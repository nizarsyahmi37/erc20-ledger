# erc20-ledger

Indexes ERC-20 (EIP-20) `Transfer` events, including mints and burns, into PostgreSQL. It keeps per-holder
balances that stay correct under duplicates, out-of-order delivery and chain reorgs, and continuously
reconciles those balances against the chain.

TypeScript 5.3 as native ES modules, Node.js >= 20.11 (LTS), PostgreSQL >= 9.5 (developed against 16), a geth, Nethermind, Erigon or Reth JSON-RPC endpoint.

```
docker compose up -d                 # postgres 16 on :5433
cp .env.example .env                 # set RPC_URL, TOKENS, START_BLOCK (loaded with node --env-file)
npm ci && npm run build
npm run migrate
npm start                            # poller + API + periodic reconciliation
TEST_DATABASE_URL=postgres://... npm test
```

The npm scripts load `.env` with `node --env-file`. To configure through the real environment instead, export
the variables and run `node dist/src/main.js` (or `migrate.js`, `rebuild.js`) directly.

API: `GET /healthz`, `GET /balances/:token/:holder`, `POST /ingest` (optional, bearer-auth).

## Compatibility baseline

Everything here was chosen to exist in February 2024.

| Piece | Version | Notes |
|---|---|---|
| Node.js | 20.11 LTS ("Iron") | native ES modules (`import.meta.dirname`), global `fetch` and `AbortSignal.timeout`, `node:test`, `--env-file`, `Array#findLast` / `toSorted`, `timers/promises`; no `--env-file-if-exists` (Node 22), no `Object.groupBy` (Node 21), no `require(esm)` |
| TypeScript | 5.3.3 | `module: NodeNext`, `strict` including `unknown` catch variables; `verbatimModuleSyntax` is not enabled |
| PostgreSQL | 16 (>= 9.5) | `INSERT ... ON CONFLICT` is the idempotency primitive; multi-array `UNNEST`, recursive CTEs; SCRAM-SHA-256 is the default password scheme |
| pg (node-postgres) | 8.11.3 | built-in `Pool`; a CommonJS package, so it is imported as a default from ESM |
| Test runner | `node:test` + `node:assert/strict` | no mocha; `--test-concurrency=1` because the suites share one database |
| `@types/*` | node 20.11, pg 8.11 | |
| JSON-RPC | geth 1.13 / Nethermind / Erigon / Reth | `eth_getBlockByNumber`, `eth_getLogs` (range), `eth_call` at a block, batch requests |
| Lockfile | npm 10 `package-lock.json` (v3) | install with `npm ci` |

Consequences worth knowing: the `eth_getLogs` `blockHash` filter (EIP-234) is available on most clients
now but not on every provider, so the service still gets fork-consistent logs with a header/log/header
"sandwich" (see Reorgs) and works against any of them. Rows are keyed by **network id** (the
`net_version` value) rather than the EIP-155 chain id, so the node does not need to implement `eth_chainId`.

## Design in one page

Three ideas carry the whole correctness story.

**1. Ingestion is dumb and order-independent.** The unit of ingestion is a *whole block*: header plus
every tracked log, committed in one transaction. Blocks are keyed by **hash**, not height, so competing
forks coexist as separate rows. Events are keyed `(network_id, block_hash, log_index)`. Inserting the
same block twice, in any order, interleaved with other forks, is a no-op. There is no `canonical` flag to
get out of sync.

**2. Canonicality is derived, never stored.** `applyThrough(targetHash)` takes a block hash the RPC node
vouches for at depth >= `CONFIRMATIONS`, then walks `parent_hash` links in our own table back to the last
applied block. If a link is missing the answer is `gap` (try again later); if the walk doesn't connect
to our applied tip the answer is `diverged`. Only blocks on the walked chain are folded into balances,
so an orphaned fork's events can never reach `balances`, however they arrived.

**3. Balances are a pure function of `applied_blocks` + `events`.** `balances` and `token_supply` are
sums, so application order within a range is irrelevant, and the whole thing can be rolled back
(subtract) or rebuilt from scratch (`npm run rebuild-balances`). The apply transaction writes balances,
supply and `applied_blocks` atomically under a per-network advisory lock; `applied_blocks`'s primary key
`(network_id, number)` is the final double-apply guard.

```
RPC / push ──► ingestBundles ──► blocks + events (all forks)
                                       │
RPC head-N ─► target hash ─► applyThrough: walk parent_hash ─► applied_blocks + balances + token_supply
                                       │
                 tick(): re-check applied tip vs node ─► rollbackTo(common ancestor) on deep reorg
                 reconcile(): balanceOf/totalSupply at the applied tip ─► reconciliation_runs/diffs
```

Mint = `from == 0x0`, burn = `to == 0x0`. The zero address has no balance row; supply moves by
`sum(mints) - sum(burns)`. Amounts are `numeric(78,0)` (uint256) and travel as decimal strings; they never
pass through a JS number.

### Confirmations

Blocks are *ingested* up to head but *applied* only when `head - CONFIRMATIONS` is reached. Unconfirmed
events are stored and inert. `GET /balances` returns only confirmed state, tagged with `asOfBlock` /
`asOfHash` from the same snapshot. Confirmations are a policy to reduce churn, not the safety mechanism:
a reorg that gets past them is still handled by rollback (below).

## Failure modes

For each: what happens, how you'd see it, and what to do.

### Duplicates

| Source | Behaviour |
|---|---|
| Same block delivered twice (retry, at-least-once relay, two replicas) | `ON CONFLICT DO NOTHING`; returns `blocksDuplicate`. No state change. |
| Same log twice inside one block payload | Collapsed in memory before insert. |
| Same tx re-mined in a *different* block after a reorg | Different `block_hash` => different row, but only the block on the applied chain counts, so it is counted once. (Tested.) |
| Concurrent appliers (two replicas, retries) | Per-network `pg_advisory_xact_lock`; the loser sees `noop`. Leader election in `main.ts` is only an efficiency measure. (Tested with 8 parallel appliers.) |
| Re-delivery that **contradicts** what is stored (different parent or different log count) | `IngestConflictError` -> HTTP 409. Not merged silently. |

### Out-of-order delivery

Blocks may arrive in any order. `applyThrough` returns `gap` with the missing height/hash until the
chain from the target back to the applied tip is complete, then applies it in one transaction. Result is
identical to in-order delivery (tested with shuffled + duplicated delivery). A permanently missing block
stalls the cursor and is visible in `/healthz` as `latestIngestedBlock` running ahead of `appliedBlock`.
The poller re-fetches from `cursor+1` on every tick, so it self-heals when the source is RPC.

### Reorgs

| Case | Behaviour |
|---|---|
| Fork abandoned before it reaches `CONFIRMATIONS` | Orphan rows stay in `blocks`/`events` but are never on a walked chain. No balance effect. (Tested.) |
| Reorg **deeper** than `CONFIRMATIONS`, after we applied | Every tick compares the applied tip's hash with the node. On mismatch we find the common ancestor, `rollbackTo` (subtract orphaned deltas, delete `applied_blocks`), and re-apply the new chain. Logged as `[reorg]`. (Tested; result equals a from-scratch rebuild.) |
| Reorg deeper than `MAX_REORG_DEPTH` | **Halts** (`network_state.halted`, reason in `/healthz`) instead of guessing. Needs an operator: raise the depth or reindex. This usually means a wrong `NETWORK_ID`/RPC, a network-wide incident, or a node that switched networks. |
| Node is merely **behind** (load-balanced RPC) | A missing block is treated as a transient error, never as a reorg, so a lagging node can't trigger a halt. |
| Reorg *during* a fetch | geth of this era has no `blockHash` log filter, so a block is stored only if the node reported the **same hash before and after** the `eth_getLogs` call and each log carries that block hash. Blocks that flipped are skipped and re-fetched next tick. (Tested.) |
| Node reports `removed: true` logs | Rejected as inconsistent (only newer clients emit the flag). We never consume removal notices; we drop orphans by hash. |

### Node problems

* **RPC errors, timeouts, rate limits:** retried with backoff in `rpc.ts`; a failing tick logs and retries
  next interval. Nothing is half-applied because each tick's DB work is transactional.
* **Node returns wrong data** (buggy, malicious, or a partially synced node): the service trusts its RPC
  for headers and logs. Run against a node you control or use two providers and compare. Reconciliation
  uses the *same* node by default, so it cannot detect a node that lies consistently.
* **Historical state required for reconciliation:** `eth_call` at an old block fails if the node has
  pruned that state (fast-synced geth keeps only recent state). The run is recorded as `error`, **not**
  `ok`. Reconciliation is pinned to the applied tip, which is `CONFIRMATIONS` behind head, so a recent
  state window is enough.
* **No JSON-RPC batch support:** the client sends batch requests; a node that rejects them fails loudly
  at the first tick rather than misbehaving.
* **Large `eth_getLogs` ranges:** some nodes cap range or result size. Lower `MAX_BLOCKS_PER_TICK`.
* **Non-standard tokens:** the model is "balance = sum of Transfer amounts". Fee-on-transfer, rebasing,
  elastic-supply, or tokens that mint/burn without emitting `Transfer` will drift. Reconciliation will
  report this as `drift`; it is a property of the token, not a bug to retry. Exclude such tokens.
  ERC-721 `Transfer` shares topic0 with ERC-20 but has 4 topics and no data word; it (and anything else
  that is not exactly 3 topics plus a 32-byte value) is skipped rather than misparsed. Tokens that emit a *non-Transfer* mint event only are not supported.

### Process / database

* **Crash mid-tick:** every write unit is a single transaction. Restart resumes from `applied_blocks`.
  Ingested-but-unapplied blocks are reused (hash lookup) rather than re-fetched.
* **Two instances:** one wins `pg_try_advisory_lock` and works; the other stands by. If the lock holder
  hangs without dropping its connection, stale-lock recovery is Postgres' connection timeout; set
  `tcp_keepalives_*` appropriately.
* **Derived state corrupted** (bad manual `UPDATE`, bug): `npm run rebuild-balances` recomputes
  `balances`/`token_supply` from `applied_blocks` + `events` under the apply lock.
* **Long reconciliation vs. writes:** reconciliation holds one `REPEATABLE READ` read-only snapshot for the
  scan so "ours" is exactly the state at the pinned block while the poller keeps applying. For millions of
  holders this snapshot will be open for a long time (vacuum bloat); shard by token.
* **Disk growth:** `events` and `applied_blocks` are append-only and retained (needed for rollback and
  rebuild). Orphaned-fork rows are kept; prune `blocks`/`events` for numbers well below the cursor that
  are not in `applied_blocks` if size matters. Never prune applied ones.

### Reconciliation outcomes

A run compares `balanceOf(holder)` for every holder we know, plus `totalSupply()`, **at the pinned
applied-tip block**, and stores the result in `reconciliation_runs` / `reconciliation_diffs`.

| Status | Meaning |
|---|---|
| `ok` | Every checked value matched at that block. |
| `drift` | Confirmed mismatch (each mismatch is re-queried once to filter transient node answers). Diffs show `ours` vs `onchain`; `*supply*` is the totalSupply check. **It does not auto-repair**; a human decides whether it is a token quirk, a start-block problem, or a bug. |
| `inconclusive` | The pinned block stopped being canonical before/after the scan (reorg in flight) or nothing is applied yet. Never reported as drift. |
| `error` | Node/DB failure. Never reported as ok. |

Blind spot: only holders **we** know are checked per-address. A holder we missed entirely can't be
enumerated on-chain; it shows up as a `*supply*` mismatch instead. Monitor `status != ok`.

## Limits and sharp edges (read before production)

1. **Index from the token's deployment block.** Balances are sums since `START_BLOCK`. Starting later
   gives wrong (possibly negative) balances; there is deliberately no `CHECK (balance >= 0)` so the
   error surfaces in reconciliation instead of wedging ingestion.
2. **The token set is fixed per database.** A block row's `event_count` certifies completeness for the
   token set it was fetched with. Adding a token later means the stored blocks are incomplete for it.
   `initNetworkState` refuses to start if `TOKENS`/`START_BLOCK` changed. To add a token, index into a
   fresh database.
3. **`POST /ingest` is for trusted relays only.** Blocks are stored as delivered; if a pushed block's
   hash is later on the confirmed chain its events are applied. An attacker with the token could push a
   real hash with fake logs *before* the poller fetches it. A same-hash, same-count, different-amount
   re-delivery is not detectable (the key dedupes it). Leave `INGEST_TOKEN` unset to disable the endpoint.
4. **RPC throughput:** one `eth_getBlockByNumber` per block (batched, 50 per request) read twice per tick
   for the consistency sandwich, plus one range `eth_getLogs`. A multi-million-block backfill is bounded
   by header throughput.
5. **Block numbers are JS numbers** (safe far beyond any plausible chain height). uint256 amounts are decoded
   with native `BigInt` and stored as exact decimal strings in `numeric(78,0)`; they never pass through a JS number.
6. **Addresses and hashes are lowercase hex `text`.** Simple and debuggable; `bytea` would roughly halve
   index size.
7. **Single network per process** (`NETWORK_ID`); the schema is network-keyed, the poller is not multiplexed.
8. **No auth on the read API.** Put it behind your gateway.

## Layout

```
migrations/001_init.sql   schema (hash-keyed blocks/events, applied_blocks, balances, reconciliation_*)
src/db.ts                 pg Pool setup, tx() helper, lock namespaces
src/errors.ts             errorMessage() for unknown caught values
src/decode.ts             Transfer -> mint|burn|transfer; uint256 as decimal string
src/ingest.ts             atomic, idempotent, order-independent block persistence
src/apply.ts              parent-walk, apply, rollback, rebuild, halt
src/poller.ts             tick(): reorg check -> consistent fetch -> ingest -> apply
src/reconcile.ts          pinned-block comparison against eth_call
src/rpc.ts                JSON-RPC client (batching, retries) behind the ChainRpc interface
src/api.ts, main.ts       HTTP API, leader lock, scheduler
test/ledger.test.ts       15 tests against real Postgres with an in-memory forking chain
test/rpc.test.ts          JSON-RPC client against a local HTTP server (no database needed)
test/api.test.ts          HTTP API against real Postgres
```
