// 派對房間：玩家與連線、房主、斷線重連、踢人、選擇要玩的遊戲、房間存檔。
// 一個房間可以連續玩不同的遊戲：大廳（lobby）→ 房主選遊戲、調設定、開始 → 遊戲進行中（game）→ 房主按「回大廳」→ 換下一個遊戲。
// 遊戲本身的規則在 server/games/*.mjs（介面見 games/base.mjs），這裡完全不知道各遊戲的細節。
//
// 傳輸協定（JSON）：
//   用戶端 → 伺服器  create / join / leave / kick{id} / host{id}（轉移房主）/ pick{game} / role{role} / settings{settings} / start / lobby / g{m:遊戲訊息}
//   伺服器 → 用戶端  joined / hub（房間狀態）/ g{g:遊戲代號, m:遊戲訊息} / error / kicked
import { randomBytes } from 'node:crypto';
import { GAMES, DEFAULT_GAME, gameList, gameInfo } from './games/index.mjs';
import { MAX_PLAYERS, cleanNick, cleanId } from './protocol.mjs';

export const TIMING = {
  // 房間
  staleMs: 10000, // 斷線超過這麼久就不算進「大家都完成了嗎」的分母（不會卡住別人）
  lobbyDropMs: 10 * 60 * 1000, // 大廳中斷線超過這麼久才移出（手機鎖螢幕、切 App 都不該被踢）
  dropMs: 60 * 60 * 1000, // 遊戲中斷線的玩家保留這麼久（分數都保留）
  hostReturnMs: 60000, // 房主斷線後這段時間內回來，可以拿回房主
  restoreGraceMs: 12000, // 伺服器重啟還原後，給大家重連的緩衝（倒數／截止至少再等這麼久）
  // 猜歌大賽
  preloadMs: 8000, // 等所有人預載的上限
  goDelayMs: 1500, // 發出「開播」到真正開播的間隔
  lagMs: 4000, // 硬性截止：作答窗口結束後再多等的延遲容忍
  // 你說我猜
  introMs: 5000, // 每輪開始前的準備時間
  turnEndMs: 12000, // 本輪結果停留多久後自動換下一輪
};

const newId = () => randomBytes(12).toString('base64url');

export class Room {
  constructor(code, timing = {}) {
    this.code = code;
    this.T = { ...TIMING, ...timing };
    this.hostId = null;
    // id → Member {id, nick, role, conn, connected, lastSeen, joinedAt}
    // role：player 參賽者｜screen 主畫面（只負責播放，不參賽）｜spectator 旁觀者（不參賽，看得到即時作答）。在大廳由本人選，可選的身分由遊戲的 meta.roles 決定
    this.players = new Map();
    this.banned = new Set();
    this.gameId = DEFAULT_GAME; // 房主目前選的遊戲
    this.settings = {}; // gameId → 設定（沒設過的用該遊戲的預設值）
    this.game = null; // 進行中的遊戲物件
    this.activeId = null;
    this.lastActive = Date.now();
    this.prevHost = null;
  }

  get phase() { return this.game ? 'game' : 'lobby'; }

  getSettings(id = this.gameId) {
    return this.settings[id] || { ...GAMES[id].defaults };
  }

  // ===== 連線 =====
  /** 加入或重連。回傳 {player} 或 {error:{code,msg}} */
  join(conn, { playerId, nick }) {
    const id = cleanId(playerId);
    let p = id ? this.players.get(id) : null;
    if (!p) {
      // 沒有（或找不到）playerId，但有「同暱稱而且目前離線」的座位 → 視為同一個人回來
      // （分頁被關掉、手機把網頁殺掉後重新開連結，就能接回原本的分數）
      const name = cleanNick(nick);
      if (name) p = [...this.players.values()].find((x) => !x.connected && x.nick.toLowerCase() === name.toLowerCase()) || null;
    }
    const isNew = !p;
    if (p) { // 重連
      if (p.conn && p.conn !== conn) { try { p.conn.kicked = true; p.conn.close(); } catch { /* ignore */ } }
      p.conn = conn; p.connected = true; p.lastSeen = Date.now();
      if (this.prevHost && this.prevHost.id === p.id) { // 原房主回來：時限內還給他
        if (Date.now() - this.prevHost.at < this.T.hostReturnMs) this.hostId = p.id;
        this.prevHost = null;
      } else if (this.prevHost && Date.now() - this.prevHost.at >= this.T.hostReturnMs) this.prevHost = null; // 別人重連不會清掉原房主的回座資格，只有過期才清
    } else {
      if (id && this.banned.has(id)) return { error: { code: 'BANNED', msg: '你已被房主移出這個房間' } };
      const name = cleanNick(nick);
      if (!name) return { error: { code: 'NICK', msg: '請輸入暱稱' } };
      if (this.players.size >= MAX_PLAYERS) return { error: { code: 'FULL', msg: `房間已滿（${MAX_PLAYERS} 人）` } };
      if (this.game) {
        const ok = this.game.canJoin();
        if (ok !== true) return { error: { code: 'STARTED', msg: ok || '遊戲已開始，無法中途加入' } };
      }
      p = { id: id || newId(), nick: this._uniqueNick(name), role: 'player', conn, connected: true, lastSeen: Date.now(), joinedAt: Date.now() };
      this.players.set(p.id, p);
      if (!this.hostId) this.hostId = p.id;
    }
    conn.room = this; conn.player = p;
    this.lastActive = Date.now();
    this._ensureHost();
    this._hello(conn, p);
    if (this.game) {
      if (isNew) this.game.onJoin(p); else this.game.onReconnect(p);
      this.game.snapshot(conn, p);
    }
    this._broadcastHub();
    return { player: p };
  }

  disconnect(conn) {
    const p = conn.player;
    if (!p || p.conn !== conn) return; // 已被新連線取代
    p.connected = false; p.conn = null; p.lastSeen = Date.now();
    this._ensureHost();
    this._broadcastHub();
    if (this.game) this.game.onDisconnect(p);
  }

  _uniqueNick(base) {
    const taken = new Set([...this.players.values()].map((p) => p.nick.toLowerCase()));
    if (!taken.has(base.toLowerCase())) return base;
    for (let i = 2; i < 100; i++) {
      const n = `${[...base].slice(0, 12 - String(i).length).join('')}${i}`;
      if (!taken.has(n.toLowerCase())) return n;
    }
    return base + newId().slice(0, 2);
  }

  _ensureHost() {
    const h = this.players.get(this.hostId);
    if (h && h.connected) return;
    const next = [...this.players.values()].filter((p) => p.connected).sort((a, b) => a.joinedAt - b.joinedAt)[0];
    if (next && next.id !== this.hostId) {
      // 原房主若很快回來（重新整理、伺服器重啟），把房主還給他；已經在計時就不重算
      if (h && !(this.prevHost && this.prevHost.id === h.id)) this.prevHost = { id: h.id, at: Date.now() };
      this.hostId = next.id;
    }
  }

  // ===== 傳送 =====
  _send(conn, msg) { try { conn.send(msg); } catch { /* ignore */ } }
  _broadcast(msg) {
    for (const p of this.players.values()) if (p.conn) this._send(p.conn, msg);
  }
  /** 給遊戲用：自動包上 {t:'g', g:遊戲代號} */
  sendG(conn, m) { this._send(conn, { t: 'g', g: this.activeId, m }); }
  broadcastG(m) { this._broadcast({ t: 'g', g: this.activeId, m }); }

  _hubMsg() {
    return {
      t: 'hub', code: this.code, phase: this.phase, hostId: this.hostId, gameId: this.gameId,
      settings: this.getSettings(), screens: this.screens.length,
      players: [...this.players.values()].map((p) => ({ id: p.id, nick: p.nick, role: p.role, connected: p.connected })),
    };
  }
  _broadcastHub() { this._broadcast(this._hubMsg()); }

  /** 加入／重連時的第一批訊息 */
  _hello(conn, p) {
    this._send(conn, { t: 'joined', code: this.code, playerId: p.id, serverNow: Date.now(), games: gameList(), info: gameInfo() });
    this._send(conn, this._hubMsg());
  }

  // ===== 訊息處理 =====
  handle(conn, msg) {
    const p = conn.player;
    this.lastActive = Date.now();
    if (p) p.lastSeen = Date.now();
    if (msg.t === 'g') {
      if (this.game && p && msg.m && typeof msg.m === 'object' && typeof msg.m.t === 'string') this.game.handle(conn, msg.m);
      return;
    }
    if (!p) return;
    const isHost = p.id === this.hostId;
    switch (msg.t) {
      case 'pick':
        if (isHost && !this.game && GAMES[msg.game]) {
          this.gameId = msg.game;
          for (const m of this.players.values()) if (!this._roles().includes(m.role)) m.role = 'player'; // 新遊戲沒有這個身分
          this._broadcastHub();
        }
        break;
      case 'settings':
        if (isHost && !this.game) { this.settings[this.gameId] = GAMES[this.gameId].clean(msg.settings, this.getSettings()); this._broadcastHub(); }
        break;
      case 'role': if (!this.game) this._setRole(p, msg.role); break;
      case 'start': if (isHost && !this.game) this._start(conn); break;
      case 'lobby': if (isHost && this.game) this._toLobby(); break;
      case 'kick': if (isHost) this._kick(String(msg.id || '')); break;
      case 'host': if (isHost) this._transferHost(String(msg.id || '')); break;
      case 'leave': this._remove(p.id); break;
      default: break;
    }
  }

  // ===== 身分（參賽者／主畫面／旁觀者）=====
  _roles() { return GAMES[this.gameId].meta.roles || ['player']; }
  _setRole(p, role) {
    if (!this._roles().includes(role) || p.role === role) return;
    p.role = role;
    this._broadcastHub();
  }

  /** 目前在線上、身分是「主畫面」的連線（遊戲用它來同步載入與播放） */
  get screens() {
    return [...this.players.values()].filter((p) => p.role === 'screen' && p.connected && p.conn).map((p) => p.conn);
  }

  // ===== 遊戲開始／結束 =====
  _start(conn) {
    const G = GAMES[this.gameId];
    const online = [...this.players.values()].filter((p) => p.connected && p.role === 'player').length;
    if (online < G.meta.min) return this._send(conn, { t: 'error', code: 'MIN', msg: `「${G.meta.name}」至少需要 ${G.meta.min} 位參賽的玩家（主畫面、旁觀者不算）` });
    const g = new G(this, this.getSettings());
    const err = g.check(conn);
    if (err) return this._send(conn, { t: 'error', ...err });
    this.game = g; this.activeId = G.meta.id;
    this._broadcastHub();
    try { g.start(); } catch (e) {
      console.error(`遊戲 ${G.meta.id} 啟動失敗`, e && e.stack ? e.stack : e);
      g.destroy(); this.game = null; this.activeId = null;
      this._broadcastHub();
      this._send(conn, { t: 'error', code: 'START', msg: '遊戲啟動失敗，請查看伺服器紀錄' });
    }
  }

  _toLobby() {
    if (this.game) this.game.destroy();
    this.game = null; this.activeId = null;
    this._broadcastHub();
  }

  // ===== 房主管理 =====
  _kick(id) {
    const p = this.players.get(id);
    if (!p || p.id === this.hostId) return;
    this.banned.add(p.id);
    if (p.conn) { this._send(p.conn, { t: 'kicked' }); p.conn.kicked = true; try { p.conn.close(); } catch { /* ignore */ } }
    this._remove(p.id);
  }

  /** 房主把房主交給房裡另一位目前在線上的人（任何身分都可以；遊戲中也可以） */
  _transferHost(id) {
    const p = this.players.get(id);
    if (!p || p.id === this.hostId || !p.connected) return;
    this.hostId = p.id;
    this.prevHost = null; // 這是主動交棒，不是斷線代理，原房主不能自動拿回
    this._broadcastHub();
  }

  _remove(id) {
    const p = this.players.get(id);
    if (!p) return;
    this.players.delete(id);
    if (p.conn) { p.conn.kicked = true; p.conn.player = null; try { p.conn.close(); } catch { /* ignore */ } }
    this._ensureHost();
    this._broadcastHub();
    if (this.game) this.game.onLeave(p);
  }

  /** 每秒呼叫：清掉斷線太久的人，並讓遊戲重新檢查（因為「離線 10 秒」是隨時間變化的） */
  tick() {
    const now = Date.now();
    for (const p of [...this.players.values()]) {
      if (p.connected) continue;
      const limit = this.game ? this.T.dropMs : this.T.lobbyDropMs;
      if (now - p.lastSeen > limit) this._remove(p.id);
    }
    if (this.game) this.game.tick();
  }

  // ===== 重啟不斷線：把房間存成 JSON、重啟後還原 =====
  serialize() {
    const gd = this.game ? this.game.serialize() : null;
    return {
      code: this.code, hostId: this.hostId, gameId: this.gameId, settings: this.settings, banned: [...this.banned],
      players: [...this.players.values()].map((p) => ({ id: p.id, nick: p.nick, role: p.role, joinedAt: p.joinedAt })),
      game: gd && { id: this.activeId, data: gd },
    };
  }

  /** 由 serialize() 的資料還原房間；所有玩家先視為離線，等他們的瀏覽器自動重連後接回。env = { idMap: 題目編號 → 題目 } */
  static restore(d, env = {}, timing = {}) {
    const r = new Room(d.code, timing);
    r.hostId = d.hostId;
    r.prevHost = d.hostId ? { id: d.hostId, at: Date.now() } : null; // 重啟後誰先連上都先代理，原房主一回來（時限內）就拿回房主
    r.gameId = GAMES[d.gameId] ? d.gameId : DEFAULT_GAME;
    for (const [id, s] of Object.entries(d.settings || {})) if (GAMES[id]) r.settings[id] = GAMES[id].clean(s, GAMES[id].defaults);
    r.banned = new Set(d.banned || []);
    const now = Date.now();
    for (const p of d.players || []) r.players.set(p.id, { id: p.id, nick: p.nick, role: p.role || 'player', conn: null, connected: false, lastSeen: now, joinedAt: p.joinedAt || now });
    const gd = d.game;
    if (gd && gd.data && GAMES[gd.id]) {
      const g = GAMES[gd.id].restore(r, r.getSettings(gd.id), gd.data, env);
      if (g) { r.game = g; r.activeId = gd.id; r.gameId = gd.id; }
    }
    return r;
  }

  get connectedCount() {
    return [...this.players.values()].filter((p) => p.connected).length;
  }

  destroy() { if (this.game) this.game.destroy(); }
}
