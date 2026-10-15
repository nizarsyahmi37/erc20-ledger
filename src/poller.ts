import { applyThrough, getCursor, halt, rollbackTo } from "./apply.js";
import { type Pool } from "./db.js";
import { decodeTransfer, type RawLog } from "./decode.js";
import { type BlockBundle, ingestBundles } from "./ingest.js";
import { type ChainRpc, type Header } from "./rpc.js";

export interface PollerConfig {
  networkId: number;
  tokens: string[];
  startBlock: number;
  confirmations: number;
  maxReorgDepth: number;
  maxBlocksPerTick: number;
}

export async function initNetworkState(pool: Pool, cfg: PollerConfig): Promise<void> {
  const r = await pool.query("SELECT start_block, tokens FROM network_state WHERE network_id = $1", [cfg.networkId]);
  if (!r.rows[0]) {
    await pool.query("INSERT INTO network_state (network_id, start_block, tokens) VALUES ($1, $2, $3) ON CONFLICT DO NOTHING", [
      cfg.networkId,
      cfg.startBlock,
      cfg.tokens
    ]);
    return;
  }
  // The block table's completeness guarantee only holds for the token set it was built with.
  if (Number(r.rows[0].start_block) !== cfg.startBlock || r.rows[0].tokens.join() !== cfg.tokens.join()) {
    throw new Error(
      "config (START_BLOCK/TOKENS) differs from what this database was indexed with. " +
        'Changing either requires a fresh database (see README: "Limits").'
    );
  }
}

export interface TickResult {
  head: number;
  cursor: number | null;
  reorgRolledBack: number;
  ingested: number;
  apply: string;
}

const present = (h: Header | null): h is Header => h !== null;

/** One pass: detect deep reorg -> ingest headers+logs up to head -> apply up to head - confirmations. */
export async function tick(pool: Pool, rpc: ChainRpc, cfg: PollerConfig): Promise<TickResult> {
  const head = await rpc.getHeadNumber();
  const out: TickResult = { head, cursor: null, reorgRolledBack: 0, ingested: 0, apply: "none" };

  out.reorgRolledBack = await handleDeepReorg(pool, rpc, cfg);

  const cursor = await getCursor(pool, cfg.networkId);
  const base = cursor?.number ?? cfg.startBlock - 1;
  out.cursor = cursor?.number ?? null;
  const from = base + 1;
  if (from > head) return out;
  const to = Math.min(head, from + cfg.maxBlocksPerTick - 1);

  const headers = (await rpc.getHeaders(from, to)).filter(present);
  if (headers.length === 0) return out;

  // Only fetch logs for blocks we do not already hold. Hash-keyed, so a re-orged height simply
  // yields a new hash and gets fetched; unchanged heights cost nothing.
  const known = await pool.query("SELECT hash FROM blocks WHERE network_id = $1 AND hash = ANY($2::text[])", [
    cfg.networkId,
    headers.map(h => h.hash)
  ]);
  const usable = new Set<string>(known.rows.map(r => r.hash)); // hashes we hold, or have just stored
  const unknown = headers.filter(h => !usable.has(h.hash));
  if (unknown.length > 0) {
    const lo = unknown[0].number;
    const hi = unknown[unknown.length - 1].number;
    // Fork consistency without a blockHash filter: sandwich the log query between two header reads.
    // A block is only stored if the node reported the SAME hash before and after the logs were read
    // (and each log carries that blockHash), so logs can never be filed under another fork's header.
    const logs = await rpc.getLogs(lo, hi, cfg.tokens);
    const afterHash = new Map<number, string>();
    for (const h of (await rpc.getHeaders(lo, hi)).filter(present)) afterHash.set(h.number, h.hash);
    const stable = unknown.filter(h => afterHash.get(h.number) === h.hash);

    const logsByHash = new Map<string, RawLog[]>();
    for (const l of logs) {
      if (l.removed) throw new Error("node returned a removed log; refusing to guess");
      if (!cfg.tokens.includes(l.address.toLowerCase())) throw new Error("node returned a log from an untracked address");
      const bh = l.blockHash.toLowerCase();
      const bucket = logsByHash.get(bh);
      if (bucket) bucket.push(l);
      else logsByHash.set(bh, [l]);
    }
    const bundles: BlockBundle[] = stable.map(h => ({
      networkId: cfg.networkId,
      number: h.number,
      hash: h.hash,
      parentHash: h.parentHash,
      events: (logsByHash.get(h.hash) ?? []).flatMap(l => decodeTransfer(l) ?? [])
    }));
    await ingestBundles(pool, bundles);
    for (const b of bundles) usable.add(b.hash);
    out.ingested = bundles.length;
  }

  // Apply as far as confirmation depth allows, using a header we just saw (and hold) as the trusted target.
  const safe = head - cfg.confirmations;
  const target = headers.findLast(h => h.number <= safe && usable.has(h.hash));
  if (target) {
    const r = await applyThrough(pool, cfg.networkId, target.hash);
    out.apply = r.status === "applied" ? `applied ${r.from}..${r.to}` : r.status;
    // "gap"/"unknown_target": a racing reorg gave us a header mix, or that block was skipped as unstable.
    // Harmless; the next tick re-fetches. "diverged": next tick's handleDeepReorg resolves it.
  }
  const now = await getCursor(pool, cfg.networkId);
  out.cursor = now?.number ?? null;
  return out;
}

/**
 * Re-check the applied tip against the node. If the node disagrees, the chain reorged deeper than our
 * confirmation depth: find the common ancestor, roll balances back to it, and carry on.
 * Beyond MAX_REORG_DEPTH we halt rather than guess.
 */
export async function handleDeepReorg(pool: Pool, rpc: ChainRpc, cfg: PollerConfig): Promise<number> {
  const cursor = await getCursor(pool, cfg.networkId);
  if (!cursor) return 0;
  const [tip] = await rpc.getHeaders(cursor.number, cursor.number);
  if (tip && tip.hash === cursor.hash) return 0;
  // A node that is merely behind (load-balanced, lagging) must not look like a reorg: never halt on null.
  if (!tip) throw new Error(`node has no block ${cursor.number} but we applied it; node lagging? retrying`);

  const lo = Math.max(cursor.number - cfg.maxReorgDepth, cfg.startBlock);
  const applied = await pool.query("SELECT number, hash FROM applied_blocks WHERE network_id = $1 AND number >= $2 ORDER BY number DESC", [
    cfg.networkId,
    lo
  ]);
  const theirs = await rpc.getHeaders(lo, cursor.number);
  if (!theirs.every(present)) throw new Error("node is missing blocks inside the reorg window; retrying");
  const nodeHash = new Map<number, string>(theirs.filter(present).map((h): [number, string] => [h.number, h.hash]));
  const ancestor = applied.rows.find(r => nodeHash.get(Number(r.number)) === r.hash);
  if (!ancestor) {
    const reason = `reorg deeper than MAX_REORG_DEPTH=${cfg.maxReorgDepth} below block ${cursor.number}`;
    await halt(pool, cfg.networkId, reason);
    throw new Error(reason);
  }
  const n = await rollbackTo(pool, cfg.networkId, Number(ancestor.number));
  console.warn(`[reorg] rolled back ${n} applied blocks to ${ancestor.number} (node tip changed at ${cursor.number})`);
  return n;
}
