// 你說我猜用戶端。三種玩法（房主在大廳選）：
//   team：一個猜題者，其他人一起看題目、用嘴巴描述（任何一位描述的人都能按 ✔／⏭）
//   pair：一位出題者、一位猜題者，輪流
//   race：一位出題者描述，其他人搶答，出題者點「最快答對的人」給他加分
// 「每輪自選」主題時，開場先有一個選主題畫面（由猜題者；race 由出題者選）。房間／連線由 js/hub/client.js 處理。
import { $, el, renderRanking } from '../../hub/view.js';

let A = null;
const H = {
  state: null, word: null, busy: false, turnEnd: null, tick: null, final: null,
};

const ALL = '__all__';
const PICK = '__pick__';

const MODE_DESC = {
  team: '每一輪有一位「猜題者」，<b>其他所有人</b>都看得到題目，一起用嘴巴描述（不能直接說出題目裡的字）。猜題者在時間內猜越多題越好，猜中一題猜題者 +1 分，每個人輪流當猜題者，比誰猜得最多。每輪會<b>隨機指定一位描述的人</b>負責按 ✔ 答對／⏭ 跳過（避免大家同時按打架），其他人專心描述就好，猜對了喊給他聽。',
  pair: '每一輪有一位「出題者」看得到題目，用嘴巴描述，另一位玩家當「猜題者」。時間內答對越多越好，兩人同分。「輪流」模式大家輪流出題、猜題者是下一位；「指定」模式由房主指定一位猜題者，其他人輪流出題讓他猜。',
  race: '每一輪有一位「出題者」看得到題目，用嘴巴描述，<b>其他人搶答</b>。出題者按下「第一個答對的人」的名字，那個人 +1 分，出題者也 +1 分（描述得好才有分）。每個人輪流當出題者。',
};

const SETTINGS_HTML = `
  <h2>你說我猜規則 <span id="hu-lockhint" class="note"></span></h2>
  <div class="grid">
    <label>玩法<select id="hu-mode">
      <option value="team">🧠 一人猜、其他人一起描述（經典）</option>
      <option value="pair">🔁 一對一輪流（一人出題、一人猜）</option>
      <option value="race">🙋 搶答（出題者選最快答對的人）</option>
    </select></label>
  </div>
  <p id="hu-modedesc" class="note hu-how"></p>
  <div class="hu-catbox">
    <div class="hu-cathead"><span>題庫分類</span><b id="hu-catpick" class="hu-catpick"></b></div>
    <div id="hu-cat" class="chips hu-cats"></div>
  </div>
  <div class="grid">
    <label>每輪時間<select id="hu-dur"><option value="30">30 秒</option><option value="45">45 秒</option><option value="60">60 秒</option><option value="90">90 秒</option><option value="120">120 秒</option></select></label>
    <label><span id="hu-roundslabel">每人當猜題者幾次</span><select id="hu-rounds"><option value="1">1 次</option><option value="2">2 次</option><option value="3">3 次</option></select></label>
    <label id="hu-gmodewrap">誰來猜<select id="hu-gmode"><option value="rotate">輪流（每個人輪流）</option><option value="fixed">指定一位猜題者</option></select></label>
    <label id="hu-gwrap">猜題者是<select id="hu-gid"></select></label>
  </div>
  <p class="note hu-how">建議大家面對面玩：看得到題目的人把手機轉向自己，不要讓猜題的人看到。</p>`;

const SCREENS_HTML = `
<main id="screen-hu" class="screen hu">
  <header class="hu-top"><span id="hu-round" class="hu-chip">第 1 / 1 輪</span><span id="hu-timer" class="hu-timer">--</span><span id="hu-score" class="hu-chip">0 題</span></header>
  <p id="hu-roles" class="hu-roles"></p>
  <section id="hu-pick" class="hu-panel hidden">
    <div id="hu-pick-title" class="hu-big"></div>
    <p id="hu-pick-tip" class="hu-tip"></p>
    <div id="hu-pick-cats" class="chips hu-cats hu-pickcats"></div>
    <div id="hu-pick-count" class="hu-count hu-count-sm">20</div>
  </section>
  <section id="hu-intro" class="hu-panel hidden">
    <div id="hu-intro-title" class="hu-big"></div>
    <p id="hu-intro-tip" class="hu-tip"></p>
    <div id="hu-intro-count" class="hu-count">5</div>
  </section>
  <section id="hu-describer" class="hu-panel hidden">
    <div id="hu-caption" class="hu-caption">用嘴巴描述，不要說出這個詞裡的字！</div>
    <div id="hu-word" class="hu-word">…</div>
    <div id="hu-race" class="hu-race hidden">
      <div class="hu-caption">誰先答對？點他的名字加分</div>
      <div id="hu-racers" class="hu-racers"></div>
    </div>
    <p id="hu-op" class="hu-op hidden"></p>
    <div id="hu-btns" class="hu-btns">
      <button id="hu-pass" class="hu-btn pass" type="button">⏭ 跳過</button>
      <button id="hu-ok" class="hu-btn ok" type="button">✔ 答對</button>
    </div>
    <p id="hu-keys" class="hu-tip">鍵盤：<kbd>Enter</kbd>／<kbd>空白</kbd> 答對　<kbd>→</kbd> 跳過</p>
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
const show = (id) => { ['hu-pick', 'hu-intro', 'hu-describer', 'hu-watch', 'hu-result'].forEach((x) => $(x).classList.toggle('hidden', x !== id)); };
const catName = (c) => (c === ALL ? '全部混合' : c);
const names = (list) => list.map((x) => x.nick).join('、');

function build() {
  const sec = el('section', 'card gset hidden');
  sec.id = 'set-headsup';
  sec.innerHTML = SETTINGS_HTML;
  $('l-settings').append(sec);
  document.body.insertAdjacentHTML('beforeend', SCREENS_HTML);
}

// ===================== 設定面板 =====================
function fillSettings(s, ctx) {
  const box = $('hu-cat');
  const cats = (ctx.info.categories || []);
  const total = cats.reduce((n, c) => n + c.n, 0);
  const sig = JSON.stringify(cats);
  if (box.dataset.built !== sig) { // 把所有題庫攤開成標籤，每個人（不只房主）都看得到有哪些
    box.replaceChildren();
    const add = (value, text, n, cls = '') => {
      const label = el('label', 'chip hu-catchip' + cls);
      const input = document.createElement('input');
      input.type = 'radio'; input.name = 'hu-cat'; input.value = value;
      label.append(input, el('span', cls ? 'hu-catlabel' : null, text), el('span', 'hu-catn', String(n)));
      box.append(label);
    };
    add(PICK, '🙋 每輪自選', '', ' hu-special');
    add(ALL, '🎲 全部混合', total, ' hu-special');
    cats.forEach((c) => add(c.name, c.name, c.n));
    box.dataset.built = sig;
  }
  const mode = s.mode;
  box.querySelectorAll('input').forEach((i) => { i.checked = i.value === s.category; i.disabled = !ctx.host; });
  box.querySelector(`input[value="${PICK}"]`).nextSibling.textContent = mode === 'race' ? '🙋 每輪由出題者選' : '🙋 每輪由猜題者選';
  const cur = s.category === PICK ? null : s.category === ALL ? null : cats.find((c) => c.name === s.category);
  $('hu-catpick').textContent = s.category === PICK ? (mode === 'race' ? '🙋 每輪由出題者自選' : '🙋 每輪由猜題者自選')
    : cur ? `${cur.name}（${cur.n} 題）` : `🎲 全部混合（${total} 題）`;

  $('hu-mode').value = mode;
  $('hu-modedesc').innerHTML = MODE_DESC[mode];
  $('hu-dur').value = String(s.duration);
  $('hu-roundslabel').textContent = mode === 'team' ? '每人當猜題者幾次' : '每人當出題者幾次';
  $('hu-rounds').value = String(s.rounds);
  $('hu-gmode').value = s.guesserMode;
  $('hu-gmodewrap').classList.toggle('hidden', mode === 'race');
  $('hu-gwrap').classList.toggle('hidden', mode === 'race' || s.guesserMode !== 'fixed');
  const gid = $('hu-gid');
  const players = ctx.hub.players.filter((p) => p.role === 'player');
  const psig = JSON.stringify(players.map((p) => [p.id, p.nick, p.connected]));
  if (gid.dataset.built !== psig) {
    gid.replaceChildren();
    const none = el('option', null, '（請選擇）'); none.value = ''; gid.append(none);
    players.forEach((p) => { const o = el('option', null, p.nick + (p.connected ? '' : '（離線）')); o.value = p.id; gid.append(o); });
    gid.dataset.built = psig;
  }
  gid.value = s.guesserId || '';
  for (const id of ['hu-mode', 'hu-dur', 'hu-rounds', 'hu-gmode', 'hu-gid']) $(id).disabled = !ctx.host;
}
const readSettings = () => ({
  mode: $('hu-mode').value,
  category: ($('hu-cat').querySelector('input:checked') || { value: PICK }).value,
  duration: Number($('hu-dur').value),
  rounds: Number($('hu-rounds').value),
  guesserMode: $('hu-gmode').value,
  guesserId: $('hu-gid').value || null,
});

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

/** 我在這一輪的身分：d 看題目的人｜g 猜題者／搶答者｜w 觀眾 */
function roleOf(m) {
  const me = meId();
  if (m.ds.some((x) => x.id === me)) return 'd';
  if (m.g && m.g.id === me) return 'g';
  if (m.mode === 'race' && m.players.some((p) => p.id === me && !p.spectator)) return 'g';
  return 'w';
}

function onState(m) {
  H.state = m;
  if (m.phase === 'final') return;
  A.show('hu');
  $('hu-round').textContent = `第 ${m.idx} / ${m.total} 輪`;
  const role = !m.d ? 'none' : roleOf(m);
  const roles = $('hu-roles');
  roles.replaceChildren();
  if (m.d) {
    if (m.mode === 'team') roles.append('🧠 猜：', el('b', null, m.g.nick), '　🗣️ 描述：', el('b', null, m.ds.length > 3 ? `其他 ${m.ds.length} 人` : names(m.ds)));
    else if (m.mode === 'race') roles.append('🗣️ 出題：', el('b', null, m.d.nick), '　🙋 搶答：', el('b', null, '大家'));
    else roles.append('🗣️ 出題：', el('b', null, m.d.nick), '　🧠 猜：', el('b', null, m.g.nick));
    if (m.cat) roles.append('　📚 ', el('b', null, catName(m.cat)));
  }
  $('hu-score').textContent = `${m.correct} 題`;
  const who = m.mode === 'team' ? m.g : m.d; // 「輪到誰」的主角
  if (m.phase === 'pick') {
    show('hu-pick');
    H.turnEnd = null;
    renderPick(m);
  } else if (m.phase === 'intro') {
    show('hu-intro');
    $('hu-intro-title').textContent = introTitle(m, role);
    $('hu-intro-tip').textContent = introTip(m, role, who);
    H.turnEnd = null;
  } else if (m.phase === 'play') {
    H.turnEnd = null;
    if (role === 'd') { show('hu-describer'); renderWord(); }
    else {
      show('hu-watch');
      const [title, tip] = watchText(m, role);
      $('hu-watch-title').textContent = title;
      $('hu-watch-tip').textContent = tip;
      $('hu-watch-count').textContent = String(m.correct);
    }
  }
  tick();
}

function introTitle(m, role) {
  if (m.mode === 'team') return role === 'd' ? `一起讓 ${m.g.nick} 猜！` : role === 'g' ? '輪到你猜！' : `輪到 ${m.g.nick} 猜`;
  if (m.mode === 'race') return role === 'd' ? '輪到你出題！' : role === 'g' ? '準備搶答！' : `輪到 ${m.d.nick} 出題`;
  return role === 'd' ? '輪到你出題！' : role === 'g' ? '輪到你猜！' : `輪到 ${m.d.nick} 出題`;
}
function introTip(m, role) {
  if (m.mode === 'team') {
    return role === 'd' ? `待會兒你會看到題目：和其他人一起用嘴巴描述，讓 ${m.g.nick} 猜，不要說出題目裡的字。把手機轉向自己，別讓猜題者看到。`
      : role === 'g' ? '別看其他人的螢幕，專心聽大家描述，大聲說出答案！'
        : `${m.g.nick} 負責猜，其他人幫忙描述。你是觀眾，先別出聲提示喔。`;
  }
  if (m.mode === 'race') {
    return role === 'd' ? '待會兒你會看到題目：用嘴巴描述（不能說出題目裡的字）。大家會搶答，有人答對你就點他的名字給他加分。把手機轉向自己。'
      : role === 'g' ? `別偷看 ${m.d.nick} 的螢幕，聽描述、搶著大聲說出答案！出題者會點第一個答對的人。`
        : `${m.d.nick} 負責描述，大家搶答。你是觀眾，先別出聲提示喔。`;
  }
  return role === 'd' ? '待會兒你會看到題目：用嘴巴描述，不要說出題目裡的字。把手機轉向自己，別讓猜題者看到。'
    : role === 'g' ? '別看出題者的螢幕，專心聽他描述，大聲說出答案！'
      : `${m.g.nick} 負責猜，${m.d.nick} 負責描述。你是觀眾，先別出聲提示喔。`;
}
function watchText(m, role) {
  if (m.mode === 'race') {
    return role === 'g' ? ['🙋 搶答！大聲喊出答案', `不要偷看 ${m.d.nick} 的螢幕，${m.d.nick} 會點第一個答對的人。`] : [`👀 ${m.d.nick} 正在出題`, '安靜看戲，別幫忙提示。'];
  }
  if (m.mode === 'team') return role === 'g' ? ['🧠 你是猜題者：大聲猜！', '不要偷看其他人的螢幕。'] : [`👀 ${m.g.nick} 正在猜`, '安靜看戲，別幫忙提示。'];
  return role === 'g' ? ['🧠 你是猜題者：大聲猜！', '不要偷看出題者的螢幕。'] : [`👀 ${m.d.nick} 正在出題`, '安靜看戲，別幫忙提示。'];
}

// ===================== 選主題 =====================
function renderPick(m) {
  const mine = m.chooser.id === meId();
  $('hu-pick-title').textContent = mine ? '選一個主題！' : `${m.chooser.nick} 正在選主題…`;
  $('hu-pick-tip').textContent = mine ? '點一個題庫開始（時間到會自動選「全部混合」）。' : (m.mode === 'race' ? '等出題者選好主題，準備搶答。' : '等猜題者選好主題，其他人準備描述。');
  const box = $('hu-pick-cats');
  box.classList.toggle('hidden', !mine);
  const cats = A.info('headsup').categories || [];
  const sig = JSON.stringify(cats) + mine;
  if (mine && box.dataset.built !== sig) {
    box.replaceChildren();
    const add = (cat, text, n, cls = '') => {
      const b = el('button', 'chip hu-catchip' + cls, text);
      b.type = 'button';
      if (n !== '') b.append(' ', el('span', 'hu-catn', String(n)));
      b.addEventListener('click', () => { if (!H.picked) { H.picked = true; A.send({ t: 'pick', cat }); } });
      box.append(b);
    };
    add(ALL, '🎲 全部混合', cats.reduce((n, c) => n + c.n, 0), ' hu-special');
    cats.forEach((c) => add(c.name, c.name, c.n));
    box.dataset.built = sig;
  }
  H.picked = false;
}

// ===================== 出題畫面 =====================
const isDescriber = () => { const s = H.state; return !!s && s.ds.some((x) => x.id === meId()); };
/** 有資格按 ✔／⏭ 的人：經典玩法是伺服器每輪隨機指定的「操作者」，其他模式就是出題者 */
const isOperator = () => { const s = H.state; return !!s && !!s.op && s.op.id === meId(); };

function renderWord() {
  const w = $('hu-word');
  const s = H.state;
  if (!s || s.phase !== 'play' || !isDescriber()) return;
  const race = s.mode === 'race';
  const op = isOperator();
  $('hu-caption').textContent = s.mode === 'team' ? `和大家一起描述，讓 ${s.g.nick} 猜！不要說出這個詞裡的字！`
    : race ? '用嘴巴描述，不要說出這個詞裡的字！有人答對就點他的名字' : '用嘴巴描述，不要說出這個詞裡的字！';
  // 經典玩法：只有操作者有按鈕，其他人專心描述；猜對了喊給操作者聽
  const opNote = $('hu-op');
  opNote.classList.toggle('hidden', s.mode !== 'team');
  opNote.textContent = op ? '🎛️ 這輪由你負責按：聽到猜對就按 ✔，太難就按 ⏭' : `🎛️ 這輪由 ${s.op.nick} 負責按 ✔／⏭，猜對了就喊給他聽`;
  $('hu-btns').classList.toggle('hidden', !op);
  $('hu-race').classList.toggle('hidden', !race || !op);
  $('hu-keys').classList.toggle('hidden', !op);
  $('hu-ok').classList.toggle('hidden', race);
  $('hu-btns').classList.toggle('race', race);
  $('hu-keys').innerHTML = race ? '鍵盤：<kbd>→</kbd> 跳過' : '鍵盤：<kbd>Enter</kbd>／<kbd>空白</kbd> 答對　<kbd>→</kbd> 跳過';
  if (race) renderRacers(s);
  w.textContent = H.word ? H.word.word : '…';
  const fit = (H.word ? [...H.word.word].length : 1);
  w.style.fontSize = fit > 12 ? 'clamp(26px, 6.5vw, 52px)' : fit > 7 ? 'clamp(32px, 8.5vw, 68px)' : 'clamp(38px, 11vw, 88px)';
  const off = !H.word || H.busy;
  $('hu-ok').disabled = $('hu-pass').disabled = off;
  $('hu-racers').querySelectorAll('button').forEach((b) => { b.disabled = off; });
}

function renderRacers(s) {
  const box = $('hu-racers');
  const list = s.players.filter((p) => !p.spectator && !s.ds.some((d) => d.id === p.id));
  const sig = JSON.stringify(list.map((p) => [p.id, p.nick, p.connected]));
  if (box.dataset.built === sig) return;
  box.replaceChildren();
  list.forEach((p) => {
    const b = el('button', 'hu-racer' + (p.connected ? '' : ' off'), p.nick);
    b.type = 'button';
    b.addEventListener('click', () => mark('correct', p.id));
    box.append(b);
  });
  box.dataset.built = sig;
}

function mark(type, who) {
  const s = H.state;
  if (!H.word || H.busy || !s || s.phase !== 'play' || !isOperator()) return;
  if (type === 'correct' && s.mode === 'race' && !who) return;
  H.busy = true;
  A.send({ t: 'mark', seq: H.word.seq, type, who });
  renderWord();
  if (type === 'correct' && navigator.vibrate) navigator.vibrate(30);
}

function tick() {
  const s = H.state;
  if (!s) return;
  if (s.phase === 'pick') {
    const left = Math.max(0, Math.ceil((A.toLocal(s.pickEndsAt) - Date.now()) / 1000));
    $('hu-pick-count').textContent = String(left);
    $('hu-timer').textContent = '選題'; $('hu-timer').classList.remove('low');
  } else if (s.phase === 'intro') {
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
  const who = m.mode === 'team' ? `${m.g.nick} 猜、${m.ds.length > 3 ? `其他 ${m.ds.length} 人` : names(m.ds)} 描述`
    : m.mode === 'race' ? `${m.d.nick} 出題、大家搶答` : `${m.d.nick} 出題、${m.g.nick} 猜`;
  $('hu-result-title').textContent = `${who}${m.reason === 'abandoned' ? '（中途結束）' : ''}${m.cat ? `　📚 ${catName(m.cat)}` : ''}`;
  $('hu-result-score').textContent = `答對 ${m.correct} 題　跳過 ${m.passed} 題`;
  const words = $('hu-words'); words.replaceChildren();
  if (!m.words.length) words.append(el('p', 'note', '這輪沒有作答'));
  m.words.forEach((w) => words.append(el('span', 'hu-w ' + (w.ok ? 'ok' : 'no'), (w.ok ? '✔ ' : '⏭ ') + w.word + (w.by ? `　← ${w.by}` : ''))));
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
  renderRanking({ podium: $('hu-podium'), table: $('hu-table') }, m.ranking, meId(), (r) => `參與 ${r.turns} 輪・得分 ${r.correct} 題`);
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
    const race = H.state && H.state.mode === 'race';
    if (!race && (e.code === 'Space' || e.code === 'Enter')) { e.preventDefault(); mark('correct'); }
    else if (e.code === 'ArrowRight' || e.code === 'KeyP') { e.preventDefault(); mark('pass'); }
  });
}

export default {
  meta: { id: 'headsup', name: '你說我猜', icon: '🗣️', desc: '一人猜、其他人一起用嘴巴描述題目（不能說出題目的字！），猜題者自選主題、限時內猜越多越好。也可以玩一對一輪流，或「出題者選最快答對的人」的搶答。' },
  init,
  settings: {
    get el() { return $('set-headsup'); },
    fill: fillSettings,
    read: readSettings,
    startHint: (ctx) => {
      const s = ctx.hub.settings;
      if (s.mode === 'race' || s.guesserMode !== 'fixed') return null;
      const g = ctx.hub.players.find((p) => p.id === s.guesserId);
      return g && g.connected ? null : '請先指定一位在線的猜題者';
    },
  },
  enter, exit, message, onHub,
};
