-- Requires PostgreSQL 9.5 (INSERT ... ON CONFLICT).
-- All addresses/hashes are lowercase 0x-hex text. Amounts are uint256 -> numeric(78,0).
-- network_id is the Ethereum network id (1 = Frontier/Homestead mainnet), as returned by net_version.

CREATE TABLE network_state (
  network_id     integer PRIMARY KEY,
  start_block  bigint  NOT NULL,
  tokens       text[]  NOT NULL,             -- fixed token set; changing it requires a reindex
  halted       boolean NOT NULL DEFAULT false,
  halt_reason  text,
  updated_at   timestamptz NOT NULL DEFAULT now()
);

-- Every block header we have ever seen, on ANY fork. Keyed by hash, so forks coexist.
-- There is deliberately no "canonical" flag: canonicality is derived by walking parent_hash
-- from a target the RPC node vouches for (see apply.ts).
CREATE TABLE blocks (
  network_id     integer NOT NULL,
  hash         text    NOT NULL CHECK (hash ~ '^0x[0-9a-f]{64}$'),
  number       bigint  NOT NULL CHECK (number >= 0),
  parent_hash  text    NOT NULL CHECK (parent_hash ~ '^0x[0-9a-f]{64}$'),
  event_count  integer NOT NULL CHECK (event_count >= 0),  -- completeness proof for duplicate deliveries
  ingested_at  timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (network_id, hash)
);
CREATE INDEX blocks_by_number ON blocks (network_id, number);

-- Natural key (network, block_hash, log_index) identifies a log in one specific version of a block.
-- A tx replayed in a different block after a reorg gets a different block_hash => distinct row.
CREATE TABLE events (
  network_id     integer NOT NULL,
  block_hash   text    NOT NULL,
  log_index    integer NOT NULL CHECK (log_index >= 0),
  block_number bigint  NOT NULL,
  tx_hash      text    NOT NULL,
  token        text    NOT NULL CHECK (token ~ '^0x[0-9a-f]{40}$'),
  kind         text    NOT NULL CHECK (kind IN ('transfer','mint','burn')),
  from_addr    text    NOT NULL CHECK (from_addr ~ '^0x[0-9a-f]{40}$'),
  to_addr      text    NOT NULL CHECK (to_addr ~ '^0x[0-9a-f]{40}$'),
  amount       numeric(78,0) NOT NULL CHECK (amount >= 0),
  PRIMARY KEY (network_id, block_hash, log_index),
  FOREIGN KEY (network_id, block_hash) REFERENCES blocks (network_id, hash) ON DELETE CASCADE
);
CREATE INDEX events_by_holder_from ON events (network_id, token, from_addr);
CREATE INDEX events_by_holder_to   ON events (network_id, token, to_addr);

-- The canonical chain we have folded into balances. Contiguous by construction.
-- PK (network_id, number) is the double-apply guard.
CREATE TABLE applied_blocks (
  network_id integer NOT NULL,
  number   bigint  NOT NULL,
  hash     text    NOT NULL,
  applied_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (network_id, number),
  FOREIGN KEY (network_id, hash) REFERENCES blocks (network_id, hash)
);

-- Derived state. Always rebuildable from applied_blocks + events (see rebuild.ts).
-- No CHECK (balance >= 0): a bad start_block or non-standard token must surface in reconciliation,
-- not wedge ingestion.
CREATE TABLE balances (
  network_id integer NOT NULL,
  token    text    NOT NULL,
  holder   text    NOT NULL,
  balance  numeric(78,0) NOT NULL,
  PRIMARY KEY (network_id, token, holder)
);

CREATE TABLE token_supply (
  network_id integer NOT NULL,
  token    text    NOT NULL,
  supply   numeric(78,0) NOT NULL,   -- sum(mints) - sum(burns)
  PRIMARY KEY (network_id, token)
);

CREATE TABLE reconciliation_runs (
  id            bigserial PRIMARY KEY,
  network_id      integer NOT NULL,
  block_number  bigint,
  block_hash    text,
  status        text NOT NULL CHECK (status IN ('ok','drift','inconclusive','error')),
  checked       integer NOT NULL DEFAULT 0,
  mismatched    integer NOT NULL DEFAULT 0,
  detail        text,
  started_at    timestamptz NOT NULL DEFAULT now(),
  finished_at   timestamptz
);

CREATE TABLE reconciliation_diffs (
  run_id   bigint NOT NULL REFERENCES reconciliation_runs(id) ON DELETE CASCADE,
  token    text NOT NULL,
  holder   text NOT NULL,           -- '*supply*' for the totalSupply check
  ours     numeric(78,0) NOT NULL,
  onchain  numeric(78,0) NOT NULL
);
