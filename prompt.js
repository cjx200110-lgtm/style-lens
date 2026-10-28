import { DIMENSIONS } from "./vocab.js";

// 两家模型共用同一份提示词与结构。
// v0.4：不再让模型逐字输出“完整复刻提示词”（中英两份几乎是分镜的重复，最耗时、最容易被截断），
// 复刻提示词改由本地根据分镜拼出；省下的输出用于“风格配方”，方便换题材复刻。

const vocabText = DIMENSIONS.map((d) => `- ${d.key}（${d.label}）：${d.values.join(" / ")}`).join("\n");

export const STYLE_GUIDE_KEYS = [
  ["medium", "媒介质感"], ["color", "色彩调色"], ["lighting", "光影"], ["composition", "构图景别"],
  ["camera", "运镜"], ["editing", "剪辑节奏"], ["effects", "特效后期"], ["sound", "声音设计"], ["mood", "整体情绪"]
];

// 准确性规则：对所有视频通用（实拍、3D、手绘、界面演示都适用），不针对某一类画面
export const ACCURACY_RULES = `【准确性规则，最重要】
A. 只写在画面里确实看到、听到的东西。看不清的宁可写笼统（例如“一个橙色的小角色”“一个蓝色的小物件”），或写“看不清”，不要猜成具体的东西；不要用某类风格的常见印象去补细节（例如不能因为是手绘风就默认横线纸，不能因为是科技风就默认霓虹光）。
B. 容易混在一起的要分开写：
   - 背景/底面是什么（纸、墙、天空、棚拍背景、软件界面等，按实际写）以及它的颜色和质地；
   - 轮廓/勾线/边缘的颜色和粗细，与填色/上色/材质分开写；
   - 某个特征只出现在部分元素上时，写清是哪些元素，不要推广到整个画面（例如“彩色笔只用于标题和标注”不能写成“彩色笔勾勒全部”）；
   - 不同元素的浓淡、饱和度不同时分别写。
C. 颜色写具体色相，并按主要主体/阵营分别写（例如“深靛蓝”“橙红”“米灰”），不要笼统写成“红蓝”“彩色”。
D. 每个维度都要检查一遍，用不上的写“无”：视角与透视（俯视/平视/仰视、有无透视）；元素出现、变化、消失的方式（例如先勾轮廓再上色、逐字出现、淡入、飞入）；画面里的文字、界面、贴纸、装饰元素。
E. 动作写清“谁、从哪里到哪里、做了什么、结果是什么”。没有发生的动作不要写，主体没动就写静止。
F. 声音只写确实听得出的：乐器听不准就写音色特征（例如“明亮的拨弦音色”），不要硬写成某种乐器；没有人声就写无。`;
// ---------- 用清晰截图校对（看视频时每帧较模糊，容易认错、编造、漏掉） ----------
export function proofShotsPrompt(shots) {
  return `你是视频分镜校对员。上面是同一条视频按时间顺序截下的清晰画面，每张图前标了它属于哪个镜头、第几秒。
下面是之前看视频写的镜头描述。看视频时画面比较模糊，描述可能有认错的主体、编造的东西或漏掉的重要元素。

请逐个镜头对照截图核对 visual（画面）、action（动作）、camera（运镜）、light（光影色彩）：
- 截图能确认的，按截图改正：认错的主体改成截图里的样子；截图里根本没有的东西删掉；截图里明显、描述却漏掉的重要元素补上。
- 截图之间的动作过程看不全：描述的动作和截图矛盾才改，不矛盾就保留原意，但不要新增截图里看不出来的细节。
- 声音不改，时间不改。
- 字数和原来差不多（visual 50 字内，其余 30 字内）。

${ACCURACY_RULES}

镜头描述（n 是镜头序号）：
${JSON.stringify(shots)}

只输出 JSON：{"shots":[{"n":1,"visual":"…","action":"…","camera":"…","light":"…","changed":"一句话说改了什么；没改写空字符串"}]}，每个镜头都要返回。`;
}
export function proofStylePrompt(style) {
  return `你是视频风格校对员。上面是从整条视频均匀截下的清晰画面（按时间顺序）。
下面是之前看视频写的风格总结。看视频时画面比较模糊，可能把背景、线条、上色、配色、视角等看错，或者漏掉明显的风格特征。

请对照截图逐项核对并改正 style_guide 各项、style_template_zh、style_template_en、style_prompt_zh：
- 截图能确认的按截图改：背景/底面、勾线与上色、各主体的配色色相、视角透视、元素出现的方式、画面里的文字和界面元素等。
- 截图看不出来的（声音、剪辑节奏、运镜）保持原样，除非和截图明显矛盾。
- 模板继续用【主题】和 [SUBJECT] 做占位符，只写风格做法，不写具体题材内容；长度和原来差不多。

${ACCURACY_RULES}

原风格总结：
${JSON.stringify(style)}

只输出 JSON：{"style_guide":{"medium":"","color":"","lighting":"","composition":"","camera":"","editing":"","effects":"","sound":"","mood":""},"style_template_zh":"","style_template_en":"","style_prompt_zh":"","changes":["一句话一条，说明改了什么；没改就是空数组"]}`;
}
export function analysisPrompt(ctx) {
  const post = ctx && (ctx.mainText || ctx.syndicationText) ? (ctx.mainText || ctx.syndicationText) : "（无）";
  const replies = ctx && ctx.authorReplies && ctx.authorReplies.length ? ctx.authorReplies.map((r, i) => `${i + 1}. ${r}`).join("\n") : "（无）";
  return `你是一名 AI 视频导演和风格分析师。请认真观看并收听附带的视频（逐个镜头看画面，同时听声音）。目标：
① 逐镜头拆解，方便用户对照原片学习；
② 提炼与题材无关的“风格配方”，让用户把同样的风格套到自己的题材上，在即梦、可灵、Sora、Veo 等工具里生成新视频；
③ 把风格标签存入用户的审美库做长期统计。

【帖子正文】
${post}

【作者本人在帖子下的回复】
${replies}

要求（只输出一个 JSON 对象）：
1. video_visible：是否真的看到了视频画面。看不到就设为 false，其余字段留空，不要猜测。
2. author_disclosed：从帖子正文和作者回复里找作者公开的提示词、工具名（如 Kling、Veo、Sora、即梦、Midjourney、Runway）。找到就原文填入 prompt 和 tools，found=true；找不到 found=false。
3. title：6-12 个字的短标题，像收藏夹里的名字，点出“题材+风格”，例如“复古电脑代码奇观”。不要以“该视频”“视频展示了”开头。
4. summary：一句话（40 字内）概括内容。
5. shots：按镜头拆分，最多 24 段（闪切很多时把相邻相似的合并成一段）。每段：
   start / end：起止秒，JSON 数字，保留一位小数；end 必须大于 start，下一段的 start 等于上一段的 end。
   visual 画面内容；action 主体动作及方向（如“从左往右走”，没有动作写“静止”）；camera 运镜；light 光影色彩；audio 声音。每项 30 字内，具体、可执行。
6. soundtrack：整体配乐和音效，一句话。
   audio_detail：认真听声音，分四项写：dialogue 台词/旁白/歌词逐字转写（标注大致秒数，没有写“无”）；music 音乐类型、主要乐器、节奏快慢（估计 BPM）、情绪走向；sfx 关键音效及出现秒数；beat_sync 画面切点是否对齐音乐节拍、在哪些秒数卡点。
7. style_guide：与具体题材无关的风格要素，每项写成能直接放进提示词的具体短语。不要写“很有科技感”这类空话，要写出做法，例如“复古米色CRT屏幕、绿色等宽字体”“每0.5–1秒硬切一次，切点对齐鼓点”。字段：
   medium 媒介与质感（包括背景/底面是什么、什么质地，勾线和上色/材质的做法分开写）；color 色彩与调色（按主体分别写具体色相，线条颜色和填色分开）；lighting 光影；composition 构图、景别与视角透视；camera 运镜方式；editing 剪辑节奏与转场；effects 特效与后期（故障、颗粒、叠加等，没有就写“无”）；sound 声音设计；mood 整体情绪。
8. style_template_zh：一段可复用的中文风格提示词模板（80-160 字）。把题材换成占位符【主题】，其余写满风格要素（媒介质感、色彩、光影、构图、运镜、剪辑节奏与转场、特效、声音）。如果原片是多镜头快剪，写明大致镜头数、每镜时长和镜头之间的变化规律。用户替换【主题】后应能直接用于 AI 视频生成。
9. style_template_en：上一条的英文版，占位符写作 [SUBJECT]。
10. style_prompt_zh：一句话风格概括（30 字内）。
11. style_tags 的每一项只能从下面的固定词表中选一个最贴切的值，原样填写：
${vocabText}
12. creative_tag：4-10 个字概括最打动人的创意点。creative_point：一句话说明打动人的地方。tool_guess：推测使用的 AI 工具。
13. duration_sec：视频总秒数（数字）。aspect：只能是“竖屏”“横屏”“方形”之一。
14. 只写视频里真实存在的元素，不要添加原片没有的风格；除 style_template_en 外，说明文字都用中文。

${ACCURACY_RULES}`;
}

// 通用 JSON Schema（千问放在提示词里；Gemini 转成它自己的格式）
const S = (type, extra = {}) => ({ type, ...extra });
export const AUDIO_KEYS = [["dialogue", "台词/旁白"], ["music", "音乐"], ["sfx", "音效"], ["beat_sync", "卡点"]];
const ORDER = ["video_visible", "title", "summary", "duration_sec", "aspect", "author_disclosed", "shots", "soundtrack", "audio_detail",
  "style_guide", "style_template_zh", "style_template_en", "style_prompt_zh", "style_tags", "creative_tag", "creative_point", "tool_guess"];
export const REQUIRED_WHEN_VISIBLE = ["title", "summary", "duration_sec", "aspect", "author_disclosed", "shots", "soundtrack", "audio_detail",
  "style_guide", "style_template_zh", "style_template_en", "style_prompt_zh", "style_tags", "creative_tag"];

const SHOT_KEYS = ["start", "end", "visual", "action", "camera", "light", "audio"];
export const baseSchema = {
  type: "object",
  properties: {
    video_visible: S("boolean"),
    title: S("string"),
    summary: S("string"),
    duration_sec: S("number"),
    aspect: S("string", { enum: ["竖屏", "横屏", "方形"] }),
    author_disclosed: {
      type: "object",
      properties: { found: S("boolean"), tools: { type: "array", items: S("string") }, prompt: S("string") },
      required: ["found"]
    },
    shots: {
      type: "array",
      items: {
        type: "object",
        properties: {
          start: S("number"), end: S("number"), visual: S("string"), action: S("string"),
          camera: S("string"), light: S("string"), audio: S("string")
        },
        required: SHOT_KEYS,
        propertyOrdering: SHOT_KEYS
      }
    },
    soundtrack: S("string"),
    audio_detail: {
      type: "object",
      properties: Object.fromEntries(AUDIO_KEYS.map(([k]) => [k, S("string")])),
      required: AUDIO_KEYS.map(([k]) => k),
      propertyOrdering: AUDIO_KEYS.map(([k]) => k)
    },
    style_guide: {
      type: "object",
      properties: Object.fromEntries(STYLE_GUIDE_KEYS.map(([k]) => [k, S("string")])),
      required: STYLE_GUIDE_KEYS.map(([k]) => k),
      propertyOrdering: STYLE_GUIDE_KEYS.map(([k]) => k)
    },
    style_template_zh: S("string"),
    style_template_en: S("string"),
    style_prompt_zh: S("string"),
    style_tags: {
      type: "object",
      properties: Object.fromEntries(DIMENSIONS.map((d) => [d.key, S("string", { enum: d.values })])),
      required: DIMENSIONS.map((d) => d.key)
    },
    creative_tag: S("string"),
    creative_point: S("string"),
    tool_guess: S("string")
  },
  required: ["video_visible", ...REQUIRED_WHEN_VISIBLE],
  propertyOrdering: ORDER
};

// Gemini 的 responseSchema 用大写类型，且不认识部分 JSON Schema 关键字
export function toGeminiSchema(node) {
  if (Array.isArray(node)) return node.map(toGeminiSchema);
  if (!node || typeof node !== "object") return node;
  const out = {};
  for (const [k, v] of Object.entries(node)) {
    if (k === "type") out.type = String(v).toUpperCase();
    else if (k === "properties") out.properties = Object.fromEntries(Object.entries(v).map(([pk, pv]) => [pk, toGeminiSchema(pv)]));
    else if (k === "items") out.items = toGeminiSchema(v);
    else if (["enum", "required", "propertyOrdering"].includes(k)) out[k] = v;
  }
  return out;
}
// 千问把结构写在提示词里，去掉 propertyOrdering 这种非标准字段
export function toJsonSchema(node) {
  if (Array.isArray(node)) return node.map(toJsonSchema);
  if (!node || typeof node !== "object") return node;
  const out = {};
  for (const [k, v] of Object.entries(node)) {
    if (k === "propertyOrdering") continue;
    if (k === "properties") out.properties = Object.fromEntries(Object.entries(v).map(([pk, pv]) => [pk, toJsonSchema(pv)]));
    else if (k === "items") out.items = toJsonSchema(v);
    else out[k] = v;
  }
  return out;
}

// ---------- 不需要视频的二次文本任务（老收藏补“风格配方”、按需生成英文提示词） ----------
export function recipePrompt(r) {
  const shots = (r.shots || []).slice(0, 30).map((s) => `${s.start}-${s.end}s：${s.visual}；动作：${s.action}；运镜：${s.camera}；声音：${s.audio}`).join("\n");
  const tags = Object.entries(r.style_tags || {}).map(([k, v]) => `${k}=${v}`).join("，");
  return `下面是一条 AI 视频的逐镜头拆解。请据此提炼与具体题材无关的“风格配方”，让用户能把同样的风格套到自己的题材上。

【概括】${r.summary || ""}
【一句话风格】${r.style_prompt_zh || ""}
【风格标签】${tags}
${r.author_disclosed && r.author_disclosed.found && r.author_disclosed.prompt ? "【作者公开的原版提示词（最可信的风格依据）】" + r.author_disclosed.prompt.slice(0, 1500) + "\n" : ""}【分镜】
${shots}

只输出一个 JSON 对象，字段：
- style_guide：对象，字段 ${STYLE_GUIDE_KEYS.map(([k, l]) => `${k}（${l}）`).join("、")}。每项写成能直接放进提示词的具体短语，写出做法，不要空话；没有的写“无”。
- style_template_zh：80-160 字的中文风格提示词模板，题材用占位符【主题】，其余写满风格要素；多镜头快剪要写明大致镜头数、每镜时长和变化规律。
- style_template_en：上一条的英文版，占位符写作 [SUBJECT]。
- title：6-12 个字的短标题，点出“题材+风格”，不要以“该视频”开头。
只根据拆解里真实存在的元素来写。`;
}

export function translatePrompt(zh) {
  return `把下面的 AI 视频分镜提示词翻译成英文，保持逐行结构和时间码，术语使用视频生成工具（Sora、Veo、Kling、Runway）常用的英文表达。只输出译文，不要任何解释。

${zh}`;
}

// ---------- 风格分组 ----------
function itemDigest(x, picks) {
  const r = x.result || {};
  const guide = Object.entries(r.style_guide || {}).map(([k, v]) => `${k}:${v}`).join("；");
  const tags = Object.values(r.style_tags || {}).join("、");
  return `[${x.id}] ${r.title || r.creative_tag || ""}｜${r.summary || ""}｜风格：${r.style_prompt_zh || ""}${guide ? "｜要素：" + guide : ""}｜标签：${tags}${(picks || []).length ? "｜用户喜欢：" + picks.join("、") : ""}`;
}
export function groupPrompt(items, picks) {
  const n = items.length;
  return `下面是一位用户收藏的 ${n} 条 AI 视频的风格拆解。请把风格确实相近的收藏归成组，方便她以后选一组作为参考来创作新视频。

分组原则：
- 组数不固定，按实际情况来：有几类明显的共同风格就分几组。宁缺毋滥，不要为了凑组把风格不同的视频放在一起。
- 一组至少 2 条，组内的视频要有明确、具体的共同风格手法（质感、色彩、光影、运镜、剪辑节奏、声音里至少几项一致），不能只是“都很酷”“都是 AI 生成”这种笼统的共同点。
- 风格独特、和其他收藏都不像的，不要放进任何组；全部都不像就返回空的 groups。
- 按视觉风格 + 适用场景分，例如“产品宣传·冷峻科技感”“治愈手绘·生活小品”，而不是按题材内容（猫、汽车）分。
- 每条收藏最多属于一组。组名 6-14 个字，用“用途·风格”的格式。

只输出一个 JSON 对象：
{"groups":[{"name":"组名","description":"一句话说明这组的共同特点和适合做什么","core":"这组共同的风格配方，60-120 字，写成可直接用于视频提示词的具体手法（质感、色彩、光影、运镜、剪辑节奏、声音）","item_ids":["收藏编号", "..."]}]}

收藏列表（方括号里是收藏编号，原样填写）：
${items.map((x) => itemDigest(x, picks[x.id])).join("\n")}`;
}

// ---------- 剪辑节奏：在本地从拆解结果算出“几秒一切”，作为硬性要求交给模型 ----------
// 合并过的画面段（merged）按里面的快切次数算，否则快切视频会被当成慢节奏
export function paceOf(r) {
  const shots = (r && r.shots) || [];
  if (shots.length < 2) return null;
  const dur = Number(r.duration_sec) || shots[shots.length - 1].end;
  if (!(dur > 0)) return null;
  let cuts = 0, fastest = Infinity;
  for (const s of shots) { const n = Math.max(1, Number(s.merged) || 1); cuts += n; fastest = Math.min(fastest, (s.end - s.start) / n); }
  return { dur, cuts, avg: dur / cuts, fastest: Math.max(0.1, fastest) };
}
const f1 = (n) => (Math.round(n * 10) / 10).toString();
export function paceRule(refs, targetSec) {
  const ps = refs.map((x) => paceOf(x.result)).filter(Boolean);
  if (!ps.length) return { text: "", shots: 0 };
  const totalDur = ps.reduce((a, p) => a + p.dur, 0);
  const avg = ps.reduce((a, p) => a + p.avg * p.dur, 0) / totalDur; // 按时长加权
  const fastest = Math.min(...ps.map((p) => p.fastest));
  const t = Number(targetSec) || 10;
  const n = Math.min(40, Math.max(1, Math.round(t / avg)));
  const lo = Math.max(1, Math.round(n * 0.85)), hi = Math.min(40, Math.max(n, Math.round(n * 1.15)));
  const fast = avg < 1.2;
  const text = `【剪辑节奏 · 硬性要求】参考视频${ps.length > 1 ? "平均" : ""}每 ${f1(avg)} 秒切一次画面（${ps.map((p) => `${f1(p.dur)} 秒里 ${p.cuts} 个画面`).join("；")}），最快的一镜约 ${f1(fastest)} 秒。
新视频约 ${t} 秒，按同样的速度，必须设计 ${lo === hi ? n : `${lo}–${hi}`} 个镜头（约 ${n} 个），平均每镜约 ${f1(t / n)} 秒。镜头数少于 ${lo} 个就是没做到。${fast ? `
这是快剪风格：不要为了好写把几个快切合并成一个长镜头；连续闪切的地方每个画面都单独写一个镜头，最短可以到 ${f1(Math.max(0.2, fastest))} 秒。快慢分布参照参考视频（例如开头/高潮处更密）。` : ""}`;
  return { text, shots: n, avg, lo };
}

// ---------- 用一组/一条收藏的风格，生成新主题的分镜方案 ----------
export function planPrompt(refs, brief, picks) {
  const pace = paceRule(refs, brief.duration);
  const refText = refs.map((x, i) => {
    const r = x.result || {};
    const shots = (r.shots || []).slice(0, 40).map((s, j) => `  ${j + 1}. ${s.start}-${s.end}s${s.merged > 1 ? `（这一段里快速切了 ${s.merged} 个画面）` : ""} ${s.visual}｜运镜:${s.camera}｜光影:${s.light || ""}｜声音:${s.audio}`).join("\n");
    const audio = Object.values(r.audio_detail || {}).filter(Boolean).join("；");
    return `【R${i + 1}】${r.title || ""}（${r.duration_sec || "?"}秒，${r.aspect || ""}）
风格配方：${Object.entries(r.style_guide || {}).map(([k, v]) => `${k}:${v}`).join("；") || r.style_prompt_zh || ""}
声音：${r.soundtrack || ""}${audio ? "｜" + audio : ""}
${(picks[x.id] || []).length ? "用户最喜欢：" + picks[x.id].join("、") + "\n" : ""}分镜：
${shots}`;
  }).join("\n\n");
  return `你是一名 AI 视频导演。用户收藏了下面 ${refs.length} 条参考视频，现在想用它们的风格手法，做一条自己的新视频。

【新视频需求】
主题/内容：${brief.subject}
时长：约 ${brief.duration} 秒；画幅：${brief.aspect}
${brief.extra ? "其他要求：" + brief.extra : ""}

【参考视频】
${refText}
${authorPromptNote(refs)}
${pace.text}

要求：
1. 只借鉴参考视频的风格手法（质感、色彩、光影、构图、运镜、剪辑节奏、转场、声音设计），内容完全围绕用户的新主题。不要照搬参考视频的具体角色、品牌、文字、标志性画面。
2. 用户“最喜欢”的点要优先保留。多条参考风格有冲突时，取它们的共同点，并在 style_summary 里说明取舍。
3. 设计完整分镜，镜头总时长等于需求时长；${pace.text ? "镜头数量和每镜时长严格按上面的【剪辑节奏】，用户的“其他要求”里另有说明的以用户为准" : "节奏参照参考视频（快剪就快剪）"}。切点尽量卡在配乐节拍上。每个镜头的描述要具体到可以直接拿去 AI 生成${pace.shots > 16 ? "，镜头多时每镜描述写精炼（30 字左右）" : ""}。
4. 每个镜头标出主要借鉴了哪条参考的哪个镜头（ref，例如 "R1-3"），没有明确对应就写 "整体风格"。
- 每个镜头另外标出生成难点 difficulty（true/false）：face 人脸占画面较大或有表情变化；hands 手部特写或手部操作；text 画面里必须出现正确的文字/Logo；multi 两个以上的人有互动；physics 液体、烟雾、爆炸、布料、快速变形等复杂物理；recurring 主角/产品在多个镜头里出现、需要前后一致。如实判断，不要全标 true。

只输出一个 JSON 对象：
{"title":"6-12字标题","concept":"一句话创意","style_summary":"继承了哪些风格手法，60字内",
"shots":[{"start":0,"end":1.5,"visual":"画面","action":"主体动作及方向","camera":"运镜","light":"光影色彩","audio":"声音","ref":"R1-3","difficulty":{"face":false,"hands":false,"text":false,"multi":false,"physics":false,"recurring":true}}],
"soundtrack":"整体配乐与音效建议",
"style_prompt_zh":"整条视频通用的风格提示词，80-150字，可附加在每个镜头提示词后面",
"style_prompt_en":"上一条的英文版"}`;
}

// ---------- 风格卡：把一组收藏的审美沉淀成可复用的资产 ----------
export const CARD_KEYS = [...STYLE_GUIDE_KEYS.filter(([k]) => k !== "sound" && k !== "mood"), ["transition", "转场"], ["mood", "情绪气质"]];
export function distillPrompt(items, picks, hint = "") {
  const text = items.map((x, i) => {
    const r = x.result || {};
    const guide = Object.entries(r.style_guide || {}).map(([k, v]) => `${k}:${v}`).join("；");
    const audio = Object.values(r.audio_detail || {}).filter(Boolean).join("；");
    const shots = (r.shots || []).slice(0, 8).map((s) => `${s.camera}/${s.light || ""}`).join("，");
    return `【${i + 1}】${r.title || ""}｜${r.style_prompt_zh || ""}
要素：${guide || "（无）"}
声音：${r.soundtrack || ""}${audio ? "｜" + audio : ""}
镜头手法：${shots}
标签：${Object.values(r.style_tags || {}).join("、")}${(picks[x.id] || []).length ? "\n她最喜欢：" + picks[x.id].join("、") : ""}`;
  }).join("\n\n");
  return `你是一名 AI 视频的美术指导。下面是一位创作者收藏的 ${items.length} 条视频的风格拆解${hint ? "，她把它们归为「" + hint + "」" : ""}。
请把它们的**共同风格**提炼成一张可以反复使用的“风格卡”。风格卡只描述风格手法，和任何具体题材、角色、品牌、文字无关，以后可以套用到完全不同的主题上。
她亲自勾选的“最喜欢”要优先保留；各条视频不一致的地方取共同点，不要硬凑。

只输出一个 JSON 对象：
{"name":"风格卡名字，4-10 字，好记有画面感，例如“冷峻悬浮”“黏土日常”",
"tagline":"一句话定义这个风格，30 字内",
"recipe":{${CARD_KEYS.map(([k, l]) => `"${k}":"${l}，写成可直接放进提示词的具体做法"`).join(",")}},
"sound":"声音设定：音乐类型、乐器、BPM 范围、卡点方式、音效特点",
"avoid":"这个风格要避开的东西，3-5 条，用顿号分隔",
"template_zh":"中文风格提示词模板，100-180 字，题材用占位符【主题】，其余写满风格要素和剪辑节奏",
"template_en":"英文版，占位符写作 [SUBJECT]"}

收藏：
${text}
${authorPromptNote(items)}`;
}

export function cardPlanPrompt(card, brief, refs = []) {
  const pace = paceRule(refs, brief.duration);
  const recipe = CARD_KEYS.map(([k, l]) => (card.recipe || {})[k] ? `${l}：${card.recipe[k]}` : "").filter(Boolean).join("\n");
  return `你是一名 AI 视频导演。用户有一张自己积累的“风格卡”，现在要用这个风格做一条新视频。

【新视频需求】
主题/内容：${brief.subject}
时长：约 ${brief.duration} 秒；画幅：${brief.aspect}
${brief.extra ? "其他要求：" + brief.extra : ""}

【风格卡：${card.name}】
${card.tagline || ""}
${recipe}
声音设定：${card.sound || ""}
要避开：${card.avoid || "（无）"}
风格模板：${card.template_zh || ""}
${pace.text ? "\n" + pace.text.replace("参考视频", "这张风格卡的原始视频") + "\n" : ""}
要求：
1. 严格遵守风格卡的手法（质感、色彩、光影、构图、运镜、剪辑节奏、转场、声音），内容完全围绕新主题。
2. 设计完整分镜，镜头总时长等于需求时长，节奏严格符合风格卡的剪辑节奏：剪辑节奏里写了“每 X 秒一切”的，用需求时长除以 X 得出镜头数，照这个数设计，不要合并快切；切点尽量卡在配乐节拍上。每个镜头具体到可以直接拿去 AI 生成。
3. 不要出现风格卡“要避开”的东西。
- 每个镜头另外标出生成难点 difficulty（true/false）：face 人脸占画面较大或有表情变化；hands 手部特写或手部操作；text 画面里必须出现正确的文字/Logo；multi 两个以上的人有互动；physics 液体、烟雾、爆炸、布料、快速变形等复杂物理；recurring 主角/产品在多个镜头里出现、需要前后一致。如实判断，不要全标 true。

只输出一个 JSON 对象：
{"title":"6-12字标题","concept":"一句话创意","style_summary":"这条视频怎样体现了这张风格卡，60字内",
"shots":[{"start":0,"end":1.5,"visual":"画面","action":"主体动作及方向","camera":"运镜","light":"光影色彩","audio":"声音","ref":"风格卡","difficulty":{"face":false,"hands":false,"text":false,"multi":false,"physics":false,"recurring":true}}],
"soundtrack":"整体配乐与音效建议","style_prompt_zh":"整条视频通用的风格提示词，80-150字","style_prompt_en":"上一条的英文版"}`;
}

// ---------- 分工拆解（Gemini）：风格部分一份 + 镜头按时间分段，同时进行 ----------
// 镜头上限跟着视频长度走：30 秒内 24 段；30–60 秒 40 段；更长约每 2 秒一段，最多 80 段。每份最多写 20~24 段
export function shotPlan(durationSec) {
  const d = Number(durationSec) || 0;
  const cap = d <= 30 ? 24 : d <= 60 ? 40 : Math.min(80, Math.ceil(d / 2));
  const parts = d <= 30 ? 1 : Math.ceil(cap / 20);
  const seg = d / parts;
  const ranges = Array.from({ length: parts }, (_, i) => [Math.round(i * seg * 10) / 10, i === parts - 1 ? Math.round(d * 10) / 10 : Math.round((i + 1) * seg * 10) / 10]);
  return { cap, perPart: Math.ceil(cap / parts), ranges: d ? ranges : [[0, 0]], long: d > 180 };
}
function ctxText(ctx) {
  const post = ctx && (ctx.mainText || ctx.syndicationText) ? (ctx.mainText || ctx.syndicationText) : "（无）";
  const replies = ctx && ctx.authorReplies && ctx.authorReplies.length ? ctx.authorReplies.map((r, i) => `${i + 1}. ${r}`).join("\n") : "（无）";
  return `【帖子正文】\n${post}\n\n【作者本人在帖子下的回复】\n${replies}`;
}
// 风格部分：除逐镜头拆解外的全部内容（与原提示词的要求逐条一致）
export function metaPrompt(ctx) {
  const full = analysisPrompt(ctx);
  return full
    .replace(/5\. shots：[\s\S]*?每项 30 字内，具体、可执行。\n/, "5. （逐镜头拆解由另一份任务同时完成，这里不要输出 shots 字段，但请完整观看视频，风格判断要基于全部镜头。）\n");
}
export function shotsPrompt(ctx, from, to, max, total, parts) {
  const range = parts > 1 ? `只拆解视频 ${from} 秒到 ${to} 秒之间的镜头（整条视频共约 ${total} 秒，其余时间段由其他任务负责）。起止秒用整条视频的绝对时间；跨越 ${from} 秒或 ${to} 秒的镜头，在边界处截断。` : "拆解整条视频的全部镜头。";
  return `你是一名 AI 视频导演。请认真观看并收听附带的视频（逐个镜头看画面，同时听声音），做逐镜头拆解，方便用户对照原片学习和复刻。

${ctxText(ctx)}

${range}
只输出一个 JSON 对象，字段：
1. video_visible：是否真的看到了视频画面。看不到就设为 false，shots 留空，不要猜测。
2. shots：按“画面段”拆分，最多 ${max} 段。分段规则（很重要，用户会按段去生成视频）：
   - 同一个场景、同一个主体的连续画面算一段，即使中间有闪烁、故障效果、文字滚动、推拉摇移、主体动作或形变，也不要切开；
   - 只有画面整体换成另一个场景或另一个主体（真正的剪辑切换）时，才开始新的一段；
   - 切点要对准画面真正切换的那一帧，精确到 0.1 秒；看不准时，宁可把相似画面合在同一段，也不要把一个连续画面切成两段。
   每段：
   start / end：起止秒，JSON 数字，保留一位小数；end 必须大于 start，下一段的 start 等于上一段的 end。
   visual 这一段的画面内容，并按时间顺序写出段内的变化（例如“复古电脑屏幕显示代码，随后剧烈闪烁、出现故障条纹”），50 字内；action 主体动作及方向（没有动作写“静止”）；camera 运镜；light 光影色彩；audio 声音。具体、可执行。
   merged：这一段如果是把几个快速切换的不同画面合并成的（段数太多、超过 ${max} 段时才这样合并），填合并了几个画面；否则填 0。
3. 只写视频里真实存在的元素；说明文字用中文。

${ACCURACY_RULES}`;
}
const pick = (obj, keys) => Object.fromEntries(Object.entries(obj).filter(([k]) => keys.includes(k)));
export const metaSchema = (() => {
  const props = { ...baseSchema.properties }; delete props.shots;
  return { ...baseSchema, properties: props, required: baseSchema.required.filter((k) => k !== "shots"), propertyOrdering: baseSchema.propertyOrdering.filter((k) => k !== "shots") };
})();
export const shotsSchema = (() => {
  const shot = baseSchema.properties.shots;
  const item = { ...shot.items, properties: { ...shot.items.properties, merged: { type: "number" } }, propertyOrdering: [...shot.items.propertyOrdering, "merged"] };
  return { type: "object", properties: { video_visible: baseSchema.properties.video_visible, shots: { ...shot, items: item } }, required: ["video_visible", "shots"], propertyOrdering: ["video_visible", "shots"] };
})();
void pick;

// ---------- 作者公开的提示词：改成我的主题 ----------
export function rewritePrompt(orig, subject) {
  return `下面是一位创作者公开的 AI 视频/图片提示词。请把它改成新主题，用于生成一条风格相同、内容不同的视频。

【原提示词】
${orig}

【新主题】
${subject}

要求：
1. 保留原提示词的风格写法：画面质感、色彩、光影、镜头语言、运镜、节奏、声音描述、结构和参数（例如 --ar、--style、时长、画幅）都保持不变。
2. 只把具体的主角、物体、场景、情节换成新主题的内容；原提示词里的人名、品牌、Logo、专属角色要换掉，不能保留。
3. 用和原提示词相同的语言写（原文是英文就写英文）。
4. 只输出改好的提示词本身，不要任何解释。`;
}
// 作者原版提示词作为最可信的风格依据，附加到各种生成任务里
export function authorPromptNote(items) {
  const list = (items || []).map((x) => x && x.result && x.result.author_disclosed).filter((a) => a && a.found && a.prompt).slice(0, 4);
  if (!list.length) return "";
  return `\n【作者公开的原版提示词（最可信的风格依据，风格判断优先以它为准，但不要照搬其中的具体内容）】\n${list.map((a, i) => `${i + 1}. ${a.prompt.slice(0, 1500)}${(a.tools || []).length ? `（工具：${a.tools.join("、")}）` : ""}`).join("\n")}\n`;
}
