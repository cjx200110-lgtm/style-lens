// 隐藏的后台页面：排队截取关键帧。不依赖用户打开的任何标签页，切走、关掉审美库都会继续做。
// 一次只做一条视频；进度和结果用广播消息告诉审美库页面，截图存进本机 IndexedDB。
import { downloadVideo, scanKeyframes, framesSig, shrink } from "./frames.js";

const queue = [];
const state = {}; // id -> { status: "queued"|"running"|"done"|"error", pct, phase, msg, at }
let running = null;

const openDB = () => new Promise((res, rej) => {
  const r = indexedDB.open("style-lens", 1);
  r.onupgradeneeded = () => r.result.createObjectStore("images");
  r.onsuccess = () => res(r.result); r.onerror = () => rej(r.error);
});
async function idbPut(k, v) {
  const db = await openDB();
  await new Promise((res, rej) => { const t = db.transaction("images", "readwrite"); t.objectStore("images").put(v, k); t.oncomplete = res; t.onerror = () => rej(t.error); });
  db.close();
}
const tell = (id) => chrome.runtime.sendMessage({ type: "frames:update", id, state: state[id] }).catch(() => {});
const set = (id, patch) => { state[id] = { ...(state[id] || {}), ...patch, at: Date.now() }; tell(id); };

chrome.runtime.onMessage.addListener((msg, _sender, send) => {
  if (!msg || msg.target !== "offscreen") return false;
  if (msg.type === "frames:add") {
    for (const job of msg.jobs || []) {
      const st = state[job.id];
      if (st && (st.status === "queued" || st.status === "running")) continue; // 已经在做
      if (st && st.status === "done" && !msg.force) continue;
      const i = queue.findIndex((j) => j.id === job.id); if (i >= 0) queue.splice(i, 1);
      queue.push(job); set(job.id, { status: "queued", pct: 0, phase: "", msg: "" });
    }
    pump();
    send({ ok: true });
  } else if (msg.type === "frames:status") send({ ok: true, state: msg.id ? state[msg.id] || null : state });
  else send({ ok: false });
  return false;
});

async function pump() {
  if (running) return;
  const job = queue.shift();
  if (!job) return;
  running = job.id;
  const t0 = Date.now();
  try {
    set(job.id, { status: "running", pct: 0, phase: "download", msg: "正在下载原视频" });
    const video = await downloadVideo(job.url);
    if (job.styleOnly) {
      // 只收藏风格：把视频均匀分成 12 段，每段取一张，用来校对风格总结
      const dur = job.dur > 0 ? job.dur : 12;
      const segs = Array.from({ length: 12 }, (_, i) => ({ start: (dur * i) / 12, end: (dur * (i + 1)) / 12 }));
      const res = await scanKeyframes(video, segs, { snap: false, maxGap: 999, perShot: 2, onProgress: (r) => set(job.id, { status: "running", pct: Math.round(r * 100), phase: "scan", msg: "正在截取画面" }) });
      const frames = [];
      for (const sh of res.shots) { const f = sh.frames[Math.floor(sh.frames.length / 2)] || sh.frames[0]; if (f) frames.push({ t: f.t, blob: await shrink(f.blob) }); for (const g of sh.frames) URL.revokeObjectURL(g.url); }
      await idbPut("styleframes:" + job.id, { frames, at: Date.now() });
      set(job.id, { status: "done", pct: 100, phase: "", msg: "", style: true, secs: Math.round((Date.now() - t0) / 1000) });
      chrome.runtime.sendMessage({ type: "frames:saved", id: job.id, style: true }).catch(() => {});
      return;
    }
    let lastPct = -1;
    const res = await scanKeyframes(video, job.shots, { snap: true, onProgress: (r, phase) => {
      const pct = Math.round(r * 100);
      if (pct !== lastPct) { lastPct = pct; set(job.id, { status: "running", pct, phase, msg: phase === "scan" ? "正在扫描画面、校准切点" : "正在截取关键帧" }); }
    } });
    let shots = job.shots;
    if (res.snapped && res.moved) {
      // 校准后的切点写回这条收藏（后台统一写，避免和其他任务互相覆盖）
      const r = await chrome.runtime.sendMessage({ type: "frames:snapped", id: job.id, shots: res.snapped, base: framesSig(job.shots) });
      if (r && r.ok) shots = r.shots || res.snapped;
      else throw new Error(r && r.reason === "changed" ? "镜头在截图期间被重新拆解了，稍后会按新镜头重截" : "保存校准结果失败");
    }
    set(job.id, { status: "running", pct: 100, phase: "save", msg: "正在保存" });
    const saved = [];
    for (const sh of res.shots) saved.push({ frames: await Promise.all(sh.frames.map(async (f) => ({ t: f.t, kind: f.kind, blob: await shrink(f.blob) }))) });
    for (const sh of res.shots) for (const f of sh.frames) URL.revokeObjectURL(f.url);
    await idbPut("frames:" + job.id, { sig: framesSig(shots), width: res.width, height: res.height, shots: saved, at: Date.now(), moved: res.moved, timing: res.timing });
    set(job.id, { status: "done", pct: 100, phase: "", msg: "", moved: res.moved, secs: Math.round((Date.now() - t0) / 1000) });
    chrome.runtime.sendMessage({ type: "frames:saved", id: job.id }).catch(() => {}); // 让后台用截图校对描述
  } catch (e) {
    console.warn("后台截图失败", job.id, e);
    set(job.id, { status: "error", msg: String((e && e.message) || e) });
  } finally {
    running = null;
    if (queue.length) pump();
    else chrome.runtime.sendMessage({ type: "frames:idle" }).catch(() => {});
  }
}
