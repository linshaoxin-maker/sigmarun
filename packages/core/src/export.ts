import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import { GatewayError, resolveTeamRoot, scanForSecrets, type ResolveOptions } from '@sigmarun/storage';
import { failEnvelope, okEnvelope, type Envelope } from './envelope.js';

export interface ExportOptions extends ResolveOptions {
  runId: string;
  to?: string;
  full?: boolean;
  force?: boolean;
}

interface OutFile {
  rel: string;
  content: string | Buffer;
}

function collectFiles(runDir: string, full: boolean): OutFile[] {
  const out: OutFile[] = [];
  const addText = (rel: string) => {
    const f = join(runDir, rel);
    if (existsSync(f)) out.push({ rel, content: readFileSync(f, 'utf8') });
  };
  for (const rel of ['plan.md', 'report.md', 'integration.md', 'context/run-memory.md']) addText(rel);

  const evDir = join(runDir, 'evidence');
  if (existsSync(evDir)) {
    for (const task of readdirSync(evDir).sort()) {
      addText(`evidence/${task}/evidence.md`);
      if (full) {
        addText(`evidence/${task}/evidence.json`);
        const outputs = join(evDir, task, 'outputs');
        if (existsSync(outputs)) {
          for (const o of readdirSync(outputs).sort()) addText(`evidence/${task}/outputs/${o}`);
        }
      }
    }
  }

  const reviewsDir = join(runDir, 'reviews');
  if (existsSync(reviewsDir)) {
    for (const task of readdirSync(reviewsDir).sort()) {
      for (const rec of readdirSync(join(reviewsDir, task)).filter((f) => f.endsWith('.json')).sort()) {
        const record = JSON.parse(readFileSync(join(reviewsDir, task, rec), 'utf8')) as {
          review_id: string;
          decision: string;
          round: number;
          reviewer_agent_id: string | null;
          findings: Array<{ severity?: string; message?: string; must_fix?: boolean }>;
        };
        const md = [
          `# ${record.review_id}`,
          '',
          `Decision: ${record.decision} · round ${record.round} · reviewer ${record.reviewer_agent_id ?? '(policy)'}`,
          '',
          ...(record.findings.length > 0
            ? record.findings.map((f) => `- [${f.severity ?? 'note'}${f.must_fix ? ', must_fix' : ''}] ${f.message ?? ''}`)
            : ['No findings.']),
          '',
        ].join('\n');
        out.push({ rel: `reviews/${task}/${record.review_id}.md`, content: md });
      }
    }
  }

  const verDir = join(runDir, 'verification');
  if (existsSync(verDir)) {
    const lines: string[] = ['# Verification index', ''];
    for (const rec of readdirSync(verDir).filter((f) => f.endsWith('.json')).sort()) {
      const v = JSON.parse(readFileSync(join(verDir, rec), 'utf8')) as {
        verify_id: string;
        verdict: string;
        target: { kind: string; task_id?: string };
      };
      lines.push(`- ${v.verify_id}: ${v.verdict} (${v.target.kind}${v.target.task_id ? ` ${v.target.task_id}` : ''})`);
    }
    out.push({ rel: 'verification.md', content: lines.join('\n') + '\n' });
  }

  if (full) {
    addText('events.jsonl');
    addText('task-graph.json');
  }
  return out;
}

/** Archive a run into git-committable docs (16 §7): blocking redaction rescan, user commits themselves. */
export function exportRun(opts: ExportOptions): Envelope {
  const startedAt = Date.now();
  let repoRoot: string;
  let teamRoot: string;
  try {
    const resolved = resolveTeamRoot(opts);
    repoRoot = resolved.repoRoot;
    teamRoot = resolved.teamRoot;
  } catch (err) {
    const ge = err as GatewayError;
    return failEnvelope(ge.code, ge.message, { startedAt });
  }
  const runDir = join(teamRoot, 'runs', opts.runId);
  if (!existsSync(join(runDir, 'run.json'))) {
    return failEnvelope('run_not_found', `Run ${opts.runId} does not exist under .team/runs/.`, { startedAt });
  }

  const targetRel = opts.to ?? `docs/team-runs/${opts.runId}`;
  const target = resolve(repoRoot, targetRel);
  if (!target.startsWith(repoRoot + '/') && target !== repoRoot) {
    return failEnvelope('export_target_invalid', `Target must live inside the repository: ${targetRel}.`, { startedAt });
  }
  if (target.startsWith(teamRoot)) {
    return failEnvelope('export_target_invalid', 'Target must not be inside .team/ (the export exists to leave it).', { startedAt });
  }
  const ignored = (() => {
    try {
      execFileSync('git', ['-C', repoRoot, 'check-ignore', '-q', relative(repoRoot, target)], { stdio: 'ignore' });
      return true;
    } catch {
      return false;
    }
  })();
  if (ignored) {
    return failEnvelope('export_target_invalid', `Target ${targetRel} is covered by .gitignore; the archive must be committable.`, {
      startedAt,
    });
  }
  if (existsSync(target) && !opts.force) {
    return failEnvelope('export_target_invalid', `Target ${targetRel} already exists; pass --force to overwrite.`, { startedAt });
  }

  const files = collectFiles(runDir, opts.full ?? false);
  if (files.length === 0) {
    return failEnvelope('export_target_invalid', `Run ${opts.runId} has nothing exportable yet.`, { startedAt });
  }

  // Blocking rescan (NFR-004): the archive goes into git — a single hit aborts everything.
  const hits: Array<{ file: string; kinds: string[] }> = [];
  for (const f of files) {
    const text = typeof f.content === 'string' ? f.content : f.content.toString('utf8');
    const found = scanForSecrets(text);
    if (found.length > 0) hits.push({ file: f.rel, kinds: found.map((h) => h.kind) });
  }
  if (hits.length > 0) {
    return failEnvelope('export_redaction_hit', `Export aborted: ${hits.length} file(s) still match secret patterns.`, {
      data: { hits },
      nextActions: ['Clean the listed files inside .team/ (they should already be redacted), then re-run export.'],
      startedAt,
    });
  }

  let totalBytes = 0;
  for (const f of files) {
    const dest = join(target, f.rel);
    mkdirSync(dirname(dest), { recursive: true });
    writeFileSync(dest, f.content);
    totalBytes += Buffer.byteLength(typeof f.content === 'string' ? f.content : f.content);
  }
  return okEnvelope({
    message: `Exported ${files.length} file(s) (${totalBytes} bytes) to ${targetRel}. Review, then commit yourself.`,
    data: { target: targetRel, files: files.map((f) => f.rel), total_bytes: totalBytes },
    nextActions: [`Review the archive, then: git add ${targetRel} && git commit`],
    startedAt,
  });
}
