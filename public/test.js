/* 레벨테스트 사이트(test.html) — 로그인 → 내게 낸 레벨테스트 목록. 응시는 lt.html(/lt/<출제 코드>).
   계정은 선생님이 레벨테스트 탭에서 등록한다(server.py lt_create_student). 학생 관리(student.html)와 따로다.
   목록 카드는 학생 사이트의 testCardHtml과 같은 모양(.st-card)이다. */
"use strict";
(function () {
  const $ = (id) => document.getElementById(id);
  const esc = (s) => String(s == null ? "" : s)
    .replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");

  async function call(url, payload) {
    const res = await fetch(url, payload ? {
      method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(payload),
    } : undefined);
    let data = null;
    try { data = await res.json(); } catch (_) {}
    if (!data) throw new Error(`서버에 연결하지 못했습니다 (HTTP ${res.status}).`);
    if (!res.ok) { const e = new Error(data.error || "요청에 실패했습니다."); e.status = res.status; throw e; }
    return data;
  }

  function setHead(academy) {
    $("headTitle").textContent = academy ? `${academy} · 레벨테스트` : "레벨테스트";
  }

  function showLogin() {
    $("listCard").hidden = true;
    $("loginCard").hidden = false;
    setHead("");
    $("headSub").textContent = "선생님이 정해 준 아이디로 로그인합니다.";
    $("loginId").focus();
  }

  function cardHtml(t) {
    const href = `/lt/${encodeURIComponent(t.code)}`;
    const bits = [`${t.questionCount}문항`];
    if (t.timeLimitSec) bits.push(`제한 시간 ${Math.round(t.timeLimitSec / 60)}분`);
    if (t.hasListening) bits.push("듣기 포함 🔊");
    let status = "", buttons = "";
    if (t.done) {
      status = `<div class="st-card-status ok">✅ 제출했어요</div>`;
      buttons = `<a class="btn ghost" href="${href}">결과 보기</a>`;
    } else if (!t.open) {
      status = `<div class="st-card-status">선생님이 닫은 시험입니다</div>`;
    } else {
      buttons = `<a class="btn" href="${href}">${t.started ? "이어서 보기" : "응시하기"}</a>`;
    }
    return `<div class="panel st-card">
        <div class="st-card-title">🎯 ${esc(t.title)}</div>
        <div class="hint">${esc(bits.join(" · "))}</div>
        ${status}
        <div class="st-card-actions">${buttons}</div>
      </div>`;
  }

  async function showList() {
    let me;
    try {
      me = await call("/api/lt/me");
    } catch (e) {
      if (e.status !== 401) $("loginErr").textContent = e.message;
      showLogin();
      return;
    }
    setHead(me.academy);
    $("headSub").textContent = "선생님이 낸 레벨테스트를 볼 수 있어요.";
    $("hello").textContent = `${me.name} 학생, 안녕하세요.`;
    $("loginCard").hidden = true;
    $("listCard").hidden = false;
    $("tests").innerHTML = `<p class="hint">불러오는 중…</p>`;
    $("listErr").textContent = "";
    try {
      const rows = (await call("/api/lt/tests")).tests || [];
      $("tests").innerHTML = rows.length ? rows.map(cardHtml).join("")
        : `<p class="hint">아직 선생님이 낸 레벨테스트가 없습니다.</p>`;
    } catch (e) {
      $("tests").innerHTML = "";
      $("listErr").textContent = e.message;
    }
  }

  $("loginForm").addEventListener("submit", async (e) => {
    e.preventDefault();
    $("loginErr").textContent = "";
    $("loginBtn").disabled = true;
    $("loginStatus").textContent = "확인 중…";
    try {
      // 아이디만으로 로그인한다(비밀번호 없음 — server.py lt_login)
      await call("/api/lt/login", { loginId: $("loginId").value.trim() });
      $("loginId").value = "";
      await showList();
    } catch (err) {
      $("loginErr").textContent = err.message;
    } finally {
      $("loginBtn").disabled = false;
      $("loginStatus").textContent = "";
    }
  });

  $("logoutBtn").addEventListener("click", async () => {
    try { await call("/api/lt/logout", {}); } catch (_) {}
    try { sessionStorage.clear(); } catch (_) {}
    showLogin();
  });

  showList();
})();
