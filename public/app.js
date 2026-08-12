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
  } else {
    steps.push(
      "<b>고칠 곳이 있으면</b> 유형·문항 수·지문을 바꿔 <b>다시 만들어</b> 주세요. " +
        "이 탭은 화면에서 직접 고치는 기능이 아직 없습니다."
    );
  }
  steps.push("확인이 끝나면 <b>🖨️ 인쇄 / PDF 저장</b>, 나중에 다시 쓰려면 <b>💾 저장</b>.");
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
function costConfirmed(krw, label) {
  if (PRICING === null) return true;
  if (!Number.isFinite(krw) || krw <= 0) return true;
  const balanceLine = Number.isFinite(currentKrw)
    ? `지금 잔액: ${currentKrw.toLocaleString()}원 → 진행 후 약 ${(currentKrw - krw).toLocaleString()}원\n`
    : "";
  return confirm(
    `${label}\n\n예상 비용: ${krw.toLocaleString()}원\n${balanceLine}\n진행하시겠습니까?`
  );
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

$("openRechargeBtn").addEventListener("click", () => {
  rechargeErrorEl.textContent = "";
  rechargeCustomForm.hidden = true;
  rechargeCustomAmountEl.value = "";
  openModal(rechargeModalEl);
});
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

function updatePassageCount(ta) {
  const el = ta.closest(".passage-item").querySelector(".passage-count");
  const text = ta.value.trim();
  const n = text.length;
  el.classList.remove("warn", "danger");
  if (!n) {
    el.textContent = "0자";
    return;
  }
  let msg = `${n.toLocaleString()}자`;
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
// 올라가기 때문이다. 지문 10개면 분석에 대략 3~10분(꼼꼼 검토 시 2배).
const MAX_PASSAGES = 10;

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

function createPassageManager(listEl, addBtn, countEl, onEnter, maxNoteEl) {
  const rowCount = () => listEl.querySelectorAll(".passage-item").length;

  function renumber() {
    const items = [...listEl.querySelectorAll(".passage-item")];
    items.forEach((it, i) => {
      // 이름을 비워두면 '지문 1', '지문 2' … 가 자동으로 쓰인다(placeholder로 안내)
      it.querySelector(".passage-name").placeholder = `지문 ${i + 1}`;
      it.querySelector(".passage-del").style.visibility =
        items.length > 1 ? "visible" : "hidden";
    });
    const full = items.length >= MAX_PASSAGES;
    if (countEl) {
      countEl.textContent = full
        ? `· 총 ${items.length}개 (최대)`
        : items.length > 1
        ? `· 총 ${items.length}개`
        : "";
    }
    // 상한에 닿으면 '지문 추가' 버튼을 잠그고 이유를 화면에 띄운다 (삭제하면 다시 풀린다)
    addBtn.disabled = full;
    addBtn.title = full ? `1회 분석 최대 지문은 ${MAX_PASSAGES}개입니다.` : "";
    if (maxNoteEl) {
      maxNoteEl.textContent = full ? `1회 분석 최대 지문은 ${MAX_PASSAGES}개입니다.` : "";
    }
  }

  function addRow(focus) {
    if (rowCount() >= MAX_PASSAGES) return null;
    const item = document.createElement("div");
    item.className = "passage-item";
    item.innerHTML = `
      <div class="passage-item-head">
        <input type="text" class="passage-name" placeholder="지문 1" title="지문 이름 (비워두면 지문 1, 지문 2 …)">
        <span class="passage-count" aria-live="polite"></span>
        <button type="button" class="btn ghost small passage-expand" title="지문 전체를 한눈에 보기">🔍 크게 보기</button>
        <button type="button" class="btn ghost small passage-del" title="이 지문 삭제">✕ 삭제</button>
      </div>
      <textarea class="passage-input" placeholder="분석할 영어 지문을 여기에 붙여넣으세요."></textarea>
      <div class="passage-note" hidden></div>`;
    listEl.appendChild(item);
    const ta = item.querySelector(".passage-input");
    const nameEl = item.querySelector(".passage-name");
    const noteEl = item.querySelector(".passage-note");

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
      offerStrip();
      if (item.classList.contains("expanded")) fitExpanded(); // 넓힌 채로 계속 늘려 준다
    });
    updatePassageCount(ta);

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
      if (!ta || !job) return; // 상한(MAX_PASSAGES)에 걸리면 나머지는 건너뜀
      ta.value = job.text || "";
      if (job.named && job.name) {
        ta.closest(".passage-item").querySelector(".passage-name").value = job.name;
      }
      updatePassageCount(ta);
    });
    renumber();
  }

  // 사진에서 옮겨 온 지문을 입력칸에 채운다. 빈 칸부터 쓰고, 없으면 칸을 늘린다.
  // 사진 1장 = 지문 1개이므로 텍스트 하나가 칸 하나를 차지한다.
  // 반환: 실제로 채웠으면 true (상한 MAX_PASSAGES에 걸리면 false)
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

  return { addRow, getJobs, setJobs, renumber, clearAll, fillText };
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
  getPayload: () => ({ passages: passageMgr.getJobs() }),
  applyPayload: (payload) => {
    passageMgr.setJobs(payload.passages || []);
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

// 지문 패널에 사진을 끌어다 놓기
const passagePanelEl = document.querySelector(".passage-panel");
["dragenter", "dragover"].forEach((ev) =>
  passagePanelEl.addEventListener(ev, (e) => {
    if (![...((e.dataTransfer && e.dataTransfer.types) || [])].includes("Files")) return;
    e.preventDefault();
    passagePanelEl.classList.add("dropping");
  })
);
["dragleave", "drop"].forEach((ev) =>
  passagePanelEl.addEventListener(ev, (e) => {
    if (ev === "dragleave" && passagePanelEl.contains(e.relatedTarget)) return;
    passagePanelEl.classList.remove("dropping");
  })
);
passagePanelEl.addEventListener("drop", (e) => {
  const files = e.dataTransfer && e.dataTransfer.files;
  if (!files || !files.length) return;
  e.preventDefault();
  runOcr(files);
});

// ── 탭 전환 ──
const tabBtns = [...document.querySelectorAll(".tab-btn")];
const tabPages = [...document.querySelectorAll(".tab-page")];
function syncFloatPrint() {
  const active = document.querySelector(".tab-page.active");
  const btn =
    active &&
    active.querySelector(
      "#printBtn, #mcqPrintBtn, #saqPrintBtn, #workbookPrintBtn, #vocabPrintBtn"
    );
  floatPrintGroup.hidden = !(btn && btn.style.display !== "none");
}
// 떠 있는 버튼은 '지금 활성 탭'의 진짜 인쇄 버튼을 대신 눌러 준다.
// 그러면 각 탭이 자기 파일명 규칙을 그대로 갖고 있으므로 여기서 따로 만들 필요가 없다.
function activeSectionBtn(selector) {
  const active = document.querySelector(".tab-page.active");
  return active && active.querySelector(selector);
}
floatPrintBtn.addEventListener("click", () => {
  const b = activeSectionBtn("#printBtn, #mcqPrintBtn, #saqPrintBtn, #workbookPrintBtn, #vocabPrintBtn");
  if (b) b.click();
});
tabBtns.forEach((btn) => {
  btn.addEventListener("click", () => {
    tabBtns.forEach((b) => b.classList.toggle("active", b === btn));
    tabPages.forEach((p) => p.classList.toggle("active", p.id === `tab-${btn.dataset.tab}`));
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
    ? "색칠된 곳(한글 해석 · 루비 · 해설)만 고칠 수 있습니다. 되돌리기는 Ctrl+Z."
    : "";
  if (on) {
    const first = resultEl.querySelector('[contenteditable="true"]');
    if (first) first.focus();
  }
}

editBtn.addEventListener("click", () => {
  // 상태는 .editing 클래스로 판단한다. #result 자체는 더 이상 편집 대상이 아니라
  // contentEditable 값이 늘 "inherit"이어서 판단 근거가 될 수 없다.
  setEditMode(!resultEl.classList.contains("editing"));
});

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
  if (!costConfirmed(billableJobCount() * (PRICING ? PRICING.analyze : 0), "지문 분석을 시작합니다.")) {
    return;
  }

  analyzeBtn.disabled = true;
  addPassageBtn.disabled = true;
  clearPassagesBtn.disabled = true;
  loadingEl.classList.add("on");
  setEditMode(false); // 새로 분석하면 이전 수정 상태를 끈다 (내용도 새로 덮어써진다)
  resultEl.innerHTML = "";
  printBtn.style.display = "none";
  editBtn.style.display = "none";
  saveBtn.style.display = "none";
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
    saveBtn.style.display = "inline-flex";
  }
  syncFloatPrint();
  loadingEl.classList.remove("on");
  analyzeBtn.disabled = false;
  addPassageBtn.disabled = false;
  clearPassagesBtn.disabled = false;
  resultEl.scrollIntoView({ behavior: "smooth", block: "start" });
  refreshTokenDisplay(); // 성공한 만큼 차감됐을 잔액 표시를 갱신
  // 지문 분석은 '직접 수정'이 있는 유일한 탭이라 고치는 방법까지 안내한다
  if (okCount) showDoneGuide(`지문 ${okCount}개의 분석본`, true);
}

// "내 저장함"에서 불러온 분석 결과를 화면에 되살린다 — API를 다시 부르지 않고,
// 저장해 둔 원본 data를 그때와 같은 buildAnalysisHtml로 다시 그리기만 한다.
function renderAnalyzeEntries(entries) {
  const total = entries.length;
  const htmlParts = entries.map(({ job, data }, i) => buildAnalysisHtml(data, job, total, i));
  if (total) htmlParts.push(`<footer>구문 단위 직독직해 분석본 · 자동 생성</footer>`);
  setEditMode(false);
  resultEl.innerHTML = htmlParts.join("");
  printBtn.style.display = total ? "inline-flex" : "none";
  editBtn.style.display = total ? "inline-flex" : "none";
  saveBtn.style.display = total ? "inline-flex" : "none";
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
  }),
  applyPayload: (payload) => {
    passageMgr.setJobs(payload.passages || []);
    grammarEl.value = (payload.settings && payload.settings.targetGrammar) || "";
    if (reviewChk) reviewChk.checked = !!(payload.settings && payload.settings.review);
    renderAnalyzeEntries(payload.entries || []);
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
  parts.push(passageBanner(job, total));

  // 표지
  parts.push(`
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
      <div class="sent${topic}">
        <div class="sent-head"><span class="sent-no">${esc(s.no)}</span><span class="tag">${esc(s.tag)}</span><span class="exam-tags">${topicBadge}${examBadges}</span></div>
        <div class="chunks">${chunksHtml}</div>
        <div class="note"><span class="note-title">${esc(s.no)}번 해설</span>${safeHTML(s.note)}${
          s.examNote
            ? `<div class="exam-why"><span class="exam-why-title">🎯 출제 포인트</span>${safeHTML(s.examNote)}</div>`
            : ""
        }</div>
      </div>
    `);
  });

  // 요약표
  if (d.summary && d.summary.length) {
    const rows = d.summary.map(
      (r) => `<tr><td>${esc(r.label)}</td><td>${safeHTML(r.content)}</td></tr>`
    ).join("");
    parts.push(`
      <h3 class="section page-break"><span class="num">Ⅱ.</span> 주제 &amp; 흐름 요약</h3>
      <div class="table-wrap"><table class="flow"><tbody>${rows}</tbody></table></div>
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
      <h3 class="section"><span class="num">Ⅲ.</span> 핵심 어휘 &amp; 표현</h3>
      <div class="table-wrap"><table class="vocab">
        <thead><tr><th>단어 / 표현</th><th>품사</th><th>뜻</th><th>유의어</th><th>반의어</th></tr></thead>
        <tbody>${rows}</tbody>
      </table></div>
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
  { id: "내용일치(영)", def: false }, { id: "내용일치(한)", def: false },
  { id: "내용불일치(영)", def: false }, { id: "내용불일치(한)", def: false },
];
// 주관식(서술형·단답형) 유형
const SAQ_TYPES = [
  { id: "서술형배열", def: true }, { id: "OX진위(영)", def: true }, { id: "OX진위(한)", def: false },
  { id: "어휘 선택형", def: true }, { id: "어법 선택형", def: true },
  { id: "틀린 어휘 찾기", def: false }, { id: "틀린 어법 찾기", def: false },
  { id: "동사형 쓰기", def: false }, { id: "빈칸 쓰기", def: false },
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
  순서: 2, 문장삽입: 2, 함축의미: 2,
  // 주관식
  "OX진위(영)": 8, "OX진위(한)": 8,
  서술형배열: 6, "어휘 선택형": 6,
  "틀린 어휘 찾기": 5, "어법 선택형": 5, "틀린 어법 찾기": 3,
  "동사형 쓰기": 2, "빈칸 쓰기": 3,
};
// +버튼이 막혔을 때 왜 막혔는지 알려 준다 — 유형마다 상한이 다른 이유가 다르다.
const TYPE_MAX_REASON = {
  순서: "지문의 문장 수에 묶여 있어",
  문장삽입: "지문의 문장 수에 묶여 있어",
  함축의미: "지문에 비유·반어 표현이 든 문장 수 때문에",
  "동사형 쓰기": "한 문항이 이미 동사 4~6개를 가져가서",
  "빈칸 쓰기": "문맥으로 되살릴 수 있는 핵심어 수 때문에",
  어법: "지문에 실제로 있는 문법 포인트 수 때문에",
  "어법 선택형": "지문에 실제로 있는 문법 포인트 수 때문에",
  "틀린 어법 찾기": "지문에 실제로 있는 문법 포인트 수 때문에",
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
const MCQ_TRANSFORM_TYPES = new Set(["빈칸", "어휘", "어법", "순서", "문장삽입"]);

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
      if (!costConfirmed(cost, label)) return;
    }

    btn.disabled = true;
    addPassageBtn.disabled = true;
    clearPassagesBtn.disabled = true;
    loadingEl.classList.add("on");
    resultEl.innerHTML = "";
    printBtn.style.display = "none";
    saveBtn.style.display = "none";
    syncFloatPrint();

    // 완성될 때마다 화면에 붙인다. 도중에 멈추거나 창을 닫아도 그때까지 만든
    // 세트는 남아 인쇄까지 할 수 있다 (여기까지 쓴 토큰을 버리지 않기 위해).
    const showFooter = () => {
      if (!resultEl.querySelector(".qz-footer")) {
        resultEl.insertAdjacentHTML("beforeend", `<footer class="qz-footer">${esc(footer)} · 자동 생성</footer>`);
      }
      printBtn.style.display = "inline-flex";
      saveBtn.style.display = "inline-flex";
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
  if (fmt === "write") return esc(q.answerText || "");
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
    /* 동사형 쓰기 · 빈칸 쓰기 — (힌트|정답)을 (힌트)로 보여 주고, 아래에 번호별 답란을
       둔다. 표기와 렌더링은 워크북5(동사형 연습하기)와 같은 것을 쓴다. 두 유형은 힌트가
       동사 원형이냐 첫 철자냐만 다르고 구조가 같아 한 갈래로 묶는다. 답란을 번호로
       나누는 것은 내신 서답형이 (A)~(D)처럼 칸을 나눠 채점하기 때문이다. */
    const { html, answers } = renderVerbForms(q.passageHtml || "");
    const lines = answers
      .map((_, i) => `<div class="qz-fixline">(${i + 1}) ${wbBlank(220)}</div>`)
      .join("");
    return `
      <div class="qz-passage">${html}</div>
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
function buildQuizHtml(d, job, total, kind, label) {
  const parts = [];
  parts.push(`<section class="passage-block qz-block">`);
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
  if (!costConfirmed(billableJobCount() * workbookCost(stages.length), "워크북을 만듭니다.")) {
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
  // 지문 저장은 입력칸만 담으므로, 무엇이 저장되는지 문구로 분명히 해 둔다
  saveDialogLeadEl.textContent = tab === PASSAGE_TAB
    ? "지금 입력칸에 있는 지문만 저장합니다. 나중에 \"📄 지문 저장함\"에서 그대로 되불러올 수 있습니다."
    : "지문과 만든 결과를 함께 저장합니다. 나중에 \"📦 제작 자료 저장함\"에서 이 제목으로 다시 찾을 수 있습니다.";
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
        <button type="button" class="btn ghost small saved-list-load">불러오기</button>
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
    lead: "저장해 둔 지문입니다. 불러오면 지문 입력칸에 그대로 되돌아옵니다.",
    empty: "아직 저장한 지문이 없습니다. 지문을 입력한 뒤 “💾 지문 저장”을 눌러 보세요.",
    match: (item) => item.tab === PASSAGE_TAB,
  },
  material: {
    title: "📦 제작 자료 저장함",
    lead: "저장해 둔 분석본·문제·워크북·단어장입니다. 불러오면 지문·설정과 결과가 함께 되돌아와 다시 인쇄하거나 수정할 수 있습니다.",
    empty: "아직 저장한 제작 자료가 없습니다. 자료를 만든 뒤 각 탭의 “💾 저장”을 눌러 보세요.",
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

savedListBodyEl.addEventListener("click", async (e) => {
  const row = e.target.closest(".saved-list-item");
  if (!row) return;
  const id = row.dataset.id;

  if (e.target.closest(".saved-list-load")) {
    try {
      const item = await getJson(`/api/saved/${encodeURIComponent(id)}`, "불러오기에 실패했습니다.");
      const tab = item.tab;
      if (!TAB_SAVE[tab]) return;
      savedListModalEl.hidden = true;
      const tabBtn = document.querySelector(`.tab-btn[data-tab="${tab}"]`);
      if (tabBtn) tabBtn.click();
      // 불러오면 지문이 통째로 바뀌므로, 화면에 남아 있던 이전 제작 결과물은 모두
      // 지운다 — 안 그러면 방금 불러온 지문과 맞지 않는 결과물이 그대로 남아
      // 어느 지문으로 만든 것인지 알 수 없게 된다(지문만 불러온 경우가 특히 그랬다).
      clearAllTabResults();
      TAB_SAVE[tab].applyPayload(item.payload || {});
    } catch (err) {
      alert(err.message || "불러오기에 실패했습니다.");
    }
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

// 분석 결과에서 '이 유형 몇 문항'을 세어 [{id, count}]로 만든다.
// 유형별 상한(TYPE_MAX)을 넘길 수 없다 — 서버도 잘라내므로 넘겨 봐야 조용히 줄어든다.
// 워크북 단계는 문항 수라는 개념이 없다(고르면 지문 전체에 적용된다). 세기는 같이 하되
// 개수는 쓰지 않고 '고를 단계'로만 넘긴다.
function examTypeItems(questions, includeSimilar, engine) {
  const want = new Map();
  (questions || []).forEach((q) => {
    if (!q.kind) return;
    if (engine && q.engine !== engine) return;
    if (q.fit === "없음") return;
    if (q.fit === "비슷함" && !includeSimilar) return;
    want.set(q.kind, (want.get(q.kind) || 0) + 1);
  });
  return [...want].map(([id, n]) => ({ id, count: Math.min(n, TYPE_MAX[id] || 1) }));
}

// 워크북 탭의 단계 체크박스를 이름으로 찾아 켠다. 이름은 서버의
// WORKBOOK_STAGE_LABELS와 같은 값이어야 한다(WB_STAGES.name이 그 짝이다).
function setWorkbookStages(names) {
  const want = new Set(names || []);
  const ids = new Set(WB_STAGES.filter((s) => want.has(s.name)).map((s) => s.id));
  wbStageGridEl.querySelectorAll("input").forEach((b) => {
    b.checked = ids.has(Number(b.value));
  });
  syncWbAll();
  renumberWbStages();
  updateWbCostHint();
  return [...ids];
}

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

      <div class="actions exam-actions">
        <label class="chk" title="켜면 '비슷한 걸로 대체' 판정까지 포함해 유형을 채웁니다. 끄면 '그대로 만들 수 있음'만 채웁니다.">
          <input type="checkbox" id="examIncludeSimilar" checked> 비슷한 것도 포함
        </label>
        <button class="btn" id="examFillMcqBtn">📝 객관식 탭 채우기</button>
        <button class="btn" id="examFillSaqBtn">✍️ 주관식 탭 채우기</button>
        <button class="btn" id="examFillWbBtn">📚 워크북 탭 채우기</button>
      </div>
      <p class="hint exam-next">
        채운 뒤에는 위쪽 <b>영어 지문</b> 칸에 시험 범위 지문을 넣고, 해당 탭에서
        <b>문제 만들기</b>를 누르세요. 요금은 그 탭의 문항 수대로 매겨집니다.
      </p>
      <div class="exam-fill-note" id="examFillNote" role="status" aria-live="polite"></div>
    </section>`;

  const similarEl = $("examIncludeSimilar");
  const noteEl = $("examFillNote");

  function fill(tab) {
    const mine = examTypeItems(qs, similarEl.checked, tab);
    if (!mine.length) {
      noteEl.textContent = `이 시험지에서 ${tab} 탭으로 만들 수 있는 유형이 없습니다.`;
      noteEl.className = "exam-fill-note warn";
      return;
    }
    if (tab === "워크북") {
      // 워크북은 단계를 고르면 지문 전체에 적용된다 — 문항 수 개념이 없다.
      const on = setWorkbookStages(mine.map((it) => it.id));
      noteEl.textContent =
        `워크북 탭에 ${on.length}단계를 골랐습니다 (${mine.map((it) => it.id).join(", ")}). ` +
        `단계는 지문 전체에 적용되므로 문항 수가 아니라 '고른 단계'로 값이 매겨집니다. ` +
        `지문을 넣고 워크북 탭에서 만드세요.`;
    } else {
      const which = tab === "객관식" ? "mcq" : "saq";
      QUIZ_TABS[which].setTypes(mine);
      const total = mine.reduce((s, it) => s + it.count, 0);
      noteEl.textContent =
        `${tab} 탭에 ${mine.length}유형 ${total}문항을 채웠습니다 ` +
        `(${mine.map((it) => `${it.id} ${it.count}`).join(", ")}). ` +
        `지문을 넣고 ${tab} 탭에서 만드세요.`;
    }
    noteEl.className = "exam-fill-note ok";
  }

  $("examFillMcqBtn").addEventListener("click", () => fill("객관식"));
  $("examFillSaqBtn").addEventListener("click", () => fill("주관식"));
  $("examFillWbBtn").addEventListener("click", () => fill("워크북"));
}

async function runExamScan() {
  if (!examPages.length || examBusy) return;
  examErrorEl.textContent = "";
  if (PRICING && PRICING.examScan > 0) {
    if (!costConfirmed(PRICING.examScan, `기출 시험지 ${examPages.length}쪽을 분석합니다.`)) return;
  }
  examBusy = true;
  examBtn.disabled = true;
  examLoadingEl.classList.add("on");
  examLoadingTextEl.textContent =
    `AI가 시험지 ${examPages.length}쪽을 읽고 있습니다… (1~3분 걸립니다)`;
  examResultEl.innerHTML = "";
  try {
    const scan = await postJson("/api/examscan", { files: examPages }, "시험지 분석에 실패했습니다.");
    renderExamScan(scan);
    refreshTokenDisplay();  // 분석에 요금이 나갔으므로 잔액 표시만 갱신(화면은 그대로)
  } catch (err) {
    examErrorEl.textContent = err.message || String(err);
  }
  examLoadingEl.classList.remove("on");
  examBusy = false;
  examBtn.disabled = !examPages.length;
}

examBtn.addEventListener("click", runExamScan);
