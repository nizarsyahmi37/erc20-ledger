import { setTimeout as sleep } from "node:timers/promises";
import { RawLog, TRANSFER_TOPIC } from "./decode.js";
import { errorMessage } from "./errors.js";

export interface Header {
  number: number;
  hash: string;
  parentHash: string;
}

/** Everything the service needs from a node. Faked in tests. */
export interface ChainRpc {
  getHeadNumber(): Promise<number>;
  /** Headers for [from, to]; entries are null where the node has no block at that height. */
  getHeaders(from: number, to: number): Promise<(Header | null)[]>;
  /** Transfer logs of the tracked tokens for blocks [from, to] as the node currently sees them. */
  getLogs(from: number, to: number, tokens: string[]): Promise<RawLog[]>;
  /** balanceOf(holder) for each holder at a historical block, as decimal strings. */
  balancesOf(token: string, holders: string[], block: number): Promise<string[]>;
  /** totalSupply() at a historical block as a decimal string, or null if the token has no such method. */
  totalSupply(token: string, block: number): Promise<string | null>;
}

export class RpcError extends Error {
  readonly method: string;
  readonly code: number;

  constructor(method: string, code: number, message: string) {
    super(`${method}: ${message} (${code})`);
    this.method = method;
    this.code = code;
  }
}

const hex = (n: number) => "0x" + n.toString(16);

function parseUint(r: string): string {
  if (!/^0x[0-9a-fA-F]{64}$/.test(r)) throw new Error(`unexpected eth_call return: ${r}`);
  return BigInt(r).toString();
}

interface Call {
  method: string;
  params: any[];
}

export class JsonRpcClient implements ChainRpc {
  private nextId = 1;
  private readonly timeoutMs = 15_000;
  private readonly retries = 4;
  private readonly batchSize = 50;
  private readonly url: string;

  constructor(url: string) {
    this.url = url;
  }

  private async post(body: unknown): Promise<any> {
    const endpoint = new URL(this.url);
    const headers: Record<string, string> = { "Content-Type": "application/json" };
    if (endpoint.username) {
      // fetch() refuses URLs with embedded credentials, so move them into a Basic auth header
      const credentials = `${decodeURIComponent(endpoint.username)}:${decodeURIComponent(endpoint.password)}`;
      headers.Authorization = `Basic ${Buffer.from(credentials).toString("base64")}`;
      endpoint.username = "";
      endpoint.password = "";
    }
    let lastErr: unknown;
    for (let attempt = 0; attempt <= this.retries; attempt++) {
      try {
        const res = await fetch(endpoint, { method: "POST", headers, body: JSON.stringify(body), signal: AbortSignal.timeout(this.timeoutMs) });
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        return await res.json();
      } catch (e) {
        lastErr = e;
        await sleep(Math.min(200 * 2 ** attempt, 5_000) + Math.random() * 100);
      }
    }
    throw new Error(`rpc transport failed after retries: ${errorMessage(lastErr)}`, { cause: lastErr });
  }

  /** JSON-RPC 2.0 batch; results come back in request order. */
  private async batch(calls: Call[]): Promise<any[]> {
    const out: any[] = [];
    for (let i = 0; i < calls.length; i += this.batchSize) {
      const chunk = calls.slice(i, i + this.batchSize);
      const base = this.nextId;
      this.nextId += chunk.length;
      const resp = await this.post(chunk.map((c, j) => ({ jsonrpc: "2.0", id: base + j, method: c.method, params: c.params })));
      if (!Array.isArray(resp)) throw new Error("rpc: expected batch response");
      const byId = new Map<number, any>(resp.map((r: any): [number, any] => [r.id, r]));
      chunk.forEach((c, j) => {
        const r = byId.get(base + j);
        if (!r) throw new Error("rpc: missing response in batch");
        if (r.error) throw new RpcError(c.method, r.error.code, r.error.message);
        out.push(r.result);
      });
    }
    return out;
  }

  async getHeadNumber(): Promise<number> {
    const [r] = await this.batch([{ method: "eth_blockNumber", params: [] }]);
    return parseInt(r, 16);
  }

  async getHeaders(from: number, to: number): Promise<(Header | null)[]> {
    const calls: Call[] = [];
    for (let n = from; n <= to; n++) calls.push({ method: "eth_getBlockByNumber", params: [hex(n), false] });
    return (await this.batch(calls)).map(b =>
      b ? { number: parseInt(b.number, 16), hash: b.hash.toLowerCase(), parentHash: b.parentHash.toLowerCase() } : null
    );
  }

  async getLogs(from: number, to: number, tokens: string[]): Promise<RawLog[]> {
    const [logs] = await this.batch([
      { method: "eth_getLogs", params: [{ fromBlock: hex(from), toBlock: hex(to), address: tokens, topics: [TRANSFER_TOPIC] }] }
    ]);
    return logs;
  }

  async balancesOf(token: string, holders: string[], block: number): Promise<string[]> {
    const calls = holders.map(h => ({
      method: "eth_call",
      params: [{ to: token, data: "0x70a08231" + h.replace(/^0x/, "").padStart(64, "0") }, hex(block)]
    }));
    return (await this.batch(calls)).map(parseUint);
  }

  async totalSupply(token: string, block: number): Promise<string | null> {
    try {
      const [r] = await this.batch([{ method: "eth_call", params: [{ to: token, data: "0x18160ddd" }, hex(block)] }]);
      return r === "0x" ? null : parseUint(r); // "0x": no such method / not a contract
    } catch (e) {
      if (e instanceof RpcError && /revert|invalid|execution/i.test(e.message)) return null;
      throw e;
    }
  }
}
