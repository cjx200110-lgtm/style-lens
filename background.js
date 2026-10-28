import { formatTaskError } from "./errors.js";
import { analysisIssues, validationError, normalizeAnalysis, buildReplicaPrompt } from "./analysis-validation.js";
import { framesSig } from "./frames.js";
import { analyzeVideo, getProvider, getGeminiEndpoint, hasProviderKey, parseJSON, getLastTiming, usageCost, proofread } from "./ai.js";
import { buildCandidateTags } from "./vocab.js";

// ---------- 存储 ----------
async function getItems() {
  const { items = [] } = await chrome.storage.local.get("items");
  return items;
}
async function saveItems(items) { await chrome.storage.local.set({ items }); }
// 后台读改写串行化，防止连续入队覆盖正在完成的任务。
let storageWrites = Promise.resolve();
function mutateItems(fn) {
  const op = storageWrites.then(async () => {
    const items = await getItems();
    const result = await fn(items);
    await saveItems(items);
    return result;
  });
  storageWrites = op.catch(() => {});
  return op;
}
async function updateItem(id, patch) {
  return mutateItems((items) => {
    const i = items.findIndex((x) => x.id === id);
    if (i >= 0) { items[i] = { ...items[i], ...patch }; return items[i]; }
    return null;
  });
}

export function parseTweetUrl(url) {
  const m = /^https:\/\/(?:www\.|mobile\.)?(?:x|twitter)\.com\/([^/?#]+)\/status\/(\d+)/.exec(url || "");
  return m ? { handle: m[1], tweetId: m[2] } : null;
}

// ---------- 在页面里读取帖子正文和作者回复（在 X 页面中执行） ----------
function readPostContext(tweetId, handle) {
  const out = { mainText: "", authorReplies: [], videoSrc: "" };
  try {
    const arts = Array.from(document.querySelectorAll('article[data-testid="tweet"], article'));
    const hOf = (a) => {
      const link = a.querySelector('[data-testid="User-Name"] a[href^="/"]');
      return link ? link.getAttribute("href").replace(/^\//, "").split("/")[0].toLowerCase() : "";
    };
    const tOf = (a) => { const t = a.querySelector('[data-testid="tweetText"]'); return t ? t.innerText.trim() : ""; };
    let mainIdx = arts.findIndex((a) => a.querySelector(`a[href*="/status/${tweetId}"] time`));
    // 找不到目标帖时不猜第一条，避免把推荐帖误当原帖。
    if (mainIdx < 0) return out;
    const main = arts[mainIdx];
    if (main) {
      out.mainText = tOf(main);
      const v = main.querySelector("video");
      if (v && /^https?:/.test(v.currentSrc || v.src || "")) out.videoSrc = v.currentSrc || v.src;
    }
    const h = (handle || "").toLowerCase();
    for (let i = mainIdx + 1; i < arts.length && out.authorReplies.length < 5; i++) {
      if (hOf(arts[i]) === h) { const t = tOf(arts[i]); if (t) out.authorReplies.push(t.slice(0, 1500)); }
    }
  } catch (e) { out.error = String(e); }
  return out;
}

// ---------- 通过 X 的公开嵌入数据找视频地址 ----------
function syndicationToken(id) {
  return ((Number(id) / 1e15) * Math.PI).toString(36).replace(/(0+|\.)/g, "");
}

async function resolveVideo(tweetId, ctx) {
  let syn = null;
  try {
    const r = await fetch(`https://cdn.syndication.twimg.com/tweet-result?id=${tweetId}&lang=zh&token=${syndicationToken(tweetId)}`);
    if (r.ok) syn = await r.json();
  } catch (_) {}
  const medias = [];
  if (syn) {
    medias.push(...(syn.mediaDetails || []));
    if (syn.quoted_tweet) medias.push(...(syn.quoted_tweet.mediaDetails || []));
  }
  const vid = medias.find((m) => m.video_info && m.video_info.variants);
  let url = "", hd = "";
  if (vid) {
    const mp4 = vid.video_info.variants.filter((v) => v.content_type === "video/mp4" && v.url);
    mp4.sort((a, b) => (a.bitrate || 0) - (b.bitrate || 0));
    // v0.4：选约 0.6–1Mbps 的清晰度。模型每秒只抽 1 帧并会压缩画面，更高码率看不出区别，
    // 却让上传到中转站变慢、超过内联上限后还要走 Files API（中转常不支持）。
    url = (mp4.find((v) => (v.bitrate || 0) >= 600000) || mp4[mp4.length - 1] || {}).url || "";
    // 另存一个清晰版给收藏页播放
    hd = (mp4.find((v) => (v.bitrate || 0) >= 1500000) || mp4[mp4.length - 1] || {}).url || url;
  }
  if (!url && ctx && ctx.videoSrc) url = ctx.videoSrc;
  if (!url) throw new Error("没找到这条帖子里的视频（可能是敏感内容、已删除，或 X 改了页面结构）");
  return {
    url,
    durationSec: vid && vid.video_info && vid.video_info.duration_millis ? vid.video_info.duration_millis / 1000 : 0,
    playUrl: hd || url,
    smallUrl: (vid && vid.video_info.variants.filter((v) => v.content_type === "video/mp4" && v.url).sort((a, b) => (a.bitrate || 0) - (b.bitrate || 0))[0] || {}).url || url,
    bestUrl: (vid && vid.video_info.variants.filter((v) => v.content_type === "video/mp4" && v.url).sort((a, b) => (b.bitrate || 0) - (a.bitrate || 0))[0] || {}).url || hd || url,
    thumb: (vid && vid.media_url_https) || "",
    syndicationText: syn && syn.text ? syn.text : "",
    author: syn && syn.user ? syn.user.screen_name : ""
  };
}

async function downloadVideo(v) {
  const parsed = new URL(v.url);
  // 先在用户浏览器下载完整视频，再交给所选供应商，禁止把任意页面地址当成视频。
  if (parsed.protocol !== "https:" || parsed.hostname !== "video.twimg.com" || parsed.username || parsed.password
      || !/\.mp4$/i.test(parsed.pathname)) throw new Error("没找到可读取的 X MP4 视频地址");
  let buf;
  try {
    const res = await fetch(v.url);
    if (!res.ok) throw new Error("视频下载失败（HTTP " + res.status + "），请稍后重试");
    // 收到响应头后，读取文件仍可能断线，必须与 fetch 一起捕获。
    buf = await res.arrayBuffer();
  } catch (err) {
    const e = new Error(formatTaskError(err, { stage: "download" }));
    e.stage = "download";
    throw e;
  }
  // 拒绝空文件及伪装成视频的 HTML 错误页，避免无视频也调用分析。
  const head = new Uint8Array(buf, 0, Math.min(buf.byteLength, 12));
  if (head.length < 12 || String.fromCharCode(...head.subarray(4, 8)) !== "ftyp") throw new Error("下载内容不是有效的 MP4 视频");
  return buf;
}

// 从 MP4 文件头读出总时长（X 没给时长时用）
function mp4Duration(buf) {
  try {
    const b = new Uint8Array(buf), dv = new DataView(buf);
    for (let i = 0; i < b.length - 32; i++) { // moov 可能在文件末尾，要扫完整个文件
      if (b[i] === 0x6d && b[i + 1] === 0x76 && b[i + 2] === 0x68 && b[i + 3] === 0x64) { // "mvhd"
        const v = b[i + 4];
        const ts = v === 1 ? dv.getUint32(i + 24) : dv.getUint32(i + 16);
        const du = v === 1 ? Number(dv.getBigUint64(i + 28)) : dv.getUint32(i + 20);
        return ts ? du / ts : 0;
      }
    }
  } catch (_) {}
  return 0;
}

// ---------- 队列 ----------
let running = false;
let keepAlive = null;

async function processQueue() {
  if (running) return;
  running = true;
  keepAlive = keepAlive || setInterval(() => chrome.runtime.getPlatformInfo(() => {}), 20000);
  try {
    for (;;) {
      const next = (await getItems()).filter((x) => x.status === "queued").sort((a, b) => a.createdAt - b.createdAt)[0];
      if (!next) break;
      await processItem(next);
    }
  } finally {
    if (!shotJobs.size) { clearInterval(keepAlive); keepAlive = null; }
    running = false;
  }
}

async function processItem(item) {
  // 区分旧失败记录与本次重试，诊断只存版本/步骤/时间，不含 Key 或上传凭证。
  const attemptVersion = chrome.runtime.getManifest?.().version || "未记录";
  await updateItem(item.id, { status: "processing", error: "", errorStage: "", attemptedAt: Date.now(), attemptVersion, failedAt: null });
  try {
    const result = await withRetry(() => analyze(item));
    const candidateTags = buildCandidateTags(result);
    try { await updateItem(item.id, { status: "done", result, candidateTags, doneAt: Date.now(), errorStage: "" }); }
    catch (err) { err.stage = "save"; throw err; }
    notify(item.id, "拆解完成", `@${item.handle} 的视频：${result.title || (result.summary || "").slice(0, 60)}`);
    // 截图（只收藏风格的也截十几张）→ 截好后用清晰截图校对描述（只在 Gemini/Atlas 方案下）
    if (item.provider === "gemini") framesEnqueue([item.id]).catch((e) => console.warn("后台截图没能开始", e));
  } catch (err) {
    const stage = err.stage || "unknown";
    const error = formatTaskError(err, { stage, provider: item.provider });
    await updateItem(item.id, { status: "failed", error, errorStage: stage, failedAt: Date.now() });
    notify(item.id, "拆解失败", `@${item.handle}：${error.slice(0, 80)}`);
  }
  await refreshBadge();
}

async function withRetry(fn) {
  const t0 = Date.now();
  try { return await fn(); } catch (err) {
    if (err.noRetry || (err.status && err.status < 500 && err.status !== 429)) throw err;
    // 已经等了超过 1 分钟才失败（多半是中转站上游超时），不再自动重试白等一轮
    if (Date.now() - t0 > 60000) throw err;
    await new Promise((r) => setTimeout(r, 4000));
    return fn();
  }
}

async function analyze(item) {
  let stage = "resolve";
  try {
  const v = await resolveVideo(item.tweetId, item.ctx);
  const ctx = { ...(item.ctx || {}), syndicationText: v.syndicationText };
  stage = "download";
  const buf = await downloadVideo(v);
  // 已下载字节由供应商适配层分别上传，千问请求里不再携带 X CDN 地址。
  stage = "analysis";
  // 旧 Gemini 任务默认官方，来源切换不会把既有队列误发到米醋。
  const tStart = Date.now();
  const durationSec = v.durationSec || mp4Duration(buf);
  // 千问只支持一次完整拆解；Gemini 支持“只收藏风格”
  const mode = item.mode === "style" && item.provider === "gemini" ? "style" : "full";
  const usage = {};
  const text = await analyzeVideo(buf, { ...ctx, videoUrl: v.url, smallUrl: v.smallUrl, durationSec, mode, usage }, item.provider, item.geminiEndpoint || "google");
  const timing = { total: Math.round((Date.now() - tStart) / 1000), ...(item.provider === "gemini" ? { firstByte: (getLastTiming() || {}).firstByte } : {}) };
  stage = "validation";
  const result = normalizeAnalysis(parseJSON(text));
  // 防止模型“没看到视频却照样回答”
  const blind = /没有(收到|附带|看到).{0,4}视频|无法(查看|看到|观看).{0,6}(视频|画面)/.test(text);
  if (!result || result.video_visible !== true || blind || (!result.style_only && (!Array.isArray(result.shots) || !result.shots.length))) {
    const e = new Error("模型表示没有看到视频画面，本次结果未保存");
    e.noRetry = true;
    throw e;
  }
  // 与千问结构修正共用同一校验，保持严格条件并报告具体中文缺项。
  const issues = analysisIssues(result);
  if (issues.length) throw validationError(issues);
  result.videoSize = buf.byteLength;
  result.timing = timing;
  const c = usageCost(usage); if (c) result.cost = { analysis: c };
  result.thumb = v.thumb;
  if (/^https:\/\/video\.twimg\.com\//.test(v.playUrl || "")) result.videoUrl = v.playUrl;
  return result;
  } catch (err) { if (!err.stage) err.stage = stage; throw err; }
}

// ---------- 后台截关键帧：交给隐藏的后台页面（offscreen）排队做 ----------
let offscreenP = null;
async function ensureOffscreen() {
  if (!chrome.offscreen) throw new Error("浏览器版本太旧，不支持后台截图");
  if (chrome.runtime.getContexts) {
    const ctx = await chrome.runtime.getContexts({ contextTypes: ["OFFSCREEN_DOCUMENT"] });
    if (ctx.length) return;
  }
  offscreenP = offscreenP || chrome.offscreen.createDocument({ url: "offscreen.html", reasons: ["BLOBS"], justification: "在后台截取视频关键帧" })
    .catch((e) => { if (!/single offscreen|already/i.test(String(e && e.message))) throw e; })
    .finally(() => { offscreenP = null; });
  await offscreenP;
}
// ids：要截图的收藏；force：已经截过也重截
async function framesEnqueue(ids, force = false) {
  const items = await getItems();
  const jobs = [];
  for (const id of ids) {
    const x = items.find((y) => y.id === id);
    if (!x || !x.result) continue;
    const styleOnly = !(x.result.shots || []).length;
    if (styleOnly && x.result.proofread && x.result.proofread.style && !force) continue; // 只收藏风格的：截图只用来校对风格，校对过就不再截
    let url = "";
    try { const v = await resolveVideo(x.tweetId, null); url = /^https:\/\/video\.twimg\.com\//.test(v.bestUrl || "") ? v.bestUrl : v.playUrl; } catch (_) {}
    if (!url && /^https:\/\/video\.twimg\.com\//.test(x.result.videoUrl || "")) url = x.result.videoUrl;
    if (!url) continue;
    jobs.push(styleOnly ? { id, url, styleOnly: true, dur: Number(x.result.duration_sec) || 0 } : { id, url, shots: x.result.shots });
  }
  if (!jobs.length) return { ok: false, reason: "没找到视频地址（帖子可能已删除）" };
  await ensureOffscreen();
  return chrome.runtime.sendMessage({ target: "offscreen", type: "frames:add", jobs, force });
}
// ---------- 截图存好后：用清晰截图校对镜头描述和风格总结 ----------
const proofJobs = new Set();
function idbGet(k) {
  return new Promise((res) => {
    const r = indexedDB.open("style-lens", 1);
    r.onupgradeneeded = () => r.result.createObjectStore("images");
    r.onerror = () => res(null);
    r.onsuccess = () => { const db = r.result; const q = db.transaction("images").objectStore("images").get(k); q.onsuccess = () => { res(q.result); db.close(); }; q.onerror = () => { res(null); db.close(); }; };
  });
}
async function proofreadItem(id) {
  if (proofJobs.has(id)) return;
  const item = (await getItems()).find((x) => x.id === id);
  if (!item || !item.result || item.provider === "qwen" || (await getProvider()) !== "gemini") return;
  const r = item.result;
  const hasShots = (r.shots || []).length > 0;
  const sig = hasShots ? framesSig(r.shots) : "style";
  if (r.proofread && r.proofread.sig === sig) return; // 这一版已经校对过
  const saved = await idbGet(hasShots ? "frames:" + id : "styleframes:" + id);
  if (!saved) return;
  if (hasShots && saved.sig !== sig) return; // 截图和现在的镜头对不上（镜头刚被重新拆过），等新截图
  proofJobs.add(id);
  const setRes = (patch) => mutateItems((items) => { const i = items.findIndex((x) => x.id === id); if (i >= 0 && items[i].result) items[i] = { ...items[i], result: { ...items[i].result, ...patch } }; });
  await setRes({ proofStatus: "running" });
  keepAlive = keepAlive || setInterval(() => chrome.runtime.getPlatformInfo(() => {}), 20000);
  try {
    const out = await proofread(r, hasShots ? { shotFrames: saved.shots.map((s) => s.frames) } : { styleFrames: saved.frames });
    await mutateItems((items) => {
      const i = items.findIndex((x) => x.id === id);
      if (i < 0 || !items[i].result) return;
      const cur = items[i].result;
      if (hasShots && framesSig(cur.shots) !== sig) return; // 校对期间镜头变了，放弃
      const next = { ...cur };
      if (out.shots) next.shots = cur.shots.map((s, k) => (out.shots[k] ? { ...s, ...out.shots[k] } : s));
      if (out.style) Object.assign(next, out.style);
      if (out.shots && cur.prompt_zh && cur.prompt_zh === buildReplicaPrompt(cur)) next.prompt_zh = buildReplicaPrompt(next);
      next.proofread = { sig, at: Date.now(), changes: out.changes.slice(0, 40), shots: !!out.shots, style: !!out.style };
      next.proofStatus = "done";
      if (out.cost) next.cost = { ...(cur.cost || {}), proofread: out.cost };
      items[i] = { ...items[i], result: next };
    });
  } catch (e) {
    console.warn("校对失败", e);
    await setRes({ proofStatus: "failed", proofError: String((e && e.message) || e).slice(0, 120) });
  } finally {
    proofJobs.delete(id);
    if (!running && !shotJobs.size && !proofJobs.size && keepAlive) { clearInterval(keepAlive); keepAlive = null; }
  }
}

// 截图时校准过的切点写回收藏；截图期间镜头被重新拆解过就放弃这次结果
async function saveSnapped(id, shots, base) {
  let out = null, reason = "";
  await mutateItems((items) => {
    const i = items.findIndex((x) => x.id === id);
    if (i < 0 || !items[i].result) { reason = "gone"; return; }
    const r = items[i].result;
    if (framesSig(r.shots) !== base) { reason = "changed"; return; }
    const clean = shots.map((s) => ({ ...s, start: Math.round(s.start * 100) / 100, end: Math.round(s.end * 100) / 100 }));
    const autoPrompt = r.prompt_zh && r.prompt_zh === buildReplicaPrompt(r);
    items[i] = { ...items[i], result: { ...r, shots: clean, cutsSnapped: 2, ...(autoPrompt ? { prompt_zh: buildReplicaPrompt({ ...r, shots: clean }) } : {}) } };
    out = clean;
  });
  return out ? { ok: true, shots: out } : { ok: false, reason };
}

// 给只收藏了风格的视频补做逐镜头拆解：风格部分保留不动，只补镜头
const shotJobs = new Set();
async function addShots(id) {
  if (shotJobs.has(id)) return;
  const item = (await getItems()).find((x) => x.id === id);
  if (!item || !item.result) return;
  shotJobs.add(id);
  const setRes = (patch) => mutateItems((items) => { const i = items.findIndex((x) => x.id === id); if (i >= 0) items[i] = { ...items[i], result: { ...items[i].result, ...patch } }; });
  await setRes({ shotsStatus: "running", shotsError: "" });
  keepAlive = keepAlive || setInterval(() => chrome.runtime.getPlatformInfo(() => {}), 20000);
  try {
    const v = await resolveVideo(item.tweetId, item.ctx);
    const buf = await downloadVideo(v);
    const durationSec = v.durationSec || mp4Duration(buf) || item.result.duration_sec;
    const provider = await getProvider();
    const geminiEndpoint = provider === "gemini" ? await getGeminiEndpoint() : undefined;
    if (provider !== "gemini") throw new Error("补做镜头拆解需要使用 Gemini 或 Atlas Cloud 方案");
    const usage = {};
    const text = await analyzeVideo(buf, { ...(item.ctx || {}), syndicationText: v.syndicationText, videoUrl: v.url, smallUrl: v.smallUrl, durationSec, mode: "shots", usage }, provider, geminiEndpoint);
    const got = normalizeAnalysis({ ...item.result, ...parseJSON(text), video_visible: true, style_only: false, prompt_zh: "", duration_sec: item.result.duration_sec || durationSec });
    if (!got.shots.length) throw new Error("模型没有返回镜头");
    const c = usageCost(usage);
    await setRes({ shots: got.shots, prompt_zh: got.prompt_zh, style_only: false, long_video: got.long_video || false, shotsStatus: "done", shotsError: "", proofread: null,
      ...(c ? { cost: { ...(item.result.cost || {}), shots: c } } : {}) });
    notify(id, "镜头拆解完成", `@${item.handle}：${got.shots.length} 个镜头`);
    framesEnqueue([id], true).catch((e) => console.warn("后台截图没能开始", e));
  } catch (e) {
    await setRes({ shotsStatus: "failed", shotsError: formatTaskError(e, { stage: e.stage || "analysis", provider: item.provider }) });
  } finally {
    shotJobs.delete(id);
    if (!running && !shotJobs.size && keepAlive) { clearInterval(keepAlive); keepAlive = null; }
  }
}

// ---------- 通知与角标 ----------
function notify(id, title, message) {
  chrome.notifications.create("item-" + id, { type: "basic", iconUrl: "icons/icon128.png", title, message, priority: 1 });
}
chrome.notifications.onClicked.addListener((nid) => {
  const id = nid.replace(/^item-/, "");
  const url = chrome.runtime.getURL("library.html#item/" + id);
  chrome.tabs.query({ url: chrome.runtime.getURL("library.html") + "*" }).then(([tab]) => tab
    ? chrome.tabs.update(tab.id, { url, active: true }).then(() => chrome.windows.update(tab.windowId, { focused: true }))
    : chrome.tabs.create({ url })).catch(() => chrome.tabs.create({ url }));
  chrome.notifications.clear(nid);
});

async function refreshBadge() {
  const items = await getItems();
  const { seen = {} } = await chrome.storage.local.get("seen");
  const busy = items.filter((x) => x.status === "queued" || x.status === "processing").length;
  const unseen = items.filter((x) => x.status === "done" && !seen[x.id]).length;
  if (busy) { chrome.action.setBadgeText({ text: "…" + busy }); chrome.action.setBadgeBackgroundColor({ color: "#888888" }); }
  else if (unseen) { chrome.action.setBadgeText({ text: String(unseen) }); chrome.action.setBadgeBackgroundColor({ color: "#d9480f" }); }
  else chrome.action.setBadgeText({ text: "" });
}

// ---------- 入队 ----------
async function enqueue(tab, mode = "style") {
  const p = parseTweetUrl(tab && tab.url);
  if (!p) return { ok: false, reason: "not_post" };
  const provider = await getProvider();
  const geminiEndpoint = provider === "gemini" ? await getGeminiEndpoint() : undefined;
  // 入队时绑定供应商，切换设置不会把排队任务误发给另一个服务。
  if (!await hasProviderKey(provider, geminiEndpoint)) return { ok: false, reason: "请先在设置页填写所选服务的 API Key" };
  let ctx = null;
  try {
    const [r] = await chrome.scripting.executeScript({ target: { tabId: tab.id }, func: readPostContext, args: [p.tweetId, p.handle] });
    ctx = r && r.result;
  } catch (_) {}
  const queued = await mutateItems((items) => {
    const dup = items.find((x) => x.tweetId === p.tweetId && x.status !== "failed");
    if (dup) return { ok: false, reason: "duplicate", id: dup.id, status: dup.status };
    const old = items.findIndex((x) => x.tweetId === p.tweetId);
    if (old >= 0) items.splice(old, 1); // 失败过的重新排队
    const item = {
      id: p.tweetId + "-" + Date.now().toString(36),
      tweetId: p.tweetId,
      handle: p.handle,
      url: `https://x.com/${p.handle}/status/${p.tweetId}`,
      ctx,
      provider,
      geminiEndpoint,
      mode: mode === "full" ? "full" : "style",
      status: "queued",
      createdAt: Date.now()
    };
    items.push(item);
    return { ok: true, id: item.id };
  });
  refreshBadge();
  processQueue();
  return queued;
}

chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  // 发给后台截图页面的、以及它广播出来的进度，不归这里回答
  if (!msg || msg.target === "offscreen" || msg.type === "frames:update") return false;
  if (msg.type === "frames:idle") { chrome.offscreen && chrome.offscreen.closeDocument().catch(() => {}); return false; }
  (async () => {
    await ready; // 等恢复完成再接收入队，防止启动时覆盖新任务。
    if (msg.type === "enqueue") return enqueue(msg.tab, msg.mode);
    if (msg.type === "addShots") { addShots(msg.id); return { ok: true }; }
    if (msg.type === "retry") {
      // 用户主动重试时重新绑定当前选择，保留来源与服务一致。
      const provider = await getProvider();
      const geminiEndpoint = provider === "gemini" ? await getGeminiEndpoint() : undefined;
      await updateItem(msg.id, { status: "queued", error: "", provider, geminiEndpoint });
      refreshBadge(); processQueue(); return { ok: true };
    }
    if (msg.type === "patchResult") {
      // 收藏页补充的字段（风格配方、英文提示词、视频地址）走后台串行写入
      const allowed = ["style_guide", "style_template_zh", "style_template_en", "title", "prompt_en", "videoUrl", "shots", "cutsSnapped", "prompt_zh"];
      const patch = Object.fromEntries(Object.entries(msg.patch || {}).filter(([k]) => allowed.includes(k)));
      const ok = await mutateItems((items) => {
        const i = items.findIndex((x) => x.id === msg.id);
        if (i < 0 || !items[i].result) return false;
        items[i] = { ...items[i], result: { ...items[i].result, ...patch } };
        return true;
      });
      return { ok };
    }
    if (msg.type === "videoUrl") {
      // 老收藏没存视频地址：现查一次给收藏页播放
      try {
        const v = await resolveVideo(String(msg.tweetId || "").replace(/\D/g, ""), null);
        return { ok: /^https:\/\/video\.twimg\.com\//.test(v.playUrl || "") , url: v.playUrl, best: /^https:\/\/video\.twimg\.com\//.test(v.bestUrl || "") ? v.bestUrl : v.playUrl, thumb: v.thumb };
      } catch (e) { return { ok: false }; }
    }
    if (msg.type === "refreshBadge") { await refreshBadge(); return { ok: true }; }
    if (msg.type === "framesEnqueue") return framesEnqueue(msg.ids || [], !!msg.force);
    if (msg.type === "frames:snapped") return saveSnapped(msg.id, msg.shots || [], msg.base);
    if (msg.type === "frames:saved" || msg.type === "proofread") { proofreadItem(msg.id).catch((e) => console.warn(e)); return { ok: true }; }
    if (msg.type === "framesStatus") {
      // 后台截图页面没开着：说明没有正在做的截图
      if (chrome.runtime.getContexts && !(await chrome.runtime.getContexts({ contextTypes: ["OFFSCREEN_DOCUMENT"] })).length) return { ok: true, state: null };
      return chrome.runtime.sendMessage({ target: "offscreen", type: "frames:status", id: msg.id }).catch(() => ({ ok: true, state: null }));
    }
    return { ok: false };
  })().then(sendResponse, (e) => sendResponse({ ok: false, reason: String(e.message || e) }));
  return true;
});

// 浏览器重启或后台被挂起后，把中断的任务重新排队
async function resume() {
  const items = await getItems();
  let changed = false;
  for (const x of items) if (x.status === "processing") { x.status = "queued"; changed = true; }
  if (changed) await saveItems(items);
  refreshBadge();
  processQueue();
}
// 点工具栏图标时打开侧边栏
if (chrome.sidePanel && chrome.sidePanel.setPanelBehavior) chrome.sidePanel.setPanelBehavior({ openPanelOnActionClick: true }).catch(() => {});

// 每次后台进程启动都会执行（包括浏览器启动、插件安装和被唤醒）
const ready = resume();
