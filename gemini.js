import { baseSchema, toGeminiSchema } from "./prompt.js";

// 固定来源与独立凭据，避免把第三方 Key 发送到 Google，或跟随上传重定向泄露。
const BASES = { google: "https://generativelanguage.googleapis.com", micu: "https://www.micuapi.ai", atlas: "https://api.atlascloud.ai" };
const endpointOf = (value) => value === "micu" ? "micu" : value === "atlas" ? "atlas" : "google";
// Atlas Cloud：一个 Key 用全部模型。模型名带 google/ 前缀，接口路径是 /v1/models/…
export const ATLAS_MODELS = { analysis: "google/gemini-3.8-flash", plan: "google/gemini-4-argon", check: "google/gemini-3.1-flash-lite" };
const modelPath = (endpoint, m) => endpoint === "atlas" ? `${BASES.atlas}/v1/models/${m}` : `${BASES[endpoint]}/v1beta/models/${encodeURIComponent(m)}`;
export const DEFAULT_MODEL = "gemini-2.5-flash";
// Base64 会增加约 1/3 体积；预留提示词与 JSON 开销，避免 18MB 原视频超过 20MB 请求上限。
const INLINE_LIMIT = 14 * 1024 * 1024;
// 注：v0.4 起下载的是较低码率版本（约 0.8Mbps），绝大多数视频都在内联上限以内，不再需要 Files API。

export async function getSettings(endpoint) {
  const s = await chrome.storage.local.get(["geminiEndpoint", "apiKey", "model", "micuApiKey", "micuModel", "atlasApiKey", "atlasModel"]);
  endpoint = endpointOf(endpoint ?? s.geminiEndpoint);
  const key = endpoint === "micu" ? s.micuApiKey : endpoint === "atlas" ? s.atlasApiKey : s.apiKey;
  const model = endpoint === "micu" ? s.micuModel : endpoint === "atlas" ? s.atlasModel : s.model;
  return { apiKey: (key || "").trim(), model: (model || (endpoint === "atlas" ? ATLAS_MODELS.analysis : DEFAULT_MODEL)).trim(), endpoint };
}

function checkedUrl(url, endpoint) {
  let u;
  try { u = new URL(url); } catch (_) {}
  if (!u || u.origin !== BASES[endpointOf(endpoint)] || u.username || u.password) {
    const e = new Error("视频上传地址与所选 Gemini 来源不一致，已停止上传");
    e.noRetry = true; throw e;
  }
  return u.href;
}

// 中转站的不同接口认 Key 的方式不一样：有的只认 x-goog-api-key，有的只认 Authorization: Bearer。
// 米醋两种都带上；Google 官方只带 x-goog-api-key（带 Bearer 会被当成 OAuth 令牌而拒绝）。
function authHeaders(apiKey, endpoint) {
  if (endpointOf(endpoint) === "atlas") return { Authorization: "Bearer " + apiKey };
  return endpointOf(endpoint) === "micu"
    ? { "x-goog-api-key": apiKey, Authorization: "Bearer " + apiKey }
    : { "x-goog-api-key": apiKey };
}

function httpError(status, data) {
  const raw = String(data?.error?.message || data?.message || "");
  const reason = status === 401 ? "API Key 无效，请检查所选来源的 Key"
    : status === 403 ? "当前 Key 没有访问权限，请检查账号及模型权限"
    : status === 404 ? "所选模型或接口不存在，请重新检测模型"
    : status === 429 ? "请求过于频繁或额度不足，请稍后重试"
    : status === 400 ? "请求参数不被当前模型接受，请检查视频与模型支持情况"
    : status === 413 ? "视频太大，中转服务拒收"
    : status === 500 && /timed? ?out|timeout|context canceled/i.test(raw) ? "中转站的上游服务器没有响应（等待超时），这是中转线路的问题，请稍后再试或在中转站后台换一个分组"
    : [502, 503, 504, 520, 522, 524].includes(status) ? "中转服务网关超时或繁忙（视频分析耗时较长时常见），请稍后重试或换更快的模型"
    : "服务暂时不可用，请稍后重试";
  const err = new Error("Gemini 请求失败（HTTP " + status + "）：" + reason);
  err.status = status;
  // 仅结构格式错误允许去掉约束，其他 400 不重传完整视频。
  err.schemaRejected = /response[_\s]?schema|response[_\s]?mime[_\s]?type|structured.?output|json.?schema|property.?ordering/i.test(raw);
  err.mimeRejected = /response[_\s]?mime[_\s]?type/i.test(raw);
  err.thinkingRejected = /thinking/i.test(raw);
  err.mediaResRejected = /media_?resolution/i.test(raw);
  err.upstreamTimeout = status >= 500 && /timed? ?out|timeout|context canceled/i.test(raw);
  err.fileRejected = /file_?uri|file_?data|fetch|download|unreachable|url/i.test(raw);
  return err;
}

// 补发的备用请求先完成时，取消另一个；被取消的请求不算失败
function cancelledError() { const e = new Error("已取消"); e.cancelled = true; e.noRetry = true; return e; }
function safeError(error, { stage, apiKey, aborted }) {
  // DOMException.message 只读；复制异常并使用固定中文，不把服务端正文或凭据写入界面。
  const timedOut = aborted || /TimeoutError|AbortError/.test(error?.name) || /timeout|timed out/i.test(error?.message || "");
  const safe = error?.status || /^[\u3400-\u9fff]|^Gemini(?=.*[\u3400-\u9fff])/.test(error?.message || "");
  const e = new Error(timedOut ? (stage === "upload" ? "视频上传到 Gemini 超时，请稍后重试" : "Gemini 分析超时（中转服务较慢），请稍后重试")
    : safe ? String(error.message).split(apiKey).join("[已隐藏]")
    : (stage === "upload" ? "视频上传到 Gemini 失败，请检查网络后重试" : "Gemini 分析请求连接中断，请检查网络后重试"));
  e.name = timedOut ? "TimeoutError" : "Error";
  e.stage = stage; e.status = error?.status; e.noRetry = timedOut || error?.noRetry;
  for (const k of ["schemaRejected", "mimeRejected", "thinkingRejected", "upstreamTimeout", "fileRejected"]) e[k] = error?.[k];
  if (error?.upstreamTimeout) e.noRetry = true; // 上游已经等了几分钟还没响应，自动重试只会再白等一轮
  return e;
}

async function apiRequest(url, opts, apiKey, endpoint, { stage = "analysis", headersOnly = false, timeout = 300000, signal = null } = {}) {
  checkedUrl(url, endpoint);
  const controller = new AbortController();
  const t0 = Date.now();
  if (signal) { if (signal.aborted) controller.abort(); else signal.addEventListener("abort", () => controller.abort(), { once: true }); }
  let timer;
  const arm = () => { clearTimeout(timer); timer = setTimeout(() => controller.abort(), timeout); };
  arm();
  try {
    const res = await fetch(url, { ...opts, redirect: "error", credentials: "omit", signal: controller.signal,
      headers: { ...(opts.headers || {}), ...authHeaders(apiKey, endpoint) } });
    arm();
    if (headersOnly && res.ok) { res.body?.cancel().catch(() => {}); return res; }
    let data;
    try { data = await res.json(); }
    catch (error) {
      if (controller.signal.aborted || /AbortError|TimeoutError/.test(error?.name)) throw error;
      if (res.ok) throw new Error("Gemini 分析响应读取失败或格式无效，请检查网络后重试");
    }
    if (res.ok) return data;
    throw httpError(res.status, data);
  } catch (error) {
    if (signal && signal.aborted) throw cancelledError();
    const e = safeError(error, { stage, apiKey, aborted: controller.signal.aborted });
    if (e.name === "TimeoutError" && stage === "analysis") e.message = `Gemini 分析超时：请求发出后等了 ${Math.round((Date.now() - t0) / 1000)} 秒都没有返回结果（中转站可能在排队或卡住了），请稍后重试`;
    throw e;
  } finally { clearTimeout(timer); }
}

// 流式请求：中转站（常见 Cloudflare 网关）对“长时间没有任何数据”的连接约 100 秒就会掐断，
// 流式输出让模型边想边回，连接一直有数据，不会被网关当成超时。
async function streamRequest(url, body, apiKey, endpoint, { signal = null, onFirst = null } = {}) {
  checkedUrl(url, endpoint);
  const controller = new AbortController();
  if (signal) { if (signal.aborted) controller.abort(); else signal.addEventListener("abort", () => controller.abort(), { once: true }); }
  let idle;
  const total = setTimeout(() => controller.abort(), 600000);
  const arm = (ms) => { clearTimeout(idle); idle = setTimeout(() => controller.abort(), ms); };
  arm(300000); // 上传视频 + 首个数据块
  // 记录每个阶段用了多久，超时时告诉用户卡在哪一步，成功时也留下耗时
  const t0 = Date.now(); let tHead = 0, tFirst = 0, received = 0, tText = 0, textLen = 0;
  // 模型先处理视频、先思考时不会输出正文（中转可能只发连接确认），这段时间放宽到 5 分钟；正文开始后 2 分钟没新内容才算中断
  const phase = () => !tHead ? "sending" : !tText ? "waiting" : "streaming";
  try {
    const res = await fetch(url, { method: "POST", body, redirect: "error", credentials: "omit", signal: controller.signal,
      headers: { "Content-Type": "application/json", ...authHeaders(apiKey, endpoint) } });
    if (!res.ok) {
      let data; try { data = await res.json(); } catch (_) {}
      throw httpError(res.status, data);
    }
    tHead = Date.now();
    arm(300000);
    const type = res.headers.get("content-type") || "";
    const chunks = [];
    if (!type.includes("event-stream")) {
      // 有的中转忽略 alt=sse，直接返回 JSON（对象或数组）
      const j = await res.json();
      tFirst = Date.now(); onFirst && onFirst();
      chunks.push(...(Array.isArray(j) ? j : [j]));
    } else {
      const reader = res.body.getReader(), decoder = new TextDecoder();
      let buffer = "";
      const consume = (event) => {
        const data = event.split(/\r?\n/).filter((l) => l.startsWith("data:")).map((l) => l.slice(5).trimStart()).join("\n");
        if (!data || data.trim() === "[DONE]") return;
        const j = JSON.parse(data);
        if (j.error) throw httpError(j.error.code || 500, j);
        for (const p of (j.candidates || [])[0]?.content?.parts || []) if (!p.thought && p.text) { textLen += p.text.length; if (!tText) { tText = Date.now(); onFirst && onFirst(); } }
        chunks.push(j);
      };
      for (;;) {
        const { done, value } = await reader.read();
        if (value && value.length) { if (!tFirst) tFirst = Date.now(); received += value.length; }
        arm(tText ? 120000 : 300000);
        buffer += done ? decoder.decode() : decoder.decode(value, { stream: true });
        let m;
        while ((m = /\r?\n\r?\n/.exec(buffer))) { consume(buffer.slice(0, m.index)); buffer = buffer.slice(m.index + m[0].length); }
        if (done) break;
      }
      if (buffer.trim()) consume(buffer);
    }
    // 合并成与非流式相同的结构，交给 extractText 统一检查
    let text = "", finishReason, blockReason, usageMetadata;
    for (const j of chunks) {
      if (j.usageMetadata) usageMetadata = j.usageMetadata;
      if (j.promptFeedback?.blockReason) blockReason = j.promptFeedback.blockReason;
      const c = (j.candidates || [])[0];
      if (!c) continue;
      for (const p of c.content?.parts || []) if (!p.thought && p.text) text += p.text;
      if (c.finishReason) finishReason = c.finishReason;
    }
    lastTiming = { send: Math.round(((tHead || Date.now()) - t0) / 1000), firstByte: Math.round(((tFirst || Date.now()) - t0) / 1000),
      total: Math.round((Date.now() - t0) / 1000), chars: text.length, streamed: type.includes("event-stream") };
    if (!text && !finishReason) {
      // 记录收到的内容开头，方便定位“空结果”是中转站出错还是被拦截
      const sample = JSON.stringify(chunks.slice(-2)).slice(0, 160);
      return { promptFeedback: blockReason ? { blockReason } : undefined, candidates: [], _empty: { bytes: received, sample } };
    }
    // 部分中转在流末尾不回 finishReason，有完整文本时视为正常结束，由 JSON 校验兜底
    return { candidates: [{ content: { parts: [{ text }] }, finishReason: finishReason || "STOP" }], usageMetadata };
  } catch (error) {
    if (signal && signal.aborted) throw cancelledError();
    const e = safeError(error, { stage: "analysis", apiKey, aborted: controller.signal.aborted });
    if (e.name === "TimeoutError") {
      const secs = Math.round((Date.now() - t0) / 1000);
      const ph = phase();
      e.message = ph === "sending" ? `Gemini 分析超时：等了 ${secs} 秒，中转站连“收到请求”都还没回复（视频可能还没传完，或中转站在排队），请稍后重试`
        : ph === "waiting" ? `Gemini 分析超时：中转站 ${Math.round((tHead - t0) / 1000)} 秒时已经连上，但之后 ${Math.round((Date.now() - tHead) / 1000)} 秒模型都没有开始输出内容（可能还在下载/处理视频，或在排队），请稍后重试`
        : `Gemini 分析超时：模型输出到一半中断了（已输出约 ${textLen} 字），请重试`;
    }
    throw e;
  } finally { clearTimeout(idle); clearTimeout(total); }
}

// 列出账号可用、能做 generateContent 的模型
export async function listModels(apiKey, endpoint = "google", filter = isVideoModel) {
  endpoint = endpointOf(endpoint);
  if (endpoint === "atlas") {
    // Atlas 的模型列表走 OpenAI 格式：{ data: [{ id }] }
    const j = await apiRequest(`${BASES.atlas}/v1/models`, {}, apiKey, endpoint, { timeout: 30000 });
    return [...new Set((j.data || j.models || []).map((m) => String(m.id || m.name || "")).filter((n) => filter(n)))];
  }
  const out = [];
  let pageToken = "";
  for (let i = 0; i < 5; i++) {
    const url = `${BASES[endpoint]}/v1beta/models?pageSize=100${pageToken ? "&pageToken=" + encodeURIComponent(pageToken) : ""}`;
    const j = await apiRequest(url, {}, apiKey, endpoint, { timeout: 30000 });
    // 米醋原生路由也可能返回兼容格式 data/id，保留原生 contents 调用方式。
    for (const m of j.models || (endpoint === "micu" ? j.data : []) || []) {
      const name = String(m.name || m.id || "").replace(/^models\//, "");
      if (filter(name) && ((m.supportedGenerationMethods || []).includes("generateContent")
          || (endpoint === "micu" && !m.supportedGenerationMethods))) out.push(name);
    }
    if (!j.nextPageToken) break;
    pageToken = j.nextPageToken;
  }
  return [...new Set(out)];
}

// 自动挑一个能看视频的普通对话模型（排除图片、语音、实时、向量等专用模型）
export function isVideoModel(model) {
  model = String(model || "").replace(/^google\//, "");
  return /^gemini[\w.-]*$/i.test(model || "") && !/(image|tts|live|embedding|audio|aqa|imagen|veo|robotics|computer-use|native|thinking)/i.test(model);
}
export function pickVideoModel(models) {
  const ok = models.filter(isVideoModel);
  if (ok.includes(DEFAULT_MODEL)) return DEFAULT_MODEL;
  if (ok.includes(ATLAS_MODELS.analysis)) return ATLAS_MODELS.analysis;
  const flash = ok.filter((m) => /flash/i.test(m) && !/lite/i.test(m));
  const pool = flash.length ? flash : ok;
  pool.sort((a, b) => b.localeCompare(a, undefined, { numeric: true }));
  return pool[0] || null;
}

function toBase64(buf) {
  const bytes = new Uint8Array(buf);
  let s = "";
  const chunk = 0x8000;
  for (let i = 0; i < bytes.length; i += chunk) s += String.fromCharCode.apply(null, bytes.subarray(i, i + chunk));
  return btoa(s);
}

async function uploadFile(apiKey, buf, mime, endpoint) {
  const base = BASES[endpoint];
  const start = await apiRequest(`${base}/upload/v1beta/files`, {
    method: "POST",
    headers: {
      "X-Goog-Upload-Protocol": "resumable",
      "X-Goog-Upload-Command": "start",
      "X-Goog-Upload-Header-Content-Length": String(buf.byteLength),
      "X-Goog-Upload-Header-Content-Type": mime,
      "Content-Type": "application/json"
    },
    body: JSON.stringify({ file: { display_name: "style-lens-video" } })
  }, apiKey, endpoint, { stage: "upload", headersOnly: true });
  const uploadUrl = start.headers.get("x-goog-upload-url");
  if (!uploadUrl) throw new Error("视频上传失败：没拿到上传地址");
  checkedUrl(uploadUrl, endpoint);
  const up = await apiRequest(uploadUrl, {
    method: "POST",
    headers: { "X-Goog-Upload-Offset": "0", "X-Goog-Upload-Command": "upload, finalize" },
    body: buf
  }, apiKey, endpoint, { stage: "upload" });
  let file = up.file;
  const deadline = Date.now() + 120000;
  for (let i = 0; i < 40 && file?.state === "PROCESSING" && Date.now() < deadline; i++) {
    if (!/^files\/[\w.-]+$/.test(file.name || "")) throw new Error("Gemini 文件处理标识无效，已停止查询");
    await new Promise((r) => setTimeout(r, 3000));
    const remaining = deadline - Date.now();
    if (remaining <= 0) break;
    file = await apiRequest(`${base}/v1beta/${file.name}`, {}, apiKey, endpoint, { stage: "upload", timeout: Math.min(30000, remaining / 2) });
  }
  if (file?.state !== "ACTIVE" || !file.uri) {
    const e = new Error(file?.state === "PROCESSING" ? "视频在 Gemini 端处理超时，请稍后重试" : "视频在 Gemini 端处理失败，请检查当前来源是否支持 Files API");
    e.stage = "upload"; e.noRetry = true; throw e;
  }
  return { file_data: { mime_type: mime, file_uri: file.uri } };
}

// Atlas 可以直接给公开视频网址，由它自己去取，省掉上传几 MB 视频的时间
export const urlVideoPart = (url) => ({ file_data: { mime_type: "video/mp4", file_uri: url } });
export async function videoPart(apiKey, buf, mime, endpoint = "google") {
  if (buf.byteLength <= INLINE_LIMIT) return { inline_data: { mime_type: mime, data: toBase64(buf) } };
  if (endpointOf(endpoint) === "atlas") { const e = new Error("视频超过 14MB，Atlas 无法内联上传"); e.noRetry = true; throw e; }
  return uploadFile(apiKey, buf, mime, endpointOf(endpoint));
}

function extractText(j) {
  const c = (j.candidates || [])[0];
  if (!c) {
    const reason = j.promptFeedback && j.promptFeedback.blockReason;
    if (reason) throw new Error("请求被 Gemini 拦截（" + reason + "），本次结果未保存");
    const e = new Error("模型返回了空结果" + (j._empty ? `（收到 ${Math.round(j._empty.bytes / 1024 * 10) / 10}KB，没有正文）` : "") + "，通常是中转站临时出错，稍后重试即可");
    e.emptyResult = true; e.sample = j._empty && j._empty.sample; throw e;
  }
  // 截断或拦截的响应即使恰好可解析成 JSON，也不能当成完整分析保存。
  if (c.finishReason && c.finishReason !== "STOP") {
    const e = new Error(c.finishReason === "MAX_TOKENS" ? "Gemini 输出达到长度上限，分析不完整，本次结果未保存" : "Gemini 未完整完成分析，本次结果未保存");
    e.stage = "validation"; e.noRetry = true; throw e;
  }
  const parts = (c.content && c.content.parts) || [];
  const text = parts.filter((p) => !p.thought && p.text).map((p) => p.text).join("");
  if (!text) throw new Error("Gemini 返回为空（结束原因：" + (c.finishReason || "未知") + "）");
  return text;
}

export function parseJSON(text) {
  let t = text.trim().replace(/^```(?:json)?\s*/i, "").replace(/```\s*$/, "");
  try { return JSON.parse(t); } catch (_) {}
  const s = t.indexOf("{"), e = t.lastIndexOf("}");
  if (s >= 0 && e > s) return JSON.parse(t.slice(s, e + 1));
  throw new Error("Gemini 返回的不是有效 JSON");
}

// 关掉/压低“思考”：2.5 Flash 默认会先思考很久再输出，看视频拆镜头不需要，这是“分析很慢”的主因之一。
// level：拆解视频用 "medium"（多花几秒，换更仔细的核对），其余用 "low"
function thinkingFor(model, level = "low") {
  if (/gemini-2\.5-flash/i.test(model)) return { thinkingBudget: level === "low" ? 0 : 1024 };
  if (/gemini-2\.5-pro/i.test(model)) return { thinkingBudget: level === "low" ? 128 : 2048 };
  if (/gemini-[34]/i.test(model)) return { thinkingLevel: level };
  return null;
}
let lastTiming = null; // 最近一次分析各阶段耗时（秒）
export const getLastTiming = () => lastTiming;
const noStream = {};      // 某来源不支持流式时记住，之后直接走普通请求
const noThinking = {};    // 某来源拒收 thinkingConfig 时记住
const lowThinkingOnly = {}; // 某来源不认 "medium" 时记住，只用 "low"
const noMediaRes = {};    // 某来源不认 mediaResolution（看视频的画质档位）时记住
// 累计用量：usage = { in, out, calls }（out 含思考）
function addUsage(usage, meta) {
  if (!usage || !meta) return;
  usage.in = (usage.in || 0) + (meta.promptTokenCount || 0);
  usage.out = (usage.out || 0) + (meta.candidatesTokenCount || 0) + (meta.thoughtsTokenCount || 0);
  usage.calls = (usage.calls || 0) + 1;
}

// 生成内容；模型不存在时自动换一个可用模型；结构化约束被拒时去掉约束重试
export async function generate(parts, { json = true, schema = null, endpoint, model: modelOverride, signal = null, onFirst = null, thinkingLevel = "low", mediaRes = null, usage = null } = {}) {
  let settings = await getSettings(endpoint);
  let { apiKey, model } = settings;
  const override = !!modelOverride;
  if (override) model = modelOverride;
  endpoint = settings.endpoint;
  if (!apiKey) throw new Error("还没有填写 Gemini API Key，请在插件设置页填写");
  let withMime = json;
  const body = (withSchema) => {
    const gc = { temperature: 0.4, maxOutputTokens: 16384 };
    if (withMime) gc.responseMimeType = "application/json";
    if (json && withSchema && schema) gc.responseSchema = schema;
    const thinking = noThinking[endpoint] ? null : thinkingFor(model, lowThinkingOnly[endpoint] ? "low" : thinkingLevel);
    if (thinking) gc.thinkingConfig = thinking;
    if (mediaRes && !noMediaRes[endpoint]) gc.mediaResolution = mediaRes;
    // 去掉服务端结构约束后，仍在提示词内保留完整 JSON 字段约定。
    const content = json && schema && !withSchema ? [...parts, { text: "只返回完整 JSON，严格遵守以下字段结构：\n" + JSON.stringify(schema) }] : parts;
    return JSON.stringify({ contents: [{ role: "user", parts: content }], generationConfig: gc });
  };
  const fin = (data) => { addUsage(usage, data && data.usageMetadata); return extractText(data); };
  const call = async (m, withSchema) => {
    const base = modelPath(endpoint, m);
    if (!noStream[endpoint]) {
      try { return fin(await streamRequest(`${base}:streamGenerateContent?alt=sse`, body(withSchema), apiKey, endpoint, { signal, onFirst })); }
      catch (err) {
        // 流式返回了空结果：换普通请求再试一次（不关掉流式）
        if (err.cancelled) throw err;
        if (err.emptyResult) {
          console.warn("流式空结果，改用普通请求重试", err.sample);
          return fin(await apiRequest(`${base}:generateContent`, { method: "POST", headers: { "Content-Type": "application/json" }, body: body(withSchema) }, apiKey, endpoint, { signal }));
        }
        // 流式接口不存在、不支持，或中转站在流式接口上不认 Key（401/403）时，退回 0.3.4 用的普通请求；
        // 普通请求也 401 才说明 Key 真的有问题。
        if (![401, 403, 404, 405, 501, ...(endpoint === "atlas" ? [400] : [])].includes(err.status) || err.thinkingRejected || err.schemaRejected || err.fileRejected) throw err;
        // 改用普通请求试一次；普通请求成功了才说明是“不支持流式”，之后直接走普通请求。
        // 普通请求也失败（例如模型名不存在），就把错误交给外层处理，不关掉流式。
        const data = await apiRequest(`${base}:generateContent`, {
          method: "POST", headers: { "Content-Type": "application/json" }, body: body(withSchema)
        }, apiKey, endpoint, { signal });
        noStream[endpoint] = true;
        return fin(data);
      }
    }
    const data = await apiRequest(`${base}:generateContent`, {
      method: "POST", headers: { "Content-Type": "application/json" }, body: body(withSchema)
    }, apiKey, endpoint, { signal });
    return fin(data);
  };
  let withSchema = Boolean(json && schema);
  let switchedModel = false;
  for (let attempt = 0; attempt < 5; attempt++) {
    try {
      return await call(model, withSchema);
    } catch (err) {
      if (err.cancelled) throw err;
      if (err.status === 400 && err.mediaResRejected && mediaRes && !noMediaRes[endpoint]) { noMediaRes[endpoint] = true; continue; }
      if (err.status === 400 && err.thinkingRejected && thinkingLevel !== "low" && !lowThinkingOnly[endpoint]) { lowThinkingOnly[endpoint] = true; continue; }
      if (err.status === 400 && err.thinkingRejected && !noThinking[endpoint]) { noThinking[endpoint] = true; continue; }
      if (err.status === 404 && override && !switchedModel) {
        // 指定的专用模型（如写方案用的旗舰）不存在时，退回设置里的默认模型，不改动保存的设置
        model = settings.model; switchedModel = true; continue;
      }
      if (err.status === 404 && !switchedModel) {
        const picked = pickVideoModel((await listModels(apiKey, endpoint)).filter((m) => m !== model));
        if (!picked) throw new Error("你的 API Key 下没有找到其他能看视频的 Gemini 模型");
        model = picked;
        switchedModel = true;
        await chrome.storage.local.set({ [endpoint === "micu" ? "micuModel" : endpoint === "atlas" ? "atlasModel" : "model"]: model });
        continue;
      }
      if (err.status === 400 && err.schemaRejected && (withSchema || (err.mimeRejected && withMime))) {
        withSchema = false;
        if (err.mimeRejected) withMime = false;
        continue;
      }
      throw err;
    }
  }
  throw new Error("Gemini 接口兼容重试已用尽，请重新检测模型后重试");
}

// ---------- 视频分析的提示词与结构（与千问共用） ----------
export { analysisPrompt } from "./prompt.js";
export const analysisSchema = toGeminiSchema(baseSchema);

// ---------- 生成分镜画面（Gemini 图像模型，例如 gemini-2.5-flash-image） ----------
export const DEFAULT_IMAGE_MODEL = "gemini-2.5-flash-image";
export const isImageModel = (m) => /^gemini[\w.-]*image/i.test(m || "") && !/imagen/i.test(m);
export async function getImageSettings() {
  const s = await chrome.storage.local.get(["imageEndpoint", "imageModel", "apiKey", "micuApiKey", "geminiEndpoint"]);
  const endpoint = endpointOf(s.imageEndpoint ?? s.geminiEndpoint);
  return { endpoint, apiKey: ((endpoint === "micu" ? s.micuApiKey : s.apiKey) || "").trim(), model: (s.imageModel || DEFAULT_IMAGE_MODEL).trim() };
}
const noImageConfig = {};
// parts：参考图（inline_data）+ 文字；返回 { mime, data(base64) }
export async function generateImage(parts, { aspect } = {}) {
  const { endpoint, apiKey, model } = await getImageSettings();
  if (!apiKey) throw new Error("生成画面要用 Gemini 的 Key（官方或米醋），请在设置页填写");
  for (let attempt = 0; attempt < 2; attempt++) {
    const gc = { responseModalities: ["IMAGE", "TEXT"], temperature: 0.8 };
    if (aspect && !noImageConfig[endpoint]) gc.imageConfig = { aspectRatio: aspect };
    try {
      const data = await apiRequest(`${BASES[endpoint]}/v1beta/models/${encodeURIComponent(model)}:generateContent`, {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ contents: [{ role: "user", parts }], generationConfig: gc })
      }, apiKey, endpoint, { timeout: 180000 });
      const c = (data.candidates || [])[0];
      const ps = (c && c.content && c.content.parts) || [];
      const img = ps.map((p) => p.inlineData || p.inline_data).find((d) => d && d.data);
      if (!img) {
        if (!c && data.promptFeedback?.blockReason) throw new Error("请求被安全策略拦截，换个描述再试");
        if (c && c.finishReason && c.finishReason !== "STOP") throw new Error("模型没有出图（" + c.finishReason + "），可能触发了安全限制，换个描述再试");
        throw new Error("模型没有返回图片，请确认设置里的生图模型能生成图片");
      }
      return { mime: img.mimeType || img.mime_type || "image/png", data: img.data };
    } catch (err) {
      // 有的中转不认 imageConfig（画幅参数），去掉后再试一次，画幅改由提示词说明
      if (err.status === 400 && gc.imageConfig) { noImageConfig[endpoint] = true; continue; }
      throw err;
    }
  }
}

// 测速：发一个很短的文字请求，看中转站多久开始回复、每秒能吐多少字
export async function speedTest(endpoint) {
  const t0 = Date.now();
  const text = await generate([{ text: "请写一段 300 字左右的中文短文，介绍一种你喜欢的颜色。" }], { json: false, endpoint });
  const t = lastTiming || {};
  return { firstByte: t.firstByte ?? Math.round((Date.now() - t0) / 1000), total: Math.round((Date.now() - t0) / 1000), chars: text.length, streamed: t.streamed };
}
