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
                    "englishHtml": {"type": "STRING"},
                    "koreanHtml": {"type": "STRING"},
                    "note": {"type": "STRING"},
                },
                "required": ["no", "tag", "englishHtml", "koreanHtml", "note"],
                "propertyOrdering": ["no", "tag", "englishHtml", "koreanHtml", "note"],
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

## Sentence splitting
- Split the passage into sentences and number them from 1 (the JSON `no` field).
- `tag` = a very short Korean label for the sentence's role in the flow
  (e.g. "도입·주제 제시", "근거", "부연", "결론·대조"). Keep under ~10 chars.

## englishHtml — chunked English line with ruby annotations
- Break the sentence into meaning units (chunks: phrases/clauses) and join them with
  a slash separator element: <span class="sep">/</span>
- Wrap each chunk's words as plain text; DO NOT wrap whole chunks in extra spans.
- Annotate key grammar and vocabulary with ruby tags placed OVER the word. The `rt`
  text is an EXPLANATION, not a translation — see the strict rule below.
  * Grammar (red) — rt = 문법 용어/기능 (grammatical term or function), NOT the meaning:
        <ruby class="over-tag"><span class="g">that</span><rt>명사절 접속사</rt></ruby>
        <ruby class="over-tag"><span class="g">were cultivated</span><rt>과거 수동태</rt></ruby>
        <ruby class="over-tag"><span class="g">to grow</span><rt>부사적 용법(목적)</rt></ruby>
  * Vocabulary (blue) — rt = 그 단어/숙어의 짧은 어휘 뜻 (one-word dictionary gloss):
        <ruby class="over-tag vocab-rt"><span class="v">cultivate</span><rt>재배하다</rt></ruby>
  * Grammar+vocab (purple) — rt = 문법 설명 (문법 기능 위주):
        <ruby class="over-tag theme-rt"><span class="gv">regardless of</span><rt>전치사구(~와 상관없이)</rt></ruby>
  * Emphasis / connective (yellow highlight) — rt = 연결어의 기능/역할 (역접·대조·첨가 등):
        <ruby class="over-tag hl-rt"><span class="hl">However</span><rt>역접(그러나)</rt></ruby>
- Parallel structure joined by and/or: mark the conjunction as
  <span class="conj-hl">and</span> and put a superscript number before each parallel
  element: <sup class="conj-num-top">1</sup>WORD ... <sup class="conj-num-top">2</sup>WORD
- CRITICAL — rt content rule: the `rt` annotation must be a GRAMMAR term/function for
  grammar tags (e.g. 관계대명사, 분사구문, 동명사, 가주어-진주어, 목적격보어(원형부정사),
  분사구문, 도치, 강조구문). For vocabulary tags it is a SHORT single-word 어휘 뜻. It must
  NEVER be a phrase- or sentence-level translation. The full Korean translation lives ONLY
  in koreanHtml — do NOT duplicate that translation inside any rt. Keep each rt very short.
- Keep the original English words and order intact; only add ruby/sep markup around them.
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

### FINAL SELF-CHECK (mandatory, before returning)
Re-read each sentence's englishHtml one more time. For every item in the coverage list
that appears in that sentence, confirm it has a RED grammar ruby. If any is missing, ADD
it now. Only return the JSON after this check — every sentence should have at least one
red grammar annotation (a sentence with none almost always means you missed something).

## koreanHtml — chunk-aligned Korean translation
- Translate the sentence chunk-by-chunk, using the SAME chunk boundaries as englishHtml,
  joined with <span class="sep">/</span>. Natural but faithful (직독직해) Korean.
- IMPORTANT: koreanHtml must be PLAIN Korean text with ONLY <span class="sep">/</span>
  separators. NEVER put <ruby>, <rt>, <code>, or any grammar/vocab color spans
  (class g/v/gv/hl/conj-hl) in koreanHtml. All annotations belong ONLY in englishHtml.

## note — per-sentence commentary
- One or two sentences of objective, written-style Korean explaining the main grammar
  point(s) and key vocabulary in this sentence.
- Wrap every English word/expression in a <code> tag that is COLOR-CODED by role, so it
  visually matches the same word's color in englishHtml (the reader connects them):
  * grammar point:     <code class="g">that</code>          (red)
  * vocabulary:        <code class="v">derogatory</code>    (blue)
  * grammar + vocab:   <code class="gv">regardless of</code>(purple)
  Choose the class consistently with how you annotated that word on the left side.

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


def build_user_prompt(passage, target_grammar, mode):
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
    return "\n".join(lines)


def call_gemini(passage, target_grammar, mode, api_key, model):
    api_key = (api_key or "").strip() or os.environ.get("GEMINI_API_KEY", "").strip()
    if not api_key:
        raise RuntimeError(
            "Gemini API 키가 없습니다. 화면 상단의 'API 키' 칸에 키를 입력하거나 "
            "환경변수 GEMINI_API_KEY 를 설정하세요."
        )
    model = model if (model and _MODEL_RE.match(model)) else MODEL

    payload = {
        "systemInstruction": {"parts": [{"text": SYSTEM_PROMPT}]},
        "contents": [
            {
                "role": "user",
                "parts": [{"text": build_user_prompt(passage, target_grammar, mode)}],
            }
        ],
        "generationConfig": {
            "temperature": 0.2,
            "maxOutputTokens": 16384,
            "responseMimeType": "application/json",
            "responseSchema": GEMINI_SCHEMA,
        },
    }
    data = json.dumps(payload).encode("utf-8")

    def _generate(use_model):
        req = urllib.request.Request(
            GEMINI_URL.format(model=use_model),
            data=data,
            method="POST",
            headers={"content-type": "application/json", "x-goog-api-key": api_key},
        )
        with urllib.request.urlopen(req, timeout=300) as resp:
            return json.loads(resp.read().decode("utf-8"))

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
        if model_gone:
            # 지원 중단/없는 모델 → 이 키로 가능한 모델(Flash 우선)로 자동 대체 후 1회 재시도
            try:
                avail = list_models(api_key)["models"]
            except Exception:
                avail = []
            alt = next(
                (m["id"] for m in avail if "flash" in m["id"].lower() and m["id"] != model),
                None,
            ) or (avail[0]["id"] if avail else None)
            if not alt:
                raise RuntimeError(
                    "선택한 모델을 사용할 수 없고, 대체할 모델도 찾지 못했습니다. "
                    "정확도(모델) 목록에서 다른 모델을 골라 다시 시도하세요."
                )
            try:
                body = _generate(alt)
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
    if cand.get("finishReason") in ("SAFETY", "RECITATION", "PROHIBITED_CONTENT"):
        raise RuntimeError(f"응답이 필터링되었습니다: {cand.get('finishReason')}")

    text = ""
    for part in cand.get("content", {}).get("parts", []):
        if "text" in part:
            text += part["text"]
    if not text:
        raise RuntimeError(
            "모델 응답이 비어 있습니다. 출력이 잘렸을 수 있으니 더 짧은 지문으로 시도하세요."
        )
    try:
        result = json.loads(text)
    except json.JSONDecodeError:
        raise RuntimeError("모델 응답을 JSON으로 해석하지 못했습니다.")
    # 한국어 줄에 잘못 들어간 루비/주석 제거 (안전장치)
    for s in result.get("sentences", []):
        if isinstance(s, dict) and s.get("koreanHtml"):
            s["koreanHtml"] = clean_korean(s["koreanHtml"])
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
        models.append({"id": mid, "label": m.get("displayName", mid)})
    # 최신·상위 모델이 위로 오도록 정렬 (버전 숫자 내림차순 근사)
    models.sort(key=lambda x: x["id"], reverse=True)
    return {"models": models}


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

        try:
            result = call_gemini(passage, target_grammar, mode, api_key, model)
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
