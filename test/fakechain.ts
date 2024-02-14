import * as crypto from "node:crypto";
import { RawLog, TRANSFER_TOPIC, ZERO_ADDRESS } from "../src/decode.js";
import { ChainRpc, Header } from "../src/rpc.js";

export interface Xfer {
  token: string;
  from: string;
  to: string;
  amount: bigint;
}

export interface FakeBlock extends Header {
  xfers: Xfer[];
}

const h32 = (s: string) => "0x" + crypto.createHash("sha256").update(s).digest("hex");

export const addr = (n: number) => "0x" + n.toString(16).padStart(40, "0");

/** In-memory chain supporting forks. `canonical` is what the "node" currently reports. */
export class FakeChain implements ChainRpc {
  blocks = new Map<string, FakeBlock>();
  canonical: string[] = []; // index = block number
  failBalanceFor = new Set<string>();
  onGetLogs: (() => void) | null = null; // test hook: runs just before logs are read (simulates a reorg mid-fetch)
  private seq = 0;

  constructor() {
    const genesis: FakeBlock = { number: 0, hash: h32("genesis"), parentHash: h32("none"), xfers: [] };
    this.blocks.set(genesis.hash, genesis);
    this.canonical = [genesis.hash];
  }

  private block(hash: string): FakeBlock {
    const b = this.blocks.get(hash);
    if (!b) throw new Error(`unknown block ${hash}`);
    return b;
  }

  /** Create a block on top of `parent` (default: canonical tip). Does not change the canonical chain. */
  mk(xfers: Xfer[], parent: string = this.canonical[this.canonical.length - 1]): FakeBlock {
    const p = this.block(parent);
    const b: FakeBlock = { number: p.number + 1, hash: h32(`b${this.seq++}`), parentHash: p.hash, xfers };
    this.blocks.set(b.hash, b);
    return b;
  }

  /** Extend the canonical chain, one block per entry. */
  mine(xfersPerBlock: Xfer[][]): FakeBlock[] {
    return xfersPerBlock.map(x => {
      const b = this.mk(x);
      this.canonical[b.number] = b.hash;
      return b;
    });
  }

  /** Make `hash` the canonical tip (and its ancestors the canonical chain). */
  setTip(hash: string): void {
    let b = this.block(hash);
    this.canonical.length = b.number + 1;
    for (;;) {
      this.canonical[b.number] = b.hash;
      if (b.number === 0) break;
      b = this.block(b.parentHash);
    }
  }

  logsOf(b: FakeBlock): RawLog[] {
    return b.xfers.map((x, i) => ({
      address: x.token,
      topics: [TRANSFER_TOPIC, "0x" + x.from.slice(2).padStart(64, "0"), "0x" + x.to.slice(2).padStart(64, "0")],
      data: "0x" + x.amount.toString(16).padStart(64, "0"),
      blockHash: b.hash,
      blockNumber: "0x" + b.number.toString(16),
      transactionHash: h32(`tx${b.hash}${i}`),
      logIndex: "0x" + i.toString(16)
    }));
  }

  async getHeadNumber(): Promise<number> {
    return this.canonical.length - 1;
  }

  async getHeaders(from: number, to: number): Promise<(Header | null)[]> {
    const out: (Header | null)[] = [];
    for (let n = from; n <= to; n++) out.push(this.canonical[n] ? this.block(this.canonical[n]) : null);
    return out;
  }

  async getLogs(from: number, to: number, tokens: string[]): Promise<RawLog[]> {
    if (this.onGetLogs) this.onGetLogs();
    const out: RawLog[] = [];
    for (let n = from; n <= to && n < this.canonical.length; n++) {
      out.push(...this.logsOf(this.block(this.canonical[n])).filter(l => tokens.includes(l.address)));
    }
    return out;
  }

  stateAt(token: string, block: number): { bal: Map<string, bigint>; supply: bigint } {
    const bal = new Map<string, bigint>();
    let supply = 0n;
    for (let n = 0; n <= block; n++) {
      for (const x of this.block(this.canonical[n]).xfers) {
        if (x.token !== token) continue;
        if (x.from === ZERO_ADDRESS) supply += x.amount;
        else bal.set(x.from, (bal.get(x.from) ?? 0n) - x.amount);
        if (x.to === ZERO_ADDRESS) supply -= x.amount;
        else bal.set(x.to, (bal.get(x.to) ?? 0n) + x.amount);
      }
    }
    return { bal, supply };
  }

  async balancesOf(token: string, holders: string[], block: number): Promise<string[]> {
    if (this.failBalanceFor.has(token)) throw new Error("rpc down");
    const { bal } = this.stateAt(token, block);
    return holders.map(h => String(bal.get(h) ?? 0n));
  }

  async totalSupply(token: string, block: number): Promise<string | null> {
    return String(this.stateAt(token, block).supply);
  }
}
