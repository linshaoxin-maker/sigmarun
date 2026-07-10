import { describe, it, expect, afterEach, beforeEach } from 'vitest';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { importRun, initProject } from '@sigmarun/core';
import { mkTmpGitRepo, cleanup } from '../../storage/test/helpers.js';
import { validPayload } from './payload-fixture.js';

let repo: string;
beforeEach(() => { repo = mkTmpGitRepo(); initProject({ cwd: repo }); });
afterEach(() => cleanup(repo));

describe('D17 payload fingerprint dedup (BDD-001-04)', () => {
  it('re-importing an identical payload is refused and points at the existing run', () => {
    importRun({ cwd: repo, payload: validPayload() });
    const env = importRun({ cwd: repo, payload: validPayload() });
    expect(env.ok).toBe(false);
    expect(env.code).toBe('duplicate_payload');
    expect(env.message).toContain('RUN-0001');
    expect(env.next_actions.some((a) => a.includes('--force'))).toBe(true);
  });

  it('--force overrides dedup and creates a new run', () => {
    importRun({ cwd: repo, payload: validPayload() });
    const env = importRun({ cwd: repo, payload: validPayload(), force: true });
    expect(env.ok).toBe(true);
    expect((env.data as { run_id: string }).run_id).toBe('RUN-0002');
  });
});

describe('AUD-021 dag cycle rejection (P0-inline)', () => {
  it('a blocks cycle is rejected with the cycle path and zero residue', () => {
    const p = validPayload() as Record<string, any>;
    p.tasks[0].depends_on = ['auth-api-tests'];
    const env = importRun({ cwd: repo, payload: p });
    expect(env.ok).toBe(false);
    expect(env.code).toBe('schema_invalid');
    expect(JSON.stringify(env.data)).toContain('cycle');
    expect(existsSync(join(repo, '.team', 'runs', 'RUN-0001'))).toBe(false);
  });
});

describe('import warnings (BDD-001-05; docs/09 §8.2, 24 §4.1 warn-only)', () => {
  it('task without paths.allow yields a warning but import succeeds', () => {
    const p = validPayload() as Record<string, any>;
    delete p.tasks[1].paths;
    const env = importRun({ cwd: repo, payload: p });
    expect(env.ok).toBe(true);
    expect(env.warnings.some((w) => w.code === 'task_without_paths')).toBe(true);
  });

  it('secret-looking text in the prompt yields a warn-only hint (never blocks)', () => {
    const p = validPayload() as Record<string, any>;
    (p.source as Record<string, unknown>).prompt = 'auth phase 1, db password=hunter2 must move to env';
    const env = importRun({ cwd: repo, payload: p });
    expect(env.ok).toBe(true);
    expect(env.warnings.some((w) => w.code === 'secret_in_payload')).toBe(true);
  });

  it('publication.initial_status ready is downgraded to draft with a warning (publish is FEAT-003)', () => {
    const p = validPayload() as Record<string, any>;
    p.publication = { initial_status: 'ready', requires_user_confirm: false };
    const env = importRun({ cwd: repo, payload: p });
    expect(env.ok).toBe(true);
    expect((env.data as { status: string }).status).toBe('draft');
    expect(env.warnings.some((w) => w.code === 'publication_downgraded')).toBe(true);
  });
});
