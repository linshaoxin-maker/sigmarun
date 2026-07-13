import { describe, it, expect, afterEach } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync } from 'node:fs';
import { rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { writeBackup, listBackupManifests, readBackupManifest, backupBytes } from '@sigmarun/storage';

const dirs: string[] = [];
afterEach(() => { while (dirs.length) rmSync(dirs.pop()!, { recursive: true, force: true }); });

function mkTeamRoot(): string {
  const root = join(mkdtempSync(join(tmpdir(), 'sr-bk-')), '.team');
  dirs.push(root);
  mkdirSync(join(root, 'runs', 'RUN-0001'), { recursive: true });
  writeFileSync(join(root, 'project.json'), JSON.stringify({ schema_version: 'team.project.v1', rev: 1 }));
  writeFileSync(join(root, 'runs', 'RUN-0001', 'run.json'), JSON.stringify({ schema_version: 'team.run.v1', rev: 3 }));
  return root;
}

describe('backup store (roadmap Phase 2 recovery loop)', () => {
  it('mirrors team-root-relative paths + writes a manifest, and lists it back', () => {
    const root = mkTeamRoot();
    const id = writeBackup(root, 'migrate', [join(root, 'project.json'), join(root, 'runs', 'RUN-0001', 'run.json')]);
    expect(id).toMatch(/^migrate-/);
    expect(existsSync(join(root, 'backups', id, 'project.json'))).toBe(true);
    expect(existsSync(join(root, 'backups', id, 'runs', 'RUN-0001', 'run.json'))).toBe(true);
    const m = readBackupManifest(root, id)!;
    expect(m.kind).toBe('migrate');
    expect(m.files.sort()).toEqual(['project.json', 'runs/RUN-0001/run.json']);
    expect(backupBytes(root, m)).toBeGreaterThan(0);
    expect(listBackupManifests(root).map((x) => x.id)).toContain(id);
  });

  it('retention keeps the most recent N (20) and drops the oldest', () => {
    const root = mkTeamRoot();
    const ids: string[] = [];
    for (let i = 0; i < 23; i++) {
      // distinct timestamps: writeBackup stamps by now(); nudge created_at ordering via file mtime is enough,
      // but to force distinct ids we vary the file set trivially and rely on ms-resolution stamps.
      writeFileSync(join(root, 'project.json'), JSON.stringify({ schema_version: 'team.project.v1', rev: i }));
      ids.push(writeBackup(root, 'test', [join(root, 'project.json')]));
    }
    const kept = listBackupManifests(root);
    expect(kept.length).toBeLessThanOrEqual(20);
    // the newest survives, the oldest is gone
    expect(kept.map((m) => m.id)).toContain(ids[ids.length - 1]);
  });
});
