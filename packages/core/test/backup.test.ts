import { describe, it, expect, afterEach } from 'vitest';
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { backupList, restoreBackup, migrateState, initProject } from '@sigmarun/core';
import { registerMigration, clearMigrations, writeBackup } from '@sigmarun/storage';
import { mkTmpGitRepo, cleanup } from '../../storage/test/helpers.js';

const dirs: string[] = [];
afterEach(() => { clearMigrations(); while (dirs.length) cleanup(dirs.pop()!); });

describe('backup list + restore — closed recovery loop (roadmap Phase 2)', () => {
  it('a migrate backup is listed and restoring rolls the file back; restore is itself reversible', () => {
    const repo = mkTmpGitRepo(); dirs.push(repo);
    initProject({ cwd: repo });
    const projectFile = join(repo, '.team', 'project.json');
    const original = readFileSync(projectFile, 'utf8');

    // a migration that changes project.json on disk, leaving a repair/migrate backup behind
    registerMigration('project', 1, (d) => ({ ...d, added_by_migration: true }));
    const mig = migrateState({ cwd: repo });
    const backupId = (mig.data as { backup: string }).backup;
    expect(JSON.parse(readFileSync(projectFile, 'utf8')).added_by_migration).toBe(true);

    // backup list surfaces it, newest first
    const list = backupList({ cwd: repo });
    const backups = (list.data as { backups: Array<{ id: string; kind: string; files: number }> }).backups;
    expect(backups[0]!.id).toBe(backupId);
    expect(backups[0]!.kind).toBe('migrate');
    expect(backups[0]!.files).toBeGreaterThan(0);

    // dry-run restore: reports, no change
    const dry = restoreBackup({ cwd: repo, backupId, dryRun: true });
    expect((dry.data as { dry_run: boolean }).dry_run).toBe(true);
    expect(JSON.parse(readFileSync(projectFile, 'utf8')).added_by_migration).toBe(true); // still migrated

    // apply restore: project.json goes back to the pre-migrate content
    clearMigrations(); // stop auto-migrating on read so we see the raw restored bytes
    const env = restoreBackup({ cwd: repo, backupId });
    expect(env.ok).toBe(true);
    expect(readFileSync(projectFile, 'utf8')).toBe(original);
    const safety = (env.data as { pre_restore_backup: string }).pre_restore_backup;
    expect(safety).toMatch(/^restore-/);

    // restore is reversible: restoring the safety backup re-applies the migrated content
    restoreBackup({ cwd: repo, backupId: safety });
    expect(JSON.parse(readFileSync(projectFile, 'utf8')).added_by_migration).toBe(true);
  });

  it('restoring an unknown backup id is backup_not_found', () => {
    const repo = mkTmpGitRepo(); dirs.push(repo);
    initProject({ cwd: repo });
    const env = restoreBackup({ cwd: repo, backupId: 'migrate-does-not-exist' });
    expect(env.ok).toBe(false);
    expect(env.code).toBe('backup_not_found');
  });

  it('backup list is empty on a fresh project', () => {
    const repo = mkTmpGitRepo(); dirs.push(repo);
    initProject({ cwd: repo });
    expect((backupList({ cwd: repo }).data as { backups: unknown[] }).backups.length).toBe(0);
  });
});
