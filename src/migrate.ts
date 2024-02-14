import { promises as fs } from "node:fs";
import * as path from "node:path";
import { createPool, Pool, tx } from "./db";

// Compiled layout is dist/src/migrate.js, so migrations live two levels up.
const DIR = path.join(__dirname, "..", "..", "migrations");

export async function migrate(pool: Pool): Promise<string[]> {
  await pool.query("CREATE TABLE IF NOT EXISTS schema_migrations (name text PRIMARY KEY, applied_at timestamptz NOT NULL DEFAULT now())");
  const files = (await fs.readdir(DIR)).filter(f => f.endsWith(".sql")).sort();
  const done: string[] = [];
  for (const f of files) {
    await tx(pool, async c => {
      await c.query("SELECT pg_advisory_xact_lock(7001)"); // serialise concurrent starters
      const r = await c.query("SELECT 1 FROM schema_migrations WHERE name = $1", [f]);
      if ((r.rowCount ?? 0) > 0) return;
      await c.query(await fs.readFile(path.join(DIR, f), "utf8"));
      await c.query("INSERT INTO schema_migrations (name) VALUES ($1)", [f]);
      done.push(f);
    });
  }
  return done;
}

if (require.main === module) {
  const pool = createPool(process.env.DATABASE_URL || "");
  migrate(pool)
    .then(done => console.log(done.length > 0 ? `applied: ${done.join(", ")}` : "up to date"))
    .catch(err => {
      console.error(err);
      process.exitCode = 1;
    })
    .then(() => pool.end());
}
