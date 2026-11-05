/* ══════ 내용 한장정리 (2026-11-03 사용자) ══════
   지문 하나 → A4 두 쪽(아래 '쪽 대원칙'), 우리말로만 글의 내용을 쉽고 자세히 풀어 준다.
   해석·문법은 상세분석·요약분석·리딩노트가 하므로, 여기는 '분야를 몰라 글 자체가 이해되지 않는' 학생을 위한
   자리다 — 영어 원문은 싣지 않고(대목마다 찾을 수 있게 첫 낱말만), 대목마다 선생님이 이야기하듯 풀어 준다.
     머리(제목·한 줄 요약) / 01 알아 두면 쉬워지는 배경지식(분야·읽기 전 상식·개념 카드 — 상세분석의 배경지식 칸과 같은 내용) /
     02 차근차근 풀어 읽기 / 03 쉽게 말하면·글쓴이가 하고 싶은 말 / 04 스스로 확인
   서버는 /api/explain(call_gemini_explain, Flash, 지문 1개당 PRICE_EXPLAIN_KRW)이고 글자만 돌려준다 — 여기서 esc()로 넣는다.
   app.js 뒤에 로드되며 app.js의 전역($, esc, postGenerate, passageMgr, TAB_SAVE …)을 쓴다(decode.js와 같은 방식).
   공용 지문칸을 그대로 쓴다. 결과 칸은 #xpResult 하나. */

const xpEl = (id) => document.getElementById(id);
// 이 탭의 이름 — 사이드바 단추·저장함·파일 이름이 함께 쓴다(이름을 바꾸면 index.html 단추 글자도 같이)
const EXPLAIN_NAME = "내용 한장정리";
const xpState = {
  entries: [],   // [{name, text, data, error, imgSrc, imgError}] — data는 서버 응답(_finish_explain 모양)
  title: "",
  editing: false,
  busy: false,
};

/* 요약 이미지(2026-11-03 사용자) — 지문마다 한 장. 요약분석·상세분석의 요약 이미지와 같은 그림이다(app.js makeSummaryImage —
   인포그래픽은 /api/infographic, 4컷은 /api/decodepic, 값도 그쪽 그대로 imgLangPrice). 고르는 값은 그쪽의 사양 글자와 같다
   ("ko"·"comic:illust"·"comic:webtoon:ko" …). 이 탭은 우리말 풀이라 한글요약이 기본이다.
   그림 본체는 entry.imgSrc(blob 주소, 화면에서만 산다), 사양·4컷 컷 설명은 entry.data.img({spec, caps})에 담겨 저장본 글에 들어간다.
   본체는 저장할 때 /api/saved-image로 따로 올린다(리딩노트·요약분석과 같은 길). */
// 고르는 칸은 요약분석과 같은 모양이다(index.html xpLangBox — app.js의 pickedImgLangs·imgSpecsFor·지문마다 따로 고르기를
// prefix "xp"로 그대로 쓴다, 2026-11-03 사용자). 다만 그림 자리가 둘째 쪽 한 장뿐이라 종류는 하나만 켜진다(아래 xpLangBox).
const xpSpecLang = (spec) => String(spec || "").split(":")[0];
const xpSpecName = (spec) => specName(spec);
// 이 지문에 그릴 그림 사양 — 없으면 ""
const xpSpecFor = (job) => imgSpecsFor("xp", job)[0] || "";
xpEl("xpLangBox").addEventListener("change", (e) => {
  const c = e.target.closest(".img-lang");
  if (c && c.checked) xpEl("xpLangBox").querySelectorAll(".img-lang").forEach((x) => { if (x !== c) x.checked = false; });
  xpSyncCost();
});
setupImgPerList("xp", () => xpSyncCost());
// 이 탭이 만든 blob 주소 — 다시 만들거나 비울 때 놓아 준다
let xpBlobUrls = [];
function xpDropBlobs() {
  xpBlobUrls.forEach((u) => URL.revokeObjectURL(u));
  xpBlobUrls = [];
}

/* ── 그리기 ── */
// 편집할 수 있는 칸에는 data-f로 자리(data 안의 경로)를 적어 둔다 — 고친 글을 저장할 때 그 자리로 되돌려 넣는다(xpHarvest)
const xpEd = (f, text, tag = "span", cls = "") =>
  `<${tag} class="xp-ed${cls ? " " + cls : ""}" data-f="${f}">${esc(text || "")}</${tag}>`;

// 쪽 구성 화면에서만 보이는 옮기기 단추 — 첫 쪽의 둘째 칸부터는 [여기부터 2쪽으로], 둘째 쪽의 첫 칸에는 [1쪽으로 올리기](CSS가 고른다)
const XP_MV = `<span class="xp-mv"><button type="button" class="xp-mv-down" data-mv="down" title="이 칸부터 뒤의 칸을 모두 둘째 쪽으로 보냅니다">⤵ 여기부터 2쪽으로</button><button type="button" class="xp-mv-up" data-mv="up" title="이 칸을 첫 쪽으로 올립니다">⤴ 1쪽으로 올리기</button></span>`;
const xpSecHead = (no, ko) => `<h4 class="xp-h"><span class="xp-h-no">${no}</span>${ko}</h4>`;

function xpSheetHtml(e, i) {
  if (e.error || !e.data) {
    return `<section class="passage-block xp-sheet" data-i="${i}"><div class="passage-error">` +
      `⚠️ ${esc(e.name)} — ${esc(e.error || "만들지 못했습니다.")} (이 지문의 값은 나가지 않았습니다)</div></section>`;
  }
  const d = e.data;
  let no = 0;
  const sec = (ko) => xpSecHead(String(++no).padStart(2, "0"), ko);
  const parts = (d.parts || []).map((p, k) =>
    `<li class="xp-part"><div class="xp-part-side">` +
    `${p.range ? `<span class="xp-part-range">문장 ${esc(p.range)}</span>` : ""}` +
    `${p.cue ? xpEd(`p.${k}.cue`, p.cue, "span", "xp-part-cue") : ""}</div>` +
    `<div class="xp-part-body">${xpEd(`p.${k}.heading`, p.heading, "div", "xp-part-head")}` +
    `${xpEd(`p.${k}.explain`, p.explain, "div", "xp-part-text")}</div></li>`).join("");
  // 배경지식 개념 카드 — 상세분석 배경지식(buildBackgroundHtml)과 같은 내용: 용어 · 한 줄 정의 · 쉬운 설명 · 이 글에서는.
  // 옛 저장본(2026-11-03 첫 판)은 terms({en, ko, explain})로 담겨 있어 그대로 읽는다
  const cKey = d.concepts ? "c" : "t";
  const terms = (d.concepts || d.terms || []).map((t, k) =>
    `<div class="xp-term"><div class="xp-term-name">${xpEd(`${cKey}.${k}.ko`, t.ko, "b")}` +
    `${t.en ? ` ${xpEd(`${cKey}.${k}.en`, t.en, "span", "xp-term-en")}` : ""}</div>` +
    `${t.short ? xpEd(`${cKey}.${k}.short`, t.short, "div", "xp-term-short") : ""}` +
    `${t.explain ? xpEd(`${cKey}.${k}.explain`, t.explain, "div", "xp-term-text") : ""}` +
    `${t.link ? `<div class="xp-term-link"><span>📖 이 글에서는</span> ${xpEd(`${cKey}.${k}.link`, t.link)}</div>` : ""}</div>`).join("");
  const bg = d.primer || terms;
  // 요약 이미지 — 늘 둘째 쪽에 크게(2026-11-03 사용자: 글 한 쪽 + 그림 한 쪽 = 두 쪽). 4컷은 한 장을 칸마다 잘라
  // 2×2로 크게(리딩노트 .dc-cuts 마크업에 .xp-cuts2를 더한다), 인포그래픽은 쪽 너비 그대로
  const img = e.imgSrc && d.img ? d.img : null;
  const isComic = !!img && xpSpecLang(img.spec) === "comic";
  const imgHtml = !img ? "" : isComic
    ? `<div class="dc-cuts xp-cuts2">${[0, 1, 2, 3].map((j) =>
      `<figure class="dc-cut"><div class="dc-cut-img"><img src="${e.imgSrc}" alt="" ` +
      `style="left:${-((j % 2) * 103 + 1.5)}%;top:${-(Math.floor(j / 2) * 103 + 1.5)}%"></div>` +
      `<figcaption><b>${j + 1}</b>${xpEd(`img.${j}`, (img.caps || [])[j] || "")}</figcaption></figure>`).join("")}</div>`
    : `<img class="xp-info" src="${e.imgSrc}" alt="요약 이미지">`;
  const tools = `<div class="xp-tools">` +
    (img ? `<button type="button" class="btn ghost small" data-act="img">🔄 그림 다시 만들기</button>` +
      `<button type="button" class="btn ghost small" data-act="noimg">그림 빼기</button>`
      : `<button type="button" class="btn ghost small" data-act="img">🖼️ 요약 이미지 넣기</button>`) +
    (d.split ? `<button type="button" class="btn ghost small xp-auto-btn" data-act="autosplit" title="손으로 정한 쪽 나눔을 풀고 다시 알아서 맞춥니다">↺ 쪽 나눔 자동으로</button>` : "") +
    (e.imgError ? `<span class="xp-tools-err">⚠️ ${esc(e.imgError)}</span>` : "") + `</div>`;
  const qs = (d.questions || []).map((q, k) =>
    `<li class="xp-q"><span class="xp-q-no">Q${k + 1}</span><div>${xpEd(`q.${k}.q`, q.q, "div", "xp-q-q")}` +
    `<div class="xp-q-a"><span class="xp-q-a-lab">답</span>${xpEd(`q.${k}.a`, q.a)}</div></div></li>`).join("");
  return `<section class="passage-block xp-sheet" data-i="${i}">
    ${tools}
    <div class="xp-fitnote" hidden></div>
    <div class="xp-page">
      <header class="xp-head"><span class="xp-head-title">${esc(xpState.title || EXPLAIN_NAME)}</span>` +
      `<span class="xp-head-name">${esc(e.name)}</span></header>
      <div class="xp-lead">
        ${xpEd("title", d.title, "div", "xp-title")}
        ${xpEd("oneLine", d.oneLine, "div", "xp-oneline")}
      </div>
      ${bg ? `<div class="xp-sec xp-sec-bg" data-sec="bg">${XP_MV}${sec(`알아 두면 쉬워지는 배경지식${d.field ? ` ${xpEd("field", d.field, "span", "xp-field")}` : ""}`)}` +
        `${d.primer ? xpEd("primer", d.primer, "div", "xp-primer") : ""}` +
        `${terms ? `<div class="xp-terms">${terms}</div>` : ""}</div>` : ""}
      <div class="xp-sec xp-sec-parts" data-sec="parts">${XP_MV}${sec("차근차근 풀어 읽기")}<ol class="xp-parts">${parts}</ol></div>
      <div class="xp-sec xp-sec-sum" data-sec="sum">${XP_MV}${sec("한마디로 정리하면")}
        <div class="xp-pair">
          ${d.analogy ? `<div class="xp-card"><span class="xp-card-lab">쉽게 말하면</span>${xpEd("analogy", d.analogy, "div")}</div>` : ""}
          <div class="xp-card xp-card-main"><span class="xp-card-lab">글쓴이가 하고 싶은 말</span>${xpEd("message", d.message, "div")}</div>
        </div>
      </div>
      ${qs ? `<div class="xp-sec xp-sec-qs" data-sec="qs">${XP_MV}${sec("스스로 확인하기")}<ol class="xp-qs">${qs}</ol></div>` : ""}
    </div>
    ${imgHtml ? `<div class="xp-page xp-page2">
      <header class="xp-head"><span class="xp-head-title">${esc(xpState.title || EXPLAIN_NAME)}</span>` +
      `<span class="xp-head-name">${esc(e.name)}</span></header>
      <div class="xp-sec xp-sec-img" data-sec="img">${sec("그림으로 보기")}${imgHtml}</div>
    </div>` : ""}
  </section>`;
}

function xpRender() {
  const ok = xpState.entries.some((e) => e.data);
  xpEl("xpResult").innerHTML = xpState.entries.map(xpSheetHtml).join("");
  ["xpPrintBtn", "xpEditBtn", "xpSaveBtn", "xpPageBtn"].forEach((id) => { xpEl(id).style.display = ok ? "" : "none"; });
  if (!ok && xpPaging) xpSetPaging(false);
  xpEl("xpImgBtn").style.display = xpState.entries.some((e) => e.data && !e.imgSrc) ? "" : "none";
  xpSetEditing(xpState.editing && ok);
  xpFitSoon();
  if (typeof syncFloatPrint === "function") syncFloatPrint();
}

/* ── 쪽 대원칙(2026-11-06 사용자) ──
   지문 하나 = 두 쪽. **1쪽은 머리·제목 ~ 배경지식 ~ 풀어 읽기 ~ 한마디로 정리하면, 2쪽은 스스로 확인하기 + 그림으로 보기.**
   글 길이에 따라 칸을 옮기지 않는다 — 예전엔 재어 본 높이로 칸을 옮겼는데 그 값이 어긋나면 그림이 3쪽으로 밀렸다.
   이 나눔은 늘 그대로이고, 맞추는 일은 크기만 한다: 2쪽은 그림을 100 → 80 → 65 → 50%로, 1쪽이 넘치면 글씨를 94 → 88 → 82%(바닥)로.
   그림이 없으면 스스로 확인하기가 1쪽에 들 때만 1쪽에 두고(종이 한 장으로 끝난다) 안 들면 2쪽이다.
   쪽 구성(xpPaging)에서 선생님이 나눔을 정하면(data.split = 둘째 쪽 첫 칸의 이름) 그것만 예외다.
   그래도 넘치면 마지막으로 **넘친 쪽의** 덜 중요한 칸부터 인쇄에서 뺀다(XP_OMIT_STEPS — .xp-omit: 인쇄·측정에서는 숨고 화면에는
   흐리게 '인쇄 제외'로 남는다. 저장본에는 그대로). 풀어 읽기와 글쓴이가 하고 싶은 말은 빼지 않는다.
   높이는 리딩노트의 dcFit과 같은 방식으로 화면에서 인쇄 폭(.xp-measure, style.css에 인쇄 규칙과 같은 값)으로 잰다.
   **다시 그린 뒤에는 반드시 재야 한다** — 재기 전의 화면은 모든 칸이 1쪽에 있다. xpRender는 rAF로 미뤄 재는데, 인쇄 안내창의 이름
   반영(xpTitleHandle.set)이 다시 그린 직후 window.print()가 먼저 돌아 칸이 1쪽에 둔 채 인쇄됐다(3쪽 현상의 원인) —
   그래서 인쇄 단추가 before로 xpFit을 바로 부른다. */
const XP_FIT_STEPS = ["", "94", "88", "82"];
const XP_IMG_SIZES = ["", "80", "65", "50"];
const XP_SEC_NAMES = { bg: "배경지식", parts: "차근차근 풀어 읽기", sum: "한마디로 정리하면", qs: "스스로 확인하기" };

// 칸 나눔 — 글 칸 secs 중 k번째부터 둘째 쪽(그림 칸 앞)으로. 둘째 쪽은 쓸 일이 있을 때만 만든다(빈 쪽이 인쇄되지 않게)
function xpPlace(sheet, secs, k) {
  const p1 = sheet.querySelector(":scope > .xp-page:not(.xp-page2)");
  let p2 = sheet.querySelector(":scope > .xp-page2");
  if (k < secs.length && !p2) {
    const e = xpState.entries[Number(sheet.dataset.i)] || {};
    sheet.insertAdjacentHTML("beforeend", `<div class="xp-page xp-page2">` +
      `<header class="xp-head"><span class="xp-head-title">${esc(xpState.title || EXPLAIN_NAME)}</span>` +
      `<span class="xp-head-name">${esc(e.name || "")}</span></header></div>`);
    p2 = sheet.querySelector(":scope > .xp-page2");
  }
  const img = p2 && p2.querySelector(":scope > .xp-sec-img");
  secs.forEach((s, j) => {
    if (j < k) p1.appendChild(s);
    else p2.insertBefore(s, img || null);
  });
  if (p2 && !img && k >= secs.length) p2.remove();
}
const XP_OMIT_STEPS = [
  [".xp-q:nth-child(3)", "확인 질문 3번"],
  [".xp-term:nth-child(3)", "배경지식 개념 3번"],
  [".xp-q:nth-child(2)", "확인 질문 2번"],
  [".xp-term-link", "개념 카드의 '이 글에서는'"],
  [".xp-card:not(.xp-card-main)", "'쉽게 말하면' 비유"],
  [".xp-term:nth-child(2)", "배경지식 개념 2번"],
  [".xp-sec-qs", "스스로 확인하기"],
  [".xp-term-text", "개념 카드의 설명"],
];
// 직접 수정 중에 글이 늘면 바로 다시 잰다(넘치면 안내가 뜨고 덜 중요한 칸이 빠진다)
let xpFitTimer = 0;
xpEl("xpResult").addEventListener("input", () => {
  clearTimeout(xpFitTimer);
  xpFitTimer = setTimeout(xpFit, 400);
});
function xpFit() {
  const host = xpEl("xpResult");
  if (!host.offsetParent || typeof PAGE_H_MM === "undefined") return;   // 탭이 숨어 있으면 못 잰다 — 탭을 열 때 다시
  const sheets = [...host.querySelectorAll(".xp-sheet")].filter((s) => s.querySelector(".xp-page"));
  if (!sheets.length) return;
  // 여유 8mm — 3mm로 두었더니 학원 마크 줄이 찍힌 실제 인쇄에서 마지막 칸(스스로 확인하기)이 다음 쪽으로 밀렸다(2026-11-03).
  // 칸은 쪽 사이에서 쪼개지지 않게 해 두어(break-inside:avoid) 조금만 넘쳐도 칸째 넘어간다
  const limit = (PAGE_H_MM - 8) * PX_PER_MM;
  host.classList.add("xp-measure");
  sheets.forEach((sheet) => {
    const e = xpState.entries[Number(sheet.dataset.i)] || {};
    const secs = [...sheet.querySelectorAll(".xp-sec[data-sec]:not([data-sec=img])")];
    const hasImg = !!sheet.querySelector(".xp-sec-img");
    sheet.querySelectorAll(".xp-omit").forEach((el) => el.classList.remove("xp-omit"));
    const pages = () => [...sheet.querySelectorAll(":scope > .xp-page")];
    const over = () => pages().filter((p) => p.getBoundingClientRect().height > limit);
    const fits = () => !over().length;
    // 손으로 정한 나눔(그 칸이 지금 없으면 대원칙대로)
    const manual = !e.data || !e.data.split ? -1
      : e.data.split === "none" ? secs.length : secs.findIndex((s) => s.dataset.sec === e.data.split);
    // 대원칙 — 스스로 확인하기부터 둘째 쪽. 그림이 없으면 1쪽에 들 때만 1쪽에 둔다
    const qsAt = secs.findIndex((s) => s.dataset.sec === "qs");
    const ks = manual > 0 ? [manual]
      : qsAt < 0 ? [secs.length] : hasImg ? [qsAt] : [secs.length, qsAt];
    const sizes = hasImg ? XP_IMG_SIZES : [""];
    let found = null;
    outer:
    for (const f of XP_FIT_STEPS) {
      sheet.dataset.fit = f;
      for (const k of ks) {
        xpPlace(sheet, secs, k);
        for (const size of sizes) {
          sheet.dataset.img = size;
          if (fits()) { found = { f, k, size }; break outer; }
        }
      }
    }
    const omitted = [];
    if (!found) {
      // 마지막 — 글씨 82%에서 넘친 쪽의 덜 중요한 칸을 뺀다. 그림은 그 쪽이 안 넘치는 가장 큰 크기로 돌려놓고 뺀다
      const k = ks[ks.length - 1];
      xpPlace(sheet, secs, k);
      const p2 = sheet.querySelector(":scope > .xp-page2");
      for (const size of sizes) {
        sheet.dataset.img = size;
        if (!p2 || p2.getBoundingClientRect().height <= limit) break;
      }
      for (const [sel, name] of XP_OMIT_STEPS) {
        const els = over().flatMap((p) => [...p.querySelectorAll(sel)]);
        if (!els.length) continue;
        els.forEach((el) => el.classList.add("xp-omit"));
        omitted.push(name);
        if (fits()) { found = { f: sheet.dataset.fit, k, size: sheet.dataset.img }; break; }
      }
    }
    const note = sheet.querySelector(".xp-fitnote");
    const parts = [];
    const moved = found ? secs.slice(found.k).map((s) => XP_SEC_NAMES[s.dataset.sec]) : [];
    if (!found) parts.push("⚠️ 풀어 읽기 글이 길어 두 쪽을 넘습니다 — ✏️ 직접 수정으로 풀이를 조금 줄여 주세요.");
    else {
      if (moved.length && manual <= 0 && !hasImg) parts.push(`📄 첫 쪽에 다 들어가지 않아 ${moved.join("·")}${josa(moved[moved.length - 1], "을", "를")} 둘째 쪽으로 넘겼습니다.`);
      if (found.f) parts.push(`📏 두 쪽에 맞추려고 이 지문만 글씨를 ${found.f}%로 줄였습니다.`);
      if (found.size) parts.push(`🖼️ 그림을 ${found.size}% 크기로 줄였습니다.`);
      if (omitted.length) parts.push(`✂️ 두 쪽에 맞추려고 인쇄에서 뺀 것: ${omitted.join(", ")} (화면에 흐리게 보이는 칸).`);
    }
    note.textContent = parts.join(" ");
    note.hidden = !parts.length;
    note.classList.toggle("xp-fitnote-warn", !found);
  });
  host.classList.remove("xp-measure");
}

/* ── 쪽 구성(2026-11-03 사용자) — 상세분석의 [📄 쪽 구성]처럼 칸을 쪽 사이로 옮긴다.
   켜면 칸마다 단추가 보인다: 첫 쪽의 둘째 칸부터 [⤵ 여기부터 2쪽으로], 둘째 쪽 첫 칸에 [⤴ 1쪽으로 올리기].
   정한 나눔은 data.split(둘째 쪽 첫 칸의 이름, 1쪽에 다 두면 "none")으로 저장본에 남고, [↺ 쪽 나눔 자동으로]로 푼다. */
let xpPaging = false;
function xpSetPaging(on) {
  xpPaging = !!on;
  xpEl("xpResult").classList.toggle("xp-paging", xpPaging);
  xpEl("xpPageBtn").textContent = xpPaging ? "✅ 쪽 구성 끝내기" : "📄 쪽 구성";
}
xpEl("xpPageBtn").addEventListener("click", () => xpSetPaging(!xpPaging));
xpEl("xpResult").addEventListener("click", (ev) => {
  const b = ev.target.closest(".xp-mv button[data-mv]");
  if (!b) return;
  const sheet = b.closest(".xp-sheet");
  const e = xpState.entries[Number(sheet.dataset.i)];
  if (!e || !e.data) return;
  if (xpState.editing) xpHarvest();
  const secs = [...sheet.querySelectorAll(".xp-sec[data-sec]:not([data-sec=img])")];
  const j = secs.indexOf(b.closest(".xp-sec"));
  // 내리기: 이 칸부터 둘째 쪽 / 올리기: 이 칸까지 첫 쪽(다음 칸부터 둘째 쪽, 없으면 모두 첫 쪽)
  const k = b.dataset.mv === "down" ? j : j + 1;
  e.data.split = k < secs.length ? secs[k].dataset.sec : "none";
  xpRender();
});
function xpFitSoon() {
  requestAnimationFrame(xpFit);
  if (document.fonts && document.fonts.ready) document.fonts.ready.then(() => requestAnimationFrame(xpFit));
}

/* ── 직접 수정 ── */
function xpSetEditing(on) {
  xpState.editing = !!on;
  xpEl("xpResult").classList.toggle("xp-editing", xpState.editing);
  xpEl("xpResult").querySelectorAll(".xp-ed").forEach((el) => {
    if (xpState.editing) el.setAttribute("contenteditable", "true");
    else el.removeAttribute("contenteditable");
  });
  xpEl("xpEditBtn").textContent = xpState.editing ? "✅ 수정 끝내기" : "✏️ 직접 수정";
}

// 화면에서 고친 글을 data로 되돌려 넣는다 — 저장·인쇄 전에 부른다
function xpHarvest() {
  xpEl("xpResult").querySelectorAll(".xp-sheet").forEach((sheet) => {
    const e = xpState.entries[Number(sheet.dataset.i)];
    if (!e || !e.data) return;
    sheet.querySelectorAll(".xp-ed[data-f]").forEach((el) => {
      const val = el.innerText.replace(/\s+/g, " ").trim();
      const p = el.dataset.f.split(".");
      const d = e.data;
      const list = { p: d.parts, c: d.concepts, t: d.terms, q: d.questions }[p[0]];
      if (p.length === 1) d[p[0]] = val;
      else if (p[0] === "img" && d.img && Array.isArray(d.img.caps)) d.img.caps[+p[1]] = val;
      else if (list && list[+p[1]]) list[+p[1]][p[2]] = val;
    });
  });
}

xpEl("xpEditBtn").addEventListener("click", () => {
  const wasEditing = xpState.editing;
  if (wasEditing) xpHarvest();
  xpSetEditing(!wasEditing);
  if (wasEditing) xpFitSoon();   // 글 길이가 바뀌었을 수 있다
});

/* ── 값 안내 ── */
// 그림 한 장 값 — 종류마다 다르다(인포그래픽·4컷, app.js imgLangPrice)
const xpImgPrice = (spec) => (typeof PRICING !== "undefined" && PRICING ? imgLangPrice(xpSpecLang(spec)) : null);
// 그림 값 합계 — 지문마다 고른 사양대로(없으면 0)
const xpImgsCost = (list) => list.reduce((s, j) => {
  const spec = xpSpecFor(j);
  return s + (spec ? xpImgPrice(spec) || 0 : 0);
}, 0);
function xpCost(jobs, withImg) {
  if (typeof PRICING === "undefined" || !PRICING || !Number.isFinite(PRICING.explain)) return null;
  return PRICING.explain * jobs.length + (withImg ? xpImgsCost(jobs) : 0);
}
function xpJobs() {
  return passageMgr.getJobs().filter((j) => j.text && j.text.length >= 20);
}
function xpSyncCost() {
  const jobs = xpJobs();
  const n = jobs.length;
  const imgN = jobs.filter((j) => xpSpecFor(j)).length;
  const cost = xpCost(jobs, true);
  xpEl("xpCostHint").innerHTML = n && cost !== null
    ? `예상 비용 <b>${pt(cost)}</b> (지문 ${n}개 × ${pt(PRICING.explain)}` +
      `${imgN ? ` + 요약 이미지 ${imgN}장 ${pt(xpImgsCost(jobs))}` : ""})` : "";
  syncImgLangNote("xp");
}
if (typeof onPricingReady === "function") onPricingReady(xpSyncCost);
document.addEventListener("input", (e) => {
  if (e.target.closest && e.target.closest(".passage-panel")) xpSyncCost();
});
document.querySelector('.tab-btn[data-tab="explain"]').addEventListener("click", () => { xpSyncCost(); xpFitSoon(); });

/* ── 요약 이미지 그리기 ── 실패해도 풀이는 그대로 두고 그 지문 위에 이유만 적는다(값은 서버가 성공했을 때만 받는다) */
async function xpDrawImg(e, spec, onRetry) {
  e.imgError = "";
  try {
    const r = await makeSummaryImage("xp", spec, { text: e.text }, onRetry);
    if (e.imgSrc) URL.revokeObjectURL(e.imgSrc);
    xpBlobUrls.push(r.src);
    e.imgSrc = r.src;
    e.data.img = r.caps ? { spec, caps: r.caps } : { spec };
    return true;
  } catch (err) {
    e.imgError = err.message || String(err);
    if (err.code === "quota" || err.code === "no_tokens") throw err;
    return false;
  }
}

// 여러 지문에 차례로 그린다(목록의 [🖼️ 요약 이미지 넣기]와 지문마다의 단추가 같이 쓴다)
async function xpDrawImgs(list) {
  const errEl = xpEl("xpError");
  errEl.textContent = "";
  if (!list.length) return;
  const specs = list.map((e) => xpSpecFor(e));
  if (!specs.some(Boolean)) {
    errEl.textContent = "위 '요약 이미지' 칸에서 그림 종류를 먼저 골라 주세요.";
    return;
  }
  list = list.filter((e, i) => specs[i]);
  const kinds = [...new Set(list.map((e) => xpSpecName(xpSpecFor(e))))];
  if (!(await costConfirmed(PRICING ? xpImgsCost(list) : null,
    `${EXPLAIN_NAME} 요약 이미지(${kinds.join(" · ")}) · ${list.length}장`, list.length))) return;
  if (xpState.editing) { xpHarvest(); xpSetEditing(false); }
  xpState.busy = true;
  xpEl("xpMakeBtn").disabled = xpEl("xpImgBtn").disabled = true;
  const loading = xpEl("xpLoading");
  const text = xpEl("xpLoadingText");
  loading.classList.add("on");
  try {
    for (let i = 0; i < list.length; i++) {
      text.textContent = `AI가 ${list[i].name}의 요약 이미지를 그리고 있습니다… (${i + 1}/${list.length})`;
      try {
        await xpDrawImg(list[i], xpSpecFor(list[i]), (n) => { text.textContent = `연결이 끊겨 다시 받아 오는 중… (${n})`; });
      } catch (err) {
        errEl.textContent = err.message;
        break;
      }
      xpRender();
    }
    xpRender();
  } finally {
    xpState.busy = false;
    xpEl("xpMakeBtn").disabled = xpEl("xpImgBtn").disabled = false;
    loading.classList.remove("on");
    refreshTokenDisplay();
  }
}
xpEl("xpImgBtn").addEventListener("click", () => {
  if (xpState.busy) return;
  if (xpState.editing) xpHarvest();
  xpDrawImgs(xpState.entries.filter((e) => e.data && !e.imgSrc));
});
// 지문마다의 단추 — 그림 넣기·다시 만들기(위에서 고른 종류로) / 그림 빼기
xpEl("xpResult").addEventListener("click", (ev) => {
  const b = ev.target.closest(".xp-tools button[data-act]");
  if (!b || xpState.busy) return;
  const e = xpState.entries[Number(b.closest(".xp-sheet").dataset.i)];
  if (!e || !e.data) return;
  if (xpState.editing) xpHarvest();
  if (b.dataset.act === "img") {
    xpDrawImgs([e]);
  } else if (b.dataset.act === "autosplit") {
    delete e.data.split;
    xpRender();
  } else if (b.dataset.act === "noimg") {
    if (!confirm("이 지문의 요약 이미지를 뺄까요? 다시 넣으려면 새로 그려야 합니다(값이 다시 나갑니다).")) return;
    delete e.data.img;
    e.imgSrc = "";
    e.imgError = "";
    xpRender();
  }
});

/* ── 만들기 ── */
async function xpMake() {
  const errEl = xpEl("xpError");
  errEl.textContent = "";
  const jobs = xpJobs();
  if (!jobs.length) {
    errEl.textContent = "위쪽 영어 지문 칸에 지문을 넣어 주세요 (20자 이상).";
    return;
  }
  const imgJobs = jobs.filter((j) => xpSpecFor(j));
  const withImg = imgJobs.length > 0;
  const kinds = [...new Set(imgJobs.map((j) => xpSpecName(xpSpecFor(j))))];
  if (!(await costConfirmed(xpCost(jobs, withImg),
    `${EXPLAIN_NAME} · 지문 ${jobs.length}개${withImg ? ` + 요약 이미지(${kinds.join(" · ")}) ${imgJobs.length}장` : ""}`,
    jobs.length, reduceAdvice(jobs.length, withImg ? "요약 이미지를 빼면" : "")))) return;
  if (typeof dropStaleSavedLink === "function") dropStaleSavedLink("explain");
  xpState.busy = true;
  xpEl("xpMakeBtn").disabled = true;
  const loading = xpEl("xpLoading");
  const text = xpEl("xpLoadingText");
  const gate = runGate(loading);
  gate.begin();
  loading.classList.add("on");
  xpState.entries = [];
  xpState.editing = false;
  xpDropBlobs();
  xpRender();
  let ok = 0;
  try {
    for (let i = 0; i < jobs.length; i++) {
      if (i && await gate.check(`지문 ${i}개까지 만들었습니다.`, xpRender)) {
        errEl.textContent = runEndedNote(jobs.length - i, "지문");
        break;
      }
      const j = jobs[i];
      text.textContent = `AI가 ${j.name}의 내용을 풀어 쓰고 있습니다… (${i + 1}/${jobs.length})`;
      try {
        const data = await postGenerate("/api/explain", { passage: j.text }, "내용 한장정리를 만들지 못했습니다.",
          (n) => { text.textContent = `연결이 끊겨 다시 받아 오는 중… (${n})`; });
        const entry = { name: j.name, text: j.text, data };
        xpState.entries.push(entry);
        ok++;
        const spec = xpSpecFor(j);
        if (spec) {
          xpRender();
          text.textContent = `AI가 ${j.name}의 요약 이미지를 그리고 있습니다… (${i + 1}/${jobs.length})`;
          // 그림은 실패해도 풀이는 남긴다. 한도 소진·잔액 부족이면 여기서 멈춘다
          const stop = await xpDrawImg(entry, spec, (n) => { text.textContent = `연결이 끊겨 다시 받아 오는 중… (${n})`; })
            .then(() => false, (err) => { errEl.textContent = err.message; return true; });
          if (stop) { xpRender(); break; }
        }
      } catch (err) {
        xpState.entries.push({ name: j.name, text: j.text, data: null, error: err.message || String(err) });
        // 한도 소진·잔액 부족은 다음 지문도 같은 답이다 — 거기서 멈춘다
        if (err.code === "quota" || err.code === "no_tokens") {
          errEl.textContent = err.message;
          break;
        }
      }
      xpRender();
    }
    if (typeof LOADED_SAVED !== "undefined" && !ok) delete LOADED_SAVED.explain;
    xpRender();
    if (ok) showDoneGuide(`지문 ${ok}개의 ${EXPLAIN_NAME}`, true);
  } finally {
    xpState.busy = false;
    xpEl("xpMakeBtn").disabled = false;
    loading.classList.remove("on");
    refreshTokenDisplay();
  }
}
xpEl("xpMakeBtn").addEventListener("click", () => { if (!xpState.busy) xpMake(); });

/* ── 인쇄·저장 ── */
xpEl("xpTitle").addEventListener("input", (e) => {
  xpState.title = e.target.value.trim();
  xpEl("xpResult").querySelectorAll(".xp-head-title").forEach((el) => { el.textContent = xpState.title || EXPLAIN_NAME; });
});
const xpTitleHandle = {
  get: () => xpState.title,
  set: (v) => { xpState.title = String(v || "").trim(); xpEl("xpTitle").value = xpState.title; xpRender(); },
};
const xpFileName = () => sanitizeFilename(xpState.title || (xpState.entries[0] && xpState.entries[0].name) || "");
xpEl("xpPrintBtn").addEventListener("click", () => {
  if (xpState.editing) { xpHarvest(); xpSetEditing(false); }
  if (xpPaging) xpSetPaging(false);
  // before — 이름을 반영하며 다시 그린 화면을 인쇄 직전에 바로 재서 쪽 나눔을 되찾는다(위 '쪽 대원칙')
  printDoc(() => [EXPLAIN_NAME, xpFileName(), todayStr()].filter(Boolean).join("_"), { title: xpTitleHandle, before: xpFit });
});
xpEl("xpSaveBtn").addEventListener("click", () => openSaveDialog("explain"));
xpEl("xpLoadBtn").addEventListener("click", () => openSavedList("tab", null, "explain"));

// 꾸미기 — 테마 색·글꼴만(app.js SHEET_FS.explain). 색은 --accent만 바꾼다
const xpSheetStyle = createSheetStyle("xpSheetStyle", xpEl("xpResult"), "explain");
xpSheetStyle.onChange(xpFitSoon);
const xpStyleTitle = xpEl("xpSheetStyle").querySelector(".sheet-style-title");
if (xpStyleTitle) xpStyleTitle.textContent = "🎨 내용 한장정리 꾸미기";

TAB_LABELS.explain = "💡 " + EXPLAIN_NAME;
TAB_LIBRARY_WORDS.explain = {
  title: `💡 ${EXPLAIN_NAME} 저장함`,
  lead: `저장해 둔 ${EXPLAIN_NAME} 자료입니다. [불러오기]를 누르면 AI를 다시 부르지 않고 그대로 엽니다.`,
  empty: `아직 저장한 ${EXPLAIN_NAME}${josa(EXPLAIN_NAME, "이", "가")} 없습니다. 만든 뒤 “💾 사이트 저장”을 눌러 보세요.`,
};
SAVE_TITLE_SUGGEST.explain = () => xpState.title || passageBasedName(EXPLAIN_NAME);
TAB_SAVE.explain = {
  // saveBtn을 등록하지 않는다 — app.js가 단추를 연결한 뒤에 이 파일이 로드된다(decode.js와 같다)
  canSave: () => (xpState.entries.some((e) => e.data) ? ""
    : `저장할 ${EXPLAIN_NAME}${josa(EXPLAIN_NAME, "이", "가")} 없습니다. 먼저 만들어 주세요.`),
  getPayload: () => {
    xpHarvest();
    const saved = xpState.entries.filter((e) => e.data);
    return {
      v: 1,
      passages: passageMgr.getJobs(),
      title: xpState.title,
      entries: saved.map((e) => ({ name: e.name, text: e.text, data: e.data })),
      // 요약 이미지는 목록만 — 본체는 저장한 뒤 afterSave가 한 장씩 올린다(저장본 문서 1MiB 한도)
      images: saved.map((e, i) => (e.imgSrc && e.data.img
        ? { entry: i, lang: xpSpecLang(e.data.img.spec), key: `p${i}`, spec: e.data.img.spec } : null)).filter(Boolean),
      sheetStyle: xpSheetStyle.get(),
    };
  },
  afterSave: async (itemId, payload, onProgress) => {
    const saved = xpState.entries.filter((e) => e.data);
    const todo = (payload.images || []).filter((m) => {
      const e = saved[m.entry];
      return e && e.imgSrc && xpSavedSrc.get(itemId + "|" + m.key) !== e.imgSrc;
    });
    let failed = 0;
    const reasons = new Set();
    if (onProgress && todo.length) onProgress(0, todo.length);
    for (let n = 0; n < todo.length; n++) {
      const m = todo[n];
      try {
        const src = saved[m.entry].imgSrc;
        const fit = await fitImageForSave(await fetch(src).then((r) => r.blob()));
        await postJson("/api/saved-image", { id: itemId, key: m.key, mime: fit.mime, image: fit.b64 },
          "그림 저장에 실패했습니다.");
        xpSavedSrc.set(itemId + "|" + m.key, src);
      } catch (e) {
        failed++;
        reasons.add((e && e.message) || String(e));
      }
      if (onProgress) onProgress(n + 1, todo.length);
    }
    if (failed) throw new Error(`글은 저장됐지만 요약 이미지 ${failed}장은 저장하지 못했습니다 — ${[...reasons].join(" / ")} 다시 저장해 보세요.`);
  },
  afterLoad: async (itemId, payload) => {
    let added = 0;
    for (const m of Array.isArray(payload.images) ? payload.images : []) {
      try {
        const d = await getJson(`/api/saved-image/${encodeURIComponent(itemId)}/${encodeURIComponent(m.key)}`, "");
        const e = xpState.entries[m.entry];
        if (d && d.image && e && e.data && e.data.img) {
          e.imgSrc = b64ToBlobUrl(d.image, d.mime || "image/jpeg");
          xpBlobUrls.push(e.imgSrc);
          xpSavedSrc.set(itemId + "|" + m.key, e.imgSrc);
          added++;
        }
      } catch (_e) { /* 이 그림만 건너뛴다 */ }
    }
    if (added) xpRender();
  },
  applyPayload: (payload) => {
    passageMgr.setJobs(payload.passages || []);
    if (payload.sheetStyle) xpSheetStyle.set(payload.sheetStyle);
    xpState.title = String(payload.title || "");
    xpEl("xpTitle").value = xpState.title;
    xpDropBlobs();
    xpState.entries = (payload.entries || []).filter((e) => e && e.data).map((e) => ({ ...e, imgSrc: "" }));
    xpState.editing = false;
    xpEl("xpError").textContent = "";
    xpRender();
    xpSyncCost();
  },
  clearResults: () => {
    xpDropBlobs();
    xpState.entries = [];
    xpState.editing = false;
    xpEl("xpError").textContent = "";
    xpRender();
  },
};

// 저장본에 이미 올린 그림(저장본 id|key → 그때의 그림 주소) — 같은 그림을 다시 올리지 않는다
const xpSavedSrc = new Map();

if (typeof HOWTO !== "undefined") {
  HOWTO.explain = {
    title: `💡 ${EXPLAIN_NAME} 만드는 법`,
    lead: "영어 해석이 아니라 <b>글의 내용 자체</b>를 우리말로 쉽고 자세히 풀어 주는 한 쪽 자료입니다 — 분야가 낯설어 해석을 해도 무슨 말인지 모르는 학생에게 좋습니다.",
    steps: [
      "위쪽 <b>영어 지문</b> 칸에 지문을 넣습니다(여러 개면 <b>＋ 지문 추가</b>). 지문 이름이 쪽 머리띠에 찍힙니다.",
      "필요하면 <b>자료 제목</b>을 적고 <b>내용 한장정리 만들기</b>를 누릅니다. " +
        "<b>🖼️ 요약 이미지</b>의 <b>만들 때 함께 넣기</b>를 체크하면 고른 종류(한글요약 인포그래픽·4컷 그림 등)의 그림도 지문마다 한 장 들어갑니다(그림 값 따로).",
      "화면에서 내용을 확인하고, 고칠 곳은 <b>✏️ 직접 수정</b>으로 그 자리에서 고칩니다. " +
        "칸을 다른 쪽으로 옮기려면 <b>📄 쪽 구성</b>을 누르고 칸 위의 <b>⤵ 여기부터 2쪽으로 / ⤴ 1쪽으로 올리기</b>를 누릅니다(지문 위의 <b>↺ 쪽 나눔 자동으로</b>로 되돌립니다). " +
        "그림은 지문마다 위의 <b>🖼️ 요약 이미지 넣기 / 🔄 그림 다시 만들기 / 그림 빼기</b>로 더하거나 바꿉니다.",
      "<b>🖨️ 인쇄 / PDF 변환</b>으로 뽑거나, <b>💾 사이트 저장</b>으로 남겨 둡니다.",
    ],
    tip: "우리말 제목·한 줄 요약 / 알아 두면 쉬워지는 배경지식(분야·읽기 전 상식·개념 카드 — 한 줄 정의·쉬운 설명·이 글에서는, 상세분석의 배경지식과 같은 내용) / 차근차근 풀어 읽기(대목마다 문장 번호와 첫 낱말, 쉬운 설명) / 쉽게 말하면·글쓴이가 하고 싶은 말 / 스스로 확인하기(답 포함) · 요약 이미지(고른 경우). 영어 원문과 해석은 싣지 않습니다 — 해석은 상세분석·요약분석·리딩노트에서 만드세요. 지문마다 <b>두 쪽</b>입니다 — 첫 쪽은 배경지식부터 한마디로 정리하면까지, 둘째 쪽은 스스로 확인하기와 그림으로 보기. 글이 첫 쪽을 넘으면 글씨를 82%까지 줄이고, 마지막으로 덜 중요한 칸을 인쇄에서 뺍니다(화면에 흐리게 '인쇄 제외'로 보입니다). 둘째 쪽에 맞게 그림 크기는 저절로 조절됩니다. 그림이 없으면 스스로 확인하기가 첫 쪽에 들어갈 때 첫 쪽에 둡니다.",
  };
}

xpRender();
