/* 레벨테스트 응시 화면(lt.html) — 레벨테스트 사이트(test.html)에 아이디·비밀번호로 로그인한 학생이
   목록의 [응시하기]로 들어온다(/lt/<출제 코드>, 2026-10-21 사용자: 학생 관리처럼 한 사이트에서 로그인).
   이름은 서버가 학생 정보에서 쓰고, 시험지는 선생님이 정한 것 하나다. 정답은 서버에만 있고, 제출하면 서버가 채점한다(server.py lt_*).
   답은 고를 때마다 sessionStorage에 적어 두어, 새로고침하거나 창이 꺼져도 같은 탭에서 이어 푼다.
   문항 그리기는 학원이 쓰던 원래 레벨테스트 사이트를 옮긴 것이다. */
"use strict";
(function () {
  const $ = (id) => document.getElementById(id);
  const esc = (s) => String(s == null ? "" : s)
    .replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");

  // 주소에서 코드를 읽는다 — /lt/<코드> 또는 /lt.html?k=<코드>
  const CODE = (location.pathname.match(/^\/lt\/([a-z0-9]+)/i) || [])[1]
    || new URLSearchParams(location.search).get("k") || "";
  const KEY = "lt:" + CODE.toLowerCase();

  function store(k, v) {
    try {
      if (v === undefined) sessionStorage.removeItem(k);
      else sessionStorage.setItem(k, JSON.stringify(v));
    } catch (_) { /* 사생활 보호 창 등 — 이어 풀기만 안 된다 */ }
  }
  function load(k) {
    try { return JSON.parse(sessionStorage.getItem(k) || "null"); } catch (_) { return null; }
  }

  async function call(url, payload) {
    const res = await fetch(url, payload ? {
      method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(payload),
    } : undefined);
    let data = null;
    try { data = await res.json(); } catch (_) {}
    if (!data) throw new Error(`서버에 연결하지 못했습니다 (HTTP ${res.status}). 잠시 뒤 다시 시도해 주세요.`);
    if (!res.ok) throw new Error(data.error || "요청에 실패했습니다.");
    return data;
  }

  const SCREENS = ["scrLoading", "scrStart", "scrTest", "scrConfirm", "scrReport"];
  function show(id) {
    SCREENS.forEach((s) => $(s).classList.toggle("hidden", s !== id));
    window.scrollTo(0, 0);
  }
  function fail(msg) {
    $("loadingMsg").textContent = msg;
    show("scrLoading");
  }

  let info = null;          // 링크 정보(학원 이름·로고·시험지 목록)
  let pickedSet = "";
  let att = null;           // { attemptId, token, startLocal } — 진행 중인 응시
  let test = null;          // 서버가 준 시험지(정답 없음)
  let answers = {};         // 문항 차례 → 답(글자 / 글자 목록 / 조각 번호 목록)
  let cur = 0;
  let timerId = null;
  let submitting = false;
  let audioUrl = "";

  function setBrand(academy, logo) {
    const ok = /^data:image\/(png|jpeg|webp);base64,/.test(logo || "");
    // 머리띠는 학생 사이트와 같은 남색 띠(.app-head) — 로고는 싣지 않고 학원 이름만 쓴다
    void ok;
    $("brand").textContent = academy ? `${academy} · 레벨테스트` : "레벨테스트";
  }
  const media = (name) => `/api/lt/media?k=${encodeURIComponent(CODE)}&name=${encodeURIComponent(name)}`;

  /* ── 시작 화면 ── */
  function renderStart() {
    const sets = info.sets || [];
    const grid = $("setGrid");
    grid.innerHTML = "";
    sets.forEach((s) => {
      const b = document.createElement("button");
      b.type = "button";
      b.className = "grade" + (s.id === pickedSet ? " sel" : "");
      const bits = [`${s.questionCount}문항`];
      if (s.timeLimitSec) bits.push(`${Math.round(s.timeLimitSec / 60)}분`);
      if (s.hasListening) bits.push("듣기 포함");
      b.innerHTML = `<b>${esc(s.gradeLabel)}</b><span>${esc(bits.join(" · "))}</span>`;
      b.addEventListener("click", () => { pickedSet = s.id; renderStart(); });
      grid.appendChild(b);
    });
    if (sets.length === 1) pickedSet = sets[0].id;
    // 선생님이 학생 이름을 정해 낸 시험 — 이름을 적지 않는다(서버도 그 이름으로 본다)
    if (info.student) {
      $("nameInput").value = info.student;
      $("nameInput").classList.add("hidden");
      $("nameFixed").textContent = `${info.student} 학생`;
      $("nameFixed").classList.remove("hidden");
      document.querySelector('label[for="nameInput"]').textContent = "응시하는 학생";
    }
    $("setWrap").classList.toggle("hidden", sets.length === 1);
    const one = sets.length === 1 ? sets[0] : null;
    $("startSub").textContent = one
      ? `${info.student ? "본인 이름이 맞으면" : "이름을 입력하고"} 시작하세요. 시험지: ${one.gradeLabel}${one.hasListening ? " — 듣기가 있으니 소리를 켜 주세요 🔊" : ""}`
      : "이름을 입력하고 시험지를 고른 뒤 시작하세요. 듣기가 있는 시험지는 소리를 켜 주세요 🔊";
    syncStart();
  }
  function syncStart() {
    $("startBtn").disabled = !($("nameInput").value.trim() && pickedSet);
  }
  $("nameInput").addEventListener("input", syncStart);
  $("startBtn").addEventListener("click", async () => {
    $("startErr").textContent = "";
    $("startBtn").disabled = true;
    try {
      const r = await call("/api/lt/begin", { k: CODE, setId: pickedSet });
      // 다른 기기에서 보던 응시를 이어 받으면(resumed) 시작 시각은 서버 값을 쓴다
      const startLocal = r.resumed && r.startedAt ? Date.parse(r.startedAt) || Date.now() : Date.now();
      const sameAttempt = att && att.attemptId === r.attemptId;
      att = { attemptId: r.attemptId, token: r.token, startLocal };
      store(KEY, att);
      answers = sameAttempt || r.resumed ? (load(KEY + ":a:" + r.attemptId) || {}) : {};
      startTest(r);
    } catch (e) {
      $("startErr").textContent = e.message;
      syncStart();
    }
  });

  /* ── 시험 ── */
  function startTest(r) {
    test = r.test;
    $("crumbs").textContent = `${r.name || ""} · ${test.gradeLabel}`;
    cur = Math.min(Number(load(KEY + ":cur")) || 0, test.items.length - 1);
    show("scrTest");
    setupAudio();
    renderItem();
    startTimer();
  }

  function setupAudio() {
    $("audioDock").classList.add("hidden");
    if (!test.hasListening || !test.audioKey) return;
    if (audioUrl) return;
    const msg = $("audioMsg");
    msg.textContent = "음성을 불러오는 중…";
    // 통째로 받아 둔다(아이폰 사파리는 끊어 받기를 못 하는 주소의 음성을 재생하지 않는다)
    fetch(media(test.audioKey)).then((res) => {
      if (!res.ok) throw new Error();
      return res.blob();
    }).then((blob) => {
      audioUrl = URL.createObjectURL(blob);
      $("audio").src = audioUrl;
      msg.textContent = "";
    }).catch(() => {
      msg.textContent = "⚠️ 음성을 불러오지 못했습니다. 새로고침하거나 선생님께 알려 주세요.";
    });
  }

  function startTimer() {
    clearInterval(timerId);
    const el = $("timer");
    if (!test.timeLimitSec) { el.classList.add("hidden"); return; }
    el.classList.remove("hidden");
    const end = (att.startLocal || Date.now()) + test.timeLimitSec * 1000;
    const tick = () => {
      const left = Math.max(0, end - Date.now());
      const m = Math.floor(left / 60000), s = Math.floor((left % 60000) / 1000);
      $("timerText").textContent = `${String(m).padStart(2, "0")}:${String(s).padStart(2, "0")}`;
      el.classList.toggle("warn", left <= 5 * 60000 && left > 60000);
      el.classList.toggle("danger", left <= 60000);
      if (left <= 0) {
        clearInterval(timerId);
        alert("시험 시간이 끝났습니다. 지금까지 쓴 답으로 제출합니다.");
        submit();
      }
    };
    tick();
    timerId = setInterval(tick, 1000);
  }

  function saveAnswers() {
    store(KEY + ":a:" + att.attemptId, answers);
    store(KEY + ":cur", cur);
  }
  function setAnswer(i, v) {
    answers[i] = v;
    saveAnswers();
  }

  function renderProgress(item) {
    const total = test.items.length;
    $("progFill").style.width = (cur / total * 100).toFixed(1) + "%";
    $("progLabel").textContent = `${cur + 1} / ${total} 문항`;
    $("secLabel").textContent = item.secTitle + (item.part ? " · " + item.part : "");
    const tabs = $("tabs");
    tabs.innerHTML = "";
    test.sections.forEach((sec) => {
      const b = document.createElement("button");
      b.type = "button";
      b.className = "tab" + (sec.id === item.sec ? " on" : "");
      b.textContent = sec.title;
      b.addEventListener("click", () => {
        const idx = test.items.findIndex((it) => it.sec === sec.id);
        if (idx >= 0 && idx !== cur) { cur = idx; renderItem(); window.scrollTo(0, 0); }
      });
      tabs.appendChild(b);
    });
    // 듣기 음성은 듣기 영역에서만 보인다(다른 영역으로 가면 멈춘다)
    const onListen = test.hasListening && item.sec === "listening";
    $("audioDock").classList.toggle("hidden", !onListen);
    if (!onListen) { try { $("audio").pause(); } catch (_) {} }
  }

  function el(tag, cls, html) {
    const e = document.createElement(tag);
    if (cls) e.className = cls;
    if (html != null) e.innerHTML = html;
    return e;
  }

  function renderItem() {
    const item = test.items[cur];
    renderProgress(item);
    saveAnswers();
    const box = $("qbox");
    box.innerHTML = "";
    const i = item.i;
    box.appendChild(el("div", "lt-eyebrow", esc(`${item.secTitle} ${item.part || ""}`.trim())));
    const sec = test.sections.find((s) => s.id === item.sec);
    // 문항 글·안내·지문은 서버가 밑줄·표만 남기고 거른 HTML이다(server.py _lt_html)
    if (sec && sec.instruction && cur === test.items.findIndex((it) => it.sec === item.sec)) {
      box.appendChild(el("div", "lt-note", esc(sec.instruction)));
    }
    if (item.note) box.appendChild(el("div", "lt-note", item.note));
    if (item.passage) box.appendChild(el("div", "passage", item.passage));
    // 단어 은행 — 빈칸 문항이면 단어를 눌러 답을 채운다(2026-10-21 사용자: 손으로 치다 철자가 틀려 오답이 되지 않게).
    // 같은 단어를 다시 누르면 비운다. 칸에 직접 쳐도 된다.
    const pickable = item.type === "fill" && item.wordbank && item.wordbank.length;
    if (item.wordbank && item.wordbank.length) {
      const wb = el("div", "wordbank" + (pickable ? " pick" : ""));
      item.wordbank.forEach((w) => {
        if (!pickable) { wb.appendChild(el("span", "", esc(w))); return; }
        const on = String(answers[i] || "").trim().toLowerCase() === String(w).trim().toLowerCase();
        const b = el("button", "wb-word" + (on ? " sel" : ""), esc(w));
        b.type = "button";
        b.addEventListener("click", () => { setAnswer(i, on ? "" : w); renderItem(); });
        wb.appendChild(b);
      });
      box.appendChild(wb);
    }
    if (item.image) {
      const img = el("img", "qimg");
      img.src = media(item.image);
      img.alt = "";
      box.appendChild(img);
    }
    const title = el("div", "qt", `${esc(item.n)}. ${item.q || ""}`);
    box.appendChild(title);

    if (item.type === "mc_multi") {
      box.appendChild(el("div", "hint", "✓ 정답이 2개 이상일 수 있어요. 해당하는 것을 모두 고르세요."));
      const sel = new Set(answers[i] || []);
      const wrap = el("div", "choices");
      Object.keys(item.choices || {}).forEach((L) => {
        const c = el("button", "choice" + (sel.has(L) ? " sel" : ""), `<span class="lt">${esc(L)}</span><span>${item.choices[L]}</span>`);
        c.type = "button";
        c.addEventListener("click", () => {
          if (sel.has(L)) sel.delete(L); else sel.add(L);
          setAnswer(i, [...sel].sort());
          renderItem();
        });
        wrap.appendChild(c);
      });
      box.appendChild(wrap);
    } else if (item.type === "mc") {
      const imgs = item.choiceImages;
      const wrap = el("div", "choices" + (imgs ? " imgs" : ""));
      Object.keys(imgs || item.choices || {}).forEach((L) => {
        const inner = imgs
          ? `<span class="lt">${esc(L)}</span><img src="${esc(media(imgs[L]))}" alt="">`
          : `<span class="lt">${esc(L)}</span><span>${item.choices[L]}</span>`;
        const c = el("button", "choice" + (answers[i] === L ? " sel" : ""), inner);
        c.type = "button";
        c.addEventListener("click", () => { setAnswer(i, L); renderItem(); });
        wrap.appendChild(c);
      });
      box.appendChild(wrap);
    } else if (item.type === "fill" && item.options && item.options.length) {
      // 답이 정해진 몇 개 중 하나(품사 쓰기, '(Don't / Doesn't)' 고르기) — 단추로 고른다. 답은 고른 글자 그대로
      const wrap = el("div", "choices opts");
      item.options.forEach((o) => {
        const on = String(answers[i] || "").trim().toLowerCase() === o.toLowerCase();
        const c = el("button", "choice" + (on ? " sel" : ""), esc(o));
        c.type = "button";
        c.addEventListener("click", () => { setAnswer(i, on ? "" : o); renderItem(); });
        wrap.appendChild(c);
      });
      box.appendChild(wrap);
    } else if (item.type === "fill") {
      const row = el("div", "fill");
      const inp = el("input");
      inp.type = "text";
      inp.placeholder = pickable ? "위 단어를 누르거나 직접 입력하세요" : "답을 입력하세요";
      inp.autocomplete = "off";
      inp.autocapitalize = "off";
      inp.spellcheck = false;
      inp.maxLength = 500;
      inp.value = answers[i] || "";
      inp.addEventListener("input", () => {
        setAnswer(i, inp.value);
        // 친 글자가 단어 은행의 단어와 같아지면 그 단어 단추도 켠다
        box.querySelectorAll(".wb-word").forEach((b) => b.classList.toggle("sel",
          b.textContent.trim().toLowerCase() === inp.value.trim().toLowerCase()));
      });
      inp.addEventListener("keydown", (e) => { if (e.key === "Enter") $("nextBtn").click(); });
      row.appendChild(inp);
      box.appendChild(row);
    } else if (item.type === "order") {
      if (!item.q) title.textContent = `${item.n}. 다음 뜻에 맞게 문장을 완성하세요.`;
      if (item.prompt) box.appendChild(el("div", "oprompt", esc(`"${item.prompt}"`)));
      const built = Array.isArray(answers[i]) ? answers[i].slice() : [];
      const b = el("div", "built");
      if (!built.length) b.appendChild(el("span", "", '<span style="color:var(--soft);font-size:.85rem;">아래 조각을 순서대로 누르세요</span>'));
      built.forEach((k, pos) => {
        const chip = el("button", "chip", esc(item.chunks[k]));
        chip.type = "button";
        chip.addEventListener("click", () => { built.splice(pos, 1); setAnswer(i, built); renderItem(); });
        b.appendChild(chip);
      });
      box.appendChild(b);
      const pool = el("div", "pool");
      item.chunks.forEach((c, k) => {
        const chip = el("button", "chip" + (built.includes(k) ? " used" : ""), esc(c));
        chip.type = "button";
        chip.addEventListener("click", () => {
          if (built.includes(k)) return;
          built.push(k);
          setAnswer(i, built);
          renderItem();
        });
        pool.appendChild(chip);
      });
      box.appendChild(pool);
    }
    $("prevBtn").style.visibility = cur === 0 ? "hidden" : "visible";
    $("nextBtn").textContent = cur === test.items.length - 1 ? "제출하기" : "다음";
  }

  $("prevBtn").addEventListener("click", () => { if (cur > 0) { cur--; renderItem(); window.scrollTo(0, 0); } });
  $("nextBtn").addEventListener("click", () => {
    if (cur < test.items.length - 1) { cur++; renderItem(); window.scrollTo(0, 0); return; }
    const empty = test.items.filter((it) => {
      const v = answers[it.i];
      return v == null || (Array.isArray(v) ? !v.length : !String(v).trim());
    }).length;
    $("confirmText").textContent = empty
      ? `아직 답하지 않은 문항이 ${empty}개 있어요. 그래도 제출할까요? 제출하면 다시 고칠 수 없어요.`
      : "모든 문항에 답했어요! 제출하면 다시 고칠 수 없어요.";
    $("submitErr").textContent = "";
    show("scrConfirm");
  });
  $("backBtn").addEventListener("click", () => { show("scrTest"); renderItem(); });
  $("submitBtn").addEventListener("click", submit);

  async function submit() {
    if (submitting) return;
    submitting = true;
    $("submitBtn").disabled = true;
    $("submitErr").textContent = "제출하는 중…";
    try {
      const r = await call("/api/lt/submit", { attemptId: att.attemptId, token: att.token, answers });
      clearInterval(timerId);
      try { $("audio").pause(); } catch (_) {}
      store(KEY + ":a:" + att.attemptId, undefined);
      store(KEY + ":cur", undefined);
      showReport(r.report);
    } catch (e) {
      // 시간이 끝나 저절로 낸 경우에도 확인 화면에서 다시 누를 수 있게 둔다(답은 그대로 남아 있다)
      show("scrConfirm");
      $("submitErr").textContent = e.message + " — [제출하기]를 다시 눌러 주세요.";
    } finally {
      submitting = false;
      $("submitBtn").disabled = false;
    }
  }

  function showReport(rep, earlier) {
    $("doneMsg").textContent = earlier ? "이미 제출한 시험입니다. 결과는 선생님께도 전달되었어요."
      : "제출했습니다. 결과는 선생님께도 전달되었어요.";
    $("crumbs").textContent = `${rep.studentName || ""} · 결과`;
    document.title = `레벨테스트 결과 · ${rep.studentName || ""}`;
    $("reportBox").innerHTML = `<style>${window.LTR.CSS}</style>` +
      window.LTR.reportHtml(rep, { academy: info && info.academy, logo: info && info.logo });
    show("scrReport");
  }
  $("printBtn").addEventListener("click", () => window.print());
  $("againBtn").addEventListener("click", () => {
    store(KEY, undefined);
    location.href = "/test.html";
  });

  /* ── 처음 ── */
  async function boot() {
    if (!CODE) { fail("시험을 찾을 수 없습니다. 시험 목록에서 다시 열어 주세요."); return; }
    try {
      info = await call(`/api/lt/info?k=${encodeURIComponent(CODE)}`);
    } catch (e) {
      fail(e.message);
      return;
    }
    setBrand(info.academy, info.logo);
    if (info.done) { showReport(info.report, true); return; }   // 이미 낸 시험 — 결과 요약만
    // 이 탭에서 보던 응시가 있으면 이어서(새로고침·잘못 닫았다 다시 연 경우)
    const saved = load(KEY);
    if (saved && saved.attemptId && saved.token) {
      try {
        const r = await call("/api/lt/resume", { attemptId: saved.attemptId, token: saved.token });
        att = saved;
        if (r.done) { showReport(r.report); return; }
        answers = load(KEY + ":a:" + saved.attemptId) || {};
        startTest(r);
        return;
      } catch (_) {
        store(KEY, undefined);
      }
    }
    if (!(info.sets || []).length) { fail("시험지가 아직 준비되지 않았습니다. 선생님께 알려 주세요."); return; }
    renderStart();
    show("scrStart");
  }
  boot();
})();
