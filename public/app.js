"use strict";

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
const usagePanelEl = $("usagePanel");

const KEY_STORE = "gemini_api_key";

const modelStatusEl = $("modelStatus");

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
  renderUsage();
});

// 이 키로 실제 사용 가능한 모델을 불러와 드롭다운을 채움 (모델 지원 중단 대비)
async function loadModels() {
  const apiKey = apiKeyEl.value.trim();
  if (!apiKey) return;
  modelStatusEl.textContent = "· 모델 목록 불러오는 중…";
  try {
    const res = await fetch("/api/models", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ apiKey }),
    });
    const data = await res.json();
    if (!res.ok || !data.models || !data.models.length) {
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
    renderUsage();
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
  renderUsage();
});

loadModels(); // 저장된 키가 있으면 시작 시 사용 가능한 모델을 불러옴 (내부에서 renderUsage 호출)

// ── 학원 마크(로고) — 고정 파일 대신 사용자가 업로드해 이 브라우저에 저장 ──
const BRAND_IMG_STORE = "brand_mark_img";   // data URL
const BRAND_NAME_STORE = "brand_mark_name"; // 학원명 텍스트
const BRAND_MAX_BYTES = 5 * 1024 * 1024;    // 5MB — localStorage 용량 보호
const brandNameEl = $("brandName");
const brandFileEl = $("brandFile");
const brandPreviewEl = $("brandPreview");
const brandRemoveBtn = $("brandRemoveBtn");
const brandMarkEl = $("brandMark");

function renderBrand() {
  const img = localStorage.getItem(BRAND_IMG_STORE) || "";
  const name = (localStorage.getItem(BRAND_NAME_STORE) || "").trim();

  // 인쇄용 우하단 마크 (비어 있으면 CSS가 자동으로 숨김)
  if (brandMarkEl) {
    brandMarkEl.innerHTML =
      (img ? `<img src="${esc(img)}" alt="">` : "") +
      (name ? `<span class="brand-name">${esc(name)}</span>` : "");
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
function updatePassageCount(ta) {
  const el = ta.closest(".passage-item").querySelector(".passage-count");
  const n = ta.value.trim().length;
  el.classList.remove("warn", "danger");
  let msg = n.toLocaleString() + "자";
  if (n > 3500) {
    el.classList.add("danger");
    msg += " · 나눠서 권장";
  } else if (n > 2000) {
    el.classList.add("warn");
    msg += " · 길어지는 중";
  }
  el.textContent = msg;
}

function createPassageManager(listEl, addBtn, countEl, onEnter) {
  function renumber() {
    const items = [...listEl.querySelectorAll(".passage-item")];
    items.forEach((it, i) => {
      // 이름을 비워두면 '지문 1', '지문 2' … 가 자동으로 쓰인다(placeholder로 안내)
      it.querySelector(".passage-name").placeholder = `지문 ${i + 1}`;
      it.querySelector(".passage-del").style.visibility =
        items.length > 1 ? "visible" : "hidden";
    });
    if (countEl) countEl.textContent = items.length > 1 ? `· 총 ${items.length}개` : "";
  }

  function addRow(focus) {
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
const passageMgr = createPassageManager(passageListEl, addPassageBtn, passageCountEl, () =>
  runActiveTab()
);
// Ctrl+Enter는 현재 열려 있는 탭의 실행 버튼을 누른다
function runActiveTab() {
  const active = document.querySelector(".tab-page.active");
  const btn = active && active.querySelector("#analyzeBtn, #mcqBtn, #saqBtn, #wbBtn");
  if (btn && !btn.disabled) btn.click();
}

// 입력한 지문을 이 브라우저에 보관해 새로고침해도 유지 (서버 저장 없음)
const PASSAGE_STORE = "passages";
let passageSaveTimer = null;
function savePassages() {
  const rows = [...passageListEl.querySelectorAll(".passage-item")].map((it) => ({
    name: it.querySelector(".passage-name").value,
    text: it.querySelector(".passage-input").value,
  }));
  if (rows.some((r) => r.text.trim() || r.name.trim())) {
    localStorage.setItem(PASSAGE_STORE, JSON.stringify(rows));
  } else {
    localStorage.removeItem(PASSAGE_STORE);
  }
}
passageListEl.addEventListener("input", () => {
  clearTimeout(passageSaveTimer);
  passageSaveTimer = setTimeout(savePassages, 500);
});
passageListEl.addEventListener("click", (e) => {
  if (e.target.closest(".passage-del")) setTimeout(savePassages, 0);
});
(function restorePassages() {
  let saved = [];
  try {
    saved = JSON.parse(localStorage.getItem(PASSAGE_STORE) || "[]");
  } catch (_) {
    saved = [];
  }
  if (Array.isArray(saved) && saved.length) {
    saved.forEach((row) => {
      // 예전 형식(문자열 배열)도 그대로 복원되도록 처리
      const { name, text } = typeof row === "string" ? { name: "", text: row } : row || {};
      const ta = passageMgr.addRow(false);
      ta.value = text || "";
      ta.closest(".passage-item").querySelector(".passage-name").value = name || "";
      updatePassageCount(ta);
    });
  } else {
    passageMgr.addRow(false); // 시작 시 지문 입력칸 1개
  }
})();

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
// Google API는 잔여 한도를 조회하는 기능이 없어서, 이 앱에서 오늘 보낸 횟수를
// 브라우저에 집계해 보여준다. 한도(429)에 걸린 모델은 '소진'으로 표시.
const USAGE_STORE = "gemini_usage";
const USAGE_LIMIT = 20; // 무료 등급 하루 요청 한도(추정치) — 모델·시기에 따라 다름
// 카운터는 미국 서부(PT) 날짜 기준으로 하루 단위 집계 (실제 한도 주기와 일치시키기 위함).
const todayStr = () =>
  new Date().toLocaleDateString("en-CA", { timeZone: "America/Los_Angeles" }); // YYYY-MM-DD(PT)
function getUsage() {
  let u;
  try { u = JSON.parse(localStorage.getItem(USAGE_STORE) || "{}"); } catch (_) { u = {}; }
  if (u.date !== todayStr()) u = { date: todayStr(), counts: {}, exhausted: {} };
  return u;
}
function saveUsage(u) { localStorage.setItem(USAGE_STORE, JSON.stringify(u)); }
function bumpUsage(model) {
  const u = getUsage();
  u.counts[model] = (u.counts[model] || 0) + 1;
  delete u.exhausted[model]; // 성공했으면 '소진' 표시 해제
  saveUsage(u);
  renderUsage();
}
function markExhausted(model) {
  const u = getUsage();
  u.exhausted[model] = true;
  saveUsage(u);
  renderUsage();
}
function renderUsage() {
  if (!usagePanelEl) return;
  const opts = [...modelEl.options];
  if (!apiKeyEl.value.trim() || !opts.length) { usagePanelEl.hidden = true; return; }
  const u = getUsage();
  const cur = modelEl.value;
  const rows = opts.map((o) => {
    const n = u.counts[o.value] || 0;
    const ex = !!u.exhausted[o.value];
    const pct = ex ? 100 : Math.min(100, Math.round((n / USAGE_LIMIT) * 100));
    const lvl = (ex || pct >= 100) ? "u-lv-hi" : (pct >= 70 ? "u-lv-mid" : "u-lv-lo");
    const name = esc(o.textContent.replace(/\s*\(.*\)\s*$/, "")); // 라벨의 (id) 제거
    const isCur = o.value === cur;
    const badge = ex ? `<span class="u-ex">⚠️ 소진</span>` : "";
    return `<div class="u-row${isCur ? " u-cur" : ""}">
        <span class="u-name">${isCur ? "▶ " : ""}${name}</span>
        <span class="u-bar"><i class="u-bar-fill ${lvl}" style="width:${pct}%"></i></span>
        <span class="u-pct ${lvl}">${pct}%</span>${badge}
      </div>`;
  }).join("");
  usagePanelEl.innerHTML = `
    <div class="u-title">모델별 오늘 사용률</div>
    ${rows}
    <div class="u-note">※ Google는 잔여 한도를 알려주지 않아, <b>하루 한도를 약 ${USAGE_LIMIT}회로 가정</b>해 이 브라우저의 오늘 사용 횟수를 %로 환산한 <b>추정치</b>입니다. ‘소진’은 그 모델이 오늘 실제 한도(429)에 걸린 표시이며, 모델마다 한도는 따로입니다.</div>`;
  usagePanelEl.hidden = false;
}

// '꼼꼼 검토' 체크 상태 기억
const REVIEW_STORE = "gemini_review";
if (reviewChk) {
  reviewChk.checked = localStorage.getItem(REVIEW_STORE) === "1";
  reviewChk.addEventListener("change", () =>
    localStorage.setItem(REVIEW_STORE, reviewChk.checked ? "1" : "0")
  );
}

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
  resultEl.innerHTML = "";
  printBtn.style.display = "none";
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
      const res = await fetch("/api/analyze", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          passage: job.text,
          targetGrammar: grammarEl.value,
          model: modelEl.value,
          review: reviewOn,
          apiKey,
        }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || "분석에 실패했습니다.");
      htmlParts.push(buildAnalysisHtml(data, job, total));
      if (Array.isArray(data.vocab) && data.vocab.length) {
        vocabSets.push({ name: job.name, vocab: data.vocab });
      }
      okCount++;
      bumpUsage(usedModel);
      if (reviewOn) bumpUsage(usedModel); // 검토 패스로 요청 1회 추가 소모
    } catch (err) {
      const msg = err.message || String(err);
      if (/한도|quota|exceeded|429/i.test(msg)) markExhausted(usedModel);
      htmlParts.push(buildErrorHtml(job, total, msg));
    }
  }

  if (okCount) htmlParts.push(`<footer>구문 단위 직독직해 분석본 · 자동 생성</footer>`);
  if (vocabSets.length) saveVocabSets(vocabSets); // 단어장 탭에서 재사용
  // 모든 지문 분석이 끝난 뒤 한 번에 렌더 (중간에 화면이 바뀌지 않도록)
  resultEl.innerHTML = htmlParts.join("");
  if (okCount) printBtn.style.display = "inline-flex";
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

  // 유형 체크박스 생성
  types.forEach((t) => {
    const label = document.createElement("label");
    label.innerHTML = `<input type="checkbox" value="${esc(t.id)}" ${t.def ? "checked" : ""}> ${esc(t.id)}`;
    gridEl.appendChild(label);
  });

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
  });
  gridEl.addEventListener("change", () => {
    syncAll();
    syncCount();
  });
  countEl.addEventListener("input", updateHint);   // 타이핑 중에는 안내만
  countEl.addEventListener("change", clampCount);  // 확정되면 하한으로 보정
  fitBtn.addEventListener("click", () => {
    countEl.value = Math.max(1, typeCount());
    updateHint();
  });
  syncAll();
  syncCount();

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
        const res = await fetch("/api/quiz", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            passage: job.text, types: picked, count, model: modelEl.value, apiKey,
          }),
        });
        const data = await res.json();
        if (!res.ok) throw new Error(data.error || "문제 생성에 실패했습니다.");
        htmlParts.push(buildQuizHtml(data, job, total));
        okCount++;
        bumpUsage(usedModel);
      } catch (err) {
        const msg = err.message || String(err);
        if (/한도|quota|exceeded|429/i.test(msg)) markExhausted(usedModel);
        htmlParts.push(buildErrorHtml(job, total, msg));
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

  (d.questions || []).forEach((q) => {
    parts.push(`
      <div class="qz-card">
        <div class="qz-head"><span class="qz-no">${esc(q.no)}</span><span class="qz-type">${esc(q.type)}</span></div>
        <div class="qz-instruction">${safeHTML(q.instruction)}</div>
        ${quizBodyHtml(q)}
        <button type="button" class="qz-reveal-btn">정답·해설 보기</button>
        <div class="qz-answer-box">
          <b>정답 ${quizAnswerLabel(q)}</b><br>${safeHTML(q.explanation)}
        </div>
      </div>
    `);
  });

  // 정답 및 해설 — 화면 토글과 별개로 인쇄물에는 항상 별도 페이지로 포함
  if (d.questions && d.questions.length) {
    const rows = d.questions
      .map(
        (q) => `
      <tr>
        <td>${esc(q.no)}</td>
        <td>${esc(q.type)}</td>
        <td>${quizAnswerLabel(q)}</td>
        <td>${safeHTML(q.explanation)}</td>
      </tr>`
      )
      .join("");
    parts.push(`
      <h3 class="section page-break"><span class="num">📌</span> 정답 및 해설</h3>
      <div class="table-wrap"><table class="answerkey">
        <thead><tr><th>번호</th><th>유형</th><th>정답</th><th>해설</th></tr></thead>
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
      const res = await fetch("/api/workbook", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ passage: job.text, model: modelEl.value, apiKey }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || "워크북 생성에 실패했습니다.");
      htmlParts.push(buildWorkbookHtml(data, stages, job, total));
      okCount++;
      bumpUsage(usedModel);
    } catch (err) {
      const msg = err.message || String(err);
      if (/한도|quota|exceeded|429/i.test(msg)) markExhausted(usedModel);
      htmlParts.push(buildErrorHtml(job, total, msg));
    }
  }

  if (okCount) htmlParts.push(`<footer>단계별 워크북 · 자동 생성</footer>`);
  workbookDocEl.innerHTML = htmlParts.join("");
  applyAnswerVisibility();
  if (okCount) workbookPrintBtn.style.display = "inline-flex";
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
  const multi = sets.length > 1;
  const parts = [];
  parts.push(`
    <div class="vocab-head">
      <h3 class="section" style="margin-top:0">
        <span class="num">📒</span> ${esc(title || "핵심 어휘 단어장")}
      </h3>
      <div class="vocab-meta">총 ${rows.length}단어 · ${esc(new Date().toLocaleDateString("ko-KR"))}</div>
    </div>`);

  const fromCol = multi ? `<th>출처</th>` : "";
  const fromCell = (r) => (multi ? `<td class="v-from">${esc(r.from)}</td>` : "");

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
          <td>${esc(r.antonym)}</td>${fromCell(r)}
        </tr>`
      )
      .join("");
    parts.push(`
      <div class="table-wrap"><table class="vocab">
        <thead><tr><th>#</th><th>단어 / 표현</th><th>품사</th><th>뜻</th><th>유의어</th><th>반의어</th>${fromCol}</tr></thead>
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
          <td class="v-blank"><span class="wb-ans">${esc(askEn ? r.meaning : r.word)}</span></td>${fromCell(r)}
        </tr>`
      )
      .join("");
    parts.push(`
      <div class="table-wrap"><table class="vocab vocab-test">
        <thead><tr><th>#</th><th>${askEn ? "단어 / 표현" : "뜻"}</th><th>${askEn ? "뜻" : "영어"}</th>${fromCol}</tr></thead>
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
