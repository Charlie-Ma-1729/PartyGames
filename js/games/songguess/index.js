// 猜歌大賽（多人）用戶端：各自播放、鎖定、揭曉、排行榜。房間／連線由 js/hub/client.js 處理。
import { sharedPlayer } from '../../player.js';
import * as ui from '../../ui.js';
import { readForm, fillForm, renderFinal, renderReveal } from './view.js';

const $ = (id) => document.getElementById(id);

const S = {
  q: null, phase: 'preload', windowMs: 0, state: null, works: [], worksBy: {},
  sel: -1, selKey: null, selLabel: '', locked: false, canAnswer: false,
  localT0: null, t0Server: null, quorumEndsAt: null, nextAt: null, reveal: null, go: null,
  player: null, handlers: null, activated: false, activateTimer: null, goTimer: null, tickTimer: null,
};
let A = null; // hub 提供的介面（見 js/hub/client.js）

const isHost = () => A.isHost();
const isScreen = () => A.isScreen();
/** 這台裝置要不要載入 YouTube：主畫面一定要；玩家只有「各自播放」才要 */
const needsVideo = () => isScreen() || (S.q && S.q.playMode === 'own');
const meId = () => A.me().id;

// ===================== 進入／離開 =====================
function enter() {
  resetGame();
  S.tickTimer = setInterval(tick, 200);
}

function resetGame() {
  clearTimeout(S.goTimer); clearTimeout(S.activateTimer);
  Object.assign(S, { q: null, phase: 'preload', state: null, works: [], worksBy: {}, sel: -1, selKey: null, selLabel: '', locked: false, canAnswer: false, localT0: null, t0Server: null, quorumEndsAt: null, nextAt: null, reveal: null, go: null });
}

function exit() {
  clearTimeout(S.goTimer); clearTimeout(S.activateTimer); clearInterval(S.tickTimer);
  S.tickTimer = null; S.q = null;
  if (S.player) S.player.stop();
  document.querySelector('.stage').classList.remove('mp', 'mp-screenmode');
}

// ===================== 訊息 =====================
function message(m) {
  switch (m.t) {
    case 'state': return onState(m);
    case 'works': S.worksBy[m.ask || 'work'] = m.list.map((w) => ({ ...w, n: norm(w.main + ' ' + w.sub) })); if (S.q && (S.q.ask || 'work') === (m.ask || 'work')) S.works = S.worksBy[m.ask || 'work']; return;
    case 'question': return onQuestion(m);
    case 'go': return onGo(m);
    case 't0': if (S.q && m.idx === S.q.idx) S.t0Server = m.t0; return;
    case 'quorum': if (S.q && m.idx === S.q.idx) S.quorumEndsAt = m.endsAt; return;
    case 'you': return onYou(m);
    case 'reveal': return onReveal(m);
    case 'skipped': A.toast(`本題略過：${m.reason}`, true); return;
    case 'final': return onFinal(m);
    default: return;
  }
}

function onState(m) {
  S.state = m; S.phase = m.phase;
  if (m.phase === 'reveal' && S.reveal) applyRevealButton(); // 房主可能剛換人
  if (m.phase === 'final') $('f-lobby').classList.toggle('hidden', !isHost());
  renderLocks();
}

function onHub() {
  if (S.phase === 'reveal' && S.reveal) applyRevealButton();
  if (S.phase === 'final') { $('f-lobby').classList.toggle('hidden', !isHost()); $('f-wait').textContent = isHost() ? '' : '等待房主回到大廳…'; }
}

// ===================== 出題 =====================
function showGame() {
  ui.showScreen('game');
  const stage = document.querySelector('.stage');
  stage.classList.add('mp');
  stage.classList.toggle('mp-screenmode', S.q.playMode === 'screen' && !isScreen());
  $('btn-quit').textContent = '離開';
}

function onQuestion(m) {
  // 斷線重連：伺服器會把「目前這題」再送一次。同一題就只更新資料，不重置選擇、不重載影片、不重置計時
  if (S.q && S.q.idx === m.idx && S.phase !== 'final') {
    S.q = m;
    S.works = S.worksBy[m.ask || 'work'] || [];
    showGame();
    renderLocks();
    return;
  }
  clearTimeout(S.goTimer); clearTimeout(S.activateTimer);
  S.q = m; S.works = S.worksBy[m.ask || 'work'] || []; S.go = null; S.phase = 'preload'; S.windowMs = (m.duration + m.graceSecs) * 1000;
  S.sel = -1; S.selKey = null; S.selLabel = ''; S.locked = false; S.canAnswer = false;
  S.localT0 = null; S.t0Server = null; S.quorumEndsAt = null; S.nextAt = null; S.reveal = null;
  showGame();
  ui.showQuestion({ kind: m.kind, prompt: m.prompt, ask: m.ask }, m.idx, m.total, m.choices);
  $('mtype-input').placeholder = m.ask === 'artist' ? '輸入歌手名搜尋…' : m.ask === 'title' ? '輸入歌名搜尋…' : '輸入作品名（中文／原文都可以）搜尋…';
  ui.lockChoices(false);
  $('mreveal').classList.add('hidden');
  $('mstatus').classList.remove('hidden');
  const typing = m.answerMode === 'typing';
  $('mtype').classList.toggle('hidden', typing ? isScreen() : true);
  $('mtype').classList.remove('locked');
  $('mtype-input').value = ''; $('mtype-list').replaceChildren(); $('mtype-picked').textContent = '';
  setMainButton();
  $('m-clock').textContent = '';
  $('m-quorum').textContent = '';
  $('btn-mforce').classList.add('hidden'); $('btn-mskip').classList.toggle('hidden', false); $('btn-mend').classList.remove('hidden');
  renderLocks();

  if (needsVideo()) {
    ensurePlayer();
    ui.setPlaying(false);
    $('cover-text').textContent = '載入影片中…';
    // 第一題時播放器可能還在載入 YouTube API：等它好了再預載（期間若已換題就放棄）
    S.player.initP.then(() => { if (S.q === m) S.player.cue({ ytId: m.ytId, start: m.start, duration: m.duration }); });
  } else {
    $('cover-text').textContent = '🎧 請聽主畫面的音樂';
  }
}

function ensurePlayer() {
  if (S.player && S.player.h === S.handlers) return;
  S.handlers = {
    onCued: () => onCued(),
    onActivated: () => { S.activated = true; clearTimeout(S.activateTimer); sendReady(); },
    onPlaying: () => {
      if (S.phase !== 'playing' && S.phase !== 'preload') return;
      if (S.localT0 == null) {
        S.localT0 = Date.now(); // 本機「真正開始出聲」的時間點 = 我的作答計時起點
        if (isScreen() && S.q) A.send({ t: 'playing', idx: S.q.idx });
      }
      ui.setPlaying(true);
    },
    onClipEnd: () => { ui.setPlaying(false); },
    onProgress: (elapsed, duration) => { if (S.phase === 'playing') ui.setProgress(elapsed, duration); },
    onError: () => {
      if (S.q && (S.phase === 'preload' || S.phase === 'playing')) {
        A.send({ t: 'playError', idx: S.q.idx });
        A.toast('這首影片在你的裝置無法播放，本題你不計分', true);
        S.canAnswer = false; setMainButton();
      }
    },
    onStuck: () => { if (S.phase === 'preload' || S.phase === 'playing') A.toast('沒有聲音？點一下頁面試試', true); },
  };
  S.player = sharedPlayer(S.handlers);
  S.player.h = S.handlers;
  S.player.initP.then(() => { S.player.setVolume(A.getVolume()); });
}

function sendReady() { if (S.q) A.send({ t: 'ready', idx: S.q.idx }); $('cover-text').textContent = '✅ 已就緒，等待其他人…'; }

/** 影片預載好了：已取得播放權限 → 直接 ready；否則先嘗試自動啟用，不行再請使用者點一下 */
function onCued() {
  if (S.q && S.phase === 'playing' && S.go) return playFromGo(); // 播放中才重新整理／重連回來
  if (!S.q || S.phase !== 'preload') return;
  if (S.activated) return sendReady();
  S.player.activate();
  S.activateTimer = setTimeout(() => {
    if (S.activated || S.phase !== 'preload') return;
    $('cover-text').textContent = '👆 點一下這裡，啟用聲音並準備好';
    $('cover').classList.add('tap');
  }, 1500);
}

function onGo(m) {
  if (!S.q || m.idx !== S.q.idx) return;
  S.phase = 'playing'; S.canAnswer = !isScreen(); $('cover').classList.remove('tap');
  setMainButton();
  $('btn-mforce').classList.remove('hidden'); // 只有房主看得到（.host-only）
  S.go = m;
  if (needsVideo() && S.player) playFromGo();
}

/** 依伺服器的開播時間點播放：還沒到就排程；已經過了（重連／重新整理回來）就從「應該播到的位置」接著播 */
function playFromGo() {
  const m = S.go;
  if (!m || !S.q || m.idx !== S.q.idx || !S.player || !S.player.clip) return; // 影片還沒預載好 → onCued 會再呼叫
  const lateMs = A.now() - m.startAt; // > 0 = 已經開播一段時間了
  clearTimeout(S.goTimer);
  if (lateMs > 800) {
    S.localT0 = Date.now() - lateMs; // 作答經過時間與其他人一致
    if (lateMs < S.q.duration * 1000) S.player.play(lateMs / 1000);
    else { ui.setPlaying(false); $('cover-text').textContent = '⏱ 音樂已經播完，可以直接作答'; }
  } else {
    S.goTimer = setTimeout(() => S.player.play(), Math.max(0, A.toLocal(m.startAt) - Date.now()));
  }
}

function onYou(m) { // 重連：還原我的選擇與鎖定狀態
  if (!S.q || m.idx !== S.q.idx) return;
  if (m.locked) { S.locked = true; ui.lockChoices(true); }
  if (m.selection) {
    if (m.selection.choice !== undefined) { S.sel = m.selection.choice; ui.setPicked(S.sel); }
    else if (m.selection.key) { S.selKey = m.selection.key; const w = S.works.find((x) => x.k === m.selection.key); S.selLabel = w ? w.main : ''; $('mtype-picked').replaceChildren(pickedNode()); }
  }
  setMainButton();
}

// ===================== 作答 =====================
function setMainButton() {
  const b = $('btn-main');
  if (isScreen()) return;
  if (S.phase === 'reveal') return; // 由 onReveal 設定
  if (!S.q) { b.disabled = true; return; }
  if (S.locked) { b.textContent = '✅ 已鎖定，等待其他人…'; b.disabled = true; return; }
  if (S.phase === 'preload') { b.textContent = '⏳ 等待大家載入影片…'; b.disabled = true; return; }
  if (!S.canAnswer) { b.textContent = '本題你無法作答'; b.disabled = true; return; }
  const has = S.q.answerMode === 'choice' ? S.sel >= 0 : !!S.selKey;
  b.textContent = has ? '🔒 鎖定答案 (空白鍵)' : '請先選一個答案';
  b.disabled = !has;
}

function pickChoice(i) {
  if (!S.canAnswer || S.locked || S.phase !== 'playing') return;
  S.sel = i; ui.setPicked(i);
  A.send({ t: 'select', idx: S.q.idx, choice: i });
  setMainButton();
}

function pickedNode() {
  const f = document.createDocumentFragment();
  if (!S.selLabel) return f;
  f.append('你的答案：');
  const b = document.createElement('b'); b.textContent = S.selLabel; f.append(b);
  return f;
}

function lockNow() {
  if (!S.q || S.locked || !S.canAnswer || S.phase !== 'playing') return;
  const has = S.q.answerMode === 'choice' ? S.sel >= 0 : !!S.selKey;
  if (!has) return;
  const msg = { t: 'lock', idx: S.q.idx, elapsedMs: S.localT0 != null && S.q.playMode === 'own' ? Date.now() - S.localT0 : 0 };
  if (S.q.answerMode === 'choice') msg.choice = S.sel; else msg.key = S.selKey;
  A.send(msg);
  S.locked = true;
  ui.lockChoices(true);
  $('mtype').classList.add('locked');
  setMainButton();
}

// ----- 打字搜尋 -----
const norm = (s) => String(s || '').normalize('NFKC').toLowerCase().replace(/[\s·・:：\-–—_!！?？,.，。、'’"“”()（）[\]【】~～]/g, '');
let activeLi = -1;
function search(q) {
  const n = norm(q);
  const list = $('mtype-list');
  list.replaceChildren(); activeLi = -1;
  if (!n) return;
  const hits = S.works.filter((w) => w.n.includes(n));
  hits.sort((a, b) => (norm(b.main).startsWith(n) - norm(a.main).startsWith(n)) || a.main.length - b.main.length);
  hits.slice(0, 10).forEach((w) => {
    const li = document.createElement('li');
    const b = document.createElement('b'); b.textContent = w.main;
    li.append(b);
    if (w.sub) { const s = document.createElement('small'); s.textContent = w.sub; li.append(s); }
    li.addEventListener('click', () => pickWork(w));
    list.append(li);
  });
  if (!hits.length) { const li = document.createElement('li'); li.textContent = '找不到，換個關鍵字試試'; li.style.cursor = 'default'; list.append(li); }
}
function pickWork(w) {
  if (!S.canAnswer || S.locked || S.phase !== 'playing') return;
  S.selKey = w.k; S.selLabel = w.main;
  $('mtype-picked').replaceChildren(pickedNode());
  $('mtype-list').replaceChildren(); $('mtype-input').value = '';
  A.send({ t: 'select', idx: S.q.idx, key: w.k });
  setMainButton();
}

// ===================== 揭曉 / 最終 =====================
function onReveal(m) {
  if (!S.q) return; // 還沒收到題目就收到揭曉（極少見）
  S.phase = 'reveal'; S.canAnswer = false; S.reveal = m; S.nextAt = m.nextAt;
  clearTimeout(S.goTimer);
  ui.showAnswer({ kind: m.kind, answer: m.answer });
  if (m.correct.index !== undefined) ui.markChoices(m.correct.index);
  ui.lockChoices(true);
  $('mtype').classList.add('locked');
  if (m.correct.key !== undefined) {
    const me = m.rows.find((r) => r.id === meId());
    $('mtype-picked').textContent = me ? (me.correct ? '✔ 答對了！' : me.answered ? '✘ 答錯了' : '未作答') : '';
  }
  if (needsVideo() && S.player) S.player.release(m.revealStart ?? undefined);
  renderReveal(m, meId());
  $('m-quorum').textContent = '';
  $('m-clock').textContent = '';
  $('btn-mforce').classList.add('hidden'); $('btn-mskip').classList.add('hidden');
  applyRevealButton();
  renderLocks();
}

/** 揭曉後的主按鈕：房主＝下一題；其他人＝等待（房主換人時也會重算） */
function applyRevealButton() {
  const b = $('btn-main');
  if (isScreen() || !S.reveal) return;
  if (isHost()) { b.textContent = S.reveal.last ? '查看最終排行榜 (空白鍵)' : '下一題 (空白鍵)'; b.disabled = false; }
  else { b.textContent = '等待房主按下一題…'; b.disabled = true; }
}

function onFinal(m) {
  S.phase = 'final';
  clearTimeout(S.goTimer);
  if (S.player) S.player.stop();
  renderFinal(m.ranking, meId(), m.total);
  $('f-lobby').classList.toggle('hidden', !isHost());
  $('f-wait').textContent = isHost() ? '' : '等待房主回到大廳…';
  ui.showScreen('mfinal');
}

// ===================== 鎖定狀態列 =====================
function renderLocks() {
  const m = S.state;
  if (!m || !S.q) return;
  const box = $('m-locks');
  box.replaceChildren();
  const inGame = m.players.filter((p) => !p.spectator);
  inGame.forEach((p) => {
    const c = document.createElement('span');
    c.className = 'mlock' + (p.locked ? ' on' : '') + (!p.connected ? ' off' : '') + (p.id === meId() ? ' me' : '');
    c.textContent = p.nick;
    box.append(c);
  });
  if (S.phase === 'reveal') $('m-lockcount').textContent = `第 ${m.idx} / ${m.total} 題結束`;
  else if (S.phase === 'preload') $('m-lockcount').textContent = `載入中 ${m.players.filter((p) => p.ready).length} / ${inGame.length}`;
  else $('m-lockcount').textContent = `已鎖定 ${m.locked} / ${m.active}`;
}

// ===================== 計時顯示（每 200ms）=====================
function tick() {
  if (!S.q) return;
  if (S.phase === 'playing') {
    const own = S.q.playMode === 'own' || isScreen();
    let elapsed = null;
    if (own) { if (S.localT0 != null) elapsed = Date.now() - S.localT0; }
    else if (S.t0Server != null) elapsed = A.now() - S.t0Server;
    if (elapsed != null) {
      const left = (S.windowMs - elapsed) / 1000;
      $('m-clock').textContent = left > 0 ? `⏱ 作答剩 ${Math.ceil(left)} 秒` : '⏱ 時間到';
      if (!own) { ui.setProgress(elapsed / 1000, S.q.duration); }
      if (own && elapsed / 1000 > S.q.duration) $('cover-text').textContent = left > 0 ? `⏱ 音樂結束，還能作答 ${Math.ceil(left)} 秒` : '⏱ 時間到，等待揭曉…';
    }
    if (S.quorumEndsAt) {
      const r = Math.max(0, Math.ceil((S.quorumEndsAt - A.now()) / 1000));
      $('m-quorum').textContent = `⏳ 鎖定人數已達標，${r} 秒後揭曉`;
      ui.setCountdown(r > 0 && r <= 5 ? r : null);
    }
  } else if (S.phase === 'reveal' && S.nextAt) {
    const r = Math.max(0, Math.ceil((S.nextAt - A.now()) / 1000));
    $('m-clock').textContent = r > 0 ? `${r} 秒後自動下一題` : '';
  }
}

function mainAction() {
  if (isScreen()) return;
  if (S.phase === 'reveal') { if (isHost()) A.send({ t: 'next' }); return; }
  lockNow();
}

// ===================== 綁定一次性事件 =====================
function init(api) {
  A = api;
  const multi = () => document.body.classList.contains('multi');
  $('btn-main').addEventListener('click', () => { if (multi()) mainAction(); });
  $('btn-mforce').addEventListener('click', () => A.send({ t: 'forceReveal' }));
  $('btn-mskip').addEventListener('click', () => { if (confirm('跳過本題（不計分，換下一首）？')) A.send({ t: 'skip' }); });
  $('btn-mend').addEventListener('click', () => { if (confirm('結束遊戲並顯示最終排行榜？')) A.send({ t: 'end' }); });
  $('btn-mlobby').addEventListener('click', () => { if (confirm('結束這場遊戲，回到房間大廳？')) A.toLobby(); });
  $('btn-quit').addEventListener('click', () => { if (multi() && confirm('離開房間？（你的座位和分數會保留一陣子，可以用同樣暱稱回來）')) A.leave(); });
  $('choices').addEventListener('click', (e) => {
    if (!multi()) return;
    const d = e.target.closest('.choice');
    if (d) pickChoice(Number(d.dataset.i));
  });
  $('cover').addEventListener('click', () => {
    if (!multi() || S.activated || !S.player) return;
    $('cover').classList.remove('tap');
    S.player.activate();
  });
  const inp = $('mtype-input');
  inp.addEventListener('input', () => search(inp.value));
  inp.addEventListener('keydown', (e) => {
    const items = [...$('mtype-list').children];
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      e.preventDefault();
      if (!items.length) return;
      activeLi = (activeLi + (e.key === 'ArrowDown' ? 1 : -1) + items.length) % items.length;
      items.forEach((li, i) => li.classList.toggle('active', i === activeLi));
    } else if (e.key === 'Enter') {
      e.preventDefault();
      (items[activeLi >= 0 ? activeLi : 0] || { click() {} }).click();
    }
  });
  $('f-lobby').addEventListener('click', () => A.toLobby());
  $('f-leave').addEventListener('click', () => A.leave());

  // 鍵盤（多人；音量鍵在 main.js）
  document.addEventListener('keydown', (e) => {
    if (!multi() || !$('screen-game').classList.contains('active')) return;
    if (e.target.tagName === 'INPUT' && e.target.type !== 'range') return;
    if (e.target.tagName === 'SELECT') return;
    if (e.code === 'Space' || e.code === 'Enter') { e.preventDefault(); mainAction(); }
    else if (/^(Digit|Numpad)[1-8]$/.test(e.code) && S.q && S.q.answerMode === 'choice') pickChoice(Number(e.code.slice(-1)) - 1);
  });
}

export default {
  meta: { id: 'songguess', name: '猜歌大賽', icon: '🎵', desc: '聽一小段動漫、流行歌或 OST，搶先猜出它是什麼！可各自播放，也可以由一個大螢幕播給大家聽。' },
  init,
  settings: {
    get el() { return $('set-songguess'); },
    fill: (settings, ctx) => fillForm(settings, ctx.info.counts || {}),
    read: readForm,
    startHint: (ctx) => (ctx.hub.settings.playMode === 'screen' && ctx.hub.screens === 0 ? '請先開啟主畫面（點上方「🖥 開啟主畫面」）' : null),
  },
  enter, exit, message, onHub,
};
