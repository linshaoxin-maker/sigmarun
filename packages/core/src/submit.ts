import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { minimatch } from 'minimatch';
import {
  GatewayError,
  resolveRepoRelativeInside,
  tryAcquireLock,
  runLockPath,
  readJsonState,
  redactText,
  resolveTeamRoot,
  writeJsonStateAtomic,
  writeJsonStateNew,
  type ResolveOptions,
} from '@sigmarun/storage';
import { failEnvelope, okEnvelope, type Envelope, type EnvelopeWarning } from './envelope.js';
import { resolveRunMode } from './mode.js';
import { appendEvent, readEventsSafe } from './events.js';

export interface SubmitOptions extends ResolveOptions {
  runId: string;
  taskId: string;
  agentId: string;
  evidencePath: string;
}

interface DraftCommand {
  cmd_id: string;
  cmd: string;
  cwd?: string;
  exit_code: number;
  duration_ms?: number;
  output_file?: string;
}

interface Draft {
  summary?: string;
  changed_files?: Array<{ path: string; change_type?: string }>;
  commands?: DraftCommand[];
  required_checks_results?: Array<{ check: string; cmd_ref?: string; status: string; note?: string }>;
  acceptance?: Array<{ item: string; status: string; evidence_ref?: string; note?: string }>;
  context_ack?: string[];
  handoff?: string;
  handoff_file?: string;
  risks?: string[];
  deviations?: string[];
  follow_ups?: string[];
}

/** File-level scope check — the minimatch tier deferred from FEAT-003/004 (docs/10 §8.2, AUD-014). */
export function fileInScope(path: string, allowGlobs: string[]): boolean {
  return allowGlobs.some((g) => minimatch(path, g, { dot: true }));
}

const HEAD_LINES = 50;
const TAIL_LINES = 200;
const MAX_BYTES = 256 * 1024;

export function truncateOutput(raw: string): { text: string; truncated: boolean } {
  const lines = raw.split('\n');
  let text = raw;
  let truncated = false;
  if (lines.length > HEAD_LINES + TAIL_LINES) {
    const dropped = lines.length - HEAD_LINES - TAIL_LINES;
    text = [...lines.slice(0, HEAD_LINES), `[... ${dropped} lines truncated ...]`, ...lines.slice(-TAIL_LINES)].join('\n');
    truncated = true;
  }
  if (Buffer.byteLength(text, 'utf8') > MAX_BYTES) {
    text = text.slice(0, MAX_BYTES) + '\n[... truncated at 256KB ...]';
    truncated = true;
  }
  return { text, truncated };
}

/**
 * Submit evidence — the F1 gate: a task is finished only through this transaction.
 * @contract docs/14 §2 (schema + field rules + D8 outputs + §2.3 nine steps) · docs/15 §3.3 working→submitted ·
 *           AUD-011/013/014/028 inline halves · docs/24 §4 redaction
 */
export function submitEvidence(opts: SubmitOptions): Envelope {
  const startedAt = Date.now();
  let teamRoot: string;
  let repoRoot: string;
  try {
    const resolved = resolveTeamRoot(opts);
    teamRoot = resolved.teamRoot;
    repoRoot = resolved.repoRoot;
  } catch (err) {
    const ge = err as GatewayError;
    return failEnvelope(ge.code, ge.message, { startedAt });
  }
  const runDir = join(teamRoot, 'runs', opts.runId);
  if (!existsSync(join(runDir, 'run.json'))) {
    return failEnvelope('run_not_found', `Run ${opts.runId} does not exist under .team/runs/.`, { startedAt });
  }
  if (!existsSync(join(runDir, 'tasks', opts.taskId, 'task.json'))) {
    return failEnvelope('task_not_found', `Task ${opts.taskId} does not exist on ${opts.runId}.`, { startedAt });
  }

  const release = tryAcquireLock(runLockPath(runDir));
  if (release instanceof GatewayError) return failEnvelope(release.code, release.message, { startedAt });

  try {
    // Mode wall (docs/26; S3): a lightweight run has no evidence gate — one legal submit used
    // to push the task to approved where `done` no longer reaches, stranding it.
    const runMode = resolveRunMode(readJsonState(join(runDir, 'run.json')).doc as { lightweight?: boolean });
    if (!runMode.can.submit) {
      return failEnvelope('mode_mismatch', `Run ${opts.runId} is lightweight — there is no evidence gate in this mode.`, {
        nextActions: [`Complete the task directly: sigmarun done ${opts.runId} ${opts.taskId} --agent=${opts.agentId}`],
        startedAt,
      });
    }

    // Step 2: state gate — working + owner.
    const taskFile = join(runDir, 'tasks', opts.taskId, 'task.json');
    const task = readJsonState(taskFile);
    const tdoc = task.doc as Record<string, unknown> & {
      status: string;
      acceptance: string[];
      required_checks: string[];
      paths?: { allow?: string[] };
    };
    const claimsFile = join(runDir, 'claims', 'task-claims.json');
    const claims = existsSync(claimsFile) ? readJsonState(claimsFile) : null;
    const claim = claims
      ? (claims.doc as { claims: Array<{ claim_id: string; task_id: string; agent_id: string; status: string }> }).claims.find(
          (c) => c.task_id === opts.taskId && c.status === 'active',
        )
      : undefined;
    if (claim && claim.agent_id !== opts.agentId) {
      return failEnvelope('not_claim_owner', `Claim ${claim.claim_id} on ${opts.taskId} belongs to ${claim.agent_id}.`, { startedAt });
    }
    if (tdoc.status !== 'working' || !claim) {
      return failEnvelope('invalid_transition', `Task ${opts.taskId} is ${tdoc.status}; submit needs working with an active claim.`, {
        startedAt,
      });
    }

    // Step 3: mechanical validation — collect every error, mutate nothing on failure.
    const errors: string[] = [];
    const warnings: EnvelopeWarning[] = [];
    let draft: Draft | null = null;
    try {
      draft = JSON.parse(readFileSync(opts.evidencePath, 'utf8')) as Draft;
    } catch (e) {
      errors.push(`evidence draft is not readable JSON: ${String(e)}`);
    }

    const emitInvalid = (): Envelope => {
      appendEvent(runDir, {
        event: 'evidence_invalid',
        actor: { type: 'agent', id: opts.agentId },
        run_id: opts.runId,
        task_id: opts.taskId,
        payload: { error_codes: errors.slice(0, 10) },
      });
      return failEnvelope('evidence_invalid', `Evidence for ${opts.taskId} failed ${errors.length} mechanical check(s).`, {
        data: { errors },
        nextActions: ['Fix exactly the listed items and re-run sigmarun submit.'],
        startedAt,
      });
    };
    if (!draft) return emitInvalid();

    if (!draft.summary || draft.summary.trim() === '') errors.push('summary must not be empty');
    const changed = draft.changed_files ?? [];
    if (changed.length === 0) errors.push('changed_files must not be empty (docs/14 §2.1)');
    // Smoke-test L6: plain strings here used to surface as a misleading path_escape_detected.
    changed.forEach((f, i) => {
      if (typeof f !== 'object' || f === null || typeof (f as { path?: unknown }).path !== 'string') {
        errors.push(`changed_files[${i}] must be an object {path, change_type}, got ${JSON.stringify(f).slice(0, 60)}`);
      }
    });
    // Security: cmd_id becomes the on-disk artifact path `outputs/<cmd_id>.log`. An unvalidated
    // value ("../../.." etc.) is an arbitrary-write primitive reachable through the sanctioned API.
    // Confine it to a bare identifier.
    (draft.commands ?? []).forEach((c, i) => {
      if (typeof c?.cmd_id !== 'string' || !/^[A-Za-z0-9._-]+$/.test(c.cmd_id) || c.cmd_id === '.' || c.cmd_id === '..') {
        errors.push(`commands[${i}].cmd_id must match [A-Za-z0-9._-] (no path separators); got ${JSON.stringify(c?.cmd_id)}`);
      }
    });
    const commands = draft.commands ?? [];
    const byCmdId = new Map(commands.map((c) => [c.cmd_id, c]));

    const checkResults = draft.required_checks_results ?? [];
    for (const required of tdoc.required_checks ?? []) {
      if (!checkResults.some((r) => r.check === required)) {
        errors.push(`required check not covered: "${required}"`);
      }
    }
    for (const c of commands) {
      if (c.output_file && !existsSync(c.output_file)) {
        errors.push(`command ${c.cmd_id}: declared output file does not exist: ${c.output_file} (resolved from the invocation cwd; absolute paths are accepted)`);
      }
    }
    for (const r of checkResults) {
      if (!['pass', 'fail', 'skipped'].includes(r.status)) errors.push(`check "${r.check}": status must be pass/fail/skipped`);
      if (r.status === 'skipped' && !r.note) errors.push(`check "${r.check}": skipped requires a note`);
      if (r.status !== 'skipped') {
        const cmd = r.cmd_ref ? byCmdId.get(r.cmd_ref) : undefined;
        if (!cmd) errors.push(`check "${r.check}": cmd_ref ${r.cmd_ref ?? '(missing)'} does not match any command`);
        else if (!cmd.output_file || !existsSync(cmd.output_file)) {
          errors.push(`check "${r.check}": raw output file missing for ${cmd.cmd_id} (D8; paths resolve from the invocation cwd — absolute paths are accepted)`);
        }
      }
    }

    const acceptance = draft.acceptance ?? [];
    const taskAcceptance = tdoc.acceptance ?? [];
    if (acceptance.length !== taskAcceptance.length) {
      errors.push(`acceptance must cover the task item-by-item (${acceptance.length} given, ${taskAcceptance.length} required)`);
    } else {
      taskAcceptance.forEach((item, i) => {
        if (acceptance[i]?.item !== item) errors.push(`acceptance[${i}] text mismatch: expected "${item}"`);
        if (!['met', 'unmet', 'partial'].includes(acceptance[i]?.status ?? '')) {
          errors.push(`acceptance[${i}]: status must be met/unmet/partial`);
        }
      });
    }

    let handoffContent = draft.handoff ?? '';
    if (!handoffContent && draft.handoff_file && existsSync(draft.handoff_file)) {
      handoffContent = readFileSync(draft.handoff_file, 'utf8');
    }
    if (!handoffContent.trim()) errors.push('handoff content is required (the gateway writes context/tasks/<TASK>.md for you)');

    if (errors.length > 0) return emitInvalid();

    // Step 4: recompute in_scope from the active path claim (never trust the agent flag).
    const pathClaimsFile = join(runDir, 'claims', 'path-claims.json');
    const allowGlobs = existsSync(pathClaimsFile)
      ? ((readJsonState(pathClaimsFile).doc as { claims: Array<{ task_id: string; status: string; paths: { allow?: string[] } }> })
          .claims.filter((c) => c.task_id === opts.taskId && c.status === 'active')
          .flatMap((c) => c.paths.allow ?? []))
      : (tdoc.paths?.allow ?? []);
    const changedFiles = changed.map((f) => {
      const { rel } = resolveRepoRelativeInside(repoRoot, f.path, 'changed_files.path');
      return {
        path: rel,
        change_type: f.change_type ?? 'modified',
        in_scope: fileInScope(rel, allowGlobs),
      };
    });
    const outOfScope = changedFiles.filter((f) => !f.in_scope);
    if (outOfScope.length > 0) {
      warnings.push({
        code: 'out_of_scope_change',
        message: `${outOfScope.length} changed file(s) outside the claimed paths: ${outOfScope.map((f) => f.path).join(', ')} (AUD-014).`,
      });
    }

    // AUD-028 half: reconcile context_ack against the latest hydrate must_read.
    const hydrated = readEventsSafe(runDir)
      .events.filter((e) => e.event === 'context_hydrated' && e.task_id === opts.taskId)
      .pop() as { payload?: { must_read?: string[] } } | undefined;
    if (hydrated?.payload?.must_read) {
      const acked = new Set(draft.context_ack ?? []);
      const missing = hydrated.payload.must_read.filter((m) => !acked.has(m));
      if (missing.length > 0) {
        warnings.push({
          code: 'handoff_not_acknowledged',
          message: `context_ack is missing ${missing.length} hydrated must_read item(s): ${missing.join(', ')} (AUD-028).`,
        });
      }
    }

    // Step 5: persist outputs (truncate + redact), handoff, evidence.json (+history), evidence.md.
    const evDir = join(runDir, 'evidence', opts.taskId);
    const outputsDir = join(evDir, 'outputs');
    mkdirSync(outputsDir, { recursive: true });
    let redactionHits = 0;
    const canonicalCommands = commands.map((c) => {
      let outputRef: string | null = null;
      let truncated = false;
      if (c.output_file && existsSync(c.output_file)) {
        const raw = readFileSync(c.output_file, 'utf8');
        const cut = truncateOutput(raw);
        const red = redactText(cut.text);
        redactionHits += red.hits.length;
        outputRef = `outputs/${c.cmd_id}.log`;
        writeFileSync(join(evDir, outputRef), red.text, 'utf8');
        truncated = cut.truncated;
      }
      return {
        cmd_id: c.cmd_id,
        cmd: c.cmd,
        cwd: c.cwd ?? 'worktree',
        exit_code: c.exit_code,
        duration_ms: c.duration_ms ?? null,
        output_ref: outputRef,
        output_truncated: truncated,
      };
    });
    const redSummary = redactText(draft.summary!);
    const redHandoff = redactText(handoffContent);
    redactionHits += redSummary.hits.length + redHandoff.hits.length;
    if (redactionHits > 0) {
      warnings.push({ code: 'secret_redacted', message: `${redactionHits} secret pattern(s) were replaced with [REDACTED:kind] (docs/24 §4).` });
    }

    mkdirSync(join(runDir, 'context', 'tasks'), { recursive: true });
    const handoffRef = `context/tasks/${opts.taskId}.md`;
    writeFileSync(join(runDir, handoffRef), redHandoff.text, 'utf8');

    const evidenceFile = join(evDir, 'evidence.json');
    let revision = 1;
    if (existsSync(evidenceFile)) {
      const prev = readJsonState(evidenceFile);
      revision = Number((prev.doc as { revision?: number }).revision ?? 0) + 1;
      mkdirSync(join(evDir, 'history'), { recursive: true });
      renameSync(evidenceFile, join(evDir, 'history', `rev-${revision - 1}.json`));
    }
    const now = new Date().toISOString();
    const passCount = checkResults.filter((r) => r.status === 'pass').length;
    writeJsonStateNew(evidenceFile, {
      schema_version: 'team.evidence.v1',
      run_id: opts.runId,
      task_id: opts.taskId,
      claim_id: claim.claim_id,
      agent_id: opts.agentId,
      submitted_at: now,
      revision,
      summary: redSummary.text,
      changed_files: changedFiles,
      commands: canonicalCommands,
      required_checks_results: checkResults,
      acceptance,
      risks: draft.risks ?? [],
      deviations: draft.deviations ?? [],
      follow_ups: draft.follow_ups ?? [],
      context_ack: draft.context_ack ?? [],
      handoff_ref: handoffRef,
    });
    writeFileSync(
      join(evDir, 'evidence.md'),
      `# Evidence — ${opts.taskId} (rev ${revision})\n\n${redSummary.text}\n\nChecks: ${passCount}/${checkResults.length} pass · out-of-scope: ${outOfScope.length} · outputs: ${canonicalCommands.filter((c) => c.output_ref).length}\n\n> Authoritative record: evidence.json (this file is a derived index).\n`,
      'utf8',
    );

    // Step 6: task/claim -> submitted; path claims stay held (docs/15 §4.2).
    tdoc.status = 'submitted';
    writeJsonStateAtomic(taskFile, tdoc, { expectedRev: task.rev });
    const listFile = join(runDir, 'team-task-list.json');
    const list = readJsonState(listFile);
    const row = (list.doc as { tasks: Array<{ task_id: string; status: string }> }).tasks.find((r) => r.task_id === opts.taskId);
    if (row) row.status = 'submitted';
    claim.status = 'submitted';
    writeJsonStateAtomic(claimsFile, claims!.doc as Record<string, unknown>, { expectedRev: claims!.rev });

    // Step 7: D6 — review gate off => approved with an auditable skip trace.
    const run = readJsonState(join(runDir, 'run.json')).doc as { default_policy?: { require_review?: boolean } };
    // docs/15 §9 strict-wins: an explicit task-level review.required: true overrides a run-level false.
    const taskReview = (tdoc.review as { required?: boolean } | undefined) ?? {};
    const reviewRequired = run.default_policy?.require_review !== false || taskReview.required === true;
    if (!reviewRequired) {
      tdoc.status = 'approved';
      const task2 = readJsonState(taskFile);
      (task2.doc as { status: string }).status = 'approved';
      writeJsonStateAtomic(taskFile, task2.doc as Record<string, unknown>, { expectedRev: task2.rev });
      if (row) row.status = 'approved';
    }
    writeJsonStateAtomic(listFile, list.doc as Record<string, unknown>, { expectedRev: list.rev });

    // Step 8: events last — commit point.
    appendEvent(runDir, {
      event: 'evidence_submitted',
      actor: { type: 'agent', id: opts.agentId },
      run_id: opts.runId,
      task_id: opts.taskId,
      claim_id: claim.claim_id,
      payload: { revision, checks_pass_count: passCount, out_of_scope_count: outOfScope.length },
    });
    if (!reviewRequired) {
      // docs/14 §3.2 skip rule: every approved task still gets a review record — no audit exceptions.
      const reviewsDir = join(runDir, 'reviews', opts.taskId);
      mkdirSync(reviewsDir, { recursive: true });
      const reviewId = `REVIEW-${opts.taskId}-${String(revision).padStart(2, '0')}`;
      const skipFile = join(reviewsDir, `${reviewId}.json`);
      if (!existsSync(skipFile)) {
        writeJsonStateNew(skipFile, {
          schema_version: 'team.review.v1',
          review_id: reviewId,
          run_id: opts.runId,
          task_id: opts.taskId,
          round: revision,
          reviewer_agent_id: null,
          evidence_revision: revision,
          started_at: now,
          completed_at: now,
          decision: 'skipped_by_policy',
          checklist: [],
          findings: [],
          scope_check: { out_of_scope_files: outOfScope.map((f) => f.path), verdict: outOfScope.length > 0 ? 'warn' : 'pass' },
          acceptance_opinion: [],
        });
      }
      appendEvent(runDir, {
        event: 'review_skipped',
        actor: { type: 'policy', id: 'require_review=false' },
        run_id: opts.runId,
        task_id: opts.taskId,
        payload: { revision, review_id: reviewId },
      });
    }

    return okEnvelope({
      message: `Evidence rev ${revision} accepted for ${opts.taskId}; task is ${reviewRequired ? 'submitted (awaiting review)' : 'approved (review skipped by policy)'}.`,
      data: {
        task_id: opts.taskId,
        revision,
        checks_pass_count: passCount,
        out_of_scope_count: outOfScope.length,
        evidence_ref: `evidence/${opts.taskId}/evidence.json`,
        handoff_ref: handoffRef,
      },
      warnings,
      nextActions: reviewRequired
        ? [`Review gate: another agent runs /team-review ${opts.runId} (self-approval is forbidden, INV-008).`]
        : [`Verification/integration continue per run policy.`],
      startedAt,
    });
  } catch (err) {
    if (err instanceof GatewayError) return failEnvelope(err.code, err.message, { startedAt });
    throw err;
  } finally {
    release();
  }
}
