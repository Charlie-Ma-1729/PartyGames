// 猜歌大賽（多人）：規則表單、本題結果、最終排行榜的畫面渲染（不含網路邏輯）
import { CATEGORIES } from '../../questions.js';
import { $, el, renderRanking } from '../../hub/view.js';

const NUM_KEYS = ['count', 'duration', 'graceSecs', 'difficulty', 'perWork', 'quorumN', 'quorumSecs', 'autoNext'];
const BOOL_KEYS = ['fromMiddle', 'penalty', 'allowLateJoin'];
const ROOT = '#set-songguess';

/** 讀出規則表單目前的值 */
export function readForm() {
  const s = {};
  s.categories = [...document.querySelectorAll(`${ROOT} #f-categories input:checked`)].map((i) => i.value);
  s.kinds = [...document.querySelectorAll(`${ROOT} #f-kinds input:checked`)].map((i) => i.value);
  document.querySelectorAll(`${ROOT} [data-k]`).forEach((sel) => {
    const k = sel.dataset.k;
    s[k] = NUM_KEYS.includes(k) ? Number(sel.value) : BOOL_KEYS.includes(k) ? sel.value === 'true' : sel.value;
  });
  return s;
}

/** 以伺服器的設定填入表單；題庫勾選區依各題庫題數重建 */
export function fillForm(settings, counts) {
  const box = $('f-categories');
  if (box.dataset.built !== JSON.stringify(counts)) {
    box.replaceChildren();
    CATEGORIES.forEach((c) => {
      const n = counts[c.id] || 0;
      const label = el('label', 'chip' + (n ? '' : ' disabled'));
      const input = document.createElement('input');
      input.type = 'checkbox'; input.value = c.id; input.disabled = !n;
      label.append(input, ` ${c.label}　${n ? n + ' 首' : '即將推出'}`);
      box.append(label);
    });
    box.dataset.built = JSON.stringify(counts);
  }
  box.querySelectorAll('input').forEach((i) => { i.checked = settings.categories.includes(i.value); });
  document.querySelectorAll(`${ROOT} #f-kinds input`).forEach((i) => { i.checked = settings.kinds.includes(i.value); });
  document.querySelectorAll(`${ROOT} [data-k]`).forEach((sel) => {
    const v = String(settings[sel.dataset.k]);
    if (sel.value !== v) sel.value = v;
  });
  // 指定人數／倒數秒數只在需要時顯示
  const hide = (k, on) => { const l = document.querySelector(`${ROOT} [data-k="${k}"]`).closest('label'); l.classList.toggle('hidden', on); };
  hide('quorumN', settings.quorumMode !== 'n');
  hide('quorumSecs', settings.quorumMode === 'off');
}

/** 旁觀者專屬：即時顯示每個人選了什麼（m = null 代表清空） */
export function renderPicks(m, meId, q) {
  const box = $('mpicks');
  const old = document.querySelectorAll('#choices .pk');
  old.forEach((x) => x.remove());
  if (!m || !document.body.classList.contains('is-spectator')) { box.classList.add('hidden'); box.replaceChildren(); return; }
  box.replaceChildren(el('h3', null, '👀 即時作答（只有旁觀者看得到）'));
  m.picks.forEach((p) => {
    const row = el('div', 'mpick' + (p.locked ? ' locked' : '') + (p.failed ? ' failed' : ''));
    const what = p.failed ? '（影片無法播放）' : p.label ? ((q && q.choices && p.choice != null ? `${p.choice + 1}. ` : '') + p.label) : '還沒選…';
    row.append(el('span', 'who', p.nick), el('span', 'what' + (p.label ? '' : ' none'), what), el('span', 'lk', p.locked ? '🔒 已鎖定' : ''));
    box.append(row);
  });
  box.classList.remove('hidden');
  // 選擇題：在每個選項上標出選它的人
  const cards = [...document.querySelectorAll('#choices .choice')];
  m.picks.forEach((p) => {
    if (p.choice == null || !cards[p.choice]) return;
    let pk = cards[p.choice].querySelector('.pk');
    if (!pk) { pk = el('span', 'pk'); cards[p.choice].append(pk); }
    pk.append(el('i', p.locked ? 'on' : '', p.nick));
  });
}

const fmtMs = (ms) => (ms == null ? '' : `${(ms / 1000).toFixed(1)}s`);

/** 最終排行榜（頒獎台 + 完整表格） */
export function renderFinal(ranking, meId, total) {
  $('f-sub').textContent = `共 ${total} 題`;
  renderRanking({ podium: $('f-podium'), table: $('f-table') }, ranking, meId,
    (r) => `答對 ${r.correct}/${r.answered}${r.avgMs != null ? `・平均 ${fmtMs(r.avgMs)}` : ''}`);
}

/** 本題結果（揭曉時） */
export function renderReveal(m, meId) {
  const box = $('mreveal');
  box.replaceChildren();
  box.append(el('h3', null, `本題結果${m.reason === 'quorum' ? '（鎖定人數達標，倒數結束）' : m.reason === 'time' ? '（時間到）' : ''}`));
  const byId = new Map(m.rows.map((r) => [r.id, r]));
  const order = m.ranking.filter((r) => byId.has(r.id));
  order.forEach((rk) => {
    const row = byId.get(rk.id);
    const r = el('div', 'mrow' + (rk.id === meId ? ' me' : ''));
    r.append(el('span', 'rk', String(rk.rank)));
    const nm = el('span', 'nm', rk.nick);
    const pickText = row.failed ? '（本題影片無法播放）' : row.pick ? `選了「${row.pick}」` : '未作答';
    nm.append(el('small', null, pickText));
    const pt = el('span', 'pt ' + (row.correct ? 'ok' : row.points < 0 ? 'bad' : ''), row.failed ? '—' : (row.correct ? '✔ ' : row.answered ? '✘ ' : '') + (row.points > 0 ? `+${row.points}` : row.points < 0 ? `${row.points}` : '0'));
    r.append(nm, pt, el('span', 'tt', `${row.total}`));
    box.append(r);
  });
  box.classList.remove('hidden');
}
