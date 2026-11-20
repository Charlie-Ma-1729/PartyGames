// 伺服器端題庫：啟動時讀 data/*.json，收到 SIGHUP 時重新載入
import { readFileSync, existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { CATEGORIES, SONG_CATS, choiceOf } from '../js/questions.js';
import { applyToBank } from './songstats.mjs';

export const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
export { CATEGORIES };

/** { [catId]: Question[] } */
export let bank = {};
/** { [catId]: { [ask]: {k, main, sub}[] } }：打字搜尋用的候選清單。一般題庫 ask = 'work'；J-POP 有 'title'（歌名）與 'artist'（歌手）兩份 */
export let works = {};

/** 題目編號 → { q, cat }（出題者／空耳選歌用） */
export let byId = new Map();
/** 搜尋用索引：{ q, cat, hay（小寫的歌名＋歌手＋作品） }[] */
let index = [];

const norm = (s) => String(s || '').normalize('NFKC').toLowerCase();

/** 這首歌「作為一首歌」的顯示標籤：歌名＋歌手（動漫題庫另帶作品名） */
export function songLabel(q, cat) {
  const a = q.answer || {};
  if (SONG_CATS.includes(cat)) return { main: a.title || '', sub: a.artist || '' };
  const work = String(a.work || '').replace(/（.*$/, '').trim();
  const title = a.title || '';
  return { main: title || work, sub: [title ? work : '', a.artist].filter(Boolean).join('・') };
}

/** 有人聲的歌（純音樂 OST 不算）：空耳歌王要唱的，必須是有歌詞可以空耳的歌 */
export const isVocal = (q) => q.kind !== 'OST';

/**
 * 選歌清單的瀏覽／搜尋（分頁）。q 空白 = 不篩關鍵字（直接逐頁瀏覽）；cat 空白 = 全部（受 cats 限制）。
 * 回傳 { list: {id,cat,main,sub}[], total }；total 是符合條件的總數，客戶端靠它判斷還有沒有下一頁。
 */
export function browseBank({ q = '', cat = '', cats = [], offset = 0, limit = 40, accept = null } = {}) {
  const toks = norm(q).split(/\s+/).filter(Boolean).slice(0, 5);
  const allow = Array.isArray(cats) && cats.length ? new Set(cats) : null;
  const list = [];
  let total = 0;
  for (const e of index) {
    if (allow && !allow.has(e.cat)) continue;
    if (cat && e.cat !== cat) continue;
    if (accept && !accept(e.q, e.cat)) continue;
    if (toks.length && !toks.every((t) => e.hay.includes(t))) continue;
    const label = songLabel(e.q, e.cat);
    if (!label.main) continue;
    if (total >= offset && list.length < limit) list.push({ id: e.q.id, cat: e.cat, ...label });
    total++;
  }
  return { list, total };
}

/** 把客戶端的 search 訊息 { q, cat, offset } 夾值後查詢，回傳 results 訊息（q／cat／offset 原樣帶回，客戶端用來丟掉過期的回應） */
export function browseReply(msg, cats, accept = null, limit = 40) {
  const q = typeof msg.q === 'string' ? msg.q.slice(0, 40) : '';
  const cat = typeof msg.cat === 'string' && cats.includes(msg.cat) ? msg.cat : '';
  const offset = Number.isInteger(msg.offset) ? Math.max(0, Math.min(msg.offset, 100000)) : 0;
  return { t: 'results', q, cat, offset, ...browseBank({ q, cat, cats, offset, limit, accept }) };
}

/** 答案的唯一鍵：J-POP 猜歌名用 t:歌名、猜歌手用 a:歌手；其他題庫用 workId */
export function keyOf(q, cat, ask = 'work') {
  if (SONG_CATS.includes(cat)) return ask === 'artist' ? `a:${q.answer?.artist || ''}` : `t:${q.answer?.title || ''}`;
  return q.workId;
}

export function loadBank() {
  const nb = {};
  const nw = {};
  for (const c of CATEGORIES) {
    const file = path.join(ROOT, c.file);
    let list = [];
    try { if (existsSync(file)) list = JSON.parse(readFileSync(file, 'utf8')); } catch (e) { console.error('讀取題庫失敗', c.file, e.message); }
    nb[c.id] = list.filter((q) => !q.disabled);
    nw[c.id] = {};
    for (const ask of SONG_CATS.includes(c.id) ? ['title', 'artist'] : ['work']) {
      const seen = new Map();
      for (const q of nb[c.id]) {
        const k = keyOf(q, c.id, ask);
        if (!k || seen.has(k)) continue;
        const ch = choiceOf(q, c.id, ask);
        seen.set(k, { k, main: ch.main, sub: ch.sub });
      }
      nw[c.id][ask] = [...seen.values()];
    }
  }
  bank = nb;
  works = nw;
  byId = new Map();
  index = [];
  for (const c of CATEGORIES) {
    for (const q of nb[c.id]) {
      byId.set(q.id, { q, cat: c.id });
      const a = q.answer || {};
      index.push({ q, cat: c.id, hay: norm([a.title, a.artist, a.artistEn, a.work].filter(Boolean).join(' ')) });
    }
  }
  applyToBank(nb); // 把累積的玩家統計（動態難度）套回重新載入的題目
  const n = Object.values(nb).reduce((s, a) => s + a.length, 0);
  console.log(`題庫載入：${CATEGORIES.map((c) => `${c.id} ${nb[c.id].length}`).join('、')}（共 ${n} 題）`);
}

loadBank();
process.on('SIGHUP', () => { try { loadBank(); } catch (e) { console.error(e); } });
