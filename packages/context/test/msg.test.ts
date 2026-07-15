import { describe, it, expect, afterEach, beforeEach } from 'vitest';
import { readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { postMessage, listMessages } from '@sigmarun/context';
import { cleanup } from '../../storage/test/helpers.js';
import { mkClaimRepo, registerDefault } from '../../dispatch/test/fixture.js';

let repo: string;
let agent: string;
beforeEach(() => {
  repo = mkClaimRepo([{ key: 'a' }, { key: 'b', deps: ['a'] }]);
  agent = registerDefault(repo);
});
afterEach(() => cleanup(repo));

const runDir = () => join(repo, '.team', 'runs', 'RUN-0001');
const msgLines = () =>
  readFileSync(join(runDir(), 'context', 'messages.jsonl'), 'utf8').trim().split('\n').map((l) => JSON.parse(l));
const eventCount = () => readFileSync(join(runDir(), 'events.jsonl'), 'utf8').trim().split('\n').length;

describe('msg post (docs/12 §6; INV-011 no event mirror)', () => {
  it('appends a full message line with allocated MSG id and bumps the counter', () => {
    const env = postMessage({
      cwd: repo, runId: 'RUN-0001', fromAgentId: agent, type: 'question',
      body: 'What is the session expiry rule?', taskId: 'TASK-0002', to: 'task:TASK-0001', refs: ['tasks/TASK-0002/task.json'],
    });
    expect(env.ok).toBe(true);
    expect((env.data as { message_id: string }).message_id).toBe('MSG-0001');
    const lines = msgLines();
    expect(lines.length).toBe(1);
    expect(lines[0]).toMatchObject({
      message_id: 'MSG-0001', run_id: 'RUN-0001', task_id: 'TASK-0002',
      from_agent_id: agent, to: 'task:TASK-0001', type: 'question',
      visibility: 'run', body: 'What is the session expiry rule?', status: 'open',
    });
    const second = postMessage({ cwd: repo, runId: 'RUN-0001', fromAgentId: agent, type: 'note', body: 'noted' });
    expect((second.data as { message_id: string }).message_id).toBe('MSG-0002');
  });

  it('does NOT write any event (INV-011: messages are context, not audit)', () => {
    const before = eventCount();
    postMessage({ cwd: repo, runId: 'RUN-0001', fromAgentId: agent, type: 'blocker', body: 'blocked on schema' });
    expect(eventCount()).toBe(before);
  });

  it('a claim owner posting piggyback-renews their lease with a heartbeat event (RULE 7 / docs/15 §8; S2)', async () => {
    const { claimNext } = await import('@sigmarun/dispatch');
    const { readJsonState, writeJsonStateAtomic } = await import('@sigmarun/storage');
    claimNext({ cwd: repo, runId: 'RUN-0001', agentId: agent });
    // age the lease down to one minute — the sweep horizon is approaching
    const f = join(runDir(), 'claims', 'task-claims.json');
    const { doc, rev } = readJsonState(f);
    (doc as { claims: Array<{ lease_until: string }> }).claims[0]!.lease_until = new Date(Date.now() + 60_000).toISOString();
    writeJsonStateAtomic(f, doc as Record<string, unknown>, { expectedRev: rev });

    const env = postMessage({
      cwd: repo, runId: 'RUN-0001', fromAgentId: agent, type: 'blocker', taskId: 'TASK-0001',
      body: 'Waiting on a human decision about the schema.',
    });
    expect(env.ok).toBe(true);
    const claim = JSON.parse(readFileSync(f, 'utf8')).claims[0];
    expect(Date.parse(claim.lease_until)).toBeGreaterThan(Date.now() + 20 * 60_000); // fresh TTL, not 1 min
    const pathClaim = JSON.parse(readFileSync(join(runDir(), 'claims', 'path-claims.json'), 'utf8')).claims[0];
    expect(pathClaim.lease_until).toBe(claim.lease_until);
    expect((env.data as { lease_extended: unknown[] }).lease_extended.length).toBe(1);
    // the lease change is real state, so it IS evented (message stays unmirrored per INV-011)
    const events = readFileSync(join(runDir(), 'events.jsonl'), 'utf8').trim().split('\n').map((l) => JSON.parse(l));
    const hb = events[events.length - 1];
    expect(hb.event).toBe('heartbeat');
    expect(hb.payload.piggyback).toBe('msg_post');

    // posting as user never touches leases — no false liveness on someone else's claim
    const before = events.length;
    postMessage({ cwd: repo, runId: 'RUN-0001', fromAgentId: 'user', type: 'answer', body: 'Decision: keep v1.' });
    const after = readFileSync(join(runDir(), 'events.jsonl'), 'utf8').trim().split('\n').length;
    expect(after).toBe(before);
  });

  it('rejects unknown type and empty body as schema_invalid', () => {
    const bad = postMessage({ cwd: repo, runId: 'RUN-0001', fromAgentId: agent, type: 'gossip', body: 'hi' });
    expect(bad.ok).toBe(false);
    expect(bad.code).toBe('schema_invalid');
    const empty = postMessage({ cwd: repo, runId: 'RUN-0001', fromAgentId: agent, type: 'note', body: '  ' });
    expect(empty.code).toBe('schema_invalid');
    expect(existsSync(join(runDir(), 'context', 'messages.jsonl'))).toBe(false);
  });

  it('rejects an unregistered sender with agent_not_registered', () => {
    const env = postMessage({ cwd: repo, runId: 'RUN-0001', fromAgentId: 'AGENT-ghost-009', type: 'note', body: 'x' });
    expect(env.code).toBe('agent_not_registered');
  });

  it('warns (but posts) when the body smells like a secret (full redaction lands FEAT-007)', () => {
    const env = postMessage({
      cwd: repo, runId: 'RUN-0001', fromAgentId: agent, type: 'note',
      body: 'temp creds AKIAIOSFODNN7EXAMPLE do not keep',
    });
    expect(env.ok).toBe(true);
    expect(env.warnings.some((w) => w.code === 'secret_in_message')).toBe(true);
  });
});

describe('msg list (M23 derived open questions)', () => {
  it('filters by task and type; --open hides answered questions', () => {
    postMessage({ cwd: repo, runId: 'RUN-0001', fromAgentId: agent, type: 'question', body: 'q1?', taskId: 'TASK-0001' });
    postMessage({ cwd: repo, runId: 'RUN-0001', fromAgentId: agent, type: 'question', body: 'q2?', taskId: 'TASK-0002' });
    postMessage({ cwd: repo, runId: 'RUN-0001', fromAgentId: agent, type: 'answer', body: 'a1.', inReplyTo: 'MSG-0001' });

    const byTask = listMessages({ cwd: repo, runId: 'RUN-0001', taskId: 'TASK-0001' });
    expect((byTask.data as { messages: unknown[] }).messages.length).toBe(1);

    const byType = listMessages({ cwd: repo, runId: 'RUN-0001', type: 'answer' });
    expect((byType.data as { messages: Array<{ message_id: string }> }).messages[0].message_id).toBe('MSG-0003');

    const open = listMessages({ cwd: repo, runId: 'RUN-0001', open: true });
    const ids = (open.data as { messages: Array<{ message_id: string }> }).messages.map((m) => m.message_id);
    expect(ids).toEqual(['MSG-0002']);
  });
});
