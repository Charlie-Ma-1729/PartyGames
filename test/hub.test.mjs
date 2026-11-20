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
  assert.deepEqual(j.games.map((g) => g.id), ['songguess', 'dubbing', 'headsup', 'coopdraw', 'soramimi']);
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
  assert.equal(s.category, '__pick__', '不存在的分類被擋掉（維持預設：每輪自選）');
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
  room.handle(conns[0], { t: 'settings', settings: { mode: 'pair', category: '__all__', duration: 20, ...settings } });
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
  assert.notEqual(g.turn.ds[0], st.d.id);
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
  const d = g.turn.ds[0];
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

test('你說我猜（一對一）：指定猜題者模式——其他人輪流出題、同一個人猜；猜題者必須在線', async () => {
  const { room, conns, players } = setup(4);
  room.handle(conns[0], { t: 'pick', game: 'headsup' });
  room.handle(conns[0], { t: 'settings', settings: { mode: 'pair', category: '__all__', guesserMode: 'fixed', duration: 20 } });
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
  assert.ok(g.turns.every((t) => t.ds[0] !== players[2].id), '猜題者自己不出題');
  const ds = g.turns.slice(0, 3).map((t) => t.ds[0]);
  assert.equal(new Set(ds).size, 3, '三位出題者各一次');
  room.destroy();
});

test('你說我猜（一對一）：兩個人的指定模式就是「一人說、一人猜」', () => {
  const { room, conns, players } = setup(2);
  room.handle(conns[0], { t: 'pick', game: 'headsup' });
  room.handle(conns[0], { t: 'settings', settings: { mode: 'pair', category: '__all__', guesserMode: 'fixed', guesserId: players[1].id } });
  room.handle(conns[0], { t: 'start' });
  assert.deepEqual(room.game.turns, [{ mode: 'pair', g: players[1].id, ds: [players[0].id] }]);
  room.destroy();
});

test('你說我猜：設定夾限——玩法與「每輪自選」都合法；不存在的分類被擋', () => {
  const { room, conns } = setup(2);
  room.handle(conns[0], { t: 'pick', game: 'headsup' });
  const s0 = conns[0].last('hub').settings;
  assert.equal(s0.mode, 'team', '預設是經典玩法：一人猜、其他人描述');
  assert.equal(s0.category, '__pick__', '預設每輪由猜題者自選');
  room.handle(conns[0], { t: 'settings', settings: { mode: 'race', category: '寶可夢' } });
  assert.equal(conns[0].last('hub').settings.mode, 'race');
  assert.equal(conns[0].last('hub').settings.category, '寶可夢');
  room.handle(conns[0], { t: 'settings', settings: { mode: 'bad', category: '不存在的分類' } });
  assert.equal(conns[0].last('hub').settings.mode, 'race', '不合法的玩法被擋');
  assert.equal(conns[0].last('hub').settings.category, '寶可夢', '不存在的分類被擋');
  room.destroy();
});

// ----- 經典：一人猜、其他人一起描述 -----
test('你說我猜（經典）：所有描述的人都拿到題目、猜題者沒有；只有操作者能按；只有猜題者得分', async () => {
  const { room, conns, players } = startHeadsUp(4, { mode: 'team' });
  const g = room.game;
  assert.equal(g.turns.length, 4, '4 人 1 輪 = 每個人猜一次');
  assert.ok(g.turns.every((t) => t.g && t.ds.length === 3 && !t.ds.includes(t.g)), '每輪 1 人猜、其他 3 人描述');
  const st = conns[0].last('state');
  assert.equal(st.mode, 'team'); assert.equal(st.ds.length, 3);
  await sleep(60);
  assert.equal(g.phase, 'play');
  const gConn = byId(players, conns, st.g.id);
  const dConns = st.ds.map((x) => byId(players, conns, x.id));
  assert.ok(!gConn.last('word'), '猜題者拿不到題目');
  assert.ok(dConns.every((c) => c.last('word') && c.last('word').seq === 1), '每位描述的人都拿到題目');
  assert.equal(new Set(dConns.map((c) => c.last('word').word)).size, 1, '大家看到同一題');
  assert.ok(st.ds.some((x) => x.id === st.op.id), '操作者是描述的人之一');
  const opConn = byId(players, conns, st.op.id);
  const notOp = dConns.filter((c) => c !== opConn);
  G(room, gConn, { t: 'mark', seq: 1, type: 'correct' });
  assert.equal(g.turn.correct, 0, '猜題者自己不能按');
  G(room, notOp[0], { t: 'mark', seq: 1, type: 'correct' });
  G(room, notOp[1], { t: 'mark', seq: 1, type: 'pass' });
  assert.equal(g.turn.correct, 0, '其他描述的人不是操作者，不能按（避免打架）');
  assert.equal(g.turn.passed, 0);
  G(room, opConn, { t: 'mark', seq: 1, type: 'correct' });
  assert.equal(g.turn.correct, 1, '只有操作者能按');
  G(room, opConn, { t: 'mark', seq: 1, type: 'correct' });
  assert.equal(g.turn.correct, 1, '同一題重複按會被忽略（seq 已經換了）');
  assert.ok(dConns.every((c) => c.last('word').seq === 2), '換題後每位描述的人都拿到新題');
  G(room, opConn, { t: 'mark', seq: 2, type: 'correct' });
  G(room, conns[0], { t: 'skip' });
  const te = conns[0].last('turnEnd');
  assert.equal(te.correct, 2);
  const score = (id) => g.seats.get(id).score;
  assert.equal(score(st.g.id), 2, '猜題者 +2');
  assert.ok(st.ds.every((x) => score(x.id) === 0), '描述的人不得分');
  room.destroy();
});

test('你說我猜（經典）：操作者每輪隨機從描述的人裡挑；離開／離線後換另一位接手', async () => {
  const seen = new Set();
  for (let i = 0; i < 12; i++) { // 隨機：多開幾局，應該不會永遠是同一個人
    const { room } = startHeadsUp(4, { mode: 'team' });
    assert.ok(room.game.turn.ds.includes(room.game.turn.op) && room.game.turn.op !== room.game.turn.g);
    seen.add(room.game.turn.op);
    room.destroy();
  }
  assert.ok(seen.size > 1, '操作者是隨機的');

  const { room, conns, players } = startHeadsUp(4, { mode: 'team' });
  const g = room.game;
  await sleep(60);
  const op = g.turn.op;
  if (op === room.hostId) { room.destroy(); return; } // 房主不能離開（會換房主），這種情況下略過
  room.handle(byId(players, conns, op), { t: 'leave' });
  assert.equal(g.phase, 'play', '還有其他描述的人，這一輪繼續');
  assert.notEqual(g.turn.op, op, '操作者離開 → 換人');
  assert.ok(g.turn.ds.includes(g.turn.op) && g.seats.has(g.turn.op));
  assert.equal(conns[0].last('state').op.id, g.turn.op, '大家都收到新的操作者');
  const newOp = byId(players, conns, g.turn.op);
  G(room, newOp, { t: 'mark', seq: g.turn.seq, type: 'correct' });
  assert.equal(g.turn.correct, 1, '新的操作者能按');
  room.destroy();
});

test('你說我猜（經典）：指定一位猜題者 → 其他人全部一起描述，重複 rounds 次', () => {
  const { room, conns, players } = setup(3);
  room.handle(conns[0], { t: 'pick', game: 'headsup' });
  room.handle(conns[0], { t: 'settings', settings: { mode: 'team', category: '__all__', guesserMode: 'fixed', guesserId: players[1].id, rounds: 2 } });
  room.handle(conns[0], { t: 'start' });
  const g = room.game;
  assert.equal(g.turns.length, 2);
  assert.ok(g.turns.every((t) => t.g === players[1].id && t.ds.length === 2 && !t.ds.includes(players[1].id)));
  room.destroy();
});

test('你說我猜（經典）：一位描述的人離開，其他人繼續；猜題者離開 → 結束該輪', async () => {
  const { room, conns, players } = startHeadsUp(4, { mode: 'team' });
  const g = room.game;
  await sleep(60);
  assert.equal(g.phase, 'play');
  const leaver = g.turn.ds.find((id) => id !== room.hostId);
  room.handle(byId(players, conns, leaver), { t: 'leave' });
  assert.equal(g.phase, 'play', '還有其他描述的人，這一輪繼續');
  assert.equal(g.turn.ds.filter((id) => g.seats.has(id)).length, 2);
  if (g.turn.g !== room.hostId) {
    room.handle(byId(players, conns, g.turn.g), { t: 'leave' });
    assert.notEqual(g.phase, 'play', '猜題者離開，這一輪結束');
  }
  room.destroy();
});

// ----- 搶答 -----
test('你說我猜（搶答）：出題者指定第一個答對的人，答對的人與出題者各 +1；其他人不能按', async () => {
  const { room, conns, players } = startHeadsUp(3, { mode: 'race' });
  const g = room.game;
  assert.equal(g.turns.length, 3, '每個人當一次出題者');
  const st = conns[0].last('state');
  assert.equal(st.g, null); assert.equal(st.ds.length, 1);
  const dId = st.d.id;
  const dConn = byId(players, conns, dId);
  const others = players.filter((p) => p.id !== dId);
  await sleep(60);
  const w1 = dConn.last('word');
  assert.ok(w1);
  assert.equal(conns.filter((c) => c !== dConn && c.last('word')).length, 0, '題目只給出題者');
  G(room, byId(players, conns, others[0].id), { t: 'mark', seq: w1.seq, type: 'correct', who: others[0].id });
  assert.equal(g.turn.correct, 0, '搶答的人自己不能按');
  G(room, dConn, { t: 'mark', seq: w1.seq, type: 'correct' });
  assert.equal(g.turn.correct, 0, '沒指定是誰答對 → 不算');
  G(room, dConn, { t: 'mark', seq: w1.seq, type: 'correct', who: dId });
  assert.equal(g.turn.correct, 0, '不能指定自己');
  G(room, dConn, { t: 'mark', seq: w1.seq, type: 'correct', who: '../bad' });
  assert.equal(g.turn.correct, 0, '不存在的人');
  G(room, dConn, { t: 'mark', seq: w1.seq, type: 'correct', who: others[1].id });
  assert.equal(g.turn.correct, 1);
  G(room, dConn, { t: 'mark', seq: dConn.last('word').seq, type: 'pass' });
  G(room, dConn, { t: 'mark', seq: dConn.last('word').seq, type: 'correct', who: others[0].id });
  G(room, conns[0], { t: 'skip' });
  const te = conns[0].last('turnEnd');
  assert.equal(te.correct, 2); assert.equal(te.passed, 1);
  assert.equal(te.words[0].by, others[1].nick, '結果會列出是誰答對的');
  const score = (id) => g.seats.get(id).score;
  assert.equal(score(others[1].id), 1); assert.equal(score(others[0].id), 1);
  assert.equal(score(dId), 2, '出題者每個被猜中的題目 +1');
  room.destroy();
});

// ----- 每輪自選主題 -----
test('你說我猜（每輪自選）：先進選主題階段，只有當輪猜題者能選；選了才開始、題目來自該分類；逾時自動全部混合', async () => {
  const { room, conns, players } = setup(3, { pickMs: 120 });
  room.handle(conns[0], { t: 'pick', game: 'headsup' });
  room.handle(conns[0], { t: 'settings', settings: { mode: 'team', category: '__pick__', duration: 20 } });
  room.handle(conns[0], { t: 'start' });
  const g = room.game;
  assert.equal(g.phase, 'pick');
  const st = conns[0].last('state');
  assert.equal(st.chooser.id, st.g.id, '經典玩法由猜題者選主題');
  assert.ok(st.pickEndsAt > Date.now());
  const gConn = byId(players, conns, st.g.id);
  const dConn = byId(players, conns, st.ds[0].id);
  G(room, dConn, { t: 'pick', cat: '寶可夢' });
  assert.equal(g.phase, 'pick', '別人不能選');
  G(room, gConn, { t: 'pick', cat: '不存在的分類' });
  assert.equal(g.phase, 'pick', '不存在的分類不算');
  G(room, gConn, { t: 'pick', cat: '寶可夢' });
  assert.equal(g.phase, 'intro');
  assert.equal(conns[0].last('state').cat, '寶可夢');
  await sleep(60);
  assert.equal(g.phase, 'play');
  const { bank } = await import('../server/games/headsup.mjs');
  assert.ok(bank['寶可夢'].includes(dConn.last('word').word), '題目來自選的分類');
  // 下一輪：沒人選 → 逾時自動全部混合
  G(room, conns[0], { t: 'skip' });
  G(room, conns[0], { t: 'next' });
  assert.equal(g.phase, 'pick');
  assert.notEqual(g.turn.g, st.g.id, '換人猜、換人選');
  await sleep(160);
  assert.notEqual(g.phase, 'pick', '逾時自動往下');
  assert.equal(g.turn.cat, '__all__');
  room.destroy();
});

test('你說我猜（每輪自選）：搶答模式由出題者選主題', () => {
  const { room, conns } = setup(3);
  room.handle(conns[0], { t: 'pick', game: 'headsup' });
  room.handle(conns[0], { t: 'settings', settings: { mode: 'race', category: '__pick__' } });
  room.handle(conns[0], { t: 'start' });
  const st = conns[0].last('state');
  assert.equal(st.phase, 'pick');
  assert.equal(st.chooser.id, st.d.id);
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
