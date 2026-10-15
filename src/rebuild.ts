import { rebuildBalances } from "./apply.ts";
import { createPool } from "./db.ts";

const networkId = Number(process.env.NETWORK_ID || 1);
const pool = createPool(process.env.DATABASE_URL || "");
rebuildBalances(pool, networkId)
  .then(() => console.log(`rebuilt balances for network ${networkId} from applied_blocks + events`))
  .catch(err => {
    console.error(err);
    process.exitCode = 1;
  })
  .then(() => pool.end());
