/* ══════ 숏폼 영상 → 정식 mp4 (2026-11-19) ══════
   처음엔 화면을 재생하며 MediaRecorder로 찍었는데, 크롬이 만드는 mp4는 '조각(moof)' 모양이라
   ① 재생기에서 초 이동이 안 되고 ② 인스타그램에 올리면 첫 조각(약 3초)만 재생됐다(2026-11-19 사용자).
   그래서 장면을 한 장씩 그려(rlDraw) 브라우저 인코더(WebCodecs — H.264·AAC)로 압축하고, 여기서 직접
   '보통 mp4'(목차 moov가 맨 앞, 조각 없음 — faststart)로 묶는다. 바깥 라이브러리는 쓰지 않는다.
   재생하며 찍지 않으므로 영상 길이보다 빨리 끝나고, 화면이 다른 탭에 가도 멈추지 않는다.
   말 빠르기는 높낮이를 그대로 두고 길이만 바꾼다(rlStretch — WSOLA). reels.js 뒤에 로드한다. */

const RLM_FPS = 30;
const RLM_SR = 48000;              // AAC 표본률(크롬 인코더가 24kHz AAC는 안 받았다)
const RLM_VTS = 90000;             // 영상 시간 단위
const RLM_VBITRATE = 8_000_000;

// 이 브라우저가 정식 mp4를 만들 수 있나
async function rlmSupported() {
  try {
    if (!window.VideoEncoder || !window.AudioEncoder) return false;
    const v = await VideoEncoder.isConfigSupported({ codec: "avc1.640028", width: RL_W, height: RL_H, bitrate: RLM_VBITRATE, framerate: RLM_FPS, avc: { format: "avc" } });
    const a = await AudioEncoder.isConfigSupported({ codec: "mp4a.40.2", sampleRate: RLM_SR, numberOfChannels: 1, bitrate: 128000 });
    return !!(v.supported && a.supported);
  } catch (_e) { return false; }
}

/* ── 소리: wav 읽기 → 빠르기 바꾸기(높낮이 그대로) → 한 줄로 섞기 ── */
function rlmReadWav(buf) {
  const d = new DataView(buf);
  let off = 12, sr = 24000, data = null;
  while (off + 8 <= d.byteLength) {
    const id = String.fromCharCode(d.getUint8(off), d.getUint8(off + 1), d.getUint8(off + 2), d.getUint8(off + 3));
    const size = d.getUint32(off + 4, true);
    if (id === "fmt ") sr = d.getUint32(off + 12, true);
    if (id === "data") { data = [off + 8, Math.min(size, d.byteLength - off - 8)]; break; }
    off += 8 + size + (size & 1);
  }
  if (!data) return { x: new Float32Array(0), sr };
  const n = data[1] >> 1;
  const x = new Float32Array(n);
  for (let i = 0; i < n; i++) x[i] = d.getInt16(data[0] + i * 2, true) / 32768;
  return { x, sr };
}
// WSOLA — 겹쳐 잇는 자리를 비슷한 모양에서 찾아 끊김 없이 길이만 바꾼다(speed>1이면 짧아진다)
function rlStretch(x, sr, speed) {
  if (Math.abs(speed - 1) < 0.005 || x.length < sr * 0.1) return x;
  const N = Math.round(sr * 0.04) & ~1, Ho = N / 2, Hi = Ho * speed, tol = Math.round(sr * 0.012);
  const outLen = Math.floor(x.length / speed);
  const out = new Float32Array(outLen + N);
  const w = new Float32Array(N);
  for (let i = 0; i < N; i++) w[i] = 0.5 - 0.5 * Math.cos((2 * Math.PI * i) / N);
  let last = 0;
  for (let k = 0; ; k++) {
    const op = k * Ho, nom = Math.round(k * Hi);
    if (op >= outLen || nom + N + tol >= x.length) break;
    let pos = nom;
    if (k) {
      const nat = last + Ho;   // 앞 조각이 자연스럽게 이어질 자리 — 그것과 가장 닮은 곳을 고른다
      let best = -Infinity;
      for (let dlt = -tol; dlt <= tol; dlt += 2) {
        const p = nom + dlt;
        if (p < 0) continue;
        let c = 0;
        for (let i = 0; i < Ho; i += 3) c += x[p + i] * x[nat + i];
        if (c > best) { best = c; pos = p; }
      }
    }
    for (let i = 0; i < N; i++) out[op + i] += x[pos + i] * w[i];
    last = pos;
  }
  return out.subarray(0, outLen);
}
async function rlmMixAudio(e, tl) {
  const total = Math.ceil(tl.total * RLM_SR);
  const mix = new Float32Array(total);
  const speed = rlSpeedOf(e);
  for (const g of tl.segs) {
    const a = e.audio[g.k];
    const blob = a.blob || await fetch(a.url).then((r) => r.blob());
    const { x, sr } = rlmReadWav(await blob.arrayBuffer());
    const y = rlStretch(x, sr, speed);
    const ratio = sr / RLM_SR, at = Math.round(g.start * RLM_SR);
    const n = Math.floor(y.length / ratio);
    for (let i = 0; i < n && at + i < total; i++) {      // 표본률 맞추기(선형)
      const p = i * ratio, j = p | 0, f = p - j;
      mix[at + i] += y[j] * (1 - f) + (j + 1 < y.length ? y[j + 1] : 0) * f;
    }
  }
  for (let i = 0; i < total; i++) mix[i] = Math.max(-1, Math.min(1, mix[i]));
  return mix;
}

/* ── mp4 묶기(ISO BMFF — 조각 없는 보통 모양, moov를 앞에) ── */
const rlmTxt = (s) => [...s].map((c) => c.charCodeAt(0));
function rlmU32(n) { return [(n >>> 24) & 255, (n >>> 16) & 255, (n >>> 8) & 255, n & 255]; }
function rlmU16(n) { return [(n >> 8) & 255, n & 255]; }
function rlmBox(type, ...parts) {
  const body = [];
  let len = 8;
  parts.forEach((p) => { body.push(p); len += p.length; });
  const out = new Uint8Array(len);
  out.set([...rlmU32(len), ...rlmTxt(type)], 0);
  let o = 8;
  body.forEach((p) => { out.set(p, o); o += p.length; });
  return out;
}
const rlmFull = (type, ver, flags, ...parts) => rlmBox(type, Uint8Array.from([ver, (flags >> 16) & 255, (flags >> 8) & 255, flags & 255]), ...parts);
const rlmB = (arr) => Uint8Array.from(arr);
const RLM_MATRIX = rlmB([0, 1, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 1, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0x40, 0, 0, 0]);
function rlmSttsEntries(deltas) {
  const runs = [];
  deltas.forEach((d) => { const r = runs[runs.length - 1]; if (r && r[1] === d) r[0]++; else runs.push([1, d]); });
  return runs;
}
function rlmTrak(t, offsets, movieDur) {
  const isV = t.kind === "v";
  const n = t.samples.length;
  const mediaDur = t.samples.reduce((s, x) => s + x.dur, 0);
  const tkhd = rlmFull("tkhd", 0, 3, rlmB([...rlmU32(0), ...rlmU32(0), ...rlmU32(t.id), ...rlmU32(0), ...rlmU32(movieDur),
    ...rlmU32(0), ...rlmU32(0), ...rlmU16(0), ...rlmU16(0), ...rlmU16(isV ? 0 : 0x0100), ...rlmU16(0)]), RLM_MATRIX,
  rlmB([...rlmU32(isV ? RL_W << 16 : 0), ...rlmU32(isV ? RL_H << 16 : 0)]));
  const mdhd = rlmFull("mdhd", 0, 0, rlmB([...rlmU32(0), ...rlmU32(0), ...rlmU32(t.ts), ...rlmU32(mediaDur), 0x55, 0xc4, 0, 0]));
  const hdlr = rlmFull("hdlr", 0, 0, rlmB([...rlmU32(0), ...rlmTxt(isV ? "vide" : "soun"), ...rlmU32(0), ...rlmU32(0), ...rlmU32(0),
    ...rlmTxt(isV ? "VideoHandler" : "SoundHandler"), 0]));
  const xmhd = isV ? rlmFull("vmhd", 0, 1, rlmB([0, 0, 0, 0, 0, 0, 0, 0])) : rlmFull("smhd", 0, 0, rlmB([0, 0, 0, 0]));
  const dinf = rlmBox("dinf", rlmFull("dref", 0, 0, rlmB(rlmU32(1)), rlmFull("url ", 0, 1)));
  let entry;
  if (isV) {
    entry = rlmBox("avc1", rlmB([0, 0, 0, 0, 0, 0, ...rlmU16(1), ...new Array(16).fill(0), ...rlmU16(RL_W), ...rlmU16(RL_H),
      ...rlmU32(0x00480000), ...rlmU32(0x00480000), ...rlmU32(0), ...rlmU16(1), ...new Array(32).fill(0), ...rlmU16(0x18), 0xff, 0xff]),
    rlmBox("avcC", t.desc));
  } else {
    const asc = t.desc;
    const dsi = [5, asc.length, ...asc];
    const dcd = [4, 13 + dsi.length, 0x40, 0x15, 0, 0, 0, ...rlmU32(128000), ...rlmU32(128000), ...dsi];
    const es = [3, 3 + dcd.length + 3, 0, 1, 0, ...dcd, 6, 1, 2];
    entry = rlmBox("mp4a", rlmB([0, 0, 0, 0, 0, 0, ...rlmU16(1), 0, 0, 0, 0, 0, 0, 0, 0, ...rlmU16(1), ...rlmU16(16), 0, 0, 0, 0,
      ...rlmU32(RLM_SR << 16)]), rlmFull("esds", 0, 0, rlmB(es)));
  }
  const stsd = rlmFull("stsd", 0, 0, rlmB(rlmU32(1)), entry);
  const runs = rlmSttsEntries(t.samples.map((x) => x.dur));
  const stts = rlmFull("stts", 0, 0, rlmB([...rlmU32(runs.length), ...runs.flatMap(([c, d]) => [...rlmU32(c), ...rlmU32(d)])]));
  const stsc = rlmFull("stsc", 0, 0, rlmB([...rlmU32(1), ...rlmU32(1), ...rlmU32(1), ...rlmU32(1)]));
  const stsz = rlmFull("stsz", 0, 0, rlmB([...rlmU32(0), ...rlmU32(n)]), rlmB(t.samples.flatMap((x) => rlmU32(x.data.length))));
  const stco = rlmFull("stco", 0, 0, rlmB(rlmU32(n)), rlmB(offsets.flatMap((o) => rlmU32(o))));
  const parts = [stsd, stts];
  if (isV) {
    const keys = t.samples.map((x, i) => (x.key ? i + 1 : 0)).filter(Boolean);
    parts.push(rlmFull("stss", 0, 0, rlmB([...rlmU32(keys.length), ...keys.flatMap((k) => rlmU32(k))])));
  }
  parts.push(stsc, stsz, stco);
  const stbl = rlmBox("stbl", ...parts);
  return rlmBox("trak", tkhd, rlmBox("mdia", mdhd, hdlr, rlmBox("minf", xmhd, dinf, stbl)));
}
function rlmBuild(vt, at) {
  // 소리와 그림을 시간 차례로 섞어 놓는다(재생기가 앞뒤로 오가며 읽지 않게)
  const order = [];
  vt.samples.forEach((s, i) => order.push({ t: vt, i, time: s.time }));
  at.samples.forEach((s, i) => order.push({ t: at, i, time: s.time }));
  order.sort((a, b) => a.time - b.time || (a.t === vt ? -1 : 1));
  const durOf = (t) => t.samples.reduce((s, x) => s + x.dur, 0) / t.ts;
  const movieDur = Math.round(Math.max(durOf(vt), durOf(at)) * 1000);
  const ftyp = rlmBox("ftyp", rlmB([...rlmTxt("isom"), ...rlmU32(512), ...rlmTxt("isom"), ...rlmTxt("iso2"), ...rlmTxt("avc1"), ...rlmTxt("mp41")]));
  const moovWith = (vo, ao) => rlmBox("moov",
    rlmFull("mvhd", 0, 0, rlmB([...rlmU32(0), ...rlmU32(0), ...rlmU32(1000), ...rlmU32(movieDur), ...rlmU32(0x00010000), ...rlmU16(0x0100),
      ...new Array(10).fill(0)]), RLM_MATRIX, rlmB([...new Array(24).fill(0), ...rlmU32(3)])),
    rlmTrak(vt, vo, movieDur), rlmTrak(at, ao, movieDur));
  const zeros = (t) => t.samples.map(() => 0);
  const moovSize = moovWith(zeros(vt), zeros(at)).length;   // 자리값의 크기는 값과 상관없다
  const dataLen = order.reduce((s, o) => s + o.t.samples[o.i].data.length, 0);
  let pos = ftyp.length + moovSize + 8;
  const vo = zeros(vt), ao = zeros(at);
  order.forEach((o) => { (o.t === vt ? vo : ao)[o.i] = pos; pos += o.t.samples[o.i].data.length; });
  const moov = moovWith(vo, ao);
  const out = new Uint8Array(ftyp.length + moov.length + 8 + dataLen);
  out.set(ftyp, 0);
  out.set(moov, ftyp.length);
  let o = ftyp.length + moov.length;
  out.set([...rlmU32(8 + dataLen), ...rlmTxt("mdat")], o);
  o += 8;
  order.forEach((x) => { const d = x.t.samples[x.i].data; out.set(d, o); o += d.length; });
  return new Blob([out], { type: "video/mp4" });
}

/* ── 그리기·압축 ── */
// 숨은 탭에서도 늦춰지지 않는 '잠깐 쉬기'(setTimeout은 숨은 탭에서 1초로 늘어난다)
const rlmYield = () => new Promise((res) => { const ch = new MessageChannel(); ch.port1.onmessage = () => res(); ch.port2.postMessage(0); });
// 반환 {done: Promise<{blob, mime}>, stop}
function rlEncodeMp4(e, { onProgress } = {}) {
  let cancelled = false;
  const ctl = { stop: () => { cancelled = true; } };
  ctl.done = (async () => {
    const tl = rlTimeline(e);
    const imgs = await rlLoadImgs(e);
    const canvas = document.createElement("canvas");
    canvas.width = RL_W; canvas.height = RL_H;
    const ctx = canvas.getContext("2d");
    let err = null;
    const vt = { kind: "v", id: 1, ts: RLM_VTS, samples: [], desc: null };
    const at = { kind: "a", id: 2, ts: RLM_SR, samples: [], desc: null };
    const venc = new VideoEncoder({
      output: (chunk, meta) => {
        if (meta && meta.decoderConfig && meta.decoderConfig.description && !vt.desc) vt.desc = new Uint8Array(meta.decoderConfig.description);
        const data = new Uint8Array(chunk.byteLength); chunk.copyTo(data);
        vt.samples.push({ data, time: chunk.timestamp / 1e6, key: chunk.type === "key", pts: chunk.timestamp });
      },
      error: (x) => { err = x; },
    });
    venc.configure({ codec: "avc1.640028", width: RL_W, height: RL_H, bitrate: RLM_VBITRATE, framerate: RLM_FPS,
      avc: { format: "avc" }, latencyMode: "quality" });
    const aenc = new AudioEncoder({
      output: (chunk, meta) => {
        if (meta && meta.decoderConfig && meta.decoderConfig.description && !at.desc) at.desc = new Uint8Array(meta.decoderConfig.description);
        const data = new Uint8Array(chunk.byteLength); chunk.copyTo(data);
        at.samples.push({ data, time: chunk.timestamp / 1e6, dur: 1024 });
      },
      error: (x) => { err = x; },
    });
    aenc.configure({ codec: "mp4a.40.2", sampleRate: RLM_SR, numberOfChannels: 1, bitrate: 128000 });
    // 소리 먼저(가볍다)
    const mix = await rlmMixAudio(e, tl);
    for (let i = 0; i < mix.length; i += 1024) {
      const part = mix.slice(i, Math.min(i + 1024, mix.length));
      aenc.encode(new AudioData({ format: "f32-planar", sampleRate: RLM_SR, numberOfFrames: part.length, numberOfChannels: 1,
        timestamp: Math.round((i / RLM_SR) * 1e6), data: part }));
    }
    // 그림 — 한 장씩 그려 넣는다(인코더가 밀리면 기다린다)
    const frames = Math.ceil(tl.total * RLM_FPS);
    const fdur = Math.round(1e6 / RLM_FPS);
    for (let f = 0; f < frames; f++) {
      if (cancelled || err) break;
      rlDraw(ctx, e, tl, imgs, f / RLM_FPS);
      const vf = new VideoFrame(canvas, { timestamp: f * fdur, duration: fdur });
      venc.encode(vf, { keyFrame: f % (RLM_FPS * 2) === 0 });
      vf.close();
      while (venc.encodeQueueSize > 6 && !err) await new Promise((r) => venc.addEventListener("dequeue", r, { once: true }));
      if (f % 15 === 0) { if (onProgress) onProgress(f / frames); await rlmYield(); }
    }
    if (cancelled) { try { venc.close(); aenc.close(); } catch (_e) { /* 이미 닫힘 */ } return { blob: null, mime: "" }; }
    await venc.flush(); await aenc.flush();
    venc.close(); aenc.close();
    if (err) throw err;
    if (!vt.desc || !at.desc || !vt.samples.length) throw new Error("영상 압축 정보를 받지 못했습니다.");
    // 그림 길이 — 다음 장까지(마지막 장은 한 장 길이). 압축기가 장 순서를 바꿨으면(B 프레임) 이 묶기로는 못 담는다 —
    // 정렬하면 풀 때 순서가 틀어지므로 멈추고 알린다(크롬 H.264 인코더는 바꾸지 않았다, 2026-11-19 확인)
    if (vt.samples.some((s, i) => i && s.pts <= vt.samples[i - 1].pts)) throw new Error("영상 압축 순서가 예상과 달라 파일을 묶지 못했습니다.");
    vt.samples.forEach((s, i) => {
      const next = vt.samples[i + 1];
      s.dur = Math.max(1, Math.round(((next ? next.pts : s.pts + fdur) - s.pts) * RLM_VTS / 1e6));
    });
    if (onProgress) onProgress(1);
    return { blob: rlmBuild(vt, at), mime: "video/mp4" };
  })();
  return ctl;
}
