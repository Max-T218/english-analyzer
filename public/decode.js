/* ══════ 리딩노트 (2026-11-02 사용자) ══════
   지문 하나 → A4 두 쪽짜리 정리 자료.
     1쪽: 본문과 해석(원문 아래 전체 해석) / 핵심 정리(제목·주제·글의 목적·흐름 세 줄) / 주요 어휘
     2쪽: 끊어 읽기 해석 — 문장마다 영어 줄 아래 우리말 줄(영어 조각 / 우리말 조각을 같은 자리에서 끊는다)
   서버는 /api/decode(call_gemini_decode, Flash, 지문 1개당 PRICE_DECODE_KRW)이고 글자만 돌려준다 — 여기서 esc()로 넣는다.
   app.js 뒤에 로드되며 app.js의 전역($, esc, postGenerate, passageMgr, TAB_SAVE …)을 쓴다(grammar.js와 같은 방식).
   공용 지문칸을 그대로 쓴다. 결과 칸은 #dcResult 하나. */

const dcEl = (id) => document.getElementById(id);
// 이 탭의 이름 — 사이드바 단추·저장함·파일 이름이 함께 쓴다(이름을 바꾸면 index.html 단추 글자도 같이)
const DECODE_NAME = "리딩노트";
const dcState = {
  entries: [],   // [{name, text, data, error}] — data는 서버 응답(_finish_decode 모양)
  title: "",
  editing: false,
  busy: false,
};

const DC_POS_LABEL = { 명: "명", 동: "동", 형: "형", 부: "부", 전: "전", 접: "접", 숙: "숙어" };

/* ── 그리기 ── */
// 편집할 수 있는 칸에는 data-f로 자리(data 안의 경로)를 적어 둔다 — 고친 글을 저장할 때 그 자리로 되돌려 넣는다(dcHarvest)
const dcEd = (f, text, tag = "span", cls = "") =>
  `<${tag} class="dc-ed${cls ? " " + cls : ""}" data-f="${f}">${esc(text || "")}</${tag}>`;

/* 모양은 참고한 교재(분홍 둥근 틀 · 알약 소제목 · 원문/해석 좌우 · 한 줄 해석 좌우 칸)와 일부러 다르게 짰다(2026-11-03 사용자):
   머리 = 영문 머리글 + 제목 / 소제목 = 번호 + 영문 머리글 + 가는 줄 / 원문 아래 해석 / 핵심 정리 = 제목 띠 + 주제·목적 두 칸 + 흐름 세 칸 /
   어휘 = 외웠는지 표시하는 네모가 붙은 세 줄 목록 / 끊어 읽기 = 문장마다 영어 줄 아래 우리말 줄 */
function dcHeadHtml(name, page) {
  return `<header class="dc-head"><div class="dc-head-l"><span class="dc-kicker">READING NOTE${page === 2 ? " · 2" : ""}</span>` +
    `<span class="dc-head-title">${esc(dcState.title || DECODE_NAME)}</span></div>` +
    `<span class="dc-head-name">${esc(name)}</span></header>`;
}

const dcSecHead = (no, en, ko) =>
  `<h4 class="dc-h"><span class="dc-h-no">${no}</span><span class="dc-h-en">${en}</span><span class="dc-h-ko">${ko}</span></h4>`;

function dcSheetHtml(e, i) {
  if (e.error || !e.data) {
    return `<section class="passage-block dc-sheet" data-i="${i}"><div class="passage-error">` +
      `⚠️ ${esc(e.name)} — ${esc(e.error || "만들지 못했습니다.")} (이 지문의 값은 나가지 않았습니다)</div></section>`;
  }
  const d = e.data;
  const sents = d.sentences || [];
  // 원문은 선생님이 넣은 지문 그대로 — 조각을 이어 붙인 것보다 정확하다(문단 나눔도 남는다)
  const enHtml = esc(e.text).split(/\n\s*\n/).map((p) => `<p>${p.replace(/\n/g, " ")}</p>`).join("");
  const koHtml = sents.map((s, k) => dcEd(`s.${k}.ko`, s.ko)).join(" ");
  const flow = (d.summary || []).map((t, k) =>
    `<div class="dc-step"><span class="dc-step-no">${k + 1}</span>${dcEd(`sum.${k}`, t)}</div>`).join("");
  const words = (d.vocab || []).map((v, k) =>
    `<div class="dc-w"><span class="dc-chk" aria-hidden="true"></span>` +
    `<span class="dc-w-body">${dcEd(`voc.${k}.word`, v.word, "span", "dc-w-word")}` +
    `${v.pos ? `<span class="dc-w-pos">${esc(DC_POS_LABEL[v.pos] || v.pos)}</span>` : ""}` +
    `${dcEd(`voc.${k}.meaning`, v.meaning, "span", "dc-w-mean")}</span></div>`).join("");
  const lines = sents.map((s, k) => {
    const en = (s.chunks || []).map((c, j) => dcEd(`c.${k}.${j}.en`, c.en)).join('<span class="dc-sl">/</span>');
    const ko = (s.chunks || []).map((c, j) => dcEd(`c.${k}.${j}.ko`, c.ko)).join('<span class="dc-sl">/</span>');
    return `<li class="dc-s"><span class="dc-s-no">${String(k + 1).padStart(2, "0")}</span>` +
      `<div class="dc-s-body"><div class="dc-s-en">${en}</div><div class="dc-s-ko">${ko}</div></div></li>`;
  }).join("");
  return `<section class="passage-block dc-sheet" data-i="${i}">
    <div class="dc-page">
      ${dcHeadHtml(e.name, 1)}
      <div class="dc-sec">${dcSecHead("01", "PASSAGE", "본문과 해석")}
        <div class="dc-passage">${enHtml}</div>
        <div class="dc-trans">${koHtml}</div>
      </div>
      <div class="dc-sec">${dcSecHead("02", "KEY POINTS", "핵심 정리")}
        <div class="dc-titlecard">${dcEd("englishTitle", d.englishTitle, "div", "dc-tc-en")}${dcEd("koreanTitle", d.koreanTitle, "div", "dc-tc-ko")}</div>
        <div class="dc-pair">
          <div class="dc-card"><span class="dc-card-lab">주제</span>${dcEd("topic", d.topic, "div")}</div>
          <div class="dc-card"><span class="dc-card-lab">글의 목적</span>${dcEd("purpose", d.purpose, "div")}</div>
        </div>
        ${flow ? `<div class="dc-flow-lab">흐름 세 줄</div><div class="dc-flow">${flow}</div>` : ""}
      </div>
      ${words ? `<div class="dc-sec">${dcSecHead("03", "WORDS", "주요 어휘")}<div class="dc-words">${words}</div></div>` : ""}
    </div>
    <div class="dc-page dc-page2">
      ${dcHeadHtml(e.name, 2)}
      <div class="dc-sec-flow">${dcSecHead("04", "LINE BY LINE", "끊어 읽기 해석")}
        <ol class="dc-lbl">${lines}</ol>
      </div>
    </div>
  </section>`;
}

function dcRender() {
  const ok = dcState.entries.some((e) => e.data);
  dcEl("dcResult").innerHTML = dcState.entries.map(dcSheetHtml).join("");
  ["dcPrintBtn", "dcEditBtn", "dcSaveBtn"].forEach((id) => { dcEl(id).style.display = ok ? "" : "none"; });
  dcSetEditing(dcState.editing && ok);
  if (typeof syncFloatPrint === "function") syncFloatPrint();
}

/* ── 직접 수정 ── */
function dcSetEditing(on) {
  dcState.editing = !!on;
  dcEl("dcResult").classList.toggle("dc-editing", dcState.editing);
  dcEl("dcResult").querySelectorAll(".dc-ed").forEach((el) => {
    if (dcState.editing) el.setAttribute("contenteditable", "true");
    else el.removeAttribute("contenteditable");
  });
  dcEl("dcEditBtn").textContent = dcState.editing ? "✅ 수정 끝내기" : "✏️ 직접 수정";
}

// 화면에서 고친 글을 data로 되돌려 넣는다 — 저장·다시 그리기 전에 부른다
function dcHarvest() {
  dcEl("dcResult").querySelectorAll(".dc-sheet").forEach((sheet) => {
    const e = dcState.entries[Number(sheet.dataset.i)];
    if (!e || !e.data) return;
    sheet.querySelectorAll(".dc-ed[data-f]").forEach((el) => {
      const val = el.innerText.replace(/\s+/g, " ").trim();
      const p = el.dataset.f.split(".");
      const d = e.data;
      if (p.length === 1) d[p[0]] = val;
      else if (p[0] === "sum" && d.summary) d.summary[+p[1]] = val;
      else if (p[0] === "voc" && d.vocab && d.vocab[+p[1]]) d.vocab[+p[1]][p[2]] = val;
      else if (p[0] === "s" && d.sentences && d.sentences[+p[1]]) d.sentences[+p[1]].ko = val;
      else if (p[0] === "c" && d.sentences && d.sentences[+p[1]]) {
        const c = (d.sentences[+p[1]].chunks || [])[+p[2]];
        if (c) c[p[3]] = val;
      }
    });
  });
}

dcEl("dcEditBtn").addEventListener("click", () => {
  if (dcState.editing) dcHarvest();
  dcSetEditing(!dcState.editing);
});

/* ── 값 안내 ── */
function dcCost(n) {
  if (typeof PRICING === "undefined" || !PRICING || !Number.isFinite(PRICING.decode)) return null;
  return PRICING.decode * n;
}
function dcJobs() {
  return passageMgr.getJobs().filter((j) => j.text && j.text.length >= 20);
}
function dcSyncCost() {
  const n = dcJobs().length;
  const cost = dcCost(n);
  dcEl("dcCostHint").innerHTML = n && cost !== null
    ? `예상 비용 <b>${pt(cost)}</b> (지문 ${n}개 × ${pt(PRICING.decode)})` : "";
}
if (typeof onPricingReady === "function") onPricingReady(dcSyncCost);
document.addEventListener("input", (e) => {
  if (e.target.closest && e.target.closest(".passage-panel")) dcSyncCost();
});
document.querySelector('.tab-btn[data-tab="decode"]').addEventListener("click", dcSyncCost);

/* ── 만들기 ── */
async function dcMake() {
  const errEl = dcEl("dcError");
  errEl.textContent = "";
  const jobs = dcJobs();
  if (!jobs.length) {
    errEl.textContent = "위쪽 영어 지문 칸에 지문을 넣어 주세요 (20자 이상).";
    return;
  }
  if (!(await costConfirmed(dcCost(jobs.length), `${DECODE_NAME} · 지문 ${jobs.length}개`, jobs.length,
    reduceAdvice(jobs.length)))) return;
  if (typeof dropStaleSavedLink === "function") dropStaleSavedLink("decode");
  dcState.busy = true;
  dcEl("dcMakeBtn").disabled = true;
  const loading = dcEl("dcLoading");
  const text = dcEl("dcLoadingText");
  const gate = runGate(loading);
  gate.begin();
  loading.classList.add("on");
  dcState.entries = [];
  dcState.editing = false;
  dcRender();
  let ok = 0;
  try {
    for (let i = 0; i < jobs.length; i++) {
      if (i && await gate.check(`지문 ${i}개까지 만들었습니다.`, dcRender)) {
        errEl.textContent = runEndedNote(jobs.length - i, "지문");
        break;
      }
      const j = jobs[i];
      text.textContent = `AI가 ${j.name}의 리딩노트를 만들고 있습니다… (${i + 1}/${jobs.length}, 지문 하나에 20~40초)`;
      try {
        const data = await postGenerate("/api/decode", { passage: j.text }, "리딩노트를 만들지 못했습니다.",
          (n) => { text.textContent = `연결이 끊겨 다시 받아 오는 중… (${n})`; });
        dcState.entries.push({ name: j.name, text: j.text, data });
        ok++;
      } catch (err) {
        dcState.entries.push({ name: j.name, text: j.text, data: null, error: err.message || String(err) });
        // 한도 소진·잔액 부족은 다음 지문도 같은 답이다 — 거기서 멈춘다
        if (err.code === "quota" || err.code === "no_tokens") {
          errEl.textContent = err.message;
          break;
        }
      }
      dcRender();
    }
    if (typeof LOADED_SAVED !== "undefined" && !ok) delete LOADED_SAVED.decode;
    dcRender();
    if (ok) showDoneGuide(`지문 ${ok}개의 ${DECODE_NAME}`, true);
  } finally {
    dcState.busy = false;
    dcEl("dcMakeBtn").disabled = false;
    loading.classList.remove("on");
    refreshTokenDisplay();
  }
}
dcEl("dcMakeBtn").addEventListener("click", dcMake);

/* ── 인쇄·저장 ── */
dcEl("dcTitle").addEventListener("input", (e) => {
  dcState.title = e.target.value.trim();
  dcEl("dcResult").querySelectorAll(".dc-head-title").forEach((el) => { el.textContent = dcState.title || DECODE_NAME; });
});
const dcTitleHandle = {
  get: () => dcState.title,
  set: (v) => { dcState.title = String(v || "").trim(); dcEl("dcTitle").value = dcState.title; dcRender(); },
};
const dcFileName = () => sanitizeFilename(dcState.title || (dcState.entries[0] && dcState.entries[0].name) || "");
dcEl("dcPrintBtn").addEventListener("click", () => {
  if (dcState.editing) { dcHarvest(); dcSetEditing(false); }
  printDoc(() => ["리딩노트", dcFileName(), todayStr()].filter(Boolean).join("_"), { title: dcTitleHandle });
});
dcEl("dcSaveBtn").addEventListener("click", () => openSaveDialog("decode"));
dcEl("dcLoadBtn").addEventListener("click", () => openSavedList("tab", null, "decode"));

// 꾸미기(테마 색·글자 크기·글꼴) — 다른 탭과 같은 한 벌(app.js createSheetStyle). 글자 크기 묶음은 "reading"(SHEET_FS).
// 색은 --accent(머리띠·소제목·번호·상자 테두리)만 바꾼다
const dcSheetStyle = createSheetStyle("dcSheetStyle", dcEl("dcResult"), "reading");
const dcStyleTitle = dcEl("dcSheetStyle").querySelector(".sheet-style-title");
if (dcStyleTitle) dcStyleTitle.textContent = "🎨 리딩노트 꾸미기";

TAB_LABELS.decode = "📘 " + DECODE_NAME;
TAB_LIBRARY_WORDS.decode = {
  title: `📘 ${DECODE_NAME} 저장함`,
  lead: `저장해 둔 ${DECODE_NAME} 자료입니다. [불러오기]를 누르면 AI를 다시 부르지 않고 그대로 엽니다.`,
  empty: `아직 저장한 ${DECODE_NAME}${josa(DECODE_NAME, "이", "가")} 없습니다. 만든 뒤 “💾 사이트 저장”을 눌러 보세요.`,
};
SAVE_TITLE_SUGGEST.decode = () => dcState.title || passageBasedName("리딩노트");
TAB_SAVE.decode = {
  // saveBtn을 등록하지 않는다 — app.js가 단추를 연결한 뒤에 이 파일이 로드된다(grammar.js와 같다)
  canSave: () => (dcState.entries.some((e) => e.data) ? ""
    : `저장할 ${DECODE_NAME}${josa(DECODE_NAME, "이", "가")} 없습니다. 먼저 만들어 주세요.`),
  getPayload: () => {
    dcHarvest();
    return {
      v: 1,
      passages: passageMgr.getJobs(),
      title: dcState.title,
      entries: dcState.entries.filter((e) => e.data).map((e) => ({ name: e.name, text: e.text, data: e.data })),
      sheetStyle: dcSheetStyle.get(),
    };
  },
  applyPayload: (payload) => {
    passageMgr.setJobs(payload.passages || []);
    if (payload.sheetStyle) dcSheetStyle.set(payload.sheetStyle);
    dcState.title = String(payload.title || "");
    dcEl("dcTitle").value = dcState.title;
    dcState.entries = (payload.entries || []).filter((e) => e && e.data);
    dcState.editing = false;
    dcEl("dcError").textContent = "";
    dcRender();
    dcSyncCost();
  },
  clearResults: () => {
    dcState.entries = [];
    dcState.editing = false;
    dcEl("dcError").textContent = "";
    dcRender();
  },
};

if (typeof HOWTO !== "undefined") {
  HOWTO.decode = {
    title: `📘 ${DECODE_NAME} 만드는 법`,
    lead: "지문 하나로 A4 두 쪽짜리 복습 자료를 만듭니다 — 본문과 해석, 핵심 정리, 주요 어휘, 끊어 읽기 해석.",
    steps: [
      "위쪽 <b>영어 지문</b> 칸에 지문을 넣습니다(여러 개면 <b>＋ 지문 추가</b>). 지문 이름이 쪽 머리띠에 찍힙니다.",
      "필요하면 <b>자료 제목</b>을 적고 <b>리딩노트 만들기</b>를 누릅니다. 지문마다 20~40초 걸립니다.",
      "화면에서 내용을 확인하고, 고칠 곳은 <b>✏️ 직접 수정</b>으로 그 자리에서 고칩니다.",
      "<b>🖨️ 인쇄 / PDF 변환</b>으로 뽑거나, <b>💾 사이트 저장</b>으로 남겨 둡니다.",
    ],
    tip: "1쪽: 본문과 해석 · 핵심 정리(제목·주제·글의 목적·흐름 세 줄) · 주요 어휘(외웠는지 표시하는 네모) / 2쪽: 문장마다 '/'로 끊은 영어 줄 아래 우리말 줄. 🎨 꾸미기로 색·글자 크기·글꼴을 바꿀 수 있습니다.",
  };
}

dcRender();
