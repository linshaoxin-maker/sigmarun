/**
 * Read-only local dashboard (docs/23 v0.2.1; front-end concern, so it lives in cli).
 *
 * Aggregates the existing read model — runList/statusRun/taskList/agentList (watch) +
 * showGraph/listMessages (context) + runShow/readEvents (core) — behind three endpoints:
 *   /api/state                       one poll of everything the page shows every tick
 *   /api/task?run=&task=             lazy per-task bundle for the detail sidebar (A–G)
 *   /api/events?run=&task=&since=    ledger timeline slice (seq cursor supported)
 * and serves a single self-contained HTML page (docs/23 §2 three-pane + needs-you inbox).
 *
 * Strictly read-only by construction: nothing here imports a write primitive, so the
 * architecture test's read-model rule holds. No npm deps, no CDN — the page is inline.
 * Derivations happen ONCE, server-side (docs/23 B6): the blocks-edge `satisfied` flag uses
 * the same DEPS_SATISFIED_DEFAULT / policy.deps_satisfied_when table as the claim-next guard;
 * the page only renders fields, it re-implements no gateway rule.
 */
import { createServer, type Server } from 'node:http';
import { runList, statusRun, taskList, taskShow, evidenceShow, agentList, gateRecords } from '@sigmarun/watch';
import { showGraph, listMessages } from '@sigmarun/context';
import { okEnvelope, failEnvelope, readEvents, runShow, DEPS_SATISFIED_DEFAULT, type Envelope } from '@sigmarun/core';

export interface DashboardOptions {
  cwd?: string;
  env?: Record<string, string | undefined>;
  teamRootFlag?: string;
  runId?: string;
}

interface RunRow { run_id: string; title?: string; status: string; lightweight?: boolean; progress_pct?: number | null; user_state?: unknown }
interface GraphNode { task_id: string; title?: string; type?: string; status?: string }

/** One poll of everything the page needs. Envelope-in, envelope-out; per-run errors degrade to fields. */
export function dashboardState(opts: DashboardOptions): Envelope {
  const startedAt = Date.now();
  const runs = runList({ ...opts });
  if (!runs.ok) return runs;
  const rows = ((runs.data as { runs?: RunRow[] }).runs ?? []).filter((r) => !opts.runId || r.run_id === opts.runId);
  const detail = rows.map((r) => {
    const st = statusRun({ ...opts, runId: r.run_id });
    const tl = taskList({ ...opts, runId: r.run_id });
    const g = showGraph({ ...opts, runId: r.run_id });
    const ag = agentList({ ...opts, runId: r.run_id });
    const rs = runShow({ ...opts, runId: r.run_id });
    const graph = (g.ok ? g.data : { nodes: [], edges: [] }) as { nodes: GraphNode[]; edges: Array<Record<string, unknown>> };
    // Blocks-edge gate, derived once with the claim-next table (docs/23 B6; core D20 default,
    // run policy may tighten). The page renders `satisfied` and never re-derives it.
    const gate =
      ((rs.ok ? (rs.data as { run?: { policy?: { deps_satisfied_when?: string[] } } }).run?.policy?.deps_satisfied_when : undefined) ??
        DEPS_SATISFIED_DEFAULT);
    const statusOf = new Map(graph.nodes.map((n) => [n.task_id, n.status ?? '']));
    const edges = graph.edges.map((e) =>
      e.kind === 'blocks' ? { ...e, satisfied: gate.includes(statusOf.get(e.from as string) ?? '') } : e,
    );
    return {
      run: r,
      status: st.ok ? st.data : { error: st.code },
      tasks: tl.ok ? ((tl.data as { tasks?: unknown[] }).tasks ?? []) : [],
      graph: { nodes: graph.nodes, edges },
      agents: ag.ok ? ((ag.data as { agents?: unknown[] }).agents ?? []) : [],
    };
  });
  return okEnvelope({
    message: `Dashboard state: ${detail.length} run(s).`,
    data: { generated_at: new Date().toISOString(), runs: detail },
    startedAt,
  });
}

/** Sidebar bundle (docs/23 §4.⑥ A–G): task profile + full evidence + gate records + messages. */
export function taskDetail(opts: DashboardOptions & { runId: string; taskId: string }): Envelope {
  const startedAt = Date.now();
  const ts = taskShow(opts);
  if (!ts.ok) return ts;
  const ev = evidenceShow(opts);
  const gr = gateRecords(opts);
  const ms = listMessages({ ...opts, taskId: opts.taskId });
  // Answered-ness must match computeProgress: an answer may lack task_id, so scan ALL answers.
  const ans = listMessages({ ...opts, type: 'answer' });
  const answered = new Set(
    (ans.ok ? ((ans.data as { messages?: Array<{ in_reply_to?: string }> }).messages ?? []) : [])
      .map((m) => m.in_reply_to)
      .filter(Boolean),
  );
  const base = ts.data as Record<string, unknown>;
  const evd = (ev.ok ? ev.data : { evidence: null, outputs: [], history: [] }) as Record<string, unknown>;
  const gates = (gr.ok ? gr.data : { reviews: [], verifications: [] }) as Record<string, unknown>;
  const messages = (ms.ok ? ((ms.data as { messages?: Array<Record<string, unknown>> }).messages ?? []) : []).map((m) => ({
    ...m,
    answered: typeof m.message_id === 'string' && answered.has(m.message_id),
  }));
  return okEnvelope({
    message: `${opts.taskId} detail bundle.`,
    data: {
      ...base, // task, claims, worktree (+ evidence summary, overwritten below by the full doc)
      evidence: evd.evidence ?? null,
      outputs: evd.outputs ?? [],
      history: evd.history ?? [],
      reviews: gates.reviews ?? [],
      verifications: gates.verifications ?? [],
      messages,
    },
    startedAt,
  });
}

/** Start the HTTP shell. Caller owns lifecycle (CLI keeps the process alive; tests close()). */
export function serveDashboard(opts: DashboardOptions & { port: number }): Server {
  const server = createServer((req, res) => {
    const url = new URL(req.url ?? '/', 'http://127.0.0.1');
    const send = (env: Envelope): void => {
      res.writeHead(200, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' });
      res.end(JSON.stringify(env));
    };
    if (url.pathname.startsWith('/api/state')) return send(dashboardState(opts));
    if (url.pathname.startsWith('/api/task')) {
      const runId = url.searchParams.get('run');
      const taskId = url.searchParams.get('task');
      if (!runId || !taskId) return send(failEnvelope('usage_error', 'Required: /api/task?run=<RUN-ID>&task=<TASK-ID>'));
      return send(taskDetail({ ...opts, runId, taskId }));
    }
    if (url.pathname.startsWith('/api/events')) {
      const runId = url.searchParams.get('run');
      if (!runId) return send(failEnvelope('usage_error', 'Required: /api/events?run=<RUN-ID>[&task=][&since=][&limit=]'));
      const num = (v: string | null): number | undefined => (v === null ? Number(v) : Number(v));
      const since = url.searchParams.get('since') === null ? undefined : num(url.searchParams.get('since'));
      const limit = url.searchParams.get('limit') === null ? undefined : num(url.searchParams.get('limit'));
      if ((since !== undefined && !Number.isFinite(since)) || (limit !== undefined && !Number.isFinite(limit))) {
        return send(failEnvelope('usage_error', 'since and limit must be numbers.'));
      }
      return send(readEvents({ ...opts, runId, task: url.searchParams.get('task') ?? undefined, since, limit }));
    }
    if (url.pathname === '/' || url.pathname.startsWith('/index')) {
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' });
      res.end(PAGE);
      return;
    }
    res.writeHead(404, { 'content-type': 'text/plain' });
    res.end('not found');
  });
  server.listen(opts.port, '127.0.0.1');
  return server;
}

/**
 * The page (docs/23 v0.2.1 three-pane + inbox; visual tokens from §8, validated light+dark).
 * Inline by design; inner JS uses string concatenation only (no template literals), so the
 * outer TS template literal needs zero escaping — a whole class of bugs removed.
 */
const PAGE = `<!doctype html>
<html lang="zh"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>sigmarun dashboard</title>
<style>
:root{
  --bg:#f6f8f7; --card:#ffffff; --line:#e2e9e6; --line-soft:#edf2f0;
  --ink:#15211f; --ink2:#4d5c58; --mut:#8a9995;
  --acc:#0f6e56; --acc-tint:rgba(15,110,86,.10);
  --st-draft:#888780; --st-ready:#ba7517; --st-work:#15559c; --st-review:#9b4fd0;
  --st-approved:#1d9e75; --st-done:#0f6e56; --st-alert:#a32d2d; --st-cancel:#5f5e5a;
  --shadow:0 8px 28px rgba(21,33,31,.13);
  --edge:#9aa8a4;
}
html[data-theme="dark"]{
  --bg:#0d1413; --card:#151f1d; --line:#26322f; --line-soft:#1c2725;
  --ink:#e7eeec; --ink2:#9fb0ab; --mut:#6b7b76;
  --acc:#5dcaa5; --acc-tint:rgba(93,202,165,.13);
  --st-draft:#98978f; --st-ready:#d68a28; --st-work:#4a90dd; --st-review:#c793f5;
  --st-approved:#52d49a; --st-done:#1f8a66; --st-alert:#f28b82; --st-cancel:#7d7c75;
  --shadow:0 10px 30px rgba(0,0,0,.5);
  --edge:#4e5c58;
}
@media(prefers-color-scheme:dark){
  html:not([data-theme]){
    --bg:#0d1413; --card:#151f1d; --line:#26322f; --line-soft:#1c2725;
    --ink:#e7eeec; --ink2:#9fb0ab; --mut:#6b7b76;
    --acc:#5dcaa5; --acc-tint:rgba(93,202,165,.13);
    --st-draft:#98978f; --st-ready:#d68a28; --st-work:#4a90dd; --st-review:#c793f5;
    --st-approved:#52d49a; --st-done:#1f8a66; --st-alert:#f28b82; --st-cancel:#7d7c75;
    --shadow:0 10px 30px rgba(0,0,0,.5);
    --edge:#4e5c58;
  }
}
*{box-sizing:border-box}
html,body{height:100%}
body{margin:0;font:13px/1.55 ui-sans-serif,system-ui,-apple-system,"PingFang SC","Microsoft YaHei",sans-serif;
  background:var(--bg);color:var(--ink);-webkit-font-smoothing:antialiased}
.mono{font-family:ui-monospace,SFMono-Regular,Menlo,Consolas,monospace}
button{font:inherit;color:inherit;background:none;border:none;cursor:pointer;padding:0}
::-webkit-scrollbar{width:10px;height:10px}
::-webkit-scrollbar-thumb{background:var(--line);border-radius:6px;border:2px solid var(--bg)}
::-webkit-scrollbar-track{background:transparent}
#top{height:48px;display:flex;align-items:center;gap:14px;padding:0 16px;
  border-bottom:1px solid var(--line);background:var(--card);position:relative;z-index:30}
#top .brand{font-weight:700;font-size:15px;letter-spacing:.01em}
.badge-ro{font-size:11px;color:var(--acc);background:var(--acc-tint);padding:1px 8px;border-radius:99px;font-weight:600}
#top .root{color:var(--mut);font-size:11px;max-width:260px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
#top .sp{flex:1}
#needsBtn{display:flex;align-items:center;gap:7px;border:1px solid var(--line);border-radius:8px;
  padding:5px 12px;font-weight:600;font-size:12.5px;background:var(--card)}
#needsBtn:hover{border-color:var(--mut)}
#needsBtn .n{background:var(--st-alert);color:#fff;font-size:11px;min-width:18px;height:18px;line-height:18px;
  text-align:center;border-radius:9px;padding:0 5px;font-weight:700}
html[data-theme="dark"] #needsBtn .n{color:#161311}
.meta{display:flex;align-items:center;gap:6px;color:var(--mut);font-size:11.5px}
#conn{width:7px;height:7px;border-radius:50%;background:var(--st-approved);animation:pu 2.5s infinite}
#conn.lag{background:var(--st-ready);animation:none}
#conn.down{background:var(--st-alert);animation:none}
@keyframes pu{0%,100%{opacity:1}50%{opacity:.25}}
#themeBtn{border:1px solid var(--line);border-radius:8px;padding:5px 10px;font-size:12px;color:var(--ink2)}
#themeBtn:hover{border-color:var(--mut)}
#inbox{position:absolute;top:52px;right:12px;width:440px;max-height:calc(100vh - 70px);overflow:auto;
  background:var(--card);border:1px solid var(--line);border-radius:12px;box-shadow:var(--shadow);z-index:40;display:none}
#inbox.open{display:block}
#inbox .hd{display:flex;align-items:center;gap:8px;padding:11px 14px;border-bottom:1px solid var(--line);
  position:sticky;top:0;background:var(--card);z-index:1}
#inbox .hd b{font-size:13px}
#inbox .hd .sub{color:var(--mut);font-size:11px}
#inbox .hd .x{margin-left:auto;color:var(--mut);font-size:15px;padding:2px 6px;border-radius:6px}
#inbox .hd .x:hover{background:var(--line-soft)}
.ni{display:flex;gap:10px;padding:11px 14px;border-bottom:1px solid var(--line-soft)}
.ni:last-child{border-bottom:none}
.ni .ic{width:26px;height:26px;border-radius:8px;display:flex;align-items:center;justify-content:center;
  font-size:13px;flex:none;margin-top:1px}
.ni .bd{min-width:0;flex:1}
.ni .l1{display:flex;align-items:center;gap:6px;flex-wrap:wrap}
.ni .kind{font-weight:650;font-size:12.5px}
.chip{font-size:10.5px;padding:0 6px;border-radius:5px;background:var(--line-soft);color:var(--ink2);
  border:1px solid var(--line);white-space:nowrap}
.chip.click{cursor:pointer}
.chip.click:hover{border-color:var(--acc);color:var(--acc)}
.ni .dt{color:var(--ink2);font-size:12px;margin:3px 0 6px;display:-webkit-box;-webkit-line-clamp:2;
  -webkit-box-orient:vertical;overflow:hidden}
.cmd{display:flex;align-items:center;gap:6px;background:var(--line-soft);border:1px solid var(--line);
  border-radius:7px;padding:4px 8px}
.cmd code{font-family:ui-monospace,Menlo,monospace;font-size:11px;color:var(--ink2);flex:1;overflow:hidden;
  text-overflow:ellipsis;white-space:nowrap}
.copy{font-size:11px;color:var(--acc);font-weight:600;flex:none;padding:1px 6px;border-radius:5px;cursor:pointer}
.copy:hover{background:var(--acc-tint)}
#grid{display:grid;grid-template-columns:248px minmax(520px,1fr) 360px;height:calc(100vh - 48px);overflow:hidden}
.col{overflow-y:auto;padding:12px}
#colL{border-right:1px solid var(--line)}
#colR{border-left:1px solid var(--line);padding:0;overflow-y:auto}
h4{margin:2px 2px 8px;font-size:11px;color:var(--mut);font-weight:650;text-transform:uppercase;letter-spacing:.07em}
.runcard{position:relative;background:var(--card);border:1px solid var(--line);border-radius:10px;
  padding:9px 11px 10px 14px;margin-bottom:8px;cursor:pointer;overflow:hidden}
.runcard::before{content:"";position:absolute;left:0;top:0;bottom:0;width:3px;background:var(--band)}
.runcard:hover{border-color:var(--mut)}
.runcard.sel{border-color:var(--acc);box-shadow:0 0 0 1px var(--acc)}
.runcard .l1{display:flex;align-items:baseline;gap:6px}
.runcard .rid{font-size:11.5px;color:var(--ink2)}
.runcard .lw{font-size:10px;color:var(--mut)}
.runcard .pct{margin-left:auto;font-size:12px;font-weight:700;color:var(--ink2)}
.runcard .tt{font-weight:650;font-size:12.5px;margin:2px 0 4px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.runcard .stt{display:flex;align-items:center;gap:5px;font-size:11.5px;color:var(--ink2);
  overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.dot{width:7px;height:7px;border-radius:50%;flex:none}
.stack{display:flex;gap:1px;height:4px;border-radius:2px;overflow:hidden;margin-top:7px;background:var(--line-soft)}
.stack i{display:block;height:100%}
.agsum{color:var(--mut);font-size:11.5px;margin:0 2px 8px}
.ag{background:var(--card);border:1px solid var(--line);border-radius:10px;padding:8px 10px;margin-bottom:7px}
.ag.stale{opacity:.62}
.ag .l1{display:flex;align-items:center;gap:6px}
.ag .id{font-weight:650;font-size:12px}
.ag .tool{font-size:10px;color:var(--mut);border:1px solid var(--line);border-radius:4px;padding:0 4px}
.ag .role{margin-left:auto;font-size:10.5px;color:var(--ink2)}
.ag .l2{display:flex;align-items:center;gap:6px;margin-top:5px;font-size:11.5px;color:var(--ink2)}
.hb{width:7px;height:7px;border-radius:50%;background:var(--st-approved);flex:none}
.hb.warn{background:var(--st-ready)}
.ag .hbt{color:var(--mut);font-size:11px;margin-left:auto}
#paneHd{display:flex;align-items:center;gap:10px;padding:2px 2px 10px;flex-wrap:wrap}
#paneHd .tt{font-size:15px;font-weight:700}
#paneHd .big{font-size:20px;font-weight:700;color:var(--acc)}
#paneHd .wt{color:var(--mut);font-size:11.5px}
.pill{display:inline-flex;align-items:center;gap:4px;padding:1px 8px;border-radius:99px;font-size:11.5px;
  font-weight:600;color:var(--c);background:color-mix(in srgb,var(--c) 12%,transparent);
  border:1px solid color-mix(in srgb,var(--c) 38%,transparent);white-space:nowrap}
.tabs{margin-left:auto;display:flex;border:1px solid var(--line);border-radius:8px;overflow:hidden}
.tabs button{padding:4px 12px;font-size:12px;color:var(--ink2);background:var(--card)}
.tabs button.on{background:var(--acc-tint);color:var(--acc);font-weight:650}
#legend{display:flex;gap:12px;align-items:center;color:var(--mut);font-size:11px;padding:0 2px 8px;flex-wrap:wrap}
#legend svg{vertical-align:-2px}
.lgchip{font-size:11px;color:var(--ink2);border:1px solid var(--line);border-radius:99px;padding:2px 10px;margin-left:auto;cursor:pointer}
.lgchip.on{color:var(--acc);border-color:var(--acc);background:var(--acc-tint)}
#dagwrap{background:var(--card);border:1px solid var(--line);border-radius:12px;overflow:auto;position:relative}
#dagwrap svg{display:block}
.node{cursor:pointer}
.node rect.bx{fill:color-mix(in srgb,var(--c) 11%,var(--card));stroke:var(--c);stroke-width:1.4;rx:9}
.node.dim rect.bx{stroke-dasharray:4 3;fill:var(--card)}
.node.dim{opacity:.75}
.node.sel rect.bx{stroke:var(--acc);stroke-width:2.2;filter:drop-shadow(0 3px 8px color-mix(in srgb,var(--acc) 45%,transparent))}
.node text{font-family:ui-monospace,Menlo,monospace}
.node .nid{font-size:11px;font-weight:700;fill:var(--c)}
.node .nti{font-size:11px;fill:var(--ink2);font-family:ui-sans-serif,system-ui,"PingFang SC",sans-serif}
.node .now{font-size:9.5px;fill:var(--mut)}
.node.cancel .nti{text-decoration:line-through}
.node.working rect.bx{animation:npulse 2.5s ease-in-out infinite}
@keyframes npulse{0%,100%{stroke-opacity:1}50%{stroke-opacity:.35}}
.fade{opacity:.18;transition:opacity .15s}
g.edge{cursor:pointer}
g.edge.esel path.vis{stroke-width:2.6}
.rk{font-size:10px}
#tbl{display:none;background:var(--card);border:1px solid var(--line);border-radius:12px;overflow:hidden}
#tblbar{display:flex;align-items:center;gap:8px;padding:7px 10px;border-bottom:1px solid var(--line)}
#tblbar .cnt{font-size:11px;color:var(--mut)}
#tbl table{width:100%;border-collapse:collapse;font-size:12px}
#tbl th{color:var(--mut);font-weight:600;font-size:11px;text-transform:uppercase;letter-spacing:.05em;
  padding:7px 10px;border-bottom:1px solid var(--line);text-align:left;background:var(--line-soft)}
#tbl td{padding:6px 10px;border-bottom:1px solid var(--line-soft);vertical-align:middle}
#tbl td:first-child{white-space:nowrap}
#tbl tr:last-child td{border-bottom:none}
#tbl tbody tr{cursor:pointer}
#tbl tbody tr:hover{background:var(--line-soft)}
#tbl tbody tr.sel{background:var(--acc-tint)}
.depchip{font-size:10.5px;padding:0 5px;border-radius:4px;border:1px solid var(--line);color:var(--ink2);
  margin-right:3px;white-space:nowrap;cursor:pointer}
.depchip.unmet{border-color:color-mix(in srgb,var(--st-ready) 55%,transparent);color:var(--st-ready)}
.depchip:hover{border-color:var(--acc);color:var(--acc)}
#sbHead,.edgehead{padding:12px 14px;border-bottom:1px solid var(--line);background:var(--card)}
#sbHead .l1,.edgehead .l1{display:flex;align-items:center;gap:7px;flex-wrap:wrap}
#sbHead .tid{font-weight:700;font-size:13.5px}
#sbHead .ty{font-size:10.5px;color:var(--mut);border:1px solid var(--line);padding:0 5px;border-radius:4px}
#sbHead .tt{font-size:13px;font-weight:600;margin-top:5px}
#sbHead .own{color:var(--mut);font-size:11.5px;margin-top:4px}
.earrow{color:var(--mut);font-size:14px}
.sec{padding:11px 14px;border-bottom:1px solid var(--line-soft)}
.sec h5{margin:0 0 8px;font-size:11px;color:var(--mut);font-weight:650;text-transform:uppercase;letter-spacing:.07em}
.kv{display:flex;gap:8px;font-size:12px;margin:4px 0;align-items:baseline}
.kv b{color:var(--mut);font-weight:600;flex:none;width:58px;font-size:11.5px}
.kv .v{color:var(--ink);min-width:0}
.riskline{display:flex;gap:6px;align-items:center;font-size:12px;color:var(--st-alert);margin:4px 0}
.riskline.warn{color:var(--st-ready)}
.ck{display:flex;align-items:center;gap:8px;padding:3px 0;font-size:12px}
.ck code{font-family:ui-monospace,Menlo,monospace;font-size:11px;color:var(--ink2);flex:1;overflow:hidden;
  text-overflow:ellipsis;white-space:nowrap}
.ckpill{font-size:10.5px;font-weight:700;padding:0 7px;border-radius:99px;color:var(--c);
  background:color-mix(in srgb,var(--c) 13%,transparent)}
.cf{display:flex;align-items:center;gap:6px;font-size:11px;padding:2px 0;color:var(--ink2)}
.cf code{font-family:ui-monospace,Menlo,monospace;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.oob{font-size:9.5px;color:var(--st-ready);border:1px solid color-mix(in srgb,var(--st-ready) 50%,transparent);
  border-radius:4px;padding:0 4px;flex:none}
.sum{font-size:12px;color:var(--ink2);margin-top:6px}
.rev{border:1px solid var(--line);border-radius:9px;padding:8px 10px;margin:6px 0;font-size:12px}
.rev .l1{display:flex;align-items:center;gap:6px;flex-wrap:wrap}
.rev .rid{font-weight:650}
.rev .when{color:var(--mut);font-size:10.5px;margin-left:auto}
.find{display:flex;gap:6px;align-items:baseline;margin-top:5px;font-size:11.5px;color:var(--ink2)}
.find .mf{flex:none;font-size:9.5px;font-weight:700;color:var(--st-alert);
  border:1px solid color-mix(in srgb,var(--st-alert) 50%,transparent);border-radius:4px;padding:0 4px}
.find .ok{color:var(--st-approved);border-color:color-mix(in srgb,var(--st-approved) 50%,transparent)}
.att{display:flex;gap:8px;align-items:baseline;font-size:11.5px;color:var(--ink2);margin:5px 0}
.att .no{flex:none;font-weight:700;color:var(--st-ready)}
.msgc{border-left:3px solid var(--c);background:color-mix(in srgb,var(--c) 7%,transparent);
  border-radius:0 8px 8px 0;padding:7px 10px;margin:6px 0;font-size:12px}
.msgc .l1{display:flex;gap:6px;align-items:center;flex-wrap:wrap;margin-bottom:3px}
.msgc .ty2{font-weight:650;color:var(--c);font-size:11.5px}
.msgc .bd2{color:var(--ink2)}
.refline{display:flex;gap:6px;align-items:center;font-size:11px;padding:2px 0;color:var(--ink2)}
.refline code{font-family:ui-monospace,Menlo,monospace;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.tl{position:relative;margin-left:4px}
.tl::before{content:"";position:absolute;left:5px;top:8px;bottom:8px;width:2px;background:var(--line)}
.ev{position:relative;padding:0 0 12px 22px}
.ev:last-child{padding-bottom:2px}
.ev .pt{position:absolute;left:0;top:4px;width:12px;height:12px;border-radius:50%;
  background:var(--c);border:2.5px solid var(--card);box-shadow:0 0 0 1.5px var(--c)}
.ev .l1{display:flex;align-items:center;gap:6px;font-size:12px}
.ev{cursor:pointer}
.ev .nm{font-weight:650}
.ev .chev{margin-left:auto;color:var(--mut);font-size:10px;flex:none}
.ev .meta2{color:var(--mut);font-size:10.5px;margin-top:2px}
.pv{display:inline-flex;gap:4px;align-items:baseline;font-size:10.5px;color:var(--ink2);
  background:var(--line-soft);border:1px solid var(--line);border-radius:5px;padding:0 5px;
  margin:3px 3px 0 0;max-width:100%;vertical-align:top}
.pv b{color:var(--mut);font-weight:600;font-size:10px;flex:none}
.pv i{font-style:normal;font-family:ui-monospace,Menlo,monospace;overflow:hidden;
  text-overflow:ellipsis;white-space:nowrap;max-width:180px}
.ev pre.full{margin:6px 0 0;padding:8px;background:var(--line-soft);border:1px solid var(--line);
  border-radius:8px;font:10.5px/1.5 ui-monospace,Menlo,monospace;color:var(--ink2);
  overflow:auto;max-height:240px;white-space:pre}
.more{color:var(--mut);font-size:11px;margin-top:8px}
.empty{color:var(--mut);font-size:12px;padding:24px 14px;text-align:center}
.drawerx{display:none}
@media(max-width:1199px){
  #grid{grid-template-columns:248px 1fr}
  #colR{position:fixed;top:48px;right:0;bottom:0;width:min(400px,92vw);background:var(--card);
    box-shadow:var(--shadow);transform:translateX(105%);transition:transform .2s;z-index:20}
  body.drawer #colR{transform:none}
  .drawerx{display:inline-block;margin-left:auto;color:var(--mut);font-size:14px;cursor:pointer}
}
#toast{position:fixed;bottom:18px;left:50%;transform:translate(-50%,8px);background:var(--ink);color:var(--bg);
  font-size:12px;padding:6px 14px;border-radius:8px;opacity:0;transition:.18s;pointer-events:none;z-index:99}
#toast.on{opacity:.93;transform:translate(-50%,0)}
</style></head><body>
<header id="top">
  <span class="brand">sigmarun dashboard</span>
  <span class="badge-ro">只读</span>
  <span class="root mono" id="rootpath"></span>
  <span class="sp"></span>
  <button id="needsBtn" onclick="toggleInbox()">需要你 <span class="n" id="needsN">0</span></button>
  <span class="meta mono" id="stamp"></span>
  <span class="meta"><span id="conn"></span><span id="connt">2.5s 轮询</span></span>
  <button id="themeBtn" onclick="cycleTheme()">主题:自动</button>
  <div id="inbox">
    <div class="hd"><b>需要你处理</b><span class="sub" id="inboxSub"></span>
      <button class="x" onclick="toggleInbox()">✕</button></div>
    <div id="inboxList"></div>
  </div>
</header>
<div id="grid">
  <div class="col" id="colL">
    <h4 id="runsHd">需求</h4>
    <div id="runs"></div>
    <h4 style="margin-top:16px">窗口 · agents</h4>
    <div class="agsum" id="agsum"></div>
    <div id="agents"></div>
  </div>
  <div class="col" id="colM">
    <div id="paneHd"></div>
    <div id="legend">
      <span><svg width="26" height="8"><line x1="0" y1="4" x2="26" y2="4" stroke="var(--edge)" stroke-width="1.6"/></svg> blocks</span>
      <span style="color:var(--st-ready)"><svg width="26" height="8"><line x1="0" y1="4" x2="26" y2="4" stroke="var(--st-ready)" stroke-width="1.6"/></svg> blocks·未满足</span>
      <span><svg width="26" height="8"><line x1="0" y1="4" x2="26" y2="4" stroke="var(--st-review)" stroke-width="1.6" stroke-dasharray="6 4"/></svg> 产出 context</span>
      <span><svg width="26" height="8"><line x1="0" y1="4" x2="26" y2="4" stroke="var(--edge)" stroke-width="1.6" stroke-dasharray="2 4"/></svg> 软依赖</span>
      <span style="color:var(--mut)">· 点节点看任务,点边看关系</span>
      <button class="lgchip" id="foldChip" onclick="collapseDone=!collapseDone;renderAll()">折叠完成组</button>
    </div>
    <div id="dagwrap"><svg id="dag"></svg></div>
    <div id="tbl">
      <div id="tblbar"><span class="cnt" id="tblcount"></span>
        <button class="lgchip" id="hideChip" onclick="hideClosed=!hideClosed;renderAll()">隐藏已收尾</button></div>
      <table><thead><tr><th>ID</th><th>标题</th><th>类型</th><th>状态</th><th>owner</th><th>依赖</th><th>风险</th></tr></thead>
      <tbody id="tbody"></tbody></table>
    </div>
  </div>
  <div class="col" id="colR"><div id="sidebar"><div class="empty" style="padding-top:60px">加载中…</div></div></div>
</div>
<div id="toast">已复制</div>
<script>
'use strict';
/* ---------- 状态 ---------- */
var STATE=null, DETAIL=null, DKEY='';
var selRun=null, selTask=null, selEdge=null, tab='dag';
var collapseDone=false, hideClosed=false, misses=0, lastJson='', lastDetailJson='';
var FOLD={done:1,integrated:1,cancelled:1};
var LAST_DAG={nodes:[],edges:[]};
/* ---------- 词汇(core/watch 词汇表,不造词) ---------- */
var ST={
  draft:{c:'var(--st-draft)',g:'○',zh:'计划'}, ready:{c:'var(--st-ready)',g:'◇',zh:'就绪'},
  claimed:{c:'var(--st-work)',g:'▶',zh:'已认领'}, working:{c:'var(--st-work)',g:'▶',zh:'进行中'},
  blocked:{c:'var(--st-alert)',g:'⛔',zh:'阻塞'}, submitted:{c:'var(--st-review)',g:'◐',zh:'已提交'},
  reviewing:{c:'var(--st-review)',g:'◐',zh:'评审中'}, changes_requested:{c:'var(--st-alert)',g:'⛔',zh:'待返工'},
  approved:{c:'var(--st-approved)',g:'✓',zh:'已通过'}, verified:{c:'var(--st-done)',g:'✓',zh:'已验证'},
  integrated:{c:'var(--st-done)',g:'✓',zh:'已集成'}, done:{c:'var(--st-done)',g:'✓',zh:'完成'},
  cancelled:{c:'var(--st-cancel)',g:'×',zh:'已取消'}, unknown:{c:'var(--st-draft)',g:'?',zh:'未知'},
  agg:{c:'var(--st-done)',g:'✓',zh:'已收尾'}
};
var USTATE={
  needs_you:{c:'var(--st-alert)',zh:'等你处理'}, awaiting_publish:{c:'var(--st-ready)',zh:'待发布'},
  ready_to_work:{c:'var(--st-ready)',zh:'可开工'}, in_progress:{c:'var(--st-work)',zh:'进行中'},
  awaiting_gates:{c:'var(--st-review)',zh:'等闸门'}, ready_to_integrate:{c:'var(--st-approved)',zh:'可集成'},
  ready_to_report:{c:'var(--st-approved)',zh:'可收尾'}, closed:{c:'var(--st-done)',zh:'已收尾'},
  paused:{c:'var(--st-cancel)',zh:'已暂停'}
};
var KIND={
  ledger_broken:{c:'var(--st-alert)',ic:'⚑',zh:'账本损坏'}, blocker:{c:'var(--st-alert)',ic:'⛔',zh:'阻塞待答'},
  blocked_unblock:{c:'var(--st-ready)',ic:'🔓',zh:'待解除阻塞'}, reclaim_confirm:{c:'var(--st-ready)',ic:'⏱',zh:'待确认回收'},
  stale_owner:{c:'var(--st-ready)',ic:'⏱',zh:'owner 失联'}, deps_dead:{c:'var(--st-ready)',ic:'✂',zh:'依赖已死'},
  open_question:{c:'var(--st-ready)',ic:'?',zh:'提问待答'}, approval_pending:{c:'var(--st-ready)',ic:'🛂',zh:'路径待批准'},
  awaiting_rework:{c:'var(--st-ready)',ic:'↩',zh:'待返工'}, handoff_unstructured:{c:'var(--st-ready)',ic:'☰',zh:'交接欠结构'},
  awaiting_review:{c:'var(--st-review)',ic:'◐',zh:'等独立评审'},
  awaiting_verify:{c:'var(--st-review)',ic:'◑',zh:'等独立验证'},
  ready_to_integrate:{c:'var(--st-approved)',ic:'⇣',zh:'可以集成'}, ready_to_report:{c:'var(--st-approved)',ic:'✓',zh:'可以收尾'}
};
var EV_ZH={
  task_created:'创建任务',task_published:'发布任务',task_claimed:'认领',task_started:'开工',
  task_released:'释放',task_reclaimed:'回收重派',evidence_submitted:'提交 evidence',evidence_invalid:'evidence 无效',
  review_claimed:'认领评审',review_released:'释放评审',review_approved:'评审通过',review_skipped:'跳过评审',
  changes_requested:'要求修改',review_blocked:'评审阻塞',task_blocked:'挂起阻塞',task_unblocked:'解除阻塞',
  verify_claimed:'认领验证',verification_started:'开始验证',verification_passed:'验证通过',verification_failed:'验证失败',
  task_integrated:'已集成',task_cancelled:'取消任务',task_done:'完成',heartbeat:'心跳',agent_registered:'注册窗口',
  path_claimed:'占用路径',path_approval_granted:'批准路径',run_created:'创建需求',run_activated:'激活需求',
  run_paused:'暂停需求',run_resumed:'恢复需求',run_reported:'收尾出报告',worktree_created:'创建 worktree',
  worktree_adopted:'接管 worktree',worktree_pruned:'清理 worktree',memory_updated:'更新记忆',
  integration_started:'开始集成',integration_reopened:'重开集成',state_repaired:'修复状态'
};
var EV_STATUS={
  task_created:'draft',task_published:'ready',task_claimed:'claimed',task_started:'working',
  task_released:'ready',task_reclaimed:'ready',evidence_submitted:'submitted',review_claimed:'reviewing',
  review_released:'submitted',review_approved:'approved',review_skipped:'approved',changes_requested:'changes_requested',
  review_blocked:'blocked',task_blocked:'blocked',task_unblocked:'working',verification_passed:'verified',
  task_integrated:'integrated',task_cancelled:'cancelled',task_done:'done'
};
var EDGE_ZH={
  blocks:{zh:'硬依赖 blocks',note:'上游过闸门前,下游不可被 claim-next 领取(与网关同一张判定表,页面不复刻规则)'},
  produces_context_for:{zh:'产出 context',note:'上游产出物是下游的 must_read;hydrate 时注入'},
  soft_depends_on:{zh:'软依赖',note:'只提示阅读顺序,不参与领取闸门,不影响分层'}
};
var DECISION_ZH={approve:['通过','var(--st-approved)'],request_changes:['要求修改','var(--st-alert)'],block:['阻塞','var(--st-alert)']};
var TOOL_SHORT={'claude-code':'CC','codex':'CX'};
var RUN_ST={active:['var(--st-work)','active'],planned:['var(--st-draft)','planned'],paused:['var(--st-cancel)','paused'],
  integrating:['var(--st-approved)','integrating'],reported:['var(--st-done)','reported'],
  archived:['var(--st-cancel)','archived'],cancelled:['var(--st-cancel)','cancelled']};
/* ---------- 工具 ---------- */
function esc(s){return String(s==null?'':s).replace(/[&<>"]/g,function(c){return {'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;'}[c]})}
/* AGENT-claude-code-001 类长 id 的紧凑显示:去前缀,过长取尾部;全名进 title */
function agShort(id){ if(!id)return ''; var s=String(id).replace(/^AGENT-/,'');
  return s.length>10?'…'+s.slice(-9):s }
function curRun(){ if(!STATE)return null; for(var i=0;i<STATE.runs.length;i++) if(STATE.runs[i].run.run_id===selRun) return STATE.runs[i]; return null }
function stOf(s){return ST[s]||ST.unknown}
function hhmmss(iso){return typeof iso==='string'&&iso.length>=19?iso.slice(11,19):''}
function agoMin(iso){ var t=Date.parse(iso); return isFinite(t)?Math.max(0,Math.round((Date.now()-t)/60000)):null }
function agoText(iso){ var m=agoMin(iso); if(m==null)return ''; if(m<1)return '刚刚'; if(m<60)return m+' 分钟前'; return Math.round(m/60)+' 小时前' }
/* 事件 payload 的结构化展示:已知字段中文标注为 chips,点击事件行展开完整 JSON。 */
var EXPAND={};
function toggleEv(seq){ EXPAND[seq]=!EXPAND[seq]; renderSidebar() }
var PAY_LABEL={revision:'版次',checks_pass_count:'checks 过',out_of_scope_count:'越界',round:'轮次',
  lease_until:'租约至',merge_commit:'合并',via:'途径',reason:'原因',branch:'分支',published_count:'发布数',
  must_fix_count:'must_fix',mirrored:'镜像消息',paths:'路径',target:'对象',attempt:'尝试',
  resumed:'续租',handoff_unstructured:'交接欠结构'};
function payVal(k,v){
  if(v==null)return '';
  if(k==='lease_until'&&typeof v==='string')return hhmmss(v)||v;
  if(k==='merge_commit'&&typeof v==='string')return v.slice(0,10);
  if(k==='target'&&typeof v==='object')return v.task_id||v.kind||'';
  if(k==='paths'&&typeof v==='object')return (v.allow||[]).join(', ');
  if(typeof v==='object'){ try{ var s=JSON.stringify(v); return s.length>42?s.slice(0,42)+'…':s }catch(e){ return '' } }
  return String(v);
}
function payChips(p){
  if(!p)return '';
  var h=''; var n=0;
  for(var k in p){ if(k==='rev_after')continue; // 记账噪音只在展开的完整 JSON 里看
    var val=payVal(k,p[k]); if(val==='')continue;
    var full=typeof p[k]==='object'?JSON.stringify(p[k]):String(p[k]);
    h+='<span class="pv">'+(PAY_LABEL[k]?'<b>'+PAY_LABEL[k]+'</b>':'')+'<i title="'+esc(k+': '+full)+'">'+esc(val)+'</i></span>';
    n++; if(n>=4){ h+='<span class="pv"><i>… 点开看全部</i></span>'; break }
  }
  return h;
}
function selectNode(id){ selTask=id; selEdge=null; document.body.classList.add('drawer'); renderAll(); refreshDetail() }
function selectEdge(id){ selEdge=id; document.body.classList.add('drawer'); renderAll() }
function jumpTo(run,task){ selRun=run; selTask=task; selEdge=null; DKEY=''; document.body.classList.add('drawer'); renderAll(); refreshDetail() }
function toggleInbox(){ document.getElementById('inbox').classList.toggle('open') }
function closeDrawer(){ document.body.classList.remove('drawer') }
function hov(id){
  var svg=document.getElementById('dag');
  if(!id){ var f=svg.querySelectorAll('.fade'); for(var i=0;i<f.length;i++) f[i].classList.remove('fade'); return }
  var keep={}; keep[id]=1;
  for(var j=0;j<LAST_DAG.edges.length;j++){ var e=LAST_DAG.edges[j];
    if(e.from===id||e.to===id){ keep[e.from]=1; keep[e.to]=1; keep[e.edge_id||('E'+j)]=1 } }
  var ns=svg.querySelectorAll('g.node'); for(var a=0;a<ns.length;a++) ns[a].classList.toggle('fade',!keep[ns[a].dataset.nid]);
  var es=svg.querySelectorAll('g.edge'); for(var b=0;b<es.length;b++) es[b].classList.toggle('fade',!keep[es[b].dataset.eid]);
}
/* ---------- 轮询 ---------- */
function setConn(kind){ var el=document.getElementById('conn'); var t=document.getElementById('connt');
  el.className = kind===0?'':(kind===1?'lag':'down');
  t.textContent = kind===0?'2.5s 轮询':(kind===1?'滞后,重试中':'连接断开,数据可能过期') }
async function tick(){
  try{
    var env=await (await fetch('/api/state')).json();
    if(env.ok){
      misses=0; setConn(0); STATE=env.data;
      document.getElementById('stamp').textContent=hhmmss(env.data.generated_at||'');
      if(!selRun&&STATE.runs.length){ var pick=null;
        for(var i=0;i<STATE.runs.length;i++){ var u=STATE.runs[i].run.user_state;
          if(!u||u.state!=='closed'){ pick=STATE.runs[i]; break } }
        selRun=(pick||STATE.runs[0]).run.run_id; }
      var j=JSON.stringify(STATE.runs);
      if(j!==lastJson){ lastJson=j; renderAll() }
      await refreshDetail();
    } else { misses++; setConn(misses>2?2:1) }
  }catch(e){ misses++; setConn(misses>2?2:1) }
  finally{ setTimeout(tick,2500) }
}
async function refreshDetail(){
  if(!selRun||!selTask){ return }
  var key=selRun+'/'+selTask;
  try{
    var t=await (await fetch('/api/task?run='+encodeURIComponent(selRun)+'&task='+encodeURIComponent(selTask))).json();
    var ev=await (await fetch('/api/events?run='+encodeURIComponent(selRun)+'&task='+encodeURIComponent(selTask)+'&limit=30')).json();
    if(t.ok){ DETAIL=t.data; DETAIL.ev=ev.ok?ev.data:{events:[],total:0} }
    else DETAIL={error:t.code,message:t.message};
    var dj=JSON.stringify(DETAIL);
    if(dj!==lastDetailJson||key!==DKEY){ lastDetailJson=dj; DKEY=key; if(!selEdge) renderSidebar() }
  }catch(e){}
}
/* ---------- ② 收件箱 ---------- */
function renderInbox(){
  var items=[]; var runsN={};
  for(var i=0;i<STATE.runs.length;i++){ var r=STATE.runs[i]; var ns=(r.status&&r.status.needs_user)||[];
    for(var j=0;j<ns.length;j++){ items.push({run:r.run.run_id,it:ns[j]}); runsN[r.run.run_id]=1 } }
  document.getElementById('needsN').textContent=items.length;
  document.getElementById('inboxSub').textContent=items.length+' 件 · 跨 '+Object.keys(runsN).length+' 个需求 · 命令只可复制';
  var h='';
  for(var k2=0;k2<items.length;k2++){ var n=items[k2].it; var run=items[k2].run;
    var kk=KIND[n.kind]||{c:'var(--st-draft)',ic:'•',zh:n.kind};
    h+='<div class="ni"><div class="ic" style="color:'+kk.c+';background:color-mix(in srgb,'+kk.c+' 13%,transparent)">'+kk.ic+'</div>'
      +'<div class="bd"><div class="l1"><span class="kind" style="color:'+kk.c+'">'+kk.zh+'</span>'
      +'<span class="chip">'+esc(run)+'</span>'
      +(n.task_id?'<span class="chip click" onclick="jumpTo(\\''+esc(run)+'\\',\\''+esc(n.task_id)+'\\')">'+esc(n.task_id)+'</span>':'')
      +'</div><div class="dt">'+esc(n.detail)+'</div>'
      +'<div class="cmd"><code>'+esc(n.command)+'</code>'
      +'<span class="copy" data-cmd="'+esc(n.command)+'" onclick="copyText(this,this.dataset.cmd)">复制</span></div></div></div>';
  }
  document.getElementById('inboxList').innerHTML=h||'<div class="empty">没有等你的事 —— 去喝口水</div>';
}
/* ---------- ③ 需求清单 ---------- */
var STACK_ORDER=['done','integrated','verified','approved','reviewing','submitted','working','claimed','blocked','changes_requested','ready','draft','cancelled'];
function renderRuns(){
  document.getElementById('runsHd').textContent='需求 · '+STATE.runs.length;
  var h='';
  for(var i=0;i<STATE.runs.length;i++){ var r=STATE.runs[i]; var run=r.run;
    var u=run.user_state||{}; var us=USTATE[u.state]||{c:'var(--st-draft)',zh:u.state||run.status};
    var counts=(r.status&&r.status.counts)||{}; var total=0; var s2;
    for(s2 in counts) total+=counts[s2]; if(!total) total=1;
    var segs='';
    for(var o=0;o<STACK_ORDER.length;o++){ var stt=STACK_ORDER[o]; if(!counts[stt])continue;
      segs+='<i style="width:'+(counts[stt]/total*100)+'%;background:'+stOf(stt).c+'" title="'+stOf(stt).zh+' '+counts[stt]+'"></i>' }
    h+='<div class="runcard'+(run.run_id===selRun?' sel':'')+'" style="--band:'+us.c+'" data-rid="'+esc(run.run_id)+'" onclick="selRun=this.dataset.rid;selTask=null;selEdge=null;DKEY=\\'\\';renderAll()">'
      +'<div class="l1"><span class="rid mono">'+esc(run.run_id)+'</span>'
      +'<span class="lw">'+(run.lightweight?'轻量':'完整')+'</span>'
      +'<span class="pct">'+(run.progress_pct==null?'—':run.progress_pct+'%')+'</span></div>'
      +'<div class="tt">'+esc(run.title||'')+'</div>'
      +'<div class="stt"><span class="dot" style="background:'+us.c+'"></span>'
      +'<span style="color:'+us.c+';font-weight:650">'+esc(us.zh)+'</span>'
      +'<span style="overflow:hidden;text-overflow:ellipsis">· '+esc(u.detail||run.status)+'</span></div>'
      +'<div class="stack">'+segs+'</div></div>';
  }
  document.getElementById('runs').innerHTML=h||'<div class="empty">还没有需求</div>';
}
/* ---------- ④ agents ---------- */
function renderAgents(){
  var r=curRun(); if(!r){ document.getElementById('agents').innerHTML=''; return }
  var a=(r.status&&r.status.agents)||{};
  document.getElementById('agsum').textContent=(a.total||0)+' 窗口 · '+(a.with_claims||0)+' 在干活 · '+(a.stale||0)+' 失联';
  var h='';
  var list=r.agents||[];
  for(var i=0;i<list.length;i++){ var g=list[i];
    var doing=g.gate_kind==='review'?'评审中':(g.gate_kind==='verify'?'验证中':'实现中');
    h+='<div class="ag'+(g.stale?' stale':'')+'"><div class="l1"><span class="hb'+(g.stale?' warn':'')+'"></span>'
      +'<span class="id mono" title="'+esc(g.agent_id)+'">'+esc(agShort(g.agent_id))+'</span>'
      +(g.label?'<span style="font-size:11px;color:var(--mut)">'+esc(g.label)+'</span>':'')
      +'<span class="tool">'+esc(TOOL_SHORT[g.tool]||g.tool||'?')+'</span>'
      +'<span class="role">'+esc(g.role||'')+'</span></div>'
      +'<div class="l2">'+(g.current_task
        ?'<span class="chip click" data-t="'+esc(g.current_task)+'" onclick="jumpTo(\\''+esc(r.run.run_id)+'\\',this.dataset.t)">'+esc(g.current_task)+'</span><span>'+doing+'</span>'
        :'<span style="color:var(--mut)">空闲</span>')
      +'<span class="hbt">'+(g.stale?(g.last_heartbeat_min+' 分钟没心跳'):(g.last_heartbeat_min===0?'心跳 刚刚':'心跳 '+g.last_heartbeat_min+' 分钟前'))+'</span></div></div>';
  }
  document.getElementById('agents').innerHTML=h||'<div class="empty" style="padding:8px">没有注册窗口</div>';
}
/* ---------- ⑤ pane 头 ---------- */
function renderPane(){
  var r=curRun(); var hd=document.getElementById('paneHd');
  if(!r){ hd.innerHTML='<span class="tt" style="color:var(--mut)">选择左侧需求</span>'; return }
  var m=RUN_ST[r.run.status]||['var(--st-draft)',r.run.status];
  var stt=r.status||{};
  hd.innerHTML='<span class="tt">'+esc(r.run.title||r.run.run_id)+'</span>'
    +'<span class="pill" style="--c:'+m[0]+'">'+esc(m[1])+'</span>'
    +'<span class="big">'+(stt.progress_pct==null?'—':stt.progress_pct+'%')+'</span>'
    +'<span class="wt">权重 '+(stt.weight_done==null?'—':stt.weight_done)+'/'+(stt.weight_total==null?'—':stt.weight_total)+'</span>'
    +'<div class="tabs"><button class="'+(tab==='dag'?'on':'')+'" onclick="tab=\\'dag\\';renderAll()">DAG</button>'
    +'<button class="'+(tab==='tbl'?'on':'')+'" onclick="tab=\\'tbl\\';renderAll()">任务表</button></div>';
  document.getElementById('dagwrap').style.display=tab==='dag'?'':'none';
  document.getElementById('legend').style.display=tab==='dag'?'':'none';
  document.getElementById('tbl').style.display=tab==='tbl'?'block':'none';
}
/* ---------- ⑤ DAG ---------- */
var NW=142,NH=52,HG=32,VG=16,PAD=16;
function taskAttempts(r,taskId){
  var ts=r.tasks||[]; for(var i=0;i<ts.length;i++) if(ts[i].task_id===taskId) return ts[i].attempts||0; return 0 }
function renderDag(){
  var r=curRun(); var svg=document.getElementById('dag');
  var chip=document.getElementById('foldChip'); if(chip)chip.classList.toggle('on',collapseDone);
  if(!r){ svg.setAttribute('height','40'); svg.innerHTML=''; return }
  var nodes=(r.graph.nodes||[]).slice(); var edges=(r.graph.edges||[]).slice();
  if(collapseDone){
    var folded=[]; var fid={};
    for(var i0=0;i0<nodes.length;i0++) if(FOLD[nodes[i0].status]){ folded.push(nodes[i0]); fid[nodes[i0].task_id]=1 }
    if(folded.length){
      nodes=nodes.filter(function(n){return !fid[n.task_id]});
      nodes.unshift({task_id:'__agg',title:'点击展开 '+folded.length+' 个',status:'agg'});
      var seen={}; var ne=[];
      for(var i1=0;i1<edges.length;i1++){ var e0=edges[i1];
        var from=fid[e0.from]?'__agg':e0.from;
        if(fid[e0.to]) continue;
        if(from==='__agg'){ var kk2=e0.kind+'>'+e0.to; if(seen[kk2])continue; seen[kk2]=1 }
        var c0={}; for(var p0 in e0) c0[p0]=e0[p0]; c0.from=from; ne.push(c0);
      }
      edges=ne;
      if(selEdge){ var still=false; for(var i2=0;i2<edges.length;i2++) if(edges[i2].edge_id===selEdge){still=true;break}
        if(!still){ selEdge=null; renderSidebar() } }
    }
  }
  LAST_DAG={nodes:nodes,edges:edges};
  if(!nodes.length){ svg.setAttribute('height','60'); svg.setAttribute('width','420');
    svg.innerHTML='<text x="16" y="34" fill="var(--mut)" font-size="12">此需求没有任务图(轻量模式或已收尾)</text>'; return }
  var depth={}; var i3;
  for(i3=0;i3<nodes.length;i3++) depth[nodes[i3].task_id]=0;
  var be=edges.filter(function(e){return e.kind==='blocks'});
  for(i3=0;i3<nodes.length;i3++)
    for(var i4=0;i4<be.length;i4++){ var b0=be[i4];
      if(depth[b0.to]!=null&&depth[b0.from]!=null&&depth[b0.to]<depth[b0.from]+1) depth[b0.to]=depth[b0.from]+1 }
  var cols={};
  nodes.slice().sort(function(a,b){return a.task_id<b.task_id?-1:1}).forEach(function(n){
    (cols[depth[n.task_id]]=cols[depth[n.task_id]]||[]).push(n) });
  var pos={}; var maxRow=1; var maxD=0;
  Object.keys(cols).sort(function(a,b){return a-b}).forEach(function(d){
    for(var i5=0;i5<cols[d].length;i5++) pos[cols[d][i5].task_id]={x:PAD+d*(NW+HG),y:PAD+i5*(NH+VG)};
    maxRow=Math.max(maxRow,cols[d].length); maxD=Math.max(maxD,Number(d)) });
  var W=PAD*2+(maxD+1)*(NW+HG)-HG; var H=PAD*2+maxRow*(NH+VG)-VG;
  svg.setAttribute('viewBox','0 0 '+W+' '+H); svg.setAttribute('width',W); svg.setAttribute('height',H);
  var s='<defs><marker id="ar" viewBox="0 0 10 10" refX="8.5" refY="5" markerWidth="6.5" markerHeight="6.5" orient="auto">'
    +'<path d="M0 0L10 5L0 10z" fill="var(--edge)"/></marker>'
    +'<marker id="arw" viewBox="0 0 10 10" refX="8.5" refY="5" markerWidth="6.5" markerHeight="6.5" orient="auto">'
    +'<path d="M0 0L10 5L0 10z" fill="var(--st-ready)"/></marker></defs>';
  for(var i6=0;i6<edges.length;i6++){ var e=edges[i6];
    var a=pos[e.from]; var b=pos[e.to]; if(!a||!b) continue;
    var eid=e.edge_id||('E'+i6);
    var x1=a.x+NW,y1=a.y+NH/2,x2=b.x,y2=b.y+NH/2,mx=(x1+x2)/2,my=(y1+y2)/2;
    var d='M'+x1+' '+y1+' C'+(x1+HG*0.55)+' '+y1+','+(x2-HG*0.55)+' '+y2+','+x2+' '+y2;
    var vis='';
    if(e.kind==='blocks'){
      var ok=e.satisfied!==false;
      vis='<path class="vis" d="'+d+'" fill="none" stroke="'+(ok?'var(--edge)':'var(--st-ready)')+'" stroke-width="1.6" marker-end="url(#'+(ok?'ar':'arw')+')"/>';
      if(!ok) vis+='<rect x="'+(mx-19)+'" y="'+(my-8)+'" width="38" height="15" rx="7.5" fill="color-mix(in srgb,var(--st-ready) 14%,var(--card))" stroke="var(--st-ready)" stroke-width="0.8"/>'
        +'<text x="'+mx+'" y="'+(my+3)+'" text-anchor="middle" font-size="9" fill="var(--st-ready)">等上游</text>';
    } else if(e.kind==='produces_context_for'){
      vis='<path class="vis" d="'+d+'" fill="none" stroke="var(--st-review)" stroke-width="1.4" stroke-dasharray="6 4" opacity="0.75"/>';
      var nrefs=(e.context_refs&&e.context_refs.length)||0;
      if(nrefs) vis+='<circle cx="'+mx+'" cy="'+my+'" r="8" fill="color-mix(in srgb,var(--st-review) 15%,var(--card))" stroke="var(--st-review)" stroke-width="0.9"/>'
        +'<text x="'+mx+'" y="'+(my+3)+'" text-anchor="middle" font-size="9" fill="var(--st-review)">'+nrefs+'</text>';
    } else {
      vis='<path class="vis" d="'+d+'" fill="none" stroke="var(--edge)" stroke-width="1.3" stroke-dasharray="2 4" opacity="0.6"/>';
    }
    s+='<g class="edge'+(selEdge===eid?' esel':'')+'" data-eid="'+eid+'" onclick="selectEdge(this.dataset.eid)">'
      +vis+'<path d="'+d+'" fill="none" stroke="transparent" stroke-width="11" pointer-events="stroke"/></g>';
  }
  var riskOf={};
  var rs=(r.status&&r.status.risks)||[];
  for(var i7=0;i7<rs.length;i7++) if(rs[i7].task_id) (riskOf[rs[i7].task_id]=riskOf[rs[i7].task_id]||[]).push(rs[i7]);
  for(var i8=0;i8<nodes.length;i8++){ var at=taskAttempts(r,nodes[i8].task_id);
    if(at) (riskOf[nodes[i8].task_id]=riskOf[nodes[i8].task_id]||[]).push({kind:'retry',n:at}) }
  for(var i9=0;i9<nodes.length;i9++){ var n=nodes[i9];
    var p=pos[n.task_id]; var st=stOf(n.status); var isAgg=n.task_id==='__agg';
    var cls='node'; if(n.status==='draft')cls+=' dim'; if(n.status==='cancelled')cls+=' cancel';
    if(n.task_id===selTask)cls+=' sel'; if(n.status==='claimed'||n.status==='working')cls+=' working';
    var row=null; var ts0=r.tasks||[];
    for(var iA=0;iA<ts0.length;iA++) if(ts0[iA].task_id===n.task_id){row=ts0[iA];break}
    var click=isAgg?'collapseDone=false;renderAll()':'selectNode(this.dataset.nid)';
    var title=String(n.title||'');
    s+='<g class="'+cls+'" style="--c:'+st.c+'" data-nid="'+esc(n.task_id)+'" onclick="'+click+'" onmouseenter="hov(this.dataset.nid)" onmouseleave="hov(null)">'
      +'<rect class="bx" x="'+p.x+'" y="'+p.y+'" width="'+NW+'" height="'+NH+'" rx="9"'+(isAgg?' stroke-dasharray="5 4"':'')+'/>'
      +'<text class="nid" x="'+(p.x+10)+'" y="'+(p.y+19)+'">'+st.g+' '+(isAgg?'已收尾组':esc(n.task_id.replace('TASK-','T')))+'</text>'
      +'<text class="nti" x="'+(p.x+10)+'" y="'+(p.y+37)+'">'+esc(title.length>10?title.slice(0,9)+'…':title)+'</text>';
    if(row&&row.owner_agent_id) s+='<text class="now" x="'+(p.x+NW-8)+'" y="'+(p.y+19)+'" text-anchor="end"><title>'+esc(row.owner_agent_id)+'</title>'+esc(agShort(row.owner_agent_id))+'</text>';
    var rk=riskOf[n.task_id];
    if(rk&&!isAgg){
      var isAlert=false; var hasStale=false; var tip=[];
      for(var iB=0;iB<rk.length;iB++){ var k3=rk[iB];
        if(k3.kind==='unresolved_blocker')isAlert=true;
        if(k3.kind==='stale_lease')hasStale=true;
        tip.push(k3.kind==='stale_lease'?('租约超时 '+k3.minutes_overdue+' 分钟'):(k3.kind==='retry'?('重试第 '+(k3.n+1)+' 次'):k3.kind)) }
      var col=isAlert?'var(--st-alert)':'var(--st-ready)';
      var icon=isAlert?'⛔':(hasStale?'⏱':'↻');
      s+='<g><title>'+esc(tip.join(' / '))+'</title>'
        +'<circle cx="'+(p.x+NW-2)+'" cy="'+(p.y+2)+'" r="8.5" fill="color-mix(in srgb,'+col+' 16%,var(--card))" stroke="'+col+'" stroke-width="1"/>'
        +'<text class="rk" x="'+(p.x+NW-2)+'" y="'+(p.y+5.5)+'" text-anchor="middle" fill="'+col+'">'+(rk.length>1?rk.length:icon)+'</text></g>';
    }
    s+='</g>';
  }
  svg.innerHTML=s;
}
/* ---------- ⑤ 任务表 ---------- */
var TBL_ORDER=['blocked','changes_requested','reviewing','submitted','working','claimed','approved','ready','draft','verified','integrated','done','cancelled'];
function edgeSatMap(r){
  var m={}; var es=(r.graph&&r.graph.edges)||[];
  for(var i=0;i<es.length;i++) if(es[i].kind==='blocks') m[es[i].from+'>'+es[i].to]=es[i].satisfied!==false;
  return m }
function renderTable(){
  var r=curRun(); var tb=document.getElementById('tbody');
  if(!r){ tb.innerHTML=''; return }
  var riskOf={};
  var rs=(r.status&&r.status.risks)||[];
  for(var i=0;i<rs.length;i++) if(rs[i].task_id) (riskOf[rs[i].task_id]=riskOf[rs[i].task_id]||[]).push(rs[i]);
  var sat=edgeSatMap(r);
  var rows=(r.tasks||[]).slice().sort(function(a,b){
    var d=TBL_ORDER.indexOf(a.status)-TBL_ORDER.indexOf(b.status);
    return d!==0?d:(a.task_id<b.task_id?-1:1) });
  var total=rows.length;
  if(hideClosed) rows=rows.filter(function(t){return !FOLD[t.status]});
  document.getElementById('hideChip').classList.toggle('on',hideClosed);
  document.getElementById('tblcount').textContent=hideClosed
    ?rows.length+'/'+total+' 项(已收尾折叠 —— 历史不删除,账本可回放)':total+' 项';
  var h='';
  for(var j=0;j<rows.length;j++){ var t=rows[j]; var st=stOf(t.status);
    var deps=''; var dl=t.depends_on||[];
    for(var k=0;k<dl.length;k++){ var dep=dl[k]; var ok=sat[dep+'>'+t.task_id]!==false;
      deps+='<span class="depchip'+(ok?'':' unmet')+'" title="'+(ok?'上游已过闸门':'上游未过闸门')+'" data-t="'+esc(dep)+'" onclick="event.stopPropagation();selectNode(this.dataset.t)">'+esc(dep.replace('TASK-','T'))+'</span>' }
    if(!deps) deps='<span style="color:var(--mut)">—</span>';
    var rkh=''; var rl=riskOf[t.task_id]||[];
    for(var k1=0;k1<rl.length;k1++){ var k4=rl[k1];
      if(k4.kind==='stale_lease') rkh+='<span title="租约超时 '+k4.minutes_overdue+' 分钟">⏱ '+k4.minutes_overdue+'m</span> ';
      else if(k4.kind==='unresolved_blocker') rkh+='<span title="阻塞未答">⛔</span> ' }
    if(t.attempts) rkh+='<span title="第 '+(t.attempts+1)+' 次尝试,重试档案见侧栏">↻'+t.attempts+'</span>';
    if(!rkh) rkh='<span style="color:var(--mut)">—</span>';
    h+='<tr class="'+(t.task_id===selTask?'sel':'')+'" data-t="'+esc(t.task_id)+'" onclick="selectNode(this.dataset.t)">'
      +'<td class="mono" style="font-size:11px">'+esc(t.task_id)+'</td>'
      +'<td style="max-width:190px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap">'+esc(t.title||'')+'</td>'
      +'<td style="color:var(--mut);font-size:11px">'+esc(t.type||'—')+'</td>'
      +'<td><span class="pill" style="--c:'+st.c+'">'+st.g+' '+st.zh+'</span></td>'
      +'<td class="mono" style="font-size:11px">'+esc(t.owner_agent_id||'—')+'</td>'
      +'<td>'+deps+'</td><td style="color:var(--st-ready)">'+rkh+'</td></tr>';
  }
  tb.innerHTML=h;
}
/* ---------- ⑥ 侧栏 ---------- */
function renderSidebar(){
  var r=curRun(); var el=document.getElementById('sidebar');
  if(!r){ el.innerHTML='<div class="empty" style="padding-top:60px">选择左侧需求</div>'; return }
  if(selEdge){ var es=(r.graph&&r.graph.edges)||[];
    for(var i=0;i<es.length;i++) if(es[i].edge_id===selEdge){ renderEdgeCard(el,r,es[i]); return }
    selEdge=null }
  var t=null; var ts=r.tasks||[];
  for(var j=0;j<ts.length;j++) if(ts[j].task_id===selTask){t=ts[j];break}
  if(!t){ var u=(r.run&&r.run.user_state)||{};
    el.innerHTML='<div class="empty" style="padding-top:60px">点击 DAG 节点或任务行查看详情<br><br><span style="font-size:11px">'+esc(u.detail||'')+'</span></div>';
    return }
  var st=stOf(t.status);
  var d=(DKEY===selRun+'/'+selTask&&DETAIL&&!DETAIL.error)?DETAIL:null;
  var h='';
  var ownLine='owner <span class="mono">'+esc(t.owner_agent_id||'—')+'</span>';
  if(d&&d.claims&&d.claims.length){
    var live=null;
    for(var c0=0;c0<d.claims.length;c0++){ var c=d.claims[c0];
      if(c.status==='active'||c.status==='submitted'){live=c} }
    if(live){
      ownLine+=' · '+esc(live.claim_id||'claim')+' · '+(live.attempt>1?('第 '+live.attempt+' 次尝试 · '):'');
      if(live.status==='submitted') ownLine+='已提交待评审';
      else { var rem=Math.round((Date.parse(live.lease_until)-Date.now())/60000);
        ownLine+=rem>=0?('租约剩 '+rem+' 分'):('租约已超 '+(-rem)+' 分') }
    }
  }
  h+='<div id="sbHead"><div class="l1"><span class="tid mono">'+esc(t.task_id)+'</span>'
    +'<span class="pill" style="--c:'+st.c+'">'+st.g+' '+st.zh+'</span>'
    +'<span class="ty">'+esc(t.type||'—')+'</span>'
    +'<span class="drawerx" onclick="closeDrawer()">✕</span></div>'
    +'<div class="tt">'+esc(t.title||'')+'</div>'
    +'<div class="own">'+ownLine+'</div></div>';
  if(!d){
    h+='<div class="empty">'+(DETAIL&&DETAIL.error?('详情加载失败:'+esc(DETAIL.message||DETAIL.error)):'加载详情…')+'</div>';
    el.innerHTML=h; return;
  }
  var task=d.task||{};
  /* A 档案 */
  var sat=edgeSatMap(r);
  var deps=''; var dl=t.depends_on||[];
  for(var k=0;k<dl.length;k++){ var dep=dl[k]; var ok=sat[dep+'>'+t.task_id]!==false;
    deps+='<span class="depchip'+(ok?'':' unmet')+'" data-t="'+esc(dep)+'" onclick="selectNode(this.dataset.t)">'+esc(dep)+(ok?'':' ·等')+'</span>' }
  if(!deps) deps='<span style="color:var(--mut)">无</span>';
  var paths=task.paths||{};
  var pallow=(paths.allow||[]).map(function(x){return esc(x)}).join('<br>')||'—';
  var pra=paths.requires_approval||[];
  var acc=task.acceptance||[];
  var risksH='';
  var rl=((r.status&&r.status.risks)||[]).filter(function(x){return x.task_id===t.task_id});
  for(var k5=0;k5<rl.length;k5++){ var kk=rl[k5];
    if(kk.kind==='stale_lease') risksH+='<div class="riskline warn">⏱ 租约超时 '+kk.minutes_overdue+' 分钟('+esc(kk.agent_id||'')+')—— 收件箱有回收命令</div>';
    else if(kk.kind==='unresolved_blocker') risksH+='<div class="riskline">⛔ 阻塞未答('+esc(kk.message_id||'')+')—— 见收件箱</div>' }
  var wt=d.worktree;
  h+='<div class="sec"><h5>任务档案</h5>'
    +'<div class="kv"><b>目标</b><div class="v">'+esc(task.objective||task.goal||'—')+'</div></div>'
    +(acc.length?'<div class="kv"><b>验收</b><div class="v">'+acc.map(function(x){return '· '+esc(x)}).join('<br>')+'</div></div>':'')
    +'<div class="kv"><b>依赖</b><div class="v">'+deps+'</div></div>'
    +'<div class="kv"><b>路径</b><div class="v mono" style="font-size:11px">'+pallow
    +(pra.length?'<br><span style="color:var(--st-ready)">待批准: '+pra.map(function(x){return esc(x)}).join(', ')+'</span>':'')+'</div></div>'
    +'<div class="kv"><b>权重</b><div class="v">'+(task.weight==null?'—':task.weight)+'</div></div>'
    +(wt&&wt.branch?'<div class="kv"><b>分支</b><div class="v mono" style="font-size:11px">'+esc(wt.branch)+' <span style="color:var(--mut)">('+esc(wt.status||'')+')</span></div></div>':'')
    +risksH+'</div>';
  /* B evidence */
  var ev=d.evidence;
  if(ev){
    var checks=ev.required_checks_results||[];
    var pass=checks.filter(function(c){return c.status==='pass'}).length;
    var cf=ev.changed_files||[];
    h+='<div class="sec"><h5>Evidence · 第 '+(ev.revision==null?'?':ev.revision)+' 版'
      +((d.history&&d.history.length)?'('+d.history.length+' 次归档)':'')+'</h5>'
      +(checks.length?'<div style="font-size:12px;color:var(--ink2);margin-bottom:6px">checks '+pass+'/'+checks.length+' 通过</div>':'')
      +checks.map(function(c){ return '<div class="ck"><code>'+esc(c.check||c.name||c.cmd||'')+'</code>'
        +'<span class="ckpill" style="--c:'+(c.status==='pass'?'var(--st-approved)':'var(--st-alert)')+'">'+(c.status==='pass'?'✓ pass':'✗ '+esc(c.status||'fail'))+'</span></div>' }).join('')
      +(cf.length?'<div style="font-size:11.5px;color:var(--mut);margin:8px 0 3px">改动文件 · '+cf.length+'</div>'
        +cf.map(function(f){ return '<div class="cf"><code title="'+esc(f.path)+'">'+esc(f.path)+'</code>'+(f.in_scope===false?'<span class="oob">越界</span>':'')+'</div>' }).join(''):'')
      +(ev.summary?'<div class="sum">'+esc(ev.summary)+'</div>':'')
      +'</div>';
  } else {
    h+='<div class="sec"><h5>Evidence</h5><div style="color:var(--mut);font-size:12px">尚未提交</div></div>';
  }
  /* C 评审轮次 */
  var revs=d.reviews||[];
  var inReview=t.status==='reviewing'||t.status==='submitted';
  if(revs.length||inReview){
    var cards='';
    for(var k6=0;k6<revs.length;k6++){ var rv=revs[k6];
      var dz=DECISION_ZH[rv.decision]||[rv.decision,'var(--st-draft)'];
      var fh=''; var fl=rv.findings||[];
      for(var k7=0;k7<fl.length;k7++){ var f=fl[k7];
        fh+='<div class="find"><span class="mf'+(f.must_fix?'':' ok')+'">'+(f.must_fix?'must_fix':'建议')+'</span>'
          +'<span>'+esc(f.message||'')+(f.message_ref?' <span class="chip mono">'+esc(f.message_ref)+'</span>':'')+'</span></div>' }
      var oos=(rv.scope_check&&rv.scope_check.out_of_scope_files)||[];
      cards+='<div class="rev"><div class="l1"><span class="rid mono">'+esc(rv.review_id||('第 '+rv.round+' 轮'))+'</span>'
        +'<span class="ckpill" style="--c:'+dz[1]+'">'+esc(dz[0])+'</span>'
        +'<span class="chip">评审人 '+esc(rv.reviewer_agent_id||'?')+'</span>'
        +'<span class="chip">evidence 第 '+(rv.evidence_revision==null?'?':rv.evidence_revision)+' 版</span>'
        +'<span class="when">'+hhmmss(rv.completed_at||'')+'</span></div>'+fh
        +(oos.length?'<div class="find"><span class="mf">越界</span><span class="mono" style="font-size:11px">'+oos.map(function(x){return esc(x)}).join(', ')+'</span></div>':'')
        +'</div>' }
    h+='<div class="sec"><h5>评审轮次 · '+revs.length+'</h5>'+cards
      +(t.status==='reviewing'?'<div style="font-size:11.5px;color:var(--st-review);margin-top:4px">◐ 第 '+(revs.length+1)+' 轮评审进行中</div>'
        :(t.status==='submitted'?'<div style="font-size:11.5px;color:var(--st-review);margin-top:4px">◐ 已提交,等第 '+(revs.length+1)+' 轮评审认领</div>':''))
      +'</div>';
  }
  /* D 验证 */
  var vers=d.verifications||[];
  if(vers.length){
    var vh='';
    for(var k8=0;k8<vers.length;k8++){ var v=vers[k8];
      var vc=v.checks||[];
      vh+='<div class="rev"><div class="l1"><span class="ckpill" style="--c:'+(v.verdict==='pass'?'var(--st-done)':'var(--st-alert)')+'">'+(v.verdict==='pass'?'✓ 通过':'✗ 未过')+'</span>'
        +'<span class="rid mono">'+esc(v.verify_id||'')+'</span>'
        +'<span class="chip">验证人 '+esc(v.verifier_agent_id||'?')+'</span>'
        +'<span class="when">'+hhmmss(v.executed_at||'')+'</span></div>'
        +vc.map(function(c){ return '<div class="ck"><code>'+esc(c.name||c.cmd||'')+'</code>'
          +(c.exit_code!=null?'<span style="font-size:10.5px;color:var(--mut)">exit '+c.exit_code+'</span>':'')
          +'<span class="ckpill" style="--c:'+(c.status==='pass'?'var(--st-approved)':'var(--st-alert)')+'">'+esc(c.status||'')+'</span></div>' }).join('')
        +((v.failures_mapped&&v.failures_mapped.length)?'<div class="find"><span class="mf">映射</span><span>'+v.failures_mapped.map(function(x){return esc(typeof x==='string'?x:JSON.stringify(x))}).join('; ')+'</span></div>':'')
        +'</div>' }
    h+='<div class="sec"><h5>验证 · '+vers.length+'</h5>'+vh+'</div>';
  } else if(t.status==='approved'){
    h+='<div class="sec"><h5>验证</h5><div class="riskline warn">◑ 等独立验证 —— 认领命令在收件箱</div></div>';
  }
  /* E 重试档案 */
  var pa=task.previous_attempts||[];
  if(pa.length){
    var ah='';
    for(var k9=0;k9<pa.length;k9++){ var a2=pa[k9];
      ah+='<div class="att"><span class="no">↻'+(a2.attempt==null?(k9+1):a2.attempt)+'</span>'
        +'<span><span class="mono">'+esc(a2.agent_id||'?')+'</span> 的租约被回收('+esc(a2.reclaim_reason==='lease_expired_sweep'?'超时清扫':(a2.reclaim_reason||''))+')· '+esc((a2.ended_at||'').replace('T',' ').slice(5,16))
        +(a2.branch?'<br>遗留分支 <span class="mono" style="font-size:10.5px">'+esc(a2.branch)+'</span>'
          +(a2.worktree_path?' —— <span class="copy" data-cmd="git worktree remove '+esc(a2.worktree_path)+' --force" onclick="copyText(this,this.dataset.cmd)">复制清理命令</span>':''):'')
        +'</span></div>' }
    h+='<div class="sec"><h5>重试档案 · '+pa.length+' 次前尝试</h5>'+ah+'</div>';
  }
  /* F 消息 */
  var ms=d.messages||[];
  if(ms.length){
    var mh='';
    for(var kA=0;kA<ms.length;kA++){ var m=ms[kA];
      var mc=(m.type==='blocker'||m.type==='request_changes')?'var(--st-alert)':(m.type==='answer'?'var(--st-approved)':'var(--st-ready)');
      var open=(m.type==='blocker'||m.type==='question')&&!m.answered;
      mh+='<div class="msgc" style="--c:'+mc+'"><div class="l1"><span class="ty2">'+esc(m.type)+'</span>'
        +'<span class="chip mono">'+esc(m.message_id||'')+'</span>'
        +'<span class="chip">来自 '+esc(m.from_agent_id||'?')+'</span>'
        +(open?'<span style="font-size:10.5px;color:var(--st-alert)">未答 · '+agoText(m.created_at)+'</span>'
          :((m.type==='blocker'||m.type==='question')?'<span style="font-size:10.5px;color:var(--st-approved)">已答</span>':''))
        +'</div><div class="bd2">'+esc(m.body||'')+'</div></div>' }
    h+='<div class="sec"><h5>消息 · '+ms.length+'</h5>'+mh+'</div>';
  }
  /* G 时间线 */
  var evd=d.ev||{events:[],total:0};
  var evs=(evd.events||[]).slice().reverse();
  var th='';
  for(var kB=0;kB<evs.length;kB++){ var e2=evs[kB];
    var stc=EV_STATUS[e2.event]?stOf(EV_STATUS[e2.event]).c:'var(--st-draft)';
    var actor=e2.actor&&e2.actor.id?e2.actor.id:'?';
    var chips=payChips(e2.payload);
    var open=!!EXPAND[e2.seq];
    th+='<div class="ev" style="--c:'+stc+'" data-seq="'+e2.seq+'" onclick="toggleEv(this.dataset.seq)"><span class="pt"></span>'
      +'<div class="l1"><span class="nm">'+esc(EV_ZH[e2.event]||e2.event)+'</span>'
      +'<span class="chip" title="'+esc(actor)+'">'+esc(agShort(actor))+'</span>'
      +'<span class="chev">'+(open?'▾':'▸')+'</span></div>'
      +'<div class="meta2 mono">#'+e2.seq+' · '+hhmmss(e2.ts||'')+(e2.claim_id?' · '+esc(e2.claim_id):'')+'</div>'
      +(chips?'<div>'+chips+'</div>':'')
      +(open?'<pre class="full">'+esc(JSON.stringify({event:e2.event,seq:e2.seq,ts:e2.ts,actor:e2.actor,task_id:e2.task_id,claim_id:e2.claim_id,payload:e2.payload||{}},null,2))+'</pre>':'')
      +'</div>' }
  h+='<div class="sec"><h5>事件时间线</h5>'
    +(th?'<div class="tl">'+th+'</div>':'<div style="color:var(--mut);font-size:12px">暂无事件</div>')
    +((evd.total>evs.length)?'<div class="more">共 '+evd.total+' 条,显示最近 '+evs.length+' 条 · '
      +'<span class="copy" data-cmd="sigmarun events '+esc(selRun)+' --task='+esc(t.task_id)+' --limit=0" onclick="copyText(this,this.dataset.cmd)">复制完整命令</span></div>':'')
    +'</div>';
  el.innerHTML=h;
}
function renderEdgeCard(el,r,e){
  var k=EDGE_ZH[e.kind]||{zh:e.kind,note:''};
  var fromSt=''; var ns=(r.graph&&r.graph.nodes)||[];
  for(var i=0;i<ns.length;i++) if(ns[i].task_id===e.from){fromSt=ns[i].status;break}
  var ok=e.satisfied!==false;
  var kc=e.kind==='produces_context_for'?'var(--st-review)':(e.kind==='blocks'?(ok?'var(--st-approved)':'var(--st-ready)'):'var(--edge)');
  var body='';
  if(e.kind==='blocks'){
    body='<div class="kv"><b>闸门</b><div class="v">上游过独立验证(verified/integrated/done,run policy 可调)前,下游不可被领取(required='+(e.required!==false)+')</div></div>'
      +'<div class="kv"><b>判定</b><div class="v">'+(ok
        ?'<span style="color:var(--st-approved);font-weight:650">已满足</span> —— 上游 '+esc(e.from)+' 已「'+stOf(fromSt).zh+'」'
        :'<span style="color:var(--st-ready);font-weight:650">未满足</span> —— 上游 '+esc(e.from)+' 还在「'+stOf(fromSt).zh+'」,'+esc(e.to)+' 因此不可领')+'</div></div>';
  } else if(e.kind==='produces_context_for'){
    var refs=e.context_refs||[];
    body='<div class="kv"><b>refs</b><div class="v">'+(refs.length
        ?refs.map(function(x){return '<div class="refline"><code>'+esc(typeof x==='string'?x:JSON.stringify(x))+'</code></div>'}).join('')
        :'此边未携带 context_refs(载荷未提供;演进项)')+'</div></div>'
      +'<div class="kv"><b>hydrate</b><div class="v">下游认领时,上游产出作为 must_read 注入</div></div>';
  }
  el.innerHTML='<div class="edgehead"><div class="l1"><b class="mono" style="font-size:13px">'+esc(e.edge_id||'边')+'</b>'
    +'<span class="pill" style="--c:'+kc+'">'+esc(k.zh)+'</span>'
    +'<span class="copy" style="margin-left:auto" onclick="selEdge=null;renderAll();renderSidebar()">✕ 关闭</span></div>'
    +'<div class="l1" style="margin-top:8px"><span class="chip click" data-t="'+esc(e.from)+'" onclick="selectNode(this.dataset.t)">'+esc(e.from)+'</span>'
    +'<span class="earrow">→</span>'
    +'<span class="chip click" data-t="'+esc(e.to)+'" onclick="selectNode(this.dataset.t)">'+esc(e.to)+'</span></div></div>'
    +'<div class="sec"><h5>关系</h5>'+body+'<div class="kv"><b>说明</b><div class="v">'+esc(k.note)+'</div></div></div>';
}
/* ---------- 主题 / 复制 ---------- */
var THEMES=['auto','light','dark'];
function themeGet(){ try{return localStorage.getItem('sigmarun-dash-theme')||'auto'}catch(e){return 'auto'} }
function applyTheme(t){
  if(t==='auto') document.documentElement.removeAttribute('data-theme');
  else document.documentElement.setAttribute('data-theme',t);
  document.getElementById('themeBtn').textContent='主题:'+({auto:'自动',light:'亮',dark:'暗'}[t]);
  try{localStorage.setItem('sigmarun-dash-theme',t)}catch(e){}
}
function cycleTheme(){ applyTheme(THEMES[(THEMES.indexOf(themeGet())+1)%THEMES.length]) }
function copyText(btn,text){
  var done=function(){ var old=btn.textContent; btn.textContent='已复制';
    setTimeout(function(){btn.textContent=old},1200) };
  if(navigator.clipboard&&navigator.clipboard.writeText) navigator.clipboard.writeText(text).then(done,function(){fallbackCopy(text,done)});
  else fallbackCopy(text,done);
}
function fallbackCopy(text,done){
  var ta=document.createElement('textarea'); ta.value=text;
  ta.style.position='fixed'; ta.style.opacity='0'; document.body.appendChild(ta);
  ta.select(); try{document.execCommand('copy')}catch(e){} document.body.removeChild(ta); done();
}
function renderAll(){
  if(!STATE) return;
  renderInbox(); renderRuns(); renderAgents(); renderPane(); renderDag(); renderTable(); renderSidebar();
}
applyTheme(themeGet());
tick();
</script></body></html>`;
