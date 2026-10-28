import { DIMENSIONS } from "./vocab.js";
import { STYLE_GUIDE_KEYS, AUDIO_KEYS } from "./prompt.js";

// v0.4 起：模型的小毛病（某个镜头结束时间写错、标签不在词表里、少一个字段）由本地自动修正，
// 只有“没看到视频 / 没有任何镜头”这类根本性问题才判定失败。
// 之前任何一处小瑕疵都会让整次分析作废，是“经常分析失败”的主要原因之一。

export const REQUIRED_ANALYSIS_FIELDS = Object.freeze(["video_visible", "summary", "shots", "prompt_zh"]);

const FIELD_LABELS = Object.freeze({
  result: "完整分析结果", video_visible: "视频画面可见确认", summary: "视频摘要", shots: "镜头列表", prompt_zh: "复刻提示词"
});
const SHOT_LABELS = Object.freeze({ start: "开始时间", end: "结束时间", visual: "画面" });

function issueForPath(path) {
  if (typeof path !== "string") return null;
  if (Object.hasOwn(FIELD_LABELS, path)) return { path, label: FIELD_LABELS[path] };
  const match = /^shots\.(0|[1-9]\d*)(?:\.(start|end|visual))?$/.exec(path);
  if (!match) return null;
  return { path, label: "第 " + (Number(match[1]) + 1) + " 镜头" + (match[2] ? SHOT_LABELS[match[2]] : "内容") };
}

const round1 = (n) => Math.round(n * 10) / 10;
function num(v) {
  if (typeof v === "number") return v;
  if (typeof v !== "string") return NaN;
  // 兼容 "1.5s"、"00:03.5"、"3秒"
  const t = v.trim();
  const mmss = /^(\d+):(\d+(?:\.\d+)?)$/.exec(t);
  if (mmss) return Number(mmss[1]) * 60 + Number(mmss[2]);
  const m = /-?\d+(?:\.\d+)?/.exec(t);
  return m ? Number(m[0]) : NaN;
}
function str(v) {
  if (v === null || v === undefined) return "";
  if (Array.isArray(v)) return v.map(str).filter(Boolean).join("，");
  if (typeof v === "object") return "";
  return String(v).trim();
}

// 用分镜在本地拼出“完整复刻提示词”，不再占用模型输出
export function buildReplicaPrompt(r) {
  const lines = (r.shots || []).map((s) => {
    const parts = [s.visual, s.action && s.action !== "静止" ? s.action : "", s.camera, s.light].filter(Boolean);
    return `${s.start.toFixed(1)}-${s.end.toFixed(1)}s：${parts.join("，")}。`;
  });
  const sound = r.soundtrack || "";
  if (sound) lines.push("配乐与音效：" + sound);
  return lines.join("\n");
}

function matchVocab(values, raw) {
  const v = str(raw);
  if (!v) return undefined;
  if (values.includes(v)) return v;
  const hit = values.find((x) => v.includes(x) || x.includes(v)) || values.find((x) => x.split("/").some((p) => p && v.includes(p)));
  return hit;
}

export function normalizeAnalysis(r) {
  if (!r || typeof r !== "object" || Array.isArray(r)) return r;
  if (r.video_visible === "true") r.video_visible = true;
  if (r.video_visible === "false") r.video_visible = false;

  // 镜头：转数字、排序、修正起止时间
  let shots = Array.isArray(r.shots) ? r.shots.filter((s) => s && typeof s === "object") : [];
  shots = shots.map((s) => ({
    start: num(s.start), end: num(s.end),
    visual: str(s.visual), action: str(s.action), camera: str(s.camera), light: str(s.light), audio: str(s.audio),
    ...(Number(s.merged) > 1 ? { merged: Math.round(Number(s.merged)) } : {})
  })).filter((s) => s.visual || s.action);
  let prevEnd = 0;
  for (const s of shots) {
    if (!Number.isFinite(s.start) || s.start < 0) s.start = prevEnd;
    if (Number.isFinite(s.end) && s.end > s.start) prevEnd = s.end;
  }
  shots.sort((a, b) => a.start - b.start);
  let dur = num(r.duration_sec);
  shots.forEach((s, i) => {
    const next = shots[i + 1];
    if (!(Number.isFinite(s.end) && s.end > s.start)) {
      s.end = next && next.start > s.start ? next.start : Number.isFinite(dur) && dur > s.start ? dur : s.start + 0.5;
    }
    s.start = round1(s.start); s.end = round1(s.end);
    if (!(s.end > s.start)) s.end = round1(s.start + 0.1);
    if (!s.visual) s.visual = s.action;
    if (!s.action) s.action = "静止";
    if (!s.camera) s.camera = "未说明";
    if (!s.audio) s.audio = "未说明";
  });
  r.shots = shots;
  const lastEnd = shots.length ? shots[shots.length - 1].end : 0;
  r.duration_sec = round1(Number.isFinite(dur) && dur > 0 ? dur : lastEnd);

  // 画幅
  const a = str(r.aspect);
  r.aspect = ["竖屏", "横屏", "方形"].includes(a) ? a
    : /竖|9[:：]16|portrait|vertical/i.test(a) ? "竖屏"
    : /方|1[:：]1|square/i.test(a) ? "方形"
    : /横|16[:：]9|landscape|horizontal/i.test(a) ? "横屏" : "横屏";

  // 作者公开信息
  const ad = r.author_disclosed && typeof r.author_disclosed === "object" ? r.author_disclosed : {};
  const tools = Array.isArray(ad.tools) ? ad.tools.map(str).filter(Boolean) : str(ad.tools) ? [str(ad.tools)] : [];
  const prompt = str(ad.prompt);
  r.author_disclosed = { found: ad.found === true || ad.found === "true" ? true : false, tools, prompt };

  // 风格标签：不在词表里的尽量就近匹配，匹配不上就留空（不再因此整条作废）
  const st = r.style_tags && typeof r.style_tags === "object" ? r.style_tags : {};
  const tags = {};
  for (const d of DIMENSIONS) { const v = matchVocab(d.values, st[d.key]); if (v) tags[d.key] = v; }
  r.style_tags = tags;

  // 风格配方
  const sg = r.style_guide && typeof r.style_guide === "object" ? r.style_guide : {};
  const guide = {};
  for (const [k] of STYLE_GUIDE_KEYS) { const v = str(sg[k]); if (v) guide[k] = v; }
  r.style_guide = guide;
  const ad2 = r.audio_detail && typeof r.audio_detail === "object" ? r.audio_detail : {};
  const audio = {};
  for (const [k] of AUDIO_KEYS) { const v = str(ad2[k]); if (v) audio[k] = v; }
  r.audio_detail = audio;
  for (const k of ["title", "summary", "soundtrack", "style_template_zh", "style_template_en", "style_prompt_zh", "creative_tag", "creative_point", "tool_guess", "prompt_zh", "prompt_en"]) {
    r[k] = str(r[k]);
  }
  if (!r.summary && shots.length) r.summary = shots[0].visual.slice(0, 40);
  r.title = shortTitle(r.title || r.creative_tag || r.summary);
  if (!r.creative_tag) r.creative_tag = r.title;
  if (!r.style_prompt_zh) r.style_prompt_zh = [guide.medium, guide.color, guide.lighting, guide.editing].filter(Boolean).join("，");
  if (!r.prompt_zh) r.prompt_zh = shots.length ? buildReplicaPrompt(r) : r.style_template_zh;
  return r;
}

// 标题最多 14 个字，去掉“该视频/视频展示了”这类开头
export function shortTitle(text) {
  let t = str(text).replace(/^(该|这个|这条|本)?视频(通过|展示了?|呈现了?|讲述了?|是)?/, "").replace(/[。！!.]+$/, "");
  return t.length > 14 ? t.slice(0, 13) + "…" : t;
}

export function analysisIssues(result) {
  if (!result || typeof result !== "object") return [issueForPath("result")];
  const issues = [];
  const add = (path) => { issues.push(issueForPath(path)); };
  if (result.video_visible !== true) add("video_visible");
  if (!result.style_only && (!Array.isArray(result.shots) || !result.shots.length)) add("shots");
  if (!str(result.summary)) add("summary");
  if (!str(result.prompt_zh)) add("prompt_zh");
  return issues;
}

export function validationError(issues) {
  const safe = [], seen = new Set();
  for (const issue of Array.isArray(issues) ? issues : []) {
    const item = issueForPath(issue?.path);
    if (item && !seen.has(item.path)) { safe.push(item); seen.add(item.path); }
  }
  const detail = safe.slice(0, 3).map((item) => item.label).join("、");
  const error = new Error("模型返回的分析不完整" + (detail ? "：" + detail : "") + "，本次结果未保存");
  error.stage = "validation";
  error.noRetry = true;
  error.issues = safe.map((item) => item.path);
  return error;
}
