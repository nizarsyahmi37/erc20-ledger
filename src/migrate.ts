"use strict";
import fs = require("fs");
import path = require("path");
import { createPool, Pool, tx } from "./db";

// Compiled layout is dist/src/migrate.js, so migrations live two levels up.
const DIR = path.join(__dirname, "..", "..", "migrations");

function readdir(dir: string): Promise<string[]> {
  return new Promise<string[]>((resolve, reject) => {
    fs.readdir(dir, (err: any, files: string[]) => (err ? reject(err) : resolve(files)));
  });
}

function readFile(file: string): Promise<string> {
  return new Promise<string>((resolve, reject) => {
    fs.readFile(file, "utf8", (err: any, data: string) => (err ? reject(err) : resolve(data)));
  });
}

export async function migrate(pool: Pool): Promise<string[]> {
  await pool.query("CREATE TABLE IF NOT EXISTS schema_migrations (name text PRIMARY KEY, applied_at timestamptz NOT NULL DEFAULT now())");
  const files = (await readdir(DIR)).filter((f) => /\.sql$/.test(f)).sort();
  const done: string[] = [];
  for (const f of files) {
    await tx(pool, async (c) => {
      await c.query("SELECT pg_advisory_xact_lock(7001)"); // serialise concurrent starters
      const r = await c.query("SELECT 1 FROM schema_migrations WHERE name = $1", [f]);
      if (r.rowCount > 0) return;
      await c.query(await readFile(path.join(DIR, f)));
      await c.query("INSERT INTO schema_migrations (name) VALUES ($1)", [f]);
      done.push(f);
    });
  }
  return done;
}

if (require.main === module) {
  const pool = createPool(process.env.DATABASE_URL || "");
  migrate(pool).then(
    (done) => {
      console.log(done.length > 0 ? "applied: " + done.join(", ") : "up to date");
      pool.end();
    },
    (err) => {
      console.error(err);
      pool.end();
      process.exit(1);
    }
  );
}
