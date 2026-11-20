import test from 'node:test';
import assert from 'node:assert/strict';
import { Room } from '../server/room.mjs';
import { cleanSettings, clipStart, scoreTurn, FIRST_BASE, FIRST_SPEED, SINGER_PER } from '../server/games/soramimi.mjs';
import { byId } from '../server/bank.mjs';

const FAST = { preloadMs: 60, staleMs: 80, lobbyDropMs: 100, dropMs: 400, turnEndMs: 100, singCountdownMs: 10 };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function fakeConn() {
  return { sent: [], send(m) { this.sent.push(m.t === 'g' ? m.m : m); }, close() {}, last(t) { return [...this.sent].reverse().find((m) => m.t === t); }, all(t) { return this.sent.filter((m) => m.t === t); } };
}
const G = (room, conn, m) => room.handle(conn, { t: 'g', m });
const ph = (room) => (room.game ? room.game.phase : 'lobby');

function setup(n, settings = {}) {
  const room = new Room('SORA', FAST);
  const conns = []; const players = [];
  for (let i = 0; i < n; i++) {
    const c = fakeConn();
    const r = room.join(c, { nick: 'P' + (i + 1) });
    assert.ok(r.player, r.error && r.error.msg);
    conns.push(c); players.push(r.player);
  }
  room.gameId = 'soramimi';
  room.settings.soramimi = { ...cleanSettings({ perPlayer: 3, autoNext: 0, ...settings }), ...settings };
  room.handle(conns[0], { t: 'start' });
  return { room, conns, players };
}

/** 每人隨機補滿並按準備 → 自動開始第一回合 */
function pickAll(room, conns) {
  conns.forEach((c) => G(room, c, { t: 'fill' }));
  conns.forEach((c) => G(room, c, { t: 'ready', on: true }));
}
const singerIdx = (room, players) => players.findIndex((p) => p.id === room.game.turn.singerId);
const toSing = (room, conns, players) => { G(room, conns[singerIdx(room, players)], { t: 'ready', idx: room.game.turn.idx }); };

test('計分：第一個猜對的人固定分＋速度加成；歌手每多一人猜對多 SINGER_PER', () => {
  assert.deepEqual(scoreTurn({ correctCount: 0, remainingFrac: 1 }), { first: 0, later: 0, singer: 0 });
  assert.equal(scoreTurn({ correctCount: 1, remainingFrac: 0 }).first, FIRST_BASE);
  assert.equal(scoreTurn({ correctCount: 1, remainingFrac: 1 }).first, FIRST_BASE + FIRST_SPEED);
  assert.ok(scoreTurn({ correctCount: 1, remainingFrac: 0.8 }).first > scoreTurn({ correctCount: 1, remainingFrac: 0.2 }).first);
  assert.equal(scoreTurn({ correctCount: 1 }).singer, SINGER_PER);
  assert.equal(scoreTurn({ correctCount: 3 }).singer, 3 * SINGER_PER);
  assert.ok(scoreTurn({ correctCount: 3 }).singer > scoreTurn({ correctCount: 2 }).singer);
});

test('設定夾限', () => {
  const s = cleanSettings({ perPlayer: 999, rounds: 0, clipSecs: 1, singSecs: 9999, answerMode: 'x', categories: ['nope'], autoNext: 1 });
  assert.equal(s.perPlayer, 20); assert.equal(s.rounds, 1); assert.equal(s.clipSecs, 10); assert.equal(s.singSecs, 180);
  assert.equal(s.answerMode, 'choice'); assert.ok(s.categories.length >= 1); assert.equal(s.autoNext, 3);
});

test('挑歌：搜尋、加入、上限、移除；沒選滿不能準備；全員準備後自動開始', () => {
  const { room, conns, players } = setup(3);
  assert.equal(ph(room), 'picking');
  assert.equal(conns[0].last('mine').max, 3);
  G(room, conns[0], { t: 'fill' });
  const mine = conns[0].last('mine');
  assert.equal(mine.picks.length, 3);
  G(room, conns[0], { t: 'add', id: [...byId.keys()][0] });
  assert.match(conns[0].last('pickError').msg, /最多/);
  G(room, conns[0], { t: 'remove', id: mine.picks[0].id });
  assert.equal(conns[0].last('mine').picks.length, 2);
  G(room, conns[0], { t: 'ready', on: true });
  assert.match(conns[0].last('pickError').msg, /選滿/);
  G(room, conns[0], { t: 'search', q: mine.picks[1].main.slice(0, 2) });
  assert.ok(conns[0].last('results').list.length > 0);
  G(room, conns[0], { t: 'add', id: mine.picks[0].id });
  // 別人看不到我的歌（state 只有數量）
  const st = conns[1].last('state');
  assert.equal(st.players.find((p) => p.id === players[0].id).picks, 3);
  assert.equal(JSON.stringify(st).includes(mine.picks[0].id), false);
  conns.slice(1).forEach((c) => G(room, c, { t: 'fill' }));
  conns.forEach((c) => G(room, c, { t: 'ready', on: true }));
  assert.equal(ph(room), 'intro');
});

test('只有歌手收到 ytId；公開的 turn／state／reveal 都不含影片編號與答案索引', () => {
  const { room, conns, players } = setup(4);
  pickAll(room, conns);
  const si = singerIdx(room, players);
  const ytId = room.game.turn.q.ytId;
  assert.ok(ytId);
  conns.forEach((c, i) => {
    if (i === si) { assert.equal(c.all('song').length, 1); assert.equal(c.last('song').ytId, ytId); }
    else assert.equal(c.all('song').length, 0);
  });
  toSing(room, conns, players);
  assert.equal(ph(room), 'sing');
  // 歌手斷線重連的快照只補給歌手
  const rejoin = fakeConn();
  room.game.snapshot(rejoin, players[(si + 1) % 4]); // 非歌手重連：不會補送 song
  assert.equal(rejoin.all('song').length, 0);
  assert.equal(JSON.stringify(rejoin.sent).includes(ytId), false);
  const rejoinSinger = fakeConn();
  room.game.snapshot(rejoinSinger, players[si]);
  assert.equal(rejoinSinger.all('song').length, 1);
  conns.forEach((c, i) => { if (i !== si) assert.equal(JSON.stringify(c.sent).includes(ytId), false, '非歌手的任何訊息都不能含 ytId'); });
  const turn = conns[(si + 1) % 4].last('turn');
  assert.equal(turn.choices.length, 8);
  assert.equal(turn.choices.some((c) => 'correct' in c), false);
  assert.equal(JSON.stringify(turn).includes(ytId), false);
});

test('8 選 1：選項不重複且含正解；每人只能猜一次；歌手不能猜；猜完自動揭曉', () => {
  const { room, conns, players } = setup(4);
  pickAll(room, conns);
  toSing(room, conns, players);
  const si = singerIdx(room, players);
  const t = room.game.turn;
  const labels = t.choices.map((c) => c.main + '|' + c.sub);
  assert.equal(new Set(labels).size, t.choices.length);
  assert.equal(t.choices[t.correctIdx].main, t.label.main);
  const others = conns.map((c, i) => i).filter((i) => i !== si);
  G(room, conns[si], { t: 'guess', idx: t.idx, choice: t.correctIdx }); // 歌手猜：忽略
  assert.equal(t.guesses.size, 0);
  const wrong = (t.correctIdx + 1) % 8;
  G(room, conns[others[0]], { t: 'guess', idx: t.idx, choice: t.correctIdx });
  G(room, conns[others[0]], { t: 'guess', idx: t.idx, choice: wrong }); // 第二次：忽略
  assert.equal(t.guesses.get(players[others[0]].id).correct, true);
  G(room, conns[others[1]], { t: 'guess', idx: t.idx, choice: 99 }); // 不合法
  assert.equal(t.guesses.has(players[others[1]].id), false);
  assert.equal(ph(room), 'sing');
  G(room, conns[others[1]], { t: 'guess', idx: t.idx, choice: t.correctIdx });
  G(room, conns[others[2]], { t: 'guess', idx: t.idx, choice: wrong });
  assert.equal(ph(room), 'reveal', '全員猜完就揭曉');
  const rv = conns[0].last('reveal');
  assert.equal(rv.reason, 'all');
  assert.equal(rv.correctCount, 2);
  const byIdRow = Object.fromEntries(rv.rows.map((r) => [r.id, r]));
  assert.ok(byIdRow[players[others[0]].id].first);
  assert.ok(byIdRow[players[others[0]].id].points >= FIRST_BASE);
  assert.equal(byIdRow[players[others[1]].id].points, 0, '第二個猜對的不得分');
  assert.equal(byIdRow[players[others[2]].id].points, 0);
  assert.equal(rv.singer.points, 2 * SINGER_PER, '歌手分數 = 猜對人數 × SINGER_PER');
  assert.equal(room.game.seats.get(players[si].id).score, 2 * SINGER_PER);
});

test('歌手分數隨猜對人數增加；沒人猜對 = 0（時間到）', async () => {
  const run = async (nCorrect) => {
    const { room, conns, players } = setup(4, { singSecs: 20 });
    pickAll(room, conns);
    toSing(room, conns, players);
    const si = singerIdx(room, players);
    const t = room.game.turn;
    const others = conns.map((c, i) => i).filter((i) => i !== si);
    others.slice(0, nCorrect).forEach((i) => G(room, conns[i], { t: 'guess', idx: t.idx, choice: t.correctIdx }));
    G(room, conns[0], { t: 'forceReveal' });
    assert.equal(ph(room), 'reveal');
    return conns[0].last('reveal').singer.points;
  };
  const p0 = await run(0); const p1 = await run(1); const p3 = await run(3);
  assert.equal(p0, 0);
  assert.ok(p1 > p0 && p3 > p1);
});

test('硬性時限：沒人猜也會揭曉', async () => {
  const { room, conns, players } = setup(3, { singSecs: 20 });
  room.settings.soramimi.singSecs = 0.1;
  pickAll(room, conns);
  toSing(room, conns, players);
  await sleep(250);
  assert.equal(ph(room), 'reveal');
  assert.equal(conns[0].last('reveal').reason, 'time');
  assert.equal(conns[0].last('reveal').singer.points, 0);
});

test('搜尋模式：公開候選清單（不含影片編號）、以索引猜', () => {
  const { room, conns, players } = setup(3, { answerMode: 'search' });
  pickAll(room, conns);
  toSing(room, conns, players);
  const si = singerIdx(room, players);
  const t = room.game.turn;
  const turn = conns[(si + 1) % 3].last('turn');
  assert.equal(turn.choices, null);
  assert.ok(turn.pool.length >= 3);
  assert.equal(JSON.stringify(turn).includes(t.q.ytId), false);
  const gi = (si + 1) % 3;
  G(room, conns[gi], { t: 'guess', idx: t.idx, pool: t.correctPool });
  assert.equal(t.guesses.get(players[gi].id).correct, true);
});

test('歌手影片無法播放 → 略過這一回合（不計分）並換下一位；每人輪完進最終排行榜', () => {
  const { room, conns, players } = setup(3);
  pickAll(room, conns);
  const first = room.game.turn.singerId;
  G(room, conns[singerIdx(room, players)], { t: 'playError', idx: room.game.turn.idx });
  assert.ok(conns[0].last('skipped'));
  assert.notEqual(room.game.turn.singerId, first);
  // 其餘兩位各唱一次、全員沒人猜 → 房主強制揭曉 → 下一位
  for (let i = 0; i < 2; i++) {
    toSing(room, conns, players);
    G(room, conns[0], { t: 'forceReveal' });
    assert.equal(ph(room), 'reveal');
    G(room, conns[0], { t: 'next' });
  }
  assert.equal(ph(room), 'final');
  const fin = conns[0].last('final');
  assert.equal(fin.ranking.length, 3);
  assert.equal(fin.total, 3);
});

test('歌手離開 → 略過這一回合；旁觀者不佔座位', () => {
  const { room, conns, players } = setup(3);
  pickAll(room, conns);
  const si = singerIdx(room, players);
  const idx = room.game.turn.idx;
  room.handle(conns[si], { t: 'leave' });
  assert.ok(conns[(si + 1) % 3].last('skipped'));
  assert.ok(room.game.turn === null || room.game.turn.idx !== idx || ph(room) === 'final');
});

test('純音樂（kind=OST）不能選：搜尋不出現、手動加入被拒、隨機補滿不會抽到；設定也不開放 ost 題庫', () => {
  const ost = [...byId.values()].find((h) => h.q.kind === 'OST' && h.cat !== 'ost');
  const { room, conns, players } = setup(3, { perPlayer: 20 });
  assert.equal(room.settings.soramimi.categories.includes('ost'), false);
  if (ost) {
    G(room, conns[0], { t: 'add', id: ost.q.id });
    assert.match(conns[0].last('pickError').msg, /純音樂/);
    assert.equal(conns[0].last('mine').picks.length, 0);
    const a = ost.q.answer || {};
    G(room, conns[0], { t: 'search', q: (a.title || a.work).slice(0, 3) });
    assert.equal(conns[0].last('results').list.some((x) => byId.get(x.id).q.kind === 'OST'), false);
  }
  G(room, conns[0], { t: 'fill' });
  const picks = conns[0].last('mine').picks;
  assert.equal(picks.length, 20);
  assert.equal(picks.some((p) => byId.get(p.id).q.kind === 'OST'), false);
  const s = cleanSettings({ categories: ['ost'] });
  assert.equal(s.categories.includes('ost'), false);
  assert.ok(s.categories.length >= 1);
});

test('原曲只會在倒數後自動開播一次：sing 訊息帶 startAt（在未來）且歌手拿到的 song 只有一則；時限從開播起算', () => {
  const { room, conns, players } = setup(3, { singSecs: 30 });
  room.T.singCountdownMs = 3000; // 正式的倒數
  pickAll(room, conns);
  const si = singerIdx(room, players);
  const before = Date.now();
  toSing(room, conns, players);
  const sing = conns[(si + 1) % 3].last('sing');
  assert.ok(sing.startAt >= before + 2900 && sing.startAt <= Date.now() + 3100);
  assert.equal(sing.endsAt - sing.startAt, 30 * 1000);
  assert.equal(conns[si].all('song').length, 1, '歌手只收到一次 song（沒有重播的管道）');
  // 重複的 ready 不會重新倒數
  G(room, conns[si], { t: 'ready', idx: room.game.turn.idx });
  assert.equal(conns[(si + 1) % 3].all('sing').length, 1);
});

test('選歌清單：不打字也能逐頁瀏覽整份歌單（分頁、可依題庫篩選、沒有純音樂）', () => {
  const { room, conns } = setup(2);
  G(room, conns[0], { t: 'search', q: '', offset: 0 });
  const p1 = conns[0].last('results');
  assert.equal(p1.q, ''); assert.equal(p1.offset, 0);
  assert.ok(p1.list.length > 0 && p1.list.length <= 40);
  assert.ok(p1.total >= p1.list.length);
  assert.ok(p1.list.every((x) => x.main && byId.get(x.id).q.kind !== 'OST'));
  if (p1.total > p1.list.length) {
    G(room, conns[0], { t: 'search', q: '', offset: p1.list.length });
    const p2 = conns[0].last('results');
    assert.equal(p2.offset, p1.list.length);
    assert.ok(p2.list.length > 0);
    assert.equal(new Set([...p1.list, ...p2.list].map((x) => x.id)).size, p1.list.length + p2.list.length, '頁與頁之間不重複');
  }
  const cat = room.game.settings.categories[0];
  G(room, conns[0], { t: 'search', q: '', cat, offset: 0 });
  const pc = conns[0].last('results');
  assert.ok(pc.list.every((x) => x.cat === cat));
  G(room, conns[0], { t: 'search', q: '', cat: 'not-a-cat', offset: -5 });
  const bad = conns[0].last('results');
  assert.equal(bad.cat, ''); assert.equal(bad.offset, 0, '亂填的題庫與位移會被夾成預設值');
});

test('歌單是全部人混在一起抽：歌手不會唱到自己選的歌（連同名同歌手的也不會）', () => {
  const { room, conns, players } = setup(3, { rounds: 3, perPlayer: 4 });
  pickAll(room, conns);
  const g = room.game;
  assert.equal(g.turns.length, 9, '每人 3 次');
  const keyOfId = (id) => { const l = g._labelOf(id); return `${l.main}|${l.sub}`.toLowerCase(); };
  for (const t of g.turns) {
    const mine = g.seats.get(t.singerId).picks;
    assert.equal(mine.includes(t.songId), false, '不會抽到自己選的歌');
    assert.equal(mine.map(keyOfId).includes(keyOfId(t.songId)), false, '同名的歌也算自己的');
  }
  // 歌來自別人的題庫，而且在還有沒唱過的歌時不重複
  const others = (sid) => players.filter((p) => p.id !== sid).flatMap((p) => g.seats.get(p.id).picks);
  assert.ok(g.turns.every((t) => others(t.singerId).includes(t.songId)));
  const distinct = new Set(g.turns.map((t) => keyOfId(t.songId))).size;
  assert.ok(distinct >= Math.min(9, 6), '盡量不重複');
});

test('只有一個人選歌：他自己沒有歌可唱（略過），沒選歌的人改唱他的歌；全都沒選歌則不開始', () => {
  const { room, conns, players } = setup(3);
  G(room, conns[1], { t: 'begin' }); // 非房主：忽略
  G(room, conns[0], { t: 'begin' });
  assert.equal(ph(room), 'picking', '誰都沒選歌：不開始');
  assert.ok(conns[0].last('skipped'));
  G(room, conns[0], { t: 'fill' });
  G(room, conns[0], { t: 'begin' });
  assert.equal(ph(room), 'intro');
  const singers = room.game.turns.map((t) => t.singerId);
  assert.equal(singers.includes(players[0].id), false, '選歌的人自己沒有別人的歌可唱');
  assert.equal(singers.length, 2);
});

test('起播位置：從頭／從中間／固定第 N 秒（歌手收到的 start 隨設定改變）', () => {
  assert.equal(cleanSettings({ startMode: 'x' }).startMode, 'begin');
  assert.equal(cleanSettings({ startMode: 'fixed', startSec: 15 }).startSec, 15);
  assert.equal(cleanSettings({ startSec: 9999 }).startSec, 120);
  assert.equal(clipStart({ start: 0, mid: 53 }, { startMode: 'begin', startSec: 15 }), 0);
  assert.equal(clipStart({ start: 0, mid: 53 }, { startMode: 'middle', startSec: 15 }), 53);
  assert.equal(clipStart({ start: 0 }, { startMode: 'middle', startSec: 15 }), 0, '沒有中間資料就從頭');
  assert.equal(clipStart({ start: 0, mid: 53 }, { startMode: 'fixed', startSec: 15 }), 15);
  for (const [mode, check] of [['fixed', (st) => st === 15], ['begin', (st, q) => st === (q.start || 0)], ['middle', (st, q) => st === (q.mid != null ? q.mid : (q.start || 0))]]) {
    const { room, conns, players } = setup(3, { startMode: mode, startSec: 15 });
    pickAll(room, conns);
    const song = conns[singerIdx(room, players)].last('song');
    assert.ok(check(song.start, room.game.turn.q), `${mode}: start=${song.start}`);
  }
});

test('已經公布過的歌不會再出現在後面的選項裡（不能用刪去法）；結果公布時附上影片與歌手聽到的起點', () => {
  const { room, conns, players } = setup(4, { rounds: 3, perPlayer: 6, startMode: 'fixed', startSec: 15 });
  pickAll(room, conns);
  const answered = [];
  let guard = 0;
  while (ph(room) !== 'final' && guard++ < 30) {
    const t = room.game.turn;
    const si = singerIdx(room, players);
    const songMsg = conns[si].last('song');
    const turnMsg = conns[(si + 1) % 4].last('turn');
    for (const key of answered) {
      assert.equal(turnMsg.choices.some((c) => `${c.main}\u0001${c.sub}` === key), false, '前面公布過的答案不會變成干擾項');
    }
    toSing(room, conns, players);
    G(room, conns[0], { t: 'forceReveal' });
    const rv = conns[0].last('reveal');
    assert.equal(rv.video.ytId, t.q.ytId, '結果公布時才附上影片');
    assert.equal(rv.video.start, songMsg.start, '預覽起點 = 歌手聽到的起點');
    assert.equal(rv.video.start, 15);
    answered.push(`${rv.answer.main}\u0001${rv.answer.sub}`);
    G(room, conns[0], { t: 'next' });
  }
  assert.equal(ph(room), 'final');
  assert.equal(answered.length, 12);
});

test('固定歌手：其他人挑歌、全部給他唱；歌手不挑歌、不用準備', () => {
  assert.equal(cleanSettings({ singerMode: 'x' }).singerMode, 'rotate');
  assert.equal(cleanSettings({ singerMode: 'fixed', fixedSingerId: 'not valid!' }).fixedSingerId, '');
  const room = new Room('SORF', FAST);
  const conns = []; const players = [];
  for (let i = 0; i < 4; i++) { const c = fakeConn(); players.push(room.join(c, { nick: 'P' + (i + 1) }).player); conns.push(c); }
  room.gameId = 'soramimi';
  room.settings.soramimi = { ...cleanSettings({ perPlayer: 3, autoNext: 0 }), singerMode: 'fixed', fixedSingerId: '' };
  room.handle(conns[0], { t: 'start' });
  assert.equal(ph(room), 'lobby', '沒指定固定歌手不能開始');
  assert.equal(conns[0].last('error').code, 'NO_SINGER');
  room.settings.soramimi.fixedSingerId = players[1].id;
  room.handle(conns[0], { t: 'start' });
  assert.equal(ph(room), 'picking');
  assert.equal(conns[0].last('state').fixedSinger, players[1].id);
  // 歌手不能挑歌／補滿；他視為已準備
  G(room, conns[1], { t: 'fill' });
  assert.equal(room.game.seats.get(players[1].id).picks.length, 0);
  G(room, conns[1], { t: 'add', id: [...byId.keys()][0] });
  assert.match(conns[1].last('pickError').msg, /固定歌手/);
  assert.equal(conns[1].last('mine').max, 0);
  // 其他三人挑滿並準備 → 自動開始
  [0, 2, 3].forEach((i) => G(room, conns[i], { t: 'fill' }));
  [0, 2].forEach((i) => G(room, conns[i], { t: 'ready', on: true }));
  assert.equal(ph(room), 'picking', '還有人沒準備');
  G(room, conns[3], { t: 'ready', on: true });
  assert.equal(ph(room), 'intro');
  const g = room.game;
  const picks = new Set([0, 2, 3].flatMap((i) => g.seats.get(players[i].id).picks.map((id) => { const l = g._labelOf(id); return `${l.main}|${l.sub}`; })));
  assert.equal(g.turns.length, picks.size, '大家挑的歌（去重）全部給他唱');
  assert.ok(g.turns.every((t) => t.singerId === players[1].id));
  assert.equal(conns[1].last('song').ytId, g.turn.q.ytId, '只有固定歌手收到影片');
  [0, 2, 3].forEach((i) => assert.equal(conns[i].all('song').length, 0));
});
