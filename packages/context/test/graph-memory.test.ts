import { describe, it, expect, afterEach, beforeEach } from 'vitest';
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { readJsonState, writeJsonStateAtomic } from '@sigmarun/storage';
import { validateGraph, updateRunMemory } from '@sigmarun/context';
import { cleanup } from '../../storage/test/helpers.js';
import { mkClaimRepo } from '../../dispatch/test/fixture.js';

let repo: string;
beforeEach(() => {
  repo = mkClaimRepo([{ key: 'a' }, { key: 'b', deps: ['a'] }]);
});
afterEach(() => cleanup(repo));

const runDir = () => join(repo, '.team', 'runs', 'RUN-0001');
const graphFile = () => join(runDir(), 'task-graph.json');

function editGraph(fn: (g: { nodes: Array<{ task_id: string }>; edges: Array<Record<string, unknown>> }) => void): void {
  const { doc, rev } = readJsonState(graphFile());
  fn(doc as never);
  writeJsonStateAtomic(graphFile(), doc, { expectedRev: rev });
}

describe('graph validate (Slice 4 acceptance; AUD-021/022 recheck on tampered files)', () => {
  it('passes a healthy imported graph', () => {
    const env = validateGraph({ cwd: repo, runId: 'RUN-0001' });
    expect(env.ok).toBe(true);
    expect((env.data as { nodes: number; edges: number }).nodes).toBe(2);
  });

  it('detects a dangling edge added behind the CLI (AUD-022)', () => {
    editGraph((g) => {
      g.edges.push({ edge_id: 'EDGE-9999', from: 'TASK-0002', to: 'TASK-0777', kind: 'blocks' });
    });
    const env = validateGraph({ cwd: repo, runId: 'RUN-0001' });
    expect(env.ok).toBe(false);
    expect(env.code).toBe('schema_invalid');
    const issues = (env.data as { issues: Array<{ rule: string; edge_id?: string }> }).issues;
    expect(issues.some((i) => i.rule === 'AUD-022' && i.edge_id === 'EDGE-9999')).toBe(true);
  });

  it('detects an injected cycle (AUD-021 defense in depth)', () => {
    editGraph((g) => {
      g.edges.push({ edge_id: 'EDGE-9998', from: 'TASK-0002', to: 'TASK-0001', kind: 'blocks' });
    });
    const env = validateGraph({ cwd: repo, runId: 'RUN-0001' });
    expect(env.ok).toBe(false);
    const issues = (env.data as { issues: Array<{ rule: string; cycle?: string[] }> }).issues;
    const cycleIssue = issues.find((i) => i.rule === 'AUD-021');
    expect(cycleIssue?.cycle).toContain('TASK-0001');
  });
});

describe('memory update (docs/12 §7; BR-005 spirit)', () => {
  it('replaces run-memory.md atomically and warns when no Source: lines exist', () => {
    const env = updateRunMemory({ cwd: repo, runId: 'RUN-0001', content: '# RUN-0001 Memory\n\n- expiry is 7d sliding.\n' });
    expect(env.ok).toBe(true);
    expect(readFileSync(join(runDir(), 'context', 'run-memory.md'), 'utf8')).toContain('expiry is 7d');
    expect(env.warnings.some((w) => w.code === 'memory_without_sources')).toBe(true);

    const sourced = updateRunMemory({
      cwd: repo, runId: 'RUN-0001',
      content: '# RUN-0001 Memory\n\n- expiry is 7d sliding. Source: MSG-0002.\n',
    });
    expect(sourced.warnings.length).toBe(0);
  });

  it('rejects content containing secrets (schema_invalid) and keeps the old file', () => {
    writeFileSync(join(runDir(), 'context', 'run-memory.md'), 'original\n');
    const env = updateRunMemory({
      cwd: repo, runId: 'RUN-0001',
      content: 'token ghp_0123456789abcdef0123456789abcdef0123 Source: x.\n',
    });
    expect(env.ok).toBe(false);
    expect(env.code).toBe('schema_invalid');
    expect(readFileSync(join(runDir(), 'context', 'run-memory.md'), 'utf8')).toBe('original\n');
  });
});

describe('smoke-test L3 + security review Finding 4: human authorship is allowed but marked unverified', () => {
  it('--from=user posts, warns it is self-asserted, and stamps author_unverified; agents are not marked', async () => {
    const { postMessage, listMessages, memoryCandidates } = await import('@sigmarun/context');
    const { registerAgent } = await import('@sigmarun/dispatch');
    const { mkClaimRepo } = await import('../../dispatch/test/fixture.js');
    const { cleanup } = await import('../../storage/test/helpers.js');
    const repo = mkClaimRepo([{ key: 'a' }]);
    try {
      const env = postMessage({ cwd: repo, runId: 'RUN-0001', fromAgentId: 'user', type: 'answer', body: 'Blocker resolved by the user.' });
      expect(env.ok).toBe(true);
      expect(env.warnings.map((w) => w.code)).toContain('author_unverified');

      // a forged human "decision" is stored, but flagged unverified on the line AND in candidates
      postMessage({ cwd: repo, runId: 'RUN-0001', fromAgentId: 'user', type: 'decision', body: 'We chose approach X.' });
      const agent = (registerAgent({ cwd: repo, runId: 'RUN-0001', tool: 'codex', role: 'implementer', label: 'w' }).data as { agent_id: string }).agent_id;
      postMessage({ cwd: repo, runId: 'RUN-0001', fromAgentId: agent, type: 'decision', body: 'Agent-authored decision.' });

      const msgs = (listMessages({ cwd: repo, runId: 'RUN-0001' }).data as { messages: Array<{ from_agent_id: string; author_unverified?: boolean }> }).messages;
      expect(msgs.find((m) => m.from_agent_id === 'user' && m.author_unverified === true)).toBeTruthy();
      expect(msgs.find((m) => m.from_agent_id === agent && m.author_unverified)).toBeFalsy();

      const cands = (memoryCandidates({ cwd: repo, runId: 'RUN-0001' }).data as { candidates: Array<{ ref: string; author_unverified?: boolean; body: string }> }).candidates;
      const userDecision = cands.find((c) => c.body.includes('approach X'));
      expect(userDecision?.author_unverified).toBe(true); // human sees it wasn't verified before promoting
      const agentDecision = cands.find((c) => c.body.includes('Agent-authored'));
      expect(agentDecision?.author_unverified).toBeUndefined();
    } finally {
      cleanup(repo);
    }
  });
});
