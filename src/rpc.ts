"use strict";
import http = require("http");
import https = require("https");
import urlLib = require("url");
import BN = require("bn.js");
import { RawLog, TRANSFER_TOPIC } from "./decode";

export interface Header {
  number: number;
  hash: string;
  parentHash: string;
}

/** Everything the service needs from a node. Faked in tests. */
export interface ChainRpc {
  getHeadNumber(): Promise<number>;
  /** Headers for [from, to]; entries are null where the node has no block at that height. */
  getHeaders(from: number, to: number): Promise<Header[]>;
  /** Transfer logs of the tracked tokens for blocks [from, to] as the node currently sees them. */
  getLogs(from: number, to: number, tokens: string[]): Promise<RawLog[]>;
  /** balanceOf(holder) for each holder at a historical block, as decimal strings. */
  balancesOf(token: string, holders: string[], block: number): Promise<string[]>;
  /** totalSupply() at a historical block as a decimal string, or null if the token has no such method. */
  totalSupply(token: string, block: number): Promise<string>;
}

export class RpcError extends Error {
  constructor(public method: string, public code: number, message: string) {
    super(method + ": " + message + " (" + code + ")");
  }
}

function hex(n: number): string {
  return "0x" + n.toString(16);
}

function pad32(h: string): string {
  const s = h.replace(/^0x/, "");
  return new Array(65 - s.length).join("0") + s;
}

function parseUint(r: string): string {
  if (!/^0x[0-9a-fA-F]{64}$/.test(r)) throw new Error("unexpected eth_call return: " + r);
  return new BN(r.slice(2), 16).toString(10);
}

function sleep(ms: number): Promise<void> {
  return new Promise<void>((resolve) => {
    setTimeout(resolve, ms);
  });
}

function httpPost(target: string, payload: string, timeoutMs: number): Promise<string> {
  return new Promise<string>((resolve, reject) => {
    const u = urlLib.parse(target);
    const mod = (u.protocol === "https:" ? https : http) as typeof http; // same request() signature
    const req = mod.request(
      {
        hostname: u.hostname,
        port: u.port,
        path: u.path,
        auth: u.auth,
        method: "POST",
        headers: { "Content-Type": "application/json", "Content-Length": Buffer.byteLength(payload) }
      },
      (res: any) => {
        const chunks: any[] = [];
        res.on("data", (c: any) => chunks.push(c));
        res.on("end", () => {
          if (res.statusCode < 200 || res.statusCode >= 300) reject(new Error("HTTP " + res.statusCode));
          else resolve(Buffer.concat(chunks).toString("utf8"));
        });
      }
    );
    req.setTimeout(timeoutMs, () => req.abort());
    req.on("error", reject);
    req.end(payload);
  });
}

export class JsonRpcClient implements ChainRpc {
  private nextId = 1;
  private timeoutMs = 15000;
  private retries = 4;
  private batchSize = 50;

  constructor(private url: string) {}

  private async post(body: any): Promise<any> {
    let lastErr: any = null;
    for (let attempt = 0; attempt <= this.retries; attempt++) {
      try {
        return JSON.parse(await httpPost(this.url, JSON.stringify(body), this.timeoutMs));
      } catch (e) {
        lastErr = e;
        await sleep(Math.min(200 * Math.pow(2, attempt), 5000) + Math.random() * 100);
      }
    }
    throw new Error("rpc transport failed after retries: " + lastErr.message);
  }

  /** JSON-RPC 2.0 batch; results come back in request order. */
  private async batch(calls: { method: string; params: any[] }[]): Promise<any[]> {
    const out: any[] = [];
    for (let i = 0; i < calls.length; i += this.batchSize) {
      const chunk = calls.slice(i, i + this.batchSize);
      const base = this.nextId;
      this.nextId += chunk.length;
      const body = chunk.map((c, j) => ({ jsonrpc: "2.0", id: base + j, method: c.method, params: c.params }));
      const resp = await this.post(body);
      if (!Array.isArray(resp)) throw new Error("rpc: expected batch response");
      const byId = new Map<number, any>();
      resp.forEach((r: any) => byId.set(r.id, r));
      for (let j = 0; j < chunk.length; j++) {
        const r = byId.get(base + j);
        if (!r) throw new Error("rpc: missing response in batch");
        if (r.error) throw new RpcError(chunk[j].method, r.error.code, r.error.message);
        out.push(r.result);
      }
    }
    return out;
  }

  async getHeadNumber(): Promise<number> {
    const r = await this.batch([{ method: "eth_blockNumber", params: [] }]);
    return parseInt(r[0], 16);
  }

  async getHeaders(from: number, to: number): Promise<Header[]> {
    const calls: { method: string; params: any[] }[] = [];
    for (let n = from; n <= to; n++) calls.push({ method: "eth_getBlockByNumber", params: [hex(n), false] });
    const res = await this.batch(calls);
    return res.map((b: any) =>
      b ? { number: parseInt(b.number, 16), hash: b.hash.toLowerCase(), parentHash: b.parentHash.toLowerCase() } : null
    );
  }

  async getLogs(from: number, to: number, tokens: string[]): Promise<RawLog[]> {
    const r = await this.batch([
      { method: "eth_getLogs", params: [{ fromBlock: hex(from), toBlock: hex(to), address: tokens, topics: [TRANSFER_TOPIC] }] }
    ]);
    return r[0] as RawLog[];
  }

  async balancesOf(token: string, holders: string[], block: number): Promise<string[]> {
    const calls = holders.map((h) => ({
      method: "eth_call",
      params: [{ to: token, data: "0x70a08231" + pad32(h) }, hex(block)]
    }));
    return (await this.batch(calls)).map(parseUint);
  }

  async totalSupply(token: string, block: number): Promise<string> {
    try {
      const r = await this.batch([{ method: "eth_call", params: [{ to: token, data: "0x18160ddd" }, hex(block)] }]);
      return r[0] === "0x" ? null : parseUint(r[0]); // "0x": no such method / not a contract
    } catch (e) {
      if (e instanceof RpcError && /revert|invalid|execution/i.test(e.message)) return null;
      throw e;
    }
  }
}
