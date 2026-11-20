import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import {
  SCORE_MIN, SCORE_MAX, MIN_ATTEMPTS, seedScore, tierOf, easeOf, scoreRound, nextScore, effectiveDifficulty,
  recordRound, applyToBank, getStats, resetStats, loadStats, saveStats,
} from '../server/songstats.mjs';

const W = 15000; // windowMs
const ok = (ms) => ({ correct: true, answered: true, failed: false, ms });
const bad = () => ({ correct: false, answered: true, failed: false, ms: 3000 });
const none = () => ({ correct: false, answered: false, failed: false, ms: null });
const song = (d, id = 's1') => ({ id, difficulty: d });

test('初始分與分區', () => {
  assert.deepEqual([1, 2, 3].map(seedScore), [200, 500, 800]);
  assert.deepEqual([1, 333, 334, 666, 667, 1000].map(tierOf), [1, 1, 2, 2, 3, 3]);
  // 預設分一定落在自己原本的分區，沒有統計時不會「換區」
  for (const d of [1, 2, 3]) assert.equal(tierOf(seedScore(d)), d);
});

test('ease：答錯／沒答 = 0；答對越快越高，最慢也有 0.5', () => {
  assert.equal(easeOf(bad(), W), 0);
  assert.equal(easeOf(none(), W), 0);
  assert.equal(easeOf(ok(0), W), 1);
  assert.equal(easeOf(ok(W), W), 0.5);
  assert.ok(easeOf(ok(2000), W) > easeOf(ok(10000), W));
});

test('scoreRound：全對秒答 → 目標分接近 1；全錯 → 1000；failed 不計', () => {
  assert.equal(scoreRound([ok(0), ok(0)], W).T, SCORE_MIN);
  assert.equal(scoreRound([bad(), none(), bad()], W).T, SCORE_MAX);
  const r = scoreRound([ok(0), { ...bad(), failed: true }], W);
  assert.equal(r.n, 1);
  assert.equal(r.T, SCORE_MIN);
  assert.equal(scoreRound([{ ...ok(0), failed: true }], W).n, 0);
  assert.equal(scoreRound([], W).T, null);
  // 少數人猜對 → 偏難；多數人猜對 → 偏簡單
  assert.ok(scoreRound([ok(5000), bad(), bad(), bad()], W).T > scoreRound([ok(5000), ok(5000), ok(5000), bad()], W).T);
});

test('一次秒答只微調，不會讓冷門歌直接跳到簡單區', () => {
  resetStats();
  const q = song(3, 'hard-1');
  recordRound(q, [ok(0)], W);
  const e = getStats('hard-1');
  assert.ok(e.score < seedScore(3) && e.score > seedScore(3) - 100, `分數只微降：${e.score}`);
  assert.equal(q.difficulty, 3, '樣本不足仍沿用原 difficulty');
  // 同一首歌 d=2 被秒答一次，也不該掉到簡單
  const q2 = song(2, 'mid-1');
  recordRound(q2, [ok(0)], W);
  assert.equal(q2.difficulty, 2);
  assert.ok(getStats('mid-1').score > 333);
});

test('未滿 MIN_ATTEMPTS 沿用原值，之後才套用統計分區', () => {
  assert.equal(effectiveDifficulty(2, { score: 100, attempts: MIN_ATTEMPTS - 1 }), 2);
  assert.equal(effectiveDifficulty(2, { score: 100, attempts: MIN_ATTEMPTS }), 1);
  assert.equal(effectiveDifficulty(2, null), 2);
});

test('多回合全員秒答 → 降到簡單；全員答錯 → 升到困難', () => {
  resetStats();
  const easy = song(2, 'e'); const hard = song(2, 'h');
  for (let i = 0; i < 12; i++) {
    recordRound(easy, [ok(500), ok(800), ok(1000)], W);
    recordRound(hard, [bad(), none(), bad()], W);
  }
  assert.equal(easy.difficulty, 1);
  assert.equal(hard.difficulty, 3);
  assert.equal(easy.baseDifficulty, 2, '原始難度保留');
  assert.equal(hard.baseDifficulty, 2);
  for (const id of ['e', 'h']) { const s = getStats(id).score; assert.ok(s >= SCORE_MIN && s <= SCORE_MAX); }
});

test('累積樣本越多，單次結果影響越小', () => {
  const first = nextScore(500, 0, 1, 0) - 500;
  const later = nextScore(500, 100, 1, 0) - 500;
  assert.ok(Math.abs(first) > Math.abs(later) * 5);
  // 單回合人數有上限
  assert.equal(nextScore(500, 0, 5, 0), nextScore(500, 0, 50, 0));
});

test('baseDifficulty 不會被重複覆蓋；applyToBank 重套統計', () => {
  resetStats();
  const q = song(2, 'x');
  for (let i = 0; i < 10; i++) recordRound(q, [ok(0), ok(0)], W);
  assert.equal(q.baseDifficulty, 2);
  assert.equal(q.difficulty, 1);
  // 模擬 SIGHUP 重新載入題庫：新物件是原始難度，套用後應回到統計出來的分區
  const fresh = song(2, 'x');
  applyToBank({ anime: [fresh, song(1, 'untouched')] });
  assert.equal(fresh.difficulty, 1);
  assert.equal(fresh.baseDifficulty, 2);
});

test('存檔再讀檔結果一致；沒有變動不重寫', () => {
  resetStats();
  const dir = mkdtempSync(path.join(tmpdir(), 'songstats-'));
  const file = path.join(dir, 'songstats.json');
  try {
    recordRound(song(1, 'a'), [ok(1000), bad()], W);
    recordRound(song(3, 'b'), [bad()], W);
    const before = { a: getStats('a'), b: getStats('b') };
    assert.equal(saveStats(file), true);
    assert.equal(saveStats(file), false, '沒變動就不再寫');
    resetStats();
    assert.equal(loadStats(file), 2);
    for (const id of ['a', 'b']) {
      assert.equal(getStats(id).attempts, before[id].attempts);
      assert.equal(getStats(id).correct, before[id].correct);
      assert.ok(Math.abs(getStats(id).score - before[id].score) < 0.01);
    }
    assert.ok(JSON.parse(readFileSync(file, 'utf8')).songs.a);
  } finally { rmSync(dir, { recursive: true, force: true }); resetStats(); }
});

test('壞掉的存檔會被忽略', () => {
  resetStats();
  const dir = mkdtempSync(path.join(tmpdir(), 'songstats-'));
  try {
    assert.equal(loadStats(path.join(dir, 'nope.json')), 0);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
