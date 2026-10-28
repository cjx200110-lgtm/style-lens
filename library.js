import { DIMENSIONS } from "./vocab.js";
import { generate, parseJSON } from "./ai.js";
import { makeImage, getStack, getBudget, imageCost, nextTier, TIER_LABEL } from "./imaging.js";
import { generateClip, getVideoSettings, clipDuration, estimateCost, modelInfo, generateFilm, filmLimits, FILM_MODELS, ATLAS_FILM_MODELS, atlasCostUSD, getProvider, USD_CNY, ATLAS_25, ATLAS_20F, completeDraft, editFilm, editCostUSD, toJpeg } from "./video.js";
import { STYLE_GUIDE_KEYS, AUDIO_KEYS, recipePrompt, translatePrompt, groupPrompt, planPrompt, CARD_KEYS, distillPrompt, cardPlanPrompt, rewritePrompt, paceRule } from "./prompt.js";
import { normalizeAnalysis, buildReplicaPrompt } from "./analysis-validation.js";
import { downloadVideo, scanKeyframes, shotTimes, makeZip, saveBlob, framesSig, shrink } from "./frames.js";
import { exportBackup, importBackup } from "./backup.js";
import { h, displayTitle, STATUS, loadAll, likeChips, copyButton, relTime, bg, toast, itemError, failureInfo } from "./ui.js";

const app = document.getElementById("app");
const REPORT_MIN = 10;
let data = { items: [], picks: {}, seen: {}, lastReport: null };
let ui = { q: "", filter: "all", lang: "zh", tlang: "zh", subject: "", preview: null };
let frameCache = {}; // 高还原复刻：每条收藏提取过的关键帧，只存在内存里（关掉页面就释放）
let player = { id: null, el: null }; // 详情页视频复用同一个元素，页面刷新时不会打断播放

const done = () => data.items.filter((x) => x.status === "done");
const sorted = (arr) => arr.slice().sort((a, b) => b.createdAt - a.createdAt);
const fmt = (n) => (typeof n === "number" ? (Math.round(n * 10) / 10).toString() : n || "");
const go = (hash) => { location.hash = hash; };

// ---------- 通用组件 ----------
function videoCard(x) {
  const r = x.result || {};
  const st = r.style_tags || {};
  const tags = ["medium", "color", "pace"].map((k) => st[k]).filter(Boolean);
  return h("div", { class: "vcard", onclick: () => go("item/" + x.id) },
    h("div", { class: "thumb", style: bg(r.thumb) }, r.thumb ? "" : (x.status === "done" ? "" : STATUS[x.status])),
    h("div", { class: "body" },
      x.status === "done" ? h("div", { class: "vtitle" }, displayTitle(x)) : null,
      h("div", { class: "clamp2 muted" }, r.summary || (x.status === "failed" ? "拆解失败：" + itemError(x) : "正在拆解…")),
      tags.length ? h("div", { class: "row", style: { gap: "6px" } }, tags.map((t) => h("span", { class: "tag" }, t))) : null,
      h("div", { class: "foot" }, h("span", {}, "@" + x.handle), h("span", {}, h("span", { class: "dot " + x.status }), " ", relTime(x.createdAt)))));
}

function emptyStart() {
  return h("div", { class: "card empty" },
    h("h2", { style: { color: "var(--ink)" } }, "还没有收藏"),
    h("p", {}, "① 在 X 上点进一条 AI 视频帖", h("br"), "② 点浏览器右上角的插件图标，打开侧边栏", h("br"), "③ 点“拆解并保存”，结果会出现在这里"));
}

// ---------- 主页 ----------
function topValue(key, list) {
  const c = {};
  for (const x of list) { const v = x.result && x.result.style_tags && x.result.style_tags[key]; if (v) c[v] = (c[v] || 0) + 1; }
  const e = Object.entries(c).sort((a, b) => b[1] - a[1])[0];
  return e ? e[0] : null;
}

function pageHome() {
  const d = done();
  if (!data.items.length) return h("div", { class: "page" }, h("div", { class: "hero" }, h("h1", {}, "你的审美库")), emptyStart());
  const weekAgo = Date.now() - 7 * 86400000;
  const week = d.filter((x) => (x.doneAt || x.createdAt) > weekAgo).length;
  const tagged = d.filter((x) => (data.picks[x.id] || []).length).length;

  const portrait = ["medium", "color", "pace", "camera", "music"].map((k) => topValue(k, d)).filter(Boolean);
  const pickCount = {};
  for (const x of d) for (const t of data.picks[x.id] || []) pickCount[t] = (pickCount[t] || 0) + 1;
  const topPicks = Object.entries(pickCount).sort((a, b) => b[1] - a[1]).slice(0, 4).map(([t]) => t);

  const reportCard = d.length < REPORT_MIN
    ? h("div", { class: "card" }, h("h3", {}, "审美报告"),
        h("div", { class: "meter" }, h("span", { style: { width: (d.length / REPORT_MIN) * 100 + "%" } })),
        h("div", { class: "muted" }, `已收藏 ${d.length} / ${REPORT_MIN} 条，攒满就能生成你的审美报告`))
    : h("div", { class: "card", style: { cursor: "pointer" }, onclick: () => go("report") },
        h("div", { class: "spread" }, h("h3", {}, "审美报告"), h("span", { class: "muted" }, "查看 →")),
        h("p", { class: "clamp2", style: { margin: "10px 0 0", color: "var(--ink-2)" } }, data.lastReport ? data.lastReport.text : "已经可以生成了，去看看你喜欢的到底是什么。"));

  return h("div", { class: "page" },
    h("div", { class: "hero" },
      h("h1", {}, "你的审美库"),
      h("div", { class: "stats" },
        h("div", { class: "card stat" }, h("div", { class: "n" }, d.length), h("div", { class: "muted" }, "条收藏")),
        h("div", { class: "card stat" }, h("div", { class: "n" }, week), h("div", { class: "muted" }, "本周新增")),
        h("div", { class: "card stat" }, h("div", { class: "n" }, d.length ? Math.round((tagged / d.length) * 100) + "%" : "–"), h("div", { class: "muted" }, "勾选了喜欢点")))),
    d.length >= 3
      ? h("div", { class: "card" },
          h("h3", {}, "你常收藏的风格"),
          h("div", { class: "portrait" }, portrait.map((t) => h("span", { class: "p" }, t))),
          topPicks.length ? h("p", { class: "muted", style: { margin: "14px 0 0" } }, "你亲自勾选最多的：" + topPicks.join("、")) : null)
      : null,
    reportCard,
    h("div", {},
      h("div", { class: "spread", style: { marginBottom: "14px" } }, h("h2", {}, "最近收藏"), h("a", { href: "#collection", class: "muted" }, "查看全部 →")),
      h("div", { class: "grid" }, sorted(data.items.filter((x) => x.status !== "failed")).slice(0, 4).map(videoCard))));
}

// ---------- 收藏 ----------
function matches(x) {
  const picks = data.picks[x.id] || [];
  if (ui.filter === "untagged" && !(x.status === "done" && !picks.length)) return false;
  if (ui.filter === "busy" && !(x.status === "queued" || x.status === "processing")) return false;
  if (ui.filter === "failed" && x.status !== "failed") return false;
  if (!ui.q) return true;
  return [x.handle, JSON.stringify(x.result || {}), (x.ctx && x.ctx.mainText) || "", picks.join(" ")].join(" ").toLowerCase().includes(ui.q.toLowerCase());
}

function pageCollection() {
  const filters = [["all", "全部"], ["untagged", "还没勾选喜欢点"], ["busy", "分析中"], ["failed", "失败"]];
  const list = sorted(data.items).filter(matches);
  const search = h("input", { type: "search", placeholder: "搜索作者、风格、提示词…", value: ui.q });
  search.addEventListener("input", () => { ui.q = search.value; drawGrid(); });
  const gridWrap = h("div");
  function drawGrid() {
    const l = sorted(data.items).filter(matches);
    gridWrap.textContent = "";
    gridWrap.append(l.length ? h("div", { class: "grid" }, l.map(videoCard)) : (data.items.length ? h("div", { class: "empty" }, "没有符合条件的收藏") : emptyStart()));
  }
  const page = h("div", { class: "page" },
    h("div", {},
      h("h1", {}, "收藏"),
      h("div", { style: { marginTop: "16px" } }, search),
      h("div", { class: "filters" }, filters.map(([k, t]) => h("span", { class: "chip" + (ui.filter === k ? " on" : ""), onclick: () => { ui.filter = k; render(); } }, t)))),
    gridWrap);
  drawGrid();
  void list;
  return page;
}

// ---------- 详情 ----------
async function removeItem(id) {
  if (!confirm("从审美库删除这条？")) return;
  const s = await chrome.storage.local.get(["items", "picks"]);
  const picks = s.picks || {};
  delete picks[id];
  await chrome.storage.local.set({ items: (s.items || []).filter((x) => x.id !== id), picks });
  idb.del("frames:" + id).catch(() => {});
  chrome.runtime.sendMessage({ type: "refreshBadge" });
  go("collection");
}

function section(title, ...kids) {
  return h("div", { class: "card" }, h("div", { class: "label" }, title), ...kids);
}

// 通过后台串行写入，避免和正在进行的拆解任务互相覆盖
async function patchResult(id, patch) {
  const r = await chrome.runtime.sendMessage({ type: "patchResult", id, patch });
  if (!r || !r.ok) throw new Error((r && r.reason) || "保存失败");
}

function isVideoUrl(u) { return /^https:\/\/video\.twimg\.com\/[^"'\s]+$/.test(u || ""); }

function videoBlock(x) {
  const r = x.result || {};
  if (player.id === x.id && player.el) return player.el;
  const wrap = h("div", { class: "player" });
  const fallback = (msg) => {
    wrap.textContent = "";
    wrap.append(h("div", { class: "thumb", style: bg(r.thumb) }), msg ? h("div", { class: "muted", style: { marginTop: "6px" } }, msg) : null);
  };
  const mount = (url) => {
    const v = h("video", { src: url, controls: "", playsinline: "", preload: "metadata", ...(bg(r.thumb).backgroundImage ? { poster: r.thumb } : {}) });
    v.addEventListener("error", () => fallback("视频加载不了（可能已被删除），可以点“打开原帖”观看。"));
    v.addEventListener("timeupdate", () => {
      const t = v.currentTime;
      document.querySelectorAll(".shot[data-s]").forEach((el) => {
        el.classList.toggle("active", t >= Number(el.dataset.s) && t < Number(el.dataset.e));
      });
    });
    wrap.textContent = "";
    wrap.append(v);
  };
  if (isVideoUrl(r.videoUrl)) mount(r.videoUrl);
  else {
    fallback("正在加载视频…");
    // 老收藏没有存视频地址：现查一次并存下来
    chrome.runtime.sendMessage({ type: "videoUrl", tweetId: x.tweetId }).then((res) => {
      if (res && res.ok && isVideoUrl(res.url)) { mount(res.url); patchResult(x.id, { videoUrl: res.url }).catch(() => {}); }
      else fallback("没找到视频地址，可以点“打开原帖”观看。");
    }, () => fallback(""));
  }
  player = { id: x.id, el: wrap };
  return wrap;
}

function seek(t) {
  const v = player.el && player.el.querySelector("video");
  if (!v) return;
  v.currentTime = Math.max(0, t + 0.01);
  v.play().catch(() => {});
}

function recipeSection(x, r) {
  const title = "风格配方 · 换个题材复刻同款风格";
  if (!r.style_template_zh) {
    const msg = h("div", { class: "muted" });
    const btn = h("button", { class: "primary", onclick: async () => {
      btn.disabled = true; btn.textContent = "正在生成…"; msg.textContent = "";
      try {
        const text = await generate([{ text: recipePrompt(r) }], { json: true, role: "plan" });
        const got = normalizeAnalysis({ ...parseJSON(text), shots: r.shots, summary: r.summary, duration_sec: r.duration_sec, aspect: r.aspect, style_tags: r.style_tags, author_disclosed: r.author_disclosed });
        if (!got.style_template_zh) throw new Error("模型没有返回风格模板，请重试");
        await patchResult(x.id, { style_guide: got.style_guide, style_template_zh: got.style_template_zh, style_template_en: got.style_template_en, title: got.title || r.title });
        toast("已生成");
      } catch (e) { msg.textContent = "生成失败：" + e.message; btn.disabled = false; btn.textContent = "生成风格配方"; }
    } }, "生成风格配方");
    return section(title,
      h("p", { class: "muted", style: { margin: "0 0 12px" } }, "这条是旧版拆解，还没有风格配方。会根据已有分镜生成，不用重新看视频，几秒钟就好。"),
      h("div", { class: "row" }, btn, msg));
  }
  const box = h("pre", { class: "prompt" });
  const seg = h("div", { class: "seg" });
  const input = h("input", { type: "text", class: "subject", placeholder: "在这里填你的主题，比如：一只橘猫在雨夜的东京街头", value: ui.subject });
  const fill = () => {
    const subj = ui.subject.trim();
    box.textContent = ui.tlang === "en"
      ? (r.style_template_en || "").replace(/\[SUBJECT\]/g, subj || "[SUBJECT]")
      : r.style_template_zh.replace(/【主题】/g, subj || "【主题】");
    seg.querySelectorAll("button").forEach((b) => b.classList.toggle("on", b.dataset.l === ui.tlang));
  };
  input.addEventListener("input", () => { ui.subject = input.value; fill(); });
  seg.append(h("button", { "data-l": "zh", onclick: () => { ui.tlang = "zh"; fill(); } }, "中文"));
  if (r.style_template_en) seg.append(h("button", { "data-l": "en", onclick: () => { ui.tlang = "en"; fill(); } }, "English"));
  if (!r.style_template_en) ui.tlang = "zh";
  fill();
  const guide = r.style_guide || {};
  return section(title,
    input,
    h("div", { class: "spread", style: { margin: "12px 0 10px" } }, seg,
      h("button", { class: "small primary", style: { padding: "4px 12px" }, onclick: async () => { await navigator.clipboard.writeText(box.textContent); toast("已复制"); } }, "复制风格提示词")),
    box,
    Object.keys(guide).length ? h("div", { class: "guide" }, STYLE_GUIDE_KEYS.filter(([k]) => guide[k]).map(([k, l]) =>
      h("div", { class: "g" }, h("div", { class: "k" }, l), h("div", {}, guide[k])))) : null,
    h("p", { class: "muted", style: { margin: "12px 0 0" } },
      "小贴士：英文提示词在 Sora、Veo、Kling 里通常更稳；主题用英文填效果更好。原片是多镜头快剪时，单次生成往往只有 5–10 秒，可按模板里的镜头规律分几段生成再剪到一起。"));
}

function replicaSection(x, r, ad) {
  const promptBox = h("pre", { class: "prompt" });
  const seg = h("div", { class: "seg" });
  const enBtn = h("button", { class: "small", onclick: async () => {
    enBtn.disabled = true; enBtn.textContent = "正在翻译…";
    try {
      const text = (await generate([{ text: translatePrompt(r.prompt_zh) }], { json: false })).trim();
      await patchResult(x.id, { prompt_en: text });
    } catch (e) { toast("翻译失败：" + e.message); enBtn.disabled = false; enBtn.textContent = "生成英文版"; }
  } }, "生成英文版");
  const setLang = (l) => {
    ui.lang = l;
    promptBox.textContent = l === "zh" ? r.prompt_zh || "" : r.prompt_en || "还没有英文版，点右边“生成英文版”。";
    enBtn.style.display = l === "en" && !r.prompt_en ? "" : "none";
    seg.querySelectorAll("button").forEach((b) => b.classList.toggle("on", b.dataset.l === l));
  };
  seg.append(h("button", { "data-l": "zh", onclick: () => setLang("zh") }, "中文"), h("button", { "data-l": "en", onclick: () => setLang("en") }, "English"));
  setLang(ui.lang);
  return section(ad.found ? "逐镜头复刻提示词（供对照）" : "逐镜头复刻提示词",
    h("div", { class: "spread", style: { marginBottom: "10px" } }, seg, h("div", { class: "row" }, enBtn,
      h("button", { class: "small primary", style: { padding: "4px 12px" }, onclick: async () => { await navigator.clipboard.writeText(promptBox.textContent); toast("已复制"); } }, "复制完整提示词"))),
    promptBox,
    r.style_prompt_zh ? h("p", { class: "muted", style: { margin: "10px 0 0" } }, "一句话风格：" + r.style_prompt_zh) : null,
    !ad.found && r.tool_guess ? h("p", { class: "muted", style: { margin: "4px 0 0" } }, "推测使用的工具：" + r.tool_guess) : null);
}

// ---------- 高还原复刻：关键帧 + 分镜 ----------
const pad = (n) => String(n).padStart(2, "0");
function shotPrompt(r, s) {
  const len = Math.max(0.1, (Number(s.end) || 0) - (Number(s.start) || 0));
  return [s.visual, s.action && s.action !== "静止" ? "动作：" + s.action : "", "运镜：" + (s.camera || "固定"),
    s.light ? "光影：" + s.light : "", r.style_prompt_zh ? "整体风格：" + r.style_prompt_zh : ""].filter(Boolean).join("；")
    + `。原镜头约 ${fmt(len)} 秒。`;
}
async function bestVideoUrl(x) {
  const res = await chrome.runtime.sendMessage({ type: "videoUrl", tweetId: x.tweetId }).catch(() => null);
  if (res && res.ok && isVideoUrl(res.best)) return res.best;
  if (isVideoUrl(x.result && x.result.videoUrl)) return x.result.videoUrl;
  throw new Error("没找到视频地址（帖子可能已删除）");
}
// 关键帧截一次就存进这条收藏（浏览器本地），下次打开直接显示；镜头重新拆过后会自动作废
const framesKey = (x) => "frames:" + x.id;
const shotsSig = (x) => framesSig((x.result || {}).shots);
async function loadSavedFrames(x) {
  if (frameCache[x.id]) return;
  frameCache[x.id] = { status: "checking" };
  const v = await idb.get(framesKey(x)).catch(() => null);
  if (v && v.sig === shotsSig(x) && Array.isArray(v.shots)) {
    const shots = v.shots.map((sh) => {
      const frames = sh.frames.map((f) => ({ ...f, url: URL.createObjectURL(f.blob) }));
      const first = frames.find((f) => f.kind === "首帧") || frames[0], last = [...frames].reverse().find((f) => f.kind === "尾帧") || frames.at(-1);
      return { frames, first: first?.blob, last: last?.blob, firstUrl: first?.url, lastUrl: last?.url, mid: frames[Math.floor(frames.length / 2)] };
    });
    frameCache[x.id] = { status: "done", sig: v.sig, video: null, width: v.width, height: v.height, shots, total: shots.reduce((n, f) => n + f.frames.length, 0), saved: true };
    render(true);
  } else { frameCache[x.id] = { status: "idle" }; render(true); } // 没存过：标记为“未截取”，不再反复查；重画一次，让页面去请求后台截图
}
async function extractFrames(x, status) {
  const r = x.result || {};
  // 只收藏了风格、没有镜头信息时，把视频均匀分成 6 段来截图（用于风格卡挑参考图）
  const dur = Number(r.duration_sec) || 10;
  const shots = (r.shots || []).length ? r.shots : Array.from({ length: 6 }, (_, i) => ({ start: (dur * i) / 6, end: (dur * (i + 1)) / 6 }));
  frameCache[x.id] = { status: "loading" };
  try {
    status("正在下载原视频（最高清晰度）…");
    const video = await downloadVideo(await bestVideoUrl(x));
    const real = (r.shots || []).length > 0;
    const { shots: fs, width, height, snapped, moved } = await scanKeyframes(video, shots, { snap: real,
      onProgress: (r, ph) => status(`${ph === "scan" ? "正在扫描画面、校准切点" : "正在截取关键帧"} ${Math.round(r * 100)}%…`) });
    // 切点挪过了：把校准后的时间写回这条收藏（复制的提示词、分镜参考的节奏都会跟着变准）
    if (real && snapped && moved) {
      const autoPrompt = r.prompt_zh && r.prompt_zh === buildReplicaPrompt(r);
      const shotsNew = snapped.map((s) => ({ ...s, start: Math.round(s.start * 100) / 100, end: Math.round(s.end * 100) / 100 }));
      x.result = { ...r, shots: shotsNew, cutsSnapped: 1, ...(autoPrompt ? { prompt_zh: buildReplicaPrompt({ ...r, shots: shotsNew }) } : {}) };
      await patchResult(x.id, { shots: x.result.shots, cutsSnapped: 1, ...(autoPrompt ? { prompt_zh: x.result.prompt_zh } : {}) }).catch((e) => console.warn("切点写回失败", e));
      const it = (data.items || []).find((y) => y.id === x.id); if (it && it !== x) it.result = x.result;
      toast(`已按画面校准 ${moved} 个切点`);
    }
    frameCache[x.id] = { status: "done", sig: shotsSig(x), video, width, height, shots: fs, total: fs.reduce((n, f) => n + f.frames.length, 0) };
    // 存一份缩小到 1280 宽的版本，下次打开直接用
    if ((r.shots || []).length) {
      const saved = [];
      for (const sh of fs) saved.push({ frames: await Promise.all(sh.frames.map(async (f) => ({ t: f.t, kind: f.kind, blob: await shrink(f.blob) }))) });
      idb.put(framesKey(x), { sig: shotsSig(x), width, height, shots: saved, at: Date.now() }).catch(() => {});
    }
  } catch (e) { frameCache[x.id] = { status: "error", msg: e.message }; }
  render(true);
}
const GUIDE_TEXT = `高还原复刻怎么用
================
文字提示词只能描述画面，参考图能把“那个样子”直接交给生成工具，所以更接近原片。

1. 打开即梦、可灵等工具的「图生视频」；有「首尾帧」模式更好。
2. 按镜头顺序：上传「关键帧/镜头NN/」里标着“首帧”的图（首尾帧模式再加标着“尾帧”的图），
   粘贴「分镜提示词.txt」里对应镜头的那段。
   镜头里画面变化多（标着“变化”“切换”的帧）时，把这个镜头拆成几小段：
   每段用相邻两张关键帧当首帧和尾帧分别生成，再接起来，节奏和动作会更贴近原片。
3. 时长选最接近原镜头的；工具最短 5 秒时，生成后剪到原镜头长度。
4. 全部镜头生成后按顺序拼接，再配上同类的音乐和音效（见提示词末尾）。

想换成自己的题材：
把关键帧当风格参考图（例如即梦的参考图、Midjourney 的风格参考），先生成你自己题材的首帧，
构图、色调尽量向原帧靠，再用这张图和同一段提示词去做图生视频。

提醒：关键帧和原视频是原作者的作品，只用于学习和练习，不要直接发布或商用。
`;
async function buildPack(x, fc) {
  const r = x.result || {};
  if (!fc.video) { toast("正在下载原视频…"); fc.video = await downloadVideo(await bestVideoUrl(x)); }
  const files = [{ name: "00_使用说明.txt", data: GUIDE_TEXT }, { name: "原视频.mp4", data: fc.video }];
  const lines = [`${displayTitle(x)}  ·  @${x.handle}  ·  ${x.url}`, `画幅：${r.aspect || ""}  关键帧尺寸：${fc.width}×${fc.height}`, ""];
  (r.shots || []).forEach((s, i) => {
    const n = pad(i + 1);
    const fr = (fc.shots[i] || { frames: [] }).frames;
    const names = fr.map((f, k) => `${pad(k + 1)}_${fmt(f.t)}s_${f.kind}.jpg`);
    lines.push(`【镜头${n}】${fmt(s.start)}s – ${fmt(s.end)}s　关键帧 ${fr.length} 张：关键帧/镜头${n}/`, shotPrompt(r, s), "声音：" + (s.audio || "—"), "");
    fr.forEach((f, k) => files.push({ name: `关键帧/镜头${n}/${names[k]}`, data: f.blob }));
  });
  if (r.soundtrack) lines.push("整体配乐与音效：" + r.soundtrack);
  files.push({ name: "分镜提示词.txt", data: lines.join("\n") });
  if (r.style_template_zh) files.push({ name: "风格模板.txt", data: r.style_template_zh + (r.style_template_en ? "\n\n" + r.style_template_en : "") });
  const safe = displayTitle(x).replace(/[\\/:*?"<>|…\s]+/g, "").slice(0, 20) || x.tweetId;
  saveBlob(await makeZip(files), `复刻素材包-${safe}.zip`);
}
// ---------- 花费记录 + 截图校对状态 ----------
function costLine(r) {
  const c = r.cost || {};
  const parts = [["analysis", "拆解"], ["shots", "补拆镜头"], ["proofread", "截图校对"]].filter(([k]) => c[k]).map(([k, l]) => `${l} ${c[k].cny.toFixed(2)} 元`);
  if (!parts.length) return null;
  const total = ["analysis", "shots", "proofread"].reduce((n, k) => n + (c[k] ? c[k].cny : 0), 0);
  const tok = ["analysis", "shots", "proofread"].reduce((n, k) => n + (c[k] ? c[k].in + c[k].out : 0), 0);
  return h("div", { class: "muted", style: { fontSize: "12px" }, title: `共 ${tok.toLocaleString()} tokens，按 Atlas 上 Gemini 3.8 Flash 的单价估算` }, `这条花费约 ${total.toFixed(2)} 元（${parts.join(" + ")}）`);
}
const proofAsked = new Set();
function proofLine(x, r) {
  if (x.status !== "done") return null;
  if (r.proofStatus === "running") return h("div", { class: "muted", style: { fontSize: "12px" } }, "正在用清晰截图校对描述…");
  if (r.proofread) {
    const ch = r.proofread.changes || [];
    return h("details", { style: { fontSize: "12px" } },
      h("summary", { class: "muted", style: { cursor: "pointer" } }, ch.length ? `已对照截图校对，改了 ${ch.length} 处（点开看）` : "已对照截图校对，描述和截图一致"),
      ch.length ? h("ul", { style: { margin: "6px 0 0", paddingLeft: "18px" } }, ch.map((c) => h("li", { class: "muted" }, c))) : null);
  }
  if (r.proofStatus === "failed") return h("div", { class: "muted", style: { fontSize: "12px" } }, "截图校对没成功：" + (r.proofError || "") + "（描述保持原样）");
  // 只收藏风格、还没校对过的：后台截十几张画面来校对风格
  if (!(r.shots || []).length && chrome.offscreen !== undefined) {
    if (!proofAsked.has(x.id)) { proofAsked.add(x.id); chrome.runtime.sendMessage({ type: "framesEnqueue", ids: [x.id] }).catch(() => {}); }
    const st = bgJobs[x.id];
    if (st && st.status === "running") return h("div", { class: "muted", style: { fontSize: "12px" }, "data-frames": x.id }, framesText(st)); // 带 data-frames：进度变化只改文字，不重画页面
    if (st && st.status === "error") return h("div", { class: "muted", style: { fontSize: "12px" } }, "截取画面失败，风格总结没有校对：" + st.msg);
  }
  return null;
}
// 截图早就存好、但还没校对过的收藏（例如升级前截的）：打开时补做一次校对
function maybeProofread(x) {
  const r = x.result || {};
  if (proofAsked.has(x.id) || r.proofStatus === "running" || (r.proofread && r.proofread.sig === framesSig(r.shots))) return;
  proofAsked.add(x.id);
  chrome.runtime.sendMessage({ type: "proofread", id: x.id }).catch(() => {});
}

// ---------- 后台截图的进度 ----------
const bgJobs = {};          // 收藏 id -> 后台截图状态
const autoAsked = new Set(); // 这次打开页面已经请求过后台截图的收藏
let bgUnsupported = false;
const frameWaiters = {};    // 收藏 id -> [resolve]
function framesText(st, fc) {
  if (st && st.status === "error") return "截图失败：" + st.msg;
  if (st && st.status === "queued") return "排队中：前面还有别的视频在截图…";
  if (st && st.status === "running") return `${st.msg || "处理中"} ${st.pct || 0}%…`;
  if (fc && fc.status === "checking") return "";
  return "正在准备截图…";
}
async function askFrames(x, force) {
  const r = await chrome.runtime.sendMessage({ type: "framesEnqueue", ids: [x.id], force }).catch((e) => ({ ok: false, reason: e.message }));
  if (r && r.ok) return;
  if (/太旧|offscreen/i.test((r && r.reason) || "")) { bgUnsupported = true; render(true); return; } // 浏览器不支持后台页面：退回在当前页面截图
  bgJobs[x.id] = { status: "error", msg: (r && r.reason) || "后台截图没能开始" }; render(true);
}
chrome.runtime.onMessage?.addListener((msg) => {
  if (!msg || msg.type !== "frames:update") return false;
  const prev = bgJobs[msg.id];
  bgJobs[msg.id] = msg.state;
  if (msg.state && msg.state.status === "done") {
    delete frameCache[msg.id];
    const x = itemById(msg.id);
    // 校准后的切点要等收藏数据刷新后再读截图，否则版本对不上
    setTimeout(async () => {
      data = await loadAll(); const y = itemById(msg.id);
      if (y) { delete frameCache[msg.id]; await loadSavedFrames(y); }
      (frameWaiters[msg.id] || []).forEach((f) => f()); delete frameWaiters[msg.id];
      if (msg.state.moved) toast(`关键帧已截好，并按画面校准了 ${msg.state.moved} 个切点`);
      render(true);
    }, 300);
    return false;
  }
  if (msg.state && msg.state.status === "error") { (frameWaiters[msg.id] || []).forEach((f) => f()); delete frameWaiters[msg.id]; }
  const el = document.querySelector(`[data-frames="${CSS.escape(msg.id)}"]`);
  if (el && prev && prev.status === msg.state.status) el.textContent = framesText(msg.state); // 只是进度变了：只改文字，不重画页面
  else render(true);
  return false;
});
function hifiSection(x, r) {
  // 镜头重新拆过后，旧关键帧作废
  if (frameCache[x.id] && frameCache[x.id].status === "done" && frameCache[x.id].sig !== shotsSig(x)) delete frameCache[x.id];
  if (!frameCache[x.id]) loadSavedFrames(x);
  const fc = frameCache[x.id] || { status: "idle" };
  const status = h("span", { class: "muted" });
  const intro = h("p", { class: "muted", style: { margin: "0 0 12px" } },
    "文字提示词描述不出“那个具体的样子”。这里会逐帧扫描原片：每个镜头截首帧、尾帧，镜头里画面一有明显变化也截下来，最长每 0.5 秒一帧，快剪和快速动作都能留住。配上该镜头的提示词，拿去即梦、可灵的「图生视频 / 首尾帧」逐镜生成，会比只用文字接近得多。截图在你的浏览器里完成，不消耗 API 额度。");
  if (fc.status === "done") {
    if ((r.shots || []).length && chrome.offscreen !== undefined) maybeProofread(x);
    const btn = h("button", { class: "primary", onclick: async () => {
      btn.disabled = true; btn.textContent = "正在打包…";
      try { await buildPack(x, fc); toast("已开始下载"); } catch (e) { toast("打包失败：" + e.message); }
      btn.disabled = false; btn.textContent = "下载复刻素材包";
    } }, "下载复刻素材包");
    return section("高还原复刻 · 关键帧 + 分镜", intro,
      h("div", { class: "row" }, btn, h("span", { class: "muted" }, `已截取 ${fc.shots.length} 个镜头共 ${fc.total} 张关键帧（${fc.width}×${fc.height}），显示在下方分镜里。素材包含原视频、全部关键帧、分镜提示词和使用说明。`)));
  }
  // 有镜头的收藏：截图在后台做（拆解完成后自动开始），这里只显示进度
  if ((r.shots || []).length && chrome.offscreen !== undefined && !bgUnsupported) {
    if (fc.status === "idle" && !autoAsked.has(x.id)) { autoAsked.add(x.id); askFrames(x, false); }
    const st = bgJobs[x.id];
    const err = st && st.status === "error";
    const line = h("span", { class: "muted", "data-frames": x.id }, framesText(st, fc));
    return section("高还原复刻 · 关键帧 + 分镜", intro,
      h("div", { class: "row" },
        err ? h("button", { class: "primary", onclick: () => { bgJobs[x.id] = { status: "queued" }; render(true); askFrames(x, true); } }, "重新截图") : null,
        line),
      err ? null : h("p", { class: "muted", style: { margin: "8px 0 0", fontSize: "12px" } }, "截图在插件后台进行，可以离开这个页面、去看别的收藏，做完会自动显示在这里。"));
  }
  const btn = h("button", { class: "primary", disabled: fc.status === "loading", onclick: () => {
    btn.disabled = true; extractFrames(x, (t) => { status.textContent = t; });
  } }, fc.status === "loading" ? "正在处理…" : "提取每个镜头的关键帧");
  if (fc.status === "error") status.textContent = "提取失败：" + fc.msg;
  return section("高还原复刻 · 关键帧 + 分镜", intro, h("div", { class: "row" }, btn, status));
}
function shotFrames(x, r, s, i) {
  const fc = frameCache[x.id];
  const copy = h("button", { class: "small", onclick: async () => { await navigator.clipboard.writeText(shotPrompt(r, s)); toast("已复制本镜提示词"); } }, "复制本镜提示词");
  if (!fc || fc.status !== "done" || !fc.shots[i]) return h("div", { class: "row", style: { marginTop: "6px" } }, copy);
  const n = pad(i + 1);
  return h("div", {}, h("div", { class: "kfs" }, fc.shots[i].frames.map((f, k) => h("figure", { class: "kf" + (f.kind === "首帧" || f.kind === "尾帧" ? " edge" : "") },
      h("img", { src: f.url, title: "点击跳到这一帧", onclick: () => seek(f.t) }),
      h("figcaption", {}, `${fmt(f.t)}s ${f.kind} · `, h("a", { href: "#", onclick: (e) => { e.preventDefault(); saveBlob(f.blob, `镜头${n}_${pad(k + 1)}_${fmt(f.t)}s_${f.kind}.jpg`); } }, "下载"))))),
    h("div", { class: "row", style: { marginTop: "6px" } }, copy));
}

// 作者公开的提示词：放在最上面，可以直接复制，或者让 AI 改成你的主题
const rewriteUI = {}; // itemId -> { subject, out, busy }
function authorSection(x, ad) {
  if (!ad.prompt) return section("作者提到了工具" + ((ad.tools || []).length ? " · " + ad.tools.join("、") : ""), h("div", { class: "muted" }, "作者提到了工具，但没有贴出提示词。"));
  const st = rewriteUI[x.id] || (rewriteUI[x.id] = { subject: "", out: "", busy: false });
  const input = h("input", { type: "text", placeholder: "你的主题，例如：一只橘猫在雨夜的东京街头", value: st.subject });
  input.addEventListener("input", () => { st.subject = input.value; });
  const go1 = h("button", { class: "small primary", disabled: st.busy, onclick: async () => {
    if (!st.subject.trim()) { input.focus(); return; }
    st.busy = true; render(true);
    try { st.out = (await generate([{ text: rewritePrompt(ad.prompt, st.subject.trim()) }], { json: false })).trim(); }
    catch (e) { toast("改写失败：" + e.message); }
    st.busy = false; render(true);
  } }, st.busy ? "正在改写…" : "改成我的主题");
  return h("div", { class: "card author" },
    h("div", { class: "spread" }, h("div", { class: "label", style: { margin: 0 } }, "★ 作者公开的原版提示词" + ((ad.tools || []).length ? " · " + ad.tools.join("、") : "")), copyButton(ad.prompt, "直接复制")),
    h("pre", { class: "prompt", style: { marginTop: "10px" } }, ad.prompt),
    h("p", { class: "muted", style: { margin: "8px 0 10px" } }, "这是最准的风格来源。写分镜、提炼风格卡时，插件也会优先参考它。"),
    h("div", { class: "row" }, h("div", { style: { flex: 1, minWidth: "220px" } }, input), go1),
    st.out ? h("div", { style: { marginTop: "10px" } }, h("div", { class: "spread" }, h("div", { class: "label", style: { margin: 0 } }, "改好的提示词"), copyButton(st.out, "复制")),
      h("pre", { class: "prompt", style: { marginTop: "6px" } }, st.out)) : null);
}
// 只收藏了风格的视频：按需补做逐镜头拆解
function shotsOffer(x, r) {
  const running = r.shotsStatus === "running";
  return section("逐镜头拆解（可选）",
    h("p", { class: "muted", style: { margin: "0 0 12px" } }, r.author_disclosed && r.author_disclosed.found && r.author_disclosed.prompt
      ? "作者已经公开了提示词，一般收藏风格就够用。想对照原片逐个镜头学习、截取关键帧，再做镜头拆解。"
      : "这条只收藏了风格。想对照原片逐个镜头学习、截取每个镜头的关键帧，可以补做镜头拆解。风格部分会保留不变。"),
    h("div", { class: "row" },
      h("button", { class: running ? "" : "primary", disabled: running, onclick: async () => { await chrome.runtime.sendMessage({ type: "addShots", id: x.id }); toast("已开始，完成后会通知你"); } }, running ? "正在拆解镜头…" : r.shotsStatus === "failed" ? "重试镜头拆解" : "拆解镜头"),
      running ? h("span", { class: "muted" }, "可以先去做别的，完成后会通知你。") : null,
      r.shotsStatus === "failed" ? h("span", { class: "muted" }, r.shotsError || "失败了，请重试") : null));
}

function pageItem(id) {
  const x = data.items.find((i) => i.id === id);
  if (!x) return h("div", { class: "page" }, h("div", { class: "empty" }, "找不到这条收藏，可能已被删除。"), h("div", { style: { textAlign: "center" } }, h("a", { href: "#collection" }, "返回收藏")));
  const r = x.result || {};
  const back = h("a", { href: "#collection", class: "muted", style: { textDecoration: "none" } }, "← 返回收藏");

  const aside = h("aside", {},
    x.status === "done" ? videoBlock(x) : h("div", { class: "thumb", style: bg(r.thumb) }),
    h("div", { class: "stack", style: { fontSize: "13.5px", marginTop: "12px" } },
      h("div", {}, h("a", { href: x.url, target: "_blank", rel: "noopener" }, "@" + x.handle), h("span", { class: "muted" }, " · " + relTime(x.createdAt))),
      x.status === "done" && (r.shots || []).length ? h("div", { class: "muted" }, "点右侧分镜的时间，视频会跳到那一段。") : null,
      r.timing && r.timing.total ? h("div", { class: "muted", style: { fontSize: "12px" } },
        `本次拆解耗时 ${r.timing.total} 秒` + (r.timing.firstByte != null ? `（模型 ${r.timing.firstByte} 秒后开始返回）` : "")) : null,
      costLine(r),
      proofLine(x, r),
      h("div", { class: "row" },
        h("button", { class: "small", onclick: () => window.open(x.url, "_blank") }, "打开原帖"),
        x.status === "failed" ? h("button", { class: "small", onclick: () => chrome.runtime.sendMessage({ type: "retry", id: x.id }) }, "重试") : null,
        h("button", { class: "small ghost", onclick: () => removeItem(x.id) }, "删除"))));

  if (x.status !== "done") {
    return h("div", { class: "page" }, back, h("div", { class: "detail" }, aside,
      h("div", { class: "card" }, h("h2", {}, STATUS[x.status]), h("p", { class: "muted" }, x.status === "failed" ? itemError(x) : "完成后会通知你，可以先去做别的。"), x.status === "failed" ? failureInfo(x) : null)));
  }

  const ad = r.author_disclosed || {};
  const st = r.style_tags || {};
  const main = h("div", { class: "stack" },
    h("div", { class: "card" },
      h("h2", { style: { lineHeight: 1.5 } }, displayTitle(x)),
      r.summary ? h("p", { style: { margin: "6px 0 0", color: "var(--ink-2)" } }, r.summary) : null,
      r.creative_point ? h("p", { class: "muted", style: { margin: "8px 0 0" } }, "打动人的地方：" + r.creative_point) : null),
    section("你喜欢它哪里？可多选，也可以跳过", likeChips(x, data.picks)),
    ad.found ? authorSection(x, ad) : null,
    recipeSection(x, r),
    section("用这条的风格做新视频", h("p", { class: "muted", style: { margin: "0 0 12px" } }, "输入你的主题，AI 借鉴这条的风格手法（不搬它的内容），给你一整套新分镜。想长期复用这个风格，可以先提炼成风格卡；想综合多条收藏，去“风格分组”。"),
      h("div", { class: "row" }, composer({ itemIds: [x.id], label: "开始设计我的视频" }),
        h("button", { class: "ghost", onclick: (e) => distillCard([x.id], displayTitle(x), e.currentTarget) }, "提炼成风格卡"))),
    !(r.shots || []).length ? shotsOffer(x, r) : null,
    !(r.shots || []).length ? null : hifiSection(x, r),
    !(r.shots || []).length ? null : section(`分镜 · ${(r.shots || []).length} 个画面段`,
      h("div", { class: "row", style: { margin: "-4px 0 12px" } },
        h("button", { class: "small ghost", disabled: r.shotsStatus === "running", onclick: async () => {
          if (!confirm("按最新的分段规则重新拆解镜头？风格部分保持不变，已截的关键帧会作废、需要重新截。")) return;
          await chrome.runtime.sendMessage({ type: "addShots", id: x.id }); toast("已开始，完成后会通知你");
        } }, r.shotsStatus === "running" ? "正在重新拆解…" : "重新拆解镜头"),
        r.shotsStatus === "failed" ? h("span", { class: "muted" }, r.shotsError || "") : null),
      r.long_video ? h("p", { class: "muted", style: { margin: "0 0 12px" } }, "这条视频比较长（超过 3 分钟），镜头拆解会粗一些，最多 80 段。细节可以对照关键帧看。") : null,
      h("div", { class: "timeline" }, (r.shots || []).map((s, i) => h("div", { class: "shot", "data-s": s.start, "data-e": s.end },
        h("div", { class: "time", title: "跳到这一段", onclick: () => seek(Number(s.start) || 0) }, `▶ ${fmt(s.start)}s – ${fmt(s.end)}s`,
          s.merged > 1 ? h("span", { class: "mergedb", title: "这一段是几个快速切换的镜头合并写的，具体画面看下面截取的关键帧" }, `含 ${s.merged} 个快切`) : null),
        h("div", {}, s.visual),
        h("div", { class: "meta" }, h("span", {}, "动作"), h("span", {}, s.action || "–"), h("span", {}, "运镜"), h("span", {}, s.camera || "–"),
          s.light ? [h("span", {}, "光影"), h("span", {}, s.light)] : null, h("span", {}, "声音"), h("span", {}, s.audio || "–")),
        shotFrames(x, r, s, i))))),
    !(r.shots || []).length ? null : replicaSection(x, r, ad),
    Object.keys(r.audio_detail || {}).length ? section("声音拆解",
      h("div", { class: "guide", style: { marginTop: 0 } }, AUDIO_KEYS.filter(([k]) => r.audio_detail[k]).map(([k, l]) => h("div", { class: "g" }, h("div", { class: "k" }, l), h("div", {}, r.audio_detail[k]))))) : null,
    section("风格标签",
      h("div", { class: "tags-grid" }, DIMENSIONS.filter((d) => st[d.key]).map((d) => h("div", {}, h("div", { class: "k" }, d.label), h("div", {}, st[d.key]))))));

  return h("div", { class: "page" }, back, h("div", { class: "detail" }, aside, main));
}

// ---------- 审美报告 ----------
function computeStats(list) {
  const dims = DIMENSIONS.map((d) => {
    const c = {};
    for (const x of list) { const v = x.result && x.result.style_tags && x.result.style_tags[d.key]; if (v) c[v] = (c[v] || 0) + 1; }
    return { label: d.label, top: Object.entries(c).sort((a, b) => b[1] - a[1]).slice(0, 3) };
  });
  const pickCount = {};
  let tagged = 0;
  for (const x of list) { const p = data.picks[x.id] || []; if (p.length) tagged++; for (const t of p) pickCount[t] = (pickCount[t] || 0) + 1; }
  const lens = list.flatMap((x) => (x.result.shots || []).map((s) => s.end - s.start)).filter((n) => n > 0);
  const avgShot = lens.length ? lens.reduce((a, b) => a + b, 0) / lens.length : 0;
  return { total: list.length, tagged, dims, avgShot, picks: Object.entries(pickCount).sort((a, b) => b[1] - a[1]).slice(0, 10) };
}

function reportPrompt(s, list) {
  const items = list.slice(0, 40).map((x) => {
    const r = x.result || {};
    return `[${x.id}] ${r.title || r.creative_tag || ""}｜${Object.values(r.style_tags || {}).join("、")}${(data.picks[x.id] || []).length ? "｜她勾选：" + data.picks[x.id].join("、") : ""}｜创意：${r.creative_point || r.creative_tag || ""}`;
  }).join("\n");
  return `你是一本视频美学杂志的编辑，要给一位 AI 视频创作者写一篇关于“她的审美”的短专题。依据是她收藏的 ${s.total} 条视频。

写作要求：
- 语气像懂行的朋友，具体、有洞察，不说空话套话；所有判断必须有数据或收藏支撑，不要编造。
- 区分两类证据：她亲自勾选的“喜欢点”（更可信，${s.tagged} 条有勾选）和 AI 打的风格标签（只是旁证）。勾选太少就直说。
- headline 是整篇的结论，像杂志标题一样有一点反转或洞察，例如“你喜欢的不是‘快’，是画面踩在鼓点上”，不超过 22 字，可用“，”分成两行。
- 每节正文 40-90 字；每节从下面收藏列表里挑 2-4 条最能说明这一节的收藏作为证据（填收藏编号）。

只输出一个 JSON 对象：
{"headline":"标题","lede":"导语，50字内，用一两个数字点出核心发现",
"sections":[
 {"title":"你亲手勾选的偏好","body":"…","evidence":["收藏编号"]},
 {"title":"你可能没注意到的规律","body":"…","evidence":["…"]},
 {"title":"下一条可以这样拍","body":"给一个具体可执行的创作建议","evidence":["…"]}
],
"pull_quote":"一句 6-12 字的金句，概括她的审美",
"next_subject":"第三节建议对应的新视频主题，一句话，可直接拿去生成分镜"}

【AI 风格标签统计（每个维度前三名，数字为条数）】
${s.dims.filter((d) => d.top.length).map((d) => `${d.label}：${d.top.map(([v, n]) => v + " " + n).join("，")}`).join("\n")}
平均镜头长度：${s.avgShot.toFixed(1)} 秒

【她亲自勾选的喜欢点（次数）】
${s.picks.length ? s.picks.map(([t, n]) => t + " " + n).join("，") : "（无）"}

【收藏列表（方括号里是收藏编号）】
${items}`;
}

// 杂志专题式的报告页面（真实报告和示例共用）
function magazine(rep, { sample = false, issue = 1, total = 0, onIdea = null } = {}) {
  const ev = (ids) => {
    const xs = (ids || []).map((id) => (sample ? id : itemById(id))).filter(Boolean).slice(0, 4);
    if (!xs.length) return null;
    return h("div", { class: "mz-ev" }, xs.map((x) => sample
      ? h("i", { style: { background: x } })
      : h("a", { href: "#item/" + x.id, title: displayTitle(x), class: "mz-th", style: bg(x.result.thumb) }, h("span", {}, displayTitle(x)))));
  };
  const sections = (rep.sections || []).slice(0, 3);
  const [h1a, h1b] = String(rep.headline || "").split(/[，,]/);
  return h("article", { class: "mz" },
    h("div", { class: "mz-iss" }, `审美报告 · 第 ${pad(issue)} 期 · ${total} 条收藏${sample ? " · 示例" : ""}`),
    h("h1", { class: "mz-h" }, h1a || "", h1b ? [ "，", h("br"), h1b ] : null),
    rep.lede ? h("div", { class: "mz-lede" }, rep.lede) : null,
    sections.map((sec, i) => [
      h("section", { class: "mz-sec" },
        h("div", { class: "mz-no" }, pad(i + 1)),
        h("div", { class: "mz-st" }, sec.title || ""),
        h("p", {}, sec.body || ""),
        ev(sec.evidence),
        i === 2 && onIdea ? h("button", { class: "primary mz-cta", onclick: onIdea }, "用这个思路生成分镜 →") : null),
      i === 0 && rep.pull_quote ? h("div", { class: "mz-pull" }, "“" + rep.pull_quote.replace(/^[“"]|[”"]$/g, "") + "”") : null
    ]));
}

const SAMPLE_REPORT = {
  headline: "你喜欢的不是“快”，是画面踩在鼓点上",
  lede: "十条收藏里，七条是音乐卡点，六条是硬光 3D。比起好看，你更在意节奏带来的那一下冲击。",
  sections: [
    { title: "你亲手勾选的偏好", body: "“快节奏”你勾了 6 次，“硬光强对比”5 次。这比 AI 打的标签更说明问题：吸引你的是节奏和光影的冲击力，而不只是画面漂亮。", evidence: ["#3a3f8f", "#ff6a2b", "#222", "#d9a24a"] },
    { title: "你可能没注意到的规律", body: "快节奏的那 6 条里有 5 条在卡点。真正抓住你的也许不是“快”本身，而是画面和节拍同步的那一瞬间。", evidence: ["#6f9a8d", "#b5542c", "#2449ff"] },
    { title: "下一条可以这样拍", body: "选一个日常物件当主角，3D 渲染加硬光，每个切点对齐鼓点，在 15 秒内完成一次“从平凡到奇观”的变化。", evidence: ["#8a6fae", "#ff4d1a"] }
  ],
  pull_quote: "光要硬，切要准。"
};

function statsAppendix(s) {
  return h("details", { class: "card mz-data" },
    h("summary", {}, `数据附录 · ${s.total} 条收藏的风格统计`),
    h("div", { class: "bars", style: { marginTop: "14px" } }, s.dims.filter((d) => d.top.length).map((d) => [
      h("div", { class: "k" }, d.label),
      h("div", { class: "v" }, d.top.map(([v, n]) => h("span", {}, h("span", { class: "bar", style: { width: Math.max(8, (n / s.total) * 120) + "px" } }), `${v} `, h("span", { class: "muted" }, n))))])),
    s.picks.length ? h("div", { style: { marginTop: "16px" } }, h("div", { class: "label" }, "你亲自勾选的喜欢点"),
      h("div", { class: "row" }, s.picks.map(([t, n]) => h("span", { class: "chip on", style: { cursor: "default" } }, `${t} · ${n}`)))) : null);
}

function pageReport() {
  const list = done();
  if (list.length < REPORT_MIN) {
    return h("div", { class: "page" }, h("h1", {}, "审美报告"),
      h("div", { class: "card" },
        h("div", { class: "meter" }, h("span", { style: { width: (list.length / REPORT_MIN) * 100 + "%" } })),
        h("p", { class: "muted", style: { margin: 0 } }, `再收藏 ${REPORT_MIN - list.length} 条视频，就可以生成你的审美报告。收藏时顺手勾选“喜欢点”，报告会更准。下面是攒满之后报告的样子（虚构示例）：`)),
      magazine(SAMPLE_REPORT, { sample: true, issue: 1, total: 10 }));
  }
  const s = computeStats(list);
  const rep = data.lastReport;
  const msg = h("span", { class: "muted" });
  const btn = h("button", { class: rep ? "" : "primary", onclick: async () => {
    btn.disabled = true; btn.textContent = "正在写…"; msg.textContent = "大约半分钟";
    try {
      const j = parseJSON(await generate([{ text: reportPrompt(s, list) }], { json: true, role: "plan" }));
      if (!j.headline || !Array.isArray(j.sections)) throw new Error("模型返回的报告不完整，请重试");
      const issue = ((rep && rep.issue) || 0) + 1;
      data.lastReport = { json: j, at: Date.now(), total: s.total, issue };
      await chrome.storage.local.set({ lastReport: data.lastReport });
      render(true);
    } catch (e) { msg.textContent = "生成失败：" + e.message; btn.disabled = false; btn.textContent = rep ? "写一期新的" : "生成我的审美报告"; }
  } }, rep ? "写一期新的" : "生成我的审美报告");
  const untagged = s.total - s.tagged;
  const onIdea = rep && rep.json ? () => {
    const ids = [...new Set((rep.json.sections || []).flatMap((x) => x.evidence || []))].filter((id) => itemById(id));
    ui.ideaSubject = rep.json.next_subject || (rep.json.sections[2] || {}).body || "";
    ui.ideaIds = ids.length ? ids : list.slice(0, 6).map((x) => x.id);
    render(true);
    setTimeout(() => document.querySelector(".idea")?.scrollIntoView({ behavior: "smooth", block: "center" }), 50);
  } : null;
  return h("div", { class: "page" },
    h("div", { class: "spread" }, h("h1", {}, "审美报告"), h("div", { class: "row" }, msg, btn)),
    rep && rep.json ? magazine(rep.json, { issue: rep.issue || 1, total: rep.total, onIdea })
      : rep && rep.text ? h("div", { class: "card" }, h("div", { class: "label" }, "旧版报告（点右上角“写一期新的”换成新样式）"), h("div", { class: "report-text" }, rep.text))
      : h("div", { class: "card muted" }, "点右上角，生成你的第一期审美报告。"),
    rep && rep.json && ui.ideaIds ? h("div", { class: "card idea" }, h("div", { class: "label" }, "按报告的建议设计一条新视频（参考报告里提到的收藏）"),
      composer({ itemIds: ui.ideaIds, label: "开始", subject: ui.ideaSubject, open: true })) : null,
    rep && rep.at ? h("div", { class: "muted", style: { textAlign: "center" } }, `基于 ${rep.total} 条收藏 · ${relTime(rep.at)}生成`) : null,
    untagged ? h("div", { class: "card spread" },
      h("div", {}, h("h3", {}, `还有 ${untagged} 条没勾选喜欢点`), h("div", { class: "muted" }, "AI 标签只是旁证，你亲自勾选的才最能代表你的审美。")),
      h("button", { onclick: () => { ui.filter = "untagged"; go("collection"); } }, "去补填")) : null,
    statsAppendix(s));
}

// ---------- 风格分组 ----------
const uid = () => Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
async function saveGroups(sg) { data.styleGroups = sg; await chrome.storage.local.set({ styleGroups: sg }); }
async function savePlans(plans) { data.plans = plans; await chrome.storage.local.set({ plans }); }
const itemById = (id) => data.items.find((x) => x.id === id && x.status === "done");

async function runGrouping(btn, msg) {
  const list = done();
  const had = data.styleGroups && data.styleGroups.groups.length;
  if (had && !confirm("重新分组会覆盖现在的分组（包括你手动调整过的）。继续？")) return;
  btn.disabled = true; btn.textContent = "AI 正在分组…"; msg.textContent = `正在比较 ${list.length} 条收藏的风格，大约半分钟…`;
  try {
    const j = parseJSON(await generate([{ text: groupPrompt(list, data.picks) }], { json: true, role: "plan" }));
    const ids = new Set(list.map((x) => x.id)), used = new Set();
    const groups = (Array.isArray(j.groups) ? j.groups : []).map((g) => ({
      id: uid(), name: String(g.name || "未命名分组").slice(0, 20), desc: String(g.description || ""), core: String(g.core || ""),
      itemIds: (Array.isArray(g.item_ids) ? g.item_ids : []).map(String).filter((id) => ids.has(id) && !used.has(id) && used.add(id))
    })).filter((g) => g.itemIds.length >= 2); // 一条成不了组，留在“未分组”
    if (!Array.isArray(j.groups)) throw new Error("模型没有返回有效的分组，请重试");
    await saveGroups({ at: Date.now(), total: list.length, groups });
    render(true);
    const lone = list.length - groups.reduce((n, g) => n + g.itemIds.length, 0);
    toast(groups.length ? `分好了 ${groups.length} 组${lone ? `，${lone} 条风格独特、暂不归组` : ""}` : "这些收藏风格差异较大，暂时没有可以归为一组的");
  } catch (e) { msg.textContent = "分组失败：" + e.message; btn.disabled = false; btn.textContent = had ? "AI 重新分组" : "AI 帮我分组"; }
}

async function moveItem(itemId, toGroupId) {
  const sg = structuredClone(data.styleGroups || { at: Date.now(), groups: [] });
  for (const g of sg.groups) g.itemIds = g.itemIds.filter((id) => id !== itemId);
  if (toGroupId === "__new") {
    const name = prompt("新分组的名字（例如：产品宣传·冷峻科技感）");
    if (!name) return render(true);
    sg.groups.push({ id: uid(), name: name.slice(0, 20), desc: "", core: "", itemIds: [itemId] });
  } else {
    const g = sg.groups.find((x) => x.id === toGroupId);
    if (g) g.itemIds.push(itemId);
  }
  sg.groups = sg.groups.filter((g) => g.itemIds.length);
  await saveGroups(sg); render(true);
}

function memberCard(x, groupId) {
  const sel = h("select", { class: "move", onchange: () => moveItem(x.id, sel.value) },
    (data.styleGroups ? data.styleGroups.groups : []).map((g) => h("option", { value: g.id, ...(g.id === groupId ? { selected: "" } : {}) }, "归入：" + g.name)),
    h("option", { value: "", ...(!groupId ? { selected: "" } : {}) }, "未分组"),
    h("option", { value: "__new" }, "＋ 新建分组…"));
  return h("div", { class: "member" },
    h("div", { class: "thumb", style: bg(x.result.thumb), onclick: () => go("item/" + x.id) }),
    h("div", { class: "mt", onclick: () => go("item/" + x.id) }, displayTitle(x)), sel);
}

function groupCard(g) {
  const members = g.itemIds.map(itemById).filter(Boolean);
  const rename = async () => {
    const name = prompt("分组名字", g.name); if (!name) return;
    const sg = structuredClone(data.styleGroups); sg.groups.find((x) => x.id === g.id).name = name.slice(0, 20); await saveGroups(sg); render(true);
  };
  return h("div", { class: "card" },
    h("div", { class: "spread" }, h("h2", {}, g.name, h("span", { class: "muted", style: { fontWeight: 400 } }, `  ${members.length} 条`)),
      h("button", { class: "small ghost", onclick: rename }, "改名")),
    g.desc ? h("p", { class: "muted", style: { margin: "6px 0 0" } }, g.desc) : null,
    g.core ? h("div", { style: { marginTop: "12px" } }, h("div", { class: "label" }, "这组的共同风格"), h("div", { class: "prompt" }, g.core)) : null,
    h("div", { class: "members" }, members.map((x) => memberCard(x, g.id))),
    h("div", { class: "row", style: { marginTop: "16px" } },
      h("button", { class: "primary", onclick: (e) => distillCard(members.map((x) => x.id), g.name, e.currentTarget) }, "提炼成风格卡"),
      composer({ itemIds: members.map((x) => x.id), groupId: g.id, label: "直接用这组做视频" })));
}

function pageGroups() {
  const list = done();
  const sg = data.styleGroups;
  const grouped = new Set((sg ? sg.groups : []).flatMap((g) => g.itemIds));
  const loose = list.filter((x) => !grouped.has(x.id));
  const msg = h("span", { class: "muted" });
  const btn = h("button", { class: "primary", disabled: list.length < 3, onclick: () => runGrouping(btn, msg) }, sg ? "AI 重新分组" : "AI 帮我分组");
  const plans = (data.plans || []).slice(0, 20);
  return h("div", { class: "page" },
    h("div", {},
      h("h1", {}, "风格分组"),
      h("p", { class: "muted", style: { margin: "8px 0 16px" } },
        "AI 按“用途 · 风格”把收藏分组，你可以随时手动调整。做新视频时选一组，AI 会综合这组的风格手法，按你的主题设计一套新分镜。"),
      h("div", { class: "row" }, btn, msg,
        list.length < 3 ? h("span", { class: "muted" }, `至少需要 3 条已完成的收藏（现在 ${list.length} 条）`) : null,
        sg ? h("span", { class: "muted" }, `上次分组：${relTime(sg.at)}`) : null)),
    sg ? sg.groups.map(groupCard) : null,
    loose.length ? h("div", { class: "card" },
      h("h2", {}, "未分组", h("span", { class: "muted", style: { fontWeight: 400 } }, `  ${loose.length} 条`)),
      h("p", { class: "muted", style: { margin: "6px 0 0" } }, sg ? (sg.groups.length ? "风格独特、暂时找不到相近收藏的，以及分组之后新收藏的视频在这里。可以手动归入某组，收藏多了再点上面“AI 重新分组”。" : "这些收藏风格差异较大，暂时没有可以归为一组的。收藏多了再点“AI 重新分组”。") : "还没有分组。"),
      h("div", { class: "members" }, loose.map((x) => memberCard(x, null)))) : null,
    plans.length ? h("div", {},
      h("h2", { style: { marginBottom: "14px" } }, "我的分镜方案"),
      h("div", { class: "grid" }, plans.map((p) => h("div", { class: "vcard", onclick: () => go("plan/" + p.id) },
        h("div", { class: "body" }, h("div", { class: "vtitle" }, p.result.title || "未命名方案"),
          h("div", { class: "clamp2 muted" }, p.brief.subject),
          h("div", { class: "foot" }, h("span", {}, p.groupName || "单条参考"), h("span", {}, relTime(p.at)))))))) : null);
}

// ---------- 生成分镜方案 ----------
function pickRefs(ids) {
  const refs = ids.map(itemById).filter(Boolean);
  if (refs.length <= 6) return refs;
  // 太多时优先用户勾选过喜欢点的，再取最近的
  return refs.sort((a, b) => ((data.picks[b.id] || []).length - (data.picks[a.id] || []).length) || b.createdAt - a.createdAt).slice(0, 6);
}

function composer({ itemIds, groupId = null, cardId = null, label, subject: preset = "", open: autoOpen = false }) {
  const wrap = h("div", { class: "composer" });
  const open = () => {
    const subject = h("textarea", { rows: 3, placeholder: "你的主题/内容，例如：一款降噪耳机的新品宣传片，突出“世界安静下来”的感觉" }, preset);
    const duration = h("select", {}, [10, 15, 20, 30, 45, 60].map((n) => h("option", { value: n, ...(n === 15 ? { selected: "" } : {}) }, `约 ${n} 秒`)));
    const aspect = h("select", {}, ["竖屏 9:16", "横屏 16:9", "方形 1:1"].map((a) => h("option", { value: a }, a)));
    const extra = h("input", { type: "text", placeholder: "其他要求（可选）：比如结尾出现品牌名、不要人物出镜" });
    const msg = h("span", { class: "muted" });
    const go2 = h("button", { class: "primary", onclick: async () => {
      if (!subject.value.trim()) { subject.focus(); return; }
      const card = cardId ? (data.styleCards || []).find((c) => c.id === cardId) : null;
      const refs = card ? (card.itemIds || []).map(itemById).filter(Boolean) : pickRefs(itemIds);
      if (!refs.length && !card) { msg.textContent = "没有可参考的收藏"; return; }
      go2.disabled = true; go2.textContent = "正在设计分镜…"; msg.textContent = card ? `按风格卡「${card.name}」设计，大约半分钟` : `参考 ${refs.length} 条收藏，大约半分钟到一分钟`;
      const brief = { subject: subject.value.trim(), duration: Number(duration.value), aspect: aspect.value, extra: extra.value.trim() };
      try {
        const ask = card ? cardPlanPrompt(card, brief, refs) : planPrompt(refs, brief, data.picks);
        const pace = paceRule(refs, brief.duration);
        let j = parseJSON(await generate([{ text: ask }], { json: true, role: "plan" }));
        // 镜头数明显少于原片节奏（不到要求下限的七成）时，指出问题再要一次
        const got = Array.isArray(j.shots) ? j.shots.length : 0;
        if (pace.lo && got && got < pace.lo * 0.7 && !/慢|长镜头|少一点镜头/.test(brief.extra)) {
          msg.textContent = `第一版只有 ${got} 个镜头，比原片节奏慢，正在按原片速度重写…`;
          try {
            const j2 = parseJSON(await generate([{ text: ask + `\n\n注意：你上一次只写了 ${got} 个镜头，太慢了，没有达到【剪辑节奏】要求的至少 ${pace.lo} 个。请重写，镜头数必须达标。` }], { json: true, role: "plan" }));
            if (Array.isArray(j2.shots) && j2.shots.length > got) j = j2;
          } catch (_) {}
        }
        const norm = normalizeAnalysis({ video_visible: true, shots: j.shots, duration_sec: brief.duration, summary: j.concept || brief.subject });
        if (!norm.shots.length) throw new Error("模型没有返回分镜，请重试");
        const result = { title: String(j.title || "").slice(0, 20), concept: String(j.concept || ""), style_summary: String(j.style_summary || ""),
          shots: norm.shots.map((s, i) => ({ ...s, ref: String((j.shots[i] && j.shots[i].ref) || ""), difficulty: cleanDiff(j.shots[i] && j.shots[i].difficulty) })),
          soundtrack: String(j.soundtrack || ""), style_prompt_zh: String(j.style_prompt_zh || ""), style_prompt_en: String(j.style_prompt_en || "") };
        const g = groupId && data.styleGroups ? data.styleGroups.groups.find((x) => x.id === groupId) : null;
        const plan = { id: uid(), at: Date.now(), groupId, groupName: g ? g.name : "", cardId: card ? card.id : null, cardName: card ? card.name : "", itemIds: refs.map((x) => x.id), brief, result };
        await savePlans([plan, ...(data.plans || [])].slice(0, 100));
        go("plan/" + plan.id);
      } catch (e) { msg.textContent = "生成失败：" + e.message; go2.disabled = false; go2.textContent = "生成分镜方案"; }
    } }, "生成分镜方案");
    wrap.textContent = "";
    wrap.append(subject, h("div", { class: "row", style: { marginTop: "10px" } }, h("div", { style: { width: "140px" } }, duration), h("div", { style: { width: "150px" } }, aspect)),
      h("div", { style: { marginTop: "10px" } }, extra), h("div", { class: "row", style: { marginTop: "12px" } }, go2, msg));
    subject.focus();
  };
  wrap.append(h("button", { onclick: open }, label + " →"));
  if (autoOpen) open();
  return wrap;
}

// ---------- 分镜方案（画布） ----------
function planShotPrompt(p, s) {
  return [s.visual, s.action && s.action !== "静止" ? "动作：" + s.action : "", "运镜：" + (s.camera || "固定"), s.light ? "光影：" + s.light : ""]
    .filter(Boolean).join("；") + `。时长约 ${fmt(s.end - s.start)} 秒。` + (p.result.style_prompt_zh ? "\n风格：" + p.result.style_prompt_zh : "");
}
function refOf(p, s) {
  const m = /R(\d+)\s*[-–—]\s*(\d+)/i.exec(s.ref || "");
  if (!m) return null;
  const x = itemById(p.itemIds[Number(m[1]) - 1]);
  return x ? { x, shot: Number(m[2]) - 1 } : null;
}
// ---------- 分镜画面：生成并存在本机（IndexedDB） ----------
const idb = (() => {
  let opening;
  const open = () => opening || (opening = new Promise((res, rej) => {
    const r = indexedDB.open("style-lens", 1);
    r.onupgradeneeded = () => r.result.createObjectStore("images");
    r.onsuccess = () => res(r.result); r.onerror = () => rej(r.error);
  }));
  const run = async (mode, fn) => { const db = await open(); return new Promise((res, rej) => {
    const t = db.transaction("images", mode); const req = fn(t.objectStore("images"));
    t.oncomplete = () => res(req && req.result); t.onerror = () => rej(t.error); }); };
  return { get: (k) => run("readonly", (st) => st.get(k)), put: (k, v) => run("readwrite", (st) => st.put(v, k)), del: (k) => run("readwrite", (st) => st.delete(k)) };
})();
// ---------- 分镜方案：画面 / 视频 / 主体设定的本机状态 ----------
// IndexedDB：`${planId}:${i}` = { versions: [Blob], cur }，`${planId}:v:${i}` = { blob, url, dur }，`${planId}:subj` = [Blob]
const planState = {};
const cardUI = {}; // `${planId}:${i}` -> "edit" | "text" | "video" | "image"
const busy = {};   // `${planId}:${i}` -> 进度文字
const planGen = { id: null, stop: false, msg: "" };
// 画图/生成中的进度：已经显示着提示时只改文字，不重画整页
function setBusy(k, m) {
  const had = busy[k] !== undefined;
  busy[k] = m;
  const el = had && document.querySelector(`[data-busy="${CSS.escape(k)}"]`);
  if (el) el.textContent = m; else render(true);
}
const U = (b) => ({ blob: b, url: URL.createObjectURL(b) });
async function loadPlanState(p) {
  if (planState[p.id]) return;
  const st = planState[p.id] = { loaded: false, img: {}, vid: {}, subj: [], film: [], filmCur: -1 };
  for (let i = 0; i < p.result.shots.length; i++) {
    const v = await idb.get(p.id + ":" + i).catch(() => null);
    if (v instanceof Blob) st.img[i] = { versions: [U(v)], cur: 0 };
    else if (v && Array.isArray(v.versions) && v.versions.length) st.img[i] = { versions: v.versions.map((x) => x instanceof Blob ? U(x) : { ...U(x.blob), tier: x.tier, review: x.review }), cur: Math.min(v.cur || 0, v.versions.length - 1) };
    const c = await idb.get(p.id + ":v:" + i).catch(() => null);
    if (c && (c.blob || c.url)) st.vid[i] = { blob: c.blob || null, url: c.blob ? URL.createObjectURL(c.blob) : c.url, dur: c.dur };
  }
  const sj = await idb.get(p.id + ":subj").catch(() => null);
  if (Array.isArray(sj)) st.subj = sj.map(U);
  const fl = await idb.get(p.id + ":film").catch(() => null);
  st.film = Array.isArray(fl) ? fl.map((f) => ({ ...f, url: f.blob ? URL.createObjectURL(f.blob) : f.url })) : [];
  st.filmCur = st.film.length - 1;
  st.loaded = true;
  render(true);
}
const S_ = (p) => planState[p.id] || { img: {}, vid: {}, subj: [], film: [], filmCur: -1 };
const curImg = (p, i) => { const e = S_(p).img[i]; return e ? e.versions[e.cur] : null; };
const saveImgs = (p, i) => { const e = planState[p.id].img[i]; return idb.put(p.id + ":" + i, { versions: e.versions.map((v) => ({ blob: v.blob, tier: v.tier, review: v.review })), cur: e.cur }); };
const saveSubj = (p) => idb.put(p.id + ":subj", planState[p.id].subj.map((v) => v.blob));
async function pushVersion(p, i, blob, meta = {}) {
  const st = planState[p.id] || (planState[p.id] = { loaded: true, img: {}, vid: {}, subj: [], film: [], filmCur: -1 });
  const e = st.img[i] || (st.img[i] = { versions: [], cur: 0 });
  e.versions.push({ ...U(blob), ...meta });
  while (e.versions.length > 6) URL.revokeObjectURL(e.versions.shift().url); // 每镜最多留 6 个版本
  e.cur = e.versions.length - 1;
  await saveImgs(p, i);
}
async function updatePlan(p, patch) {
  const plans = data.plans.map((x) => (x.id === p.id ? { ...x, ...patch } : x));
  await savePlans(plans);
  render(true);
}
function b64ToBlob(img) {
  const bin = atob(img.data); const bytes = new Uint8Array(bin.length);
  for (let k = 0; k < bin.length; k++) bytes[k] = bin.charCodeAt(k);
  return new Blob([bytes], { type: img.mime });
}

async function blobToPart(blob) {
  const buf = new Uint8Array(await blob.arrayBuffer());
  let bin = ""; for (let i = 0; i < buf.length; i += 0x8000) bin += String.fromCharCode(...buf.subarray(i, i + 0x8000));
  return { inline_data: { mime_type: blob.type || "image/jpeg", data: btoa(bin) } };
}
async function ensureFrames(x) {
  if (!frameCache[x.id]) await loadSavedFrames(x);
  if ((!frameCache[x.id] || frameCache[x.id].status !== "done") && ((x.result || {}).shots || []).length && chrome.offscreen !== undefined && !bgUnsupported) {
    // 等后台截好（最多 6 分钟）
    await new Promise((res) => { (frameWaiters[x.id] ||= []).push(res); askFrames(x, false); setTimeout(res, 360000); });
    const y = itemById(x.id) || x; if (!frameCache[y.id]) await loadSavedFrames(y); x = y;
  }
  if (!frameCache[x.id] || frameCache[x.id].status !== "done") await extractFrames(x, () => {});
  return frameCache[x.id] && frameCache[x.id].status === "done" ? frameCache[x.id] : null;
}
function styleRefFrame(p, s) {
  const ref = refOf(p, s);
  if (ref) { const fc = frameCache[ref.x.id]; const f = fc && fc.shots[ref.shot]; if (f && f.mid) return f.mid.blob; }
  // “整体风格”的镜头：用第一条参考视频中间那个镜头的画面当风格参考
  const x = itemById(p.itemIds[0]); const fc = x && frameCache[x.id];
  if (fc && fc.status === "done") { const f = fc.shots[Math.floor(fc.shots.length / 2)]; return f && f.mid ? f.mid.blob : null; }
  return null;
}
const ratioOf = (a) => (/(\d+:\d+)/.exec(a || "") || [])[1] || "16:9";
// ---------- 难度 → 档位；画完自动检查 ----------
const DIFF_KEYS = ["face", "hands", "text", "multi", "physics", "recurring"];
const DIFF_LABEL = { face: "人脸", hands: "手部", text: "文字", multi: "多人互动", physics: "复杂物理", recurring: "主体一致" };
function cleanDiff(d) { return d && typeof d === "object" ? Object.fromEntries(DIFF_KEYS.map((k) => [k, d[k] === true || d[k] === "true"])) : null; }
// 规则：人脸/手部/文字/多人互动 任意一项 → 高；一个难点都没有 → 低；其余 → 中。没有难度信息的老方案一律中档
function shotTier(s) {
  const d = s.difficulty;
  if (!d) return { tier: "mid", why: "默认" };
  const hard = ["face", "hands", "text", "multi"].filter((k) => d[k]);
  if (hard.length) return { tier: "high", why: "有" + hard.map((k) => DIFF_LABEL[k]).join("、") };
  const mid = ["physics", "recurring"].filter((k) => d[k]);
  if (mid.length) return { tier: "mid", why: "有" + mid.map((k) => DIFF_LABEL[k]).join("、") };
  return { tier: "low", why: "没有难点（空镜/场景）" };
}
const CHECK_KEYS = [["content", "内容"], ["subject", "主体"], ["text", "文字"], ["anatomy", "人脸手部"], ["style", "风格"]];
// subjBlobs：主体参考图。有的话一起交给检查模型，对比生成的主角像不像
async function checkImage(p, s, blob, subjBlobs = []) {
  const hasSubj = subjBlobs.length > 0;
  const prompt = `你是分镜画面质检员。${hasSubj ? `第 1 张图是要检查的分镜画面，后面 ${subjBlobs.length} 张是主角的参考图。` : ""}看${hasSubj ? "第 1 张" : "这张"}图是否符合下面这个镜头的要求，按 1-5 分打分（5 最好）。
镜头要求：${s.visual}；动作：${s.action}；光影：${s.light || ""}
整体风格：${p.result.style_prompt_zh || ""}
${subjOf(p) ? "主体设定：" + subjOf(p) : ""}
评分项：content 画面内容是否符合要求；subject 主角/产品外观是否正确${hasSubj ? "：和参考图比，是不是同一个角色/产品（造型、比例、材质质感、配色、标志性细节）。明显是另一个造型或换了材质给 1-2 分，大体像但细节不对给 3 分；这一镜没有出现主角给 5 分" : ""}；text 画面里的文字是否正确（没有文字给 5 分）；anatomy 人脸和手是否自然、有没有畸形（没有人给 5 分）；style 是否符合整体风格。
只输出 JSON：{"content":5,"subject":5,"text":5,"anatomy":5,"style":5,"issue":"最主要的问题，一句话；没有就写空字符串"}`;
  const parts = [await blobToPart(blob)];
  for (const sb of subjBlobs) parts.push(await blobToPart(await toJpeg(sb)));
  const j = parseJSON(await generate([...parts, { text: prompt }], { json: true, role: "check" }));
  const sc = CHECK_KEYS.map(([k]) => Math.max(1, Math.min(5, Number(j[k]) || 3)));
  const pass = sc.every((x) => x >= 3) && sc.reduce((a, b) => a + b, 0) / sc.length >= 3.5;
  const worst = CHECK_KEYS[sc.indexOf(Math.min(...sc))][1];
  return { pass, scores: Object.fromEntries(CHECK_KEYS.map(([k], n) => [k, sc[n]])), issue: String(j.issue || "") || (pass ? "" : worst + "不达标") };
}
// 记一笔花费（元），用于预算
async function addSpent(p, cny) {
  const cur = fresh(p);
  const plans = data.plans.map((x) => (x.id === p.id ? { ...x, spent: Math.round(((cur.spent || 0) + cny) * 100) / 100 } : x));
  await savePlans(plans);
}
async function overBudget(p, est, what) {
  const budget = await getBudget(), spent = fresh(p).spent || 0;
  if (spent + est <= budget) return false;
  return !confirm(`${what}预计约 ${est.toFixed(1)} 元，这条视频已经花了约 ${spent.toFixed(1)} 元，加起来会超过这条视频的预算上限 ${budget} 元。\n继续？`);
}

// 生成或修改一镜的画面。instr 有值时 = 在当前画面上按要求修改；forceTier 用于自动升档重画
const fresh = (p) => (data.plans || []).find((x) => x.id === p.id) || p; // 总是用最新保存的方案（主体描述、改过的文字）
async function genShotImage(p, i, instr = "", forceTier = null, onStatus = null) {
  p = fresh(p);
  const stack = await getStack();
  const r = p.result, s = r.shots[i];
  const st = S_(p);
  const subjText = subjOf(p);
  const images = [], notes = [];
  const cur = curImg(p, i);
  const auto = shotTier(s);
  let tier = forceTier || auto.tier;
  let prompt;
  if (instr && cur) {
    if (tier === "low") tier = "mid"; // 改图至少用中档
    images.push(cur.blob);
    for (const sj of st.subj.slice(0, 2)) { images.push(sj.blob); notes.push(`第${images.length}张图是主体参考：画面里的主角/产品，外形、比例、材质质感、配色都要和这张图一致；修改要求或文字描述和这张图冲突时，以图为准。`); }
    prompt = `在第1张图的基础上修改：${instr}
除了要求修改的地方，构图、机位、光影、色调和画面其他内容尽量保持不变。
${subjText ? "主体设定：" + subjText + "\n" : ""}${notes.join("\n")}
要求：画幅 ${ratioOf(p.brief.aspect)}；画面里不要出现字幕、水印或无关文字。`;
  } else {
    let style = null;
    if (p.cardId) {
      // 风格卡方案：用风格卡的参考图板当风格参考，不再回头翻原视频
      const board = await loadBoard(p.cardId);
      if (board.length) style = board[i % board.length].blob;
    } else {
      const refs = new Set([refOf(p, s)?.x, itemById(p.itemIds[0])].filter(Boolean));
      for (const x of refs) await ensureFrames(x);
      style = styleRefFrame(p, s);
    }
    // 有主体参考图时放在最前面：模型对排在前面的图最重视
    if (st.subj.length) {
      const subjImgs = st.subj.slice(0, 2);
      for (const sj of subjImgs) images.push(sj.blob);
      notes.push(`第 1${subjImgs.length > 1 ? "、2" : ""} 张参考图是本片主角：画面里的主角要和它${subjImgs.length > 1 ? "们" : ""}是同一个角色/产品，外形、比例、材质质感（例如像素方块、毛绒、金属）、配色和标志性细节都严格照图，不要重新设计、不要换成别的风格。文字描述里对主角外形的说法和图冲突时，一律以图为准；文字只决定主角的动作、位置和场景。主角可以按整体风格调整光影，但造型不能变。如果这一镜的画面内容里没有主角（例如空镜、场景镜头），就不要把主角加进画面。`);
    }
    if (style) { images.push(style); notes.push(`第${images.length}张参考图是风格参考：学习它的质感、色彩、光影和构图方式，但不要照搬里面的具体人物、物体、文字和标志，画面内容必须是新主题。`); }
    if (!st.subj.length) {
      const first = curImg(p, 0);
      if (i > 0 && first) { images.push(first.blob); notes.push(`第${images.length}张参考图是本片第 1 镜已生成的画面：保持主角/产品的外观、配色和整体调性一致。`); }
    }
    prompt = `生成一张短视频分镜画面：新视频第 ${i + 1}/${r.shots.length} 镜（约 ${fmt(s.end - s.start)} 秒）的开场画面。
新视频主题：${p.brief.subject}
${subjText ? "主体设定（必须遵守）：" + subjText + "\n" : ""}画面内容：${s.visual}
主体动作（定格在动作开始的瞬间）：${s.action}
构图与运镜起点：${s.camera}
光影色彩：${s.light || ""}
整体风格：${r.style_prompt_zh || ""}
${notes.join("\n")}
要求：画幅 ${ratioOf(p.brief.aspect)}；电影级画质；画面里不要出现字幕、水印或无关文字。`;
  }
  onStatus && onStatus(`正在画（${TIER_LABEL[tier]}档）…`);
  const out = await makeImage({ images, prompt, aspect: ratioOf(p.brief.aspect), tier });
  await addSpent(p, imageCost(stack, out.tier));
  const why = forceTier ? "上一版没通过检查，自动升档" : instr ? "修改画面" : auto.why;
  // 自动检查：只检查新画的（修改画面是你主动要求的，不自动改）；不合格升一档重画一次
  let review = null;
  if (!instr) {
    try { onStatus && onStatus("正在检查画面…"); review = await checkImage(p, s, out.blob, st.subj.slice(0, 2).map((x) => x.blob)); } catch (e) { console.warn("画面检查失败", e); review = null; }
  }
  await pushVersion(p, i, out.blob, { tier: out.tier, why, review });
  if (review && !review.pass && !forceTier && stack === "atlas") { // 自定义方案只有一个画图模型，升档没有意义，只提示
    const up = nextTier(out.tier);
    if (up) return genShotImage(p, i, "", up, onStatus);
  }
}

function clipPrompt(p, s) {
  const subj = subjOf(p);
  return [planShotPrompt(p, s), subj ? "主体：" + subj : "", "镜头从首帧画面开始，按上面的动作和运镜自然展开；不要出现字幕和水印。"].filter(Boolean).join("\n");
}
async function genClip(p, i, onStatus, isStopped) {
  p = fresh(p);
  const s = p.result.shots[i];
  const img = curImg(p, i);
  const out = await generateClip({ prompt: clipPrompt(p, s), imageBlob: img && img.blob, duration: s.end - s.start, ratio: ratioOf(p.brief.aspect) }, onStatus, isStopped);
  const st = planState[p.id];
  if (st.vid[i] && st.vid[i].blob) URL.revokeObjectURL(st.vid[i].url);
  st.vid[i] = { blob: out.blob, url: out.blob ? URL.createObjectURL(out.blob) : out.url, dur: out.duration };
  await idb.put(p.id + ":v:" + i, out.blob ? { blob: out.blob, dur: out.duration } : { url: out.url, dur: out.duration, at: Date.now() });
  if (!out.blob) toast("视频已生成，但没能下载到本机：在线地址 24 小时后失效，请尽快导出");
}

async function runBatch(p, label, todo, fn) {
  if (planGen.id) return;
  planGen.id = p.id; planGen.stop = false;
  let fails = 0;
  try {
    for (let k = 0; k < todo.length; k++) {
      if (planGen.stop) break;
      const i = todo[k];
      planGen.msg = `${label} ${k + 1}/${todo.length}（第 ${i + 1} 镜）…`; render(true);
      try { await fn(i, (m) => setBusy(p.id + ":" + i, m)); }
      catch (e) { fails++; planGen.msg = `第 ${i + 1} 镜失败：${e.message}`; toast(planGen.msg); if (k === 0 && /Key|权限|开通|模型/.test(e.message)) break; }
      finally { delete busy[p.id + ":" + i]; }
    }
  } finally { planGen.id = null; if (!fails) planGen.msg = ""; render(true); }
}
async function genAllImages(p, onlyMissing) {
  const todo = p.result.shots.map((_, i) => i).filter((i) => !onlyMissing || !curImg(p, i));
  const stack = await getStack();
  const est = todo.reduce((a, i) => a + imageCost(stack, shotTier(p.result.shots[i]).tier), 0);
  if (await overBudget(p, est, `画 ${todo.length} 张画面`)) return;
  return runBatch(p, "正在画", todo, (i, st) => genShotImage(p, i, "", null, st));
}
// 个人实名账号同时最多 3 个任务，视频一次并行 3 段
async function genAllClips(p, onlyMissing) {
  if (planGen.id) return;
  const todo = p.result.shots.map((_, i) => i).filter((i) => !onlyMissing || !S_(p).vid[i]);
  planGen.id = p.id; planGen.stop = false;
  let doneN = 0, fails = 0, stopAll = false;
  const update = () => { planGen.msg = `正在生成视频：已完成 ${doneN}/${todo.length}，同时进行最多 3 段`; render(true); };
  update();
  const worker = async () => {
    while (todo.length && !planGen.stop && !stopAll) {
      const i = todo.shift();
      const k = p.id + ":" + i;
      try { await genClip(p, i, (m) => setBusy(k, m), () => planGen.stop); }
      catch (e) { fails++; planGen.msg = `第 ${i + 1} 镜失败：${e.message}`; toast(planGen.msg); if (/Key|权限|开通|余额/.test(e.message)) stopAll = true; }
      finally { delete busy[k]; doneN++; if (!fails) update(); }
    }
  };
  try { await Promise.all([worker(), worker(), worker()]); }
  finally { planGen.id = null; if (!fails) planGen.msg = ""; render(true); }
}

async function oneShot(p, i, label, fn) {
  const k = p.id + ":" + i;
  if (busy[k]) return;
  busy[k] = label; render(true);
  try { await fn((m) => setBusy(k, m)); cardUI[k] = null; }
  catch (e) { toast(label.replace(/…$/, "") + "失败：" + e.message); }
  finally { delete busy[k]; render(true); }
}

// ---------- 成片：按原镜头长度截取并连起来 ----------
function clipList(p) {
  return p.result.shots.map((s, i) => ({ i, len: Math.max(0.3, s.end - s.start), v: S_(p).vid[i], img: curImg(p, i) }));
}
function previewPlayer(p) {
  const list = clipList(p);
  const missing = list.filter((c) => !c.v).map((c) => c.i + 1);
  const v = h("video", { playsinline: "", controls: "" });
  const cap = h("div", { class: "muted", style: { marginTop: "6px" } });
  let k = -1;
  const next = () => {
    k++;
    while (k < list.length && !list[k].v) k++;
    if (k >= list.length) { cap.textContent = "播放完毕"; k = -1; return; }
    cap.textContent = `第 ${list[k].i + 1} 镜 · 截取前 ${fmt(list[k].len)} 秒`;
    v.src = list[k].v.url; v.currentTime = 0; v.play().catch(() => {});
  };
  v.addEventListener("timeupdate", () => { if (k >= 0 && v.currentTime >= list[k].len) next(); });
  v.addEventListener("ended", () => { if (k >= 0) next(); });
  const play = h("button", { class: "primary", onclick: () => { k = -1; next(); } }, "▶ 从头播放");
  return h("div", { class: "preview" }, h("div", { class: "pv" }, v),
    h("div", { class: "row", style: { marginTop: "10px" } }, play, cap),
    missing.length ? h("p", { class: "muted", style: { margin: "6px 0 0" } }, `第 ${missing.join("、")} 镜还没有视频，播放时会跳过。`) : null);
}
// 在浏览器里把各段视频按原镜头长度拼起来录成一个文件（实时录制，片长多少秒就要等多少秒）
async function exportFilm(p, onStatus) {
  const list = clipList(p).filter((c) => c.v);
  if (!list.length) throw new Error("还没有生成任何视频片段");
  const first = document.createElement("video"); first.muted = true; first.src = list[0].v.url;
  await new Promise((r, j) => { first.onloadedmetadata = r; first.onerror = () => j(new Error("视频读取失败")); });
  const W = first.videoWidth || 720, H = first.videoHeight || 1280;
  const canvas = document.createElement("canvas"); canvas.width = W; canvas.height = H;
  const ctx = canvas.getContext("2d");
  const type = ["video/mp4;codecs=avc1", "video/mp4", "video/webm;codecs=vp9", "video/webm"].find((t) => MediaRecorder.isTypeSupported(t));
  const rec = new MediaRecorder(canvas.captureStream(30), { mimeType: type, videoBitsPerSecond: 8e6 });
  const chunks = []; rec.ondataavailable = (e) => e.data.size && chunks.push(e.data);
  const stopped = new Promise((r) => (rec.onstop = r));
  rec.start(500);
  for (const c of list) {
    onStatus(`正在合成第 ${c.i + 1} 镜…`);
    const v = document.createElement("video"); v.muted = true; v.playsInline = true; v.src = c.v.url;
    await new Promise((r, j) => { v.oncanplay = r; v.onerror = () => j(new Error("视频读取失败")); });
    await v.play();
    await new Promise((resolve) => {
      const draw = () => {
        // 等比铺满画布
        const s = Math.max(W / v.videoWidth, H / v.videoHeight), w = v.videoWidth * s, hh = v.videoHeight * s;
        ctx.drawImage(v, (W - w) / 2, (H - hh) / 2, w, hh);
        if (v.currentTime >= c.len || v.ended) { v.pause(); resolve(); } else requestAnimationFrame(draw);
      };
      draw();
    });
  }
  rec.stop(); await stopped;
  const ext = type.includes("mp4") ? "mp4" : "webm";
  saveBlob(new Blob(chunks, { type: type.split(";")[0] }), `成片-${(p.result.title || "未命名").replace(/[\\/:*?"<>|\s]+/g, "")}.${ext}`);
}

async function exportPlanPack(p) {
  const r = p.result;
  const files = [{ name: "00_使用说明.txt", data: `这个包里有什么
- 分镜画面/：每个镜头当前选中的画面
- 视频片段/：每个镜头生成的视频（比原镜头长，剪辑时按「剪辑表.txt」截取前 N 秒）
- 分镜提示词.txt：每个镜头的提示词
插件里的“导出成片”可以直接得到拼好的无声成片；想加音乐和字幕，可以把成片或片段放进剪映。` }];
  const lines = [`${r.title}｜${r.concept}`, `主题：${p.brief.subject}｜约 ${p.brief.duration} 秒｜${p.brief.aspect}`, subjOf(p) ? "主体：" + subjOf(p) : "", ""];
  const edl = ["剪辑表：按顺序摆放，每段只用前面的秒数", ""];
  for (const [i, s] of r.shots.entries()) {
    const im = curImg(p, i), vd = S_(p).vid[i];
    if (im) files.push({ name: `分镜画面/镜头${pad(i + 1)}.${(im.blob.type.split("/")[1] || "png").replace("jpeg", "jpg")}`, data: im.blob });
    if (vd && vd.blob) files.push({ name: `视频片段/镜头${pad(i + 1)}.mp4`, data: vd.blob });
    lines.push(`【镜头${pad(i + 1)}】${fmt(s.start)}s – ${fmt(s.end)}s`, clipPrompt(p, s), "声音：" + s.audio, "");
    edl.push(`镜头${pad(i + 1)}：用前 ${fmt(s.end - s.start)} 秒${vd ? "" : "（还没有视频）"}`);
  }
  lines.push("配乐与音效：" + r.soundtrack, "", r.style_prompt_zh, r.style_prompt_en);
  files.push({ name: "分镜提示词.txt", data: lines.join("\n") }, { name: "剪辑表.txt", data: edl.join("\n") });
  saveBlob(await makeZip(files), `分镜方案-${(r.title || "未命名").replace(/[\\/:*?"<>|\s]+/g, "")}.zip`);
}

// ---------- 主体设定 ----------
// ---------- 整片一次生成：所有分镜画面作为参考图，一次生成一条带连贯音乐的视频 ----------
const filmUI = { busy: null, msg: "" };
// 等待中只改提示文字，不重画整个页面（否则每隔几秒整片框会闪一下）
function setFilmMsg(m) {
  filmUI.msg = m;
  const el = document.querySelector(".film .filmmsg");
  if (el) el.textContent = m; else render(true);
}
// 同步读取（数据在页面加载时已经读好），这样整片框可以一次画好，不会每次刷新都闪一下
function filmSettingsSync(p) {
  const s = data.film || {};
  const provider = s.videoProvider === "atlas" || data.stack === "atlas" ? "atlas" : "ark";
  const list = provider === "atlas" ? ATLAS_FILM_MODELS : FILM_MODELS;
  const chosen = list.some(([v]) => v === s.filmModel) ? s.filmModel : list[0][0];
  let model = chosen, why = "";
  if (chosen === "auto") ({ model, why } = autoFilmModel(p));
  const is25 = /seedance-2\.5/.test(model);
  const resolution = provider === "atlas" ? (is25 ? "draft" : "720p") : s.filmResolution || "480p";
  return { provider, list, chosen, model, why, resolution, audio: s.filmAudio !== false };
}
async function filmSettings(p) { return filmSettingsSync(p); }
// 整片自动选模型：片长超过 15 秒、超过三成镜头有复杂物理、或有人脸+多人互动的镜头 → 2.5；其余 → 2.0 Fast 720p
function autoFilmModel(p) {
  const shots = p.result.shots;
  const total = Math.max(...shots.map((x) => x.end), 1);
  const phys = shots.filter((s) => s.difficulty && s.difficulty.physics).length / shots.length;
  const people = shots.some((s) => s.difficulty && s.difficulty.face && s.difficulty.multi);
  if (total > 15.5) return { model: ATLAS_25, why: `片长 ${fmt(total)} 秒，超过 2.0 的 15 秒上限` };
  if (phys > 0.3) return { model: ATLAS_25, why: "超过三成镜头有复杂物理效果" };
  if (people) return { model: ATLAS_25, why: "有多人互动的人物镜头" };
  return { model: ATLAS_20F, why: "难度一般，用 2.0 Fast 就够" };
}
// 统一成人民币显示
function filmCost(fs_, seconds) {
  if (fs_.provider === "atlas") { const usd = atlasCostUSD(fs_.model, fs_.resolution, seconds); return usd == null ? null : { cny: usd * USD_CNY, text: `约 $${usd.toFixed(2)}（≈${(usd * USD_CNY).toFixed(1)} 元）` }; }
  const c = estimateCost(fs_.model, fs_.resolution, seconds); return c == null ? null : { cny: c, text: `约 ${c.toFixed(1)} 元` };
}
function filmPlan(p, model, provider) {
  const lim = filmLimits(model);
  const tag = provider === "atlas" ? "@image" : "@图像"; // Atlas 的提示词里用 @image1 指代参考图
  const st = S_(p), r = p.result;
  const total = Math.max(...r.shots.map((x) => x.end), 1);
  const dur = Math.min(lim.maxDur, Math.max(lim.minDur, Math.round(total)));
  const k = dur / total; // 片长超过上限时，按比例压缩时间线
  // 参考图：主体参考最多 2 张，其余给分镜画面；镜头太多时均匀挑选
  const subj = st.subj.slice(0, 2).map((x) => x.blob);
  const withImg = r.shots.map((_, i) => i).filter((i) => curImg(p, i));
  const room = lim.maxImages - subj.length;
  const pick = withImg.length <= room ? withImg : Array.from({ length: room }, (_, j) => withImg[Math.round((j * (withImg.length - 1)) / Math.max(1, room - 1))]);
  const picked = [...new Set(pick)];
  const images = [...subj, ...picked.map((i) => curImg(p, i).blob)];
  const imgNo = Object.fromEntries(picked.map((i, j) => [i, subj.length + j + 1]));
  const subjText = subjOf(p);
  // 节奏：镜头数、平均几秒一切。连续的极短镜头（不到 0.8 秒）合成一组“闪切”来写，模型更容易照做
  const n = r.shots.length, avgLen = dur / n;
  const fastCut = avgLen < 1.2;
  const lenOf = (s) => (s.end - s.start) * k;
  const one = (s, i) => `${imgNo[i] ? `画面参考 ${tag}${imgNo[i]}。` : ""}${s.visual}`;
  const lines = [];
  for (let i = 0; i < n; i++) {
    const s = r.shots[i];
    let j = i;
    while (j - i < 5 && j + 1 < n && lenOf(r.shots[j]) < 0.8 && lenOf(r.shots[j + 1]) < 0.8) j++;
    if (j > i) {
      const g = r.shots.slice(i, j + 1);
      lines.push(`镜头${i + 1}–${j + 1}（${(s.start * k).toFixed(1)}–${(r.shots[j].end * k).toFixed(1)}秒）：快速闪切 ${g.length} 个画面，每个约 ${(g.reduce((a, x) => a + lenOf(x), 0) / g.length).toFixed(1)} 秒，硬切、一个接一个：${g.map((x, q) => `${"①②③④⑤⑥⑦⑧⑨⑩"[q] || `(${q + 1})`}${one(x, i + q)}`).join(" ")}；声音：${s.audio}`);
      i = j;
    } else {
      lines.push(`镜头${i + 1}（${(s.start * k).toFixed(1)}–${(s.end * k).toFixed(1)}秒）：${one(s, i)}；动作：${s.action}；运镜：${s.camera}${s.light ? "；光影：" + s.light : ""}；声音：${s.audio}`);
    }
  }
  const rhythm = `全片共 ${n} 个镜头，平均每 ${avgLen.toFixed(1)} 秒切一次${fastCut ? "，是快剪风格" : ""}。严格按下面的秒数切换：每个镜头到时间就硬切到下一个，不要放慢节奏，不要把几个镜头合成一个长镜头，${fastCut ? "不要加溶解、淡入淡出等转场，" : "除非分镜里写明，否则不加溶解、淡入淡出等转场，"}切点卡在音乐节拍上。`;
  const prompt = `按下面的分镜，生成一条 ${dur} 秒短视频，画幅 ${ratioOf(p.brief.aspect)}。
${rhythm}配乐和音效贯穿全片，节奏跟着画面切换走。
主题：${p.brief.subject}
整体风格：${r.style_prompt_zh || ""}
${subjText || subj.length ? `主体：${subjText}${subj.length ? `（主角就是 ${subj.map((_, j) => tag + (j + 1)).join("、")} 里的角色/产品，外形、比例、材质、配色全片严格照图、保持不变，文字描述和图冲突时以图为准）` : ""}\n` : ""}分镜：
${lines.join("\n")}
配乐与音效：${r.soundtrack || "与画面风格一致"}
不要出现字幕、水印或无关文字。`;
  return { dur, compressed: k < 0.999, total, images, avgLen, shotCount: n, imgCount: images.length, missing: r.shots.length - withImg.length, prompt };
}
const modelName = (m) => String(m || "").replace("doubao-seedance-", "Seedance ").replace(/-\d{6}$/, "").replace(/^bytedance\/seedance-([\w.-]+)\/(reference-to-video|draft-complete)$/, "Seedance $1");
async function saveFilms(p) {
  const st = planState[p.id];
  while (st.film.length > 6) st.film.shift();
  await idb.put(p.id + ":film", st.film.map(({ url, ...f }) => (f.blob ? f : { ...f, url })));
}
async function runFilm(p) {
  p = fresh(p);
  const fs_ = await filmSettings(p);
  const plan = filmPlan(p, fs_.model, fs_.provider);
  const cost = filmCost(fs_, plan.dur);
  const is25 = fs_.provider === "atlas" && /seedance-2\.5/.test(fs_.model);
  if (!confirm(`用 ${fs_.provider === "atlas" ? "Atlas Cloud · " : "火山方舟 · "}${modelName(fs_.model)} 一次生成 ${plan.dur} 秒整片（${is25 ? "先出 480p 草稿，满意再转 1080p" : fs_.resolution}${fs_.audio ? "，带音乐音效" : "，无声"}），参考图 ${plan.imgCount} 张。${fs_.why ? `\n自动选择原因：${fs_.why}。` : ""}${cost ? `\n预计${cost.text}。` : ""}${plan.missing ? `\n注意：有 ${plan.missing} 个镜头还没有画面，这些镜头只按文字生成。` : ""}${plan.compressed ? `\n分镜总长 ${fmt(plan.total)} 秒，超过这个模型的上限，会按比例压缩到 ${plan.dur} 秒。` : ""}\n继续？`)) return;
  if (cost && await overBudget(p, cost.cny, "这次整片")) return;
  filmUI.busy = p.id; filmUI.msg = "正在提交…"; render(true);
  try {
    const out = await generateFilm({ ...fs_, prompt: plan.prompt, images: plan.images, duration: plan.dur, ratio: ratioOf(p.brief.aspect) },
      setFilmMsg, () => false);
    if (cost) await addSpent(p, cost.cny);
    const st = planState[p.id];
    st.film.push({ blob: out.blob, url: out.blob ? URL.createObjectURL(out.blob) : out.url, remote: out.url, model: fs_.model, res: out.draft ? "480p 草稿" : fs_.resolution, dur: out.duration, at: Date.now(),
      ...(out.draft ? { draftId: out.taskId } : {}) });
    st.filmCur = st.film.length - 1;
    await saveFilms(p);
    filmUI.msg = out.blob ? (out.draft ? "草稿好了。满意的话点“转成 1080p 正式版”，画面内容会保持一致。" : "") : "已生成，但没能下载到本机：在线地址 24 小时后失效，请尽快下载";
  } catch (e) { filmUI.msg = "整片生成失败：" + e.message; }
  finally { filmUI.busy = null; render(true); }
}
async function finalizeDraft(p, f) {
  p = fresh(p);
  const usd = atlasCostUSD(ATLAS_25, "complete", f.dur || 5), cny = usd * USD_CNY;
  if (!confirm(`把这版草稿转成 1080p 正式版（${f.dur} 秒），画面内容和草稿保持一致。\n预计约 $${usd.toFixed(2)}（≈${cny.toFixed(1)} 元）。继续？`)) return;
  if (await overBudget(p, cny, "转正式版")) return;
  filmUI.busy = p.id; filmUI.msg = "正在转正式版…"; render(true);
  try {
    const out = await completeDraft(f.draftId, setFilmMsg);
    await addSpent(p, cny);
    const st = planState[p.id];
    f.finalized = true;
    st.film.push({ blob: out.blob, url: out.blob ? URL.createObjectURL(out.blob) : out.url, remote: out.url, model: "bytedance/seedance-2.5/draft-complete", res: "1080p 正式版", dur: f.dur, at: Date.now(), ...(f.note ? { note: f.note } : {}) });
    st.filmCur = st.film.length - 1;
    await saveFilms(p);
    filmUI.msg = out.blob ? "" : "已生成，但没能下载到本机：在线地址 24 小时后失效，请尽快下载";
  } catch (e) { console.warn("转正式版失败", e); filmUI.msg = "转正式版失败：" + e.message + (/not found|不存在|expired|过期/i.test(e.message) ? "（草稿可能已超过 7 天）" : ""); }
  finally { filmUI.busy = null; render(true); }
}
// ---------- 修改已生成的视频：在原视频上改（edit）或往后延长（extend），只支持 Atlas ----------
const editUI = { text: "", mode: "edit", secs: 5 };
async function runEdit(p, f) {
  p = fresh(p);
  const ext = editUI.mode === "extend";
  const ask = editUI.text.trim();
  if (!ext && !ask) { toast("先写一下想改哪里"); document.querySelector(".film .editask")?.focus(); return; }
  if (!ext && !(f.dur >= 4)) { toast("原视频不到 4 秒，模型改不了"); return; }
  if (f.dur > 30) { toast("原视频超过 30 秒，模型改不了"); return; }
  const outSec = ext ? editUI.secs : f.dur || 5;
  const usd = editCostUSD(outSec), cny = usd * USD_CNY;
  if (!confirm(`${ext ? `把第 ${S_(p).filmCur + 1} 版往后延长 ${outSec} 秒` : `在第 ${S_(p).filmCur + 1} 版上修改：“${ask}”`}\n用 Seedance 2.5，先出 480p 草稿，满意再转 1080p 正式版（另计费）。原版本会保留。\n预计约 $${usd.toFixed(2)}（≈${cny.toFixed(1)} 元）。继续？`)) return;
  if (await overBudget(p, cny, ext ? "这次延长" : "这次修改")) return;
  filmUI.busy = p.id; filmUI.msg = "正在提交…"; render(true);
  try {
    const out = await editFilm({ blob: f.blob, url: f.remote, fresh: !!f.remote && Date.now() - f.at < 20 * 3600000,
      mode: editUI.mode, instruction: ask, seconds: editUI.secs, audio: (data.film || {}).filmAudio !== false }, setFilmMsg, () => false);
    await addSpent(p, cny);
    const st = planState[p.id];
    const note = ext ? `延长 ${outSec} 秒${ask ? "：" + ask : ""}` : "修改：" + ask;
    st.film.push({ blob: out.blob, url: out.blob ? URL.createObjectURL(out.blob) : out.url, remote: out.url, model: ATLAS_25,
      res: out.draft ? "480p 草稿" : "480p", dur: outSec, at: Date.now(), note, from: st.filmCur + 1, ...(out.draft ? { draftId: out.taskId } : {}) });
    st.filmCur = st.film.length - 1;
    await saveFilms(p);
    editUI.text = "";
    filmUI.msg = out.blob ? (out.draft ? "改好了（480p 草稿）。不满意可以接着改，或用“上一版”对比；满意再转 1080p。" : "改好了。") : "已生成，但没能下载到本机：在线地址 24 小时后失效，请尽快下载";
  } catch (e) { console.warn("修改视频失败", e); filmUI.msg = (ext ? "延长" : "修改") + "失败：" + e.message; }
  finally { filmUI.busy = null; render(true); }
}
function editBox(p, f, fs_) {
  if (fs_.provider !== "atlas") return h("p", { class: "muted", style: { margin: "10px 0 0", fontSize: "12px" } }, "想在这版视频上直接修改，需要在设置页切换到 Atlas Cloud（一个 Key 全部搞定）。");
  const ext = editUI.mode === "extend";
  const ta = h("textarea", { class: "editask", rows: 2, placeholder: ext ? "（可选）后面接什么内容，例如：镜头拉远，产品停在画面中央，出现品牌名" : "想改哪里？例如：把耳机换成白色；整体调成黄昏暖光；第 3 秒之后人物动作慢一点" }, editUI.text);
  ta.addEventListener("input", () => { editUI.text = ta.value; });
  const modeSel = h("select", { onchange: (e) => { editUI.mode = e.target.value; render(true); } },
    [["edit", "修改这版"], ["extend", "往后延长"]].map(([v, l]) => h("option", { value: v, ...(v === editUI.mode ? { selected: "" } : {}) }, l)));
  const secs = ext ? h("select", { onchange: (e) => { editUI.secs = Number(e.target.value); render(true); } },
    [4, 5, 6, 8, 10].map((n) => h("option", { value: n, ...(n === editUI.secs ? { selected: "" } : {}) }, `${n} 秒`))) : null;
  const outSec = ext ? editUI.secs : f.dur || 5;
  const cny = editCostUSD(outSec) * USD_CNY;
  return h("div", { class: "editbox", style: { marginTop: "12px", paddingTop: "12px", borderTop: "1px solid var(--line, #e7e3dc)" } },
    h("div", { class: "row", style: { marginBottom: "8px" } }, h("strong", { style: { fontSize: "14px" } }, "微调这版视频"),
      h("span", { class: "muted", style: { fontSize: "12px" } }, "适合小改：颜色、光线、换掉某个物体、动作快慢。换场景、改情节这类大改，建议回到分镜改画面再生成。")),
    ta,
    h("div", { class: "row", style: { marginTop: "8px" } },
      h("div", { style: { width: "130px" } }, modeSel), secs ? h("div", { style: { width: "90px" } }, secs) : null,
      h("button", { class: "small primary", disabled: !!filmUI.busy, onclick: () => runEdit(p, f) }, ext ? "延长" : "按要求修改"),
      h("span", { class: "muted" }, `${ext ? "新增" : "输出"} ${outSec} 秒 · 约 ${cny.toFixed(1)} 元 · 原版本保留`)));
}
function filmCard(p) {
  const st = S_(p);
  const card = h("div", { class: "card film" });
  {
    const fs_ = filmSettingsSync(p);
    const plan = filmPlan(p, fs_.model, fs_.provider);
    const cost = filmCost(fs_, plan.dur);
    const save = (k) => async (e) => { const v = e.target.type === "checkbox" ? e.target.checked : e.target.value; data.film = { ...(data.film || {}), [k]: v }; await chrome.storage.local.set({ [k]: v }); render(true); };
    const model = h("select", { onchange: save("filmModel") }, fs_.list.map(([v, l]) => h("option", { value: v, ...(v === fs_.chosen ? { selected: "" } : {}) }, l)));
    const res = fs_.provider === "atlas" ? null : h("select", { onchange: save("filmResolution") }, ["480p", "720p", "1080p"].map((v) => h("option", { value: v, ...(v === fs_.resolution ? { selected: "" } : {}) }, v === "480p" ? "480p（草稿）" : v)));
    const audio = h("input", { type: "checkbox", style: { width: "auto" }, onchange: save("filmAudio"), ...(fs_.audio ? { checked: "" } : {}) });
    const f = st.film[st.filmCur];
    const busyHere = filmUI.busy === p.id;
    const draftOk = f && f.draftId && !f.finalized && Date.now() - f.at < 7 * 86400000;
    card.append(h("div", {},
      h("div", { class: "spread" }, h("h3", {}, "一次生成整片 · 带连贯的音乐和音效"), h("span", { class: "tag" }, "推荐")),
      h("p", { class: "muted", style: { margin: "6px 0 12px" } },
        "把上面所有分镜画面当参考图、加上每个镜头的时间安排，一次交给 Seedance 生成一整条视频。镜头衔接和配乐由模型统一处理。分镜画面是参考，成片不会和每张图一模一样。"),
      h("div", { class: "row" }, h("div", { style: { width: "210px" } }, model), res ? h("div", { style: { width: "130px" } }, res) : null,
        h("label", { class: "row", style: { gap: "6px", fontSize: "13px" } }, audio, "生成音乐音效"),
        h("button", { class: "primary", disabled: busyHere || !!filmUI.busy, onclick: () => runFilm(p) }, busyHere ? "生成中…" : f ? "再生成一版" : "生成整片"),
        h("span", { class: "muted" }, `${fs_.chosen === "auto" ? "将用 " + modelName(fs_.model) + " · " : ""}${plan.dur} 秒 · 参考图 ${plan.imgCount} 张${cost ? " · " + cost.text : ""}`)),
      fs_.why ? h("p", { class: "muted", style: { margin: "6px 0 0", fontSize: "12px" } }, "自动选择：" + fs_.why + (/2\.5/.test(fs_.model) ? "。2.5 会先出 480p 草稿，满意再转 1080p 正式版（两次分别计费）" : "")) : null,
      plan.compressed ? h("p", { class: "muted", style: { margin: "6px 0 0" } }, `分镜总长 ${fmt(plan.total)} 秒，超过这个模型一次最长 ${filmLimits(fs_.model).maxDur} 秒，会按比例压缩。`) : null,
      plan.avgLen < 0.7 ? h("p", { class: "muted", style: { margin: "6px 0 0" } }, `这个方案平均 ${plan.avgLen.toFixed(1)} 秒一切（${plan.shotCount} 个镜头），非常密。提示词里已经写明硬切、不放慢，但视频模型对 0.5 秒左右的闪切不一定每次都跟得上，可以多生成一版对比。`) : null,
      plan.missing ? h("p", { class: "muted", style: { margin: "6px 0 0" } }, `还有 ${plan.missing} 个镜头没有画面，建议先在下面画好，整片会更接近你的分镜。`) : null,
      h("p", { class: "muted filmmsg", style: { margin: "8px 0 0", minHeight: filmUI.msg && (busyHere || !filmUI.busy) ? "" : "0" } }, filmUI.msg && (busyHere || !filmUI.busy) ? filmUI.msg : ""),
      f ? h("div", { class: "filmout" },
        h("video", { src: f.url, controls: "", playsinline: "" }),
        h("div", { class: "row", style: { marginTop: "8px" } },
          st.film.length > 1 ? [h("button", { class: "small", disabled: st.filmCur === 0, onclick: () => { st.filmCur--; render(true); } }, "‹ 上一版"),
            h("span", { class: "muted" }, `第 ${st.filmCur + 1}/${st.film.length} 版`),
            h("button", { class: "small", disabled: st.filmCur === st.film.length - 1, onclick: () => { st.filmCur++; render(true); } }, "下一版 ›")] : null,
          h("span", { class: "muted" }, `${modelName(f.model)} · ${f.res} · ${f.dur} 秒 · ${relTime(f.at)}`),
          draftOk ? h("button", { class: "small primary", disabled: !!filmUI.busy, onclick: () => finalizeDraft(p, f) }, `转成 1080p 正式版（约 ${(atlasCostUSD(ATLAS_25, "complete", f.dur || 5) * USD_CNY).toFixed(1)} 元）`) : null,
          draftOk ? h("span", { class: "muted", style: { fontSize: "12px" } }, `草稿可转正式版到 ${new Date(f.at + 7 * 86400000).toLocaleDateString()}`) : null,
          f.blob ? h("button", { class: "small" + (draftOk ? "" : " primary"), onclick: () => saveBlob(f.blob, `整片-${(p.result.title || "未命名").replace(/[\\/:*?"<>|\s]+/g, "")}-v${st.filmCur + 1}.mp4`) }, "下载") : h("a", { href: f.url, target: "_blank" }, "打开在线地址")),
        f.note ? h("p", { class: "muted", style: { margin: "6px 0 0", fontSize: "12px" } }, `基于第 ${f.from || "?"} 版 · ${f.note}`) : null,
        editBox(p, f, fs_)) : null,
      h("details", { style: { marginTop: "10px" } }, h("summary", { class: "muted", style: { cursor: "pointer" } }, "查看发给模型的完整提示词"), h("pre", { class: "prompt", style: { marginTop: "8px" } }, plan.prompt))));
  }
  return card;
}
// 主体的完整说明：用户写的 + 模型看参考图写下的外形
const subjOf = (p) => [(p.subjectText || "").trim(), p.subjectLook ? "外形：" + p.subjectLook : ""].filter(Boolean).join("；");
// 让分镜跟着主体改：模型先看参考图写下主角外形，再把每一镜里对主角外形的描述换成参考图的样子，动作、位置、运镜不变
const alignUI = { busy: null, msg: "" };
async function alignToSubject(p) {
  p = fresh(p);
  const st = S_(p);
  if (!st.subj.length && !(p.subjectText || "").trim()) { toast("先上传主体参考图，或写一下主体描述"); return; }
  alignUI.busy = p.id; alignUI.msg = "正在看参考图、改写分镜…"; render(true);
  try {
    const parts = [];
    for (const sj of st.subj.slice(0, 3)) parts.push(await blobToPart(await toJpeg(sj.blob)));
    const shots = p.result.shots.map((s, i) => ({ n: i + 1, visual: s.visual, action: s.action }));
    parts.push({ text: `${st.subj.length ? `上面 ${st.subj.length} 张图是这条视频主角的参考图。` : ""}用户对主角的说明：${(p.subjectText || "").trim() || "（无）"}
任务：
1. look：仔细看参考图，用 40-80 字写出主角的外形，具体到能让画图模型照着画出同一个角色：整体造型、比例、材质质感（例如像素方块/毛绒/金属）、配色、五官和标志性细节。没有参考图就根据用户说明写。
2. shots：下面是分镜里每一镜的画面（visual）和动作（action）。把里面描述主角外形的词（例如别的造型、材质、颜色、“星芒状”“粘土质感”“精灵”之类）全部换成和参考图一致的说法；主角的名字可以保留。场景、构图、主角的位置和动作方向、其他物体都不要改。主角不出现的镜头原样返回。每一镜都要返回，n 保持原样。
分镜：
${JSON.stringify(shots)}
只输出 JSON：{"look":"…","shots":[{"n":1,"visual":"…","action":"…"}]}` });
    const j = parseJSON(await generate(parts, { json: true, role: "plan" }));
    const look = String(j.look || "").trim();
    const map = new Map((Array.isArray(j.shots) ? j.shots : []).map((x) => [Number(x.n), x]));
    let changed = 0;
    const cur = fresh(p);
    const newShots = cur.result.shots.map((s, i) => {
      const x = map.get(i + 1);
      if (!x) return s;
      const visual = String(x.visual || "").trim() || s.visual, action = String(x.action || "").trim() || s.action;
      if (visual !== s.visual || action !== s.action) changed++;
      return { ...s, visual, action };
    });
    await updatePlan(cur, { subjectLook: look || cur.subjectLook || "", result: { ...cur.result, shots: newShots } });
    alignUI.msg = `已按参考图改写 ${changed} 个镜头的描述。已经画好的画面不会自动变，点“全部重画”或单独“重新画”就会按新描述生成。`;
  } catch (e) { alignUI.msg = "改写失败：" + e.message; }
  finally { alignUI.busy = null; render(true); }
}
function subjectCard(p) {
  const st = S_(p);
  const ta = h("textarea", { rows: 2, placeholder: "描述你想要的主角/产品，例如：白色头戴式降噪耳机，圆形大耳罩，磨砂质感，玫瑰金金属头梁" }, p.subjectText || "");
  ta.addEventListener("change", () => updatePlan(p, { subjectText: ta.value.trim() }).then(() => toast("主体描述已保存")));
  const file = h("input", { type: "file", accept: "image/*", multiple: "", style: { display: "none" } });
  file.addEventListener("change", async () => {
    for (const f of [...file.files].slice(0, 3)) planState[p.id].subj.push(U(f));
    planState[p.id].subj = planState[p.id].subj.slice(-3);
    await saveSubj(p); render(true);
  });
  return section("主体设定 · 让每个镜头里的主角/产品长成你想要的样子",
    ta,
    h("div", { class: "row", style: { marginTop: "10px", alignItems: "flex-start" } },
      st.subj.map((sj, k) => h("div", { class: "subj" }, h("img", { src: sj.url }),
        h("button", { class: "x", title: "移除", onclick: async () => { planState[p.id].subj.splice(k, 1); await saveSubj(p); render(true); } }, "×"))),
      st.subj.length < 3 ? h("button", { class: "subj add", onclick: () => file.click() }, "＋ 上传参考图") : null, file),
    p.subjectLook ? h("p", { style: { margin: "10px 0 0", fontSize: "13px" } }, h("span", { class: "muted" }, "模型看到的外形："), p.subjectLook) : null,
    h("div", { class: "row", style: { marginTop: "10px" } },
      h("button", { class: "small primary", disabled: !!alignUI.busy || (!st.subj.length && !(p.subjectText || "").trim()), onclick: () => alignToSubject(p) },
        alignUI.busy === p.id ? "正在改写…" : "让分镜跟着主体改"),
      h("span", { class: "muted", style: { fontSize: "12px" } }, alignUI.msg && (alignUI.busy === p.id || !alignUI.busy) ? alignUI.msg : "上传或更换主体后点一下：把每一镜里对主角外形的描述改成参考图的样子，避免文字和图打架。")),
    h("p", { class: "muted", style: { margin: "10px 0 0" } },
      "可以上传你自己的产品照片、草图或喜欢的样子（最多 3 张），也可以在下面任意一张画面上点“设为主体”。改了主体设定后，点“全部重画”让所有镜头统一。"));
}

function shotCard(p, s, i) {
  const k = p.id + ":" + i;
  const st = S_(p);
  const ref = refOf(p, s);
  const fc = ref && frameCache[ref.x.id];
  const refUrl = fc && fc.status === "done" && fc.shots[ref.shot] ? fc.shots[ref.shot].firstUrl : null;
  const e = st.img[i], gen = curImg(p, i), vd = st.vid[i];
  const working = busy[k] || (planGen.id === p.id);
  const view = cardUI[k + ":view"] || (vd ? "video" : "image");
  const ratio = ratioOf(p.brief.aspect).replace(":", " / ");
  let media;
  if (view === "video" && vd) media = h("video", { src: vd.url, controls: "", loop: "", muted: "", playsinline: "", poster: gen ? gen.url : undefined });
  else if (gen) media = h("img", { src: gen.url, class: "gen" });
  else if (refUrl) media = h("img", { src: refUrl, class: "refimg" });
  else media = h("div", { class: "thumb", style: ref ? bg(ref.x.result.thumb) : {} });
  const verNav = e && e.versions.length > 1 && view !== "video" ? h("div", { class: "ver" },
    h("button", { disabled: e.cur === 0, onclick: async () => { e.cur--; await saveImgs(p, i); render(true); } }, "‹"),
    h("span", {}, `${e.cur + 1}/${e.versions.length}`),
    h("button", { disabled: e.cur === e.versions.length - 1, onclick: async () => { e.cur++; await saveImgs(p, i); render(true); } }, "›")) : null;

  // 文字编辑
  let body;
  if (cardUI[k] === "text") {
    const f = {};
    const field = (key, label, rows = 1) => (f[key] = h("textarea", { rows, class: "small-ta" }, s[key] || ""), h("label", { class: "fl" }, label, f[key]));
    body = h("div", {}, field("visual", "画面", 2), field("action", "动作"), field("camera", "运镜"), field("light", "光影"), field("audio", "声音"),
      h("div", { class: "row", style: { marginTop: "6px" } },
        h("button", { class: "small primary", onclick: async () => {
          const shots = p.result.shots.map((x, j) => (j === i ? { ...x, ...Object.fromEntries(Object.entries(f).map(([kk, el]) => [kk, el.value.trim()])) } : x));
          cardUI[k] = null; await updatePlan(p, { result: { ...p.result, shots } }); toast("已保存，点“重新画”按新文字出图");
        } }, "保存文字"),
        h("button", { class: "small ghost", onclick: () => { cardUI[k] = null; render(true); } }, "取消")));
  } else {
    body = h("div", {},
      h("div", { style: { margin: "4px 0 6px" } }, s.visual),
      h("div", { class: "meta" }, h("span", {}, "动作"), h("span", {}, s.action), h("span", {}, "运镜"), h("span", {}, s.camera),
        s.light ? [h("span", {}, "光影"), h("span", {}, s.light)] : null, h("span", {}, "声音"), h("span", {}, s.audio)));
  }
  // 在画面上修改
  let editBox = null;
  if (cardUI[k] === "edit") {
    const inp = h("textarea", { rows: 2, class: "small-ta", placeholder: "想怎么改？例如：耳机换成白色头戴式，耳罩更大更圆" });
    const go3 = () => inp.value.trim() && oneShot(p, i, "正在修改画面…", () => genShotImage(p, i, inp.value.trim()));
    editBox = h("div", { class: "editbox" }, inp,
      h("div", { class: "row", style: { marginTop: "6px" } },
        ["主体放大、更居中", "背景更简洁", "光线更亮更通透", "换个更有冲击力的角度"].map((t) => h("span", { class: "chip", onclick: () => { inp.value = inp.value ? inp.value + "；" + t : t; } }, t))),
      h("div", { class: "row", style: { marginTop: "8px" } }, h("button", { class: "small primary", onclick: go3 }, "按这个改"),
        h("button", { class: "small ghost", onclick: () => { cardUI[k] = null; render(true); } }, "取消")),
      h("p", { class: "muted", style: { margin: "6px 0 0", fontSize: "12px" } }, "会在当前画面基础上只改你说的地方，生成一个新版本，旧版本可以用 ‹ › 切回去。"));
  }
  const B = (label, fn, cls = "small") => h("button", { class: cls, disabled: !!working, onclick: fn }, label);
  return h("div", { class: "bcard" },
    h("div", { class: "bimg", style: { aspectRatio: ratio } }, media, h("span", { class: "bno" }, pad(i + 1)),
      (() => { // 档位小标记：鼠标悬停看原因
        const v = gen || null, t = v && v.tier ? v.tier : shotTier(s).tier;
        const tip = [v && v.why ? v.why : shotTier(s).why, v && v.review && v.review.issue ? "检查：" + v.review.issue : ""].filter(Boolean).join("；");
        return h("span", { class: "tierb t-" + t, title: (v ? "用了" : "将用") + TIER_LABEL[t] + "档模型：" + tip }, TIER_LABEL[t]);
      })(),
      gen && gen.review && !gen.review.pass && (gen.tier === "high" || /自动升档/.test(gen.why || "") || data.stack !== "atlas") ? h("span", { class: "needlook", title: gen.review.issue }, "需要你看一下") : null,
      gen && refUrl && view !== "video" ? h("img", { class: "refmini", src: refUrl, title: "原片参考画面" }) : null,
      !gen && !vd ? h("span", { class: "bhint" }, refUrl || ref ? "原片参考 · 还没生成" : "还没生成") : null,
      busy[k] ? h("div", { class: "busy", "data-busy": k }, busy[k]) : null, verNav,
      vd && gen ? h("div", { class: "viewtog" },
        h("button", { class: view === "image" ? "on" : "", onclick: () => { cardUI[k + ":view"] = "image"; render(true); } }, "画面"),
        h("button", { class: view === "video" ? "on" : "", onclick: () => { cardUI[k + ":view"] = "video"; render(true); } }, "视频")) : null),
    h("div", { class: "bbody" },
      h("div", { class: "spread" }, h("div", { class: "time" }, `${fmt(s.start)}s – ${fmt(s.end)}s`),
        ref ? h("a", { class: "muted", href: "#item/" + ref.x.id, style: { fontSize: "12px" } }, `参考 R${p.itemIds.indexOf(ref.x.id) + 1} 第${ref.shot + 1}镜`) : h("span", { class: "muted", style: { fontSize: "12px" } }, s.ref || "整体风格")),
      body, editBox,
      h("div", { class: "btns" },
        h("div", { class: "row" },
          B(gen ? "重新画" : "生成画面", () => oneShot(p, i, "正在画…", (st2) => genShotImage(p, i, "", null, st2)), gen ? "small" : "small primary"),
          gen ? B("修改画面", () => { cardUI[k] = "edit"; render(true); }) : null,
          cardUI[k] !== "text" ? B("改文字", () => { cardUI[k] = "text"; render(true); }, "small ghost") : null,
          gen ? B("设为主体", async () => {
            planState[p.id].subj = [...planState[p.id].subj, U(gen.blob)].slice(-3); await saveSubj(p); toast("已加入主体参考"); render(true);
          }, "small ghost") : null),
        h("div", { class: "row" },
          data.stack === "atlas" ? null : B(vd ? "重新生成视频" : "生成视频", () => oneShot(p, i, "正在提交视频任务…", (st2) => genClip(p, i, st2)), gen && !vd ? "small primary" : "small"),
          gen ? h("button", { class: "small ghost", onclick: () => saveBlob(gen.blob, `镜头${pad(i + 1)}.png`) }, "下载画面") : null,
          vd && vd.blob ? h("button", { class: "small ghost", onclick: () => saveBlob(vd.blob, `镜头${pad(i + 1)}.mp4`) }, "下载视频") : null,
          h("button", { class: "small ghost", onclick: async () => { await navigator.clipboard.writeText(clipPrompt(p, s)); toast("已复制本镜提示词"); } }, "复制提示词")))));
}

function pagePlan(id) {
  const p = (data.plans || []).find((x) => x.id === id);
  if (!p) return h("div", { class: "page" }, h("div", { class: "empty" }, "找不到这个方案，可能已被删除。"), h("div", { style: { textAlign: "center" } }, h("a", { href: "#groups" }, "返回风格分组")));
  const r = p.result;
  const refs = p.itemIds.map(itemById).filter(Boolean);
  if (!planState[p.id]) loadPlanState(p);
  const st = S_(p);
  const box = h("pre", { class: "prompt" });
  const seg = h("div", { class: "seg" });
  const setL = (l) => { box.textContent = l === "en" ? r.style_prompt_en || "（没有英文版）" : r.style_prompt_zh; seg.querySelectorAll("button").forEach((b) => b.classList.toggle("on", b.dataset.l === l)); };
  seg.append(h("button", { "data-l": "zh", onclick: () => setL("zh") }, "中文"), h("button", { "data-l": "en", onclick: () => setL("en") }, "English"));
  setL("zh");
  const allText = () => [`${r.title}｜${r.concept}`, `主题：${p.brief.subject}｜约 ${p.brief.duration} 秒｜${p.brief.aspect}`, "",
    ...r.shots.map((s, i) => `【镜头${pad(i + 1)}】${fmt(s.start)}s – ${fmt(s.end)}s\n${clipPrompt(p, s)}\n声音：${s.audio}\n`),
    "配乐与音效：" + r.soundtrack, "", "通用风格提示词：", r.style_prompt_zh, r.style_prompt_en].join("\n");
  const n = r.shots.length;
  const nImg = r.shots.filter((_, i) => curImg(p, i)).length, nVid = r.shots.filter((_, i) => st.vid[i]).length;
  const running = planGen.id === p.id;
  const filmMsg = h("span", { class: "muted" });
  const toolbar = h("div", { class: "toolbar" },
    h("div", { class: "row" }, h("span", { class: "step" }, "① 画面"),
      running ? null : h("button", { class: "small" + (nImg < n ? " primary" : ""), onclick: () => { if (nImg >= n && !confirm("全部重画会给每个镜头生成新版本（旧版本保留，可切回）。继续？")) return; genAllImages(p, nImg < n); } },
        nImg >= n ? "全部重画" : nImg ? `补齐剩下 ${n - nImg} 张` : "一键生成全部画面"),
      h("span", { class: "muted" }, `${nImg}/${n} 张`),
      h("span", { class: "muted", style: { marginLeft: "auto" } }, `这条视频已花约 ${(p.spent || 0).toFixed(1)} 元 · 预算 ${data.planBudget || 30} 元`)),
    data.stack === "atlas" ? null : h("div", { class: "row" }, h("span", { class: "step" }, "逐镜视频"),
      running ? null : h("button", { class: "small" + (nImg >= n && nVid < n ? " primary" : ""), onclick: async () => {
        const vs = await getVideoSettings();
        const todo = r.shots.map((_, i) => i).filter((i) => nVid >= n || !st.vid[i]);
        const secs = todo.reduce((a, i) => a + clipDuration(vs.model, r.shots[i].end - r.shots[i].start, vs.minDur), 0);
        const cost = estimateCost(vs.model, vs.resolution, secs);
        if (!confirm(`将用 ${vs.model} 生成 ${todo.length} 段视频，合计 ${secs} 秒（${vs.resolution}）${cost != null ? `，预计约 ${cost.toFixed(1)} 元` : "，会按火山方舟的价格计费"}。${nImg < n ? "\n注意：还有镜头没有画面，这些镜头会只按文字生成，和整体风格可能对不上。" : ""}\n继续？`)) return;
        genAllClips(p, nVid < n);
      } }, nVid >= n ? "全部重新生成视频" : nVid ? `补齐剩下 ${n - nVid} 段` : "一键生成全部视频"),
      h("span", { class: "muted" }, `${nVid}/${n} 段`)),
    data.stack === "atlas" ? null : h("div", { class: "row" }, h("span", { class: "step" }, "逐镜成片"),
      h("button", { class: "small" + (nVid ? " primary" : ""), disabled: !nVid, onclick: () => { ui.preview = ui.preview === p.id ? null : p.id; render(true); } }, ui.preview === p.id ? "收起预览" : "预览成片"),
      h("button", { class: "small", disabled: !nVid || running, onclick: async (e) => {
        const b = e.currentTarget; b.disabled = true;
        try { await exportFilm(p, (m) => { filmMsg.textContent = m; }); filmMsg.textContent = "已导出（无声，配乐可在剪映里加）"; }
        catch (err) { filmMsg.textContent = "导出失败：" + err.message; }
        b.disabled = false;
      } }, "导出成片"), filmMsg),
    running ? h("div", { class: "row" }, h("span", { class: "muted" }, planGen.msg), h("button", { class: "small", onclick: () => { planGen.stop = true; planGen.msg = "当前这一镜完成后停止…"; render(true); } }, "停止"))
      : planGen.msg ? h("div", { class: "muted" }, planGen.msg) : null);
  return h("div", { class: "page" },
    h("a", { href: "#groups", class: "muted", style: { textDecoration: "none" } }, "← 返回风格分组"),
    h("div", { class: "card" },
      h("h1", {}, r.title || "分镜方案"),
      r.concept ? h("p", { style: { margin: "8px 0 0", color: "var(--ink-2)" } }, r.concept) : null,
      h("p", { class: "muted", style: { margin: "8px 0 0" } }, `主题：${p.brief.subject}　·　约 ${p.brief.duration} 秒　·　${p.brief.aspect}${p.brief.extra ? "　·　" + p.brief.extra : ""}`),
      h("div", { class: "row", style: { marginTop: "12px" } }, h("span", { class: "muted" }, p.cardId ? "" : p.groupName ? `参考分组「${p.groupName}」：` : "参考："),
        p.cardId ? h("a", { class: "chip on", href: "#card/" + p.cardId, style: { textDecoration: "none" } }, "风格卡 · " + (p.cardName || "")) : null,
        refs.map((x, i) => h("a", { class: "chip", href: "#item/" + x.id, style: { textDecoration: "none" } }, `R${i + 1} ${displayTitle(x)}`))),
      r.style_summary ? h("p", { class: "muted", style: { margin: "10px 0 0" } }, "继承的风格：" + r.style_summary) : null),
    subjectCard(p),
    h("div", { class: "card" },
      h("div", { class: "spread", style: { marginBottom: "12px" } },
        h("div", { class: "label", style: { margin: 0 } }, `分镜画布 · ${n} 个镜头`),
        h("div", { class: "row" },
          h("button", { class: "small ghost", onclick: () => exportPlanPack(p) }, "导出素材包"),
          h("button", { class: "small ghost", onclick: async () => { await navigator.clipboard.writeText(allText()); toast("已复制全部分镜"); } }, "复制全部提示词"))),
      toolbar,
      ui.preview === p.id ? previewPlayer(p) : null,
      h("div", { class: "board" }, r.shots.map((s, i) => shotCard(p, s, i))),
      r.soundtrack ? h("p", { class: "muted", style: { margin: "14px 0 0" } }, "配乐与音效建议：" + r.soundtrack) : null),
    h("div", { class: "label", style: { margin: "0 0 -14px" } }, "② 生成视频"),
    filmCard(p),
    section("通用风格提示词（已附加在每个镜头里）",
      h("div", { class: "spread", style: { marginBottom: "10px" } }, seg, h("button", { class: "small primary", style: { padding: "4px 12px" }, onclick: async () => { await navigator.clipboard.writeText(box.textContent); toast("已复制"); } }, "复制")),
      box),
    h("div", { class: "row" },
      h("button", { class: "small ghost", onclick: async () => {
        if (!confirm("删除这个分镜方案（包括生成的画面和视频）？")) return;
        await savePlans(data.plans.filter((x) => x.id !== p.id));
        for (let i = 0; i < n; i++) { idb.del(p.id + ":" + i).catch(() => {}); idb.del(p.id + ":v:" + i).catch(() => {}); }
        idb.del(p.id + ":subj").catch(() => {}); delete planState[p.id]; go("groups");
      } }, "删除方案")));
}

// ---------- 风格卡 ----------
const cardBoards = {}; // cardId -> [{ blob, url }]
const cardBusy = {};   // cardId -> 进度文字
async function saveCards(cards) { data.styleCards = cards; await chrome.storage.local.set({ styleCards: cards }); }
const cardById = (id) => (data.styleCards || []).find((c) => c.id === id);
async function loadBoard(id) {
  if (!cardBoards[id]) {
    const v = await idb.get("card:" + id + ":board").catch(() => null);
    cardBoards[id] = Array.isArray(v) ? v.map(U) : [];
  }
  return cardBoards[id];
}
const saveBoard = (id) => idb.put("card:" + id + ":board", cardBoards[id].map((x) => x.blob));
// 从每条来源视频里挑最有代表性的画面：优先时长长的镜头的中间帧，各条视频轮流取，最多 9 张
async function buildBoard(card, offset = 0) {
  const xs = (card.itemIds || []).map(itemById).filter(Boolean).slice(0, 9);
  const per = [];
  for (const [n, x] of xs.entries()) {
    cardBusy[card.id] = `正在从《${displayTitle(x)}》里挑画面（${n + 1}/${xs.length}）…`; render(true);
    const fc = await ensureFrames(x);
    if (!fc) continue;
    const shots = ((x.result.shots || []).length ? x.result.shots : fc.shots).map((s, i) => ({ i, len: (s.end - s.start) || 1 })).sort((a, b) => b.len - a.len);
    per.push(shots.map(({ i }) => fc.shots[i] && fc.shots[i].mid && fc.shots[i].mid.blob).filter(Boolean));
  }
  const out = [];
  for (let round = 0; out.length < 9 && per.some((l) => l.length > round + offset); round++)
    for (const l of per) if (out.length < 9 && l[round + offset]) out.push(l[round + offset]);
  (cardBoards[card.id] || []).forEach((x) => URL.revokeObjectURL(x.url));
  cardBoards[card.id] = out.map(U);
  await saveBoard(card.id);
  delete cardBusy[card.id]; render(true);
}
async function distillCard(itemIds, hint, btn) {
  const items = itemIds.map(itemById).filter(Boolean);
  if (!items.length) return toast("没有可提炼的收藏");
  if (btn) { btn.disabled = true; btn.textContent = "正在提炼…"; }
  try {
    const j = parseJSON(await generate([{ text: distillPrompt(items, data.picks, hint) }], { json: true, role: "plan" }));
    if (!j.name || !j.recipe) throw new Error("模型返回的风格卡不完整，请重试");
    const card = { id: uid(), at: Date.now(), updatedAt: Date.now(), name: String(j.name).slice(0, 16), tagline: String(j.tagline || ""),
      recipe: Object.fromEntries(CARD_KEYS.map(([k]) => [k, String((j.recipe || {})[k] || "")])),
      sound: String(j.sound || ""), avoid: String(j.avoid || ""), template_zh: String(j.template_zh || ""), template_en: String(j.template_en || ""),
      itemIds: items.map((x) => x.id), source: hint || "" };
    await saveCards([card, ...(data.styleCards || [])]);
    go("card/" + card.id);
    buildBoard(card).catch((e) => { cardBusy[card.id] = "挑选参考图失败：" + e.message; render(true); });
  } catch (e) { toast("提炼失败：" + e.message); if (btn) { btn.disabled = false; btn.textContent = "提炼成风格卡"; } }
}
function collage(id) {
  const b = cardBoards[id];
  if (!b) { loadBoard(id).then(() => render(true)); }
  const imgs = (b || []).slice(0, 9);
  const n = imgs.length > 6 || !imgs.length ? 9 : imgs.length > 3 ? 6 : 3; // 按图数排成 3×1 / 3×2 / 3×3
  return h("div", { class: "collage", style: { aspectRatio: `3 / ${n / 3}` } }, Array.from({ length: n }, (_, i) => imgs[i] ? h("img", { src: imgs[i].url }) : h("div")));
}
function pageCards() {
  const cards = data.styleCards || [];
  const groups = data.styleGroups ? data.styleGroups.groups : [];
  return h("div", { class: "page" },
    h("div", {}, h("h1", {}, "风格卡"),
      h("p", { class: "muted", style: { margin: "8px 0 0" } }, "把一组收藏的共同审美提炼成一张可以反复使用的风格卡：风格配方、参考图板、声音设定、要避开什么。以后做视频只要选一张风格卡、写上主题，不用再回头照着某条视频做。")),
    cards.length ? h("div", { class: "cards" }, cards.map((c) => h("div", { class: "scard", onclick: () => go("card/" + c.id) },
      collage(c.id),
      h("div", { class: "sb" }, h("div", { class: "sn" }, c.name), h("div", { class: "muted", style: { marginTop: "4px" } }, c.tagline),
        h("div", { class: "muted", style: { marginTop: "8px", fontSize: "12px" } }, `来自 ${(c.itemIds || []).length} 条收藏${c.source ? " · " + c.source : ""}`)))))
      : h("div", { class: "card empty" }, "还没有风格卡。"),
    h("div", { class: "card" }, h("h3", {}, "新建风格卡"),
      groups.length ? [h("p", { class: "muted", style: { margin: "6px 0 10px" } }, "从风格分组提炼（推荐，几条视频的共同点更能代表你的审美）："),
        h("div", { class: "row" }, groups.map((g) => h("button", { onclick: (e) => distillCard(g.itemIds, g.name, e.currentTarget) }, g.name + ` · ${g.itemIds.length} 条`)))]
        : h("p", { class: "muted", style: { margin: "6px 0 0" } }, "先去“风格分组”让 AI 分好组，再回来提炼；也可以在任意一条收藏的详情页里，把单条视频提炼成风格卡。")));
}
function pageCard(id) {
  const c = cardById(id);
  if (!c) return h("div", { class: "page" }, h("div", { class: "empty" }, "找不到这张风格卡。"), h("div", { style: { textAlign: "center" } }, h("a", { href: "#cards" }, "返回风格卡")));
  const board = cardBoards[id];
  if (!board) loadBoard(id).then(() => render(true));
  const patch = async (obj) => { await saveCards(data.styleCards.map((x) => (x.id === id ? { ...x, ...obj, updatedAt: Date.now() } : x))); };
  const field = (val, onSave, rows = 2, cls = "") => {
    const t = h("textarea", { rows, class: cls }, val || "");
    t.addEventListener("change", () => onSave(t.value.trim()).then(() => toast("已保存")));
    return t;
  };
  const name = h("input", { class: "cn", value: c.name }); name.addEventListener("change", () => patch({ name: name.value.trim() || c.name }).then(() => toast("已保存")));
  const tag = h("input", { class: "ctl", value: c.tagline, placeholder: "一句话定义这个风格" }); tag.addEventListener("change", () => patch({ tagline: tag.value.trim() }));
  const sources = (c.itemIds || []).map(itemById).filter(Boolean);
  const tseg = h("div", { class: "seg" });
  const tbox = h("div");
  const showT = (l) => { tbox.textContent = ""; tbox.append(l === "en" ? field(c.template_en, (v) => patch({ template_en: v }), 5) : field(c.template_zh, (v) => patch({ template_zh: v }), 5));
    tseg.querySelectorAll("button").forEach((b) => b.classList.toggle("on", b.dataset.l === l)); };
  tseg.append(h("button", { "data-l": "zh", onclick: () => showT("zh") }, "中文"), h("button", { "data-l": "en", onclick: () => showT("en") }, "English"));
  showT("zh");
  return h("div", { class: "page" },
    h("a", { href: "#cards", class: "muted", style: { textDecoration: "none" } }, "← 全部风格卡"),
    h("div", { class: "card cardhero" },
      h("div", {},
        board && board.length ? h("div", { class: "board9" }, board.map((b, k) => h("div", { class: "bi" }, h("img", { src: b.url }),
          h("button", { class: "x", title: "移除这张", onclick: async () => { URL.revokeObjectURL(b.url); board.splice(k, 1); await saveBoard(id); render(true); } }, "×"))))
          : h("div", { class: "collage", style: { borderRadius: "14px" } }, Array.from({ length: 9 }, () => h("div"))),
        h("div", { class: "row", style: { marginTop: "8px" } },
          cardBusy[id] ? h("span", { class: "muted" }, cardBusy[id])
            : h("button", { class: "small", onclick: () => buildBoard(c, (board && board.length ? 1 : 0)).catch((e) => toast(e.message)) }, board && board.length ? "换一批参考图" : "挑选参考图"),
          h("span", { class: "muted", style: { fontSize: "12px" } }, "生成画面时作为风格参考：只学风格，不学内容"))),
      h("div", {},
        name, tag,
        h("div", { class: "muted", style: { margin: "14px 0 6px", fontSize: "12px" } }, `提炼自 ${sources.length} 条收藏${c.source ? "（" + c.source + "）" : ""}：`),
        h("div", { class: "row" }, sources.map((x) => h("a", { class: "chip", href: "#item/" + x.id, style: { textDecoration: "none" } }, displayTitle(x)))),
        h("div", { style: { marginTop: "20px" } }, h("div", { class: "label" }, "用这张风格卡做视频"),
          composer({ itemIds: c.itemIds || [], cardId: id, label: "写上主题，开始设计" })))),
    h("div", { class: "card" }, h("div", { class: "label" }, "风格配方（可以直接改，改完自动保存）"),
      h("div", { class: "recipe" }, CARD_KEYS.map(([k, l]) => h("label", {}, l, field((c.recipe || {})[k], (v) => patch({ recipe: { ...c.recipe, [k]: v } })))))),
    h("div", { class: "card cfield" }, h("div", { class: "recipe" },
      h("label", {}, "声音设定", field(c.sound, (v) => patch({ sound: v }), 3)),
      h("label", {}, "要避开什么", field(c.avoid, (v) => patch({ avoid: v }), 3)))),
    h("div", { class: "card cfield" }, h("div", { class: "spread", style: { marginBottom: "10px" } }, h("div", { class: "label", style: { margin: 0 } }, "风格提示词模板（【主题】处换成你的内容）"), tseg), tbox),
    h("div", { class: "row" },
      h("button", { class: "small ghost", onclick: () => distillCard(c.itemIds || [], c.source, null) }, "重新提炼一版（保留这张）"),
      h("button", { class: "small ghost", onclick: async () => {
        if (!confirm(`删除风格卡「${c.name}」？用它做过的分镜方案不受影响。`)) return;
        await saveCards(data.styleCards.filter((x) => x.id !== id)); idb.del("card:" + id + ":board").catch(() => {}); go("cards");
      } }, "删除风格卡")));
}

// ---------- 路由 ----------
function route() {
  const hash = decodeURIComponent(location.hash.slice(1)) || "home";
  if (hash.startsWith("item/")) return { name: "item", id: hash.slice(5) };
  if (hash.startsWith("plan/")) return { name: "plan", id: hash.slice(5) };
  if (hash.startsWith("card/")) return { name: "card", id: hash.slice(5) };
  return { name: ["home", "collection", "report", "groups", "cards"].includes(hash) ? hash : "home" };
}

function render(keepScroll = false) {
  const y = window.scrollY;
  const r = route();
  document.querySelectorAll("nav .tabs a").forEach((a) => a.classList.toggle("on", a.dataset.r === r.name || (r.name === "item" && a.dataset.r === "collection") || (r.name === "plan" && a.dataset.r === "groups") || (r.name === "card" && a.dataset.r === "cards")));
  app.textContent = "";
  app.append(r.name === "card" ? pageCard(r.id) : r.name === "cards" ? pageCards() : r.name === "plan" ? pagePlan(r.id) : r.name === "groups" ? pageGroups() : r.name === "item" ? pageItem(r.id) : r.name === "collection" ? pageCollection() : r.name === "report" ? pageReport() : pageHome());
  if (r.name !== "item" || r.id !== player.id) { const v = player.el && player.el.querySelector("video"); if (v) v.pause(); if (r.name !== "item") player = { id: null, el: null }; }
  if (keepScroll) window.scrollTo(0, y); else window.scrollTo(0, 0);
}

async function markSeen() {
  const seen = { ...data.seen };
  let changed = false;
  for (const x of data.items) if (x.status === "done" && !seen[x.id]) { seen[x.id] = 1; changed = true; }
  if (changed) { data.seen = seen; await chrome.storage.local.set({ seen }); chrome.runtime.sendMessage({ type: "refreshBadge" }); }
}

async function init() {
  data = await loadAll();
  render();
  markSeen();
}

window.addEventListener("hashchange", () => render());
chrome.storage.onChanged.addListener(async (changes) => {
  if (!changes.items && !changes.picks && !changes.styleGroups && !changes.plans && !changes.styleCards) return;
  data = await loadAll();
  if (changes.items) for (const id of Object.keys(frameCache)) if (frameCache[id].status === "idle") delete frameCache[id];
  // 正在输入搜索时不整页重绘，避免打断
  const typing = document.activeElement && ["search", "text", "textarea"].includes(document.activeElement.type);
  if (typing && !changes.items) return;
  render(true);
  if (changes.items) markSeen();
});
document.getElementById("opt").onclick = () => chrome.runtime.openOptionsPage();
// 备份 / 恢复：删掉插件、换电脑、换文件夹之后，用备份文件把数据找回来
document.getElementById("export").onclick = async (ev) => {
  const btn = ev.currentTarget; btn.disabled = true;
  try {
    const r = await exportBackup((m) => { btn.textContent = "备份中…"; btn.title = m; });
    toast(`已备份 ${r.items} 条收藏、${r.plans} 个分镜方案、${r.files} 个画面/视频文件（约 ${(r.bytes / 1048576).toFixed(1)} MB）。文件在浏览器的下载文件夹里`);
  } catch (e) { toast("备份失败：" + e.message); }
  finally { btn.disabled = false; btn.textContent = "备份"; }
};
document.getElementById("import").onclick = () => document.getElementById("importFile").click();
document.getElementById("importFile").onchange = async (ev) => {
  const f = ev.target.files[0]; ev.target.value = "";
  if (!f) return;
  if (!confirm(`从“${f.name}”恢复？\n只会把现在没有的收藏、方案、风格卡和画面加回来，不会覆盖或删除现有数据。`)) return;
  const btn = document.getElementById("import"); btn.disabled = true; btn.textContent = "恢复中…";
  try {
    const r = await importBackup(f, (m) => { btn.title = m; });
    alert(`恢复完成：加回 ${r.items} 条收藏、${r.plans} 个分镜方案、${r.cards} 张风格卡、${r.files} 组画面/视频/关键帧。${r.needKey ? "\n备份里不含 API Key，请到设置页重新填写。" : ""}`);
    location.reload();
  } catch (e) { toast("恢复失败：" + e.message); btn.disabled = false; btn.textContent = "恢复"; }
};
init();
