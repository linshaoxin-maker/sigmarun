import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

/** A handoff following the docs/14 §2.4 recommended shape — passes both AUD-041 heuristics. */
export const STRUCTURED_HANDOFF = [
  '# Handoff summary — TASK-0001 shipped',
  'Module a implemented and green; nothing left half-done.',
  '',
  '## What was done',
  '- Added src/a/index.ts; ran `npm test -- a`, all green (cmd-01).',
  '',
  '## Key decisions (why)',
  '- Kept the module dependency-free so downstream tasks import it without extra setup.',
  '',
  '## Pitfalls & unfinished',
  '- none',
  '',
  '## Notes for the next agent',
  '- Extend src/a/index.ts in place rather than adding a parallel entry point.',
  '',
  '## Related files',
  '- src/a/index.ts — the only deliverable of this task.',
  '',
].join('\n');

/** A valid draft evidence file for fixture task `a` (paths.allow: src/a/**, no required_checks). */
export function validDraft(repo: string, overrides: Record<string, unknown> = {}): string {
  const outDir = join(repo, '..', `draft-out-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`);
  mkdirSync(outDir, { recursive: true });
  const outputFile = join(outDir, 'check-01.raw.log');
  writeFileSync(outputFile, 'all 12 tests passed\n');
  const draft = {
    schema_version: 'team.evidence.v1',
    summary: 'Implemented task a with tests.',
    changed_files: [{ path: 'src/a/index.ts', change_type: 'added' }],
    commands: [{ cmd_id: 'cmd-01', cmd: 'npm test -- a', exit_code: 0, output_file: outputFile }],
    required_checks_results: [],
    acceptance: [{ item: 'a done.', status: 'met', evidence_ref: 'cmd-01' }],
    context_ack: [],
    handoff: '# TASK-0001 handoff\n\n- src/a/index.ts added. Source: cmd-01.\n',
    risks: [],
    follow_ups: [],
    ...overrides,
  };
  const draftPath = join(outDir, 'evidence-draft.json');
  writeFileSync(draftPath, JSON.stringify(draft, null, 2));
  return draftPath;
}
