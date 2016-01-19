# Changelog

All notable changes to this project are documented in this file.
The format follows [Keep a Changelog](http://keepachangelog.com/) and the project adheres to [Semantic Versioning](http://semver.org/).

## [Unreleased]

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
