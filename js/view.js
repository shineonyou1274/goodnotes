// 노트 화면: 여러 페이지를 세로로 이어 보여 주고, 펜·손가락 입력과 확대/이동을 처리한다.
import {
  drawStroke, drawStrokeSegment, strokeHitsCircle, eraseFromStroke, itemBounds,
  itemInLasso, transformItem, unionBounds, recognizeShape,
} from './ink.js';
import {
  drawPaper, drawItems, onImageLoaded, FONT_STACK, LINE_HEIGHT, measureTextHeight,
} from './render.js';
import { uid } from './model.js';

const GAP = 28;            // 페이지 사이 간격(페이지 단위)
const MIN_ZOOM = 0.2;
const MAX_ZOOM = 8;
const HOLD_MS = 550;       // 펜을 멈추고 기다리면 도형으로 바꿔 주는 시간

const now = () => performance.now();
const clamp = (v, a, b) => Math.max(a, Math.min(b, v));

export class NoteView {
  constructor(root, host) {
    this.root = root;
    this.host = host;
    this.pages = [];
    this.pos = new Map();
    this.zoom = 1; this.ox = 0; this.oy = 0;
    this.vw = 1; this.vh = 1; this.dpr = 1;
    this.contentW = 1; this.totalH = 1;
    this.touches = new Map();
    this.action = null;
    this.gesture = null;
    this.tap = null;
    this.inertia = null;
    this.selection = null;
    this.hidden = new Set();
    this.penSeen = false;
    this.spaceDown = false;
    this.mainDirty = true;
    this.liveDirty = false;
    this.frame = 0;
    this.currentIndex = 0;
    this.textEdit = null;

    root.classList.add('note-view');
    this.main = document.createElement('canvas');
    this.main.className = 'layer main';
    this.live = document.createElement('canvas');
    this.live.className = 'layer live';
    this.overlay = document.createElement('div');
    this.overlay.className = 'layer overlay';
    root.append(this.main, this.live, this.overlay);
    this.mctx = this.main.getContext('2d');
    this.lctx = this.live.getContext('2d');

    this._bind();
    this.unsubImage = onImageLoaded(() => this.invalidate());
    this.ro = new ResizeObserver(() => this.resize());
    this.ro.observe(root);
    this.resize();
  }

  destroy() {
    this.ro.disconnect();
    this.unsubImage();
    cancelAnimationFrame(this.frame);
    window.removeEventListener('keydown', this._onKeyDown);
    window.removeEventListener('keyup', this._onKeyUp);
    document.removeEventListener('gesturestart', this._prevent);
    this.root.innerHTML = '';
  }

  /* ---------- 배치와 카메라 ---------- */
  setPages(pages, { keepView = true } = {}) {
    this.pages = pages;
    this.layout();
    if (this.selection && !pages.includes(this.selection.page)) this.clearSelection();
    if (!keepView) this.fitWidth();
    else this.clampView();
    this.invalidate();
  }

  layout() {
    this.pos.clear();
    let y = GAP, maxW = 0;
    for (const p of this.pages) {
      this.pos.set(p.id, { x: -p.w / 2, y, w: p.w, h: p.h });
      y += p.h + GAP;
      maxW = Math.max(maxW, p.w);
    }
    this.contentW = maxW || 794;
    this.totalH = y;
  }

  resize() {
    const r = this.root.getBoundingClientRect();
    const firstTime = this.vw <= 1;
    const oldW = this.vw;
    this.vw = Math.max(1, r.width);
    this.vh = Math.max(1, r.height);
    this.dpr = Math.min(window.devicePixelRatio || 1, 3);
    this.desk = getComputedStyle(this.root).getPropertyValue('--desk').trim() || '#e6e6eb';
    for (const c of [this.main, this.live]) {
      c.width = Math.round(this.vw * this.dpr);
      c.height = Math.round(this.vh * this.dpr);
      c.style.width = this.vw + 'px';
      c.style.height = this.vh + 'px';
    }
    if (firstTime) this.fitWidth();
    else {
      // 화면 회전 등으로 폭이 바뀌면 보던 위치를 유지하면서 폭에 맞춘다
      const wasFit = Math.abs(this.zoom - this.fitZoom(oldW)) < 0.01;
      if (wasFit) {
        const topWorld = -this.oy / this.zoom;
        this.zoom = this.fitZoom();
        this.oy = -topWorld * this.zoom;
      }
      this.clampView();
    }
    this.invalidate(true);
  }

  fitZoom(vw = this.vw) {
    const margin = vw < 600 ? 8 : 24;
    return clamp((vw - margin * 2) / this.contentW, MIN_ZOOM, 1.6);
  }

  fitWidth() {
    const idx = this.currentIndex;
    this.zoom = this.fitZoom();
    this.ox = this.vw / 2;
    const p = this.pages[idx];
    this.oy = p ? -(this.pos.get(p.id).y - GAP / 2) * this.zoom : 0;
    this.clampView();
    this.invalidate();
    this.host.onZoom?.(this.zoom, false);
  }

  clampView() {
    const z = this.zoom, pad = 40;
    const cw = this.contentW * z;
    if (cw <= this.vw) this.ox = this.vw / 2;
    else this.ox = clamp(this.ox, this.vw - pad - cw / 2, cw / 2 + pad);
    const ch = this.totalH * z;
    if (ch <= this.vh) this.oy = 0;
    else this.oy = clamp(this.oy, this.vh - ch - pad, pad);
  }

  zoomAt(z, sx, sy) {
    z = clamp(z, MIN_ZOOM, MAX_ZOOM);
    const wx = (sx - this.ox) / this.zoom, wy = (sy - this.oy) / this.zoom;
    this.zoom = z;
    this.ox = sx - wx * z;
    this.oy = sy - wy * z;
    this.clampView();
    this.invalidate();
  }

  scrollToPage(index) {
    const p = this.pages[index];
    if (!p) return;
    this.oy = -(this.pos.get(p.id).y - GAP / 2) * this.zoom;
    this.clampView();
    this.invalidate();
  }

  pageAtWorld(wx, wy, slack = 0) {
    for (const p of this.pages) {
      const r = this.pos.get(p.id);
      if (wx >= r.x - slack && wx <= r.x + r.w + slack && wy >= r.y - slack && wy <= r.y + r.h + slack) return p;
    }
    return null;
  }

  toLocal(page, sx, sy) {
    const r = this.pos.get(page.id);
    return { x: (sx - this.ox) / this.zoom - r.x, y: (sy - this.oy) / this.zoom - r.y };
  }

  // 화면의 점 s 아래에 있는 동영상 (맨 위의 것)
  videoAt(s) {
    const page = this.pageAtWorld((s.x - this.ox) / this.zoom, (s.y - this.oy) / this.zoom);
    if (!page) return null;
    const l = this.toLocal(page, s.x, s.y);
    for (let i = page.items.length - 1; i >= 0; i--) {
      const it = page.items[i];
      if (it.type === 'video' && l.x >= it.x && l.x <= it.x + it.w && l.y >= it.y && l.y <= it.y + it.h) return it;
    }
    return null;
  }

  toScreen(page, x, y) {
    const r = this.pos.get(page.id);
    return { x: this.ox + (r.x + x) * this.zoom, y: this.oy + (r.y + y) * this.zoom };
  }

  // 화면에 가장 많이 보이는 페이지
  computeCurrent() {
    const top = -this.oy / this.zoom, bottom = (this.vh - this.oy) / this.zoom;
    let best = 0, bestVis = -1;
    this.pages.forEach((p, i) => {
      const r = this.pos.get(p.id);
      const vis = Math.min(bottom, r.y + r.h) - Math.max(top, r.y);
      if (vis > bestVis) { bestVis = vis; best = i; }
    });
    if (best !== this.currentIndex) {
      this.currentIndex = best;
      this.host.onPageChange?.(best);
    }
  }

  get currentPage() { return this.pages[this.currentIndex]; }

  // 현재 페이지에서 화면에 보이는 영역의 가운데(페이지 좌표)
  visibleCenter(page = this.currentPage) {
    const c = this.toLocal(page, this.vw / 2, this.vh / 2);
    return { x: clamp(c.x, page.w * 0.15, page.w * 0.85), y: clamp(c.y, page.h * 0.12, page.h * 0.88) };
  }

  /* ---------- 그리기 ---------- */
  invalidate(live = false) {
    this.mainDirty = true;
    if (live || this.selection || this.textEdit) this.liveDirty = true;
    this._schedule();
  }

  invalidateLive() { this.liveDirty = true; this._schedule(); }

  _schedule() {
    if (this.frame) return;
    this.frame = requestAnimationFrame(() => {
      this.frame = 0;
      if (this.inertia) this._stepInertia();
      if (this.mainDirty) this.renderMain();
      if (this.liveDirty) this.renderLive();
      if (this.inertia) this._schedule();
    });
  }

  renderMain() {
    this.mainDirty = false;
    const ctx = this.mctx, dpr = this.dpr, z = this.zoom;
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.fillStyle = this.desk;
    ctx.fillRect(0, 0, this.main.width, this.main.height);
    const vx = -this.ox / z, vy = -this.oy / z, vw = this.vw / z, vh = this.vh / z;
    for (const p of this.pages) {
      const r = this.pos.get(p.id);
      if (r.x > vx + vw || r.x + r.w < vx || r.y > vy + vh || r.y + r.h < vy) continue;
      ctx.setTransform(dpr * z, 0, 0, dpr * z, dpr * (this.ox + r.x * z), dpr * (this.oy + r.y * z));
      ctx.save();
      ctx.shadowColor = 'rgba(0,0,0,0.16)';
      ctx.shadowBlur = 10 * dpr;
      ctx.shadowOffsetY = 2 * dpr;
      ctx.fillStyle = '#fff';
      ctx.fillRect(0, 0, p.w, p.h);
      ctx.restore();
      ctx.save();
      ctx.beginPath();
      ctx.rect(0, 0, p.w, p.h);
      ctx.clip();
      drawPaper(ctx, p, z);
      drawItems(ctx, p.items, { skip: this.hidden, visible: { x: vx - r.x, y: vy - r.y, w: vw, h: vh } });
      ctx.restore();
    }
    if (this.action) { this.liveFull = true; this.liveDirty = true; }
    this.computeCurrent();
    if (this.selection) this.host.onSelectionChange?.(this.selectionScreenRect());
    if (this.textEdit) this._positionTextEdit();
  }

  renderLive() {
    this.liveDirty = false;
    const ctx = this.lctx, dpr = this.dpr;
    const a = this.action;
    // 펜으로 쓰는 중에는 새로 들어온 부분만 덧그린다
    if (a && a.incremental && a.drawn > 0 && !this.liveFull && !this.selection) {
      a.drawLive(ctx);
      return;
    }
    this.liveFull = false;
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.clearRect(0, 0, this.live.width, this.live.height);
    if (a && 'drawn' in a) a.drawn = 0;
    if (a && a.drawLive) a.drawLive(ctx);
    if (this.selection) this._drawSelection(ctx);
    if (a && a.drawCursor) {
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      a.drawCursor(ctx);
    }
  }

  pageTransform(ctx, page) {
    const r = this.pos.get(page.id), z = this.zoom, dpr = this.dpr;
    ctx.setTransform(dpr * z, 0, 0, dpr * z, dpr * (this.ox + r.x * z), dpr * (this.oy + r.y * z));
  }

  clipPage(ctx, page) {
    ctx.beginPath();
    ctx.rect(0, 0, page.w, page.h);
    ctx.clip();
  }

  /* ---------- 선택 ---------- */
  setSelection(page, ids) {
    if (!ids || ids.size === 0) { this.clearSelection(); return; }
    this.selection = { page, ids };
    this.invalidateLive();
    this.host.onSelectionChange?.(this.selectionScreenRect());
  }

  clearSelection() {
    if (!this.selection) return;
    this.selection = null;
    this.invalidateLive();
    this.host.onSelectionChange?.(null);
  }

  selectedItems() {
    if (!this.selection) return [];
    return this.selection.page.items.filter((it) => this.selection.ids.has(it.id));
  }

  selectionBounds() {
    const items = this.selectedItems();
    if (!items.length) return null;
    const b = unionBounds(items);
    const pad = 6;
    return { x: b.x - pad, y: b.y - pad, w: b.w + pad * 2, h: b.h + pad * 2 };
  }

  selectionScreenRect() {
    const b = this.selectionBounds();
    if (!b) return null;
    const a = this.toScreen(this.selection.page, b.x, b.y);
    return { x: a.x, y: a.y, w: b.w * this.zoom, h: b.h * this.zoom };
  }

  _drawSelection(ctx) {
    const r = this.selectionScreenRect();
    if (!r) return;
    const dpr = this.dpr;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.save();
    ctx.strokeStyle = '#3a6df0';
    ctx.lineWidth = 1.5;
    ctx.setLineDash([6, 4]);
    ctx.strokeRect(r.x, r.y, r.w, r.h);
    ctx.setLineDash([]);
    ctx.fillStyle = '#fff';
    ctx.beginPath();
    ctx.arc(r.x + r.w, r.y + r.h, 9, 0, Math.PI * 2);
    ctx.fill();
    ctx.stroke();
    ctx.restore();
  }

  /* ---------- 항목 변경 ---------- */
  commit(page, before, after) {
    page.items = after;
    this.host.onItemsChange(page, before, after);
    this.invalidate();
  }

  setPageItems(page, items) {
    page.items = items;
    if (this.selection && this.selection.page === page) {
      const ids = new Set(items.filter((it) => this.selection.ids.has(it.id)).map((it) => it.id));
      if (ids.size) this.selection.ids = ids; else this.clearSelection();
    }
    this.invalidate();
  }

  deleteSelection() {
    const sel = this.selection;
    if (!sel) return;
    const before = sel.page.items;
    this.clearSelection();
    this.commit(sel.page, before, before.filter((it) => !sel.ids.has(it.id)));
  }

  duplicateSelection() {
    const sel = this.selection;
    if (!sel) return;
    const copies = this.selectedItems().map((it) => ({ ...transformItem(it, 20, 20), id: uid() }));
    const before = sel.page.items;
    this.commit(sel.page, before, [...before, ...copies]);
    this.setSelection(sel.page, new Set(copies.map((c) => c.id)));
  }

  recolorSelection(color) {
    const sel = this.selection;
    if (!sel) return;
    const before = sel.page.items;
    const after = before.map((it) => (sel.ids.has(it.id) && it.type !== 'image' && it.type !== 'video' ? { ...it, color } : it));
    this.commit(sel.page, before, after);
  }

  // 붙여넣기·이미지 넣기: 현재 보이는 곳 가운데에 놓는다
  placeItems(items, page = this.currentPage) {
    if (!page || !items.length) return;
    const b = unionBounds(items);
    const c = this.visibleCenter(page);
    // 페이지 밖으로 나가지 않게 한다
    const cx = b.w < page.w ? clamp(c.x, b.w / 2, page.w - b.w / 2) : page.w / 2;
    const cy = b.h < page.h ? clamp(c.y, b.h / 2, page.h - b.h / 2) : page.h / 2;
    const placed = items.map((it) => ({ ...transformItem(it, cx - (b.x + b.w / 2), cy - (b.y + b.h / 2)), id: uid() }));
    const before = page.items;
    this.commit(page, before, [...before, ...placed]);
    this.setSelection(page, new Set(placed.map((p) => p.id)));
  }

  /* ---------- 글상자 편집 ---------- */
  beginTextEdit(page, item, x, y) {
    this.endTextEdit();
    const s = this.host.textStyle();
    const w = item ? item.w : Math.min(360, Math.max(80, page.w - x - 24));
    const draft = item ? { ...item } : { type: 'text', id: uid(), x, y: y - s.size * 0.7, w, size: s.size, color: s.color, text: '' };
    const ta = document.createElement('textarea');
    ta.className = 'text-edit';
    ta.value = draft.text;
    ta.spellcheck = false;
    ta.setAttribute('autocapitalize', 'off');
    this.overlay.appendChild(ta);
    this.textEdit = { page, item, draft, ta };
    if (item) this.hidden.add(item.id);
    ta.addEventListener('input', () => this._positionTextEdit());
    ta.addEventListener('blur', () => setTimeout(() => { if (this.textEdit && this.textEdit.ta === ta) this.endTextEdit(); }, 0));
    ta.addEventListener('keydown', (e) => { if (e.key === 'Escape') ta.blur(); e.stopPropagation(); });
    this._positionTextEdit();
    this.invalidate();
    ta.focus();
  }

  _positionTextEdit() {
    const t = this.textEdit;
    if (!t) return;
    const { draft, ta, page } = t;
    const p = this.toScreen(page, draft.x, draft.y);
    const z = this.zoom;
    ta.style.left = p.x + 'px';
    ta.style.top = p.y + 'px';
    ta.style.width = draft.w * z + 'px';
    ta.style.fontSize = draft.size * z + 'px';
    ta.style.lineHeight = String(LINE_HEIGHT);
    ta.style.fontFamily = FONT_STACK;
    ta.style.color = draft.color;
    ta.style.height = 'auto';
    ta.style.height = Math.max(ta.scrollHeight, draft.size * LINE_HEIGHT * z) + 'px';
  }

  endTextEdit() {
    const t = this.textEdit;
    if (!t) return;
    this.textEdit = null;
    const { page, item, draft, ta } = t;
    const text = ta.value.replace(/\s+$/, '');
    ta.remove();
    if (item) this.hidden.delete(item.id);
    const before = page.items;
    if (!text) {
      if (item) this.commit(page, before, before.filter((it) => it.id !== item.id));
      else this.invalidate();
      return;
    }
    const next = { ...draft, text };
    next.h = measureTextHeight(this.mctx, next);
    if (item) {
      if (item.text === text) { this.invalidate(); return; }
      this.commit(page, before, before.map((it) => (it.id === item.id ? next : it)));
    } else {
      this.commit(page, before, [...before, next]);
    }
  }

  /* ---------- 입력 ---------- */
  _bind() {
    const c = this.live;
    this._prevent = (e) => e.preventDefault();
    c.addEventListener('pointerdown', (e) => this._onDown(e));
    c.addEventListener('pointermove', (e) => this._onMove(e));
    c.addEventListener('pointerup', (e) => this._onUp(e, false));
    c.addEventListener('pointercancel', (e) => this._onUp(e, true));
    // iOS Safari: 스크롤·확대·돋보기·길게 누르기 메뉴를 막는다
    c.addEventListener('touchstart', this._prevent, { passive: false });
    c.addEventListener('touchmove', this._prevent, { passive: false });
    c.addEventListener('touchend', this._prevent, { passive: false });
    c.addEventListener('contextmenu', this._prevent);
    c.addEventListener('wheel', (e) => this._onWheel(e), { passive: false });
    document.addEventListener('gesturestart', this._prevent);
    this._onKeyDown = (e) => {
      if (e.code === 'Space' && !this.textEdit && !(e.target instanceof HTMLInputElement) && !(e.target instanceof HTMLTextAreaElement)) {
        this.spaceDown = true;
        e.preventDefault();
      }
    };
    this._onKeyUp = (e) => { if (e.code === 'Space') this.spaceDown = false; };
    window.addEventListener('keydown', this._onKeyDown);
    window.addEventListener('keyup', this._onKeyUp);
  }

  _pt(e) {
    const r = this.live.getBoundingClientRect();
    let p = e.pointerType === 'pen' ? e.pressure : 0.5;
    if (!this.host.settings().pressure) p = 0.5;
    return { x: e.clientX - r.left, y: e.clientY - r.top, p, t: e.timeStamp };
  }

  _samples(e) {
    let list = e.getCoalescedEvents ? e.getCoalescedEvents() : null;
    if (!list || !list.length) list = [e];
    return list.map((ev) => this._pt(ev));
  }

  _onDown(e) {
    e.preventDefault();
    this.inertia = null;
    try { this.live.setPointerCapture(e.pointerId); } catch { /* 무시 */ }
    const type = e.pointerType;
    const s = this._pt(e);

    if (this.textEdit) {
      // 글상자 밖을 누르면 편집을 끝낸다
      this.textEdit.ta.blur();
      this.endTextEdit();
      if (type !== 'touch' || this.touches.size === 0) { this.swallow = e.pointerId; return; }
    }

    if (type === 'pen' && !this.penSeen) {
      this.penSeen = true;
      this.host.onPenDetected?.();
    }

    if (type === 'touch') {
      this.touches.set(e.pointerId, { x: s.x, y: s.y, sx: s.x, sy: s.y });
      if (this.touches.size === 1) this.tap = { t0: now(), max: 1, moved: false, s };
      else if (this.tap) this.tap.max = Math.max(this.tap.max, this.touches.size);
      if (this.action) {
        if (this.action.pointerType === 'touch' && this.action.canCancel()) {
          this.action.cancel();
          this.action = null;
          this.invalidateLive();
        } else return; // 펜으로 쓰는 중이면 손바닥으로 보고 무시
      }
      if (this.host.fingerDraws() && this.touches.size === 1 && !this.gesture) {
        this._startAction(e, s);
        return;
      }
      this._startGesture();
      return;
    }

    if (type === 'mouse' && (e.button === 1 || e.button === 2 || this.spaceDown)) {
      this.gesture = { mouse: e.pointerId, bx: s.x, by: s.y, box: this.ox, boy: this.oy };
      return;
    }
    if (type === 'mouse' && e.button !== 0) return;

    if (this.action) {
      if (this.action.pointerType === 'touch') { this.action.cancel(); this.action = null; } else return;
    }
    if (this.gesture && type === 'pen') this.gesture = null;
    this._startAction(e, s);
  }

  _onMove(e) {
    const type = e.pointerType;
    if (type === 'touch' && this.touches.has(e.pointerId)) {
      const s = this._pt(e);
      const t = this.touches.get(e.pointerId);
      t.x = s.x; t.y = s.y;
      if (this.tap && Math.hypot(t.x - t.sx, t.y - t.sy) > 12) this.tap.moved = true;
    }
    if (this.action && this.action.pointerId === e.pointerId) {
      this.action.move(this._samples(e), e);
      return;
    }
    if (this.gesture) {
      if (this.gesture.mouse !== undefined) {
        if (this.gesture.mouse !== e.pointerId) return;
        const s = this._pt(e);
        this.ox = this.gesture.box + (s.x - this.gesture.bx);
        this.oy = this.gesture.boy + (s.y - this.gesture.by);
        this.clampView();
        this.invalidate();
      } else if (type === 'touch') this._updateGesture(e);
    }
  }

  _onUp(e, cancelled) {
    if (this.swallow === e.pointerId) { this.swallow = null; return; }
    const type = e.pointerType;
    if (this.action && this.action.pointerId === e.pointerId) {
      const a = this.action;
      this.action = null;
      // 펜 입력이 시스템에 의해 취소돼도 쓴 내용은 남긴다
      if (cancelled && type === 'touch') a.cancel(); else a.up(this._pt(e), e);
      this.live.style.mixBlendMode = '';
      this.invalidateLive();
    }
    if (this.gesture && this.gesture.mouse === e.pointerId) { this.gesture = null; return; }
    if (type === 'touch' && this.touches.has(e.pointerId)) {
      this.touches.delete(e.pointerId);
      if (this.gesture) {
        if (this.touches.size > 0) this._startGesture();
        else this._endGesture();
      }
      if (this.touches.size === 0 && this.tap) {
        const tap = this.tap;
        this.tap = null;
        if (!tap.moved && now() - tap.t0 < 350 && !cancelled) {
          if (tap.max === 1 && !this.host.fingerDraws()) {
            // 손가락으로 동영상을 톡 누르면 재생한다
            const v = this.videoAt(tap.s);
            if (v) this.host.onPlayVideo?.(v);
          }
          if (tap.max === 2) this.host.onUndoGesture?.();
          else if (tap.max === 3) this.host.onRedoGesture?.();
        }
      }
    }
  }

  _startGesture() {
    const pts = [...this.touches.values()];
    if (!pts.length) return;
    const g = { box: this.ox, boy: this.oy, bz: this.zoom, vel: [] };
    if (pts.length === 1) {
      g.bx = pts[0].x; g.by = pts[0].y;
    } else {
      const [a, b] = pts;
      g.bd = Math.max(1, Math.hypot(a.x - b.x, a.y - b.y));
      g.bmx = (a.x + b.x) / 2; g.bmy = (a.y + b.y) / 2;
      g.wx = (g.bmx - this.ox) / this.zoom; g.wy = (g.bmy - this.oy) / this.zoom;
    }
    g.n = pts.length;
    this.gesture = g;
  }

  _updateGesture() {
    const g = this.gesture;
    const pts = [...this.touches.values()];
    if (pts.length !== g.n) { this._startGesture(); return; }
    if (pts.length === 1) {
      const nx = g.box + (pts[0].x - g.bx), ny = g.boy + (pts[0].y - g.by);
      const t = now();
      g.vel.push({ t, x: nx, y: ny });
      if (g.vel.length > 6) g.vel.shift();
      this.ox = nx; this.oy = ny;
    } else {
      const [a, b] = pts;
      const d = Math.hypot(a.x - b.x, a.y - b.y);
      const mx = (a.x + b.x) / 2, my = (a.y + b.y) / 2;
      const z = clamp(g.bz * (d / g.bd), MIN_ZOOM, MAX_ZOOM);
      this.zoom = z;
      this.ox = mx - g.wx * z;
      this.oy = my - g.wy * z;
      this.host.onZoom?.(z, true);
    }
    this.clampView();
    this.invalidate();
  }

  _endGesture() {
    const g = this.gesture;
    this.gesture = null;
    if (!g) return;
    if (g.n >= 2) this.host.onZoom?.(this.zoom, false);
    if (g.n === 1 && g.vel.length >= 2) {
      const a = g.vel[0], b = g.vel[g.vel.length - 1];
      const dt = b.t - a.t;
      if (dt > 0 && now() - b.t < 80) {
        const vx = (b.x - a.x) / dt, vy = (b.y - a.y) / dt;
        if (Math.hypot(vx, vy) > 0.25) {
          this.inertia = { vx, vy, t: now() };
          this._schedule();
        }
      }
    }
  }

  _stepInertia() {
    const it = this.inertia;
    const t = now();
    const dt = Math.min(40, t - it.t);
    it.t = t;
    const ox = this.ox, oy = this.oy;
    this.ox += it.vx * dt;
    this.oy += it.vy * dt;
    const decay = Math.pow(0.994, dt);
    it.vx *= decay; it.vy *= decay;
    this.clampView();
    this.mainDirty = true;
    if (this.selection || this.textEdit) this.liveDirty = true;
    if (Math.hypot(it.vx, it.vy) < 0.02 || (this.ox === ox && this.oy === oy)) this.inertia = null;
  }

  _onWheel(e) {
    e.preventDefault();
    this.inertia = null;
    const r = this.live.getBoundingClientRect();
    const k = e.deltaMode === 1 ? 16 : e.deltaMode === 2 ? this.vh : 1;
    if (e.ctrlKey || e.metaKey) {
      this.zoomAt(this.zoom * Math.exp(-e.deltaY * k * 0.01), e.clientX - r.left, e.clientY - r.top);
      this.host.onZoom?.(this.zoom, true);
      clearTimeout(this._wheelZoomEnd);
      this._wheelZoomEnd = setTimeout(() => this.host.onZoom?.(this.zoom, false), 400);
    } else {
      this.ox -= (e.shiftKey ? e.deltaY : e.deltaX) * k;
      this.oy -= (e.shiftKey ? 0 : e.deltaY) * k;
      this.clampView();
      this.invalidate();
    }
  }

  _startAction(e, s) {
    let tool = this.host.settings().tool;
    // 펜의 지우개 끝(buttons 32)이나 S펜 옆 버튼(buttons 2)은 지우개로 쓴다
    if (e.pointerType === 'pen' && (e.buttons & 32 || e.buttons & 2 || e.button === 5)) tool = 'eraser';
    const wx = (s.x - this.ox) / this.zoom, wy = (s.y - this.oy) / this.zoom;
    const page = this.pageAtWorld(wx, wy);
    let action = null;
    if (tool === 'lasso') action = this._lassoAction(e, s, page);
    else if (!page) {
      this.clearSelection();
      if (e.pointerType !== 'pen') {
        // 페이지 밖을 마우스로 끌면 화면을 움직인다
        if (e.pointerType === 'mouse') this.gesture = { mouse: e.pointerId, bx: s.x, by: s.y, box: this.ox, boy: this.oy };
      }
      return;
    } else {
      this.clearSelection();
      // 펜·글상자로 동영상을 누르면 재생한다 (옮기거나 지우려면 올가미로 고른다)
      if (tool !== 'eraser') {
        const v = this.videoAt(s);
        if (v) { this.swallow = e.pointerId; this.host.onPlayVideo?.(v); return; }
      }
      if (tool === 'pen' || tool === 'highlighter') action = new StrokeAction(this, page, tool, e, s);
      else if (tool === 'eraser') action = new EraseAction(this, page, e, s);
      else if (tool === 'text') action = new TextAction(this, page, e, s);
    }
    if (!action) return;
    action.pointerId = e.pointerId;
    action.pointerType = e.pointerType;
    action.t0 = now();
    action.sx = s.x; action.sy = s.y;
    action.maxMove = 0;
    if (!action.canCancel) action.canCancel = () => now() - action.t0 < 300 && action.maxMove < 24;
    this.action = action;
    this.invalidateLive();
  }

  _lassoAction(e, s, page) {
    const sel = this.selection;
    if (sel) {
      const r = this.selectionScreenRect();
      if (r) {
        if (Math.hypot(s.x - (r.x + r.w), s.y - (r.y + r.h)) < 26) return new TransformAction(this, s, 'scale');
        if (s.x >= r.x && s.x <= r.x + r.w && s.y >= r.y && s.y <= r.y + r.h) return new TransformAction(this, s, 'move');
      }
      this.clearSelection();
    }
    if (!page) return null;
    return new LassoAction(this, page, s);
  }
}

/* ---------- 펜·형광펜 ---------- */
class StrokeAction {
  constructor(view, page, tool, e, s) {
    this.view = view;
    this.page = page;
    this.tool = tool;
    const st = view.host.toolStyle(tool);
    this.color = st.color;
    this.width = st.width;
    this.constant = tool === 'highlighter' || e.pointerType !== 'pen' || !view.host.settings().pressure;
    this.pts = [];
    this.drawn = 0;
    this.shape = null;
    this.fixFirstPressure = false;
    if (tool === 'highlighter') view.live.style.mixBlendMode = 'multiply';
    this._add(s);
    this._armHold(s);
  }

  get incremental() { return this.tool !== 'highlighter' && !this.shape; }

  _add(s) {
    const v = this.view;
    const l = v.toLocal(this.page, s.x, s.y);
    let p = s.p;
    const n = this.pts.length;
    if (n === 0) {
      if (p <= 0) { p = 0.5; this.fixFirstPressure = true; }
      this.pts.push(l.x, l.y, p);
      this.lx = l.x; this.ly = l.y;
      return;
    }
    if (p <= 0) p = this.pts[n - 1];
    if (this.fixFirstPressure) { this.pts[2] = p; this.fixFirstPressure = false; }
    // 너무 가까운 점은 건너뛴다
    if (Math.hypot(l.x - this.lx, l.y - this.ly) * v.zoom < 0.8) return;
    this.lx = l.x; this.ly = l.y;
    // 손떨림을 줄이는 가벼운 보정
    const k = 0.6;
    const x = this.pts[n - 3] + (l.x - this.pts[n - 3]) * k;
    const y = this.pts[n - 2] + (l.y - this.pts[n - 2]) * k;
    const pp = this.pts[n - 1] + (p - this.pts[n - 1]) * 0.35;
    this.pts.push(x, y, pp);
  }

  _armHold(s) {
    clearTimeout(this.holdTimer);
    if (!this.view.host.settings().shapeAssist) return;
    this.holdAnchor = { x: s.x, y: s.y };
    this.holdTimer = setTimeout(() => this._snap(), HOLD_MS);
  }

  _snap() {
    if (this.shape || this.view.action !== this || this.pts.length < 9) return;
    const res = recognizeShape(this.pts);
    if (!res) return;
    let avg = 0;
    for (let i = 2; i < this.pts.length; i += 3) avg += this.pts[i];
    avg /= this.pts.length / 3;
    const w = this.constant ? this.width : this.width * (0.4 + 1.2 * avg);
    this.shape = res;
    this.shapeWidth = w;
    const pts = [];
    for (const [x, y] of res.points) pts.push(x, y, 0.5);
    this.pts = pts;
    this.drawn = 0;
    this.view.invalidateLive();
    try { navigator.vibrate?.(8); } catch { /* 무시 */ }
  }

  move(samples) {
    if (this.shape) {
      // 직선은 펜을 따라 끝점을 옮길 수 있다
      if (this.shape.kind === 'line') {
        const s = samples[samples.length - 1];
        const l = this.view.toLocal(this.page, s.x, s.y);
        this.pts[3] = l.x; this.pts[4] = l.y;
        this.view.invalidateLive();
      }
      return;
    }
    for (const s of samples) {
      this.maxMove = Math.max(this.maxMove, Math.hypot(s.x - this.sx, s.y - this.sy));
      this._add(s);
    }
    const last = samples[samples.length - 1];
    if (this.holdAnchor && Math.hypot(last.x - this.holdAnchor.x, last.y - this.holdAnchor.y) > 4) this._armHold(last);
    this.view.invalidateLive();
  }

  _item() {
    if (this.shape) {
      return {
        type: 'stroke', id: uid(), tool: this.tool, color: this.color,
        width: this.tool === 'highlighter' ? this.width : this.shapeWidth,
        constant: true, closed: this.shape.closed, pts: new Float32Array(this.pts),
      };
    }
    return {
      type: 'stroke', id: uid(), tool: this.tool, color: this.color, width: this.width,
      constant: this.constant, pts: new Float32Array(this.pts),
    };
  }

  drawLive(ctx) {
    const v = this.view;
    v.pageTransform(ctx, this.page);
    ctx.save();
    v.clipPage(ctx, this.page);
    const n = this.pts.length / 3;
    if (this.tool === 'highlighter' || this.shape) {
      // 전체를 다시 그린다
      drawStroke(ctx, this._item());
    } else {
      // 화면을 지우지 않고 새로 들어온 부분만 이어 그린다
      drawStrokeSegment(ctx, { color: this.color, width: this.width, constant: this.constant, pts: new Float32Array(this.pts) }, this.drawn);
    }
    ctx.restore();
    this.drawn = n;
  }

  up() {
    clearTimeout(this.holdTimer);
    if (!this.pts.length) return;
    const v = this.view;
    v.commit(this.page, this.page.items, [...this.page.items, this._item()]);
    v.renderMain();
  }

  cancel() { clearTimeout(this.holdTimer); }
}

/* ---------- 지우개 ---------- */
class EraseAction {
  constructor(view, page, e, s) {
    this.view = view;
    this.page = page;
    this.before = page.items;
    this.mode = view.host.toolStyle('eraser').mode;
    this.r = view.host.toolStyle('eraser').width / 2;
    this.changed = false;
    this.last = s;
    this.cursor = s;
    this._eraseAt(s);
  }

  _eraseAt(s) {
    const v = this.view, page = this.page;
    const l = v.toLocal(page, s.x, s.y);
    const r = Math.max(this.r, 3 / v.zoom);
    let changed = false;
    const out = [];
    for (const it of page.items) {
      if (it.type !== 'stroke') { out.push(it); continue; }
      if (this.mode === 'stroke') {
        if (strokeHitsCircle(it, l.x, l.y, r)) changed = true; else out.push(it);
      } else {
        const res = eraseFromStroke(it, l.x, l.y, r, uid);
        if (res === null) out.push(it);
        else { changed = true; out.push(...res); }
      }
    }
    if (changed) {
      page.items = out;
      this.changed = true;
      v.mainDirty = true;
    }
  }

  move(samples) {
    for (const s of samples) {
      const d = Math.hypot(s.x - this.last.x, s.y - this.last.y);
      const step = Math.max(2, this.r * this.view.zoom * 0.5);
      const k = Math.ceil(d / step);
      for (let i = 1; i <= k; i++) {
        const t = i / k;
        this._eraseAt({ x: this.last.x + (s.x - this.last.x) * t, y: this.last.y + (s.y - this.last.y) * t });
      }
      this.last = s;
      this.maxMove = Math.max(this.maxMove, Math.hypot(s.x - this.sx, s.y - this.sy));
    }
    this.cursor = samples[samples.length - 1];
    this.view.invalidate(true);
  }

  drawCursor(ctx) {
    const r = Math.max(this.r * this.view.zoom, 3);
    ctx.strokeStyle = 'rgba(60,60,67,0.7)';
    ctx.fillStyle = 'rgba(255,255,255,0.35)';
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.arc(this.cursor.x, this.cursor.y, r, 0, Math.PI * 2);
    ctx.fill();
    ctx.stroke();
  }

  up() {
    if (this.changed) this.view.commit(this.page, this.before, this.page.items);
  }

  cancel() {
    if (this.changed) { this.page.items = this.before; this.view.invalidate(); }
  }
}

/* ---------- 올가미 선택 ---------- */
class LassoAction {
  constructor(view, page, s) {
    this.view = view;
    this.page = page;
    const l = view.toLocal(page, s.x, s.y);
    this.poly = [l.x, l.y];
  }

  move(samples) {
    for (const s of samples) {
      const l = this.view.toLocal(this.page, s.x, s.y);
      this.poly.push(l.x, l.y);
      this.maxMove = Math.max(this.maxMove, Math.hypot(s.x - this.sx, s.y - this.sy));
    }
    this.view.invalidateLive();
  }

  drawLive(ctx) {
    const v = this.view;
    v.pageTransform(ctx, this.page);
    ctx.save();
    ctx.beginPath();
    ctx.moveTo(this.poly[0], this.poly[1]);
    for (let i = 2; i < this.poly.length; i += 2) ctx.lineTo(this.poly[i], this.poly[i + 1]);
    ctx.closePath();
    ctx.fillStyle = 'rgba(58,109,240,0.07)';
    ctx.fill();
    ctx.setLineDash([5 / v.zoom, 4 / v.zoom]);
    ctx.lineWidth = 1.4 / v.zoom;
    ctx.strokeStyle = '#3a6df0';
    ctx.stroke();
    ctx.restore();
  }

  up() {
    if (this.poly.length < 6) {
      // 짧게 누르면 그 자리의 항목 하나를 고른다
      const [x, y] = this.poly;
      const hit = [...this.page.items].reverse().find((it) => {
        if (it.type === 'stroke') return strokeHitsCircle(it, x, y, 8 / this.view.zoom);
        const b = itemBounds(it);
        return x >= b.x && x <= b.x + b.w && y >= b.y && y <= b.y + b.h;
      });
      if (hit) this.view.setSelection(this.page, new Set([hit.id]));
      return;
    }
    const ids = new Set(this.page.items.filter((it) => itemInLasso(it, this.poly)).map((it) => it.id));
    this.view.setSelection(this.page, ids);
  }

  cancel() {}
}

/* ---------- 선택 항목 옮기기·크기 바꾸기 ---------- */
class TransformAction {
  constructor(view, s, mode) {
    this.view = view;
    this.mode = mode;
    const sel = view.selection;
    this.page = sel.page;
    this.ids = sel.ids;
    this.before = this.page.items;
    this.bounds = view.selectionBounds();
    this.start = view.toLocal(this.page, s.x, s.y);
    this.moved = false;
  }

  move(samples) {
    const s = samples[samples.length - 1];
    this.maxMove = Math.max(this.maxMove, Math.hypot(s.x - this.sx, s.y - this.sy));
    const v = this.view;
    const l = v.toLocal(this.page, s.x, s.y);
    let dx = 0, dy = 0, k = 1, ox = 0, oy = 0;
    if (this.mode === 'move') {
      dx = l.x - this.start.x; dy = l.y - this.start.y;
    } else {
      const b = this.bounds;
      ox = b.x; oy = b.y;
      const vx = l.x - ox, vy = l.y - oy;
      k = Math.max(0.1, (vx * b.w + vy * b.h) / (b.w * b.w + b.h * b.h));
    }
    this.moved = true;
    this.page.items = this.before.map((it) => (this.ids.has(it.id) ? transformItem(it, dx, dy, k, ox, oy) : it));
    v.invalidate(true);
  }

  up() {
    if (this.moved) this.view.commit(this.page, this.before, this.page.items);
    this.view.invalidateLive();
  }

  cancel() {
    this.page.items = this.before;
    this.view.invalidate(true);
  }
}

/* ---------- 글상자 ---------- */
class TextAction {
  constructor(view, page, e, s) {
    this.view = view;
    this.page = page;
    this.s = s;
  }
  move(samples) {
    const s = samples[samples.length - 1];
    this.maxMove = Math.max(this.maxMove, Math.hypot(s.x - this.sx, s.y - this.sy));
  }
  up() {
    if (this.maxMove > 20) return;
    const v = this.view;
    const l = v.toLocal(this.page, this.s.x, this.s.y);
    const hit = [...this.page.items].reverse().find((it) => {
      if (it.type !== 'text') return false;
      const b = itemBounds(it);
      return l.x >= b.x - 6 && l.x <= b.x + b.w + 6 && l.y >= b.y - 6 && l.y <= b.y + b.h + 6;
    });
    v.beginTextEdit(this.page, hit || null, l.x, l.y);
  }
  cancel() {}
}
