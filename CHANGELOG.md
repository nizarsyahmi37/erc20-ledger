# Changelog

All notable changes to this project are documented in this file.
The format follows [Keep a Changelog](http://keepachangelog.com/) and the project adheres to [Semantic Versioning](http://semver.org/).

## [Unreleased]

### Added
- @types/node and @types/mocha
- @types/bn.js
- @types/pg

### Changed
- docker-compose file moved to the version 3 format and PostgreSQL 10 (9.5 remains the minimum supported version)
- .env.example mentions geth and Parity as supported JSON-RPC endpoints
- Runtime baseline raised from Node 4.2 to Node 8.11 LTS (engines.node >= 8.11.0)
- TypeScript 1.7.5 -> 2.9.2, compiling to ES2017 so async/await is native instead of a generator helper
- mocha 2.3.4 -> 5.2.0
- bn.js 4.6.1 -> 4.11.8
- pg 4.4.3 -> 7.4.3: the hand-written Promise wrapper over the global pool is replaced by the built-in Pool, created with createPool()
- Entrypoints and tests create their pool with createPool()
- Config loader uses template strings, array spread and the typed NodeJS.ProcessEnv
- ingestToken is typed string | null
- EventKind is a string-literal type and decodeTransfer returns DecodedEvent | null
- JSON-RPC client parses endpoints with the WHATWG URL class and sends basic-auth credentials from it
- ChainRpc states nullable headers and totalSupply explicitly; address padding uses padStart and backoff uses the ** operator
- Block ingestion uses object spread, array spread and Array#every instead of manual loops and Object.assign
- ApplyResult is a discriminated union on status, so callers get typed from/to and missingNumber/missingHash fields
- getCursor returns Cursor | null
- Header presence is checked with a type guard; TickResult.cursor is number | null
- Replace manual loops with find, includes and spread; known and just-stored block hashes share one set
- ReconcileStatus is a string-literal union; blockNumber and detail are nullable and always present in results

### Removed
- Hand-written Node and mocha typings (typings/node-lite.d.ts, typings/mocha-lite.d.ts)
- Hand-written typings/bn.d.ts
- Hand-written typings/pg.d.ts and the typings directory

### Fixed
- ERC-721 Transfer logs (same topic0, 4 topics) are documented as skipped now that the standard exists

## [0.1.0] - 2016-02-04

### Added
- Project scaffold targeting Node 4.2 LTS: TypeScript 1.7.5 (ES6 target, CommonJS), `pg` 4.4.3 and `bn.js` 4.6.1 as the only runtime dependencies, mocha 2.3.4 for tests
- Dependencies pinned to exact versions
- PostgreSQL 9.5 via docker-compose (v1 file format) and `.env.example` configuration template
- Hand-written minimal type declarations for the Node 4 modules, node-postgres 4.x, bn.js and mocha globals used by the project
- Hash-keyed `blocks` and `events` tables so competing forks coexist
- `applied_blocks`, `balances` and `token_supply` as derived, rebuildable state
- `reconciliation_runs` / `reconciliation_diffs` and `network_state` (halt flag, fixed token set), keyed by Ethereum network id
- Promise wrapper over node-postgres 4.x callback API and its global pool
- `tx()` helper with configurable isolation level
- Advisory-lock namespaces for per-network apply and leader election
- Idempotent SQL migration runner (`npm run migrate`) serialised by an advisory lock
- Env loader validating token addresses, integers and required variables
- Settings for confirmations, reorg depth, batch size, polling and reconciliation intervals
- Transfer decoder classifying mint (from 0x0) and burn (to 0x0)
- uint256 amounts converted from hex to exact decimal strings with bn.js
- Transfer-shaped logs that are not ERC-20 (wrong topic count or data size) are skipped instead of misparsed
- Whole-block ingestion (header plus all logs) in a single transaction
- Duplicate deliveries are no-ops via `ON CONFLICT DO NOTHING`
- Contradicting re-deliveries raise `IngestConflictError` instead of being merged
- `applyThrough` walks parent hashes from a trusted target; returns `gap` or `diverged` when the chain is incomplete or disconnected
- Atomic balance, supply and `applied_blocks` update under a per-network advisory lock
- `rollbackTo`, `rebuildBalances` (`npm run rebuild-balances`) and `halt`
- HTTP(S) JSON-RPC 2.0 client with batching, timeout and exponential backoff retries
- Range `eth_getLogs` and historical `balanceOf` / `totalSupply` via `eth_call`
- Tick ingests up to head and applies only up to `head - CONFIRMATIONS`
- Fork-consistent log fetching without a blockHash filter: header/log/header sandwich, blocks whose hash changed mid-fetch are skipped and retried
- Applied tip is re-checked against the node; common ancestor found and balances rolled back on deep reorgs
- Halts beyond `MAX_REORG_DEPTH`; a lagging node is treated as transient, never as a reorg
- Startup guard refusing a changed `TOKENS` / `START_BLOCK` for an existing database
- Comparison pinned to the applied tip inside a single REPEATABLE READ snapshot
- Outcomes `ok`, `drift`, `inconclusive` (reorg during scan) and `error`
- Mismatches re-queried once before being recorded; results persisted with exact diffs
- `GET /balances/:token/:holder` returning confirmed balance with its block number and hash
- `GET /healthz` with cursor, halt state and last reconciliation
- Optional bearer-authenticated `POST /ingest` with strict validation, constant-time token check and body size limit
- Service entrypoint with leader election by advisory lock and graceful shutdown
- Periodic reconciliation with status logging; stops on halt for operator action
- In-memory chain supporting forks, used against a real PostgreSQL
- 15 mocha tests: idempotency, out-of-order delivery, orphan forks, deep reorg rollback, reorg during log fetch, halt, reconciliation outcomes and concurrent appliers
- README covering design, confirmations and failure modes for duplicates, out-of-order delivery, reorgs, node, process and reconciliation
- Compatibility baseline table and documented limits for production use
