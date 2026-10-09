// 노트 백업 파일(.gnote) 만들기와 불러오기. 다른 기기로 노트를 옮길 때 쓴다.
import { uid } from './model.js';
import { blobToDataURL, dataURLToBlob } from './util.js';

const FORMAT = 'goodnotes-web';

async function encodeItem(it) {
  if (it.type === 'stroke') {
    return { ...it, pts: Array.from(it.pts, (v) => Math.round(v * 100) / 100) };
  }
  if (it.type === 'image') {
    return { ...it, blob: it.blob ? await blobToDataURL(it.blob) : null };
  }
  if (it.type === 'video') {
    return { ...it, blob: it.blob ? await blobToDataURL(it.blob) : null, poster: it.poster ? await blobToDataURL(it.poster) : null };
  }
  return { ...it };
}

async function decodeItem(it) {
  if (it.type === 'stroke') return { ...it, id: uid(), pts: new Float32Array(it.pts) };
  if (it.type === 'image') return { ...it, id: uid(), blob: it.blob ? await dataURLToBlob(it.blob) : null };
  if (it.type === 'video') {
    return { ...it, id: uid(), blob: it.blob ? await dataURLToBlob(it.blob) : null, poster: it.poster ? await dataURLToBlob(it.poster) : null };
  }
  return { ...it, id: uid() };
}

export async function exportBackup(nb, pages) {
  const outPages = [];
  for (const p of pages) {
    outPages.push({
      ...p,
      bg: p.bg ? await blobToDataURL(p.bg) : null,
      items: await Promise.all(p.items.map(encodeItem)),
    });
  }
  const data = { format: FORMAT, version: 1, exportedAt: Date.now(), notebook: { ...nb, thumb: nb.thumb }, pages: outPages };
  return new Blob([JSON.stringify(data)], { type: 'application/json' });
}

// keepIds: 클라우드 동기화처럼 같은 노트를 덮어쓸 때는 원래 ID를 그대로 쓴다
export async function importBackup(file, { keepIds = false } = {}) {
  const data = JSON.parse(typeof file === 'string' ? file : await file.text());
  if (data.format !== FORMAT || !data.notebook || !Array.isArray(data.pages)) {
    throw new Error('노트 백업 파일이 아닙니다.');
  }
  const nbId = keepIds ? data.notebook.id : uid();
  const idMap = new Map();
  const pages = [];
  for (const p of data.pages) {
    const id = keepIds ? p.id : uid();
    idMap.set(p.id, id);
    pages.push({
      ...p,
      id,
      notebookId: nbId,
      bg: p.bg ? await dataURLToBlob(p.bg) : null,
      items: await Promise.all((p.items || []).map(decodeItem)),
    });
  }
  const order = (data.notebook.pageIds || []).map((old) => idMap.get(old)).filter(Boolean);
  const nb = {
    ...data.notebook,
    id: nbId,
    pageIds: order.length === pages.length ? order : pages.map((p) => p.id),
    updatedAt: Date.now(),
  };
  if (!keepIds) {
    // 파일로 가져온 노트는 새 노트로 다룬다
    delete nb.syncedAt;
    delete nb.remoteId;
    delete nb.cloud;
  }
  return { nb, pages };
}
