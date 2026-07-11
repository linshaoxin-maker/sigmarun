import { describe, it, expect, afterEach } from 'vitest';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { runCli } from '../src/cli.js';
import { mkTmpGitRepo, cleanup } from '../../storage/test/helpers.js';
import { validPayload } from '../../core/test/payload-fixture.js';

const dirs: string[] = [];
afterEach(() => { while (dirs.length) cleanup(dirs.pop()!); });

/** Envelope invariants every command must honor (docs/17 §2; conformance suite M38 / docs/19 §9). */
function expectEnvelope(stdout: string): Record<string, unknown> {
  expect(stdout.trim().split('\n').length).toBe(1); // exactly one machine line in --json mode
  const env = JSON.parse(stdout) as Record<string, unknown>;
  expect(typeof env.ok).toBe('boolean');
  expect(typeof env.code).toBe('string');
  expect(typeof env.message).toBe('string');
  expect(Array.isArray(env.warnings)).toBe(true);
  expect(Array.isArray(env.next_actions)).toBe(true);
  const meta = env.meta as { envelope_version: string; gateway_version: string; elapsed_ms: number };
  expect(meta.envelope_version).toBe('team.envelope.v1');
  expect(typeof meta.gateway_version).toBe('string');
  expect(typeof meta.elapsed_ms).toBe('number');
  // D16: the machine face is English only
  expect(/[一-鿿]/.test(String(env.message))).toBe(false);
  return env;
}

describe('conformance — one envelope per command, uniform failure classes (M38)', () => {
  it('every surveyed command returns a single well-formed envelope', () => {
    const repo = mkTmpGitRepo(); dirs.push(repo);
    const payloadFile = join(repo, 'payload.json');
    writeFileSync(payloadFile, JSON.stringify(validPayload()));

    const surface: Array<{ argv: string[]; exit: number }> = [
      { argv: ['init'], exit: 0 },
      { argv: ['doctor'], exit: 0 },
      { argv: ['run', 'import', payloadFile], exit: 0 },
      { argv: ['task', 'publish', 'RUN-0001'], exit: 0 },
      { argv: ['run', 'show', 'RUN-0001'], exit: 0 },
      { argv: ['run', 'list'], exit: 0 },
      { argv: ['agent', 'register', 'RUN-0001', '--tool=codex', '--label=w1'], exit: 0 },
      { argv: ['claim-next', 'RUN-0001', '--agent=AGENT-codex-001'], exit: 0 },
      { argv: ['status', 'RUN-0001'], exit: 0 },
      { argv: ['task', 'show', 'RUN-0001', 'TASK-0001'], exit: 0 },
      { argv: ['evidence', 'show', 'RUN-0001', 'TASK-0001'], exit: 0 },
      { argv: ['msg', 'post', 'RUN-0001', '--from=AGENT-codex-001', '--type=note', '--body=hi'], exit: 0 },
      { argv: ['msg', 'list', 'RUN-0001'], exit: 0 },
      { argv: ['context', 'hydrate', 'RUN-0001', 'TASK-0001'], exit: 0 },
      { argv: ['graph', 'validate', 'RUN-0001'], exit: 0 },
      { argv: ['audit', 'run', 'RUN-0001'], exit: 0 },
      { argv: ['repair', 'RUN-0001'], exit: 0 },
      { argv: ['watch', 'RUN-0001', '--once', '--force'], exit: 0 },
      { argv: ['memory', 'candidates', 'RUN-0001'], exit: 0 },
      // uniform failure classes (docs/17 §2.2)
      { argv: ['bogus'], exit: 2 },
      { argv: ['run', 'show', 'RUN-9999'], exit: 5 },
      { argv: ['task', 'publish', 'RUN-9999'], exit: 5 },
      { argv: ['claim-next', 'RUN-0001', '--agent=AGENT-ghost-001'], exit: 5 },
      { argv: ['reclaim', 'RUN-0001', 'TASK-0001'], exit: 7 },
      { argv: ['watch', 'RUN-0001', '--interval=nope'], exit: 2 },
    ];

    for (const step of surface) {
      const r = runCli([...step.argv, '--json'], { cwd: repo });
      const env = expectEnvelope(r.stdout);
      expect(r.exitCode, `${step.argv.join(' ')} -> code=${String(env.code)}`).toBe(step.exit);
      expect(env.ok).toBe(step.exit === 0);
      if (!env.ok) expect((env.next_actions as string[]).length).toBeGreaterThan(0); // failures must be actionable
    }
  }, 30_000);
});
