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
