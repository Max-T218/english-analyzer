/* 레벨테스트 성적표 그리기 — 응시 화면(lt.html)과 선생님 탭(leveltest.js)이 같이 쓴다.
   리포트 값은 서버가 만든다(server.py _lt_build_report/_lt_summarize). 여기서는 그 값을 HTML로만
   바꾼다 — 서버에서 읽어 온 값이라 모든 글자를 이스케이프한다(정답·답안 칸만 <u>를 살린다).

   모양은 학생 관리의 월간 성적표와 같은 틀이다(2026-10-21 사용자: "우리 사이트의 성적표처럼") —
   표지 머리(.rp-head) → 숫자 카드(.trend-tile) → 번호 소제목(h4.sec) → 표. 그 CSS는 trend.js의
   TREND_CSS인데, 학생 화면(lt.html)은 trend.js를 부를 수 없어(선생님 화면 칸을 찾는다) 쓰는 규칙만
   아래 BASE_CSS로 옮겨 왔다. **TREND_CSS의 표지·카드·표 모양을 고치면 BASE_CSS도 함께 고칠 것.**
   선생님 탭·인쇄 창은 TREND_CSS가 이미 있어 EXTRA_CSS만 더한다. */
(function () {
  "use strict";

  // 레벨 구간 — server.py LT_LEVEL_BANDS와 같은 값(게이지 색 띠를 그리는 데만 쓴다)
  const LT_BANDS = [
    { max: 40, label: "Low Beginner", color: "#E8564B" },
    { max: 60, label: "Beginner", color: "#F0A93B" },
    { max: 85, label: "Intermediate", color: "#2FA893" },
    { max: 100, label: "Advanced", color: "#3E7FD6" },
  ];

  const esc = (v) => String(v == null ? "" : v)
    .replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
  const escU = (v) => esc(v).replace(/&lt;(\/?)u&gt;/g, "<$1u>");
  const arr = (a) => (Array.isArray(a) ? a : []);
  const safeColor = (c) => (/^#[0-9a-fA-F]{3,8}$/.test(c || "") ? c : "#4d94ec");

  // trend.js TREND_CSS + app.js REPORT_CSS에서 성적표가 쓰는 규칙만 옮긴 것
  const BASE_CSS = `
.trend-report{font-family:"Malgun Gothic","맑은 고딕",sans-serif;color:#1a1f2b;line-height:1.6;counter-reset:sec}
.trend-report h3{margin:0 0 4px;font-size:20px}
.trend-report h4{margin:18px 0 6px;font-size:15px;border-left:4px solid #4d94ec;padding-left:8px}
.trend-report h4.sec::before{counter-increment:sec;content:counter(sec) ". ";color:#4d94ec}
.trend-report table{width:100%;border-collapse:collapse;font-size:13px}
.trend-report th,.trend-report td{border:1px solid #cfd6e3;padding:5px 7px;text-align:center}
.trend-report th{background:#eaeff8}
.trend-report td.tk{text-align:left}
.trend-report .tag{display:inline-block;padding:0 7px;border-radius:9px;font-size:11px;background:#e6ecf7;color:#2c4a86}
.trend-report .tbar{display:block;height:12px;background-color:#4d94ec;border-radius:0 4px 4px 0;min-width:2px;
  background-image:linear-gradient(180deg,rgba(255,255,255,.55) 0,rgba(255,255,255,.12) 45%,rgba(0,0,0,.06) 100%);
  box-shadow:0 1px 2px rgba(26,31,43,.22),inset 0 -1px 0 rgba(0,0,0,.08)}
.trend-report td.tbarcell{width:30%;text-align:left}
.trend-report .rp-comment{margin:4px 0;padding:10px 14px;background:#f4f7fc;border-left:3px solid #4d94ec;
  border-radius:0 8px 8px 0;font-size:13.5px;line-height:1.7;color:#1a1f2b}
.rp-head{border-top:3px solid #0b0b0b;padding-top:10px;margin-bottom:14px}
.rp-kicker{font-size:12px;letter-spacing:.08em;color:#52514e;font-weight:600}
.trend-report .rp-head h3{font-size:24px;margin:2px 0 10px;letter-spacing:-.01em}
.trend-report table.rp-meta{font-size:12.5px;border-top:1px solid #c3c2b7;border-bottom:1px solid #c3c2b7}
.trend-report .rp-meta th,.trend-report .rp-meta td{border:0;border-bottom:1px solid #e1e0d9;padding:5px 10px;text-align:left}
.trend-report .rp-meta th{width:84px;background:#f6f6f3;color:#52514e;font-weight:600;white-space:nowrap}
.trend-report .rp-meta tr:last-child th,.trend-report .rp-meta tr:last-child td{border-bottom:0}
.trend-dash{border:1px solid rgba(11,11,11,.10);border-radius:12px;padding:16px 18px;margin:10px 0 6px;break-inside:avoid;background:#fcfcfb}
.trend-tiles{display:grid;grid-template-columns:repeat(auto-fit,minmax(140px,1fr));gap:10px}
.trend-tiles.t4{grid-template-columns:minmax(0,1.3fr) repeat(3,minmax(0,1fr))}
.trend-tile{border:1px solid rgba(11,11,11,.08);background:#fff;border-radius:10px;padding:10px 11px;border-top:4px solid var(--acc,#c3c2b7);min-width:0;word-break:keep-all}
.trend-tile span{display:block;font-size:12px;color:#52514e}
.trend-tile b{display:block;font-size:24px;line-height:1.25;font-weight:700;color:#0b0b0b;margin:2px 0}
.trend-tile b.sm{font-size:18px;line-height:1.55}
.trend-tile b small{font-size:15px;font-weight:600;color:#898781}
.trend-tile em{font-style:normal;font-size:11.5px;color:#898781;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;display:block}
@media (max-width:640px){.trend-tiles.t4{grid-template-columns:1fr 1fr}}
`;

  // 레벨테스트에만 있는 것 — 게이지·방사형 그래프·채점 칸
  const EXTRA_CSS = `
.trend-report .lt-charts{display:grid;grid-template-columns:1fr 1.3fr;gap:12px;align-items:center}
@media (max-width:640px){.trend-report .lt-charts{grid-template-columns:1fr}}
.trend-report .lt-charts svg{display:block;width:100%;height:auto;margin:0 auto}
.trend-report .lt-gauge{max-width:280px;margin:0 auto;text-align:center;font-size:12px;color:#52514e}
.trend-report .lt-band-legend{display:flex;flex-wrap:wrap;gap:4px 10px;justify-content:center;margin-top:4px;font-size:11px;color:#52514e}
.trend-report .lt-band-legend i{display:inline-block;width:9px;height:9px;border-radius:2px;margin-right:3px;vertical-align:-1px}
.trend-report .lt-pending{margin:8px 0;padding:8px 12px;border-radius:8px;background:#fff7e0;border:1px solid #f0d48a;font-size:13px}
.trend-report .lt-ok{color:#1d6b3c;font-weight:700}
.trend-report .lt-no{color:#b42318;font-weight:700}
.trend-report .lt-wait{color:#a05a00;font-weight:700;white-space:nowrap}
.trend-report .lt-by{font-size:11px;color:#898781;font-weight:400}
.trend-report .ltr-gbtn{font:inherit;font-size:12px;padding:1px 8px;margin:3px 2px 0 0;border:1px solid #cfd6e3;border-radius:6px;background:#fff;cursor:pointer}
.trend-report .ltr-gbtn:hover{border-color:#4d94ec}
.trend-report .lt-bar{display:flex;align-items:center;gap:8px}
.trend-report .lt-bar > div{flex:1}
.trend-report .lt-bar b{font-weight:600;min-width:3.2em;text-align:right}
.trend-report table.lt-items td{vertical-align:top}
.trend-report table.lt-items tr{break-inside:avoid}
.trend-report .rp-comment b{font-weight:700}
.trend-report .rp-comment ul{margin:4px 0 0;padding-left:18px}
@media print{.trend-report .ltr-gbtn{display:none}}
`;

  // 반원 게이지 — 구간 색 띠 + 바늘
  function gaugeSvg(score) {
    const cx = 150, cy = 150, r = 115;
    const pt = (f, rr) => {
      const a = Math.PI + Math.PI * f;
      return [cx + Math.cos(a) * rr, cy + Math.sin(a) * rr];
    };
    let prev = 0;
    const arcs = LT_BANDS.map((b) => {
      const [x1, y1] = pt(prev / 100, r), [x2, y2] = pt(b.max / 100, r);
      prev = b.max;
      return `<path d="M${x1.toFixed(1)} ${y1.toFixed(1)} A${r} ${r} 0 0 1 ${x2.toFixed(1)} ${y2.toFixed(1)}" fill="none" stroke="${b.color}" stroke-width="24"/>`;
    }).join("");
    const [nx, ny] = pt(score / 100, r - 32);
    return `<svg viewBox="0 0 300 165" role="img" aria-label="레벨 게이지">${arcs}
      <line x1="${cx}" y1="${cy}" x2="${nx.toFixed(1)}" y2="${ny.toFixed(1)}" stroke="#1a1f2b" stroke-width="4" stroke-linecap="round"/>
      <circle cx="${cx}" cy="${cy}" r="7" fill="#1a1f2b"/></svg>`;
  }

  // 영역별 방사형 그래프 — 영역이 셋 미만이면 모양이 안 나와 그리지 않는다(표만 남는다)
  function radarSvg(cats) {
    const n = cats.length;
    if (n < 3) return "";
    const W = 440, H = 300, cx = W / 2, cy = H / 2, R = 105;
    const at = (i, rr) => {
      const a = -Math.PI / 2 + i * (2 * Math.PI / n);
      return [cx + Math.cos(a) * rr, cy + Math.sin(a) * rr];
    };
    const poly = (rr) => cats.map((_, i) => at(i, rr).map((v) => v.toFixed(1)).join(",")).join(" ");
    let g = "";
    for (let ring = 1; ring <= 4; ring++) g += `<polygon points="${poly(R * ring / 4)}" fill="none" stroke="#dbe3ee"/>`;
    cats.forEach((c, i) => {
      const [x, y] = at(i, R), [lx, ly] = at(i, R + 28);
      g += `<line x1="${cx}" y1="${cy}" x2="${x.toFixed(1)}" y2="${y.toFixed(1)}" stroke="#dbe3ee"/>`;
      g += `<text x="${lx.toFixed(1)}" y="${(ly + 4).toFixed(1)}" text-anchor="middle" font-size="13" font-weight="600" fill="#1a1f2b">${esc(c.name)}</text>`;
      g += `<text x="${lx.toFixed(1)}" y="${(ly + 19).toFixed(1)}" text-anchor="middle" font-size="12" fill="#5b6473">${esc(c.pct)}%</text>`;
    });
    const pts = cats.map((c, i) => at(i, R * Math.max(0, Math.min(100, Number(c.pct) || 0)) / 100));
    g += `<polygon points="${pts.map((p) => p.map((v) => v.toFixed(1)).join(",")).join(" ")}" fill="rgba(77,148,236,.22)" stroke="#4d94ec" stroke-width="2"/>`;
    g += pts.map(([x, y]) => `<circle cx="${x.toFixed(1)}" cy="${y.toFixed(1)}" r="4" fill="#4d94ec"/>`).join("");
    return `<svg viewBox="0 0 ${W} ${H}" role="img" aria-label="영역별 성취도">${g}</svg>`;
  }

  function catComment(c) {
    let detail = "";
    const d = c.detail;
    if (d && d.type === "reading") {
      const wrong = arr(d.wrong), right = arr(d.right);
      if (wrong.length) detail += `<br>특히 <b>${wrong.map(esc).join(", ")}</b> 유형의 문제에서 어려움을 보였어요. 해당 유형은 지문을 꼼꼼히 다시 읽고 근거가 되는 문장을 직접 찾아보는 연습을 하면 크게 향상될 수 있어요.`;
      if (right.length) detail += `<br>반면 <b>${right.map(esc).join(", ")}</b> 유형은 정확하게 잘 풀었어요.`;
    } else if (d && d.type === "grammar") {
      const wrong = arr(d.wrong);
      detail += wrong.length
        ? `<br>오답을 살펴본 결과, 다음 문법 유형에서 어려움을 보였어요. 해당 개념을 중심으로 다시 학습해 보세요.<ul>${wrong.map((w) =>
            `<li><b>${esc(w.skill)}</b> (${arr(w.nums).length}문항 · ${arr(w.nums).map(esc).join(", ")}번)</li>`).join("")}</ul>`
        : `<br>문법 문항을 전부 정확히 풀었어요. 세부 규칙까지 잘 이해하고 있는 모습이에요!`;
    }
    return `<div class="rp-comment"><b>${esc(c.name)}</b> — 성취도 <b>${esc(c.pct)}%</b>로 <b>${esc(c.bandLabel)}</b> 수준입니다. ${esc(c.narrative)}${detail}</div>`;
  }

  function markCell(it, gradeBtns) {
    const btns = gradeBtns
      ? `<br><button type="button" class="ltr-gbtn" data-i="${esc(it.i)}" data-ok="1">맞음</button><button type="button" class="ltr-gbtn" data-i="${esc(it.i)}" data-ok="0">틀림</button>`
      : "";
    if (it.ok === null || it.ok === undefined) return `<td class="lt-wait">확인 대기${btns}</td>`;
    const by = it.byTeacher ? ` <span class="lt-by">(선생님)</span>` : "";
    return `<td class="${it.ok ? "lt-ok" : "lt-no"}">${it.ok ? "O" : "X"}${by}${gradeBtns && it.byTeacher ? btns : ""}</td>`;
  }

  /* rep: 서버 리포트 값. opts: { items: 정오답표를 싣는지, gradeBtns: 확인 대기 칸에 맞음/틀림 단추,
     academy: 표지 머리의 학원 이름, extraMeta: [[이름, 값], …] } */
  function reportHtml(rep, opts) {
    opts = opts || {};
    const score = Math.max(0, Math.min(100, Number(rep.score) || 0));
    const band = { label: String((rep.band && rep.band.label) || ""), color: safeColor(rep.band && rep.band.color) };
    const cats = arr(rep.cats);
    const pending = Number(rep.pending) || 0;
    // 가장 잘한·보완할 영역 — 모두 같은 점수면(전부 0% 등) 둘이 같은 영역이 되어 이상하게 읽힌다. 그때는 비운다
    let best = cats.reduce((a, c) => (!a || c.pct > a.pct ? c : a), null);
    let worst = cats.reduce((a, c) => (!a || c.pct < a.pct ? c : a), null);
    if (best && worst && best.pct === worst.pct) { best = best.pct > 0 ? best : null; worst = best ? null : worst; }
    const bandRange = (() => {
      const k = LT_BANDS.findIndex((b) => b.label === band.label);
      return k < 0 ? "" : `${k ? LT_BANDS[k - 1].max + 1 : 0}~${LT_BANDS[k].max}점 구간`;
    })();

    // 표지 머리 — 월간 성적표(app.js reportHeadHtml)와 같은 두 칸씩 표
    const d = new Date();
    const today = `${d.getFullYear()}. ${d.getMonth() + 1}. ${d.getDate()}.`;
    const rows = [["학생", esc(rep.studentName)], ["시험지", esc(rep.gradeLabel)], ["응시일", esc(rep.date)]]
      .concat((opts.extraMeta || []).map(([k, v]) => [esc(k), esc(v)])).concat([["작성일", today]]);
    let meta = "";
    for (let i = 0; i < rows.length; i += 2) {
      const a = rows[i], b = rows[i + 1];
      meta += b ? `<tr><th>${a[0]}</th><td>${a[1]}</td><th>${b[0]}</th><td>${b[1]}</td></tr>`
        : `<tr><th>${a[0]}</th><td colspan="3">${a[1]}</td></tr>`;
    }
    const head = `<div class="rp-head">
        <div class="rp-kicker">${esc(opts.academy ? opts.academy + " · " : "")}레벨테스트 성적표</div>
        <h3>${esc(rep.studentName)} 학생 레벨테스트 결과</h3>
        <table class="rp-meta">${meta}</table></div>`;

    const tiles = [
      { label: "총점", value: score, unit: "점", sub: `${esc(rep.totalCorrect)}/${esc(rep.totalCount)}문항 정답`, color: "#4d94ec" },
      { label: "레벨", value: esc(band.label), sm: true, sub: bandRange, color: band.color },
      { label: "가장 잘한 영역", value: best ? esc(best.name) : "—", sm: true, sub: best ? `성취도 ${best.pct}%` : "", color: "#2fd197" },
      { label: "보완할 영역", value: worst ? esc(worst.name) : "—", sm: true, sub: worst ? `성취도 ${worst.pct}%` : "", color: "#ff8a4c" },
    ];
    const tilesHtml = `<div class="trend-dash"><div class="trend-tiles t4">${tiles.map((t) => `
      <div class="trend-tile" style="--acc:${t.color}"><span>${t.label}</span>
        <b${t.sm ? ' class="sm"' : ""}>${t.value}<small>${t.unit || ""}</small></b><em>${t.sub || "&nbsp;"}</em></div>`).join("")}</div></div>`;

    const legend = `<div class="lt-band-legend">${LT_BANDS.map((b, k) =>
      `<span><i style="background:${b.color}"></i>${esc(b.label)} ${k ? LT_BANDS[k - 1].max + 1 : 0}~${b.max}</span>`).join("")}</div>`;
    const charts = `<div class="trend-dash"><div class="lt-charts">
        <div class="lt-gauge">${gaugeSvg(score)}<div>${esc(band.label)} (${score}점)</div>${legend}</div>
        <div>${radarSvg(cats)}</div></div></div>`;

    const catTable = `<table><thead><tr><th>영역</th><th>맞힌 문항</th><th>성취도</th><th>수준</th></tr></thead><tbody>${
      cats.map((c) => `<tr><td class="tk">${esc(c.name)}</td><td>${esc(c.correct)}/${esc(c.total)}</td>
        <td class="tbarcell"><div class="lt-bar"><div><span class="tbar" style="width:${Math.max(2, Math.min(100, Number(c.pct) || 0))}%"></span></div><b>${esc(c.pct)}%</b></div></td>
        <td>${esc(c.bandLabel)}</td></tr>`).join("")}</tbody></table>`;

    const items = opts.items ? `<h4 class="sec">정오답표</h4>
      <table class="lt-items"><thead><tr><th>문항</th><th>영역</th><th>채점</th><th>정답</th><th>학생 답안</th></tr></thead><tbody>${
        arr(rep.items).map((it) => `<tr><td>${esc(it.no)}</td><td>${esc(it.section)}</td>${markCell(it, opts.gradeBtns)}
          <td class="tk">${escU(it.correctText)}</td><td class="tk">${escU(it.givenText)}</td></tr>`).join("")}</tbody></table>` : "";

    return `<div class="trend-report lt-report">
      ${head}
      ${tilesHtml}
      ${pending ? `<div class="lt-pending">✍️ 선생님 확인을 기다리는 문항이 <b>${pending}개</b> 있습니다 — 확인이 끝나면 점수가 바뀔 수 있습니다.</div>` : ""}
      <h4 class="sec">레벨과 영역별 성취도</h4>
      ${charts}
      ${catTable}
      <h4 class="sec">영역별 코멘트</h4>
      ${cats.map(catComment).join("")}
      ${items}
    </div>`;
  }

  window.LTR = { CSS: BASE_CSS + EXTRA_CSS, BASE_CSS, EXTRA_CSS, reportHtml, BANDS: LT_BANDS };
})();
