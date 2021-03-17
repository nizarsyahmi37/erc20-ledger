# Changelog

All notable changes to this project are documented in this file.
The format follows [Keep a Changelog](https://keepachangelog.com/en/1.0.0/) and the project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Added
- pg_isready healthcheck for the development database

### Changed
- docker-compose file uses format 3.8 and PostgreSQL 13 (9.5 remains the minimum supported version)
- Runtime baseline raised from Node 8.11 to Node 14.16 LTS (engines.node >= 14.16.0)
- TypeScript 2.9.2 -> 4.2.2, compiling to ES2020 so optional chaining, nullish coalescing and BigInt are native
- mocha 5.2.0 -> 8.3.0, @types/node 10 -> 14, @types/mocha 5 -> 8
- tsconfig adds esModuleInterop, skipLibCheck and forceConsistentCasingInFileNames
- pg 7.4.3 -> 8.5.1 (SCRAM-SHA-256 authentication, no connection workarounds needed on current Node)
- @types/pg 7.4 -> 7.14
- uint256 values are decoded from hex to exact decimal strings with native BigInt (log data and eth_call results)
- Config loader uses numeric separators for millisecond defaults and treats an empty variable as unset in one check
- tx() accepts an Isolation union (READ COMMITTED, REPEATABLE READ, SERIALIZABLE) instead of an arbitrary string
- JSON-RPC requests use the http timeout option and req.destroy() instead of the deprecated req.abort()
- Backoff sleep is util.promisify(setTimeout); status and error handling use ?. and ??
- Block ingestion builds event rows with flatMap instead of reduce and concat
- Poller derives bundle events with flatMap and uses ?. and ?? for cursors and log grouping, dropping a manual loop
- Reconciliation uses ?? for page size, diff cap, missing supply rows and re-queried supply values
- Health and balance responses use ?. and ??; responses chain writeHead().end() now that it returns the response
- Migration runner reads files through fs.promises
- Service loop sleeps with util.promisify(setTimeout) and logs reconcile detail with ??
- Fake chain and tests model token amounts as bigint, matching what the decoder now produces
- Tests use Node's built-in assert.rejects instead of a hand-written helper

### Removed
- bn.js and @types/bn.js dependencies

## [0.2.0] - 2018-07-26

### Added
- @types/node and @types/mocha
- @types/bn.js
- @types/pg
- Decoder test asserting that ERC-721 style Transfer logs are skipped
- package-lock.json (lockfile v1); install with npm ci

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
- Request URLs are parsed with the URL class and oversized bodies destroy the request with req.destroy()
- Health check runs its queries concurrently
- Migration runner uses util.promisify and String#endsWith
- main, migrate and rebuild entrypoints set the exit code on error and always close the pool
- Tests and fake chain use destructuring, object spread, padStart and strict null-safe types
- Compiler runs in strict mode with noUnusedLocals and noImplicitReturns
- README compatibility table, quick start (npm ci, PostgreSQL 10) and ERC-721 notes updated for Node 8, TypeScript 2.9 and pg 7
- Version bumped to 0.2.0
- Changelog links updated to Keep a Changelog 1.0.0 and Semantic Versioning 2.0.0

### Removed
- Hand-written Node and mocha typings (typings/node-lite.d.ts, typings/mocha-lite.d.ts)
- Hand-written typings/bn.d.ts
- Hand-written typings/pg.d.ts and the typings directory

### Fixed
- ERC-721 Transfer logs (same topic0, 4 topics) are documented as skipped now that the standard exists
- Bearer token is compared with crypto.timingSafeEqual over SHA-256 digests: constant time and no length leak

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
