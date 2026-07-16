#!/usr/bin/env bash
# Smoke test for the human-in-the-loop adapter layer.
#
# The adapter instructions are natural language, so typecheck and unit tests
# can't verify that the gateway commands / flags / field paths they reference
# actually exist and return what the instructions claim. This script installs
# the adapter into a throwaway repo, builds a real run, forces a real takeover,
# and checks each referenced contract. Any mismatch exits non-zero.
#
# Usage (from the sigmarun repo root, after `npm run build`):
#   bash scripts/smoke-hitl.sh
set -uo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
CLI="$ROOT/packages/cli/dist/bin.js"
[ -f "$CLI" ] || { echo "Build first: npm run build  (missing $CLI)"; exit 1; }

T="$(mktemp -d)"
trap 'rm -rf "$T"' EXIT
PASS=0; FAIL=0
ok(){ echo "  ✓ $1"; PASS=$((PASS+1)); }
no(){ echo "  ✗ $1"; FAIL=$((FAIL+1)); }
J(){ python3 -c "import sys,json;d=json.load(sys.stdin);print($1)" 2>/dev/null; }
run(){ node "$CLI" "$@"; }

cd "$T"
git init -q; git config user.email t@t.co; git config user.name t
mkdir -p server/coupon web/checkout db
echo x > server/coupon/v.js; echo x > web/checkout/p.md; echo x > db/s.sql
git add -A; git commit -qm init

echo "== adapter install =="
run init >/dev/null
run adapter install --tool=claude-code >/dev/null
grep -q "template_version: 0.5" .claude/commands/team-dispatch.md \
  && ok "adapter installed (template v0.5.x)" || no "adapter install / version"
[ "$(grep -lc 'PAUSE FOR THE HUMAN' .claude/commands/team-*.md | wc -l | tr -d ' ')" != 0 ] \
  && ok "human-loop PAUSE instructions present" || no "PAUSE instructions missing"

echo "== build a run =="
cat > plan.json <<'JSON'
{"schema_version":"team.plan_payload.v1",
 "source":{"tool":"claude-code","command":"/team-plan","prompt":"coupon","agent_id":"planner"},
 "run":{"title":"coupon at checkout","mode":"feature","goal":"add coupon support"},
 "plan":{"summary":"3 independent pieces"},
 "tasks":[
  {"client_task_key":"api","title":"coupon API","type":"implementation","objective":"validate codes","acceptance":["invalid code returns 400"],"paths":{"allow":["server/coupon/**"]}},
  {"client_task_key":"ui","title":"checkout input","type":"implementation","objective":"input box","acceptance":["shows discounted price"],"paths":{"allow":["web/checkout/**"]}},
  {"client_task_key":"db","title":"coupon schema","type":"implementation","objective":"schema","acceptance":["migration reversible"],"paths":{"allow":["db/**"]}}]}
JSON
run run import plan.json >/dev/null
run task publish RUN-0001 >/dev/null
A="$(run agent register RUN-0001 --tool=claude-code --label=win-1 --json | J "d['data']['agent_id']")"

echo "== contract ② claim-next --dry-run -> would_claim =="
WC="$(run claim-next RUN-0001 --agent="$A" --dry-run --json | J "d.get('data',{}).get('would_claim')")"
[ "$WC" = "TASK-0001" ] && ok "--dry-run returns would_claim=$WC (no claim made)" || no "--dry-run would_claim (got '$WC')"

echo "== contract ② task list --status=ready =="
N="$(run task list RUN-0001 --status=ready --json | J "len(d.get('data',{}).get('tasks',[]))")"
[ "$N" = "3" ] && ok "task list --status=ready -> $N ready tasks" || no "task list --status=ready (got '$N')"

echo "== contract ⑥ events --type=changes_requested =="
run events RUN-0001 --task=TASK-0001 --type=changes_requested --json | J "d['ok']" | grep -qx True \
  && ok "events --task --type filter accepted" || no "events --type filter"

echo "== contract ④ takeover -> data.task.previous_attempts =="
run task cancel RUN-0001 TASK-0002 --reason=smoke >/dev/null
run task cancel RUN-0001 TASK-0003 --reason=smoke >/dev/null
run claim-next RUN-0001 --agent="$A" >/dev/null   # win-1 grabs TASK-0001
python3 - <<'PY'                                   # kill win-1's lease (dead window)
import json
f=".team/runs/RUN-0001/claims/task-claims.json"; d=json.load(open(f))
for c in d["claims"]: c["lease_until"]="2020-01-01T00:00:00.000Z"
json.dump(d,open(f,"w"))
PY
B="$(run agent register RUN-0001 --tool=claude-code --label=win-2 --json | J "d['data']['agent_id']")"
run claim-next RUN-0001 --agent="$B" >/dev/null    # win-2 auto-reclaims + takes over
PA="$(run task show RUN-0001 TASK-0001 --json | J "len((d['data']['task'].get('previous_attempts') or []))")"
[ "${PA:-0}" -ge 1 ] 2>/dev/null \
  && ok "takeover fills data.task.previous_attempts ($PA entry) — ④ can detect it" \
  || no "data.task.previous_attempts empty after takeover (④ would be dead)"

echo ""
echo "RESULT: $PASS passed, $FAIL failed"
[ "$FAIL" = 0 ]
