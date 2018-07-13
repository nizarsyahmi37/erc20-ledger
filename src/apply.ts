import { Conn, LOCK_NS_APPLY, Pool, Queryable, tx } from "./db";
import { ZERO_ADDRESS } from "./decode";

export type ApplyResult =
  | { status: "applied"; from: number; to: number; blocks: number }
  /** Target is not ahead of the applied tip. */
  | { status: "noop" }
  | { status: "unknown_target" }
  /** Parent chain from the target is missing a block (a delivery hasn't arrived). Retry later. */
  | { status: "gap"; missingNumber: number; missingHash: string }
  /** Target's chain does not extend our applied tip: the tip was reorged out. Roll back. */
  | { status: "diverged" };

export interface Cursor {
  number: number;
  hash: string;
}

export async function getCursor(q: Queryable, networkId: number): Promise<Cursor | null> {
  const r = await q.query("SELECT number, hash FROM applied_blocks WHERE network_id = $1 ORDER BY number DESC LIMIT 1", [networkId]);
  return r.rows[0] ? { number: Number(r.rows[0].number), hash: r.rows[0].hash } : null;
}

const lockNetwork = (c: Conn, networkId: number) => c.query("SELECT pg_advisory_xact_lock($1, $2)", [LOCK_NS_APPLY, networkId]);

/**
 * Fold the canonical chain ending at `targetHash` into balances.
 *
 * `targetHash` must come from a source we trust to be canonical (the RPC node, at depth >= CONFIRMATIONS).
 * We then WALK BACK through parent_hash links in our own table. That makes the result independent of
 * delivery order (missing links => "gap", retry later) and of forks (blocks not on the walked chain are
 * never touched, so orphaned events can never reach balances).
 *
 * Atomic: balances, supply and applied_blocks move together in one transaction under a per-network lock.
 * Re-running with the same or an older target is a no-op.
 */
export async function applyThrough(pool: Pool, networkId: number, targetHash: string): Promise<ApplyResult> {
  return tx(pool, async (c): Promise<ApplyResult> => {
    await lockNetwork(c, networkId);
    const st = await c.query("SELECT start_block, halted FROM network_state WHERE network_id = $1", [networkId]);
    if (!st.rows[0]) throw new Error(`network ${networkId} not initialised`);
    if (st.rows[0].halted) throw new Error(`network ${networkId} is halted; operator action required`);

    const cursor = await getCursor(c, networkId);
    const base = cursor ? cursor.number : Number(st.rows[0].start_block) - 1;

    const t = await c.query("SELECT number FROM blocks WHERE network_id = $1 AND hash = $2", [networkId, targetHash]);
    if (!t.rows[0]) return { status: "unknown_target" };
    const targetNumber = Number(t.rows[0].number);
    if (targetNumber <= base) return { status: "noop" };

    const walk = await c.query(
      `WITH RECURSIVE chain AS (
         SELECT number, hash, parent_hash FROM blocks WHERE network_id = $1 AND hash = $2
         UNION ALL
         SELECT b.number, b.hash, b.parent_hash
           FROM chain c JOIN blocks b ON b.network_id = $1 AND b.hash = c.parent_hash AND b.number = c.number - 1
          WHERE c.number > $3::bigint + 1
       )
       SELECT number, hash, parent_hash FROM chain ORDER BY number`,
      [networkId, targetHash, base]
    );
    const rows = walk.rows;
    if (rows.length !== targetNumber - base) {
      return { status: "gap", missingNumber: Number(rows[0].number) - 1, missingHash: rows[0].parent_hash };
    }
    if (cursor && rows[0].parent_hash !== cursor.hash) return { status: "diverged" };

    await c.query("INSERT INTO applied_blocks (network_id, number, hash) SELECT $1, * FROM UNNEST($2::bigint[], $3::text[])", [
      networkId,
      rows.map(r => r.number),
      rows.map(r => r.hash)
    ]);
    await applyDeltas(c, networkId, rows.map(r => r.hash), 1);
    return { status: "applied", from: Number(rows[0].number), to: targetNumber, blocks: rows.length };
  });
}

/** Add (sign=1) or subtract (sign=-1) the effect of all events in these blocks. Order-independent: it is a sum. */
async function applyDeltas(c: Conn, networkId: number, hashes: string[], sign: 1 | -1): Promise<void> {
  await c.query(
    `WITH d AS (
       SELECT token, from_addr AS holder, -amount AS delta FROM events
        WHERE network_id = $1 AND block_hash = ANY($2::text[]) AND from_addr <> $4
       UNION ALL
       SELECT token, to_addr, amount FROM events
        WHERE network_id = $1 AND block_hash = ANY($2::text[]) AND to_addr <> $4
     ), agg AS (SELECT token, holder, sum(delta) * $3::numeric AS delta FROM d GROUP BY 1, 2)
     INSERT INTO balances (network_id, token, holder, balance)
     SELECT $1, token, holder, delta FROM agg
     ON CONFLICT (network_id, token, holder) DO UPDATE SET balance = balances.balance + EXCLUDED.balance`,
    [networkId, hashes, sign, ZERO_ADDRESS]
  );
  // Supply moves only on mint (from 0x0) / burn (to 0x0). Same rule for any event shape.
  await c.query(
    `WITH agg AS (
       SELECT token,
              (sum(CASE WHEN from_addr = $4 THEN amount ELSE 0 END)
             - sum(CASE WHEN to_addr   = $4 THEN amount ELSE 0 END)) * $3::numeric AS delta
         FROM events WHERE network_id = $1 AND block_hash = ANY($2::text[]) GROUP BY token
     ) INSERT INTO token_supply (network_id, token, supply)
     SELECT $1, token, delta FROM agg
     ON CONFLICT (network_id, token) DO UPDATE SET supply = token_supply.supply + EXCLUDED.supply`,
    [networkId, hashes, sign, ZERO_ADDRESS]
  );
}

/**
 * Undo applied blocks with number > toNumber (a reorg deeper than our confirmation depth).
 * Events of the orphaned blocks are kept (inert, because their hashes are no longer on the applied chain).
 */
export async function rollbackTo(pool: Pool, networkId: number, toNumber: number): Promise<number> {
  return tx(pool, async c => {
    await lockNetwork(c, networkId);
    const r = await c.query("DELETE FROM applied_blocks WHERE network_id = $1 AND number > $2 RETURNING hash", [networkId, toNumber]);
    if (r.rows.length > 0) await applyDeltas(c, networkId, r.rows.map(x => x.hash), -1);
    return r.rows.length;
  });
}

/** Operator tool: recompute derived tables from applied_blocks + events. Use after suspected corruption. */
export async function rebuildBalances(pool: Pool, networkId: number): Promise<void> {
  await tx(pool, async c => {
    await lockNetwork(c, networkId);
    await c.query("DELETE FROM balances WHERE network_id = $1", [networkId]);
    await c.query("DELETE FROM token_supply WHERE network_id = $1", [networkId]);
    const r = await c.query("SELECT hash FROM applied_blocks WHERE network_id = $1", [networkId]);
    if (r.rows.length > 0) await applyDeltas(c, networkId, r.rows.map(x => x.hash), 1);
  });
}

export async function halt(pool: Pool, networkId: number, reason: string): Promise<void> {
  await pool.query("UPDATE network_state SET halted = true, halt_reason = $2, updated_at = now() WHERE network_id = $1", [networkId, reason]);
}
