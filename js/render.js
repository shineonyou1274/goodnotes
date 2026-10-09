// 페이지 그리기: 종이 서식, 배경(PDF) 이미지, 획·글상자·이미지
import { drawStroke, itemBounds, rectsIntersect } from './ink.js';
import { PAPER_COLORS } from './model.js';

export const FONT_STACK = '-apple-system, BlinkMacSystemFont, "Apple SD Gothic Neo", "Noto Sans KR", "Malgun Gothic", "Segoe UI", sans-serif';

/* ---------- 이미지(Blob) 디코딩 캐시 ---------- */
const bitmapCache = new WeakMap(); // Blob -> { img, promise }
const listeners = new Set();
export function onImageLoaded(fn) { listeners.add(fn); return () => listeners.delete(fn); }

async function decode(blob) {
  if (window.createImageBitmap) {
    try { return await createImageBitmap(blob); } catch { /* 아래 방법으로 */ }
  }
  const url = URL.createObjectURL(blob);
  try {
    const img = new Image();
    img.src = url;
    await img.decode();
    return img;
  } finally {
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  }
}

export function getImage(blob) {
  if (!blob) return null;
  let entry = bitmapCache.get(blob);
  if (!entry) {
    entry = { img: null, promise: null };
    entry.promise = decode(blob).then((img) => {
      entry.img = img;
      listeners.forEach((fn) => fn());
      return img;
    }).catch(() => null);
    bitmapCache.set(blob, entry);
  }
  return entry.img;
}

export function loadImage(blob) {
  getImage(blob);
  return bitmapCache.get(blob).promise;
}

export async function ensurePageImages(page) {
  const blobs = [];
  if (page.bg) blobs.push(page.bg);
  for (const it of page.items) {
    if (it.type === 'image' && it.blob) blobs.push(it.blob);
    if (it.type === 'video' && it.poster) blobs.push(it.poster);
  }
  await Promise.all(blobs.map(loadImage));
}

/* ---------- 종이 서식 ---------- */
export function drawPaper(ctx, page, zoom = 1) {
  const pc = PAPER_COLORS[page.paper] || PAPER_COLORS.white;
  ctx.fillStyle = pc.fill;
  ctx.fillRect(0, 0, page.w, page.h);
  if (page.bg) {
    const img = getImage(page.bg);
    if (img) ctx.drawImage(img, 0, 0, page.w, page.h);
    return;
  }
  const W = page.w, H = page.h;
  const line = pc.line;
  const thin = Math.max(0.6, 0.8 / zoom);
  ctx.strokeStyle = line;
  ctx.fillStyle = line;
  ctx.lineWidth = thin;
  switch (page.template) {
    case 'lined': {
      const gap = 32, top = 96;
      ctx.beginPath();
      for (let y = top; y < H - 20; y += gap) { ctx.moveTo(0, y); ctx.lineTo(W, y); }
      ctx.stroke();
      ctx.strokeStyle = page.paper === 'dark' ? '#7a3b3b' : '#efb2b2';
      ctx.beginPath(); ctx.moveTo(72, 0); ctx.lineTo(72, H); ctx.stroke();
      break;
    }
    case 'grid': {
      const gap = 24;
      ctx.beginPath();
      for (let x = gap; x < W; x += gap) { ctx.moveTo(x, 0); ctx.lineTo(x, H); }
      for (let y = gap; y < H; y += gap) { ctx.moveTo(0, y); ctx.lineTo(W, y); }
      ctx.globalAlpha = 0.75;
      ctx.stroke();
      ctx.globalAlpha = 1;
      break;
    }
    case 'dot': {
      const gap = 24, r = Math.max(1.1, 1 / zoom);
      ctx.beginPath();
      for (let y = gap; y < H; y += gap) {
        for (let x = gap; x < W; x += gap) { ctx.moveTo(x + r, y); ctx.arc(x, y, r, 0, Math.PI * 2); }
      }
      ctx.fill();
      break;
    }
    case 'cornell': {
      const gap = 32, head = 110, cue = Math.round(W * 0.3), foot = Math.round(H * 0.8);
      ctx.beginPath();
      for (let y = head + gap; y < foot; y += gap) { ctx.moveTo(cue, y); ctx.lineTo(W, y); }
      ctx.stroke();
      ctx.lineWidth = Math.max(1.2, 1.4 / zoom);
      ctx.beginPath();
      ctx.moveTo(0, head); ctx.lineTo(W, head);
      ctx.moveTo(cue, head); ctx.lineTo(cue, foot);
      ctx.moveTo(0, foot); ctx.lineTo(W, foot);
      ctx.stroke();
      break;
    }
    case 'music': {
      const staffGap = 10, block = 96, top = 80;
      ctx.beginPath();
      for (let y = top; y + staffGap * 4 < H - 40; y += block) {
        for (let k = 0; k < 5; k++) { ctx.moveTo(48, y + k * staffGap); ctx.lineTo(W - 48, y + k * staffGap); }
      }
      ctx.stroke();
      break;
    }
    default:
      break;
  }
}

/* ---------- 글상자 ---------- */
export function textFont(item) {
  return `${item.bold ? '600 ' : ''}${item.size}px ${FONT_STACK}`;
}

const wrapCache = new WeakMap();
export function wrapText(ctx, item) {
  let lines = wrapCache.get(item);
  if (lines) return lines;
  ctx.save();
  ctx.font = textFont(item);
  lines = [];
  const maxW = item.w;
  for (const para of String(item.text).split('\n')) {
    if (para === '') { lines.push(''); continue; }
    const fits = (t) => ctx.measureText(t).width <= maxW;
    let line = '';
    for (const token of para.split(/(\s+)/)) {
      if (token === '') continue;
      if (fits(line + token)) { line += token; continue; }
      if (/^\s+$/.test(token)) { lines.push(line); line = ''; continue; }
      if (line !== '') { lines.push(line.replace(/\s+$/, '')); line = ''; }
      if (fits(token)) { line = token; continue; }
      // 너무 긴 단어는 글자 단위로 나눈다
      for (const ch of token) {
        if (line !== '' && !fits(line + ch)) { lines.push(line); line = ch; } else line += ch;
      }
    }
    lines.push(line);
  }
  ctx.restore();
  wrapCache.set(item, lines);
  return lines;
}

export const LINE_HEIGHT = 1.35;

export function drawText(ctx, item) {
  const lines = wrapText(ctx, item);
  ctx.font = textFont(item);
  ctx.fillStyle = item.color;
  ctx.textBaseline = 'top';
  const lh = item.size * LINE_HEIGHT;
  const pad = (lh - item.size) / 2;
  lines.forEach((ln, i) => ctx.fillText(ln, item.x, item.y + pad + i * lh));
}

export function measureTextHeight(ctx, item) {
  return Math.max(1, wrapText(ctx, item).length) * item.size * LINE_HEIGHT;
}

/* ---------- 항목 그리기 ---------- */
export function drawItem(ctx, item) {
  if (item.type === 'stroke') drawStroke(ctx, item);
  else if (item.type === 'text') drawText(ctx, item);
  else if (item.type === 'video') drawVideo(ctx, item);
  else if (item.type === 'image') {
    const img = getImage(item.blob);
    if (img) ctx.drawImage(img, item.x, item.y, item.w, item.h);
    else {
      ctx.fillStyle = 'rgba(120,120,128,0.15)';
      ctx.fillRect(item.x, item.y, item.w, item.h);
    }
  }
}

function fmtTime(sec) {
  if (!(sec > 0) || !isFinite(sec)) return '';
  const m = Math.floor(sec / 60), s = Math.round(sec % 60);
  return `${m}:${String(s).padStart(2, '0')}`;
}

// 동영상: 첫 장면 그림 위에 재생 단추
function drawVideo(ctx, item) {
  const img = item.poster ? getImage(item.poster) : null;
  ctx.save();
  if (img) ctx.drawImage(img, item.x, item.y, item.w, item.h);
  else { ctx.fillStyle = '#2b2d33'; ctx.fillRect(item.x, item.y, item.w, item.h); }
  const r = Math.max(16, Math.min(40, Math.min(item.w, item.h) * 0.16));
  const cx = item.x + item.w / 2, cy = item.y + item.h / 2;
  ctx.fillStyle = 'rgba(0,0,0,0.5)';
  ctx.beginPath(); ctx.arc(cx, cy, r, 0, Math.PI * 2); ctx.fill();
  ctx.fillStyle = '#fff';
  ctx.beginPath();
  ctx.moveTo(cx - r * 0.32, cy - r * 0.48); ctx.lineTo(cx + r * 0.52, cy); ctx.lineTo(cx - r * 0.32, cy + r * 0.48);
  ctx.closePath(); ctx.fill();
  const t = fmtTime(item.duration);
  if (t) {
    const fs = Math.max(10, Math.min(16, item.h * 0.07));
    ctx.font = `600 ${fs}px ${FONT_STACK}`;
    const tw = ctx.measureText(t).width;
    ctx.fillStyle = 'rgba(0,0,0,0.6)';
    ctx.fillRect(item.x + item.w - tw - fs * 1.1, item.y + item.h - fs * 1.7, tw + fs * 0.8, fs * 1.4);
    ctx.fillStyle = '#fff';
    ctx.textBaseline = 'middle';
    ctx.fillText(t, item.x + item.w - tw - fs * 0.7, item.y + item.h - fs);
  }
  ctx.restore();
}

export function drawItems(ctx, items, { skip, visible } = {}) {
  for (const it of items) {
    if (skip && skip.has(it.id)) continue;
    if (visible && !rectsIntersect(itemBounds(it), visible)) continue;
    drawItem(ctx, it);
  }
}

// 페이지 하나를 주어진 배율로 새 캔버스에 그린다 (썸네일·PDF 내보내기용)
export function renderPageCanvas(page, scale, canvas = document.createElement('canvas')) {
  canvas.width = Math.max(1, Math.round(page.w * scale));
  canvas.height = Math.max(1, Math.round(page.h * scale));
  const ctx = canvas.getContext('2d');
  ctx.setTransform(scale, 0, 0, scale, 0, 0);
  drawPaper(ctx, page, scale);
  drawItems(ctx, page.items);
  return canvas;
}
