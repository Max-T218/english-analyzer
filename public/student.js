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
  if (!res.ok) {
    const err = new Error(data.error || "요청에 실패했습니다.");
    if (data.making) err.making = true;   // 보충 문제를 다른 요청이 아직 만드는 중
    throw err;
  }
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

/* ══════ 풀던 답 임시 저장(2026-11-09 사용자) ══════
   학원 공용 기기와 휴대폰을 오가며 보므로 풀던 답을 학생 아이디로 서버(/api/student/draft)에 둔다.
   글자마다 보내면 느려서(서버는 미국·저장소는 서울) 쓰고 잠시 쉬었을 때·문항을 옮길 때·창을 나갈 때만 보낸다.
   인터넷이 끊겨도 잃지 않게 이 기기에도 학생별 이름표(dk — 서버가 준 해시)로 함께 적어 두고, 다시 열 때 서버 것과
   기기 것 중 더 최근 것을 쓴다. 기기에 적은 것은 로그아웃할 때 지운다(공용 기기). 3일 지난 것은 버린다(서버도 같다). */
const DRAFT_DAYS = 3;
const DRAFT_PREFIX = "stdraft:";
const DRAFT_IDLE_MS = 3000;
let draftDk = "";   // /api/student/me·로그인 응답의 dk
const draft = { ctx: null, last: null, dirty: false, timer: null, edited: false, saving: null };

function draftLocalKey(ctx) { return `${DRAFT_PREFIX}${draftDk}:${ctx.aid}:${ctx.kind}:${ctx.round || 0}`; }
function draftOld(t) { return !t || Date.now() - t > DRAFT_DAYS * 86400000; }
function draftLocalGet(ctx) {
  try {
    const k = draftLocalKey(ctx);
    const d = JSON.parse(localStorage.getItem(k) || "null");
    if (d && draftOld(d.t)) { localStorage.removeItem(k); return null; }
    return d;
  } catch (_) { return null; }
}
function draftLocalPut(ctx, v) {
  try { localStorage.setItem(draftLocalKey(ctx), JSON.stringify({ answers: v.answers, index: v.index, t: Date.now() })); } catch (_) {}
}
function draftLocalDrop(ctx) { try { localStorage.removeItem(draftLocalKey(ctx)); } catch (_) {} }
// keep: 남길 것을 고르는 함수 — 없으면 모두 지운다. 학생 구분 없이 적던 옛 판(qt_draft_)은 누구 것인지 몰라 늘 지운다.
function draftLocalSweep(keep) {
  try {
    for (let i = localStorage.length - 1; i >= 0; i--) {
      const k = localStorage.key(i);
      if (!k) continue;
      if (k.startsWith("qt_draft_")) { localStorage.removeItem(k); continue; }
      if (!k.startsWith(DRAFT_PREFIX)) continue;
      let d = null;
      try { d = JSON.parse(localStorage.getItem(k) || "null"); } catch (_) {}
      if (!keep || !d || draftOld(d.t)) localStorage.removeItem(k);
    }
  } catch (_) {}
}
function draftSetDk(dk) { draftDk = dk || ""; draftLocalSweep(true); }

async function draftFlush(keepalive) {
  clearTimeout(draft.timer);
  const ctx = draft.ctx;
  if (!ctx || !draft.dirty || !draft.last) return;
  if (draft.saving && !keepalive) { await draft.saving; if (!draft.dirty) return; }
  draft.dirty = false;
  const body = JSON.stringify({ assignmentId: ctx.aid, kind: ctx.kind, round: ctx.round,
                                answers: draft.last.answers, index: draft.last.index });
  draft.saving = fetch("/api/student/draft", { method: "POST", headers: { "content-type": "application/json" },
                                               body, keepalive: !!keepalive && body.length < 60000 })
    .then((r) => { if (!r.ok && r.status >= 500) draft.dirty = true; })
    .catch(() => { if (draft.ctx === ctx) draft.dirty = true; })   // 인터넷이 끊겼다 — 다음 기회에 다시 보낸다(기기에는 남아 있다)
    .finally(() => { draft.saving = null; });
  await draft.saving;
}
function draftBegin(aid, kind, round) {
  draftFlush();
  draft.ctx = { aid, kind, round: round || 0 };
  draft.last = null; draft.dirty = false; draft.edited = false;
  return draft.ctx;
}
// 답이 바뀌었다 — 기기에는 바로, 서버에는 잠시 쉬었을 때
function draftChanged(answers, index) {
  if (!draft.ctx) return;
  draft.last = { answers, index };
  draft.dirty = true; draft.edited = true;
  draftLocalPut(draft.ctx, draft.last);
  clearTimeout(draft.timer);
  draft.timer = setTimeout(() => draftFlush(), DRAFT_IDLE_MS);
}
// 문항을 옮겼다 — 답한 것이 있을 때만 곧바로 보낸다
function draftMoved(index) {
  if (!draft.ctx || !draft.last) return;
  draft.last.index = index;
  draft.dirty = true;
  draftLocalPut(draft.ctx, draft.last);
  draftFlush();
}
// 제출했다 — 서버는 제출할 때 지운다
function draftDone() {
  clearTimeout(draft.timer);
  if (draft.ctx) draftLocalDrop(draft.ctx);
  draft.ctx = null; draft.last = null; draft.dirty = false;
}
// 서버 것과 기기 것 중 더 최근 것. 화면을 먼저 기기 것으로 채워 두고, 서버 것이 더 최근이며 학생이 아직 손대지 않았으면 apply로 바꾼다.
function draftRestore(ctx, apply) {
  const local = draftLocalGet(ctx);
  if (local) { draft.last = { answers: local.answers, index: local.index }; apply(local, false); }
  getJson(`/api/student/draft?assignmentId=${encodeURIComponent(ctx.aid)}&kind=${ctx.kind}&round=${ctx.round || 0}`)
    .then((srv) => {
      if (draft.ctx !== ctx || draft.edited) return;
      if (!srv || !Array.isArray(srv.answers)) {   // 서버에 없다 — 이 기기에만 있는 답(끊겼을 때 쓴 것)을 올린다
        if (local) { draft.dirty = true; draftFlush(); }
        return;
      }
      const st = Date.parse(srv.updatedAt || "") || 0;
      if (local && local.t >= st) {   // 이 기기 것이 더 최근 — 서버에 못 보낸 것이면 지금 보낸다
        if (JSON.stringify(local.answers) !== JSON.stringify(srv.answers)) { draft.dirty = true; draftFlush(); }
        return;
      }
      draft.last = { answers: srv.answers, index: srv.index };
      draftLocalPut(ctx, draft.last);
      apply(srv, true);
    })
    .catch(() => {
      if (local && draft.ctx === ctx) { draft.dirty = true; draft.timer = setTimeout(() => draftFlush(), DRAFT_IDLE_MS); }
    });
}
function draftNote(beforeEl, text) {
  let el = beforeEl.parentElement.querySelector(":scope > .draft-note");
  if (!el) {
    el = document.createElement("p");
    el.className = "hint draft-note";
    el.style.cssText = "margin:0 0 8px; color:var(--accent,#2563eb);";
    beforeEl.before(el);
  }
  el.textContent = text || "";
  el.hidden = !text;
}
document.addEventListener("visibilitychange", () => { if (document.visibilityState === "hidden") draftFlush(true); });
window.addEventListener("pagehide", () => draftFlush(true));

const codeGateEl = $("codeGate");
const listWorkspaceEl = $("listWorkspace");
const studyWorkspaceEl = $("studyWorkspace");
const takeWorkspaceEl = $("takeWorkspace");
const resultWorkspaceEl = $("resultWorkspace");
const pwWorkspaceEl = $("pwWorkspace");
const quizWorkspaceEl = $("quizWorkspace");
const quizResultWorkspaceEl = $("quizResultWorkspace");
const quizStudyWorkspaceEl = $("quizStudyWorkspace");
const quizConceptWorkspaceEl = $("quizConceptWorkspace");

function showOnly(el) {
  [codeGateEl, listWorkspaceEl, studyWorkspaceEl, takeWorkspaceEl, resultWorkspaceEl, pwWorkspaceEl,
   quizWorkspaceEl, quizResultWorkspaceEl, quizStudyWorkspaceEl, quizConceptWorkspaceEl].forEach((s) => {
    s.hidden = s !== el;
  });
  window.scrollTo(0, 0);
}

// 이미 로그인된 세션이면(student_session 쿠키) 코드 입력 없이 바로 목록으로
(async () => {
  try {
    const info = await getJson("/api/student/me");
    if (info.loggedIn) {
      draftSetDk(info.dk);
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
    draftSetDk(info.dk);
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
  await draftFlush();          // 못 보낸 답을 먼저 서버에 — 그래야 다른 기기에서 이어 푼다
  draftDone();
  draftLocalSweep(false);      // 공용 기기에 남기지 않는다
  try { await postJson("/api/student/logout"); } catch (_) {}
  showOnly(codeGateEl);
});

const FORMAT_LABEL = { mcq: "객관식", saq: "주관식", mix: "객관식+주관식" };
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
      data.format === "mcq" ? "보기 중 하나를 고르세요."
      : data.format === "mix" ? "보기가 있으면 고르고, 없으면 직접 입력하세요." : "직접 입력하세요.";
    currentFormat = data.format;
    currentQuestions = data.questions;
    currentAnswers = currentQuestions.map(() => "");
    currentOut = [];
    currentIndex = 0;
    draftNote($("takeForm"), "");
    renderQuestion();
    // 풀던 답 — 회차마다 문항 순서가 달라 회차별로 따로 둔다. 문항 수가 다르면(선생님이 고친 시험) 버린다
    const ctx = draftBegin(assignmentId, "vocab", data.round || 1);
    draftRestore(ctx, (saved, fromServer) => {
      if (takeWorkspaceEl.hidden || draft.ctx !== ctx) return;
      if (!Array.isArray(saved.answers) || saved.answers.length !== currentQuestions.length) return;
      currentAnswers = saved.answers.map((a) => (typeof a === "string" ? a : ""));
      currentIndex = Math.min(Number(saved.index) || 0, currentQuestions.length - 1);
      renderQuestion();
      draftNote($("takeForm"), fromServer ? "💾 저장해 둔 답을 불러왔어요. 이어서 풀면 돼요." : "");
    });
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
        ${!isMcQ(q) ? `<span class="hint">(${q.direction === "en2ko" ? "뜻 쓰기" : "영어 쓰기"})</span>` : ""}
      </div>
      ${isMcQ(q)
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

// 객관식 문항인지 — 혼합 시험(mix)은 문항마다 다르다. 서버가 객관식 문항에만 보기(options)를 싣는다
function isMcQ(q) { return !!(q && Array.isArray(q.options)); }

function readCurrentAnswer() {
  if (isMcQ(currentQuestions[currentIndex])) {
    const checked = $("takeForm").querySelector('input[name="qCurrent"]:checked');
    return checked ? checked.value : "";
  }
  const input = $("qCurrentInput");
  return input ? input.value.trim() : "";
}

$("backToListBtn").addEventListener("click", () => { draftFlush(); showOnly(listWorkspaceEl); loadTests(); });
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
    draftDone();
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

// 단어시험 임시 저장 — 문항을 옮길 때는 곧바로 서버에 보낸다
function vocabDraftSave(moved) {
  draftChanged(currentAnswers.slice(), currentIndex);
  if (moved) draftFlush();
}

function goNext() {
  currentAnswers[currentIndex] = readCurrentAnswer();
  if (currentIndex === currentQuestions.length - 1) {
    vocabDraftSave(true);
    openSubmitConfirm();
    return;
  }
  currentIndex++;
  renderQuestion();
  vocabDraftSave(true);
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
  vocabDraftSave(true);
});

// 주관식 칸에 쓰는 중 — 기기에는 바로, 서버에는 잠시 쉬었을 때
$("takeForm").addEventListener("input", (e) => {
  if (e.target.id !== "qCurrentInput") return;
  currentAnswers[currentIndex] = e.target.value.trim();
  vocabDraftSave(false);
});

// 객관식: 보기를 눌러도 자동으로 넘어가지 않는다(2026-10-27 사용자 — 자동으로 넘어가면 검토가
// 안 된다). 정답이 아닌 보기는 ✕로 지워 가며 풀고, 직접 [다음]을 누른다. 지운 표시는 답이 아니라
// 풀이 도중 표시일 뿐이라 이 화면 안에서만 기억한다(currentOut).
$("takeForm").addEventListener("click", (e) => {
  if (!isMcQ(currentQuestions[currentIndex])) return;
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
    if (out && input.checked) {
      input.checked = false; lab.classList.remove("sel");
      currentAnswers[currentIndex] = "";
      vocabDraftSave(false);
    }
    return;
  }
  const opt = e.target.closest("label.st-opt");
  const input = opt && opt.querySelector('input[name="qCurrent"]');
  if (!input) return;
  input.checked = true;
  currentAnswers[currentIndex] = input.value;
  vocabDraftSave(false);
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
  const todo = t.submitted && t.retryTodo;   // 선생님이 켠 보충 학습을 아직 마치지 못했다
  const status = t.submitted
    ? `<div class="st-card-status">${QT.countsText(t.qc, true)}${todo ? ' <span class="tag fail">보충 학습 해야 해요</span>' : ""}</div>` : "";
  const buttons = t.submitted
    ? (todo
      ? `<button type="button" class="btn result-btn" data-id="${id}">🔁 보충 학습 하기</button>`
      : `<button type="button" class="btn ghost result-btn" data-id="${id}">정답·해설 보기</button>`)
    : `<button type="button" class="btn take-btn" data-id="${id}">문제 풀기</button>`;
  return testCardHtml(t.title || (t.source === "workbook" ? "워크북" : "문제 시험"),
    t.source === "workbook" ? `📚 워크북 · ${t.questionCount}단계` : `📝 문제 시험 · ${t.questionCount}문항`,
    status, buttons);
}

let quizQuestions = [];
let quizDraftTimer = null;

function saveQuizDraft() {
  clearTimeout(quizDraftTimer);
  quizDraftTimer = setTimeout(() => {
    const answers = QT.collect($("quizBody"), quizQuestions);
    draftChanged(answers, quizIndex);   // 기기에는 바로, 서버에는 잠시 쉬었을 때
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
  // 어디까지 풀었는지도 함께 — 다른 기기에서 그 문항부터 연다. 처음 그릴 때는 보내지 않는다
  // (기기에 남은 옛 답을 서버의 더 최근 답보다 먼저 덮어쓰지 않게)
  if (!quizDrawing) draftMoved(quizIndex);
}
let quizDrawing = false;
$("quizPrevBtn").addEventListener("click", () => { clearTimeout(quizAutoTimer); showQuizStep(quizIndex - 1); });
$("quizNextBtn").addEventListener("click", () => { clearTimeout(quizAutoTimer); showQuizStep(quizIndex + 1); });
// 객관식도 보기를 눌러도 자동으로 넘어가지 않는다 — 보기를 하나씩 지워 가며(✕) 검토하고
// 직접 [다음]을 누르게 한다(2026-10-27 사용자: 자동으로 넘어가면 검토가 안 된다)

let quizRetryRound = 0;   // 0이면 일반 시험, 1·2면 보충 학습 회차
function openQuiz(assignmentId, data) {
  currentAssignmentId = assignmentId;
  quizRetryRound = data.retry ? Number(data.retryRound) || 0 : 0;
  quizQuestions = data.questions || [];
  $("quizTitle").textContent = data.title || "문제 시험";
  $("quizError").textContent = "";
  clearTimeout(quizAutoTimer); quizAutoTimer = null;
  clearTimeout(quizDraftTimer);
  const ctx = draftBegin(assignmentId, quizRetryRound ? "retry" : "quiz", quizRetryRound);
  const draw = (saved) => {
    $("quizBody").innerHTML = quizQuestions.map((q, i) => QT.questionHtml(q, i, "take")).join("");
    if (saved && Array.isArray(saved.answers)) QT.restore($("quizBody"), quizQuestions, saved.answers);
    quizIndex = saved ? Math.min(Number(saved.index) || 0, Math.max(0, quizQuestions.length - 1)) : 0;
    quizDrawing = true;
    try { showQuizStep(quizIndex); } finally { quizDrawing = false; }
  };
  draftNote($("quizBody"), "");
  draw(null);
  showOnly(quizWorkspaceEl);
  draftRestore(ctx, (saved, fromServer) => {
    if (quizWorkspaceEl.hidden || draft.ctx !== ctx) return;
    draw(saved);
    draftNote($("quizBody"), fromServer ? "💾 저장해 둔 답을 불러왔어요. 이어서 풀면 돼요." : "");
  });
}

QT.bind($("quizBody"), saveQuizDraft);
$("quizBackBtn").addEventListener("click", () => {
  clearTimeout(quizDraftTimer);
  if (draft.ctx && draft.edited) draftChanged(QT.collect($("quizBody"), quizQuestions), quizIndex);
  draftFlush();
  showOnly(listWorkspaceEl); loadTests();
});
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
    const answers = QT.collect($("quizBody"), quizQuestions);
    const r = quizRetryRound
      ? await postJson("/api/student/retry/submit", { assignmentId: currentAssignmentId, round: quizRetryRound, answers })
      : await postJson("/api/student/tests/submit", { assignmentId: currentAssignmentId, answers });
    draftDone();
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
    (qc.pending ? ` 선생님이 확인할 ${qc.unit ? "칸" : "문항"}이 ${qc.pending}개 있어요.` : "");
  $("quizWrongOnly").checked = false;
  $("quizResultBody").innerHTML = items.map((q, i) => QT.questionHtml(q, i, "review")).join("");
  quizResultData = r;
  renderQuizRetryBox(r);
  showOnly(quizResultWorkspaceEl);
}

/* ══════ 보충 학습 — 선생님이 '다시 풀기'를 켠 시험 ══════
   결과 화면 → [틀린 문제 다시 학습하기](틀린 문제만 정답·해설과 함께 다시 읽기) → [다음]을 누르면 서버가
   같은 내용의 새 문제(객관식은 시험에 낸 다른 객관식 유형, 주관식은 같은 유형의 주관식)를 만들어 주고(선생님 포인트 차감), 그 문제를 풀면 같은 결과 화면으로 돌아온다. */
let quizResultData = null;
const quizItemWrong = (q) => (q.units || []).some((u) => u.ok === false);

function renderQuizRetryBox(r) {
  const box = $("quizRetryBox");
  const st = r.retry;
  $("quizRetryError").textContent = "";
  $("quizResultBackBtn").hidden = false;
  if (!st || !st.enabled) { box.hidden = true; return; }
  const rounds = (st.rounds || []).filter((x) => x.status === "done");
  $("quizRetryRounds").innerHTML = rounds.length
    ? "보충 학습 기록: " + rounds.map((x) => `${x.round}회차 ${QT.countsText(x.qc || { right: 0, wrong: 0, pending: 0 }, true)}`).join(" · ")
    : "";
  const btn = $("quizRetryStartBtn");
  btn.hidden = false;
  // 선생님이 켠 보충 학습은 필수 — 마칠 때까지 목록으로 못 나간다(다시 들어와도 목록에서 '보충 학습 해야 해요'가 붙는다)
  $("quizResultBackBtn").hidden = !!st.todo;
  if (st.open) {
    $("quizRetryText").textContent = `풀던 보충 ${st.open}회차 문제가 있어요. 꼭 마쳐야 해요.`;
    btn.textContent = "▶ 이어서 풀기";
    btn.dataset.mode = "resume";
    box.hidden = false;
  } else if (st.canStart) {
    $("quizRetryText").textContent = `선생님이 정한 보충 학습이에요. 틀린 문제 ${st.wrongCount}개를 다시 학습하고, 개념을 읽은 뒤, 같은 내용의 새 문제를 꼭 풀어야 해요 (보충 ${st.nextRound}/${st.maxRounds}회).`;
    btn.textContent = "🔁 틀린 문제 다시 학습하기";
    btn.dataset.mode = "study";
    box.hidden = false;
  } else {
    btn.hidden = true;
    $("quizRetryText").textContent = rounds.length
      ? (st.wrongCount ? `보충 학습 ${st.maxRounds}회를 모두 마쳤어요.` : "보충 학습에서 모두 맞혔어요! 🎉")
      : "";
    box.hidden = !rounds.length;
  }
}

// 새로고침 전에 누른 요청이 아직 문제를 만드는 중이면 서버가 making으로 답한다 — 오류를 띄우지 않고
// 잠시 뒤 다시 물어 다 만든 문제를 이어 받는다(2026-11-09 사용자: 기다리다 새로고침한 학생이 오류만 봤다).
// 다시 묻기만 하므로 값이 또 나가지 않는다. 다른 화면으로 가면 그만 묻는다.
const RETRY_MAKING_POLL_MS = 4000;
const RETRY_MAKING_POLL_MAX = 70;
async function startQuizRetry(statusEl, errEl, btn) {
  errEl.textContent = "";
  btn.disabled = true;
  statusEl.textContent = "새 문제를 만드는 중이에요…";
  const aid = currentAssignmentId;
  // 단추가 든 화면이 아직 보이고 같은 시험이어야 이어 받는다(목록으로 갔으면 그만둔다)
  const stillHere = () => currentAssignmentId === aid && btn.offsetParent !== null;
  try {
    let data = null;
    for (let tries = 0; ; tries++) {
      try {
        data = await postJson("/api/student/retry/start", { assignmentId: aid });
        break;
      } catch (err) {
        if (!err.making || tries >= RETRY_MAKING_POLL_MAX) throw err;
        statusEl.textContent = "새 문제를 만드는 중이에요… 창을 닫지 말고 기다려 주세요.";
        await new Promise((r) => setTimeout(r, RETRY_MAKING_POLL_MS));
        if (!stillHere()) return;   // 그사이 다른 화면으로 갔다
      }
    }
    if (!stillHere()) return;
    if ((data.concepts || []).length) showQuizConcepts(data);   // 개념 정리를 읽어야 새 문제로 넘어간다
    else openQuiz(currentAssignmentId, data);
  } catch (err) {
    errEl.textContent = err.message || "새 문제를 만들지 못했어요.";
  } finally {
    btn.disabled = false;
    statusEl.textContent = "";
  }
}

let quizConceptPending = null;
function showQuizConcepts(data) {
  quizConceptPending = data;
  $("quizConceptBody").innerHTML = data.concepts.map((c) => `<div class="panel" style="margin-bottom:12px;">
      <div style="font-weight:800; font-size:16px; margin-bottom:6px;">${esc(c.topic)}</div>
      <p style="margin:0 0 8px;">${esc(c.summary)}</p>
      ${(c.points || []).length ? `<ul style="margin:0 0 8px; padding-left:20px;">${c.points.map((p) => `<li>${esc(p)}</li>`).join("")}</ul>` : ""}
      ${(c.examples || []).length ? `<div class="hint" style="background:var(--bg-soft,#f3f6fb); padding:8px 10px; border-radius:8px;">${c.examples.map((x) => `<div>${esc(x)}</div>`).join("")}</div>` : ""}
    </div>`).join("");
  showOnly(quizConceptWorkspaceEl);
}
$("quizConceptNextBtn").addEventListener("click", () => {
  if (quizConceptPending) openQuiz(currentAssignmentId, quizConceptPending);
});

$("quizRetryStartBtn").addEventListener("click", (e) => {
  if (e.currentTarget.dataset.mode === "resume") {
    startQuizRetry($("quizRetryText"), $("quizRetryError"), e.currentTarget);
    return;
  }
  const wrong = ((quizResultData && quizResultData.items) || [])
    .map((q, i) => ({ q, i })).filter(({ q }) => quizItemWrong(q));
  $("quizStudyTitle").textContent = `틀린 문제 다시 학습 (${wrong.length}개)`;
  $("quizStudyBody").innerHTML = wrong.map(({ q, i }) => QT.questionHtml(q, i, "review")).join("");
  $("quizStudyError").textContent = "";
  showOnly(quizStudyWorkspaceEl);
});
$("quizStudyBackBtn").addEventListener("click", () => showOnly(quizResultWorkspaceEl));
$("quizStudyNextBtn").addEventListener("click", (e) =>
  startQuizRetry($("quizStudyStatus"), $("quizStudyError"), e.currentTarget));

$("quizWrongOnly").addEventListener("change", (e) => {
  const only = e.target.checked;
  $("quizResultBody").querySelectorAll(".qt-card").forEach((c) => {
    c.hidden = only && c.dataset.status === "ok";
  });
});
