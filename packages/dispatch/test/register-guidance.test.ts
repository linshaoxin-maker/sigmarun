import { describe, it, expect, afterEach } from 'vitest';
import { join } from 'node:path';
import { claimNext, registerAgent, verifySubmit } from '@sigmarun/dispatch';
import { cleanup } from '../../storage/test/helpers.js';
import { mkClaimRepo } from './fixture.js';

// P1-6: on a FULL (non-lightweight) run, a window that claims with its own self-made label hits
// `agent_not_registered`. The remediation told it to `register ... --label=<window>`, which reads as
// "your window label is your identity" — but register MINTS a fresh AGENT-<tool>-NNN id, and claim
// only works with THAT id. A window that trusts the error guidance (not register's own output)
// re-runs claim-next with its label and loops. The guidance must name the returned AGENT-ID.
// This is a wording contract, not a behavior change: full runs still do not self-register.

let repo: string;
afterEach(() => cleanup(repo));

describe('P1-6: agent_not_registered guidance points at the returned AGENT-ID (full runs)', () => {
  it('claim-next guidance tells the window register returns an AGENT-ID to claim with (not the label)', () => {
    repo = mkClaimRepo([{ key: 'a' }]); // feature mode -> full run, not lightweight
    const env = claimNext({ cwd: repo, runId: 'RUN-0001', agentId: 'win-1' });
    expect(env.ok).toBe(false);
    expect(env.code).toBe('agent_not_registered');
    const guidance = env.next_actions.join('\n');
    // The remediation must surface the returned AGENT-ID identity...
    expect(guidance).toMatch(/AGENT-ID/i);
    // ...and steer the next claim-next at that id rather than the window label.
    expect(guidance).toMatch(/claim-next[^\n]*--agent=/i);
  });

  it('protocol reproduction: register mints a NEW id (not the label); the label keeps bouncing; the returned id claims', () => {
    repo = mkClaimRepo([{ key: 'a' }]);
    // A: the window's own label bounces on a full run.
    expect(claimNext({ cwd: repo, runId: 'RUN-0001', agentId: 'win-1' }).code).toBe('agent_not_registered');
    // B: register with that label returns a generated AGENT-<tool>-NNN id, NOT 'win-1'.
    const reg = registerAgent({ cwd: repo, runId: 'RUN-0001', tool: 'claude', role: 'implementer', label: 'win-1' });
    const agentId = (reg.data as { agent_id: string }).agent_id;
    expect(agentId).not.toBe('win-1');
    expect(agentId).toMatch(/^AGENT-claude-\d{3}$/);
    // C: naively re-using the label STILL bounces (the trap the guidance must warn about).
    expect(claimNext({ cwd: repo, runId: 'RUN-0001', agentId: 'win-1' }).code).toBe('agent_not_registered');
    // D: claiming with the RETURNED id succeeds.
    expect(claimNext({ cwd: repo, runId: 'RUN-0001', agentId }).ok).toBe(true);
    // register's own success guidance already names the right id — the escape hatch users must be pointed to.
    expect(reg.next_actions.join('\n')).toContain(`--agent=${agentId}`);
  });
});

// P1-6 (sibling emitter): verify submit carries the SAME agent_not_registered wall with its own
// explicit nextActions, so it does not inherit the envelope default and kept the old label-framed
// guidance. Sync it to the returned-AGENT-ID protocol.
describe('P1-6: verify-submit agent_not_registered guidance names the returned AGENT-ID (full runs)', () => {
  it('verify submit guidance surfaces the returned AGENT-ID to act with, not the window label', () => {
    repo = mkClaimRepo([{ key: 'a' }]); // full run
    const env = verifySubmit({ cwd: repo, runId: 'RUN-0001', agentId: 'win-1', verifyPath: join(repo, 'no-such-verify.json') });
    expect(env.ok).toBe(false);
    expect(env.code).toBe('agent_not_registered');
    const guidance = env.next_actions.join('\n');
    expect(guidance).toMatch(/AGENT-ID/i);
    expect(guidance).toMatch(/--agent=<AGENT-ID>/);
  });
});
