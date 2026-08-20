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
const nameGateEl = $("nameGate");
const listWorkspaceEl = $("listWorkspace");
const takeWorkspaceEl = $("takeWorkspace");
const resultWorkspaceEl = $("resultWorkspace");

function showOnly(el) {
  [codeGateEl, nameGateEl, listWorkspaceEl, takeWorkspaceEl, resultWorkspaceEl].forEach((s) => {
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

/* ── 1단계: 반 코드 → 학생 이름 목록 ── */
let currentClassCode = "";

const codeNextBtn = $("codeNextBtn");
const codeError = $("codeError");
const codeStatus = $("codeStatus");
$("codeForm").addEventListener("submit", async (e) => {
  e.preventDefault();
  const code = $("codeInput").value.trim();
  codeError.textContent = "";
  if (!code) {
    codeError.textContent = "코드를 입력하세요.";
    return;
  }
  codeNextBtn.disabled = true;
  codeStatus.textContent = "확인 중…";
  try {
    const data = await getJson(`/api/student/roster?code=${encodeURIComponent(code)}`);
    currentClassCode = code;
    $("nameGateClassName").textContent = data.className;
    renderNameList(data.students || []);
    showOnly(nameGateEl);
  } catch (err) {
    codeError.textContent = err.message || "코드를 확인하지 못했습니다.";
  } finally {
    codeNextBtn.disabled = false;
    codeStatus.textContent = "";
  }
});

function renderNameList(students) {
  const nameError = $("nameError");
  nameError.textContent = "";
  $("nameList").innerHTML = students.length
    ? students
        .map((s) => `<button type="button" class="btn ghost name-btn" data-id="${esc(s.id)}">${esc(s.name)}</button>`)
        .join("")
    : "";
  if (!students.length) nameError.textContent = "이 반에 등록된 학생이 없습니다. 선생님께 문의하세요.";
}

$("nameList").addEventListener("click", async (e) => {
  const btn = e.target.closest(".name-btn");
  if (!btn) return;
  const nameError = $("nameError");
  nameError.textContent = "";
  btn.disabled = true;
  try {
    const info = await postJson("/api/student/login", { code: currentClassCode, studentId: btn.dataset.id });
    $("studentGreeting").textContent = `${info.name}님, 안녕하세요`;
    $("codeInput").value = "";
    showOnly(listWorkspaceEl);
    loadTests();
  } catch (err) {
    nameError.textContent = err.message || "로그인에 실패했습니다.";
    btn.disabled = false;
  }
});

$("backToCodeBtn").addEventListener("click", () => {
  currentClassCode = "";
  showOnly(codeGateEl);
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
  $("testList").innerHTML = tests.map((t) => `
    <div class="panel" style="display:flex; align-items:center; justify-content:space-between; gap:10px; flex-wrap:wrap;">
      <div>
        <div style="font-weight:700;">${esc(t.title)}</div>
        <div class="hint">${esc(FORMAT_LABEL[t.format] || t.format)}(영어↔뜻 혼합) · 단어 ${t.wordCount}개</div>
      </div>
      ${t.submitted
        ? `<div style="font-weight:800; color:var(--accent);">${t.score} / ${t.total}점</div>`
        : `<button type="button" class="btn small take-btn" data-id="${esc(t.id)}">응시하기</button>`}
    </div>
  `).join("");
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
    $("takeTitle").textContent = data.title;
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
    showOnly(resultWorkspaceEl);
  } catch (err) {
    errEl.textContent = err.message || "제출에 실패했습니다.";
  } finally {
    submitBtn.disabled = false;
    submitStatus.textContent = "";
  }
});
