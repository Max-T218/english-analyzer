"use strict";

const $ = (id) => document.getElementById(id);
const apiKeyEl = $("apiKey");
const toggleKeyEl = $("toggleKey");
const passageEl = $("passage");
const grammarEl = $("targetGrammar");
const modeEl = $("mode");
const modelEl = $("model");
const analyzeBtn = $("analyzeBtn");
const printBtn = $("printBtn");
const errorEl = $("error");
const loadingEl = $("loading");
const resultEl = $("result");

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
modelEl.addEventListener("change", () => localStorage.setItem(MODEL_STORE, modelEl.value));

// ── 학원 마크 ──
const LOGO_STORE = "academy_logo";
const NAME_STORE = "academy_name";
const logoFileEl = $("logoFile");
const academyNameEl = $("academyName");
const brandPreviewEl = $("brandPreview");
const removeLogoEl = $("removeLogo");
const brandMarkEl = $("brandMark");
const printBrandTopEl = $("printBrandTop");
const headTitleEl = document.querySelector(".app-head h1");
const DEFAULT_TITLE = "영어 지문 분석본 자동 생성기";

academyNameEl.value = localStorage.getItem(NAME_STORE) || "";

function renderBrand() {
  const logo = localStorage.getItem(LOGO_STORE) || "";
  const name = localStorage.getItem(NAME_STORE) || "";

  // 상단 제목: 학원명이 있으면 학원명으로 대체
  headTitleEl.textContent = name || DEFAULT_TITLE;
  printBrandTopEl.textContent = name;

  // 우하단 마크: 로고 이미지
  brandMarkEl.innerHTML = logo ? `<img src="${logo}" alt="학원 로고">` : "";

  // 설정 미리보기: 로고 + 학원명 함께 표시
  let preview = "";
  if (logo) preview += `<img src="${logo}" alt="학원 로고">`;
  if (name) preview += `<span class="brand-name">${esc(name)}</span>`;
  brandPreviewEl.innerHTML = preview || '<span class="muted">아직 등록된 마크가 없습니다.</span>';
}

// 이미지를 인쇄용으로 적당히 축소해 저장 용량을 줄임 (긴 변 max 360px)
function downscaleImage(file, maxSize) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => {
      const img = new Image();
      img.onload = () => {
        let { width: w, height: h } = img;
        const scale = Math.min(1, maxSize / Math.max(w, h));
        w = Math.round(w * scale);
        h = Math.round(h * scale);
        const canvas = document.createElement("canvas");
        canvas.width = w;
        canvas.height = h;
        canvas.getContext("2d").drawImage(img, 0, 0, w, h);
        resolve(canvas.toDataURL("image/png"));
      };
      img.onerror = () => reject(new Error("이미지를 읽을 수 없습니다."));
      img.src = reader.result;
    };
    reader.onerror = () => reject(new Error("파일을 읽을 수 없습니다."));
    reader.readAsDataURL(file);
  });
}

logoFileEl.addEventListener("change", async () => {
  const file = logoFileEl.files && logoFileEl.files[0];
  if (!file) return;
  try {
    const dataUrl = await downscaleImage(file, 360);
    localStorage.setItem(LOGO_STORE, dataUrl);
    renderBrand();
    if (!$("brandPanel").open) $("brandPanel").open = true;
  } catch (e) {
    alert(e.message || "이미지 처리 중 오류가 발생했습니다.");
  }
});

academyNameEl.addEventListener("input", () => {
  const v = academyNameEl.value.trim();
  if (v) localStorage.setItem(NAME_STORE, v);
  else localStorage.removeItem(NAME_STORE);
  renderBrand();
});

removeLogoEl.addEventListener("click", () => {
  localStorage.removeItem(LOGO_STORE);
  logoFileEl.value = "";
  renderBrand();
});

renderBrand();
loadModels(); // 저장된 키가 있으면 시작 시 사용 가능한 모델을 불러옴

analyzeBtn.addEventListener("click", analyze);
printBtn.addEventListener("click", () => window.print());
passageEl.addEventListener("keydown", (e) => {
  if ((e.ctrlKey || e.metaKey) && e.key === "Enter") analyze();
});

async function analyze() {
  const passage = passageEl.value.trim();
  const apiKey = apiKeyEl.value.trim();
  errorEl.textContent = "";
  if (!apiKey) {
    errorEl.textContent = "먼저 Gemini API 키를 입력하세요.";
    apiKeyEl.focus();
    return;
  }
  if (passage.length < 20) {
    errorEl.textContent = "분석할 영어 지문을 입력하세요 (20자 이상).";
    return;
  }
  analyzeBtn.disabled = true;
  loadingEl.classList.add("on");
  resultEl.innerHTML = "";
  printBtn.style.display = "none";

  try {
    const res = await fetch("/api/analyze", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        passage,
        targetGrammar: grammarEl.value,
        mode: modeEl.value,
        model: modelEl.value,
        apiKey,
      }),
    });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || "분석에 실패했습니다.");
    render(data);
    printBtn.style.display = "inline-flex";
    resultEl.scrollIntoView({ behavior: "smooth", block: "start" });
  } catch (err) {
    errorEl.textContent = err.message || String(err);
  } finally {
    analyzeBtn.disabled = false;
    loadingEl.classList.remove("on");
  }
}

function esc(s) {
  return String(s == null ? "" : s)
    .replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

function render(d) {
  const parts = [];

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
        <b><span class="sep">/</span> 의미 단위 끊어읽기</b>
      </div>
    </div>
    <div class="result-tools"></div>
  `);

  // 문장 카드 — englishHtml/koreanHtml/note 는 서버(AI)가 생성한 마크업을 그대로 사용
  (d.sentences || []).forEach((s) => {
    parts.push(`
      <div class="sent">
        <div class="sent-head"><span class="sent-no">${esc(s.no)}</span><span class="tag">${esc(s.tag)}</span></div>
        <div class="eng">${s.englishHtml || ""}</div>
        <div class="kor">${s.koreanHtml || ""}</div>
        <div class="note"><span class="note-title">${esc(s.no)}번 해설</span>${s.note || ""}</div>
      </div>
    `);
  });

  // 요약표
  if (d.summary && d.summary.length) {
    const rows = d.summary.map(
      (r) => `<tr><td>${esc(r.label)}</td><td>${r.content || ""}</td></tr>`
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

  parts.push(`<footer>청크 단위 직독직해 분석본 · 자동 생성</footer>`);
  resultEl.innerHTML = parts.join("");
}
