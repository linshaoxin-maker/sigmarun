import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, readdirSync, renameSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve, sep } from 'node:path';
import {
  GatewayError,
  assertRealPathInside,
  tryAcquireLock,
  readJsonState,
  resolveTeamRoot,
  scanForSecrets,
  writeJsonStateAtomic,
  type ResolveOptions,
} from '@sigmarun/storage';
import { assertGatewayWritable, appendEvent, failEnvelope, okEnvelope, type Envelope } from '@sigmarun/core';

export interface PromoteOptions extends ResolveOptions {
  runId: string;
  entry: string;
  section: string;
  refs: string[];
  supersedes?: string;
}

export interface CandidatesOptions extends ResolveOptions {
  runId: string;
}

export const MEMORY_SECTIONS = ['Architecture', 'Interfaces', 'Constraints', 'Pitfalls'] as const;

const MANAGED_HEADER = `# Project Memory
<!-- managed by sigmarun; edit via \`sigmarun memory promote\` / PR review -->

## Architecture

## Interfaces

## Constraints

## Pitfalls

## Superseded
`;

function invalid(message: string, startedAt: number): Envelope {
  return failEnvelope('memory_entry_invalid', message, {
    nextActions: ['Fix the entry (one sentence + resolvable refs) and retry sigmarun memory promote.'],
    startedAt,
  });
}

/**
 * L4 promotion (docs/25 §4): mechanical landing of a human/agent-curated one-liner.
 * Refs are mandatory and must resolve (INV-012 project level); content must survive redaction.
 */
export function promoteMemory(opts: PromoteOptions): Envelope {
  const startedAt = Date.now();
  let repoRoot: string;
  let teamRoot: string;
  try {
    const r = resolveTeamRoot(opts);
    repoRoot = r.repoRoot;
    teamRoot = r.teamRoot;
  } catch (err) {
    const ge = err as GatewayError;
    return failEnvelope(ge.code, ge.message, { startedAt });
  }
  const runDir = join(teamRoot, 'runs', opts.runId);
  if (!existsSync(join(runDir, 'run.json'))) {
    return failEnvelope('run_not_found', `Run ${opts.runId} does not exist under .team/runs/.`, { startedAt });
  }

  if (!opts.entry || opts.entry.trim().length === 0) return invalid('entry must be a non-empty one-liner.', startedAt);
  if (!(MEMORY_SECTIONS as readonly string[]).includes(opts.section)) {
    return invalid(`section must be one of ${MEMORY_SECTIONS.join('/')} (docs/25 §3.2).`, startedAt);
  }
  if (!opts.refs || opts.refs.length === 0) {
    return invalid('refs are mandatory — an entry without provenance is illegal (INV-012).', startedAt);
  }
  for (const ref of opts.refs) {
    if (/^MSG-\d{4}$/.test(ref)) {
      const msgFile = join(runDir, 'context', 'messages.jsonl');
      const hit =
        existsSync(msgFile) &&
        readFileSync(msgFile, 'utf8')
          .split('\n')
          .some((l) => l.includes(`"message_id":"${ref}"`));
      if (!hit) return invalid(`ref ${ref} does not exist in the run message pool.`, startedAt);
    } else {
      // A file ref must resolve to an existing file INSIDE the repo or the run — not escape via
      // ../ into the wider filesystem (security review: existsSync(resolve(repoRoot, '../../etc/passwd'))
      // both polluted provenance and leaked a file-existence oracle).
      const inRepo = resolve(repoRoot, ref);
      const inRun = resolve(runDir, ref);
      const confined = (base: string, abs: string) => abs === base || abs.startsWith(base + sep);
      const okRepo = confined(repoRoot, inRepo) && existsSync(inRepo);
      const okRun = confined(runDir, inRun) && existsSync(inRun);
      if (!okRepo && !okRun) {
        return invalid(`ref ${ref} must be a MSG id or a repo-relative path to an existing file.`, startedAt);
      }
    }
  }
  if (scanForSecrets(opts.entry).length > 0) {
    return invalid('entry matches a secret pattern; project memory goes into git and must be clean (docs/24 §4).', startedAt);
  }

  const project = readJsonState(join(teamRoot, 'project.json')).doc as { project_memory_path?: string };
  const memRel = project.project_memory_path ?? 'docs/team/MEMORY.md';
  const memPath = resolve(repoRoot, memRel);
  // Separator-safe + symlink-catching containment (the shared fence), not a raw startsWith
  // prefix test — "../repo-evil/M.md" satisfies startsWith(repoRoot) but escapes the repo.
  try {
    assertRealPathInside(repoRoot, memPath, 'project_memory_path');
  } catch {
    return invalid(`project_memory_path must resolve inside the repo: ${memRel}.`, startedAt);
  }
  if (memPath.startsWith(teamRoot + sep) || memPath === teamRoot) {
    return invalid(`project_memory_path must live outside .team/: ${memRel}.`, startedAt);
  }
  const ignored = (() => {
    try {
      execFileSync('git', ['-C', repoRoot, 'check-ignore', '-q', memRel], { stdio: 'ignore' });
      return true;
    } catch {
      return false;
    }
  })();
  if (ignored) return invalid(`${memRel} is gitignored; project memory must be git-tracked (docs/25 §3.1).`, startedAt);

  const tooOld = assertGatewayWritable(teamRoot);
  if (tooOld) return failEnvelope(tooOld.code, tooOld.message, { startedAt });
  const release = tryAcquireLock(join(teamRoot, 'locks', 'project.lock'));
  if (release instanceof GatewayError) return failEnvelope(release.code, release.message, { startedAt });

  try {
    let md = existsSync(memPath) ? readFileSync(memPath, 'utf8') : MANAGED_HEADER;
    const entryIds = [...md.matchAll(/^- \[(MEM-\d{4})\]/gm)].map((m) => m[1]);
    if (opts.supersedes && !entryIds.includes(opts.supersedes)) {
      return invalid(`supersedes target ${opts.supersedes} does not exist in ${memRel}.`, startedAt);
    }

    const countersFile = join(teamRoot, 'counters.json');
    const counters = readJsonState(countersFile);
    const cdoc = counters.doc as Record<string, unknown>;
    const n = Number(cdoc.next_mem ?? 1);
    const memId = `MEM-${String(n).padStart(4, '0')}`;
    const date = new Date().toISOString().slice(0, 10);
    const stamp = `  ⟨${opts.runId} · ${date} · refs: ${opts.refs.join(', ')}${opts.supersedes ? ` · supersedes ${opts.supersedes}` : ''}⟩`;
    const entryBlock = `- [${memId}] ${opts.entry.trim()}\n${stamp}`;

    if (opts.supersedes) {
      // move the superseded two-line block to the Superseded section, provenance intact
      const lines = md.split('\n');
      const idx = lines.findIndex((l) => l.startsWith(`- [${opts.supersedes}]`));
      if (idx >= 0) {
        const block = lines.splice(idx, lines[idx + 1]?.trim().startsWith('⟨') ? 2 : 1);
        md = lines.join('\n');
        if (!md.includes('## Superseded')) md = md.trimEnd() + '\n\n## Superseded\n';
        md = md.trimEnd() + '\n' + block.join('\n') + '\n';
      }
    }
    const sectionHeader = `## ${opts.section}`;
    if (!md.includes(sectionHeader)) md = md.trimEnd() + `\n\n${sectionHeader}\n`;
    const parts = md.split('\n');
    const headerIdx = parts.findIndex((l) => l.trim() === sectionHeader);
    let insertAt = parts.length;
    for (let i = headerIdx + 1; i < parts.length; i++) {
      if (parts[i]!.startsWith('## ')) {
        insertAt = i;
        break;
      }
    }
    while (insertAt > headerIdx + 1 && parts[insertAt - 1]!.trim() === '') insertAt--;
    parts.splice(insertAt, 0, entryBlock);
    md = parts.join('\n');
    if (!md.endsWith('\n')) md += '\n';

    mkdirSync(dirname(memPath), { recursive: true });
    const tmp = memPath + '.tmp';
    writeFileSync(tmp, md, 'utf8');
    renameSync(tmp, memPath);
    writeJsonStateAtomic(countersFile, { ...cdoc, next_mem: n + 1 }, { expectedRev: counters.rev });

    if (opts.supersedes) {
      appendEvent(runDir, {
        event: 'memory_superseded',
        actor: { type: 'user', id: 'user' },
        run_id: opts.runId,
        payload: { mem_id: opts.supersedes, superseded_by: memId },
      });
    }
    appendEvent(runDir, {
      event: 'memory_promoted',
      actor: { type: 'user', id: 'user' },
      run_id: opts.runId,
      payload: { mem_id: memId, refs: opts.refs, section: opts.section, ...(opts.supersedes ? { supersedes: opts.supersedes } : {}) },
    });

    return okEnvelope({
      message: `${memId} promoted to ${memRel} (${opts.section})${opts.supersedes ? `; ${opts.supersedes} superseded` : ''}. Commit it via your normal PR flow.`,
      data: { mem_id: memId, path: memRel, section: opts.section, supersedes: opts.supersedes ?? null },
      nextActions: [`Review and commit: git add ${memRel}`],
      startedAt,
    });
  } catch (err) {
    if (err instanceof GatewayError) return failEnvelope(err.code, err.message, { startedAt });
    throw err;
  } finally {
    release();
  }
}

/** Candidate discovery (docs/25 §4 step 1): list-only — decisions + heavyweight review findings. */
export function memoryCandidates(opts: CandidatesOptions): Envelope {
  const startedAt = Date.now();
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
  const candidates: Array<{ kind: string; ref: string; body: string; author_unverified?: boolean }> = [];
  const msgFile = join(runDir, 'context', 'messages.jsonl');
  if (existsSync(msgFile)) {
    for (const line of readFileSync(msgFile, 'utf8').split('\n')) {
      if (!line.trim()) continue;
      let m: { message_id: string; type: string; body: string; author_unverified?: boolean };
      try {
        m = JSON.parse(line) as typeof m;
      } catch {
        continue; // torn/corrupt line — skip (same discipline as readEventsSafe)
      }
      // A decision message may claim to be from the human; carry author_unverified through so the
      // human sees, before promoting into git-tracked memory, that the gateway did not verify it.
      if (m.type === 'decision') {
        candidates.push({ kind: 'decision', ref: m.message_id, body: m.body, ...(m.author_unverified ? { author_unverified: true } : {}) });
      }
    }
  }
  const reviewsDir = join(runDir, 'reviews');
  if (existsSync(reviewsDir)) {
    for (const task of readdirSync(reviewsDir)) {
      for (const rec of readdirSync(join(reviewsDir, task)).filter((f) => f.endsWith('.json'))) {
        const r = JSON.parse(readFileSync(join(reviewsDir, task, rec), 'utf8')) as {
          review_id: string;
          findings?: Array<{ severity?: string; must_fix?: boolean; message?: string }>;
        };
        for (const f of r.findings ?? []) {
          if (f.must_fix || f.severity === 'major' || f.severity === 'critical') {
            candidates.push({ kind: 'review_finding', ref: `reviews/${task}/${rec}`, body: f.message ?? '' });
          }
        }
      }
    }
  }
  return okEnvelope({
    message: `${candidates.length} promotion candidate(s) on ${opts.runId} — pick, phrase, and confirm; nothing is promoted automatically.`,
    data: { candidates },
    nextActions:
      candidates.length > 0
        ? [`Promote one: sigmarun memory promote ${opts.runId} --entry="…" --section=Architecture --from=<ref>`]
        : [],
    startedAt,
  });
}
