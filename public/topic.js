/* ══════ 기출 소재·어휘 (2026-11-18 사용자) ══════
   모의고사·수능 여러 회차(3·6·9·10월 …)를 회차별로 넣고
     ① 소재 분석 — 지문마다 분야·한 줄 소재·핵심어·글의 성격(서버 /api/topicscan, Flash, 지문 1개당 PRICING.topic)
     ② 어휘 분석 — 교육과정 3,000단어(파생어 포함)로 지문 낱말을 몇 % 읽을 수 있는지(/api/vocabstats, AI 없음·0원)
     ③ 3,000단어 밖 낱말을 골라 뜻을 달아 단어장 탭으로(/api/topicwords, Flash, 100단어 한 번당 PRICING.topicWords)
   회차 = 지문 묶음 하나. PDF 파일 하나가 회차 하나이고, 위쪽 공용 지문 칸에서도 회차를 가져올 수 있다.
   지문은 문제 상태 그대로 보낸다 — 빈칸·순서·삽입을 되살리지 않아도 소재·어휘는 거의 그대로 셀 수 있다.
   인쇄 보고서에는 지문 원문을 싣지 않는다(소재·핵심어·통계만). 지문에 색을 칠해 보는 칸은 화면 전용이다.
   app.js·trend.js 뒤에 로드되며 그 전역($, esc, postGenerate, reportHeadHtml, openPrintWindow, TAB_SAVE …)을 쓴다. */

const tpEl = (id) => document.getElementById(id);
const TOPIC_NAME = "기출 소재·어휘";
// server.py TOPIC_FIELDS와 같은 값·같은 차례
const TOPIC_FIELDS = ["인문·철학", "심리·행동", "사회·문화", "경제·경영", "정치·법·윤리", "교육·학습",
  "언어·문학", "역사", "예술", "생명과학·의학", "물리·화학·지구과학", "환경·생태",
  "기술·정보", "스포츠·건강", "실용문"];
// 분야마다 또렷이 갈리는 색(2026-11-18 사용자: 레벨테스트 성적표처럼 색을 많이 써서 구분이 잘 가게) — TOPIC_FIELDS 차례
const TOPIC_FIELD_COLORS = ["#8e44d6", "#e6194b", "#f58231", "#e6b800", "#9a6324", "#3cb44b",
  "#f032e6", "#800000", "#ff7eb6", "#00a6c8", "#4363d8", "#7cb518", "#1f3a93", "#469990", "#8f8f8f"];
const TOPIC_GENRE_COLORS = { 설명: "#4363d8", 주장: "#e6194b", 이야기: "#f5a623", 실용문: "#20b2aa" };
const TOPIC_OFF_COLOR = "#ff8a3d";   // 교육과정 3,000단어 밖
const TOPIC_BATCH = 10;          // server.py TOPIC_SCAN_BATCH
const TOPIC_PARALLEL = 3;        // 함께 보내는 묶음 수
const TOPIC_WORDS_BATCH = 100;   // server.py TOPIC_WORDS_MAX
const TOPIC_TARGET = 95;         // 읽기 기준선(%)
const TOPIC_LEVELS = ["초등", "중학교·공통", "고등(선택)"];
const TOPIC_LEVEL_COLORS = ["#5cc26b", "#3d8bfd", "#8e5cd9"];

const tpState = {
  rounds: [],     // [{id, name, passages:[{id, name, text, on}]}]
  topics: {},     // 지문 id → {field, topic, keywords, genre}
  stats: null,    // /api/vocabstats 응답
  statsKey: "",   // 그 통계를 낸 지문 묶음의 열쇠 — 바뀌면 '다시 분석' 안내
  picked: new Set(),
  wordsShown: 100,
  // 단어장으로 나눠 보내기(2026-11-18 사용자 — '600개를 30개씩이면 단어장 20개'): 한 단어장 개수 · 정리 순서 · 이름
  pack: { size: 30, order: "freq", base: "", label: "Day {n}" },
  peek: { id: "", level: 2 },
  title: "",
  busy: false,
};
let tpSeq = 0;
const tpId = (head) => `${head}${Date.now().toString(36)}${(tpSeq++).toString(36)}`;

/* ── 회차 넣기 ── */
function tpRoundName(fileName) {
  return String(fileName || "").replace(/\.pdf$/i, "").replace(/[_]+/g, " ").trim().slice(0, 60);
}
function tpOnPassages() {
  return tpState.rounds.flatMap((r) => r.passages.filter((p) => p.on).map((p) => ({ r, p })));
}
function tpKey() {
  return tpState.rounds.map((r) => r.name + ":" + r.passages.filter((p) => p.on).map((p) => p.id).join(",")).join("|");
}
function tpStatus(html, kind) {
  const el = tpEl("tpInStatus");
  el.innerHTML = html || "";
  el.className = "hint" + (kind ? " " + kind : "");
}

/* PDF → 회차. 서버(/api/topicpdf, AI 없음·0원)가 글자를 문항별로 '문제 모양 그대로' 잘라 준다 — 원래 지문으로
   되살리지 않는다(2026-11-18 사용자: 여러 개를 올리면 지문을 채우느라 시간이 다 갔다. 소재·어휘에는 정답이 필요 없다).
   유형별 모음집처럼 문항마다 출처('2019 3월 고3 서울교육청 36번')가 붙은 PDF는 파일이 아니라 시험별로 회차를 묶는다 —
   여러 권을 올리면 같은 시험의 문항이 한 회차로 모인다. 출처가 없으면 파일 하나가 회차 하나다. */
async function tpAddPdfs(files) {
  files = [...files].filter(isPdf);
  if (!files.length) return tpStatus("PDF 파일만 올릴 수 있습니다.", "warn");
  const notes = [];
  let added = 0;
  tpEl("tpPdfBtn").disabled = true;
  try {
    for (let i = 0; i < files.length; i++) {
      const f = files[i];
      const who = f.name || `PDF ${i + 1}`;
      tpStatus(`<span class="spinner"></span> ${esc(who)} 읽는 중… (${i + 1}/${files.length})`);
      try {
        const data = await blobToBase64(f);
        if (data.length > PDF_MAX_UPLOAD) {
          notes.push(`${esc(who)} — 파일이 너무 큽니다. 쪽을 나눠 올려 주세요.`);
          continue;
        }
        const res = await postJson("/api/topicpdf", { file: { mime: "application/pdf", data } }, "PDF를 읽지 못했습니다.");
        const list = res.passages || [];
        if (!list.length) {
          notes.push(`${esc(who)} — 문항을 찾지 못했습니다(문항 번호가 '18. 다음 글의 …'처럼 붙은 PDF만 읽습니다).`);
          continue;
        }
        const fileRound = tpRoundName(who) || `회차 ${tpState.rounds.length + 1}`;
        list.forEach((p) => {
          const rname = p.src || fileRound;
          let round = tpState.rounds.find((r) => r.name === rname);
          if (!round) {
            round = { id: tpId("r"), name: rname, passages: [] };
            tpState.rounds.push(round);
          }
          if (round.passages.some((x) => x.no === p.no)) return;   // 같은 시험의 같은 번호(겹친 파일)는 한 번만
          const nos = [];
          for (let n = p.no; n <= (p.end || p.no); n++) nos.push(n);
          round.passages.push({
            id: tpId("p"), name: nos.length > 1 ? `${p.no}~${p.end}번` : `${p.no}번`, text: p.text,
            // 25~28번(도표·인물·안내문)은 처음엔 빼 둔다 — 눌러서 넣을 수 있다
            on: !nos.some((n) => PDF_SKIP_NOS.has(n)), no: p.no, nos,
          });
          added++;
        });
        tpState.rounds.forEach((r) => r.passages.sort((a, b) => (a.no || 999) - (b.no || 999)));
        tpSortRounds();
        tpRenderRounds();
      } catch (err) {
        notes.push(`${esc(who)} — ${esc(err.message || String(err))}`);
      }
    }
  } finally {
    tpEl("tpPdfBtn").disabled = false;
  }
  tpStatus((added ? `문항 <b>${added}개</b>를 회차에 넣었습니다. 문제 모양 그대로라 빈칸·순서·삽입 문제도 바로 분석합니다. ` : "") +
    (notes.length ? notes.join("<br>") : "회차 이름을 확인하고, 뺄 지문은 눌러서 끄세요."), notes.length ? "warn" : "ok");
  tpAfterChange();
}

// 회차 이름이 '2019 3월 …'처럼 연도·월로 시작하면 시험 차례(이른 것부터)로 놓는다. 하나라도 못 읽으면 건드리지 않는다
function tpSortRounds() {
  const key = (r) => {
    const m = /^(20\d\d)\s*(\d{1,2})월/.exec(r.name);
    return m ? Number(m[1]) * 100 + Number(m[2]) : null;
  };
  if (tpState.rounds.every((r) => key(r) !== null)) tpState.rounds.sort((a, b) => key(a) - key(b));
}

// 요청할 때만 — 이 회차의 지문을 위쪽 공용 지문 칸에 넣는다(거기서 [지문 저장]이나 다른 탭에 쓴다). 문제 모양 그대로다
function tpRoundToPassages(ri) {
  const r = tpState.rounds[ri];
  const jobs = r.passages.filter((p) => p.on).map((p) => ({ name: `${r.name} · ${p.name}`, text: p.text, named: true }));
  if (!jobs.length) return;
  if (!confirm(`'${r.name}' 지문 ${jobs.length}개를 위쪽 지문 칸에 넣을까요?

` +
    "PDF 글자를 문제 모양 그대로 자른 것이라 빈칸·순서·삽입 문제는 원래 지문 모양이 아닙니다. " +
    "지문 칸에서 [지문 저장]을 누르면 저장함에 남습니다.")) return;
  const put = passageMgr.appendJobs(jobs);
  tpStatus(`'${esc(r.name)}' 지문 ${put.added}개를 위쪽 지문 칸에 넣었습니다.` +
    (put.full ? " 지문 칸이 가득 차 나머지는 넣지 못했습니다." : "") + " 저장하려면 지문 칸의 [💾 지문 저장]을 누르세요.",
  put.full ? "warn" : "ok");
  const panel = document.querySelector(".passage-panel");
  if (panel) panel.scrollIntoView({ behavior: "smooth", block: "start" });
}

function tpPullShared() {
  const jobs = (typeof passageMgr !== "undefined" ? passageMgr.getJobs() : []).filter((j) => (j.text || "").trim().length >= 20);
  if (!jobs.length) return tpStatus("위쪽 영어 지문 칸이 비어 있습니다. 지문을 넣거나 저장함에서 불러온 뒤 눌러 주세요.", "warn");
  const name = prompt("이 회차의 이름을 적어 주세요 (예: 2026 고3 6월)", `회차 ${tpState.rounds.length + 1}`);
  if (name === null) return;
  tpState.rounds.push({
    id: tpId("r"), name: name.trim().slice(0, 60) || `회차 ${tpState.rounds.length + 1}`,
    passages: jobs.map((j) => ({ id: tpId("p"), name: j.name, text: j.text, on: true })),
  });
  tpStatus(`지문 ${jobs.length}개를 회차로 가져왔습니다.`, "ok");
  tpAfterChange();
}

function tpRenderRounds() {
  const box = tpEl("tpRounds");
  tpEl("tpClearBtn").hidden = !tpState.rounds.length;
  if (!tpState.rounds.length) {
    box.innerHTML = "";
    return;
  }
  box.innerHTML = tpState.rounds.map((r, ri) => {
    const on = r.passages.filter((p) => p.on).length;
    return `<div class="tp-round" data-r="${ri}">
      <div class="tp-round-head">
        <input type="text" class="tp-round-name" value="${esc(r.name)}" maxlength="60" aria-label="회차 이름">
        <span class="tp-round-count">지문 ${r.passages.length}개 중 <b>${on}개</b> 분석</span>
        <button type="button" class="btn ghost small" data-act="up" ${ri ? "" : "disabled"} title="앞으로">▲</button>
        <button type="button" class="btn ghost small" data-act="down" ${ri < tpState.rounds.length - 1 ? "" : "disabled"} title="뒤로">▼</button>
        <button type="button" class="btn ghost small" data-act="pass" title="이 회차의 지문을 위쪽 지문 칸에 넣습니다(저장은 거기서).">⬆ 지문 칸으로</button>
        <button type="button" class="btn ghost small" data-act="del">회차 빼기</button>
      </div>
      <div class="tp-chips">${r.passages.map((p, pi) => `<button type="button" class="tp-chip${p.on ? " on" : ""}${tpState.topics[p.id] ? " done" : ""}" data-p="${pi}"
        title="${esc((p.text || "").slice(0, 120))}…">${esc(p.name)}</button>`).join("")}</div>
    </div>`;
  }).join("") + `<div class="hint">지문 단추를 누르면 분석에서 빼거나 다시 넣습니다(✓ = 소재 분석을 마친 지문). 회차 차례가 보고서의 차례입니다 — 이른 시험부터 놓아 주세요.</div>`;
}
tpEl("tpRounds").addEventListener("click", (e) => {
  const rEl = e.target.closest(".tp-round");
  if (!rEl) return;
  const ri = Number(rEl.dataset.r);
  const chip = e.target.closest(".tp-chip");
  if (chip) {
    const p = tpState.rounds[ri].passages[Number(chip.dataset.p)];
    p.on = !p.on;
    tpAfterChange();
    return;
  }
  const act = e.target.closest("[data-act]");
  if (!act) return;
  const rs = tpState.rounds;
  if (act.dataset.act === "pass") {
    tpRoundToPassages(ri);
    return;
  }
  if (act.dataset.act === "del") {
    if (!confirm(`'${rs[ri].name}' 회차를 뺄까요?`)) return;
    rs.splice(ri, 1);
  } else if (act.dataset.act === "up" && ri > 0) {
    [rs[ri - 1], rs[ri]] = [rs[ri], rs[ri - 1]];
  } else if (act.dataset.act === "down" && ri < rs.length - 1) {
    [rs[ri + 1], rs[ri]] = [rs[ri], rs[ri + 1]];
  }
  tpAfterChange();
});
tpEl("tpRounds").addEventListener("input", (e) => {
  const inp = e.target.closest(".tp-round-name");
  if (!inp) return;
  tpState.rounds[Number(inp.closest(".tp-round").dataset.r)].name = inp.value.trim().slice(0, 60);
  tpRenderReport();
});
// 회차·지문이 바뀌었다 — 칸을 다시 그리고 보고서·값 안내를 맞춘다
function tpAfterChange() {
  tpRenderRounds();
  tpRenderReport();
  tpSyncCost();
}

tpEl("tpPdfBtn").addEventListener("click", () => tpEl("tpPdfFile").click());
tpEl("tpPdfFile").addEventListener("change", (e) => {
  const files = e.target.files;
  if (files && files.length) tpAddPdfs(files);
  e.target.value = "";
});
tpEl("tpPullBtn").addEventListener("click", tpPullShared);
tpEl("tpClearBtn").addEventListener("click", () => {
  if (!confirm("넣은 회차와 분석 결과를 모두 비울까요? 저장함에 저장한 것은 그대로 남습니다.")) return;
  TAB_SAVE.topic.clearResults();
  if (typeof LOADED_SAVED !== "undefined") delete LOADED_SAVED.topic;
});

/* ── 값 안내 ── */
const tpTodo = () => tpOnPassages().filter(({ p }) => !tpState.topics[p.id]);
function tpSyncCost() {
  const el = tpEl("tpCostHint");
  const all = tpOnPassages().length;
  if (!all) {
    el.textContent = "회차를 넣으면 예상 비용이 보입니다.";
    return;
  }
  const todo = tpTodo().length;
  const per = PRICING ? PRICING.topic : null;
  el.innerHTML = (todo
    ? `소재 분석: 지문 ${todo}개${per != null ? ` × ${pt(per)} = 약 <b>${pt(per * todo)}</b>` : ""}`
    : "소재 분석: 모두 마쳤습니다") +
    ` · 어휘 분석: <b>무료</b>(지문 ${all}개)`;
}
onPricingReady(tpSyncCost);

/* ── ① 소재 분석 ── */
async function tpRunTopic() {
  const errEl = tpEl("tpError");
  errEl.textContent = "";
  const todo = tpTodo();
  if (!tpOnPassages().length) {
    errEl.textContent = "먼저 ① 회차를 넣어 주세요.";
    return;
  }
  if (!todo.length) {
    errEl.textContent = "분석할 지문의 소재를 모두 정리했습니다. 지문을 더 넣으면 그 지문만 새로 분석합니다.";
    return;
  }
  const per = PRICING ? PRICING.topic : 0;
  if (!(await costConfirmed(per * todo.length, `${TOPIC_NAME} · 소재 분석 · 지문 ${todo.length}개`, todo.length))) return;
  if (typeof dropStaleSavedLink === "function") dropStaleSavedLink("topic");
  tpState.busy = true;
  tpEl("tpTopicBtn").disabled = true;
  const loading = tpEl("tpLoading");
  const text = tpEl("tpLoadingText");
  const gate = runGate(loading);
  gate.begin();
  loading.classList.add("on");
  let done = 0;
  try {
    // 묶음(TOPIC_BATCH지문)을 TOPIC_PARALLEL개씩 함께 보낸다 — 한 묶음에 20초쯤 걸려 차례로 보내면 4회차(약 100지문)에 3분이 넘었다
    const step = TOPIC_BATCH * TOPIC_PARALLEL;
    let stop = false;
    for (let i = 0; i < todo.length && !stop; i += step) {
      if (i && await gate.check(`지문 ${done}개의 소재를 정리했습니다.`, tpRenderReport)) {
        errEl.textContent = runEndedNote(todo.length - i, "지문");
        break;
      }
      text.textContent = `AI가 소재를 정리하고 있습니다… (${done}/${todo.length})`;
      const parts = [];
      for (let k = i; k < Math.min(i + step, todo.length); k += TOPIC_BATCH) parts.push(todo.slice(k, k + TOPIC_BATCH));
      await Promise.all(parts.map((part) => postGenerate("/api/topicscan",
        { passages: part.map(({ p }) => ({ id: p.id, name: p.name, text: p.text })) },
        "소재를 정리하지 못했습니다.",
        (n) => { text.textContent = `연결이 끊겨 다시 받아 오는 중… (${n})`; })
        .then((res) => {
          (res.items || []).forEach((it) => {
            tpState.topics[it.id] = { field: it.field, topic: it.topic, keywords: it.keywords || [], genre: it.genre };
            done++;
          });
          text.textContent = `AI가 소재를 정리하고 있습니다… (${done}/${todo.length})`;
        }, (err) => {
          errEl.textContent = err.message || String(err);
          if (err.code === "quota" || err.code === "no_tokens") stop = true;
        })));
      tpRenderRounds();
      tpRenderReport();
    }
    const miss = tpTodo().length;
    if (miss && !errEl.textContent) errEl.textContent = `지문 ${miss}개는 소재를 정리하지 못했습니다(값은 나가지 않았습니다). 다시 누르면 그 지문만 다시 합니다.`;
    if (done) showDoneGuide(`지문 ${done}개의 소재 분석`, false);
  } finally {
    tpState.busy = false;
    tpEl("tpTopicBtn").disabled = false;
    loading.classList.remove("on");
    refreshTokenDisplay();
    tpAfterChange();
  }
}
tpEl("tpTopicBtn").addEventListener("click", () => { if (!tpState.busy) tpRunTopic(); });

/* ── ② 어휘 분석(0원) ── */
async function tpRunVocab() {
  const errEl = tpEl("tpError");
  errEl.textContent = "";
  const rounds = tpState.rounds.map((r) => ({
    name: r.name, passages: r.passages.filter((p) => p.on).map((p) => ({ id: p.id, name: p.name, text: p.text })),
  })).filter((r) => r.passages.length);
  if (!rounds.length) {
    errEl.textContent = "먼저 ① 회차를 넣어 주세요.";
    return;
  }
  tpEl("tpVocabBtn").disabled = true;
  try {
    tpState.stats = await postJson("/api/vocabstats", { rounds }, "어휘를 세지 못했습니다.");
    tpState.statsKey = tpKey();
    tpState.picked = new Set();
    tpState.wordsShown = 100;
    if (!tpState.stats.ready) errEl.textContent = "서버에 교육과정 어휘 목록이 없어 어휘 분석을 할 수 없습니다. 관리자에게 알려 주세요.";
    tpRenderReport();
    const sec = tpEl("tpResult").querySelector(".tp-vocab-sec");
    if (sec) sec.scrollIntoView({ behavior: "smooth", block: "start" });
  } catch (err) {
    errEl.textContent = err.message || String(err);
  } finally {
    tpEl("tpVocabBtn").disabled = false;
  }
}
tpEl("tpVocabBtn").addEventListener("click", tpRunVocab);

/* ── 보고서 ── */
const tpPct = (x) => `${Number(x || 0).toFixed(1)}%`;
const tpFieldColor = (f) => TOPIC_FIELD_COLORS[Math.max(0, TOPIC_FIELDS.indexOf(f))];

function tpTopicRows() {
  // [{round, ri, p, t}] — 소재를 정리한 지문만
  const out = [];
  tpState.rounds.forEach((r, ri) => r.passages.forEach((p) => {
    if (p.on && tpState.topics[p.id]) out.push({ round: r.name, ri, p, t: tpState.topics[p.id] });
  }));
  return out;
}

function tpTopicHtml() {
  const rows = tpTopicRows();
  if (!rows.length) return "";
  const rounds = tpState.rounds.filter((r) => r.passages.some((p) => p.on && tpState.topics[p.id]));
  const byField = {};
  rows.forEach((x) => { (byField[x.t.field] = byField[x.t.field] || []).push(x); });
  const fields = TOPIC_FIELDS.filter((f) => byField[f]).sort((a, b) => byField[b].length - byField[a].length
    || TOPIC_FIELDS.indexOf(a) - TOPIC_FIELDS.indexOf(b));
  const max = Math.max(...fields.map((f) => byField[f].length));
  const bars = fields.map((f) => `<div class="tp-bar"><span class="tp-bar-name">${esc(f)}</span>
    <span class="tp-bar-track"><i style="width:${(byField[f].length / max) * 100}%;background-color:${tpFieldColor(f)}"></i></span>
    <b>${byField[f].length}</b></div>`).join("");
  // 회차 × 분야
  const cnt = (f, r) => byField[f].filter((x) => x.round === r.name && tpState.rounds[x.ri] === r).length;
  const grid = `<table class="tp-grid"><thead><tr><th>분야</th>${rounds.map((r) => `<th>${esc(r.name)}</th>`).join("")}<th>합계</th></tr></thead>
    <tbody>${fields.map((f) => `<tr><th><i class="tp-dot" style="background:${tpFieldColor(f)}"></i>${esc(f)}</th>${rounds.map((r) => {
      const n = cnt(f, r);
      return `<td${n ? ` class="tp-heat" style="background-color:rgba(77,148,236,${Math.min(0.15 + n * 0.17, 0.85)});${n >= 3 ? "color:#fff;" : ""}"` : ""}>${n || ""}</td>`;
    }).join("")}<td><b>${byField[f].length}</b></td></tr>`).join("")}</tbody></table>`;
  const every = rounds.length > 1 ? fields.filter((f) => rounds.every((r) => cnt(f, r) > 0)) : [];
  const never = TOPIC_FIELDS.filter((f) => !byField[f] && f !== "실용문");
  const genres = {};
  rows.forEach((x) => { genres[x.t.genre] = (genres[x.t.genre] || 0) + 1; });
  const summary = [
    `가장 많이 나온 분야는 <b>${fields.slice(0, 3).map((f) => `${esc(f)}(${byField[f].length})`).join(" · ")}</b>입니다.`,
    every.length ? `모든 회차에 나온 분야: <b>${every.map(esc).join(" · ")}</b>` : "",
    never.length ? `한 번도 안 나온 분야: ${never.map(esc).join(" · ")}` : "",
    `글의 성격: ${Object.entries(genres).sort((a, b) => b[1] - a[1]).map(([g, n]) => `${esc(g)} ${n}`).join(" · ")}`,
  ].filter(Boolean).map((s) => `<li>${s}</li>`).join("");
  const tables = fields.map((f) => `<div class="rp-keep tp-field-block">
      <h5><i class="tp-dot" style="background:${tpFieldColor(f)}"></i>${esc(f)} <small>${byField[f].length}지문</small></h5>
      <table class="tp-list tp-topics"><thead><tr><th>회차</th><th>번호</th><th>소재</th><th>핵심어</th><th>성격</th></tr></thead><tbody>
      ${byField[f].map((x) => `<tr><td>${esc(x.round)}</td><td>${esc(x.p.name)}</td><td>${esc(x.t.topic)}</td>
        <td class="tp-kw">${esc((x.t.keywords || []).join(", "))}</td><td>${esc(x.t.genre)}</td></tr>`).join("")}
      </tbody></table></div>`).join("");
  const fieldParts = fields.map((f) => ({ label: f, value: byField[f].length, color: tpFieldColor(f) }));
  const genreParts = Object.entries(genres).sort((a, b) => b[1] - a[1])
    .map(([g, n]) => ({ label: g, value: n, color: TOPIC_GENRE_COLORS[g] || "#999" }));
  const donuts = `<div class="tp-charts">
      ${rpDonutBlock("분야 비율", fieldParts, `${fields.length}가지`, `지문 ${rows.length}개`)}
      ${rpDonutBlock("글의 성격", genreParts, `${rows.length}`, "지문")}
    </div>`;
  const stack = rounds.length > 1 ? `<div class="rp-keep"><h5>회차별 분야 구성 <small>회차마다 100%로 펼친 막대 — 칸 안 숫자는 지문 수</small></h5>
      ${rpStackRows(rounds.map((r) => ({ label: r.name, parts: fields.map((f) => ({ label: f, value: cnt(f, r), color: tpFieldColor(f) })) })))}
      <div class="tp-legend">${fields.map((f) => `<span><i style="background:${tpFieldColor(f)}"></i>${esc(f)}</span>`).join("")}</div></div>` : "";
  return `<h4 class="sec">소재 분석</h4>
    <ul class="tp-summary">${summary}</ul>
    ${donuts}
    <div class="tp-two"><div><h5>분야별 출제 수</h5>${bars}</div><div><h5>회차별 분야</h5>${grid}</div></div>
    ${stack}
    <h4 class="sec">분야별 소재 목록</h4>${tables}`;
}

// 기준선(95%)까지 — 추가 어휘를 위에서부터 몇 개 익히면 넘는지
function tpWordsToTarget(st) {
  if (st.coverage[2] >= TOPIC_TARGET) return 0;
  const i = st.offlist.findIndex((w) => w.cumulative >= TOPIC_TARGET);
  return i < 0 ? null : i + 1;
}

function tpCovBar(cov, label, sub) {
  const [a, b, c] = cov;
  return `<div class="tp-cov"><div class="tp-cov-label">${esc(label)}${sub ? ` <small>${esc(sub)}</small>` : ""}</div>
    <div class="tp-cov-track">
      <i style="width:${a}%;background-color:${TOPIC_LEVEL_COLORS[0]}"></i><i style="width:${b - a}%;background-color:${TOPIC_LEVEL_COLORS[1]}"></i><i style="width:${c - b}%;background-color:${TOPIC_LEVEL_COLORS[2]}"></i><i style="width:${Math.max(0, 100 - c)}%;background-color:${TOPIC_OFF_COLOR}"></i>
      <span class="tp-cov-line" style="left:${TOPIC_TARGET}%"></span>
    </div><b class="${c >= TOPIC_TARGET ? "ok" : ""}">${tpPct(c)}</b></div>`;
}

function tpVocabHtml(forPrint) {
  const st = tpState.stats;
  if (!st || !st.tokens) return "";
  const stale = tpState.statsKey !== tpKey();
  const need = tpWordsToTarget(st);
  const gap = Math.max(0, TOPIC_TARGET - st.coverage[2]);
  const legend = `<div class="tp-legend">${TOPIC_LEVELS.map((l, i) => `<span><i style="background:${TOPIC_LEVEL_COLORS[i]}"></i>${esc(l)}${i ? "까지" : ""}</span>`).join("")}<span><i style="background:${TOPIC_OFF_COLOR}"></i>3,000단어 밖</span><span><i class="tp-line-i"></i>읽기 기준선 ${TOPIC_TARGET}%</span></div>`;
  // 원형: 낱말이 어느 학교급 목록에서 왔는지 / 세로 막대: 지문마다 읽는 비율이 어디에 몰렸는지
  const [c0, c1, c2] = st.coverage;
  const levelDonut = rpDonutBlock("낱말이 속한 학교급", [
    { label: "초등", value: Math.round(st.tokens * c0 / 100), color: TOPIC_LEVEL_COLORS[0] },
    { label: "중학교·공통", value: Math.round(st.tokens * (c1 - c0) / 100), color: TOPIC_LEVEL_COLORS[1] },
    { label: "고등(선택)", value: Math.round(st.tokens * (c2 - c1) / 100), color: TOPIC_LEVEL_COLORS[2] },
    { label: "3,000단어 밖", value: Math.round(st.tokens * (100 - c2) / 100), color: TOPIC_OFF_COLOR },
  ], tpPct(c2), "읽는 비율");
  const allP = st.rounds.flatMap((r) => r.passages).filter((p) => p.tokens >= 30);
  const BINS = [[0, 90, "~90"], [90, 92, "90~92"], [92, 94, "92~94"], [94, 95, "94~95"], [95, 96, "95~96"],
    [96, 97, "96~97"], [97, 98, "97~98"], [98, 99, "98~99"], [99, 100.1, "99~"]];
  const BIN_COLORS = ["#d7263d", "#f46036", "#f5a623", "#f2c94c", "#a3d977", "#5cc26b", "#2ec4b6", "#3d8bfd", "#5a4fcf"];
  const hist = allP.length ? `<div class="tp-chart rp-keep tp-chart-wide"><h5>지문별 읽기 비율 분포 <small>지문 ${allP.length}개 — 3,000단어로 읽는 비율(%)별 지문 수, ${TOPIC_TARGET}% 아래는 붉은 쪽</small></h5>
      ${rpColumns(BINS.map(([lo, hi, label], i) => ({ label, color: BIN_COLORS[i],
        value: allP.filter((p) => p.coverage[2] >= lo && p.coverage[2] < hi).length })), "")}</div>` : "";
  const vocabCharts = `<div class="tp-charts">${levelDonut}${hist}</div>`;
  const covs = tpCovBar(st.coverage, "전체", `낱말 ${st.tokens.toLocaleString()}개`) +
    (st.rounds.length > 1 ? st.rounds.map((r) => tpCovBar(r.coverage, r.name, `낱말 ${r.tokens.toLocaleString()}개`)).join("") : "");
  const levelLine = `초등 단어로 <b>${tpPct(st.coverage[0])}</b> → 중학교·공통까지 <b>${tpPct(st.coverage[1])}</b> → 교육과정 3,000단어(파생어 포함)까지 <b>${tpPct(st.coverage[2])}</b>`;
  const gapLine = gap > 0
    ? `기준선 ${TOPIC_TARGET}%까지 <b>${gap.toFixed(1)}%p</b> 모자랍니다 — 그 간격이 곧 '추가 어휘'입니다.` +
      (need ? ` 아래 목록을 위에서부터 <b>${need}개</b> 익히면 ${TOPIC_TARGET}%를 넘습니다.` : "")
    : `교육과정 3,000단어만으로 기준선 ${TOPIC_TARGET}%를 넘습니다.`;
  // 어휘가 어려운 지문
  const hard = st.rounds.flatMap((r) => r.passages.map((p) => ({ r: r.name, ...p })))
    .filter((p) => p.tokens >= 30).sort((a, b) => a.coverage[2] - b.coverage[2]).slice(0, 10);
  const hardHtml = hard.length ? `<table class="tp-list"><thead><tr><th>순위</th><th>회차</th><th>번호</th><th>3,000단어로 읽는 비율</th><th>낯선 낱말(많이 나온 차례)</th></tr></thead><tbody>
    ${hard.map((p, i) => `<tr><td>${i + 1}</td><td>${esc(p.r)}</td><td>${esc(p.name)}</td><td><b>${tpPct(p.coverage[2])}</b></td>
      <td class="tp-kw">${esc(p.offlist.slice(0, 8).join(", "))}</td></tr>`).join("")}</tbody></table>` : "";
  // 추가 어휘 표
  const shown = forPrint ? Math.min(st.offlist.length, need ? Math.max(need, 60) : 60) : Math.min(st.offlist.length, tpState.wordsShown);
  const words = st.offlist.slice(0, shown);
  const wordRows = words.map((w, i) => `<tr class="${need && i < need ? "tp-need" : ""}">
    ${forPrint ? "" : `<td class="no-print"><input type="checkbox" class="tp-pick" data-w="${esc(w.word)}"${tpState.picked.has(w.word) ? " checked" : ""}></td>`}
    <td>${i + 1}</td><td><b>${esc(w.word)}</b>${w.forms.length ? ` <small>(${esc(w.forms.join(", "))})</small>` : ""}</td>
    <td>${w.count}</td><td>${w.passages}</td><td>${tpPct(w.cumulative)}</td></tr>`).join("");
  const tools = forPrint ? "" : `<div class="tp-word-tools no-print">
      ${need ? `<button type="button" class="btn ghost small" data-wpick="need">${TOPIC_TARGET}%까지 ${need}개 고르기</button>` : ""}
      <span class="tp-topn">상위 <input type="number" id="tpTopN" min="1" max="${st.offlist.length}" step="10" value="${Math.min(st.offlist.length, tpState.picked.size || 100)}"> 개
        <button type="button" class="btn ghost small" data-wpick="topn">고르기</button></span>
      <button type="button" class="btn ghost small" data-wpick="all">모두 (${st.offlist.length}개)</button>
      <button type="button" class="btn ghost small" data-wpick="none">모두 해제</button>
    </div>
    <div class="tp-pack no-print">
      <div class="tp-pack-row">
        <label>한 단어장에 <input type="number" id="tpPackSize" min="5" max="500" step="5" value="${esc(String(tpState.pack.size))}"> 개씩</label>
        <label>정리 순서 <select id="tpPackOrder">
          <option value="freq"${tpState.pack.order === "freq" ? " selected" : ""}>많이 나온 순</option>
          <option value="first"${tpState.pack.order === "first" ? " selected" : ""}>기출에 처음 나온 순서(회차·번호 차례)</option>
          <option value="alpha"${tpState.pack.order === "alpha" ? " selected" : ""}>알파벳 순</option>
        </select></label>
      </div>
      <div class="tp-pack-row">
        <label>묶음 이름 <input type="text" id="tpPackBase" maxlength="40" value="${esc(tpState.pack.base)}" placeholder="${esc(tpPackBaseDefault())}"></label>
        <label>단어장 이름 <input type="text" id="tpPackLabel" maxlength="30" value="${esc(tpState.pack.label)}" placeholder="Day {n}"></label>
        <span class="hint">{n} 자리에 01, 02 … 번호가 들어갑니다(예: Day {n}, {n}강, Unit {n}).</span>
      </div>
      <div class="tp-pack-preview" id="tpPackPreview">${tpPackPreview()}</div>
      <button type="button" class="btn small" id="tpSendBtn" ${tpState.picked.size ? "" : "disabled"}>📒 고른 낱말로 단어장 만들기</button>
      <span class="hint">AI가 지문에서 쓰인 뜻을 달아(${TOPIC_WORDS_BATCH}단어마다 한 번) 단어장 탭으로 넘깁니다. 단어장 탭에서 [💾 사이트 저장]을 누르면 묶음 이름의 폴더 하나에 단어장마다 하나씩 저장됩니다.</span>
    </div>`;
  const more = !forPrint && st.offlist.length > shown
    ? `<button type="button" class="btn ghost small no-print" id="tpMoreWords">더 보기 (${shown}/${st.offlist.length})</button>` : "";
  return `<div class="tp-vocab-sec">
    ${stale && !forPrint ? `<div class="tp-stale no-print">⚠️ 회차나 지문이 바뀌었습니다. [📊 어휘 분석하기]를 다시 누르면 지금 지문으로 다시 셉니다(무료).</div>` : ""}
    <h4 class="sec">어휘 분석 — 교육과정 어휘로 몇 % 읽을까</h4>
    <ul class="tp-summary"><li>${levelLine}</li><li>${gapLine}</li>
      <li>교육과정 3,000단어 밖 낱말은 모두 <b>${st.offlistTotal.toLocaleString()}개</b>(같은 낱말의 변화형은 하나로 셉니다)입니다.</li></ul>
    ${vocabCharts}
    ${legend}${covs}
    ${hardHtml ? `<div class="rp-keep"><h5>어휘가 어려운 지문</h5>${hardHtml}</div>` : ""}
    ${forPrint ? "" : tpPeekHtml()}
    <h4 class="sec">${gap > 0 ? `${TOPIC_TARGET}%까지 필요한 추가 어휘` : "교육과정 3,000단어 밖 어휘"}</h4>
    <div class="hint">교육과정 3,000단어 밖 낱말을 많이 나온 차례로 모았습니다. '익히면'은 위에서부터 그 낱말까지 익혔을 때 읽을 수 있는 낱말 비율입니다${need ? ` — 색칠한 ${need}개가 ${TOPIC_TARGET}%까지입니다` : ""}. 지문은 PDF의 문제 모양 그대로라 빈칸 자리의 낱말은 빠져 있습니다(보기 줄은 세지 않습니다).</div>
    ${tools}
    <table class="tp-list tp-words"><thead><tr>${forPrint ? "" : `<th class="no-print">고르기</th>`}<th>순위</th><th>낱말</th><th>나온 횟수</th><th>나온 지문</th><th>익히면</th></tr></thead>
      <tbody>${wordRows}</tbody></table>${more}
  </div>`;
}

/* 지문 하나에 색을 칠해 보기(화면 전용) — 고른 수준에서 모르는 낱말을 주황으로 */
function tpPeekHtml() {
  const st = tpState.stats;
  const all = tpState.rounds.flatMap((r) => r.passages.filter((p) => p.on).map((p) => ({ r, p })));
  if (!all.length || !st.levels) return "";
  if (!all.some(({ p }) => p.id === tpState.peek.id)) tpState.peek.id = all[0].p.id;
  const cur = all.find(({ p }) => p.id === tpState.peek.id);
  const lv = tpState.peek.level;
  let unknown = 0;
  let total = 0;
  const body = esc(cur.p.text).replace(/[A-Za-z]+(?:['’][A-Za-z]+)*/g, (tok) => {
    const low = tok.toLowerCase().replace(/’/g, "'");
    const base = low.endsWith("n't") ? ({ won: "will", ca: "can", sha: "shall" }[low.slice(0, -3)] || low.slice(0, -3)) : low.split("'")[0];
    if (!(base in st.levels)) return tok;
    total++;
    const l = st.levels[base];
    if (l === null || l > lv) {
      unknown++;
      return `<mark class="tp-unk">${tok}</mark>`;
    }
    return tok;
  });
  const pct = total ? ((total - unknown) / total) * 100 : 0;
  return `<div class="tp-peek no-print">
    <h5>같은 지문, 아는 어휘가 달라지면 <small>화면에서만 보입니다</small></h5>
    <div class="tp-peek-ctl">
      <select id="tpPeekSel">${all.map(({ r, p }) => `<option value="${p.id}"${p.id === cur.p.id ? " selected" : ""}>${esc(r.name)} · ${esc(p.name)}</option>`).join("")}</select>
      ${TOPIC_LEVELS.map((l, i) => `<label class="chk"><input type="radio" name="tpPeekLv" value="${i}"${i === lv ? " checked" : ""}> ${i === 2 ? "교육과정 3,000단어" : esc(l) + (i ? "까지" : " 단어")}</label>`).join("")}
      <span class="tp-peek-pct">읽을 수 있는 낱말 <b>${tpPct(pct)}</b> <small><mark class="tp-unk">주황</mark> = 모르는 낱말</small></span>
    </div>
    <div class="tp-peek-text">${body}</div>
  </div>`;
}

function tpReportHtml(forPrint) {
  const topic = tpTopicHtml();
  const vocab = tpVocabHtml(forPrint);
  if (!topic && !vocab) return "";
  const rounds = tpState.rounds.filter((r) => r.passages.some((p) => p.on));
  const nPass = tpOnPassages().length;
  const rows = tpTopicRows();
  const nFields = new Set(rows.map((x) => x.t.field)).size;
  const st = tpState.stats;
  const tiles = reportTilesHtml([
    { label: "회차", value: rounds.length, unit: "회", color: "#4d94ec", sub: rounds.slice(0, 3).map((r) => r.name).join(" · ") + (rounds.length > 3 ? " …" : "") },
    { label: "분석한 지문", value: nPass, unit: "개", color: "#3f9c6b", sub: rows.length ? `소재 정리 ${rows.length}개` : "소재 분석 전" },
    { label: "나온 분야", value: rows.length ? nFields : "–", unit: rows.length ? "가지" : "", color: "#e07b39", sub: `분야 목록 ${TOPIC_FIELDS.length}가지 중` },
    { label: "3,000단어로 읽는 비율", value: st && st.tokens ? Number(st.coverage[2]).toFixed(1) : "–", unit: st && st.tokens ? "%" : "", color: "#1f5fb8", sub: st && st.tokens ? `기준선 ${TOPIC_TARGET}%` : "어휘 분석 전" },
  ]);
  const head = reportHeadHtml("기출 소재·어휘 분석", tpState.title || `${rounds.map((r) => r.name).join(" · ")} 소재·어휘 분석`,
    [["회차", esc(rounds.map((r) => r.name).join(", "))], ["지문", `${nPass}개`]]);
  return `<div class="trend-report tp-report">${head}${tiles}${topic}${vocab}</div>`;
}

function tpRenderReport() {
  const html = tpReportHtml(false);
  tpEl("tpResult").innerHTML = html ? `<section class="panel tp-panel">
      <div class="field tp-title-field no-print"><label for="tpTitle">보고서 제목 (선택)</label>
        <input type="text" id="tpTitle" maxlength="60" value="${esc(tpState.title)}" placeholder="예: 2026 고3 모의고사 소재·어휘 분석"></div>
      ${html}</section>` : "";
  const has = !!html;
  tpEl("tpPrintBtn").style.display = has ? "" : "none";
  tpEl("tpSaveBtn").style.display = tpState.rounds.length ? "" : "none";
}

tpEl("tpResult").addEventListener("input", (e) => {
  const key = { tpPackSize: "size", tpPackBase: "base", tpPackLabel: "label" }[e.target.id];
  if (key) {
    tpState.pack[key] = key === "size" ? e.target.value : e.target.value.trim();
    tpSyncSendBtn();
    return;
  }
  if (e.target.id === "tpTitle") {
    tpState.title = e.target.value.trim();
    const h = tpEl("tpResult").querySelector(".rp-head h3");
    if (h) h.textContent = tpState.title || `${tpState.rounds.map((r) => r.name).join(" · ")} 소재·어휘 분석`;
  }
});
tpEl("tpResult").addEventListener("change", (e) => {
  const t = e.target;
  if (t.classList.contains("tp-pick")) {
    if (t.checked) tpState.picked.add(t.dataset.w);
    else tpState.picked.delete(t.dataset.w);
    tpSyncSendBtn();
  } else if (t.id === "tpPackOrder") {
    tpState.pack.order = t.value;
    tpSyncSendBtn();
  } else if (t.id === "tpPeekSel") {
    tpState.peek.id = t.value;
    tpRefreshPeek();
  } else if (t.name === "tpPeekLv") {
    tpState.peek.level = Number(t.value);
    tpRefreshPeek();
  }
});
function tpRefreshPeek() {
  const old = tpEl("tpResult").querySelector(".tp-peek");
  if (old) old.outerHTML = tpPeekHtml();
}
function tpSyncSendBtn() {
  const b = tpEl("tpSendBtn");
  if (b) b.disabled = !tpState.picked.size || tpState.busy;
  const pv = tpEl("tpPackPreview");
  if (pv) pv.innerHTML = tpPackPreview();
}

/* ── 단어장 나누기 ── */
function tpPackBaseDefault() {
  // 회차 이름(파일 이름)을 이으면 너무 길어 보고서 제목이 있을 때만 쓴다
  return tpState.title ? `${tpState.title.replace(/ · /g, " ").slice(0, 30)} 추가 어휘` : "기출 추가 어휘";
}
const tpPackSize = () => Math.max(5, Math.min(500, Math.round(Number(tpState.pack.size) || 30)));
// 고른 낱말을 정리 순서대로
function tpPackOrdered() {
  const st = tpState.stats;
  const list = st.offlist.filter((w) => tpState.picked.has(w.word));
  if (tpState.pack.order === "alpha") return list.slice().sort((a, b) => a.word.localeCompare(b.word));
  if (tpState.pack.order === "first") return list.slice().sort((a, b) => (a.first ?? 1e9) - (b.first ?? 1e9));
  return list;   // 많이 나온 순 — 서버가 준 차례 그대로
}
// k번째(0부터) 단어장 이름 — '묶음 이름 · Day 01'. 묶음 이름이 폴더 이름이 되고 저장본은 '묶음 이름_Day 01'이 된다(app.js vocabBigName)
function tpPackName(k, total) {
  const base = (tpState.pack.base || tpPackBaseDefault()).trim();
  let label = (tpState.pack.label || "Day {n}").trim();
  if (!label.includes("{n}")) label += " {n}";
  const n = String(k + 1).padStart(Math.max(2, String(total).length), "0");
  return `${base} · ${label.split("{n}").join(n)}`.slice(0, 80);
}
function tpPackPreview() {
  const n = tpState.picked.size;
  if (!n) return "위 표에서 낱말을 고르세요.";
  const size = tpPackSize();
  const sets = Math.ceil(n / size);
  const calls = Math.ceil(n / TOPIC_WORDS_BATCH);
  const cost = PRICING ? PRICING.topicWords * calls : null;
  const last = n - size * (sets - 1);
  return `고른 낱말 <b>${n}개</b> → ${size}개씩 <b>단어장 ${sets}개</b>` +
    (sets > 1 && last !== size ? ` (마지막 단어장은 ${last}개)` : "") +
    ` · '${esc(tpPackName(0, sets))}'${sets > 1 ? ` ~ '${esc(tpPackName(sets - 1, sets))}'` : ""}` +
    (cost != null ? ` · 뜻 달기 ${calls}번 <b>${pt(cost)}</b>` : "");
}
tpEl("tpResult").addEventListener("click", (e) => {
  const st = tpState.stats;
  const pick = e.target.closest("[data-wpick]");
  if (pick && st) {
    const v = pick.dataset.wpick;
    const n = v === "need" ? tpWordsToTarget(st) || 0 : v === "none" ? 0 : v === "all" ? st.offlist.length
      : v === "topn" ? Math.max(0, Math.round(Number(tpEl("tpTopN").value) || 0)) : Number(v);
    tpState.picked = new Set(st.offlist.slice(0, n).map((w) => w.word));
    tpState.wordsShown = Math.max(tpState.wordsShown, n);
    tpRenderReport();
    return;
  }
  if (e.target.id === "tpMoreWords") {
    tpState.wordsShown += 100;
    tpRenderReport();
    return;
  }
  if (e.target.id === "tpSendBtn") tpSendWords();
});

/* ── ③ 단어장으로 보내기 ── */
// 낱말이 나온 첫 문장 — AI가 그 문장에서 쓰인 뜻을 달게 한다
function tpExampleFor(word, forms) {
  const re = new RegExp(`\\b(${[word, ...(forms || [])].map((w) => w.replace(/[^a-z'-]/gi, "")).join("|")})\\b`, "i");
  for (const { p } of tpOnPassages()) {
    if (!re.test(p.text)) continue;
    const sents = p.text.split(/(?<=[.?!])\s+/);
    const s = sents.find((x) => re.test(x));
    if (s) return s.trim().slice(0, 300);
  }
  return "";
}
async function tpSendWords() {
  const st = tpState.stats;
  if (!st || !tpState.picked.size || tpState.busy) return;
  const list = tpPackOrdered();
  const size = tpPackSize();
  const calls = Math.ceil(list.length / TOPIC_WORDS_BATCH);
  const cost = PRICING ? PRICING.topicWords * calls : 0;
  if (!(await costConfirmed(cost, `${TOPIC_NAME} · 추가 어휘 ${list.length}개에 뜻 달기 → ${size}개씩 단어장 ${Math.ceil(list.length / size)}개`))) return;
  const btn = tpEl("tpSendBtn");
  const errEl = tpEl("tpError");
  errEl.textContent = "";
  tpState.busy = true;
  btn.disabled = true;
  const meant = new Map();   // 낱말 → 뜻 달린 항목
  let stop = false;
  try {
    // 뜻 달기는 TOPIC_WORDS_BATCH개씩, TOPIC_PARALLEL번씩 함께 보낸다 — 600단어면 여섯 번
    const parts = [];
    for (let i = 0; i < list.length; i += TOPIC_WORDS_BATCH) parts.push(list.slice(i, i + TOPIC_WORDS_BATCH));
    let done = 0;
    for (let i = 0; i < parts.length && !stop; i += TOPIC_PARALLEL) {
      btn.textContent = `뜻을 다는 중… (${done}/${list.length})`;
      await Promise.all(parts.slice(i, i + TOPIC_PARALLEL).map((part) => postGenerate("/api/topicwords",
        { words: part.map((w) => ({ word: w.word, example: tpExampleFor(w.word, w.forms) })) },
        "뜻을 달지 못했습니다.")
        .then((res) => {
          (res.items || []).forEach((it) => meant.set(it.word.toLowerCase(),
            { word: it.word, pos: it.pos || "", meaning: it.meaning || "", synonym: it.synonym || "" }));
          done += part.length;
          btn.textContent = `뜻을 다는 중… (${done}/${list.length})`;
        }, (err) => {
          errEl.textContent = err.message || String(err);
          if (err.code === "quota" || err.code === "no_tokens") stop = true;
        })));
    }
  } finally {
    tpState.busy = false;
    btn.textContent = "📒 고른 낱말로 단어장 만들기";
    refreshTokenDisplay();
    tpSyncSendBtn();
  }
  // 정리 순서대로 뜻이 달린 것만 남기고 size개씩 자른다(못 단 낱말이 있어도 단어장마다 개수가 맞게)
  const items = list.map((w) => meant.get(w.word.toLowerCase())).filter(Boolean);
  if (!items.length) return;
  const missed = list.length - items.length;
  const total = Math.ceil(items.length / size);
  const sets = [];
  for (let k = 0; k < total; k++) sets.push({ name: tpPackName(k, total), vocab: items.slice(k * size, (k + 1) * size) });
  const vb = document.querySelector('.tab-btn[data-tab="vocab"]');
  if (vb) vb.click();
  const had = getVocabSets().length;
  const missNote = missed ? ` 뜻을 달지 못한 ${missed}개는 뺐습니다.` : "";
  if (sets.length === 1) {
    vocabEditorAdd(sets[0].vocab, sets[0].name, "extract");
    vocabBuildStatus(`🗂️ 기출 소재·어휘에서 <b>${items.length}단어</b>를 넘겼습니다.${missNote} AI가 쓴 뜻이니 아래 표에서 확인한 뒤 [완료]를 누르세요.`, "ok");
    return;
  }
  vocabEditorClose();
  sets.forEach((x) => appendVocabSet({ name: x.name, vocab: x.vocab, src: "extract" }));
  vocabBuildStatus(`🗂️ 기출 소재·어휘에서 <b>${items.length}단어</b>를 ${size}개씩 <b>단어장 ${sets.length}개</b>로 나눴습니다` +
    ` ('${esc(sets[0].name)}' ~ '${esc(sets[sets.length - 1].name)}').${missNote} ` +
    "위 '📚 쓸 단어장 고르기'에서 하나씩 확인할 수 있고, [💾 사이트 저장]을 누르면 묶음 이름의 폴더 하나에 단어장마다 하나씩 저장됩니다. " +
    (had ? `단어장 탭에 먼저 있던 단어장 ${had}개도 함께 저장되니, 필요 없으면 먼저 '쓸 단어장 고르기'에서 빼 주세요. ` : "") +
    "AI가 쓴 뜻이니 한 번 확인하세요.", "ok");
}

/* ── 인쇄·저장 ── */
tpEl("tpPrintBtn").addEventListener("click", () => {
  const html = tpReportHtml(true);
  if (!html) return;
  openPrintWindow(tpState.title || TOPIC_NAME, `<style>${TOPIC_CSS}</style>${html}`);
});
tpEl("tpSaveBtn").addEventListener("click", () => openSaveDialog("topic"));
tpEl("tpLoadBtn").addEventListener("click", () => openSavedList("tab", null, "topic"));

TAB_LABELS.topic = "🗂️ " + TOPIC_NAME;
TAB_LIBRARY_WORDS.topic = {
  title: `🗂️ ${TOPIC_NAME} 저장함`,
  lead: `저장해 둔 ${TOPIC_NAME} 분석입니다. 불러온 뒤 회차를 더 넣고 다시 분석할 수 있습니다(이미 정리한 지문의 소재는 다시 값을 받지 않습니다).`,
  empty: `아직 저장한 ${TOPIC_NAME} 분석이 없습니다. 분석한 뒤 “💾 사이트 저장”을 눌러 보세요.`,
};
SAVE_TITLE_SUGGEST.topic = () => tpState.title || `${tpState.rounds.map((r) => r.name).join(" · ")} 소재·어휘`.slice(0, 60);
TAB_SAVE.topic = {
  canSave: () => {
    if (!tpState.rounds.length) return "저장할 회차가 없습니다. 먼저 회차를 넣어 주세요.";
    // 저장본 문서는 1MiB 한도다 — 지문 글이 대부분이라 회차가 아주 많으면 나눠 저장하게 한다
    const size = JSON.stringify({ rounds: tpState.rounds, topics: tpState.topics }).length;
    return size > 900000 ? `회차·지문이 너무 많아 한 번에 저장할 수 없습니다(지문 ${tpOnPassages().length}개). 회차를 몇 개 빼고 나눠 저장해 주세요.` : "";
  },
  getPayload: () => ({
    v: 1,
    title: tpState.title,
    rounds: tpState.rounds,
    topics: tpState.topics,
    // 어휘 통계는 담지 않는다(낱말 표가 커서) — 불러올 때 다시 센다(무료)
    hadStats: !!tpState.stats,
  }),
  applyPayload: (payload) => {
    tpState.title = String(payload.title || "");
    tpState.rounds = (payload.rounds || []).map((r) => ({
      id: r.id || tpId("r"), name: String(r.name || ""),
      passages: (r.passages || []).map((p) => ({ id: p.id || tpId("p"), name: String(p.name || ""), text: String(p.text || ""),
        on: p.on !== false, no: p.no, nos: Array.isArray(p.nos) ? p.nos : [], restored: !!p.restored })),
    }));
    tpState.topics = payload.topics && typeof payload.topics === "object" ? payload.topics : {};
    tpState.stats = null;
    tpState.statsKey = "";
    tpState.picked = new Set();
    tpEl("tpError").textContent = "";
    tpStatus("");
    tpAfterChange();
    if (payload.hadStats) tpRunVocab();
  },
  clearResults: () => {
    tpState.rounds = [];
    tpState.topics = {};
    tpState.stats = null;
    tpState.statsKey = "";
    tpState.picked = new Set();
    tpState.title = "";
    tpEl("tpError").textContent = "";
    tpStatus("");
    tpAfterChange();
  },
};

/* ── 화면 CSS(인쇄 창에도 같은 것을 넣는다) ── */
const TOPIC_CSS = `
.tp-report h5{margin:14px 0 6px;font-size:14px}
.tp-report h5 small{font-weight:400;color:#777}
.tp-summary{margin:6px 0 12px;padding-left:18px;line-height:1.7;font-size:13.5px}
.tp-two{display:grid;grid-template-columns:1fr 1.2fr;gap:18px;align-items:start}
.tp-bar{display:grid;grid-template-columns:96px 1fr 28px;gap:8px;align-items:center;font-size:12.5px;margin:3px 0}
/* 막대 입체감 — 시험지 분석 리포트 막대(.tv-bar)와 같은 광택·그림자(2026-11-18 사용자) */
.tp-bar-track{height:14px;background:#eef1f5;border-radius:0 7px 7px 0;overflow:visible;box-shadow:inset 0 1px 2px rgba(26,31,43,.08)}
.tp-bar-track i{display:block;height:100%;border-radius:0 7px 7px 0;min-width:3px;
  background-image:linear-gradient(180deg,rgba(255,255,255,.55) 0,rgba(255,255,255,.12) 45%,rgba(0,0,0,.06) 100%);
  box-shadow:0 1px 2px rgba(26,31,43,.22),inset 0 -1px 0 rgba(0,0,0,.08)}
.tp-heat{background-image:linear-gradient(180deg,rgba(255,255,255,.45) 0,rgba(255,255,255,.08) 50%,rgba(0,0,0,.06) 100%);
  box-shadow:inset 0 -1px 0 rgba(0,0,0,.08)}
.tp-bar b{text-align:right}
.tp-grid,.tp-list{width:100%;border-collapse:collapse;font-size:12.5px}
.tp-grid th,.tp-grid td,.tp-list th,.tp-list td{border:1px solid #e3e6ea;padding:4px 6px;text-align:center}
.tp-grid tbody th{text-align:left;font-weight:600;white-space:nowrap}
.tp-list td:nth-child(3){text-align:left}
.tp-list thead th,.tp-grid thead th{background:#f4f6f9}
.tp-kw{color:#555;text-align:left !important}
.tp-list th,.tp-topics td:nth-child(2),.tp-topics td:nth-child(5){white-space:nowrap}
.tp-dot{display:inline-block;width:9px;height:9px;border-radius:50%;margin-right:5px;vertical-align:middle}
.tp-field-block{margin-bottom:8px}
.tp-legend{display:flex;flex-wrap:wrap;gap:12px;font-size:12px;color:#444;margin:4px 0 8px}
.tp-legend i{display:inline-block;width:12px;height:12px;border-radius:3px;margin-right:4px;vertical-align:-2px}
.tp-legend .tp-line-i{width:2px;height:13px;background:#d9534f;border-radius:0}
.tp-cov{display:grid;grid-template-columns:150px 1fr 56px;gap:10px;align-items:center;margin:5px 0;font-size:13px}
.tp-cov-label small{color:#888;font-size:11px}
.tp-cov-track{position:relative;height:16px;background:#eef1f5;border-radius:4px;display:flex;overflow:visible;box-shadow:0 1px 2px rgba(26,31,43,.22)}
.tp-cov-track i{display:block;height:100%;
  background-image:linear-gradient(180deg,rgba(255,255,255,.55) 0,rgba(255,255,255,.12) 45%,rgba(0,0,0,.08) 100%)}
.tp-cov-track i:first-child{border-radius:4px 0 0 4px}
.tp-cov-line{position:absolute;top:-3px;bottom:-3px;width:2px;background:#d9534f}
.tp-cov b{text-align:right}.tp-cov b.ok{color:#2c7a3f}
.tp-words td:nth-child(3),.tp-words td:nth-child(2){text-align:left}
.tp-words tr.tp-need td{background:#fff6e0}
.tp-word-tools{display:flex;flex-wrap:wrap;gap:6px;align-items:center;margin:6px 0}
.tp-topn input{width:70px}
.tp-pack{border:1px solid #d6e4f5;background:#f6faff;border-radius:10px;padding:10px 12px;margin:8px 0 10px;display:flex;flex-direction:column;gap:8px;font-size:13px}
.tp-pack-row{display:flex;flex-wrap:wrap;gap:12px;align-items:center}
.tp-pack-row input[type=number]{width:70px}.tp-pack-row input[type=text]{width:200px}
.tp-pack .btn{align-self:flex-start}
.tp-stale{background:#fff6e0;border:1px solid #f0d28a;border-radius:8px;padding:8px 10px;font-size:13px;margin:6px 0}
.tp-peek{border:1px dashed #c9d3df;border-radius:10px;padding:10px 12px;margin:12px 0}
.tp-peek-ctl{display:flex;flex-wrap:wrap;gap:10px;align-items:center;font-size:13px;margin-bottom:8px}
.tp-peek-ctl select{max-width:240px}
.tp-peek-pct{margin-left:auto}
.tp-peek-text{font-family:Georgia,"Times New Roman",serif;font-size:14.5px;line-height:1.75}
mark.tp-unk{background:#ffd6a5;color:inherit;padding:0 1px;border-radius:2px}
.tp-legend{margin-top:6px}
@media (max-width:700px){.tp-two{grid-template-columns:1fr}.tp-cov{grid-template-columns:90px 1fr 50px}.tp-peek-pct{margin-left:0}}
`;
(() => {
  const st = document.createElement("style");
  st.textContent = TOPIC_CSS + `
.tp-round{border:1px solid var(--line,#e3e6ea);border-radius:10px;padding:8px 10px;margin:8px 0}
.tp-round-head{display:flex;flex-wrap:wrap;gap:6px;align-items:center}
.tp-round-name{flex:1 1 200px;font-weight:600}
.tp-round-count{font-size:12.5px;color:#666}
.tp-chips{display:flex;flex-wrap:wrap;gap:4px;margin-top:6px}
.tp-chip{font-size:12px;padding:2px 8px;border:1px solid #cfd6df;border-radius:12px;background:#fff;color:#999;cursor:pointer;text-decoration:line-through}
.tp-chip.on{color:#1b2430;text-decoration:none;border-color:#4d94ec;background:#eef5ff}
.tp-chip.on.done::after{content:" ✓";color:#2c7a3f}
.tp-title-field{margin-bottom:10px}
`;
  document.head.appendChild(st);
})();

if (typeof HOWTO !== "undefined") {
  HOWTO.topic = {
    title: `🗂️ ${TOPIC_NAME} 만드는 법`,
    lead: "모의고사·수능 여러 회차를 넣으면 어떤 소재가 나왔는지 분야별로 정리하고, 교육과정 3,000단어로 지문을 몇 % 읽을 수 있는지와 그 간격을 메울 추가 어휘를 뽑아 단어장으로 보냅니다.",
    steps: [
      "<b>📄 모의고사 PDF로 회차 추가</b>로 시험지·유형별 모음집 PDF를 여러 개 한꺼번에 올립니다. 위쪽 지문 칸에 넣은 지문은 <b>⬇ 위 지문 칸에서 회차 추가</b>로 가져옵니다.",
      "PDF 글자를 문항별로 문제 모양 그대로 잘라 넣습니다(무료). 유형별 모음집은 출처를 읽어 시험별로 회차를 묶습니다. 회차 이름을 확인하고, 뺄 지문은 번호 단추를 눌러 끕니다(25~28번 도표·안내문은 처음엔 꺼져 있습니다). 지문을 저장하려면 회차의 <b>⬆ 지문 칸으로</b>를 누른 뒤 위쪽 지문 칸에서 저장합니다.",
      "<b>🗂️ 소재 분석하기</b>를 누르면 지문마다 분야·한 줄 소재·핵심어를 정리합니다(지문당 값). <b>📊 어휘 분석하기</b>는 무료입니다.",
      "어휘 분석 아래 <b>추가 어휘</b>에서 낱말을 고르고(<b>상위 ○개 고르기</b>·<b>95%까지 고르기</b>), <b>한 단어장에 ○개씩</b>·<b>정리 순서</b>·<b>묶음 이름</b>·<b>단어장 이름</b>(예: Day {n})을 정한 뒤 <b>📒 고른 낱말로 단어장 만들기</b>를 누릅니다 — 600개를 30개씩이면 단어장 20개가 단어장 탭에 생기고, [💾 사이트 저장]으로 한 폴더에 하나씩 저장됩니다.",
      "<b>🖨️ 인쇄 / PDF 변환</b>으로 보고서를 뽑거나 <b>💾 사이트 저장</b>으로 남겨 두고, 나중에 불러와 회차를 더 붙입니다.",
    ],
    tip: "빈칸·순서·삽입 문제도 문제 모양 그대로 분석합니다 — 소재를 정하는 데 정답은 필요 없고, 어휘는 본문 낱말을 셉니다(보기 ①~⑤ 줄과 각주는 뺍니다). 인쇄 보고서에는 지문 원문을 싣지 않습니다. '같은 지문, 아는 어휘가 달라지면' 칸은 화면에서만 보입니다.",
  };
}

document.querySelector('.tab-btn[data-tab="topic"]').addEventListener("click", tpSyncCost);
tpAfterChange();
