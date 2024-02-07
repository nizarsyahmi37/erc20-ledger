import assert from "node:assert/strict";
import type { Server } from "http";
import * as http from "http";
import type { AddressInfo } from "net";
import { after, before, beforeEach, describe, it } from "node:test";
import { TRANSFER_TOPIC } from "../src/decode";
import { JsonRpcClient, RpcError } from "../src/rpc";

interface Call {
  jsonrpc: string;
  id: number;
  method: string;
  params: any[];
}
type Answer = { result?: unknown; error?: { code: number; message: string } };

const HASH_A = "0x" + "AB".repeat(32);
const HASH_B = "0x" + "cd".repeat(32);
const MAX_UINT = "0x" + "f".repeat(64);

describe("JsonRpcClient", () => {
  let server: Server;
  let url = "";
  let seen: { headers: http.IncomingHttpHeaders; body: Call[] }[] = [];
  let failNext = 0; // HTTP 500s to return before answering
  let respond: (call: Call) => Answer = () => ({ result: null });

  before(async () => {
    server = http.createServer((req, res) => {
      const chunks: Buffer[] = [];
      req.on("data", (c: Buffer) => chunks.push(c));
      req.on("end", () => {
        const body: Call[] = JSON.parse(Buffer.concat(chunks).toString("utf8"));
        seen.push({ headers: req.headers, body });
        if (failNext > 0) {
          failNext--;
          res.writeHead(500).end("boom");
          return;
        }
        // answer in reverse order on purpose: the client must match responses by id
        const answers = body.map(c => ({ jsonrpc: "2.0", id: c.id, ...respond(c) })).reverse();
        res.writeHead(200, { "Content-Type": "application/json" }).end(JSON.stringify(answers));
      });
    });
    await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
    url = `http://127.0.0.1:${(server.address() as AddressInfo).port}/`;
  });
  after(async () => {
    server.closeAllConnections();
    await new Promise(resolve => server.close(resolve));
  });
  beforeEach(() => {
    seen = [];
    failNext = 0;
    respond = () => ({ result: null });
  });

  it("parses the head block number", async () => {
    respond = () => ({ result: "0x1b4" });
    assert.equal(await new JsonRpcClient(url).getHeadNumber(), 436);
  });

  it("returns lower-cased headers, null for missing blocks, matched by id", async () => {
    respond = c => (c.params[0] === "0x5" ? { result: { number: "0x5", hash: HASH_A, parentHash: HASH_B } } : { result: null });
    const headers = await new JsonRpcClient(url).getHeaders(5, 6);
    assert.deepEqual(headers, [{ number: 5, hash: HASH_A.toLowerCase(), parentHash: HASH_B }, null]);
    assert.deepEqual(seen[0].body.map(c => c.params), [["0x5", false], ["0x6", false]]);
  });

  it("asks eth_getLogs for the Transfer topic over a block range", async () => {
    const token = "0x" + "11".repeat(20);
    respond = () => ({ result: [{ address: token }] });
    const logs = await new JsonRpcClient(url).getLogs(10, 20, [token]);
    assert.equal(logs.length, 1);
    assert.deepEqual(seen[0].body[0].params, [{ fromBlock: "0xa", toBlock: "0x14", address: [token], topics: [TRANSFER_TOPIC] }]);
  });

  it("encodes balanceOf calls and returns exact decimal strings", async () => {
    const token = "0x" + "11".repeat(20);
    const holders = ["0x" + "00".repeat(19) + "0a", "0x" + "00".repeat(19) + "0b"];
    respond = c => ({ result: c.params[0].data.endsWith("0a") ? MAX_UINT : "0x" + "0".repeat(63) + "5" });
    const balances = await new JsonRpcClient(url).balancesOf(token, holders, 255);
    assert.deepEqual(balances, ["115792089237316195423570985008687907853269984665640564039457584007913129639935", "5"]);
    const call = seen[0].body[0];
    assert.equal(call.method, "eth_call");
    assert.equal(call.params[1], "0xff");
    assert.equal(call.params[0].data, "0x70a08231" + "0".repeat(24) + holders[0].slice(2));
  });

  it("treats empty return data and reverts as 'no totalSupply'", async () => {
    const client = new JsonRpcClient(url);
    respond = () => ({ result: "0x" });
    assert.equal(await client.totalSupply("0x" + "11".repeat(20), 1), null);
    respond = () => ({ error: { code: -32000, message: "execution reverted" } });
    assert.equal(await client.totalSupply("0x" + "11".repeat(20), 1), null);
    respond = () => ({ result: "0x" + "0".repeat(62) + "2a" });
    assert.equal(await client.totalSupply("0x" + "11".repeat(20), 1), "42");
  });

  it("surfaces JSON-RPC errors as RpcError without retrying", async () => {
    respond = () => ({ error: { code: -32000, message: "header not found" } });
    await assert.rejects(new JsonRpcClient(url).getHeaders(1, 1), (e: unknown) => e instanceof RpcError && e.code === -32000 && e.method === "eth_getBlockByNumber");
    assert.equal(seen.length, 1);
  });

  it("retries transport failures with backoff", async () => {
    failNext = 1;
    respond = () => ({ result: "0x2" });
    assert.equal(await new JsonRpcClient(url).getHeadNumber(), 2);
    assert.equal(seen.length, 2);
  });

  it("sends credentials embedded in the URL as basic auth", async () => {
    respond = () => ({ result: "0x1" });
    await new JsonRpcClient(url.replace("http://", "http://user:p%40ss@")).getHeadNumber();
    assert.equal(seen[0].headers.authorization, "Basic " + Buffer.from("user:p@ss").toString("base64"));
  });

  it("splits large batches into requests of at most 50 calls", async () => {
    respond = () => ({ result: "0x" + "0".repeat(64) });
    const holders = Array.from({ length: 120 }, (_, i) => "0x" + i.toString(16).padStart(40, "0"));
    const balances = await new JsonRpcClient(url).balancesOf("0x" + "11".repeat(20), holders, 1);
    assert.equal(balances.length, 120);
    assert.deepEqual(seen.map(s => s.body.length), [50, 50, 20]);
  });
});
