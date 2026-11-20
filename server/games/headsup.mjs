// 你說我猜（Heads Up）：三種玩法，房主在大廳選
//
//   team（經典，預設）：每一輪一位「猜題者」，其他所有人都看得到題目、一起用嘴巴描述；每輪隨機指定其中一位當「操作者」負責按 ✔／⏭（避免大家同時按打架）。
//                       猜題者在時間內猜越多越好，猜中一題猜題者 +1 分。每個人輪流當猜題者（或房主指定一位猜題者）。
//   pair（一對一輪流）：每一輪一位「出題者」看題目、一位「猜題者」猜，出題者與猜題者各得同樣的分；出題者輪流換，猜題者是下一位（或房主指定）。
//   race（搶答）：每一輪一位「出題者」看題目、用嘴巴描述，其他人搶答；出題者按下「第一個答對的人」，那個人 +1 分，出題者也 +1 分。
//
// 主題：房主可以固定一個分類／全部混合，或選「每輪自選」——每輪開始前由當輪的猜題者（race 則是出題者）自己選主題，逾時自動「全部混合」。
// 題目只會傳給有資格看的人（team：所有描述的人；pair／race：出題者），猜題者／搶答者的裝置拿不到。
//
// 階段：pick（選主題，只有「每輪自選」才有）→ intro（換人準備）→ play（倒數作答）→ turnEnd（本輪結果）→ … → final
import { readFileSync, existsSync } from 'node:fs';
import path from 'node:path';
import { ROOT } from '../bank.mjs';
import { MAX_PLAYERS, cleanId, num, oneOf, shuffle } from '../protocol.mjs';
import { GameBase } from './base.mjs';

const ALL = '__all__'; // 全部混合
const PICK = '__pick__'; // 每輪由當輪的猜題者（race：出題者）自選
const MODES = ['team', 'pair', 'race'];

/** { [分類名稱]: string[] }，載入時去除空白與同分類內重複的題目 */
export let bank = {};
export function loadHeadsUpBank() {
  const file = path.join(ROOT, 'data', 'headsup.json');
  const out = {};
  try {
    if (existsSync(file)) {
      const j = JSON.parse(readFileSync(file, 'utf8'));
      for (const [name, words] of Object.entries(j.categories || {})) {
        const list = [...new Set((words || []).map((w) => String(w).trim()).filter(Boolean))];
        if (list.length) out[name] = list;
      }
    }
  } catch (e) { console.error('讀取你說我猜題庫失敗', e.message); }
  bank = out;
}
loadHeadsUpBank();
process.on('SIGHUP', () => { try { loadHeadsUpBank(); } catch (e) { console.error(e); } });

const DEFAULTS = { mode: 'team', category: PICK, duration: 60, rounds: 1, guesserMode: 'rotate', guesserId: null };

const freshSeat = (extra = {}) => ({ score: 0, correct: 0, turns: 0, spectator: false, ...extra });

function rank(rows) {
  const sorted = rows.slice().sort((a, b) => b.score - a.score || a.nick.localeCompare(b.nick));
  let r = 0;
  return sorted.map((p, i) => { if (i === 0 || p.score !== sorted[i - 1].score) r = i + 1; return { ...p, rank: r }; });
}

export class HeadsUpGame extends GameBase {
  static meta = {
    id: 'headsup', name: '你說我猜', icon: '🗣️', min: 2, max: MAX_PLAYERS, roles: ['player'],
    desc: '一人猜、其他人一起用嘴巴描述題目（不能說出題目的字！），猜題者自選主題、限時內猜越多越好。也可以玩一對一輪流，或「出題者選最快答對的人」的搶答。',
  };
  static defaults = DEFAULTS;
  static clean(input, prev = DEFAULTS) {
    const s = input && typeof input === 'object' ? input : {};
    const cat = s.category ?? prev.category;
    return {
      mode: oneOf(s.mode ?? prev.mode, MODES, prev.mode),
      category: cat === ALL || cat === PICK || bank[cat] ? cat : prev.category,
      duration: num(s.duration ?? prev.duration, 20, 180, prev.duration),
      rounds: num(s.rounds ?? prev.rounds, 1, 3, prev.rounds),
      guesserMode: oneOf(s.guesserMode ?? prev.guesserMode, ['rotate', 'fixed'], prev.guesserMode),
      guesserId: s.guesserId === undefined ? prev.guesserId : cleanId(s.guesserId),
    };
  }
  static info() { return { categories: Object.entries(bank).map(([name, list]) => ({ name, n: list.length })) }; }
  static restore() { return null; } // 輪流制、計時器多，重啟後直接回大廳

  constructor(hub, settings) {
    super(hub, settings);
    this.phase = 'intro';
    this.turns = []; // { mode, g（猜題者 id；race 為 null）, ds（描述／出題者 id 陣列）}
    this.ti = 0; // 目前第幾輪（0 起算）
    this.turn = null;
    this.decks = new Map(); // 分類 → { list, pos }：同一個分類不重複，抽完才重洗
    this.lastTurnEnd = null;
    this.lastFinal = null;
  }

  poolWords(cat) {
    if (cat === ALL) return [...new Set(Object.values(bank).flat())];
    return bank[cat] || [];
  }

  _draw(cat) {
    let d = this.decks.get(cat);
    if (!d) { d = { list: shuffle(this.poolWords(cat)), pos: 0 }; this.decks.set(cat, d); }
    if (d.pos >= d.list.length) { d.list = shuffle(d.list); d.pos = 0; }
    return d.list[d.pos++] || '';
  }

  get mode() { return this.settings.mode; }

  /** 指定猜題者模式：猜題者必須是目前在線的玩家 */
  _fixedGuesser() {
    const m = this.hub.players.get(this.settings.guesserId);
    return m && m.connected ? m : null;
  }

  check() {
    const s = this.settings;
    if (s.category !== PICK && !this.poolWords(s.category).length) return { code: 'EMPTY', msg: '這個分類沒有題目' };
    if (s.category === PICK && !Object.keys(bank).length) return { code: 'EMPTY', msg: '題庫是空的' };
    if (s.mode !== 'race' && s.guesserMode === 'fixed' && !this._fixedGuesser()) return { code: 'NO_GUESSER', msg: '請先指定一位在線的猜題者' };
    return null;
  }

  start() {
    this.decks = new Map();
    const order = shuffle([...this.hub.players.values()].filter((m) => m.connected));
    for (const m of this.hub.players.values()) this.seat(m, freshSeat({ spectator: !order.includes(m) }));
    const ids = order.map((m) => m.id);
    const { mode, rounds } = this.settings;
    const fixed = mode !== 'race' && this.settings.guesserMode === 'fixed' ? this._fixedGuesser().id : null;
    for (let r = 0; r < rounds; r++) {
      if (mode === 'race') {
        for (const id of ids) this.turns.push({ mode, g: null, ds: [id] });
      } else if (mode === 'team') {
        if (fixed) this.turns.push({ mode, g: fixed, ds: ids.filter((x) => x !== fixed) }); // 一個人猜、其他人一起描述
        else for (const id of ids) this.turns.push({ mode, g: id, ds: ids.filter((x) => x !== id) });
      } else if (fixed) {
        for (const id of ids.filter((x) => x !== fixed)) this.turns.push({ mode, g: fixed, ds: [id] }); // 其他人輪流出題、同一個人猜
      } else {
        ids.forEach((id, i) => this.turns.push({ mode, g: ids[(i + 1) % ids.length], ds: [id] }));
      }
    }
    this.ti = 0;
    this._beginTurn();
  }

  canJoin() { return true; } // 中途加入的人先當觀眾，下一局才參加

  // ===== 輪次 =====
  _playable(id) { const s = this.seats.get(id); return !!s && !s.spectator; }
  _active(id) { const s = this.seats.get(id); return !!s && (s.connected || Date.now() - s.lastSeen <= this.T.staleMs); }
  _playableIds() { return [...this.seats.values()].filter((s) => !s.spectator).map((s) => s.id); }

  /** 這一輪還成不成立：team／pair 要猜題者與至少一位描述的人；race 要出題者與至少一位搶答的人 */
  _turnOk(check) {
    const t = this.turn;
    if (t.mode === 'race') return check(t.ds[0]) && this._playableIds().some((id) => id !== t.ds[0] && check(id));
    return check(t.g) && t.ds.some(check);
  }

  /** 經典玩法：操作者離線或離開 → 換另一位還在線的描述者接手 */
  _ensureOp() {
    const t = this.turn;
    if (!t || t.mode !== 'team' || (this._playable(t.op) && this._active(t.op))) return false;
    const next = shuffle(t.ds.filter((id) => id !== t.op && this._playable(id) && this._active(id)))[0];
    if (!next) return false;
    t.op = next;
    return true;
  }

  _beginTurn() {
    this.clearTimers();
    while (this.ti < this.turns.length) {
      const tt = this.turns[this.ti];
      const ds = tt.ds.filter((id) => this._playable(id));
      const ok = tt.mode === 'race' ? ds.length && this._playableIds().some((id) => id !== ds[0]) : ds.length && this._playable(tt.g);
      if (ok) break;
      this.ti++;
    }
    if (this.ti >= this.turns.length) return this._final();
    const tt = this.turns[this.ti];
    const ds = tt.ds.filter((id) => this._playable(id));
    // 負責按 ✔／⏭ 的人（操作者）：經典玩法有很多人看得到題目，只隨機指定一位來按，避免大家同時按「打架」；其他模式本來就只有出題者
    const op = tt.mode === 'team' ? (shuffle(ds).find((id) => this._active(id)) || ds[0]) : ds[0];
    this.turn = {
      idx: this.ti + 1, mode: tt.mode, g: tt.g, ds, op, chooser: tt.mode === 'race' ? ds[0] : tt.g, cat: null,
      correct: 0, passed: 0, words: [], seq: 0, word: null, endsAt: null, introEndsAt: null, pickEndsAt: null,
    };
    if (this.settings.category === PICK) {
      this.phase = 'pick';
      this.turn.pickEndsAt = Date.now() + this.T.pickMs;
      this._broadcastState();
      this.after('pick', this.T.pickMs, () => this._pick(ALL));
    } else {
      this.turn.cat = this.settings.category;
      this._intro();
    }
  }

  _pick(cat) {
    if (this.phase !== 'pick') return;
    if (cat !== ALL && !bank[cat]) return;
    this.turn.cat = cat;
    this._intro();
  }

  _intro() {
    this.phase = 'intro';
    this.turn.introEndsAt = Date.now() + this.T.introMs;
    this._broadcastState();
    this.after('intro', this.T.introMs, () => this._play());
  }

  _play() {
    if (this.phase !== 'intro') return;
    const t = this.turn;
    if (!this._turnOk((id) => this._active(id))) { this.broadcast({ t: 'skipped', reason: '有人不在線上，略過這一輪' }); return this._advance(true); }
    this.phase = 'play';
    t.endsAt = Date.now() + this.settings.duration * 1000;
    this._nextWord();
    this._broadcastState();
    this.after('turn', this.settings.duration * 1000, () => this._endTurn('time'));
  }

  _nextWord() {
    const t = this.turn;
    t.word = this._draw(t.cat);
    t.seq++;
    for (const id of t.ds) this.sendTo(this.seats.get(id), { t: 'word', idx: t.idx, seq: t.seq, word: t.word });
  }

  _mark(msg) {
    const t = this.turn;
    if (this.phase !== 'play' || msg.seq !== t.seq) return;
    const ok = msg.type === 'correct';
    if (!ok && msg.type !== 'pass') return;
    let by = null;
    if (ok && t.mode === 'race') { // 搶答：出題者指定第一個答對的人
      by = this.seats.get(typeof msg.who === 'string' ? msg.who : '');
      if (!by || by.spectator || t.ds.includes(by.id)) return;
    }
    t.words.push({ word: t.word, ok, by: by ? by.nick : null, byId: by ? by.id : null });
    if (ok) t.correct++; else t.passed++;
    this._nextWord();
    this._broadcastState();
  }

  _endTurn(reason) {
    if (this.phase !== 'play') return;
    this.clearTimers();
    const t = this.turn;
    const award = (id) => { const s = this.seats.get(id); if (s) { s.score++; s.correct++; } };
    for (const w of t.words) {
      if (!w.ok) continue;
      if (t.mode === 'team') award(t.g); // 只有猜的人得分，描述的人是來幫忙的
      else if (t.mode === 'pair') { award(t.ds[0]); award(t.g); }
      else { award(w.byId); award(t.ds[0]); } // race：答對的人與出題者
    }
    const involved = t.mode === 'race' ? this._playableIds() : [...t.ds, t.g];
    for (const id of involved) { const s = this.seats.get(id); if (s) s.turns++; }
    this.phase = 'turnEnd';
    const last = this.ti + 1 >= this.turns.length;
    this.lastTurnEnd = {
      t: 'turnEnd', idx: t.idx, total: this.turns.length, reason, last, mode: t.mode, cat: t.cat,
      d: this._who(t.ds[0]), ds: t.ds.map((id) => this._who(id)), g: t.g ? this._who(t.g) : null,
      correct: t.correct, passed: t.passed, words: t.words.map((w) => ({ word: w.word, ok: w.ok, by: w.by })),
      ranking: this._ranking(), nextAt: Date.now() + this.T.turnEndMs, serverNow: Date.now(),
    };
    this.broadcast(this.lastTurnEnd);
    this._broadcastState();
    this.after('next', this.T.turnEndMs, () => this._advance());
  }

  /** 本輪結束後換下一輪；skip = 略過的輪（沒有結果畫面）時也用 */
  _advance(skip = false) {
    if (!skip && this.phase !== 'turnEnd') return;
    this.clearTimers();
    this.ti++;
    this._beginTurn();
  }

  _abandonTurn() {
    if (this.phase === 'play') this._endTurn('abandoned');
    else if (this.phase === 'intro' || this.phase === 'pick') this._advance(true);
  }

  _final() {
    this.clearTimers();
    this.phase = 'final';
    this.turn = null;
    this.lastFinal = { t: 'final', total: this.turns.length, ranking: this._ranking() };
    this.broadcast(this.lastFinal);
    this._broadcastState();
  }

  // ===== 狀態 =====
  _who(id) { const s = this.seats.get(id); return { id, nick: s ? s.nick : '（已離開）' }; }
  _ranking() {
    return rank([...this.seats.values()].filter((s) => !s.spectator || s.turns > 0).map((s) => ({ id: s.id, nick: s.nick, score: s.score, correct: s.correct, turns: s.turns })));
  }
  _stateMsg() {
    const t = this.turn;
    return {
      t: 'state', phase: this.phase, serverNow: Date.now(), total: this.turns.length, duration: this.settings.duration, mode: this.settings.mode,
      idx: t ? t.idx : 0, ds: t ? t.ds.map((id) => this._who(id)) : [], d: t ? this._who(t.ds[0]) : null, g: t && t.g ? this._who(t.g) : null, op: t ? this._who(t.op) : null,
      chooser: t ? this._who(t.chooser) : null, cat: t ? t.cat : null,
      correct: t ? t.correct : 0, passed: t ? t.passed : 0, endsAt: t ? t.endsAt : null, introEndsAt: t ? t.introEndsAt : null, pickEndsAt: t ? t.pickEndsAt : null,
      players: [...this.seats.values()].map((s) => ({ id: s.id, nick: s.nick, connected: s.connected, score: s.score, spectator: s.spectator })),
    };
  }
  _broadcastState() { this.broadcast(this._stateMsg()); }

  snapshot(conn, member) {
    const t = this.turn;
    if (member && t && this.phase === 'play' && t.ds.includes(member.id)) this.send(conn, { t: 'word', idx: t.idx, seq: t.seq, word: t.word });
    if (this.phase === 'turnEnd' && this.lastTurnEnd) this.send(conn, this.lastTurnEnd);
    if (this.phase === 'final' && this.lastFinal) this.send(conn, this.lastFinal);
  }

  // ===== 成員變動 =====
  onJoin(member) { this.seat(member, freshSeat({ spectator: true })); this._broadcastState(); }
  onReconnect() { this._broadcastState(); }
  onDisconnect() { this._broadcastState(); }
  onLeave(member) {
    const t = this.turn;
    this.seats.delete(member.id);
    if (this.phase !== 'final' && this._playableIds().length < 2) return this._final();
    if (t && this.phase !== 'final' && this.phase !== 'turnEnd') {
      if (!this._turnOk((id) => this._playable(id))) this._abandonTurn();
      else this._ensureOp();
    }
    this._broadcastState();
  }

  handle(conn, msg) {
    const p = this.seatOf(conn);
    if (!p) return;
    const host = this.isHost(p);
    const t = this.turn;
    switch (msg.t) {
      case 'mark': if (t && t.op === p.id) this._mark(msg); break; // 只有操作者能按
      case 'pick': if (t && this.phase === 'pick' && p.id === t.chooser && typeof msg.cat === 'string') this._pick(msg.cat); break;
      case 'next': if (host && this.phase === 'turnEnd') this._advance(); break;
      case 'skip': if (host && (this.phase === 'pick' || this.phase === 'intro' || this.phase === 'play')) this._abandonTurn(); break;
      case 'end': if (host && this.phase !== 'final') this._final(); break;
      default: break;
    }
  }

  tick() {
    const t = this.turn;
    if (!t) return;
    if (this.phase === 'play' || this.phase === 'intro' || this.phase === 'pick') {
      if (!this._turnOk((id) => this._active(id))) this._abandonTurn(); // 關鍵的人離線超過寬限時間：結束／略過這一輪
      else if (this._ensureOp()) this._broadcastState();
    }
  }

  serialize() { return null; }
}
