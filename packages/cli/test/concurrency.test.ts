import { describe, it, expect, afterEach } from 'vitest';
import { execFile } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';
import { runCli } from '../src/cli.js';
import { mkTmpGitRepo, cleanup } from '../../storage/test/helpers.js';

const execFileP = promisify(execFile);
const BIN = fileURLToPath(new URL('../dist/bin.js', import.meta.url));

let repo: string;
afterEach(() => cleanup(repo));

/**
 * NFR-001 (docs/17 §10): concurrent claim-next from real OS processes must
 * never double-assign a task, corrupt a rev, or duplicate a ledger seq.
 * Runs against the built binary; `npm run build` precedes tests in CI.
 */
describe.skipIf(!existsSync(BIN))('NFR-001 — concurrent claim-next over real processes', () => {
  it('8 parallel claimers get 8 distinct tasks; event seq stays gapless and duplicate-free', async () => {
    repo = mkTmpGitRepo();
    runCli(['init', '--json'], { cwd: repo });
    const N = 8;
    const payload = {
      schema_version: 'team.plan_payload.v1',
      source: { tool: 'claude-code', command: '/team-plan', prompt: 'stress', agent_id: 'AGENT-claude-001' },
      run: { title: 'Stress run', mode: 'feature', goal: 'NFR-001.', policy: { max_parallel_tasks: N } },
      plan: { summary: 'stress' },
      tasks: Array.from({ length: N }, (_, i) => ({
        client_task_key: `t${i + 1}`,
        title: `Task ${i + 1}`,
        type: 'implementation',
        objective: `Do t${i + 1}.`,
        acceptance: ['ok'],
        paths: { allow: [`src/t${i + 1}/**`] },
      })),
    };
    const { writeFileSync } = await import('node:fs');
    const payloadFile = join(repo, 'payload.json');
    writeFileSync(payloadFile, JSON.stringify(payload));
    runCli(['run', 'import', payloadFile, '--json'], { cwd: repo });
    runCli(['task', 'publish', 'RUN-0001', '--json'], { cwd: repo });

    const agents: string[] = [];
    for (let i = 0; i < N; i++) {
      const r = runCli(['agent', 'register', 'RUN-0001', '--tool=codex', `--label=w${i}`, '--json'], { cwd: repo });
      agents.push(JSON.parse(r.stdout).data.agent_id);
    }

    const results = await Promise.all(
      agents.map((a) =>
        execFileP(process.execPath, [BIN, 'claim-next', 'RUN-0001', `--agent=${a}`, '--json'], { cwd: repo })
          .then((r) => ({ ok: true as const, out: r.stdout }))
          .catch((e: { stdout?: string }) => ({ ok: false as const, out: e.stdout ?? '' })),
      ),
    );

    const claimed = results
      .map((r) => JSON.parse(r.out.trim()) as { ok: boolean; data?: { task_id?: string } })
      .filter((env) => env.ok)
      .map((env) => env.data!.task_id!);
    expect(claimed.length).toBe(N); // every claimer got work (lock serializes, 5s timeout >> contention)
    expect(new Set(claimed).size).toBe(N); // no double assignment

    const seqs = readFileSync(join(repo, '.team', 'runs', 'RUN-0001', 'events.jsonl'), 'utf8')
      .trim().split('\n').map((l) => (JSON.parse(l) as { seq: number }).seq);
    for (let i = 1; i < seqs.length; i++) expect(seqs[i]).toBe(seqs[i - 1]! + 1); // gapless, no duplicates

    const audit = runCli(['audit', 'run', 'RUN-0001', '--json'], { cwd: repo });
    const findings = (JSON.parse(audit.stdout).data as { findings: Array<{ severity: string }> }).findings;
    expect(findings.filter((f) => f.severity === 'error')).toEqual([]);
  }, 60_000);
});
