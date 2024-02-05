import { Pool, PoolClient } from "pg";

export { Pool };
export type Conn = PoolClient;

export interface QueryResult {
  rows: any[];
  rowCount: number | null;
}

export interface Queryable {
  query(text: string, values?: any[]): Promise<QueryResult>;
}

// int8/numeric come back from node-postgres as strings, which is what we want: uint256 amounts stay
// decimal strings and never pass through a JS double.
export function createPool(connectionString: string, max = 10): Pool {
  const pool = new Pool({ connectionString, max });
  pool.on("error", err => console.error("[pg] idle client error", err.message));
  return pool;
}

export type Isolation = "READ COMMITTED" | "REPEATABLE READ" | "SERIALIZABLE";

export async function tx<T>(pool: Pool, fn: (c: Conn) => Promise<T>, isolation: Isolation = "READ COMMITTED"): Promise<T> {
  const c = await pool.connect();
  try {
    await c.query(`BEGIN ISOLATION LEVEL ${isolation}`);
    const result = await fn(c);
    await c.query("COMMIT");
    return result;
  } catch (e) {
    await c.query("ROLLBACK").catch(() => undefined);
    throw e;
  } finally {
    c.release();
  }
}

/** Advisory-lock namespaces (first key of the two-int pg_advisory_* functions). */
export const LOCK_NS_APPLY = 0x4c45;
export const LOCK_NS_LEADER = 0x4c46;
