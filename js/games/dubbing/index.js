// 配音大師用戶端：練習／錄音 → 輪流播放評分 → 頒獎下載。房間／連線由 js/hub/client.js 處理，檔案走 HTTP（/api/dubbing、/media/dubbing）。
import { $, el } from '../../hub/view.js';
import * as mic from './audio.js';
import { createExplorer, videoUrl } from './explorer.js';

const UPLOAD_GRACE_MS = 30 * 1000; // 與伺服器一致：限時結束後還有這麼久可以上傳
const audioUrl = (f) => `/media/dubbing/audio/${encodeURIComponent(f)}`;
const outUrl = (f) => `/media/dubbing/outputs/${encodeURIComponent(f)}`;
const shortName = (p) => String(p).split('/').pop();

let A = null;
let explorer = null;
const D = {
  round: null, idx: 0, ui: 'practice', locked: false, busy: false, timer: null, deadline: 0,
  exhibit: null, voted: false, funny: 0, acting: 0, exTimer: null, showVoteTimer: null, hasMic: false, results: null,
};

// ===================== 畫面（只建一次） =====================
const SETTINGS_HTML = `
  <h2>配音大師規則 <span id="dub-lockhint" class="note"></span></h2>
  <div class="dub-secure hidden" id="dub-secure">⚠ 目前的網址不是 HTTPS，瀏覽器不會允許玩家使用麥克風。請用 https:// 或 localhost 開啟。</div>
  <div class="dub-row"><label for="dub-time">⏳ 每關配音限時（分鐘）</label><input id="dub-time" type="number" min="1" max="15" value="5"></div>
  <div class="dub-pick">
    <div class="dub-count">已勾選 <b id="dub-count">0</b> 部影片（每部影片是一關）</div>
    <div id="dub-explorer"></div>
  </div>`;

const SCREENS_HTML = `
<main id="screen-dub-record" class="screen dub">
  <header class="dub-head">
    <h2>🎬 <span id="dub-vname">---</span> <small id="dub-vno"></small></h2>
    <div class="dub-stats"><span id="dub-progress" class="dub-badge">完成 0/0</span><span id="dub-timer" class="dub-badge">⏳ --:--</span></div>
  </header>
  <div class="dub-videobox"><video id="dub-video" controls playsinline></video><div id="dub-countdown" class="dub-countdown hidden">3</div></div>
  <div class="dub-wave"><canvas id="dub-canvas"></canvas><div id="dub-rec" class="dub-rec hidden">🔴 錄音中</div></div>
  <section class="card dub-controls">
    <p id="dub-instr">【練習模式】可以自由操作上面的影片來構思台詞。準備好就開始正式錄音。</p>
    <div id="dub-micwarn" class="dub-micwarn hidden">
      <p>🎙️ 無法使用麥克風。請允許瀏覽器使用麥克風（網址列旁的鎖頭／麥克風圖示），或確認網址是 https:// 或 localhost。</p>
      <button id="dub-retry-mic" class="ghost" type="button">重試取得麥克風</button>
      <button id="dub-skip-round" class="ghost" type="button">這關我不錄了（交白卷）</button>
    </div>
    <div class="dub-btns">
      <button id="dub-start" class="big primary" type="button">開始正式錄音</button>
      <button id="dub-preview" class="ghost hidden" type="button">▶️ 預覽我的配音</button>
      <button id="dub-redo" class="ghost hidden" type="button">重新錄音</button>
      <button id="dub-finish" class="big primary hidden" type="button">✅ 完成並鎖定</button>
    </div>
    <button id="dub-skipwait-rec" class="ghost host-only" type="button">⏩ 不等了，直接進入評分（房主）</button>
  </section>
  <audio id="dub-preview-audio" class="hidden"></audio>
</main>

<main id="screen-dub-vote" class="screen dub">
  <header class="dub-head">
    <h2>📺 正在展示：<span id="dub-ename" class="dub-hl">---</span> 的配音 <small id="dub-eno"></small></h2>
    <div class="dub-stats"><span id="dub-voteprog" class="dub-badge">已評分 0/0</span></div>
  </header>
  <div class="dub-videobox"><video id="dub-evideo" playsinline></video><audio id="dub-eaudio"></audio><div id="dub-eover" class="dub-countdown hidden">準備播放…</div></div>
  <section id="dub-votebox" class="card hidden">
    <h3>為這個作品評分！</h3>
    <div class="dub-vg"><label>😂 搞笑程度</label><div class="dub-stars" id="dub-s-funny">${[1, 2, 3, 4, 5].map((n) => `<button type="button" class="dub-star" data-v="${n}">${n}</button>`).join('')}</div></div>
    <div class="dub-vg"><label>🎭 配音優異度</label><div class="dub-stars" id="dub-s-acting">${[1, 2, 3, 4, 5].map((n) => `<button type="button" class="dub-star" data-v="${n}">${n}</button>`).join('')}</div></div>
    <div class="dub-btns"><button id="dub-replay" class="ghost" type="button">🔁 重播作品</button><button id="dub-submit" class="big primary" type="button" disabled>送出評分</button></div>
  </section>
  <section id="dub-votewait" class="card hidden"><h3 id="dub-votewait-t">已送出評分 ✅</h3><p>等待其他玩家完成評分…</p></section>
  <div class="dub-btns"><button id="dub-gorate" class="ghost hidden" type="button">⏭ 直接評分（不用等影片播完）</button>
  <button id="dub-skipwait-vote" class="ghost host-only" type="button">⏩ 不等了，下一個（房主）</button></div>
</main>

<main id="screen-dub-results" class="screen dub">
  <h1>🏆 頒獎典禮</h1>
  <div id="dub-processing" class="card dub-processing hidden"><h2>🎥 正在合成作品…</h2><p class="note">合成每個人的配音影片需要一點時間，請稍等。</p></div>
  <div id="dub-final" class="hidden">
    <div class="dub-fame">
      <section class="card dub-gold"><h3>🥇 全場最搞笑</h3><h2 id="dub-tf-name" class="dub-hl">---</h2><p class="note">影片：<span id="dub-tf-video"></span>　得分：<b id="dub-tf-score"></b></p><div id="dub-tf-media"></div></section>
      <section class="card dub-gold alt"><h3>🥇 配音最優秀</h3><h2 id="dub-ta-name" class="dub-hl">---</h2><p class="note">影片：<span id="dub-ta-video"></span>　得分：<b id="dub-ta-score"></b></p><div id="dub-ta-media"></div></section>
    </div>
    <section class="card"><h3>📊 玩家總排行榜</h3><div id="dub-rank"></div></section>
    <section class="card"><h3>💾 所有作品<span id="dub-mergenote" class="note"></span></h3><div id="dub-works"></div></section>
    <div class="row"><button id="dub-tolobby" class="big primary" type="button">回房間大廳</button><button id="dub-leave" class="ghost" type="button">離開房間</button></div>
    <p id="dub-wait" class="tip"></p>
  </div>
</main>

<div id="dub-modal" class="dub-modal hidden"><div class="dub-modal-box"><h3 id="dub-modal-t">預覽</h3><video id="dub-modal-v" controls playsinline></video><button id="dub-modal-x" class="ghost" type="button">關閉預覽</button></div></div>`;

function build() {
  const sec = el('section', 'card gset hidden');
  sec.id = 'set-dubbing';
  sec.innerHTML = SETTINGS_HTML;
  $('l-settings').append(sec);
  document.body.insertAdjacentHTML('beforeend', SCREENS_HTML);
}

// ===================== 設定面板（大廳） =====================
function readSettings() {
  return { videos: explorer.getSelected(), timeLimit: Number($('dub-time').value) || 5 };
}
function fillSettings(s, ctx) {
  $('dub-time').value = String(s.timeLimit);
  $('dub-time').disabled = !ctx.host;
  explorer.sync(s.videos, ctx.host);
  explorer.load();
  $('dub-secure').classList.toggle('hidden', window.isSecureContext);
}

// ===================== 進入／離開 =====================
function enter() {
  resetAll();
}
function resetAll() {
  clearInterval(D.timer); clearTimeout(D.exTimer); clearTimeout(D.showVoteTimer);
  Object.assign(D, { round: null, idx: 0, ui: 'practice', locked: false, busy: false, exhibit: null, voted: false, funny: 0, acting: 0, results: null });
}
function exit() {
  resetAll();
  stopMedia();
  mic.releaseMic();
  $('dub-modal').classList.add('hidden');
}
function stopMedia() {
  document.querySelectorAll('#screen-dub-record video, #screen-dub-vote video, #screen-dub-vote audio, #screen-dub-results video, #dub-modal video, #dub-preview-audio').forEach((m) => { try { m.pause(); } catch { /* ignore */ } });
}

// ===================== 訊息 =====================
function message(m) {
  switch (m.t) {
    case 'round': return onRound(m);
    case 'progress': return onProgress(m);
    case 'you': return onYou(m);
    case 'exhibit': return onExhibit(m);
    case 'votes': $('dub-voteprog').textContent = `已評分 ${m.voted}/${m.total}`; return;
    case 'processing': return onProcessing();
    case 'results': return onResults(m);
    default: return;
  }
}

function onHub() {
  if (D.results) applyResultsButtons();
}

// ===================== 錄音階段 =====================
const videoEl = () => $('dub-video');
const fmt = (sec) => `${Math.floor(sec / 60)}:${String(sec % 60).padStart(2, '0')}`;

async function onRound(m) {
  if (D.round && D.round.idx === m.idx && D.round.endsAt === m.endsAt) return; // 重連補送的同一關
  stopMedia();
  D.round = m; D.idx = m.idx; D.locked = false; D.busy = false;
  A.show('dub-record');
  $('dub-vname').textContent = shortName(m.video);
  $('dub-vno').textContent = `第 ${m.idx + 1} / ${m.total} 關`;
  $('dub-progress').textContent = '完成 0/0';
  setUi('practice');
  const v = videoEl();
  v.src = videoUrl(m.video); v.muted = true; v.load(); v.setAttribute('controls', 'controls');
  mic.bind($('dub-canvas'), $('dub-preview-audio'));
  mic.clearBlob();
  requestAnimationFrame(mic.resizeCanvas);
  startTimer();
  const ok = await mic.initMic();
  if (D.round !== m) return;
  D.hasMic = ok;
  $('dub-micwarn').classList.toggle('hidden', ok);
  $('dub-start').disabled = !ok;
  mic.resizeCanvas();
}

function startTimer() {
  clearInterval(D.timer);
  D.deadline = A.toLocal(D.round.endsAt) - UPLOAD_GRACE_MS; // 到這個時間點強制交卷
  const tickFn = () => {
    const left = Math.round((D.deadline - Date.now()) / 1000);
    const t = $('dub-timer');
    if (left <= 0) {
      t.textContent = '⏳ 時間到！'; t.classList.add('over');
      clearInterval(D.timer);
      if (!D.locked) forceSubmit();
    } else { t.textContent = `⏳ 剩餘 ${fmt(left)}`; t.classList.toggle('over', left <= 30); }
  };
  tickFn();
  if (!D.locked || Date.now() < D.deadline) D.timer = setInterval(tickFn, 1000);
}

function onProgress(m) {
  $('dub-progress').textContent = `完成 ${m.finished}/${m.total}`;
  $('dub-progress').classList.toggle('done', m.total > 0 && m.finished === m.total);
}

/** 重連：伺服器告訴我這關是不是已經交卷 */
function onYou(m) {
  if (m.voted !== undefined) { // 評分階段：我是不是已經評過這個作品
    if (m.voted && D.exhibit) { D.voted = true; $('dub-votebox').classList.add('hidden'); $('dub-votewait').classList.remove('hidden'); $('dub-votewait-t').textContent = '已送出評分 ✅'; }
    return;
  }
  if (m.idx !== D.idx || !D.round) return;
  if (m.finished) { D.locked = true; setUi('locked'); return; }
  if (m.uploaded && !D.locked) { // 錄音已經傳到伺服器，只是「交卷」訊息沒送到
    D.locked = true; setUi('locked'); A.send({ t: 'finished', idx: D.idx, hasRecord: true });
  }
}

function setUi(state) {
  D.ui = state;
  const id = (x) => $(x);
  ['dub-start', 'dub-preview', 'dub-redo', 'dub-finish', 'dub-rec'].forEach((x) => id(x).classList.add('hidden'));
  const finish = id('dub-finish'); finish.disabled = false; finish.textContent = '✅ 完成並鎖定';
  const ins = id('dub-instr');
  if (state === 'practice') { id('dub-start').classList.remove('hidden'); id('dub-start').disabled = !D.hasMic; ins.textContent = '【練習模式】可以自由操作上面的影片來構思台詞。準備好就開始正式錄音。'; }
  else if (state === 'recording') { id('dub-rec').classList.remove('hidden'); ins.textContent = '🔴 錄音進行中，請對著影片配音！（影片播完會自動結束錄音）'; }
  else if (state === 'preview') { ['dub-preview', 'dub-redo', 'dub-finish'].forEach((x) => id(x).classList.remove('hidden')); ins.textContent = '【錄音完成】可以預覽成品；滿意就按「完成並鎖定」。'; }
  else if (state === 'locked') { id('dub-preview').classList.remove('hidden'); ins.textContent = '🔒 你的配音已鎖定並上傳，等待其他玩家完成…'; }
}

function countdown(sec, done) {
  const o = $('dub-countdown');
  o.classList.remove('hidden'); o.textContent = String(sec);
  let n = sec;
  const t = setInterval(() => {
    n--;
    if (n > 0) o.textContent = String(n); else { clearInterval(t); o.classList.add('hidden'); done(); }
  }, 1000);
}

function startRecordFlow() {
  if (D.locked || D.ui !== 'practice') return;
  const v = videoEl();
  v.removeAttribute('controls'); v.pause(); v.currentTime = 0;
  $('dub-start').disabled = true;
  countdown(3, () => {
    if (D.locked) return;
    setUi('recording');
    mic.startRecording();
    v.currentTime = 0; v.play().catch(() => {});
    v.onended = async () => { await mic.stopRecording(); if (!D.locked) { setUi('preview'); v.setAttribute('controls', 'controls'); } };
  });
}

async function upload(blob) {
  const h = A.hub();
  const url = `/api/dubbing/upload?room=${encodeURIComponent(h.code)}&pid=${encodeURIComponent(A.me().id)}&idx=${D.idx}`;
  const res = await fetch(url, { method: 'POST', headers: { 'Content-Type': blob.type || 'audio/webm' }, body: blob });
  let j = {};
  try { j = await res.json(); } catch { /* ignore */ }
  return { ok: res.ok && j.success, msg: j.message };
}

async function submit(auto) {
  if (D.locked || D.busy) return;
  D.busy = true;
  const v = videoEl(); v.pause(); mic.stopPreview();
  const btn = $('dub-finish'); btn.disabled = true; btn.textContent = '上傳中…';
  let blob = mic.isRecording() ? await mic.stopRecording() : mic.getBlob();
  if (!blob || blob.size === 0) {
    if (!auto) { A.toast('尚未錄製任何音訊！', true); btn.disabled = false; btn.textContent = '✅ 完成並鎖定'; D.busy = false; return; }
    D.locked = true; D.busy = false; setUi('locked');
    A.send({ t: 'finished', idx: D.idx, hasRecord: false });
    return;
  }
  let r = { ok: false, msg: '上傳發生錯誤' };
  try { r = await upload(blob); } catch { /* 網路錯誤 */ }
  D.busy = false;
  if (r.ok) {
    D.locked = true; setUi('locked');
    A.send({ t: 'finished', idx: D.idx, hasRecord: true });
  } else if (auto) {
    D.locked = true; setUi('locked');
    A.send({ t: 'finished', idx: D.idx, hasRecord: false });
    A.toast(`上傳失敗：${r.msg || ''}，這關沒有你的作品`, true);
  } else {
    A.toast(`上傳失敗：${r.msg || '請再試一次'}`, true);
    btn.disabled = false; btn.textContent = '✅ 完成並鎖定';
  }
}

function forceSubmit() {
  A.toast('⏳ 時間到！系統已鎖定並提交你的作品…', true);
  submit(true);
}

// ===================== 播放與評分階段 =====================
function onExhibit(m) {
  const e = D.exhibit;
  if (e && e.idx === m.idx && e.k === m.k && e.target.id === m.target.id) { D.exhibit = m; return; } // 重連補送的同一個作品
  clearInterval(D.timer); clearTimeout(D.exTimer); clearTimeout(D.showVoteTimer);
  stopMedia();
  D.exhibit = m; D.voted = false; D.funny = 0; D.acting = 0; D.idx = m.idx;
  A.show('dub-vote');
  $('dub-ename').textContent = m.target.nick;
  $('dub-eno').textContent = `（第 ${m.idx + 1} 關・作品 ${m.k}/${m.n}）`;
  $('dub-votebox').classList.add('hidden'); $('dub-votewait').classList.add('hidden');
  $('dub-submit').disabled = true;
  document.querySelectorAll('#screen-dub-vote .dub-star').forEach((b) => b.classList.remove('sel'));
  const v = $('dub-evideo'); const a = $('dub-eaudio');
  v.src = videoUrl(m.video); v.muted = true; v.onended = () => showVote();
  v.onerror = () => showVote();
  a.src = audioUrl(m.audio);
  const o = $('dub-eover'); o.textContent = '準備播放…'; o.classList.remove('hidden');
  const isVoter = m.voters.includes(A.me().id);
  $('dub-gorate').classList.add('hidden');
  D.exTimer = setTimeout(() => {
    o.classList.add('hidden');
    v.currentTime = 0; a.currentTime = 0;
    v.play().catch(() => showVote());
    a.play().catch(() => { /* 自動播放被擋：使用者點「重播」就會有聲音 */ });
    if (isVoter) D.showVoteTimer = setTimeout(() => $('dub-gorate').classList.remove('hidden'), 4000);
  }, 1500);
}

function showVote() {
  const m = D.exhibit;
  if (!m) return;
  if (m.voters.includes(A.me().id)) {
    if (!D.voted) $('dub-votebox').classList.remove('hidden');
    $('dub-gorate').classList.add('hidden');
  } else {
    $('dub-votewait').classList.remove('hidden');
    $('dub-votewait-t').textContent = '這是你的作品 🎬';
  }
}

function pickStar(e) {
  const b = e.target.closest('.dub-star');
  if (!b) return;
  const box = b.parentElement;
  box.querySelectorAll('.dub-star').forEach((x) => x.classList.remove('sel'));
  b.classList.add('sel');
  if (box.id === 'dub-s-funny') D.funny = Number(b.dataset.v); else D.acting = Number(b.dataset.v);
  $('dub-submit').disabled = !(D.funny && D.acting);
}

function submitVote() {
  const m = D.exhibit;
  if (!m || !D.funny || !D.acting) return;
  A.send({ t: 'vote', idx: m.idx, target: m.target.id, funny: D.funny, acting: D.acting });
  D.voted = true;
  $('dub-votebox').classList.add('hidden');
  $('dub-votewait').classList.remove('hidden');
  $('dub-votewait-t').textContent = '已送出評分 ✅';
  $('dub-gorate').classList.add('hidden');
}

// ===================== 結算 =====================
function onProcessing() {
  clearInterval(D.timer); stopMedia();
  A.show('dub-results');
  $('dub-processing').classList.remove('hidden'); $('dub-final').classList.add('hidden');
}

const score3 = (n) => Number(n).toFixed(3);

/** 一個作品的播放器：合成成功用成品 mp4；否則退回「原影片（靜音）＋錄音」同步播放 */
function mediaNode(r) {
  const box = el('div', 'dub-media');
  if (r.merged) {
    const v = el('video'); v.controls = true; v.playsInline = true; v.preload = 'metadata'; v.src = outUrl(r.outFile);
    box.append(v);
  } else {
    const v = el('video'); v.controls = true; v.playsInline = true; v.muted = true; v.preload = 'metadata'; v.src = videoUrl(r.videoName);
    const a = el('audio'); a.src = audioUrl(r.audio); a.preload = 'metadata';
    v.addEventListener('play', () => { a.currentTime = v.currentTime; a.play().catch(() => {}); });
    v.addEventListener('pause', () => a.pause());
    v.addEventListener('seeked', () => { a.currentTime = v.currentTime; });
    box.append(v, a);
    box.append(el('p', 'note', '（沒有合成影片，這裡是原影片＋錄音同步播放）'));
  }
  return box;
}

function onResults(m) {
  D.results = m;
  clearInterval(D.timer); stopMedia();
  A.show('dub-results');
  $('dub-processing').classList.add('hidden'); $('dub-final').classList.remove('hidden');
  const best = (prefix, r, key) => {
    $(`dub-${prefix}-name`).textContent = r ? r.playerName : '（沒有作品）';
    $(`dub-${prefix}-video`).textContent = r ? shortName(r.videoName) : '—';
    $(`dub-${prefix}-score`).textContent = r ? `${score3(r[key])} 分` : '—';
    $(`dub-${prefix}-media`).replaceChildren(...(r ? [mediaNode(r)] : []));
  };
  best('tf', m.topFunny, 'funnyAvg'); best('ta', m.topActing, 'actingAvg');

  const rank = $('dub-rank'); rank.replaceChildren();
  m.playerRanking.forEach((p, i) => {
    const row = el('div', 'dub-rankrow');
    row.append(el('b', null, `第 ${i + 1} 名：${p.name}`), el('span', null, `總分 ${score3(p.totalScore)}　（搞笑 ${score3(p.avgFunny)}｜優異 ${score3(p.avgActing)}）`));
    rank.append(row);
  });

  const works = $('dub-works'); works.replaceChildren();
  const rows = m.rows.filter((r) => r.hasRecord).sort((a, b) => b.totalScore - a.totalScore);
  if (!rows.length) works.append(el('p', 'note', '這場沒有人交出作品。'));
  rows.forEach((r) => {
    const item = el('div', 'dub-work');
    const head = el('div', 'dub-work-head');
    const info = el('div');
    info.append(el('b', 'dub-hl', r.playerName), ` － ${shortName(r.videoName)}`, el('div', 'note', `😂 搞笑 ${score3(r.funnyAvg)}　🎭 優異 ${score3(r.actingAvg)}`));
    const btns = el('div', 'dub-work-btns');
    const toggle = el('button', 'ghost', '▶️ 預覽'); toggle.type = 'button';
    const holder = el('div', 'dub-work-media hidden');
    toggle.addEventListener('click', () => {
      const open = holder.classList.contains('hidden');
      if (open) { if (!holder.firstChild) holder.append(mediaNode(r)); holder.classList.remove('hidden'); toggle.textContent = '🔽 收起'; }
      else { holder.classList.add('hidden'); holder.querySelectorAll('video, audio').forEach((x) => x.pause()); toggle.textContent = '▶️ 預覽'; }
    });
    btns.append(toggle);
    if (r.merged) { const dl = el('a', 'ghost dub-dl', '⬇️ 下載'); dl.href = outUrl(r.outFile); dl.download = r.outFile; btns.append(dl); }
    head.append(info, btns);
    item.append(head, holder);
    works.append(item);
  });
  $('dub-mergenote').textContent = m.mergeOk ? '' : '（伺服器無法合成影片，只能線上預覽；要下載合成檔需要在伺服器安裝 ffmpeg）';
  applyResultsButtons();
}

function applyResultsButtons() {
  const host = A.isHost();
  $('dub-tolobby').classList.toggle('hidden', !host);
  $('dub-wait').textContent = host ? '' : '等待房主回到大廳…';
}

// ===================== 綁定一次性事件 =====================
function init(api) {
  A = api;
  build();
  explorer = createExplorer({
    root: $('dub-explorer'), countEl: $('dub-count'),
    onChange: () => $('l-settings').dispatchEvent(new Event('change', { bubbles: true })),
    onPreview: (n) => { $('dub-modal-t').textContent = `預覽：${n.name}`; const v = $('dub-modal-v'); v.src = videoUrl(n.path); $('dub-modal').classList.remove('hidden'); v.play().catch(() => {}); },
  });
  $('dub-modal-x').addEventListener('click', () => { const v = $('dub-modal-v'); v.pause(); v.removeAttribute('src'); $('dub-modal').classList.add('hidden'); });

  $('dub-start').addEventListener('click', startRecordFlow);
  $('dub-preview').addEventListener('click', () => { const v = videoEl(); v.muted = true; v.currentTime = 0; v.play().catch(() => {}); mic.playPreview(); v.onended = () => mic.stopPreview(); });
  $('dub-redo').addEventListener('click', () => { const v = videoEl(); v.pause(); v.currentTime = 0; mic.stopPreview(); mic.clearBlob(); setUi('practice'); v.setAttribute('controls', 'controls'); });
  $('dub-finish').addEventListener('click', () => submit(false));
  $('dub-retry-mic').addEventListener('click', async () => { const ok = await mic.initMic(); D.hasMic = ok; $('dub-micwarn').classList.toggle('hidden', ok); $('dub-start').disabled = !ok; });
  $('dub-skip-round').addEventListener('click', () => { if (confirm('這一關不錄音（交白卷），確定嗎？')) { D.locked = true; setUi('locked'); A.send({ t: 'finished', idx: D.idx, hasRecord: false }); } });
  $('dub-skipwait-rec').addEventListener('click', () => { if (confirm('不再等還沒完成的人，直接進入評分？')) A.send({ t: 'skipWait' }); });
  $('dub-skipwait-vote').addEventListener('click', () => { if (confirm('不再等還沒評分的人，直接看下一個？')) A.send({ t: 'skipWait' }); });

  $('dub-s-funny').addEventListener('click', pickStar);
  $('dub-s-acting').addEventListener('click', pickStar);
  $('dub-submit').addEventListener('click', submitVote);
  $('dub-gorate').addEventListener('click', () => { $('dub-evideo').pause(); $('dub-eaudio').pause(); showVote(); });
  $('dub-replay').addEventListener('click', () => { const v = $('dub-evideo'); const a = $('dub-eaudio'); v.currentTime = 0; a.currentTime = 0; v.play().catch(() => {}); a.play().catch(() => {}); });
  $('dub-tolobby').addEventListener('click', () => A.toLobby());
  $('dub-leave').addEventListener('click', () => A.leave());
}

export default {
  meta: { id: 'dubbing', name: '配音大師', icon: '🎙️', desc: '每人對著同一段影片用麥克風配音，再輪流播放、互相評分「搞笑」與「配音優異」，最後合成成品可下載！（需要麥克風）' },
  init,
  settings: {
    get el() { return $('set-dubbing'); },
    fill: fillSettings,
    read: readSettings,
    startHint: (ctx) => (ctx.hub.settings.videos.length ? null : '請先勾選至少一部影片'),
  },
  enter, exit, message, onHub,
};
