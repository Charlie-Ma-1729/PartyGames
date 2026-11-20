// 配音大師：每一關大家各自對著同一部影片配音（錄音上傳），再一個一個播出來互相評分（搞笑、配音優異），
// 全部結束後用 ffmpeg 把影片和配音合成成品，頒獎並可下載。
//
// 階段：record（練習＋錄音）→ exhibit（輪流播放、評分）→ (下一關 record …) → processing（合成）→ results
// 錄音檔走 HTTP 上傳（server/media.mjs），完成後再用 WebSocket 通知「我交卷了」。
import { MAX_PLAYERS, num, shuffle } from '../protocol.mjs';
import { audioExists, audioPath, isVideoPath, mergeAudioVideo, outputPath, videoExists, videoPath } from '../media.mjs';
import { GameBase } from './base.mjs';

const DEFAULTS = { videos: [], timeLimit: 5 };
const MAX_VIDEOS = 40;
const UPLOAD_GRACE_MS = 30 * 1000; // 每關限時結束後，再給上傳錄音的時間
const EXHIBIT_MAX_MS = 10 * 60 * 1000; // 一個作品的評分等待上限（防止有人睡著卡住大家）

const avg3 = (sum, n) => (n > 0 ? Number((sum / n).toFixed(3)) : 0);

export class DubbingGame extends GameBase {
  static meta = {
    id: 'dubbing', name: '配音大師', icon: '🎙️', min: 1, max: MAX_PLAYERS, roles: ['player'],
    desc: '每人對著同一段影片用麥克風配音，再輪流播放、互相評分「搞笑」與「配音優異」，最後合成成品可下載！（需要麥克風）',
  };
  static defaults = DEFAULTS;
  static clean(input, prev = DEFAULTS) {
    const s = input && typeof input === 'object' ? input : {};
    let videos = prev.videos;
    if (Array.isArray(s.videos)) videos = [...new Set(s.videos.filter((v) => typeof v === 'string' && isVideoPath(v)))].slice(0, MAX_VIDEOS);
    return { videos, timeLimit: num(s.timeLimit ?? prev.timeLimit, 1, 15, prev.timeLimit) };
  }
  static info() { return {}; }
  static restore() { return null; } // 錄音與合成進行到一半，重啟後直接回大廳

  constructor(hub, settings) {
    super(hub, settings);
    this.phase = 'record';
    this.videos = [];
    this.idx = 0;
    this.votes = []; // {target, voter, idx, funny, acting}
    this.names = new Map(); // 玩家離開後結算還要用到暱稱
    this.queue = [];
    this.exhIdx = 0;
    this.exh = null;
    this.roundMsg = null;
    this.exhibitMsg = null;
    this.lastResults = null;
    this.destroyed = false;
  }

  check() {
    const s = this.settings;
    if (!s.videos.length) return { code: 'NO_VIDEO', msg: '至少要勾選一部影片' };
    const missing = s.videos.find((v) => !videoExists(v));
    if (missing) return { code: 'NO_VIDEO', msg: `找不到影片檔：${missing}` };
    return null;
  }

  start() {
    this.videos = [...this.settings.videos];
    for (const m of this.hub.players.values()) this._addSeat(m, false);
    this.idx = 0;
    this._beginRecord();
  }

  _addSeat(m, spectator) {
    this.names.set(m.id, m.nick);
    return this.seat(m, { finished: false, files: {}, voted: false, spectator });
  }

  canJoin() { return '配音遊戲已經開始，無法中途加入'; }

  _isActive(s) { return !s.spectator && (s.connected || Date.now() - s.lastSeen <= this.T.staleMs); }
  _active() { return [...this.seats.values()].filter((s) => this._isActive(s)); }
  _who(id) { return { id, nick: this.names.get(id) || '（已離開）' }; }

  // ===== 錄音階段 =====
  _beginRecord() {
    this.clearTimers();
    this.phase = 'record';
    for (const s of this.seats.values()) { s.finished = false; s.voted = false; this.names.set(s.id, s.nick); }
    const ms = this.settings.timeLimit * 60 * 1000 + UPLOAD_GRACE_MS;
    this.roundMsg = { t: 'round', idx: this.idx, total: this.videos.length, video: this.videos[this.idx], timeLimit: this.settings.timeLimit, endsAt: Date.now() + ms, serverNow: Date.now() };
    this.broadcast(this.roundMsg);
    this._broadcastProgress();
    this.after('record', ms, () => this._endRecord());
  }

  _progress() {
    const act = this._active();
    return { t: 'progress', finished: act.filter((s) => s.finished).length, total: act.length, done: [...this.seats.values()].filter((s) => s.finished).map((s) => s.id) };
  }
  _broadcastProgress() { this.broadcast(this._progress()); }

  /** 用戶端上傳錄音前先問：這個人現在能不能上傳 */
  uploadTarget(pid, idx, ext) {
    const s = this.seats.get(pid);
    if (this.phase !== 'record' || idx !== this.idx || !s || s.spectator) return { error: '現在不能上傳（這一關已經結束）' };
    if (s.finished) return { error: '你已經交卷了' };
    return { file: `${this.hub.code}_${pid}_${idx}${ext}` };
  }
  uploadDone(pid, idx, file) {
    const s = this.seats.get(pid);
    if (s && idx === this.idx) s.files[idx] = file;
  }

  _finish(s, hasRecord) {
    if (this.phase !== 'record' || s.finished) return;
    const file = s.files[this.idx];
    if (!hasRecord || !file || !audioExists(file)) delete s.files[this.idx];
    s.finished = true;
    this._broadcastProgress();
    this._checkRecord();
  }

  _checkRecord() {
    if (this.phase !== 'record') return;
    const act = this._active();
    if (act.length > 0 && act.every((s) => s.finished)) this._endRecord();
  }

  _endRecord() {
    if (this.phase !== 'record') return;
    this.clearTimers();
    for (const s of this.seats.values()) s.finished = true; // 逾時沒交卷的人，這關沒有作品
    this.queue = shuffle([...this.seats.values()].filter((s) => !s.spectator && s.files[this.idx]).map((s) => s.id));
    this.exhIdx = 0;
    if (this.queue.length === 0) return this._nextVideo(); // 這關沒人交作品，直接換關
    this._showExhibit();
  }

  // ===== 播放與評分階段 =====
  _showExhibit() {
    this.clearTimers();
    while (this.exhIdx < this.queue.length && !this.seats.has(this.queue[this.exhIdx])) this.exhIdx++; // 作者中途離開的作品跳過
    if (this.exhIdx >= this.queue.length) return this._nextVideo();
    const target = this.queue[this.exhIdx];
    const act = this._active();
    let voters = act.filter((s) => s.id !== target);
    if (voters.length === 0) voters = act; // 只有一個人在線（單人試玩）：允許自己評分
    this.phase = 'exhibit';
    for (const s of this.seats.values()) s.voted = false;
    this.exh = { target, voters: voters.map((s) => s.id) };
    const file = this.seats.get(target).files[this.idx];
    this.exhibitMsg = {
      t: 'exhibit', idx: this.idx, k: this.exhIdx + 1, n: this.queue.length, target: this._who(target),
      video: this.videos[this.idx], audio: file, voters: this.exh.voters,
    };
    this.broadcast(this.exhibitMsg);
    this._broadcastVotes();
    this.after('exhibit', EXHIBIT_MAX_MS, () => this._finishExhibit());
  }

  _votes() {
    const voters = this.exh ? this.exh.voters.map((id) => this.seats.get(id)).filter((s) => s && this._isActive(s)) : [];
    return { t: 'votes', voted: voters.filter((s) => s.voted).length, total: voters.length };
  }
  _broadcastVotes() { this.broadcast(this._votes()); }

  _vote(s, msg) {
    const e = this.exh;
    if (this.phase !== 'exhibit' || !e || msg.idx !== this.idx || msg.target !== e.target || s.voted || !e.voters.includes(s.id)) return;
    const funny = Math.round(Number(msg.funny));
    const acting = Math.round(Number(msg.acting));
    if (!(funny >= 1 && funny <= 5 && acting >= 1 && acting <= 5)) return;
    s.voted = true;
    this.votes.push({ target: e.target, voter: s.id, idx: this.idx, funny, acting });
    this._broadcastVotes();
    this._checkVotes();
  }

  _checkVotes() {
    if (this.phase !== 'exhibit') return;
    const v = this._votes();
    if (v.voted >= v.total) this._finishExhibit(); // total = 0 代表評分的人都離線了，也直接往下
  }

  _finishExhibit() {
    if (this.phase !== 'exhibit') return;
    this.exhIdx++;
    if (this.exhIdx < this.queue.length) this._showExhibit(); else this._nextVideo();
  }

  _nextVideo() {
    this.idx++;
    if (this.idx < this.videos.length) this._beginRecord(); else this._finishGame();
  }

  // ===== 結算與合成 =====
  _calcResults() {
    const rows = [];
    const per = new Map(); // 玩家 → 各關平均的累計
    const seen = [...this.seats.values()].filter((s) => !s.spectator);
    for (const s of seen) per.set(s.id, { name: this.names.get(s.id) || s.nick, funny: 0, acting: 0, n: 0 });
    for (const s of seen) {
      for (let v = 0; v < this.videos.length; v++) {
        const vs = this.votes.filter((x) => x.target === s.id && x.idx === v);
        const funnyAvg = avg3(vs.reduce((a, x) => a + x.funny, 0), vs.length);
        const actingAvg = avg3(vs.reduce((a, x) => a + x.acting, 0), vs.length);
        const file = s.files[v];
        const outFile = `${this.hub.code}_${s.id}_${v}.mp4`;
        rows.push({
          targetId: s.id, vIndex: v, playerName: this.names.get(s.id) || s.nick, videoName: this.videos[v], hasRecord: !!file,
          funnyAvg, actingAvg, totalScore: Number((funnyAvg + actingAvg).toFixed(3)), audio: file || null, outFile, merged: false,
        });
        const p = per.get(s.id); p.funny += funnyAvg; p.acting += actingAvg; p.n++; // 沒作品的關卡以 0 分計
      }
    }
    const best = (key) => rows.filter((r) => r.hasRecord).reduce((b, r) => (!b || r[key] > b[key] ? r : b), null);
    const playerRanking = [...per.values()].map((p) => {
      const f = p.n ? p.funny / p.n : 0; const a = p.n ? p.acting / p.n : 0;
      return { name: p.name, avgFunny: Number(f.toFixed(3)), avgActing: Number(a.toFixed(3)), totalScore: Number((f + a).toFixed(3)) };
    }).sort((x, y) => y.totalScore - x.totalScore);
    return { rows, topFunny: best('funnyAvg'), topActing: best('actingAvg'), playerRanking };
  }

  async _finishGame() {
    this.clearTimers();
    this.phase = 'processing';
    this.broadcast({ t: 'processing' });
    const res = this._calcResults();
    // 逐一合成；ffmpeg 沒裝或某個檔案壞掉只影響那一份（前端會退回「影片＋錄音同步播放」）
    for (const r of res.rows) {
      if (!r.hasRecord || this.destroyed) continue;
      const video = videoPath(r.videoName);
      const audio = audioPath(r.audio);
      const out = outputPath(r.outFile);
      if (!video || !audio || !out) continue;
      try { await mergeAudioVideo(video, audio, out); r.merged = true; } catch (e) { console.error(`[配音] 合成失敗 ${r.outFile}：${e.message}`); }
    }
    if (this.destroyed) return;
    this.phase = 'results';
    this.lastResults = { t: 'results', ...res, mergeOk: res.rows.filter((r) => r.hasRecord).every((r) => r.merged) };
    this.broadcast(this.lastResults);
  }

  // ===== 訊息與成員 =====
  snapshot(conn, member) {
    const s = member ? this.seats.get(member.id) : null;
    if (this.phase === 'record') {
      this.send(conn, this.roundMsg);
      this.send(conn, this._progress());
      if (s) this.send(conn, { t: 'you', idx: this.idx, finished: s.finished, uploaded: !!s.files[this.idx] });
    } else if (this.phase === 'exhibit') {
      this.send(conn, this.exhibitMsg);
      this.send(conn, this._votes());
      if (s) this.send(conn, { t: 'you', idx: this.idx, voted: s.voted });
    } else if (this.phase === 'processing') this.send(conn, { t: 'processing' });
    else if (this.phase === 'results' && this.lastResults) this.send(conn, this.lastResults);
  }

  handle(conn, msg) {
    const s = this.seatOf(conn);
    if (!s || s.spectator) return;
    switch (msg.t) {
      case 'finished': if (msg.idx === this.idx) this._finish(s, !!msg.hasRecord); break;
      case 'vote': this._vote(s, msg); break;
      case 'skipWait':
        if (!this.isHost(s)) break;
        if (this.phase === 'record') this._endRecord(); else if (this.phase === 'exhibit') this._finishExhibit();
        break;
      default: break;
    }
  }

  onReconnect() { if (this.phase === 'record') this._broadcastProgress(); }
  onDisconnect() { this._broadcastProgress(); this._broadcastVotes(); this._checkRecord(); this._checkVotes(); }
  onLeave(member) {
    this.seats.delete(member.id);
    this._broadcastProgress();
    if (this.phase === 'exhibit') { this._broadcastVotes(); if (this.exh && this.exh.target === member.id) this._finishExhibit(); else this._checkVotes(); }
    this._checkRecord();
  }
  tick() { this._checkRecord(); this._checkVotes(); }

  destroy() { this.destroyed = true; this.clearTimers(); }
}
