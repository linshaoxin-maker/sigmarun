import { describe, it, expect, afterEach, beforeEach } from 'vitest';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { installAdapters } from '@sigmarun/adapters';
import { mkTmpGitRepo, cleanup } from '../../storage/test/helpers.js';

let repo: string;
beforeEach(() => {
  repo = mkTmpGitRepo();
});
afterEach(() => cleanup(repo));

describe('adapter install (docs/19; docs/22 §installation; D12 sigmarun naming)', () => {
  it('claude-code: writes command templates with version header, RULES block, sigmarun commands', () => {
    const env = installAdapters({ cwd: repo, tool: 'claude-code' });
    expect(env.ok).toBe(true);
    for (const f of ['team-plan.md', 'team-dispatch.md', 'team-publish.md']) {
      expect(existsSync(join(repo, '.claude', 'commands', f))).toBe(true);
    }
    const dispatch = readFileSync(join(repo, '.claude', 'commands', 'team-dispatch.md'), 'utf8');
    expect(dispatch).toContain('template_version:');
    expect(dispatch).toContain('RULES (protocol-critical, non-negotiable)');
    expect(dispatch).toContain('sigmarun claim-next');
    expect(dispatch).toContain('--loop');
    expect(dispatch).not.toMatch(/`team (run|claim|submit)/);
  });

  it('appends the AGENTS section once, idempotently (markers)', () => {
    installAdapters({ cwd: repo, tool: 'claude-code' });
    installAdapters({ cwd: repo, tool: 'claude-code' });
    const agents = readFileSync(join(repo, 'AGENTS.md'), 'utf8');
    expect((agents.match(/sigmarun:adapter-section/g) ?? []).length).toBe(2); // begin + end marker, once
    expect(agents).toContain('Team Run Protocol (.team/)');
  });

  it('re-install skips existing files with a warning; --update overwrites', () => {
    installAdapters({ cwd: repo, tool: 'claude-code' });
    const again = installAdapters({ cwd: repo, tool: 'claude-code' });
    expect(again.warnings.some((w) => w.code === 'already_installed')).toBe(true);
    const updated = installAdapters({ cwd: repo, tool: 'claude-code', update: true });
    expect(updated.warnings.length).toBe(0);
    expect((updated.data as { written: string[] }).written.length).toBeGreaterThan(0);
  });

  it('codex: writes skills under the OFFICIAL .agents/skills tree, never .codex/skills (P0-3)', () => {
    // OpenAI Codex only scans .agents/skills (repo), ~/.agents/skills (user), /etc/codex/skills —
    // NOT .codex/skills (developers.openai.com/codex/skills). Install the single official source only.
    const env = installAdapters({ cwd: repo, tool: 'codex' });
    expect(env.ok).toBe(true);
    const skill = readFileSync(join(repo, '.agents', 'skills', 'team-run-dispatch', 'SKILL.md'), 'utf8');
    expect(skill).toContain('name: team-run-dispatch');
    expect(skill).toContain('sigmarun claim-next');
    expect(existsSync(join(repo, 'AGENTS.md'))).toBe(true);
    // No double-install: the wrong .codex/skills tree must not be created at all.
    expect(existsSync(join(repo, '.codex', 'skills'))).toBe(false);
    // Cross-references inside the pack must point at the official tree too.
    const doSkill = readFileSync(join(repo, '.agents', 'skills', 'team-run-do', 'SKILL.md'), 'utf8');
    expect(doSkill).toContain('.agents/skills/team-run-dispatch/SKILL.md');
    expect(doSkill).not.toContain('.codex/skills');
  });

  it('dispatch flow warns that isolated worktrees lack node_modules and must bootstrap deps (P1-5)', () => {
    // A `git worktree add` copies only tracked files; node_modules is gitignored, so dependency-backed
    // checks (vitest/tsc) ERR_MODULE_NOT_FOUND in a fresh worktree unless deps are installed/symlinked.
    installAdapters({ cwd: repo, tool: 'all' });
    const claudeDispatch = readFileSync(join(repo, '.claude', 'commands', 'team-dispatch.md'), 'utf8');
    const codexDispatch = readFileSync(join(repo, '.agents', 'skills', 'team-run-dispatch', 'SKILL.md'), 'utf8');
    for (const dispatch of [claudeDispatch, codexDispatch]) {
      expect(dispatch).toContain('node_modules');
      expect(dispatch).toMatch(/ERR_MODULE_NOT_FOUND/);
      expect(dispatch).toMatch(/npm install|pnpm install/);
    }
  });

  it('unknown tool is a usage error', () => {
    const env = installAdapters({ cwd: repo, tool: 'cursor' });
    expect(env.ok).toBe(false);
    expect(env.code).toBe('usage_error');
  });
});

describe('smoke-round L21: managed templates roll forward by version', () => {
  it('re-install rewrites files whose template_version differs and reports them as updated', async () => {
    const { installAdapters: installAdapter } = await import('@sigmarun/adapters');
    const { mkTmpGitRepo, cleanup } = await import('../../storage/test/helpers.js');
    const { readFileSync, writeFileSync } = await import('node:fs');
    const { join } = await import('node:path');
    const repo = mkTmpGitRepo();
    try {
      installAdapter({ cwd: repo, tool: 'claude-code' });
      const file = join(repo, '.claude', 'commands', 'team-dispatch.md');
      const downgraded = readFileSync(file, 'utf8').replace(/template_version: [\d.]+/, 'template_version: 0.0.1');
      writeFileSync(file, downgraded);
      const env = installAdapter({ cwd: repo, tool: 'claude-code' });
      expect(env.ok).toBe(true);
      const data = env.data as { updated: string[]; skipped: string[] };
      expect(data.updated.some((u) => u.includes('team-dispatch.md'))).toBe(true);
      expect(readFileSync(file, 'utf8')).not.toContain('template_version: 0.0.1');
      // unchanged files stay skipped
      expect(data.skipped.length).toBeGreaterThan(0);
    } finally {
      cleanup(repo);
    }
  });
});

describe('OSS review: hand-edited (marker-less) templates are preserved, not silently overwritten', () => {
  it('a file whose template_version marker was removed is left untouched with a warning', () => {
    const repo = mkTmpGitRepo();
    try {
      installAdapters({ cwd: repo, tool: 'claude-code' });
      const file = join(repo, '.claude', 'commands', 'team-dispatch.md');
      const edited = readFileSync(file, 'utf8').replace(/<!-- template_version:[^>]*-->/, '<!-- (hand-edited, marker removed) -->') + '\nMY LOCAL EDIT\n';
      writeFileSync(file, edited);
      const env = installAdapters({ cwd: repo, tool: 'claude-code' });
      expect(env.ok).toBe(true);
      expect(env.warnings.map((w) => w.code)).toContain('unmanaged_template');
      expect(readFileSync(file, 'utf8')).toContain('MY LOCAL EDIT'); // not clobbered
      const data = env.data as { updated: string[]; skipped: string[] };
      expect(data.skipped.some((s) => s.includes('team-dispatch.md'))).toBe(true);
    } finally {
      cleanup(repo);
    }
  });
});
