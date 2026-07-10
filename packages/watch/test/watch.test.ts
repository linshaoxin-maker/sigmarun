import { describe, it, expect, afterEach, beforeEach } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { readJsonState, writeJsonStateAtomic } from '@sigmarun/storage';
import { claimNext } from '@sigmarun/dispatch';
import { watchOnce } from '@sigmarun/watch';
import { cleanup } from '../../storage/test/helpers.js';
import { mkClaimRepo, registerDefault } from '../../dispatch/test/fixture.js';

let repo: string;
let agent: string;
beforeEach(() => {
  repo = mkClaimRepo([{ key: 'a' }]);
  agent = registerDefault(repo);
});
afterEach(() => cleanup(repo));

const runDir = () => join(repo, '.team', 'runs', 'RUN-0001');
const readJson = (rel: string) => JSON.parse(readFileSync(join(runDir(), rel), 'utf8'));

describe('watch --once (docs/17 §7; BDD-007-07; D14 passive CLI)', () => {
  it('a tick runs the sweep (3xTTL reclaim) and returns a snapshot', () => {
    claimNext({ cwd: repo, runId: 'RUN-0001', agentId: agent });
    const file = join(runDir(), 'claims', 'task-claims.json');
    const { doc, rev } = readJsonState(file);
    (doc as { claims: Array<{ lease_until: string }> }).claims[0].lease_until = new Date(Date.now() - 61 * 60_000).toISOString();
    writeJsonStateAtomic(file, doc, { expectedRev: rev });

    const env = watchOnce({ cwd: repo, runId: 'RUN-0001' });
    expect(env.ok).toBe(true);
    const data = env.data as { swept: Array<{ task_id: string }>; progress: { counts: Record<string, number> } };
    expect(data.swept.some((s) => s.task_id === 'TASK-0001')).toBe(true);
    expect(readJson('claims/task-claims.json').claims[0].status).toBe('reclaimed');
    expect(readJson('tasks/TASK-0001/task.json').status).toBe('ready');
    expect(data.progress.counts.ready).toBe(1);
  });

  it('second instance is rejected by the advisory lock; --force overrides (BDD-007-07)', () => {
    const holder = watchOnce({ cwd: repo, runId: 'RUN-0001', holdLock: true });
    expect(holder.ok).toBe(true);
    const second = watchOnce({ cwd: repo, runId: 'RUN-0001' });
    expect(second.ok).toBe(false);
    expect(second.code).toBe('lock_timeout');
    const forced = watchOnce({ cwd: repo, runId: 'RUN-0001', force: true });
    expect(forced.ok).toBe(true);
  });

  it('exits on a terminal run state', () => {
    const runFile = join(runDir(), 'run.json');
    const { doc, rev } = readJsonState(runFile);
    (doc as { status: string }).status = 'cancelled';
    writeJsonStateAtomic(runFile, doc, { expectedRev: rev });
    const env = watchOnce({ cwd: repo, runId: 'RUN-0001' });
    expect(env.ok).toBe(true);
    expect((env.data as { terminal: boolean }).terminal).toBe(true);
  });
});
