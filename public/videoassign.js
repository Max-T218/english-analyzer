"use strict";
/* ══════ 지문 강의 영상 과제 부여(2026-11-20 사용자) ══════
   학생 관리 탭의 [🎬 영상 과제 부여]와 지문 강의 영상 탭 카드의 [🏫 반에 과제 부여]가 같은 창을 연다.
   영상은 한 번 올려 두면(/api/lessonvideo/*, Firestore 조각) 여러 반·학생에게 다시 올리지 않고 낼 수 있다.
   과제는 문제 시험(/api/quiz-tests)에 videoId를 더한 것이다 — 확인 문제는 선택이고, 있으면 영상을 다 본 뒤에야 열린다.
   app.js·lesson.js 뒤에 불러와 그쪽 전역(getJson·postJson·fillTargetList·postForTargets·quizQuestionsFromSaved…)을 쓴다. */
const VA_CHUNK = 700 * 1024;   // server.py VIDEO_CHUNK와 같은 값
const vaEl = (id) => document.getElementById(id);
let vaNow = null;        // 지문 강의 영상 탭에서 연 경우 — 지금 만든 영상(lsState의 entry)
let vaSaved = null;      // 저장함 목록(확인 문제 고르기용)

function vaRelease() { vaEl("vaStatus").textContent = ""; vaEl("vaSubmitBtn").disabled = false; }

async function vaOpen(entry) {
  vaNow = entry && lsVidOk(entry) ? entry : null;
  vaEl("vaError").textContent = "";
  vaEl("vaTitle").value = vaNow ? String(vaNow.script.title || vaNow.name || "") : "";
  vaEl("vaQuizKind").value = "";
  vaEl("vaQuizList").hidden = true;
  vaSaved = null;
  try { classesCache = (await getJson("/api/classes", "")).classes || []; } catch (_) { classesCache = []; }
  vaEl("vaClassSelect").innerHTML = classesCache.length
    ? classesCache.map((c) => `<option value="${esc(c.id)}"${c.id === selectedClassId ? " selected" : ""}>${esc(c.name)}</option>`).join("")
    : `<option value="">먼저 '학생 관리' 탭에서 반을 만들어 주세요</option>`;
  await vaTargets();
  await vaVideos();
  openModal(vaEl("videoAssignModalOverlay"));
}

async function vaTargets() {
  const classId = vaEl("vaClassSelect").value;
  let students = [];
  if (classId) {
    try { students = (await getJson(`/api/students?classId=${encodeURIComponent(classId)}`, "")).students || []; } catch (_) { students = []; }
  }
  fillTargetList(vaEl("vaTargetSelect"), students);
}
vaEl("vaClassSelect").addEventListener("change", vaTargets);

const vaMin = (s) => `${Math.floor(s / 60)}분 ${Math.round(s % 60)}초`;
async function vaVideos() {
  let list = [];
  try { list = (await getJson("/api/lessonvideo/list", "")).videos || []; } catch (err) { vaEl("vaError").textContent = err.message || ""; }
  const row = (value, html, checked) =>
    `<label class="chk" style="display:block; margin:4px 0;"><input type="radio" name="vaVideo" value="${esc(value)}"${checked ? " checked" : ""}> ${html}</label>`;
  let html = "";
  if (vaNow) {
    const mb = (vaNow.video.blob.size / 1e6).toFixed(0);
    html += row("now", `🆕 지금 만든 영상 — ${esc(vaNow.script.title || vaNow.name)} <span class="hint">(${vaMin(lsTimeline(vaNow).total)} · ${mb}MB · 올리면서 냅니다)</span>`, true);
  }
  html += list.map((v, i) =>
    row(v.id, `${esc(v.title)} <span class="hint">(${vaMin(v.seconds)} · ${(v.size / 1e6).toFixed(0)}MB · 올려 둔 영상)</span>
      <button type="button" class="btn ghost small va-del" data-id="${esc(v.id)}" style="margin-left:6px;">지우기</button>`, !vaNow && i === 0)).join("");
  vaEl("vaVideoList").innerHTML = html || `<p class="hint">올려 둔 영상이 없습니다. 지문 강의 영상 탭에서 영상을 만든 뒤 [🏫 반에 과제 부여]를 눌러 주세요.</p>`;
}
vaEl("vaVideoList").addEventListener("click", async (ev) => {
  const b = ev.target.closest(".va-del");
  if (!b) return;
  ev.preventDefault();
  if (!confirm("이 영상을 지울까요? 이미 과제로 낸 영상은 지울 수 없습니다.")) return;
  try { await postJson("/api/lessonvideo/delete", { videoId: b.dataset.id }, "영상을 지우지 못했습니다."); await vaVideos(); }
  catch (err) { vaEl("vaError").textContent = err.message || ""; }
});

vaEl("vaQuizKind").addEventListener("change", async () => {
  const kind = vaEl("vaQuizKind").value;
  const box = vaEl("vaQuizList");
  box.hidden = !kind;
  if (!kind) return;
  if (!vaSaved) {
    try { vaSaved = (await getJson("/api/saved", "")).items || []; } catch (_) { vaSaved = []; }
  }
  const rows = vaSaved.filter((it) => it.tab === kind);
  box.innerHTML = rows.length
    ? rows.map((it) => `<label class="chk" style="display:block; margin:4px 0;"><input type="radio" name="vaQuizPick" value="${esc(it.id)}"> ${esc(it.title || "제목 없음")}</label>`).join("")
    : `<p class="hint">저장된 자료가 없습니다. 그 탭에서 만든 뒤 [💾 사이트 저장]을 눌러 두세요.</p>`;
});

function vaBase64(blob) {
  return new Promise((res, rej) => {
    const r = new FileReader();
    r.onload = () => res(String(r.result).split(",")[1] || "");
    r.onerror = () => rej(new Error("영상을 읽지 못했습니다."));
    r.readAsDataURL(blob);
  });
}

// 지금 만든 영상을 서버에 올린다 — 조각 700KB씩. 같은 영상을 다시 낼 때는 올리지 않고 올린 것을 쓴다
async function vaUpload(entry, onProgress) {
  const v = entry.video;
  if (v.vaId && v.vaSig === v.sig) return v.vaId;
  const blob = v.blob, n = Math.ceil(blob.size / VA_CHUNK);
  const { videoId } = await postJson("/api/lessonvideo/begin", {
    title: String(entry.script.title || entry.name || "지문 강의 영상"),
    seconds: lsTimeline(entry).total, size: blob.size, chunks: n,
  }, "영상을 올리지 못했습니다.");
  for (let i = 0; i < n; i++) {
    onProgress(i, n);
    const data = await vaBase64(blob.slice(i * VA_CHUNK, (i + 1) * VA_CHUNK));
    await postJson("/api/lessonvideo/chunk", { videoId, index: i, data }, "영상을 올리지 못했습니다.");
  }
  await postJson("/api/lessonvideo/finish", { videoId }, "영상을 올리지 못했습니다.");
  v.vaId = videoId; v.vaSig = v.sig;
  return videoId;
}

vaEl("videoAssignForm").addEventListener("submit", async (ev) => {
  ev.preventDefault();
  const err = vaEl("vaError"), status = vaEl("vaStatus"), btn = vaEl("vaSubmitBtn");
  err.textContent = "";
  const classId = vaEl("vaClassSelect").value;
  if (!classId) { err.textContent = "반을 먼저 만들어 주세요."; return; }
  const targets = targetIdsOf(vaEl("vaTargetSelect"));
  if (targets && !targets.length) { err.textContent = "낼 대상을 골라 주세요."; return; }
  const pick = document.querySelector('input[name="vaVideo"]:checked');
  if (!pick) { err.textContent = "낼 영상을 골라 주세요."; return; }
  const kind = vaEl("vaQuizKind").value;
  const quizPick = kind ? document.querySelector('input[name="vaQuizPick"]:checked') : null;
  if (kind && !quizPick) { err.textContent = "확인 문제로 낼 저장본을 골라 주세요(문제 없이 내려면 '문제 없이 영상만'을 고르세요)."; return; }
  btn.disabled = true;
  try {
    let questions = [];
    if (kind) {
      status.textContent = "확인 문제를 불러오는 중…";
      const item = await getJson(`/api/saved/${encodeURIComponent(quizPick.value)}`, "저장본을 불러오지 못했습니다.");
      questions = withoutRetrySource(quizQuestionsFromSaved(kind, item).questions, null);
      if (!questions.length) throw new Error("이 저장본에는 학생에게 낼 문항이 없습니다.");
      if (questions.length > QUIZ_TEST_MAX_QUESTIONS) throw new Error(`문항이 ${questions.length}개라 한 번에 낼 수 없습니다(${QUIZ_TEST_MAX_QUESTIONS}문항까지).`);
    }
    let videoId = pick.value, title = vaEl("vaTitle").value.trim();
    if (videoId === "now") {
      status.textContent = "영상을 올리는 중… 0%";
      videoId = await vaUpload(vaNow, (i, n) => { status.textContent = `영상을 올리는 중… ${Math.round((i / n) * 100)}%`; });
    }
    if (!title) title = (vaNow && videoId && vaNow.video.vaId === videoId ? (vaNow.script.title || vaNow.name) : "") ||
      (pick.parentElement.textContent.split("(")[0] || "").replace(/^🆕 지금 만든 영상 — /, "").trim() || "지문 강의 영상";
    status.textContent = "과제를 내는 중…";
    const r = await postForTargets(vaEl("vaTargetSelect"), (studentId) => postJson("/api/quiz-tests", {
      classId, studentId, title, questions, source: "quiz", origin: kind, videoId,
    }, "과제 내기에 실패했습니다."));
    closeModal(vaEl("videoAssignModalOverlay"));
    if (classId === selectedClassId && typeof loadAssignedTests === "function") loadAssignedTests();
    alert(`영상 과제를 냈습니다.${r.questions ? ` 확인 문제 ${r.questions}문항이 영상 뒤에 열립니다.` : ""} '학생 관리' 탭의 시험 목록에서 시청 현황을 볼 수 있습니다.`);
  } catch (e) {
    err.textContent = e.message || "과제 내기에 실패했습니다.";
  } finally {
    vaRelease();
  }
});
vaEl("videoAssignModalClose").addEventListener("click", () => closeModal(vaEl("videoAssignModalOverlay")));
vaEl("goVideoAssignBtn").addEventListener("click", () => vaOpen(null));
