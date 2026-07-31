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
MODEL = os.environ.get("GEMINI_MODEL", "gemini-3.6-flash")
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

# --- 요청 시간 예산 -------------------------------------------------------
# 아래 기본값은 '로컬 실행' 기준으로, 끊는 프록시가 없으므로 넉넉하게 둔다.
# (Gemini가 503 과부하를 내도 오래 기다려 결국 성공시키는 쪽이 유리하다)
#
# 반면 Render 등 PaaS의 프록시는 응답 바이트가 나가지 않는 요청을 100초 안팎에서
# 끊고 JSON 대신 HTML 에러 페이지를 반환한다. 그러면 아래의 친절한 한국어 오류
# 메시지조차 사용자에게 도달하지 못한다. 그래서 배포 환경에서만 값을 줄이며,
# 그 설정은 render.yaml의 envVars에 들어 있다.
MAX_RETRY_TOTAL = float(os.environ.get("MAX_RETRY_TOTAL", "150"))
                         # 누적 재시도 대기가 이 시간(초)을 넘으면 포기하고 명확히 안내
GEMINI_TIMEOUT = float(os.environ.get("GEMINI_TIMEOUT", "300"))
                         # Gemini 호출 1회의 소켓 타임아웃(초)
REFINE_BUDGET = float(os.environ.get("REFINE_BUDGET", "86400"))
                         # 이 시간(초)을 이미 쓴 뒤에는 보정 재요청을 시작하지 않는다
                         # (로컬 기본값은 사실상 무제한 = 원래 동작 그대로)


def _over_budget(t0):
    """이번 요청에 이미 REFINE_BUDGET 이상을 썼으면 True.
    (품질 보정 재요청을 한 번 더 시작할 여유가 없다는 뜻)"""
    return (time.monotonic() - t0) >= REFINE_BUDGET


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
                                "text": {"type": "STRING"},
                                "kor": {"type": "STRING"},
                                "anns": {
                                    "type": "ARRAY",
                                    "items": {
                                        "type": "OBJECT",
                                        "properties": {
                                            "t": {"type": "STRING"},
                                            "role": {"type": "STRING"},
                                            "rt": {"type": "STRING"},
                                            "num": {"type": "INTEGER"},
                                        },
                                        "required": ["t", "role", "rt", "num"],
                                        "propertyOrdering": ["t", "role", "rt", "num"],
                                    },
                                },
                            },
                            "required": ["text", "kor", "anns"],
                            "propertyOrdering": ["text", "kor", "anns"],
                        },
                    },
                    "note": {"type": "STRING"},
                    "isTopic": {"type": "BOOLEAN"},
                    "examTags": {"type": "ARRAY", "items": {"type": "STRING"}},
                    "examNote": {"type": "STRING"},
                },
                "required": ["no", "tag", "chunks", "note", "isTopic", "examTags", "examNote"],
                "propertyOrdering": ["no", "tag", "chunks", "note", "isTopic", "examTags", "examNote"],
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

# ── 문제 제작(수능형 객관식 문제) 스키마 ──
QUIZ_SCHEMA = {
    "type": "OBJECT",
    "properties": {
        "questions": {
            "type": "ARRAY",
            "items": {
                "type": "OBJECT",
                "properties": {
                    "no": {"type": "INTEGER"},
                    "type": {"type": "STRING"},
                    "format": {"type": "STRING"},
                    "instruction": {"type": "STRING"},
                    "passageHtml": {"type": "STRING"},
                    "choices": {"type": "ARRAY", "items": {"type": "STRING"}},
                    "answer": {"type": "INTEGER"},
                    "answerText": {"type": "STRING"},
                    "tfItems": {
                        "type": "ARRAY",
                        "items": {
                            "type": "OBJECT",
                            "properties": {
                                "text": {"type": "STRING"},
                                "isTrue": {"type": "BOOLEAN"},
                            },
                            "required": ["text", "isTrue"],
                            "propertyOrdering": ["text", "isTrue"],
                        },
                    },
                    "fixes": {
                        "type": "ARRAY",
                        "items": {
                            "type": "OBJECT",
                            "properties": {
                                "wrong": {"type": "STRING"},
                                "right": {"type": "STRING"},
                            },
                            "required": ["wrong", "right"],
                            "propertyOrdering": ["wrong", "right"],
                        },
                    },
                    "explanation": {"type": "STRING"},
                },
                "required": ["no", "type", "format", "instruction", "passageHtml",
                             "choices", "answer", "answerText", "tfItems", "fixes", "explanation"],
                "propertyOrdering": ["no", "type", "format", "instruction", "passageHtml",
                                     "choices", "answer", "answerText", "tfItems", "fixes", "explanation"],
            },
        },
    },
    "required": ["questions"],
    "propertyOrdering": ["questions"],
}

QUIZ_TYPE_LABELS = [
    "주제", "제목", "요지", "빈칸", "어휘", "어법", "순서", "문장삽입",
    "내용일치(영)", "내용일치(한)", "내용불일치(영)", "내용불일치(한)",
    "서술형배열", "OX진위",
    "어휘 선택형", "어법 선택형", "틀린 어휘 찾기", "틀린 어법 찾기",
]

QUIZ_SYSTEM_PROMPT = r"""You are an expert Korean high-school English teacher who writes
수능·모의고사 style multiple-choice reading-comprehension questions from a given English
passage. Return ONLY the structured JSON described by the schema — no markdown, no prose.

You will receive: (1) one English passage, (2) a list of ALLOWED question types, (3) how
many questions total to produce. Produce EXACTLY that many questions, choosing types ONLY
from the allowed list (spread across different types when possible; only repeat a type if
the allowed list is smaller than the requested count).

## Output per question — fields
- `no`: 1, 2, 3… in order.
- `type`: one of the allowed type names, EXACTLY as given (e.g. "주제").
- `format`: "mc" for 5-choice questions, "write" for 서술형배열, "tf" for OX진위,
  "pick" for 어휘/어법 선택형, "fix" for 틀린 어휘/어법 찾기.
  Every type is "mc" EXCEPT those five.
- `instruction`: the exact Korean question line the student reads (수능 어투 그대로), e.g.
  "다음 글의 주제로 가장 적절한 것은?". For "문장삽입" also embed the sentence to insert,
  on its own line after the question line, like:
  다음 글에서 전체 흐름으로 보아 주어진 문장이 들어가기에 가장 적절한 곳을 고르시오.<br><br>
  <b>주어진 문장:</b> The sentence text.
- `passageHtml`: the passage the student reads for THIS question, reformatted per the rules
  below. Plain text plus ONLY <br>, <u>, <b> tags allowed — nothing else (no colors/ruby).
- `choices`: for "mc", EXACTLY 5 short strings — do NOT prefix them with ①②③④⑤ (the app adds
  those). For "write" and "tf", set `choices` to an empty array [].
- `answer`: for "mc", integer 1–5 = the 1-based index of the correct choice.
  For "write" and "tf", set `answer` to 0.
- `answerText`: for "write", the correct English sentence (verbatim from the passage).
  For "mc" and "tf", set to "".
- `tfItems`: for "tf", EXACTLY 5 items {text, isTrue}. For every other format, set to [].
- `fixes`: for "fix", one {wrong, right} per planted error. For every other format, set to [].
- `explanation`: 2–4 Korean sentences (문어체) explaining why the answer is correct and why
  the others are wrong — specific, referencing the passage content.

## Type-specific rules (only use types present in the allowed list)
- "주제" — instruction "다음 글의 주제로 가장 적절한 것은?". passageHtml = full passage,
  unmodified. choices = 5 topic phrases (English or Korean), one clearly correct.
- "제목" — instruction "다음 글의 제목으로 가장 적절한 것은?". passageHtml = full passage,
  unmodified. choices = 5 short English title phrases.
- "요지" — instruction "다음 글의 요지로 가장 적절한 것은?". passageHtml = full passage,
  unmodified. choices = 5 Korean 요지 문장.
- "빈칸" — instruction "다음 빈칸에 들어갈 말로 가장 적절한 것은?". passageHtml = the
  passage with ONE key phrase replaced by "_______________". choices = 5 candidate English
  phrases that fit the blank grammatically, one clearly the best fit.
- "어휘" — instruction "다음 글의 밑줄 친 부분 중, 문맥상 낱말의 쓰임이 적절하지 않은
  것은?". passageHtml = full passage with EXACTLY 5 words/short phrases each wrapped in <u>
  and preceded by a circled number (①<u>word</u>, ②<u>word</u> … ⑤<u>word</u>), spread
  across the passage. Exactly ONE of the 5 is WRONG in context (e.g. swap in a near-antonym);
  that one is the answer. choices = ["①","②","③","④","⑤"] in that literal order.
  UNDERLINE BOUNDARIES ARE CRITICAL — a student must see exactly where the underline starts
  and ends. <u> must wrap the COMPLETE word(s), never a fragment: write ⑤<u>learning</u>,
  NEVER ⑤<u>learnin</u>g. The circled number goes immediately BEFORE <u>, outside it, and
  the closing </u> must come right after the word's last letter (before any space/comma/period).
- "어법" — instruction "다음 글의 밑줄 친 부분 중, 어법상 틀린 것은?". Same passageHtml/
  choices mechanics as 어휘 (5 underlined circled-numbered spans), but each is a GRAMMAR
  point and exactly one contains a genuine grammar error you introduce (e.g. wrong verb
  form/agreement/relative pronoun/parallel structure).
- "순서" — instruction "주어진 글 다음에 이어질 글의 순서로 가장 적절한 것은?".
  passageHtml = the passage's first 1–2 sentences (the given opening) then <br><br>, then the
  REST of the passage split into exactly 3 blocks labeled <b>(A)</b>, <b>(B)</b>, <b>(C)</b>
  (each starting a new line via <br><br>) given in a SCRAMBLED (non-original) order. choices
  = 5 plausible orderings like "(B)-(A)-(C)", only one matching the passage's true order.
- "문장삽입" — instruction as described above (includes the sentence to insert). passageHtml
  = the rest of the passage (after removing one sentence) with 5 candidate insertion points
  marked as circled numbers ①~⑤ placed BETWEEN sentences. choices = ["①","②","③","④","⑤"]
  in that literal order; answer = where the removed sentence truly belongs.
- "내용일치(영)" — instruction "다음 글의 내용과 일치하는 것은?". passageHtml = full passage,
  unmodified. choices = 5 ENGLISH statements about the passage; EXACTLY ONE is true to the
  passage, the other 4 must CONTRADICT it (not merely be unmentioned). answer = the true one.
- "내용일치(한)" — identical to "내용일치(영)" but every choice is written in KOREAN.
- "내용불일치(영)" — instruction "다음 글의 내용과 일치하지 않는 것은?". passageHtml = full
  passage, unmodified. choices = 5 ENGLISH statements; EXACTLY FOUR are true to the passage
  and ONE contradicts it. answer = the FALSE one.
- "내용불일치(한)" — identical to "내용불일치(영)" but every choice is written in KOREAN.
  For all four 내용일치/불일치 types: base each statement on a DIFFERENT part of the passage,
  keep them one clause long, and make wrong ones wrong by a concrete factual flip (숫자·주체·
  인과·시점을 바꾸기) — never by vague wording.
- "서술형배열" (format "write") — instruction
  "다음 우리말과 같은 뜻이 되도록 주어진 단어를 모두 배열하여 문장을 완성하시오."
  Pick ONE key sentence of the passage (주제문이나 핵심 문장, 8~20 words).
  · `answerText` = that English sentence, VERBATIM from the passage.
  · `passageHtml` = ONLY the Korean translation of that one sentence (the student writes the
    English from it). Do NOT include the whole passage and do NOT include the English words —
    the app scrambles `answerText` itself to show the word bank.
  · choices = [], answer = 0.
- "어휘 선택형" (format "pick") — instruction
  "다음 각 네모 안에서 문맥상 알맞은 낱말을 골라 쓰시오."
  `passageHtml` = 3~6 sentences taken from the passage, PLAIN TEXT ONLY (no HTML tags at all),
  containing 4~8 bracketed pairs written EXACTLY as [정답|오답]:
    · left of `|` = the word that actually appears in the passage (the correct answer)
    · right of `|` = a wrong word that is contextually confusable (반의어나 비슷하게 생긴 낱말)
  The app shuffles the display order and collects the answers itself.
  Test WORD MEANING (어휘), not grammar. choices = [], answer = 0, answerText = "", fixes = [].
- "어법 선택형" (format "pick") — instruction
  "다음 각 네모 안에서 어법상 알맞은 것을 골라 쓰시오."
  Same [정답|오답] mechanics as 어휘 선택형, but each pair tests a GRAMMAR point
  (수일치, 시제, 태, 준동사(to부정사/동명사/분사), 관계사, 대명사, 병렬구조 등).
  The wrong option must be a genuinely ungrammatical alternative, not just an odd word choice.
  choices = [], answer = 0, answerText = "", fixes = [].
- "틀린 어휘 찾기" (format "fix") — instruction
  "다음 글에서 문맥상 낱말의 쓰임이 적절하지 않은 것을 모두 찾아 바르게 고쳐 쓰시오."
  `passageHtml` = one paragraph of the passage, PLAIN TEXT ONLY, identical to the original
  EXCEPT that exactly 2~3 words are replaced by contextually WRONG words (주로 반의어).
  `fixes` = one {wrong, right} per replaced word: `wrong` = the word you planted (must appear
  VERBATIM in passageHtml), `right` = the original word from the passage.
  The app underlines the planted words and prints the correction lines.
  choices = [], answer = 0, answerText = "".
- "틀린 어법 찾기" (format "fix") — instruction
  "다음 글에서 어법상 틀린 부분을 모두 찾아 바르게 고쳐 쓰시오."
  Same mechanics as 틀린 어휘 찾기, but plant 2~3 GRAMMAR errors instead
  (주어-동사 수일치 오류, 시제/태 오류, to부정사↔동명사 오용, 관계사 오용, 병렬 파괴 등).
  `fixes` = {wrong: the ungrammatical form you planted, right: the original correct form}.
  choices = [], answer = 0, answerText = "".
- "OX진위" (format "tf") — instruction
  "다음 글의 내용과 일치하면 O, 일치하지 않으면 X를 쓰시오."
  passageHtml = full passage, unmodified. `tfItems` = EXACTLY 5 objects {text, isTrue}:
  · `text` = one short ENGLISH statement about the passage.
  · `isTrue` = true if it matches the passage, false if it contradicts it.
  Mix them up — roughly 2~3 true and 2~3 false, in a non-obvious order. Each statement must
  come from a DIFFERENT part of the passage. choices = [], answer = 0.

## Quality rules
- Base everything on the ACTUAL passage content — never invent facts not in the passage.
- Only ONE choice may be correct; the other 4 must be clearly wrong to a careful reader but
  plausible enough to require real understanding (avoid silly/obviously-wrong options).
- Vary which choice number is correct across questions (don't make the answer always ①).
- Escape literal < > & in passage text as &lt; &gt; &amp; before adding your own <u>/<b>/<br>.

Return valid JSON only."""


def build_quiz_user_prompt(passage, types, count, short_hint=None):
    lines = [
        f"허용된 문제 유형: {', '.join(types)}",
        f"총 문항 수: {count}개 (정확히 이 개수만큼 생성)",
        # 화면의 유형 선택 칸에 '출제 순서' 번호를 보여 주므로, 그 순서와 실제
        # 출제 순서가 반드시 일치해야 한다.
        "⚠️ 문항 순서: 위 '허용된 문제 유형'에 나열된 순서 그대로 questions 배열에 담으세요. "
        "같은 유형을 여러 문항 낼 때는 그 유형의 문항들을 연달아 배치하세요.",
    ]
    n = len(types)
    if n == count:
        lines.append("각 유형을 정확히 1문항씩, 위 목록의 모든 유형을 빠짐없이 출제하세요.")
    elif count > n:
        per, extra = divmod(count, n)
        detail = f"각 유형을 최소 {per}문항씩"
        if extra:
            detail += f", 그중 {extra}개 유형은 {per + 1}문항씩"
        lines.append(
            detail + " 출제해 총 " + str(count) + "문항을 채우세요. "
            "모든 유형이 최소 1문항은 나와야 하며, 같은 유형을 여러 번 낼 때는 "
            "지문의 서로 다른 부분·다른 정답을 다루어 문항이 겹치지 않게 하세요."
        )
    else:
        lines.append(
            f"허용된 유형 중 {count}개를 골라 서로 다른 유형으로 1문항씩 출제하세요."
        )
    if short_hint is not None:
        lines.append(
            f"⚠️ 이전 시도는 {short_hint}문항만 만들었습니다. 이번에는 반드시 {count}문항을 "
            f"끝까지 모두 생성하세요. 중간에 멈추지 마세요."
        )
    lines += ["", "[지문]", passage.strip()]
    return "\n".join(lines)


_QUIZ_TRUNC_MSG = (
    "출력이 최대 길이에 도달해 문제 생성이 잘렸습니다. 문항 수를 줄이거나 "
    "지문을 더 짧게 나눠 다시 시도하세요."
)

_QUIZ_ALLOWED_TAGS = {"br", "u", "b"}
_QUIZ_ANY_TAG_RE = re.compile(r"</?([a-zA-Z0-9]+)([^>]*)>")


def sanitize_quiz_html(html):
    """문제 지문 HTML에서 <br>/<u>/<b> 만 남기고 나머지 태그는 제거한다."""
    if not html:
        return html

    def repl(m):
        tag = m.group(1).lower()
        if tag not in _QUIZ_ALLOWED_TAGS:
            return ""
        return m.group(0) if m.group(0).startswith("</") else f"<{tag}>"

    return _QUIZ_ANY_TAG_RE.sub(repl, html)


# 어법·어휘 문항의 밑줄이 단어 중간에서 끊기는 것을 바로잡는다.
# 모델이 <u>learnin</u>g 처럼 마지막 글자를 밑줄 밖에 남기는 일이 실제로 발생했고,
# 그러면 학생이 "밑줄 친 부분"이 어디까지인지 헷갈린다. 문자 단위로 단어 경계까지
# 밑줄을 넓혀 항상 낱말 전체에 그어지도록 보정한다.
_WORD_CH = r"[A-Za-z0-9’'\-]"
_U_TAIL_RE = re.compile(r"</u>(" + _WORD_CH + r"+)")
_U_HEAD_RE = re.compile(r"(" + _WORD_CH + r"+)<u>")


def fix_underline_bounds(html):
    """<u>…</u>가 낱말을 잘라 먹었으면 낱말 전체를 감싸도록 넓힌다."""
    if not html or "<u>" not in html:
        return html
    html = _U_TAIL_RE.sub(r"\1</u>", html)  # </u> 뒤에 붙은 글자를 안으로
    html = _U_HEAD_RE.sub(r"<u>\1", html)   # <u> 앞에 붙은 글자를 안으로
    return html


def call_gemini_quiz(passage, types, count, api_key, model, short_hint=None):
    api_key = (api_key or "").strip() or os.environ.get("GEMINI_API_KEY", "").strip()
    if not api_key:
        raise RuntimeError(
            "Gemini API 키가 없습니다. 화면 상단의 'API 키' 칸에 키를 입력하거나 "
            "환경변수 GEMINI_API_KEY 를 설정하세요."
        )
    model = model if (model and _MODEL_RE.match(model)) else MODEL
    types = [t for t in (types or []) if t in QUIZ_TYPE_LABELS] or ["주제", "제목", "요지"]
    count = max(1, min(int(count or 5), 30))

    payload = {
        "systemInstruction": {"parts": [{"text": QUIZ_SYSTEM_PROMPT}]},
        "contents": [
            {"role": "user", "parts": [{"text": build_quiz_user_prompt(passage, types, count, short_hint)}]}
        ],
        "generationConfig": {
            "temperature": 0.4,
            # 문항마다 지문이 통째로 들어가므로 문항 수가 많으면 출력이 커진다 → 넉넉히
            "maxOutputTokens": 65536,
            "responseMimeType": "application/json",
            "responseSchema": QUIZ_SCHEMA,
        },
    }
    data = json.dumps(payload).encode("utf-8")
    body = _gemini_call_with_retry(data, api_key, model)
    result = _extract_gemini_json(body, _QUIZ_TRUNC_MSG)

    for q in result.get("questions", []):
        if not isinstance(q, dict):
            continue
        for f in ("passageHtml", "instruction", "explanation", "answerText"):
            if q.get(f):
                q[f] = sanitize_quiz_html(q[f])
        # 어법·어휘의 밑줄이 낱말을 자르고 끝나면 낱말 전체로 넓힌다
        if q.get("passageHtml"):
            q["passageHtml"] = fix_underline_bounds(q["passageHtml"])
        choices = q.get("choices")
        if isinstance(choices, list):
            q["choices"] = [sanitize_quiz_html(c) if isinstance(c, str) else c for c in choices]
        items = q.get("tfItems")
        if isinstance(items, list):
            for it in items:
                if isinstance(it, dict) and it.get("text"):
                    it["text"] = sanitize_quiz_html(it["text"])
        fixes = q.get("fixes")
        if isinstance(fixes, list):
            for fx in fixes:
                if not isinstance(fx, dict):
                    continue
                for k in ("wrong", "right"):
                    if fx.get(k):
                        fx[k] = sanitize_quiz_html(fx[k])
    return result


# ── 워크북(10단계 통합 학습지) 스키마 ──
# 한 번의 호출로 10단계 전부를 만들 수 있는 재료를 받아, 서버/클라이언트가 단계별로 조립한다.
WORKBOOK_SCHEMA = {
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
                    "heading": {"type": "STRING"},
                    "en": {"type": "STRING"},
                    "ko": {"type": "STRING"},
                    "enBlank": {"type": "STRING"},
                    "verbForm": {"type": "STRING"},
                    "grammarChoice": {"type": "STRING"},
                    "writeKeys": {"type": "ARRAY", "items": {"type": "STRING"}},
                },
                "required": ["no", "heading", "en", "ko", "enBlank",
                             "verbForm", "grammarChoice", "writeKeys"],
                "propertyOrdering": ["no", "heading", "en", "ko", "enBlank",
                                     "verbForm", "grammarChoice", "writeKeys"],
            },
        },
        "oddParagraphs": {
            "type": "ARRAY",
            "items": {
                "type": "OBJECT",
                "properties": {
                    "no": {"type": "INTEGER"},
                    "heading": {"type": "STRING"},
                    "text": {"type": "STRING"},
                    "fixes": {
                        "type": "ARRAY",
                        "items": {
                            "type": "OBJECT",
                            "properties": {
                                "wrong": {"type": "STRING"},
                                "right": {"type": "STRING"},
                            },
                            "required": ["wrong", "right"],
                            "propertyOrdering": ["wrong", "right"],
                        },
                    },
                },
                "required": ["no", "heading", "text", "fixes"],
                "propertyOrdering": ["no", "heading", "text", "fixes"],
            },
        },
    },
    "required": ["englishTitle", "koreanTitle", "sentences", "oddParagraphs"],
    "propertyOrdering": ["englishTitle", "koreanTitle", "sentences", "oddParagraphs"],
}

WORKBOOK_SYSTEM_PROMPT = r"""You are an expert Korean high-school English teacher who builds
'10단계 워크북' (10-stage workbook) worksheets from a textbook passage — the kind Korean
schools use for 내신 대비. Return ONLY the structured JSON described by the schema.

You will receive ONE English passage. Split it into sentences and, for EACH sentence, provide
the raw materials the workbook stages need. The app assembles the printable stages from your
data, so accuracy of the MARKUP FORMAT below is critical.

## sentences[] — one entry per sentence of the passage
- `no`: 1, 2, 3 … with no gaps, in original order. EVERY sentence of the passage must appear
  EXACTLY ONCE. Never stop partway — completeness is mandatory.
- `heading`: if a section heading/subtitle appears in the passage immediately BEFORE this
  sentence (e.g. "Discover Yourself"), put it here. Otherwise "".
- `en`: the sentence's original English, verbatim, plain text (no markup at all).
- `ko`: a natural, complete Korean translation of that sentence (존댓말 문어체, 교과서 지도서 톤).

### `enBlank` — 워크북3 재료 (해석 보고 영어 빈칸 채우기)
Copy `en` exactly, but wrap 1~4 KEY English words/phrases in {{ }}.
Choose words worth memorizing (핵심 어휘·숙어), keeping the sentence solvable from `ko`.
Example: "Many students are either {{unsure of}} what they know or {{confused}} about ..."

### `verbForm` — 워크북5 재료 (동사형 고쳐 쓰기)
Copy `en`, but replace each notable VERB (and only verbs/verbals) with (기본형|정답):
  · left of `|` = the plain base form shown to the student in parentheses
  · right of `|` = the correct inflected form that belongs there
Cover tense/agreement/passive/to-infinitive/gerund/participle. 2~5 per sentence.
Example: "It (be|is) hard (climb|to climb) a mountain, and (design|designing) a path (require|requires) it."

### `grammarChoice` — 워크북6 재료 (어법 선택형)
Copy `en`, but replace 2~4 grammar points with [정답|오답]:
  · left of `|` = the CORRECT form (as it appears in the passage)
  · right of `|` = a plausible WRONG alternative testing a real grammar point
    (수일치, 태, 준동사, 관계사, 대명사, 병렬 등). The app shuffles the display order.
Example: "Begin your map by [taking|take] a paper and [drawing|draw] some dots on [it|them]."

### `writeKeys` — 워크북9 재료 (영작 키워드)
3~8 short English keywords (base forms) that guide writing this sentence, in the order they
appear. Example: ["either", "unsure", "what", "confuse", "how", "find", "career"]

## oddParagraphs[] — 워크북7 재료 (문맥상 어색한 곳 찾기)
Group the passage into 2~5 paragraphs (follow the passage's own paragraph/heading structure).
For EACH paragraph:
- `no`: 1, 2, 3 …
- `heading`: the section heading if the paragraph starts one, else "".
- `text`: the paragraph's full English text, BUT with exactly 2~3 words replaced by a
  CONTEXTUALLY WRONG word (usually a near-antonym) so students must spot them.
  Keep everything else identical to the passage.
- `fixes`: one {wrong, right} per replaced word — `wrong` = the word you put in `text`,
  `right` = the original correct word. `wrong` MUST appear verbatim in `text`.
Example: original "are either unsure of" → text has "are either sure of",
         fixes: [{"wrong": "sure", "right": "unsure"}]

## HARD RULES (most common failures — check before returning)
1. `en` must be the passage's sentence VERBATIM. Never paraphrase or drop words.
2. `enBlank`/`verbForm`/`grammarChoice` must each equal `en` except for their own markup.
   Do not rewrite or paraphrase the sentence.
3. Use ONLY these markers: {{answer}}, (base|answer), [correct|wrong]. No other symbols,
   no HTML, no numbering inside the text.
4. `|` separates two parts — never use `|` for anything else.
5. Every sentence of the passage appears exactly once, in order.

Return valid JSON only. No markdown fences, no prose."""


_WORKBOOK_TRUNC_MSG = (
    "출력이 최대 길이에 도달해 워크북 생성이 잘렸습니다. 지문이 너무 깁니다. "
    "지문을 두세 문단으로 나눠 각각 따로 만드세요."
)


def build_workbook_user_prompt(passage, complete_hint=None):
    lines = []
    if complete_hint is not None:
        expected, got = complete_hint
        lines.append(
            f"⚠️ 이전 시도는 {got}문장만 만들었으나 이 지문은 약 {expected}문장입니다. "
            f"이번에는 지문의 모든 문장을 1번부터 끝까지 빠짐없이 포함하세요."
        )
        lines.append("")
    lines.append("[지문]")
    lines.append(passage.strip())
    return "\n".join(lines)


def call_gemini_workbook(passage, api_key, model, complete_hint=None):
    api_key = (api_key or "").strip() or os.environ.get("GEMINI_API_KEY", "").strip()
    if not api_key:
        raise RuntimeError(
            "Gemini API 키가 없습니다. 화면 상단의 'API 키' 칸에 키를 입력하거나 "
            "환경변수 GEMINI_API_KEY 를 설정하세요."
        )
    model = model if (model and _MODEL_RE.match(model)) else MODEL

    payload = {
        "systemInstruction": {"parts": [{"text": WORKBOOK_SYSTEM_PROMPT}]},
        "contents": [
            {"role": "user", "parts": [{"text": build_workbook_user_prompt(passage, complete_hint)}]}
        ],
        "generationConfig": {
            "temperature": 0.25,
            "maxOutputTokens": 65536,
            "responseMimeType": "application/json",
            "responseSchema": WORKBOOK_SCHEMA,
        },
    }
    data = json.dumps(payload).encode("utf-8")
    body = _gemini_call_with_retry(data, api_key, model)
    return _extract_gemini_json(body, _WORKBOOK_TRUNC_MSG)


SYSTEM_PROMPT = r"""You are an expert Korean high-school English teacher who produces
'청크 단위 직독직해' (chunk-by-chunk literal translation) analysis sheets for exam
passages (수능·모의고사·내신).

You will receive one English passage. Analyze it and return ONLY the structured JSON
described by the schema. Follow these rules exactly.

## Sentence splitting (STRICT RULES)
- ⚠️ COMPLETENESS IS MANDATORY: the `sentences` array MUST contain ONE entry for EVERY
  sentence in the passage — from the first to the very last. Analyze the WHOLE passage,
  never stop partway. The number of `sentences` entries MUST equal the number of sentences
  you refer to in `summary` (e.g. if summary mentions ❶~❻, there must be 6 sentence entries).
  Analyzing fewer sentences than you summarize is a serious error.
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
- `isTopic` (boolean): set true for EXACTLY ONE sentence — the passage's topic/thesis
  sentence that best states the main idea (핵심 주장/요지). Set false for all others. If the
  main idea is only implied and no single sentence states it, set false for every sentence
  (do NOT force a topic). Never mark more than one sentence true.
- `examTags` (array of short Korean strings): label this sentence with the Korean
  high-school exam (내신·모의고사) question types it is a STRONG candidate for. Use ONLY the
  labels below, 0~2 per sentence — most sentences should be an empty array []. Quality over
  quantity; do NOT tag every sentence.
    * "요지"     — 글의 요지가 압축된 문장
    * "빈칸"     — 핵심 추상 개념이라 빈칸추론으로 낼 만한 문장
    * "문장삽입" — 연결어·지시어·대명사로 앞뒤와 강하게 연결돼 문장삽입/순서 문제로 낼 만한 문장
    * "순서"     — 글의 순서를 가르는 단서(지시어·연결어)가 뚜렷한 문장
    * "함축"     — 비유·함축 표현이 있어 밑줄 함축의미로 낼 만한 문장
    * "어법"     — 어법(문법) 문제로 자주 출제되는 포인트가 있는 문장
    * "어휘"     — 문맥상 어휘 문제로 낼 만한 핵심 어휘가 있는 문장
    * "제목단서" — 제목 추론의 핵심 단서 문장
  Do NOT put "주제문" in examTags (that is the isTopic flag).
- `examNote` (string): IF this sentence isTopic OR has any examTags, write a concise Korean
  explanation (1문장, 문어체) of WHY it is a good candidate for those question type(s) —
  e.g. "글 전체의 주장을 압축한 문장이라 요지·주제 문제의 정답 근거가 된다", "앞 문장의
  결과를 지시어 'this'로 받아 순서·문장삽입 단서가 뚜렷하다", "핵심 개념이 추상적으로
  제시돼 빈칸으로 만들기 좋다". If the sentence has NO isTopic and NO examTags, set examNote
  to an empty string "".

## chunks — 청크(의미 단위) 배열: 각 청크마다 {text, kor, anns}
IMPORTANT: You do NOT write ANY HTML for the English. The server paints the colors from your
plain English (`text`) + an annotation list (`anns`). This makes it IMPOSSIBLE to lose English
words. So for English your only job is: give the plain text, then list what to mark.

- Break the sentence into meaning units (chunks: phrases/clauses), IN ORDER, in `chunks`.
  Chunk size = a natural phrase/clause (주어부, 동사구, 전치사구, 관계절, 부사절 등); not a
  single article, not a whole long sentence.
- For EACH chunk provide {text, kor, anns}:
  * `text` = the chunk's ORIGINAL ENGLISH words, PLAIN — verbatim, in order, NO markup at all.
    Every English word of the passage MUST appear across the chunks' `text`. Drop nothing.
  * `kor` = the PLAIN Korean 직독직해 of THAT chunk only (no markup).
  * `anns` = list of things to mark INSIDE this chunk's `text`. Each item = {t, role, rt, num}:
      · `t`    = the EXACT substring of `text` to mark (copy it verbatim, letter for letter).
      · `role` = one of:
            "g"    어법(빨강)          "v"  어휘(파랑)        "gv" 어법+어휘(보라)
            "hl"   강조·연결어(노랑)    "tg" 목표 어법(주황, 목표 어법이 지정된 경우만)
            "conj" 등위·상관접속사(하늘 형광)   "num" 색 없이 병렬 번호만
      · `rt`   = short Korean explanation shown above the word (for "conj"/"num" use "").
      · `num`  = 0 normally. For parallel numbering use 1,2,3… (adds a small superscript number).
    If nothing to mark, `anns` = [].

### COLOR DECISION RULE (role 고르기 — 기계적으로 적용, 가장 실수 잦은 곳)
  ▸ SINGLE word 한 단어:
      · 문법 포인트(관계사·접속사·조동사·전치사, 시제/태/준동사 형태: were cultivated, to grow) → "g".
        rt = 문법 기능만. 예: that→"명사절 접속사".
      · 내용어(명사·동사·형용사·부사)의 뜻이 포인트 → "v". rt = 짧은 뜻. 예: cultivate→"재배하다".
      · 한 단어는 절대 "gv"(보라) 금지.
  ▸ 2단어 이상 고정표현(숙어·구동사·전치사구 관용구·상관표현: regardless of, in order to,
    be likely to, so ~ that …) → "gv". rt = 문법 기능만(뜻 금지). 예: regardless of→"전치사구".
  ▸ 연결어(However, Therefore, In addition …) → "hl". rt = 역접/대조/첨가 등 기능.
  ▸ 목표 어법이 지정되면 그 구조만 "tg"(주황), 나머지 어법은 "g".
  HARD LIMITS: "g" rt=문법용어만(뜻 0%) / "v" rt=뜻만 / "gv"=2단어 이상만 / rt는 해석 아님·아주 짧게.
  WRONG rt <재배하다(과거 수동태)>  →  RIGHT rt <과거 수동태>.

### 등위·상관접속사 병렬 (MANDATORY — 절대 빠뜨리지 말 것)
Scan every "and / or / but / nor / yet" (and correlatives both…and / either…or /
not only…but also / neither…nor / not…but) that joins parallel elements. For EACH:
  · add an ann for the conjunction: {t:"and", role:"conj", rt:"", num:0}
  · add an ann for EACH parallel element with num = 1, 2, 3…: e.g.
      {t:"influence", role:"num", rt:"", num:1}, {t:"invest", role:"num", rt:"", num:2}
    (use role "g"/"v"/"gv" instead of "num" if that element also deserves color.)
Never skip one, not even a simple "and" joining two nouns.

### GRAMMAR COVERAGE (role "g") — do NOT omit
Find and mark ALL notable grammar structures with a "g" ann. Scan for every occurrence of:
  - 시제·상·태: 수동태(be+p.p.), 완료(have+p.p.), 진행(be+~ing) 등
  - 준동사: to부정사(명사적/형용사적/부사적), 동명사, 분사, 분사구문
  - 관계사: who/whom/whose/which/that, where/when/why/how(관계부사), 계속적 용법
  - 접속사: that(명사절), whether/if(명사절), 부사절(although/because/while/if/unless/so that…)
  - 특수구문: 가정법, 도치, it~that 강조, 가주어/진주어, 부분/전체 부정, 비교급·최상급, 생략
  - 목적격보어(원형/현재분사/과거분사), 사역·지각동사
분명한 문법 포인트는 빠뜨리지 말고 표시하라. 매칭할 `t`는 반드시 `text` 안의 실제 문자열이어야 한다.

### FINAL SELF-CHECK (mandatory, before returning)
1. ENGLISH: mentally read all chunks' `text` in order — they MUST reconstruct the WHOLE
   passage with no words missing.
2. `t` 정확성: every ann's `t` must be an exact substring of its chunk's `text` (아니면 무시됨).
3. COVERAGE: every grammar point in the coverage list has a "g" ann.
4. 등위접속사 SWEEP: every parallel and/or/but/nor/yet has a "conj" ann + numbered elements.
Only return JSON after all four checks.

## note — per-sentence commentary
- One or two sentences of objective, written-style Korean explaining the main grammar
  point(s) and key vocabulary in this sentence.
- Wrap every English word/expression in a <code> tag COLOR-CODED by role, matching the same
  word's color in the left column (the reader connects them):
  * grammar point:     <code class="g">that</code>          (red)
  * vocabulary:        <code class="v">derogatory</code>    (blue)
  * grammar + vocab:   <code class="gv">regardless of</code>(purple)
  * 목표 어법:         <code class="tg">to find</code>       (orange)
  Choose the class consistently with the role you gave that word in `anns`.
- The `note` may use <code> only. NEVER put <ruby>, <rt>, or over-tag markup in `note`.

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
        code_cls = cls if cls in ("g", "v", "gv", "tg") else ""
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
_SPAN_ROLE_RE = re.compile(r'<span class="\s*(gv|hl|tg|g|v)\b[^"]*"')
_RUBY_MOD = {"g": "over-tag", "v": "over-tag vocab-rt",
             "gv": "over-tag theme-rt", "hl": "over-tag hl-rt",
             "tg": "over-tag target-rt"}


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


_SENT_END_RE = re.compile(r'[.!?]+(?=\s+["\'(\[]?[A-Z]|\s*$)')


def rough_sentence_count(passage):
    """지문의 문장 수 대략 추정 (약어로 다소 부풀 수 있어 넉넉한 허용오차와 함께 사용)."""
    text = re.sub(r"\d\.\d", "00", passage.strip())  # 소수점 보호
    n = len(_SENT_END_RE.findall(text))
    return max(n, 1)


_RT_STRIP_RE = re.compile(r"<rt\b[^>]*>.*?</rt>", re.S)
_TAG_STRIP_RE = re.compile(r"<[^>]+>")


def _english_letters(html):
    """chunk eng 에서 주석(rt)·태그를 걷어내고 남는 '영어 알파벳' 글자 수."""
    t = _RT_STRIP_RE.sub("", html or "")   # 루비 주석(한글) 제거
    t = _TAG_STRIP_RE.sub("", t)           # 나머지 태그 제거
    return sum(1 for ch in t if ("a" <= ch <= "z") or ("A" <= ch <= "Z"))


def _ascii_count(s):
    return sum(1 for ch in (s or "") if ("a" <= ch <= "z") or ("A" <= ch <= "Z"))


def _esc_html(s):
    return (s or "").replace("&", "&amp;").replace("<", "&lt;").replace(">", "&gt;")


_ROLE_RUBY = {
    "g": "over-tag", "v": "over-tag vocab-rt", "gv": "over-tag theme-rt",
    "hl": "over-tag hl-rt", "tg": "over-tag target-rt",
}


def _wrap_ann(word, a):
    """평문 영어 조각 word 에 역할(role)에 맞는 루비/색상/병렬번호를 입힌다."""
    role = (a.get("role") or "g").strip()
    rt = _esc_html((a.get("rt") or "").strip())
    w = _esc_html(word)
    num = a.get("num")
    numhtml = ""
    if isinstance(num, (int, float)) and int(num) > 0:
        numhtml = f'<sup class="conj-num-top">{int(num)}</sup>'
    if role == "conj":
        return numhtml + f'<span class="conj-hl">{w}</span>'
    if role in _ROLE_RUBY:
        return (numhtml + f'<ruby class="{_ROLE_RUBY[role]}">'
                f'<span class="{role}">{w}</span><rt>{rt}</rt></ruby>')
    return numhtml + w  # role "num" 등: 번호만, 색 없음


def assemble_eng(text, anns):
    """모델이 준 평문 영어(text) 위에, 주석 목록(anns)의 대상 문자열을 찾아
    색상/루비/병렬번호를 겹쳐 최종 영어 HTML을 만든다. 매칭 안 되는 주석은 무시하되
    영어 원문은 항상 그대로 보존된다."""
    text = text or ""
    if not text:
        return ""
    used = [False] * len(text)
    spans = []
    for a in anns or []:
        if not isinstance(a, dict):
            continue
        t = a.get("t") or ""
        if not t:
            continue
        idx = text.find(t)
        while idx != -1 and any(used[idx:idx + len(t)]):
            idx = text.find(t, idx + 1)
        if idx == -1:
            continue
        for i in range(idx, idx + len(t)):
            used[i] = True
        spans.append((idx, idx + len(t), a))
    spans.sort()
    out = []
    pos = 0
    for st, en, a in spans:
        out.append(_esc_html(text[pos:st]))
        out.append(_wrap_ann(text[st:en], a))
        pos = en
    out.append(_esc_html(text[pos:]))
    return "".join(out)


def english_incomplete(result, passage):
    """영어 원문 누락 감지: 한글은 있는데 영어가 빈 chunk가 있거나,
    전체 영어량이 원문의 60% 미만이면 True (재요청 필요)."""
    src = sum(1 for ch in passage if ("a" <= ch <= "z") or ("A" <= ch <= "Z"))
    if src < 30:
        return False
    got = 0
    dropped = False
    for s in result.get("sentences", []):
        for c in s.get("chunks", []):
            if not isinstance(c, dict):
                continue
            en = _english_letters(c.get("eng", ""))
            got += en
            if en == 0 and (c.get("kor", "") or "").strip():
                dropped = True  # 한글은 있는데 영어가 사라진 chunk
    return dropped or got < src * 0.6


def build_user_prompt(passage, target_grammar, mode, prior=None, complete_hint=None, english_fix=False):
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
    if complete_hint is not None:
        expected, got = complete_hint
        lines.append(
            f"⚠️ 이전 시도는 문장 분석을 {got}개만 만들었으나, 이 지문은 약 {expected}문장입니다. "
            f"이번에는 지문의 '모든' 문장을 1번부터 끝까지 `sentences` 배열에 반드시 포함하세요. "
            f"어떤 문장도 건너뛰지 말고, 요약에서 언급한 문장 수와 분석한 문장 수가 같아야 합니다."
        )
    if english_fix:
        lines.append(
            "⚠️ 이전 시도에서 일부 chunk의 평문 영어(`text`)가 비어 있거나 누락됐습니다. "
            "모든 chunk의 `text`에 지문의 영어 단어가 그대로(원문대로·순서대로) 들어가야 하며, "
            "전체를 이으면 지문 전체 영어가 빠짐없이 복원되어야 합니다. 빠짐없이 다시 출력하세요."
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


def _gemini_call_with_retry(data, api_key, model):
    """페이로드(JSON bytes)를 모델에 전송하고 재시도·모델 대체를 공통 처리한다
    (지문분석·문제제작 등 모든 Gemini 호출이 공유).
    - flash 429(속도 제한), 5xx(서버 과부하), 네트워크 오류 → 대기 후 자동 재시도
      (누적 대기가 MAX_RETRY_TOTAL을 넘으면 포기하고 명확한 한국어 오류로 안내)
    - 모델이 사라졌거나(400/404) 비-flash 429(할당량 0) → 사용 가능한 flash 모델로 자동 대체
    성공 시 Gemini 응답 바디(dict)를 반환한다."""

    def _post(use_model):
        req = urllib.request.Request(
            GEMINI_URL.format(model=use_model),
            data=data,
            method="POST",
            headers={"content-type": "application/json", "x-goog-api-key": api_key},
        )
        with urllib.request.urlopen(req, timeout=GEMINI_TIMEOUT) as resp:
            return json.loads(resp.read().decode("utf-8"))

    def _generate(use_model):
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
        return _generate(model)
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
                return _generate(alt)  # Flash로 재시도
            except urllib.error.HTTPError as e2:
                raise RuntimeError(f"Gemini API 오류 {e2.code}: {_err_msg(e2)}")
        elif e.code in (400, 403) and "API" in msg.upper():
            raise RuntimeError(f"API 키 오류로 보입니다 ({e.code}): {msg}")
        else:
            raise RuntimeError(f"Gemini API 오류 {e.code}: {msg}")
    except urllib.error.URLError as e:
        raise RuntimeError(f"네트워크 오류: {e.reason}")


def _extract_gemini_json(body, trunc_msg):
    """Gemini 응답 바디에서 텍스트를 뽑아 JSON으로 파싱한다.
    안전필터·빈응답·MAX_TOKENS 잘림 등은 한국어 RuntimeError로 변환한다."""
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

    text = ""
    for part in cand.get("content", {}).get("parts", []):
        if "text" in part:
            text += part["text"]
    if not text:
        if finish == "MAX_TOKENS":
            raise RuntimeError(trunc_msg)
        raise RuntimeError(
            "모델 응답이 비어 있습니다. 출력이 잘렸을 수 있으니 더 짧은 지문으로 시도하세요."
        )
    try:
        result = json.loads(text)
    except json.JSONDecodeError:
        if finish == "MAX_TOKENS":
            raise RuntimeError(trunc_msg)
        raise RuntimeError("모델 응답을 JSON으로 해석하지 못했습니다.")
    if finish == "MAX_TOKENS":
        raise RuntimeError(trunc_msg)
    return result


_ANALYZE_TRUNC_MSG = (
    "출력이 최대 길이에 도달해 분석이 잘렸습니다. 이 지문이 너무 길어서 그렇습니다. "
    "지문을 두세 문단으로 나눠 각각 따로 분석하세요."
)


def call_gemini(passage, target_grammar, mode, api_key, model, prior=None, complete_hint=None, english_fix=False):
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
                "parts": [{"text": build_user_prompt(passage, target_grammar, mode, prior, complete_hint, english_fix)}],
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
    body = _gemini_call_with_retry(data, api_key, model)
    result = _extract_gemini_json(body, _ANALYZE_TRUNC_MSG)
    # AI 마크업 정화 + 한국어 루비 제거 (레이아웃 붕괴/오류 방어)
    for s in result.get("sentences", []):
        if not isinstance(s, dict):
            continue
        for c in s.get("chunks", []):
            if not isinstance(c, dict):
                continue
            # 서버가 평문 영어(text) 위에 주석 목록(anns)을 겹쳐 최종 영어를 조립한다.
            # → 영어 원문은 항상 보존되고, 매칭 안 되는 주석만 무시된다.
            plain = _TAG_STRIP_RE.sub("", c.get("text", "") or "").strip()
            c["eng"] = assemble_eng(plain, c.get("anns", []))
            c.pop("text", None)
            c.pop("anns", None)
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
        # 별칭(-latest)·프리뷰·실험 버전 제외 — 별칭은 실제 모델과 할당량을 공유해
        # 사용량 집계만 흐리고, 프리뷰/실험판은 품질이 들쭉날쭉하다.
        if mid.endswith("-latest") or "preview" in low or "-exp" in low:
            continue
        # 구버전 제외 — 현재 주력인 3.5 이상만 노출 (새 버전이 나오면 자동 포함)
        vm = re.search(r"gemini-(\d+(?:\.\d+)?)", low)
        if not vm or float(vm.group(1)) < 3.5:
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
        if path not in ("/api/analyze", "/api/models", "/api/quiz", "/api/workbook"):
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

        if path == "/api/workbook":
            passage = (req.get("passage") or "").strip()
            if len(passage) < 20:
                self._send_json({"error": "워크북을 만들 영어 지문을 입력하세요 (20자 이상)."}, 400)
                return
            api_key = req.get("apiKey") or ""
            model = req.get("model") or MODEL
            t0 = time.monotonic()
            try:
                result = call_gemini_workbook(passage, api_key, model)
                # 문장 누락 방어 — 실제 문장 수보다 많이 부족하면 자동 보정 재요청
                expected = rough_sentence_count(passage)
                for _ in range(2):
                    got = len(result.get("sentences", []))
                    if got >= expected - 2:
                        break
                    if _over_budget(t0):  # 프록시가 끊기 전에 현재 결과라도 돌려준다
                        break
                    result = call_gemini_workbook(
                        passage, api_key, model, complete_hint=(expected, got)
                    )
            except Exception as e:
                self._send_json({"error": str(e)}, 502)
                return
            self._send_json(result)
            return

        if path == "/api/quiz":
            passage = (req.get("passage") or "").strip()
            if len(passage) < 20:
                self._send_json({"error": "문제를 만들 영어 지문을 입력하세요 (20자 이상)."}, 400)
                return
            types = req.get("types") or []
            count = req.get("count") or 5
            api_key = req.get("apiKey") or ""
            model = req.get("model") or MODEL
            t0 = time.monotonic()
            try:
                result = call_gemini_quiz(passage, types, count, api_key, model)
                # 문항 누락 방어 — 요청한 개수보다 적게 오면 한 번 더 요청해 채운다
                want = max(1, min(int(count or 5), 30))
                for _ in range(2):
                    got = len(result.get("questions", []))
                    if got >= want:
                        break
                    if _over_budget(t0):  # 프록시가 끊기 전에 현재 결과라도 돌려준다
                        break
                    retry = call_gemini_quiz(
                        passage, types, count, api_key, model, short_hint=got
                    )
                    # 더 많이 만들어 온 결과만 채택 (재시도가 더 나쁘면 기존 유지)
                    if len(retry.get("questions", [])) > got:
                        result = retry
            except Exception as e:
                self._send_json({"error": str(e)}, 502)
                return
            self._send_json(result)
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

        t0 = time.monotonic()
        try:
            result = call_gemini(passage, target_grammar, mode, api_key, model)
            # 문장 누락 방어 — 실제 문장 수보다 분석이 많이 부족하면 자동 보정 재요청
            expected = rough_sentence_count(passage)
            for _ in range(2):
                got = len(result.get("sentences", []))
                if got >= expected - 2:  # 약어로 인한 과다추정 대비 허용오차
                    break
                if _over_budget(t0):  # 프록시가 끊기 전에 현재 결과라도 돌려준다
                    break
                result = call_gemini(
                    passage, target_grammar, mode, api_key, model,
                    complete_hint=(expected, got),
                )
            # 영어 원문 누락 방어 — 영어가 빠진 chunk가 있으면 자동으로 다시 요청
            for _ in range(2):
                if not english_incomplete(result, passage):
                    break
                if _over_budget(t0):
                    break
                result = call_gemini(
                    passage, target_grammar, mode, api_key, model, english_fix=True
                )
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
