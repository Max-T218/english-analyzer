/* ══════════════════════════ 시험지 분석 리포트 탭 ══════════════════════════
   기출 시험지(PDF·사진)를 올려 문항 유형을 읽고(/api/examscan — 동형 모의고사 탭과 같은
   서버 호출), 그 결과를 부(회차)·유형별로 세어 출제경향 보고서로 보여 준다.
   동형 모의고사 탭과는 상태를 나누지 않는다 — 올린 시험지·분석 결과·저장이 모두 이 탭 것이다.
   분석은 시간이 걸리므로 결과(부별 문항 유형표 + AI 글)를 저장함에 tab "trend"로 저장해 두고
   다시 불러 쓴다. 저장본에는 쪽 그림을 넣지 않는다(용량) — 문항 유형표만 담는다.

   app.js가 먼저 로드되어 있어야 한다(같은 전역을 쓴다): $, esc, postGenerate, costConfirmed,
   photoToPart, blobToBase64, isPhoto, extractJpegs, examPdfNeedsWhole, buildExamMergeRows,
   EXAM_MAX_PAGES, EXAM_SCAN_BATCH, PRICING, TAB_SAVE, TAB_LABELS, openSaveDialog, openSavedList.

   집계와 그래프는 화면이 공짜로 하고, AI는 집계표(부·유형별 개수)만 받아 총평과 유형별 대비
   전략 글을 쓴다(/api/examtrend, Flash). 인쇄는 새 창에 보고서만 담아 연다.

   시험 범위 대조: 분석할 때 쪽 그림에서 출제 지문도 옮겨 적고(/api/examocr — 동형 모의고사의
   '지문도 가져오기'와 같은 호출, 2쪽씩 한 쪽 겹쳐 읽는다), 선생님이 넣은 시험 범위 지문과
   세 낱말 묶음(shingle)이 얼마나 겹치는지로 짝을 짓는다(trendCoverage). 시험 지문은 빈칸·
   밑줄·번호가 들어가 원문과 글자가 똑같지 않으므로 통째 비교가 아니라 겹침 비율로 본다. */

const TREND_MAX_DOCS = 12;   // server.py EXAM_TREND_MAX_DOCS와 같아야 한다 — 넘치면 서버가 잘라 낸다

let trendDocs = [];     // [{name, pages:[{mime,data}]|null, questions:[…]|null, failedIdx:[], passages:[{label,text}]|null, passErr, busy, error}]
const TREND_MATCH_MIN = 0.3;   // 낱말 세 개 묶음이 이만큼 겹쳐야 같은 지문으로 본다
let trendAi = null;     // AI가 쓴 글 {overview, strategies, caution}. 분석한 부가 바뀌면 비운다
/* 시험 범위만 바뀐 경우에는 총평을 지우지 않고 '예전 범위 기준'이라고만 알린다 — 총평은
   보고서 값(1건당)을 받는 자리라, 범위 칸을 조금 고칠 때마다 지워 버리면 다시 쓰느라
   값이 또 나간다. 다시 쓸지는 선생님이 정한다. */
let trendAiStale = false;
let trendBusy = false;
let trendLoadMode = "replace";   // 저장본을 불러올 때 지금 것을 갈아 끼울지("replace") 이어 붙일지("append")

const trendDropEl = $("trendDrop");
const trendFileEl = $("trendFile");
const trendStatusEl = $("trendStatus");
const trendDocsEl = $("trendDocs");
const trendRunBtn = $("trendRunBtn");
const trendErrorEl = $("trendError");
const trendLoadingEl = $("trendLoading");
const trendLoadingTextEl = $("trendLoadingText");
const trendResultEl = $("trendResult");
const trendReadPassagesEl = $("trendReadPassages");
const trendWantPassages = () => !!(trendReadPassagesEl && trendReadPassagesEl.checked);
/* 보고서 머리에 찍는 학교 이름·학년 과목. 출제경향 보고서는 '어느 학교 시험인가'가
   먼저 보여야 해서 칸을 따로 둔다. 비워 두면 예전처럼 제목만 나온다. */
const trendSchoolEl = $("trendSchool");
const trendSubjectEl = $("trendSubject");
const trendSchool = () => (trendSchoolEl ? trendSchoolEl.value.trim() : "");
const trendSubject = () => (trendSubjectEl ? trendSubjectEl.value.trim() : "");
[trendSchoolEl, trendSubjectEl].forEach((el) => el && el.addEventListener("input", () => {
  clearTimeout(trendHeadTimer);
  trendHeadTimer = setTimeout(() => trendRender(), 300);
}));
let trendHeadTimer = null;
const newTrendDoc = (name) => ({ name, pages: [], questions: null, failedIdx: [], passages: null,
                                 passErr: "", busy: false, error: "" });

/* ── 보고서 CSS: 화면과 인쇄 창이 같은 한 벌을 쓴다 ── */
const TREND_CSS = `
.trend-brand-slot{margin-top:14px}
.trend-report{font-family:"Malgun Gothic","맑은 고딕",sans-serif;color:#1a1f2b;line-height:1.6}
.trend-report h3{margin:0 0 4px;font-size:20px}
.trend-report h4{margin:18px 0 6px;font-size:15px;border-left:4px solid #4d94ec;padding-left:8px}
.trend-report .trend-sub{margin:0 0 10px;font-size:12px;color:#5b6473}
.trend-report .trend-summary{margin:8px 0;padding:10px 12px;background:#f2f5fb;border-radius:8px;font-size:14px}
.trend-report table{width:100%;border-collapse:collapse;font-size:13px}
.trend-report th,.trend-report td{border:1px solid #cfd6e3;padding:5px 7px;text-align:center}
.trend-report th{background:#eaeff8}
.trend-report td.tk{text-align:left}
.trend-report td.zero{color:#aab2c0}
/* 표의 비중 막대 — 1쪽 '유형별 문항 수'와 같은 유형 색·광택(2026-09-30 사용자). 색은 background-color로 준다 */
.trend-report .tbar{display:block;height:12px;background-color:#4d94ec;border-radius:0 4px 4px 0;min-width:2px;
  background-image:linear-gradient(180deg,rgba(255,255,255,.55) 0,rgba(255,255,255,.12) 45%,rgba(0,0,0,.06) 100%);
  box-shadow:0 1px 2px rgba(26,31,43,.22),inset 0 -1px 0 rgba(0,0,0,.08)}
.trend-report td.tbarcell{width:26%;text-align:left}
.trend-report .tag{display:inline-block;padding:0 7px;border-radius:9px;font-size:11px;background:#e6ecf7;color:#2c4a86}
.trend-report .tag.every{background:#dff3e6;color:#1d6b3c}
.trend-report .tag.once{background:#fdeed9;color:#8a5a12}
.trend-report ul{margin:4px 0 0;padding-left:20px;font-size:14px}
.trend-report li{margin:4px 0}
.trend-report .trend-caution{margin-top:10px;font-size:12px;color:#5b6473}
.trend-report .trend-empty{font-size:13px;color:#5b6473}
.trend-report{counter-reset:sec}
.trend-report h4.sec::before{counter-increment:sec;content:counter(sec) ". ";color:#4d94ec}
.rp-head{border-top:3px solid #0b0b0b;padding-top:10px;margin-bottom:14px}
.rp-kicker{font-size:12px;letter-spacing:.08em;color:#52514e;font-weight:600}
.trend-report .rp-head h3{font-size:24px;margin:2px 0 10px;letter-spacing:-.01em}
.trend-report table.rp-meta{font-size:12.5px;border-top:1px solid #c3c2b7;border-bottom:1px solid #c3c2b7}
.trend-report .rp-meta th,.trend-report .rp-meta td{border:0;border-bottom:1px solid #e1e0d9;padding:5px 10px;text-align:left}
.trend-report .rp-meta th{width:84px;background:#f6f6f3;color:#52514e;font-weight:600;white-space:nowrap}
.trend-report .rp-meta tr:last-child th,.trend-report .rp-meta tr:last-child td{border-bottom:0}
.rp-find{margin:4px 0 0;padding:10px 14px 10px 34px;background:#f4f7fc;border-left:3px solid #4d94ec;border-radius:0 8px 8px 0;font-size:13.5px}
.rp-find li{margin:3px 0}
.trend-report .rp-body{font-size:13.5px;margin:4px 0;text-align:justify}
.trend-report table.rp-strat{font-size:12.5px}
.trend-report .rp-strat th:nth-child(1){width:22%}.trend-report .rp-strat th:nth-child(2){width:9%}
.trend-report .rp-strat td{padding:5px 8px;vertical-align:top}
.tv-dom{display:grid;grid-template-columns:max-content minmax(120px,1fr) minmax(0,1.3fr);gap:6px 12px;align-items:center;font-size:12.5px}
.tv-dn{font-weight:600;color:#0b0b0b;white-space:nowrap}
.tv-dk{font-size:11.5px;color:#898781;word-break:keep-all}
.tv-bar.dom{background:#1c5cab}
.trend-report td.hit{background:#eef5ff}
.trend-report .qk{display:block;font-size:11px;color:#5b6473}
.trend-report .trend-cov td{padding:3px 8px;font-size:12.5px}
.trend-report .trend-cov .qk{display:inline;font-size:11.5px}
.trend-report .trend-cov tr.grp td{background:#f2f5fb;font-weight:700;text-align:left;color:#2c3a55}
.trend-report .trend-miss-h{margin:14px 0 4px;font-size:13px;color:#2c3a55}
.trend-report .trend-miss{margin:0;padding-left:18px;font-size:12.5px;color:#3a4458}
.trend-report .trend-miss li{margin:2px 0}
.trend-dash{border:1px solid rgba(11,11,11,.10);border-radius:12px;padding:16px 18px;margin:10px 0 6px;break-inside:avoid;background:#fcfcfb}
.trend-dash h5{margin:18px 0 8px;font-size:13.5px;font-weight:700;color:#0b0b0b}
.trend-tiles{display:grid;grid-template-columns:repeat(auto-fit,minmax(140px,1fr));gap:10px}
.trend-tile{border:1px solid rgba(11,11,11,.08);background:#fff;border-radius:10px;padding:10px 11px;border-top:4px solid var(--acc,#c3c2b7);
  box-shadow:0 2px 6px rgba(26,31,43,.10)}
.trend-tile span{display:block;font-size:12px;color:#52514e}
.trend-tile b{display:block;font-size:24px;line-height:1.25;font-weight:700;color:#0b0b0b;margin:2px 0}
.trend-tile b.sm{font-size:18px;line-height:1.55}
.trend-tile b small{font-size:15px;font-weight:600;color:#898781}
.trend-tile em{font-style:normal;font-size:11.5px;color:#898781}
.trend-tiles.t4{grid-template-columns:minmax(0,1.3fr) repeat(3,minmax(0,1fr))}
.trend-tiles.t3{grid-template-columns:minmax(0,1.3fr) repeat(2,minmax(0,1fr))}
.tv-dt-top{display:flex;align-items:center;justify-content:space-between;gap:10px}
.tv-dt-top span{white-space:nowrap}
.tv-dt-top b{white-space:nowrap}
.tv-dt-legend{display:flex;align-items:center;gap:4px;white-space:nowrap;margin-top:2px}
.tv-dt-legend .tv-key{margin-left:6px}.tv-dt-legend .tv-key:first-child{margin-left:0}
.trend-tile{min-width:0;word-break:keep-all}
.trend-tile em:not(.tv-dt-legend),.trend-tile > span{white-space:nowrap;overflow:hidden;text-overflow:ellipsis;display:block}
.rp-note{margin-top:18px;padding:10px 12px;border-top:1px solid #c3c2b7;font-size:12px;color:#52514e;break-inside:avoid}
.rp-note b{display:block;font-size:12.5px;color:#0b0b0b;margin-bottom:2px}
.rp-note p{margin:0 0 2px}
/* 보고서 칸이 좁으면(화면 폭이 아니라 그래프 상자 폭 기준) 네 칸을 2×2로 — 한 줄에 넷을 두면
   "선택 10 · 서술 4" 같은 글이 잘렸다. 인쇄(A4)는 폭이 넉넉해 넷이 한 줄로 나온다. */
.trend-dash{container-type:inline-size}
@container (max-width:600px){.trend-tiles.t4{grid-template-columns:1fr 1fr}}
@media (max-width:640px){.trend-tiles.t4,.trend-tiles.t3{grid-template-columns:1fr 1fr}}
.tv-donut{flex:none}
.tv-legend{display:flex;flex-wrap:wrap;gap:4px 14px;font-size:12px;color:#52514e;margin-bottom:4px}
.tv-legend i{display:inline-block;width:14px;height:3px;border-radius:2px;margin-right:5px;vertical-align:3px}
.tv-line{display:block;max-width:100%;height:auto}
.tv-pair-legend{display:flex;flex-wrap:wrap;gap:4px 16px;font-size:12px;color:#52514e;margin:0 0 8px}
.tv-pair-legend i{display:inline-block;width:16px;height:10px;border-radius:2px;background:#52514e;margin-right:5px;vertical-align:-1px}
.tv-pair{display:grid;grid-template-columns:minmax(110px,max-content) 1fr 64px;gap:7px 10px;align-items:center;font-size:12.5px}
.tv-pair-l{color:#0b0b0b;font-weight:600;white-space:nowrap}.tv-pair-l.same{color:#898781;font-weight:400}
.tv-pair-bars{display:flex;flex-direction:column;gap:2px;border-left:1px solid #c3c2b7;padding-left:1px}
.tv-pair-b{display:flex;align-items:center;gap:5px;height:11px}
.tv-pair-b span{display:block;height:100%;border-radius:0 4px 4px 0;min-width:1px;
  background-image:linear-gradient(180deg,rgba(255,255,255,.55) 0,rgba(255,255,255,.12) 45%,rgba(0,0,0,.06) 100%);
  box-shadow:0 1px 2px rgba(26,31,43,.22),inset 0 -1px 0 rgba(0,0,0,.08)}
.tv-pair-b em{font-style:normal;font-size:10.5px;color:#52514e;line-height:1}
.tv-pair.thin{gap:5px 10px}.tv-pair.thin .tv-pair-b{height:7px}.tv-pair.thin .tv-pair-b em{font-size:9.5px}
.tv-pair.xthin{gap:4px 10px;font-size:12px}.tv-pair.xthin .tv-pair-bars{gap:1px}.tv-pair.xthin .tv-pair-b{height:5px}.tv-pair.xthin .tv-pair-b em{font-size:8.5px}
.tv-pair-d{text-align:right;white-space:nowrap}
.tv-pair-d .up,.tv-pair-d .down{color:#0b0b0b}.tv-pair-d .eq{color:#898781;font-size:11px}
.trend-dash h5 small{font-weight:400;color:#898781;font-size:11.5px}
.tv-grid{display:grid;grid-template-columns:1fr 1fr;gap:10px 28px;align-items:start}
.tv-ph{display:flex;align-items:center;gap:6px;font-size:12.5px;color:#52514e;margin-bottom:8px}
.tv-ph b{margin-left:auto;color:#0b0b0b;font-weight:600}
.tv-key{width:10px;height:10px;border-radius:3px;display:inline-block}
.tv-key.mc,.tv-bar.mc{background:#4d94ec}
.tv-key.sub,.tv-bar.sub{background:#ff8a4c}
.tv-bars{display:grid;grid-template-columns:max-content 1fr;gap:7px 10px;align-items:center;font-size:12.5px}
.tv-l{color:#0b0b0b;white-space:nowrap}
.tv-b{display:flex;align-items:center;gap:6px;min-width:0;border-left:1px solid #c3c2b7;padding-left:0}
.tv-bar{height:14px;border-radius:0 4px 4px 0;flex:none;
  background-image:linear-gradient(180deg,rgba(255,255,255,.55) 0,rgba(255,255,255,.12) 45%,rgba(0,0,0,.06) 100%);
  box-shadow:0 1px 2px rgba(26,31,43,.22),inset 0 -1px 0 rgba(0,0,0,.08)}
.tv-v{font-size:12px;color:#0b0b0b;white-space:nowrap;font-variant-numeric:tabular-nums}
.tv-v small{color:#898781;font-size:11px}
.tv-cov{display:grid;grid-template-columns:minmax(0,1fr) minmax(140px,42%) 92px;gap:8px 12px;align-items:center;font-size:12.5px}
.tv-cl{color:#0b0b0b;word-break:keep-all}
.tv-track{height:12px;border-radius:6px;background:#d9f7ec;overflow:hidden}
.tv-fill{height:100%;background:#2fd197;border-radius:5px;
  background-image:linear-gradient(180deg,rgba(255,255,255,.55) 0,rgba(255,255,255,.1) 50%,rgba(0,0,0,.06) 100%)}
.tv-cov .tv-v{text-align:right}
.tv-domwrap{display:flex;align-items:center;gap:22px}
.tv-ring{flex:none}
.tv-domlist{flex:1;display:grid;grid-template-columns:14px max-content max-content minmax(0,1fr);gap:7px 10px;align-items:center;font-size:12.5px}
.tv-dk2 i{display:block;width:12px;height:12px;border-radius:3px}
.tv-dv{white-space:nowrap;color:#52514e}.tv-dv b{font-size:15px;color:#0b0b0b}.tv-dv span{margin-left:4px;color:#898781}
@media (max-width:640px){.tv-domwrap{flex-direction:column;align-items:flex-start}}
@media (max-width:640px){.tv-grid{grid-template-columns:1fr}}
`;

(function injectTrendStyle() {
  const st = document.createElement("style");
  st.textContent = TREND_CSS + `
.trend-doc{display:flex;align-items:center;gap:8px;margin:6px 0;flex-wrap:wrap}
.trend-doc-name{flex:1 1 220px;min-width:0;padding:6px 8px}
.trend-doc-state{font-size:13px;color:#5b6473}
.trend-doc-state.ok{color:#1d6b3c}
.trend-doc-state.bad{color:#c0392b}
.trend-tools{display:flex;gap:8px;flex-wrap:wrap;margin:10px 0}

@media print{.trend-tools{display:none !important;}}`;
  document.head.appendChild(st);
})();

/* ── 올리기 ── */
function trendStatus(msg, kind) {
  trendStatusEl.hidden = !msg;
  trendStatusEl.textContent = msg || "";
  trendStatusEl.className = "exam-status" + (kind ? " " + kind : "");
}

async function trendAddFiles(fileList) {
  if (trendBusy) return;
  trendBusy = true;
  trendErrorEl.textContent = "";
  try {
    /* PDF 한 파일 = 시험지 한 부. 낱장 사진은 한 부로 묶는다(동형 모의고사 탭과 같은 규칙). */
    let photoDoc = null;
    /* 파일 이름 차례로 정렬한다. 여러 장을 고르거나 끌어다 놓으면 브라우저가 넘겨주는 차례가
       제멋대로라(누른 파일이 맨 앞에 오기도 한다) 쪽 순서가 뒤섞인다. 휴대폰 사진은 찍은
       시각이 이름이 되므로, 쪽 차례대로 찍었다면 이름 차례가 곧 쪽 차례다. 쪽 경계를 넘는
       지문은 이 차례대로 이어 읽는다(trendOcrStarts). */
    const files = [...fileList].sort((a, b) =>
      String(a.name || "").localeCompare(String(b.name || ""), undefined, { numeric: true }));
    for (const file of files) {
      if (trendDocs.length >= TREND_MAX_DOCS) {
        trendErrorEl.textContent = `한 보고서에는 ${TREND_MAX_DOCS}부까지 담을 수 있습니다.`;
        break;
      }
      const isPdf = /pdf$/i.test(file.type) || /\.pdf$/i.test(file.name || "");
      if (isPdf) {
        trendStatus(`${file.name} 에서 쪽을 꺼내는 중…`);
        const doc = newTrendDoc((file.name || `시험지 ${trendDocs.length + 1}`).replace(/\.pdf$/i, ""));
        const buf = new Uint8Array(await file.arrayBuffer());
        const blobs = extractJpegs(buf);
        if (blobs.length && !examPdfNeedsWhole(buf, blobs.length)) {
          for (const b of blobs) {
            if (doc.pages.length >= EXAM_MAX_PAGES) break;
            doc.pages.push(await photoToPart(b));
          }
        } else {
          // 쪽 그림을 꺼낼 수 없는 PDF — 원본을 그대로 넘긴다(자세한 사정은 app.js examPdfNeedsWhole)
          const data = await blobToBase64(file);
          if (data.length > 9 * 1024 * 1024) {
            trendErrorEl.textContent =
              `${file.name} 은 쪽 그림을 꺼낼 수 없는 PDF인데 용량이 너무 큽니다. 쪽을 사진으로 찍거나 캡처해서 올려 주세요.`;
            continue;
          }
          doc.pages.push({ mime: "application/pdf", data });
        }
        trendDocs.push(doc);
      } else if (isPhoto(file)) {
        if (!photoDoc) {
          photoDoc = newTrendDoc("사진");
          trendDocs.push(photoDoc);
        }
        if (photoDoc.pages.length < EXAM_MAX_PAGES) photoDoc.pages.push(await photoToPart(file));
      }
    }
  } catch (err) {
    trendErrorEl.textContent = `시험지를 읽지 못했습니다: ${err.message || err}`;
  }
  trendBusy = false;
  trendSync();
}

/* ── 부 목록 · 상태 ── */
function trendDocState(d) {
  if (d.busy) return ["분석 중…", ""];
  if (d.questions) {
    const fail = d.failedIdx.length ? ` · 못 읽은 쪽 ${d.failedIdx.map((i) => i + 1).join("·")}` : "";
    const pass = d.passages ? ` · 출제 지문 ${d.passages.length}개${d.ocrFailed && d.ocrFailed.length ? ` (못 읽은 쪽 ${d.ocrFailed.map((i) => i + 1).join("·")} — [분석하기]로 다시 읽기)` : ""}`
      : d.passErr ? " · 지문 읽기 실패" : d.pages && trendWantPassages() && trendHasRange() ? " · 지문 읽기 대기" : "";
    return [`${d.questions.length}문항 분석됨${pass}${fail}`, d.failedIdx.length || d.passErr ? "bad" : "ok"];
  }
  if (d.error) return [d.error, "bad"];
  return [d.pages ? `${d.pages.length}쪽 · 분석 대기` : "", ""];
}

function trendRenderDocs() {
  trendDocsEl.innerHTML = trendDocs.map((d, i) => {
    const [txt, cls] = trendDocState(d);
    return `<div class="trend-doc" data-i="${i}">
      <input type="text" class="trend-doc-name" value="${esc(d.name)}" maxlength="40"
             aria-label="${i + 1}부 이름" title="보고서에 찍힐 이름입니다. 고쳐도 됩니다.">
      <span class="trend-doc-state ${cls}">${esc(txt)}</span>
      <button type="button" class="btn ghost small trend-doc-del" title="이 부를 뺍니다">✕</button>
    </div>`;
  }).join("");
}

const trendNeedsScan = (d) => !d.questions || d.failedIdx.length > 0;
const trendHasRange = () => typeof trendRangeMgr !== "undefined" && trendRangeJobs().length > 0;
const trendNeedsPassages = (d) => trendWantPassages() && trendHasRange() && !!(d.pages && d.pages.length)
  && (!d.passages || (Array.isArray(d.ocrFailed) && d.ocrFailed.length > 0));
function trendPending() {
  return trendDocs.filter((d) => trendNeedsScan(d) || trendNeedsPassages(d));
}

function trendSync() {
  trendRenderDocs();
  const pending = trendPending().filter((d) => d.pages && d.pages.length);
  trendRunBtn.disabled = trendBusy || !pending.length;
  const ready = trendDocs.filter((d) => d.questions).length;
  const left = pending.length;
  if (!trendDocs.length) trendStatus("");
  else trendStatus(`${trendDocs.length}부 · 분석 완료 ${ready}부${left ? ` · 분석할 것 ${left}부 — “분석하기”를 누르세요` : ""}`,
                   left ? "" : "ok");
  trendRender();
}

trendDocsEl.addEventListener("change", (e) => {
  const input = e.target.closest(".trend-doc-name");
  if (!input) return;
  const d = trendDocs[Number(input.closest(".trend-doc").dataset.i)];
  if (!d) return;
  d.name = input.value.trim() || d.name;
  d.nameEdited = true;
  input.value = d.name;
  trendRender();
});
trendDocsEl.addEventListener("click", (e) => {
  const del = e.target.closest(".trend-doc-del");
  if (!del || trendBusy) return;
  const i = Number(del.closest(".trend-doc").dataset.i);
  if (trendDocs[i] && trendDocs[i].questions && trendAi) trendAiStale = true;   // 집계가 바뀌었다 — 알리기만 한다
  trendDocs.splice(i, 1);
  trendSync();
});

trendDropEl.addEventListener("click", () => trendFileEl.click());
trendFileEl.addEventListener("change", () => {
  trendAddFiles(trendFileEl.files);
  trendFileEl.value = "";
});
["dragover", "dragenter"].forEach((ev) =>
  trendDropEl.addEventListener(ev, (e) => { e.preventDefault(); trendDropEl.classList.add("over"); }));
["dragleave", "drop"].forEach((ev) =>
  trendDropEl.addEventListener(ev, (e) => { e.preventDefault(); trendDropEl.classList.remove("over"); }));
trendDropEl.addEventListener("drop", (e) => {
  if (e.dataTransfer && e.dataTransfer.files) trendAddFiles(e.dataTransfer.files);
});

/* ── 분석 ── */
const trendPageNo = (q) => { const m = /^\d+/.exec(String(q.no || "").trim()); return m ? Number(m[0]) : Infinity; };

// 지문 옮겨 적기에서 한 번에 읽는 쪽 묶음 — 2쪽씩 한 쪽 겹친다(까닭은 app.js runExamOcr 위 주석)
function trendOcrStarts(n) {
  const out = [];
  for (let i = 0; i < n; ) {
    out.push(i);
    if (i + EXAM_OCR_BATCH >= n) break;
    i += EXAM_OCR_BATCH - 1;
  }
  return out;
}

/* 한 부의 쪽 그림에서 영어 지문을 옮겨 적는다.
   묶음 하나가 실패해도 나머지는 버리지 않는다 — 10쪽 시험지에서 8묶음 중 1묶음이 5분을
   넘겨 잘렸는데, 예전에는 그 하나 때문에 이미 읽은 7묶음까지 통째로 버렸다(2026-09-29).
   실패한 묶음은 그 자리에서 한 쪽씩 다시 읽고, 그래도 안 되는 쪽은 d.ocrFailed에 적어 둔다.
   다음 [분석하기]는 그 쪽만 다시 읽어 이미 읽은 지문에 합친다. */
async function trendReadPassages(d) {
  const retry = Array.isArray(d.ocrFailed) && d.ocrFailed.length && Array.isArray(d.passages);
  const found = retry ? d.passages.slice() : [];
  const heads = new Map();
  const tails = new Map();
  found.forEach((p, i) => { heads.set(passageKey(p.text, false), i); tails.set(passageKey(p.text, true), i); });
  const add = (res) => {
    for (const p of res.passages || []) {
      // 겹쳐 읽은 쪽 때문에 같은 지문이 두 번 온다 — 긴 쪽을 남기고, 문항 번호는 아는 쪽을 쓴다
      const hk = passageKey(p.text, false);
      const tk = passageKey(p.text, true);
      if (!hk) continue;
      let at = heads.get(hk);
      if (at === undefined) at = tails.get(tk);
      const item = { label: String(p.label || ""), text: String(p.text || "") };
      if (at === undefined) {
        at = found.length;
        found.push(item);
      } else if (item.text.length > found[at].text.length) {
        found[at] = { label: item.label || found[at].label, text: item.text };
      } else {
        if (!found[at].label) found[at].label = item.label;
        continue;
      }
      heads.set(passageKey(found[at].text, false), at);
      tails.set(passageKey(found[at].text, true), at);
    }
  };
  const read = (idx) => postGenerate(
    "/api/examocr",
    { files: idx.map((i) => d.pages[i]), pageFrom: idx[0] + 1, pageTotal: d.pages.length },
    "시험지에서 지문을 꺼내지 못했습니다."
  );
  // 처음이면 2쪽씩 겹쳐 묶고, 다시 읽는 것이면 못 읽은 쪽만 한 쪽씩
  const jobs = retry
    ? d.ocrFailed.map((i) => [i])
    : trendOcrStarts(d.pages.length).map((s) => [s, s + 1].filter((i) => i < d.pages.length));
  const failed = new Set();
  let lastErr = "";
  for (let k = 0; k < jobs.length; k++) {
    const idx = jobs[k];
    trendLoadingTextEl.textContent =
      `AI가 「${d.name}」에서 출제 지문을 옮겨 적고 있습니다… (${k + 1}/${jobs.length})`;
    try {
      add(await read(idx));
    } catch (err) {
      if (isQuotaError(err)) throw err;   // 한도 소진은 기다려도 안 풀린다
      lastErr = err.message || String(err);
      if (idx.length === 1) { failed.add(idx[0]); continue; }
      for (const i of idx) {
        trendLoadingTextEl.textContent =
          `「${d.name}」 ${idx[0] + 1}~${idx[idx.length - 1] + 1}쪽을 한 번에 못 읽어 한 쪽씩 다시 읽습니다… (${i + 1}쪽)`;
        try { add(await read([i])); }
        catch (err2) {
          if (isQuotaError(err2)) throw err2;
          lastErr = err2.message || String(err2);
          failed.add(i);
        }
      }
    }
  }
  /* 겹쳐 읽으므로 한 쪽이 실패해도 옆 묶음이 그 쪽을 읽었을 수 있다. 그래도 어느 쪽이
     빠졌는지 정확히 알 수 없으니 실패한 쪽은 그대로 적어 두고 다시 읽을 길을 남긴다. */
  d.passages = found;
  d.ocrFailed = [...failed].sort((a, b) => a - b);
  d.passErr = d.ocrFailed.length ? `${d.ocrFailed.map((i) => i + 1).join("·")}쪽 지문을 못 읽음(${lastErr})` : "";
}

async function trendRun() {
  if (trendBusy) return;
  const todo = trendPending();
  if (!todo.length) return;
  trendErrorEl.textContent = "";
  const scanCalls = todo.reduce((n, d) => n + (!trendNeedsScan(d) ? 0 : d.questions
    ? d.failedIdx.length : Math.ceil(d.pages.length / EXAM_SCAN_BATCH)), 0);
  const ocrPages = todo.reduce((n, d) => n + (trendNeedsPassages(d)
    ? trendOcrStarts(d.pages.length).reduce((m, i) => m + Math.min(EXAM_OCR_BATCH, d.pages.length - i), 0) : 0), 0);
  const won = PRICING ? (PRICING.examScan || 0) * scanCalls + (PRICING.examOcrPage || 0) * ocrPages
    + (trendAi ? 0 : (PRICING.examTrend || 0)) : 0;
  if (won > 0 && !(await costConfirmed(won,
      `시험지 ${todo.length}부를 분석${trendAi ? "합니다(총평은 그대로 둡니다)" : "하고 총평까지 씁니다"}${ocrPages ? " (출제 지문 옮겨 적기 포함)" : ""}.`, scanCalls, ""))) return;
  trendBusy = true;
  trendRunBtn.disabled = true;
  trendLoadingEl.classList.add("on");
  let lastErr = "";
  let quotaOut = false;
  for (const d of todo) {
    if (quotaOut) break;
    d.busy = true;
    d.error = "";
    trendRenderDocs();
    if (trendNeedsScan(d)) {
      const first = !d.questions;
      const acc = d.questions ? d.questions.slice() : [];
      const seen = new Set(acc.map((q) => String(q.no || "").trim()).filter(Boolean));
      // 처음이면 3쪽씩 묶고, 다시 읽는 것이면 못 읽은 쪽만 한 쪽씩 읽는다
      const jobs = [];
      if (first) {
        for (let i = 0; i < d.pages.length; i += EXAM_SCAN_BATCH) {
          jobs.push(d.pages.map((_p, k) => k).slice(i, i + EXAM_SCAN_BATCH));
        }
      } else {
        d.failedIdx.forEach((i) => jobs.push([i]));
      }
      const failed = [];
      const readJob = async (idx) => {
        const scan = await postGenerate(
          "/api/examscan",
          { files: idx.map((i) => d.pages[i]), pageFrom: idx[0] + 1, pageTotal: d.pages.length },
          "시험지 분석에 실패했습니다."
        );
        // 첫 쪽에서 읽은 고사 이름(예: 2026학년도 2학기 영어Ⅱ 1차고사)을 부 이름으로 쓴다 —
        // '사진'이나 파일 이름은 보고서에서 어느 시험인지 알 수 없다. 손으로 고친 이름은 둔다.
        const t = String(scan.title || "").trim();
        if (t && !d.nameEdited && !d.titled) { d.name = t.slice(0, 40); d.titled = true; }
        for (const q of scan.questions || []) {
          const key = String(q.no || "").trim();
          if (key && seen.has(key)) continue;   // 쪽 경계에 걸친 문항이 겹쳐 오면 먼저 읽은 것을 남긴다
          if (key) seen.add(key);
          // 저장본을 가볍게 — 보고서에 쓰는 것만 남긴다(발문은 짧게 자른다)
          acc.push({ no: q.no, format: q.format, category: q.category, kind: q.kind, engine: q.engine, fit: q.fit,
                     prompt: String(q.prompt || "").slice(0, 60) });
        }
      };
      for (let j = 0; j < jobs.length; j++) {
        const idx = jobs[j];
        if (quotaOut) { failed.push(...idx); continue; }
        trendLoadingTextEl.textContent =
          `AI가 「${d.name}」의 문항 유형을 읽고 있습니다… (${idx[0] + 1}~${idx[idx.length - 1] + 1}쪽, 1~3분 걸립니다)`;
        try {
          await readJob(idx);
        } catch (err) {
          lastErr = err.message || String(err);
          if (isQuotaError(err)) { quotaOut = true; failed.push(...idx); continue; }
          if (idx.length === 1) { failed.push(idx[0]); continue; }
          // 묶음이 실패하면 한 쪽씩 나눠 다시 읽는다(app.js runExamScan과 같은 대응)
          for (const i of idx) {
            if (quotaOut) { failed.push(i); continue; }
            try { await readJob([i]); }
            catch (err2) {
              lastErr = err2.message || String(err2);
              if (isQuotaError(err2)) quotaOut = true;
              failed.push(i);
            }
          }
        }
      }
      d.failedIdx = failed.sort((a, b) => a - b);
      if (acc.length) {
        acc.sort((a, b) => trendPageNo(a) - trendPageNo(b));
        d.questions = acc;
        if (trendAi) trendAiStale = true;   // 집계가 바뀌었다 — 총평은 두고 알리기만 한다
      } else if (first) {
        d.error = lastErr || "문항을 찾지 못했습니다.";
      }
    }
    if (!quotaOut && d.questions && trendNeedsPassages(d)) {
      d.passErr = "";
      try {
        await trendReadPassages(d);
        if (trendAi) trendAiStale = true;
      } catch (err) {
        lastErr = err.message || String(err);
        d.passErr = lastErr;
        if (isQuotaError(err)) quotaOut = true;
      }
    }
    d.busy = false;
    // 다 읽었으면 쪽 그림을 버려 메모리를 돌려준다(지문을 아직 못 읽었으면 남겨 둔다)
    if (d.questions && !d.failedIdx.length && !(d.ocrFailed && d.ocrFailed.length)
        && (d.passages || !trendWantPassages())) d.pages = null;
    trendRenderDocs();
  }
  if (lastErr) trendErrorEl.textContent = lastErr;
  trendSync();
  /* 분석이 끝나면 곧장 AI 총평까지 쓴다 — 단 총평이 아직 없을 때만. 이미 있으면(다시 읽기 ·
     시험지 추가) 저절로 다시 쓰지 않고 '바뀌었다'고만 알린다(trendAiStale). 총평은 보고서
     값을 받는 자리라, 몰래 다시 쓰면 값이 또 나간다. 한도 소진이면 부르지 않는다. */
  if (!quotaOut && !trendAi && trendStats()) {
    trendLoadingTextEl.textContent = "AI가 시험지 분석 총평과 대비 전략을 쓰고 있습니다…";
    await trendRunAi(true);
  }
  trendLoadingEl.classList.remove("on");
  trendBusy = false;
  if (typeof refreshTokenDisplay === "function") refreshTokenDisplay();
  trendSync();
}
trendRunBtn.addEventListener("click", trendRun);

// [분석하기] 옆 요금 안내 — 금액은 서버(/api/pricing)가 유일한 출처다
onPricingReady(() => {
  const el = $("trendCostHint");
  if (!el || !PRICING) return;
  const won = PRICING.examTrend || 0;
  el.innerHTML = won > 0
    ? `시험지 분석은 <b>무료</b> · 보고서 총평 1건 <b>${pt(won)}</b>`
    : "분석과 보고서 모두 <b>포인트가 들지 않습니다</b>";
});

/* ── 집계 ── */
// 분석이 끝난 부만 보고서에 넣는다. doc는 그 목록 안의 순번이다
function trendSourceNow() {
  const ready = trendDocs.filter((d) => d.questions && d.questions.length);
  const questions = [];
  ready.forEach((d, i) => d.questions.forEach((q) => questions.push({ ...q, doc: i })));
  return { questions, names: ready.map((d) => d.name) };
}

/* 보고서가 세는 유형. 서버가 문항마다 붙여 주는 보고서용 유형(category — server.py
   EXAM_REPORT_CATEGORIES)을 쓴다. 이 앱으로 만들 수 있는지(kind)와 상관없이 모든 문항이
   하나씩 갖는다 — 그래서 중학교 시험지의 대화문·영영풀이 문항도 빠지지 않고 세어진다.
   category가 없는 것(이 기능 전에 읽은 분석)은 kind로, 그것도 없으면 '분류 못 함'으로 센다. */
const trendCat = (q) => q.category || q.kind || "분류 못 함";

// 유형별로 부마다 몇 문항 나왔는지 센다
function trendStats() {
  const src = trendSourceNow();
  if (!src.names.length) return null;
  const docs = src.names.length;
  const map = new Map();
  src.questions.forEach((q) => {
    const key = trendCat(q);
    let r = map.get(key);
    if (!r) { r = { kind: key, per: new Array(docs).fill(0) }; map.set(key, r); }
    r.per[q.doc || 0] += 1;
  });
  const perDocTotal = new Array(docs).fill(0);
  map.forEach((r) => r.per.forEach((v, i) => { perDocTotal[i] += v; }));
  const grand = perDocTotal.reduce((a, b) => a + b, 0);
  const sub = src.questions.filter((q) => q.format === "서답형").length;
  const list = [...map.values()].map((r) => {
    const total = r.per.reduce((a, b) => a + b, 0);
    const appears = r.per.filter((v) => v > 0).length;
    let cls = "";
    if (docs > 1) cls = appears === docs ? "every" : appears === 1 ? "once" : "some";
    return { kind: r.kind, per: r.per, total, appears, cls, label: r.kind,
             share: grand ? total / grand : 0 };
  }).sort((a, b) => b.total - a.total || a.label.localeCompare(b.label));
  return { names: src.names, docs, list, perDocTotal, grand, subTotal: sub,
           unmadeTotal: (map.get("분류 못 함") || { per: [] }).per.reduce((a, b) => a + b, 0) };
}

/* ── 시험 범위 대조 ── */
function trendShingles(text) {
  const w = String(text || "").toLowerCase().replace(/[^a-z\s]/g, " ").split(/\s+/).filter(Boolean);
  const out = new Set();
  for (let i = 0; i + 3 <= w.length; i++) out.add(w.slice(i, i + 3).join(" "));
  return out;
}
// 짧은 쪽 기준 겹침 비율 — 시험지가 원문 일부만 실어도, 범위 지문이 발췌여도 잡힌다
function trendOverlap(a, b) {
  if (!a.size || !b.size) return 0;
  const [small, big] = a.size <= b.size ? [a, b] : [b, a];
  let n = 0;
  small.forEach((x) => { if (big.has(x)) n++; });
  return n / small.size;
}
// "15번" · "15-16번" · "15~17번" → [15, 16, 17]
function trendLabelNos(label) {
  const m = /(\d+)\s*[-~∼–]\s*(\d+)/.exec(label || "");
  if (m) {
    const a = Number(m[1]), b = Number(m[2]);
    if (b >= a && b - a < 6) return Array.from({ length: b - a + 1 }, (_v, k) => a + k);
  }
  return ((label || "").match(/\d+/g) || []).map(Number);
}
const trendRangeLabel = (r, i) => r.named ? r.name
  : `${r.name || `지문 ${i + 1}`} · ${String(r.text).trim().split(/\s+/).slice(0, 5).join(" ")}…`;

// 범위 지문마다 부별로 어느 문항(번호·유형)으로 나왔는지 센다. 대조할 것이 없으면 null
function trendCoverage() {
  const ready = trendDocs.filter((d) => d.questions && d.questions.length);
  const rangeJobs = trendRangeJobs();
  if (!rangeJobs.length || !ready.some((d) => d.passages)) return null;
  const range = rangeJobs.map((r, i) => ({
    label: trendRangeLabel(r, i), sh: trendShingles(r.text), hits: ready.map(() => []),
    group: r.named && r.name.includes(" · ") ? r.name.slice(0, r.name.lastIndexOf(" · ")).trim() : "",
  }));
  const outside = ready.map(() => []);
  ready.forEach((d, di) => {
    (d.passages || []).forEach((p) => {
      const sh = trendShingles(p.text);
      let best = -1, score = 0;
      range.forEach((r, ri) => {
        const v = trendOverlap(sh, r.sh);
        if (v > score) { score = v; best = ri; }
      });
      /* 선다형 1번과 서답형 1번이 한 시험지에 함께 있다 — 번호만 보면 서답형 지문에
         선다형 1번의 유형이 붙는다. 라벨과 문항 번호 양쪽의 '서답·서술' 여부까지 맞춘다. */
      const sub = /서/.test(p.label || "");
      const kinds = [...new Set(trendLabelNos(p.label).map((n) => {
        const q = d.questions.find((x) => {
          const no = String(x.no || "");
          const m = /\d+/.exec(no);
          return m && Number(m[0]) === n && /서/.test(no) === sub;
        });
        return q ? trendCat(q) : "";
      }).filter(Boolean))];
      const hit = { label: p.label || "?", kinds };
      if (best >= 0 && score >= TREND_MATCH_MIN) range[best].hits[di].push(hit);
      else outside[di].push(hit);
    });
  });
  return {
    names: ready.map((d) => d.name),
    read: ready.map((d) => !!d.passages),
    rows: range.map((r) => ({ label: r.label, hits: r.hits, group: r.group,
                              count: r.hits.reduce((a, h) => a + (h.length ? 1 : 0), 0) })),
    outside,
  };
}

/* 묶음 이름(저장본 제목)이 없는 범위 지문 — 칸에 직접 붙여 넣었거나 이름을 "제목 · 지문"꼴로
   달지 않은 것. 예전에는 이런 지문을 묶음에서 빼 버려, 범위별 출제율 그래프에 대화문만 나오고
   본문이 통째로 빠진 일이 있었다(2026-09-29 아중중 보고서). 한 묶음으로 모아 함께 센다. */
const TREND_OTHER_GROUP = "그 밖의 범위 지문";
/* 묶음 이름이 없으면 지문 이름의 숫자 앞 말로 묶는다 — "본문 5-3" · "본문5-2" → "본문",
   "지문 3" → "지문". 그것도 없으면 '그 밖의 범위 지문'. */
const trendGroupKey = (r) => {
  if (r.group) return r.group;
  const m = /^\s*([^\d·]+?)\s*\d/.exec(r.label || "");
  return m && m[1].trim() ? m[1].trim() : TREND_OTHER_GROUP;
};

// 범위(저장본 제목)마다 지문 몇 개 중 몇 개가 나왔는지
function trendGroupStats(cv) {
  const groups = new Map();
  (cv ? cv.rows : []).forEach((r) => {
    const key = trendGroupKey(r);
    const g = groups.get(key) || { total: 0, used: 0, hits: 0 };
    g.total++;
    if (r.count > 0) g.used++;
    g.hits += r.hits.reduce((a, h) => a + h.length, 0);
    groups.set(key, g);
  });
  return groups;
}

/* ── 한눈에 보기 — 그래프를 한 장에 모은다 ──
   인쇄하면 이 칸이 첫 장을 차지하고 자세한 표는 다음 장부터 나온다(break-after). 유형은
   많아야 24가지라 한 줄 17px로 그리면 A4 한 장에 다른 그래프와 함께 들어간다. 서술형 유형은
   색을 달리해 선택형과 한눈에 갈리게 했다. */

/* 시험지 이름이 길고 앞뒤가 같아("2026학년도 1학기 1차고사 영어1" / "… 2차고사 …") 잘라 쓰면
   둘이 같아 보인다(2026-09-30 진안제일고 보고서) — 이름들에 공통인 앞·뒤 낱말을 떼고 다른 부분만
   남긴다. 떼고 나면 빈 이름이 생기면 원래 이름을 쓴다. */
function trendShortNames(names) {
  if (!names || names.length < 2) return names || [];
  const toks = names.map((n) => String(n).trim().split(/\s+/));
  let pre = 0;
  while (toks.every((t) => t.length > pre + 1 && t[pre] === toks[0][pre])) pre++;
  let suf = 0;
  while (toks.every((t) => t.length > pre + suf + 1 && t[t.length - 1 - suf] === toks[0][toks[0].length - 1 - suf])) suf++;
  const out = toks.map((t) => t.slice(pre, t.length - suf).join(" "));
  return out.every(Boolean) && new Set(out).size === out.length ? out : names.map(String);
}

/* 시험지별 유형 변화 — 유형마다 한 줄에 시험지별 막대를 위아래로 겹쳐 놓는다.
   처음엔 모든 유형을 꺾은선으로 그렸는데, 선 열세 개가 엇갈려 어느 선이 어느 유형인지 따라갈 수
   없었다(2026-09-30 사용자: "지저분해서 뭐 알아보겠냐"). 그 전엔 많이 나온 3가지만 그려 '분석하다
   만 느낌'이었다. 줄마다 막대를 두면 유형이 몇 개든 서로 엉키지 않는다.
   막대 색은 **시험지마다 하나**다(TREND_EXAM_COLORS — 첫 시험 빨강, 둘째 파랑, 셋째 초록…). 처음엔 유형
   색을 쓰고 시험지를 진하기로 갈랐는데, 범례(회색 네모)와 막대 색이 달라 어느 막대가 어느 시험인지
   헷갈렸다(2026-09-30 사용자). 유형은 줄 이름이 알려 준다. 증감(▲/▼)은 시험지 색과 섞이지 않게 검정으로 쓴다. 오른쪽 끝에 처음→마지막 증감(▲/▼)을 적는다. 같은 눈금이라 줄끼리 견줄 수 있다.
   시험지가 두 부 이상일 때만 뜻이 있다. */
// 시험지 색 — 이웃한 둘이 뚜렷이 갈리도록 색상환을 크게 건너뛴다. 시험지는 TREND_MAX_DOCS(12)부까지라 12색
const TREND_EXAM_COLORS = ["#ef5350", "#3f7fe8", "#26b57a", "#ff9a3c", "#9b6cf0", "#1fb5c9",
  "#e05fc4", "#9ccc3d", "#8d6e63", "#5d6ff0", "#e6b800", "#607d8b"];
function trendChangeBarsHtml(st) {
  if (st.docs < 2) return "";
  const last = st.docs - 1;
  const max = Math.max(1, ...st.list.flatMap((r) => r.per));
  const ec = (i) => TREND_EXAM_COLORS[i % TREND_EXAM_COLORS.length];
  const short = trendShortNames(st.names);
  /* 줄 수 × 시험지 수가 많으면 막대를 가늘게 한다 — 한 쪽(A4)에 들도록 잰 값(2026-09-30, 폭 687px:
     24유형·4부가 보통 굵기로 1075px라 한 장 1017을 넘었다) */
  const cells = st.list.length * st.docs;
  const thin = cells > 60 ? " xthin" : st.docs > 2 || st.list.length > 16 ? " thin" : "";
  const rows = st.list.map((r) => {
    const d = r.per[last] - r.per[0];
    // 처음과 끝이 같아도 가운데 시험에서 달랐으면 '변화 없음'이 아니다(시험지가 셋 이상일 때)
    const varied = new Set(r.per).size > 1;
    const badge = d > 0 ? `<b class="up">▲${d}</b>` : d < 0 ? `<b class="down">▼${-d}</b>`
      : `<span class="eq">${varied ? "오르내림" : "변화 없음"}</span>`;
    const bars = r.per.map((v, i) => `<div class="tv-pair-b"><span style="width:${(v / max) * 100}%;background-color:${ec(i)}"></span><em>${v}</em></div>`).join("");
    return `<div class="tv-pair-l${varied ? "" : " same"}">${esc(r.label)}</div><div class="tv-pair-bars">${bars}</div><div class="tv-pair-d">${badge}</div>`;
  }).join("");
  const legend = short.map((nm, i) => `<span><i style="background:${ec(i)}"></i>${esc(nm)}</span>`).join("");
  return `<div class="tv-pair-legend">${legend}</div>
    <div class="tv-pair${thin}">${rows}</div>`;
}

/* 변화 한눈에 — 처음 시험지와 마지막 시험지를 견줘 늘어난·줄어든·그대로인 유형을 나눈다.
   시험지가 셋 이상이면 가운데 시험지는 그래프로 본다(여기서는 처음과 끝만 견준다). */
function trendChangeSummary(st) {
  const last = st.docs - 1;
  const rows = st.list.map((r) => ({ label: r.label, a: r.per[0], b: r.per[last], d: r.per[last] - r.per[0] }));
  return {
    up: rows.filter((r) => r.d > 0).sort((x, y) => y.d - x.d || y.b - x.b),
    down: rows.filter((r) => r.d < 0).sort((x, y) => x.d - y.d || y.a - x.a),
    same: rows.filter((r) => r.d === 0).sort((x, y) => y.b - x.b),
  };
}
/* 막대 줄마다 증감(▲/▼)이 붙어 있어 '늘어난·줄어든·그대로' 상자는 따로 두지 않는다 — 같은 내용이
   두 번 나오고, 유형이 많으면 이 쪽이 A4 한 장을 넘었다(22유형·3부에서 1187/1017). 묶은 요약은
   핵심 요약의 한 줄(trendChangeSummary)이 맡는다. */
function trendChangeHtml(st) {
  if (st.docs < 2) return "";
  return `<div class="trend-dash">
    <h5 style="margin-top:0">유형별 문항 수 <small>(막대 색 = 시험지 · 오른쪽은 처음 대비 증감)</small></h5>
    ${trendChangeBarsHtml(st)}
  </div>`;
}

/* ── 영역 색(영역 도넛·서술형 영역 등) ──
   파랑 한 가지로는 눈에 들어오지 않아(2026-09-29 사용자) 영역마다 색을 준다. 유형 막대는
   아래 TREND_KIND_SHADE가 유형마다 따로 칠한다. 색은 dataviz 참조 팔레트의 1~5번 차례(파랑·주황·청록·노랑·분홍 — 이웃한 둘이 잘
   갈리도록 검증된 차례이니 도넛 조각 차례를 바꾸지 말 것)를 따르되, 인쇄물에서 눈에 띄도록
   한 단계 밝게 올린 값이다(2026-09-29 사용자 요청). 이름표·범례·표가 함께 있어 색만으로 읽지 않는다. */
const TREND_DOMAIN_COLOR = {
  "대의 파악": "#4d94ec",
  "세부 정보": "#ff8a4c",
  "논리·흐름": "#2fd197",
  "어법·어휘": "#ffc02e",
  "서술형": "#f78cb8",
  "기타": "#9a9890",
};
const TREND_MC_COLOR = "#8a97b0";   // 선다형(도넛) — 영역 색과 겹치지 않는 먹색
/* 유형 막대의 색 — 유형마다 무지개 전체에서 서로 다른 색을 준다(2026-09-29 사용자: "세상엔 색이
   참 많은데 노랑·초록만 쓴다"). 처음에는 색 계열을 영역에 묶었더니 유형이 많은 영역(어법·어휘,
   논리·흐름)이 한 색 계열로 뭉쳐 같은 유형처럼 보였다. 영역은 영역 도넛(TREND_DOMAIN_COLOR)이
   따로 보여 준다. 한 시험지에 자주 함께 나오는 유형끼리 색상환에서 멀리 떨어지게 골랐고, 너무
   연한 색은 흰 종이에서 안 보여 쓰지 않는다. 색은 유형에 붙는다(순위가 아니라). */
const TREND_KIND_SHADE = {
  "빈칸 추론": "#2fd197",        // 초록
  "어법": "#ffc02e",             // 노랑
  "내용 일치·불일치": "#ff8a4c", // 주황
  "주제·제목": "#4d94ec",        // 파랑
  "순서 배열": "#9b6cf0",        // 보라
  "문장 삽입": "#1fbfb0",        // 청록
  "요약문 완성": "#f25c5c",      // 빨강
  "어휘·낱말 쓰임": "#e05fc4",   // 자주
  "요지·주장": "#38b6f0",        // 하늘
  "무관한 문장": "#9ccc3d",      // 연두
  "대화 흐름·응답": "#5d6ff0",   // 남색
  "대화문 내용 파악": "#ff7fa0", // 분홍
  "영어 표현 고르기": "#d99a3c", // 호박
  "단어 뜻·영영풀이": "#c9b52c", // 겨자
  "연결어": "#4fa3b8",           // 청회
  "글의 목적": "#c77ddb",        // 연보라
  "심경·분위기": "#ff9e7a",      // 살구
  "함축 의미": "#3f6fd1",        // 코발트
  "지칭 대상": "#b07b52",        // 갈색
};
const TREND_SUB_SHADE = {
  "서술형: 빈칸·단어 쓰기": "#f78cb8", // 분홍
  "서술형: 영작·배열": "#26c6da",      // 청록
  "서술형: 내용 서술": "#ffb74d",      // 귤색
  "서술형: 어법 고쳐 쓰기": "#ab7ae0", // 보라
};
const trendColorOf = (label) => TREND_SUB_SHADE[label] || TREND_KIND_SHADE[label]
  || TREND_DOMAIN_COLOR[trendDomainOf(label)] || "#9a9890";

/* 도넛 — 조각 사이에 2px 틈(테두리 없이 갈라 보이게). parts: [{v, color, label}] */
let trendRingSeq = 0;
function trendRingSvg(parts, size, stroke, center, sub) {
  const total = parts.reduce((a, p) => a + p.v, 0);
  if (!total) return "";
  const r = (size - stroke) / 2, c = 2 * Math.PI * r, h = size / 2;
  const gap = parts.filter((p) => p.v > 0).length > 1 ? 2 : 0;
  let off = 0;
  const arcs = parts.map((p) => {
    const len = (p.v / total) * c;
    const out = len > gap ? `<circle r="${r}" cx="${h}" cy="${h}" fill="none" stroke="${p.color}" stroke-width="${stroke}"
      stroke-dasharray="${(len - gap).toFixed(2)} ${(c - len + gap).toFixed(2)}" stroke-dashoffset="${(-off).toFixed(2)}"
      transform="rotate(-90 ${h} ${h})"><title>${esc(p.label || "")} ${p.v}</title></circle>` : "";
    off += len;
    return out;
  }).join("");
  /* 입체감 — 그림자로 띄우고, 위에서 비치는 흰 광택을 조각 위에 한 겹 덮는다. 원을 기울이는
     진짜 3D는 앞쪽 조각이 커 보여 비율을 속이므로 쓰지 않는다(2026-09-29). */
  const id = `tr${++trendRingSeq}`;
  return `<svg class="tv-ring" viewBox="-4 -3 ${size + 8} ${size + 10}" width="${size}" height="${size}" role="img">
    <defs>
      <filter id="${id}s" x="-20%" y="-20%" width="140%" height="150%"><feDropShadow dx="0" dy="${size > 100 ? 3 : 1.5}" stdDeviation="${size > 100 ? 3 : 1.5}" flood-color="#1a1f2b" flood-opacity=".22"/></filter>
      <linearGradient id="${id}g" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#fff" stop-opacity=".28"/><stop offset=".5" stop-color="#fff" stop-opacity="0"/><stop offset="1" stop-color="#000" stop-opacity=".10"/></linearGradient>
    </defs>
    <g filter="url(#${id}s)">${arcs}</g>
    <circle r="${r}" cx="${h}" cy="${h}" fill="none" stroke="url(#${id}g)" stroke-width="${stroke}" pointer-events="none"/>
    ${center ? `<text x="${h}" y="${h + (sub ? 1 : 5)}" text-anchor="middle" font-size="${size > 100 ? 22 : 13}" font-weight="700" fill="#0b0b0b">${center}</text>` : ""}
    ${sub ? `<text x="${h}" y="${h + 18}" text-anchor="middle" font-size="11" fill="#6b6a65">${sub}</text>` : ""}
  </svg>`;
}

function trendDashHtml(st, cv) {
  const pct = (a, b) => (b ? Math.round((a / b) * 100) : 0);
  // 두 판이 같은 눈금을 쓴다 — 선택형 5문항과 서술형 4문항의 막대 길이가 그대로 견줘져야 한다
  const max = Math.max(...st.list.map((r) => r.total)) || 1;
  const isSub = (r) => /^서술형/.test(r.label);
  const mcRows = st.list.filter((r) => !isSub(r));
  const subRows = st.list.filter(isSub);
  const rowsN = Math.max(mcRows.length, subRows.length);
  const many = rowsN > 10;    // 줄 간격을 좁힌다
  const dense = rowsN > 12;   // 더 좁히고 영역 도넛도 줄인다
  const xdense = rowsN > 17;  // 유형이 거의 다 나온 시험지(중학교 등) — 가장 촘촘하게
  const panel = (rows, title, color) => (rows.length ? `
      <div class="tv-panel">
        <div class="tv-ph"><span class="tv-key" style="background:${color}"></span>${title}<b>${rows.reduce((a, r) => a + r.total, 0)}문항</b></div>
        <div class="tv-bars${xdense ? " dense xdense" : dense ? " dense" : many ? " many" : ""}">${rows.map((r) => `
          <div class="tv-l" title="${esc(r.label)}">${esc(r.label.replace(/^서술형:\s*/, ""))}</div>
          <div class="tv-b"><span class="tv-bar" style="background-color:${trendColorOf(r.label)};width:${Math.max(3, Math.round((r.total / max) * 78))}%"></span><span class="tv-v">${r.total}<small> · ${pct(r.total, st.grand)}%</small></span></div>`).join("")}
        </div>
      </div>` : "");
  const used = cv ? cv.rows.filter((r) => r.count > 0).length : 0;
  const mc = st.grand - st.subTotal;
  const doms = trendDomains(st);
  const tiles = [
    `<div class="trend-tile tv-donut-tile" style="--acc:${TREND_MC_COLOR}">
      <div class="tv-dt-top"><div><span>총 문항</span><b>${st.grand}<small>문항</small></b></div>${trendRingSvg([
        { v: mc, color: TREND_MC_COLOR, label: "선다형" },
        { v: st.subTotal, color: TREND_DOMAIN_COLOR["서술형"], label: "서답형" },
      ], 64, 12, `${pct(mc, st.grand)}%`)}</div>
      <em class="tv-dt-legend"><i class="tv-key" style="background:${TREND_MC_COLOR}"></i>선다형 ${mc}<i class="tv-key" style="background:${TREND_DOMAIN_COLOR["서술형"]}"></i>서답형 ${st.subTotal}</em>
    </div>`,
    `<div class="trend-tile" style="--acc:${TREND_DOMAIN_COLOR["세부 정보"]}"><span>출제 유형</span><b>${st.list.length}가지</b><em>선택 ${mcRows.length} · 서술 ${subRows.length}</em></div>`,
    `<div class="trend-tile" style="--acc:${trendColorOf(st.list[0].label)}"><span>가장 많은 유형</span><b class="sm">${esc(st.list[0].label)}</b><em>${st.list[0].total}문항 · ${pct(st.list[0].total, st.grand)}%</em></div>`,
    cv ? `<div class="trend-tile" style="--acc:${TREND_DOMAIN_COLOR["논리·흐름"]}"><span>출제된 범위 지문</span><b>${used}<small>/${cv.rows.length}</small></b><em>${pct(used, cv.rows.length)}%</em></div>` : "",
  ].join("");
  // 영역 — 큰 도넛 + 색 표시가 붙은 표(영역 · 문항 · 비율 · 들어 있는 유형)
  const domHtml = `
      <div class="tv-domwrap${xdense ? " xdense" : ""}">
        ${trendRingSvg(doms.map((x) => ({ v: x.total, color: TREND_DOMAIN_COLOR[x.name], label: x.name })), xdense ? 100 : dense ? 116 : 150, xdense ? 20 : dense ? 22 : 26, `${st.grand}`, "문항")}
        <div class="tv-domlist">${doms.map((x) => `
          <div class="tv-dk2"><i style="background:${TREND_DOMAIN_COLOR[x.name]}"></i></div>
          <div class="tv-dn">${esc(x.name)}</div>
          <div class="tv-dv"><b>${x.total}</b>문항 <span>${pct(x.total, st.grand)}%</span></div>
          <div class="tv-dk">${x.kinds.map(esc).join(", ")}</div>`).join("")}
        </div>
      </div>`;
  return `
    <div class="trend-dash">
      <div class="trend-tiles ${cv ? "t4" : "t3"}">${tiles}</div>
      <h5>영역별 출제 비중</h5>
      ${domHtml}
      <h5>유형별 문항 수 </h5>
      <div class="tv-grid">${panel(mcRows, "선택형", TREND_MC_COLOR)}${panel(subRows, "서술형", TREND_DOMAIN_COLOR["서술형"])}</div>
    </div>`;
}

/* 그래프 뒤 덩어리 — 범위별 출제율과 해마다의 유형 변화. 1쪽에 그래프를 모두 담으면 A4 한 장을
   넘기므로(표지·핵심 요약과 함께) 이 둘은 2쪽 머리로 보낸다. 둘 다 없으면(범위 없음 · 시험지
   한 부) 빈 문자열이다. */
function trendDashExtraHtml(st, cv) {
  const pct = (a, b) => (b ? Math.round((a / b) * 100) : 0);
  const cov = [...trendGroupStats(cv)].map(([name, g]) => `
      <div class="tv-cl">${esc(name)}</div>
      <div class="tv-track"><div class="tv-fill" style="width:${pct(g.used, g.total)}%"></div></div>
      <div class="tv-v">${g.used}/${g.total}개<small> · ${pct(g.used, g.total)}%</small></div>`).join("");
  if (!cov) return "";
  return `
    <div class="trend-dash">
      <h5 style="margin-top:0">범위별 출제된 지문</h5>
      <div class="tv-cov">${cov}</div>
    </div>`;
}

function trendCoverageHtml(cv) {
  if (!cv) return "";
  const docs = cv.names.length;
  const used = cv.rows.filter((r) => r.count > 0).length;
  /* 단원별 묶음 — 저장함 제목(교재·단원)마다 지문 몇 개 중 몇 개가 나왔는지. 단원이
     둘 이상일 때만 보여 준다(하나면 위 요약과 같은 말이다). 이름 칸에는 묶음 이름을 빼고
     지문 이름만 남겨 표가 덜 붐비게 한다. */
  const groups = trendGroupStats(cv);
  /* 범위(저장본)별 '몇 개 중 몇 개' 표는 두지 않는다 — 한눈에 보기의 범위별 그래프와
     같은 숫자다(인쇄하면 두 쪽에 같은 것이 겹쳐 나왔다). */
  const grouped = groups.size > 1;
  const rowName = (r) => (grouped && r.group ? r.label.slice(r.group.length).replace(/^\s*·\s*/, "") : r.label);
  const outN = cv.outside.reduce((a, o) => a + o.length, 0);
  const unread = cv.names.filter((_n, i) => !cv.read[i]);
  // 칸 하나에 한 줄로 — "16번 · 빈칸 추론". 두 줄로 쓰면 줄마다 높이가 두 배가 된다.
  const cell = (hits, ok) => {
    if (!ok) return `<td class="zero">—</td>`;
    if (!hits.length) return `<td class="zero">·</td>`;
    const nos = hits.map((h) => esc(String(h.label).replace(/번$/, ""))).join("·");
    const kinds = [...new Set(hits.flatMap((h) => h.kinds))];
    return `<td class="hit tk"><b>${nos}번</b>${kinds.length ? ` <span class="qk">· ${kinds.map(esc).join(", ")}</span>` : ""}</td>`;
  };
  const covShort = trendShortNames(cv.names);
  const heads = cv.names.map((nm, i) => `<th title="${esc(nm)}">${esc(covShort[i].length > 18 ? covShort[i].slice(0, 17) + "…" : covShort[i])}</th>`).join("");
  const cols = 1 + cv.names.length + (docs > 1 ? 1 : 0);

  /* 표에는 출제된 지문만 싣는다. 안 나온 지문은 표 아래에 범위별로 한 줄씩 모은다 —
     안 나온 지문까지 줄을 차지하면 표가 두 배로 길어지고, 정작 보려는 '어디서 나왔나'가
     빈 줄 사이에 묻힌다(인쇄하면 세 쪽이 넘었다).
     범위를 여럿 넣었으면 합친 칸(rowspan) 대신 범위마다 머리줄을 둔다 — 합친 칸은 인쇄할 때
     쪼개지지 않아, 18줄짜리 범위가 통째로 다음 쪽으로 밀리며 앞 쪽이 비었다. */
  const shown = cv.rows.filter((r) => r.count > 0);
  let lastGroup = null;
  const body = shown.map((r) => {
    let head = "";
    if (grouped && trendGroupKey(r) !== lastGroup) {
      lastGroup = trendGroupKey(r);
      const g = groups.get(lastGroup);
      head = `<tr class="grp"><td colspan="${cols}">${esc(lastGroup)}${g ? ` <span class="qk">· ${g.used}/${g.total}개 출제</span>` : ""}</td></tr>`;
    }
    return `${head}
    <tr>
      <td class="tk">${esc(rowName(r))}</td>
      ${r.hits.map((h, i) => cell(h, cv.read[i])).join("")}
      ${docs > 1 ? `<td><b>${r.count}</b></td>` : ""}
    </tr>`;
  }).join("");

  // 안 나온 지문 — 범위별로 묶어 이름만 늘어놓는다
  const missing = new Map();
  cv.rows.filter((r) => r.count === 0).forEach((r) => {
    const key = grouped ? trendGroupKey(r) : "";
    if (!missing.has(key)) missing.set(key, []);
    missing.get(key).push(rowName(r));
  });
  const missingHtml = missing.size ? `
    <h5 class="trend-miss-h">출제되지 않은 범위 지문 (${cv.rows.length - used}개)</h5>
    <ul class="trend-miss">${[...missing].map(([g, names]) =>
      `<li>${g ? `<b>${esc(g)}</b> — ` : ""}${names.map(esc).join(", ")}</li>`).join("")}</ul>` : "";

  const outList = cv.names.map((nm, i) => cv.outside[i].length
    ? `${esc(nm)} ${cv.outside[i].map((h) => esc(h.label)).join("·")}` : "").filter(Boolean).join(" / ");
  return `
    <h4 class="trend-pg sec">시험 범위 지문별 출제 현황</h4>
    <div class="trend-summary">
      시험 범위 지문 <b>${cv.rows.length}개</b> 중 <b>${used}개</b>가 출제됐고, <b>${cv.rows.length - used}개</b>는 나오지 않았습니다.
      ${outN ? `시험지 지문 중 <b>${outN}개</b>는 범위에서 찾지 못했습니다(범위 밖 지문이거나 많이 바뀐 지문).` : ""}
      ${unread.length ? `<br><span class="trend-sub">출제 지문을 읽지 않은 부: ${unread.map(esc).join(", ")} — 표에 “—”로 나옵니다.</span>` : ""}
      <br><span class="trend-sub">글자 겹침으로 짝을 지은 결과입니다. 지문을 크게 바꿔 낸 문항은 못 찾을 수 있으니 확인해 주세요.</span>
    </div>
    ${shown.length ? `<div style="overflow-x:auto"><table class="trend-cov">
      <thead><tr><th>출제된 범위 지문</th>${heads}${docs > 1 ? "<th>출제 횟수</th>" : ""}</tr></thead>
      <tbody>${body}</tbody>
    </table></div>` : ""}
    ${missingHtml}
    ${outN ? `<p class="trend-sub" style="margin-top:8px">범위에서 찾지 못한 시험지 지문: ${outList}</p>` : ""}`;
}

/* ── 영역 — 유형을 다섯 갈래로 묶는다 ──
   유형 스무 가지를 나열만 하면 '이 학교는 무엇을 중시하나'가 안 보인다. 교육 쪽 분석
   보고서가 흔히 쓰는 틀(대의 파악 · 세부 정보 · 논리·흐름 · 어법·어휘 · 서술형)로 묶는다.
   유형 이름은 server.py EXAM_REPORT_CATEGORIES와 같아야 한다. 목록 밖(예전 방식으로
   읽은 저장본의 유형 이름)은 '기타'로 센다. */
const TREND_DOMAINS = [
  ["대의 파악", ["주제·제목", "요지·주장", "글의 목적", "심경·분위기", "함축 의미"]],
  ["세부 정보", ["내용 일치·불일치", "대화문 내용 파악", "지칭 대상"]],
  ["논리·흐름", ["빈칸 추론", "연결어", "순서 배열", "문장 삽입", "무관한 문장", "요약문 완성", "대화 흐름·응답"]],
  ["어법·어휘", ["어법", "어휘·낱말 쓰임", "단어 뜻·영영풀이", "영어 표현 고르기"]],
];
function trendDomainOf(label) {
  if (/^서술형/.test(label)) return "서술형";
  const hit = TREND_DOMAINS.find(([, kinds]) => kinds.includes(label));
  return hit ? hit[0] : "기타";
}
function trendDomains(st) {
  const order = [...TREND_DOMAINS.map(([n]) => n), "서술형", "기타"];
  const map = new Map(order.map((n) => [n, { name: n, total: 0, kinds: [] }]));
  st.list.forEach((r) => {
    const d = map.get(trendDomainOf(r.label));
    d.total += r.total;
    d.kinds.push(r.label.replace(/^서술형:\s*/, ""));
  });
  return [...map.values()].filter((d) => d.total > 0);
}

// 출제 지문의 출처 — 범위 칸 이름(저장본 제목)으로 가른다. 모의고사 / 교과서·부교재 / 범위 밖
function trendSources(cv) {
  if (!cv) return null;
  const out = { "모의고사": 0, "교과서·부교재": 0, "범위 밖": 0 };
  cv.rows.forEach((r) => {
    const n = r.hits.reduce((a, h) => a + h.length, 0);
    if (!n) return;
    out[/모의/.test(r.group || r.label) ? "모의고사" : "교과서·부교재"] += n;
  });
  out["범위 밖"] = cv.outside.reduce((a, o) => a + o.length, 0);
  return out;
}

// 핵심 요약 — AI를 부르지 않고 숫자에서 바로 뽑는다(보고서를 펼치면 가장 먼저 읽는 자리)
function trendKeyFindings(st, cv) {
  const pct = (a, b) => `${b ? Math.round((a / b) * 100) : 0}%`;
  const out = [];
  const top = st.list.slice(0, 3);
  const top3 = top.reduce((a, r) => a + r.total, 0);
  out.push(`가장 많이 출제된 유형은 <b>${esc(top[0].label)}</b>(${top[0].total}문항, ${pct(top[0].total, st.grand)})이며, 상위 ${top.length}개 유형이 전체의 <b>${pct(top3, st.grand)}</b>를 차지합니다.`);
  const doms = trendDomains(st).slice().sort((a, b) => b.total - a.total);
  out.push(`영역별로는 ${doms.slice(0, 3).map((d, i) => `${i ? "" : "<b>"}${esc(d.name)} ${d.total}문항(${pct(d.total, st.grand)})${i ? "" : "</b>"}`).join(" › ")} 순으로 비중이 높습니다.`);
  if (st.subTotal) {
    const subTop = st.list.find((r) => /^서술형/.test(r.label));
    out.push(`서답형은 <b>${st.subTotal}문항(${pct(st.subTotal, st.grand)})</b>이며, 그중 ${esc(subTop.label.replace(/^서술형:\s*/, ""))} 유형이 ${subTop.total}문항으로 가장 많습니다.`);
  } else {
    out.push(`서답형 없이 <b>선다형 ${st.grand}문항</b>으로만 구성되었습니다.`);
  }
  if (cv) {
    const used = cv.rows.filter((r) => r.count > 0).length;
    const src = trendSources(cv);
    const parts = Object.entries(src).filter(([, n]) => n > 0).map(([k, n]) => `${k} ${n}개`);
    out.push(`시험 범위 지문 ${cv.rows.length}개 중 <b>${used}개(${pct(used, cv.rows.length)})</b>가 출제되었고, 시험지 지문의 출처는 ${parts.join(" · ")}입니다.`);
  }
  if (st.docs > 1) {
    const every = st.list.filter((r) => r.cls === "every");
    out.push(`시험지 ${st.docs}부에 <b>모두 출제된 유형은 ${every.length}가지</b>${every.length ? `(${every.slice(0, 4).map((r) => esc(r.label)).join(", ")}${every.length > 4 ? " 등" : ""})` : ""}입니다.`);
    const ch = trendChangeSummary(st), sn = trendShortNames(st.names);
    const nm = (list) => list.slice(0, 3).map((r) => `${esc(r.label)} ${r.a}→${r.b}`).join(", ") + (list.length > 3 ? " 등" : "");
    out.push(ch.up.length || ch.down.length
      ? `${esc(sn[0])} 대비 ${esc(sn[st.docs - 1])}에서 ${ch.up.length ? `<b>늘어난 유형</b>은 ${nm(ch.up)}` : "늘어난 유형은 없고"}${ch.down.length ? `, <b>줄어든 유형</b>은 ${nm(ch.down)}` : ", 줄어든 유형은 없"}입니다.`
      : `처음과 마지막 시험지의 유형별 문항 수가 같습니다.`);
  }
  return out;
}

function trendHtml(st, ai) {
  if (!st || !st.list.length) {
    return `<div class="trend-report"><p class="trend-empty">집계할 문항 유형이 없습니다.</p></div>`;
  }
  const pct = (v) => `${(v * 100).toFixed(v >= 0.1 ? 0 : 1)}%`;
  const maxShare = Math.max(...st.list.map((r) => r.share)) || 1;
  const tagLabel = { every: "매회 출제", some: "가끔 출제", once: "한 번만" };
  const shortNames = trendShortNames(st.names);
  const heads = st.names
    .map((nm, i) => `<th title="${esc(nm)}">${esc(shortNames[i].length > 12 ? shortNames[i].slice(0, 11) + "…" : shortNames[i])}</th>`)
    .join("");
  const body = st.list.map((r) => `
    <tr>
      <td class="tk">${esc(r.label)}</td>
      ${r.per.map((v) => `<td class="${v ? "" : "zero"}">${v || "·"}</td>`).join("")}
      <td><b>${r.total}</b></td>
      <td>${pct(r.share)}</td>
      <td class="tbarcell"><span class="tbar" style="width:${Math.max(2, Math.round((r.share / maxShare) * 100))}%;background-color:${trendColorOf(r.label)}"></span></td>
      <td>${r.cls ? `<span class="tag ${r.cls}">${tagLabel[r.cls]}</span>` : ""}</td>
    </tr>`).join("");
  const cv = trendCoverage();
  const mc = st.grand - st.subTotal;

  /* 머리 — 보고서 표지 정보. 제목 한 줄보다 '누구의 무엇을 언제 분석했나'가 표로 먼저
     보여야 보고서로 읽힌다. */
  const d = new Date();
  const today = `${d.getFullYear()}. ${d.getMonth() + 1}. ${d.getDate()}.`;
  const head = `
    <div class="rp-head">
      <div class="rp-kicker">출제경향 분석 보고서</div>
      <h3>${esc(trendSchool() || "출제경향 분석")}</h3>
      <table class="rp-meta">
        <tr><th>학년 · 과목</th><td>${esc(trendSubject() || "—")}</td><th>작성일</th><td>${today}</td></tr>
        <tr><th>분석 대상</th><td colspan="3">${st.names.map((nm) => esc(nm)).join(" · ")}${st.docs > 1 ? ` (${st.docs}부)` : ""}</td></tr>
        <tr><th>총 문항</th><td>${st.grand}문항 (선다형 ${mc} · 서답형 ${st.subTotal})</td><th>출제 유형</th><td>${st.list.length}가지</td></tr>
      </table>
    </div>`;

  const findings = `
    <h4 class="sec">핵심 요약</h4>
    <ol class="rp-find">${trendKeyFindings(st, cv).map((t) => `<li>${t}</li>`).join("")}</ol>`;

  // 대비 전략은 표로 — 유형 · 출제 문항 · 전략. 글머리표 나열보다 한눈에 견줘진다
  const countOf = (kind) => {
    const r = st.list.find((x) => x.label === kind || x.label.replace(/^서술형:\s*/, "") === kind);
    return r ? `${r.total}문항` : "";
  };
  const aiHtml = ai ? `
      <h4 class="sec">시험지 분석 총평</h4>
      <p class="rp-body">${esc(ai.overview)}</p>
      ${ai.strategies.length ? `<h4 class="sec">유형별 대비 전략</h4>
      <table class="rp-strat">
        <thead><tr><th>유형</th><th>출제</th><th>대비 전략</th></tr></thead>
        <tbody>${ai.strategies.slice(0, 6).map((s) => `<tr><td class="tk"><b>${esc(s.kind)}</b></td><td>${countOf(s.kind)}</td><td class="tk">${esc(s.advice)}</td></tr>`).join("")}</tbody>
      </table>` : ""}` : "";
  return `
    <div class="trend-report">
      ${head}
      <h4 class="sec">한눈에 보는 출제 현황</h4>${trendDashHtml(st, cv)}
      ${(() => {
        /* 1쪽은 표지와 그래프만 — 그림이 먼저 눈에 들어오게(2026-09-29 사용자 요청).
           핵심 요약까지 1쪽에 넣으면 A4를 약 100px 넘겨(실측 1117/1017) 2쪽 머리로 보낸다.
           2쪽: 핵심 요약 → 지문 출처(범위 게이지) → 총평 → 대비 전략.
           시험지가 둘 이상이면 다음 쪽이 '시험지별 유형 변화'(모든 유형의 꺾은선 + 늘고 준 유형)와
           유형 출제 현황 표다(2026-09-30 — 꺾은선을 2쪽에서 이 쪽으로 옮겼다). */
        const extra = trendDashExtraHtml(st, cv);
        return `<div class="trend-pg">
          ${findings}
          ${extra ? `<h4 class="sec">지문 출처</h4>${extra}` : ""}
          ${aiHtml}
        </div>`;
      })()}
      ${st.docs > 1 ? `<div class="trend-pg">
      <h4 class="sec">시험지별 유형 변화</h4>${trendChangeHtml(st)}
      <h4 class="sec">시험지별 유형 출제 현황</h4>
      <div style="overflow-x:auto"><table>
        <thead><tr><th>유형</th>${heads}<th>합계</th><th>비율</th><th>비중</th><th>구분</th></tr></thead>
        <tbody>${body}</tbody>
      </table></div></div>` : ""}
      ${trendCoverageHtml(cv)}
      <div class="rp-note"><b>유의 사항</b>
        <p>이 보고서의 문항 유형 분류와 시험 범위 지문 대조는 AI가 시험지 이미지를 읽어 만든 결과이므로 일부 오류가 있을 수 있습니다. 중요한 판단에는 원본 시험지와 함께 확인해 주십시오.</p>
        ${ai && ai.caution ? `<p>${esc(ai.caution)}</p>` : ""}
      </div>
    </div>`;
}

/* ── 학원 마크 ──
   학원명·우하단 로고·워터마크는 다른 탭과 같은 것(학원 마크 칸, app.js BRAND_*_STORE)을 쓴다.
   보고서는 새 창에서 인쇄하므로 본문 쪽의 .print-foot·#printWatermark가 따라오지 않아 여기서
   따로 그린다. 켜고 끄는 칸은 없다 — 넣은 것만 찍힌다(2026-09-29 사용자): 학원명·로고가 있으면
   아래쪽(학원명 왼쪽·로고 오른쪽), 워터마크 이미지가 있으면 뒷배경. 화면 보고서에는 그리지 않는다. */
function trendBrand() {
  let img = "", name = "", wm = "";
  try {
    img = localStorage.getItem(BRAND_IMG_STORE) || "";
    name = (localStorage.getItem(BRAND_NAME_STORE) || "").trim();
    wm = localStorage.getItem(BRAND_WM_STORE) || "";
  } catch (_) { /* 저장소가 막힌 브라우저 — 마크 없이 인쇄한다 */ }
  return { img, name, wm };
}
/* 학원 마크 칸(app.js의 .brand-panel)은 한 벌뿐이라 syncTabChrome이 아래
   #trendBrandSlot으로 옮겨 온다. 보고서를 다시 그리면(innerHTML) 그 안의 칸이 함께 지워지므로
   trendRender가 그리기 전에 원래 자리로 돌려놓는다. */
function trendBrandOptsHtml() {
  return `<div id="trendBrandSlot" class="trend-brand-slot"></div>`;
}

function trendRender() {
  const st = trendStats();
  moveBrandPanel(null);   // 학원 마크 칸을 보고서 밖으로 꺼내 둔다(다시 그리면 지워지므로)
  const onTrend = () => { if ($("tab-trend").classList.contains("active")) syncTabChrome("trend"); };
  if (!st) { trendResultEl.innerHTML = ""; onTrend(); return; }
  trendResultEl.innerHTML = `
    <section class="panel exam-report">
      ${trendHtml(st, trendAi)}
      ${trendAi && trendAiStale ? `<p class="hint" style="color:#8a5a12">⚠️ 총평을 쓴 뒤에 시험지나 시험 범위가 바뀌었습니다 — 총평은 예전 내용을 기준으로 쓴 것입니다. 새로 쓰려면 [✨ 총평 다시 쓰기]를 누르세요.</p>` : ""}
      <p class="hint" id="trendAiErr" style="color:#c0392b"></p>
      ${trendBrandOptsHtml()}
      <div class="trend-tools">
        <button type="button" class="btn small" id="trendAiBtn">${trendAi ? "✨ 총평 다시 쓰기" : "✨ 시험지 분석 총평 쓰기"}</button>
        <button type="button" class="btn ghost small" id="trendPrintBtn">🖨 인쇄 / PDF 저장</button>
        <button type="button" class="btn ghost small" id="trendSaveBtn">💾 분석 저장</button>
      </div>
    </section>`;
  $("trendAiBtn").addEventListener("click", () => trendRunAi(false));
  onTrend();
  $("trendPrintBtn").addEventListener("click", trendPrint);
  $("trendSaveBtn").addEventListener("click", () => openSaveDialog("trend"));
}

/* ── AI 글 ── */
async function trendRunAi(auto) {
  const st = trendStats();
  const btn = $("trendAiBtn");
  const errEl = $("trendAiErr");
  if (!st || !btn) return;
  errEl.textContent = "";
  const won = (PRICING && PRICING.examTrend) || 0;
  if (!auto && won > 0 && !(await costConfirmed(won, "AI가 출제경향 총평과 대비 전략을 씁니다.", 1))) return;
  btn.disabled = true;
  const label = btn.textContent;
  btn.textContent = "쓰는 중…";
  try {
    const res = await postGenerate("/api/examtrend", {
      data: {
        docs: st.names,
        kinds: st.list.map((r) => ({ kind: r.label, per: r.per })),
        unmade: st.unmadeTotal,
        passages: (() => {
          const cv = trendCoverage();
          return cv ? cv.rows.map((r) => ({ name: r.label, per: r.hits.map((h) => h.length) })) : [];
        })(),
      },
    }, "보고서 글을 만들지 못했습니다.");
    trendAiStale = false;
    trendAi = {
      overview: String(res.overview || ""),
      strategies: Array.isArray(res.strategies) ? res.strategies : [],
      caution: String(res.caution || ""),
    };
    trendRender();
    if (typeof refreshTokenDisplay === "function") refreshTokenDisplay();
  } catch (err) {
    errEl.textContent = err.message || String(err);
    btn.disabled = false;
    btn.textContent = label;
  }
}

/* 인쇄 창의 학원 마크.
   아래쪽: 쪽 바닥에 position:fixed로 두면 크롬이 쪽마다 같은 자리에 되풀이해 그린다 — 앱 본문의
   tfoot 방식은 '그 쪽 내용이 끝난 자리'에 붙어, 이 보고서처럼 쪽을 일부러 끊으면(1·2쪽) 로고가
   쪽 중간에 뜬다. 다만 fixed는 자리를 차지하지 않아 내용이 넘어가는 쪽(범위 표)에서 글과
   겹치므로, 같은 높이의 빈 tfoot을 깔아 쪽마다 그만큼을 비워 둔다.
   그만큼 쪽 높이가 줄어 1쪽 그래프가 넘칠 수 있어 보고서를 조금(zoom .95) 줄인다 — 쪽마다
   A4 한 장에 드는지 잰 값이다(1쪽 가장 빽빽할 때 약 1003px × .95 + 바닥 34px ≤ 1017).
   워터마크: 쪽 전체(여백 안쪽)에 비율을 지켜 가득 차게 fixed로 깔고(2026-09-29 사용자 — 가운데 62%는 작았다), 글 위에 아주 옅게 얹는다(아래에 깔면 흰 칸·표
   배경에 가려 보이지 않는다). multiply로 섞어 JPG 로고의 흰 바탕은 사라지게 한다. */
function trendBrandPrintCss(foot) {
  return `
    .rp-foot{position:fixed;left:0;right:0;bottom:0;height:9mm;display:flex;justify-content:space-between;
      align-items:flex-end;font-family:"Malgun Gothic","맑은 고딕",sans-serif;font-weight:700;font-size:11px;color:#1b2430}
    .rp-foot img{max-height:8mm;max-width:38mm;object-fit:contain}
    .rp-frame{width:100%;border-collapse:collapse}.rp-frame td{padding:0}
    .rp-foot-space{height:9mm}
    .rp-wm{position:fixed;top:0;left:0;width:100%;height:100%;
      object-fit:contain;opacity:.07;mix-blend-mode:multiply;pointer-events:none;z-index:5}
    ${foot ? ".rp-frame .trend-report{zoom:.95}" : ""}`;
}
function trendBrandPrintBody(report, foot, wm) {
  let body = report;
  if (foot) {
    body = `<table class="rp-frame"><tbody><tr><td>${report}</td></tr></tbody>
      <tfoot><tr><td><div class="rp-foot-space"></div></td></tr></tfoot></table>
      <div class="rp-foot"><span>${esc(foot.name)}</span>${foot.img ? `<img src="${esc(foot.img)}" alt="">` : "<span></span>"}</div>`;
  }
  if (wm) body += `<img class="rp-wm" src="${esc(wm)}" alt="">`;
  return body;
}

// 새 창에 보고서만 담아 인쇄한다 — 이 탭의 업로드 칸·버튼과 섞이지 않는다
function trendPrint() {
  const st = trendStats();
  const errEl = $("trendAiErr");
  if (!st) return;
  const w = window.open("", "_blank");
  if (!w) {
    if (errEl) errEl.textContent = "팝업이 막혀 인쇄 창을 열지 못했습니다. 이 사이트의 팝업을 허용해 주세요.";
    return;
  }
  const brand = trendBrand();
  // 넣은 것만 찍는다 — 학원명·로고가 있으면 아래쪽, 워터마크 이미지가 있으면 뒷배경
  const foot = brand.img || brand.name ? brand : null;
  const wm = brand.wm;
  w.document.write(`<!doctype html><html lang="ko"><head><meta charset="utf-8">
    <title>${esc(sanitizeFilename([trendSchool(), trendSubject(), "출제경향_보고서"].filter(Boolean).join("_")))}</title>
    <style>@page{size:A4;margin:14mm}body{margin:0;padding:0}${TREND_CSS}
    .trend-report{-webkit-print-color-adjust:exact;print-color-adjust:exact}
    .trend-report tr{break-inside:avoid}.trend-report h4{break-after:avoid}
    .trend-pg{break-before:page}
    /* 한 장에 들어가도록 잰 값이다(2026-09-29, A4 폭 687px에서 1쪽 약 940 · 2쪽 약 960 / 한 장 1017).
       키우면 2쪽이 넘쳐 그래프가 두 장으로 갈린다 — 바꾸면 다시 잴 것. */
    .trend-dash{padding:16px 20px}
    .trend-dash h5{margin:16px 0 8px;font-size:14px}
    .trend-tile b{font-size:26px}.trend-tile b.sm{font-size:19px}
    .tv-bars{font-size:13px;gap:7px 12px}.tv-bar{height:15px}
    .tv-bars.many{gap:4px 12px}.tv-bars.many .tv-bar{height:12px}
    .tv-bars.dense{gap:2px 12px;font-size:12px;line-height:16px}.tv-bars.dense .tv-bar{height:11px}
    .tv-bars.xdense{gap:1px 12px;font-size:11.5px;line-height:15px}.tv-bars.xdense .tv-bar{height:10px}
    .tv-domwrap.xdense .tv-domlist{gap:3px 10px}
    .tv-ph{font-size:13.5px}
    .tv-cov{font-size:13px;gap:8px 12px}.tv-track{height:12px}
    .tv-dom{font-size:13px;gap:6px 12px}.tv-bar.dom{height:14px}
    .trend-report .rp-strat td{padding:4px 8px}
    .rp-find{padding:8px 14px 8px 34px}
    ${trendBrandPrintCss(foot)}</style></head>
    <body>${trendBrandPrintBody(trendHtml(st, trendAi), foot, wm)}</body></html>`);
  w.document.close();
  w.focus();
  // 글꼴이 자리 잡은 뒤에 인쇄 대화상자를 연다
  setTimeout(() => { try { w.print(); } catch (_) { /* 사용자가 창을 닫았다 */ } }, 300);
}

/* ── 시험 범위 지문 입력 ──
   동형 모의고사의 시험 범위 칸과 똑같은 지문 입력칸(createPassageManager)을 쓴다 — 지문마다
   이름을 달고(보고서에 그 이름으로 나온다), 합치기·나누기, 지문 저장, 저장함·PDF에서
   가져오기가 다른 칸과 같은 방식으로 된다. 상한도 시험 범위 칸과 같은 EXAM_PAPER_MAX_PASSAGES. */
const trendRangePanelEl = $("trendRangePanel");
const trendRangeStatusEl = $("trendRangeStatus");
function trendRangeStatus(msg, kind) {
  trendRangeStatusEl.hidden = !msg;
  trendRangeStatusEl.innerHTML = msg || "";   // app.js의 안내 문구(<b> 포함)를 그대로 받는다
  trendRangeStatusEl.className = "exam-status" + (kind ? " " + kind : "");
}
const trendRangeMgr = createPassageManager(
  $("trendRangeList"),
  $("trendRangeAddBtn"),
  $("trendRangeCount"),
  () => trendRunBtn.click(),
  $("trendRangeMaxNote"),
  EXAM_PAPER_MAX_PASSAGES
);
trendRangeMgr.addRow(false);
// PDF를 칸에 끌어다 놓으면 지문을 꺼내 넣는다(사진은 받지 않는다 — 위 시험지 칸과 헷갈린다)
wirePassageDrop(trendRangePanelEl, trendRangeMgr, trendRangeStatus);

// 보고서에 쓰는 범위 지문 — 너무 짧은 칸(쓰다 만 것)은 대조에서 뺀다
const trendRangeJobs = () => trendRangeMgr.getJobs().filter((j) => j.text.length >= 40);

/* 칸을 고치면 보고서를 다시 그린다. 글자를 칠 때마다 그리면 느리므로 잠깐 멈췄을 때 한 번.
   AI 글은 지문 '내용'이 바뀌었을 때만 지운다 — 이름만 고친 것으로 다시 쓰게 할 까닭이 없다. */
let trendRangeTimer = null;
let trendRangeSig = "";
function trendRangeChanged() {
  clearTimeout(trendRangeTimer);
  trendRangeTimer = setTimeout(() => {
    const sig = trendRangeJobs().map((j) => passageKey(j.text, false) + passageKey(j.text, true)).join("|");
    if (sig !== trendRangeSig) { trendRangeSig = sig; if (trendAi) trendAiStale = true; }
    // 부 목록·[분석하기]까지 다시 맞춘다 — 분석 뒤에 범위를 넣으면 지문 읽기만 이어서 할 수 있다
    trendSync();
  }, 400);
}
$("trendRangeList").addEventListener("input", trendRangeChanged);
new MutationObserver(trendRangeChanged).observe($("trendRangeList"), { childList: true });

$("trendRangeSaveBtn").addEventListener("click", () => {
  passageSaveFrom = { mgr: trendRangeMgr, grammarEl: null, label: "시험 범위 지문 칸" };
  openSaveDialog(PASSAGE_TAB);
});
$("trendRangeLoadBtn").addEventListener("click", () => {
  openSavedList("passage", {
    mgr: trendRangeMgr,
    label: "시험 범위 지문 칸",
    after: (msg) => trendRangeStatus(msg, "ok"),
    /* 저장본 제목(예: "공통영어2 비상(홍) 1단원 본문")을 지문 이름 앞에 붙인다 — 선생님이
       저장함에 단원·교재 이름으로 저장해 두므로, 그 이름이 곧 '어느 범위의 지문인가'다.
       보고서는 " · " 앞부분으로 단원별 출제 수를 묶는다(trendCoverageHtml). */
    prepare: (list, item) => {
      const title = String(item.title || "").replace(/\s*·\s*/g, " ").trim();
      if (!title) return list;
      return list.map((j, i) => {
        const own = j.named && j.name ? String(j.name).trim() : `지문 ${i + 1}`;
        return { ...j, name: `${title} · ${own}`, named: true };
      });
    },
  });
});
const trendRangePdfFileEl = $("trendRangePdfFile");
$("trendRangePdfBtn").addEventListener("click", () => trendRangePdfFileEl.click());
trendRangePdfFileEl.addEventListener("change", () => {
  if (trendRangePdfFileEl.files && trendRangePdfFileEl.files.length) {
    runPdfImport(trendRangePdfFileEl.files, trendRangeMgr, trendRangeStatus);
  }
  trendRangePdfFileEl.value = "";
});
$("trendRangeClearBtn").addEventListener("click", () => {
  if (confirm("입력한 시험 범위 지문을 모두 지우시겠습니까?\n되돌릴 수 없습니다.")) {
    trendRangeMgr.clearAll();
    trendRangeStatus("");
  }
});
trendReadPassagesEl.addEventListener("change", trendSync);
// 목록 아래의 같은 단추들 — 위 단추를 대신 눌러 준다(동작을 두 벌 두지 않으려고)
document.querySelectorAll("[data-trend-proxy]").forEach((b) => {
  b.addEventListener("click", () => { const t = $(b.dataset.trendProxy); if (t) t.click(); });
});

/* ── 저장 · 불러오기 · 새로 시작 ── */
const trendHasWork = () => trendDocs.length > 0;

function trendReset() {
  trendDocs = [];
  trendAi = null;
  trendErrorEl.textContent = "";
  delete LOADED_SAVED.trend;   // 새로 시작했으니 이전 저장본을 고치는 중이 아니다
  trendSync();
}

$("trendResetBtn").addEventListener("click", () => {
  if (trendBusy) { alert("분석이 진행 중입니다. 끝난 뒤에 눌러 주세요."); return; }
  if (trendHasWork() && !confirm("올린 시험지와 분석 결과가 모두 사라집니다(시험 범위 지문은 남습니다).\n아직 저장하지 않았다면 [취소]를 누르고 먼저 저장하세요.\n\n지우고 새로 시작할까요?")) return;
  trendReset();
});
$("trendLoadBtn").addEventListener("click", () => { trendLoadMode = "replace"; openSavedList("tab", null, "trend"); });
$("trendAddSavedBtn").addEventListener("click", () => { trendLoadMode = "append"; openSavedList("tab", null, "trend"); });

TAB_LABELS.trend = "📊 시험지 분석";
TAB_LIBRARY_WORDS.trend = {
  title: "📊 시험지 분석 저장함",
  lead: "저장해 둔 시험지 분석입니다. [불러오기]를 누르면 시험지를 다시 올리거나 분석하지 않고 그 보고서를 바로 볼 수 있습니다. 여러 개를 합쳐 보려면 탭의 [➕ 저장한 분석 더하기]로 하나씩 이어 붙이세요.",
  empty: "아직 저장한 시험지 분석이 없습니다. 시험지를 분석한 뒤 “💾 분석 저장”을 눌러 보세요.",
};
SAVE_TITLE_SUGGEST.trend = () => {
  const names = trendDocs.filter((d) => d.questions).map((d) => d.name);
  const label = names.length === 1 ? sanitizeFilename(names[0]) : names.length ? `${names.length}부` : "";
  return ["시험지분석", sanitizeFilename(trendSchool()), sanitizeFilename(trendSubject()) || label, todayStr()]
    .filter(Boolean).join("_");
};

TAB_SAVE.trend = {
  // saveBtn을 등록하지 않는다 — app.js가 로드될 때 한 번만 단추를 연결하는데 이 파일은 그 뒤에 로드된다.
  // 대신 보고서의 [💾 분석 저장]이 openSaveDialog("trend")를 직접 부른다.
  canSave: () => (trendDocs.some((d) => d.questions) ? "" : "먼저 시험지를 분석해 주세요."),
  saveLead: () => "분석한 시험지의 문항 유형표·출제 지문, 시험 범위 지문, AI 글을 저장합니다(시험지 그림은 저장하지 않습니다). " +
                  "나중에 “📂 저장한 분석 불러오기”로 다시 열 수 있습니다.",
  getPayload: () => ({
    v: 2,
    school: trendSchool(),
    subject: trendSubject(),
    docs: trendDocs.filter((d) => d.questions)
      .map((d) => ({ name: d.name, questions: d.questions, passages: d.passages || null })),
    range: trendRangeJobs().map((j) => ({ name: j.name, named: j.named, text: j.text })),
    ai: trendAi,
  }),
  // loadSavedItem이 탭을 바꾸기 전에 부른다 — false면 불러오기를 멈춘다
  beforeLoad: () => {
    if (trendBusy) { alert("분석이 진행 중입니다. 끝난 뒤에 불러와 주세요."); return false; }
    if (trendLoadMode === "replace" && trendHasWork()) {
      return confirm("지금 화면의 시험지와 분석 결과가 사라지고 저장본으로 바뀝니다.\n아직 저장하지 않았다면 [취소]를 누르고 먼저 저장하세요.\n\n불러올까요?");
    }
    return true;
  },
  applyPayload: (payload) => {
    const incoming = (payload.docs || []).filter((d) => Array.isArray(d.questions) && d.questions.length)
      .map((d) => ({ ...newTrendDoc(String(d.name || "시험지").slice(0, 40)), pages: null, nameEdited: true,
                     questions: d.questions, passages: Array.isArray(d.passages) ? d.passages : null }));
    const range = (payload.range || []).filter((j) => j && String(j.text || "").trim());
    const append = trendLoadMode === "append";
    let dropped = 0;
    if (append) {
      const room = Math.max(0, TREND_MAX_DOCS - trendDocs.length);
      dropped = Math.max(0, incoming.length - room);
      trendDocs = trendDocs.concat(incoming.slice(0, room));
      /* 범위는 가져오지 않는다 — 이어 붙이는 것은 대개 다른 해·다른 회차 시험지라 범위가
         서로 다르다. 섞어 넣으면 "어느 범위 지문이 나왔나" 표가 엉뚱한 지문끼리 짝짓는다.
         지금 칸에 넣어 둔 범위는 그대로 둔다. */
      if (trendAi) trendAiStale = true;   // 합친 뒤에는 [총평 다시 쓰기]로 새로 쓴다
      // 이어 붙인 것은 어느 저장본도 아니다 — loadSavedItem이 이 함수 뒤에 기억해 두므로 그 뒤에 지운다
      setTimeout(() => { delete LOADED_SAVED.trend; }, 0);
    } else {
      trendDocs = incoming.slice(0, TREND_MAX_DOCS);
      if (trendSchoolEl) trendSchoolEl.value = String(payload.school || "");
      if (trendSubjectEl) trendSubjectEl.value = String(payload.subject || "");
      // 범위가 없는 저장본이면 지금 칸을 그대로 둔다(범위만 따로 넣어 둔 경우를 지우지 않는다)
      if (range.length) trendRangeMgr.setJobs(range);
      trendRangeSig = trendRangeJobs().map((j) => passageKey(j.text, false) + passageKey(j.text, true)).join("|");
      trendAi = payload.ai && payload.ai.overview ? payload.ai : null;
      trendAiStale = false;
    }
    trendErrorEl.textContent = dropped ? `한 보고서에는 ${TREND_MAX_DOCS}부까지라 ${dropped}부는 넣지 못했습니다.` : "";
    trendSync();
  },
};

trendSync();

// [❓ 만드는 법] 창의 글 — 화면(단추 이름·순서)을 바꾸면 같은 커밋에서 함께 고칠 것
HOWTO.trend = {
  title: "📊 시험지 분석 리포트 만드는 법",
  lead: "기출 시험지의 문항 유형을 읽어 출제경향 보고서로 만듭니다. 동형 모의고사 탭과는 따로 움직입니다. 시험지 분석에는 포인트가 들지 않고, 시험지 분석 총평을 쓸 때 보고서 1건당 값이 매겨집니다(금액은 [분석하기] 옆에 나옵니다).",
  steps: [
    "<b>학교 이름</b>과 <b>학년·과목</b>을 적습니다 — 보고서 제목에 찍힙니다(예: 전주제일고등학교 출제경향 분석 보고서 · 2학년 영어Ⅱ).",
    "기출 시험지 <b>PDF·사진</b>을 끌어다 놓습니다. <b>PDF 한 파일이 한 부</b>입니다 — 해마다의 경향을 보려면 여러 부를 올리세요. 부 이름은 칸에서 고칠 수 있고(예: 2024 1학기 중간), <b>✕</b>로 뺄 수 있습니다.",
    "(선택) <b>시험 범위 지문</b>을 넣습니다 — 다른 탭과 같은 지문 칸에 붙여넣거나 <b>[📄 저장함에서 가져오기]</b> · <b>[📄 PDF에서 가져오기]</b>로 채웁니다. 저장함에서 가져오면 <b>저장본 제목이 이름 앞에 붙어</b>(예: 공통영어2 비상(홍) 1단원 본문 · 본문1) 보고서에 <b>범위(저장본)별로 몇 개 중 몇 개가 나왔는지</b>도 묶여 나옵니다. 이름은 칸에서 고칠 수 있고, <b>[💾 지문 저장]</b>으로 이름째 저장해 둘 수 있습니다. 넣어 두면 보고서에 <b>범위의 어느 지문이 몇 번 문항으로 나왔는지</b>가 나옵니다. 분석한 뒤에 넣어도 됩니다.",
    "<b>[분석하기]</b>를 누르면 AI가 부마다 문항 유형을 읽습니다. <b>시험 범위 지문을 넣어 두었을 때만</b> 시험지의 지문도 옮겨 적어 범위와 대조합니다 — 범위를 비워 두면 유형만 읽어 훨씬 빠릅니다. 여러 해 시험지를 모아 경향만 볼 때는 범위를 비워 두세요. 시험지 한 부에 몇 분 걸립니다. 못 읽은 것이 있으면 다시 누르세요 — 못 읽은 것만 다시 읽습니다.",
    "분석이 끝나면 아래에 <b>보고서</b>가 나옵니다 — 요약, 부별 유형 표, 비중 그래프, 그리고 <b>매회 출제 / 가끔 출제 / 한 번만</b> 구분이 들어 있습니다.",
    "분석이 끝나면 <b>시험지 분석 총평과 유형별 대비 전략</b>까지 이어서 자동으로 씁니다. 시험 범위를 나중에 바꿔도 총평은 지워지지 않고 '예전 범위 기준'이라는 안내만 뜹니다 — 새로 쓰려면 <b>[✨ 총평 다시 쓰기]</b>를 누르세요(다시 쓸 때도 값이 매겨집니다).",
    "<b>[🖨 인쇄 / PDF 저장]</b>은 보고서만 새 창에 담아 인쇄합니다 — 1쪽 그래프(한눈에 보는 출제 현황), 2쪽 핵심 요약·총평·대비 전략, 3쪽부터 시험 범위 지문별 출제 현황입니다. 팝업이 막혀 있으면 이 사이트의 팝업을 허용하세요.",
    "<b>[💾 분석 저장]</b>으로 분석 결과를 저장해 두면, 다음에는 시험지를 다시 올리지 않고 <b>[📂 저장한 분석 불러오기]</b>로 바로 열 수 있습니다. <b>[➕ 저장한 분석 더하기]</b>는 지금 화면에 다른 저장본을 이어 붙여 한 보고서로 합칩니다(시험지만 합치고 시험 범위는 가져오지 않습니다). 합친 뒤 <b>[✨ 시험지 분석 총평 쓰기]</b>로 총평을 새로 쓰세요.",
  ],
  tip: "유형은 중·고등 내신에 두루 쓰는 이름(대화문 내용 파악, 영영풀이, 서술형 영작 등)으로 모든 문항을 셉니다 — 중학교 시험지도 됩니다. 범위 대조는 글자 겹침으로 짝을 짓기 때문에, 지문을 크게 바꿔 낸 문항은 '범위에서 찾지 못한 지문'으로 나올 수 있습니다. 저장본에는 시험지 그림이 들어가지 않습니다 — 그래서 지문을 읽지 않고 저장한 분석은 나중에 지문을 다시 읽을 수 없습니다.",
};
