// 合力塗鴉用戶端：畫家拿工具卡在共享畫布上合力畫、猜題者看著畫布打字猜。房間／連線由 js/hub/client.js 處理。
import { $, el, renderRanking } from '../../hub/view.js';
import { Board, Input } from './canvas.js';
import { PALETTE, STAMPS, STAMP_LABEL, PING_EMOJI, INK_MAX, INK_REGEN, cardById } from './rules.js';

let A = null;
let board = null;
let over = null;
let input = null;

const D = {
  state: null, idx: 0, card: null, def: null, word: null, ink: { v: INK_MAX, t: Date.now() },
  mode: 'draw', pingE: PING_EMOJI[0], opts: { ci: 0, f: false, sh: 'random' },
  guesses: [], roundEnd: null, final: null, tick: null, guessCd: 0, previewCost: null,
};

const SETTINGS_HTML = `
  <h2>合力塗鴉規則 <span id="cd-lockhint" class="note"></span></h2>
  <div class="cd-catbox">
    <div class="cd-cathead"><span>題庫分類</span><b id="cd-catpick" class="cd-catpick"></b></div>
    <div id="cd-cat" class="chips cd-cats"></div>
  </div>
  <div class="grid">
    <label>題目難度<select id="cd-diff"><option value="easy">簡單</option><option value="all">簡單＋中等</option><option value="hard">中等＋困難</option><option value="any">全部（簡單到困難）</option></select></label>
    <label>每回合時間<select id="cd-dur"><option value="45">45 秒</option><option value="60">60 秒</option><option value="75">75 秒</option><option value="90">90 秒</option><option value="120">120 秒</option><option value="150">150 秒</option></select></label>
    <label>每人當猜題者幾次<select id="cd-rounds"><option value="1">1 次</option><option value="2">2 次</option><option value="3">3 次</option></select></label>
  </div>
  <p class="note cd-how">玩法：每回合輪流一位「猜題者」，其他人都是「畫家」，看得到題目。每位畫家會拿到不同的「工具卡」（只能畫直線、只能畫圓、只能點點、只能擦…）和會慢慢恢復的墨水，大家同時在同一張畫布上作畫，合力讓猜題者猜出答案！墨水用完時可以放「📍指揮標記」指揮隊友。至少 3 人（1 位猜題者＋2 位畫家）。</p>`;

const SCREENS_HTML = `
<main id="screen-cd" class="screen cd">
  <header class="cd-top"><span id="cd-round" class="cd-chip">第 1 / 1 回合</span><span id="cd-timer" class="cd-timer">--</span><span id="cd-score" class="cd-chip">0 分</span></header>
  <p id="cd-roles" class="cd-roles"></p>
  <div id="cd-wordbar" class="cd-wordbar hidden"></div>
  <div id="cd-stage" class="cd-stage">
    <canvas id="cd-canvas"></canvas>
    <canvas id="cd-over"></canvas>
    <div id="cd-pings" class="cd-pings"></div>
    <div id="cd-intro" class="cd-intro hidden"></div>
  </div>
  <section id="cd-tool" class="cd-panel hidden">
    <div class="cd-toolhead"><span id="cd-ticon" class="cd-ticon"></span><div><b id="cd-tname"></b><p id="cd-tdesc" class="cd-tdesc"></p></div></div>
    <div class="cd-inkrow"><span>💧 墨水</span><div id="cd-ink" class="cd-ink"><i id="cd-inkfill"></i><i id="cd-inkprev"></i></div><span id="cd-inktxt" class="cd-inktxt">100</span></div>
    <div id="cd-opts" class="cd-opts"></div>
    <div id="cd-pingbar" class="cd-pingbar"></div>
  </section>
  <section id="cd-guess" class="cd-panel hidden">
    <form id="cd-gform" class="cd-gform" autocomplete="off">
      <input id="cd-ginput" maxlength="20" placeholder="猜猜他們在畫什麼…" enterkeyhint="send">
      <button id="cd-gbtn" class="primary" type="submit">猜！</button>
    </form>
  </section>
  <section id="cd-feedbox" class="cd-panel hidden"><h3>猜測紀錄</h3><div id="cd-feed" class="cd-feed"></div></section>
  <div id="cd-roster" class="cd-roster"></div>
  <section id="cd-result" class="cd-panel hidden">
    <h2 id="cd-result-title">本回合結果</h2>
    <div id="cd-result-gain" class="cd-gain"></div>
    <h3>目前排行</h3>
    <div id="cd-rank" class="rank-table"></div>
    <button id="cd-next" class="big primary hidden" type="button">下一回合</button>
    <p id="cd-nextin" class="tip"></p>
  </section>
  <div class="row cd-host">
    <button id="cd-skip" class="ghost host-only" type="button">⤼ 略過這回合</button>
    <button id="cd-end" class="ghost host-only" type="button">■ 結束遊戲</button>
    <button id="cd-lobby" class="ghost host-only" type="button">⌂ 回大廳</button>
    <button id="cd-quit" class="ghost" type="button">離開</button>
  </div>
</main>

<main id="screen-cd-final" class="screen cd">
  <h1>🏆 最終排行榜</h1>
  <p id="cd-final-sub" class="sub"></p>
  <div id="cd-podium" class="podium"></div>
  <div id="cd-table" class="rank-table"></div>
  <div class="row">
    <button id="cd-final-lobby" class="big primary" type="button">回房間大廳</button>
    <button id="cd-final-leave" class="ghost" type="button">離開房間</button>
  </div>
  <p id="cd-final-wait" class="tip"></p>
</main>`;

const meId = () => A.me().id;
const roleOf = (s) => (!s || !s.g ? 'none' : s.g.id === meId() ? 'g' : s.drawers.includes(meId()) ? 'd' : 'w');
const canDraw = () => !!D.state && D.state.phase === 'draw' && !D.state.solved && roleOf(D.state) === 'd' && !!D.def && D.mode === 'draw';

function build() {
  const sec = el('section', 'card gset hidden');
  sec.id = 'set-coopdraw';
  sec.innerHTML = SETTINGS_HTML;
  $('l-settings').append(sec);
  document.body.insertAdjacentHTML('beforeend', SCREENS_HTML);
  board = new Board($('cd-canvas'));
  over = new Board($('cd-over'), { alpha: 0.6, transparent: true });
  input = new Input($('cd-over'), {
    canDraw,
    card: () => D.def,
    assigned: () => (D.card ? D.card.color : null),
    mode: () => D.mode,
    opts: () => D.opts,
    ink: inkNow,
    spend,
    flash: flashInk,
    send: (ops) => A.send({ t: 'ops', ops }),
    ping: (x, y) => A.send({ t: 'ping', x, y, e: D.pingE }),
    board,
    over,
    preview: (cost) => { D.previewCost = cost; updateInk(); },
  });
}

// ===================== 設定面板 =====================
function fillSettings(s, ctx) {
  const box = $('cd-cat');
  const cats = ctx.info.categories || [];
  const LV = { easy: ['easy'], all: ['easy', 'medium'], hard: ['medium', 'hard'], any: ['easy', 'medium', 'hard'] }; // 要與 server/games/coopdraw.mjs 一致
  const count = (c) => (LV[s.difficulty] || LV.easy).reduce((n, lv) => n + (c[lv] || 0), 0); // 目前難度下這個分類有幾題
  const total = cats.reduce((n, c) => n + count(c), 0);
  const sig = JSON.stringify(cats.map((c) => c.name));
  if (box.dataset.built !== sig) { // 把所有題庫攤開成標籤，每個人（不只房主）都看得到有哪些；只有房主點得動
    box.replaceChildren();
    const add = (value, text) => {
      const label = el('label', 'chip cd-catchip');
      const input = document.createElement('input');
      input.type = 'radio'; input.name = 'cd-cat'; input.value = value;
      const n = el('span', 'cd-catn', '');
      n.dataset.cat = value;
      label.append(input, el('span', null, text), n);
      box.append(label);
    };
    add('__all__', '🎲 全部混合');
    cats.forEach((c) => add(c.name, c.name));
    box.dataset.built = sig;
  }
  box.querySelectorAll('input').forEach((i) => { i.checked = i.value === s.category; i.disabled = !ctx.host; });
  box.querySelectorAll('.cd-catn').forEach((n) => { const c = cats.find((x) => x.name === n.dataset.cat); n.textContent = String(c ? count(c) : total); });
  const cur = s.category === '__all__' ? null : cats.find((c) => c.name === s.category);
  $('cd-catpick').textContent = cur ? `${cur.name}（${count(cur)} 題）` : `🎲 全部混合（${total} 題）`;
  const on = box.querySelector('input:checked');
  if (on && box.dataset.shown !== s.category) { box.dataset.shown = s.category; if (!ctx.host) on.parentElement.scrollIntoView({ block: 'nearest' }); }
  $('cd-diff').value = s.difficulty;
  $('cd-dur').value = String(s.duration);
  $('cd-rounds').value = String(s.rounds);
  for (const id of ['cd-diff', 'cd-dur', 'cd-rounds']) $(id).disabled = !ctx.host;
}
const readSettings = () => ({ category: ($('cd-cat').querySelector('input:checked') || { value: '__all__' }).value, difficulty: $('cd-diff').value, duration: Number($('cd-dur').value), rounds: Number($('cd-rounds').value) });

// ===================== 進入／離開 =====================
function resetRound(idx) {
  D.idx = idx;
  D.card = null; D.def = null; D.word = null;
  D.ink = { v: INK_MAX, t: Date.now() };
  D.mode = 'draw'; D.guesses = []; D.roundEnd = null; D.previewCost = null;
  D.opts = { ci: 0, f: false, sh: 'random' };
  if (input) input.resetStrokes();
  renderFeed();
}

function enter() {
  Object.assign(D, { state: null, final: null });
  resetRound(0);
  board.clear(); over.clear();
  $('cd-pings').replaceChildren();
  clearInterval(D.tick);
  D.tick = setInterval(tick, 100);
}
function exit() {
  clearInterval(D.tick); D.tick = null;
  D.state = null;
}

// ===================== 訊息 =====================
function message(m) {
  switch (m.t) {
    case 'state': return onState(m);
    case 'canvas': if (m.idx !== D.idx) resetRound(m.idx); board.clear(); over.clear(); board.drawOps(m.ops || []); return;
    case 'card': if (m.idx !== D.idx) resetRound(m.idx); D.card = m; D.def = cardById(m.id); D.opts.ci = 0; renderTool(); renderIntro(); return;
    case 'word': if (m.idx !== D.idx) resetRound(m.idx); D.word = m.word; renderWordbar(); return;
    case 'ops': if (m.u !== meId()) board.drawOps(m.ops); return;
    case 'ink': D.ink = { v: m.v, t: A.toLocal(m.at) }; if (m.rej) A.send({ t: 'sync' }); updateInk(); return;
    case 'ping': return showPing(m);
    case 'guess': return onGuess(m);
    case 'roundEnd': return onRoundEnd(m);
    case 'final': return onFinal(m);
    case 'skipped': A.toast(m.reason, true); return;
    default: return;
  }
}

function onHub() {
  if (D.roundEnd) applyNext();
  if (D.final) applyFinalButtons();
}

function onState(m) {
  D.state = m;
  if (m.phase === 'final') return;
  A.show('cd');
  const role = roleOf(m);
  $('cd-round').textContent = `第 ${m.idx} / ${m.total} 回合`;
  const me = m.players.find((p) => p.id === meId());
  $('cd-score').textContent = `${me ? me.score : 0} 分`;
  $('cd-roles').replaceChildren();
  if (m.g) $('cd-roles').append('🧠 猜題者：', el('b', null, m.g.nick), `　🎨 畫家 ${m.drawers.length} 位`);
  $('cd-tool').classList.toggle('hidden', !(role === 'd' && (m.phase === 'intro' || m.phase === 'draw')));
  $('cd-guess').classList.toggle('hidden', !(role === 'g' && m.phase === 'draw' && !m.solved));
  $('cd-feedbox').classList.toggle('hidden', m.phase === 'intro' && !D.guesses.length);
  $('cd-result').classList.toggle('hidden', m.phase !== 'roundEnd');
  if (m.phase !== 'roundEnd') D.roundEnd = null;
  renderWordbar();
  renderIntro();
  renderRoster();
  renderFeed();
  renderTool();
  if (role === 'g' && m.phase === 'draw') setTimeout(() => { if (!document.activeElement || document.activeElement === document.body) $('cd-ginput').focus(); }, 0);
  tick();
}

// ===================== 畫面部件 =====================
function renderWordbar() {
  const s = D.state; const bar = $('cd-wordbar');
  if (!s || !s.g || (s.phase !== 'intro' && s.phase !== 'draw')) { bar.classList.add('hidden'); return; }
  const role = roleOf(s);
  bar.classList.remove('hidden');
  bar.classList.toggle('drawer', role === 'd');
  bar.textContent = role === 'd' ? `🎯 題目：${D.word || '…'}（不能用嘴巴提示！）` : `${role === 'g' ? '🧠' : '👀'} 答案共 ${s.len} 個字`;
}

function renderIntro() {
  const s = D.state; const box = $('cd-intro');
  if (!s || s.phase !== 'intro') { box.classList.add('hidden'); return; }
  const role = roleOf(s);
  box.classList.remove('hidden');
  box.replaceChildren();
  const title = role === 'g' ? '🧠 你是猜題者！' : role === 'd' ? '🎨 你是畫家！' : `🧠 輪到 ${s.g.nick} 猜`;
  const tip = role === 'g' ? '看著大家在畫布上畫，打字猜答案。' : role === 'd' ? (D.def ? `你的工具：${D.def.icon} ${D.def.name}` : '正在發工具卡…') : '你是旁觀者，可以看大家畫。';
  box.append(el('div', 'cd-intro-title', title), el('div', 'cd-intro-tip', tip));
  if (role === 'd' && D.def) box.append(el('div', 'cd-intro-desc', D.def.desc));
  const n = el('div', 'cd-intro-count', '');
  n.id = 'cd-intro-count';
  box.append(n);
}

function renderRoster() {
  const s = D.state; const box = $('cd-roster');
  box.replaceChildren();
  if (!s) return;
  for (const p of s.players) {
    if (p.spectator) continue;
    const isG = s.g && p.id === s.g.id;
    const def = p.card ? cardById(p.card) : null;
    const chip = el('span', 'cd-pchip' + (p.id === meId() ? ' me' : '') + (p.connected ? '' : ' off'));
    chip.append(el('span', 'cd-pi', isG ? '🧠' : def ? def.icon : '🎨'), p.nick);
    if (def) chip.title = `${def.name}：${def.desc}`;
    box.append(chip);
  }
}

function renderFeed() {
  const s = D.state; const box = $('cd-feed');
  box.replaceChildren();
  const accept = !!s && s.phase === 'draw' && !s.solved && roleOf(s) === 'd';
  [...D.guesses].reverse().forEach((g) => {
    const row = el('div', 'cd-guessrow' + (g.ok ? ' ok' : ''));
    row.append(el('b', null, g.nick), '：', el('span', 'cd-gtext', g.text));
    if (g.ok) row.append(el('span', 'cd-gok', g.by ? `✅ ${g.by} 接受` : '✅ 答對了！'));
    else if (accept) {
      const b = el('button', 'cd-accept', '✅ 接受這個答案');
      b.type = 'button';
      b.addEventListener('click', () => A.send({ t: 'accept', id: g.id }));
      row.append(b);
    }
    box.append(row);
  });
  if (!D.guesses.length) box.append(el('p', 'note', '猜題者還沒猜…'));
}

function onGuess(m) {
  const i = D.guesses.findIndex((g) => g.id === m.id);
  const g = { id: m.id, nick: m.nick, text: m.text, ok: !!m.ok, by: m.by || null };
  if (i >= 0) D.guesses[i] = g; else D.guesses.push(g);
  if (D.state) $('cd-feedbox').classList.remove('hidden');
  renderFeed();
}

function showPing(m) {
  const d = el('div', 'cd-ping');
  d.style.left = `${(m.x / 800) * 100}%`;
  d.style.top = `${(m.y / 600) * 100}%`;
  d.append(el('span', 'cd-ping-e', m.e), el('span', 'cd-ping-n', m.from));
  $('cd-pings').append(d);
  setTimeout(() => d.remove(), 3200);
}

// ----- 工具卡／墨水 -----
const inkNow = () => Math.max(0, Math.min(INK_MAX, D.ink.v + ((Date.now() - D.ink.t) * INK_REGEN) / 1000));
function spend(cost) { D.ink = { v: inkNow() - cost, t: Date.now() }; updateInk(); }
function flashInk() { const b = $('cd-ink'); b.classList.add('bad'); setTimeout(() => b.classList.remove('bad'), 350); }

function updateInk() {
  const ink = inkNow();
  $('cd-inkfill').style.width = `${(ink / INK_MAX) * 100}%`;
  $('cd-inktxt').textContent = String(Math.floor(ink));
  const prev = $('cd-inkprev');
  const c = D.previewCost;
  if (c == null) { prev.style.width = '0'; prev.classList.remove('bad'); return; }
  const lo = Math.max(0, ink - c);
  prev.style.left = `${(lo / INK_MAX) * 100}%`;
  prev.style.width = `${((ink - lo) / INK_MAX) * 100}%`;
  prev.classList.toggle('bad', c > ink);
}

function renderTool() {
  const def = D.def;
  if (!def) return;
  $('cd-ticon').textContent = def.icon;
  $('cd-tname').textContent = def.name;
  $('cd-tdesc').textContent = def.desc;
  const box = $('cd-opts');
  box.replaceChildren();
  if (def.color === 'pick') {
    const row = el('div', 'cd-palette');
    PALETTE.forEach((c, i) => {
      const b = el('button', 'cd-sw' + (D.opts.ci === i ? ' on' : ''));
      b.type = 'button'; b.style.background = c; b.setAttribute('aria-label', `顏色 ${i + 1}`);
      b.addEventListener('click', () => { D.opts.ci = i; renderTool(); });
      row.append(b);
    });
    box.append(row);
  } else if (def.color === 'random' && D.card) {
    const row = el('div', 'cd-mycolor');
    const sw = el('span', 'cd-sw on'); sw.style.background = D.card.color;
    row.append('你的顏色：', sw);
    box.append(row);
  }
  if (def.canFill) {
    const b = el('button', 'cd-opt' + (D.opts.f ? ' on' : ''), D.opts.f ? '■ 實心' : '□ 空心（點一下換實心）');
    b.type = 'button';
    b.addEventListener('click', () => { D.opts.f = !D.opts.f; renderTool(); });
    box.append(b);
  }
  if (def.kind === 'stamp') {
    const row = el('div', 'cd-shapes');
    row.append(el('span', 'cd-pinglabel', '蓋章形狀：'));
    [['random', '🎲 隨機'], ...STAMPS.map((sh) => [sh, STAMP_LABEL[sh]])].forEach(([sh, label]) => {
      const b = el('button', 'cd-opt' + (D.opts.sh === sh ? ' on' : ''), label);
      b.type = 'button';
      b.addEventListener('click', () => { D.opts.sh = sh; renderTool(); });
      row.append(b);
    });
    box.append(row);
  }
  // 指揮標記
  const pb = $('cd-pingbar');
  pb.replaceChildren();
  const draw = el('button', 'cd-opt' + (D.mode === 'draw' ? ' on' : ''), '✏️ 畫畫');
  draw.type = 'button';
  draw.addEventListener('click', () => { D.mode = 'draw'; renderTool(); });
  pb.append(draw, el('span', 'cd-pinglabel', '📍 指揮標記（只有畫家看得到）：'));
  PING_EMOJI.forEach((e) => {
    const b = el('button', 'cd-opt' + (D.mode === 'ping' && D.pingE === e ? ' on' : ''), e);
    b.type = 'button';
    b.addEventListener('click', () => { D.mode = 'ping'; D.pingE = e; renderTool(); });
    pb.append(b);
  });
  $('cd-over').classList.toggle('ping', D.mode === 'ping');
  updateInk();
}

// ----- 計時 -----
function tick() {
  const s = D.state;
  if (!s) return;
  updateInk();
  const t = $('cd-timer');
  if (s.phase === 'intro') {
    const left = Math.max(0, Math.ceil((A.toLocal(s.introEndsAt) - Date.now()) / 1000));
    t.textContent = '準備'; t.classList.remove('low');
    const n = $('cd-intro-count'); if (n) n.textContent = String(left);
  } else if (s.phase === 'draw') {
    const left = Math.max(0, Math.ceil((A.toLocal(s.endsAt) - Date.now()) / 1000));
    t.textContent = String(left);
    t.classList.toggle('low', left <= 10);
  } else if (s.phase === 'roundEnd') {
    t.textContent = '—'; t.classList.remove('low');
    if (D.roundEnd && D.roundEnd.nextAt) {
      const r = Math.max(0, Math.ceil((A.toLocal(D.roundEnd.nextAt) - Date.now()) / 1000));
      if (A.isHost()) $('cd-nextin').textContent = r > 0 ? `${r} 秒後自動下一回合` : '';
    }
  }
}

// ===================== 結果 =====================
function onRoundEnd(m) {
  D.roundEnd = m;
  A.show('cd');
  $('cd-result').classList.remove('hidden');
  $('cd-tool').classList.add('hidden');
  $('cd-guess').classList.add('hidden');
  $('cd-wordbar').classList.remove('hidden');
  $('cd-wordbar').classList.remove('drawer');
  $('cd-wordbar').textContent = `答案：${m.word}`;
  $('cd-round').textContent = `第 ${m.idx} / ${m.total} 回合`;
  $('cd-result-title').textContent = m.reason === 'abandoned' ? `回合中斷了（答案是「${m.word}」）` : m.solved ? `🎉 ${m.g.nick} 猜中了！` : `⏰ 時間到！答案是「${m.word}」`;
  $('cd-result-gain').textContent = m.solved && m.gain ? `猜題者 +${m.gain.g} 分　畫家每人 +${m.gain.d} 分` : '這回合沒人得分';
  const rank = $('cd-rank'); rank.replaceChildren();
  m.ranking.forEach((r) => {
    const row = el('div', 'mrow' + (r.id === meId() ? ' me' : ''));
    row.append(el('span', 'rk', String(r.rank)), el('span', 'nm', r.nick), el('span', 'pt', `${r.score}`), el('span', 'tt', ''));
    rank.append(row);
  });
  renderFeed();
  applyNext();
}

function applyNext() {
  const host = A.isHost();
  const last = D.roundEnd && D.roundEnd.last;
  $('cd-next').classList.toggle('hidden', !host);
  $('cd-next').textContent = last ? '查看最終排行榜' : '下一回合';
  if (!host) $('cd-nextin').textContent = '等待房主…（也會自動換下一回合）';
}

function onFinal(m) {
  D.final = m;
  clearInterval(D.tick); D.tick = null;
  $('cd-final-sub').textContent = `共 ${m.total} 回合`;
  renderRanking({ podium: $('cd-podium'), table: $('cd-table') }, m.ranking, meId(), (r) => `猜中 ${r.guessed} 次・助攻 ${r.assists} 次`);
  A.show('cd-final');
  applyFinalButtons();
}

function applyFinalButtons() {
  const host = A.isHost();
  $('cd-final-lobby').classList.toggle('hidden', !host);
  $('cd-final-wait').textContent = host ? '' : '等待房主回到大廳…';
}

// ===================== 綁定一次性事件 =====================
function init(api) {
  A = api;
  build();
  $('cd-gform').addEventListener('submit', (e) => {
    e.preventDefault();
    const inp = $('cd-ginput');
    const text = inp.value.trim();
    if (!text || Date.now() < D.guessCd) return;
    A.send({ t: 'guess', text });
    inp.value = '';
    D.guessCd = Date.now() + 1000;
    $('cd-gbtn').disabled = true;
    setTimeout(() => { $('cd-gbtn').disabled = false; }, 1000);
  });
  $('cd-next').addEventListener('click', () => A.send({ t: 'next' }));
  $('cd-skip').addEventListener('click', () => { if (confirm('略過這一回合（不計分）？')) A.send({ t: 'skip' }); });
  $('cd-end').addEventListener('click', () => { if (confirm('結束遊戲並顯示最終排行榜？')) A.send({ t: 'end' }); });
  $('cd-lobby').addEventListener('click', () => { if (confirm('結束這場遊戲，回到房間大廳？')) A.toLobby(); });
  $('cd-quit').addEventListener('click', () => { if (confirm('離開房間？')) A.leave(); });
  $('cd-final-lobby').addEventListener('click', () => A.toLobby());
  $('cd-final-leave').addEventListener('click', () => A.leave());
}

export default {
  meta: { id: 'coopdraw', name: '合力塗鴉', icon: '🎨', desc: '大家合力在同一張畫布上畫出題目，讓猜題者猜！但每個人只拿到受限的工具（只能畫直線、只能畫圓、只能點點…）和有限的墨水，必須互相配合。' },
  init,
  settings: {
    get el() { return $('set-coopdraw'); },
    fill: fillSettings,
    read: readSettings,
    startHint: () => null,
  },
  enter, exit, message, onHub,
};
