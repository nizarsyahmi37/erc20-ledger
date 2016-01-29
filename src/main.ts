"use strict";
import { createApi } from "./api";
import { loadConfig } from "./config";
import { LOCK_NS_LEADER, Pool } from "./db";
import { migrate } from "./migrate";
import { initNetworkState, tick } from "./poller";
import { reconcile } from "./reconcile";
import { JsonRpcClient } from "./rpc";

function sleep(ms: number): Promise<void> {
  return new Promise<void>((resolve) => {
    setTimeout(resolve, ms);
  });
}

async function main(): Promise<void> {
  const cfg = loadConfig(process.env);
  const pool = new Pool(cfg.databaseUrl);
  await migrate(pool);
  await initNetworkState(pool, cfg);
  const rpc = new JsonRpcClient(cfg.rpcUrl);

  const api = createApi({ pool: pool, networkId: cfg.networkId, tokens: cfg.tokens, ingestToken: cfg.ingestToken });
  api.listen(cfg.apiPort, () => console.log("api on :" + cfg.apiPort));

  let stopping = false;
  const stop = () => {
    stopping = true;
  };
  process.on("SIGINT", stop);
  process.on("SIGTERM", stop);

  // Single active writer per network. Correctness does not depend on this (apply is transactional and
  // locked); it just avoids N replicas doing identical RPC work. Held on a dedicated connection.
  const leader = await pool.connect();
  while (!stopping) {
    const r = await leader.query("SELECT pg_try_advisory_lock($1, $2) AS ok", [LOCK_NS_LEADER, cfg.networkId]);
    if (r.rows[0].ok) break;
    console.log("standby: another instance holds the leader lock");
    await sleep(10000);
  }

  let lastReconcile = 0;
  let fatal = false;
  while (!stopping) {
    let behind = false;
    try {
      const t = await tick(pool, rpc, cfg);
      behind = t.cursor !== null && t.head - t.cursor > cfg.confirmations + cfg.maxBlocksPerTick;
      if (t.ingested > 0 || t.reorgRolledBack > 0) console.log("[tick] head=" + t.head + " cursor=" + t.cursor + " ingested=" + t.ingested + " " + t.apply);
    } catch (e) {
      console.error("[tick] failed:", e.message);
      if (/halted|MAX_REORG_DEPTH/.test(e.message)) {
        fatal = true; // needs an operator
        break;
      }
      await sleep(cfg.pollIntervalMs);
      continue;
    }
    if (cfg.reconcileIntervalMs > 0 && Date.now() - lastReconcile > cfg.reconcileIntervalMs) {
      lastReconcile = Date.now();
      const r = await reconcile(pool, rpc, { networkId: cfg.networkId });
      const log = r.status === "ok" ? console.log : console.error;
      log("[reconcile] " + r.status + " block=" + r.blockNumber + " checked=" + r.checked + " mismatched=" + r.mismatched + " " + (r.detail || ""));
    }
    if (!behind) await sleep(cfg.pollIntervalMs);
  }
  api.close();
  leader.release();
  pool.end();
  process.exit(fatal ? 1 : 0);
}

main().catch((e: any) => {
  console.error(e);
  process.exit(1);
});
