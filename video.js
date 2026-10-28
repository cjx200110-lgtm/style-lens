// 视频生成：火山方舟 Seedance（即梦背后的视频模型）
// 流程：创建任务 → 每隔几秒查询 → 成功后下载视频（官方视频地址 24 小时后失效，所以下载到本机保存）
const ARK = "https://ark.cn-beijing.volces.com/api/v3";
export const DEFAULT_VIDEO_MODEL = "doubao-seedance-1-0-pro-fast-250528";
export const SUGGESTED_VIDEO_MODELS = ["doubao-seedance-1-0-pro-fast-250528", "doubao-seedance-1-0-pro-250528", "doubao-seedance-2-0-fast-260128", "doubao-seedance-2-0-mini-260615", "doubao-seedance-2-5-260628"];

// 各模型的时长范围与单价（元/百万 token，图生/文生视频）。来源：火山方舟文档（2026-10 询问）
// token = 时长 × 宽 × 高 × 24 / 1024
export function modelInfo(model) {
  const m = String(model || "");
  if (/seedance-2-5/.test(m)) return { min: 4, max: 30, price: { "480p": 70, "720p": 70, "1080p": 70 }, adaptiveOnly: true, audio: true };
  if (/seedance-2-0-fast/.test(m)) return { min: 4, max: 15, price: { "480p": 37, "720p": 37 }, audio: true };
  if (/seedance-2-0-mini/.test(m)) return { min: 4, max: 15, price: { "480p": 23, "720p": 23 }, audio: true };
  if (/seedance-2-0/.test(m)) return { min: 4, max: 15, price: { "480p": 46, "720p": 46, "1080p": 51 }, audio: true };
  // 1.0 系列：没有 200 元门槛，单价不分分辨率，最短 2 秒
  if (/seedance-1-0-pro-fast/.test(m)) return { min: 2, max: 12, price: { "480p": 4.2, "720p": 4.2, "1080p": 4.2 }, audio: false };
  if (/seedance-1-0-pro/.test(m)) return { min: 2, max: 12, price: { "480p": 15, "720p": 15, "1080p": 15 }, audio: false };
  if (/seedance-1-0/.test(m)) return { min: 2, max: 12, price: null, audio: false };
  return { min: 4, max: 12, price: null, audio: false };
}
const PIXELS = { "480p": 864 * 496, "720p": 1280 * 720, "1080p": 1920 * 1080 };
export function clipDuration(model, shotLen, minDur) {
  const info = modelInfo(model);
  return Math.min(info.max, Math.max(info.min, minDur || 0, Math.ceil(shotLen)));
}
// 估算费用（元）；不知道单价时返回 null
export function estimateCost(model, resolution, seconds) {
  const unit = modelInfo(model).price?.[resolution];
  if (!unit) return null;
  return (seconds * PIXELS[resolution] * 24 / 1024) * unit / 1e6;
}

export async function getVideoSettings() {
  const s = await chrome.storage.local.get(["arkApiKey", "videoModel", "videoResolution", "videoMinDur", "videoAudio"]);
  // 早期版本默认填了不存在的 seedance-1-5-pro，自动换成 1.0 Pro Fast
  const saved = (s.videoModel || "").trim();
  return { apiKey: (s.arkApiKey || "").trim(), model: !saved || /seedance-1-5/.test(saved) ? DEFAULT_VIDEO_MODEL : saved,
    resolution: s.videoResolution || "480p", minDur: Number(s.videoMinDur) || 0, audio: s.videoAudio === true };
}

function arkError(status, j) {
  const raw = String(j?.error?.message || j?.message || "");
  const code = String(j?.error?.code || "");
  const reason = status === 401 ? "火山方舟 API Key 无效，请在设置页检查"
    : status === 403 ? "没有这个模型的权限：请到火山方舟控制台“开通管理”里开通视频生成模型（2.0/2.5 要求账户余额大于 200 元或买了资源包；1.0 系列没有这个要求）"
    : status === 404 ? "模型名称不存在，请在设置页检查视频模型"
    : status === 429 ? "请求太频繁或额度不足，请稍后再试"
    : /SensitiveContent|sensitive/i.test(code + raw) ? "内容触发了平台审核，换一张图或改一下描述再试"
    : status === 400 ? "参数不被接受" + (/duration/i.test(raw) ? "（时长不支持）" : /ratio/i.test(raw) ? "（画幅不支持）" : /image/i.test(raw) ? "（首帧图片不符合要求）" : "")
    : "服务暂时不可用，请稍后再试";
  const e = new Error("视频生成失败（HTTP " + status + "）：" + reason);
  e.status = status; e.durationRejected = /duration/i.test(raw); e.raw = raw;
  return e;
}

async function ark(path, opts, apiKey) {
  const res = await fetch(ARK + path, { ...opts, credentials: "omit", redirect: "error",
    headers: { ...(opts.headers || {}), Authorization: "Bearer " + apiKey, "Content-Type": "application/json" } });
  let j = null; try { j = await res.json(); } catch (_) {}
  if (!res.ok) throw arkError(res.status, j);
  return j;
}

// shot: { prompt, imageBlob?, duration, ratio }；onStatus 用于显示进度
export async function generateClip({ prompt, imageBlob, duration, ratio }, onStatus, isStopped) {
  const { apiKey, model, resolution, minDur, audio } = await getVideoSettings();
  const info = modelInfo(model);
  if (!apiKey) throw new Error("生成视频要用火山方舟的 API Key，请先在设置页填写");
  const content = [{ type: "text", text: prompt }];
  if (imageBlob) content.push({ type: "image_url", image_url: { url: await toDataUrl(imageBlob) }, role: "first_frame" });
  let dur = clipDuration(model, duration, minDur);
  // fast / mini 不支持 1080p，自动降到 720p
  const res = resolution === "1080p" && info.price && !info.price["1080p"] ? "720p" : resolution;
  let task;
  for (let attempt = 0; attempt < 2; attempt++) {
    const body = { model, content, duration: dur, resolution: res, watermark: false };
    // 有首帧时画幅跟随图片（2.5 只允许 adaptive）；纯文字时用方案的画幅
    body.ratio = imageBlob ? "adaptive" : ratio;
    // 2.x 默认会生成声音；成片是按镜头截短再拼接的，默认关掉，避免声音被切得断断续续（有声无声同价）
    if (info.audio) body.generate_audio = audio;
    try { task = await ark("/contents/generations/tasks", { method: "POST", body: JSON.stringify(body) }, apiKey); break; }
    catch (e) { if (attempt === 0 && e.status === 400 && e.durationRejected && dur !== 5) { dur = 5; continue; }
      if (attempt === 0 && e.status === 400 && /generate_audio/i.test(e.raw || "")) { delete info.audio; continue; } throw e; }
  }
  return await waitTask(task, apiKey, onStatus, isStopped, dur);
}

async function waitTask(task, apiKey, onStatus, isStopped, dur) {
  if (!task || !task.id) throw new Error("没有拿到视频任务编号");
  onStatus && onStatus("已提交，排队中…");
  const started = Date.now();
  for (;;) {
    await new Promise((r) => setTimeout(r, 5000));
    if (isStopped && isStopped()) throw new Error("已停止（任务仍会在火山方舟后台完成）");
    if (Date.now() - started > 15 * 60000) throw new Error("等了 15 分钟还没生成好，请稍后在火山方舟控制台查看");
    const t = await ark("/contents/generations/tasks/" + encodeURIComponent(task.id), { method: "GET" }, apiKey);
    if (t.status === "succeeded") {
      const url = t.content && t.content.video_url;
      if (!url) throw new Error("任务成功但没有返回视频地址");
      onStatus && onStatus("生成好了，正在下载…");
      let blob = null;
      try { const r = await fetch(url, { credentials: "omit" }); if (r.ok) blob = await r.blob(); } catch (_) {}
      return { blob, url, duration: dur, taskId: task.id };
    }
    if (t.status === "failed" || t.status === "expired" || t.status === "cancelled") {
      const msg = String(t.error?.message || "");
      throw new Error(t.status === "expired" ? "任务超时过期了，请重试"
        : /sensitive/i.test(String(t.error?.code || "") + msg) ? "内容触发了平台审核，换一张图或改一下描述再试" : "视频生成失败，请重试");
    }
    const secs = Math.round((Date.now() - started) / 1000);
    onStatus && onStatus((t.status === "queued" ? "排队中" : "生成中") + `… 已等 ${secs} 秒`);
  }
}


export async function toDataUrl(blob) {
  const buf = new Uint8Array(await blob.arrayBuffer());
  let bin = ""; for (let i = 0; i < buf.length; i += 0x8000) bin += String.fromCharCode(...buf.subarray(i, i + 0x8000));
  return `data:${blob.type || "image/png"};base64,${btoa(bin)}`;
}

export async function testKey(apiKey) {
  // 查一个不存在的任务：Key 正确会返回 404/400，Key 错误返回 401
  try { await ark("/contents/generations/tasks/cgt-check", { method: "GET" }, apiKey); return true; }
  catch (e) { if (e.status === 401 || e.status === 403) throw e; return true; }
}

// ---------- 整片一次生成（Seedance 2.x 多图参考，声音整条一起生成） ----------
export const FILM_MODELS = [
  ["doubao-seedance-2-0-fast-260128", "2.0 Fast（推荐）"],
  ["doubao-seedance-2-0-mini-260615", "2.0 Mini（最便宜）"],
  ["doubao-seedance-2-0-260128", "2.0 标准版"],
  ["doubao-seedance-2-5-260628", "2.5（最好也最贵）"]
];
export function filmLimits(model) {
  if (/^bytedance\//.test(model)) return { maxDur: /seedance-2\.5/.test(model) ? 30 : 15, minDur: 4, maxImages: 9, is25: /seedance-2\.5/.test(model) };
  const is25 = /seedance-2-5/.test(model);
  return { maxDur: is25 ? 30 : 15, minDur: 4, maxImages: is25 ? 30 : 9, is25 };
}
// ---------- Atlas Cloud（中转，按秒计费，没有 200 元门槛） ----------
const ATLAS = "https://api.atlascloud.ai/api/v1/model";
export const ATLAS_FILM_MODELS = [
  ["auto", "自动（按难度选）"],
  ["bytedance/seedance-2.0-fast/reference-to-video", "2.0 Fast · 720p"],
  ["bytedance/seedance-2.0-mini/reference-to-video", "2.0 Mini · 720p（便宜）"],
  ["bytedance/seedance-2.5/reference-to-video", "2.5 · 先出草稿再转 1080p"]
];
export const ATLAS_25 = "bytedance/seedance-2.5/reference-to-video";
export const ATLAS_20F = "bytedance/seedance-2.0-fast/reference-to-video";
// 美元/秒（2026-10 Atlas 页面，已含 8 折）。2.5 草稿按页面起价估算，转正式版按 Draft Complete 价格
const ATLAS_PRICE = { "2.0-fast": { "480p": 0.072, "720p": 0.1548 }, "2.0-mini": { "480p": 0.045, "720p": 0.0968 }, "2.5-draft": 0.134, "2.5-complete": 0.263 };
export const USD_CNY = 7.1;
export function atlasCostUSD(model, resolution, seconds) {
  if (/seedance-2\.5/.test(model)) return ATLAS_PRICE[resolution === "complete" ? "2.5-complete" : "2.5-draft"] * seconds;
  const k = /2\.0-fast/.test(model) ? "2.0-fast" : /2\.0-mini/.test(model) ? "2.0-mini" : null;
  const unit = k && ATLAS_PRICE[k][resolution];
  return unit ? unit * seconds : null;
}
export async function getProvider() {
  const s = await chrome.storage.local.get(["videoProvider", "atlasApiKey"]);
  return { provider: s.videoProvider === "atlas" ? "atlas" : "ark", atlasKey: (s.atlasApiKey || "").trim() };
}
export async function atlas(path, opts, key) {
  const res = await fetch(ATLAS + path, { ...opts, credentials: "omit",
    headers: { ...(opts.headers || {}), Authorization: "Bearer " + key, "Content-Type": "application/json" } });
  let j = null; try { j = await res.json(); } catch (_) {}
  const raw = String(j?.message || j?.msg || j?.error || j?.data?.error || "");
  if (!res.ok || (j && j.code && j.code !== 200 && !j.data)) {
    const st = res.ok ? 400 : res.status;
    const e = new Error("Atlas Cloud 请求失败（HTTP " + st + "）：" + (st === 401 ? "API Key 无效，请在设置页检查"
      : st === 402 || /balance|insufficient|credit/i.test(raw) ? "余额不足，请到 Atlas Cloud 充值"
      : st === 429 ? "请求太频繁，请稍后再试" : st === 404 ? "模型名称不存在" : /sensitive|moderat|policy/i.test(raw) ? "内容触发了平台审核，换一张图或改一下描述再试"
      : st === 400 ? "参数不被接受" : "服务暂时不可用，请稍后再试"));
    e.status = st; e.raw = raw; throw e;
  }
  return j;
}
async function atlasPoll(id, key, onStatus, isStopped, dur) {
  const started = Date.now();
  for (;;) {
    await new Promise((r) => setTimeout(r, 4000));
    if (isStopped && isStopped()) throw new Error("已停止（任务仍会在后台完成）");
    if (Date.now() - started > 20 * 60000) throw new Error("等了 20 分钟还没生成好，请稍后到 Atlas Cloud 控制台查看");
    const t = await atlas("/prediction/" + encodeURIComponent(id), { method: "GET" }, key);
    const st = t?.data?.status;
    if (st === "completed" || st === "succeeded") {
      const url = (t.data.outputs || [])[0];
      if (!url) throw new Error("任务成功但没有返回视频地址");
      onStatus && onStatus("生成好了，正在下载…");
      let blob = null;
      try { const r = await fetch(url, { credentials: "omit" }); if (r.ok) blob = await r.blob(); } catch (_) {}
      return { blob, url, duration: dur, taskId: id };
    }
    if (st === "failed") {
      const msg = String(t.data.error || "");
      throw new Error(/sensitive|moderat|policy/i.test(msg) ? "内容触发了平台审核，换一张图或改一下描述再试" : "视频生成失败" + (msg ? "：" + msg.slice(0, 80) : "，请重试"));
    }
    onStatus && onStatus(`生成中… 已等 ${Math.round((Date.now() - started) / 1000)} 秒`);
  }
}
async function generateFilmAtlas({ model, resolution, audio, prompt, images, duration, ratio }, key, onStatus, isStopped) {
  const is25 = /seedance-2\.5/.test(model);
  const refs = [];
  for (const b of images.slice(0, 9)) refs.push(await toDataUrl(await toJpeg(b)));
  const dur = Math.min(is25 ? 30 : 15, Math.max(4, Math.round(duration)));
  // 一张参考图都没有时改用文生视频（同价），不需要传参考字段
  const t2v = !refs.length;
  const body = { model: t2v ? model.replace(/\/reference-to-video$/, "/text-to-video") : model, prompt, duration: dur, resolution: resolution === "complete" ? "720p" : resolution,
    ratio, generate_audio: audio !== false, seed: -1, watermark: false, return_last_frame: false };
  if (!t2v) Object.assign(body, { reference_images: refs, reference_videos: [], reference_audios: [] }, is25 ? {} : { bitrate_mode: "standard" });
  // 2.5 先出 480p 草稿，满意了再用 Draft Complete 转成 1080p 正式版（内容保持一致）
  if (is25) Object.assign(body, { draft: true, output_format: "mp4" }, t2v ? {} : { omni_reference_task_type: "reference" });
  onStatus && onStatus(is25 ? "正在提交草稿任务…" : "正在提交到 Atlas Cloud…");
  let j;
  try { j = await atlas("/generateVideo", { method: "POST", body: JSON.stringify(body) }, key); }
  catch (e) {
    // 有的接口只收纯 base64（不带 data: 前缀），参数被拒时换一种写法再试一次
    if (e.status !== 400 || t2v) throw e;
    body.reference_images = refs.map((u) => u.replace(/^data:[^,]+,/, ""));
    j = await atlas("/generateVideo", { method: "POST", body: JSON.stringify(body) }, key);
  }
  const id = j?.data?.id;
  if (!id) throw new Error("Atlas Cloud 没有返回任务编号");
  const out = await atlasPoll(id, key, onStatus, isStopped, dur);
  return { ...out, draft: is25 };
}
// 把 2.5 草稿转成 1080p 正式版
export async function completeDraft(draftId, onStatus) {
  const pv = await getProvider();
  if (!pv.atlasKey) throw new Error("请先在设置页填写 Atlas Cloud 的 API Key");
  onStatus && onStatus("正在提交正式版任务…");
  const j = await atlas("/generateVideo", { method: "POST", body: JSON.stringify({ model: "bytedance/seedance-2.5/draft-complete", draft_id: draftId, output_format: "mp4", watermark: false, return_last_frame: false }) }, pv.atlasKey);
  const id = j?.data?.id;
  if (!id) throw new Error("Atlas Cloud 没有返回任务编号");
  return atlasPoll(id, pv.atlasKey, onStatus, null, null);
}

// 把本机的视频传到 Atlas，换一个在线地址（原来的在线地址过期时用）
async function uploadAtlas(blob, key) {
  const fd = new FormData();
  fd.append("file", blob, "film.mp4");
  const res = await fetch(ATLAS + "/uploadMedia", { method: "POST", body: fd, credentials: "omit", headers: { Authorization: "Bearer " + key } });
  let j = null; try { j = await res.json(); } catch (_) {}
  const url = j && (j.url || j.data?.url || j.data?.download_url || j.data?.file_url);
  if (!res.ok || !url) throw new Error("上传原视频失败（HTTP " + res.status + "），请稍后再试");
  return url;
}
// 在已生成的视频上修改（edit）或往后延长（extend），用 Seedance 2.5。
// 先按 480p 草稿出（价格同 480p），满意可以和整片一样转 1080p；草稿不被接受时直接出 480p。
export const EDIT_MODEL = ATLAS_25;
export async function editFilm({ blob, url, fresh, mode, instruction, seconds, audio }, onStatus, isStopped) {
  const pv = await getProvider();
  if (!pv.atlasKey) throw new Error("请先在设置页填写 Atlas Cloud 的 API Key");
  let src = fresh ? url : null;
  if (!src) {
    if (!blob) throw new Error("原视频的在线地址已过期，本机也没有这版视频，没法修改");
    onStatus && onStatus("正在上传原视频…");
    src = await uploadAtlas(blob, pv.atlasKey);
  }
  const ext = mode === "extend";
  const ask = String(instruction || "").trim();
  const prompt = ext
    ? `接着 @Video1 的最后一个画面继续往后拍 ${seconds} 秒，人物、产品、画风、光线和配乐保持一致，衔接自然。${ask ? "后面的内容：" + ask : "顺着原来的动作和节奏自然发展。"}`
    : `修改 @Video1：${ask}。除了这里提到的地方，其他画面、镜头顺序、运镜节奏、人物和配乐尽量保持不变。`;
  const body = { model: EDIT_MODEL, prompt, reference_videos: [src], reference_images: [], reference_audios: [],
    omni_reference_task_type: ext ? "extend" : "edit", duration: ext ? Math.min(15, Math.max(4, Math.round(seconds))) : -1,
    ratio: "adaptive", resolution: "480p", output_format: "mp4", generate_audio: audio !== false, watermark: false, return_last_frame: false, draft: true };
  onStatus && onStatus(ext ? "正在提交延长任务…" : "正在提交修改任务…");
  let j, draft = true;
  try { j = await atlas("/generateVideo", { method: "POST", body: JSON.stringify(body) }, pv.atlasKey); }
  catch (e) {
    if (e.status !== 400) throw editError(e);
    delete body.draft; draft = false;
    try { j = await atlas("/generateVideo", { method: "POST", body: JSON.stringify(body) }, pv.atlasKey); }
    catch (e2) { throw editError(e2); }
  }
  const id = j?.data?.id;
  if (!id) throw new Error("Atlas Cloud 没有返回任务编号");
  const out = await atlasPoll(id, pv.atlasKey, onStatus, isStopped, null);
  return { ...out, draft };
}
function editError(e) {
  if (e.status === 400 && /duration|length|second/i.test(e.raw)) e.message = "原视频要在 4–30 秒之间才能修改";
  else if (e.status === 400 && /resolution|pixel|dimension|size/i.test(e.raw)) e.message = "原视频分辨率太低，模型不接受（方形 480p 草稿常见），先转成 1080p 正式版再修改";
  else if (e.status === 400 && e.raw) e.message += "（" + e.raw.slice(0, 80) + "）";
  return e;
}
export const editCostUSD = (seconds) => atlasCostUSD(ATLAS_25, "draft", seconds);

// images: [Blob]，按提示词里 @图像1、@图像2… 的顺序
export async function generateFilm({ model, resolution, audio, prompt, images, duration, ratio }, onStatus, isStopped) {
  const pv = await getProvider();
  if (pv.provider === "atlas") {
    if (!pv.atlasKey) throw new Error("请先在设置页填写 Atlas Cloud 的 API Key");
    return generateFilmAtlas({ model, resolution, audio, prompt, images, duration, ratio }, pv.atlasKey, onStatus, isStopped);
  }
  const { apiKey } = await getVideoSettings();
  if (!apiKey) throw new Error("生成视频要用火山方舟的 API Key，请先在设置页填写");
  const lim = filmLimits(model);
  const info = modelInfo(model);
  const content = [{ type: "text", text: prompt }];
  for (const b of images.slice(0, lim.maxImages)) content.push({ type: "image_url", image_url: { url: await toDataUrl(await toJpeg(b)) }, role: "reference_image" });
  const dur = Math.min(lim.maxDur, Math.max(lim.minDur, Math.round(duration)));
  const res = resolution === "1080p" && info.price && !info.price["1080p"] ? "720p" : resolution;
  const body = { model, content, duration: dur, resolution: res, ratio, watermark: false, generate_audio: audio !== false };
  if (lim.is25) body.omni_reference_task_type = "reference";
  onStatus && onStatus("正在提交整片任务…");
  const task = await ark("/contents/generations/tasks", { method: "POST", body: JSON.stringify(body) }, apiKey);
  return await waitTask(task, apiKey, onStatus, isStopped, dur);
}
// 参考图转成 JPEG、长边不超过 1600，控制请求体大小（总上限 64MB）
export async function toJpeg(blob) {
  try {
    const bmp = await createImageBitmap(blob);
    const k = Math.min(1, 1600 / Math.max(bmp.width, bmp.height));
    const c = document.createElement("canvas"); c.width = Math.round(bmp.width * k); c.height = Math.round(bmp.height * k);
    c.getContext("2d").drawImage(bmp, 0, 0, c.width, c.height);
    return await new Promise((r) => c.toBlob(r, "image/jpeg", 0.9));
  } catch (_) { return blob; }
}
