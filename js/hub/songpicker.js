// 「搜尋題庫、點一首歌」的共用元件（猜歌的出題者、空耳歌王的選歌都用）。
// 只管畫面：輸入框 → debounce 後呼叫 onSearch(q)；呼叫端把伺服器回來的結果交給 setResults(list)；點選一首呼叫 onPick(item)。
// item = { id, cat, main, sub }（伺服器的 searchBank 格式）。
import { el } from './view.js';

export function createPicker({ placeholder = '輸入歌名、歌手或作品名搜尋…', onSearch, onPick, delay = 300 } = {}) {
  const root = el('div', 'songpicker');
  const input = el('input');
  input.type = 'search';
  input.placeholder = placeholder;
  input.autocomplete = 'off';
  input.spellcheck = false;
  input.maxLength = 40;
  const list = el('ul', 'sp-list');
  const hint = el('p', 'sp-hint', '輸入關鍵字開始搜尋');
  root.append(input, hint, list);

  let timer = null;
  let last = '';
  let marked = new Set();

  const run = () => {
    const q = input.value.trim();
    if (q === last) return;
    last = q;
    if (!q) { list.replaceChildren(); hint.textContent = '輸入關鍵字開始搜尋'; hint.classList.remove('hidden'); return; }
    hint.textContent = '搜尋中…'; hint.classList.remove('hidden');
    onSearch(q);
  };
  input.addEventListener('input', () => { clearTimeout(timer); timer = setTimeout(run, delay); });
  input.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') { e.preventDefault(); clearTimeout(timer); run(); const first = list.querySelector('li[data-i]'); if (first) first.click(); }
  });

  let items = [];
  function render() {
    list.replaceChildren();
    items.forEach((it, i) => {
      const li = el('li', marked.has(it.id) ? 'on' : '');
      li.dataset.i = String(i);
      li.append(el('b', null, it.main));
      if (it.sub) li.append(el('small', null, it.sub));
      if (marked.has(it.id)) li.append(el('span', 'sp-tag', '已選'));
      li.addEventListener('click', () => onPick(it));
      list.append(li);
    });
  }

  return {
    el: root,
    input,
    /** 伺服器回來的搜尋結果（q = 該次的查詢字，過期的結果會被忽略） */
    setResults(results, q) {
      if (q !== undefined && q !== last) return;
      items = Array.isArray(results) ? results : [];
      hint.textContent = items.length ? '' : '找不到，換個關鍵字試試';
      hint.classList.toggle('hidden', items.length > 0);
      render();
    },
    /** 標記已選過的歌（以 id 判斷） */
    mark(ids) { marked = new Set(ids); render(); },
    clear() { clearTimeout(timer); input.value = ''; last = ''; items = []; list.replaceChildren(); hint.textContent = '輸入關鍵字開始搜尋'; hint.classList.remove('hidden'); },
    focus() { input.focus(); },
  };
}
