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

  const testUrl = `${location.origin}/test`;   // 짧은 주소(server.py가 /test.html로 받는다 — 2026-11-13 사용자: .html은 뺀다)
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
      ? `<table class="lt-table"><thead><tr><th>이름</th><th>반</th><th>아이디</th><th>등록일</th><th></th></tr></thead><tbody>${
        ltStudents.map((st) => `<tr data-id="${esc(st.id)}">
          <td><b>${esc(st.name)}</b></td><td>${esc(st.memo || "")}</td><td>${esc(st.loginId)}</td>
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
    const one = (s) => `<label class="lt-set"><input type="radio" name="ltSet" value="${esc(s.id)}"${keep === s.id ? " checked" : ""}>
          <b>${esc(s.gradeLabel)}</b> <span class="hint">${s.questionCount}문항${s.timeLimitSec ? ` · ${Math.round(s.timeLimitSec / 60)}분` : ""}${s.hasListening ? " · 듣기" : ""}</span></label>`;
    // 연도 묶음(서버 group) — 첫 묶음(올해 시험지)은 펼쳐 두고, 지난해 묶음은 접어 둔다(2026-11-13 사용자: 2026 시험지는 묶어서 보관)
    const groups = [];
    ltSets.forEach((s) => {
      const g = s.group || "";
      let row = groups.find((x) => x.name === g);
      if (!row) groups.push(row = { name: g, sets: [] });
      row.sets.push(s);
    });
    box.innerHTML = !ltSets.length
      ? `<p class="hint">등록된 시험지가 없습니다. 관리자에게 문의하세요.</p>`
      : groups.length < 2 && !groups[0].name
        ? `<div class="lt-sets">${ltSets.map(one).join("")}</div>`
        : groups.map((g, k) => {
          const open = k === 0 || g.sets.some((s) => s.id === keep);
          return `<details class="lt-set-group"${open ? " open" : ""}><summary>${esc(g.name || "기타 시험지")} <span class="hint">${g.sets.length}종</span></summary>
            <div class="lt-sets">${g.sets.map(one).join("")}</div></details>`;
        }).join("");
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

  /* ── 명단으로 한꺼번에 등록·출제 (2026-11-13 사용자: 원생 전체) ──
     이름·반·아이디 세 칸을 엑셀(.xlsx·.csv)로 올리거나 붙여 넣으면 반별로 묶어 보여 주고, 반마다 시험지를 한 번 고른다.
     서버 /api/leveltest/sheet(파일 → 표)·/api/leveltest/bulk(학생 25명씩 등록 + 출제). 반 이름은 학생 메모에 남는다. */
  const BULK_KEY = "lt_bulk_group_set";
  let bulk = [];   // { name, group, loginId, on, dupe }
  const bulkSetOf = {};   // 반 → 시험지 id
  try { Object.assign(bulkSetOf, JSON.parse(localStorage.getItem(BULK_KEY) || "{}")); } catch (_) { /* 저장 못 해도 된다 */ }
  const OFF_GROUP = /휴원|퇴원|휴학/;

  // 직접 입력 표(이름·반·아이디 칸) — 엑셀에서 복사해 아무 칸에 붙여 넣으면 칸마다 나뉘어 채워지고(2026-11-13 사용자: 직접 입력해도 안 헷갈리게),
  // 마지막 줄에 쓰면 줄이 늘어난다. 파일을 놓은 뒤 표를 건드리면 파일 선택은 풀어 표를 읽는다.
  const grid = $("ltBulkGrid").tBodies[0];
  const GRID_PH = ["김민수", "AL3", ""];
  function gridAdd(n) {
    for (let i = 0; i < n; i++) {
      const tr = document.createElement("tr");
      const ph = grid.rows.length === 0;   // 회색 예시는 첫 줄에만 — 빈 줄마다 있으면 입력한 것처럼 보여 헷갈린다
      tr.innerHTML = `<td class="n">${grid.rows.length + 1}</td>` + [0, 1, 2].map((c) =>
        `<td><input data-c="${c}" autocomplete="off" spellcheck="false"${ph && GRID_PH[c] ? ` placeholder="${GRID_PH[c]}"` : ""}></td>`).join("");
      grid.appendChild(tr);
    }
  }
  function gridRows() {
    return [...grid.rows].map((tr) => [...tr.querySelectorAll("input")].map((i) => i.value.trim())).filter((r) => r[0]);
  }
  function gridDetachFile() {
    if ($("ltBulkFile").files.length) {
      $("ltBulkFile").value = "";
      $("ltBulkDrop").classList.remove("has");
      $("ltBulkFileName").textContent = "또는 이 칸을 눌러 파일 고르기 (.xlsx · .csv)";
    }
  }
  gridAdd(8);
  grid.addEventListener("input", (e) => {
    gridDetachFile();
    const tr = e.target.closest("tr");
    if (tr && tr === grid.rows[grid.rows.length - 1]) gridAdd(5);
  });
  grid.addEventListener("keydown", (e) => {
    if (e.key !== "Enter" || !e.target.matches("input")) return;
    e.preventDefault();
    const tr = e.target.closest("tr").nextElementSibling;
    if (tr) tr.querySelectorAll("input")[Number(e.target.dataset.c)].focus();
  });
  grid.addEventListener("paste", (e) => {
    const inp = e.target.closest("input");
    if (!inp) return;
    const text = (e.clipboardData || window.clipboardData).getData("text");
    if (!/[\t\n]/.test(text)) return;   // 한 칸짜리 붙여넣기는 그대로 둔다
    e.preventDefault();
    gridDetachFile();
    const lines = text.replace(/\r/g, "").split("\n");
    while (lines.length && !lines[lines.length - 1].trim()) lines.pop();
    const delim = text.includes("\t") ? "\t" : ",";
    const r0 = inp.closest("tr").rowIndex - 1;
    const c0 = Number(inp.dataset.c);
    lines.forEach((line, k) => {
      while (grid.rows.length <= r0 + k) gridAdd(1);
      const inputs = grid.rows[r0 + k].querySelectorAll("input");
      line.split(delim).forEach((v, j) => { if (c0 + j <= 2) inputs[c0 + j].value = v.trim(); });
    });
    while (grid.rows.length < r0 + lines.length + 3) gridAdd(1);   // 아래에 빈 줄을 남긴다
  });
  $("ltBulkAddRowsBtn").addEventListener("click", () => gridAdd(5));
  $("ltBulkClearBtn").addEventListener("click", () => {
    if (gridRows().length && !confirm("표에 적은 내용을 모두 지울까요?")) return;
    grid.innerHTML = "";
    gridAdd(8);
    gridDetachFile();
  });

  function bulkParse(rows) {
    const cols = { name: 0, group: 1, id: 2 };
    // 제목 줄 찾기 — 맨 위에 '원생 명단 (날짜)' 같은 제목이나 빈 줄이 있어도 위 10줄 안에서 찾는다
    const NAME_RE = /^(이름|성명|원생명?|학생명?|name)$/;
    let head = -1;
    for (let k = 0; k < Math.min(rows.length, 10) && head < 0; k++) {
      if (rows[k].some((c) => NAME_RE.test(String(c).replace(/\s/g, "").toLowerCase()))) head = k;
    }
    if (head >= 0) {
      const first = rows[head].map((c) => String(c).replace(/\s/g, "").toLowerCase());
      const find = (re) => first.findIndex((c) => re.test(c));
      cols.name = find(NAME_RE);
      cols.group = find(/^(반|반명|클래스|class|소속)$/);
      cols.id = find(/^(아이디|id|로그인|로그인id|학생코드|코드)$/);
      rows = rows.slice(head + 1);
    }
    const out = [];
    rows.forEach((r) => {
      const name = String(r[cols.name] || "").trim();
      if (!name) return;
      const group = cols.group >= 0 ? String(r[cols.group] || "").trim() : "";
      const loginId = cols.id >= 0 ? String(r[cols.id] || "").trim() : "";
      out.push({ name, group, loginId, on: !OFF_GROUP.test(group), dupe: false });
    });
    const seen = new Map();
    out.forEach((r) => {
      if (!r.loginId) return;
      const k = r.loginId.replace(/\s+/g, "").toLowerCase();
      if (seen.has(k)) { r.dupe = true; seen.get(k).dupe = true; } else seen.set(k, r);
    });
    return out;
  }

  const groupLabel = (g) => g || "(반 없음)";
  function setOptions(sel) {
    const groups = [];
    ltSets.forEach((s) => {
      let row = groups.find((x) => x.name === (s.group || ""));
      if (!row) groups.push(row = { name: s.group || "", sets: [] });
      row.sets.push(s);
    });
    return `<option value="">시험지 고르기</option>` + groups.map((g) =>
      `<optgroup label="${esc(g.name || "기타")}">${g.sets.map((s) => `<option value="${esc(s.id)}"${sel === s.id ? " selected" : ""}>${esc(s.gradeLabel)}</option>`).join("")}</optgroup>`).join("");
  }

  function bulkRender(summaryHtml) {
    const box = $("ltBulkPreview");
    if (!bulk.length) { box.innerHTML = summaryHtml || ""; return; }
    const groups = [];
    bulk.forEach((r, k) => {
      let g = groups.find((x) => x.name === r.group);
      if (!g) groups.push(g = { name: r.group, rows: [] });
      g.rows.push(k);
    });
    box.innerHTML = `${summaryHtml || ""}
      <p class="hint"><b>${bulk.length}명</b>을 읽었습니다 (${groups.length}개 반). 반마다 시험지를 고르세요. 체크를 끈 학생은 등록하지 않습니다${bulk.some((r) => OFF_GROUP.test(r.group)) ? " (휴원·퇴원 반은 처음부터 꺼져 있습니다)" : ""}.</p>
      ${groups.map((g) => `<div class="lt-bulk-group" data-group="${esc(g.name)}">
        <div class="lt-bulk-head">
          <label class="lt-set"><input type="checkbox" data-gall="1"${g.rows.every((k) => bulk[k].on) ? " checked" : ""}> <b>${esc(groupLabel(g.name))}</b> <span class="hint">${g.rows.length}명</span></label>
          <select data-gset="1">${setOptions(bulkSetOf[g.name])}</select>
        </div>
        <details><summary class="hint" style="cursor:pointer;">명단 보기</summary>
          <table class="lt-table"><tbody>${g.rows.map((k) => `<tr data-k="${k}"${bulk[k].dupe ? ' class="lt-off"' : ""}>
            <td style="width:34px;"><input type="checkbox" data-row="1"${bulk[k].on ? " checked" : ""}></td>
            <td><b>${esc(bulk[k].name)}</b></td><td>${esc(bulk[k].loginId || "(이름이 아이디)")}${bulk[k].dupe ? ' <span style="color:#c0392b;">아이디 겹침</span>' : ""}</td></tr>`).join("")}</tbody></table>
        </details></div>`).join("")}
      <div style="margin-top:10px;"><button type="button" class="btn" id="ltBulkGoBtn"></button> <span class="hint" id="ltBulkProgress"></span></div>`;
    bulkSyncBtn();
  }

  function bulkSyncBtn() {
    const b = $("ltBulkGoBtn");
    if (b) b.textContent = `일괄 등록·출제 (${bulk.filter((r) => r.on).length}명)`;
  }

  async function bulkReadFile(file) {
    const buf = new Uint8Array(await file.arrayBuffer());
    let bin = "";
    for (let i = 0; i < buf.length; i += 0x8000) bin += String.fromCharCode.apply(null, buf.subarray(i, i + 0x8000));
    const r = await postJson("/api/leveltest/sheet", { name: file.name, data: btoa(bin) }, "파일을 읽지 못했습니다.");
    return r.rows || [];
  }

  $("ltBulkReadBtn").addEventListener("click", async () => {
    $("ltBulkError").textContent = "";
    const file = $("ltBulkFile").files[0];
    const btn = $("ltBulkReadBtn");
    btn.disabled = true;
    try {
      let rows;
      if (file) rows = await bulkReadFile(file);
      else {
        rows = gridRows();
        if (!rows.length) throw new Error("표에 이름을 입력하거나, 엑셀 파일을 끌어다 놓아 주세요.");
      }
      bulk = bulkParse(rows);
      if (!bulk.length) throw new Error("이름이 있는 줄을 찾지 못했습니다. 첫 줄에 '이름 · 반 · 아이디' 제목을 넣거나, 이름·반·아이디 순서로 적어 주세요.");
      bulkRender("");
      if (file) $("ltBulkFileName").textContent = `✔ ${file.name} — ${bulk.length}명을 읽었습니다 (다른 파일을 놓으면 바꿔 읽습니다)`;
    } catch (e) {
      $("ltBulkError").textContent = e.message;
      if (file) $("ltBulkFileName").textContent = `✖ ${file.name} — 읽지 못했습니다`;
    } finally {
      btn.disabled = false;
    }
  });

  // 파일 끌어다 놓기 — 놓거나 고르면 바로 명단을 읽는다(2026-11-13 사용자). 상자 밖에 놓아도 브라우저가 파일을 열지 않게 패널 전체가 받는다.
  function bulkPick(file) {
    if (!file) return;
    if (!/\.(xlsx|csv|txt|xls)$/i.test(file.name)) { $("ltBulkError").textContent = "엑셀(.xlsx)이나 CSV 파일만 올릴 수 있습니다."; return; }
    const dt = new DataTransfer();
    dt.items.add(file);
    $("ltBulkFile").files = dt.files;
    $("ltBulkFileName").textContent = `✔ ${file.name} — 읽는 중…`;
    $("ltBulkDrop").classList.add("has");
    $("ltBulkReadBtn").click();
  }
  const bulkPanel = document.querySelector(".lt-bulk-panel");
  ["dragenter", "dragover"].forEach((ev) => bulkPanel.addEventListener(ev, (e) => {
    if (![...(e.dataTransfer?.types || [])].includes("Files")) return;
    e.preventDefault();
    $("ltBulkDrop").classList.add("over");
  }));
  bulkPanel.addEventListener("dragleave", (e) => {
    if (!bulkPanel.contains(e.relatedTarget)) $("ltBulkDrop").classList.remove("over");
  });
  bulkPanel.addEventListener("drop", (e) => {
    if (![...(e.dataTransfer?.types || [])].includes("Files")) return;
    e.preventDefault();
    $("ltBulkDrop").classList.remove("over");
    bulkPick(e.dataTransfer.files[0]);
  });
  $("ltBulkFile").addEventListener("change", () => bulkPick($("ltBulkFile").files[0]));

  $("ltBulkTemplateBtn").addEventListener("click", () => {
    const csv = "﻿이름,반,아이디\n김민수,AL3,3s001\n이서연,AM2,\n";
    const a = document.createElement("a");
    a.href = URL.createObjectURL(new Blob([csv], { type: "text/csv;charset=utf-8" }));
    a.download = "레벨테스트_명단_양식.csv";
    a.click();
    setTimeout(() => URL.revokeObjectURL(a.href), 2000);
  });

  $("ltBulkPreview").addEventListener("change", (e) => {
    const grp = e.target.closest(".lt-bulk-group");
    if (!grp) return;
    const name = grp.dataset.group;
    if (e.target.dataset.gset) {
      bulkSetOf[name] = e.target.value;
      try { localStorage.setItem(BULK_KEY, JSON.stringify(bulkSetOf)); } catch (_) { /* 저장 못 해도 된다 */ }
    } else if (e.target.dataset.gall) {
      bulk.forEach((r) => { if (r.group === name) r.on = e.target.checked; });
      grp.querySelectorAll("input[data-row]").forEach((x) => { x.checked = e.target.checked; });
    } else if (e.target.dataset.row) {
      bulk[Number(e.target.closest("tr").dataset.k)].on = e.target.checked;
      grp.querySelector("input[data-gall]").checked = bulk.filter((r) => r.group === name).every((r) => r.on);
    }
    bulkSyncBtn();
  });

  $("ltBulkPreview").addEventListener("click", async (e) => {
    if (e.target.id !== "ltBulkGoBtn") return;
    $("ltBulkError").textContent = "";
    const mine = bulk.map((r, k) => ({ r, k })).filter((x) => x.r.on);
    if (!mine.length) { $("ltBulkError").textContent = "등록할 학생이 없습니다."; return; }
    const noSet = [...new Set(mine.filter((x) => !bulkSetOf[x.r.group] || !ltSets.some((s) => s.id === bulkSetOf[x.r.group])).map((x) => groupLabel(x.r.group)))];
    if (noSet.length) { $("ltBulkError").textContent = `시험지를 고르지 않은 반이 있습니다: ${noSet.join(", ")}`; return; }
    const dupes = mine.filter((x) => x.r.dupe).length;
    if (dupes && !confirm(`아이디가 겹치는 학생이 ${dupes}명 있습니다. 겹치는 줄은 먼저 나온 한 명만 등록되고 나머지는 실패로 남습니다. 계속할까요?`)) return;
    if (!confirm(`${mine.length}명을 등록하고 시험을 냅니다. 계속할까요?`)) return;
    const btn = $("ltBulkGoBtn");
    btn.disabled = true;
    const done = [];      // 성공 { name, group, loginId, setLabel }
    const failed = [];    // 실패 { k, error }
    const CHUNK = 25;
    try {
      for (let at = 0; at < mine.length; at += CHUNK) {
        const part = mine.slice(at, at + CHUNK);
        $("ltBulkProgress").textContent = `${Math.min(at + CHUNK, mine.length)} / ${mine.length}명 처리 중…`;
        const res = await postJson("/api/leveltest/bulk", {
          rows: part.map((x) => ({ name: x.r.name, group: x.r.group, loginId: x.r.loginId, fixedId: !!x.r.loginId, setId: bulkSetOf[x.r.group] })),
        }, "등록하지 못했습니다.");
        (res.results || []).forEach((o) => {
          const x = part[o.i];
          if (o.ok) done.push({ name: o.name, group: x.r.group, loginId: o.loginId, setLabel: o.setLabel, k: x.k });
          else failed.push({ k: x.k, error: o.error });
        });
      }
    } catch (err) {
      $("ltBulkError").textContent = `${err.message} (여기까지 ${done.length}명은 등록됐습니다 — 아래 명단에서 남은 학생만 다시 시도하세요)`;
      mine.forEach((x) => { if (!done.some((d) => d.k === x.k) && !failed.some((f) => f.k === x.k)) failed.push({ k: x.k, error: "처리하지 못했습니다." }); });
    }
    // 성공한 줄은 명단에서 빼고, 실패한 줄만 남겨 다시 시도할 수 있게 한다
    const okKeys = new Set(done.map((d) => d.k));
    const failLines = failed.slice(0, 40).map((f) => `<li>${esc(bulk[f.k].name)}: ${esc(String(f.error))}</li>`).join("");
    bulk = bulk.filter((_, k) => !okKeys.has(k));
    bulkLastDone = done;
    bulkRender(`<div class="hint" style="color:var(--accent, #2f6fdb); font-weight:700; margin-bottom:8px;">${done.length}명을 등록하고 시험을 냈습니다.${failed.length ? ` <span style="color:#c0392b;">${failed.length}명은 실패했습니다 — 아래 명단에 남겨 두었습니다.</span>` : ""}
      ${done.length ? ` <button type="button" class="btn ghost small" id="ltBulkCsvBtn">결과(이름·반·아이디) 내려받기</button>` : ""}</div>
      ${failLines ? `<ul class="hint" style="color:#c0392b;">${failLines}</ul>` : ""}`);
    await ltRefresh();
  });

  let bulkLastDone = [];
  $("ltBulkPreview").addEventListener("click", (e) => {
    if (e.target.id !== "ltBulkCsvBtn") return;
    const q = (s) => `"${String(s ?? "").replace(/"/g, '""')}"`;
    const csv = "﻿" + ["이름,반,아이디,시험지", ...bulkLastDone.map((d) => [d.name, d.group, d.loginId, d.setLabel].map(q).join(","))].join("\n");
    const a = document.createElement("a");
    a.href = URL.createObjectURL(new Blob([csv], { type: "text/csv;charset=utf-8" }));
    a.download = "레벨테스트_등록결과.csv";
    a.click();
    setTimeout(() => URL.revokeObjectURL(a.href), 2000);
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
