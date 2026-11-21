/* ══════ 지문 강의 영상 (2026-11-20 사용자) ══════
   지문 하나 → 가로 1920×1080 수업 영상(4~6분). 문장마다 영어를 읽고, 뜻을 풀고, 문법·구문·내신에 나올 곳을 짚는다.
     ① /api/lessonscript — 서버가 문장을 나누고(원문 그대로) AI가 해석·대사·필기 계획을 짠다(값 한 번)
     ② /api/lessonvoice  — 대사를 LS_VOICE_BATCH줄씩 목소리로(줄마다 값)
   화면 모양은 둘이고 **같은 대본**을 여기서 다르게 그린다 — 만든 뒤 값 없이 바꾼다(2026-11-20 사용자: 두 가지 다).
     ✍️ 필기형  — 지문 종이 위를 카메라가 문장마다 확대해 펜으로 동그라미·밑줄·형광펜을 긋고 낱말 위에 손글씨 메모,
                  오른쪽 공책에 정리(로컬 도구 지문설명영상/_제작도구/build.py·stage.html을 캔버스로 옮긴 것)
     🖥️ 슬라이드형 — 문장 하나씩 큰 카드, 색 표시·이름표, 오른쪽 '포인트' 카드
   영상 파일은 숏폼처럼 브라우저가 만든다(reels_mp4.js의 rlEncodeMp4에 크기·시간표·그리기를 넘긴다 — 정식 mp4).
   목소리 다듬기(rlCleanPcm — Gemini 음성 끝 '치직' 자르기)·wav(rlWavBlob)·목소리 목록(RL_VOICES)은 reels.js 것을 쓴다.
   저장은 저장함 tab "lesson" — 대본은 저장본 글에, 목소리는 /api/saved-image로 한 줄씩. 영상 파일은 저장하지 않는다. */

const lsEl = (id) => document.getElementById(id);
const LESSON_NAME = "지문 강의 영상";
const LS_W = 1920, LS_H = 1080;
const LS_VOICE_BATCH = 12;          // 서버 LESSON_VOICE_BATCH와 같다
const LS_VOICE_PARALLEL = 2;        // 목소리 묶음을 함께 부르는 수
const LS_TEMPO = 1.05;              // 기본 빠르기 — 수업 영상은 숏폼(1.15)보다 느리게(2026-11-14 사용자, 로컬 도구와 같다)
// 한 번에 만드는 영상 수(2026-11-20 사용자 — 한 단원 본문 여러 개를 한 번에. 3 → 10 → 20). 영상 수보다 전체 길이가 문제라
// 고른 영상 문장 합계를 LS_TOTAL_SENT_MAX로 막는다 — 다 만든 mp4를 브라우저 메모리에 들고 있고(실측 1분 ≈ 12MB, 29문장 = 11분 136MB),
// 120문장 ≈ 45분 ≈ 550MB가 학교 PC 크롬 탭이 버티는 선이다
const LS_MAX_PASSAGES = 20;
const LS_TOTAL_SENT_MAX = 120;
const LS_VBITRATE = 4_000_000;      // 영상 압축 목표(숏폼 8Mbps의 절반)
const LS_DEFAULT_VOICE = "Aoede";   // 로컬 수업 영상에 쓰던 목소리
const LS_LOOKS = [
  { id: "pen", label: "✍️ 필기형", desc: "왼쪽 영어·오른쪽 해석(워크북 좌지문 우해석) 위에 펜으로 긋고 손글씨 메모, 오른쪽 공책에 정리" },
  { id: "slide", label: "🖥️ 슬라이드형", desc: "문장 하나씩 크게, 색 표시와 이름표, 오른쪽 포인트 카드" },
];
const LS_FONT = (typeof RL_FONT !== "undefined" && RL_FONT) || "sans-serif";
const LS_EN_FONT = `Georgia, "Times New Roman", serif`;
const LS_PEN = `LsPen, ${LS_FONT}`;
const LS_COLORS = { red: "#e0453a", blue: "#2f5bd3", green: "#169c5a", orange: "#e8810c" };
const LS_ACCENT = "#4b3fb5";

const lsState = { entries: [], busy: false };
let lsBlobUrls = [];
const lsBlob = (u) => { lsBlobUrls.push(u); return u; };
function lsDropBlobs() { lsBlobUrls.forEach((u) => URL.revokeObjectURL(u)); lsBlobUrls = []; }
const lsSpeedOf = (e) => (e && +e.speed) || LS_TEMPO;
const lsLookOf = (e) => (e && LS_LOOKS.some((l) => l.id === e.look) ? e.look : LS_LOOKS[0].id);
const lsTagOf = (e) => (typeof e.tag === "string" ? e.tag : (e.name || LESSON_NAME)).trim();

/* ── 고르는 칸: 목소리 · 빠르기 · 화면 모양 ── */
// 목소리 고르기 — 숏폼 탭과 같은 방식(2026-11-20 사용자): 추천 넷 + '더 많은 목소리', 카드마다 [🔊 들어 보기],
// 여러 개 고르면 지문마다 줄이 생기고 처음엔 차례로 돌려 넣는다(바꾼 것은 지문 글을 열쇠로 기억 — 화면에서만)
const lsVoiceCard = (v) =>
  `<label class="rl-voice"><input type="checkbox" class="ls-vchk" value="${v.id}"${v.id === LS_DEFAULT_VOICE ? " checked" : ""}>` +
  `<b>${v.id}</b><span class="rl-voice-desc">${esc(v.desc)}</span>` +
  `<button type="button" class="btn ghost small ls-listen" data-v="${v.id}" title="같은 인사말로 미리 들어 봅니다">🔊 들어 보기</button></label>`;
lsEl("lsVoiceBox").innerHTML =
  `<div class="rl-vgroup-title">⭐ 추천 목소리</div>` +
  `<div class="rl-voices">${RL_VOICES.filter((v) => v.rec).map(lsVoiceCard).join("")}</div>` +
  `<details class="rl-vmore"><summary>더 많은 목소리 (${RL_VOICES.filter((v) => !v.rec).length}개)</summary>` +
  `<div class="rl-voices">${RL_VOICES.filter((v) => !v.rec).map(lsVoiceCard).join("")}</div></details>` +
  `<div class="rl-per" id="lsPerList" hidden></div>`;
const lsVoicesChecked = () => [...document.querySelectorAll(".ls-vchk:checked")].map((c) => c.value);
const lsVoicePick = new Map();   // 지문 글 → 고른 목소리
function lsVoiceFor(job, i) {
  const vs = lsVoicesChecked();
  if (!vs.length) return "";
  const picked = lsVoicePick.get(job.text);
  return vs.includes(picked) ? picked : vs[i % vs.length];
}
function lsRenderPer() {
  const box = lsEl("lsPerList");
  const vs = lsVoicesChecked();
  const jobs = lsJobs();
  box.hidden = vs.length < 2 || !jobs.length;
  if (box.hidden) { box.innerHTML = ""; return; }
  box.innerHTML = `<div class="rl-vgroup-title">🎙️ 영상마다 목소리 <span class="rl-voice-desc">처음엔 고른 목소리를 차례로 돌려 넣었어요 — 지문마다 바꿀 수 있어요</span></div>` +
    jobs.map((j, i) => `<label class="rl-per-row"><span>${esc(j.name)}</span><select data-i="${i}">` +
      vs.map((v) => `<option value="${v}"${v === lsVoiceFor(j, i) ? " selected" : ""}>${v} — ${esc(RL_VOICES.find((x) => x.id === v).desc)}</option>`).join("") +
      `</select></label>`).join("");
}
lsEl("lsVoiceBox").addEventListener("change", (e) => {
  if (e.target.classList.contains("ls-vchk")) lsRenderPer();
  const sel = e.target.closest(".rl-per select");
  if (sel) { const j = lsJobs()[+sel.dataset.i]; if (j) lsVoicePick.set(j.text, sel.value); }
});
const lsSpeedText = (v) => `${(+v).toFixed(2).replace(/0$/, "")}배`;
lsEl("lsSpeedBox").innerHTML = `<label for="lsSpeed" class="rl-vgroup-title">⏩ 말 빠르기</label> ` +
  `<input type="range" id="lsSpeed" min="0.7" max="1.5" step="0.05" value="${LS_TEMPO}"><b class="rl-speed-val" id="lsSpeedVal">${lsSpeedText(LS_TEMPO)}</b>` +
  `<span class="rl-voice-desc">만든 뒤에도 영상마다 바꿀 수 있어요(값 없음)</span>`;
lsEl("lsLookBox").innerHTML = `<div class="rl-vgroup-title">🎞️ 화면 모양</div><div class="rl-styles ls-looks">` +
  LS_LOOKS.map((l, i) => `<label class="rl-voice rl-style"><input type="radio" name="lsLook" class="ls-look" value="${l.id}"${i ? "" : " checked"}>` +
    `<b>${l.label}</b><span class="rl-voice-desc">${l.desc}</span></label>`).join("") +
  `</div><span class="rl-voice-desc">두 모양은 같은 대본으로 그립니다 — 만든 뒤 카드에서 값 없이 바꿀 수 있어요</span>`;
const lsSpeedPick = () => +lsEl("lsSpeed").value || LS_TEMPO;
const lsLookPick = () => { const c = document.querySelector(".ls-look:checked"); return c ? c.value : LS_LOOKS[0].id; };
lsEl("lsSpeed").addEventListener("input", () => {
  lsEl("lsSpeedVal").textContent = lsSpeedText(lsSpeedPick());
  if (lsSample) lsSample.playbackRate = lsSpeedPick() / 1.15;
});
// 들어 보기 — 숏폼과 같다: 누르면 재생, 듣는 중에 다시 누르면 일시정지, 한 번 더 누르면 이어서. 다른 목소리를 누르면 앞의 것은 멈춘다.
// 파일은 숏폼과 같은 public/reel-voice-<id>.mp3(1.15배로 녹음 — 고른 빠르기에 맞춰 틀어 준다)
const LS_LISTEN = "🔊 들어 보기", LS_PAUSE = "⏸ 일시정지", LS_RESUME = "▶ 이어 듣기";
let lsSample = null, lsSampleBtn = null;
lsEl("lsVoiceBox").addEventListener("click", (e) => {
  const b = e.target.closest(".ls-listen");
  if (!b) return;
  e.preventDefault();
  if (lsSampleBtn === b && lsSample) {
    if (lsSample.paused) { lsSample.play().catch(() => {}); b.textContent = LS_PAUSE; }
    else { lsSample.pause(); b.textContent = LS_RESUME; }
    return;
  }
  if (lsSample) lsSample.pause();
  if (lsSampleBtn) lsSampleBtn.textContent = LS_LISTEN;
  lsSample = new Audio(rlAsset(`/reel-voice-${b.dataset.v}.mp3`));
  lsSample.preservesPitch = true;
  lsSample.playbackRate = lsSpeedPick() / 1.15;
  lsSampleBtn = b;
  lsSample.addEventListener("ended", () => { b.textContent = LS_LISTEN; lsSample = null; lsSampleBtn = null; });
  b.textContent = LS_PAUSE;
  lsSample.play().catch(() => { b.textContent = LS_LISTEN; });
});

/* ── 값 ── */
const lsPrice = () => (typeof PRICING !== "undefined" && PRICING && Number.isFinite(PRICING.lessonScript)) ? PRICING : null;
// 목표 어법(공용 '목표 어법' 칸) — 서버가 4개까지 상세 설명을 붙인다(LESSON_TARGETS_MAX). 어법 하나에 대사 약 6줄이 더해진다
const LS_TARGETS_MAX = 4;
function lsTargets() {
  const seen = new Set(), out = [];
  String((typeof grammarEl !== "undefined" && grammarEl && grammarEl.value) || "").split(/[,;\n，、]+/).forEach((p) => {
    const t = p.replace(/\s+/g, " ").trim().slice(0, 80);
    if (t && !seen.has(t.toLowerCase())) { seen.add(t.toLowerCase()); out.push(t); }
  });
  return out.slice(0, LS_TARGETS_MAX);
}
const lsEstLines = (text) => Math.round((typeof roughSentenceCount === "function" ? roughSentenceCount(text) : 8) * 2.5 + 8 + lsTargets().length * 6);
// 상세분석(지문마다 PRICING.analyze)을 먼저 돌려 그 해설로 대본을 쓴다(2026-11-21 사용자) — parts = 묶음 속 지문 수
const lsEstCost = (text, parts = 1) => { const p = lsPrice(); return p ? p.lessonScript + (p.lessonAnalyze || 0) * parts + p.lessonVoiceLine * lsEstLines(text) : null; };
function lsJobs() { return passageMgr.getJobs().filter((j) => j.text && j.text.length >= 20).slice(0, LS_MAX_PASSAGES); }
function lsSyncCost() {
  const jobs = lsJobs(), p = lsPrice();
  const tg = lsTargets();
  lsEl("lsTargetNote").innerHTML = tg.length
    ? `🎯 목표 어법 <b>${tg.map(esc).join(", ")}</b> — 문장 설명이 끝난 뒤 어법마다 개념·형태·이 지문에서 쓰인 곳·내신에 나오는 방식을 자세히 설명합니다${String(grammarEl.value || "").split(/[,;\n，、]+/).filter((x) => x.trim()).length > LS_TARGETS_MAX ? ` (앞의 ${LS_TARGETS_MAX}개만)` : ""}.`
    : "🎯 위쪽 <b>목표 어법</b> 칸에 어법을 적으면(쉼표로 여럿, 4개까지) 그 어법을 따로 자세히 설명하는 시간이 들어갑니다.";
  lsEl("lsCostHint").innerHTML = jobs.length && p
    ? `예상 비용 <b>${pt(jobs.reduce((s, j) => s + lsEstCost(j.text), 0))}</b> 안팎 (지문 ${jobs.length}개 × [대본 ${pt(p.lessonScript)} + 목소리 대사 약 ${jobs.map((j) => lsEstLines(j.text)).join("·")}줄 × ${pt(p.lessonVoiceLine)}]` +
      ` — 대사 수는 문장 수에 따라 달라지고, 실제로 만든 줄 수만큼만 받습니다)` : "";
}
if (typeof onPricingReady === "function") onPricingReady(lsSyncCost);
document.addEventListener("input", (e) => {
  if (e.target.id === "targetGrammar") lsSyncCost();
  if (e.target.closest && e.target.closest(".passage-panel")) { lsSyncCost(); lsRenderPer(); }
});
document.querySelector('.tab-btn[data-tab="lesson"]').addEventListener("click", () => { lsSyncCost(); lsRenderPer(); });

/* ── 손글씨 글꼴(필기형) — 이 탭에서 그릴 때만 불러온다(3.5MB, 나눔손글씨 펜·SIL OFL) ── */
let lsFontP = null, lsFontOk = false;
function lsFontReady() {
  if (!lsFontP) {
    lsFontP = (window.FontFace ? new FontFace("LsPen", "url(/fonts/NanumPen.ttf)").load() : Promise.reject())
      .then((f) => { document.fonts.add(f); lsFontOk = true; return true; }).catch(() => false);
  }
  return lsFontP;
}

/* ── 글자 놓기 · 낱말 찾기 ── */
const lsNorm = (s) => String(s || "").replace(/[‐-―]/g, "-").replace(/[’‘]/g, "'").replace(/[“”]/g, '"');
let lsMeasure = null;
const lsCtx = () => (lsMeasure || (lsMeasure = document.createElement("canvas").getContext("2d")));
function lsWrap(ctx, text, maxW) {
  const out = [];
  let line = "";
  String(text || "").split(/\s+/).filter(Boolean).forEach((w) => {
    const t = line ? line + " " + w : w;
    if (line && ctx.measureText(t).width > maxW) { out.push(line); line = w; } else line = t;
  });
  if (line) out.push(line);
  return out;
}
// 영어 문장을 줄로 나눠 놓는다 → {words:[{t,x0,x1,base,top,bot,line}], lines:[{text,x,base}], lastBase}
function lsPlace(ctx, text, size, x, base0, maxW, lh, centerX) {
  ctx.font = `${size}px ${LS_EN_FONT}`;
  const sp = ctx.measureText(" ").width;
  const rows = [[]];
  let cx = 0;
  String(text).split(/\s+/).filter(Boolean).forEach((t) => {
    const w = ctx.measureText(t).width;
    if (cx && cx + w > maxW) { rows.push([]); cx = 0; }
    rows[rows.length - 1].push({ t, w, dx: cx });
    cx += w + sp;
  });
  const words = [], lines = [];
  rows.forEach((r, i) => {
    const lw = r.length ? r[r.length - 1].dx + r[r.length - 1].w : 0;
    const x0 = centerX != null ? centerX - lw / 2 : x;
    const base = base0 + i * lh;
    lines.push({ text: r.map((w) => w.t).join(" "), x: x0, base });
    r.forEach((w) => words.push({ t: w.t, x0: x0 + w.dx, x1: x0 + w.dx + w.w, base, top: base - size * 0.74, bot: base + size * 0.24, line: i }));
  });
  return { words, lines, lastBase: base0 + (rows.length - 1) * lh };
}
function lsFind(words, target) {
  let stream = "";
  const owner = [];
  words.forEach((w, i) => {
    if (i) { stream += " "; owner.push(-1); }
    const t = lsNorm(w.t);
    stream += t;
    for (let k = 0; k < t.length; k++) owner.push(i);
  });
  const tg = lsNorm(target).trim();
  if (!tg) return [];
  const re = tg.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const m = new RegExp(`(?<![A-Za-z])${re}(?![A-Za-z])`).exec(stream) || new RegExp(`(?<![A-Za-z])${re}(?![A-Za-z])`, "i").exec(stream);
  if (!m) return [];
  const idx = new Set();
  for (let k = m.index; k < m.index + tg.length; k++) if (owner[k] >= 0) idx.add(owner[k]);
  return [...idx].sort((a, b) => a - b).map((i) => words[i]);
}
function lsByLine(ws) {
  const out = [];
  ws.forEach((w) => {
    const L = out[out.length - 1];
    if (L && L.line === w.line) { L.x1 = w.x1; } else out.push({ line: w.line, x0: w.x0, x1: w.x1, top: w.top, bot: w.bot, base: w.base });
  });
  return out;
}

/* ── 모양(펜 길) — 점 목록과 누적 길이를 미리 만들어 두고 진행률만큼 그린다 ── */
function lsPath(pts) {
  const acc = [0];
  for (let i = 1; i < pts.length; i++) acc.push(acc[i - 1] + Math.hypot(pts[i][0] - pts[i - 1][0], pts[i][1] - pts[i - 1][1]));
  return { pts, acc, len: acc[acc.length - 1] || 1 };
}
function lsCapsule(x0, x1, y0, y1) {
  // 길쭉한 고리 — 손으로 그린 듯 살짝 흔들리고 끝이 조금 겹친다(stage.html ellipsePath와 같은 모양)
  const r = (y1 - y0) / 2, cy = (y0 + y1) / 2, xl = x0 + r, xr = Math.max(x1 - r, xl), per = 2 * (xr - xl) + 2 * Math.PI * r, N = 90, pts = [];
  for (let i = 0; i <= N; i++) {
    let u = ((i / N) * 1.05 + 0.62) % 1 * per, x, y;
    if (u < xr - xl) { x = xl + u; y = cy - r; }
    else if ((u -= xr - xl) < Math.PI * r) { const a = -Math.PI / 2 + u / r; x = xr + Math.cos(a) * r; y = cy + Math.sin(a) * r; }
    else if ((u -= Math.PI * r) < xr - xl) { x = xr - u; y = cy + r; }
    else { u -= xr - xl; const a = Math.PI / 2 + u / r; x = xl + Math.cos(a) * r; y = cy + Math.sin(a) * r; }
    pts.push([x, y + 1.2 * Math.sin((i / N) * 9) + (2 * i) / N]);
  }
  return pts;
}
function lsShapes(kind, lines, size) {
  const f = size / 46;
  return lines.map((L) => {
    if (kind === "circle") return { type: "stroke", ...lsPath(lsCapsule(L.x0 - 7 * f, L.x1 + 7 * f, L.top - 6 * f, L.bot + 5 * f)) };
    if (kind === "box") {
      const x = L.x0 - 6 * f, y = L.top - 5 * f, w = L.x1 - L.x0 + 12 * f, h = L.bot - L.top + 10 * f;
      return { type: "stroke", ...lsPath([[x, y], [x + w, y + 1], [x + w - 1, y + h], [x + 1, y + h - 1], [x - 1, y - 3]]) };
    }
    if (kind === "highlight") return { type: "hl", x: L.x0 - 4 * f, y: L.top + 1 * f, w: L.x1 - L.x0 + 8 * f, h: L.bot - L.top };
    if (kind === "wavy") {   // 물결 밑줄 — 뜻이 중요한 낱말(lesson-video 스킬의 w)
      const y = L.base + 11 * f, n = Math.max(8, Math.round((L.x1 - L.x0) / (7 * f))), pts = [];
      for (let i = 0; i <= n * 4; i++) { const u = i / (n * 4); pts.push([L.x0 + (L.x1 - L.x0) * u, y + 4 * f * Math.sin(u * n * Math.PI)]); }
      return { type: "stroke", ...lsPath(pts) };
    }
    const y = L.base + 10 * f, pts = [];
    for (let i = 0; i <= 20; i++) { const u = i / 20; pts.push([L.x0 + (L.x1 - L.x0) * u, y + 4 * f * u * (1 - u) * 2 - 2 * f * u]); }
    return { type: "stroke", ...lsPath(pts) };
  });
}
function lsDrawPart(ctx, sh, p, color, width) {
  // 진행률 p만큼 그리고 펜 끝 자리를 돌려준다
  if (p <= 0) return null;
  if (sh.type === "hl") {
    ctx.save();
    ctx.globalCompositeOperation = "multiply";
    ctx.fillStyle = "rgba(255,221,0,.6)";
    ctx.fillRect(sh.x, sh.y, sh.w * Math.min(p, 1), sh.h);
    ctx.restore();
    return p < 1 ? [sh.x + sh.w * p, sh.y + sh.h] : null;
  }
  const goal = sh.len * Math.min(p, 1);
  ctx.beginPath();
  ctx.moveTo(sh.pts[0][0], sh.pts[0][1]);
  let tip = sh.pts[0];
  for (let i = 1; i < sh.pts.length; i++) {
    if (sh.acc[i] <= goal) { ctx.lineTo(sh.pts[i][0], sh.pts[i][1]); tip = sh.pts[i]; continue; }
    const a = sh.acc[i - 1], k = (goal - a) / Math.max(sh.acc[i] - a, 1e-6);
    tip = [sh.pts[i - 1][0] + (sh.pts[i][0] - sh.pts[i - 1][0]) * k, sh.pts[i - 1][1] + (sh.pts[i][1] - sh.pts[i - 1][1]) * k];
    ctx.lineTo(tip[0], tip[1]);
    break;
  }
  ctx.strokeStyle = color; ctx.lineWidth = width; ctx.lineCap = "round"; ctx.lineJoin = "round";
  ctx.stroke();
  return p < 1 ? tip : null;
}

/* ── 배치: 필기형(지문 종이 한 장, 카메라가 움직인다) ── */
// 종이는 지문 칸(1400px) 폭에 꽉 — 처음엔 1300px 종이를 가운데 두어 양옆이 비었다(2026-11-20 사용자: 더 크게)
/* 2026-11-21 사용자: 워크북 '좌지문 우해석'처럼 문장마다 왼쪽 영어(7)·오른쪽 해석(3)을 나란히 놓고 그 위에 필기한다
   (예전엔 영어 아래에 해석을 한 줄로 이어 썼다). ER = 영어 칸 오른쪽 끝, KX = 해석 칸 왼쪽 끝 */
const LSP = { DW: 1400, X: 66, R: 1372, ER: 930, KX: 976, EN: 44, LH: 116, KO: 28, KOLH: 42, NOTE: 40 };
function lsLayoutPen(ctx, e) {
  const blocks = [];
  let y = 150;
  e.script.sentences.forEach((s) => {
    const top = y, base0 = top + 84;
    const pl = lsPlace(ctx, s.en, LSP.EN, LSP.X, base0, LSP.ER - LSP.X, LSP.LH);
    ctx.font = `${LSP.KO}px ${LS_FONT}`;
    const ko = (s.ko ? lsWrap(ctx, s.ko, LSP.R - LSP.KX) : []).map((text, i) => ({ text, base: base0 + i * LSP.KOLH }));
    const bot = Math.max(pl.lastBase + 44, ko.length ? ko[ko.length - 1].base + 22 : 0);
    blocks.push({ n: s.n, top, bot, ...pl, ko });
    y = bot + 26;
  });
  return { blocks, docH: y + 20, size: LSP.EN };
}
function lsCamPen(lay, view, from) {
  const m = /^s(\d+)$/.exec(view);
  if (m) {
    const b = lay.blocks[+m[1] - 1], a = from && lay.blocks[from - 1];
    if (a && a !== b && b.bot - a.top < LS_H - 160) return { s: 1, tx: 0, ty: 110 - a.top };
    return { s: 1, tx: 0, ty: 110 - b.top };
  }
  // 도입·정리 — 줄이지 않고 문장 장면과 같은 크기로 지문 맨 위부터(2026-11-20 사용자: 줄여 가운데 두었더니 양옆이 비었다)
  return { s: 1, tx: 0, ty: 0 };
}

/* ── 배치: 슬라이드형(문장마다 한 장) ── */
const LSS = { CX: 700, W: 1120, EN: 56, LH: 126, KO: 32, KOLH: 46, CARD: [60, 60, 1280, 830] };
function lsLayoutSlide(ctx, e) {
  const blocks = e.script.sentences.map((s) => {
    let size = LSS.EN, lh = LSS.LH, pl;
    for (;;) {   // 긴 문장은 글씨를 줄여 카드에 맞춘다
      pl = lsPlace(ctx, s.en, size, 0, 0, LSS.W, lh, LSS.CX);
      if ((pl.lines.length) * lh < 520 || size <= 36) break;
      size -= 4; lh = Math.round(size * 2.25);
    }
    ctx.font = `${LSS.KO}px ${LS_FONT}`;
    const koL = s.ko ? lsWrap(ctx, s.ko, LSS.W) : [];
    const h = pl.lines.length * lh + 30 + koL.length * LSS.KOLH;
    const top = 60 + 90 + Math.max(0, (830 - 110 - h) / 2);
    const dy = top + size;   // 첫 줄 바탕선
    pl.words.forEach((w) => { w.base += dy; w.top += dy; w.bot += dy; });
    pl.lines.forEach((l) => { l.base += dy; });
    const koBase = pl.lastBase + dy + 30 + LSS.KO + 14;
    return { n: s.n, words: pl.words, lines: pl.lines, size, ko: koL.map((text, i) => ({ text, base: koBase + i * LSS.KOLH })) };
  });
  return { blocks, size: LSS.EN };
}

/* ── 시간표 — build.py와 같은 간격(대사 사이 0.42초, 화면이 바뀔 때 0.75초) ── */
function lsTimeline(e) {
  const look = lsLookOf(e), speed = lsSpeedOf(e);
  const key = `${look}|${speed}|${lsFontOk}|${(e.audio || []).map((a) => a && a.raw).join(",")}`;
  if (e._tl && e._tlKey === key) return e._tl;
  const ctx = lsCtx();
  const pen = look === "pen";
  const lay = pen ? lsLayoutPen(ctx, e) : lsLayoutSlide(ctx, e);
  const segs = [];
  let t = 1.0, prev = null;
  e.script.segments.forEach((g, k) => {
    const a = e.audio && e.audio[k];
    const moved = g.view !== prev;
    if (prev !== null) t += moved ? 0.75 : 0.42;
    const dur = (a ? a.raw : Math.max(1.5, g.say.length * 0.11)) / speed;
    segs.push({ k, start: t, dur, end: t + dur, view: g.view, moved, say: g.say });
    t += dur;
    prev = g.view;
  });
  const total = t + 1.8;
  // 필기·메모·노트 — 펜은 하나라 차례로 쓴다
  const items = [];
  let penT = 0;
  const placed = {};   // 문장 번호 → 놓은 메모 상자들
  const boardPages = [];   // 판서 판들 {no, title, t0}
  const BOARD_ROWS = pen ? LSB_PEN.ROWS : LSB_SLIDE.ROWS;
  let boardCur = null, boardRow = 0;
  const noteFont = pen ? `${LSP.NOTE}px ${LS_PEN}` : `700 28px ${LS_FONT}`;
  e.script.segments.forEach((g, si) => {
    const sg = segs[si];
    const base = sg.start + (sg.moved ? 0.45 : 0.1);
    const m = /^s(\d+)$/.exec(g.view);
    const blk = m ? lay.blocks[+m[1] - 1] : null;
    const sayL = g.say.toLowerCase();
    (blk ? g.marks : []).forEach((mk, j) => {
      const ws = lsFind(blk.words, mk.target);
      if (!ws.length) return;
      const lines = lsByLine(ws);
      const kind = mk.kind === "circle" && lines.length > 1 ? "underline" : mk.kind;
      let shapes;
      if (kind === "number") shapes = [];   // 번호 글씨 — 모양 없이 메모 자리에 번호만(아래 note)
      else if (kind === "arrow") {   // 대명사 → 가리키는 말(같은 문장이나 바로 앞 문장)
        // 슬라이드형은 문장마다 한 장이라 앞 문장이 화면에 없다 — 같은 문장 안의 화살표만 긋고 나머지는 동그라미로
        const toBlk = mk.toN && mk.toN !== blk.n ? (pen ? lay.blocks[mk.toN - 1] : null) : blk;
        const tw = toBlk ? lsFind(toBlk.words, mk.to || "") : [];
        if (!tw.length) shapes = lsShapes("circle", lines.slice(0, 1), blk.size || lay.size);
        else {
          if (toBlk !== blk) sg.camFrom = mk.toN;
          const A = lines[0], B = lsByLine(tw)[0], f = (blk.size || lay.size) / 46;
          const ax = (A.x0 + A.x1) / 2, ay = A.top - 4 * f, bx = (B.x0 + B.x1) / 2, by = B.bot + 6 * f;
          const up = by <= ay + 4;   // 가리키는 말이 위쪽 줄이면 아래로 볼록하게 돌지 않고 바로 잇는다
          const cx = (ax + bx) / 2, cy = up ? (ay + by) / 2 - 30 * f : Math.min(ay, B.top) - 46 * f;
          const pts = [];
          for (let i = 0; i <= 24; i++) { const u = i / 24; pts.push([(1 - u) * (1 - u) * ax + 2 * (1 - u) * u * cx + u * u * bx, (1 - u) * (1 - u) * ay + 2 * (1 - u) * u * cy + u * u * (up ? by : B.top - 4 * f)]); }
          const ex = pts[24][0], ey = pts[24][1], dx = ex - pts[21][0], dy = ey - pts[21][1], dl = Math.hypot(dx, dy) || 1;
          const ux = dx / dl, uy = dy / dl, hl = 16 * f;
          shapes = [{ type: "stroke", ...lsPath(lsCapsule(A.x0 - 6 * f, A.x1 + 6 * f, A.top - 5 * f, A.bot + 4 * f)) },
            { type: "stroke", ...lsPath(pts) },
            { type: "stroke", ...lsPath([[ex - hl * (ux - uy * 0.6), ey - hl * (uy + ux * 0.6)], [ex, ey], [ex - hl * (ux + uy * 0.6), ey - hl * (uy - ux * 0.6)]]) }];
        }
      } else shapes = lsShapes(kind, lines, blk.size || lay.size);
      const color = LS_COLORS[mk.color] || LS_COLORS.red;
      const pos = sayL.indexOf(mk.target.toLowerCase());
      const frac = pos >= 0 ? pos / Math.max(sayL.length, 1) : 0.2 + 0.2 * j;
      const st = Math.max(base, penT, sg.start + frac * sg.dur - 0.15);
      const d = shapes.reduce((s, sh) => s + (pen ? (sh.type === "hl" ? 0.55 : 0.6) : 0.3), 0);
      if (shapes.length) {
        items.push({ kind: "mark", n: blk.n, t0: st, t1: st + d, color, shapes });
        penT = st + d + 0.12;
      } else penT = Math.max(penT, st);
      if (!mk.note) return;
      // 메모 자리: 첫 줄 바로 위 줄 틈 — 다른 메모와 겹치지 않게 좌우로 비켜 본다
      ctx.font = noteFont;
      const w = ctx.measureText(mk.note).width + (pen ? 4 : 28), h = pen ? LSP.NOTE : 40;
      const L = lines[0], cx = (L.x0 + L.x1) / 2;
      // 필기형은 메모가 오른쪽 해석 칸으로 넘어가지 않게 영어 칸 안에서만 비켜 본다
      const lo = pen ? LSP.X - 30 : 90, hi = pen ? LSP.ER + 24 : 1310;
      const mine = placed[blk.n] || (placed[blk.n] = []);
      const dn = mk.pos === "dn";   // 메모를 낱말 아래에(스킬의 pos="dn")
      const numX = kind === "number" ? L.x0 - w * 0.35 : null;   // 번호는 항목 첫 낱말 왼쪽 위에
      let spot = null;
      for (const dx of [0, -20, 20, -45, 45, -75, 75, -110, 110, -150, 150, -200, 200]) {
        const x = (numX != null ? numX + w / 2 : cx) + dx - w / 2, y = dn ? L.bot + 16 : L.top - 10 - h;
        if (x < lo || x + w > hi) continue;
        if (mine.some((r) => x < r[2] + 8 && x + w > r[0] - 8 && y < r[3] && y + h > r[1])) continue;
        spot = [x, y, x + w, y + h];
        break;
      }
      const nd = Math.min(1.3, Math.max(0.5, 0.11 * mk.note.length));
      if (spot) {
        mine.push(spot);
        items.push({ kind: "note", n: blk.n, t0: penT, t1: penT + nd, color, text: mk.note, x: spot[0], y: spot[1], w, h });
      } else {
        items.push({ kind: "pad", t0: penT, t1: penT + nd + 0.3, title: false, text: `${mk.target} : ${mk.note}`.slice(0, 26), color });
      }
      penT = items[items.length - 1].t1 + 0.15;
    });
    const pads = (g.pad_title ? [["t", g.pad_title]] : []).concat((g.pad || []).map((x) => ["l", x]));
    pads.forEach(([k, txt]) => {
      const st = Math.max(penT, sg.start + 0.3);
      const nd = k === "t" ? 0.8 : Math.min(1.6, Math.max(0.55, 0.075 * txt.length));
      items.push({ kind: "pad", t0: st, t1: st + nd, title: k === "t", text: txt, color: "#1d2a6b" });
      penT = st + nd + 0.15;
    });
    // 판서(view "board" — 목표 어법·내신 포인트·핵심 어휘, 2026-11-20 사용자: 말로만 설명하니 설명하는 느낌이 없다).
    // board_title이 오면 새 판을 시작하고, 줄은 말에 맞춰 한 줄씩 써 내려간다. 판이 차면 '(이어서)'로 새 판
    if (g.view === "board") {
      const newPage = (title) => {
        boardCur = { no: boardPages.length, title, t0: sg.start - 0.3 };
        boardPages.push(boardCur);
        boardRow = 0;
        const st = Math.max(penT, sg.start + 0.05), nd = 0.9;
        items.push({ kind: "btitle", page: boardCur.no, t0: st, t1: st + nd, text: title });
        penT = st + nd + 0.1;
      };
      // 긴 줄은 글씨를 줄이지 않고 두 줄로 나눈다(줄였더니 그 줄만 작아 들쭉날쭉했다)
      const rows = (g.board || []).flatMap((txt) => lsBoardRows(txt, pen));
      if (g.board_title || !boardCur) newPage(g.board_title || (boardCur && boardCur.title) || "정리");
      // 한 대사의 줄은 한 판에 함께 — 판이 모자라면 대사를 시작할 때 미리 넘긴다. 쓰는 도중에 넘기면 방금 쓴 줄이
      // 화면에 한 번도 안 나왔다(2026-11-20 사용자 영상 — 내신 포인트 셋째 줄이 사라졌다)
      else if (boardRow + rows.length > BOARD_ROWS) newPage(boardCur.title.replace(/ \(이어서\)$/, "") + " (이어서)");
      rows.forEach((info) => {
        if (boardRow >= BOARD_ROWS) newPage(boardCur.title.replace(/ \(이어서\)$/, "") + " (이어서)");
        const st = Math.max(penT, sg.start + 0.25);
        const nd = Math.min(2.4, Math.max(0.8, 0.075 * info.text.length));
        items.push({ kind: "board", page: boardCur.no, row: boardRow++, t0: st, t1: st + nd, ...info });
        penT = st + nd + 0.15;
      });
    }
  });
  // 노트 칸 줄·쪽 넘김
  const PAD_LINES = pen ? 16 : 13;
  let row = 0, page = 0;
  items.filter((x) => x.kind === "pad").forEach((it) => {
    let need = it.title && row > 0 ? 2 : 1;
    if (row + need > PAD_LINES) { page++; row = 0; need = 1; }
    row += need - 1;
    it.row = row; it.page = page;
    row++;
  });
  // 카메라(필기형) · 화면 바뀌는 때(슬라이드형)
  const cams = pen ? segs.map((sg) => ({ t: sg.start - (sg.moved ? 0.55 : 0), ...lsCamPen(lay, sg.view, sg.camFrom) })) : [];
  const views = segs.filter((sg) => sg.moved).map((sg) => ({ t: sg.start - 0.35, view: sg.view }));
  // 자막: 두 줄 분량으로 나눈다
  const subs = [];
  segs.forEach((sg) => {
    const pieces = sg.say.split(/(?<=[.?!])\s+/);
    const chunks = [];
    let cur = "";
    pieces.forEach((p) => { if (cur && cur.length + p.length > 58) { chunks.push(cur); cur = p; } else cur = (cur + " " + p).trim(); });
    if (cur) chunks.push(cur);
    const fixed = [];
    chunks.forEach((c) => {
      while (c.length > 70) {
        let k = c.lastIndexOf(", ", 62);
        k = k > 20 ? k + 1 : c.lastIndexOf(" ", 62);
        if (k <= 0) k = 62;
        fixed.push(c.slice(0, k).trim()); c = c.slice(k).trim();
      }
      fixed.push(c);
    });
    const tot = fixed.reduce((s, c) => s + c.length, 0) || 1;
    let t0 = sg.start;
    fixed.forEach((c, i) => {
      const d = (sg.dur * c.length) / tot;
      subs.push({ t0, t1: t0 + d + (i === fixed.length - 1 ? 0.25 : 0), text: c });
      t0 += d;
    });
  });
  e._tl = { look, lay, segs, items, cams, views, subs, total, boardPages };
  e._tlKey = key;
  return e._tl;
}

/* ── 그리기 공통 ── */
const lsEase = (x) => (x < 0 ? 0 : x > 1 ? 1 : x * x * (3 - 2 * x));
function lsRound(ctx, x, y, w, h, r) {
  ctx.beginPath();
  ctx.moveTo(x + r, y); ctx.arcTo(x + w, y, x + w, y + h, r); ctx.arcTo(x + w, y + h, x, y + h, r);
  ctx.arcTo(x, y + h, x, y, r); ctx.arcTo(x, y, x + w, y, r); ctx.closePath();
}
const lsProg = (it, t) => Math.min(1, Math.max(0, (t - it.t0) / Math.max(it.t1 - it.t0, 1e-3)));
function lsSubtitle(ctx, tl, t, cx, maxW, bottom) {
  const s = tl.subs.find((x) => x.t0 <= t && t < x.t1);
  if (!s) return;
  ctx.font = `600 34px ${LS_FONT}`;
  const lines = lsWrap(ctx, s.text, maxW - 56);
  const h = lines.length * 49 + 26;
  const w = Math.max(...lines.map((l) => ctx.measureText(l).width)) + 56;
  lsRound(ctx, cx - w / 2, bottom - h, w, h, 14);
  ctx.fillStyle = "rgba(24,26,38,.86)"; ctx.fill();
  ctx.fillStyle = "#fff"; ctx.textAlign = "center"; ctx.textBaseline = "middle";
  lines.forEach((l, i) => ctx.fillText(l, cx, bottom - h + 13 + 24.5 + i * 49));
  ctx.textAlign = "left"; ctx.textBaseline = "alphabetic";
}
function lsBrand() {
  if (!(lsEl("lsBrandOn") && lsEl("lsBrandOn").checked)) return null;
  const b = typeof trendBrand === "function" ? trendBrand() : { img: "", name: "" };
  return (b.name || b.img) ? { name: b.name, img: b.img } : null;
}
const lsBrandKey = () => { const b = lsBrand(); return b ? `${b.name}|${b.img.length}|${b.img.slice(-40)}` : ""; };
function lsDrawBrand(ctx, br, x, y, w, h, dark) {
  if (!br || !(br.name || br.logo)) return;
  let logoW = 0;
  if (br.logo && br.logo.naturalWidth) {
    const lh = h - 12, lw = Math.min(w * 0.45, br.logo.naturalWidth * (lh / br.logo.naturalHeight));
    const lhh = lw * (br.logo.naturalHeight / br.logo.naturalWidth);
    logoW = lw + 16;
    ctx.drawImage(br.logo, x + w - lw, y + (h - lhh) / 2, lw, lhh);
  }
  if (br.name) {
    let fs = 30;
    ctx.font = `800 ${fs}px ${LS_FONT}`;
    while (fs > 18 && ctx.measureText(br.name).width > w - logoW) { fs -= 2; ctx.font = `800 ${fs}px ${LS_FONT}`; }
    ctx.fillStyle = dark ? "#fff" : "#1d2a6b"; ctx.textBaseline = "middle";
    ctx.fillText(br.name, x, y + h / 2);
    ctx.textBaseline = "alphabetic";
  }
}
function lsDrawPenIcon(ctx, x, y) {
  ctx.save();
  ctx.translate(x, y); ctx.rotate(-0.73);
  ctx.fillStyle = "#333"; ctx.beginPath(); ctx.moveTo(0, 0); ctx.lineTo(9, -4); ctx.lineTo(9, 4); ctx.closePath(); ctx.fill();
  ctx.fillStyle = "#c9a26b"; ctx.fillRect(9, -4.5, 10, 9);
  ctx.fillStyle = "#2f3a63"; ctx.fillRect(19, -5.5, 70, 11);
  ctx.fillStyle = "#e0b84a"; ctx.fillRect(74, -5.5, 6, 11);
  ctx.restore();
}
// 노트·포인트 칸(오른쪽) — pen이면 공책, 아니면 카드
function lsDrawPad(ctx, tl, t, pen) {
  const X = pen ? 1420 : 1380, Y = pen ? 76 : 60, W = pen ? 470 : 500, H = pen ? 914 : 830;
  const ROW = pen ? 50 : 56, TOP = pen ? Y + 66 : Y + 92;
  ctx.save();
  ctx.shadowColor = "rgba(30,40,80,.18)"; ctx.shadowBlur = 18; ctx.shadowOffsetY = 4;
  lsRound(ctx, X, Y, W, H, pen ? 8 : 20);
  ctx.fillStyle = pen ? "#fffef7" : "rgba(255,255,255,.97)"; ctx.fill();
  ctx.restore();
  if (pen) {
    ctx.fillStyle = "#d7e1f2";
    for (let y = TOP + ROW - 1; y < Y + H; y += ROW) ctx.fillRect(X, y, W, 1);
    ctx.fillStyle = "#f2b8b8"; ctx.fillRect(X + 58, Y, 2, H);
    ctx.fillStyle = "#e9ecf3";
    for (let y = Y + 40; y < Y + H - 20; y += 72) { ctx.beginPath(); ctx.arc(X + 26, y, 8, 0, Math.PI * 2); ctx.fill(); }
  } else {
    ctx.fillStyle = LS_ACCENT; ctx.font = `800 34px ${LS_FONT}`;
    ctx.fillText("📌 포인트", X + 28, Y + 56);
    ctx.fillRect(X + 28, Y + 72, 60, 4);
  }
  let curPage = 0;
  tl.items.forEach((it) => { if (it.kind === "pad" && t >= it.t0) curPage = it.page; });
  let tip = null;
  tl.items.forEach((it) => {
    if (it.kind !== "pad" || it.page !== curPage || t < it.t0) return;
    const p = lsProg(it, t);
    const x = pen ? X + 74 : X + 28, base = TOP + it.row * ROW + ROW - (pen ? 12 : 16);
    // 손글씨 글꼴은 굵은 글씨가 없다 — bold로 쓰면 브라우저가 획을 번지게 그려 '흐'처럼 촘촘한 글자가 뭉개졌다(2026-11-20 사용자 화면).
    // 소제목은 굵게 대신 조금 크게 쓰고 아래에 밑줄을 긋는다
    ctx.font = pen ? (it.title ? `44px ${LS_PEN}` : `34px ${LS_PEN}`) : (it.title ? `800 30px ${LS_FONT}` : `500 27px ${LS_FONT}`);
    let text = it.text;
    const maxW = W - (x - X) - 20;
    // 길면 먼저 글씨를 줄여 본다(소제목 '목표 어법: 관계대명사 that'이 잘렸다) — 그래도 넘치면 그때 자른다
    for (let fs = parseInt(ctx.font.match(/(\d+)px/)[1], 10); fs > 24 && ctx.measureText(text).width > maxW; fs -= 2) {
      ctx.font = ctx.font.replace(/\d+px/, `${fs - 2}px`);
    }
    while (text.length > 2 && ctx.measureText(text).width > maxW) text = text.slice(0, -1);
    const tw = ctx.measureText(text).width;
    if (pen) {
      ctx.save();
      ctx.beginPath(); ctx.rect(x - 2, base - ROW, (tw + 6) * p, ROW + 14); ctx.clip();
      ctx.fillStyle = it.color; ctx.fillText(text, x, base);
      if (it.title) { ctx.fillStyle = "rgba(75,63,181,.55)"; ctx.fillRect(x, base + 7, tw, 3); }
      ctx.restore();
      if (p < 1) tip = [x + tw * p, base - 8];
    } else {
      ctx.globalAlpha = lsEase(p * 1.6);
      const dx = (1 - lsEase(p * 1.6)) * 24;
      if (it.title) {
        ctx.fillStyle = LS_ACCENT; ctx.fillText(text, x + dx, base);
      } else {
        ctx.fillStyle = it.color === "#1d2a6b" ? "#1f2937" : it.color;
        ctx.beginPath(); ctx.arc(x + 8 + dx, base - 9, 5, 0, Math.PI * 2); ctx.fill();
        ctx.fillText(text, x + 24 + dx, base);
      }
      ctx.globalAlpha = 1;
    }
  });
  return tip;
}

/* ── 판서(view "board") ──
   줄 머리로 종류를 알아 색을 나눈다 — 개념(남색) · 형태(초록, 공식이라 상자를 두른다) · 예문(파랑) · 주의(빨강) · 번호 목록 */
const LSB_PEN = { X: 140, TOP: 232, ROW: 100, ROWS: 7, FS: 54, TFS: 72 };
const LSB_SLIDE = { TOP: 226, ROW: 86, ROWS: 7, FS: 36, TFS: 54 };
const LSB_TYPES = [
  { re: /^개념\s*[:：]\s*/, label: "개념", color: "#1d2a6b" },
  { re: /^(공식|형태)\s*[:：]\s*/, label: "형태", color: "#169c5a" },
  { re: /^(예문|예)\s*[)）:：]\s*/, label: "예문", color: "#2f5bd3" },
  { re: /^주의\s*[:：!]\s*/, label: "주의", color: "#e0453a" },
];
function lsBoardType(txt) {
  for (const k of LSB_TYPES) {
    const m = k.re.exec(txt);
    if (m) return { text: txt, label: k.label, body: txt.slice(m[0].length), color: k.color };
  }
  const n = /^(\d+)\s*[.)]\s*/.exec(txt);
  if (n) return { text: txt, label: n[1], body: txt.slice(n[0].length), color: LS_ACCENT };
  // '- …' '· …' '→ …' 보충 줄 — 위 줄의 글과 같은 칸에서 시작하게 들여 쓴다(맨 왼쪽에 붙어 줄이 안 맞았다)
  const sub = /^\s*[-–·•→▶]\s*/.exec(txt);
  if (sub) return { text: txt, label: "", sub: true, body: txt.slice(sub[0].length), color: "#475569" };
  return { text: txt, label: "", body: txt, color: "#334155" };
}
// 판서 한 줄 → 화면 줄(1~2개). 정해진 글씨 크기로 칸을 넘으면 낱말 사이에서 둘로 나누고, 둘째 줄은 글 칸에 맞춰 들여 쓴다(cont)
function lsBoardRows(txt, pen) {
  const info = lsBoardType(txt);
  const ctx = lsCtx();
  let avail;
  if (pen) { ctx.font = `${LSB_PEN.FS}px ${LS_PEN}`; avail = 1200 - (info.sub ? 64 : 0); }
  else { ctx.font = `${info.label === "예문" ? "" : "600 "}${LSB_SLIDE.FS}px ${info.label === "예문" ? LS_EN_FONT : LS_FONT}`; avail = LSS.CARD[2] - 120 - (info.label || info.sub ? 120 : 0); }
  const shown = pen ? info.text : info.body;   // 필기형은 줄 머리(개념: …)까지 그대로 쓴다
  if (ctx.measureText(shown).width <= avail * 1.08) return [info];   // 조금 넘는 것은 글씨를 살짝 줄여 한 줄로
  const words = shown.split(" ");
  let a = "";
  while (words.length > 1 && ctx.measureText(a ? `${a} ${words[0]}` : words[0]).width <= avail) a = a ? `${a} ${words.shift()}` : words.shift();
  if (!a) a = words.shift();
  const b = words.join(" ");
  if (!b) return [info];
  const first = pen ? { ...info, text: a } : { ...info, body: a, text: info.text };
  return [first, { text: b, body: b, label: "", cont: true, sub: false, color: info.color }];
}
// 지금 화면에 보이는 판(시간 t) — 없으면 null
function lsBoardPageAt(tl, t) {
  let p = null;
  tl.boardPages.forEach((b) => { if (t >= b.t0) p = b; });
  return p;
}
// 지금 보는 곳(view)과 그 화면이 시작된 시각
function lsViewAt(tl, t) {
  let cur = tl.views[0] || { t: 0, view: "intro" };
  tl.views.forEach((v) => { if (t >= v.t) cur = v; });
  return cur;
}
function lsFitFont(ctx, font, size, text, maxW, min) {
  let fs = size;
  ctx.font = font.replace("{}", fs);
  while (fs > min && ctx.measureText(text).width > maxW) { fs -= 2; ctx.font = font.replace("{}", fs); }
  return fs;
}
// 필기형 판서 — 왼쪽 지문 칸(1400px) 위에 공책 한 장을 덮고 펜으로 쓴다. 펜 끝 자리를 돌려준다
function lsDrawBoardPen(ctx, tl, t, a) {
  const page = lsBoardPageAt(tl, t);
  if (!page) return null;
  const B = LSB_PEN;
  ctx.save();
  ctx.globalAlpha = a;
  ctx.fillStyle = "#e9ecf3"; ctx.fillRect(0, 0, 1400, LS_H);
  ctx.save();
  ctx.shadowColor = "rgba(30,40,80,.18)"; ctx.shadowBlur = 18; ctx.shadowOffsetY = 3;
  lsRound(ctx, 24, 24, 1352, LS_H - 48, 10); ctx.fillStyle = "#fffef7"; ctx.fill();
  ctx.restore();
  ctx.fillStyle = "#d7e1f2";
  for (let y = B.TOP + B.ROW - 2; y < LS_H - 30; y += B.ROW) ctx.fillRect(24, y, 1352, 2);
  ctx.fillStyle = "#f2b8b8"; ctx.fillRect(108, 24, 3, LS_H - 48);
  let tip = null;
  tl.items.forEach((it) => {
    if (it.page !== page.no || t < it.t0 || (it.kind !== "board" && it.kind !== "btitle")) return;
    const p = lsProg(it, t);
    const title = it.kind === "btitle";
    const x = B.X + (it.sub || it.cont ? 64 : 0), base = title ? 172 : B.TOP + it.row * B.ROW + B.ROW - 24;   // 보충 줄·이어진 줄은 들여 쓴다
    const fs = lsFitFont(ctx, `{}px ${LS_PEN}`, title ? B.TFS : B.FS, it.text, 1200, 30);
    const tw = ctx.measureText(it.text).width;
    ctx.save();
    ctx.beginPath(); ctx.rect(x - 4, base - fs * 1.1, (tw + 10) * p, fs * 1.6); ctx.clip();
    ctx.fillStyle = title ? "#1d2a6b" : it.color;
    ctx.fillText(it.text, x, base);
    if (title) { ctx.fillStyle = "rgba(75,63,181,.55)"; ctx.fillRect(x, base + 12, tw, 5); }
    ctx.restore();
    if (!title && it.label === "형태" && p >= 1) {   // 공식은 상자로 두른다
      ctx.strokeStyle = it.color; ctx.lineWidth = 3;
      lsRound(ctx, x - 14, base - fs * 0.95, tw + 28, fs * 1.3, 10); ctx.stroke();
    }
    if (p < 1) tip = [x + tw * p, base - fs * 0.2];
  });
  ctx.restore();
  return tip;
}
// 슬라이드형 판서 — 카드 안에 제목과 줄을 종류 이름표와 함께 하나씩 띄운다
function lsDrawBoardSlide(ctx, tl, t, cx, cy, cw) {
  const page = lsBoardPageAt(tl, t);
  if (!page) return;
  const B = LSB_SLIDE;
  tl.items.forEach((it) => {
    if (it.page !== page.no || t < it.t0 || (it.kind !== "board" && it.kind !== "btitle")) return;
    const p = lsEase(lsProg(it, t) * 2);
    const keep = ctx.globalAlpha;
    ctx.globalAlpha = keep * p;
    const dx = (1 - p) * 24;
    if (it.kind === "btitle") {
      lsFitFont(ctx, `800 {}px ${LS_FONT}`, B.TFS, it.text, cw - 120, 30);
      ctx.fillStyle = "#0f1e3d"; ctx.fillText(it.text, cx + 60 + dx, cy + 120);
      ctx.fillStyle = LS_ACCENT; ctx.fillRect(cx + 60, cy + 146, 90, 6);
    } else {
      const y = cy + B.TOP + it.row * B.ROW;
      if (it.label) {
        ctx.font = `800 24px ${LS_FONT}`;
        const lw = Math.max(76, ctx.measureText(it.label).width + 30);
        lsRound(ctx, cx + 60 + dx, y - 34, lw, 46, 23); ctx.fillStyle = it.color; ctx.fill();
        ctx.fillStyle = "#fff"; ctx.textAlign = "center"; ctx.fillText(it.label, cx + 60 + dx + lw / 2, y - 3); ctx.textAlign = "left";
      }
      const bx = cx + 60 + (it.label || it.sub || it.cont ? 120 : 0) + dx;
      if (it.sub) { ctx.fillStyle = "#94a3b8"; ctx.fillRect(bx - 30, y - 14, 14, 4); }   // 보충 줄 앞의 짧은 줄표
      lsFitFont(ctx, `${it.label === "예문" ? "" : "600 "}{}px ${it.label === "예문" ? LS_EN_FONT : LS_FONT}`, B.FS, it.body, cx + cw - 60 - bx, 22);
      ctx.fillStyle = it.label === "주의" ? "#b91c1c" : "#0f1e3d";
      ctx.fillText(it.body, bx, y);
      if (it.label === "형태") {
        const tw = ctx.measureText(it.body).width;
        ctx.strokeStyle = it.color; ctx.lineWidth = 3;
        lsRound(ctx, bx - 12, y - B.FS - 4, tw + 24, B.FS + 22, 10); ctx.stroke();
      }
    }
    ctx.globalAlpha = keep;
  });
}

/* ── 그리기: 필기형 ── */
function lsCamAt(cams, t) {
  let i = 0;
  while (i + 1 < cams.length && cams[i + 1].t <= t) i++;
  const c = cams[i], p = i > 0 ? cams[i - 1] : c;
  const k = Math.min(1, Math.max(0, (t - c.t) / 0.9)), e = k < 0.5 ? 2 * k * k : 1 - Math.pow(-2 * k + 2, 2) / 2;
  return { s: p.s + (c.s - p.s) * e, tx: p.tx + (c.tx - p.tx) * e, ty: p.ty + (c.ty - p.ty) * e };
}
function lsDrawPen(ctx, e, tl, as, t) {
  ctx.fillStyle = "#e9ecf3"; ctx.fillRect(0, 0, LS_W, LS_H);
  const lay = tl.lay;
  const cam = lsCamAt(tl.cams, t);
  ctx.save();
  ctx.beginPath(); ctx.rect(0, 0, 1400, LS_H); ctx.clip();
  ctx.translate(cam.tx, cam.ty); ctx.scale(cam.s, cam.s);
  const vy0 = -cam.ty / cam.s, vy1 = (LS_H - cam.ty) / cam.s;
  ctx.save();
  ctx.shadowColor = "rgba(30,40,80,.18)"; ctx.shadowBlur = 18; ctx.shadowOffsetY = 3;
  ctx.fillStyle = "#fff"; ctx.fillRect(0, 0, LSP.DW, lay.docH);
  ctx.restore();
  ctx.fillStyle = "#1d2a6b"; ctx.font = `800 40px ${LS_FONT}`;
  ctx.fillText(e.script.title || lsTagOf(e) || LESSON_NAME, LSP.X, 84);
  ctx.fillStyle = "#c7cfe6"; ctx.fillRect(LSP.X, 112, LSP.R - LSP.X, 3);
  lay.blocks.forEach((b) => {
    if (b.bot < vy0 - 40 || b.top > vy1 + 40) return;
    ctx.fillStyle = LS_ACCENT;
    ctx.beginPath(); ctx.arc(33, b.lines[0].base - 16, 20, 0, Math.PI * 2); ctx.fill();
    ctx.fillStyle = "#fff"; ctx.font = `700 22px ${LS_FONT}`; ctx.textAlign = "center";
    ctx.fillText(String(b.n), 33, b.lines[0].base - 8); ctx.textAlign = "left";
    ctx.fillStyle = "#16233f"; ctx.font = `${LSP.EN}px ${LS_EN_FONT}`;
    b.lines.forEach((l) => ctx.fillText(l.text, l.x, l.base));
    // 오른쪽 해석 칸 — 옅은 바탕에 왼쪽 세로줄(워크북 좌지문 우해석의 해석 칸과 같은 결)
    const ky = b.top + 30, kh = b.bot - b.top - 30;
    ctx.fillStyle = "#f3f2fb"; ctx.fillRect(LSP.KX - 22, ky, LSP.R - LSP.KX + 34, kh);
    ctx.fillStyle = "#c9c4ec"; ctx.fillRect(LSP.KX - 22, ky, 3, kh);
    ctx.fillStyle = "#4b5563"; ctx.font = `${LSP.KO}px ${LS_FONT}`;
    b.ko.forEach((k) => ctx.fillText(k.text, LSP.KX, k.base));
  });
  let tip = null;
  const sw = 3.2;
  tl.items.forEach((it) => {
    if (t < it.t0 || it.kind === "pad") return;
    const p = lsProg(it, t);
    if (it.kind === "mark") {
      const n = it.shapes.length;
      it.shapes.forEach((sh, j) => { const r = lsDrawPart(ctx, sh, p * n - j, it.color, sw); if (r) tip = r; });
    } else {
      ctx.save();
      ctx.beginPath(); ctx.rect(it.x - 3, it.y - 8, (it.w + 6) * p, it.h + 20); ctx.clip();
      ctx.font = `${LSP.NOTE}px ${LS_PEN}`; ctx.fillStyle = it.color;
      ctx.fillText(it.text, it.x, it.y + it.h * 0.86);
      ctx.restore();
      if (p < 1) tip = [it.x + it.w * p, it.y + it.h * 0.8];
    }
  });
  ctx.restore();
  if (tip) tip = [cam.tx + tip[0] * cam.s, cam.ty + tip[1] * cam.s];
  // 판서 중이면 지문 위에 공책 한 장을 덮는다(바뀔 때 0.35초 동안 서서히)
  const vw = lsViewAt(tl, t);
  if (vw.view === "board") tip = lsDrawBoardPen(ctx, tl, t, lsEase((t - vw.t) / 0.35));
  const padTip = lsDrawPad(ctx, tl, t, true);
  if (padTip) tip = padTip;
  // 머리표
  const tag = lsTagOf(e);
  if (tag) {
    ctx.font = `700 24px ${LS_FONT}`;
    lsRound(ctx, 1420, 16, 470, 46, 23); ctx.fillStyle = LS_ACCENT; ctx.fill();
    ctx.fillStyle = "#fff"; ctx.textAlign = "center"; ctx.textBaseline = "middle";
    let tg = tag; while (tg.length > 2 && ctx.measureText(tg).width > 430) tg = tg.slice(0, -1);
    ctx.fillText(tg, 1655, 40); ctx.textAlign = "left"; ctx.textBaseline = "alphabetic";
  }
  lsDrawBrand(ctx, as.brand, 1424, 1000, 462, 66, false);
  lsSubtitle(ctx, tl, t, 700, 1240, LS_H - 36);
  if (tip) lsDrawPenIcon(ctx, tip[0], tip[1]);
  ctx.fillStyle = LS_ACCENT; ctx.fillRect(0, LS_H - 6, LS_W * Math.min(t / tl.total, 1), 6);
}

/* ── 그리기: 슬라이드형 ── */
function lsDrawSlide(ctx, e, tl, as, t) {
  const g = ctx.createLinearGradient(0, 0, LS_W, LS_H);
  g.addColorStop(0, "#132a5c"); g.addColorStop(1, "#0b1733");
  ctx.fillStyle = g; ctx.fillRect(0, 0, LS_W, LS_H);
  ctx.fillStyle = "rgba(255,255,255,.04)";
  ctx.beginPath(); ctx.arc(1780, 120, 260, 0, Math.PI * 2); ctx.fill();
  const cur = lsViewAt(tl, t);
  const a = tl.views[0] === cur ? 1 : lsEase((t - cur.t) / 0.35);
  const [cx, cy, cw, ch] = LSS.CARD;
  ctx.save();
  ctx.shadowColor = "rgba(0,0,0,.35)"; ctx.shadowBlur = 40; ctx.shadowOffsetY = 10;
  lsRound(ctx, cx, cy, cw, ch, 28); ctx.fillStyle = "#fff"; ctx.fill();
  ctx.restore();
  ctx.save();
  ctx.globalAlpha = a;
  ctx.translate(0, (1 - a) * 18);
  const m = /^s(\d+)$/.exec(cur.view);
  const N = e.script.sentences.length;
  const tag = lsTagOf(e);
  ctx.textBaseline = "alphabetic";
  if (m) {
    const b = tl.lay.blocks[+m[1] - 1];
    ctx.font = `800 26px ${LS_FONT}`;
    const chip = `문장 ${b.n} / ${N}`;
    const w = ctx.measureText(chip).width + 40;
    lsRound(ctx, cx + 40, cy + 34, w, 46, 23); ctx.fillStyle = LS_ACCENT; ctx.fill();
    ctx.fillStyle = "#fff"; ctx.fillText(chip, cx + 60, cy + 66);
    if (tag) { ctx.fillStyle = "#94a3b8"; ctx.font = `600 24px ${LS_FONT}`; ctx.textAlign = "right"; ctx.fillText(tag, cx + cw - 40, cy + 66); ctx.textAlign = "left"; }
    ctx.fillStyle = "#0f1e3d"; ctx.font = `${b.size}px ${LS_EN_FONT}`;
    // 형광은 글자 밑에(곱하기라 위에 칠해도 된다)
    b.lines.forEach((l) => ctx.fillText(l.text, l.x, l.base));
    ctx.fillStyle = "#475569"; ctx.font = `${LSS.KO}px ${LS_FONT}`; ctx.textAlign = "center";
    b.ko.forEach((k) => ctx.fillText(k.text, LSS.CX, k.base));
    ctx.textAlign = "left";
    tl.items.forEach((it) => {
      if (it.n !== b.n || t < it.t0) return;
      const p = lsProg(it, t);
      if (it.kind === "mark") {
        const n = it.shapes.length;
        it.shapes.forEach((sh, j) => lsDrawPart(ctx, sh, p * n - j, it.color, 5));
      } else if (it.kind === "note") {
        ctx.globalAlpha = a * lsEase(p * 1.5);
        lsRound(ctx, it.x, it.y, it.w, it.h, 20); ctx.fillStyle = it.color; ctx.fill();
        ctx.fillStyle = "#fff"; ctx.font = `700 28px ${LS_FONT}`; ctx.textAlign = "center"; ctx.textBaseline = "middle";
        ctx.fillText(it.text, it.x + it.w / 2, it.y + it.h / 2 + 1);
        ctx.textAlign = "left"; ctx.textBaseline = "alphabetic";
        ctx.globalAlpha = a;
      }
    });
  } else if (cur.view === "board") {
    lsDrawBoardSlide(ctx, tl, t, cx, cy, cw);
  } else {
    const end = cur.view === "end";
    ctx.textAlign = "center";
    ctx.fillStyle = LS_ACCENT; ctx.font = `800 30px ${LS_FONT}`;
    ctx.fillText(end ? "오늘의 정리" : (tag || "지문 강의"), LSS.CX, cy + 150);
    ctx.fillStyle = "#0f1e3d";
    let fs = 70;
    ctx.font = `800 ${fs}px ${LS_FONT}`;
    const title = e.script.title || LESSON_NAME;
    while (fs > 40 && ctx.measureText(title).width > cw - 120) { fs -= 4; ctx.font = `800 ${fs}px ${LS_FONT}`; }
    ctx.fillText(title, LSS.CX, cy + 250);
    ctx.fillStyle = "#e2e8f0"; ctx.fillRect(LSS.CX - 60, cy + 290, 120, 5);
    if (end) {
      ctx.fillStyle = "#334155"; ctx.font = `700 44px ${LS_FONT}`;
      ctx.fillText("수고했어요! 👏", LSS.CX, cy + 420);
    } else {
      // 지문 미리 보기 — 문장 번호를 붙여 작게
      ctx.font = `24px ${LS_EN_FONT}`;
      const txt = e.script.sentences.map((s) => `(${s.n}) ${s.en}`).join("  ");
      const lines = lsWrap(ctx, txt, cw - 160);
      ctx.fillStyle = "#475569";
      lines.slice(0, 13).forEach((l, i) => {
        if (i === 12 && lines.length > 13) ctx.globalAlpha = a * 0.35;
        ctx.fillText(l, LSS.CX, cy + 360 + i * 36);
      });
      ctx.globalAlpha = a;
    }
    ctx.textAlign = "left";
  }
  ctx.restore();
  lsDrawPad(ctx, tl, t, false);
  lsDrawBrand(ctx, as.brand, 1384, 920, 492, 70, true);
  lsSubtitle(ctx, tl, t, 700, 1240, LS_H - 30);
  ctx.fillStyle = "#ffd23f"; ctx.fillRect(0, LS_H - 6, LS_W * Math.min(t / tl.total, 1), 6);
}
function lsDraw(ctx, e, tl, as, t) {
  ctx.textAlign = "left"; ctx.textBaseline = "alphabetic"; ctx.globalAlpha = 1;
  if (tl.look === "pen") lsDrawPen(ctx, e, tl, as, t); else lsDrawSlide(ctx, e, tl, as, t);
}
function lsLoadImg(src) {
  return new Promise((res) => { if (!src) return res(null); const im = new Image(); im.onload = () => res(im); im.onerror = () => res(null); im.src = src; });
}
async function lsAssets() {
  const b = lsBrand();
  return { brand: b ? { name: b.name, logo: await lsLoadImg(b.img) } : null };
}

/* ── 미리 보기(재생) ── */
let lsPlaying = null;
function lsPlay(e, canvas, onEnd) {
  const ctl = { stop: () => { ctl.cancelled = true; } };
  (async () => {
    await lsFontReady();
    const tl = lsTimeline(e);
    const as = await lsAssets();
    if (ctl.cancelled) { if (onEnd) onEnd(); return; }
    const ctx = canvas.getContext("2d");
    const els = e.audio.map((a) => { const el = new Audio(a.url); el.preservesPitch = true; el.playbackRate = lsSpeedOf(e); return el; });
    const started = new Set();
    const t0 = performance.now();
    let raf = 0, done = false;
    const finish = () => { if (done) return; done = true; cancelAnimationFrame(raf); els.forEach((el) => el.pause()); if (onEnd) onEnd(); };
    ctl.stop = finish;
    const frame = () => {
      if (done) return;
      const t = (performance.now() - t0) / 1000;
      lsDraw(ctx, e, tl, as, Math.min(t, tl.total));
      tl.segs.forEach((g) => { if (!started.has(g.k) && t >= g.start) { started.add(g.k); els[g.k].play().catch(() => {}); } });
      if (t >= tl.total) { finish(); return; }
      raf = requestAnimationFrame(frame);
    };
    raf = requestAnimationFrame(frame);
  })().catch((err) => { if (onEnd) onEnd(err); });
  return ctl;
}
async function lsPoster(e, canvas) {
  if (!e.script) return;
  await lsFontReady();
  const tl = lsTimeline(e);
  const t = (tl.segs.find((g) => /^s\d+$/.test(g.view)) || tl.segs[0]).start + 4;   // 첫 문장 설명 중 한 장면
  lsDraw(canvas.getContext("2d"), e, tl, await lsAssets(), Math.min(t, tl.total));
}

/* ── 영상 파일(mp4) — 다 만든 것은 뒤에서 하나씩 만든다. 빠르기·모양·표·학원 마크가 바뀌면 다시 ── */
const lsReady = (e) => !!(e && e.script && e.audio && e.audio.length === e.script.segments.length && e.audio.every(Boolean));
const lsVidSig = (e) => `${lsLookOf(e)}|${lsSpeedOf(e)}|${lsTagOf(e)}|${e.audio.map((a) => a.url).join(",")}|${lsBrandKey()}`;
const lsVidOk = (e) => !!(e.video && lsReady(e) && e.video.sig === lsVidSig(e));
let lsMp4Ok = null, lsRecQueue = [], lsRecNow = null, lsRecWaiters = [], lsRecNote = null;
function lsDropVideo(e) { if (e.video && e.video.url) URL.revokeObjectURL(e.video.url); e.video = null; }
function lsQueueRecord(e) {
  if (!lsReady(e) || lsVidOk(e) || lsRecQueue.includes(e)) return;
  // 같은 모양으로 이미 실패했으면 다시 줄 세우지 않는다(실패 → 다시 그리기 → 다시 줄 세우기가 끝없이 돌았다)
  if (e.vidError && e.vidErrSig === lsVidSig(e)) return;
  if (lsRecNow && lsRecNow.e === e && lsRecNow.sig === lsVidSig(e)) return;
  if (lsRecNow && lsRecNow.e === e) lsRecNow.ctl.stop();
  lsDropVideo(e);
  lsRecQueue.push(e);
  lsRecPump();
}
function lsRecAbortAll() {
  lsRecQueue = [];
  if (lsRecNow) lsRecNow.ctl.stop();
  else { const w = lsRecWaiters; lsRecWaiters = []; w.forEach((f) => f()); }
}
const lsRecIdle = () => (!lsRecNow && !lsRecQueue.length) ? Promise.resolve() : new Promise((res) => lsRecWaiters.push(res));
function lsCardOf(e) { const i = lsState.entries.indexOf(e); return i >= 0 ? lsEl("lsResult").querySelector(`.ls-card[data-i="${i}"]`) : null; }
async function lsRecPump() {
  if (lsRecNow || !lsRecQueue.length) return;
  const e = lsRecQueue.shift();
  if (!lsState.entries.includes(e) || !lsReady(e) || lsVidOk(e)) { lsRecPump(); return; }
  const sig = lsVidSig(e);
  lsRecNow = { e, ctl: { stop: () => {} }, sig };
  if (lsMp4Ok === null) lsMp4Ok = typeof rlmSupported === "function" ? await rlmSupported(LS_W, LS_H) : false;
  if (!lsMp4Ok) {
    e.vidError = "이 브라우저는 영상 파일 만들기를 지원하지 않습니다 — PC 크롬에서 열어 주세요(미리 보기는 됩니다).";
  } else {
    await lsFontReady();
    const show = (p) => {
      if (lsRecNote) lsRecNote(e, p);
      const b = lsCardOf(e) && lsCardOf(e).querySelector(".ls-dl");
      if (b && !lsVidOk(e)) b.textContent = `🎞️ 영상 파일 만드는 중 ${Math.round(p * 100)}%`;
    };
    // 수업 영상은 화면이 거의 멈춰 있어 숏폼(8Mbps)보다 낮은 목표로도 글씨가 깨끗하다 — 긴 영상(20분 넘게)의 파일·메모리를 줄인다
    const ctl = rlEncodeMp4(e, { onProgress: show, w: LS_W, h: LS_H, timeline: lsTimeline, load: lsAssets, draw: lsDraw, bitrate: LS_VBITRATE });
    lsRecNow.ctl = ctl;
    try {
      const { blob } = await ctl.done;
      if (blob && blob.size && lsState.entries.includes(e) && lsVidSig(e) === sig) {
        lsDropVideo(e);
        e.video = { blob, url: URL.createObjectURL(blob), sig };
        e.vidError = "";
      }
    } catch (err) { e.vidError = err.message || String(err); }
  }
  if (e.vidError) e.vidErrSig = sig;
  lsRecNow = null;
  const btn = lsCardOf(e) && lsCardOf(e).querySelector(".ls-dl");
  if (btn && lsVidOk(e)) {
    btn.disabled = false; btn.textContent = `⬇ 영상 받기 (mp4, ${(e.video.blob.size / 1e6).toFixed(0)}MB)`;
    const ab = lsCardOf(e).querySelector(".ls-assign"); if (ab) ab.disabled = false;
  }
  else if (lsState.entries.includes(e)) lsRender();
  if (!lsRecQueue.length) { const w = lsRecWaiters; lsRecWaiters = []; w.forEach((f) => f()); }
  lsRecPump();
}
function lsDownload(e) {
  const a = document.createElement("a");
  a.href = e.video.url;
  a.download = `${sanitizeFilename(["지문강의", e.name, e.script.title].filter(Boolean).join("_"))}.mp4`;
  document.body.appendChild(a); a.click(); a.remove();
}
function lsFullscreen(e, card) {
  if (lsVidOk(e)) {
    const v = document.createElement("video");
    v.className = "rl-fullvideo";
    v.src = e.video.url; v.controls = true; v.playsInline = true;
    document.body.appendChild(v);
    const drop = () => { v.pause(); v.remove(); document.removeEventListener("fullscreenchange", done); };
    const done = () => { if (!document.fullscreenElement) drop(); };
    document.addEventListener("fullscreenchange", done);
    if (!v.requestFullscreen && v.webkitEnterFullscreen) { v.addEventListener("webkitendfullscreen", drop, { once: true }); v.play().then(() => v.webkitEnterFullscreen()).catch(drop); return; }
    (v.requestFullscreen ? v.requestFullscreen() : Promise.reject()).then(() => v.play().catch(() => {}), drop);
    return;
  }
  const stage = card.querySelector(".ls-stage");
  if (!stage || !stage.requestFullscreen) return;
  stage.requestFullscreen().then(() => {
    const play = card.querySelector(".ls-play");
    if (play && !play.disabled) play.click();
    const out = () => { if (!document.fullscreenElement) { if (lsPlaying) lsPlaying.stop(); document.removeEventListener("fullscreenchange", out); } };
    document.addEventListener("fullscreenchange", out);
  }).catch(() => {});
}

/* ── 결과 카드 ── */
const lsViewName = (v) => (v === "intro" ? "도입·정리" : v === "end" ? "마무리" : v === "board" ? "판서" : `${v.slice(1)}번 문장`);
function lsCardHtml(e, i) {
  if (e.error && !e.script) return `<section class="ls-card" data-i="${i}"><div class="passage-error">⚠️ ${esc(e.name)} — ${esc(e.error)}</div></section>`;
  const segs = e.script.segments;
  const ready = lsReady(e);
  const missing = segs.length - (e.audio || []).filter(Boolean).length;
  const secs = ready ? lsTimeline(e).total : 0;
  return `<section class="ls-card" data-i="${i}">
    <h3 class="rl-title">🎓 ${esc(e.script.title || e.name)} <span class="rl-sub">${esc(e.name)} · 문장 ${e.script.sentences.length}개 · 대사 ${segs.length}줄 · 목소리 ${esc(e.voice)}${ready ? ` · ${Math.floor(secs / 60)}분 ${Math.round(secs % 60)}초` : ""}${(e.script.targets || []).length ? ` · 🎯 ${esc(e.script.targets.join(", "))}` : ""}</span></h3>
    ${e.error ? `<div class="passage-error">⚠️ ${esc(e.error)}</div>` : ""}
    ${e.vidError ? `<div class="passage-error">⚠️ 영상 파일을 만들지 못했습니다 — ${esc(e.vidError)}</div>` : ""}
    <div class="ls-stage"><canvas class="ls-canvas" width="${LS_W}" height="${LS_H}"></canvas></div>
    <div class="actions">
      <button type="button" class="btn ghost ls-play"${ready ? "" : " disabled"}>▶ 미리 보기</button>
      <button type="button" class="btn ghost ls-stop" hidden>■ 멈추기</button>
      <button type="button" class="btn ghost ls-full"${ready ? "" : " disabled"} title="영상 파일이 준비됐으면 그 파일을 재생기로(초 이동 가능), 아직이면 미리 보기를 전체 화면으로 엽니다. Esc로 나옵니다.">⛶ 전체 화면</button>
      <button type="button" class="btn ls-dl"${lsVidOk(e) ? "" : " disabled"}>${lsVidOk(e) ? `⬇ 영상 받기 (mp4, ${(e.video.blob.size / 1e6).toFixed(0)}MB)` : ready ? "🎞️ 영상 파일 기다리는 중…" : "⬇ 영상 받기"}</button>
      <button type="button" class="btn ls-assign"${lsVidOk(e) ? "" : " disabled"} title="영상 파일이 준비되면 반·학생에게 과제로 냅니다. 학생은 건너뛰지 못하고 끝까지 봐야 하며, 확인 문제를 붙일 수 있습니다.">🏫 반에 과제 부여</button>
      ${missing ? `<button type="button" class="btn ghost ls-voice-redo">🔁 빠진 목소리 ${missing}줄 만들기</button>` : ""}
    </div>
    <div class="actions ls-opts">
      <label class="rl-speed-card">화면 모양 <select class="ls-look-sel">${LS_LOOKS.map((l) => `<option value="${l.id}"${l.id === lsLookOf(e) ? " selected" : ""}>${l.label}</option>`).join("")}</select></label>
      <label class="rl-speed-card">빠르기 <input type="range" class="ls-speed-sel" min="0.7" max="1.5" step="0.05" value="${lsSpeedOf(e)}"><b class="rl-speed-val">${lsSpeedText(lsSpeedOf(e))}</b></label>
      <label class="rl-tag-card" title="오른쪽 위 머리표(필기형)·카드 위 글(슬라이드형). 비우면 넣지 않습니다(값 없음)">머리표 <input type="text" class="rl-tag-in ls-tag-in" maxlength="30" value="${esc(lsTagOf(e))}" placeholder="비우면 표 없음"></label>
    </div>
    <div class="hint ls-status"></div>
    <details class="ls-script"><summary>📜 대본 보기 (대사 ${segs.length}줄)</summary><ol>${segs.map((g, k) =>
      `<li${e.audio && e.audio[k] ? "" : ' class="ls-nov"'}><small>${lsViewName(g.view)}</small> ${esc(g.say)}${g.marks.length ? ` <small class="ls-marks">✏️ ${g.marks.map((m) => esc(m.target) + (m.note ? `(${esc(m.note)})` : "")).join(", ")}</small>` : ""}${
        (g.board || []).length || g.board_title ? ` <small class="ls-marks">🖊️ ${[g.board_title ? `[${g.board_title}]` : "", ...(g.board || [])].filter(Boolean).map(esc).join(" / ")}</small>` : ""}</li>`).join("")}</ol></details>
  </section>`;
}
function lsRender() {
  const box = lsEl("lsResult");
  box.innerHTML = lsState.entries.map(lsCardHtml).join("");
  box.querySelectorAll(".ls-card").forEach((card) => {
    const e = lsState.entries[+card.dataset.i];
    const cv = card.querySelector(".ls-canvas");
    if (cv && e.script) lsPoster(e, cv);
  });
  lsState.entries.forEach(lsQueueRecord);
  const has = lsState.entries.some((e) => e.script);
  lsEl("lsSaveBtn").style.display = has ? "" : "none";
  lsEl("lsSaveNote").hidden = !has;
}

/* ── 서버 부르기 ── */
const lsRetryNote = (el) => (n) => { el.textContent = `연결이 끊겨 다시 받아 오는 중… (${n})`; };
// 빠진 줄만 LS_VOICE_BATCH줄씩 만든다. 할당량·잔액 부족이면 바로 멈추고, 그 밖의 실패는 그 묶음만 비워 둔다
async function lsMakeVoice(e, note, onStep) {
  const segs = e.script.segments;
  if (!e.audio) e.audio = segs.map(() => null);
  const todo = segs.map((_, k) => k).filter((k) => !e.audio[k]);
  const batches = [];
  for (let i = 0; i < todo.length; i += LS_VOICE_BATCH) batches.push({ ks: todo.slice(i, i + LS_VOICE_BATCH) });
  let stop = null, done = 0;
  await runPool(batches, LS_VOICE_PARALLEL, async ({ ks }) => {
    if (stop) return;
    try {
      const d = await postGenerate("/api/lessonvoice", { lines: ks.map((k) => segs[k].say), voice: e.voice }, "목소리를 만들지 못했습니다.", note);
      d.lines.forEach((l, j) => {
        const y = rlCleanPcm(rlPcmFromB64(l.pcm), l.rate);
        e.audio[ks[j]] = { url: lsBlob(URL.createObjectURL(rlWavBlob(y, l.rate))), raw: y.length / l.rate, blob: null };
      });
    } catch (err) {
      if (err.code === "quota" || err.code === "no_tokens") stop = err;
      else e.error = err.message || String(err);
    }
    done += ks.length;
    if (onStep) onStep(done, todo.length);
  });
  if (stop) throw stop;
  if (e.audio.every(Boolean)) e.error = "";
}

/* ── 지문이 여러 개일 때: 어떤 지문끼리 합쳐 한 편으로 만들지 선생님이 고른다(2026-11-20 사용자) ──
   창은 숏폼과 같은 reels.js rlAskGroups. 한 편의 문장은 서버 LESSON_SENT_MAX(30)개까지라 넘는 묶음은 빨갛게 알리고 막는다. */
const LS_SENT_MAX = 50;   // 서버 LESSON_SENT_MAX와 같다 — 대본은 서버가 10문장씩 나눠 만들고, 이 한도는 영상 파일 크기(브라우저 메모리) 때문
const lsAskGroups = (all) => rlAskGroups(all, { max: LS_MAX_PASSAGES, sentMax: LS_SENT_MAX, totalMax: LS_TOTAL_SENT_MAX, icon: "🎓",
  cost: (t) => (lsPrice() ? lsEstCost(t, Math.max(1, String(t).split(/\n\n/).length)) : null) });

/* 상세분석(/api/analyze 결과) → 대본 요청에 실을 만큼만(2026-11-21 사용자 — 상세분석을 돌려 그 해설로 대본을 쓴다).
   묶음이면 지문마다 분석한 것을 차례로 잇는다. 문장 글 = 덩어리(chunks)를 이은 것 — 화면 왼쪽 영어 칸에 그대로 나온다 */
/* 서버가 돌려주는 덩어리는 평문 text가 아니라 조립된 HTML eng다 — 문법 표시는 <ruby><span>낱말</span><rt>문법 이름</rt></ruby>,
   병렬 번호는 <sup>. 글자만 꺼낼 때 rt·sup을 빼야 한다(처음엔 c.text를 읽어 문장이 비었고 서버가 분석을 버렸다 — 2026-11-21 실서비스) */
function lsHtmlDiv(h) { const d = document.createElement("div"); d.innerHTML = String(h || ""); return d; }
function lsPlainEn(h) { const d = lsHtmlDiv(h); d.querySelectorAll("rt,rp,sup").forEach((x) => x.remove()); return d.textContent; }
function lsAnnsOf(h) {
  return [...lsHtmlDiv(h).querySelectorAll("ruby")].map((r) => {
    const rt = r.querySelector("rt"), c = r.cloneNode(true);
    c.querySelectorAll("rt,rp,sup").forEach((x) => x.remove());
    return { t: c.textContent.trim(), rt: rt ? rt.textContent.trim() : "" };
  }).filter((a) => a.t && a.rt);
}
function lsAnalysisOf(list) {
  const sentences = [], stages = [];
  let oneLine = "";
  list.forEach((d) => {
    (d.sentences || []).forEach((st) => {
      const ch = Array.isArray(st.chunks) ? st.chunks : [];
      sentences.push({
        en: ch.map((c) => c.text || lsPlainEn(c.eng)).join(" ").replace(/\s+/g, " ").trim(),
        ko: ch.map((c) => lsHtmlDiv(c.kor).textContent).join(" ").replace(/\s+/g, " ").trim(),
        tag: st.tag || "", note: st.note || "", isTopic: !!st.isTopic,
        examTags: st.examTags || [], examNote: st.examNote || "",
        anns: ch.flatMap((c) => (c.anns || []).map((a) => ({ t: a.t || "", rt: a.rt || "" })).concat(c.eng ? lsAnnsOf(c.eng) : [])).slice(0, 12),
      });
    });
    const ol = d.outline || {};
    if (ol.oneLine) oneLine = oneLine ? `${oneLine} / ${ol.oneLine}` : ol.oneLine;
    (ol.stages || []).forEach((x) => stages.push({ name: x.name || "", range: x.range || "", role: x.role || "" }));
  });
  return { sentences, outline: { oneLine, stages: stages.slice(0, 6) } };
}

async function lsMake() {
  const errEl = lsEl("lsError");
  errEl.textContent = "";
  const all = passageMgr.getJobs().filter((j) => j.text && j.text.length >= 20);
  if (!all.length) { errEl.textContent = "위쪽 영어 지문 칸에 지문을 넣어 주세요 (20자 이상)."; return; }
  let jobs = all;
  if (all.length > 1) {
    const gs = await lsAskGroups(all);
    if (!gs) return;
    // 한 편 = 묶음 하나. 목소리는 묶음 첫 지문에 정해 둔 것(영상마다 목소리)을 따른다
    jobs = gs.map((g) => ({ name: g.name, text: g.text, voiceKey: g.jobs[0], parts: g.jobs.map((x) => x.text) }));
  }
  const voices = jobs.map((j, i) => lsVoiceFor(j.voiceKey || j, i));
  if (!voices[0]) { errEl.textContent = "목소리를 하나 이상 골라 주세요."; return; }
  const est = lsPrice() ? jobs.reduce((s, j) => s + lsEstCost(j.text, (j.parts || [j.text]).length), 0) : null;
  if (!(await costConfirmed(est, `${LESSON_NAME} · 지문 ${jobs.length}개 · 목소리 ${[...new Set(voices)].join(", ")}`, jobs.length, reduceAdvice(jobs.length, "")))) return;
  if (typeof dropStaleSavedLink === "function") dropStaleSavedLink("lesson");
  if (lsPlaying) lsPlaying.stop();
  lsRecAbortAll();
  lsState.entries.forEach(lsDropVideo);
  lsState.busy = true;
  lsEl("lsMakeBtn").disabled = true;
  const loading = lsEl("lsLoading"), text = lsEl("lsLoadingText");
  const gate = runGate(loading);
  gate.begin();
  loading.classList.add("on");
  lsDropBlobs();
  lsState.entries = [];
  lsRender();
  const note = lsRetryNote(text);
  let ok = 0;
  try {
    lsFontReady();   // 글꼴은 대본을 기다리는 동안 미리 받는다
    for (let i = 0; i < jobs.length; i++) {
      if (i && await gate.check(`지문 ${i}개까지 만들었습니다.`, lsRender)) { errEl.textContent = runEndedNote(jobs.length - i, "지문"); break; }
      const j = jobs[i];
      const voice = voices[i];
      const e = { name: j.name, text: j.text, voice, speed: lsSpeedPick(), look: lsLookPick(), tag: j.name, script: null, audio: null };
      lsState.entries.push(e);
      try {
        // ① 상세분석 — 대본의 근거(문장별 문법 해설·시험 포인트). 묶음이면 지문마다
        const parts = j.parts || [j.text], anas = [];
        for (let k = 0; k < parts.length; k++) {
          text.textContent = `AI가 ${j.name}을(를) 상세분석하고 있습니다…${parts.length > 1 ? ` ${k + 1}/${parts.length}` : ""} (${i + 1}/${jobs.length})`;
          anas.push(await postGenerate("/api/analyze", { passage: parts[k], targetGrammar: lsTargets().join(", "), purpose: "lesson" }, "상세분석을 하지 못했습니다.", note));
        }
        // ② 대본 — 분석을 근거로
        text.textContent = `AI가 ${j.name}의 수업 대본을 쓰고 있습니다… (${i + 1}/${jobs.length})`;
        const d = await postGenerate("/api/lessonscript", { passage: j.text, targetGrammar: lsTargets().join(", "), analysis: lsAnalysisOf(anas) }, "영상 대본을 만들지 못했습니다.", note);
        e.script = d.script;
        lsRender();
        const n = e.script.segments.length;
        text.textContent = `${voice} 목소리로 대사 ${n}줄을 녹음하고 있습니다… (${i + 1}/${jobs.length})`;
        await lsMakeVoice(e, note, (k, m) => { text.textContent = `${voice} 목소리로 녹음하고 있습니다… ${k}/${m}줄 (${i + 1}/${jobs.length})`; });
        ok++;
      } catch (err) {
        e.error = err.message || String(err);
        if (err.code === "quota" || err.code === "no_tokens") { errEl.textContent = err.message; lsRender(); break; }
      }
      lsRender();
    }
    if (ok) {
      const made = lsState.entries.filter(lsReady);
      lsRecNote = (e, pct) => {
        const n = made.indexOf(e);
        if (n >= 0) text.textContent = `🎞️ 영상 파일을 만들고 있습니다… ${made.length > 1 ? `(${n + 1}/${made.length}) ` : ""}${Math.round(pct * 100)}% — 이 창은 그대로 두세요`;
      };
      text.textContent = "🎞️ 영상 파일을 만들고 있습니다…";
      lsRender();
      await lsRecIdle();
      const got = lsState.entries.filter(lsVidOk).length;
      if (got) lsEl("lsError").textContent = `✅ 영상 ${got}편이 준비됐습니다 — 카드의 [⬇ 영상 받기]로 받으세요. 영상 파일은 사이트에 저장되지 않습니다.`;
    }
  } finally {
    lsRecNote = null;
    lsState.busy = false;
    lsEl("lsMakeBtn").disabled = false;
    loading.classList.remove("on");
    refreshTokenDisplay();
  }
}
lsEl("lsMakeBtn").addEventListener("click", () => { if (!lsState.busy) lsMake(); });

lsEl("lsResult").addEventListener("input", (ev) => {
  const r = ev.target.closest(".ls-speed-sel");
  if (r) r.nextElementSibling.textContent = lsSpeedText(r.value);
});
lsEl("lsResult").addEventListener("change", (ev) => {
  const card = ev.target.closest(".ls-card");
  if (!card) return;
  const e = lsState.entries[+card.dataset.i];
  if (ev.target.closest(".ls-look-sel")) e.look = ev.target.value;
  else if (ev.target.closest(".ls-speed-sel")) e.speed = +ev.target.value;
  else if (ev.target.closest(".ls-tag-in")) e.tag = ev.target.value.trim().slice(0, 30);
  else return;
  if (lsPlaying) lsPlaying.stop();
  lsRender();   // 값 없이 다시 그리고, 영상 파일은 뒤에서 다시 만든다
});
lsEl("lsResult").addEventListener("click", async (ev) => {
  const card = ev.target.closest(".ls-card");
  if (!card) return;
  const e = lsState.entries[+card.dataset.i];
  const status = card.querySelector(".ls-status");
  const playB = card.querySelector(".ls-play"), stopB = card.querySelector(".ls-stop");
  const busy = (on) => { if (playB) playB.disabled = on; if (stopB) stopB.hidden = !on; };
  if (ev.target.closest(".ls-stop")) { if (lsPlaying) lsPlaying.stop(); return; }
  if (ev.target.closest(".ls-play")) {
    if (lsPlaying) lsPlaying.stop();
    busy(true);
    status.textContent = "재생 중…";
    const ctl = lsPlay(e, card.querySelector(".ls-canvas"), (err) => { busy(false); status.textContent = err ? "⚠️ " + (err.message || err) : ""; if (lsPlaying === ctl) lsPlaying = null; });
    lsPlaying = ctl;
    return;
  }
  if (ev.target.closest(".ls-full")) { if (lsPlaying) lsPlaying.stop(); lsPlaying = null; lsFullscreen(e, card); return; }
  if (ev.target.closest(".ls-dl")) { if (lsVidOk(e)) { lsDownload(e); status.textContent = "✅ 내려받았습니다(mp4)."; } return; }
  if (ev.target.closest(".ls-assign")) { if (lsVidOk(e)) vaOpen(e); return; }
  if (ev.target.closest(".ls-voice-redo")) {
    if (lsState.busy) return;
    const n = e.script.segments.length - (e.audio || []).filter(Boolean).length;
    const p = lsPrice();
    if (!(await costConfirmed(p ? p.lessonVoiceLine * n : null, `${LESSON_NAME} · 목소리 ${n}줄`, 1, ""))) return;
    lsState.busy = true;
    status.textContent = "목소리를 만들고 있습니다…";
    try { await lsMakeVoice(e, lsRetryNote(status)); } catch (err) { e.error = err.message || String(err); }
    lsState.busy = false;
    refreshTokenDisplay();
    lsRender();
  }
});

/* ── 저장 ── */
const lsWavKey = (ei, k) => `e${ei}a${k}`;
// 저장본 문서 하나는 약 1MB(base64)까지라 목소리는 15초쯤이 한계다 — 수업 대사는 그보다 긴 줄이 있어 '그림이 너무 커서'로
// 저장이 막혔다(2026-11-20 사용자). 긴 줄은 LS_WAV_PART_SEC초씩 잘라 조각마다 온전한 wav로 담고(키 e0a5p0, e0a5p1…),
// 불러올 때 이어 붙인다. 음질은 그대로다
const LS_WAV_PART_SEC = 12;
const lsWavParts = (raw) => Math.max(1, Math.ceil((raw || 0) / LS_WAV_PART_SEC - 0.02));
const LS_WAV_KEY_RE = /^e(\d+)a(\d+)(?:p(\d+))?$/;
const lsSavedSrc = new Map();
lsEl("lsSaveBtn").addEventListener("click", () => openSaveDialog("lesson"));
lsEl("lsLoadBtn").addEventListener("click", () => openSavedList("tab", null, "lesson"));
TAB_LABELS.lesson = "🎓 " + LESSON_NAME;
TAB_LIBRARY_WORDS.lesson = {
  title: `🎓 ${LESSON_NAME} 저장함`,
  lead: "저장해 둔 지문 강의 영상의 대본·목소리입니다(영상 파일은 저장되지 않습니다). [불러오기]를 누르면 AI를 다시 부르지 않고 영상을 다시 만들어 받을 수 있습니다.",
  empty: "아직 저장한 지문 강의 영상이 없습니다. 만든 뒤 “💾 사이트 저장”을 눌러 보세요.",
};
SAVE_TITLE_SUGGEST.lesson = () => passageBasedName("지문 강의 영상");
function lsPayloadOf(saved, passages) {
  const images = [];
  saved.forEach((e, ei) => (e.audio || []).forEach((a, k) => {
    if (!a) return;
    const n = lsWavParts(a.raw);
    if (n === 1) images.push({ entry: ei, lang: "wav", key: lsWavKey(ei, k) });
    else for (let p = 0; p < n; p++) images.push({ entry: ei, lang: "wav", key: `${lsWavKey(ei, k)}p${p}` });
  }));
  return {
    v: 1,
    passages,
    entries: saved.map((e) => ({ name: e.name, text: e.text, voice: e.voice, tag: e.tag, script: e.script, speed: lsSpeedOf(e), look: lsLookOf(e),
      raws: (e.audio || []).map((a) => (a ? +a.raw.toFixed(3) : 0)) })),
    images,
  };
}
/* 저장본에 딸린 목소리(wav)를 올린다 — saved는 이 저장본에 담긴 영상 목록(따로 저장은 영상 하나) */
async function lsAfterSaveFor(saved, itemId, payload, onProgress) {
  const todo = (payload.images || []).map((m) => {
    const km = LS_WAV_KEY_RE.exec(m.key);
    const e = saved[m.entry], k = km ? +km[2] : -1;
    const a = e && e.audio && e.audio[k];
    return { m, k, p: km && km[3] != null ? +km[3] : -1, n: a ? lsWavParts(a.raw) : 1, src: a && a.url, line: `${m.entry}:${k}` };
  }).filter((x) => x.src && lsSavedSrc.get(itemId + "|" + x.m.key) !== x.src);
  const failedLines = new Set();
  const reasons = new Set();
  const wavCache = new Map();   // 줄 주소 → {x, sr} (조각마다 다시 읽지 않게)
  if (onProgress && todo.length) onProgress(0, todo.length);
  for (let i = 0; i < todo.length; i++) {
    const { m, p, n, src, line } = todo[i];
    try {
      let blob = await fetch(src).then((r) => r.blob());
      if (p >= 0) {   // 긴 줄 — 이 조각의 소리만 떼어 온전한 wav 하나로
        if (!wavCache.has(src)) wavCache.set(src, rlmReadWav(await blob.arrayBuffer()));
        const { x, sr } = wavCache.get(src);
        const per = Math.ceil(x.length / n);
        blob = rlWavBlob(x.subarray(p * per, Math.min(x.length, (p + 1) * per)), sr);
      }
      await postJson("/api/saved-image", { id: itemId, key: m.key, mime: "audio/wav", image: await blobToB64(blob) }, "저장에 실패했습니다.");
      lsSavedSrc.set(itemId + "|" + m.key, src);
    } catch (err) { failedLines.add(line); reasons.add((err && err.message) || String(err)); }
    if (onProgress) onProgress(i + 1, todo.length);
  }
  if (failedLines.size) throw new Error(`대본은 저장됐지만 목소리 ${failedLines.size}줄은 저장하지 못했습니다 — ${[...reasons].join(" / ")} 다시 저장해 보세요.`);
}

/* 저장본의 목소리(wav)를 받아 entries[].audio에 채운다 — 저장함에서 불러올 때와 과제 부여 창이 함께 쓴다. 받은 게 있으면 true */
async function lsLoadAudio(entries, itemId, payload) {
  const metas = Array.isArray(payload.images) ? payload.images : [];
  const parts = new Map();   // "entry:k" → [조각 차례대로 base64]
  const got = await fetchSavedImages(itemId, metas, (m, d) => {
    const e = entries[m.entry];
    const km = LS_WAV_KEY_RE.exec(m.key);
    if (!e || !km) return false;
    const k = +km[2];
    if (km[3] != null) {   // 긴 줄의 조각 — 다 받은 뒤 이어 붙인다
      const key = `${m.entry}:${k}`;
      if (!parts.has(key)) parts.set(key, []);
      parts.get(key)[+km[3]] = d.image;
      return;
    }
    const url = lsBlob(b64ToBlobUrl(d.image, d.mime || "audio/wav"));
    e.audio[k] = { url, raw: (e.raws && e.raws[k]) || 3 };
    lsSavedSrc.set(itemId + "|" + m.key, url);
  }, "목소리");
  const b64Buf = (b64) => { const s = atob(b64); const u = new Uint8Array(s.length); for (let i = 0; i < s.length; i++) u[i] = s.charCodeAt(i); return u.buffer; };
  parts.forEach((list, key) => {
    const [ei, k] = key.split(":").map(Number);
    const e = entries[ei];
    if (!e || list.length !== lsWavParts(e.raws && e.raws[k]) || list.some((x) => !x)) return;   // 조각이 빠졌으면 그 줄은 비워 둔다([빠진 목소리 만들기]가 뜬다)
    const pcs = list.map((b) => rlmReadWav(b64Buf(b)));
    const all = new Float32Array(pcs.reduce((s, p) => s + p.x.length, 0));
    let o = 0;
    pcs.forEach((p) => { all.set(p.x, o); o += p.x.length; });
    const url = lsBlob(URL.createObjectURL(rlWavBlob(all, pcs[0].sr)));
    e.audio[k] = { url, raw: all.length / pcs[0].sr };
    list.forEach((_, p) => lsSavedSrc.set(`${itemId}|${lsWavKey(ei, k)}p${p}`, url));
  });
  return got;

}

TAB_SAVE.lesson = {
  canSave: () => (lsState.entries.some((e) => e.script) ? "" : "저장할 지문 강의 영상이 없습니다. 먼저 만들어 주세요."),
  getPayload: () => lsPayloadOf(lsState.entries.filter((e) => e.script), passageMgr.getJobs()),
  // 영상이 둘 이상이면 '영상마다 따로 저장'을 고를 수 있다 — 저장본 하나에 영상 하나씩(이름은 '제목_영상 이름')
  splitItems: () => {
    const used = new Map();
    return lsState.entries.filter((e) => e.script).map((e) => {
      let name = String(e.script.title || e.name || "영상").trim() || "영상";
      const n = (used.get(name) || 0) + 1; used.set(name, n);
      if (n > 1) name = `${name} (${n})`;
      const jobs = passageMgr.getJobs().filter((j) => j.text && (e.text || "").includes(j.text.trim()));
      return {
        name,
        getPayload: () => lsPayloadOf([e], jobs.length ? jobs : [{ name: e.name, text: e.text, named: true }]),
        afterSave: (itemId, payload, onProgress) => lsAfterSaveFor([e], itemId, payload, onProgress),
      };
    });
  },
  afterSave: (itemId, payload, onProgress) => lsAfterSaveFor(lsState.entries.filter((e) => e.script), itemId, payload, onProgress),
  afterLoad: async (itemId, payload) => { if (await lsLoadAudio(lsState.entries, itemId, payload)) lsRender(); },
  applyPayload: (payload) => {
    if (lsPlaying) lsPlaying.stop();
    lsRecAbortAll();
    lsState.entries.forEach(lsDropVideo);
    passageMgr.setJobs(payload.passages || []);
    lsDropBlobs();
    lsState.entries = (payload.entries || []).filter((e) => e && e.script).map((e) => ({ ...e, audio: e.script.segments.map(() => null), error: "" }));
    lsEl("lsError").textContent = "";
    lsRender();
    lsSyncCost();
  },
  clearResults: () => {
    if (lsPlaying) lsPlaying.stop();
    lsRecAbortAll();
    lsState.entries.forEach(lsDropVideo);
    lsDropBlobs();
    lsState.entries = [];
    lsEl("lsError").textContent = "";
    lsRender();
  },
};

if (typeof HOWTO !== "undefined") {
  HOWTO.lesson = {
    title: `🎓 ${LESSON_NAME} 하는 법`,
    lead: "지문 하나로 <b>가로 수업 영상</b>(1920×1080, 4~6분)을 만듭니다 — 먼저 <b>상세분석</b>을 돌리고, 그 해설을 근거로 AI가 문장마다 읽고, 뜻을 풀고, 문법·구문과 내신에 나올 곳을 짚는 대본을 쓰고, 고른 목소리로 읽어 줍니다.",
    steps: [
      "위쪽 <b>영어 지문</b> 칸에 지문을 넣습니다. 지문이 여러 개면 만들 때 창이 떠서 지문마다 <b>몇 번째 영상</b>에 넣을지 고릅니다 — 같은 번호끼리 이어 한 편이 됩니다(한 번에 영상 20편·문장 모두 120개까지, 한 편에 문장 50개까지 — 긴 지문은 대본을 나눠 만들어 이어 붙입니다).",
      "<b>목소리</b>를 고릅니다(<b>🔊 들어 보기</b>로 미리 들어 볼 수 있고, <b>더 많은 목소리</b>를 펼치면 열 가지가 더 있습니다). 여러 개 고르면 <b>🎙️ 영상마다 목소리</b>에서 지문마다 정합니다.",
      "<b>말 빠르기</b>·<b>화면 모양</b>(✍️ 필기형 — 왼쪽 영어·오른쪽 해석 위에 동그라미·밑줄·물결·형광펜·화살표·번호를 그으며 설명 / 🖥️ 슬라이드형)을 고르고 <b>🎓 영상 만들기</b>를 누릅니다. 위쪽 <b>목표 어법</b> 칸에 어법을 적으면(쉼표로 4개까지) 문장 설명 뒤에 그 어법을 따로 자세히 설명합니다(개념·형태·이 지문에서 쓰인 곳·내신에 나오는 방식).",
      "<b>▶ 미리 보기</b>로 확인합니다. 화면 모양·빠르기·머리표는 만든 뒤에도 카드에서 <b>값 없이</b> 바꿀 수 있습니다.",
      "영상 파일(mp4)은 저절로 만들어 둡니다. <b>⬇ 영상 받기</b>로 받으세요. <b>💾 사이트 저장</b>은 대본·목소리만 남깁니다(영상 파일은 저장되지 않습니다). 영상이 둘 이상이면 저장창의 <b>영상 N개를 따로따로 저장하기</b>를 체크해 영상마다 저장본을 하나씩 만들 수 있습니다(과제로 낼 때도 편합니다).",
    ],
    tip: "실제 시험 문제를 모르는 채 만드는 대본이라 '정답'은 말하지 않고 '나오기 좋아요'로만 짚습니다. AI가 만든 해설이니 수업에 쓰기 전에 <b>📜 대본 보기</b>로 한 번 확인해 주세요. 영상 파일은 <b>PC 크롬</b>을 권합니다.",
  };
}

// 학원 마크 칸이나 '넣기' 체크가 바뀌면 다시 그린다(영상 파일은 lsRender가 다시 만든다)
let lsBrandTimer = 0;
function lsBrandChanged() {
  if (!lsState.entries.length) return;
  clearTimeout(lsBrandTimer);
  lsBrandTimer = setTimeout(() => { if (!lsPlaying) lsRender(); }, 700);
}
lsEl("lsBrandOn").addEventListener("change", lsBrandChanged);
["input", "change", "click"].forEach((ev) => document.addEventListener(ev, (e) => {
  if (e.target.closest && e.target.closest(".brand-panel") && lsEl("tab-lesson").classList.contains("active")) lsBrandChanged();
}, true));

lsRender();
lsSyncCost();
