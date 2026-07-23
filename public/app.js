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

  // 문장 카드 — 청크(의미 단위)마다 영문+한글을 번갈아 표시
  (d.sentences || []).forEach((s) => {
    const chunksHtml = (s.chunks || [])
      .map(
        (c) => `
        <div class="chunk">
          <div class="c-eng">${c.eng || ""}</div>
          <div class="c-kor">${c.kor || ""}</div>
        </div>`
      )
      .join("");
    parts.push(`
      <div class="sent">
        <div class="sent-head"><span class="sent-no">${esc(s.no)}</span><span class="tag">${esc(s.tag)}</span></div>
        <div class="chunks">${chunksHtml}</div>
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
