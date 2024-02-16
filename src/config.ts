export interface Config {
  databaseUrl: string;
  networkId: number;
  rpcUrl: string;
  tokens: string[];
  startBlock: number;
  confirmations: number;
  maxReorgDepth: number;
  pollIntervalMs: number;
  maxBlocksPerTick: number;
  reconcileIntervalMs: number;
  apiPort: number;
  ingestToken: string | null;
}

function req(env: NodeJS.ProcessEnv, key: string): string {
  const v = env[key];
  if (!v) throw new Error(`missing required env var ${key}`);
  return v;
}

function int(env: NodeJS.ProcessEnv, key: string, dflt: number, min: number): number {
  const raw = env[key];
  if (!raw) return dflt;
  const n = Number(raw);
  if (!Number.isInteger(n) || n < min) throw new Error(`${key} must be an integer >= ${min}`);
  return n;
}

export function loadConfig(env: NodeJS.ProcessEnv): Config {
  const tokens = req(env, "TOKENS")
    .split(",")
    .map(t => t.trim().toLowerCase())
    .filter(t => t.length > 0);
  if (tokens.length === 0) throw new Error("TOKENS is empty");
  for (const t of tokens) if (!/^0x[0-9a-f]{40}$/.test(t)) throw new Error(`bad token address: ${t}`);
  return {
    databaseUrl: req(env, "DATABASE_URL"),
    networkId: int(env, "NETWORK_ID", 1, 0),
    rpcUrl: req(env, "RPC_URL"),
    tokens: [...new Set(tokens)].toSorted(),
    startBlock: int(env, "START_BLOCK", 0, 0),
    confirmations: int(env, "CONFIRMATIONS", 12, 0),
    maxReorgDepth: int(env, "MAX_REORG_DEPTH", 256, 1),
    pollIntervalMs: int(env, "POLL_INTERVAL_MS", 4_000, 100),
    maxBlocksPerTick: int(env, "MAX_BLOCKS_PER_TICK", 200, 1),
    reconcileIntervalMs: int(env, "RECONCILE_INTERVAL_MS", 900_000, 0),
    apiPort: int(env, "API_PORT", 8080, 1),
    ingestToken: env.INGEST_TOKEN || null
  };
}
