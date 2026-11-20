// 合力塗鴉的畫布：把繪圖操作畫出來（Board），以及把手指／滑鼠的動作變成繪圖操作（Input）。
import { W, H, BG, STAMPS, sanitizeOp, colorOf } from './rules.js';

const SCALE = 2; // 內部解析度 = 邏輯座標的 2 倍，手機上線條比較銳利

export class Board {
  constructor(canvas, { alpha = 1, transparent = false } = {}) {
    this.cv = canvas;
    canvas.width = W * SCALE;
    canvas.height = H * SCALE;
    this.ctx = canvas.getContext('2d');
    this.alpha = alpha;
    this.transparent = transparent;
    this.clear();
  }

  clear() {
    const c = this.ctx;
    c.setTransform(1, 0, 0, 1, 0, 0);
    c.clearRect(0, 0, this.cv.width, this.cv.height);
    c.setTransform(SCALE, 0, 0, SCALE, 0, 0);
    if (!this.transparent) { c.fillStyle = BG; c.fillRect(0, 0, W, H); }
  }

  drawOps(ops) { for (const op of ops) this.drawOp(op); }

  drawOp(op) {
    const c = this.ctx;
    c.save();
    c.globalAlpha = this.alpha;
    c.lineCap = 'round'; c.lineJoin = 'round';
    c.strokeStyle = op.c; c.fillStyle = op.c; c.lineWidth = op.w || 6;
    switch (op.k) {
      case 'path':
        this._poly(op.pts, op.w);
        if (op.m) this._poly(op.pts.map(([x, y]) => [W - x, y]), op.w);
        break;
      case 'dot':
        for (const [x, y] of op.pts) { c.beginPath(); c.arc(x, y, op.w / 2, 0, Math.PI * 2); c.fill(); }
        break;
      case 'line':
        c.beginPath(); c.moveTo(op.a[0], op.a[1]); c.lineTo(op.b[0], op.b[1]); c.stroke();
        break;
      case 'circle':
        c.beginPath(); c.arc(op.p[0], op.p[1], op.r, 0, Math.PI * 2);
        if (op.f) c.fill(); else c.stroke();
        break;
      case 'rect': {
        const x = Math.min(op.a[0], op.b[0]); const y = Math.min(op.a[1], op.b[1]);
        const w = Math.abs(op.a[0] - op.b[0]); const h = Math.abs(op.a[1] - op.b[1]);
        if (op.f) c.fillRect(x, y, w, h); else c.strokeRect(x, y, w, h);
        break;
      }
      case 'stamp': this._stamp(op); break;
      default: break;
    }
    c.restore();
  }

  _poly(pts, w) {
    const c = this.ctx;
    if (pts.length === 1) { c.beginPath(); c.arc(pts[0][0], pts[0][1], w / 2, 0, Math.PI * 2); c.fill(); return; }
    c.beginPath();
    c.moveTo(pts[0][0], pts[0][1]);
    for (let i = 1; i < pts.length; i++) c.lineTo(pts[i][0], pts[i][1]);
    c.stroke();
  }

  _stamp({ p: [x, y], sh, sz }) {
    const c = this.ctx;
    const r = sz / 2;
    c.beginPath();
    if (sh === 'circle') c.arc(x, y, r, 0, Math.PI * 2);
    else if (sh === 'tri') { c.moveTo(x, y - r); c.lineTo(x + r, y + r * 0.8); c.lineTo(x - r, y + r * 0.8); c.closePath(); }
    else if (sh === 'heart') {
      c.moveTo(x, y + r * 0.9);
      c.bezierCurveTo(x - r * 1.5, y - r * 0.2, x - r * 0.6, y - r * 1.2, x, y - r * 0.4);
      c.bezierCurveTo(x + r * 0.6, y - r * 1.2, x + r * 1.5, y - r * 0.2, x, y + r * 0.9);
      c.closePath();
    } else { // star
      for (let i = 0; i < 10; i++) {
        const a = -Math.PI / 2 + (i * Math.PI) / 5;
        const rr = i % 2 ? r * 0.45 : r;
        if (i) c.lineTo(x + Math.cos(a) * rr, y + Math.sin(a) * rr); else c.moveTo(x + Math.cos(a) * rr, y + Math.sin(a) * rr);
      }
      c.closePath();
    }
    c.fill();
  }
}

const dist = (a, b) => Math.hypot(a[0] - b[0], a[1] - b[1]);
const FLUSH_MS = 70; // 自由手繪每隔多久把新的點打包送出（伺服器每條連線每秒最多收 60 則訊息）

/**
 * 輸入：在 overlay 畫布上接 pointer 事件。host 由 index.js 提供：
 *   canDraw() 現在能不能畫    card() 我的工具卡    assigned() 伺服器發的隨機色    mode() 'draw' | 'ping'
 *   opts() { ci, f, sh }     顏色／實心／印章形狀
 *   ink() 目前墨水    spend(cost) 扣墨水（本地預測）    flash() 墨水不足提示
 *   send(ops[]) 送出操作    ping(x, y)    board 自己的畫布    over 預覽用的 Board    preview(cost|null) 顯示預計花費
 */
export class Input {
  constructor(el, host) {
    this.el = el; this.h = host;
    this.cur = null;
    this.strokeId = 0;
    this.timer = null;
    el.addEventListener('pointerdown', (e) => this.down(e));
    el.addEventListener('pointermove', (e) => this.move(e));
    el.addEventListener('pointerup', (e) => this.up(e));
    el.addEventListener('pointercancel', (e) => this.up(e, true));
  }

  resetStrokes() { this.strokeId = 0; this.cancel(); }

  point(e) {
    const r = this.el.getBoundingClientRect();
    return [Math.round(Math.max(0, Math.min(W, ((e.clientX - r.left) / r.width) * W))), Math.round(Math.max(0, Math.min(H, ((e.clientY - r.top) / r.height) * H)))];
  }

  cancel() {
    clearInterval(this.timer); this.timer = null;
    this.cur = null;
    this.h.over.clear();
    this.h.preview(null);
  }

  down(e) {
    const h = this.h;
    if (e.button > 0) return;
    const p = this.point(e);
    if (h.mode() === 'ping') { e.preventDefault(); h.ping(p[0], p[1]); return; }
    if (!h.canDraw()) return;
    const card = h.card();
    if (!card) return;
    e.preventDefault();
    try { this.el.setPointerCapture(e.pointerId); } catch { /* ignore */ }
    const color = colorOf(card, h.assigned(), { ci: h.opts().ci });
    this.cur = { kind: card.kind, start: p, last: p, color, card };
    if (card.kind === 'path') {
      if (h.ink() < 1) { this.cur = null; h.flash(); return; }
      h.spend(1);
      Object.assign(this.cur, { s: ++this.strokeId, pts: [p], len: 0, fresh: true, dead: false });
      h.board.drawOp(this._pathOp([p]));
      this.timer = setInterval(() => this.flush(), FLUSH_MS);
    } else if (card.kind === 'dot') {
      this.cur.pts = [];
      this._dot(p);
      this.timer = setInterval(() => this.flush(), FLUSH_MS);
    } else this._preview(p);
  }

  move(e) {
    const c = this.cur;
    if (!c) return;
    const evs = typeof e.getCoalescedEvents === 'function' ? e.getCoalescedEvents() : [];
    for (const ev of evs.length ? evs : [e]) {
      const p = this.point(ev);
      if (c.kind === 'path') this._pathTo(p);
      else if (c.kind === 'dot') { if (dist(c.last, p) >= c.card.width * 0.8) this._dot(p); } else this._preview(p);
    }
  }

  up(e, cancelled = false) {
    const c = this.cur;
    if (!c) return;
    const h = this.h;
    if (c.kind === 'path' || c.kind === 'dot') { this.flush(); this.cancel(); return; }
    const p = cancelled ? c.last : this.point(e);
    const raw = this._shape(c, p);
    this.cancel();
    if (cancelled) return;
    const r = sanitizeOp(c.card, h.assigned(), raw, h.ink());
    if (!r.op) { h.flash(); return; }
    h.spend(r.cost);
    h.board.drawOp(r.op);
    h.send([raw]);
  }

  // ----- 自由手繪 -----
  _pathOp(pts) {
    const { card, color } = this.cur;
    const op = { k: 'path', pts, c: color, w: card.width };
    if (card.mirror) op.m = 1;
    return op;
  }

  _pathTo(p) {
    const c = this.cur; const h = this.h;
    if (c.dead) return;
    const d = dist(c.last, p);
    if (d < 2) return;
    const cost = d * c.card.perPx;
    if (cost > h.ink() || (c.card.maxLen && c.len + d > c.card.maxLen)) { c.dead = true; h.flash(); return; }
    h.spend(cost);
    c.len += d;
    h.board.drawOp(this._pathOp([c.last, p]));
    c.pts.push(p);
    c.last = p;
  }

  _dot(p) {
    const c = this.cur; const h = this.h;
    if (h.ink() < c.card.perDot) { h.flash(); return; }
    h.spend(c.card.perDot);
    h.board.drawOp({ k: 'dot', pts: [p], c: c.color, w: c.card.width });
    c.pts.push(p);
    c.last = p;
  }

  flush() {
    const c = this.cur;
    if (!c) return;
    if (c.kind === 'dot') {
      if (!c.pts.length) return;
      const ops = [];
      for (let i = 0; i < c.pts.length; i += 20) ops.push({ k: 'dot', pts: c.pts.slice(i, i + 20), ci: this.h.opts().ci });
      c.pts = [];
      this.h.send(ops);
      return;
    }
    if (!c.fresh && c.pts.length < 2) return;
    const ops = [];
    for (let i = 0; i < c.pts.length; i += 59) { // 每段 ≤ 60 點；段與段重疊一個點
      const part = c.pts.slice(i, i + 60);
      ops.push({ k: 'path', s: c.s, pts: part, ci: this.h.opts().ci });
    }
    c.pts = [c.pts[c.pts.length - 1]];
    c.fresh = false;
    this.h.send(ops);
  }

  // ----- 形狀（直線／圓／方塊／印章）-----
  _shape(c, p) {
    const o = this.h.opts();
    switch (c.kind) {
      case 'line': return { k: 'line', a: c.start, b: p, ci: o.ci };
      case 'circle': return { k: 'circle', p: c.start, r: dist(c.start, p), f: o.f ? 1 : 0, ci: o.ci };
      case 'rect': return { k: 'rect', a: c.start, b: p, f: o.f ? 1 : 0, ci: o.ci };
      default: return { k: 'stamp', p, sh: STAMPS.includes(o.sh) ? o.sh : 'star', ci: o.ci };
    }
  }

  _preview(p) {
    const c = this.cur; const h = this.h;
    c.last = p;
    const raw = this._shape(c, p);
    const r = sanitizeOp(c.card, h.assigned(), raw, 1e9); // 預覽不管墨水夠不夠，只看要花多少
    h.over.clear();
    if (r.op) { h.over.drawOp(r.op); h.preview(r.cost); } else h.preview(null);
  }
}
