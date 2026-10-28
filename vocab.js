// 固定标签词表：保证不同视频的标签可以统计、可以比较
export const DIMENSIONS = [
  { key: "medium", label: "媒介质感", values: ["写实实拍感", "3D渲染", "2D扁平", "动漫", "黏土/定格", "胶片复古", "像素", "水彩/手绘", "拼贴", "其他媒介"] },
  { key: "color", label: "色彩", values: ["冷色高饱和", "冷色低饱和", "暖色高饱和", "暖色低饱和", "中性/黑白", "多彩撞色"] },
  { key: "light", label: "光影", values: ["柔光", "硬光强对比", "霓虹/人工光", "自然日光", "暗调低光"] },
  { key: "framing", label: "景别", values: ["特写为主", "中景为主", "远景为主", "景别混合"] },
  { key: "camera", label: "运镜", values: ["固定镜头为主", "推拉镜头", "摇移/跟拍", "手持晃动", "航拍/大幅运镜"] },
  { key: "transition", label: "转场", values: ["硬切", "匹配剪辑", "特效转场", "一镜到底"] },
  { key: "pace", label: "节奏", values: ["快节奏", "中等节奏", "慢节奏"] },
  { key: "subject", label: "主体", values: ["人物", "动物", "物体/产品", "风景/场景", "抽象图形"] },
  { key: "narrative", label: "叙事", values: ["有剧情", "有反转", "纯氛围", "教程/展示"] },
  { key: "dialogue", label: "台词", values: ["有台词/旁白", "无台词"] },
  { key: "music", label: "音乐情绪", values: ["欢快", "治愈舒缓", "紧张悬疑", "史诗大气", "搞怪", "无音乐"] },
  { key: "beat", label: "卡点", values: ["音乐卡点", "不卡点"] },
  { key: "genre", label: "题材", values: ["搞笑", "治愈", "奇观", "科普", "广告", "叙事短片", "MV", "其他题材"] }
];

// 适合拿来让用户勾选“喜欢点”的维度（太基础的如“无台词”不放进候选）
export const LIKEABLE_KEYS = ["medium", "color", "light", "framing", "camera", "transition", "pace", "narrative", "music", "beat"];

export function shuffle(arr) {
  const a = arr.slice();
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

// “不卡点”“无音乐”这类否定值不适合当作“喜欢点”
const NOT_LIKEABLE = new Set(["不卡点", "无音乐", "无台词", "其他媒介", "其他题材"]);

// 由分析结果生成候选标签：固定词表标签 + 1 个 AI 自由写的创意点标签，最多 8 个，顺序打乱
export function buildCandidateTags(result) {
  const tags = [];
  const st = (result && result.style_tags) || {};
  for (const k of LIKEABLE_KEYS) {
    const v = st[k];
    if (typeof v === "string" && v && !NOT_LIKEABLE.has(v) && !tags.includes(v)) tags.push(v);
  }
  const picked = shuffle(tags).slice(0, 7);
  if (result && result.creative_tag) picked.push("创意：" + String(result.creative_tag).slice(0, 12));
  return shuffle(picked);
}
