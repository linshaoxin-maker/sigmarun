import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, renameSync, rmdirSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { realpathSync } from 'node:fs';

export { GatewayError } from './errors.js';
export type { ReasonCode } from './errors.js';
export { acquireLock } from './lock.js';
export type { LockOptions } from './lock.js';
export { scanForSecrets, redactText, SECRET_PATTERNS } from './redaction.js';
export type { SecretHit } from './redaction.js';
import { GatewayError } from './errors.js';

export interface TeamRootResolution {
  repoRoot: string;
  teamRoot: string;
  source: 'flag' | 'env' | 'git';
}

export interface ResolveOptions {
  cwd?: string;
  env?: Record<string, string | undefined>;
  teamRootFlag?: string;
}

/**
 * Resolve the single authoritative .team root.
 * @contract docs/16 §2 — resolution order: --team-root flag > TEAM_ROOT env > git common dir (main checkout).
 */
export function resolveTeamRoot(opts: ResolveOptions = {}): TeamRootResolution {
  const cwd = opts.cwd ?? process.cwd();
  const env = opts.env ?? process.env;
  if (opts.teamRootFlag) {
    const teamRoot = resolve(opts.teamRootFlag);
    return { repoRoot: dirname(teamRoot), teamRoot, source: 'flag' };
  }
  if (env.TEAM_ROOT) {
    const teamRoot = resolve(env.TEAM_ROOT);
    return { repoRoot: dirname(teamRoot), teamRoot, source: 'env' };
  }
  const probe = spawnSync('git', ['rev-parse', '--is-bare-repository', '--git-common-dir'], {
    cwd,
    encoding: 'utf8',
  });
  if (probe.status !== 0) {
    throw new GatewayError('not_a_git_repo', 'Current directory is not inside a git repository.');
  }
  const [bareLine, commonLine] = probe.stdout.trim().split('\n');
  if (bareLine?.trim() === 'true') {
    throw new GatewayError('bare_repo_unsupported', 'Bare repositories are not supported; use a working checkout.');
  }
  if (!commonLine) {
    throw new GatewayError('team_root_not_found', 'Could not resolve the git common directory.');
  }
  const commonDir = realpathSync(resolve(cwd, commonLine.trim()));
  const repoRoot = dirname(commonDir);
  return { repoRoot, teamRoot: join(repoRoot, '.team'), source: 'git' };
}

export interface JsonState {
  doc: Record<string, unknown> & { rev?: number };
  rev: number;
}

/** Read a mutable JSON state file preserving every field verbatim (docs/21 §4.2 unknown-field round trip). */
export function readJsonState(file: string): JsonState {
  let raw: string;
  try {
    raw = readFileSync(file, 'utf8');
  } catch (e) {
    throw new GatewayError('io_error', `Cannot read state file: ${file}`, { cause: String(e) });
  }
  const doc = JSON.parse(raw) as JsonState['doc'];
  return { doc, rev: typeof doc.rev === 'number' ? doc.rev : 0 };
}

/**
 * Atomic state write: temp file + rename, rev bumped by exactly 1.
 * @contract docs/17 §5.1–5.2 — rev mismatch means a bypassing write happened; refuse with rev_conflict.
 */
export function writeJsonStateAtomic(
  file: string,
  doc: Record<string, unknown>,
  opts: { expectedRev: number },
): void {
  if (existsSync(file)) {
    const current = readJsonState(file);
    if (current.rev !== opts.expectedRev) {
      throw new GatewayError('rev_conflict', `State file rev is ${current.rev}, expected ${opts.expectedRev}: ${file}`);
    }
  } else if (opts.expectedRev !== 0) {
    throw new GatewayError('rev_conflict', `State file does not exist yet, expected rev ${opts.expectedRev}: ${file}`);
  }
  const next = { ...doc, rev: opts.expectedRev + 1, updated_at: new Date().toISOString() };
  const tmp = `${file}.tmp-${process.pid}`;
  try {
    writeFileSync(tmp, JSON.stringify(next, null, 2) + '\n');
    renameSync(tmp, file);
  } catch (e) {
    throw new GatewayError('io_error', `Atomic write failed for: ${file}`, { cause: String(e) });
  }
}

/** Write a brand-new JSON file (rev 1) atomically; refuses to overwrite. */
export function writeJsonStateNew(file: string, doc: Record<string, unknown>): void {
  if (existsSync(file)) {
    throw new GatewayError('io_error', `Refusing to overwrite existing state file: ${file}`);
  }
  const tmp = `${file}.tmp-${process.pid}`;
  writeFileSync(tmp, JSON.stringify({ ...doc, rev: 1 }, null, 2) + '\n');
  renameSync(tmp, file);
}

/** mkdir-based lock capability probe used by doctor (docs/17 §8). */
export function probeLockCapability(dir: string): boolean {
  const probe = join(dir, `.lock-probe-${process.pid}`);
  try {
    mkdirSync(probe);
    rmdirSync(probe);
    return true;
  } catch {
    return false;
  }
}
