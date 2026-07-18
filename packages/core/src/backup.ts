import { copyFileSync, existsSync, mkdirSync, renameSync } from 'node:fs';
import { dirname, join } from 'node:path';
import {
  GatewayError, resolveTeamRoot, writeBackup, listBackupManifests, readBackupManifest, backupBytes,
  type ResolveOptions,
} from '@sigmarun/storage';
import { failEnvelope, okEnvelope, type Envelope } from './envelope.js';
import { acquireRunWriteLock } from './tx.js';

/** `backup list` — inventory of restore points repair/migrate/restore have written. */
export function backupList(opts: ResolveOptions): Envelope {
  const startedAt = Date.now();
  try {
    const { teamRoot } = resolveTeamRoot(opts);
    const manifests = listBackupManifests(teamRoot).reverse(); // newest first
    const backups = manifests.map((m) => ({
      id: m.id,
      kind: m.kind,
      created_at: m.created_at,
      files: m.files.length,
      bytes: backupBytes(teamRoot, m),
    }));
    return okEnvelope({
      message: `${backups.length} backup(s) under .team/backups/ (newest first; retention keeps the last 20).`,
      data: { backups },
      nextActions: backups.length > 0 ? [`Roll back: sigmarun restore ${backups[0]!.id} --dry-run`] : [],
      startedAt,
    });
  } catch (err) {
    if (err instanceof GatewayError) return failEnvelope(err.code, err.message, { startedAt });
    throw err;
  }
}

export interface RestoreOptions extends ResolveOptions {
  backupId: string;
  dryRun?: boolean;
}

/**
 * `restore <backup-id>` — copy a backup's files back over the current state (roll back a repair or
 * migrate). Restore is itself reversible: before overwriting, it snapshots the current version of
 * every file it touches into a fresh `restore-*` backup, so you can always go forward again.
 */
export function restoreBackup(opts: RestoreOptions): Envelope {
  const startedAt = Date.now();
  try {
    const { teamRoot } = resolveTeamRoot(opts);
    const manifest = readBackupManifest(teamRoot, opts.backupId);
    if (!manifest) {
      return failEnvelope('backup_not_found', `No backup "${opts.backupId}" under .team/backups/.`, {
        nextActions: ['List restore points: sigmarun backup list'],
        startedAt,
      });
    }

    const plan = manifest.files.map((rel) => ({
      rel,
      from: join(teamRoot, 'backups', manifest.id, rel),
      to: join(teamRoot, rel),
    }));

    if (opts.dryRun) {
      return okEnvelope({
        message: `Would restore ${plan.length} file(s) from ${manifest.id} (${manifest.kind}, ${manifest.created_at}) — dry run.`,
        data: { backup: manifest.id, files: plan.map((p) => p.rel), dry_run: true },
        nextActions: [`Apply: sigmarun restore ${manifest.id}`],
        startedAt,
      });
    }

    // Serialize behind any in-flight run transaction (P1-8). restore used to write with no lock, so a
    // multi-file copy could tear through a live claim/submit/repair mid-write and leave a half-restored,
    // internally inconsistent run. Take the run write lock (the same door repair/migrate use) for every
    // run whose files this restore overwrites; a restore may span several runs (a migrate backup), so
    // lock each. Files outside any run (a project-scope backup, e.g. project.json) have no run lock to
    // take. Acquire in a stable sorted order so two concurrent restores can't deadlock on lock ordering.
    const runDirs = new Set<string>();
    for (const p of plan) {
      const seg = p.rel.split('/');
      if (seg[0] === 'runs' && seg.length >= 2 && existsSync(join(teamRoot, 'runs', seg[1]!))) {
        runDirs.add(join(teamRoot, 'runs', seg[1]!));
      }
    }
    const releases: Array<() => void> = [];
    for (const runDir of [...runDirs].sort()) {
      const release = acquireRunWriteLock(runDir);
      if (release instanceof GatewayError) {
        for (const r of releases) r(); // roll back the locks we did take
        return failEnvelope(release.code, release.message, { startedAt });
      }
      releases.push(release);
    }

    try {
      // Safety net: snapshot the current version of everything we're about to overwrite so restore is reversible.
      const safety = writeBackup(teamRoot, 'restore', plan.map((p) => p.to));

      for (const p of plan) {
        if (!existsSync(p.from)) continue;
        mkdirSync(dirname(p.to), { recursive: true });
        const tmp = `${p.to}.tmp-${process.pid}`;
        copyFileSync(p.from, tmp);
        renameSync(tmp, p.to); // atomic swap into place
      }

      return okEnvelope({
        message: `Restored ${plan.length} file(s) from ${manifest.id}; the pre-restore state is backed up as ${safety}.`,
        data: { backup: manifest.id, restored: plan.map((p) => p.rel), pre_restore_backup: safety, dry_run: false },
        nextActions: [`Undo this restore: sigmarun restore ${safety}`],
        startedAt,
      });
    } finally {
      for (const r of releases) r();
    }
  } catch (err) {
    if (err instanceof GatewayError) return failEnvelope(err.code, err.message, { startedAt });
    throw err;
  }
}
