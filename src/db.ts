"use strict";
import pg = require("pg");

export interface QueryResult {
  rows: any[];
  rowCount: number;
}

export interface Queryable {
  query(text: string, values?: any[]): Promise<QueryResult>;
}

// node-postgres 4.x is callback-only and has no Pool class; this wraps its global pool in Promises.
// int8/numeric come back as strings, which is what we want: uint256 amounts stay decimal strings
// and never pass through a JS double.
export class Conn implements Queryable {
  constructor(private client: any, private done: (destroy?: any) => void) {}

  query(text: string, values?: any[]): Promise<QueryResult> {
    return new Promise<QueryResult>((resolve, reject) => {
      this.client.query(text, values || [], (err: any, res: any) => (err ? reject(err) : resolve(res)));
    });
  }

  release(): void {
    this.done();
  }
}

export class Pool implements Queryable {
  constructor(private url: string, size?: number) {
    pg.defaults.poolSize = size || 10;
  }

  connect(): Promise<Conn> {
    return new Promise<Conn>((resolve, reject) => {
      pg.connect(this.url, (err: any, client: any, done: (destroy?: any) => void) => {
        if (err) reject(err);
        else resolve(new Conn(client, done));
      });
    });
  }

  async query(text: string, values?: any[]): Promise<QueryResult> {
    const c = await this.connect();
    try {
      return await c.query(text, values);
    } finally {
      c.release();
    }
  }

  end(): void {
    pg.end();
  }
}

export async function tx<T>(pool: Pool, fn: (c: Conn) => Promise<T>, isolation?: string): Promise<T> {
  const c = await pool.connect();
  try {
    await c.query("BEGIN ISOLATION LEVEL " + (isolation || "READ COMMITTED"));
    const r = await fn(c);
    await c.query("COMMIT");
    return r;
  } catch (e) {
    try {
      await c.query("ROLLBACK");
    } catch (ignored) {}
    throw e;
  } finally {
    c.release();
  }
}

/** Advisory-lock namespaces (first key of the two-int pg_advisory_* functions). */
export const LOCK_NS_APPLY = 0x4c45;
export const LOCK_NS_LEADER = 0x4c46;
