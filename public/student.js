"use strict";
const $ = (id) => document.getElementById(id);

async function postJson(url, payload) {
  const res = await fetch(url, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(payload || {}),
  });
  const text = await res.text();
  let data = null;
  try { data = JSON.parse(text); } catch {}
  if (!data) throw new Error(`서버 오류 (HTTP ${res.status})`);
  if (!res.ok) throw new Error(data.error || "요청에 실패했습니다.");
  return data;
}
async function getJson(url) {
  const res = await fetch(url);
  const text = await res.text();
  let data = null;
  try { data = JSON.parse(text); } catch {}
  if (!data) throw new Error(`서버 오류 (HTTP ${res.status})`);
  if (!res.ok) throw new Error(data.error || "요청에 실패했습니다.");
  return data;
}
const esc = (s) => String(s == null ? "" : s)
  .replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

const codeGateEl = $("codeGate");
const listWorkspaceEl = $("listWorkspace");
const takeWorkspaceEl = $("takeWorkspace");
const resultWorkspaceEl = $("resultWorkspace");

function showOnly(el) {
  [codeGateEl, listWorkspaceEl, takeWorkspaceEl, resultWorkspaceEl].forEach((s) => {
    s.hidden = s !== el;
  });
}

// 이미 로그인된 세션이면(student_session 쿠키) 코드 입력 없이 바로 목록으로
(async () => {
  try {
    const info = await getJson("/api/student/me");
    if (info.loggedIn) {
      $("studentGreeting").textContent = `${info.name}님, 안녕하세요`;
      showOnly(listWorkspaceEl);
      loadTests();
    } else {
      showOnly(codeGateEl);
    }
  } catch (_) {
    showOnly(codeGateEl);
  }
})();

/* ── 로그인: 이름만 입력 ──
   반 코드는 더 이상 묻지 않는다. 학생 등록이 이름을 앱 전체에서 유일하게
   강제하므로(create_student, server.py 참고) 이름 하나로 로그인이 결정된다. */
const codeNextBtn = $("codeNextBtn");
const codeError = $("codeError");
const codeStatus = $("codeStatus");
$("codeForm").addEventListener("submit", async (e) => {
  e.preventDefault();
  const name = $("nameInput").value.trim();
  codeError.textContent = "";
  if (!name) {
    codeError.textContent = "이름을 입력하세요.";
    return;
  }
  codeNextBtn.disabled = true;
  codeStatus.textContent = "확인 중…";
  try {
    const info = await postJson("/api/student/login", { name });
    $("studentGreeting").textContent = `${info.name}님, 안녕하세요`;
    $("nameInput").value = "";
    showOnly(listWorkspaceEl);
    loadTests();
  } catch (err) {
    codeError.textContent = err.message || "로그인에 실패했습니다.";
  } finally {
    codeNextBtn.disabled = false;
    codeStatus.textContent = "";
  }
});

$("logoutBtn").addEventListener("click", async () => {
  try { await postJson("/api/student/logout"); } catch (_) {}
  showOnly(codeGateEl);
});

const FORMAT_LABEL = { mcq: "객관식", saq: "주관식" };
const DIRECTION_LABEL = { en2ko: "영어→뜻", ko2en: "뜻→영어" };

async function loadTests() {
  const errEl = $("listError");
  errEl.textContent = "";
  $("testList").innerHTML = `<p class="hint">불러오는 중…</p>`;
  try {
    const data = await getJson("/api/student/tests");
    renderTests(data.tests || []);
  } catch (err) {
    if (/로그인/.test(err.message || "")) {
      showOnly(codeGateEl);
      return;
    }
    errEl.textContent = err.message || "시험 목록을 불러오지 못했습니다.";
  }
}

function renderTests(tests) {
  if (!tests.length) {
    $("testList").innerHTML = `<p class="hint">아직 배정된 시험이 없습니다.</p>`;
    return;
  }
  $("testList").innerHTML = tests.map((t) => {
    let rightSide;
    if (!t.submitted) {
      rightSide = `<button type="button" class="btn small take-btn" data-id="${esc(t.id)}">응시하기</button>`;
    } else if (t.passed) {
      rightSide = `<div style="font-weight:800; color:var(--accent);">✅ 합격 (${t.passedRound}회차 · ${t.score}/${t.total})</div>`;
    } else {
      rightSide = `
        <div style="text-align:right;">
          <div style="font-weight:700; color:var(--g);">미통과 (${t.attemptCount}회 시도 · 최근 ${t.score}/${t.total})</div>
          <button type="button" class="btn small take-btn" data-id="${esc(t.id)}" style="margin-top:4px;">재시험 보기</button>
        </div>`;
    }
    return `
    <div class="panel" style="display:flex; align-items:center; justify-content:space-between; gap:10px; flex-wrap:wrap;">
      <div>
        <div style="font-weight:700;">${esc(t.title)}</div>
        <div class="hint">${esc(FORMAT_LABEL[t.format] || t.format)}(영어↔뜻 혼합) · 단어 ${t.wordCount}개
          ${t.maxWrong != null ? `· 합격 기준 ${t.wordCount - t.maxWrong}/${t.wordCount}` : ""}</div>
      </div>
      ${rightSide}
    </div>`;
  }).join("");
}

$("testList").addEventListener("click", (e) => {
  const btn = e.target.closest(".take-btn");
  if (btn) openTest(btn.dataset.id);
});

let currentAssignmentId = null;

async function openTest(assignmentId) {
  const errEl = $("takeError");
  errEl.textContent = "";
  currentAssignmentId = assignmentId;
  showOnly(takeWorkspaceEl);
  $("takeTitle").textContent = "불러오는 중…";
  $("takeForm").innerHTML = "";
  try {
    const data = await getJson(`/api/student/tests/detail?assignmentId=${encodeURIComponent(assignmentId)}`);
    $("takeTitle").textContent = data.round > 1 ? `${data.title} (${data.round}회차)` : data.title;
    $("takeHint").textContent =
      data.format === "mcq" ? "보기 중 하나를 고르세요." : "직접 입력하세요.";
    $("takeForm").innerHTML = data.questions.map((q, i) => `
      <div class="field" style="margin-bottom:14px;">
        <label>${i + 1}. ${esc(q.prompt)}
          <span class="hint">(${esc(DIRECTION_LABEL[q.direction] || q.direction)}${data.format === "saq" ? (q.direction === "en2ko" ? " · 뜻 쓰기" : " · 영어 쓰기") : ""})</span>
        </label>
        ${data.format === "mcq"
          ? (q.options || []).map((opt, oi) => `
              <label class="chk" style="display:flex; margin:4px 0;">
                <input type="radio" name="q${i}" value="${esc(opt)}">
                <span style="margin-left:6px;">${esc(opt)}</span>
              </label>`).join("")
          : `<input type="text" name="q${i}" autocomplete="off">`}
      </div>
    `).join("");
  } catch (err) {
    $("takeTitle").textContent = "";
    errEl.textContent = err.message || "시험을 불러오지 못했습니다.";
  }
}

$("backToListBtn").addEventListener("click", () => { showOnly(listWorkspaceEl); loadTests(); });
$("backToListBtn2").addEventListener("click", () => { showOnly(listWorkspaceEl); loadTests(); });
$("retryBtn").addEventListener("click", () => openTest(currentAssignmentId));

const submitBtn = $("submitBtn");
const submitStatus = $("submitStatus");
$("takeForm").addEventListener("submit", async (e) => {
  e.preventDefault();
  const errEl = $("takeError");
  errEl.textContent = "";
  const formData = new FormData($("takeForm"));
  const answers = [];
  let i = 0;
  while (formData.has(`q${i}`) || $("takeForm").querySelector(`[name="q${i}"]`)) {
    answers.push((formData.get(`q${i}`) || "").toString());
    i++;
  }
  submitBtn.disabled = true;
  submitStatus.textContent = "채점 중…";
  try {
    const result = await postJson("/api/student/tests/submit", {
      assignmentId: currentAssignmentId, answers,
    });
    $("resultScore").textContent = `${result.score} / ${result.total}점`;
    $("resultLead").textContent = result.passed
      ? (result.round > 1 ? `🎉 ${result.round}회차 만에 합격했습니다!` : "🎉 합격했습니다!")
      : `아직 기준에 못 미쳤습니다 (틀린 개수 ${result.wrong}개). 다시 도전해 보세요.`;
    $("retryBtn").hidden = result.passed;
    showOnly(resultWorkspaceEl);
  } catch (err) {
    errEl.textContent = err.message || "제출에 실패했습니다.";
  } finally {
    submitBtn.disabled = false;
    submitStatus.textContent = "";
  }
});
