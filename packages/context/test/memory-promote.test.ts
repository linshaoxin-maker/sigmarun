import { describe, it, expect, afterEach, beforeEach } from 'vitest';
import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { promoteMemory, memoryCandidates, postMessage } from '@sigmarun/context';
import { auditRun } from '@sigmarun/audit';
import { statusRun } from '@sigmarun/watch';
import { cleanup } from '../../storage/test/helpers.js';
import { mkClaimRepo, registerDefault } from '../../dispatch/test/fixture.js';

let repo: string;
let agent: string;
beforeEach(() => {
  repo = mkClaimRepo([{ key: 'a' }]);
  agent = registerDefault(repo);
  postMessage({ cwd: repo, runId: 'RUN-0001', fromAgentId: agent, type: 'decision', body: 'Session expiry is 7-day sliding.' });
});
afterEach(() => cleanup(repo));

const memFile = () => join(repo, 'docs', 'team', 'MEMORY.md');
const events = () =>
  readFileSync(join(repo, '.team', 'runs', 'RUN-0001', 'events.jsonl'), 'utf8').trim().split('\n').map((l) => JSON.parse(l));

describe('memory promote (25 §4; BDD-009-01/02/06; INV-012 project level)', () => {
  it('promotes a decision with MEM id, provenance stamp, and memory_promoted event', () => {
    const env = promoteMemory({
      cwd: repo, runId: 'RUN-0001', entry: 'Session expiry is 7-day sliding.',
      section: 'Architecture', refs: ['MSG-0001'],
    });
    expect(env.ok).toBe(true);
    expect((env.data as { mem_id: string }).mem_id).toBe('MEM-0001');
    const md = readFileSync(memFile(), 'utf8');
    expect(md).toContain('# Project Memory');
    expect(md).toContain('[MEM-0001] Session expiry is 7-day sliding.');
    expect(md).toMatch(/⟨RUN-0001 · \d{4}-\d{2}-\d{2} · refs: MSG-0001⟩/);
    expect(md.indexOf('[MEM-0001]')).toBeGreaterThan(md.indexOf('## Architecture'));
    expect(events().some((e) => e.event === 'memory_promoted' && e.payload.mem_id === 'MEM-0001')).toBe(true);

    const second = promoteMemory({
      cwd: repo, runId: 'RUN-0001', entry: 'Never import src/users directly.',
      section: 'Constraints', refs: ['MSG-0001'],
    });
    expect((second.data as { mem_id: string }).mem_id).toBe('MEM-0002');
  });

  it('rejects entries without refs, with dangling refs, or with secrets (memory_entry_invalid)', () => {
    const noRefs = promoteMemory({ cwd: repo, runId: 'RUN-0001', entry: 'x.', section: 'Architecture', refs: [] });
    expect(noRefs.code).toBe('memory_entry_invalid');
    const dangling = promoteMemory({ cwd: repo, runId: 'RUN-0001', entry: 'x.', section: 'Architecture', refs: ['MSG-9999'] });
    expect(dangling.code).toBe('memory_entry_invalid');
    const secret = promoteMemory({
      cwd: repo, runId: 'RUN-0001', section: 'Architecture', refs: ['MSG-0001'],
      entry: 'token is ghp_0123456789abcdef0123456789abcdef0123.',
    });
    expect(secret.code).toBe('memory_entry_invalid');
    const badSection = promoteMemory({ cwd: repo, runId: 'RUN-0001', entry: 'x.', section: 'Random', refs: ['MSG-0001'] });
    expect(badSection.code).toBe('memory_entry_invalid');
    expect(existsSync(memFile())).toBe(false); // zero writes on rejection
  });

  it('supersedes moves the old entry to Superseded and records both events (BDD-009-06)', () => {
    promoteMemory({ cwd: repo, runId: 'RUN-0001', entry: 'Expiry is absolute 24h.', section: 'Architecture', refs: ['MSG-0001'] });
    const env = promoteMemory({
      cwd: repo, runId: 'RUN-0001', entry: 'Expiry is 7-day sliding.', section: 'Architecture',
      refs: ['MSG-0001'], supersedes: 'MEM-0001',
    });
    expect(env.ok).toBe(true);
    const md = readFileSync(memFile(), 'utf8');
    expect(md).toContain('## Superseded');
    const supersededIdx = md.indexOf('## Superseded');
    expect(md.indexOf('[MEM-0001]')).toBeGreaterThan(supersededIdx); // old moved below
    expect(md).toContain('supersedes MEM-0001');
    expect(events().some((e) => e.event === 'memory_superseded' && e.payload.mem_id === 'MEM-0001')).toBe(true);

    const dangling = promoteMemory({
      cwd: repo, runId: 'RUN-0001', entry: 'y.', section: 'Architecture', refs: ['MSG-0001'], supersedes: 'MEM-0099',
    });
    expect(dangling.code).toBe('memory_entry_invalid');
  });

  it('refuses a gitignored memory target', () => {
    writeFileSync(join(repo, '.gitignore'), '.team/\ndocs/team/\n');
    const env = promoteMemory({ cwd: repo, runId: 'RUN-0001', entry: 'x.', section: 'Architecture', refs: ['MSG-0001'] });
    expect(env.code).toBe('memory_entry_invalid');
  });

  it('memory candidates lists decision messages (25 §4 discovery, list-only)', () => {
    const env = memoryCandidates({ cwd: repo, runId: 'RUN-0001' });
    expect(env.ok).toBe(true);
    const cands = (env.data as { candidates: Array<{ kind: string; body: string }> }).candidates;
    expect(cands.some((c) => c.kind === 'decision' && c.body.includes('7-day sliding'))).toBe(true);
  });
});

describe('memory audit batch + size discipline (AUD-036…040; BDD-009-05)', () => {
  it('AUD-036/038: hand-edited entry without stamp and dangling supersedes are errors', () => {
    promoteMemory({ cwd: repo, runId: 'RUN-0001', entry: 'good entry.', section: 'Architecture', refs: ['MSG-0001'] });
    let md = readFileSync(memFile(), 'utf8');
    md += '\n- [MEM-0099] hand-added claim with no provenance.\n';
    md = md.replace('refs: MSG-0001⟩', 'refs: MSG-0001 · supersedes MEM-0777⟩');
    writeFileSync(memFile(), md);
    const env = auditRun({ cwd: repo, runId: 'RUN-0001' });
    const rules = (env.data as { findings: Array<{ rule_id: string; severity: string }> }).findings;
    expect(rules.some((f) => f.rule_id === 'AUD-036' && f.severity === 'error')).toBe(true);
    expect(rules.some((f) => f.rule_id === 'AUD-038' && f.severity === 'error')).toBe(true);
    const skipped = (env.data as { rules_skipped: Array<{ rule_id: string }> }).rules_skipped;
    expect(skipped.some((s) => s.rule_id.startsWith('AUD-036'))).toBe(false); // no longer skipped
  });

  it('AUD-037 + status risk: oversize memory warns without blocking (BDD-009-05)', () => {
    promoteMemory({ cwd: repo, runId: 'RUN-0001', entry: 'seed.', section: 'Architecture', refs: ['MSG-0001'] });
    const pad = readFileSync(memFile(), 'utf8') + Array.from({ length: 210 }, (_, i) => `- filler line ${i}`).join('\n');
    writeFileSync(memFile(), pad);
    const audit = auditRun({ cwd: repo, runId: 'RUN-0001' });
    expect((audit.data as { findings: Array<{ rule_id: string; severity: string }> }).findings.some((f) => f.rule_id === 'AUD-037' && f.severity === 'warn')).toBe(true);
    const status = statusRun({ cwd: repo, runId: 'RUN-0001' });
    expect((status.data as { risks: Array<{ kind: string }> }).risks.some((r) => r.kind === 'memory_oversize')).toBe(true);
  });

  it('AUD-040: an agent holding more active claims than the cap is detected', async () => {
    const { readJsonState, writeJsonStateAtomic } = await import('@sigmarun/storage');
    const { claimNext } = await import('@sigmarun/dispatch');
    claimNext({ cwd: repo, runId: 'RUN-0001', agentId: agent });
    const file = join(repo, '.team', 'runs', 'RUN-0001', 'claims', 'task-claims.json');
    const { doc, rev } = readJsonState(file);
    const claims = (doc as { claims: Array<Record<string, unknown>> }).claims;
    claims.push({ ...claims[0], claim_id: 'CLAIM-task-9998', task_id: 'TASK-0099' });
    writeJsonStateAtomic(file, doc, { expectedRev: rev });
    const env = auditRun({ cwd: repo, runId: 'RUN-0001' });
    expect((env.data as { findings: Array<{ rule_id: string }> }).findings.some((f) => f.rule_id === 'AUD-040')).toBe(true);
  });
});

describe('OSS security review: memory-promote ref cannot escape the repo (existence oracle)', () => {
  it('rejects a ../ path ref instead of accepting it as a resolvable file', () => {
    const repo = mkClaimRepo([{ key: 'a' }]);
    try {
      postMessage({ cwd: repo, runId: 'RUN-0001', fromAgentId: registerDefault(repo, 'w'), type: 'decision', body: 'D.' });
      const env = promoteMemory({
        cwd: repo, runId: 'RUN-0001', entry: 'Escapes the repo.',
        section: 'Architecture', refs: ['../../../../../../etc/passwd'],
      });
      expect(env.ok).toBe(false);
      expect(env.code).toBe('memory_entry_invalid');
      expect(env.message).toMatch(/MSG id or a repo-relative path/);
    } finally {
      cleanup(repo);
    }
  });
});
