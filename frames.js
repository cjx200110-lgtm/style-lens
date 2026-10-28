import { parseMp4, decodeAll } from "./decode.js";
// 高还原复刻：在浏览器里下载原视频、截取每个镜头的首帧/尾帧，打包成素材包。
// 全部在本机完成，不调用模型，不消耗 API 额度。

// 插件页面对 video.twimg.com 有访问权限，下载成本地 Blob 后截图不会被浏览器的跨域保护拦住。
export async function downloadVideo(url) {
  if (!/^https:\/\/video\.twimg\.com\/[^"'\s]+$/.test(url || "")) throw new Error("视频地址无效");
  const res = await fetch(url, { credentials: "omit" });
  if (!res.ok) throw new Error("视频下载失败（HTTP " + res.status + "）");
  const blob = await res.blob();
  if (blob.size < 1000) throw new Error("下载到的视频是空的");
  return new Blob([blob], { type: "video/mp4" });
}

function once(el, ev, ms = 15000) {
  return new Promise((resolve, reject) => {
    const t = setTimeout(() => { cleanup(); reject(new Error("视频读取超时")); }, ms);
    const ok = () => { cleanup(); resolve(); };
    const bad = () => { cleanup(); reject(new Error("浏览器无法解码这个视频")); };
    const cleanup = () => { clearTimeout(t); el.removeEventListener(ev, ok); el.removeEventListener("error", bad); };
    el.addEventListener(ev, ok); el.addEventListener("error", bad);
  });
}

// ---------- 切点校准 + 关键帧 ----------
// 先把整条视频每 0.1 秒取一张小图（64×36，白底小字的变化也看得出），后面所有判断都用这份取样：
// 1) 切点：模型给的切点常差 0.1~1.5 秒。对每个切点，取前一段、后一段各一张代表画面，
//    看前后 1.5 秒内每一帧“更像前一段还是更像后一段”，找出画面换过去的那一刻；淡入淡出时取新画面已经清楚的位置；
//    附近有硬切（一帧突变）就精确对到那一帧。
// 2) 关键帧：每段首帧、尾帧，段内画面一有明显变化就截，最长每 0.5 秒一张；只有最后要保存的那几张才去截高清图。
const SNAP_RANGE = 1.5, SW = 64, SH = 36;
async function seekTo(v, t, dur) {
  const tt = Math.min(Math.max(0, t), Math.max(0, dur - 0.05));
  if (Math.abs(v.currentTime - tt) > 0.001) { const p = once(v, "seeked"); v.currentTime = tt; await p; }
}
async function grabSmall(v, sctx, t, dur) {
  await seekTo(v, t, dur);
  sctx.drawImage(v, 0, 0, SW, SH);
  return sctx.getImageData(0, 0, SW, SH).data;
}
function pxDiff(a, b) {
  let d = 0; for (let k = 0; k < a.length; k += 4) d += Math.abs(a[k] - b[k]) + Math.abs(a[k + 1] - b[k + 1]) + Math.abs(a[k + 2] - b[k + 2]);
  return d / ((a.length / 4) * 3);
}
const median = (arr) => { if (!arr.length) return 0; const s = [...arr].sort((a, b) => a - b); return s[Math.floor(s.length / 2)]; };
function idxAt(ts, t) {
  let lo = 0, hi = ts.length - 1;
  while (lo < hi) { const m = (lo + hi) >> 1; if (ts[m] < t) lo = m + 1; else hi = m; }
  if (lo > 0 && Math.abs(ts[lo - 1] - t) <= Math.abs(ts[lo] - t)) lo--;
  return lo;
}
// 取样：页面在前台时让视频静音高速播放、边播边截（快）；在后台或播放卡住时，从卡住的地方接着逐个跳转截（慢但稳，后台也能做）
async function sampleFrames(v, sctx, dur, step, onProgress) {
  const ts = [], px = [];
  const report = (t) => onProgress && onProgress(Math.min(1, t / dur));
  const grab = (t) => { sctx.drawImage(v, 0, 0, SW, SH); ts.push(Math.round(t * 1000) / 1000); px.push(sctx.getImageData(0, 0, SW, SH).data); };
  if (typeof v.requestVideoFrameCallback === "function" && document.visibilityState === "visible") {
    const host = document.createElement("div");
    host.style.cssText = "position:fixed;left:0;top:0;width:2px;height:2px;opacity:0.01;pointer-events:none;overflow:hidden";
    host.append(v); document.body.append(host);
    try {
      await seekTo(v, 0, dur).catch(() => {});
      v.playbackRate = 8;
      await new Promise((resolve, reject) => {
        let last = -1, lastWall = Date.now(), stop = false;
        const quit = (e) => { if (stop) return; stop = true; clearInterval(watchdog); document.removeEventListener("visibilitychange", onVis); e ? reject(e) : resolve(); };
        const onVis = () => { if (document.visibilityState !== "visible") quit(new Error("hidden")); };
        const watchdog = setInterval(() => { if (Date.now() - lastWall > 3000) quit(new Error("stall")); }, 500);
        const onFrame = (_, meta) => {
          if (stop) return;
          lastWall = Date.now();
          const t = meta.mediaTime;
          if (t - last >= step * 0.95) { grab(t); last = t; if (ts.length % 20 === 0) report(t); }
          if (!v.ended) v.requestVideoFrameCallback(onFrame);
        };
        document.addEventListener("visibilitychange", onVis);
        v.addEventListener("ended", () => quit(), { once: true });
        v.requestVideoFrameCallback(onFrame);
        v.play().catch((e) => quit(e));
      });
    } catch (e) { console.info("取样：边播边截中断，接着逐个跳转", e && e.message); }
    try { v.pause(); v.playbackRate = 1; } catch (_) {}
    host.remove();
    // 播放时偶尔跳帧：间隔太大的地方后面补上
  }
  // 逐个跳转：从已经取到的地方接着往后取；播放取样里间隔超过 2.5 倍步长的空档也补上
  const want = []; for (let t = 0; t < dur - 0.04; t += step) want.push(Math.round(t * 1000) / 1000);
  const have = ts.slice();
  const missing = want.filter((t) => { if (!have.length) return true; const k = idxAt(have, t); return Math.abs(have[k] - t) > step * 1.25; });
  let n = 0;
  for (const t of missing) {
    try { const p = await grabSmall(v, sctx, t, dur); ts.push(t); px.push(p); }
    catch (e) { console.warn("跳过一帧", t, e && e.message); } // 某一帧卡住就跳过，不让整次失败
    if (++n % 20 === 0) report(have.length ? (have.length + n) / want.length * dur : t);
  }
  const order = ts.map((t, k) => k).sort((a, b) => ts[a] - ts[b]);
  return { ts: order.map((k) => ts[k]), px: order.map((k) => px[k]) };
}
// 硬切：相邻两张取样差别很大、并且明显大于附近的一般变化；再在两张之间逐帧找到切换的那一帧
async function detectHard(v, sctx, ts, px, dur) {
  const d = ts.map((_, k) => (k ? pxDiff(px[k - 1], px[k]) : 0));
  const W = 10, cuts = [];
  for (let k = 1; k < ts.length; k++) {
    if (ts[k] - ts[k - 1] > 0.5) continue;
    const med = median(d.slice(Math.max(1, k - W), k).concat(d.slice(k + 1, k + 1 + W)));
    const isPeak = d[k] >= Math.max(...d.slice(Math.max(1, k - 2), k + 3));
    // 硬切：比附近一般的帧间变化大很多（手绘、同色调画面的硬切差值也可能只有 20 多，所以看相对大小）
    if (!(d[k] >= 10 && d[k] >= med * 4 + 5 && isPeak)) continue;
    let t = ts[k];
    if (v && ts[k] - ts[k - 1] > 0.05) try {
      const sub = [ts[k - 1]]; for (let x = ts[k - 1] + 0.033; x < ts[k] - 0.01; x += 0.033) sub.push(x); sub.push(ts[k]);
      const sp = [px[k - 1]]; for (let j = 1; j < sub.length - 1; j++) sp.push(await grabSmall(v, sctx, sub[j], dur)); sp.push(px[k]);
      let best = 1, bd = -1; for (let j = 1; j < sp.length; j++) { const x = pxDiff(sp[j - 1], sp[j]); if (x > bd) { bd = x; best = j; } }
      t = sub[best];
    } catch (_) {}
    cuts.push(Math.round(t * 100) / 100);
  }
  return cuts;
}
// 只比较前后两段画面真正不同的区域（例如白底上的文字），否则大片相同的背景会把差别平均掉
function maskOf(A, B) {
  const m = []; for (let k = 0; k < A.length; k += 4) if (Math.abs(A[k] - B[k]) + Math.abs(A[k + 1] - B[k + 1]) + Math.abs(A[k + 2] - B[k + 2]) > 45) m.push(k);
  return m;
}
function mDiff(X, Y, m) {
  let d = 0; for (const k of m) d += Math.abs(X[k] - Y[k]) + Math.abs(X[k + 1] - Y[k + 1]) + Math.abs(X[k + 2] - Y[k + 2]);
  return d / (m.length * 3);
}
// 校准每个切点：
// 1) 前后 1.5 秒内有硬切（一帧突变）：直接用最近的那一个，精确到帧；
// 2) 没有硬切（擦掉再画、淡入淡出、滑入等）：分别找出“前一段特有的内容”和“后一段特有的内容”所在的区域，
//    取“前一段的内容基本消失”或“后一段的内容基本出现”中更早的那一刻。例如“擦掉标题→开始画棋盘”，切点在标题擦完时。
//    判断不清（两段差别太小）就保持模型原来的时间。
const SOFT_RANGE = 0.8;
export function findHardSync(ts, px) { return detectHard(null, null, ts, px, 0); } // 测试用
export function snapShots(ts, px, shots, hard = []) {
  const out = shots.map((s) => ({ ...s }));
  const used = new Set();
  let moved = 0;
  for (let i = 0; i + 1 < out.length; i++) {
    delete out[i].tail;
    const t = out[i].end, a0 = out[i].start, b1 = out[i + 1].end;
    let cut = null;
    // 1) 硬切
    const near = hard.filter((h) => !used.has(h) && h > a0 + 0.1 && h < b1 - 0.1 && Math.abs(h - t) <= SNAP_RANGE).sort((x, y) => Math.abs(x - t) - Math.abs(y - t))[0];
    if (near != null) { cut = near; used.add(near); }
    else {
      // 2) 软过渡
      const lo = idxAt(ts, Math.max(a0 + 0.1, t - SOFT_RANGE)), hi = idxAt(ts, Math.min(b1 - 0.1, t + SOFT_RANGE));
      const A = px[lo], B = px[hi];
      if (hi - lo >= 3) {
        const m = maskOf(A, B);
        if (m.length >= 6) {
          // 每个像素在窗口里的“常态”（中位数），用来区分哪些是前一段特有的、哪些是后一段特有的
          const SA = [], SB = [];
          for (const k of m) {
            const med = [0, 1, 2].map((c) => { const v = []; for (let j = lo; j <= hi; j++) v.push(px[j][k + c]); v.sort((x, y) => x - y); return v[v.length >> 1]; });
            const devA = Math.abs(A[k] - med[0]) + Math.abs(A[k + 1] - med[1]) + Math.abs(A[k + 2] - med[2]);
            const devB = Math.abs(B[k] - med[0]) + Math.abs(B[k + 1] - med[1]) + Math.abs(B[k + 2] - med[2]);
            (devA >= devB ? SA : SB).push(k);
          }
          const closerTo = (X, Y, Z, k) => Math.abs(X[k] - Y[k]) + Math.abs(X[k + 1] - Y[k + 1]) + Math.abs(X[k + 2] - Y[k + 2]) < Math.abs(X[k] - Z[k]) + Math.abs(X[k + 1] - Z[k + 1]) + Math.abs(X[k + 2] - Z[k + 2]);
          const presA = (X) => (SA.length ? SA.filter((k) => closerTo(X, A, B, k)).length / SA.length : 1);
          const presB = (X) => (SB.length ? SB.filter((k) => closerTo(X, B, A, k)).length / SB.length : 0);
          // “换过去了”：前一段特有的内容基本消失或后一段特有的内容基本出现，并且整体上已经更像后一段（排除画面里角色走动之类的局部变化）
          const flipped = (k) => (SA.length >= 4 && presA(px[k]) < 0.5) || (SB.length >= 4 && presB(px[k]) > 0.5);
          // 找一个分界：分界前尽量都“没换”，分界后尽量都“换了”（比连续几帧判断更不怕偶然的干扰）
          const lab = []; for (let k = lo; k <= hi; k++) lab.push(flipped(k) ? 1 : 0);
          const ones = lab.reduce((x, y) => x + y, 0);
          if (ones >= 3) {
            let z = 0, o = 0, best = -1, bestScore = -1;
            for (let s2 = 1; s2 < lab.length; s2++) {
              if (lab[s2 - 1]) o++; else z++;
              const score = z + (ones - o);
              if (score > bestScore) { bestScore = score; best = s2; }
            }
            // 分得清才动：前后至少 85% 的帧和分界一致，否则说明只是画面里有东西在动，保持模型原来的时间
            // 软过渡最多挪 0.5 秒：挪得更远的，多半是画面在逐步画出/变化，而不是换了镜头
            if (best > 0 && bestScore >= lab.length * 0.85 && Math.abs(ts[lo + best] - t) <= 0.5) cut = ts[lo + best];
          }
        }
      }
    }
    if (cut != null && Math.abs(cut - t) >= 0.05) { const r = Math.round(cut * 100) / 100; out[i].end = r; out[i + 1].start = r; moved++; }
  }
  // 开头：前 0.6 秒里有硬切、而且不是已有的切点，说明开头有一个一闪而过、被漏掉的画面，单独补成一段
  // 补开头要更谨慎：切点前后的画面必须整体完全不同（角色动作大不算）
  const pAt = (t) => px[idxAt(ts, t)];
  // 用整体配色比较：同一场景换个机位/推拉，配色基本不变；换成另一个画面，配色明显不同
  const hist = (p) => { const hb = new Float32Array(64); for (let k = 0; k < p.length; k += 4) hb[(p[k] >> 6) * 16 + (p[k + 1] >> 6) * 4 + (p[k + 2] >> 6)]++; const n = p.length / 4; return hb.map((x) => x / n); };
  const hDiff = (a, b) => { const x = hist(a), y = hist(b); let d = 0; for (let i = 0; i < 64; i++) d += Math.abs(x[i] - y[i]); return d / 2; };
  const oc = hard.find((h) => h >= 0.08 && h <= 0.6 && !out.some((s) => Math.abs(s.start - h) < 0.05) && hDiff(pAt(Math.max(0, h - 0.07)), pAt(h + 0.3)) > 0.35);
  if (out.length && oc != null && out[0].start < 0.05 && out[0].end - oc > 0.3) {
    out.unshift({ start: 0, end: oc, visual: "开场一闪而过的画面（插件按画面切换自动补出的一段，具体看截图）", action: "静止", camera: "未说明", light: "", audio: "未说明", auto: true });
    out[1].start = oc; moved++;
  }
  return { shots: out, moved };
}

// 选关键帧：每段首帧、尾帧 + 段内明显变化（和上一张保存的比）+ 最长每 maxGap 秒一张
function selectPicks(shots, ts, px, maxGap, perShot) {
  const picks = shots.map(() => []);
  shots.forEach((s, i) => {
    const [a, b0] = shotTimes(s);
    const b = s.tail > a ? s.tail : b0;
    const list = picks[i];
    list.push({ t: Math.round(a * 1000) / 1000, kind: "首帧" });
    let lastPx = px[idxAt(ts, a)], lastT = a;
    for (let k = idxAt(ts, a + 0.1); k < ts.length && ts[k] < b - 0.1; k++) {
      if (ts[k] <= a + 0.05) continue;
      const diff = pxDiff(px[k], lastPx);
      const changed = diff > 14, gap = ts[k] - lastT >= maxGap;
      if ((changed || gap) && list.length < perShot - 1) { list.push({ t: ts[k], kind: changed ? (diff > 40 ? "切换" : "变化") : "间隔" }); lastPx = px[k]; lastT = ts[k]; }
    }
    if (b - a > 0.05) list.push({ t: Math.round(b * 1000) / 1000, kind: "尾帧" });
  });
  return picks;
}
function finishOut(out) {
  for (const o of out) {
    o.frames.sort((a, b) => a.t - b.t);
    for (const f of o.frames) f.t = Math.round(f.t * 100) / 100;
    const first = o.frames.find((f) => f.kind === "首帧") || o.frames[0];
    const last = [...o.frames].reverse().find((f) => f.kind === "尾帧") || o.frames.at(-1);
    Object.assign(o, { first: first?.blob, last: last?.blob, firstUrl: first?.url, lastUrl: last?.url, mid: o.frames[Math.floor(o.frames.length / 2)] });
  }
  return out;
}

// snap=true 时先校准切点，返回值里的 snapped 是校准后的镜头（时间改过、可能在开头多一段）
// onProgress(比例 0~1, 阶段)：阶段 "scan" 扫描整条视频，"capture" 截关键帧
// 先用“直接解码”（快）；视频格式不支持、浏览器不支持时退回“逐个跳转截图”（慢但都能用）
export async function scanKeyframes(videoBlob, shots, opts = {}) {
  try { return await scanDecode(videoBlob, shots, opts); }
  catch (e) { console.info("直接解码不可用，改用逐个跳转截图：", e && e.message); }
  return scanSeek(videoBlob, shots, opts);
}
async function scanDecode(videoBlob, shots, { maxGap = 0.5, perShot = 12, onProgress, snap = false } = {}) {
  const t0 = Date.now();
  const buf = await videoBlob.arrayBuffer();
  const track = parseMp4(buf);
  const W = track.width, H = track.height;
  const small = document.createElement("canvas"); small.width = SW; small.height = SH;
  const sctx = small.getContext("2d", { willReadFrequently: true });
  // 第一遍：每 1/30 秒取一张小图
  const ts = [], px = [];
  const step = 1 / 30;
  let last = -1;
  await decodeAll(buf, track, (frame, t) => {
    if (t - last < step * 0.9) return;
    sctx.drawImage(frame, 0, 0, SW, SH);
    ts.push(Math.round(t * 1000) / 1000); px.push(sctx.getImageData(0, 0, SW, SH).data); last = t;
  }, (r) => onProgress && onProgress(r * 0.6, "scan"));
  if (ts.length < 3) throw new Error("解码出的画面太少");
  const order = ts.map((_, k) => k).sort((a, b) => ts[a] - ts[b]);
  const T = order.map((k) => ts[k]), P = order.map((k) => px[k]);
  const dur = T[T.length - 1] + step;
  const tScan = Date.now();
  let snapped = null, moved = 0;
  if (snap && shots.length > 0) {
    const hard = await detectHard(null, sctx, T, P, dur);
    ({ shots: snapped, moved } = snapShots(T, P, shots, hard));
    shots = snapped;
  }
  const picks = selectPicks(shots, T, P, maxGap, perShot);
  // 第二遍：只把要保存的那几帧画下来（长边不超过 1280，和存档尺寸一致）
  const all = picks.flatMap((l, i) => l.map((p) => ({ ...p, i }))).sort((x, y) => x.t - y.t);
  const k = Math.min(1, 1280 / Math.max(W, H)), cw = Math.round(W * k), ch = Math.round(H * k);
  const out = shots.map(() => ({ frames: [] }));
  const jobs = [];
  let pi = 0;
  await decodeAll(buf, track, (frame, t) => {
    let c = null;
    while (pi < all.length && t >= all[pi].t - 0.009) {
      const p = all[pi++];
      if (!c) { c = document.createElement("canvas"); c.width = cw; c.height = ch; c.getContext("2d").drawImage(frame, 0, 0, cw, ch); }
      const cv = c;
      jobs.push(new Promise((r) => cv.toBlob(r, "image/jpeg", 0.9)).then((blob) => { if (blob) out[p.i].frames.push({ t: p.t, kind: p.kind, blob, url: URL.createObjectURL(blob) }); }));
    }
  }, (r) => onProgress && onProgress(0.6 + r * 0.4, "capture"));
  await Promise.all(jobs);
  console.info(`关键帧（直接解码）：视频 ${Math.round(dur)} 秒，扫描 ${((tScan - t0) / 1000).toFixed(1)} 秒（${T.length} 张），截图 ${((Date.now() - tScan) / 1000).toFixed(1)} 秒（${all.length} 张）`);
  return { shots: finishOut(out), width: cw, height: ch, snapped, moved, timing: { scan: tScan - t0, total: Date.now() - t0, samples: T.length, mode: "decode" } };
}
async function scanSeek(videoBlob, shots, { maxGap = 0.5, perShot = 12, onProgress, snap = false } = {}) {
  const url = URL.createObjectURL(videoBlob);
  const v = document.createElement("video");
  v.muted = true; v.preload = "auto"; v.playsInline = true; v.src = url;
  try {
    await once(v, "loadeddata", 30000);
    const dur = v.duration || 0;
    const W = v.videoWidth, H = v.videoHeight;
    const full = document.createElement("canvas"); full.width = W; full.height = H;
    const fctx = full.getContext("2d");
    const small = document.createElement("canvas"); small.width = SW; small.height = SH;
    const sctx = small.getContext("2d", { willReadFrequently: true });
    const t0 = Date.now();
    const { ts, px } = await sampleFrames(v, sctx, dur, Math.max(0.1, dur / 1500), (r) => onProgress && onProgress(r * 0.7, "scan"));
    const tScan = Date.now();
    let snapped = null, moved = 0;
    if (snap && shots.length > 0) {
      const hard = await detectHard(v, sctx, ts, px, dur);
      ({ shots: snapped, moved } = snapShots(ts, px, shots, hard));
      shots = snapped;
    }
    const picks = selectPicks(shots, ts, px, maxGap, perShot);
    // 截高清图
    const out = shots.map(() => ({ frames: [] }));
    const all = picks.flatMap((l, i) => l.map((p) => ({ ...p, i }))).sort((x, y) => x.t - y.t);
    for (let n = 0; n < all.length; n++) {
      const p = all[n];
      try {
        await seekTo(v, p.t, dur);
        fctx.drawImage(v, 0, 0, W, H);
        const blob = await new Promise((r) => full.toBlob(r, "image/jpeg", 0.9));
        out[p.i].frames.push({ t: p.t, kind: p.kind, blob, url: URL.createObjectURL(blob) });
      } catch (e) { console.warn("跳过一张关键帧", p.t, e && e.message); }
      onProgress && onProgress(0.7 + 0.3 * (n + 1) / all.length, "capture");
    }
    finishOut(out);
    console.info(`关键帧：视频 ${Math.round(dur)} 秒，扫描 ${((tScan - t0) / 1000).toFixed(1)} 秒（${ts.length} 张），截图 ${((Date.now() - tScan) / 1000).toFixed(1)} 秒（${all.length} 张）`);
    return { shots: out, width: W, height: H, snapped, moved, timing: { scan: tScan - t0, total: Date.now() - t0, samples: ts.length } };
  } finally { v.removeAttribute("src"); v.load(); URL.revokeObjectURL(url); }
}

// 关键帧存档的版本 + 镜头时间。镜头时间变了（重新拆解、切点校准）或校准方法升级了，旧截图就作废重截
export const framesSig = (shots) => "s4:" + JSON.stringify((shots || []).map((s) => [s.start, s.end]));
// 存档用的缩小版（长边 1280）
export async function shrink(blob) {
  try {
    const bmp = await createImageBitmap(blob);
    const k = Math.min(1, 1280 / Math.max(bmp.width, bmp.height));
    if (k >= 1) return blob;
    const c = document.createElement("canvas"); c.width = Math.round(bmp.width * k); c.height = Math.round(bmp.height * k);
    c.getContext("2d").drawImage(bmp, 0, 0, c.width, c.height);
    return await new Promise((r) => c.toBlob(r, "image/jpeg", 0.85));
  } catch (_) { return blob; }
}

// 每个镜头的首尾时间点：开头稍后 0.05 秒（避开转场黑帧），结尾前 0.08 秒
export function shotTimes(shot) {
  const s = Number(shot.start) || 0, e = Number(shot.end) || s + 0.5;
  const len = Math.max(0.1, e - s);
  return [s + Math.min(0.05, len / 4), Math.max(s, e - Math.min(0.08, len / 4))];
}

// ---------- 极简 ZIP（不压缩，图片和视频本来就压缩过） ----------
const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; t[n] = c >>> 0; }
  return t;
})();
function crc32(bytes) {
  let c = 0xffffffff;
  for (let i = 0; i < bytes.length; i++) c = CRC_TABLE[(c ^ bytes[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

// files: [{ name, data: Blob|string }]
export async function makeZip(files) {
  const enc = new TextEncoder();
  const parts = [], central = [];
  let offset = 0;
  const now = new Date();
  const dosTime = (now.getHours() << 11) | (now.getMinutes() << 5) | (now.getSeconds() >> 1);
  const dosDate = ((now.getFullYear() - 1980) << 9) | ((now.getMonth() + 1) << 5) | now.getDate();
  for (const f of files) {
    const data = typeof f.data === "string" ? enc.encode(f.data) : new Uint8Array(await f.data.arrayBuffer());
    const name = enc.encode(f.name);
    const crc = crc32(data);
    const local = new DataView(new ArrayBuffer(30));
    local.setUint32(0, 0x04034b50, true); local.setUint16(4, 20, true); local.setUint16(6, 0x0800, true); // UTF-8 文件名
    local.setUint16(8, 0, true); local.setUint16(10, dosTime, true); local.setUint16(12, dosDate, true);
    local.setUint32(14, crc, true); local.setUint32(18, data.length, true); local.setUint32(22, data.length, true);
    local.setUint16(26, name.length, true); local.setUint16(28, 0, true);
    parts.push(local, name, data);
    const cd = new DataView(new ArrayBuffer(46));
    cd.setUint32(0, 0x02014b50, true); cd.setUint16(4, 20, true); cd.setUint16(6, 20, true); cd.setUint16(8, 0x0800, true);
    cd.setUint16(10, 0, true); cd.setUint16(12, dosTime, true); cd.setUint16(14, dosDate, true);
    cd.setUint32(16, crc, true); cd.setUint32(20, data.length, true); cd.setUint32(24, data.length, true);
    cd.setUint16(28, name.length, true); cd.setUint32(42, offset, true);
    central.push(cd, name);
    offset += 30 + name.length + data.length;
  }
  const cdSize = central.reduce((n, p) => n + (p.byteLength ?? p.length), 0);
  const end = new DataView(new ArrayBuffer(22));
  end.setUint32(0, 0x06054b50, true); end.setUint16(8, files.length, true); end.setUint16(10, files.length, true);
  end.setUint32(12, cdSize, true); end.setUint32(16, offset, true);
  return new Blob([...parts, ...central, end], { type: "application/zip" });
}

export function saveBlob(blob, name) {
  const a = document.createElement("a");
  a.href = URL.createObjectURL(blob); a.download = name;
  document.body.append(a); a.click(); a.remove();
  setTimeout(() => URL.revokeObjectURL(a.href), 30000);
}
