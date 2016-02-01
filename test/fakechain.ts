"use strict";
import crypto = require("crypto");
import { RawLog, TRANSFER_TOPIC, ZERO_ADDRESS } from "../src/decode";
import { ChainRpc, Header } from "../src/rpc";

export interface Xfer {
  token: string;
  from: string;
  to: string;
  amount: number; // small numbers only: tests never need uint256 here
}

export interface FakeBlock extends Header {
  xfers: Xfer[];
}

function h32(s: string): string {
  return "0x" + crypto.createHash("sha256").update(s).digest("hex");
}

function pad(s: string, n: number): string {
  return new Array(n + 1 - s.length).join("0") + s;
}

export function addr(n: number): string {
  return "0x" + pad(n.toString(16), 40);
}

/** In-memory chain supporting forks. `canonical` is what the "node" currently reports. */
export class FakeChain implements ChainRpc {
  blocks = new Map<string, FakeBlock>();
  canonical: string[] = []; // index = block number
  failBalanceFor = new Set<string>();
  onGetLogs: () => void = null; // test hook: runs just before logs are read (to simulate a reorg mid-fetch)
  private seq = 0;

  constructor(public tokens: string[]) {
    const g: FakeBlock = { number: 0, hash: h32("genesis"), parentHash: h32("none"), xfers: [] };
    this.blocks.set(g.hash, g);
    this.canonical = [g.hash];
  }

  /** Create a block on top of `parent` (default: canonical tip). Does not change the canonical chain. */
  mk(xfers: Xfer[], parent?: string): FakeBlock {
    const p = this.blocks.get(parent || this.canonical[this.canonical.length - 1]);
    const b: FakeBlock = { number: p.number + 1, hash: h32("b" + this.seq++), parentHash: p.hash, xfers: xfers || [] };
    this.blocks.set(b.hash, b);
    return b;
  }

  /** Extend the canonical chain, one block per entry. */
  mine(xfersPerBlock: Xfer[][]): FakeBlock[] {
    const out: FakeBlock[] = [];
    for (const x of xfersPerBlock) {
      const b = this.mk(x);
      this.canonical[b.number] = b.hash;
      out.push(b);
    }
    return out;
  }

  /** Make `hash` the canonical tip (and its ancestors the canonical chain). */
  setTip(hash: string): void {
    let b = this.blocks.get(hash);
    this.canonical.length = b.number + 1;
    for (;;) {
      this.canonical[b.number] = b.hash;
      if (b.number === 0) break;
      b = this.blocks.get(b.parentHash);
    }
  }

  logsOf(b: FakeBlock): RawLog[] {
    return b.xfers.map((x, i) => ({
      address: x.token,
      topics: [TRANSFER_TOPIC, "0x" + pad(x.from.slice(2), 64), "0x" + pad(x.to.slice(2), 64)],
      data: "0x" + pad(x.amount.toString(16), 64),
      blockHash: b.hash,
      blockNumber: "0x" + b.number.toString(16),
      transactionHash: h32("tx" + b.hash + i),
      logIndex: "0x" + i.toString(16)
    }));
  }

  async getHeadNumber(): Promise<number> {
    return this.canonical.length - 1;
  }

  async getHeaders(from: number, to: number): Promise<Header[]> {
    const out: Header[] = [];
    for (let n = from; n <= to; n++) out.push(this.canonical[n] ? this.blocks.get(this.canonical[n]) : null);
    return out;
  }

  async getLogs(from: number, to: number, tokens: string[]): Promise<RawLog[]> {
    if (this.onGetLogs) this.onGetLogs();
    const out: RawLog[] = [];
    for (let n = from; n <= to && n < this.canonical.length; n++) {
      for (const l of this.logsOf(this.blocks.get(this.canonical[n]))) if (tokens.indexOf(l.address) >= 0) out.push(l);
    }
    return out;
  }

  stateAt(token: string, block: number): { bal: Map<string, number>; supply: number } {
    const bal = new Map<string, number>();
    let supply = 0;
    for (let n = 0; n <= block; n++) {
      for (const x of this.blocks.get(this.canonical[n]).xfers) {
        if (x.token !== token) continue;
        if (x.from === ZERO_ADDRESS) supply += x.amount;
        else bal.set(x.from, (bal.get(x.from) || 0) - x.amount);
        if (x.to === ZERO_ADDRESS) supply -= x.amount;
        else bal.set(x.to, (bal.get(x.to) || 0) + x.amount);
      }
    }
    return { bal: bal, supply: supply };
  }

  async balancesOf(token: string, holders: string[], block: number): Promise<string[]> {
    if (this.failBalanceFor.has(token)) throw new Error("rpc down");
    const s = this.stateAt(token, block);
    return holders.map((h) => String(s.bal.get(h) || 0));
  }

  async totalSupply(token: string, block: number): Promise<string> {
    return String(this.stateAt(token, block).supply);
  }
}
