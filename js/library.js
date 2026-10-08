// 노트 목록(서재) 화면
import * as db from './db.js';
import { icons } from './icons.js';
import { newNotebook, newPage, uid, COVER_COLORS, TEMPLATES, PAPER_COLORS, PAGE_SIZES } from './model.js';
import { pdfToPages, exportPdf } from './pdf.js';
import { exportBackup, importBackup } from './backup.js';
import { templatePreview } from './editor.js';
import {
  h, toast, progress, dialog, confirmDialog, promptDialog, menu, pickFile, saveFile, safeFileName, formatDate,
} from './util.js';

export class Library {
  constructor(app) {
    this.app = app;
    this.query = '';
  }

  async mount(container) {
    this.el = h('div', { class: 'library' });
    this.search = h('input', { class: 'search', type: 'search', placeholder: '노트 찾기', 'aria-label': '노트 찾기' });
    this.search.addEventListener('input', () => { this.query = this.search.value.trim().toLowerCase(); this.renderGrid(); });
    const header = h('header', { class: 'lib-header' },
      h('h1', {}, '노트'),
      h('div', { class: 'spacer' }),
      h('label', { class: 'search-wrap' }, h('span', { html: icons.search }), this.search),
      h('button', { class: 'btn', onclick: (e) => this.importMenu(e.currentTarget) }, h('span', { html: icons.upload }), h('span', { class: 'hide-sm' }, '가져오기')),
      h('button', { class: 'btn primary', onclick: () => this.createDialog() }, h('span', { html: icons.plus }), h('span', {}, '새 노트')));
    this.grid = h('main', { class: 'grid' });
    this.el.append(header, this.grid);
    container.append(this.el);
    await this.load();
  }

  destroy() { this.el?.remove(); }

  async load() {
    this.notebooks = (await db.getAllNotebooks()).sort((a, b) => b.updatedAt - a.updatedAt);
    this.renderGrid();
  }

  renderGrid() {
    const g = this.grid;
    g.innerHTML = '';
    const list = this.notebooks.filter((n) => !this.query || n.title.toLowerCase().includes(this.query));
    g.append(h('button', { class: 'card new-card', onclick: () => this.createDialog() },
      h('div', { class: 'cover new-cover', html: icons.plus }), h('div', { class: 'card-title' }, '새 노트')));
    for (const nb of list) {
      const cover = nb.thumb
        ? h('div', { class: 'cover thumb-cover', style: { '--cover': nb.cover } }, h('img', { src: nb.thumb, alt: '', draggable: 'false' }))
        : h('div', { class: 'cover color-cover', style: { '--cover': nb.cover } }, h('span', {}, nb.title));
      g.append(h('div', { class: 'card' },
        h('button', { class: 'card-open', onclick: () => this.app.openNotebook(nb.id), 'aria-label': `${nb.title} 열기` }, cover),
        h('div', { class: 'card-info' },
          h('div', { class: 'card-text' }, h('div', { class: 'card-title' }, nb.title), h('div', { class: 'card-date' }, formatDate(nb.updatedAt))),
          h('button', { class: 'mini-btn', 'aria-label': '노트 메뉴', html: icons.more, onclick: (e) => this.cardMenu(e.currentTarget, nb) }))));
    }
    if (!this.notebooks.length) {
      g.append(h('div', { class: 'empty' },
        h('p', {}, '아직 노트가 없습니다.'),
        h('p', { class: 'muted' }, '“새 노트”를 눌러 시작하거나, PDF를 가져와서 필기해 보세요.')));
    }
  }

  importMenu(anchor) {
    menu(anchor, [
      { label: 'PDF 가져오기', icon: icons.pdf, action: () => this.importPdf() },
      { label: '백업 파일(.gnote) 가져오기', icon: icons.upload, action: () => this.importBackupFile() },
    ]);
  }

  cardMenu(anchor, nb) {
    menu(anchor, [
      { label: '이름 바꾸기', icon: icons.edit, action: () => this.rename(nb) },
      { label: '표지 색 바꾸기', icon: icons.palette, action: () => this.recolor(nb) },
      { label: '복제', icon: icons.duplicate, action: () => this.duplicate(nb) },
      '-',
      { label: 'PDF로 내보내기', icon: icons.pdf, action: () => this.exportPdf(nb) },
      { label: '백업 파일로 내보내기', icon: icons.download, action: () => this.exportBackup(nb) },
      '-',
      { label: '삭제', icon: icons.trash, danger: true, action: () => this.remove(nb) },
    ]);
  }

  async createDialog() {
    let cover = COVER_COLORS[Math.floor(Math.random() * COVER_COLORS.length)];
    let template = 'lined', paper = 'white', size = 'a4-portrait';
    const title = h('input', { class: 'input', type: 'text', placeholder: '제목 없음', value: '' });
    const covers = h('div', { class: 'choice-row' });
    const tplGrid = h('div', { class: 'choice-grid' });
    const paperRow = h('div', { class: 'choice-row' });
    const sizeSel = h('select', { class: 'input' }, Object.entries(PAGE_SIZES).map(([id, s]) => h('option', { value: id }, s.label)));
    sizeSel.addEventListener('change', () => { size = sizeSel.value; draw(); });
    const draw = () => {
      covers.innerHTML = '';
      for (const c of COVER_COLORS) {
        covers.append(h('button', { class: `cover-chip ${c === cover ? 'active' : ''}`, style: { background: c }, 'aria-label': '표지 색', onclick: () => { cover = c; draw(); } }));
      }
      tplGrid.innerHTML = '';
      for (const [id, label] of Object.entries(TEMPLATES)) {
        tplGrid.append(h('button', { class: `choice ${template === id ? 'active' : ''}`, onclick: () => { template = id; draw(); } },
          templatePreview(id, paper, size), h('span', {}, label)));
      }
      paperRow.innerHTML = '';
      for (const [id, pc] of Object.entries(PAPER_COLORS)) {
        paperRow.append(h('button', { class: `paper-chip ${paper === id ? 'active' : ''}`, onclick: () => { paper = id; draw(); } },
          h('span', { class: 'paper-dot', style: { background: pc.fill } }), pc.label));
      }
    };
    draw();
    const ok = await dialog({
      title: '새 노트',
      body: h('div', { class: 'form' },
        h('label', { class: 'field-label' }, '제목'), title,
        h('label', { class: 'field-label' }, '표지'), covers,
        h('label', { class: 'field-label' }, '종이 서식'), tplGrid,
        h('div', { class: 'two-col' },
          h('div', {}, h('label', { class: 'field-label' }, '종이 크기'), sizeSel),
          h('div', {}, h('label', { class: 'field-label' }, '종이 색'), paperRow))),
      buttons: [{ label: '취소', value: false }, { label: '만들기', value: true, primary: true }],
    });
    if (!ok) return;
    const nb = newNotebook({ title: title.value.trim() || '제목 없음', cover, size, template, paper });
    const page = newPage(nb.id, { size, template, paper });
    nb.pageIds = [page.id];
    await db.putNotebookWithPages(nb, [page]);
    this.app.openNotebook(nb.id);
  }

  async importPdf() {
    const file = await pickFile('application/pdf,.pdf');
    if (!file) return;
    const nb = newNotebook({ title: file.name.replace(/\.pdf$/i, ''), template: 'blank' });
    try {
      progress('PDF 여는 중…');
      const pages = await pdfToPages(file, nb.id, (i, n) => progress(`PDF 가져오는 중… ${i} / ${n}`));
      nb.pageIds = pages.map((p) => p.id);
      if (pages[0]) { nb.size = 'a4-portrait'; }
      await db.putNotebookWithPages(nb, pages);
      progress(null);
      this.app.openNotebook(nb.id);
    } catch (e) {
      console.error(e);
      progress(null);
      toast('PDF를 열 수 없습니다. 암호가 걸렸거나 손상된 파일일 수 있습니다.', 4000);
    }
  }

  async importBackupFile() {
    const file = await pickFile('.gnote,application/json,.json');
    if (!file) return;
    try {
      progress('백업 파일 불러오는 중…');
      const { nb, pages } = await importBackup(file);
      await db.putNotebookWithPages(nb, pages);
      progress(null);
      toast(`“${nb.title}” 노트를 가져왔습니다`);
      await this.load();
    } catch (e) {
      console.error(e);
      progress(null);
      toast(e.message || '백업 파일을 읽을 수 없습니다', 4000);
    }
  }

  async loadFull(nb) {
    const pages = await db.getPages(nb.id);
    const byId = new Map(pages.map((p) => [p.id, p]));
    return nb.pageIds.map((id) => byId.get(id)).filter(Boolean);
  }

  async rename(nb) {
    const name = await promptDialog('노트 이름', nb.title);
    if (!name) return;
    nb.title = name;
    await db.putNotebook(nb);
    this.renderGrid();
  }

  async recolor(nb) {
    const row = h('div', { class: 'choice-row' });
    let chosen = nb.cover;
    const draw = () => {
      row.innerHTML = '';
      for (const c of COVER_COLORS) row.append(h('button', { class: `cover-chip ${c === chosen ? 'active' : ''}`, style: { background: c }, onclick: () => { chosen = c; draw(); } }));
    };
    draw();
    const ok = await dialog({ title: '표지 색', body: row, buttons: [{ label: '취소', value: false }, { label: '적용', value: true, primary: true }] });
    if (!ok) return;
    nb.cover = chosen;
    await db.putNotebook(nb);
    this.renderGrid();
  }

  async duplicate(nb) {
    const pages = await this.loadFull(nb);
    const copy = { ...nb, id: uid(), title: nb.title + ' 사본', createdAt: Date.now(), updatedAt: Date.now() };
    const newPages = pages.map((p) => ({ ...p, id: uid(), notebookId: copy.id }));
    copy.pageIds = newPages.map((p) => p.id);
    await db.putNotebookWithPages(copy, newPages);
    await this.load();
    toast('노트를 복제했습니다');
  }

  async exportPdf(nb) {
    try {
      progress('PDF 만드는 중…');
      const pages = await this.loadFull(nb);
      const blob = await exportPdf(pages, (i, n) => progress(`PDF 만드는 중… ${i} / ${n}`));
      progress(null);
      await saveFile(blob, safeFileName(nb.title) + '.pdf');
    } catch (e) {
      console.error(e);
      progress(null);
      toast('PDF를 만들지 못했습니다');
    }
  }

  async exportBackup(nb) {
    try {
      progress('백업 파일 만드는 중…');
      const blob = await exportBackup(nb, await this.loadFull(nb));
      progress(null);
      await saveFile(blob, safeFileName(nb.title) + '.gnote');
    } catch (e) {
      console.error(e);
      progress(null);
      toast('백업 파일을 만들지 못했습니다');
    }
  }

  async remove(nb) {
    const ok = await confirmDialog('노트 삭제', `“${nb.title}” 노트를 지울까요? 되돌릴 수 없습니다.`);
    if (!ok) return;
    await db.deleteNotebook(nb.id);
    await this.load();
  }
}
