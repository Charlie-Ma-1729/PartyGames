// 派對遊戲用戶端的「外殼」：首頁（暱稱／開房間／加入）、房間大廳（玩家、遊戲選單、遊戲規則）、連線與重連。
// 遊戲本身是外掛（js/games/*）：進入遊戲後，伺服器的 {t:'g', g, m} 訊息會交給對應的遊戲模組處理。
//
// 遊戲模組介面：
//   meta        { id, name, icon, desc }                          首頁的遊戲一覽用
//   init(api)   一次性初始化（綁按鈕、建立畫面）
//   settings    { el, fill(settings, ctx), read(), startHint?(ctx) }   大廳裡這個遊戲的規則面板（el 是 <section>）
//   enter(hub)  遊戲開始（或重連進入進行中的遊戲）
//   message(m)  遊戲訊息
//   onHub(hub)  房間狀態更新（玩家名單變動等）
//   exit()      遊戲結束／回大廳／離開房間：停掉媒體、計時器
import { Net } from './net.js';
import { wsUrl } from '../config.js';
import * as ui from '../ui.js';
import { GAME_MODULES } from '../games/index.js';
import { $, renderPlayers, renderGameCards, renderRoles } from './view.js';

const SS_KEY = 'partygames-session'; // sessionStorage：{code, pid, nick, role}（每個分頁各自一份，重新整理可回座）
const NICK_KEY = 'partygames-nick';

const H = {
  net: null, pid: null, code: null, nick: '', pending: null,
  games: [], info: {}, hub: null, entered: null,
};
let deps = { getVolume: () => 80, stopSingle: () => {} };

const isHost = () => !!H.pid && H.pid === (H.hub && H.hub.hostId);
/** 我目前的身分：player 參賽者｜screen 主畫面｜spectator 旁觀者 */
const myRole = () => { const me = H.hub && H.hub.players.find((p) => p.id === H.pid); return (me && me.role) || 'player'; };
const isScreen = () => myRole() === 'screen';
const isSpectator = () => myRole() === 'spectator';
const mod = (id) => GAME_MODULES[id];

// ===================== 給遊戲模組用的介面 =====================
export const api = {
  send: (m) => { if (H.net) H.net.send({ t: 'g', m }); },
  sendHub: (m) => { if (H.net) H.net.send(m); },
  me: () => ({ id: H.pid, nick: H.nick }),
  isHost,
  isScreen,
  isSpectator,
  /** 這台裝置是不是參賽者（要作答） */
  isContestant: () => myRole() === 'player',
  hub: () => H.hub,
  info: (id) => H.info[id] || {},
  /** 伺服器時間（毫秒），與伺服器對時後的結果 */
  now: () => (H.net ? H.net.now : Date.now()),
  toLocal: (serverMs) => (H.net ? H.net.toLocal(serverMs) : serverMs),
  toast,
  show: (name) => ui.showScreen(name),
  toLobby: () => api.sendHub({ t: 'lobby' }),
  leave: () => leaveRoom(),
  getVolume: () => deps.getVolume(),
};

let toastTimer = null;
function toast(msg, warn = false) {
  const t = $('gtoast');
  t.textContent = msg;
  t.classList.toggle('warn', !!warn);
  t.classList.toggle('on', !!msg);
  clearTimeout(toastTimer);
  if (msg) toastTimer = setTimeout(() => t.classList.remove('on'), 4500);
}

// ===================== 連線 =====================
const saveSession = () => { try { sessionStorage.setItem(SS_KEY, JSON.stringify({ code: H.code, pid: H.pid, nick: H.nick })); } catch { /* ignore */ } };
const loadSession = () => { try { return JSON.parse(sessionStorage.getItem(SS_KEY) || 'null'); } catch { return null; } };
const clearSession = () => { try { sessionStorage.removeItem(SS_KEY); } catch { /* ignore */ } };
const inviteLink = () => `${location.origin}${location.pathname}?room=${H.code}`;
const homeMsg = (t) => { $('h-msg').textContent = t || ''; };

function connect(pending) {
  H.pending = pending;
  if (H.net) H.net.close();
  homeMsg('連線中…');
  H.net = new Net(wsUrl(), {
    onOpen: () => {
      $('netbar').classList.add('hidden');
      homeMsg('');
      // 重連時用 session 的 playerId 回座；第一次則送 create / join
      const msg = H.code && H.pid ? { t: 'join', code: H.code, playerId: H.pid, nick: H.nick } : H.pending;
      if (msg) H.net.send(msg);
    },
    onClose: () => { if (H.code && H.net) $('netbar').classList.remove('hidden'); }, // 已在房間裡斷線：顯示「重新連線中」
    onFail: () => homeMsg('連不上伺服器。多人遊戲需要有 Node 伺服器（請見 README），或確認網址與網路。'),
    onMessage: handle,
  });
  H.net.connect();
}

function leaveRoom(silent = false) {
  if (H.net) { H.net.send({ t: 'leave' }); H.net.close(); }
  $('netbar').classList.add('hidden');
  exitGame();
  H.net = null; H.code = null; H.pid = null; H.hub = null;
  clearSession();
  document.body.classList.remove('multi', 'is-host', 'is-screen', 'is-spectator');
  history.replaceState(null, '', location.pathname);
  if (!silent) ui.showScreen('home');
}

// ===================== 訊息 =====================
function handle(m) {
  switch (m.t) {
    case 'joined': return onJoined(m);
    case 'hub': return onHub(m);
    case 'g': {
      if (H.entered !== m.g && H.hub && H.hub.phase === 'game' && H.hub.gameId === m.g) enterGame(m.g); // 保險：正常情況 hub 訊息會先到
      if (H.entered === m.g) mod(m.g).message(m.m);
      return;
    }
    case 'kicked': alert('你已被房主移出房間'); leaveRoom(); return;
    case 'error': return onError(m);
    default: return;
  }
}

function onError(m) {
  if (['NO_ROOM', 'NICK', 'FULL', 'STARTED', 'BANNED', 'BUSY', 'PASSWORD'].includes(m.code)) {
    // 加入失敗：回到首頁顯示原因
    const had = H.code;
    $('netbar').classList.add('hidden');
    if (H.net) H.net.close();
    H.net = null; H.code = null; H.pid = null; H.hub = null;
    if (had) clearSession();
    exitGame();
    document.body.classList.remove('multi', 'is-host', 'is-screen', 'is-spectator');
    ui.showScreen('home');
    homeMsg(m.msg);
    return;
  }
  if ($('screen-lobby').classList.contains('active')) $('l-msg').textContent = m.msg;
  else toast(m.msg, true);
}

function onJoined(m) {
  H.code = m.code; H.games = m.games || []; H.info = m.info || {};
  H.pid = m.playerId;
  saveSession();
  history.replaceState(null, '', `${location.pathname}?room=${H.code}`);
  document.body.classList.add('multi');
  $('l-code').textContent = H.code;
}

function onHub(m) {
  H.hub = m;
  document.body.classList.toggle('is-host', isHost());
  document.body.classList.toggle('is-screen', isScreen());
  document.body.classList.toggle('is-spectator', isSpectator());
  if (m.phase === 'lobby') {
    if (H.entered) exitGame();
    if (!$('screen-lobby').classList.contains('active')) ui.showScreen('lobby');
    renderLobby();
  } else {
    if (H.entered !== m.gameId) enterGame(m.gameId);
    const g = mod(H.entered);
    if (g && g.onHub) g.onHub(m);
  }
}

function enterGame(id) {
  if (H.entered) exitGame();
  H.entered = id;
  mod(id).enter(H.hub);
}
function exitGame() {
  if (!H.entered) return;
  const id = H.entered;
  H.entered = null;
  try { mod(id).exit(); } catch (e) { console.error(e); }
}

// ===================== 大廳 =====================
function renderLobby() {
  const m = H.hub;
  const host = isHost();
  renderPlayers(m, H.pid, host, (id, nick) => { if (confirm(`要把「${nick}」移出房間嗎？`)) api.sendHub({ t: 'kick', id }); },
  (id, nick) => { if (confirm(`要把房主交給「${nick}」嗎？交出去後你就不能操作房主功能了。`)) api.sendHub({ t: 'host', id }); });
  renderGameCards($('l-games'), H.games, m.gameId, host, (id) => api.sendHub({ t: 'pick', game: id }));
  $('l-pickhint').textContent = host ? '（點一個選擇，下面可以調整規則）' : '（由房主選擇）';

  const meta = H.games.find((g) => g.id === m.gameId) || { min: 1, name: '' };
  const g = mod(m.gameId);
  const ctx = { hub: m, info: H.info[m.gameId] || {}, host, api };
  for (const [id, x] of Object.entries(GAME_MODULES)) x.settings.el.classList.toggle('hidden', id !== m.gameId);
  g.settings.el.classList.toggle('readonly', !host);
  g.settings.fill(m.settings, ctx);
  $('l-lockhint').textContent = host ? '' : '（只有房主能修改）';

  const roles = meta.roles || ['player'];
  $('l-role').classList.toggle('hidden', roles.length < 2);
  renderRoles($('l-roles'), roles, myRole(), (r) => api.sendHub({ t: 'role', role: r }));

  const online = m.players.filter((p) => p.connected && p.role === 'player').length;
  const hint = online < meta.min ? `至少需要 ${meta.min} 位參賽的玩家（目前 ${online} 位）` : (g.settings.startHint ? g.settings.startHint(ctx) : null);
  $('l-start').classList.toggle('hidden', !host);
  $('l-start').disabled = !!hint;
  $('l-start').textContent = hint || `開始「${meta.name}」▶`;
  $('l-wait').classList.toggle('hidden', host);
  $('l-wait').textContent = isScreen() ? '你是「主畫面」：遊戲開始後會自動切換到播放畫面。' : isSpectator() ? '你是旁觀者：遊戲開始後可以即時看到大家的作答。等待房主開始…' : '等待房主開始遊戲…';
  $('l-msg').textContent = '';
}

function sendSettings() {
  if (!isHost() || !H.hub) return;
  api.sendHub({ t: 'settings', settings: mod(H.hub.gameId).settings.read() });
}

// ===================== 入口 =====================
const nickValue = () => $('h-nick').value.trim().slice(0, 12);

export function initHub(d) {
  deps = d;
  let savedNick = '';
  try { savedNick = localStorage.getItem(NICK_KEY) || ''; } catch { /* ignore */ }
  $('h-nick').value = savedNick;
  for (const x of Object.values(GAME_MODULES)) x.init(api);

  // 首頁
  const showcase = $('h-games');
  for (const x of Object.values(GAME_MODULES)) {
    const c = document.createElement('div');
    c.className = 'gcard static';
    for (const [cls, text] of [['gicon', x.meta.icon], ['gname', x.meta.name], ['gdesc', x.meta.desc]]) { const s = document.createElement('span'); s.className = cls; s.textContent = text; c.append(s); }
    showcase.append(c);
  }
  fetch('/api/config').then((r) => r.json()).then((c) => { if (c && c.needPassword) $('h-passwrap').classList.remove('hidden'); }).catch(() => { /* 沒有伺服器（例如 GitHub Pages）：只能單人 */ });
  $('btn-solo').addEventListener('click', () => { deps.startSolo(); });

  const remember = (n) => { try { localStorage.setItem(NICK_KEY, n); } catch { /* ignore */ } };
  $('h-create').addEventListener('click', () => {
    const nick = nickValue();
    if (!nick) { homeMsg('請先輸入暱稱'); $('h-nick').focus(); return; }
    remember(nick); H.nick = nick; H.code = null; H.pid = null;
    connect({ t: 'create', nick, password: $('h-pass').value });
  });
  const join = () => {
    const code = $('h-code').value.trim().toUpperCase();
    const nick = nickValue();
    if (code.length !== 4) { homeMsg('請輸入 4 碼的房間代碼'); return; }
    if (!nick) { homeMsg('請先輸入暱稱'); $('h-nick').focus(); return; }
    if (nick) remember(nick);
    H.nick = nick; H.code = null; H.pid = null;
    connect({ t: 'join', code, nick });
  };
  $('h-join').addEventListener('click', join);
  $('h-code').addEventListener('keydown', (e) => { if (e.key === 'Enter') join(); });
  $('h-code').addEventListener('input', (e) => { e.target.value = e.target.value.toUpperCase().replace(/[^A-Z0-9]/g, ''); });
  $('h-nick').addEventListener('keydown', (e) => { if (e.key === 'Enter') $('h-create').click(); });

  // 大廳
  $('l-leave').addEventListener('click', () => leaveRoom());
  $('l-copy').addEventListener('click', async () => {
    try { await navigator.clipboard.writeText(inviteLink()); toast('已複製邀請連結'); $('l-copy').textContent = '✅ 已複製'; setTimeout(() => { $('l-copy').textContent = '📋 複製邀請連結'; }, 1800); }
    catch { prompt('複製這個邀請連結：', inviteLink()); }
  });
  $('l-start').addEventListener('click', () => { sendSettings(); api.sendHub({ t: 'start' }); });
  $('l-settings').addEventListener('change', sendSettings);

  // 網址帶房間代碼：?room=ABCD（&screen=1 = 主畫面）；同分頁重新整理則自動回座
  const params = new URLSearchParams(location.search);
  const room = (params.get('room') || '').toUpperCase().replace(/[^A-Z0-9]/g, '').slice(0, 4);
  if (room) {
    const sess = loadSession();
    deps.stopSingle();
    $('h-code').value = room;
    if (sess && sess.code === room) {
      H.code = room; H.pid = sess.pid; H.nick = sess.nick;
      document.body.classList.add('multi');
      homeMsg('重新連線中…');
      connect(null);
    } else {
      $('h-nick').focus();
      homeMsg(`要加入房間 ${room}：輸入暱稱後按「加入」`);
    }
  }
}
