import assert from "node:assert/strict";
import { after, before, beforeEach, describe, it } from "node:test";
import { applyThrough, rebuildBalances } from "../src/apply";
import { createPool, Pool } from "../src/db";
import { decodeTransfer, DecodedEvent, TRANSFER_TOPIC, ZERO_ADDRESS } from "../src/decode";
import { BlockBundle, ingestBundles, IngestConflictError } from "../src/ingest";
import { migrate } from "../src/migrate";
import { initNetworkState, PollerConfig, tick } from "../src/poller";
import { reconcile } from "../src/reconcile";
import { addr, FakeBlock, FakeChain, Xfer } from "./fakechain";

const DB_URL = process.env.TEST_DATABASE_URL;
const T = addr(0xa11ce0000);
const [A, B, C] = [addr(1), addr(2), addr(3)];
const NET = 1;

const x = (from: string, to: string, amount: bigint): Xfer => ({ token: T, from, to, amount });

const cfg = (confirmations: number): PollerConfig => ({
  networkId: NET,
  tokens: [T],
  startBlock: 1,
  confirmations,
  maxReorgDepth: 50,
  maxBlocksPerTick: 100
});

const bundle = (chain: FakeChain, b: FakeBlock): BlockBundle => ({
  networkId: NET,
  number: b.number,
  hash: b.hash,
  parentHash: b.parentHash,
  events: chain.logsOf(b).map(l => decodeTransfer(l) as DecodedEvent)
});

describe("ledger", { skip: DB_URL ? false : "set TEST_DATABASE_URL" }, () => {
  let pool: Pool;
  let chain: FakeChain;

  const bal = async (h: string) => {
    const r = await pool.query("SELECT balance FROM balances WHERE network_id = 1 AND token = $1 AND holder = $2", [T, h]);
    return BigInt(r.rows[0]?.balance ?? 0);
  };
  const supply = async () => {
    const r = await pool.query("SELECT supply FROM token_supply WHERE network_id = 1 AND token = $1", [T]);
    return BigInt(r.rows[0]?.supply ?? 0);
  };
  const count = async (table: string) => Number((await pool.query(`SELECT count(*) AS n FROM ${table}`)).rows[0].n);

  before(async () => {
    pool = createPool(DB_URL!);
    await migrate(pool);
  });
  after(() => pool.end());
  beforeEach(async () => {
    await pool.query("TRUNCATE reconciliation_runs, balances, token_supply, applied_blocks, events, blocks, network_state CASCADE");
    chain = new FakeChain();
    await initNetworkState(pool, cfg(2));
  });

  it("decodes mint/burn/transfer and skips ERC-721 Transfers", () => {
    const base = { address: T, blockHash: "0x" + "1".repeat(64), blockNumber: "0x1", transactionHash: "0x" + "2".repeat(64), logIndex: "0x0" };
    const topic = (a: string) => "0x" + a.slice(2).padStart(64, "0");
    const amt = "0x" + "5".padStart(64, "0");
    const mk = (topics: string[], data: string) => ({ ...base, topics, data });
    assert.strictEqual(decodeTransfer(mk([TRANSFER_TOPIC, topic(ZERO_ADDRESS), topic(A)], amt))!.kind, "mint");
    assert.strictEqual(decodeTransfer(mk([TRANSFER_TOPIC, topic(A), topic(ZERO_ADDRESS)], amt))!.kind, "burn");
    const plain = decodeTransfer(mk([TRANSFER_TOPIC, topic(A), topic(B)], amt))!;
    assert.strictEqual(plain.kind, "transfer");
    assert.strictEqual(plain.amount, "5");
    assert.strictEqual(decodeTransfer(mk([TRANSFER_TOPIC, topic(A), topic(B), topic(A)], "0x")), null); // ERC-721
    // uint256 max survives as an exact decimal string
    const max = decodeTransfer(mk([TRANSFER_TOPIC, topic(A), topic(B)], "0x" + "f".repeat(64)))!;
    assert.strictEqual(max.amount, "115792089237316195423570985008687907853269984665640564039457584007913129639935");
  });

  it("applies mint/transfer/burn only up to the confirmation depth", async () => {
    chain.mine([[x(ZERO_ADDRESS, A, 100n)], [x(A, B, 30n)], [x(B, ZERO_ADDRESS, 10n)], [], []]);
    const r = await tick(pool, chain, cfg(2)); // head=5 -> applies through 3
    assert.strictEqual(r.cursor, 3);
    assert.strictEqual(await bal(A), 70n);
    assert.strictEqual(await bal(B), 20n);
    assert.strictEqual(await supply(), 90n);
    assert.strictEqual(await count("events"), 3); // everything ingested, only 1..3 applied
  });

  it("is idempotent: repeated ticks and duplicate deliveries change nothing", async () => {
    const blocks = chain.mine([[x(ZERO_ADDRESS, A, 100n)], [x(A, B, 40n)], []]);
    await tick(pool, chain, cfg(0));
    const snap = async () => [await bal(A), await bal(B), await supply(), await count("events"), await count("applied_blocks")].join();
    const before = await snap();
    for (let i = 0; i < 3; i++) await tick(pool, chain, cfg(0));
    for (const b of blocks) {
      const r = await ingestBundles(pool, [bundle(chain, b), bundle(chain, b)]);
      assert.strictEqual(r.blocksNew, 0);
      assert.strictEqual(r.eventsNew, 0);
    }
    assert.deepStrictEqual(await applyThrough(pool, NET, blocks[2].hash), { status: "noop" });
    assert.strictEqual(await snap(), before);
    assert.strictEqual(await bal(B), 40n);
  });

  it("rejects a redelivery that contradicts the stored block", async () => {
    const [b1] = chain.mine([[x(ZERO_ADDRESS, A, 100n)]]);
    await ingestBundles(pool, [bundle(chain, b1)]);
    await assert.rejects(ingestBundles(pool, [{ ...bundle(chain, b1), events: [] }]), IngestConflictError);
    const tampered = bundle(chain, b1);
    tampered.events[0].amount = "999";
    // (a same-hash, same-count, different-amount redelivery is NOT detectable; see README "Limits")
    await assert.rejects(ingestBundles(pool, [bundle(chain, b1), tampered]), IngestConflictError);
  });

  it("handles out-of-order delivery: gap until the missing block arrives, same result as in-order", async () => {
    const bs = chain.mine([[x(ZERO_ADDRESS, A, 100n)], [x(A, B, 25n)], [x(B, C, 5n)], [x(A, C, 1n)]]);
    const results: string[] = [];
    for (const i of [3, 1, 3, 0, 2]) {
      // block 4, 2, 4 again, 1, 3
      await ingestBundles(pool, [bundle(chain, bs[i])]);
      results.push((await applyThrough(pool, NET, bs[3].hash)).status);
    }
    assert.deepStrictEqual(results, ["gap", "gap", "gap", "gap", "applied"]);
    assert.strictEqual(await bal(A), 74n);
    assert.strictEqual(await bal(B), 20n);
    assert.strictEqual(await bal(C), 6n);
    assert.strictEqual(await supply(), 100n);
  });

  it("orphan blocks never reach balances (reorg before confirmation)", async () => {
    const [b1] = chain.mine([[x(ZERO_ADDRESS, A, 100n)]]);
    await tick(pool, chain, cfg(2)); // ingests b1 (unconfirmed)
    const orphan = chain.mk([x(A, B, 100n)], b1.hash);
    chain.setTip(orphan.hash);
    await tick(pool, chain, cfg(2)); // sees the fork, ingests it, still unconfirmed
    const good2 = chain.mk([x(A, C, 50n)], b1.hash);
    const good3 = chain.mk([], good2.hash);
    const good4 = chain.mk([], good3.hash);
    chain.setTip(good4.hash);
    await tick(pool, chain, cfg(2));
    assert.strictEqual(await bal(A), 50n);
    assert.strictEqual(await bal(B), 0n);
    assert.strictEqual(await bal(C), 50n);
    assert.strictEqual(await count("blocks"), 5); // b1, orphan, good2..4 all retained
  });

  it("deep reorg after apply: rolls back, then re-applies the new fork", async () => {
    const bs = chain.mine([[x(ZERO_ADDRESS, A, 100n)], [x(A, B, 60n)], [x(B, C, 10n)], [], []]);
    await tick(pool, chain, cfg(1)); // cursor=4
    assert.strictEqual(await bal(B), 50n);
    // replace blocks 3..: the A->B transfer (block 2) is kept, block 3's B->C is dropped for A->C
    const n3 = chain.mk([x(A, C, 7n)], bs[1].hash);
    const n4 = chain.mk([], n3.hash);
    const n5 = chain.mk([], n4.hash);
    const n6 = chain.mk([], n5.hash);
    chain.setTip(n6.hash);
    const r = await tick(pool, chain, cfg(1));
    assert.ok(r.reorgRolledBack > 0);
    assert.deepStrictEqual([await bal(A), await bal(B), await bal(C), await supply()], [33n, 60n, 7n, 100n]);
    // the reorg-and-replay must equal a from-scratch rebuild
    await rebuildBalances(pool, NET);
    assert.deepStrictEqual([await bal(A), await bal(B), await bal(C)], [33n, 60n, 7n]);
  });

  it("same tx re-mined in a different block after a reorg is counted once", async () => {
    const [b1] = chain.mine([[x(ZERO_ADDRESS, A, 100n)]]);
    const t = x(A, B, 10n);
    const old2 = chain.mk([t], b1.hash);
    chain.setTip(old2.hash);
    chain.mine([[], []]);
    await tick(pool, chain, cfg(1));
    assert.strictEqual(await bal(B), 10n);
    const new2 = chain.mk([], b1.hash);
    const new3 = chain.mk([t], new2.hash); // same transfer, new block
    const new4 = chain.mk([], new3.hash);
    const new5 = chain.mk([], new4.hash);
    chain.setTip(new5.hash);
    await tick(pool, chain, cfg(1));
    assert.strictEqual(await bal(B), 10n);
    assert.strictEqual(await bal(A), 90n);
  });

  it("a reorg during the log fetch never files logs under the wrong header", async () => {
    const [b1, b2] = chain.mine([[x(ZERO_ADDRESS, A, 100n)], [x(A, B, 10n)]]);
    const alt2 = chain.mk([x(A, C, 77n)], b1.hash);
    const alt3 = chain.mk([], alt2.hash);
    chain.onGetLogs = () => {
      chain.onGetLogs = null;
      chain.setTip(alt3.hash); // node switches forks between our two header reads
    };
    const r1 = await tick(pool, chain, cfg(0));
    assert.strictEqual(r1.ingested, 1); // only block 1 was provably consistent
    assert.strictEqual(Number((await pool.query("SELECT count(*) AS n FROM blocks WHERE hash = $1", [b2.hash])).rows[0].n), 0);
    await tick(pool, chain, cfg(0));
    assert.deepStrictEqual([await bal(A), await bal(B), await bal(C)], [23n, 0n, 77n]);
  });

  it("halts instead of guessing when a reorg exceeds MAX_REORG_DEPTH", async () => {
    chain.mine([[x(ZERO_ADDRESS, A, 1n)], [], [], [], []]);
    const small = { ...cfg(0), maxReorgDepth: 2 };
    await tick(pool, chain, small); // cursor=5
    let p = chain.canonical[0]; // fork from genesis: nothing in common within the last 2 blocks
    for (let i = 0; i < 7; i++) p = chain.mk([], p).hash;
    chain.setTip(p);
    await assert.rejects(tick(pool, chain, small), /MAX_REORG_DEPTH/);
    assert.strictEqual((await pool.query("SELECT halted FROM network_state")).rows[0].halted, true);
    await assert.rejects(tick(pool, chain, small));
  });

  describe("reconciliation", () => {
    beforeEach(async () => {
      chain.mine([[x(ZERO_ADDRESS, A, 100n)], [x(A, B, 30n)], [x(B, ZERO_ADDRESS, 5n)], []]);
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
      assert.deepStrictEqual(d.rows.map(z => [z.holder, z.ours, z.onchain]), [["*supply*", "88", "95"], [A, "71", "70"]]);
    });

    it("is inconclusive, not 'drift', if the pinned block was reorged away", async () => {
      await pool.query("UPDATE balances SET balance = balance + 1 WHERE holder = $1", [A]);
      const tip = chain.blocks.get(chain.canonical[3])!;
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
    const bs = chain.mine([[x(ZERO_ADDRESS, A, 100n)], [x(A, B, 1n)]]);
    await ingestBundles(pool, bs.map(b => bundle(chain, b)));
    const rs = await Promise.all(Array.from({ length: 8 }, () => applyThrough(pool, NET, bs[1].hash)));
    assert.strictEqual(rs.filter(r => r.status === "applied").length, 1);
    assert.strictEqual(await bal(A), 99n);
    assert.strictEqual(await supply(), 100n);
  });
});
