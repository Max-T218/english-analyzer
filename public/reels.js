/* ══════ 릴스 제작 (2026-11-19 사용자) ══════
   지문 하나 → 세로 숏폼 영상(1080×1920, 60초 안팎). 사용자는 지문을 넣고 목소리만 고른다.
     ① /api/reelscript — 서버가 내용 한장정리(call_gemini_explain)를 만든 뒤 그것만 근거로 장면 대본을 짠다(값 한 번)
     ② /api/reelvoice  — 대사 전부를 고른 목소리로(줄마다 PCM)
     ③ /api/reelimage  — 장면 그림 한 장씩(세로 9:16, RL_IMG_PARALLEL장씩 함께 — 목소리와 동시에)
   영상은 서버가 아니라 여기서 만든다 — 캔버스에 그림·큰 글씨·자막·퀴즈 카드를 그리면서(rlDraw) 목소리를 1.15배로 틀고,
   [⬇ 영상 내려받기]는 그 화면과 소리를 MediaRecorder로 녹화한다(크롬은 mp4, 안 되면 webm). 녹화는 영상 길이만큼 걸린다.
   그리는 모양·시간표는 지문설명영상/_제작도구/reel_build.py(로컬에서 만들던 판)와 같다 — 한쪽을 고치면 함께 볼 것.
   목소리 다듬기(끝 '치직' 0.17초·앞 '틱' 10ms 자르기)도 그 도구의 strip_bursts와 같은 규칙이다(Gemini 음성의 버릇).
   저장은 저장함 tab "reels" — 대본·한장정리는 저장본 글에, 그림·목소리는 /api/saved-image로 한 장(한 줄)씩 따로. */

const rlEl = (id) => document.getElementById(id);
const REELS_NAME = "숏폼 영상 제작";   // 화면 이름(2026-11-19 사용자 — '릴스'는 인스타그램 기능 이름이라 피했다)
// 목소리 — 서버 REEL_VOICES와 같은 값·같은 차례. rec이면 '추천' 묶음(2026-11-19 사용자가 고른 넷), 나머지는 '더 많은 목소리'
// (같은 날 사용자 — 선택 폭을 넓혀 달라고). 미리 듣기 파일은 public/reel-voice-<id>.mp3(같은 두 문장, 1.15배)
const RL_VOICES = [
  { id: "Charon", desc: "남 · 낮고 안정된 설명형", rec: true },
  { id: "Alnilam", desc: "남 · 단단하고 힘 있는 톤", rec: true },
  { id: "Orus", desc: "남 · 단호하고 또렷한 톤", rec: true },
  { id: "Aoede", desc: "여 · 부드럽고 차분한 톤", rec: true },
  { id: "Kore", desc: "여 · 단호하고 힘 있는 설명형" },
  { id: "Erinome", desc: "여 · 맑고 또렷한 톤" },
  { id: "Gacrux", desc: "여 · 성숙하고 차분한 선생님 톤" },
  { id: "Pulcherrima", desc: "여 · 적극적이고 밝은 톤" },
  { id: "Sulafat", desc: "여 · 따뜻한 톤" },
  { id: "Iapetus", desc: "남 · 또렷한 젊은 강사 톤" },
  { id: "Rasalgethi", desc: "남 · 다큐 내레이션 같은 정보 전달형" },
  { id: "Sadaltager", desc: "남 · 차분히 풀어 주는 톤" },
  { id: "Achird", desc: "남 · 친근한 톤" },
  { id: "Schedar", desc: "남 · 고르고 담담한 톤" },
];
// 말 빠르기(2026-11-19 사용자 — 고를 수 있게). 녹음은 1배로 받아 두고 틀 때 playbackRate로 바꾼다(높낮이는 그대로 — preservesPitch)
// 그래서 만든 뒤에도 값 없이 바꿀 수 있다. 기본 1.15배는 로컬에서 만들던 릴스와 같은 값. 미리 듣기 파일은 1.15배로 녹음돼 있다
// 슬라이더로 0.7~1.5배를 0.05씩(2026-11-19 사용자 — 처음엔 다섯 단계 고르기였다)
const RL_SPEED_MIN = 0.7, RL_SPEED_MAX = 1.5, RL_SPEED_STEP = 0.05;
const RL_TEMPO = 1.15;            // 기본 빠르기
const RL_SAMPLE_TEMPO = 1.15;     // 미리 듣기 파일(reel-voice-*.mp3)이 녹음된 빠르기
const rlSpeedOf = (e) => (e && +e.speed) || RL_TEMPO;
const rlSpeedPick = () => +(rlEl("rlSpeed") && rlEl("rlSpeed").value) || RL_TEMPO;
const rlSpeedText = (v) => `${(+v).toFixed(2).replace(/0$/, "")}배`;
const rlSpeedRange = (cls, cur, id = "") =>
  `<input type="range" class="${cls}"${id ? ` id="${id}"` : ""} min="${RL_SPEED_MIN}" max="${RL_SPEED_MAX}" step="${RL_SPEED_STEP}" value="${cur}">` +
  `<b class="rl-speed-val">${rlSpeedText(cur)}</b>`;
const RL_MAX_PASSAGES = 5;        // 한 번에 만드는 지문 수(한 편 3천 P 안팎이라)
const RL_EST_SCENES = 9;          // 값 어림용 장면 수(퀴즈 포함)
const RL_W = 1080, RL_H = 1920, RL_FPS = 30;
const RL_IMG_PARALLEL = 5;      // 장면 그림을 함께 부르는 수 — 9장이면 두 번에 끝난다

const rlState = { entries: [], busy: false };
let rlBlobUrls = [];
const rlBlob = (u) => { rlBlobUrls.push(u); return u; };
function rlDropBlobs() { rlBlobUrls.forEach((u) => URL.revokeObjectURL(u)); rlBlobUrls = []; }

/* ── 목소리 고르기 ──
   여러 개를 고를 수 있다. 둘 이상이면 아래 '영상마다 목소리'에 지문마다 줄이 생기고, 처음에는 고른 목소리를
   지문 차례대로 돌려 가며 넣는다(바꾼 것은 지문 글을 열쇠로 기억 — rlVoicePick, 화면에서만). */
const rlVoiceCard = (v) =>
  `<label class="rl-voice"><input type="checkbox" class="rl-vchk" value="${v.id}"${v.id === RL_VOICES[0].id ? " checked" : ""}>` +
  `<b>${v.id}</b><span class="rl-voice-desc">${v.desc}</span>` +
  `<button type="button" class="btn ghost small rl-listen" data-v="${v.id}" title="같은 두 문장으로 미리 들어 봅니다">🔊 들어 보기</button></label>`;
rlEl("rlVoiceBox").innerHTML =
  `<div class="rl-vgroup-title">⭐ 추천 목소리</div>` +
  `<div class="rl-voices">${RL_VOICES.filter((v) => v.rec).map(rlVoiceCard).join("")}</div>` +
  `<details class="rl-vmore"><summary>더 많은 목소리 (${RL_VOICES.filter((v) => !v.rec).length}개)</summary>` +
  `<div class="rl-voices">${RL_VOICES.filter((v) => !v.rec).map(rlVoiceCard).join("")}</div></details>` +
  `<div class="rl-per" id="rlPerList" hidden></div>`;
rlEl("rlSpeedBox").innerHTML = `<label for="rlSpeed" class="rl-vgroup-title">⏩ 말 빠르기</label> ` +
  `<span class="rl-speed-ends">${rlSpeedText(RL_SPEED_MIN)}</span>${rlSpeedRange("rl-speed-main", RL_TEMPO, "rlSpeed")}` +
  `<span class="rl-speed-ends">${rlSpeedText(RL_SPEED_MAX)}</span>` +
  `<button type="button" class="btn ghost small" id="rlSpeedReset">기본(${rlSpeedText(RL_TEMPO)})</button>` +
  `<span class="rl-voice-desc">들어 보기에도 바로 반영됩니다 · 만든 뒤에도 영상마다 바꿀 수 있어요(값 없음)</span>`;
const rlSpeedSync = () => {
  rlEl("rlSpeedBox").querySelector(".rl-speed-val").textContent = rlSpeedText(rlSpeedPick());
  if (rlSampleAudio) rlSampleAudio.playbackRate = rlSpeedPick() / RL_SAMPLE_TEMPO;
};
rlEl("rlSpeed").addEventListener("input", rlSpeedSync);
rlEl("rlSpeedReset").addEventListener("click", () => { rlEl("rlSpeed").value = RL_TEMPO; rlSpeedSync(); });
/* ── 그림 느낌 고르기(2026-11-19 사용자 — 영상 속 그림을 선생님이 고른다) ──
   서버 REEL_IMG_STYLES와 같은 열쇠·차례(첫째가 기본). 값은 어느 느낌이든 같다. 고른 느낌은 영상(entry)마다 imgStyle에 담아
   저장본에도 남기고, [다시 그리기]도 그 느낌으로 그린다. */
const RL_IMG_STYLES = [
  { id: "illust", label: "🎨 반실사 일러스트", desc: "차분한 색감의 디지털 페인팅(기본)" },
  { id: "photo", label: "📷 실사 사진", desc: "다큐 사진처럼 사실적인 장면" },
  { id: "webtoon", label: "💬 웹툰", desc: "굵은 선과 또렷한 색의 만화 느낌" },
  { id: "anime", label: "🌸 애니메이션", desc: "부드러운 빛의 일본 애니 영화 느낌" },
  { id: "watercolor", label: "🖌️ 수채화", desc: "번지는 물감, 연한 파스텔" },
  { id: "card", label: "📰 카드뉴스(글자형)", desc: "그림 없이 배경색 + 큰 글씨·자막 — 그림 값 없음", local: true },
];
// 카드뉴스 배경색(2026-11-19 사용자 — 누르면 배경색을 정한다). auto는 장면마다 색을 돌려 가며 쓴다. 글씨가 흰색이라 어두운 색 위주
const RL_CARD_COLORS = [
  { id: "auto", label: "자동(장면마다 다르게)", hex: "" },
  { id: "navy", label: "네이비", hex: "#1f3a8a" },
  { id: "teal", label: "청록", hex: "#0f766e" },
  { id: "plum", label: "자주", hex: "#7e22ce" },
  { id: "wine", label: "와인", hex: "#be123c" },
  { id: "forest", label: "초록", hex: "#15803d" },
  { id: "orange", label: "주황", hex: "#c2410c" },
  { id: "slate", label: "차콜", hex: "#334155" },
];
const RL_CARD_AUTO = ["#1f3a8a", "#0f766e", "#7e22ce", "#be123c", "#15803d", "#c2410c"];
const RL_IMG_STYLE_DEFAULT = RL_IMG_STYLES[0].id;
const rlStyleOf = (e) => (e && RL_IMG_STYLES.some((s) => s.id === e.imgStyle) ? e.imgStyle : RL_IMG_STYLE_DEFAULT);
const rlStylePick = () => { const c = document.querySelector(".rl-schk:checked"); return c ? c.value : RL_IMG_STYLE_DEFAULT; };
rlEl("rlStyleBox").innerHTML = `<div class="rl-vgroup-title">🖼️ 그림 느낌</div><div class="rl-styles">` +
  RL_IMG_STYLES.map((s) => `<label class="rl-voice rl-style"><input type="radio" name="rlImgStyle" class="rl-schk" value="${s.id}"` +
    `${s.id === RL_IMG_STYLE_DEFAULT ? " checked" : ""}><b>${s.label}</b><span class="rl-voice-desc">${s.desc}</span>` +
    // 예시 그림 — 같은 장면을 느낌별로 실제로 그린 것(public/reel-style-<id>.jpg). 카드뉴스는 그림이 아니라 모양만 흉내 낸다
    (s.local ? `<span class="rl-style-sample rl-style-card" aria-hidden="true"><em>핵심<br>키워드</em><small>자막이 여기에 나와요</small></span>`
      : `<img class="rl-style-sample" src="/reel-style-${s.id}.jpg" alt="${s.label} 예시" loading="lazy">`) + `</label>`).join("") +
  `</div><div class="rl-cardbox" id="rlCardBox" hidden><div class="rl-vgroup-title">🎨 카드 배경색</div><div class="rl-swatches">` +
  RL_CARD_COLORS.map((c) => `<label class="rl-sw" title="${c.label}"><input type="radio" name="rlCardColor" class="rl-cchk" value="${c.id}"${c.id === "auto" ? " checked" : ""}>` +
    (c.hex ? `<i style="background:${c.hex}"></i>` : `<i class="rl-sw-auto">자동</i>`) + `<span>${c.label}</span></label>`).join("") +
  `<label class="rl-sw" title="직접 고르기"><input type="radio" name="rlCardColor" class="rl-cchk" value="custom"><input type="color" id="rlCardCustom" value="#1f3a8a"><span>직접 고르기</span></label>` +
  `</div><span class="rl-voice-desc">너무 밝은 색은 글씨가 안 보이지 않게 자동으로 조금 어둡게 맞춥니다</span></div>` +
  `<span class="rl-voice-desc">그림 느낌은 값이 모두 같고, 카드뉴스는 그림 값이 없습니다 · 만든 뒤 그림만 [다시 그리기]해도 같은 느낌으로 그려요</span>`;
const rlCardPick = () => {
  const c = document.querySelector(".rl-cchk:checked");
  const v = c ? c.value : "auto";
  if (v === "custom") return rlEl("rlCardCustom").value;
  const f = RL_CARD_COLORS.find((x) => x.id === v);
  return f && f.hex ? f.hex : "auto";
};
const rlCardOf = (e) => (e && /^(auto|#[0-9a-f]{6})$/i.test(e.cardColor || "") ? e.cardColor : "auto");
const rlIsCard = (e) => rlStyleOf(e) === "card";
// 밝은 색은 글씨(흰색)가 안 보이니 밝기를 눌러 준다
function rlCardShade(hex) {
  let [r, g, b] = [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16));
  const lum = () => 0.2126 * r + 0.7152 * g + 0.0722 * b;
  while (lum() > 110) { r *= 0.9; g *= 0.9; b *= 0.9; }
  return [r, g, b].map((x) => Math.round(x));
}
function rlCardImage(color, k, total) {
  const base = color === "auto" ? RL_CARD_AUTO[k % RL_CARD_AUTO.length] : color;
  const [r, g, b] = rlCardShade(base);
  const cv = document.createElement("canvas");
  cv.width = RL_W; cv.height = RL_H;
  const ctx = cv.getContext("2d");
  const gr = ctx.createLinearGradient(0, 0, RL_W * 0.4, RL_H);
  gr.addColorStop(0, `rgb(${Math.min(r * 1.25 + 14, 255)},${Math.min(g * 1.25 + 14, 255)},${Math.min(b * 1.25 + 14, 255)})`);
  gr.addColorStop(1, `rgb(${r * 0.55 | 0},${g * 0.55 | 0},${b * 0.55 | 0})`);
  ctx.fillStyle = gr; ctx.fillRect(0, 0, RL_W, RL_H);
  ctx.fillStyle = "rgba(255,255,255,.07)";
  ctx.beginPath(); ctx.arc(RL_W * 0.92, RL_H * 0.2, 340, 0, Math.PI * 2); ctx.fill();
  ctx.beginPath(); ctx.arc(RL_W * 0.05, RL_H * 0.72, 420, 0, Math.PI * 2); ctx.fill();
  ctx.fillStyle = "rgba(255,255,255,.10)";
  ctx.font = `800 420px ${RL_FONT}`; ctx.textAlign = "center"; ctx.textBaseline = "middle";
  ctx.fillText(String(k + 1).padStart(2, "0"), RL_W / 2, RL_H * 0.5);
  ctx.fillStyle = "rgba(255,255,255,.55)";
  ctx.fillRect(RL_W / 2 - 60, 250, 120, 8);
  return new Promise((res) => cv.toBlob((bl) => res(bl), "image/jpeg", 0.9));
}
const rlStyleSync = () => {
  rlEl("rlCardBox").hidden = rlStylePick() !== "card";
  rlSyncCost();
};
rlEl("rlStyleBox").addEventListener("change", (ev) => {
  if (ev.target.closest(".rl-cchk") || ev.target.id === "rlCardCustom") {
    if (ev.target.id === "rlCardCustom") document.querySelector('.rl-cchk[value="custom"]').checked = true;
    return;
  }
  rlStyleSync();
});
const rlVoicesChecked = () => [...document.querySelectorAll(".rl-vchk:checked")].map((c) => c.value);
const rlVoicePick = new Map();   // 지문 글 → 고른 목소리
function rlVoiceFor(job, i) {
  const vs = rlVoicesChecked();
  if (!vs.length) return "";
  const picked = rlVoicePick.get(job.text);
  return vs.includes(picked) ? picked : vs[i % vs.length];
}
function rlRenderPer() {
  const box = rlEl("rlPerList");
  const vs = rlVoicesChecked();
  const jobs = rlJobs().slice(0, RL_MAX_PASSAGES);
  box.hidden = vs.length < 2 || !jobs.length;
  if (box.hidden) { box.innerHTML = ""; return; }
  box.innerHTML = `<div class="rl-vgroup-title">🎙️ 영상마다 목소리 <span class="rl-voice-desc">처음엔 고른 목소리를 차례로 돌려 넣었어요 — 지문마다 바꿀 수 있어요</span></div>` +
    jobs.map((j, i) => `<label class="rl-per-row"><span>${esc(j.name)}</span><select data-i="${i}">` +
      vs.map((v) => `<option value="${v}"${v === rlVoiceFor(j, i) ? " selected" : ""}>${v} — ${esc(RL_VOICES.find((x) => x.id === v).desc)}</option>`).join("") +
      `</select></label>`).join("");
}
rlEl("rlVoiceBox").addEventListener("change", (e) => {
  if (e.target.classList.contains("rl-vchk")) rlRenderPer();
  const sel = e.target.closest(".rl-per select");
  if (sel) { const j = rlJobs()[+sel.dataset.i]; if (j) rlVoicePick.set(j.text, sel.value); }
});
// 들어 보기 — 누르면 재생, 듣는 중에 다시 누르면 일시정지, 한 번 더 누르면 이어서(2026-11-19 사용자). 다른 목소리를 누르면 앞의 것은 멈춘다
const RL_LISTEN = "🔊 들어 보기", RL_PAUSE = "⏸ 일시정지", RL_RESUME = "▶ 이어 듣기";
let rlSampleAudio = null, rlSampleBtn = null;
rlEl("rlVoiceBox").addEventListener("click", (e) => {
  const b = e.target.closest(".rl-listen");
  if (!b) return;
  e.preventDefault();
  if (rlSampleBtn === b && rlSampleAudio) {
    if (rlSampleAudio.paused) { rlSampleAudio.play().catch(() => {}); b.textContent = RL_PAUSE; }
    else { rlSampleAudio.pause(); b.textContent = RL_RESUME; }
    return;
  }
  if (rlSampleAudio) rlSampleAudio.pause();
  if (rlSampleBtn) rlSampleBtn.textContent = RL_LISTEN;
  rlSampleAudio = new Audio(`/reel-voice-${b.dataset.v}.mp3`);
  rlSampleAudio.preservesPitch = true;
  rlSampleAudio.playbackRate = rlSpeedPick() / RL_SAMPLE_TEMPO;
  rlSampleBtn = b;
  rlSampleAudio.addEventListener("ended", () => { b.textContent = RL_LISTEN; rlSampleAudio = null; rlSampleBtn = null; });
  b.textContent = RL_PAUSE;
  rlSampleAudio.play().catch(() => { b.textContent = RL_LISTEN; });
});

/* ── 값 ── */
const rlPrice = () => (typeof PRICING !== "undefined" && PRICING && Number.isFinite(PRICING.reelScript)) ? PRICING : null;
const rlEachCost = () => {
  const p = rlPrice();
  return p ? p.reelScript + p.reelVoice + (rlStylePick() === "card" ? 0 : p.reelImage * RL_EST_SCENES) : null;   // 카드뉴스는 그림을 그리지 않아 그림 값이 없다
};
function rlJobs() {
  return passageMgr.getJobs().filter((j) => j.text && j.text.length >= 20);
}
function rlSyncCost() {
  const n = Math.min(rlJobs().length, RL_MAX_PASSAGES);
  const p = rlPrice();
  rlEl("rlCostHint").innerHTML = n && p
    ? `예상 비용 <b>${pt(rlEachCost() * n)}</b> 안팎 (지문 ${n}개 × [대본 ${pt(p.reelScript)} + 목소리 ${pt(p.reelVoice)}${rlStylePick() === "card" ? "" : ` + 장면 그림 약 ${RL_EST_SCENES}장 × ${pt(p.reelImage)}`}]` +
      ` — 장면 수에 따라 조금 달라집니다)` : "";
}
if (typeof onPricingReady === "function") onPricingReady(rlSyncCost);
document.addEventListener("input", (e) => {
  if (e.target.closest && e.target.closest(".passage-panel")) { rlSyncCost(); rlRenderPer(); }
});
document.querySelector('.tab-btn[data-tab="reels"]').addEventListener("click", () => { rlSyncCost(); rlRenderPer(); });

/* ── 목소리 다듬기: PCM16 → (자르기·크기 맞추기) → wav ── */
function rlPcmFromB64(b64) {
  const bin = atob(b64);
  const n = bin.length >> 1;
  const out = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    let v = bin.charCodeAt(2 * i) | (bin.charCodeAt(2 * i + 1) << 8);
    if (v >= 32768) v -= 65536;
    out[i] = v / 32768;
  }
  return out;
}
const rlRms = (x, a, b) => { let s = 0; for (let i = a; i < b; i++) s += x[i] * x[i]; return Math.sqrt(s / Math.max(1, b - a)); };
function rlCleanPcm(x, sr) {
  // 끝 0.16초가 말소리보다 훨씬 크면(잡음) 끝 0.17초를 자른다, 앞 10ms는 늘 자른다 — reel_build.py strip_bursts와 같다
  const tail = Math.floor(sr * 0.16);
  const tailRms = rlRms(x, x.length - tail, x.length);
  let peak = 0;
  const win = 480;
  for (let i = Math.floor(sr * 0.05); i + win < x.length - Math.floor(sr * 0.2); i += win) peak = Math.max(peak, rlRms(x, i, i + win));
  const cutEnd = (tailRms > 1.5 * peak || tailRms > 0.3) ? Math.floor(sr * 0.17) : 0;
  let a = Math.floor(sr * 0.01), b = x.length - cutEnd;
  // 앞뒤 조용한 곳(-45dB) 걷기 — 말 앞 50ms·뒤 80ms는 남긴다
  const th = 0.0056;
  const loud = (i) => Math.abs(x[i]) > th;
  while (a < b && !loud(a)) a++;
  while (b > a && !loud(b - 1)) b--;
  a = Math.max(0, a - Math.floor(sr * 0.05));
  b = Math.min(x.length - cutEnd, b + Math.floor(sr * 0.08));
  const y = x.slice(a, b);
  // 크기 고르게(말소리 부분 RMS 기준) + 앞뒤 짧게 흐리기
  let s = 0, c = 0;
  for (const v of y) if (Math.abs(v) > 0.01) { s += v * v; c++; }
  const g = c ? 0.11 / Math.sqrt(s / c) : 1;
  const fi = Math.floor(sr * 0.02), fo = Math.floor(sr * 0.04);
  for (let i = 0; i < y.length; i++) {
    let k = g;
    if (i < fi) k *= i / fi;
    if (i > y.length - fo) k *= (y.length - i) / fo;
    y[i] = Math.max(-1, Math.min(1, y[i] * k));
  }
  return y;
}
function rlWavBlob(y, sr) {
  const buf = new ArrayBuffer(44 + y.length * 2);
  const d = new DataView(buf);
  const w = (o, s) => [...s].forEach((ch, i) => d.setUint8(o + i, ch.charCodeAt(0)));
  w(0, "RIFF"); d.setUint32(4, 36 + y.length * 2, true); w(8, "WAVE"); w(12, "fmt ");
  d.setUint32(16, 16, true); d.setUint16(20, 1, true); d.setUint16(22, 1, true);
  d.setUint32(24, sr, true); d.setUint32(28, sr * 2, true); d.setUint16(32, 2, true); d.setUint16(34, 16, true);
  w(36, "data"); d.setUint32(40, y.length * 2, true);
  for (let i = 0; i < y.length; i++) d.setInt16(44 + i * 2, Math.round(y[i] * 32767), true);
  return new Blob([buf], { type: "audio/wav" });
}
// wav 한 줄 → {url, dur(1.15배로 튼 길이)}
function rlAudioFromWav(blob, sr, nSamples) {
  return { url: rlBlob(URL.createObjectURL(blob)), raw: nSamples / sr, blob };
}

/* ── 시간표 — reel_build.py와 같은 간격 ── */
function rlTimeline(e) {
  const sc = e.script.scenes;
  const segs = [];
  let t = 0.5, prev = null, k = 0;
  sc.forEach((s, si) => {
    s.say.forEach((say, li) => {
      const a = e.audio[k];
      if (prev !== null) t += si !== prev ? 0.5 : 0.22;
      t += (s.pause_before || [])[li] || 0;
      const dur = a.raw / rlSpeedOf(e);
      segs.push({ scene: si, start: t, end: t + dur, text: say, k, li });
      t += dur;
      prev = si;
      k++;
    });
  });
  const total = t + 1.6;
  const scenes = sc.map((s, si) => {
    const mine = segs.filter((g) => g.scene === si);
    return { ...s, idx: si, start: si ? mine[0].start - 0.3 : 0, segs: mine };
  });
  scenes.forEach((s, i) => { s.end = i + 1 < scenes.length ? scenes[i + 1].start : total; });
  return { segs, scenes, total };
}

/* ── 그리기 ── */
const RL_FONT = getComputedStyle(document.body).fontFamily || "sans-serif";
const rlEase = (x) => (x < 0 ? 0 : x > 1 ? 1 : x * x * (3 - 2 * x));
function rlRound(ctx, x, y, w, h, r) {
  ctx.beginPath();
  ctx.moveTo(x + r, y); ctx.arcTo(x + w, y, x + w, y + h, r); ctx.arcTo(x + w, y + h, x, y + h, r);
  ctx.arcTo(x, y + h, x, y, r); ctx.arcTo(x, y, x + w, y, r); ctx.closePath();
}
// 낱말 단위 줄바꿈(낱말 중간에서 자르지 않는다 — 처음 판에서 '헷갈/리지'가 나왔다)
function rlWrap(ctx, text, maxW) {
  const out = [];
  String(text || "").split("\n").forEach((para) => {
    let line = "";
    para.split(/\s+/).filter(Boolean).forEach((w) => {
      const t = line ? line + " " + w : w;
      if (line && ctx.measureText(t).width > maxW) { out.push(line); line = w; } else line = t;
    });
    if (line) out.push(line);
  });
  return out;
}
function rlCover(ctx, img, z, dx, dy) {
  const s = Math.max(RL_W / img.naturalWidth, RL_H / img.naturalHeight) * z;
  const w = img.naturalWidth * s, h = img.naturalHeight * s;
  ctx.drawImage(img, (RL_W - w) / 2 + dx, RL_H * 0.45 - h * 0.45 + dy, w, h);
}
function rlDraw(ctx, e, tl, imgs, t) {
  ctx.fillStyle = "#000";
  ctx.fillRect(0, 0, RL_W, RL_H);
  const XF = 0.4;
  tl.scenes.forEach((s, i) => {
    let o = 0;
    if (t >= s.start - XF && t < s.end) o = i === 0 ? 1 : rlEase((t - s.start + XF) / XF);
    if (i === tl.scenes.length - 1 && t >= s.start) o = 1;
    if (o <= 0) return;
    const p = Math.min(Math.max((t - s.start + XF) / (s.end - s.start + XF * 2), 0), 1);
    ctx.globalAlpha = o;
    const img = imgs[i];
    if (img && img.complete && img.naturalWidth) {
      rlCover(ctx, img, 1.03 + 0.09 * p, (i % 2 ? 1 : -1) * 28 * (p - 0.5), ((i % 3) - 1) * 18 * (p - 0.5));
    } else {
      const g = ctx.createLinearGradient(0, 0, 0, RL_H);
      g.addColorStop(0, "#1d2b4f"); g.addColorStop(1, "#0b1020");
      ctx.fillStyle = g; ctx.fillRect(0, 0, RL_W, RL_H);
    }
    ctx.globalAlpha = 1;
  });
  // 위아래 어둡게(글씨가 읽히게)
  const sh = ctx.createLinearGradient(0, 0, 0, RL_H);
  sh.addColorStop(0, "rgba(0,0,0,.62)"); sh.addColorStop(0.22, "rgba(0,0,0,.18)"); sh.addColorStop(0.4, "rgba(0,0,0,0)");
  sh.addColorStop(0.55, "rgba(0,0,0,0)"); sh.addColorStop(0.72, "rgba(0,0,0,.55)"); sh.addColorStop(1, "rgba(0,0,0,.78)");
  if (rlIsCard(e)) ctx.globalAlpha = 0.45;   // 카드뉴스는 배경색이 흐려지지 않게 그늘을 옅게
  ctx.fillStyle = sh; ctx.fillRect(0, 0, RL_W, RL_H);
  ctx.globalAlpha = 1;
  ctx.textAlign = "center"; ctx.textBaseline = "middle";
  // 머리표
  ctx.font = `600 34px ${RL_FONT}`;
  const tag = e.tag || e.name || REELS_NAME;
  const tw = ctx.measureText(tag).width + 52;
  rlRound(ctx, (RL_W - tw) / 2, 150, tw, 58, 29);
  ctx.fillStyle = "rgba(255,255,255,.16)"; ctx.fill();
  ctx.strokeStyle = "rgba(255,255,255,.45)"; ctx.lineWidth = 2; ctx.stroke();
  ctx.fillStyle = "#fff"; ctx.fillText(tag, RL_W / 2, 180);
  const cur = tl.scenes.filter((s) => t >= s.start - 0.1).pop() || tl.scenes[0];
  // 큰 글씨
  if (!cur.quiz && cur.big) {
    const kp = rlEase((t - cur.start) / 0.35);
    let fs = 84;
    ctx.font = `800 ${fs}px ${RL_FONT}`;
    let lines = rlWrap(ctx, cur.big, 960);
    if (lines.length > 2) { fs = 68; ctx.font = `800 ${fs}px ${RL_FONT}`; lines = rlWrap(ctx, cur.big, 960); }
    ctx.globalAlpha = kp;
    ctx.shadowColor = "rgba(0,0,0,.6)"; ctx.shadowBlur = 24;
    ctx.fillStyle = "#fff";
    lines.forEach((ln, i) => ctx.fillText(ln, RL_W / 2, 300 + i * fs * 1.22 + (1 - kp) * 30));
    ctx.shadowBlur = 0; ctx.globalAlpha = 1;
  }
  // 자막
  const seg = cur.segs.find((g) => t >= g.start - 0.05 && t < g.end + 0.25);
  if (seg) {
    ctx.font = `700 52px ${RL_FONT}`;
    const lines = rlWrap(ctx, seg.text, 920);
    lines.forEach((ln, i) => {
      const y = 1300 + i * 91;
      const w = ctx.measureText(ln).width + 36;
      rlRound(ctx, (RL_W - w) / 2, y - 40, w, 80, 14);
      ctx.fillStyle = "rgba(0,0,0,.62)"; ctx.fill();
      ctx.fillStyle = "#fff"; ctx.fillText(ln, RL_W / 2, y + 2);
    });
  }
  // 퀴즈 카드 + 3·2·1
  if (cur.quiz) {
    const [q, a] = [cur.segs[0], cur.segs[1]];
    const isAns = a && t >= a.start - 0.05;
    const cp = rlEase((t - (isAns ? a.start : cur.start)) / 0.3);
    ctx.font = `800 64px ${RL_FONT}`;
    const lines = rlWrap(ctx, isAns ? cur.quiz.a : cur.quiz.q, 820);
    const h = 120 + lines.length * 86;
    ctx.save();
    ctx.globalAlpha = cp;
    ctx.translate(RL_W / 2, 560 + h / 2); ctx.scale(0.9 + 0.1 * cp, 0.9 + 0.1 * cp); ctx.translate(-RL_W / 2, -(560 + h / 2));
    ctx.shadowColor = "rgba(0,0,0,.45)"; ctx.shadowBlur = 50;
    rlRound(ctx, 70, 560, RL_W - 140, h, 36);
    ctx.fillStyle = "rgba(255,255,255,.95)"; ctx.fill();
    ctx.shadowBlur = 0;
    ctx.font = `800 40px ${RL_FONT}`;
    ctx.fillStyle = isAns ? "#1b8a4b" : "#e2483d";
    ctx.fillText(isAns ? "정답" : "Q. 퀴즈", RL_W / 2, 610);
    ctx.font = `800 64px ${RL_FONT}`;
    ctx.fillStyle = "#16233f";
    lines.forEach((ln, i) => ctx.fillText(ln, RL_W / 2, 690 + i * 86));
    ctx.restore();
    if (a && q && t >= q.end && t < a.start) {
      const left = a.start - t;
      ctx.globalAlpha = rlEase(1 - (left % 1));
      ctx.beginPath(); ctx.arc(RL_W / 2, Math.max(985, 560 + h + 110), 75, 0, Math.PI * 2);
      ctx.fillStyle = "rgba(0,0,0,.7)"; ctx.fill();
      ctx.strokeStyle = "#ffd23f"; ctx.lineWidth = 4; ctx.stroke();
      ctx.fillStyle = "#ffd23f"; ctx.font = `800 96px ${RL_FONT}`;
      ctx.fillText(String(Math.ceil(left)), RL_W / 2, Math.max(985, 560 + h + 110) + 5);   // 카드가 세 줄이면 아래로 내린다
      ctx.globalAlpha = 1;
    }
  }
  // 학원 마크 — 맨 아래 띠, 왼쪽 학원명·오른쪽 로고(인쇄물 꼬리말과 같은 자리, 2026-11-19 사용자)
  const br = imgs.brand;
  if (br && (br.name || br.logo)) {
    const y = RL_H - 150, hh = 110;
    const g = ctx.createLinearGradient(0, y - 40, 0, RL_H);
    g.addColorStop(0, "rgba(0,0,0,0)"); g.addColorStop(0.35, "rgba(0,0,0,.55)"); g.addColorStop(1, "rgba(0,0,0,.75)");
    ctx.fillStyle = g; ctx.fillRect(0, y - 40, RL_W, RL_H - y + 40);
    let logoW = 0;
    if (br.logo && br.logo.naturalWidth) {
      const lh = 76, lw = Math.min(300, br.logo.naturalWidth * (lh / br.logo.naturalHeight));
      const lhh = lw * (br.logo.naturalHeight / br.logo.naturalWidth);
      logoW = lw + 28;
      rlRound(ctx, RL_W - 56 - lw - 14, y + (hh - lhh) / 2 - 10, lw + 28, lhh + 20, 14);
      ctx.fillStyle = "rgba(255,255,255,.92)"; ctx.fill();
      ctx.drawImage(br.logo, RL_W - 56 - lw, y + (hh - lhh) / 2, lw, lhh);
    }
    if (br.name) {
      ctx.textAlign = "left"; ctx.textBaseline = "middle";
      let fs = 44;
      ctx.font = `800 ${fs}px ${RL_FONT}`;
      const maxW = RL_W - 112 - logoW - 30;
      while (fs > 26 && ctx.measureText(br.name).width > maxW) { fs -= 2; ctx.font = `800 ${fs}px ${RL_FONT}`; }
      ctx.fillStyle = "#fff";
      ctx.fillText(br.name, 56, y + hh / 2);
      ctx.textAlign = "center";
    }
  }
  // 진행 막대
  ctx.fillStyle = "#ffd23f";
  ctx.fillRect(0, 0, RL_W * Math.min(t / tl.total, 1), 10);
}
// 학원 마크 — 학원 마크 칸(app.js, trend.js trendBrand)에 넣은 학원명·로고. 칸을 끄면 넣지 않는다
function rlBrand() {
  if (!(rlEl("rlBrandOn") && rlEl("rlBrandOn").checked)) return null;
  const b = typeof trendBrand === "function" ? trendBrand() : { img: "", name: "" };
  return (b.name || b.img) ? { name: b.name, img: b.img } : null;
}
const rlBrandKey = () => { const b = rlBrand(); return b ? `${b.name}|${b.img.length}|${b.img.slice(-40)}` : ""; };

/* ── 재생·녹화 ── */
let rlPlaying = null;   // 미리 보기 중인 재생(rlPlay가 돌려준 ctl)
function rlLoadImg(src) {
  return new Promise((res) => {
    if (!src) return res(null);
    const im = new Image();
    im.onload = () => res(im); im.onerror = () => res(null);
    im.src = src;
  });
}
async function rlLoadImgs(e) {
  const imgs = await Promise.all(e.script.scenes.map((_, i) => rlLoadImg(e.images[i])));
  const b = rlBrand();
  imgs.brand = b ? { name: b.name, logo: await rlLoadImg(b.img) } : null;
  return imgs;
}
// 화면이 다른 탭으로 가도 멈추지 않는 시계 — 브라우저는 숨은 탭의 requestAnimationFrame·setInterval을 멈추거나
// 1초에 한 번으로 늦추지만, 워커가 보내는 메시지는 그대로 받는다(뒤에서 녹화할 때 쓴다)
const RL_TICK_SRC = "let id;onmessage=(e)=>{clearInterval(id);if(e.data>0)id=setInterval(()=>postMessage(0),e.data);}";
function rlTicker(ms, fn) {
  const url = URL.createObjectURL(new Blob([RL_TICK_SRC], { type: "text/javascript" }));
  const w = new Worker(url);
  w.onmessage = fn;
  w.postMessage(ms);
  return () => { w.terminate(); URL.revokeObjectURL(url); };
}
const RL_MIMES = ["video/mp4;codecs=avc1.640028,mp4a.40.2", "video/mp4;codecs=avc1,mp4a.40.2", "video/mp4",
  "video/webm;codecs=vp9,opus", "video/webm"];
// 재생(미리 보기) 또는 녹화. silent면 스피커로 내보내지 않고(뒤에서 녹화) 워커 시계로 그린다.
// 반환 ctl — ctl.done은 {blob, mime}(멈추면 blob null), ctl.stop()으로 멈춘다
function rlPlay(e, canvas, { record = false, silent = false, onEnd, onProgress } = {}) {
  // 그림을 읽는 동안 멈추면(재생 시작 직후 전체 화면을 누를 때) 그대로 틀어 소리가 겹치지 않게 표시해 둔다
  const ctl = { stop: () => { ctl.cancelled = true; } };
  ctl.done = (async () => {
    const tl = rlTimeline(e);
    const imgs = await rlLoadImgs(e);
    if (ctl.cancelled) { if (onEnd) onEnd(); return { blob: null, mime: "" }; }
    const ctx = canvas.getContext("2d");
    const ac = new (window.AudioContext || window.webkitAudioContext)();
    const dest = ac.createMediaStreamDestination();
    const els = e.audio.map((a) => {
      const el = new Audio(a.url);
      el.preservesPitch = true;
      el.playbackRate = rlSpeedOf(e);
      const src = ac.createMediaElementSource(el);
      if (!silent) src.connect(ac.destination);
      if (record) src.connect(dest);
      return el;
    });
    let rec = null, chunks = [], mime = "";
    if (record) {
      const stream = canvas.captureStream(RL_FPS);
      dest.stream.getAudioTracks().forEach((tr) => stream.addTrack(tr));
      mime = RL_MIMES.find((m) => window.MediaRecorder && MediaRecorder.isTypeSupported(m)) || "";
      if (!mime) { ac.close().catch(() => {}); throw new Error("이 브라우저는 영상 녹화를 지원하지 않습니다 — PC 크롬에서 열어 주세요."); }
      rec = new MediaRecorder(stream, { mimeType: mime, videoBitsPerSecond: 8_000_000, audioBitsPerSecond: 192_000 });
      rec.ondataavailable = (ev) => { if (ev.data && ev.data.size) chunks.push(ev.data); };
      rec.start(1000);
    }
    await ac.resume();
    if (ctl.cancelled) { if (rec) try { rec.stop(); } catch (_e) { /* */ } ac.close().catch(() => {}); if (onEnd) onEnd(); return { blob: null, mime }; }
    const started = new Set();
    const t0 = performance.now();
    let raf = 0, untick = null, done = false;
    let resolveEnded;
    const ended = new Promise((resolve) => { resolveEnded = resolve; });
    const finish = (stopped) => {
      if (done) return;
      done = true;
      cancelAnimationFrame(raf);
      if (untick) untick();
      els.forEach((el) => el.pause());
      const close = () => ac.close().catch(() => {});
      if (rec && !stopped) {
        rec.onstop = () => { close(); resolveEnded(new Blob(chunks, { type: mime.split(";")[0] })); };
        setTimeout(() => rec.stop(), 200);
      } else {
        if (rec) try { rec.stop(); } catch (_e) { /* 이미 멈춤 */ }
        close();
        resolveEnded(null);
      }
    };
    const frame = () => {
      if (done) return;
      const t = (performance.now() - t0) / 1000;
      rlDraw(ctx, e, tl, imgs, Math.min(t, tl.total));
      if (onProgress) onProgress(Math.min(t / tl.total, 1));
      tl.segs.forEach((g) => {
        if (!started.has(g.k) && t >= g.start) { started.add(g.k); els[g.k].currentTime = 0; els[g.k].play().catch(() => {}); }
      });
      if (t >= tl.total) { finish(false); return; }
      if (!silent) raf = requestAnimationFrame(frame);
    };
    if (silent) untick = rlTicker(Math.round(1000 / RL_FPS), frame);
    else raf = requestAnimationFrame(frame);
    ctl.stop = () => finish(true);
    const blob = await ended;
    if (onEnd) onEnd();
    return { blob, mime };
  })();
  return ctl;
}

/* ── 만든 뒤 바로 받기(2026-11-19 사용자) ──
   릴스가 다 만들어지면(그림·목소리가 모두 있으면) 뒤에서 소리 없이 영상 파일을 녹화해 둔다 — 한 편씩 차례로,
   다음 지문을 만드는 동안에도. 끝나면 [⬇ 영상 받기]가 누르는 즉시 내려받는다. 빠르기·그림·목소리가 바뀌면
   (rlVidSig가 달라지면) 지난 파일을 버리고 다시 녹화한다. 녹화는 영상 길이만큼 걸린다(재생하며 찍는 방식). */
const rlVidSig = (e) => `${rlSpeedOf(e)}|${e.images.join(",")}|${(e.audio || []).map((a) => a && a.url).join(",")}|${rlBrandKey()}`;
const rlReady = (e) => !!(e && e.script && e.audio && e.audio.every(Boolean) && e.images.length && e.images.every(Boolean));
const rlVidOk = (e) => !!(e.video && e.video.sig === rlVidSig(e));
let rlMp4Ok = null;   // 정식 mp4를 만들 수 있는 브라우저인가(처음 한 번 묻는다)
let rlRecQueue = [], rlRecNow = null;   // rlRecNow = {e, ctl, sig}
function rlDropVideo(e) {
  if (e.video && e.video.url) URL.revokeObjectURL(e.video.url);
  e.video = null;
}
function rlQueueRecord(e) {
  if (!rlReady(e) || rlVidOk(e) || rlRecQueue.includes(e)) return;
  if (rlRecNow && rlRecNow.e === e && rlRecNow.sig === rlVidSig(e)) return;
  if (rlRecNow && rlRecNow.e === e) rlRecNow.ctl.stop();   // 바뀌었다 — 하던 녹화는 버린다
  rlDropVideo(e);
  rlRecQueue.push(e);
  rlRecPump();
}
function rlRecAbortAll() {
  rlRecQueue = [];
  if (rlRecNow) rlRecNow.ctl.stop();
  else { const w = rlRecWaiters; rlRecWaiters = []; w.forEach((f) => f()); }
}
// 녹화가 모두 끝나기를 기다린다(만들기 칸이 '제작 완료'를 그 뒤에 띄운다 — 2026-11-19 사용자: 완료라고 해서 눌렀는데
// 아직 파일이 없으면 짜증 난다)
let rlRecWaiters = [];
const rlRecIdle = () => (!rlRecNow && !rlRecQueue.length) ? Promise.resolve()
  : new Promise((res) => rlRecWaiters.push(res));
let rlRecNote = null;   // 만들기 칸의 진행 글(rlMake가 녹화를 기다리는 동안만)
function rlRecShow(e, pct) {
  if (rlRecNote) rlRecNote(e, pct);
  const i = rlState.entries.indexOf(e);
  const b = rlEl("rlResult").querySelector(`.rl-card[data-i="${i}"] .rl-dl`);
  if (b && !rlVidOk(e)) b.textContent = `🎞️ 영상 파일 만드는 중 ${Math.round(pct * 100)}%`;
}
async function rlRecPump() {
  if (rlRecNow || !rlRecQueue.length) return;
  const e = rlRecQueue.shift();
  if (!rlState.entries.includes(e) || !rlReady(e) || rlVidOk(e)) { rlRecPump(); return; }
  const sig = rlVidSig(e);
  const canvas = document.createElement("canvas");
  canvas.width = RL_W; canvas.height = RL_H;
  // 정식 mp4(reels_mp4.js — 초 이동·인스타그램 업로드가 되는 보통 mp4)를 먼저 쓰고, 이 브라우저가 못 하면 예전처럼 재생하며 녹화한다.
  // 묻는 동안(await) 다른 녹화가 끼어들지 않게 자리를 먼저 잡아 둔다
  rlRecNow = { e, ctl: { stop: () => {} }, sig };
  if (rlMp4Ok === null) rlMp4Ok = typeof rlmSupported === "function" ? await rlmSupported() : false;
  const ctl = rlMp4Ok ? rlEncodeMp4(e, { onProgress: (p) => rlRecShow(e, p) })
    : rlPlay(e, canvas, { record: true, silent: true, onProgress: (p) => rlRecShow(e, p) });
  rlRecNow.ctl = ctl;
  try {
    const { blob, mime } = await ctl.done;
    if (blob && blob.size && rlState.entries.includes(e) && rlVidSig(e) === sig) {
      rlDropVideo(e);
      e.video = { blob, url: URL.createObjectURL(blob), ext: mime.startsWith("video/mp4") ? "mp4" : "webm", sig };
      e.vidError = "";
    }
  } catch (err) {
    e.vidError = err.message || String(err);
  }
  rlRecNow = null;
  // 카드를 통째로 다시 그리면 미리 보기 중인 화면이 끊긴다 — 단추만 바꾼다(실패했을 때만 다시 그린다)
  const i = rlState.entries.indexOf(e);
  const btn = i >= 0 && rlEl('rlResult').querySelector(`.rl-card[data-i="${i}"] .rl-dl`);
  if (btn && rlVidOk(e)) {
    btn.disabled = false;
    btn.textContent = `⬇ 영상 받기 (${e.video.ext}, ${(e.video.blob.size / 1e6).toFixed(0)}MB)`;
  } else if (i >= 0) rlRender();
  if (!rlRecQueue.length) { const w = rlRecWaiters; rlRecWaiters = []; w.forEach((f) => f()); }
  rlRecPump();
}
// 제작 완료 창 — 영상 파일이 다 준비된 뒤에 띄운다. 창 안의 단추로 바로 받는다(사이트 공용 완료 창은 인쇄 안내라 따로 둔다)
function rlDoneDialog() {
  const list = rlState.entries.filter((e) => e.script);
  const ok = list.filter(rlVidOk);
  let ov = rlEl("rlDoneOverlay");
  if (!ov) {
    ov = document.createElement("div");
    ov.id = "rlDoneOverlay";
    ov.className = "rl-done-overlay";
    document.body.appendChild(ov);
    ov.addEventListener("click", (ev) => {
      if (ev.target === ov || ev.target.closest(".rl-done-close")) { ov.hidden = true; return; }
      const b = ev.target.closest("[data-dl]");
      if (b) {
        const e = rlState.entries[+b.dataset.dl];
        if (e && rlVidOk(e)) { rlDownload(e); b.textContent = "✅ 받았습니다"; }
        return;
      }
      if (ev.target.closest(".rl-done-all")) {
        ov.querySelectorAll("[data-dl]").forEach((x, n) => setTimeout(() => x.click(), n * 600));
      }
    });
  }
  const fail = list.length - ok.length;
  ov.innerHTML = `<div class="rl-done-box" role="dialog" aria-modal="true">
    <h3>✅ 숏폼 영상 제작 완료</h3>
    <p>영상 파일 <b>${ok.length}편</b>이 준비됐습니다. 아래 단추를 누르면 바로 내려받습니다.${fail ? `<br><span class="rl-done-warn">⚠️ ${fail}편은 영상 파일을 만들지 못했습니다 — 카드의 안내를 확인해 주세요.</span>` : ""}</p>
    <ul>${ok.map((e) => `<li><span>🎬 ${esc(e.script.title || e.name)} <small>${esc(e.name)} · ${e.video.ext} · ${(e.video.blob.size / 1e6).toFixed(0)}MB</small></span>
      <button type="button" class="btn small" data-dl="${rlState.entries.indexOf(e)}">⬇ 영상 받기</button></li>`).join("")}</ul>
    <p class="hint">AI가 만든 영상이라 내용·자막이 틀릴 수 있습니다 — 올리기 전에 ▶ 미리 보기로 한 번 확인해 주세요.<br>영상 파일은 사이트에 저장되지 않습니다 — 여기서 받아 두세요(💾 사이트 저장은 대본·그림·목소리만 남깁니다).</p>
    <div class="actions">${ok.length > 1 ? `<button type="button" class="btn rl-done-all">⬇ 모두 받기</button>` : ""}
      <button type="button" class="btn ghost rl-done-close">닫기</button></div></div>`;
  ov.hidden = false;
}
// 전체 화면 보기(2026-11-19 사용자) — 영상 파일이 있으면 그 mp4를 재생기(컨트롤·초 이동)로, 없으면 미리 보기 캔버스를 전체 화면으로
function rlFullscreen(e, card) {
  if (rlVidOk(e)) {
    const v = document.createElement("video");
    v.className = "rl-fullvideo";
    v.src = e.video.url;
    v.controls = true;
    v.playsInline = true;
    document.body.appendChild(v);
    const drop = () => { v.pause(); v.remove(); document.removeEventListener("fullscreenchange", done); };
    const done = () => { if (!document.fullscreenElement) drop(); };
    document.addEventListener("fullscreenchange", done);
    if (!v.requestFullscreen && v.webkitEnterFullscreen) {   // 아이폰 사파리 — 영상만 전체 화면이 된다
      v.addEventListener("webkitendfullscreen", drop, { once: true });
      v.play().then(() => v.webkitEnterFullscreen()).catch(drop);
      return;
    }
    let entered = false;
    (v.requestFullscreen ? v.requestFullscreen() : Promise.reject()).then(() => { entered = true; v.play().catch(() => {}); }, drop);
    setTimeout(() => { if (!entered && document.fullscreenElement !== v) drop(); }, 4000);   // 브라우저가 답하지 않으면 치운다
    return;
  }
  const stage = card.querySelector(".rl-stage");
  if (!stage || !stage.requestFullscreen) return;
  stage.requestFullscreen().then(() => {
    const play = card.querySelector(".rl-play");
    if (play && !play.disabled) play.click();   // 아직 파일이 없으면 미리 보기를 그대로 크게 튼다
    const out = () => { if (!document.fullscreenElement) { if (rlPlaying) rlPlaying.stop(); document.removeEventListener("fullscreenchange", out); } };
    document.addEventListener("fullscreenchange", out);
  }).catch(() => {});
}
function rlDownload(e) {
  const a = document.createElement("a");
  a.href = e.video.url;
  a.download = `${sanitizeFilename(["숏폼", e.name, e.script.title].filter(Boolean).join("_"))}.${e.video.ext}`;
  document.body.appendChild(a); a.click(); a.remove();
}
// 멈춘 화면(첫 장면 + 제목)
async function rlPoster(e, canvas) {
  if (!e.audio || !e.script) return;
  const tl = rlTimeline(e);
  const imgs = await rlLoadImgs(e);
  rlDraw(canvas.getContext("2d"), e, tl, imgs, 1.2);
}

/* ── 결과 그리기 ── */
function rlCardHtml(e, i) {
  if (e.error && !e.script) {
    return `<section class="rl-card" data-i="${i}"><div class="passage-error">⚠️ ${esc(e.name)} — ${esc(e.error)}</div></section>`;
  }
  const sc = e.script.scenes;
  const missing = sc.filter((_, k) => !e.images[k]).length;
  const ready = rlReady(e);
  return `<section class="rl-card" data-i="${i}">
    <div class="rl-stage"><canvas class="rl-canvas" width="${RL_W}" height="${RL_H}"></canvas></div>
    <div class="rl-side">
      <h3 class="rl-title">🎬 ${esc(e.script.title || e.name)} <span class="rl-sub">${esc(e.name)} · 목소리 ${esc(e.voice)}${e.audio ? ` · ${rlTimeline(e).total.toFixed(0)}초` : ""}</span></h3>
      ${e.error ? `<div class="passage-error">⚠️ ${esc(e.error)}</div>` : ""}
      ${e.vidError ? `<div class="passage-error">⚠️ 영상 파일을 만들지 못했습니다 — ${esc(e.vidError)}</div>` : ""}
      ${rlVidOk(e) && e.video.ext === "webm" ? `<div class="hint">이 브라우저는 mp4 녹화를 지원하지 않아 webm으로 만들었습니다 — 인스타그램에 올리려면 PC 크롬을 권합니다.</div>` : ""}
      <div class="actions">
        <button type="button" class="btn ghost rl-play"${ready ? "" : " disabled"}>▶ 미리 보기</button>
        <button type="button" class="btn ghost rl-stop" hidden>■ 멈추기</button>
        <button type="button" class="btn ghost rl-full"${ready ? "" : " disabled"}
                title="영상 파일이 준비됐으면 그 파일을 전체 화면 재생기로(초 이동 가능), 아직이면 미리 보기를 전체 화면으로 엽니다. Esc로 나옵니다.">⛶ 전체 화면</button>
        <button type="button" class="btn rl-dl"${rlVidOk(e) ? "" : " disabled"}
                title="다 만든 영상은 뒤에서 영상 파일로 미리 만들어 둡니다(영상 길이만큼 걸립니다). 준비되면 누르는 즉시 내려받습니다.">${
          rlVidOk(e) ? `⬇ 영상 받기 (${e.video.ext}, ${(e.video.blob.size / 1e6).toFixed(0)}MB)` : ready ? "🎞️ 영상 파일 기다리는 중…" : "⬇ 영상 받기"}</button>
        <label class="rl-speed-card">빠르기 ${rlSpeedRange("rl-speed-sel", rlSpeedOf(e))}</label>
        ${!e.audio ? `<button type="button" class="btn ghost rl-voice-redo">🔁 목소리 다시 만들기</button>` : ""}
        ${missing ? `<button type="button" class="btn ghost rl-img-redo">🖼️ 빠진 그림 ${missing}장 그리기</button>` : ""}
      </div>
      <div class="hint rl-status"></div>
      <ol class="rl-scenes">${sc.map((s, k) => `<li>
        ${e.images[k] ? `<img src="${e.images[k]}" alt="">` : `<span class="rl-noimg">그림 없음</span>`}
        <div><b>${esc(s.quiz ? "퀴즈" : (s.big || "").replace(/\n/g, " "))}</b>
        ${s.say.map((x) => `<span>${esc(x)}</span>`).join("")}
        <button type="button" class="btn ghost small rl-redraw" data-k="${k}">🔄 그림 다시</button></div></li>`).join("")}</ol>
    </div></section>`;
}
function rlRender() {
  const box = rlEl("rlResult");
  box.innerHTML = rlState.entries.map(rlCardHtml).join("");
  box.querySelectorAll(".rl-card").forEach((card) => {
    const e = rlState.entries[+card.dataset.i];
    const cv = card.querySelector(".rl-canvas");
    if (cv && e.script && e.audio) rlPoster(e, cv);
  });
  rlState.entries.forEach(rlQueueRecord);   // 다 만든 것은 뒤에서 영상 파일로(이미 있거나 줄에 있으면 그대로)
  const has = rlState.entries.some((e) => e.script);
  rlEl("rlSaveBtn").style.display = has ? "" : "none";
  rlEl("rlSaveNote").hidden = !has;
}

/* ── 서버 부르기 ── */
const rlRetryNote = (el) => (n) => { el.textContent = `연결이 끊겨 다시 받아 오는 중… (${n})`; };
async function rlMakeVoice(e, note) {
  const lines = e.script.scenes.flatMap((s) => s.say);
  const d = await postGenerate("/api/reelvoice", { lines, voice: e.voice }, "목소리를 만들지 못했습니다.", note);
  e.audio = d.lines.map((l) => {
    const y = rlCleanPcm(rlPcmFromB64(l.pcm), l.rate);
    return rlAudioFromWav(rlWavBlob(y, l.rate), l.rate, y.length);
  });
}
async function rlMakeImage(e, k, note) {
  const s = e.script.scenes[k];
  if (rlIsCard(e)) {   // 카드뉴스 — 서버를 부르지 않고 여기서 배경 카드를 그린다(값 없음)
    e.images[k] = rlBlob(URL.createObjectURL(await rlCardImage(rlCardOf(e), k, e.script.scenes.length)));
    return;
  }
  const d = await postGenerate("/api/reelimage", { cast: e.script.cast, scene: s.img, style: rlStyleOf(e) }, "장면 그림을 그리지 못했습니다.", note);
  e.images[k] = rlBlob(b64ToBlobUrl(d.image, d.mime || "image/jpeg"));
}
async function rlMakeImages(e, ks, note) {
  let stop = null;
  // runPool은 목록에서 거짓 값(0)을 만나면 멈추므로 장면 번호를 상자에 담아 넘긴다(첫 장면 0번이 빠졌다)
  await runPool(ks.map((k) => ({ k })), RL_IMG_PARALLEL, async ({ k }) => {
    if (stop) return;
    try { await rlMakeImage(e, k, note); } catch (err) {
      if (err.code === "quota" || err.code === "no_tokens") stop = err;
      else e.error = err.message || String(err);
    }
  });
  if (stop) throw stop;
}

/* ── 지문이 여러 칸일 때: 하나로 합칠지 각각 만들지 ── */
function rlMergeJobs(jobs) {
  const heads = jobs.map((j) => String(j.name || "").split(" · ")[0].trim());
  const same = heads[0] && heads.every((h) => h === heads[0]);
  const name = same ? heads[0] : `${jobs[0].name || "지문 1"} 외 ${jobs.length - 1}개`;
  return { name, text: jobs.map((j) => j.text.trim()).join("\n\n") };
}
function rlAskMerge(jobs) {
  return new Promise((resolve) => {
    const n = jobs.length, each = rlEachCost(), shown = Math.min(n, RL_MAX_PASSAGES);
    const cost = (k) => (each === null ? "" : ` · 예상 ${pt(each * k)}`);
    const chars = jobs.reduce((s, j) => s + j.text.length, 0);
    const ov = document.createElement("div");
    ov.style.cssText = "position:fixed;inset:0;z-index:9999;background:rgba(0,0,0,.5);display:flex;align-items:center;justify-content:center;padding:16px;";
    ov.innerHTML = `<div role="dialog" aria-modal="true" style="background:var(--card,#fff);color:var(--text,#111);max-width:460px;width:100%;border-radius:14px;padding:20px;box-shadow:0 10px 40px rgba(0,0,0,.35);">` +
      `<h3 style="margin:0 0 6px;font-size:18px;">지문이 ${n}개 들어 있어요</h3>` +
      `<p style="margin:0 0 14px;font-size:14px;color:var(--muted,#64748b);">한 단원을 여러 칸으로 나눠 넣으셨다면 합쳐서 한 편으로 만들 수 있어요.</p>` +
      `<button type="button" class="btn" data-h="merge" style="display:block;width:100%;margin-bottom:8px;text-align:left;">🔗 하나로 합쳐서 영상 1편 만들기<br><small>지문 ${n}개를 이어서 한 이야기로${cost(1)}${chars > 3500 ? " · 글이 길어 영상이 길어질 수 있어요" : ""}</small></button>` +
      `<button type="button" class="btn ghost" data-h="each" style="display:block;width:100%;margin-bottom:8px;text-align:left;">📑 지문마다 따로 ${shown}편 만들기<br><small>${n > RL_MAX_PASSAGES ? `앞의 ${RL_MAX_PASSAGES}개만${cost(shown)}` : cost(shown).replace(/^ · /, "")}</small></button>` +
      `<button type="button" class="btn ghost small" data-h="" style="display:block;margin-left:auto;">취소</button></div>`;
    const done = (v) => { ov.remove(); resolve(v); };
    ov.addEventListener("click", (ev) => {
      const b = ev.target.closest("[data-h]");
      if (b) done(b.dataset.h);
      else if (ev.target === ov) done("");
    });
    document.body.appendChild(ov);
    ov.querySelector("[data-h=merge]").focus();
  });
}

async function rlMake() {
  const errEl = rlEl("rlError");
  errEl.textContent = "";
  let jobs = rlJobs();
  if (!jobs.length) { errEl.textContent = "위쪽 영어 지문 칸에 지문을 넣어 주세요 (20자 이상)."; return; }
  if (jobs.length > 1) {
    // 한 단원을 지문 여러 칸으로 나눠 두었을 수 있다 — 하나로 이어 영상 한 편으로 만들지, 지문마다 한 편씩 만들지 묻는다(2026-11-19 사용자)
    const how = await rlAskMerge(jobs);
    if (!how) return;
    if (how === "merge") jobs = [rlMergeJobs(jobs)];
  }
  if (jobs.length > RL_MAX_PASSAGES) {
    errEl.textContent = `한 번에 지문 ${RL_MAX_PASSAGES}개까지 만듭니다 — 앞의 ${RL_MAX_PASSAGES}개만 만들어요.`;
    jobs = jobs.slice(0, RL_MAX_PASSAGES);
  }
  const voices = jobs.map((j, i) => rlVoiceFor(j, i));
  if (!voices[0]) { errEl.textContent = "목소리를 하나 이상 골라 주세요."; return; }
  if (!(await costConfirmed(rlEachCost() === null ? null : rlEachCost() * jobs.length,
    `${REELS_NAME} · 지문 ${jobs.length}개 · 목소리 ${[...new Set(voices)].join(", ")}`, jobs.length, reduceAdvice(jobs.length, "")))) return;
  if (typeof dropStaleSavedLink === "function") dropStaleSavedLink("reels");
  if (rlPlaying) rlPlaying.stop();
  rlRecAbortAll();
  rlState.entries.forEach(rlDropVideo);
  rlState.busy = true;
  rlEl("rlMakeBtn").disabled = true;
  const loading = rlEl("rlLoading");
  const text = rlEl("rlLoadingText");
  const gate = runGate(loading);
  gate.begin();
  loading.classList.add("on");
  rlDropBlobs();
  rlState.entries = [];
  rlRender();
  let ok = 0;
  const note = rlRetryNote(text);
  try {
    for (let i = 0; i < jobs.length; i++) {
      if (i && await gate.check(`지문 ${i}개까지 만들었습니다.`, rlRender)) {
        errEl.textContent = runEndedNote(jobs.length - i, "지문");
        break;
      }
      const j = jobs[i];
      const voice = voices[i];
      const e = { name: j.name, text: j.text, voice, speed: rlSpeedPick(), imgStyle: rlStylePick(), cardColor: rlCardPick(), tag: j.name, explain: null, script: null, images: [], audio: null };
      rlState.entries.push(e);
      try {
        text.textContent = `AI가 ${j.name}의 내용을 정리하고 대본을 쓰고 있습니다… (${i + 1}/${jobs.length})`;
        const d = await postGenerate("/api/reelscript", { passage: j.text }, "영상 대본을 만들지 못했습니다.", note);
        e.explain = d.explain;
        e.script = d.script;
        e.images = e.script.scenes.map(() => null);
        rlRender();
        // 목소리와 그림을 함께 만든다 — 차례로 하면 그림만 2분 가까이 걸렸다(2026-11-19 실측: 대본 38초 · 목소리 13초 · 그림 3장씩 112초)
        text.textContent = `${voice} 목소리로 녹음하면서 장면 그림 ${e.script.scenes.length}장을 그리고 있습니다… (${i + 1}/${jobs.length})`;
        const voiceP = rlMakeVoice(e, note).catch((err) => {
          if (err.code === "quota" || err.code === "no_tokens") throw err;
          e.error = err.message || String(err);
        });
        await Promise.all([voiceP, rlMakeImages(e, e.script.scenes.map((_, k) => k), note)]);
        ok++;
      } catch (err) {
        e.error = err.message || String(err);
        if (err.code === "quota" || err.code === "no_tokens") { errEl.textContent = err.message; rlRender(); break; }
      }
      rlRender();
    }
    if (ok) {
      // 영상 파일까지 다 만든 뒤에 '완료'를 띄운다 — 그동안 진행 칸은 그대로 둔다
      rlRender();
      const made = rlState.entries.filter(rlReady);
      rlRecNote = (e, pct) => {
        const n = made.indexOf(e);
        if (n >= 0) text.textContent = `🎞️ 영상 파일을 만들고 있습니다… ${made.length > 1 ? `(${n + 1}/${made.length}) ` : ""}${Math.round(pct * 100)}%` +
          " — 이 창은 그대로 두세요";
      };
      text.textContent = "🎞️ 영상 파일을 만들고 있습니다…";
      await rlRecIdle();
      rlRecNote = null;
      const got = rlState.entries.filter(rlVidOk).length;
      rlDoneDialog();
    }
  } finally {
    rlRecNote = null;
    rlState.busy = false;
    rlEl("rlMakeBtn").disabled = false;
    loading.classList.remove("on");
    refreshTokenDisplay();
  }
}
rlEl("rlMakeBtn").addEventListener("click", () => { if (!rlState.busy) rlMake(); });

rlEl("rlResult").addEventListener("input", (ev) => {
  const r = ev.target.closest(".rl-speed-sel");
  if (r) r.nextElementSibling.textContent = rlSpeedText(r.value);
});
rlEl("rlResult").addEventListener("change", (ev) => {
  const sel = ev.target.closest(".rl-speed-sel");
  if (!sel) return;
  const e = rlState.entries[+sel.closest(".rl-card").dataset.i];
  if (rlPlaying) rlPlaying.stop();
  e.speed = +sel.value;
  rlRender();
});
rlEl("rlResult").addEventListener("click", async (ev) => {
  const card = ev.target.closest(".rl-card");
  if (!card) return;
  const e = rlState.entries[+card.dataset.i];
  const cv = card.querySelector(".rl-canvas");
  const status = card.querySelector(".rl-status");
  const playB = card.querySelector(".rl-play"), stopB = card.querySelector(".rl-stop");
  const busy = (on) => { if (playB) playB.disabled = on; if (stopB) stopB.hidden = !on; };
  if (ev.target.closest(".rl-stop")) { if (rlPlaying) rlPlaying.stop(); status.textContent = ""; busy(false); return; }
  if (ev.target.closest(".rl-play")) {
    if (rlPlaying) rlPlaying.stop();
    busy(true);
    status.textContent = "재생 중…";
    const ctl = rlPlay(e, cv, { onEnd: () => { busy(false); status.textContent = ""; if (rlPlaying === ctl) rlPlaying = null; } });
    rlPlaying = ctl;
    ctl.done.catch((err) => { status.textContent = "⚠️ " + (err.message || err); busy(false); });
    return;
  }
  if (ev.target.closest(".rl-full")) {
    // 미리 보기를 틀어 둔 채 영상 파일을 전체 화면으로 틀면 소리가 두 겹으로 났다(2026-11-19 사용자) — 먼저 멈춘다.
    // 파일이 없을 때는 rlFullscreen이 미리 보기를 처음부터 다시 트므로 역시 멈춰 두어도 된다
    if (rlPlaying) rlPlaying.stop();
    rlPlaying = null;
    status.textContent = ""; busy(false);
    rlFullscreen(e, card);
    return;
  }
  if (ev.target.closest(".rl-dl")) {
    if (rlVidOk(e)) { rlDownload(e); status.textContent = `✅ 내려받았습니다(${e.video.ext}).`; }
    return;
  }
  const one = async (label, fn) => {
    if (rlState.busy) return;
    rlState.busy = true;
    status.textContent = label;
    try { await fn(); e.error = ""; } catch (err) { e.error = err.message || String(err); }
    rlState.busy = false;
    refreshTokenDisplay();
    rlRender();
  };
  const p = rlPrice();
  const redraw = ev.target.closest(".rl-redraw");
  if (redraw) {
    const k = +redraw.dataset.k;
    if (!rlIsCard(e) && !(await costConfirmed(p ? p.reelImage : null, `${REELS_NAME} · 장면 그림 1장 다시 그리기`, 1, ""))) return;
    await one("그림을 다시 그리고 있습니다…", () => rlMakeImage(e, k, rlRetryNote(status)));
    return;
  }
  if (ev.target.closest(".rl-img-redo")) {
    const ks = e.script.scenes.map((_, k) => k).filter((k) => !e.images[k]);
    if (!rlIsCard(e) && !(await costConfirmed(p ? p.reelImage * ks.length : null, `${REELS_NAME} · 장면 그림 ${ks.length}장`, 1, ""))) return;
    await one("빠진 그림을 그리고 있습니다…", () => rlMakeImages(e, ks, rlRetryNote(status)));
    return;
  }
  if (ev.target.closest(".rl-voice-redo")) {
    if (!(await costConfirmed(p ? p.reelVoice : null, `${REELS_NAME} · 목소리 ${e.voice}`, 1, ""))) return;
    await one("목소리를 만들고 있습니다…", () => rlMakeVoice(e, rlRetryNote(status)));
  }
});

/* ── 저장 ── */
// 저장본 그림·목소리 key — 지문 e, 장면 s / 대사 a (서버 _SAVED_IMG_KEY_RE: 소문자·숫자·_)
const rlImgKey = (ei, k) => `e${ei}s${k}`;
const rlWavKey = (ei, k) => `e${ei}a${k}`;
const rlSavedSrc = new Map();   // 이미 올린 것(저장본 id|key → 주소) — 같은 것을 다시 올리지 않는다
const blobToB64 = (blob) => new Promise((res, rej) => {
  const r = new FileReader();
  r.onload = () => res(String(r.result).split(",")[1] || "");
  r.onerror = rej;
  r.readAsDataURL(blob);
});
rlEl("rlSaveBtn").addEventListener("click", () => openSaveDialog("reels"));
rlEl("rlLoadBtn").addEventListener("click", () => openSavedList("tab", null, "reels"));
TAB_LABELS.reels = "🎬 " + REELS_NAME;
TAB_LIBRARY_WORDS.reels = {
  title: `🎬 ${REELS_NAME} 저장함`,
  lead: "저장해 둔 숏폼 영상의 대본·장면 그림·목소리입니다(영상 파일은 저장되지 않습니다). [불러오기]를 누르면 AI를 다시 부르지 않고 영상을 다시 만들어 바로 받을 수 있습니다.",
  empty: "아직 저장한 숏폼 영상이 없습니다. 만든 뒤 “💾 사이트 저장”을 눌러 보세요.",
};
SAVE_TITLE_SUGGEST.reels = () => passageBasedName("숏폼 영상");
TAB_SAVE.reels = {
  canSave: () => (rlState.entries.some((e) => e.script) ? "" : "저장할 숏폼 영상이 없습니다. 먼저 만들어 주세요."),
  getPayload: () => {
    const saved = rlState.entries.filter((e) => e.script);
    const images = [];
    saved.forEach((e, ei) => {
      e.images.forEach((src, k) => { if (src) images.push({ entry: ei, lang: "reel", key: rlImgKey(ei, k) }); });
      (e.audio || []).forEach((_a, k) => images.push({ entry: ei, lang: "wav", key: rlWavKey(ei, k) }));
    });
    return {
      v: 1,
      passages: passageMgr.getJobs(),
      entries: saved.map((e) => ({ name: e.name, text: e.text, voice: e.voice, tag: e.tag, explain: e.explain, script: e.script,
        speed: rlSpeedOf(e), imgStyle: rlStyleOf(e), cardColor: rlCardOf(e), raws: (e.audio || []).map((a) => +a.raw.toFixed(3)) })),
      images,
    };
  },
  afterSave: async (itemId, payload, onProgress) => {
    const saved = rlState.entries.filter((e) => e.script);
    const todo = (payload.images || []).map((m) => {
      const e = saved[m.entry];
      const k = +m.key.split(/[sa]/)[1];
      const src = m.lang === "wav" ? e.audio && e.audio[k] && e.audio[k].url : e.images[k];
      return { m, e, k, src };
    }).filter((x) => x.src && rlSavedSrc.get(itemId + "|" + x.m.key) !== x.src);
    let failed = 0;
    const reasons = new Set();
    if (onProgress && todo.length) onProgress(0, todo.length);
    for (let n = 0; n < todo.length; n++) {
      const { m, src } = todo[n];
      try {
        const blob = await fetch(src).then((r) => r.blob());
        let mime = "audio/wav", b64;
        if (m.lang === "wav") b64 = await blobToB64(blob);
        else { const fit = await fitImageForSave(blob); mime = fit.mime; b64 = fit.b64; }
        await postJson("/api/saved-image", { id: itemId, key: m.key, mime, image: b64 }, "저장에 실패했습니다.");
        rlSavedSrc.set(itemId + "|" + m.key, src);
      } catch (err) { failed++; reasons.add((err && err.message) || String(err)); }
      if (onProgress) onProgress(n + 1, todo.length);
    }
    if (failed) throw new Error(`대본은 저장됐지만 그림·목소리 ${failed}개는 저장하지 못했습니다 — ${[...reasons].join(" / ")} 다시 저장해 보세요.`);
  },
  afterLoad: async (itemId, payload) => {
    const metas = Array.isArray(payload.images) ? payload.images : [];
    const got = await fetchSavedImages(itemId, metas, (m, d) => {
      const e = rlState.entries[m.entry];
      if (!e) return false;
      const k = +m.key.split(/[sa]/)[1];
      const url = rlBlob(b64ToBlobUrl(d.image, d.mime || (m.lang === "wav" ? "audio/wav" : "image/jpeg")));
      if (m.lang === "wav") {
        if (!e.audio) e.audio = [];
        e.audio[k] = { url, raw: (e.raws && e.raws[k]) || 3 };
      } else e.images[k] = url;
      rlSavedSrc.set(itemId + "|" + m.key, url);
    }, "그림·목소리");
    // 목소리가 한 줄이라도 빠졌으면 [목소리 다시 만들기]가 보이게 비운다
    rlState.entries.forEach((e) => {
      const n = e.script.scenes.reduce((s, x) => s + x.say.length, 0);
      if (!e.audio || e.audio.filter(Boolean).length !== n) e.audio = null;
    });
    if (got) rlRender();
  },
  applyPayload: (payload) => {
    rlRecAbortAll();
    rlState.entries.forEach(rlDropVideo);
    passageMgr.setJobs(payload.passages || []);
    rlDropBlobs();
    rlState.entries = (payload.entries || []).filter((e) => e && e.script).map((e) => ({
      ...e, images: e.script.scenes.map(() => null), audio: null, error: "" }));
    rlEl("rlError").textContent = "";
    rlRender();
    rlSyncCost();
  },
  clearResults: () => {
    if (rlPlaying) rlPlaying.stop();
    rlRecAbortAll();
    rlState.entries.forEach(rlDropVideo);
    rlDropBlobs();
    rlState.entries = [];
    rlEl("rlError").textContent = "";
    rlRender();
  },
};

if (typeof HOWTO !== "undefined") {
  HOWTO.reels = {
    title: `🎬 ${REELS_NAME} 하는 법`,
    lead: "지문 하나로 <b>세로 숏폼 영상</b>(1분 안팎, 인스타그램 릴스·유튜브 쇼츠에 올릴 수 있는 세로 1080×1920)을 만듭니다 — AI가 지문 내용을 정리해 대본을 쓰고, 장면 그림을 그리고, 고른 목소리로 읽어 줍니다.",
    steps: [
      "위쪽 <b>영어 지문</b> 칸에 지문을 넣습니다(한 번에 5개까지, 지문마다 영상 한 편). 지문 이름이 영상 위 머리표로 들어갑니다.",
      "<b>목소리</b>를 고르고(<b>🔊 들어 보기</b>로 미리 들어 볼 수 있습니다 — <b>⭐ 추천 목소리</b> 넷 말고도 <b>더 많은 목소리</b>를 펼치면 열 가지가 더 있습니다) <b>🎬 영상 만들기</b>를 누릅니다. " +
        "목소리를 <b>여러 개</b> 고르면 <b>🎙️ 영상마다 목소리</b>에 지문마다 줄이 생겨 영상마다 다른 목소리를 정할 수 있습니다(처음엔 고른 목소리를 차례로 돌려 넣습니다).",
      "<b>⏩ 말 빠르기</b>는 슬라이더로 0.7~1.5배 사이에서 고릅니다(기본 1.15배). 만든 뒤에도 영상마다 <b>빠르기</b> 칸에서 바꿀 수 있고 값은 들지 않습니다. " +
        "<b>▶ 미리 보기</b>나 <b>⛶ 전체 화면</b>(영상 파일이 준비되면 초 이동이 되는 재생기)으로 확인합니다. 마음에 안 드는 장면은 <b>🔄 그림 다시</b>로 그 그림만 다시 그립니다(그림 값 따로).",
      "다 만든 영상은 곧바로 <b>영상 파일(mp4)</b>로 만들어 둡니다. <b>✅ 제작 완료</b> 창이 뜨면 <b>⬇ 영상 받기</b>로 받습니다. " +
        "<b>💾 사이트 저장</b>은 대본·장면 그림·목소리를 저장합니다 — <b>영상 파일은 저장되지 않으니</b> 꼭 받아 두세요. 저장한 것을 불러오면 AI 값 없이 영상을 다시 만들어 받을 수 있습니다.",
    ],
    tip: "대본은 이 사이트의 <b>내용 한장정리</b>와 같은 방법으로 지문 내용을 먼저 정리한 뒤, 그 정리에 있는 내용만으로 씁니다 — 첫 질문 → 배경지식 → 대목마다 풀어 읽기 → 쉽게 말하면(비유) → 글쓴이가 하고 싶은 말 → 퀴즈(3·2·1 뒤 정답). 그림에는 글자를 넣지 않고 실존 인물도 그리지 않습니다. 영상 맨 아래에는 <b>학원 마크</b> 칸에 넣은 <b>학원명(왼쪽)·학원 로고(오른쪽)</b>가 들어갑니다(넣기 체크로 끌 수 있습니다). 영상 파일은 <b>PC 크롬</b>을 권합니다. 교재 지문으로 만든 영상을 공개 계정에 올릴 때는 교재 저작권을 확인하세요.",
  };
}

// 학원 마크 칸(이름 적기·로고 올리기·지우기)이나 '넣기' 체크가 바뀌면 다시 그린다 — 영상 파일은 rlRender가 다시 만든다
let rlBrandTimer = 0;
function rlBrandChanged() {
  if (!rlState.entries.length) return;
  clearTimeout(rlBrandTimer);
  rlBrandTimer = setTimeout(() => { if (!rlPlaying) rlRender(); }, 700);
}
rlEl("rlBrandOn").addEventListener("change", rlBrandChanged);
["input", "change", "click"].forEach((ev) => document.addEventListener(ev, (e) => {
  if (e.target.closest && e.target.closest(".brand-panel") && rlEl("tab-reels").classList.contains("active")) rlBrandChanged();
}, true));

rlRender();
