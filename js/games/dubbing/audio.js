// 配音大師：麥克風錄音與波形顯示（麥克風只在第一次需要時詢問，之後整場重複使用同一條串流）
let stream = null; let audioContext = null; let analyser = null; let recorder = null;
let chunks = []; let blob = null; let raf = 0; let visualizing = false;
let canvas = null; let cx = null; let previewEl = null;
let stopWaiters = [];

export function bind(canvasEl, previewAudioEl) {
  if (!canvas) window.addEventListener('resize', resizeCanvas);
  canvas = canvasEl; cx = canvasEl.getContext('2d'); previewEl = previewAudioEl;
}

const micAlive = () => !!stream && stream.getAudioTracks().some((t) => t.readyState === 'live');

/** 取得麥克風。回傳 true／false（沒有權限、不是 HTTPS、沒有裝置） */
export async function initMic() {
  if (micAlive() && recorder) return true;
  if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) return false;
  try {
    stream = await navigator.mediaDevices.getUserMedia({ audio: true });
    audioContext = new (window.AudioContext || window.webkitAudioContext)();
    analyser = audioContext.createAnalyser(); analyser.fftSize = 2048;
    audioContext.createMediaStreamSource(stream).connect(analyser);
    recorder = new MediaRecorder(stream);
    recorder.ondataavailable = (e) => { if (e.data.size > 0) chunks.push(e.data); };
    recorder.onstop = () => {
      const type = (recorder.mimeType || '').split(';')[0] || (MediaRecorder.isTypeSupported('audio/webm') ? 'audio/webm' : 'audio/mp4');
      blob = new Blob(chunks, { type });
      previewEl.src = URL.createObjectURL(blob);
      const ws = stopWaiters; stopWaiters = [];
      ws.forEach((f) => f(blob));
    };
    resizeCanvas();
    return true;
  } catch { return false; }
}

export function releaseMic() {
  try { if (recorder && recorder.state !== 'inactive') recorder.stop(); } catch { /* ignore */ }
  if (stream) stream.getTracks().forEach((t) => t.stop());
  try { if (audioContext) audioContext.close(); } catch { /* ignore */ }
  stream = null; audioContext = null; analyser = null; recorder = null;
  visualizing = false; cancelAnimationFrame(raf);
}

export function resizeCanvas() {
  if (!canvas || !canvas.parentElement || canvas.parentElement.clientWidth <= 0) return;
  canvas.width = canvas.parentElement.clientWidth; canvas.height = canvas.parentElement.clientHeight;
  if (!visualizing) drawIdle();
}

function drawIdle() {
  cx.fillStyle = '#0b132b'; cx.fillRect(0, 0, canvas.width, canvas.height);
  cx.lineWidth = 2; cx.strokeStyle = '#555'; cx.beginPath(); cx.moveTo(0, canvas.height / 2); cx.lineTo(canvas.width, canvas.height / 2); cx.stroke();
}

function draw() {
  if (!visualizing) return;
  raf = requestAnimationFrame(draw);
  const n = analyser.frequencyBinCount; const data = new Uint8Array(n); analyser.getByteTimeDomainData(data);
  cx.fillStyle = '#0b132b'; cx.fillRect(0, 0, canvas.width, canvas.height);
  cx.lineWidth = 2; cx.strokeStyle = '#f9a826'; cx.beginPath();
  const slice = canvas.width / n; let x = 0;
  for (let i = 0; i < n; i++) {
    const y = (data[i] / 128) * canvas.height / 2;
    if (i === 0) cx.moveTo(x, y); else cx.lineTo(x, y);
    x += slice;
  }
  cx.lineTo(canvas.width, canvas.height / 2); cx.stroke();
}

export function startRecording() {
  chunks = []; blob = null; previewEl.removeAttribute('src');
  recorder.start();
  if (audioContext.state === 'suspended') audioContext.resume();
  visualizing = true; draw();
}

/** 停止錄音，回傳錄好的 Blob（沒在錄就直接回傳上一次的） */
export function stopRecording() {
  visualizing = false; cancelAnimationFrame(raf); resizeCanvas();
  if (!recorder || recorder.state === 'inactive') return Promise.resolve(blob);
  return new Promise((resolve) => { stopWaiters.push(resolve); recorder.stop(); });
}

export const isRecording = () => !!recorder && recorder.state === 'recording';
export const getBlob = () => blob;
export const clearBlob = () => { blob = null; chunks = []; if (previewEl) previewEl.removeAttribute('src'); };
export const playPreview = () => { if (previewEl.src) { previewEl.currentTime = 0; previewEl.play().catch(() => {}); } };
export const stopPreview = () => { previewEl.pause(); previewEl.currentTime = 0; };
