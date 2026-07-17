import { describe, it, expect, afterEach } from 'vitest';
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { runCli } from '../src/cli.js';
import { TEMPLATE_VERSION } from '@sigmarun/adapters';
import { mkTmpGitRepo, cleanup } from '../../storage/test/helpers.js';

const dirs: string[] = [];
afterEach(() => { while (dirs.length) cleanup(dirs.pop()!); });

describe('cli front-end (contract: docs/17 §1/§2.2 — parse, delegate, map exit code)', () => {
  it('init --json prints one parseable envelope and exits 0', () => {
    const repo = mkTmpGitRepo(); dirs.push(repo);
    const r = runCli(['init', '--json'], { cwd: repo });
    expect(r.exitCode).toBe(0);
    const env = JSON.parse(r.stdout);
    expect(env.ok).toBe(true);
    expect(env.meta.envelope_version).toBe('team.envelope.v1');
  });

  it('doctor --json parses and exits 0 on an initialized repo', () => {
    const repo = mkTmpGitRepo(); dirs.push(repo);
    runCli(['init', '--json'], { cwd: repo });
    const r = runCli(['doctor', '--json'], { cwd: repo });
    expect(r.exitCode).toBe(0);
    expect(JSON.parse(r.stdout).ok).toBe(true);
  });

  it('unknown command maps to usage_error with exit 2', () => {
    const repo = mkTmpGitRepo(); dirs.push(repo);
    const r = runCli(['bogus', '--json'], { cwd: repo });
    expect(r.exitCode).toBe(2);
    expect(JSON.parse(r.stdout).code).toBe('usage_error');
  });

  it('environment failure maps to exit 8 (17 §2.2)', () => {
    const r = runCli(['doctor', '--json'], { cwd: '/tmp' });
    expect(r.exitCode).toBe(8);
    expect(JSON.parse(r.stdout).code).toBe('not_a_git_repo');
  });

  it('run import <file> --json imports and exits 0 (FEAT-002)', async () => {
    const repo = mkTmpGitRepo(); dirs.push(repo);
    runCli(['init', '--json'], { cwd: repo });
    const { writeFileSync } = await import('node:fs');
    const { join } = await import('node:path');
    const { validPayload } = await import('../../core/test/payload-fixture.js');
    const f = join(repo, 'payload.json');
    writeFileSync(f, JSON.stringify(validPayload()));
    const r = runCli(['run', 'import', f, '--json'], { cwd: repo });
    expect(r.exitCode).toBe(0);
    expect(JSON.parse(r.stdout).data.run_id).toBe('RUN-0001');
  });

  it('run import without a file argument is a usage error', () => {
    const repo = mkTmpGitRepo(); dirs.push(repo);
    const r = runCli(['run', 'import', '--json'], { cwd: repo });
    expect(r.exitCode).toBe(2);
    expect(JSON.parse(r.stdout).code).toBe('usage_error');
  });

  it('register -> claim-next -> release roundtrip via argv (FEAT-004)', async () => {
    const repo = mkTmpGitRepo(); dirs.push(repo);
    runCli(['init', '--json'], { cwd: repo });
    const { writeFileSync } = await import('node:fs');
    const { join } = await import('node:path');
    const { validPayload } = await import('../../core/test/payload-fixture.js');
    const f = join(repo, 'payload.json');
    writeFileSync(f, JSON.stringify(validPayload()));
    runCli(['run', 'import', f, '--json'], { cwd: repo });
    runCli(['task', 'publish', 'RUN-0001', '--json'], { cwd: repo });

    const reg = runCli(['agent', 'register', 'RUN-0001', '--tool=codex', '--label=win-1', '--json'], { cwd: repo });
    expect(reg.exitCode).toBe(0);
    const agentId = JSON.parse(reg.stdout).data.agent_id;

    const claim = runCli(['claim-next', 'RUN-0001', `--agent=${agentId}`, '--json'], { cwd: repo });
    expect(claim.exitCode).toBe(0);
    expect(JSON.parse(claim.stdout).data.task_id).toBe('TASK-0001');

    const again = runCli(['claim-next', 'RUN-0001', `--agent=${agentId}`, '--json'], { cwd: repo });
    expect(again.exitCode).toBe(6); // agent_claim_limit joins the BR-001 conflict class (17 S2.2 row 6)
    expect(JSON.parse(again.stdout).code).toBe('agent_claim_limit');

    const rel = runCli(['release', 'RUN-0001', 'TASK-0001', `--agent=${agentId}`, '--json'], { cwd: repo });
    expect(rel.exitCode).toBe(0);
  });

  it('claim-next without --agent is a usage error', () => {
    const repo = mkTmpGitRepo(); dirs.push(repo);
    const r = runCli(['claim-next', 'RUN-0001', '--json'], { cwd: repo });
    expect(r.exitCode).toBe(2);
  });

  it('msg post -> context hydrate roundtrip via argv (FEAT-005)', async () => {
    const repo = mkTmpGitRepo(); dirs.push(repo);
    runCli(['init', '--json'], { cwd: repo });
    const { writeFileSync } = await import('node:fs');
    const { join } = await import('node:path');
    const { validPayload } = await import('../../core/test/payload-fixture.js');
    writeFileSync(join(repo, 'payload.json'), JSON.stringify(validPayload()));
    runCli(['run', 'import', join(repo, 'payload.json'), '--json'], { cwd: repo });
    runCli(['task', 'publish', 'RUN-0001', '--json'], { cwd: repo });
    const reg = runCli(['agent', 'register', 'RUN-0001', '--tool=codex', '--label=w1', '--json'], { cwd: repo });
    const agentId = JSON.parse(reg.stdout).data.agent_id;

    const post = runCli(['msg', 'post', 'RUN-0001', `--from=${agentId}`, '--type=question', '--body=expiry rule?', '--json'], { cwd: repo });
    expect(post.exitCode).toBe(0);
    expect(JSON.parse(post.stdout).data.message_id).toBe('MSG-0001');

    const hyd = runCli(['context', 'hydrate', 'RUN-0001', 'TASK-0002', `--agent=${agentId}`, '--json'], { cwd: repo });
    expect(hyd.exitCode).toBe(0);
    expect(JSON.parse(hyd.stdout).data.must_read).toContain('tasks/TASK-0002/task.md');

    const graph = runCli(['graph', 'validate', 'RUN-0001', '--json'], { cwd: repo });
    expect(graph.exitCode).toBe(0);
  });

  it('run show + adapter install routes (FEAT-006)', async () => {
    const repo = mkTmpGitRepo(); dirs.push(repo);
    runCli(['init', '--json'], { cwd: repo });
    const { writeFileSync, existsSync } = await import('node:fs');
    const { join } = await import('node:path');
    const { validPayload } = await import('../../core/test/payload-fixture.js');
    writeFileSync(join(repo, 'payload.json'), JSON.stringify(validPayload()));
    runCli(['run', 'import', join(repo, 'payload.json'), '--json'], { cwd: repo });

    const show = runCli(['run', 'show', 'RUN-0001', '--json'], { cwd: repo });
    expect(show.exitCode).toBe(0);
    expect(JSON.parse(show.stdout).data.counts.draft).toBe(2);

    const install = runCli(['adapter', 'install', '--tool=claude-code', '--json'], { cwd: repo });
    expect(install.exitCode).toBe(0);
    expect(existsSync(join(repo, '.claude', 'commands', 'team-dispatch.md'))).toBe(true);
  });

  it('status + audit run + repair routes stay exit 0 with findings as data (FEAT-008)', async () => {
    const repo = mkTmpGitRepo(); dirs.push(repo);
    runCli(['init', '--json'], { cwd: repo });
    const { writeFileSync } = await import('node:fs');
    const { join } = await import('node:path');
    const { validPayload } = await import('../../core/test/payload-fixture.js');
    writeFileSync(join(repo, 'payload.json'), JSON.stringify(validPayload()));
    runCli(['run', 'import', join(repo, 'payload.json'), '--json'], { cwd: repo });
    runCli(['task', 'publish', 'RUN-0001', '--json'], { cwd: repo });

    const status = runCli(['status', 'RUN-0001', '--json'], { cwd: repo });
    expect(status.exitCode).toBe(0);
    expect(JSON.parse(status.stdout).data.counts.ready).toBe(2);

    const audit = runCli(['audit', 'run', 'RUN-0001', '--json'], { cwd: repo });
    expect(audit.exitCode).toBe(0);
    expect(JSON.parse(audit.stdout).data.rules_run.length).toBeGreaterThan(10);

    const repair = runCli(['repair', 'RUN-0001', '--json'], { cwd: repo });
    expect(repair.exitCode).toBe(0);
    expect(JSON.parse(repair.stdout).data.repaired).toEqual([]);

    const watch = runCli(['watch', 'RUN-0001', '--once', '--json'], { cwd: repo });
    expect(watch.exitCode).toBe(0);
  });

  it('renders repair string findings without "undefined" (P1-11: the findings key has two producer shapes)', async () => {
    const repo = mkTmpGitRepo(); dirs.push(repo);
    const { writeFileSync, appendFileSync } = await import('node:fs');
    const { join } = await import('node:path');
    const { validPayload } = await import('../../core/test/payload-fixture.js');
    runCli(['init', '--json'], { cwd: repo });
    writeFileSync(join(repo, 'payload.json'), JSON.stringify(validPayload()));
    runCli(['run', 'import', join(repo, 'payload.json'), '--json'], { cwd: repo });
    runCli(['task', 'publish', 'RUN-0001', '--json'], { cwd: repo });
    // a torn tail line makes repair emit a PLAIN-STRING finding (audit emits objects for the same key)
    appendFileSync(join(repo, '.team', 'runs', 'RUN-0001', 'events.jsonl'), '{"event":"task_don');

    const r = runCli(['repair', 'RUN-0001'], { cwd: repo }); // no --json -> human render path
    expect(r.exitCode).toBe(0);
    expect(r.stdout).not.toContain('undefined'); // used to print "[undefined] undefined undefined -> undefined"
    expect(r.stdout).toContain('unparseable'); // the finding string is rendered verbatim
  });
});

describe('remediation R0-7: CLI experience group (docs/16 §2; docs/17 §1)', () => {
  it('bare invocation prints help and exits 0', () => {
    const r = runCli([], { cwd: '/tmp' });
    expect(r.exitCode).toBe(0);
    expect(r.stdout).toContain('sigmarun — repo-local multi-agent collaboration gateway');
  });

  it('a mistyped subcommand answers with the group menu, not a bare unknown-command', () => {
    const r = runCli(['task', 'lst', '--json'], { cwd: '/tmp' });
    expect(r.exitCode).toBe(2);
    const env = JSON.parse(r.stdout);
    expect(env.message).toContain('Unknown subcommand');
    expect(env.next_actions.join(' ')).toContain('publish | add | list | cancel | show');
  });

  it('--flag with a space instead of "=" gets a targeted diagnosis', () => {
    const r = runCli(['claim-next', 'RUN-0001', '--agent', 'AGENT-X', '--json'], { cwd: '/tmp' });
    expect(r.exitCode).toBe(2);
    expect(JSON.parse(r.stdout).message).toContain('--agent takes a value');
  });

  it('--team-root outranks cwd discovery (docs/16 §2 resolution order)', async () => {
    const repo = mkTmpGitRepo(); dirs.push(repo);
    runCli(['init', '--json'], { cwd: repo });
    const { join } = await import('node:path');
    const r = runCli(['run', 'list', `--team-root=${join(repo, '.team')}`, '--json'], { cwd: '/tmp' });
    expect(r.exitCode).toBe(0);
    expect(JSON.parse(r.stdout).ok).toBe(true);
  });

  it('task cancel --reason lands in the envelope and the ledger event; events timeline shows the date', async () => {
    const repo = mkTmpGitRepo(); dirs.push(repo);
    runCli(['init', '--json'], { cwd: repo });
    const { writeFileSync, readFileSync } = await import('node:fs');
    const { join } = await import('node:path');
    const { validPayload } = await import('../../core/test/payload-fixture.js');
    const f = join(repo, 'payload.json');
    writeFileSync(f, JSON.stringify(validPayload()));
    runCli(['run', 'import', f, '--json'], { cwd: repo });
    const r = runCli(['task', 'cancel', 'RUN-0001', 'TASK-0001', '--reason=descoped in planning', '--json'], { cwd: repo });
    expect(r.exitCode).toBe(0);
    expect(JSON.parse(r.stdout).data.reason).toBe('descoped in planning');
    const events = readFileSync(join(repo, '.team', 'runs', 'RUN-0001', 'events.jsonl'), 'utf8')
      .trim().split('\n').map((l) => JSON.parse(l));
    expect(events.find((e) => e.event === 'task_cancelled')?.payload.reason).toBe('descoped in planning');

    // human-mode events timeline carries the date — a run can span days
    const timeline = runCli(['events', 'RUN-0001'], { cwd: repo });
    expect(timeline.stdout).toMatch(/\d\d-\d\d \d\d:\d\d:\d\d/);
  });
});

describe('remediation C3: human-mode sections (msg bodies, task table, needs-you)', () => {
  it('msg list shows bodies; run show shows the task table; status shows needs-you with commands', async () => {
    const repo = mkTmpGitRepo(); dirs.push(repo);
    runCli(['init', '--json'], { cwd: repo });
    const { writeFileSync } = await import('node:fs');
    const { join } = await import('node:path');
    const { validPayload } = await import('../../core/test/payload-fixture.js');
    const f = join(repo, 'payload.json');
    writeFileSync(f, JSON.stringify(validPayload()));
    runCli(['run', 'import', f, '--lightweight', '--json'], { cwd: repo });
    runCli(['claim-next', 'RUN-0001', '--agent=win-1', '--json'], { cwd: repo });
    runCli(['msg', 'post', 'RUN-0001', '--from=win-1', '--type=blocker', '--task=TASK-0001', '--body=Need the schema decision.', '--json'], { cwd: repo });

    const msgs = runCli(['msg', 'list', 'RUN-0001'], { cwd: repo });
    expect(msgs.stdout).toContain('Need the schema decision.'); // the body, not just a count
    expect(msgs.stdout).toContain('MSG-0001');

    const show = runCli(['run', 'show', 'RUN-0001'], { cwd: repo });
    expect(show.stdout).toContain('TASK-0001');
    expect(show.stdout).toContain('claimed');

    const status = runCli(['status', 'RUN-0001'], { cwd: repo });
    expect(status.stdout).toContain('needs you:');
    expect(status.stdout).toContain('--type=answer --reply-to=MSG-0001');

    const agents = runCli(['agent', 'list', 'RUN-0001'], { cwd: repo });
    expect(agents.stdout).toContain('win-1');
    expect(agents.stdout).toContain('TASK-0001');
  });
});

describe('remediation C4: watch loop streams a heartbeat line per tick', () => {
  it('loop mode emits tick lines through the sink and exits on a terminal run', async () => {
    const repo = mkTmpGitRepo(); dirs.push(repo);
    runCli(['init', '--json'], { cwd: repo });
    const { writeFileSync } = await import('node:fs');
    const { join } = await import('node:path');
    const { validPayload } = await import('../../core/test/payload-fixture.js');
    writeFileSync(join(repo, 'payload.json'), JSON.stringify(validPayload()));
    runCli(['run', 'import', join(repo, 'payload.json'), '--lightweight', '--json'], { cwd: repo });
    // drive to terminal so the loop exits after one tick
    for (const t of ['TASK-0001', 'TASK-0002']) {
      runCli(['claim-next', 'RUN-0001', '--agent=w', '--json'], { cwd: repo });
      runCli(['done', 'RUN-0001', t, '--agent=w', '--json'], { cwd: repo });
    }
    runCli(['report', 'RUN-0001', '--json'], { cwd: repo });

    const ticks: string[] = [];
    const r = runCli(['watch', 'RUN-0001'], { cwd: repo, onTick: (l) => ticks.push(l) });
    expect(r.exitCode).toBe(0);
    expect(ticks.length).toBe(1);
    expect(ticks[0]).toContain('terminal');

    const jsonTicks: string[] = [];
    runCli(['watch', 'RUN-0001', '--json'], { cwd: repo, onTick: (l) => jsonTicks.push(l) });
    expect(() => JSON.parse(jsonTicks[0]!)).not.toThrow(); // NDJSON per tick
  });
});

describe('smoke-test fixes: help surface (L15) and project-scoped worktree root (L17)', () => {
  it('--help and help exit 0 with the command map', () => {
    for (const argv of [['--help'], ['help'], ['-h']]) {
      const r = runCli(argv);
      expect(r.exitCode).toBe(0);
      expect(r.stdout).toContain('claim-next');
      expect(r.stdout).toContain('verify submit');
    }
  });

  it('init writes a worktree root that carries the repo dirname', async () => {
    const { mkTmpGitRepo, cleanup } = await import('../../storage/test/helpers.js');
    const { readFileSync } = await import('node:fs');
    const { basename, join } = await import('node:path');
    const repo = mkTmpGitRepo();
    try {
      runCli(['init'], { cwd: repo });
      const project = JSON.parse(readFileSync(join(repo, '.team', 'project.json'), 'utf8'));
      expect(project.default_worktree_root).toBe(`../.team-worktrees/${basename(repo)}`);
    } finally {
      cleanup(repo);
    }
  });
});

describe('P1-4 / P1-7 / P1-12: onboarding breadcrumbs + health-gate exit codes', () => {
  it('P1-4: --help opens with a start-here path into the agent /team-plan entry', () => {
    const r = runCli(['--help']);
    expect(r.exitCode).toBe(0);
    expect(r.stdout).toContain('adapter install');
    expect(r.stdout).toContain('/team-plan'); // the real UX lives in the agent slash command
  });

  it('P1-7: doctor with a failing check does not exit 0 — a broken lock must gate, not pass', async () => {
    const repo = mkTmpGitRepo(); dirs.push(repo);
    runCli(['init', '--json'], { cwd: repo });
    const { rmSync } = await import('node:fs');
    const { join } = await import('node:path');
    rmSync(join(repo, '.team', 'locks'), { recursive: true, force: true }); // lock probe fails
    const r = runCli(['doctor', '--json'], { cwd: repo });
    const env = JSON.parse(r.stdout);
    expect(env.ok).toBe(false);
    expect(r.exitCode).not.toBe(0);
  });

  it('P1-12: audit run with an error finding exits non-zero yet keeps the success envelope (findings are data)', async () => {
    const repo = mkTmpGitRepo(); dirs.push(repo);
    runCli(['init', '--json'], { cwd: repo });
    const { writeFileSync, readFileSync } = await import('node:fs');
    const { join } = await import('node:path');
    const { validPayload } = await import('../../core/test/payload-fixture.js');
    writeFileSync(join(repo, 'payload.json'), JSON.stringify(validPayload()));
    runCli(['run', 'import', join(repo, 'payload.json'), '--lightweight', '--json'], { cwd: repo });
    // tear the ledger: drop a middle event so seqs gap -> AUD-033 error
    const ev = join(repo, '.team', 'runs', 'RUN-0001', 'events.jsonl');
    const lines = readFileSync(ev, 'utf8').trim().split('\n');
    writeFileSync(ev, [lines[0], ...lines.slice(2)].join('\n') + '\n');
    const r = runCli(['audit', 'run', 'RUN-0001', '--json'], { cwd: repo });
    const env = JSON.parse(r.stdout);
    // envelope semantics unchanged: audit ran fine, findings are data
    expect(env.ok).toBe(true);
    expect(env.code).toBe('OK');
    expect((env.data.findings as Array<{ severity: string }>).some((f) => f.severity === 'error')).toBe(true);
    // but the process exit blocks `sigmarun audit run && ...`
    expect(r.exitCode).not.toBe(0);
  });

  it('P1-12: audit run on a clean run still exits 0 (no error findings, no false gate)', async () => {
    const repo = mkTmpGitRepo(); dirs.push(repo);
    runCli(['init', '--json'], { cwd: repo });
    const { writeFileSync } = await import('node:fs');
    const { join } = await import('node:path');
    const { validPayload } = await import('../../core/test/payload-fixture.js');
    writeFileSync(join(repo, 'payload.json'), JSON.stringify(validPayload()));
    runCli(['run', 'import', join(repo, 'payload.json'), '--lightweight', '--json'], { cwd: repo });
    const r = runCli(['audit', 'run', 'RUN-0001', '--json'], { cwd: repo });
    expect(r.exitCode).toBe(0);
    expect((JSON.parse(r.stdout).data.findings as Array<{ severity: string }>).filter((f) => f.severity === 'error')).toEqual([]);
  });
});

describe('OSS-readiness: version flag and crash-safety', () => {
  it('--version, -v, and version print the gateway version on the first line at exit 0', () => {
    for (const argv of [['--version'], ['-v'], ['version']]) {
      const r = runCli(argv);
      expect(r.exitCode).toBe(0);
      // The first line stays a bare gateway semver so scripts can still do `--version | head -1`.
      expect(r.stdout.split('\n')[0]).toMatch(/^\d+\.\d+\.\d+$/);
    }
  });

  it('--version also surfaces the adapter template generation this gateway ships (P1-1)', () => {
    // TEMPLATE_VERSION moves with capability, on its own cadence from the gateway semver; before this
    // it was invisible to every CLI face, so "which generation am I on" was unanswerable.
    const r = runCli(['--version']);
    expect(r.exitCode).toBe(0);
    expect(r.stdout).toContain(TEMPLATE_VERSION);
    expect(r.stdout.toLowerCase()).toContain('template');
  });

  it('--version reports installed-template drift so "did my upgrade take effect" is answerable (P1-1)', () => {
    const repo = mkTmpGitRepo(); dirs.push(repo);
    runCli(['init'], { cwd: repo });
    runCli(['adapter', 'install', '--tool=claude-code'], { cwd: repo });

    // A fresh install matches the bundled generation -> up to date.
    const fresh = runCli(['--version'], { cwd: repo });
    expect(fresh.stdout).toContain(TEMPLATE_VERSION);
    expect(fresh.stdout.toLowerCase()).toContain('up to date');

    // Simulate an installed-but-never-reinstalled repo: roll one managed file's marker back a
    // generation. The gateway must now report drift and name the stale installed generation.
    const planFile = join(repo, '.claude', 'commands', 'team-plan.md');
    writeFileSync(planFile, readFileSync(planFile, 'utf8').replace(/template_version: [\d.]+/, 'template_version: 0.0.1'));
    const drifted = runCli(['--version'], { cwd: repo });
    expect(drifted.stdout.toLowerCase()).toContain('drift');
    expect(drifted.stdout).toContain('0.0.1');
  });

  it('every surveyed bad invocation returns a single JSON envelope, never a throw', () => {
    // bin.ts has a last-resort guard, but runCli itself should not throw on hostile input.
    const hostile: string[][] = [
      ['run', 'import', '/does/not/exist.json', '--json'],
      ['status', 'RUN-9999', '--json'],
      ['claim-next', 'RUN-1', '--agent=', '--json'],
      ['task', 'add', 'RUN-1', '--file=/nope.json', '--json'],
      ['verify', 'submit', 'RUN-1', '--agent=x', '--verify=/nope.json', '--json'],
    ];
    for (const argv of hostile) {
      expect(() => runCli(argv)).not.toThrow();
      const r = runCli(argv);
      expect(() => JSON.parse(r.stdout)).not.toThrow();
      expect(r.stdout.trim().split('\n').length).toBe(1);
    }
  });
});

describe('OSS review: a UTF-8 BOM on a payload file does not break import', () => {
  it('run import strips a leading BOM and succeeds', async () => {
    const { mkTmpGitRepo, cleanup } = await import('../../storage/test/helpers.js');
    const { validPayload } = await import('../../core/test/payload-fixture.js');
    const { writeFileSync } = await import('node:fs');
    const { join } = await import('node:path');
    const repo = mkTmpGitRepo();
    try {
      runCli(['init'], { cwd: repo });
      const file = join(repo, 'payload.json');
      writeFileSync(file, '\uFEFF' + JSON.stringify(validPayload()), 'utf8'); // BOM-prefixed
      const r = runCli(['run', 'import', file, '--json'], { cwd: repo });
      expect(r.exitCode).toBe(0);
      expect(JSON.parse(r.stdout).ok).toBe(true);
    } finally {
      cleanup(repo);
    }
  });
});
