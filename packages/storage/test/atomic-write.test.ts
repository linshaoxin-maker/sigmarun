import { describe, it, expect, afterEach } from 'vitest';
import { readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { readJsonState, writeJsonStateAtomic, GatewayError } from '@sigmarun/storage';
import { mkTmpDir, cleanup } from './helpers.js';

const dirs: string[] = [];
afterEach(() => { while (dirs.length) cleanup(dirs.pop()!); });

function seed(dir: string): string {
  const file = join(dir, 'state.json');
  writeFileSync(file, JSON.stringify({
    schema_version: 'team.project.v1',
    rev: 1,
    known: 1,
    x_custom: { deep: true, list: [1, 2] },
  }, null, 2));
  return file;
}

describe('atomic write with rev optimistic lock (contract: docs/17 §5, docs/21 §4.2)', () => {
  it('increments rev by exactly 1 and persists mutation', () => {
    const dir = mkTmpDir(); dirs.push(dir);
    const file = seed(dir);
    const cur = readJsonState(file);
    writeJsonStateAtomic(file, { ...cur.doc, known: 2 }, { expectedRev: 1 });
    const after = readJsonState(file);
    expect(after.doc.rev).toBe(2);
    expect(after.doc.known).toBe(2);
  });

  it('NFR-006: unknown fields survive a full read-modify-write round trip', () => {
    const dir = mkTmpDir(); dirs.push(dir);
    const file = seed(dir);
    const cur = readJsonState(file);
    writeJsonStateAtomic(file, { ...cur.doc, known: 3 }, { expectedRev: 1 });
    const raw = JSON.parse(readFileSync(file, 'utf8'));
    expect(raw.x_custom).toEqual({ deep: true, list: [1, 2] });
  });

  it('throws rev_conflict when expectedRev does not match the file', () => {
    const dir = mkTmpDir(); dirs.push(dir);
    const file = seed(dir);
    const cur = readJsonState(file);
    try {
      writeJsonStateAtomic(file, { ...cur.doc }, { expectedRev: 7 });
      expect.unreachable('should throw');
    } catch (e) {
      expect((e as GatewayError).code).toBe('rev_conflict');
    }
    expect(readJsonState(file).doc.rev).toBe(1);
  });

  it('leaves no temp-file residue after a successful write', () => {
    const dir = mkTmpDir(); dirs.push(dir);
    const file = seed(dir);
    writeJsonStateAtomic(file, { ...readJsonState(file).doc }, { expectedRev: 1 });
    const leftovers = readdirSync(dir).filter((f) => f.includes('.tmp'));
    expect(leftovers).toEqual([]);
  });
});

describe('schema version handshake (17 S11 / 21 S7 pre-flight defence)', () => {
  it('refuses a state file whose schema major is newer than this gateway', async () => {
    const { mkdtempSync, writeFileSync } = await import('node:fs');
    const { tmpdir } = await import('node:os');
    const { join } = await import('node:path');
    const dir = mkdtempSync(join(tmpdir(), 'sr-hs-'));
    const file = join(dir, 'run.json');
    writeFileSync(file, JSON.stringify({ schema_version: 'team.run.v2', rev: 1 }));
    expect(() => readJsonState(file)).toThrowError(/unsupported_schema_version|newer than this gateway/);
    try { readJsonState(file); } catch (e) { expect((e as { code: string }).code).toBe('unsupported_schema_version'); }

    writeFileSync(file, JSON.stringify({ schema_version: 'team.run.v1', rev: 1 }));
    expect(readJsonState(file).rev).toBe(1);
    writeFileSync(file, JSON.stringify({ rev: 2 }));
    expect(readJsonState(file).rev).toBe(2); // field-less derived files stay readable
    writeFileSync(file, JSON.stringify({ schema_version: 'someone.elses.v9', rev: 3 }));
    expect(readJsonState(file).rev).toBe(3); // foreign naming is not ours to police
  });
});
