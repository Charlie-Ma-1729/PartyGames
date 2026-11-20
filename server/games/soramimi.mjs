// 空耳歌王（伺服器權威）
//
// 每位玩家先從內建題庫挑 N 首歌當自己的「題庫」；之後隨機輪流當歌手：
//   只有歌手的裝置收得到音樂（ytId 只用 sendTo 傳給歌手，任何廣播都不含它），
//   歌手要用「空耳」把這首歌唱出來（需要大家自備語音通話），其他人猜是哪一首。
//   每位猜題者每回合只能猜一次（8 選 1 或搜尋）。
//   原曲只會在倒數後「自動開播一次」，歌手不能重播、不能暫停，要即時跟上（節目效果）。
//
// 計分（常數見下方，測試會用）：
//   第一個猜對的人：FIRST_BASE + 速度加成（越早越高，最多 FIRST_SPEED）
//   歌手：每有一個人猜對 +SINGER_PER（猜對的人越多越高）
//   其他猜對的人：LATER_CORRECT（預設 0，只有第一個猜對的人得分）
//
// 階段：picking（大家挑歌）→ intro（等歌手預載）→ sing（猜）→ reveal（結果）→ … → final
import { rankPlayers } from '../../js/scoring.js';
import { bank, byId, browseReply, songLabel, isVocal, CATEGORIES } from '../bank.mjs';
import { MAX_PLAYERS, cleanId, num, oneOf, shuffle, subset } from '../protocol.mjs';
import { GameBase } from './base.mjs';

export const FIRST_BASE = 100;
export const FIRST_SPEED = 100;
export const SINGER_PER = 60;
export const LATER_CORRECT = 0;
const CHOICES = 8;
export const SING_COUNTDOWN_MS = 3000; // 歌手按「我準備好了」後的倒數，倒數結束原曲自動開播

// 空耳要有歌詞：純音樂 OST 不能選。整個「遊戲／其他 OST」題庫都是純音樂，直接不開放；其他題庫裡 kind 為 OST 的題目另外在 isVocal 過濾
export const ALL_CATS = CATEGORIES.map((c) => c.id).filter((id) => id !== 'ost');
export const DEFAULTS = {
  perPlayer: 10, // 每人題庫幾首
  rounds: 1, // 每人當幾次歌手（輪流模式）
  singerMode: 'rotate', // rotate 輪流當歌手 | fixed 固定一位歌手：其他人挑歌，全部給他唱
  fixedSingerId: '', // singerMode = fixed 時的歌手（玩家 id）
  categories: ALL_CATS,
  clipSecs: 20, // 歌手聽到的片段長度
  startMode: 'begin', // 從哪裡開始播：begin 從頭 | middle 從中間（接近高潮處，沒有資料的歌仍從頭）| fixed 固定從第 startSec 秒
  startSec: 15, // startMode = fixed 時，從第幾秒開始
  singSecs: 60, // 每回合猜的時限
  answerMode: 'choice', // choice 8 選 1 | search 從候選清單搜尋
  autoNext: 10, // 結果停留幾秒後自動下一位，0 = 房主手動
};

/** 歌手聽的片段從影片的第幾秒開始（秒）。middle = 題庫標的「最多重播處」前幾秒（約副歌），沒有資料就從頭 */
export function clipStart(q, s) {
  if (s.startMode === 'fixed') return s.startSec;
  if (s.startMode === 'middle' && q.mid != null) return q.mid;
  return q.start || 0;
}

export function cleanSettings(input, prev = DEFAULTS) {
  const s = input && typeof input === 'object' ? input : {};
  return {
    perPlayer: num(s.perPlayer ?? prev.perPlayer, 3, 20, prev.perPlayer),
    rounds: num(s.rounds ?? prev.rounds, 1, 5, prev.rounds),
    singerMode: oneOf(s.singerMode ?? prev.singerMode, ['rotate', 'fixed'], prev.singerMode),
    fixedSingerId: s.fixedSingerId === undefined ? (prev.fixedSingerId || '') : (cleanId(s.fixedSingerId) || ''),
    categories: subset(s.categories ?? prev.categories, ALL_CATS, prev.categories),
    clipSecs: num(s.clipSecs ?? prev.clipSecs, 10, 60, prev.clipSecs),
    startMode: oneOf(s.startMode ?? prev.startMode, ['begin', 'middle', 'fixed'], prev.startMode),
    startSec: num(s.startSec ?? prev.startSec, 0, 120, prev.startSec),
    singSecs: num(s.singSecs ?? prev.singSecs, 20, 180, prev.singSecs),
    answerMode: oneOf(s.answerMode ?? prev.answerMode, ['choice', 'search'], prev.answerMode),
    autoNext: s.autoNext === undefined ? prev.autoNext : (num(s.autoNext, 0, 60, 0) === 0 ? 0 : num(s.autoNext, 3, 60, 10)),
  };
}

/** 計分（純函式，方便測試）。remainingFrac = 第一個猜對時，時限還剩幾成（0–1） */
export function scoreTurn({ correctCount, remainingFrac }) {
  const f = Math.max(0, Math.min(1, remainingFrac || 0));
  return {
    first: correctCount > 0 ? FIRST_BASE + Math.round(FIRST_SPEED * f) : 0,
    later: LATER_CORRECT,
    singer: SINGER_PER * correctCount,
  };
}

const labelKey = (l) => `${l.main}\u0001${l.sub}`;

const freshSeat = (extra = {}) => ({ score: 0, correct: 0, sang: 0, totalMs: 0, picks: [], ready: false, ...extra });

export class SoramimiGame extends GameBase {
  static meta = {
    id: 'soramimi', name: '空耳歌王', icon: '🎤', min: 2, max: MAX_PLAYERS, roles: ['player', 'spectator'],
    desc: '每人先挑一批自己的歌當題庫；輪流當歌手，只有歌手聽得到音樂，要用「空耳」把歌唱出來讓大家猜！猜的人越多猜對，歌手分數越高。需要大家自備語音通話（Discord、LINE 等）。',
  };
  static defaults = DEFAULTS;
  static clean(input, prev) { return cleanSettings(input, prev); }
  static info() { return { counts: Object.fromEntries(Object.entries(bank).filter(([k]) => ALL_CATS.includes(k)).map(([k, v]) => [k, v.filter(isVocal).length])) }; }
  static restore() { return null; } // 輪流制、私人訊息多，重啟後直接回大廳

  constructor(hub, settings) {
    super(hub, settings);
    this.phase = 'picking';
    this.pool = []; // { k, main, sub }[]：所有人題庫合併、依歌名去重（不公開歸屬）；歌手從這裡抽，但不會抽到自己選的
    this.poolIdx = new Map(); // 歌名鍵 → pool 索引
    this.usedKeys = new Set(); // 已經公布過答案的歌（歌名鍵）：後面的選項不再出現
    this.turns = [];
    this.ti = 0;
    this.turn = null;
    this.lastReveal = null;
    this.lastFinal = null;
  }

  /** 固定歌手模式：開局時指定的那位玩家（其他模式為 null）。他不挑歌，其他人挑的歌全部給他唱 */
  get fixedId() { return this._fixedId || null; }

  check() {
    const s = this.settings;
    if (s.singerMode !== 'fixed') return null;
    const m = this.hub.players.get(s.fixedSingerId);
    if (!m || m.role !== 'player' || !m.connected) return { code: 'NO_SINGER', msg: '請先指定一位在線的固定歌手（必須是參賽者身分）' };
    const others = [...this.hub.players.values()].filter((x) => x.role === 'player' && x.connected && x.id !== m.id).length;
    if (others < 1) return { code: 'NO_GUESSER', msg: '固定歌手之外至少要有一位參賽者來挑歌、猜歌' };
    return null;
  }

  start() {
    this._fixedId = this.settings.singerMode === 'fixed' ? this.settings.fixedSingerId : null;
    for (const m of this.hub.players.values()) {
      if (m.role === 'player') this.seat(m, freshSeat(m.id === this._fixedId ? { ready: true } : {})); // 固定歌手不挑歌，視為已準備
    }
    this._broadcastState();
    for (const p of this.seats.values()) this._sendMine(p);
  }

  canJoin() { return true; }

  // ===== 工具 =====
  _active(p) { return !!p && (p.connected || Date.now() - p.lastSeen <= this.T.staleMs); }
  _who(id) { const s = this.seats.get(id); return { id, nick: s ? s.nick : '（已離開）' }; }
  _allowed(cat) { return this.settings.categories.includes(cat); }
  _labelOf(id) { const h = byId.get(id); return h ? songLabel(h.q, h.cat) : null; }

  _stateMsg() {
    const t = this.turn;
    return {
      t: 'state', phase: this.phase, serverNow: Date.now(), perPlayer: this.settings.perPlayer, fixedSinger: this.fixedId,
      idx: t ? t.idx : 0, total: this.turns.length, singer: t ? this._who(t.singerId) : null,
      players: [...this.seats.values()].map((p) => ({
        id: p.id, nick: p.nick, connected: p.connected, score: p.score, ready: p.ready, picks: p.picks.length,
        guessed: !!(t && t.guesses.has(p.id)), late: !!(t && !t.guesserIds.has(p.id) && p.id !== t.singerId),
      })),
    };
  }
  _broadcastState() { this.broadcast(this._stateMsg()); }

  _sendMine(p) {
    this.sendTo(p, {
      t: 'mine', max: p.id === this.fixedId ? 0 : this.settings.perPlayer, ready: p.ready,
      picks: p.picks.map((id) => ({ id, ...(this._labelOf(id) || { main: '?', sub: '' }) })),
    });
  }

  // ===== 挑歌階段 =====
  _search(conn, msg) {
    if (this.phase !== 'picking') return;
    this.send(conn, browseReply(msg, this.settings.categories, isVocal));
  }

  _unready(p) { if (p.ready) { p.ready = false; this._broadcastState(); } }

  _add(p, id) {
    if (this.phase !== 'picking' || typeof id !== 'string') return;
    if (p.id === this.fixedId) return this.sendTo(p, { t: 'pickError', msg: '你是固定歌手，由其他人挑歌給你唱' });
    const h = byId.get(id);
    if (!h || !this._allowed(h.cat) || p.picks.includes(id)) return;
    if (!isVocal(h.q)) return this.sendTo(p, { t: 'pickError', msg: '純音樂沒辦法空耳，請選有歌詞的歌' });
    if (p.picks.length >= this.settings.perPlayer) return this.sendTo(p, { t: 'pickError', msg: `最多只能選 ${this.settings.perPlayer} 首` });
    p.picks.push(id);
    this._unready(p);
    this._sendMine(p); this._broadcastState();
  }

  _remove(p, id) {
    if (this.phase !== 'picking') return;
    const i = p.picks.indexOf(id);
    if (i < 0) return;
    p.picks.splice(i, 1);
    this._unready(p);
    this._sendMine(p); this._broadcastState();
  }

  /** 隨機補滿到 perPlayer 首 */
  _fill(p) {
    if (this.phase !== 'picking' || p.id === this.fixedId) return;
    const have = new Set(p.picks);
    const cand = [];
    for (const c of this.settings.categories) for (const q of bank[c] || []) if (!have.has(q.id) && isVocal(q) && songLabel(q, c).main) cand.push(q.id);
    for (const id of shuffle(cand).slice(0, Math.max(0, this.settings.perPlayer - p.picks.length))) p.picks.push(id);
    this._unready(p);
    this._sendMine(p); this._broadcastState();
  }

  _ready(p, on) {
    if (this.phase !== 'picking' || p.id === this.fixedId) return;
    if (on && p.picks.length !== this.settings.perPlayer) return this.sendTo(p, { t: 'pickError', msg: `要先選滿 ${this.settings.perPlayer} 首（可按「隨機補滿」）` });
    p.ready = !!on;
    this._sendMine(p); this._broadcastState();
    this._checkAllReady();
  }

  _checkAllReady() {
    if (this.phase !== 'picking') return;
    if (this.fixedId && !this.seats.has(this.fixedId)) return; // 固定歌手離開了：不自動開始（房主可以回大廳重新指定）
    const act = [...this.seats.values()].filter((p) => this._active(p));
    if (act.length >= 2 && act.every((p) => p.ready)) this._begin(); // 固定歌手一開始就是 ready，只等其他人
  }

  /** 開始輪流：每位有歌的玩家當 rounds 次歌手（順序隨機、每圈重新洗牌） */
  _begin() {
    if (this.phase !== 'picking') return;
    const seats = [...this.seats.values()];
    // 全部人的歌混在一起（同一首歌被多人選只算一首，記下所有選它的人）
    const seen = new Map(); // labelKey → { id, label, owners:Set<playerId> }
    for (const p of seats) {
      for (const id of p.picks) {
        const l = this._labelOf(id);
        if (!l) continue;
        const k = labelKey(l);
        if (!seen.has(k)) seen.set(k, { id, label: l, owners: new Set() });
        seen.get(k).owners.add(p.id);
      }
    }
    if (seen.size === 0) return this.broadcast({ t: 'skipped', reason: '還沒有人選歌，無法開始' });
    this.pool = [...seen.values()].map((e, i) => ({ k: i, main: e.label.main, sub: e.label.sub }));
    this.poolIdx = new Map([...seen.keys()].map((k, i) => [k, i]));
    this.usedKeys = new Set();
    // 每回合從混合歌單抽一首：歌手不會抽到自己選的歌；盡量不重複（抽完才允許重複）
    const all = [...seen.values()];
    let used = new Set();
    this.turns = [];
    if (this.fixedId) {
      // 固定歌手：其他人挑的歌（去重後）隨機排序，全部給他唱
      if (!this.seats.has(this.fixedId)) return this.broadcast({ t: 'skipped', reason: '固定歌手不在房間裡，無法開始' });
      this.turns = shuffle(all).map((e) => ({ singerId: this.fixedId, songId: e.id }));
    }
    for (let r = 0; !this.fixedId && r < this.settings.rounds; r++) {
      for (const p of shuffle(seats)) {
        const mine = all.filter((e) => !e.owners.has(p.id));
        if (!mine.length) continue; // 全部的歌都是他自己選的（例如只有他一個人選歌）→ 這回合沒有歌可唱
        let fresh = mine.filter((e) => !used.has(e.id));
        if (!fresh.length) { used = new Set(); fresh = mine; }
        const e = fresh[Math.floor(Math.random() * fresh.length)];
        used.add(e.id);
        this.turns.push({ singerId: p.id, songId: e.id });
      }
    }
    if (!this.turns.length && this.fixedId) return this.broadcast({ t: 'skipped', reason: '還沒有人挑歌，無法開始' });
    if (!this.turns.length) return this.broadcast({ t: 'skipped', reason: '每位玩家選的歌都一樣，沒有別人的歌可以唱；請多選一些不同的歌' });
    this.ti = 0;
    this._beginTurn();
  }

  // ===== 回合 =====
  _beginTurn() {
    this.clearTimers();
    for (;;) {
      if (this.ti >= this.turns.length) return this._final();
      const t = this.turns[this.ti];
      const singer = this.seats.get(t.singerId);
      if (singer && this._active(singer) && byId.has(t.songId) && this._guessers(singer).length > 0) break;
      this.ti++;
    }
    const t = this.turns[this.ti];
    const singer = this.seats.get(t.singerId);
    const { q, cat } = byId.get(t.songId);
    const label = songLabel(q, cat);
    const correctPool = this.poolIdx.get(labelKey(label));
    const s = this.settings;
    let choices = null; let correctIdx = -1;
    if (s.answerMode === 'choice') {
      // 前面回合已經公布過的答案不再當干擾項（不然猜的人可以用刪去法）；正解本身不受影響
      const exclude = new Set([...this.usedKeys, labelKey(label)]);
      const others = shuffle(this.pool.filter((c) => c.k !== correctPool && !this.usedKeys.has(labelKey(c)))).slice(0, CHOICES - 1).map((c) => ({ main: c.main, sub: c.sub }));
      others.forEach((c) => exclude.add(labelKey(c)));
      for (let tries = 0; others.length < CHOICES - 1 && tries < 400; tries++) { // 題庫混合不夠 8 首：從所選題庫補干擾項
        const c = s.categories[Math.floor(Math.random() * s.categories.length)];
        const list = bank[c] || [];
        if (!list.length) continue;
        const cand = list[Math.floor(Math.random() * list.length)];
        if (!isVocal(cand)) continue;
        const l = songLabel(cand, c);
        if (!l.main || exclude.has(labelKey(l))) continue;
        exclude.add(labelKey(l)); others.push(l);
      }
      choices = shuffle([{ main: label.main, sub: label.sub, correct: true }, ...others]);
      correctIdx = choices.findIndex((c) => c.correct);
    }
    this.turn = {
      idx: this.ti + 1, singerId: t.singerId, songId: t.songId, q, cat, label, correctPool, choices, correctIdx,
      guesses: new Map(), guesserIds: new Set(this._guessers(singer).map((p) => p.id)),
      endsAt: null, startedAt: null, ytMsg: { t: 'song', idx: this.ti + 1, ytId: q.ytId, start: clipStart(q, s), duration: s.clipSecs },
    };
    this.phase = 'intro';
    this.turn.pubMsg = this._turnMsg();
    this.broadcast(this.turn.pubMsg);
    this.sendTo(singer, this.turn.ytMsg); // 只有歌手拿得到 ytId
    this._broadcastState();
    this.after('intro', this.T.preloadMs, () => this._startSing()); // 歌手沒回 ready 也照常開始
  }

  _guessers(singer) {
    return [...this.seats.values()].filter((p) => p.id !== singer.id && this._active(p));
  }

  /** 公開的回合訊息：不含 ytId、不含答案（選項不標正解） */
  _turnMsg() {
    const t = this.turn;
    return {
      t: 'turn', idx: t.idx, total: this.turns.length, singer: this._who(t.singerId), answerMode: this.settings.answerMode,
      singSecs: this.settings.singSecs,
      choices: t.choices ? t.choices.map(({ main, sub }) => ({ main, sub })) : null,
      // 搜尋模式的候選清單同理：已公布過的答案拿掉（保留原本的 k，猜的時候用 k 對照）
      pool: this.settings.answerMode === 'search' ? this.pool.filter((c) => c.k === t.correctPool || !this.usedKeys.has(labelKey(c))) : null,
    };
  }

  _singMsg() {
    const t = this.turn;
    return { t: 'sing', idx: t.idx, startAt: t.startedAt, endsAt: t.endsAt, serverNow: Date.now() };
  }

  _startSing() {
    if (this.phase !== 'intro') return;
    clearTimeout(this.timers.intro);
    const t = this.turn;
    // 倒數幾秒後原曲「自動」開播，只播一次、不能重播：歌手要即時跟上
    t.startedAt = Date.now() + (this.T.singCountdownMs ?? SING_COUNTDOWN_MS);
    t.endsAt = t.startedAt + this.settings.singSecs * 1000;
    this.phase = 'sing';
    this.broadcast(this._singMsg());
    this._broadcastState();
    this.after('sing', t.endsAt - Date.now(), () => this._reveal('time'));
  }

  _guess(p, msg) {
    const t = this.turn;
    if (this.phase !== 'sing' || !t || msg.idx !== t.idx || p.id === t.singerId || !t.guesserIds.has(p.id) || t.guesses.has(p.id)) return;
    let n; let correct;
    if (this.settings.answerMode === 'choice') {
      n = msg.choice;
      if (!Number.isInteger(n) || n < 0 || n >= t.choices.length) return;
      correct = n === t.correctIdx;
    } else {
      n = msg.pool;
      if (!Number.isInteger(n) || n < 0 || n >= this.pool.length) return;
      correct = n === t.correctPool;
    }
    t.guesses.set(p.id, { n, correct, at: Date.now() });
    this.sendTo(p, { t: 'you', idx: t.idx, n });
    this._broadcastState();
    this._checkAllGuessed();
  }

  _checkAllGuessed() {
    const t = this.turn;
    if (this.phase !== 'sing' || !t) return;
    const left = [...t.guesserIds].filter((id) => !t.guesses.has(id) && this._active(this.seats.get(id)));
    if (left.length === 0) this._reveal('all');
  }

  _guessLabel(t, g) {
    if (!g) return null;
    const c = this.settings.answerMode === 'choice' ? t.choices[g.n] : this.pool[g.n];
    return c ? { main: c.main, sub: c.sub } : null;
  }

  _reveal(reason) {
    if (this.phase !== 'sing' && this.phase !== 'intro') return;
    this.clearTimers();
    const t = this.turn;
    const s = this.settings;
    const winners = [...t.guesses.entries()].filter(([, g]) => g.correct).sort((a, b) => a[1].at - b[1].at);
    const startedAt = t.startedAt ?? Date.now();
    const total = (t.endsAt ?? startedAt) - startedAt || 1;
    const sc = scoreTurn({ correctCount: winners.length, remainingFrac: winners.length ? ((t.endsAt ?? startedAt) - winners[0][1].at) / total : 0 });
    const rows = [];
    for (const id of t.guesserIds) {
      const p = this.seats.get(id);
      if (!p) continue;
      const g = t.guesses.get(id) || null;
      const isFirst = winners.length > 0 && winners[0][0] === id;
      const points = g && g.correct ? (isFirst ? sc.first : sc.later) : 0;
      p.score += points;
      if (g && g.correct) { p.correct++; p.totalMs += Math.max(0, g.at - startedAt); }
      rows.push({ id, nick: p.nick, guess: this._guessLabel(t, g), correct: !!(g && g.correct), first: isFirst, points, total: p.score });
    }
    const singer = this.seats.get(t.singerId);
    if (singer) { singer.score += sc.singer; singer.sang++; }
    this.phase = 'reveal';
    this.usedKeys.add(labelKey(t.label)); // 這首已公布，之後的選項不會再出現它
    const last = this.ti + 1 >= this.turns.length;
    const a = t.q.answer || {};
    this.lastReveal = {
      t: 'reveal', idx: t.idx, total: this.turns.length, last, reason,
      singer: { ...this._who(t.singerId), points: sc.singer, total: singer ? singer.score : 0 },
      answer: { main: t.label.main, sub: t.label.sub, work: a.work || '', artist: a.artist || '' },
      // 揭曉後才公開影片：結果畫面嵌入預覽，起點與歌手聽到的一樣
      video: { ytId: t.q.ytId, start: Math.floor(t.ytMsg.start || 0) },
      correctCount: winners.length, rows, ranking: this._ranking(),
      nextAt: s.autoNext > 0 ? Date.now() + s.autoNext * 1000 : null, serverNow: Date.now(),
    };
    this.broadcast(this.lastReveal);
    this._broadcastState();
    if (s.autoNext > 0) this.after('next', s.autoNext * 1000, () => this._advance());
  }

  _advance(skip = false) {
    if (!skip && this.phase !== 'reveal') return;
    this.clearTimers();
    this.ti++;
    this._beginTurn();
  }

  /** 歌手斷線／離開、猜題者全走光：這回合作廢（不計分） */
  _abandonTurn(why) {
    if (this.phase !== 'intro' && this.phase !== 'sing') return;
    this.clearTimers();
    this.broadcast({ t: 'skipped', idx: this.turn.idx, reason: why });
    this._advance(true);
  }

  _ranking() {
    return rankPlayers([...this.seats.values()].map((p) => ({ id: p.id, nick: p.nick, score: p.score, correct: p.correct, answered: p.correct, sang: p.sang, totalMs: p.totalMs })));
  }

  _final() {
    this.clearTimers();
    this.phase = 'final';
    this.turn = null;
    this.lastFinal = { t: 'final', total: this.turns.length, ranking: this._ranking() };
    this.broadcast(this.lastFinal);
    this._broadcastState();
  }

  // ===== 成員變動 =====
  onJoin(member) {
    if (member.role !== 'player') return;
    const p = this.seat(member, freshSeat());
    this._broadcastState();
    if (this.phase === 'picking') this._sendMine(p);
  }
  onReconnect(member) {
    this._broadcastState();
    const p = this.seats.get(member.id);
    if (p && this.phase === 'picking') this._sendMine(p);
  }
  onDisconnect() { this._broadcastState(); this._checkAllReady(); this._checkAllGuessed(); }
  onLeave(member) {
    const t = this.turn;
    this.seats.delete(member.id);
    if (this.phase !== 'final' && this.seats.size < 2) return this._final();
    if (this.phase !== 'final' && this.phase !== 'picking' && member.id === this.fixedId) return this._final(); // 固定歌手走了，後面都沒人唱
    if (t && member.id === t.singerId) return this._abandonTurn('歌手離開了，略過這一回合');
    this._broadcastState();
    this._checkAllReady();
    this._checkAllGuessed();
  }

  /** 加入／重連：補目前狀態。ytId 只補給歌手本人 */
  snapshot(conn, member) {
    const t = this.turn;
    const p = member ? this.seats.get(member.id) : null;
    if (this.phase === 'picking' && p) this._sendMine(p);
    if (t && (this.phase === 'intro' || this.phase === 'sing')) {
      this.send(conn, t.pubMsg);
      if (member && member.id === t.singerId) this.send(conn, t.ytMsg);
      if (this.phase === 'sing') this.send(conn, this._singMsg());
      const g = p ? t.guesses.get(p.id) : null;
      if (g) this.send(conn, { t: 'you', idx: t.idx, n: g.n });
    }
    if (this.phase === 'reveal' && this.lastReveal) this.send(conn, this.lastReveal);
    if (this.phase === 'final' && this.lastFinal) this.send(conn, this.lastFinal);
  }

  handle(conn, msg) {
    const member = conn.player;
    if (!member) return;
    const p = this.seats.get(member.id);
    const host = this.isHost(member);
    if (p) {
      switch (msg.t) {
        case 'search': this._search(conn, msg); break;
        case 'add': this._add(p, msg.id); break;
        case 'remove': this._remove(p, msg.id); break;
        case 'fill': this._fill(p); break;
        case 'ready': if (this.phase === 'picking') this._ready(p, msg.on !== false); else if (this.phase === 'intro' && this.turn && p.id === this.turn.singerId && msg.idx === this.turn.idx) this._startSing(); break;
        case 'guess': this._guess(p, msg); break;
        case 'playError': if (this.turn && p.id === this.turn.singerId && msg.idx === this.turn.idx) this._abandonTurn('這首歌的影片在歌手的裝置無法播放，略過這一回合'); break;
        default: break;
      }
    }
    if (host) {
      switch (msg.t) {
        case 'begin': this._begin(); break;
        case 'next': if (this.phase === 'reveal') this._advance(); break;
        case 'skip': this._abandonTurn('房主跳過這一回合'); break;
        case 'forceReveal': if (this.phase === 'sing') this._reveal('host'); break;
        case 'end': if (this.phase !== 'final') this._final(); break;
        default: break;
      }
    }
  }

  tick() {
    const t = this.turn;
    if (t && (this.phase === 'intro' || this.phase === 'sing') && !this._active(this.seats.get(t.singerId))) this._abandonTurn('歌手離線太久，略過這一回合');
    else if (this.phase === 'sing') this._checkAllGuessed();
    else if (this.phase === 'picking') this._checkAllReady();
  }

  serialize() { return null; }
}
