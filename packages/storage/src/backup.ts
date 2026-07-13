import { copyFileSync, existsSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';

/**
 * Unified backup store (roadmap Phase 2 — close the recovery loop). repair and migrate both snapshot
 * state before they act; without a shared format and retention those snapshots only accumulate and
 * can't be rolled back. A backup mirrors the team-root-relative path of every file it holds, plus a
 * backup.json manifest, so `restore` is generic across producers. Retention keeps the most recent N.
 */
export interface BackupManifest {
  id: string;
  kind: string;
  created_at: string;
  /** team-root-relative paths of the backed-up files */
  files: string[];
}

const RETENTION = 20;

function stamp(): string {
  return new Date().toISOString().replace(/[:.]/g, '-');
}

/** Snapshot the given absolute files under .team/backups/<kind>-<stamp>/, mirroring their paths. Returns the backup id. */
export function writeBackup(teamRoot: string, kind: string, absFiles: string[]): string {
  const base = `${kind}-${stamp()}`;
  let id = base;
  for (let n = 2; existsSync(join(teamRoot, 'backups', id)); n++) id = `${base}-${n}`; // same-ms uniqueness
  const root = join(teamRoot, 'backups', id);
  const files: string[] = [];
  for (const abs of absFiles) {
    if (!existsSync(abs)) continue;
    const rel = abs.slice(teamRoot.length + 1);
    const dest = join(root, rel);
    mkdirSync(dirname(dest), { recursive: true });
    copyFileSync(abs, dest);
    files.push(rel);
  }
  mkdirSync(root, { recursive: true });
  const manifest: BackupManifest = { id, kind, created_at: new Date().toISOString(), files };
  writeFileSync(join(root, 'backup.json'), JSON.stringify(manifest, null, 2) + '\n');
  rotateBackups(teamRoot);
  return id;
}

/** Keep the most recent RETENTION manifested backups; drop older ones (chronological by created_at). */
export function rotateBackups(teamRoot: string): string[] {
  const all = listBackupManifests(teamRoot);
  const excess = all.length - RETENTION;
  const dropped: string[] = [];
  for (let i = 0; i < excess; i++) {
    rmSync(join(teamRoot, 'backups', all[i]!.id), { recursive: true, force: true });
    dropped.push(all[i]!.id);
  }
  return dropped;
}

/** All manifested backups, oldest first. */
export function listBackupManifests(teamRoot: string): BackupManifest[] {
  const dir = join(teamRoot, 'backups');
  if (!existsSync(dir)) return [];
  const out: BackupManifest[] = [];
  for (const entry of readdirSync(dir)) {
    const mf = join(dir, entry, 'backup.json');
    if (!existsSync(mf)) continue;
    try {
      out.push(JSON.parse(readFileSync(mf, 'utf8')) as BackupManifest);
    } catch {
      // a torn manifest is not a valid backup — skip
    }
  }
  return out.sort((a, b) => a.created_at.localeCompare(b.created_at));
}

export function readBackupManifest(teamRoot: string, id: string): BackupManifest | null {
  const mf = join(teamRoot, 'backups', id, 'backup.json');
  if (!existsSync(mf)) return null;
  try {
    return JSON.parse(readFileSync(mf, 'utf8')) as BackupManifest;
  } catch {
    return null;
  }
}

/** Total bytes held by a backup's files (for `backup list`). */
export function backupBytes(teamRoot: string, m: BackupManifest): number {
  let bytes = 0;
  for (const rel of m.files) {
    const p = join(teamRoot, 'backups', m.id, rel);
    if (existsSync(p)) bytes += statSync(p).size;
  }
  return bytes;
}
