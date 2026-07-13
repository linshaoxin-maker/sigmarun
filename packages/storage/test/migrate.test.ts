import { describe, it, expect, afterEach } from 'vitest';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  readJsonState, GatewayError,
  registerMigration, clearMigrations, currentSchemaMajor,
} from '@sigmarun/storage';

afterEach(() => clearMigrations());

function tmpFile(doc: unknown): string {
  const dir = mkdtempSync(join(tmpdir(), 'sr-mig-'));
  const file = join(dir, 'widget.json');
  writeFileSync(file, JSON.stringify(doc));
  return file;
}

describe('schema migrate-on-read (roadmap Phase 2, auto migration)', () => {
  it('with no migration registered, the current major is 1 and v1 reads pass through', () => {
    expect(currentSchemaMajor('widget')).toBe(1);
    const file = tmpFile({ schema_version: 'team.widget.v1', rev: 1, name: 'a' });
    expect((readJsonState(file).doc as { name: string }).name).toBe('a');
  });

  it('a registered chain upgrades an older doc in memory on read', () => {
    // v1 -> v2 renames `name` to `label`; v2 -> v3 adds `active: true`
    registerMigration('widget', 1, (d) => ({ ...d, label: d.name, name: undefined }));
    registerMigration('widget', 2, (d) => ({ ...d, active: true }));
    expect(currentSchemaMajor('widget')).toBe(3);

    const file = tmpFile({ schema_version: 'team.widget.v1', rev: 4, name: 'gadget' });
    const { doc } = readJsonState(file);
    expect(doc.schema_version).toBe('team.widget.v3');
    expect((doc as { label: string }).label).toBe('gadget');
    expect((doc as { active: boolean }).active).toBe(true);
    expect(readJsonState(file).rev).toBe(4); // rev is preserved across in-memory migration
  });

  it('a doc NEWER than this gateway understands is refused (no down-conversion)', () => {
    const file = tmpFile({ schema_version: 'team.widget.v2', rev: 1 }); // current is 1, no migrations
    let caught: unknown;
    try { readJsonState(file); } catch (e) { caught = e; }
    expect(caught).toBeInstanceOf(GatewayError);
    expect((caught as GatewayError).code).toBe('unsupported_schema_version');
  });
});
