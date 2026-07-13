import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, realpathSync, renameSync, rmdirSync, writeFileSync } from 'node:fs';
import { dirname, isAbsolute, join, posix, resolve, sep } from 'node:path';

export { GatewayError } from './errors.js';
export type { ReasonCode } from './errors.js';
export { acquireLock, tryAcquireLock, runLockPath } from './lock.js';
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

function insideRoot(rootReal: string, targetReal: string): boolean {
  return targetReal === rootReal || targetReal.startsWith(rootReal.endsWith(sep) ? rootReal : rootReal + sep);
}

function nearestExistingPath(path: string): string {
  let cur = path;
  while (!existsSync(cur)) {
    const next = dirname(cur);
    if (next === cur) break;
    cur = next;
  }
  return cur;
}

/** Validate docs/24 §6 repo-relative POSIX paths: no absolute paths, no backslashes, no `..` escape. */
export function normalizeRepoRelativePath(input: string, label = 'path'): string {
  if (!input || isAbsolute(input) || input.includes('\\')) {
    throw new GatewayError('path_escape_detected', `${label} must be a repo-relative POSIX path.`);
  }
  const normalized = posix.normalize(input);
  if (normalized === '.' || normalized === '..' || normalized.startsWith('../') || posix.isAbsolute(normalized)) {
    throw new GatewayError('path_escape_detected', `${label} escapes the repository: ${input}`);
  }
  return normalized;
}

/**
 * Resolve a repo-relative path and verify the nearest existing realpath stays under repoRoot.
 * This catches symlink escapes while still allowing not-yet-created leaf files/directories.
 */
export function resolveRepoRelativeInside(repoRoot: string, rel: string, label = 'path'): { rel: string; abs: string } {
  const normalized = normalizeRepoRelativePath(rel, label);
  const abs = resolve(repoRoot, normalized);
  assertRealPathInside(repoRoot, abs, label);
  return { rel: normalized, abs };
}

/** Validate an existing or soon-to-exist absolute path by realpathing its nearest existing parent. */
export function assertRealPathInside(root: string, target: string, label = 'path'): void {
  if (!existsSync(root)) {
    throw new GatewayError('path_escape_detected', `${label} root does not exist: ${root}`);
  }
  const rootReal = realpathSync(root);
  const existing = nearestExistingPath(target);
  const targetReal = realpathSync(existing);
  if (!insideRoot(rootReal, targetReal)) {
    throw new GatewayError('path_escape_detected', `${label} realpath escapes root: ${target}`);
  }
}

/** Read a mutable JSON state file preserving every field verbatim (docs/21 §4.2 unknown-field round trip). */
export function readJsonState(file: string): JsonState {
  let raw: string;
  try {
    raw = readFileSync(file, 'utf8');
  } catch (e) {
    throw new GatewayError('io_error', `Cannot read state file: ${file}`, { cause: String(e) });
  }
  let doc: JsonState['doc'];
  try {
    doc = JSON.parse(raw) as JsonState['doc'];
  } catch {
    // A readable-but-malformed state file (git merge-conflict markers, a torn
    // write, an editor swap file, a hand-edit) must not crash the CLI with a raw
    // SyntaxError. Every primitive already handles GatewayError → clean envelope.
    throw new GatewayError(
      'io_error',
      `State file is not valid JSON: ${file}. If this repo shares .team/ across branches, check for an unresolved git merge conflict, then re-run.`,
    );
  }
  assertSupportedSchema(doc, file);
  return { doc, rev: typeof doc.rev === 'number' ? doc.rev : 0 };
}

/** All shipped schemas are major 1; every subsequent major must land with a migration chain (docs/21 §6.1). */
const SUPPORTED_SCHEMA_MAJOR = 1;

/**
 * Version handshake on every state read (docs/17 §11, docs/21 §7 pre-flight defence):
 * an unknown schema major means a newer gateway wrote this file — refuse instead of misreading it.
 */
function assertSupportedSchema(doc: Record<string, unknown>, file: string): void {
  const sv = doc.schema_version;
  if (typeof sv !== 'string') return; // derived/older files without the field stay readable
  const m = /^team\.[a-z_]+\.v(\d+)$/.exec(sv);
  if (!m) return; // foreign naming is not ours to police
  if (Number(m[1]) > SUPPORTED_SCHEMA_MAJOR) {
    throw new GatewayError(
      'unsupported_schema_version',
      `${file} carries ${sv}, newer than this gateway understands (v${SUPPORTED_SCHEMA_MAJOR}). Upgrade sigmarun to a version that understands it.`,
    );
  }
}

/**
 * Atomic state write: temp file + rename, rev bumped by exactly 1.
 * @contract docs/17 §5.1–5.2 — rev mismatch means a bypassing write happened; refuse with rev_conflict.
 */
/**
 * Monotonic counter bumped by every atomic state write. collectStateRevs (in core) keys its
 * memo on this so a transaction that appends N events walks the state tree once, not N times
 * (concurrency review Finding 2: the per-event full-tree walk widened the lock's stale window).
 */
let stateGeneration = 0;
export function currentStateGeneration(): number {
  return stateGeneration;
}

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
    stateGeneration++;
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
  stateGeneration++;
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
