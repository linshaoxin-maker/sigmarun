import { existsSync, readFileSync } from 'node:fs';
import { basename, dirname, join } from 'node:path';
import { GatewayError, resolveTeamRoot, tryAcquireLock, runLockPath, type ResolveOptions } from '@sigmarun/storage';
import { failEnvelope, GATEWAY_VERSION, type Envelope } from './envelope.js';
import { appendEvent } from './events.js';

/**
 * R1 seed of the TxKernel (remediation §2.2①; full body migration lands in R3): the single
 * choke point every run-write transaction passes through. Owning this one door buys two
 * contract items that were pure paper before:
 *
 *  - the min_gateway_version WRITE GATE (docs/21 §6.2/§8): init wrote the field, nothing read
 *    it — an old gateway could scribble over a newer project's state unchecked;
 *  - the lock_takeover ledger event (docs/17 §4, docs/18 #44): stale-lock takeovers happened
 *    silently (a vlog line at best), leaving no account of who seized a crashed holder's lock.
 */

/** Refuse to write when the project demands a newer gateway major. Read paths stay open. */
export function assertGatewayWritable(teamRoot: string): GatewayError | null {
  const f = join(teamRoot, 'project.json');
  if (!existsSync(f)) return null; // uninitialized tree — doctor's territory, not a write wall
  try {
    const min = (JSON.parse(readFileSync(f, 'utf8')) as { min_gateway_version?: string }).min_gateway_version;
    if (!min) return null;
    const need = Number(String(min).split('.')[0]);
    const have = Number(GATEWAY_VERSION.split('.')[0]);
    if (Number.isFinite(need) && Number.isFinite(have) && have < need) {
      return new GatewayError(
        'gateway_too_old',
        `Writes refused: this project requires gateway major ${need} (min_gateway_version=${min}); this is ${GATEWAY_VERSION}. Upgrade: npm i -g sigmarun@latest`,
      );
    }
  } catch {
    // unreadable project.json — doctor reports it; the write gate must not mask that diagnosis
  }
  return null;
}

/**
 * Acquire the run write lock through the version gate, and put any stale-lock takeover on the
 * ledger. Drop-in for `tryAcquireLock(runLockPath(runDir))` at every run mutator.
 */
export function acquireRunWriteLock(runDir: string): (() => void) | GatewayError {
  // <teamRoot>/runs/<RUN> — two levels up is the team root.
  const gate = assertGatewayWritable(dirname(dirname(runDir)));
  if (gate) return gate;
  let takeover: Record<string, unknown> | null = null;
  const release = tryAcquireLock(runLockPath(runDir), { onTakeover: (info) => { takeover = info; } });
  if (release instanceof GatewayError) return release;
  if (takeover) {
    // Seize first, record after (docs/17 §4): we hold the lock now, so the append is ordered.
    try {
      appendEvent(runDir, {
        event: 'lock_takeover',
        actor: { type: 'system', id: 'lock-manager' },
        run_id: basename(runDir),
        payload: takeover,
      });
    } catch {
      // the record must never fail the transaction the takeover just rescued
    }
  }
  return release;
}

/**
 * THE run-write transaction skeleton (remediation E1, R3 migration): resolve -> run exists ->
 * version gate + lock + takeover ledger -> body -> GatewayError-to-envelope -> release. The
 * system's most load-bearing invariants used to live in five near-copies (dispatch withRunLock,
 * core openRunTx / withRunTransaction / integrate withLock, plus inline forms in submit and the
 * context plane) whose write orders had already drifted three ways. One implementation, one
 * order of guards; the architecture test asserts no copy grows back.
 */
export function withRunTx(
  opts: ResolveOptions & { runId: string },
  startedAt: number,
  body: (runDir: string, runId: string) => Envelope,
): Envelope {
  let teamRoot: string;
  try {
    teamRoot = resolveTeamRoot(opts).teamRoot;
  } catch (err) {
    const ge = err as GatewayError;
    return failEnvelope(ge.code, ge.message, { startedAt });
  }
  const runDir = join(teamRoot, 'runs', opts.runId);
  if (!existsSync(join(runDir, 'run.json'))) {
    return failEnvelope('run_not_found', `Run ${opts.runId} does not exist under .team/runs/.`, { startedAt });
  }
  const release = acquireRunWriteLock(runDir);
  if (release instanceof GatewayError) return failEnvelope(release.code, release.message, { startedAt });
  try {
    return body(runDir, opts.runId);
  } catch (err) {
    if (err instanceof GatewayError) return failEnvelope(err.code, err.message, { startedAt });
    throw err;
  } finally {
    release();
  }
}
