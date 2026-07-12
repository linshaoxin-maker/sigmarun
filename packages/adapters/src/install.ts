import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { GatewayError, resolveTeamRoot, type ResolveOptions } from '@sigmarun/storage';
import { failEnvelope, okEnvelope, type Envelope, type EnvelopeWarning } from '@sigmarun/core';
import { AGENTS_SECTION, TEMPLATES } from './templates.js';

export interface InstallOptions extends ResolveOptions {
  tool: string;
  update?: boolean;
}

/**
 * Copy adapter templates into the repo (docs/22 §installation, repo scope only in MVP).
 * Existing files are skipped with a warning unless `update` is set; the AGENTS.md
 * section is appended once between managed markers (idempotent).
 */
export function installAdapters(opts: InstallOptions): Envelope {
  const startedAt = Date.now();
  const files = TEMPLATES[opts.tool];
  if (!files) {
    return failEnvelope('usage_error', `Unknown tool "${opts.tool}". Supported: ${Object.keys(TEMPLATES).join(', ')}.`, { startedAt });
  }
  let repoRoot: string;
  try {
    repoRoot = resolveTeamRoot(opts).repoRoot;
  } catch (err) {
    const ge = err as GatewayError;
    return failEnvelope(ge.code, ge.message, { startedAt });
  }

  const written: string[] = [];
  const updated: string[] = [];
  const skipped: string[] = [];
  const warnings: EnvelopeWarning[] = [];
  const versionOf = (text: string): string | null => /template_version: ([\d.]+)/.exec(text)?.[1] ?? null;
  try {
   for (const [rel, content] of Object.entries(files)) {
    const target = join(repoRoot, rel);
    if (existsSync(target) && !opts.update) {
      // Managed files upgrade themselves when the shipped template_version differs
      // (docs/22 §4.3; smoke-round L21: exists-means-skip could never roll 0.1.0 forward).
      const current = versionOf(readFileSync(target, 'utf8'));
      const shipped = versionOf(content);
      if (current === shipped) {
        skipped.push(rel);
        continue;
      }
      mkdirSync(dirname(target), { recursive: true });
      writeFileSync(target, content, 'utf8');
      updated.push(`${rel} (${current ?? '?'} -> ${shipped ?? '?'})`);
      continue;
    }
    mkdirSync(dirname(target), { recursive: true });
    writeFileSync(target, content, 'utf8');
    written.push(rel);
   }
  } catch (err) {
    // An existing managed target that is now a directory or unreadable must not crash the CLI.
    return failEnvelope('io_error', `Cannot write adapter files under ${repoRoot}: ${err instanceof Error ? err.message : String(err)}`, { startedAt });
  }
  if (skipped.length > 0) {
    warnings.push({
      code: 'already_installed',
      message: `${skipped.length} template(s) already at this version and left untouched (use --update to force): ${skipped.join(', ')}.`,
    });
  }

  const agentsFile = join(repoRoot, 'AGENTS.md');
  const existing = existsSync(agentsFile) ? readFileSync(agentsFile, 'utf8') : '';
  if (!existing.includes('sigmarun:adapter-section:begin')) {
    const next = existing.length > 0 ? `${existing.trimEnd()}\n\n${AGENTS_SECTION}\n` : `# Agent rules\n\n${AGENTS_SECTION}\n`;
    writeFileSync(agentsFile, next, 'utf8');
    written.push('AGENTS.md');
  }

  return okEnvelope({
    message: `Installed ${opts.tool} adapter: ${written.length} new, ${updated.length} updated, ${skipped.length} up-to-date.`,
    data: { tool: opts.tool, written, updated, skipped },
    warnings,
    nextActions:
      opts.tool === 'claude-code'
        ? ['Open a Claude Code window in this repo and run /team-plan or /team-dispatch <RUN-ID>.']
        : ['Ask Codex to "join run <RUN-ID>" or type /team-dispatch <RUN-ID> to trigger the skill.'],
    startedAt,
  });
}
