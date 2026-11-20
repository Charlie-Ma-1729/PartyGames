// 訊息驗證、暱稱處理、設定夾限用的小工具（與遊戲無關；各遊戲自己的設定在 server/games/*.mjs）
export const MAX_PLAYERS = 20;

export const num = (v, lo, hi, d) => {
  const n = Math.round(Number(v));
  return Number.isFinite(n) ? Math.max(lo, Math.min(hi, n)) : d;
};
export const oneOf = (v, list, d) => (list.includes(v) ? v : d);
export const subset = (v, list, d) => {
  if (!Array.isArray(v)) return d;
  const out = [...new Set(v.filter((x) => list.includes(x)))];
  return out.length ? out : d;
};

/** 暱稱：去頭尾空白與控制字元、最長 12 字；空的回傳 null */
export function cleanNick(v) {
  if (typeof v !== 'string') return null;
  const s = v.replace(/[\u0000-\u001f\u007f<>]/g, '').replace(/\s+/g, ' ').trim();
  return s ? [...s].slice(0, 12).join('') : null;
}

/** 房間代碼字元（去掉 0O1I 等易混淆字） */
const CODE_CHARS = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';
export function randomCode() {
  let s = '';
  for (let i = 0; i < 4; i++) s += CODE_CHARS[Math.floor(Math.random() * CODE_CHARS.length)];
  return s;
}
export const normCode = (v) => (typeof v === 'string' ? v.toUpperCase().replace(/[^A-Z0-9]/g, '').slice(0, 4) : '');

export function cleanId(v) {
  return typeof v === 'string' && /^[A-Za-z0-9_-]{8,40}$/.test(v) ? v : null;
}

export function parseMsg(raw) {
  try {
    const m = JSON.parse(raw);
    return m && typeof m === 'object' && typeof m.t === 'string' ? m : null;
  } catch { return null; }
}

export function shuffle(arr) {
  const a = arr.slice();
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}
