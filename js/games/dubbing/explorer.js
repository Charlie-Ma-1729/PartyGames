// 配音大師的影片素材挑選器（房主用）：像檔案總管一樣逛資料夾、勾選影片、預覽。
// 勾選結果以伺服器的設定為準（fill 時同步進來），每次勾選就通知外面送出設定。
import { el } from '../../hub/view.js';

export const videoUrl = (rel) => '/media/dubbing/videos/' + rel.split('/').map(encodeURIComponent).join('/');

export function createExplorer({ root, countEl, onChange, onPreview }) {
  let tree = null; let loadErr = '';
  let stack = []; // [{nodes, names}]
  let selected = new Set();
  let editable = false;

  const allPaths = (nodes) => nodes.flatMap((n) => (n.type === 'file' ? [n.path] : allPaths(n.children)));
  const cur = () => (stack.length ? stack[stack.length - 1] : { nodes: tree || [], names: [] });

  function render() {
    root.replaceChildren();
    if (loadErr) { root.append(el('p', 'dub-note', loadErr)); return; }
    if (!tree) { root.append(el('p', 'dub-note', '載入影片清單中…')); return; }
    if (tree.length === 0) { root.append(el('p', 'dub-note', '伺服器的 data/dubbing/videos 資料夾裡還沒有影片。把 mp4／webm／mov／mkv 放進去（可以分資料夾）就會出現在這裡。')); return; }
    const { nodes, names } = cur();

    const crumb = el('div', 'dub-crumb');
    const rootBtn = el('button', 'dub-link', '📁 Videos');
    rootBtn.type = 'button';
    rootBtn.addEventListener('click', () => { stack = []; render(); });
    crumb.append(rootBtn, el('span', null, names.length ? ' > ' + names.join(' > ') : ''));
    root.append(crumb);

    const list = el('ul', 'dub-files');
    if (stack.length) {
      const li = el('li', 'dub-file folder');
      const b = el('button', 'dub-link', '🔙 返回上一層');
      b.type = 'button';
      b.addEventListener('click', () => { stack.pop(); render(); });
      li.append(b); list.append(li);
    }
    const here = allPaths(nodes);
    if (here.length) {
      const li = el('li', 'dub-file');
      const cb = document.createElement('input'); cb.type = 'checkbox'; cb.disabled = !editable;
      cb.checked = here.every((p) => selected.has(p));
      cb.addEventListener('change', () => { here.forEach((p) => (cb.checked ? selected.add(p) : selected.delete(p))); changed(); });
      const lb = el('label', 'dub-link', '全選這個畫面的所有影片');
      lb.prepend(cb);
      li.append(lb); list.append(li);
    }
    nodes.forEach((n) => {
      const li = el('li', 'dub-file');
      if (n.type === 'dir') {
        const kids = allPaths(n.children);
        const k = kids.filter((p) => selected.has(p)).length;
        const cb = document.createElement('input'); cb.type = 'checkbox'; cb.disabled = !editable;
        cb.checked = k === kids.length; cb.indeterminate = k > 0 && k < kids.length;
        cb.addEventListener('change', () => { kids.forEach((p) => (cb.checked ? selected.add(p) : selected.delete(p))); changed(); });
        const open = el('button', 'dub-link', `📁 ${n.name} (${k}/${kids.length})`);
        open.type = 'button';
        open.addEventListener('click', () => { stack.push({ nodes: n.children, names: [...names, n.name] }); render(); });
        li.append(cb, open);
      } else {
        const cb = document.createElement('input'); cb.type = 'checkbox'; cb.disabled = !editable; cb.checked = selected.has(n.path);
        cb.addEventListener('change', () => { if (cb.checked) selected.add(n.path); else selected.delete(n.path); changed(); });
        const lb = el('label', 'dub-link', `🎬 ${n.name}`);
        lb.title = n.path;
        lb.prepend(cb);
        const pv = el('button', 'dub-mini', '預覽');
        pv.type = 'button';
        pv.addEventListener('click', () => onPreview(n));
        li.append(lb, pv);
      }
      list.append(li);
    });
    root.append(list);
  }

  function changed() {
    countEl.textContent = String(selected.size);
    render();
    onChange();
  }

  return {
    getSelected: () => [...selected],
    /** 以伺服器設定為準；editable = 是否為房主 */
    sync(paths, canEdit) {
      const sig = paths.join('|');
      const same = sig === [...selected].join('|') && canEdit === editable;
      selected = new Set(paths); editable = canEdit;
      countEl.textContent = String(selected.size);
      if (!same) render();
    },
    async load() {
      if (tree) return;
      try {
        const r = await fetch('/api/dubbing/videos');
        const j = await r.json();
        if (!j.success) throw new Error(j.message);
        tree = j.videos; loadErr = '';
      } catch { loadErr = '無法載入影片清單（伺服器沒有開，或網址不對）'; tree = null; }
      render();
    },
    reload() { tree = null; return this.load(); },
  };
}
