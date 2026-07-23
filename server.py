#!/usr/bin/env python3
"""영어 지문 분석본 자동 생성 웹앱 (순수 표준 라이브러리, pip 설치 불필요).

지문을 받아 Google Gemini API로 '청크 단위 직독직해' 분석본 JSON을 생성하고,
정적 프런트엔드(public/)가 이를 좌우 7:3 카드 형식으로 렌더링한다.

API 키는 (1) 웹 화면에서 입력(브라우저 localStorage 저장) 또는
        (2) 환경변수 GEMINI_API_KEY  로 제공할 수 있다.

실행:  python server.py       (기본 http://localhost:8000)
"""

import json
import os
import re
import sys
import time
import urllib.request
import urllib.error
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path

# 배포(Render 등)에서는 0.0.0.0 바인딩이 필요. 로컬에서도 localhost로 접속됨.
HOST = os.environ.get("HOST", "0.0.0.0")
PORT = int(os.environ.get("PORT", "8000"))
MODEL = os.environ.get("GEMINI_MODEL", "gemini-flash-latest")
# 모델명은 URL 경로에 들어가므로 안전한 형식만 허용 (하드코딩 목록 대신 형식 검증)
_MODEL_RE = re.compile(r"^gemini-[A-Za-z0-9.\-]+$")
PUBLIC_DIR = Path(__file__).resolve().parent / "public"

GEMINI_LIST_URL = "https://generativelanguage.googleapis.com/v1beta/models?pageSize=1000"

GEMINI_URL = (
    "https://generativelanguage.googleapis.com/v1beta/models/{model}:generateContent"
)

# 전송 실패 자동 재시도 설정 — 시간이 걸려도 모든 지문을 끝까지 분석(사용자 요청).
# 상한(포기) 없이 성공할 때까지 재시도하되, 한 번의 대기는 아래 값으로 잘라 반복한다.
RETRY_MIN_WAIT = 3       # 최소 대기(초) — 과도한 반복 방지
RETRY_MAX_WAIT = 60      # 한 번 대기의 상한(초)
MAX_RETRY_TOTAL = 150    # 누적 대기가 이 시간(초)을 넘으면 포기하고 명확히 안내
                         # (일시적 속도제한은 이 안에 풀림 / 하루 할당량 소진은 무한대기 방지)


def _parse_retry_delay(detail):
    """Gemini 429 오류 본문에서 권장 대기시간(초)을 뽑는다. 없으면 None.
    형식 예: error.details[].retryDelay = "17s"."""
    try:
        info = json.loads(detail)
    except Exception:
        return None
    for d in info.get("error", {}).get("details", []):
        rd = d.get("retryDelay")
        if isinstance(rd, str) and rd.endswith("s"):
            try:
                return float(rd[:-1])
            except ValueError:
                pass
    return None

# ── Gemini 구조화 출력 스키마 (파싱을 보장) ──
GEMINI_SCHEMA = {
    "type": "OBJECT",
    "properties": {
        "englishTitle": {"type": "STRING"},
        "koreanTitle": {"type": "STRING"},
        "sentences": {
            "type": "ARRAY",
            "items": {
                "type": "OBJECT",
                "properties": {
                    "no": {"type": "INTEGER"},
                    "tag": {"type": "STRING"},
                    "chunks": {
                        "type": "ARRAY",
                        "items": {
                            "type": "OBJECT",
                            "properties": {
                                "eng": {"type": "STRING"},
                                "kor": {"type": "STRING"},
                            },
                            "required": ["eng", "kor"],
                            "propertyOrdering": ["eng", "kor"],
                        },
                    },
                    "note": {"type": "STRING"},
                },
                "required": ["no", "tag", "chunks", "note"],
                "propertyOrdering": ["no", "tag", "chunks", "note"],
            },
        },
        "summary": {
            "type": "ARRAY",
            "items": {
                "type": "OBJECT",
                "properties": {
                    "label": {"type": "STRING"},
                    "content": {"type": "STRING"},
                },
                "required": ["label", "content"],
                "propertyOrdering": ["label", "content"],
            },
        },
        "vocab": {
            "type": "ARRAY",
            "items": {
                "type": "OBJECT",
                "properties": {
                    "word": {"type": "STRING"},
                    "pos": {"type": "STRING"},
                    "meaning": {"type": "STRING"},
                    "synonym": {"type": "STRING"},
                    "antonym": {"type": "STRING"},
                },
                "required": ["word", "pos", "meaning", "synonym", "antonym"],
                "propertyOrdering": ["word", "pos", "meaning", "synonym", "antonym"],
            },
        },
    },
    "required": ["englishTitle", "koreanTitle", "sentences", "summary", "vocab"],
    "propertyOrdering": ["englishTitle", "koreanTitle", "sentences", "summary", "vocab"],
}

SYSTEM_PROMPT = r"""You are an expert Korean high-school English teacher who produces
'청크 단위 직독직해' (chunk-by-chunk literal translation) analysis sheets for exam
passages (수능·모의고사·내신).

You will receive one English passage. Analyze it and return ONLY the structured JSON
described by the schema. Follow these rules exactly.

## Sentence splitting (STRICT RULES)
- Number sentences with the JSON `no` field: 1, 2, 3, … with NO gaps and NO duplicates.
  Every sentence of the passage appears EXACTLY ONCE, in original order.
- Split ONLY at a sentence-ending `.` `?` or `!` that truly ends a sentence (followed by
  a space + capital letter, a closing quote/paren then space+capital, or end of text).
- Do NOT split at:
  * abbreviations: Mr. Mrs. Ms. Dr. Prof. St. vs. etc. e.g. i.e. No. U.S. a.m. p.m.
  * decimals / numbers: 3.14, 1,000, No. 5
  * an ellipsis (…, ...) used mid-sentence
  * `;` (semicolon) or `:` (colon) — these stay INSIDE one sentence, never start a new one
- Keep closing quotation marks / parentheses and their punctuation WITH their sentence.
- Do NOT merge two sentences into one card, and do NOT split one sentence into two cards.
- If the passage already contains sentence markers (❶❷❸…, ①②③, or leading "1." "2.")
  use them ONLY as a hint for boundaries. Renumber cleanly from 1 in `no`, and REMOVE those
  marker characters from the chunk text (do not display them).
- `tag` = a very short Korean label for the sentence's role in the flow
  (e.g. "도입·주제 제시", "근거", "부연", "결론·대조"). Keep under ~10 chars.

## chunks — 청크(의미 단위) 배열: 각 청크마다 {eng, kor}
- Break the sentence into meaning units (chunks: phrases/clauses). Output them IN ORDER as
  the `chunks` array. For EACH chunk provide an object {eng, kor}:
  * `eng` = that English chunk's words (original order) with ruby annotations added per the
    rules below. Do NOT wrap the whole chunk in an extra span; NO slash separators.
  * `kor` = the PLAIN Korean translation of THAT chunk only (직독직해). Plain text only —
    NEVER put <ruby>, <rt>, <code>, or grammar/vocab color spans in `kor`.
- `eng` and `kor` of the same chunk must correspond one-to-one (same meaning unit).
- Chunk size: a natural phrase/clause (주어부, 동사구, 전치사구, 관계절, 부사절 등). Not too
  small (single articles) nor a whole long sentence.
- Annotate key grammar and vocabulary in `eng` with ruby tags placed OVER the word. The `rt`
  text is an EXPLANATION, not a translation — see the strict rule below.
  * Grammar (red) — rt = 문법 용어/기능 (grammatical term or function), NOT the meaning:
        <ruby class="over-tag"><span class="g">that</span><rt>명사절 접속사</rt></ruby>
        <ruby class="over-tag"><span class="g">were cultivated</span><rt>과거 수동태</rt></ruby>
        <ruby class="over-tag"><span class="g">to grow</span><rt>부사적 용법(목적)</rt></ruby>
  * Vocabulary (blue) — rt = 그 단어/숙어의 짧은 어휘 뜻 (one-word dictionary gloss):
        <ruby class="over-tag vocab-rt"><span class="v">cultivate</span><rt>재배하다</rt></ruby>
  * Grammar+vocab (purple) — rt = 문법 기능만 (뜻은 넣지 말 것):
        <ruby class="over-tag theme-rt"><span class="gv">regardless of</span><rt>전치사구</rt></ruby>
  * Emphasis / connective (yellow highlight) — rt = 연결어의 기능/역할 (역접·대조·첨가 등):
        <ruby class="over-tag hl-rt"><span class="hl">However</span><rt>역접(그러나)</rt></ruby>
- 등위·상관접속사 병렬구조 (MANDATORY — 절대 빠뜨리지 말 것): EVERY coordinating
  conjunction (and / or / but / nor / yet) that joins two or more parallel elements
  (words, phrases, or clauses) MUST be marked — and correlatives too (both…and,
  not only…but also, either…or, neither…nor, not…but). Mark the conjunction with
  <span class="conj-hl">and</span> and put a superscript number before EACH parallel
  element: <sup class="conj-num-top">1</sup>WORD ... <sup class="conj-num-top">2</sup>WORD
  Apply this to EVERY such conjunction in the passage — do not skip any, not even a
  simple "and" joining two nouns or verbs. This is the item most often forgotten.
- CRITICAL — separate 어법 vs 어휘 in rt content, NEVER mix them:
  * RED grammar tag (`class="g"`): rt = ONLY the grammatical term/function
    (관계대명사, 분사구문, 동명사, 가주어-진주어, 목적격보어(원형부정사), 도치, 강조구문 등).
    It must contain ZERO word meaning (뜻). If you feel the urge to write what the word
    means, that belongs on a BLUE vocab tag instead — not here.
      - WRONG: <rt>재배하다(과거 수동태)</rt>   ← 뜻이 섞임, 금지
      - RIGHT: <rt>과거 수동태</rt>
  * BLUE vocab tag (`class="v"`): rt = ONLY a short 어휘 뜻 (재배하다, 경멸적인 …).
    No grammar term here.
  * PURPLE grammar+vocab tag (`class="gv"`): use ONLY for a fixed expression whose
    grammar function matters; rt = the grammar function (기능 위주). Prefer red or blue
    over purple whenever possible.
  * rt is NEVER a phrase/sentence translation — the Korean translation lives ONLY in the
    chunk's `kor` field. Keep every rt very short.
- FINAL rt CHECK: before returning, re-scan every RED grammar rt and confirm it contains
  no word 뜻 (only a grammar label). Fix any that mix meaning in.
- Keep the original English words and order intact; only add ruby markup around them.
- Escape any literal < > & in the source text as &lt; &gt; &amp; (there usually are none).

### GRAMMAR COVERAGE (RED) — do NOT omit
Every sentence contains grammar points. For EACH sentence you must find and mark ALL
notable grammar structures with the RED grammar ruby (`<ruby class="over-tag"><span
class="g">…</span><rt>설명</rt></ruby>`). Scan for and mark every occurrence of:
  - 동사의 시제·상·태: 수동태(be+p.p.), 완료(have+p.p.), 진행(be+~ing), 완료수동 등
  - 준동사: to부정사(명사적/형용사적/부사적), 동명사, 현재분사, 과거분사, 분사구문
  - 관계사: who/whom/whose/which/that(관계대명사), where/when/why/how(관계부사), 계속적 용법
  - 접속사: that(명사절), whether/if(명사절), 부사절(although/because/while/if/unless/so that…), 등위·상관접속사(both…and, not only…but also, either…or)
  - 특수구문: 가정법, 도치, it~that 강조구문, 가주어/진주어(it~to/that), 부분/전체 부정, 비교급·최상급, 생략, 삽입
  - 목적격보어(원형부정사/현재분사/과거분사), 사역·지각동사 구문
RULE: it is far better to mark a clear grammar point than to skip it. Do NOT leave an
obvious grammar structure without a red ruby. Aim for full coverage in every sentence.
RULE (등위접속사): treat every and/or/but/nor/yet that links parallel elements as a
REQUIRED mark (conj-hl + numbered elements as above). Never leave one unmarked.

### FINAL SELF-CHECK (mandatory, before returning)
Re-read each chunk's `eng` one more time and run BOTH checks, fixing any miss:
1. COVERAGE: for every item in the coverage list that appears in that chunk, confirm it has
   a RED grammar ruby. If any is missing, ADD it now.
2. 등위접속사 SWEEP: scan the ENTIRE passage for every "and", "or", "but", "nor", "yet"
   (and correlatives both…and / either…or / not only…but also / neither…nor). For each one
   that joins parallel elements, confirm it is wrapped in <span class="conj-hl">…</span> and
   the parallel elements carry <sup class="conj-num-top">…</sup> numbers. This is the single
   most frequently forgotten item — verify it explicitly and add every missing one.
Only return the JSON after BOTH checks — every sentence should have at least one red grammar
annotation (a sentence with none almost always means you missed something).

## note — per-sentence commentary
- One or two sentences of objective, written-style Korean explaining the main grammar
  point(s) and key vocabulary in this sentence.
- Wrap every English word/expression in a <code> tag that is COLOR-CODED by role, so it
  visually matches the same word's color in the chunk `eng` (the reader connects them):
  * grammar point:     <code class="g">that</code>          (red)
  * vocabulary:        <code class="v">derogatory</code>    (blue)
  * grammar + vocab:   <code class="gv">regardless of</code>(purple)
  Choose the class consistently with how you annotated that word on the left side.
- NEVER put <ruby>, <rt>, or over-tag markup in `note`. Ruby annotations belong ONLY in
  the chunk `eng` (left column). In the note (right explanation column) English words are
  wrapped in <code> only — a stray <ruby> here breaks the right-column layout.

## summary (주제 & 흐름 요약)
- First item: {label:"주제", content: an English topic sentence, then <br>, then the
  Korean topic}.
- Following items: {label: "도입 ❶❷" style range labels using ❶❷❸..., content: Korean
  summary of that part}. Cover the whole passage in logical stages.

## vocab (핵심 어휘 & 표현)
- 8~14 of the most useful words/expressions actually in the passage.
- pos: n. / v. / adj. / adv. / phr. etc.  meaning: Korean. synonym/antonym: short
  English (use "—" when none).

Return valid JSON only. No markdown fences, no extra prose."""


_RT_RE = re.compile(r"<rt[^>]*>.*?</rt>", re.S)
_RUBY_RE = re.compile(r"</?ruby[^>]*>")
_ROLE_SPAN_RE = re.compile(r'<span class="(?:g|v|gv|hl|conj-hl)"[^>]*>(.*?)</span>', re.S)


def clean_korean(html):
    """한국어 해석 줄에 잘못 들어간 루비/주석/색상 스팬을 제거하고
    순수 한국어 + sep 구분자만 남긴다 (AI 실수 방어)."""
    if not html:
        return html
    html = _RT_RE.sub("", html)          # <rt>주석</rt> 제거
    html = _RUBY_RE.sub("", html)        # <ruby> 래퍼 제거
    prev = None
    while prev != html:                  # 역할 색상 스팬은 텍스트만 남기고 벗김
        prev = html
        html = _ROLE_SPAN_RE.sub(r"\1", html)
    return html


# 우측 해설(note)로 잘못 딸려온 루비 태그를 잡아 <code>로 바꾼다.
# 구조: <ruby ...><span class="g">word</span><rt>설명</rt></ruby>
_NOTE_RUBY_RE = re.compile(
    r'<ruby[^>]*>\s*<span class="(g|v|gv|hl|conj-hl)"[^>]*>(.*?)</span>\s*'
    r"(?:<rt[^>]*>.*?</rt>\s*)?</ruby>",
    re.S,
)


def clean_note(html):
    """해설(우측 설명 열)에 잘못 들어간 <ruby> 태그를 제거한다.
    루비는 좌측 본문 전용이므로, 해설에서는 rt(위 첨자 설명)를 떼어내고
    같은 역할 색상을 유지한 <code>로 변환해 레이아웃이 깨지지 않게 한다."""
    if not html:
        return html

    def repl(m):
        cls = m.group(1)
        inner = _RT_RE.sub("", m.group(2))       # 혹시 남은 rt 제거
        inner = _RUBY_RE.sub("", inner)          # 중첩 ruby 래퍼 제거
        prev = None
        while prev != inner:                     # 안쪽 역할 색상 스팬은 텍스트만
            prev = inner
            inner = _ROLE_SPAN_RE.sub(r"\1", inner)
        code_cls = cls if cls in ("g", "v", "gv") else ""
        attr = f' class="{code_cls}"' if code_cls else ""
        return f"<code{attr}>{inner}</code>"

    html = _NOTE_RUBY_RE.sub(repl, html)
    # 짝이 맞지 않아 남은 ruby/rt 잔재까지 방어적으로 제거
    html = _RT_RE.sub("", html)
    html = _RUBY_RE.sub("", html)
    return html


# ── 루비 색상 정규화: 안쪽 span 역할에 맞춰 보조 클래스를 강제로 맞춘다 ──
# (모델이 vocab-rt/theme-rt/hl-rt 를 빠뜨려도 범례 색상이 어긋나지 않도록)
_RUBY_BLOCK_RE = re.compile(r"<ruby\b[^>]*>(.*?)</ruby>", re.S)
_SPAN_ROLE_RE = re.compile(r'<span class="\s*(g|v|gv|hl)\b[^"]*"')
_RUBY_MOD = {"g": "over-tag", "v": "over-tag vocab-rt",
             "gv": "over-tag theme-rt", "hl": "over-tag hl-rt"}


def normalize_ruby(html):
    """각 <ruby>의 class를 안쪽 span 역할(g/v/gv/hl)에 맞는 값으로 다시 쓴다.
    이렇게 하면 어휘=파랑, 어법+어휘=보라, 강조=노랑, 어법=빨강 이 범례와 항상 일치한다."""
    if not html:
        return html

    def repl(m):
        inner = m.group(1)
        sm = _SPAN_ROLE_RE.search(inner)
        role = sm.group(1) if sm else "g"   # 역할 span이 없으면 어법(빨강)으로 간주
        return f'<ruby class="{_RUBY_MOD[role]}">{inner}</ruby>'

    return _RUBY_BLOCK_RE.sub(repl, html)


# ── AI가 만든 마크업 정화: 허용된 인라인 태그만 남겨 레이아웃 붕괴 방지 ──
_ALLOWED_TAGS = {"ruby", "rt", "span", "sup", "code", "br"}
_CLASS_ATTR_RE = re.compile(r'class\s*=\s*"([^"]*)"')
_ANY_TAG_RE = re.compile(r"</?([a-zA-Z0-9]+)([^>]*)>")


def sanitize_inline(html):
    """<div>, <table>, <script> 등 구조/위험 태그를 제거하고
    ruby·rt·span·sup·code·br 만 남긴다. 허용 태그는 class 속성만 유지."""
    if not html:
        return html

    def repl(m):
        tag = m.group(1).lower()
        if tag not in _ALLOWED_TAGS:
            return ""  # 허용 안 된 태그는 제거(안쪽 텍스트는 보존)
        if m.group(0).startswith("</"):
            return f"</{tag}>"
        cm = _CLASS_ATTR_RE.search(m.group(2) or "")
        cls = f' class="{cm.group(1)}"' if cm else ""
        return f"<{tag}{cls}>"

    return _ANY_TAG_RE.sub(repl, html)


def build_user_prompt(passage, target_grammar, mode, prior=None):
    lines = []
    if mode == "student":
        lines.append("대상: 학생 자기주도 학습용. 해설은 이해하기 쉽게 쓰되 정확하게.")
    else:
        lines.append("대상: 교사 수업/인쇄 배포용. 정확하고 간결한 문어체 해설.")
    if target_grammar.strip():
        lines.append(
            "목표 어법(이 문법 포인트를 특히 꼼꼼히 표시·설명할 것): "
            + target_grammar.strip()
        )
    lines.append("")
    lines.append("[지문]")
    lines.append(passage.strip())
    if prior is not None:
        # 2차 검토 패스: 1차 결과를 주고 빠진 어법·어휘·등위접속사를 보강시킨다.
        lines.append("")
        lines.append("[1차 분석 결과 — 아래를 검토·보강하라]")
        lines.append(json.dumps(prior, ensure_ascii=False))
        lines.append("")
        lines.append(
            "위 1차 결과를 지문과 대조하여, 빠지거나 틀린 표시를 모두 보강·수정하라. "
            "특히 ① 등위·상관접속사(and/or/but/nor/yet, both…and 등)와 병렬구조, "
            "② 준동사(to부정사·동명사·분사·분사구문), ③ 관계사, ④ 시제·상·태(수동/완료/진행), "
            "⑤ 특수구문(가정법·도치·강조·가주어진주어 등), ⑥ 핵심 어휘를 한 문장씩 다시 훑어 "
            "누락이 없는지 확인하라. 이미 올바른 부분은 그대로 두고, 누락은 추가, 오류는 수정하여 "
            "동일한 스키마의 '완전한' JSON으로 다시 출력하라. 문장 수·순서·번호는 1차와 동일해야 한다."
        )
    return "\n".join(lines)


def call_gemini(passage, target_grammar, mode, api_key, model, prior=None):
    api_key = (api_key or "").strip() or os.environ.get("GEMINI_API_KEY", "").strip()
    if not api_key:
        raise RuntimeError(
            "Gemini API 키가 없습니다. 화면 상단의 'API 키' 칸에 키를 입력하거나 "
            "환경변수 GEMINI_API_KEY 를 설정하세요."
        )
    model = model if (model and _MODEL_RE.match(model)) else MODEL

    sys_text = SYSTEM_PROMPT
    if prior is not None:
        sys_text += (
            "\n\n## REVIEW MODE (검토·보강 패스)\n"
            "You are now REVISING an existing analysis for completeness. Keep every correct "
            "mark, ADD every missed grammar/vocab/coordinating-conjunction mark, and FIX any "
            "wrong ones. Do not change sentence count, order, or numbering. Return the full "
            "corrected JSON in the same schema."
        )

    payload = {
        "systemInstruction": {"parts": [{"text": sys_text}]},
        "contents": [
            {
                "role": "user",
                "parts": [{"text": build_user_prompt(passage, target_grammar, mode, prior)}],
            }
        ],
        "generationConfig": {
            "temperature": 0.2,
            "maxOutputTokens": 65536,
            "responseMimeType": "application/json",
            "responseSchema": GEMINI_SCHEMA,
        },
    }
    data = json.dumps(payload).encode("utf-8")

    def _post(use_model):
        req = urllib.request.Request(
            GEMINI_URL.format(model=use_model),
            data=data,
            method="POST",
            headers={"content-type": "application/json", "x-goog-api-key": api_key},
        )
        with urllib.request.urlopen(req, timeout=300) as resp:
            return json.loads(resp.read().decode("utf-8"))

    def _generate(use_model):
        """전송 실패를 넉넉히 자동 재시도하되, 누적 대기가 MAX_RETRY_TOTAL을 넘으면
        무한 대기 대신 명확한 안내로 포기한다.
        - flash 429(속도 제한), 5xx(서버 과부하), 네트워크 오류 → 대기 후 재시도
        - 인증/모델/요청 오류(400/403/404), 비-flash 429 → 재시도 않고 바깥에서 처리
        일시적 속도 제한은 대개 이 시간 안에 풀리고, 하루 할당량이 소진된 경우엔
        영원히 매달리지 않고 사용자에게 원인을 알려준다."""
        is_flash = "flash" in (use_model or "").lower()
        attempt = 0
        waited = 0.0
        while True:
            try:
                return _post(use_model)
            except urllib.error.HTTPError as e:
                retryable = e.code in (500, 502, 503, 504) or (e.code == 429 and is_flash)
                if not retryable:
                    raise  # 비-flash 429·인증/모델 오류 등은 바깥에서 처리(본문 미소비)
                is_quota = e.code == 429
                wait = _parse_retry_delay(e.read().decode("utf-8", "replace")) if is_quota else None
                if wait is None:
                    wait = min(RETRY_MIN_WAIT * (2 ** attempt), RETRY_MAX_WAIT)  # 3,6,12,24,48,60…
                else:
                    wait = min(wait + 1, RETRY_MAX_WAIT)  # 권장시간 + 약간의 여유
                wait = max(wait, RETRY_MIN_WAIT)
                if waited + wait > MAX_RETRY_TOTAL:
                    if is_quota:
                        raise RuntimeError(
                            "무료 등급 사용량 한도를 초과했습니다(재시도해도 풀리지 않음). "
                            "① 정확도(모델)에서 다른 Flash 모델로 바꾸거나 ② 한도가 리셋된 뒤 "
                            "다시 시도하거나 ③ 한 번에 처리하는 지문 수를 줄이세요. "
                            "(Google 결제를 설정하면 한도가 크게 늘어납니다.)"
                        )
                    raise RuntimeError("서버가 계속 응답하지 않습니다(과부하). 잠시 뒤 다시 시도하세요.")
                time.sleep(wait)
                waited += wait
                attempt += 1
            except urllib.error.URLError:
                wait = min(RETRY_MIN_WAIT * (2 ** attempt), RETRY_MAX_WAIT)
                if waited + wait > MAX_RETRY_TOTAL:
                    raise RuntimeError("네트워크가 계속 불안정합니다. 연결을 확인하고 다시 시도하세요.")
                time.sleep(wait)
                waited += wait
                attempt += 1

    def _err_msg(e):
        detail = e.read().decode("utf-8", "replace")
        try:
            return json.loads(detail).get("error", {}).get("message", detail)
        except Exception:
            return detail

    try:
        body = _generate(model)
    except urllib.error.HTTPError as e:
        msg = _err_msg(e)
        low = msg.lower()
        model_gone = e.code in (400, 404) and (
            "no longer available" in low
            or "not found" in low
            or "is not supported" in low
            or "not available" in low
        )
        # Pro 등 무료 등급 미지원(429 할당량 0/초과) → Flash로 자동 대체
        quota_block = e.code == 429 and "flash" not in (model or "").lower()
        if model_gone or quota_block:
            try:
                avail = list_models(api_key)["models"]
            except Exception:
                avail = []
            alt = next(
                (m["id"] for m in avail if "flash" in m["id"].lower() and m["id"] != model),
                None,
            )
            if not alt and not quota_block:
                alt = avail[0]["id"] if avail else None
            if not alt:
                if quota_block:
                    raise RuntimeError(
                        "이 모델(Pro 등)은 무료 등급에서 사용할 수 없습니다(할당량 0). "
                        "정확도(모델)에서 Flash 모델을 고르거나, Google 결제(billing)를 설정하세요."
                    )
                raise RuntimeError(
                    "선택한 모델을 사용할 수 없고, 대체할 모델도 찾지 못했습니다. "
                    "정확도(모델) 목록에서 다른 모델을 골라 다시 시도하세요."
                )
            try:
                body = _generate(alt)  # Flash로 재시도
            except urllib.error.HTTPError as e2:
                raise RuntimeError(f"Gemini API 오류 {e2.code}: {_err_msg(e2)}")
        elif e.code in (400, 403) and "API" in msg.upper():
            raise RuntimeError(f"API 키 오류로 보입니다 ({e.code}): {msg}")
        else:
            raise RuntimeError(f"Gemini API 오류 {e.code}: {msg}")
    except urllib.error.URLError as e:
        raise RuntimeError(f"네트워크 오류: {e.reason}")

    # 안전 필터 등으로 후보가 없을 때
    feedback = body.get("promptFeedback", {})
    if feedback.get("blockReason"):
        raise RuntimeError(f"요청이 차단되었습니다: {feedback.get('blockReason')}")
    candidates = body.get("candidates") or []
    if not candidates:
        raise RuntimeError("모델이 응답을 생성하지 못했습니다. 지문을 확인하세요.")

    cand = candidates[0]
    finish = cand.get("finishReason")
    if finish in ("SAFETY", "RECITATION", "PROHIBITED_CONTENT"):
        raise RuntimeError(f"응답이 필터링되었습니다: {finish}")

    _TRUNC_MSG = (
        "출력이 최대 길이에 도달해 분석이 잘렸습니다. 이 지문이 너무 길어서 그렇습니다. "
        "지문을 두세 문단으로 나눠 각각 따로 분석하세요."
    )

    text = ""
    for part in cand.get("content", {}).get("parts", []):
        if "text" in part:
            text += part["text"]
    if not text:
        if finish == "MAX_TOKENS":
            raise RuntimeError(_TRUNC_MSG)
        raise RuntimeError(
            "모델 응답이 비어 있습니다. 출력이 잘렸을 수 있으니 더 짧은 지문으로 시도하세요."
        )
    try:
        result = json.loads(text)
    except json.JSONDecodeError:
        # 잘려서 JSON이 완성되지 못한 경우가 대부분 → 원인을 분명히 안내
        if finish == "MAX_TOKENS":
            raise RuntimeError(_TRUNC_MSG)
        raise RuntimeError("모델 응답을 JSON으로 해석하지 못했습니다.")
    # 길이 제한에 걸렸는데도 우연히 JSON이 파싱된 경우(내용이 부족) 방어
    if finish == "MAX_TOKENS":
        raise RuntimeError(_TRUNC_MSG)
    # AI 마크업 정화 + 한국어 루비 제거 (레이아웃 붕괴/오류 방어)
    for s in result.get("sentences", []):
        if not isinstance(s, dict):
            continue
        for c in s.get("chunks", []):
            if not isinstance(c, dict):
                continue
            if c.get("eng"):
                c["eng"] = normalize_ruby(sanitize_inline(c["eng"]))
            if c.get("kor"):
                c["kor"] = sanitize_inline(clean_korean(c["kor"]))
        if s.get("note"):
            s["note"] = sanitize_inline(clean_note(s["note"]))
    # 요약 content 도 정화 (표/구조 태그가 레이아웃을 깨는 것을 서버에서도 차단)
    for item in result.get("summary", []):
        if isinstance(item, dict) and item.get("content"):
            item["content"] = sanitize_inline(item["content"])
    return result


def list_models(api_key):
    """해당 키로 generateContent가 가능한 gemini 모델 목록을 반환."""
    api_key = (api_key or "").strip() or os.environ.get("GEMINI_API_KEY", "").strip()
    if not api_key:
        raise RuntimeError("Gemini API 키가 없습니다. 먼저 키를 입력하세요.")
    req = urllib.request.Request(
        GEMINI_LIST_URL,
        method="GET",
        headers={"x-goog-api-key": api_key},
    )
    try:
        with urllib.request.urlopen(req, timeout=30) as resp:
            body = json.loads(resp.read().decode("utf-8"))
    except urllib.error.HTTPError as e:
        detail = e.read().decode("utf-8", "replace")
        try:
            detail = json.loads(detail).get("error", {}).get("message", detail)
        except Exception:
            pass
        raise RuntimeError(f"모델 목록을 불러오지 못했습니다 ({e.code}): {detail}")
    except urllib.error.URLError as e:
        raise RuntimeError(f"네트워크 오류: {e.reason}")

    models = []
    for m in body.get("models", []):
        mid = m.get("name", "").split("/", 1)[-1]
        if not mid.startswith("gemini-"):
            continue
        if "generateContent" not in m.get("supportedGenerationMethods", []):
            continue
        low = mid.lower()
        # 임베딩/이미지생성 등 텍스트 분석에 부적합한 모델 제외
        if any(x in low for x in ("embedding", "image", "tts", "aqa", "vision")):
            continue
        # Flash 모델만 노출 (Pro는 무료 등급에서 사용 불가 → 제외)
        if "flash" not in low:
            continue
        # Flash-Lite 제외 (분석 품질 우선 — 누락이 많아 사용 안 함)
        if "lite" in low:
            continue
        models.append({"id": mid, "label": m.get("displayName", mid)})
    # 최신순 정렬 후 상위 5개만 반환 (-latest 별칭 우선, 그다음 버전 숫자 내림차순)
    def rank(m):
        mid = m["id"].lower()
        is_latest = 1 if mid.endswith("-latest") else 0
        vm = re.search(r"gemini-(\d+(?:\.\d+)?)", mid)
        ver = float(vm.group(1)) if vm else 0.0
        return (is_latest, ver, mid)

    models.sort(key=rank, reverse=True)
    return {"models": models[:5]}


CONTENT_TYPES = {
    ".html": "text/html; charset=utf-8",
    ".css": "text/css; charset=utf-8",
    ".js": "application/javascript; charset=utf-8",
    ".json": "application/json; charset=utf-8",
    ".svg": "image/svg+xml",
    ".ico": "image/x-icon",
}


class Handler(BaseHTTPRequestHandler):
    server_version = "PassageAnalyzer/1.0"

    def log_message(self, fmt, *args):
        sys.stderr.write("%s - %s\n" % (self.address_string(), fmt % args))

    def _send_json(self, obj, status=200):
        data = json.dumps(obj, ensure_ascii=False).encode("utf-8")
        self.send_response(status)
        self.send_header("content-type", "application/json; charset=utf-8")
        self.send_header("content-length", str(len(data)))
        self.end_headers()
        self.wfile.write(data)

    def do_GET(self):
        path = self.path.split("?", 1)[0]
        if path == "/":
            path = "/index.html"
        target = (PUBLIC_DIR / path.lstrip("/")).resolve()
        if not str(target).startswith(str(PUBLIC_DIR.resolve())) or not target.is_file():
            self.send_error(404, "Not found")
            return
        ctype = CONTENT_TYPES.get(target.suffix, "application/octet-stream")
        body = target.read_bytes()
        self.send_response(200)
        self.send_header("content-type", ctype)
        self.send_header("content-length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def do_POST(self):
        path = self.path.split("?", 1)[0]
        if path not in ("/api/analyze", "/api/models"):
            self.send_error(404, "Not found")
            return
        try:
            length = int(self.headers.get("content-length", "0"))
            raw = self.rfile.read(length) if length else b"{}"
            req = json.loads(raw.decode("utf-8"))
        except (ValueError, json.JSONDecodeError):
            self._send_json({"error": "잘못된 요청입니다."}, 400)
            return

        if path == "/api/models":
            try:
                self._send_json(list_models(req.get("apiKey") or ""))
            except Exception as e:
                self._send_json({"error": str(e)}, 502)
            return

        passage = (req.get("passage") or "").strip()
        if len(passage) < 20:
            self._send_json({"error": "분석할 영어 지문을 입력하세요 (20자 이상)."}, 400)
            return
        target_grammar = req.get("targetGrammar") or ""
        mode = req.get("mode") or "teacher"
        api_key = req.get("apiKey") or ""
        model = req.get("model") or MODEL
        review = bool(req.get("review"))

        try:
            result = call_gemini(passage, target_grammar, mode, api_key, model)
            if review:
                # 2차 검토 패스 — 1차 결과를 다시 보내 빠진 어법·어휘를 보강
                result = call_gemini(
                    passage, target_grammar, mode, api_key, model, prior=result
                )
        except Exception as e:
            self._send_json({"error": str(e)}, 502)
            return
        self._send_json(result)


def main():
    if not PUBLIC_DIR.is_dir():
        sys.exit(f"public 디렉터리를 찾을 수 없습니다: {PUBLIC_DIR}")
    server = ThreadingHTTPServer((HOST, PORT), Handler)
    key_set = "환경변수 설정됨" if os.environ.get("GEMINI_API_KEY") else "미설정 (화면에서 입력 가능)"
    print("영어 지문 분석본 웹앱 실행 중 (Google Gemini)")
    print(f"  주소     : http://{HOST}:{PORT}")
    print(f"  모델     : {MODEL}")
    print(f"  API 키   : {key_set}")
    print("  종료     : Ctrl+C")
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        print("\n종료합니다.")
        server.shutdown()


if __name__ == "__main__":
    main()
