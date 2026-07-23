"use strict";

const $ = (id) => document.getElementById(id);
const apiKeyEl = $("apiKey");
const toggleKeyEl = $("toggleKey");
const passageListEl = $("passageList");
const addPassageBtn = $("addPassageBtn");
const passageCountEl = $("passageCount");
const grammarEl = $("targetGrammar");
const modeEl = $("mode");
const modelEl = $("model");
const analyzeBtn = $("analyzeBtn");
const printBtn = $("printBtn");
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

// ── 여러 지문 입력 관리 (지문 추가/삭제) ──
function renumberPassages() {
  const items = [...passageListEl.querySelectorAll(".passage-item")];
  items.forEach((it, i) => {
    it.querySelector(".passage-item-no").textContent = `지문 ${i + 1}`;
    // 지문이 하나뿐일 때는 삭제 버튼을 숨김
    it.querySelector(".passage-del").style.visibility =
      items.length > 1 ? "visible" : "hidden";
  });
  passageCountEl.textContent = items.length > 1 ? `· 총 ${items.length}개` : "";
}

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

function addPassageRow(focus) {
  const item = document.createElement("div");
  item.className = "passage-item";
  item.innerHTML = `
    <div class="passage-item-head">
      <span class="passage-item-no"></span>
      <span class="passage-count" aria-live="polite"></span>
      <button type="button" class="btn ghost small passage-del" title="이 지문 삭제">✕ 삭제</button>
    </div>
    <textarea class="passage-input" placeholder="분석할 영어 지문을 여기에 붙여넣으세요."></textarea>`;
  passageListEl.appendChild(item);
  const ta = item.querySelector(".passage-input");
  ta.addEventListener("keydown", (e) => {
    if ((e.ctrlKey || e.metaKey) && e.key === "Enter") analyze();
  });
  ta.addEventListener("input", () => updatePassageCount(ta));
  updatePassageCount(ta); // 초기 표시
  item.querySelector(".passage-del").addEventListener("click", () => {
    item.remove();
    renumberPassages();
  });
  renumberPassages();
  if (focus) ta.focus();
  return ta;
}

addPassageBtn.addEventListener("click", () => addPassageRow(true));
addPassageRow(false); // 시작 시 지문 입력칸 1개

// ── 모델별 "오늘 사용량" 추적 ──
// Google API는 잔여 한도를 조회하는 기능이 없어서, 이 앱에서 오늘 보낸 횟수를
// 브라우저에 집계해 보여준다. 한도(429)에 걸린 모델은 '소진'으로 표시.
const USAGE_STORE = "gemini_usage";
const USAGE_LIMIT = 20; // 무료 등급 하루 요청 한도(추정치) — 모델·시기에 따라 다름
const todayStr = () => new Date().toLocaleDateString("sv");  // YYYY-MM-DD(로컬)
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
    <div class="u-title">모델별 오늘 사용률 <span class="u-sub">· 자정에 초기화</span></div>
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

async function analyze() {
  const apiKey = apiKeyEl.value.trim();
  errorEl.textContent = "";
  if (!apiKey) {
    errorEl.textContent = "먼저 Gemini API 키를 입력하세요.";
    apiKeyEl.focus();
    return;
  }

  // 입력된 지문 수집 (빈 칸은 건너뜀). 번호는 화면에 보이는 순서를 유지.
  const items = [...passageListEl.querySelectorAll(".passage-item")];
  const jobs = [];
  items.forEach((it, i) => {
    const text = it.querySelector(".passage-input").value.trim();
    if (text) jobs.push({ no: i + 1, text });
  });
  if (!jobs.length) {
    errorEl.textContent = "분석할 영어 지문을 입력하세요.";
    return;
  }

  analyzeBtn.disabled = true;
  addPassageBtn.disabled = true;
  loadingEl.classList.add("on");
  resultEl.innerHTML = "";
  printBtn.style.display = "none";

  const total = jobs.length;
  const usedModel = modelEl.value;
  const reviewOn = !!(reviewChk && reviewChk.checked);
  let okCount = 0;
  for (let i = 0; i < total; i++) {
    const job = jobs[i];
    const stage = reviewOn ? "분석·검토 중" : "분석 중";
    loadingTextEl.textContent =
      total > 1
        ? `지문 ${job.no} ${stage}… (${i + 1}/${total})`
        : `AI가 지문을 ${stage}입니다… ${reviewOn ? "(꼼꼼 검토: 두 번 분석해 더 걸립니다)" : "(지문 길이에 따라 20~60초)"}`;

    if (job.text.length < 20) {
      resultEl.insertAdjacentHTML(
        "beforeend",
        buildErrorHtml(job.no, total, "지문이 너무 짧습니다 (20자 이상 입력).")
      );
      continue;
    }

    try {
      const res = await fetch("/api/analyze", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          passage: job.text,
          targetGrammar: grammarEl.value,
          mode: modeEl.value,
          model: modelEl.value,
          review: reviewOn,
          apiKey,
        }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || "분석에 실패했습니다.");
      resultEl.insertAdjacentHTML("beforeend", buildAnalysisHtml(data, job.no, total));
      okCount++;
      bumpUsage(usedModel);
      if (reviewOn) bumpUsage(usedModel); // 검토 패스로 요청 1회 추가 소모
    } catch (err) {
      const msg = err.message || String(err);
      if (/한도|quota|exceeded|429/i.test(msg)) markExhausted(usedModel);
      resultEl.insertAdjacentHTML("beforeend", buildErrorHtml(job.no, total, msg));
    }
  }

  if (okCount) {
    resultEl.insertAdjacentHTML(
      "beforeend",
      `<footer>청크 단위 직독직해 분석본 · 자동 생성</footer>`
    );
    printBtn.style.display = "inline-flex";
  }
  loadingEl.classList.remove("on");
  analyzeBtn.disabled = false;
  addPassageBtn.disabled = false;
  resultEl.scrollIntoView({ behavior: "smooth", block: "start" });
}

function esc(s) {
  return String(s == null ? "" : s)
    .replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
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
function buildErrorHtml(no, total, msg) {
  const label = total > 1 ? `지문 ${no} 분석 실패` : "분석 실패";
  return `<section class="passage-block"><div class="passage-error"><b>${esc(label)}</b>${esc(msg)}</div></section>`;
}

// 한 지문의 전체 분석본 HTML을 문자열로 만든다 (여러 지문을 이어붙이기 위함)
function buildAnalysisHtml(d, no, total) {
  const parts = [];
  parts.push(`<section class="passage-block">`);
  if (total > 1) parts.push(`<div class="passage-banner">지문 ${esc(no)}</div>`);

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
    parts.push(`
      <div class="sent">
        <div class="sent-head"><span class="sent-no">${esc(s.no)}</span><span class="tag">${esc(s.tag)}</span></div>
        <div class="chunks">${chunksHtml}</div>
        <div class="note"><span class="note-title">${esc(s.no)}번 해설</span>${safeHTML(s.note)}</div>
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
