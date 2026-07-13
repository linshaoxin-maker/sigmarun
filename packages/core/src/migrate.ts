import { existsSync, readFileSync, readdirSync, renameSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  GatewayError, resolveTeamRoot, readJsonState, parseSchemaVersion, currentSchemaMajor, writeBackup,
  type ResolveOptions,
} from '@sigmarun/storage';
import { failEnvelope, okEnvelope, type Envelope } from './envelope.js';

export interface MigrateOptions extends ResolveOptions {
  /** limit to one run; omit to migrate project files + every run */
  runId?: string;
  /** report what would migrate without touching anything */
  dryRun?: boolean;
}

function walkJson(dir: string, out: string[]): void {
  if (!existsSync(dir)) return;
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (entry.name === 'locks' || entry.name === 'backups') continue;
    const abs = join(dir, entry.name);
    if (entry.isDirectory()) walkJson(abs, out);
    else if (entry.isFile() && entry.name.endsWith('.json')) out.push(abs);
  }
}

/**
 * Eagerly bring on-disk state up to the current schema major (roadmap Phase 2). Reads auto-migrate
 * in memory already; this rewrites the files so nothing keeps relying on read-time upgrade — backing
 * up the originals first. rev is preserved (a migration is a shape change, not a logical transition).
 * A no-op today (all state is v1) but the mechanism is live the moment a v2 schema + its migration ship.
 */
export function migrateState(opts: MigrateOptions): Envelope {
  const startedAt = Date.now();
  try {
    const { teamRoot } = resolveTeamRoot(opts);
    const files: string[] = [];
    if (opts.runId) {
      const runDir = join(teamRoot, 'runs', opts.runId);
      if (!existsSync(join(runDir, 'run.json'))) {
        return failEnvelope('run_not_found', `Run ${opts.runId} does not exist under .team/runs/.`, { startedAt });
      }
      walkJson(runDir, files);
    } else {
      for (const f of ['project.json', 'counters.json']) {
        const p = join(teamRoot, f);
        if (existsSync(p)) files.push(p);
      }
      const runsDir = join(teamRoot, 'runs');
      if (existsSync(runsDir)) for (const r of readdirSync(runsDir)) walkJson(join(runsDir, r), files);
    }

    const rel = (f: string) => f.slice(teamRoot.length + 1);
    const pending: Array<{ file: string; from: number; to: number; object: string }> = [];
    for (const file of files) {
      let raw: { schema_version?: unknown };
      try {
        raw = JSON.parse(readFileSync(file, 'utf8')) as { schema_version?: unknown };
      } catch {
        continue; // torn/derived file — skip; audit rules cover corruption
      }
      const id = parseSchemaVersion(raw.schema_version);
      if (!id) continue;
      const cur = currentSchemaMajor(id.object);
      if (id.major < cur) pending.push({ file, from: id.major, to: cur, object: id.object });
    }

    const scope = opts.runId ? ` on ${opts.runId}` : '';
    if (pending.length === 0) {
      return okEnvelope({
        message: `Nothing to migrate${scope}; all state is at the current schema major.`,
        data: { migrated: [], dry_run: Boolean(opts.dryRun) },
        startedAt,
      });
    }

    const summary = pending.map((p) => ({ file: rel(p.file), object: p.object, from: `v${p.from}`, to: `v${p.to}` }));
    if (opts.dryRun) {
      return okEnvelope({
        message: `${pending.length} file(s) would migrate${scope} (dry run).`,
        data: { migrated: summary, dry_run: true },
        nextActions: [`Apply: sigmarun migrate${opts.runId ? ` ${opts.runId}` : ''}`],
        startedAt,
      });
    }

    const backupId = writeBackup(teamRoot, 'migrate', pending.map((p) => p.file));
    for (const p of pending) {
      const migrated = readJsonState(p.file).doc; // upgraded in memory (rev preserved)
      const tmp = `${p.file}.tmp-${process.pid}`;
      writeFileSync(tmp, JSON.stringify(migrated, null, 2) + '\n');
      renameSync(tmp, p.file);
    }

    return okEnvelope({
      message: `Migrated ${pending.length} file(s)${scope} to the current schema major; originals backed up as ${backupId}.`,
      data: { migrated: summary, backup: backupId, dry_run: false },
      startedAt,
    });
  } catch (err) {
    if (err instanceof GatewayError) return failEnvelope(err.code, err.message, { startedAt });
    throw err;
  }
}
