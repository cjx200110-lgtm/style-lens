import { formatTaskError } from "./errors.js";
import { analysisIssues, validationError, normalizeAnalysis } from "./analysis-validation.js";
import * as qwen from "./qwen.js";
import * as gemini from "./gemini.js";
import { shotPlan, metaPrompt, shotsPrompt, metaSchema, shotsSchema, toGeminiSchema, proofShotsPrompt, proofStylePrompt, STYLE_GUIDE_KEYS } from "./prompt.js";

export async function getProvider() {
  const { provider = "qwen" } = await chrome.storage.local.get("provider");
  return provider === "gemini" ? "gemini" : "qwen";
}
export async function getGeminiEndpoint() {
  const { geminiEndpoint } = await chrome.storage.local.get("geminiEndpoint");
  return geminiEndpoint === "micu" ? "micu" : geminiEndpoint === "atlas" ? "atlas" : "google";
}
export async function hasProviderKey(provider, endpoint) {
  // 按明确来源取 Key，米醋未配置时不能借用 Google 官方凭据。
  const ep = provider === "gemini" ? (endpoint || await getGeminiEndpoint()) : null;
  const key = provider === "gemini" ? ep === "micu" ? "micuApiKey" : ep === "atlas" ? "atlasApiKey" : "apiKey" : "qwenApiKey";
  const s = await chrome.storage.local.get(key);
  return !!(s[key] || "").trim();
}
// 用量换算成钱：Atlas 上 Gemini 3.8 Flash（拆解、校对用的模型）每百万 tokens 输入 $0.75、输出（含思考）$3.75（2026-10 页面价格）
const USD_CNY = 7.1, PRICE_IN = 0.75, PRICE_OUT = 3.75;
export function usageCost(usage) {
  if (!usage || !(usage.in || usage.out)) return null;
  const usd = ((usage.in || 0) * PRICE_IN + (usage.out || 0) * PRICE_OUT) / 1e6;
  return { in: usage.in || 0, out: usage.out || 0, calls: usage.calls || 0, usd: Math.round(usd * 10000) / 10000, cny: Math.round(usd * USD_CNY * 100) / 100 };
}
// ---------- 用截好的清晰关键帧校对拆解结果 ----------
// shotFrames：[[{t, kind, blob}]]（每个镜头的关键帧）；styleFrames：[{t, blob}]（整条视频均匀截的图，只收藏风格时用）
// 返回 { shots: [{visual, action, camera, light}] | null, style: {...} | null, changes: [...], cost }
async function imagePart(blob) {
  const buf = new Uint8Array(await blob.arrayBuffer());
  let bin = ""; for (let i = 0; i < buf.length; i += 0x8000) bin += String.fromCharCode(...buf.subarray(i, i + 0x8000));
  return { inline_data: { mime_type: blob.type || "image/jpeg", data: btoa(bin) } };
}
const fmtT = (t) => (Math.round(t * 10) / 10).toString();
// 图片用中等画质（每张约 560 tokens）就够看清，思考调到“中”
const IMG_OPTS = { mediaRes: "MEDIA_RESOLUTION_MEDIUM", thinkingLevel: "medium" };
export async function proofread(result, { shotFrames = null, styleFrames = null } = {}) {
  const endpoint = await getGeminiEndpoint();
  const usage = {};
  const changes = [];
  const ask = async (parts) => parseJSON(await gemini.generate(parts, { json: true, endpoint, usage, ...IMG_OPTS }));
  // 镜头：每个镜头取首帧、中间、尾帧最多 3 张；每次最多 8 个镜头（约 24 张图），几批同时进行
  let shots = null;
  const rs = result.shots || [];
  if (shotFrames && rs.length) {
    const picksOf = (fr) => { if (fr.length <= 3) return fr; return [fr[0], fr[Math.floor(fr.length / 2)], fr[fr.length - 1]]; };
    const batches = []; for (let i = 0; i < rs.length; i += 8) batches.push([i, Math.min(rs.length, i + 8)]);
    const outs = await Promise.all(batches.map(async ([a, b]) => {
      const parts = [];
      for (let i = a; i < b; i++) for (const f of picksOf(shotFrames[i] || [])) { parts.push({ text: `【镜头${i + 1} · 第 ${fmtT(f.t)} 秒 · ${f.kind}】` }, await imagePart(f.blob)); }
      if (!parts.length) return [];
      const desc = rs.slice(a, b).map((s, k) => ({ n: a + k + 1, start: s.start, end: s.end, visual: s.visual, action: s.action, camera: s.camera, light: s.light }));
      parts.push({ text: proofShotsPrompt(desc) });
      try { const j = await ask(parts); return Array.isArray(j.shots) ? j.shots : []; }
      catch (e) { console.warn("镜头校对失败（这一批保持原样）", e); return []; }
    }));
    const byN = new Map(outs.flat().map((x) => [Number(x.n), x]));
    shots = rs.map((s, i) => {
      const x = byN.get(i + 1); if (!x) return null;
      const pick = (k) => (typeof x[k] === "string" && x[k].trim() ? x[k].trim() : s[k]);
      const out = { visual: pick("visual"), action: pick("action"), camera: pick("camera"), light: pick("light") };
      if (x.changed && String(x.changed).trim()) changes.push(`镜头${i + 1}：${String(x.changed).trim()}`);
      return out;
    });
    if (shots.every((x) => !x)) shots = null;
  }
  // 风格：从全片均匀挑最多 12 张
  let style = null;
  const pool = styleFrames && styleFrames.length ? styleFrames : (shotFrames || []).flat().sort((x, y) => x.t - y.t);
  if (pool.length) {
    const n = Math.min(12, pool.length);
    const pick = Array.from({ length: n }, (_, k) => pool[Math.round((k * (pool.length - 1)) / Math.max(1, n - 1))]);
    const parts = [];
    for (const f of pick) parts.push({ text: `【第 ${fmtT(f.t)} 秒】` }, await imagePart(f.blob));
    const cur = { style_guide: result.style_guide || {}, style_template_zh: result.style_template_zh || "", style_template_en: result.style_template_en || "", style_prompt_zh: result.style_prompt_zh || "" };
    parts.push({ text: proofStylePrompt(cur) });
    try {
      const j = await ask(parts);
      const guide = { ...(result.style_guide || {}) };
      for (const [k] of STYLE_GUIDE_KEYS) { const v = j.style_guide && j.style_guide[k]; if (typeof v === "string" && v.trim()) guide[k] = v.trim(); }
      const str = (k) => (typeof j[k] === "string" && j[k].trim() ? j[k].trim() : result[k]);
      style = { style_guide: guide, style_template_zh: str("style_template_zh"), style_template_en: str("style_template_en"), style_prompt_zh: str("style_prompt_zh") };
      for (const c of Array.isArray(j.changes) ? j.changes : []) if (String(c).trim()) changes.push("风格：" + String(c).trim());
    } catch (e) { console.warn("风格校对失败（保持原样）", e); }
  }
  if (!shots && !style) throw new Error("校对没有成功，保持原来的描述");
  return { shots, style, changes, cost: usageCost(usage) };
}
export function parseJSON(text) {
  try { return qwen.parseJSON(text); }
  catch (_) { throw new Error("模型返回的不是有效 JSON，本次结果未保存"); }
}
export async function analyzeVideo(buf, ctx, provider, endpoint) {
  provider = provider || await getProvider();
  const adapter = provider === "gemini" ? gemini : qwen;
  const settings = await adapter.getSettings(provider === "gemini" ? endpoint : undefined);
  if (!settings.apiKey) throw new Error("请先在设置页填写" + (provider === "gemini" ? " Gemini" : "千问") + " API Key");
  // 两套传输方式独立：Gemini 保持原内联/Files，千问小视频直传、大视频 OSS。
  let part;
  // Atlas：先直接给视频网址（快）；它取不到时再退回上传视频文件
  const viaUrl = provider === "gemini" && settings.endpoint === "atlas" && /^https:\/\/video\.twimg\.com\//.test(ctx?.videoUrl || "");
  try { part = viaUrl ? gemini.urlVideoPart(ctx.videoUrl) : provider === "gemini" ? await gemini.videoPart(settings.apiKey, buf, "video/mp4", settings.endpoint) : qwen.videoPart(buf); }
  catch (err) {
    // Gemini 协议不变，仅在适配边界保留上传阶段并给出中文原因。
    const e = new Error(formatTaskError(err, { stage: "upload", provider }));
    e.stage = "upload"; e.status = err.status; e.noRetry = err.noRetry; throw e;
  }
  // 千问只有 JSON 格式约束；结构缺项在同次调用内修正一次，复用已上传视频。
  const validate = provider === "qwen" ? text => {
    let result;
    try { result = parseJSON(text); }
    catch (err) { err.stage = "validation"; err.noRetry = true; throw err; }
    const blind = /没有(收到|附带|看到).{0,4}视频|无法(查看|看到|观看).{0,6}(视频|画面)/.test(text);
    if (result?.video_visible !== true || blind) return; // 不能通过重试把没看到视频的回答改成成功。
    const issues = analysisIssues(normalizeAnalysis(result));
    if (issues.length) throw validationError(issues);
  } : null;
  // 直接上传视频的写法（只算一次）：Atlas 取不到网址时用，请求卡住时的备用请求也用它
  let inlineP = null;
  const inlinePart = () => inlineP || (inlineP = (async () => {
    let data = buf;
    if (buf.byteLength > 13 * 1024 * 1024 && /^https:\/\/video\.twimg\.com\//.test(ctx.smallUrl || "")) {
      try { const r = await fetch(ctx.smallUrl); if (r.ok) data = await r.arrayBuffer(); } catch (_) {}
    }
    return gemini.videoPart(settings.apiKey, data, "video/mp4", settings.endpoint);
  })());
  if (provider === "gemini") ctx = { ...ctx, altPart: viaUrl ? inlinePart : async () => part };
  // Gemini：风格部分一份 + 镜头按时间分段，几份同时进行，总时间约等于最慢的那一份；精度不变（每份都完整看视频）
  const run = provider === "gemini" && ctx?.mode === "style" ? (pt) => styleOnly(pt, ctx, settings.endpoint)
    : provider === "gemini" && ctx?.mode === "shots" ? (pt) => shotsOnly(pt, ctx, settings.endpoint)
    : provider === "gemini" && ctx?.durationSec > 0 ? (pt) => splitAnalyze(pt, ctx, settings.endpoint)
    : (pt) => adapter.generate([pt, { text: adapter.analysisPrompt(ctx) }], { json: true, schema: adapter.analysisSchema, validate, endpoint: settings.endpoint });
  try {
    try { return await run(part); }
    catch (err) {
      if (!viaUrl || err.upstreamTimeout || err.name === "TimeoutError" || (err.status && err.status < 400) || err.status === 401) throw err;
      // Atlas 取不到视频网址：改为直接上传视频。视频太大时先换成低清晰度版本（只用于分析，不影响截图）
      let inline;
      try { inline = await inlinePart(); }
      catch (_) {
        const e = new Error("读取视频失败：中转站取不到视频网址（" + String(err.message || "").replace(/^Gemini ?/, "").slice(0, 80) + "），改为直接上传时视频又太大，请稍后重试");
        e.stage = "analysis"; e.status = err.status; e.noRetry = true; throw e;
      }
      return await run(inline);
    }
  }
  catch (err) {
    const stage = err.stage || "analysis";
    const e = new Error(formatTaskError(err, { stage, provider }));
    e.stage = stage; e.status = err.status; e.noRetry = err.noRetry; e.upstreamTimeout = err.upstreamTimeout; throw e;
  }
}
// role：plan（写方案、提炼风格卡、写报告、分组）用旗舰模型；check（检查画面）用最便宜的模型。只在 Atlas 方案下生效
export async function generate(parts, options = {}) {
  const provider = await getProvider();
  let opts = options;
  if (provider === "gemini" && options.role && await getGeminiEndpoint() === "atlas") opts = { ...options, model: gemini.ATLAS_MODELS[options.role] };
  // 审美报告也经过统一错误边界，避免 Gemini 断网时漏出原始英文。
  try { return await (provider === "gemini" ? gemini : qwen).generate(parts, opts); }
  catch (err) {
    const stage = err.stage || "analysis";
    const e = new Error(formatTaskError(err, { stage, provider }));
    e.stage = stage; e.status = err.status; e.noRetry = err.noRetry; throw e;
  }
}

// 最近一次 Gemini 请求各阶段耗时（秒），拆解成功后记到收藏里
export { getLastTiming } from "./gemini.js";

// 拆镜头时让模型每秒多看几帧（默认每秒 1 帧，切点只能估到大概）；接口不认这个参数时自动去掉
let noFps = false;
// 分段同时请求时，任何一份失败都会让整次拆解失败。所以每一份单独兜底：
// 空结果、返回的 JSON 不完整、中转站 5xx/429、网络中断 → 隔 3 秒只重做这一份，最多再试一次。
// Key 无效、余额不足、视频被拒这类重试也没用的错误直接抛出。
function retryable(e) {
  if (!e || e.status === 401 || e.status === 402 || e.status === 403 || e.fileRejected || e.thinkingRejected) return false;
  if (e.upstreamTimeout || e.name === "TimeoutError") return false; // 已经等了很久，再等用户受不了
  return e.emptyResult || e.stage === "validation" || e instanceof SyntaxError || !e.status || e.status === 429 || e.status >= 500;
}
async function once(fn) {
  try { return await fn(); }
  catch (e) {
    if (!retryable(e)) throw e;
    console.warn("分段请求失败，单独重试一次：", e.message);
    await new Promise((r) => setTimeout(r, 3000));
    return fn();
  }
}
const genJSON = (fn) => once(async () => parseJSON(await fn()));

// 请求卡住兜底：正常 10~20 秒就开始返回内容。60 秒还没开始输出，就补发一个相同的备用请求
// （视频改为直接上传，绕开中转站去 X 下载视频这一步），哪个先完成用哪个，另一个取消。
// 已经开始输出的请求不会补发，不影响精度；只有卡住时多花一次分析的钱。
const HEDGE_MS = 60000;
function hedged(part, ctx, mk) {
  const alt = ctx && ctx.altPart;
  if (!alt) return mk(part, {});
  return new Promise((resolve, reject) => {
    const ca = new AbortController(), cb = new AbortController();
    let first = false, bOn = false, done = false, aErr = null, bErr = null, aEnd = false, bEnd = false;
    const win = (v, other) => { if (done) return; done = true; clearTimeout(timer); other.abort(); resolve(v); };
    const lose = () => {
      if (done || !aEnd || (bOn && !bEnd)) return;
      done = true; clearTimeout(timer);
      const e = aErr || bErr;
      if (bOn && e && e.name === "TimeoutError") e.message += "（60 秒时已自动补发一个备用请求，也没有成功）";
      reject(e);
    };
    const timer = setTimeout(async () => {
      if (first || done || aEnd) return;
      bOn = true; console.warn("60 秒没有开始输出，补发一个备用请求");
      try { const pt = await alt(); mk(pt, { signal: cb.signal }).then((v) => win(v, ca), (e) => { bEnd = true; bErr = e; lose(); }); }
      catch (e) { bEnd = true; bErr = e; lose(); }
    }, HEDGE_MS);
    mk(part, { signal: ca.signal, onFirst: () => { first = true; } }).then((v) => win(v, cb), (e) => { aEnd = true; aErr = e; lose(); });
  });
}

// 看视频的设置：
// - 写风格（1 个请求）：每帧用高画质看（细线、小字、纸张质地看得清），思考调到“中”——风格是核心资产，精度优先
// - 拆镜头（几个请求、每秒 3 帧，最贵）：默认画质、思考“低”；认错、编造的东西由截好图后的“截图校对”纠正
// 用量都记到 ctx.usage
const STYLE_OPTS = { mediaRes: "MEDIA_RESOLUTION_HIGH", thinkingLevel: "medium" };
const SHOT_OPTS = { mediaRes: null, thinkingLevel: "low" };
// 每秒看几帧：60 秒内 3 帧，3 分钟内 2 帧，更长 1 帧；接口不认这个参数时自动去掉
async function askVideo(part, prompt, schema, ctx, endpoint, opts, o = {}) {
  const d = Number(ctx.durationSec) || 30;
  const fps = d <= 60 ? 3 : d <= 180 ? 2 : 1;
  const run = (pt) => gemini.generate([pt, { text: prompt }], { json: true, schema: toGeminiSchema(schema), endpoint, ...opts, usage: ctx.usage, ...o });
  if (noFps || fps === 1) return run(part);
  try { return await run({ ...part, video_metadata: { fps } }); }
  catch (e) { if (e.status === 400 && !e.fileRejected && !e.mediaResRejected && !e.thinkingRejected) { noFps = true; return run(part); } throw e; }
}
const genShots = (part, ctx, a, b, max, total, parts, endpoint, o = {}) => askVideo(part, shotsPrompt(ctx, a, b, max, total, parts), shotsSchema, ctx, endpoint, SHOT_OPTS, o);
const genMeta = (part, ctx, endpoint, o = {}) => askVideo(part, metaPrompt(ctx), metaSchema, ctx, endpoint, STYLE_OPTS, o);
async function splitAnalyze(part, ctx, endpoint) {
  const plan = shotPlan(ctx.durationSec);
  const total = Math.round(ctx.durationSec * 10) / 10;
  const jobs = [genJSON(() => hedged(part, ctx, (pt, o) => genMeta(pt, ctx, endpoint, o)))]
    .concat(plan.ranges.map(([a, b]) => genJSON(() => hedged(part, ctx, (pt, o) => genShots(pt, ctx, a, b, plan.perPart, total, plan.ranges.length, endpoint, o)))));
  const [meta, ...shotParts] = await Promise.all(jobs);
  const visible = meta.video_visible === true && shotParts.some((x) => x && x.video_visible === true);
  const shots = shotParts.flatMap((x) => (Array.isArray(x && x.shots) ? x.shots : []));
  return JSON.stringify({ ...meta, video_visible: visible, duration_sec: meta.duration_sec || total, shots, ...(plan.long ? { long_video: true } : {}) });
}

// 只收藏风格：只写风格部分（标题、风格配方、声音、模板、标签），不做逐镜头拆解，最快
async function styleOnly(part, ctx, endpoint) {
  const meta = await genJSON(() => hedged(part, ctx, (pt, o) => genMeta(pt, ctx, endpoint, o)));
  return JSON.stringify({ ...meta, duration_sec: meta.duration_sec || Math.round((ctx.durationSec || 0) * 10) / 10, shots: [], style_only: true });
}
// 给已收藏风格的视频补做逐镜头拆解（按时间分段同时进行）
async function shotsOnly(part, ctx, endpoint) {
  const plan = shotPlan(ctx.durationSec || 30);
  const total = Math.round((ctx.durationSec || 30) * 10) / 10;
  const outs = await Promise.all(plan.ranges.map(([a, b]) => genJSON(() => hedged(part, ctx, (pt, o) => genShots(pt, ctx, a, b, plan.perPart, total, plan.ranges.length, endpoint, o)))));
  return JSON.stringify({ video_visible: outs.some((x) => x && x.video_visible === true), shots: outs.flatMap((x) => (Array.isArray(x && x.shots) ? x.shots : [])), ...(plan.long ? { long_video: true } : {}) });
}
