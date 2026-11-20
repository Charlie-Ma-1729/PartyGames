// 合力塗鴉：規則（工具卡／墨水／驗證）與伺服器遊戲流程的單元測試
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

process.env.DUBBING_DIR = mkdtempSync(path.join(tmpdir(), 'partygames-cd-'));
process.env.FFMPEG_PATH = 'ffmpeg-does-not-exist';
const { Room } = await import('../server/room.mjs');
const { norm, bank } = await import('../server/games/coopdraw.mjs');
const rules = await import('../js/games/coopdraw/rules.js');
const { CARDS, PALETTE, INK_MAX, cardById, sanitizeOp, inkAt } = rules;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const FAST = { staleMs: 80, lobbyDropMs: 100, dropMs: 400, introMs: 30, turnEndMs: 60, guessCdMs: 0, pingCdMs: 0 };

function fakeConn() {
  return { sent: [], send(m) { this.sent.push(m.t === 'g' ? { ...m.m, _g: m.g } : m); }, close() { this.closed = true; }, last(t) { return [...this.sent].reverse().find((m) => m.t === t); }, all(t) { return this.sent.filter((m) => m.t === t); } };
}
const G = (room, conn, m) => room.handle(conn, { t: 'g', m });

/** n 位玩家的房間，選好合力塗鴉並開始，等進入作畫階段 */
async function play(n, settings = {}, timing = {}) {
  const room = new Room('TEST', { ...FAST, ...timing });
  const conns = []; const players = [];
  for (let i = 0; i < n; i++) {
    const c = fakeConn();
    const r = room.join(c, { nick: 'P' + (i + 1) });
    assert.ok(r.player, r.error && r.error.msg);
    conns.push(c); players.push(r.player);
  }
  room.handle(conns[0], { t: 'pick', game: 'coopdraw' });
  if (Object.keys(settings).length) room.handle(conns[0], { t: 'settings', settings });
  room.handle(conns[0], { t: 'start' });
  assert.equal(room.phase, 'game', '遊戲有開始');
  await sleep(80);
  const game = room.game;
  const t = game.turn;
  const connOf = (id) => conns[players.findIndex((p) => p.id === id)];
  return { room, conns, players, game, t, connOf, guesser: connOf(t.g), drawerIds: t.drawers };
}
/** 強制某位畫家拿某張卡（測試用，不然是隨機發的） */
const giveCard = (t, id, cardId, color = '#e63946') => { t.cards.set(id, { card: cardById(cardId), color }); };

// ===================== 規則 =====================
test('題庫：載入、有別名、答案正規化', () => {
  assert.ok(Object.keys(bank).length >= 5, '至少 5 個分類');
  const all = Object.values(bank).flat();
  assert.ok(all.length >= 200, `題目夠多（${all.length}）`);
  const bike = all.find((w) => w.word === '腳踏車');
  assert.ok(bike && bike.answers.includes(norm('單車')) && bike.answers.includes(norm('自行車')));
  assert.equal(norm(' 腳 踏車！ '), '腳踏車');
  assert.equal(norm('ＡＢＣ'), 'abc');
});

test('rules：座標夾限、壞資料被拒絕、顏色由卡決定', () => {
  const ruler = cardById('ruler');
  let r = sanitizeOp(ruler, null, { k: 'line', a: [-50, 9999], b: [300, 300], c: '#ff0000' }, 100);
  assert.deepEqual(r.op.a, [0, 600], '座標夾進畫布');
  assert.equal(r.op.c, PALETTE[0], '直線尺只能黑色，用戶端自己指定的顏色無效');
  assert.equal(sanitizeOp(ruler, null, { k: 'line', a: ['x', 1], b: [2, 3] }, 100).op, null, '壞座標被拒絕');
  assert.equal(sanitizeOp(ruler, null, { k: 'circle', p: [1, 1], r: 5 }, 100).op, null, '直線尺不能畫圓');
  assert.equal(sanitizeOp(ruler, null, { k: 'line', a: [0, 0], b: [1, 1] }, 100).op, null, '太短的線被拒絕');
  const compass = cardById('compass');
  r = sanitizeOp(compass, null, { k: 'circle', p: [400, 300], r: 9999, f: 1, ci: 3 }, 100);
  assert.equal(r.op.r, compass.maxR, '半徑有上限');
  assert.equal(r.op.f, 1);
  assert.equal(r.op.c, PALETTE[3], '圓規可以自己選色');
  const block = cardById('block');
  assert.equal(sanitizeOp(block, '#2a9d8f', { k: 'rect', a: [0, 0], b: [50, 50], ci: 5 }, 100).op.c, '#2a9d8f', '隨機色卡用伺服器發的顏色');
  const mirror = cardById('mirror');
  assert.equal(sanitizeOp(mirror, null, { k: 'path', s: 1, pts: [[10, 10], [20, 20]] }, 100).op.m, 1, '鏡像筆的線帶對稱旗標');
  assert.equal(sanitizeOp(cardById('eraser'), null, { k: 'path', s: 1, pts: [[10, 10], [20, 20]] }, 100).op.c, rules.BG, '橡皮擦 = 白色');
});

test('rules：墨水不足時自由手繪截斷、形狀整個拒絕、新的一筆要花墨水', () => {
  const pen = cardById('colorpen'); // perPx 0.2
  const pts = Array.from({ length: 60 }, (_, i) => [i * 10, 0]); // 590px → 118 墨水
  const r = sanitizeOp(pen, null, { k: 'path', s: 1, pts }, 100);
  assert.ok(r.op.pts.length < 60 && r.op.pts.length > 10, `被截斷（${r.op.pts.length} 點）`);
  assert.ok(r.cost <= 100 + 1e-9);
  assert.equal(sanitizeOp(pen, null, { k: 'path', s: 2, pts: [[1, 1]] }, 0.5).op, null, '沒墨水連開始一筆都不行');
  const same = sanitizeOp(pen, null, { k: 'path', s: 1, pts: [[5, 5], [6, 5]] }, 0.5, { s: 1, len: 0, last: [5, 5] });
  assert.ok(same.op, '同一筆的後續段落不用再付開筆費用');
  assert.equal(sanitizeOp(pen, null, { k: 'path', s: 1, pts: [[300, 300]] }, 50, { s: 1, len: 0, last: [5, 5] }).op.pts.length, 1, '接不上上一段 = 新的一筆（要付開筆費用）');
  assert.equal(sanitizeOp(pen, null, { k: 'path', s: 1, pts: [[300, 300]] }, 0.5, { s: 1, len: 0, last: [5, 5] }).op, null, '沒墨水時不能靠「單點段落」免費畫點');
  assert.equal(sanitizeOp(pen, null, { k: 'path', s: 1, pts: [[5, 5]] }, 50, { s: 1, len: 0, last: [5, 5] }).op, null, '接續段落只有一個點 = 什麼都沒畫');
  assert.equal(sanitizeOp(cardById('ruler'), null, { k: 'line', a: [0, 0], b: [800, 0] }, 50).op, null, '墨水不夠，整條直線被拒絕');
  const short = cardById('shortpen'); // maxLen 140
  const long = sanitizeOp(short, null, { k: 'path', s: 1, pts: [[0, 0], [100, 0], [200, 0], [300, 0]] }, 100);
  assert.equal(long.op.pts.length, 2, '短筆一筆最多約 140 像素');
  const next = sanitizeOp(short, null, { k: 'path', s: 1, pts: [[100, 0], [200, 0]] }, 100, long.stroke);
  assert.equal(next.op, null, '同一筆累計長度已用完');
  const fresh = sanitizeOp(short, null, { k: 'path', s: 2, pts: [[100, 0], [200, 0]] }, 100, long.stroke);
  assert.ok(fresh.op, '換一筆就重新計算');
});

test('rules：墨水會隨時間恢復，不會超過上限', () => {
  assert.equal(inkAt({ v: 0, t: 0 }, 1000), rules.INK_REGEN);
  assert.equal(inkAt({ v: 90, t: 0 }, 60000), INK_MAX);
  assert.equal(inkAt({ v: 0, t: 0 }, 1000 * 12), INK_MAX, '約 12 秒內回滿');
});

test('rules：每張卡的定義完整', () => {
  const ids = new Set(CARDS.map((c) => c.id));
  assert.equal(ids.size, CARDS.length, 'id 不重複');
  for (const c of CARDS) {
    assert.ok(c.name && c.icon && c.desc && c.kind, c.id);
    assert.ok(['black', 'random', 'pick', 'erase'].includes(c.color), c.id);
  }
});

// ===================== 遊戲流程 =====================
test('開始：3 人（1 猜 2 畫）；猜題者拿不到題目，畫家拿得到卡與題目；人少時不發輔助卡', async () => {
  const { room, conns, players, t, guesser, drawerIds, connOf } = await play(3);
  assert.equal(room.game.phase, 'draw');
  assert.equal(drawerIds.length, 2);
  assert.ok(!drawerIds.includes(t.g));
  for (const c of guesser.sent) assert.ok(!('word' in c) && !JSON.stringify(c).includes(t.word), `猜題者收到不該有的內容：${JSON.stringify(c)}`);
  assert.equal(guesser.last('card'), undefined, '猜題者沒有工具卡');
  for (const id of drawerIds) {
    const c = connOf(id);
    assert.equal(c.last('word').word, t.word);
    const card = cardById(c.last('card').id);
    assert.ok(card && !card.support, '3 人局不發輔助卡');
  }
  const st = guesser.last('state');
  assert.equal(st.g.id, t.g);
  assert.equal(st.len, [...t.word].length, '猜題者只知道字數');
  assert.equal(st.players.length, players.length);
  assert.ok(conns.length === 3);
  room.destroy();
});

test('人多：≥4 位畫家一定有橡皮擦；19 位畫家（卡不夠）也能發完', async () => {
  const a = await play(6);
  const cards = [...a.t.cards.values()].map((x) => x.card.id);
  assert.equal(cards.length, 5);
  assert.ok(cards.includes('eraser'));
  a.room.destroy();
  const b = await play(20);
  assert.equal(b.t.cards.size, 19);
  b.room.destroy();
});

test('作畫：卡不符的操作被拒絕、符合的會廣播給所有人（含猜題者）、墨水回報給本人', async () => {
  const { room, t, guesser, drawerIds, connOf } = await play(3);
  const [d1, d2] = drawerIds;
  giveCard(t, d1, 'ruler');
  giveCard(t, d2, 'compass');
  const c1 = connOf(d1); const c2 = connOf(d2);
  G(room, c1, { t: 'ops', ops: [{ k: 'circle', p: [100, 100], r: 30 }] }); // 直線尺畫圓 ✗
  assert.equal(guesser.all('ops').length, 0);
  assert.equal(c1.last('ink').rej, 1);
  G(room, c1, { t: 'ops', ops: [{ k: 'line', a: [0, 10], b: [800, 10] }] }); // 800px：1.5 + 72 ≈ 73.5 墨水
  const o = guesser.last('ops');
  assert.equal(o.u, d1);
  assert.equal(o.ops[0].k, 'line');
  assert.ok(c2.last('ops'), '其他畫家也收到');
  const ink = c1.last('ink').v;
  assert.ok(ink < 30 && ink > 20, `墨水被扣掉（${ink}）`);
  assert.equal(t.ops.length, 1, '畫在紀錄裡');
  // 猜題者不能畫
  G(room, guesser, { t: 'ops', ops: [{ k: 'line', a: [10, 10], b: [210, 10] }] });
  assert.equal(t.ops.length, 1);
  // 墨水不夠：再畫一條長線被拒絕；時間過去後恢復
  G(room, c1, { t: 'ops', ops: [{ k: 'line', a: [0, 50], b: [800, 50] }] });
  assert.equal(t.ops.length, 1, '墨水不夠');
  t.ink.get(d1).t -= 12000;
  G(room, c1, { t: 'ops', ops: [{ k: 'line', a: [0, 50], b: [800, 50] }] });
  assert.equal(t.ops.length, 2, '12 秒後墨水恢復，可以再畫');
  room.destroy();
});

test('自由手繪的分段會合併成同一筆（紀錄不膨脹），但不連續就不合併', async () => {
  const { room, t, drawerIds, connOf } = await play(3);
  const d = drawerIds[0];
  giveCard(t, d, 'colorpen');
  const c = connOf(d);
  G(room, c, { t: 'ops', ops: [{ k: 'path', s: 1, pts: [[10, 10], [20, 10]] }] });
  G(room, c, { t: 'ops', ops: [{ k: 'path', s: 1, pts: [[20, 10], [30, 10]] }] });
  G(room, c, { t: 'ops', ops: [{ k: 'path', s: 1, pts: [[50, 50], [60, 50]] }] }); // 起點對不上
  assert.equal(t.ops.length, 2);
  assert.deepEqual(t.ops[0].pts, [[10, 10], [20, 10], [30, 10]]);
  room.destroy();
});

test('猜中：猜題者與畫家一起得分；之後不能再畫、不能再猜', async () => {
  const { room, t, game, guesser, drawerIds, connOf } = await play(3);
  G(room, guesser, { t: 'guess', text: '一定不是答案的字串' });
  assert.equal(guesser.last('guess').ok, false);
  assert.equal(game.phase, 'draw');
  G(room, connOf(drawerIds[0]), { t: 'guess', text: t.word }); // 畫家不能猜
  assert.equal(game.phase, 'draw');
  G(room, guesser, { t: 'guess', text: ` ${t.word} ` });
  assert.equal(game.phase, 'roundEnd');
  const e = guesser.last('roundEnd');
  assert.equal(e.solved, true);
  assert.equal(e.word, t.word);
  assert.ok(e.gain.g >= 100 && e.gain.d >= 50);
  const byId = Object.fromEntries(e.ranking.map((r) => [r.id, r]));
  assert.equal(byId[t.g].score, e.gain.g);
  for (const id of drawerIds) assert.equal(byId[id].score, e.gain.d);
  assert.equal(byId[t.g].guessed, 1);
  G(room, connOf(drawerIds[0]), { t: 'ops', ops: [{ k: 'line', a: [10, 10], b: [210, 10] }] });
  assert.equal(game.turn.ops.length, 0, '回合結束後不能再畫');
  room.destroy();
});

test('同義詞：題庫別名直接算對；畫家可以接受猜測，猜題者本人不行', async () => {
  const { room, t, game, guesser, drawerIds, connOf } = await play(3);
  const alias = [...t.answers].find((a) => a !== norm(t.word));
  if (alias) { // 這題有別名：直接猜別名就算對
    G(room, guesser, { t: 'guess', text: alias });
    assert.equal(game.phase, 'roundEnd');
    assert.equal(guesser.last('roundEnd').solved, true);
    room.destroy();
    return;
  }
  G(room, guesser, { t: 'guess', text: '同義詞啦' });
  const gid = guesser.last('guess').id;
  G(room, guesser, { t: 'accept', id: gid }); // 猜題者自己不能接受
  assert.equal(game.phase, 'draw');
  G(room, connOf(drawerIds[1]), { t: 'accept', id: gid });
  assert.equal(game.phase, 'roundEnd');
  const g = guesser.all('guess').at(-1);
  assert.equal(g.ok, true);
  assert.equal(g.by, game.seats.get(drawerIds[1]).nick);
  room.destroy();
});

test('指揮標記：只有畫家看得到', async () => {
  const { room, guesser, drawerIds, connOf } = await play(4);
  const [d1, d2] = drawerIds;
  G(room, connOf(d1), { t: 'ping', x: 9999, y: 100, e: '👉' });
  assert.equal(connOf(d2).last('ping').x, 800, '座標夾限');
  assert.equal(connOf(d1).last('ping').from, room.players.get(d1).nick, '自己也看得到');
  assert.equal(guesser.all('ping').length, 0, '猜題者看不到');
  G(room, guesser, { t: 'ping', x: 1, y: 1, e: '👉' });
  assert.equal(guesser.all('ping').length, 0);
  room.destroy();
});

test('時間到：沒人得分、揭曉答案；房主按下一回合、全部輪完出現總排行', async () => {
  const { room, game, conns, t } = await play(3, { duration: 45 });
  const idx = t.idx;
  G(room, conns[1], { t: 'skip' }); // 非房主沒用
  assert.equal(game.phase, 'draw');
  G(room, conns[0], { t: 'skip' }); // 房主略過 = 中斷
  assert.equal(game.phase, 'roundEnd');
  const e = conns[1].last('roundEnd');
  assert.equal(e.reason, 'abandoned');
  assert.equal(e.solved, false);
  assert.ok(e.ranking.every((r) => r.score === 0));
  G(room, conns[1], { t: 'next' }); // 非房主沒用
  assert.equal(game.phase, 'roundEnd');
  G(room, conns[0], { t: 'next' });
  await sleep(10);
  assert.equal(game.turn.idx, idx + 1);
  assert.notEqual(game.turn.g, t.g, '換人猜');
  for (let i = 0; i < 2; i++) {
    await sleep(60);
    G(room, conns[0], { t: 'skip' });
    G(room, conns[0], { t: 'next' });
  }
  await sleep(20);
  assert.equal(game.phase, 'final');
  const f = conns[2].last('final');
  assert.equal(f.ranking.length, 3);
  assert.equal(f.total, 3);
  room.destroy();
});

test('倒數結束會自動揭曉', async () => {
  const room = new Room('TEST', { ...FAST, turnEndMs: 5000 });
  const conns = [1, 2, 3].map((i) => { const c = fakeConn(); room.join(c, { nick: 'P' + i }); return c; });
  room.handle(conns[0], { t: 'pick', game: 'coopdraw' });
  room.settings.coopdraw = { ...room.getSettings(), duration: 1 }; // 測試用：1 秒
  room.handle(conns[0], { t: 'start' });
  await sleep(1300);
  assert.equal(room.game.phase, 'roundEnd');
  assert.equal(conns[1].last('roundEnd').reason, 'time');
  room.destroy();
});

test('重連：畫家拿回工具卡、題目、畫布與猜測；猜題者拿到畫布但沒有題目', async () => {
  const { room, t, guesser, drawerIds, connOf, players } = await play(3);
  const d = drawerIds[0];
  giveCard(t, d, 'ruler');
  G(room, connOf(d), { t: 'ops', ops: [{ k: 'line', a: [10, 10], b: [210, 10] }] });
  G(room, guesser, { t: 'guess', text: '亂猜一個' });
  // 畫家重連
  const c2 = fakeConn();
  const nick = players.find((p) => p.id === d).nick;
  room.join(c2, { playerId: d, nick });
  assert.equal(c2.last('word').word, t.word);
  assert.equal(c2.last('card').id, 'ruler');
  assert.equal(c2.last('canvas').ops.length, 1);
  assert.equal(c2.last('guess').text, '亂猜一個');
  assert.ok(c2.last('ink'));
  // 猜題者重連
  const g2 = fakeConn();
  room.join(g2, { playerId: t.g, nick: players.find((p) => p.id === t.g).nick });
  assert.equal(g2.last('canvas').ops.length, 1);
  assert.ok(!g2.sent.some((m) => m.t === 'word' || m.t === 'card' || JSON.stringify(m).includes(t.word)), '猜題者重連後仍看不到題目');
  // sync：要求重送畫布（有冷卻）
  const before = c2.all('canvas').length;
  G(room, c2, { t: 'sync' });
  assert.equal(c2.all('canvas').length, before + 1);
  G(room, c2, { t: 'sync' });
  assert.equal(c2.all('canvas').length, before + 1, '冷卻中不重送');
  room.destroy();
});

test('旁觀者看得到畫布與猜測，但拿不到題目、也不能畫', async () => {
  const room = new Room('TEST', { ...FAST });
  const conns = [1, 2, 3, 4].map((i) => { const c = fakeConn(); room.join(c, { nick: 'P' + i }); return c; });
  room.handle(conns[0], { t: 'pick', game: 'coopdraw' });
  room.handle(conns[3], { t: 'role', role: 'spectator' });
  room.handle(conns[0], { t: 'start' });
  await sleep(80);
  const t = room.game.turn;
  assert.equal(t.drawers.length + 1, 3, '旁觀者不參賽');
  const spec = conns[3];
  assert.ok(!spec.sent.some((m) => m.t === 'word' || m.t === 'card' || JSON.stringify(m).includes(t.word)));
  const d = t.drawers[0];
  giveCard(t, d, 'ruler');
  G(room, conns.find((c) => c.sent.some((m) => m.t === 'card' && room.players.get(d).conn === c)), { t: 'ops', ops: [{ k: 'line', a: [10, 10], b: [210, 10] }] });
  assert.equal(spec.last('ops').ops.length, 1, '旁觀者看得到畫');
  G(room, spec, { t: 'ops', ops: [{ k: 'line', a: [10, 100], b: [210, 100] }] });
  assert.equal(t.ops.length, 1, '旁觀者不能畫');
  room.destroy();
});

test('猜題者離線太久：回合中斷、不計分', async () => {
  const { room, game, t, connOf } = await play(3);
  room.disconnect(connOf(t.g));
  await sleep(120); // 超過 staleMs（80ms）、還沒到 dropMs（400ms）；room.tick 由伺服器每秒呼叫，測試直接呼叫
  room.tick();
  assert.equal(game.phase, 'roundEnd');
  assert.equal(game.lastRoundEnd.reason, 'abandoned');
  room.destroy();
});

test('人數不足 3 人：房主不能開始；中途有人離開剩 2 人就直接結算', async () => {
  const room = new Room('TEST', { ...FAST });
  const a = fakeConn(); const b = fakeConn();
  room.join(a, { nick: 'A' }); room.join(b, { nick: 'B' });
  room.handle(a, { t: 'pick', game: 'coopdraw' });
  room.handle(a, { t: 'start' });
  assert.equal(a.last('error').code, 'MIN');
  const c = fakeConn(); room.join(c, { nick: 'C' });
  room.handle(a, { t: 'start' });
  await sleep(60);
  assert.equal(room.phase, 'game');
  room.handle(c, { t: 'leave' });
  assert.equal(room.game.phase, 'final');
  room.destroy();
});

test('設定夾限：回合數、時間、難度、分類', () => {
  const room = new Room('TEST', { ...FAST });
  const a = fakeConn(); room.join(a, { nick: 'A' });
  room.handle(a, { t: 'pick', game: 'coopdraw' });
  room.handle(a, { t: 'settings', settings: { duration: 9999, rounds: 99, difficulty: 'x', category: '不存在' } });
  const s = a.last('hub').settings;
  assert.equal(s.duration, 180);
  assert.equal(s.rounds, 3);
  assert.equal(s.difficulty, 'easy');
  assert.equal(s.category, '__all__');
  room.handle(a, { t: 'settings', settings: { difficulty: 'all', category: Object.keys(bank)[0] } });
  assert.equal(a.last('hub').settings.difficulty, 'all');
});
