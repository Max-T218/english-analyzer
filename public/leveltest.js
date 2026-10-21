/* ══════ 레벨테스트 탭 (선생님 쪽) ══════
   관리자가 켜 준 선생님만 보인다(renderAccount가 leveltestTabBtn을 켜고 끈다, 서버 _leveltest_approved).
   ① 시험 출제 — 시험지 하나 + 레벨테스트 학생(여럿)에게 낸다(2026-10-21 사용자: 학생 관리처럼 학생들이
      한 사이트에 로그인해서 보되, 학생 관리와 따로 test.html로). 학생은 test.html 목록에서 연다(lt.html).
      제출하면 서버가 그 출제를 닫는다 — 다시 보게 하려면 [다시 보게 하기].
   ③ 레벨테스트 학생 — 이름·아이디·비밀번호 등록/고치기/삭제(server.py lt_create_student 등).
   ② 응시 결과 목록 → 리포트(정오답표 포함) → 우리말 답 칸 [맞음]/[틀림] → 인쇄.
   학생 화면은 public/lt.html·lt.js, 리포트 그리기는 둘이 같이 쓰는 public/ltreport.js.
   app.js 뒤에 로드되고 app.js의 전역($·esc·getJson·postJson·openPrintWindow·trendBrand)을 쓴다. */
(function () {
  "use strict";
  const tabBtn = $("leveltestTabBtn");
  if (!tabBtn) return;

  let ltSets = [];
  let ltLinks = [];
  let ltResults = [];
  let ltOpen = null;          // 열어 둔 결과 { id, report, … }
  let ltLoaded = false;
  let ltStudents = [];        // 레벨테스트 학생(학생 관리와 따로)

  const testUrl = `${location.origin}/test.html`;
  $("ltStudentUrl").textContent = testUrl;
  $("ltCopyUrlBtn").addEventListener("click", () => {
    const ok = () => { $("ltNotice").textContent = "주소를 복사했습니다."; };
    if (navigator.clipboard && navigator.clipboard.writeText) navigator.clipboard.writeText(testUrl).then(ok, () => prompt("아래 주소를 복사하세요", testUrl));
    else prompt("아래 주소를 복사하세요", testUrl);
  });
  const fmtWhen = (iso) => {
    if (!iso) return "";
    const d = new Date(iso);
    if (isNaN(d)) return "";
    const p = (n) => String(n).padStart(2, "0");
    return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;
  };
  const fmtDur = (sec) => (sec == null ? "" : `${Math.floor(sec / 60)}분 ${sec % 60}초`);

  function brandOf() {
    const b = typeof trendBrand === "function" ? trendBrand() : null;
    return { academy: (b && b.name) || "", logo: (b && b.img) || "" };
  }

  async function ltRefresh() {
    $("ltError").textContent = "";
    try {
      const [s, l, r, ro] = await Promise.all([
        getJson("/api/leveltest/sets", "시험지 목록을 불러오지 못했습니다."),
        getJson("/api/leveltest/links", "출제한 시험을 불러오지 못했습니다."),
        getJson("/api/leveltest/results", "응시 결과를 불러오지 못했습니다."),
        getJson("/api/leveltest/students", "학생 목록을 불러오지 못했습니다."),
      ]);
      ltStudents = ro.students || [];
      renderStudentPicker();
      renderStudentList();
      ltSets = s.sets || [];
      ltLinks = l.links || [];
      ltResults = r.results || [];
      ltLoaded = true;
      renderSetPicker();
      renderLinks();
      renderResults();
    } catch (e) {
      $("ltError").textContent = e.message;
    }
  }

  /* ── ① 시험 출제 ── */
  function renderStudentPicker() {
    const box = $("ltStudentPicker");
    const keep = new Set([...box.querySelectorAll("input[value]:checked")].map((x) => x.value));
    box.innerHTML = ltStudents.length
      ? `<label class="lt-set"><input type="checkbox" data-all="1"> <b>전체 선택</b></label>` +
        ltStudents.map((st) => `<label class="lt-set"><input type="checkbox" value="${esc(st.id)}"${keep.has(st.id) ? " checked" : ""}> ${esc(st.name)} <span class="hint">${esc(st.loginId)}</span></label>`).join("")
      : `<p class="hint">아직 등록한 학생이 없습니다.</p>`;
    $("ltPickWrap").hidden = !ltStudents.length;
  }

  // 아이디 칸은 이름을 따라 저절로 채운다(띄어쓰기 뺌, 2026-10-21 사용자: 이름을 그대로 아이디로).
  // 선생님이 아이디 칸을 직접 고치면 그때부터는 따라 바꾸지 않는다.
  let ltIdTouched = false;
  $("ltNewName").addEventListener("input", () => {
    if (!ltIdTouched) $("ltNewId").value = $("ltNewName").value.replace(/\s+/g, "").toLowerCase();
  });
  $("ltNewId").addEventListener("input", () => { ltIdTouched = $("ltNewId").value.trim() !== ""; });

  /* ── ③ 레벨테스트 학생 ── */
  function renderStudentList() {
    const box = $("ltStudentList");
    box.innerHTML = ltStudents.length
      ? `<table class="lt-table"><thead><tr><th>이름</th><th>아이디</th><th>등록일</th><th></th></tr></thead><tbody>${
        ltStudents.map((st) => `<tr data-id="${esc(st.id)}">
          <td><b>${esc(st.name)}</b></td><td>${esc(st.loginId)}</td>
          <td>${esc(fmtWhen(st.createdAt))}</td>
          <td><button type="button" class="btn ghost small" data-act="edit">이름·아이디</button>
            <button type="button" class="btn ghost small danger" data-act="del">삭제</button></td>
        </tr>`).join("")}</tbody></table>`
      : `<p class="hint">아직 등록한 학생이 없습니다.</p>`;
  }

  $("ltStudentList").addEventListener("click", async (e) => {
    const b = e.target.closest("button[data-act]");
    if (!b) return;
    const id = b.closest("tr").dataset.id;
    const st = ltStudents.find((x) => x.id === id);
    if (!st) return;
    let body = null;
    if (b.dataset.act === "edit") {
      const name = prompt("이름", st.name);
      if (name == null) return;
      const loginId = prompt("아이디 (한글·영문 소문자·숫자 2~20자)", st.loginId);
      if (loginId == null) return;
      body = { id, name: name.trim(), loginId: loginId.trim() };
    } else if (!confirm(`${st.name} 학생을 지울까요?\n이 학생의 아이디·출제한 시험·응시 결과가 모두 지워집니다. 되돌릴 수 없습니다.`)) {
      return;
    }
    b.disabled = true;
    $("ltStudentError").textContent = "";
    try {
      if (body) await postJson("/api/leveltest/students/update", body, "고치지 못했습니다.");
      else await postJson("/api/leveltest/students/delete", { id }, "지우지 못했습니다.");
      await ltRefresh();
    } catch (err) {
      $("ltStudentError").textContent = err.message;
      b.disabled = false;
    }
  });
  $("ltStudentPicker").addEventListener("change", (e) => {
    if (e.target.dataset.all) {
      $("ltStudentPicker").querySelectorAll("input[value]").forEach((x) => { x.checked = e.target.checked; });
    }
  });

  function renderSetPicker() {
    const box = $("ltSetPicker");
    const keep = (box.querySelector("input:checked") || {}).value;
    box.innerHTML = ltSets.length
      ? ltSets.map((s) => `<label class="lt-set"><input type="radio" name="ltSet" value="${esc(s.id)}"${keep === s.id ? " checked" : ""}>
          <b>${esc(s.gradeLabel)}</b> <span class="hint">${s.questionCount}문항${s.timeLimitSec ? ` · ${Math.round(s.timeLimitSec / 60)}분` : ""}${s.hasListening ? " · 듣기" : ""}</span></label>`).join("")
      : `<p class="hint">등록된 시험지가 없습니다. 관리자에게 문의하세요.</p>`;
  }

  function renderLinks() {
    const box = $("ltLinkList");
    if (!ltLinks.length) {
      box.innerHTML = `<p class="hint">아직 출제한 시험이 없습니다.</p>`;
      return;
    }
    // 상태 — 제출하면 서버가 출제를 닫고 doneAt을 적는다(lt_submit)
    const state = (k) => k.doneAt ? '<span class="lt-done">제출함</span>'
      : !k.active ? '<span class="hint">닫음</span>'
      : k.uses ? '<span class="lt-wait">응시 중</span>' : "응시 전";
    const toggle = (k) => k.active ? "닫기" : k.doneAt ? "다시 보게 하기" : "다시 열기";
    box.innerHTML = `<table class="lt-table"><thead><tr><th>학생</th><th>아이디</th><th>시험지</th><th>출제일</th><th>상태</th><th></th></tr></thead><tbody>${
      ltLinks.map((k) => `<tr data-code="${esc(k.code)}"${k.active ? "" : ' class="lt-off"'}>
        <td><b>${esc(k.studentName) || '<span class="hint">—</span>'}</b></td>
        <td>${esc(k.loginId)}</td>
        <td>${k.sets.map(esc).join("<br>")}</td>
        <td>${esc(fmtWhen(k.createdAt))}</td>
        <td>${state(k)}</td>
        <td><button type="button" class="btn ghost small" data-act="toggle">${toggle(k)}</button>
          <button type="button" class="btn ghost small danger" data-act="del">삭제</button></td>
      </tr>`).join("")}</tbody></table>`;
  }

  $("ltMakeLinkBtn").addEventListener("click", async () => {
    // 학생 칸을 채웠으면 그 학생을 먼저 등록하고 바로 낸다(2026-10-21 사용자: 등록과 출제를 한 단계로).
    // 이미 등록한 학생은 '이미 등록한 학생에게 내기'에서 체크해 함께 낼 수 있다.
    const picked = $("ltSetPicker").querySelector("input:checked");
    const ids = [...$("ltStudentPicker").querySelectorAll("input[value]:checked")].map((x) => x.value);
    const newName = $("ltNewName").value.trim();
    const newId = ($("ltNewId").value.trim() || newName).replace(/\s+/g, "").toLowerCase();
    const wantsNew = !!(newName || newId);
    $("ltNotice").textContent = "";
    $("ltError").textContent = "";
    if (wantsNew && !newName) { $("ltError").textContent = "학생 이름을 적어 주세요."; $("ltNewName").focus(); return; }
    if (wantsNew && !newId) { $("ltError").textContent = "학생이 로그인할 아이디를 정해 주세요."; $("ltNewId").focus(); return; }
    if (!wantsNew && !ids.length) { $("ltError").textContent = "학생 이름·아이디를 적거나, 이미 등록한 학생을 체크해 주세요."; $("ltNewName").focus(); return; }
    if (!picked) { $("ltError").textContent = "시험지를 골라 주세요."; return; }
    const label = (ltSets.find((s) => s.id === picked.value) || {}).gradeLabel || "";
    const btn = $("ltMakeLinkBtn");
    btn.disabled = true;
    try {
      let created = "";
      if (wantsNew) {
        // 학생은 아이디만으로 로그인한다(server.py lt_login)
        const c = await postJson("/api/leveltest/students", { name: newName, loginId: newId }, "학생을 등록하지 못했습니다.");
        ids.push(c.id);
        created = ` ${newName} 학생 — 아이디 ${newId.toLowerCase()}.`;
        ["ltNewName", "ltNewId"].forEach((id) => { $(id).value = ""; });
        ltIdTouched = false;
      }
      const r = await postJson("/api/leveltest/links", { setId: picked.value, studentIds: ids }, "시험을 내지 못했습니다.");
      await ltRefresh();
      $("ltNotice").textContent = `${r.made}명에게 '${label}' 레벨테스트를 냈습니다.${created} 학생은 ${testUrl} 에 로그인하면 목록에서 봅니다.`;
    } catch (e) {
      $("ltError").textContent = e.message;
    } finally {
      btn.disabled = false;
    }
  });

  $("ltLinkList").addEventListener("click", async (e) => {
    const b = e.target.closest("button[data-act]");
    if (!b) return;
    const code = b.closest("tr").dataset.code;
    const link = ltLinks.find((k) => k.code === code);
    if (!link) return;
    const act = b.dataset.act;
    if (act === "del" && !confirm(`${link.studentName} 학생에게 낸 시험을 지울까요?\n이 시험의 응시 결과도 함께 지워지고, 이 학생에게 남은 시험이 없으면 아이디(${link.loginId})도 지워집니다. 되돌릴 수 없습니다.`)) return;
    b.disabled = true;
    try {
      if (act === "toggle") await postJson("/api/leveltest/links/update", { code, active: !link.active }, "바꾸지 못했습니다.");
      else await postJson("/api/leveltest/links/delete", { code }, "지우지 못했습니다.");
      await ltRefresh();
    } catch (err) {
      $("ltError").textContent = err.message;
      b.disabled = false;
    }
  });

  /* ── ② 응시 결과 ── */
  function renderResults() {
    const q = $("ltSearch").value.trim();
    const rows = ltResults.filter((r) => !q || r.name.includes(q));
    const box = $("ltResultList");
    if (!rows.length) {
      box.innerHTML = `<p class="hint">${ltResults.length ? "이름이 맞는 결과가 없습니다." : "아직 응시한 학생이 없습니다."}</p>`;
      return;
    }
    const band = (label) => (window.LTR.BANDS.find((b) => b.label === label) || {}).color || "#7A2FA6";
    box.innerHTML = `<table class="lt-table"><thead><tr><th>응시일</th><th>이름</th><th>시험지</th><th>점수</th><th>레벨</th><th>상태</th><th></th></tr></thead><tbody>${
      rows.map((r) => {
        const done = r.status === "done";
        const state = !done ? '<span class="hint">응시 중 · 미제출</span>'
          : r.pending ? `<span class="lt-wait">확인 대기 ${r.pending}</span>` : "제출";
        return `<tr data-id="${esc(r.id)}">
          <td>${esc(fmtWhen(done ? r.submittedAt : r.startedAt))}${r.memo ? `<div class="hint">${esc(r.memo)}</div>` : ""}</td>
          <td><b>${esc(r.name)}</b></td>
          <td>${esc(r.setLabel)}</td>
          <td>${done ? `${esc(r.score)}점` : ""}</td>
          <td>${done ? `<span class="lt-pill" style="background:${band(r.level)}">${esc(r.level)}</span>` : ""}</td>
          <td>${state}</td>
          <td>${done ? '<button type="button" class="btn small" data-act="open">리포트</button>' : ""}
            <button type="button" class="btn ghost small danger" data-act="del">삭제</button></td>
        </tr>`;
      }).join("")}</tbody></table>`;
  }
  $("ltSearch").addEventListener("input", renderResults);
  $("ltRefreshBtn").addEventListener("click", ltRefresh);

  $("ltResultList").addEventListener("click", async (e) => {
    const b = e.target.closest("button[data-act]");
    if (!b) return;
    const id = b.closest("tr").dataset.id;
    const row = ltResults.find((r) => r.id === id);
    if (b.dataset.act === "open") { openResult(id); return; }
    if (!confirm(`${row ? row.name : ""} 학생의 응시 기록을 지울까요? 되돌릴 수 없습니다.`)) return;
    b.disabled = true;
    try {
      await postJson("/api/leveltest/results/delete", { id }, "지우지 못했습니다.");
      await ltRefresh();
    } catch (err) {
      $("ltError").textContent = err.message;
      b.disabled = false;
    }
  });

  /* ── 리포트 ── */
  async function openResult(id) {
    $("ltError").textContent = "";
    try {
      ltOpen = await getJson(`/api/leveltest/result?id=${encodeURIComponent(id)}`, "리포트를 불러오지 못했습니다.");
    } catch (e) {
      $("ltError").textContent = e.message;
      return;
    }
    $("ltListView").hidden = true;
    $("ltReportView").hidden = false;
    renderReport();
    window.scrollTo({ top: $("tab-leveltest").offsetTop - 10 });
  }

  function reportOpts(forPrint) {
    const extra = [];
    if (ltOpen.elapsedSec != null) extra.push(["걸린 시간", fmtDur(ltOpen.elapsedSec)]);
    return Object.assign(brandOf(), { items: true, gradeBtns: !forPrint, extraMeta: extra });
  }

  function renderReport() {
    $("ltReportBox").innerHTML = `<style>${window.LTR.EXTRA_CSS}</style>` + window.LTR.reportHtml(ltOpen.report, reportOpts(false));
  }

  $("ltReportBox").addEventListener("click", async (e) => {
    const b = e.target.closest(".ltr-gbtn");
    if (!b) return;
    b.disabled = true;
    try {
      const r = await postJson("/api/leveltest/grade", { id: ltOpen.id, i: Number(b.dataset.i), ok: b.dataset.ok === "1" }, "채점하지 못했습니다.");
      ltOpen.report = r.report;
      renderReport();
      const row = ltResults.find((x) => x.id === ltOpen.id);
      if (row) { row.score = r.report.score; row.level = r.report.band.label; row.pending = r.report.pending; }
    } catch (err) {
      $("ltError").textContent = err.message;
      b.disabled = false;
    }
  });

  $("ltBackBtn").addEventListener("click", () => {
    ltOpen = null;
    $("ltReportView").hidden = true;
    $("ltListView").hidden = false;
    renderResults();
  });

  $("ltPrintBtn").addEventListener("click", () => {
    if (!ltOpen) return;
    const rep = ltOpen.report;
    openPrintWindow(`레벨테스트 리포트 · ${rep.studentName || ""}`,
      `<style>${window.LTR.EXTRA_CSS}</style>` + window.LTR.reportHtml(rep, reportOpts(true)));
  });

  // 탭을 처음 열 때(그리고 다시 열 때마다) 목록을 받아 온다 — 학생이 막 제출했을 수 있다
  // 탭을 누르면 언제나 목록으로 — 리포트를 보던 중이면 [← 목록으로]를 누른 것과 같다(2026-10-21 사용자).
  // 목록은 다시 받아 온다(학생이 막 제출했을 수 있다)
  tabBtn.addEventListener("click", () => {
    if (!$("ltReportView").hidden) {
      ltOpen = null;
      $("ltReportView").hidden = true;
      $("ltListView").hidden = false;
      window.scrollTo({ top: 0 });
    }
    ltRefresh();
  });
  window.ltReset = () => {   // 로그아웃 — 다음 사람이 이 화면을 보지 않게
    ltSets = []; ltLinks = []; ltResults = []; ltOpen = null; ltLoaded = false;
    $("ltReportView").hidden = true;
    $("ltListView").hidden = false;
    ltStudents = [];
    ["ltSetPicker", "ltStudentPicker", "ltStudentList", "ltLinkList", "ltResultList", "ltReportBox"].forEach((id) => { $(id).innerHTML = ""; });
  };
})();
