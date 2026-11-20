// 合力塗鴉的共用規則：工具卡、墨水、繪圖操作的驗證與計價。
// 伺服器（server/games/coopdraw.mjs）用它當「裁判」，用戶端用同一份來預測（先畫在自己螢幕上、顯示墨水），所以只放純函式、不碰 DOM。
//
// 畫布是 800×600 的邏輯座標（整數）。繪圖操作（op）：
//   path   { k:'path', s:筆畫編號, pts:[[x,y]…], c:顏色, w:粗細, m?:1 左右對稱 }   自由手繪／橡皮擦（橡皮擦 = 白色粗線）
//          一筆畫會分成很多段（每段第一個點 = 上一段最後一個點），s 相同的段屬於同一筆
//   dot    { k:'dot', pts:[[x,y]…], c, w }
//   line   { k:'line', a:[x,y], b:[x,y], c, w }
//   circle { k:'circle', p:[x,y], r, f?:1 實心, c, w }
//   rect   { k:'rect', a:[x,y], b:[x,y], f?:1 實心, c, w }
//   stamp  { k:'stamp', p:[x,y], sh:'star'|'heart'|'tri'|'circle', sz, c }
export const W = 800;
export const H = 600;
export const BG = '#ffffff';
export const INK_MAX = 100;
export const INK_REGEN = 9; // 每秒恢復多少（約 11 秒回滿）
export const PALETTE = ['#111111', '#e63946', '#f4a261', '#ffd166', '#2a9d8f', '#4cc9f0', '#6a4c93', '#ff8fab', '#8d6e63'];
export const STAMPS = ['star', 'heart', 'tri', 'circle'];
export const STAMP_LABEL = { star: '⭐', heart: '❤️', tri: '🔺', circle: '⚪' };
export const PING_EMOJI = ['👉', '❌', '➕', '⭕', '👍'];

/**
 * 工具卡。color：black 黑色｜random 每回合隨機一色（由伺服器發）｜pick 自己從調色盤選｜erase 白色（橡皮擦）
 * support：輔助型（點點、印章、橡皮擦），人少的時候不發，免得整局畫不出東西
 */
export const CARDS = [
  { id: 'ruler', name: '直線尺', icon: '📏', desc: '只能畫直線：按住拖曳，放開就畫出來。黑色。', kind: 'line', color: 'black', width: 6, perPx: 0.09, base: 1.5 },
  { id: 'compass', name: '圓規', icon: '⭕', desc: '只能畫圓：從圓心拖曳決定大小。可選空心／實心、可選顏色。', kind: 'circle', color: 'pick', width: 6, perR: 0.12, fillMul: 2.5, base: 4, maxR: 170, canFill: true },
  { id: 'block', name: '方塊', icon: '🔲', desc: '只能畫方塊：對角拖曳。可選空心／實心，顏色是隨機發的。', kind: 'rect', color: 'random', width: 6, perPx: 0.05, areaPx: 0.0002, base: 4, canFill: true },
  { id: 'shortpen', name: '短筆', icon: '✏️', desc: '自由手繪，但一筆最多畫約 140 像素，要一小段一小段接起來。黑色。', kind: 'path', color: 'black', width: 6, perPx: 0.08, maxLen: 140 },
  { id: 'dots', name: '點點筆', icon: '⚫', desc: '只能點點（可以按住拖著點）。可選顏色。', kind: 'dot', color: 'pick', width: 14, perDot: 1.6, support: true },
  { id: 'fat', name: '大色塊', icon: '🖌️', desc: '超粗的筆刷，適合塗大面積。顏色是隨機發的。', kind: 'path', color: 'random', width: 34, perPx: 0.07 },
  { id: 'stamp', name: '印章', icon: '⭐', desc: '只能蓋章（星、愛心、三角、圓）。顏色是隨機發的。', kind: 'stamp', color: 'random', width: 0, size: 56, perStamp: 12, support: true },
  { id: 'mirror', name: '鏡像筆', icon: '🪞', desc: '自由手繪，畫的線會自動左右對稱複製一份。黑色。', kind: 'path', color: 'black', width: 6, perPx: 0.09, mirror: true },
  { id: 'eraser', name: '橡皮擦', icon: '🧽', desc: '只能擦：把別人畫歪的擦掉。', kind: 'path', color: 'erase', width: 40, perPx: 0.05, erase: true, support: true },
  { id: 'colorpen', name: '彩筆', icon: '🎨', desc: '細細的自由手繪線，顏色可選，但很耗墨水。', kind: 'path', color: 'pick', width: 4, perPx: 0.2 },
];
export const cardById = (id) => CARDS.find((c) => c.id === id) || null;

/** 目前的墨水量。st = {v: 上次記錄的量, t: 當時的時間(毫秒)} */
export function inkAt(st, now) {
  return Math.max(0, Math.min(INK_MAX, st.v + ((now - st.t) * INK_REGEN) / 1000));
}

const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));
const dist = (a, b) => Math.hypot(a[0] - b[0], a[1] - b[1]);
function pt(p) {
  if (!Array.isArray(p)) return null;
  const x = Number(p[0]); const y = Number(p[1]);
  if (!Number.isFinite(x) || !Number.isFinite(y)) return null;
  return [Math.round(clamp(x, 0, W)), Math.round(clamp(y, 0, H))];
}
const round1 = (n) => Math.round(n * 10) / 10;

/** 這張卡這一次畫用什麼顏色 */
export function colorOf(card, assigned, raw) {
  switch (card.color) {
    case 'black': return PALETTE[0];
    case 'erase': return BG;
    case 'random': return PALETTE.includes(assigned) ? assigned : PALETTE[1];
    default: { const i = Number(raw && raw.ci); return PALETTE[Number.isInteger(i) && i >= 0 && i < PALETTE.length ? i : 0]; }
  }
}

/**
 * 驗證並計價一個繪圖操作。
 * card 這位玩家的工具卡；assigned 伺服器發的隨機色；raw 用戶端送來的操作；ink 目前墨水；stroke 這位玩家上一筆的狀態 {s, len, last}
 * 回傳 { op, cost, stroke }：op 是整理過的操作（可能比 raw 短：自由手繪會在墨水用完／超過長度上限處截斷），null = 拒絕
 */
export function sanitizeOp(card, assigned, raw, ink, stroke = { s: null, len: 0, last: null }) {
  const none = { op: null, cost: 0, stroke };
  if (!card || !raw || typeof raw !== 'object') return none;
  const c = colorOf(card, assigned, raw);
  switch (card.kind) {
    case 'path': {
      if (raw.k !== 'path' || !Array.isArray(raw.pts)) return none;
      const s = Number.isInteger(raw.s) ? clamp(raw.s, 0, 1e9) : 0;
      const first = pt(raw.pts[0]);
      if (!first) return none;
      // 同一筆的後續段落必須從上一段結束的地方接著畫；接不上就當作新的一筆（不然可以拿「單點段落」在任何位置免費畫點）
      const isNew = stroke.s !== s || !stroke.last || stroke.last[0] !== first[0] || stroke.last[1] !== first[1];
      const st = { s, len: isNew ? 0 : stroke.len, last: null };
      let left = ink;
      let cost = 0;
      if (isNew) { // 開一筆新的要花一點墨水（不然連點一直蓋章就免費了）
        if (left < 1) return none;
        left -= 1; cost += 1;
      }
      const pts = [];
      for (const p0 of raw.pts.slice(0, 60)) {
        const p = pt(p0);
        if (!p) break;
        if (pts.length) {
          const d = dist(pts[pts.length - 1], p);
          const cc = d * card.perPx;
          if (card.maxLen && st.len + d > card.maxLen) break;
          if (cc > left) break;
          left -= cc; cost += cc; st.len += d;
        }
        pts.push(p);
      }
      if (!pts.length || (!isNew && pts.length < 2)) return none;
      st.last = pts[pts.length - 1];
      const op = { k: 'path', s, pts, c, w: card.width };
      if (card.mirror) op.m = 1;
      return { op, cost, stroke: st };
    }
    case 'dot': {
      if (raw.k !== 'dot' || !Array.isArray(raw.pts)) return none;
      const pts = [];
      let left = ink;
      for (const p0 of raw.pts.slice(0, 20)) {
        const p = pt(p0);
        if (!p || left < card.perDot) break;
        left -= card.perDot;
        pts.push(p);
      }
      if (!pts.length) return none;
      return { op: { k: 'dot', pts, c, w: card.width }, cost: pts.length * card.perDot, stroke };
    }
    case 'line': {
      if (raw.k !== 'line') return none;
      const a = pt(raw.a); const b = pt(raw.b);
      if (!a || !b) return none;
      const d = dist(a, b);
      if (d < 4) return none;
      const cost = card.base + d * card.perPx;
      if (cost > ink) return none;
      return { op: { k: 'line', a, b, c, w: card.width }, cost, stroke };
    }
    case 'circle': {
      if (raw.k !== 'circle') return none;
      const p = pt(raw.p);
      const r = Math.round(Number(raw.r));
      if (!p || !Number.isFinite(r)) return none;
      const rr = clamp(r, 4, card.maxR);
      const f = card.canFill && raw.f ? 1 : 0;
      const cost = card.base + rr * card.perR * (f ? card.fillMul : 1);
      if (cost > ink) return none;
      const op = { k: 'circle', p, r: rr, c, w: card.width };
      if (f) op.f = 1;
      return { op, cost, stroke };
    }
    case 'rect': {
      if (raw.k !== 'rect') return none;
      const a = pt(raw.a); const b = pt(raw.b);
      if (!a || !b) return none;
      const w = Math.abs(a[0] - b[0]); const h = Math.abs(a[1] - b[1]);
      if (w < 4 || h < 4) return none;
      const f = card.canFill && raw.f ? 1 : 0;
      const cost = card.base + (w + h) * card.perPx + (f ? w * h * card.areaPx : 0);
      if (cost > ink) return none;
      const op = { k: 'rect', a, b, c, w: card.width };
      if (f) op.f = 1;
      return { op, cost, stroke };
    }
    case 'stamp': {
      if (raw.k !== 'stamp') return none;
      const p = pt(raw.p);
      if (!p) return none;
      const cost = card.perStamp;
      if (cost > ink) return none;
      return { op: { k: 'stamp', p, sh: STAMPS.includes(raw.sh) ? raw.sh : 'star', sz: card.size, c }, cost, stroke };
    }
    default: return none;
  }
}

export { round1 };
