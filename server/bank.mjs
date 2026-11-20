// 伺服器端題庫：啟動時讀 data/*.json，收到 SIGHUP 時重新載入
import { readFileSync, existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { CATEGORIES, SONG_CATS, choiceOf } from '../js/questions.js';

export const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
export { CATEGORIES };

/** { [catId]: Question[] } */
export let bank = {};
/** { [catId]: { [ask]: {k, main, sub}[] } }：打字搜尋用的候選清單。一般題庫 ask = 'work'；J-POP 有 'title'（歌名）與 'artist'（歌手）兩份 */
export let works = {};

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
  const n = Object.values(nb).reduce((s, a) => s + a.length, 0);
  console.log(`題庫載入：${CATEGORIES.map((c) => `${c.id} ${nb[c.id].length}`).join('、')}（共 ${n} 題）`);
}

loadBank();
process.on('SIGHUP', () => { try { loadBank(); } catch (e) { console.error(e); } });
