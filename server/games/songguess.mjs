// 猜歌大賽（伺服器權威的回合狀態機）
// 階段：preload → playing → reveal → (preload …) → final。大廳／房主／踢人／重連由房間（server/room.mjs）處理。
import { buildQueue, buildChoices, pickAsk, ASK_PROMPT, SONG_CATS, CATEGORIES } from '../../js/questions.js';
import { scoreAnswer, rankPlayers, SCORE_MODES } from '../../js/scoring.js';
import { bank, works, keyOf } from '../bank.mjs';
import { MAX_PLAYERS, num, oneOf, subset } from '../protocol.mjs';
import { GameBase } from './base.mjs';

export const KINDS = ['OP', 'ED', 'INSERT', 'OST', 'SONG'];

export const DEFAULT_SETTINGS = {
  categories: ['anime'],
  kinds: ['OP', 'ED', 'INSERT', 'OST'],
  count: 10,
  duration: 15,
  difficulty: 2,
  perWork: 99,
  fromMiddle: false,
  jpopAsk: 'mixed', // 日本流行歌：title 猜歌名 | artist 猜歌手 | mixed 每題隨機（一曲兩用）
  answerMode: 'choice', // choice 8 選 1 | typing 打字搜尋
  playMode: 'own', // own 各自播放 | screen 主畫面播放
  quorumMode: 'half', // off | half 過半 | all 全員 | n 指定人數
  quorumN: 2,
  quorumSecs: 10,
  graceSecs: 5, // 音樂播完後的作答寬限
  scoreMode: 'speed',
  penalty: false,
  autoNext: 0, // 揭曉後幾秒自動下一題，0 = 房主手動
  allowLateJoin: true,
};

/** 把使用者傳來的設定夾成合法值（缺的欄位沿用 prev） */
export function cleanSettings(input, prev = DEFAULT_SETTINGS) {
  const s = input && typeof input === 'object' ? input : {};
  const p = prev;
  return {
    categories: subset(s.categories ?? p.categories, CATEGORIES.map((c) => c.id), p.categories),
    kinds: subset(s.kinds ?? p.kinds, KINDS, p.kinds),
    count: num(s.count ?? p.count, 3, 100, p.count),
    duration: num(s.duration ?? p.duration, 5, 60, p.duration),
    difficulty: num(s.difficulty ?? p.difficulty, 1, 3, p.difficulty),
    perWork: num(s.perWork ?? p.perWork, 1, 99, p.perWork),
    fromMiddle: s.fromMiddle === undefined ? p.fromMiddle : !!s.fromMiddle,
    jpopAsk: oneOf(s.jpopAsk ?? p.jpopAsk, ['mixed', 'title', 'artist'], p.jpopAsk),
    answerMode: oneOf(s.answerMode ?? p.answerMode, ['choice', 'typing'], p.answerMode),
    playMode: oneOf(s.playMode ?? p.playMode, ['own', 'screen'], p.playMode),
    quorumMode: oneOf(s.quorumMode ?? p.quorumMode, ['off', 'half', 'all', 'n'], p.quorumMode),
    quorumN: num(s.quorumN ?? p.quorumN, 1, MAX_PLAYERS, p.quorumN),
    quorumSecs: num(s.quorumSecs ?? p.quorumSecs, 3, 60, p.quorumSecs),
    graceSecs: num(s.graceSecs ?? p.graceSecs, 0, 30, p.graceSecs),
    scoreMode: oneOf(s.scoreMode ?? p.scoreMode, SCORE_MODES, p.scoreMode),
    penalty: s.penalty === undefined ? p.penalty : !!s.penalty,
    autoNext: s.autoNext === undefined ? p.autoNext : (num(s.autoNext, 0, 60, 0) === 0 ? 0 : num(s.autoNext, 3, 60, 10)),
    allowLateJoin: s.allowLateJoin === undefined ? p.allowLateJoin : !!s.allowLateJoin,
  };
}

/** 打字搜尋用的候選清單 { work:[], title:[], artist:[] }（所選題庫的所有作品／歌名／歌手，不含本題答案資訊） */
function buildWorks(s) {
  const out = {};
  const seen = {};
  for (const c of s.categories) {
    for (const [ask, list] of Object.entries(works[c] || {})) {
      if (SONG_CATS.includes(c) && s.jpopAsk !== 'mixed' && ask !== s.jpopAsk) continue;
      const o = out[ask] || (out[ask] = []);
      const sn = seen[ask] || (seen[ask] = new Set());
      for (const w of list) if (!sn.has(w.k)) { sn.add(w.k); o.push(w); }
    }
  }
  return out;
}

const SEAT_KEYS = ['score', 'correct', 'answered', 'totalMs', 'streak', 'eligible', 'spectator', 'ready', 'failed', 'selection', 'lock'];
const freshSeat = (extra = {}) => ({
  score: 0, correct: 0, answered: 0, totalMs: 0, streak: 0,
  eligible: false, spectator: false, ready: false, failed: false, selection: null, lock: null, ...extra,
});

export class SongGame extends GameBase {
  static meta = {
    id: 'songguess', name: '猜歌大賽', icon: '🎵', min: 1, max: MAX_PLAYERS, screen: true,
    desc: '聽一小段動漫、流行歌或 OST，搶先猜出它是什麼！可各自播放，也可以由一個大螢幕播給大家聽。',
  };
  static defaults = DEFAULT_SETTINGS;
  static clean(input, prev) { return cleanSettings(input, prev); }
  static info() { return { counts: Object.fromEntries(Object.entries(bank).map(([k, v]) => [k, v.length])) }; }

  constructor(hub, settings) {
    super(hub, settings);
    this.phase = 'preload';
    this.g = null;
    this.lastReveal = null;
    this.lastFinal = null;
    this._pre = null;
  }

  // ===== 開始 =====
  check() {
    const s = this.settings;
    if (s.playMode === 'screen' && this.hub.screens.size === 0) return { code: 'NO_SCREEN', msg: '「主畫面播放」需要先開啟主畫面（用另一個分頁／裝置加入並選「作為主畫面」）' };
    const catOf = new Map();
    const pool = [];
    for (const c of s.categories) for (const q of bank[c] || []) { catOf.set(q.id, c); pool.push(q); }
    const queue = buildQueue(pool, { kinds: s.kinds, maxDifficulty: s.difficulty, maxPerWork: s.perWork, count: s.count });
    if (queue.length === 0) return { code: 'EMPTY', msg: '符合條件的題目是 0 首，請放寬設定' };
    this._pre = { queue, catOf };
    return null;
  }

  start() {
    const s = this.settings;
    const { queue, catOf } = this._pre;
    this._pre = null;
    const wl = s.answerMode === 'typing' ? buildWorks(s) : {};
    for (const m of this.hub.players.values()) this.seat(m, freshSeat());
    this.g = { queue, catOf, idx: 0, total: Math.min(s.count, queue.length), works: wl, q: null };
    for (const [ask, list] of Object.entries(wl)) this.broadcast({ t: 'works', ask, list });
    this._nextQuestion();
  }

  canJoin() { return this.settings.allowLateJoin ? true : '遊戲已開始，房主不允許中途加入'; }

  // ===== 成員變動 =====
  onJoin(member) { this.seat(member, freshSeat({ spectator: true })); this._broadcastState(); }
  onReconnect() { this._broadcastState(); this._checkBarrier(); }
  onDisconnect() { this._broadcastState(); this._checkBarrier(); this._checkProgress(); }
  onLeave(member) { this.seats.delete(member.id); this._broadcastState(); this._checkBarrier(); this._checkProgress(); }
  onScreenJoin(conn) { conn.ready = false; this._broadcastState(); }
  onScreenLeave() { this._broadcastState(); this._checkBarrier(); }

  isActive(p) {
    return p.eligible && !p.failed && (p.connected || Date.now() - p.lastSeen <= this.T.staleMs);
  }

  _stateMsg() {
    const act = this.phase === 'playing' ? [...this.seats.values()].filter((p) => this.isActive(p)) : [];
    const g = this.g;
    return {
      t: 'state', phase: this.phase, idx: g ? g.idx : 0, total: g ? g.total : 0, screens: this.hub.screens.size,
      locked: act.filter((p) => p.lock).length, active: act.length,
      players: [...this.seats.values()].map((p) => ({
        id: p.id, nick: p.nick, connected: p.connected, score: p.score,
        locked: !!p.lock, ready: p.ready, spectator: p.spectator, failed: p.failed,
      })),
    };
  }
  _broadcastState() { this.broadcast(this._stateMsg()); }

  /** 加入／重連時，把目前題目的狀態補給該連線（state 由 onJoin／onReconnect 廣播） */
  snapshot(conn, member) {
    const p = member ? this.seats.get(member.id) : null;
    const g = this.g;
    if (!g) return;
    if (this.settings.answerMode === 'typing') for (const [ask, list] of Object.entries(g.works || {})) this.send(conn, { t: 'works', ask, list });
    if (this.phase === 'preload' || this.phase === 'playing' || this.phase === 'reveal') {
      this.send(conn, g.qMsg);
      if (g.goMsg) this.send(conn, g.goMsg);
      if (g.t0 != null) this.send(conn, { t: 't0', idx: g.idx, t0: g.t0 });
      if (g.quorumEndsAt) this.send(conn, { t: 'quorum', idx: g.idx, endsAt: g.quorumEndsAt });
      if (p) this.send(conn, { t: 'you', idx: g.idx, selection: p.selection, locked: !!p.lock, failed: p.failed });
    }
    if (this.phase === 'reveal' && this.lastReveal) this.send(conn, this.lastReveal);
    if (this.phase === 'final' && this.lastFinal) this.send(conn, this.lastFinal);
  }

  // ===== 訊息處理 =====
  handle(conn, msg) {
    if (conn.screen) return this._handleScreen(conn, msg);
    const p = this.seatOf(conn);
    if (!p) return;
    const host = this.isHost(p);
    switch (msg.t) {
      case 'ready': if (this._cur(msg) && this.phase === 'preload') { p.ready = true; this._checkBarrier(); this._broadcastState(); } break;
      case 'select': if (this._cur(msg)) this._select(p, msg); break;
      case 'lock': if (this._cur(msg)) this._lock(p, msg); break;
      case 'playError': if (this._cur(msg)) this._playError(p); break;
      case 'next': if (host && this.phase === 'reveal') this._nextQuestion(); break;
      case 'skip': if (host && (this.phase === 'preload' || this.phase === 'playing')) this._skipQuestion('房主跳過本題'); break;
      case 'forceReveal': if (host && this.phase === 'playing') this._reveal('host'); break;
      case 'end': if (host && this.phase !== 'final') this._final(); break;
      default: break;
    }
  }

  _handleScreen(conn, msg) {
    if (msg.t === 'ready' && this._cur(msg) && this.phase === 'preload') { conn.ready = true; this._checkBarrier(); }
    else if (msg.t === 'playing' && this._cur(msg) && this.phase === 'playing') this._screenPlaying();
    else if (msg.t === 'playError' && this._cur(msg) && (this.phase === 'preload' || this.phase === 'playing')) this._skipQuestion('主畫面無法播放這首影片');
  }

  /** 訊息帶的題號必須是目前這題（避免延遲的舊訊息） */
  _cur(msg) { return this.g && msg.idx === this.g.idx; }

  _nextQuestion({ replace = false } = {}) {
    this.clearTimers();
    const g = this.g;
    const s = this.settings;
    if (replace) g.idx--;
    let q; let choices = null; let cat; let ask = 'work';
    for (;;) {
      if (g.idx >= g.total || g.queue.length === 0) return this._final();
      q = g.queue.shift();
      cat = g.catOf.get(q.id);
      ask = pickAsk(q, s.jpopAsk); // J-POP「一曲兩用」：這題問歌名還是歌手；其他題庫 ask = 'work'
      if (s.answerMode === 'choice') {
        choices = buildChoices(q, bank[cat] || [], cat, { maxDifficulty: s.difficulty, ask });
        if (!choices) continue; // 題庫太小湊不出選項 → 換下一題
      }
      break;
    }
    g.idx++;
    g.q = q; g.choices = choices; g.cat = cat; g.ask = ask;
    g.correctIdx = choices ? choices.findIndex((c) => c.correct) : -1;
    g.correctKey = keyOf(q, cat, ask);
    g.startAt = null; g.t0 = null; g.goMsg = null; g.quorumEndsAt = null;
    g.windowMs = (s.duration + s.graceSecs) * 1000;
    for (const p of this.seats.values()) {
      p.spectator = false; p.eligible = true; p.ready = false; p.failed = false; p.selection = null; p.lock = null;
    }
    for (const sc of this.hub.screens) sc.ready = false;
    g.qMsg = {
      t: 'question', idx: g.idx, total: g.total, ytId: q.ytId,
      start: (s.fromMiddle && q.mid != null ? q.mid : q.start) || 0,
      duration: s.duration, graceSecs: s.graceSecs, kind: q.kind, ask, prompt: ask === 'work' ? q.prompt : ASK_PROMPT[ask],
      choices: choices ? choices.map(({ main, sub }) => ({ main, sub })) : null,
      answerMode: s.answerMode, playMode: s.playMode,
    };
    this.phase = 'preload';
    this.broadcast(g.qMsg);
    this._broadcastState();
    this.after('preload', this.T.preloadMs, () => this._go());
    this._checkBarrier();
  }

  /** 準備同步屏障：所有「該載入影片的人」都 ready 就開播 */
  _checkBarrier() {
    if (this.phase !== 'preload') return;
    const s = this.settings;
    let all;
    if (s.playMode === 'screen') all = this.hub.screens.size > 0 && [...this.hub.screens].every((c) => c.ready);
    else {
      const act = [...this.seats.values()].filter((p) => this.isActive(p));
      all = act.every((p) => p.ready);
    }
    if (all) this._go();
  }

  _go() {
    if (this.phase !== 'preload') return;
    clearTimeout(this.timers.preload);
    const g = this.g;
    g.startAt = Date.now() + this.T.goDelayMs;
    g.goMsg = { t: 'go', idx: g.idx, startAt: g.startAt, serverNow: Date.now() };
    this.phase = 'playing';
    this.broadcast(g.goMsg);
    this._broadcastState();
    this.after('hard', g.startAt + g.windowMs + this.T.lagMs - Date.now(), () => this._reveal('time'));
    this._checkProgress();
  }

  /** 主畫面模式：以主畫面「真正開播」的時刻為全員的 t0 */
  _screenPlaying() {
    const g = this.g;
    if (g.t0 != null) return;
    g.t0 = Date.now();
    this.broadcast({ t: 't0', idx: g.idx, t0: g.t0 });
  }

  // ===== 作答 =====
  _validAnswer(msg) {
    const g = this.g;
    if (this.settings.answerMode === 'choice') {
      const c = msg.choice;
      return Number.isInteger(c) && c >= 0 && c < g.choices.length ? { choice: c } : null;
    }
    return typeof msg.key === 'string' && msg.key.length > 0 && msg.key.length < 80 ? { key: msg.key } : null;
  }
  _isCorrect(a) {
    const g = this.g;
    return a.choice !== undefined ? a.choice === g.correctIdx : a.key === g.correctKey;
  }
  _label(a) {
    const g = this.g;
    if (a.choice !== undefined) return g.choices[a.choice].main;
    const w = ((g.works || {})[g.ask] || []).find((x) => x.k === a.key);
    return w ? w.main : '';
  }

  _select(p, msg) {
    if ((this.phase !== 'preload' && this.phase !== 'playing') || !p.eligible || p.lock || p.failed) return;
    const a = this._validAnswer(msg);
    if (a) p.selection = a;
  }

  _lock(p, msg) {
    if (this.phase !== 'playing' || !p.eligible || p.lock || p.failed) return;
    const a = this._validAnswer(msg);
    if (!a) return;
    const g = this.g;
    const now = Date.now();
    let elapsed;
    if (this.settings.playMode === 'screen') elapsed = now - (g.t0 ?? g.startAt);
    else elapsed = Math.max(0, Math.min(Number(msg.elapsedMs) || 0, now - g.startAt + 300)); // 夾上限：不能比伺服器看到的更久
    elapsed = Math.max(0, Math.min(elapsed, g.windowMs));
    p.selection = a;
    p.lock = { ...a, elapsed, correct: this._isCorrect(a) };
    this._broadcastState();
    this._checkProgress();
  }

  _playError(p) {
    if (this.phase !== 'preload' && this.phase !== 'playing') return;
    if (!p.eligible || p.failed) return;
    p.failed = true; p.ready = true;
    const el = [...this.seats.values()].filter((x) => x.eligible && (x.connected || Date.now() - x.lastSeen <= this.T.staleMs));
    const failed = el.filter((x) => x.failed).length;
    if (this.settings.playMode === 'own' && failed * 2 >= el.length) return this._skipQuestion('多數玩家無法播放這首影片');
    this._broadcastState();
    this._checkBarrier();
    this._checkProgress();
  }

  /** 每次鎖定／失敗／離線後檢查：全員鎖定 → 揭曉；達門檻 → 開始倒數 */
  _checkProgress() {
    if (this.phase !== 'playing') return;
    const g = this.g;
    const act = [...this.seats.values()].filter((p) => this.isActive(p));
    if (act.length === 0) return;
    const locked = act.filter((p) => p.lock).length;
    if (locked === act.length) return this._reveal('all');
    const s = this.settings;
    if (g.quorumEndsAt || s.quorumMode === 'off' || locked === 0) return;
    const need = s.quorumMode === 'all' ? act.length
      : s.quorumMode === 'half' ? Math.floor(act.length / 2) + 1
        : Math.min(s.quorumN, act.length);
    if (locked >= need) {
      g.quorumEndsAt = Date.now() + s.quorumSecs * 1000;
      this.after('quorum', s.quorumSecs * 1000, () => this._reveal('quorum'));
      this.broadcast({ t: 'quorum', idx: g.idx, endsAt: g.quorumEndsAt, serverNow: Date.now() });
    }
  }

  // ===== 揭曉與計分 =====
  _reveal(reason) {
    if (this.phase !== 'playing') return;
    this.clearTimers();
    const g = this.g;
    const s = this.settings;
    const rows = [];
    for (const p of this.seats.values()) {
      if (!p.eligible) continue;
      let answered = false; let correct = false; let elapsed = g.windowMs; let pick = null;
      if (p.lock) { answered = true; correct = p.lock.correct; elapsed = p.lock.elapsed; pick = p.lock; }
      else if (p.selection && !p.failed) { answered = true; correct = this._isCorrect(p.selection); pick = p.selection; } // 已選未鎖定 → 以最慢速度計入
      let points = 0;
      if (!p.failed) {
        const r = scoreAnswer({ correct, answered, elapsedMs: elapsed, windowMs: g.windowMs, mode: s.scoreMode, streak: p.streak, penalty: s.penalty });
        points = r.points; p.streak = r.streak;
        p.score += points;
        if (answered) p.answered++;
        if (correct) { p.correct++; p.totalMs += elapsed; }
      }
      rows.push({ id: p.id, nick: p.nick, answered, correct, failed: p.failed, points, total: p.score, streak: p.streak, pick: pick ? this._label(pick) : null, ms: answered ? Math.round(elapsed) : null });
    }
    const ranking = this._ranking();
    this.phase = 'reveal';
    this.lastReveal = {
      t: 'reveal', idx: g.idx, total: g.total, reason, last: g.idx >= g.total,
      answer: g.q.answer, kind: g.q.kind, revealStart: g.q.revealStart ?? null, ytId: g.q.ytId,
      correct: g.correctIdx >= 0 ? { index: g.correctIdx } : { key: g.correctKey },
      rows, ranking, nextAt: s.autoNext > 0 ? Date.now() + s.autoNext * 1000 : null, serverNow: Date.now(),
    };
    this.broadcast(this.lastReveal);
    this._broadcastState();
    if (s.autoNext > 0) this.after('next', s.autoNext * 1000, () => this._nextQuestion());
  }

  _ranking() {
    return rankPlayers([...this.seats.values()].map((p) => ({ id: p.id, nick: p.nick, score: p.score, correct: p.correct, answered: p.answered, totalMs: p.totalMs })));
  }

  /** 本題作廢（影片壞掉／房主跳過）：不計分，換備用題 */
  _skipQuestion(reason) {
    if (this.phase !== 'preload' && this.phase !== 'playing') return;
    this.clearTimers();
    this.broadcast({ t: 'skipped', idx: this.g.idx, reason });
    this._nextQuestion({ replace: true });
  }

  _final() {
    this.clearTimers();
    this.phase = 'final';
    this.lastFinal = { t: 'final', total: this.g ? this.g.idx : 0, ranking: this._ranking() };
    this.broadcast(this.lastFinal);
    this._broadcastState();
  }

  tick() {
    if (this.phase === 'preload') this._checkBarrier();
    if (this.phase === 'playing') this._checkProgress();
  }

  // ===== 重啟不斷線：存成 JSON、重啟後還原 =====
  serialize() {
    const g = this.g;
    return {
      phase: this.phase, lastReveal: this.lastReveal, lastFinal: this.lastFinal,
      seats: [...this.seats.values()].map((p) => ({ id: p.id, ...Object.fromEntries(SEAT_KEYS.map((k) => [k, p[k]])) })),
      g: g && {
        idx: g.idx, total: g.total, qId: g.q ? g.q.id : null, queueIds: g.queue.map((q) => q.id),
        catOf: Object.fromEntries([...g.queue, ...(g.q ? [g.q] : [])].map((q) => [q.id, g.catOf.get(q.id)])),
        choices: g.choices, correctIdx: g.correctIdx, correctKey: g.correctKey, cat: g.cat, ask: g.ask,
        startAt: g.startAt, t0: g.t0, goMsg: g.goMsg, qMsg: g.qMsg, quorumEndsAt: g.quorumEndsAt, windowMs: g.windowMs,
      },
    };
  }

  /** 由 serialize() 的資料還原；null = 還原不了（例如題庫更新後那一題不見了），房間會回到大廳 */
  static restore(hub, settings, d, env) {
    const gd = d.g;
    if (!gd) return null;
    const idMap = env.idMap || new Map();
    const q = gd.qId ? idMap.get(gd.qId) : null;
    const inQuestion = ['preload', 'playing', 'reveal'].includes(d.phase);
    if (inQuestion && !q) return null;
    const gm = new SongGame(hub, settings);
    gm.phase = d.phase;
    gm.lastReveal = d.lastReveal || null; gm.lastFinal = d.lastFinal || null;
    gm.g = {
      queue: (gd.queueIds || []).map((id) => idMap.get(id)).filter(Boolean),
      catOf: new Map(Object.entries(gd.catOf || {})),
      idx: gd.idx, total: gd.total, q, works: settings.answerMode === 'typing' ? buildWorks(settings) : {},
      choices: gd.choices, correctIdx: gd.correctIdx, correctKey: gd.correctKey, cat: gd.cat, ask: gd.ask || 'work',
      startAt: gd.startAt, t0: gd.t0, goMsg: gd.goMsg, qMsg: gd.qMsg, quorumEndsAt: gd.quorumEndsAt, windowMs: gd.windowMs,
    };
    for (const sd of d.seats || []) {
      const m = hub.players.get(sd.id);
      if (m) gm.seat(m, Object.fromEntries(SEAT_KEYS.map((k) => [k, sd[k]])));
    }
    for (const m of hub.players.values()) if (!gm.seats.has(m.id)) gm.seat(m, freshSeat({ spectator: true }));
    gm._rearm();
    return gm;
  }

  /** 還原後重新排計時器。給大家一點重連的緩衝時間（至少 restoreGraceMs），避免剛重啟就被判時間到 */
  _rearm() {
    const g = this.g;
    const now = Date.now();
    const grace = this.T.restoreGraceMs;
    if (this.phase === 'preload') {
      this.after('preload', this.T.preloadMs, () => this._go());
    } else if (this.phase === 'playing') {
      const hard = Math.max(g.startAt + g.windowMs + this.T.lagMs - now, grace);
      this.after('hard', hard, () => this._reveal('time'));
      if (g.quorumEndsAt) {
        g.quorumEndsAt = Math.max(g.quorumEndsAt, now + grace);
        this.after('quorum', g.quorumEndsAt - now, () => this._reveal('quorum'));
      }
    } else if (this.phase === 'reveal' && this.settings.autoNext > 0) {
      const at = Math.max((this.lastReveal && this.lastReveal.nextAt) || 0, now + 5000);
      if (this.lastReveal) this.lastReveal.nextAt = at;
      this.after('next', at - now, () => this._nextQuestion());
    }
  }
}
