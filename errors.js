// 只保存可解释的中文原因和步骤，不把网络英文、网址或认证信息带进收藏与通知。
export const STAGE_LABELS = { resolve: "读取帖子", download: "下载视频", upload: "上传视频", analysis: "模型分析", validation: "检查分析结果", save: "保存结果", unknown: "未记录" };
export function formatTaskError(error, { stage = "unknown", provider = "qwen", legacy = false } = {}) {
  const message = String(error?.message || error || "").trim();
  stage = error?.stage || stage;
  const service = provider === "gemini" ? "Gemini" : "百炼";
  // 服务端回显可能带敏感地址或凭据，遇到这些信息使用固定提示。
  const safe = !/https?:\/\/|oss:\/\/|Bearer\s|Authorization|AIza[\w-]+|\bsk-[\w-]{8,}/i.test(message);
  const chinese = /^(?:[\u3400-\u9fff]|Gemini(?=.*[\u3400-\u9fff]))/.test(message);
  if (safe && chinese) return message;
  const network = /failed to fetch|fetch failed|network|load failed|connection|err_/i.test(message);
  const timeout = /timeout|timed out/i.test(message) || ["TimeoutError", "AbortError"].includes(error?.name);
  if (legacy && stage === "unknown" && (network || timeout)) return "网络请求失败；原记录未记录具体步骤，请用当前版本重试。";
  if (stage === "download") return timeout ? "视频下载超时，请确认当前网络能访问 X 视频后重试。" : "视频下载中断，请确认当前网络能访问 X 视频后重试。";
  if (stage === "upload") return "视频上传到" + service + (timeout ? "超时，请稍后重试。" : "失败：连接中断，请检查网络后重试。");
  if (stage === "resolve") return "读取帖子失败，请确认帖子仍可访问后重试。";
  if (stage === "analysis") return service + (timeout ? "分析超时，请稍后重试。" : "分析请求失败，请检查网络和所选服务设置后重试。");
  if (stage === "validation") return "模型返回的分析不完整，本次结果未保存。";
  if (stage === "save") return "分析结果未能保存，请检查浏览器存储空间后重试。";
  return "网络或处理请求失败，请重试；新版会记录具体失败步骤。";
}
