import { describe, it, expect, afterEach, beforeEach } from 'vitest';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { readJsonState, writeJsonStateAtomic } from '@sigmarun/storage';
import { hydrateContext, postMessage } from '@sigmarun/context';
import { cleanup } from '../../storage/test/helpers.js';
import { mkClaimRepo, registerDefault } from '../../dispatch/test/fixture.js';

let repo: string;
let agent: string;
beforeEach(() => {
  repo = mkClaimRepo([
    { key: 'a', paths: { allow: ['src/a/**'], avoid: ['package-lock.json'], requires_approval: ['src/users/**'] } },
    { key: 'b', deps: ['a'] },
  ]);
  agent = registerDefault(repo);
});
afterEach(() => cleanup(repo));

const runDir = () => join(repo, '.team', 'runs', 'RUN-0001');
const events = () => readFileSync(join(runDir(), 'events.jsonl'), 'utf8').trim().split('\n').map((l) => JSON.parse(l));

describe('context hydrate (docs/12 §8; event #39; D19 read path)', () => {
  it('assembles the base pack and writes a context_hydrated event with must_read', () => {
    const env = hydrateContext({ cwd: repo, runId: 'RUN-0001', taskId: 'TASK-0002', agentId: agent });
    expect(env.ok).toBe(true);
    const pack = env.data as { run_id: string; task_id: string; must_read: string[]; messages: unknown[] };
    expect(pack.task_id).toBe('TASK-0002');
    expect(pack.must_read).toContain('tasks/TASK-0002/task.md');
    expect(pack.must_read).toContain('context/run-memory.md');
    const ev = events().find((e) => e.event === 'context_hydrated');
    expect(ev.task_id).toBe('TASK-0002');
    expect(ev.payload.must_read).toEqual(pack.must_read);
    expect(ev.actor).toEqual({ type: 'agent', id: agent });
  });

  it('pulls upstream handoff + evidence files into must_read when they exist (blocks edge)', () => {
    mkdirSync(join(runDir(), 'context', 'tasks'), { recursive: true });
    writeFileSync(join(runDir(), 'context', 'tasks', 'TASK-0001.md'), '# handoff from a\n');
    mkdirSync(join(runDir(), 'evidence', 'TASK-0001'), { recursive: true });
    writeFileSync(join(runDir(), 'evidence', 'TASK-0001', 'evidence.md'), '# evidence a\n');
    const env = hydrateContext({ cwd: repo, runId: 'RUN-0001', taskId: 'TASK-0002', agentId: agent });
    const mustRead = (env.data as { must_read: string[] }).must_read;
    expect(mustRead).toContain('context/tasks/TASK-0001.md');
    expect(mustRead).toContain('evidence/TASK-0001/evidence.md');
  });

  it('includes the L4 project memory when docs/team/MEMORY.md exists (D19 inheritance)', () => {
    mkdirSync(join(repo, 'docs', 'team'), { recursive: true });
    writeFileSync(join(repo, 'docs', 'team', 'MEMORY.md'), '# Project memory\n');
    const env = hydrateContext({ cwd: repo, runId: 'RUN-0001', taskId: 'TASK-0002', agentId: agent });
    expect((env.data as { must_read: string[] }).must_read).toContain('docs/team/MEMORY.md');
  });

  it('surfaces avoid/requires_approval globs as risks and relevant open questions', () => {
    postMessage({ cwd: repo, runId: 'RUN-0001', fromAgentId: agent, type: 'question', body: 'expiry rule?', to: 'task:TASK-0001', taskId: 'TASK-0002' });
    const env = hydrateContext({ cwd: repo, runId: 'RUN-0001', taskId: 'TASK-0001', agentId: agent });
    const pack = env.data as { risks: string[]; open_questions: Array<{ message_id: string }>; messages: Array<{ message_id: string }> };
    expect(pack.risks.some((r) => r.includes('package-lock.json'))).toBe(true);
    expect(pack.risks.some((r) => r.includes('src/users/**'))).toBe(true);
    expect(pack.messages.map((m) => m.message_id)).toContain('MSG-0001');
    expect(pack.open_questions.map((q) => q.message_id)).toContain('MSG-0001');
  });

  it('passes previous_attempts through (docs/15 §5.3)', () => {
    const taskFile = join(runDir(), 'tasks', 'TASK-0001', 'task.json');
    const { doc, rev } = readJsonState(taskFile);
    (doc as Record<string, unknown>).previous_attempts = [{ attempt: 1, agent_id: 'AGENT-codex-009', reclaim_reason: 'stale_lease_auto' }];
    writeJsonStateAtomic(taskFile, doc, { expectedRev: rev });
    const env = hydrateContext({ cwd: repo, runId: 'RUN-0001', taskId: 'TASK-0001', agentId: agent });
    const attempts = (env.data as { previous_attempts: Array<{ agent_id: string }> }).previous_attempts;
    expect(attempts[0].agent_id).toBe('AGENT-codex-009');
  });

  it('unknown task fails with task_not_found', () => {
    const env = hydrateContext({ cwd: repo, runId: 'RUN-0001', taskId: 'TASK-0099', agentId: agent });
    expect(env.ok).toBe(false);
    expect(env.code).toBe('task_not_found');
  });
});
