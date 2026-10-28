// 画分镜画面：按难度分三档。Atlas 方案用 Nano Banana（Edit），自定义方案沿用设置里的 Gemini 生图模型
import { atlas, toDataUrl, toJpeg, USD_CNY } from "./video.js";
import { generateImage as geminiImage } from "./gemini.js";

export const TIERS = ["low", "mid", "high"];
export const TIER_LABEL = { low: "低", mid: "中", high: "高" };
const ATLAS_IMG = {
  low: { model: "google/nano-banana-2.1-developer/edit", field: "reference_images", usd: 0.018 },
  mid: { model: "google/nano-banana-2.1/edit", field: "reference_images", usd: 0.04 },
  high: { model: "google/nano-banana-pro/edit", field: "images", usd: 0.14, resolution: "2k" }
};
// 没有任何参考图时用文生图，同样分三档
const ATLAS_T2I = {
  low: { model: "google/nano-banana-2.1-developer/text-to-image", usd: 0.018 },
  mid: { model: "google/nano-banana-2.1/text-to-image", usd: 0.04 },
  high: { model: "google/nano-banana-pro/text-to-image", usd: 0.14, resolution: "2k" }
};
const badModels = new Set(); // 名字不存在的模型（例如 Developer 版没开放）记住，之后直接换档

export async function getStack() {
  const s = await chrome.storage.local.get(["stack", "geminiEndpoint"]);
  return s.stack === "atlas" || s.geminiEndpoint === "atlas" ? "atlas" : "custom";
}
export async function getBudget() { const s = await chrome.storage.local.get("planBudget"); return Number(s.planBudget) || 30; }
// 每张图的预计价格（元）
export function imageCost(stack, tier) {
  if (stack !== "atlas") return 0.3;
  return (ATLAS_IMG[tier] || ATLAS_IMG.mid).usd * USD_CNY;
}
export const nextTier = (t) => (t === "low" ? "mid" : t === "mid" ? "high" : null);

async function blobFromOutput(out) {
  if (/^https?:\/\//.test(out)) { const r = await fetch(out, { credentials: "omit" }); if (!r.ok) throw new Error("画面下载失败"); return r.blob(); }
  const m = /^data:([^;,]+);base64,(.*)$/s.exec(out);
  const b64 = m ? m[2] : out, mime = m ? m[1] : (out.startsWith("/9j/") ? "image/jpeg" : "image/png");
  const bin = atob(b64); const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  return new Blob([bytes], { type: mime });
}

async function atlasImage({ images, prompt, aspect, tier }, key) {
  let t = tier;
  const table = images.length ? ATLAS_IMG : ATLAS_T2I;
  while (t && badModels.has(table[t].model)) t = t === "low" ? "mid" : null; // Developer 版不可用时用中档
  const cfg = table[t || "mid"];
  const refs = [];
  for (const b of images.slice(0, 10)) refs.push(await toDataUrl(await toJpeg(b)));
  const body = { model: cfg.model, prompt, aspect_ratio: aspect || "auto", resolution: cfg.resolution || "1k",
    enable_base64_output: true, enable_sync_mode: false, seed: -1 };
  if (images.length) body[cfg.field] = refs;
  let j;
  try { j = await atlas("/generateImage", { method: "POST", body: JSON.stringify(body) }, key); }
  catch (e) {
    if (e.status === 404 && t === "low") { badModels.add(cfg.model); return atlasImage({ images, prompt, aspect, tier: "mid" }, key); }
    if (e.status !== 400 || !images.length) throw e;
    body[cfg.field] = refs.map((u) => u.replace(/^data:[^,]+,/, "")); // 只收纯 base64 时换一种写法再试
    j = await atlas("/generateImage", { method: "POST", body: JSON.stringify(body) }, key);
  }
  const id = j?.data?.id;
  if (!id) throw new Error("Atlas 没有返回画面任务编号");
  const t0 = Date.now();
  for (;;) {
    await new Promise((r) => setTimeout(r, 2000));
    if (Date.now() - t0 > 5 * 60000) throw new Error("画面生成超过 5 分钟，请重试");
    const r = await atlas("/prediction/" + encodeURIComponent(id), { method: "GET" }, key);
    const st = r?.data?.status;
    if (st === "completed" || st === "succeeded") {
      const out = (r.data.outputs || [])[0];
      if (!out) throw new Error("没有返回画面");
      return { blob: await blobFromOutput(out), tier: t || "mid", model: cfg.model };
    }
    if (st === "failed") {
      const msg = String(r.data.error || "");
      throw new Error(/sensitive|moderat|policy|safety/i.test(msg) ? "画面触发了平台审核，换个描述再试" : "画面生成失败" + (msg ? "：" + msg.slice(0, 80) : ""));
    }
  }
}

async function partOf(blob) {
  const buf = new Uint8Array(await blob.arrayBuffer());
  let bin = ""; for (let i = 0; i < buf.length; i += 0x8000) bin += String.fromCharCode(...buf.subarray(i, i + 0x8000));
  return { inline_data: { mime_type: blob.type || "image/jpeg", data: btoa(bin) } };
}

// images：按提示词里“第1张、第2张…参考图”的顺序；返回 { blob, tier, model }
export async function makeImage({ images = [], prompt, aspect, tier = "mid" }) {
  if (await getStack() === "atlas") {
    const { atlasApiKey } = await chrome.storage.local.get("atlasApiKey");
    if (!(atlasApiKey || "").trim()) throw new Error("请先在设置页填写 Atlas Cloud 的 API Key");
    return atlasImage({ images, prompt, aspect, tier }, atlasApiKey.trim());
  }
  const parts = [];
  for (const b of images) parts.push(await partOf(b));
  parts.push({ text: prompt });
  const img = await geminiImage(parts, { aspect });
  return { blob: await blobFromOutput(img.data.startsWith("data:") ? img.data : `data:${img.mime};base64,${img.data}`), tier: "mid", model: "gemini" };
}
