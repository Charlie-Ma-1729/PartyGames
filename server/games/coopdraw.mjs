// 合力塗鴉：多人合作畫圖猜題。
//
// 每一回合：一位「猜題者」（只看得到即時畫布、打字猜），其他所有人都是「畫家」（看得到題目）。
// 每位畫家拿到一張不同的「工具卡」（只能畫直線／只能畫圓／只能點點／只能擦…）和一條會慢慢恢復的墨水，
// 大家同時在同一張共享畫布上作畫，合力讓猜題者猜出答案。墨水用完時還能放「📍指揮標記」（只有畫家看得到）指揮隊友。
// 題目只會傳給畫家的裝置，猜題者與旁觀者拿不到。
//
// 階段：intro（發牌）→ draw（作畫＋猜題）→ roundEnd（揭曉）→ … → final
// 工具卡、墨水、繪圖操作的驗證在 js/games/coopdraw/rules.js（與用戶端共用）。
import { readFileSync, existsSync } from 'node:fs';
import path from 'node:path';
import { ROOT } from '../bank.mjs';
import { MAX_PLAYERS, num, oneOf, shuffle } from '../protocol.mjs';
import { GameBase } from './base.mjs';
import { CARDS, PALETTE, PING_EMOJI, INK_MAX, INK_REGEN, W, H, inkAt, sanitizeOp } from '../../js/games/coopdraw/rules.js';

const ALL = '__all__';
const MAX_OPS = 4000; // 一回合畫布操作紀錄的上限（重連時要整份重播）
const MAX_OPS_PER_MSG = 25;

// ===== 題庫 =====
/** { [分類]: [{ word: 標準答案, answers: [正規化後的所有可接受答案], lvl: 'easy'|'medium' }] } */
export let bank = {};
/** 比對用：全形轉半形、轉小寫、去掉空白與標點 */
export const norm = (s) => String(s).normalize('NFKC').toLowerCase().replace(/[\s\p{P}\p{S}]+/gu, '');

export function loadDrawBank() {
  const file = path.join(ROOT, 'data', 'draw.json');
  const out = {};
  try {
    if (existsSync(file)) {
      const j = JSON.parse(readFileSync(file, 'utf8'));
      for (const [name, lv] of Object.entries(j.categories || {})) {
        const seen = new Set();
        const list = [];
        for (const lvl of ['easy', 'medium', 'hard']) {
          for (const raw of (lv && lv[lvl]) || []) {
            const names = String(raw).split('|').map((x) => x.trim()).filter(Boolean);
            if (!names.length || seen.has(names[0])) continue;
            seen.add(names[0]);
            list.push({ word: names[0], answers: [...new Set(names.map(norm))], lvl });
          }
        }
        if (list.length) out[name] = list;
      }
    }
  } catch (e) { console.error('讀取合力塗鴉題庫失敗', e.message); }
  bank = out;
}
loadDrawBank();
process.on('SIGHUP', () => { try { loadDrawBank(); } catch (e) { console.error(e); } });

/** 難度 → 會出哪些等級的題目 */
const LEVELS = { easy: ['easy'], all: ['easy', 'medium'], hard: ['medium', 'hard'], any: ['easy', 'medium', 'hard'] };
const DEFAULTS = { category: ALL, difficulty: 'easy', duration: 75, rounds: 1 };
const freshSeat = (extra = {}) => ({ score: 0, guessed: 0, assists: 0, spectator: false, ...extra });

function rank(rows) {
  const sorted = rows.slice().sort((a, b) => b.score - a.score || a.nick.localeCompare(b.nick));
  let r = 0;
  return sorted.map((p, i) => { if (i === 0 || p.score !== sorted[i - 1].score) r = i + 1; return { ...p, rank: r }; });
}

export class CoopDrawGame extends GameBase {
  static meta = {
    id: 'coopdraw', name: '合力塗鴉', icon: '🎨', min: 3, max: MAX_PLAYERS, roles: ['player', 'spectator'],
    desc: '大家合力在同一張畫布上畫出題目，讓猜題者猜！但每個人只拿到受限的工具（只能畫直線、只能畫圓、只能點點…）和有限的墨水，必須互相配合。',
  };
  static defaults = DEFAULTS;
  static clean(input, prev = DEFAULTS) {
    const s = input && typeof input === 'object' ? input : {};
    const cat = s.category ?? prev.category;
    return {
      category: cat === ALL || bank[cat] ? cat : prev.category,
      difficulty: oneOf(s.difficulty ?? prev.difficulty, Object.keys(LEVELS), prev.difficulty),
      duration: num(s.duration ?? prev.duration, 30, 180, prev.duration),
      rounds: num(s.rounds ?? prev.rounds, 1, 3, prev.rounds),
    };
  }
  static info() {
    const n = (list, lvl) => list.filter((w) => w.lvl === lvl).length;
    return { categories: Object.entries(bank).map(([name, list]) => ({ name, easy: n(list, 'easy'), medium: n(list, 'medium'), hard: n(list, 'hard') })) };
  }
  static restore() { return null; } // 計時器多、畫布大，重啟後直接回大廳

  constructor(hub, settings) {
    super(hub, settings);
    this.phase = 'intro';
    this.turns = []; // [{ g: 猜題者 id }]
    this.ti = 0;
    this.turn = null;
    this.deck = [];
    this.deckPos = 0;
    this.lastRoundEnd = null;
    this.lastFinal = null;
    this.syncAt = new Map();
  }

  poolWords() {
    const s = this.settings;
    const lists = s.category === ALL ? Object.values(bank) : [bank[s.category] || []];
    const lv = LEVELS[s.difficulty] || LEVELS.easy;
    const seen = new Set(); // 不同分類可能有同一題，只留一份
    return lists.flat().filter((w) => lv.includes(w.lvl) && !seen.has(w.word) && seen.add(w.word));
  }

  check() {
    if (!this.poolWords().length) return { code: 'EMPTY', msg: '這個分類沒有題目' };
    return null;
  }

  start() {
    this.deck = shuffle(this.poolWords());
    this.deckPos = 0;
    const order = shuffle([...this.hub.players.values()].filter((m) => m.connected && m.role === 'player'));
    for (const m of this.hub.players.values()) this.seat(m, freshSeat({ spectator: !order.includes(m) }));
    for (let r = 0; r < this.settings.rounds; r++) for (const m of order) this.turns.push({ g: m.id });
    this.ti = 0;
    this._beginTurn();
  }

  canJoin() { return true; } // 中途加入的人先當旁觀，下一局才參加

  // ===== 回合 =====
  _playable(id) { const s = this.seats.get(id); return !!s && !s.spectator; }
  _active(id) { const s = this.seats.get(id); return !!s && (s.connected || Date.now() - s.lastSeen <= this.T.staleMs); }

  _nextWord() {
    if (this.deckPos >= this.deck.length) { this.deck = shuffle(this.deck); this.deckPos = 0; }
    return this.deck[this.deckPos++];
  }

  /** 發工具卡：人少時不發輔助型的卡（點點、印章、橡皮擦），人多（≥4 位畫家）時一定有橡皮擦；卡不夠時才重複 */
  _deal(drawers) {
    const n = drawers.length;
    const pool = n >= 4 ? CARDS : CARDS.filter((c) => !c.support);
    let list = [];
    while (list.length < n) list = list.concat(shuffle(pool));
    list = list.slice(0, n);
    if (n >= 4 && !list.some((c) => c.id === 'eraser')) list[0] = CARDS.find((c) => c.id === 'eraser');
    const colors = shuffle(PALETTE.slice(1));
    const out = new Map();
    drawers.forEach((id, i) => out.set(id, { card: list[i], color: colors[i % colors.length] }));
    return out;
  }

  _beginTurn() {
    this.clearTimers();
    while (this.ti < this.turns.length && !this._playable(this.turns[this.ti].g)) this.ti++;
    if (this.ti >= this.turns.length) return this._final();
    const g = this.turns[this.ti].g;
    const drawers = shuffle([...this.seats.values()].filter((s) => !s.spectator && s.id !== g && s.connected).map((s) => s.id));
    if (!this._active(g) || drawers.length < 2) { this.broadcast({ t: 'skipped', reason: '人數不夠或有人不在線上，略過這一回合' }); this.ti++; return this._beginTurn(); }
    const w = this._nextWord();
    this.turn = {
      idx: this.ti + 1, g, drawers, cards: this._deal(drawers),
      ink: new Map(), strokes: new Map(), ops: [], lastPath: new Map(),
      guesses: [], gid: 0, lastGuessAt: 0, pingAt: new Map(),
      word: w.word, answers: new Set(w.answers), solved: false, gain: null,
      endsAt: null, introEndsAt: Date.now() + this.T.introMs,
    };
    this.phase = 'intro';
    this.broadcast({ t: 'canvas', idx: this.turn.idx, ops: [] }); // 清空畫布
    for (const id of drawers) this._sendPrivate(id);
    this._broadcastState();
    this.after('intro', this.T.introMs, () => this._play());
  }

  _sendPrivate(id) {
    const t = this.turn;
    const seat = this.seats.get(id);
    const c = t && t.cards.get(id);
    if (!seat || !c) return;
    this.sendTo(seat, { t: 'card', idx: t.idx, id: c.card.id, color: c.color, inkMax: INK_MAX, regen: INK_REGEN });
    this.sendTo(seat, { t: 'word', idx: t.idx, word: t.word });
  }

  _play() {
    if (this.phase !== 'intro') return;
    const t = this.turn;
    if (!this._active(t.g)) return this._abandon();
    this.phase = 'draw';
    const now = Date.now();
    t.endsAt = now + this.settings.duration * 1000;
    for (const id of t.drawers) t.ink.set(id, { v: INK_MAX, t: now });
    this._broadcastState();
    for (const id of t.drawers) this.sendTo(this.seats.get(id), { t: 'ink', v: INK_MAX, at: now, rej: 0 });
    this.after('round', this.settings.duration * 1000, () => this._endRound('time'));
  }

  // ===== 畫圖 =====
  _log(uid, op) {
    const t = this.turn;
    if (op.k === 'path') {
      const prev = t.ops[t.ops.length - 1];
      // 同一個人同一筆、而且是紀錄裡最後一個操作時，把新的一段接到後面（只合併不改變疊放順序）
      if (prev && prev.k === 'path' && prev.u === uid && prev.s === op.s && prev.pts.length < 3000) {
        const last = prev.pts[prev.pts.length - 1];
        if (last[0] === op.pts[0][0] && last[1] === op.pts[0][1]) { prev.pts.push(...op.pts.slice(1)); return; }
      }
      t.ops.push({ ...op, pts: op.pts.slice(), u: uid });
      return;
    }
    t.ops.push(op);
  }

  _onOps(p, msg) {
    const t = this.turn;
    if (!t || this.phase !== 'draw' || !Array.isArray(msg.ops)) return;
    const slot = t.cards.get(p.id);
    const st = t.ink.get(p.id);
    if (!slot || !st) return;
    const now = Date.now();
    let ink = inkAt(st, now);
    let stroke = t.strokes.get(p.id) || { s: null, len: 0, last: null };
    const accepted = [];
    let rejected = 0;
    for (const raw of msg.ops.slice(0, MAX_OPS_PER_MSG)) {
      if (t.ops.length >= MAX_OPS) { rejected++; continue; }
      const r = sanitizeOp(slot.card, slot.color, raw, ink, stroke);
      if (!r.op) { rejected++; continue; }
      ink -= r.cost; stroke = r.stroke;
      accepted.push(r.op);
      this._log(p.id, r.op);
    }
    st.v = ink; st.t = now;
    t.strokes.set(p.id, stroke);
    if (accepted.length) this.broadcast({ t: 'ops', u: p.id, ops: accepted });
    this.sendTo(p, { t: 'ink', v: Math.round(ink * 10) / 10, at: now, rej: rejected });
  }

  _ping(p, msg) {
    const t = this.turn;
    if (!t || this.phase !== 'draw' || !t.cards.has(p.id)) return;
    const now = Date.now();
    if (now - (t.pingAt.get(p.id) || 0) < (this.T.pingCdMs ?? 1500)) return;
    const x = Number(msg.x); const y = Number(msg.y);
    if (!Number.isFinite(x) || !Number.isFinite(y)) return;
    t.pingAt.set(p.id, now);
    const m = { t: 'ping', from: p.nick, x: Math.round(Math.max(0, Math.min(W, x))), y: Math.round(Math.max(0, Math.min(H, y))), e: PING_EMOJI.includes(msg.e) ? msg.e : PING_EMOJI[0] };
    for (const id of t.drawers) this.sendTo(this.seats.get(id), m); // 只有畫家看得到
  }

  // ===== 猜題 =====
  _guess(p, msg) {
    const t = this.turn;
    if (!t || this.phase !== 'draw' || t.solved || p.id !== t.g) return;
    const now = Date.now();
    if (now - t.lastGuessAt < (this.T.guessCdMs ?? 1000)) return;
    const text = typeof msg.text === 'string' ? [...msg.text.replace(/[\u0000-\u001f\u007f<>]/g, '').trim()].slice(0, 20).join('') : '';
    if (!text) return;
    t.lastGuessAt = now;
    const entry = { id: ++t.gid, text, ok: false };
    t.guesses.push(entry);
    if (t.answers.has(norm(text))) {
      entry.ok = true;
      this.broadcast({ t: 'guess', ...entry, nick: p.nick });
      return this._solve();
    }
    this.broadcast({ t: 'guess', ...entry, nick: p.nick });
  }

  /** 畫家覺得猜題者猜的是同義詞（例如「單車」＝「腳踏車」），按 ✅ 接受 */
  _accept(p, msg) {
    const t = this.turn;
    if (!t || this.phase !== 'draw' || t.solved || !t.cards.has(p.id)) return;
    const e = t.guesses.find((x) => x.id === msg.id);
    if (!e) return;
    e.ok = true;
    e.by = p.nick;
    this.broadcast({ t: 'guess', ...e, nick: this.seats.get(t.g).nick });
    this._solve();
  }

  _solve() {
    const t = this.turn;
    if (t.solved) return;
    t.solved = true;
    const ratio = Math.max(0, Math.min(1, (t.endsAt - Date.now()) / (this.settings.duration * 1000)));
    t.gain = { g: 100 + Math.round(100 * ratio), d: 50 + Math.round(50 * ratio) };
    const gs = this.seats.get(t.g);
    if (gs) { gs.score += t.gain.g; gs.guessed++; }
    for (const id of t.drawers) { const s = this.seats.get(id); if (s) { s.score += t.gain.d; s.assists++; } }
    this._endRound('solved');
  }

  _endRound(reason) {
    if (this.phase !== 'draw') return;
    this.clearTimers();
    const t = this.turn;
    this.phase = 'roundEnd';
    const last = this.ti + 1 >= this.turns.length;
    this.lastRoundEnd = {
      t: 'roundEnd', idx: t.idx, total: this.turns.length, reason, last, word: t.word, solved: t.solved, gain: t.gain,
      g: this._who(t.g), ranking: this._ranking(), nextAt: Date.now() + this.T.turnEndMs, serverNow: Date.now(),
    };
    this.broadcast(this.lastRoundEnd);
    this._broadcastState();
    this.after('next', this.T.turnEndMs, () => this._advance());
  }

  _advance(skip = false) {
    if (!skip && this.phase !== 'roundEnd') return;
    this.clearTimers();
    this.ti++;
    this._beginTurn();
  }

  _abandon() {
    if (this.phase === 'draw') this._endRound('abandoned');
    else if (this.phase === 'intro') { this.broadcast({ t: 'skipped', reason: '有人不在線上，略過這一回合' }); this._advance(true); }
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
    return rank([...this.seats.values()].filter((s) => !s.spectator).map((s) => ({ id: s.id, nick: s.nick, score: s.score, guessed: s.guessed, assists: s.assists })));
  }
  _stateMsg() {
    const t = this.turn;
    return {
      t: 'state', phase: this.phase, serverNow: Date.now(), total: this.turns.length, duration: this.settings.duration,
      idx: t ? t.idx : 0, g: t ? this._who(t.g) : null, drawers: t ? t.drawers : [],
      len: t ? [...t.word].length : 0, solved: t ? t.solved : false,
      endsAt: t ? t.endsAt : null, introEndsAt: t ? t.introEndsAt : null,
      players: [...this.seats.values()].map((s) => ({
        id: s.id, nick: s.nick, connected: s.connected, score: s.score, spectator: s.spectator,
        card: t && t.cards.get(s.id) ? t.cards.get(s.id).card.id : null,
      })),
    };
  }
  _broadcastState() { this.broadcast(this._stateMsg()); }

  snapshot(conn, member) {
    const t = this.turn;
    if (t && member && t.cards.has(member.id) && this.phase !== 'final') {
      this._sendPrivate(member.id);
      const st = t.ink.get(member.id);
      if (st && this.phase === 'draw') this.send(conn, { t: 'ink', v: Math.round(inkAt(st, Date.now()) * 10) / 10, at: Date.now(), rej: 0 });
    }
    if (t) {
      this.send(conn, { t: 'canvas', idx: t.idx, ops: t.ops });
      for (const e of t.guesses) this.send(conn, { t: 'guess', ...e, nick: this._who(t.g).nick, replay: true });
    }
    if (this.phase === 'roundEnd' && this.lastRoundEnd) this.send(conn, this.lastRoundEnd);
    if (this.phase === 'final' && this.lastFinal) this.send(conn, this.lastFinal);
  }

  // ===== 成員變動 =====
  onJoin(member) { this.seat(member, freshSeat({ spectator: true })); this._broadcastState(); }
  onReconnect() { this._broadcastState(); }
  onDisconnect() { this._broadcastState(); }
  onLeave(member) {
    const t = this.turn;
    this.seats.delete(member.id);
    if (this.phase !== 'final' && [...this.seats.values()].filter((s) => !s.spectator).length < 3) return this._final();
    if (t && (this.phase === 'intro' || this.phase === 'draw')) {
      if (member.id === t.g) return this._abandon();
      const i = t.drawers.indexOf(member.id);
      if (i >= 0) {
        t.drawers.splice(i, 1);
        if (t.drawers.length < 1) return this._abandon();
      }
    }
    this._broadcastState();
  }

  handle(conn, msg) {
    const p = this.seatOf(conn);
    if (!p) return;
    const host = this.isHost(p);
    switch (msg.t) {
      case 'ops': this._onOps(p, msg); break;
      case 'ping': this._ping(p, msg); break;
      case 'guess': this._guess(p, msg); break;
      case 'accept': this._accept(p, msg); break;
      case 'sync': {
        const now = Date.now();
        if (this.turn && now - (this.syncAt.get(p.id) || 0) > 1500) { this.syncAt.set(p.id, now); this.send(conn, { t: 'canvas', idx: this.turn.idx, ops: this.turn.ops }); }
        break;
      }
      case 'next': if (host && this.phase === 'roundEnd') this._advance(); break;
      case 'skip': if (host && (this.phase === 'intro' || this.phase === 'draw')) this._abandon(); break;
      case 'end': if (host && this.phase !== 'final') this._final(); break;
      default: break;
    }
  }

  tick() {
    const t = this.turn;
    if (!t || (this.phase !== 'draw' && this.phase !== 'intro')) return;
    if (!this._active(t.g) || !t.drawers.some((id) => this._active(id))) this._abandon(); // 猜題者離線太久／畫家全不在：結束這一回合
  }

  serialize() { return null; }
}
