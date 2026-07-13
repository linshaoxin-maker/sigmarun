import { describe, it, expect, afterEach } from 'vitest';
import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { migrateState, initProject } from '@sigmarun/core';
import { registerMigration, clearMigrations, readJsonState } from '@sigmarun/storage';
import { mkTmpGitRepo, cleanup } from '../../storage/test/helpers.js';

const dirs: string[] = [];
afterEach(() => { clearMigrations(); while (dirs.length) cleanup(dirs.pop()!); });

describe('sigmarun migrate — eager on-disk schema upgrade (roadmap Phase 2)', () => {
  it('reports nothing to migrate when all state is at the current major', () => {
    const repo = mkTmpGitRepo(); dirs.push(repo);
    initProject({ cwd: repo });
    const env = migrateState({ cwd: repo });
    expect(env.ok).toBe(true);
    expect((env.data as { migrated: unknown[] }).migrated.length).toBe(0);
    expect(env.message).toMatch(/[Nn]othing to migrate/);
  });

  it('rewrites below-current files, preserves rev, and backs up the originals', () => {
    const repo = mkTmpGitRepo(); dirs.push(repo);
    initProject({ cwd: repo });
    // ship a project migration v1 -> v2 that adds a field
    registerMigration('project', 1, (d) => ({ ...d, migrated_marker: true }));

    // dry-run first: reports, no write
    const projectFile = join(repo, '.team', 'project.json');
    const before = readFileSync(projectFile, 'utf8');
    const dry = migrateState({ cwd: repo, dryRun: true });
    expect((dry.data as { dry_run: boolean }).dry_run).toBe(true);
    expect((dry.data as { migrated: Array<{ file: string }> }).migrated.some((m) => m.file.endsWith('project.json'))).toBe(true);
    expect(readFileSync(projectFile, 'utf8')).toBe(before); // untouched

    const revBefore = readJsonState(projectFile).rev;
    const env = migrateState({ cwd: repo });
    expect(env.ok).toBe(true);
    const onDisk = JSON.parse(readFileSync(projectFile, 'utf8'));
    expect(onDisk.schema_version).toBe('team.project.v2');
    expect(onDisk.migrated_marker).toBe(true);
    expect(onDisk.rev).toBe(revBefore); // rev preserved
    const backup = (env.data as { backup: string }).backup;
    expect(existsSync(join(repo, '.team', backup, 'project.json'))).toBe(true);
    // second run is now a no-op
    expect((migrateState({ cwd: repo }).data as { migrated: unknown[] }).migrated.length).toBe(0);
  });
});
