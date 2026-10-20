/* 문제 시험(객관식·주관식 탭에서 만든 문제를 학생이 사이트에서 푼다) — 문항 그리기 공용.
   학생 화면(student.html)의 풀기·결과와 선생님 화면(index.html)의 답안 보기·채점이 같은
   모양을 쓰도록 한 파일에 둔다. 전역 이름이 app.js와 부딪치지 않게 window.QT 하나만 내놓는다.

   문항 모양은 서버의 _qt_student_view가 정한다(정답이 빠진 모양). 결과 화면에서는 서버가
   units(칸마다 내 답·정답·맞음)와 explanation을 더 붙여 보낸다. 채점 단위는 '답 칸 하나'다. */
(function () {
  "use strict";
  const CIRCLED = ["①", "②", "③", "④", "⑤"];
  // 모범답안과 다르게 써도 맞을 수 있는 모양 — 선생님 채점 단추를 단다(wbwrite = 워크북 영작 연습)
  const FREE = new Set(["short", "compose", "convert", "answer", "wbwrite"]);
  const esc = (s) => String(s == null ? "" : s)
    .replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");

  /* 발문의 판단 낱말(틀린·않은·적절한·옳은…)에 굵게+밑줄 — 시중 문제처럼 '옳은 것'과 '틀린 것'을
     헷갈리지 않게 한다(2026-10-20 사용자 결정: 부정·긍정 모두). AI에 맡기지 않고 그릴 때 붙이므로
     옛 저장본에도 적용되고 요금이 없다. '것·곳·문장…' 앞의 낱말만 잡아 "어법에 맞는 표현으로
     가장 적절한 것은"에서는 '적절한'만 칠한다. 이미 칠한 것은 벗기고 다시 칠해 겹치지 않는다.
     clean()이 속성을 지우므로 반드시 clean 뒤에 부른다. */
  const STEM_EM_RE = /(틀린|않은|않는|없는|아닌|다른|어색한|잘못된|올바른|바른|옳은|알맞은|맞는|적절한|일치하는|같은)(?=\s*(?:것|곳|말|문장|부분|낱말|단어|응답|대답|질문|설명|의미|뜻))/g;
  function emStem(html) {
    return String(html == null ? "" : html)
      .replace(/<span class="qz-em">([\s\S]*?)<\/span>/g, "$1")
      .split(/(<[^>]*>)/)
      .map((p) => (p.charAt(0) === "<" ? p : p.replace(STEM_EM_RE, '<span class="qz-em">$1</span>')))
      .join("");
  }

  /* 서버가 이미 br·u·b만 남기고 걸렀지만 학생 브라우저에 그대로 넣는 HTML이라 여기서도
     한 번 더 거른다 — 허용 태그 외에는 껍데기만 벗기고 글자는 남긴다, 속성은 모두 지운다. */
  const KEEP = new Set(["BR", "U", "B"]);
  function clean(html) {
    const tpl = document.createElement("template");
    tpl.innerHTML = String(html == null ? "" : html);
    const walk = (node) => {
      [...node.childNodes].forEach((c) => {
        if (c.nodeType === 1) {
          walk(c);
          if (KEEP.has(c.tagName)) {
            [...c.attributes].forEach((a) => c.removeAttribute(a.name));
          } else if (c.tagName === "SCRIPT" || c.tagName === "STYLE") {
            c.remove();
          } else {
            c.replaceWith(...c.childNodes);
          }
        } else if (c.nodeType !== 3) {
          c.remove();
        }
      });
    };
    walk(tpl.content);
    const box = document.createElement("div");
    box.appendChild(tpl.content);
    return box.innerHTML;
  }

  function unitCount(q) {
    switch (q.format) {
      case "mc": return 1;
      case "tf": return (q.statements || []).length;
      case "pick": case "verb": case "fill":
        return (q.segments || []).filter((s) => s.slot).length;
      case "find": case "gloss": return (q.prompts || []).length;
      case "fix": return q.fixCount || 0;
      case "read": return 0;
      case "order": case "wbwrite": return (q.lines || []).length;
      case "paraorder": return (q.paras || []).length;
      default: return 1;
    }
  }

  const passageBox = (html) =>
    String(html || "").trim() ? `<div class="qz-passage">${clean(html)}</div>` : "";

  // 지문 속에 칸이 있는 유형(pick·verb·fill) — 글 조각을 이어 한 번에 거른 뒤 칸 자리를 바꿔 넣는다
  // (조각마다 따로 거르면 <b>가 칸을 사이에 두고 열리고 닫힐 때 짝이 깨진다).
  function segmentsHtml(q, i, mode) {
    const raw = (q.segments || []).map((s) => (s.slot ? `${s.slot}` : s.html || "")).join("");
    const bySlot = new Map((q.segments || []).filter((s) => s.slot).map((s) => [s.slot, s]));
    const html = clean(raw).replace(/(\d+)/g, (_, n) => {
      const s = bySlot.get(Number(n));
      const u = Number(n) - 1;
      const no = `<span class="qt-blankno">(${n})</span>`;
      if (q.format === "pick") {
        if (mode !== "take") return `${no}<b class="wb-choice">[ ${esc(s.options[0])} / ${esc(s.options[1])} ]</b>`;
        return `${no}<span class="qt-pick">${s.options.map((o) =>
          `<button type="button" class="qt-opt" data-q="${i}" data-u="${u}" data-v="${esc(o)}">${esc(o)}</button>`).join("")}</span>`;
      }
      const hint = s.hint ? `<b class="wb-paren">(${esc(s.hint)})</b>` : "";
      if (mode !== "take") return `${no}${hint} <span class="wb-blank" style="min-width:70px"></span>`;
      return `${no}${hint}<input type="text" class="qt-in" data-q="${i}" data-u="${u}" autocomplete="off" autocapitalize="off" spellcheck="false">`;
    });
    return `<div class="qz-passage">${html}</div>`;
  }

  function bankHtml(q) {
    const bank = (q.wordBank || []).filter(Boolean);
    const conds = (q.conditions || []).filter(Boolean);
    return (bank.length
      ? `<div class="qz-scramble"><span class="qz-scramble-tag">&lt;보기&gt;</span>${esc(bank.join(" / "))}</div>` : "") +
      (conds.length
        ? `<div class="qz-conditions"><span class="qz-conditions-tag">&lt;조건&gt;</span><ul>${conds.map((c, k) =>
            `<li><span class="qz-num">${CIRCLED[k] || k + 1}</span><span>${esc(c)}</span></li>`).join("")}</ul></div>` : "");
  }

  // 결과 화면에서 고른 보기에 맞음/틀림 색을 입힌다
  function optClass(q, value, mode) {
    if (mode === "take") return "";
    const u = (q.units || [])[0] || {};
    if (q.format === "mc") {
      if (String(value) === String(q.answer)) return " right";
      if (String(value) === String(u.given)) return " wrong";
    }
    return "";
  }

  function bodyHtml(q, i, mode) {
    const fmt = q.format;
    const inputAttrs = (u, part) =>
      `class="qt-in" data-q="${i}" data-u="${u}"${part != null ? ` data-part="${part}"` : ""} autocomplete="off" autocapitalize="off" spellcheck="false"`;
    if (fmt === "pick" || fmt === "verb" || fmt === "fill") return segmentsHtml(q, i, mode);
    // ── 워크북에서 온 모양 ──
    if (fmt === "read") return passageBox(q.passageHtml);   // 좌지문 우해석 — 읽기만
    if (fmt === "order" || fmt === "wbwrite") {
      return (q.lines || []).map((l, j) =>
        `<div class="qt-cue"><span class="qt-blankno">(${j + 1})</span> ${esc(l.cue)}</div>` +
        (l.hint ? `<div class="qz-scramble">${esc(l.hint)}</div>` : "") +
        (mode === "take"
          // 힌트가 없는 줄은 단어 쓰기(워크북 13·14·15) — 문장이 아니라 단어·뜻 하나를 쓴다
          ? (l.hint ? `<textarea ${inputAttrs(j)} rows="2" placeholder="영어 문장 전체를 쓰세요"></textarea>`
                    : `<input type="text" ${inputAttrs(j)} placeholder="답을 쓰세요">`)
          : "")).join("");
    }
    if (fmt === "paraorder") {
      const paras = q.paras || [];
      const letters = paras.map((x) => x.letter).sort();
      const blocks = (q.head ? `<div class="qz-passage">${esc(q.head)}</div>` : "") +
        paras.map((x) => `<div class="qz-passage"><b>(${esc(x.letter)})</b> ${esc(x.text)}</div>`).join("") +
        (q.tail ? `<div class="qz-passage">${esc(q.tail)}</div>` : "");
      const rows = mode === "take"
        ? paras.map((_, k) => `<div class="qt-line"><span class="qt-blankno">${k + 1}번째</span><span class="qt-row-opts">${letters.map((L) =>
            `<button type="button" class="qt-opt" data-q="${i}" data-u="${k}" data-v="${esc(L)}">(${esc(L)})</button>`).join("")}</span></div>`).join("")
        : "";
      return blocks + rows;
    }
    if (fmt === "mc") {
      const n = q.choiceCount || (q.choices || []).length || 5;
      if ((q.choices || []).length) {
        return passageBox(q.passageHtml) + `<div class="qt-opts">${q.choices.map((c, k) =>
          `<button type="button" class="qt-opt${optClass(q, k + 1, mode)}" data-q="${i}" data-u="0" data-v="${k + 1}"${mode === "take" ? "" : " disabled"}>` +
          `<span class="qz-num">${CIRCLED[k] || k + 1}</span><span>${clean(c)}</span></button>`).join("")}</div>`;
      }
      // 어법·어휘처럼 지문의 밑줄 ①~⑤가 곧 보기인 문항 — 번호 단추만 둔다
      return passageBox(q.passageHtml) + `<div class="qt-row-opts">${Array.from({ length: n }, (_, k) =>
        `<button type="button" class="qt-opt${optClass(q, k + 1, mode)}" data-q="${i}" data-u="0" data-v="${k + 1}"${mode === "take" ? "" : " disabled"}>` +
        `<span class="qz-num">${CIRCLED[k] || k + 1}</span></button>`).join("")}</div>`;
    }
    if (fmt === "tf") {
      return passageBox(q.passageHtml) + (q.statements || []).map((t, j) =>
        `<div class="qt-cue">(${j + 1}) ${clean(t)}</div>` +
        (mode === "take"
          ? `<div class="qt-row-opts">${["O", "X"].map((v) =>
              `<button type="button" class="qt-opt" data-q="${i}" data-u="${j}" data-v="${v}">${v}</button>`).join("")}</div>`
          : "")).join("");
    }
    if (fmt === "find" || fmt === "gloss") {
      return passageBox(q.passageHtml) + (q.prompts || []).map((p, j) =>
        `<div class="qt-cue">(${j + 1}) ${esc(p)}</div>` +
        (mode === "take" ? `<input type="text" ${inputAttrs(j)} style="width:100%;">` : "")).join("");
    }
    if (fmt === "fix") {
      const rows = mode === "take"
        ? Array.from({ length: q.fixCount || 0 }, (_, j) =>
            `<div class="qt-line"><span class="qt-blankno">(${j + 1})</span>` +
            `<input type="text" ${inputAttrs(j, 0)} placeholder="틀린 말"> → <input type="text" ${inputAttrs(j, 1)} placeholder="바른 말"></div>`).join("")
        : "";
      return `<div class="qz-passage">${clean(q.passageHtml)}</div>` +
        `<p class="hint">틀린 곳 ${q.fixCount || 0}개를 찾아 고쳐 쓰세요 (순서는 상관없어요).</p>` + rows;
    }
    // write · short · compose · convert · answer — 문장 하나를 쓴다
    return passageBox(q.passageHtml) + bankHtml(q) +
      (mode === "take" ? `<textarea ${inputAttrs(0)} rows="2" placeholder="답을 쓰세요"></textarea>` : "");
  }

  function questionStatus(q) {
    const us = q.units || [];
    if (!us.length) return null;
    if (us.some((u) => u.ok === null || u.ok === undefined)) return "wait";
    return us.every((u) => u.ok === true) ? "ok" : "bad";
  }

  function markHtml(q) {
    const st = questionStatus(q);
    if (st === "ok") return `<span class="qt-mark ok">정답</span>`;
    if (st === "wait") return `<span class="qt-mark wait">선생님 확인 중</span>`;
    if (st === "bad") return `<span class="qt-mark bad">오답</span>`;
    return "";
  }

  // 칸마다 내 답 · 정답 · 맞음 — opts.grading이면 선생님이 고를 [맞음][틀림] 단추를 단다
  function unitsHtml(q, i, opts) {
    if (q.format === "read") return "";
    const us = q.units || [];
    if (!us.length) return `<p class="hint">제출한 답이 없습니다.</p>`;
    const showNo = us.length > 1;
    const label = (v) => (q.format === "mc" && v ? CIRCLED[Number(v) - 1] || v : v);
    const rows = us.map((u, j) => {
      const res = u.ok === true ? `<td class="ok">✓</td>` : u.ok === false ? `<td class="bad">✗</td>` : `<td class="hint">확인 중</td>`;
      const canGrade = opts.grading && (FREE.has(q.format) || u.ok === null || u.ok === undefined);
      const btns = canGrade
        ? `<td style="white-space:nowrap;"><button type="button" class="btn ghost small qt-grade" data-q="${i}" data-u="${j}" data-ok="1">맞음</button>` +
          ` <button type="button" class="btn ghost small qt-grade" data-q="${i}" data-u="${j}" data-ok="0">틀림</button></td>`
        : opts.grading ? "<td></td>" : "";
      return `<tr>${showNo ? `<td>(${j + 1})</td>` : ""}` +
        `<td${u.ok === false ? ' class="bad"' : ""}>${u.given ? esc(label(u.given)) : `<span class="hint">(무응답)</span>`}</td>` +
        `<td><b>${esc(label(u.correct))}</b></td>${res}${btns}</tr>`;
    }).join("");
    return `<div class="table-wrap" style="margin-top:8px;"><table class="qt-units">
      <thead><tr>${showNo ? "<th>#</th>" : ""}<th>${opts.grading ? "학생 답" : "내 답"}</th><th>정답</th><th></th>${opts.grading ? "<th></th>" : ""}</tr></thead>
      <tbody>${rows}</tbody></table></div>`;
  }

  /* mode: "take"(풀기) | "review"(결과 — 정답·해설). opts.grading: 선생님 채점 단추 */
  function questionHtml(q, i, mode, opts) {
    opts = opts || {};
    const review = mode !== "take";
    return `<div class="qz-card qt-card" data-q="${i}" data-fmt="${esc(q.format)}" data-units="${unitCount(q)}"
        data-status="${review ? questionStatus(q) || "" : ""}">
      <div class="qz-head"><span class="qz-no">${i + 1}</span>${q.type ? `<span class="qz-type">${esc(q.type)}</span>` : ""}
        ${review ? markHtml(q) : ""}</div>
      ${q.passageName ? `<div class="hint" style="margin-bottom:4px;">${esc(q.passageName)}</div>` : ""}
      <div class="qz-instruction">${emStem(clean(q.instruction))}</div>
      ${bodyHtml(q, i, mode)}
      ${review ? unitsHtml(q, i, opts) : ""}
      ${review && String(q.explanation || "").trim() ? `<div class="qt-exp"><b>해설</b><br>${clean(q.explanation)}</div>` : ""}
    </div>`;
  }

  // 풀기 화면 — 고르기 단추를 누르면 같은 칸의 다른 단추는 꺼진다
  function bind(root, onChange) {
    root.addEventListener("click", (e) => {
      const b = e.target.closest(".qt-opt");
      if (!b || b.disabled) return;
      root.querySelectorAll(`.qt-opt[data-q="${b.dataset.q}"][data-u="${b.dataset.u}"]`)
        .forEach((x) => x.classList.toggle("sel", x === b));
      onChange && onChange();
    });
    root.addEventListener("input", (e) => {
      if (e.target.classList.contains("qt-in")) onChange && onChange();
    });
  }

  // 화면의 답을 [문항][칸] 배열로 — 틀린 곳 고치기만 칸마다 [틀린 말, 바른 말]
  function collect(root, questions) {
    return questions.map((q, i) => {
      const n = unitCount(q);
      const ans = Array.from({ length: n }, () => (q.format === "fix" ? ["", ""] : ""));
      root.querySelectorAll(`.qt-opt.sel[data-q="${i}"]`).forEach((b) => { ans[Number(b.dataset.u)] = b.dataset.v; });
      root.querySelectorAll(`.qt-in[data-q="${i}"]`).forEach((el) => {
        const u = Number(el.dataset.u);
        if (u >= n) return;
        if (q.format === "fix") ans[u][Number(el.dataset.part)] = el.value;
        else ans[u] = el.value;
      });
      return ans;
    });
  }

  function restore(root, questions, answers) {
    (answers || []).forEach((ans, i) => {
      if (!Array.isArray(ans)) return;
      ans.forEach((v, u) => {
        if (Array.isArray(v)) {
          v.forEach((pv, part) => {
            const el = root.querySelector(`.qt-in[data-q="${i}"][data-u="${u}"][data-part="${part}"]`);
            if (el) el.value = pv || "";
          });
          return;
        }
        const el = root.querySelector(`.qt-in[data-q="${i}"][data-u="${u}"]`);
        if (el) { el.value = v || ""; return; }
        root.querySelectorAll(`.qt-opt[data-q="${i}"][data-u="${u}"]`)
          .forEach((b) => b.classList.toggle("sel", v !== "" && b.dataset.v === String(v)));
      });
    });
  }

  function blankCount(answers) {
    let n = 0;
    (answers || []).forEach((ans) => (ans || []).forEach((v) => {
      if (Array.isArray(v) ? !v.some((x) => String(x || "").trim()) : !String(v || "").trim()) n++;
    }));
    return n;
  }

  // 점수 대신 보여 주는 한 줄 — 문항 단위 맞음·틀림(·확인 중) 개수. html이면 색을 입힌다
  function countsText(qc, html) {
    if (!qc) return "";
    const ok = html ? `<b style="color:#15803d">맞음 ${qc.right}</b>` : `맞음 ${qc.right}`;
    const bad = html ? `<b style="color:#b91c1c">틀림 ${qc.wrong}</b>` : `틀림 ${qc.wrong}`;
    return `${ok} · ${bad}${qc.pending ? ` · 확인 중 ${qc.pending}` : ""}`;
  }

  window.QT = { countsText, clean, emStem, esc, unitCount, questionHtml, questionStatus, bind, collect, restore, blankCount };
})();
