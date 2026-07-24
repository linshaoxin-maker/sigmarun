/**
 * Read-only local dashboard (docs/23; front-end concern, so it lives in cli).
 *
 * Aggregates the existing read model — runList/statusRun/taskList (watch) + showGraph
 * (context) — into one JSON, and serves a single self-contained HTML page that polls it.
 * Strictly read-only by construction: nothing here imports a write primitive, so the
 * architecture test's read-model rule holds. No npm deps, no CDN — the page is inline.
 */
import { createServer, type Server } from 'node:http';
import { runList, statusRun, taskList } from '@sigmarun/watch';
import { showGraph } from '@sigmarun/context';
import { okEnvelope, type Envelope } from '@sigmarun/core';

export interface DashboardOptions {
  cwd?: string;
  env?: Record<string, string | undefined>;
  teamRootFlag?: string;
  runId?: string;
}

interface RunRow { run_id: string; title?: string; status: string; lightweight?: boolean; progress_pct?: number | null; user_state?: unknown }

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
    return {
      run: r,
      status: st.ok ? st.data : { error: st.code },
      tasks: tl.ok ? ((tl.data as { tasks?: unknown[] }).tasks ?? []) : [],
      graph: g.ok ? g.data : { nodes: [], edges: [] },
    };
  });
  return okEnvelope({
    message: `Dashboard state: ${detail.length} run(s).`,
    data: { generated_at: new Date().toISOString(), runs: detail },
    startedAt,
  });
}

/** Start the HTTP shell. Caller owns lifecycle (CLI keeps the process alive; tests close()). */
export function serveDashboard(opts: DashboardOptions & { port: number }): Server {
  const server = createServer((req, res) => {
    const url = req.url ?? '/';
    if (url.startsWith('/api/state')) {
      const env = dashboardState(opts);
      res.writeHead(200, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' });
      res.end(JSON.stringify(env));
      return;
    }
    if (url === '/' || url.startsWith('/index')) {
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

const PAGE = `<!doctype html>
<html lang="zh"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>sigmarun dashboard</title>
<style>
  :root{--bg:#f5f8f7;--card:#fff;--ink:#15211f;--mut:#5f6e6a;--line:#dbe5e2;--acc:#0f6e56}
  @media(prefers-color-scheme:dark){:root{--bg:#0d1413;--card:#151f1d;--ink:#e7eeec;--mut:#9aa9a5;--line:#26322f;--acc:#5dcaa5}}
  *{box-sizing:border-box}body{margin:0;font:14px/1.6 ui-sans-serif,system-ui,"PingFang SC",sans-serif;background:var(--bg);color:var(--ink)}
  header{padding:14px 20px;border-bottom:1px solid var(--line);display:flex;gap:12px;align-items:baseline}
  header b{font-size:16px}#stamp{color:var(--mut);font-size:12px;margin-left:auto}
  .wrap{display:grid;grid-template-columns:240px 1fr;gap:16px;padding:16px;max-width:1200px;margin:0 auto}
  .card{background:var(--card);border:1px solid var(--line);border-radius:10px;padding:12px}
  .run{padding:8px 10px;border-radius:8px;cursor:pointer;border:1px solid transparent}
  .run:hover{border-color:var(--line)}.run.sel{border-color:var(--acc)}
  .run .id{font-family:ui-monospace,monospace;font-size:12px}.run .st{color:var(--mut);font-size:12px}
  h3{margin:0 0 8px;font-size:13px;color:var(--mut);font-weight:600;text-transform:uppercase;letter-spacing:.06em}
  table{width:100%;border-collapse:collapse;font-size:13px}
  th,td{text-align:left;padding:6px 8px;border-bottom:1px solid var(--line)}th{color:var(--mut);font-weight:600}
  .pill{display:inline-block;padding:1px 8px;border-radius:99px;font-size:12px;color:#fff}
  .needs li{margin:6px 0}.needs code{background:rgba(127,127,127,.15);padding:1px 6px;border-radius:5px;font-size:12px}
  #banner{font-size:15px;margin-bottom:10px}
  svg text{font:12px ui-monospace,monospace}
  .col{display:flex;flex-direction:column;gap:16px}
  #dagwrap{overflow-x:auto}
</style></head><body>
<header><b>sigmarun dashboard</b><span style="color:var(--mut)">只读 · 2.5s 自刷新</span><span id="stamp"></span></header>
<div class="wrap">
  <div class="card"><h3>需求 runs</h3><div id="runs"></div></div>
  <div class="col">
    <div class="card"><div id="banner">加载中…</div><div class="needs" id="needs"></div></div>
    <div class="card"><h3>任务 DAG</h3><div id="dagwrap"><svg id="dag" width="100%" height="10"></svg></div></div>
    <div class="card"><h3>任务表</h3><table id="tasks"><thead><tr><th>ID</th><th>标题</th><th>状态</th><th>owner</th></tr></thead><tbody></tbody></table></div>
  </div>
</div>
<script>
const COLOR={draft:'#888780',ready:'#ba7517',claimed:'#185fa5',working:'#185fa5',blocked:'#a32d2d',submitted:'#534ab7',reviewing:'#534ab7',changes_requested:'#a32d2d',approved:'#1d9e75',verified:'#0f6e56',integrated:'#0f6e56',done:'#0f6e56',cancelled:'#5f5e5a'};
let sel=null;
async function tick(){
  try{
    const env=await (await fetch('/api/state')).json();
    if(!env.ok){document.getElementById('banner').textContent='错误:'+env.code+' — '+env.message;return}
    const runs=env.data.runs;document.getElementById('stamp').textContent=env.data.generated_at.replace('T',' ').slice(0,19);
    if(!sel&&runs.length)sel=runs[0].run.run_id;
    renderRuns(runs);const cur=runs.find(r=>r.run.run_id===sel);if(cur)renderRun(cur);
    else document.getElementById('banner').textContent=runs.length?'选择左侧需求':'还没有需求 — 在 Claude Code/Codex 里 /team-plan 一个吧';
  }catch(e){document.getElementById('stamp').textContent='连接断开,重试中…'}
}
function renderRuns(runs){
  const el=document.getElementById('runs');
  el.innerHTML=runs.map(r=>{const u=r.run.user_state||{};return '<div class="run'+(r.run.run_id===sel?' sel':'')+'" onclick="sel=\\''+r.run.run_id+'\\';tick()">'
    +'<div class="id">'+r.run.run_id+(r.run.lightweight?' · 轻量':' · full')+'</div>'
    +'<div>'+esc(r.run.title||'')+'</div>'
    +'<div class="st">'+(u.state||r.run.status)+(r.run.progress_pct!=null?' · '+r.run.progress_pct+'%':'')+'</div></div>'}).join('');
}
function renderRun(r){
  const u=(r.status&&r.status.user_state)||{};
  document.getElementById('banner').innerHTML='<b>'+r.run.run_id+'</b> '+esc(r.run.title||'')+' — <b>'+(u.state||r.run.status)+'</b>'+(u.detail?' · '+esc(u.detail):'');
  const needs=(r.status&&r.status.needs_user)||[];
  document.getElementById('needs').innerHTML=needs.length?'<h3>需要你处理</h3><ul>'+needs.map(n=>'<li>['+n.kind+'] '+esc(n.detail)+(n.command?'<br><code>'+esc(n.command)+'</code>':'')+'</li>').join('')+'</ul>':'';
  const tb=document.querySelector('#tasks tbody');
  tb.innerHTML=(r.tasks||[]).map(t=>'<tr><td class="id">'+t.task_id+'</td><td>'+esc(t.title||'')+'</td><td><span class="pill" style="background:'+(COLOR[t.status]||'#888')+'">'+t.status+'</span></td><td>'+(t.owner_agent_id||'—')+'</td></tr>').join('');
  drawDag(r.graph&&r.graph.nodes||[],r.graph&&r.graph.edges||[]);
}
function drawDag(nodes,edges){
  const svg=document.getElementById('dag');
  if(!nodes.length){svg.setAttribute('height','30');svg.innerHTML='<text x="8" y="20" fill="#888">无节点</text>';return}
  const depth={},ein={};nodes.forEach(n=>{depth[n.task_id]=0;ein[n.task_id]=[]});
  edges.forEach(e=>{if(ein[e.to])ein[e.to].push(e.from)});
  for(let i=0;i<nodes.length;i++)nodes.forEach(n=>{depth[n.task_id]=Math.max(0,...(ein[n.task_id]||[]).map(f=>(depth[f]??0)+1))});
  const cols={};nodes.forEach(n=>{(cols[depth[n.task_id]]=cols[depth[n.task_id]]||[]).push(n)});
  const W=170,H=64,pos={};let maxRow=1;
  Object.keys(cols).sort((a,b)=>a-b).forEach(d=>{cols[d].forEach((n,i)=>{pos[n.task_id]={x:24+d*W,y:16+i*H};});maxRow=Math.max(maxRow,cols[d].length)});
  const width=24+(Math.max(...Object.keys(cols).map(Number))+1)*W,height=16+maxRow*H+8;
  svg.setAttribute('viewBox','0 0 '+width+' '+height);svg.setAttribute('height',Math.min(height,420));
  let s='<defs><marker id="m" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="6" markerHeight="6" orient="auto"><path d="M0 0L10 5L0 10z" fill="#888780"/></marker></defs>';
  edges.forEach(e=>{const a=pos[e.from],b=pos[e.to];if(!a||!b)return;const x1=a.x+140,y1=a.y+22,x2=b.x,y2=b.y+22;
    s+='<path d="M'+x1+' '+y1+' C'+(x1+18)+' '+y1+','+(x2-18)+' '+y2+','+x2+' '+y2+'" fill="none" stroke="#888780" stroke-width="1.5" marker-end="url(#m)"/>'});
  nodes.forEach(n=>{const p=pos[n.task_id];
    s+='<g><rect x="'+p.x+'" y="'+p.y+'" width="140" height="44" rx="8" fill="'+(COLOR[n.status]||'#888')+'" opacity="0.92"/>'
     +'<text x="'+(p.x+10)+'" y="'+(p.y+18)+'" fill="#fff">'+n.task_id+'</text>'
     +'<text x="'+(p.x+10)+'" y="'+(p.y+34)+'" fill="#fff" opacity="0.85">'+esc((n.title||'').slice(0,10))+'</text></g>'});
  svg.innerHTML=s;
}
function esc(s){return String(s).replace(/[&<>"]/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;'}[c]))}
tick();setInterval(tick,2500);
</script></body></html>`;
