import { spawnSync, execSync } from 'node:child_process';
import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { basename, join } from 'node:path';
import {
  GatewayError,
  probeLockCapability,
  resolveTeamRoot,
  writeJsonStateNew,
  type ResolveOptions,
} from '@sigmarun/storage';
import { failEnvelope, okEnvelope, GATEWAY_VERSION, type Envelope } from './envelope.js';
import { parseSchemaId, ProjectSchema, CountersSchema, SUPPORTED_MAJOR } from './schemas.js';

export interface DoctorCheck {
  name: string;
  status: 'pass' | 'fail' | 'warn';
  detail: string;
}

function toFailEnvelope(e: unknown, startedAt: number): Envelope {
  if (e instanceof GatewayError) return failEnvelope(e.code, e.message, { startedAt });
  return failEnvelope('io_error', String(e), { startedAt });
}

function currentBranch(repoRoot: string): string {
  const r = spawnSync('git', ['symbolic-ref', '--short', 'HEAD'], { cwd: repoRoot, encoding: 'utf8' });
  return r.status === 0 ? r.stdout.trim() : 'main';
}

/**
 * Create the repo-local .team skeleton; idempotent.
 * @contract docs/17 §8 init · docs/16 §1.1 gitignore rule (D4) · docs/02 §6 project.json fields
 * @uc UC-001 precondition (BDD-001 background)
 */
/** `init --example` scaffold — the smallest payload that imports clean (remediation A4). */
const EXAMPLE_PAYLOAD = {
  schema_version: 'team.plan_payload.v1',
  source: { tool: 'claude-code', command: '/team-plan', prompt: 'example', agent_id: 'AGENT-claude-001' },
  run: { title: 'Example run', mode: 'feature', goal: 'Replace this with your goal.' },
  plan: { summary: 'Two independent example tasks. Edit freely.' },
  tasks: [
    {
      client_task_key: 'first',
      title: 'First piece',
      type: 'implementation',
      objective: 'Describe the first independent piece of work.',
      acceptance: ['A testable statement of done.'],
      paths: { allow: ['src/**'] },
    },
    {
      client_task_key: 'second',
      title: 'Second piece',
      type: 'implementation',
      objective: 'Describe the second independent piece of work.',
      acceptance: ['Another testable statement of done.'],
      paths: { allow: ['docs/**'] },
    },
  ],
};

export function initProject(opts: ResolveOptions & { example?: boolean } = {}): Envelope {
  const startedAt = Date.now();
  let root;
  try {
    root = resolveTeamRoot(opts);
  } catch (e) {
    return toFailEnvelope(e, startedAt);
  }
  const created: string[] = [];
  const skipped: string[] = [];
  const warnings: { code: string; message: string }[] = [];

  for (const dir of ['', 'locks']) {
    const p = join(root.teamRoot, dir);
    if (existsSync(p)) skipped.push(p);
    else {
      mkdirSync(p, { recursive: true });
      created.push(p);
    }
  }

  const projectFile = join(root.teamRoot, 'project.json');
  if (existsSync(projectFile)) {
    skipped.push(projectFile);
    warnings.push({ code: 'already_initialized', message: 'project.json already exists; left untouched.' });
  } else {
    writeJsonStateNew(projectFile, {
      schema_version: 'team.project.v1',
      project_id: basename(root.repoRoot),
      team_dir: '.team',
      min_gateway_version: GATEWAY_VERSION,
      default_base_branch: currentBranch(root.repoRoot),
      // Smoke-test L17: sibling repos with the same RUN-ID collide without a project segment.
      default_worktree_root: `../.team-worktrees/${basename(root.repoRoot)}`,
      default_checks: [],
      project_memory_path: 'docs/team/MEMORY.md',
      tooling: { supports_claude_code: true, supports_codex: true, supports_cursor: false },
    });
    created.push(projectFile);
  }

  const countersFile = join(root.teamRoot, 'counters.json');
  if (existsSync(countersFile)) skipped.push(countersFile);
  else {
    writeJsonStateNew(countersFile, { schema_version: 'team.counters.v1', next_run: 1 });
    created.push(countersFile);
  }

  const gitignore = join(root.repoRoot, '.gitignore');
  const giContent = existsSync(gitignore) ? readFileSync(gitignore, 'utf8') : '';
  let gitignoreUpdated = false;
  if (!giContent.split('\n').some((l) => l.trim() === '.team/')) {
    appendFileSync(gitignore, `${giContent.endsWith('\n') || giContent === '' ? '' : '\n'}.team/\n`);
    gitignoreUpdated = true;
  }

  if (opts.example) {
    const target = join(root.repoRoot, 'sigmarun-plan.example.json');
    if (existsSync(target)) {
      skipped.push(target);
    } else {
      writeFileSync(target, JSON.stringify(EXAMPLE_PAYLOAD, null, 2) + '\n', 'utf8');
      created.push(target);
    }
  }

  return okEnvelope({
    startedAt,
    message: created.length > 0 ? 'Initialized .team coordination directory.' : 'Already initialized; nothing to do.',
    data: { teamRoot: root.teamRoot, created, skipped, gitignoreUpdated },
    warnings,
    // P1-4: the breadcrumb must not dead-end at `doctor`. Hand over the whole onboarding chain —
    // verify -> install the agent adapter -> drive the run from the /team-plan slash command, which
    // is where the actual UX lives (the raw CLI is the plumbing those commands call).
    nextActions: opts.example
      ? [
          'Verify the environment: sigmarun doctor',
          'Install the agent commands: sigmarun adapter install --tool=claude-code|codex',
          'Edit sigmarun-plan.example.json, then import it: sigmarun run import sigmarun-plan.example.json --lightweight',
          'Then drive it from your agent — open Claude Code or Codex in this repo and run /team-plan <goal> (or /team-dispatch <RUN-ID>). The real workflow lives in those slash commands, not the CLI.',
        ]
      : [
          'Verify the environment: sigmarun doctor',
          'Install the agent commands: sigmarun adapter install --tool=claude-code|codex',
          'Then start from your agent — open Claude Code or Codex in this repo and run /team-plan <goal>. That slash command is the real entry point, not the CLI.',
        ],
  });
}

/**
 * Read-only environment self-check.
 * @contract docs/17 §8 doctor · docs/16 §1.4/§2.2 tracked-.team detection (AUD-030) · docs/21 §4.1 version handshake
 * @bdd BDD-001 background · ERR-006 journey
 */
type Resolved = ReturnType<typeof resolveTeamRoot>;

/** Run the doctor checks against a resolved team root (pure read). */
function buildChecks(root: Resolved): DoctorCheck[] {
  const checks: DoctorCheck[] = [];
  const add = (name: string, status: DoctorCheck['status'], detail: string) => checks.push({ name, status, detail });

  add('git_repo', 'pass', `repo root: ${root.repoRoot}`);
  add('team_root', 'pass', `resolved via ${root.source}: ${root.teamRoot}`);

  const initialized = existsSync(join(root.teamRoot, 'project.json'));
  add('team_initialized', initialized ? 'pass' : 'fail', initialized ? '.team present' : 'Run `sigmarun init` first.');

  const nodeMajor = Number(process.versions.node.split('.')[0]);
  add('node_version', nodeMajor >= 20 ? 'pass' : 'fail', `node ${process.versions.node} (need >= 20)`);

  if (initialized) {
    const locksDir = join(root.teamRoot, 'locks');
    const lockOk = existsSync(locksDir) && probeLockCapability(locksDir);
    // P1-7: name the consequence, not just the symptom — a dead lock means concurrent commands
    // lose their collision guard (crash-safety), so this cannot read as a passing green check.
    add(
      'lock_capability',
      lockOk ? 'pass' : 'fail',
      lockOk
        ? 'mkdir lock probe ok'
        : 'cannot create lock directories under .team/locks — the run lock is unavailable, so concurrent commands lose crash-safety (no collision guard); fix write permissions on .team/locks',
    );
  }

  const gitignore = join(root.repoRoot, '.gitignore');
  const hasEntry = existsSync(gitignore) && readFileSync(gitignore, 'utf8').split('\n').some((l) => l.trim() === '.team/');
  add('gitignore_team_entry', hasEntry ? 'pass' : 'fail', hasEntry ? '.gitignore covers .team/' : 'Add `.team/` to .gitignore (D4).');

  let tracked = '';
  try {
    tracked = execSync('git ls-files .team', { cwd: root.repoRoot, encoding: 'utf8' }).trim();
  } catch {
    tracked = '';
  }
  add(
    'tracked_team_dir',
    tracked === '' ? 'pass' : 'fail',
    tracked === ''
      ? 'no .team files tracked by git'
      : `tracked .team files found; run: git rm -r --cached .team/ (AUD-030). Files: ${tracked.split('\n').length}`,
  );

  // docs/25 §6: the L4 memory path must stay committable — a gitignored path defeats promotion.
  if (initialized) {
    const memRel = (() => {
      try {
        return ((JSON.parse(readFileSync(join(root.teamRoot, 'project.json'), 'utf8')) as { project_memory_path?: string })
          .project_memory_path) ?? 'docs/team/MEMORY.md';
      } catch {
        return 'docs/team/MEMORY.md';
      }
    })();
    let memIgnored = false;
    try {
      execSync(`git check-ignore -q ${JSON.stringify(memRel)}`, { cwd: root.repoRoot });
      memIgnored = true;
    } catch {
      memIgnored = false;
    }
    add(
      'project_memory_committable',
      memIgnored ? 'fail' : 'pass',
      memIgnored
        ? `${memRel} is covered by .gitignore; project memory must be git-tracked (docs/25 §3.1)`
        : `${memRel} is committable`,
    );
  }

  if (initialized) {
    for (const [name, file, schema, object] of [
      ['project_schema', 'project.json', ProjectSchema, 'project'],
      ['counters_schema', 'counters.json', CountersSchema, 'counters'],
    ] as const) {
      try {
        const doc = JSON.parse(readFileSync(join(root.teamRoot, file), 'utf8'));
        const id = parseSchemaId(String(doc.schema_version ?? ''));
        if (!id || id.object !== object || id.major !== SUPPORTED_MAJOR) {
          add(name, 'fail', `unsupported_schema_version: found ${doc.schema_version}, supported major v${SUPPORTED_MAJOR}`);
        } else if (!schema.safeParse(doc).success) {
          add(name, 'fail', `${file} does not match team.${object}.v1 shape`);
        } else {
          add(name, 'pass', `${file} valid (${doc.schema_version})`);
        }
      } catch (e) {
        add(name, 'fail', `cannot read ${file}: ${String(e)}`);
      }
    }
  }

  return checks;
}

/** Safe auto-fixes for the fixable doctor failures. Returns a description if it acted, else null. */
function tryFixCheck(name: string, root: Resolved, opts: ResolveOptions): string | null {
  try {
    switch (name) {
      case 'team_initialized':
        initProject(opts);
        return 'ran init (created .team scaffolding + .gitignore entry)';
      case 'gitignore_team_entry': {
        const gi = join(root.repoRoot, '.gitignore');
        const content = existsSync(gi) ? readFileSync(gi, 'utf8') : '';
        appendFileSync(gi, `${content.endsWith('\n') || content === '' ? '' : '\n'}.team/\n`);
        return 'added .team/ to .gitignore (D4)';
      }
      case 'tracked_team_dir':
        execSync('git rm -r --cached .team', { cwd: root.repoRoot, stdio: 'ignore' });
        return 'untracked .team/ from git (files kept on disk; AUD-030)';
      case 'lock_capability': {
        const locksDir = join(root.teamRoot, 'locks');
        if (!existsSync(locksDir)) {
          mkdirSync(locksDir, { recursive: true });
          return 'created the missing .team/locks directory';
        }
        return null; // present but unprobeable -> a permission issue, not auto-fixable
      }
      default:
        return null; // node_version, schema corruption, memory-committable: not safely auto-fixable
    }
  } catch {
    return null; // the fix itself failed (permissions, git state) — report the check as still-failed
  }
}

export interface DoctorOptions extends ResolveOptions {
  /** apply safe auto-fixes for fixable failures, then re-check (roadmap Phase 1). */
  fix?: boolean;
}

export function doctorProject(opts: DoctorOptions = {}): Envelope {
  const startedAt = Date.now();
  let root: Resolved;
  try {
    root = resolveTeamRoot(opts);
  } catch (e) {
    return toFailEnvelope(e, startedAt);
  }

  let checks = buildChecks(root);
  const fixed: string[] = [];
  if (opts.fix) {
    for (const c of checks.filter((c) => c.status === 'fail')) {
      const applied = tryFixCheck(c.name, root, { cwd: opts.cwd, env: opts.env });
      if (applied) fixed.push(applied);
    }
    if (fixed.length > 0) {
      root = resolveTeamRoot(opts); // init may have created the team root
      checks = buildChecks(root);
    }
  }

  const failed = checks.filter((c) => c.status === 'fail');
  const fixedNote = fixed.length > 0 ? ` Auto-fixed ${fixed.length}: ${fixed.join('; ')}.` : '';
  // P1-4: an all-green doctor is a waypoint, not the finish line — point onward to the adapter
  // install and the /team-plan agent entry instead of leaving the user on a bare checkmark. On
  // failures, each check's detail IS the next step (they carry their own remediation, including
  // the lock crash-safety cost surfaced above).
  const ONWARD = [
    'Install the agent commands if you have not: sigmarun adapter install --tool=claude-code|codex',
    'Then start from your agent — open Claude Code or Codex in this repo and run /team-plan <goal>. That slash command is the real entry point, not the CLI.',
  ];
  const env = okEnvelope({
    startedAt,
    message:
      failed.length === 0
        ? `Doctor: all ${checks.length} checks passed.${fixedNote}`
        : `Doctor: ${failed.length} of ${checks.length} checks ${opts.fix ? 'still fail after auto-fix' : 'failed'}.${fixedNote}`,
    data: { checks, ...(opts.fix ? { fixed } : {}) },
    warnings: failed.map((c) => ({ code: `doctor_${c.name}_failed`, message: c.detail })),
    nextActions: failed.length === 0 ? ONWARD : failed.map((c) => c.detail),
  });
  // P1-7: doctor is a health gate, not a status printer. okEnvelope always stamps ok:true, so a
  // failed check (e.g. an unusable .team/locks — crash-safety gone) still read green. Pull the
  // aggregate ok down when any check fails; the CLI maps ok:false here to a non-zero exit.
  return failed.length === 0 ? env : { ...env, ok: false };
}
