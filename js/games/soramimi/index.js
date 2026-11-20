// 空耳歌王用戶端：挑歌 → 歌手聽音樂空耳演唱 → 其他人猜（8 選 1／搜尋）→ 結果。房間／連線由 js/hub/client.js 處理。
// 音樂只會送給「歌手」的裝置；其他人的裝置從頭到尾沒有拿到影片編號。
import { ClipPlayer } from '../../player.js';
import { CATEGORIES } from '../../questions.js';
import { $, el, renderRanking } from '../../hub/view.js';
import { createPicker } from '../../hub/songpicker.js';

let A = null;
const S = {
  state: null, mine: { picks: [], max: 10, ready: false }, turn: null, song: null, endsAt: null, guess: null, reveal: null, final: null,
  player: null, playing: false, cued: false, picker: null, tick: null,
  startAt: null, activated: false, readySent: false, played: false, clipDone: false, playTimer: null,
};

const SETTINGS_HTML = `
  <h2>空耳歌王規則 <span id="sr-lockhint" class="note"></span></h2>
  <div id="sr-categories" class="chips"></div>
  <div class="grid">
    <label>每人題庫幾首<select id="sr-perPlayer"><option value="3">3 首</option><option value="5">5 首</option><option value="8">8 首</option><option value="10">10 首</option><option value="15">15 首</option><option value="20">20 首</option></select></label>
    <label>每人當幾次歌手<select id="sr-rounds"><option value="1">1 次</option><option value="2">2 次</option><option value="3">3 次</option><option value="5">5 次</option></select></label>
    <label>歌手聽到的片段長度<select id="sr-clipSecs"><option value="10">10 秒</option><option value="15">15 秒</option><option value="20">20 秒</option><option value="30">30 秒</option><option value="45">45 秒</option><option value="60">60 秒</option></select></label>
    <label>每回合猜歌時間<select id="sr-singSecs"><option value="30">30 秒</option><option value="45">45 秒</option><option value="60">60 秒</option><option value="90">90 秒</option><option value="120">2 分鐘</option><option value="180">3 分鐘</option></select></label>
    <label>猜的方式<select id="sr-answerMode"><option value="choice">8 選 1</option><option value="search">從所有人的歌裡搜尋（較難）</option></select></label>
    <label>結果之後<select id="sr-autoNext"><option value="0">房主按下一位</option><option value="5">5 秒後自動下一位</option><option value="10">10 秒後自動下一位</option><option value="20">20 秒後自動下一位</option></select></label>
  </div>
  <label class="sr-voice"><input type="checkbox" id="sr-voice"> 大家已經開好語音通話（Discord、LINE 等）——房主確認後才能開始</label>
  <p class="note sr-how">玩法：每人先從題庫挑一批自己的歌。輪流當「歌手」：只有歌手聽得到原曲（倒數後自動播放，<b>只播一次、不能重播</b>，要即時跟上），要用<b>空耳</b>把它唱出來（不能直接說歌名！）；其他人用語音聽，從選項裡猜是哪一首，每人只能猜一次。第一個猜對的人得分（越快越高），歌手則是<b>猜對的人越多分數越高</b>。本遊戲不提供語音，請大家自備語音通話，歌手建議戴耳機。</p>`;

const SCREENS_HTML = `
<main id="screen-sora" class="screen sora">
  <header class="sr-top"><span id="sr-round" class="sr-chip">🎤 空耳歌王</span><span id="sr-timer" class="sr-timer"></span><span id="sr-score" class="sr-chip"></span></header>

  <section id="sr-pick" class="sr-panel hidden">
    <h2>先挑你的 <span id="sr-pick-n">10</span> 首歌</h2>
    <p class="sr-tip">只能選有歌詞的歌（純音樂沒辦法空耳）。之後輪到你當歌手時，會從這些歌裡隨機抽一首給你聽。其他人看不到你挑了什麼，只會看到所有人的歌混在一起的候選。</p>
    <div id="sr-picker"></div>
    <h3>我的題庫 <span id="sr-mine-count"></span></h3>
    <ul id="sr-mine" class="sr-mine"></ul>
    <div class="row">
      <button id="sr-fill" class="ghost" type="button">🎲 隨機補滿</button>
      <button id="sr-ready" class="big primary" type="button">我選好了</button>
    </div>
    <div id="sr-readyboard" class="sr-readyboard"></div>
    <button id="sr-begin" class="ghost host-only" type="button">⏩ 不等了，直接開始</button>
  </section>

  <section id="sr-sing" class="sr-panel hidden">
    <div class="sr-big">🎤 輪到你當歌手！</div>
    <p class="sr-tip">按「我準備好了」後倒數 3 秒，<b>原曲自動開播，只播一次、不能重播</b>——你要即時跟上，用<b>空耳</b>在語音裡唱給大家猜。不要直接說出歌名。<br>建議戴耳機，免得原曲被你的麥克風收進去。</p>
    <div id="sr-eq" class="sr-status">載入音樂中…</div>
    <button id="sr-play" class="big primary" type="button" disabled>🎤 我準備好了！</button>
    <p id="sr-singwho" class="sr-tip"></p>
  </section>

  <section id="sr-guess" class="sr-panel hidden">
    <div id="sr-guess-title" class="sr-big"></div>
    <p id="sr-guess-tip" class="sr-tip">用語音聽歌手空耳演唱，猜是哪一首。<b>每人只能猜一次</b>，選了就不能改！</p>
    <div id="sr-choices" class="sr-choices"></div>
    <div id="sr-search" class="sr-search hidden">
      <input id="sr-search-input" placeholder="輸入歌名／歌手搜尋…" autocomplete="off" spellcheck="false">
      <ul id="sr-search-list" class="sp-list"></ul>
    </div>
    <p id="sr-mine-guess" class="sr-mineguess"></p>
    <div id="sr-who" class="sr-who"></div>
  </section>

  <section id="sr-result" class="sr-panel hidden">
    <div class="sr-caption">這首歌是</div>
    <div id="sr-answer" class="sr-answer"></div>
    <div id="sr-answer-sub" class="sr-tip"></div>
    <div id="sr-singer-row" class="sr-singer"></div>
    <div id="sr-rows" class="sr-rows"></div>
    <h3>目前排行</h3>
    <div id="sr-rank" class="rank-table"></div>
    <button id="sr-next" class="big primary hidden" type="button">下一位</button>
    <p id="sr-nextin" class="tip"></p>
  </section>

  <div class="row sr-host">
    <button id="sr-force" class="ghost host-only" type="button">⏩ 強制揭曉</button>
    <button id="sr-skip" class="ghost host-only" type="button">⤼ 略過這一回合</button>
    <button id="sr-end" class="ghost host-only" type="button">■ 結束遊戲</button>
    <button id="sr-lobby" class="ghost host-only" type="button">⌂ 回大廳</button>
    <button id="sr-quit" class="ghost" type="button">離開</button>
  </div>
  <div class="sr-yt"><div id="sr-yt"></div></div>
</main>

<main id="screen-sora-final" class="screen sora">
  <h1>🏆 最終排行榜</h1>
  <p id="sr-final-sub" class="sub"></p>
  <div id="sr-podium" class="podium"></div>
  <div id="sr-table" class="rank-table"></div>
  <div class="row">
    <button id="sr-final-lobby" class="big primary" type="button">回房間大廳</button>
    <button id="sr-final-leave" class="ghost" type="button">離開房間</button>
  </div>
  <p id="sr-final-wait" class="tip"></p>
</main>`;

const meId = () => A.me().id;
const panel = (id) => { ['sr-pick', 'sr-sing', 'sr-guess', 'sr-result'].forEach((x) => $(x).classList.toggle('hidden', x !== id)); };
const isSinger = () => !!(S.state && S.state.singer && S.state.singer.id === meId());
const myRow = () => (S.state ? S.state.players.find((p) => p.id === meId()) : null);
const canGuess = () => { const r = myRow(); return A.isContestant() && !isSinger() && !!r && !r.late; };

function build() {
  const sec = el('section', 'card gset hidden');
  sec.id = 'set-soramimi';
  sec.innerHTML = SETTINGS_HTML;
  $('l-settings').append(sec);
  document.body.insertAdjacentHTML('beforeend', SCREENS_HTML);
}

// ===================== 設定面板 =====================
const NUM = ['perPlayer', 'rounds', 'clipSecs', 'singSecs', 'autoNext'];
function fillSettings(s, ctx) {
  const counts = ctx.info.counts || {};
  const box = $('sr-categories');
  const sig = JSON.stringify(counts);
  if (box.dataset.built !== sig) {
    box.replaceChildren();
    CATEGORIES.filter((c) => c.id in counts).forEach((c) => { // 純音樂題庫伺服器不開放，不列出
      const n = counts[c.id] || 0;
      const label = el('label', 'chip' + (n ? '' : ' disabled'));
      const input = document.createElement('input');
      input.type = 'checkbox'; input.value = c.id; input.disabled = !n;
      label.append(input, ` ${c.label}　${n ? n + ' 首' : '即將推出'}`);
      box.append(label);
    });
    box.dataset.built = sig;
  }
  box.querySelectorAll('input').forEach((i) => { i.checked = s.categories.includes(i.value); });
  for (const k of NUM) $('sr-' + k).value = String(s[k]);
  $('sr-answerMode').value = s.answerMode;
  $('sr-voice').disabled = !ctx.host;
}
const readSettings = () => {
  const s = { categories: [...document.querySelectorAll('#sr-categories input:checked')].map((i) => i.value), answerMode: $('sr-answerMode').value };
  for (const k of NUM) s[k] = Number($('sr-' + k).value);
  return s;
};

// ===================== 進入／離開 =====================
function enter() {
  Object.assign(S, { state: null, mine: { picks: [], max: 10, ready: false }, turn: null, song: null, endsAt: null, startAt: null, guess: null, reveal: null, final: null, playing: false, cued: false, readySent: false, played: false, clipDone: false });
  clearTimeout(S.playTimer);
  clearInterval(S.tick);
  S.tick = setInterval(tick, 200);
}
function exit() {
  clearInterval(S.tick); S.tick = null;
  clearTimeout(S.playTimer);
  if (S.player) S.player.stop();
  S.state = null; S.turn = null; S.song = null;
}

// ===================== 訊息 =====================
function message(m) {
  switch (m.t) {
    case 'state': return onState(m);
    case 'mine': S.mine = m; renderMine(); return;
    case 'results': if (S.picker) S.picker.setResults(m.list, m.q); return;
    case 'pickError': A.toast(m.msg || '不能這樣選', true); return;
    case 'turn': return onTurn(m);
    case 'song': return onSong(m);
    case 'sing': if (S.turn && m.idx === S.turn.idx) { S.endsAt = m.endsAt; S.startAt = m.startAt; scheduleSingerPlay(); render(); } return;
    case 'you': if (S.turn && m.idx === S.turn.idx) { S.guess = m.n; render(); } return;
    case 'reveal': return onReveal(m);
    case 'skipped': A.toast(m.reason, true); return;
    case 'final': return onFinal(m);
    default: return;
  }
}

function onHub() {
  if (S.reveal && S.state && S.state.phase === 'reveal') applyNext();
  if (S.final) applyFinalButtons();
  if (S.state) render();
}

function onState(m) {
  S.state = m;
  if (m.phase === 'final') return;
  if (m.phase === 'picking') { S.turn = null; S.reveal = null; S.song = null; }
  A.show('sora');
  render();
}

function onTurn(m) {
  S.turn = m; S.guess = null; S.reveal = null; S.song = null; S.endsAt = null; S.startAt = null; S.cued = false; S.playing = false;
  S.readySent = false; S.played = false; S.clipDone = false;
  clearTimeout(S.playTimer);
  if (S.player) S.player.stop();
  render();
}

function onReveal(m) {
  S.reveal = m;
  clearTimeout(S.playTimer);
  if (S.player) S.player.stop();
  S.playing = false;
  A.show('sora');
  render();
  applyNext();
}

function onFinal(m) {
  S.final = m;
  if (S.player) S.player.stop();
  $('sr-final-sub').textContent = `共 ${m.total} 回合`;
  renderRanking({ podium: $('sr-podium'), table: $('sr-table') }, m.ranking, meId(), (r) => `猜對 ${r.correct} 首・當歌手 ${r.sang} 次`);
  A.show('sora-final');
  applyFinalButtons();
}

function applyFinalButtons() {
  $('sr-final-lobby').classList.toggle('hidden', !A.isHost());
  $('sr-final-wait').textContent = A.isHost() ? '' : '等待房主回到大廳…';
}

// ===================== 畫面 =====================
function render() {
  const st = S.state;
  if (!st || st.phase === 'final') return;
  const me = myRow();
  $('sr-score').textContent = me ? `${me.score} 分` : '';
  $('sr-force').classList.toggle('hidden', st.phase !== 'sing');
  if (st.phase === 'picking') {
    $('sr-round').textContent = '🎤 挑歌中';
    panel('sr-pick');
    renderPick();
  } else if (st.phase === 'reveal' && S.reveal) {
    $('sr-round').textContent = `第 ${S.reveal.idx} / ${S.reveal.total} 回合`;
    panel('sr-result');
    renderResult();
  } else if ((st.phase === 'intro' || st.phase === 'sing') && S.turn) {
    $('sr-round').textContent = `第 ${S.turn.idx} / ${S.turn.total} 回合`;
    if (isSinger()) { panel('sr-sing'); renderSinger(); } else { panel('sr-guess'); renderGuess(); }
  }
  tick();
}

// ----- 挑歌 -----
function renderPick() {
  const st = S.state;
  $('sr-pick-n').textContent = String(S.mine.max || st.perPlayer);
  $('sr-begin').classList.toggle('hidden', !A.isHost());
  const playing = A.isContestant();
  $('sr-pick').classList.toggle('spectating', !playing);
  $('sr-picker').classList.toggle('hidden', !playing);
  $('sr-fill').classList.toggle('hidden', !playing);
  $('sr-ready').classList.toggle('hidden', !playing);
  renderMine();
  const board = $('sr-readyboard');
  board.replaceChildren();
  st.players.forEach((p) => {
    const c = el('span', 'sr-rd' + (p.ready ? ' on' : '') + (p.connected ? '' : ' off'), `${p.ready ? '✅' : '✏️'} ${p.nick} ${p.picks}/${st.perPlayer}`);
    board.append(c);
  });
}

function renderMine() {
  const m = S.mine;
  $('sr-mine-count').textContent = `（${m.picks.length} / ${m.max}）`;
  const ul = $('sr-mine');
  ul.replaceChildren();
  m.picks.forEach((p) => {
    const li = el('li');
    li.append(el('span', 'sr-song', p.main), el('small', null, p.sub || ''));
    const b = el('button', 'ghost', '✕');
    b.type = 'button'; b.title = '移除';
    b.disabled = m.ready;
    b.addEventListener('click', () => A.send({ t: 'remove', id: p.id }));
    li.append(b);
    ul.append(li);
  });
  if (S.picker) S.picker.mark(m.picks.map((p) => p.id));
  const b = $('sr-ready');
  b.textContent = m.ready ? '✅ 已準備（點一下取消）' : (m.picks.length === m.max ? '我選好了' : `還差 ${m.max - m.picks.length} 首`);
  b.disabled = !m.ready && m.picks.length !== m.max;
  $('sr-fill').disabled = m.ready;
}

// ----- 歌手 -----
function renderSinger() {
  const sing = S.state.phase === 'sing';
  const b = $('sr-play');
  b.classList.toggle('hidden', sing || S.readySent);
  b.disabled = !S.cued;
  $('sr-singwho').textContent = sing ? '大家正在猜了，唱起來！' : S.readySent ? '' : '準備好就按下去，別讓大家等太久。';
  let eq = '載入音樂中…';
  if (sing) {
    const left = S.startAt ? Math.ceil((A.toLocal(S.startAt) - Date.now()) / 1000) : 0;
    if (left > 0) eq = `⏳ ${left}…`;
    else if (S.playing) eq = '🔊 原曲播放中——只有這一次，跟上！';
    else if (S.clipDone) eq = '🎶 原曲結束了，繼續唱完！';
    else eq = '🎧 準備開唱…';
  } else if (S.readySent) eq = '等待音樂啟用…';
  else if (S.cued) eq = '🎧 音樂已就緒（只有你聽得到）';
  $('sr-eq').textContent = eq;
}

/** 歌手：按下「我準備好了」（使用者手勢，瀏覽器才允許之後由程式自動開播） */
function singerReady() {
  if (!S.cued || !S.turn || !S.song || S.readySent) return;
  S.readySent = true;
  if (S.activated) A.send({ t: 'ready', idx: S.turn.idx });
  else S.player.activate(); // 啟用完成後 onActivated 會送 ready
  render();
}

/** 原曲只自動開播一次：倒數結束的那一刻播（斷線重連回來若已經開播，就從該有的位置接上，不重頭） */
function scheduleSingerPlay() {
  clearTimeout(S.playTimer);
  if (!isSinger() || !S.player || !S.song || !S.cued || !S.startAt || S.played) return;
  const fire = (offsetSec = 0) => { if (S.played) return; S.played = true; S.player.play(offsetSec); };
  const wait = A.toLocal(S.startAt) - Date.now();
  if (wait > 0) S.playTimer = setTimeout(() => fire(), wait);
  else if (-wait < 800) fire();
  else if (-wait < S.song.duration * 1000) fire(-wait / 1000);
  else { S.played = true; S.clipDone = true; }
}

function ensurePlayer() {
  if (S.player) return S.player;
  const p = new ClipPlayer('sr-yt', {
    onCued: () => { S.cued = true; scheduleSingerPlay(); render(); },
    onActivated: () => { S.activated = true; if (S.turn && S.song) A.send({ t: 'ready', idx: S.turn.idx }); render(); },
    onPlaying: () => { S.playing = true; render(); },
    onClipEnd: () => { S.playing = false; S.clipDone = true; render(); },
    onError: () => {
      A.toast('這首歌的影片在你的裝置無法播放，略過這一回合', true);
      if (S.turn) A.send({ t: 'playError', idx: S.turn.idx });
    },
    onStuck: () => A.toast('沒有聲音？檢查一下音量或瀏覽器的自動播放設定', true),
  });
  p.initP = p.init();
  p.initP.then(() => p.setVolume(A.getVolume()));
  S.player = p;
  return p;
}

function onSong(m) {
  if (!S.turn || m.idx !== S.turn.idx) return;
  S.song = m; S.cued = false; S.playing = false;
  const p = ensurePlayer();
  p.initP.then(() => { if (S.song === m) p.cue({ ytId: m.ytId, start: m.start, duration: m.duration }); });
  render();
}

// ----- 猜題者 -----
const norm = (s) => String(s || '').normalize('NFKC').toLowerCase().replace(/\s+/g, '');
function renderGuess() {
  const t = S.turn;
  const st = S.state;
  $('sr-guess-title').textContent = `🎧 ${t.singer.nick} 正在空耳演唱`;
  const can = canGuess();
  const guessing = st.phase === 'sing';
  $('sr-guess-tip').textContent = !A.isContestant() ? '你是旁觀者：看大家猜，不能作答。'
    : !can ? '你是中途加入的，下一回合起就能猜。'
      : guessing ? '用語音聽他空耳演唱，猜是哪一首。每人只能猜一次，選了就不能改！' : '等歌手準備好…';
  const choicesEl = $('sr-choices');
  const searchEl = $('sr-search');
  choicesEl.classList.toggle('hidden', t.answerMode !== 'choice');
  searchEl.classList.toggle('hidden', t.answerMode !== 'search');
  const locked = S.guess != null;
  if (t.answerMode === 'choice') {
    if (choicesEl.dataset.turn !== String(t.idx)) {
      choicesEl.dataset.turn = String(t.idx);
      choicesEl.replaceChildren();
      t.choices.forEach((c, i) => {
        const d = el('button', 'sr-choice');
        d.type = 'button'; d.dataset.i = String(i);
        d.append(el('span', 'n', String(i + 1)), el('b', null, c.main), el('small', null, c.sub || ''));
        d.addEventListener('click', () => pickChoice(i));
        choicesEl.append(d);
      });
    }
    [...choicesEl.children].forEach((d, i) => {
      d.classList.toggle('picked', S.guess === i);
      d.disabled = !can || !guessing || locked;
    });
  } else {
    $('sr-search-input').disabled = !can || !guessing || locked;
    if (locked) $('sr-search-list').replaceChildren();
  }
  $('sr-mine-guess').textContent = '';
  if (locked) {
    const c = t.answerMode === 'choice' ? t.choices[S.guess] : t.pool[S.guess];
    $('sr-mine-guess').textContent = c ? `🔒 你猜的是「${c.main}」，等待其他人…` : '🔒 已送出，等待其他人…';
  }
  const who = $('sr-who');
  who.replaceChildren();
  st.players.filter((p) => p.id !== t.singer.id && !p.late).forEach((p) => who.append(el('span', 'sr-rd' + (p.guessed ? ' on' : '') + (p.connected ? '' : ' off'), `${p.guessed ? '🔒' : '🤔'} ${p.nick}`)));
}

function pickChoice(i) {
  if (!canGuess() || S.state.phase !== 'sing' || S.guess != null) return;
  S.guess = i;
  A.send({ t: 'guess', idx: S.turn.idx, choice: i });
  render();
}

function searchPool(q) {
  const list = $('sr-search-list');
  list.replaceChildren();
  const n = norm(q);
  if (!n || !S.turn || !S.turn.pool) return;
  S.turn.pool.filter((c) => norm(c.main + c.sub).includes(n)).slice(0, 10).forEach((c) => {
    const li = el('li');
    li.append(el('b', null, c.main));
    if (c.sub) li.append(el('small', null, c.sub));
    li.addEventListener('click', () => {
      if (!canGuess() || S.state.phase !== 'sing' || S.guess != null) return;
      S.guess = c.k;
      A.send({ t: 'guess', idx: S.turn.idx, pool: c.k });
      $('sr-search-input').value = '';
      render();
    });
    list.append(li);
  });
}

// ----- 結果 -----
function renderResult() {
  const m = S.reveal;
  $('sr-answer').textContent = m.answer.main;
  $('sr-answer-sub').textContent = [m.answer.sub, m.answer.work && m.answer.work !== m.answer.main ? m.answer.work : ''].filter(Boolean).join('　・　');
  const sr = $('sr-singer-row');
  sr.replaceChildren(el('span', null, `🎤 歌手 ${m.singer.nick}　`), el('b', m.singer.points > 0 ? 'ok' : '', m.singer.points > 0 ? `+${m.singer.points}（${m.correctCount} 人猜對）` : '沒有人猜對…'));
  const rows = $('sr-rows');
  rows.replaceChildren();
  m.rows.forEach((r) => {
    const row = el('div', 'mrow' + (r.id === meId() ? ' me' : ''));
    const nm = el('span', 'nm', r.nick);
    nm.append(el('small', null, r.guess ? `猜「${r.guess.main}」` : '沒有猜'));
    row.append(el('span', 'rk', r.first ? '⚡' : ''), nm, el('span', 'pt ' + (r.correct ? 'ok' : ''), (r.correct ? '✔ ' : r.guess ? '✘ ' : '') + (r.points > 0 ? `+${r.points}` : '0')), el('span', 'tt', String(r.total)));
    rows.append(row);
  });
  const rank = $('sr-rank');
  rank.replaceChildren();
  m.ranking.forEach((r) => {
    const row = el('div', 'mrow' + (r.id === meId() ? ' me' : ''));
    row.append(el('span', 'rk', String(r.rank)), el('span', 'nm', r.nick), el('span', 'pt', String(r.score)), el('span', 'tt', ''));
    rank.append(row);
  });
}

function applyNext() {
  const host = A.isHost();
  $('sr-next').classList.toggle('hidden', !host);
  $('sr-next').textContent = S.reveal && S.reveal.last ? '查看最終排行榜' : '下一位歌手';
  if (!host) $('sr-nextin').textContent = '等待房主…（也會自動換下一位）';
}

// ===================== 計時 =====================
function tick() {
  const st = S.state;
  const t = $('sr-timer');
  if (!st) return;
  if (st.phase === 'sing' && S.endsAt) {
    const from = S.startAt ? Math.max(Date.now(), A.toLocal(S.startAt)) : Date.now(); // 倒數期間時限先不動
    const left = Math.max(0, Math.ceil((A.toLocal(S.endsAt) - from) / 1000));
    t.textContent = String(left);
    t.classList.toggle('low', left <= 10);
    if (S.turn && S.startAt) { // 倒數期間：歌手看大字倒數、猜題者看「N 秒後開唱」
      const pre = Math.ceil((A.toLocal(S.startAt) - Date.now()) / 1000);
      if (isSinger()) renderSinger();
      else if (pre > 0) $('sr-guess-tip').textContent = `🎬 ${S.turn.singer.nick} ${pre} 秒後開唱，準備好耳朵！`;
      else if (pre === 0 || S.lastPre > 0) { S.lastPre = pre; renderGuess(); }
      S.lastPre = pre;
    }
  } else {
    t.textContent = ''; t.classList.remove('low');
  }
  if (st.phase === 'reveal' && S.reveal && S.reveal.nextAt) {
    const r = Math.max(0, Math.ceil((A.toLocal(S.reveal.nextAt) - Date.now()) / 1000));
    $('sr-nextin').textContent = r > 0 ? `${r} 秒後自動下一位` : '';
  }
}

// ===================== 綁定一次性事件 =====================
function init(api) {
  A = api;
  build();
  S.picker = createPicker({
    onSearch: (q) => A.send({ t: 'search', q }),
    onPick: (it) => A.send({ t: 'add', id: it.id }),
  });
  $('sr-picker').append(S.picker.el);
  $('sr-fill').addEventListener('click', () => A.send({ t: 'fill' }));
  $('sr-ready').addEventListener('click', () => A.send({ t: 'ready', on: !S.mine.ready }));
  $('sr-begin').addEventListener('click', () => { if (confirm('直接開始？還沒準備好的人會用目前選的歌參加（沒選歌的人只負責猜）。')) A.send({ t: 'begin' }); });
  $('sr-play').addEventListener('click', singerReady);
  $('sr-search-input').addEventListener('input', (e) => searchPool(e.target.value));
  $('sr-next').addEventListener('click', () => A.send({ t: 'next' }));
  $('sr-force').addEventListener('click', () => A.send({ t: 'forceReveal' }));
  $('sr-skip').addEventListener('click', () => { if (confirm('略過這一回合（不計分）？')) A.send({ t: 'skip' }); });
  $('sr-end').addEventListener('click', () => { if (confirm('結束遊戲並顯示最終排行榜？')) A.send({ t: 'end' }); });
  $('sr-lobby').addEventListener('click', () => { if (confirm('結束這場遊戲，回到房間大廳？')) A.toLobby(); });
  $('sr-quit').addEventListener('click', () => { if (confirm('離開房間？')) A.leave(); });
  $('sr-final-lobby').addEventListener('click', () => A.toLobby());
  $('sr-final-leave').addEventListener('click', () => A.leave());
  document.addEventListener('keydown', (e) => {
    if (!$('screen-sora').classList.contains('active') || $('sr-guess').classList.contains('hidden')) return;
    if (e.target.tagName === 'INPUT' || e.target.tagName === 'SELECT') return;
    if (/^(Digit|Numpad)[1-8]$/.test(e.code) && S.turn && S.turn.answerMode === 'choice') pickChoice(Number(e.code.slice(-1)) - 1);
  });
}

export default {
  meta: { id: 'soramimi', name: '空耳歌王', icon: '🎤', desc: '每人先挑一批自己的歌當題庫；輪流當歌手，只有歌手聽得到音樂，要用「空耳」把歌唱出來讓大家猜！猜的人越多猜對，歌手分數越高。需要大家自備語音通話（Discord、LINE 等）。' },
  init,
  settings: {
    get el() { return $('set-soramimi'); },
    fill: fillSettings,
    read: readSettings,
    startHint: () => ($('sr-voice').checked ? null : '請先確認大家已開好語音通話（勾選上方的方塊）'),
  },
  enter, exit, message, onHub,
};
