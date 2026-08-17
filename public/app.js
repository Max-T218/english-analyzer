"use strict";

// ── 열 때마다 완전 초기화 ──────────────────────────────────────────────
// 창을 새로 열면 지문·학원 마크·모델 설정·단어장 데이터까지 전부 비운다.
// 공용 PC에서 앞사람 흔적이 남지 않게 하려는 것으로, 아래의 모든 초기화 코드보다
// 먼저 실행되어야 하므로 파일 맨 위에 둔다.
// (한 세션 안에서의 저장은 그대로 동작한다 — 예: 지문 분석 결과의 어휘를 단어장
//  탭이 이어받는 흐름. 다만 새로고침하면 함께 사라진다.)
//
// 로그인 상태는 여기 영향받지 않는다 — 세션은 브라우저가 못 보는 HttpOnly
// 쿠키에 있어서, localStorage를 지워도 로그인은 유지된다.
try {
  localStorage.clear();
} catch (_) {
  /* 사생활 보호 모드 등에서 접근이 막혀도 앱은 그대로 동작 */
}

const $ = (id) => document.getElementById(id);
const passageListEl = $("passageList");
const addPassageBtn = $("addPassageBtn");
const clearPassagesBtn = $("clearPassagesBtn");
const passageCountEl = $("passageCount");
const grammarEl = $("targetGrammar");
const analyzeBtn = $("analyzeBtn");
const printBtn = $("printBtn");
const floatPrintGroup = $("floatPrintGroup");
const floatPrintBtn = $("floatPrintBtn");
const reviewChk = $("reviewChk");
const errorEl = $("error");
const loadingEl = $("loading");
const loadingTextEl = $("loadingText");
const resultEl = $("result");

/* ── 인쇄 / PDF로 저장 ──
   종이 인쇄든 PDF 저장이든 브라우저 인쇄 대화상자가 뜨고, '대상(프린터)'에서 무엇을
   고르느냐만 다르다. 게다가 그 목록에 무엇이 먼저 선택돼 있는지는 브라우저가 정한다
   (보안 정책 — 사이트가 사용자 몰래 파일을 저장하지 못하게 막는 장치). 그래서 버튼을
   둘로 나눌 이유가 없어 하나로 합치고, 대신
   ① 누를 때 대화상자에서 무엇을 골라야 하는지 안내 창으로 알려 주고,
   ② 'PDF로 저장'을 고른 뒤 뜨는 저장 창의 기본 파일명을 지문·제목에서 뽑아 채운다
      (Chrome·Edge의 '인쇄 → PDF로 저장' 흐름은 document.title을 파일명 제안으로 쓴다). */
function pad2(n) {
  return String(n).padStart(2, "0");
}
function todayStr() {
  const d = new Date();
  return `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}`;
}
// 파일명에 못 쓰는 문자(Windows 기준 \ / : * ? " < > |)를 지운다
function sanitizeFilename(s) {
  return String(s || "").replace(/[\\/:*?"<>|]/g, " ").replace(/\s+/g, " ").trim();
}
// 첫 지문에 사용자가 직접 이름을 지었으면 그 이름을, 아니면 유형명만 파일명에 쓴다
function passageBasedName(prefix) {
  const jobs = passageMgr.getJobs();
  const first = jobs[0];
  const label = first && first.named ? sanitizeFilename(first.name) : "";
  return [prefix, label, todayStr()].filter(Boolean).join("_");
}
// 제목 입력칸(워크북·단어장)이 채워져 있으면 그 제목을, 비어 있으면 지문 이름을 쓴다
function titledName(prefix, titleElId) {
  const el = $(titleElId);
  const t = el ? sanitizeFilename(el.value.trim()) : "";
  return t ? [prefix, t, todayStr()].filter(Boolean).join("_") : passageBasedName(prefix);
}

const ORIGINAL_TITLE = document.title;

// 안내 창 — '다시 보지 않기'를 켜면 이번 세션 동안만 건너뛴다
// (창을 새로 열면 맨 위의 localStorage.clear()로 함께 지워진다).
const PRINT_GUIDE_SKIP = "gemini_print_guide_skip";
const printGuideEl = $("printGuide");
const printGuideSkipEl = $("printGuideSkip");
let printGuideRun = null; // 안내를 확인하면 실행할 인쇄 동작

function closePrintGuide() {
  printGuideEl.hidden = true;
  printGuideRun = null;
}
function showPrintGuide(run) {
  if (localStorage.getItem(PRINT_GUIDE_SKIP) === "1") {
    run();
    return;
  }
  printGuideRun = run;
  printGuideEl.hidden = false;
  $("printGuideGo").focus();
}
$("printGuideCancel").addEventListener("click", closePrintGuide);
$("printGuideGo").addEventListener("click", () => {
  const run = printGuideRun;
  if (printGuideSkipEl.checked) localStorage.setItem(PRINT_GUIDE_SKIP, "1");
  closePrintGuide();
  if (run) run();
});
// 바깥을 누르거나 Esc를 누르면 닫는다 (인쇄는 하지 않는다)
printGuideEl.addEventListener("click", (e) => {
  if (e.target === printGuideEl) closePrintGuide();
});
document.addEventListener("keydown", (e) => {
  if (e.key === "Escape" && !printGuideEl.hidden) closePrintGuide();
});

// 실제 인쇄 실행.
// nameFn: 저장 대화상자에 뜰 기본 파일명을 만드는 함수 (지금 화면 상태를 보고 매번 새로 계산)
// before/after: 인쇄하는 동안에만 지면 구성을 바꿔야 할 때 쓴다 (워크북 '답지만')
function runPrint(nameFn, before, after) {
  let name = "";
  try {
    name = sanitizeFilename(nameFn ? nameFn() : "");
  } catch {
    name = "";
  }
  document.title = name || ORIGINAL_TITLE;
  if (before) before();
  let done = false;
  const restore = () => {
    if (done) return;
    done = true;
    document.title = ORIGINAL_TITLE;
    if (after) after();
    window.removeEventListener("afterprint", restore);
  };
  window.addEventListener("afterprint", restore);
  // afterprint를 안 보내는(또는 대화상자를 그냥 닫은) 경우를 대비한 안전장치
  setTimeout(restore, 60000);
  window.print();
}

// 인쇄/PDF저장 버튼의 공통 동작 — 안내 후 인쇄 대화상자를 연다.
function printDoc(nameFn, opts) {
  showPrintGuide(() => runPrint(nameFn, opts && opts.before, opts && opts.after));
}

/* ── 워드(.docx)로 내려받기 ──
   인쇄는 PDF로 되므로 이쪽의 목적은 오직 '편집'이다.

   화면이 이미 그려 놓은 결과 HTML을 그대로 보낸다. 데이터를 보내고 서버가 다시 그리게
   하면 문항 모양을 만드는 로직(quizBodyHtml의 format별 분기, 워크북 단계별 렌더링)이
   파이썬에 한 벌 더 생겨 두 곳이 조용히 어긋난다 — 그리는 곳은 app.js 하나로 둔다.

   따라서 '지금 화면에 보이는 그대로' 담긴다. 워크북의 '정답 표시'처럼 화면 상태를 바꾸는
   설정은 누르기 전에 맞춰 두면 그대로 반영된다.

   AI를 부르지 않으므로 요금도, 비용 확인 창도 없다. */
async function downloadDocx({ resultEl, name, answerHeading, btn, errorEl, strip, columns }) {
  if (errorEl) errorEl.textContent = "";
  if (!resultEl || !resultEl.innerHTML.trim()) {
    if (errorEl) errorEl.textContent = "먼저 자료를 만들어 주세요.";
    return;
  }
  /* strip: 보내기 전에 덜어 낼 선택자들.
     화면에서 '숨김'은 대개 CSS로 처리하므로(워크북 정답이 대표적이다 — .wb-ans는 늘
     HTML에 있고 .show-answers가 붙었을 때만 보인다) innerHTML을 그대로 보내면 화면에
     안 보이던 것이 워드에는 찍힌다. 복제본에서 실제로 지워 보낸다. */
  let source = resultEl.innerHTML;
  if (strip && strip.length) {
    const clone = resultEl.cloneNode(true);
    clone.querySelectorAll(strip.join(",")).forEach((el) => el.remove());
    source = clone.innerHTML;
  }
  const label = btn ? btn.textContent : "";
  if (btn) {
    btn.disabled = true;
    btn.textContent = "만드는 중…";
  }
  try {
    const res = await fetch("/api/docx", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        html: source,
        title: name,
        filename: name,
        answerHeading: answerHeading || "정답 및 해설",
        columns: columns === 1 ? 1 : 2,
      }),
    });
    if (!res.ok) {
      // 실패는 JSON으로 온다 (성공했을 때만 파일이 온다)
      let msg = "워드 파일을 만들지 못했습니다.";
      try {
        msg = (await res.json()).error || msg;
      } catch (_) {}
      throw new Error(msg);
    }
    const url = URL.createObjectURL(await res.blob());
    const a = document.createElement("a");
    a.href = url;
    a.download = `${name}.docx`;
    document.body.appendChild(a);
    a.click();
    a.remove();
    // 곧바로 반납하면 내려받기가 시작되기 전에 끊기는 브라우저가 있다
    setTimeout(() => URL.revokeObjectURL(url), 60000);
  } catch (err) {
    if (errorEl) errorEl.textContent = err.message || String(err);
  } finally {
    if (btn) {
      btn.disabled = false;
      btn.textContent = label;
    }
  }
}

/* ── 제작 완료 안내 ──
   만들기가 끝나면 뜬다. AI가 만든 결과를 그대로 인쇄해 학생에게 나눠 주기 전에,
   화면에서 한 번 검토하게 하는 것이 목적이다.
   '✏️ 직접 수정'은 지문 분석 탭에만 있으므로(다른 탭은 편집 기능이 없다) 고치는
   방법 안내가 탭마다 달라진다 — canEdit로 가른다.
   '다시 보지 않기'는 인쇄 안내와 같은 방식으로 이번 세션 동안만 유지된다
   (창을 새로 열면 파일 맨 위의 localStorage.clear()로 함께 지워진다). */
const DONE_GUIDE_SKIP = "gemini_done_guide_skip";
const doneGuideEl = $("doneGuide");
const doneGuideTitleEl = $("doneGuideTitle");
const doneGuideLeadEl = $("doneGuideLead");
const doneGuideStepsEl = $("doneGuideSteps");
const doneGuideNoteEl = $("doneGuideNote");
const doneGuideSkipEl = $("doneGuideSkip");
const doneGuideCloseBtn = $("doneGuideClose");

// 받침 유무로 조사를 고른다 — "8문항이/세트가"처럼 자연스럽게. 한글이 아닌 글자로
// 끝나면(숫자·영문) 판단할 수 없으므로 받침 없는 쪽을 쓴다.
function josa(word, withBatchim, withoutBatchim) {
  const last = String(word || "").trim().slice(-1);
  const code = last.charCodeAt(0);
  if (!(code >= 0xac00 && code <= 0xd7a3)) return withoutBatchim;
  return (code - 0xac00) % 28 ? withBatchim : withoutBatchim;
}

function closeDoneGuide() {
  if (doneGuideSkipEl.checked) localStorage.setItem(DONE_GUIDE_SKIP, "1");
  doneGuideEl.hidden = true;
}
doneGuideCloseBtn.addEventListener("click", closeDoneGuide);
doneGuideEl.addEventListener("click", (e) => {
  if (e.target === doneGuideEl) closeDoneGuide();
});

// what: 무엇을 몇 개 만들었는지 (예: "지문 3개의 분석본")
// canEdit: 그 탭에 '직접 수정' 버튼이 있는지
function showDoneGuide(what, canEdit) {
  if (localStorage.getItem(DONE_GUIDE_SKIP) === "1") return;
  doneGuideTitleEl.textContent = "✅ 제작 완료";
  doneGuideLeadEl.innerHTML =
    `${esc(what)}${josa(what, "이", "가")} 만들어졌습니다. ` +
    `<b>인쇄하기 전에 화면에서 먼저 확인해 주세요.</b>`;
  const steps = [
    "<b>내용을 훑어보세요</b> — AI가 만든 결과라 해석·해설·정답이 틀릴 수 있습니다.",
  ];
  if (canEdit) {
    steps.push(
      "<b>고칠 곳이 있으면</b> 결과 위의 <b>✏️ 직접 수정</b> 버튼을 누르세요. " +
        "한글 해석·루비·해설을 그 자리에서 고칠 수 있고, 고친 그대로 인쇄됩니다."
    );
    steps.push(
      "<b>쪽 아래가 비어 보이면</b> <b>📄 쪽 구성</b>을 눌러 보세요. " +
        "인쇄했을 때 쪽이 어디서 넘어가는지 보여 주고, 표·문장 카드 단위로 쪽을 옮길 수 있습니다."
    );
  } else {
    steps.push(
      "<b>고칠 곳이 있으면</b> 유형·문항 수·지문을 바꿔 <b>다시 만들어</b> 주세요. " +
        "이 탭은 화면에서 직접 고치는 기능이 아직 없습니다."
    );
  }
  steps.push("확인이 끝나면 <b>🖨️ 인쇄 / PDF 변환</b>, 나중에 다시 쓰려면 <b>💾 사이트 저장</b>.");
  doneGuideStepsEl.innerHTML = steps.map((s) => `<li>${s}</li>`).join("");
  doneGuideNoteEl.textContent = canEdit
    ? "수정한 내용은 저장·인쇄에 그대로 반영됩니다."
    : "";
  doneGuideSkipEl.checked = false;
  doneGuideEl.hidden = false;
  doneGuideCloseBtn.focus();
}

// 서버 API 호출 공통 헬퍼.
// 배포 환경(Render 등)의 프록시는 요청이 길어지면 JSON이 아니라 HTML 에러 페이지를
// 돌려준다. 그대로 res.json()을 부르면 'Unexpected token <' 같은 메시지가 떠서
// 진짜 원인(상태코드)이 가려지므로, 텍스트로 먼저 받아 파싱을 시도한다.
async function postJson(url, payload, fallbackMsg) {
  const res = await fetch(url, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(payload),
  });
  const text = await res.text();
  let data = null;
  try {
    data = JSON.parse(text);
  } catch {}
  if (!data) {
    const hint = /^\s*</.test(text)
      ? res.status === 502 || res.status === 504
        ? "서버 응답이 너무 오래 걸려 중간에서 끊겼습니다. 지문을 짧게 나눠 다시 시도해 보세요."
        : "서버가 JSON 대신 HTML을 반환했습니다."
      : text.slice(0, 120).trim() || "응답이 비어 있습니다.";
    throw new Error(`서버 오류 (HTTP ${res.status}) — ${hint}`);
  }
  if (!res.ok) {
    const err = new Error(data.error || fallbackMsg);
    err.code = data.code || "";   // 서버가 붙인 식별자 ("quota" 등)
    err.status = res.status;
    throw err;
  }
  return data;
}

// 할당량 소진인가? — 서버가 code를 붙여 주면 그것으로 판정하고,
// 예전 응답이나 예외 상황을 대비해 메시지 문구로도 한 번 더 확인한다.
// 이 키로 Pro를 쓸 수 없는 경우 — 모델만 바꾸면 되므로 한도 소진과 구분해 안내한다
function isProUnavailableError(err) {
  return !!(err && err.code === "pro_unavailable");
}

// 반대로 '이 기능은 Pro가 필요한데 Flash를 골랐다'는 경우 ('5개 이상 변형').
// 모델을 올리기 전에는 계속 실패하므로 역시 즉시 중단한다.
function isNeedsProError(err) {
  return !!(err && err.code === "needs_pro");
}

// 로그인 계정의 잔액이 부족한 경우 — Gemini 한도와는 별개로, 이 계정이 더 쓸 수
// 없는 상태다. 다시 시도해도 똑같이 실패하므로 한도 소진과 같은 방식(즉시 중단)으로 다룬다.
function isNoTokensError(err) {
  return !!(err && err.code === "no_tokens");
}

function isQuotaError(err) {
  if (err && err.code === "quota") return true;
  if (isProUnavailableError(err)) return true; // 남은 지문을 즉시 중단시키기 위해
  if (isNeedsProError(err)) return true;
  if (isNoTokensError(err)) return true;
  const msg = (err && err.message) || String(err || "");
  return /한도|quota|exceeded|429/i.test(msg);
}

// 중단 안내 카드 — Pro 사용 불가와 한도 소진을 구분해서 보여 준다.
// unit: 남은 분량의 단위. 문제 제작은 '지문 × 변형 × 유형묶음'으로 쪼개 부르므로
// 지문 수가 아니라 '작업' 수를 센다.
function quotaStopHtml(left, err, unit = "지문") {
  if (isNeedsProError(err)) {
    return `<section class="passage-block"><div class="passage-error">
      <b>Pro 모델이 필요해 중단했습니다</b>
      ${esc(err.message || "")}
      남은 ${unit} ${left}개는 시도하지 않았습니다.
    </div></section>`;
  }
  if (isProUnavailableError(err)) {
    return `<section class="passage-block"><div class="passage-error">
      <b>Pro 모델을 사용할 수 없어 중단했습니다</b>
      이 API 키는 Pro 모델을 쓸 수 없습니다(결제된 키에서만 동작).
      위 <b>모델</b> 목록에서 <b>Flash</b> 모델을 선택한 뒤 다시 실행해 주세요.
      남은 ${unit} ${left}개는 시도하지 않았습니다.
    </div></section>`;
  }
  if (isNoTokensError(err)) {
    return `<section class="passage-block"><div class="passage-error">
      <b>잔액이 부족해 중단했습니다</b>
      남은 ${unit} ${left}개는 시도하지 않았습니다. 관리자에게 문의해 잔액을 충전받으세요.
    </div></section>`;
  }
  return `<section class="passage-block"><div class="passage-error">
    <b>한도 초과로 중단했습니다</b>
    남은 ${unit} ${left}개는 시도하지 않았습니다. 지금은 다시 시도해도 같은 결과라
    시간만 걸리기 때문입니다. 한도가 리셋된 뒤 이어서 진행하세요.
  </div></section>`;
}

/* ══════════════════════════ 시작 화면(로그인/회원가입) ══════════════════════════ */
// 개인 API 키 없이, 로그인해야만 작업 화면으로 들어간다 — 실제 AI 호출은 전부
// 관리자(운영자)의 서버 키 하나로 이루어지고, 로그인은 '누가 그 키를 쓰는지'
// 구분하는 용도다. 로그인 방법은 구글 OAuth 또는 이메일/비밀번호 회원가입 둘 다.
const gateEl = $("gate");
const workspaceEl = $("workspace");
const loginModalEl = $("loginModalOverlay");
const signupModalEl = $("signupModalOverlay");
const rechargeModalEl = $("rechargeModalOverlay");
const loginPanelEl = $("loginPanel");
const signupPanelEl = $("signupPanel");
const verifyPanelEl = $("verifyPanel");

// 로그인/회원가입은 시작 화면의 버튼 두 개로만 열리는 플로팅 창이다. 회원가입 창은
// 안에서 '이메일·비밀번호 입력'→'인증코드 입력' 두 단계를 오가고, 로그인 창은
// 구글 버튼과 이메일/비밀번호 폼을 한 창에 같이 보여준다.
function openModal(overlay) {
  overlay.hidden = false;
}
function closeModal(overlay) {
  overlay.hidden = true;
}
function closeAllModals() {
  closeModal(loginModalEl);
  closeModal(signupModalEl);
  closeModal(rechargeModalEl);
}
function showSignupStep(step) {
  signupPanelEl.hidden = step !== "form";
  verifyPanelEl.hidden = step !== "verify";
}

// 시작 화면이 길어져서 로그인 버튼을 위아래 두 곳에 둔다 — 처음 온 사람은 소개를
// 읽고 아래에서, 다시 온 사람은 위에서 바로 누른다. id는 하나뿐이라 클래스로 건다.
document.querySelectorAll(".js-open-login").forEach((btn) =>
  btn.addEventListener("click", () => {
    loginErrorEl.textContent = "";
    openModal(loginModalEl);
  })
);
document.querySelectorAll(".js-open-signup").forEach((btn) =>
  btn.addEventListener("click", () => {
    signupErrorEl.textContent = "";
    showSignupStep("form");
    openModal(signupModalEl);
  })
);
$("loginModalClose").addEventListener("click", () => closeModal(loginModalEl));
$("signupModalClose").addEventListener("click", () => closeModal(signupModalEl));
$("rechargeModalClose").addEventListener("click", () => closeModal(rechargeModalEl));
// 배경(어두운 부분) 클릭 시 닫기 — 안쪽 상자를 클릭한 건 버블링으로 안 걸리게 확인
[loginModalEl, signupModalEl, rechargeModalEl].forEach((overlay) => {
  overlay.addEventListener("click", (e) => {
    if (e.target === overlay) closeModal(overlay);
  });
});
document.addEventListener("keydown", (e) => {
  if (e.key === "Escape") closeAllModals();
});

function showGate() {
  gateEl.hidden = false;
  workspaceEl.hidden = true;
  closeAllModals();
  window.scrollTo({ top: 0 });
}

function enterWorkspace() {
  gateEl.hidden = true;
  workspaceEl.hidden = false;
  closeAllModals();
  window.scrollTo({ top: 0 });
}

/* ══════════ 로그인 상태 / 계정 표시 ══════════
   서버는 세션 쿠키(HttpOnly)로 로그인 여부를 관리한다 — 여기서는 쿠키 값을 볼 수
   없으므로, 로그인 여부는 항상 /api/me로 서버에 물어서 판단한다. */
async function getJson(url, fallbackMsg) {
  const res = await fetch(url);
  const text = await res.text();
  let data = null;
  try { data = JSON.parse(text); } catch {}
  if (!data) throw new Error(fallbackMsg || "서버 응답을 읽을 수 없습니다.");
  if (!res.ok) throw new Error(data.error || fallbackMsg);
  return data;
}

/* ══════════ 정찰 가격표 + '만들기' 전 비용 확인 ══════════
   서버가 실제로 매기는 가격(server.py의 PRICE_* 값)을 그대로 보여줘야 하므로,
   화면에 하드코딩하지 않고 /api/pricing으로 받아 온다. 로그인 여부와 무관한
   값이라 로그인 전에도 미리 받아 둔다. */
let PRICING = null;
// 가격표는 화면이 다 그려진 뒤에 도착한다. 그 전에 그려 둔 '예상 금액' 안내는 금액이
// 빠진 채로 남으므로, 도착하면 다시 그리도록 등록해 둔다.
const PRICING_READY = [];
function onPricingReady(fn) {
  PRICING_READY.push(fn);
  if (PRICING) fn(); // 이미 도착한 뒤에 등록했으면 바로 한 번
}
async function loadPricing() {
  try {
    PRICING = await getJson("/api/pricing", "");
  } catch (_) {
    PRICING = null; // 못 받아 오면 비용 확인 없이 그냥 진행시킨다(아래 costConfirmed 참고)
  }
  PRICING_READY.forEach((fn) => {
    try {
      fn();
    } catch (_) {
      /* 안내 문구 하나 때문에 나머지가 멈추면 안 된다 */
    }
  });
}
loadPricing();

// 지금 입력된 지문 중 실제로 과금 대상이 될 만큼 긴 것만 센다(20자 미만은 서버가
// 애초에 거부하므로 비용 예측에서도 빼는 게 맞다).
function billableJobCount() {
  return passageMgr.getJobs().filter((j) => j.text && j.text.length >= 20).length;
}

// renderAccount()가 /api/me를 받을 때마다 갱신해 두는 현재 잔액 — 비용 확인창에
// "예상 비용" 옆에 "지금 잔액"도 같이 보여주는 데 쓴다.
let currentKrw = null;

// 예상 비용(+지금 잔액)을 보여주고 진행 여부를 묻는다. 가격표를 못 받아 왔으면
// (네트워크 문제 등) 확인 없이 그냥 진행시킨다 — 비용 확인은 편의 기능이지,
// 이것 때문에 정작 필요한 기능 자체가 막히면 안 된다. krw가 0이면(무료 기능이거나
// 지문이 없으면) 그냥 진행한다.
// jobCount를 넘기면 '지문이 너무 많다'는 안내도 같은 창에 함께 넣는다 — PDF에서 한
// 번에 수십 개를 담을 수 있게 되면서, 담은 줄도 모르고 실행해 몇십 분을 기다리는 일이
// 생길 수 있기 때문이다. 확인창을 두 번 띄우지 않으려고 비용 안내와 한 창에 합친다.
function costConfirmed(krw, label, jobCount) {
  const manyLine =
    Number.isFinite(jobCount) && jobCount > MANY_PASSAGES_WARN
      ? `지문 ${jobCount}개를 하나씩 차례로 처리합니다 — 시간이 꽤 걸립니다.\n`
      : "";
  const priced = PRICING !== null && Number.isFinite(krw) && krw > 0;
  if (!manyLine && !priced) return true;
  const costLine = priced ? `예상 비용: ${krw.toLocaleString()}원\n` : "";
  const balanceLine =
    priced && Number.isFinite(currentKrw)
      ? `지금 잔액: ${currentKrw.toLocaleString()}원 → 진행 후 약 ${(currentKrw - krw).toLocaleString()}원\n`
      : "";
  return confirm(`${label}\n\n${manyLine}${costLine}${balanceLine}\n진행하시겠습니까?`);
}

// 탭마다 자신을 등록해 두는 저장/불러오기 레지스트리. 각 항목:
//   saveBtn: 저장 버튼 엘리먼트, getPayload(): 지금 상태를 저장용 객체로,
//   applyPayload(payload): 불러온 값으로 화면을 되살림
const TAB_SAVE = {};
const accountNameEl = $("accountName");
const passageLibraryBtn = $("passageLibraryBtn");
const materialLibraryBtn = $("materialLibraryBtn");
const logoutBtn = $("logoutBtn");

let isLoggedIn = false; // 저장/불러오기 버튼들이 이 값으로 로그인 여부를 판단한다
let lastAccountLabel = ""; // 이름/이메일 표시용 — 충전 후 잔액만 다시 그릴 때 재사용
let currentKrwFree = null; // 무상 포인트 — 이용 내역 안내 문구에 쓴다
let currentKrwPaid = null; // 유상 포인트(환불 대상)

function renderAccount(info) {
  isLoggedIn = !!(info && info.loggedIn);
  if (!isLoggedIn) {
    currentKrw = null;
    currentKrwFree = currentKrwPaid = null;
    return;
  }
  const krw = Number(info.krwRemaining);
  currentKrw = Number.isFinite(krw) ? krw : null;
  const free = Number(info.krwFree);
  const paid = Number(info.krwPaid);
  currentKrwFree = Number.isFinite(free) ? free : null;
  currentKrwPaid = Number.isFinite(paid) ? paid : null;
  if (info.name || info.email) lastAccountLabel = info.name || info.email;
  const krwText = currentKrw !== null ? ` · 잔액 ${currentKrw.toLocaleString()}원` : "";
  accountNameEl.textContent = `${lastAccountLabel || "로그인됨"}님${krwText}`;
}

async function refreshAccount() {
  try {
    const info = await getJson("/api/me", "로그인 상태를 확인하지 못했습니다.");
    renderAccount(info);
    // 세션이 살아 있으면(예: 새로고침) 로그인 화면을 다시 거치지 않고 바로 들여보낸다
    if (info.loggedIn) enterWorkspace();
    else showGate();
  } catch (_) {
    renderAccount({ loggedIn: false });
    showGate();
  }
}
refreshAccount();

// 생성 작업이 끝난 뒤 잔액 표시만 갱신한다 — refreshAccount()와 달리 게이트/작업
// 화면을 오가지 않는다(방금 결과를 만든 화면에서 로그인 화면으로 튕겨 나가면 안 되므로).
async function refreshTokenDisplay() {
  try {
    renderAccount(await getJson("/api/me", ""));
  } catch (_) {
    /* 표시 갱신 실패는 조용히 무시 — 다음 생성 때 다시 시도된다 */
  }
}

// index.html의 data-callback="handleGoogleCredential"이 로그인 성공 시 이 함수를 부른다.
window.handleGoogleCredential = async function (response) {
  try {
    const info = await postJson(
      "/api/auth/google",
      { credential: response.credential },
      "구글 로그인에 실패했습니다."
    );
    renderAccount(info);
    enterWorkspace();
  } catch (err) {
    alert(err.message || "구글 로그인에 실패했습니다.");
  }
};

logoutBtn.addEventListener("click", async () => {
  try {
    await postJson("/api/logout", {}, "로그아웃에 실패했습니다.");
  } catch (_) {
    /* 실패해도 화면은 로그아웃 상태로 되돌린다 — 세션 쿠키는 만료되면 어차피 무효 */
  }
  renderAccount({ loggedIn: false });
  showGate();
});

const deleteAccountBtn = $("deleteAccountBtn");
deleteAccountBtn.addEventListener("click", async () => {
  if (!confirm("정말 탈퇴하시겠습니까?\n남은 잔액과 저장된 자료가 모두 사라지며 되돌릴 수 없습니다."))
    return;
  try {
    await postJson("/api/auth/delete", {}, "탈퇴 처리에 실패했습니다.");
  } catch (err) {
    alert(err.message || "탈퇴 처리에 실패했습니다.");
    return;
  }
  renderAccount({ loggedIn: false });
  showGate();
});

/* ── 충전(결제사 연동 전, 비공개 테스트 기간 임시 무료 충전) ── */
const rechargeCustomForm = $("rechargeCustomForm");
const rechargeCustomAmountEl = $("rechargeCustomAmount");
const rechargeCustomBtn = $("rechargeCustomBtn");
const rechargeStatusEl = $("rechargeStatus");
const rechargeErrorEl = $("rechargeError");

async function submitRecharge(amount) {
  rechargeErrorEl.textContent = "";
  if (!Number.isFinite(amount) || amount <= 0) {
    rechargeErrorEl.textContent = "충전할 금액을 올바르게 입력하세요.";
    return;
  }
  rechargeStatusEl.textContent = "충전 중…";
  try {
    const data = await postJson("/api/account/recharge", { amount }, "충전에 실패했습니다.");
    renderAccount({ loggedIn: true, krwRemaining: data.krwRemaining });
    closeModal(rechargeModalEl);
  } catch (err) {
    rechargeErrorEl.textContent = err.message || "충전에 실패했습니다.";
  } finally {
    rechargeStatusEl.textContent = "";
  }
}

/* 충전 버튼은 지금 index.html에서 주석으로 내려 두었다(결제사 연동 전이라 누르면 그냥
   잔액이 늘어나는 상태였다). 여기서 없는 요소에 addEventListener를 걸면 그 자리에서
   app.js가 통째로 죽으므로 — 버튼 하나 때문에 화면 전체가 멎는다 — 있을 때만 건다.
   버튼을 되살리면 이 배선도 그대로 다시 동작한다. */
const openRechargeBtn = $("openRechargeBtn");
if (openRechargeBtn) {
  openRechargeBtn.addEventListener("click", () => {
    rechargeErrorEl.textContent = "";
    rechargeCustomForm.hidden = true;
    rechargeCustomAmountEl.value = "";
    openModal(rechargeModalEl);
  });
}
$("rechargePresets").addEventListener("click", (e) => {
  const btn = e.target.closest(".recharge-preset-btn");
  if (!btn) return;
  submitRecharge(parseInt(btn.dataset.amount, 10));
});
$("rechargeCustomToggleBtn").addEventListener("click", () => {
  rechargeCustomForm.hidden = !rechargeCustomForm.hidden;
  if (!rechargeCustomForm.hidden) rechargeCustomAmountEl.focus();
});
rechargeCustomForm.addEventListener("submit", (e) => {
  e.preventDefault();
  submitRecharge(parseInt(rechargeCustomAmountEl.value, 10));
});

/* ── 이메일/비밀번호 로그인·회원가입 ── */
const loginBtn = $("loginBtn");
const loginErrorEl = $("loginError");
const loginStatusEl = $("loginStatus");
loginPanelEl.addEventListener("submit", async (e) => {
  e.preventDefault();
  const email = $("loginEmail").value.trim();
  const password = $("loginPassword").value;
  loginErrorEl.textContent = "";
  if (!email || !password) {
    loginErrorEl.textContent = "이메일과 비밀번호를 입력하세요.";
    return;
  }
  loginBtn.disabled = true;
  loginStatusEl.textContent = "로그인 중…";
  try {
    const info = await postJson("/api/auth/login", { email, password }, "로그인에 실패했습니다.");
    renderAccount(info);
    enterWorkspace();
  } catch (err) {
    loginErrorEl.textContent = err.message || "로그인에 실패했습니다.";
  } finally {
    loginBtn.disabled = false;
    loginStatusEl.textContent = "";
  }
});

const signupBtn = $("signupBtn");
const signupErrorEl = $("signupError");
const signupStatusEl = $("signupStatus");
const verifyHintEl = $("verifyHint");
let pendingSignupEmail = "";
signupPanelEl.addEventListener("submit", async (e) => {
  e.preventDefault();
  const name = $("signupName").value.trim();
  const email = $("signupEmail").value.trim();
  const password = $("signupPassword").value;
  signupErrorEl.textContent = "";
  if (!email || !password) {
    signupErrorEl.textContent = "이메일과 비밀번호를 입력하세요.";
    return;
  }
  if (password.length < 8) {
    signupErrorEl.textContent = "비밀번호는 8자 이상이어야 합니다.";
    return;
  }
  signupBtn.disabled = true;
  signupStatusEl.textContent = "인증코드 보내는 중…";
  try {
    await postJson("/api/auth/signup", { email, password, name }, "회원가입에 실패했습니다.");
    pendingSignupEmail = email;
    verifyHintEl.textContent = `${email} 로 인증코드를 보냈습니다. 메일함(스팸함 포함)을 확인하세요.`;
    $("verifyCode").value = "";
    showSignupStep("verify");
  } catch (err) {
    signupErrorEl.textContent = err.message || "회원가입에 실패했습니다.";
  } finally {
    signupBtn.disabled = false;
    signupStatusEl.textContent = "";
  }
});

const verifyBtn = $("verifyBtn");
const verifyErrorEl = $("verifyError");
const verifyStatusEl = $("verifyStatus");
verifyPanelEl.addEventListener("submit", async (e) => {
  e.preventDefault();
  const code = $("verifyCode").value.trim();
  verifyErrorEl.textContent = "";
  if (!code) {
    verifyErrorEl.textContent = "인증코드를 입력하세요.";
    return;
  }
  verifyBtn.disabled = true;
  verifyStatusEl.textContent = "확인 중…";
  try {
    const info = await postJson(
      "/api/auth/verify", { email: pendingSignupEmail, code }, "인증에 실패했습니다."
    );
    renderAccount(info);
    enterWorkspace();
  } catch (err) {
    verifyErrorEl.textContent = err.message || "인증에 실패했습니다.";
  } finally {
    verifyBtn.disabled = false;
    verifyStatusEl.textContent = "";
  }
});
$("verifyBackBtn").addEventListener("click", () => showSignupStep("form"));

// ── 학원 마크(로고) — 고정 파일 대신 사용자가 업로드해 이 브라우저에 저장 ──
const BRAND_IMG_STORE = "brand_mark_img";   // data URL
const BRAND_NAME_STORE = "brand_mark_name"; // 학원명 텍스트
const BRAND_MAX_BYTES = 5 * 1024 * 1024;    // 5MB — localStorage 용량 보호
const brandNameEl = $("brandName");
const brandFileEl = $("brandFile");
const brandPreviewEl = $("brandPreview");
const brandRemoveBtn = $("brandRemoveBtn");
const brandMarkEl = $("brandMark");
const brandNameOutEl = $("printBrandName");

function renderBrand() {
  const img = localStorage.getItem(BRAND_IMG_STORE) || "";
  const name = (localStorage.getItem(BRAND_NAME_STORE) || "").trim();

  // 학원명 — 모든 인쇄 페이지 좌하단
  if (brandNameOutEl) brandNameOutEl.textContent = name;

  // 로고 — 모든 인쇄 페이지 우하단
  // 비어 있으면 CSS가 자동으로 숨긴다
  if (brandMarkEl) {
    brandMarkEl.innerHTML = img ? `<img src="${esc(img)}" alt="">` : "";
  }

  // 설정 패널 미리보기
  if (brandPreviewEl) {
    if (!img && !name) {
      brandPreviewEl.innerHTML = `<span class="muted">업로드한 로고가 여기에 미리보기로 표시됩니다.</span>`;
    } else {
      brandPreviewEl.innerHTML =
        (img ? `<img src="${esc(img)}" alt="">` : "") +
        (name ? `<span class="brand-name">${esc(name)}</span>` : "");
    }
  }
}

if (brandNameEl) {
  brandNameEl.value = localStorage.getItem(BRAND_NAME_STORE) || "";
  brandNameEl.addEventListener("input", () => {
    const v = brandNameEl.value.trim();
    if (v) localStorage.setItem(BRAND_NAME_STORE, v);
    else localStorage.removeItem(BRAND_NAME_STORE);
    renderBrand();
  });
}

if (brandFileEl) {
  brandFileEl.addEventListener("change", () => {
    const file = brandFileEl.files && brandFileEl.files[0];
    if (!file) return;
    if (!file.type.startsWith("image/")) {
      errorEl.textContent = "이미지 파일만 업로드할 수 있습니다.";
      brandFileEl.value = "";
      return;
    }
    if (file.size > BRAND_MAX_BYTES) {
      errorEl.textContent = "로고 파일이 너무 큽니다 (5MB 이하로 올려주세요).";
      brandFileEl.value = "";
      return;
    }
    const reader = new FileReader();
    reader.onload = () => {
      localStorage.setItem(BRAND_IMG_STORE, reader.result);
      renderBrand();
    };
    reader.onerror = () => {
      errorEl.textContent = "로고 파일을 읽는 데 실패했습니다.";
    };
    reader.readAsDataURL(file);
  });
}

if (brandRemoveBtn) {
  brandRemoveBtn.addEventListener("click", () => {
    localStorage.removeItem(BRAND_IMG_STORE);
    localStorage.removeItem(BRAND_NAME_STORE);
    if (brandFileEl) brandFileEl.value = "";
    if (brandNameEl) brandNameEl.value = "";
    renderBrand();
  });
}

renderBrand(); // 저장된 마크가 있으면 시작 시 바로 표시

// ── 여러 지문 입력 관리 (지문 추가/삭제) — 지문분석·문제제작 탭이 공유하는 컴포넌트 ──
// 지문 글자수 표시 + 길이에 따른 경고(잘림 위험 안내)
// 권장 길이는 수능·모의고사 지문 한 개(700~900자) 기준.
// 상한을 정하는 건 출력 토큰이 아니라 ① 문장이 많을수록 잦아지는 보정 재요청(=한도 소모)
// ② 인쇄 분량이다. 특히 워크북은 문장마다 6단계를 만들어 1,000자면 벌써 40문항이 넘는다.
// 3.6 Flash 기준 실측·추정으로 잡은 값 — 1,200자가 기본 권장, 1,500자가 상한.
// 1,500자를 넘으면 문장 누락 보정 재요청이 잦아지고 한 요청이 5분을 넘겨
// 중간에 과부하·한도를 만날 위험이 커진다.
const PASSAGE_WARN = 1200;
const PASSAGE_DANGER = 1500;

// 단어 수 — 공백으로 끊어 센다(영어 지문 기준).
// 글자 수만으로는 지문 하나가 얼마나 무거운지 감이 잘 안 와서, 합칠지 나눌지 정할 때
// 보라고 함께 띄운다. 길이 경고(1,200·1,500자)의 기준은 지금까지대로 글자 수다.
function countWords(text) {
  const t = String(text || "").trim();
  return t ? t.split(/\s+/).length : 0;
}

function updatePassageCount(ta) {
  const el = ta.closest(".passage-item").querySelector(".passage-count");
  const text = ta.value.trim();
  const n = text.length;
  el.classList.remove("warn", "danger");
  if (!n) {
    el.textContent = "0자";
    return;
  }
  let msg = `${n.toLocaleString()}자 · ${countWords(text).toLocaleString()}단어`;
  if (n > PASSAGE_DANGER) {
    el.classList.add("danger");
    msg += " · 나눠 넣으세요";
  } else if (n > PASSAGE_WARN) {
    el.classList.add("warn");
    msg += ` · ${PASSAGE_DANGER.toLocaleString()}자까지 권장`;
  }
  el.textContent = msg;
}

// 한 번에 넣을 수 있는 지문 수 상한.
// API 사용량 한도 때문이 아니라(하루 한도는 훨씬 넉넉하다) 지문을 하나씩 순차로
// 처리해서 개수만큼 시간이 늘고, 오래 돌수록 중간에 모델 과부하를 만날 확률이
// 올라가기 때문이다.
//
// 예전에는 10개였다. PDF에서 지문을 꺼내면(📄 PDF에서 가져오기) 모의고사 한 부가
// 25개, 시험 범위 교과서까지 더하면 30개를 넘는데, 10개에서 잘리면 나머지를 다시
// 손으로 넣어야 해서 자동으로 꺼낸 의미가 사라진다. 그래서 시험지 제작 탭과 같은
// 40개로 맞췄다.
//
// 대신 '넣는 것'과 '한 번에 돌리는 것'은 다르다 — 여기 탭들은 지문마다 고른 유형을
// 전부 만들므로 시간·요금이 지문 수에 곱해진다. 지문 10개면 분석에 대략 3~10분
// (꼼꼼 검토 시 2배)이고, 40개면 그 네 배다. 그래서 많이 담긴 상태로 실행할 때는
// 실행 직전에 한 번 더 알린다(runActiveTab의 안내 참고).
const MAX_PASSAGES = 40;
// 이 수를 넘겨 한 번에 실행하려 하면 시간이 얼마나 걸릴지 먼저 알린다.
const MANY_PASSAGES_WARN = 10;

/* ── 붙여넣은 지문의 문장 번호(❶ ① ➊ …) 자동 제거 ──
   교재·기출 자료를 복사하면 문장마다 원문자 번호가 딸려 온다. 그대로 두면
   ① 분석본의 영어 줄에 번호가 섞이고,
   ② 문제 제작에서 앱이 쓰는 보기 기호(어휘·어법의 ①~⑤, 문장삽입의 삽입 위치 ①~⑤)와
      뒤섞여 학생이 무엇을 고르는지 알 수 없게 된다.
   그래서 입력 단계에서 지운다. 지우는 자리는 '문두'뿐이다 —
   문자열 처음 / 줄 처음 / 문장부호 뒤. 문장 중간의 원문자는 보기 기호일 수 있어 남긴다
   (이미 만든 어휘 문제를 다시 붙여넣어도 안전하다).
   ASCII 표기(1. / (1) / 1))는 '1990. That year…' 같은 연도를 잘못 지울 수 있어 건드리지 않는다. */
const CIRCLED_MARKERS =
  "①-⑳" + // ①②③ … ⑳
  "⑴-⒇" + // ⑴⑵⑶ … ⒇
  "⒈-⒛" + // ⒈⒉⒊ … ⒛
  "⓵-⓾" + // ⓵⓶⓷ …
  "❶-❿" + // ❶❷❸ … ❿ (속이 찬 원, 1~10)
  // 속이 찬 원의 11~20은 위 ❶(U+2776) 줄과 이어지지 않고 U+24EB부터 따로 떨어져 있다.
  // 이 줄이 없어서 11번째 문장부터 번호가 그대로 남았다(문장이 10개를 넘는 지문에서만
  // 드러나는 탓에 한동안 눈에 띄지 않았다).
  "⓫-⓴" + // ⓫⓬⓭ … ⓴
  "➀-➉" + // ➀➁➂ …
  "➊-➓" + // ➊➋➌ …
  "㉑-㉟" + // ㉑㉒ … ㉟
  "㊱-㊿" + // ㊱㊲ …
  "㉠-㉻" + // ㉠㉡ / ㉮㉯ (한글 원문자)
  "Ⅰ-Ⅻ";  // ⅠⅡⅢ … (로마 숫자)
// 앞자리(문두 조건)는 캡처 그룹으로 잡아 그대로 되돌려 놓는다.
// 후방탐색((?<=…))을 쓰면 지원하지 않는 구형 브라우저에서 이 파일 전체가
// SyntaxError로 죽으므로 일부러 쓰지 않는다.
// 마커 바로 뒤에 붙는 구분 기호(Ⅰ. / ①) / ㉮:)도 함께 걷어낸다.
// 마커에 '붙어 있는' 것만 지우므로 문장 끝 마침표에는 영향이 없다.
const SENT_MARKER_RE = new RegExp(
  `(^|[\\n\\r]|[.!?"'”’)\\]][ \\t])[ \\t]*[${CIRCLED_MARKERS}][.):\\]]?[ \\t]*`,
  "gm"
);

// 문두 문장 번호를 지운 텍스트와 지운 개수를 돌려준다. 여러 번 적용해도 결과가 같다.
function stripSentenceMarkers(text) {
  let count = 0;
  const out = String(text || "").replace(SENT_MARKER_RE, (m, lead) => {
    count++;
    return lead; // 줄바꿈·문장부호 등 앞자리는 그대로 두고 번호만 걷어낸다
  });
  return { text: out.replace(/[ \t]{2,}/g, " ").trim(), count };
}

/* ── 지문 나누기 기준 ──
   한 칸에 여러 문단을 통째로 붙여넣은 경우를 칸 여러 개로 가른다.
   ① 빈 줄이 있으면 빈 줄을 경계로 삼는다 — 사람이 문단을 나눈 표시이므로 가장 확실하다.
   ② 빈 줄이 하나도 없으면 그때만 줄바꿈을 경계로 쓴다(PDF·교재에서 옮겨 오면 문단
      사이가 빈 줄 없이 한 줄로만 갈라져 있는 경우가 많다).
   합치기가 두 지문 사이에 빈 줄을 넣는 이유가 여기 있다 — 합친 것을 그대로 되돌릴 수 있다. */
function splitPassageText(raw) {
  const text = String(raw || "").trim();
  if (!text) return [];
  const byBlank = text.split(/\n[ \t]*\n+/).map((s) => s.trim()).filter(Boolean);
  if (byBlank.length > 1) return byBlank;
  return text.split(/\n+/).map((s) => s.trim()).filter(Boolean);
}

// max를 받는 이유: 지문 입력칸이 두 벌이고 상한이 서로 다르다(공용 10개 / 시험지 40개).
// 안 넘기면 지금까지대로 MAX_PASSAGES를 쓴다.
function createPassageManager(listEl, addBtn, countEl, onEnter, maxNoteEl, max) {
  const limit = max || MAX_PASSAGES;
  const rowCount = () => listEl.querySelectorAll(".passage-item").length;

  /* '나누기' 버튼에 몇 칸으로 갈라지는지를 미리 적어 둔다.
     빈 줄이 없으면 줄바꿈이 경계가 되므로, 줄마다 개행이 든 지문을 무심코 누르면
     한 줄짜리 칸이 우수수 생길 수 있다. 누르기 전에 '✂ 12개로 나누기'라고 보이면
     그게 내가 원하는 게 아니라는 걸 바로 알 수 있다. */
  function syncSplitBtn(item) {
    const btn = item.querySelector(".passage-split");
    const n = splitPassageText(item.querySelector(".passage-input").value).length;
    btn.hidden = n < 2;
    if (n >= 2) btn.textContent = `✂ ${n}개로 나누기`;
  }

  function renumber() {
    const items = [...listEl.querySelectorAll(".passage-item")];
    items.forEach((it, i) => {
      // 이름을 비워두면 '지문 1', '지문 2' … 가 자동으로 쓰인다(placeholder로 안내)
      it.querySelector(".passage-name").placeholder = `지문 ${i + 1}`;
      it.querySelector(".passage-del").style.visibility =
        items.length > 1 ? "visible" : "hidden";
      // 합칠 상대가 없는 자리에서는 버튼을 아예 감춘다 —
      // 첫 칸에 '위와 합치기', 마지막 칸에 '아래와 합치기'는 누를 데가 없다.
      it.querySelector(".passage-merge-up").hidden = i === 0;
      it.querySelector(".passage-merge-down").hidden = i === items.length - 1;
      // '나누기'는 실제로 나뉠 게 있을 때만 나타난다(평소엔 숨어 있어 머리줄이 붐비지 않는다)
      syncSplitBtn(it);
    });
    const full = items.length >= limit;
    if (countEl) {
      countEl.textContent = full
        ? `· 총 ${items.length}개 (최대)`
        : items.length > 1
        ? `· 총 ${items.length}개`
        : "";
    }
    // 상한에 닿으면 '지문 추가' 버튼을 잠그고 이유를 화면에 띄운다 (삭제하면 다시 풀린다)
    addBtn.disabled = full;
    addBtn.title = full ? `한 번에 넣을 수 있는 지문은 ${limit}개입니다.` : "";
    if (maxNoteEl) {
      maxNoteEl.textContent = full ? `한 번에 넣을 수 있는 지문은 ${limit}개입니다.` : "";
    }
  }

  // afterEl을 넘기면 그 칸 '바로 뒤'에 끼워 넣는다(나누기 전용).
  // 나눈 조각이 목록 맨 아래로 날아가면 원래 지문과 떨어져 순서를 다시 맞춰야 하기 때문이다.
  function addRow(focus, afterEl) {
    if (rowCount() >= limit) return null;
    const item = document.createElement("div");
    item.className = "passage-item";
    item.innerHTML = `
      <div class="passage-item-head">
        <input type="text" class="passage-name" placeholder="지문 1" title="지문 이름 (비워두면 지문 1, 지문 2 …)">
        <span class="passage-count" aria-live="polite"></span>
        <button type="button" class="btn ghost small passage-merge-up" title="바로 위 지문과 하나로 합치기">↑ 위와 합치기</button>
        <button type="button" class="btn ghost small passage-merge-down" title="바로 아래 지문과 하나로 합치기">↓ 아래와 합치기</button>
        <button type="button" class="btn ghost small passage-split" title="문단마다 지문 칸을 나누기" hidden>✂ 나누기</button>
        <button type="button" class="btn ghost small passage-expand" title="지문 전체를 한눈에 보기">🔍 크게 보기</button>
        <button type="button" class="btn ghost small passage-del" title="이 지문 삭제">✕ 삭제</button>
      </div>
      <textarea class="passage-input" placeholder="분석할 영어 지문을 여기에 붙여넣으세요."></textarea>
      <div class="passage-note" hidden></div>`;
    if (afterEl && afterEl.parentNode === listEl) listEl.insertBefore(item, afterEl.nextSibling);
    else listEl.appendChild(item);
    const ta = item.querySelector(".passage-input");
    const nameEl = item.querySelector(".passage-name");
    const noteEl = item.querySelector(".passage-note");
    const splitBtn = item.querySelector(".passage-split");

    // 붙여넣기 직후 문장 번호를 정리하고, 무엇을 지웠는지 알려 준다.
    // 안내는 두 상태를 오간다 — 지운 뒤에는 '되돌리기', 되돌린 뒤에는 '다시 지우기'.
    // undoText는 '방금 지웠다' 상태에서만 값을 갖는다(= 되돌릴 것이 있다는 뜻).
    let undoText = null;

    function noteHtml(msg, cls, label) {
      noteEl.innerHTML = `${msg} <button type="button" class="linkish ${cls}">${label}</button>`;
      noteEl.hidden = false;
    }
    // 현재 입력값에 남아 있는 문장 번호 수에 맞춰 '다시 지우기'를 띄운다(없으면 숨김)
    function offerStrip() {
      const { count } = stripSentenceMarkers(ta.value);
      if (count) noteHtml(`문장 번호 <b>${count}개</b>가 있습니다.`, "passage-restrip", "번호 지우기");
      else noteEl.hidden = true;
    }
    function doStrip() {
      const { text, count } = stripSentenceMarkers(ta.value);
      if (!count) {
        noteEl.hidden = true;
        return;
      }
      undoText = ta.value;
      ta.value = text;
      updatePassageCount(ta);
      noteHtml(`문장 번호 <b>${count}개</b>를 지웠습니다.`, "passage-undo", "되돌리기");
    }

    // 브라우저가 붙여넣기를 반영한 뒤에 값을 읽어야 하므로 다음 틱으로 미룬다.
    // (execCommand 대신 이 방식을 쓰면 브라우저의 되돌리기 스택도 그대로 살아 있다)
    ta.addEventListener("paste", (e) => {
      // 캡처 이미지를 붙여넣으면 텍스트 대신 OCR로 보낸다 (선생님들이 가장 많이 쓰는 경로)
      const shots = [...((e.clipboardData && e.clipboardData.files) || [])].filter(isPhoto);
      if (shots.length) {
        e.preventDefault(); // 이미지가 파일명 같은 텍스트로 새어 들어가는 것을 막는다
        runOcr(shots);
        return;
      }
      setTimeout(doStrip, 0);
    });

    noteEl.addEventListener("click", (e) => {
      if (e.target.closest(".passage-restrip")) {
        // 되돌린 뒤(또는 직접 번호를 넣은 뒤) 다시 지우기 — 항상 '지금 값'을 기준으로 센다
        doStrip();
        ta.focus();
        return;
      }
      if (e.target.closest(".passage-undo") && undoText != null) {
        ta.value = undoText;
        undoText = null;
        updatePassageCount(ta);
        offerStrip();   // 되돌렸으니 이제 다시 지울 수 있다고 알린다
        ta.focus();
        return;
      }
      // 합치기·나누기 되돌리기 — 한 칸이 아니라 목록 전체가 바뀌는 일이라
      // 직전 목록을 통째로 되살린다(칸이 새로 그려지므로 이 안내도 함께 사라진다).
      if (e.target.closest(".passage-op-undo") && item._opUndo) {
        setJobs(item._opUndo);
      }
    });
    ta.addEventListener("keydown", (e) => {
      if ((e.ctrlKey || e.metaKey) && e.key === "Enter" && onEnter) onEnter();
    });
    nameEl.addEventListener("keydown", (e) => {
      if ((e.ctrlKey || e.metaKey) && e.key === "Enter" && onEnter) onEnter();
    });
    ta.addEventListener("input", () => {
      updatePassageCount(ta);
      // 사용자가 직접 고치면 안내를 현재 내용에 맞춘다 — 남은 번호 수가 실제와 어긋나면
      // 안내가 거짓말이 되기 때문. 이때 '되돌리기'는 더 이상 유효하지 않다.
      // (붙여넣기의 input은 doStrip보다 먼저 실행되므로 지운 뒤 안내를 덮지 않는다)
      undoText = null;
      item._opUndo = null;
      offerStrip();
      // 문단이 생기거나 사라지면 '나누기' 버튼도 그에 맞춰 나타났다 숨는다
      syncSplitBtn(item);
      if (item.classList.contains("expanded")) fitExpanded(); // 넓힌 채로 계속 늘려 준다
    });
    updatePassageCount(ta);

    item.querySelector(".passage-merge-up").addEventListener("click", () => mergeRows(item, -1));
    item.querySelector(".passage-merge-down").addEventListener("click", () => mergeRows(item, 1));
    splitBtn.addEventListener("click", () => splitRow(item));

    /* ── '크게 보기' — 지문 전체를 스크롤 없이 한눈에 보이게 칸을 늘린다 ──
       resize:vertical 손잡이를 매번 끌어 늘리는 게 긴 지문에서는 번거로워서,
       버튼 하나로 실제 내용 길이만큼 즉시 펼친다. 화면 높이의 80%를 넘는 아주 긴
       지문은 그 위에서 안쪽 스크롤로 바뀐다(칸 자체가 화면보다 커지지 않도록). */
    const expandBtn = item.querySelector(".passage-expand");
    function fitExpanded() {
      ta.style.height = "auto";
      const max = Math.round(window.innerHeight * 0.8);
      ta.style.height = Math.min(ta.scrollHeight + 2, max) + "px";
    }
    expandBtn.addEventListener("click", () => {
      const on = !item.classList.contains("expanded");
      item.classList.toggle("expanded", on);
      expandBtn.textContent = on ? "🔽 접기" : "🔍 크게 보기";
      expandBtn.classList.toggle("active", on);
      if (on) fitExpanded();
      else ta.style.height = ""; // 원래 min-height·수동 크기 조절로 되돌림
    });

    item.querySelector(".passage-del").addEventListener("click", () => {
      item.remove();
      renumber();
    });
    renumber();
    if (focus) ta.focus();
    return ta;
  }

  addBtn.addEventListener("click", () => addRow(true));

  /* ══════ 합치기 · 나누기 ══════
     둘 다 실행 버튼을 누르기 전, 입력칸 안에서만 일어나는 일이다. 서버로 가는 것은
     지금까지와 똑같은 지문 목록이라 요금·모델 계산에는 영향이 없다(지문 수가 줄면
     그만큼 요금도 줄어들 뿐이다). */

  // 지금 목록 전체(빈 칸 포함)를 그대로 떠 둔다 — 되돌리기용.
  // getJobs는 빈 칸을 버리므로 되살리기에는 쓸 수 없어 따로 만든다.
  function snapshotRows() {
    return [...listEl.querySelectorAll(".passage-item")].map((it) => {
      const name = it.querySelector(".passage-name").value.trim();
      return { text: it.querySelector(".passage-input").value, name, named: !!name };
    });
  }

  // 합치기·나누기 결과를 그 칸 아래 안내줄에 알린다(붙여넣기 정리 안내와 같은 자리).
  // snap을 주면 '되돌리기'가 함께 뜬다.
  function showOpNote(item, msg, snap) {
    item._opUndo = snap || null;
    const noteEl = item.querySelector(".passage-note");
    let html = snap
      ? `${msg} <button type="button" class="linkish passage-op-undo">되돌리기</button>`
      : msg;
    // 이 안내가 붙여넣기 정리 안내와 같은 자리를 쓰므로, 남아 있는 문장 번호 안내를
    // 덮어 지워 버리지 않도록 함께 적어 둔다(둘 다 지금 이 칸의 상태다).
    const left = stripSentenceMarkers(item.querySelector(".passage-input").value).count;
    if (left) {
      html += ` · 문장 번호 <b>${left}개</b> <button type="button" class="linkish passage-restrip">번호 지우기</button>`;
    }
    noteEl.innerHTML = html;
    noteEl.hidden = false;
  }

  // dir: -1이면 위 칸과, 1이면 아래 칸과 합친다. 남는 칸은 사라진다.
  // 이름은 위쪽 칸 것을 쓰되, 위가 비어 있고 아래에만 이름이 있으면 그것을 가져온다.
  function mergeRows(item, dir) {
    const other = dir < 0 ? item.previousElementSibling : item.nextElementSibling;
    if (!other || !other.classList.contains("passage-item")) return;
    const top = dir < 0 ? other : item;
    const bottom = dir < 0 ? item : other;
    const snap = snapshotRows();
    const topTa = top.querySelector(".passage-input");
    const topName = top.querySelector(".passage-name");
    const botName = bottom.querySelector(".passage-name").value.trim();
    if (!topName.value.trim() && botName) topName.value = botName;
    // 사이에 빈 줄을 넣는다 — 문단 경계가 남아 '나누기'로 그대로 되돌릴 수 있다
    const merged = [topTa.value.trim(), bottom.querySelector(".passage-input").value.trim()]
      .filter(Boolean)
      .join("\n\n");
    bottom.remove();
    topTa.value = merged;
    // 글자·단어 수와 '나누기' 버튼을 직접 입력했을 때와 똑같이 갱신한다
    topTa.dispatchEvent(new Event("input", { bubbles: true }));
    renumber();
    // input이 _opUndo를 지우므로 안내는 반드시 그 뒤에 붙인다
    showOpNote(top, "지문 2개를 합쳤습니다.", snap);
    topTa.focus();
  }

  // 문단마다 칸을 나눈다. 새 칸은 원래 칸 바로 뒤에 들어간다.
  function splitRow(item) {
    const ta = item.querySelector(".passage-input");
    let parts = splitPassageText(ta.value);
    if (parts.length < 2) return;
    const room = limit - rowCount(); // 더 만들 수 있는 칸 수
    if (room <= 0) {
      showOpNote(item, `지문 칸이 ${limit}개로 꽉 차서 나눌 수 없습니다. 다른 칸을 지우거나 합친 뒤 다시 눌러 주세요.`, null);
      return;
    }
    const snap = snapshotRows();
    let piled = 0; // 칸이 모자라 마지막 칸에 함께 남긴 문단 수
    if (parts.length - 1 > room) {
      // 상한에 걸려도 글은 절대 버리지 않는다 — 남는 문단은 마지막 칸에 모아 둔다
      piled = parts.length - room;
      parts = parts.slice(0, room).concat([parts.slice(room).join("\n\n")]);
    }
    const nameEl = item.querySelector(".passage-name");
    const base = nameEl.value.trim();
    ta.value = parts[0];
    if (base) nameEl.value = `${base} (1)`;
    ta.dispatchEvent(new Event("input", { bubbles: true }));
    let anchor = item;
    parts.slice(1).forEach((text, i) => {
      const newTa = addRow(false, anchor);
      if (!newTa) return;
      newTa.value = text;
      const row = newTa.closest(".passage-item");
      if (base) row.querySelector(".passage-name").value = `${base} (${i + 2})`;
      newTa.dispatchEvent(new Event("input", { bubbles: true }));
      anchor = row;
    });
    renumber();
    showOpNote(
      item,
      `지문 <b>${parts.length}개</b>로 나눴습니다.` +
        (piled ? ` (칸이 모자라 마지막 문단 ${piled}개는 한 칸에 모았습니다)` : ""),
      snap
    );
  }

  function clearAll() {
    listEl.innerHTML = "";
    addRow(false);
  }

  function getJobs() {
    const items = [...listEl.querySelectorAll(".passage-item")];
    const jobs = [];
    items.forEach((it, i) => {
      const text = it.querySelector(".passage-input").value.trim();
      if (!text) return;
      const typed = it.querySelector(".passage-name").value.trim();
      jobs.push({
        no: i + 1,
        text,
        name: typed || `지문 ${i + 1}`, // 이름을 안 쓰면 기본 이름
        named: !!typed,                  // 직접 지은 이름인지
      });
    });
    return jobs;
  }

  // 저장해 둔 지문 목록으로 입력칸을 통째로 되살린다("불러오기"에서만 쓰인다 —
  // 평소 입력은 저장하지 않는다는 원칙과는 별개로, 사용자가 직접 누른 "저장" 결과를
  // 불러올 때만 예외적으로 지문을 채운다).
  function setJobs(jobs) {
    listEl.innerHTML = "";
    const list = Array.isArray(jobs) && jobs.length ? jobs : [null];
    list.forEach((job) => {
      const ta = addRow(false);
      if (!ta || !job) return; // 상한(limit)에 걸리면 나머지는 건너뜀
      ta.value = job.text || "";
      if (job.named && job.name) {
        ta.closest(".passage-item").querySelector(".passage-name").value = job.name;
      }
      updatePassageCount(ta);
    });
    renumber();
  }

  /* 저장해 둔 지문을 지금 있는 칸을 그대로 두고 '뒤에' 이어 붙인다.
     setJobs가 통째로 갈아 끼우는 것과 짝이 된다 — 시험 범위가 교과서 단원 여럿에
     걸쳐 있으면 저장도 단원별로 나눠 하게 되는데, 그걸 다시 한자리에 모으려면
     불러올 때마다 앞엣것이 사라지지 않아야 한다.

     비어 있는 칸은 먼저 치운다. 시작할 때 자동으로 생기는 빈 칸 하나가 붙인 지문들
     사이에 끼면 결과물에 빈 지문이 섞인다(getJobs가 빈 칸을 걸러내긴 하지만, 화면에
     남은 빈 칸이 '몇 개짜리인지'를 헷갈리게 한다).

     반환 {added, full} — full이면 상한에 걸려 못 넣은 것이 있다는 뜻이다. */
  function appendJobs(jobs) {
    const list = (Array.isArray(jobs) ? jobs : []).filter(
      (j) => j && String(j.text || "").trim()
    );
    if (!list.length) return { added: 0, full: false };

    [...listEl.querySelectorAll(".passage-item")].forEach((it) => {
      if (!it.querySelector(".passage-input").value.trim()) it.remove();
    });

    let added = 0;
    let full = false;
    for (const job of list) {
      const ta = addRow(false);
      if (!ta) {
        full = true;   // 상한에 닿았다 — 남은 것은 넣지 않는다
        break;
      }
      ta.value = job.text;
      if (job.named && job.name) {
        ta.closest(".passage-item").querySelector(".passage-name").value = job.name;
      }
      updatePassageCount(ta);
      added++;
    }
    if (!rowCount()) addRow(false);   // 하나도 못 넣었으면 빈 칸은 남겨 둔다
    renumber();
    return { added, full };
  }

  // 사진·PDF에서 옮겨 온 지문을 입력칸에 채운다. 빈 칸부터 쓰고, 없으면 칸을 늘린다.
  // 사진 1장 = 지문 1개, PDF 문단(문항) 1개 = 지문 1개이므로 텍스트 하나가 칸 하나를 차지한다.
  //
  // 본문만 넣고 '지문 이름'은 건드리지 않는다. 예전에는 PDF에서 뽑은 '31번'·소제목을
  // 이름칸에 자동으로 넣었는데, 잘 맞는 것은 문항 번호가 또렷한 모의고사뿐이었다.
  // 교과서·부교재는 쪽머리·단원 제목·본문 첫 줄이 뒤섞여 엉뚱한 이름이 붙었고,
  // 그 이름이 결과물 이름표와 저장 파일명에까지 그대로 따라갔다. 자동으로 붙은 이름은
  // 손으로 지우기 전에는 사라지지 않으니, 아예 비워 두고 선생님이 짓게 한다.
  // 반환: 실제로 채웠으면 true (상한 limit에 걸리면 false)
  function fillText(raw) {
    const text = String(raw || "").trim();
    if (!text) return false;
    let ta = [...listEl.querySelectorAll(".passage-input")].find((t) => !t.value.trim());
    if (!ta) ta = addRow(false);
    if (!ta) return false;   // 지문 칸 상한에 닿음
    ta.value = text;
    // 글자 수·안내를 직접 입력했을 때와 똑같이 갱신한다
    // (문장번호가 남아 있으면 '번호 지우기' 안내가 자동으로 뜬다)
    ta.dispatchEvent(new Event("input", { bubbles: true }));
    renumber();
    return true;
  }

  return { addRow, getJobs, setJobs, appendJobs, renumber, clearAll, fillText };
}

// 모든 탭이 공유하는 지문 입력 (탭 밖 공통 패널) — 별도 저장소 없이 화면 하나로 공유
const passageMgr = createPassageManager(
  passageListEl,
  addPassageBtn,
  passageCountEl,
  () => runActiveTab(),
  $("passageMaxNote")
);
// Ctrl+Enter는 현재 열려 있는 탭의 실행 버튼을 누른다
function runActiveTab() {
  const active = document.querySelector(".tab-page.active");
  const btn = active && active.querySelector("#analyzeBtn, #mcqBtn, #saqBtn, #wbBtn");
  if (btn && !btn.disabled) btn.click();
}

// 지문은 저장하지 않는다 (파일 맨 위 localStorage.clear()와 같은 취지)
passageMgr.addRow(false); // 시작 시 지문 입력칸 1개
clearPassagesBtn.addEventListener("click", () => {
  if (confirm("입력한 지문을 모두 지우시겠습니까?\n되돌릴 수 없습니다.")) {
    passageMgr.clearAll();
  }
});

/* 입력한 지문만 따로 저장한다 — 제작 결과물과는 별개의 저장 종류.
   아직 아무것도 만들지 않았어도(분석·문제 실행 전에도) 타이핑한 지문을 넣어 둘 수 있게
   해서, 다음에 와서 불러온 뒤 원하는 탭을 돌리면 되도록 한다. 다른 탭 저장과 같은
   TAB_SAVE 레지스트리에 얹으므로 저장 모달·목록·삭제 배선은 그대로 재사용된다. */
TAB_SAVE.passage = {
  saveBtn: $("passageSaveBtn"),
  canSave: () => (passageMgr.getJobs().length ? "" : "저장할 지문이 없습니다. 지문을 먼저 입력해 주세요."),
  // 목표 어법도 함께 담는다 — 이제 이 패널에 같이 있고, 지문과 한 벌로 쓰이는 설정이다
  getPayload: () => ({ passages: passageMgr.getJobs(), targetGrammar: grammarEl.value }),
  /* mode "append"면 지금 입력칸을 비우지 않고 뒤에 이어 붙인다 (저장함의 [뒤에 붙이기]).
     목표 어법은 그때 덮어쓰지 않는다 — 이어 붙이는 저장본의 값으로 지금 것을 바꾸면,
     앞서 불러온 지문에 맞춰 적어 둔 어법이 조용히 사라진다. 비어 있을 때만 채운다. */
  applyPayload: (payload, mode) => {
    if (mode === "append") {
      const { added, full } = passageMgr.appendJobs(payload.passages || []);
      if (!grammarEl.value.trim()) grammarEl.value = payload.targetGrammar || "";
      const total = passageMgr.getJobs().length;
      ocrStatus(
        full
          ? `지문 ${added}개를 뒤에 붙였습니다 (총 ${total}개). 칸이 가득 차 나머지는 넣지 못했습니다 — 필요 없는 지문을 지우고 다시 붙여 주세요.`
          : `지문 ${added}개를 뒤에 붙였습니다 (총 ${total}개).`,
        full ? "warn" : "ok"
      );
    } else {
      passageMgr.setJobs(payload.passages || []);
      grammarEl.value = payload.targetGrammar || "";
    }
    passageListEl.scrollIntoView({ behavior: "smooth", block: "start" });
  },
};

/* ══════════════ 사진에서 지문 가져오기 (OCR) ══════════════
   Gemini가 멀티모달이라 지금 쓰는 API 키·엔드포인트를 그대로 쓴다 (별도 OCR 서비스 없음).
   사진 1장 = 지문 1개. 여러 장을 올리면 장마다 따로 요청한다 — 한 장이 실패해도 나머지는
   살고, 끝나는 대로 입력칸에 채워져 진행이 보이기 때문.
   결과는 입력칸에 채우기만 하고 실행은 사용자가 직접 누른다 — 잘못 읽은 단어 하나가
   분석·문제 전체를 오염시키므로 검토 단계를 건너뛰지 않는다. */
const ocrBtn = $("ocrBtn");
const ocrFileEl = $("ocrFile");
const ocrStatusEl = $("ocrStatus");

// 업로드 전 축소 — 긴 변 1600px면 지문 글자를 읽기에 충분하고,
// 전송량·토큰·처리 시간이 크게 준다 (4MB 사진 → 대개 0.3MB 안팎).
const OCR_MAX_EDGE = 1600;
const OCR_JPEG_QUALITY = 0.85;
const OCR_MAX_UPLOAD = 12 * 1024 * 1024; // base64 기준. 서버 상한(14MB)보다 먼저 잡는다

// 사진인지 판정. 끌어다 놓기나 일부 파일 관리자는 type을 비워 주므로 확장자로도 확인한다.
function isPhoto(file) {
  const type = (file.type || "").toLowerCase();
  const name = (file.name || "").toLowerCase();
  return /^image\//.test(type) || /\.(jpe?g|png|webp|heic|heif|bmp)$/.test(name);
}

function blobToBase64(blob) {
  return new Promise((resolve, reject) => {
    const fr = new FileReader();
    fr.onload = () => resolve(String(fr.result).split(",")[1] || "");
    fr.onerror = () => reject(new Error("파일을 읽지 못했습니다."));
    fr.readAsDataURL(blob);
  });
}

async function photoToPart(file) {
  try {
    const bmp = await createImageBitmap(file);
    const scale = Math.min(1, OCR_MAX_EDGE / Math.max(bmp.width, bmp.height));
    const w = Math.max(1, Math.round(bmp.width * scale));
    const h = Math.max(1, Math.round(bmp.height * scale));
    const cv = document.createElement("canvas");
    cv.width = w;
    cv.height = h;
    cv.getContext("2d").drawImage(bmp, 0, 0, w, h);
    if (bmp.close) bmp.close();
    const blob = await new Promise((r) => cv.toBlob(r, "image/jpeg", OCR_JPEG_QUALITY));
    if (!blob) throw new Error("no blob");
    return { mime: "image/jpeg", data: await blobToBase64(blob) };
  } catch {
    // 브라우저가 못 여는 형식(아이폰 HEIC 등)은 원본 그대로 보내 모델에 맡긴다
    return { mime: file.type || "image/jpeg", data: await blobToBase64(file) };
  }
}

/* ── 재현(RECITATION) 차단 우회: 사진을 가로로 잘라 조각별로 읽기 ──
   Gemini는 '학습 데이터의 원문을 길게 그대로 재현'하는 출력을 막는다. 수능·모평 기출처럼
   널리 공개된 지문은 통째로 옮기려 하면 이 검사에 걸린다. 사진을 몇 조각으로 나누면
   조각 하나가 만드는 출력이 짧아져 긴 연속 일치가 생기지 않아 통과한다.
   조각 경계에서 문장이 잘리므로 위아래를 겹쳐 자르고, 이어 붙일 때 겹친 부분을 지운다. */
const OCR_SLICE_OVERLAP = 0.14; // 조각끼리 겹치는 비율 — 경계에서 잘린 문장을 살리기 위함

async function sliceImage(file, count) {
  const bmp = await createImageBitmap(file);
  const scale = Math.min(1, OCR_MAX_EDGE / Math.max(bmp.width, bmp.height));
  const w = Math.max(1, Math.round(bmp.width * scale));
  const fullH = Math.max(1, Math.round(bmp.height * scale));
  const band = fullH / count;
  const pad = band * OCR_SLICE_OVERLAP;
  const parts = [];
  for (let i = 0; i < count; i++) {
    const top = Math.max(0, Math.round(i * band - pad));
    const bottom = Math.min(fullH, Math.round((i + 1) * band + pad));
    const h = bottom - top;
    if (h <= 0) continue;
    const cv = document.createElement("canvas");
    cv.width = w;
    cv.height = h;
    // 원본 좌표계로 되돌려 해당 띠만 그린다
    cv.getContext("2d").drawImage(
      bmp, 0, top / scale, bmp.width, h / scale, 0, 0, w, h
    );
    const blob = await new Promise((r) => cv.toBlob(r, "image/jpeg", OCR_JPEG_QUALITY));
    parts.push({ mime: "image/jpeg", data: await blobToBase64(blob) });
  }
  if (bmp.close) bmp.close();
  return parts;
}

// 이어 붙이기 — 겹쳐 자른 탓에 같은 문장이 두 조각에 모두 나온다. 앞 조각의 끝과
// 뒤 조각의 시작에서 가장 긴 공통 부분을 찾아 한 번만 남긴다.
function joinOverlap(a, b) {
  if (!a) return b;
  if (!b) return a;
  const norm = (s) => s.replace(/\s+/g, " ").trim().toLowerCase();
  const na = norm(a);
  const nb = norm(b);
  const max = Math.min(na.length, nb.length, 600);
  for (let k = max; k >= 25; k--) {
    if (na.slice(-k) === nb.slice(0, k)) {
      // 겹친 길이만큼 뒤 조각 앞부분을 잘라낸다 (정규화 전 문자열 기준으로 근사)
      let cut = 0, seen = 0;
      while (cut < b.length && seen < k) {
        if (!/\s/.test(b[cut]) || (seen > 0 && !/\s/.test(b[cut - 1]))) seen++;
        cut++;
      }
      return a.replace(/\s+$/, "") + " " + b.slice(cut).replace(/^\s+/, "");
    }
  }
  return a.replace(/\s+$/, "") + " " + b.replace(/^\s+/, "");
}

function ocrStatus(html, tone) {
  ocrStatusEl.innerHTML = html;
  ocrStatusEl.className = "ocr-status" + (tone ? " " + tone : "");
  ocrStatusEl.hidden = !html;
}

function isRecitationError(err) {
  if (err && err.code === "recitation") return true;
  return /RECITATION/i.test((err && err.message) || "");
}

// 사진을 조각내어 읽고 이어 붙인다. 조각 수를 늘려 가며 시도하고, 조각조차 막히면 포기한다.
async function ocrBySlices(file, who, onProgress) {
  let lastErr = null;
  for (const count of [3, 5]) {
    try {
      const slices = await sliceImage(file, count);
      let text = "";
      const notes = [];
      for (let i = 0; i < slices.length; i++) {
        onProgress(`나눠 읽는 중… (${i + 1}/${slices.length})`);
        const part = slices[i];
        const data = await postJson(
          "/api/ocr",
          { file: part, partial: true },
          "조각을 옮기지 못했습니다."
        );
        text = joinOverlap(text, data.text || "");
        if (data.note) notes.push(data.note);
      }
      if (text.trim()) return { text: text.trim(), note: notes.join(" ") };
      lastErr = new Error("나눠 읽었지만 지문을 찾지 못했습니다.");
    } catch (err) {
      lastErr = err;
      // 한도 소진이면 조각을 더 쪼개 봐야 소용없다
      if (isQuotaError(err)) throw err;
    }
  }
  // 통짜로도, 나눠서도 막혔다 — 사용자가 다음에 뭘 할지 알 수 있게 안내한다
  if (isRecitationError(lastErr)) {
    const e = new Error(
      "널리 공개된 지문이라 사진을 나눠서까지 시도했지만 모두 차단되었습니다(RECITATION). " +
        "지문을 문단별로 따로 찍어 올리거나, 글자를 직접 붙여넣어 주세요."
    );
    e.code = "recitation";
    throw e;
  }
  throw lastErr || new Error("사진을 나눠 읽는 데 실패했습니다.");
}

let ocrBusy = false;

async function runOcr(fileList) {
  const files = [...fileList].filter((f) => f && isPhoto(f));
  if (!files.length) {
    ocrStatus("사진(JPG·PNG·WEBP)만 올릴 수 있습니다.", "warn");
    return;
  }
  if (ocrBusy) return;
  ocrBusy = true;
  ocrBtn.disabled = true;

  let added = 0;
  const notes = [];
  const fails = [];

  for (let i = 0; i < files.length; i++) {
    const file = files[i];
    const who = file.name || `사진 ${i + 1}`;
    ocrStatus(
      `<span class="spinner"></span> ${esc(who)} 읽는 중… (${i + 1}/${files.length})`
    );
    try {
      const part = await photoToPart(file);
      // 다 올려 놓고 거절당하면 시간만 버린다 — 여기서 먼저 잡는다
      if (part.data.length > OCR_MAX_UPLOAD) {
        fails.push(`${who} — 사진이 너무 큽니다. 더 작게 찍어 올려 주세요.`);
        continue;
      }
      let data;
      try {
        data = await postJson(
          "/api/ocr",
          { file: part },
          "사진에서 지문을 옮기지 못했습니다."
        );
      } catch (err) {
        if (!isRecitationError(err)) throw err;
        // 널리 공개된 지문이라 통째로는 막혔다 — 사진을 잘라 조각별로 읽어 이어 붙인다
        data = await ocrBySlices(file, who, (msg) =>
          ocrStatus(`<span class="spinner"></span> ${esc(who)} ${msg}`)
        );
        notes.push(`${who}: 널리 공개된 지문이라 사진을 나눠 읽었습니다. 문장이 이어지는지 특히 잘 확인하세요.`);
      }
      if (data.note) notes.push(`${who}: ${data.note}`);
      if (passageMgr.fillText(data.text)) added++;
      else fails.push(`${who} — 지문 칸이 가득 차 더 넣지 못했습니다.`);
    } catch (err) {
      const msg = err.message || String(err);
      fails.push(`${who} — ${msg}`);
      // 한도 소진은 기다려도 안 풀린다 — 남은 사진을 시도하지 않는다
      if (isQuotaError(err)) {
        const left = files.length - (i + 1);
        if (left > 0) fails.push(`한도 초과로 중단했습니다. 남은 ${left}장은 시도하지 않았습니다.`);
        break;
      }
    }
  }

  const parts = [];
  if (added) {
    parts.push(
      `<b>지문 ${added}개</b>를 입력칸에 옮겼습니다. ` +
        `사진과 대조해 <b>오타가 없는지 확인한 뒤</b> 실행하세요.`
    );
  }
  notes.forEach((n) => parts.push(`⚠️ ${esc(n)}`));
  fails.forEach((f) => parts.push(`❌ ${esc(f)}`));
  if (!parts.length) parts.push("옮길 지문을 찾지 못했습니다.");
  ocrStatus(parts.join("<br>"), added ? (fails.length ? "warn" : "ok") : "warn");

  ocrBusy = false;
  ocrBtn.disabled = false;
  ocrFileEl.value = ""; // 같은 파일을 다시 골라도 change가 나도록 비운다
  refreshTokenDisplay();
}

ocrBtn.addEventListener("click", () => ocrFileEl.click());
ocrFileEl.addEventListener("change", () => {
  if (ocrFileEl.files && ocrFileEl.files.length) runOcr(ocrFileEl.files);
});

/* ══════════════ PDF에서 지문 가져오기 ══════════════
   사진 OCR과 목적은 같지만 길이 다르다. 교과서 본문·모의고사 PDF는 '글자로 만든'
   파일이라 글자가 이미 안에 들어 있어, 서버가 그대로 꺼내 문단(문항)마다 지문 하나로
   나눈다 — AI를 부르지 않으므로 요금이 들지 않고 옮겨 적다 생기는 오타도 없다.
   시험 범위가 30개를 넘어도 한 번에 담기는 것이 이 기능의 요점이다.
   규칙으로 못 나누는 자료를 만나면 서버가 canAi로 알려 주고, 그때만 AI에게
   '지문이 몇째 줄부터 몇째 줄까지인지'를 물어본다(본문은 그대로 원문에서 잘라 쓴다).
   결과는 입력칸에 채우기만 하고 실행은 사용자가 직접 누른다 — 사진 OCR과 같은 이유다. */
const pdfBtn = $("pdfBtn");
const pdfFileEl = $("pdfFile");
const examPdfBtn = $("examPdfBtn");
const examPdfFileEl = $("examPdfFile");
const examPassageStatusEl = $("examPassageStatus");

const PDF_MAX_UPLOAD = 9 * 1024 * 1024; // base64 기준. 서버 상한(10MB)보다 먼저 잡는다

// PDF인지 판정. 끌어다 놓기나 일부 파일 관리자는 type을 비워 주므로 확장자로도 확인한다.
function isPdf(file) {
  const type = (file.type || "").toLowerCase();
  const name = (file.name || "").toLowerCase();
  return type === "application/pdf" || /\.pdf$/.test(name);
}

function statusWriter(el) {
  return (html, tone) => {
    el.innerHTML = html;
    el.className = "ocr-status" + (tone ? " " + tone : "");
    el.hidden = !html;
  };
}
const examPassageStatus = statusWriter(examPassageStatusEl);

let pdfBusy = false;

/* ── 도표·실용문 가려내기 ──

   모의고사 한 벌에는 서술문만 들어 있지 않다. 도표 설명(25번), 안내문(27·28번)이 섞여
   있는데, 이 지문으로 빈칸·순서·문장삽입을 만들면 말이 안 되는 문항이 나온다. 실측한
   시험지에서 도표 지문으로 만든 어휘 문항이 "The graph above shows…"로 시작했는데
   정작 그 그래프는 시험지에 없었고, 축제 안내문(When & Where · ※ 홈페이지 주소)에는
   빈칸 추론이 걸려 있었다.

   그래서 PDF에서 꺼낼 때 이런 지문은 빼 두고, 다 넣은 뒤에 "추가할까요?"를 묻는다.
   버리지 않는 이유는 내용일치처럼 이들 지문이 제격인 유형도 있어서다 — 고르는 것은
   선생님 몫이고, 이 함수는 '기본값을 어느 쪽에 둘지'만 정한다.

   Gemini를 부르지 않고 글 모양만 본다. 서버가 지문을 넘길 때 _pdf_clean_passage가
   줄바꿈을 전부 공백으로 눌러 버리므로(`\s+` → ' '), '짧은 줄이 많다' 같은 줄 단위
   신호는 쓸 수 없다. 살아남는 표시만 센다 — 가운뎃점·※·주소·항목 이름.

   인물 소개(26번)는 여기서 가려내지 못한다. 평범한 서술문이라 글 모양이 다른 지문과
   같아서, 규칙으로 잡으려 들면 멀쩡한 지문까지 걸린다. */
const PDF_CHART_RE = /\b(?:graph|chart|table)\s+above\b|\babove\s+(?:graph|chart|table)\b/i;
const PDF_LABEL_RE = /\b(?:When|Where|Date|Time|Place|Venue|Fee|Cost|Location|Contact|Registration|Deadline|Notes?|Hours|Admission|Prizes?|Eligibility)\s*:/gi;

function passageShape(text) {
  const t = String(text || "");
  if (!t.trim()) return "";
  if (PDF_CHART_RE.test(t)) return "도표";

  let hits = 0;
  // 가운뎃점이 여럿이면 항목을 나열한 것이다 — 가장 확실한 표시라 둘로 센다
  if ((t.match(/[•·▪‣]/g) || []).length >= 3) hits += 2;
  if (/※/.test(t)) hits++;
  if (/\b(?:www\.|https?:\/\/)/i.test(t)) hits++;
  // "When:" 하나쯤은 서술문에도 나온다. 둘 이상이면 안내문 꼴이다.
  const labels = (t.match(PDF_LABEL_RE) || []).length;
  hits += labels >= 2 ? 2 : labels;

  return hits >= 2 ? "실용문" : "";
}

/* ── 문항 번호로 빼기 ──
   글 모양만으로는 인물 소개(26번)를 못 가려낸다. 평범한 서술문이라 다른 지문과 모양이
   같아서, 규칙으로 잡으려 들면 멀쩡한 지문까지 걸린다. 대신 번호를 본다 — 수능형
   편집에서 도표·인물 소개·안내문이 놓이는 자리가 정해져 있다.

   서버가 붙여 준 이름("25번", "27~28번")을 여기서만 읽고 버린다. 지문 이름칸에는 이
   값을 쓰지 않으므로(교과서에서 엉뚱하게 붙는다), 번호를 잘못 읽어도 지문 이름을
   더럽히지 않고 아래 확인 창에서 체크 한 번으로 되돌릴 수 있다. */
const PDF_SKIP_NOS = new Set([25, 26, 27, 28]);
const PDF_SKIP_LABEL = { 25: "도표", 26: "인물 소개", 27: "안내문", 28: "안내문" };

function pdfQuestionNos(name) {
  const m = /^(\d+)\s*(?:~\s*(\d+))?번$/.exec(String(name || "").trim());
  if (!m) return [];
  const from = Number(m[1]);
  const to = m[2] ? Number(m[2]) : from;
  // 10문항을 넘는 묶음은 번호를 잘못 읽은 것으로 본다
  if (!(from >= 1 && to >= from && to - from < 10)) return [];
  return Array.from({ length: to - from + 1 }, (_, i) => from + i);
}

/* PDF에서 빼 둔 지문. 확인 창에서 고를 때까지 여기 들고 있는다.
   한 번에 한 PDF만 읽으므로(pdfBusy) 자리는 하나면 된다. */
let pdfHeldBack = null;
const pdfHeldGuideEl = $("pdfHeldGuide");
const pdfHeldListEl = $("pdfHeldList");

function closePdfHeldGuide() {
  pdfHeldGuideEl.hidden = true;
  pdfHeldBack = null;
}

function openPdfHeldGuide(mgr, status, items) {
  pdfHeldBack = { mgr, status, items };
  $("pdfHeldLead").innerHTML =
    `지문 <b>${items.length}개</b>를 넣지 않고 남겨 두었습니다. ` +
    `모의고사의 <b>도표(25번) · 인물 소개(26번) · 안내문(27·28번)</b>은 ` +
    `빈칸·순서·문장삽입 같은 유형에 맞지 않아 기본으로 빼 둡니다.`;
  pdfHeldListEl.innerHTML = items
    .map(
      (it, i) => `
    <label class="pdf-held-item">
      <input type="checkbox" data-i="${i}" checked>
      <span class="pdf-held-body">
        <span class="pdf-held-head">
          ${it.no ? `<span class="pdf-held-no">${esc(it.no)}</span>` : ""}
          ${it.kind ? `<span class="pdf-held-kind">${esc(it.kind)}</span>` : ""}
        </span>
        <span class="pdf-held-text">${esc(it.text.slice(0, 170))}…</span>
      </span>
    </label>`
    )
    .join("");
  pdfHeldGuideEl.hidden = false;
}

$("pdfHeldSkip").addEventListener("click", closePdfHeldGuide);
pdfHeldGuideEl.addEventListener("click", (e) => {
  if (e.target === pdfHeldGuideEl) closePdfHeldGuide();
});

$("pdfHeldAdd").addEventListener("click", () => {
  if (!pdfHeldBack) return closePdfHeldGuide();
  const { mgr, status, items } = pdfHeldBack;
  const picked = [...pdfHeldListEl.querySelectorAll("input:checked")]
    .map((el) => items[Number(el.dataset.i)])
    .filter(Boolean);
  closePdfHeldGuide();
  if (!picked.length) return;

  let added = 0;
  let full = false;
  for (const it of picked) {
    if (mgr.fillText(it.text)) added++;
    else {
      full = true;
      break;
    }
  }
  status(
    `<b>지문 ${added}개</b>를 추가했습니다.` +
      (full ? " 지문 칸이 가득 차 나머지는 넣지 못했습니다." : "") +
      ` 이런 지문은 <b>내용일치</b>처럼 글 전체를 묻는 유형에 쓰세요.`,
    full ? "warn" : "ok"
  );
});

// mgr: 채울 지문칸 관리자(공용 또는 시험 범위), status: 안내를 그리는 함수
async function runPdfImport(fileList, mgr, status) {
  const files = [...fileList].filter(isPdf);
  if (!files.length) {
    status("PDF 파일만 올릴 수 있습니다.", "warn");
    return;
  }
  if (pdfBusy) return;
  pdfBusy = true;
  [pdfBtn, examPdfBtn].forEach((b) => b && (b.disabled = true));

  let added = 0;
  let full = false;
  const notes = [];
  const fails = [];
  const held = [];   // 도표·실용문 — 다 넣은 뒤에 추가할지 묻는다
  pdfHeldBack = null;

  for (let i = 0; i < files.length; i++) {
    const file = files[i];
    const who = file.name || `PDF ${i + 1}`;
    status(`<span class="spinner"></span> ${esc(who)} 읽는 중… (${i + 1}/${files.length})`);
    try {
      const data = await blobToBase64(file);
      // 다 올려 놓고 거절당하면 시간만 버린다 — 여기서 먼저 잡는다
      if (data.length > PDF_MAX_UPLOAD) {
        fails.push(`${who} — 파일이 너무 큽니다. 쪽을 나눠 올려 주세요.`);
        continue;
      }
      const payload = { file: { mime: "application/pdf", data } };
      let res = await postJson("/api/pdfsplit", payload, "PDF에서 지문을 꺼내지 못했습니다.");
      if (!res.passages.length && res.canAi) {
        // 규칙으로는 못 나눴다. AI에게 경계만 물어본다 — 값이 매겨져 있으면 먼저 확인한다.
        if (!costConfirmed(PRICING ? PRICING.pdfSplit : 0,
                           `${who}\n\n문단을 자동으로 나누지 못했습니다. AI로 다시 찾아볼까요?`)) {
          fails.push(`${who} — 문단을 나누지 못했습니다.`);
          continue;
        }
        status(`<span class="spinner"></span> ${esc(who)} AI가 지문 경계를 찾는 중…`);
        res = await postJson("/api/pdfsplit", Object.assign({ ai: true }, payload),
                             "PDF에서 지문을 꺼내지 못했습니다.");
        notes.push(`${who}: 규칙으로 나누지 못해 AI가 경계를 찾았습니다. 지문이 어디서 끊겼는지 특히 잘 확인하세요.`);
      }
      if (!res.passages.length) {
        fails.push(`${who} — 영어 지문을 찾지 못했습니다.`);
        continue;
      }
      /* 번호로 빼는 규칙은 이 PDF가 28번을 넘어설 때만 쓴다. 25~28이 도표·안내문
         자리인 것은 수능형 편집의 관례라, 거기까지 닿지 않는 PDF(교과서 단원, 부분
         발췌)에서 25~28번은 그냥 평범한 지문이다. */
      const nosOf = res.passages.map((p) => pdfQuestionNos(p.name));
      const useNoRule = Math.max(0, ...nosOf.flat()) >= 29;

      for (let k = 0; k < res.passages.length; k++) {
        const p = res.passages[k];
        // p.name은 지문 이름칸에 쓰지 않는다 — fillText 주석 참고. 여기서 번호만 읽고 버린다.
        const nos = nosOf[k];
        const hitNo = useNoRule ? nos.find((n) => PDF_SKIP_NOS.has(n)) : undefined;
        const shape = passageShape(p.text);
        if (hitNo !== undefined || shape) {
          held.push({
            text: p.text,
            no: nos.length
              ? nos.length > 1 ? `${nos[0]}~${nos[nos.length - 1]}번` : `${nos[0]}번`
              : "",
            kind: shape || PDF_SKIP_LABEL[hitNo] || "",
          });
          continue;   // 빼 두고 아래 확인 창에서 물어본다
        }
        if (mgr.fillText(p.text)) added++;
        else {
          full = true;
          break;
        }
      }
      if (res.note) notes.push(`${who}: ${res.note}`);
      if (full) {
        fails.push(`${who} — 지문 칸이 가득 차 나머지는 넣지 못했습니다.`);
        break;
      }
    } catch (err) {
      const msg = err.message || String(err);
      fails.push(`${who} — ${msg}`);
      if (err.code === "no_text") {
        // 스캔본이다 — 사진 OCR로 가야 한다. 위 안내에 이미 그 길이 적혀 있다.
        continue;
      }
      // 한도 소진은 기다려도 안 풀린다 — 남은 파일을 시도하지 않는다
      if (isQuotaError(err)) {
        const left = files.length - (i + 1);
        if (left > 0) fails.push(`한도 초과로 중단했습니다. 남은 ${left}개는 시도하지 않았습니다.`);
        break;
      }
    }
  }

  const parts = [];
  if (added) {
    parts.push(
      `<b>지문 ${added}개</b>를 입력칸에 나눠 담았습니다. ` +
        `PDF와 대조해 <b>문단이 제대로 끊겼는지 확인한 뒤</b> 실행하세요.`
    );
  }
  if (held.length) {
    const label = held.map((h) => h.no || h.kind).filter(Boolean).join(", ");
    parts.push(
      `📊 <b>지문 ${held.length}개는 넣지 않았습니다</b>${label ? ` — ${esc(label)}` : ""}.`
    );
  }
  notes.forEach((n) => parts.push(`⚠️ ${esc(n)}`));
  fails.forEach((f) => parts.push(`❌ ${esc(f)}`));
  if (!parts.length) parts.push("옮길 지문을 찾지 못했습니다.");
  status(parts.join("<br>"), added ? (fails.length ? "warn" : "ok") : "warn");

  pdfBusy = false;
  [pdfBtn, examPdfBtn].forEach((b) => b && (b.disabled = false));
  pdfFileEl.value = "";       // 같은 파일을 다시 골라도 change가 나도록 비운다
  examPdfFileEl.value = "";
  refreshTokenDisplay();

  /* 넣을 것을 다 넣은 뒤에 묻는다 — 넣는 중에 물으면 흐름이 끊기고, 무엇이 들어갔는지
     본 다음에 판단하는 편이 낫다. 칸이 이미 가득 찼으면 물어도 넣을 데가 없으므로
     위 안내에 사실만 남기고 창은 띄우지 않는다. */
  if (held.length && !full) openPdfHeldGuide(mgr, status, held);
}

pdfBtn.addEventListener("click", () => pdfFileEl.click());
pdfFileEl.addEventListener("change", () => {
  if (pdfFileEl.files && pdfFileEl.files.length) {
    runPdfImport(pdfFileEl.files, passageMgr, ocrStatus);
  }
});
// 시험지 제작 탭의 '시험 범위 지문'도 같은 길로 채운다 — 시험 범위 전체를 넣는 칸이라
// PDF 한 부를 통째로 담는 쓰임이 가장 잦은 곳이다.
examPdfBtn.addEventListener("click", () => examPdfFileEl.click());
examPdfFileEl.addEventListener("change", () => {
  if (examPdfFileEl.files && examPdfFileEl.files.length) {
    runPdfImport(examPdfFileEl.files, examPaperMgr, examPassageStatus);
  }
});

/* 지문 칸에 파일을 끌어다 놓기.
   공용 지문 패널과 시험지 제작 탭의 '시험 범위 지문'이 같은 배선을 나눠 쓴다 —
   버튼(📄 PDF에서 가져오기)은 두 곳 다 있는데 끌어다 놓기는 공용 칸에만 있어서,
   같은 칸인 줄 알고 놓았다가 아무 일도 안 일어나는 일이 있었다.
   ocr 옵션: 사진(OCR)은 공용 칸에만 있다. runOcr이 공용 지문칸을 직접 채우도록
   되어 있어, 시험 범위 칸에 사진을 놓으면 엉뚱한 칸이 채워지기 때문이다.
   그래서 거기서는 조용히 무시하지 않고 어디에 놓아야 하는지 알려 준다. */
function wirePassageDrop(panelEl, mgr, statusFn, opts) {
  if (!panelEl) return;
  const withOcr = !!(opts && opts.ocr);
  ["dragenter", "dragover"].forEach((ev) =>
    panelEl.addEventListener(ev, (e) => {
      if (![...((e.dataTransfer && e.dataTransfer.types) || [])].includes("Files")) return;
      e.preventDefault();
      panelEl.classList.add("dropping");
    })
  );
  ["dragleave", "drop"].forEach((ev) =>
    panelEl.addEventListener(ev, (e) => {
      if (ev === "dragleave" && panelEl.contains(e.relatedTarget)) return;
      panelEl.classList.remove("dropping");
    })
  );
  panelEl.addEventListener("drop", (e) => {
    const files = e.dataTransfer && e.dataTransfer.files;
    if (!files || !files.length) return;
    e.preventDefault();
    // 사진과 PDF는 가는 길이 다르다 — 섞어서 놓아도 각각 제 길로 보낸다
    const pdfs = [...files].filter(isPdf);
    const shots = [...files].filter((f) => !isPdf(f));
    if (pdfs.length) runPdfImport(pdfs, mgr, statusFn);
    if (!shots.length) return;
    if (withOcr) runOcr(shots);
    else
      statusFn(
        "여기에는 <b>PDF</b>만 놓을 수 있습니다. 사진에서 지문을 가져오려면 " +
          "위쪽 <b>영어 지문</b> 칸에 놓아 주세요.",
        "warn"
      );
  });
}

const passagePanelEl = document.querySelector(".passage-panel");
wirePassageDrop(passagePanelEl, passageMgr, ocrStatus, { ocr: true });

// ── 탭 전환 ──
const tabBtns = [...document.querySelectorAll(".tab-btn")];
const tabPages = [...document.querySelectorAll(".tab-page")];
function syncFloatPrint() {
  const active = document.querySelector(".tab-page.active");
  const btn =
    active &&
    active.querySelector(
      "#printBtn, #mcqPrintBtn, #saqPrintBtn, #workbookPrintBtn, #vocabPrintBtn, #examPaperPrintBtn"
    );
  // 묶음은 페이지 이동 버튼도 담고 있으므로 통째로 감추지 않고 인쇄 버튼만 여닫는다
  floatPrintBtn.hidden = !(btn && btn.style.display !== "none");
  // 되돌리기도 이 묶음 안에 있다 — 지문 분석 탭에서 고치는 중일 때만 보인다
  syncUndoBtn();
}
// 떠 있는 버튼은 '지금 활성 탭'의 진짜 인쇄 버튼을 대신 눌러 준다.
// 그러면 각 탭이 자기 파일명 규칙을 그대로 갖고 있으므로 여기서 따로 만들 필요가 없다.
function activeSectionBtn(selector) {
  const active = document.querySelector(".tab-page.active");
  return active && active.querySelector(selector);
}
floatPrintBtn.addEventListener("click", () => {
  const b = activeSectionBtn(
    "#printBtn, #mcqPrintBtn, #saqPrintBtn, #workbookPrintBtn, #vocabPrintBtn, #examPaperPrintBtn"
  );
  if (b) b.click();
});

/* ── 페이지 단위 이동(▲▼) ──
   움직이는 양을 크롬이 PgUp/PgDn에 쓰는 값과 같게 맞췄다 — '화면 높이의 87.5%'와
   '화면 높이 − 40px' 중 큰 쪽. 40px은 앞 화면의 끝줄을 남겨 두는 겹침이다.
   여기서 양을 임의로 정하면 키보드로 넘길 때와 달라져, 두 방법을 번갈아 쓰는 순간
   어디까지 읽었는지 놓친다. */
const floatPager = $("floatPager");
const topBtn = $("topBtn");
const pageUpBtn = $("pageUpBtn");
const pageDownBtn = $("pageDownBtn");
const bottomBtn = $("bottomBtn");
const PAGE_OVERLAP_PX = 40;
const PAGE_MIN_FRACTION = 0.875;

function pageStep() {
  const h = window.innerHeight;
  return Math.max(h * PAGE_MIN_FRACTION, h - PAGE_OVERLAP_PX);
}
function scrollPage(dir) {
  window.scrollBy({ top: dir * pageStep(), behavior: "smooth" });
}
// 스크롤할 것이 있을 때만 띄우고, 끝에 닿은 쪽은 잠근다
function syncPager() {
  const max = document.documentElement.scrollHeight - window.innerHeight;
  floatPager.hidden = max < 80; // 한 화면도 넘치지 않으면 있을 이유가 없다
  if (floatPager.hidden) return;
  const y = window.scrollY;
  const atTop = y <= 2;
  const atBottom = y >= max - 2;
  topBtn.disabled = atTop;
  pageUpBtn.disabled = atTop;
  pageDownBtn.disabled = atBottom;
  bottomBtn.disabled = atBottom;
}
topBtn.addEventListener("click", () => window.scrollTo({ top: 0, behavior: "smooth" }));
bottomBtn.addEventListener("click", () =>
  window.scrollTo({ top: document.documentElement.scrollHeight, behavior: "smooth" })
);
pageUpBtn.addEventListener("click", () => scrollPage(-1));
pageDownBtn.addEventListener("click", () => scrollPage(1));
addEventListener("scroll", syncPager, { passive: true });
addEventListener("resize", syncPager);
// 결과물이 그려지거나 지문칸이 늘면 문서 높이가 바뀐다 — 그때도 다시 판단한다.
// (버튼은 position:fixed라 감췄다 띄웠다 해도 본문 높이에 영향을 주지 않는다)
new ResizeObserver(syncPager).observe(document.body);
syncPager();
/* ── 기출 탭에서는 탭 바깥의 공용 칸 두 개를 치운다 ──
   공용 지문칸과 학원 마크 칸은 탭 바깥(탭 버튼보다 위)에 있어서 어느 탭에서나 화면
   맨 위에 뜬다. 그런데 시험지 제작은 이 둘을 그 자리에서 쓰지 않는다 —
     · 지문은 자기 입력칸(examPaperMgr)을 쓴다. 상한이 달라서다(공용 10개 / 시험지 40개).
       두 칸이 동시에 보이면 어디에 넣어야 하는지 알 수 없고, 잘못 넣으면 아무 일도
       일어나지 않는다.
     · 학원 마크는 '만들기 직전' 단계로 옮겨 보여 준다(#examBrandSlot).
   그래서 기출 탭에 들어오면 둘 다 감추고, 분석이 끝나면 시험지 칸 안에서 다시 꺼낸다.
   탭을 벗어나면 원래 자리(#brandHome 앞)로 돌려놓는다 — 다른 탭은 이 칸을 계속 쓴다. */
const sharedPassagePanel = document.querySelector(".passage-panel");
const brandPanelEl = document.querySelector(".brand-panel");
const brandHomeEl = $("brandHome");

function moveBrandPanel(intoExam) {
  if (!brandPanelEl || !brandHomeEl) return;
  const slot = $("examBrandSlot");
  if (intoExam && slot) slot.appendChild(brandPanelEl);
  else brandHomeEl.parentNode.insertBefore(brandPanelEl, brandHomeEl);
}

function syncTabChrome(tab) {
  const onExam = tab === "exam";
  if (sharedPassagePanel) sharedPassagePanel.hidden = onExam;
  // 기출 탭에서는 분석이 끝나 시험지 칸이 열렸을 때만 마크 칸을 보여 준다
  moveBrandPanel(onExam && !examPaperPanelEl.hidden);
  if (brandPanelEl) brandPanelEl.hidden = onExam && examPaperPanelEl.hidden;
}

tabBtns.forEach((btn) => {
  btn.addEventListener("click", () => {
    tabBtns.forEach((b) => b.classList.toggle("active", b === btn));
    tabPages.forEach((p) => p.classList.toggle("active", p.id === `tab-${btn.dataset.tab}`));
    syncTabChrome(btn.dataset.tab);
    syncFloatPrint();
  });
});

// '꼼꼼 검토' 체크 상태 기억
const REVIEW_STORE = "gemini_review";
if (reviewChk) {
  reviewChk.checked = localStorage.getItem(REVIEW_STORE) === "1";
  reviewChk.addEventListener("change", () =>
    localStorage.setItem(REVIEW_STORE, reviewChk.checked ? "1" : "0")
  );
}

/* ── 분석본 직접 수정 ──
   결과는 이미 화면에 HTML로 그려져 있으므로, 그 영역을 편집 가능 상태로 바꾸기만 하면
   해석·해설·어휘표를 그 자리에서 고칠 수 있다. 되돌리기(Ctrl+Z)는 브라우저가 처리하고,
   인쇄도 고친 내용 그대로 나간다. 편집 표시(점선 테두리)는 인쇄에서 제외된다. */
const editBtn = $("editBtn");
const editHintEl = $("editHint");
const saveBtn = $("saveBtn");
let lastAnalyzeEntries = []; // 저장/불러오기용 — {job, data} 성공한 것만, 순서 유지

// 고칠 수 있는 구역만 연다 — 루비(영어 위 한글), 한글 해석, 우측 해설.
// 영어 원문·제목·범례·번호·태그는 잠가 둔다(잘못 건드리면 분석본이 망가진다).
const EDITABLE_SEL = "rt, .c-kor, .note";
// 자동으로 붙는 라벨은 해설 안에 있더라도 잠근다
const LOCKED_SEL = ".note-title, .exam-why-title";

function setEditMode(on) {
  // 두 모드는 같은 화면을 만지므로 함께 켜지 않는다 (쪽 구성의 손잡이가 편집을 방해한다)
  if (on && resultEl.classList.contains("paging")) setPagingMode(false);
  resultEl.spellcheck = false;               // 영어·한국어가 섞여 빨간 밑줄이 지저분해진다
  resultEl.classList.toggle("editing", on);
  resultEl.querySelectorAll(EDITABLE_SEL).forEach((el) => {
    el.contentEditable = on ? "true" : "false";
  });
  resultEl.querySelectorAll(LOCKED_SEL).forEach((el) => {
    el.contentEditable = "false";
  });
  editBtn.textContent = on ? "✅ 수정 끝내기" : "✏️ 직접 수정";
  editHintEl.textContent = on
    ? "색칠된 곳(한글 해석 · 루비 · 해설)만 고칠 수 있습니다. 한 글자씩 무르려면 Ctrl+Z, 고친 묶음째 되돌리려면 ↩ 되돌리기."
    : "";
  if (on) {
    const first = resultEl.querySelector('[contenteditable="true"]');
    if (first) first.focus();
  }
  syncUndoBtn(); // 고치는 중일 때만 뜨는 버튼이라 모드가 바뀌면 함께 바뀐다
}

editBtn.addEventListener("click", () => {
  flushUndo(); // 고치다 만 묶음을 한 단계로 끊어 두고 모드를 바꾼다
  // 상태는 .editing 클래스로 판단한다. #result 자체는 더 이상 편집 대상이 아니라
  // contentEditable 값이 늘 "inherit"이어서 판단 근거가 될 수 없다.
  setEditMode(!resultEl.classList.contains("editing"));
});

/* ── 쪽 구성 (인쇄 지면 나눔) ──
   분석본은 '쪼개지지 않는 덩어리'(.pg-blk — 표지 / 문장 카드 하나 / 표 하나)가 줄줄이
   이어진 모양이다. 그래서 덩어리가 앞 쪽에 다 못 들어가면 통째로 다음 쪽으로 밀리고,
   앞 쪽 아래가 텅 빈다. 여기서는 두 가지를 한다.

   1) 인쇄했을 때 쪽이 어디서 넘어가는지 화면에 그려 준다. 결과 폭을 인쇄 폭(186mm)에
      맞춘 뒤 덩어리 높이를 재서 A4 한 쪽(261mm)에 몇 개가 들어가는지 세고, 남는 자리를
      실제 빈 칸으로 벌려 보여 준다. 브라우저·프린터에 따라 한두 줄 차이는 난다.
   2) 덩어리마다 '여기서 새 쪽 / 쪽 나눔 해제'를 눌러 쪽 경계를 옮기게 한다. 순서는
      바꾸지 않는다 — 문장 순서가 섞이면 분석본이 아니게 되기 때문이다.

   실제 인쇄에 반영되는 것은 덩어리의 data-brk 하나뿐이고(style.css의 인쇄 규칙),
   손잡이·경계선·빈 칸은 전부 화면 표시라 인쇄에서 빠진다. */
const pageBtn = $("pageBtn");
const pageResetBtn = $("pageResetBtn");
const pageHintEl = $("pageHint");

const PX_PER_MM = 96 / 25.4;              // CSS가 정한 환산값 (1in = 96px)
const PAGE_W_MM = 210 - 12 * 2;           // A4 폭 - @page 좌우 여백
// A4 높이 - 위 14mm - 아래 10mm - 매 쪽 하단에 반복되는 tfoot(.print-foot) 12mm.
// 셋 다 style.css의 @page / .print-foot 값이다. 그쪽을 고치면 여기도 함께 고쳐야 한다.
const PAGE_H_MM = 297 - 14 - 10 - 12;
// 쪽 구성 중에만 덩어리 위에 비워 두는 손잡이 자리 (style.css의 #result.paging .pg-blk
// padding-top과 같은 값이어야 한다). 화면에만 있는 자리이므로 쪽 계산에서는 빼고 센다.
const HANDLE_PAD_PX = 34;

function pagingOn() {
  return resultEl.classList.contains("paging");
}

function pgBlocks() {
  return [...resultEl.querySelectorAll(".pg-blk")];
}

// 지문의 첫 덩어리인가 — 지문마다 이미 새 쪽에서 시작하므로 쪽 나눔을 걸 자리가 없다
function isPassageHead(blk) {
  return blk.classList.contains("pg-head");
}

// 이 덩어리에서 반드시 쪽이 넘어가는가 (직접 지정했거나, 둘째 지문부터의 첫 덩어리거나)
function forcedBreak(blk) {
  if (blk.dataset.brk === "page") return true;
  return isPassageHead(blk) && !!blk.parentElement.previousElementSibling;
}

function ensureHandles() {
  pgBlocks().forEach((blk) => {
    if (blk.querySelector(":scope > .pg-handle")) return;
    const bar = document.createElement("div");
    bar.className = "pg-handle";
    bar.contentEditable = "false";
    bar.innerHTML = isPassageHead(blk)
      ? `<span class="pg-tag">지문 시작 · 항상 새 쪽</span>`
      : `<button type="button" class="pg-brk-btn"></button><span class="pg-note"></span>`;
    blk.prepend(bar);
  });
}

function removeHandles() {
  resultEl.querySelectorAll(".pg-handle").forEach((n) => n.remove());
}

// 경계선·빈 칸은 잴 때마다 지우고 다시 그린다 (남겨 두면 다음 측정이 그만큼 밀린다)
function clearPageMarks() {
  resultEl.querySelectorAll(".pg-gap, .pg-edge").forEach((n) => n.remove());
}

function layoutPages() {
  if (!pagingOn()) return;
  clearPageMarks();
  const blks = pgBlocks();
  if (!blks.length) {
    pageHintEl.textContent = "";
    return;
  }

  // 측정 — 덩어리의 높이와, 덩어리 사이 여백(바깥 여백은 접히므로 좌표 차로 구한다).
  // boxH는 화면 상자(손잡이 자리 포함), hs는 종이에서 실제로 차지할 높이다.
  const base = resultEl.getBoundingClientRect().top;
  const rects = blks.map((b) => b.getBoundingClientRect());
  const tops = rects.map((r) => r.top - base);
  const boxH = rects.map((r) => r.height);
  const hs = boxH.map((h) => Math.max(0, h - HANDLE_PAD_PX));
  const pageH = PAGE_H_MM * PX_PER_MM;

  // 쪽 나누기 — 브라우저가 인쇄할 때 하는 일을 그대로 흉내낸다
  const pages = [];
  let cur = { first: 0, last: 0, body: 0, used: 0, forced: true };
  for (let i = 0; i < blks.length; i++) {
    const forced = forcedBreak(blks[i]);
    if (i > 0 && (forced || cur.used + hs[i] > pageH)) {
      pages.push(cur);
      cur = { first: i, last: i, body: 0, used: 0, forced, head: isPassageHead(blks[i]) };
    }
    const gap = i + 1 < blks.length ? Math.max(0, tops[i + 1] - (tops[i] + boxH[i])) : 0;
    cur.used += hs[i];
    cur.body = cur.used;   // 마지막 덩어리 아래 여백은 뺀 높이 — 남는 자리 계산용
    cur.used += gap;
    cur.last = i;
  }
  pages.push(cur);

  // 그리기 — 쪽이 바뀌는 자리에 '앞 쪽의 남은 빈 자리'를 벌리고 경계선을 넣는다
  pages.forEach((pg, p) => {
    const blk = blks[pg.first];
    const parent = blk.parentElement;
    let left = 0;
    if (p > 0) {
      left = Math.max(0, pageH - pages[p - 1].body);
      // 몇 px밖에 안 남았으면 빈 칸을 그리지 않는다 — 테두리만 남아 줄처럼 보인다.
      // 다음 덩어리의 손잡이 자리도 빈 자리처럼 보이므로 그만큼 뺀다.
      if (left - HANDLE_PAD_PX >= 6) {
        const gapEl = document.createElement("div");
        gapEl.className = "pg-gap";
        gapEl.style.height = `${Math.round(left - HANDLE_PAD_PX)}px`;
        gapEl.setAttribute("aria-hidden", "true");
        parent.insertBefore(gapEl, blk);
      }
    }
    const edge = document.createElement("div");
    edge.className = "pg-edge";
    const why = [];
    if (p > 0) {
      why.push(pg.head ? "새 지문 시작" : pg.forced ? "새 쪽 시작으로 지정한 자리" : "자리가 부족해 넘어감");
      const mm = Math.round(left / PX_PER_MM);
      if (mm >= 5) why.push(`앞 쪽 아래 약 ${mm}mm 빔`);
    }
    edge.innerHTML =
      `<span class="pg-edge-no">${p + 1}쪽</span>` +
      (why.length ? `<span class="pg-edge-why">${esc(why.join(" · "))}</span>` : "");
    parent.insertBefore(edge, blk);
  });

  // 손잡이 상태 맞추기 — 어느 덩어리가 쪽 첫머리인지 알려 준다
  const startAt = new Map();
  pages.forEach((pg, p) => startAt.set(pg.first, p + 1));
  blks.forEach((blk, i) => {
    const btn = blk.querySelector(":scope > .pg-handle > .pg-brk-btn");
    if (!btn) return;
    const on = blk.dataset.brk === "page";
    btn.textContent = on ? "⤴ 위로 올리기" : "✂ 새 쪽 시작";
    btn.title = on
      ? "앞 쪽에 이어 붙입니다 (앞 쪽 빈자리로 올라갑니다)."
      : "여기부터 새 쪽에서 시작하게 합니다.";
    const note = blk.querySelector(":scope > .pg-handle > .pg-note");
    if (note) note.textContent = !on && startAt.has(i) ? `${startAt.get(i)}쪽 첫머리` : "";
  });

  const narrow = Math.abs(resultEl.clientWidth - PAGE_W_MM * PX_PER_MM) > 8;
  pageHintEl.textContent =
    `모두 ${pages.length}쪽 — 표·문장 카드 위의 [✂ 새 쪽 시작] · [⤴ 위로 올리기]로 옮기세요.` +
    (narrow ? " (창이 좁아 실제 인쇄와 다를 수 있습니다)" : "");
}

function setPagingMode(on) {
  if (on && resultEl.classList.contains("editing")) setEditMode(false);
  resultEl.classList.toggle("paging", on);
  pageBtn.textContent = on ? "✅ 쪽 구성 끝내기" : "📄 쪽 구성";
  pageResetBtn.style.display = on ? "inline-flex" : "none";
  if (on) {
    ensureHandles();
    layoutPages();
  } else {
    clearPageMarks();
    removeHandles();
    pageHintEl.textContent = "";
  }
  syncUndoBtn();
}

pageBtn.addEventListener("click", () => setPagingMode(!pagingOn()));

pageResetBtn.addEventListener("click", () => {
  flushUndo();
  pgBlocks().forEach((b) => {
    if (b.dataset.brkDef) b.dataset.brk = b.dataset.brkDef;
    else delete b.dataset.brk;
  });
  layoutPages();
  pushUndo(); // 되돌리기 한 단계 — '처음으로'도 무를 수 있어야 한다
});

resultEl.addEventListener("click", (e) => {
  const btn = e.target.closest(".pg-brk-btn");
  if (!btn || !pagingOn()) return;
  const blk = btn.closest(".pg-blk");
  if (!blk || isPassageHead(blk)) return;
  flushUndo();
  blk.dataset.brk = blk.dataset.brk === "page" ? "auto" : "page";
  layoutPages();
  pushUndo();
});

// 창 폭이 바뀌면 줄바꿈이 달라져 쪽 경계도 달라진다 — 잠잠해진 뒤 한 번만 다시 잰다
let pageResizeTimer = 0;
window.addEventListener("resize", () => {
  if (!pagingOn()) return;
  clearTimeout(pageResizeTimer);
  pageResizeTimer = setTimeout(layoutPages, 200);
});

/* ── 되돌리기 ──
   고칠 수 있는 곳이 둘(글자 직접 수정 · 쪽 구성)인데 되돌리는 방법이 서로 달랐다 —
   글자는 브라우저의 Ctrl+Z, 쪽 구성은 '처음으로'뿐이라 한 단계만 무르는 길이 없었다.
   여기서는 둘을 한 단추로 묶는다. 방법은 화면(결과 HTML)을 통째로 찍어 쌓아 두는 것이다.
   분석본은 화면이 곧 결과물이고(인쇄도 저장도 이 화면을 되읽는다) 크기도 한 지문에
   수백 KB라, 단계별로 무엇이 바뀌었는지 따지는 것보다 이 편이 단순하고 안전하다.

   한 단계 = 손이 멈춘 묶음. 타이핑은 0.7초 쉬면 한 단계로 끊고, 쪽 나눔은 누를 때마다
   한 단계다. 화면용 표시(손잡이·경계선·빈 칸·편집 표시)는 찍을 때 지운다 — 남겨 두면
   되돌린 화면에 그것들이 겹쳐 쌓인다. */
const undoBtn = $("undoBtn");
const UNDO_MAX = 30;        // 지문이 여러 개면 한 장이 수백 KB다 — 무한정 쌓지 않는다
const UNDO_MAX_CHARS = 20e6; // 쌓아 둔 화면의 총 글자 수 상한 (약 40MB 메모리)
let undoStack = [];
let undoBase = null;        // 마지막으로 '멈춘' 상태

function resultSnapshot() {
  const copy = resultEl.cloneNode(true);
  copy.querySelectorAll(".pg-handle, .pg-gap, .pg-edge").forEach((n) => n.remove());
  copy.querySelectorAll("[contenteditable]").forEach((n) => n.removeAttribute("contenteditable"));
  return copy.innerHTML;
}

// 되돌리기 버튼은 떠 있는 인쇄 버튼 위에 붙어 있고, 고치는 중일 때만 보인다.
// (고칠 곳은 화면 아래쪽인데 버튼 줄은 맨 위라, 되돌리려고 매번 올라가야 했다)
function syncUndoBtn() {
  if (!undoBtn) return;
  const active = document.querySelector(".tab-page.active");
  const onAnalyze = !!active && active.id === "tab-analyze";
  const fixing = resultEl.classList.contains("editing") || pagingOn();
  undoBtn.hidden = !(onAnalyze && fixing);
  undoBtn.disabled = !undoStack.length;
  undoBtn.title = undoStack.length
    ? `방금 고친 것을 한 단계 되돌립니다 (되돌릴 수 있는 단계 ${undoStack.length})`
    : "되돌릴 것이 없습니다.";
}

// 새로 그린 화면을 되돌리기의 출발점으로 삼는다 (이전 기록은 버린다)
function resetUndo() {
  undoStack = [];
  undoBase = resultEl.innerHTML ? resultSnapshot() : null;
  syncUndoBtn();
}

// 지금 화면을 한 단계로 확정한다. 바뀐 게 없으면 아무 일도 하지 않는다.
function pushUndo() {
  const now = resultSnapshot();
  if (undoBase == null) {
    undoBase = now;
    return;
  }
  if (now === undoBase) return;
  undoStack.push(undoBase);
  // 지문을 여러 개 담으면 한 장이 메가바이트급이 된다 — 단계 수와 총량 둘 다로 자른다
  while (
    undoStack.length > 1 &&
    (undoStack.length > UNDO_MAX || undoStack.reduce((n, s) => n + s.length, 0) > UNDO_MAX_CHARS)
  ) {
    undoStack.shift();
  }
  undoBase = now;
  syncUndoBtn();
}

let undoTypeTimer = 0;
resultEl.addEventListener("input", () => {
  clearTimeout(undoTypeTimer);
  undoTypeTimer = setTimeout(pushUndo, 700);
});

// 타이핑 중이었다면 그 묶음까지 먼저 한 단계로 끊는다
function flushUndo() {
  clearTimeout(undoTypeTimer);
  pushUndo();
}

function undoOnce() {
  flushUndo();
  if (!undoStack.length) return;
  const prev = undoStack.pop();
  const editing = resultEl.classList.contains("editing");
  const paging = pagingOn();
  resultEl.innerHTML = prev;
  undoBase = prev;
  // 화면을 통째로 갈아 끼웠으므로 켜져 있던 모드의 표시를 다시 입힌다
  if (editing) setEditMode(true);
  else if (paging) {
    ensureHandles();
    layoutPages();
  }
  syncUndoBtn();
}

undoBtn.addEventListener("click", undoOnce);

// Ctrl+Z — 글자를 고치는 중에는 브라우저의 되돌리기(한 글자씩)가 더 자연스러우므로
// 가로채지 않는다. 쪽 구성 중일 때만 이 되돌리기가 받는다.
document.addEventListener("keydown", (e) => {
  if (!(e.ctrlKey || e.metaKey) || e.shiftKey) return;
  if (String(e.key).toLowerCase() !== "z") return;
  if (resultEl.classList.contains("editing") || !pagingOn()) return;
  e.preventDefault();
  undoOnce();
});

/* 직접 지정한 쪽 나눔을 저장/복원한다. 분석본은 저장해 둔 원본 data로 다시 그리므로
   덩어리 순서가 늘 같다 — 지문마다 덩어리 순서대로 값을 적어 두면 그대로 되살아난다.

   지문마다 값을 '배열'로 담아 그 배열들을 다시 배열에 넣으면(배열 속의 배열)
   Firestore가 거부한다 ("Property payload contains an invalid nested entity") —
   실제로 저장이 이 자리에서 막혔다. 그래서 지문 하나의 값은 "|"로 이어붙인
   문자열 하나로 담는다 — 최상위 배열의 원소가 문자열/null뿐이라 중첩이 없다. */
function collectPageBreaks() {
  return lastAnalyzeEntries.map((_, idx) => {
    const block = resultEl.querySelector(`.passage-block[data-entry="${idx}"]`);
    if (!block) return null;
    return [...block.querySelectorAll(".pg-blk")].map((b) => b.dataset.brk || "").join("|");
  });
}

function applyPageBreaks(list) {
  (list || []).forEach((packed, idx) => {
    if (typeof packed !== "string" || !packed) return;
    const block = resultEl.querySelector(`.passage-block[data-entry="${idx}"]`);
    if (!block) return;
    const blks = [...block.querySelectorAll(".pg-blk")];
    packed.split("|").forEach((m, i) => {
      if (!blks[i]) return;
      if (m === "page" || m === "auto") blks[i].dataset.brk = m;
    });
  });
}

analyzeBtn.addEventListener("click", analyze);
printBtn.addEventListener("click", () => printDoc(() => passageBasedName("지문분석")));
syncFloatPrint(); // 초기 탭(지문 분석) 기준으로 상태 맞춤

async function analyze() {
  errorEl.textContent = "";

  const jobs = passageMgr.getJobs();
  if (!jobs.length) {
    errorEl.textContent = "분석할 영어 지문을 입력하세요.";
    return;
  }
  // 요약 이미지를 함께 만들면 지문당 값이 얹힌다 — 확인 창에 합친 금액이 나가야 한다
  const withInfo = !!(infoChk && infoChk.checked);
  const perPassage =
    (PRICING ? PRICING.analyze : 0) + (withInfo && PRICING ? PRICING.infographic : 0);
  if (!costConfirmed(
        billableJobCount() * perPassage,
        withInfo
          ? "지문 분석과 요약 이미지를 함께 만듭니다. (이미지는 지문당 8~12초가 더 걸립니다)"
          : "지문 분석을 시작합니다.",
        jobs.length)) {
    return;
  }

  analyzeBtn.disabled = true;
  addPassageBtn.disabled = true;
  clearPassagesBtn.disabled = true;
  loadingEl.classList.add("on");
  setEditMode(false); // 새로 분석하면 이전 수정 상태를 끈다 (내용도 새로 덮어써진다)
  setPagingMode(false);
  revokeInfographics(); // 이전 분석본에 붙어 있던 그림을 메모리에서 놓아준다
  resultEl.innerHTML = "";
  printBtn.style.display = "none";
  editBtn.style.display = "none";
  pageBtn.style.display = "none";
  saveBtn.style.display = "none";
  resetUndo();
  syncFloatPrint();

  const total = jobs.length;
  const reviewOn = !!(reviewChk && reviewChk.checked);
  let okCount = 0;
  const htmlParts = []; // 결과를 모아뒀다가 모두 끝난 뒤 한 번에 렌더
  const vocabSets = []; // 단어장 탭이 쓸 지문별 핵심 어휘
  const entries = []; // 저장 기능이 쓸 {job, data} — 성공한 것만
  for (let i = 0; i < total; i++) {
    const job = jobs[i];
    const stage = reviewOn ? "분석·검토 중" : "분석 중";
    loadingTextEl.textContent =
      total > 1
        ? `${job.name} ${stage}… (${i + 1}/${total})`
        : `AI가 지문을 ${stage}입니다… ${reviewOn ? "(꼼꼼 검토: 두 번 분석해 더 걸립니다)" : "(지문 길이에 따라 20~60초)"}`;

    if (job.text.length < 20) {
      htmlParts.push(buildErrorHtml(job, total, "지문이 너무 짧습니다 (20자 이상 입력)."));
      continue;
    }

    try {
      const data = await postJson(
        "/api/analyze",
        {
          passage: job.text,
          targetGrammar: grammarEl.value,
          review: reviewOn,
        },
        "분석에 실패했습니다."
      );
      htmlParts.push(buildAnalysisHtml(data, job, total, entries.length));
      entries.push({ job, data });
      if (Array.isArray(data.vocab) && data.vocab.length) {
        vocabSets.push({ name: job.name, vocab: data.vocab });
      }
      okCount++;
    } catch (err) {
      const msg = err.message || String(err);
      htmlParts.push(buildErrorHtml(job, total, msg));
      // 한도 소진은 기다려도 안 풀린다 — 남은 지문을 시도하지 않고 즉시 멈춘다
      if (isQuotaError(err)) {
        const left = total - (i + 1);
        if (left > 0) htmlParts.push(quotaStopHtml(left, err));
        break;
      }
    }
  }

  if (okCount) htmlParts.push(`<footer>구문 단위 직독직해 분석본 · 자동 생성</footer>`);
  if (vocabSets.length) saveVocabSets(vocabSets); // 단어장 탭에서 재사용
  lastAnalyzeEntries = entries; // 저장 버튼이 이 값을 그대로 payload로 보낸다
  // 모든 지문 분석이 끝난 뒤 한 번에 렌더 (중간에 화면이 바뀌지 않도록)
  resultEl.innerHTML = htmlParts.join("");
  if (okCount) {
    printBtn.style.display = "inline-flex";
    editBtn.style.display = "inline-flex";
    pageBtn.style.display = "inline-flex";
    saveBtn.style.display = "inline-flex";
  }
  resetUndo(); // 새 분석본이 되돌리기의 출발점 — 이전 분석본으로는 돌아가지 않는다
  syncFloatPrint();
  loadingEl.classList.remove("on");
  analyzeBtn.disabled = false;
  addPassageBtn.disabled = false;
  clearPassagesBtn.disabled = false;
  resultEl.scrollIntoView({ behavior: "smooth", block: "start" });
  refreshTokenDisplay(); // 성공한 만큼 차감됐을 잔액 표시를 갱신

  // '요약 이미지'를 켜 두었으면 분석이 끝난 뒤 이어서 만든다.
  // 분석과 한 요청에 묶지 않는 이유는 시간이다 — 그림 한 장이 8~12초라 지문 수만큼
  // 곱해지면 요청 하나가 몇 분씩 열려 있게 되고 배포 프록시가 먼저 끊는다.
  // 사용자에게는 버튼 한 번으로 보이지만, 실제로는 지문마다 따로 부른다.
  // 금액은 위 확인 창에서 이미 합쳐 물었으므로 여기서 다시 묻지 않는다.
  if (withInfo && entries.length) {
    await makeInfographics(entries.map((_e, i) => i));
  }
  // 지문 분석은 '직접 수정'이 있는 유일한 탭이라 고치는 방법까지 안내한다
  if (okCount) showDoneGuide(`지문 ${okCount}개의 분석본`, true);
}

/* ══════════════════════════ 지문 요약 인포그래픽 ══════════════════════════ */
// 지문 내용을 한 장으로 요약한 가로형 그림을 분석본 맨 뒤(핵심 어휘 표 다음)에 붙인다.
//
// 분석과 같은 요청에 묶지 않는다. 그림 한 장에 8~12초가 걸려서 지문이 여러 개면 요청
// 하나가 몇 분씩 열려 있게 되고, 그전에 배포 프록시가 먼저 끊는다. 서버는 지문 하나만
// 받고, 여러 장이면 여기서 한 장씩 차례로 부른다(실패한 지문은 건너뛰고 계속한다).
//
// 저장함(💾)에는 넣지 않는다 — Firestore 문서 하나가 1MiB인데 4K 그림은 base64로 그보다
// 크다. 넣으면 저장 자체가 실패하므로, 그림은 인쇄하거나 내려받아 쓰는 것으로 둔다.
// 다시 필요하면 다시 만들어야 하고 그때 다시 과금된다 — 버튼 안내문에 그렇게 적어 두었다.

/* 받은 base64를 blob URL로 바꿔서 DOM에 넣는다. data URI를 그대로 쓰면 안 되는 이유:
   되돌리기(undoOnce)가 결과 화면 HTML을 통째로 문자열로 찍어 쌓는 구조라, 4K 그림이
   data URI로 박혀 있으면 스냅샷 한 장이 몇 MB가 된다. 그러면
     ① UNDO_MAX_CHARS(20M자) 상한을 한두 단계 만에 먹어 되돌리기가 사실상 죽고,
     ② '직접 수정'에서 글자를 칠 때마다 그 몇 MB를 매번 복사해 편집이 느려진다.
   blob URL은 DOM에 50자 남짓만 남고 그림 실체는 메모리에 한 벌만 있으므로 둘 다 없다.
   대신 만든 URL은 스스로 사라지지 않아 결과를 갈아엎을 때 직접 반납해야 한다. */
let infographicUrls = [];

function b64ToBlobUrl(b64, mime) {
  const bin = atob(b64);
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  const url = URL.createObjectURL(new Blob([bytes], { type: mime }));
  infographicUrls.push(url);
  return url;
}

// 결과 화면을 새로 그리기 전에 부른다 — 안 부르면 만든 그림이 탭을 닫을 때까지 메모리에 남는다
function revokeInfographics() {
  infographicUrls.forEach((u) => URL.revokeObjectURL(u));
  infographicUrls = [];
}

function infographicBlockHtml(idx, src) {
  // data-brk="page" — 가로로 꽉 차는 그림이라 앞 내용에 이어 붙이면 반쪽이 잘린다.
  // '쪽 구성'에서 끌 수 있는 기본값이고, data-brk-def가 [처음 상태로]의 되돌릴 값이다.
  return `
    <div class="pg-blk" data-brk="page" data-brk-def="page" data-infographic="${idx}">
      <h3 class="section"><span class="num">Ⅳ.</span> 한눈에 보는 요약</h3>
      <div class="table-wrap"><img class="infographic" src="${src}" alt="지문 요약 인포그래픽"></div>
      <p class="info-caution">그림 속 글자는 AI가 그린 것이라 '직접 수정'으로 고칠 수 없습니다.
        인쇄하기 전에 오탈자가 없는지 한 번 확인해 주세요.</p>
    </div>`;
}

const infoChk = $("infoChk");
// 가격표는 화면이 다 그려진 뒤에 도착하므로, 도착하면 체크박스 옆 금액을 채워 넣는다
onPricingReady(() => {
  const el = $("infoChkPrice");
  if (el && PRICING) el.textContent = `(지문당 +${PRICING.infographic.toLocaleString()}원 · 8~12초)`;
});

/* 분석이 끝난 뒤 이어서 그림을 만든다. 부르는 곳은 analyze() 하나뿐이고, 금액은
   거기 확인 창에서 이미 합쳐 물었으므로 여기서 다시 묻지 않는다.
   todo: 그림을 넣을 지문의 번호 목록 (lastAnalyzeEntries의 자리번호) */
async function makeInfographics(todo) {
  const entries = lastAnalyzeEntries;
  if (!todo || !todo.length) return;

  analyzeBtn.disabled = true;
  setEditMode(false);   // 그림이 끼어들면 수정 중이던 자리가 어긋난다
  setPagingMode(false); // 쪽 경계도 다시 잡아야 한다
  loadingEl.classList.add("on");

  let okCount = 0;
  for (let n = 0; n < todo.length; n++) {
    const idx = todo[n];
    const job = entries[idx].job;
    loadingTextEl.textContent =
      todo.length > 1
        ? `${job.name} 요약 이미지 만드는 중… (${n + 1}/${todo.length})`
        : "AI가 요약 이미지를 그리는 중입니다… (8~12초)";
    try {
      const data = await postJson(
        "/api/infographic",
        { passage: job.text },
        "요약 이미지를 만들지 못했습니다."
      );
      const host = resultEl.querySelector(`section.passage-block[data-entry="${idx}"]`);
      if (host) {
        const src = b64ToBlobUrl(data.image, data.mime || "image/jpeg");
        host.insertAdjacentHTML("beforeend", infographicBlockHtml(idx, src));
        okCount++;
      }
    } catch (err) {
      // 한 지문이 실패해도 나머지는 계속 만든다. 다만 한도 소진은 기다려도 안 풀린다.
      errorEl.textContent = `${job.name}: ${err.message || String(err)}`;
      if (isQuotaError(err)) break;
    }
  }

  loadingEl.classList.remove("on");
  analyzeBtn.disabled = false;
  resetUndo();            // 그림이 붙은 상태가 새 출발점이다
  syncFloatPrint();
  refreshTokenDisplay();  // 성공한 장수만큼 차감됐을 잔액 갱신
  if (okCount) {
    const last = resultEl.querySelector(`[data-infographic]:last-of-type`);
    if (last) last.scrollIntoView({ behavior: "smooth", block: "start" });
  }
}

// "내 저장함"에서 불러온 분석 결과를 화면에 되살린다 — API를 다시 부르지 않고,
// 저장해 둔 원본 data를 그때와 같은 buildAnalysisHtml로 다시 그리기만 한다.
function renderAnalyzeEntries(entries) {
  const total = entries.length;
  const htmlParts = entries.map(({ job, data }, i) => buildAnalysisHtml(data, job, total, i));
  if (total) htmlParts.push(`<footer>구문 단위 직독직해 분석본 · 자동 생성</footer>`);
  setEditMode(false);
  setPagingMode(false);
  revokeInfographics(); // 불러오기로 화면을 갈아엎기 전에 이전 그림을 놓아준다
  resultEl.innerHTML = htmlParts.join("");
  printBtn.style.display = total ? "inline-flex" : "none";
  editBtn.style.display = total ? "inline-flex" : "none";
  pageBtn.style.display = total ? "inline-flex" : "none";
  saveBtn.style.display = total ? "inline-flex" : "none";
  // 그림은 저장함에 담기지 않으므로(1MiB 제한) 불러온 분석본에는 그림이 없다.
  // 다시 넣으려면 '요약 이미지'를 켜고 분석을 다시 돌려야 한다.
  resetUndo();
  lastAnalyzeEntries = entries;
  syncFloatPrint();
  // 비우는 호출(entries가 빈 배열)일 때는 스크롤하지 않는다 — 빈 자리로 끌려가지 않게
  if (total) resultEl.scrollIntoView({ behavior: "smooth", block: "start" });
}

/* ── 직접 수정한 내용을 저장 데이터에 되돌려 넣기 ──
   '직접 수정'은 화면(DOM)만 고친다. 인쇄는 그 화면을 그대로 뽑으므로 고친 내용이
   나가지만, 저장은 분석 당시의 원본 data를 보내므로 그냥 두면 고친 내용이 저장에서
   빠진다(불러오면 수정이 사라진다). 그래서 저장 직전에 화면을 한 번 되읽는다.
   되읽는 곳은 실제로 고칠 수 있는 세 곳뿐이다(EDITABLE_SEL — 루비·한글 해석·해설).
   영어 원문·표·제목은 잠겨 있어 화면과 데이터가 어긋날 일이 없다. */

// contenteditable 표시는 화면용이라 저장 데이터에 섞이면 안 된다 — 지운 복사본을 준다
function editedCopy(el) {
  const copy = el.cloneNode(true);
  copy.removeAttribute("contenteditable");
  copy.querySelectorAll("[contenteditable]").forEach((n) => n.removeAttribute("contenteditable"));
  return copy;
}

function collectAnalysisEdits() {
  lastAnalyzeEntries.forEach((entry, idx) => {
    const block = resultEl.querySelector(`.passage-block[data-entry="${idx}"]`);
    if (!block || !entry || !entry.data) return; // 화면이 이미 바뀌었으면 원본을 그대로 둔다
    const sentEls = block.querySelectorAll(".sent");
    (entry.data.sentences || []).forEach((s, i) => {
      const sentEl = sentEls[i];
      if (!sentEl) return;

      // 청크 — 루비(rt)는 .c-eng 안에 있어서 영문 칸을 통째로 되읽어야 반영된다
      const chunkEls = sentEl.querySelectorAll(".chunk");
      (s.chunks || []).forEach((c, j) => {
        const chunkEl = chunkEls[j];
        if (!chunkEl) return;
        const engEl = chunkEl.querySelector(".c-eng");
        const korEl = chunkEl.querySelector(".c-kor");
        if (engEl) c.eng = editedCopy(engEl).innerHTML;
        if (korEl) c.kor = editedCopy(korEl).innerHTML;
      });

      // 해설 — 자동으로 붙는 제목과 '출제 포인트' 상자는 다시 그릴 때 붙으므로 뺀다
      const noteEl = sentEl.querySelector(".note");
      if (!noteEl) return;
      const noteCopy = editedCopy(noteEl);
      const whyCopy = noteCopy.querySelector(".exam-why");
      if (whyCopy) whyCopy.remove();
      const titleCopy = noteCopy.querySelector(".note-title");
      if (titleCopy) titleCopy.remove();
      s.note = noteCopy.innerHTML;

      const whyEl = noteEl.querySelector(".exam-why");
      if (whyEl) {
        const whyBody = editedCopy(whyEl);
        const whyTitle = whyBody.querySelector(".exam-why-title");
        if (whyTitle) whyTitle.remove();
        s.examNote = whyBody.innerHTML;
      }
    });
  });
  return lastAnalyzeEntries;
}

TAB_SAVE.analyze = {
  saveBtn,
  getPayload: () => ({
    passages: passageMgr.getJobs(),
    settings: { targetGrammar: grammarEl.value, review: !!(reviewChk && reviewChk.checked) },
    entries: collectAnalysisEdits(),
    pageBreaks: collectPageBreaks(),
  }),
  applyPayload: (payload) => {
    passageMgr.setJobs(payload.passages || []);
    grammarEl.value = (payload.settings && payload.settings.targetGrammar) || "";
    if (reviewChk) reviewChk.checked = !!(payload.settings && payload.settings.review);
    renderAnalyzeEntries(payload.entries || []);
    applyPageBreaks(payload.pageBreaks); // 손봐 둔 쪽 구성까지 그대로 되살린다
    resetUndo(); // 불러온 그 상태가 출발점 (되돌리기로 저장본 이전으로 가지 않게)
  },
  clearResults: () => renderAnalyzeEntries([]),
};

function esc(s) {
  return String(s == null ? "" : s)
    .replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

// 문제 유형 라벨 → CSS 클래스 접미사 (색상 구분용)
function examCls(t) {
  const map = {
    "문장삽입": "insert", "빈칸": "blank", "요지": "gist", "순서": "order",
    "함축": "imply", "어법": "grammar", "어휘": "vocab", "제목단서": "title",
  };
  return map[t] || "etc";
}

// 모델이 준 HTML(루비/색상 스팬 등)을 브라우저 파서로 정규화해 태그 균형을 복구한다.
// 짝이 안 맞는 태그(안 닫힌 <ruby>, 남은 </div> 등)가 문장 카드(.sent) 그리드를
// 깨뜨려 요약·어휘표가 오른쪽 해설 칸으로 빨려들어가는 현상을 원천 차단.
function safeHTML(s) {
  const t = document.createElement("div");
  t.innerHTML = s == null ? "" : String(s);
  return t.innerHTML;
}

// 한 지문의 분석 실패 카드
// label: 지문 변형 세트 이름 ("원문" / "5개 내외 변형" …). 변형을 하나만 골랐으면 빈 값.
// what: 실패한 작업 이름 (기본 "분석" — 문제 제작 탭에서는 "문제 제작")
function buildErrorHtml(job, total, msg, label, kind) {
  const what = kind === "mcq" || kind === "saq" ? "문제 제작" : "분석";
  const named = total > 1 || job.named || label;
  const who = [named ? job.name : "", label].filter(Boolean).join(" · ");
  const head = who ? `${who} ${what} 실패` : `${what} 실패`;
  return `<section class="passage-block"><div class="passage-error"><b>${esc(head)}</b>${esc(msg)}</div></section>`;
}

// 결과 상단에 지문 이름표를 붙일지 (여러 지문이거나, 직접 이름을 지었을 때).
// 변형 세트를 여러 개 만들었으면 어느 세트인지도 함께 보여 준다 — 세트끼리 지문이
// 달라서, 이름표가 없으면 인쇄 후에 어느 쪽이 원문인지 알 수 없다.
function passageBanner(job, total, label) {
  if (!(total > 1 || job.named || label)) return "";
  const tail = label ? `<span class="passage-banner-tag">${esc(label)}</span>` : "";
  return `<div class="passage-banner">${esc(job.name)}${tail}</div>`;
}

// 한 지문의 전체 분석본 HTML을 문자열로 만든다 (여러 지문을 이어붙이기 위함)
// idx: lastAnalyzeEntries에서 이 지문이 몇 번째인지. 저장할 때 화면에서 고친 내용을
//      어느 entry에 되돌려 넣을지 찾는 표식이다(실패 카드가 섞이면 화면 순서와
//      entries 순서가 어긋나므로 번호를 직접 박아 둔다).
function buildAnalysisHtml(d, job, total, idx) {
  const parts = [];
  const mark = Number.isInteger(idx) ? ` data-entry="${idx}"` : "";
  parts.push(`<section class="passage-block"${mark}>`);

  // 표지
  // .pg-blk = '쪽 구성'이 통째로 옮길 수 있는 최소 덩어리. 표지·문장 카드 하나·표 하나가
  // 각각 한 덩어리다. 인쇄에서 쪼개지지 않는 단위와 일부러 같게 맞춰 두었다.
  // .pg-head = 지문의 첫 덩어리. 지문은 이미 새 쪽에서 시작하므로 쪽 나눔을 걸지 않는다.
  // 지문 이름표(37번 …)를 이 안에 함께 넣는 이유: 덩어리 밖에 두면 쪽 계산에서 빠져
  // 쪽 경계선이 이름표 아래에 그어진다. 그러면 화면에서는 이름표가 앞 쪽 끝에 붙어
  // 보이는데 인쇄하면 다음 쪽으로 넘어가, 화면과 종이가 어긋난다.
  parts.push(`
    <div class="pg-blk pg-head">
    ${passageBanner(job, total)}
    <div class="cover">
      <h2>${esc(d.englishTitle)}</h2>
      <div class="ko-title">${esc(d.koreanTitle)}</div>
      <div class="legend">
        <span class="legend-title">색상 범례 (본문 · 해설 공통)</span>
        <b><span class="dot" style="background:var(--g)"></span><span class="g">어법</span></b>
        <b><span class="dot" style="background:var(--v)"></span><span class="v">어휘</span></b>
        <b><span class="dot" style="background:var(--gv)"></span><span class="gv">어법+어휘</span></b>
        <b><span class="dot" style="background:var(--conj)"></span><span class="dot" style="background:var(--conj2)"></span><span class="dot" style="background:var(--conj3)"></span><span class="conj-hl">병렬구조</span><span class="legend-note">같은 색끼리 한 묶음</span></b>
        <b><span class="dot" style="background:var(--hl)"></span><span class="hl" style="padding:0 3px;border-radius:3px">강조·연결어</span></b>
        ${grammarEl.value.trim() ? `<b><span class="dot" style="background:var(--target-hl)"></span><span class="tg" style="padding:0 3px;border-radius:3px">목표 어법</span></b>` : ""}
        <b><span class="sep">/</span> 의미 단위 끊어읽기</b>
      </div>
    </div>
    </div>
  `);

  // 문장 카드 — 청크(의미 단위)마다 영문+한글을 번갈아 표시
  (d.sentences || []).forEach((s) => {
    const chunksHtml = (s.chunks || [])
      .map(
        (c) => `
        <div class="chunk">
          <div class="c-eng">${safeHTML(c.eng)}</div>
          <div class="c-kor">${safeHTML(c.kor)}</div>
        </div>`
      )
      .join("");
    const topic = s.isTopic ? " is-topic" : "";
    const topicBadge = s.isTopic ? `<span class="exam-tag et-topic">주제문</span>` : "";
    const examBadges = (s.examTags || [])
      .map((t) => `<span class="exam-tag et-${examCls(t)}">${esc(t)}</span>`)
      .join("");
    parts.push(`
      <div class="pg-blk">
      <div class="sent${topic}">
        <div class="sent-head"><span class="sent-no">${esc(s.no)}</span><span class="tag">${esc(s.tag)}</span><span class="exam-tags">${topicBadge}${examBadges}</span></div>
        <div class="chunks">${chunksHtml}</div>
        <div class="note"><span class="note-title">${esc(s.no)}번 해설</span>${safeHTML(s.note)}${
          s.examNote
            ? `<div class="exam-why"><span class="exam-why-title">🎯 출제 포인트</span>${safeHTML(s.examNote)}</div>`
            : ""
        }</div>
      </div>
      </div>
    `);
  });

  // 요약표
  if (d.summary && d.summary.length) {
    const rows = d.summary.map(
      (r) => `<tr><td>${esc(r.label)}</td><td>${safeHTML(r.content)}</td></tr>`
    ).join("");
    // 제목과 표는 한 덩어리로 묶는다 — 따로 움직이면 제목만 남은 쪽이 생긴다.
    // data-brk="page"가 기존의 '요약표는 늘 새 쪽에서 시작'을 이어받는다. 다만 이제는
    // '쪽 구성'에서 끌 수 있는 기본값이고, data-brk-def가 [처음 상태로]의 되돌릴 값이다.
    parts.push(`
      <div class="pg-blk" data-brk="page" data-brk-def="page">
      <h3 class="section"><span class="num">Ⅱ.</span> 주제 &amp; 흐름 요약</h3>
      <div class="table-wrap"><table class="flow"><tbody>${rows}</tbody></table></div>
      </div>
    `);
  }

  // 어휘표
  if (d.vocab && d.vocab.length) {
    const rows = d.vocab.map(
      (v) => `<tr>
        <td>${esc(v.word)}</td><td class="pos">${esc(v.pos)}</td>
        <td>${esc(v.meaning)}</td><td>${esc(v.synonym)}</td><td>${esc(v.antonym)}</td>
      </tr>`
    ).join("");
    parts.push(`
      <div class="pg-blk">
      <h3 class="section"><span class="num">Ⅲ.</span> 핵심 어휘 &amp; 표현</h3>
      <div class="table-wrap"><table class="vocab">
        <thead><tr><th>단어 / 표현</th><th>품사</th><th>뜻</th><th>유의어</th><th>반의어</th></tr></thead>
        <tbody>${rows}</tbody>
      </table></div>
      </div>
    `);
  }

  parts.push(`</section>`);
  return parts.join("");
}

/* ══════════════════════════ 문제 제작 탭 (객관식 / 주관식) ══════════════════════════ */

const CIRCLED = ["①", "②", "③", "④", "⑤", "⑥", "⑦", "⑧", "⑨", "⑩", "⑪", "⑫"];

// 객관식(5지선다) 유형
const MCQ_TYPES = [
  { id: "주제", def: true }, { id: "제목", def: true }, { id: "요지", def: true },
  { id: "빈칸", def: true }, { id: "어휘", def: false }, { id: "어법", def: false },
  { id: "순서", def: false }, { id: "문장삽입", def: false }, { id: "함축의미", def: false },
  { id: "무관한 문장", def: false }, { id: "요약문", def: false }, { id: "영영풀이", def: false },
  { id: "내용일치(영)", def: false }, { id: "내용일치(한)", def: false },
  { id: "내용불일치(영)", def: false }, { id: "내용불일치(한)", def: false },
];
// 주관식(서술형·단답형) 유형
const SAQ_TYPES = [
  { id: "서술형배열", def: true }, { id: "OX진위(영)", def: true }, { id: "OX진위(한)", def: false },
  { id: "어휘 선택형", def: true }, { id: "어법 선택형", def: true },
  { id: "틀린 어휘 찾기", def: false }, { id: "틀린 어법 찾기", def: false },
  { id: "동사형 쓰기", def: false }, { id: "빈칸 쓰기", def: false },
  { id: "표현 찾아 쓰기", def: false }, { id: "영영풀이 쓰기", def: false },
  { id: "무관한 문장 쓰기", def: false }, { id: "요약문 완성", def: false },
];

// select 대신 '체크박스처럼 보이는 라디오 그룹'으로 값을 관리할 때 쓰는 어댑터.
// select와 똑같이 .value getter/setter, .addEventListener("change", ...)를 제공해서
// 아래 출제 순서·지문 변형·단어장 형식/정렬 로직을 select였을 때와 그대로 재사용한다.
// 해당 name의 라디오가 화면에 하나도 없으면(예: 주관식 탭의 '지문 변형') null을 반환해
// 기존의 `if (variationEl) {...}` 같은 존재 여부 검사가 그대로 동작하게 한다.
function radioGroup(name) {
  const inputs = () => [...document.querySelectorAll(`input[name="${name}"]`)];
  if (!inputs().length) return null;
  return {
    get value() {
      const on = inputs().find((i) => i.checked);
      return on ? on.value : "";
    },
    set value(v) {
      inputs().forEach((i) => (i.checked = i.value === v));
      syncPicked(name);
    },
    addEventListener(type, fn) {
      inputs().forEach((i) =>
        i.addEventListener(type, (e) => {
          syncPicked(name);
          fn(e);
        })
      );
    },
  };
}
// 선택된 라디오의 라벨에 .picked 를 붙여 유형 선택 칸과 같은 방식으로 강조 표시한다
function syncPicked(name) {
  document.querySelectorAll(`input[name="${name}"]`).forEach((i) => {
    i.closest("label").classList.toggle("picked", i.checked);
  });
}

// 여러 개를 고를 수 있는 체크박스 묶음. radioGroup과 짝을 이루되 값이 배열이다.
// (지문 변형처럼 "여러 개를 고르면 고른 수만큼 세트가 늘어나는" 컨트롤에 쓴다)
function checkGroup(name) {
  const inputs = () => [...document.querySelectorAll(`input[name="${name}"]`)];
  if (!inputs().length) return null;
  return {
    get values() {
      return inputs().filter((i) => i.checked).map((i) => i.value);
    },
    set values(list) {
      const want = new Set(list || []);
      inputs().forEach((i) => (i.checked = want.has(i.value)));
      syncPicked(name);
    },
    input(value) {
      return inputs().find((i) => i.value === value) || null;
    },
    addEventListener(type, fn) {
      inputs().forEach((i) =>
        i.addEventListener(type, (e) => {
          syncPicked(name);
          fn(e);
        })
      );
    },
  };
}

// 지문 변형 단계 — 화면 표시용 이름과 설명
const VARIATION_LABELS = {
  verbatim: "원문",
  light: "5개 내외 변형",
  heavy: "5개 이상 변형",
};
const VARIATION_DESC = {
  verbatim: "지문을 그대로 사용합니다.",
  light: "지문 전체에서 약 5개 단어·표현을 비슷한 뜻의 다른 말로 바꿉니다.",
  heavy: "지문 전체에서 5개보다 많은 단어·표현을 바꿉니다.",
};

/* 한 지문에서 유형별로 뽑을 수 있는 최대 문항 수.
   server.py의 QUIZ_TYPE_MAX와 반드시 같은 값을 유지한다 — 여기서는 +버튼을 막는 데
   쓰고, 서버는 화면을 우회한 요청을 같은 값으로 잘라낸다(가격이 개수에 걸린다). */
const TYPE_MAX = {
  // 객관식
  주제: 5, 제목: 5, 요지: 5,
  "내용일치(영)": 5, "내용일치(한)": 5, "내용불일치(영)": 5, "내용불일치(한)": 5,
  빈칸: 6, 어휘: 6, 어법: 4,
  순서: 2, 문장삽입: 2, 함축의미: 2, 영영풀이: 5,
  "무관한 문장": 1, 요약문: 1,
  // 주관식
  "OX진위(영)": 8, "OX진위(한)": 8,
  서술형배열: 6, "어휘 선택형": 6,
  "틀린 어휘 찾기": 5, "어법 선택형": 5, "틀린 어법 찾기": 3,
  "동사형 쓰기": 2, "빈칸 쓰기": 3, "표현 찾아 쓰기": 2, "영영풀이 쓰기": 2,
  "무관한 문장 쓰기": 1, "요약문 완성": 1,
};
// +버튼이 막혔을 때 왜 막혔는지 알려 준다 — 유형마다 상한이 다른 이유가 다르다.
const TYPE_MAX_REASON = {
  순서: "지문의 문장 수에 묶여 있어",
  문장삽입: "지문의 문장 수에 묶여 있어",
  함축의미: "지문에 비유·반어 표현이 든 문장 수 때문에",
  "동사형 쓰기": "한 문항이 이미 동사 4~6개를 가져가서",
  "빈칸 쓰기": "문맥으로 되살릴 수 있는 핵심어 수 때문에",
  "표현 찾아 쓰기": "뜻이 하나로 떨어지는 표현 수 때문에",
  "영영풀이 쓰기": "영영풀이 하나로 뜻이 딱 정해지는 낱말 수 때문에",
  어법: "지문에 실제로 있는 문법 포인트 수 때문에",
  "어법 선택형": "지문에 실제로 있는 문법 포인트 수 때문에",
  "틀린 어법 찾기": "지문에 실제로 있는 문법 포인트 수 때문에",
  // 둘 다 '글 전체의 논지' 하나에 걸려 있어 지문 하나에서 1문항이 상한이다.
  // 무관한 문장을 두 개 심으면 남은 문장만으로 원래 흐름이 이어지지 않아 어느 쪽이
  // 무관한지 가릴 수 없고, 요약은 글 하나에 하나뿐이라 두 번째는 중복이 된다.
  "무관한 문장": "글의 논지가 하나뿐이라",
  요약문: "글 하나를 요약한 문장이 하나뿐이라",
  "무관한 문장 쓰기": "글의 논지가 하나뿐이라",
  "요약문 완성": "글 하나를 요약한 문장이 하나뿐이라",
};
function typeMaxNote(id) {
  const max = TYPE_MAX[id] || 1;
  const why = TYPE_MAX_REASON[id];
  return why
    ? `${why} ${max}문항까지만 만들 수 있습니다.`
    : `이 유형은 ${max}문항까지 만들 수 있습니다.`;
}

// 한 번의 호출에 넣을 최대 '문항 수'.
// 문항마다 지문이 통째로 실려 나오는 유형이 있어, 한 호출의 출력이 커지면 배포
// 환경의 프록시 제한(약 100초)에 걸린다. 문항 수로 끊으면 유형을 몇 개 골랐든
// 호출당 출력량이 비슷하게 유지되고, 하나가 실패해도 그 몇 문항만 잃는다.
const QUIZ_QUESTIONS_PER_CALL = 6;

// '문제 만들기' 한 번에 만들 수 있는 총 문항 수 상한 = 지문 수 × 변형 세트 수 × 문항 수.
// 유형별 상한만으로는 이 폭발을 막지 못한다 — 객관식 최대는 지문 1개당 55문항이지만,
// 지문 10개 × 변형 3세트면 1,650문항이 되어 실행 시간도 요금도 감당이 안 된다.
// 지문 수는 이 탭 밖에서 바뀌므로 만들기를 누르는 시점에만 확인한다.
const QUIZ_MAX_QUESTIONS_PER_RUN = 200;

// 객관식 '지문변형형' — 정찰 가격도, 실제로 쓰는 모델(Pro)도 다른 유형들.
// server.py의 MCQ_ONLY_TYPES 중 QUIZ_PLAIN_PASSAGE_TYPES에 없는 5개와 반드시 같아야 한다.
// 무관한 문장·요약문도 여기 든다 — 둘 다 지문을 그대로 싣지 않고 손을 댄다
// (무관한 문장은 없던 문장을 지어 끼워 넣고, 요약문은 요약 문장을 새로 쓴다).
const MCQ_TRANSFORM_TYPES = new Set([
  "빈칸", "어휘", "어법", "순서", "문장삽입", "무관한 문장", "요약문",
]);

/* 유형을 호출 묶음으로 나눈다. 규칙 세 가지:
   ① '지문변형형'(Pro로 처리)과 나머지(Flash로 처리)를 먼저 가른다 — 한 호출 안에 두
      모델이 섞이면 서버가 어느 모델로 부를지 정할 수 없다.
   ② 같은 유형은 절대 쪼개지 않는다 — 호출끼리는 서로 무엇을 만들었는지 모르므로,
      한 유형의 문항이 두 호출로 갈리면 같은 문제가 중복으로 나온다.
   ③ 그 안에서 문항 수 합계가 상한을 넘지 않게 묶는다. 단, 유형 하나가 이미 상한보다
      크면(예: OX진위 8문항) ②가 우선이라 그 유형만으로 한 묶음을 만든다.
   items = [{id, count}] 를 받아 같은 모양의 배열들로 돌려준다. */
// 진행 표시·오류 메시지에 쓸 묶음 이름 — 2문항 이상인 유형만 개수를 덧붙인다
function groupLabel(group) {
  return group.map((it) => (it.count > 1 ? `${it.id} ${it.count}문항` : it.id)).join(", ");
}

function chunkTypes(items, size = QUIZ_QUESTIONS_PER_CALL) {
  const out = [];
  const pack = (list) => {
    let cur = [];
    let n = 0;
    for (const it of list) {
      if (cur.length && n + it.count > size) {
        out.push(cur);
        cur = [];
        n = 0;
      }
      cur.push(it);
      n += it.count;
    }
    if (cur.length) out.push(cur);
  };
  pack(items.filter((it) => !MCQ_TRANSFORM_TYPES.has(it.id)));
  pack(items.filter((it) => MCQ_TRANSFORM_TYPES.has(it.id)));
  return out;
}

// 문제 제작 탭 하나를 구성한다 (객관식·주관식이 같은 로직을 공유)
function setupQuizTab({ prefix, types, footer }) {
  const gridEl = $(prefix + "TypeGrid");
  const allEl = $(prefix + "TypeAll");
  const btn = $(prefix + "Btn");
  const printBtn = $(prefix + "PrintBtn");
  const saveBtn = $(prefix + "SaveBtn");
  const docxBtn = $(prefix + "DocxBtn");
  let lastEntries = []; // 저장/불러오기용 — {job, label, set, total}
  const docName = prefix === "mcq" ? "객관식문제" : "주관식문제";
  const errorEl = $(prefix + "Error");
  const loadingEl = $(prefix + "Loading");
  const loadingTextEl = $(prefix + "LoadingText");
  const resultEl = $(prefix + "Result");
  const orderEl = radioGroup(prefix + "Order");
  const orderHintEl = $(prefix + "OrderHint");
  const ORDER_STORE = "gemini_" + prefix + "_order";
  // 지문 변형 — 지금은 객관식 탭에만 있는 컨트롤이라 주관식 탭에서는 checkGroup이 null을 반환한다.
  // 어법·어휘 선택형처럼 [정답|오답] 쌍이 실제 원문 단어와 정확히 일치해야 하는 주관식
  // 포맷과 변형이 섞이면 정답 근거가 애매해지므로, 주관식은 항상 "원문 그대로"로 보낸다.
  const variationEl = checkGroup(prefix + "Variation");
  const variationHintEl = $(prefix + "VariationHint");
  const VARIATION_STORE = "gemini_" + prefix + "_variation";
  const costHintEl = $(prefix + "CostHint");

  /* 유형 칩 생성 — 체크박스(선택)와 스테퍼(문항 수)를 형제로 둔다.
     스테퍼를 <label> 안에 넣으면 +/− 를 누를 때마다 라벨이 체크박스를 토글해 버리므로,
     라벨은 '체크박스 + 유형 이름'까지만 감싼다. */
  types.forEach((t) => {
    const max = TYPE_MAX[t.id] || 1;
    const chip = document.createElement("div");
    chip.className = "type-chip";
    chip.dataset.id = t.id;
    chip.innerHTML =
      `<label><input type="checkbox" value="${esc(t.id)}" ${t.def ? "checked" : ""}>` +
      `<span class="type-name">${esc(t.id)}</span></label>` +
      `<div class="type-count" title="${esc(typeMaxNote(t.id))}">` +
      `<button type="button" class="type-step" data-step="-1" aria-label="${esc(t.id)} 문항 수 줄이기">−</button>` +
      `<span class="type-n" aria-live="polite" data-n="1"></span>` +
      `<button type="button" class="type-step" data-step="1" aria-label="${esc(t.id)} 문항 수 늘리기">+</button>` +
      `</div>`;
    chip.querySelector(".type-n").dataset.max = max;
    gridEl.appendChild(chip);
  });

  /* 유형별 문항 수. 값은 data-n에 두고 화면 글자는 syncTypeChips가 그린다 —
     체크가 꺼진 유형은 숫자를 비워 둔다. 만들지 않을 유형에 숫자가 남아 있으면
     무엇을 몇 개 만드는지 헷갈리기 때문. 체크를 켜면 언제나 1부터 시작한다. */
  const chipOf = (id) => gridEl.querySelector(`.type-chip[data-id="${CSS.escape(id)}"]`);
  const countOf = (id) => {
    const el = chipOf(id);
    return el ? Math.max(1, Number(el.querySelector(".type-n").dataset.n) || 1) : 1;
  };
  function setCount(chip, n) {
    const nEl = chip.querySelector(".type-n");
    const max = Number(nEl.dataset.max) || 1;
    nEl.dataset.n = Math.min(max, Math.max(1, n));
  }
  // 체크한 유형을 화면 순서대로 [{id, count}]로 —— 요청·가격 계산이 모두 이 값을 쓴다
  const pickedItems = () =>
    [...gridEl.querySelectorAll(".type-chip")]
      .filter((c) => c.querySelector("input").checked)
      .map((c) => ({ id: c.dataset.id, count: countOf(c.dataset.id) }));

  // 스테퍼 — 라벨 밖이라 체크 상태를 건드리지 않는다.
  // 체크가 꺼진 유형에서 +를 누르는 것은 '이 유형을 쓰겠다'는 뜻이므로, 켜고 1부터 시작한다.
  gridEl.addEventListener("click", (e) => {
    const step = e.target.closest(".type-step");
    if (!step) return;
    const chip = step.closest(".type-chip");
    const box = chip.querySelector("input");
    const delta = Number(step.dataset.step);
    if (!box.checked) {
      if (delta < 0) return; // 꺼진 유형에서 −는 할 일이 없다
      box.checked = true;
      setCount(chip, 1);
    } else if (delta < 0 && countOf(chip.dataset.id) <= 1) {
      // 1에서 −를 누르면 0이 되는 셈이므로 유형 자체를 끈다 —— 체크박스를 따로
      // 찾아 누르지 않아도 스테퍼만으로 선택을 해제할 수 있다.
      // (숫자는 syncTypeChips가 1로 되돌리고 비운다)
      box.checked = false;
    } else {
      setCount(chip, countOf(chip.dataset.id) + delta);
    }
    syncAll();
    syncTypeChips();
  });

  // 출제 순서 — "type"(유형 순서대로) / "random"(무작위로 섞기)
  const isRandom = () => orderEl.value === "random";

  // 칩의 선택 표시와 스테퍼 상태를 지금 값에 맞춘다.
  // 출제 순서는 화면에 나열된 순서(DOM 순서) 그대로이고 서버에도 그 순서로 보내지만,
  // 칩에 문항 번호까지 찍지는 않는다 — 유형 이름·개수와 함께 놓기엔 정보가 많고,
  // 문항이 여러 개면 '1–2.'처럼 범위가 되어 정작 유형 이름이 잘렸다.
  function syncTypeChips() {
    gridEl.querySelectorAll(".type-chip").forEach((chip) => {
      const on = chip.querySelector("input").checked;
      chip.classList.toggle("picked", on);
      chip.querySelector(".type-count").classList.toggle("off", !on);
      const nEl = chip.querySelector(".type-n");
      // 체크가 꺼진 유형은 숫자를 비우고 값도 1로 되돌린다 — 만들지 않을 유형에 숫자가
      // 남아 있으면 무엇을 몇 개 만드는지 헷갈린다. 켜는 순간 1부터 다시 센다.
      if (!on) nEl.dataset.n = "1";
      const cur = countOf(chip.dataset.id);
      const max = Number(nEl.dataset.max) || 1;
      nEl.textContent = on ? String(cur) : "";
      // 상한에 닿으면 + 를 잠근다. 꺼진 유형의 +는 '켜고 1로'라서 열어 둔다.
      chip.querySelector('.type-step[data-step="1"]').disabled = on && cur >= max;
      // − 는 켜져 있으면 언제나 열어 둔다 — 1에서 한 번 더 누르면 유형이 꺼진다
      chip.querySelector('.type-step[data-step="-1"]').disabled = !on;
    });
    updateCostHint();
  }

  /* 지문 1개 · 변형 1세트를 만드는 값. server.py의 _quiz_action_cost와 같은 식이다
     — 유형 기본 단가 + 추가 문항 × PRICE_EXTRA_QUESTION_KRW.
     실제 청구는 언제나 서버가 다시 계산하고, 여기 값은 미리 보여 주기 위한 것이다. */
  function costPerSet(items) {
    if (!PRICING) return 0;
    const extra = PRICING.extraQuestion || 0;
    return items.reduce((sum, it) => {
      const base =
        prefix === "mcq"
          ? MCQ_TRANSFORM_TYPES.has(it.id)
            ? PRICING.mcqTransform
            : PRICING.mcqPlain
          : PRICING.saq;
      return sum + base + extra * (it.count - 1);
    }, 0);
  }

  // 유형·개수·변형을 바꿀 때마다 총 문항 수와 예상 금액을 즉시 보여 준다.
  // 지문 수는 이 탭 밖(공통 지문 패널)에서 바뀌므로 '지문 1개당'으로 표시하고,
  // 지문 수까지 곱한 최종 금액은 만들기를 누를 때 확인창이 보여 준다.
  function updateCostHint() {
    if (!costHintEl) return;
    const items = pickedItems();
    if (!items.length) {
      costHintEl.textContent = "";
      return;
    }
    const total = items.reduce((s, it) => s + it.count, 0);
    const sets = variationEl ? Math.max(1, variationEl.values.length) : 1;
    const parts = [`선택 <b>${items.length}유형</b> · <b>${total}문항</b>`];
    if (sets > 1) parts.push(`× 변형 ${sets}세트 = <b>${total * sets}문항</b>`);
    if (PRICING) {
      parts.push(`— 지문 1개당 <b>${(costPerSet(items) * sets).toLocaleString()}원</b>`);
    }
    costHintEl.innerHTML = parts.join(" ");
  }

  function updateOrderHint() {
    orderHintEl.innerHTML = isRandom()
      ? "유형과 상관없이 문항이 <b>무작위로 섞여</b> 출제됩니다. 문제지 번호는 섞인 순서대로 1번부터 매겨집니다."
      : "위 <b>유형 칸에 놓인 순서대로</b> 출제됩니다. 문제지도 이 순서대로 만들어집니다.";
  }

  orderEl.value = localStorage.getItem(ORDER_STORE) === "random" ? "random" : "type";
  orderEl.addEventListener("change", () => {
    localStorage.setItem(ORDER_STORE, orderEl.value);
    syncTypeChips();
    updateOrderHint();
  });
  updateOrderHint();

  // 지문 변형 정도 — 있는 탭에서만 동작 (없으면 항상 ["verbatim"] 한 세트로 취급).
  // 여러 개를 고르면 고른 수만큼 문제 세트가 만들어진다 (원문 1세트 + 변형 1세트 …).
  const variations = () => {
    if (!variationEl) return ["verbatim"];
    const on = variationEl.values;
    return on.length ? on : ["verbatim"];
  };
  function updateVariationHint() {
    if (!variationHintEl) return;
    const on = variationEl ? variationEl.values : [];
    const parts = [];
    if (!on.length) {
      parts.push("지문 변형을 하나 이상 선택하세요.");
    } else if (on.length === 1) {
      parts.push(VARIATION_DESC[on[0]] || "");
    } else {
      parts.push(
        `<b>${on.map((v) => VARIATION_LABELS[v]).join(" + ")}</b> — ` +
          `지문 1개당 <b>${on.length}세트</b>가 만들어집니다. 사실·순서·난이도는 모두 그대로 유지됩니다.`
      );
    }
    if (on.includes("light") || on.includes("heavy")) {
      // 변형본은 문제를 만들기 전에 한 번 확정한다. 그래야 유형을 나눠 여러 번
      // 호출해도 모든 문항이 같은 지문을 쓴다.
      parts.push("변형본은 먼저 한 번 만들어 확정한 뒤, 그 지문으로 모든 문항을 출제합니다.");
    }
    variationHintEl.innerHTML = parts.filter(Boolean).join(" ");
  }
  if (variationEl) {
    // '5개 이상 변형'은 서버가 자동으로 Pro 모델을 골라 처리한다 — 화면에서
    // 모델을 고를 필요가 없으므로 잠금 없이 항상 선택할 수 있다.
    function saveVariations() {
      localStorage.setItem(VARIATION_STORE, variationEl.values.join(","));
    }
    const saved = (localStorage.getItem(VARIATION_STORE) || "verbatim")
      .split(",")
      .filter((v) => v in VARIATION_LABELS);
    variationEl.values = saved.length ? saved : ["verbatim"];
    variationEl.addEventListener("change", () => {
      saveVariations();
      updateVariationHint();
      updateCostHint(); // 세트 수가 바뀌면 총 문항 수·금액도 바뀐다
    });
  }

  // 전체 선택 / 전체 해제 (일부만 선택된 상태는 '중간' 표시)
  function syncAll() {
    const boxes = [...gridEl.querySelectorAll("input")];
    const on = boxes.filter((b) => b.checked).length;
    allEl.checked = on === boxes.length;
    allEl.indeterminate = on > 0 && on < boxes.length;
  }
  allEl.addEventListener("change", () => {
    const check = allEl.checked;
    gridEl.querySelectorAll(".type-chip").forEach((chip) => {
      chip.querySelector("input").checked = check;
      if (check) setCount(chip, 1); // 켤 때는 언제나 1부터
    });
    syncAll();
    syncTypeChips();
  });
  gridEl.addEventListener("change", (e) => {
    // 체크를 켜면 문항 수는 1로 되돌린다 — 껐다 켰는데 예전 숫자가 살아 있으면
    // 몇 개를 만드는지 화면만 보고 알 수 없다.
    const chip = e.target.closest && e.target.closest(".type-chip");
    if (chip && e.target.checked) setCount(chip, 1);
    syncAll();
    syncTypeChips();
  });
  syncAll();
  syncTypeChips();
  onPricingReady(updateCostHint); // 가격표가 늦게 와도 금액이 채워지도록

  async function generate() {
    errorEl.textContent = "";
    const jobs = passageMgr.getJobs();
    if (!jobs.length) {
      errorEl.textContent = "문제를 만들 영어 지문을 입력하세요.";
      return;
    }
    const picked = pickedItems();
    if (!picked.length) {
      errorEl.textContent = "출제 유형을 하나 이상 선택하세요.";
      return;
    }
    const perSetQuestions = picked.reduce((s, it) => s + it.count, 0);
    const vars = variationEl && !variationEl.values.length ? [] : variations();
    if (!vars.length) {
      errorEl.textContent = "지문 변형을 하나 이상 선택하세요.";
      return;
    }
    // 지문 수까지 곱한 실제 총량을 여기서 확인한다 — 지문은 이 탭 밖에서 바뀌므로
    // 유형 칸의 실시간 요약만으로는 잡히지 않는다.
    const runQuestions = billableJobCount() * perSetQuestions * vars.length;
    if (runQuestions > QUIZ_MAX_QUESTIONS_PER_RUN) {
      errorEl.textContent =
        `한 번에 ${QUIZ_MAX_QUESTIONS_PER_RUN}문항까지만 만들 수 있습니다 ` +
        `(지금 지문 ${billableJobCount()}개 × ${perSetQuestions}문항` +
        (vars.length > 1 ? ` × 변형 ${vars.length}세트` : "") +
        ` = ${runQuestions}문항). 지문·유형·문항 수 중 하나를 줄여 주세요.`;
      return;
    }
    if (PRICING) {
      // 유형마다 단가가 갈리고 추가 문항은 따로 매겨진다(costPerSet). 지문변형 세트를
      // 여러 개 고르면 세트 수만큼 문제 생성이 통째로 반복된다.
      const rewordSets = vars.filter((v) => v !== "verbatim").length;
      const cost =
        billableJobCount() * (vars.length * costPerSet(picked) + rewordSets * PRICING.reword);
      const label =
        `${docName}를 만듭니다.\n` +
        `지문 ${billableJobCount()}개 × ${perSetQuestions}문항` +
        (vars.length > 1 ? ` × 변형 ${vars.length}세트` : "") +
        ` = 총 ${billableJobCount() * perSetQuestions * vars.length}문항`;
      if (!costConfirmed(cost, label, jobs.length)) return;
    }

    btn.disabled = true;
    addPassageBtn.disabled = true;
    clearPassagesBtn.disabled = true;
    loadingEl.classList.add("on");
    resultEl.innerHTML = "";
    printBtn.style.display = "none";
    saveBtn.style.display = "none";
    docxBtn.style.display = "none";
    syncFloatPrint();

    // 완성될 때마다 화면에 붙인다. 도중에 멈추거나 창을 닫아도 그때까지 만든
    // 세트는 남아 인쇄까지 할 수 있다 (여기까지 쓴 토큰을 버리지 않기 위해).
    const showFooter = () => {
      if (!resultEl.querySelector(".qz-footer")) {
        resultEl.insertAdjacentHTML("beforeend", `<footer class="qz-footer">${esc(footer)} · 자동 생성</footer>`);
      }
      printBtn.style.display = "inline-flex";
      saveBtn.style.display = "inline-flex";
      docxBtn.style.display = "inline-flex";
      syncFloatPrint();
    };
    const append = (html) => {
      const foot = resultEl.querySelector(".qz-footer");
      if (foot) foot.remove();
      resultEl.insertAdjacentHTML("beforeend", html);
    };

    const total = jobs.length;
    const chunks = chunkTypes(picked);
    // 전체 진행 칸 수 = 지문 × 변형 × 청크. 어디까지 왔는지 보여 주기 위한 값.
    const steps = total * vars.length * chunks.length;
    let step = 0;
    let okCount = 0;
    let stopped = false;
    let stopErr = null;
    const entries = []; // 저장 기능이 쓸 {job, label, set, total} — 성공한 세트만

    for (let i = 0; i < total && !stopped; i++) {
      const job = jobs[i];

      if (job.text.length < 20) {
        append(buildErrorHtml(job, total, "지문이 너무 짧습니다 (20자 이상 입력).", "", prefix));
        continue;
      }

      for (let v = 0; v < vars.length && !stopped; v++) {
        const variation = vars[v];
        const label = vars.length > 1 ? VARIATION_LABELS[variation] : "";
        const who = total > 1 || job.named ? job.name : "지문";
        const tag = label ? `${who} · ${label}` : who;

        // ① 변형본 확정 — 유형을 나눠 여러 번 호출해도 모든 문항이 같은 지문을 쓰도록
        //    문제를 만들기 전에 지문을 한 번만 다시 쓴다.
        let source = job.text;
        let varied = [];
        if (variation !== "verbatim") {
          loadingTextEl.textContent = `${tag} 지문 변형본 만드는 중…`;
          try {
            const r = await postJson(
              "/api/reword",
              { passage: job.text, variation },
              "지문 변형에 실패했습니다."
            );
            source = (r.passage || "").trim() || job.text;
            varied = Array.isArray(r.variations) ? r.variations : [];
          } catch (err) {
            append(buildErrorHtml(job, total, err.message || String(err), label, prefix));
            if (isQuotaError(err)) {
              stopped = true;
              stopErr = err;
              const left = steps - step;
              if (left > 0) append(quotaStopHtml(left, err, "작업"));
            }
            step += chunks.length;
            continue;
          }
        }

        // ② 문제 생성 — 확정된 지문을 '원문 그대로'로 넘긴다. 변형은 ①에서 이미 끝났다.
        const questions = [];
        const failed = [];
        for (const group of chunks) {
          step++;
          loadingTextEl.textContent =
            steps > 1
              ? `${tag} 문제 만드는 중… (${step}/${steps}) — ${groupLabel(group)}`
              : "AI가 문제를 만들고 있습니다…";
          try {
            const data = await postJson(
              "/api/quiz",
              {
                passage: source,
                types: group,   // [{id, count}] — 유형별 문항 수가 그대로 실린다
                variation: "verbatim",
                // 어법 계열 유형이 섞여 있을 때만 서버가 쓴다. 비어 있으면 지금까지대로
                // AI가 지문에 맞춰 알아서 문법 포인트를 고른다.
                targetGrammar: grammarEl.value,
              },
              "문제 생성에 실패했습니다."
            );
            if (Array.isArray(data.questions)) questions.push(...data.questions);
          } catch (err) {
            failed.push({ group, msg: err.message || String(err) });
            // 한도 소진·Pro 불가는 기다려도 안 풀린다 — 남은 작업을 시도하지 않는다
            if (isQuotaError(err)) {
              stopped = true;
              stopErr = err;
              break;
            }
          }
        }

        // 일부 청크가 실패해도 성공한 문항은 살려 낸다 (그만큼 토큰을 이미 썼다)
        if (questions.length) {
          // 무작위 모드 — 받아온 문항을 섞는다. 세트마다 다시 섞이고, 문제지 번호와
          // 정답표 번호는 buildQuizHtml이 섞인 순서로 함께 매기므로 어긋나지 않는다.
          const set = { questions, variations: varied };
          if (isRandom()) {
            set.questions = seededShuffle(set.questions, Math.floor(Math.random() * 1e9));
          }
          append(buildQuizHtml(set, job, total, prefix, label));
          entries.push({ job, label, set, total });
          okCount++;
          showFooter();
        }
        failed.forEach((f) => {
          append(buildErrorHtml(job, total, `${groupLabel(f.group)} — ${f.msg}`, label, prefix));
        });
        if (stopped && stopErr) {
          const left = steps - step;
          if (left > 0) append(quotaStopHtml(left, stopErr, "작업"));
        }
      }
    }

    if (okCount) showFooter();
    lastEntries = entries; // 저장 버튼이 이 값을 그대로 payload로 보낸다
    syncFloatPrint();
    loadingEl.classList.remove("on");
    btn.disabled = false;
    addPassageBtn.disabled = false;
    clearPassagesBtn.disabled = false;
    resultEl.scrollIntoView({ behavior: "smooth", block: "start" });
    refreshTokenDisplay();
    // 문제 탭에는 '직접 수정'이 없다 — 고칠 곳이 있으면 다시 만들라고 안내한다
    if (okCount) {
      const made = resultEl.querySelectorAll(".qz-card").length;
      const kind = prefix === "mcq" ? "객관식 문제" : "주관식 문제";
      showDoneGuide(`${kind} ${made}문항`, false);
    }
  }

  // "내 저장함"에서 불러온 문제 세트를 다시 그린다 — API를 다시 부르지 않고
  // 저장해 둔 원본 set(질문·변형 정보)을 그때와 같은 buildQuizHtml로 재사용한다.
  function renderQuizEntries(entries) {
    resultEl.innerHTML = "";
    entries.forEach(({ job, label, set, total }) => {
      resultEl.insertAdjacentHTML("beforeend", buildQuizHtml(set, job, total, prefix, label));
    });
    if (entries.length) {
      resultEl.insertAdjacentHTML("beforeend", `<footer class="qz-footer">${esc(footer)} · 자동 생성</footer>`);
    }
    printBtn.style.display = entries.length ? "inline-flex" : "none";
    saveBtn.style.display = entries.length ? "inline-flex" : "none";
    docxBtn.style.display = entries.length ? "inline-flex" : "none";
    lastEntries = entries;
    syncFloatPrint();
    // 비우는 호출일 때는 스크롤하지 않는다 — 빈 자리로 끌려가지 않게
    if (entries.length) resultEl.scrollIntoView({ behavior: "smooth", block: "start" });
  }

  function getQuizSettings() {
    const items = pickedItems();
    return {
      // types는 예전 저장본과 같은 모양(유형 이름 배열)으로 계속 남긴다 —
      // 개수는 counts에 따로 담아, 옛 저장본을 불러와도 그대로 동작하게 한다.
      types: items.map((it) => it.id),
      counts: Object.fromEntries(items.map((it) => [it.id, it.count])),
      order: orderEl.value,
      variation: variationEl ? variationEl.values : [],
    };
  }
  function applyQuizSettings(settings) {
    if (!settings) return;
    const wanted = new Set(settings.types || []);
    const counts = settings.counts || {}; // 옛 저장본에는 없다 → 전부 1문항
    gridEl.querySelectorAll(".type-chip").forEach((chip) => {
      const id = chip.dataset.id;
      chip.querySelector("input").checked = wanted.has(id);
      // 불러오기는 저장해 둔 개수를 그대로 되살린다. checked를 직접 넣어 change가
      // 안 나므로 위의 '켜면 1로' 규칙이 끼어들지 않는다.
      setCount(chip, Number(counts[id]) || 1);
    });
    syncAll();
    syncTypeChips();
    if (settings.order) {
      orderEl.value = settings.order;
      updateOrderHint();
    }
    if (variationEl && Array.isArray(settings.variation) && settings.variation.length) {
      variationEl.values = settings.variation;
      updateVariationHint();
    }
  }

  TAB_SAVE[prefix] = {
    saveBtn,
    getPayload: () => ({
      passages: passageMgr.getJobs(),
      settings: getQuizSettings(),
      entries: lastEntries,
    }),
    applyPayload: (payload) => {
      passageMgr.setJobs(payload.passages || []);
      applyQuizSettings(payload.settings);
      renderQuizEntries(payload.entries || []);
    },
    clearResults: () => renderQuizEntries([]),
  };

  btn.addEventListener("click", generate);
  printBtn.addEventListener("click", () => printDoc(() => passageBasedName(docName)));

  // 주관식 해설지는 '정답'만 싣는다(buildQuizHtml이 해설 열을 빼는 것과 같은 기준)
  docxBtn.addEventListener("click", () =>
    downloadDocx({
      resultEl,
      name: passageBasedName(docName),
      answerHeading: prefix === "saq" ? "정답" : "정답 및 해설",
      btn: docxBtn,
      errorEl,
    })
  );

  // 기출 유형 분석 탭이 분석 결과대로 이 탭의 유형 칸을 채울 수 있게 손잡이를 내준다.
  // 문제 생성 자체는 여기 있는 것을 그대로 쓴다 — 만드는 길이 둘이 되면 한쪽만 고쳐져
  // 조용히 어긋난다(요금 계산도 이 안에 있다).
  return {
    setTypes(items) {
      gridEl.querySelectorAll(".type-chip").forEach((chip) => {
        const want = (items || []).find((it) => it.id === chip.dataset.id);
        chip.querySelector("input").checked = !!want;
        if (want) setCount(chip, want.count);
      });
      syncAll();
      syncTypeChips();
      updateCostHint();
    },
  };
}

const QUIZ_TABS = {
  mcq: setupQuizTab({ prefix: "mcq", types: MCQ_TYPES, footer: "수능형 객관식 문제" }),
  saq: setupQuizTab({ prefix: "saq", types: SAQ_TYPES, footer: "서술형·단답형 문제" }),
};

// 한 문항의 '정답' 표기를 형식에 맞게 만든다
// (객관식=①, 서술형=문장, OX=O/X 나열, 선택형=고른 낱말, 오류찾기=틀린말→바른말)
function quizAnswerLabel(q) {
  const fmt = q.format || "mc";
  if (fmt === "write" || fmt === "short") return esc(q.answerText || "");
  if (fmt === "tf") {
    return (q.tfItems || [])
      .map((it, i) => `(${i + 1}) ${it.isTrue ? "O" : "X"}`)
      .join("  ");
  }
  if (fmt === "pick") {
    // 지문의 [정답|오답] 마크업에서 정답만 순서대로 뽑는다
    return renderChoices(q.passageHtml || "", q.no || 1).answers.join(" / ");
  }
  if (fmt === "verb" || fmt === "fill") {
    // 지문의 (힌트|정답) 마크업에서 정답만 순서대로 뽑는다 (워크북5와 같은 표기).
    // 동사형 쓰기는 힌트가 동사 원형, 빈칸 쓰기는 힌트가 첫 철자일 뿐 구조가 같다.
    return renderVerbForms(q.passageHtml || "").answers
      .map((a, i) => `(${i + 1}) ${a}`)
      .join("　");
  }
  if (fmt === "find" || fmt === "gloss") {
    const list = fmt === "gloss" ? q.glossItems : q.findItems;
    return (list || [])
      .filter((it) => it && it.en)
      .map((it, i) => `(${i + 1}) ${esc(it.en)}`)
      .join("　");
  }
  if (fmt === "fix") {
    return (q.fixes || [])
      .filter((f) => f && f.wrong)
      .map((f, i) => `(${i + 1}) ${f.wrong} → ${f.right}`)
      .join("　");
  }
  return CIRCLED[(q.answer || 1) - 1] || esc(q.answer);
}

// 문항 본체(지문·선택지·답란)를 형식별로 렌더
function quizBodyHtml(q) {
  const fmt = q.format || "mc";

  /* 지문을 읽고 답란에 직접 쓰는 주관식 — '무관한 문장 쓰기'와 '요약문 완성'이 쓴다.
     write(서술형배열)와 따로 두는 이유: write는 answerText를 낱말로 흩어 <보기>를 만드는데,
     이 둘은 정답을 흩어 보여 주면 안 된다(무관한 문장은 지문 안에 이미 있고, 요약문 완성은
     AI가 만든 <보기>가 passageHtml에 들어 있다).
     답란을 두 줄 두는 것은 무관한 문장이 한 문장을 통째로 옮겨 적는 유형이라서다. */
  if (fmt === "short") {
    return `
      <div class="qz-passage">${safeHTML(q.passageHtml)}</div>
      <div class="qz-writeline"></div>
      <div class="qz-writeline"></div>`;
  }

  if (fmt === "write") {
    /* 서술형 배열 — 지문을 그대로 보여 주되, 배열할 문장 한 개만 한글 해석으로 바뀌어
       밑줄+굵게 표시되어 있다. 학생은 앞뒤 영어 문맥을 읽고 그 자리에 들어갈 영어를
       <보기>의 낱말로 다시 만든다. 내신 서술형 시험지가 쓰는 방식이다. */
    const scrambled = scrambleSentence(q.answerText || "", q.no || 1);
    return `
      <div class="qz-passage">${safeHTML(q.passageHtml)}</div>
      <div class="qz-scramble"><span class="qz-scramble-tag">&lt;보기&gt;</span>${scrambled}</div>
      <div class="qz-writeline"></div>
      <div class="qz-writeline"></div>`;
  }

  if (fmt === "pick") {
    // 어휘·어법 선택형 — [정답|오답]을 [ A / B ]로 섞어 보여주고 고른 낱말을 쓰게 한다
    const { html } = renderChoices(q.passageHtml || "", q.no || 1);
    return `
      <div class="qz-passage">${html}</div>
      <div class="qz-writeline"></div>
      <div class="qz-writeline"></div>`;
  }

  if (fmt === "verb" || fmt === "fill") {
    /* 동사형 쓰기 · 빈칸 쓰기 — 지문에 심은 (힌트|정답)을 학생이 볼 모양으로 바꾸고,
       아래에 번호별 답란을 둔다.

       워크북5의 renderVerbForms를 그대로 쓰지 않는 이유가 둘 있다.
       ① 워크북은 문장 하나에 답란이 하나라 번호가 필요 없지만, 여기서는 지문 하나에
          빈칸이 여럿이고 답란도 (1)(2)(3)으로 나뉜다. 지문 쪽에 번호가 없으면 어느
          빈칸이 몇 번인지 알 수 없다.
       ② 빈칸 쓰기는 힌트 없이 밑줄만 둔다. 예전에는 첫 철자를 주었는데, 그것을 "(a)"로
          찍으면 내신 시험지에서 빈칸 이름으로 쓰는 (A)(B)(C)처럼 보여 힌트로 읽히지
          않았다. 지금은 아예 주지 않으므로 밑줄만 그린다.
          (힌트 자리가 비어 있지 않은 예전 저장물은 그 글자를 밑줄 앞에 그대로 보여 준다) */
    const answers = [];
    const html = esc(q.passageHtml || "").replace(
      /\(([^()|]*)\|([^()|]*)\)/g,
      (_, hint, ans) => {
        answers.push(ans.trim());
        const n = answers.length;
        const h = hint.trim();
        return fmt === "fill"
          ? `<b class="qz-blankno">(${n})</b>&nbsp;<span class="qz-fillhint">${h}` +
            `<span class="qz-fillrule${h ? "" : " wide"}"></span></span>`
          : `<b class="qz-blankno">(${n})</b>&nbsp;<b class="wb-paren">(${h})</b>`;
      }
    );
    const lines = answers
      .map((_, i) => `<div class="qz-fixline">(${i + 1}) ${wbBlank(220)}</div>`)
      .join("");
    return `
      <div class="qz-passage">${html}</div>
      ${lines}`;
  }

  if (fmt === "find") {
    /* 표현 찾아 쓰기 — 지문은 손대지 않고(정답이 그 안에 그대로 있어야 학생이 찾는다)
       아래에 우리말 목록과 답란을 세운다. 지문에 표시를 심는 다른 서답형과 유일하게
       다른 모양이라 렌더러를 따로 둔다. */
    const items = (q.findItems || []).filter((it) => it && it.ko);
    const lines = items
      .map((it, i) =>
        `<div class="qz-findline"><span class="qz-findko">(${i + 1}) ${esc(it.ko)}</span>` +
        `<span class="qz-findarrow">→</span>${wbBlank(240)}</div>`)
      .join("");
    return `
      <div class="qz-passage">${safeHTML(q.passageHtml)}</div>
      ${lines}`;
  }

  if (fmt === "gloss") {
    /* 영영풀이 쓰기 — 표현 찾아 쓰기와 같은 원리(지문은 그대로, 목록만 따로)이지만
       단서가 우리말 한 줄이 아니라 영어 정의라 한 줄에 다 안 들어가는 일이 잦다.
       그래서 옆으로 붙이지 않고 정의를 한 줄로 두고 답란을 그 아래에 둔다 — 정의가
       길어도 줄바꿈이 자연스럽고, 2단 인쇄에서도 폭 계산을 따로 손볼 일이 없다. */
    const items = (q.glossItems || []).filter((it) => it && it.def);
    const lines = items
      .map((it, i) =>
        `<div class="qz-glossitem">` +
        `<div class="qz-glossdef"><span class="qz-num">(${i + 1})</span> ${esc(it.def)}</div>` +
        `<div class="qz-writeline"></div></div>`)
      .join("");
    return `
      <div class="qz-passage">${safeHTML(q.passageHtml)}</div>
      ${lines}`;
  }

  if (fmt === "fix") {
    // 틀린 어휘·어법 찾기 — 심어둔 오답에 밑줄, 아래에 '틀린말 → 바른말' 줄
    const fixes = (q.fixes || []).filter((f) => f && f.wrong);
    let text = esc(q.passageHtml || "");
    fixes.forEach((f) => {
      const w = esc(f.wrong).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
      const re = new RegExp(`(^|[^\\w<>])(${w})(?![\\w>])`);
      text = text.replace(re, (m, pre, word) => `${pre}<u>${word}</u>`);
    });
    const lines = fixes
      .map((_, i) => `<div class="qz-fixline">(${i + 1}) ${wbBlank(150)} → ${wbBlank(150)}</div>`)
      .join("");
    return `
      <div class="qz-passage">${text}</div>
      ${lines}`;
  }

  if (fmt === "tf") {
    // O/X 진위판단 — 진술마다 괄호에 O/X 기입
    const items = (q.tfItems || [])
      .map(
        (it, i) => `
        <li><span class="qz-num">(${i + 1})</span>
            <span class="qz-choice-text">${safeHTML(it.text)}</span>
            <span class="qz-ox">(　　)</span></li>`
      )
      .join("");
    return `
      <div class="qz-passage">${safeHTML(q.passageHtml)}</div>
      <ul class="qz-choices qz-tf">${items}</ul>`;
  }

  // 어법·어휘는 보기가 ["①"…"⑤"] 뿐이다 — 지문의 밑줄 친 부분이 곧 보기이므로,
  // 아래에 같은 기호를 한 번 더 나열하면 지면만 먹고 무엇을 고르는지 헷갈린다.
  const rawChoices = q.choices || [];
  const markerOnly =
    rawChoices.length > 0 &&
    rawChoices.every((c) => CIRCLED.includes(String(c == null ? "" : c).trim()));
  if (markerOnly) {
    return `<div class="qz-passage">${safeHTML(q.passageHtml)}</div>`;
  }

  // 객관식 5지선다
  const choicesHtml = (q.choices || [])
    .map(
      (c, i) => `
      <li><span class="qz-num">${CIRCLED[i] || i + 1}</span><span class="qz-choice-text">${safeHTML(c)}</span></li>`
    )
    .join("");
  return `
    <div class="qz-passage">${safeHTML(q.passageHtml)}</div>
    <ul class="qz-choices">${choicesHtml}</ul>`;
}

// 지문에서 '변형된 낱말'에 표시를 입힌다.
// <v>로 감싸는 방식인 이유: 화면에서는 형광 배경이 보여 어디를 손댔는지 한눈에
// 확인할 수 있고, 인쇄 CSS가 그 배경만 지우므로 시험지에는 평범한 본문으로 찍힌다.
// 낱말 자체는 어느 쪽에서도 사라지지 않는다.
function markVariations(html, variations) {
  const list = (variations || []).filter((v) => v && v.to && v.from);
  if (!html || !list.length) return html;

  const box = document.createElement("div");
  box.innerHTML = html;

  // 긴 표현을 먼저 매칭해야 짧은 낱말이 긴 표현을 조각내지 않는다
  const sorted = list.slice().sort((a, b) => b.to.length - a.to.length);
  const origOf = new Map(sorted.map((v) => [v.to.toLowerCase(), v.from]));
  const alts = sorted
    .map((v) => v.to.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"))
    .join("|");
  // \b 대신 영숫자 전후 확인 — 변형 낱말에 어퍼스트로피·하이픈이 섞여도 정확히 끊긴다
  const re = new RegExp(`(?<![A-Za-z0-9])(?:${alts})(?![A-Za-z0-9])`, "gi");

  const walker = document.createTreeWalker(box, NodeFilter.SHOW_TEXT);
  const targets = [];
  for (let n = walker.nextNode(); n; n = walker.nextNode()) {
    re.lastIndex = 0;
    if (re.test(n.nodeValue)) targets.push(n);
  }

  targets.forEach((node) => {
    const frag = document.createDocumentFragment();
    let last = 0;
    node.nodeValue.replace(re, (m, offset) => {
      if (offset > last) frag.appendChild(document.createTextNode(node.nodeValue.slice(last, offset)));
      const mark = document.createElement("v");
      const from = origOf.get(m.toLowerCase());
      if (from) mark.title = `원문: ${from}`;
      mark.textContent = m;
      frag.appendChild(mark);
      last = offset + m.length;
      return m;
    });
    if (last < node.nodeValue.length) frag.appendChild(document.createTextNode(node.nodeValue.slice(last)));
    node.parentNode.replaceChild(frag, node);
  });

  return box.innerHTML;
}

// 문제 카드 + 정답/해설(화면: 토글, 인쇄: 항상 별도 섹션) HTML 생성
// kind: "mcq" | "saq" — 주관식 해설지에는 해설 열을 넣지 않는다(정답만).
// sheetHead: 시험지 머리글 HTML(기출 탭 전용, 선택). 섹션 '안'에 넣는 이유 —
//   인쇄 CSS가 .passage-block마다 쪽을 나누므로, 밖에 두면 머리글만 있는 빈 쪽이 생긴다.
function buildQuizHtml(d, job, total, kind, label, sheetHead) {
  const parts = [];
  parts.push(`<section class="passage-block qz-block">`);
  if (sheetHead) parts.push(sheetHead);
  parts.push(passageBanner(job, total, label));

  // 문항 카드는 별도 래퍼에 담는다 — 인쇄할 때 이 래퍼에만 2단 조판을 적용하고
  // '정답 및 해설' 표는 단 나눔 없이 전체 폭을 쓰게 하기 위해서다.
  parts.push(`<div class="qz-cards">`);

  // 번호는 AI가 준 q.no 대신 '실제 출제(출력) 순서'로 다시 매긴다.
  // 문항이 유형별로 묶여 나오므로, 지면에 찍히는 순서와 번호가 어긋나지 않게 한다.
  (d.questions || []).forEach((q, i) => {
    parts.push(`
      <div class="qz-card">
        <div class="qz-head"><span class="qz-no">${i + 1}</span><span class="qz-type">${esc(q.type)}</span></div>
        <div class="qz-instruction">${safeHTML(q.instruction)}</div>
        ${markVariations(quizBodyHtml(q), d.variations)}
        <button type="button" class="qz-reveal-btn">정답·해설 보기</button>
        <div class="qz-answer-box">
          <b>정답 ${quizAnswerLabel(q)}</b><br>${safeHTML(q.explanation)}
        </div>
      </div>
    `);
  });

  parts.push(`</div>`); // .qz-cards

  // 정답 및 해설 — 화면 토글과 별개로 인쇄물에는 항상 별도 페이지로 포함
  if (d.questions && d.questions.length) {
    // 해설이 하나도 없으면 '해설' 열 자체를 만들지 않는다 — 머리글만 있고 내용은
    // 텅 빈 열이 지면을 먹고, 지문마다 표 모양이 달라 보이는 것을 막는다.
    // 일부만 빠진 경우에는 열을 유지하되 빈 칸을 '—'로 표시해 누락이 드러나게 한다.
    const hasExp = (q) =>
      String(q.explanation || "").replace(/<[^>]*>/g, "").trim().length > 0;
    // 주관식 해설지는 '정답'만 싣는다 (해설 열 제외)
    const anyExp = kind !== "saq" && d.questions.some(hasExp);
    const expHead = anyExp ? `<th>해설</th>` : "";
    const expCell = (q) =>
      anyExp ? `<td>${hasExp(q) ? safeHTML(q.explanation) : "—"}</td>` : "";

    const rows = d.questions
      .map(
        (q, i) => `
      <tr>
        <td>${i + 1}</td>
        <td>${esc(q.type)}</td>
        <td>${quizAnswerLabel(q)}</td>${expCell(q)}
      </tr>`
      )
      .join("");
    parts.push(`
      <h3 class="section page-break"><span class="num">📌</span> ${anyExp ? "정답 및 해설" : "정답"}</h3>
      <div class="table-wrap"><table class="answerkey">
        <thead><tr><th>번호</th><th>유형</th><th>정답</th>${expHead}</tr></thead>
        <tbody>${rows}</tbody>
      </table></div>
    `);
  }

  // 지문 변형 내역 — 어떤 낱말을 무엇으로 바꿨는지. 문제지의 형광 표시는 인쇄되지
  // 않지만 이 표는 인쇄된다. 선생님이 답지를 들고 확인하는 자료이기 때문이다.
  const varied = (d.variations || []).filter((v) => v && v.from && v.to);
  if (varied.length) {
    const rows = varied
      .map(
        (v, i) => `
      <tr><td>${i + 1}</td><td>${esc(v.from)}</td><td>${esc(v.to)}</td></tr>`
      )
      .join("");
    parts.push(`
      <h3 class="section"><span class="num">✏️</span> 지문 변형 내역 <span class="qz-varied-count">${varied.length}곳</span></h3>
      <div class="table-wrap"><table class="answerkey variedkey">
        <thead><tr><th>번호</th><th>원문</th><th>변형</th></tr></thead>
        <tbody>${rows}</tbody>
      </table></div>
    `);
  }

  parts.push(`</section>`);
  return parts.join("");
}

// 정답/해설 토글 — 문제 탭·워크북 탭 어디에 렌더되든 동작하도록 document에 위임
document.addEventListener("click", (e) => {
  const btn = e.target.closest(".qz-reveal-btn");
  if (!btn) return;
  const box = btn.nextElementSibling;
  if (!box) return;
  const showing = box.classList.toggle("show");
  btn.textContent = showing ? "정답·해설 숨기기" : "정답·해설 보기";
});

/* ══════════════════════════ 워크북 제작 탭 (단계별 학습지) ══════════════════════════ */

// 지원 단계 — 참고 자료(10단계 WORKBOOK)의 번호·명칭·지시문을 그대로 쓰되,
// 1(지문 연습하기)·2(빈칸 완성하기·우리말)는 제외한 3~10단계만 만든다.
const WB_STAGES = [
  { id: 3,  name: "빈칸 완성하기(영문)",   guide: "우리말 해석을 읽고 영문의 빈칸을 완성해 보세요.", def: true },
  { id: 4,  name: "해석 연습하기",         guide: "문장 전체의 자연스러운 해석을 써 보세요.", def: true },
  { id: 5,  name: "동사형 연습하기",       guide: "괄호 안에 주어진 단어를 알맞게 고쳐 쓰세요.", def: true },
  { id: 6,  name: "어법·어휘 고르기",      guide: "괄호 안에서 옳은 어법과 어휘를 골라 보세요.", def: true },
  { id: 7,  name: "어색한 곳 찾기",        guide: "밑줄 친 부분 중 어법상 어색한 것을 세 개 찾아 알맞게 고쳐 쓰세요.", def: true },
  { id: 8,  name: "순서 배열하기",         guide: "우리말과 같은 뜻이 되도록 주어진 단어를 바르게 배열해 보세요.", def: true },
  { id: 9,  name: "문단 배열하기",         guide: "다음 문단을 흐름상 알맞게 배열해 보세요.", def: true },
  { id: 10, name: "영작 연습하기",         guide: "우리말과 같은 뜻이 되도록 주어진 단어를 순서대로 사용하여 영작하세요.", def: true },
];

const wbStageGridEl = $("wbStageGrid");
WB_STAGES.forEach((s) => {
  const label = document.createElement("label");
  // '빈칸 완성하기(우리말)'처럼 괄호 설명이 붙은 이름은 설명을 아래 줄로 내려 표시한다
  const split = s.name.match(/^(.*?)\s*(\([^)]*\))$/);
  const nameHtml = split
    ? `<span class="opt-text">${esc(split[1])}<span class="opt-sub">${esc(split[2])}</span></span>`
    : `<span>${esc(s.name)}</span>`;
  if (split) label.classList.add("opt-2line");
  label.innerHTML =
    `<input type="checkbox" value="${s.id}" ${s.def ? "checked" : ""}>` +
    `<span class="type-no"></span>${nameHtml}`;
  wbStageGridEl.appendChild(label);
});

// 체크한 단계에만 1번부터 번호를 붙인다. WB_STAGES의 id는 렌더 분기를 고르는
// 내부 키이자 참고 자료의 단계 번호이고, 화면·인쇄물에 찍히는 번호는 '선택 순서'다.
function renumberWbStages() {
  let n = 0;
  wbStageGridEl.querySelectorAll("label").forEach((label) => {
    const on = label.querySelector("input").checked;
    label.querySelector(".type-no").textContent = on ? `${++n}.` : "";
    label.classList.toggle("picked", on);
  });
}
// 전체 선택 / 해제 — 일부만 선택된 상태는 '중간' 표시 (문제 제작 탭과 동일)
const wbStageAllEl = $("wbStageAll");
function syncWbAll() {
  const boxes = [...wbStageGridEl.querySelectorAll("input")];
  const on = boxes.filter((b) => b.checked).length;
  wbStageAllEl.checked = on === boxes.length;
  wbStageAllEl.indeterminate = on > 0 && on < boxes.length;
}
wbStageAllEl.addEventListener("change", () => {
  const check = wbStageAllEl.checked;
  wbStageGridEl.querySelectorAll("input").forEach((b) => (b.checked = check));
  syncWbAll();
  renumberWbStages();
  updateWbCostHint();
});
/* 워크북 값 — 고른 단계 수 × 단계 단가, 상한까지. server.py의 _workbook_cost와 같은 식이다.
   실제 청구는 언제나 서버가 다시 계산하고, 여기 값은 미리 보여 주기 위한 것이다. */
function workbookCost(stageCount) {
  if (!PRICING || !stageCount) return 0;
  const per = PRICING.workbookStage || 0;
  const max = PRICING.workbookMax || 0;
  const sum = per * stageCount;
  return max ? Math.min(sum, max) : sum;
}

// 단계를 켜고 끌 때마다 지문 1개당 예상 금액을 바로 보여 준다 (문제 제작 탭과 같은 방식).
// 지문 수는 이 탭 밖에서 바뀌므로 '지문 1개당'으로 적고, 최종 금액은 확인창이 보여 준다.
const wbCostHintEl = $("wbCostHint");
function updateWbCostHint() {
  if (!wbCostHintEl) return;
  const n = wbStageGridEl.querySelectorAll("input:checked").length;
  if (!n) {
    wbCostHintEl.textContent = "";
    return;
  }
  const parts = [`선택 <b>${n}단계</b>`];
  if (PRICING) {
    const cost = workbookCost(n);
    parts.push(`— 지문 1개당 <b>${cost.toLocaleString()}원</b>`);
    // 상한에 걸렸으면 왜 단계 수 × 단가와 다른지 밝힌다
    const per = PRICING.workbookStage || 0;
    if (per && cost < per * n) parts.push(`<span class="cost-hint-note">(전체 선택 상한)</span>`);
  }
  wbCostHintEl.innerHTML = parts.join(" ");
}

wbStageGridEl.addEventListener("change", () => {
  syncWbAll();
  renumberWbStages();
  updateWbCostHint();
});
syncWbAll();
renumberWbStages();
onPricingReady(updateWbCostHint);

const wbBtn = $("wbBtn");
const wbErrorEl = $("wbError");
const wbLoadingEl = $("wbLoading");
const wbLoadingTextEl = $("wbLoadingText");
const wbTitleEl = $("wbTitle");
const wbExamEl = $("wbExam");
const wbAnswerChk = $("wbAnswerChk");
const wbAnswerBookChk = $("wbAnswerBookChk");
const workbookDocEl = $("workbookDoc");
const workbookPrintBtn = $("workbookPrintBtn");
const wbAnswerPrintBtn = $("wbAnswerPrintBtn");
const workbookSaveBtn = $("workbookSaveBtn");
const workbookDocxBtn = $("workbookDocxBtn");
let lastWorkbookEntries = []; // 저장/불러오기용 — {job, data} 성공한 것만

// 머리말(시험명)은 다음에 열 때도 그대로 쓰도록 기억해 둔다
const WB_EXAM_STORE = "gemini_wb_exam";
if (wbExamEl) {
  wbExamEl.value = localStorage.getItem(WB_EXAM_STORE) || "";
  wbExamEl.addEventListener("change", () =>
    localStorage.setItem(WB_EXAM_STORE, wbExamEl.value.trim())
  );
}

// 정답 표시 토글 — 다시 그리지 않고 클래스만 바꿔서 (섞인 보기·순서가 유지되도록)
const WB_ANSWER_STORE = "gemini_wb_answer";
wbAnswerChk.checked = localStorage.getItem(WB_ANSWER_STORE) === "1";
function applyAnswerVisibility() {
  workbookDocEl.classList.toggle("show-answers", wbAnswerChk.checked);
}
wbAnswerChk.addEventListener("change", () => {
  localStorage.setItem(WB_ANSWER_STORE, wbAnswerChk.checked ? "1" : "0");
  applyAnswerVisibility();
});

wbBtn.addEventListener("click", generateWorkbook);
workbookPrintBtn.addEventListener("click", () => printDoc(() => titledName("워크북", "wbTitle")));

/* 워크북 워드 내보내기.
   '정답 표시'가 꺼져 있으면 .wb-ans를 덜어 내고 보낸다 — 이 토글은 다시 그리지 않고
   CSS 클래스(show-answers)만 바꾸는 방식이라, 정답이 화면에 안 보일 뿐 HTML에는 늘
   들어 있다. 그대로 보내면 학생용으로 뽑았는데 정답이 찍혀 나온다.
   뒤쪽 '정답 모음' 별지(.wb-answerbook)는 그 체크박스가 만들 때 결정하므로 그대로 둔다. */
workbookDocxBtn.addEventListener("click", () =>
  downloadDocx({
    resultEl: workbookDocEl,
    name: titledName("워크북", "wbTitle"),
    answerHeading: "정답",
    btn: workbookDocxBtn,
    errorEl: wbErrorEl,
    strip: wbAnswerChk.checked ? [] : [".wb-ans"],
    // 워크북만 1단이다 — 단계마다 답을 적는 칸이 있어 2단으로 좁히면 쓸 자리가 모자란다
    columns: 1,
  })
);

// 답지만 — 문제 내용을 감추고 뒤쪽 '정답' 모음만 지면에 올린다.
// 다시 그리지 않고 클래스만 바꾸므로, 섞인 보기·순서가 학생용 문제지와 정확히 일치한다.
// '정답 표시' 체크와 무관하게 항상 정답이 나오고, 인쇄가 끝나면 원래 화면으로 돌아온다.
wbAnswerPrintBtn.addEventListener("click", () =>
  printDoc(() => titledName("워크북_답지", "wbTitle"), {
    before: () => workbookDocEl.classList.add("answers-only"),
    after: () => workbookDocEl.classList.remove("answers-only"),
  })
);

async function generateWorkbook() {
  wbErrorEl.textContent = "";
  const jobs = passageMgr.getJobs();
  if (!jobs.length) {
    wbErrorEl.textContent = "워크북을 만들 영어 지문을 입력하세요.";
    return;
  }
  const stages = [...wbStageGridEl.querySelectorAll("input:checked")].map((i) => parseInt(i.value, 10));
  if (!stages.length) {
    wbErrorEl.textContent = "포함할 단계를 하나 이상 선택하세요.";
    return;
  }
  if (!costConfirmed(billableJobCount() * workbookCost(stages.length),
                     "워크북을 만듭니다.", jobs.length)) {
    return;
  }

  wbBtn.disabled = true;
  addPassageBtn.disabled = true;
  clearPassagesBtn.disabled = true;
  wbLoadingEl.classList.add("on");
  workbookDocEl.innerHTML = "";
  workbookPrintBtn.style.display = "none";
  wbAnswerPrintBtn.style.display = "none";
  workbookSaveBtn.style.display = "none";
  workbookDocxBtn.style.display = "none";
  syncFloatPrint();

  const total = jobs.length;
  let okCount = 0;
  const htmlParts = [];
  const answerParts = [];
  const entries = []; // 저장 기능이 쓸 {job, data} — 성공한 것만
  const title = wbTitleEl.value.trim();
  const exam = wbExamEl ? wbExamEl.value.trim() : "";
  if (title) {
    htmlParts.push(`
      <div class="wb-cover">
        <h1>${esc(title)}</h1>
        ${exam ? `<div class="wb-exam">${esc(exam)}</div>` : ""}
        <div class="wb-date">${esc(new Date().toLocaleDateString("ko-KR"))}</div>
      </div>`);
  }

  for (let i = 0; i < total; i++) {
    const job = jobs[i];
    wbLoadingTextEl.textContent =
      total > 1
        ? `${job.name} 워크북 만드는 중… (${i + 1}/${total})`
        : "AI가 워크북을 만들고 있습니다… (지문 길이에 따라 40~120초 걸릴 수 있어요)";

    if (job.text.length < 20) {
      htmlParts.push(buildErrorHtml(job, total, "지문이 너무 짧습니다 (20자 이상 입력)."));
      continue;
    }

    try {
      const data = await postJson(
        "/api/workbook",
        // stages는 요금 계산에 쓰인다 — 서버가 단계 수로 값을 매기므로 반드시 보낸다.
        // (만들어지는 내용은 8단계분이 통째로 오고, 고른 것만 화면이 그린다.)
        { passage: job.text, stages },
        "워크북 생성에 실패했습니다."
      );
      const built = buildWorkbookHtml(data, stages, job, total, exam);
      htmlParts.push(built.html);
      answerParts.push(built.answerHtml);
      entries.push({ job, data });
      okCount++;
    } catch (err) {
      const msg = err.message || String(err);
      htmlParts.push(buildErrorHtml(job, total, msg));
      // 한도 소진은 기다려도 안 풀린다 — 남은 지문을 시도하지 않고 즉시 멈춘다
      if (isQuotaError(err)) {
        const left = total - (i + 1);
        if (left > 0) htmlParts.push(quotaStopHtml(left, err));
        break;
      }
    }
  }

  // 참고 자료처럼 문제지 뒤에 '정답'을 한데 모아 붙인다
  let hasAnswerBook = false;
  if (okCount && (!wbAnswerBookChk || wbAnswerBookChk.checked)) {
    const body = answerParts.filter((p) => p && p.trim()).join("");
    if (body) {
      hasAnswerBook = true;
      htmlParts.push(`
        <section class="wb-answerbook">
          <h2 class="wb-answerbook-head">정답</h2>
          ${body}
        </section>`);
    }
  }
  if (okCount) htmlParts.push(`<footer>단계별 WORKBOOK · 자동 생성</footer>`);
  workbookDocEl.innerHTML = htmlParts.join("");
  applyAnswerVisibility();
  if (okCount) {
    workbookPrintBtn.style.display = "inline-flex";
    // '답지만'은 뒤쪽 정답 모음을 지면에 올리는 기능이라, 그게 없으면 쓸 수 없다
    wbAnswerPrintBtn.style.display = hasAnswerBook ? "inline-flex" : "none";
    workbookSaveBtn.style.display = "inline-flex";
    workbookDocxBtn.style.display = "inline-flex";
  }
  lastWorkbookEntries = entries; // 저장 버튼이 이 값을 그대로 payload로 보낸다
  syncFloatPrint();
  wbLoadingEl.classList.remove("on");
  wbBtn.disabled = false;
  addPassageBtn.disabled = false;
  clearPassagesBtn.disabled = false;
  workbookDocEl.scrollIntoView({ behavior: "smooth", block: "start" });
  refreshTokenDisplay();
  // 워크북에도 '직접 수정'은 없다
  if (okCount) showDoneGuide(`지문 ${okCount}개의 워크북`, false);
}

// "내 저장함"에서 불러온 워크북을 다시 그린다 — API를 다시 부르지 않고, 저장해 둔
// 원본 data를 지금 화면의 단계 선택(stages)·제목·머리말로 buildWorkbookHtml에 넘긴다.
function renderWorkbookEntries(entries) {
  const total = entries.length;
  const htmlParts = [];
  const answerParts = [];
  const title = wbTitleEl.value.trim();
  const exam = wbExamEl ? wbExamEl.value.trim() : "";
  const stages = [...wbStageGridEl.querySelectorAll("input:checked")].map((i) => parseInt(i.value, 10));
  if (title) {
    htmlParts.push(`
      <div class="wb-cover">
        <h1>${esc(title)}</h1>
        ${exam ? `<div class="wb-exam">${esc(exam)}</div>` : ""}
        <div class="wb-date">${esc(new Date().toLocaleDateString("ko-KR"))}</div>
      </div>`);
  }
  entries.forEach(({ job, data }) => {
    const built = buildWorkbookHtml(data, stages, job, total, exam);
    htmlParts.push(built.html);
    answerParts.push(built.answerHtml);
  });
  let hasAnswerBook = false;
  if (total && (!wbAnswerBookChk || wbAnswerBookChk.checked)) {
    const body = answerParts.filter((p) => p && p.trim()).join("");
    if (body) {
      hasAnswerBook = true;
      htmlParts.push(`
        <section class="wb-answerbook">
          <h2 class="wb-answerbook-head">정답</h2>
          ${body}
        </section>`);
    }
  }
  if (total) htmlParts.push(`<footer>단계별 WORKBOOK · 자동 생성</footer>`);
  workbookDocEl.innerHTML = htmlParts.join("");
  applyAnswerVisibility();
  workbookPrintBtn.style.display = total ? "inline-flex" : "none";
  wbAnswerPrintBtn.style.display = total && hasAnswerBook ? "inline-flex" : "none";
  workbookSaveBtn.style.display = total ? "inline-flex" : "none";
  workbookDocxBtn.style.display = total ? "inline-flex" : "none";
  lastWorkbookEntries = entries;
  syncFloatPrint();
  // 비우는 호출일 때는 스크롤하지 않는다 — 빈 자리로 끌려가지 않게
  if (total) workbookDocEl.scrollIntoView({ behavior: "smooth", block: "start" });
}

function getWorkbookSettings() {
  return {
    stages: [...wbStageGridEl.querySelectorAll("input:checked")].map((i) => parseInt(i.value, 10)),
    title: wbTitleEl.value,
    exam: wbExamEl ? wbExamEl.value : "",
    answer: wbAnswerChk.checked,
    answerBook: wbAnswerBookChk ? wbAnswerBookChk.checked : true,
  };
}
function applyWorkbookSettings(settings) {
  if (!settings) return;
  const wanted = new Set(settings.stages || []);
  wbStageGridEl.querySelectorAll("input").forEach((b) => {
    b.checked = wanted.has(parseInt(b.value, 10));
  });
  syncWbAll();
  renumberWbStages();
  updateWbCostHint(); // 불러온 설정의 단계 수에 맞춰 금액 안내도 다시 그린다
  wbTitleEl.value = settings.title || "";
  if (wbExamEl) wbExamEl.value = settings.exam || "";
  wbAnswerChk.checked = !!settings.answer;
  if (wbAnswerBookChk) wbAnswerBookChk.checked = settings.answerBook !== false;
}

TAB_SAVE.workbook = {
  saveBtn: workbookSaveBtn,
  getPayload: () => ({
    passages: passageMgr.getJobs(),
    settings: getWorkbookSettings(),
    entries: lastWorkbookEntries,
  }),
  applyPayload: (payload) => {
    passageMgr.setJobs(payload.passages || []);
    applyWorkbookSettings(payload.settings);
    renderWorkbookEntries(payload.entries || []);
  },
  clearResults: () => renderWorkbookEntries([]),
};

/* ── 워크북 마크업 파서 & 렌더 도우미 ── */

// 시드 기반 난수 — 같은 문장은 항상 같은 순서로 섞이도록(재렌더 시 흔들림 방지)
function seededRand(seed) {
  let t = seed + 0x6d2b79f5;
  return function () {
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
// 문자열에서 안정적인 정수 시드를 뽑는다 (같은 지문 → 같은 배열)
function strSeed(str) {
  let h = 2166136261;
  const s = String(str || "");
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return h >>> 0;
}
function seededShuffle(arr, seed) {
  const a = arr.slice();
  const rnd = seededRand(seed);
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(rnd() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

const wbBlank = (w) => `<span class="wb-blank" style="min-width:${w || 90}px"></span>`;
const wbAns = (t) => `<span class="wb-ans">${esc(t)}</span>`;

// 빈칸 폭은 답의 길이에 맞춰 잡는다 (너무 길어지지 않게 상한을 둔다)
const blankWidth = (s) => Math.min(230, Math.max(70, s.length * 9));

// {{정답}} → 빈칸 + 정답 목록
function renderBraceBlanks(text) {
  const answers = [];
  const html = esc(text).replace(/\{\{([^{}]*)\}\}/g, (_, a) => {
    const v = a.trim();
    answers.push(v);
    return wbBlank(blankWidth(v));
  });
  return { html, answers };
}

// (기본형|정답) → (기본형) 표시 + 정답 목록. 기본형은 "have, be, dump"처럼 여럿일 수 있다.
function renderVerbForms(text) {
  const answers = [];
  const html = esc(text).replace(/\(([^()|]*)\|([^()|]*)\)/g, (_, base, ans) => {
    answers.push(ans.trim());
    return `<b class="wb-paren">(${esc(base.trim())})</b>`;
  });
  return { html, answers };
}

// [정답|오답] → [A / B] (시드로 섞음) + 정답 목록
function renderChoices(text, seed) {
  const answers = [];
  let idx = 0;
  const html = esc(text).replace(/\[([^\[\]|]*)\|([^\[\]|]*)\]/g, (_, right, wrong) => {
    const r = right.trim();
    const w = wrong.trim();
    answers.push(r);
    const pair = seededShuffle([r, w], seed * 100 + idx++);
    return `<b class="wb-choice">[ ${esc(pair[0])} / ${esc(pair[1])} ]</b>`;
  });
  return { html, answers };
}

// 영어 문장을 낱말 단위로 섞어 배열 문제로 만든다 (문제 제작 탭의 서술형 배열도 이걸 쓴다).
// 참고 자료처럼 ① 끝 마침표는 떼고 ② 첫 단어는 소문자로 바꿔
// 문장의 시작·끝이 드러나지 않게 한다(고유명사처럼 보이는 말은 그대로 둔다).
function scrambleSentence(en, seed) {
  let text = String(en || "").trim();
  if (!text) return "";
  text = text.replace(/\s*\.\s*$/, ""); // 끝 마침표 제거 (?, ! 는 단서라 유지)
  const words = text.split(/\s+/).filter(Boolean);
  if (words.length < 2) return esc(text);
  // 첫 단어가 'Parents' 처럼 일반 단어면 소문자로 (ARA, I 같은 건 유지)
  const first = words[0];
  if (/^[A-Z][a-z]+$/.test(first)) words[0] = first[0].toLowerCase() + first.slice(1);
  const shuffled = seededShuffle(words, seed);
  return esc(shuffled.join(" / "));
}

// 워크북8 — 구(청크) 단위로 섞는다.
// AI가 준 chunks에서 '='로 시작하는 것은 고정(제자리에 그대로 인쇄)이고,
// 고정 청크 사이에 낀 나머지 묶음마다 따로 섞어 ( a / b / c ) 로 낸다.
// 참고 자료의 "To (growing / fix / problem / this), I (…)" 모양이 이렇게 나온다.
function renderChunkOrder(chunks, en, seed) {
  let list = (chunks || []).map((c) => String(c == null ? "" : c)).filter((c) => c.trim());
  // 청크가 없거나 너무 적으면 낱말 단위로 쪼개 대신 쓴다 (참고 자료의 보조 형태)
  if (list.length < 3) {
    const words = String(en || "").trim().split(/\s+/).filter(Boolean);
    if (words.length < 3) return "";
    list = words;
  }
  const out = [];
  let run = [];
  const flush = () => {
    if (!run.length) return;
    const mixed = run.length > 1 ? seededShuffle(run, seed * 31 + out.length) : run;
    out.push(`<b class="wb-scramble-grp">(${esc(mixed.join(" / "))})</b>`);
    run = [];
  };
  list.forEach((c) => {
    if (c.startsWith("=")) {
      flush();
      out.push(esc(c.slice(1).trim()));
    } else {
      run.push(c.trim());
    }
  });
  flush();
  return out.join(" ");
}

// 워크북10 — {{쓸 부분}}의 단어 수만큼 밑줄을 깔아 준다 (참고 자료와 같은 모양)
function renderWriteMask(mask, en) {
  const src = String(mask || "").indexOf("{{") >= 0 ? mask : `{{${en || ""}}}`;
  let any = false;
  const html = esc(src).replace(/\{\{([^{}]*)\}\}/g, (_, a) => {
    const words = a.trim().split(/\s+/).filter(Boolean);
    if (!words.length) return "";
    any = true;
    return words.map((w) => wbBlank(blankWidth(w))).join(" ");
  });
  return any ? html : "";
}

function wbHeading(h) {
  return h && h.trim() ? `<div class="wb-heading">${esc(h.trim())}</div>` : "";
}

/* ── 단계 조립 ── */

function buildWorkbookHtml(d, stages, job, total, exam) {
  const parts = [];
  const answerStages = [];
  const label = job && (job.named || total > 1) ? job.name : "";

  parts.push(`<section class="wb-passage">`);
  if (d.englishTitle || d.koreanTitle) {
    parts.push(`
      <div class="wb-titlebar">
        <b>${esc(d.englishTitle || "")}</b>
        ${d.koreanTitle ? `<span>${esc(d.koreanTitle)}</span>` : ""}
      </div>`);
  }

  const sentences = (d.sentences || []).filter((s) => s && s.en);
  // 지면에 찍히는 번호는 1부터 연속. 내용이 없어 건너뛴 단계는 번호를 쓰지 않으므로
  // 'STEP 1, STEP 2 …' 사이에 빈 번호가 생기지 않는다.
  let stageNo = 0;
  stages.forEach((stageId) => {
    const meta = WB_STAGES.find((s) => s.id === stageId);
    if (!meta) return;
    const built = buildStage(stageId, d, sentences);
    if (!built || !built.html.trim()) return;
    stageNo++;
    const head = `STEP ${stageNo} ${meta.name}`;
    // 표의 <thead>는 브라우저가 쪽마다 다시 그려 준다 — 참고 자료의 '쪽 머리말'이 된다
    parts.push(`
      <table class="wb-page">
        <thead><tr><td>
          <div class="wb-run">
            <span class="wb-run-l">${esc(head)}</span>
            <span class="wb-run-r">${esc([label, exam].filter(Boolean).join(" ┃ "))}</span>
          </div>
        </td></tr></thead>
        <tbody><tr><td>
          <div class="wb-guide">${esc(meta.guide)}</div>
          ${built.html}
        </td></tr></tbody>
      </table>`);
    if (built.answers && built.answers.length) {
      answerStages.push({ head, items: built.answers });
    }
  });

  parts.push(`</section>`);

  // 뒤쪽 '정답' 모음에 들어갈 조각
  let answerHtml = "";
  if (answerStages.length) {
    answerHtml = `
      <div class="wb-ab-passage">
        ${label ? `<div class="wb-ab-label">${esc(label)}</div>` : ""}
        ${answerStages
          .map(
            (st) => `
          <div class="wb-ab-stage">
            <h3>${esc(st.head)}</h3>
            <ol>${st.items
              .map((it) => `<li value="${Number(it.no) || 1}">${esc(it.text)}</li>`)
              .join("")}</ol>
          </div>`
          )
          .join("")}
      </div>`;
  }

  return { html: parts.join(""), answerHtml };
}

// 한 단계를 통째로 만든다 → { html, answers:[{no, text}] }
function buildStage(stageId, d, sentences) {
  if (stageId === 7) return buildStage7(d.grammarFix);
  if (stageId === 9) return buildStage9(d.paraOrder, sentences);

  const html = [];
  const answers = [];
  sentences.forEach((s) => {
    const one = renderStageSentence(stageId, s);
    if (!one) return;
    html.push(one.html);
    if (one.answer) answers.push({ no: s.no, text: one.answer });
  });
  return { html: html.join(""), answers };
}

function renderStageSentence(stageId, s) {
  const noBadge = `<span class="wb-no">${esc(s.no)}</span>`;
  const head = wbHeading(s.heading);
  let body = "";
  let answer = "";

  if (stageId === 3) {
    // 빈칸 완성하기(영문) — 해석을 보고 영문의 빈칸 채우기
    const { html, answers } = renderBraceBlanks(s.enBlank || "");
    if (!answers.length) return null;
    body = `
      <div class="wb-ko">${esc(s.ko || "")}</div>
      <div class="wb-en">${html}</div>
      ${wbAns(answers.join(" / "))}`;
    answer = answers.join(" / ");
  } else if (stageId === 4) {
    // 해석 연습하기 — 영문 보고 해석 쓰기
    body = `
      <div class="wb-en">${esc(s.en)}</div>
      <div class="wb-writeline"></div>
      <div class="wb-writeline"></div>
      ${wbAns(s.ko || "")}`;
    answer = s.ko || "";
  } else if (stageId === 5) {
    // 동사형 연습하기
    const { html, answers } = renderVerbForms(s.verbForm || "");
    if (!answers.length) return null;
    body = `
      <div class="wb-ko">${esc(s.ko || "")}</div>
      <div class="wb-en">${html}</div>
      ${wbAns(answers.join(" / "))}`;
    answer = answers.join(" / ");
  } else if (stageId === 6) {
    // 어법·어휘 고르기
    const { html, answers } = renderChoices(s.grammarChoice || "", s.no || 1);
    if (!answers.length) return null;
    body = `
      <div class="wb-ko">${esc(s.ko || "")}</div>
      <div class="wb-en">${html}</div>
      ${wbAns(answers.join(" / "))}`;
    answer = answers.join(" / ");
  } else if (stageId === 8) {
    // 순서 배열하기 — 구(청크) 단위
    const scr = renderChunkOrder(s.chunks, s.en, s.no || 1);
    if (!scr) return null;
    body = `
      <div class="wb-ko">${esc(s.ko || "")}</div>
      <div class="wb-scramble">${scr}</div>
      <div class="wb-writeline"></div>
      ${wbAns(s.en || "")}`;
    answer = s.en || "";
  } else if (stageId === 10) {
    // 영작 연습하기 — 키워드 + 단어 수만큼의 밑줄
    const keys = (s.writeKeys || []).filter(Boolean);
    const masked = renderWriteMask(s.writeMask, s.en);
    if (!masked) return null;
    body = `
      <div class="wb-ko">${esc(s.ko || "")}</div>
      ${keys.length ? `<div class="wb-keys">${esc(keys.join(", "))}</div>` : ""}
      <div class="wb-en wb-write">${masked}</div>
      ${wbAns(s.en || "")}`;
    answer = s.en || "";
  }

  if (!body) return null;
  return {
    html: `<div class="wb-q">${head}<div class="wb-q-body">${noBadge}<div class="wb-q-main">${body}</div></div></div>`,
    answer,
  };
}

// 워크북7 — 지문 전체에서 어법상 어색한 세 곳 찾아 고치기
function buildStage7(gf) {
  if (!gf || !gf.text) return { html: "", answers: [] };
  const fixes = (gf.fixes || []).filter((f) => f && f.wrong && f.right);
  if (!fixes.length) return { html: "", answers: [] };

  // 밑줄 — AI가 준 구간을 본문에서 찾아 <u>로 감싼다. 앞에서부터 한 번씩만 쓴다.
  let text = String(gf.text);
  const marks = [];
  (gf.spans || []).forEach((sp) => {
    const t = String(sp || "").trim();
    if (!t) return;
    const at = text.indexOf(t, marks.length ? marks[marks.length - 1].end : 0);
    if (at < 0) return;
    marks.push({ start: at, end: at + t.length });
  });
  // 밑줄 구간과 그 사이 본문을 조각으로 갈라 놓는다 (겹치는 구간은 버린다)
  let cur = 0;
  const pieces = [];
  marks.forEach((m) => {
    if (m.start < cur) return;
    if (m.start > cur) pieces.push({ u: false, t: text.slice(cur, m.start) });
    pieces.push({ u: true, t: text.slice(m.start, m.end) });
    cur = m.end;
  });
  if (cur < text.length) pieces.push({ u: false, t: text.slice(cur) });
  const bodyHtml = pieces.length
    ? pieces
        .map((p) => {
          const h = esc(p.t).replace(/\n{2,}/g, "<br><br>").replace(/\n/g, " ");
          return p.u ? `<u>${h}</u>` : h;
        })
        .join("")
    : esc(text).replace(/\n{2,}/g, "<br><br>").replace(/\n/g, " ");

  const lines = fixes
    .map((_, i) => `<div class="wb-fixline">(${i + 1}) ${wbBlank(200)} → ${wbBlank(200)}</div>`)
    .join("");
  const answers = fixes.map((f, i) => ({
    no: i + 1,
    text: `${f.wrong} → ${f.right}`,
  }));
  const ansText = answers.map((a) => `(${a.no}) ${a.text}`).join("   ");

  return {
    html: `
      <div class="wb-q">
        <div class="wb-para">${bodyHtml}</div>
        ${lines}
        ${wbAns(ansText)}
      </div>`,
    answers,
  };
}

// 워크북9 — 문단 (A)(B)(C) 순서 배열
function buildStage9(po, sentences) {
  let head = "";
  let tail = "";
  let paras = [];
  if (po && Array.isArray(po.paragraphs) && po.paragraphs.filter((p) => p && p.trim()).length >= 2) {
    head = String(po.head || "").trim();
    tail = String(po.tail || "").trim();
    paras = po.paragraphs.map((p) => String(p).trim()).filter(Boolean);
  } else {
    // AI가 문단을 못 줬으면 문장을 3덩이로 나눠 만든다
    const list = sentences.map((s) => s.en).filter(Boolean);
    if (list.length < 3) return { html: "", answers: [] };
    const size = Math.ceil(list.length / 3);
    for (let i = 0; i < list.length; i += size) paras.push(list.slice(i, i + size).join(" "));
  }
  if (paras.length < 2) return { html: "", answers: [] };

  const letters = ["A", "B", "C", "D", "E"];
  // 원문 순서 i가 화면에서 letters[j]로 보이도록 섞는다.
  // 시드는 본문에서 뽑으므로 지문마다 배열이 달라지고, 같은 지문은 늘 같게 나온다.
  const seed = strSeed(paras.join(" ~ "));
  let order = paras.map((_, i) => i);
  for (let k = 0; k < 8; k++) {
    order = seededShuffle(order, seed + k);
    // 원문 그대로 (A)(B)(C)가 나오면 답이 드러나므로 다시 섞는다
    if (order.some((v, i) => v !== i)) break;
  }
  const shown = order.map((origIdx, j) => ({ letter: letters[j], origIdx, text: paras[origIdx] }));
  // 정답 = 원문 순서대로 읽었을 때의 글자 나열
  const answerSeq = paras
    .map((_, origIdx) => shown.find((x) => x.origIdx === origIdx).letter)
    .join(" → ");

  const blocks = shown
    .map(
      (x) =>
        `<div class="wb-parablock"><b>(${x.letter})</b> <span>${esc(x.text).replace(/\n+/g, " ")}</span></div>`
    )
    .join("");
  const slots = paras.map(() => `<span class="wb-blank" style="min-width:70px"></span>`).join(" → ");

  return {
    html: `
      <div class="wb-q">
        ${head ? `<div class="wb-en wb-para-head">${esc(head).replace(/\n+/g, " ")}</div>` : ""}
        ${blocks}
        ${tail ? `<div class="wb-en wb-para-tail">${esc(tail).replace(/\n+/g, "<br>")}</div>` : ""}
        <div class="wb-orderline">${slots}</div>
        ${wbAns(answerSeq)}
      </div>`,
    answers: [{ no: 1, text: answerSeq }],
  };
}

/* ══════════════════════════ 단어장 탭 ══════════════════════════ */
// 지문 분석 결과의 '핵심 어휘'를 모아 단어장·단어시험지를 만든다.
// 이미 받아둔 분석 데이터를 재사용하므로 AI 호출(사용량)이 전혀 없다.

const VOCAB_STORE = "gemini_vocab_sets";
const vocabSourceEl = $("vocabSource");
const vocabFormatEl = radioGroup("vocabFormat");
const vocabSortEl = radioGroup("vocabSort");
// select였을 땐 값만 읽으면 됐지만 라디오는 선택 표시(.picked)를 직접 갱신해야 한다
syncPicked("vocabFormat");
syncPicked("vocabSort");
vocabFormatEl.addEventListener("change", () => {});
vocabSortEl.addEventListener("change", () => {});
const vocabTitleEl = $("vocabTitle");
const vocabDedupEl = $("vocabDedup");
const vocabAnswerChk = $("vocabAnswerChk");
const vocabBtn = $("vocabBtn");
const vocabPrintBtn = $("vocabPrintBtn");
const vocabSaveBtn = $("vocabSaveBtn");
const vocabErrorEl = $("vocabError");
const vocabDocEl = $("vocabDoc");

function getVocabSets() {
  try {
    const v = JSON.parse(localStorage.getItem(VOCAB_STORE) || "[]");
    return Array.isArray(v) ? v : [];
  } catch (_) {
    return [];
  }
}
function saveVocabSets(sets) {
  localStorage.setItem(VOCAB_STORE, JSON.stringify(sets));
  renderVocabSource();
}

// 현재 쓸 수 있는 어휘가 얼마나 되는지 안내
function renderVocabSource() {
  if (!vocabSourceEl) return;
  const sets = getVocabSets();
  const words = sets.reduce((n, s) => n + (s.vocab || []).length, 0);
  vocabSourceEl.textContent = sets.length
    ? `📖 지문 분석 결과 ${sets.length}개 지문 · 어휘 ${words}개를 사용합니다. (지문을 다시 분석하면 갱신됩니다)`
    : "아직 분석 결과가 없습니다. 먼저 '지문 분석' 탭에서 분석을 실행하세요.";
}
renderVocabSource();

// 정답 표시 토글 — 다시 그리지 않고 클래스만 바꾼다
const VOCAB_ANSWER_STORE = "gemini_vocab_answer";
vocabAnswerChk.checked = localStorage.getItem(VOCAB_ANSWER_STORE) === "1";
function applyVocabAnswer() {
  vocabDocEl.classList.toggle("show-answers", vocabAnswerChk.checked);
}
vocabAnswerChk.addEventListener("change", () => {
  localStorage.setItem(VOCAB_ANSWER_STORE, vocabAnswerChk.checked ? "1" : "0");
  applyVocabAnswer();
});

vocabBtn.addEventListener("click", buildVocab);
vocabPrintBtn.addEventListener("click", () => printDoc(() => titledName("단어장", "vocabTitle")));

function buildVocab() {
  vocabErrorEl.textContent = "";
  const sets = getVocabSets();
  if (!sets.length) {
    vocabErrorEl.textContent = "먼저 '지문 분석' 탭에서 지문을 분석하세요.";
    return;
  }

  // 지문별 어휘를 한 줄로 펼치고, 필요하면 같은 단어를 합친다
  let rows = [];
  sets.forEach((s) => {
    (s.vocab || []).forEach((v) => {
      if (v && v.word) rows.push({ ...v, from: s.name });
    });
  });
  if (vocabDedupEl.checked) {
    const seen = new Map();
    rows.forEach((r) => {
      const key = String(r.word).trim().toLowerCase();
      if (!key) return;
      if (seen.has(key)) {
        const prev = seen.get(key);
        if (!prev.from.includes(r.from)) prev.from += `, ${r.from}`;
      } else {
        seen.set(key, { ...r });
      }
    });
    rows = [...seen.values()];
  }
  if (vocabSortEl.value === "alpha") {
    rows.sort((a, b) =>
      String(a.word).toLowerCase().localeCompare(String(b.word).toLowerCase())
    );
  }
  if (!rows.length) {
    vocabErrorEl.textContent = "분석 결과에 어휘가 없습니다.";
    return;
  }

  const fmt = vocabFormatEl.value;
  const title = vocabTitleEl.value.trim();
  const parts = [];
  parts.push(`
    <div class="vocab-head">
      <h3 class="section" style="margin-top:0">
        <span class="num">📒</span> ${esc(title || "핵심 어휘 단어장")}
      </h3>
      <div class="vocab-meta">총 ${rows.length}단어 · ${esc(new Date().toLocaleDateString("ko-KR"))}</div>
    </div>`);

  if (fmt === "list") {
    // 단어장 — 뜻·유의어·반의어까지 보여주는 참고용
    const body = rows
      .map(
        (r, i) => `<tr>
          <td class="v-no">${i + 1}</td>
          <td class="v-word">${esc(r.word)}</td>
          <td class="pos">${esc(r.pos)}</td>
          <td>${esc(r.meaning)}</td>
          <td>${esc(r.synonym)}</td>
          <td>${esc(r.antonym)}</td>
        </tr>`
      )
      .join("");
    parts.push(`
      <div class="table-wrap"><table class="vocab">
        <thead><tr><th>#</th><th>단어 / 표현</th><th>품사</th><th>뜻</th><th>유의어</th><th>반의어</th></tr></thead>
        <tbody>${body}</tbody>
      </table></div>`);
  } else {
    // 시험지 — 한쪽을 비우고 쓰게 한다 (정답은 '정답 표시'를 켤 때만 인쇄)
    const askEn = fmt === "ko"; // 영어 보고 뜻 쓰기
    const body = rows
      .map(
        (r, i) => `<tr>
          <td class="v-no">${i + 1}</td>
          <td class="${askEn ? "v-word" : ""}">${esc(askEn ? r.word : r.meaning)}</td>
          <td class="v-blank"><span class="wb-ans">${esc(askEn ? r.meaning : r.word)}</span></td>
        </tr>`
      )
      .join("");
    parts.push(`
      <div class="table-wrap"><table class="vocab vocab-test">
        <thead><tr><th>#</th><th>${askEn ? "단어 / 표현" : "뜻"}</th><th>${askEn ? "뜻" : "영어"}</th></tr></thead>
        <tbody>${body}</tbody>
      </table></div>`);
  }

  parts.push(`<footer>핵심 어휘 단어장 · 지문 분석 결과로 자동 생성</footer>`);
  vocabDocEl.innerHTML = parts.join("");
  applyVocabAnswer();
  vocabPrintBtn.style.display = "inline-flex";
  vocabSaveBtn.style.display = "inline-flex";
  syncFloatPrint();
  vocabDocEl.scrollIntoView({ behavior: "smooth", block: "start" });
}

// 단어장은 API 호출이 없어 저장할 때 지문 분석 결과(vocabSets)와 설정만 담으면
// 되고, 불러올 때도 buildVocab()을 그대로 다시 호출하면 똑같이 재현된다.
TAB_SAVE.vocab = {
  saveBtn: vocabSaveBtn,
  getPayload: () => ({
    vocabSets: getVocabSets(),
    settings: {
      format: vocabFormatEl.value,
      sort: vocabSortEl.value,
      title: vocabTitleEl.value,
      dedup: vocabDedupEl.checked,
      answer: vocabAnswerChk.checked,
    },
  }),
  applyPayload: (payload) => {
    saveVocabSets(payload.vocabSets || []);
    const s = payload.settings || {};
    if (s.format) {
      vocabFormatEl.value = s.format;
      syncPicked("vocabFormat");
    }
    if (s.sort) {
      vocabSortEl.value = s.sort;
      syncPicked("vocabSort");
    }
    vocabTitleEl.value = s.title || "";
    vocabDedupEl.checked = !!s.dedup;
    vocabAnswerChk.checked = !!s.answer;
    applyVocabAnswer();
    buildVocab();
  },
  clearResults: () => {
    vocabDocEl.innerHTML = "";
    vocabPrintBtn.style.display = "none";
    vocabSaveBtn.style.display = "none";
    syncFloatPrint();
  },
};

/* ══════════════════════════ 저장/불러오기 배선 ══════════════════════════
   각 탭이 위에서 TAB_SAVE[탭]에 자신의 getPayload/applyPayload를 등록해 뒀다.
   여기서는 그 등록을 그대로 이용해 "저장" 버튼 → 제목 입력 모달 → POST, 그리고
   "내 저장함" → 목록 조회 → 불러오기/삭제만 배선한다. 탭마다 다른 로직은 몰라도 된다. */

const TAB_LABELS = {
  passage: "📄 지문",
  analyze: "📖 지문 분석",
  mcq: "📝 객관식 문제",
  saq: "✍️ 주관식 문제",
  workbook: "📚 워크북",
  vocab: "📒 단어장",
  exam: "🧾 시험지",
};
// 저장 종류 — "지문"만 따로 두고 나머지(제작 결과물)는 한 묶음으로 본다
const PASSAGE_TAB = "passage";
// 저장 제목 기본값 — 기존 인쇄 파일명 규칙을 재사용하고, 밑줄만 보기 좋게 공백으로 바꾼다
const SAVE_TITLE_SUGGEST = {
  passage: () => passageBasedName("지문"),
  analyze: () => passageBasedName("지문분석"),
  mcq: () => passageBasedName("객관식문제"),
  saq: () => passageBasedName("주관식문제"),
  workbook: () => titledName("워크북", "wbTitle"),
  vocab: () => titledName("단어장", "vocabTitle"),
  /* 시험지는 공용 지문칸이 아니라 자기 지문칸을 쓰므로 passageBasedName을 못 쓴다.
     대신 시험지 머리글에 적어 둔 학교·고사 이름을 가져온다 — 기출에서 읽어 낸 고사
     이름(scan.title)은 저장하지 않으므로, 저장함에서 이 시험지가 어느 기출을 본뜬
     것인지 알려 주는 것은 선생님이 직접 적은 이 이름뿐이다.
     머리글을 비워 뒀으면 지금까지처럼 '시험지_날짜'가 된다. */
  exam: () => {
    const h = examHeadValues();
    const label = sanitizeFilename([h.school, h.title].filter(Boolean).join(" "));
    // 저장함 목록에는 제목만 보인다(payload를 열지 않는다). 시험지가 든 저장과 구성표만
    // 든 저장을 목록에서 가려내려면 제목이 그 말을 해 주는 수밖에 없다.
    const prefix = examPaperSets.length ? "시험지" : "기출구성";
    return [prefix, label, todayStr()].filter(Boolean).join("_");
  },
};

const saveDialogEl = $("saveDialog");
const saveDialogTitleEl = $("saveDialogTitle");
const saveDialogLeadEl = $("saveDialogLead");
const saveTitleInputEl = $("saveTitleInput");
const saveDialogErrorEl = $("saveDialogError");
const saveDialogCancelBtn = $("saveDialogCancel");
const saveDialogConfirmBtn = $("saveDialogConfirm");
const savedListModalEl = $("savedListModal");
const savedListBodyEl = $("savedListBody");
const savedListTitleEl = $("savedListTitle");
const savedListLeadEl = $("savedListLead");
const savedListCloseBtn = $("savedListClose");

let pendingSaveTab = null;

// 각 탭이 등록해 둔 clearResults()를 모두 불러 화면의 제작 결과물을 비운다.
// (지문 탭은 결과물이 따로 없으므로 등록하지 않는다)
function clearAllTabResults() {
  Object.values(TAB_SAVE).forEach((entry) => {
    if (entry && typeof entry.clearResults === "function") entry.clearResults();
  });
}

function openSaveDialog(tab) {
  pendingSaveTab = tab;
  saveDialogErrorEl.textContent = "";
  saveDialogTitleEl.textContent = tab === PASSAGE_TAB ? "💾 지문 저장" : "💾 제작 자료 저장";
  // 지문 저장은 입력칸만 담으므로, 무엇이 저장되는지 문구로 분명히 해 둔다.
  // 탭이 saveLead를 등록해 두었으면 그 문구가 이긴다 — 같은 탭인데도 무엇이 담기는지가
  // 그때그때 다른 경우가 있다(기출 탭: 시험지까지인지, 구성표뿐인지).
  const customLead = TAB_SAVE[tab] && TAB_SAVE[tab].saveLead ? TAB_SAVE[tab].saveLead() : "";
  saveDialogLeadEl.textContent = customLead || (tab === PASSAGE_TAB
    ? "지금 입력칸에 있는 지문만 저장합니다. 나중에 \"📄 지문 저장함\"에서 그대로 되불러올 수 있습니다."
    : "지문과 만든 결과를 함께 저장합니다. 나중에 \"📦 제작 자료 저장함\"에서 이 제목으로 다시 찾을 수 있습니다.");
  const blocked = TAB_SAVE[tab] && TAB_SAVE[tab].canSave ? TAB_SAVE[tab].canSave() : "";
  if (!isLoggedIn) {
    saveDialogErrorEl.textContent = "저장하려면 먼저 구글 로그인을 해주세요.";
    saveTitleInputEl.value = "";
    saveDialogConfirmBtn.disabled = true;
  } else if (blocked) {
    saveDialogErrorEl.textContent = blocked;
    saveTitleInputEl.value = "";
    saveDialogConfirmBtn.disabled = true;
  } else {
    saveDialogConfirmBtn.disabled = false;
    const suggest = SAVE_TITLE_SUGGEST[tab];
    saveTitleInputEl.value = (suggest ? suggest() : "").replace(/_/g, " ");
  }
  saveDialogEl.hidden = false;
  saveTitleInputEl.focus();
}
function closeSaveDialog() {
  saveDialogEl.hidden = true;
  pendingSaveTab = null;
}
saveDialogCancelBtn.addEventListener("click", closeSaveDialog);
saveDialogEl.addEventListener("click", (e) => {
  if (e.target === saveDialogEl) closeSaveDialog();
});

saveDialogConfirmBtn.addEventListener("click", async () => {
  const tab = pendingSaveTab;
  if (!tab || !TAB_SAVE[tab]) return;
  const title = saveTitleInputEl.value.trim() || "제목 없음";
  saveDialogErrorEl.textContent = "";
  saveDialogConfirmBtn.disabled = true;
  try {
    const payload = TAB_SAVE[tab].getPayload();
    await postJson("/api/saved", { tab, title, payload }, "저장에 실패했습니다.");
    closeSaveDialog();
  } catch (err) {
    saveDialogErrorEl.textContent = err.message || "저장에 실패했습니다.";
  } finally {
    saveDialogConfirmBtn.disabled = false;
  }
});

Object.keys(TAB_SAVE).forEach((tab) => {
  const entry = TAB_SAVE[tab];
  if (entry && entry.saveBtn) entry.saveBtn.addEventListener("click", () => openSaveDialog(tab));
});

function savedItemRowHtml(item) {
  const label = TAB_LABELS[item.tab] || item.tab;
  const date = item.updated_at ? new Date(item.updated_at).toLocaleString("ko-KR") : "";
  return `
    <div class="saved-list-item" data-id="${esc(item.id)}">
      <span class="saved-list-tag">${esc(label)}</span>
      <div class="saved-list-info">
        <div class="saved-list-title">${esc(item.title || "제목 없음")}</div>
        <div class="saved-list-date">${esc(date)}</div>
      </div>
      <div class="saved-list-actions">
        <button type="button" class="btn ghost small saved-list-load"
                title="이 저장본을 입력칸으로 가져옵니다.">불러오기</button>
        <button type="button" class="btn ghost small danger saved-list-delete">삭제</button>
      </div>
    </div>`;
}

/* 저장함은 "지문"과 "제작 자료" 둘로 나눠 연다 — 저장은 한 컬렉션에 들어가지만,
   찾을 때는 무엇을 찾는지가 이미 정해져 있어서(지문을 다시 쓰려는 것 / 만든 자료를
   다시 뽑으려는 것) 섞어 보여 주는 것보다 따로 여는 편이 헤매지 않는다. */
const LIBRARY = {
  passage: {
    title: "📄 지문 저장함",
    lead: "저장해 둔 지문입니다. [불러오기]를 누르면 입력칸으로 가져옵니다 — 이미 입력해 둔 " +
          "지문이 있으면, 뒤에 이어 붙일지 지우고 새로 넣을지 그때 물어봅니다.",
    empty: "아직 저장한 지문이 없습니다. 지문을 입력한 뒤 “💾 지문 저장”을 눌러 보세요.",
    match: (item) => item.tab === PASSAGE_TAB,
  },
  material: {
    title: "📦 제작 자료 저장함",
    lead: "저장해 둔 분석본·문제·워크북·단어장입니다. 불러오면 지문·설정과 결과가 함께 되돌아와 다시 인쇄하거나 수정할 수 있습니다.",
    empty: "아직 저장한 제작 자료가 없습니다. 자료를 만든 뒤 각 탭의 “💾 사이트 저장”을 눌러 보세요.",
    match: (item) => item.tab !== PASSAGE_TAB,
  },
};

// 목록은 열 때마다 통째로 받아 두고, 어느 저장함인지는 화면에서만 걸러 낸다
let savedItemsCache = [];
let openLibrary = "passage";

function renderSavedList() {
  const lib = LIBRARY[openLibrary];
  const items = savedItemsCache.filter(lib.match);
  savedListBodyEl.innerHTML = items.length
    ? items.map(savedItemRowHtml).join("")
    : `<p class="saved-list-empty">${esc(lib.empty)}</p>`;
}

async function openSavedList(kind) {
  openLibrary = LIBRARY[kind] ? kind : "passage";
  const lib = LIBRARY[openLibrary];
  savedListTitleEl.textContent = lib.title;
  savedListLeadEl.textContent = lib.lead;
  savedListModalEl.hidden = false;
  savedListBodyEl.innerHTML = `<p class="saved-list-empty">불러오는 중…</p>`;
  try {
    const data = await getJson("/api/saved", "저장 목록을 불러오지 못했습니다.");
    savedItemsCache = data.items || [];
    renderSavedList();
  } catch (err) {
    savedItemsCache = [];
    savedListBodyEl.innerHTML = `<p class="saved-list-empty">${esc(err.message || "저장 목록을 불러오지 못했습니다.")}</p>`;
  }
}

/* 저장본 하나를 실제로 입력칸에 넣는다. mode는 "replace"(통째로 갈아 끼우기) 또는
   "append"(지금 것을 두고 뒤에 이어 붙이기) — 지문 저장본만 append를 받는다. */
async function loadSavedItem(id, mode) {
  try {
    const item = await getJson(`/api/saved/${encodeURIComponent(id)}`, "불러오기에 실패했습니다.");
    const tab = item.tab;
    if (!TAB_SAVE[tab]) return;
    const append = mode === "append";
    savedListModalEl.hidden = true;
    const tabBtn = document.querySelector(`.tab-btn[data-tab="${tab}"]`);
    if (tabBtn) tabBtn.click();
    /* 통째로 불러오면 지문이 다 바뀌므로 화면에 남아 있던 이전 제작 결과물을 모두
       지운다 — 안 그러면 방금 불러온 지문과 맞지 않는 결과물이 그대로 남아 어느
       지문으로 만든 것인지 알 수 없게 된다(지문만 불러온 경우가 특히 그랬다).
       뒤에 붙일 때는 지우지 않는다. 앞서 있던 지문이 그 자리에 그대로 남으므로
       그 지문으로 만든 결과물도 여전히 맞는 짝이다. */
    if (!append) clearAllTabResults();
    TAB_SAVE[tab].applyPayload(item.payload || {}, append ? "append" : "replace");
  } catch (err) {
    alert(err.message || "불러오기에 실패했습니다.");
  }
}

/* 지문 저장본을 불러올 때, 입력칸이 이미 차 있으면 어떻게 할지 먼저 묻는다.
   [뒤에 붙이기]를 목록의 별도 버튼으로 두었더니 "불러오기를 누르면 지금 것이
   사라진다"는 사실이 눌러 봐야 드러났다 — 되돌릴 수 없는 쪽(덮어쓰기)이 기본으로
   눌리기 쉬운 자리에 있었던 셈이다. 그래서 갈림길을 누른 뒤로 옮겼다. */
const loadModeDialogEl = $("loadModeDialog");
const loadModeLeadEl = $("loadModeLead");
let pendingLoadId = null;

function closeLoadModeDialog() {
  loadModeDialogEl.hidden = true;
  pendingLoadId = null;
}
function openLoadModeDialog(id, currentCount) {
  pendingLoadId = id;
  loadModeLeadEl.textContent =
    `지금 입력칸에 지문 ${currentCount}개가 들어 있습니다. ` +
    `불러올 지문을 그 뒤에 이어 붙일까요, 아니면 지금 것을 지우고 새로 넣을까요?`;
  loadModeDialogEl.hidden = false;
}
$("loadModeCancel").addEventListener("click", closeLoadModeDialog);
loadModeDialogEl.addEventListener("click", (e) => {
  if (e.target === loadModeDialogEl) closeLoadModeDialog();
});
$("loadModeAppend").addEventListener("click", () => {
  const id = pendingLoadId;
  closeLoadModeDialog();
  if (id) loadSavedItem(id, "append");
});
$("loadModeReplace").addEventListener("click", () => {
  const id = pendingLoadId;
  closeLoadModeDialog();
  if (id) loadSavedItem(id, "replace");
});

savedListBodyEl.addEventListener("click", async (e) => {
  const row = e.target.closest(".saved-list-item");
  if (!row) return;
  const id = row.dataset.id;

  if (e.target.closest(".saved-list-load")) {
    // 지문 저장본이고 입력칸이 이미 차 있을 때만 갈림길을 묻는다.
    // 제작 자료는 지문·설정·결과가 한 벌이라 이어 붙일 수가 없어 늘 통째로 바꾼다.
    const cached = savedItemsCache.find((it) => it.id === id);
    const current = cached && cached.tab === PASSAGE_TAB ? passageMgr.getJobs().length : 0;
    if (current) openLoadModeDialog(id, current);
    else loadSavedItem(id, "replace");
    return;
  }

  if (e.target.closest(".saved-list-delete")) {
    if (!confirm("이 저장 항목을 삭제하시겠습니까?\n되돌릴 수 없습니다.")) return;
    try {
      await postJson("/api/saved/delete", { id }, "삭제에 실패했습니다.");
      savedItemsCache = savedItemsCache.filter((it) => it.id !== id);
      renderSavedList();
    } catch (err) {
      alert(err.message || "삭제에 실패했습니다.");
    }
  }
});

passageLibraryBtn.addEventListener("click", () => openSavedList("passage"));
materialLibraryBtn.addEventListener("click", () => openSavedList("material"));
savedListCloseBtn.addEventListener("click", () => { savedListModalEl.hidden = true; });
savedListModalEl.addEventListener("click", (e) => {
  if (e.target === savedListModalEl) savedListModalEl.hidden = true;
});
/* ══════════════════════════ 이용 내역 ══════════════════════════
   포인트가 언제 무엇에 얼마나 쓰였는지 보여 준다. 만들기 전에는 "예상 비용 900원"을
   매번 알려 주면서 지나간 것은 확인할 방법이 없었다 — 유료로 바뀌면 그게 곧 문의가 된다.
   서버가 잔액을 움직일 때마다 원장에 한 줄씩 남기고, 여기서는 그걸 최신순으로 보여 준다. */
const usageModalEl = $("usageModal");
const usageBodyEl = $("usageBody");
const usageLeadEl = $("usageLead");
const usageMoreBtn = $("usageMoreBtn");
const usageHistoryBtn = $("usageHistoryBtn");

// 원장 종류 → 화면 표시. 서버의 kind 값과 짝을 이룬다(use/charge/grant/carry/adjust).
const USAGE_KIND_LABEL = {
  use: "사용",
  charge: "충전",
  grant: "지급",
  carry: "이월",
  adjust: "조정",
};

let usageRows = [];      // 지금까지 받아 둔 줄 (더 보기로 이어 붙인다)
let usageLoading = false;

function usageRowHtml(row) {
  const amount = Number(row.amount) || 0;
  const sign = amount > 0 ? "+" : amount < 0 ? "−" : "";
  const money = `${sign}${Math.abs(amount).toLocaleString()}원`;
  const kind = USAGE_KIND_LABEL[row.kind] || row.kind || "";
  // 이월 줄은 금액이 0이고 잔액만 의미가 있다 — 금액칸을 비워 혼동을 막는다
  const moneyText = row.kind === "carry" ? "" : money;
  return `
    <div class="saved-list-item">
      <span class="saved-list-tag">${esc(kind)}</span>
      <div class="saved-list-info">
        <div class="saved-list-title">${esc(row.label || "")}</div>
        <div class="saved-list-date">${esc(row.date || "")}</div>
      </div>
      <div class="saved-list-actions" style="display:block; text-align:right;">
        <div style="font-weight:700;">${esc(moneyText)}</div>
        <div class="saved-list-date">잔액 ${Number(row.balanceAfter || 0).toLocaleString()}원</div>
      </div>
    </div>`;
}

function renderUsageList() {
  usageBodyEl.innerHTML = usageRows.length
    ? usageRows.map(usageRowHtml).join("")
    : `<p class="saved-list-empty">아직 이용 내역이 없습니다.</p>`;
}

async function loadUsage(more) {
  if (usageLoading) return;
  usageLoading = true;
  usageMoreBtn.disabled = true;
  try {
    // 더 보기는 마지막 줄보다 과거만 요청한다 (createdAt 기준 커서)
    const last = usageRows[usageRows.length - 1];
    const qs = more && last ? `?before=${encodeURIComponent(last.createdAt)}` : "";
    const data = await getJson(`/api/usage${qs}`, "이용 내역을 불러오지 못했습니다.");
    usageRows = more ? usageRows.concat(data.items || []) : (data.items || []);
    renderUsageList();
    usageMoreBtn.hidden = !data.more;
  } catch (err) {
    if (!more) usageBodyEl.innerHTML = `<p class="saved-list-empty">${esc(err.message || "이용 내역을 불러오지 못했습니다.")}</p>`;
    else alert(err.message || "이용 내역을 불러오지 못했습니다.");
  } finally {
    usageLoading = false;
    usageMoreBtn.disabled = false;
  }
}

function openUsageModal() {
  usageModalEl.hidden = false;
  usageMoreBtn.hidden = true;
  usageRows = [];
  // 유상/무상을 나눠 알려 준다 — 환불 대상은 유상분뿐이라 미리 구분해 두는 편이 낫다
  const parts = [];
  if (currentKrw !== null) parts.push(`잔액 ${currentKrw.toLocaleString()}원`);
  if (currentKrwPaid !== null && currentKrwFree !== null) {
    parts.push(`충전분 ${currentKrwPaid.toLocaleString()}원 · 무료 지급분 ${currentKrwFree.toLocaleString()}원`);
  }
  usageLeadEl.textContent = parts.join(" (") + (parts.length > 1 ? ")" : "");
  if (!isLoggedIn) {
    usageBodyEl.innerHTML = `<p class="saved-list-empty">로그인 후 이용 내역을 볼 수 있습니다.</p>`;
    return;
  }
  usageBodyEl.innerHTML = `<p class="saved-list-empty">불러오는 중…</p>`;
  loadUsage(false);
}

usageHistoryBtn.addEventListener("click", openUsageModal);
usageMoreBtn.addEventListener("click", () => loadUsage(true));
$("usageClose").addEventListener("click", () => { usageModalEl.hidden = true; });
usageModalEl.addEventListener("click", (e) => {
  if (e.target === usageModalEl) usageModalEl.hidden = true;
});

document.addEventListener("keydown", (e) => {
  if (e.key !== "Escape") return;
  // 불러오기 방식 창은 저장함 위에 겹쳐 있다 — 겹쳤을 때는 위엣것만 닫는다
  if (!loadModeDialogEl.hidden) { closeLoadModeDialog(); return; }
  if (!saveDialogEl.hidden) closeSaveDialog();
  if (!savedListModalEl.hidden) savedListModalEl.hidden = true;
  if (!usageModalEl.hidden) usageModalEl.hidden = true;
  if (!doneGuideEl.hidden) closeDoneGuide();
});

/* ══════════ 기출 유형 분석 ══════════
   학교 기출 시험지를 읽어 '어떤 유형이 몇 문항 나왔는지'를 뽑고, 그 결과로 객관식·
   주관식 탭의 유형 칸을 채운다. 문제 생성 자체는 그 탭들이 그대로 한다
   (setupQuizTab의 setTypes 참고) — 만드는 길을 둘로 늘리지 않기 위해서다.

   PDF는 브라우저가 그림으로 못 그린다. 대신 스캔 PDF 안에는 쪽마다 JPEG가 통째로
   들어 있으므로(DCTDecode), 파일에서 JPEG 시작·끝 표시를 찾아 그대로 꺼낸다.
   외부 라이브러리가 필요 없고, 실측한 기출 9개 중 8개가 이 방식으로 열렸다.
   꺼낼 것이 없는 PDF(글자로 만든 원본, 팩스 압축 스캔)는 크기가 작으므로 PDF 그대로
   서버에 넘겨 Gemini가 직접 읽게 한다. */
const examDropEl = $("examDrop");
const examFileEl = $("examFile");
const examStatusEl = $("examStatus");
const examBtn = $("examBtn");
const examClearBtn = $("examClearBtn");
const examErrorEl = $("examError");
const examLoadingEl = $("examLoading");
const examLoadingTextEl = $("examLoadingText");
const examResultEl = $("examResult");
const examCostHintEl = $("examCostHint");

const EXAM_MAX_PAGES = 16;      // server.py의 EXAM_MAX_PAGES와 같은 값
const EXAM_MIN_JPEG = 20000;    // 이보다 작은 조각은 쪽 그림이 아니라 아이콘·썸네일이다
let examPages = [];             // [{mime, data}] — 서버에 보낼 쪽 그림
let examBusy = false;
let examAutoTimer = null;
let examAutoDone = false;       // 지금 올려 둔 시험지로 자동 분석을 이미 걸었는가

function examStatus(msg, kind) {
  examStatusEl.hidden = !msg;
  examStatusEl.textContent = msg || "";
  examStatusEl.className = "exam-status" + (kind ? " " + kind : "");
}

// PDF 바이트에서 JPEG를 통째로 꺼낸다. FF D8 FF 로 시작해 FF D9 로 끝난다.
function extractJpegs(buf) {
  const out = [];
  let i = 0;
  while (i < buf.length - 3) {
    if (buf[i] === 0xff && buf[i + 1] === 0xd8 && buf[i + 2] === 0xff) {
      let j = i + 2;
      while (j < buf.length - 1 && !(buf[j] === 0xff && buf[j + 1] === 0xd9)) j++;
      if (j >= buf.length - 1) break;   // 끝 표시가 없다 = 여기부터는 JPEG가 아니다
      const end = j + 2;
      if (end - i >= EXAM_MIN_JPEG) out.push(new Blob([buf.subarray(i, end)], { type: "image/jpeg" }));
      i = end;
    } else {
      i++;
    }
  }
  return out;
}

async function examAddFiles(fileList) {
  if (examBusy) return;
  examBusy = true;
  examErrorEl.textContent = "";
  try {
    for (const file of [...fileList]) {
      if (examPages.length >= EXAM_MAX_PAGES) break;
      const isPdf = /pdf$/i.test(file.type) || /\.pdf$/i.test(file.name || "");
      if (isPdf) {
        examStatus(`${file.name} 에서 쪽을 꺼내는 중…`);
        const buf = new Uint8Array(await file.arrayBuffer());
        const blobs = extractJpegs(buf);
        if (blobs.length) {
          for (const b of blobs) {
            if (examPages.length >= EXAM_MAX_PAGES) break;
            examPages.push(await photoToPart(b));   // 사진 업로드와 같은 축소를 탄다
          }
        } else {
          // 꺼낼 그림이 없는 PDF — 원본을 그대로 넘긴다. 이런 PDF는 대개 작다.
          const data = await blobToBase64(file);
          if (data.length > 9 * 1024 * 1024) {
            examErrorEl.textContent =
              `${file.name} 은 그림이 들어 있지 않은 PDF인데 용량이 너무 큽니다. ` +
              `쪽을 사진으로 찍거나 캡처해서 올려 주세요.`;
            continue;
          }
          examPages.push({ mime: "application/pdf", data });
        }
      } else if (isPhoto(file)) {
        examPages.push(await photoToPart(file));
      }
    }
  } catch (err) {
    examErrorEl.textContent = `시험지를 읽지 못했습니다: ${err.message || err}`;
  }
  examBusy = false;
  examSyncStatus();
}

function examSyncStatus() {
  const n = examPages.length;
  examBtn.disabled = !n;
  examClearBtn.style.display = n ? "inline-flex" : "none";
  if (!n) {
    examStatus("");
    return;
  }
  const mb = examPages.reduce((s, p) => s + p.data.length, 0) / 1048576;
  const full = n >= EXAM_MAX_PAGES ? ` (최대 ${EXAM_MAX_PAGES}쪽까지)` : "";
  const next = examAutoDone ? "" : " · 곧 분석을 시작합니다";
  examStatus(`시험지 ${n}쪽 준비됨 · 약 ${mb.toFixed(1)}MB${full}${next}`, "ok");
  examScheduleAuto();
}

/* 올리기가 끝나면 버튼을 따로 누르지 않아도 분석으로 이어 간다.
   곧바로 부르지 않고 잠깐 기다리는 이유: 여러 장을 잇달아 끌어다 놓거나 PDF에서 쪽이
   하나씩 들어오는 동안에도 이 함수가 매번 불린다. 그때마다 분석이 걸리면 한 시험지에
   요금이 여러 번 나간다. 마지막으로 들어온 뒤 잠잠해지면 그때 한 번만 시작한다.

   가격표가 아직 안 왔으면 자동으로 시작하지 않는다. 분석은 지금 0원이라 당장은 차감될
   것이 없지만, 값은 환경변수로 붙일 수 있고 가격표가 오기 전에는 그 값을 알 수 없다.
   PRICING이 null이면 비용 확인창이 생략되도록 되어 있어(costConfirmed), 값이 붙은 뒤에는
   파일을 놓기만 했는데 확인 없이 차감되는 상황이 된다. 그때는 버튼을 직접 누르게 둔다. */
function examScheduleAuto() {
  if (examAutoDone || examBusy || !examPages.length) return;
  if (!PRICING) return;
  clearTimeout(examAutoTimer);
  examAutoTimer = setTimeout(() => {
    if (examAutoDone || examBusy || !examPages.length) return;
    examAutoDone = true;
    runExamScan();
  }, 800);
}

examDropEl.addEventListener("click", () => examFileEl.click());
examFileEl.addEventListener("change", () => {
  examAddFiles(examFileEl.files);
  examFileEl.value = "";
});
["dragover", "dragenter"].forEach((ev) =>
  examDropEl.addEventListener(ev, (e) => {
    e.preventDefault();
    examDropEl.classList.add("over");
  })
);
["dragleave", "drop"].forEach((ev) =>
  examDropEl.addEventListener(ev, (e) => {
    e.preventDefault();
    examDropEl.classList.remove("over");
  })
);
examDropEl.addEventListener("drop", (e) => {
  if (e.dataTransfer && e.dataTransfer.files) examAddFiles(e.dataTransfer.files);
});
examClearBtn.addEventListener("click", () => {
  clearTimeout(examAutoTimer);
  examPages = [];
  examAutoDone = false;   // 새 시험지를 올리면 다시 자동으로 분석한다
  examResultEl.innerHTML = "";
  examErrorEl.textContent = "";
  examSyncStatus();
});

onPricingReady(() => {
  if (!PRICING) return;
  examCostHintEl.innerHTML = PRICING.examScan > 0
    ? `분석 1회 <b>${PRICING.examScan.toLocaleString()}원</b> · 쪽 수와 무관합니다`
    : "분석에는 <b>포인트가 들지 않습니다</b> · 문제를 만들 때만 값이 매겨집니다";
});

/* examTypeItems / setWorkbookStages 는 여기 있었다.
   분석 결과의 유형을 세어 객관식·주관식·워크북 탭의 입력칸을 대신 채워 주던 함수들인데,
   그 세 [탭 채우기] 버튼을 없애면서 부르는 곳이 사라졌다. 시험지 제작은 유형을 다른 탭에
   옮겨 담지 않고 examPaperSlots로 곧장 문항 슬롯을 만든다. */

const EXAM_FIT_INFO = {
  "같음": { cls: "ok", label: "그대로 만들 수 있음" },
  "비슷함": { cls: "warn", label: "비슷한 걸로 대체" },
  "없음": { cls: "no", label: "못 만듦" },
};

function renderExamScan(scan) {
  const qs = scan.questions || [];
  const count = (f) => qs.filter((q) => q.fit === f).length;
  const rows = qs
    .map((q) => {
      const info = EXAM_FIT_INFO[q.fit] || EXAM_FIT_INFO["없음"];
      return `<tr class="exam-row-${info.cls}">
        <td class="exam-no">${esc(q.no)}</td>
        <td class="exam-fmt">${esc(q.format)}</td>
        <td class="exam-prompt">${esc(q.prompt)}</td>
        <td class="exam-fit"><span class="exam-badge ${info.cls}">${esc(info.label)}</span></td>
        <td class="exam-kind">${q.kind ? esc(q.kind) : "—"}</td>
        <td class="exam-engine">${q.engine ? esc(q.engine) : "—"}</td>
        <td class="exam-note">${esc(q.note || "")}</td>
      </tr>`;
    })
    .join("");

  examResultEl.innerHTML = `
    <section class="panel exam-report">
      <h3 class="exam-title">${esc(scan.title || "기출 시험지")}</h3>
      <p class="exam-summary">
        문항 <b>${qs.length}개</b>
        (선다형 ${qs.filter((q) => q.format === "선다형").length} ·
         서답형 ${qs.filter((q) => q.format === "서답형").length}) —
        그대로 만들 수 있음 <b class="ok">${count("같음")}</b> ·
        비슷한 걸로 대체 <b class="warn">${count("비슷함")}</b> ·
        못 만듦 <b class="no">${count("없음")}</b>
      </p>
      ${scan.note ? `<p class="hint">${esc(scan.note)}</p>` : ""}

      <div class="exam-table-wrap">
        <table class="exam-table">
          <thead><tr>
            <th>번호</th><th>형식</th><th>발문</th><th>판정</th><th>앱 유형</th><th>어느 탭</th><th>비고</th>
          </tr></thead>
          <tbody>${rows}</tbody>
        </table>
      </div>

    </section>`;

  // 분석 결과가 곧 시험지의 사양이다 — 분석이 끝나야 아래 시험지 제작 칸이 열린다.
  // 예전에는 여기에 [객관식/주관식/워크북 탭 채우기] 세 버튼을 두어 유형만 옮겨 담고
  // 사용자가 다른 탭으로 건너가 지문을 넣게 했다. 만드는 길이 둘로 갈려 어느 쪽으로
  // 가야 하는지 화면만 봐서는 알 수 없었고, 그 길은 지문마다 유형을 전부 만들어
  // '기출과 같은 구성 한 부'와도 어긋났다. 지금은 이 탭에서 곧장 끝낸다.
  openExamPaperPanel(scan);
}

/* 한 번에 보낼 쪽 수.
   7쪽을 한 요청으로 보냈더니 배포 프록시가 응답을 기다리다 끊어(HTTP 502) 분석이
   통째로 날아갔다. 쪽당 15~20초쯤 걸리는데 프록시 한계가 약 100초라, 한 요청이
   3쪽을 넘지 않게 잘라 여러 번 부른다. 총 시간은 비슷하지만 각 요청이 짧아
   중간에서 끊기지 않고, 한 묶음이 실패해도 나머지는 살아남는다. */
const EXAM_SCAN_BATCH = 3;

async function runExamScan() {
  if (!examPages.length || examBusy) return;
  examErrorEl.textContent = "";
  const batches = [];
  for (let i = 0; i < examPages.length; i += EXAM_SCAN_BATCH) {
    batches.push({ from: i + 1, files: examPages.slice(i, i + EXAM_SCAN_BATCH) });
  }
  if (PRICING && PRICING.examScan > 0) {
    // 나눠 부르면 호출 수만큼 값이 매겨진다 — 확인 문구에 실제 총액을 적는다
    const won = PRICING.examScan * batches.length;
    if (!costConfirmed(won, `기출 시험지 ${examPages.length}쪽을 ${batches.length}번에 나눠 분석합니다.`)) return;
  }
  examBusy = true;
  examBtn.disabled = true;
  examLoadingEl.classList.add("on");
  examResultEl.innerHTML = "";

  const questions = [];
  const seenNo = new Set();   // 쪽 경계에 걸친 문항이 두 묶음에서 겹쳐 오는 것을 막는다
  const notes = [];
  const failed = [];
  let title = "";

  for (let b = 0; b < batches.length; b++) {
    const { from, files } = batches[b];
    const to = from + files.length - 1;
    examLoadingTextEl.textContent =
      batches.length > 1
        ? `AI가 시험지를 읽고 있습니다… (${b + 1}/${batches.length}) — ${from}~${to}쪽`
        : `AI가 시험지 ${examPages.length}쪽을 읽고 있습니다… (1~3분 걸립니다)`;
    try {
      const scan = await postJson(
        "/api/examscan",
        { files, pageFrom: from, pageTotal: examPages.length },
        "시험지 분석에 실패했습니다."
      );
      if (!title && scan.title) title = scan.title;
      if (scan.note) notes.push(scan.note);
      for (const q of scan.questions || []) {
        const key = String(q.no || "").trim();
        if (key && seenNo.has(key)) continue;   // 같은 번호가 또 오면 먼저 읽은 것을 남긴다
        if (key) seenNo.add(key);
        questions.push(q);
      }
    } catch (err) {
      failed.push(`${from}~${to}쪽: ${err.message || String(err)}`);
      // 한도 소진은 기다려도 안 풀린다 — 남은 묶음을 시도하지 않는다
      if (isQuotaError(err)) break;
    }
  }

  if (questions.length) {
    if (failed.length) {
      notes.push(`읽지 못한 쪽이 있습니다 — ${failed.join(" / ")}. 그 쪽의 문항은 빠져 있습니다.`);
    }
    renderExamScan({ title, questions, note: notes.join(" / ") });
    refreshTokenDisplay();  // 분석에 요금이 나갔으므로 잔액 표시만 갱신(화면은 그대로)
  } else {
    examErrorEl.textContent = failed.join(" / ") || "시험지에서 문항을 찾지 못했습니다.";
  }
  examLoadingEl.classList.remove("on");
  examBusy = false;
  examBtn.disabled = !examPages.length;
}

examBtn.addEventListener("click", runExamScan);

/* ══════════════ 기출과 같은 구성으로 시험지 만들기 ══════════════
   기출 분석이 "이 학교는 어법 2, 빈칸 3, 순서 2 … 총 30문항"을 알려 주면 그 구성
   그대로 시험지 한 부를 만든다. 객관식·주관식 탭과 결정적으로 다른 것은 지문을 쓰는
   방식이다.

     · 객관식 탭 — 넣은 지문 '전부' × 고른 유형 '전부'. 지문이 곱해지는 축이라
       40지문에 30문항 구성을 걸면 1,200문항이 나온다. 시험지가 아니라 문제집이다.
     · 시험지   — 문항 수는 기출이 정한 30개로 고정이고, 지문은 그 30문항이 나눠
       가질 '풀'이다. 40지문을 넣어도 문항은 30개, 요금도 30문항어치다.

   ── 대원칙 1. 한 부 안에서 같은 지문을 두 번 쓰지 않는다 ──
   이 앱은 문항마다 지문을 따로 싣는다(실제 시험지의 "[3~4] 다음 글을 읽고 물음에
   답하시오" 식 묶음이 아니다). 그래서 한 지문으로 빈칸 문제와 주제 문제를 같이 내면,
   주제 문제에 가공 없이 실린 지문이 빈칸의 정답을 그대로 보여 준다. 지문을 겹치지 않게
   하면 이 사고가 구조적으로 사라진다 — 지켜야 할 규칙이 아니라 성립하는 불변식이 된다.
   '문항 수 ≤ 지문 수'가 하드 요구사항이 되는 것도 이 원칙 때문이다.

   ── 대원칙 2. 부가 달라도 같은 (지문, 유형) 조합은 다시 쓰지 않는다 ──
   40지문에서 30문항씩 뽑으면 2부째부터 지문은 반드시 겹친다(60 > 40). 거기서 유형까지
   겹치면 A형과 B형에 사실상 같은 문항이 실려 A형을 푼 학생이 B형에서 그대로 이득을
   본다. 지문이 겹치는 것은 어쩔 수 없고, 유형까지 겹치지 않게 막는 것이 이 원칙이다.
   저장물에 배분표를 함께 넣는 이유가 이것이다 — 나중에 B형을 따로 만들 때 A형이 무엇을
   썼는지 알아야 피할 수 있다.

   ── 흐름 ──
   기출 분석(무료) → 지문 입력 → 배분(공짜·즉시) → 배분표 확인 → 생성(여기서만 과금)
   실패할 수 있는 경우를 전부 배분 단계에서 잡는 것이 요점이다. 배분은 AI 호출이 0회라
   몇 번을 다시 굴려도 요금이 없고, 만들 수 없는 조합은 돈을 쓰기 전에 드러난다. */

const EXAM_PAPER_MAX_PASSAGES = 40;
// 부수 상한. 계산상으로는 더 나오지만(유형별 적합 지문 ÷ 부당 문항 수) 2부가 이미
// 60회 호출·30~60분이고, 그보다 길면 한 탭을 붙들고 있기 어려워 실제로 안 쓰인다.
const EXAM_PAPER_MAX_COPIES = 2;
const EXAM_COPY_LABELS = ["A형", "B형"];

/* 유형별 지문 조건 — server.py의 QUIZ_TYPE_MAX 주석이 그대로 근거다.
   "순서·문장삽입은 지문의 문장 수에 물리적으로 묶여 모델을 바꿔도 늘지 않는다",
   "빈칸 쓰기는 같은 낱말이 지문 다른 곳에 실제로 나오는 자리만 뚫는다"가 여기 조건이 된다.
   배분 단계에서 미리 걸러 두면 만들다 실패하는 횟수가 줄고, 무엇보다 '만들 수 없다'는
   사실이 돈을 쓰기 전에 드러난다. 조건이 거칠어도 되는 이유는 생성이 실패하면 같은
   유형의 다음 후보 지문으로 넘어가고, 요금은 성공했을 때만 빠지기 때문이다. */
const EXAM_FIT_RULES = {
  "순서": { minSent: 6 },
  "문장삽입": { minSent: 6 },
  // 도입부 2문장 + 번호 붙는 5문장 = 7문장이 물리적 하한이다. 그중 하나는 AI가 지어
  // 끼워 넣으므로 지문 자신이 6문장을 대야 한다(실측 기출 11문항이 전부 이 모양이었다).
  "무관한 문장": { minSent: 6 },
  "무관한 문장 쓰기": { minSent: 6 },
  // 글 전체를 한 문장으로 압축하려면 논지가 세워질 만큼은 있어야 한다
  "요약문": { minSent: 5 },
  "요약문 완성": { minSent: 5 },
  "서술형배열": { minSent: 4 },
  "함축의미": { minSent: 4 },
  "요지": { minSent: 4 },
  "주제": { minSent: 3 },
  "제목": { minSent: 3 },
  "빈칸": { minSent: 3 },
  "빈칸 쓰기": { minSent: 3, repeatWord: true },
  "동사형 쓰기": { minSent: 3 },
  "표현 찾아 쓰기": { minSent: 3 },
};
const EXAM_FIT_MIN_SENT = 2;      // 유형을 안 가리는 최소 조건
const EXAM_FIT_MIN_CHARS = 120;

// 문장 수 — 배분 조건에만 쓰므로 대충 세면 된다. 마지막 문장에 문장부호가 없는
// 경우가 흔해(붙여넣다 잘림) 남은 꼬리도 한 문장으로 친다.
function countSentences(text) {
  const s = String(text || "");
  const closed = (s.match(/[^.!?]+[.!?]/g) || []).filter((x) => x.trim().length > 1).length;
  const tail = s.replace(/[\s\S]*[.!?]/, "").trim();
  return closed + (tail.length > 1 ? 1 : 0);
}

// 5글자 이상인 낱말이 두 번 이상 나오는가 — '빈칸 쓰기'가 요구하는 조건이다.
// 짧은 낱말(the·and·that)은 어느 지문에나 있어 조건 구실을 못 하므로 길이로 거른다.
function hasRepeatedWord(text) {
  const seen = new Set();
  for (const w of String(text || "").toLowerCase().match(/[a-z]{5,}/g) || []) {
    if (seen.has(w)) return true;
    seen.add(w);
  }
  return false;
}

// 지문 하나에 배분 판정용 값을 미리 붙여 둔다 (문장 수를 문항마다 다시 세지 않도록)
function examProfile(job) {
  return {
    ...job,
    sentences: countSentences(job.text),
    repeatWord: hasRepeatedWord(job.text),
  };
}

// 이 지문으로 이 유형을 낼 수 있는가
function examEligible(type, p) {
  const rule = EXAM_FIT_RULES[type] || {};
  if (p.sentences < (rule.minSent || EXAM_FIT_MIN_SENT)) return false;
  if (p.text.length < EXAM_FIT_MIN_CHARS) return false;
  if (rule.repeatWord && !p.repeatWord) return false;
  return true;
}

// 조건을 사람 말로 — 배분이 실패했을 때 무엇을 더 넣어야 하는지 알려 준다
function examFitReason(type) {
  const rule = EXAM_FIT_RULES[type] || {};
  const parts = [];
  if (rule.minSent) parts.push(`문장 ${rule.minSent}개 이상`);
  if (rule.repeatWord) parts.push("같은 낱말이 두 번 이상 나오는 지문");
  return parts.join(" · ") || `${EXAM_FIT_MIN_CHARS}자 이상`;
}

/* 기출 문항 목록을 '만들 문항 슬롯'으로 바꾼다.
   워크북 유형은 뺀다 — 워크북은 지문 전체를 훑는 학습지라 번호 붙은 시험지 문항이
   되지 않고, /api/quiz로 만들어지지도 않는다(만들려면 워크북 탭을 써야 한다).
   순서는 객관식 먼저·서답형 뒤 — 실제 시험지 관례다. 기출의 문항 번호는 따라가지
   않는다(번호 위치까지 맞추면 배분 제약만 늘고 얻는 것이 없다). */
function examPaperSlots(questions, includeSimilar) {
  const picked = [];
  (questions || []).forEach((q) => {
    if (!q.kind || q.fit === "없음") return;
    if (q.fit === "비슷함" && !includeSimilar) return;
    if (q.engine === "워크북") return;
    picked.push({ type: q.kind, engine: q.engine, format: q.format });
  });
  return picked
    .map((s, i) => ({ ...s, seq: i }))
    .sort((a, b) => (a.engine === "객관식" ? 0 : 1) - (b.engine === "객관식" ? 0 : 1) || a.seq - b.seq)
    .map((s, i) => ({ type: s.type, engine: s.engine, format: s.format, q: i + 1 }));
}

/* 배분 — 문항마다 지문 하나를 붙인다. AI 호출 0회.

   후보 지문이 '적은' 문항부터 자리를 잡는다(most-constrained-first). 반대로 하면
   어법·주제처럼 아무 지문이나 되는 유형이 긴 지문을 먼저 차지해 버려, 정작 긴 지문이
   있어야 하는 순서·문장삽입 차례에 짧은 지문만 남는다.
   같은 조건이면 '쓸 수 있는 유형이 적은' 지문부터 소비한다 — 두루 쓰이는 지문을 뒤에
   남겨 두는 쪽이 전체가 성립할 확률이 높다.

   usedPairs: 이미 만들어 둔 부들이 쓴 "지문번호|유형" 집합 (대원칙 2).
   실패하면 어느 유형에서 후보가 떨어졌는지 그대로 돌려준다 — 사용자가 무엇을 더 넣어야
   하는지 알아야 하기 때문이다. */
function planExamPaper(slots, jobs, copies, usedPairs, seed) {
  const profiles = jobs.map(examProfile);
  const eligible = slots.map((s) => profiles.filter((p) => examEligible(s.type, p)).map((p) => p.no));

  // 지문이 감당하는 유형 가짓수 — 적을수록 먼저 쓴다
  const breadth = new Map();
  profiles.forEach((p) => {
    breadth.set(p.no, slots.reduce((n, s) => n + (examEligible(s.type, p) ? 1 : 0), 0));
  });

  const key = (no, type) => `${no}|${type}`;
  const taken = new Set(usedPairs || []);
  const plans = [];

  for (let c = 0; c < copies; c++) {
    const usedHere = new Set();          // 대원칙 1 — 이 부 안에서 쓴 지문
    const rows = new Array(slots.length).fill(null);
    const order = slots
      .map((s, i) => i)
      .sort((a, b) => eligible[a].length - eligible[b].length || a - b);

    for (const i of order) {
      const s = slots[i];
      let cands = eligible[i].filter((no) => !usedHere.has(no) && !taken.has(key(no, s.type)));
      if (!cands.length) {
        return {
          ok: false,
          fail: { type: s.type, copy: c + 1, pool: eligible[i].length, need: examFitReason(s.type) },
        };
      }
      // 먼저 섞고 나서 breadth로 정렬한다 — 정렬이 안정적이라 같은 값끼리는 섞인
      // 순서가 남고, [다시 배분]이 다른 표를 내놓는다.
      cands = seededShuffle(cands, seed + c * 977 + i);
      cands.sort((a, b) => (breadth.get(a) || 0) - (breadth.get(b) || 0));
      const pick = cands[0];
      usedHere.add(pick);
      taken.add(key(pick, s.type));
      rows[i] = { q: s.q, type: s.type, engine: s.engine, passageNo: pick };
    }
    plans.push(rows);
  }
  return { ok: true, plans };
}

// 배분표 한 부를 표로 — 화면 미리보기와 인쇄물이 같은 함수를 쓴다
function examPlanTableHtml(rows, jobs, caption) {
  const nameOf = (no) => {
    const j = jobs.find((x) => x.no === no);
    return j ? j.name : `지문 ${no}`;
  };
  const body = rows
    .map(
      (r) => `<tr>
        <td>${r.q}</td><td>${esc(r.type)}</td>
        <td>${esc(r.engine)}</td><td>${esc(nameOf(r.passageNo))}</td>
      </tr>`
    )
    .join("");
  /* .exam-plan으로 감싸는 이유는 인쇄에서 통째로 빼기 위해서다 — 표 자체는 정답표와
     같은 class(answerkey)를 써서 이 감싸개가 없으면 둘을 갈라낼 수 없다.
     배분표는 '어느 문항을 어느 지문으로 만들었나'를 적은 제작 기록이라 화면에서 확인할
     것이지 학생에게 나가는 인쇄물이 아니다. 다음 부를 겹치지 않게 만드는 데 쓰는 값은
     저장본(payload)에 들어 있고, 인쇄물에서 읽어 오지 않는다. */
  return `
    <div class="exam-plan">
      <h3 class="section"><span class="num">📋</span> ${esc(caption)}</h3>
      <div class="table-wrap"><table class="answerkey">
        <thead><tr><th>문항</th><th>유형</th><th>구분</th><th>쓴 지문</th></tr></thead>
        <tbody>${body}</tbody>
      </table></div>
    </div>`;
}

/* ── 시험지 제작 화면 배선 ── */
const examPaperPanelEl = $("examPaperPanel");
const examPaperSpecEl = $("examPaperSpec");
const examPaperErrorEl = $("examPaperError");
const examPaperCostHintEl = $("examPaperCostHint");
const examPlanBtn = $("examPlanBtn");
const examPaperLoadingEl = $("examPaperLoading");
const examPaperLoadingTextEl = $("examPaperLoadingText");
const examPaperResultEl = $("examPaperResult");
// 목표 어법 — 이 탭은 지문칸이 따로라 공용 칸(grammarEl)과 별개로 받는다
const examGrammarEl = $("examTargetGrammar");
const examCopiesEl = radioGroup("examCopies");
const examSimilarEl = $("examIncludeSimilar");

/* 출제 순서 — "type"(기출 순서대로) / "random"(무작위로 섞기)
   기본은 기출 순서다. 기출을 그대로 본뜬 시험지가 이 탭의 목적이기 때문이다.
   섞기는 만들어진 문항을 부(部)마다 따로 섞는다 — A형과 B형이 같은 순서로 나오지
   않게 하려는 것으로, 2부를 만들 때 특히 뜻이 있다. */
const examOrderEl = radioGroup("examOrder");
const examOrderHintEl = $("examOrderHint");
const examIsRandom = () => !!examOrderEl && examOrderEl.value === "random";

function updateExamOrderHint() {
  if (!examOrderHintEl) return;
  examOrderHintEl.innerHTML = examIsRandom()
    ? "유형과 상관없이 문항이 <b>무작위로 섞여</b> 나옵니다. 부마다 따로 섞이므로 " +
      "A형과 B형의 순서가 서로 다릅니다. 문제지 번호와 정답표·배분표 번호는 섞인 순서로 함께 매겨집니다."
    : "기출과 같은 차례로 나옵니다 — <b>객관식 먼저, 서답형 뒤</b>입니다.";
}
if (examOrderEl) examOrderEl.addEventListener("change", updateExamOrderHint);
updateExamOrderHint();

// 기출이 '비슷한 걸로 대체' 판정한 문항까지 넣을지. 문항 수가 달라지므로 요금·배분이
// 함께 바뀐다 — 끄면 '그대로 만들 수 있음'만 남는다.
const examIncludeSimilar = () => !examSimilarEl || examSimilarEl.checked;

let examScanNow = null;   // 지금 화면에 떠 있는 기출 분석 (저장하지 않는다)
let examPlanNow = null;   // 방금 계산한 배분 (생성이 끝나면 비운다)
let examPaperSets = [];   // 완성된 부 [{label, questions, plan}]
let examPaperBusy = false;

const examPaperMgr = createPassageManager(
  $("examPassageList"),
  $("examAddPassageBtn"),
  $("examPassageCount"),
  () => examPlanBtn.click(),
  $("examPassageMaxNote"),
  EXAM_PAPER_MAX_PASSAGES
);
examPaperMgr.addRow(false);
// 공용 지문칸과 똑같이 PDF를 끌어다 놓을 수 있게 한다.
// 대상은 패널 전체다 — 지문칸만 받으면 칸이 하나뿐일 때 놓을 자리가 너무 좁다.
wirePassageDrop(examPaperPanelEl, examPaperMgr, examPassageStatus);

$("examClearPassagesBtn").addEventListener("click", () => {
  if (confirm("입력한 시험 범위 지문을 모두 지우시겠습니까?\n되돌릴 수 없습니다.")) {
    examPaperMgr.clearAll();
    examInputChanged();
  }
});

// 문항 1개 = 호출 1회 = 유형 1개 × 1문항. 추가문항 할인(extraQuestion)은 구조상
// 걸릴 일이 없다 — 한 호출에 한 문항만 담기기 때문이다.
function examSlotPrice(slot) {
  if (!PRICING) return 0;
  if (slot.engine === "객관식") {
    return MCQ_TRANSFORM_TYPES.has(slot.type) ? PRICING.mcqTransform : PRICING.mcqPlain;
  }
  return PRICING.saq;
}

function examCopies() {
  const n = Number(examCopiesEl ? examCopiesEl.value : 1) || 1;
  return Math.min(EXAM_PAPER_MAX_COPIES, Math.max(1, n));
}

function updateExamPaperCost() {
  if (!examPaperCostHintEl) return;
  if (!examScanNow) {
    examPaperCostHintEl.textContent = "";
    return;
  }
  const slots = examPaperSlots(examScanNow.questions, examIncludeSimilar());
  const copies = examCopies();
  const jobs = examPaperMgr.getJobs();
  const parts = [
    `<b>${slots.length}문항</b> × ${copies}부 = <b>${slots.length * copies}문항</b>`,
    `· 지문 <b>${jobs.length}개</b> 입력됨`,
  ];
  if (PRICING) {
    const won = slots.reduce((s, sl) => s + examSlotPrice(sl), 0) * copies;
    parts.push(`— 예상 <b>${won.toLocaleString()}원</b>`);
  }
  // 대원칙 1이 곧 '문항 수 ≤ 지문 수'다. 지문이 모자라면 배분 자체가 성립하지 않으므로
  // 제작 버튼을 누르기 전에 먼저 알려 준다.
  if (jobs.length < slots.length) {
    parts.push(
      `<b class="no">— 지문이 ${slots.length - jobs.length}개 모자랍니다</b>` +
      ` (한 부 안에서 같은 지문을 두 번 쓰지 않으므로 문항 수만큼 필요합니다)`
    );
  }
  examPaperCostHintEl.innerHTML = parts.join(" ");
}

/* 지문·부수·'비슷한 것 포함'이 바뀌면 방금 계산한 배분은 더 이상 그 입력의 것이 아니다.
   즉시 버린다 — 다음에 [문제 제작]을 누르면 새 입력으로 다시 계산된다. */
function examInputChanged() {
  if (examPlanNow) {
    dropExamPlan();
    examPaperErrorEl.textContent = "";
  }
  updateExamPaperCost();
}
if (examCopiesEl) examCopiesEl.addEventListener("change", examInputChanged);
if (examSimilarEl) examSimilarEl.addEventListener("change", examInputChanged);
$("examPassageList").addEventListener("input", examInputChanged);
// 지문 삭제는 input을 일으키지 않는다. 캡처 단계에서 받는 이유는 삭제 처리가 그 행을
// 먼저 없애 버려, 거품 단계에서는 이 컨테이너까지 올라오지 않을 수 있기 때문이다.
$("examPassageList").addEventListener(
  "click",
  (e) => {
    if (e.target.closest(".passage-del")) examInputChanged();
  },
  true
);

function openExamPaperPanel(scan) {
  examScanNow = scan;
  examPlanNow = null;
  examPaperErrorEl.textContent = "";
  examPaperPanelEl.hidden = false;

  const slots = examPaperSlots(scan.questions, examIncludeSimilar());
  const mcq = slots.filter((s) => s.engine === "객관식").length;
  const saq = slots.length - mcq;
  const dropped = (scan.questions || []).length - slots.length;
  examPaperSpecEl.innerHTML =
    `이 시험지의 구성은 <b>${slots.length}문항</b>` +
    ` (객관식 ${mcq} · 서답형 ${saq})입니다. 같은 구성으로 시험지를 만듭니다.` +
    (dropped > 0
      ? ` <span class="warn">기출 ${dropped}문항은 여기서 만들 수 없어 빠졌습니다</span>` +
        ` (못 만드는 유형이거나, 워크북으로만 되는 유형입니다).`
      : "");
  updateExamPaperCost();
  syncExamSpecSave();
  // 이제 지문칸이 열렸으니 학원 마크 칸도 이 안으로 꺼내 온다
  syncTabChrome("exam");
}

function dropExamPlan() {
  examPlanNow = null;
}

/* 배분은 화면에 단계로 드러내지 않는다 — [문제 제작] 한 번이면 끝나야 하기 때문이다.
   대신 배분이 AI 호출 0회·0원이라는 성질은 그대로 쓴다. 누르면 먼저 배분을 계산해
   '만들 수 없는 경우'를 전부 걸러내고, 그 검사를 통과했을 때만 요금 확인창을 띄운다.
   덕분에 요금이 나간 뒤에 배분이 실패하는 일이 없다.
   어느 문항을 어느 지문으로 만들었는지는 결과 아래에 표로 붙는다(화면 전용 — 인쇄에서는
   .exam-plan을 뺀다). */
function runExamPaperFlow() {
  if (examPaperBusy) return;
  examPaperErrorEl.textContent = "";
  if (!examScanNow) return;

  const slots = examPaperSlots(examScanNow.questions, examIncludeSimilar());
  const jobs = examPaperMgr.getJobs();
  if (!slots.length) {
    dropExamPlan();
    examPaperErrorEl.textContent =
      "이 시험지로 만들 수 있는 문항이 없습니다. '비슷한 것도 포함'을 켜 보세요.";
    return;
  }
  if (jobs.length < slots.length) {
    dropExamPlan();
    examPaperErrorEl.textContent =
      `지문이 모자랍니다 — ${slots.length}문항을 만들려면 지문이 ${slots.length}개 이상 필요합니다` +
      ` (지금 ${jobs.length}개). 한 부 안에서 같은 지문을 두 번 쓰지 않기 때문입니다.`;
    return;
  }

  const copies = examCopies();
  // 이미 만들어 둔 부(또는 저장에서 불러온 부)가 쓴 조합은 피한다 — 대원칙 2.
  // 씨앗을 매번 새로 뽑으므로 같은 입력으로 다시 눌러도 배분이 달라진다.
  const res = planExamPaper(slots, jobs, copies, examUsedPairs(), Math.floor(Math.random() * 1e9));

  if (!res.ok) {
    const f = res.fail;
    dropExamPlan();
    examPaperErrorEl.innerHTML =
      `<b>${esc(f.type)}</b> 문항에 쓸 지문이 떨어졌습니다` +
      (copies > 1 ? ` (${f.copy}부째)` : "") +
      ` — 조건에 맞는 지문이 ${f.pool}개뿐입니다. 필요한 조건: <b>${esc(f.need)}</b>.<br>` +
      `그런 지문을 더 넣거나, 부수를 줄여 보세요.`;
    return;
  }

  examPlanNow = { slots, jobs, copies, plans: res.plans };
  runExamPaper();
}

// 이미 만들어 둔 부들이 쓴 (지문, 유형) — 대원칙 2의 근거가 되는 값이다.
// 저장물을 불러오면 그 배분표가 여기 들어와, 나중에 B형을 따로 만들어도 겹치지 않는다.
function examUsedPairs() {
  const out = new Set();
  examPaperSets.forEach((set) => {
    (set.plan || []).forEach((r) => out.add(`${r.passageNo}|${r.type}`));
  });
  return out;
}

/* 생성 — 여기서만 요금이 나간다.
   호출 하나가 (지문 1개 · 유형 1개 · 1문항)이다. 대원칙 1 때문에 한 문항이 지문
   하나를 통째로 차지하므로 묶을 것이 없다(chunkTypes를 쓰지 않는 이유).
   부가 끝날 때마다 화면에 붙이고 저장 버튼을 열어 둔다 — 중간에 끊겨도 끝난 부는 남는다. */
async function runExamPaper() {
  if (!examPlanNow || examPaperBusy) return;
  const { jobs, copies, plans } = examPlanNow;
  const won = PRICING
    ? examPlanNow.slots.reduce((s, sl) => s + examSlotPrice(sl), 0) * copies
    : 0;
  const totalSteps = plans.reduce((n, rows) => n + rows.length, 0);
  if (!costConfirmed(won, `시험지 ${copies}부(${totalSteps}문항)를 만듭니다.`)) return;

  examPaperBusy = true;
  examPaperErrorEl.textContent = "";
  examPaperLoadingEl.classList.add("on");
  const makeBtn = $("examMakeBtn");
  const replanBtn = $("examReplanBtn");
  if (makeBtn) makeBtn.disabled = true;
  if (replanBtn) replanBtn.disabled = true;

  const jobOf = (no) => jobs.find((j) => j.no === no);
  let step = 0;
  let stopped = false;

  for (let c = 0; c < copies && !stopped; c++) {
    const rows = plans[c];
    const label = copies > 1 ? EXAM_COPY_LABELS[c] : "";
    const questions = [];
    const failed = [];

    for (const r of rows) {
      step++;
      examPaperLoadingTextEl.textContent =
        `${label ? label + " · " : ""}${r.q}번 ${r.type} 만드는 중… (${step}/${totalSteps})`;
      const job = jobOf(r.passageNo);
      if (!job) continue;
      try {
        const data = await postJson(
          "/api/quiz",
          {
            passage: job.text,
            types: [{ id: r.type, count: 1 }],
            variation: "verbatim",
            // 이 탭은 지문칸이 따로이므로 목표 어법도 이 탭 칸의 값을 쓴다
            targetGrammar: examGrammarEl.value,
          },
          "문제 생성에 실패했습니다."
        );
        const q = (data.questions || [])[0];
        if (q) questions.push({ ...q, _plan: r });
        else failed.push({ ...r, msg: "문항이 만들어지지 않았습니다." });
      } catch (err) {
        failed.push({ ...r, msg: err.message || String(err) });
        // 한도 소진은 기다려도 안 풀린다 — 남은 문항을 시도하지 않고 멈춘다
        if (isQuotaError(err)) {
          stopped = true;
          break;
        }
      }
    }

    if (questions.length) {
      // 무작위 모드 — 번호를 다시 매기기 '전에' 섞는다. 그래야 문제지 번호와
      // 정답표·배분표 번호가 섞인 순서 그대로 함께 따라간다.
      // 부마다 새 씨앗을 뽑으므로 A형과 B형의 순서가 서로 다르다.
      const ordered = examIsRandom()
        ? seededShuffle(questions, Math.floor(Math.random() * 1e9))
        : questions;
      // 실제로 만들어진 것만 남기고 번호를 다시 매긴다 — 실패한 문항 자리에 번호가
      // 비어 있으면 시험지에 결번이 생긴다.
      const plan = ordered.map((q, i) => ({ ...q._plan, q: i + 1 }));
      ordered.forEach((q) => delete q._plan);
      examPaperSets.push({ label, questions: ordered, plan, failed });
      renderExamPaperSets();
    }
  }

  examPaperLoadingEl.classList.remove("on");
  examPaperBusy = false;
  refreshTokenDisplay();
  if (stopped) {
    examPaperErrorEl.textContent =
      "한도에 걸려 중단했습니다. 만들어진 부는 아래에 남아 있으니 저장해 두세요.";
  }
  // 다음에 누르면 방금 쓴 (지문, 유형) 조합을 피해 새로 배분한다 — 대원칙 2
  examPlanNow = null;
}

/* ── 시험지 머리글 ──
   만든 문항을 '학교 시험지'처럼 보이게 하는 부분이다. 학교마다 판형이 다르지만
   공통으로 들어가는 것은 넷이다 — 고사명, 학교·학년, 큼직한 과목 상자, 그리고
   성명 기입란. 그 넷만 재현한다.
   학교 이름이 비어 있으면 머리글을 아예 만들지 않는다. 학교명 없는 시험지 머리글은
   실제 시험지처럼 보이지 않아 오히려 어설프기 때문이다. 그때는 지금까지처럼
   지문 이름표(passageBanner)만 붙는다. */
const examHeadEls = {
  school: $("examSchool"),
  title: $("examSheetTitle"),
  subject: $("examSubject"),
  grade: $("examGrade"),
  teacher: $("examTeacher"),
  minutes: $("examMinutes"),
};

function examHeadValues() {
  const v = (el) => (el ? el.value.trim() : "");
  return {
    school: v(examHeadEls.school),
    title: v(examHeadEls.title),
    subject: v(examHeadEls.subject),
    grade: v(examHeadEls.grade),
    teacher: v(examHeadEls.teacher),
    minutes: v(examHeadEls.minutes),
  };
}

function examSheetHeadHtml(set) {
  const h = examHeadValues();
  if (!h.school) return "";
  const count = (set.questions || []).length;
  // 과목 상자 — 실제 시험지가 그렇듯 오른쪽에 크게 둔다. 글자 사이 간격은 CSS가 준다.
  const subject = h.subject || "영어";
  const form = set.label ? `<div class="exam-sheet-form">${esc(set.label)}</div>` : "";
  const line2 = [h.school, h.grade].filter(Boolean).map(esc).join(" · ");
  const info = [
    h.minutes ? `시험 시간 ${esc(h.minutes)}분` : "",
    count ? `총 ${count}문항` : "",
    h.teacher ? `출제 ${esc(h.teacher)}` : "",
  ].filter(Boolean);
  return `
    <div class="exam-sheet-head">
      <div class="exam-sheet-top">
        <div class="exam-sheet-id">
          ${h.title ? `<div class="exam-sheet-exam">${esc(h.title)}</div>` : ""}
          <div class="exam-sheet-school">${line2}</div>
        </div>
        <div class="exam-sheet-subject">
          <div class="exam-sheet-subject-name">${esc(subject)}</div>
          ${form}
        </div>
      </div>
      <div class="exam-sheet-bar">
        <span class="exam-sheet-info">${info.join(" · ")}</span>
        <span class="exam-sheet-fill">반 <u></u> 번호 <u></u> 성명 <u class="wide"></u></span>
      </div>
    </div>
  `;
}

/* '이 기출 구성 저장' 줄은 분석은 끝났는데 아직 시험지를 안 만들었을 때만 보인다.
   한 부라도 만들면 아래 '💾 사이트 저장'이 시험지와 구성표를 함께 담으므로 여기서 감춘다 —
   저장 버튼이 둘 보이면 어느 쪽이 무엇을 담는지 알 수 없다. */
function syncExamSpecSave() {
  const row = $("examSpecSaveRow");
  if (row) row.hidden = !(examScanNow && !examPaperSets.length);
}

function renderExamPaperSets() {
  syncExamSpecSave();
  // 인쇄/저장 버튼은 다른 탭과 같은 방식으로 '버튼 자체'를 감춘다 —
  // syncFloatPrint가 버튼의 style.display를 보고 떠 있는 인쇄 버튼을 켜고 끄기 때문이다.
  const showBtns = (on) => {
    $("examPaperPrintBtn").style.display = on ? "inline-flex" : "none";
    $("examPaperSaveBtn").style.display = on ? "inline-flex" : "none";
    $("examPaperDocxBtn").style.display = on ? "inline-flex" : "none";
  };
  if (!examPaperSets.length) {
    examPaperResultEl.innerHTML = "";
    showBtns(false);
    syncFloatPrint();
    return;
  }
  const jobs = examPlanNow ? examPlanNow.jobs : examPaperMgr.getJobs();
  examPaperResultEl.innerHTML = examPaperSets
    .map((set) => {
      // 머리글이 붙으면 그 안에 이미 학교·형(A/B)이 들어 있으므로 이름표는 빼서
      // 같은 말이 두 번 찍히지 않게 한다.
      const sheetHead = examSheetHeadHtml(set);
      const head = { name: set.label || "시험지", named: !sheetHead };
      const fails = (set.failed || []).length
        ? `<p class="hint warn">${set.failed.length}문항은 만들지 못해 빠졌습니다 — ` +
          esc(set.failed.map((f) => `${f.type}`).join(", ")) + `</p>`
        : "";
      return (
        fails +
        buildQuizHtml({ questions: set.questions, variations: [] }, head, 1, "mcq", "", sheetHead) +
        examPlanTableHtml(set.plan, jobs, `출제 지문${set.label ? " — " + set.label : ""}`)
      );
    })
    .join("");
  showBtns(true);
  syncFloatPrint();
}

/* 머리글 칸을 고치면 이미 만들어 둔 시험지에도 곧바로 반영한다 — 만든 뒤에 학교
   이름을 적어 넣는 순서가 자연스럽기 때문이다. input이 아니라 change로 듣는다:
   글자마다 결과물 전체를 다시 그리면 펼쳐 둔 정답·해설이 도로 닫힌다. */
Object.values(examHeadEls).forEach((el) => {
  if (el) el.addEventListener("change", () => renderExamPaperSets());
});

$("examPlanBtn").addEventListener("click", runExamPaperFlow);
$("examPaperPrintBtn").addEventListener("click", () =>
  printDoc(() => ["시험지", todayStr()].filter(Boolean).join("_"))
);

/* 시험지 워드 내보내기. 시험지 본문은 문제 탭과 같은 buildQuizHtml이 그리므로 변환도
   그대로 통한다. 배분표(.exam-plan)는 서버가 빼는데, 인쇄에서 빠지는 것과 같은 이유다 —
   '어느 문항을 어느 지문으로 만들었나'를 적은 제작 기록이라 학생에게 나갈 것이 아니다. */
$("examPaperDocxBtn").addEventListener("click", () =>
  downloadDocx({
    resultEl: examPaperResultEl,
    name: ["시험지", todayStr()].filter(Boolean).join("_"),
    answerHeading: "정답 및 해설",
    btn: $("examPaperDocxBtn"),
    errorEl: $("examPaperError") || null,
  })
);

/* ══════════════ 기출 구성표 — 저장할 수 있는 모양으로 ══════════════

   기출 분석 결과(examScanNow)에는 두 종류가 섞여 있다.

     ① 학교 시험지에서 읽어 낸 것 — title(고사 이름), no(문항 번호), group(묶음 범위),
        prompt(발문 원문), note(비고)
     ② 이 앱이 판정해 낸 것   — format(선다형/서답형), fit(같음/비슷함/없음),
        kind(앱 유형), engine(어느 탭)

   ①은 남의 저작물이라 저장하지 않는다. 그런데 시험지를 만드는 데 실제로 쓰이는 것은
   ②뿐이다 — examPaperSlots가 읽는 필드가 그 넷이 전부다. 그래서 ②만 남겨 두면
   '무슨 유형 몇 개'라는 주문서는 그대로 살면서 원본 시험지의 흔적은 남지 않는다.

   문항 줄은 못 만드는 것(fit "없음")까지 통째로 남긴다. 지우면 '기출 N문항은 여기서
   만들 수 없어 빠졌습니다' 안내의 숫자가 불러온 뒤 달라진다. 그 줄에 남는 값은
   format 하나뿐이라(kind·engine이 빈 문자열) 남겨도 학교를 가리키지 않는다. */
function examSpecFromScan(scan) {
  return {
    questions: ((scan && scan.questions) || []).map((q) => ({
      format: q.format,
      fit: q.fit,
      kind: q.kind,
      engine: q.engine,
    })),
  };
}

// 화면이 아는 유형 이름 — 저장본의 kind가 아직 살아 있는 이름인지 검사할 때 쓴다
const EXAM_KNOWN_KINDS = new Set([...MCQ_TYPES, ...SAQ_TYPES].map((t) => t.id));

/* 저장본 → 분석 결과 모양으로 되돌린다. ①은 빈 문자열로 채운다 — 화면의 기출 표는
   다시 그리지 않지만(그리려면 발문이 있어야 한다), 그 아래 제작 칸은 구성만으로 열린다.

   여기서 유형 이름을 한 번 더 검사하는 이유: 서버의 normalize_exam_scan이 같은 검사를
   하지만 그건 '분석하는 그 순간'에 한 번뿐이다. 저장본은 그 검사를 지나온 뒤 몇 달을
   묵을 수 있고, 그 사이 유형 목록이 바뀌면(이름 변경·삭제) 서버가 모르는 이름이 된다.
   그대로 두면 /api/quiz가 그 유형을 조용히 버려 문항이 소리 없이 빠진다.
   워크북 유형은 검사하지 않는다 — examPaperSlots가 어차피 걸러내 슬롯이 되지 않는다. */
function examSpecToScan(spec) {
  const stale = [];
  const questions = (Array.isArray(spec && spec.questions) ? spec.questions : []).map((raw) => {
    const q = {
      no: "", group: "", prompt: "", note: "",
      format: raw.format === "서답형" ? "서답형" : "선다형",
      fit: raw.fit || "없음",
      kind: raw.kind || "",
      engine: raw.engine || "",
    };
    if (q.kind && q.engine !== "워크북" && !EXAM_KNOWN_KINDS.has(q.kind)) {
      stale.push(q.kind);
      q.kind = "";
      q.fit = "없음";
      q.engine = "";
    }
    return q;
  });
  return { scan: { title: "", note: "", questions }, stale };
}

/* 저장 — 만든 문항과 '배분표', 그리고 기출 구성표를 넣는다.
   기출 시험지 자체(발문·문항 번호·고사 이름)는 저장하지 않는다. 들어가는 것은 이 앱이
   계산해 낸 배분 결과와 우리가 만든 문항, 그리고 위의 구성표뿐이다.
   배분표가 있어야 나중에 B형을 따로 만들 때 A형이 쓴 (지문, 유형)을 피할 수 있고
   (대원칙 2), 구성표가 있어야 기출을 다시 올리지 않고 그 B형을 만들 수 있다. */
TAB_SAVE.exam = {
  saveBtn: $("examPaperSaveBtn"),
  /* 시험지를 아직 안 만들었어도 구성표만으로 저장할 수 있다 — 분석은 1~3분이 걸리고
     값이 매겨지면 요금도 나가는데, 지문을 다 넣기 전에 새로고침하면 통째로 날아갔다. */
  canSave: () =>
    examPaperSets.length || examScanNow
      ? ""
      : "저장할 것이 없습니다. 기출 시험지를 올려 유형 분석을 먼저 해 주세요.",
  saveLead: () =>
    examPaperSets.length
      ? "만든 시험지와 배분표, 기출 구성표를 함께 저장합니다. " +
        "기출의 발문·문항 번호·고사 이름은 저장하지 않습니다."
      : "기출 구성표와 지금 입력칸에 있는 지문을 저장합니다 (아직 만든 시험지가 없습니다). " +
        "불러오면 기출을 다시 올리지 않고 이 구성 그대로 이어서 만들 수 있습니다. " +
        "기출의 발문·문항 번호·고사 이름은 저장하지 않습니다.",
  getPayload: () => ({
    passages: examPaperMgr.getJobs(),
    sets: examPaperSets,
    targetGrammar: examGrammarEl.value,
    // 머리글(학교명·고사명 등) — 불러온 시험지를 다시 인쇄해도 같은 모양이 되도록
    sheetHead: examHeadValues(),
    // 기출 구성표 — 발문·번호·고사 이름은 빼고 '무슨 유형 몇 개'만
    examSpec: examScanNow ? examSpecFromScan(examScanNow) : null,
  }),
  applyPayload: (payload) => {
    examPaperMgr.setJobs(payload.passages || []);
    examGrammarEl.value = payload.targetGrammar || "";
    // 머리글이 없던 시절에 저장한 것은 칸을 건드리지 않는다 (과목 기본값 '영어'가
    // 빈칸으로 지워지지 않게)
    if (payload.sheetHead) {
      Object.keys(examHeadEls).forEach((k) => {
        if (examHeadEls[k]) examHeadEls[k].value = payload.sheetHead[k] || "";
      });
    }
    examPaperSets = Array.isArray(payload.sets) ? payload.sets : [];
    examPlanNow = null;

    /* 구성표가 함께 저장돼 있으면 기출을 다시 올리지 않고 제작 칸을 연다.
       불러온 부의 배분표가 곧 '피해야 할 조합'이 되므로(대원칙 2), 여기서 곧바로
       B형을 이어 만들 수 있다. 구성표가 없는 옛 저장본은 예전처럼 인쇄·저장만 된다. */
    let notice = "";
    if (payload.examSpec) {
      const { scan, stale } = examSpecToScan(payload.examSpec);
      openExamPaperPanel(scan);   // examScanNow를 세우고 구성 안내를 다시 그린다
      if (stale.length) {
        const names = [...new Set(stale)].join(", ");
        notice =
          `저장한 뒤 유형 목록이 바뀌어 ${stale.length}문항이 빠졌습니다 — ${names}. ` +
          `없어졌거나 이름이 바뀐 유형이라 지금은 만들 수 없습니다. 남은 문항으로 만들거나, ` +
          `기출을 다시 올려 분석하면 지금 유형으로 다시 판정합니다.`;
      }
    } else {
      examScanNow = null;
      examPaperPanelEl.hidden = true;
      notice =
        "불러온 시험지를 인쇄·저장할 수 있습니다. 이어서 다른 부를 만들려면 위에서 기출 시험지를 다시 올려 분석하세요 " +
        "(구성표를 저장하기 전에 만든 시험지입니다). 그때 이 배분표를 피해 배분합니다.";
    }

    renderExamPaperSets();
    updateExamPaperCost();
    syncTabChrome("exam");
    examPaperErrorEl.textContent = notice;
  },
  clearResults: () => {
    examPaperSets = [];
    renderExamPaperSets();
  },
};
$("examPaperSaveBtn").addEventListener("click", () => openSaveDialog("exam"));
// 분석만 끝난 상태에서 누르는 저장 — 같은 저장 창을 쓴다. 무엇이 담기는지는
// saveLead가, 목록에서 어떻게 보일지는 SAVE_TITLE_SUGGEST가 경우에 맞춰 바꾼다.
$("examSpecSaveBtn").addEventListener("click", () => openSaveDialog("exam"));
