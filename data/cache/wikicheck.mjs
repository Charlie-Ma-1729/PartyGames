import { readFileSync, writeFileSync } from 'node:fs';
import { norm } from '../../scripts/lib.mjs';
const sus = JSON.parse(readFileSync('data/cache/verify-movie-suspects.json', 'utf8'));
const qs = JSON.parse(readFileSync('data/movie.json', 'utf8'));
const byId = Object.fromEntries(qs.map((q) => [q.id, q]));
const UA = { 'user-agent': 'SongGuesser/1.0 (hobby project; personal use)' };
const api = async (p) => (await fetch('https://en.wikipedia.org/w/api.php?format=json&' + new URLSearchParams(p), { headers: UA })).json();
const out = [];
for (const s of sus) {
  const q = byId[s.id]; if (!q) continue;
  const m = q.answer.work.match(/（(.*)）/); const film = m ? m[1] : '';
  if (!/[A-Za-z]{4}/.test(film)) { out.push({ ...s, wiki: 'skip' }); continue; }
  const core = film.replace(/^The /i, '').split(/[:–]/)[0].trim();
  let hit = false;
  try {
    const r = await api({ action: 'query', list: 'search', srsearch: `"${q.answer.title.replace(/\(.*?\)/g, '').trim()}" ${q.answer.artist || ''} ${core}`, srlimit: '4' });
    const ids = (r.query?.search || []).map((x) => x.pageid);
    for (const x of r.query?.search || []) if (norm(x.title + x.snippet.replace(/<[^>]+>/g, '')).includes(norm(core))) hit = true;
    if (!hit && ids.length) {
      const e = await api({ action: 'query', prop: 'extracts', explaintext: '1', exlimit: String(ids.length), exchars: '4000', pageids: ids.join('|') });
      for (const p of Object.values(e.query?.pages || {})) if (norm(p.extract || '').includes(norm(core))) hit = true;
    }
  } catch (e) { console.log('ERR', e.message); out.push({ ...s, wiki: 'err' }); continue; }
  out.push({ ...s, wiki: hit ? 'ok' : 'NO' });
  await new Promise((r) => setTimeout(r, 1800));
}
writeFileSync('data/cache/wikicheck.json', JSON.stringify(out, null, 1));
for (const o of out.filter((o) => o.wiki === 'NO')) console.log('NO', o.work, '/', o.song);
console.log(out.reduce((a, o) => (a[o.wiki] = (a[o.wiki] || 0) + 1, a), {}));
