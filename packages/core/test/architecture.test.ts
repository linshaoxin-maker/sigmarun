import { describe, it, expect } from 'vitest';
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';

/**
 * Architecture reconciliation (remediation E1/E2 + D24 machine checks): the dependency matrix
 * and the single-transaction-skeleton rule are asserted here so drift is a red test, not a
 * review finding two months later.
 */

const ROOT = join(__dirname, '..', '..');
const posix = (p: string): string => p.split('\\').join('/'); // Windows CI runs this too
const PKGS = ['storage', 'core', 'dispatch', 'context', 'adapters', 'watch', 'audit', 'cli'];

/** Allowed @sigmarun/* imports per package (docs/20 §5, amended per D23 + R3 reality). */
const ALLOWED: Record<string, string[]> = {
  storage: [],
  core: ['storage'],
  dispatch: ['core', 'storage'],
  context: ['core', 'storage'],
  adapters: ['core', 'storage'],
  audit: ['core', 'storage'],
  watch: ['core', 'storage', 'dispatch'], // audit edge removed in R3 (EVENT_STATUS lives in core)
  cli: ['core', 'storage', 'dispatch', 'context', 'adapters', 'watch', 'audit'],
};

function srcFiles(pkg: string): string[] {
  const dir = join(ROOT, pkg, 'src');
  const out: string[] = [];
  const walk = (d: string) => {
    for (const e of readdirSync(d, { withFileTypes: true })) {
      const p = join(d, e.name);
      if (e.isDirectory()) walk(p);
      else if (e.name.endsWith('.ts')) out.push(p);
    }
  };
  walk(dir);
  return out;
}

describe('architecture reconciliation (docs/20 §5 dependency matrix; E1 single skeleton)', () => {
  it('every @sigmarun import respects the allowed dependency matrix', () => {
    const offenses: string[] = [];
    for (const pkg of PKGS) {
      for (const file of srcFiles(pkg)) {
        const text = readFileSync(file, 'utf8');
        for (const m of text.matchAll(/from '@sigmarun\/([a-z-]+)'/g)) {
          const dep = m[1]!;
          if (!ALLOWED[pkg]!.includes(dep)) offenses.push(`${pkg} -> ${dep} (${posix(file.slice(ROOT.length + 1))})`);
        }
      }
    }
    expect(offenses).toEqual([]);
  });

  it('package.json dependencies match the matrix (no undeclared or excess internal deps)', () => {
    for (const pkg of PKGS) {
      const deps = Object.keys(
        (JSON.parse(readFileSync(join(ROOT, pkg, 'package.json'), 'utf8')) as { dependencies?: Record<string, string> })
          .dependencies ?? {},
      )
        .filter((d) => d.startsWith('@sigmarun/'))
        .map((d) => d.slice('@sigmarun/'.length))
        .sort();
      expect({ pkg, deps }).toEqual({ pkg, deps: [...ALLOWED[pkg]!].sort() });
    }
  });

  it('exactly ONE run-lock acquisition site exists (core/tx.ts) — no skeleton copies grow back', () => {
    const holders: string[] = [];
    for (const pkg of PKGS) {
      for (const file of srcFiles(pkg)) {
        const text = readFileSync(file, 'utf8');
        if (/tryAcquireLock\(runLockPath\(/.test(text)) holders.push(posix(file.slice(ROOT.length + 1)));
      }
    }
    expect(holders).toEqual(['core/src/tx.ts']);
  });

  it('the storage write primitives are entered only below the tx layer (no raw project-lock writes beyond the two sanctioned ones)', () => {
    // project.lock is legitimately taken by run import and memory promote (project-scope writes);
    // anything else must go through acquireRunWriteLock/withRunTx.
    const holders: string[] = [];
    for (const pkg of PKGS) {
      for (const file of srcFiles(pkg)) {
        const text = readFileSync(file, 'utf8');
        if (/tryAcquireLock\(join\(/.test(text)) holders.push(posix(file.slice(ROOT.length + 1)));
      }
    }
    expect(holders.sort()).toEqual(['context/src/memory-promote.ts', 'core/src/run-import.ts']);
  });

  it('EVENT_STATUS has a single definition (core/state-machine) — consumers import, not copy', () => {
    const definers: string[] = [];
    for (const pkg of PKGS) {
      for (const file of srcFiles(pkg)) {
        const text = readFileSync(file, 'utf8');
        if (/export const EVENT_STATUS\s*[:=]/.test(text) || /const EVENT_STATUS\s*:\s*Record/.test(text)) {
          definers.push(posix(file.slice(ROOT.length + 1)));
        }
      }
    }
    expect(definers).toEqual(['core/src/state-machine.ts']);
  });
});
