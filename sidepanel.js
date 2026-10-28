import { h, displayTitle, STATUS, loadAll, likeChips, copyButton, relTime, isPostUrl, openLibrary, bg, itemError, failureInfo } from "./ui.js";

const app = document.getElementById("app");
let tab = null;
let busy = false;

async function currentTab() {
  const [t] = await chrome.tabs.query({ active: true, lastFocusedWindow: true });
  return t || null;
}

function currentBlock(data) {
  const m = isPostUrl(tab && tab.url);
  if (!data.hasKey) {
    return h("div", { class: "card hero" },
      h("div", { class: "icon" }, "🔑"), h("h3", {}, "还差一步：填写 API Key"),
      h("p", { class: "muted" }, "去设置页填好 Key，就能开始收藏视频的风格了"),
      h("button", { class: "primary", onclick: () => chrome.runtime.openOptionsPage() }, "去设置"));
  }
  if (!m) {
    return h("div", { class: "card hero" },
      h("div", { class: "icon" }, "🎬"), h("h3", {}, "打开一条视频帖"),
      h("p", { class: "muted" }, "在 X 上点进一条 AI 视频帖，这里就会出现“拆解”按钮。"));
  }
  const tweetId = m[1];
  const item = data.items.find((x) => x.tweetId === tweetId);

  if (!item) {
    return h("div", { class: "card hero" },
      h("h3", {}, "这条视频还没拆解"),
      h("p", { class: "muted" }, "点一下就好，分析在后台进行，你可以继续刷。"),
      h("button", { class: "primary", style: { width: "100%" }, disabled: busy, onclick: () => enqueue("style") }, busy ? "正在加入…" : "收藏风格"),
      h("p", { class: "muted", style: { margin: "8px 0 0", fontSize: "12px" } }, "只提取风格：配方、声音、提示词模板、标签，最快。"),
      h("button", { class: "ghost small", style: { width: "100%", marginTop: "6px" }, disabled: busy, onclick: () => enqueue("full") }, "完整拆解（含逐镜头）"));
  }
  if (item.status === "queued" || item.status === "processing") {
    // 实测临时上传可能超过一分钟，避免原 10–40 秒预估造成任务卡住的误解。
    return h("div", { class: "card" },
      h("h3", {}, item.status === "queued" ? "排队中…" : "正在看这条视频…"),
      h("p", { class: "muted", style: { margin: "4px 0 0" } }, "上传和分析可能需要几分钟，完成后会通知你。"),
      h("div", { class: "progress" }, h("span")));
  }
  if (item.status === "failed") {
    return h("div", { class: "card" },
      h("h3", {}, "这次没拆解成功"),
      h("p", { class: "muted" }, itemError(item)),
      failureInfo(item),
      h("button", { onclick: () => chrome.runtime.sendMessage({ type: "retry", id: item.id }) }, "重试"));
  }
  const r = item.result || {};
  return h("div", { class: "card current" },
    r.thumb ? h("div", { class: "thumb", style: bg(r.thumb) }) : null,
    h("div", { class: "section" }, h("h3", {}, displayTitle(item)), h("div", { class: "muted" }, r.summary || "")),
    h("div", { class: "section" }, h("div", { class: "label" }, "你喜欢它哪里？可多选，也可以跳过"), likeChips(item, data.picks)),
    h("div", { class: "section" },
      h("div", { class: "spread" }, h("div", { class: "label", style: { margin: 0 } }, r.style_template_zh ? "风格模板（替换【主题】即可用）" : "一句话风格"), copyButton(r.style_template_zh || r.style_prompt_zh)),
      h("p", { class: "prompt", style: { marginTop: "8px" } }, r.style_template_zh || r.style_prompt_zh || "")),
    (r.author_disclosed && r.author_disclosed.found)
      ? h("div", { class: "section muted" }, "✓ 作者公开了提示词" + ((r.author_disclosed.tools || []).length ? "（" + r.author_disclosed.tools.join("、") + "）" : ""))
      : null,
    h("div", { class: "section" }, h("button", { style: { width: "100%" }, onclick: () => openLibrary("item/" + item.id) }, (item.result && item.result.style_only ? "查看风格详情 →" : "查看完整拆解 →"))));
}

function recentBlock(data) {
  const others = data.items.slice().sort((a, b) => b.createdAt - a.createdAt).slice(0, 5);
  if (!others.length) return null;
  return h("div", { style: { marginTop: "26px" } },
    h("div", { class: "label" }, "最近"),
    others.map((x) => h("div", { class: "recent", onclick: () => openLibrary("item/" + x.id) },
      h("div", { class: "thumb", style: bg(x.result && x.result.thumb) }),
      h("div", { class: "t" },
        h("div", {}, x.status === "done" ? displayTitle(x) : "@" + x.handle),
        h("div", { class: "muted" }, h("span", { class: "dot " + x.status }), " ", STATUS[x.status], " · ", relTime(x.createdAt))))));
}

async function render() {
  tab = await currentTab();
  const data = await loadAll();
  app.textContent = "";
  app.append(currentBlock(data));
  const rb = recentBlock(data);
  if (rb) app.append(rb);
}

async function enqueue(mode = "style") {
  busy = true; render();
  const r = await chrome.runtime.sendMessage({ type: "enqueue", tab: { id: tab.id, url: tab.url }, mode });
  busy = false;
  if (!r || (!r.ok && r.reason !== "duplicate")) alert("没能加入队列：" + ((r && r.reason) || "未知错误"));
  render();
}

document.getElementById("home").onclick = () => openLibrary("home");
document.getElementById("opt").onclick = () => chrome.runtime.openOptionsPage();
chrome.tabs.onActivated.addListener(render);
chrome.tabs.onUpdated.addListener((_id, info) => { if (info.url || info.status === "complete") render(); });
chrome.storage.onChanged.addListener(render);
render();
