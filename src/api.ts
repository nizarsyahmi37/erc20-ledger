"use strict";
import http = require("http");
import urlLib = require("url");
import { getCursor } from "./apply";
import { Pool } from "./db";
import { decodeTransfer, DecodedEvent, RawLog } from "./decode";
import { ingestBundles, IngestConflictError } from "./ingest";

export interface ApiDeps {
  pool: Pool;
  networkId: number;
  tokens: string[];
  ingestToken: string;
}

const ADDR = /^0x[0-9a-fA-F]{40}$/;
const HASH = /^0x[0-9a-fA-F]{64}$/;
const MAX_BODY = 5 * 1024 * 1024;

class HttpError extends Error {
  constructor(public status: number, message: string) {
    super(message);
  }
}

export function createApi(d: ApiDeps): any {
  return http.createServer((req: any, res: any) => {
    route(d, req, res).catch((e: any) => {
      if (e instanceof HttpError) return send(res, e.status, { error: e.message });
      if (e instanceof IngestConflictError) return send(res, 409, { error: e.message });
      if (e instanceof SyntaxError) return send(res, 400, { error: "invalid json" });
      console.error("[api]", e);
      send(res, 500, { error: "internal" });
    });
  });
}

async function route(d: ApiDeps, req: any, res: any): Promise<void> {
  const pathname: string = urlLib.parse(req.url, true).pathname || "/";
  const parts = pathname.split("/").filter((p) => p.length > 0);
  if (req.method === "GET" && pathname === "/healthz") return send(res, 200, await health(d));
  if (req.method === "GET" && parts[0] === "balances" && parts.length === 3) {
    if (!ADDR.test(parts[1]) || !ADDR.test(parts[2])) throw new HttpError(400, "bad address");
    return send(res, 200, await balance(d, parts[1].toLowerCase(), parts[2].toLowerCase()));
  }
  if (req.method === "POST" && pathname === "/ingest") {
    if (!d.ingestToken) throw new HttpError(404, "ingest disabled");
    authorize(req, d.ingestToken);
    return send(res, 200, await ingest(d, JSON.parse(await readBody(req))));
  }
  throw new HttpError(404, "not found");
}

async function health(d: ApiDeps): Promise<any> {
  const cursor = await getCursor(d.pool, d.networkId);
  const st = await d.pool.query("SELECT halted, halt_reason FROM network_state WHERE network_id = $1", [d.networkId]);
  const latest = await d.pool.query("SELECT max(number) AS n FROM blocks WHERE network_id = $1", [d.networkId]);
  const rec = await d.pool.query(
    "SELECT status, block_number, checked, mismatched, finished_at FROM reconciliation_runs " +
      "WHERE network_id = $1 AND finished_at IS NOT NULL ORDER BY id DESC LIMIT 1",
    [d.networkId]
  );
  return {
    halted: st.rows[0] ? st.rows[0].halted : null,
    haltReason: st.rows[0] ? st.rows[0].halt_reason : null,
    appliedBlock: cursor ? cursor.number : null,
    latestIngestedBlock: latest.rows[0].n === null ? null : Number(latest.rows[0].n),
    lastReconciliation: rec.rows[0] || null
  };
}

async function balance(d: ApiDeps, token: string, holder: string): Promise<any> {
  // One snapshot so balance and block always agree.
  const c = await d.pool.connect();
  try {
    await c.query("BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY");
    const cursor = await getCursor(c, d.networkId);
    const r = await c.query("SELECT balance FROM balances WHERE network_id = $1 AND token = $2 AND holder = $3", [d.networkId, token, holder]);
    await c.query("COMMIT");
    return {
      token: token,
      holder: holder,
      balance: r.rows[0] ? r.rows[0].balance : "0",
      asOfBlock: cursor ? cursor.number : null,
      asOfHash: cursor ? cursor.hash : null,
      confirmed: true
    };
  } finally {
    c.release();
  }
}

/**
 * Push-style delivery of one whole block (e.g. from a webhook relay). TRUSTED sources only: a pushed
 * block is stored as-is and, if its hash lands on the confirmed chain, its events are applied.
 * Delivery can be duplicated, delayed or out of order; see ingest.ts / apply.ts.
 */
async function ingest(d: ApiDeps, b: any): Promise<any> {
  if (!b || typeof b !== "object" || !HASH.test(b.hash) || !HASH.test(b.parentHash) || !/^\d+$/.test(String(b.number)) || !Array.isArray(b.logs)) {
    throw new HttpError(400, "expected {number, hash, parentHash, logs[]}");
  }
  if (b.networkId !== undefined && b.networkId !== d.networkId) throw new HttpError(400, "wrong network");
  if (b.logs.length > 10000) throw new HttpError(400, "too many logs");
  const hash = (b.hash as string).toLowerCase();
  const events: DecodedEvent[] = [];
  for (const l of b.logs as RawLog[]) {
    if (l.removed) throw new HttpError(400, "removed logs not accepted; deliver whole blocks (orphans are handled by hash)");
    if (!ADDR.test(l.address) || d.tokens.indexOf(l.address.toLowerCase()) < 0) throw new HttpError(400, "log from untracked address");
    if (String(l.blockHash).toLowerCase() !== hash) throw new HttpError(400, "log blockHash mismatch");
    const ev = decodeTransfer(l);
    if (ev) events.push(ev);
  }
  return ingestBundles(d.pool, [
    { networkId: d.networkId, number: Number(b.number), hash: hash, parentHash: (b.parentHash as string).toLowerCase(), events: events }
  ]);
}

// crypto.timingSafeEqual does not exist before Node 6.6, so compare by hand without early exit.
function constantTimeEqual(a: string, b: string): boolean {
  let diff = a.length ^ b.length;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i % (b.length || 1));
  return diff === 0;
}

function authorize(req: any, token: string): void {
  const got = String(req.headers.authorization || "").replace(/^Bearer /, "");
  if (!constantTimeEqual(got, token)) throw new HttpError(401, "unauthorized");
}

function readBody(req: any): Promise<string> {
  return new Promise<string>((resolve, reject) => {
    let n = 0;
    const chunks: any[] = [];
    req.on("data", (c: any) => {
      n += c.length;
      if (n > MAX_BODY) {
        reject(new HttpError(413, "body too large"));
        req.connection.destroy();
      } else chunks.push(c);
    });
    req.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
    req.on("error", reject);
  });
}

function send(res: any, status: number, data: any): void {
  res.writeHead(status, { "Content-Type": "application/json" });
  res.end(JSON.stringify(data));
}
