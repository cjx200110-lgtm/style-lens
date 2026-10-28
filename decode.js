// 直接解码视频：读出 MP4 里每一帧的位置，交给浏览器自带的解码器（WebCodecs）从头到尾按顺序解一遍。
// 比“一帧一帧跳转”快得多：X 上的视频常常 3 秒才有一个关键帧，每跳一次都要从关键帧重新解码几十上百帧。
// 只支持最常见的 H.264（avc1）普通 MP4；其他格式抛错，由调用方退回跳转截图。

function boxes(dv, start, end) {
  const out = [];
  let p = start;
  while (p + 8 <= end) {
    let size = dv.getUint32(p), hdr = 8;
    const type = String.fromCharCode(dv.getUint8(p + 4), dv.getUint8(p + 5), dv.getUint8(p + 6), dv.getUint8(p + 7));
    if (size === 1) { size = Number(dv.getBigUint64(p + 8)); hdr = 16; }
    else if (size === 0) size = end - p;
    if (size < hdr || p + size > end) break;
    out.push({ type, start: p, body: p + hdr, end: p + size });
    p += size;
  }
  return out;
}
const child = (dv, b, type) => boxes(dv, b.body, b.end).find((x) => x.type === type);
const path = (dv, b, types) => types.reduce((cur, t) => cur && child(dv, cur, t), b);

// 解析出视频轨道：编码参数 + 每一帧（文件位置、大小、显示时间、是否关键帧）
export function parseMp4(buf) {
  const dv = new DataView(buf);
  const moov = boxes(dv, 0, buf.byteLength).find((x) => x.type === "moov");
  if (!moov) throw new Error("不是普通 MP4（没有 moov）");
  for (const trak of boxes(dv, moov.body, moov.end).filter((x) => x.type === "trak")) {
    const mdia = child(dv, trak, "mdia"); if (!mdia) continue;
    const hdlr = child(dv, mdia, "hdlr");
    if (!hdlr || String.fromCharCode(...new Uint8Array(buf, hdlr.body + 8, 4)) !== "vide") continue;
    const mdhd = child(dv, mdia, "mdhd");
    const timescale = dv.getUint8(mdhd.body) === 1 ? dv.getUint32(mdhd.body + 20) : dv.getUint32(mdhd.body + 12);
    const stbl = path(dv, mdia, ["minf", "stbl"]);
    if (!stbl) continue;
    const stsd = child(dv, stbl, "stsd");
    const entry = boxes(dv, stsd.body + 8, stsd.end)[0];
    if (!entry || !/^avc[13]$/.test(entry.type)) throw new Error("不是 H.264 视频：" + (entry && entry.type));
    const width = dv.getUint16(entry.body + 24), height = dv.getUint16(entry.body + 26);
    const avcC = boxes(dv, entry.body + 78, entry.end).find((x) => x.type === "avcC");
    if (!avcC) throw new Error("缺少 avcC");
    const description = new Uint8Array(buf.slice(avcC.body, avcC.end));
    const hex = (n) => n.toString(16).padStart(2, "0");
    const codec = "avc1." + hex(description[1]) + hex(description[2]) + hex(description[3]);
    // 时间表
    const u32 = (b, i) => dv.getUint32(b.body + i);
    const stts = child(dv, stbl, "stts"), ctts = child(dv, stbl, "ctts"), stsc = child(dv, stbl, "stsc");
    const stsz = child(dv, stbl, "stsz"), stco = child(dv, stbl, "stco"), co64 = child(dv, stbl, "co64"), stss = child(dv, stbl, "stss");
    const n = u32(stsz, 8), fixed = u32(stsz, 4);
    const sizes = Array.from({ length: n }, (_, i) => fixed || u32(stsz, 12 + i * 4));
    const dts = []; { let t = 0, k = 0; const c = u32(stts, 4); for (let e = 0; e < c; e++) { const cnt = u32(stts, 8 + e * 8), d = u32(stts, 12 + e * 8); for (let j = 0; j < cnt && k < n; j++, k++) { dts.push(t); t += d; } } }
    const off = new Array(n).fill(0);
    if (ctts) { const v1 = dv.getUint8(ctts.body) === 1; const c = u32(ctts, 4); let k = 0; for (let e = 0; e < c; e++) { const cnt = u32(ctts, 8 + e * 8); const o = v1 ? dv.getInt32(ctts.body + 12 + e * 8) : u32(ctts, 12 + e * 8); for (let j = 0; j < cnt && k < n; j++, k++) off[k] = o; } }
    const chunkOffs = stco ? Array.from({ length: u32(stco, 4) }, (_, i) => u32(stco, 8 + i * 4)) : Array.from({ length: u32(co64, 4) }, (_, i) => Number(dv.getBigUint64(co64.body + 8 + i * 8)));
    const sc = Array.from({ length: u32(stsc, 4) }, (_, e) => ({ first: u32(stsc, 8 + e * 12), per: u32(stsc, 12 + e * 12) }));
    const keys = stss ? new Set(Array.from({ length: u32(stss, 4) }, (_, i) => u32(stss, 8 + i * 4) - 1)) : null;
    const samples = [];
    let s = 0;
    for (let ci = 0; ci < chunkOffs.length && s < n; ci++) {
      let e = sc.length - 1; while (e > 0 && sc[e].first > ci + 1) e--;
      let p = chunkOffs[ci];
      for (let j = 0; j < sc[e].per && s < n; j++, s++) {
        samples.push({ offset: p, size: sizes[s], cts: (dts[s] + off[s]) / timescale, key: keys ? keys.has(s) : true });
        p += sizes[s];
      }
    }
    return { codec, description, width, height, samples };
  }
  throw new Error("没有视频轨道");
}

// 从头到尾解码一遍；每解出一帧调用 onFrame(frame, 秒)，回调里必须同步用完 frame（插件会马上关闭它）
export async function decodeAll(buf, track, onFrame, onProgress) {
  if (typeof VideoDecoder === "undefined") throw new Error("浏览器不支持 WebCodecs");
  const config = { codec: track.codec, description: track.description, codedWidth: track.width, codedHeight: track.height };
  const sup = await VideoDecoder.isConfigSupported(config);
  if (!sup.supported) throw new Error("浏览器解不了这个编码：" + track.codec);
  let err = null;
  const dec = new VideoDecoder({
    output: (frame) => { try { onFrame(frame, frame.timestamp / 1e6); } catch (e) { err = err || e; } finally { frame.close(); } },
    error: (e) => { err = err || e; }
  });
  dec.configure(config);
  const total = track.samples.length;
  for (let i = 0; i < total; i++) {
    if (err) break;
    const s = track.samples[i];
    dec.decode(new EncodedVideoChunk({ type: s.key ? "key" : "delta", timestamp: Math.round(s.cts * 1e6), data: new Uint8Array(buf, s.offset, s.size) }));
    // 控制排队数量，避免一次塞太多占内存
    while (dec.decodeQueueSize > 24 && !err) await new Promise((r) => dec.addEventListener("dequeue", r, { once: true }));
    if (onProgress && i % 60 === 0) onProgress(i / total);
  }
  if (!err) await dec.flush().catch((e) => { err = err || e; });
  try { dec.close(); } catch (_) {}
  if (err) throw err instanceof Error ? err : new Error(String(err && err.message || err));
}
