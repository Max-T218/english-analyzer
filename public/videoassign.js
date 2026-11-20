"use strict";
/* ══════ 지문 강의 영상 과제 부여(2026-11-20 사용자) ══════
   학생 관리 탭의 [🎬 영상 과제 부여]와 지문 강의 영상 탭 카드의 [🏫 반에 과제 부여]가 같은 창을 연다.
   영상은 한 번 올려 두면(/api/lessonvideo/*, Firestore 조각) 여러 반·학생에게 다시 올리지 않고 낼 수 있다.
   과제는 문제 시험(/api/quiz-tests)에 videoId를 더한 것이다 — 확인 문제는 선택이고, 있으면 영상을 다 본 뒤에야 열린다.
   app.js·lesson.js 뒤에 불러와 그쪽 전역(getJson·postJson·fillTargetList·postForTargets·quizQuestionsFromSaved…)을 쓴다. */
const VA_CHUNK = 700 * 1024;   // server.py VIDEO_CHUNK와 같은 값
const VA_W = 1280, VA_H = 720, VA_FPS = 15, VA_BITRATE = 1_200_000;   // 저장함 영상으로 과제를 낼 때 만드는 영상의 크기·초당 장수·압축 목표
const vaEl = (id) => document.getElementById(id);
let vaNow = null;        // 지문 강의 영상 탭에서 연 경우 — 지금 만든 영상(lsState의 entry)
let vaSaved = null;      // 저장함 목록(확인 문제 고르기용)
let vaSavedLessons = []; // 저장함의 지문 강의 영상 저장본
const vaSavedVideo = new Map();   // "저장본id:영상 차례" → {videoId, title} — 이 창을 연 동안 같은 영상을 다시 올리지 않는다

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

// 지금 만든 영상의 이름 — 저장함에서 불러온 영상이면 그 저장 이름, 아니면 AI가 지은 영상 제목
function vaNowTitle() {
  if (!vaNow) return "";
  const loaded = typeof LOADED_SAVED !== "undefined" && LOADED_SAVED.lesson;
  const one = lsState.entries.filter((e) => e.script).length === 1;
  return (loaded && one && LOADED_SAVED.lesson.title) || vaNow.script.title || vaNow.name || "";
}
const vaMin = (s) => `${Math.floor(s / 60)}분 ${Math.round(s % 60)}초`;
async function vaVideos() {
  let list = [];
  try { list = (await getJson("/api/lessonvideo/list", "")).videos || []; } catch (err) { vaEl("vaError").textContent = err.message || ""; }
  try { vaSavedLessons = ((await getJson("/api/saved", "")).items || []).filter((it) => it.tab === "lesson"); } catch (_) { vaSavedLessons = []; }
  const row = (value, html, checked, title) =>
    `<label class="chk" style="display:block; margin:4px 0;"><input type="checkbox" name="vaVideo" value="${esc(value)}" data-title="${esc(title || "")}"${checked ? " checked" : ""}> ${html}</label>`;
  let html = "";
  if (vaNow) {
    const mb = (vaNow.video.blob.size / 1e6).toFixed(0);
    html += row("now", `🆕 지금 만든 영상 — ${esc(vaNowTitle())} <span class="hint">(${vaMin(lsTimeline(vaNow).total)} · ${mb}MB · 올리면서 냅니다)</span>`, true, vaNowTitle());
  }
  const savedHtml = vaSavedLessons.map((it) =>
    row(`saved:${it.id}`, `${esc(it.title || "제목 없음")} <span class="hint">(저장함 · 영상 파일을 새로 만들어 올립니다)</span>`, false, it.title || "")).join("");
  html += list.map((v, i) =>
    row(v.id, `${esc(v.title)} <span class="hint">(${vaMin(v.seconds)} · ${(v.size / 1e6).toFixed(0)}MB · 올려 둔 영상)</span>
      <button type="button" class="btn ghost small va-ren" data-id="${esc(v.id)}" data-title="${esc(v.title)}" style="margin-left:6px;">이름</button>
      <button type="button" class="btn ghost small va-del" data-id="${esc(v.id)}" style="margin-left:6px;">지우기</button>`, !vaNow && i === 0, v.title)).join("");
  if (savedHtml) {
    html += `<p class="hint" style="margin:10px 0 2px;"><b>💾 저장함의 지문 강의 영상</b> — 고르면 저장해 둔 대본·목소리로 영상 파일을 만들어 올리고 과제를 냅니다.
      브라우저에서 만드는 데 영상 길이만큼(몇 분) 걸리니 <b>끝날 때까지 이 창을 켜 두세요.</b> 여러 개를 체크하면 영상마다 과제가 하나씩 나가고, 과제 이름은 저장해 둔 이름 그대로입니다.</p>${savedHtml}`;
  }
  vaEl("vaVideoList").innerHTML = html || `<p class="hint">올려 둔 영상이 없습니다. 지문 강의 영상 탭에서 영상을 만든 뒤 [🏫 반에 과제 부여]를 눌러 주세요.</p>`;
}
vaEl("vaVideoList").addEventListener("click", async (ev) => {
  const rn = ev.target.closest(".va-ren");
  if (rn) {
    ev.preventDefault();
    const name = prompt("영상 이름을 바꿉니다(이미 낸 과제 이름은 그대로입니다).", rn.dataset.title || "");
    if (name == null || !name.trim()) return;
    try { await postJson("/api/lessonvideo/rename", { videoId: rn.dataset.id, title: name.trim() }, "이름을 바꾸지 못했습니다."); await vaVideos(); }
    catch (err) { vaEl("vaError").textContent = err.message || ""; }
    return;
  }
  const b = ev.target.closest(".va-del");
  if (!b) return;
  ev.preventDefault();
  if (!confirm("이 영상을 지울까요? 이미 과제로 낸 영상은 지울 수 없습니다.")) return;
  try { await postJson("/api/lessonvideo/delete", { videoId: b.dataset.id }, "영상을 지우지 못했습니다."); vaSavedVideo.clear(); await vaVideos(); }
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
async function vaUpload(entry, onProgress, title) {
  const v = entry.video;
  if (v.vaId && v.vaSig === v.sig) return v.vaId;
  const blob = v.blob, n = Math.ceil(blob.size / VA_CHUNK);
  const { videoId } = await postJson("/api/lessonvideo/begin", {
    title: String(title || entry.script.title || entry.name || "지문 강의 영상"),
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

// 저장함의 지문 강의 영상 → 대본·목소리를 받아 영상 파일(mp4)을 이 브라우저에서 만들고 올린다.
// 지문 강의 영상 탭의 화면 상태(lsState)는 건드리지 않는다 — 저장본의 영상은 따로 펼친다.
async function vaBuildFromSaved(itemId, status) {
  status.textContent = "저장함에서 불러오는 중…";
  const item = await getJson(`/api/saved/${encodeURIComponent(itemId)}`, "저장본을 불러오지 못했습니다.");
  const payload = item.payload || {};
  const entries = (payload.entries || []).filter((e) => e && e.script).map((e) => ({ ...e, audio: e.script.segments.map(() => null), error: "" }));
  if (!entries.length) throw new Error("이 저장본에는 영상이 없습니다.");
  const cached = entries.map((_, i) => vaSavedVideo.get(`${itemId}:${i}`));
  if (!cached.every(Boolean)) {
    status.textContent = "목소리를 받는 중…";
    await lsLoadAudio(entries, itemId, payload);
    if (entries.some((e) => !lsReady(e))) {
      throw new Error("목소리가 빠진 영상입니다 — '지문 강의 영상' 탭에서 불러와 [🔁 빠진 목소리 만들기]를 누르고 다시 저장한 뒤 낼 수 있습니다.");
    }
    if (lsMp4Ok === null) lsMp4Ok = typeof rlmSupported === "function" ? await rlmSupported(LS_W, LS_H) : false;
    if (!lsMp4Ok) throw new Error("이 브라우저는 영상 파일 만들기를 지원하지 않습니다 — PC 크롬에서 열어 주세요.");
    await lsFontReady();
  }
  const out = [];
  for (let i = 0; i < entries.length; i++) {
    if (cached[i]) { out.push(cached[i]); continue; }
    const e = entries[i], tag = entries.length > 1 ? ` (${i + 1}/${entries.length})` : "";
    status.textContent = `영상 파일 만드는 중${tag} 0%`;
    const t0 = Date.now();
    // 과제용은 화면 크기·초당 장수를 줄여 만든다(1280×720·15장 — 필기·글씨는 그대로 또렷하고, 만드는 시간과 파일 크기가 크게 준다)
    const ctl = rlEncodeMp4(e, { onProgress: (p) => {
        const left = p > 0.05 ? Math.ceil(((Date.now() - t0) / p) * (1 - p) / 1000) : 0;
        status.textContent = `영상 파일 만드는 중${tag} ${Math.round(p * 100)}%${left ? ` · 약 ${left >= 60 ? Math.ceil(left / 60) + "분" : left + "초"} 남음` : ""}`;
      },
      w: VA_W, h: VA_H, fps: VA_FPS, timeline: lsTimeline, load: lsAssets, bitrate: VA_BITRATE,
      draw: (ctx, en, tl, as, t) => { ctx.save(); ctx.scale(VA_W / LS_W, VA_H / LS_H); lsDraw(ctx, en, tl, as, t); ctx.restore(); } });
    const { blob } = await ctl.done;
    if (!blob || !blob.size) throw new Error("영상 파일을 만들지 못했습니다.");
    e.video = { blob, sig: "saved" };
    // 저장해 둔 이름을 그대로 쓴다 — AI가 지은 영상 제목(script.title)으로 바꾸지 않는다. 저장본에 영상이 여럿이면 '저장 이름_영상 제목'
    const title = entries.length === 1 ? (item.title || e.script.title || e.name) : `${item.title || "영상"}_${e.script.title || e.name}`;
    const videoId = await vaUpload(e, (k, n) => { status.textContent = `영상 올리는 중${tag} ${Math.round((k / n) * 100)}%`; }, title);
    const rec = { videoId, title };
    vaSavedVideo.set(`${itemId}:${i}`, rec);
    out.push(rec);
  }
  return out;
}

vaEl("videoAssignForm").addEventListener("submit", async (ev) => {
  ev.preventDefault();
  const err = vaEl("vaError"), status = vaEl("vaStatus"), btn = vaEl("vaSubmitBtn");
  err.textContent = "";
  const classId = vaEl("vaClassSelect").value;
  if (!classId) { err.textContent = "반을 먼저 만들어 주세요."; return; }
  const targets = targetIdsOf(vaEl("vaTargetSelect"));
  if (targets && !targets.length) { err.textContent = "낼 대상을 골라 주세요."; return; }
  const picks = [...document.querySelectorAll('input[name="vaVideo"]:checked')];
  if (!picks.length) { err.textContent = "낼 영상을 하나 이상 골라 주세요."; return; }
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
    const typed = vaEl("vaTitle").value.trim();
    // 낼 영상 목록 [{videoId, title}] — 올려 둔 영상 하나, 지금 만든 영상 하나, 또는 저장본에서 만든 영상 여럿
    let videos = [];
    for (const pick of picks) {
      if (pick.value === "now") {
        status.textContent = "영상을 올리는 중… 0%";
        const title = vaNowTitle();
        videos.push({ videoId: await vaUpload(vaNow, (i, n) => { status.textContent = `영상을 올리는 중… ${Math.round((i / n) * 100)}%`; }, title), title });
      } else if (pick.value.startsWith("saved:")) {
        videos.push(...await vaBuildFromSaved(pick.value.slice(6), status));
      } else {
        videos.push({ videoId: pick.value, title: pick.dataset.title || "지문 강의 영상" });
      }
    }
    let made = 0, qs = 0;
    for (const v of videos) {
      status.textContent = videos.length > 1 ? `과제를 내는 중… ${made + 1}/${videos.length}` : "과제를 내는 중…";
      const title = videos.length === 1 ? (typed || v.title) : (typed ? `${typed}_${v.title}` : v.title);
      const r = await postForTargets(vaEl("vaTargetSelect"), (studentId) => postJson("/api/quiz-tests", {
        classId, studentId, title, questions, source: "quiz", origin: kind, videoId: v.videoId,
      }, "과제 내기에 실패했습니다."));
      made++; qs = r.questions || 0;
    }
    closeModal(vaEl("videoAssignModalOverlay"));
    if (classId === selectedClassId && typeof loadAssignedTests === "function") loadAssignedTests();
    alert(`영상 과제 ${made > 1 ? made + "개를" : "를"} 냈습니다.${qs ? ` 확인 문제 ${qs}문항이 영상 뒤에 열립니다.` : ""} '학생 관리' 탭의 시험 목록에서 시청 현황을 볼 수 있습니다.`);
  } catch (e) {
    err.textContent = e.message || "과제 내기에 실패했습니다.";
  } finally {
    vaRelease();
  }
});
vaEl("videoAssignModalClose").addEventListener("click", () => closeModal(vaEl("videoAssignModalOverlay")));
vaEl("goVideoAssignBtn").addEventListener("click", () => vaOpen(null));
