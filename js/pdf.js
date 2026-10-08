// PDF 가져오기(pdf.js 사용)와 PDF 내보내기(직접 만든 간단한 PDF 작성기)
import { newPage } from './model.js';
import { renderPageCanvas, ensurePageImages } from './render.js';

let pdfjs = null;
async function loadPdfJs() {
  if (!pdfjs) {
    pdfjs = await import('../vendor/pdfjs/pdf.min.mjs');
    pdfjs.GlobalWorkerOptions.workerSrc = new URL('../vendor/pdfjs/pdf.worker.min.mjs', import.meta.url).href;
  }
  return pdfjs;
}

function canvasToBlob(canvas, type, quality) {
  return new Promise((resolve, reject) => {
    canvas.toBlob((b) => (b ? resolve(b) : reject(new Error('이미지 변환 실패'))), type, quality);
  });
}

// PDF 파일의 각 쪽을 배경 이미지로 가진 페이지들을 만든다
export async function pdfToPages(file, notebookId, onProgress = () => {}) {
  const lib = await loadPdfJs();
  const data = new Uint8Array(await file.arrayBuffer());
  const doc = await lib.getDocument({
    data,
    cMapUrl: new URL('../vendor/pdfjs/cmaps/', import.meta.url).href,
    cMapPacked: true,
    standardFontDataUrl: new URL('../vendor/pdfjs/standard_fonts/', import.meta.url).href,
    isEvalSupported: false,
  }).promise;
  const pages = [];
  const canvas = document.createElement('canvas');
  try {
    for (let i = 1; i <= doc.numPages; i++) {
      onProgress(i, doc.numPages);
      const pg = await doc.getPage(i);
      const base = pg.getViewport({ scale: 96 / 72 });
      // 확대해도 선명하도록 2배 정도로 그리되, 너무 큰 이미지는 막는다
      const k = Math.min(2.2, 2600 / Math.max(base.width, base.height));
      const vp = pg.getViewport({ scale: (96 / 72) * k });
      canvas.width = Math.ceil(vp.width);
      canvas.height = Math.ceil(vp.height);
      const ctx = canvas.getContext('2d');
      ctx.fillStyle = '#fff';
      ctx.fillRect(0, 0, canvas.width, canvas.height);
      await pg.render({ canvasContext: ctx, viewport: vp }).promise;
      const blob = await canvasToBlob(canvas, 'image/jpeg', 0.88);
      const page = newPage(notebookId, { template: 'blank', w: Math.round(base.width), h: Math.round(base.height) });
      page.bg = blob;
      pages.push(page);
      pg.cleanup();
    }
  } finally {
    canvas.width = canvas.height = 0;
    doc.destroy();
  }
  return pages;
}

/* ---------- PDF 내보내기 ---------- */
const enc = new TextEncoder();

export async function exportPdf(pages, onProgress = () => {}, { maxScale = 2.5, quality = 0.9 } = {}) {
  const chunks = [];
  let offset = 0;
  const offsets = [];
  const push = (data) => {
    const bytes = typeof data === 'string' ? enc.encode(data) : data;
    chunks.push(bytes);
    offset += bytes.length;
  };
  const startObj = (n) => { offsets[n] = offset; push(`${n} 0 obj\n`); };

  push('%PDF-1.4\n%\xE2\xE3\xCF\xD3\n');
  const n = pages.length;
  // 객체 번호: 1 카탈로그, 2 페이지 묶음, 그다음 쪽마다 (쪽, 내용, 그림) 3개
  const kids = pages.map((_, i) => `${3 + i * 3} 0 R`).join(' ');
  startObj(1); push('<< /Type /Catalog /Pages 2 0 R >>\nendobj\n');
  startObj(2); push(`<< /Type /Pages /Kids [${kids}] /Count ${n} >>\nendobj\n`);

  const canvas = document.createElement('canvas');
  for (let i = 0; i < n; i++) {
    onProgress?.(i + 1, n);
    const page = pages[i];
    await ensurePageImages(page);
    const scale = Math.min(maxScale, 3000 / Math.max(page.w, page.h));
    renderPageCanvas(page, scale, canvas);
    const jpeg = new Uint8Array(await (await canvasToBlob(canvas, 'image/jpeg', quality)).arrayBuffer());
    const W = (page.w * 0.75).toFixed(2), H = (page.h * 0.75).toFixed(2);
    const pageObj = 3 + i * 3, contObj = pageObj + 1, imgObj = pageObj + 2;
    startObj(pageObj);
    push(`<< /Type /Page /Parent 2 0 R /MediaBox [0 0 ${W} ${H}] /Resources << /XObject << /Im0 ${imgObj} 0 R >> >> /Contents ${contObj} 0 R >>\nendobj\n`);
    const content = `q ${W} 0 0 ${H} 0 0 cm /Im0 Do Q`;
    startObj(contObj);
    push(`<< /Length ${content.length} >>\nstream\n${content}\nendstream\nendobj\n`);
    startObj(imgObj);
    push(`<< /Type /XObject /Subtype /Image /Width ${canvas.width} /Height ${canvas.height} /ColorSpace /DeviceRGB /BitsPerComponent 8 /Filter /DCTDecode /Length ${jpeg.length} >>\nstream\n`);
    push(jpeg);
    push('\nendstream\nendobj\n');
  }
  canvas.width = canvas.height = 0;

  const total = 3 + n * 3;
  const xref = offset;
  let x = `xref\n0 ${total}\n0000000000 65535 f \n`;
  for (let k = 1; k < total; k++) x += String(offsets[k]).padStart(10, '0') + ' 00000 n \n';
  push(x);
  push(`trailer\n<< /Size ${total} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`);
  return new Blob(chunks, { type: 'application/pdf' });
}
