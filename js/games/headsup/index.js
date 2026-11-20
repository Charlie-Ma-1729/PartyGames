// 你說我猜用戶端：出題者看題目、用嘴巴描述、答對按 ✔；猜題者不能看；其他人當觀眾。房間／連線由 js/hub/client.js 處理。
import { $, el, renderRanking } from '../../hub/view.js';

let A = null;
const H = {
  state: null, word: null, busy: false, turnEnd: null, tick: null, final: null,
};

const SETTINGS_HTML = `
  <h2>你說我猜規則 <span id="hu-lockhint" class="note"></span></h2>
  <div class="grid">
    <label>題庫分類<select id="hu-cat"></select></label>
    <label>每輪時間<select id="hu-dur"><option value="30">30 秒</option><option value="45">45 秒</option><option value="60">60 秒</option><option value="90">90 秒</option><option value="120">120 秒</option></select></label>
    <label>每人當出題者幾次<select id="hu-rounds"><option value="1">1 次</option><option value="2">2 次</option><option value="3">3 次</option></select></label>
  </div>
  <p class="note hu-how">玩法：每一輪有一位「出題者」看得到題目，用嘴巴描述（不能直接說出題目裡的字），下一位玩家當「猜題者」。時間內答對越多越好，兩人同分。大家輪流當出題者，最後比總分！<br>建議大家面對面玩：出題者把手機轉向自己，不要讓猜題者看到。</p>`;

const SCREENS_HTML = `
<main id="screen-hu" class="screen hu">
  <header class="hu-top"><span id="hu-round" class="hu-chip">第 1 / 1 輪</span><span id="hu-timer" class="hu-timer">--</span><span id="hu-score" class="hu-chip">0 題</span></header>
  <p id="hu-roles" class="hu-roles"></p>
  <section id="hu-intro" class="hu-panel hidden">
    <div id="hu-intro-title" class="hu-big"></div>
    <p id="hu-intro-tip" class="hu-tip"></p>
    <div id="hu-intro-count" class="hu-count">5</div>
  </section>
  <section id="hu-describer" class="hu-panel hidden">
    <div class="hu-caption">用嘴巴描述，不要說出這個詞裡的字！</div>
    <div id="hu-word" class="hu-word">…</div>
    <div class="hu-btns">
      <button id="hu-pass" class="hu-btn pass" type="button">⏭ 跳過</button>
      <button id="hu-ok" class="hu-btn ok" type="button">✔ 答對</button>
    </div>
    <p class="hu-tip">鍵盤：<kbd>Enter</kbd>／<kbd>空白</kbd> 答對　<kbd>→</kbd> 跳過</p>
  </section>
  <section id="hu-watch" class="hu-panel hidden">
    <div id="hu-watch-title" class="hu-big"></div>
    <p id="hu-watch-tip" class="hu-tip"></p>
    <div id="hu-watch-count" class="hu-count">0</div>
    <div class="hu-caption">目前答對</div>
  </section>
  <section id="hu-result" class="hu-panel hidden">
    <h2 id="hu-result-title">本輪結果</h2>
    <div id="hu-result-score" class="hu-big"></div>
    <div id="hu-words" class="hu-words"></div>
    <h3>目前排行</h3>
    <div id="hu-rank" class="rank-table"></div>
    <button id="hu-next" class="big primary hidden" type="button">下一輪</button>
    <p id="hu-nextin" class="tip"></p>
  </section>
  <div class="row hu-host">
    <button id="hu-skip" class="ghost host-only" type="button">⤼ 略過這一輪</button>
    <button id="hu-end" class="ghost host-only" type="button">■ 結束遊戲</button>
    <button id="hu-lobby" class="ghost host-only" type="button">⌂ 回大廳</button>
    <button id="hu-quit" class="ghost" type="button">離開</button>
  </div>
</main>

<main id="screen-hu-final" class="screen hu">
  <h1>🏆 最終排行榜</h1>
  <p id="hu-final-sub" class="sub"></p>
  <div id="hu-podium" class="podium"></div>
  <div id="hu-table" class="rank-table"></div>
  <div class="row">
    <button id="hu-final-lobby" class="big primary" type="button">回房間大廳</button>
    <button id="hu-final-leave" class="ghost" type="button">離開房間</button>
  </div>
  <p id="hu-final-wait" class="tip"></p>
</main>`;

const meId = () => A.me().id;
const show = (id) => { ['hu-intro', 'hu-describer', 'hu-watch', 'hu-result'].forEach((x) => $(x).classList.toggle('hidden', x !== id)); };

function build() {
  const sec = el('section', 'card gset hidden');
  sec.id = 'set-headsup';
  sec.innerHTML = SETTINGS_HTML;
  $('l-settings').append(sec);
  document.body.insertAdjacentHTML('beforeend', SCREENS_HTML);
}

// ===================== 設定面板 =====================
function fillSettings(s, ctx) {
  const sel = $('hu-cat');
  const cats = (ctx.info.categories || []);
  const sig = JSON.stringify(cats);
  if (sel.dataset.built !== sig) {
    sel.replaceChildren();
    const all = el('option', null, `🎲 全部混合（${cats.reduce((n, c) => n + c.n, 0)} 題）`); all.value = '__all__'; sel.append(all);
    cats.forEach((c) => { const o = el('option', null, `${c.name}（${c.n}）`); o.value = c.name; sel.append(o); });
    sel.dataset.built = sig;
  }
  sel.value = s.category;
  $('hu-dur').value = String(s.duration);
  $('hu-rounds').value = String(s.rounds);
  for (const id of ['hu-cat', 'hu-dur', 'hu-rounds']) $(id).disabled = !ctx.host;
}
const readSettings = () => ({ category: $('hu-cat').value, duration: Number($('hu-dur').value), rounds: Number($('hu-rounds').value) });

// ===================== 進入／離開 =====================
function enter() {
  Object.assign(H, { state: null, word: null, busy: false, turnEnd: null, final: null });
  clearInterval(H.tick);
  H.tick = setInterval(tick, 200);
}
function exit() {
  clearInterval(H.tick); H.tick = null;
  H.state = null; H.word = null;
}

// ===================== 訊息 =====================
function message(m) {
  switch (m.t) {
    case 'state': return onState(m);
    case 'word': H.word = m; H.busy = false; renderWord(); return;
    case 'turnEnd': return onTurnEnd(m);
    case 'final': return onFinal(m);
    case 'skipped': A.toast(m.reason, true); return;
    default: return;
  }
}

function onHub() {
  if (H.turnEnd) applyNext();
  if (H.final) applyFinalButtons();
}

function onState(m) {
  H.state = m;
  if (m.phase === 'final') return;
  A.show('hu');
  $('hu-round').textContent = `第 ${m.idx} / ${m.total} 輪`;
  const me = meId();
  const role = !m.d ? 'none' : m.d.id === me ? 'd' : m.g.id === me ? 'g' : 'w';
  $('hu-roles').innerHTML = '';
  if (m.d) {
    $('hu-roles').append('🗣️ 出題：', el('b', null, m.d.nick), '　🧠 猜：', el('b', null, m.g.nick));
  }
  $('hu-score').textContent = `${m.correct} 題`;
  if (m.phase === 'intro') {
    show('hu-intro');
    $('hu-intro-title').textContent = role === 'd' ? '輪到你出題！' : role === 'g' ? '輪到你猜！' : `輪到 ${m.d.nick} 出題`;
    $('hu-intro-tip').textContent = role === 'd' ? '待會兒你會看到題目：用嘴巴描述，不要說出題目裡的字。把手機轉向自己，別讓猜題者看到。'
      : role === 'g' ? '別看出題者的螢幕，專心聽他描述，大聲說出答案！'
        : `${m.g.nick} 負責猜，${m.d.nick} 負責描述。你是觀眾，先別出聲提示喔。`;
    H.turnEnd = null;
  } else if (m.phase === 'play') {
    H.turnEnd = null;
    if (role === 'd') { show('hu-describer'); renderWord(); }
    else {
      show('hu-watch');
      $('hu-watch-title').textContent = role === 'g' ? '🧠 你是猜題者：大聲猜！' : `👀 ${m.d.nick} 正在出題`;
      $('hu-watch-tip').textContent = role === 'g' ? '不要偷看出題者的螢幕。' : '安靜看戲，別幫忙提示。';
      $('hu-watch-count').textContent = String(m.correct);
    }
  }
  tick();
}

function renderWord() {
  const w = $('hu-word');
  const s = H.state;
  if (!s || s.phase !== 'play' || !s.d || s.d.id !== meId()) return;
  w.textContent = H.word ? H.word.word : '…';
  const fit = (H.word ? [...H.word.word].length : 1);
  w.style.fontSize = fit > 12 ? '9vw' : fit > 7 ? '12vw' : '16vw';
  $('hu-ok').disabled = $('hu-pass').disabled = !H.word || H.busy;
}

function mark(type) {
  const s = H.state;
  if (!H.word || H.busy || !s || s.phase !== 'play' || s.d.id !== meId()) return;
  H.busy = true;
  A.send({ t: 'mark', seq: H.word.seq, type });
  $('hu-ok').disabled = $('hu-pass').disabled = true;
  if (type === 'correct' && navigator.vibrate) navigator.vibrate(30);
}

function tick() {
  const s = H.state;
  if (!s) return;
  if (s.phase === 'intro') {
    const left = Math.max(0, Math.ceil((A.toLocal(s.introEndsAt) - Date.now()) / 1000));
    $('hu-intro-count').textContent = String(left);
    $('hu-timer').textContent = '準備'; $('hu-timer').classList.remove('low');
  } else if (s.phase === 'play') {
    const left = Math.max(0, Math.ceil((A.toLocal(s.endsAt) - Date.now()) / 1000));
    const t = $('hu-timer');
    t.textContent = String(left);
    t.classList.toggle('low', left <= 10);
  } else if (s.phase === 'turnEnd') {
    $('hu-timer').textContent = '—'; $('hu-timer').classList.remove('low');
    if (H.turnEnd && H.turnEnd.nextAt) {
      const r = Math.max(0, Math.ceil((A.toLocal(H.turnEnd.nextAt) - Date.now()) / 1000));
      $('hu-nextin').textContent = r > 0 ? `${r} 秒後自動下一輪` : '';
    }
  }
}

// ===================== 結果 =====================
function onTurnEnd(m) {
  H.turnEnd = m;
  A.show('hu');
  show('hu-result');
  $('hu-round').textContent = `第 ${m.idx} / ${m.total} 輪`;
  $('hu-result-title').textContent = `${m.d.nick} 出題、${m.g.nick} 猜${m.reason === 'abandoned' ? '（中途結束）' : ''}`;
  $('hu-result-score').textContent = `答對 ${m.correct} 題　跳過 ${m.passed} 題`;
  const words = $('hu-words'); words.replaceChildren();
  if (!m.words.length) words.append(el('p', 'note', '這輪沒有作答'));
  m.words.forEach((w) => words.append(el('span', 'hu-w ' + (w.ok ? 'ok' : 'no'), (w.ok ? '✔ ' : '⏭ ') + w.word)));
  const rank = $('hu-rank'); rank.replaceChildren();
  m.ranking.forEach((r) => {
    const row = el('div', 'mrow' + (r.id === meId() ? ' me' : ''));
    row.append(el('span', 'rk', String(r.rank)), el('span', 'nm', r.nick), el('span', 'pt', `${r.score}`), el('span', 'tt', ''));
    rank.append(row);
  });
  applyNext();
}

function applyNext() {
  const host = A.isHost();
  const last = H.turnEnd && H.turnEnd.last;
  $('hu-next').classList.toggle('hidden', !host);
  $('hu-next').textContent = last ? '查看最終排行榜' : '下一輪';
  if (!host) $('hu-nextin').textContent = '等待房主…（也會自動換下一輪）';
}

function onFinal(m) {
  H.final = m;
  clearInterval(H.tick); H.tick = null;
  $('hu-final-sub').textContent = `共 ${m.total} 輪`;
  renderRanking({ podium: $('hu-podium'), table: $('hu-table') }, m.ranking, meId(), (r) => `出題／猜 ${r.turns} 輪・答對 ${r.correct} 題`);
  A.show('hu-final');
  applyFinalButtons();
}

function applyFinalButtons() {
  const host = A.isHost();
  $('hu-final-lobby').classList.toggle('hidden', !host);
  $('hu-final-wait').textContent = host ? '' : '等待房主回到大廳…';
}

// ===================== 綁定一次性事件 =====================
function init(api) {
  A = api;
  build();
  $('hu-ok').addEventListener('click', () => mark('correct'));
  $('hu-pass').addEventListener('click', () => mark('pass'));
  $('hu-next').addEventListener('click', () => A.send({ t: 'next' }));
  $('hu-skip').addEventListener('click', () => { if (confirm('略過這一輪（不計分）？')) A.send({ t: 'skip' }); });
  $('hu-end').addEventListener('click', () => { if (confirm('結束遊戲並顯示最終排行榜？')) A.send({ t: 'end' }); });
  $('hu-lobby').addEventListener('click', () => { if (confirm('結束這場遊戲，回到房間大廳？')) A.toLobby(); });
  $('hu-quit').addEventListener('click', () => { if (confirm('離開房間？')) A.leave(); });
  $('hu-final-lobby').addEventListener('click', () => A.toLobby());
  $('hu-final-leave').addEventListener('click', () => A.leave());
  document.addEventListener('keydown', (e) => {
    if (!$('screen-hu').classList.contains('active') || $('hu-describer').classList.contains('hidden')) return;
    if (e.target.tagName === 'INPUT' || e.target.tagName === 'SELECT') return;
    if (e.code === 'Space' || e.code === 'Enter') { e.preventDefault(); mark('correct'); }
    else if (e.code === 'ArrowRight' || e.code === 'KeyP') { e.preventDefault(); mark('pass'); }
  });
}

export default {
  meta: { id: 'headsup', name: '你說我猜', icon: '🗣️', desc: '一人看題目、用嘴巴描述（不能說出題目的字！），另一人猜。限時內答對越多分越高，大家輪流當出題者。' },
  init,
  settings: {
    get el() { return $('set-headsup'); },
    fill: fillSettings,
    read: readSettings,
  },
  enter, exit, message, onHub,
};
