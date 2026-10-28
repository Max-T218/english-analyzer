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
  if (!res.ok) {
    const err = new Error(data.error || "요청에 실패했습니다.");
    if (data.needStudy) err.needStudy = true;
    throw err;
  }
  return data;
}
const esc = (s) => String(s == null ? "" : s)
  .replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

const codeGateEl = $("codeGate");
const listWorkspaceEl = $("listWorkspace");
const studyWorkspaceEl = $("studyWorkspace");
const takeWorkspaceEl = $("takeWorkspace");
const resultWorkspaceEl = $("resultWorkspace");
const pwWorkspaceEl = $("pwWorkspace");
const quizWorkspaceEl = $("quizWorkspace");
const quizResultWorkspaceEl = $("quizResultWorkspace");

function showOnly(el) {
  [codeGateEl, listWorkspaceEl, studyWorkspaceEl, takeWorkspaceEl, resultWorkspaceEl, pwWorkspaceEl,
   quizWorkspaceEl, quizResultWorkspaceEl].forEach((s) => {
    s.hidden = s !== el;
  });
  window.scrollTo(0, 0);
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

/* ── 로그인: 선생님이 정해 준 아이디 + 비밀번호 ── */
const codeNextBtn = $("codeNextBtn");
const codeError = $("codeError");
const codeStatus = $("codeStatus");
$("codeForm").addEventListener("submit", async (e) => {
  e.preventDefault();
  const loginId = $("loginIdInput").value.trim();
  const password = $("loginPwInput").value;
  codeError.textContent = "";
  if (!loginId || !password) {
    codeError.textContent = "아이디와 비밀번호를 입력하세요.";
    return;
  }
  codeNextBtn.disabled = true;
  codeStatus.textContent = "확인 중…";
  try {
    const info = await postJson("/api/student/login", { loginId, password });
    $("studentGreeting").textContent = `${info.name}님, 안녕하세요`;
    $("loginIdInput").value = "";
    $("loginPwInput").value = "";
    showOnly(listWorkspaceEl);
    loadTests();
    // 아직 한 번도 직접 바꾸지 않았으면 바꾸라고 권한다. [다음에 하기]를 한 번 눌렀으면 이 기기에서는
    // 다시 띄우지 않는다 — 위쪽 [비밀번호 변경]에서 언제든 바꿀 수 있다(2026-10-27 사용자)
    pwNudgeId = loginId.toLowerCase();
    if (info.pwChanged === false && !pwNudgeSkipped()) setPwNudge(true);
  } catch (err) {
    codeError.textContent = err.message || "로그인에 실패했습니다.";
  } finally {
    codeNextBtn.disabled = false;
    codeStatus.textContent = "";
  }
});

/* ── 첫 로그인 안내창 ── */
let pwNudgeId = "";   // 안내창을 띄운 학생의 아이디 — [다음에 하기]를 아이디별로 기억한다
function pwNudgeSkipped() {
  try { return localStorage.getItem("pwNudgeSkip:" + pwNudgeId) === "1"; } catch (_) { return false; }
}
function setPwNudge(on) {
  const el = $("pwNudge");
  el.hidden = !on;
  el.style.display = on ? "flex" : "none";
}
$("pwNudgeNowBtn").addEventListener("click", () => {
  setPwNudge(false);
  $("openPwBtn").click();
});
$("pwNudgeLaterBtn").addEventListener("click", () => {
  try { localStorage.setItem("pwNudgeSkip:" + pwNudgeId, "1"); } catch (_) { /* 저장이 막혀 있으면 다음에 또 뜬다 */ }
  setPwNudge(false);
});

/* ── 비밀번호 변경 ── */
$("openPwBtn").addEventListener("click", () => {
  $("pwError").textContent = "";
  $("pwStatus").textContent = "";
  $("pwForm").reset();
  showOnly(pwWorkspaceEl);
});
$("pwBackBtn").addEventListener("click", () => { showOnly(listWorkspaceEl); });
$("pwForm").addEventListener("submit", async (e) => {
  e.preventDefault();
  const errEl = $("pwError");
  errEl.textContent = "";
  const current = $("pwCurrent").value;
  const next = $("pwNew").value;
  if (!current || !next) {
    errEl.textContent = "현재 비밀번호와 새 비밀번호를 입력하세요.";
    return;
  }
  if (next !== $("pwNew2").value) {
    errEl.textContent = "새 비밀번호 확인이 서로 다릅니다.";
    return;
  }
  $("pwSaveBtn").disabled = true;
  try {
    await postJson("/api/student/password", { current, new: next });
    $("pwForm").reset();
    $("pwStatus").textContent = "변경했습니다.";
  } catch (err) {
    errEl.textContent = err.message || "변경에 실패했습니다.";
  } finally {
    $("pwSaveBtn").disabled = false;
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
    if (t.kind === "quiz") return quizListRowHtml(t);
    const id = esc(t.id);
    const study = `<button type="button" class="btn ghost study-btn" data-id="${id}">📖 단어 학습</button>`;
    let status = "", buttons;
    if (!t.submitted) {
      buttons = `<button type="button" class="btn take-btn" data-id="${id}">응시하기</button>${study}`;
    } else if (t.retakeOpen) {
      // 합격했어도 선생님이 다시 보라고 열어 준 시험
      status = `<div class="st-card-status bad">🔁 선생님이 재시험을 내셨어요 (지난 점수 ${t.score}/${t.total})</div>`;
      buttons = `<button type="button" class="btn take-btn" data-id="${id}">재시험 보기</button>
        <button type="button" class="btn ghost result-btn" data-id="${id}">지난 결과 보기</button>${study}`;
    } else if (t.passed) {
      // 합격 기준 없이 낸 시험은 '합격'이 아니라 '시험 마침'(2026-10-28 사용자)
      status = t.maxWrong == null
        ? `<div class="st-card-status ok">✅ 시험 마침 (${t.score}/${t.total})</div>`
        : `<div class="st-card-status ok">✅ 합격 (${t.passedRound}회차 · ${t.score}/${t.total})</div>`;
      buttons = `<button type="button" class="btn ghost result-btn" data-id="${id}">결과 보기</button>${study}`;
    } else {
      status = `<div class="st-card-status bad">미통과 (${t.attemptCount}회 시도 · 최근 ${t.score}/${t.total})</div>`;
      buttons = `<button type="button" class="btn take-btn" data-id="${id}">재시험 보기</button>
        <button type="button" class="btn ghost result-btn" data-id="${id}">틀린 단어 보기</button>${study}`;
    }
    return testCardHtml(t.title,
      `${esc(FORMAT_LABEL[t.format] || t.format)}(영어↔뜻 혼합) · 단어 ${t.wordCount}개`
        + (t.maxWrong != null ? ` · 합격 기준 ${t.wordCount - t.maxWrong}/${t.wordCount}` : ""),
      status, buttons);
  }).join("");
}

// 목록 카드 한 벌 — 단어시험·문제 시험·워크북이 모두 이 모양이다(제목 → 설명 → 결과 → 단추 줄).
// 예전에는 시험마다 단추가 오른쪽·아래로 제각각 놓여 폰에서 들쭉날쭉했다.
function testCardHtml(title, meta, status, buttons) {
  return `
    <div class="panel st-card">
      <div class="st-card-title">${esc(title)}</div>
      <div class="hint">${meta}</div>
      ${status}
      <div class="st-card-actions">${buttons}</div>
    </div>`;
}

$("testList").addEventListener("click", (e) => {
  const takeBtn = e.target.closest(".take-btn");
  if (takeBtn) { openTest(takeBtn.dataset.id); return; }
  const resultBtn = e.target.closest(".result-btn");
  if (resultBtn) { openResult(resultBtn.dataset.id); return; }
  const studyBtn = e.target.closest(".study-btn");
  if (studyBtn) { openStudy(studyBtn.dataset.id); return; }
});

let currentStudyAssignmentId = null;
let currentStudyVocab = [];
let studyRevealed = 0;

// 뜻은 처음부터 가려 둔다. 모든 단어의 뜻을 눌러 확인해야 학습으로 인정하고, 그때서야
// 서버에 알려 시험을 연다. 시험을 열려면 회차마다(재시험 포함) 이 학습을 다시 마쳐야 한다.
async function openStudy(assignmentId, notice) {
  const errEl = $("studyError");
  errEl.textContent = notice || "";
  currentStudyAssignmentId = assignmentId;
  showOnly(studyWorkspaceEl);
  $("studyTitle").textContent = "불러오는 중…";
  $("studyTableBody").innerHTML = "";
  $("studyProgress").textContent = "";
  $("studyTakeBtn").disabled = true;
  $("studyTakeBtn").hidden = false;
  studyRevealed = 0;
  try {
    const data = await getJson(`/api/student/tests/vocab?assignmentId=${encodeURIComponent(assignmentId)}`);
    $("studyTitle").textContent = data.title;
    currentStudyVocab = data.vocab || [];
    renderStudyTable();
    updateStudyProgress();
  } catch (err) {
    $("studyTitle").textContent = "";
    errEl.textContent = err.message || "단어 목록을 불러오지 못했습니다.";
  }
}

function renderStudyTable() {
  $("studyTableBody").innerHTML = currentStudyVocab.map((v, i) => `
    <tr>
      <td>${i + 1}</td>
      <td>${esc(v.word)}</td>
      <td class="study-meaning" data-meaning="${esc(v.meaning)}" data-revealed="0"
          style="cursor:pointer;">눌러서 보기</td>
    </tr>
  `).join("");
}

async function updateStudyProgress() {
  const total = currentStudyVocab.length;
  $("studyProgress").textContent = `뜻 확인 ${studyRevealed} / ${total}`;
  if (studyRevealed < total) return;
  $("studyProgress").textContent = `뜻 확인 ${total} / ${total} ✅`;
  const assignmentId = currentStudyAssignmentId;
  try {
    const r = await postJson("/api/student/tests/studied", { assignmentId, revealed: studyRevealed });
    if (assignmentId !== currentStudyAssignmentId) return;
    if (r.round == null) {          // 이미 합격한 시험 — 복습일 뿐이라 시험 단추는 없다
      $("studyTakeBtn").hidden = true;
      return;
    }
    $("studyTakeBtn").disabled = false;
  } catch (err) {
    $("studyError").textContent = err.message || "학습 기록을 남기지 못했습니다. 다시 시도해 주세요.";
  }
}

// 뜻 칸만이 아니라 줄 어디를 눌러도 연다 — 폰에서는 단어를 누르는 일이 많다
$("studyTableBody").addEventListener("click", (e) => {
  const td = e.target.closest("tr")?.querySelector(".study-meaning");
  if (!td || td.dataset.revealed === "1") return;
  td.dataset.revealed = "1";
  td.style.cursor = "default";
  td.textContent = td.dataset.meaning;
  studyRevealed += 1;
  updateStudyProgress();
});
$("studyTakeBtn").addEventListener("click", () => openTest(currentStudyAssignmentId));
$("backToListBtn3").addEventListener("click", () => { showOnly(listWorkspaceEl); loadTests(); });

async function openResult(assignmentId) {
  const errEl = $("listError");
  errEl.textContent = "";
  try {
    const r = await getJson(`/api/student/tests/result?assignmentId=${encodeURIComponent(assignmentId)}`);
    currentAssignmentId = assignmentId;
    if (r.kind === "quiz") { showQuizResult(r); return; }
    showResultScreen(r, { title: `${r.title}${r.round > 1 ? ` (${r.round}회차)` : ""} 결과` });
  } catch (err) {
    errEl.textContent = err.message || "결과를 불러오지 못했습니다.";
  }
}

let currentAssignmentId = null;
let currentFormat = "saq";
let currentQuestions = [];
let currentAnswers = [];
let currentOut = [];   // 문항마다 ✕로 지운 보기(풀이 도중 표시 — 답이 아니다)
let currentIndex = 0;

async function openTest(assignmentId) {
  const errEl = $("takeError");
  errEl.textContent = "";
  currentAssignmentId = assignmentId;
  showOnly(takeWorkspaceEl);
  $("takeTitle").textContent = "불러오는 중…";
  $("takeProgress").textContent = "";
  $("takeForm").innerHTML = "";
  try {
    const data = await getJson(`/api/student/tests/detail?assignmentId=${encodeURIComponent(assignmentId)}`);
    if (data.kind === "quiz") { openQuiz(assignmentId, data); return; }
    $("takeTitle").textContent = data.round > 1 ? `${data.title} (${data.round}회차)` : data.title;
    $("takeHint").textContent =
      data.format === "mcq" ? "보기 중 하나를 고르세요." : "직접 입력하세요.";
    currentFormat = data.format;
    currentQuestions = data.questions;
    currentAnswers = currentQuestions.map(() => "");
    currentOut = [];
    currentIndex = 0;
    renderQuestion();
  } catch (err) {
    if (err.needStudy) {     // 이 회차의 단어 학습을 아직 안 했다 — 학습 화면으로 보낸다
      openStudy(assignmentId, "시험을 보기 전에 단어 학습을 먼저 마쳐 주세요.");
      return;
    }
    $("takeTitle").textContent = "";
    errEl.textContent = err.message || "시험을 불러오지 못했습니다.";
  }
}

// 한 문항만 그린다(여러 문항을 한 화면에 띄우면 위로 스크롤해 보기를 대조할 수 있다).
// 이전 문항으로는 [← 이전]으로 돌아갈 수 있고, 먼저 고른 답이 그대로 표시된다.
// 객관식은 보기를 누르면 답을 저장하고 곧바로 다음 문항으로 넘어간다. 마지막 문항이면
// 바로 제출하지 않고 '제출할까요?' 확인창이 뜬다.
function renderQuestion() {
  const q = currentQuestions[currentIndex];
  const total = currentQuestions.length;
  const saved = currentAnswers[currentIndex] || "";
  $("takeProgress").textContent = `문항 ${currentIndex + 1} / ${total}`;
  $("prevBtn").hidden = currentIndex === 0;
  // 보기는 문제 시험(quiztest.js)과 같은 큰 칸(.qt-opt)으로 그린다 — 폰에서 손가락으로 누르기 쉽게
  $("takeForm").innerHTML = `
    <div class="st-q">
      <div class="st-q-prompt">${currentIndex + 1}. ${esc(q.prompt)}
        ${currentFormat === "saq" ? `<span class="hint">(${q.direction === "en2ko" ? "뜻 쓰기" : "영어 쓰기"})</span>` : ""}
      </div>
      ${currentFormat === "mcq"
        ? `<div class="qt-opts">${(q.options || []).map((opt, k) => {
            const out = ((currentOut[currentIndex] || []).includes(opt)) && opt !== saved;
            return `<div class="qt-cell">
            <label class="qt-opt st-opt${opt === saved ? " sel" : ""}${out ? " out" : ""}">
              <input type="radio" name="qCurrent" value="${esc(opt)}"${opt === saved ? " checked" : ""}>
              <span class="qz-num">${"①②③④⑤⑥⑦⑧"[k] || ""}</span><span>${esc(opt)}</span>
            </label>
            <button type="button" class="qt-x st-x${out ? " on" : ""}" data-v="${esc(opt)}" aria-label="${k + 1}번 보기 지우기" title="정답이 아닌 보기 지우기">✕</button></div>`;
          }).join("")}</div>`
        : `<input type="text" class="qt-in st-in" id="qCurrentInput" autocomplete="off" value="${esc(saved)}">`}
    </div>
  `;
  nextBtn.textContent = currentIndex === total - 1 ? "제출하기" : "다음";
}

function readCurrentAnswer() {
  if (currentFormat === "mcq") {
    const checked = $("takeForm").querySelector('input[name="qCurrent"]:checked');
    return checked ? checked.value : "";
  }
  const input = $("qCurrentInput");
  return input ? input.value.trim() : "";
}

$("backToListBtn").addEventListener("click", () => { showOnly(listWorkspaceEl); loadTests(); });
$("backToListBtn2").addEventListener("click", () => { showOnly(listWorkspaceEl); loadTests(); });
$("retryBtn").addEventListener("click", () => openTest(currentAssignmentId));

const nextBtn = $("nextBtn");
const submitStatus = $("submitStatus");

/* 결과 화면 — 제출 직후와 목록의 [결과 보기]가 같이 쓴다. 틀린 단어는 내 답과 정답을
   나란히 보여 준다(어느 단어를 다시 외워야 하는지 알 수 있게). */
function showResultScreen(result, opts) {
  opts = opts || {};
  $("resultHeading").textContent = opts.title ? opts.title : "제출 완료!";
  $("resultScore").textContent = `${result.score} / ${result.total}점`;
  $("resultLead").textContent = result.passed && result.noCriterion
    ? "✅ 시험을 마쳤습니다."
    : result.passed
    ? (result.round > 1 ? `🎉 ${result.round}회차 만에 합격했습니다!` : "🎉 합격했습니다!")
    : result.retakeOpen
      ? "🔁 선생님이 재시험을 내셨어요. 다시 도전해 보세요."
      : `아직 기준에 못 미쳤습니다 (틀린 개수 ${result.wrong}개). 다시 도전해 보세요.`;
  $("retryBtn").hidden = result.passed;
  const items = result.wrongItems || [];
  const box = $("resultWrong");
  if (items.length) {
    box.innerHTML = `
      <div style="font-weight:700; margin-bottom:6px;">틀린 단어 ${items.length}개</div>
      <div class="table-wrap"><table class="st-table">
        <thead><tr><th>#</th><th>문제</th><th>내 답</th><th>정답</th></tr></thead>
        <tbody>${items.map((w) => `<tr>
          <td>${esc(w.no)}</td><td>${esc(w.prompt)}</td>
          <td style="color:var(--g);">${w.given ? esc(w.given) : "<span class='hint'>(무응답)</span>"}</td>
          <td style="font-weight:700;">${esc(w.correct)}</td></tr>`).join("")}</tbody>
      </table></div>`;
  } else if (result.hasDetails === false || result.wrong > 0) {
    // 틀린 문제가 있는데 목록이 비어 있으면 '다 맞았다'고 하지 않는다(옛 기록·응답 누락)
    box.innerHTML = `<p class="hint" style="text-align:center;">틀린 단어 정보를 불러오지 못했어요.</p>`;
  } else {
    box.innerHTML = `<p class="hint" style="text-align:center;">틀린 단어가 없어요. 🎉</p>`;
  }
  showOnly(resultWorkspaceEl);
}

async function submitTest() {
  const errEl = $("takeError");
  errEl.textContent = "";
  nextBtn.disabled = true;
  submitStatus.textContent = "채점 중…";
  try {
    const result = await postJson("/api/student/tests/submit", {
      assignmentId: currentAssignmentId, answers: currentAnswers,
    });
    showResultScreen(result);
  } catch (err) {
    errEl.textContent = err.message || "제출에 실패했습니다.";
  } finally {
    nextBtn.disabled = false;
    submitStatus.textContent = "";
  }
}

let autoAdvanceTimer = null;

// 제출 확인창 — 마지막 문항을 풀면 바로 채점하지 않고 한 번 묻는다. 제출하면 되돌릴 수
// 없고(재시험이 있는 시험은 한 회차를 쓴다) 아직 안 푼 문항이 있어도 그대로 채점되기 때문이다.
function openSubmitConfirm() {
  const blank = currentAnswers.filter((a) => !a).length;
  $("submitConfirmMsg").textContent = blank
    ? `아직 답하지 않은 문항이 ${blank}개 있어요. 그대로 제출하면 틀린 것으로 처리돼요.`
    : "모든 문항에 답했어요. 제출하면 바로 채점돼요.";
  const el = $("submitConfirm");
  el.hidden = false;
  el.style.display = "flex";
}
function closeSubmitConfirm() {
  const el = $("submitConfirm");
  el.hidden = true;
  el.style.display = "none";
}
$("submitConfirmNoBtn").addEventListener("click", closeSubmitConfirm);
$("submitConfirmYesBtn").addEventListener("click", () => {
  closeSubmitConfirm();
  if (!quizWorkspaceEl.hidden) submitQuiz();
  else submitTest();
});

function goNext() {
  currentAnswers[currentIndex] = readCurrentAnswer();
  if (currentIndex === currentQuestions.length - 1) {
    openSubmitConfirm();
    return;
  }
  currentIndex++;
  renderQuestion();
}

nextBtn.addEventListener("click", goNext);

// 주관식: 입력칸에서 Enter를 누르면 [다음]과 같다. 한글은 글자를 조합하는 중에 Enter가
// 조합 확정 키로도 쓰이므로(isComposing / keyCode 229), 그때 넘어가 버리면 마지막
// 글자가 답에서 빠진다 — 조합 중이면 무시한다.
$("takeForm").addEventListener("keydown", (e) => {
  if (e.key !== "Enter" || e.isComposing || e.keyCode === 229) return;
  if (e.target.id !== "qCurrentInput") return;
  e.preventDefault();
  goNext();
});

$("prevBtn").addEventListener("click", () => {
  if (currentIndex === 0) return;
  if (autoAdvanceTimer) { clearTimeout(autoAdvanceTimer); autoAdvanceTimer = null; }
  currentAnswers[currentIndex] = readCurrentAnswer();   // 지금 문항 답도 보관
  currentIndex--;
  renderQuestion();
});

// 객관식: 보기를 눌러도 자동으로 넘어가지 않는다(2026-10-27 사용자 — 자동으로 넘어가면 검토가
// 안 된다). 정답이 아닌 보기는 ✕로 지워 가며 풀고, 직접 [다음]을 누른다. 지운 표시는 답이 아니라
// 풀이 도중 표시일 뿐이라 이 화면 안에서만 기억한다(currentOut).
$("takeForm").addEventListener("click", (e) => {
  if (currentFormat !== "mcq") return;
  const xb = e.target.closest(".st-x");
  if (xb) {
    const list = currentOut[currentIndex] || (currentOut[currentIndex] = []);
    const v = xb.dataset.v;
    const at = list.indexOf(v);
    if (at >= 0) list.splice(at, 1); else list.push(v);
    const lab = xb.parentElement.querySelector("label.st-opt");
    const input = lab.querySelector('input[name="qCurrent"]');
    const out = at < 0;
    lab.classList.toggle("out", out);
    xb.classList.toggle("on", out);
    if (out && input.checked) { input.checked = false; lab.classList.remove("sel"); }
    return;
  }
  const opt = e.target.closest("label.st-opt");
  const input = opt && opt.querySelector('input[name="qCurrent"]');
  if (!input) return;
  input.checked = true;
  const list = currentOut[currentIndex];
  if (list) { const at = list.indexOf(input.value); if (at >= 0) list.splice(at, 1); }
  opt.classList.remove("out");
  opt.parentElement.querySelector(".st-x").classList.remove("on");
  $("takeForm").querySelectorAll("label.st-opt").forEach((l) => l.classList.toggle("sel", l === opt));
});

/* ══════ 문제 시험 — 객관식·주관식 탭에서 선생님이 낸 문제를 푼다 ══════
   문항 그리기는 quiztest.js(window.QT)가 하고, 여기서는 화면 전환·임시 보관·제출만 한다.
   한 번만 낼 수 있고, 내면 바로 점수·정답·해설을 보여 준다(답을 여러 모양으로 쓸 수 있는
   문항은 모범답안과 다르면 '선생님 확인 중'으로 남는다). */
function quizListRowHtml(t) {
  const id = esc(t.id);
  const status = t.submitted ? `<div class="st-card-status">${QT.countsText(t.qc, true)}</div>` : "";
  const buttons = t.submitted
    ? `<button type="button" class="btn ghost result-btn" data-id="${id}">정답·해설 보기</button>`
    : `<button type="button" class="btn take-btn" data-id="${id}">문제 풀기</button>`;
  return testCardHtml(t.title || (t.source === "workbook" ? "워크북" : "문제 시험"),
    t.source === "workbook" ? `📚 워크북 · ${t.questionCount}단계` : `📝 문제 시험 · ${t.questionCount}문항`,
    status, buttons);
}

let quizQuestions = [];
let quizDraftTimer = null;
const quizDraftKey = () => `qt_draft_${currentAssignmentId}`;

function saveQuizDraft() {
  clearTimeout(quizDraftTimer);
  quizDraftTimer = setTimeout(() => {
    const answers = QT.collect($("quizBody"), quizQuestions);
    try { localStorage.setItem(quizDraftKey(), JSON.stringify(answers)); } catch (_) {}
    updateQuizProgress(answers);
  }, 300);
}

function updateQuizProgress(answers) {
  const total = quizQuestions.reduce((n, q) => n + QT.unitCount(q), 0);
  const blank = QT.blankCount(answers || QT.collect($("quizBody"), quizQuestions));
  $("quizProgress").textContent = `${quizIndex + 1} / ${quizQuestions.length}번 · ${total - blank}/${total}칸 답함`;
}

// 한 번에 한 문항만 보인다(단어시험처럼). 모든 문항은 이미 그려져 있고 현재 것만 펼친다.
let quizIndex = 0;
let quizAutoTimer = null;
function showQuizStep(i) {
  quizIndex = Math.max(0, Math.min(quizQuestions.length - 1, i));
  $("quizBody").querySelectorAll(".qt-card").forEach((c) => { c.hidden = Number(c.dataset.q) !== quizIndex; });
  const last = quizIndex === quizQuestions.length - 1;
  $("quizPrevBtn").hidden = quizIndex === 0;
  $("quizNextBtn").hidden = last;
  $("quizSubmitBtn").hidden = !last;
  updateQuizProgress();
  window.scrollTo(0, 0);
}
$("quizPrevBtn").addEventListener("click", () => { clearTimeout(quizAutoTimer); showQuizStep(quizIndex - 1); });
$("quizNextBtn").addEventListener("click", () => { clearTimeout(quizAutoTimer); showQuizStep(quizIndex + 1); });
// 객관식도 보기를 눌러도 자동으로 넘어가지 않는다 — 보기를 하나씩 지워 가며(✕) 검토하고
// 직접 [다음]을 누르게 한다(2026-10-27 사용자: 자동으로 넘어가면 검토가 안 된다)

function openQuiz(assignmentId, data) {
  currentAssignmentId = assignmentId;
  quizQuestions = data.questions || [];
  $("quizTitle").textContent = data.title || "문제 시험";
  $("quizError").textContent = "";
  $("quizBody").innerHTML = quizQuestions.map((q, i) => QT.questionHtml(q, i, "take")).join("");
  let draft = null;
  try { draft = JSON.parse(localStorage.getItem(quizDraftKey()) || "null"); } catch (_) {}
  if (draft) QT.restore($("quizBody"), quizQuestions, draft);
  clearTimeout(quizAutoTimer); quizAutoTimer = null;
  showQuizStep(0);
  showOnly(quizWorkspaceEl);
}

QT.bind($("quizBody"), saveQuizDraft);
$("quizBackBtn").addEventListener("click", () => { showOnly(listWorkspaceEl); loadTests(); });
$("quizResultBackBtn").addEventListener("click", () => { showOnly(listWorkspaceEl); loadTests(); });

$("quizSubmitBtn").addEventListener("click", () => {
  const blank = QT.blankCount(QT.collect($("quizBody"), quizQuestions));
  $("submitConfirmMsg").textContent = blank
    ? `아직 비어 있는 답이 ${blank}칸 있어요. 그대로 제출하면 틀린 것으로 처리돼요. 제출은 한 번만 할 수 있어요.`
    : "모든 칸에 답했어요. 제출은 한 번만 할 수 있어요.";
  const el = $("submitConfirm");
  el.hidden = false;
  el.style.display = "flex";
});

async function submitQuiz() {
  const btn = $("quizSubmitBtn");
  $("quizError").textContent = "";
  btn.disabled = true;
  $("quizSubmitStatus").textContent = "채점 중…";
  try {
    const r = await postJson("/api/student/tests/submit", {
      assignmentId: currentAssignmentId, answers: QT.collect($("quizBody"), quizQuestions),
    });
    try { localStorage.removeItem(quizDraftKey()); } catch (_) {}
    showQuizResult(r);
  } catch (err) {
    $("quizError").textContent = err.message || "제출에 실패했습니다.";
    window.scrollTo(0, 0);
  } finally {
    btn.disabled = false;
    $("quizSubmitStatus").textContent = "";
  }
}

function showQuizResult(r) {
  $("quizResultHeading").textContent = r.title || "문제 시험";
  const items = r.items || [];
  const qc = r.qc || { right: 0, wrong: 0, pending: 0 };
  $("quizResultScore").innerHTML = QT.countsText(qc, true);
  $("quizResultLead").textContent =
    (qc.wrong ? "아래에서 틀린 문항의 정답과 해설을 확인하세요." : qc.pending ? "" : "모두 맞혔어요! 🎉") +
    (qc.pending ? ` 선생님이 확인할 문항이 ${qc.pending}개 있어요.` : "");
  $("quizWrongOnly").checked = false;
  $("quizResultBody").innerHTML = items.map((q, i) => QT.questionHtml(q, i, "review")).join("");
  showOnly(quizResultWorkspaceEl);
}

$("quizWrongOnly").addEventListener("change", (e) => {
  const only = e.target.checked;
  $("quizResultBody").querySelectorAll(".qt-card").forEach((c) => {
    c.hidden = only && c.dataset.status === "ok";
  });
});
