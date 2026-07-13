import { GatewayError } from './errors.js';

/**
 * Schema migration registry (docs/21 §6.1; roadmap Phase 2 — schema evolution policy: auto
 * migrate-on-read). Every shipped schema is major 1. When a breaking on-disk change lands, its new
 * major ships WITH a registered migration from the previous major, so any newer gateway can read any
 * older state. readJsonState applies the chain IN MEMORY on read (never writing during a read — a
 * lock-free audit read must stay side-effect-free); the on-disk file converges to the new major the
 * next time it is written, or eagerly via `sigmarun migrate`.
 */
export type MigrationFn = (doc: Record<string, unknown>) => Record<string, unknown>;

const BASE_MAJOR = 1;
/** object -> (fromMajor -> fn that produces the fromMajor+1 doc) */
const migrations = new Map<string, Map<number, MigrationFn>>();

export function registerMigration(object: string, fromMajor: number, fn: MigrationFn): void {
  if (!migrations.has(object)) migrations.set(object, new Map());
  migrations.get(object)!.set(fromMajor, fn);
}

/** Test hook: drop all registered migrations so a synthetic one can't leak across tests. */
export function clearMigrations(): void {
  migrations.clear();
}

/** The highest major reachable from v1 via a contiguous chain of registered migrations. */
export function currentSchemaMajor(object: string): number {
  const chain = migrations.get(object);
  let major = BASE_MAJOR;
  while (chain?.has(major)) major++;
  return major;
}

export function parseSchemaVersion(sv: unknown): { object: string; major: number } | null {
  if (typeof sv !== 'string') return null;
  const m = /^team\.([a-z_]+)\.v(\d+)$/.exec(sv);
  return m ? { object: m[1]!, major: Number(m[2]) } : null;
}

/**
 * Bring a parsed doc up to the current major for its object, applying the registered chain in memory.
 * Returns the (possibly upgraded) doc and the original major if it changed. Throws
 * unsupported_schema_version if the doc is NEWER than this gateway can produce (no down-conversion).
 */
export function migrateDoc(
  doc: Record<string, unknown>,
  file: string,
): { doc: Record<string, unknown>; migratedFrom: number | null } {
  const id = parseSchemaVersion(doc.schema_version);
  if (!id) return { doc, migratedFrom: null }; // derived files / foreign naming: not ours to migrate
  const current = currentSchemaMajor(id.object);
  if (id.major > current) {
    throw new GatewayError(
      'unsupported_schema_version',
      `${file} carries team.${id.object}.v${id.major}, newer than this gateway understands (v${current}). Upgrade sigmarun to a version that understands it.`,
    );
  }
  if (id.major === current) return { doc, migratedFrom: null };
  const chain = migrations.get(id.object)!;
  let out = doc;
  for (let major = id.major; major < current; major++) {
    out = chain.get(major)!(out);
    out.schema_version = `team.${id.object}.v${major + 1}`;
  }
  return { doc: out, migratedFrom: id.major };
}
