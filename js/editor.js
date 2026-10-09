// 노트 편집 화면: 상단 막대, 도구 막대, 페이지 목록, 선택 메뉴, 저장·되돌리기
import * as db from './db.js';
import { NoteView } from './view.js';
import { icons } from './icons.js';
import { newPage, uid, TEMPLATES, PAPER_COLORS, PAGE_SIZES } from './model.js';
import { renderPageCanvas, ensurePageImages, loadImage } from './render.js';
import { saveSettings, PEN_PALETTE, HIGHLIGHTER_PALETTE } from './settings.js';
import { exportPdf, pdfToPages } from './pdf.js';
import { exportBackup } from './backup.js';
import { getCloud, shouldSync, needsSync, uploadNotebook } from './cloud.js';
import { assignDialog, giveBackDialog } from './tasks.js';
import {
  h, toast, progress, dialog, confirmDialog, promptDialog, popover, menu, closePopovers,
  saveFile, pickFile, safeFileName,
} from './util.js';

const TOOL_LIST = [
  ['pen', '펜', icons.pen],
  ['highlighter', '형광펜', icons.highlighter],
  ['eraser', '지우개', icons.eraser],
  ['lasso', '올가미 선택', icons.lasso],
  ['text', '글상자', icons.text],
];

export class Editor {
  constructor(app, nb, pages) {
    this.app = app;
    this.nb = nb;
    this.pages = pages;
    this.s = app.settings;
    this.undoStack = [];
    this.redoStack = [];
    this.dirty = new Set();
    this.nbDirty = false;
    this.saveTimer = 0;
    this.thumbTimer = 0;
  }

  /* ---------- 화면 구성 ---------- */
  mount(container) {
    this.el = h('div', { class: 'editor' });
    this.titleBtn = h('button', { class: 'title-btn', onclick: () => this.rename() }, this.nb.title);
    this.undoBtn = this._iconBtn(icons.undo, '실행 취소', () => this.undo());
    this.redoBtn = this._iconBtn(icons.redo, '다시 실행', () => this.redo());
    this.pagesBtn = this._iconBtn(icons.pages, '페이지 목록', () => this.togglePanel());
    const top = h('header', { class: 'topbar' },
      this._iconBtn(icons.back, '노트 목록', () => this.app.goLibrary()),
      this.titleBtn,
      this.nb.remoteId ? h('span', { class: 'badge student' }, this.nb.remoteName || '학생') : null,
      h('div', { class: 'spacer' }),
      this.submitBtn = this.makeSubmitBtn(),
      this.undoBtn, this.redoBtn,
      h('div', { class: 'sep' }),
      this.pagesBtn,
      this._iconBtn(icons.addPage, '페이지 추가', () => this.addPage()),
      this._iconBtn(icons.more, '더 보기', (e) => this.moreMenu(e.currentTarget)));

    this.toolbar = h('div', { class: 'toolbar' });
    this.panel = h('aside', { class: 'pages-panel' });
    this.viewportEl = h('div', { class: 'viewport' });
    this.selMenu = h('div', { class: 'sel-menu hidden' });
    this.pageInd = h('div', { class: 'page-ind' });
    this.zoomInd = h('div', { class: 'zoom-ind' });
    const work = h('div', { class: 'workspace' }, this.panel, h('div', { class: 'view-wrap' }, this.viewportEl, this.selMenu, this.pageInd, this.zoomInd));
    this.el.append(top, this.toolbar, work);
    container.append(this.el);

    this.view = new NoteView(this.viewportEl, {
      settings: () => this.s,
      toolStyle: (tool) => this.toolStyle(tool),
      textStyle: () => ({ size: this.s.text.sizes[this.s.text.size], color: this.s.text.colors[this.s.text.color] }),
      fingerDraws: () => this.s.fingerDraw,
      onItemsChange: (page, before, after) => this.recordChange(page, before, after),
      onPageChange: () => this.updatePageInd(),
      onSelectionChange: (rect) => this.positionSelMenu(rect),
      onZoom: (z, active) => this.showZoom(z, active),
      onPenDetected: () => this.penDetected(),
      onUndoGesture: () => this.undo(),
      onRedoGesture: () => this.redo(),
    });
    this.view.setPages(this.pages, { keepView: false });
    if (this.nb.lastPage) {
      const idx = this.pages.findIndex((p) => p.id === this.nb.lastPage);
      if (idx > 0) { this.view.currentIndex = idx; this.view.scrollToPage(idx); }
    }
    this.renderToolbar();
    this.updateUndo();
    this.updatePageInd();

    this._onKey = (e) => this.onKey(e);
    window.addEventListener('keydown', this._onKey);
    this._onHide = () => { if (document.visibilityState === 'hidden') this.flush(); };
    document.addEventListener('visibilitychange', this._onHide);
    window.addEventListener('pagehide', this._onHide);
  }

  // 학생: 선생님께 제출하는 버튼 (노트를 닫아도 자동으로 제출된다)
  // 선생님: 학생 노트에는 '돌려주기', 문제지에는 '과제로 내주기'
  makeSubmitBtn() {
    const cfg = getCloud();
    if (cfg?.mode === 'owner' && this.nb.remoteId) {
      return h('button', { class: 'submit-btn', onclick: () => this.giveBack() }, '돌려주기');
    }
    if (cfg?.mode === 'owner' && this.nb.worksheet) {
      return h('button', { class: 'submit-btn', onclick: () => this.assign() }, this.nb.taskInfo?.assignedAt ? '다시 내주기' : '과제로 내주기');
    }
    if (!cfg || cfg.mode !== 'student' || !shouldSync(this.nb, cfg)) return null;
    this.isSubmit = true;
    const btn = h('button', { class: 'submit-btn', onclick: () => this.submit() }, '제출하기');
    db.getNotebook(this.nb.id).then((cur) => this.setSubmitted(cur && !cur.fresh && !needsSync(cur, cfg) && cur.syncedAt));
    return btn;
  }

  async giveBack() {
    this.view.endTextEdit();
    await this.flush();
    await giveBackDialog({ id: this.nb.remoteId, title: this.nb.title, name: this.nb.remoteName }, this.nb);
  }

  async assign() {
    this.view.endTextEdit();
    await this.flush();
    if (await assignDialog(this.nb.id)) {
      const cur = await db.getNotebook(this.nb.id);
      this.nb.taskInfo = cur.taskInfo;
      if (this.submitBtn) this.submitBtn.textContent = '다시 내주기';
    }
  }

  setSubmitted(done) {
    if (!this.submitBtn || !this.isSubmit) return;
    this.submitBtn.textContent = done ? '제출됨 ✓' : '제출하기';
    this.submitBtn.classList.toggle('done', !!done);
  }

  async submit() {
    if (this.submitting) return;
    this.submitting = true;
    this.view.endTextEdit();
    try {
      await this.flush();
      if ((await db.getNotebook(this.nb.id))?.fresh) { toast('답을 먼저 쓰고 제출하세요'); return; }
      progress('선생님께 제출하는 중…');
      const sent = await uploadNotebook(this.nb.id, (m) => progress(m));
      progress(null);
      this.setSubmitted(true);
      toast(sent ? '선생님께 제출했습니다 ✓' : '이미 제출했습니다. 고친 내용이 없어요.');
    } catch (e) {
      progress(null);
      toast('제출하지 못했습니다: ' + e.message, 5000);
    } finally {
      this.submitting = false;
    }
  }

  _iconBtn(icon, label, onclick, extra = {}) {
    return h('button', { class: 'icon-btn', title: label, 'aria-label': label, html: icon, onclick, ...extra });
  }

  async close() {
    this.view.endTextEdit();
    closePopovers();
    window.removeEventListener('keydown', this._onKey);
    document.removeEventListener('visibilitychange', this._onHide);
    window.removeEventListener('pagehide', this._onHide);
    this.nb.lastPage = this.view.currentPage?.id;
    this.nbDirty = true;
    await this.updateCover();
    await this.flush();
    this.view.destroy();
    this.el.remove();
  }

  /* ---------- 도구 ---------- */
  toolStyle(tool) {
    const t = this.s[tool];
    if (tool === 'eraser') return { mode: t.mode, width: t.widths[t.width] };
    return { color: t.colors[t.color], width: t.widths[t.width] };
  }

  setTool(tool) {
    if (this.s.tool !== tool) {
      this.view.endTextEdit();
      this.view.clearSelection();
    }
    this.s.tool = tool;
    saveSettings(this.s);
    this.renderToolbar();
  }

  renderToolbar() {
    const s = this.s, tb = this.toolbar;
    tb.innerHTML = '';
    const tools = h('div', { class: 'tb-group tools' });
    for (const [id, label, icon] of TOOL_LIST) {
      tools.append(h('button', {
        class: `tool-btn ${s.tool === id ? 'active' : ''}`, title: label, 'aria-label': label, html: icon,
        onclick: () => this.setTool(id),
      }));
    }
    tools.append(h('button', { class: 'tool-btn', title: '사진 넣기', 'aria-label': '사진 넣기', html: icons.image, onclick: () => this.insertImage() }));
    tb.append(tools, h('div', { class: 'tb-sep' }));

    const tool = s.tool;
    if (tool === 'pen' || tool === 'highlighter' || tool === 'text') {
      const t = s[tool];
      const colors = h('div', { class: 'tb-group colors' });
      t.colors.forEach((c, i) => {
        const btn = h('button', {
          class: `swatch ${t.color === i ? 'active' : ''}`, 'aria-label': `색 ${i + 1}`,
          style: { '--c': c },
          onclick: (e) => {
            if (t.color === i) this.colorPopover(e.currentTarget, tool, i);
            else { t.color = i; saveSettings(s); this.renderToolbar(); }
          },
        });
        colors.append(btn);
      });
      tb.append(colors, h('div', { class: 'tb-sep' }));
      const sizes = h('div', { class: 'tb-group sizes' });
      const list = tool === 'text' ? t.sizes : t.widths;
      const cur = tool === 'text' ? t.size : t.width;
      list.forEach((w, i) => {
        const dot = tool === 'text'
          ? h('span', { class: 'size-text', style: { fontSize: 11 + i * 4 + 'px' } }, '가')
          : h('span', { class: 'size-dot', style: { width: dotSize(tool, w) + 'px', height: dotSize(tool, w) + 'px', background: tool === 'highlighter' ? t.colors[t.color] : 'currentColor' } });
        sizes.append(h('button', {
          class: `size-btn ${cur === i ? 'active' : ''}`, 'aria-label': `굵기 ${i + 1}`,
          onclick: (e) => {
            if (cur === i) this.sizePopover(e.currentTarget, tool, i);
            else { if (tool === 'text') t.size = i; else t.width = i; saveSettings(s); this.renderToolbar(); }
          },
        }, dot));
      });
      tb.append(sizes);
    } else if (tool === 'eraser') {
      const t = s.eraser;
      const modes = h('div', { class: 'tb-group seg' },
        h('button', { class: `seg-btn ${t.mode === 'partial' ? 'active' : ''}`, onclick: () => { t.mode = 'partial'; saveSettings(s); this.renderToolbar(); } }, '부분 지우개'),
        h('button', { class: `seg-btn ${t.mode === 'stroke' ? 'active' : ''}`, onclick: () => { t.mode = 'stroke'; saveSettings(s); this.renderToolbar(); } }, '획 지우개'));
      const sizes = h('div', { class: 'tb-group sizes' });
      t.widths.forEach((w, i) => {
        sizes.append(h('button', {
          class: `size-btn ${t.width === i ? 'active' : ''}`, 'aria-label': `지우개 크기 ${i + 1}`,
          onclick: () => { t.width = i; saveSettings(s); this.renderToolbar(); },
        }, h('span', { class: 'size-ring', style: { width: 8 + i * 6 + 'px', height: 8 + i * 6 + 'px' } })));
      });
      tb.append(modes, h('div', { class: 'tb-sep' }), sizes);
    } else if (tool === 'lasso') {
      tb.append(h('div', { class: 'tb-hint' }, '고를 부분을 둘러 그리거나 눌러서 고르세요'));
      if (this.app.clipboard.length) {
        tb.append(h('button', { class: 'chip-btn', html: `${icons.paste}<span>붙여넣기</span>`, onclick: () => this.paste() }));
      }
    }
    tb.append(h('div', { class: 'spacer' }));
    tb.append(h('button', {
      class: `tool-btn finger ${s.fingerDraw ? 'active' : ''}`,
      title: s.fingerDraw ? '손가락으로 그리기: 켜짐' : '손가락으로 그리기: 꺼짐 (손가락은 이동·확대)',
      'aria-label': '손가락으로 그리기', html: icons.hand,
      onclick: () => {
        s.fingerDraw = !s.fingerDraw;
        s.autoFinger = false;
        saveSettings(s);
        this.renderToolbar();
        toast(s.fingerDraw ? '손가락으로도 그릴 수 있습니다' : '손가락은 화면 이동·확대에만 씁니다');
      },
    }));
  }

  colorPopover(anchor, tool, idx) {
    const t = this.s[tool];
    const palette = tool === 'highlighter' ? HIGHLIGHTER_PALETTE : PEN_PALETTE;
    const choose = (c) => { t.colors[idx] = c; saveSettings(this.s); pop.close(); this.renderToolbar(); };
    const grid = h('div', { class: 'palette' }, palette.map((c) => h('button', {
      class: `swatch ${c === t.colors[idx] ? 'active' : ''}`, style: { '--c': c }, 'aria-label': c, onclick: () => choose(c),
    })));
    const custom = h('input', { type: 'color', value: t.colors[idx], class: 'color-input' });
    custom.addEventListener('change', () => choose(custom.value));
    const pop = popover(anchor, h('div', { class: 'pop-pad' }, h('div', { class: 'pop-title' }, '색 고르기'), grid,
      h('label', { class: 'custom-color' }, custom, '직접 고르기')));
  }

  sizePopover(anchor, tool, idx) {
    const t = this.s[tool];
    const isText = tool === 'text';
    const list = isText ? t.sizes : t.widths;
    const [min, max, step] = isText ? [8, 96, 1] : tool === 'highlighter' ? [4, 48, 1] : [0.5, 16, 0.1];
    const label = h('span', { class: 'pop-value' }, fmt(list[idx]));
    const range = h('input', { type: 'range', min, max, step, value: list[idx], class: 'range' });
    range.addEventListener('input', () => {
      list[idx] = Number(range.value);
      label.textContent = fmt(list[idx]);
      saveSettings(this.s);
    });
    popover(anchor, h('div', { class: 'pop-pad', style: { width: '240px' } },
      h('div', { class: 'pop-title' }, isText ? '글자 크기 ' : '굵기 ', label), range),
    { onClose: () => this.renderToolbar() });
  }

  penDetected() {
    if (this.s.autoFinger && this.s.fingerDraw) {
      this.s.fingerDraw = false;
      saveSettings(this.s);
      this.renderToolbar();
      toast('펜이 감지되었습니다. 이제 손가락은 화면 이동·확대에만 씁니다.', 3600);
    }
  }

  /* ---------- 변경 기록·저장 ---------- */
  recordChange(page, before, after) {
    if (before === after) return;
    this.undoStack.push({ page, before, after });
    if (this.undoStack.length > 200) this.undoStack.shift();
    this.redoStack.length = 0;
    this.markDirty(page);
    this.updateUndo();
  }

  undo() {
    this.view.endTextEdit();
    const e = this.undoStack.pop();
    if (!e) return;
    this.redoStack.push(e);
    this.view.setPageItems(e.page, e.before);
    this.revealPage(e.page);
    this.markDirty(e.page);
    this.updateUndo();
  }

  redo() {
    const e = this.redoStack.pop();
    if (!e) return;
    this.undoStack.push(e);
    this.view.setPageItems(e.page, e.after);
    this.revealPage(e.page);
    this.markDirty(e.page);
    this.updateUndo();
  }

  revealPage(page) {
    const idx = this.pages.indexOf(page);
    const v = this.view;
    const r = v.pos.get(page.id);
    if (!r) return;
    const top = -v.oy / v.zoom, bottom = (v.vh - v.oy) / v.zoom;
    if (r.y + r.h < top || r.y > bottom) v.scrollToPage(idx);
  }

  updateUndo() {
    this.undoBtn.disabled = !this.undoStack.length;
    this.redoBtn.disabled = !this.redoStack.length;
  }

  markDirty(page) {
    page.updatedAt = Date.now();
    this.dirty.add(page);
    this.nbDirty = true;
    this.contentChanged = true;
    this.setSubmitted(false);
    clearTimeout(this.saveTimer);
    this.saveTimer = setTimeout(() => this.flush(), 700);
    if (this.panelOpen) {
      clearTimeout(this.thumbTimer);
      this.thumbTimer = setTimeout(() => this.refreshThumb(page), 500);
    }
  }

  async flush() {
    clearTimeout(this.saveTimer);
    const pages = [...this.dirty].filter((p) => this.pages.includes(p));
    this.dirty.clear();
    const nbChanged = this.nbDirty;
    this.nbDirty = false;
    try {
      if (pages.length) await db.putPages(pages);
      if (nbChanged || pages.length) {
        // 내용이 바뀐 때만 '수정 시각'을 바꾼다 (그래야 클라우드에 다시 올릴 노트를 알 수 있다)
        if (this.contentChanged || pages.length) { this.nb.updatedAt = Date.now(); delete this.nb.fresh; }
        this.contentChanged = false;
        this.nb.pageIds = this.pages.map((p) => p.id);
        // 그사이 클라우드 동기화가 적어 둔 값은 지우지 않는다
        const cur = await db.getNotebook(this.nb.id);
        if (cur) {
          this.nb.syncedAt = cur.syncedAt;
          if ('cloud' in cur) this.nb.cloud = cur.cloud;
        }
        await db.putNotebook(this.nb);
      }
    } catch (err) {
      console.error(err);
      toast('저장하지 못했습니다. 기기 저장 공간을 확인하세요.', 4000);
    }
  }

  async updateCover() {
    const first = this.pages[0];
    if (!first) return;
    try {
      await ensurePageImages(first);
      const c = renderPageCanvas(first, 300 / first.w);
      this.nb.thumb = c.toDataURL('image/jpeg', 0.8);
      c.width = c.height = 0;
    } catch { /* 무시 */ }
  }

  /* ---------- 페이지 ---------- */
  updatePageInd() {
    const i = this.view ? this.view.currentIndex : 0;
    this.pageInd.textContent = `${i + 1} / ${this.pages.length}`;
    if (this.panelOpen) {
      this.panel.querySelectorAll('.thumb').forEach((t, k) => t.classList.toggle('current', k === i));
    }
  }

  showZoom(z, active) {
    this.zoomInd.textContent = Math.round(z * 100) + '%';
    this.zoomInd.classList.add('show');
    clearTimeout(this.zoomTimer);
    if (!active) this.zoomTimer = setTimeout(() => this.zoomInd.classList.remove('show'), 700);
  }

  pagesChanged(scrollTo) {
    this.nb.pageIds = this.pages.map((p) => p.id);
    this.nbDirty = true;
    this.contentChanged = true;
    this.view.setPages(this.pages);
    if (scrollTo !== undefined) {
      this.view.currentIndex = scrollTo;
      this.view.scrollToPage(scrollTo);
    }
    this.updatePageInd();
    if (this.panelOpen) this.renderPanel();
    clearTimeout(this.saveTimer);
    this.saveTimer = setTimeout(() => this.flush(), 300);
  }

  addPage(at = this.view.currentIndex + 1, like = this.view.currentPage) {
    const p = newPage(this.nb.id, { template: like?.bg ? this.nb.template : like?.template || this.nb.template, paper: like?.paper || this.nb.paper, size: this.nb.size });
    if (like && !like.bg) { p.w = like.w; p.h = like.h; }
    this.pages.splice(at, 0, p);
    this.dirty.add(p);
    this.pagesChanged(at);
    toast(`${at + 1}쪽을 추가했습니다`);
  }

  duplicatePage(i) {
    const src = this.pages[i];
    const p = { ...src, id: uid(), items: src.items.map((it) => ({ ...it, id: uid() })), updatedAt: Date.now() };
    this.pages.splice(i + 1, 0, p);
    this.dirty.add(p);
    this.pagesChanged(i + 1);
  }

  async deletePage(i) {
    const ok = await confirmDialog('페이지 삭제', `${i + 1}쪽을 지울까요? 되돌릴 수 없습니다.`);
    if (!ok) return;
    const [p] = this.pages.splice(i, 1);
    this.undoStack = this.undoStack.filter((e) => e.page !== p);
    this.redoStack = this.redoStack.filter((e) => e.page !== p);
    this.updateUndo();
    this.dirty.delete(p);
    await db.deletePages([p.id]);
    if (!this.pages.length) {
      const np = newPage(this.nb.id, { template: this.nb.template, paper: this.nb.paper, size: this.nb.size });
      this.pages.push(np);
      this.dirty.add(np);
    }
    this.pagesChanged(Math.min(i, this.pages.length - 1));
  }

  movePage(i, dir) {
    const j = i + dir;
    if (j < 0 || j >= this.pages.length) return;
    [this.pages[i], this.pages[j]] = [this.pages[j], this.pages[i]];
    this.pagesChanged(j);
  }

  togglePanel() {
    this.panelOpen = !this.panelOpen;
    this.el.classList.toggle('panel-open', this.panelOpen);
    this.pagesBtn.classList.toggle('active', this.panelOpen);
    if (this.panelOpen) this.renderPanel();
    else this.panel.innerHTML = '';
    // 패널이 열리고 닫히면 보기 영역 크기가 바뀐다
    requestAnimationFrame(() => this.view.resize());
  }

  renderPanel() {
    const panel = this.panel;
    panel.innerHTML = '';
    this.thumbs = new Map();
    const list = h('div', { class: 'thumb-list' });
    this.pages.forEach((p, i) => {
      const canvas = h('canvas', { class: 'thumb-canvas' });
      const thumb = h('div', { class: `thumb ${i === this.view.currentIndex ? 'current' : ''}` },
        h('button', { class: 'thumb-img', 'aria-label': `${i + 1}쪽으로 가기`, onclick: () => { this.view.scrollToPage(i); if (window.innerWidth < 700) this.togglePanel(); } }, canvas),
        h('div', { class: 'thumb-foot' },
          h('span', {}, String(i + 1)),
          h('button', { class: 'mini-btn', 'aria-label': `${i + 1}쪽 메뉴`, html: icons.more, onclick: (e) => this.pageMenu(e.currentTarget, i) })));
      list.append(thumb);
      this.thumbs.set(p, canvas);
    });
    panel.append(list, h('button', { class: 'btn add-page-btn', onclick: () => this.addPage(this.pages.length, this.pages[this.pages.length - 1]) }, '+ 페이지 추가'));
    // 보이는 썸네일만 그린다
    const io = new IntersectionObserver((entries) => {
      for (const en of entries) {
        if (!en.isIntersecting) continue;
        io.unobserve(en.target);
        const page = [...this.thumbs].find(([, c]) => c === en.target)?.[0];
        if (page) this.refreshThumb(page);
      }
    }, { root: panel });
    this.thumbs.forEach((c) => io.observe(c));
  }

  async refreshThumb(page) {
    const canvas = this.thumbs?.get(page);
    if (!canvas) return;
    await ensurePageImages(page);
    const scale = 150 / page.w;
    renderPageCanvas(page, scale * Math.min(2, window.devicePixelRatio || 1), canvas);
    canvas.style.aspectRatio = `${page.w} / ${page.h}`;
  }

  pageMenu(anchor, i) {
    menu(anchor, [
      { label: '앞으로 옮기기', icon: icons.up, action: () => this.movePage(i, -1) },
      { label: '뒤로 옮기기', icon: icons.down, action: () => this.movePage(i, 1) },
      { label: '뒤에 새 페이지', icon: icons.addPage, action: () => this.addPage(i + 1, this.pages[i]) },
      { label: '페이지 복제', icon: icons.duplicate, action: () => this.duplicatePage(i) },
      { label: '서식 바꾸기', icon: icons.template, action: () => this.templateDialog(i) },
      '-',
      { label: '페이지 삭제', icon: icons.trash, danger: true, action: () => this.deletePage(i) },
    ]);
  }

  async templateDialog(i = this.view.currentIndex) {
    const page = this.pages[i];
    let tpl = page.template, paper = page.paper, scope = 'page';
    const tplGrid = h('div', { class: 'choice-grid' });
    const paperRow = h('div', { class: 'choice-row' });
    const draw = () => {
      tplGrid.innerHTML = '';
      for (const [id, label] of Object.entries(TEMPLATES)) {
        tplGrid.append(h('button', { class: `choice ${tpl === id ? 'active' : ''}`, onclick: () => { tpl = id; draw(); } },
          templatePreview(id, paper), h('span', {}, label)));
      }
      paperRow.innerHTML = '';
      for (const [id, pc] of Object.entries(PAPER_COLORS)) {
        paperRow.append(h('button', { class: `paper-chip ${paper === id ? 'active' : ''}`, onclick: () => { paper = id; draw(); } },
          h('span', { class: 'paper-dot', style: { background: pc.fill } }), pc.label));
      }
    };
    draw();
    const scopeSel = h('select', { class: 'input' },
      h('option', { value: 'page' }, `이 페이지만 (${i + 1}쪽)`),
      h('option', { value: 'all' }, '모든 페이지'));
    scopeSel.addEventListener('change', () => { scope = scopeSel.value; });
    const ok = await dialog({
      title: '페이지 서식',
      body: h('div', { class: 'form' }, h('label', { class: 'field-label' }, '서식'), tplGrid, h('label', { class: 'field-label' }, '종이 색'), paperRow, h('label', { class: 'field-label' }, '적용 범위'), scopeSel),
      buttons: [{ label: '취소', value: false }, { label: '적용', value: true, primary: true }],
    });
    if (!ok) return;
    const targets = scope === 'all' ? this.pages : [page];
    for (const p of targets) {
      p.template = tpl;
      p.paper = paper;
      this.markDirty(p);
    }
    if (scope === 'all') { this.nb.template = tpl; this.nb.paper = paper; }
    this.view.invalidate();
    if (this.panelOpen) targets.forEach((p) => this.refreshThumb(p));
  }

  /* ---------- 선택 메뉴 ---------- */
  positionSelMenu(rect) {
    const m = this.selMenu;
    if (!rect) { m.classList.add('hidden'); m.innerHTML = ''; return; }
    if (!m.childElementCount) {
      m.append(
        h('button', { onclick: () => this.cut() }, '잘라내기'),
        h('button', { onclick: () => this.copy() }, '복사'),
        h('button', { onclick: () => this.view.duplicateSelection() }, '복제'),
        h('button', { onclick: (e) => this.recolor(e.currentTarget) }, '색 바꾸기'),
        h('button', { class: 'danger', onclick: () => this.view.deleteSelection() }, '삭제'));
    }
    m.classList.remove('hidden');
    const vw = this.viewportEl.clientWidth;
    const mw = m.offsetWidth, mh = m.offsetHeight;
    let x = rect.x + rect.w / 2 - mw / 2;
    x = Math.max(8, Math.min(vw - mw - 8, x));
    let y = rect.y - mh - 12;
    if (y < 8) y = Math.min(rect.y + rect.h + 16, this.viewportEl.clientHeight - mh - 8);
    m.style.transform = `translate(${Math.round(x)}px, ${Math.round(y)}px)`;
  }

  copy() {
    const items = this.view.selectedItems();
    if (!items.length) return;
    this.app.clipboard = items.map((it) => ({ ...it }));
    toast('복사했습니다');
    if (this.s.tool === 'lasso') this.renderToolbar();
  }

  cut() {
    this.copy();
    this.view.deleteSelection();
  }

  paste() {
    if (!this.app.clipboard.length) return;
    if (this.s.tool !== 'lasso') this.setTool('lasso');
    this.view.placeItems(this.app.clipboard);
  }

  recolor(anchor) {
    const grid = h('div', { class: 'palette' }, PEN_PALETTE.concat(HIGHLIGHTER_PALETTE.slice(0, 8)).map((c) => h('button', {
      class: 'swatch', style: { '--c': c }, 'aria-label': c,
      onclick: () => { pop.close(); this.view.recolorSelection(c); },
    })));
    const pop = popover(anchor, h('div', { class: 'pop-pad' }, h('div', { class: 'pop-title' }, '선택한 항목의 색'), grid));
  }

  /* ---------- 사진 ---------- */
  async insertImage() {
    const file = await pickFile('image/*');
    if (!file) return;
    try {
      const img = await loadImage(file);
      if (!img) throw new Error();
      const blob = await shrinkImage(file, img);
      const page = this.view.currentPage;
      const maxW = page.w * 0.6, maxH = page.h * 0.5;
      const k = Math.min(1, maxW / img.width, maxH / img.height);
      const item = { type: 'image', id: uid(), x: 0, y: 0, w: img.width * k, h: img.height * k, blob };
      this.setTool('lasso');
      this.view.placeItems([item], page);
      toast('사진을 넣었습니다. 끌어서 옮기고 모서리로 크기를 바꾸세요.');
    } catch {
      toast('사진을 열 수 없습니다');
    }
  }

  /* ---------- 더 보기 메뉴 ---------- */
  moreMenu(anchor) {
    const s = this.s;
    const toggle = (key, label) => ({
      label, checked: s[key],
      action: () => { s[key] = !s[key]; if (key === 'fingerDraw') s.autoFinger = false; saveSettings(s); this.renderToolbar(); },
    });
    const i = this.view.currentIndex;
    menu(anchor, [
      { label: '페이지 서식 바꾸기', icon: icons.template, action: () => this.templateDialog() },
      { label: '이 페이지 복제', icon: icons.duplicate, action: () => this.duplicatePage(i) },
      { label: 'PDF 쪽 가져와 넣기', icon: icons.upload, action: () => this.importPdfPages() },
      { label: '이 페이지 삭제', icon: icons.trash, danger: true, action: () => this.deletePage(i) },
      '-',
      { label: '화면 폭에 맞추기', icon: icons.fit, action: () => this.view.fitWidth() },
      '-',
      { label: 'PDF로 내보내기', icon: icons.pdf, action: () => this.exportPdf() },
      { label: '백업 파일로 내보내기', icon: icons.download, action: () => this.exportBackup() },
      getCloud()?.mode === 'owner' && !this.nb.remoteId ? { label: '과제로 내주기', icon: icons.upload, action: () => this.assign() } : null,
      '-',
      toggle('fingerDraw', '손가락으로 그리기'),
      toggle('pressure', '필압 사용 (펜)'),
      toggle('shapeAssist', '멈추면 도형으로 바꾸기'),
    ]);
  }

  async rename() {
    const name = await promptDialog('노트 이름', this.nb.title);
    if (!name) return;
    this.nb.title = name;
    this.titleBtn.textContent = name;
    this.nbDirty = true;
    this.contentChanged = true;
    this.flush();
  }

  async exportPdf() {
    this.view.endTextEdit();
    await this.flush();
    try {
      progress('PDF 만드는 중…');
      const blob = await exportPdf(this.pages, (i, n) => progress(`PDF 만드는 중… ${i} / ${n}`));
      progress(null);
      await saveFile(blob, safeFileName(this.nb.title) + '.pdf');
    } catch (e) {
      console.error(e);
      progress(null);
      toast('PDF를 만들지 못했습니다');
    }
  }

  async exportBackup() {
    this.view.endTextEdit();
    await this.flush();
    try {
      progress('백업 파일 만드는 중…');
      const blob = await exportBackup(this.nb, this.pages);
      progress(null);
      await saveFile(blob, safeFileName(this.nb.title) + '.gnote');
    } catch (e) {
      console.error(e);
      progress(null);
      toast('백업 파일을 만들지 못했습니다');
    }
  }

  async importPdfPages() {
    const file = await pickFile('application/pdf,.pdf');
    if (!file) return;
    try {
      progress('PDF 여는 중…');
      const newPages = await pdfToPages(file, this.nb.id, (i, n) => progress(`PDF 가져오는 중… ${i} / ${n}`));
      progress(null);
      const at = this.view.currentIndex + 1;
      this.pages.splice(at, 0, ...newPages);
      newPages.forEach((p) => this.dirty.add(p));
      this.pagesChanged(at);
      toast(`${newPages.length}쪽을 넣었습니다`);
    } catch (e) {
      console.error(e);
      progress(null);
      toast('PDF를 열 수 없습니다');
    }
  }

  /* ---------- 단축키 ---------- */
  onKey(e) {
    if (e.target instanceof HTMLInputElement || e.target instanceof HTMLTextAreaElement || e.target instanceof HTMLSelectElement) return;
    if (document.querySelector('.dialog-back')) return;
    const mod = e.metaKey || e.ctrlKey;
    const k = e.key.toLowerCase();
    if (mod && k === 'z') { e.preventDefault(); if (e.shiftKey) this.redo(); else this.undo(); return; }
    if (mod && k === 'y') { e.preventDefault(); this.redo(); return; }
    if (mod && k === 'c') { this.copy(); return; }
    if (mod && k === 'x') { this.cut(); return; }
    if (mod && k === 'v') { e.preventDefault(); this.paste(); return; }
    if (mod && k === 'd') { e.preventDefault(); this.view.duplicateSelection(); return; }
    if (mod && k === '0') { e.preventDefault(); this.view.fitWidth(); return; }
    if (mod && (k === '=' || k === '+')) { e.preventDefault(); this.view.zoomAt(this.view.zoom * 1.25, this.view.vw / 2, this.view.vh / 2); return; }
    if (mod && k === '-') { e.preventDefault(); this.view.zoomAt(this.view.zoom / 1.25, this.view.vw / 2, this.view.vh / 2); return; }
    if (mod) return;
    if (k === 'delete' || k === 'backspace') { this.view.deleteSelection(); return; }
    if (k === 'escape') { this.view.clearSelection(); return; }
    const map = { p: 'pen', h: 'highlighter', e: 'eraser', l: 'lasso', t: 'text' };
    if (map[k]) this.setTool(map[k]);
    if (k === 'pagedown') this.view.scrollToPage(Math.min(this.pages.length - 1, this.view.currentIndex + 1));
    if (k === 'pageup') this.view.scrollToPage(Math.max(0, this.view.currentIndex - 1));
  }
}

function fmt(v) { return Number.isInteger(v) ? String(v) : v.toFixed(1); }

function dotSize(tool, w) {
  if (tool === 'highlighter') return Math.min(22, 6 + w * 0.6);
  return Math.min(18, 3 + w * 2.2);
}

// 너무 큰 사진은 줄여서 저장한다
async function shrinkImage(file, img) {
  const max = 2000;
  if (Math.max(img.width, img.height) <= max && file.size < 1.5e6) return file;
  const k = max / Math.max(img.width, img.height);
  const c = document.createElement('canvas');
  c.width = Math.round(img.width * Math.min(1, k));
  c.height = Math.round(img.height * Math.min(1, k));
  c.getContext('2d').drawImage(img, 0, 0, c.width, c.height);
  const type = file.type === 'image/png' ? 'image/png' : 'image/jpeg';
  const blob = await new Promise((r) => c.toBlob(r, type, 0.88));
  c.width = c.height = 0;
  return blob || file;
}

export function templatePreview(template, paper = 'white', size = 'a4-portrait') {
  const s = PAGE_SIZES[size] || PAGE_SIZES['a4-portrait'];
  const page = { w: s.w, h: s.h, template, paper, bg: null, items: [] };
  const c = renderPageCanvas(page, 72 / s.w * 2);
  c.className = 'tpl-preview';
  return c;
}
