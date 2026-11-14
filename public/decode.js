/* ══════ 리딩노트 (2026-11-02 사용자) ══════
   지문 하나 → A4 두 쪽짜리 정리 자료.
     1쪽: 본문과 해석(원문 아래 전체 해석) / 핵심 정리(제목·주제·글의 목적·흐름 세 줄) / 주요 어휘
     2쪽: 끊어 읽기 해석 — 문장마다 왼쪽 영어, 오른쪽 우리말 2단(영어 조각 / 우리말 조각을 같은 자리에서 끊는다)
   서버는 /api/decode(call_gemini_decode, Flash, 지문 1개당 PRICE_DECODE_KRW)이고 글자만 돌려준다 — 여기서 esc()로 넣는다.
   app.js 뒤에 로드되며 app.js의 전역($, esc, postGenerate, passageMgr, TAB_SAVE …)을 쓴다(grammar.js와 같은 방식).
   공용 지문칸을 그대로 쓴다. 결과 칸은 #dcResult 하나. */

const dcEl = (id) => document.getElementById(id);
// 이 탭의 이름 — 사이드바 단추·저장함·파일 이름이 함께 쓴다(이름을 바꾸면 index.html 단추 글자도 같이)
const DECODE_NAME = "리딩노트";
const dcState = {
  entries: [],   // [{name, text, data, error}] — data는 서버 응답(_finish_decode 모양)
  title: "",
  editing: false,
  busy: false,
};

const DC_POS_LABEL = { 명: "명", 동: "동", 형: "형", 부: "부", 전: "전", 접: "접", 숙: "숙어" };
// 4컷 그림 느낌 — 서버 DECODE_PIC_STYLES와 같은 열쇠
const DC_PIC_STYLES = { illust: "일러스트", webtoon: "웹툰" };
/* 4컷 그림 본체는 entry.picSrc(blob 주소, 화면에서만 산다)이고, 그림 느낌·컷 설명은 entry.data.pic({style, captions})에 담겨
   저장본 글에 함께 들어간다. 그림 본체는 저장할 때 /api/saved-image로 따로 올린다(요약 이미지와 같은 길). */
let dcBlobUrls = [];
function dcBlobUrl(b64, mime) {
  const bin = atob(b64);
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  const url = URL.createObjectURL(new Blob([bytes], { type: mime || "image/jpeg" }));
  dcBlobUrls.push(url);
  return url;
}
function dcDropBlobs(keep) {
  dcBlobUrls.filter((u) => !(keep && keep.has(u))).forEach((u) => URL.revokeObjectURL(u));
  dcBlobUrls = keep ? dcBlobUrls.filter((u) => keep.has(u)) : [];
}

/* ── 그리기 ── */
// 편집할 수 있는 칸에는 data-f로 자리(data 안의 경로)를 적어 둔다 — 고친 글을 저장할 때 그 자리로 되돌려 넣는다(dcHarvest)
const dcEd = (f, text, tag = "span", cls = "") =>
  `<${tag} class="dc-ed${cls ? " " + cls : ""}" data-f="${f}">${esc(text || "")}</${tag}>`;

/* 모양은 참고한 교재(분홍 둥근 틀 · 알약 소제목 · 원문/해석 좌우)와 일부러 다르게 짰다(2026-11-03 사용자):
   머리 = 영문 머리글 + 제목 / 소제목 = 번호 + 영문 머리글 + 가는 줄 / 원문 아래 해석 / 핵심 정리 = 제목 띠 + 주제·목적 두 칸 + 흐름 세 칸 /
   어휘 = 외웠는지 표시하는 네모가 붙은 세 줄 목록 / 끊어 읽기 = 문장마다 왼쪽 영어, 오른쪽 우리말 2단(2026-11-05 사용자), 우리말 칸 바탕은 꾸미기 색 */
function dcHeadHtml(name, page) {
  return `<header class="dc-head"><div class="dc-head-l"><span class="dc-kicker">READING NOTE${page > 1 ? " · " + page : ""}</span>` +
    `<span class="dc-head-title">${esc(dcState.title || DECODE_NAME)}</span></div>` +
    `<span class="dc-head-name">${esc(name)}</span></header>`;
}

const dcSecHead = (no, en, ko) =>
  `<h4 class="dc-h"><span class="dc-h-no">${no}</span><span class="dc-h-en">${en}</span><span class="dc-h-ko">${ko}</span></h4>`;

function dcSheetHtml(e, i) {
  if (e.error || !e.data) {
    return `<section class="passage-block dc-sheet" data-i="${i}"><div class="passage-error">` +
      `⚠️ ${esc(e.name)} — ${esc(e.error || "만들지 못했습니다.")} (이 지문의 값은 나가지 않았습니다)</div></section>`;
  }
  const d = e.data;
  const sents = d.sentences || [];
  // 원문은 선생님이 넣은 지문 그대로 — 조각을 이어 붙인 것보다 정확하다(문단 나눔도 남는다)
  const enHtml = esc(e.text).split(/\n\s*\n/).map((p) => `<p>${p.replace(/\n/g, " ")}</p>`).join("");
  const koHtml = sents.map((s, k) => dcEd(`s.${k}.ko`, s.ko)).join(" ");
  const flow = (d.summary || []).map((t, k) =>
    `<div class="dc-step"><span class="dc-step-no">${k + 1}</span>${dcEd(`sum.${k}`, t)}</div>`).join("");
  const words = (d.vocab || []).map((v, k) =>
    `<div class="dc-w"><span class="dc-chk" aria-hidden="true"></span>` +
    `<span class="dc-w-body">${dcEd(`voc.${k}.word`, v.word, "span", "dc-w-word")}` +
    `${v.pos ? `<span class="dc-w-pos">${esc(DC_POS_LABEL[v.pos] || v.pos)}</span>` : ""}` +
    `${dcEd(`voc.${k}.meaning`, v.meaning, "span", "dc-w-mean")}</span></div>`).join("");
  const lines = sents.map((s, k) => {
    const en = (s.chunks || []).map((c, j) => dcEd(`c.${k}.${j}.en`, c.en)).join('<span class="dc-sl">/</span>');
    const ko = (s.chunks || []).map((c, j) => dcEd(`c.${k}.${j}.ko`, c.ko)).join('<span class="dc-sl">/</span>');
    return `<li class="dc-s"><span class="dc-s-no">${String(k + 1).padStart(2, "0")}</span>` +
      `<div class="dc-s-body"><div class="dc-s-en">${en}</div><div class="dc-s-ko">${ko}</div></div></li>`;
  }).join("");
  // 4컷 — 2×2 한 장을 칸마다 잘라 보인다. 컷 사이 흰 줄이 비치지 않게 칸보다 조금 크게(206%) 놓고 가운데를 쓴다
  const pic = e.picSrc && d.pic && Array.isArray(d.pic.captions) ? d.pic : null;
  const cuts = pic ? [0, 1, 2, 3].map((j) =>
    `<figure class="dc-cut"><div class="dc-cut-img"><img src="${e.picSrc}" alt="" ` +
    `style="left:${-((j % 2) * 103 + 1.5)}%;top:${-(Math.floor(j / 2) * 103 + 1.5)}%"></div>` +
    `<figcaption><b>${j + 1}</b>${dcEd(`pic.${j}`, pic.captions[j] || "")}</figcaption></figure>`).join("") : "";
  const tools = `<div class="dc-tools">` +
    (pic ? `<button type="button" class="btn ghost small" data-act="pic">🔄 그림 다시 그리기</button>` +
      `<button type="button" class="btn ghost small" data-act="nopic">그림 빼기</button>`
      : `<button type="button" class="btn ghost small" data-act="pic">🖼️ 4컷 그림 넣기</button>`) +
    (e.picError ? `<span class="dc-tools-err">⚠️ ${esc(e.picError)}</span>` : "") + `</div>`;
  return `<section class="passage-block dc-sheet" data-i="${i}">
    ${tools}
    <div class="dc-fitnote" hidden></div>
    <div class="dc-page">
      ${dcHeadHtml(e.name, 1)}
      <div class="dc-sec">${dcSecHead("01", "PASSAGE", "본문과 해석")}
        <div class="dc-passage">${enHtml}</div>
        <div class="dc-trans">${koHtml}</div>
      </div>
      <div class="dc-sec">${dcSecHead("02", "KEY POINTS", "핵심 정리")}
        <div class="dc-titlecard">${dcEd("englishTitle", d.englishTitle, "div", "dc-tc-en")}${dcEd("koreanTitle", d.koreanTitle, "div", "dc-tc-ko")}</div>
        <div class="dc-pair">
          <div class="dc-card"><span class="dc-card-lab">주제</span>${dcEd("topic", d.topic, "div")}</div>
          <div class="dc-card"><span class="dc-card-lab">글의 목적</span>${dcEd("purpose", d.purpose, "div")}</div>
        </div>
        ${flow ? `<div class="dc-flow-lab">흐름 세 줄</div><div class="dc-flow">${flow}</div>` : ""}
      </div>
      ${words ? `<div class="dc-sec dc-sec-words">${dcSecHead("03", "WORDS", "주요 어휘")}<div class="dc-words">${words}</div></div>` : ""}
    </div>
    <div class="dc-page dc-page2">
      ${dcHeadHtml(e.name, 2)}
      <div class="dc-sec-flow">${dcSecHead("04", "LINE BY LINE", "끊어 읽기 해석")}
        <ol class="dc-lbl">${lines}</ol>
      </div>
      ${cuts ? `<div class="dc-sec dc-sec-pic">${dcSecHead("05", "PICTURE", "그림으로 기억하기")}<div class="dc-cuts">${cuts}</div></div>` : ""}
    </div>
  </section>`;
}

function dcRender() {
  const ok = dcState.entries.some((e) => e.data);
  dcEl("dcResult").innerHTML = dcState.entries.map(dcSheetHtml).join("");
  ["dcPrintBtn", "dcEditBtn", "dcSaveBtn"].forEach((id) => { dcEl(id).style.display = ok ? "" : "none"; });
  dcEl("dcPicBtn").style.display = dcState.entries.some((e) => e.data && !e.picSrc) ? "" : "none";
  dcSetEditing(dcState.editing && ok);
  dcFitSoon();
  if (typeof syncFloatPrint === "function") syncFloatPrint();
}

/* ── 인쇄 2쪽 맞추기(2026-11-03 사용자) ──
   지문 길이보다 해석·목적 글 길이에 따라 1쪽이 넘쳐, 주요 어휘만 다음 쪽으로 밀려 거의 빈 쪽이 생겼다
   (152단어 지문에서도 났다). 화면에서 인쇄 폭(.dc-measure — style.css에 인쇄 규칙과 같은 값)으로 쪽마다 높이를 재서
   ① 그대로 ② 그 지문만 글씨 94% ③ 주요 어휘를 2쪽 맨 위로 ④ ③+94% ⑤ 어휘는 1쪽 그대로 글씨 88% ⑥ ③+88% 차례로
   (바뀌는 것이 적은 쪽부터), 두 쪽이 모두 들어가는 첫 모양을 고른다.
   쪽 높이는 다른 탭과 같은 PAGE_H_MM(아래 학원 마크 줄을 뺀 높이)에서 3mm를 더 남긴다. 화면에도 같은 모양으로 보인다.
   4컷 그림은 **늘 가로 한 줄**로 둔다(2026-11-03 사용자 — 3쪽에 2×2로 크게 넣었더니 쪽 낭비가 심했다). 글 모양을 차례로 돌며
   그림을 2쪽 끝(100 → 80 → 65%)에 먼저 넣어 보고, 어느 글 모양으로도 안 될 때만 1쪽 빈자리, 그래도 안 되면 한 줄 그대로 3쪽에 둔다.
   **그림이 1쪽으로 가면 그림이 어휘·끊어 읽기보다 앞에 놓여 순서가 무너지므로 마지막 수단이다**(2026-11-06 사용자 — 16문장 지문이
   '본문 → 그림 | 어휘 → 끊어 읽기'로 나왔다. 어휘 1쪽 + 88%가 없어 맞는 모양이 있는데도 1쪽으로 갔다).
   **끊어 읽기 영어 줄간격도 여기서 고른다**(2026-11-14 사용자 — 수업 중 줄 사이에 설명을 써 넣는다): 넓게(2.5배, 기본) → 보통(data-lh="m", 2.1배)
   → 예전 모양(data-lh="s", 1.7배 + 영어:우리말 반반 칸) 차례로, 줄간격마다 위의 글 모양 × 그림 2쪽 자리를 해 본다(글씨 88%는 예전 줄간격에서만). 그림을 1쪽·3쪽으로 옮기는 것은 예전 줄간격으로도
   안 될 때만이다 — 그래서 쪽 수·그림 자리는 줄간격을 넓히기 전보다 나빠지지 않는다(영어:우리말 칸도 3:2로 바꿔 예전보다 짧다).
   **끊어 읽기가 넓은 줄간격·글씨 그대로 2쪽 한 장(그림 없이)에도 안 들어가는 장문은 3쪽으로 이어 싣는다**(2026-11-14 사용자 —
   고2 10월 모의고사 41~42번 1,327자를 2쪽에 맞추느라 줄간격 1.7배·그림 65%가 됐다). 실측으로 대략 원문 1,150자(공백 포함)를 넘는 지문이다
   (끊어 읽기 높이 ≈ 글자 수 × 0.12mm + 문장 수 × 8.7mm + 12mm, 2쪽에서 끊어 읽기 자리 약 240mm · 4컷 그림을 함께 두면 약 180mm = 약 850자).
   그때는 2쪽에 들지 않는 문장(dcSplitFlow)을 3쪽 앞으로 넘기고 그림은 3쪽 끝에 둔다. 3쪽으로도 모자라면 위와 같은 차례로 줄간격·글씨·그림을 줄인다.
   판정은 글자 수가 아니라 화면에서 잰 높이로 한다(글자 수는 선생님께 알리는 어림값).
   소제목 번호는 맞춘 뒤 쪽 차례대로 다시 매긴다. */
const DC_LINE_STEPS = ["", "m", "s"];   // style.css의 .dc-sheet[data-lh] — 인쇄·.dc-measure 두 곳
const DC_PIC_KEEP = [["p2", ""], ["p2", "80"], ["p2", "65"]];     // 순서가 그대로인 자리
const DC_PIC_SPARE = [["p1", ""], ["p1", "80"], ["p1", "65"]];    // 순서가 바뀌는 자리 — 마지막 수단
const DC_FIT_STEPS = [[false, ""], [false, "94"], [true, ""], [true, "94"], [false, "88"], [true, "88"]];
// 3쪽으로 이을 때는 어휘를 2쪽으로 옮겨도 자리가 3쪽으로 밀릴 뿐이라 글씨를 줄이는 것보다 먼저 한다(41~42번이 1쪽 때문에 94%가 됐다)
const DC_FIT_STEPS_THREE = [[false, ""], [true, ""], [false, "94"], [true, "94"], [false, "88"], [true, "88"]];

function dcPlaceWords(sheet, toPage2) {
  const w = sheet.querySelector(".dc-sec-words");
  if (!w) return;
  if (toPage2) {
    const flow = sheet.querySelector(".dc-sec-flow");
    flow.parentNode.insertBefore(w, flow);
  } else {
    sheet.querySelector(".dc-page").appendChild(w);
  }
}

// 그림 자리 — "p1"(1쪽 끝) · "p2"(2쪽 끝) · "p3"(3쪽, 안 될 때만). 3쪽은 그때만 만든다(빈 쪽이 인쇄되지 않게)
function dcPlacePic(sheet, where) {
  const pic = sheet.querySelector(".dc-sec-pic");
  let p3 = sheet.querySelector(":scope > .dc-page3");
  if (!pic) return;
  if (where === "p3") {
    if (!p3) {
      const e = dcState.entries[Number(sheet.dataset.i)] || {};
      sheet.insertAdjacentHTML("beforeend", `<div class="dc-page dc-page3">${dcHeadHtml(e.name || "", 3)}</div>`);
      p3 = sheet.querySelector(":scope > .dc-page3");
    }
    p3.appendChild(pic);
    return;
  }
  sheet.querySelector(where === "p1" ? ".dc-page" : ".dc-page2").appendChild(pic);
  if (p3) p3.remove();
}

// 3쪽(머리만 있는 빈 쪽)을 만든다 — 이미 있으면 그대로
function dcEnsurePage3(sheet) {
  let p3 = sheet.querySelector(":scope > .dc-page3");
  if (!p3) {
    const e = dcState.entries[Number(sheet.dataset.i)] || {};
    sheet.insertAdjacentHTML("beforeend", `<div class="dc-page dc-page3">${dcHeadHtml(e.name || "", 3)}</div>`);
    p3 = sheet.querySelector(":scope > .dc-page3");
  }
  return p3;
}
// 3쪽으로 넘긴 끊어 읽기 문장을 2쪽으로 되돌린다(다시 잴 때마다 나누기 전 모양에서 시작)
function dcJoinFlow(sheet) {
  const cont = sheet.querySelector(".dc-flow-cont");
  if (!cont) return;
  const ol = sheet.querySelector(".dc-page2 .dc-sec-flow .dc-lbl");
  cont.querySelectorAll(".dc-s").forEach((li) => ol.appendChild(li));
  cont.remove();
}
// 2쪽에 들지 않는 끊어 읽기 문장을 뒤에서부터 3쪽 맨 앞(그림보다 앞)으로 넘긴다 — 문장 한 줄은 쪽 사이에서 자르지 않는다
function dcSplitFlow(sheet, limit) {
  const p2 = sheet.querySelector(".dc-page2");
  const ol = p2.querySelector(".dc-sec-flow .dc-lbl");
  const p3 = dcEnsurePage3(sheet);
  let cont = p3.querySelector(".dc-flow-cont");
  if (!cont) {
    p3.querySelector(".dc-head").insertAdjacentHTML("afterend", `<div class="dc-flow-cont"><ol class="dc-lbl"></ol></div>`);
    cont = p3.querySelector(".dc-flow-cont");
  }
  const ol3 = cont.querySelector(".dc-lbl");
  while (p2.getBoundingClientRect().height > limit && ol.children.length > 1) ol3.prepend(ol.lastElementChild);
}

// 소제목 번호를 쪽 차례대로 01, 02 … 로 다시 매긴다(어휘·그림이 쪽을 옮겨 다니므로)
function dcRenumber(sheet) {
  sheet.querySelectorAll(".dc-h-no").forEach((el, k) => { el.textContent = String(k + 1).padStart(2, "0"); });
}

function dcFit() {
  const host = dcEl("dcResult");
  if (!host.offsetParent || typeof PAGE_H_MM === "undefined") return;   // 탭이 숨어 있으면 못 잰다 — 탭을 열 때 다시
  const sheets = [...host.querySelectorAll(".dc-sheet")].filter((s) => s.querySelector(".dc-page"));
  if (!sheets.length) return;
  const limit = (PAGE_H_MM - 3) * PX_PER_MM;
  host.classList.add("dc-measure");
  sheets.forEach((sheet) => {
    const fits = () => [...sheet.querySelectorAll(":scope > .dc-page")]
      .every((p) => p.getBoundingClientRect().height <= limit);
    const hasPic = !!sheet.querySelector(".dc-sec-pic");
    let picP3 = false;
    // 지난번에 3쪽으로 나눴으면 되돌리고 시작한다
    dcJoinFlow(sheet);
    if (hasPic) dcPlacePic(sheet, "p2");   // 3쪽이 있으면 함께 지운다
    else sheet.querySelector(":scope > .dc-page3")?.remove();
    sheet.dataset.pic = "";
    // 장문인지 — 넓은 줄간격·글씨 그대로, 어휘 1쪽, 그림을 뺀 2쪽에 끊어 읽기가 안 들어가면 3쪽으로 잇는다
    sheet.dataset.lh = "";
    sheet.dataset.fit = "";
    dcPlaceWords(sheet, false);
    if (hasPic) dcPlacePic(sheet, "p3");
    const three = sheet.querySelector(".dc-page2").getBoundingClientRect().height > limit;
    if (hasPic) dcPlacePic(sheet, "p2");
    // 글 모양마다 그림 자리들을 넣어 보고 처음 맞는 글 모양을 돌려준다
    // 글씨 88%는 줄간격을 가장 좁혔을 때만 — 88%는 1쪽 본문까지 함께 작아져, 줄간격을 지키려고 쓰기에는 손해가 크다
    // (2026-11-14 고2 10월 모의고사 40번이 넓은 줄간격 + 글씨 88%로 나왔다)
    const tryAll = (spots) => {
      const last = (sheet.dataset.lh || "") === DC_LINE_STEPS[DC_LINE_STEPS.length - 1];
      for (const [toPage2, fit] of DC_FIT_STEPS) {
        if (fit === "88" && !last) continue;
        dcPlaceWords(sheet, toPage2);
        sheet.dataset.fit = fit;
        for (const [where, size] of spots) {
          dcPlacePic(sheet, where);
          sheet.dataset.pic = size;
          if (fits()) return [toPage2, fit];
        }
      }
      return null;
    };
    // 줄간격을 넓은 것부터 — 그림은 2쪽 자리만. 그래도 안 되면 가장 좁은 줄간격(예전 값)으로 1쪽·3쪽 자리를 본다
    // 3쪽으로 이을 때 — 줄간격 넓은 것부터, 글 모양(어휘 자리·글씨) × 그림 크기(3쪽 끝)를 해 본다
    const tryThree = () => {
      const lastLh = DC_LINE_STEPS[DC_LINE_STEPS.length - 1];
      for (const lh of DC_LINE_STEPS) {
        sheet.dataset.lh = lh;
        for (const [toPage2, fit] of DC_FIT_STEPS_THREE) {
          if (fit === "88" && lh !== lastLh) continue;
          dcPlaceWords(sheet, toPage2);
          sheet.dataset.fit = fit;
          for (const size of hasPic ? ["", "80", "65"] : [""]) {
            sheet.dataset.pic = size;
            dcJoinFlow(sheet);
            if (hasPic) dcPlacePic(sheet, "p3");
            dcSplitFlow(sheet, limit);
            if (fits()) return [toPage2, fit];
          }
        }
      }
      return null;
    };
    let step = null;
    if (three) {
      step = tryThree();
      if (!step) {
        // 3쪽으로도 모자라면 가장 줄인 모양으로 두고 넘치는 만큼 인쇄가 한 쪽 더 넘어간다
        sheet.dataset.lh = DC_LINE_STEPS[DC_LINE_STEPS.length - 1];
        sheet.dataset.fit = "88";
        sheet.dataset.pic = "";
        dcPlaceWords(sheet, true);
        dcJoinFlow(sheet);
        if (hasPic) dcPlacePic(sheet, "p3");
        dcSplitFlow(sheet, limit);
      }
      // 줄인 모양에서 문장이 모두 2쪽에 들면 3쪽의 빈 칸(그림도 없으면 쪽째)을 치운다 — 빈 쪽이 인쇄되지 않게
      const cont = sheet.querySelector(".dc-flow-cont");
      if (cont && !cont.querySelector(".dc-s")) cont.remove();
      const p3 = sheet.querySelector(":scope > .dc-page3");
      if (p3 && !p3.querySelector(".dc-s, .dc-sec-pic")) p3.remove();
    } else {
      for (const lh of DC_LINE_STEPS) {
        sheet.dataset.lh = lh;
        step = tryAll(hasPic ? DC_PIC_KEEP : [["p2", ""]]);
        if (step) break;
      }
      if (!step && hasPic) step = tryAll(DC_PIC_SPARE);
    }
    if (!step && hasPic && !three) {
      // 어느 모양으로도 안 들어가면 그림만 한 줄 그대로 3쪽에 둔다 — 글은 그림 없이 맞춘다
      sheet.dataset.pic = "";
      dcPlacePic(sheet, "p3");
      picP3 = true;
      // 2쪽이 끊어 읽기만으로 비므로 줄간격은 다시 넓은 것부터
      for (const lh of DC_LINE_STEPS) {
        sheet.dataset.lh = lh;
        for (const [toPage2, fit] of DC_FIT_STEPS) {
          if (fit === "88" && lh !== DC_LINE_STEPS[DC_LINE_STEPS.length - 1]) continue;
          dcPlaceWords(sheet, toPage2);
          sheet.dataset.fit = fit;
          if (fits()) { step = [toPage2, fit]; break; }
        }
        if (step) break;
      }
    }
    dcRenumber(sheet);
    const note = sheet.querySelector(".dc-fitnote");
    const parts = [];
    const pages = three ? "3쪽" : "2쪽";
    if (three) parts.push(`📄 끊어 읽기가 길어 3쪽까지 이어 싣습니다${hasPic ? "(4컷 그림은 3쪽 끝)" : ""}.`);
    if (!step) parts.push(`⚠️ 글이 길어 ${pages}에 다 들어가지 않아 한 쪽 더 넘어갑니다 — 🎨 꾸미기의 글자 크기를 줄이거나 ✏️ 직접 수정으로 해석을 줄여 보세요.`);
    else if (step[0] && step[1]) parts.push(`📏 인쇄 ${pages}에 맞추려고 주요 어휘를 2쪽 위로 옮기고 이 지문만 글씨를 ${step[1]}%로 줄였습니다.`);
    else if (step[1]) parts.push(`📏 인쇄 ${pages}에 맞추려고 이 지문만 글씨를 ${step[1]}%로 줄였습니다.`);
    else if (step[0]) parts.push(`📏 인쇄 ${pages}에 맞추려고 주요 어휘를 2쪽 위로 옮겼습니다.`);
    if (sheet.dataset.lh) parts.push(`✏️ ${pages}에 맞추려고 끊어 읽기 영어 줄간격을 ${sheet.dataset.lh === "m" ? "조금" : "예전만큼"} 좁혔습니다.`);
    if (three) { if (sheet.dataset.pic) parts.push(`🖼️ 4컷 그림을 ${sheet.dataset.pic}% 크기로 줄여 넣었습니다.`); }
    else if (picP3) parts.push("🖼️ 4컷 그림은 자리가 모자라 3쪽에 넣었습니다 — 2쪽 안에 넣으려면 🎨 꾸미기의 글자 크기를 줄여 보세요.");
    else if (hasPic && !sheet.querySelector(".dc-page2 .dc-sec-pic")) {
      parts.push(`🖼️ 2쪽에 자리가 모자라 4컷 그림을 1쪽에 넣었습니다${sheet.dataset.pic ? `(${sheet.dataset.pic}% 크기)` : ""} — 그림이 끊어 읽기보다 앞에 옵니다.`);
    } else if (sheet.dataset.pic) parts.push(`🖼️ 4컷 그림을 ${sheet.dataset.pic}% 크기로 줄여 넣었습니다.`);
    note.textContent = parts.join(" ");
    note.hidden = !parts.length;
  });
  host.classList.remove("dc-measure");
}
// 그리고 난 뒤·글꼴을 받은 뒤 잰다(글꼴이 늦게 오면 줄바꿈이 바뀐다)
function dcFitSoon() {
  requestAnimationFrame(dcFit);
  if (document.fonts && document.fonts.ready) document.fonts.ready.then(() => requestAnimationFrame(dcFit));
}

/* ── 직접 수정 ── */
function dcSetEditing(on) {
  dcState.editing = !!on;
  dcEl("dcResult").classList.toggle("dc-editing", dcState.editing);
  dcEl("dcResult").querySelectorAll(".dc-ed").forEach((el) => {
    if (dcState.editing) el.setAttribute("contenteditable", "true");
    else el.removeAttribute("contenteditable");
  });
  dcEl("dcEditBtn").textContent = dcState.editing ? "✅ 수정 끝내기" : "✏️ 직접 수정";
}

// 화면에서 고친 글을 data로 되돌려 넣는다 — 저장·다시 그리기 전에 부른다
function dcHarvest() {
  dcEl("dcResult").querySelectorAll(".dc-sheet").forEach((sheet) => {
    const e = dcState.entries[Number(sheet.dataset.i)];
    if (!e || !e.data) return;
    sheet.querySelectorAll(".dc-ed[data-f]").forEach((el) => {
      const val = el.innerText.replace(/\s+/g, " ").trim();
      const p = el.dataset.f.split(".");
      const d = e.data;
      if (p.length === 1) d[p[0]] = val;
      else if (p[0] === "sum" && d.summary) d.summary[+p[1]] = val;
      else if (p[0] === "pic" && d.pic && Array.isArray(d.pic.captions)) d.pic.captions[+p[1]] = val;
      else if (p[0] === "voc" && d.vocab && d.vocab[+p[1]]) d.vocab[+p[1]][p[2]] = val;
      else if (p[0] === "s" && d.sentences && d.sentences[+p[1]]) d.sentences[+p[1]].ko = val;
      else if (p[0] === "c" && d.sentences && d.sentences[+p[1]]) {
        const c = (d.sentences[+p[1]].chunks || [])[+p[2]];
        if (c) c[p[3]] = val;
      }
    });
  });
}

dcEl("dcEditBtn").addEventListener("click", () => {
  const wasEditing = dcState.editing;
  if (wasEditing) dcHarvest();
  dcSetEditing(!wasEditing);
  if (wasEditing) dcFitSoon();   // 글 길이가 바뀌었을 수 있다
});

/* ── 값 안내 ── */
const dcPicOn = () => dcEl("dcPicChk").checked;
const dcPicStyle = () => (document.querySelector('input[name="dcPicStyle"]:checked') || {}).value || "illust";
// 웹툰 말풍선 말 — 한국어·영어(서버 DECODE_PIC_BUBBLE_RULES와 같은 열쇠). 일러스트면 서버가 쓰지 않는다
const dcPicBubble = () => (document.querySelector('input[name="dcPicBubble"]:checked') || {}).value || "ko";
const dcPicPrice = () => (typeof PRICING !== "undefined" && PRICING && Number.isFinite(PRICING.decodePic) ? PRICING.decodePic : null);
function dcCost(n, withPic) {
  if (typeof PRICING === "undefined" || !PRICING || !Number.isFinite(PRICING.decode)) return null;
  const pic = withPic ? dcPicPrice() : 0;
  return pic === null ? null : (PRICING.decode + pic) * n;
}
function dcJobs() {
  return passageMgr.getJobs().filter((j) => j.text && j.text.length >= 20);
}
function dcSyncCost() {
  const n = dcJobs().length;
  const withPic = dcPicOn();
  const cost = dcCost(n, withPic);
  dcEl("dcCostHint").innerHTML = n && cost !== null
    ? `예상 비용 <b>${pt(cost)}</b> (지문 ${n}개 × ${pt(PRICING.decode)}${withPic ? ` + 4컷 그림 ${n}세트(지문마다 1세트) × ${pt(dcPicPrice())}` : ""})` : "";
  const pp = dcPicPrice();
  dcEl("dcPicPrice").textContent = pp !== null ? `4컷 한 세트(지문 1개)에 ${pt(pp)}입니다 — 컷마다 따로 받지 않습니다.` : "";
}
dcEl("dcPicChk").addEventListener("change", dcSyncCost);
if (typeof onPricingReady === "function") onPricingReady(dcSyncCost);
document.addEventListener("input", (e) => {
  if (e.target.closest && e.target.closest(".passage-panel")) dcSyncCost();
});
document.querySelector('.tab-btn[data-tab="decode"]').addEventListener("click", () => { dcSyncCost(); dcFitSoon(); });

/* ── 4컷 그림 그리기 ── 실패해도 글 자료는 그대로 두고 그 지문 위에 이유만 적는다(값은 서버가 성공했을 때만 받는다) */
async function dcDrawPic(e, style, onRetry) {
  e.picError = "";
  try {
    const r = await postGenerate("/api/decodepic", { passage: e.text, style, bubble: dcPicBubble() },
      "4컷 그림을 그리지 못했습니다.", onRetry);
    e.data.pic = { style: r.style || style, captions: (r.captions || []).slice(0, 4) };
    e.picSrc = dcBlobUrl(r.image, r.mime);
    return true;
  } catch (err) {
    e.picError = err.message || String(err);
    if (err.code === "quota" || err.code === "no_tokens") throw err;
    return false;
  }
}

// 여러 지문에 차례로 그린다(목록의 [🖼️ 4컷 그림 넣기]와 지문마다의 단추가 같이 쓴다)
async function dcDrawPics(list) {
  const errEl = dcEl("dcError");
  errEl.textContent = "";
  if (!list.length) return;
  const style = dcPicStyle();
  const each = dcPicPrice();
  if (!(await costConfirmed(each === null ? null : each * list.length,
    `${DECODE_NAME} 4컷 그림(${DC_PIC_STYLES[style]}) · ${list.length}세트(지문마다 1세트)`, list.length))) return;
  if (dcState.editing) { dcHarvest(); dcSetEditing(false); }
  dcState.busy = true;
  dcEl("dcMakeBtn").disabled = dcEl("dcPicBtn").disabled = true;
  const loading = dcEl("dcLoading");
  const text = dcEl("dcLoadingText");
  loading.classList.add("on");
  try {
    for (let i = 0; i < list.length; i++) {
      text.textContent = `AI가 ${list[i].name}의 4컷 그림을 그리고 있습니다… (${i + 1}/${list.length})`;
      try {
        await dcDrawPic(list[i], style, (n) => { text.textContent = `연결이 끊겨 다시 받아 오는 중… (${n})`; });
      } catch (err) {
        errEl.textContent = err.message;
        break;
      }
      dcRender();
    }
    dcRender();
  } finally {
    dcState.busy = false;
    dcEl("dcMakeBtn").disabled = dcEl("dcPicBtn").disabled = false;
    loading.classList.remove("on");
    refreshTokenDisplay();
  }
}
dcEl("dcPicBtn").addEventListener("click", () => {
  if (dcState.busy) return;
  if (dcState.editing) dcHarvest();
  dcDrawPics(dcState.entries.filter((e) => e.data && !e.picSrc));
});
// 지문마다의 단추 — 그림 넣기·다시 그리기 / 그림 빼기
dcEl("dcResult").addEventListener("click", (ev) => {
  const b = ev.target.closest(".dc-tools button[data-act]");
  if (!b || dcState.busy) return;
  const e = dcState.entries[Number(b.closest(".dc-sheet").dataset.i)];
  if (!e || !e.data) return;
  if (dcState.editing) dcHarvest();
  if (b.dataset.act === "pic") {
    dcDrawPics([e]);
  } else if (b.dataset.act === "nopic") {
    if (!confirm("이 지문의 4컷 그림을 뺄까요? 다시 넣으려면 새로 그려야 합니다(값이 다시 나갑니다).")) return;
    delete e.data.pic;
    e.picSrc = "";
    e.picError = "";
    dcRender();
  }
});

/* ── 만들기 ── */
async function dcMake() {
  const errEl = dcEl("dcError");
  errEl.textContent = "";
  const jobs = dcJobs();
  if (!jobs.length) {
    errEl.textContent = "위쪽 영어 지문 칸에 지문을 넣어 주세요 (20자 이상).";
    return;
  }
  const withPic = dcPicOn();
  const style = dcPicStyle();
  if (!(await costConfirmed(dcCost(jobs.length, withPic),
    `${DECODE_NAME} · 지문 ${jobs.length}개${withPic ? ` + 4컷 그림(${DC_PIC_STYLES[style]}) ${jobs.length}세트(지문마다 1세트)` : ""}`,
    jobs.length, reduceAdvice(jobs.length, withPic ? "4컷 그림을 빼면" : "")))) return;
  if (typeof dropStaleSavedLink === "function") dropStaleSavedLink("decode");
  dcState.busy = true;
  dcEl("dcMakeBtn").disabled = true;
  const loading = dcEl("dcLoading");
  const text = dcEl("dcLoadingText");
  const gate = runGate(loading);
  gate.begin();
  loading.classList.add("on");
  dcState.entries = [];
  dcState.editing = false;
  dcDropBlobs();
  dcRender();
  let ok = 0;
  try {
    for (let i = 0; i < jobs.length; i++) {
      if (i && await gate.check(`지문 ${i}개까지 만들었습니다.`, dcRender)) {
        errEl.textContent = runEndedNote(jobs.length - i, "지문");
        break;
      }
      const j = jobs[i];
      text.textContent = `AI가 ${j.name}의 리딩노트를 만들고 있습니다… (${i + 1}/${jobs.length})`;
      try {
        const data = await postGenerate("/api/decode", { passage: j.text }, "리딩노트를 만들지 못했습니다.",
          (n) => { text.textContent = `연결이 끊겨 다시 받아 오는 중… (${n})`; });
        const entry = { name: j.name, text: j.text, data };
        dcState.entries.push(entry);
        ok++;
        if (withPic) {
          dcRender();
          text.textContent = `AI가 ${j.name}의 4컷 그림을 그리고 있습니다… (${i + 1}/${jobs.length})`;
          // 그림은 실패해도 글 자료는 남긴다. 한도 소진·잔액 부족이면 여기서 멈춘다
          const stop = await dcDrawPic(entry, style, (n) => { text.textContent = `연결이 끊겨 다시 받아 오는 중… (${n})`; })
            .then(() => false, (err) => { errEl.textContent = err.message; return true; });
          if (stop) { dcRender(); break; }
        }
      } catch (err) {
        dcState.entries.push({ name: j.name, text: j.text, data: null, error: err.message || String(err) });
        // 한도 소진·잔액 부족은 다음 지문도 같은 답이다 — 거기서 멈춘다
        if (err.code === "quota" || err.code === "no_tokens") {
          errEl.textContent = err.message;
          break;
        }
      }
      dcRender();
    }
    if (typeof LOADED_SAVED !== "undefined" && !ok) delete LOADED_SAVED.decode;
    dcRender();
    if (ok) showDoneGuide(`지문 ${ok}개의 ${DECODE_NAME}`, true);
  } finally {
    dcState.busy = false;
    dcEl("dcMakeBtn").disabled = false;
    loading.classList.remove("on");
    refreshTokenDisplay();
  }
}
dcEl("dcMakeBtn").addEventListener("click", () => { if (!dcState.busy) dcMake(); });

/* ── 인쇄·저장 ── */
dcEl("dcTitle").addEventListener("input", (e) => {
  dcState.title = e.target.value.trim();
  dcEl("dcResult").querySelectorAll(".dc-head-title").forEach((el) => { el.textContent = dcState.title || DECODE_NAME; });
});
const dcTitleHandle = {
  get: () => dcState.title,
  set: (v) => { dcState.title = String(v || "").trim(); dcEl("dcTitle").value = dcState.title; dcRender(); },
};
const dcFileName = () => sanitizeFilename(dcState.title || (dcState.entries[0] && dcState.entries[0].name) || "");
dcEl("dcPrintBtn").addEventListener("click", () => {
  if (dcState.editing) { dcHarvest(); dcSetEditing(false); }
  printDoc(() => ["리딩노트", dcFileName(), todayStr()].filter(Boolean).join("_"), { title: dcTitleHandle, before: dcFit });
});
dcEl("dcSaveBtn").addEventListener("click", () => openSaveDialog("decode"));
dcEl("dcLoadBtn").addEventListener("click", () => openSavedList("tab", null, "decode"));

// 꾸미기(테마 색·글자 크기·글꼴) — 다른 탭과 같은 한 벌(app.js createSheetStyle). 글자 크기 묶음은 "reading"(SHEET_FS).
// 색은 --accent(머리띠·소제목·번호·상자 테두리)만 바꾼다
const dcSheetStyle = createSheetStyle("dcSheetStyle", dcEl("dcResult"), "reading");
dcSheetStyle.onChange(dcFitSoon);   // 글꼴·글자 크기가 바뀌면 쪽 맞춤을 다시
const dcStyleTitle = dcEl("dcSheetStyle").querySelector(".sheet-style-title");
if (dcStyleTitle) dcStyleTitle.textContent = "🎨 리딩노트 꾸미기";

TAB_LABELS.decode = "📘 " + DECODE_NAME;
TAB_LIBRARY_WORDS.decode = {
  title: `📘 ${DECODE_NAME} 저장함`,
  lead: `저장해 둔 ${DECODE_NAME} 자료입니다. [불러오기]를 누르면 AI를 다시 부르지 않고 그대로 엽니다.`,
  empty: `아직 저장한 ${DECODE_NAME}${josa(DECODE_NAME, "이", "가")} 없습니다. 만든 뒤 “💾 사이트 저장”을 눌러 보세요.`,
};
SAVE_TITLE_SUGGEST.decode = () => dcState.title || passageBasedName("리딩노트");
TAB_SAVE.decode = {
  // saveBtn을 등록하지 않는다 — app.js가 단추를 연결한 뒤에 이 파일이 로드된다(grammar.js와 같다)
  canSave: () => (dcState.entries.some((e) => e.data) ? ""
    : `저장할 ${DECODE_NAME}${josa(DECODE_NAME, "이", "가")} 없습니다. 먼저 만들어 주세요.`),
  getPayload: () => {
    dcHarvest();
    const saved = dcState.entries.filter((e) => e.data);
    return {
      v: 1,
      passages: passageMgr.getJobs(),
      title: dcState.title,
      entries: saved.map((e) => ({ name: e.name, text: e.text, data: e.data })),
      // 4컷 그림은 목록만 — 본체는 저장한 뒤 afterSave가 한 장씩 올린다(저장본 문서 1MiB 한도)
      images: saved.map((e, i) => (e.picSrc && e.data.pic ? { entry: i, lang: e.data.pic.style || "", key: `p${i}` } : null))
        .filter(Boolean),
      sheetStyle: dcSheetStyle.get(),
    };
  },
  afterSave: async (itemId, payload, onProgress) => {
    const saved = dcState.entries.filter((e) => e.data);
    const todo = (payload.images || []).filter((m) => {
      const e = saved[m.entry];
      return e && e.picSrc && dcSavedSrc.get(itemId + "|" + m.key) !== e.picSrc;
    });
    let failed = 0;
    const reasons = new Set();
    if (onProgress && todo.length) onProgress(0, todo.length);
    for (let n = 0; n < todo.length; n++) {
      const m = todo[n];
      try {
        const src = saved[m.entry].picSrc;
        const fit = await fitImageForSave(await fetch(src).then((r) => r.blob()));
        await postJson("/api/saved-image", { id: itemId, key: m.key, mime: fit.mime, image: fit.b64 },
          "그림 저장에 실패했습니다.");
        dcSavedSrc.set(itemId + "|" + m.key, src);
      } catch (e) {
        failed++;
        reasons.add((e && e.message) || String(e));
      }
      if (onProgress) onProgress(n + 1, todo.length);
    }
    if (failed) throw new Error(`글은 저장됐지만 4컷 그림 ${failed}장은 저장하지 못했습니다 — ${[...reasons].join(" / ")} 다시 저장해 보세요.`);
  },
  afterLoad: async (itemId, payload) => {
    const metas = Array.isArray(payload.images) ? payload.images : [];
    let added = 0;
    for (const m of metas) {
      try {
        const d = await getJson(`/api/saved-image/${encodeURIComponent(itemId)}/${encodeURIComponent(m.key)}`, "");
        const e = dcState.entries[m.entry];
        if (d && d.image && e && e.data && e.data.pic) {
          e.picSrc = dcBlobUrl(d.image, d.mime || "image/jpeg");
          dcSavedSrc.set(itemId + "|" + m.key, e.picSrc);
          added++;
        }
      } catch (_e) { /* 이 그림만 건너뛴다 */ }
    }
    if (added) dcRender();
  },
  applyPayload: (payload) => {
    passageMgr.setJobs(payload.passages || []);
    if (payload.sheetStyle) dcSheetStyle.set(payload.sheetStyle);
    dcState.title = String(payload.title || "");
    dcEl("dcTitle").value = dcState.title;
    dcDropBlobs();
    dcState.entries = (payload.entries || []).filter((e) => e && e.data).map((e) => ({ ...e, picSrc: "" }));
    dcState.editing = false;
    dcEl("dcError").textContent = "";
    dcRender();
    dcSyncCost();
  },
  clearResults: () => {
    dcState.entries = [];
    dcState.editing = false;
    dcDropBlobs();
    dcEl("dcError").textContent = "";
    dcRender();
  },
};
// 저장본에 이미 올린 그림(저장본 id|key → 그때의 그림 주소) — 같은 그림을 다시 올리지 않는다
const dcSavedSrc = new Map();

/* 결과물 예시 — 탭 아래 '📄 결과물 예시'와 만드는 법 창이 함께 쓴다(app.js HOWTO_SAMPLE·TAB_SAMPLE_RESULT).
   그림(howto-decode-1·2·3.jpg — 3은 2쪽을 일러스트 4컷으로 바꾼 것)은 **다른 탭 예시와 다른 지문**(Sleep and Memory — 상세분석·요약분석 예시와 지문도 그림 느낌도 달라 보이게,
   2026-11-03 사용자)으로 실제로 만든 리딩노트(4컷 웹툰 포함)를 헤드리스 크롬으로 인쇄한 쪽이다. 리딩노트 모양을 눈에 띄게 바꾸면 다시 찍을 것 */
if (typeof HOWTO_SAMPLE !== "undefined") {
  HOWTO_SAMPLE.decode = () => samplePagesHtml("decode", [
    "1쪽 — 본문과 해석 · 핵심 정리 · 주요 어휘",
    "2쪽 — 끊어 읽기 해석 · 4컷 그림(웹툰)",
    "2쪽 — 같은 지문, 4컷 그림(일러스트)",
  ], "4컷 그림은 일러스트·웹툰 중에서 고릅니다 — 같은 지문을 두 느낌으로 그린 예시이고, 지문마다 장면이 새로 정해집니다.");
  TAB_SAMPLE_RESULT.decode = "dcResult";
}

if (typeof HOWTO !== "undefined") {
  HOWTO.decode = {
    title: `📘 ${DECODE_NAME} 만드는 법`,
    lead: "지문 하나로 A4 두 쪽짜리 복습 자료를 만듭니다 — 본문과 해석, 핵심 정리, 주요 어휘, 끊어 읽기 해석.",
    steps: [
      "위쪽 <b>영어 지문</b> 칸에 지문을 넣습니다(여러 개면 <b>＋ 지문 추가</b>). 지문 이름이 쪽 머리띠에 찍힙니다.",
      "필요하면 <b>자료 제목</b>을 적고 <b>리딩노트 만들기</b>를 누릅니다. " +
        "<b>🖼️ 4컷 그림</b>의 <b>만들 때 함께 넣기</b>를 체크하면 지문 흐름을 네 장면으로 그린 그림도 들어갑니다(일러스트·웹툰 중 고르기, 그림 값 따로).",
      "화면에서 내용을 확인하고, 고칠 곳은 <b>✏️ 직접 수정</b>으로 그 자리에서 고칩니다. " +
        "그림은 지문마다 위의 <b>🖼️ 4컷 그림 넣기 / 🔄 그림 다시 그리기 / 그림 빼기</b>로 더하거나 바꿉니다.",
      "<b>🖨️ 인쇄 / PDF 변환</b>으로 뽑거나, <b>💾 사이트 저장</b>으로 남겨 둡니다.",
    ],
    tip: "1쪽: 본문과 해석 · 핵심 정리(제목·주제·글의 목적·흐름 세 줄) · 주요 어휘(외웠는지 표시하는 네모) / 2쪽: 문장마다 왼쪽에 '/'로 끊은 영어, 오른쪽에 우리말(4컷 그림은 2쪽 아래). 끊어 읽기 영어는 줄 사이에 설명을 써 넣을 수 있게 줄간격을 넓게 두고, 지문이 길어 넘치면 줄간격·글씨를 조금 줄이거나 어휘·그림 자리를 옮겨 <b>알아서 두 쪽에 맞춥니다</b>. 끊어 읽기만으로 한 쪽이 넘는 장문(대략 1,150자 넘는 지문)은 줄이지 않고 <b>3쪽까지 이어 싣고</b> 4컷 그림은 3쪽 끝에 둡니다. 4컷 그림 값은 지문마다 1세트입니다. 🎨 꾸미기로 색·글자 크기·글꼴을 바꿀 수 있고, 고른 색은 끊어 읽기 우리말 칸의 바탕색에도 들어갑니다(요금 없음). 다른 지문으로 넘어갈 때는 지문 칸의 <b>[🆕 새로 만들기]</b>를 누르세요.",
  };
}

dcRender();
