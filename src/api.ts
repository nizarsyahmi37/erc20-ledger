import * as crypto from "node:crypto";
import * as http from "node:http";
import { URL } from "node:url";
import { getCursor } from "./apply";
import { Pool } from "./db";
import { decodeTransfer, DecodedEvent, RawLog } from "./decode";
import { ingestBundles, IngestConflictError } from "./ingest";

export interface ApiDeps {
  pool: Pool;
  networkId: number;
  tokens: string[];
  ingestToken: string | null;
}

const ADDR = /^0x[0-9a-fA-F]{40}$/;
const HASH = /^0x[0-9a-fA-F]{64}$/;
const MAX_BODY = 5 * 1024 * 1024;

class HttpError extends Error {
  constructor(public status: number, message: string) {
    super(message);
  }
}

export function createApi(d: ApiDeps): http.Server {
  return http.createServer((req, res) => {
    route(d, req, res).catch(e => {
      if (e instanceof HttpError) return send(res, e.status, { error: e.message });
      if (e instanceof IngestConflictError) return send(res, 409, { error: e.message });
      if (e instanceof SyntaxError) return send(res, 400, { error: "invalid json" });
      console.error("[api]", e);
      send(res, 500, { error: "internal" });
    });
  });
}

async function route(d: ApiDeps, req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
  const { pathname } = new URL(req.url || "/", "http://localhost");
  const parts = pathname.split("/").filter(p => p.length > 0);
  if (req.method === "GET" && pathname === "/healthz") return send(res, 200, await health(d));
  if (req.method === "GET" && parts[0] === "balances" && parts.length === 3) {
    const [, token, holder] = parts;
    if (!ADDR.test(token) || !ADDR.test(holder)) throw new HttpError(400, "bad address");
    return send(res, 200, await balance(d, token.toLowerCase(), holder.toLowerCase()));
  }
  if (req.method === "POST" && pathname === "/ingest") {
    if (!d.ingestToken) throw new HttpError(404, "ingest disabled");
    authorize(req, d.ingestToken);
    return send(res, 200, await ingest(d, JSON.parse(await readBody(req))));
  }
  throw new HttpError(404, "not found");
}

async function health(d: ApiDeps): Promise<object> {
  const [cursor, st, latest, rec] = await Promise.all([
    getCursor(d.pool, d.networkId),
    d.pool.query("SELECT halted, halt_reason FROM network_state WHERE network_id = $1", [d.networkId]),
    d.pool.query("SELECT max(number) AS n FROM blocks WHERE network_id = $1", [d.networkId]),
    d.pool.query(
      `SELECT status, block_number, checked, mismatched, finished_at FROM reconciliation_runs
        WHERE network_id = $1 AND finished_at IS NOT NULL ORDER BY id DESC LIMIT 1`,
      [d.networkId]
    )
  ]);
  return {
    halted: st.rows[0]?.halted ?? null,
    haltReason: st.rows[0]?.halt_reason ?? null,
    appliedBlock: cursor?.number ?? null,
    latestIngestedBlock: latest.rows[0].n === null ? null : Number(latest.rows[0].n),
    lastReconciliation: rec.rows[0] ?? null
  };
}

async function balance(d: ApiDeps, token: string, holder: string): Promise<object> {
  // One snapshot so balance and block always agree.
  const c = await d.pool.connect();
  try {
    await c.query("BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY");
    const cursor = await getCursor(c, d.networkId);
    const r = await c.query("SELECT balance FROM balances WHERE network_id = $1 AND token = $2 AND holder = $3", [d.networkId, token, holder]);
    await c.query("COMMIT");
    return {
      token,
      holder,
      balance: r.rows[0]?.balance ?? "0",
      asOfBlock: cursor?.number ?? null,
      asOfHash: cursor?.hash ?? null,
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
async function ingest(d: ApiDeps, b: any): Promise<object> {
  if (!b || typeof b !== "object" || !HASH.test(b.hash) || !HASH.test(b.parentHash) || !/^\d+$/.test(String(b.number)) || !Array.isArray(b.logs)) {
    throw new HttpError(400, "expected {number, hash, parentHash, logs[]}");
  }
  if (b.networkId !== undefined && b.networkId !== d.networkId) throw new HttpError(400, "wrong network");
  if (b.logs.length > 10000) throw new HttpError(400, "too many logs");
  const hash = String(b.hash).toLowerCase();
  const events: DecodedEvent[] = [];
  for (const l of b.logs as RawLog[]) {
    if (l.removed) throw new HttpError(400, "removed logs not accepted; deliver whole blocks (orphans are handled by hash)");
    if (!ADDR.test(l.address) || !d.tokens.includes(l.address.toLowerCase())) throw new HttpError(400, "log from untracked address");
    if (String(l.blockHash).toLowerCase() !== hash) throw new HttpError(400, "log blockHash mismatch");
    const ev = decodeTransfer(l);
    if (ev) events.push(ev);
  }
  return ingestBundles(d.pool, [{ networkId: d.networkId, number: Number(b.number), hash, parentHash: String(b.parentHash).toLowerCase(), events }]);
}

// Compare digests so timingSafeEqual always sees equal-length buffers and the token length doesn't leak.
function authorize(req: http.IncomingMessage, token: string): void {
  const digest = (s: string) => crypto.createHash("sha256").update(s).digest();
  const got = String(req.headers.authorization || "").replace(/^Bearer /, "");
  if (!crypto.timingSafeEqual(digest(got), digest(token))) throw new HttpError(401, "unauthorized");
}

function readBody(req: http.IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    let n = 0;
    const chunks: Buffer[] = [];
    req.on("data", (c: Buffer) => {
      n += c.length;
      if (n > MAX_BODY) {
        reject(new HttpError(413, "body too large"));
        req.destroy();
      } else chunks.push(c);
    });
    req.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
    req.on("error", reject);
  });
}

function send(res: http.ServerResponse, status: number, data: object): void {
  res.writeHead(status, { "Content-Type": "application/json" }).end(JSON.stringify(data));
}
