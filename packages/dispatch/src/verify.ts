import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { readJsonState, redactText, writeJsonStateAtomic, writeJsonStateNew, type ResolveOptions } from '@sigmarun/storage';
import { appendEvent, failEnvelope, okEnvelope, truncateOutput, type Envelope } from '@sigmarun/core';
import { loadClaims, withRunLock, type ClaimStores, type TaskRow } from './claim-engine.js';
import { historicalOwners } from './review.js';

export interface VerifyOptions extends ResolveOptions {
  runId: string;
  agentId: string;
  verifyPath: string;
}

interface VerifyDraft {
  target?: { kind: string; task_id?: string };
  checks?: Array<{ name: string; cmd: string; exit_code: number; output_file?: string | null; status: string }>;
  gates?: Record<string, string>;
  skip_reasons?: Record<string, string>;
  verdict?: string;
  failures_mapped?: string[];
}

const GATE_KEYS = ['build', 'focused_tests', 'regression_tests', 'scope_check', 'evidence_complete'];

/** Statuses a run-level verification failure may legitimately map back to rework (docs/16 §4.1 node J). */
const REVERTIBLE = new Set(['approved', 'verified', 'integrated']);

/**
 * Flip a task back to changes_requested and revive its owner claim (shared by review/verify fail paths).
 * Returns true when an owner claim was revived — the caller persists the claims file only then.
 */
export function mapTaskToRework(runDir: string, runId: string, taskId: string, stores: ClaimStores): boolean {
  const taskFile = join(runDir, 'tasks', taskId, 'task.json');
  if (!existsSync(taskFile)) return false;
  const task = readJsonState(taskFile);
  (task.doc as { status: string }).status = 'changes_requested';
  writeJsonStateAtomic(taskFile, task.doc as Record<string, unknown>, { expectedRev: task.rev });
  const listFile = join(runDir, 'team-task-list.json');
  const list = readJsonState(listFile);
  const row = (list.doc as { tasks: TaskRow[] }).tasks.find((r) => r.task_id === taskId);
  if (row) row.status = 'changes_requested';
  writeJsonStateAtomic(listFile, list.doc as Record<string, unknown>, { expectedRev: list.rev });
  // submitted = pre-verified rework (review fail); completed = post-verified rework (run-level /
  // integration fail — verify closed the claim at verified per AUD-009, so the failure re-opens it).
  const owner = stores.taskClaims.doc.claims.find((c) => c.task_id === taskId && ['submitted', 'completed'].includes(c.status));
  if (owner) {
    const run = readJsonState(join(runDir, 'run.json')).doc as { default_policy?: { claim_ttl_minutes?: number } };
    owner.status = 'active';
    owner.lease_until = new Date(Date.now() + (run.default_policy?.claim_ttl_minutes ?? 30) * 60_000).toISOString();
    return true;
  }
  return false;
}

/**
 * Verify submission (docs/14 §4): the agent executed the checks; the gateway validates structure,
 * persists the record, and drives approved -> verified / changes_requested (D11 boundary).
 * Independence is enforced inline: a historical owner cannot verify their own task (INV-008 family;
 * review finding #4 — previously only the claim-next synthesis filtered owners).
 */
export function verifySubmit(opts: VerifyOptions): Envelope {
  const startedAt = Date.now();
  return withRunLock(opts, startedAt, (runDir, runId) => {
    if (!existsSync(join(runDir, 'agents', `${opts.agentId}.json`))) {
      return failEnvelope('agent_not_registered', `Agent ${opts.agentId} is not registered on ${runId}.`, {
        nextActions: [`Register first: sigmarun agent register ${runId} --tool=<tool> --label=<window>`],
        startedAt,
      });
    }
    let draft: VerifyDraft;
    try {
      draft = JSON.parse(readFileSync(opts.verifyPath, 'utf8')) as VerifyDraft;
    } catch (e) {
      return failEnvelope('schema_invalid', `Verify draft is not readable JSON: ${String(e)}`, { startedAt });
    }
    const errors: string[] = [];
    const kind = draft.target?.kind;
    if (kind !== 'task' && kind !== 'run') errors.push('target.kind must be task or run');
    const taskId = draft.target?.task_id;
    if (kind === 'task' && !taskId) errors.push('task target needs target.task_id');

    const checks = draft.checks ?? [];
    checks.forEach((c) => {
      if (!['pass', 'fail', 'skipped'].includes(c.status)) errors.push(`check "${c.name}": status must be pass/fail/skipped`);
      if (c.status === 'pass' && c.exit_code !== 0) errors.push(`check "${c.name}": status pass contradicts exit_code ${c.exit_code}`);
      if (c.status === 'fail' && c.exit_code === 0) errors.push(`check "${c.name}": status fail contradicts exit_code 0`);
      if (c.output_file && !existsSync(c.output_file)) errors.push(`check "${c.name}": output file missing: ${c.output_file}`);
    });
    const gates = draft.gates ?? {};
    for (const key of GATE_KEYS) {
      const v = gates[key];
      if (!v || !['pass', 'fail', 'skipped'].includes(v)) errors.push(`gate "${key}" must be pass/fail/skipped`);
      if (v === 'skipped' && !draft.skip_reasons?.[key]) errors.push(`gate "${key}": skipped requires a reason (14 §4 rule 2)`);
    }
    const verdict = draft.verdict;
    if (verdict !== 'pass' && verdict !== 'fail') errors.push('verdict must be pass or fail');
    const nonSkippedAllPass = GATE_KEYS.every((k) => gates[k] === 'skipped' || gates[k] === 'pass');
    if (verdict === 'pass' && !nonSkippedAllPass) errors.push('verdict pass requires every non-skipped gate to pass (14 §4 rule 4)');

    const stores = loadClaims(runDir, runId);
    // Run-level failure mapping is validated BEFORE any write: mapped ids must exist and be in a
    // revertible state — no phantom ids, no silent flips of never-verified tasks (review finding #6).
    const mapped = kind === 'task' ? (taskId ? [taskId] : []) : (draft.failures_mapped ?? []);
    if (kind === 'run' && verdict === 'fail') {
      if (mapped.length === 0) errors.push('run-level fail must map failures back to task ids (failures_mapped)');
      for (const t of mapped) {
        const f = join(runDir, 'tasks', t, 'task.json');
        if (!existsSync(f)) {
          errors.push(`failures_mapped: task ${t} does not exist`);
          continue;
        }
        const st = (readJsonState(f).doc as { status: string }).status;
        if (!REVERTIBLE.has(st)) errors.push(`failures_mapped: task ${t} is ${st}; only approved/verified/integrated can be mapped to rework`);
      }
    }
    if (errors.length > 0) {
      return failEnvelope('schema_invalid', `Verify draft failed ${errors.length} mechanical check(s).`, { data: { errors }, startedAt });
    }

    if (kind === 'task') {
      const taskFile = join(runDir, 'tasks', taskId!, 'task.json');
      if (!existsSync(taskFile)) return failEnvelope('task_not_found', `Task ${taskId} does not exist on ${runId}.`, { startedAt });
      const status = (readJsonState(taskFile).doc as { status: string }).status;
      if (status !== 'approved') {
        return failEnvelope('invalid_transition', `Task ${taskId} is ${status}; verification targets approved tasks.`, { startedAt });
      }
      if (historicalOwners(runDir, taskId!, stores).has(opts.agentId)) {
        return failEnvelope(
          'self_approval_forbidden',
          `Agent ${opts.agentId} owned ${taskId} at some point; independent verification forbids verifying your own work (INV-008).`,
          { startedAt },
        );
      }
    }

    const countersFile = join(runDir, 'counters.json');
    const counters = readJsonState(countersFile);
    const cdoc = counters.doc as Record<string, unknown>;
    const n = Number(cdoc.next_verify ?? 1);
    const verifyId = `VERIFY-${String(n).padStart(4, '0')}`;
    const verDir = join(runDir, 'verification');
    const outDir = join(verDir, 'outputs');
    mkdirSync(outDir, { recursive: true });

    const canonicalChecks = checks.map((c, i) => {
      let outputRef: string | null = null;
      let truncated = false;
      if (c.output_file && existsSync(c.output_file)) {
        // Same cut-then-redact pipeline as evidence outputs (D8; review finding: unbounded verify logs).
        const cut = truncateOutput(readFileSync(c.output_file, 'utf8'));
        truncated = cut.truncated;
        outputRef = `outputs/${verifyId}-${String(i + 1).padStart(2, '0')}.log`;
        writeFileSync(join(verDir, outputRef), redactText(cut.text).text, 'utf8');
      }
      return { name: c.name, cmd: c.cmd, exit_code: c.exit_code, output_ref: outputRef, output_truncated: truncated, status: c.status };
    });

    writeJsonStateNew(join(verDir, `${verifyId}.json`), {
      schema_version: 'team.verification.v1',
      verify_id: verifyId,
      run_id: runId,
      target: draft.target,
      verifier_agent_id: opts.agentId,
      executed_at: new Date().toISOString(),
      checks: canonicalChecks,
      gates,
      skip_reasons: draft.skip_reasons ?? {},
      verdict,
      failures_mapped: draft.failures_mapped ?? [],
    });
    writeJsonStateAtomic(countersFile, { ...cdoc, next_verify: n + 1 }, { expectedRev: counters.rev });

    appendEvent(runDir, {
      event: 'verification_started',
      actor: { type: 'agent', id: opts.agentId },
      run_id: runId,
      ...(taskId ? { task_id: taskId } : {}),
      payload: { verify_id: verifyId, target: draft.target },
    });

    if (verdict === 'pass') {
      if (kind === 'task') {
        const taskFile = join(runDir, 'tasks', taskId!, 'task.json');
        const task = readJsonState(taskFile);
        (task.doc as { status: string }).status = 'verified';
        writeJsonStateAtomic(taskFile, task.doc as Record<string, unknown>, { expectedRev: task.rev });
        const listFile = join(runDir, 'team-task-list.json');
        const list = readJsonState(listFile);
        const row = (list.doc as { tasks: TaskRow[] }).tasks.find((r) => r.task_id === taskId);
        if (row) row.status = 'verified';
        writeJsonStateAtomic(listFile, list.doc as Record<string, unknown>, { expectedRev: list.rev });
        // AUD-009 (18 matrix row 5): verified is claim-terminal — the owner's engagement ends here.
        // Rework after a later run-level failure revives via the owner re-claim path, so completing is safe.
        const claimsFile = join(runDir, 'claims', 'task-claims.json');
        if (existsSync(claimsFile)) {
          const tc = readJsonState(claimsFile);
          let touched = false;
          for (const c of (tc.doc as { claims: Array<{ task_id: string; status: string }> }).claims) {
            if (c.task_id === taskId && ['active', 'submitted'].includes(c.status)) {
              c.status = 'completed';
              touched = true;
            }
          }
          if (touched) writeJsonStateAtomic(claimsFile, tc.doc as Record<string, unknown>, { expectedRev: tc.rev });
        }
      }
      appendEvent(runDir, {
        event: 'verification_passed',
        actor: { type: 'agent', id: opts.agentId },
        run_id: runId,
        ...(taskId ? { task_id: taskId } : {}),
        payload: { verify_id: verifyId, target: draft.target },
      });
      return okEnvelope({
        message: `${verifyId}: pass${kind === 'task' ? `; ${taskId} is verified` : ' (run level)'}.`,
        data: { verify_id: verifyId, verdict, target: draft.target },
        startedAt,
      });
    }

    let revived = false;
    for (const t of mapped) revived = mapTaskToRework(runDir, runId, t, stores) || revived;
    if (revived && stores.taskClaims.rev !== null) {
      writeJsonStateAtomic(stores.taskClaims.file, stores.taskClaims.doc, { expectedRev: stores.taskClaims.rev });
    }
    appendEvent(runDir, {
      event: 'verification_failed',
      actor: { type: 'agent', id: opts.agentId },
      run_id: runId,
      ...(kind === 'task' && taskId ? { task_id: taskId } : {}),
      payload: { verify_id: verifyId, failures_mapped: mapped },
    });
    return okEnvelope({
      message: `${verifyId}: fail; ${mapped.length} task(s) mapped back to changes_requested.`,
      data: { verify_id: verifyId, verdict, failures_mapped: mapped },
      startedAt,
    });
  });
}

/** D15 verifier synthesis: stateless suggestion from the approved queue (no verify-claim schema in 14 §4). */
export function synthesizeVerify(runDir: string, runId: string, agentId: string, startedAt: number): Envelope {
  const rows = (readJsonState(join(runDir, 'team-task-list.json')).doc as { tasks: TaskRow[] }).tasks;
  const stores = loadClaims(runDir, runId);
  const candidate = rows
    .filter((r) => r.status === 'approved')
    .filter((r) => !historicalOwners(runDir, r.task_id, stores).has(agentId))
    .sort((a, b) => a.task_id.localeCompare(b.task_id))[0];
  if (!candidate) {
    return failEnvelope('no_claimable_task', `No approved task is waiting for verification on ${runId}.`, { startedAt });
  }
  return okEnvelope({
    message: `Verify work: ${candidate.task_id} awaits independent verification.`,
    data: {
      kind: 'verify_work',
      task_id: candidate.task_id,
      evidence_ref: `evidence/${candidate.task_id}/evidence.json`,
      gates: GATE_KEYS,
    },
    nextActions: [
      `Run the checks yourself, then: sigmarun verify submit ${runId} --agent=${agentId} --verify=<file> (target.kind=task).`,
    ],
    startedAt,
  });
}
