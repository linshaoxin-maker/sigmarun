import { describe, it, expect } from 'vitest';
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { runCli, COMMAND_SURFACE } from '../src/cli.js';
import { mkTmpGitRepo, cleanup } from '../../storage/test/helpers.js';

/**
 * Corpus <-> code reconciliation (D24): the constitution stays authoritative BECAUSE drift is a
 * red test. Three tables are held to each other mechanically: the command surface (docs/17 §1),
 * the exit-code map (docs/17 §2.2), and the event catalog (docs/18 §2).
 */

const ROOT = join(__dirname, '..', '..', '..');
const doc17 = readFileSync(join(ROOT, 'docs', '17-cli-mcp-contract-and-error-model.md'), 'utf8');
const doc18 = readFileSync(join(ROOT, 'docs', '18-audit-rule-catalog-and-trust-model.md'), 'utf8');

/** Parse docs/17 §1: `team <words...>` cells with ` / ` alternates replacing the LAST word. */
function docCommands(): { mvp: Set<string>; all: Set<string> } {
  const sec = doc17.slice(doc17.indexOf('## 1. 命令总表'), doc17.indexOf('## 2. 全局返回'));
  const mvp = new Set<string>();
  const all = new Set<string>();
  for (const line of sec.split('\n')) {
    const m = /^\|\s*`team ([^`]+)`/.exec(line);
    if (!m) continue;
    const isMvp = /\|\s*✓[^|]*\|/.test(line);
    const spec = m[1]!;
    // words before the first argument token; alternates share the leading words
    const parts = spec.split(' / ');
    const lead = parts[0]!.split(' ').filter((w) => !/^[<\[($-]/.test(w) && !w.includes('<'));
    const expand = (words: string[]) => {
      const key = words.join(' ');
      all.add(key);
      if (isMvp) mvp.add(key);
    };
    expand(lead);
    for (const alt of parts.slice(1)) {
      const w = alt.split(' ').filter((x) => !/^[<\[($-]/.test(x) && !x.includes('<'))[0];
      if (w) expand([...lead.slice(0, -1), w]);
    }
  }
  return { mvp, all };
}

describe('docs reconciliation — command surface (docs/17 §1)', () => {
  it('every MVP row in docs/17 §1 is a real CLI command, and every CLI command has an MVP row', () => {
    const { mvp } = docCommands();
    const surface = new Set(COMMAND_SURFACE);
    const promisedNotBuilt = [...mvp].filter((c) => !surface.has(c)).sort();
    const builtNotPromised = [...surface].filter((c) => !mvp.has(c)).sort();
    expect({ promisedNotBuilt, builtNotPromised }).toEqual({ promisedNotBuilt: [], builtNotPromised: [] });
  });

  it('every COMMAND_SURFACE entry actually dispatches (no phantom manifest rows)', () => {
    const repo = mkTmpGitRepo();
    try {
      for (const cmd of COMMAND_SURFACE) {
        const r = runCli([...cmd.split(' '), '--json'], { cwd: repo });
        const env = JSON.parse(r.stdout) as { message: string };
        expect(`${cmd}: ${env.message}`).not.toMatch(/Unknown (sub)?command/);
      }
    } finally {
      cleanup(repo);
    }
  });
});

describe('docs reconciliation — exit-code map (docs/17 §2.2)', () => {
  it('every code in EXIT_BY_CODE sits on its documented exit row', () => {
    // EXIT_BY_CODE is module-private; re-derive from source to avoid exporting internals.
    const src = readFileSync(join(ROOT, 'packages', 'cli', 'src', 'cli.ts'), 'utf8');
    const block = /const EXIT_BY_CODE[^;]+;/s.exec(src)![0];
    const pairs = [...block.matchAll(/([a-z_A-Z]+):\s*(\d+),/g)].map((m) => [m[1]!, Number(m[2])] as const);
    expect(pairs.length).toBeGreaterThan(30);
    const sec = doc17.slice(doc17.indexOf('### 2.2 Exit code'), doc17.indexOf('## 3.'));
    const rowOf = new Map<string, number>();
    for (const line of sec.split('\n')) {
      const m = /^\|\s*(\d+)\s*\|/.exec(line);
      if (!m) continue;
      for (const code of line.matchAll(/`([A-Za-z_]+)`/g)) rowOf.set(code[1]!, Number(m[1]));
    }
    const misplaced = pairs.filter(([code, exit]) => rowOf.get(code) !== exit).map(([c, e]) => `${c} (code ${e}, docs ${rowOf.get(c) ?? 'absent'})`);
    expect(misplaced).toEqual([]);
  });
});

describe('docs reconciliation — event catalog (docs/18 §2)', () => {
  function emittedEvents(): Set<string> {
    const out = new Set<string>();
    for (const pkg of ['storage', 'core', 'dispatch', 'context', 'adapters', 'watch', 'audit', 'cli']) {
      const walk = (d: string): void => {
        for (const e of readdirSync(d, { withFileTypes: true })) {
          const p = join(d, e.name);
          if (e.isDirectory()) walk(p);
          else if (e.name.endsWith('.ts')) {
            const t = readFileSync(p, 'utf8');
            for (const m of t.matchAll(/event:\s*'([a-z_]+)'/g)) out.add(m[1]!);
            for (const m of t.matchAll(/event:\s*[^,\n]*\?\s*'([a-z_]+)'\s*:\s*'([a-z_]+)'/g)) {
              out.add(m[1]!);
              out.add(m[2]!);
            }
            for (const m of t.matchAll(/eventName\s*=\s*[^;]*'([a-z_]+)'[^;]*'([a-z_]+)'/g)) {
              out.add(m[1]!);
              out.add(m[2]!);
            }
            for (const m of t.matchAll(/EVENT_BY_DECISION[^=]*=\s*\{([^}]+)\}/g)) {
              for (const v of m[1]!.matchAll(/:\s*'([a-z_]+)'/g)) out.add(v[1]!);
            }
          }
        }
      };
      walk(join(ROOT, 'packages', pkg, 'src'));
    }
    return out;
  }

  it('emitted events and the active docs/18 §2 catalog are the SAME set', () => {
    const sec = doc18.slice(doc18.indexOf('## 2. 事件目录总表'), doc18.indexOf('## 3.'));
    const active = new Set<string>();
    for (const line of sec.split('\n')) {
      const m = /^\|\s*\d+\s*\|\s*`([a-z_]+)`/.exec(line);
      if (!m) continue;
      if (/废弃|取代|未实装/.test(line)) continue; // formally retired or not-yet-built rows
      active.add(m[1]!);
    }
    const emitted = emittedEvents();
    const emittedNotCataloged = [...emitted].filter((e) => !active.has(e)).sort();
    const catalogedNotEmitted = [...active].filter((e) => !emitted.has(e)).sort();
    expect({ emittedNotCataloged, catalogedNotEmitted }).toEqual({ emittedNotCataloged: [], catalogedNotEmitted: [] });
  });
});
