"use strict";
import { rebuildBalances } from "./apply";
import { createPool } from "./db";

const networkId = Number(process.env.NETWORK_ID || 1);
const pool = createPool(process.env.DATABASE_URL || "");
rebuildBalances(pool, networkId).then(
  () => {
    console.log("rebuilt balances for network " + networkId + " from applied_blocks + events");
    pool.end();
  },
  (err: any) => {
    console.error(err);
    pool.end();
    process.exit(1);
  }
);
