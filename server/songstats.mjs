// 猜歌動態難度：每首歌一個難度分（1~1000，越小越簡單），每回合結束後依「多少人猜對、猜多快」微調。
// 預設分（由題庫原 difficulty 轉成）相當於 prior：樣本少時分數幾乎不動，一次秒答不會讓冷門歌跳到簡單區。
// 套用方式是「執行時覆蓋」：把算出來的分區寫進 q.difficulty（原值留在 q.baseDifficulty），data/*.json 不動。
import { readFileSync, writeFileSync, renameSync, mkdirSync, existsSync } from 'node:fs';
import path from 'node:path';

export const SCORE_MIN = 1;
export const SCORE_MAX = 1000;
/** 題庫原 difficulty → 初始分 */
export const SEED = { 1: 200, 2: 500, 3: 800 };
/** score ≤ EASY_MAX → 1；≤ NORMAL_MAX → 2；其餘 → 3 */
export const EASY_MAX = 333;
export const NORMAL_MAX = 666;
/** 預設分的「虛擬樣本數」：越大越慣性 */
export const PRIOR_N = 10;
/** 單回合最多計入幾人（避免大房間一回合洗掉分數） */
export const MAX_N_PER_ROUND = 5;
/** 累計作答未滿這個次數，一律沿用原本 difficulty */
export const MIN_ATTEMPTS = 5;

/** @type {Record<string, {score:number, attempts:number, correct:number, updatedAt:number}>} */
let stats = {};
let dirty = false;

const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));

export const seedScore = (baseDifficulty) => SEED[baseDifficulty] ?? SEED[2];
export const tierOf = (score) => (score <= EASY_MAX ? 1 : score <= NORMAL_MAX ? 2 : 3);

/** 單一玩家這題的「容易度」0~1：答錯／沒作答 0；答對 0.5~1（越快越高） */
export function easeOf(row, windowMs) {
  if (!row || !row.correct) return 0;
  const w = windowMs > 0 ? windowMs : 1;
  const el = clamp(Number.isFinite(row.ms) ? row.ms : w, 0, w);
  return 0.5 + 0.5 * (1 - el / w);
}

/**
 * 一個回合的結果 → { n, correct, T }。T = 目標難度分。
 * 只算參賽且影片沒失敗的玩家（rows 來自 SongGame._reveal，出題者／旁觀者本來就不在裡面）。
 */
export function scoreRound(rows, windowMs) {
  const valid = (rows || []).filter((r) => r && !r.failed);
  if (!valid.length) return { n: 0, correct: 0, T: null };
  const ease = valid.reduce((s, r) => s + easeOf(r, windowMs), 0) / valid.length;
  return {
    n: valid.length,
    correct: valid.filter((r) => r.correct).length,
    T: clamp(SCORE_MAX * (1 - ease), SCORE_MIN, SCORE_MAX),
  };
}

/** 往目標分移動一步；n = 這回合有效人數、attempts = 更新前累計作答次數 */
export function nextScore(score, attempts, n, T) {
  const eff = Math.min(n, MAX_N_PER_ROUND);
  const w = eff / (PRIOR_N + attempts + eff);
  return clamp(score + (T - score) * w, SCORE_MIN, SCORE_MAX);
}

/** 這首歌目前該用的難度（樣本不足 → 原本 difficulty） */
export function effectiveDifficulty(base, entry) {
  if (!entry || entry.attempts < MIN_ATTEMPTS) return base;
  return tierOf(entry.score);
}

function applyOne(q) {
  const e = stats[q.id];
  if (!e) return;
  if (q.baseDifficulty === undefined) q.baseDifficulty = q.difficulty ?? 1;
  q.difficulty = effectiveDifficulty(q.baseDifficulty, e);
}

/** 題庫（重新）載入之後呼叫：把已累積的統計套到題目上 */
export function applyToBank(bank) {
  for (const list of Object.values(bank || {})) for (const q of list) applyOne(q);
}

/** 回合結束時呼叫（SongGame._reveal）。q 必須是題庫裡的那個物件。回傳這首歌更新後的統計（沒有有效玩家則 null） */
export function recordRound(q, rows, windowMs) {
  if (!q || !q.id) return null;
  const { n, correct, T } = scoreRound(rows, windowMs);
  if (!n) return null;
  const base = q.baseDifficulty ?? q.difficulty ?? 1;
  const e = stats[q.id] || { score: seedScore(base), attempts: 0, correct: 0, updatedAt: 0 };
  e.score = nextScore(e.score, e.attempts, n, T);
  e.attempts += n;
  e.correct += correct;
  e.updatedAt = Date.now();
  stats[q.id] = e;
  dirty = true;
  applyOne(q);
  return e;
}

export const getStats = (id) => stats[id] || null;
export const allStats = () => stats;
export function resetStats() { stats = {}; dirty = false; }

// ===== 存檔（跟房間存檔同樣模式：寫暫存再改名）=====
export function loadStats(file) {
  if (!existsSync(file)) return 0;
  try {
    const d = JSON.parse(readFileSync(file, 'utf8'));
    const src = d && typeof d.songs === 'object' && d.songs ? d.songs : {};
    const out = {};
    for (const [id, e] of Object.entries(src)) {
      if (!e || !Number.isFinite(e.score) || !Number.isFinite(e.attempts)) continue;
      out[id] = { score: clamp(e.score, SCORE_MIN, SCORE_MAX), attempts: Math.max(0, e.attempts | 0), correct: Math.max(0, (e.correct | 0)), updatedAt: Number(e.updatedAt) || 0 };
    }
    stats = out;
    dirty = false;
    return Object.keys(out).length;
  } catch (e) {
    console.error('讀取歌曲統計失敗（忽略，從空的開始）', e && e.message);
    return 0;
  }
}

export function saveStats(file) {
  if (!dirty) return false;
  try {
    const songs = {};
    for (const [id, e] of Object.entries(stats)) songs[id] = { ...e, score: Math.round(e.score * 100) / 100 };
    mkdirSync(path.dirname(file), { recursive: true });
    const tmp = file + '.tmp';
    writeFileSync(tmp, JSON.stringify({ savedAt: Date.now(), songs }));
    renameSync(tmp, file);
    dirty = false;
    return true;
  } catch (e) {
    console.error('歌曲統計存檔失敗', e && e.message);
    return false;
  }
}
