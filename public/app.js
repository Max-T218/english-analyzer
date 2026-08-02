"use strict";

// ── 열 때마다 완전 초기화 ──────────────────────────────────────────────
// 창을 새로 열면 API 키·지문·학원 마크·모델 설정·단어장 데이터까지 전부 비운다.
// 공용 PC에서 앞사람 흔적이 남지 않게 하려는 것으로, 아래의 모든 초기화 코드보다
// 먼저 실행되어야 하므로 파일 맨 위에 둔다.
// (한 세션 안에서의 저장은 그대로 동작한다 — 예: 지문 분석 결과의 어휘를 단어장
//  탭이 이어받는 흐름. 다만 새로고침하면 함께 사라진다.)
try {
  localStorage.clear();
} catch (_) {
  /* 사생활 보호 모드 등에서 접근이 막혀도 앱은 그대로 동작 */
}

const $ = (id) => document.getElementById(id);
const apiKeyEl = $("apiKey");
const toggleKeyEl = $("toggleKey");
const passageListEl = $("passageList");
const addPassageBtn = $("addPassageBtn");
const passageCountEl = $("passageCount");
const grammarEl = $("targetGrammar");
const modelEl = $("model");
const analyzeBtn = $("analyzeBtn");
const printBtn = $("printBtn");
const floatPrintBtn = $("floatPrintBtn");
const reviewChk = $("reviewChk");
const errorEl = $("error");
const loadingEl = $("loading");
const loadingTextEl = $("loadingText");
const resultEl = $("result");

const KEY_STORE = "gemini_api_key";

const modelStatusEl = $("modelStatus");

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
function isQuotaError(err) {
  if (err && err.code === "quota") return true;
  const msg = (err && err.message) || String(err || "");
  return /한도|quota|exceeded|429/i.test(msg);
}

// 한도로 중단했을 때 남은 지문을 알려 주는 안내 카드
function quotaStopHtml(left) {
  return `<section class="passage-block"><div class="passage-error">
    <b>한도 초과로 중단했습니다</b>
    남은 지문 ${left}개는 시도하지 않았습니다. 지금은 다시 시도해도 같은 결과라
    시간만 걸리기 때문입니다. 한도가 리셋된 뒤 이어서 진행하세요.
  </div></section>`;
}

// 저장된 키 불러오기
apiKeyEl.value = localStorage.getItem(KEY_STORE) || "";
// 입력 시 자동 저장 + 모델 목록 자동 갱신(디바운스)
let keyTimer = null;
apiKeyEl.addEventListener("input", () => {
  const v = apiKeyEl.value.trim();
  if (v) localStorage.setItem(KEY_STORE, v);
  else localStorage.removeItem(KEY_STORE);
  clearTimeout(keyTimer);
  keyTimer = setTimeout(loadModels, 800);
});

// 이 키로 실제 사용 가능한 모델을 불러와 드롭다운을 채움 (모델 지원 중단 대비)
async function loadModels() {
  const apiKey = apiKeyEl.value.trim();
  if (!apiKey) return;
  modelStatusEl.textContent = "· 모델 목록 불러오는 중…";
  try {
    const data = await postJson(
      "/api/models", { apiKey }, "모델 목록을 불러오지 못했습니다."
    );
    if (!data.models || !data.models.length) {
      modelStatusEl.textContent = "";
      return;
    }
    const saved = localStorage.getItem(MODEL_STORE);
    modelEl.innerHTML = "";
    for (const m of data.models) {
      const opt = document.createElement("option");
      opt.value = m.id;
      opt.textContent = `${m.label} (${m.id})`;
      modelEl.appendChild(opt);
    }
    let pick = "";
    if (saved && data.models.some((m) => m.id === saved)) pick = saved;
    if (!pick) {
      const flash = data.models.find((m) => /flash/i.test(m.id));
      pick = flash ? flash.id : data.models[0].id;
    }
    modelEl.value = pick;
    modelStatusEl.textContent = `· 사용 가능 ${data.models.length}개`;
  } catch (_) {
    modelStatusEl.textContent = "";
  }
}
toggleKeyEl.addEventListener("click", () => {
  apiKeyEl.type = apiKeyEl.type === "password" ? "text" : "password";
});

// 모델 선택 기억
const MODEL_STORE = "gemini_model";
const savedModel = localStorage.getItem(MODEL_STORE);
if (savedModel) modelEl.value = savedModel;
modelEl.addEventListener("change", () => {
  localStorage.setItem(MODEL_STORE, modelEl.value);
});

loadModels(); // 저장된 키가 있으면 시작 시 사용 가능한 모델을 불러옴

/* ══════════════════════════ 시작 화면(소개 + 키 입력) ══════════════════════════ */
// 처음 들어온 사람이 무슨 사이트인지 알 수 있도록 소개를 먼저 보여주고,
// 키를 확인한 뒤에야 작업 화면으로 넘어간다.
const gateEl = $("gate");
const workspaceEl = $("workspace");
const gateStartBtn = $("gateStartBtn");
const gateStatusEl = $("gateStatus");
const gateErrorEl = $("gateError");
const changeKeyBtn = $("changeKeyBtn");

function showGate() {
  gateEl.hidden = false;
  workspaceEl.hidden = true;
  gateErrorEl.textContent = "";
  gateStatusEl.textContent = "";
  window.scrollTo({ top: 0 });
  apiKeyEl.focus();
}

function enterWorkspace() {
  gateEl.hidden = true;
  workspaceEl.hidden = false;
  window.scrollTo({ top: 0 });
}

async function startWithKey() {
  const key = apiKeyEl.value.trim();
  gateErrorEl.textContent = "";
  if (!key) {
    gateErrorEl.textContent = "API 키를 입력하세요.";
    apiKeyEl.focus();
    return;
  }
  gateStartBtn.disabled = true;
  gateStatusEl.textContent = "키 확인 중…";
  try {
    // 실제로 쓸 수 있는 키인지 모델 목록으로 확인한다(문항 생성과 달리 사용량이 거의 없다)
    const data = await postJson("/api/models", { apiKey: key }, "키를 확인하지 못했습니다.");
    if (!data.models || !data.models.length) throw new Error("이 키로 쓸 수 있는 모델이 없습니다.");
    await loadModels();
    enterWorkspace();
  } catch (err) {
    // 확인에 실패하면 들여보내지 않는다. 틀린 키로 들어가 봐야 이후 작업이 모두
    // 실패할 뿐이고, 그때는 원인이 훨씬 알기 어려워진다.
    // (키 확인에 쓰는 모델 목록 조회는 생성과 별개 경로라, 생성 한도가 소진된
    //  상태에서도 정상 동작한다 — 한도 때문에 못 들어가는 일은 없다.)
    const msg = err.message || String(err);
    gateErrorEl.textContent =
      /Failed to fetch|NetworkError|HTTP 5\d\d/i.test(msg)
        ? `서버에 연결하지 못했습니다. 잠시 뒤 다시 시도하세요. (${msg})`
        : `${msg} 키를 다시 확인해 주세요.`;
    apiKeyEl.focus();
    apiKeyEl.select();
  } finally {
    gateStartBtn.disabled = false;
    gateStatusEl.textContent = "";
  }
}

gateStartBtn.addEventListener("click", startWithKey);
apiKeyEl.addEventListener("keydown", (e) => {
  if (e.key === "Enter" && !gateEl.hidden) startWithKey();
});
changeKeyBtn.addEventListener("click", showGate);

// ── 학원 마크(로고) — 고정 파일 대신 사용자가 업로드해 이 브라우저에 저장 ──
const BRAND_IMG_STORE = "brand_mark_img";   // data URL
const BRAND_NAME_STORE = "brand_mark_name"; // 학원명 텍스트
const BRAND_MAX_BYTES = 5 * 1024 * 1024;    // 5MB — localStorage 용량 보호
const brandNameEl = $("brandName");
const brandFileEl = $("brandFile");
const brandPreviewEl = $("brandPreview");
const brandRemoveBtn = $("brandRemoveBtn");
const brandMarkEl = $("brandMark");
const brandTopEl = $("printBrandTop");

function renderBrand() {
  const img = localStorage.getItem(BRAND_IMG_STORE) || "";
  const name = (localStorage.getItem(BRAND_NAME_STORE) || "").trim();

  // 학원명 — 모든 인쇄 페이지 상단 중앙
  if (brandTopEl) brandTopEl.textContent = name;

  // 로고 — 모든 인쇄 페이지 우하단 (학원명은 위로 갔으므로 여기선 로고만)
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
const PASSAGE_WARN = 1000;   // 이 이상이면 나누는 걸 권함
const PASSAGE_DANGER = 1800; // 이 이상이면 강하게 권함
// 서버의 문장 수 추정(_SENT_END_RE)과 같은 규칙 — 다음이 대문자이거나 문장 끝일 때만 종결로 본다
const SENT_END_RE = /[.!?]+(?=\s+["'(\[]?[A-Z]|\s*$)/g;

function updatePassageCount(ta) {
  const el = ta.closest(".passage-item").querySelector(".passage-count");
  const text = ta.value.trim();
  const n = text.length;
  el.classList.remove("warn", "danger");
  if (!n) {
    el.textContent = "0자";
    return;
  }
  const sents = Math.max((text.replace(/\d\.\d/g, "00").match(SENT_END_RE) || []).length, 1);
  let msg = `${n.toLocaleString()}자 · 약 ${sents}문장`;
  if (n > PASSAGE_DANGER) {
    el.classList.add("danger");
    msg += " · 나눠 넣으세요";
  } else if (n > PASSAGE_WARN) {
    el.classList.add("warn");
    msg += " · 워크북은 나누는 게 좋아요";
  }
  el.textContent = msg;
}

// 한 번에 넣을 수 있는 지문 수 상한.
// API 사용량 한도 때문이 아니라(하루 한도는 훨씬 넉넉하다) 지문을 하나씩 순차로
// 처리해서 개수만큼 시간이 늘고, 오래 돌수록 중간에 모델 과부하를 만날 확률이
// 올라가기 때문이다. 지문 10개면 분석에 대략 3~10분(꼼꼼 검토 시 2배).
const MAX_PASSAGES = 10;

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
        <button type="button" class="btn ghost small passage-del" title="이 지문 삭제">✕ 삭제</button>
      </div>
      <textarea class="passage-input" placeholder="분석할 영어 지문을 여기에 붙여넣으세요."></textarea>`;
    listEl.appendChild(item);
    const ta = item.querySelector(".passage-input");
    const nameEl = item.querySelector(".passage-name");
    ta.addEventListener("keydown", (e) => {
      if ((e.ctrlKey || e.metaKey) && e.key === "Enter" && onEnter) onEnter();
    });
    nameEl.addEventListener("keydown", (e) => {
      if ((e.ctrlKey || e.metaKey) && e.key === "Enter" && onEnter) onEnter();
    });
    ta.addEventListener("input", () => updatePassageCount(ta));
    updatePassageCount(ta);
    item.querySelector(".passage-del").addEventListener("click", () => {
      item.remove();
      renumber();
    });
    renumber();
    if (focus) ta.focus();
    return ta;
  }

  addBtn.addEventListener("click", () => addRow(true));

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

  return { addRow, getJobs, renumber };
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
  floatPrintBtn.hidden = !(btn && btn.style.display !== "none");
}
tabBtns.forEach((btn) => {
  btn.addEventListener("click", () => {
    tabBtns.forEach((b) => b.classList.toggle("active", b === btn));
    tabPages.forEach((p) => p.classList.toggle("active", p.id === `tab-${btn.dataset.tab}`));
    syncFloatPrint();
  });
});

// ── 모델별 "오늘 사용량" 추적 ──

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
printBtn.addEventListener("click", () => window.print());
floatPrintBtn.addEventListener("click", () => window.print());
syncFloatPrint(); // 초기 탭(지문 분석) 기준으로 상태 맞춤

async function analyze() {
  const apiKey = apiKeyEl.value.trim();
  errorEl.textContent = "";
  if (!apiKey) {
    errorEl.textContent = "먼저 Gemini API 키를 입력하세요.";
    apiKeyEl.focus();
    return;
  }

  const jobs = passageMgr.getJobs();
  if (!jobs.length) {
    errorEl.textContent = "분석할 영어 지문을 입력하세요.";
    return;
  }

  analyzeBtn.disabled = true;
  addPassageBtn.disabled = true;
  loadingEl.classList.add("on");
  setEditMode(false); // 새로 분석하면 이전 수정 상태를 끈다 (내용도 새로 덮어써진다)
  resultEl.innerHTML = "";
  printBtn.style.display = "none";
  editBtn.style.display = "none";
  syncFloatPrint();

  const total = jobs.length;
  const usedModel = modelEl.value;
  const reviewOn = !!(reviewChk && reviewChk.checked);
  let okCount = 0;
  const htmlParts = []; // 결과를 모아뒀다가 모두 끝난 뒤 한 번에 렌더
  const vocabSets = []; // 단어장 탭이 쓸 지문별 핵심 어휘
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
          model: modelEl.value,
          review: reviewOn,
          apiKey,
        },
        "분석에 실패했습니다."
      );
      htmlParts.push(buildAnalysisHtml(data, job, total));
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
        if (left > 0) htmlParts.push(quotaStopHtml(left));
        break;
      }
    }
  }

  if (okCount) htmlParts.push(`<footer>구문 단위 직독직해 분석본 · 자동 생성</footer>`);
  if (vocabSets.length) saveVocabSets(vocabSets); // 단어장 탭에서 재사용
  // 모든 지문 분석이 끝난 뒤 한 번에 렌더 (중간에 화면이 바뀌지 않도록)
  resultEl.innerHTML = htmlParts.join("");
  if (okCount) {
    printBtn.style.display = "inline-flex";
    editBtn.style.display = "inline-flex";
  }
  syncFloatPrint();
  loadingEl.classList.remove("on");
  analyzeBtn.disabled = false;
  addPassageBtn.disabled = false;
  resultEl.scrollIntoView({ behavior: "smooth", block: "start" });
}

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
function buildErrorHtml(job, total, msg) {
  const head = total > 1 || job.named ? `${job.name} 분석 실패` : "분석 실패";
  return `<section class="passage-block"><div class="passage-error"><b>${esc(head)}</b>${esc(msg)}</div></section>`;
}

// 결과 상단에 지문 이름표를 붙일지 (여러 지문이거나, 직접 이름을 지었을 때)
function passageBanner(job, total) {
  return total > 1 || job.named
    ? `<div class="passage-banner">${esc(job.name)}</div>`
    : "";
}

// 한 지문의 전체 분석본 HTML을 문자열로 만든다 (여러 지문을 이어붙이기 위함)
function buildAnalysisHtml(d, job, total) {
  const parts = [];
  parts.push(`<section class="passage-block">`);
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
        <b><span class="dot" style="background:var(--conj)"></span><span class="conj-hl">병렬구조</span></b>
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
  { id: "순서", def: false }, { id: "문장삽입", def: false },
  { id: "내용일치(영)", def: false }, { id: "내용일치(한)", def: false },
  { id: "내용불일치(영)", def: false }, { id: "내용불일치(한)", def: false },
];
// 주관식(서술형·단답형) 유형
const SAQ_TYPES = [
  { id: "서술형배열", def: true }, { id: "OX진위", def: true },
  { id: "어휘 선택형", def: true }, { id: "어법 선택형", def: true },
  { id: "틀린 어휘 찾기", def: false }, { id: "틀린 어법 찾기", def: false },
];

// 문제 제작 탭 하나를 구성한다 (객관식·주관식이 같은 로직을 공유)
function setupQuizTab({ prefix, types, footer }) {
  const gridEl = $(prefix + "TypeGrid");
  const allEl = $(prefix + "TypeAll");
  const countEl = $(prefix + "Count");
  const countHintEl = $(prefix + "CountHint");
  const fitBtn = $(prefix + "FitBtn");
  const btn = $(prefix + "Btn");
  const printBtn = $(prefix + "PrintBtn");
  const errorEl = $(prefix + "Error");
  const loadingEl = $(prefix + "Loading");
  const loadingTextEl = $(prefix + "LoadingText");
  const resultEl = $(prefix + "Result");
  const orderEl = $(prefix + "Order");
  const orderHintEl = $(prefix + "OrderHint");
  const ORDER_STORE = "gemini_" + prefix + "_order";

  // 유형 체크박스 생성
  types.forEach((t) => {
    const label = document.createElement("label");
    label.innerHTML =
      `<input type="checkbox" value="${esc(t.id)}" ${t.def ? "checked" : ""}>` +
      `<span class="type-no"></span><span>${esc(t.id)}</span>`;
    gridEl.appendChild(label);
  });

  // 출제 순서 — "type"(유형 순서대로) / "random"(무작위로 섞기)
  const isRandom = () => orderEl.value === "random";

  // 체크한 유형에 출제 순서 번호를 매긴다.
  // 문항을 서버에 보낼 때도 이 순서(DOM 순서)로 보내고, 서버가 같은 순서로 출제하도록
  // 프롬프트에 명시했으므로 여기 번호 = 문제지에 나오는 순서.
  // 무작위 모드에서는 번호가 실제 순서와 달라지므로 아예 붙이지 않는다.
  function renumberTypes() {
    const rnd = isRandom();
    let n = 0;
    gridEl.querySelectorAll("label").forEach((label) => {
      const on = label.querySelector("input").checked;
      label.querySelector(".type-no").textContent = on && !rnd ? `${++n}.` : "";
      label.classList.toggle("picked", on);
    });
  }

  function updateOrderHint() {
    orderHintEl.innerHTML = isRandom()
      ? "유형과 상관없이 문항이 <b>무작위로 섞여</b> 출제됩니다. 문제지 번호는 섞인 순서대로 1번부터 매겨집니다."
      : "체크한 유형 앞의 <b>번호가 출제 순서</b>입니다. 문제지도 이 순서대로 만들어집니다.";
  }

  orderEl.value = localStorage.getItem(ORDER_STORE) === "random" ? "random" : "type";
  orderEl.addEventListener("change", () => {
    localStorage.setItem(ORDER_STORE, orderEl.value);
    renumberTypes();
    updateOrderHint();
  });
  updateOrderHint();

  // 전체 선택 / 전체 해제 (일부만 선택된 상태는 '중간' 표시)
  function syncAll() {
    const boxes = [...gridEl.querySelectorAll("input")];
    const on = boxes.filter((b) => b.checked).length;
    allEl.checked = on === boxes.length;
    allEl.indeterminate = on > 0 && on < boxes.length;
  }
  // 문항 수 규칙: 선택한 유형은 최소 1문항씩 나와야 하므로
  //   · 하한 = 체크한 유형 수 (그 아래로는 못 내려감)
  //   · 유형을 체크하면 문항 수가 자동으로 따라 올라감
  //   · 사용자가 더 늘리는 것은 자유 (최대 30) → 유형을 반복해 더 많이 출제
  const MAX_COUNT = 30;
  const typeCount = () => gridEl.querySelectorAll("input:checked").length;

  function updateHint() {
    const n = typeCount();
    const c = parseInt(countEl.value, 10) || 0;
    let msg, cls = "";
    if (!n) {
      msg = "유형을 선택하세요";
      cls = "warn";
    } else if (c < n) {
      msg = `선택 유형 ${n}개 · 최소 ${n}문항`;
      cls = "warn";
    } else if (c === n) {
      msg = `선택 유형 ${n}개 · 유형당 1문항`;
    } else {
      const per = (c / n).toFixed(1).replace(/\.0$/, "");
      msg = `선택 유형 ${n}개 · 유형당 약 ${per}문항`;
    }
    countHintEl.textContent = msg;
    countHintEl.className = "count-hint" + (cls ? " " + cls : "");
  }

  // 입력을 마쳤을 때(blur/Enter) 하한·상한으로 보정 — 타이핑 도중에는 건드리지 않는다
  function clampCount() {
    const n = Math.max(1, typeCount());
    let c = parseInt(countEl.value, 10);
    if (!Number.isFinite(c) || c < n) c = n;
    if (c > MAX_COUNT) c = MAX_COUNT;
    countEl.value = c;
    updateHint();
  }

  // 유형 선택이 바뀌면 하한과 문항 수를 체크한 유형 수에 맞춘다.
  // 체크하면 올라가고, 해제하면 같이 내려간다. (원하면 그 뒤에 직접 더 늘릴 수 있음)
  function syncCount() {
    const n = Math.max(1, typeCount());
    countEl.min = n;
    countEl.value = n;
    updateHint();
  }

  allEl.addEventListener("change", () => {
    const check = allEl.checked;
    gridEl.querySelectorAll("input").forEach((b) => (b.checked = check));
    syncAll();
    syncCount();
    renumberTypes();
  });
  gridEl.addEventListener("change", () => {
    syncAll();
    syncCount();
    renumberTypes();
  });
  countEl.addEventListener("input", updateHint);   // 타이핑 중에는 안내만
  countEl.addEventListener("change", clampCount);  // 확정되면 하한으로 보정
  fitBtn.addEventListener("click", () => {
    countEl.value = Math.max(1, typeCount());
    updateHint();
  });
  syncAll();
  syncCount();
  renumberTypes();

  async function generate() {
    const apiKey = apiKeyEl.value.trim();
    errorEl.textContent = "";
    if (!apiKey) {
      errorEl.textContent = "먼저 Gemini API 키를 입력하세요.";
      apiKeyEl.focus();
      return;
    }
    const jobs = passageMgr.getJobs();
    if (!jobs.length) {
      errorEl.textContent = "문제를 만들 영어 지문을 입력하세요.";
      return;
    }
    const picked = [...gridEl.querySelectorAll("input:checked")].map((i) => i.value);
    if (!picked.length) {
      errorEl.textContent = "출제 유형을 하나 이상 선택하세요.";
      return;
    }
    // 선택한 유형은 최소 1문항씩 보장 (하한 = 유형 수), 상한 30
    clampCount();
    const count = Math.min(
      Math.max(parseInt(countEl.value, 10) || picked.length, picked.length),
      MAX_COUNT
    );

    btn.disabled = true;
    addPassageBtn.disabled = true;
    loadingEl.classList.add("on");
    resultEl.innerHTML = "";
    printBtn.style.display = "none";
    syncFloatPrint();

    const total = jobs.length;
    const usedModel = modelEl.value;
    let okCount = 0;
    const htmlParts = [];
    for (let i = 0; i < total; i++) {
      const job = jobs[i];
      loadingTextEl.textContent =
        total > 1
          ? `${job.name} 문제 만드는 중… (${i + 1}/${total})`
          : "AI가 문제를 만들고 있습니다… (유형·문항 수에 따라 시간이 걸릴 수 있어요)";

      if (job.text.length < 20) {
        htmlParts.push(buildErrorHtml(job, total, "지문이 너무 짧습니다 (20자 이상 입력)."));
        continue;
      }

      try {
        const data = await postJson(
          "/api/quiz",
          { passage: job.text, types: picked, count, model: modelEl.value, apiKey },
          "문제 생성에 실패했습니다."
        );
        // 무작위 모드 — 받아온 문항을 섞는다. 지문마다 다시 섞이고, 문제지 번호와
        // 정답표 번호는 buildQuizHtml이 섞인 순서로 함께 매기므로 어긋나지 않는다.
        if (isRandom() && Array.isArray(data.questions)) {
          data.questions = seededShuffle(data.questions, Math.floor(Math.random() * 1e9));
        }
        htmlParts.push(buildQuizHtml(data, job, total));
        okCount++;
      } catch (err) {
        const msg = err.message || String(err);
        htmlParts.push(buildErrorHtml(job, total, msg));
        // 한도 소진은 기다려도 안 풀린다 — 남은 지문을 시도하지 않고 즉시 멈춘다
        if (isQuotaError(err)) {
            const left = total - (i + 1);
          if (left > 0) htmlParts.push(quotaStopHtml(left));
          break;
        }
      }
    }

    if (okCount) htmlParts.push(`<footer>${esc(footer)} · 자동 생성</footer>`);
    resultEl.innerHTML = htmlParts.join("");
    if (okCount) printBtn.style.display = "inline-flex";
    syncFloatPrint();
    loadingEl.classList.remove("on");
    btn.disabled = false;
    addPassageBtn.disabled = false;
    resultEl.scrollIntoView({ behavior: "smooth", block: "start" });
  }

  btn.addEventListener("click", generate);
  printBtn.addEventListener("click", () => window.print());
}

setupQuizTab({ prefix: "mcq", types: MCQ_TYPES, footer: "수능형 객관식 문제" });
setupQuizTab({ prefix: "saq", types: SAQ_TYPES, footer: "서술형·단답형 문제" });

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
    // 서술형 배열 — 우리말을 보고, 섞인 단어로 문장 완성
    const scrambled = scrambleSentence(q.answerText || "", q.no || 1);
    return `
      <div class="qz-passage">${safeHTML(q.passageHtml)}</div>
      <div class="qz-scramble">( ${scrambled} )</div>
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

// 문제 카드 + 정답/해설(화면: 토글, 인쇄: 항상 별도 섹션) HTML 생성
function buildQuizHtml(d, job, total) {
  const parts = [];
  parts.push(`<section class="passage-block qz-block">`);
  parts.push(passageBanner(job, total));

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
        ${quizBodyHtml(q)}
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
    const anyExp = d.questions.some(hasExp);
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
      <h3 class="section page-break"><span class="num">📌</span> 정답 및 해설</h3>
      <div class="table-wrap"><table class="answerkey">
        <thead><tr><th>번호</th><th>유형</th><th>정답</th>${expHead}</tr></thead>
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

// 지원 단계 — 참고 자료(10단계 워크북)의 번호·명칭을 그대로 사용
const WB_STAGES = [
  { id: 3, name: "빈칸 연습 (영문)", guide: "우리말 해석을 보고 영문을 완성하시오.", def: true },
  { id: 4, name: "해석 연습", guide: "영어 문장을 읽고 우리말 해석을 쓰시오.", def: true },
  { id: 5, name: "동사형 연습", guide: "괄호 안에 주어진 단어를 알맞게 고쳐 쓰시오.", def: true },
  { id: 6, name: "어법 선택형 연습", guide: "괄호 안에서 어법상 알맞은 것을 고르시오.", def: true },
  { id: 7, name: "어색한 곳 찾기 연습", guide: "밑줄 친 부분 중 문맥상 어색한 것을 찾아 바르게 고쳐 쓰시오.", def: true },
  { id: 8, name: "순서배열 연습 (문장)", guide: "우리말과 같은 뜻이 되도록 주어진 단어를 알맞게 배열하시오.", def: true },
  { id: 9, name: "영작 연습", guide: "우리말과 같은 뜻이 되도록 주어진 단어를 사용하여 영작하시오.", def: true },
];

const wbStageGridEl = $("wbStageGrid");
WB_STAGES.forEach((s) => {
  const label = document.createElement("label");
  label.innerHTML = `<input type="checkbox" value="${s.id}" ${s.def ? "checked" : ""}> ${s.id}. ${esc(s.name)}`;
  wbStageGridEl.appendChild(label);
});

const wbBtn = $("wbBtn");
const wbErrorEl = $("wbError");
const wbLoadingEl = $("wbLoading");
const wbLoadingTextEl = $("wbLoadingText");
const wbTitleEl = $("wbTitle");
const wbAnswerChk = $("wbAnswerChk");
const workbookDocEl = $("workbookDoc");
const workbookPrintBtn = $("workbookPrintBtn");
const wbAnswerPrintBtn = $("wbAnswerPrintBtn");


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
workbookPrintBtn.addEventListener("click", () => window.print());

// 답지만 인쇄 — 문제 내용을 감추고 번호와 정답만 지면에 올린다.
// 다시 그리지 않고 클래스만 바꾸므로, 섞인 보기·순서가 학생용 문제지와 정확히 일치한다.
// '정답 표시' 체크와 무관하게 항상 정답이 나오고, 인쇄가 끝나면 원래 화면으로 돌아온다.
function printWorkbookAnswers() {
  workbookDocEl.classList.add("answers-only");
  let done = false;
  const restore = () => {
    if (done) return;
    done = true;
    workbookDocEl.classList.remove("answers-only");
    window.removeEventListener("afterprint", restore);
  };
  window.addEventListener("afterprint", restore);
  setTimeout(restore, 60000); // afterprint를 안 보내는 브라우저 대비 안전장치
  window.print();
}
wbAnswerPrintBtn.addEventListener("click", printWorkbookAnswers);

async function generateWorkbook() {
  const apiKey = apiKeyEl.value.trim();
  wbErrorEl.textContent = "";
  if (!apiKey) {
    wbErrorEl.textContent = "먼저 Gemini API 키를 입력하세요.";
    apiKeyEl.focus();
    return;
  }
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

  wbBtn.disabled = true;
  addPassageBtn.disabled = true;
  wbLoadingEl.classList.add("on");
  workbookDocEl.innerHTML = "";
  workbookPrintBtn.style.display = "none";
  wbAnswerPrintBtn.style.display = "none";
  syncFloatPrint();

  const total = jobs.length;
  const usedModel = modelEl.value;
  let okCount = 0;
  const htmlParts = [];
  const title = wbTitleEl.value.trim();
  if (title) {
    htmlParts.push(`
      <div class="wb-cover">
        <h1>${esc(title)}</h1>
        <div class="wb-date">${esc(new Date().toLocaleDateString("ko-KR"))}</div>
      </div>`);
  }

  for (let i = 0; i < total; i++) {
    const job = jobs[i];
    wbLoadingTextEl.textContent =
      total > 1
        ? `${job.name} 워크북 만드는 중… (${i + 1}/${total})`
        : "AI가 워크북을 만들고 있습니다… (지문 길이에 따라 30~90초 걸릴 수 있어요)";

    if (job.text.length < 20) {
      htmlParts.push(buildErrorHtml(job, total, "지문이 너무 짧습니다 (20자 이상 입력)."));
      continue;
    }

    try {
      const data = await postJson(
        "/api/workbook",
        { passage: job.text, model: modelEl.value, apiKey },
        "워크북 생성에 실패했습니다."
      );
      htmlParts.push(buildWorkbookHtml(data, stages, job, total));
      okCount++;
    } catch (err) {
      const msg = err.message || String(err);
      htmlParts.push(buildErrorHtml(job, total, msg));
      // 한도 소진은 기다려도 안 풀린다 — 남은 지문을 시도하지 않고 즉시 멈춘다
      if (isQuotaError(err)) {
        const left = total - (i + 1);
        if (left > 0) htmlParts.push(quotaStopHtml(left));
        break;
      }
    }
  }

  if (okCount) htmlParts.push(`<footer>단계별 워크북 · 자동 생성</footer>`);
  workbookDocEl.innerHTML = htmlParts.join("");
  applyAnswerVisibility();
  if (okCount) {
    workbookPrintBtn.style.display = "inline-flex";
    wbAnswerPrintBtn.style.display = "inline-flex";
  }
  syncFloatPrint();
  wbLoadingEl.classList.remove("on");
  wbBtn.disabled = false;
  addPassageBtn.disabled = false;
  workbookDocEl.scrollIntoView({ behavior: "smooth", block: "start" });
}

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

// {{정답}} → 빈칸 + 정답 목록
function renderBraceBlanks(text) {
  const answers = [];
  const html = esc(text).replace(/\{\{([^{}]*)\}\}/g, (_, a) => {
    answers.push(a.trim());
    return wbBlank(Math.max(70, a.trim().length * 9));
  });
  return { html, answers };
}

// (기본형|정답) → (기본형) 표시 + 정답 목록
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

// 영어 문장을 단어 단위로 섞어 순서배열 문제로 만든다.
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

function wbHeading(h) {
  return h && h.trim() ? `<div class="wb-heading">${esc(h.trim())}</div>` : "";
}

/* ── 단계별 렌더 ── */

function buildWorkbookHtml(d, stages, job, total) {
  const parts = [];
  parts.push(`<section class="wb-passage">`);
  parts.push(passageBanner(job, total));
  if (d.englishTitle || d.koreanTitle) {
    parts.push(`
      <div class="wb-titlebar">
        <b>${esc(d.englishTitle || "")}</b>
        ${d.koreanTitle ? `<span>${esc(d.koreanTitle)}</span>` : ""}
      </div>`);
  }

  const sentences = (d.sentences || []).filter((s) => s && s.en);
  stages.forEach((stageId) => {
    const meta = WB_STAGES.find((s) => s.id === stageId);
    if (!meta) return;
    let inner = "";
    if (stageId === 7) inner = renderStage7(d.oddParagraphs || []);
    else inner = sentences.map((s) => renderStageSentence(stageId, s)).join("");
    if (!inner.trim()) return;
    parts.push(`
      <section class="wb-stage">
        <h3 class="section wb-stage-head"><span class="num">워크북${meta.id}</span> ${esc(meta.name)}</h3>
        <div class="wb-guide">◗ ${esc(meta.guide)}</div>
        ${inner}
      </section>`);
  });

  parts.push(`</section>`);
  return parts.join("");
}

function renderStageSentence(stageId, s) {
  const noBadge = `<span class="wb-no">${esc(s.no)}</span>`;
  const head = wbHeading(s.heading);
  let body = "";

  if (stageId === 3) {
    // 빈칸 연습(영문) — 해석을 보고 영어 빈칸 채우기
    const { html, answers } = renderBraceBlanks(s.enBlank || s.en);
    if (!answers.length) return "";
    body = `
      <div class="wb-ko">${esc(s.ko)}</div>
      <div class="wb-en">${html}</div>
      ${wbAns(answers.join(" / "))}`;
  } else if (stageId === 4) {
    // 해석 연습 — 영문 보고 해석 쓰기
    body = `
      <div class="wb-en">${esc(s.en)}</div>
      <div class="wb-writeline"></div>
      ${wbAns(s.ko || "")}`;
  } else if (stageId === 5) {
    // 동사형 연습
    const { html, answers } = renderVerbForms(s.verbForm || "");
    if (!answers.length) return "";
    body = `
      <div class="wb-ko">${esc(s.ko)}</div>
      <div class="wb-en">${html}</div>
      ${wbAns(answers.join(" / "))}`;
  } else if (stageId === 6) {
    // 어법 선택형
    const { html, answers } = renderChoices(s.grammarChoice || "", s.no || 1);
    if (!answers.length) return "";
    body = `
      <div class="wb-ko">${esc(s.ko)}</div>
      <div class="wb-en">${html}</div>
      ${wbAns(answers.join(" / "))}`;
  } else if (stageId === 8) {
    // 순서배열
    body = `
      <div class="wb-ko">${esc(s.ko)}</div>
      <div class="wb-scramble">( ${scrambleSentence(s.en, s.no || 1)} )</div>
      <div class="wb-writeline"></div>
      ${wbAns(s.en || "")}`;
  } else if (stageId === 9) {
    // 영작 연습
    const keys = (s.writeKeys || []).filter(Boolean);
    body = `
      <div class="wb-ko">${esc(s.ko)}</div>
      ${keys.length ? `<div class="wb-keys">${esc(keys.join(", "))}</div>` : ""}
      <div class="wb-writeline"></div>
      ${wbAns(s.en || "")}`;
  }

  if (!body) return "";
  return `<div class="wb-q">${head}<div class="wb-q-body">${noBadge}<div class="wb-q-main">${body}</div></div></div>`;
}

function renderStage7(paras) {
  return (paras || [])
    .filter((p) => p && p.text)
    .map((p) => {
      const fixes = (p.fixes || []).filter((f) => f && f.wrong);
      // 어색한 단어에 밑줄 표시 (본문에서 해당 단어를 찾아 <u>로 감싼다)
      let text = esc(p.text);
      fixes.forEach((f) => {
        const w = esc(f.wrong);
        const re = new RegExp(`(^|[^\\w<>])(${w.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")})(?![\\w>])`);
        text = text.replace(re, (m, pre, word) => `${pre}<u>${word}</u>`);
      });
      const lines = fixes
        .map(
          (_, i) =>
            `<div class="wb-fixline">(${i + 1}) ${wbBlank(150)} → ${wbBlank(150)}</div>`
        )
        .join("");
      const ansText = fixes.map((f, i) => `(${i + 1}) ${f.wrong} → ${f.right}`).join("   ");
      return `
        <div class="wb-q">
          ${wbHeading(p.heading)}
          <div class="wb-q-body">
            <span class="wb-no">${esc(p.no)}</span>
            <div class="wb-q-main">
              <div class="wb-para">${text}</div>
              ${lines}
              ${wbAns(ansText)}
            </div>
          </div>
        </div>`;
    })
    .join("");
}

/* ══════════════════════════ 단어장 탭 ══════════════════════════ */
// 지문 분석 결과의 '핵심 어휘'를 모아 단어장·단어시험지를 만든다.
// 이미 받아둔 분석 데이터를 재사용하므로 AI 호출(사용량)이 전혀 없다.

const VOCAB_STORE = "gemini_vocab_sets";
const vocabSourceEl = $("vocabSource");
const vocabFormatEl = $("vocabFormat");
const vocabSortEl = $("vocabSort");
const vocabTitleEl = $("vocabTitle");
const vocabDedupEl = $("vocabDedup");
const vocabAnswerChk = $("vocabAnswerChk");
const vocabBtn = $("vocabBtn");
const vocabPrintBtn = $("vocabPrintBtn");
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
vocabPrintBtn.addEventListener("click", () => window.print());

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
  syncFloatPrint();
  vocabDocEl.scrollIntoView({ behavior: "smooth", block: "start" });
}
