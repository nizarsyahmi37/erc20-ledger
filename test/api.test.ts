import assert from "node:assert/strict";
import type { Server } from "node:http";
import type { AddressInfo } from "node:net";
import { after, before, beforeEach, describe, it } from "node:test";
import { createApi } from "../src/api.js";
import { applyThrough } from "../src/apply.js";
import { createPool, type Pool } from "../src/db.js";
import { ZERO_ADDRESS } from "../src/decode.js";
import { migrate } from "../src/migrate.js";
import { initNetworkState } from "../src/poller.js";
import { addr, type FakeBlock, FakeChain, type Xfer } from "./fakechain.js";

const DB_URL = process.env.TEST_DATABASE_URL;
const T = addr(0xa11ce0000);
const [A, B] = [addr(1), addr(2)];
const TOKEN = "s3cret";
const NET = 1;

const x = (from: string, to: string, amount: bigint): Xfer => ({ token: T, from, to, amount });

describe("http api", { skip: DB_URL ? false : "set TEST_DATABASE_URL" }, () => {
  let pool: Pool;
  let server: Server;
  let noIngest: Server;
  let base = "";
  let baseNoIngest = "";
  let chain: FakeChain;

  const listen = (s: Server) =>
    new Promise<string>(resolve => s.listen(0, "127.0.0.1", () => resolve(`http://127.0.0.1:${(s.address() as AddressInfo).port}`)));
  const body = (b: FakeBlock) => ({ number: b.number, hash: b.hash, parentHash: b.parentHash, logs: chain.logsOf(b) });
  const post = (path: string, payload: unknown, token: string | null = TOKEN, root = base) =>
    fetch(root + path, {
      method: "POST",
      headers: { "Content-Type": "application/json", ...(token ? { Authorization: `Bearer ${token}` } : {}) },
      body: typeof payload === "string" ? payload : JSON.stringify(payload)
    });

  before(async () => {
    pool = createPool(DB_URL!);
    await migrate(pool);
    server = createApi({ pool, networkId: NET, tokens: [T], ingestToken: TOKEN });
    noIngest = createApi({ pool, networkId: NET, tokens: [T], ingestToken: null });
    base = await listen(server);
    baseNoIngest = await listen(noIngest);
  });
  after(async () => {
    for (const s of [server, noIngest]) {
      s.closeAllConnections();
      await new Promise(resolve => s.close(resolve));
    }
    await pool.end();
  });
  beforeEach(async () => {
    await pool.query("TRUNCATE reconciliation_runs, balances, token_supply, applied_blocks, events, blocks, network_state CASCADE");
    await initNetworkState(pool, { networkId: NET, tokens: [T], startBlock: 1, confirmations: 0, maxReorgDepth: 50, maxBlocksPerTick: 100 });
    chain = new FakeChain();
  });

  it("reports health before anything is applied", async () => {
    const res = await fetch(base + "/healthz");
    assert.equal(res.status, 200);
    assert.deepEqual(await res.json(), { halted: false, haltReason: null, appliedBlock: null, latestIngestedBlock: null, lastReconciliation: null });
  });

  it("rejects ingest without a valid bearer token", async () => {
    const [b1] = chain.mine([[x(ZERO_ADDRESS, A, 100n)]]);
    assert.equal((await post("/ingest", body(b1), null)).status, 401);
    assert.equal((await post("/ingest", body(b1), "wrong")).status, 401);
    assert.equal((await post("/ingest", body(b1), "s3cre")).status, 401);
  });

  it("disables ingest when no token is configured", async () => {
    const [b1] = chain.mine([[x(ZERO_ADDRESS, A, 100n)]]);
    assert.equal((await post("/ingest", body(b1), TOKEN, baseNoIngest)).status, 404);
  });

  it("ingests a block once and reports redeliveries as duplicates", async () => {
    const [b1] = chain.mine([[x(ZERO_ADDRESS, A, 100n)]]);
    const first = await post("/ingest", body(b1));
    assert.equal(first.status, 200);
    assert.deepEqual(await first.json(), { blocksNew: 1, blocksDuplicate: 0, eventsNew: 1 });
    assert.deepEqual(await (await post("/ingest", body(b1))).json(), { blocksNew: 0, blocksDuplicate: 1, eventsNew: 0 });
  });

  it("answers 409 when a block is redelivered with different content", async () => {
    const [b1] = chain.mine([[x(ZERO_ADDRESS, A, 100n)]]);
    await post("/ingest", body(b1));
    assert.equal((await post("/ingest", { ...body(b1), logs: [] })).status, 409);
  });

  it("serves confirmed balances together with the block they are as of", async () => {
    const [b1, b2] = chain.mine([[x(ZERO_ADDRESS, A, 100n)], [x(A, B, 40n)]]);
    await post("/ingest", body(b1));
    await post("/ingest", body(b2));
    assert.equal((await applyThrough(pool, NET, b2.hash)).status, "applied");
    const res = await fetch(`${base}/balances/${T}/${B}`);
    assert.deepEqual(await res.json(), { token: T, holder: B, balance: "40", asOfBlock: 2, asOfHash: b2.hash, confirmed: true });
    const unknown = (await (await fetch(`${base}/balances/${T}/${addr(9)}`)).json()) as { balance: string };
    assert.equal(unknown.balance, "0");
  });

  it("validates input", async () => {
    assert.equal((await fetch(`${base}/balances/xyz/abc`)).status, 400);
    assert.equal((await fetch(`${base}/nope`)).status, 404);
    assert.equal((await post("/ingest", "{not json")).status, 400);
    const [b1] = chain.mine([[{ token: addr(0xbad), from: ZERO_ADDRESS, to: A, amount: 1n }]]);
    assert.equal((await post("/ingest", body(b1))).status, 400);
  });
});
