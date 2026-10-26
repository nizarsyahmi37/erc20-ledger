import { createApi } from "./api.ts";
import { loadConfig } from "./config.ts";
import { createPool, LOCK_NS_LEADER } from "./db.ts";
import { errorMessage } from "./errors.ts";
import { migrate } from "./migrate.ts";
import { initNetworkState, tick } from "./poller.ts";
import { reconcile } from "./reconcile.ts";
import { JsonRpcClient } from "./rpc.ts";
import { pause } from "./time.ts";

async function main(): Promise<void> {
  const cfg = loadConfig(process.env);
  const pool = createPool(cfg.databaseUrl);
  await migrate(pool);
  await initNetworkState(pool, cfg);
  const rpc = new JsonRpcClient(cfg.rpcUrl);

  const api = createApi({ pool, networkId: cfg.networkId, tokens: cfg.tokens, ingestToken: cfg.ingestToken });
  api.listen(cfg.apiPort, () => console.log(`api on :${cfg.apiPort}`));

  // The first SIGINT/SIGTERM aborts the signal, which also cuts any sleep short; a second one exits at once.
  const shutdown = new AbortController();
  const stop = () => {
    if (shutdown.signal.aborted) process.exit(1);
    console.log("shutting down");
    shutdown.abort();
  };
  process.on("SIGINT", stop);
  process.on("SIGTERM", stop);

  // Single active writer per network. Correctness does not depend on this (apply is transactional and
  // locked); it just avoids N replicas doing identical RPC work. Held on a dedicated connection.
  const leader = await pool.connect();
  while (!shutdown.signal.aborted) {
    const r = await leader.query("SELECT pg_try_advisory_lock($1, $2) AS ok", [LOCK_NS_LEADER, cfg.networkId]);
    if (r.rows[0].ok) break;
    console.log("standby: another instance holds the leader lock");
    await pause(10_000, shutdown.signal);
  }

  let lastReconcile = 0;
  let fatal = false;
  while (!shutdown.signal.aborted) {
    let behind = false;
    try {
      const t = await tick(pool, rpc, cfg);
      behind = t.cursor !== null && t.head - t.cursor > cfg.confirmations + cfg.maxBlocksPerTick;
      if (t.ingested > 0 || t.reorgRolledBack > 0) console.log(`[tick] head=${t.head} cursor=${t.cursor} ingested=${t.ingested} ${t.apply}`);
    } catch (e) {
      const message = errorMessage(e);
      console.error("[tick] failed:", message);
      if (/halted|MAX_REORG_DEPTH/.test(message)) {
        fatal = true; // needs an operator
        break;
      }
      await pause(cfg.pollIntervalMs, shutdown.signal);
      continue;
    }
    if (cfg.reconcileIntervalMs > 0 && Date.now() - lastReconcile > cfg.reconcileIntervalMs) {
      lastReconcile = Date.now();
      const r = await reconcile(pool, rpc, { networkId: cfg.networkId });
      const log = r.status === "ok" ? console.log : console.error;
      log(`[reconcile] ${r.status} block=${r.blockNumber} checked=${r.checked} mismatched=${r.mismatched} ${r.detail ?? ""}`);
    }
    if (!behind) await pause(cfg.pollIntervalMs, shutdown.signal);
  }
  api.close();
  leader.release();
  await pool.end();
  process.exit(fatal ? 1 : 0);
}

main().catch(e => {
  console.error(e);
  process.exit(1);
});
