// ---------- 完整备份 / 恢复 ----------
// 备份 = 一个 zip：data.json（收藏、分镜方案、风格卡、分组、设置）+ files/（分镜画面、视频、关键帧、主体图）。
// API Key 不进备份：备份文件可能被转发或上传，Key 留在本机更安全，恢复后在设置页重新填一次即可。
import { makeZip, saveBlob } from "./frames.js";

const DB = "style-lens", STORE = "images";
const SECRET = /(api)?key$/i;
const openDB = () => new Promise((res, rej) => {
  const r = indexedDB.open(DB, 1);
  r.onupgradeneeded = () => r.result.createObjectStore(STORE);
  r.onsuccess = () => res(r.result); r.onerror = () => rej(r.error);
});
async function idbAll() {
  const db = await openDB();
  return new Promise((res, rej) => {
    const out = [], t = db.transaction(STORE, "readonly");
    const cur = t.objectStore(STORE).openCursor();
    cur.onsuccess = () => { const c = cur.result; if (c) { out.push([c.key, c.value]); c.continue(); } };
    t.oncomplete = () => res(out); t.onerror = () => rej(t.error);
  });
}
async function idbHas(db, k) {
  return new Promise((res) => { const r = db.transaction(STORE, "readonly").objectStore(STORE).getKey(k); r.onsuccess = () => res(r.result !== undefined); r.onerror = () => res(false); });
}
async function idbPut(db, k, v) {
  return new Promise((res, rej) => { const t = db.transaction(STORE, "readwrite"); t.objectStore(STORE).put(v, k); t.oncomplete = res; t.onerror = () => rej(t.error); });
}

const EXT = { "image/png": "png", "image/jpeg": "jpg", "image/webp": "webp", "video/mp4": "mp4" };
// 把值里的 Blob 换成 {"$blob": 文件名}，文件另存
function pack(v, files) {
  if (v instanceof Blob) {
    const name = `files/${files.length + 1}.${EXT[v.type] || "bin"}`;
    files.push({ name, data: v, type: v.type });
    return { $blob: name, type: v.type };
  }
  if (Array.isArray(v)) return v.map((x) => pack(x, files));
  if (v && typeof v === "object") { const o = {}; for (const [k, x] of Object.entries(v)) if (k !== "url" || typeof x !== "string" || !x.startsWith("blob:")) o[k] = pack(x, files); return o; }
  return v;
}
function unpack(v, get) {
  if (Array.isArray(v)) return v.map((x) => unpack(x, get));
  if (v && typeof v === "object") {
    if (typeof v.$blob === "string") return get(v.$blob, v.type);
    const o = {}; for (const [k, x] of Object.entries(v)) o[k] = unpack(x, get); return o;
  }
  return v;
}

export async function exportBackup(onStatus = () => {}) {
  onStatus("正在整理收藏和设置…");
  const all = await chrome.storage.local.get(null);
  const store = Object.fromEntries(Object.entries(all).filter(([k]) => !SECRET.test(k)));
  onStatus("正在读取画面、视频和关键帧…");
  const files = [];
  const idb = (await idbAll()).map(([k, v]) => [k, pack(v, files)]);
  const data = { app: "style-lens", version: chrome.runtime.getManifest().version, at: Date.now(), store, idb };
  onStatus(`正在打包（${files.length} 个文件）…`);
  const zip = await makeZip([{ name: "data.json", data: JSON.stringify(data) }, ...files]);
  const d = new Date(), pad = (n) => String(n).padStart(2, "0");
  saveBlob(zip, `风格拆解备份-${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}.zip`);
  await chrome.storage.local.set({ lastBackupAt: Date.now() });
  return { items: (store.items || []).length, plans: (store.plans || []).length, files: files.length, bytes: zip.size };
}

// 读插件自己导出的 zip（不压缩），按本地文件头顺序读
async function readZip(file) {
  const buf = new Uint8Array(await file.arrayBuffer());
  const dv = new DataView(buf.buffer), dec = new TextDecoder();
  const out = new Map();
  let p = 0;
  while (p + 30 <= buf.length && dv.getUint32(p, true) === 0x04034b50) {
    if (dv.getUint16(p + 8, true) !== 0) throw new Error("这个压缩包被别的软件重新压缩过，请直接用插件导出的原文件");
    const size = dv.getUint32(p + 18, true), nlen = dv.getUint16(p + 26, true), xlen = dv.getUint16(p + 28, true);
    const name = dec.decode(buf.subarray(p + 30, p + 30 + nlen));
    const start = p + 30 + nlen + xlen;
    out.set(name, buf.subarray(start, start + size));
    p = start + size;
  }
  return out;
}

// 合并恢复：备份里有、现在没有的加回来；两边都有的（同一条收藏/方案）保留现在的版本。不会删除任何现有数据
const byId = (cur = [], add = []) => { const ids = new Set(cur.map((x) => x.id)); const extra = add.filter((x) => x && !ids.has(x.id)); return { list: [...cur, ...extra], n: extra.length }; };
export async function importBackup(file, onStatus = () => {}) {
  onStatus("正在读取备份文件…");
  let data, entries = null;
  if (/\.json$/i.test(file.name)) {
    // 旧版“导出数据”的 JSON：只有收藏列表
    const j = JSON.parse(await file.text());
    data = { store: { items: j.items || [], picks: j.picks || {}, lastReport: j.lastReport }, idb: [] };
  } else {
    entries = await readZip(file);
    if (!entries.has("data.json")) throw new Error("这不是风格拆解的备份文件");
    data = JSON.parse(new TextDecoder().decode(entries.get("data.json")));
    if (data.app !== "style-lens") throw new Error("这不是风格拆解的备份文件");
  }
  const s = data.store || {};
  const cur = await chrome.storage.local.get(null);
  const patch = {}, report = {};
  for (const k of ["items", "plans", "styleCards"]) {
    if (!Array.isArray(s[k])) continue;
    const { list, n } = byId(cur[k], s[k]); report[k] = n;
    if (n) patch[k] = k === "items" ? list.sort((a, b) => (b.createdAt || 0) - (a.createdAt || 0)) : list;
  }
  for (const k of ["picks", "seen"]) if (s[k] && typeof s[k] === "object") patch[k] = { ...s[k], ...(cur[k] || {}) };
  // 其余（分组结果、审美报告、各项设置）：现在没有才用备份里的
  for (const [k, v] of Object.entries(s)) if (!(k in patch) && !["items", "plans", "styleCards", "picks", "seen"].includes(k) && cur[k] === undefined && !SECRET.test(k)) patch[k] = v;
  onStatus("正在恢复画面、视频和关键帧…");
  let restored = 0;
  if (entries && Array.isArray(data.idb) && data.idb.length) {
    const db = await openDB();
    const get = (name, type) => { const b = entries.get(name); return b ? new Blob([b], { type: type || "" }) : null; };
    for (const [k, v] of data.idb) {
      if (await idbHas(db, k)) continue; // 现在已有的不覆盖
      await idbPut(db, k, unpack(v, get)); restored++;
    }
  }
  await chrome.storage.local.set(patch);
  return { items: report.items || 0, plans: report.plans || 0, cards: report.styleCards || 0, files: restored, needKey: !Object.keys(cur).some((k) => SECRET.test(k) && cur[k]) };
}
