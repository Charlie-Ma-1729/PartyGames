// 房間（大廳／選遊戲／重連）、你說我猜、配音大師的單元測試
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

// 配音大師的資料夾與 ffmpeg 要在載入伺服器模組「之前」指定（測試用暫存資料夾；沒有 ffmpeg 也要能走完流程）
const tmp = mkdtempSync(path.join(tmpdir(), 'partygames-'));
process.env.DUBBING_DIR = tmp;
process.env.FFMPEG_PATH = 'ffmpeg-does-not-exist';
mkdirSync(path.join(tmp, 'videos', 'sub'), { recursive: true });
writeFileSync(path.join(tmp, 'videos', 'a.mp4'), 'x');
writeFileSync(path.join(tmp, 'videos', 'sub', 'b.webm'), 'x');
const { Room } = await import('../server/room.mjs');
const { DUB } = await import('../server/media.mjs');

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const FAST = { preloadMs: 60, goDelayMs: 10, lagMs: 60, staleMs: 80, lobbyDropMs: 100, dropMs: 400, introMs: 30, turnEndMs: 60 };

function fakeConn() {
  return { sent: [], kicked: false, send(m) { this.sent.push(m.t === 'g' ? { ...m.m, _g: m.g } : m); }, close() { this.closed = true; }, last(t) { return [...this.sent].reverse().find((m) => m.t === t); }, all(t) { return this.sent.filter((m) => m.t === t); } };
}
const G = (room, conn, m) => room.handle(conn, { t: 'g', m });
function setup(n, timing = {}) {
  const room = new Room('TEST', { ...FAST, ...timing });
  const conns = []; const players = [];
  for (let i = 0; i < n; i++) {
    const c = fakeConn();
    const r = room.join(c, { nick: 'P' + (i + 1) });
    assert.ok(r.player, r.error && r.error.msg);
    conns.push(c); players.push(r.player);
  }
  return { room, conns, players };
}
const byId = (players, conns, id) => conns[players.findIndex((p) => p.id === id)];

// ===================== 房間：選遊戲 =====================
test('joined 帶遊戲清單；房主選遊戲、改設定，其他人不能', () => {
  const { room, conns, players } = setup(2);
  const j = conns[0].last('joined');
  assert.deepEqual(j.games.map((g) => g.id), ['songguess', 'dubbing', 'headsup', 'coopdraw']);
  assert.ok(j.info.songguess.counts && j.info.headsup.categories.length > 5);
  assert.equal(conns[0].last('hub').gameId, 'songguess', '預設遊戲');
  room.handle(conns[1], { t: 'pick', game: 'headsup' });
  assert.equal(room.gameId, 'songguess', '非房主不能選');
  room.handle(conns[0], { t: 'pick', game: 'nope' });
  assert.equal(room.gameId, 'songguess', '不存在的遊戲被忽略');
  room.handle(conns[0], { t: 'pick', game: 'headsup' });
  assert.equal(conns[1].last('hub').gameId, 'headsup');
  room.handle(conns[0], { t: 'settings', settings: { duration: 9999, rounds: 2, category: '不存在' } });
  const s = conns[1].last('hub').settings;
  assert.equal(s.duration, 180, '夾限');
  assert.equal(s.rounds, 2);
  assert.equal(s.category, '__all__', '不存在的分類被擋掉');
  // 各遊戲的設定各存各的
  room.handle(conns[0], { t: 'pick', game: 'songguess' });
  assert.ok(conns[0].last('hub').settings.categories);
  room.handle(conns[0], { t: 'pick', game: 'headsup' });
  assert.equal(conns[0].last('hub').settings.rounds, 2, '切回來設定還在');
  assert.equal(players.length, 2);
});

test('人數不夠不能開始（你說我猜至少 2 人）；離線的不算', () => {
  const { room, conns } = setup(1);
  room.handle(conns[0], { t: 'pick', game: 'headsup' });
  room.handle(conns[0], { t: 'start' });
  assert.equal(conns[0].last('error').code, 'MIN');
  assert.equal(room.game, null);
});

test('遊戲進行中不能換遊戲或改設定；房主「回大廳」可以，大家回到大廳', () => {
  const { room, conns } = setup(2);
  room.handle(conns[0], { t: 'pick', game: 'headsup' });
  room.handle(conns[0], { t: 'start' });
  assert.equal(room.phase, 'game');
  assert.equal(conns[1].last('hub').phase, 'game');
  room.handle(conns[0], { t: 'pick', game: 'songguess' });
  assert.equal(room.gameId, 'headsup');
  room.handle(conns[1], { t: 'lobby' });
  assert.equal(room.phase, 'game', '非房主不能回大廳');
  room.handle(conns[0], { t: 'lobby' });
  assert.equal(room.phase, 'lobby');
  assert.equal(conns[1].last('hub').phase, 'lobby');
  room.handle(conns[0], { t: 'pick', game: 'songguess' });
  room.handle(conns[0], { t: 'settings', settings: { count: 3 } });
  room.handle(conns[0], { t: 'start' });
  assert.equal(room.activeId, 'songguess', '同一個房間可以接著玩另一個遊戲');
  room.destroy();
});

test('遊戲訊息都包著 {t:"g", g:遊戲代號}；沒開始時的遊戲訊息被忽略', () => {
  const { room, conns } = setup(2);
  G(room, conns[0], { t: 'lock', idx: 1 }); // 沒有遊戲：不能出錯
  room.handle(conns[0], { t: 'pick', game: 'headsup' });
  room.handle(conns[0], { t: 'start' });
  assert.equal(conns[1].last('state')._g, 'headsup');
  room.destroy();
});

test('房間存檔：大廳選的遊戲與各遊戲設定重啟後還原；進行中的你說我猜重啟後回大廳', () => {
  const { room, conns, players } = setup(2);
  room.handle(conns[0], { t: 'pick', game: 'headsup' });
  room.handle(conns[0], { t: 'settings', settings: { duration: 45 } });
  const r1 = Room.restore(JSON.parse(JSON.stringify(room.serialize())), {}, FAST);
  assert.equal(r1.gameId, 'headsup');
  assert.equal(r1.getSettings().duration, 45);
  assert.equal(r1.hostId, players[0].id);
  assert.equal(r1.players.size, 2);
  room.handle(conns[0], { t: 'start' });
  const r2 = Room.restore(JSON.parse(JSON.stringify(room.serialize())), {}, FAST);
  assert.equal(r2.phase, 'lobby', '不支援還原的遊戲 → 安全地回大廳');
  assert.equal(r2.gameId, 'headsup');
  room.destroy();
});

test('離線者重連時補送遊戲狀態；中途加入受各遊戲規則限制', () => {
  const { room, conns, players } = setup(2);
  room.handle(conns[0], { t: 'pick', game: 'dubbing' });
  room.handle(conns[0], { t: 'settings', settings: { videos: ['a.mp4'] } });
  room.handle(conns[0], { t: 'start' });
  assert.equal(room.phase, 'game');
  assert.equal(room.join(fakeConn(), { nick: '遲到' }).error.code, 'STARTED', '配音遊戲不能中途加入');
  room.disconnect(conns[1]);
  const c2 = fakeConn();
  assert.equal(room.join(c2, { playerId: players[1].id }).player.id, players[1].id);
  assert.ok(c2.last('round') && c2.last('progress'), '重連後補送這一關的資訊');
  room.destroy();
});

// ===================== 你說我猜 =====================
function startHeadsUp(n, settings = {}) {
  const ctx = setup(n);
  const { room, conns } = ctx;
  room.handle(conns[0], { t: 'pick', game: 'headsup' });
  room.handle(conns[0], { t: 'settings', settings: { duration: 20, ...settings } });
  room.handle(conns[0], { t: 'start' });
  return ctx;
}

test('你說我猜：只有出題者拿得到題目；答對／跳過換下一題；時間到結算並輪到下一位', async () => {
  const { room, conns, players } = startHeadsUp(3);
  const g = room.game;
  assert.equal(g.turns.length, 3, '3 人 1 輪 = 3 個回合');
  assert.equal(g.phase, 'intro');
  const st = conns[0].last('state');
  assert.notEqual(st.d.id, st.g.id);
  const dConn = byId(players, conns, st.d.id);
  const gConn = byId(players, conns, st.g.id);
  assert.equal(conns.every((c) => !c.last('word')), true, '準備階段沒有人拿到題目');
  await sleep(60);
  assert.equal(g.phase, 'play');
  const w1 = dConn.last('word');
  assert.ok(w1 && w1.word);
  assert.equal(conns.filter((c) => c !== dConn && c.last('word')).length, 0, '題目不會傳給其他人');
  // 錯誤的 seq 被忽略；別人不能按
  G(room, dConn, { t: 'mark', seq: 999, type: 'correct' });
  G(room, gConn, { t: 'mark', seq: w1.seq, type: 'correct' });
  assert.equal(g.turn.correct, 0);
  G(room, dConn, { t: 'mark', seq: w1.seq, type: 'correct' });
  assert.equal(g.turn.correct, 1);
  const w2 = dConn.last('word');
  assert.notEqual(w2.word, w1.word);
  G(room, dConn, { t: 'mark', seq: w2.seq, type: 'pass' });
  G(room, dConn, { t: 'mark', seq: dConn.last('word').seq, type: 'correct' });
  assert.equal(conns[0].last('state').correct, 2);
  // 房主提早結束這一輪
  const host = conns[0];
  G(room, host, { t: 'skip' });
  const te = host.last('turnEnd');
  assert.equal(te.correct, 2); assert.equal(te.passed, 1);
  assert.deepEqual(te.words.map((x) => x.ok), [true, false, true]);
  const score = (id) => g.seats.get(id).score;
  assert.equal(score(st.d.id), 2); assert.equal(score(st.g.id), 2, '出題者與猜題者同分');
  const other = players.find((p) => p.id !== st.d.id && p.id !== st.g.id);
  assert.equal(score(other.id), 0);
  assert.equal(te.ranking[0].score, 2);
  // 自動換下一輪（出題者換人）
  await sleep(120);
  assert.equal(g.turn.idx, 2);
  assert.notEqual(g.turn.d, st.d.id);
  room.destroy();
});

test('你說我猜：時間到自動結算；全部輪完 → final；非房主不能 next', async () => {
  const { room, conns } = startHeadsUp(2, { duration: 20 });
  const g = room.game;
  assert.equal(g.turns.length, 2);
  g.settings.duration = 0.05; // 縮短計時
  await sleep(60);
  assert.equal(g.phase, 'play');
  await sleep(80);
  assert.equal(g.phase, 'turnEnd');
  assert.equal(conns[0].last('turnEnd').reason, 'time');
  G(room, conns[1], { t: 'next' });
  assert.equal(g.phase, 'turnEnd', '非房主不能 next');
  G(room, conns[0], { t: 'next' });
  assert.equal(g.phase, 'intro');
  await sleep(60); await sleep(80);
  assert.equal(g.phase, 'turnEnd');
  assert.equal(conns[0].last('turnEnd').last, true);
  G(room, conns[0], { t: 'next' });
  assert.equal(g.phase, 'final');
  assert.equal(conns[1].last('final').ranking.length, 2);
  room.destroy();
});

test('你說我猜：出題者斷線超過寬限 → 結束該輪；人數不足 → 直接結束；重連補送題目', async () => {
  const { room, conns, players } = startHeadsUp(3);
  const g = room.game;
  await sleep(60);
  const d = g.turn.d;
  const dc = byId(players, conns, d);
  room.disconnect(dc);
  const c2 = fakeConn();
  room.join(c2, { playerId: d });
  assert.ok(c2.last('word'), '出題者重連後拿回目前題目');
  room.disconnect(c2);
  await sleep(120);
  room.tick();
  assert.equal(g.phase, 'turnEnd');
  // 兩個人離開 → 剩 1 人，遊戲直接結束
  const ids = players.map((p) => p.id).filter((id) => id !== room.hostId);
  room.handle(byId(players, conns, ids[0]), { t: 'leave' });
  room.handle(byId(players, conns, ids[1]), { t: 'leave' });
  assert.equal(g.phase, 'final');
  room.destroy();
});

test('你說我猜：指定猜題者模式——其他人輪流出題、同一個人猜；猜題者必須在線', async () => {
  const { room, conns, players } = setup(4);
  room.handle(conns[0], { t: 'pick', game: 'headsup' });
  room.handle(conns[0], { t: 'settings', settings: { guesserMode: 'fixed', duration: 20 } });
  room.handle(conns[0], { t: 'start' });
  assert.equal(conns[0].last('error').code, 'NO_GUESSER', '還沒指定猜題者');
  room.handle(conns[0], { t: 'settings', settings: { guesserMode: 'fixed', guesserId: players[2].id, rounds: 2 } });
  assert.equal(conns[0].last('hub').settings.guesserId, players[2].id);
  room.handle(conns[0], { t: 'settings', settings: { guesserId: '../bad' } });
  assert.equal(conns[0].last('hub').settings.guesserId, null, '不合法的 id 被擋掉');
  room.handle(conns[0], { t: 'settings', settings: { guesserId: players[2].id } });
  room.disconnect(conns[2]);
  room.handle(conns[0], { t: 'start' });
  assert.equal(conns[0].last('error').code, 'NO_GUESSER', '猜題者不在線');
  const c = fakeConn();
  room.join(c, { playerId: players[2].id });
  room.handle(conns[0], { t: 'start' });
  const g = room.game;
  assert.equal(g.turns.length, 6, '3 位出題者 × 2 次');
  assert.ok(g.turns.every((t) => t.g === players[2].id), '每一輪都是同一個人猜');
  assert.ok(g.turns.every((t) => t.d !== players[2].id), '猜題者自己不出題');
  const ds = g.turns.slice(0, 3).map((t) => t.d);
  assert.equal(new Set(ds).size, 3, '三位出題者各一次');
  room.destroy();
});

test('你說我猜：兩個人的指定模式就是經典的「一人說、一人猜」', () => {
  const { room, conns, players } = setup(2);
  room.handle(conns[0], { t: 'pick', game: 'headsup' });
  room.handle(conns[0], { t: 'settings', settings: { guesserMode: 'fixed', guesserId: players[1].id } });
  room.handle(conns[0], { t: 'start' });
  assert.deepEqual(room.game.turns, [{ d: players[0].id, g: players[1].id }]);
  room.destroy();
});

// ===================== 配音大師 =====================
test('配音大師：設定夾限、路徑檢查（擋 ../）', () => {
  const { room, conns } = setup(1);
  room.handle(conns[0], { t: 'pick', game: 'dubbing' });
  room.handle(conns[0], { t: 'settings', settings: { videos: ['a.mp4', '../x.mp4', 'sub/b.webm', 'a.mp4', 'c.txt', '/etc/passwd', 'sub\\b.webm'], timeLimit: 99 } });
  const s = conns[0].last('hub').settings;
  assert.deepEqual(s.videos, ['a.mp4', 'sub/b.webm']);
  assert.equal(s.timeLimit, 15);
  room.handle(conns[0], { t: 'settings', settings: { videos: ['nonexist.mp4'] } });
  room.handle(conns[0], { t: 'start' });
  assert.equal(conns[0].last('error').code, 'NO_VIDEO', '檔案不存在不能開始');
  assert.equal(room.game, null);
});

function fakeUpload(room, p, idx, ext = '.webm') {
  const t = room.game.uploadTarget(p.id, idx, ext);
  assert.ok(t.file, t.error);
  writeFileSync(path.join(DUB.audio, t.file), 'audio');
  room.game.uploadDone(p.id, idx, t.file);
}

test('配音大師：完整流程（錄音 → 輪流評分 → 結算），沒有 ffmpeg 也會送出結果', async () => {
  const { room, conns, players } = setup(3);
  room.handle(conns[0], { t: 'pick', game: 'dubbing' });
  room.handle(conns[0], { t: 'settings', settings: { videos: ['a.mp4', 'sub/b.webm'], timeLimit: 3 } });
  room.handle(conns[0], { t: 'start' });
  const g = room.game;
  assert.equal(g.phase, 'record');
  assert.equal(conns[1].last('round').total, 2);
  // 不能亂傳：關卡不對、非玩家
  assert.ok(g.uploadTarget(players[0].id, 5, '.webm').error);
  assert.ok(g.uploadTarget('nobody-xxxxxxxx', 0, '.webm').error);
  // 關卡 1：P1、P2 有錄音；P3 沒錄（交白卷）
  fakeUpload(room, players[0], 0); fakeUpload(room, players[1], 0);
  G(room, conns[0], { t: 'finished', idx: 0, hasRecord: true });
  G(room, conns[1], { t: 'finished', idx: 0, hasRecord: true });
  assert.equal(conns[2].last('progress').finished, 2);
  assert.equal(g.phase, 'record');
  G(room, conns[2], { t: 'finished', idx: 0, hasRecord: true }); // 謊稱有錄音 → 檔案不存在，不算
  assert.equal(g.phase, 'exhibit');
  assert.equal(g.queue.length, 2, '只有真的有錄音檔的人被展示');
  // 評分：作者不能評自己；每人只能評一次；分數要 1~5
  for (let k = 0; k < 2; k++) {
    const e = conns[0].last('exhibit');
    assert.equal(e.k, k + 1);
    const target = e.target.id;
    const tc = byId(players, conns, target);
    G(room, tc, { t: 'vote', idx: 0, target, funny: 5, acting: 5 });
    assert.equal(g.votes.length, k * 2, '作者自評無效');
    const voters = players.filter((p) => p.id !== target);
    G(room, byId(players, conns, voters[0].id), { t: 'vote', idx: 0, target, funny: 9, acting: 3 });
    assert.equal(g.votes.length, k * 2, '分數超出範圍無效');
    G(room, byId(players, conns, voters[0].id), { t: 'vote', idx: 0, target, funny: 4, acting: 2 });
    G(room, byId(players, conns, voters[0].id), { t: 'vote', idx: 0, target, funny: 1, acting: 1 });
    assert.equal(g.votes.length, k * 2 + 1, '同一人重複投無效');
    G(room, byId(players, conns, voters[1].id), { t: 'vote', idx: 0, target, funny: 2, acting: 4 });
  }
  assert.equal(g.phase, 'record');
  assert.equal(g.idx, 1, '評分完換下一關');
  // 關卡 2：只有 P3 有錄音；房主可略過等待
  fakeUpload(room, players[2], 1);
  G(room, conns[2], { t: 'finished', idx: 1, hasRecord: true });
  G(room, conns[1], { t: 'skipWait' }); // 非房主無效
  assert.equal(g.phase, 'record');
  G(room, conns[0], { t: 'skipWait' }); // 房主：直接結束錄音
  assert.equal(g.phase, 'exhibit');
  const e2 = conns[0].last('exhibit');
  assert.equal(e2.target.id, players[2].id);
  G(room, conns[0], { t: 'vote', idx: 1, target: players[2].id, funny: 3, acting: 3 });
  G(room, conns[1], { t: 'vote', idx: 1, target: players[2].id, funny: 5, acting: 1 });
  assert.equal(g.phase, 'processing');
  await sleep(100);
  assert.equal(g.phase, 'results');
  const res = conns[0].last('results');
  assert.equal(res.rows.length, 6, '3 人 × 2 關');
  assert.equal(res.rows.filter((r) => r.hasRecord).length, 3);
  assert.equal(res.mergeOk, false, '沒有 ffmpeg：合成失敗但流程照樣走完');
  const r3 = res.rows.find((r) => r.targetId === players[2].id && r.vIndex === 1);
  assert.equal(r3.funnyAvg, 4); assert.equal(r3.actingAvg, 2); assert.equal(r3.totalScore, 6);
  assert.equal(res.rows.find((r) => r.targetId === players[2].id && r.vIndex === 0).hasRecord, false);
  assert.ok(res.topFunny && res.topActing);
  assert.equal(res.playerRanking.length, 3);
  assert.ok(res.playerRanking[0].totalScore >= res.playerRanking[2].totalScore);
  // 重連補送結果
  room.disconnect(conns[1]);
  const c2 = fakeConn();
  room.join(c2, { playerId: players[1].id });
  assert.ok(c2.last('results'));
  room.handle(conns[0], { t: 'lobby' });
  assert.equal(room.phase, 'lobby');
});

test('配音大師：逾時沒交卷的人這關沒作品；全員斷線的等待不會卡住（評分者離線）', async () => {
  const { room, conns, players } = setup(2);
  room.handle(conns[0], { t: 'pick', game: 'dubbing' });
  room.handle(conns[0], { t: 'settings', settings: { videos: ['a.mp4'], timeLimit: 1 } });
  room.handle(conns[0], { t: 'start' });
  const g = room.game;
  fakeUpload(room, players[0], 0);
  G(room, conns[0], { t: 'finished', idx: 0, hasRecord: true });
  assert.equal(g.phase, 'record', '還在等 P2');
  room.disconnect(conns[1]); // P2 斷線，超過寬限後不算在分母
  await sleep(120);
  room.tick();
  assert.equal(g.phase, 'exhibit', '只剩 P1 在線 → 全員完成');
  assert.deepEqual(g.exh.voters, [players[0].id], '只有作者自己在線時，允許自評（單人試玩）');
  G(room, conns[0], { t: 'vote', idx: 0, target: players[0].id, funny: 5, acting: 5 });
  assert.equal(g.phase, 'processing');
  room.destroy();
});
