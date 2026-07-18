import { describe, it, expect } from 'vitest';
import { submitEvidence } from '@sigmarun/core';
import { cleanup } from '../../storage/test/helpers.js';
import { mkClaimRepo, registerDefault, setupWorking } from '../../dispatch/test/fixture.js';
import { validDraft } from './submit-fixture.js';

// P0-4: docs/14 §2.1 was the ONLY complete evidence example and it showed the OUTPUT field
// names (commands[].output_ref, top-level handoff_ref) — what the gateway *writes* to the stored
// record. But the submit gateway *reads* the INPUT draft fields (commands[].output_file, and
// handoff / handoff_file). An agent copying the doc verbatim always hit evidence_invalid, and the
// error blamed "raw output file missing / path resolution" or "handoff content is required" —
// never the field name — so a fix-by-error agent looped on paths forever.
// Contract now: the evidence_invalid error must NAME the correct draft field (and call out the
// mistaken output_ref/handoff_ref) so a single read fixes it.

const errorsOf = (env: { data: unknown }) => (env.data as { errors: string[] }).errors.join('\n');

describe('submit — evidence draft field names survive a verbatim docs/14 §2.1 copy (P0-4)', () => {
  it('a required-check command with output_file (correct draft field) submits successfully', async () => {
    const repo = mkClaimRepo([{ key: 'b', checks: ['npm test -- b'] }]);
    try {
      const agent = registerDefault(repo);
      await setupWorking(repo, agent, 'TASK-0001', 'task-b');
      const env = submitEvidence({
        cwd: repo, runId: 'RUN-0001', taskId: 'TASK-0001', agentId: agent,
        evidencePath: validDraft(repo, {
          acceptance: [{ item: 'b done.', status: 'met' }],
          required_checks_results: [{ check: 'npm test -- b', cmd_ref: 'cmd-01', status: 'pass' }],
        }),
      });
      expect(env.ok).toBe(true);
    } finally {
      cleanup(repo);
    }
  });

  it('output_ref instead of output_file: the error names commands[].output_file and calls out output_ref', async () => {
    const repo = mkClaimRepo([{ key: 'b', checks: ['npm test -- b'] }]);
    try {
      const agent = registerDefault(repo);
      await setupWorking(repo, agent, 'TASK-0001', 'task-b');
      // Verbatim docs/14 §2.1 copy: the command carries output_ref (not output_file).
      const draft = validDraft(repo, {
        acceptance: [{ item: 'b done.', status: 'met' }],
        commands: [{ cmd_id: 'cmd-01', cmd: 'npm test -- b', exit_code: 0, output_ref: 'outputs/check-01.log' }],
        required_checks_results: [{ check: 'npm test -- b', cmd_ref: 'cmd-01', status: 'pass' }],
      });
      const env = submitEvidence({ cwd: repo, runId: 'RUN-0001', taskId: 'TASK-0001', agentId: agent, evidencePath: draft });
      expect(env.ok).toBe(false);
      expect(env.code).toBe('evidence_invalid');
      const blob = errorsOf(env);
      expect(blob).toContain('output_file'); // names the field to use
      expect(blob).toContain('output_ref');  // calls out the field they mistakenly copied
    } finally {
      cleanup(repo);
    }
  });

  it('handoff_ref instead of handoff: the error names handoff/handoff_file and calls out handoff_ref', async () => {
    const repo = mkClaimRepo([{ key: 'a' }]);
    try {
      const agent = registerDefault(repo);
      await setupWorking(repo, agent);
      // Verbatim docs/14 §2.1 copy: top-level handoff_ref, no handoff / handoff_file.
      const draft = validDraft(repo, { handoff: '', handoff_ref: 'context/tasks/TASK-0001.md' });
      const env = submitEvidence({ cwd: repo, runId: 'RUN-0001', taskId: 'TASK-0001', agentId: agent, evidencePath: draft });
      expect(env.ok).toBe(false);
      expect(env.code).toBe('evidence_invalid');
      const blob = errorsOf(env);
      expect(blob).toContain('handoff_ref');           // calls out the field they mistakenly copied
      expect(blob).toMatch(/`handoff`|handoff_file/);  // names the field(s) to actually use
    } finally {
      cleanup(repo);
    }
  });
});
