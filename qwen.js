import { baseSchema, toJsonSchema } from "./prompt.js";

// 切换供应商后独立保存配置，避免把旧 Gemini Key 误发到千问。
export const DEFAULT_MODEL = "qwen3.8-omni-flash";
export const DEFAULT_BASE_URL = "https://dashscope.aliyuncs.com/compatible-mode/v1";

export function normalizeBaseUrl(value = DEFAULT_BASE_URL) {
  let url;
  try { url = new URL((value || DEFAULT_BASE_URL).trim()); } catch (_) { throw new Error("请填写阿里云百炼的完整 Base URL"); }
  const legacy = ["dashscope.aliyuncs.com", "dashscope-intl.aliyuncs.com", "dashscope-us.aliyuncs.com"];
  const workspace = /^[a-z0-9-]+\.[a-z0-9-]+\.maas\.aliyuncs\.com$/i.test(url.hostname);
  // 只允许官方 HTTPS 服务地址，防止误填地址时将 Key 发送给其他网站。
  if (url.protocol !== "https:" || (!legacy.includes(url.hostname) && !workspace)
      || url.username || url.password || url.port || url.search || url.hash
      || url.pathname.replace(/\/+$/, "") !== "/compatible-mode/v1") {
    throw new Error("Base URL 必须是阿里云百炼官方的 /compatible-mode/v1 服务地址");
  }
  return url.origin + "/compatible-mode/v1";
}

export function isVideoModel(model) {
  // 使用全模态系列保留声音分析，不能自动回退至只看画面的 VL 或实时语音接口。
  return /^qwen(?:\d+(?:\.\d+)?)?-omni-(?:flash|plus|turbo)(?:$|-)/i.test(model || "")
    && !/(realtime|audio|tts|live)/i.test(model);
}

export async function getSettings() {
  const s = await chrome.storage.local.get(["qwenApiKey", "qwenModel", "qwenBaseUrl"]);
  return { apiKey: (s.qwenApiKey || "").trim(), model: isVideoModel(s.qwenModel) ? s.qwenModel : DEFAULT_MODEL,
    baseUrl: normalizeBaseUrl(s.qwenBaseUrl || DEFAULT_BASE_URL) };
}

async function apiFetch(url, opts, apiKey) {
  const res = await fetch(url, { ...opts, headers: { ...(opts.headers || {}), Authorization: "Bearer " + apiKey } });
  if (!res.ok) {
    let msg = String(res.status);
    let code = "";
    try {
      const j = await res.json();
      msg += "：" + (j.error?.message || j.message || res.statusText);
      code = j.error?.code || j.code || "";
    } catch (_) {}
    const err = new Error(msg.replaceAll(apiKey, "[已隐藏]"));
    err.status = res.status; err.code = code;
    throw err;
  }
  return res;
}

export async function listModels(apiKey, baseUrl = DEFAULT_BASE_URL) {
  const origin = new URL(normalizeBaseUrl(baseUrl)).origin;
  const models = [];
  // 百炼的原生模型列表返回 output.models，不能沿用 Gemini models 接口。
  for (let page = 1; page <= 20; page++) {
    const res = await apiFetch(`${origin}/api/v1/models?name=omni&page_no=${page}&page_size=100`, {}, apiKey);
    const j = await res.json();
    const batch = j.output?.models;
    if (!Array.isArray(batch)) throw new Error("百炼模型列表结构不符合预期，请核对业务空间 Base URL");
    for (const m of batch) {
      if (isVideoModel(m.model)) models.push(m.model);
    }
    if (batch.length < 100 || (Number.isFinite(j.output.total) && page * 100 >= j.output.total)) break;
  }
  return [...new Set(models)];
}

export function pickVideoModel(models) {
  const pool = models.filter(isVideoModel);
  if (pool.includes(DEFAULT_MODEL)) return DEFAULT_MODEL;
  // 优先稳定别名，其次快照；不假设普通文本模型具备视频或声音输入。
  pool.sort((a, b) => {
    const stable = (m) => /-(?:flash|plus|turbo)$/.test(m) ? 1 : 0;
    const version = (m) => Number(/^qwen(\d+(?:\.\d+)?)/i.exec(m)?.[1] || 0);
    return version(b) - version(a) || stable(b) - stable(a) || b.localeCompare(a, undefined, { numeric: true });
  });
  return pool[0] || null;
}

// 官方规定 Base64 视频必须小于 10MB；以十进制字节计，并将前缀计入限制。
const VIDEO_PREFIX = "data:;base64,";
export const MAX_INLINE_VIDEO_BYTES = 3 * Math.floor((10000000 - VIDEO_PREFIX.length - 1) / 4);
const MAX_UPLOAD_BYTES = 1000000000; // 临时上传官方总上限 1GB，另受凭证和模型上限约束。
function videoBytes(buf) {
  const bytes = buf instanceof ArrayBuffer ? new Uint8Array(buf)
    : ArrayBuffer.isView(buf) ? new Uint8Array(buf.buffer, buf.byteOffset, buf.byteLength) : null;
  if (!bytes || !bytes.byteLength) throw new Error("视频内容为空，本次未发送");
  return bytes;
}
export function inlineVideoPart(buf) {
  const bytes = videoBytes(buf);
  if (4 * Math.ceil(bytes.byteLength / 3) + VIDEO_PREFIX.length >= 10000000) {
    const e = new Error("视频超过千问 Base64 输入限制，必须通过临时存储上传");
    e.noRetry = true; throw e;
  }
  let binary = "";
  for (let i = 0; i < bytes.length; i += 0x8000) binary += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return { type: "video_url", video_url: { url: VIDEO_PREFIX + btoa(binary) } };
}
export function videoPart(buf) {
  // 保留完整内存字节，生成请求时按大小直传或按实际选中模型获取上传凭证。
  return { type: "local_video", bytes: videoBytes(buf) };
}

const OSS_REGIONS = ["cn-beijing", "ap-southeast-1", "us-east-1", "cn-hongkong", "ap-northeast-1", "eu-central-1"];
function validateUploadHost(value) {
  const url = new URL(value);
  const match = /^dashscope-file-[a-z0-9-]+\.oss-([a-z0-9-]+)\.aliyuncs\.com$/i.exec(url.hostname);
  // OSS 只收临时签名表单；拒绝接口返回的外域和重定向，绝不把百炼 Key 发给 OSS。
  if (url.protocol !== "https:" || !match || !OSS_REGIONS.includes(match[1]) || url.username || url.password
      || url.port || url.search || url.hash || url.pathname !== "/") throw new Error("百炼返回的临时上传地址不受支持");
  return url.origin;
}

function localError(message, code) {
  const e = new Error(message); e.code = code; e.noRetry = true; return e;
}
function friendlyError(err, stage = "analysis") {
  const text = String(err.message || ""), code = String(err.code || "");
  // 脱敏标记中的中文不代表原错误已本地化，不能因此把英文服务错误展示给用户。
  const localMessage = !err.status && /^[\u3400-\u9fff]/.test(text.replaceAll("[已隐藏]", ""));
  const timedOut = /timeout|timed out/i.test(text) || ["TimeoutError", "AbortError"].includes(err.name);
  let message;
  if (timedOut) {
    message = stage === "upload" ? "视频上传到百炼超时，请稍后重试" : "百炼分析超时，请稍后重试";
  } else if (err.status === 401 || /InvalidApiKey|InvalidAuthentication/i.test(code)) {
    message = stage === "upload" ? "视频上传到百炼失败：API Key 无效或未授权，请检查设置" : "百炼 API Key 无效或未授权，请检查设置";
  } else if (err.status === 429) message = "百炼请求过于频繁或额度不足，请稍后重试并检查额度";
  else if (err.status === 403) message = stage === "upload" ? "视频上传到百炼失败：没有上传权限或临时凭证已过期" : "百炼拒绝访问，请检查模型权限和服务地域";
  else if (err.status === 404 && /model/i.test(code + text)) message = "百炼模型不存在或没有访问权限，请重新检测模型";
  else if (stage === "upload") message = "视频上传到百炼失败" + (localMessage ? "：" + text : "，请检查服务地址或稍后重试");
  else if (localMessage) message = text;
  else message = "百炼分析失败，请检查所选模型和服务地址后重试";
  const e = new Error(message); e.status = err.status; e.code = err.code;
  e.noRetry = err.noRetry || timedOut; // 长超时已经等待充分，不自动重下重传，交由用户手动重试。
  e.stage = stage; // 保留失败发生于上传还是分析，供任务诊断使用。
  return e;
}

async function uploadVideo(bytes, apiKey, model, baseUrl) {
  const origin = new URL(baseUrl).origin;
  try {
    if (bytes.byteLength > MAX_UPLOAD_BYTES) throw localError("视频超过百炼临时存储的 1GB 上限", "FILE_TOO_LARGE");
    const policyResponse = await apiFetch(`${origin}/api/v1/uploads?action=getPolicy&model=${encodeURIComponent(model)}`, {
      headers: { "Content-Type": "application/json" }, signal: AbortSignal.timeout(30000)
    }, apiKey);
    const data = (await policyResponse.json()).data;
    const required = ["policy", "signature", "upload_dir", "upload_host", "oss_access_key_id", "x_oss_object_acl", "x_oss_forbid_overwrite"];
    if (!data || required.some((k) => typeof data[k] !== "string" || !data[k])) throw new Error("未取得完整的百炼上传凭证");
    const host = validateUploadHost(data.upload_host);
    if (!/^dashscope-instant\/[a-z0-9/_-]+$/i.test(data.upload_dir)) throw new Error("百炼返回的临时上传目录不符合预期");
    const limit = Number(data.max_file_size_mb);
    if (!Number.isFinite(limit) || limit <= 0) throw new Error("百炼没有返回有效的文件大小上限");
    if (bytes.byteLength > limit * 1000000) throw localError("视频超过所选模型允许的上传大小", "FILE_TOO_LARGE");
    const fileName = "style-lens-" + crypto.randomUUID() + ".mp4";
    const key = data.upload_dir.replace(/\/+$/, "") + "/" + fileName;
    const form = new FormData();
    form.append("OSSAccessKeyId", data.oss_access_key_id);
    form.append("Signature", data.signature);
    form.append("policy", data.policy);
    form.append("key", key);
    form.append("x-oss-object-acl", data.x_oss_object_acl);
    form.append("x-oss-forbid-overwrite", data.x_oss_forbid_overwrite);
    form.append("success_action_status", "200");
    // file 必须是最后一个字段，Content-Type 边界交给浏览器自动生成。
    form.append("file", new Blob([bytes], { type: "video/mp4" }), fileName);
    const res = await fetch(host, { method: "POST", body: form, credentials: "omit", redirect: "error", signal: AbortSignal.timeout(180000) });
    if (!res.ok) { const e = new Error("OSS 上传失败"); e.status = res.status; throw e; }
    return { type: "video_url", video_url: { url: "oss://" + key } };
  } catch (err) { err.stage = "upload"; throw err; }
}

async function prepareParts(parts, settings) {
  const content = [];
  for (const part of parts) {
    if (part.type === "local_video") {
      // 小视频按用户选择优先直传，省去先等临时上传超时；超限视频仍必须完整上传。
      if (part.bytes.byteLength <= MAX_INLINE_VIDEO_BYTES) content.push(inlineVideoPart(part.bytes));
      else content.push(await uploadVideo(part.bytes, settings.apiKey, settings.model, settings.baseUrl));
    } else if (part.type === "video_url") {
      // 禁止把 X CDN 或其他公网视频地址交给百炼二次下载。
      const url = part.video_url?.url || "";
      if (!url.startsWith("oss://dashscope-instant/") && !url.startsWith(VIDEO_PREFIX)) throw new Error("视频必须先下载并上传到百炼");
      content.push(part);
    } else content.push(part.type ? part : { type: "text", text: part.text });
  }
  return content;
}

function textContent(content) {
  if (typeof content === "string") return content;
  return Array.isArray(content) ? content.filter((p) => p.type === "text").map((p) => p.text || "").join("") : "";
}

function checkFinish(reason) {
  if (reason && reason !== "stop") throw new Error("千问未完整返回结果（结束原因：" + reason + "）");
}

async function extractText(res) {
  if (!(res.headers.get("content-type") || "").includes("text/event-stream")) {
    const j = await res.json();
    if (j.error) throw new Error(j.error.message || "千问返回错误");
    const c = j.choices?.[0];
    checkFinish(c?.finish_reason);
    const text = textContent(c?.message?.content);
    if (!text) throw new Error("千问没有返回分析文本");
    return text;
  }
  // Omni 旧型号仅支持流式输出；逐事件解码，忽略思考内容和用量事件。
  const reader = res.body.getReader(), decoder = new TextDecoder();
  let buffer = "", text = "", finished = false, terminal = false;
  const consume = (event) => {
    const data = event.split(/\r?\n/).filter((l) => l.startsWith("data:")).map((l) => l.slice(5).trimStart()).join("\n");
    if (!data) return;
    if (data.trim() === "[DONE]") { finished = true; terminal = true; return; }
    const j = JSON.parse(data);
    if (j.error) throw new Error(j.error.message || "千问返回错误");
    const c = j.choices?.[0];
    if (!c) return;
    checkFinish(c.finish_reason);
    if (c.finish_reason === "stop") finished = true;
    text += textContent(c.delta?.content);
    if (text.length > 4 * 1024 * 1024) throw new Error("千问返回结果过长");
  };
  try {
    for (;;) {
      const { done, value } = await reader.read();
      buffer += done ? decoder.decode() : decoder.decode(value, { stream: true });
      let match;
      while ((match = /\r?\n\r?\n/.exec(buffer))) {
        consume(buffer.slice(0, match.index));
        buffer = buffer.slice(match.index + match[0].length);
        if (terminal) break;
      }
      // 服务已明确结束时立即释放连接，避免代理保持长连接让完整结果继续等待。
      if (terminal || done) break;
    }
    if (!terminal && buffer.trim()) consume(buffer);
    if (!finished || !text.trim()) throw new Error("千问返回中断或没有分析文本，本次结果未保存");
    return text;
  } finally {
    // 完整结束后清理连接不应阻塞保存；代理或流分支可能迟迟不确认取消。
    reader.cancel().catch(() => {}); reader.releaseLock();
  }
}

export function parseJSON(text) {
  const t = text.trim().replace(/^```(?:json)?\s*/i, "").replace(/```\s*$/, "");
  try { return JSON.parse(t); } catch (_) {}
  const s = t.indexOf("{"), e = t.lastIndexOf("}");
  if (s >= 0 && e > s) return JSON.parse(t.slice(s, e + 1));
  throw new Error("千问返回的不是有效 JSON");
}

async function requestText(url, options, apiKey) {
  const controller = new AbortController();
  const timeout = () => controller.abort(new DOMException("Analysis request timed out", "TimeoutError"));
  let timer = setTimeout(timeout, 180000);
  try {
    const response = await apiFetch(url, { ...options, signal: controller.signal }, apiKey);
    // 上传及首响应可能已用掉大半预算，正文生成单独计时，避免正常输出在总三分钟处被截断。
    clearTimeout(timer);
    timer = setTimeout(timeout, 180000);
    return await extractText(response);
  } finally { clearTimeout(timer); }
}

export async function generate(parts, { json = true, schema = null, validate = null } = {}) {
  let { apiKey, model, baseUrl } = await getSettings();
  if (!apiKey) throw new Error("还没有填写千问 API Key，请在插件设置页填写");
  let jsonMode = json, switchedModel = false, preparedModel = null, content = null, repaired = false, correction = "";
  for (let attempt = 0; attempt < 4; attempt++) {
    try {
      if (preparedModel !== model) {
        content = await prepareParts(parts, { apiKey, model, baseUrl });
        // Omni 不支持 JSON Schema 参数：由提示词规定结构，再在客户端校验。
        if (json) content.push({ type: "text", text: "只输出一个完整 JSON 对象，不要 Markdown 或其他说明。"
          + (schema ? "\n遵循以下 JSON Schema（看不到视频时仅返回 {\"video_visible\":false}）：\n" + JSON.stringify(schema) : "") });
        preparedModel = model;
      }
      const requestContent = correction ? [...content, { type: "text", text: correction }] : content;
      const body = { model, messages: [{ role: "user", content: requestContent }], stream: true, modalities: ["text"] };
      if (/^qwen3\.8-omni-/i.test(model)) body.reasoning_effort = "none";
      else body.enable_thinking = false;
      if (jsonMode) body.response_format = { type: "json_object" };
      const headers = { "Content-Type": "application/json" };
      // 临时 OSS 地址必须开启解析；上传与分析始终使用同一账号和模型。
      if (content.some((p) => p.type === "video_url" && p.video_url.url.startsWith("oss://"))) headers["X-DashScope-OssResourceResolve"] = "enable";
      const text = await requestText(baseUrl + "/chat/completions", {
        method: "POST", headers, body: JSON.stringify(body)
      }, apiKey);
      if (validate) validate(text);
      return text;
    } catch (err) {
      // DOMException.message 是只读属性，脱敏必须复制错误，避免超时处理反而抛 TypeError。
      const original = err;
      err = new Error(String(original?.message || original || "").replaceAll(apiKey, "[已隐藏]"));
      for (const key of ["name", "status", "code", "stage", "noRetry", "issues"]) {
        if (original?.[key] !== undefined) err[key] = original[key];
      }
      if (err.stage === "validation" && Array.isArray(err.issues) && err.issues.length && !repaired) {
        // 结构残缺时仅重看同一视频一次，复用已上传媒体，避免重下重传再等几分钟。
        repaired = true;
        correction = "上次结果未通过完整性检查，以下字段缺失或不符合结构：" + err.issues.slice(0, 30).join("、")
          + "。请重新观看并收听同一附带视频，按完整结构重新输出整个 JSON，不只输出补丁。"
          + "时间用 JSON 数字，所有镜头都要有画面、动作方向、运镜和声音。不要编造未观察到的内容；看不到视频仍返回 {\"video_visible\":false}。";
        continue;
      }
      const modelMissing = err.status === 404 && /model/i.test(String(err.code) + " " + err.message);
      if (modelMissing && !switchedModel) {
        try {
          const picked = pickVideoModel((await listModels(apiKey, baseUrl)).filter((m) => m !== model));
          if (!picked) throw new Error("没有找到其他可用的千问 Omni 视频模型，请检查模型权限");
          model = picked; switchedModel = true;
          await chrome.storage.local.set({ qwenModel: model });
          // 大文件与模型绑定：换模型后 prepareParts 会重新取凭证并上传。
          continue;
        } catch (lookupErr) { throw friendlyError(lookupErr, "analysis"); }
      }
      if (err.stage !== "upload" && err.status === 400 && jsonMode && /response_format|json.?object|structured/i.test(err.message)) {
        jsonMode = false; continue;
      }
      throw friendlyError(err, err.stage || "analysis");
    }
  }
  throw new Error("千问兼容重试次数已用尽");
}

// ---------- 视频分析的提示词与结构（与 Gemini 共用） ----------
export { analysisPrompt } from "./prompt.js";
export const analysisSchema = toJsonSchema(baseSchema);
