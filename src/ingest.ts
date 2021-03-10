import { Pool, tx } from "./db";
import { DecodedEvent } from "./decode";

export interface BlockBundle {
  networkId: number;
  number: number;
  hash: string;
  parentHash: string;
  events: DecodedEvent[];
}

export class IngestConflictError extends Error {}

export interface IngestResult {
  blocksNew: number;
  blocksDuplicate: number;
  eventsNew: number;
}

const sameEvent = (a: DecodedEvent, b: DecodedEvent) =>
  a.logIndex === b.logIndex && a.txHash === b.txHash && a.token === b.token && a.from === b.from && a.to === b.to && a.amount === b.amount;

function dedupeEvents(b: BlockBundle): DecodedEvent[] {
  const m = new Map<number, DecodedEvent>();
  for (const e of b.events) {
    const prev = m.get(e.logIndex);
    if (prev && !sameEvent(prev, e)) throw new IngestConflictError(`conflicting logs for ${b.hash}:${e.logIndex}`);
    m.set(e.logIndex, e);
  }
  return [...m.values()].sort((x, y) => x.logIndex - y.logIndex);
}

function assertSameBundle(a: BlockBundle, b: BlockBundle): void {
  const ea = dedupeEvents(a);
  const eb = dedupeEvents(b);
  const same = a.number === b.number && a.parentHash === b.parentHash && ea.length === eb.length && ea.every((e, i) => sameEvent(e, eb[i]));
  if (!same) throw new IngestConflictError(`block ${a.hash} delivered twice with different content`);
}

/**
 * Persist whole blocks (header + every tracked log) atomically. Safe to call with:
 *  - the same bundle repeatedly  -> no-op (PK + ON CONFLICT DO NOTHING)
 *  - bundles in any order        -> nothing here depends on order; ordering is resolved at apply time
 *  - competing forks             -> distinct block hashes, stored side by side
 * A re-delivery that DISAGREES with what we stored (different parent, or different log count) throws
 * IngestConflictError instead of being silently merged.
 */
export async function ingestBundles(pool: Pool, bundles: BlockBundle[]): Promise<IngestResult> {
  if (bundles.length === 0) return { blocksNew: 0, blocksDuplicate: 0, eventsNew: 0 };

  const byHash = new Map<string, BlockBundle>();
  for (const b of bundles) {
    const seen = byHash.get(b.hash);
    if (seen) assertSameBundle(seen, b);
    else byHash.set(b.hash, { ...b, events: dedupeEvents(b) });
  }
  const list = [...byHash.values()];

  return tx(pool, async c => {
    const ins = await c.query(
      `INSERT INTO blocks (network_id, hash, number, parent_hash, event_count)
       SELECT * FROM UNNEST($1::int[], $2::text[], $3::bigint[], $4::text[], $5::int[])
       ON CONFLICT (network_id, hash) DO NOTHING RETURNING hash`,
      [list.map(b => b.networkId), list.map(b => b.hash), list.map(b => b.number), list.map(b => b.parentHash), list.map(b => b.events.length)]
    );
    const fresh = new Set<string>(ins.rows.map(r => r.hash));

    // Pre-existing blocks: verify the redelivery agrees with what we stored.
    const existing = list.filter(b => !fresh.has(b.hash));
    if (existing.length > 0) {
      const chk = await c.query(
        "SELECT hash, number, parent_hash, event_count FROM blocks WHERE network_id = $1 AND hash = ANY($2::text[])",
        [existing[0].networkId, existing.map(b => b.hash)]
      );
      for (const row of chk.rows) {
        const b = byHash.get(row.hash)!;
        if (Number(row.number) !== b.number || row.parent_hash !== b.parentHash || row.event_count !== b.events.length) {
          throw new IngestConflictError(`block ${b.hash} redelivered with different content`);
        }
      }
    }

    const rows = list.filter(b => fresh.has(b.hash)).flatMap(b => b.events.map(e => ({ b, e })));
    let eventsNew = 0;
    if (rows.length > 0) {
      const r = await c.query(
        `INSERT INTO events (network_id, block_hash, log_index, block_number, tx_hash, token, kind, from_addr, to_addr, amount)
         SELECT * FROM UNNEST($1::int[], $2::text[], $3::int[], $4::bigint[], $5::text[], $6::text[], $7::text[], $8::text[], $9::text[], $10::numeric[])
         ON CONFLICT (network_id, block_hash, log_index) DO NOTHING`,
        [
          rows.map(x => x.b.networkId),
          rows.map(x => x.b.hash),
          rows.map(x => x.e.logIndex),
          rows.map(x => x.b.number),
          rows.map(x => x.e.txHash),
          rows.map(x => x.e.token),
          rows.map(x => x.e.kind),
          rows.map(x => x.e.from),
          rows.map(x => x.e.to),
          rows.map(x => x.e.amount)
        ]
      );
      eventsNew = r.rowCount;
    }
    return { blocksNew: fresh.size, blocksDuplicate: existing.length, eventsNew };
  });
}
