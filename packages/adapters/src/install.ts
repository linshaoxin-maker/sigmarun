import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { GatewayError, resolveTeamRoot, type ResolveOptions } from '@sigmarun/storage';
import { failEnvelope, okEnvelope, type Envelope, type EnvelopeWarning } from '@sigmarun/core';
import { AGENTS_SECTION, TEMPLATES } from './templates.js';

export interface InstallOptions extends ResolveOptions {
  /** One tool ("claude-code"), several comma-separated ("claude-code,codex"), or "all". */
  tool: string;
  update?: boolean;
}

const versionOf = (text: string): string | null => /template_version: ([\d.]+)/.exec(text)?.[1] ?? null;

interface FileResult {
  written: string[];
  updated: string[];
  skipped: string[];
  warnings: EnvelopeWarning[];
}

/** Write one tool's templates into repoRoot, honoring the version-marker upgrade rules. */
function installOne(repoRoot: string, files: Record<string, string>, update: boolean): FileResult {
  const written: string[] = [];
  const updated: string[] = [];
  const skipped: string[] = [];
  const warnings: EnvelopeWarning[] = [];
  for (const [rel, content] of Object.entries(files)) {
    const target = join(repoRoot, rel);
    if (existsSync(target) && !update) {
      // Managed files upgrade themselves when the shipped template_version differs
      // (docs/22 §4.3; smoke-round L21: exists-means-skip could never roll 0.1.0 forward).
      const current = versionOf(readFileSync(target, 'utf8'));
      const shipped = versionOf(content);
      if (current === shipped) {
        skipped.push(rel);
        continue;
      }
      if (current === null) {
        // The on-disk file carries no managed version marker — it was hand-edited or is not ours.
        // Overwriting would silently destroy the user's edits; leave it and warn (use --update to force).
        skipped.push(rel);
        warnings.push({ code: 'unmanaged_template', message: `${rel} has no template_version marker (hand-edited?) — left untouched. Pass --update to overwrite with the shipped template.` });
        continue;
      }
      mkdirSync(dirname(target), { recursive: true });
      writeFileSync(target, content, 'utf8');
      updated.push(`${rel} (${current} -> ${shipped ?? '?'})`);
      continue;
    }
    mkdirSync(dirname(target), { recursive: true });
    writeFileSync(target, content, 'utf8');
    written.push(rel);
  }
  return { written, updated, skipped, warnings };
}

/**
 * Copy adapter templates into the repo (docs/22 §installation, repo scope only in MVP).
 * `tool` may name one tool, several ("claude-code,codex"), or "all" — a machine with both
 * Claude Code and Codex should not have to run install twice. Existing files are skipped with
 * a warning unless `update` is set; the AGENTS.md section is tool-agnostic and appended once.
 */
export function installAdapters(opts: InstallOptions): Envelope {
  const startedAt = Date.now();
  const supported = Object.keys(TEMPLATES);
  const requested =
    opts.tool.trim() === 'all' ? supported : opts.tool.split(',').map((t) => t.trim()).filter(Boolean);
  const unknown = requested.filter((t) => !TEMPLATES[t]);
  if (requested.length === 0 || unknown.length > 0) {
    const bad = unknown.length > 0 ? unknown.join(', ') : opts.tool;
    return failEnvelope('usage_error', `Unknown tool "${bad}". Supported: ${supported.join(', ')}, or "all".`, { startedAt });
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
  try {
    for (const tool of requested) {
      const files = TEMPLATES[tool];
      if (!files) continue; // unreachable: validated against TEMPLATES above; guards the index type
      const r = installOne(repoRoot, files, opts.update ?? false);
      written.push(...r.written);
      updated.push(...r.updated);
      skipped.push(...r.skipped);
      warnings.push(...r.warnings);
    }
  } catch (err) {
    // An existing managed target that is now a directory or unreadable must not crash the CLI.
    return failEnvelope('io_error', `Cannot write adapter files under ${repoRoot}: ${err instanceof Error ? err.message : String(err)}`, { startedAt });
  }
  if (skipped.length > 0) {
    warnings.push({
      code: 'already_installed',
      message: `${skipped.length} template(s) already at this version and left untouched (use --update to force).`,
    });
  }

  // The AGENTS.md protocol section is the same regardless of tool — write it once, idempotently.
  const agentsFile = join(repoRoot, 'AGENTS.md');
  const existing = existsSync(agentsFile) ? readFileSync(agentsFile, 'utf8') : '';
  if (!existing.includes('sigmarun:adapter-section:begin')) {
    const next = existing.length > 0 ? `${existing.trimEnd()}\n\n${AGENTS_SECTION}\n` : `# Agent rules\n\n${AGENTS_SECTION}\n`;
    writeFileSync(agentsFile, next, 'utf8');
    written.push('AGENTS.md');
  }

  const multi = requested.length > 1;
  const bothNext = 'Open a Claude Code or Codex window in this repo and run /team-plan or /team-dispatch <RUN-ID>.';
  const claudeNext = 'Open a Claude Code window in this repo and run /team-plan or /team-dispatch <RUN-ID>.';
  const codexNext = 'Ask Codex to "join run <RUN-ID>" or type /team-dispatch <RUN-ID> to trigger the skill.';
  return okEnvelope({
    message: `Installed ${requested.join(' + ')} adapter${multi ? 's' : ''}: ${written.length} new, ${updated.length} updated, ${skipped.length} up-to-date.`,
    data: { tool: opts.tool, tools: requested, written, updated, skipped },
    warnings,
    nextActions: multi ? [bothNext] : requested[0] === 'claude-code' ? [claudeNext] : [codexNext],
    startedAt,
  });
}

/**
 * The adapter template generation currently installed in `repoRoot`, or null if no managed adapter
 * file is present. Reads the same `template_version:` marker `installOne` writes; returns the first
 * one found across every tool's files. The CLI version face compares this against the bundled
 * TEMPLATE_VERSION so "which generation is installed / did my upgrade take effect" is answerable.
 */
export function installedTemplateVersion(repoRoot: string): string | null {
  for (const files of Object.values(TEMPLATES)) {
    for (const rel of Object.keys(files)) {
      const target = join(repoRoot, rel);
      if (existsSync(target)) {
        const v = versionOf(readFileSync(target, 'utf8'));
        if (v) return v;
      }
    }
  }
  return null;
}
