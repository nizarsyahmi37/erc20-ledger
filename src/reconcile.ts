import { getCursor } from "./apply.js";
import { type Pool } from "./db.js";
import { errorMessage } from "./errors.js";
import { type ChainRpc } from "./rpc.js";

export interface ReconcileOptions {
  networkId: number;
  /** Holders per eth_call batch (default 100). */
  pageSize?: number;
  /** Cap on diffs persisted per run (default 1000); the mismatch COUNT is always exact. */
  maxDiffs?: number;
}

export type ReconcileStatus = "ok" | "drift" | "inconclusive" | "error";

export interface ReconcileResult {
  runId: number;
  status: ReconcileStatus;
  blockNumber: number | null;
  checked: number;
  mismatched: number;
  detail: string | null;
}

interface Diff {
  token: string;
  holder: string;
  ours: string;
  onchain: string;
}

async function stillCanonical(rpc: ChainRpc, cur: { number: number; hash: string }): Promise<boolean> {
  const [h] = await rpc.getHeaders(cur.number, cur.number);
  return !!h && h.hash === cur.hash;
}

/**
 * Compare our balances with eth_call(balanceOf) and totalSupply() at ONE pinned block: the applied tip.
 *
 * Consistency: we read cursor + balances inside a single REPEATABLE READ snapshot, so "ours" is exactly
 * the state at the cursor even while the poller keeps applying new blocks. We then ask the node about
 * that same block number.
 *
 * Soundness: a result is only "ok"/"drift" if the node still agrees the pinned block hash is canonical
 * before AND after the scan. Otherwise the comparison may be across forks => "inconclusive", never "drift".
 * Mismatches are re-queried once before being reported, to filter transient/inconsistent node answers.
 *
 * Limits (README): only holders WE know are checked. A holder we missed entirely shows up through the
 * totalSupply check, not per-holder.
 */
export async function reconcile(pool: Pool, rpc: ChainRpc, opts: ReconcileOptions): Promise<ReconcileResult> {
  const { networkId } = opts;
  const pageSize = opts.pageSize ?? 100;
  const maxDiffs = opts.maxDiffs ?? 1000;
  const run = await pool.query("INSERT INTO reconciliation_runs (network_id, status) VALUES ($1, 'error') RETURNING id", [networkId]);
  const runId = Number(run.rows[0].id);

  const finish = async (
    status: ReconcileStatus,
    blockNumber: number | null,
    checked: number,
    mismatched: number,
    detail: string | null,
    diffs: Diff[] = []
  ): Promise<ReconcileResult> => {
    await pool.query(
      "UPDATE reconciliation_runs SET status = $2, block_number = $3, checked = $4, mismatched = $5, detail = $6, finished_at = now() WHERE id = $1",
      [runId, status, blockNumber, checked, mismatched, detail]
    );
    if (diffs.length > 0) {
      await pool.query(
        `INSERT INTO reconciliation_diffs (run_id, token, holder, ours, onchain)
         SELECT $1, * FROM UNNEST($2::text[], $3::text[], $4::numeric[], $5::numeric[])`,
        [runId, diffs.map(d => d.token), diffs.map(d => d.holder), diffs.map(d => d.ours), diffs.map(d => d.onchain)]
      );
    }
    return { runId, status, blockNumber, checked, mismatched, detail };
  };

  const c = await pool.connect();
  try {
    await c.query("BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY");
    const cursor = await getCursor(c, networkId);
    if (!cursor) {
      await c.query("COMMIT");
      return await finish("inconclusive", null, 0, 0, "nothing applied yet");
    }
    await pool.query("UPDATE reconciliation_runs SET block_hash = $2 WHERE id = $1", [runId, cursor.hash]);

    if (!(await stillCanonical(rpc, cursor))) {
      await c.query("COMMIT");
      return await finish("inconclusive", cursor.number, 0, 0, "applied tip not canonical on node (reorg in progress?)");
    }

    const tokens: string[] = (await c.query("SELECT tokens FROM network_state WHERE network_id = $1", [networkId])).rows[0].tokens;
    const diffs: Diff[] = [];
    let checked = 0;
    let mismatched = 0;
    const record = (d: Diff) => {
      mismatched++;
      if (diffs.length < maxDiffs) diffs.push(d);
    };

    for (const token of tokens) {
      const supplyRow = await c.query("SELECT supply FROM token_supply WHERE network_id = $1 AND token = $2", [networkId, token]);
      const oursSupply: string = supplyRow.rows[0]?.supply ?? "0";
      const onSupply = await rpc.totalSupply(token, cursor.number);
      if (onSupply !== null) {
        checked++;
        if (onSupply !== oursSupply) {
          const again = await rpc.totalSupply(token, cursor.number);
          if (again !== oursSupply) record({ token, holder: "*supply*", ours: oursSupply, onchain: again ?? onSupply });
        }
      }

      // balances, keyset-paginated inside the snapshot
      let after = "";
      for (;;) {
        const page = await c.query(
          "SELECT holder, balance FROM balances WHERE network_id = $1 AND token = $2 AND holder > $3 ORDER BY holder LIMIT $4",
          [networkId, token, after, pageSize]
        );
        if (page.rows.length === 0) break;
        const holders: string[] = page.rows.map(r => r.holder);
        const onchain = await rpc.balancesOf(token, holders, cursor.number);
        const suspects: number[] = [];
        page.rows.forEach((r, i) => {
          checked++;
          if (r.balance !== onchain[i]) suspects.push(i);
        });
        if (suspects.length > 0) {
          const second = await rpc.balancesOf(token, suspects.map(i => holders[i]), cursor.number);
          suspects.forEach((i, j) => {
            if (page.rows[i].balance !== second[j]) record({ token, holder: holders[i], ours: page.rows[i].balance, onchain: second[j] });
          });
        }
        after = holders[holders.length - 1];
      }
    }
    await c.query("COMMIT");

    if (!(await stillCanonical(rpc, cursor))) {
      return await finish("inconclusive", cursor.number, checked, mismatched, "reorg during scan; results discarded");
    }
    return await finish(mismatched > 0 ? "drift" : "ok", cursor.number, checked, mismatched, null, diffs);
  } catch (e) {
    await c.query("ROLLBACK").catch(() => undefined);
    return await finish("error", null, 0, 0, errorMessage(e));
  } finally {
    c.release();
  }
}
