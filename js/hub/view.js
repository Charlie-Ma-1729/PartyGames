// 房間大廳與各遊戲共用的畫面小工具（純 DOM 渲染，不含網路邏輯）
export const $ = (id) => document.getElementById(id);

export function el(tag, cls, text) {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  if (text != null) e.textContent = text;
  return e;
}

/** 大廳玩家列表（房主可看到 ✕ 踢人） */
export function renderPlayers(hub, meId, isHost, onKick) {
  const box = $('l-players');
  box.replaceChildren();
  hub.players.forEach((p) => {
    const chip = el('span', 'pchip' + (p.id === meId ? ' me' : '') + (p.connected ? '' : ' off'));
    chip.append((p.id === hub.hostId ? '👑 ' : '') + p.nick);
    if (isHost && p.id !== meId) {
      const b = el('button', null, '✕');
      b.title = '移出房間';
      b.addEventListener('click', () => onKick(p.id, p.nick));
      chip.append(b);
    }
    box.append(chip);
  });
  const sc = hub.screens ? `　🖥 主畫面 ×${hub.screens}` : '';
  $('l-count').textContent = `（${hub.players.length} 人）${sc}`;
}

/**
 * 遊戲選單卡片。items = [{id, icon, name, desc, min, max}]；selected = 目前選的；
 * canPick = 房主才能點；onPick(id)
 */
export function renderGameCards(box, items, selected, canPick, onPick) {
  box.replaceChildren();
  items.forEach((g) => {
    const card = el('button', 'gcard' + (g.id === selected ? ' on' : '') + (canPick ? '' : ' ro'));
    card.type = 'button';
    card.dataset.game = g.id;
    const range = g.min === g.max ? `${g.min} 人` : g.max >= 20 ? `${g.min} 人以上` : `${g.min}–${g.max} 人`;
    card.append(el('span', 'gicon', g.icon), el('span', 'gname', g.name), el('span', 'gdesc', g.desc), el('span', 'gmeta', `👥 ${range}`));
    if (canPick) card.addEventListener('click', () => onPick(g.id));
    else card.disabled = true;
    box.append(card);
  });
}

export const MEDAL = ['🥇', '🥈', '🥉'];

/** 一列排名：rank / 暱稱（+小字）/ 分數 */
export function rankRow({ rank, nick, sub, right, me }) {
  const r = el('div', 'mrow' + (me ? ' me' : ''));
  r.append(el('span', 'rk', String(rank)));
  const nm = el('span', 'nm', nick);
  if (sub) nm.append(el('small', null, sub));
  r.append(nm, el('span', 'pt', right), el('span', 'tt', ''));
  return r;
}

/**
 * 最終排行榜：頒獎台 + 完整表格。ranking = [{id, nick, score, rank}]；sub(row) → 小字（可省略）
 */
export function renderRanking({ podium, table }, ranking, meId, sub = () => '') {
  podium.replaceChildren();
  const top = ranking.filter((r) => r.rank <= 3).slice(0, 3);
  const order = top.length === 3 ? [1, 0, 2] : top.map((_, i) => i); // 2、1、3 的擺放順序
  order.forEach((i) => {
    const r = top[i];
    if (!r) return;
    const d = el('div', `pod p${r.rank}`);
    d.append(el('div', 'medal', MEDAL[r.rank - 1] || ''), el('div', 'pn', r.nick), el('div', 'ps', `${r.score} 分`), el('div', 'pm', sub(r)));
    podium.append(d);
  });
  table.replaceChildren();
  ranking.forEach((r) => {
    table.append(rankRow({ rank: r.rank, nick: r.nick, me: r.id === meId, sub: sub(r), right: `${r.score}` }));
  });
}
