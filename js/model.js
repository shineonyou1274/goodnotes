// 노트·페이지 데이터 구조와 기본값

export const uid = () =>
  Date.now().toString(36) + Math.random().toString(36).slice(2, 10);

export const PAGE_SIZES = {
  'a4-portrait': { w: 794, h: 1123, label: 'A4 세로' },
  'a4-landscape': { w: 1123, h: 794, label: 'A4 가로' },
  'wide': { w: 1280, h: 800, label: '와이드 (16:10)' },
};

export const TEMPLATES = {
  blank: '빈 종이',
  lined: '줄 노트',
  grid: '모눈',
  dot: '점 격자',
  cornell: '코넬 노트',
  music: '오선지',
};

export const PAPER_COLORS = {
  white: { fill: '#ffffff', line: '#c5d3e6', label: '흰색' },
  ivory: { fill: '#fbf6e9', line: '#d9cdb0', label: '아이보리' },
  dark: { fill: '#26272b', line: '#45474e', label: '어두운 색' },
};

export const COVER_COLORS = [
  '#3a6df0', '#14a39a', '#e0a526', '#e2574c', '#8a5cf6', '#2f3a4a', '#d9668f', '#6c8f3d',
];

export function newPage(notebookId, { size = 'a4-portrait', template = 'lined', paper = 'white', w, h } = {}) {
  const s = PAGE_SIZES[size] || PAGE_SIZES['a4-portrait'];
  return {
    id: uid(),
    notebookId,
    w: w || s.w,
    h: h || s.h,
    template,
    paper,
    bg: null, // PDF에서 가져온 배경 이미지(Blob)
    items: [],
    updatedAt: Date.now(),
  };
}

export function newNotebook({ title, cover, size, template, paper }) {
  const now = Date.now();
  return {
    id: uid(),
    title: title || '새 노트',
    cover: cover || COVER_COLORS[0],
    size: size || 'a4-portrait',
    template: template || 'lined',
    paper: paper || 'white',
    pageIds: [],
    thumb: null,
    createdAt: now,
    updatedAt: now,
  };
}
