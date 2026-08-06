#!/usr/bin/env python3
"""영어 지문 분석본 자동 생성 웹앱 (순수 표준 라이브러리, pip 설치 불필요).

지문을 받아 Google Gemini API로 '청크 단위 직독직해' 분석본 JSON을 생성하고,
정적 프런트엔드(public/)가 이를 좌우 7:3 카드 형식으로 렌더링한다.

Gemini API 키는 관리자(운영자)가 환경변수 GEMINI_API_KEY 하나로만 설정한다.
사용자는 개인 키를 입력하지 않고, 대신 로그인(구글 또는 이메일/비밀번호 회원가입)
해야 AI 기능을 쓸 수 있다 — 로그인은 '누가 관리자의 키를 쓰는지' 구분하는
용도이지, 사용자별 키를 받기 위한 것이 아니다.

실행:  python server.py       (기본 http://localhost:8000)
"""

import difflib
import hashlib
import json
import os
import re
import secrets
import smtplib
import socket
import ssl
import sys
import time
import traceback
import urllib.request
import urllib.error
import urllib.parse
from datetime import datetime, timedelta, timezone
from email.message import EmailMessage
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path

from google.cloud import firestore
from google.oauth2 import service_account

# 배포(Render 등)에서는 0.0.0.0 바인딩이 필요. 로컬에서도 localhost로 접속됨.
HOST = os.environ.get("HOST", "0.0.0.0")
PORT = int(os.environ.get("PORT", "8000"))
MODEL = os.environ.get("GEMINI_MODEL", "gemini-3.6-flash")
# 모델명은 URL 경로에 들어가므로 안전한 형식만 허용 (하드코딩 목록 대신 형식 검증)
_MODEL_RE = re.compile(r"^gemini-[A-Za-z0-9.\-]+$")
PUBLIC_DIR = Path(__file__).resolve().parent / "public"

# --- 로그인(구글 OAuth + 이메일/비밀번호) + Firestore -----------------------
GOOGLE_CLIENT_ID = os.environ.get("GOOGLE_CLIENT_ID", "")
SESSION_MAX_AGE = 60 * 60 * 24 * 30  # 세션 유지 기간(초) — 30일


def _load_firestore():
    """서비스 계정 키로 Firestore 클라이언트를 만든다. 로컬은 파일 경로
    (GOOGLE_APPLICATION_CREDENTIALS)를, Render 등 배포 환경은 JSON 내용을 통째로 담은
    환경변수(GOOGLE_APPLICATION_CREDENTIALS_JSON)를 지원한다 — 배포 환경엔 영구 디스크가
    없어 키 파일을 둘 곳이 없으므로 값 자체를 환경변수로 넣는 쪽이 더 간단하다.
    둘 다 없으면 None을 돌려준다 — 이제 로그인은 AI 기능(관리자 키 사용)의 전제
    조건이므로, Firestore가 없으면 로그인은 물론 분석·문제 제작도 함께 막힌다."""
    raw = os.environ.get("GOOGLE_APPLICATION_CREDENTIALS_JSON")
    if raw:
        info = json.loads(raw)
        creds = service_account.Credentials.from_service_account_info(info)
        return firestore.Client(credentials=creds, project=info.get("project_id"))
    if os.environ.get("GOOGLE_APPLICATION_CREDENTIALS"):
        return firestore.Client()
    return None


DB = _load_firestore()

# --- 이메일/비밀번호 회원가입 -----------------------------------------------
SMTP_HOST = os.environ.get("SMTP_HOST", "smtp.gmail.com")
SMTP_PORT = int(os.environ.get("SMTP_PORT", "465"))
SMTP_USER = os.environ.get("SMTP_USER", "")
SMTP_PASSWORD = os.environ.get("SMTP_PASSWORD", "")
VERIFY_CODE_TTL = 15 * 60    # 인증코드 유효 시간(초)
VERIFY_MAX_ATTEMPTS = 5      # 인증코드 오답 허용 횟수 — 넘으면 처음부터 다시 가입
SIGNUP_RESEND_COOLDOWN = 60  # 같은 이메일로 인증코드를 다시 보낼 수 있는 최소 간격(초)
_EMAIL_RE = re.compile(r"^[^@\s]+@[^@\s]+\.[^@\s]+$")


class _IPv4SMTP_SSL(smtplib.SMTP_SSL):
    """Render 등 일부 컨테이너 환경은 IPv6 주소만 갖고 실제 경로는 없어서,
    smtp.gmail.com이 IPv6로 먼저 풀리면 'Network is unreachable'로 실패한다.
    소켓 연결만 IPv4로 강제하고, TLS 인증서 검증은 원래 호스트명으로 그대로 한다."""

    def _get_socket(self, host, port, timeout):
        addrinfo = socket.getaddrinfo(host, port, socket.AF_INET, socket.SOCK_STREAM)
        ip = addrinfo[0][4][0]
        new_socket = socket.create_connection((ip, port), timeout, self.source_address)
        if self.timeout is not None and not self.timeout:
            new_socket.setblocking(True)
        return self.context.wrap_socket(new_socket, server_hostname=self._host)


def _gen_verify_code():
    return "".join(secrets.choice("0123456789") for _ in range(6))


def send_verification_email(to_email, code):
    """인증코드를 메일로 보낸다. SMTP 설정이 없으면(로컬 개발 등) 메일 대신
    서버 로그에 코드를 남기고 넘어간다 — 관리자가 콘솔에서 코드를 보고 직접
    전달할 수 있고, 실제 메일 없이도 회원가입 흐름을 테스트할 수 있다."""
    if not SMTP_USER or not SMTP_PASSWORD:
        print(f"[signup] SMTP 설정이 없어 메일을 보내지 못했습니다. "
              f"{to_email} 인증코드: {code}", file=sys.stderr)
        return
    msg = EmailMessage()
    msg["Subject"] = "[English Lab] 이메일 인증코드"
    msg["From"] = SMTP_USER
    msg["To"] = to_email
    msg.set_content(
        f"English Lab 회원가입 인증코드는 {code} 입니다.\n"
        f"{VERIFY_CODE_TTL // 60}분 안에 입력해 주세요.\n\n"
        "본인이 요청한 것이 아니라면 이 메일을 무시하셔도 됩니다."
    )
    context = ssl.create_default_context()
    with _IPv4SMTP_SSL(SMTP_HOST, SMTP_PORT, context=context, timeout=20) as server:
        server.login(SMTP_USER, SMTP_PASSWORD)
        server.send_message(msg)


def _hash_password(password, salt=None):
    salt = salt or secrets.token_bytes(16)
    digest = hashlib.pbkdf2_hmac("sha256", password.encode("utf-8"), salt, 200_000)
    return salt.hex(), digest.hex()


def _verify_password_hash(password, salt_hex, hash_hex):
    _, digest_hex = _hash_password(password, bytes.fromhex(salt_hex))
    return secrets.compare_digest(digest_hex, hash_hex)


def _user_doc_id(email):
    return "email:" + email.strip().lower()


def start_signup(email, password, name):
    """1단계: 이메일·비밀번호를 임시 저장하고 인증코드를 보낸다.
    아직 users 컬렉션에는 만들지 않는다 — complete_signup에서 코드 확인 후 만든다."""
    _require_db()
    email = email.strip().lower()
    if not _EMAIL_RE.match(email):
        raise ValueError("올바른 이메일 주소를 입력하세요.")
    if len(password) < 8:
        raise ValueError("비밀번호는 8자 이상이어야 합니다.")
    if DB.collection("users").document(_user_doc_id(email)).get().exists:
        raise ValueError("이미 가입된 이메일입니다. 로그인해 주세요.")

    ref = DB.collection("pending_signups").document(email)
    snap = ref.get()
    if snap.exists:
        try:
            created = datetime.fromisoformat(snap.to_dict().get("created_at"))
            elapsed = (datetime.now(timezone.utc) - created).total_seconds()
        except Exception:
            elapsed = SIGNUP_RESEND_COOLDOWN
        if elapsed < SIGNUP_RESEND_COOLDOWN:
            wait = int(SIGNUP_RESEND_COOLDOWN - elapsed)
            raise ValueError(f"잠시 후 다시 시도하세요 ({wait}초 남음).")

    salt_hex, hash_hex = _hash_password(password)
    code = _gen_verify_code()
    ref.set({
        "email": email,
        "name": name.strip(),
        "password_salt": salt_hex,
        "password_hash": hash_hex,
        "code": code,
        "attempts": 0,
        "created_at": _now_iso(),
        "expires_at": (datetime.now(timezone.utc) + timedelta(seconds=VERIFY_CODE_TTL)).isoformat(),
    })
    send_verification_email(email, code)


def complete_signup(email, code):
    """2단계: 인증코드를 확인하고 실제 계정(users 문서)을 만든다. 성공하면
    세션에 쓸 user_id를 돌려준다."""
    _require_db()
    email = email.strip().lower()
    ref = DB.collection("pending_signups").document(email)
    snap = ref.get()
    if not snap.exists:
        raise ValueError("회원가입 요청을 찾을 수 없습니다. 다시 시도하세요.")
    d = snap.to_dict()
    try:
        expires = datetime.fromisoformat(d["expires_at"])
    except Exception:
        expires = datetime.now(timezone.utc)
    if datetime.now(timezone.utc) >= expires:
        ref.delete()
        raise ValueError("인증코드가 만료되었습니다. 다시 가입해 주세요.")
    if d.get("attempts", 0) >= VERIFY_MAX_ATTEMPTS:
        ref.delete()
        raise ValueError("인증 시도 횟수를 초과했습니다. 다시 가입해 주세요.")
    if code.strip() != d.get("code"):
        ref.update({"attempts": firestore.Increment(1)})
        raise ValueError("인증코드가 올바르지 않습니다.")

    user_id = _user_doc_id(email)
    DB.collection("users").document(user_id).set({
        "email": email,
        "name": d.get("name") or "",
        "password_salt": d["password_salt"],
        "password_hash": d["password_hash"],
        "provider": "password",
        "created_at": _now_iso(),
    })
    ref.delete()
    return user_id


def login_with_password(email, password):
    _require_db()
    email = email.strip().lower()
    snap = DB.collection("users").document(_user_doc_id(email)).get()
    if not snap.exists:
        raise ValueError("이메일 또는 비밀번호가 올바르지 않습니다.")
    d = snap.to_dict()
    if not d.get("password_hash"):
        raise ValueError("이 계정은 구글 로그인 전용입니다. 구글로 로그인해 주세요.")
    if not _verify_password_hash(password, d["password_salt"], d["password_hash"]):
        raise ValueError("이메일 또는 비밀번호가 올바르지 않습니다.")
    return _user_doc_id(email), d

GEMINI_LIST_URL = "https://generativelanguage.googleapis.com/v1beta/models?pageSize=1000"

GEMINI_URL = (
    "https://generativelanguage.googleapis.com/v1beta/models/{model}:generateContent"
)

# --- 요청 본문 상한 ---------------------------------------------------------
# 본문은 통째로 메모리에 올라간다. 상한이 없으면 큰 요청 몇 개에 인스턴스가
# 죽을 수 있다(Render 무료 512MB).
MAX_BODY_BYTES = int(os.environ.get("MAX_BODY_BYTES", str(14 * 1024 * 1024)))
# 사진 1장의 상한. 화면이 긴 변 1600px JPEG로 줄여 보내므로 보통 0.3~0.6MB가 된다.
MAX_FILE_BYTES = int(os.environ.get("MAX_FILE_BYTES", str(10 * 1024 * 1024)))
# 사진에서 지문 옮겨 적기(OCR)에 받는 형식. PDF는 다루지 않는다 — 사진만.
OCR_MIMES = {"image/jpeg", "image/png", "image/webp", "image/heic", "image/heif"}

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

# 429(할당량) 빠른 실패 기준.
# 분당 한도라면 구글이 응답에 짧은 retryDelay를 실어 보내므로 그만큼만 기다렸다
# 다시 시도할 값어치가 있다. 반면 '일일 한도 소진'은 기다려도 리셋 전까지 안 풀리는데,
# 예전에는 이 경우에도 150초를 헛되이 기다린 뒤에야 오류를 띄웠다(게다가 재시도가
# 남은 할당량을 더 태웠다). 권장 대기가 이 값을 넘거나 아예 없으면 즉시 포기한다.
QUOTA_RETRY_MAX_WAIT = float(os.environ.get("QUOTA_RETRY_MAX_WAIT", "20"))
QUOTA_MAX_RETRIES = int(os.environ.get("QUOTA_MAX_RETRIES", "2"))
                         # 분당 한도로 보이더라도 이 횟수까지만 재시도한다

QUOTA_MESSAGE = (
    "무료 등급 사용량 한도를 초과했습니다. 오늘 한도가 리셋되기 전까지는 "
    "다시 시도해도 풀리지 않습니다. ① 정확도(모델)에서 다른 Flash 모델로 바꾸거나 "
    "② 한도가 리셋된 뒤 다시 시도하세요. "
    "(Google 결제를 설정하면 한도가 크게 늘어납니다.)"
)


class QuotaExceeded(RuntimeError):
    """무료 등급 할당량 소진 — 재시도해도 풀리지 않으므로 즉시 중단해야 한다."""


class ProUnavailable(RuntimeError):
    """결제되지 않은 키로 Pro 모델을 고른 경우 — Flash로 바꿔야 하므로 즉시 중단한다."""


class Recitation(RuntimeError):
    """Gemini가 '학습 데이터의 문헌을 그대로 재현 중'이라고 보고 출력을 막은 경우.
    안전(SAFETY) 필터와 달리 지문 내용이 문제인 게 아니라 '원문 그대로 복제'라는
    행위 자체가 걸린 것이라, 표본을 달리해 다시 뽑으면 통과하는 일이 잦다.
    (수능·모평 기출이나 교과서 지문처럼 학습 데이터에 있는 글에서 특히 자주 난다)"""


class NeedsPro(RuntimeError):
    """반대로, 고른 기능이 Pro를 요구하는데 Flash가 선택된 경우('5개 이상 변형').
    모델을 바꾸기 전에는 몇 번을 시도해도 같으므로 남은 작업까지 즉시 중단한다."""


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
                # passageHtml은 required가 아니다 — 지문을 가공 없이 그대로 쓰는 유형
                # (QUIZ_PLAIN_PASSAGE_TYPES)은 비워서 보내고 서버가 채운다.
                # 지문을 유형 수만큼 되받지 않으므로 출력 토큰이 크게 줄고,
                # 문항끼리 지문이 미묘하게 달라지는 사고도 사라진다.
                "required": ["no", "type", "format", "instruction",
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
    "서술형배열", "OX진위(영)", "OX진위(한)",
    "어휘 선택형", "어법 선택형", "틀린 어휘 찾기", "틀린 어법 찾기",
]

# 지문을 '가공 없이 통째로' 보여 주는 유형 — 빈칸·밑줄·블록 분할이 전혀 없다.
# 이 유형들의 passageHtml은 매번 지문 전문의 복사본이라, 유형 수만큼 지문이
# 출력에 중복돼 실린다(12유형이면 지문 12벌). 모델에게는 비워서 보내게 하고
# 서버가 지문으로 채워, 출력 토큰과 생성 시간을 함께 줄인다.
QUIZ_PLAIN_PASSAGE_TYPES = {
    "주제", "제목", "요지",
    "내용일치(영)", "내용일치(한)", "내용불일치(영)", "내용불일치(한)",
    "OX진위(영)", "OX진위(한)",
}


def passage_to_html(passage):
    """지문 원문을 문항용 HTML로 바꾼다 — 모델이 만들어 주던 것과 같은 형태.
    < > & 를 이스케이프하고 줄바꿈을 <br>(문단 사이는 <br><br>)로 바꾼다."""
    text = (passage or "").replace("&", "&amp;").replace("<", "&lt;").replace(">", "&gt;")
    text = re.sub(r"\r\n?", "\n", text).strip()
    text = re.sub(r"\n{2,}", "<br><br>", text)
    return text.replace("\n", "<br>")

QUIZ_SYSTEM_PROMPT = r"""You are an expert Korean high-school English teacher who writes
수능·모의고사 style multiple-choice reading-comprehension questions from a given English
passage. Return ONLY the structured JSON described by the schema — no markdown, no prose.

You will receive: (1) one English passage, (2) a list of ALLOWED question types, (3) how
many questions total to produce, (4) a passage variation level. Produce EXACTLY that many
questions, choosing types ONLY from the allowed list (spread across different types when
possible; only repeat a type if the allowed list is smaller than the requested count).

## Passage variation level
The request states one of three levels for how much you may reword the input passage before
building questions from it:
- "원문 그대로" — Use the input passage exactly as given. Change no wording at all.
- "단어 5개 내외 변형" — First silently produce ONE reworded version of the ENTIRE passage:
  replace roughly 5 content words/phrases with different wording of equivalent meaning and
  difficulty (동의어·다른 표현으로 자연스럽게 교체). Keep every fact, the order of ideas,
  sentence count, paragraph breaks, proper nouns, and numbers exactly the same — only the
  wording changes.
- "단어 5개 이상 변형" — Same rules as above, but replace MORE than 5 content words/phrases.
Whichever level applies (including "원문 그대로"), build EVERY question in this response from
THAT SAME single version of the passage — never re-derive a second, different rewording
partway through — so that blanks, underlines, scrambled blocks, and every "다음 글의 내용과
일치하는 것은?" style choice stay consistent with each other and with what the student reads
in every other question.

## Output per question — fields
- `no`: 1, 2, 3… in order.
- `type`: one of the allowed type names, EXACTLY as given (e.g. "주제").
- `format`: "mc" for 5-choice questions, "write" for 서술형배열, "tf" for OX진위(영)/OX진위(한),
  "pick" for 어휘/어법 선택형, "fix" for 틀린 어휘/어법 찾기.
  Every other type is "mc".
- `instruction`: the exact Korean question line the student reads (수능 어투 그대로), e.g.
  "다음 글의 주제로 가장 적절한 것은?". For "문장삽입" also embed the sentence to insert,
  on its own line after the question line, like:
  다음 글에서 전체 흐름으로 보아 주어진 문장이 들어가기에 가장 적절한 곳을 고르시오.<br><br>
  <b>주어진 문장:</b> The sentence text.
- `passageHtml`: the passage the student reads for THIS question, reformatted per the rules
  below. Plain text plus ONLY <br>, <u>, <b> tags allowed — nothing else (no colors/ruby).
  ⚠️ When the request says "지문 재사용: 켬", the types listed there show the passage with NO
  modification at all (no blank, no underline, no scrambling, no insertion markers). For those
  types you MUST OMIT `passageHtml` entirely — the app inserts the passage itself. Copying the
  passage out again wastes output and risks it drifting from what other questions show.
  Every OTHER type still requires `passageHtml`, because its passage is genuinely modified.
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
Below, "passageHtml = 지문 전문" means: OMIT the field when 지문 재사용 is on, otherwise output
the passage in full.
- "주제" — instruction "다음 글의 주제로 가장 적절한 것은?". passageHtml = 지문 전문.
  choices = 5 topic phrases (English or Korean), one clearly correct.
- "제목" — instruction "다음 글의 제목으로 가장 적절한 것은?". passageHtml = 지문 전문.
  choices = 5 short English title phrases.
- "요지" — instruction "다음 글의 요지로 가장 적절한 것은?". passageHtml = 지문 전문.
  choices = 5 Korean 요지 문장.
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
- "내용일치(영)" — instruction "다음 글의 내용과 일치하는 것은?". passageHtml = 지문 전문.
  choices = 5 ENGLISH statements about the passage; EXACTLY ONE is true to the
  passage, the other 4 must CONTRADICT it (not merely be unmentioned). answer = the true one.
- "내용일치(한)" — identical to "내용일치(영)" but every choice is written in KOREAN.
- "내용불일치(영)" — instruction "다음 글의 내용과 일치하지 않는 것은?".
  passageHtml = 지문 전문. choices = 5 ENGLISH statements; EXACTLY FOUR are true to the passage
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
- "OX진위(영)" (format "tf") — instruction
  "다음 글의 내용과 일치하면 O, 일치하지 않으면 X를 쓰시오."
  passageHtml = 지문 전문. `tfItems` = EXACTLY 5 objects {text, isTrue}:
  · `text` = one short ENGLISH statement about the passage.
  · `isTrue` = true if it matches the passage, false if it contradicts it.
  Mix them up — roughly 2~3 true and 2~3 false, in a non-obvious order. Each statement must
  come from a DIFFERENT part of the passage. choices = [], answer = 0.
- "OX진위(한)" — identical to "OX진위(영)" in every way (same instruction, same passageHtml,
  same true/false mix, same rules) EXCEPT `text` for each tfItem is written in KOREAN instead
  of English (자연스러운 한국어 문장으로, 영어 원문을 그대로 옮기지 말고 내용만 정확히 번역).

## Quality rules
- Base everything on the ACTUAL passage content — never invent facts not in the passage.
- Only ONE choice may be correct; the other 4 must be clearly wrong to a careful reader but
  plausible enough to require real understanding (avoid silly/obviously-wrong options).
- Vary which choice number is correct across questions (don't make the answer always ①).
- Escape literal < > & in passage text as &lt; &gt; &amp; before adding your own <u>/<b>/<br>.

## explanation — MANDATORY FOR EVERY SINGLE QUESTION (no exceptions)
This is the most frequently violated rule. Read it twice.
- EVERY object in `questions` MUST carry a non-empty Korean `explanation`. There is no
  question type that is exempt — 객관식 and 주관식 (서술형배열 / OX진위(영) / OX진위(한) /
  어휘 선택형 / 어법 선택형 / 틀린 어휘 찾기 / 틀린 어법 찾기) all require one.
- NEVER output "", " ", "-", "없음", "해설 없음", or a copy of the answer. An empty string
  is a FAILED response even though the schema accepts it.
- Minimum 25 Korean characters. State WHY the answer is right — the grammar point, the
  contextual clue, or the sentence in the passage it rests on. For multi-part answers
  (OX진위(영)/OX진위(한), 틀린 어법/어휘 찾기, 선택형) cover EVERY part, e.g. "(1)…, (2)…".
- Before returning, count your questions and count your non-empty explanations. The two
  numbers MUST be equal. If they are not, write the missing explanations and only then return.

Return valid JSON only."""


def blank_explanations(result):
    """해설이 비어 있는(또는 사실상 비어 있는) 문항의 1-based 번호 목록."""
    out = []
    for i, q in enumerate(result.get("questions", []) or []):
        if not isinstance(q, dict):
            continue
        exp = re.sub(r"<[^>]*>", "", str(q.get("explanation") or "")).strip()
        if len(exp) < 8 or exp in {"-", "없음", "해설 없음", "N/A"}:
            out.append(i + 1)
    return out


# 화면의 '지문 변형' 드롭다운 값 → 프롬프트에 넣을 한국어 표현.
# 서버가 받는 값은 이 딕셔너리의 key로만 한정하고, 모르는 값은 "원문 그대로"로 되돌린다
# (예전 버전 화면이 캐시돼 이상한 값을 보내도 안전하게 동작하도록).
QUIZ_VARIATIONS = {
    "verbatim": "원문 그대로",
    "light": "단어 5개 내외 변형",
    "heavy": "단어 5개 이상 변형",
}


def build_quiz_user_prompt(passage, types, count, short_hint=None, explain_hint=None, variation="verbatim"):
    lines = [
        f"지문 변형 정도: {QUIZ_VARIATIONS.get(variation, QUIZ_VARIATIONS['verbatim'])}",
        f"허용된 문제 유형: {', '.join(types)}",
        f"총 문항 수: {count}개 (정확히 이 개수만큼 생성)",
    ]
    # 지문 재사용(passageHtml 생략)은 '원문 그대로'일 때만 켠다.
    # light/heavy는 모델이 응답 안에서 즉석으로 리워딩하므로 서버가 가진 원문으로
    # 채우면 학생이 읽는 지문과 어긋난다 — 그때는 지금까지처럼 모델이 직접 싣는다.
    reuse = sorted(set(types) & QUIZ_PLAIN_PASSAGE_TYPES) if variation == "verbatim" else []
    if reuse:
        lines.append(
            "지문 재사용: 켬 — 다음 유형은 passageHtml 필드를 아예 넣지 마세요(앱이 지문을 "
            f"그대로 채웁니다): {', '.join(reuse)}"
        )
    else:
        lines.append("지문 재사용: 끔 — 모든 문항에 passageHtml을 직접 채우세요.")
    lines += [
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
        # 유형별 1문항 고정이므로, 몇 개가 모자랐는지보다 '어떤 유형이 빠졌는지'를
        # 알려 주는 편이 재요청 한 번에 채워질 확률이 높다.
        if isinstance(short_hint, (list, tuple, set)) and short_hint:
            lines.append(
                f"⚠️ 이전 시도는 {', '.join(short_hint)} 유형을 빠뜨렸습니다. "
                f"이번에는 빠진 유형을 반드시 포함해 {count}문항을 끝까지 모두 생성하세요."
            )
        else:
            lines.append(
                f"⚠️ 이전 시도는 {short_hint}문항만 만들었습니다. 이번에는 반드시 {count}문항을 "
                f"끝까지 모두 생성하세요. 중간에 멈추지 마세요."
            )
    if explain_hint:
        lines.append(
            f"⚠️ 이전 시도는 {len(explain_hint)}개 문항({', '.join(map(str, explain_hint))}번)의 "
            "explanation을 비워서 보냈습니다. 이번에는 모든 문항에 25자 이상의 한국어 해설을 "
            "반드시 채우세요. 해설이 빈 문항이 하나라도 있으면 실패입니다."
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


def call_gemini_quiz(passage, types, count, api_key, model, short_hint=None,
                      explain_hint=None, variation="verbatim"):
    api_key = (api_key or "").strip() or os.environ.get("GEMINI_API_KEY", "").strip()
    if not api_key:
        raise RuntimeError(
            "관리자가 아직 서버에 Gemini API 키(GEMINI_API_KEY)를 설정하지 않았습니다. "
            "관리자에게 문의하세요."
        )
    model = model if (model and _MODEL_RE.match(model)) else MODEL
    types = [t for t in (types or []) if t in QUIZ_TYPE_LABELS] or ["주제", "제목", "요지"]
    count = max(1, min(int(count or 5), 30))
    variation = variation if variation in QUIZ_VARIATIONS else "verbatim"
    # 화면에서 이미 막지만, 화면을 우회해도 서버가 최종 방어한다(다른 검증들과 같은 원칙).
    # '5개 이상 변형'은 지문 전체를 사실·순서·난이도는 그대로 두고 대량으로 바꿔 쓰는
    # 작업이라 Flash보다 Pro가 훨씬 안정적으로 해낸다.
    if variation == "heavy" and "pro" not in (model or "").lower():
        raise NeedsPro(
            "지문 변형 '단어 5개 이상 변형'은 Pro 모델에서만 사용할 수 있습니다. "
            "정확도(모델)에서 Pro를 선택하거나, 변형 정도를 '단어 5개 내외 변형'으로 낮추세요."
        )

    payload = {
        "systemInstruction": {"parts": [{"text": QUIZ_SYSTEM_PROMPT}]},
        "contents": [
            {"role": "user", "parts": [
                {"text": build_quiz_user_prompt(
                    passage, types, count, short_hint, explain_hint, variation
                )}
            ]}
        ],
        "generationConfig": {
            "temperature": 0.4,
            # 문항마다 지문이 통째로 들어가므로 문항 수가 많으면 출력이 커진다 → 넉넉히
            "maxOutputTokens": 65536,
            "responseMimeType": "application/json",
            "responseSchema": QUIZ_SCHEMA,
        },
    }
    result = _gemini_json(payload, api_key, model, _QUIZ_TRUNC_MSG)

    # 지문을 그대로 쓰는 유형의 빈 passageHtml을 서버가 채운다.
    # '원문 그대로'일 때만 해당한다 — light/heavy는 모델이 응답 안에서 리워딩한 지문을
    # 쓰므로 원문으로 채우면 학생이 읽는 지문과 어긋난다.
    if variation == "verbatim":
        plain_html = passage_to_html(passage)
        for q in result.get("questions", []):
            if not isinstance(q, dict):
                continue
            if q.get("type") in QUIZ_PLAIN_PASSAGE_TYPES and not str(q.get("passageHtml") or "").strip():
                q["passageHtml"] = plain_html

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


# ── 지문 변형(리워딩) ──
# 문제 생성과 분리된 짧은 호출이다. 유형을 나눠 여러 번 호출할 때 각 호출이 저마다
# 다른 변형본을 만들어 버리면 한 문제지 안에서 지문이 달라진다. 그래서 변형본을
# 먼저 한 번 확정해 두고, 이후 문제 생성은 그 텍스트를 '원문 그대로'로 받아 쓴다.
REWORD_SCHEMA = {
    "type": "OBJECT",
    "properties": {"passage": {"type": "STRING"}},
    "required": ["passage"],
    "propertyOrdering": ["passage"],
}

REWORD_SYSTEM_PROMPT = r"""You reword English reading passages for Korean high-school exams.
Return ONLY the structured JSON described by the schema — no markdown, no prose, no commentary.

Produce ONE reworded version of the ENTIRE passage at the requested level:
- "단어 5개 내외 변형" — replace roughly 5 content words/phrases.
- "단어 5개 이상 변형" — replace clearly more than 5 (about 8~15) content words/phrases.

Rules (all levels):
- Replace words with wording of EQUIVALENT meaning and EQUIVALENT difficulty
  (동의어·다른 표현으로 자연스럽게 교체). The result must read like natural published English.
- Keep EVERY fact, the order of ideas, the number of sentences, paragraph breaks, proper
  nouns, numbers, and quoted text exactly the same. Do not add, merge, split, or drop
  sentences. Do not add or remove information.
- Keep the reading difficulty the same — do not simplify and do not make it fancier.
- Return the FULL passage, start to finish, as plain text. No HTML, no markdown, no
  underlines, no numbering, no title, no notes about what you changed.

The output is what students will read, so it must stand on its own as a complete passage."""


def build_reword_user_prompt(passage, variation):
    return "\n".join([
        f"변형 정도: {QUIZ_VARIATIONS.get(variation, QUIZ_VARIATIONS['light'])}",
        "",
        "[원문]",
        passage.strip(),
    ])


_REWORD_TRUNC_MSG = "지문 변형본이 잘렸습니다. 지문을 더 짧게 나눠 다시 시도하세요."


def call_gemini_reword(passage, variation, api_key, model):
    """지문을 한 번만 리워딩해 확정된 변형본 텍스트를 돌려준다."""
    api_key = (api_key or "").strip() or os.environ.get("GEMINI_API_KEY", "").strip()
    if not api_key:
        raise RuntimeError(
            "관리자가 아직 서버에 Gemini API 키(GEMINI_API_KEY)를 설정하지 않았습니다. "
            "관리자에게 문의하세요."
        )
    model = model if (model and _MODEL_RE.match(model)) else MODEL
    if variation not in ("light", "heavy"):
        # 변형이 필요 없는 값이 오면 원문을 그대로 돌려준다 (호출 자체가 낭비)
        return passage
    # '5개 이상 변형'은 Pro에서만 — 문제 생성이 아니라 이 단계에 걸리는 제약이다.
    if variation == "heavy" and "pro" not in (model or "").lower():
        raise NeedsPro(
            "지문 변형 '단어 5개 이상 변형'은 Pro 모델에서만 사용할 수 있습니다. "
            "정확도(모델)에서 Pro를 선택하거나, 변형 정도를 '단어 5개 내외 변형'으로 낮추세요."
        )

    payload = {
        "systemInstruction": {"parts": [{"text": REWORD_SYSTEM_PROMPT}]},
        "contents": [
            {"role": "user", "parts": [{"text": build_reword_user_prompt(passage, variation)}]}
        ],
        "generationConfig": {
            # 지문 하나만 다시 쓰는 짧은 작업이라 온도를 낮게 잡아 사실 왜곡을 줄인다
            "temperature": 0.3,
            "maxOutputTokens": 8192,
            "responseMimeType": "application/json",
            "responseSchema": REWORD_SCHEMA,
        },
    }
    result = _gemini_json(payload, api_key, model, _REWORD_TRUNC_MSG)

    out = str(result.get("passage") or "").strip()
    # 빈 응답이나 눈에 띄게 짧아진 결과는 채택하지 않는다 — 문장을 통째로 날려 먹은
    # 경우인데, 그대로 쓰면 뒤따르는 모든 문항의 근거가 사라진다.
    if len(out) < len(passage.strip()) * 0.6:
        raise RuntimeError(
            "지문 변형본이 원문보다 크게 짧아 사용하지 않았습니다. 다시 시도하거나 "
            "'원문 그대로'로 만들어 주세요."
        )
    return out


# 변형본에서 실제로 바뀐 낱말을 찾아낸다.
# 모델에게 "무엇을 바꿨는지 같이 알려 달라"고 시키지 않는 이유: 모델의 자기 보고는
# 빠뜨리거나 실제 출력과 어긋나기 쉽고 토큰도 더 쓴다. 원문과 결과를 직접 비교하면
# 언제나 출력과 정확히 일치하는 목록이 나온다.
_WORD_TOKEN_RE = re.compile(r"[A-Za-z0-9’'\-]+|\s+|[^\sA-Za-z0-9’'\-]+")


def _is_word(tok):
    return bool(tok) and (tok[0].isalnum() or tok[0] in "’'")


def diff_variations(original, reworded):
    """원문 → 변형본에서 교체된 낱말 쌍 [{"from": …, "to": …}] 목록."""
    a = [t for t in _WORD_TOKEN_RE.findall(original or "")]
    b = [t for t in _WORD_TOKEN_RE.findall(reworded or "")]
    # 공백·문장부호는 비교에서 빼고 낱말만 맞춰야 '한 낱말 → 두 낱말' 교체도
    # 하나의 변경으로 잡힌다 (사이에 낀 공백이 별도 변경으로 쪼개지지 않는다).
    aw = [t for t in a if _is_word(t)]
    bw = [t for t in b if _is_word(t)]
    pairs = []
    seen = set()
    for op, i1, i2, j1, j2 in difflib.SequenceMatcher(None, aw, bw, autojunk=False).get_opcodes():
        if op != "replace":
            continue  # 순수 삽입·삭제는 '교체'가 아니므로 목록에 넣지 않는다
        src = " ".join(aw[i1:i2]).strip()
        dst = " ".join(bw[j1:j2]).strip()
        if not src or not dst or src.lower() == dst.lower():
            continue
        key = (src.lower(), dst.lower())
        if key in seen:
            continue
        seen.add(key)
        pairs.append({"from": src, "to": dst})
    return pairs


# ── 사진에서 지문 옮겨 적기(OCR) ──
# 사진 1장 = 지문 1개. 그래서 요청도 응답도 '한 장'만 다룬다.
# 여러 장을 올리면 화면이 장마다 따로 요청한다 — 한 장이 실패해도 나머지는 살고,
# 끝나는 대로 입력칸에 채워져 진행이 보이기 때문.
# 지문을 통짜 문자열 하나로 받지 않고 '문장별 배열'로 받는다.
# Gemini의 재현(RECITATION) 검사는 출력의 '연속된 구간'이 학습 데이터의 원문과 길게
# 일치하는지를 보는데, 문장마다 따로 담으면 원 응답 문자열이 따옴표·쉼표로 끊겨
# 긴 연속 일치가 생기지 않아 차단을 훨씬 덜 만난다. 서버가 다시 이어 붙인다.
OCR_SCHEMA = {
    "type": "OBJECT",
    "properties": {
        "lines": {"type": "ARRAY", "items": {"type": "STRING"}},
        "note": {"type": "STRING"},
    },
    "required": ["lines", "note"],
    "propertyOrdering": ["lines", "note"],
}

OCR_SYSTEM_PROMPT = r"""You transcribe the English reading passage from ONE photo of Korean
school/exam material (교과서·모의고사·문제집). Return ONLY the structured JSON in the schema —
no markdown, no commentary.

## Output shape — one SENTENCE per array item
`lines` is an array. Put ONE sentence of the passage in each item, in order.
- Split at sentence ends (. ? !). Do not split mid-sentence.
- Use "" (an empty string item) to mark a paragraph break between sentences.
- Do NOT number the items and do NOT add any text that is not in the photo.
Report any problem you hit in `note`.

## Transcribe EXACTLY — this is transcription, not writing
- Copy the English word for word: same spelling, capitalization, punctuation, numbers.
- NEVER translate, NEVER fix grammar or spelling (even if the original looks wrong),
  NEVER summarize, NEVER shorten, NEVER continue a sentence that is cut off.
- NEVER invent text. If a word is blurred, covered by handwriting, or cut off at the edge,
  transcribe only what you can actually read and record the problem in `note`. A plausible
  guess is the worst possible outcome — one wrong word corrupts every question built from
  this passage later.
- If the photo has no English reading passage at all, set `lines` to [] and say so in `note`.

## Remove — these are NOT part of the passage
- Question numbers and Korean prompts: "24.", "다음 글의 제목으로 가장 적절한 것은?"
- Multiple-choice options: ① ② ③ ④ ⑤ lines, and (A)/(B)/(C) answer boxes
- Korean translations, Korean explanations, vocabulary glosses, footnotes
- Page numbers, headers, footers, source tags ("[2024학년도 수능]", "고3 3월 학평")
- Handwriting and highlighter marks — transcribe the printed word underneath
- Sentence markers at the start of sentences (❶ ① ➊ …) — drop the marker, keep the sentence

## Keep and repair
- Keep the passage's own sentence order. Mark paragraph breaks with an empty item.
- JOIN text that the page layout broke mid-sentence — each item must be a whole sentence,
  never one printed line.
- Repair hyphenation split across lines: "compre-" + "hension" → "comprehension".
- If the page has TWO COLUMNS, read the left column fully, then the right column.
- Blanks printed in the passage (______ or (A)) stay as they are; mention them in `note`
  so the teacher knows this is a question version, not the original text.

## note (Korean, short)
- "" when the photo was clean and fully readable.
- Otherwise state the concrete problem in one sentence: 흐려서 못 읽은 부분, 잘린 부분,
  필기에 가려진 부분, 빈칸이 포함된 문제용 지문임, 영어 지문이 없음 등.

Return valid JSON only."""


_OCR_TRUNC_MSG = "사진의 글자가 너무 많아 옮기다가 잘렸습니다. 나눠 찍어 올려 주세요."


def _join_ocr_lines(lines):
    """문장별 배열을 다시 하나의 지문으로 잇는다.
    빈 항목은 문단 경계이므로 빈 줄로 바꾸고, 나머지는 공백으로 잇는다."""
    paras, cur = [], []
    for raw in lines or []:
        line = _TAG_STRIP_RE.sub("", str(raw or "")).strip()
        if not line:
            if cur:
                paras.append(" ".join(cur))
                cur = []
            continue
        cur.append(line)
    if cur:
        paras.append(" ".join(cur))
    return "\n\n".join(paras).strip()


def call_gemini_ocr(file, api_key, model, partial=False):
    """사진 1장(base64)에서 영어 지문을 옮겨 적어 {text, note}를 돌려준다.
    file: {"mime": "image/jpeg", "data": "<base64>"} — 화면이 이미 축소해 보낸다.
    partial: 이 사진이 한 페이지를 가로로 자른 '조각'인 경우 True
             (재현 차단을 피하려고 화면이 사진을 나눠 보낼 때 쓴다)."""
    api_key = (api_key or "").strip() or os.environ.get("GEMINI_API_KEY", "").strip()
    if not api_key:
        raise RuntimeError(
            "관리자가 아직 서버에 Gemini API 키(GEMINI_API_KEY)를 설정하지 않았습니다. "
            "관리자에게 문의하세요."
        )
    model = model if (model and _MODEL_RE.match(model)) else MODEL

    mime = (file.get("mime") or "").lower().split(";")[0].strip()
    data = file.get("data") or ""
    if mime not in OCR_MIMES:
        raise RuntimeError(
            f"지원하지 않는 파일 형식입니다({mime or '알 수 없음'}). "
            "JPG·PNG·WEBP 사진만 올릴 수 있습니다."
        )
    if not data:
        raise RuntimeError("사진 내용이 비어 있습니다.")
    if len(data) > MAX_FILE_BYTES:
        raise RuntimeError(
            f"사진이 너무 큽니다 (최대 {MAX_FILE_BYTES // 1048576}MB). "
            "해상도를 낮춰 다시 올려 주세요."
        )

    ask = "이 사진에서 영어 지문을 그대로 옮겨 적으세요."
    if partial:
        # 조각은 위아래가 문장 중간에서 잘려 있다. 이어 붙이는 건 화면이 하므로
        # 여기서는 '보이는 것만' 정확히 옮기게 하고, 없는 말을 채우지 못하게 막는다.
        ask = (
            "이 사진은 한 페이지를 가로로 자른 '조각'입니다. 조각에 보이는 영어만 옮겨 "
            "적으세요. 위나 아래가 문장 중간에서 잘려 있어도 보이는 만큼만 그대로 적고, "
            "잘린 앞뒤 내용을 절대 짐작해서 채우지 마세요. 잘린 조각이므로 첫 항목과 "
            "마지막 항목은 완전한 문장이 아닐 수 있습니다 — 그대로 두세요."
        )
    payload = {
        "systemInstruction": {"parts": [{"text": OCR_SYSTEM_PROMPT}]},
        "contents": [{"role": "user", "parts": [
            {"inlineData": {"mimeType": mime, "data": data}},
            {"text": ask},
        ]}],
        "generationConfig": {
            # 옮겨 적기는 창작이 아니라 낮은 온도가 맞지만, 0으로 두면 '가장 그럴듯한 다음
            # 토큰'만 골라 학습 데이터의 원문과 글자 단위로 일치해 RECITATION 차단을
            # 부른다(실제로 기출 지문에서 발생). 읽을 대상이 사진에 있어 모델이 추측할
            # 여지가 크지 않으므로, 살짝 올려도 정확도 손해는 거의 없다.
            "temperature": 0.15,
            "maxOutputTokens": 16384,
            "responseMimeType": "application/json",
            "responseSchema": OCR_SCHEMA,
        },
    }
    result = _gemini_json(payload, api_key, model, _OCR_TRUNC_MSG)

    # 문장별 배열을 다시 잇는다 (태그가 섞여 오면 걷어낸다)
    text = _join_ocr_lines(result.get("lines"))
    note = str(result.get("note") or "").strip()
    if not text:
        raise RuntimeError(
            note or "사진에서 영어 지문을 찾지 못했습니다. 지문이 잘 보이게 다시 찍어 올려 주세요."
        )
    return {"text": text, "note": note}


# ── 워크북(단계별 학습지) 스키마 ──
# 한 번의 호출로 모든 단계의 재료를 받아, 서버/클라이언트가 단계별로 조립한다.
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
                    "chunks": {"type": "ARRAY", "items": {"type": "STRING"}},
                    "writeKeys": {"type": "ARRAY", "items": {"type": "STRING"}},
                    "writeMask": {"type": "STRING"},
                },
                "required": ["no", "heading", "en", "ko", "enBlank",
                             "verbForm", "grammarChoice", "chunks",
                             "writeKeys", "writeMask"],
                "propertyOrdering": ["no", "heading", "en", "ko", "enBlank",
                                     "verbForm", "grammarChoice", "chunks",
                                     "writeKeys", "writeMask"],
            },
        },
        # 워크북 7 — 지문 전체를 통으로 주고 어법 오류 3개를 심는다
        "grammarFix": {
            "type": "OBJECT",
            "properties": {
                "text": {"type": "STRING"},
                "spans": {"type": "ARRAY", "items": {"type": "STRING"}},
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
            "required": ["text", "spans", "fixes"],
            "propertyOrdering": ["text", "spans", "fixes"],
        },
        # 워크북 9 — 문단 배열
        "paraOrder": {
            "type": "OBJECT",
            "properties": {
                "head": {"type": "STRING"},
                "tail": {"type": "STRING"},
                "paragraphs": {"type": "ARRAY", "items": {"type": "STRING"}},
            },
            "required": ["head", "tail", "paragraphs"],
            "propertyOrdering": ["head", "tail", "paragraphs"],
        },
    },
    "required": ["englishTitle", "koreanTitle", "sentences", "grammarFix", "paraOrder"],
    "propertyOrdering": ["englishTitle", "koreanTitle", "sentences",
                         "grammarFix", "paraOrder"],
}


WORKBOOK_SYSTEM_PROMPT = r"""You are an expert Korean high-school English teacher who builds
'단계별 WORKBOOK' worksheets from an exam passage (수능·모의고사·내신 대비) — the exact format
Korean 학력평가 workbooks use. Return ONLY the structured JSON described by the schema.

You will receive ONE English passage. Split it into sentences and, for EACH sentence, provide
the raw materials the stages need. The app assembles the printable pages from your data,
so the MARKUP FORMAT below must be followed to the letter.

(The reference workbook has 10 stages; stages 1~2 are not produced here, so the numbering
below starts at 3 — it is the reference material's numbering, not a gap.)

The stages the app builds from your data:
  3 빈칸 완성하기(영문)   해석 보고 영문 빈칸 채우기   ← enBlank
  4 해석 연습하기        영문 보고 해석 쓰기         ← en (정답 ko)
  5 동사형 연습하기      괄호 안 동사 고쳐 쓰기      ← verbForm
  6 어법·어휘 고르기     [A / B] 중 옳은 것 고르기   ← grammarChoice
  7 어색한 곳 찾기       어법 오류 3개 찾아 고치기    ← grammarFix
  8 순서 배열하기        주어진 말 배열해 문장 완성   ← chunks
  9 문단 배열하기        문단 (A)(B)(C) 순서 정하기  ← paraOrder
 10 영작 연습하기        키워드로 문장 영작하기       ← writeKeys, writeMask

## sentences[] — one entry per sentence of the passage
- `no`: 1, 2, 3 … with no gaps, in original order. EVERY sentence of the passage must appear
  EXACTLY ONCE. Never stop partway — completeness is mandatory.
- `heading`: a section heading/subtitle appearing in the passage immediately BEFORE this
  sentence (e.g. "Discover Yourself"). Otherwise "".
- `en`: the sentence's original English, VERBATIM, plain text, no markup.
  · Salutations/closings that belong to the sentence (e.g. "To Whom It May Concern:",
    "Sincerely, Julia Morgan") stay attached to their sentence, exactly as in the passage.
- `ko`: a natural, complete Korean translation (문어체; 편지·기사면 존댓말, 이야기면 평서체 —
  글의 어조를 따른다). This is the answer key for stage 4, so it must read naturally on its own.

### `enBlank` — 워크북3 재료 (해석 보고 영문 완성)
Copy `en` exactly, then wrap 2~8 KEY English words/phrases in {{ }}.
Choose words worth memorizing (핵심 어휘·숙어·파생형), keeping the sentence solvable from `ko`.
Do NOT blank articles, be동사, or prepositions on their own.
Example: "People have been {{dumping}} their {{waste}} in areas of our {{neighborhood}} where
it's not {{permitted}}."

### `verbForm` — 워크북5 재료 (동사형 고쳐 쓰기)
Copy `en`, but replace each notable VERB GROUP with (힌트|정답):
  · LEFT of `|`  = the base words the student sees, comma-separated, in the order they combine.
    A verb group made of several words lists them all: 조동사·be·have + 본동사.
  · RIGHT of `|` = the exact inflected string that belongs there (what the passage actually has).
Cover 시제·상·수일치·태·to부정사·동명사·분사. 2~6 per sentence. Include verbals, not just 정동사.
Examples (left = shown, right = answer):
  "People (have, be, dump|have been dumping) their waste in areas of our neighborhood where
   it (not, permit|is not permitted)."
  "(Fix|To fix) this (grow|growing) problem, I (urge|urge) the city (strengthen|to strengthen)
   management."
RULES: no nested parentheses; the left side never contains `|`; the right side is a verbatim
slice of `en`. Capitalize the left side only when it starts the sentence.

### `grammarChoice` — 워크북6 재료 (어법·어휘 고르기)
Copy `en`, but replace 3~6 points with [정답|오답]:
  · LEFT of `|`  = the CORRECT form, exactly as it appears in the passage.
  · RIGHT of `|` = a plausible WRONG alternative. The app shuffles the two on the page.
Mix BOTH kinds of points in every sentence:
  · 어법: 수일치, 태, 시제, 준동사, 관계사(where/which/that), 접속사, 대명사, 병렬, 형용사/부사
  · 어휘: 문맥상 맞는 낱말 vs 반의어·혼동어 (permitted/prevented, illegal/legal,
          more and more/less and less, strengthen/weaken, garbage/garage, worse/better)
Example: "People have [been dumping|been dumped] their waste in areas of our neighborhood
[where|that] it's not [permitted|prevented]."
RULES: no nested brackets; both sides are short (1~3 words); everything outside [ ] is
identical to `en`.

### `chunks` — 워크북8 재료 (순서 배열)
Break `en` into 5~10 meaning units (구·절 단위: 주어부, 동사구, 전치사구, 관계절, 부사절).
Joining the chunks in order with single spaces must reproduce `en` exactly (punctuation
included; keep a comma at the end of the chunk it follows).
- The app SHUFFLES the chunks and prints them as ( a / b / c … ).
- Prefix a chunk with `=` to PIN it — pinned chunks are printed in place, unshuffled, and the
  runs of unpinned chunks around them become separate shuffled groups. Pin the parts that
  would give the answer away or that must anchor the sentence: 인사말·맺음말, 문두 연결어,
  "To", "recently", and short fixed tails.
Example for "To fix this growing problem, I urge the city to strengthen management ... in the
community.":
  ["=To", "fix", "this growing problem,", "=I", "urge", "the city", "to strengthen",
   "management and supervision", "of illegal dumping", "=in the community."]

### `writeKeys` / `writeMask` — 워크북10 재료 (영작)
- `writeKeys`: 3~7 short English keywords shown to the student, IN THE ORDER they appear in the
  sentence, given in BASE form (dump, waste, neighborhood, permit). Nouns may keep an article
  when that is the natural cue ("the recipe", "a ritual"). These are hints, not the answer.
- `writeMask`: copy `en` and wrap in {{ }} every span the student must write. Leave OUTSIDE the
  braces only the scaffolding that should stay printed: 짧은 기능어(in, of, and, where, that,
  it's), 고유명사, 인사말·맺음말. Aim to blank 60~80% of the words.
  Each word inside {{ }} becomes ONE underline on the page, so wrap real word spans.
  Everything outside {{ }} must be identical to `en`.
  Example: "People {{have been dumping their waste}} in areas of {{our neighborhood}} where
  it's {{not permitted}}."

## grammarFix — 워크북7 재료 (밑줄 친 부분 중 어법상 어색한 것 3개)
- `text`: the WHOLE passage as one block of running text (paragraph breaks with a blank line),
  identical to the original EXCEPT that you introduce EXACTLY 3 grammatical errors.
  The errors must be 어법 errors a Korean exam tests — 관계사(where→which), 수일치,
  태(be p.p.→능동), 준동사(to부정사↔동명사), 접속사, 병렬, 대명사 — NOT spelling or vocabulary.
- `spans`: 6~10 substrings of `text` to be underlined on the page, listed in the order they
  appear. They must be verbatim slices of `text`, clause-sized (5~15 words), non-overlapping.
  ALL 3 errors must fall inside one of these spans; the rest are correct spans (distractors).
- `fixes`: exactly 3 items, in the order the errors appear.
  · `wrong` = the erroneous words as they appear in `text` (short — just the wrong part).
  · `right` = what the original passage has.
Example: original "in areas of our neighborhood where it's not permitted" → text has
"... neighborhood which it's not permitted", span "which it's not permitted.",
fix {"wrong": "which", "right": "where"}.

## paraOrder — 워크북9 재료 (문단 배열)
- `paragraphs`: split the passage into 3 (occasionally 4) chunks of consecutive sentences that
  each form a coherent block, IN THE ORIGINAL ORDER. Their text must be the passage verbatim.
  The app shuffles them into (A)(B)(C) and the answer is the original order.
  Make the blocks roughly equal in length, and split where the flow turns (도입 / 전개 / 결론).
- `head`: text that must stay ABOVE the shuffled blocks because it is not part of the flow —
  a salutation ("To Whom It May Concern:"), a title, or an opening line that always comes
  first. "" if none.
- `tail`: likewise for the closing ("Sincerely,\nJulia Morgan"). "" if none.
  head/tail text must NOT also appear inside `paragraphs`.

## HARD RULES (the most common failures — verify each before returning)
1. `en` is the passage's sentence VERBATIM. Never paraphrase, never drop or add words.
2. `enBlank`, `writeMask` = `en` + braces only.
   `verbForm` = `en` with (…|…) only. `grammarChoice` = `en` with […|…] only.
   Strip the markup and you must get the original string back, character for character.
3. Use ONLY these markers: {{answer}}, (hint|answer), [correct|wrong], "=" as a chunk prefix.
   No HTML, no numbering inside the text, no other symbols.
4. `|` separates two parts and is used for nothing else. Never nest ( ) inside ( ) or
   [ ] inside [ ].
5. `chunks` joined with spaces == `en`. `grammarFix.spans` are verbatim slices of
   `grammarFix.text`. `grammarFix.fixes` has exactly 3 items.
6. Every sentence of the passage appears exactly once, in order, in `sentences`.

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
            "관리자가 아직 서버에 Gemini API 키(GEMINI_API_KEY)를 설정하지 않았습니다. "
            "관리자에게 문의하세요."
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
    return _gemini_json(payload, api_key, model, _WORKBOOK_TRUNC_MSG)


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

### 등위·상관접속사 병렬 (MANDATORY — 가장 자주 빠뜨리는 항목, 기계 검사로 대조된다)
DEFAULT = MARK IT. 지문에 나오는 "and / or / but / nor / yet"은 아래 '제외 목록'에 해당하지
않는 한 **전부** 등위접속사로 보고 표시하라. "이건 굳이 병렬이라 할 것까진…" 하고 넘기지 말 것.
빠뜨린 접속사는 서버가 기계적으로 세어 되돌려 보내므로, 처음부터 빠짐없이 표시하는 편이 낫다.

For EACH such conjunction:
  · 접속사 자체에 ann: {t:"and", role:"conj", rt:"", num:0}
  · 그 접속사가 잇는 **모든** 병렬 요소에 번호 ann: num = 1, 2, 3…
      {t:"influence", role:"num", rt:"", num:1}, {t:"invest", role:"num", rt:"", num:2}
    (그 요소가 색도 받을 만하면 role을 "num" 대신 "g"/"v"/"gv"로 주고 num만 붙인다.)
  · 상관접속사는 **두 짝을 모두** "conj"로 표시한다:
      both…and / either…or / neither…nor / not only…but (also) / not…but /
      between A and B — "both"와 "and" 각각에 conj ann.

▸ 놓치기 쉬운 병렬 — 이 목록을 한 항목씩 짚어 가며 지문을 훑어라:
  1. 3개 이상 나열: "A, B, and C" → 쉼표로 이어진 앞의 것들까지 전부 num 부여 (1,2,3).
  2. **절·문장 병렬**: "S+V …, and S+V …" — 절을 잇는 and/but/or도 반드시 표시.
  3. **동사구 병렬**: "can help develop and improve" — 조동사 뒤 원형 두 개.
  4. **to부정사 병렬에서 두 번째 to 생략**: "to grow and (to) survive".
  5. 전치사구·분사구·형용사·부사의 병렬: "in schools and in homes", "growing and spreading".
  6. 명사구 병렬: "hundreds of chemical reactions and processes".
  7. 문두의 But/And/Or (앞 문장과 잇는 경우)도 conj로 표시한다.
  8. 병렬 요소가 여러 chunk에 걸쳐 있어도 각 chunk의 anns에 각각 번호를 넣어 이어 붙인다.

▸ 제외(표시하지 않음): 굳어진 표현 안의 and/or/but —
  and so on / and so forth / as well as / all but / nothing but / anything but /
  but for / more or less / sooner or later. "yet"이 부사('아직·그런데도')인 경우도 제외.

▸ `t` 주의: 접속사 ann의 `t`는 반드시 **독립된 낱말**이어야 한다. "expanded" 속의 "and",
  "memory" 속의 "or"처럼 단어 일부를 `t`로 주면 그 ann은 버려지고 진짜 접속사는 표시되지
  않는다. 접속사 하나에 ann 하나씩, 앞뒤가 공백/구두점인 자리만 고른다.

### GRAMMAR COVERAGE (role "g") — do NOT omit
Find and mark ALL notable grammar structures with a "g" ann. Scan for every occurrence of:
  - 시제·상·태: 수동태(be+p.p.), 완료(have+p.p.), 진행(be+~ing) 등
  - 준동사: to부정사(명사적/형용사적/부사적), 동명사, 분사, 분사구문
  - 관계사: who/whom/whose/which/that, where/when/why/how(관계부사), 계속적 용법
  - 접속사: that(명사절), whether/if(명사절), 부사절(although/because/while/if/unless/so that…)
  - 특수구문: 가정법, 도치, it~that 강조, 가주어/진주어, 부분/전체 부정, 비교급·최상급, 생략
  - 목적격보어(원형/현재분사/과거분사), 사역·지각동사
분명한 문법 포인트는 빠뜨리지 말고 표시하라. 매칭할 `t`는 반드시 `text` 안의 실제 문자열이어야 한다.

### VOCABULARY COVERAGE (role "v"/"gv") — do NOT omit, 문장당 평균 1~3개 목표
Grammar만큼 어휘도 빠짐없이 스캔하라. 한 문장을 다 훑었는데 표시된 "g"를 빼고 아무 "v"/"gv"도
없다면 대개 누락이다. 아래 기준에 해당하는 단어/표현을 찾아 반드시 "v"(단어) 또는 "gv"(2단어
이상 고정표현)로 표시하라:
  - 고1~고3 학생 기준으로 뜻을 모르면 해석이 막히는 중·고난도 단어 (예: derogatory, compelling)
  - 다의어가 이 문맥에서 특정한 뜻으로 쓰인 경우 (예: address = "다루다", not "주소")
  - 문맥상 핵심 개념어 — 주제·요지와 직결되는 명사/동사/형용사
  - 비유·함축적 표현 (밑줄 함축의미 문제의 소재가 될 만한 것)
  - 숙어·구동사·전치사구 관용표현 (2단어 이상 → "gv": give rise to, account for, at odds with)
  - 유의어/반의어 함정이 있어 어휘 선택형(문맥상 낱말 쓰임 적절성) 문제로 낼 만한 단어
이미 "g"로 표시한 단어(관계사·전치사·조동사 등 순수 문법 기능어)는 "v"로 중복 표시하지 말고,
내용어(content word)의 "뜻"이 핵심일 때만 "v"를 붙인다. 쉬운 단어(the, is, very, good 등)까지
전부 태그하지 말 것 — 문맥상 학습 가치가 있는 단어만 고른다.

### FINAL SELF-CHECK (mandatory, before returning)
1. ENGLISH: mentally read all chunks' `text` in order — they MUST reconstruct the WHOLE
   passage with no words missing.
2. `t` 정확성: every ann's `t` must be an exact substring of its chunk's `text` (아니면 무시됨).
3. GRAMMAR COVERAGE: every grammar point in the coverage list has a "g" ann.
4. VOCAB COVERAGE: re-read each sentence — any content word/expression that would block
   comprehension if unknown, or that fits the vocabulary-coverage criteria above, has a
   "v" or "gv" ann. A sentence with a "g" ann but zero "v"/"gv" is suspicious — double-check it.
5. 등위접속사 COUNT (숫자로 대조하라 — 눈으로 훑지 말 것):
   (a) 지문 전체에서 낱말 "and / or / but / nor"가 몇 번 나오는지 센다 → N
   (b) 굳어진 표현(and so on, as well as, all but …) 안에 든 것을 뺀다 → N'
   (c) 내가 만든 "conj" ann의 개수를 센다 → M
   (d) M < N' 이면 반드시 누락이다. 어느 것을 빠뜨렸는지 찾아 conj ann과 번호를 추가한 뒤
       다시 세어 M = N' 이 될 때까지 반복한다. 상관접속사(both…and 등)는 짝마다 1개씩 센다.
6. 병렬 번호: 모든 "conj" ann에는 그것이 잇는 요소들의 num ann이 최소 2개 딸려 있어야 한다.
   conj만 있고 번호가 없으면 미완성이다.
Only return JSON after all six checks.

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


# 종결부호 뒤에 닫는 따옴표·괄호가 붙는 경우까지 문장 끝으로 인정한다.
#   예: He said, "Go home." Then he left.
_SENT_END_RE = re.compile(
    r'[.!?]+["\'”’)\]]?(?=\s+["\'“‘(\[]?[A-Z]|\s*$)'
)
# 마침표가 문장 끝이 아닌 약어들 — 이걸 걸러내지 않으면 'Dr. Smith'가 한 문장으로 잘려
# 문장 수가 부풀고, 서버가 "AI가 문장을 빠뜨렸다"고 오판해 불필요한 재요청을 건다.
_ABBR_RE = re.compile(
    r"\b(Mr|Mrs|Ms|Dr|Prof|Sr|Jr|St|Mt|Ave|Rd|No|Fig|Inc|Ltd|Co|vs|etc|approx)\.",
    re.IGNORECASE,
)
_INITIAL_RE = re.compile(r"\b([A-Z])\.")   # J. K. Rowling, U.S., e.g. 의 낱글자


def rough_sentence_count(passage):
    """지문의 문장 수를 센다. 소수점·약어·이니셜의 마침표는 문장 끝으로 세지 않는다."""
    text = passage.strip()
    text = re.sub(r"\d\.\d", "00", text)      # 3.14 같은 소수점
    text = _ABBR_RE.sub(r"\1@", text)         # Mr. Dr. etc.
    text = _INITIAL_RE.sub(r"\1@", text)      # U.S. / J. K.
    return max(len(_SENT_END_RE.findall(text)), 1)


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


# 줄바꿈 금지를 붙일 최대 길이. 이보다 긴 대상은 그냥 접히게 둔다 —
# 좁은 화면에서 한 줄로 붙들면 카드 밖으로 삐져나가는 쪽이 더 나쁘기 때문.
_NOBREAK_MAX = 28


def _nobreak(word):
    """루비/형광 표시가 줄 끝에서 쪼개지지 않게 할지. 짧은 대상에만 적용한다.
    브라우저는 ruby의 본문이 두 줄로 나뉘면 위의 한글 설명까지 잘라서 나눠 붙인다
    ('For example,' + '예시' → 'For'에 '예', 'example,'에 '시'). 실제로 나던 오류."""
    return len(word) <= _NOBREAK_MAX and word.count(" ") <= 4


def _wrap_ann(word, a):
    """평문 영어 조각 word 에 역할(role)에 맞는 루비/색상/병렬번호를 입힌다."""
    role = (a.get("role") or "g").strip()
    rt = _esc_html((a.get("rt") or "").strip())
    w = _esc_html(word)
    num = a.get("num")
    numhtml = ""
    if isinstance(num, (int, float)) and int(num) > 0:
        numhtml = f'<sup class="conj-num-top">{int(num)}</sup>'
    nb = " nobreak" if _nobreak(word) else ""
    if role == "conj":
        return numhtml + f'<span class="conj-hl{nb}">{w}</span>'
    if role in _ROLE_RUBY:
        return (numhtml + f'<ruby class="{_ROLE_RUBY[role]}{nb}">'
                f'<span class="{role}">{w}</span><rt>{rt}</rt></ruby>')
    return numhtml + w  # role "num" 등: 번호만, 색 없음


_WORD_CH_RE = re.compile(r"[0-9A-Za-z]")


def _is_word_ch(c):
    return bool(c) and bool(_WORD_CH_RE.match(c))


def _find_ann(text, t, used):
    """text에서 주석 대상 t의 위치를 찾는다. 이미 다른 주석이 차지한 구간(used)은 건너뛴다.

    t가 낱말 문자로 시작/끝나면 그쪽은 반드시 낱말 경계여야 한다.
    이 검사가 없으면 등위접속사 'and'가 'exp|and|ed'의 한가운데에, 'or'가
    'mem|or|y' 한가운데에 걸려 단어가 쪼개진 채 표시된다(실제로 나던 오류).
    구두점으로 시작/끝나는 대상(",", "(" 등)에는 경계 조건을 걸지 않는다."""
    need_left = _is_word_ch(t[:1])
    need_right = _is_word_ch(t[-1:])
    idx = text.find(t)
    while idx != -1:
        end = idx + len(t)
        if (
            not any(used[idx:end])
            and not (need_left and idx > 0 and _is_word_ch(text[idx - 1]))
            and not (need_right and end < len(text) and _is_word_ch(text[end]))
        ):
            return idx
        idx = text.find(t, idx + 1)
    return -1


def _ann_spans(text, anns):
    """주석 목록을 text 위의 (시작, 끝, 주석) 구간으로 확정한다.
    앞선 주석이 차지한 자리는 뒤 주석이 다시 쓰지 못한다(겹침 방지).
    조립(assemble_eng)과 누락 검사(unmarked_conjunctions)가 같은 결과를 보도록 공유한다."""
    used = [False] * len(text)
    spans = []
    for a in anns or []:
        if not isinstance(a, dict):
            continue
        t = a.get("t") or ""
        if not t:
            continue
        idx = _find_ann(text, t, used)
        if idx == -1:
            continue
        for i in range(idx, idx + len(t)):
            used[i] = True
        spans.append((idx, idx + len(t), a))
    spans.sort()
    return spans


def assemble_eng(text, anns):
    """모델이 준 평문 영어(text) 위에, 주석 목록(anns)의 대상 문자열을 찾아
    색상/루비/병렬번호를 겹쳐 최종 영어 HTML을 만든다. 매칭 안 되는 주석은 무시하되
    영어 원문은 항상 그대로 보존된다."""
    text = text or ""
    if not text:
        return ""
    spans = _ann_spans(text, anns)
    out = []
    pos = 0
    for st, en, a in spans:
        out.append(_esc_html(text[pos:st]))
        out.append(_wrap_ann(text[st:en], a))
        pos = en
    out.append(_esc_html(text[pos:]))
    return "".join(out)


# 등위접속사 후보. 'yet'은 부사('아직/그런데도')로 쓰이는 일이 훨씬 잦아 오탐이 많으므로
# 기계 검사에서는 뺀다 — 프롬프트에서는 여전히 표시 대상이다.
_COORD_RE = re.compile(r"\b(and|or|but|nor)\b", re.I)
# 접속사가 아니라 굳어진 표현의 일부라 병렬로 보지 않는 것들
_COORD_SKIP = re.compile(
    r"\b(?:and so on|and so forth|as well as|all but|nothing but|anything but|"
    r"no one but|none but|but for|or so|more or less|sooner or later)\b", re.I
)


# 상관접속사의 '앞짝'. 뒤짝(and/or/nor/but)이 같은 chunk 뒤쪽에 실제로 있을 때만
# 후보로 본다 — "both of them"처럼 짝 없이 쓰인 경우를 걸러내기 위해서다.
_CORRELATIVES = [
    (re.compile(r"\bboth\b", re.I), re.compile(r"\band\b", re.I)),
    (re.compile(r"\beither\b", re.I), re.compile(r"\bor\b", re.I)),
    (re.compile(r"\bneither\b", re.I), re.compile(r"\bnor\b", re.I)),
    (re.compile(r"\bnot only\b", re.I), re.compile(r"\bbut\b", re.I)),
]


def unmarked_conjunctions(result, limit=10):
    """chunk의 평문 text에서 등위접속사를 찾아, "conj" 주석이 안 붙은 것을 모은다.

    모델이 가장 자주 빠뜨리는 부분이라 성실성에만 맡기지 않고 기계로 한 번 더 센다.
    반환값은 재요청 프롬프트에 그대로 넣을 수 있는 문자열 목록
    (예: '3번 문장: "…can help develop and improve…"').
    굳어진 표현(and so on 등)은 후보에서 뺀다."""
    out = []
    for s in result.get("sentences", []) or []:
        if not isinstance(s, dict):
            continue
        no = s.get("no")
        for c in s.get("chunks", []) or []:
            if not isinstance(c, dict):
                continue
            text = _TAG_STRIP_RE.sub("", c.get("text", "") or "")
            if not text:
                continue
            spans = _ann_spans(text, c.get("anns", []))
            marked = [
                (st, en) for st, en, a in spans
                if (a.get("role") or "").strip() == "conj"
            ]
            skip = [m.span() for m in _COORD_SKIP.finditer(text)]

            def report(m, note=""):
                st, en = m.span()
                if any(a <= st and en <= b for a, b in marked):
                    return False      # 이미 표시됨
                if any(a <= st and en <= b for a, b in skip):
                    return False      # 굳어진 표현
                lo, hi = max(0, st - 30), min(len(text), en + 30)
                out.append(
                    f'{no}번 문장의 "{m.group(0)}"{note} — …{text[lo:hi].strip()}…'
                )
                return True

            for m in _COORD_RE.finditer(text):
                report(m)
                if len(out) >= limit:
                    return out
            # 상관접속사 앞짝(both/either/neither/not only)도 conj 표시 대상이다.
            # 뒤짝이 실제로 뒤따를 때만 짚어 "both of them" 같은 경우를 걸러낸다.
            for head_re, tail_re in _CORRELATIVES:
                for m in head_re.finditer(text):
                    if not tail_re.search(text, m.end()):
                        continue
                    report(m, "(상관접속사 앞짝)")
                    if len(out) >= limit:
                        return out
    return out


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


def build_user_prompt(passage, target_grammar, mode, prior=None, complete_hint=None,
                      english_fix=False, conj_hint=None):
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
    if conj_hint:
        # 기계 검사가 짚어 준 자리 — 어림짐작이 아니라 '여기'를 다시 보게 한다
        lines.append(
            "⚠️ 이전 시도에서 아래 등위접속사에 \"conj\" 표시가 빠졌습니다. "
            "각 자리를 다시 보고, 병렬을 잇는 접속사라면 conj ann과 병렬 요소 번호(num)를 "
            "추가하세요. 굳어진 표현이거나 정말 병렬이 아니라면 그대로 두세요. "
            "이미 올바른 표시는 절대 지우지 마세요."
        )
        for h in conj_hint:
            lines.append("  · " + h)
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
        # 서버 내부용 키(_로 시작)는 빼고 보낸다 — 모델이 스키마에 없는 필드를
        # 따라 만들거나 혼란스러워하지 않도록.
        lines.append(json.dumps(
            {k: v for k, v in prior.items() if not str(k).startswith("_")},
            ensure_ascii=False,
        ))
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
            body = json.loads(resp.read().decode("utf-8"))
        return body

    def _generate(use_model):
        is_flash = "flash" in (use_model or "").lower()
        attempt = 0
        waited = 0.0
        quota_tries = 0   # 429 재시도는 따로 세어 짧게 끊는다
        while True:
            try:
                return _post(use_model)
            except urllib.error.HTTPError as e:
                retryable = e.code in (500, 502, 503, 504) or (e.code == 429 and is_flash)
                if not retryable:
                    raise  # 비-flash 429·인증/모델 오류 등은 바깥에서 처리(본문 미소비)
                is_quota = e.code == 429
                if is_quota:
                    # 구글이 알려준 권장 대기시간으로 '분당 한도'와 '일일 한도 소진'을 가른다.
                    # 짧으면 잠깐 뒤 풀리므로 기다릴 값어치가 있고, 길거나 없으면 오늘은
                    # 안 풀리므로 즉시 포기한다(기다려 봐야 할당량만 더 태운다).
                    hint = _parse_retry_delay(e.read().decode("utf-8", "replace"))
                    quota_tries += 1
                    if (
                        hint is None
                        or hint > QUOTA_RETRY_MAX_WAIT
                        or quota_tries > QUOTA_MAX_RETRIES
                    ):
                        raise QuotaExceeded(QUOTA_MESSAGE)
                    wait = max(min(hint + 1, RETRY_MAX_WAIT), RETRY_MIN_WAIT)
                    if waited + wait > MAX_RETRY_TOTAL:
                        raise QuotaExceeded(QUOTA_MESSAGE)
                else:
                    wait = min(RETRY_MIN_WAIT * (2 ** attempt), RETRY_MAX_WAIT)  # 3,6,12,24,48,60…
                    wait = max(wait, RETRY_MIN_WAIT)
                    if waited + wait > MAX_RETRY_TOTAL:
                        raise RuntimeError(
                            "서버가 계속 응답하지 않습니다(과부하). 잠시 뒤 다시 시도하세요."
                        )
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
        # Pro 등 비-Flash 모델이 429 → 조용히 바꾸지 않고, 사용자에게 분명히 알린다.
        # (무료 등급 키는 Pro 할당량이 0이라 즉시 거부된다)
        if e.code == 429 and "flash" not in (model or "").lower():
            free_tier = "free_tier" in low or "limit: 0" in low
            if free_tier:
                raise ProUnavailable(
                    f"이 API 키로는 Pro 모델({model})을 사용할 수 없습니다. "
                    "Pro는 결제(billing)가 설정된 키에서만 동작합니다. "
                    "위 '모델' 목록에서 Flash 모델을 선택한 뒤 다시 실행해 주세요."
                )
            raise ProUnavailable(
                f"Pro 모델({model})의 사용 한도를 초과했습니다. "
                "잠시 후 다시 시도하거나, 위 '모델' 목록에서 Flash 모델을 선택해 주세요."
            )
        # 모델 자체가 없어졌거나 지원 종료된 경우에만 사용 가능한 모델로 자동 대체
        if model_gone:
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
                    "모델 목록에서 다른 모델을 골라 다시 시도하세요."
                )
            try:
                return _generate(alt)
            except urllib.error.HTTPError as e2:
                raise RuntimeError(f"Gemini API 오류 {e2.code}: {_err_msg(e2)}")
        if e.code in (400, 403) and "API" in msg.upper():
            raise RuntimeError(f"API 키 오류로 보입니다 ({e.code}): {msg}")
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
    if finish == "RECITATION":
        # 지문 내용이 부적절해서가 아니라, '원문을 그대로 재현한다'는 점이 걸린 것이다.
        # 호출부가 표본을 달리해 다시 시도할 수 있도록 별도 예외로 올린다.
        raise Recitation(
            "이 지문은 이미 널리 공개된 글이라 원문 그대로 옮기는 것이 차단되었습니다"
            "(RECITATION). 다시 시도하거나, 지문을 나눠 찍어 올리거나, 직접 붙여넣어 주세요."
        )
    if finish in ("SAFETY", "PROHIBITED_CONTENT"):
        raise RuntimeError(
            f"안전 필터에 걸려 응답이 차단되었습니다({finish}). 지문에 민감한 표현이 "
            "있는지 확인하거나, 문단을 나눠 다시 시도하세요."
        )

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


def _gemini_json(payload, api_key, model, trunc_msg):
    """페이로드를 보내고 JSON 결과를 받는다 (모든 Gemini 호출의 공통 입구).

    RECITATION으로 막히면 표본추출 설정을 바꿔 다시 시도한다. 이 차단은 '가장 그럴듯한
    다음 토큰'만 고르는 결정적 디코딩에서 특히 잘 나는데, 그렇게 뽑은 문장이 학습 데이터에
    있는 원문과 글자 단위로 일치해 버리기 때문이다. 온도를 올려 표본을 흔들면 같은 내용을
    담으면서도 차단을 피해 가는 경우가 많다.
    (safetySettings로는 끌 수 없다 — RECITATION은 유해성 분류가 아니라 별도 검사다)"""
    attempts = (None, 0.4, 0.85)
    last = None
    for temp in attempts:
        if temp is not None:
            payload.setdefault("generationConfig", {})["temperature"] = temp
        data = json.dumps(payload).encode("utf-8")
        body = _gemini_call_with_retry(data, api_key, model)
        try:
            return _extract_gemini_json(body, trunc_msg)
        except Recitation as e:
            last = e
            continue
    raise last


_ANALYZE_TRUNC_MSG = (
    "출력이 최대 길이에 도달해 분석이 잘렸습니다. 이 지문이 너무 길어서 그렇습니다. "
    "지문을 두세 문단으로 나눠 각각 따로 분석하세요."
)


def call_gemini(passage, target_grammar, mode, api_key, model, prior=None, complete_hint=None,
                english_fix=False, conj_hint=None):
    api_key = (api_key or "").strip() or os.environ.get("GEMINI_API_KEY", "").strip()
    if not api_key:
        raise RuntimeError(
            "관리자가 아직 서버에 Gemini API 키(GEMINI_API_KEY)를 설정하지 않았습니다. "
            "관리자에게 문의하세요."
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
                "parts": [{"text": build_user_prompt(passage, target_grammar, mode, prior,
                                                     complete_hint, english_fix, conj_hint)}],
            }
        ],
        "generationConfig": {
            "temperature": 0.2,
            "maxOutputTokens": 65536,
            "responseMimeType": "application/json",
            "responseSchema": GEMINI_SCHEMA,
        },
    }
    result = _gemini_json(payload, api_key, model, _ANALYZE_TRUNC_MSG)
    # 등위접속사 누락 검사는 조립 '전'에 해야 한다 — 아래 루프가 anns를 버리기 때문.
    # 결과는 비공개 키로 얹어 두고, 핸들러가 재요청 판단에 쓴 뒤 응답 전에 지운다.
    missed = unmarked_conjunctions(result)
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
    result["_conjMiss"] = missed
    return result


def list_models(api_key):
    """해당 키로 generateContent가 가능한 gemini 모델 목록을 반환."""
    api_key = (api_key or "").strip() or os.environ.get("GEMINI_API_KEY", "").strip()
    if not api_key:
        raise RuntimeError("관리자가 아직 서버에 Gemini API 키(GEMINI_API_KEY)를 설정하지 않았습니다.")
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
        # Flash·Pro 모두 노출한다. (Pro는 결제된 키에서만 동작하며, 무료 키로 고르면
        #  분석 시 "이 키로는 Pro를 쓸 수 없다"는 안내가 뜨도록 처리한다.)
        is_pro = "pro" in low
        if "flash" not in low and not is_pro:
            continue
        # Flash-Lite 제외 (분석 품질 우선 — 누락이 많아 사용 안 함)
        if "lite" in low:
            continue
        # 별칭(-latest)·실험 버전은 늘 제외 — 별칭은 실제 모델과 할당량을 공유해 사용량
        # 집계만 흐리고, 실험판은 품질이 들쭉날쭉하다.
        if mid.endswith("-latest") or "-exp" in low:
            continue
        # 프리뷰 제외 — 단, Pro는 이 글을 쓰는 시점에 정식(GA) 버전이 없어 프리뷰
        # (gemini-3.1-pro-preview 등)가 유일한 통로다. Flash는 항상 안정판이 있으므로
        # 프리뷰를 걸러 품질 들쭉날쭉함을 피한다. Pro가 GA로 나오면 프리뷰 없이도
        # 이 조건을 통과하고, rank()가 GA를 프리뷰보다 우선하도록 해 뒀다.
        if "preview" in low and not is_pro:
            continue
        # 구버전 제외. Pro와 Flash는 버전 번호를 독립적으로 매겨(현재 Flash 3.6대,
        # Pro는 3.1대) 하나의 하한을 같이 쓰면 Pro가 걸러지므로 하한을 따로 둔다.
        vm = re.search(r"gemini-(\d+(?:\.\d+)?)", low)
        floor = 3.0 if is_pro else 3.5
        if not vm or float(vm.group(1)) < floor:
            continue
        models.append({"id": mid, "label": m.get("displayName", mid)})
    # 최신순 정렬 후 상위 5개만 반환
    # (-latest 별칭 > 버전 숫자 내림차순 > GA가 프리뷰보다 우선)
    def rank(m):
        mid = m["id"].lower()
        is_latest = 1 if mid.endswith("-latest") else 0
        is_ga = 0 if "preview" in mid else 1
        vm = re.search(r"gemini-(\d+(?:\.\d+)?)", mid)
        ver = float(vm.group(1)) if vm else 0.0
        return (is_latest, ver, is_ga, mid)

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


# --- 저장/불러오기: 구글 로그인 검증 + Firestore 읽고쓰기 ---------------------

def _now_iso():
    return datetime.now(timezone.utc).isoformat()


def _require_db():
    if DB is None:
        raise RuntimeError(
            "로그인/저장 기능이 아직 설정되지 않았습니다 (관리자에게 문의하세요)."
        )


def verify_google_id_token(credential):
    """구글이 이미 서명을 검증한 결과를 그대로 받아온다 — 우리가 JWT 서명 검증
    라이브러리를 따로 둘 필요가 없다. aud(발급 대상)가 우리 클라이언트 ID인지만
    서버에서 추가로 확인한다."""
    url = "https://oauth2.googleapis.com/tokeninfo?id_token=" + urllib.parse.quote(credential)
    try:
        with urllib.request.urlopen(url, timeout=10) as resp:
            claims = json.loads(resp.read().decode("utf-8"))
    except urllib.error.HTTPError:
        raise ValueError("구글 로그인 확인에 실패했습니다. 다시 시도하세요.")
    if not GOOGLE_CLIENT_ID or claims.get("aud") != GOOGLE_CLIENT_ID:
        raise ValueError("이 사이트용으로 발급된 로그인 정보가 아닙니다.")
    return claims


def upsert_user(sub, email, name):
    _require_db()
    ref = DB.collection("users").document(sub)
    if not ref.get().exists:
        ref.set({"email": email, "name": name, "created_at": _now_iso()})
    else:
        ref.set({"email": email, "name": name}, merge=True)


def create_session(sub):
    _require_db()
    token = secrets.token_urlsafe(32)
    expires = datetime.now(timezone.utc) + timedelta(seconds=SESSION_MAX_AGE)
    DB.collection("sessions").document(token).set({
        "user_id": sub,
        "created_at": _now_iso(),
        "expires_at": expires.isoformat(),
    })
    return token


def delete_session(token):
    if DB is None or not token:
        return
    DB.collection("sessions").document(token).delete()


def _parse_cookies(header):
    cookies = {}
    for part in (header or "").split(";"):
        if "=" in part:
            k, v = part.strip().split("=", 1)
            cookies[k] = v
    return cookies


def _session_user(handler):
    """세션 쿠키로 로그인한 사용자(구글 sub)를 찾는다. 없거나 만료됐으면 None."""
    if DB is None:
        return None
    token = _parse_cookies(handler.headers.get("Cookie", "")).get("session")
    if not token:
        return None
    ref = DB.collection("sessions").document(token)
    snap = ref.get()
    if not snap.exists:
        return None
    sess = snap.to_dict()
    try:
        expires = datetime.fromisoformat(sess["expires_at"])
    except Exception:
        return None
    if datetime.now(timezone.utc) >= expires:
        ref.delete()
        return None
    return sess.get("user_id")


def list_saved_items(user_id):
    _require_db()
    q = (
        DB.collection("saved_items")
        .where("user_id", "==", user_id)
        .order_by("updated_at", direction=firestore.Query.DESCENDING)
    )
    return [
        {
            "id": doc.id,
            "tab": doc.get("tab"),
            "title": doc.get("title"),
            "updated_at": doc.get("updated_at"),
        }
        for doc in q.stream()
    ]


def get_saved_item(item_id, user_id):
    _require_db()
    snap = DB.collection("saved_items").document(item_id).get()
    if not snap.exists:
        return None
    d = snap.to_dict()
    if d.get("user_id") != user_id:
        return None
    return d


def save_item(item_id, user_id, tab, title, payload):
    """item_id가 있으면 그 항목을 덮어쓰고(소유자 확인), 없으면 새로 만든다."""
    _require_db()
    now = _now_iso()
    if item_id:
        ref = DB.collection("saved_items").document(item_id)
        snap = ref.get()
        if not snap.exists or snap.to_dict().get("user_id") != user_id:
            raise PermissionError("저장 항목을 찾을 수 없습니다.")
        ref.set({"tab": tab, "title": title, "payload": payload, "updated_at": now}, merge=True)
        return item_id
    ref = DB.collection("saved_items").document()
    ref.set({
        "user_id": user_id, "tab": tab, "title": title, "payload": payload,
        "created_at": now, "updated_at": now,
    })
    return ref.id


def delete_saved_item(item_id, user_id):
    _require_db()
    ref = DB.collection("saved_items").document(item_id)
    snap = ref.get()
    if not snap.exists or snap.to_dict().get("user_id") != user_id:
        return False
    ref.delete()
    return True


class Handler(BaseHTTPRequestHandler):
    server_version = "PassageAnalyzer/1.0"

    def log_message(self, fmt, *args):
        sys.stderr.write("%s - %s\n" % (self.address_string(), fmt % args))

    def _send_json(self, obj, status=200, cookies=None):
        data = json.dumps(obj, ensure_ascii=False).encode("utf-8")
        self.send_response(status)
        self.send_header("content-type", "application/json; charset=utf-8")
        self.send_header("content-length", str(len(data)))
        for c in cookies or ():
            self.send_header("Set-Cookie", c)
        self.end_headers()
        self.wfile.write(data)

    def _session_cookie(self, token, max_age):
        # Render 등 https 뒤에 있을 때만 Secure를 붙인다(로컬 http에서도 로그인이 되게).
        secure = "; Secure" if self.headers.get("X-Forwarded-Proto") == "https" else ""
        return f"session={token}; Path=/; HttpOnly; SameSite=Lax; Max-Age={max_age}{secure}"

    def _cleared_session_cookie(self):
        secure = "; Secure" if self.headers.get("X-Forwarded-Proto") == "https" else ""
        return f"session=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0{secure}"

    def do_GET(self):
        """/api/*는 Firestore를 호출하므로, do_POST처럼 예상 못 한 예외에도
        연결을 끊지 않고 JSON 오류로 답한다(정적 파일 서빙은 예외가 날 일이 거의
        없지만 같은 안전망을 함께 태워도 손해가 없다)."""
        try:
            self._handle_get()
        except Exception as e:
            traceback.print_exc()
            try:
                self._send_json({"error": f"서버 내부 오류입니다: {e}"}, 500)
            except Exception:
                pass

    def _handle_get(self):
        path = self.path.split("?", 1)[0]

        if path == "/api/me":
            user_id = _session_user(self)
            if not user_id:
                self._send_json({"loggedIn": False})
                return
            info = (DB.collection("users").document(user_id).get().to_dict() or {})
            self._send_json({"loggedIn": True, "email": info.get("email"), "name": info.get("name")})
            return

        if path == "/api/saved":
            user_id = _session_user(self)
            if not user_id:
                self._send_json({"error": "로그인이 필요합니다."}, 401)
                return
            try:
                self._send_json({"items": list_saved_items(user_id)})
            except Exception as e:
                self._send_json({"error": str(e)}, 500)
            return

        if path.startswith("/api/saved/"):
            user_id = _session_user(self)
            if not user_id:
                self._send_json({"error": "로그인이 필요합니다."}, 401)
                return
            item_id = path[len("/api/saved/"):]
            try:
                item = get_saved_item(item_id, user_id)
            except Exception as e:
                self._send_json({"error": str(e)}, 500)
                return
            if not item:
                self._send_json({"error": "저장한 항목을 찾을 수 없습니다."}, 404)
                return
            self._send_json({
                "id": item_id,
                "tab": item.get("tab"),
                "title": item.get("title"),
                "payload": item.get("payload"),
                "updated_at": item.get("updated_at"),
            })
            return

        if path == "/":
            path = "/index.html"
        target = (PUBLIC_DIR / path.lstrip("/")).resolve()
        if not str(target).startswith(str(PUBLIC_DIR.resolve())) or not target.is_file():
            self.send_error(404, "Not found")
            return
        ctype = CONTENT_TYPES.get(target.suffix, "application/octet-stream")
        body = target.read_bytes()
        if target.name == "index.html":
            # 클라이언트 ID는 비밀값이 아니라 화면(구글 로그인 버튼)에 그대로 넣어도 된다.
            body = body.replace(b"%%GOOGLE_CLIENT_ID%%", GOOGLE_CLIENT_ID.encode("utf-8"))
        self.send_response(200)
        self.send_header("content-type", ctype)
        self.send_header("content-length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    # 너무 큰 본문을 '읽어서 버리는' 한 조각 크기와, 그마저 포기하는 한계.
    # 한계를 넘으면 안내를 포기하고 끊는다(악의적 요청에 계속 읽어 줄 이유는 없다).
    _DRAIN_CHUNK = 64 * 1024
    _DRAIN_LIMIT = 128 * 1024 * 1024

    def _drain(self, length):
        """요청 본문을 조각내어 읽고 버린다 (메모리에 쌓지 않는다)."""
        if length > self._DRAIN_LIMIT:
            return
        left = length
        while left > 0:
            chunk = self.rfile.read(min(self._DRAIN_CHUNK, left))
            if not chunk:
                break
            left -= len(chunk)

    def do_POST(self):
        """예상 못 한 예외가 나도 연결을 끊지 않고 JSON 오류로 답한다.
        여기서 터지면 화면은 'JSON 대신 HTML' 같은 엉뚱한 메시지밖에 볼 수 없어
        원인을 찾기가 매우 어렵다(실제로 그런 사고가 있었다)."""
        try:
            self._handle_post()
        except Exception as e:
            traceback.print_exc()
            try:
                self._send_json({"error": f"서버 내부 오류입니다: {e}"}, 500)
            except Exception:
                pass

    def _handle_post(self):
        path = self.path.split("?", 1)[0]
        if path not in ("/api/analyze", "/api/models", "/api/quiz", "/api/workbook",
                        "/api/reword", "/api/ocr",
                        "/api/auth/google", "/api/auth/signup", "/api/auth/verify",
                        "/api/auth/login", "/api/logout", "/api/saved", "/api/saved/delete"):
            self.send_error(404, "Not found")
            return
        try:
            length = int(self.headers.get("content-length", "0"))
            # 본문을 통째로 메모리에 올리므로 상한이 없으면 큰 사진 몇 장에
            # 인스턴스가 죽는다(Render 무료 512MB). 읽기 '전에' 막는다.
            if length > MAX_BODY_BYTES:
                # 응답만 보내고 끊으면 클라이언트는 아직 본문을 보내는 중이라
                # 응답을 읽지 못하고 연결 오류만 본다. 본문을 조각내어 버리며 끝까지
                # 받아 준 뒤에 413을 보내야 안내 문구가 실제로 도달한다.
                # (버리기만 하므로 메모리는 조각 크기만 쓴다)
                self._drain(length)
                self._send_json({
                    "error": f"보낸 자료가 너무 큽니다 "
                             f"({length / 1048576:.1f}MB / 최대 {MAX_BODY_BYTES // 1048576}MB). "
                             "사진 수를 줄이거나 더 작은 파일로 다시 시도하세요."
                }, 413)
                return
            raw = self.rfile.read(length) if length else b"{}"
            req = json.loads(raw.decode("utf-8"))
        except (ValueError, json.JSONDecodeError):
            self._send_json({"error": "잘못된 요청입니다."}, 400)
            return

        # AI를 실제로 호출하는 엔드포인트는 전부 로그인이 있어야 쓸 수 있다 —
        # 이제 사용자가 자기 Gemini 키를 내지 않고 관리자 키 하나를 같이 쓰므로,
        # 로그인이 곧 '누가 관리자 키를 쓰는지' 구분하는 유일한 장치다.
        if path in ("/api/analyze", "/api/models", "/api/quiz",
                    "/api/workbook", "/api/reword", "/api/ocr"):
            if DB is None:
                self._send_json(
                    {"error": "로그인 기능이 아직 설정되지 않았습니다 (관리자에게 문의하세요)."}, 503
                )
                return
            if not _session_user(self):
                self._send_json({"error": "로그인이 필요한 서비스입니다."}, 401)
                return

        if path == "/api/auth/google":
            credential = req.get("credential") or ""
            if not credential:
                self._send_json({"error": "구글 로그인 정보가 없습니다."}, 400)
                return
            try:
                claims = verify_google_id_token(credential)
                sub = claims["sub"]
                upsert_user(sub, claims.get("email", ""), claims.get("name", ""))
                token = create_session(sub)
            except ValueError as e:
                self._send_json({"error": str(e)}, 401)
                return
            except Exception as e:
                self._send_json({"error": f"로그인에 실패했습니다: {e}"}, 500)
                return
            self._send_json(
                {"loggedIn": True, "email": claims.get("email"), "name": claims.get("name")},
                cookies=[self._session_cookie(token, SESSION_MAX_AGE)],
            )
            return

        if path == "/api/auth/signup":
            email = (req.get("email") or "").strip()
            password = req.get("password") or ""
            name = (req.get("name") or "").strip()
            try:
                start_signup(email, password, name)
            except ValueError as e:
                self._send_json({"error": str(e)}, 400)
                return
            except Exception as e:
                self._send_json({"error": f"회원가입에 실패했습니다: {e}"}, 500)
                return
            self._send_json({"sent": True})
            return

        if path == "/api/auth/verify":
            email = (req.get("email") or "").strip()
            code = (req.get("code") or "").strip()
            if not email or not code:
                self._send_json({"error": "이메일과 인증코드를 입력하세요."}, 400)
                return
            try:
                user_id = complete_signup(email, code)
                token = create_session(user_id)
            except ValueError as e:
                self._send_json({"error": str(e)}, 400)
                return
            except Exception as e:
                self._send_json({"error": f"인증에 실패했습니다: {e}"}, 500)
                return
            info = DB.collection("users").document(user_id).get().to_dict() or {}
            self._send_json(
                {"loggedIn": True, "email": info.get("email"), "name": info.get("name")},
                cookies=[self._session_cookie(token, SESSION_MAX_AGE)],
            )
            return

        if path == "/api/auth/login":
            email = (req.get("email") or "").strip()
            password = req.get("password") or ""
            if not email or not password:
                self._send_json({"error": "이메일과 비밀번호를 입력하세요."}, 400)
                return
            try:
                user_id, info = login_with_password(email, password)
                token = create_session(user_id)
            except ValueError as e:
                self._send_json({"error": str(e)}, 401)
                return
            except Exception as e:
                self._send_json({"error": f"로그인에 실패했습니다: {e}"}, 500)
                return
            self._send_json(
                {"loggedIn": True, "email": info.get("email"), "name": info.get("name")},
                cookies=[self._session_cookie(token, SESSION_MAX_AGE)],
            )
            return

        if path == "/api/logout":
            token = _parse_cookies(self.headers.get("Cookie", "")).get("session")
            delete_session(token)
            self._send_json({"loggedIn": False}, cookies=[self._cleared_session_cookie()])
            return

        if path == "/api/saved":
            user_id = _session_user(self)
            if not user_id:
                self._send_json({"error": "로그인이 필요합니다."}, 401)
                return
            tab = (req.get("tab") or "").strip()
            title = (req.get("title") or "").strip() or "제목 없음"
            payload = req.get("payload")
            item_id = req.get("id") or None
            if not tab or payload is None:
                self._send_json({"error": "저장할 내용이 없습니다."}, 400)
                return
            try:
                new_id = save_item(item_id, user_id, tab, title, payload)
            except PermissionError as e:
                self._send_json({"error": str(e)}, 404)
                return
            except Exception as e:
                self._send_json({"error": f"저장에 실패했습니다: {e}"}, 500)
                return
            self._send_json({"id": new_id})
            return

        if path == "/api/saved/delete":
            user_id = _session_user(self)
            if not user_id:
                self._send_json({"error": "로그인이 필요합니다."}, 401)
                return
            item_id = req.get("id") or ""
            try:
                ok = delete_saved_item(item_id, user_id)
            except Exception as e:
                self._send_json({"error": str(e)}, 500)
                return
            if not ok:
                self._send_json({"error": "저장한 항목을 찾을 수 없습니다."}, 404)
                return
            self._send_json({"ok": True})
            return

        if path == "/api/models":
            try:
                self._send_json(list_models(req.get("apiKey") or ""))
            except ProUnavailable as e:
                self._send_json({"error": str(e), "code": "pro_unavailable"}, 429)
                return
            except QuotaExceeded as e:
                # 재시도해도 안 풀리는 한도 소진 — 화면이 남은 지문을 즉시 중단하도록
                # 기계가 알아볼 수 있는 code를 함께 내려준다
                self._send_json({"error": str(e), "code": "quota"}, 429)
                return
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
            except ProUnavailable as e:
                self._send_json({"error": str(e), "code": "pro_unavailable"}, 429)
                return
            except QuotaExceeded as e:
                # 재시도해도 안 풀리는 한도 소진 — 화면이 남은 지문을 즉시 중단하도록
                # 기계가 알아볼 수 있는 code를 함께 내려준다
                self._send_json({"error": str(e), "code": "quota"}, 429)
                return
            except Exception as e:
                self._send_json({"error": str(e)}, 502)
                return
            self._send_json(result)
            return

        # 지문 변형본을 먼저 확정하는 단계. 유형을 나눠 여러 번 문제를 만들어도
        # 모든 문항이 같은 지문을 쓰도록, 화면이 이 결과를 받아 이후 호출에 넘긴다.
        # 사진에서 지문 옮겨 적기. 사진 1장 = 지문 1개이므로 요청도 1장씩 온다.
        # 결과는 화면의 지문 입력칸에 채워지고, 실행은 사용자가 확인한 뒤 직접 누른다
        # (잘못 읽은 단어 하나가 분석·문제 전체를 오염시키므로 검토를 건너뛰지 않는다).
        if path == "/api/ocr":
            file = req.get("file")
            if not isinstance(file, dict):
                self._send_json({"error": "올릴 사진을 선택하세요."}, 400)
                return
            api_key = req.get("apiKey") or ""
            model = req.get("model") or MODEL
            partial = bool(req.get("partial"))
            try:
                self._send_json(call_gemini_ocr(file, api_key, model, partial))
            except Recitation as e:
                # 화면이 '사진을 조각내어 다시 시도'로 넘어갈 수 있게 식별자를 붙인다
                self._send_json({"error": str(e), "code": "recitation"}, 502)
            except NeedsPro as e:
                self._send_json({"error": str(e), "code": "needs_pro"}, 429)
            except ProUnavailable as e:
                self._send_json({"error": str(e), "code": "pro_unavailable"}, 429)
            except QuotaExceeded as e:
                self._send_json({"error": str(e), "code": "quota"}, 429)
            except Exception as e:
                self._send_json({"error": str(e)}, 502)
            return

        if path == "/api/reword":
            passage = (req.get("passage") or "").strip()
            if len(passage) < 20:
                self._send_json({"error": "변형할 영어 지문을 입력하세요 (20자 이상)."}, 400)
                return
            variation = req.get("variation") or "light"
            api_key = req.get("apiKey") or ""
            model = req.get("model") or MODEL
            try:
                reworded = call_gemini_reword(passage, variation, api_key, model)
                # 바뀐 낱말 목록을 함께 돌려준다 — 화면이 지문에서 그 낱말을 표시하고
                # 해설지에 '원문 → 변형' 표를 싣는 데 쓴다.
                self._send_json({
                    "passage": reworded,
                    "variations": diff_variations(passage, reworded),
                })
            except NeedsPro as e:
                # 모델을 바꾸기 전에는 계속 실패한다 — 화면이 남은 작업을 멈추도록 code를 붙인다
                self._send_json({"error": str(e), "code": "needs_pro"}, 429)
            except ProUnavailable as e:
                self._send_json({"error": str(e), "code": "pro_unavailable"}, 429)
            except QuotaExceeded as e:
                self._send_json({"error": str(e), "code": "quota"}, 429)
            except Exception as e:
                self._send_json({"error": str(e)}, 502)
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
            variation = req.get("variation") or "verbatim"
            t0 = time.monotonic()
            try:
                result = call_gemini_quiz(passage, types, count, api_key, model, variation=variation)
                # 문항 누락 방어 — 요청한 개수보다 적게 오면 한 번 더 요청해 채운다
                want = max(1, min(int(count or 5), 30))
                for _ in range(2):
                    got = len(result.get("questions", []))
                    if got >= want:
                        break
                    if _over_budget(t0):  # 프록시가 끊기 전에 현재 결과라도 돌려준다
                        break
                    # 유형별 1문항이 기본이므로, 개수 대신 '빠진 유형'을 알려 주면
                    # 재요청 한 번으로 채워질 확률이 높다.
                    made = {q.get("type") for q in result.get("questions", []) if isinstance(q, dict)}
                    missing = [t for t in types if t not in made]
                    retry = call_gemini_quiz(
                        passage, types, count, api_key, model,
                        short_hint=(missing or got), variation=variation
                    )
                    # 더 많이 만들어 온 결과만 채택 (재시도가 더 나쁘면 기존 유지)
                    if len(retry.get("questions", [])) > got:
                        result = retry

                # 해설 누락 방어 — 지문마다 해설이 있다 없다 하면 안 되므로,
                # 빈 해설이 하나라도 있으면 어느 문항이 비었는지 알려 주고 다시 요청한다.
                for _ in range(2):
                    missing = blank_explanations(result)
                    if not missing:
                        break
                    if _over_budget(t0):
                        break
                    retry = call_gemini_quiz(
                        passage, types, count, api_key, model, explain_hint=missing, variation=variation
                    )
                    # 문항 수가 줄지 않고 해설이 더 잘 채워진 결과만 채택
                    if (
                        len(retry.get("questions", [])) >= len(result.get("questions", []))
                        and len(blank_explanations(retry)) < len(missing)
                    ):
                        result = retry
            except NeedsPro as e:
                self._send_json({"error": str(e), "code": "needs_pro"}, 429)
                return
            except ProUnavailable as e:
                self._send_json({"error": str(e), "code": "pro_unavailable"}, 429)
                return
            except QuotaExceeded as e:
                # 재시도해도 안 풀리는 한도 소진 — 화면이 남은 지문을 즉시 중단하도록
                # 기계가 알아볼 수 있는 code를 함께 내려준다
                self._send_json({"error": str(e), "code": "quota"}, 429)
                return
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
            # 등위접속사 누락 방어 — 모델이 가장 자주 빠뜨리는 항목이라, 서버가 직접
            # 세어 빠진 자리를 짚어 준 뒤 다시 요청한다. 더 많이 표시해 온 결과만 채택해
            # 재요청이 오히려 표시를 지우고 오는 경우를 막는다.
            for _ in range(2):
                missed = result.get("_conjMiss") or []
                if not missed or _over_budget(t0):
                    break
                retry = call_gemini(
                    passage, target_grammar, mode, api_key, model, conj_hint=missed
                )
                better = (
                    len(retry.get("_conjMiss") or []) < len(missed)
                    # 접속사를 더 찾아왔더라도 문장이나 영어를 잃었으면 채택하지 않는다
                    and len(retry.get("sentences") or []) >= len(result.get("sentences") or [])
                    and not english_incomplete(retry, passage)
                )
                if not better:
                    break
                result = retry
            result.pop("_conjMiss", None)
        except ProUnavailable as e:
            self._send_json({"error": str(e), "code": "pro_unavailable"}, 429)
            return
        except QuotaExceeded as e:
            self._send_json({"error": str(e), "code": "quota"}, 429)
            return
        except Exception as e:
            self._send_json({"error": str(e)}, 502)
            return
        self._send_json(result)


def main():
    if not PUBLIC_DIR.is_dir():
        sys.exit(f"public 디렉터리를 찾을 수 없습니다: {PUBLIC_DIR}")
    server = ThreadingHTTPServer((HOST, PORT), Handler)
    key_set = "설정됨" if os.environ.get("GEMINI_API_KEY") else "미설정 (AI 기능 전체가 막힘)"
    login_set = "설정됨" if DB is not None else "미설정 (로그인·AI 기능 전체가 막힘)"
    google_set = "설정됨" if GOOGLE_CLIENT_ID else "미설정 (구글 로그인 버튼 비활성)"
    smtp_set = "설정됨" if (SMTP_USER and SMTP_PASSWORD) else "미설정 (인증코드가 서버 로그에만 출력됨)"
    print("영어 지문 분석본 웹앱 실행 중 (Google Gemini)")
    print(f"  주소       : http://{HOST}:{PORT}")
    print(f"  모델       : {MODEL}")
    print(f"  관리자 API 키(GEMINI_API_KEY) : {key_set}")
    print(f"  로그인 저장소(Firestore)      : {login_set}")
    print(f"  구글 로그인(GOOGLE_CLIENT_ID) : {google_set}")
    print(f"  회원가입 메일(SMTP)           : {smtp_set}")
    print("  종료       : Ctrl+C")
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        print("\n종료합니다.")
        server.shutdown()


if __name__ == "__main__":
    main()
