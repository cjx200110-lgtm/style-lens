import { formatTaskError, STAGE_LABELS } from "./errors.js";
import { shortTitle } from "./analysis-validation.js";

// 列表里显示的短标题：新收藏用模型给的 title，老收藏用创意标签兜底
export function displayTitle(item) {
  const r = (item && item.result) || {};
  return shortTitle(r.title || r.creative_tag || r.summary || "") || "@" + item.handle;
}
// 侧边栏和主页面共用的小工具
export function h(tag, attrs = {}, ...kids) {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs || {})) {
    if (k === "class") el.className = v;
    else if (k === "style" && typeof v === "object") Object.assign(el.style, v);
    else if (k.startsWith("on")) el.addEventListener(k.slice(2), v);
    else if (v !== undefined && v !== null && v !== false) el.setAttribute(k, v);
  }
  for (const k of kids.flat(Infinity)) if (k !== null && k !== undefined && k !== false) el.append(k instanceof Node ? k : String(k));
  return el;
}

export const STATUS = { queued: "排队中", processing: "分析中", done: "已完成", failed: "失败" };

export function toast(msg) {
  let t = document.querySelector(".toast");
  if (!t) { t = h("div", { class: "toast" }); document.body.append(t); }
  t.textContent = msg;
  t.classList.add("show");
  clearTimeout(t._t);
  t._t = setTimeout(() => t.classList.remove("show"), 1400);
}

export function copyButton(text, label = "复制", cls = "small") {
  return h("button", { class: cls, onclick: async (e) => { e.stopPropagation(); await navigator.clipboard.writeText(text || ""); toast("已复制"); } }, label);
}

export async function loadAll() {
  const s = await chrome.storage.local.get(["items", "picks", "seen", "lastReport", "styleGroups", "plans", "styleCards", "atlasApiKey", "planBudget", "stack", "filmModel", "filmResolution", "filmAudio", "videoProvider", "qwenApiKey", "apiKey", "micuApiKey", "geminiEndpoint", "provider"]);
  // 页面就绪状态使用当前来源的独立 Key，避免官方 Key 掩盖米醋未配置。
  const providerName = s.provider === "gemini" ? s.geminiEndpoint === "micu" ? "Gemini（米醋API）" : s.geminiEndpoint === "atlas" ? "Atlas Cloud" : "Gemini" : "千问";
  const key = s.provider === "gemini" ? s.geminiEndpoint === "micu" ? s.micuApiKey : s.geminiEndpoint === "atlas" ? s.atlasApiKey : s.apiKey : s.qwenApiKey;
  return { film: { filmModel: s.filmModel, filmResolution: s.filmResolution, filmAudio: s.filmAudio, videoProvider: s.videoProvider }, planBudget: Number(s.planBudget) || 30, stack: s.stack === "atlas" || s.geminiEndpoint === "atlas" ? "atlas" : "custom", styleCards: s.styleCards || [], styleGroups: s.styleGroups || null, plans: s.plans || [], items: s.items || [], picks: s.picks || {}, seen: s.seen || {}, lastReport: s.lastReport || null, providerName, hasKey: !!(key || "").trim() };
}

export async function togglePick(id, tag) {
  const { picks = {} } = await chrome.storage.local.get("picks");
  const cur = new Set(picks[id] || []);
  cur.has(tag) ? cur.delete(tag) : cur.add(tag);
  picks[id] = Array.from(cur);
  await chrome.storage.local.set({ picks });
}

// 勾选“喜欢点”的标签组
export function likeChips(item, picks) {
  const mine = picks[item.id] || [];
  return h("div", { class: "row" }, (item.candidateTags || []).map((t) =>
    h("span", { class: "chip" + (mine.includes(t) ? " on" : ""), onclick: (e) => { e.stopPropagation(); togglePick(item.id, t); } }, t)));
}

export function relTime(ts) {
  const d = (Date.now() - ts) / 1000;
  if (d < 60) return "刚刚";
  if (d < 3600) return Math.floor(d / 60) + " 分钟前";
  if (d < 86400) return Math.floor(d / 3600) + " 小时前";
  if (d < 86400 * 7) return Math.floor(d / 86400) + " 天前";
  return new Date(ts).toLocaleDateString();
}

export const isPostUrl = (url) => /^https:\/\/(?:www\.|mobile\.)?(?:x|twitter)\.com\/[^/?#]+\/status\/(\d+)/.exec(url || "");
export const libraryUrl = (hash = "") => chrome.runtime.getURL("library.html" + (hash ? "#" + hash : ""));
// 已经开着审美库就在那个页面里切换并调到前面（正在进行的截图、生成不会被打断）；没有才新开
export async function openLibrary(hash = "") {
  const url = libraryUrl(hash);
  try {
    const [tab] = await chrome.tabs.query({ url: libraryUrl() + "*" });
    if (tab) {
      await chrome.tabs.update(tab.id, { url, active: true });
      await chrome.windows.update(tab.windowId, { focused: true });
      return;
    }
  } catch (_) {}
  chrome.tabs.create({ url });
}

// 只允许 X 的图片域名作为缩略图，避免奇怪的地址混进样式
export function bg(url) {
  return /^https:\/\/pbs\.twimg\.com\/[^"'()\s\\]+$/.test(url || "") ? { backgroundImage: `url("${url}")` } : {};
}

// 老记录只做展示层转换，不伪造过去失败的具体步骤或尝试版本。
export function itemError(item) {
  return formatTaskError(item.error, { stage: item.errorStage || "unknown", provider: item.provider, legacy: !item.attemptVersion });
}
export function failureInfo(item) {
  const current = chrome.runtime.getManifest().version;
  const provider = item.provider === "gemini" ? item.geminiEndpoint === "micu" ? "Gemini（米醋API）" : item.geminiEndpoint === "atlas" ? "Atlas Cloud" : "Gemini" : item.provider === "qwen" ? "千问" : "未记录服务";
  return h("div", { class: "muted" },
    "当前插件 v" + current + " · " + provider + " · 失败步骤：" + (STAGE_LABELS[item.errorStage] || "未记录"),
    h("br"), "本次尝试版本：" + (item.attemptVersion || "原记录未记录")
      + (item.attemptedAt ? " · 开始于" + relTime(item.attemptedAt) : " · 点击重试可获取新诊断"));
}
