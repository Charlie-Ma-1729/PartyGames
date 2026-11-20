// 配音大師用的檔案服務：影片素材清單、影片／錄音／成品的串流（支援 Range，影片才能拖曳時間軸）、錄音上傳、ffmpeg 合成、過期檔案清理
import { createReadStream, createWriteStream, existsSync, mkdirSync, readdirSync, renameSync, statSync, unlinkSync } from 'node:fs';
import { readdir } from 'node:fs/promises';
import { spawn } from 'node:child_process';
import path from 'node:path';
import { ROOT } from './bank.mjs';
import { cleanId, normCode } from './protocol.mjs';

const BASE = process.env.DUBBING_DIR ? path.resolve(process.env.DUBBING_DIR) : path.join(ROOT, 'data', 'dubbing');
export const DUB = { videos: path.join(BASE, 'videos'), audio: path.join(BASE, 'temp_audio'), outputs: path.join(BASE, 'outputs') };
for (const d of Object.values(DUB)) { try { mkdirSync(d, { recursive: true }); } catch { /* ignore */ } }

const FFMPEG = process.env.FFMPEG_PATH || 'ffmpeg';
const KEEP_MS = Number(process.env.DUBBING_KEEP_HOURS || 24) * 3600 * 1000;
const MAX_UPLOAD = 40 * 1024 * 1024;

export const VIDEO_EXTS = ['.mp4', '.webm', '.mov', '.mkv'];
const TYPES = {
  '.mp4': 'video/mp4', '.webm': 'video/webm', '.mov': 'video/quicktime', '.mkv': 'video/x-matroska',
  '.m4a': 'audio/mp4', '.ogg': 'audio/ogg', '.wav': 'audio/wav',
};
// 上傳的錄音：瀏覽器的 MediaRecorder 在 Chrome／Firefox 是 webm 或 ogg，Safari 是 mp4
const UPLOAD_EXT = { 'audio/webm': '.webm', 'video/webm': '.webm', 'audio/mp4': '.m4a', 'audio/x-m4a': '.m4a', 'audio/aac': '.m4a', 'audio/ogg': '.ogg', 'audio/wav': '.wav', 'audio/x-wav': '.wav' };
const audioType = (f) => (f.endsWith('.webm') ? 'audio/webm' : TYPES[path.extname(f)] || 'application/octet-stream');

/** 把相對路徑接到 base 底下；跳出 base 或格式怪異就回傳 null（擋 ../） */
export function safeJoin(base, rel) {
  if (typeof rel !== 'string' || !rel || rel.length > 300 || rel.includes('\0') || rel.includes('\\')) return null;
  const parts = rel.split('/');
  if (parts.some((p) => !p || p === '.' || p === '..')) return null;
  const abs = path.join(base, ...parts);
  return abs.startsWith(base + path.sep) ? abs : null;
}
export const isVideoPath = (rel) => safeJoin(DUB.videos, rel) !== null && VIDEO_EXTS.includes(path.extname(rel).toLowerCase());
export const videoPath = (rel) => (isVideoPath(rel) ? safeJoin(DUB.videos, rel) : null);
export const videoExists = (rel) => { const f = isVideoPath(rel) && safeJoin(DUB.videos, rel); try { return !!f && statSync(f).isFile(); } catch { return false; } };
export const audioExists = (file) => { const f = safeJoin(DUB.audio, file); try { return !!f && statSync(f).size > 0; } catch { return false; } };
export const audioPath = (file) => safeJoin(DUB.audio, file);
export const outputPath = (file) => safeJoin(DUB.outputs, file);

/** 遞迴掃描影片資料夾（資料夾排前面）；只保留裡面有影片的資料夾 */
export async function listVideos(dir = DUB.videos, prefix = '') {
  const out = [];
  let entries = [];
  try { entries = await readdir(dir, { withFileTypes: true }); } catch { return out; }
  for (const e of entries) {
    const rel = prefix ? `${prefix}/${e.name}` : e.name;
    if (e.isDirectory()) {
      const children = await listVideos(path.join(dir, e.name), rel);
      if (children.length) out.push({ type: 'dir', name: e.name, path: rel, children });
    } else if (VIDEO_EXTS.includes(path.extname(e.name).toLowerCase())) {
      out.push({ type: 'file', name: e.name, path: rel });
    }
  }
  out.sort((a, b) => (a.type === b.type ? a.name.localeCompare(b.name) : a.type === 'dir' ? -1 : 1));
  return out;
}

/** 傳檔案（支援 Range） */
export function serveFile(req, res, file, type) {
  let st;
  try { st = statSync(file); if (!st.isFile()) throw new Error('not file'); } catch { res.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' }).end('Not found'); return; }
  const size = st.size;
  const headers = { 'content-type': type, 'accept-ranges': 'bytes', 'cache-control': 'no-cache' };
  const range = req.headers.range;
  let start = 0; let end = size - 1; let status = 200;
  if (range) {
    const m = /^bytes=(\d*)-(\d*)$/.exec(range);
    if (!m || (m[1] === '' && m[2] === '')) { res.writeHead(416, { 'content-range': `bytes */${size}` }).end(); return; }
    if (m[1] === '') { start = Math.max(0, size - Number(m[2])); } else { start = Number(m[1]); if (m[2] !== '') end = Math.min(end, Number(m[2])); }
    if (start > end || start >= size) { res.writeHead(416, { 'content-range': `bytes */${size}` }).end(); return; }
    status = 206;
    headers['content-range'] = `bytes ${start}-${end}/${size}`;
  }
  headers['content-length'] = size === 0 ? 0 : end - start + 1;
  res.writeHead(status, headers);
  if (req.method === 'HEAD' || size === 0) { res.end(); return; }
  const rs = createReadStream(file, { start, end });
  rs.on('error', () => res.destroy());
  res.on('close', () => rs.destroy());
  rs.pipe(res);
}

const json = (res, code, obj) => res.writeHead(code, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' }).end(JSON.stringify(obj));

/**
 * 處理 /api/dubbing/* 與 /media/dubbing/*。已處理回傳 true。
 * @param {Map<string, any>} rooms 房間表（用來驗證上傳者確實在一場進行中的配音遊戲裡）
 */
export function handleDubbingHttp(req, res, url, rooms) {
  const p = decodeURIComponent(url.pathname);
  if (p === '/api/dubbing/videos' && (req.method === 'GET' || req.method === 'HEAD')) {
    listVideos().then((videos) => json(res, 200, { success: true, videos }), () => json(res, 500, { success: false, message: '伺服器無法讀取影片目錄' }));
    return true;
  }
  if (p === '/api/dubbing/upload' && req.method === 'POST') { upload(req, res, url, rooms); return true; }
  let m = /^\/media\/dubbing\/videos\/(.+)$/.exec(p);
  if (m && (req.method === 'GET' || req.method === 'HEAD')) {
    const f = isVideoPath(m[1]) && safeJoin(DUB.videos, m[1]);
    if (!f) res.writeHead(404).end(); else serveFile(req, res, f, TYPES[path.extname(f).toLowerCase()]);
    return true;
  }
  m = /^\/media\/dubbing\/audio\/([\w.-]+)$/.exec(p);
  if (m && (req.method === 'GET' || req.method === 'HEAD')) {
    const f = safeJoin(DUB.audio, m[1]);
    if (!f) res.writeHead(404).end(); else serveFile(req, res, f, audioType(m[1]));
    return true;
  }
  m = /^\/media\/dubbing\/outputs\/([\w.-]+\.mp4)$/.exec(p);
  if (m && (req.method === 'GET' || req.method === 'HEAD')) {
    const f = safeJoin(DUB.outputs, m[1]);
    if (!f) res.writeHead(404).end(); else serveFile(req, res, f, 'video/mp4');
    return true;
  }
  return false;
}

/** POST /api/dubbing/upload?room=ABCD&pid=…&idx=0，body = 錄音原始位元組（Content-Type 為 audio/webm 等） */
function upload(req, res, url, rooms) {
  const room = rooms.get(normCode(url.searchParams.get('room')));
  const game = room && room.game;
  const pid = cleanId(url.searchParams.get('pid'));
  const idx = Number(url.searchParams.get('idx'));
  const ext = UPLOAD_EXT[(req.headers['content-type'] || '').split(';')[0].trim().toLowerCase()];
  const fail = (code, msg) => { json(res, code, { success: false, message: msg }); req.resume(); };
  if (!game || game.constructor.meta.id !== 'dubbing' || !pid) return fail(404, '找不到這場遊戲');
  if (!ext) return fail(415, '不支援的錄音格式');
  const len = Number(req.headers['content-length'] || 0);
  if (len > MAX_UPLOAD) return fail(413, '錄音檔太大');
  const target = game.uploadTarget(pid, idx, ext);
  if (target.error) return fail(409, target.error);
  const final = path.join(DUB.audio, target.file);
  const tmp = `${final}.part`;
  const ws = createWriteStream(tmp);
  let size = 0; let aborted = false;
  const cleanup = () => { try { unlinkSync(tmp); } catch { /* ignore */ } };
  req.on('data', (c) => {
    size += c.length;
    if (size > MAX_UPLOAD && !aborted) { aborted = true; ws.destroy(); cleanup(); json(res, 413, { success: false, message: '錄音檔太大' }); req.destroy(); }
  });
  req.on('aborted', () => { aborted = true; ws.destroy(); cleanup(); });
  req.on('error', () => { aborted = true; ws.destroy(); cleanup(); });
  ws.on('error', () => { if (!aborted) { aborted = true; cleanup(); json(res, 500, { success: false, message: '儲存失敗' }); } });
  ws.on('finish', () => {
    if (aborted) return;
    if (size === 0) { cleanup(); return json(res, 400, { success: false, message: '沒有收到錄音內容' }); }
    try { renameSync(tmp, final); } catch { cleanup(); return json(res, 500, { success: false, message: '儲存失敗' }); }
    game.uploadDone(pid, idx, target.file);
    json(res, 200, { success: true, message: '上傳成功' });
  });
  req.pipe(ws);
}

/** 影片＋錄音 → mp4（影像不重新編碼；音訊轉 AAC；以較短者為準）。沒裝 ffmpeg 會 reject */
export function mergeAudioVideo(video, audio, out) {
  return new Promise((resolve, reject) => {
    let p;
    try { p = spawn(FFMPEG, ['-y', '-i', video, '-i', audio, '-c:v', 'copy', '-c:a', 'aac', '-map', '0:v:0', '-map', '1:a:0', '-shortest', out], { stdio: ['ignore', 'ignore', 'pipe'] }); } catch (e) { reject(e); return; }
    let err = '';
    const timer = setTimeout(() => { try { p.kill('SIGKILL'); } catch { /* ignore */ } }, 5 * 60 * 1000);
    p.stderr.on('data', (d) => { err = (err + d).slice(-1500); });
    p.on('error', (e) => { clearTimeout(timer); reject(e); });
    p.on('close', (code) => { clearTimeout(timer); if (code === 0 && existsSync(out)) resolve(out); else reject(new Error(`ffmpeg 結束代碼 ${code}：${err.trim().split('\n').slice(-2).join(' ')}`)); });
  });
}

/** 刪掉超過保存時間的錄音與成品（影片素材不動） */
export function cleanupOld(now = Date.now()) {
  let n = 0;
  for (const dir of [DUB.audio, DUB.outputs]) {
    let names = [];
    try { names = readdirSync(dir); } catch { continue; }
    for (const f of names) {
      const file = path.join(dir, f);
      try { if (now - statSync(file).mtimeMs > KEEP_MS) { unlinkSync(file); n++; } } catch { /* ignore */ }
    }
  }
  return n;
}
