import { spawnSync, execSync } from 'node:child_process';
import { appendFileSync, existsSync, mkdirSync, readFileSync } from 'node:fs';
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
export function initProject(opts: ResolveOptions = {}): Envelope {
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

  for (const dir of ['', 'templates', 'locks']) {
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
      default_worktree_root: '../.team-worktrees',
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

  return okEnvelope({
    startedAt,
    message: created.length > 0 ? 'Initialized .team coordination directory.' : 'Already initialized; nothing to do.',
    data: { teamRoot: root.teamRoot, created, skipped, gitignoreUpdated },
    warnings,
    nextActions: ['Run `sigmarun doctor` to verify the setup.'],
  });
}

/**
 * Read-only environment self-check.
 * @contract docs/17 §8 doctor · docs/16 §1.4/§2.2 tracked-.team detection (AUD-030) · docs/21 §4.1 version handshake
 * @bdd BDD-001 background · ERR-006 journey
 */
export function doctorProject(opts: ResolveOptions = {}): Envelope {
  const startedAt = Date.now();
  let root;
  try {
    root = resolveTeamRoot(opts);
  } catch (e) {
    return toFailEnvelope(e, startedAt);
  }
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
    add('lock_capability', lockOk ? 'pass' : 'fail', lockOk ? 'mkdir lock probe ok' : 'cannot create lock directories under .team/locks');
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

  const failed = checks.filter((c) => c.status === 'fail');
  return okEnvelope({
    startedAt,
    message: failed.length === 0 ? `Doctor: all ${checks.length} checks passed.` : `Doctor: ${failed.length} of ${checks.length} checks failed.`,
    data: { checks },
    warnings: failed.map((c) => ({ code: `doctor_${c.name}_failed`, message: c.detail })),
    nextActions: failed.length === 0 ? [] : failed.map((c) => c.detail),
  });
}
