import test from 'node:test';
import assert from 'node:assert/strict';
import { Room } from '../server/room.mjs';
import { cleanSettings } from '../server/games/songguess.mjs';
import { getStats } from '../server/songstats.mjs';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const FAST = { preloadMs: 60, goDelayMs: 10, lagMs: 60, staleMs: 80, lobbyDropMs: 100, dropMs: 400 };

// 遊戲訊息包在 {t:'g', m}；測試用的假連線把它拆開，方便用 last('question') 這種寫法
function fakeConn() {
  return { sent: [], kicked: false, send(m) { this.sent.push(m.t === 'g' ? m.m : m); }, close() { this.closed = true; }, last(t) { return [...this.sent].reverse().find((m) => m.t === t); }, all(t) { return this.sent.filter((m) => m.t === t); } };
}
const G = (room, conn, m) => room.handle(conn, { t: 'g', m });
const ph = (room) => (room.game ? room.game.phase : 'lobby'); // 遊戲內的階段；沒有遊戲 = lobby
const seat = (room, p) => room.game.seats.get(p.id);

/** 建一個房間並加入 n 位玩家；回傳 { room, conns, players } */
function setup(n, settings = {}, timing = {}) {
  const room = new Room('TEST', { ...FAST, ...timing });
  const conns = []; const players = [];
  for (let i = 0; i < n; i++) {
    const c = fakeConn();
    const r = room.join(c, { nick: 'P' + (i + 1) });
    assert.ok(r.player, r.error && r.error.msg);
    conns.push(c); players.push(r.player);
  }
  room.gameId = 'songguess';
  room.settings.songguess = { ...cleanSettings({ categories: ['anime'], count: 3, ...settings }), ...settings };
  return { room, conns, players };
}
const start = (room, conns) => room.handle(conns[0], { t: 'start' });
const readyAll = (room, conns) => { const idx = room.game.g.idx; conns.forEach((c) => G(room, c, { t: 'ready', idx })); };

test('暱稱重名會自動加數字、第一位是房主', () => {
  const room = new Room('T1', FAST);
  const a = room.join(fakeConn(), { nick: '小明' }).player;
  const b = room.join(fakeConn(), { nick: '小明' }).player;
  assert.equal(a.nick, '小明');
  assert.equal(b.nick, '小明2');
  assert.equal(room.hostId, a.id);
  assert.equal(room.join(fakeConn(), { nick: '   ' }).error.code, 'NICK');
});

test('全員 ready → 開播；全員鎖定 → 提早揭曉並計分', async () => {
  const { room, conns, players } = setup(3);
  start(room, conns);
  assert.equal(ph(room), 'preload');
  const q = conns[0].last('question');
  assert.equal(q.choices.length, 8);
  assert.equal(q.choices.some((c) => 'correct' in c), false, '選項不能洩漏正解');
  assert.equal('answer' in q, false, '題目訊息不應包含答案卡');
  assert.equal('correct' in q, false);
  readyAll(room, conns);
  assert.equal(ph(room), 'playing');
  assert.ok(conns[1].last('go').startAt);
  const idx = room.game.g.idx; const ok = room.game.g.correctIdx; const bad = (ok + 1) % 8;
  G(room, conns[0], { t: 'lock', idx, choice: ok, elapsedMs: 0 });
  G(room, conns[1], { t: 'lock', idx, choice: bad, elapsedMs: 0 });
  assert.equal(ph(room), 'playing');
  assert.equal(conns[2].last('state').locked, 2);
  G(room, conns[2], { t: 'lock', idx, choice: ok, elapsedMs: 5000 });
  assert.equal(ph(room), 'reveal');
  const rv = conns[0].last('reveal');
  assert.equal(rv.reason, 'all');
  assert.equal(rv.correct.index, ok);
  const byId = Object.fromEntries(rv.rows.map((r) => [r.id, r]));
  assert.equal(byId[players[0].id].correct, true);
  assert.equal(byId[players[1].id].points, 0);
  assert.ok(byId[players[0].id].points > byId[players[2].id].points, '越快分數越高');
  assert.equal(rv.ranking[0].id, players[0].id);
});

test('揭曉時會把這題的作答記進歌曲難度統計', () => {
  const { room, conns } = setup(3);
  start(room, conns); readyAll(room, conns);
  const idx = room.game.g.idx; const ok = room.game.g.correctIdx; const bad = (ok + 1) % 8;
  const q = room.game.g.q;
  assert.equal(getStats(q.id), null);
  G(room, conns[0], { t: 'lock', idx, choice: ok, elapsedMs: 0 });
  G(room, conns[1], { t: 'lock', idx, choice: bad, elapsedMs: 0 });
  G(room, conns[2], { t: 'lock', idx, choice: ok, elapsedMs: 5000 });
  assert.equal(ph(room), 'reveal');
  const e = getStats(q.id);
  assert.equal(e.attempts, 3);
  assert.equal(e.correct, 2);
  assert.equal(q.difficulty, q.baseDifficulty ?? q.difficulty, '樣本不足不換區');
});

test('過半鎖定 → 開始倒數且只觸發一次；倒數結束揭曉', async () => {
  const { room, conns } = setup(4, { quorumMode: 'half', quorumSecs: 0.15 });
  start(room, conns); readyAll(room, conns);
  const idx = room.game.g.idx;
  G(room, conns[0], { t: 'lock', idx, choice: 0, elapsedMs: 0 });
  G(room, conns[1], { t: 'lock', idx, choice: 0, elapsedMs: 0 });
  assert.equal(conns[3].all('quorum').length, 0, '2/4 還沒過半');
  G(room, conns[2], { t: 'lock', idx, choice: 0, elapsedMs: 0 });
  assert.equal(conns[3].all('quorum').length, 1, '3/4 過半 → 開始倒數');
  assert.equal(ph(room), 'playing');
  await sleep(250);
  assert.equal(ph(room), 'reveal');
  assert.equal(conns[3].last('reveal').reason, 'quorum');
  assert.equal(conns[3].all('quorum').length, 1);
});

test('門檻「關閉」時不倒數；已選未鎖定的在揭曉時以最慢速度計入', () => {
  const { room, conns, players } = setup(3, { quorumMode: 'off', scoreMode: 'speed' });
  start(room, conns); readyAll(room, conns);
  const idx = room.game.g.idx; const ok = room.game.g.correctIdx;
  G(room, conns[0], { t: 'lock', idx, choice: ok, elapsedMs: 0 });
  G(room, conns[1], { t: 'select', idx, choice: ok }); // 只選未鎖
  G(room, conns[2], { t: 'lock', idx, choice: ok, elapsedMs: 0 });
  assert.equal(conns[0].all('quorum').length, 0);
  G(room, conns[0], { t: 'forceReveal', idx });
  const rv = conns[0].last('reveal');
  const r1 = rv.rows.find((r) => r.id === players[1].id);
  assert.equal(r1.correct, true);
  assert.equal(r1.points, 600, '最慢速度 = 基本分');
});

test('硬性截止：沒人作答也會揭曉', async () => {
  const { room, conns } = setup(2, { duration: 0.05, graceSecs: 0 });
  start(room, conns); readyAll(room, conns);
  await sleep(250);
  assert.equal(ph(room), 'reveal');
  assert.equal(conns[0].last('reveal').reason, 'time');
});

test('預載逾時也會開播（有人沒 ready）', async () => {
  const { room, conns } = setup(2);
  start(room, conns);
  G(room, conns[0], { t: 'ready', idx: room.game.g.idx });
  assert.equal(ph(room), 'preload');
  await sleep(120);
  assert.equal(ph(room), 'playing');
});

test('elapsed 會被夾在伺服器看到的時間以內（不能亂報超快）', () => {
  const { room, conns, players } = setup(2, { scoreMode: 'speed' });
  start(room, conns); readyAll(room, conns);
  const idx = room.game.g.idx; const ok = room.game.g.correctIdx;
  G(room, conns[0], { t: 'lock', idx, choice: ok, elapsedMs: -99999 });
  G(room, conns[1], { t: 'lock', idx, choice: ok, elapsedMs: 99999999 });
  const rv = conns[0].last('reveal');
  const a = rv.rows.find((r) => r.id === players[0].id);
  const b = rv.rows.find((r) => r.id === players[1].id);
  assert.ok(a.ms >= 0);
  assert.ok(b.ms <= room.game.g.windowMs);
});

test('錯誤的題號、錯誤的選項索引會被忽略', () => {
  const { room, conns } = setup(2);
  start(room, conns); readyAll(room, conns);
  const idx = room.game.g.idx;
  G(room, conns[0], { t: 'lock', idx: idx + 5, choice: 0 });
  G(room, conns[0], { t: 'lock', idx, choice: 99 });
  G(room, conns[0], { t: 'lock', idx, choice: 'x' });
  assert.equal(conns[1].last('state').locked, 0);
});

test('非房主不能開始／跳題；房主離線後移轉', () => {
  const { room, conns, players } = setup(3);
  room.handle(conns[1], { t: 'start' });
  assert.equal(ph(room), 'lobby');
  room.disconnect(conns[0]);
  assert.equal(room.hostId, players[1].id);
});

test('房主很快重連（重新整理）會拿回房主；太久才回來則不會', () => {
  const { room, conns, players } = setup(2, {}, { hostReturnMs: 60 });
  room.disconnect(conns[0]);
  assert.equal(room.hostId, players[1].id);
  room.join(fakeConn(), { playerId: players[0].id });
  assert.equal(room.hostId, players[0].id, '馬上回來 → 還給房主');
});

test('原房主離線期間別人陸續重連，原房主稍後回來仍拿回房主', () => {
  const { room, conns, players } = setup(3, {}, { hostReturnMs: 5000 });
  const r2 = Room.restore(JSON.parse(JSON.stringify(room.serialize())), {}, { hostReturnMs: 5000 }); // 伺服器重啟
  r2.join(fakeConn(), { playerId: players[1].id });
  assert.equal(r2.hostId, players[1].id, '先連上的人暫代房主');
  r2.join(fakeConn(), { playerId: players[2].id });
  assert.equal(r2.hostId, players[1].id);
  r2.join(fakeConn(), { playerId: players[0].id });
  assert.equal(r2.hostId, players[0].id, '原房主晚一步回來，還是拿回房主');
});

test('原房主太久沒回來（超過時限）就不再歸還', async () => {
  const { room, players } = setup(2, {}, { hostReturnMs: 40 });
  const r2 = Room.restore(JSON.parse(JSON.stringify(room.serialize())), {}, { hostReturnMs: 40 });
  r2.join(fakeConn(), { playerId: players[1].id });
  await new Promise((r) => setTimeout(r, 80));
  r2.join(fakeConn(), { playerId: players[0].id });
  assert.equal(r2.hostId, players[1].id);
});

test('轉移房主：只有房主能轉、只能轉給在線上的人、轉出去後原房主失去權限', () => {
  const { room, conns, players } = setup(3);
  room.handle(conns[1], { t: 'host', id: players[2].id });
  assert.equal(room.hostId, players[0].id, '非房主不能轉');
  room.handle(conns[0], { t: 'host', id: players[0].id });
  room.handle(conns[0], { t: 'host', id: 'nobody' });
  assert.equal(room.hostId, players[0].id, '轉給自己／不存在的人無效');
  room.disconnect(conns[2]);
  room.handle(conns[0], { t: 'host', id: players[2].id });
  assert.equal(room.hostId, players[0].id, '離線的人不能接');
  room.handle(conns[0], { t: 'host', id: players[1].id });
  assert.equal(room.hostId, players[1].id);
  assert.equal(conns[0].last('hub').hostId, players[1].id, '大家都收到新房主');
  room.handle(conns[0], { t: 'start' });
  assert.equal(ph(room), 'lobby', '原房主不能再開始遊戲');
  // 主動交棒的人重新整理後不會自動搶回
  room.disconnect(conns[0]);
  room.join(fakeConn(), { playerId: players[0].id });
  assert.equal(room.hostId, players[1].id);
});

test('斷線重連：用同一個 playerId 回座並保留分數', async () => {
  const { room, conns, players } = setup(2);
  start(room, conns); readyAll(room, conns);
  const idx = room.game.g.idx; const ok = room.game.g.correctIdx;
  G(room, conns[0], { t: 'lock', idx, choice: ok, elapsedMs: 0 });
  G(room, conns[1], { t: 'lock', idx, choice: ok, elapsedMs: 0 });
  const score = seat(room, players[0]).score;
  assert.ok(score > 0);
  room.disconnect(conns[0]);
  const c2 = fakeConn();
  const r = room.join(c2, { playerId: players[0].id, nick: '別的名字' });
  assert.equal(r.player.id, players[0].id);
  assert.equal(seat(room, r.player).score, score);
  assert.equal(r.player.nick, 'P1');
  assert.ok(c2.last('reveal'), '重連後補送目前的揭曉畫面');
  assert.equal(room.players.size, 2);
});

test('離線超過 staleMs 不算進鎖定分母：剩下的人都鎖定就揭曉', async () => {
  const { room, conns } = setup(3, { quorumMode: 'off' });
  start(room, conns); readyAll(room, conns);
  const idx = room.game.g.idx;
  room.disconnect(conns[2]);
  G(room, conns[0], { t: 'lock', idx, choice: 0, elapsedMs: 0 });
  G(room, conns[1], { t: 'lock', idx, choice: 0, elapsedMs: 0 });
  assert.equal(ph(room), 'playing', '剛離線 10 秒內仍算在分母');
  await sleep(120);
  room.tick();
  assert.equal(ph(room), 'reveal');
});

test('影片無法播放：個人略過不計分；多數失敗 → 換下一題', () => {
  const { room, conns, players } = setup(3);
  start(room, conns); readyAll(room, conns);
  const idx = room.game.g.idx;
  G(room, conns[2], { t: 'playError', idx });
  assert.equal(ph(room), 'playing');
  assert.equal(seat(room, players[2]).failed, true);
  G(room, conns[1], { t: 'playError', idx });
  assert.ok(conns[0].last('skipped'));
  assert.equal(room.game.g.idx, idx, '換備用題，題號不增加');
  assert.equal(ph(room), 'preload');
});

test('打字搜尋模式：以 key 判分', () => {
  const { room, conns, players } = setup(2, { answerMode: 'typing' });
  start(room, conns);
  assert.ok(conns[0].last('works').list.length > 10);
  assert.equal(conns[0].last('question').choices, null);
  readyAll(room, conns);
  const idx = room.game.g.idx;
  G(room, conns[0], { t: 'lock', idx, key: room.game.g.correctKey, elapsedMs: 0 });
  G(room, conns[1], { t: 'lock', idx, key: 'nope', elapsedMs: 0 });
  const rv = conns[0].last('reveal');
  assert.equal(rv.rows.find((r) => r.id === players[0].id).correct, true);
  assert.equal(rv.rows.find((r) => r.id === players[1].id).correct, false);
});

test('完整一局：揭曉 → 下一題 → 最終排行 → 再來一局', () => {
  const { room, conns, players } = setup(2, { count: 3 });
  start(room, conns);
  for (let i = 0; i < 3; i++) {
    readyAll(room, conns);
    const idx = room.game.g.idx; const ok = room.game.g.correctIdx;
    G(room, conns[0], { t: 'lock', idx, choice: ok, elapsedMs: 1000 });
    G(room, conns[1], { t: 'lock', idx, choice: (ok + 1) % 8, elapsedMs: 1000 });
    assert.equal(ph(room), 'reveal');
    assert.equal(conns[0].last('reveal').last, i === 2);
    G(room, conns[1], { t: 'next' }); // 非房主，無效
    assert.equal(ph(room), 'reveal');
    G(room, conns[0], { t: 'next' });
  }
  assert.equal(ph(room), 'final');
  const f = conns[0].last('final');
  assert.equal(f.ranking[0].id, players[0].id);
  assert.equal(f.ranking[0].correct, 3);
  room.handle(conns[0], { t: 'lobby' });
  assert.equal(ph(room), 'lobby');
  assert.equal(room.game, null, '回到大廳，遊戲物件已丟掉');
});

test('踢人：被踢者不能再用同一 id 加入', () => {
  const { room, conns, players } = setup(3);
  room.handle(conns[0], { t: 'kick', id: players[2].id });
  assert.equal(room.players.has(players[2].id), false);
  assert.equal(conns[2].last('kicked').t, 'kicked');
  assert.equal(room.join(fakeConn(), { playerId: players[2].id, nick: 'x' }).error.code, 'BANNED');
});

test('中途加入：先觀戰，下一題才參與；房主可關閉', () => {
  const { room, conns } = setup(2);
  start(room, conns); readyAll(room, conns);
  const late = fakeConn();
  const lp = room.join(late, { nick: '遲到' }).player;
  assert.equal(seat(room, lp).spectator, true);
  assert.ok(late.last('question'), '補送目前題目');
  G(room, late, { t: 'lock', idx: room.game.g.idx, choice: 0 });
  assert.equal(seat(room, lp).lock, null, '觀戰者不能作答');
  room.settings.songguess.allowLateJoin = false;
  assert.equal(room.join(fakeConn(), { nick: '再遲到' }).error.code, 'STARTED');
});

test('設定夾限：不合法的值會被修正', () => {
  const s = cleanSettings({ count: 99999, duration: 1, scoreMode: 'hack', categories: ['x'], quorumMode: 'n', quorumN: -5, autoNext: 1 });
  assert.equal(s.count, 100);
  assert.equal(s.duration, 5);
  assert.equal(s.scoreMode, 'speed');
  assert.deepEqual(s.categories, ['anime']);
  assert.equal(s.quorumN, 1);
  assert.equal(s.autoNext, 3);
});

test('主畫面模式：沒有主畫面不能開始；以主畫面的 ready 為準', () => {
  const { room, conns } = setup(2, { playMode: 'screen' });
  start(room, conns);
  assert.equal(ph(room), 'lobby');
  assert.equal(conns[0].last('error').code, 'NO_SCREEN');
  const sc = fakeConn();
  assert.ok(room.join(sc, { nick: '客廳電視' }).player);
  room.handle(sc, { t: 'role', role: 'screen' }); // 在大廳把身分選為主畫面
  assert.equal(room.screens.length, 1);
  start(room, conns);
  assert.equal(ph(room), 'preload');
  assert.equal(room.game.seats.size, 2, '主畫面不參賽，沒有座位');
  G(room, sc, { t: 'ready', idx: room.game.g.idx });
  assert.equal(ph(room), 'playing', '手機不用 ready');
  G(room, sc, { t: 'playing', idx: room.game.g.idx });
  assert.ok(sc.last('t0').t0 > 0);
});

test('身分：只能在大廳、選遊戲支援的身分；不夠的參賽者不能開始；主畫面／旁觀者不算人數', () => {
  const { room, conns, players } = setup(2);
  room.handle(conns[1], { t: 'role', role: 'hacker' });
  assert.equal(players[1].role, 'player', '不存在的身分被忽略');
  room.handle(conns[1], { t: 'role', role: 'spectator' });
  assert.equal(conns[0].last('hub').players[1].role, 'spectator');
  room.handle(conns[0], { t: 'role', role: 'spectator' });
  start(room, conns);
  assert.equal(conns[0].last('error').code, 'MIN', '沒有任何參賽者');
  room.handle(conns[0], { t: 'role', role: 'player' });
  // 換成不支援身分的遊戲 → 身分重設為參賽者
  room.handle(conns[0], { t: 'pick', game: 'headsup' });
  assert.equal(players[1].role, 'player');
  room.handle(conns[1], { t: 'role', role: 'screen' });
  assert.equal(players[1].role, 'player', '你說我猜沒有主畫面身分');
  // 遊戲中不能換身分
  room.handle(conns[0], { t: 'pick', game: 'songguess' });
  room.handle(conns[1], { t: 'role', role: 'spectator' });
  room.handle(conns[0], { t: 'start' });
  room.handle(conns[1], { t: 'role', role: 'player' });
  assert.equal(players[1].role, 'spectator');
  room.destroy();
});

test('旁觀者：不參賽、不能作答，但即時看到每個人選了什麼；房主是旁觀者也能控制進度', () => {
  const { room, conns, players } = setup(3, { quorumMode: 'off' });
  room.handle(conns[2], { t: 'role', role: 'spectator' });
  start(room, conns);
  assert.equal(room.game.seats.size, 2);
  assert.equal(conns[2].last('state').players.length, 2, '旁觀者不在參賽名單');
  readyAll(room, conns);
  const idx = room.game.g.idx; const ok = room.game.g.correctIdx;
  assert.ok(conns[2].last('picks'), '旁觀者收到作答狀況');
  assert.equal(conns[0].last('picks'), undefined, '參賽者看不到別人選了什麼');
  G(room, conns[1], { t: 'select', idx, choice: ok });
  const p1 = conns[2].last('picks').picks.find((p) => p.id === players[1].id);
  assert.equal(p1.choice, ok); assert.equal(p1.locked, false);
  assert.equal(p1.label, conns[0].last('question').choices[ok].main);
  G(room, conns[2], { t: 'lock', idx, choice: 0 }); // 旁觀者作答無效
  G(room, conns[1], { t: 'lock', idx, choice: ok, elapsedMs: 0 });
  assert.equal(conns[2].last('picks').picks.find((p) => p.id === players[1].id).locked, true);
  G(room, conns[0], { t: 'lock', idx, choice: ok, elapsedMs: 0 });
  assert.equal(ph(room), 'reveal');
  // 旁觀者重連會補送目前的作答狀況
  const c2 = fakeConn();
  room.disconnect(conns[2]);
  room.join(c2, { playerId: players[2].id });
  assert.ok(c2.last('picks'));
  // 房主換成旁觀者後仍能按下一題
  room.settings.songguess.allowLateJoin = true;
  room.handle(conns[0], { t: 'lobby' });
  room.handle(conns[0], { t: 'role', role: 'spectator' });
  room.handle(conns[1], { t: 'start' });
  assert.equal(ph(room), 'lobby', '非房主不能開始');
  room.handle(conns[2], { t: 'role', role: 'player' });
  start(room, conns);
  readyAll(room, [conns[1], c2]);
  G(room, conns[0], { t: 'forceReveal' });
  assert.equal(ph(room), 'reveal', '旁觀者房主可以強制揭曉');
  G(room, conns[0], { t: 'next' });
  assert.equal(ph(room), 'preload');
  room.destroy();
});

test('分頁被關掉：用同暱稱重新加入，接回離線的座位（保留分數、不會變成「名2」）', () => {
  const { room, conns, players } = setup(2);
  start(room, conns); readyAll(room, conns);
  const idx = room.game.g.idx; const ok = room.game.g.correctIdx;
  G(room, conns[0], { t: 'lock', idx, choice: ok, elapsedMs: 0 });
  G(room, conns[1], { t: 'lock', idx, choice: ok, elapsedMs: 0 });
  const score = seat(room, players[1]).score;
  assert.ok(score > 0);
  room.disconnect(conns[1]); // 手機把網頁殺掉
  const c2 = fakeConn();
  const r = room.join(c2, { nick: 'p2' }); // 沒有 playerId，只有暱稱（大小寫不拘）
  assert.equal(r.player.id, players[1].id);
  assert.equal(seat(room, r.player).score, score);
  assert.equal(room.players.size, 2);
  assert.equal(c2.last('joined').playerId, players[1].id);
  // 對方還在線上時，同暱稱不能搶座位
  const c3 = fakeConn();
  const r3 = room.join(c3, { nick: 'P2' });
  assert.equal(r3.player.nick, 'P22', '在線的人不會被擠掉，新來的自動加數字');
});

test('離線玩家保留很久（大廳 10 分鐘、遊戲中 1 小時），不會因為鎖螢幕幾十秒就被踢', async () => {
  const { room, conns, players } = setup(2, {}, { staleMs: 10, lobbyDropMs: 10 * 60 * 1000 });
  room.disconnect(conns[1]);
  players[1].lastSeen -= 5 * 60 * 1000;
  room.tick();
  assert.equal(room.players.has(players[1].id), true, '大廳離線 5 分鐘仍保留');
  players[1].lastSeen -= 6 * 60 * 1000;
  room.tick();
  assert.equal(room.players.has(players[1].id), false, '大廳離線超過 10 分鐘才移出');
});

import { bank } from '../server/bank.mjs';
const idMap = () => { const m = new Map(); for (const l of Object.values(bank)) for (const q of l) m.set(q.id, q); return m; };
const roundtrip = (room, timing = FAST) => Room.restore(JSON.parse(JSON.stringify(room.serialize())), { idMap: idMap() }, timing);

test('伺服器重啟：房間存檔還原後，玩家用 playerId 重連，分數／鎖定／題目都在，遊戲可以繼續', () => {
  const { room, conns, players } = setup(3, { quorumMode: 'off', count: 3 });
  start(room, conns); readyAll(room, conns);
  let idx = room.game.g.idx; let ok = room.game.g.correctIdx;
  // 第 1 題：兩個人答，一個人沒答 → 手動揭曉，累積分數
  G(room, conns[0], { t: 'lock', idx, choice: ok, elapsedMs: 0 });
  G(room, conns[1], { t: 'lock', idx, choice: (ok + 1) % 8, elapsedMs: 0 });
  G(room, conns[0], { t: 'forceReveal', idx });
  G(room, conns[0], { t: 'next' });
  readyAll(room, conns);
  idx = room.game.g.idx; ok = room.game.g.correctIdx;
  G(room, conns[2], { t: 'lock', idx, choice: ok, elapsedMs: 1000 }); // 第 2 題進行中，只有 P3 鎖定
  const score0 = seat(room, players[0]).score; assert.ok(score0 > 0);

  const r2 = roundtrip(room); // ← 伺服器重啟
  assert.equal(ph(r2), 'playing');
  assert.equal(r2.game.g.idx, idx);
  assert.equal(r2.hostId, players[0].id);
  assert.equal(r2.game.seats.get(players[0].id).score, score0, '分數保留');
  assert.ok(r2.game.seats.get(players[2].id).lock, '已鎖定的答案保留');
  assert.equal(r2.players.get(players[0].id).connected, false, '還原後先視為離線');
  assert.equal(r2.game.g.correctIdx, ok, '正解索引保留（選項順序一致）');

  // 玩家重連
  const nc = [fakeConn(), fakeConn(), fakeConn()];
  nc.forEach((c, i) => assert.equal(r2.join(c, { playerId: players[i].id, nick: players[i].nick }).player.id, players[i].id));
  assert.ok(nc[0].last('question') && nc[0].last('go'), '重連後補送題目與開播時間');
  assert.equal(nc[2].last('you').locked, true);
  assert.equal(r2.hostId, players[0].id);
  // 繼續玩：其他人鎖定 → 全員鎖定 → 揭曉 → 下一題 → 結束
  G(r2, nc[0], { t: 'lock', idx, choice: ok, elapsedMs: 500 });
  G(r2, nc[1], { t: 'lock', idx, choice: ok, elapsedMs: 500 });
  assert.equal(ph(r2), 'reveal');
  assert.ok(nc[0].last('reveal').rows.find((r) => r.id === players[0].id).total > score0, '還原後分數持續累加');
  G(r2, nc[0], { t: 'next' });
  r2.game.g.idx; readyAll(r2, nc);
  const i3 = r2.game.g.idx;
  nc.forEach((c) => G(r2, c, { t: 'lock', idx: i3, choice: 0, elapsedMs: 0 }));
  G(r2, nc[0], { t: 'next' });
  assert.equal(ph(r2), 'final');
  r2.destroy();
});

test('還原：揭曉中與最終排行榜階段也能接回', () => {
  const { room, conns } = setup(2, { quorumMode: 'off' });
  start(room, conns); readyAll(room, conns);
  const idx = room.game.g.idx; const ok = room.game.g.correctIdx;
  conns.forEach((c) => G(room, c, { t: 'lock', idx, choice: ok, elapsedMs: 0 }));
  assert.equal(ph(room), 'reveal');
  const r2 = roundtrip(room);
  assert.equal(ph(r2), 'reveal');
  const c = fakeConn();
  r2.join(c, { playerId: [...r2.players.keys()][0], nick: 'x' });
  assert.ok(c.last('reveal'), '重連後補送揭曉畫面');
  r2.destroy();
  G(room, conns[0], { t: 'end' });
  const r3 = roundtrip(room);
  assert.equal(ph(r3), 'final');
  r3.destroy();
});

test('還原：題庫更新讓那一題不見 → 安全地回到大廳（不當掉）', () => {
  const { room, conns } = setup(2);
  start(room, conns); readyAll(room, conns);
  const data = JSON.parse(JSON.stringify(room.serialize()));
  const r2 = Room.restore(data, { idMap: new Map() }, FAST); // 空題庫
  assert.equal(ph(r2), 'lobby');
  assert.equal(r2.game, null);
  assert.equal(r2.players.size, 2);
  r2.destroy();
});

// ===== J-POP「一曲兩用」（猜歌名／猜歌手）=====
import { choiceOf, buildChoices, ASK_PROMPT, assignAsk } from '../js/questions.js';
const hasJpop = new Set((bank.song || []).map((q) => q.answer.artist)).size >= 12; // 需要夠多歌手才湊得出 8 個不重複選項

test('J-POP 選項：猜歌名＝歌名（小字歌手）；猜歌手＝歌手（小字英文名）', { skip: !hasJpop }, () => {
  const q = bank.song.find((x) => x.answer.artistEn) || bank.song[0];
  assert.deepEqual(choiceOf(q, 'song', 'title'), { main: q.answer.title, sub: q.answer.artist });
  assert.deepEqual(choiceOf(q, 'song', 'artist'), { main: q.answer.artist, sub: q.answer.artistEn || '' });
  for (const ask of ['title', 'artist']) {
    const ch = buildChoices(q, bank.song, 'song', { ask });
    assert.equal(ch.length, 8);
    assert.equal(new Set(ch.map((c) => c.main)).size, 8, '選項互不重複');
    assert.equal(ch.filter((c) => c.correct).length, 1);
    assert.equal(ch.find((c) => c.correct).main, choiceOf(q, 'song', ask).main);
  }
});

test('J-POP 單人：assignAsk 依模式指定猜法並換掉 prompt', { skip: !hasJpop }, () => {
  const qs = bank.song.slice(0, 40);
  assert.ok(assignAsk(qs, 'title').every((q) => q.ask === 'title' && q.prompt === ASK_PROMPT.title));
  assert.ok(assignAsk(qs, 'artist').every((q) => q.ask === 'artist' && q.prompt === ASK_PROMPT.artist));
  const mixed = assignAsk(qs, 'mixed');
  assert.ok(mixed.some((q) => q.ask === 'title') && mixed.some((q) => q.ask === 'artist'), '混合會兩種都出現');
  const anime = assignAsk([{ kind: 'OP', prompt: 'x' }], 'artist');
  assert.equal(anime[0].ask, undefined, '非 J-POP 題目不受影響');
});

test('J-POP 多人（8 選 1）：每題帶 ask 與對應 prompt，正解索引判分', { skip: !hasJpop }, () => {
  const { room, conns, players } = setup(2, { categories: ['song'], jpopAsk: 'mixed', quorumMode: 'off', count: 4 });
  start(room, conns);
  const seen = new Set();
  for (let i = 0; i < 4; i++) {
    readyAll(room, conns);
    const q = conns[0].last('question');
    assert.ok(['title', 'artist'].includes(q.ask));
    assert.equal(q.prompt, ASK_PROMPT[q.ask]);
    assert.equal(q.choices.length, 8);
    seen.add(q.ask);
    const ok = room.game.g.correctIdx;
    const gold = room.game.g.q.answer;
    assert.equal(q.choices[ok].main, q.ask === 'artist' ? gold.artist : gold.title, '正解選項顯示的是歌手／歌名');
    G(room, conns[0], { t: 'lock', idx: q.idx, choice: ok, elapsedMs: 0 });
    G(room, conns[1], { t: 'lock', idx: q.idx, choice: (ok + 1) % 8, elapsedMs: 0 });
    const rv = conns[0].last('reveal');
    assert.equal(rv.answer.title, gold.title, '揭曉時歌名與歌手都帶出');
    assert.equal(rv.answer.artist, gold.artist);
    assert.equal(rv.rows.find((r) => r.id === players[0].id).correct, true);
    G(room, conns[0], { t: 'next' });
  }
  assert.equal(ph(room), 'final');
});

test('J-POP 多人（打字搜尋）：猜歌手用 a: 鍵、猜歌名用 t: 鍵；候選清單分兩份', { skip: !hasJpop }, () => {
  const { room, conns, players } = setup(2, { categories: ['song'], jpopAsk: 'artist', answerMode: 'typing', quorumMode: 'off' });
  start(room, conns);
  const wa = conns[0].all('works');
  assert.deepEqual(wa.map((m) => m.ask), ['artist'], 'jpopAsk=artist 只送歌手清單');
  assert.ok(wa[0].list.length >= 10 && wa[0].list[0].k.startsWith('a:'));
  readyAll(room, conns);
  const q = conns[0].last('question');
  assert.equal(q.ask, 'artist'); assert.equal(q.choices, null);
  G(room, conns[0], { t: 'lock', idx: q.idx, key: room.game.g.correctKey, elapsedMs: 0 });
  G(room, conns[1], { t: 'lock', idx: q.idx, key: 'a:不存在的歌手', elapsedMs: 0 });
  const rv = conns[0].last('reveal');
  assert.equal(rv.rows.find((r) => r.id === players[0].id).correct, true);
  assert.equal(rv.rows.find((r) => r.id === players[1].id).correct, false);
  assert.ok(rv.rows.find((r) => r.id === players[0].id).pick, '揭曉列出你選的是什麼（由候選清單查出）');
});

test('J-POP 不受「歌曲類型」勾選影響（沒有 OP/ED 概念）', { skip: !hasJpop }, () => {
  const { room, conns } = setup(1, { categories: ['song'], kinds: ['OP'] });
  start(room, conns);
  assert.equal(ph(room), 'preload', '只勾 OP 也能出 J-POP');
});

// ===== 出題者模式 =====

const firstAnimeSearch = () => { const a = bank.anime[0].answer; return (a.work || a.title).slice(0, 2); };

test('出題者模式：必須指定在線出題者且至少還有一位參賽者', () => {
  const { room, conns } = setup(3, { questionSource: 'setter', setterId: null });
  start(room, conns);
  assert.equal(room.game, null);
  assert.equal(conns[0].last('error').code, 'NO_SETTER');
  const s2 = setup(1, { questionSource: 'setter' });
  s2.room.settings.songguess.setterId = s2.players[0].id;
  start(s2.room, s2.conns);
  assert.equal(s2.conns[0].last('error').code, 'NO_GUESSER');
});

test('出題者模式：出題者搜尋、挑歌 → 其他人作答；出題者不參賽、不進排名', () => {
  const { room, conns, players } = setup(3, { questionSource: 'setter', count: 2 });
  room.settings.songguess.setterId = players[2].id;
  start(room, conns);
  assert.equal(ph(room), 'pick');
  const pk = conns[0].last('pick');
  assert.equal(pk.setter.id, players[2].id);
  assert.equal(pk.idx, 1);
  assert.equal(conns[0].last('question'), undefined, '挑歌前沒有題目');

  const kw = firstAnimeSearch();
  G(room, conns[0], { t: 'search', q: kw }); // 非出題者：忽略
  assert.equal(conns[0].last('results'), undefined);
  G(room, conns[2], { t: 'search', q: kw });
  const res = conns[2].last('results');
  assert.ok(res.list.length > 0 && res.q === kw);
  const pickedId = res.list[0].id;

  G(room, conns[0], { t: 'setPick', idx: 1, id: pickedId }); // 非出題者：忽略
  assert.equal(ph(room), 'pick');
  G(room, conns[2], { t: 'setPick', idx: 1, id: 'no-such-song' });
  assert.ok(conns[2].last('pickError'));
  G(room, conns[2], { t: 'setPick', idx: 1, id: pickedId });
  assert.equal(ph(room), 'preload');
  assert.equal(room.game.g.q.id, pickedId);
  const q = conns[0].last('question');
  assert.equal(q.setter.id, players[2].id);
  assert.equal(seat(room, players[2]).eligible, false);

  readyAll(room, conns);
  assert.equal(ph(room), 'playing');
  const idx = room.game.g.idx; const ok = room.game.g.correctIdx;
  G(room, conns[2], { t: 'lock', idx, choice: ok, elapsedMs: 0 }); // 出題者不能作答
  assert.equal(seat(room, players[2]).lock, null);
  G(room, conns[0], { t: 'lock', idx, choice: ok, elapsedMs: 0 });
  G(room, conns[1], { t: 'lock', idx, choice: (ok + 1) % 8, elapsedMs: 0 });
  assert.equal(ph(room), 'reveal', '只有兩位猜題者鎖定就揭曉');
  const rv = conns[0].last('reveal');
  assert.equal(rv.rows.some((r) => r.id === players[2].id), false);
  assert.equal(rv.ranking.some((r) => r.id === players[2].id), false);

  // 第二題：房主按下一題 → 又進入挑歌；同一首歌不能重複出
  G(room, conns[0], { t: 'next' });
  assert.equal(ph(room), 'pick');
  assert.equal(conns[0].last('pick').idx, 2);
  G(room, conns[2], { t: 'setPick', idx: 2, id: pickedId });
  assert.match(conns[2].last('pickError').msg, /已經出過/);
});

test('出題者模式：挑歌逾時、房主跳過 → 退回隨機出題', async () => {
  const { room, conns, players } = setup(3, { questionSource: 'setter', pickSecs: 0.1 });
  room.settings.songguess.setterId = players[2].id;
  start(room, conns);
  assert.equal(ph(room), 'pick');
  await sleep(150);
  assert.notEqual(ph(room), 'pick');
  assert.equal(conns[0].last('pickFallback').reason, 'timeout');
  assert.ok(conns[0].last('question').setter, '之後仍標示出題者，但本題是隨機的');

  const t2 = setup(3, { questionSource: 'setter', pickSecs: 30 });
  t2.room.settings.songguess.setterId = t2.players[2].id;
  start(t2.room, t2.conns);
  G(t2.room, t2.conns[0], { t: 'skip' });
  assert.equal(ph(t2.room), 'preload');
  assert.equal(t2.conns[0].last('pickFallback').reason, 'host');
});

test('出題者模式：出題者離開 → 改隨機；設定夾限', () => {
  const { room, conns, players } = setup(3, { questionSource: 'setter', pickSecs: 30 });
  room.settings.songguess.setterId = players[2].id;
  start(room, conns);
  room.handle(conns[2], { t: 'leave' });
  assert.equal(ph(room), 'preload');
  assert.equal(conns[0].last('pickFallback').reason, 'offline');
  const s = cleanSettings({ questionSource: 'x', setterId: 'bad id!', pickSecs: 9999 });
  assert.equal(s.questionSource, 'random');
  assert.equal(s.setterId, null);
  assert.equal(s.pickSecs, 180);
});

// ===== VOCALOID 題庫：作品＝作者（P 主），猜歌手那題問的是作者 =====
import { askPrompt, CATEGORIES } from '../js/questions.js';
const hasVocaloid = (bank.vocaloid || []).length >= 20;

test('VOCALOID 已登錄為題庫；猜作者的題目文字與其他流行歌不同', () => {
  assert.ok(CATEGORIES.some((c) => c.id === 'vocaloid'));
  assert.equal(askPrompt('VOCALOID', 'artist'), '這首歌的作者（P 主）是誰？');
  assert.equal(askPrompt('VOCALOID', 'title'), '這首歌的歌名是？');
  assert.equal(askPrompt('JPOP', 'artist'), '這首歌是哪位歌手唱的？');
  const ov = assignAsk([{ kind: 'VOCALOID', prompt: 'x' }, { kind: 'VOCALOID', prompt: 'x' }], 'artist');
  assert.ok(ov.every((q) => q.prompt === '這首歌的作者（P 主）是誰？'));
});

test('VOCALOID 題庫：每題有影片、作者、歌名；選項互不重複；不受歌曲類型勾選影響', { skip: !hasVocaloid }, () => {
  for (const q of bank.vocaloid) {
    assert.match(q.ytId, /^[\w-]{11}$/);
    assert.equal(q.kind, 'VOCALOID');
    assert.ok(q.answer.title && q.answer.artist, q.id);
  }
  assert.equal(new Set(bank.vocaloid.map((q) => q.id)).size, bank.vocaloid.length, '題目編號不重複');
  assert.equal(new Set(bank.vocaloid.map((q) => q.ytId)).size, bank.vocaloid.length, '同一支影片不出現兩次');
  const q = bank.vocaloid[0];
  for (const ask of ['title', 'artist']) {
    const ch = buildChoices(q, bank.vocaloid, 'vocaloid', { ask });
    assert.equal(ch.length, 8);
    assert.equal(new Set(ch.map((c) => c.main)).size, 8);
    assert.equal(ch.filter((c) => c.correct).length, 1);
  }
  const { room, conns } = setup(2, { categories: ['vocaloid'], kinds: ['OP'], jpopAsk: 'artist' });
  start(room, conns);
  assert.equal(ph(room), 'preload');
  const m = conns[0].last('question');
  assert.equal(m.prompt, '這首歌的作者（P 主）是誰？');
  assert.equal(m.kind, 'VOCALOID');
  room.destroy();
});

// ===== 遊戲 OST 題庫：猜「這段配樂來自哪款遊戲」，一款遊戲一題 =====
const hasOst = (bank.ost || []).length >= 100;

test('遊戲 OST 題庫：每題有影片、遊戲名、曲名；一款遊戲只出現一次；影片不重複', { skip: !hasOst }, () => {
  for (const q of bank.ost) {
    assert.match(q.ytId, /^[\w-]{11}$/);
    assert.equal(q.kind, 'OST');
    assert.ok(q.answer.work && q.answer.title, q.id);
  }
  assert.equal(new Set(bank.ost.map((q) => q.ytId)).size, bank.ost.length, '同一支影片不出現兩次');
  assert.equal(new Set(bank.ost.map((q) => q.workId)).size, bank.ost.length, '同一款遊戲不出現兩次');
  const works = bank.ost.map((q) => q.answer.work).join('\n');
  for (const must of ['Pokémon', 'Minecraft', 'Super Mario Bros.', 'Genshin Impact', 'League of Legends', 'Plants vs. Zombies']) assert.ok(works.includes(must), `缺少 ${must}`);
});

test('鎖定倒數：沒有「全員」選項（全員鎖定本來就立刻揭曉）；舊的 all 設定視為不倒數', () => {
  assert.equal(cleanSettings({ quorumMode: 'all' }).quorumMode, 'off');
  assert.equal(cleanSettings({ quorumMode: 'half' }).quorumMode, 'half');
  assert.equal(cleanSettings({ quorumMode: 'n' }).quorumMode, 'n');
});
