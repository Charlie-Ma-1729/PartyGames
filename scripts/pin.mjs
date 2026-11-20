// 手動指定某一首歌用哪支 YouTube 影片（自動搜尋找不到、或找到的不是原版時用）。
// 用法：node scripts/pin.mjs --cat vocaloid "歌名" <YouTube 影片 ID 或網址> [起點秒數]
//  - 會讀影片頁確認可以嵌入，寫入 data/cache/resolved.json；之後 build.mjs 就會收進題庫
//  - 歌名要和歌單裡寫的一樣；同名的歌有多首時，用「作品|歌名」（例如 "DECO*27|ゴーストルール"）
import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import path from 'node:path';
import { parseSeeds, allSongs, CACHE_DIR } from './lib.mjs';

const args = process.argv.slice(2).filter((a, i, all) => a !== '--cat' && all[i - 1] !== '--cat');
const [name, rawId, startArg] = args;
if (!name || !rawId) { console.error('用法：node scripts/pin.mjs --cat <題庫> "歌名" <影片ID或網址> [起點秒數]'); process.exit(1); }
const ytId = (rawId.match(/(?:v=|youtu\.be\/|embed\/)([\w-]{11})/) || [null, rawId])[1];
if (!/^[\w-]{11}$/.test(ytId)) { console.error('看不懂影片 ID：' + rawId); process.exit(1); }

const [w, t] = name.includes('|') ? name.split('|') : [null, name];
const matches = allSongs(parseSeeds()).filter((s) => s.title === t && (!w || s.workObj.zh === w || s.workObj.work === w));
if (matches.length !== 1) { console.error(matches.length ? `有 ${matches.length} 首同名的歌，請用「作品|歌名」` : `歌單裡找不到「${name}」`); process.exit(1); }
const song = matches[0];

const HEADERS = { 'user-agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/124.0 Safari/537.36', 'accept-language': 'ja,en;q=0.6', cookie: 'CONSENT=YES+1' };
const oe = await fetch('https://www.youtube.com/oembed?format=json&url=' + encodeURIComponent('https://www.youtube.com/watch?v=' + ytId), { headers: HEADERS });
if (!oe.ok) { console.error(`影片 ${ytId} 不能嵌入或不存在（HTTP ${oe.status}）`); process.exit(1); }
const o = await oe.json();
const html = await (await fetch('https://www.youtube.com/watch?hl=ja&v=' + ytId, { headers: HEADERS })).text();
const length = Number(html.match(/"lengthSeconds":"(\d+)"/)?.[1] || 0) || undefined;

const file = path.join(CACHE_DIR, 'resolved.json');
const cache = existsSync(file) ? JSON.parse(readFileSync(file, 'utf8')) : {};
// 「從中間播放」模式用的起點：預設在全長的 20% 處（最多 60 秒）；也可以手動指定
const start = startArg != null ? Number(startArg) : Math.min(60, Math.round((length || 150) * 0.2));
cache[song.key] = {
  ytId, videoTitle: o.title, channel: o.author_name, length, start: Math.max(0, Math.min(start, (length || 999) - 30)), startSource: 'heuristic',
  audioFirst: true, review: false, official: true, pinned: true, resolvedAt: new Date().toISOString().slice(0, 10),
};
writeFileSync(file, JSON.stringify(cache, null, 1));
console.log(`✓ ${song.workObj.zh} / ${song.title} → ${ytId}  ${o.title}（${o.author_name}）`);
