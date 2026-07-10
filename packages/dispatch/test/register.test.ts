import { describe, it, expect, afterEach } from 'vitest';
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { claimNext, registerAgent } from '@sigmarun/dispatch';
import { cleanup } from '../../storage/test/helpers.js';
import { mkClaimRepo } from './fixture.js';

let repo: string;
afterEach(() => cleanup(repo));

const runDir = () => join(repo, '.team', 'runs', 'RUN-0001');
const events = () => readFileSync(join(runDir(), 'events.jsonl'), 'utf8').trim().split('\n').map((l) => JSON.parse(l));

describe('agent register (D17; BDD-003-05; docs/02 §7)', () => {
  it('registers an agent: file, envelope data, and agent_registered event', () => {
    repo = mkClaimRepo([{ key: 'a' }]);
    const env = registerAgent({ cwd: repo, runId: 'RUN-0001', tool: 'codex', role: 'implementer', label: 'win-1' });
    expect(env.ok).toBe(true);
    const data = env.data as { agent_id: string; reused: boolean };
    expect(data.agent_id).toBe('AGENT-codex-001');
    expect(data.reused).toBe(false);
    const agent = JSON.parse(readFileSync(join(runDir(), 'agents', 'AGENT-codex-001.json'), 'utf8'));
    expect(agent.schema_version).toBe('team.agent.v1');
    expect(agent.label).toBe('win-1');
    expect(agent.status).toBe('active');
    const ev = events().find((e) => e.event === 'agent_registered');
    expect(ev.payload.tool).toBe('codex');
    expect(ev.payload.label).toBe('win-1');
  });

  it('same label is idempotent: same agent_id, reused=true, single file (BDD-003-05)', () => {
    repo = mkClaimRepo([{ key: 'a' }]);
    const first = registerAgent({ cwd: repo, runId: 'RUN-0001', tool: 'codex', role: 'implementer', label: 'win-1' });
    const second = registerAgent({ cwd: repo, runId: 'RUN-0001', tool: 'codex', role: 'implementer', label: 'win-1' });
    expect((second.data as { agent_id: string }).agent_id).toBe((first.data as { agent_id: string }).agent_id);
    expect((second.data as { reused: boolean }).reused).toBe(true);
    expect(readdirSync(join(runDir(), 'agents')).filter((f) => f.endsWith('.json')).length).toBe(1);
    const reuse = events().filter((e) => e.event === 'agent_registered');
    expect(reuse[reuse.length - 1].payload.reused).toBe(true);
  });

  it('claim by an unregistered agent fails with agent_not_registered (BR-001 #2)', () => {
    repo = mkClaimRepo([{ key: 'a' }]);
    const env = claimNext({ cwd: repo, runId: 'RUN-0001', agentId: 'AGENT-ghost-001' });
    expect(env.ok).toBe(false);
    expect(env.code).toBe('agent_not_registered');
  });
});
