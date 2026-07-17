import { describe, it, expect, afterEach } from 'vitest';
import { postMessage } from '@sigmarun/context';
import { cleanup } from '../../storage/test/helpers.js';
import { mkClaimRepo } from '../../dispatch/test/fixture.js';

// P1-6 (sibling emitter): msg post carries the SAME agent_not_registered wall with its own explicit
// nextActions, so it does not inherit the envelope default and kept the old label-framed guidance.
// Sync it to the returned-AGENT-ID protocol — but keep the existing `--from=user` human-posting hint.

let repo: string;
afterEach(() => cleanup(repo));

describe('P1-6: msg-post agent_not_registered guidance names the returned AGENT-ID (full runs)', () => {
  it('points the retry at the returned AGENT-ID (not the label) and preserves the --from=user hint', () => {
    repo = mkClaimRepo([{ key: 'a' }]); // full run
    const env = postMessage({ cwd: repo, runId: 'RUN-0001', fromAgentId: 'win-1', type: 'note', body: 'hi' });
    expect(env.ok).toBe(false);
    expect(env.code).toBe('agent_not_registered');
    const guidance = env.next_actions.join('\n');
    expect(guidance).toMatch(/AGENT-ID/i);            // the returned id identity
    expect(guidance).toMatch(/--from=<AGENT-ID>/);    // steer the retry at that id, via msg post's --from flag
    expect(guidance).toContain('Posting as the human? Use --from=user.'); // the correct old hint must survive
  });
});
