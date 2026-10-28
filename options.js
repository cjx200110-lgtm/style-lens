import * as qwen from "./qwen.js";
import * as gemini from "./gemini.js";
import * as video from "./video.js";
const $ = (id) => document.getElementById(id);
$("runtimeVersion").textContent = "v" + chrome.runtime.getManifest().version; // 显示实际加载版本，避免更新到另一插件目录。
let shownSlot = null;
let loading = true, busy = false, initializing = true, providerRequestId = 0;
const drafts = {};
const adapter = () => $("provider").value === "gemini" ? gemini : qwen;
const endpoint = () => $("geminiEndpoint").value === "micu" ? "micu" : "google";
const slot = () => $("provider").value === "gemini" ? "gemini:" + endpoint() : "qwen";
const names = (provider, source) => provider === "gemini"
  ? source === "micu" ? { key: "micuApiKey", model: "micuModel", list: "micuModelList" }
    : { key: "apiKey", model: "model", list: "modelList" }
  : { key: "qwenApiKey", model: "qwenModel", list: "qwenModelList" };

function fillModels(list, current) {
  const filter = $("provider").value === "gemini" ? gemini.isVideoModel : qwen.isVideoModel;
  const sel = $("model"); sel.innerHTML = "";
  for (const m of new Set([current, ...list].filter(filter))) {
    const option = document.createElement("option"); option.value = option.textContent = m; sel.append(option);
  }
  sel.value = current;
}
function rememberDraft() {
  if (shownSlot && !loading) drafts[shownSlot] = { key: $("key").value, model: $("model").value,
    list: [...$("model").options].map((o) => o.value), baseUrl: $("baseUrl").value };
}
function ready() { return !loading && shownSlot === slot(); }
function updateControls() {
  // 切换读取完成前禁用旧表单，防止把上一服务的 Key 保存或发送给新服务。
  for (const id of ["key", "model", "baseUrl", "save", "detect"]) $(id).disabled = busy || !ready();
  $("provider").disabled = initializing || busy;
  $("geminiEndpoint").disabled = initializing || busy;
  $("geminiEndpointRow").hidden = $("provider").value !== "gemini";
  $("baseUrlRow").hidden = $("provider").value === "gemini";
  $("speedRow").hidden = $("provider").value !== "gemini";
  // 来源只能在固定主机中选择，明确提示转发关系，不按 Key 前缀猜测路由。
  $("geminiEndpointHelp").textContent = endpoint() === "micu"
    ? "固定接口地址：https://www.micuapi.ai。视频和帖子文字会经米醋API转发。"
    : "固定接口地址：https://generativelanguage.googleapis.com。视频和帖子文字直接发送给 Google。";
}
async function showProvider() {
  rememberDraft();
  const requestId = ++providerRequestId;
  const provider = $("provider").value, source = endpoint(), currentSlot = slot(), n = names(provider, source), module = adapter();
  loading = true; updateControls();
  $("msg").textContent = "正在切换服务…";
  try {
    const saved = await chrome.storage.local.get([n.key, n.model, n.list, "qwenBaseUrl"]);
    // 请求编号覆盖 A→B→A 的重入场景，只允许最后一次读取应用结果或解除禁用。
    if (requestId !== providerRequestId) return;
    // Google、米醋和千问各自保存草稿及配置，切换来源时绝不沿用另一主机的 Key。
    const d = drafts[currentSlot] || { key: saved[n.key] || "", model: saved[n.model] || module.DEFAULT_MODEL,
      list: saved[n.list] || [], baseUrl: saved.qwenBaseUrl || qwen.DEFAULT_BASE_URL };
    if (provider === "qwen" && !qwen.isVideoModel(d.model)) d.model = qwen.DEFAULT_MODEL;
    $("key").value = d.key;
    $("keyLabel").textContent = (provider === "gemini" ? source === "micu" ? "米醋" : "Gemini" : "千问") + " API Key";
    $("key").placeholder = provider === "gemini" ? source === "micu" ? "在 www.micuapi.ai 获取" : "在 aistudio.google.com 获取" : "在阿里云百炼控制台获取";
    $("baseUrlRow").hidden = provider === "gemini";
    $("baseUrl").value = d.baseUrl;
    $("modelHelp").textContent = provider === "gemini" ? "可检测账号下可用的视频模型。" : "选择 Omni 模型，保留画面与声音分析；Key 需与服务地域一致。";
    fillModels(d.list, d.model);
    shownSlot = currentSlot;
    $("msg").textContent = "";
  } catch (_) {
    if (requestId === providerRequestId) { shownSlot = null; $("msg").textContent = "读取服务配置失败，请重新选择服务"; }
  } finally {
    if (requestId === providerRequestId) { loading = false; updateControls(); }
  }
}

$("provider").onchange = showProvider;
$("geminiEndpoint").onchange = showProvider;
$("detect").onclick = async () => {
  if (!ready() || busy) return; // 事件处理也检查状态，避免切换时旧输入跨服务发送。
  const key = $("key").value.trim();
  if (!key) { $("msg").textContent = "请先填写所选服务的 API Key"; return; }
  const provider = $("provider").value, source = endpoint(), module = adapter(), n = names(provider, source);
  busy = true; updateControls();
  $("msg").textContent = "检测中…";
  try {
    const list = provider === "gemini" ? await module.listModels(key, source)
      : await module.listModels(key, qwen.normalizeBaseUrl($("baseUrl").value));
    const best = module.pickVideoModel(list);
    await chrome.storage.local.set({ [n.list]: list });
    fillModels(list, best || $("model").value || module.DEFAULT_MODEL);
    $("msg").textContent = best ? `已选择 ${best}，记得点保存` : "没有找到可用的视频模型，请检查模型权限";
  } catch (e) {
    // 检测页也不直接展示服务端英文或可能回显的凭据。
    const reason = e.status === 401 ? "API Key 无效，请检查所选服务的 Key"
      : e.status === 403 ? "没有模型列表权限，请检查服务地域和账号权限"
      : e.status === 429 ? "请求过于频繁或额度不足，请稍后重试"
      : /^[\u3400-\u9fff]/.test(e.message || "") ? e.message : "请检查服务地址及网络后重试";
    $("msg").textContent = "模型列表检测失败（不代表推理不可用）：" + reason;
  }
  finally { busy = false; updateControls(); }
};
$("save").onclick = async () => {
  if (!ready() || busy) return; // 与检测共用保护，切换读取期间不写入任何服务的凭据。
  busy = true; updateControls();
  try {
    const provider = $("provider").value, source = endpoint(), n = names(provider, source), module = adapter();
    // 只保存所选服务的凭据，另一服务的 Key 和模型保持独立。
    const patch = { provider, [n.key]: $("key").value.trim(), [n.model]: $("model").value || module.DEFAULT_MODEL };
    if (provider === "qwen") patch.qwenBaseUrl = qwen.normalizeBaseUrl($("baseUrl").value);
    else patch.geminiEndpoint = source; // 将来源与对应 Key 一并保存，避免第三方凭据流向 Google。
    await chrome.storage.local.set(patch);
    rememberDraft();
    $("msg").textContent = "已保存";
  } catch (e) { $("msg").textContent = "保存失败：" + e.message; }
  finally { busy = false; updateControls(); }
};
(async () => {
  updateControls();
  try {
    const { provider = "qwen", geminiEndpoint = "google" } = await chrome.storage.local.get(["provider", "geminiEndpoint"]);
    $("provider").value = provider === "gemini" ? "gemini" : "qwen";
    $("geminiEndpoint").value = geminiEndpoint === "micu" ? "micu" : "google";
  } catch (_) { $("provider").value = "qwen"; }
  initializing = false;
  await showProvider();
})();

// ---------- 生图设置（独立于上面的分析服务） ----------
(async () => {
  const s = await chrome.storage.local.get(["imageEndpoint", "imageModel", "geminiEndpoint"]);
  $("imageEndpoint").value = (s.imageEndpoint ?? s.geminiEndpoint) === "micu" ? "micu" : "google";
  $("imageModel").value = s.imageModel || gemini.DEFAULT_IMAGE_MODEL;
})();
$("imageDetect").onclick = async () => {
  const ep = $("imageEndpoint").value;
  const k = await chrome.storage.local.get(ep === "micu" ? "micuApiKey" : "apiKey");
  const key = (k.micuApiKey || k.apiKey || "").trim();
  if (!key) { $("imageMsg").textContent = "请先在上面保存" + (ep === "micu" ? "米醋" : "Gemini") + "的 Key"; return; }
  $("imageMsg").textContent = "检测中…";
  try {
    const list = await gemini.listModels(key, ep, gemini.isImageModel);
    $("imageModelList").innerHTML = "";
    for (const m of list) { const o = document.createElement("option"); o.value = m; $("imageModelList").append(o); }
    if (list.length && !list.includes($("imageModel").value)) $("imageModel").value = list.find((m) => /flash-image/.test(m)) || list[0];
    $("imageMsg").textContent = list.length ? `找到 ${list.length} 个图像模型：${list.join("、")}。选好后点保存` : "没找到 Gemini 图像模型，这个来源可能不支持生图";
  } catch (e) { $("imageMsg").textContent = "检测失败（不代表不能用）：" + (e.status === 401 ? "Key 无效" : e.message); }
};
$("imageSave").onclick = async () => {
  await chrome.storage.local.set({ imageEndpoint: $("imageEndpoint").value, imageModel: $("imageModel").value.trim() || gemini.DEFAULT_IMAGE_MODEL });
  $("imageMsg").textContent = "已保存";
};

// ---------- 视频生成设置 ----------
(async () => {
  const s = await video.getVideoSettings();
  $("arkKey").value = s.apiKey; $("videoModel").value = s.model;
  const pv = await chrome.storage.local.get(["videoProvider", "atlasApiKey"]);
  $("videoProvider").value = pv.videoProvider === "ark" ? "ark" : "atlas"; $("atlasKey").value = pv.atlasApiKey || "";
  $("videoResolution").value = s.resolution; $("videoAudio").value = String(s.audio);
  for (const m of video.SUGGESTED_VIDEO_MODELS) { const o = document.createElement("option"); o.value = m; $("videoModelList").append(o); }
})();
$("videoSave").onclick = async () => {
  await chrome.storage.local.set({ videoProvider: $("videoProvider").value, atlasApiKey: $("atlasKey").value.trim(), arkApiKey: $("arkKey").value.trim(), videoModel: $("videoModel").value.trim() || video.DEFAULT_VIDEO_MODEL,
    videoResolution: $("videoResolution").value, videoAudio: $("videoAudio").value === "true" });
  $("videoMsg").textContent = "已保存";
};
$("videoTest").onclick = async () => {
  const key = $("arkKey").value.trim();
  if (!key) { $("videoMsg").textContent = "请先填写 Key"; return; }
  $("videoMsg").textContent = "检查中…";
  try { await video.testKey(key); $("videoMsg").textContent = "Key 可用（模型是否开通，要到第一次生成时才知道）"; }
  catch (e) { $("videoMsg").textContent = e.message; }
};

const MODEL_HELP = {
  "doubao-seedance-1-0-pro-fast-250528": "1.0 Pro 快速版（默认）：最便宜、没有 200 元门槛、最短 2 秒。2 秒 720p 约 0.2 元，适合日常试效果。画质和理解力不如 2.x。",
  "doubao-seedance-1-0-pro-250528": "1.0 Pro：比快速版画质好一些，价格约 3.5 倍，同样没有门槛。",
  "doubao-seedance-2-0-fast-260128": "2.0 快速版（需余额 > 200 元）：画质明显更好，每段 4 秒 480p 约 1.5 元、720p 约 3.2 元。",
  "doubao-seedance-2-0-mini-260615": "2.0 迷你版（需余额 > 200 元）：每段 4 秒 480p 约 0.9 元、720p 约 2 元，画质略低。",
  "doubao-seedance-2-5-260628": "2.5 最新版（需余额 > 200 元）：效果最好也最贵，每段 4 秒 720p 约 6 元，适合最后出成片。",
};
const showHelp = () => { $("videoModelHelp").textContent = MODEL_HELP[$("videoModel").value.trim()] || "模型 ID 以火山方舟控制台显示的为准。估价按 16:9 计算，实际以账单为准。"; };
$("videoModel").addEventListener("input", showHelp); setTimeout(showHelp, 300);

// ---------- 中转测速 ----------
$("speedTest").onclick = async () => {
  const ep = endpoint();
  $("speedTest").disabled = true; $("speedMsg").textContent = "测试中…（用已保存的 Key 和模型）";
  try {
    const r = await gemini.speedTest(ep);
    const rate = r.total > r.firstByte ? Math.round(r.chars / Math.max(1, r.total - r.firstByte)) : null;
    const verdict = r.firstByte <= 5 ? "响应正常" : r.firstByte <= 15 ? "有点慢，拆视频可能要几分钟" : "很慢，中转站可能在排队，拆视频容易超时，建议换时间段或换一家中转";
    $("speedMsg").textContent = `${r.firstByte} 秒后开始回复，共 ${r.total} 秒返回 ${r.chars} 字${rate ? `（约 ${rate} 字/秒）` : ""}${r.streamed === false ? "；这家中转不是边生成边返回" : ""}。${verdict}。`;
  } catch (e) { $("speedMsg").textContent = "测速失败：" + e.message; }
  finally { $("speedTest").disabled = false; }
};

// ---------- 一个 Key 方案（Atlas Cloud） ----------
(async () => {
  const s = await chrome.storage.local.get(["stack", "atlasApiKey", "planBudget", "geminiEndpoint"]);
  $("stack").value = s.stack === "atlas" ? "atlas" : s.stack === "custom" ? "custom" : (s.atlasApiKey ? "atlas" : "custom");
  $("atlasMainKey").value = s.atlasApiKey || "";
  $("budget").value = s.planBudget || 30;
  const sync = () => { $("atlasMain").hidden = $("stack").value !== "atlas"; if ($("stack").value === "custom") $("advanced").open = true; };
  $("stack").onchange = sync; sync();
})();
$("stackSave").onclick = async () => {
  const st = $("stack").value, key = $("atlasMainKey").value.trim(), budget = Math.max(1, Number($("budget").value) || 30);
  if (st === "atlas") {
    if (!key) { $("stackMsg").textContent = "请填写 Atlas Cloud 的 API Key"; return; }
    const prev = await chrome.storage.local.get(["geminiEndpoint", "provider"]);
    // 记住切换前的自定义来源，切回“自定义”时恢复
    await chrome.storage.local.set({ stack: "atlas", atlasApiKey: key, planBudget: budget, provider: "gemini", geminiEndpoint: "atlas",
      videoProvider: "atlas", ...(prev.geminiEndpoint !== "atlas" ? { customEndpoint: prev.geminiEndpoint || "google", customProvider: prev.provider || "qwen" } : {}) });
  } else {
    const prev = await chrome.storage.local.get(["customEndpoint", "customProvider", "geminiEndpoint"]);
    await chrome.storage.local.set({ stack: "custom", planBudget: budget,
      ...(prev.geminiEndpoint === "atlas" ? { geminiEndpoint: prev.customEndpoint || "google", provider: prev.customProvider || "gemini" } : {}) });
  }
  $("stackMsg").textContent = "已保存";
};
$("stackDetect").onclick = async () => {
  const key = $("atlasMainKey").value.trim();
  if (!key) { $("stackMsg").textContent = "请先填写 Key"; return; }
  $("stackMsg").textContent = "检查中…";
  try {
    const list = await gemini.listModels(key, "atlas", () => true);
    const want = Object.values(gemini.ATLAS_MODELS);
    const missing = want.filter((m) => !list.includes(m));
    $("stackMsg").textContent = list.length
      ? (missing.length ? `Key 可用。以下模型在列表里没找到，会自动用别的代替：${missing.join("、")}` : "Key 可用，所需模型都在。")
      : "Key 可用（没拿到模型列表，第一次使用时会自动确认）";
  } catch (e) { $("stackMsg").textContent = e.status === 401 ? "Key 无效，请检查" : "检查失败：" + e.message; }
};
