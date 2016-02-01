"use strict";
import assert = require("assert");
import { applyThrough, getCursor, rebuildBalances } from "../src/apply";
import { Pool } from "../src/db";
import { decodeTransfer, TRANSFER_TOPIC, ZERO_ADDRESS } from "../src/decode";
import { BlockBundle, ingestBundles, IngestConflictError } from "../src/ingest";
import { migrate } from "../src/migrate";
import { initNetworkState, PollerConfig, tick } from "../src/poller";
import { reconcile } from "../src/reconcile";
import { addr, FakeBlock, FakeChain, Xfer } from "./fakechain";

const URL: string = process.env.TEST_DATABASE_URL;
const T = addr(0xa11ce0000);
const A = addr(1);
const B = addr(2);
const C = addr(3);
const NET = 1;

function x(from: string, to: string, amount: number): Xfer {
  return { token: T, from: from, to: to, amount: amount };
}

function cfg(conf: number): PollerConfig {
  return { networkId: NET, tokens: [T], startBlock: 1, confirmations: conf, maxReorgDepth: 50, maxBlocksPerTick: 100 };
}

function bundle(chain: FakeChain, b: FakeBlock): BlockBundle {
  return { networkId: NET, number: b.number, hash: b.hash, parentHash: b.parentHash, events: chain.logsOf(b).map((l) => decodeTransfer(l)) };
}

// assert.throws is synchronous in Node 4, so promises need a helper.
async function rejects(p: Promise<any>, matcher: any): Promise<void> {
  let err: any = null;
  try {
    await p;
  } catch (e) {
    err = e;
  }
  assert.ok(err, "expected promise to reject");
  if (typeof matcher === "function") assert.ok(err instanceof matcher, "wrong error type: " + err);
  else if (matcher) assert.ok(matcher.test(err.message), "wrong error message: " + err.message);
}

(URL ? describe : describe.skip)("ledger (set TEST_DATABASE_URL)", () => {
  let pool: Pool;
  let chain: FakeChain;

  async function bal(h: string): Promise<number> {
    const r = await pool.query("SELECT balance FROM balances WHERE network_id = 1 AND token = $1 AND holder = $2", [T, h]);
    return r.rows[0] ? Number(r.rows[0].balance) : 0;
  }
  async function supply(): Promise<number> {
    const r = await pool.query("SELECT supply FROM token_supply WHERE network_id = 1 AND token = $1", [T]);
    return r.rows[0] ? Number(r.rows[0].supply) : 0;
  }
  async function count(table: string): Promise<number> {
    return Number((await pool.query("SELECT count(*) AS n FROM " + table)).rows[0].n);
  }

  before(async () => {
    pool = new Pool(URL);
    await migrate(pool);
  });
  after(() => {
    pool.end();
  });
  beforeEach(async () => {
    await pool.query("TRUNCATE reconciliation_runs, balances, token_supply, applied_blocks, events, blocks, network_state CASCADE");
    chain = new FakeChain([T]);
    await initNetworkState(pool, cfg(2));
  });

  it("decodes mint/burn/transfer and skips Transfer-shaped logs that are not ERC-20", () => {
    const base = { address: T, blockHash: "0x" + "1".repeat(64), blockNumber: "0x1", transactionHash: "0x" + "2".repeat(64), logIndex: "0x0" };
    const topic = (a: string) => "0x" + new Array(65 - (a.length - 2)).join("0") + a.slice(2);
    const amt = "0x" + new Array(63).join("0") + "05";
    const mk = (topics: string[], data: string) => Object.assign({}, base, { topics: topics, data: data });
    assert.strictEqual(decodeTransfer(mk([TRANSFER_TOPIC, topic(ZERO_ADDRESS), topic(A)], amt)).kind, "mint");
    assert.strictEqual(decodeTransfer(mk([TRANSFER_TOPIC, topic(A), topic(ZERO_ADDRESS)], amt)).kind, "burn");
    const plain = decodeTransfer(mk([TRANSFER_TOPIC, topic(A), topic(B)], amt));
    assert.strictEqual(plain.kind, "transfer");
    assert.strictEqual(plain.amount, "5");
    assert.strictEqual(decodeTransfer(mk([TRANSFER_TOPIC, topic(A), topic(B), topic(A)], "0x")), null);
    // uint256 max survives as an exact decimal string
    const max = decodeTransfer(mk([TRANSFER_TOPIC, topic(A), topic(B)], "0x" + new Array(65).join("f")));
    assert.strictEqual(max.amount, "115792089237316195423570985008687907853269984665640564039457584007913129639935");
  });

  it("applies mint/transfer/burn only up to the confirmation depth", async () => {
    chain.mine([[x(ZERO_ADDRESS, A, 100)], [x(A, B, 30)], [x(B, ZERO_ADDRESS, 10)], [], []]);
    const r = await tick(pool, chain, cfg(2)); // head=5 -> applies through 3
    assert.strictEqual(r.cursor, 3);
    assert.strictEqual(await bal(A), 70);
    assert.strictEqual(await bal(B), 20);
    assert.strictEqual(await supply(), 90);
    assert.strictEqual(await count("events"), 3); // everything ingested, only 1..3 applied
  });

  it("is idempotent: repeated ticks and duplicate deliveries change nothing", async () => {
    const blocks = chain.mine([[x(ZERO_ADDRESS, A, 100)], [x(A, B, 40)], []]);
    await tick(pool, chain, cfg(0));
    const snap = async () => JSON.stringify([await bal(A), await bal(B), await supply(), await count("events"), await count("applied_blocks")]);
    const before = await snap();
    for (let i = 0; i < 3; i++) await tick(pool, chain, cfg(0));
    for (const b of blocks) {
      const r = await ingestBundles(pool, [bundle(chain, b), bundle(chain, b)]);
      assert.strictEqual(r.blocksNew, 0);
      assert.strictEqual(r.eventsNew, 0);
    }
    assert.strictEqual((await applyThrough(pool, NET, blocks[2].hash)).status, "noop");
    assert.strictEqual(await snap(), before);
    assert.strictEqual(await bal(B), 40);
  });

  it("rejects a redelivery that contradicts the stored block", async () => {
    const b1 = chain.mine([[x(ZERO_ADDRESS, A, 100)]])[0];
    await ingestBundles(pool, [bundle(chain, b1)]);
    const fewer = Object.assign({}, bundle(chain, b1), { events: [] });
    await rejects(ingestBundles(pool, [fewer]), IngestConflictError);
    const tampered = bundle(chain, b1);
    tampered.events[0].amount = "999";
    // (a same-hash, same-count, different-amount redelivery is NOT detectable; see README "Limits")
    await rejects(ingestBundles(pool, [bundle(chain, b1), tampered]), IngestConflictError);
  });

  it("handles out-of-order delivery: gap until the missing block arrives, same result as in-order", async () => {
    const bs = chain.mine([[x(ZERO_ADDRESS, A, 100)], [x(A, B, 25)], [x(B, C, 5)], [x(A, C, 1)]]);
    const order = [3, 1, 3, 0, 2]; // block 4, 2, 4 again, 1, 3
    const results: string[] = [];
    for (const i of order) {
      await ingestBundles(pool, [bundle(chain, bs[i])]);
      results.push((await applyThrough(pool, NET, bs[3].hash)).status);
    }
    assert.deepEqual(results, ["gap", "gap", "gap", "gap", "applied"]);
    assert.strictEqual(await bal(A), 74);
    assert.strictEqual(await bal(B), 20);
    assert.strictEqual(await bal(C), 6);
    assert.strictEqual(await supply(), 100);
  });

  it("orphan blocks never reach balances (reorg before confirmation)", async () => {
    const b1 = chain.mine([[x(ZERO_ADDRESS, A, 100)]])[0];
    await tick(pool, chain, cfg(2)); // ingests b1 (unconfirmed)
    const orphan = chain.mk([x(A, B, 100)], b1.hash);
    chain.setTip(orphan.hash);
    await tick(pool, chain, cfg(2)); // sees the fork, ingests it, still unconfirmed
    const good2 = chain.mk([x(A, C, 50)], b1.hash);
    const good3 = chain.mk([], good2.hash);
    const good4 = chain.mk([], good3.hash);
    chain.setTip(good4.hash);
    await tick(pool, chain, cfg(2));
    assert.strictEqual(await bal(A), 50);
    assert.strictEqual(await bal(B), 0);
    assert.strictEqual(await bal(C), 50);
    assert.strictEqual(await count("blocks"), 5); // b1, orphan, good2..4 all retained
  });

  it("deep reorg after apply: rolls back, then re-applies the new fork", async () => {
    const bs = chain.mine([[x(ZERO_ADDRESS, A, 100)], [x(A, B, 60)], [x(B, C, 10)], [], []]);
    await tick(pool, chain, cfg(1)); // cursor=4
    assert.strictEqual(await bal(B), 50);
    // replace blocks 3..: the A->B transfer (block 2) is kept, block 3's B->C is dropped for A->C
    const n3 = chain.mk([x(A, C, 7)], bs[1].hash);
    const n4 = chain.mk([], n3.hash);
    const n5 = chain.mk([], n4.hash);
    const n6 = chain.mk([], n5.hash);
    chain.setTip(n6.hash);
    const r = await tick(pool, chain, cfg(1));
    assert.ok(r.reorgRolledBack > 0);
    assert.strictEqual(await bal(A), 33);
    assert.strictEqual(await bal(B), 60);
    assert.strictEqual(await bal(C), 7);
    assert.strictEqual(await supply(), 100);
    // the reorg-and-replay must equal a from-scratch rebuild
    await rebuildBalances(pool, NET);
    assert.deepEqual([await bal(A), await bal(B), await bal(C)], [33, 60, 7]);
  });

  it("same tx re-mined in a different block after a reorg is counted once", async () => {
    const b1 = chain.mine([[x(ZERO_ADDRESS, A, 100)]])[0];
    const t = x(A, B, 10);
    const old2 = chain.mk([t], b1.hash);
    chain.setTip(old2.hash);
    chain.mine([[], []]);
    await tick(pool, chain, cfg(1));
    assert.strictEqual(await bal(B), 10);
    const new2 = chain.mk([], b1.hash);
    const new3 = chain.mk([t], new2.hash); // same transfer, new block
    const new4 = chain.mk([], new3.hash);
    const new5 = chain.mk([], new4.hash);
    chain.setTip(new5.hash);
    await tick(pool, chain, cfg(1));
    assert.strictEqual(await bal(B), 10);
    assert.strictEqual(await bal(A), 90);
  });

  it("a reorg during the log fetch never files logs under the wrong header", async () => {
    const mined = chain.mine([[x(ZERO_ADDRESS, A, 100)], [x(A, B, 10)]]);
    const b1 = mined[0];
    const b2 = mined[1];
    const alt2 = chain.mk([x(A, C, 77)], b1.hash);
    const alt3 = chain.mk([], alt2.hash);
    chain.onGetLogs = () => {
      chain.onGetLogs = null;
      chain.setTip(alt3.hash); // node switches forks between our two header reads
    };
    const r1 = await tick(pool, chain, cfg(0));
    assert.strictEqual(r1.ingested, 1); // only block 1 was provably consistent
    assert.strictEqual(Number((await pool.query("SELECT count(*) AS n FROM blocks WHERE hash = $1", [b2.hash])).rows[0].n), 0);
    await tick(pool, chain, cfg(0));
    assert.strictEqual(await bal(A), 23);
    assert.strictEqual(await bal(B), 0);
    assert.strictEqual(await bal(C), 77);
  });

  it("halts instead of guessing when a reorg exceeds MAX_REORG_DEPTH", async () => {
    chain.mine([[x(ZERO_ADDRESS, A, 1)], [], [], [], []]);
    const small = Object.assign({}, cfg(0), { maxReorgDepth: 2 });
    await tick(pool, chain, small); // cursor=5
    let p = chain.canonical[0]; // fork from genesis: nothing in common within the last 2 blocks
    for (let i = 0; i < 7; i++) p = chain.mk([], p).hash;
    chain.setTip(p);
    await rejects(tick(pool, chain, small), /MAX_REORG_DEPTH/);
    assert.strictEqual((await pool.query("SELECT halted FROM network_state")).rows[0].halted, true);
    await rejects(tick(pool, chain, small), null);
  });

  describe("reconciliation", () => {
    beforeEach(async () => {
      chain.mine([[x(ZERO_ADDRESS, A, 100)], [x(A, B, 30)], [x(B, ZERO_ADDRESS, 5)], []]);
      await tick(pool, chain, cfg(0));
    });

    it("reports ok when state matches on-chain", async () => {
      const r = await reconcile(pool, chain, { networkId: NET });
      assert.strictEqual(r.status, "ok");
      assert.strictEqual(r.mismatched, 0);
      assert.ok(r.checked >= 3);
    });

    it("detects a corrupted balance and a supply mismatch, with exact diffs", async () => {
      await pool.query("UPDATE balances SET balance = balance + 1 WHERE holder = $1", [A]);
      await pool.query("UPDATE token_supply SET supply = supply - 7");
      const r = await reconcile(pool, chain, { networkId: NET });
      assert.strictEqual(r.status, "drift");
      assert.strictEqual(r.mismatched, 2);
      const d = await pool.query('SELECT holder, ours, onchain FROM reconciliation_diffs WHERE run_id = $1 ORDER BY holder COLLATE "C"', [r.runId]);
      assert.deepEqual(d.rows.map((z: any) => [z.holder, z.ours, z.onchain]), [["*supply*", "88", "95"], [A, "71", "70"]]);
    });

    it("is inconclusive, not 'drift', if the pinned block was reorged away", async () => {
      await pool.query("UPDATE balances SET balance = balance + 1 WHERE holder = $1", [A]);
      const tip = chain.blocks.get(chain.canonical[3]);
      chain.setTip(chain.mk([], tip.parentHash).hash); // node now disagrees about block 3
      const r = await reconcile(pool, chain, { networkId: NET });
      assert.strictEqual(r.status, "inconclusive");
    });

    it("records an error (not a false ok) when the node fails", async () => {
      chain.failBalanceFor.add(T);
      const r = await reconcile(pool, chain, { networkId: NET });
      assert.strictEqual(r.status, "error");
    });
  });

  it("concurrent appliers cannot double-apply", async () => {
    const bs = chain.mine([[x(ZERO_ADDRESS, A, 100)], [x(A, B, 1)]]);
    await ingestBundles(pool, bs.map((b) => bundle(chain, b)));
    const jobs: Promise<any>[] = [];
    for (let i = 0; i < 8; i++) jobs.push(applyThrough(pool, NET, bs[1].hash));
    const rs = await Promise.all(jobs);
    assert.strictEqual(rs.filter((r: any) => r.status === "applied").length, 1);
    assert.strictEqual(await bal(A), 99);
    assert.strictEqual(await supply(), 100);
  });
});
