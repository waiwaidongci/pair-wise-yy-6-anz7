import http from "node:http";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const dbPath = join(__dirname, "data", "ink-stick-testing.json");
const port = Number(process.env.PORT || 3037);
const stages = ["待试磨", "待复核", "已试磨", "重点观察"];
const statLabels = stages;
const dispositions = ["通过复核", "继续观察", "重开试磨"];
// 首次记录必须填写的考核项（纸张、加水量为辅助信息，不参与能否通过复核）
const requiredRoundKeys = ["speed", "colorLayer", "sediment", "score"];
const requiredRoundLabels = { speed: "出墨速度", colorLayer: "墨色层次", sediment: "沉淀", score: "评分" };

const seed = {
  "version": 2,
  "items": [
    {
      "id": "seed-is-001",
      "code": "IS-001",
      "smokeSource": "黄山松烟",
      "glueRatio": "7.5%",
      "ageYears": 8,
      "storage": "恒湿柜B",
      "logs": [
        { "at": "2026-06-10T09:00", "step": "建档", "note": "创建墨锭" },
        { "at": "2026-06-11T10:20", "step": "试磨", "note": "沈墨工首次记录：宣纸20滴水，评分86" },
        { "at": "2026-06-12T14:05", "step": "复核", "note": "周研 复核通过：符合入藏标准" }
      ],
      "rounds": [
        {
          "id": "seed-r-001",
          "at": "2026-06-11T10:20",
          "recorder": "沈墨工",
          "paper": "宣纸",
          "water": "20滴",
          "speed": "快",
          "colorLayer": "五层清晰",
          "sediment": "无",
          "score": 86,
          "valid": true,
          "review": { "at": "2026-06-12T14:05", "reviewer": "周研", "disposition": "通过复核", "note": "符合入藏标准" }
        }
      ]
    },
    {
      "id": "seed-is-002",
      "code": "IS-002",
      "smokeSource": "桐油烟",
      "glueRatio": "8%",
      "ageYears": 3,
      "storage": "试样盒C",
      "logs": [
        { "at": "2026-06-20T09:00", "step": "建档", "note": "创建墨锭" },
        { "at": "2026-06-21T03:50", "step": "试磨", "note": "沈墨工首次记录：棉连纸18滴水，评分79，待复核" }
      ],
      "rounds": [
        {
          "id": "seed-r-002",
          "at": "2026-06-21T03:50",
          "recorder": "沈墨工",
          "paper": "棉连纸",
          "water": "18滴",
          "speed": "中",
          "colorLayer": "偏暖",
          "sediment": "少",
          "score": 79,
          "valid": true,
          "review": null
        }
      ]
    },
    {
      "id": "seed-is-003",
      "code": "IS-003",
      "smokeSource": "漆砂烟",
      "glueRatio": "7%",
      "ageYears": 1,
      "storage": "试样盒A",
      "logs": [
        { "at": "2026-07-02T09:00", "step": "建档", "note": "创建墨锭" }
      ],
      "rounds": []
    }
  ]
};
const fields = [["code", "墨锭编号", "text"], ["smokeSource", "烟料来源", "text"], ["glueRatio", "胶料比例", "text"], ["ageYears", "存放年限", "number"], ["storage", "存放位置", "text"]];
const profileKeys = fields.map(([key]) => key);
const extraFields = [["recorder", "首次记录人"], ["paper", "试磨纸张"], ["water", "加水量"], ["speed", "出墨速度"], ["colorLayer", "墨色层次"], ["sediment", "沉淀情况"], ["score", "评分"]];

async function loadDb() {
  if (!existsSync(dbPath)) {
    await mkdir(dirname(dbPath), { recursive: true });
    await writeFile(dbPath, JSON.stringify(seed, null, 2));
  }
  const db = JSON.parse(await readFile(dbPath, "utf8"));
  await migrate(db);
  return db;
}
async function saveDb(db) { await writeFile(dbPath, JSON.stringify(db, null, 2)); }
// 旧数据（无 rounds 结构）迁移：历史试磨一律回到待复核，由不同的人补复核，闭环不被历史数据绕过
async function migrate(db) {
  let changed = false;
  if (!db.version || db.version < 2) {
    for (const item of db.items || []) {
      if (!Array.isArray(item.rounds)) {
        const rounds = [];
        for (const t of item.tests || []) {
          rounds.push({
            id: newId(),
            at: t.at || new Date().toISOString(),
            recorder: "未登记",
            paper: t.paper || "",
            water: t.water || "",
            speed: t.speed || "",
            colorLayer: t.colorLayer || "",
            sediment: t.sediment || "",
            score: t.score === undefined || t.score === null || t.score === "" ? null : Number(t.score),
            valid: true,
            review: null
          });
        }
        if (!rounds.length) {
          for (const l of item.logs || []) {
            if (l.step === "试磨" && typeof l.score === "number") {
              rounds.push({
                id: newId(), at: l.at, recorder: "未登记",
                paper: "", water: "", speed: "", colorLayer: "", sediment: "",
                score: l.score, valid: true, review: null
              });
            }
          }
        }
        item.rounds = rounds;
      }
      for (const r of item.rounds) {
        r.valid ??= true;
        r.review ??= null;
      }
      delete item.tests;
      delete item.status;
      changed = true;
    }
    db.version = 2;
  }
  if (changed) await saveDb(db);
}
async function body(req) {
  const chunks = [];
  for await (const chunk of req) chunks.push(chunk);
  return chunks.length ? JSON.parse(Buffer.concat(chunks).toString("utf8")) : {};
}
function send(res, status, data) {
  res.writeHead(status, { "Content-Type": "application/json; charset=utf-8" });
  res.end(JSON.stringify(data, null, 2));
}
function fail(res, status, code, error) { return send(res, status, { code, error }); }
function html(res, text) {
  res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
  res.end(text);
}
function newId() { return "IS-" + Date.now() + "-" + Math.random().toString(36).slice(2, 7); }
function clean(value) {
  return value === undefined || value === null ? "" : String(value).trim();
}
function lastValidRound(item) {
  for (let i = (item.rounds || []).length - 1; i >= 0; i--) {
    if (item.rounds[i].valid) return item.rounds[i];
  }
  return null;
}
function missingFields(round) {
  return requiredRoundKeys.filter(key => {
    const v = round[key];
    return v === null || v === undefined || String(v).trim() === "";
  });
}
// 只有考核项齐全且评分 >=85 的轮次才允许复核通过、进入已试磨
function approvable(round) {
  return missingFields(round).length === 0 && Number(round.score) >= 85;
}
// 状态全部由最近一轮有效试磨推导，保证卡片、统计、刷新后历史一致
function deriveStatus(item) {
  const round = lastValidRound(item);
  if (!round) return "待试磨";
  if (!round.review) return "待复核";
  if (round.review.disposition === "通过复核") return "已试磨";
  return "重点观察";
}
function roundState(round) {
  if (!round.valid) return "已失效";
  if (!round.review) return "待复核";
  return round.review.disposition;
}
function computeStats(items) {
  const stats = Object.fromEntries(statLabels.map(label => [label, 0]));
  for (const item of items) {
    const status = deriveStatus(item);
    if (stats[status] !== undefined) stats[status] += 1;
  }
  return stats;
}
function summarize(item) {
  const logCount = (item.logs || []).length;
  const rounds = item.rounds || [];
  const latestRound = lastValidRound(item);
  return {
    ...item,
    status: deriveStatus(item),
    latestRound,
    openRoundCount: latestRound && !latestRound.review ? 1 : 0,
    roundCount: rounds.length,
    logCount
  };
}
function page() {
  return `<!doctype html>
<html lang="zh-CN">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>墨锭试磨室 · 双人复核</title>
  <style>
    :root { --bg:#f1f3ef; --panel:#fff; --ink:#20241f; --muted:#687066; --line:#d4ddd0; --accent:#526f43; --warn:#9b4937; }
    * { box-sizing:border-box; } body { margin:0; background:var(--bg); color:var(--ink); font-family:Arial,"PingFang SC",sans-serif; }
    header { padding:22px 28px; background:#fff; border-bottom:1px solid var(--line); display:flex; justify-content:space-between; gap:16px; align-items:center; }
    h1 { margin:0; font-size:26px; } h2 { margin:0 0 12px; font-size:18px; } main { display:grid; grid-template-columns:380px 1fr; gap:22px; padding:22px 28px; }
    form,.panel,.card,.stat { background:var(--panel); border:1px solid var(--line); border-radius:8px; padding:16px; }
    label { display:block; margin:10px 0 5px; color:var(--muted); font-size:13px; } input,select,textarea { width:100%; border:1px solid var(--line); border-radius:6px; padding:9px; font:inherit; background:#fff; } textarea { min-height:60px; }
    button { border:0; border-radius:6px; background:var(--accent); color:#fff; padding:10px 13px; font-weight:700; cursor:pointer; } button.secondary { background:#69736a; } button.warn { background:var(--warn); }
    .stats { display:grid; grid-template-columns:repeat(auto-fit,minmax(120px,1fr)); gap:10px; margin-bottom:14px; } .stat strong { display:block; font-size:24px; }
    .toolbar { display:flex; gap:10px; flex-wrap:wrap; margin-bottom:14px; } .toolbar select,.toolbar input { width:auto; min-width:160px; }
    .grid { display:grid; grid-template-columns:repeat(auto-fill,minmax(300px,1fr)); gap:12px; } .card { display:grid; gap:8px; }
    .meta { color:var(--muted); font-size:13px; } .pill { display:inline-block; border:1px solid var(--line); border-radius:999px; padding:3px 8px; font-size:12px; } .pill.warn { color:var(--warn); border-color:var(--warn); }
    .round { border-top:1px solid var(--line); padding-top:8px; display:grid; gap:4px; } .tag { font-size:12px; border-radius:4px; padding:1px 6px; border:1px solid var(--line); } .tag.bad { color:var(--warn); border-color:var(--warn); } .tag.dead { color:var(--muted); text-decoration:line-through; }
    .logs { border-top:1px solid var(--line); padding-top:8px; max-height:110px; overflow:auto; } .warn { color:var(--warn); font-weight:700; } .hint { font-size:12px; color:var(--muted); margin-top:6px; } .row { display:flex; gap:8px; align-items:center; flex-wrap:wrap; }
    @media (max-width:900px){ header{display:block;padding:18px 16px;} main{grid-template-columns:1fr;padding:16px;} }
  </style>
</head>
<body>
  <header><div><h1>墨锭试磨室 · 双人复核闭环</h1><div class="meta">首次记录 → 待复核 → 他人复核处置；未复核不得进入已试磨</div></div><button id="reload">刷新</button></header>
  <main>
    <section>
      <form id="createForm"><h2>新增墨锭</h2><div id="fields"></div><div class="hint">新墨锭统一为“待试磨”，试磨复核完成后状态才会变化。</div><button style="margin-top:10px">保存墨锭</button></form>
      <form id="actionForm" style="margin-top:14px"><h2>试磨首次记录 / 重开新一轮</h2><label>选择墨锭</label><select name="id" id="itemSelect"></select><div id="extraFields"></div><div class="hint" id="testHint"></div><button style="margin-top:10px">提交首次记录</button></form>
      <form id="reviewForm" style="margin-top:14px"><h2>复核（须另一位人员）</h2><label>选择待复核墨锭</label><select name="id" id="reviewSelect"></select><label>复核人</label><input name="reviewer" required><label>处置意见</label><select name="disposition">${dispositions.map(d => '<option>' + d + '</option>').join('')}</select><label>复核说明</label><textarea name="note"></textarea><div class="hint">评分低于85或考核项缺失时不能“通过复核”；重复复核沿用首次结果。</div><button style="margin-top:10px">提交复核</button></form>
    </section>
    <section>
      <div class="stats" id="stats"></div>
      <div class="toolbar"><select id="statusFilter"><option value="">全部状态</option>${stages.map(s => '<option>' + s + '</option>').join('')}</select><input id="search" placeholder="搜索编号或关键词"></div>
      <div class="panel"><h2>每锭同时只能有一轮未结束试磨；重开后旧结果失效，历史中保留并标注。</h2><div class="grid" id="cards"></div></div>
    </section>
  </main>
  <script>
    const fields = [["code","墨锭编号","text"],["smokeSource","烟料来源","text"],["glueRatio","胶料比例","text"],["ageYears","存放年限","number"],["storage","存放位置","text"]];
    const stages = ["待试磨","待复核","已试磨","重点观察"];
    const dispositions = ["通过复核","继续观察","重开试磨"];
    const extraFields = [["recorder","首次记录人"],["paper","试磨纸张"],["water","加水量"],["speed","出墨速度"],["colorLayer","墨色层次"],["sediment","沉淀情况"],["score","评分"]];
    const requiredFields = [["speed","出墨速度"],["colorLayer","墨色层次"],["sediment","沉淀情况"],["score","评分"]];
    const createForm = document.querySelector('#createForm');
    const actionForm = document.querySelector('#actionForm');
    const reviewForm = document.querySelector('#reviewForm');
    const cards = document.querySelector('#cards');
    const statsEl = document.querySelector('#stats');
    const itemSelect = document.querySelector('#itemSelect');
    const reviewSelect = document.querySelector('#reviewSelect');
    let items = [];
    const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
    const fmt = at => !at ? '' : String(at).slice(0, 16).replace('T', ' ');
    async function api(path, options) {
      const res = await fetch(path, options && options.body ? { ...options, headers:{ 'Content-Type':'application/json' } } : options);
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || '请求失败');
      return data;
    }
    function renderForms() {
      document.querySelector('#fields').innerHTML = fields.map(([key,label,type]) => '<label>'+label+'</label><input name="'+key+'" type="'+type+'" '+(key==='code'?'required':'')+'>').join('');
      document.querySelector('#extraFields').innerHTML = extraFields.map(([key,label]) => '<label>'+label+(requiredFields.some(f=>f[0]===key)?' <span class="warn">*</span>':'')+'</label><input name="'+key+'"'+(key==='score'?' type="number" min="0" max="100"':'')+'>').join('');
    }
    function missingList(round) {
      return requiredFields.filter(([key]) => round[key] === null || round[key] === undefined || String(round[key]).trim() === '').map(([,label]) => label);
    }
    function render() {
      itemSelect.innerHTML = items.map(item => '<option value="'+esc(item.id)+'">'+esc(item.code)+' · '+esc(item.status)+'</option>').join('');
      const pending = items.filter(i => i.status === '待复核');
      reviewSelect.innerHTML = pending.length ? pending.map(item => '<option value="'+esc(item.id)+'">'+esc(item.code)+' · 记录人 '+esc(item.latestRound && item.latestRound.recorder)+'</option>').join('') : '<option value="">（暂无待复核墨锭）</option>';
      const stats = Object.fromEntries(stages.map(s => [s, items.filter(i => i.status === s).length]));
      statsEl.innerHTML = Object.entries(stats).map(([k,v]) => '<div class="stat"><span>'+k+'</span><strong>'+v+'</strong></div>').join('');
      updateTestHint();
      const status = document.querySelector('#statusFilter').value;
      const q = document.querySelector('#search').value.trim();
      const visible = items.filter(item => (!status || item.status === status) && (!q || JSON.stringify(item).includes(q)));
      cards.innerHTML = visible.map(item => cardHtml(item)).join('');
      document.querySelectorAll('[data-note]').forEach(btn => btn.onclick = async () => { const id = btn.dataset.note; const note = prompt('记录备注'); if (note !== null && note.trim()) { await api('/api/items/'+id+'/logs', { method:'POST', body: JSON.stringify({ step:'备注', note }) }); await load(); } });
      document.querySelectorAll('[data-reopen]').forEach(btn => btn.onclick = async () => {
        const id = btn.dataset.reopen;
        const operator = prompt('重开试磨操作人（旧结果将失效）');
        if (operator !== null && operator.trim()) {
          try { await api('/api/items/'+id+'/reopen', { method:'POST', body: JSON.stringify({ operator, note:'' }) }); await load(); }
          catch (e) { alert(e.message); }
        }
      });
    }
    function updateTestHint() {
      const item = items.find(i => i.id === itemSelect.value);
      const hint = document.querySelector('#testHint');
      if (!item) { hint.textContent = ''; return; }
      if (item.status === '待复核') hint.textContent = '该墨锭有一轮未结束试磨，必须先由另一位人员复核，不能重复记录。';
      else if (item.status === '重点观察') hint.textContent = '该墨锭正在重点观察，需先“重开试磨”再记录新一轮。';
      else if (item.status === '已试磨') hint.textContent = '提交后即重开试磨：上一轮结果立即失效，新一轮进入待复核。';
      else hint.textContent = '首次记录须包含出墨速度、墨色层次、沉淀和评分；提交后进入待复核。';
    }
    function roundHtml(round) {
      const missing = missingList(round);
      const fieldLine = requiredFields.map(([key,label]) => {
        const v = round[key];
        const empty = v === null || v === undefined || String(v).trim() === '';
        return label + '：' + (empty ? '<span class="warn">缺失</span>' : esc(v));
      }).join('　');
      const state = !round.valid ? '<span class="tag dead">已失效</span>' : !round.review ? '<span class="tag bad">待复核</span>' : '<span class="tag">'+esc(round.review.disposition)+'</span>';
      const warn = round.valid && !round.review && (missing.length || Number(round.score) < 85) ? '<div class="warn">评分低于85或项目缺失，只能“继续观察”或“重开试磨”。</div>' : '';
      const review = round.review ? '<div class="meta">复核：'+esc(round.review.reviewer)+' · '+fmt(round.review.at)+' · '+esc(round.review.disposition)+(round.review.note ? ' · '+esc(round.review.note) : '')+'</div>' : '';
      return '<div class="round"><div class="row"><b>试磨 '+fmt(round.at)+'</b>'+state+'</div><div class="meta">记录人：'+esc(round.recorder)+'　纸张：'+esc(round.paper||'缺失')+'　加水量：'+esc(round.water||'缺失')+'</div><div>'+fieldLine+'</div>'+(missing.length ? '<div class="meta warn">缺失项：'+missing.join('、')+'</div>' : '')+warn+review+'</div>';
    }
    function cardHtml(item) {
      const main = fields.slice(0,5).map(([key,label]) => '<div><b>'+label+'</b> '+(item[key] ?? '')+'</div>').join('');
      const pillWarn = item.status === '待复核' || item.status === '重点观察';
      const round = item.latestRound;
      const canReopen = round && round.review;
      const logs = (item.logs || []).slice(-6).map(l => '<div>'+fmt(l.at)+' '+esc(l.step)+'：'+esc(l.note)+'</div>').join('');
      return '<article class="card"><div class="row"><h3 style="margin:0">'+esc(item.code)+'</h3><span class="pill'+(pillWarn?' warn':'')+'">'+esc(item.status)+'</span></div>'+main
        + (round ? roundHtml(round) : '<div class="meta">尚无试磨记录</div>')
        + '<div class="row"><button class="secondary" data-note="'+esc(item.id)+'">追加备注</button>'
        + (canReopen ? '<button class="warn" data-reopen="'+esc(item.id)+'">重开试磨</button>' : '') + '</div>'
        + '<div class="logs meta">'+(logs || '暂无记录')+'</div></article>';
    }
    async function load() { items = await api('/api/items'); render(); }
    createForm.onsubmit = async event => { event.preventDefault(); try { await api('/api/items', { method:'POST', body: JSON.stringify(Object.fromEntries(new FormData(createForm).entries())) }); createForm.reset(); await load(); } catch (e) { alert(e.message); } };
    actionForm.onsubmit = async event => { event.preventDefault(); try { await api('/api/items/'+itemSelect.value+'/action', { method:'POST', body: JSON.stringify(Object.fromEntries(new FormData(actionForm).entries())) }); actionForm.reset(); await load(); } catch (e) { alert(e.message); } };
    reviewForm.onsubmit = async event => {
      event.preventDefault();
      const payload = Object.fromEntries(new FormData(reviewForm).entries());
      if (!payload.id) { alert('暂无待复核墨锭'); return; }
      try {
        const data = await api('/api/items/'+payload.id+'/review', { method:'POST', body: JSON.stringify(payload) });
        reviewForm.reset();
        await load();
        if (data && data.reused) alert('该轮已复核，沿用首次复核结果。');
      } catch (e) { alert(e.message); }
    };
    itemSelect.onchange = updateTestHint;
    document.querySelector('#statusFilter').onchange = render; document.querySelector('#search').oninput = render; document.querySelector('#reload').onclick = load;
    renderForms(); load();
  </script>
</body>
</html>`;
}

const server = http.createServer(async (req, res) => {
  try {
    const url = new URL(req.url, `http://${req.headers.host}`);
    const db = await loadDb();
    const findItem = id => db.items.find(x => x.id === id || x.code === id);
    const now = () => new Date().toISOString();

    if (req.method === "GET" && url.pathname === "/") return html(res, page());
    if (req.method === "GET" && url.pathname === "/api/items") return send(res, 200, db.items.map(summarize));
    if (req.method === "GET" && url.pathname === "/api/stats") return send(res, 200, computeStats(db.items));

    if (req.method === "POST" && url.pathname === "/api/items") {
      const input = await body(req);
      if (!clean(input.code)) return fail(res, 400, "code_required", "墨锭编号不能为空");
      const item = { id: newId(), rounds: [], logs: [{ at: now(), step: "建档", note: "创建墨锭" }] };
      for (const key of profileKeys) if (input[key] !== undefined) item[key] = input[key];
      db.items.unshift(item);
      await saveDb(db);
      return send(res, 201, summarize(item));
    }

    const patch = url.pathname.match(/^\/api\/items\/([^/]+)$/);
    if (patch && req.method === "PATCH") {
      const item = findItem(patch[1]);
      if (!item) return fail(res, 404, "item_not_found", "墨锭不存在");
      const input = await body(req);
      // 状态只能由试磨/复核流程推导，禁止直接改写，防止未复核进入已试磨
      for (const key of profileKeys) if (input[key] !== undefined) item[key] = input[key];
      item.logs.push({ at: now(), step: "资料", note: "更新墨锭档案信息" });
      await saveDb(db);
      return send(res, 200, summarize(item));
    }

    const log = url.pathname.match(/^\/api\/items\/([^/]+)\/logs$/);
    if (log && req.method === "POST") {
      const item = findItem(log[1]);
      if (!item) return fail(res, 404, "item_not_found", "墨锭不存在");
      const input = await body(req);
      item.logs ||= [];
      item.logs.push({ at: now(), step: input.step || "记录", note: clean(input.note) });
      await saveDb(db);
      return send(res, 201, summarize(item));
    }

    // 首次记录：每锭同时只允许一轮未结束试磨；对已试磨墨锭提交即重开，旧结果失效
    const action = url.pathname.match(/^\/api\/items\/([^/]+)\/action$/);
    if (action && req.method === "POST") {
      const item = findItem(action[1]);
      if (!item) return fail(res, 404, "item_not_found", "墨锭不存在");
      const input = await body(req);
      const recorder = clean(input.recorder);
      if (!recorder) return fail(res, 400, "recorder_required", "请填写首次记录人");

      const last = lastValidRound(item);
      if (last && !last.review) {
        return fail(res, 409, "round_open", "该墨锭已有一轮未结束试磨，须先由另一位人员复核，不能重复记录");
      }
      if (last && last.review.disposition === "继续观察") {
        return fail(res, 409, "round_watching", "该墨锭正在重点观察，须先重开试磨，旧结果失效后才能记录新一轮");
      }
      if (last && last.review.disposition === "通过复核") {
        for (const r of item.rounds) r.valid = false;
        item.logs.push({ at: now(), step: "重开", note: "重开试磨，上一轮已复核结果失效" });
      }

      const scoreRaw = clean(input.score);
      let score = null;
      if (scoreRaw !== "") {
        score = Number(scoreRaw);
        if (!Number.isFinite(score)) return fail(res, 400, "score_invalid", "评分必须是数字");
      }
      const round = {
        id: newId(),
        at: now(),
        recorder,
        paper: clean(input.paper),
        water: clean(input.water),
        speed: clean(input.speed),
        colorLayer: clean(input.colorLayer),
        sediment: clean(input.sediment),
        score,
        valid: true,
        review: null
      };
      item.rounds ||= [];
      item.rounds.push(round);
      const missing = missingFields(round).map(k => requiredRoundLabels[k]);
      const note = "首次记录人 " + recorder + "，纸张" + (round.paper || "缺失") +
        "，加水量" + (round.water || "缺失") +
        "，评分" + (score === null ? "缺失" : score) +
        (missing.length ? "，缺失项：" + missing.join("、") : "") +
        "，进入待复核";
      item.logs.push({ at: round.at, step: "试磨", note, score });
      await saveDb(db);
      return send(res, 201, summarize(item));
    }

    // 复核：复核人必须不同于记录人；通过复核有评分和项目完整性门槛；重复复核沿用首次结果
    const review = url.pathname.match(/^\/api\/items\/([^/]+)\/review$/);
    if (review && req.method === "POST") {
      const item = findItem(review[1]);
      if (!item) return fail(res, 404, "item_not_found", "墨锭不存在");
      const round = lastValidRound(item);
      if (!round) return fail(res, 400, "round_missing", "该墨锭还没有试磨记录，无法复核");
      if (round.review) {
        return send(res, 200, { reused: true, message: "该轮已复核，沿用首次复核结果", item: summarize(item) });
      }
      const input = await body(req);
      const reviewer = clean(input.reviewer);
      const disposition = clean(input.disposition);
      if (!reviewer) return fail(res, 400, "reviewer_required", "请填写复核人");
      if (reviewer === round.recorder) return fail(res, 409, "reviewer_must_differ", "复核人必须与首次记录人不同（本轮记录人：" + round.recorder + "）");
      if (!dispositions.includes(disposition)) return fail(res, 400, "disposition_invalid", "请选择复核处置：通过复核 / 继续观察 / 重开试磨");
      if (disposition === "通过复核" && !approvable(round)) {
        const missing = missingFields(round).map(k => requiredRoundLabels[k]);
        const reasons = [];
        if (missing.length) reasons.push("缺失项：" + missing.join("、"));
        if (round.score === null || Number(round.score) < 85) reasons.push("评分" + (round.score === null ? "缺失" : round.score + " 低于85"));
        return fail(res, 409, "not_approvable", reasons.join("；") + "，不能通过复核，只能“继续观察”或“重开试磨”");
      }
      const note = clean(input.note);
      round.review = { at: now(), reviewer, disposition, note };
      item.logs.push({
        at: round.review.at, step: "复核",
        note: reviewer + " 复核：" + disposition + (note ? "（" + note + "）" : "") + "，记录人 " + round.recorder
      });
      if (disposition === "重开试磨") {
        round.valid = false;
        item.logs.push({ at: now(), step: "重开", note: "复核决定重开试磨，本轮结果失效（复核人 " + reviewer + "）" });
      }
      await saveDb(db);
      return send(res, 201, { reused: false, item: summarize(item) });
    }

    // 已通过/观察中的轮次重开：旧结果失效，墨锭回到待试磨，可记录新一轮
    const reopen = url.pathname.match(/^\/api\/items\/([^/]+)\/reopen$/);
    if (reopen && req.method === "POST") {
      const item = findItem(reopen[1]);
      if (!item) return fail(res, 404, "item_not_found", "墨锭不存在");
      const round = lastValidRound(item);
      if (!round) return fail(res, 400, "round_missing", "该墨锭还没有试磨记录，无需重开");
      if (!round.review) return fail(res, 409, "round_pending_review", "该轮尚在待复核，请由另一位人员在复核时选择“重开试磨”");
      const input = await body(req);
      const operator = clean(input.operator);
      if (!operator) return fail(res, 400, "operator_required", "请填写重开操作人");
      for (const r of item.rounds) r.valid = false;
      item.logs.push({ at: now(), step: "重开", note: operator + " 重开试磨，第" + item.rounds.length + "轮结果失效，墨锭回到待试磨" });
      await saveDb(db);
      return send(res, 201, summarize(item));
    }

    send(res, 404, { error: "not_found" });
  } catch (error) {
    send(res, 500, { error: error.message });
  }
});
server.listen(port, () => console.log("墨锭试磨室 listening on http://localhost:" + port));
