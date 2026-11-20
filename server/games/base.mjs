// 遊戲外掛的共用基底。
//
// 房間（server/room.mjs）負責：連線、重連、暱稱、房主、踢人、選遊戲、存檔。
// 遊戲（本資料夾）負責：一局遊戲裡的所有規則與狀態。房間在「開始」時建立遊戲物件，結束時丟掉。
//
// 每個遊戲是一個 class，必須提供：
//   static meta     { id, name, icon, desc, min, max, screen }   給選單顯示（screen = 支援「主畫面」裝置）
//   static defaults 預設設定
//   static clean(input, prev)  把使用者傳來的設定夾成合法值
//   static info()   伺服器端的靜態資訊（例如題庫數量），隨 joined 訊息送給用戶端
//   static restore(hub, settings, data, env) → 遊戲物件｜null    （由 serialize() 的資料還原；null = 回大廳）
//   constructor(hub, settings)
//   check(conn) → null｜{code,msg}    開始前的檢查（回傳錯誤就不會開始）
//   start()                           正式開始（check 通過後呼叫）
//   canJoin() → true｜字串（拒絕原因）  遊戲進行中有「新的人」要加入
//   onJoin(member) / onLeave(member) / onDisconnect(member) / onReconnect(member)
//   onScreenJoin(conn) / onScreenLeave(conn)
//   snapshot(conn, member|null)       把目前狀態補給剛加入／重連的連線
//   handle(conn, msg)                 用戶端送來的遊戲訊息（msg 已拆掉外層）
//   tick()                            每秒一次
//   serialize() → 可 JSON 化的資料｜null（不支援還原）
//   destroy()                         清掉計時器等
//
// 遊戲不直接碰連線：用 this.send(conn, msg) / this.broadcast(msg) / this.sendTo(member, msg)。
export class GameBase {
  constructor(hub, settings) {
    this.hub = hub;
    this.settings = settings;
    /** 遊戲自己的「座位」：每位玩家一個物件，原型指向房間的成員，所以 nick／connected／conn／lastSeen 會即時反映，
     *  遊戲自己的欄位（分數等）寫在座位本身 */
    this.seats = new Map();
    this.timers = {};
  }

  get T() { return this.hub.T; }
  isHost(member) { return !!member && member.id === this.hub.hostId; }

  seat(member, extra = {}) {
    const s = Object.assign(Object.create(member), extra);
    this.seats.set(member.id, s);
    return s;
  }
  seatOf(conn) { return conn.player ? this.seats.get(conn.player.id) || null : null; }

  send(conn, msg) { this.hub.sendG(conn, msg); }
  sendTo(member, msg) { if (member && member.conn) this.hub.sendG(member.conn, msg); }
  broadcast(msg) { this.hub.broadcastG(msg); }

  /** 簡單的命名計時器：同名的會先被取消 */
  after(name, ms, fn) {
    clearTimeout(this.timers[name]);
    this.timers[name] = setTimeout(() => { delete this.timers[name]; try { fn(); } catch (e) { console.error('遊戲計時器錯誤', e && e.stack ? e.stack : e); } }, Math.max(0, ms));
  }
  clearTimers() { for (const k of Object.keys(this.timers)) { clearTimeout(this.timers[k]); delete this.timers[k]; } }

  // ---- 預設實作（遊戲可覆寫）----
  check() { return null; }
  canJoin() { return true; }
  onJoin() {}
  onLeave() {}
  onDisconnect() {}
  onReconnect() {}
  onScreenJoin() {}
  onScreenLeave() {}
  snapshot() {}
  handle() {}
  tick() {}
  serialize() { return null; }
  destroy() { this.clearTimers(); }
}
