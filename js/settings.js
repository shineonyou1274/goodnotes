// 도구 설정(색·굵기 등)을 기기에 기억한다
const KEY = 'goodnotes-web:settings';

export const PEN_PALETTE = [
  '#1c1c1e', '#48484a', '#8e8e93', '#ffffff', '#1f4fd6', '#3a8ef6', '#0aa5a5', '#188038',
  '#5bb318', '#d93025', '#ff6b4a', '#f29900', '#f5c400', '#8e44ad', '#c2185b', '#795548',
];
export const HIGHLIGHTER_PALETTE = [
  '#ffe066', '#fff3a3', '#9be89b', '#c7f5c0', '#9fd3ff', '#cfe7ff', '#ffb3d1', '#ffd6e6',
  '#ffc38a', '#ffe0c2', '#d2b8ff', '#e9dcff', '#b8f2ee', '#e0e0e0', '#ffcccc', '#d7ccc8',
];

const DEFAULTS = {
  tool: 'pen',
  pen: { colors: ['#1c1c1e', '#1f4fd6', '#d93025', '#188038', '#8e44ad'], color: 0, widths: [1.4, 2.4, 4.2], width: 1 },
  highlighter: { colors: ['#ffe066', '#9be89b', '#9fd3ff', '#ffb3d1', '#ffc38a'], color: 0, widths: [10, 16, 26], width: 1 },
  eraser: { mode: 'partial', widths: [10, 24, 50], width: 1 },
  text: { colors: ['#1c1c1e', '#1f4fd6', '#d93025', '#188038', '#8e44ad'], color: 0, sizes: [16, 22, 32], size: 1 },
  fingerDraw: true,
  autoFinger: true, // 펜을 처음 쓰면 손가락 그리기를 자동으로 끈다
  pressure: true,
  shapeAssist: true,
};

function merge(base, over) {
  if (Array.isArray(base)) return Array.isArray(over) && over.length === base.length ? over.slice() : base.slice();
  if (base && typeof base === 'object') {
    const out = {};
    for (const k of Object.keys(base)) out[k] = merge(base[k], over ? over[k] : undefined);
    return out;
  }
  return over === undefined || typeof over !== typeof base ? base : over;
}

export function loadSettings() {
  let saved = null;
  try { saved = JSON.parse(localStorage.getItem(KEY) || 'null'); } catch { /* 무시 */ }
  return merge(DEFAULTS, saved);
}

export function saveSettings(s) {
  try { localStorage.setItem(KEY, JSON.stringify(s)); } catch { /* 무시 */ }
}
