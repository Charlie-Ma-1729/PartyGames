// 「從題庫挑一首歌」的共用元件（猜歌的出題者、空耳歌王的選歌都用）。
// 一打開就直接列出整份歌單，可以用手指／滑鼠一路往下滑（接近底部自動載入下一頁）；
// 上面有題庫下拉選單與搜尋框，想縮小範圍再用，不用打字也能挑。
// 只管畫面：需要資料時呼叫 onSearch({ q, cat, offset })；呼叫端把伺服器的 results 訊息交給 setResults(msg)；點一首呼叫 onPick(item)。
// item = { id, cat, main, sub }。
import { el } from './view.js';
import { CATEGORIES } from '../questions.js';

/** 把設定裡勾選的題庫 id 轉成下拉選單用的 { id, label }（去掉標籤後面的括號說明） */
export const catOptions = (ids) => CATEGORIES.filter((c) => (ids || []).includes(c.id)).map((c) => ({ id: c.id, label: c.label.replace(/[（(].*$/, '').trim() }));

export function createPicker({ placeholder = '搜尋歌名、歌手或作品名…', onSearch, onPick, delay = 300, cats = [] } = {}) {
  const root = el('div', 'songpicker');
  const bar = el('div', 'sp-bar');
  const sel = el('select', 'sp-cat');
  const input = el('input');
  input.type = 'search';
  input.placeholder = placeholder;
  input.autocomplete = 'off';
  input.spellcheck = false;
  input.maxLength = 40;
  bar.append(sel, input);
  const hint = el('p', 'sp-hint', '載入中…');
  const list = el('ul', 'sp-list');
  root.append(bar, hint, list);

  let timer = null;
  let q = '';
  let cat = '';
  let total = 0;
  let loading = false;
  let loaded = false;
  let marked = new Set();
  const items = [];

  function setHint() {
    let t = '';
    if (loading && !items.length) t = '載入中…';
    else if (!items.length) t = loaded ? '找不到，換個關鍵字或題庫試試' : '';
    else t = `共 ${total} 首${items.length < total ? '，往下滑載入更多' : ''}`;
    hint.textContent = t;
    hint.classList.toggle('hidden', !t);
  }

  function request(reset) {
    if (reset) { items.length = 0; total = 0; list.replaceChildren(); list.scrollTop = 0; loaded = false; }
    loading = true;
    setHint();
    onSearch({ q, cat, offset: items.length });
  }

  function addRows(rows) {
    for (const it of rows) {
      const li = el('li', marked.has(it.id) ? 'on' : '');
      li.dataset.id = it.id;
      li.append(el('b', null, it.main));
      if (it.sub) li.append(el('small', null, it.sub));
      li.append(el('span', 'sp-tag', '已選'));
      li.addEventListener('click', () => onPick(it));
      list.append(li);
    }
  }

  let catsKey = null;
  function setCats(arr) {
    const key = (arr || []).map((c) => c.id).join(',');
    if (key === catsKey) return; // 沒變就不重建（重建會把使用者正打開的下拉選單收掉）
    const first = catsKey === null;
    catsKey = key;
    const keep = sel.value;
    sel.replaceChildren();
    const all = el('option', null, '所有題庫');
    all.value = '';
    sel.append(all);
    for (const c of arr || []) { const o = el('option', null, c.label); o.value = c.id; sel.append(o); }
    sel.value = [...sel.options].some((o) => o.value === keep) ? keep : '';
    sel.classList.toggle('hidden', (arr || []).length < 2);
    cat = sel.value;
    if (!first && (loaded || loading)) request(true); // 可選的題庫變了（房主改了設定）→ 重新列出
  }
  setCats(cats);

  sel.addEventListener('change', () => { cat = sel.value; request(true); });
  input.addEventListener('input', () => {
    clearTimeout(timer);
    timer = setTimeout(() => { const v = input.value.trim(); if (v !== q) { q = v; request(true); } }, delay);
  });
  input.addEventListener('keydown', (e) => {
    if (e.key !== 'Enter') return;
    e.preventDefault();
    clearTimeout(timer);
    const v = input.value.trim();
    if (v !== q) { q = v; request(true); return; }
    const first = list.querySelector('li');
    if (first) first.click();
  });
  list.addEventListener('scroll', () => {
    if (loading || items.length >= total) return;
    if (list.scrollTop + list.clientHeight >= list.scrollHeight - 120) request(false);
  });

  return {
    el: root,
    input,
    setCats,
    /** 伺服器的 results 訊息 { q, cat, offset, total, list }；跟目前條件不符（過期）的會被忽略 */
    setResults(m) {
      if (!m || m.q !== q || (m.cat || '') !== cat || m.offset !== items.length) return;
      loading = false; loaded = true;
      total = m.total || 0;
      const rows = Array.isArray(m.list) ? m.list : [];
      items.push(...rows);
      addRows(rows);
      setHint();
      // 第一頁剛好塞不滿清單（沒得滑）而後面還有 → 補載下一頁
      if (items.length < total && list.scrollHeight <= list.clientHeight + 4) request(false);
    },
    /** 標記已選過的歌（以 id 判斷） */
    mark(ids) {
      marked = new Set(ids);
      for (const li of list.children) li.classList.toggle('on', marked.has(li.dataset.id));
    },
    /** 還沒載入過就載入第一頁（要顯示選歌畫面時呼叫） */
    open() { if (!loaded && !loading) request(true); },
    /** 清掉關鍵字，重新從頭列出 */
    clear() { clearTimeout(timer); input.value = ''; q = ''; request(true); },
    focus() { input.focus(); },
  };
}
