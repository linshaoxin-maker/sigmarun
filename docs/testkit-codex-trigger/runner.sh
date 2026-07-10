#!/bin/bash
# Codex trigger test runner (19 §8, D13). Sequential codex exec runs with a stub gateway.
set -u
BASE="$(cd "$(dirname "$0")" && pwd)"
OUT="$BASE/out"; FIXREPO="$BASE/repo"; PRISTINE="$BASE/repo.pristine"
mkdir -p "$OUT"
chmod +x "$BASE/bin/team"

# --- build pristine fixture repo once ---
if [ ! -d "$PRISTINE" ]; then
  mkdir -p "$PRISTINE"
  cd "$PRISTINE"
  git init -q -b main
  mkdir -p .team/runs/RUN-0001/tasks/TASK-0042 .team/runs/RUN-0001/context notes
  cat > README.md <<'EOF'
# Fixture project
Toy repo for the Team Run Protocol Codex trigger test.
EOF
  cat > .team/runs/RUN-0001/run.json <<'EOF'
{ "schema_version": "team.run.v1", "rev": 1, "run_id": "RUN-0001",
  "title": "Hello note run", "mode": "feature", "status": "active", "base_branch": "main" }
EOF
  cat > .team/runs/RUN-0001/tasks/TASK-0042/task.md <<'EOF'
# TASK-0042 Add hello note

## Objective
Create `notes/hello.md` containing exactly one line: `hello team run`.

## Acceptance
- File `notes/hello.md` exists in the worktree with that single line.

## Paths
Allow: `notes/**`
EOF
  cat > .team/runs/RUN-0001/context/run-memory.md <<'EOF'
# RUN-0001 Memory
Goal: verify the dispatch flow end to end with a trivial task.
Note: keep changes minimal; only touch notes/.
EOF
  printf 'placeholder\n' > notes/.gitkeep
  git add -A && git commit -qm "fixture: RUN-0001 with TASK-0042"
fi

reset_repo() { rm -rf "$FIXREPO"; cp -R "$PRISTINE" "$FIXREPO"; }
team_hash() { find "$FIXREPO/.team" -type f -print0 2>/dev/null | sort -z | xargs -0 shasum 2>/dev/null | shasum | cut -d' ' -f1; }

run_case() {
  local id="$1" prompt="$2"
  reset_repo
  local log="$OUT/$id.calls.log"; : > "$log"
  local h_before; h_before="$(team_hash)"
  echo "=== $id START $(date +%H:%M:%S) prompt: $prompt" >> "$OUT/progress.log"
  PATH="$BASE/bin:$PATH" TEAM_CALL_LOG="$log" \
  perl -e 'alarm 600; exec @ARGV' -- \
    codex exec -C "$FIXREPO" -s workspace-write \
      -c shell_environment_policy.inherit=all \
      --json -o "$OUT/$id.last.md" "$prompt" \
      > "$OUT/$id.jsonl" 2> "$OUT/$id.err" < /dev/null
  local rc=$?
  local h_after; h_after="$(team_hash)"
  {
    echo "case=$id rc=$rc"
    echo "team_dir_unchanged=$([ "$h_before" = "$h_after" ] && echo yes || echo no)"
    echo "gateway_calls=$(wc -l < "$log" | tr -d ' ')"
    echo "hello_md=$( [ -f "$FIXREPO/.wt/TASK-0042/notes/hello.md" ] && echo created || echo absent )"
    echo "---calls---"; cat "$log"
  } > "$OUT/$id.summary.txt"
  echo "=== $id DONE rc=$rc calls=$(wc -l < "$log" | tr -d ' ') $(date +%H:%M:%S)" >> "$OUT/progress.log"
}

P1='/team-dispatch RUN-0001'
P2='加入 RUN-0001，领个任务干活'
P3='解释一下前端框架里 event dispatch 的概念，纯概念问题，与本项目无关'
P4='Use the team-run-dispatch skill to join RUN-0001'

# t1a covered by the smoke run (triggered, full flow observed)
run_case t1b "$P1"; run_case t1c "$P1"
run_case t2a "$P2"; run_case t2b "$P2"; run_case t2c "$P2"
run_case t3a "$P3"; run_case t3b "$P3"; run_case t3c "$P3"
run_case t4a "$P4"; run_case t4b "$P4"
echo "ALL DONE $(date +%H:%M:%S)" >> "$OUT/progress.log"
