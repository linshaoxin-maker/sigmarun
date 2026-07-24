import { describe, it, expect, afterEach, beforeEach } from 'vitest';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { submitEvidence } from '@sigmarun/core';
import { cleanup } from '../../storage/test/helpers.js';
import { mkClaimRepo, registerDefault, setupWorking } from '../../dispatch/test/fixture.js';
import { validDraft } from './submit-fixture.js';

/**
 * Handoff structure guardrail (docs/14 §2.4): the handoff lands as context/tasks/<TASK>.md and
 * becomes the next agent's hydrate must_read, but it used to be free-form markdown — a garbage
 * handoff was only caught downstream. Two shape heuristics (< 200 chars, no `## ` heading) now
 * draw a `handoff_unstructured` WARNING. Warn-only is the contract: the gateway has no LLM (I4)
 * and must never reject on content "quality", so every case here still submits with ok=true.
 */

let repo: string;
let agent: string;
beforeEach(async () => {
  repo = mkClaimRepo([{ key: 'a' }]);
  agent = registerDefault(repo);
  await setupWorking(repo, agent);
});
afterEach(() => cleanup(repo));

const submit = (evidencePath: string) =>
  submitEvidence({ cwd: repo, runId: 'RUN-0001', taskId: 'TASK-0001', agentId: agent, evidencePath });

const STRUCTURED_HANDOFF = [
  '# Handoff summary — TASK-0001 shipped',
  'Module a implemented and green; nothing left half-done.',
  '',
  '## What was done',
  '- Added src/a/index.ts; ran `npm test -- a`, all green (cmd-01).',
  '',
  '## Key decisions (why)',
  '- Kept the module dependency-free so downstream tasks import it without extra setup.',
  '',
  '## Pitfalls & unfinished',
  '- none',
  '',
  '## Notes for the next agent',
  '- Extend src/a/index.ts in place rather than adding a parallel entry point.',
  '',
  '## Related files',
  '- src/a/index.ts — the only deliverable of this task.',
  '',
].join('\n');

describe('submit — handoff structure guardrail (docs/14 §2.4; warn-only, never rejects)', () => {
  it('a one-liner handoff still lands but draws handoff_unstructured naming both heuristics', () => {
    const env = submit(validDraft(repo, { handoff: 'done, see the diff.' }));
    expect(env.ok).toBe(true); // iron rule: shape warns, quality never rejects
    const w = env.warnings.find((x) => x.code === 'handoff_unstructured');
    expect(w).toBeDefined();
    expect(w!.message).toContain('docs/14 §2.4');
    expect(w!.message).toContain('under 200 characters');
    expect(w!.message).toContain('"## " section heading');
  });

  it('a structured handoff (sections + substance) draws no warning and lands verbatim', () => {
    const env = submit(validDraft(repo, { handoff: STRUCTURED_HANDOFF }));
    expect(env.ok).toBe(true);
    expect(env.warnings.some((x) => x.code === 'handoff_unstructured')).toBe(false);
    const landed = readFileSync(join(repo, '.team', 'runs', 'RUN-0001', 'context', 'tasks', 'TASK-0001.md'), 'utf8');
    expect(landed).toContain('## Key decisions (why)');
  });

  it('long heading-free prose warns about sections only, not length', () => {
    const prose = 'This handoff rambles on about the work without any structure whatsoever. '.repeat(5);
    const env = submit(validDraft(repo, { handoff: prose }));
    expect(env.ok).toBe(true);
    const w = env.warnings.find((x) => x.code === 'handoff_unstructured');
    expect(w).toBeDefined();
    expect(w!.message).toContain('"## " section heading');
    expect(w!.message).not.toContain('under 200 characters');
  });

  it('a short but sectioned handoff warns about length only (heuristics are independent)', () => {
    const env = submit(validDraft(repo, { handoff: '# Handoff summary\n## What was done\n- tiny fix.\n' }));
    expect(env.ok).toBe(true);
    const w = env.warnings.find((x) => x.code === 'handoff_unstructured');
    expect(w).toBeDefined();
    expect(w!.message).toContain('under 200 characters');
    expect(w!.message).not.toContain('"## " section heading');
  });

  it('handoff_file goes through the same guardrail (structured file content → no warning)', () => {
    const dir = join(repo, '..', `handoff-file-${Date.now()}`);
    mkdirSync(dir, { recursive: true });
    const handoffPath = join(dir, 'handoff.md');
    writeFileSync(handoffPath, STRUCTURED_HANDOFF);
    const env = submit(validDraft(repo, { handoff: '', handoff_file: handoffPath }));
    expect(env.ok).toBe(true);
    expect(env.warnings.some((x) => x.code === 'handoff_unstructured')).toBe(false);
  });

  it('an empty handoff stays a hard evidence_invalid error, not a warning (missing ≠ unstructured)', () => {
    const env = submit(validDraft(repo, { handoff: '   ' }));
    expect(env.ok).toBe(false);
    expect(env.code).toBe('evidence_invalid');
    expect((env.data as { errors: string[] }).errors.some((e) => e.includes('handoff content is required'))).toBe(true);
  });
});
