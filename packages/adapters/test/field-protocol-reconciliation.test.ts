import { describe, it, expect } from 'vitest';
import { TEMPLATES } from '@sigmarun/adapters';

/**
 * Field-protocol reconciliation (drift guard).
 *
 * The skill templates tell the AI what JSON to build; the gateway code validates it. If the
 * gateway REQUIRES a field the skill never names, the AI omits it and hits a validation failure
 * on the first try. This is exactly how the P0-4 evidence field-name drift (output_ref vs
 * output_file) and the commands[].cmd_id gap slipped in — nothing tied the two sides together.
 *
 * Each list below is the set of distinctive field names the cited validator requires/reads. The
 * skill corpus for every tool MUST name each one. When a validator gains/renames a required
 * field, update BOTH the code (+ its own validation test) AND this list — that keeps the skill
 * honest. This is the forward direction (code-requires -> skill-must-name), the one that actually
 * breaks users; the reverse (skill mentions a field the code ignores) is harmless passthrough.
 */
const REQUIRED_FIELDS: Record<string, string[]> = {
  // core/src/payload.ts PayloadSchema (run import)
  'plan payload (run import)': ['schema_version', 'client_task_key', 'objective', 'acceptance', 'mode', 'goal'],
  // core/src/submit.ts evidence draft
  'evidence draft (submit)': ['changed_files', 'change_type', 'cmd_id', 'cmd_ref', 'required_checks_results', 'output_file', 'handoff', 'context_ack'],
  // dispatch/src/verify.ts verify draft
  'verify draft (verify submit)': ['target', 'gates', 'verdict', 'skip_reasons', 'failures_mapped'],
  // dispatch/src/review.ts review draft
  'review draft (review approve/request-changes)': ['findings', 'must_fix'],
};

/**
 * Plan-recipes reconciliation (docs/34 §1 ⑤). The PLAN_RECIPES block teaches the planner ROUTE
 * (mode selection) and the per-mode task shapes; each keyword below is the load-bearing artifact
 * name of one recipe (bugfix→impact-analysis, hotfix→rollback note, refactor→safety net,
 * spike→timebox/decision-memo, BDD acceptance→Given). If a keyword drops out of a tool's corpus,
 * that tool's planner silently loses the recipe. Keywords are matched case-sensitively and must
 * not be split by line wrapping in the template.
 */
const RECIPE_KEYWORDS = ['ROUTE', 'impact-analysis', 'rollback note', 'timebox', 'safety net', 'decision-memo', 'Given'];

describe('field-protocol reconciliation — skill templates name every field the gateway requires', () => {
  for (const tool of Object.keys(TEMPLATES)) {
    const corpus = Object.values(TEMPLATES[tool]!).join('\n\n');
    for (const [draft, fields] of Object.entries(REQUIRED_FIELDS)) {
      it(`${tool}: names every gateway-required field of the ${draft}`, () => {
        const missing = fields.filter((f) => !corpus.includes(f));
        expect(missing, `${tool} skills omit field(s) the gateway requires for the ${draft} — an AI following the skill would hit a validation failure`).toEqual([]);
      });
    }
    it(`${tool}: plan recipes teach ROUTE and every recipe's load-bearing artifact (docs/34)`, () => {
      const missing = RECIPE_KEYWORDS.filter((k) => !corpus.includes(k));
      expect(missing, `${tool} skills lost plan-recipe keyword(s) — the planner would stop teaching that recipe's required artifact (docs/34 §4)`).toEqual([]);
    });
  }
});
