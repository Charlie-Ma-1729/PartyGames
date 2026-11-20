// 你說我猜（Heads Up 的「出題者／猜題者」兩人一組玩法，擴充成多人輪流）
//
// 每一「輪」有兩個人：出題者（看得到題目，用嘴巴描述，答對按 ✔、太難按 ⏭）和猜題者（看不到題目，負責猜）。
// 其他人當觀眾，看得到倒數與目前得分。輪流讓每個人都當一次出題者（猜題者是下一位），每輪答對的題數兩人各得同樣的分。
// 題目只會傳給出題者的裝置，其他人拿不到。
//
// 階段：intro（換人準備）→ play（倒數作答）→ turnEnd（本輪結果）→ … → final
import { readFileSync, existsSync } from 'node:fs';
import path from 'node:path';
import { ROOT } from '../bank.mjs';
import { MAX_PLAYERS, num, shuffle } from '../protocol.mjs';
import { GameBase } from './base.mjs';

const ALL = '__all__';

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

const DEFAULTS = { category: ALL, duration: 60, rounds: 1 };

const SEAT_KEYS = ['score', 'correct', 'turns', 'spectator'];
const freshSeat = (extra = {}) => ({ score: 0, correct: 0, turns: 0, spectator: false, ...extra });

function rank(rows) {
  const sorted = rows.slice().sort((a, b) => b.score - a.score || a.nick.localeCompare(b.nick));
  let r = 0;
  return sorted.map((p, i) => { if (i === 0 || p.score !== sorted[i - 1].score) r = i + 1; return { ...p, rank: r }; });
}

export class HeadsUpGame extends GameBase {
  static meta = {
    id: 'headsup', name: '你說我猜', icon: '🗣️', min: 2, max: MAX_PLAYERS, screen: false,
    desc: '一人看題目、用嘴巴描述（不能說出題目的字！），另一人猜。限時內答對越多分越高，大家輪流當出題者。',
  };
  static defaults = DEFAULTS;
  static clean(input, prev = DEFAULTS) {
    const s = input && typeof input === 'object' ? input : {};
    const cat = s.category ?? prev.category;
    return {
      category: cat === ALL || bank[cat] ? cat : prev.category,
      duration: num(s.duration ?? prev.duration, 20, 180, prev.duration),
      rounds: num(s.rounds ?? prev.rounds, 1, 3, prev.rounds),
    };
  }
  static info() { return { categories: Object.entries(bank).map(([name, list]) => ({ name, n: list.length })) }; }
  static restore() { return null; } // 輪流制、計時器多，重啟後直接回大廳

  constructor(hub, settings) {
    super(hub, settings);
    this.phase = 'intro';
    this.turns = [];
    this.ti = 0; // 目前第幾輪（0 起算）
    this.turn = null;
    this.deck = [];
    this.deckPos = 0;
    this.lastTurnEnd = null;
    this.lastFinal = null;
  }

  poolWords() {
    const s = this.settings;
    if (s.category !== ALL) return bank[s.category] || [];
    return [...new Set(Object.values(bank).flat())];
  }

  check() { return this.poolWords().length ? null : { code: 'EMPTY', msg: '這個分類沒有題目' }; }

  start() {
    this.deck = shuffle(this.poolWords());
    this.deckPos = 0;
    const order = shuffle([...this.hub.players.values()].filter((m) => m.connected));
    for (const m of this.hub.players.values()) this.seat(m, freshSeat({ spectator: !order.includes(m) }));
    const n = order.length;
    for (let r = 0; r < this.settings.rounds; r++) {
      for (let i = 0; i < n; i++) this.turns.push({ d: order[i].id, g: order[(i + 1) % n].id });
    }
    this.ti = 0;
    this._beginTurn();
  }

  canJoin() { return true; } // 中途加入的人先當觀眾，下一局才參加

  // ===== 輪次 =====
  _playable(id) { const s = this.seats.get(id); return !!s && !s.spectator; }
  _active(id) { const s = this.seats.get(id); return !!s && (s.connected || Date.now() - s.lastSeen <= this.T.staleMs); }

  _beginTurn() {
    this.clearTimers();
    while (this.ti < this.turns.length && !(this._playable(this.turns[this.ti].d) && this._playable(this.turns[this.ti].g))) this.ti++;
    if (this.ti >= this.turns.length) return this._final();
    const t = this.turns[this.ti];
    this.turn = { idx: this.ti + 1, d: t.d, g: t.g, correct: 0, passed: 0, words: [], seq: 0, word: null, endsAt: null, introEndsAt: Date.now() + this.T.introMs };
    this.phase = 'intro';
    this._broadcastState();
    this.after('intro', this.T.introMs, () => this._play());
  }

  _play() {
    if (this.phase !== 'intro') return;
    const t = this.turn;
    if (!this._active(t.d) || !this._active(t.g)) { this.broadcast({ t: 'skipped', reason: '有人不在線上，略過這一輪' }); return this._advance(true); }
    this.phase = 'play';
    t.endsAt = Date.now() + this.settings.duration * 1000;
    this._nextWord();
    this._broadcastState();
    this.after('turn', this.settings.duration * 1000, () => this._endTurn('time'));
  }

  _nextWord() {
    if (this.deckPos >= this.deck.length) { this.deck = shuffle(this.deck); this.deckPos = 0; }
    const t = this.turn;
    t.word = this.deck[this.deckPos++];
    t.seq++;
    this.sendTo(this.seats.get(t.d), { t: 'word', idx: t.idx, seq: t.seq, word: t.word });
  }

  _mark(msg) {
    const t = this.turn;
    if (this.phase !== 'play' || msg.seq !== t.seq) return;
    const ok = msg.type === 'correct';
    if (!ok && msg.type !== 'pass') return;
    t.words.push({ word: t.word, ok });
    if (ok) t.correct++; else t.passed++;
    this._nextWord();
    this._broadcastState();
  }

  _endTurn(reason) {
    if (this.phase !== 'play') return;
    this.clearTimers();
    const t = this.turn;
    for (const id of [t.d, t.g]) {
      const s = this.seats.get(id);
      if (s) { s.score += t.correct; s.correct += t.correct; s.turns++; }
    }
    this.phase = 'turnEnd';
    const last = this.ti + 1 >= this.turns.length;
    this.lastTurnEnd = {
      t: 'turnEnd', idx: t.idx, total: this.turns.length, reason, last,
      d: this._who(t.d), g: this._who(t.g), correct: t.correct, passed: t.passed, words: t.words,
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
    else if (this.phase === 'intro') this._advance(true);
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
      t: 'state', phase: this.phase, serverNow: Date.now(), total: this.turns.length, duration: this.settings.duration,
      idx: t ? t.idx : 0, d: t ? this._who(t.d) : null, g: t ? this._who(t.g) : null,
      correct: t ? t.correct : 0, passed: t ? t.passed : 0, endsAt: t ? t.endsAt : null, introEndsAt: t ? t.introEndsAt : null,
      players: [...this.seats.values()].map((s) => ({ id: s.id, nick: s.nick, connected: s.connected, score: s.score, spectator: s.spectator })),
    };
  }
  _broadcastState() { this.broadcast(this._stateMsg()); }

  snapshot(conn, member) {
    const t = this.turn;
    if (member && t && this.phase === 'play' && member.id === t.d) this.send(conn, { t: 'word', idx: t.idx, seq: t.seq, word: t.word });
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
    if (this.phase !== 'final' && [...this.seats.values()].filter((s) => !s.spectator).length < 2) return this._final();
    if (t && (member.id === t.d || member.id === t.g)) this._abandonTurn();
    this._broadcastState();
  }

  handle(conn, msg) {
    const p = this.seatOf(conn);
    if (!p) return;
    const host = this.isHost(p);
    switch (msg.t) {
      case 'mark': if (this.turn && p.id === this.turn.d) this._mark(msg); break;
      case 'next': if (host && this.phase === 'turnEnd') this._advance(); break;
      case 'skip': if (host && (this.phase === 'intro' || this.phase === 'play')) this._abandonTurn(); break;
      case 'end': if (host && this.phase !== 'final') this._final(); break;
      default: break;
    }
  }

  tick() {
    const t = this.turn;
    if (!t) return;
    if (this.phase === 'play' && !this._active(t.d)) this._endTurn('abandoned'); // 出題者離線超過寬限時間：結束這一輪
    else if (this.phase === 'intro' && (!this._active(t.d) || !this._active(t.g))) this._abandonTurn();
  }

  serialize() { return null; }
}
