import http from "node:http";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const dbPath = join(__dirname, "data", "ink-stick-testing.json");
const port = Number(process.env.PORT || 3037);

const seed = {
  "items": [
    {
      "code": "IS-001",
      "smokeSource": "黄山松烟",
      "glueRatio": "7.5%",
      "ageYears": 8,
      "storage": "恒湿柜B",
      "status": "已试磨",
      "logs": [
        { "at": "2026-06-10T09:12:00.000Z", "step": "建档", "note": "创建墨锭" },
        { "at": "2026-06-11T10:05:00.000Z", "step": "试磨", "note": "试磨第1轮：记录人「林墨工」；出墨速度 快；墨色层次 五层清透；沉淀 无；评分 88" },
        { "at": "2026-06-11T15:40:00.000Z", "step": "复核", "note": "复核人「周掌柜」处置 通过，转入已试磨", "score": 88 }
      ],
      "rounds": [
        {
          "id": "R-seed-001",
          "no": 1,
          "recordedAt": "2026-06-11T10:05:00.000Z",
          "recorder": "林墨工",
          "paper": "净皮宣纸",
          "water": "20滴",
          "speed": "快",
          "colorLayer": "五层清透",
          "sediment": "无",
          "score": 88,
          "state": "已复核",
          "review": { "at": "2026-06-11T15:40:00.000Z", "reviewer": "周掌柜", "disposition": "通过", "note": "" }
        }
      ]
    },
    {
      "code": "IS-002",
      "smokeSource": "桐油烟",
      "glueRatio": "8%",
      "ageYears": 3,
      "storage": "试样盒C",
      "status": "待试磨",
      "logs": [
        { "at": "2026-06-18T09:00:00.000Z", "step": "建档", "note": "创建墨锭" }
      ],
      "rounds": []
    },
    {
      "code": "IS-003",
      "smokeSource": "漆烟",
      "glueRatio": "7%",
      "ageYears": 5,
      "storage": "试样盒A",
      "status": "待复核",
      "logs": [
        { "at": "2026-06-19T09:00:00.000Z", "step": "建档", "note": "创建墨锭" },
        { "at": "2026-06-20T14:20:00.000Z", "step": "试磨", "note": "试磨第1轮：记录人「林墨工」；出墨速度 中；墨色层次 偏暖；沉淀 少；评分 79；评分低于85，待复核", "score": 79 }
      ],
      "rounds": [
        {
          "id": "R-seed-003",
          "no": 1,
          "recordedAt": "2026-06-20T14:20:00.000Z",
          "recorder": "林墨工",
          "paper": "棉连纸",
          "water": "18滴",
          "speed": "中",
          "colorLayer": "偏暖",
          "sediment": "少",
          "score": 79,
          "state": "待复核",
          "review": null
        }
      ]
    }
  ]
};

const fields = [["code", "墨锭编号", "text"], ["smokeSource", "烟料来源", "text"], ["glueRatio", "胶料比例", "text"], ["ageYears", "存放年限", "number"], ["storage", "存放位置", "text"]];
const stages = ["待试磨", "待复核", "已试磨", "重点观察"];
const statLabels = ["待试磨", "待复核", "已试磨", "重点观察"];
const dispositions = ["通过", "重点观察", "退回重开"];
const passScore = 85;
const firstRecordFields = [["speed", "出墨速度"], ["colorLayer", "墨色层次"], ["sediment", "沉淀情况"], ["score", "评分"]];

async function loadDb() {
  if (!existsSync(dbPath)) {
    await mkdir(dirname(dbPath), { recursive: true });
    await writeFile(dbPath, JSON.stringify(seed, null, 2));
    return seed;
  }
  const db = JSON.parse(await readFile(dbPath, "utf8"));
  db.items ||= [];
  let dirty = false;
  for (const item of db.items) {
    if (migrateItem(item)) dirty = true;
    const status = deriveStatus(item);
    if (item.status !== status) { item.status = status; dirty = true; }
  }
  if (dirty) await writeFile(dbPath, JSON.stringify(db, null, 2));
  return db;
}
async function saveDb(db) { await writeFile(dbPath, JSON.stringify(db, null, 2)); }
async function body(req) {
  const chunks = [];
  for await (const chunk of req) chunks.push(chunk);
  return chunks.length ? JSON.parse(Buffer.concat(chunks).toString("utf8")) : {};
}
function send(res, status, data) {
  res.writeHead(status, { "Content-Type": "application/json; charset=utf-8" });
  res.end(JSON.stringify(data, null, 2));
}
function html(res, text) {
  res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
  res.end(text);
}
function newId(prefix) { return prefix + "-" + Date.now().toString(36) + Math.random().toString(36).slice(2, 6); }
function nowIso() { return new Date().toISOString(); }
function clean(value) { return String(value ?? "").trim(); }
function addLog(item, step, note, extra = {}) {
  item.logs ||= [];
  item.logs.push({ at: nowIso(), step, note, ...extra });
}

// 把旧版 tests/无轮次数据迁移进复核闭环：历史试磨一律先回到“待复核”，不能算作已完成
function migrateItem(item) {
  let dirty = false;
  item.logs ||= [];
  if (!Array.isArray(item.rounds)) { item.rounds = []; dirty = true; }
  if (Array.isArray(item.tests) && item.tests.length) {
    for (const test of item.tests) {
      const score = Number(test.score);
      item.rounds.push({
        id: newId("R"),
        no: item.rounds.length + 1,
        recordedAt: test.at || nowIso(),
        recorder: clean(test.recorder) || "（历史导入）",
        paper: clean(test.paper),
        water: clean(test.water),
        speed: clean(test.speed),
        colorLayer: clean(test.colorLayer),
        sediment: clean(test.sediment),
        score: Number.isFinite(score) ? score : null,
        state: "待复核",
        review: null
      });
    }
    delete item.tests;
    dirty = true;
  }
  for (const round of item.rounds) {
    if (round.state === "已通过" || round.state === "已完成") { round.state = "已复核"; dirty = true; }
  }
  return dirty;
}

function openRound(item) {
  return (item.rounds || []).find(r => r.state === "待复核") || null;
}
function latestRound(item) {
  const rounds = item.rounds || [];
  return rounds.length ? rounds[rounds.length - 1] : null;
}
function missingFields(round) {
  const missing = [];
  for (const [key, label] of firstRecordFields) {
    if (key === "score") {
      if (round.score === null || round.score === undefined || Number.isNaN(round.score)) missing.push(label);
    } else if (!clean(round[key])) {
      missing.push(label);
    }
  }
  return missing;
}
// 评分>=85且首次记录项目齐全，复核才允许“通过”
function roundEligible(round) { return missingFields(round).length === 0 && round.score >= passScore; }
// 状态只能由试磨轮次推导，避免手工把观察中的墨锭统计成已完成
function deriveStatus(item) {
  const rounds = item.rounds || [];
  if (rounds.some(r => r.state === "待复核")) return "待复核";
  const last = rounds[rounds.length - 1];
  if (!last || last.state === "已失效") return "待试磨";
  return last.review && last.review.disposition === "通过" ? "已试磨" : "重点观察";
}
function computeStats(items) {
  const stats = Object.fromEntries(statLabels.map(label => [label, 0]));
  for (const item of items) {
    const status = deriveStatus(item);
    stats[status] += 1;
  }
  return stats;
}
function summarize(item) {
  const rounds = item.rounds || [];
  return {
    ...item,
    status: deriveStatus(item),
    logCount: (item.logs || []).length,
    openRound: openRound(item) ? openRound(item).id : null,
    rounds: rounds.map(r => ({ ...r, missing: missingFields(r), eligible: roundEligible(r) }))
  };
}

function page() {
  return `<!doctype html>
<html lang="zh-CN">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>墨锭试磨室</title>
  <style>
    :root { --bg:#f1f3ef; --panel:#fff; --ink:#20241f; --muted:#687066; --line:#d4ddd0; --accent:#526f43; --warn:#9b4937; --review:#8a6d2f; }
    * { box-sizing:border-box; } body { margin:0; background:var(--bg); color:var(--ink); font-family:Arial,"PingFang SC",sans-serif; }
    header { padding:22px 28px; background:#fff; border-bottom:1px solid var(--line); display:flex; justify-content:space-between; gap:16px; align-items:center; }
    h1 { margin:0; font-size:26px; } h2 { margin:0 0 12px; font-size:18px; } h3 { margin:0; } main { display:grid; grid-template-columns:380px 1fr; gap:22px; padding:22px 28px; }
    form,.panel,.card,.stat { background:var(--panel); border:1px solid var(--line); border-radius:8px; padding:16px; }
    label { display:block; margin:10px 0 5px; color:var(--muted); font-size:13px; } input,select,textarea { width:100%; border:1px solid var(--line); border-radius:6px; padding:9px; font:inherit; background:#fff; }
    button { border:0; border-radius:6px; background:var(--accent); color:#fff; padding:10px 13px; font-weight:700; cursor:pointer; } button.secondary { background:#69736a; } button.danger { background:var(--warn); }
    button:disabled,select:disabled { opacity:.45; cursor:not-allowed; }
    .stats { display:grid; grid-template-columns:repeat(auto-fit,minmax(120px,1fr)); gap:10px; margin-bottom:14px; } .stat strong { display:block; font-size:24px; }
    .toolbar { display:flex; gap:10px; flex-wrap:wrap; margin-bottom:14px; } .toolbar select,.toolbar input { width:auto; min-width:160px; }
    .grid { display:grid; grid-template-columns:repeat(auto-fill,minmax(320px,1fr)); gap:12px; } .card { display:grid; gap:8px; align-content:start; }
    .meta { color:var(--muted); font-size:13px; }
    .pill { display:inline-block; border:1px solid var(--line); border-radius:999px; padding:3px 8px; font-size:12px; justify-self:start; }
    .p-todo { background:#eef1ec; } .p-review { background:#f7ecd4; color:var(--review); border-color:#ddc48a; }
    .p-done { background:#e4eddf; color:var(--accent); border-color:#b8cdab; } .p-watch { background:#f3e1dc; color:var(--warn); border-color:#d5ab9e; }
    .p-dead { background:#ececec; color:#777; text-decoration:line-through; }
    .round { border:1px dashed var(--line); border-radius:6px; padding:8px 10px; display:grid; gap:3px; font-size:13px; background:#fbfcf9; }
    .round.dead { background:#f4f4f4; } .round-head { display:flex; justify-content:space-between; gap:8px; align-items:center; font-weight:700; }
    .review { border-top:1px solid var(--line); padding-top:8px; display:grid; gap:2px; }
    .logs { border-top:1px solid var(--line); padding-top:8px; max-height:130px; overflow:auto; display:grid; gap:3px; font-size:12px; }
    .warn { color:var(--warn); font-weight:700; } .ok { color:var(--accent); font-weight:700; } .hint { font-size:12px; }
    #banner { display:none; margin:0 28px; padding:10px 14px; border-radius:6px; font-size:14px; }
    #banner.err { display:block; background:#f3e1dc; color:var(--warn); border:1px solid #d5ab9e; }
    #banner.ok { display:block; background:#e4eddf; color:var(--accent); border:1px solid #b8cdab; }
    @media (max-width:900px){ header{display:block;padding:18px 16px;} main{grid-template-columns:1fr;padding:16px;} #banner{margin:0 16px;} }
  </style>
</head>
<body>
  <header><div><h1>墨锭试磨室</h1><div class="meta">墨锭建档 · 首录试磨 · 双人复核闭环</div></div><button id="reload">刷新</button></header>
  <div id="banner"></div>
  <main>
    <section>
      <form id="createForm"><h2>新增墨锭</h2><div id="fields"></div><button>保存墨锭</button></form>
      <form id="testForm" style="margin-top:14px"><h2>试磨首录（开新一轮）</h2>
        <label>选择墨锭</label><select name="id" id="itemSelect"></select>
        <div id="testFields"></div>
        <div class="hint meta" style="margin-top:6px">每锭同时只能有一轮未结束试磨；评分≥85且四项齐全，复核才可“通过”。</div>
        <button style="margin-top:8px">提交首录</button>
      </form>
    </section>
    <section>
      <div class="stats" id="stats"></div>
      <div class="toolbar"><select id="statusFilter"><option value="">全部状态</option>${stages.map(s => '<option>' + s + '</option>').join('')}</select><input id="search" placeholder="搜索编号或关键词"></div>
      <div class="panel"><h2>试磨流程</h2><div class="meta" style="margin:-6px 0 12px">待试磨 → 首录后进入待复核 → 复核人（须不同于记录人）填写处置：通过转已试磨、列入重点观察或退回重开；重开后旧轮次失效，回到待试磨。未复核不会计入已试磨。</div><div class="grid" id="cards"></div></div>
    </section>
  </main>
  <script>
    const fields = [["code","墨锭编号","text"],["smokeSource","烟料来源","text"],["glueRatio","胶料比例","text"],["ageYears","存放年限","number"],["storage","存放位置","text"]];
    const stages = ["待试磨","待复核","已试磨","重点观察"];
    const dispositions = ["通过","重点观察","退回重开"];
    const testFields = [["recorder","记录人"],["paper","试磨纸张（选填）"],["water","加水量（选填）"],["speed","出墨速度"],["colorLayer","墨色层次"],["sediment","沉淀情况"],["score","评分（0-100）"]];
    const createForm = document.querySelector('#createForm');
    const testForm = document.querySelector('#testForm');
    const cards = document.querySelector('#cards');
    const statsEl = document.querySelector('#stats');
    const itemSelect = document.querySelector('#itemSelect');
    const bannerEl = document.querySelector('#banner');
    let items = [];
    function esc(v) { return String(v ?? '').replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c])); }
    function fmt(at) { return at ? String(at).replace('T',' ').slice(0,16) : ''; }
    function banner(msg, kind) { bannerEl.textContent = msg; bannerEl.className = kind || 'err'; }
    function itemId(item) { return item.id || item.code; }
    async function api(path, options) {
      const res = await fetch(path, options && options.body ? { ...options, headers:{ 'Content-Type':'application/json' } } : options);
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || '请求失败');
      return data;
    }
    function renderForms() {
      document.querySelector('#fields').innerHTML = fields.map(([key,label,type]) => '<label>'+label+'</label><input name="'+key+'" type="'+type+'" '+(key==='code'?'required':'')+'>').join('');
      document.querySelector('#testFields').innerHTML = testFields.map(([key,label]) => '<label>'+label+'</label><input name="'+key+'" '+(key==='score'?'type="number" min="0" max="100"':'type="text"')+(key==='recorder'?' required':'')+'>').join('');
    }
    function pillClass(status) { return { '待试磨':'p-todo','待复核':'p-review','已试磨':'p-done','重点观察':'p-watch' }[status] || 'p-todo'; }
    function render() {
      itemSelect.innerHTML = items.map(item => {
        const locked = item.status === '待复核';
        return '<option value="'+esc(itemId(item))+'" '+(locked?'disabled':'')+'>'+esc(item.code)+' · '+esc(item.status)+(locked?'（待复核中，不可新开）':'')+'</option>';
      }).join('');
      const stats = Object.fromEntries(stages.map(s => [s, items.filter(i => i.status === s).length]));
      statsEl.innerHTML = Object.entries(stats).map(([k,v]) => '<div class="stat"><span>'+k+'</span><strong>'+v+'</strong></div>').join('');
      const status = document.querySelector('#statusFilter').value;
      const q = document.querySelector('#search').value.trim();
      const visible = items.filter(item => (!status || item.status === status) && (!q || JSON.stringify(item).includes(q)));
      cards.innerHTML = visible.map(item => cardHtml(item)).join('');
      bindCardActions();
    }
    function eligibilityHint(round) {
      if (round.missing && round.missing.length) return '<div class="warn">项目缺失：'+esc(round.missing.join('、'))+'，复核不能“通过”，只能列入重点观察或退回重开。</div>';
      if (round.score < 85) return '<div class="warn">评分 '+esc(round.score)+' 低于85，复核不能“通过”，只能列入重点观察或退回重开。</div>';
      return '<div class="ok hint">项目齐全且评分≥85，复核可“通过”。</div>';
    }
    function roundHtml(round) {
      const dead = round.state === '已失效';
      const head = '<div class="round-head"><span>第 '+round.no+' 轮试磨</span><span class="pill '+(dead?'p-dead':round.state==='已复核'?'p-done':'p-review')+'">'+esc(round.state)+'</span></div>';
      const body = '<div>记录人：'+esc(round.recorder)+'　'+fmt(round.recordedAt)+'</div>'
        + '<div class="meta">试纸：'+esc(round.paper || '—')+'　加水：'+esc(round.water || '—')+'</div>'
        + '<div>出墨速度：'+esc(round.speed || '缺失')+'　｜　墨色层次：'+esc(round.colorLayer || '缺失')+'　｜　沉淀：'+esc(round.sediment || '缺失')+'</div>'
        + '<div>评分：<b>'+(round.score === null || round.score === undefined ? '缺失' : esc(round.score))+'</b></div>';
      const review = round.review
        ? '<div class="meta">复核：'+esc(round.review.reviewer)+' 处置「'+esc(round.review.disposition)+'」'+(round.review.note ? '；'+esc(round.review.note) : '')+'　'+fmt(round.review.at)+'</div>'
        : (dead ? '<div class="meta">该轮结果已随重开失效</div>' : eligibilityHint(round));
      return '<div class="round'+(dead?' dead':'')+'">'+head+body+review+'</div>';
    }
    function reviewHtml(item, round) {
      const opts = dispositions.map(d => '<option value="'+d+'" '+(d==='通过' && !round.eligible?'disabled':'')+'>'+d+(d==='通过' && !round.eligible?'（评分/项目不满足）':'')+'</option>').join('');
      return '<div class="review"><label>复核人（须与记录人「'+esc(round.recorder)+'」不同）</label><input data-reviewer placeholder="复核人姓名">'
        + '<label>处置</label><select data-disposition>'+opts+'</select>'
        + '<label>复核说明（选填）</label><input data-review-note>'
        + '<div style="margin-top:6px"><button data-review="'+esc(itemId(item))+'">提交复核</button></div></div>';
    }
    function cardHtml(item) {
      const main = fields.slice(0,5).map(([key,label]) => '<div><b>'+label+'</b> '+esc(item[key] ?? '')+'</div>').join('');
      const rounds = (item.rounds || []).slice().reverse().map(roundHtml).join('') || '<div class="meta">尚无试磨轮次</div>';
      const open = (item.rounds || []).find(r => r.state === '待复核');
      const last = (item.rounds || []).slice().pop();
      let actions = '';
      if (open) {
        actions = reviewHtml(item, open);
      } else if (last && last.state === '已复核') {
        actions = '<div class="hint meta">已按首次复核结果结案；如需再磨可重开，重开后旧结果失效。</div><button class="danger" data-reopen="'+esc(itemId(item))+'">重开试磨（旧结果失效）</button>';
      } else if (last && last.state === '已失效') {
        actions = '<div class="hint meta">上一轮已失效，请在左侧“试磨首录”重开新一轮。</div>';
      } else {
        actions = '<div class="hint meta">待试磨：请在左侧“试磨首录”开始第一轮。</div>';
      }
      const logs = (item.logs || []).slice().reverse().map(l => '<div>'+fmt(l.at)+' <b>'+esc(l.step)+'</b>：'+esc(l.note)+'</div>').join('');
      return '<article class="card"><h3>'+esc(item.code || itemId(item))+'</h3><span class="pill '+pillClass(item.status)+'">'+esc(item.status)+'</span>'
        + main + '<div style="display:grid;gap:8px;margin-top:4px">'+rounds+'</div>' + actions
        + '<div class="logs meta">'+(logs || '暂无记录')+'</div></article>';
    }
    function bindCardActions() {
      document.querySelectorAll('[data-review]').forEach(btn => btn.onclick = async () => {
        const box = btn.closest('.review');
        const id = btn.dataset.review;
        const reviewer = box.querySelector('[data-reviewer]').value.trim();
        const disposition = box.querySelector('[data-disposition]').value;
        const note = box.querySelector('[data-review-note]').value.trim();
        try {
          await api('/api/items/'+encodeURIComponent(id)+'/review', { method:'POST', body: JSON.stringify({ reviewer, disposition, note }) });
          banner('复核已提交', 'ok');
          await load();
        } catch (e) { banner(e.message); }
      });
      document.querySelectorAll('[data-reopen]').forEach(btn => btn.onclick = async () => {
        if (!confirm('重开试磨后，上一轮首录与复核结果全部失效，且不能恢复。确定重开？')) return;
        try {
          await api('/api/items/'+encodeURIComponent(btn.dataset.reopen)+'/reopen', { method:'POST', body: JSON.stringify({}) });
          banner('已重开试磨，旧轮次结果失效', 'ok');
          await load();
        } catch (e) { banner(e.message); }
      });
    }
    async function load() { items = await api('/api/items'); render(); }
    createForm.onsubmit = async event => {
      event.preventDefault();
      try {
        await api('/api/items', { method:'POST', body: JSON.stringify(Object.fromEntries(new FormData(createForm).entries())) });
        createForm.reset(); banner('墨锭已建档，状态为待试磨', 'ok'); await load();
      } catch (e) { banner(e.message); }
    };
    testForm.onsubmit = async event => {
      event.preventDefault();
      const payload = Object.fromEntries(new FormData(testForm).entries());
      try {
        await api('/api/items/'+encodeURIComponent(payload.id)+'/rounds', { method:'POST', body: JSON.stringify(payload) });
        testForm.reset(); banner('首录已提交，进入待复核', 'ok'); await load();
      } catch (e) { banner(e.message); }
    };
    document.querySelector('#statusFilter').onchange = render;
    document.querySelector('#search').oninput = render;
    document.querySelector('#reload').onclick = () => load().then(() => banner('已刷新，卡片、统计与历史保持一致', 'ok'));
    renderForms(); load();
  </script>
</body>
</html>`;
}

const server = http.createServer(async (req, res) => {
  try {
    const url = new URL(req.url, `http://${req.headers.host}`);
    const db = await loadDb();
    const findItem = key => db.items.find(x => x.id === key || x.code === key);

    if (req.method === "GET" && url.pathname === "/") return html(res, page());
    if (req.method === "GET" && url.pathname === "/api/items") return send(res, 200, db.items.map(summarize));
    if (req.method === "GET" && url.pathname === "/api/stats") return send(res, 200, computeStats(db.items));

    if (req.method === "POST" && url.pathname === "/api/items") {
      const input = await body(req);
      if (!clean(input.code)) return send(res, 400, { error: "墨锭编号不能为空" });
      if (db.items.some(x => x.code === clean(input.code))) return send(res, 409, { error: "墨锭编号已存在" });
      // 建档一律从待试磨开始，闭环状态不允许手工指定
      const item = {
        id: newId("IS"),
        ...Object.fromEntries(fields.map(([key]) => [key, clean(input[key])])),
        ageYears: input.ageYears === undefined || input.ageYears === "" ? null : Number(input.ageYears),
        status: "待试磨",
        logs: [],
        rounds: []
      };
      addLog(item, "建档", "创建墨锭");
      db.items.unshift(item);
      await saveDb(db);
      return send(res, 201, summarize(item));
    }

    const roundMatch = url.pathname.match(/^\/api\/items\/([^/]+)\/rounds$/);
    if (roundMatch && req.method === "POST") {
      const item = findItem(roundMatch[1]);
      if (!item) return send(res, 404, { error: "item_not_found" });
      if (openRound(item)) return send(res, 409, { error: "该墨锭已有一轮试磨待复核，每锭同时只能有一轮未结束试磨" });
      const input = await body(req);
      const recorder = clean(input.recorder);
      if (!recorder) return send(res, 400, { error: "请填写记录人，复核人须与记录人不同" });
      const rawScore = clean(input.score);
      const scoreNum = Number(rawScore);
      const round = {
        id: newId("R"),
        no: (item.rounds || []).length + 1,
        recordedAt: nowIso(),
        recorder,
        paper: clean(input.paper),
        water: clean(input.water),
        speed: clean(input.speed),
        colorLayer: clean(input.colorLayer),
        sediment: clean(input.sediment),
        score: rawScore === "" || !Number.isFinite(scoreNum) ? null : scoreNum,
        state: "待复核",
        review: null
      };
      item.rounds ||= [];
      item.rounds.push(round);
      // 无论评分高低或项目是否缺失，首录后一律待复核，未复核不得进入已试磨
      const detail = "出墨速度 " + (round.speed || "缺失") + "；墨色层次 " + (round.colorLayer || "缺失")
        + "；沉淀 " + (round.sediment || "缺失") + "；评分 " + (round.score === null ? "缺失" : round.score);
      const missing = missingFields(round);
      const reason = missing.length ? "项目缺失（" + missing.join("、") + "），待复核"
        : round.score < passScore ? "评分低于" + passScore + "，待复核" : "待复核";
      addLog(item, "试磨", "试磨第" + round.no + "轮：记录人「" + recorder + "」；" + detail + "；" + reason,
        round.score === null ? {} : { score: round.score });
      item.status = deriveStatus(item);
      await saveDb(db);
      return send(res, 201, summarize(item));
    }

    const reviewMatch = url.pathname.match(/^\/api\/items\/([^/]+)\/review$/);
    if (reviewMatch && req.method === "POST") {
      const item = findItem(reviewMatch[1]);
      if (!item) return send(res, 404, { error: "item_not_found" });
      const round = openRound(item);
      if (!round) {
        const last = latestRound(item);
        if (last && last.state === "已复核") return send(res, 409, { error: "该轮已完成复核，重复复核沿用首次结果" });
        if (last && last.state === "已失效") return send(res, 409, { error: "该轮结果已失效，请重开试磨后重新记录" });
        return send(res, 409, { error: "没有待复核的试磨轮次" });
      }
      const input = await body(req);
      const reviewer = clean(input.reviewer);
      const disposition = clean(input.disposition);
      if (!reviewer) return send(res, 400, { error: "请填写复核人" });
      if (reviewer === round.recorder) return send(res, 400, { error: "复核人必须与原记录人不同（原记录人：" + round.recorder + "）" });
      if (!dispositions.includes(disposition)) return send(res, 400, { error: "请选择复核处置：通过 / 重点观察 / 退回重开" });
      if (disposition === "通过" && !roundEligible(round)) {
        const missing = missingFields(round);
        return send(res, 400, { error: missing.length
          ? "项目缺失（" + missing.join("、") + "），不能通过，请选择重点观察或退回重开"
          : "评分低于" + passScore + "，不能通过，请选择重点观察或退回重开" });
      }
      const note = clean(input.note);
      round.review = { at: nowIso(), reviewer, disposition, note };
      if (disposition === "退回重开") {
        round.state = "已失效";
        addLog(item, "复核", "复核人「" + reviewer + "」处置 退回重开，第" + round.no + "轮结果失效");
      } else {
        round.state = "已复核";
        const target = disposition === "通过" ? "已试磨" : "重点观察";
        addLog(item, "复核", "复核人「" + reviewer + "」处置 " + disposition + "，转入" + target,
          round.score === null ? {} : { score: round.score });
      }
      item.status = deriveStatus(item);
      await saveDb(db);
      return send(res, 200, summarize(item));
    }

    const reopenMatch = url.pathname.match(/^\/api\/items\/([^/]+)\/reopen$/);
    if (reopenMatch && req.method === "POST") {
      const item = findItem(reopenMatch[1]);
      if (!item) return send(res, 404, { error: "item_not_found" });
      const last = latestRound(item);
      if (!last) return send(res, 409, { error: "该墨锭还没有试磨轮次，无需重开" });
      if (last.state === "已失效") return send(res, 409, { error: "上一轮结果已失效，请直接提交新的试磨首录" });
      // 重开试磨：无论待复核还是已结案，旧轮次立即失效，状态回到待试磨
      last.state = "已失效";
      last.invalidatedAt = nowIso();
      const input = await body(req).catch(() => ({}));
      const reason = clean(input.note);
      addLog(item, "重开", "重开试磨：第" + last.no + "轮首录与复核结果全部失效，回到待试磨" + (reason ? "；原因：" + reason : ""));
      item.status = deriveStatus(item);
      await saveDb(db);
      return send(res, 200, summarize(item));
    }

    const logMatch = url.pathname.match(/^\/api\/items\/([^/]+)\/logs$/);
    if (logMatch && req.method === "POST") {
      const item = findItem(logMatch[1]);
      if (!item) return send(res, 404, { error: "item_not_found" });
      const input = await body(req);
      addLog(item, input.step || "备注", input.note || "");
      await saveDb(db);
      return send(res, 201, summarize(item));
    }

    // 闭环状态只能由轮次推导，PATCH 仅允许修改档案字段，不能直接改 status/rounds
    const patch = url.pathname.match(/^\/api\/items\/([^/]+)$/);
    if (patch && req.method === "PATCH") {
      const item = findItem(patch[1]);
      if (!item) return send(res, 404, { error: "item_not_found" });
      const input = await body(req);
      for (const [key] of fields) {
        if (input[key] !== undefined) item[key] = key === "ageYears" ? Number(input[key]) : clean(input[key]);
      }
      await saveDb(db);
      return send(res, 200, summarize(item));
    }

    send(res, 404, { error: "not_found" });
  } catch (error) {
    send(res, 500, { error: error.message });
  }
});
server.listen(port, () => console.log("墨锭试磨室 listening on http://localhost:" + port));
