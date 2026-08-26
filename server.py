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

import base64
import copy
import difflib
import hashlib
import io
import json
import os
import random
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
import zipfile
from collections import Counter
# 워드 내보내기에 쓴다. 모듈 이름 html은 이 파일 곳곳에서 매개변수 이름으로 쓰고 있어
# (sanitize_inline(html) 등) 통째로 import하면 그 안에서 가려진다 — 필요한 것만 꺼내 온다.
from html import unescape as _html_unescape
from html.parser import HTMLParser
from datetime import datetime, timedelta, timezone
from email.message import EmailMessage
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path

from google.cloud import firestore
from google.oauth2 import service_account

# --- 설정값을 어디서 읽었는지 함께 기록한다 --------------------------------
# render.yaml에 적어 둔 값이 실제로는 적용되지 않는 일이 반복됐다. 대시보드에서 직접
# 만든 서비스는 그 파일을 읽지 않기 때문인데, 파일만 보고 "지금 예산은 40초"라고 믿은
# 채 진단하면 엉뚱한 결론에 이른다(실제로 그렇게 헛다리를 짚은 적이 있다).
#
# 그래서 값과 '그 값이 어디서 왔는지'를 함께 들고 다니다가 시작할 때 찍는다.
# 로그의 [설정] 줄 하나만 보면 지금 무엇이 적용돼 있는지 바로 알 수 있어야 한다.
CONFIG_SOURCE = {}


def _env(name, default, cast=str):
    """환경변수를 읽고 출처를 CONFIG_SOURCE에 남긴다.

    값이 이상해서 못 읽으면 기본값으로 돌아가되 그 사실도 출처에 남긴다 —
    조용히 기본값으로 돌아가면 '왜 안 먹지'를 또 처음부터 뒤지게 된다."""
    raw = os.environ.get(name)
    if raw is None or raw.strip() == "":
        CONFIG_SOURCE[name] = "기본값"
        return default
    try:
        value = cast(raw)
    except (TypeError, ValueError):
        CONFIG_SOURCE[name] = f"기본값 (환경변수 '{raw}'를 읽을 수 없음)"
        return default
    CONFIG_SOURCE[name] = "환경변수"
    return value


# 배포(Render 등)에서는 0.0.0.0 바인딩이 필요. 로컬에서도 localhost로 접속됨.
HOST = os.environ.get("HOST", "0.0.0.0")
PORT = int(os.environ.get("PORT", "8000"))
# 2026-08-14: 3.6 → 3.7. 두 모델의 토큰 단가는 같다(올해 말까지 100만 토큰당 입력
# $0.75·출력 $3.75, 2027-01-01부터 $1.50·$7.50). 값이 같으니 새 쪽을 쓴다.
# 되돌리려면 Render 환경변수 GEMINI_MODEL에 gemini-3.6-flash를 넣으면 된다.
MODEL = _env("GEMINI_MODEL", "gemini-3.7-flash")
# 정확도가 더 필요한 작업에만 쓰는 Pro 모델. 사용자가 모델을 직접 고르지 않고, 기능마다
# 서버가 이 중 하나를 고정해 쓴다 — 정찰 요금과 실제 원가가 어긋나지 않도록 하기 위해서다.
# 지금 Pro로 가는 것: 지문을 변형해 만드는 문제(객관식·주관식 모두), 지문변형 '5개 이상'.
# 분석본·워크북·사진 옮기기는 Flash다(분석본은 서버가 여섯 가지로 기계 검사해 보완한다).
MODEL_PRO = _env("GEMINI_MODEL_PRO", "gemini-3.1-pro-preview")
# 지문 요약 인포그래픽을 '그리는' 모델(나노바나나 프로). 글자를 그림 안에 찍는 작업이라
# 한글이 깨지지 않는 모델이 필요해 Pro로 고정한다 — Flash 계열은 검증하지 않았다.
# 위의 두 모델과 달리 부르는 곳이 다르다: :generateContent가 아니라 Interactions API다
# (GEMINI_IMAGE_URL 참고).
MODEL_IMAGE = _env("GEMINI_MODEL_IMAGE", "gemini-3-pro-image")
# 가로형 인포그래픽. 4K인 이유는 인쇄물이기 때문이다 — A4 가로(297mm)에 깔면
# 2K는 175dpi로 작은 글자가 뭉개지고, 4K는 350dpi가 나온다. 요금은 두 배다
# (2K $0.134 / 4K $0.24 per image).
IMAGE_ASPECT = _env("GEMINI_IMAGE_ASPECT", "16:9")
IMAGE_SIZE = _env("GEMINI_IMAGE_SIZE", "4K")
# 모델명은 URL 경로에 들어가므로 안전한 형식만 허용 (하드코딩 목록 대신 형식 검증)
_MODEL_RE = re.compile(r"^gemini-[A-Za-z0-9.\-]+$")
PUBLIC_DIR = Path(__file__).resolve().parent / "public"

# --- 로그인(구글 OAuth + 이메일/비밀번호) + Firestore -----------------------
GOOGLE_CLIENT_ID = os.environ.get("GOOGLE_CLIENT_ID", "")
# 서버에 남는 세션 기록의 수명(초). 로그인이 실제로 끊기는 시점은 이 값이 아니라
# '브라우저를 닫을 때'다 — 쿠키에 유효기간을 안 붙이기 때문이다(_session_cookie 참고).
# 이 값은 브라우저를 계속 켜 둔 채 쓰는 경우의 상한 역할만 한다.
SESSION_MAX_AGE = 60 * 60 * 24 * 30  # 30일
# 계정을 새로 만들 때 지급하는 잔액(원). 필요에 맞게 환경변수로 조정하고, 특정
# 사용자에게 더 주고 싶으면 관리자 페이지(/admin.html)에서 충전하거나 Firestore
# 콘솔에서 users/<id> 문서의 krw_remaining 값을 직접 고치면 된다.
DEFAULT_USER_KRW = int(os.environ.get("DEFAULT_USER_KRW", "10000"))

# --- 결제(포트원) -----------------------------------------------------------
# 셋 다 비어 있으면 "충전하기"가 결제창을 못 띄운다(503) — 결제사가 아직
# 안 붙었다는 뜻이므로 무상으로 채워 주던 옛 동작으로 조용히 되돌아가지 않는다.
PORTONE_STORE_ID = os.environ.get("PORTONE_STORE_ID", "")
PORTONE_CHANNEL_KEY_CARD = os.environ.get("PORTONE_CHANNEL_KEY_CARD", "")
PORTONE_API_SECRET = os.environ.get("PORTONE_API_SECRET", "")
PORTONE_API_BASE = "https://api.portone.io"

# --- 포인트 원장(이용 내역) ------------------------------------------------
# 잔액은 숫자 하나로만 남아 있어서 "언제 무엇에 얼마를 썼는지"를 아무도 알 수 없었다.
# 유료로 전환하면 그게 곧 분쟁이 되므로(실패했는데 차감된 것 같다 / 충전한 만큼 안
# 들어왔다), 잔액이 움직일 때마다 한 줄씩 남긴다. 이력은 소급해서 만들 수 없어서
# 유료 전환 전에 미리 쌓아 둔다.
POINT_LEDGER = "point_ledger"
# 보관 기간(개월). 지난 것은 지우되, 지우기 전에 '이월' 한 줄로 접어 둔다 — 그래야
# 포인트에 유효기간이 없는 지금 구조에서도 (지급+충전-사용=잔액) 검산이 유지된다.
LEDGER_KEEP_MONTHS = int(os.environ.get("LEDGER_KEEP_MONTHS", "18"))
# 무상 포인트 유효기간(일). 0이면 만료 없음 — 지금은 꺼 둔다.
# 켜기 전에 반드시 가입 화면과 이용 내역에 소멸 예정일을 먼저 안내해야 한다
# (고지 없이 소멸시키면 그것 자체가 분쟁이 된다).
FREE_POINT_EXPIRE_DAYS = int(os.environ.get("FREE_POINT_EXPIRE_DAYS", "0"))
USAGE_PAGE_SIZE = 50   # 이용 내역 한 쪽에 보여 줄 줄 수
# 사용자가 보는 날짜라 UTC로 적으면 오전 9시 이전 사용분이 전날로 표시된다
KST = timezone(timedelta(hours=9))

# --- 요금제: 실제 Gemini 사용량이 아니라, 행동 하나당 고정 가격(원)을 매긴다 ----
# 실사용 토큰을 그때그때 재는 대신 정찰제로 가는 이유: 사용자 입장에서 예측 가능하고,
# 관리자 입장에서도 "이 버튼 한 번 = 얼마"가 분명해진다. 실제 Gemini 비용과의 차액은
# 관리자가 마진으로 흡수한다. 값은 전부 원(KRW) 단위이며 환경변수로 조정 가능하다.
PRICE_ANALYZE_KRW = int(os.environ.get("PRICE_ANALYZE_KRW", "300"))        # 지문분석, 지문 1개당
# 지문 요약 인포그래픽, 지문 1개당(분석에 얹는 값). 다른 항목과 달리 마진이 얇다 —
# 여기만 원가가 크다. 4K 이미지 1장이 $0.24라 환율 1,400원이면 원가만 약 339원이고
# (1단계 Flash 호출은 그에 비하면 무시할 수준), 남는 건 60원 남짓이다.
# 환율이 오르거나 구글이 단가를 올리면 곧바로 역마진이 되니 그때는 이 값을 올려야 한다.
PRICE_INFOGRAPHIC_KRW = int(os.environ.get("PRICE_INFOGRAPHIC_KRW", "400"))
PRICE_MCQ_PLAIN_KRW = int(os.environ.get("PRICE_MCQ_PLAIN_KRW", "250"))    # 객관식·지문유지, (지문×유형) 1개당
PRICE_MCQ_TRANSFORM_KRW = int(os.environ.get("PRICE_MCQ_TRANSFORM_KRW", "250"))  # 객관식·지문변형, (지문×유형) 1개당
# 주관식, (지문×유형) 1개당. 객관식과 같은 250원으로 맞춘다 — 주관식도 열다섯 유형 중
# 열셋이 지문을 손대 만들고(선택형·오류찾기·배열·영작·전환 …), 그 유형들은 객관식과
# 똑같이 Pro로 생성한다. 원가가 같은데 값만 싸게 받을 이유가 없다.
# (지문을 그대로 싣는 주관식은 OX진위 둘뿐이다.)
PRICE_SAQ_KRW = int(os.environ.get("PRICE_SAQ_KRW", "250"))
# 워크북 — 지문 1개당, 고른 단계 수로 매긴다. 8단계를 다 고르면 상한(700원)에 걸려
# 800원이 아니라 700원이다(전부 고르는 쪽이 단계당으로는 싸진다).
#
# ⚠️ 알아 둘 것: Gemini 호출은 고른 단계 수와 무관하게 언제나 한 번, 8단계분을 통째로
# 받아온다. 즉 단계를 적게 골라도 원가는 그대로다. 이 요금제는 원가가 아니라 '학생에게
# 나가는 지면이 몇 장이냐'를 값으로 삼은 것이다. 원가와 맞추려면 고른 단계만 만들도록
# 스키마·프롬프트를 잘라야 한다(그때 비로소 적게 고르면 실제로 싸진다).
PRICE_WORKBOOK_STAGE_KRW = int(os.environ.get("PRICE_WORKBOOK_STAGE_KRW", "100"))  # 단계 1개당
PRICE_WORKBOOK_MAX_KRW = int(os.environ.get("PRICE_WORKBOOK_MAX_KRW", "700"))      # 지문 1개당 상한
WORKBOOK_STAGE_IDS = (1, 3, 4, 5, 6, 7, 8, 9, 10)  # public/app.js의 WB_STAGES와 같은 목록

# 단계 이름과 '학생이 실제로 하는 일'. public/app.js WB_STAGES의 name·guide와 같은 값을
# 유지해야 한다 — 기출 유형 분석이 시험지 문항을 이 이름에 갖다 붙이고, 화면은 그 이름으로
# 워크북 탭의 체크박스를 찾아 켠다. 이름이 어긋나면 채우기가 조용히 아무것도 안 한다.
WORKBOOK_STAGE_LABELS = {
    # 유일하게 '푸는' 게 아니라 '읽는' 단계다 — sentences[].en/ko는 어차피 모든 요청에서
    # 항상 만들어지므로(스키마가 required로 강제) 새 AI 호출 없이 공짜로 만들 수 있다.
    1:  ("좌지문 우해석", "지문 원문과 우리말 해석을 나란히 놓고 읽는다"),
    3:  ("빈칸 완성하기(영문)", "우리말 해석을 보고 영문 문장의 빈칸을 채워 쓴다"),
    4:  ("해석 연습하기",       "영어 문장을 우리말로 해석해 쓴다"),
    5:  ("동사형 연습하기",     "괄호 안에 기본형으로 주어진 동사를 알맞은 형태로 고쳐 쓴다"),
    6:  ("어법·어휘 고르기",    "괄호 안 두 낱말 중 어법·문맥상 옳은 것을 골라 쓴다"),
    7:  ("어색한 곳 찾기",      "지문의 밑줄 친 부분들 중 어법상 틀린 것을 찾아 바르게 고쳐 쓴다"),
    8:  ("순서 배열하기",       "주어진 말들을 배열해 우리말과 같은 뜻의 문장을 만든다"),
    9:  ("문단 배열하기",       "문단 (A)(B)(C)를 흐름에 맞게 배열한다"),
    10: ("영작 연습하기",       "주어진 키워드를 활용해 문장을 영어로 쓴다"),
}
WORKBOOK_KIND_NAMES = [name for name, _desc in WORKBOOK_STAGE_LABELS.values()]

# 주관식 유형이 '학생에게 무엇을 시키는지' 한 줄 설명. 기출 유형 분석이 시험지 문항을
# 이 이름들에 갖다 붙일 때만 쓴다(문제 생성 프롬프트는 자기 규칙을 따로 갖고 있다).
# 빠진 이름이 있어도 그 유형은 이름만 나가므로 동작에는 지장이 없다.
QUIZ_KIND_HINTS = {
    "서술형배열": "밑줄 친 한 문장을 주어진 낱말들을 배열해 영어로 쓴다",
    "OX진위(영)": "지문 내용에 대한 영어 진술이 맞는지 O/X로 답한다",
    "OX진위(한)": "지문 내용에 대한 우리말 진술이 맞는지 O/X로 답한다",
    "어휘 선택형": "괄호 안 두 낱말 중 문맥에 맞는 것을 골라 쓴다",
    "어법 선택형": "괄호 안 두 낱말 중 어법에 맞는 것을 골라 쓴다",
    "틀린 어휘 찾기": "지문에서 문맥상 틀린 낱말을 찾아 바르게 고쳐 쓴다",
    "틀린 어법 찾기": "지문에서 어법상 틀린 곳을 찾아 바르게 고쳐 쓴다",
    "동사형 쓰기": "괄호 안에 기본형으로 주어진 동사를 알맞은 형태로 고쳐 쓴다",
    "빈칸 쓰기": "지문에 뚫린 빈칸에 들어갈 낱말을 본문에서 찾아 써넣는다(힌트 없음)",
    "표현 찾아 쓰기": "주어진 우리말과 뜻이 같은 영어 표현을 지문에서 찾아 옮겨 쓴다",
    "무관한 문장 쓰기": "글의 흐름과 관계 없는 문장을 찾아 그대로 옮겨 쓴다(번호 없음)",
    "요약문 완성": "글을 한 문장으로 요약한 문장의 빈칸 두 곳을 <보기>의 낱말로 채운다",
    "조건 영작": "밑줄 친 우리말을 <보기>의 낱말(원형)과 <조건>에 맞게 직접 영작한다",
    "문장 전환": "밑줄 친 문장을 수동태·분사구문 등 <조건>이 지정한 구조로 바꿔 쓴다",
    "질문에 답하기": "지문에 대한 영어 질문을 읽고 완전한 영어 문장으로 답을 직접 쓴다",
}


def parse_workbook_stages(raw):
    """요청의 stages를 정규화한다. 모르는 값은 버리고 중복도 없앤다 — 화면에서도 막지만
    화면을 우회한 요청이 그대로 통과하면 안 된다(가격이 단계 수에 걸린다).
    비어 있으면 예전 화면이 보낸 요청으로 보고 전체를 고른 것으로 친다."""
    out = []
    for v in raw or ():
        try:
            n = int(v)
        except (TypeError, ValueError):
            continue
        if n in WORKBOOK_STAGE_IDS and n not in out:
            out.append(n)
    return out or list(WORKBOOK_STAGE_IDS)


def _workbook_cost(stages):
    """워크북 1지문의 정찰 가격(원). 화면도 같은 식으로 예상 비용을 보여 주지만,
    실제 청구는 언제나 여기서 다시 계산한 값을 쓴다."""
    n = len(parse_workbook_stages(stages))
    return min(n * PRICE_WORKBOOK_STAGE_KRW, PRICE_WORKBOOK_MAX_KRW)
# 같은 유형에서 2문항째부터 추가되는 금액. 한 번의 호출에서 지문과 시스템 프롬프트는
# 문항 수와 무관하게 한 번만 입력되므로(= 입력 토큰을 나눠 쓴다), 추가 문항은 출력
# 비용만 든다. 그래서 첫 문항(유형 단가)보다 싸게 매긴다.
PRICE_EXTRA_QUESTION_KRW = int(os.environ.get("PRICE_EXTRA_QUESTION_KRW", "100"))
# 아직 가격이 정해지지 않은 기능 — 정해질 때까지 무료(0원)로 둔다. 로그인은 그대로 필요.
PRICE_REWORD_KRW = int(os.environ.get("PRICE_REWORD_KRW", "0"))            # 지문 변형(문제 생성 전 재작성)
PRICE_OCR_KRW = int(os.environ.get("PRICE_OCR_KRW", "0"))                  # 사진에서 지문 옮기기
# 기출 시험지 유형 분석 — 무료(0원). Pro로 여러 쪽을 읽는 무거운 호출이지만 값을 받지
# 않는다. 이것만으로는 손에 남는 자료가 없고(문항 목록일 뿐이다), 여기서 나온 유형으로
# 문제·워크북을 만들 때 이미 값을 받기 때문이다. 분석에까지 값을 매기면 무엇을 만들지
# 정하기 전에 먼저 돈을 내는 셈이 된다.
# OCR·지문 변형과 같은 자리다 — 결과물이 아니라 '만들기 전 단계'는 받지 않는다.
PRICE_EXAMSCAN_KRW = int(os.environ.get("PRICE_EXAMSCAN_KRW", "0"))
# PDF에서 지문 꺼내기 — 규칙으로 나누는 길은 Gemini를 부르지 않으므로 값이 붙지
# 않는다(아래 잔액 확인에서도 0원으로 지나간다). 규칙이 실패해 사용자가 'AI로 다시
# 시도'를 누른 경우에만 이 값을 매긴다. 그때도 AI는 '지문이 몇째 줄부터 몇째 줄까지인지'
# 만 답하고 본문은 서버가 원문에서 잘라 쓰므로 호출이 가볍다.
PRICE_PDFSPLIT_KRW = int(os.environ.get("PRICE_PDFSPLIT_KRW", "0"))
# 단어장 탭 — 사진에서 단어 목록 인식. 지문 사진(PRICE_OCR_KRW)과 같은 자리이지만
# 값은 따로 매긴다(단어장은 지문 분석 없이도 쓸 수 있어 씀씀이가 다르다).
PRICE_VOCAB_OCR_KRW = int(os.environ.get("PRICE_VOCAB_OCR_KRW", "0"))
# 단어장 탭 — PDF에서 AI로 단어 목록 정리. 규칙(정규식)만으로 뽑히는 깔끔한 표는
# 이 값과 무관하게 언제나 0원이다(PRICE_PDFSPLIT_KRW와 같은 원칙). 규칙이 못 뽑아
# '단어 인식(AI)'을 다시 눌렀을 때만 매겨진다.
PRICE_VOCAB_PDF_KRW = int(os.environ.get("PRICE_VOCAB_PDF_KRW", "0"))

# 객관식 전용 유형 — public/app.js의 MCQ_TYPES와 반드시 같은 목록을 유지한다.
# 이 집합에 없는 유형은 전부 주관식으로 보고 PRICE_SAQ_KRW를 매긴다(객관식·주관식
# 유형 이름은 서로 겹치지 않는다 — "영영풀이"(객관식)와 "영영풀이 쓰기"(주관식)처럼
# 이름 끝을 달리해 구분한다).
MCQ_ONLY_TYPES = {
    "주제", "제목", "요지", "빈칸", "어휘", "어법", "순서", "문장삽입",
    "내용일치(영)", "내용일치(한)", "내용불일치(영)", "내용불일치(한)",
    "함축의미", "무관한 문장", "요약문", "영영풀이",
    "목적", "심경", "지칭 추론",
    "어법 분석", "옳은 문장 찾기", "영영풀이 오류 찾기",
    "연결어 2빈칸 추론",
}


def _quiz_type_base_price(t):
    """유형 1개의 기본 단가(첫 문항 값)."""
    if t in MCQ_ONLY_TYPES:
        return PRICE_MCQ_PLAIN_KRW if t in QUIZ_PLAIN_PASSAGE_TYPES else PRICE_MCQ_TRANSFORM_KRW
    return PRICE_SAQ_KRW


def _quiz_action_cost(items):
    """/api/quiz 요청의 (유형, 문항수) 목록으로 이번 호출의 정찰 가격(원)을 계산한다.
    유형마다 '기본 단가 + 추가문항 × PRICE_EXTRA_QUESTION_KRW'로 매긴다.
    화면도 같은 식으로 예상 비용을 보여 주지만, 실제 청구는 언제나 여기서 다시 계산한
    값을 쓴다 — 화면을 우회해 개수를 부풀린 요청에 그대로 과금되면 안 되기 때문이다."""
    total = 0
    for t, n in items or ():
        total += _quiz_type_base_price(t) + PRICE_EXTRA_QUESTION_KRW * max(0, n - 1)
    return total

# --- 관리자 페이지(public/admin.html) — 회원 목록·토큰 조회/충전 --------------
# 일반 회원 로그인(이메일 정규식 검증 등)과 완전히 분리된, 아이디 하나짜리 단일
# 관리자 로그인이다. ADMIN_PASSWORD를 설정하지 않으면 관리자 로그인은 항상 거부된다
# (기본값을 코드에 두지 않는 이유 — 설정을 깜빡했다고 아무나 들어올 수 있게 하면 안 된다).
ADMIN_USERNAME = os.environ.get("ADMIN_USERNAME", "admin")
ADMIN_PASSWORD = os.environ.get("ADMIN_PASSWORD", "")
ADMIN_SESSION_MAX_AGE = 60 * 60 * 12  # 관리자 세션은 짧게 — 12시간

# --- 학생 로그인(반/단어시험) ------------------------------------------------
# 학생 세션도 관리자처럼 짧게 둔다 — 학교 공용 컴퓨터를 여러 학생이 번갈아 쓰는
# 자리라, 앞 학생 세션이 오래 남아 있으면 뒷 학생이 그 계정으로 시험을 보게 된다.
STUDENT_SESSION_MAX_AGE = 60 * 60 * 12
# 반 코드에 쓰는 문자셋 — 헷갈리는 글자(0/O, 1/I/L)를 빼서 칠판에 적어도 옮겨 적기
# 쉽게 한다. 8자리라 무작위 대입도 현실적으로 어렵다. 학생 개별 코드가 아니라
# 반 하나에 코드 하나 — 학생은 이 코드로 반을 찾은 뒤 목록에서 자기 이름을 고른다.
CLASS_CODE_ALPHABET = "23456789ABCDEFGHJKMNPQRSTUVWXYZ"
CLASS_CODE_LEN = 8


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
# 메일 설정이 없을 때 인증코드를 서버 로그에 찍고 가입을 계속 진행할지.
# 로컬에서 메일 없이 회원가입 흐름을 시험할 때만 켠다 — 실서비스에서 켜면
# '메일을 못 보냈는데 보냈다고 말하는' 상태가 되고, 인증코드가 로그에 남는다.
SIGNUP_CODE_TO_LOG = os.environ.get("SIGNUP_CODE_TO_LOG", "").strip().lower() in ("1", "true", "yes")
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


class MailNotConfigured(RuntimeError):
    """인증메일을 보낼 수단이 없다 — 가입을 진행시키면 안 된다."""


def send_verification_email(to_email, code):
    """인증코드를 메일로 보낸다.

    예전에는 SMTP 설정이 없으면 코드를 서버 로그에 찍고 '보낸 것처럼' 넘어갔다.
    로컬에서 메일 없이 흐름을 시험하려던 배려였는데, 실제 서비스에서 그 설정이
    빠져 있는 바람에 이런 일이 벌어졌다 —
      화면은 "인증코드를 보냈습니다. 메일함을 확인하세요"라고 말하고,
      메일은 나가지 않고, 선생님은 오지 않는 메일을 기다리다 가입을 포기하고,
      가입 완료 단계에서만 만들어지는 users 문서가 끝내 생기지 않아
      회원 목록에는 구글 로그인 회원만 남았다. 아무 데도 오류가 안 찍히니
      운영자도 몰랐다.
    그래서 기본 동작을 '분명히 실패'로 바꾼다. 로그로 흘려 보내는 예전 동작은
    SIGNUP_CODE_TO_LOG를 켰을 때만 쓴다(로컬 시험용 — 실서비스에는 켜지 말 것)."""
    if not SMTP_USER or not SMTP_PASSWORD:
        if SIGNUP_CODE_TO_LOG:
            print(f"[signup] SMTP 설정이 없어 메일 대신 로그로 남깁니다. "
                  f"{to_email} 인증코드: {code}", file=sys.stderr)
            return
        print(f"[signup] SMTP_USER/SMTP_PASSWORD가 없어 {to_email} 에게 "
              f"인증메일을 보내지 못했습니다.", file=sys.stderr)
        raise MailNotConfigured(
            "지금은 이메일로 가입할 수 없습니다 (인증메일 발송이 설정되지 않았습니다). "
            "구글 계정으로 로그인해 주시거나, 잠시 후 다시 시도해 주세요."
        )
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
    try:
        send_verification_email(email, code)
    except Exception:
        # 코드를 못 보냈으면 시도 자체를 없던 일로 되돌린다.
        # 안 그러면 이 문서가 남아 재시도 쿨다운(SIGNUP_RESEND_COOLDOWN)에 걸려,
        # 메일도 못 받고 다시 눌러 볼 수도 없는 상태가 된다.
        try:
            ref.delete()
        except Exception:
            pass
        raise


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
    starting_krw = 0 if _was_previously_deleted(email) else DEFAULT_USER_KRW
    DB.collection("users").document(user_id).set({
        "email": email,
        "name": d.get("name") or "",
        "password_salt": d["password_salt"],
        "password_hash": d["password_hash"],
        "provider": "password",
        "created_at": _now_iso(),
        "krw_remaining": starting_krw,
        # 가입 축하금은 돈을 받은 적이 없으므로 전액 무상이다(환불 대상이 아니다)
        "krw_free": starting_krw,
        "krw_paid": 0,
        # upsert_user와 같은 이유 — 방금 가입했으니 지난 업데이트 소식은 최신으로 맞춰 둔다
        "last_seen_changelog": CHANGELOG[0]["version"] if CHANGELOG else 0,
    })
    ref.delete()
    _log_signup_grant(user_id, starting_krw)
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

# 그림을 만드는 모델은 부르는 곳이 다르다 — 모델명이 URL이 아니라 본문에 들어가고,
# 응답도 텍스트가 아니라 base64 이미지로 온다(_image_from_interaction 참고).
GEMINI_IMAGE_URL = "https://generativelanguage.googleapis.com/v1beta/interactions"


def _asset_version():
    """app.js·style.css가 바뀔 때마다 달라지는 짧은 표식.

    index.html이 <script src="/app.js?v=…">로 이걸 달고 나간다. 캐시 헤더만으로는
    부족했다 — 헤더가 없던 시절에 이미 받아 둔 app.js를 브라우저가 계속 쥐고 있으면
    새 헤더를 볼 기회 자체가 없기 때문이다(그 파일을 다시 요청하지 않으므로).
    주소가 달라지면 브라우저에게 '처음 보는 파일'이 되어 반드시 새로 받는다.

    빌드 도구가 없으니 파일이 고쳐진 시각(mtime)을 표식으로 쓴다. 읽지 못하면 지금
    시각으로 떨어뜨린다 — 캐시가 덜 되는 쪽이 옛 코드가 도는 쪽보다 안전하다."""
    stamp = 0.0
    for name in ("app.js", "style.css"):
        try:
            stamp = max(stamp, (PUBLIC_DIR / name).stat().st_mtime)
        except OSError:
            return str(int(time.time()))
    return str(int(stamp))

# --- 요청 본문 상한 ---------------------------------------------------------
# 본문은 통째로 메모리에 올라간다. 상한이 없으면 큰 요청 몇 개에 인스턴스가
# 죽을 수 있다(Render 무료 512MB).
MAX_BODY_BYTES = int(os.environ.get("MAX_BODY_BYTES", str(14 * 1024 * 1024)))
# 사진 1장의 상한. 화면이 긴 변 1600px JPEG로 줄여 보내므로 보통 0.3~0.6MB가 된다.
MAX_FILE_BYTES = int(os.environ.get("MAX_FILE_BYTES", str(10 * 1024 * 1024)))
# 사진에서 지문 옮겨 적기(OCR)에 받는 형식. PDF는 다루지 않는다 — 사진만.
OCR_MIMES = {"image/jpeg", "image/png", "image/webp", "image/heic", "image/heif"}
# 기출 시험지 분석에 받는 형식. 화면이 PDF에서 쪽별 그림을 꺼내 보내지만, 그림이 들어
# 있지 않은 PDF(글자로 만든 원본)는 꺼낼 것이 없으므로 PDF 그대로도 받는다.
EXAM_MIMES = OCR_MIMES | {"application/pdf"}
# 한 번에 받는 시험지 쪽 수 상한. 실측한 기출 시험지가 6~10쪽이라 넉넉하게 잡았다.
# 상한이 필요한 이유는 크기가 아니라(1600px로 줄이면 쪽당 0.3~0.4MB다) 한 요청에
# 수십 장이 들어와 Pro 호출이 한없이 길어지는 것을 막기 위해서다.
EXAM_MAX_PAGES = int(os.environ.get("EXAM_MAX_PAGES", "16"))
# PDF에서 지문 꺼내기(/api/pdfsplit)에 받는 형식. 여기는 그림이 아니라 PDF 안의
# '글자층'을 읽으므로 PDF만 받는다.
PDF_MIME = "application/pdf"
# 한 번에 읽는 PDF 쪽 수 상한. 모의고사 한 부가 27쪽, 교과서 한 과가 2~5쪽이라
# 넉넉히 잡았다. 상한을 두는 이유는 크기가 아니라 글자층 해석에 드는 시간이다
# (실측: 27쪽 2.3초 — 쪽 수에 거의 비례한다).
PDF_MAX_PAGES = int(os.environ.get("PDF_MAX_PAGES", "80"))
# 꺼낸 글자가 이 길이를 넘으면 자른다 — AI 보조(경계 찾기)에 통째로 넣기 때문이다.
PDF_MAX_CHARS = int(os.environ.get("PDF_MAX_CHARS", "200000"))
# 이보다 짧은 덩어리는 지문이 아니라 제목·안내문 조각으로 본다.
PDF_MIN_PASSAGE_CHARS = int(os.environ.get("PDF_MIN_PASSAGE_CHARS", "120"))

# 전송 실패 자동 재시도 설정 — 시간이 걸려도 모든 지문을 끝까지 분석(사용자 요청).
# 상한(포기) 없이 성공할 때까지 재시도하되, 한 번의 대기는 아래 값으로 잘라 반복한다.
RETRY_MIN_WAIT = 3       # 최소 대기(초) — 과도한 반복 방지
RETRY_MAX_WAIT = 60      # 한 번 대기의 상한(초)

# --- 요청 시간 예산 -------------------------------------------------------
# 아래 기본값은 '로컬 실행' 기준으로, 끊는 프록시가 없으므로 넉넉하게 둔다.
# (Gemini가 503 과부하를 내도 오래 기다려 결국 성공시키는 쪽이 유리하다)
#
# 배포 환경에서 값을 줄이고 싶으면 render.yaml이 아니라 Render 대시보드의
# Environment 탭에 직접 넣어야 한다. 적용됐는지는 시작 로그의 [설정] 줄로 확인한다.
MAX_RETRY_TOTAL = _env("MAX_RETRY_TOTAL", 150.0, float)
                         # 누적 재시도 대기가 이 시간(초)을 넘으면 포기하고 명확히 안내
                         # (호출 1건마다 따로 적용된다)
GEMINI_TIMEOUT = _env("GEMINI_TIMEOUT", 300.0, float)
                         # Gemini 호출 1회의 소켓 타임아웃(초)
REFINE_BUDGET = _env("REFINE_BUDGET", 86400.0, float)
                         # 이 시간(초)을 이미 쓴 뒤에는 보정 재요청을 시작하지 않는다
                         # (기본값은 사실상 무제한 = 검사를 끝까지 다 돌린다)

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


class RefineTrace:
    """분석 1건이 실제로 어떻게 보정됐는지 기록한다 — 지문 하나에 모델을 몇 번
    불렀는지, 어느 보정 단계까지 돌았는지, 시간 예산(REFINE_BUDGET)에 걸려 어디서
    멈췄는지. 배포 환경은 예산이 40초라 뒤쪽 단계가 아예 실행되지 않을 수 있는데,
    그 사실이 지금은 아무 데도 남지 않아 눈에 띄지 않는다.

    요청을 처리하는 스레드 안에서만 쓰므로 잠금이 필요 없다."""

    def __init__(self, t0):
        self.t0 = t0
        self.calls = 1       # 1차 호출은 조건 없이 일어난다
        self.first = None    # 1차 호출에 걸린 시간(초)
        self.done = []       # 실제로 재요청까지 간 단계
        self.cut = None      # 예산이 없어 시작조차 못 한 첫 단계

    def first_done(self):
        """1차 호출이 끝난 시점을 기록한다(모델을 바꿔도 되는지 판단하는 근거)."""
        self.first = time.monotonic() - self.t0

    def blocked(self, stage):
        """이 단계를 시작할 여유가 없으면 True. 겸사겸사 어디서 잘렸는지 남긴다."""
        if _over_budget(self.t0):
            if self.cut is None:
                self.cut = stage
            return True
        return False

    def retry(self, stage, partial=None):
        """이 단계가 재요청을 한 번 보냈다.
        partial=True면 문장만 고쳐 받은 것, False면 전체를 다시 만든 것."""
        self.calls += 1
        if partial is True:
            stage += "(부분)"
        elif partial is False:
            stage += "(전체)"
        if stage not in self.done:
            self.done.append(stage)

    def log(self, model, passage, error=None):
        """한 줄로 남긴다. Render 로그에서 '[분석]'으로 걸러 보면 된다.
        진단용 기록이 본 작업을 망치면 안 되므로, 출력이 실패해도 넘어간다
        (콘솔 인코딩이 한글을 못 쓰는 환경 등)."""
        total = time.monotonic() - self.t0
        first = f"{self.first:.1f}초" if self.first is not None else "-"
        try:
            print(
                f"[분석] 호출 {self.calls}회 | 1차 {first} | 총 {total:.1f}초"
                f" | 보정 {','.join(self.done) or '없음'}"
                f" | 중단 {self.cut or '없음'}"
                f" | 예산 {REFINE_BUDGET:.0f}초 | {model} | 지문 {len(passage)}자"
                + (f" | 실패 {error}" if error else ""),
                file=sys.stderr,
            )
        except Exception:
            pass


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
                                            "grp": {"type": "INTEGER"},
                                        },
                                        "required": ["t", "role", "rt", "num", "grp"],
                                        "propertyOrdering": ["t", "role", "rt", "num", "grp"],
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
                    # 표현 찾아 쓰기 — 우리말 뜻과 지문에 있는 영어 표현의 짝.
                    # 이 유형만 지문에 표시를 심지 않고 목록을 따로 세우므로 칸이 따로 있다.
                    "findItems": {
                        "type": "ARRAY",
                        "items": {
                            "type": "OBJECT",
                            "properties": {
                                "ko": {"type": "STRING"},
                                "en": {"type": "STRING"},
                            },
                            "required": ["ko", "en"],
                            "propertyOrdering": ["ko", "en"],
                        },
                    },
                    # 영영풀이 쓰기 — 영어 정의(def)와 그 정의가 가리키는, 지문에 실제로
                    # 있는 영어 낱말/표현(en)의 짝. findItems와 짝이 우리말↔영어냐
                    # 영어↔영어냐만 다르다.
                    "glossItems": {
                        "type": "ARRAY",
                        "items": {
                            "type": "OBJECT",
                            "properties": {
                                "def": {"type": "STRING"},
                                "en": {"type": "STRING"},
                            },
                            "required": ["def", "en"],
                            "propertyOrdering": ["def", "en"],
                        },
                    },
                    # 조건 영작·문장 전환·질문에 답하기 — 학생에게 거는 <조건> 줄들(우리말).
                    # 조건 영작의 '총 N단어로 쓸 것'은 여기 넣지 않는다. 모델이 낱말을
                    # 세다 틀리면 모범답안이 제 조건을 어기게 되므로, 서버가 answerText를
                    # 직접 세어 뒤에 붙인다(_append_word_count_condition). 질문에 답하기의
                    # 분량 제한은 답이 정해진 하나로 떨어지지 않아 서버가 대신 세지 않는다.
                    "conditions": {"type": "ARRAY", "items": {"type": "STRING"}},
                    # 조건 영작(항상), 질문에 답하기(<보기>를 줄 때만) — 학생에게 주는 낱말.
                    # 조건 영작은 반드시 사전형(원형)이라 형태 결정이 학생 몫으로 남는다.
                    "wordBank": {"type": "ARRAY", "items": {"type": "STRING"}},
                    "explanation": {"type": "STRING"},
                },
                # passageHtml은 required가 아니다 — 지문을 가공 없이 그대로 쓰는 유형
                # (QUIZ_PLAIN_PASSAGE_TYPES)은 비워서 보내고 서버가 채운다.
                # 지문을 유형 수만큼 되받지 않으므로 출력 토큰이 크게 줄고,
                # 문항끼리 지문이 미묘하게 달라지는 사고도 사라진다.
                "required": ["no", "type", "format", "instruction",
                             "choices", "answer", "answerText", "tfItems", "fixes",
                             "findItems", "glossItems", "conditions", "wordBank",
                             "explanation"],
                "propertyOrdering": ["no", "type", "format", "instruction", "passageHtml",
                                     "choices", "answer", "answerText", "tfItems", "fixes",
                                     "findItems", "glossItems", "conditions", "wordBank",
                                     "explanation"],
            },
        },
    },
    "required": ["questions"],
    "propertyOrdering": ["questions"],
}

QUIZ_TYPE_LABELS = [
    "주제", "제목", "요지", "빈칸", "어휘", "어법", "순서", "문장삽입", "함축의미",
    "무관한 문장", "요약문", "영영풀이",
    "내용일치(영)", "내용일치(한)", "내용불일치(영)", "내용불일치(한)",
    "서술형배열", "OX진위(영)", "OX진위(한)",
    "어휘 선택형", "어법 선택형", "틀린 어휘 찾기", "틀린 어법 찾기",
    "동사형 쓰기", "빈칸 쓰기", "표현 찾아 쓰기", "영영풀이 쓰기",
    "무관한 문장 쓰기", "요약문 완성", "조건 영작", "문장 전환", "질문에 답하기",
    "목적", "심경", "지칭 추론",
    "어법 분석", "옳은 문장 찾기", "영영풀이 오류 찾기",
    "요약문 완전구성형", "연결어 2빈칸 추론", "다의어 문맥의미 매칭형",
]

# 지문을 '가공 없이 통째로' 보여 주는 유형 — 빈칸·밑줄·블록 분할이 전혀 없다.
# 이 유형들의 passageHtml은 매번 지문 전문의 복사본이라, 유형 수만큼 지문이
# 출력에 중복돼 실린다(12유형이면 지문 12벌). 모델에게는 비워서 보내게 하고
# 서버가 지문으로 채워, 출력 토큰과 생성 시간을 함께 줄인다.
# "영영풀이"도 여기 든다 — 영영풀이는 지문 옆에 정의를 얹을 뿐 지문 자체는 그대로다.
# "질문에 답하기"도 마찬가지다 — 질문은 instruction에 실리고 지문 자체는 손대지 않는다.
# "목적"·"심경"도 지문을 그대로 읽고 판단하는 유형이라 여기 든다. "지칭 추론"은 대명사에
# 밑줄·번호를 붙이므로 여기 없다(어휘·어법과 같은 '지문변형형').
QUIZ_PLAIN_PASSAGE_TYPES = {
    "주제", "제목", "요지", "영영풀이", "목적", "심경",
    "내용일치(영)", "내용일치(한)", "내용불일치(영)", "내용불일치(한)",
    "OX진위(영)", "OX진위(한)", "질문에 답하기",
    # 요약 문장을 통째로 새로 짓는 유형이라 지문 자체는 건드리지 않는다
    # ("요약문 완성"은 요약 문장 안에 빈칸을 뚫으므로 여기 없다).
    "요약문 완전구성형",
}

# '목표 어법'(화면의 targetGrammar)이 걸리는 유형.
# 지문 분석에만 있던 설정을 문제 제작에도 쓴다 — 이번 단원에서 가르친 문법을
# 시험에 그대로 내기 위한 것이다. 문법 포인트를 직접 묻는 유형만 넣는다.
# 주제·제목·빈칸처럼 문법과 무관한 유형에는 지시를 아예 실어 보내지 않는다
# (엉뚱한 곳에 문법을 끼워 넣으려 드는 것을 막는다).
QUIZ_GRAMMAR_TYPES = {"어법", "어법 선택형", "틀린 어법 찾기", "동사형 쓰기",
                      "조건 영작", "문장 전환"}

# 한 지문에서 유형별로 뽑을 수 있는 최대 문항 수.
# public/app.js의 TYPE_MAX와 반드시 같은 값을 유지한다(화면은 이 값으로 +버튼을 막고,
# 서버는 화면을 우회한 요청을 여기서 잘라낸다 — 가격이 개수에 걸리므로 필수).
#
# 값이 유형마다 다른 이유:
#  · 지문 재사용 유형(위 QUIZ_PLAIN_PASSAGE_TYPES)은 문항이 늘어도 출력이 거의 안 커져
#    넉넉하다. 반대 유형은 문항마다 지문이 통째로 실려 프록시 제한(약 100초)에 걸린다.
#  · 어법 계열은 지문에 '실제로 있는' 문법 포인트 수가 한계다. 그보다 많이 시키면
#    틀리지 않은 형태를 틀렸다고 하는 정답 시비가 난다.
#  · 순서·문장삽입은 지문의 문장 수에 물리적으로 묶여 모델을 바꿔도 늘지 않는다.
QUIZ_TYPE_MAX = {
    # 객관식
    "주제": 5, "제목": 5, "요지": 5,
    "내용일치(영)": 5, "내용일치(한)": 5, "내용불일치(영)": 5, "내용불일치(한)": 5,
    "빈칸": 6, "어휘": 6, "어법": 4,
    "순서": 2, "문장삽입": 2,
    # 지문에 실제로 든 비유·반어 표현의 수가 한계다. 그보다 많이 시키면 평범한 사실
    # 문장에 밑줄을 긋고 '의미하는 바'를 묻게 되어, 정답과 오답이 갈리지 않는다.
    "함축의미": 2,
    "영영풀이": 5,
    # 주관식 (전부 Flash로 처리되므로 어법 계열은 객관식보다 더 보수적으로 잡는다)
    # 한 번에 만들 수 있는 총량(QUIZ_MAX_QUESTIONS_PER_RUN, 200문항)에 가장 먼저
    # 걸리는 유형이라 5로 잡는다. 영어·한글 두 유형이라 지문 1개당 10문항이 되고,
    # 그래야 지문 20개까지 한 번에 낼 수 있다(8이면 지문 13개에서 막혔다).
    "OX진위(영)": 5, "OX진위(한)": 5,
    "서술형배열": 6, "어휘 선택형": 6,
    "틀린 어휘 찾기": 5, "어법 선택형": 5, "틀린 어법 찾기": 3,
    # 한 문항이 지문 전체에서 동사 4~6개를 이미 가져간다. 문항을 늘리면 같은 동사를
    # 다시 뽑거나 문법 포인트가 없는 동사까지 긁어오게 된다.
    "동사형 쓰기": 2,
    # 한 문항이 핵심어 2~4개를 가져간다. 더 늘리면 문맥으로 되살릴 수 없는 낱말까지
    # 지우게 되어 답이 하나로 정해지지 않는다.
    "빈칸 쓰기": 3,
    # 한 문항이 3~4개 표현을 가져간다. 겹치지 않으면서 뜻이 하나로 떨어지는 표현이
    # 지문 하나에 그리 많지 않다.
    "표현 찾아 쓰기": 2,
    # 표현 찾아 쓰기와 같은 이유 — 한 문항이 2~4개 낱말을 가져가고, 영영풀이 하나로
    # 뜻이 딱 정해지는 낱말이 지문 하나에 그리 많지 않다.
    "영영풀이 쓰기": 2,
    # 무관한 문장·요약문 계열은 지문 하나에 1문항이 상한이다. 둘 다 '글 전체의 논지'
    # 하나에 걸려 있어서다 — 무관한 문장을 두 개 심으면 남은 문장만으로는 원래 흐름이
    # 이어지지 않아 어느 쪽이 무관한지 가릴 수 없고, 요약문은 글 하나에 요약이 하나뿐이라
    # 두 번째 문항은 같은 문장을 다른 낱말로 뚫은 중복이 된다.
    "무관한 문장": 1, "요약문": 1,
    "무관한 문장 쓰기": 1, "요약문 완성": 1,
    # 한 문항이 지문의 문장 하나를 통째로 가져간다. 그 문장은 조건을 걸 만한 문법
    # 구조(관계사·분사구문·수동태 …)를 실제로 갖고 있어야 하는데, 지문 하나에 그런
    # 문장이 그리 많지 않다. 더 시키면 평범한 문장에 억지 조건을 붙이게 된다.
    "조건 영작": 3,
    # 전환은 원문이 그 구조를 이미 갖고 있을 때만 성립한다(수동태로 바꾸려면 타동사와
    # 목적어가, 분사구문으로 바꾸려면 부사절이 있어야 한다). 조건 영작보다 더 좁다.
    "문장 전환": 3,
    # 지문 재사용 유형이라 출력은 크지 않지만, 질문마다 답의 근거가 되는 대목이
    # 겹치지 않아야 한다. 지문 하나에서 서로 다른 대목을 짚어 물을 수 있는 질문이
    # 그리 많지 않아 OX진위(8)보다는 보수적으로 잡는다.
    "질문에 답하기": 5,
    # 목적도 주제·제목·요지와 같은 지문 재사용형이라 같은 상한을 준다.
    "목적": 5,
    # 심경은 서사(이야기)에만 성립하는 유형이다. 이야기 하나의 정서적 흐름은 보통
    # 하나뿐이라, 여러 문항을 내면 같은 판단을 다른 말로 되풀이하게 된다.
    "심경": 2,
    # 지문에 서로 다른 대상을 가리키는 지칭어 집합이 여러 벌 나오기 어렵다 —
    # 어법과 같은 이유(문법 포인트 수)로, 대명사가 헷갈릴 만한 자리 수가 한계다.
    "지칭 추론": 2,
    # 어법보다 한 자리 낮춘다 — 한 자리에 '참인 주장 하나 + 거짓인 주장 넷'을 모두
    # 자연스럽게 지어내야 해서, 단순히 오류 하나만 심는 어법보다 손이 더 간다.
    "어법 분석": 3,
    # 문항 하나에 문장 5개 중 넷에 문법 오류를 심고 하나는 원문 그대로 옳아야 한다.
    # 어법(단어 하나에 오류 하나)보다 한 문항이 요구하는 오류 수가 많아 어법 분석과
    # 같은 상한을 준다.
    "옳은 문장 찾기": 3,
    # 영영풀이와 같은 이유(뜻이 뚜렷한 내용어 수)로 넉넉히 잡는다.
    "영영풀이 오류 찾기": 5,
    # 무관한 문장·요약문과 같은 이유 — 지문 하나를 요약한 문장은 하나뿐이라 여러 문항을
    # 내면 같은 요약을 다른 낱말로 되풀이하게 된다.
    "요약문 완전구성형": 1,
    # 연결어 두 자리가 자연스레 성립하는 담화 전환점(그러나·따라서 등)이 지문 하나에
    # 여럿 있기는 어렵다. 순서·문장삽입과 같은 상한을 준다.
    "연결어 2빈칸 추론": 2,
    # 같은 낱말이 서로 다른 뜻으로 3번 이상 쓰인 경우 자체가 드물다 — 지문 하나에
    # 그런 낱말이 두 개 있기는 더 어렵다.
    "다의어 문맥의미 매칭형": 1,
}
# 한 번의 /api/quiz 호출에 넣을 수 있는 총 문항 수 상한.
# 화면은 문항 수로 끊어 보내므로(app.js의 QUIZ_QUESTIONS_PER_CALL=6, 한 유형이 그보다
# 크면 그 유형만 최대 8) 정상 요청은 8문항을 넘지 않는다. 여기 값은 화면을 우회해
# 19유형을 상한까지 한 호출에 몰아넣는 요청(=96문항)을 막는 안전망이다 — 그런 호출은
# 프록시 제한에 걸려 어차피 실패하면서 관리자 키의 토큰만 태운다.
QUIZ_MAX_QUESTIONS_PER_CALL = int(os.environ.get("QUIZ_MAX_QUESTIONS_PER_CALL", "30"))


def parse_quiz_items(raw):
    """요청의 types를 [(유형, 문항수)] 로 정규화한다.

    화면은 [{"id": "주제", "count": 2}, ...] 형태로 보낸다. 모르는 유형은 버리고,
    개수는 1 이상 유형별 상한 이하로 자른다 — 화면에서도 막지만 화면을 우회한
    요청이 그대로 통과하면 안 된다(가격이 개수에 걸린다).
    같은 유형이 두 번 들어오면 뒤엣것을 무시한다."""
    items = []
    seen = set()
    for it in raw or ():
        if isinstance(it, dict):
            tid, n = it.get("id"), it.get("count", 1)
        else:  # 문자열만 온 경우 = 1문항으로 본다
            tid, n = it, 1
        if tid not in QUIZ_TYPE_LABELS or tid in seen:
            continue
        try:
            n = int(n)
        except (TypeError, ValueError):
            n = 1
        seen.add(tid)
        items.append((tid, max(1, min(n, QUIZ_TYPE_MAX.get(tid, 1)))))
    # 호출 하나의 총 문항 수도 막는다 — 상한을 넘으면 넘는 지점에서 잘라낸다.
    total = 0
    capped = []
    for tid, n in items:
        if total + n > QUIZ_MAX_QUESTIONS_PER_CALL:
            n = QUIZ_MAX_QUESTIONS_PER_CALL - total
            if n <= 0:
                break
        capped.append((tid, n))
        total += n
    return capped


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
  "pick" for 어휘/어법 선택형, "fix" for 틀린 어휘/어법 찾기, "verb" for 동사형 쓰기,
  "fill" for 빈칸 쓰기, "find" for 표현 찾아 쓰기, "gloss" for 영영풀이 쓰기,
  "compose" for 조건 영작, "convert" for 문장 전환, "answer" for 질문에 답하기.
  Every other type (including "영영풀이") is "mc".
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
  For "compose", the same — the passage's own sentence, verbatim (that is the 모범답안).
  For "convert", the TRANSFORMED sentence you wrote (NOT the passage's original).
  For "answer", the model answer to the question — a NEW sentence you compose from
  understanding the passage (not copied verbatim), obeying `conditions`.
  For "mc" and "tf", set to "".
- `tfItems`: for "tf", EXACTLY 5 items {text, isTrue}. For every other format, set to [].
- `fixes`: for "fix", one {wrong, right} per planted error. For every other format, set to [].
- `findItems`: for format "find" — 3~4 items {ko, en} for "표현 찾아 쓰기", or 3~5 items
  (one per underlined occurrence) for "다의어 문맥의미 매칭형". For every other format, set to [].
- `glossItems`: for "gloss" (영영풀이 쓰기), 2~4 items {def, en}. For every other format, set to [].
- `conditions`: for "compose", "convert", and "answer", the Korean <조건> lines (see those
  types below). For every other format, set to [].
- `wordBank`: for "compose" always, and for "answer" only when that item gives a word bank
  (see below) — the <보기> words in DICTIONARY form. For every other format, set to [].
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
- "목적" — instruction "다음 글의 목적으로 가장 적절한 것은?". passageHtml = 지문 전문.
  이 유형은 지문이 '누군가에게 보내는 글'(공지·안내문·이메일·광고·연설 등)일 때 가장
  자연스럽다 — 그럴 때는 필자가 읽는 이에게 원하는 행동이나 전달하려는 요점을 고른다.
  지문이 순수 설명문이라도 "~을 설명하려고", "~을 소개하려고"처럼 필자의 서술 의도로
  잡을 수 있다.
  choices = 5 Korean phrases ending in "~려고"(예: "학생 의견을 반영한 학교 시설 개선
  사항을 안내하려고"), 서로 다른 문장 성분(누구에게 · 무엇을 · 왜)이 갈리게 써서 지문을
  안 읽고는 못 고르게 한다.
- "심경" — instruction: 지문에 감정을 드러내는 인물(1인칭 "I" 또는 이름 있는 등장인물)이
  있고 그 감정이 글 초반과 후반에서 달라지면
  "다음 글에 드러난 '{인물}'의 심경 변화로 가장 적절한 것은?"을 쓰고, 감정이 하나로
  이어지면
  "다음 글에 드러난 '{인물}'의 심경으로 가장 적절한 것은?"을 쓴다({인물} 자리에 지문
  속 실제 이름이나 "I"를 넣는다).
  passageHtml = 지문 전문.
  ⚠️ 이 유형은 **서사(이야기)** 지문에만 성립한다. 감정을 겪는 인물이 뚜렷하지 않은
  순수 설명문·논설문에는 억지로 심경을 지어내지 마라 — 그런 지문이면 이 유형을 건너뛰고
  대신 다른 유형의 문항을 하나 더 만들어 문항 수를 채워라.
  choices: 변화형이면 5개의 "형용사 → 형용사" 쌍(예: "anxious → relieved"), 단일형이면
  5개의 단일 형용사. 전부 영어로 쓴다. 오답은 지문의 감정과 반대이거나, 방향이 틀렸거나
  (변화 순서를 뒤바꾸거나), 지문에 없는 감정(예: 지문에 두려움이 없는데 "fear")이어야
  한다 — 막연히 그럴듯한 형용사를 늘어놓지 마라.
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
- "지칭 추론" — instruction "다음 글의 밑줄 친 부분 중, 가리키는 대상이 나머지 넷과
  다른 것은?". Same underline/circled-number mechanics as 어휘·어법 (5 spans, ①~⑤),
  but each underlined span is a REFERRING EXPRESSION (대명사 he/she/it/they/this/that/
  one, 또는 the man/the woman처럼 대상을 되받는 명사구) — not a vocabulary or grammar
  point.
  · 지문에서 서로 다른 대상(사람·사물) **최소 2개**를 찾아라. 그중 하나를 가리키는
    지칭어를 넷, 다른 하나(또는 다른 것)를 가리키는 지칭어를 하나 골라 총 5개에
    ①~⑤를 붙인다. 넷이 같은 대상이고 하나만 다른 것 — 그 하나가 정답이다.
  · 각 지칭어가 무엇을 가리키는지 지문 문맥만으로 **명확히** 추적되어야 한다. 성별·
    수(단수/복수)가 겹쳐 헷갈릴 만한 자리를 고르되, 실제로는 답이 하나로 정해져야
    한다 — 두 가지로 읽힐 수 있으면 그 지문은 이 유형에 맞지 않으니 다른 자리를
    찾아라.
  choices = ["①","②","③","④","⑤"] in that literal order; answer = 다른 대상을
  가리키는 것의 위치.
- "어법 분석" — instruction "다음 글의 밑줄 친 부분에 대한 설명으로 가장 적절한 것은?".
  Same underline/circled-number passageHtml as 어법 (5 spans, ①~⑤) — 문법 포인트든
  어휘(문맥상 뜻)든 섞어도 된다. 여기까지는 어법과 같지만, **choices의 구조가
  다르다**: 어법·어휘는 "어느 것이 틀렸나"를 묻지만, 이 유형은 **각 choice가 그
  번호의 밑줄에 대한 하나의 문법적·의미적 주장**이다 — choice N은 반드시 밑줄 N에
  대해 말해야 한다(1번 choice가 3번 밑줄을 설명하는 식으로 뒤섞지 마라). 예:
    ① ①that은 which로 바꿔 쓸 수 있다.
    ② ②that은 the illusion을 설명하는 목적격 관계대명사이다.
    ③ ③no less than은 문맥상 '기껏해야'를 의미한다.
    ④ ④to recognise는 어법상 recognising으로 바꿔 쓸 수 없다.
    ⑤ ⑤presenting은 어법상 presented로 고쳐야 한다.
  정확히 하나의 주장만 참이고, 나머지 넷은 각각 그 밑줄에 대해 **틀린** 주장이어야
  한다(형태를 잘못 짚거나, 뜻을 잘못 짚거나, 안 바뀌는 걸 바뀐다고 하거나).
  ⚠️ 참인 주장 하나를 뺀 나머지 넷의 밑줄 자체는 실제로 어법상·의미상 **문제가
  없어야** 한다 — 그 넷에 대한 주장만 틀렸을 뿐, 밑줄 자체가 틀리면 학생이 왜
  그 choice가 틀렸다고 판단해야 하는지 근거가 사라진다.
  choices = 5 Korean/English-mixed statements as above; answer = the TRUE one's position.
- "옳은 문장 찾기" — instruction "다음 글에서 어법상 옳은 문장은?". 어법의 극성을
  뒤집은 유형이다 — 어법은 5개 중 **하나만 틀린 것**을 찾지만, 이건 5개 중
  **하나만 맞는 것**을 찾는다. 표시 단위도 낱말이 아니라 **문장**이다.
  · 지문에서 문장 5개를 골라(연속이 아니어도 된다) 각각을 <u>…</u>로 통째로 감싸고
    앞에 circled number를 붙인다(①<u>Sentence one.</u> … ⑤<u>Sentence five.</u>).
  · 그중 정확히 하나는 지문 원문 그대로 — 어법상 완전히 옳다. 나머지 넷에는 네가
    직접 문법 오류를 하나씩 심는다(수일치·시제·태·준동사·관계사·병렬 등, 어법
    유형과 같은 원리로 고른다).
  · 오류를 심은 네 문장도 억지스럽지 않게 자연스러운 문장처럼 읽혀야 한다 — 대놓고
    틀린 문장은 학생이 지문을 안 읽어도 걸러낼 수 있어 시험이 안 된다.
  choices = ["①","②","③","④","⑤"] in that literal order; answer = 원문 그대로 둔
  문장(어법상 옳은 것)의 위치.
- "순서" — instruction "주어진 글 다음에 이어질 글의 순서로 가장 적절한 것은?".
  passageHtml = the passage's first 1–2 sentences (the given opening) then <br><br>, then the
  REST of the passage split into exactly 3 blocks labeled <b>(A)</b>, <b>(B)</b>, <b>(C)</b>
  (each starting a new line via <br><br>) given in a SCRAMBLED (non-original) order. choices
  = 5 plausible orderings like "(B)-(A)-(C)", only one matching the passage's true order.
- "문장삽입" — instruction as described above (includes the sentence to insert). passageHtml
  = the rest of the passage (after removing one sentence) with 5 candidate insertion points
  marked as circled numbers ①~⑤ placed BETWEEN sentences. choices = ["①","②","③","④","⑤"]
  in that literal order; answer = where the removed sentence truly belongs.
- "무관한 문장" (format "mc") — instruction "다음 글에서 전체 흐름과 관계 없는 문장은?"
  `passageHtml` = the passage rebuilt like this, PLAIN TEXT with circled numbers only
  (no HTML tags):
    · The FIRST 2 sentences stay as an UNNUMBERED opening — they establish the topic, and a
      student cannot judge "관계 없음" before the topic is set.
    · After them come EXACTLY 5 sentences, each preceded by ①②③④⑤ (①Sentence. ②Sentence. …).
    · FOUR of those 5 are the passage's own next sentences, verbatim, in their original order.
    · ONE is a sentence YOU write and INSERT. That inserted one is the answer.
  ⚠️ HOW TO WRITE THE INSERTED SENTENCE — this is the whole difficulty of the type.
  A well-written passage contains no irrelevant sentence, so you must manufacture one that is
  tempting yet indefensible. It must satisfy BOTH:
    (a) SAME SUBJECT MATTER — reuse the passage's own nouns and key terms. Introduce no new
        topic, no new proper noun, no new domain. On a quick read it must look like it belongs.
    (b) DIFFERENT CONCERN — it makes a claim the passage never argues toward. Reliable ways:
        turn a descriptive passage into a practical recommendation; discuss a limitation,
        exception, or difficulty the passage does not raise; reverse a cause-and-effect
        direction; evaluate what the passage merely describes.
  Example of the pattern (passage about how cave art let humans TRANSMIT knowledge across
  generations): the inserted sentence says "despite advances in technology there is a limit in
  RESTORING damaged cave paintings" — same subject (cave paintings), different concern
  (restoration technique vs knowledge transmission).
  ⚠️ Do NOT edit the other four sentences in any way. If one of the passage's own sentences
  would read as more off-topic than the one you inserted, the item has no defensible answer —
  in that case choose a different insertion point and rewrite your sentence.
  ⚠️ PLACE THE INSERTED SENTENCE AT ③ OR ④ — never ①, ②, or ⑤. At ① the topic is not yet
  established; at ⑤ the passage would end on the irrelevant note and stop reading as a whole.
  (Real 수능·모의고사 answers land on ③/④ almost without exception.)
  choices = ["①","②","③","④","⑤"] in that literal order; answer = the inserted position.
- "요약문" (format "mc") — instruction
  "다음 글의 내용을 한 문장으로 요약하고자 한다. 빈칸 (A), (B)에 들어갈 말로 가장 적절한 것은?"
  `passageHtml` = the passage verbatim, then <br><br>, then ONE English summary sentence that
  compresses the WHOLE passage (not just its first half), with exactly two blanks written as
  "(A)______________" and "(B)______________".
  The two blanked words must be the sentence's two load-bearing ideas — typically the property
  the passage attributes to its subject, and the consequence that follows. Blanking a word the
  reader can guess from grammar alone (an article, a preposition, a generic noun) wastes the item.
  choices = 5 strings, each ONE pair written exactly as "wordA … wordB" (three-dot ellipsis,
  spaces around it). answer = the correct pair.
  ⚠️ DISTRACTOR GRID — without this the item is only half a question.
  If all five (A) words differ AND all five (B) words differ, a student who knows only (A) has
  already found the answer. Real exams prevent this: ONE side reuses words so that the same
  (A) appears in two or three different pairs, and only (B) separates them.
  So: on ONE side use just 2-3 distinct words spread across the five pairs; on the OTHER side
  use five distinct words. Example of the shape:
      ① hinders … denies      ② enhances … counters   ③ controls … distorts
      ④ enhances … confirms   ⑤ hinders … approves
  (A) has three distinct words reused; knowing "hinders" still leaves ① and ⑤ to separate.
  ⚠️ Every wrong pair must be wrong for a reason grounded in the passage — a word the passage
  actually contradicts, not a word that is merely odd. Do not use nonsense fillers.
  ⚠️ Do NOT put the correct pair first. Order the five pairs so the answer falls at ②, ③, ④,
  or ⑤ — a correct choice sitting at ① is a giveaway.
- "연결어 2빈칸 추론" (format "mc") — instruction
  "다음 글의 빈칸 (A), (B)에 들어갈 말로 가장 적절한 것은?"
  수능에 흔한 담화표지(연결어) 두 자리 추론 유형이다. "빈칸"과 다른 점은 한 자리가
  아니라 **두 자리**이고, 채울 것이 명사·구가 아니라 **문장과 문장을 잇는 담화표지**
  (however, therefore, in addition, for example, in contrast, as a result, similarly …)
  라는 것이다.
  `passageHtml` = the passage verbatim, with exactly TWO sentence-initial connectives
  replaced by "(A)_______" and "(B)_______" — pick two spots where the passage's own
  logic genuinely turns (역접·인과·예시·첨가 등), not two random sentence starts.
  ⚠️ The two blanks must sit at two DIFFERENT kinds of transition (e.g. one 역접 + one
  인과) — if both blanks want the same relationship, the item has only one real decision
  disguised as two.
  choices = 5 strings, each ONE pair written exactly as "wordA … wordB" (three-dot
  ellipsis, spaces around it) — same convention as "요약문". answer = the correct pair.
  ⚠️ DISTRACTOR GRID — same requirement as "요약문": if all five (A) words differ AND all
  five (B) words differ, a student who nails only (A) has already found the answer. Reuse
  words on ONE side (2-3 distinct words spread across the five pairs) and keep the OTHER
  side fully distinct (5 different words), e.g.:
      ① However … Therefore   ② In addition … For example   ③ However … For example
      ④ In contrast … As a result   ⑤ However … As a result
  ⚠️ Every wrong connective must be wrong for a reason grounded in the passage's actual
  logic at that spot (a real 역접 spot where the distractor claims 인과, etc.) — never a
  connective that would also read acceptably there.
  ⚠️ Do NOT put the correct pair first — order so the answer falls at ②, ③, ④, or ⑤.
- "영영풀이" (format "mc") — instruction "다음 영영풀이가 설명하는 낱말로 가장 적절한 것은?"
  followed on its own line by the definition, embedded the same way "문장삽입" embeds its
  given sentence:
  다음 영영풀이가 설명하는 낱말로 가장 적절한 것은?<br><br>
  <b>영영풀이:</b> The English definition text.
  passageHtml = 지문 전문 (지문 재사용이면 OMIT — the passage itself is not touched).
  Pick ONE content word or short fixed phrase that ACTUALLY APPEARS in the passage and matters
  to its meaning (not a throwaway function word). Write an English dictionary-style definition
  of it AS USED IN THIS PASSAGE — never use the word itself, an obvious cognate, or a word
  built on the same root anywhere in the definition.
  choices = 5 English words/short phrases, ALL of them content words that actually appear in
  the passage (so a student who hasn't read the passage can't just recognize a random
  dictionary word) — one is the word you defined, the other 4 are OTHER passage words of
  similar part of speech and difficulty that the definition does NOT fit. answer = the defined
  word's position. Never choose 5 near-synonyms — a careful reader must be able to rule out
  4 of them by matching the definition, not by vocabulary trivia alone.
- "영영풀이 오류 찾기" — instruction "다음 글의 밑줄 친 부분의 영영풀이로 적절하지 않은
  것은?". 영영풀이와 재료(단어+영어 정의)는 같지만, 한 단어에 정의 하나씩이 아니라
  **다섯 쌍**을 한꺼번에 보여주고 그중 잘못 짝지어진 것을 고르게 한다.
  · `passageHtml` = 지문 전문에서 내용어 5개를 골라 각각 circled number를 붙여
    <u>…</u>로 감싸고, 그 낱말 바로 뒤에 괄호로 영영풀이를 단다 — 예:
    "the animal remained largely <u>①unnoticed</u>(without attracting attention) by
    predators". 정의는 <u> 밖에 평문으로 쓴다(정의 자체에는 밑줄 치지 마라).
  · 다섯 중 넷은 그 낱말이 **이 지문에서 실제로 쓰인 뜻**과 맞는 정의를 쓴다.
    나머지 하나는 그럴듯하지만 **틀린** 정의를 쓴다 — 가장 확실한 방법은 방향이
    반대인 정의를 쓰는 것이다(예: melt를 "to cause a solid to become liquid"가
    아니라 "to cause a liquid to become solid"라고 뒤집기), 또는 그 낱말의 다른
    뜻(문맥에 안 맞는 의미)을 정의로 준다.
  · 정의에는 그 낱말 자체나 같은 어근을 쓰지 마라(영영풀이 유형과 같은 규칙).
  choices = ["①","②","③","④","⑤"] in that literal order; answer = 정의가 틀린
  것의 위치.
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
- "함축의미" — instruction "밑줄 친 부분이 의미하는 바로 가장 적절한 것은?"
  Pick ONE stretch of the passage (a clause or a whole sentence) whose meaning is NOT literal —
  비유·은유·반어·관용 표현, or a phrase that only makes sense from the surrounding context.
  A plain factual statement is the wrong choice: if its meaning is obvious on the surface,
  every distractor becomes obviously wrong and the question tests nothing.
  · `passageHtml` = the WHOLE passage, verbatim, with that stretch wrapped in <u>…</u>.
    EXACTLY ONE underlined stretch may exist, so that "밑줄 친 부분" is unambiguous.
    Add no other marking — no (A), no ①, no bold.
  · choices = 5 ENGLISH statements, each a plain-language reading of the underlined part.
  · answer = the ONE that restates what the writer actually means by it.
  ⚠️ The other four must be readings a student could mistake for the answer AND that the
  passage rules out — a literal reading of the figure, an opposite, an over-generalisation,
  a cause/effect swap. NEVER write a distractor that is simply "true elsewhere in the passage
  but not what this part means": that statement is defensible too, so the item would have two
  answers. Every wrong choice must be checkable as wrong against the passage itself.
- "서술형배열" (format "write") — instruction
  "위 글의 밑줄 친 문장과 의미가 같도록 주어진 단어를 배열하여 문장을 완성하시오."
  Pick ONE key sentence of the passage (주제문이나 핵심 문장, 8~20 words).
  · `answerText` = that English sentence, VERBATIM from the passage.
  · `passageHtml` = the WHOLE passage, with ONLY that one sentence replaced by its Korean
    translation, wrapped in <u><b>…</b></u> — like this, in place of the English sentence:
      <u><b>우리가 지난달 박람회를 공지했음에도 불구하고, 학생의 등록이 우리가 예상했던
      것보다 훨씬 더 저조하다.</b></u>
    Underline and bold are the ONLY marking — do not add (A), ①, or any other label.
    Exactly ONE underlined stretch may exist in the whole passage, so that "밑줄 친 문장"
    is unambiguous. Every OTHER sentence stays in English, verbatim and in its original
    place — the student reads that surrounding English for context.
    ⚠️ The English of the underlined sentence must appear NOWHERE in `passageHtml` — that
    would give the answer away. Only its Korean translation appears there.
    Do NOT put the scrambled word bank in `passageHtml`; the app builds it from `answerText`.
    The Korean translation must be natural 문어체 that maps clearly onto the English word
    order the student has to produce (어순 단서가 되도록 직역에 가깝게).
  · choices = [], answer = 0.
- "조건 영작" (format "compose") — instruction
  "위 글의 밑줄 친 우리말과 뜻이 같도록, <보기>의 낱말을 모두 사용하여 <조건>에 맞게 영작하시오."
  지문을 만드는 방법은 "서술형배열"과 똑같고, 학생이 하는 일이 다르다 — 낱말이 원형으로
  주어져 형태를 스스로 정해야 하고, 문법 조건이 함께 걸린다.
  Pick ONE sentence of the passage (8~20 words) that ACTUALLY USES a grammar structure worth
  demanding (관계사절, 분사구문, 수동태, to부정사, 비교급, 가정법, 도치 …).
  · `answerText` = that English sentence, VERBATIM from the passage. 이것이 모범답안이다.
  · `passageHtml` = the WHOLE passage, with ONLY that one sentence replaced by its Korean
    translation wrapped in <u><b>…</b></u> — same rules as "서술형배열":
    그 문장의 영어는 `passageHtml` 어디에도 남아 있으면 안 되고, 밑줄 친 곳은 지문 전체에
    정확히 하나뿐이며, 나머지 문장은 전부 영어 원문 그대로 제자리에 둔다.
    우리말 번역은 영어 어순이 비치는 문어체로 쓴다(학생이 어순 단서를 얻을 수 있게).
  · `wordBank` = 4~8개. `answerText`의 내용어(동사·명사·형용사·부사)를 골라 **사전형**으로
    적는다 — be, have, go, child (was, had, went, children이 아니다).
    관사·전치사·대명사 같은 기능어는 넣지 않는다. 학생이 채워야 할 몫이다.
    ⚠️ 굴절형을 그대로 주면 낱말을 늘어놓기만 하면 되는 배열 문제가 되어 버린다.
    ⚠️ `answerText`에 실제로 들어 있는 낱말만 넣어라. 쓰이지 않는 낱말을 끼우면
    '모두 사용할 것' 조건과 모범답안이 어긋난다.
  · `conditions` = 2개. 이 순서로 적는다:
      ① "<보기>의 낱말을 모두 사용하되, 필요하면 형태를 바꿀 것"
      ② 그 문장이 **실제로 쓰고 있는** 문법 하나를 집어 요구한다
         (예: "관계대명사를 사용할 것", "분사구문으로 쓸 것", "수동태로 쓸 것").
         ⚠️ `answerText`가 정말 그 구조인지 확인하고 적어라. 쓰지 않는 문법을 요구하면
         모범답안이 제 조건을 어긴 셈이 되어 채점이 불가능하다.
      낱말 수 조건("총 N단어로 쓸 것")은 **적지 마라** — 앱이 answerText를 세어 붙인다.
  · choices = [], answer = 0, tfItems = [], fixes = [], findItems = [], glossItems = [].
- "문장 전환" (format "convert") — instruction
  "다음 글의 밑줄 친 문장을 <조건>에 맞게 바꿔 쓰시오."
  Pick ONE sentence of the passage (8~25 words) that GENUINELY ADMITS the transformation you
  are about to demand. 원문에 그 구조가 없으면 그 문장은 고르지 마라.
  · `passageHtml` = the WHOLE passage, verbatim, with ONLY that one sentence wrapped in
    <u><b>…</b></u>. 영어는 그대로 둔다 — 학생은 눈에 보이는 문장을 고쳐 쓴다.
    밑줄 친 곳은 지문 전체에 정확히 하나뿐이고, 그 밖의 것은 무엇도 바꾸지 않는다.
  · `answerText` = 바꿔 쓴 문장(모범답안). 어법상 완전해야 하고, 뜻이 원문과 같아야 한다.
  · `conditions` = 1~2줄. 무엇으로 바꾸는지 우리말로 적는다. 예:
      "수동태 문장으로 바꿔 쓸 것" / "분사구문을 사용할 것" /
      "관계대명사를 사용하여 한 문장으로 쓸 것" / "가주어 It으로 시작할 것" /
      "간접의문문으로 바꿔 쓸 것" / "too ~ to 구문으로 바꿔 쓸 것"
  · 고를 수 있는 전환 — 원문이 그 구조를 갖고 있을 때만:
      능동태 → 수동태 (타동사와 목적어가 있어야 한다)
      부사절 → 분사구문 (When/Because/While/As + S + V 가 있어야 한다)
      두 문장·관계절 ↔ 한 문장 (같은 대상을 가리키는 명사가 있어야 한다)
      to부정사·that절 주어 → 가주어 It ~ (또는 그 반대)
      so ~ that … → too ~ to / enough to (뜻이 같아지는 경우에만)
      직접의문문 → 간접의문문 (의문사절이 목적어 자리에 들어갈 수 있어야 한다)
  ⚠️ `answerText`는 밑줄 친 원문과 **반드시 달라야** 한다. 같으면 바꾼 것이 없다.
  ⚠️ 원문에 없는 정보를 더하거나 빼지 마라 — 뜻이 그대로여야 채점할 수 있다.
  ⚠️ 한 지문에서 여러 문항을 낼 때는 **문장도 전환 종류도 서로 겹치지 않게** 하라.
  · choices = [], answer = 0, tfItems = [], fixes = [], findItems = [], glossItems = [],
    wordBank = [].
- "질문에 답하기" (format "answer") — passageHtml = 지문 전문(OMIT when 지문 재사용 is on,
  same as the other QUIZ_PLAIN_PASSAGE_TYPES). 지문은 전혀 손대지 않는다 — 표시도 변형도 없다.
  `instruction` = "다음 글을 읽고, 질문에 대한 답을 완전한 영어 문장으로 쓰시오." 다음 줄에
  질문을 영어로 붙인다:
    다음 글을 읽고, 질문에 대한 답을 완전한 영어 문장으로 쓰시오.<br><br>
    <b>Q:</b> How does the painting differ from typical art of that time?
  이 유형은 지문 속 문장을 그대로 찾거나 옮기는 게 아니다 — **질문을 이해하고, 지문 내용을
  근거로 학생이 직접 새 문장을 짓게** 하는 것이 핵심이다. 서술형배열·조건 영작과 헷갈리지
  마라 — 그 둘은 지문에 '이미 있는' 문장을 재료로 쓰지만, 이 유형의 질문은 지문 어디에도
  그 형태로 적혀 있지 않은 새로운 문장을 요구한다.
  · 질문 만들기: 지문의 핵심 정보 하나(원인·비교·정의·이유·과정 등)를 짚어 영어 의문문으로
    쓴다. 답이 지문 한 군데에 명확히 있어야 한다 — 추론에 추론을 거듭해야 답이 나오는
    질문, 또는 답이 여러 갈래로 갈리는 질문은 쓰지 마라.
  · `answerText` = 그 질문에 대한 모범답안. 지문 내용을 바탕으로 학생이 실제로 쓸 법한,
    문법적으로 완전한 영어 문장 하나. 지문 문장을 토씨 하나 안 틀리고 베낀 것이면 안 된다
    — 질문에 맞게 재구성하거나 표현을 바꿔야 한다(다만 지문에 없는 사실을 지어내지는 마라).
  · `conditions` = 1~3줄, 다음 중 실제로 거는 것만 우리말로 적는다(전부 걸 필요는 없다):
      "답변으로 주어진 단어 'It'으로 시작할 것" 처럼 답의 시작을 지정 —
        지정했으면 answerText도 반드시 그 단어로 시작해야 한다.
      "주어와 동사를 갖춘, 문법적으로 완성된 문장으로 답을 작성할 것"
      "10단어 이내로 완성할 것" 처럼 분량 제한 — 지정했으면 answerText가 그 안에 들어야 한다.
    낱말 수를 세는 건 네 몫이다(서버가 다시 세지 않는다) — 조건에 적은 숫자와 answerText가
    어긋나지 않게 스스로 확인하라.
  · `wordBank` = 선택. 답에 반드시 들어가야 하는 표현을 줄 때만 채운다(3~6개). 채웠으면
    conditions에 "<보기>의 표현을 모두 사용할 것"과, 형태를 바꿔도 되는지("필요하면 형태를
    바꿀 것" 또는 "형태 변형 없이 사용할 것")를 반드시 함께 적어라. 안 줄 때는 빈 배열로
    두고, 학생이 자유롭게 단어를 골라 쓰게 한다.
  ⚠️ 한 지문에서 여러 문항을 낼 때는 **질문마다 지문의 다른 대목을 짚어라** — 같은 문장을
  근거로 삼는 질문을 두 개 내면 사실상 같은 문제의 반복이다.
  · choices = [], answer = 0, tfItems = [], fixes = [], findItems = [], glossItems = [].
- "요약문 완전구성형" (format "compose") — passageHtml = 지문 전문(OMIT when 지문 재사용 is
  on — QUIZ_PLAIN_PASSAGE_TYPES와 같다. "요약문 완성"과 달리 이 유형은 지문을 전혀
  손대지 않는다). `instruction` = "다음 글의 내용을 한 문장으로 요약하고자 한다. <보기>의
  낱말을 모두 사용하여 요약문을 완성하시오."
  이 유형은 "요약문 완성"(빈칸 두 곳만 채움)과 다르다 — 학생이 요약 문장 **전체를
  새로 짓는다**. "조건 영작"과 재료(wordBank·conditions)는 닮았지만 대상이 다르다 —
  조건 영작은 '지문 속에 이미 있는 문장'을 우리말 보고 재현하는 것이고, 이 유형은
  '지문에 없는, 요약이라는 새 문장'을 짓는 것이다. 그래서 밑줄 친 우리말 문장도,
  숨겨야 할 원문 영어도 없다 — passageHtml은 그냥 지문 전문이다.
  · `answerText` = 모범 요약 문장 하나(영어). 지문 전체(도입부만이 아니라)를 압축해야
    하고, 문법적으로 완전한 한 문장이어야 한다.
  · `wordBank` = 4~7개. `answerText`의 내용어(동사·명사·형용사·부사)를 **사전형**으로
    적는다(조건 영작과 같은 규칙 — 굴절형 금지). `answerText`에 실제로 쓰인 낱말만
    넣는다.
  · `conditions` = 2개, 이 순서로:
      ① "<보기>의 낱말을 모두 사용하되, 필요하면 형태를 바꿀 것"
      ② "한 문장으로 쓸 것"
    낱말 수 조건은 적지 마라 — 앱이 answerText를 세어 붙인다.
  ⚠️ 요약문은 지문의 **결론이나 전체 요지**를 담아야 한다 — 도입부 사실 하나만 옮기면
  요약이 아니라 발췌다.
  · choices = [], answer = 0, tfItems = [], fixes = [], findItems = [], glossItems = [].
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
  choices = [], answer = 0, answerText = "", fixes = [], findItems = [], glossItems = [].
- "동사형 쓰기" (format "verb") — instruction
  "다음 글의 괄호 안에 주어진 말을 문맥과 어법에 맞게 알맞은 형태로 고쳐 쓰시오."
  `passageHtml` = 3~6 sentences taken from the passage, PLAIN TEXT ONLY (no HTML tags at all),
  with 4~6 VERB GROUPS replaced by (힌트|정답):
    · left of `|`  = the base words the student sees, comma-separated, in the order they
      combine. A verb group made of several words lists them all: 조동사·be·have + 본동사.
      Give them in DICTIONARY form (have, be, dump) — never the inflected answer.
    · right of `|` = the exact inflected string the passage actually has, verbatim.
  Example: "People (have, be, dump|have been dumping) their waste where it (not, permit|is
  not permitted)." — strip the markup and the sentence must read exactly as the passage does.
  Cover a MIX of 시제·상·수일치·태·to부정사·동명사·분사; include verbals, not only 정동사.
  Never mark a verb whose form is obvious from the base words alone (a bare present tense
  that needs no change) — the student must actually decide something.
  RULES: no nested parentheses; the left side never contains `|`; everything outside ( ) is
  identical to the passage, character for character.
  choices = [], answer = 0, answerText = "", tfItems = [], fixes = [], findItems = [], glossItems = [].
- "표현 찾아 쓰기" (format "find") — instruction
  "아래 우리말과 뜻이 같은 영어 표현을 윗글에서 찾아 쓰시오."
  The ONLY type that leaves the passage alone and puts a list beside it.
  · `passageHtml` = the passage in full, verbatim, PLAIN TEXT with no marking of any kind.
    The answers must still be visible in it — the student's job is to FIND them.
  · `findItems` = 3~4 items {ko, en}:
      en = a phrase copied VERBATIM from the passage, 2~6 words, a meaningful unit
           (동사구, 명사구, 전치사구, 관용표현). Never a whole sentence, never a single
           common word.
      ko = its natural Korean meaning, 문어체, written so that exactly one phrase in the
           passage matches it. Keep the part of speech: 동사구는 "~하다"로, 명사구는 명사로.
    List them in the order the phrases appear in the passage.
  ⚠️ Each `en` must occur EXACTLY ONCE in the passage, and no two items may overlap or share
  words. If a Korean meaning could point at two different phrases, the item has two answers —
  pick a different phrase instead.
  choices = [], answer = 0, answerText = "", tfItems = [], fixes = [], glossItems = [].
- "영영풀이 쓰기" (format "gloss") — instruction
  "다음 영영풀이에 해당하는 낱말을 윗글에서 찾아 쓰시오."
  Same shape as "표현 찾아 쓰기" — the passage is left alone and a list sits beside it — but
  the clue is an ENGLISH definition instead of a Korean meaning, and the answer is a single
  WORD (occasionally a short fixed two-word unit — phrasal verb, compound), not a phrase.
  · `passageHtml` = the passage in full, verbatim, PLAIN TEXT with no marking of any kind.
    The answer word must still be visible in it — the student's job is to FIND it.
  · `glossItems` = 2~4 items {def, en}:
      en = ONE content word copied VERBATIM from the passage as it appears there (keep its
           inflection — -s/-ed/-ing — exactly). Occasionally a fixed two-word unit (phrasal
           verb like "give up") is fine; never a longer phrase and never a whole sentence.
      def = an English dictionary-style definition of that word AS USED IN THIS PASSAGE —
           NEVER use the word itself, an obvious cognate, or a word sharing its root anywhere
           in the definition. Specific enough that exactly one word in the passage fits it.
    List them in the order the words appear in the passage.
  ⚠️ Each `en` must occur EXACTLY ONCE in the passage, and no two items may share the same
  word or overlap. Pick words whose meaning is actually worth testing (관용표현·핵심 어휘) —
  never an article, pronoun, or other function word.
  choices = [], answer = 0, answerText = "", tfItems = [], fixes = [], findItems = [].
- "다의어 문맥의미 매칭형" (format "find") — instruction
  "다음 글에서 밑줄 친 낱말 ①~은 아래 <보기> 중 어느 뜻으로 쓰였는지 기호를 쓰시오."
  ⚠️ 이 유형은 지문에 **같은 철자의 한 단어가 서로 다른 뜻으로 3번 이상** 쓰일 때만
  성립한다(예: as가 '~함에 따라'와 '~로서'로 각각 쓰이는 경우). 그런 낱말이 지문에
  실제로 없으면 이 유형을 만들지 마라 — 억지로 만들면 답이 하나로 안 정해진다.
  흔한 후보: as, that, since, while, for, like, once, so, well, still, before, right,
  even, just(문맥에 따라 전치사·접속사·부사·형용사로 뜻이 갈리는 기능어들).
  · `passageHtml` = the passage verbatim, with EVERY occurrence of the target word (3~5
    of them) wrapped as a circled-numbered underline in reading order — ①<u>as</u>,
    ②<u>as</u>, ③<u>as</u> … (같은 규칙: circled number는 <u> 바로 앞, 밖에 둔다).
    그 뒤에 <br><br>로 이어, 이 단어가 지문에서 실제로 갖는 **서로 다른 뜻**을 우리말
    보기로 나열한다(2~4개 — 뜻의 가짓수이지 낱말 등장 횟수가 아니다. 등장은 5번이어도
    뜻은 2~3가지로 겹칠 수 있다):
      &lt;보기&gt;<br>
      ㄱ. ~함에 따라(비례)<br>
      ㄴ. ~로서(자격)<br>
      ㄷ. ~ 때(시간)
    보기 순서는 지문 등장 순서와 무관하게 둬도 된다(사전식이든 임의든) — 어차피 답을
    번호마다 기호로 적으므로 순서 자체는 단서가 아니다.
  · `findItems` = 등장한 낱말 개수만큼(3~5개), 지문에 나온 순서대로 {ko, en}:
      ko = 그 번호 라벨 그대로, 예: "①"
      en = 그 자리에 맞는 보기 기호, 예: "ㄴ"
    ⚠️ 최소 두 개의 서로 다른 기호가 실제로 쓰여야 한다 — 답이 전부 같은 기호면
    '문맥마다 다른 뜻'을 확인하는 문제가 아니라 반복 확인 문제가 된다.
  · <보기>의 각 뜻은 실제로 하나 이상의 밑줄과 짝지어져야 한다 — 어느 밑줄과도 맞지
    않는 보기 항목을 넣지 마라(선택형과 달리 오답 매력을 위한 미끼 항목을 두는 유형이
    아니다).
  choices = [], answer = 0, answerText = "", tfItems = [], fixes = [], glossItems = [].
- "빈칸 쓰기" (format "fill") — instruction
  "다음 글의 빈칸에 들어갈 알맞은 낱말을 윗글에서 찾아 쓰시오."
  `passageHtml` = the passage (or 4~8 consecutive sentences of it), PLAIN TEXT ONLY
  (no HTML tags at all), with 2~4 KEY CONTENT WORDS replaced by (|정답):
    · left of `|` = ALWAYS EMPTY. Write nothing there — no letter, no dots, no underscore.
      The student gets a bare blank.
    · right of `|` = the word exactly as the passage has it (keep the -s, -ed, -ing ending).
  Example: "Real change is expensive and slow, while a press release (|costs) almost nothing."
  ⚠️ No first-letter hint is given, so the answer must be PINNED, not merely plausible.
  Blank a word ONLY when the same word (or its obvious base form) still appears SOMEWHERE
  ELSE in `passageHtml` — a repeated key term, a word picked up again later, a term the
  passage itself defines. The student's job is to find it in the text and copy it.
  Never blank a word that has to be supplied from outside the passage: with a bare blank,
  any synonym (ignored / overlooked / neglected) is a defensible answer and the item breaks.
  If the passage has fewer than 2 such words, produce fewer items rather than reaching.
  Do not blank two words in the same clause, and never blank the same word twice.
  RULES: no nested parentheses; the left side is empty; everything outside ( ) is identical
  to the passage, character for character.
  choices = [], answer = 0, answerText = "", tfItems = [], fixes = [], findItems = [], glossItems = [].
- "무관한 문장 쓰기" (format "short") — instruction
  "다음 글에서 전체 흐름과 관계 없는 문장을 찾아 그대로 옮겨 쓰시오."
  주관식판이다. 객관식 "무관한 문장"과 심는 방법은 같고, 번호를 붙이지 않는다 —
  학생이 ①~⑤ 중에서 고르는 것이 아니라 스스로 찾아 옮겨 적는다.
  `passageHtml` = the passage rebuilt as ONE plain paragraph, NO circled numbers, NO markup:
    · the passage's first 2 sentences, verbatim, as the opening;
    · then 4 more of the passage's own sentences, verbatim and in their original order;
    · plus ONE sentence YOU write and INSERT among them — that inserted sentence is the answer.
  ⚠️ The inserted sentence follows the SAME two rules as "무관한 문장" above:
  (a) SAME SUBJECT MATTER — reuse the passage's own nouns and key terms, introduce no new
  topic; (b) DIFFERENT CONCERN — a claim the passage never argues toward.
  ⚠️ Insert it in the MIDDLE — after at least 2 of the passage's own sentences have followed
  the opening, and never as the last sentence (the passage must still end on its own note).
  ⚠️ Change nothing else. If one of the passage's own sentences would read as more off-topic
  than the one you inserted, the item has no defensible answer — move the insertion and rewrite.
  `answerText` = the inserted sentence, character for character as it appears in passageHtml.
  choices = [], answer = 0, tfItems = [], fixes = [], findItems = [], glossItems = [].
- "요약문 완성" (format "short") — instruction
  "다음 글의 내용을 한 문장으로 요약하고자 한다. <보기>에서 알맞은 낱말을 골라 빈칸 (A), (B)에 쓰시오."
  `passageHtml` = three parts joined by <br><br> :
    1. the passage, verbatim;
    2. ONE English summary sentence compressing the WHOLE passage, with exactly two blanks
       written as "(A)______________" and "(B)______________";
    3. a word bank on one line, exactly in this shape:
       &lt;보기&gt; word1 / word2 / word3 / word4 / word5 / word6
  The two blanked words must be the summary's two load-bearing ideas — typically the property
  the passage attributes to its subject and the consequence that follows. Never blank a word
  recoverable from grammar alone (article, preposition, generic noun).
  ⚠️ THE WORD BANK IS WHAT MAKES THIS GRADEABLE. With a bare blank, any synonym is a
  defensible answer and the item breaks (같은 이유로 "빈칸 쓰기"는 본문에 실제로 다시 나오는
  낱말만 뚫는다). So the bank must contain EXACTLY 6 words: the 2 correct ones plus 4
  distractors. Every distractor must be wrong for a reason the passage actually supplies — a
  word the passage CONTRADICTS — never a word that is merely odd or off-topic. Put the 6 words
  in a scrambled order, not with the answers first.
  ⚠️ No word in the bank may fit either blank except the intended one. If a distractor would
  also read correctly in (A) or (B), replace it.
  `answerText` = "(A) word  (B) word" using the two correct words.
  choices = [], answer = 0, tfItems = [], fixes = [], findItems = [], glossItems = [].
- "틀린 어휘 찾기" (format "fix") — instruction
  "다음 글에서 문맥상 낱말의 쓰임이 적절하지 않은 것을 모두 찾아 바르게 고쳐 쓰시오."
  `passageHtml` = one paragraph of the passage, PLAIN TEXT ONLY, identical to the original
  EXCEPT that exactly 2~3 words are replaced by contextually WRONG words (주로 반의어).
  `fixes` = one {wrong, right} per replaced word: `wrong` = the word you planted (must appear
  VERBATIM in passageHtml), `right` = the original word from the passage.
  The app underlines the planted words and prints the correction lines.
  choices = [], answer = 0, answerText = "", findItems = [], glossItems = [].
- "틀린 어법 찾기" (format "fix") — instruction
  "다음 글에서 어법상 틀린 부분을 모두 찾아 바르게 고쳐 쓰시오."
  Same mechanics as 틀린 어휘 찾기, but plant 2~3 GRAMMAR errors instead
  (주어-동사 수일치 오류, 시제/태 오류, to부정사↔동명사 오용, 관계사 오용, 병렬 파괴 등).
  `fixes` = {wrong: the ungrammatical form you planted, right: the original correct form}.
  choices = [], answer = 0, answerText = "", findItems = [], glossItems = [].
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


def build_quiz_user_prompt(passage, items, short_hint=None, explain_hint=None,
                           variation="verbatim", target_grammar=""):
    """items = [(유형, 문항수)] — 유형마다 몇 문항인지가 요청에 그대로 들어 있다."""
    types = [t for t, _ in items]
    count = sum(n for _, n in items)
    lines = [
        f"지문 변형 정도: {QUIZ_VARIATIONS.get(variation, QUIZ_VARIATIONS['verbatim'])}",
        "허용된 문제 유형과 유형별 문항 수: "
        + ", ".join(f"{t} {n}문항" for t, n in items),
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
        # 화면은 유형 선택 칸에 놓인 순서가 곧 출제 순서라고 안내하고 그 순서대로
        # 보내므로, 받은 순서와 실제 출제 순서가 반드시 일치해야 한다.
        "⚠️ 문항 순서: 위 목록에 나열된 유형 순서 그대로 questions 배열에 담으세요. "
        "같은 유형을 여러 문항 낼 때는 그 유형의 문항들을 연달아 배치하세요.",
        "⚠️ 유형별 문항 수를 정확히 지키세요. 어느 유형도 빠뜨리거나 더 만들지 마세요.",
    ]
    if any(n > 1 for _, n in items):
        # 같은 유형을 여러 문항 낼 때가 품질이 제일 잘 무너지는 지점이다 — 선지만
        # 조금 바꾼 사실상 같은 문제가 나오기 쉬우므로 무엇을 다르게 해야 하는지
        # 유형 성격별로 구체적으로 지시한다.
        lines.append(
            "⚠️ 같은 유형을 2문항 이상 낼 때는 서로 확실히 다른 문제여야 합니다. "
            "정답의 근거가 되는 지문의 부분이 서로 달라야 하고, 정답 선지의 표현도 "
            "매번 새로 쓰세요. 주제·제목·요지처럼 정답 내용이 하나로 정해지는 유형은 "
            "정답을 다른 말로 바꿔 쓰고 오답 선지를 완전히 새로 구성하세요. "
            "빈칸·어휘·어법은 지문의 서로 다른 위치를 고르세요. "
            "내용일치·OX진위는 매번 다른 사실을 다루세요."
        )
    # 목표 어법 — 이번 단원에서 가르친 문법을 그대로 시험에 내기 위한 지시.
    # 어법 계열 유형이 이번 호출에 실제로 들어 있을 때만 붙인다.
    #
    # 요점은 '밑줄 다섯 개를 전부 그 문법으로 채우라'가 아니라 '학생이 찾아내야 하는
    # 정답 자리를 그 문법으로 하라'는 것이다. 나머지 밑줄까지 같은 포인트로 채우면
    # 무엇을 고르는 문제인지 흐려진다.
    #
    # 지문에 그 문법이 없을 때 억지로 끼워 넣으라고 하지 않는다 — 없는 구조를 우겨넣으면
    # 지문이 어색해지고, 원문(교과서·기출)과 달라진 것을 선생님이 알아채기 어렵다.
    # 그런 경우에는 지금까지처럼 지문에 있는 문법으로 낸다.
    grammar_types = [t for t in types if t in QUIZ_GRAMMAR_TYPES]
    target_grammar = (target_grammar or "").strip()
    if target_grammar and grammar_types:
        lines.append(
            f"목표 어법: {target_grammar} — {', '.join(sorted(set(grammar_types)))} 문항은 "
            "학생이 찾아내야 하는 자리(정답이 되는 밑줄·네모·괄호)를 이 문법 포인트로 "
            "잡으세요. 나머지 보기는 다른 포인트로 채워 무엇을 묻는 문제인지 흐려지지 "
            "않게 합니다. 조건 영작·문장 전환은 찾아내는 자리가 없는 대신 <조건>으로 "
            "요구하는 문법을 이 포인트로 잡고, 그 문법을 실제로 쓰고 있는 문장을 고르세요. "
            "목표 어법을 쉼표로 여럿 적었으면 문항마다 하나씩 돌아가며 "
            "배정하세요. 다만 지문에 그 문법이 쓰인 곳이 없으면 억지로 지문을 고쳐 넣지 "
            "말고, 지문에 실제로 있는 문법으로 평소대로 출제하세요."
        )
    if short_hint is not None:
        # 어떤 유형이 몇 문항 모자랐는지 짚어 주는 편이 재요청 한 번에 채워질 확률이 높다.
        if isinstance(short_hint, (list, tuple, set)) and short_hint:
            lines.append(
                f"⚠️ 이전 시도는 {', '.join(short_hint)}이(가) 모자랐습니다. "
                f"이번에는 유형별 문항 수를 지켜 {count}문항을 끝까지 모두 생성하세요."
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
# 경계 조건이 중요하다. '낱말이 실제로 쪼개진 경우'에만 넓혀야 한다 — 즉 밑줄 태그
# 반대쪽에도 영문자가 붙어 있어야 한 낱말이 갈린 것이다. 이 조건이 없으면 서술형배열의
# 한글 밑줄 문장 뒤에 공백 없이 영어가 오는 순간(…저조하다.</u>Therefore) 그 영어까지
# 밑줄 안으로 끌려 들어가, 밑줄 친 문장이 어디까지인지 되레 어긋난다.
_U_TAIL_RE = re.compile(r"(?<=" + _WORD_CH + r")</u>(" + _WORD_CH + r"+)")
_U_HEAD_RE = re.compile(r"(" + _WORD_CH + r"+)<u>(?=" + _WORD_CH + r")")


def fix_underline_bounds(html):
    """<u>…</u>가 낱말을 잘라 먹었으면 낱말 전체를 감싸도록 넓힌다."""
    if not html or "<u>" not in html:
        return html
    html = _U_TAIL_RE.sub(r"\1</u>", html)  # </u> 뒤에 붙은 글자를 안으로
    html = _U_HEAD_RE.sub(r"<u>\1", html)   # <u> 앞에 붙은 글자를 안으로
    return html


_WORD_COUNT_RE = re.compile(r"[A-Za-z0-9']+(?:-[A-Za-z0-9']+)*")


def count_english_words(text):
    """영어 문장의 낱말 수 — 조건 영작의 '총 N단어로 쓸 것'에 쓴다.

    모델에게 세라고 시키지 않는 이유: 낱말 세기는 자주 틀리는데, 이 숫자가 틀리면
    모범답안이 제 조건을 어긴 셈이 되어 채점 자체가 불가능해진다. answerText만 있으면
    기계로 정확히 셀 수 있는 값이므로 여기서 센다.
    하이픈으로 묶인 말(well-being)은 시험지 관행대로 한 낱말로 세고, 문장부호는 세지 않는다."""
    return len(_WORD_COUNT_RE.findall(str(text or "")))


def attach_word_count_condition(q):
    """조건 영작의 <조건>에 '총 N단어로 쓸 것'을 붙인다(N은 모범답안에서 직접 센다).

    모델이 적어 온 낱말 수 조건이 있으면 버리고 다시 센다 — 세다 틀리면 모범답안이
    제 조건을 어긴 셈이 되어 채점이 불가능해지기 때문이다."""
    n = count_english_words(q.get("answerText"))
    conds = q.get("conditions")
    conds = [c for c in conds if isinstance(c, str) and c.strip()] if isinstance(conds, list) else []
    conds = [c for c in conds if "단어로 쓸 것" not in c]
    q["conditions"] = conds + ([f"총 {n}단어로 쓸 것"] if n else [])
    return q


def call_gemini_quiz(passage, items, api_key, model, short_hint=None,
                      explain_hint=None, variation="verbatim", target_grammar=""):
    """items = [(유형, 문항수)]. 개수 상한은 parse_quiz_items가 이미 적용해 둔다."""
    api_key = (api_key or "").strip() or os.environ.get("GEMINI_API_KEY", "").strip()
    if not api_key:
        raise RuntimeError(
            "관리자가 아직 서버에 Gemini API 키(GEMINI_API_KEY)를 설정하지 않았습니다. "
            "관리자에게 문의하세요."
        )
    model = model if (model and _MODEL_RE.match(model)) else MODEL
    items = list(items or ()) or [("주제", 1), ("제목", 1), ("요지", 1)]
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
                    passage, items, short_hint, explain_hint, variation, target_grammar
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
        for key in ("conditions", "wordBank"):
            lst = q.get(key)
            if isinstance(lst, list):
                q[key] = [sanitize_quiz_html(s) if isinstance(s, str) else s for s in lst]
        # 조건 영작의 낱말 수 조건은 모델이 아니라 여기서 붙인다
        if q.get("type") == "조건 영작":
            attach_word_count_condition(q)
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


# ══════════════ 단어장 탭 — 사진·PDF에서 단어 목록 가져오기 ══════════════
# 지문 분석 없이도 단어장을 만들 수 있게, 사진(교과서 단어장 페이지·손글씨 목록)과
# PDF(교과서 단원 끝 단어장 등)에서 곧바로 단어 목록을 뽑아낸다. 출력 모양은 지문
# 분석의 vocab 항목({word, pos, meaning, synonym, antonym})과 같다 — 단어장 탭
# 아래쪽(정렬·중복 합치기·인쇄) 로직을 그대로 재사용하기 위해서다.
VOCAB_ITEMS_SCHEMA = {
    "type": "OBJECT",
    "properties": {
        "items": {
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
        "note": {"type": "STRING"},
    },
    "required": ["items", "note"],
    "propertyOrdering": ["items", "note"],
}

VOCAB_OCR_SYSTEM_PROMPT = r"""You transcribe a vocabulary list from ONE photo of Korean
school material — a textbook 단어장 page, a teacher-made word list, flashcards, or a
handwritten word list. Return ONLY the structured JSON in the schema — no markdown, no
commentary.

## Output — one entry per word, in the order they appear in the photo
- `word`: the English word or fixed expression, copied exactly as printed/written. Keep the
  base form shown — do not add or remove endings, do not fix spelling.
- `pos`: the part of speech ONLY if explicitly marked (e.g. "n.", "v.", "adj.", "adv.") —
  otherwise "". NEVER guess a part of speech that isn't marked in the photo.
- `meaning`: the Korean meaning exactly as printed/written next to the word. If more than one
  meaning is given, join them with "; ". NEVER invent or add a meaning the photo doesn't show,
  and never translate the word yourself when no Korean meaning appears — set `meaning` to ""
  and mention it in `note` instead.
- `synonym` / `antonym`: ONLY if the photo explicitly marks them (e.g. "유=", "반=", "syn:",
  "ant:", "↔"); otherwise "".

## Transcribe, don't invent
- If handwriting or a smudge makes a word or its meaning unreadable, SKIP that entry entirely
  rather than guessing — a wrong entry silently corrupts the teacher's word list. Count how
  many you skipped and say why in `note`.
- If the photo has no vocabulary list at all (it's a passage, a worksheet, something else),
  set `items` to [] and say so in `note`.

## note (Korean, short)
- "" when the photo was clean and every entry was read.
- Otherwise one sentence stating the concrete problem: 흐려서 못 읽은 항목 수, 필기에 가려진
  항목, 뜻이 안 보여 비워 둔 단어 수 등.

Return valid JSON only."""

VOCAB_PDF_SYSTEM_PROMPT = r"""You receive raw text mechanically extracted from a PDF page
(a textbook vocabulary list or teacher-made word list). The extraction can scramble reading
order — a 2-column page may come through as all English words first, then all Korean meanings
after, or lines can be split oddly — and it can merge or drop whitespace. Your job is to
recover the intended word↔meaning pairs. Return ONLY the structured JSON in the schema — no
markdown, no commentary.

## Output — one entry per word
Same field rules as reading from a photo:
- `word`: the English word/expression, copied from the text as given (fix nothing).
- `pos`: ONLY if explicitly marked in the text (e.g. "n.", "v.") — otherwise "".
- `meaning`: the Korean meaning as given, joined with "; " if there are several. NEVER invent
  a meaning that isn't in the text.
- `synonym` / `antonym`: ONLY if explicitly marked (e.g. "유=", "반=", "syn:", "ant:") —
  otherwise "".

## When order is scrambled
If a word's meaning was clearly separated from it by column-scrambling (e.g. a run of English
words followed by a run of Korean meanings in the same count and rough order), re-pair them by
position. If you cannot pair a word with its meaning confidently, DROP that entry rather than
guessing — a wrong word next to a wrong meaning is worse than a missing entry. Say how many you
dropped in `note`.

## Ignore
Page headers/footers, unit/lesson titles, instructions, and example sentences that aren't
themselves the word+meaning pair (a word followed by its own usage example is fine — just keep
the word and its meaning, drop the example sentence).

## note (Korean, short)
- "" if every line was clearly a word entry and none were dropped.
- Otherwise one sentence: 몇 개는 짝을 다시 맞추지 못해 제외함, 본문처럼 보이는 줄이 섞여 있어
  일부만 추림 등.

Return valid JSON only."""

_VOCAB_OCR_TRUNC_MSG = "사진의 글자가 너무 많아 옮기다가 잘렸습니다. 나눠 찍어 올려 주세요."
_VOCAB_PDF_TRUNC_MSG = "PDF의 글자가 너무 많아 정리하다가 잘렸습니다. 쪽을 나눠 올려 주세요."


def _clean_vocab_items(raw):
    """모델이 준 항목을 다듬는다 — 단어가 빈 항목은 버리고, 나머지 필드는 앞뒤 공백만 뗀다.
    화면이 이 값을 표에 넣을 때 esc()로 이스케이프하므로(지문 분석 vocab과 같은 경로),
    여기서 태그를 더 벗겨낼 필요는 없다."""
    out = []
    for it in raw or ():
        if not isinstance(it, dict):
            continue
        word = str(it.get("word") or "").strip()
        if not word:
            continue
        out.append({
            "word": word,
            "pos": str(it.get("pos") or "").strip(),
            "meaning": str(it.get("meaning") or "").strip(),
            "synonym": str(it.get("synonym") or "").strip(),
            "antonym": str(it.get("antonym") or "").strip(),
        })
    return out


def call_gemini_vocab_ocr(file, api_key, model):
    """사진 1장(base64)에서 단어 목록을 읽어 {items, note}를 돌려준다.
    file: {"mime": "image/jpeg", "data": "<base64>"} — 화면이 이미 축소해 보낸다."""
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

    payload = {
        "systemInstruction": {"parts": [{"text": VOCAB_OCR_SYSTEM_PROMPT}]},
        "contents": [{"role": "user", "parts": [
            {"inlineData": {"mimeType": mime, "data": data}},
            {"text": "이 사진에서 단어 목록을 읽어 옮겨 적으세요."},
        ]}],
        "generationConfig": {
            "temperature": 0.1,
            "maxOutputTokens": 16384,
            "responseMimeType": "application/json",
            "responseSchema": VOCAB_ITEMS_SCHEMA,
        },
    }
    result = _gemini_json(payload, api_key, model, _VOCAB_OCR_TRUNC_MSG)
    items = _clean_vocab_items(result.get("items"))
    note = str(result.get("note") or "").strip()
    if not items:
        raise RuntimeError(
            note or "사진에서 단어 목록을 찾지 못했습니다. 잘 보이게 다시 찍어 올려 주세요."
        )
    return {"items": items, "note": note}


def call_gemini_vocab_pdf(text, api_key, model):
    """PDF에서 미리 뽑아 둔 글자(text)를 넘겨 단어 목록으로 정리시킨다.
    이미지가 아니라 글자만 보내므로 사진 인식보다 원가가 훨씬 낮다."""
    api_key = (api_key or "").strip() or os.environ.get("GEMINI_API_KEY", "").strip()
    if not api_key:
        raise RuntimeError(
            "관리자가 아직 서버에 Gemini API 키(GEMINI_API_KEY)를 설정하지 않았습니다. "
            "관리자에게 문의하세요."
        )
    model = model if (model and _MODEL_RE.match(model)) else MODEL

    payload = {
        "systemInstruction": {"parts": [{"text": VOCAB_PDF_SYSTEM_PROMPT}]},
        "contents": [{"role": "user", "parts": [{"text": text}]}],
        "generationConfig": {
            "temperature": 0.1,
            "maxOutputTokens": 16384,
            "responseMimeType": "application/json",
            "responseSchema": VOCAB_ITEMS_SCHEMA,
        },
    }
    result = _gemini_json(payload, api_key, model, _VOCAB_PDF_TRUNC_MSG)
    items = _clean_vocab_items(result.get("items"))
    note = str(result.get("note") or "").strip()
    if not items:
        raise RuntimeError(note or "이 PDF에서 단어 목록을 찾지 못했습니다.")
    return {"items": items, "note": note}


# ══════════════ 지문 요약 인포그래픽 ══════════════
# 지문을 한 장의 가로형 그림으로 요약한다. 두 번 부르는 것이 핵심이다.
#
#   1단계 (Flash)  지문 → 구조와 문구를 JSON으로 확정한다. 여기가 '글을 쓰는' 단계다.
#   2단계 (Pro 이미지) 그 문구를 넘겨 '그대로 조판만' 시킨다. 여기는 '그리는' 단계다.
#
# 한 번에 시키면 안 되는 이유가 있다. 이미지 모델에게 지문을 주고 알아서 요약하게 하면
# 그림 안의 글자에서 어법·철자 오류가 난다 — 실제로 "COSMEPOLITAN COSMOPOLITAN"처럼
# 같은 낱말을 오타 한 번, 정타 한 번 두 벌 찍어 놓는 사고가 있었다. 글은 글 쓰는 모델이
# 짓게 하고 그림 모델에게는 문자열을 못박아 넘기면 이런 오류가 크게 준다.
#
# 다만 0이 되지는 않는다. 조판 단계에서도 드물게 글자가 뭉개지므로, 결과는 픽셀이라
# sanitize_* 로 걸러낼 수도 setEditMode로 고칠 수도 없다 — 인쇄 전에 눈으로 한 번
# 보는 절차가 반드시 남는다. 화면도 그렇게 안내한다.

# 지문의 짜임에 따라 고르는 배치. 색·글꼴·캐릭터 같은 '겉모습'은 어느 것을 골라도
# 같고(한 벌로 인쇄되므로), 달라지는 것은 칸을 어떻게 늘어놓고 화살표를 그리느냐뿐이다.
#
# 나누는 이유는 보기 좋으라고가 아니다. 화살표는 '그다음' 또는 '그래서'라고 주장한다.
# 지문이 그렇게 말하지 않았는데 화살표를 그리면 그림이 없는 관계를 지어내는 것이다.
# 교과서 본문은 시간 순 서사라 흐름이 맞지만, 모의고사·수능 지문은 논증문이라
# 근거들이 대등하다 — 거기에 번호를 붙여 이으면 없던 순서가 생긴다.
INFOGRAPHIC_LAYOUTS = ("flow", "claim", "contrast")

INFOGRAPHIC_SCHEMA = {
    "type": "OBJECT",
    "properties": {
        "layout": {"type": "STRING", "enum": list(INFOGRAPHIC_LAYOUTS)},
        "title": {"type": "STRING"},
        "stages": {
            "type": "ARRAY",
            "items": {
                "type": "OBJECT",
                "properties": {
                    "label_en": {"type": "STRING"},
                    "body_ko": {"type": "STRING"},
                    "bold_en": {"type": "ARRAY", "items": {"type": "STRING"}},
                    "icon": {"type": "STRING"},
                },
                "required": ["label_en", "body_ko", "bold_en", "icon"],
                "propertyOrdering": ["label_en", "body_ko", "bold_en", "icon"],
            },
        },
        # 하위 갈래는 '있을 때만' 쓰지만, 구조화 출력은 required를 비워 두면 모델이
        # 제멋대로 생략한다. 그래서 항상 받되 parent=0이면 없는 것으로 읽는다.
        "branch": {
            "type": "OBJECT",
            "properties": {
                "parent": {"type": "INTEGER"},
                "label_en": {"type": "STRING"},
                "items": {
                    "type": "ARRAY",
                    "items": {
                        "type": "OBJECT",
                        "properties": {
                            "body_ko": {"type": "STRING"},
                            "bold_en": {"type": "ARRAY", "items": {"type": "STRING"}},
                            "icon": {"type": "STRING"},
                        },
                        "required": ["body_ko", "bold_en", "icon"],
                        "propertyOrdering": ["body_ko", "bold_en", "icon"],
                    },
                },
            },
            "required": ["parent", "label_en", "items"],
            "propertyOrdering": ["parent", "label_en", "items"],
        },
        "note": {"type": "STRING"},
    },
    "required": ["layout", "title", "stages", "branch", "note"],
    "propertyOrdering": ["layout", "title", "stages", "branch", "note"],
}

INFOGRAPHIC_SYSTEM_PROMPT = r"""You plan a ONE-PAGE horizontal infographic that helps a Korean
high-school student understand an English reading passage. You do NOT draw it — you decide the
structure and write the exact strings that will be typeset into the image later.
Return ONLY the structured JSON in the schema — no markdown, no commentary.

## The reader
A Korean student who has just read the English passage. The explanations are in Korean so the
meaning lands immediately; the key English wording stays in English so the student connects the
Korean to the words actually on the page.

## Use ONLY the passage
Every claim must come from the passage. Add no examples, no background facts, no advice, no
moral, no conclusion the passage does not state. If the passage is too short or too fragmentary
to structure, still do your best with what is there and say so in `note`.

## layout — decide what the passage's parts actually are
This choice decides whether the picture draws ARROWS between the parts. An arrow asserts
"and then" or "and therefore". If the passage does not actually say that, an arrow makes the
picture claim something the passage never claimed. Choose by what the passage does, not by
what would look nice.

- `flow` — the parts happen in a real order: a sequence in time, a process, stages of a
  change, a narrative. Typical of textbook reading passages.
  ONLY choose this if reordering the parts would make the passage wrong.
- `claim` — the passage argues something: one main point supported by reasons, evidence, or
  examples that sit BESIDE each other rather than after each other. Typical of exam passages
  (모의고사·수능). The reasons are equal in rank; none comes "after" another.
- `contrast` — the passage sets two things against each other: a common belief versus the
  truth, before versus after, A versus B. Exactly two sides.

When you are not sure, choose `claim`. Drawing no arrow says nothing; drawing the wrong arrow
says something false. `claim` is the safe default.

For `contrast`, the two sides go in `stages` as exactly two entries — the first is the side
the passage introduces first (often the common belief), the second is the side it argues for.

## title
The passage's overall point, in ENGLISH, ALL CAPS. Max 60 characters.
Prefer the passage's own vocabulary over invented phrasing.

## stages — the parts of the passage
How many, and what they are, depends on the layout you chose:

- `flow` — 3 to 5 stages, in the order the passage puts them.
- `claim` — the FIRST entry is the passage's main point; the entries after it are the reasons
  or examples that support it (2 to 4 of them). They are equal in rank, so do not write them
  as if one follows another — no "먼저/그다음/마지막으로".
- `contrast` — EXACTLY 2 entries, the two sides being set against each other.

Do not force a number — use as many as the passage actually has, within those limits.
Fewer, clearer parts beat more, thinner ones. Each entry:

- `label_en` — the part's name in ENGLISH, ALL CAPS. Max 30 characters. This is a heading,
  not a sentence: no final period.
- `body_ko` — ONE Korean sentence explaining that stage. Max 45 characters INCLUDING spaces.
  This goes inside a picture, so length is a hard limit, not a suggestion. Write natural
  Korean (해요체가 아니라 문어체 — "~한다", "~이다"). Never translate word-for-word if it
  produces awkward Korean.
- `bold_en` — 0 to 2 English words or short phrases, taken VERBATIM from the passage, that
  will be shown in bold. CRITICAL: every string here must appear EXACTLY as written inside
  this stage's `body_ko`. If you want to bold "K-drama", then `body_ko` must literally
  contain "K-drama". If nothing English belongs in this sentence, use an empty array.
- `icon` — what to DRAW for this part, in English. Max 80 characters. This is the part that
  actually carries the meaning, so make it worth looking at: a scene, a moment, a place, a
  gesture, an object, a visual metaphor — whatever would make this part click for someone
  who has not read the passage. "A commuter checking a phone while the train empties around
  them" is good; "a phone" is weak; "communication" is unusable.
  It must be something a person could actually draw — never an abstraction on its own.
  Prefer what the passage itself describes; invent an image only when the passage is abstract,
  and then make sure the image still says exactly what the passage says.

## branch — only when one part really splits
Some passages list two or more parallel things under a single part (e.g. three things the
writer wants to do). When that happens, fill `branch`:
- `parent` — the 1-based index of the part that splits.
- `label_en` — ENGLISH, ALL CAPS heading for the group. Max 30 characters.
- `items` — 2 to 3 entries, each with the same `body_ko` / `bold_en` / `icon` rules as a stage
  (but `body_ko` max 30 characters — these sit in narrow columns).

When nothing splits, set `parent` to 0, `label_en` to "", and `items` to [].
Use at most ONE branch per passage. Never branch a part that has only one item.
Do not use a branch with `contrast` — the two sides are already the split.

## note (Korean, short)
"" when the passage structured cleanly. Otherwise one sentence naming the concrete problem:
지문이 너무 짧아 나누기 어려웠음, 논증문이라 흐름 대신 주장·근거로 묶었음 등.

## Above all
The strings you write here are typeset into an image as-is and CANNOT be corrected afterwards.
Check spelling, spacing, and grammar in both languages before you answer.

Return valid JSON only."""


# 2단계에 넘기는 그림 지시.
#
# 여기에 판(레이아웃)을 적지 않는 것이 요점이다. 처음에는 배치·색·테두리까지 못박아
# 두었는데, 그러면 지문이 무엇이든 같은 틀에 글자만 갈아 끼운 그림이 나온다.
# 실제로 만화풍 틀에서 도표풍 틀로 바꿔 봐도 '고정된 틀'이라는 성질은 그대로였다.
#
# 그래서 구도는 통째로 모델에게 맡기고, 여기에는 어겨서는 안 되는 것만 남긴다.
#   - 글자는 준 문자열 그대로 (어법 오류가 나는 자리라 이것만은 못박는다)
#   - 없는 말을 그려 넣지 않기
#   - 인쇄해서 읽을 수 있는 크기와 여백
# 색·배치·그림체는 목록에 없다 — 지문마다 달라지라고 일부러 비워 둔 자리다.
INFOGRAPHIC_RULES = r"""
HOW TO COMPOSE
Compose this image however best explains THIS passage. There is no template and no house
style — a passage about a journey, a passage arguing a point, and a passage comparing two
things should end up looking nothing like each other. Decide the composition, the palette,
the illustration style, and the arrangement yourself, from what this passage is about.

Let the pictures carry the meaning. A student should grasp what the passage is about from
the artwork alone, before reading a single line. The given text lines are labels ON that
artwork — they are not the content, and they must never become rows of captioned boxes.
Draw real things: scenes, people, places, objects, metaphors, whatever this passage calls
for. Fill the frame with the idea.

WHAT YOU MUST NOT CHANGE
- Render every supplied string EXACTLY as given, character for character. Do not translate,
  rephrase, shorten, correct, re-spell, or duplicate any word. Korean must be rendered in
  correct Hangul exactly as written; English exactly as written.
- Every supplied string must appear somewhere in the image, and must be legible.
- Add NO text that is not supplied — no labels of your own, no captions, no watermark,
  no logo, no page number, no signature.
- Draw nothing the passage does not support. No invented facts, no added examples.
- No text may be smaller than 1/50 of the image height. If the text does not fit, make the
  artwork simpler — never shrink the text.
- Leave at least 4% margin on every edge and crop nothing.
"""

_INFOGRAPHIC_TRUNC_MSG = "지문이 너무 길어 요약 구조를 만들다가 잘렸습니다. 지문을 나눠 시도해 주세요."


def _clip(text, limit):
    """그림에 들어갈 문자열을 상한 길이로 자른다.

    프롬프트에 글자 수 상한을 적어도 모델이 넘길 때가 있는데, 긴 문자열이 그림에
    들어가면 글자가 작아지거나 테두리 밖으로 잘려 나간다. 잘라 내는 쪽이 낫다."""
    s = " ".join(str(text or "").split())
    return s if len(s) <= limit else s[:limit].rstrip()


def _clean_infographic_plan(plan):
    """1단계 결과를 그림에 넘길 수 있는 형태로 다듬는다.

    가장 중요한 일은 bold_en 검사다. 볼드로 칠할 영어 표현은 반드시 그 칸의 한국어
    문장 안에 그대로 들어 있어야 한다. 없는 표현을 '굵게 하라'고 시키면 그림 모델이
    문장에 없는 낱말을 새로 그려 넣는다 — 지문에 없는 말이 결과물에 나타나는 경로가
    되므로, 문장에서 찾지 못한 것은 조용히 버린다."""
    def _one(d, body_limit):
        body = _clip(d.get("body_ko"), body_limit)
        bold = [
            b for b in (_clip(x, 40) for x in (d.get("bold_en") or []))
            if b and b in body
        ][:2]
        return {"body_ko": body, "bold_en": bold, "icon": _clip(d.get("icon"), 80)}

    # 모르는 값이 오면 claim으로 떨어뜨린다 — 화살표를 안 그리는 쪽이 늘 안전하다
    layout = plan.get("layout")
    if layout not in INFOGRAPHIC_LAYOUTS:
        layout = "claim"

    stages = []
    for st in (plan.get("stages") or [])[:5]:
        item = _one(st, 45)
        item["label_en"] = _clip(st.get("label_en"), 30).upper().rstrip(".")
        if item["body_ko"] and item["label_en"]:
            stages.append(item)
    if len(stages) < 2:
        raise RuntimeError(
            "지문에서 요약할 내용을 찾지 못했습니다. 지문이 너무 짧은 것 같습니다."
        )
    # 대조는 두 쪽이라야 성립한다. 셋 이상이 오면 좌우로 나눌 수가 없으므로,
    # 배치를 바꾸는 대신 claim으로 내린다(앞의 것을 억지로 버리면 내용이 사라진다).
    if layout == "contrast" and len(stages) != 2:
        layout = "claim"

    raw_branch = plan.get("branch") or {}
    parent = raw_branch.get("parent") or 0
    items = [_one(x, 30) for x in (raw_branch.get("items") or [])[:3]]
    items = [x for x in items if x["body_ko"]]
    # parent가 범위를 벗어나면(모델이 없는 단계를 가리킴) 갈래를 통째로 버린다 —
    # 어느 칸에 매달지 모르는 채로 그리게 두면 자리가 엉킨다.
    branch = None
    if 1 <= parent <= len(stages) and len(items) >= 2:
        branch = {
            "parent": parent,
            "label_en": _clip(raw_branch.get("label_en"), 30).upper().rstrip(".") or "DETAILS",
            "items": items,
        }
    # 대조는 좌우 두 쪽이 곧 나뉜 모습이라, 거기 또 갈래를 달면 한쪽만 무거워진다
    if layout == "contrast":
        branch = None
    return {
        "layout": layout,
        "title": _clip(plan.get("title"), 60).upper(),
        "stages": stages,
        "branch": branch,
        "note": _clip(plan.get("note"), 200),
    }


def _infographic_prompt(plan):
    """다듬은 구조를 그림 모델이 읽을 지시문으로 편다.

    구도는 적지 않는다 — 무엇을 담을지(문자열과 그릴 것)만 넘기고 어떻게 배치할지는
    모델이 지문마다 정하게 둔다. 칸 이름도 'STAGE 1' 같은 자리 이름 대신 그냥 번호로
    부른다(자리 이름을 주면 그 이름대로 상자를 만들어 늘어놓는다)."""
    # 관계는 '이렇게 그려라'가 아니라 '지문이 이렇다'는 정보로만 넘긴다.
    # 순서가 아닌 지문에 순서를 그려 넣지 않게 하려는 것이지, 판을 정해 주는 게 아니다.
    relation = {
        "flow": "These parts happen in a real order — one leads to the next.",
        "claim": "The first part is the passage's point; the rest are reasons that support "
                 "it. The reasons are equal in rank — none comes before or causes another.",
        "contrast": "These two are set against each other — opposed, not sequential.",
    }.get(plan.get("layout", "claim"))

    out = [
        "Create one horizontal image that summarizes an English reading passage",
        "for a Korean high-school student.",
        "",
        f"WHAT THE PASSAGE IS LIKE: {relation}",
        "",
        "TEXT TO PLACE IN THE IMAGE",
        f'  Title: {plan["title"]}',
    ]
    for i, st in enumerate(plan["stages"], 1):
        out.append("")
        out.append(f'  {i}. English label: {st["label_en"]}')
        out.append(f'     Korean line:   {st["body_ko"]}')
        if st["bold_en"]:
            out.append(
                '     Set these exact substrings in bold inside that Korean line: '
                + " | ".join(st["bold_en"])
            )
        out.append(f'     Draw: {st["icon"]}')
    br = plan.get("branch")
    if br:
        out.append("")
        out.append(
            f'  These belong under "{plan["stages"][br["parent"] - 1]["label_en"]}", '
            f'grouped as: {br["label_en"]}'
        )
        for it in br["items"]:
            out.append(f'     Korean line: {it["body_ko"]}')
            if it["bold_en"]:
                out.append(
                    '     Bold inside it: ' + " | ".join(it["bold_en"])
                )
            out.append(f'     Draw: {it["icon"]}')
    out.append(INFOGRAPHIC_RULES)
    return "\n".join(out)


def _image_from_interaction(body):
    """응답 어디에 있든 base64 이미지를 찾아낸다.

    Interactions API의 응답 JSON 구조는 문서에 나와 있지 않다(파이썬 SDK의
    `interaction.output_image`는 편의 속성이라 원본이 어디에 담기는지 알려주지 않는다).
    그래서 자리를 짚어 꺼내는 대신 응답 전체를 훑어 '이미지로 보이는 것'을 찾는다.

    이미지로 보이는 것 = data(또는 bytes_base64_encoded) 값이 충분히 긴 문자열인 dict.
    길이로 거르는 이유는 id·token 같은 짧은 문자열을 이미지로 오인하지 않기 위해서다
    (가장 작은 1K JPEG도 base64로 수만 자다). 형제 키에서 mime을 같이 주워 온다."""
    found = []

    def walk(node):
        if isinstance(node, dict):
            for key in ("data", "bytes_base64_encoded", "bytesBase64Encoded", "b64_json"):
                val = node.get(key)
                if isinstance(val, str) and len(val) > 5000:
                    mime = (node.get("mime_type") or node.get("mimeType")
                            or node.get("media_type") or node.get("mediaType"))
                    found.append((val, mime))
                    return  # 이 dict는 다 본 것으로 친다
            for val in node.values():
                walk(val)
        elif isinstance(node, list):
            for val in node:
                walk(val)

    walk(body)
    if not found:
        return None, None
    # 여러 장이 오면 가장 큰 것을 고른다 — 미리보기 섬네일이 함께 오는 경우가 있다
    data, mime = max(found, key=lambda pair: len(pair[0]))
    return data, mime


def _describe_json(node, depth=0):
    """응답의 '모양'만 짧게 적는다 — 원인을 찾으려면 어떤 키가 왔는지 알아야 하는데,
    응답을 통째로 찍으면 base64가 섞여 로그가 터진다. 값은 길이만 남긴다."""
    pad = "  " * depth
    if isinstance(node, dict):
        if depth > 4:
            return f"{pad}{{…{len(node)}개 키}}"
        return "\n".join(
            f"{pad}{k}:\n{_describe_json(v, depth + 1)}" for k, v in list(node.items())[:20]
        )
    if isinstance(node, list):
        if not node:
            return f"{pad}[]"
        return f"{pad}[{len(node)}개]\n{_describe_json(node[0], depth + 1)}"
    if isinstance(node, str):
        return f"{pad}<문자열 {len(node)}자>" if len(node) > 80 else f"{pad}{node!r}"
    return f"{pad}{node!r}"


def call_gemini_infographic(passage, api_key, model=None):
    """지문 1개 → 가로형 요약 인포그래픽 1장.

    두 번 부른다: Flash가 문구를 확정하고(_infographic_plan), Pro 이미지 모델이
    그것을 조판한다. 돌려주는 것은 {image, mime, plan, note}이고 image는 base64다.
    요금 차감은 여기서 하지 않는다 — 성공해서 돌아간 뒤 라우트가 한다."""
    api_key = (api_key or "").strip() or os.environ.get("GEMINI_API_KEY", "").strip()
    if not api_key:
        raise RuntimeError(
            "관리자가 아직 서버에 Gemini API 키(GEMINI_API_KEY)를 설정하지 않았습니다. "
            "관리자에게 문의하세요."
        )
    text = (passage or "").strip()
    if len(text) < 40:
        raise RuntimeError("지문이 너무 짧습니다. 요약할 내용이 있는 지문을 넣어 주세요.")

    # --- 1단계: 무엇을 어떤 문구로 그릴지 정한다 (Flash) ---
    plan_payload = {
        "systemInstruction": {"parts": [{"text": INFOGRAPHIC_SYSTEM_PROMPT}]},
        "contents": [{"role": "user", "parts": [{"text": text}]}],
        "generationConfig": {
            "temperature": 0.3,
            "maxOutputTokens": 4096,
            "responseMimeType": "application/json",
            "responseSchema": INFOGRAPHIC_SCHEMA,
        },
    }
    plan = _clean_infographic_plan(
        _gemini_json(plan_payload, api_key, MODEL, _INFOGRAPHIC_TRUNC_MSG)
    )

    # --- 2단계: 그 문구를 그대로 조판시킨다 (나노바나나 프로) ---
    use_model = model if (model and _MODEL_RE.match(model)) else MODEL_IMAGE
    img_payload = {
        "model": use_model,
        "input": [{"type": "text", "text": _infographic_prompt(plan)}],
        "response_format": {
            "type": "image",
            # PNG는 4K에서 파일이 몇 MB로 뛴다. 브라우저로 실어 나르고 인쇄까지 해야 해서
            # JPEG로 받는다(평면 일러스트라 화질 손해가 눈에 띄지 않는다).
            "mime_type": "image/jpeg",
            "aspect_ratio": IMAGE_ASPECT,
            "image_size": IMAGE_SIZE,
        },
    }
    data = json.dumps(img_payload, ensure_ascii=False).encode("utf-8")
    try:
        body = _gemini_call_with_retry(
            data, api_key, use_model,
            url=GEMINI_IMAGE_URL,
            # 그림 모델을 글자 모델로 갈아탈 수는 없다 — 없으면 없다고 말해야 한다
            allow_fallback=False,
        )
    except ProUnavailable:
        # 공통 처리기의 안내문은 '모델 목록에서 Flash를 고르라'고 하는데, 이 기능에는
        # 모델을 고르는 자리가 없고 대체할 그림 모델도 없다. 상황에 맞게 다시 말한다.
        raise ProUnavailable(
            f"이 API 키로는 그림 모델({use_model})을 사용할 수 없습니다. "
            "요약 이미지는 결제(billing)가 설정된 키에서만 만들 수 있습니다 — "
            "무료 등급 키에는 이미지 할당량이 없습니다. 관리자에게 문의하세요."
        )

    image, mime = _image_from_interaction(body)
    if not image:
        # 응답은 200으로 왔는데 그 안에 이미지가 없다. 형식이 바뀐 것인지, 모델이
        # 거절한 것인지(안전 필터 등) 응답 모양을 봐야 알 수 있으므로 로그에 남긴다.
        # 값은 길이만 적으므로 base64가 로그를 덮지 않는다.
        print("[인포그래픽] 이미지를 찾지 못했다. 응답 모양:", flush=True)
        print(_describe_json(body), flush=True)
        raise RuntimeError(
            "그림 모델이 이미지를 돌려주지 않았습니다. "
            "서버 로그에 응답 모양을 남겼으니 확인해 주세요."
        )
    return {
        "image": image,
        "mime": mime or "image/jpeg",
        "plan": plan,
        "note": plan.get("note") or "",
    }


# ══════════════ PDF에서 지문 꺼내기 ══════════════
# 사진 OCR(위)과 목적은 같지만 방법이 다르다. 여기서 다루는 PDF는 '글자로 만든' 파일이라
# 글자가 이미 안에 들어 있다 — Gemini를 부르지 않고 그대로 꺼낸다. 그래서
#   (1) 요금이 들지 않고, (2) 옮겨 적다 생기는 오타가 원천적으로 없고,
#   (3) 널리 공개된 기출이어도 재현(RECITATION) 차단을 만나지 않는다.
# 스캔본(그림만 든 PDF)은 꺼낼 글자가 없다 — 그때는 사진 OCR 쪽으로 안내한다.
#
# 나누는 기준은 두 가지다.
#   문항형(모의고사·문제집) — '18. 다음 글의 …' 같은 한글 지시문이 지문의 시작점이다.
#   문단형(교과서 본문)     — 들여쓰기·앞 줄이 짧게 끝났는지·글자 크기로 문단을 가른다.
# 어느 쪽으로도 안 나뉘면 화면이 'AI로 다시 시도'를 권한다(call_gemini_pdf_split).
try:
    from pdfminer.high_level import extract_pages as _pdf_extract_pages
    from pdfminer.layout import LAParams, LTTextContainer, LTTextLine
    PDF_READY = True
except ImportError:
    # pdfminer.six가 없으면 이 기능만 꺼진다 — 서버는 그대로 뜨고 나머지 기능도 그대로다.
    PDF_READY = False

_HANGUL_RE = re.compile(r"[가-힣]")
# 문항 시작줄: '18.' '41~42.' '31 .' 로 시작하고 한글 지시문이 이어진다.
# 한글을 함께 요구하는 이유 — 영어 본문의 '1. Introduction' 같은 줄을 문항으로 오인하지
# 않기 위해서다(지시문은 언제나 한글이다).
_PDF_Q_RE = re.compile(r"^\s*(\d{1,2})\s*(?:[~～∼-]\s*(\d{1,2}))?\s*[.．]\s*\S")
# 보기 줄(① … ⑤)로 시작하면 지문은 거기서 끝난다.
_PDF_CHOICE_RE = re.compile(r"^\s*[①-⑤]")
# 교사용 자료가 본문에 박아 둔 정답 교정: "(c) presence (→ lack)" → "lack".
# 앞의 보기 기호(① … ⑤ / (a) … (e))부터 화살표 괄호까지가 '틀리게 인쇄된 부분'이다.
_PDF_FIX_RE = re.compile(r"(?:[①-⑤]|\([a-e]\))\s*([^()]{1,80}?)\s*\(\s*→\s*([^)]+)\)")
# 문장삽입 문항이 본문에 찍어 두는 삽입 위치 표시 — ( ① ) ( ② ) …
_PDF_SLOT_RE = re.compile(r"\(\s*[①-⑤]\s*\)")
# 순서·장문 문항이 문단 앞에 붙이는 라벨 — (A) (B) (C) (D) (E)
_PDF_PARA_LABEL_RE = re.compile(r"(^|\s)\([A-E]\)\s*")
# 지문에서 걷어낼 원문자 번호 전체(app.js의 CIRCLED_MARKERS와 같은 뜻).
_PDF_MARKER_CHARS = "".join(
    chr(ord(base) + i)
    for base in ("❶", "⓫", "➀", "➊", "①", "⑴", "⒈", "⓵")
    for i in range(10)
)
# 그중 '속이 찬 원'만 문장 번호로 쓴다 — 값(몇 번째 문장인지)까지 읽는 것은 이 목록뿐이다.
# ①~⑤는 보기 기호로도 쓰여서 문장 번호로 삼으면 순서를 잘못 읽는다.
_PDF_SENT_MARKERS = {}
for _base, _start in (("❶", 1), ("⓫", 11), ("➊", 1)):
    for _i in range(10):
        _PDF_SENT_MARKERS.setdefault(chr(ord(_base) + _i), _start + _i)
_PDF_SENT_SPLIT_RE = re.compile(f"([{''.join(_PDF_SENT_MARKERS)}])")


def _pdf_is_question_line(t):
    """'18. 다음 글의 …' 같은 문항 시작줄인가.

    한글이 들어 있는지로 가른다(비율이 아니라 유무로 보는 이유 — 함축의미 문항처럼
    지시문에 영어 구절을 통째로 인용하는 줄은 한글 비율이 20%도 안 된다).
    영어 본문의 '1. Introduction' 같은 줄은 한글이 없어 걸리지 않는다."""
    return bool(_PDF_Q_RE.match(t)) and len(_HANGUL_RE.findall(t)) >= 2


def _ko_ratio(s):
    """글자 중 한글이 차지하는 비율. 영어 지문 줄과 한글 해석·어휘 줄을 가른다."""
    letters = [c for c in s if c.isalpha()]
    if not letters:
        return 0.0
    return sum(1 for c in letters if _HANGUL_RE.match(c)) / len(letters)


def _pdf_page_lines(page):
    """PDF 한 쪽을 '읽는 순서대로 놓인 줄'의 목록으로 바꾼다.

    두 가지를 손봐야 원문이 그대로 나온다.
    - 양쪽 정렬(justify)로 자간이 벌어진 줄은 단어마다 조각나 들어온다 → 같은 높이의
      조각을 이어 붙여 '보이는 한 줄'로 되돌린다(같은 텍스트 상자 안에서만 잇는다 —
      옆 단의 줄과 높이가 겹치기 때문).
    - 교과서·교사용 자료는 왼쪽이 영어, 오른쪽이 한글 해석인 2단 구성이다 → 높이순으로
      섞어 읽으면 영어 문장 사이에 한글이 끼어든다. 좌·우로 나눈 뒤 각각 위에서 아래로 읽는다.
    """
    rows = []
    for box in page:
        if not isinstance(box, LTTextContainer):
            continue
        for ln in box:
            if not isinstance(ln, LTTextLine):
                continue
            text = ln.get_text().rstrip()
            if not text.strip():
                continue
            sizes = [c.size for c in ln if hasattr(c, "size")]
            rows.append({
                "t": text, "x0": ln.x0, "x1": ln.x1,
                "y": -ln.y1,  # 위→아래가 커지도록 뒤집는다
                "size": max(sizes) if sizes else 10.0,
            })
    if not rows:
        return []
    out = []
    for group in _pdf_columns(rows):
        for row in group:
            prev = out[-1] if out else None
            # 같은 단에서 같은 높이(±2pt)에 가까이(30pt 이내) 이어지면 한 줄로 붙인다.
            # 단을 나눈 뒤에 붙이는 이유 — 붙이기 전에는 옆 단의 한글 줄이 같은 높이에
            # 있어 함께 딸려 들어온다.
            if (prev and abs(row["y"] - prev["y"]) <= 2
                    and -1 <= row["x0"] - prev["x1"] <= 30):
                prev["t"] = prev["t"].rstrip() + " " + row["t"].lstrip()
                prev["x1"] = max(prev["x1"], row["x1"])
                prev["size"] = max(prev["size"], row["size"])
            else:
                out.append(dict(row))
    return out


def _pdf_row_order(row):
    """읽는 순서 — 위에서 아래로, 같은 높이면 왼쪽부터.
    같은 줄인데 1~2pt 어긋난 조각들이 갈리지 않도록 높이를 3pt 단위로 뭉갠다."""
    return (round(row["y"] / 3), row["x0"])


def _pdf_columns(rows, depth=2):
    """쪽을 단(column)으로 나눠, 각 단을 위에서 아래로 읽을 수 있게 돌려준다.

    쪽 한가운데를 기준으로 자르면 안 된다 — 본문 줄이 가운데를 넘어가는 자료가 흔하고
    (실측한 모의고사에서 자간이 벌어진 조각 하나가 넘어가 문장에서 두 단어가 빠졌다),
    그러면 그 조각만 옆 단으로 넘어가 조용히 사라진다.
    그래서 '줄이 거의 가로지르지 않는 빈 세로줄'(단 사이 여백)만 경계로 삼는다.
    '거의'인 이유 — 머리말·꼬리말·저작권 문구는 쪽 전체를 가로지른다. 이것까지 막으면
    어떤 자리도 통과하지 못해 2단 자료가 1단으로 읽힌다(그러면 영어 문장 사이에 옆 단의
    한글 해석·어휘가 끼어든다). 가로지르는 줄이 몇 개뿐이면 왼쪽 단에 넣고 넘어간다.
    쓸 만한 자리가 없으면 1단으로 보고 그대로 둔다."""
    rows = sorted(rows, key=_pdf_row_order)
    if depth <= 0 or len(rows) < 6:
        return [rows]
    allowed = max(2, len(rows) // 12)
    # 후보는 '어떤 줄이 실제로 시작하는 자리'다. 1pt 단위로 묶어 후보 수를 줄이되 값은
    # 그 묶음의 실제 최솟값을 쓴다 — 반올림한 값을 그대로 쓰면 414.7에서 시작하는 단이
    # 415 기준으로는 왼쪽에 남아 단이 갈리지 않는다.
    starts = {}
    for r in rows:
        key = int(r["x0"])
        starts[key] = min(starts.get(key, r["x0"]), r["x0"])
    for cut in sorted(starts.values())[1:]:
        left = [r for r in rows if r["x0"] < cut]
        right = [r for r in rows if r["x0"] >= cut]
        if len(left) < 3 or len(right) < 3:
            continue
        if sum(1 for r in left if r["x1"] > cut) > allowed:
            continue     # 이 자리를 가로지르는 줄이 많다 = 여백이 아니다
        return _pdf_columns(left, depth - 1) + _pdf_columns(right, depth - 1)
    return [rows]


def _pdf_drop_running_heads(pages):
    """여러 쪽에 똑같이 찍히는 줄(머리말·꼬리말·저작권 문구·쪽 번호)을 걷어낸다.
    숫자를 #로 바꿔 비교하므로 '- 1 -', '- 2 -'도 같은 줄로 묶인다."""
    if len(pages) < 3:
        return pages
    seen = Counter()
    for lines in pages:
        for key in {re.sub(r"\d+", "#", r["t"].strip()) for r in lines}:
            seen[key] += 1
    common = {k for k, n in seen.items() if n >= len(pages) * 0.6}
    return [[r for r in lines if re.sub(r"\d+", "#", r["t"].strip()) not in common]
            for lines in pages]


def _pdf_reorder_sentences(text):
    """문장 번호가 순서를 알려 주는 경우에만 문장을 원래 순서로 되돌린다.

    문장삽입 문항은 '주어진 문장'을 본문 위에 따로 찍어 두는데, 교사용 자료는 그 문장에
    제자리 번호를 매겨 둔다(❹ 가 맨 앞에 오고 본문이 ❶❷❸❺… 로 이어지는 식).
    번호가 1..N을 정확히 한 번씩 채울 때만 정렬한다 — 그렇지 않으면 손대지 않는다."""
    parts = _PDF_SENT_SPLIT_RE.split(text)
    if len(parts) < 3:
        return text
    head = parts[0].strip()
    items = []
    for i in range(1, len(parts) - 1, 2):
        items.append((_PDF_SENT_MARKERS[parts[i]], parts[i + 1].strip()))
    nums = [n for n, _ in items]
    if sorted(nums) != list(range(1, len(nums) + 1)) or nums == sorted(nums):
        return text
    items.sort(key=lambda kv: kv[0])
    return " ".join(([head] if head else []) + [s for _n, s in items])


def _pdf_clean_passage(text, drop_labels):
    """꺼낸 덩어리를 '지문 그대로'로 다듬는다. 지우는 것은 시험지가 덧붙인 표시뿐이다."""
    text = text.replace("­", "-").replace(" ", " ")  # 소프트 하이픈·비분리 공백
    text = re.sub(r"\s+", " ", text).strip()
    # 삽입 위치 표시를 먼저 지운다 — 문장 순서를 읽기 전에 치워야 ( ① ) 가 문장 번호로
    # 잘못 세어지지 않는다.
    text = _PDF_SLOT_RE.sub("", text)
    text = _pdf_reorder_sentences(text)
    # 정답 교정을 반영한다 — 어법·어휘 문항은 일부러 틀리게 인쇄한 것이라
    # 교정본이 원래 지문이다. ("the (c) presence (→ lack) of" → "the lack of")
    text = _PDF_FIX_RE.sub(lambda m: m.group(2).strip(), text)
    if drop_labels:
        text = _PDF_PARA_LABEL_RE.sub(r"\1", text)
    # (a)~(e)는 어휘·지칭 문항이 낱말에 붙인 기호다. 본문에 실제로 쓰인 괄호를
    # 지우지 않도록 3개 이상 나올 때만 기호로 보고 걷어낸다.
    if len(re.findall(r"\([a-e]\)", text)) >= 3:
        text = re.sub(r"\([a-e]\)\s*", "", text)
    text = re.sub(f"[{_PDF_MARKER_CHARS}]\\s*", "", text)
    return re.sub(r"\s{2,}", " ", text).strip()


def _pdf_looks_like_prose(body):
    """모아 놓은 줄이 '글'인가, 낱말 목록인가.

    교사용 자료는 지문 뒤에 어휘 목록을 싣는다(commercial / aim for / predictability …).
    한 줄에 한 낱말씩이라 이어 붙이면 길이만으로는 지문과 구별되지 않는다 —
    짧은 줄이 절반을 넘으면 목록으로 본다."""
    if not body:
        return False
    short = sum(1 for t in body if len(t.split()) <= 3)
    return short <= len(body) * 0.5


def _pdf_body_from(lines, start):
    """지시문 다음 줄부터 영어 본문만 모은다. 보기(①~⑤)·한글·구역 표시를 만나면 거기서 끝."""
    body = []
    got = 0
    for row in lines[start:]:
        t = row["t"].strip()
        if not t:
            continue
        # ■ Vocabulary · ▶ 유형 같은 구역 표시가 나오면 그 문항의 지문은 끝난 것이다
        if t.startswith("■") or t.startswith("▶"):
            break
        if _PDF_CHOICE_RE.match(t) or t.startswith("*"):
            if got >= 40:
                break
            continue
        # 화살표 기호 한 자만 있는 줄 — 요약문 상자가 시작되는 자리다
        if got >= 40 and not re.search(r"[A-Za-z0-9]", t):
            break
        if _ko_ratio(t) > 0.5:
            if got >= 40:
                break
            continue        # 두 줄로 접힌 한글 지시문은 건너뛰고 본문을 계속 찾는다
        body.append(t)
        got += len(t)
    return body


def _pdf_split_by_question(pages):
    """문항형(모의고사·문제집): 한글 지시문마다 지문 하나."""
    out = []
    for lines in pages:
        starts = [i for i, r in enumerate(lines) if _pdf_is_question_line(r["t"])]
        for k, i in enumerate(starts):
            end = starts[k + 1] if k + 1 < len(starts) else len(lines)
            body = _pdf_body_from(lines[:end], i + 1)
            if not _pdf_looks_like_prose(body):
                continue
            text = _pdf_clean_passage(" ".join(body), drop_labels=True)
            if len(text) < PDF_MIN_PASSAGE_CHARS:
                continue
            m = _PDF_Q_RE.match(lines[i]["t"])
            name = f"{m.group(1)}~{m.group(2)}번" if m.group(2) else f"{m.group(1)}번"
            out.append({"name": name, "text": text})
    return out


def _pdf_split_by_paragraph(pages):
    """문단형(교과서 본문): 영어 줄만 남기고 문단 경계에서 자른다.

    경계로 보는 신호는 셋이다 — 들여쓰기, 앞 줄이 오른쪽 끝까지 못 가고 끝났는지,
    글자가 커졌는지(소제목). 소제목은 그 자체로 지문이 되기엔 짧으므로 다음 문단의
    이름으로 쓴다."""
    out = []
    pending_name = ""
    for lines in pages:
        eng = [r for r in lines if _ko_ratio(r["t"]) < 0.3 and re.search(r"[A-Za-z]", r["t"])]
        if not eng:
            continue
        left = min(r["x0"] for r in eng)
        right = max(r["x1"] for r in eng)
        width = max(right - left, 1)
        body_size = Counter(round(r["size"], 1) for r in eng).most_common(1)[0][0]
        chunks, cur = [], []
        for k, row in enumerate(eng):
            indented = row["x0"] - left > 4
            ended_short = k > 0 and (right - eng[k - 1]["x1"]) > width * 0.12
            bigger = row["size"] > body_size + 0.6
            if cur and (indented or ended_short or bigger):
                chunks.append(cur)
                cur = []
            cur.append(row)
        if cur:
            chunks.append(cur)
        for chunk in chunks:
            rows = [r["t"] for r in chunk]
            text = _pdf_clean_passage(" ".join(rows), drop_labels=False)
            if len(text) >= PDF_MIN_PASSAGE_CHARS:
                if not _pdf_looks_like_prose(rows):
                    continue           # 낱말 목록(어휘 정리)이지 지문이 아니다
                out.append({"name": pending_name, "text": text})
                pending_name = ""
            elif text and (len(text) <= 60 or not re.search(r"[.!?]$", text)):
                pending_name = text[:40]   # 소제목 — 다음 문단의 이름으로 넘긴다
    return out


def read_pdf_pages(raw):
    """PDF 바이트에서 쪽별 줄 목록을 꺼낸다. 글자층이 없으면 빈 목록이 나온다."""
    if not PDF_READY:
        raise RuntimeError(
            "이 서버에는 PDF를 읽는 부품(pdfminer.six)이 설치되어 있지 않습니다. "
            "관리자에게 문의하세요."
        )
    try:
        pages = [_pdf_page_lines(p) for p in _pdf_extract_pages(
            io.BytesIO(raw), laparams=LAParams(), maxpages=PDF_MAX_PAGES)]
    except Exception as e:
        raise RuntimeError(f"PDF를 읽지 못했습니다: {e}")
    return _pdf_drop_running_heads(pages)


def split_pdf_passages(pages):
    """쪽별 줄 목록을 지문 목록으로 나눈다. {mode, passages} 를 돌려준다.
    Gemini를 부르지 않는다 — 규칙만으로 나눈다."""
    marks = sum(1 for lines in pages for r in lines if _pdf_is_question_line(r["t"]))
    if marks >= 2:
        found = _pdf_split_by_question(pages)
        if len(found) >= 2:
            return {"mode": "question", "passages": found}
    return {"mode": "paragraph", "passages": _pdf_split_by_paragraph(pages)}


# ── PDF에서 단어 목록 규칙으로 뽑기 ──
# 교과서 단원 끝 '단어장' 페이지처럼 "단어    뜻"이 줄마다 규칙적인 깔끔한 표만
# 여기서 무료로 잡는다. _pdf_page_lines가 이미 같은 높이(±2pt)·가까운 간격(30pt 이내)의
# 조각을 한 줄로 붙여 두므로, 그 결과로 나온 한 줄 안에서 "영어 낱말 + 큰 간격 + 한글 뜻"
# 모양만 찾으면 된다. 2단으로 벌어진 자료(영어 칸을 전부 읽은 뒤 한글 칸을 잇는 경우)나
# 표 모양이 불규칙한 자료는 여기서 못 잡고 canAi로 넘어간다 — AI에게는 원문 줄을 그대로
# 보내 순서를 다시 맞추게 한다(call_gemini_vocab_pdf).
_VOCAB_LEAD_NO_RE = re.compile(r"^[①-⑳0-9]{1,3}[.)\s]+")
_VOCAB_SPLIT_RE = re.compile(r"\s{2,}|\t+")
_VOCAB_WORD_RE = re.compile(r"^[A-Za-z][A-Za-z .'\-]{0,40}$")
_VOCAB_POS_RE = re.compile(r"^\(([A-Za-z.]{1,6})\)\s*(.*)$")


def _parse_vocab_line(line):
    """줄 하나가 '단어 — 뜻' 모양이면 항목으로, 아니면 None."""
    line = _VOCAB_LEAD_NO_RE.sub("", line.strip()).strip()
    if not line:
        return None
    parts = _VOCAB_SPLIT_RE.split(line, maxsplit=1)
    if len(parts) != 2:
        return None
    word, rest = parts[0].strip(), parts[1].strip()
    if not word or not rest or not _VOCAB_WORD_RE.match(word):
        return None
    if not _HANGUL_RE.search(rest):
        return None
    pos = ""
    m = _VOCAB_POS_RE.match(rest)
    if m:
        pos, rest = m.group(1), m.group(2).strip()
    if not rest:
        return None
    return {"word": word, "pos": pos, "meaning": rest, "synonym": "", "antonym": ""}


def parse_vocab_lines_rule(pages):
    """쪽별 줄 목록에서 '단어 — 뜻' 모양의 줄만 규칙으로 골라낸다.
    걸린 줄이 전체 중 상당수(3개 이상 그리고 35% 이상)를 차지해야 '표 형태의 단어
    목록'이라고 믿고 돌려준다 — 몇 줄만 우연히 이 모양에 맞으면 본문 문장 사이에서
    잘못 골라낸 것일 수 있다. 못 미더우면 빈 목록을 돌려줘 canAi로 넘어가게 한다."""
    lines = [r["t"] for page in pages for r in page]
    items = [v for v in (_parse_vocab_line(t) for t in lines) if v]
    total = sum(1 for t in lines if t.strip())
    if total and len(items) >= 3 and len(items) >= total * 0.35:
        return items
    return []


# ── AI 보조: 규칙이 못 나눈 PDF의 경계만 찾아 준다 ──
# 본문을 옮겨 적게 하지 않는 것이 핵심이다. 줄마다 번호를 붙여 보여 주고 '몇째 줄부터
# 몇째 줄까지가 지문 하나인지'만 받는다. 그래서
#   (1) 답이 짧아 빠르고 싸며, (2) 모델이 글자를 바꿔 놓을 여지가 없고,
#   (3) 원문을 길게 되뱉지 않으므로 재현(RECITATION) 차단에 걸리지 않는다.
# 본문은 서버가 원래 줄에서 잘라 쓴다.
PDF_SPLIT_SCHEMA = {
    "type": "OBJECT",
    "properties": {
        "passages": {
            "type": "ARRAY",
            "items": {
                "type": "OBJECT",
                "properties": {
                    "start": {"type": "INTEGER"},
                    "end": {"type": "INTEGER"},
                    "name": {"type": "STRING"},
                },
                "required": ["start", "end", "name"],
                "propertyOrdering": ["start", "end", "name"],
            },
        },
        "note": {"type": "STRING"},
    },
    "required": ["passages", "note"],
    "propertyOrdering": ["passages", "note"],
}

PDF_SPLIT_SYSTEM_PROMPT = r"""You are given the text of a Korean school English material
(교과서 본문, 모의고사, 문제집, 부교재), one numbered line per printed line.
Find where each ENGLISH READING PASSAGE begins and ends. Return ONLY the structured JSON.

## What to return
For each passage: `start` and `end` are LINE NUMBERS (inclusive) from the input.
NEVER copy the passage text itself — line numbers only.
- Passages must not overlap, and must be listed in reading order.
- `name`: a short Korean label the teacher will see — the question number ("31번",
  "41~42번") when the material is a question paper, or the section heading, or "" if
  there is none. Keep it under 20 characters.

## Where a passage starts and ends
- Question papers: the passage starts on the line AFTER the Korean instruction
  ("31. 다음 빈칸에 들어갈 말로…") and ends just BEFORE the answer choices (① ② ③ ④ ⑤),
  the Korean translation, the vocabulary list, or the next question.
- Textbook/reading material: one paragraph of the English body = one passage.
  A heading line is not a passage — use it as the `name` of the paragraph under it.
- Include every line of the passage body, including lines that only hold a few words.

## Leave out
Korean instructions and translations, vocabulary glosses, answer choices, answer keys,
footnotes (* neural 신경의), headers, footers, page numbers, copyright notices,
and anything that is not the English body itself.

## note (Korean, one short sentence)
"" when the split was clean. Otherwise say what was unclear — for example
글자가 깨져 있음, 영어 지문을 찾지 못함, 지문 경계가 분명하지 않음.

Return valid JSON only."""

_PDF_SPLIT_TRUNC_MSG = "PDF가 너무 길어 경계를 찾다가 잘렸습니다. 쪽을 나눠 올려 주세요."


def call_gemini_pdf_split(pages, api_key, model):
    """규칙이 못 나눈 PDF를 Gemini에게 '경계만' 물어 지문 목록으로 만든다."""
    api_key = (api_key or "").strip() or os.environ.get("GEMINI_API_KEY", "").strip()
    if not api_key:
        raise RuntimeError(
            "관리자가 아직 서버에 Gemini API 키(GEMINI_API_KEY)를 설정하지 않았습니다. "
            "관리자에게 문의하세요."
        )
    model = model if (model and _MODEL_RE.match(model)) else MODEL

    flat = [r["t"].strip() for lines in pages for r in lines if r["t"].strip()]
    if not flat:
        raise RuntimeError("PDF에서 글자를 찾지 못했습니다.")
    numbered = "\n".join(f"{i + 1}: {t}" for i, t in enumerate(flat))
    if len(numbered) > PDF_MAX_CHARS:
        raise RuntimeError(
            f"PDF의 글자가 너무 많습니다 (약 {len(numbered) // 1000}천 자). "
            "쪽을 나눠 올려 주세요."
        )

    payload = {
        "systemInstruction": {"parts": [{"text": PDF_SPLIT_SYSTEM_PROMPT}]},
        "contents": [{"role": "user", "parts": [
            {"text": "다음 자료에서 영어 지문의 시작·끝 줄 번호를 찾아 주세요.\n\n" + numbered},
        ]}],
        "generationConfig": {
            # 경계 찾기는 판단이 아니라 확인에 가깝다 — 낮은 온도가 맞다.
            # 본문을 뱉지 않으므로 여기서는 온도를 올려 재현 차단을 피할 이유가 없다.
            "temperature": 0.0,
            "maxOutputTokens": 8192,
            "responseMimeType": "application/json",
            "responseSchema": PDF_SPLIT_SCHEMA,
        },
    }
    result = _gemini_json(payload, api_key, model, _PDF_SPLIT_TRUNC_MSG)

    out = []
    for item in result.get("passages") or ():
        try:
            start = int(item.get("start", 0))
            end = int(item.get("end", 0))
        except (TypeError, ValueError):
            continue
        # 모델이 준 것은 번호뿐이다 — 범위를 실제 줄 수 안으로 자르고 본문은 원문에서 꺼낸다
        start = max(1, start)
        end = min(len(flat), end)
        if end < start:
            continue
        text = _pdf_clean_passage(" ".join(flat[start - 1:end]), drop_labels=True)
        if len(text) < PDF_MIN_PASSAGE_CHARS:
            continue
        name = _TAG_STRIP_RE.sub("", str(item.get("name") or "")).strip()[:20]
        out.append({"name": name, "text": text})
    return {"passages": out, "note": str(result.get("note") or "").strip()}


# ── 기출 시험지 유형 분석 스키마 ──
# 시험지 사진 여러 장을 한 번에 보고, 문항마다 '무엇을 묻는 문제인지'를 뽑는다.
# 영어 지문은 일부러 옮겨 적지 않는다 — 유형 판정에 필요 없고, 널리 공개된 지문을
# 그대로 재현하려다 RECITATION 차단에 걸리는 길을 아예 피한다(call_gemini_ocr 주석 참고).
EXAM_SCAN_SCHEMA = {
    "type": "OBJECT",
    "properties": {
        "title": {"type": "STRING"},
        "questions": {
            "type": "ARRAY",
            "items": {
                "type": "OBJECT",
                "properties": {
                    "no": {"type": "STRING"},
                    "group": {"type": "STRING"},
                    "format": {"type": "STRING"},
                    "prompt": {"type": "STRING"},
                    "kind": {"type": "STRING"},
                    "fit": {"type": "STRING"},
                    "note": {"type": "STRING"},
                },
                "required": ["no", "group", "format", "prompt", "kind", "fit", "note"],
                "propertyOrdering": ["no", "group", "format", "prompt",
                                     "kind", "fit", "note"],
            },
        },
        "note": {"type": "STRING"},
    },
    "required": ["title", "questions", "note"],
    "propertyOrdering": ["title", "questions", "note"],
}

# 시험지가 쓰는 유형 이름은 학교마다 제각각이다("어법상 어색한 것", "밑줄 친 부분 중
# 틀린 것", "다음 중 옳지 않은 것"). 그 이름을 우리 19유형에 갖다 붙이는 판단을 모델에게
# 맡기되, 고를 수 있는 이름은 호출할 때 QUIZ_TYPE_LABELS에서 그대로 넣어 준다 —
# 여기에 유형 이름을 베껴 두면 목록이 바뀔 때 조용히 어긋난다.
EXAM_SCAN_SYSTEM_PROMPT = r"""You analyse photos of a Korean high-school ENGLISH exam paper
(고등학교 영어 내신 기출) and report WHAT EACH QUESTION ASKS. Return ONLY the structured JSON
in the schema — no markdown, no commentary.

## Your job is classification, NOT transcription
Report the question layout of this exam. Do NOT copy the English reading passages — they are
irrelevant here and copying them wastes the whole output. Read the Korean question prompt
(발문) and the answer choices, then decide what type of question it is.

## Reading these scans
- Pages may be ROTATED or UPSIDE DOWN, and different pages may face different directions.
  Read them anyway; never skip a page because of its orientation.
- Handwriting is a student's marking, NOT part of the exam: circled numbers, X marks,
  underlines, pen notes in Korean or English. IGNORE all of it and read the PRINTED text.
  Never report a circled choice as if it were the printed answer.
- Cover EVERY question on EVERY page, in the order printed. Do not stop early.
- Skip the cover-page instructions (답안은 검정 볼펜으로…), the 배점표, and the answer sheet.

## Per question
- `no`: the number exactly as printed — "1", "14", "서답1", "서술형 3", "[서답형] 2".
- `group`: when one passage serves several questions ("[1-2] 다음 글을 읽고 물음에 답하시오"),
  put that range ("1-2") on EVERY question in it. Otherwise "".
- `format`: "선다형" for multiple choice (① ② ③ ④ ⑤), "서답형" for anything the student writes.
- `prompt`: the Korean 발문, without the leading number. ONE line, 60 characters MAX —
  if the 발문 is longer, keep the beginning and stop there. This field is only a label the
  teacher reads to recognise the question; a full transcript wastes the output budget that
  the remaining questions need.
- `kind`: the closest type from the ALLOWED LIST given in the user message, copied EXACTLY.
  Use "" when nothing on the list is close.
  The list has three groups (객관식 / 주관식 / 워크북). Korean 내신 서답형 — 영작, 우리말
  해석 쓰기, 동사 형태 고쳐 쓰기, 어법 틀린 곳 찾아 고쳐 쓰기, 단어 배열 — is almost always
  a 워크북 entry, not a 객관식 one. Look there before giving up and writing "".
  Judge by WHAT THE STUDENT DOES, not by the page layout: a 워크북 entry prints as a
  worksheet covering the whole passage rather than one numbered exam item, and that
  difference alone does NOT make the fit worse.
  When a 객관식/주관식 entry and a 워크북 entry would BOTH fit, prefer the 객관식/주관식 one —
  it comes out as a single numbered question like the exam's, while 워크북 comes out as a
  worksheet. (e.g. 동사 형태를 쓰게 하는 문항은 "동사형 쓰기"가 "동사형 연습하기"보다 낫다.)
- `fit`: how well that type reproduces this question —
    "같음"   the list type asks the same thing in the same shape
    "비슷함" same idea, different shape (e.g. the exam asks in Korean, the list type in English;
             the exam blanks three spots at once, the list type blanks one)
    "없음"   no list type produces this question. `kind` MUST be "" when fit is "없음".
- `note`: Korean, one short phrase, ONLY when fit is 비슷함 or 없음 — say concretely what
  differs or what is missing ("빈칸 세 개를 한 번에 짝짓는 형태", "찾은 뒤 문장을 다시 쓰게 함",
  "이 지문에만 해당하는 맞춤 발문"). Otherwise "".

## Judging fit honestly
Korean 내신 exams often write a prompt tailored to one specific passage
("이 글에 제시된 사례들이 공통적으로 보여 주는 도시 기반 시설의 특징으로 적절한 것은?").
It resembles a 주제/요지 question but is not one — a generic type cannot reproduce it.
Mark these "없음". Guessing a generous match is the worst outcome: the teacher then builds a
practice sheet believing it matches their school's exam when it does not.

## title and note
- `title`: what the paper calls itself, in Korean — "2026학년도 1학기 2차고사 영어1 2학년".
  "" if you cannot read it.
- `note`: Korean, one sentence, only for problems that affect the result — pages too blurred
  to read, a page that is clearly missing, questions hidden under handwriting. "" if clean.

Return valid JSON only."""


def build_exam_scan_user_prompt(page_count, page_from=0, page_total=0):
    """고를 수 있는 이름을 세 갈래로 나눠 보여 준다.

    워크북까지 넣는 이유: 학교 시험의 서답형(영작·해석·동사형·어법 고쳐 쓰기)은 객관식·
    주관식 유형에 대응하는 것이 거의 없고, 그 일들을 실제로 하는 것은 워크북 단계들이다.
    객관식·주관식만 보여 주면 서답형이 통째로 '없음'으로 판정된다."""
    mcq = [t for t in QUIZ_TYPE_LABELS if t in MCQ_ONLY_TYPES]
    # 주관식은 이름만으로 무엇을 시키는 문제인지 알기 어렵다. 설명 없이 내보냈더니
    # 설명이 붙은 워크북 쪽이 매번 이겨서(단답2가 '동사형 쓰기' 대신 '동사형 연습하기'로
    # 갔다) 같은 자리에서 겨루도록 여기에도 한 줄씩 붙인다.
    saq = [
        f"{t} — {QUIZ_KIND_HINTS[t]}" if t in QUIZ_KIND_HINTS else t
        for t in QUIZ_TYPE_LABELS if t not in MCQ_ONLY_TYPES
    ]
    wb = [f"{name} — {desc}" for name, desc in WORKBOOK_STAGE_LABELS.values()]
    # 쪽을 나눠 여러 번 부를 때는 '전체 중 몇 쪽째'인지 알려 준다.
    # 이 말이 없으면 모델이 앞쪽 문항을 못 봤다는 이유로 번호를 1부터 다시 매기거나,
    # 잘린 지문을 보고 '쪽이 빠졌다'는 note를 남긴다.
    if page_total and page_from:
        head = (
            f"전체 {page_total}쪽짜리 시험지 중 {page_from}~{page_from + page_count - 1}쪽입니다. "
            "여기 보이는 문항만, 시험지에 인쇄된 번호 그대로 분류하세요. "
            "앞뒤 쪽은 따로 처리하므로 빠진 쪽을 걱정하거나 번호를 새로 매기지 마세요."
        )
    else:
        head = f"시험지 {page_count}쪽입니다. 모든 쪽의 모든 문항을 빠짐없이 분류하세요."
    return "\n".join([
        head,
        "",
        "ALLOWED LIST — kind 에는 아래 이름 중 하나를 그대로 쓰고, 해당 없으면 빈 문자열.",
        "",
        "[객관식] 5지선다로 나옵니다:",
        "  " + ", ".join(mcq),
        "",
        "[주관식] 번호가 붙은 서답형 문항 1개로 나옵니다. 시험지의 서답형은 여기부터 보세요:",
        "\n".join("  " + s for s in saq),
        "",
        "[워크북] 지문 전체를 훑는 학습지로 나옵니다. 위 목록에 더 가까운 것이 있으면 그쪽을",
        "쓰되, 여기서 맞는 것을 찾았다면 반드시 고르세요 — 학습지 모양이라는 이유만으로",
        "'없음'으로 두면 안 됩니다:",
        "\n".join("  " + w for w in wb),
    ])


def call_gemini_exam_scan(files, api_key, model, page_from=0, page_total=0):
    """시험지 쪽 그림 여러 장을 한 번에 보고 문항별 유형을 돌려준다.
    files: [{"mime": ..., "data": "<base64>"}] — 화면이 PDF에서 꺼내 축소해 보낸다."""
    api_key = (api_key or "").strip() or os.environ.get("GEMINI_API_KEY", "").strip()
    if not api_key:
        raise RuntimeError(
            "관리자가 아직 서버에 Gemini API 키(GEMINI_API_KEY)를 설정하지 않았습니다. "
            "관리자에게 문의하세요."
        )
    model = model if (model and _MODEL_RE.match(model)) else MODEL

    parts = []
    for i, f in enumerate(files or (), 1):
        if not isinstance(f, dict):
            continue
        mime = (f.get("mime") or "").lower().split(";")[0].strip()
        data = f.get("data") or ""
        if mime not in EXAM_MIMES:
            raise RuntimeError(
                f"{i}번째 파일의 형식을 지원하지 않습니다({mime or '알 수 없음'}). "
                "PDF나 JPG·PNG 사진만 올릴 수 있습니다."
            )
        if not data:
            raise RuntimeError(f"{i}번째 파일의 내용이 비어 있습니다.")
        if len(data) > MAX_FILE_BYTES:
            raise RuntimeError(
                f"{i}번째 쪽이 너무 큽니다 (최대 {MAX_FILE_BYTES // 1048576}MB)."
            )
        parts.append({"inlineData": {"mimeType": mime, "data": data}})

    if not parts:
        raise RuntimeError("분석할 시험지를 올려 주세요.")

    parts.append({"text": build_exam_scan_user_prompt(len(parts), page_from, page_total)})
    payload = {
        "systemInstruction": {"parts": [{"text": EXAM_SCAN_SYSTEM_PROMPT}]},
        "contents": [{"role": "user", "parts": parts}],
        "generationConfig": {
            # 분류 작업이라 낮은 온도가 맞다. 0으로 두지 않는 이유는 OCR과 같다 —
            # 결정적 디코딩이 RECITATION 차단을 부른다.
            "temperature": 0.15,
            # 16384였는데 7쪽(약 30문항)짜리 시험지가 여기서 잘렸다.
            # 한 문항이 no·group·format·prompt(발문)·kind·fit·note를 다 싣고, 한글은
            # 토큰을 많이 먹는다. 게다가 쪽 수 상한은 EXAM_MAX_PAGES(16쪽)이라 이 칸이
            # 절반에도 못 미쳤다. 다른 무거운 호출과 같은 값으로 올려 상한을 맞춘다.
            "maxOutputTokens": 65536,
            "responseMimeType": "application/json",
            "responseSchema": EXAM_SCAN_SCHEMA,
        },
    }
    # salvage=True — 그래도 잘리면 통째로 버리지 않고 읽어 낸 문항까지 살린다.
    # 30문항 중 25문항이라도 표가 나오는 편이, 아무것도 없이 "쪽을 나눠 올리세요"보다
    # 낫다. 몇 문항까지 읽었는지는 아래에서 note로 알린다.
    result = _gemini_json(
        payload, api_key, model,
        "시험지의 문항이 너무 많아 분석하다가 잘렸습니다. 쪽을 나눠 올려 주세요.",
        salvage=True,
    )
    scan = normalize_exam_scan(result)
    if result.get("_truncated"):
        last = (scan["questions"][-1]["no"] if scan["questions"] else "").strip()
        cut = (
            f"시험지가 길어 분석이 중간에 끊겼습니다 — 문항 {len(scan['questions'])}개까지 "
            + (f"읽었습니다(마지막 {last}번). " if last else "읽었습니다. ")
            + "뒤쪽 문항까지 넣으려면 쪽을 나눠 두 번에 올려 주세요."
        )
        scan["note"] = f"{scan['note']} / {cut}" if scan["note"] else cut
    return scan


_EXAM_FITS = ("같음", "비슷함", "없음")


def normalize_exam_scan(result):
    """모델 응답을 화면이 믿고 쓸 수 있는 모양으로 정리한다.

    kind는 반드시 QUIZ_TYPE_LABELS 안의 이름이어야 한다 — 여기서 걸러내지 않으면
    화면이 곧바로 /api/quiz에 그 이름을 실어 보내고, 서버가 모르는 유형이라 조용히
    버려져 '고른 유형이 안 나오는' 증상이 된다(parse_quiz_items와 같은 원칙)."""
    rows = []
    for raw in (result or {}).get("questions") or ():
        if not isinstance(raw, dict):
            continue
        kind = str(raw.get("kind") or "").strip()
        fit = str(raw.get("fit") or "").strip()
        if kind not in QUIZ_TYPE_LABELS and kind not in WORKBOOK_KIND_NAMES:
            kind, fit = "", "없음"
        if fit not in _EXAM_FITS:
            fit = "비슷함" if kind else "없음"
        if fit == "없음":
            kind = ""          # 못 만드는 문항에 유형이 붙어 있으면 안 된다

        fmt = "서답형" if str(raw.get("format") or "").strip() == "서답형" else "선다형"
        note = sanitize_inline(str(raw.get("note") or ""))

        # 어느 탭에서 만드는지는 모델에게 묻지 않고 이름으로 정한다 — 이름이 어느
        # 목록에 있느냐가 곧 답이라, 모델이 틀릴 여지를 남길 이유가 없다.
        if not kind:
            engine = ""
        elif kind in WORKBOOK_KIND_NAMES:
            engine = "워크북"
        elif kind in MCQ_ONLY_TYPES:
            engine = "객관식"
        else:
            engine = "주관식"

        # 객관식/서답형이 어긋나면 '같음'일 수 없다.
        # 실측에서 모델이 서답형 '주제문을 완성하시오'에 객관식 유형 주제를 붙이고
        # 같음이라고 했다. 이름만 보면 맞지만 만들어 나오는 것은 5지선다라 시험지의
        # 영작 문항과 전혀 다른 물건이다. 반대 방향도 같다(선다형 빈칸 짝짓기에
        # 주관식 어법 선택형이 붙었다). 유형 이름이 그럴듯해서 생기는 착시라
        # 모델에게 맡기지 않고 여기서 기계로 끌어내린다.
        # 워크북은 전부 학생이 써 넣는 형태이므로 선다형과는 언제나 어긋난다.
        want_fmt = "선다형" if engine == "객관식" else "서답형"
        if kind and fmt != want_fmt:
            fit = "비슷함"
            gap = {
                "객관식": "이 유형으로 만들면 객관식이 됩니다",
                "주관식": "이 유형으로 만들면 주관식이 됩니다",
                "워크북": "워크북은 써 넣는 학습지로 나옵니다",
            }[engine]
            note = f"{note} / {gap}" if note else gap

        rows.append({
            "no": sanitize_inline(str(raw.get("no") or "")),
            "group": sanitize_inline(str(raw.get("group") or "")),
            "format": fmt,
            "prompt": sanitize_inline(str(raw.get("prompt") or "")),
            "kind": kind,
            "engine": engine,
            "fit": fit,
            "note": note,
        })
    if not rows:
        raise RuntimeError(
            "시험지에서 문항을 찾지 못했습니다. 시험지가 잘 보이는지 확인하고 다시 올려 주세요."
        )
    return {
        "title": sanitize_inline(str((result or {}).get("title") or "")),
        "questions": rows,
        "note": sanitize_inline(str((result or {}).get("note") or "")),
    }


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

(The reference workbook has 10 stages; stage 2 is not produced here, so there is a gap in
the numbering below — it is the reference material's numbering, not a mistake. Stage 1 needs
no extra data beyond sentences[].en/ko below, which every request already produces.)

The stages the app builds from your data:
  1 좌지문 우해석         지문 원문·해석을 나란히 놓고 읽기 ← en, ko (no new field)
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
  ⚠️ EVERY word you list in `writeKeys` MUST end up INSIDE {{ }} — including its inflected form
  (key "plant" → "Plants" must be inside the braces; key "seed" → "of seeds" leaves "of" outside
  but "seeds" inside). A keyword that is already printed on the page is not a hint, it is the
  answer, and the question stops working. Check every keyword against the mask before you answer.
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

### 청크를 자르는 자리 (직독직해 품질을 결정하는 곳 — 여기서 틀리면 한국어가 깨진다)
▸ 판정 기준은 단 하나: **그 청크의 `kor`만 따로 읽어도 우리말이 되는가.**
  안 되면 자른 자리가 틀린 것이다. 영어 길이가 아니라 한국어가 기준이다.
▸ 후치수식어(분사구·전치사구·관계절·to부정사구)를 떼어 낼 때는 **수식어의 첫 단어부터**
  새 청크를 시작한다. 수식어의 머리(spent, watching, that, of, to …)를 앞 청크 꼬리에
  남기면 앞 청크의 한국어가 반드시 깨진다.
    WRONG  <after a lifetime spent> / <watching those creatures>
           → "이제, 보낸 평생 후에" / "그 생물들을 관찰하는 데"   ← 앞이 말이 안 됨
    RIGHT  <after a lifetime> / <spent watching those creatures>
           → "평생을 보낸 후에" / "그 생물들을 관찰하며"
▸ 절대 가르지 않는 덩어리: 조동사+본동사, be+p.p.(수동태), have+p.p.(완료),
  to+동사원형, 전치사+그 목적어, 관사·소유격+명사, 구동사(give up, account for),
  상관어구의 한쪽(so ~ that의 so만, not only만).
▸ 한 청크가 두 줄을 넘길 만큼 길면 자를 자리를 다시 찾되, 위 규칙을 어기면서까지 자르지 마라.
  자를 자리가 없으면 길게 두는 편이 낫다.

- For EACH chunk provide {text, kor, anns}:
  * `text` = the chunk's ORIGINAL ENGLISH words, PLAIN — verbatim, in order, NO markup at all.
    Every English word of the passage MUST appear across the chunks' `text`. Drop nothing.
  * `kor` = the PLAIN Korean 직독직해 of THAT chunk only (no markup).
    · 그 조각만 읽어도 뜻이 통해야 하고, 청크를 순서대로 이어 읽으면 문장 전체가 되어야 한다.
    · 영어 어순을 따라간다(직독직해). 뒤 청크의 내용을 앞으로 당겨 오지 말고, 앞 청크의
      내용을 뒤에서 되풀이하지도 마라.
    · 조사·어미로 다음 청크와 자연스럽게 이어 준다("~하는", "~해서", "~인데", "~을").
    · 원문에 없는 말을 더하지 마라. 다만 우리말로 꼭 필요한 조사·주어 생략 보충은 허용한다.
  * `anns` = list of things to mark INSIDE this chunk's `text`. Each item = {t, role, rt, num, grp}:
      · `t`    = the EXACT substring of `text` to mark (copy it verbatim, letter for letter).
      · `role` = one of:
            "g"    어법(빨강)          "v"  어휘(파랑)        "gv" 어법+어휘(보라)
            "hl"   강조·연결어(노랑)    "tg" 목표 어법(주황, 목표 어법이 지정된 경우만)
            "conj" 등위·상관접속사(형광)     "num" 색 없이 병렬 번호만
      · `rt`   = short Korean explanation shown above the word (for "conj"/"num" use "").
      · `num`  = 0 normally. For parallel numbering use 1,2,3… (adds a small superscript number).
      · `grp`  = 0 normally. 병렬 표시(conj/num)에만 쓰는 **묶음 번호** — 아래 설명 참고.
    If nothing to mark, `anns` = [].

### COLOR DECISION RULE (role 고르기 — 기계적으로 적용, 가장 실수 잦은 곳)
  ▸ SINGLE word 한 단어:
      · 문법 포인트(관계사·접속사·조동사·전치사, 시제/태/준동사 형태: were cultivated, to grow) → "g".
        rt = 문법 기능만. 예: that→"명사절 접속사".
      · 내용어(명사·동사·형용사·부사)의 뜻이 포인트 → "v". rt = 짧은 뜻. 예: cultivate→"재배하다".
      · 기능어라도 **뜻을 몰라서 해석이 막히는** 부류(despite, notwithstanding, whereas,
        albeit, thereby, hence …)는 "g"가 아니라 "v"로 주고 rt에 뜻을 적는다.
        이런 단어에 "전치사"라고만 적으면 학생이 얻는 게 없다.
        예: despite→"~에도 불구하고", whereas→"~인 반면".
      · 한 단어는 절대 "gv"(보라) 금지 — 뜻을 보여 주고 싶으면 위처럼 "v"를 쓴다.
  ▸ 2단어 이상 고정표현(숙어·구동사·전치사구 관용구·상관표현: regardless of, in order to,
    be likely to, so ~ that …) → "gv". **rt = 우리말 뜻**. 예: regardless of→"~에 상관없이".
    ⚠️ 여기서 문법 범주 이름("숙어", "관용구", "전치사구", "구동사", "상관표현")을 rt로 쓰지 마라.
    보라색이라는 것 자체가 이미 '어법+어휘'임을 알려 주므로, 범주 이름을 또 적으면 학생이
    얻는 정보가 0이다. 학생이 정말 모르는 것은 그 덩어리의 **뜻**이다.
      WRONG  give up the ghost→"관용구"      RIGHT  give up the ghost→"낡은 관념을 버리다"
      WRONG  be responsible for→"숙어"        RIGHT  be responsible for→"~을 담당하다"
      WRONG  unique to→"전치사구"             RIGHT  unique to→"~에만 있는"
    뜻이 문맥에 따라 달라지는 표현은 **이 문맥에서의 뜻**을 쓴다.
    구조 자체가 포인트라 뜻을 우리말로 옮기기 어려운 틀(so ~ that, not only A but B,
    the 비교급 ~ the 비교급)만 예외로 "너무 ~해서 …하다"처럼 **뜻이 담긴 해석 틀**을 쓴다.
    이때도 "상관접속사"처럼 범주 이름만 적는 것은 금지.
  ▸ 연결어(However, Therefore, In addition …) → "hl". rt = 역접/대조/첨가 등 기능.
    예외: 상관접속사의 일부인 말은 "hl"이 아니라 "conj"다. 특히 **not only A but also B**의
    "also"는 첨가 연결어처럼 보여도 상관접속사 구문의 일부이므로 "conj"로 표시한다(아래 병렬 규칙).
  ▸ 목표 어법이 지정되면 그 구조만 "tg"(주황), 나머지 어법은 "g".
  HARD LIMITS: "g" rt=문법용어만(뜻 0%) / "v" rt=뜻만 / "gv" rt=뜻(문법 범주 이름 금지)
              / "gv"는 2단어 이상만 / rt는 문장 해석이 아니라 아주 짧게.
  WRONG rt <재배하다(과거 수동태)>  →  RIGHT rt <과거 수동태>.
  ▸ **rt에 후보를 늘어놓지 마라 — 그 자리에 실제로 쓰인 것 하나로 판정해 적는다.**
    "형용사/분사", "명사/동명사", "현재분사/동명사"처럼 빗금으로 둘을 적으면 학생은
    둘 중 무엇인지 끝내 알 수 없다. 형태를 보고 하나를 골라라.
      WRONG  with half of the forests gone → "with+명사+형용사/분사"
      RIGHT  with half of the forests gone → "with+명사+과거분사"
    오른쪽 note도 같은 이름으로 불러라 — 왼쪽이 "과거분사"인데 note가 "형용사"라고
    하면 좌우가 어긋난다.
  ▸ **생략된 말(목적격 관계대명사·접속사 that·주격관계사+be)은 '생략된 자리 바로 뒤
    낱말'에 표시한다.** 관계절의 끝 낱말에 붙이면 생략이 어디서 일어났는지 알 수 없다.
      the children (that) you are supporting
        RIGHT  t="you",         rt="목적격 관대 생략"
        WRONG  t="supporting",  rt="목적격 관대 생략"
    note가 "children 뒤에 생략"이라고 썼으면 표시도 그 바로 다음 낱말에 있어야 한다.

### 등위·상관접속사 병렬 (MANDATORY — 가장 자주 빠뜨리는 항목, 기계 검사로 대조된다)
DEFAULT = MARK IT. 지문에 나오는 "and / or / but / nor / yet"은 아래 '제외 목록'에 해당하지
않는 한 **전부** 등위접속사로 보고 표시하라. "이건 굳이 병렬이라 할 것까진…" 하고 넘기지 말 것.
빠뜨린 접속사는 서버가 기계적으로 세어 되돌려 보내므로, 처음부터 빠짐없이 표시하는 편이 낫다.

▸ **묶음 번호 `grp` — 한 문장에 접속사가 둘 이상일 때 반드시 필요하다.**
  한 문장에 등위접속사가 여러 개면 각 접속사가 잇는 짝이 서로 다르다. 그런데 번호를
  전부 1,2로만 매기면 화면에 ¹…²…¹…² 가 뒤섞여 **어느 ¹이 어느 ²와 짝인지 알 수 없다.**
  그래서 접속사마다 묶음 번호를 준다. 서버가 묶음별로 색을 달리 칠해 구분해 준다.
    · 한 문장 안에서 등위접속사가 나오는 **순서대로** grp = 1, 2, 3… 을 매긴다.
    · 접속사 ann과 그 접속사가 잇는 요소 ann이 **모두 같은 grp** 값을 갖는다.
    · `num`은 그 묶음 **안에서만** 1,2,3…으로 매긴다(묶음이 바뀌면 다시 1부터).
    · 병렬과 무관한 ann(어법·어휘 등)은 grp = 0.
  예: "everyone ¹accesses the news through the ¹Internet or ²social media,
       and ²takes the information that suits their ¹tastes or ²beliefs."
    → or(Internet/social media)가 첫 접속사   grp=1: Internet num=1, social media num=2
      and(accesses/takes)가 두 번째 접속사    grp=2: accesses num=1, takes num=2
      or(tastes/beliefs)가 세 번째 접속사     grp=3: tastes num=1, beliefs num=2
    문장에 접속사가 하나뿐이면 그 하나가 grp=1이다(지금까지와 똑같다).
  ⚠️ **한 묶음(grp)에 and/or/but/nor를 둘 이상 넣지 마라.** 서버가 기계로 센다.
    특히 **병렬 안에 병렬**이 있을 때 둘을 한 묶음으로 묶어 오는 실수가 잦다 —
    "A, B, and C₁ and C₂"에서 바깥 and는 A·B·(C₁ and C₂ 통째)를 잇고, 안쪽 and는
    C₁·C₂를 잇는다. 서로 다른 묶음이다.
    예: "the depths of human emotion, the nuances of relationships,
         and the challenges and triumphs of the human spirit"
      → 바깥 and grp=1: depths num=1, nuances num=2,
                        **"the challenges and triumphs" num=3** (안쪽 병렬을 통째로)
        안쪽 and grp=2: challenges num=1, triumphs num=2
    바깥 묶음의 마지막 번호(3)를 빠뜨리면 화면에 ¹²만 남아, 나열된 셋 중 하나가
    사라진 것처럼 보인다. 안쪽 요소에 이미 ann이 있어도 바깥 요소 ann을 따로 만들어라
    — 자리가 겹쳐도 서버가 번호만 앞에 꽂아 준다.

For EACH such conjunction:
  · 접속사 자체에 ann: {t:"and", role:"conj", rt:"", num:0, grp:<이 접속사의 묶음 번호>}
  · 그 접속사가 잇는 **모든** 병렬 요소에 번호 ann: num = 1, 2, 3… (grp은 접속사와 같게)
      {t:"influence", role:"num", rt:"", num:1, grp:1}, {t:"invest", role:"num", rt:"", num:2, grp:1}
    (그 요소가 색도 받을 만하면 role을 "num" 대신 "g"/"v"/"gv"로 주고 num·grp만 붙인다.)
  · ⚠️ 번호는 **각 묶음(grp)마다 1부터** 시작해 빠짐없이 이어져야 한다. 2를 붙였는데 1이 없으면
    화면에 위첨자 ²만 덩그러니 뜨고 짝이 보이지 않아, 학생은 무엇과 무엇이 병렬인지 알 수 없다.
    가장 흔한 실수: **앞쪽 요소에 이미 색 ann이 있어서** 거기에 num 붙이는 걸 잊는 것.
      WRONG  {t:"flexible", role:"v", rt:"유연한", num:0, grp:0} … {t:"the ability", role:"num", num:2, grp:1}
      RIGHT  {t:"flexible", role:"v", rt:"유연한", num:1, grp:1} … {t:"the ability", role:"num", num:2, grp:1}
    같은 요소에 ann을 두 개 만들지 말고, 이미 있는 ann의 num·grp만 채워라.
    서버가 묶음별로 1 없이 2가 있는 문장을 기계로 찾아 되돌려 보낸다.
  · **앞말을 바꿔 말하는 or**(= '즉/다시 말해', 동격)도 두 명사구를 잇는 등위접속사이므로
    conj와 병렬 번호를 똑같이 붙인다. 번호가 '무엇과 무엇이 같은 말인지' 짚어 주기 때문이다.
    대신 kor은 '또는'이 아니라 **'즉'**으로 옮기고, note에서도 '동격'이라고 설명해
    왼쪽 번호와 오른쪽 해설이 같은 것을 가리키게 하라.
      예: <flexible behavior, or the ability to change their behavior>
          → ¹flexible behavior, or ²the ability… / kor "즉 …" / note "…와 동격인 명사구"
  · 상관접속사는 **짝을 이루는 말을 모두** "conj"로 표시하고 **같은 grp**를 준다:
      both…and / either…or / neither…nor / not only…but (also) / not…but /
      between A and B — "both"와 "and" 각각에 conj ann.
    ⚠️ **not only A but also B 의 "also"도 conj로 표시하라**(같은 grp, num:0).
      오른쪽 해설에서는 이 구문을 "not only A but (also) B"라고 한 덩어리로 부르는데,
      왼쪽에서 "also"만 노란 강조(hl)로 칠하면 좌우가 어긋나 학생이 헷갈린다.
      "but"과 "also"가 떨어져 있어도( "but they also want" ) 각각 conj ann을 만든다
      — 붙어 있지 않으므로 하나의 t로 묶으려 하지 말 것.
      단, 상관접속사와 무관한 그냥 부사 "also"는 여기 해당하지 않는다.

▸ 놓치기 쉬운 병렬 — 이 목록을 한 항목씩 짚어 가며 지문을 훑어라:
  1. 3개 이상 나열: "A, B, and C" → 쉼표로 이어진 앞의 것들까지 전부 num 부여 (1,2,3).
  2. **절·문장 병렬**: "S+V …, and S+V …" — 절을 잇는 and/but/or도 반드시 표시.
     ⚠️ **여기서 가장 자주 틀린다: 절을 잇는데 동사만 묶는 것.** 기계로 대조한다.
     ▸ 판정법 — 접속사 **뒤에 새 주어가 나오면 절 병렬이다.**
         "…, and consequently, **they** are viewed as…"  → they가 새 주어 → 절 병렬
         "they study and work"                          → 뒤가 바로 동사 → 동사구 병렬
       주어가 대명사(they/it/this/we…)든 명사구든 마찬가지다.
     ▸ 절 병렬이면 번호가 붙는 요소는 **그 절 전체**다. t를 절의 **첫 낱말(주어)부터**
       잡아라. 동사부터 잡으면 학생은 '동사 둘이 병렬'이라고 거꾸로 배운다.
         WRONG  They ¹convert the CO2 …, and consequently, they ²are viewed as …
                (번호가 convert / are viewed as 에만 붙음)
         RIGHT  ¹They convert the CO2 …, and consequently, ²they are viewed as …
     ▸ 절이 길어 한 청크를 넘으면 조각마다 **같은 번호**를 붙여 이어라(위 8번).
     ▸ note에 '절을 연결한다'고 썼으면 표시도 반드시 절 단위여야 한다. 왼쪽은 동사만
       묶어 놓고 오른쪽에서 "두 절을 연결"이라고 하면 좌우가 어긋난다.
  3. **동사구 병렬**: "can help develop and improve" — 조동사 뒤 원형 두 개.
  4. **to부정사 병렬에서 두 번째 to 생략**: "to grow and (to) survive".
  5. 전치사구·분사구·형용사·부사의 병렬: "in schools and in homes", "growing and spreading".
  6. 명사구 병렬: "hundreds of chemical reactions and processes".
  7. 문두의 But/And/Or (앞 문장과 잇는 경우)도 conj로 표시한다.
  8. 병렬 요소가 여러 chunk에 걸쳐 있어도 각 chunk의 anns에 각각 번호를 넣어 이어 붙인다.
     ▸ **한 요소가 끊겨 있으면 조각마다 같은 번호를 붙여라** — 번호를 나누지 마라.
       청크를 넘어 끊겼든, 한 청크 안에서 다른 말에 끼여 끊겼든 마찬가지다.
       서버는 '같은 번호가 연달아 나오면 한 요소'로 읽는다. 사이에 그 묶음의 다른
       번호가 끼어들면 그때만 다른 요소로 본다.
         예: ¹to grow in the wild / and ²there survive ²the winter
             → "there survive"와 "the winter"는 둘 다 2번 요소의 조각이다.

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

▸ 용어를 틀리기 쉬운 자리 — 아래는 **문장에서의 역할**로 판정한다. 모양(-ing/-ed)만 보고
  고르지 마라. 여기서 틀리면 왼쪽 루비와 오른쪽 해설이 서로 다른 말을 하게 된다.
  · -ing가 **주어·목적어·보어·전치사의 목적어** 자리 → "동명사". 앞에 의미상 주어(명사·소유격)가
    붙어 있어도 동명사다. 예: <scientists attributing consciousness to any animal is …>
    에서 attributing은 **동명사**(주어), 현재분사가 아니다.
  · -ing가 **명사를 꾸미거나** 분사구문을 이끌면 → "현재분사".
  · spend/waste + 시간·돈 + -ing 의 -ing → "동명사" (spend ~ (in) -ing 구문).
  · -ed가 명사를 뒤에서 꾸미면 → "과거분사". be동사 뒤면 수동태 또는 보어.
  · become/get/grow + p.p. → "수동 의미 보어"로 쓰고, 능동 수동태(be+p.p.)와 구분한다.
  · to부정사는 자리에 따라 "명사적/형용사적/부사적 용법"까지 적는다. 그냥 "to부정사"는 정보가 없다.
  · **가주어 it은 진주어(to부정사구·that절)를 실제로 받을 때만** 그렇게 부른다.
    <It is time to V>, <It is no use V-ing>처럼 뒤의 to부정사가 앞 명사(time 등)를
    수식하는 구문의 it은 가주어가 아니라 **비인칭 주어**다. 시간·날씨·거리의 it도 마찬가지.
    "it은 가주어인데 to부정사는 time을 수식한다"는 그 자체로 앞뒤가 안 맞는 설명이다
    — 가주어라고 썼으면 무엇이 진주어인지 말할 수 있어야 한다.
  판단이 애매하면 그 자리에는 아예 ann을 달지 마라 — 틀린 용어를 다는 것보다 낫다.

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
   conj만 있고 번호가 없으면 미완성이다. 번호는 **묶음(grp)마다** 1부터 시작해 빠진 숫자가
   없어야 한다 (2가 있는데 1이 없으면 화면에 짝 없는 위첨자가 뜬다 — 서버가 기계로 검사한다).
   그리고 한 문장에 접속사가 둘 이상이면 grp를 순서대로 1,2,3…으로 서로 다르게 매겼는지,
   각 요소가 **자기 접속사와 같은 grp**를 갖는지 다시 확인하라. 여기가 틀리면 화면에서
   엉뚱한 것끼리 같은 색으로 묶여 학생이 잘못 배운다.
7. 한국어 청크: 각 chunk의 `kor`을 **하나씩 따로** 소리 내어 읽어 본다. 그 조각만으로
   우리말이 안 되는 것이 하나라도 있으면 청크를 자른 자리가 틀린 것이다 — 자리를 다시
   잡아라(수식어의 머리를 앞 청크에 남기지 않았는지부터 확인). 그런 다음 순서대로
   이어 읽어 문장 전체가 자연스러운 우리말이 되는지 확인한다.
8. 용어 일치: 같은 단어를 두고 왼쪽 rt와 오른쪽 note·examNote가 다른 문법 용어를 쓰고
   있지 않은지 대조한다. 다르면 rt 쪽을 옳은 것으로 고치고 note를 거기에 맞춘다.
Only return JSON after all eight checks.

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
- ⚠️ 왼쪽 루비와 **같은 말**을 해야 한다. 화면은 왼쪽(청크의 rt)과 오른쪽(note·examNote)을
  나란히 붙여 보여 주므로, 같은 단어를 왼쪽에서 "현재분사", 오른쪽에서 "동명사구 주어"라고
  하면 학생은 어느 쪽이 맞는지 알 수 없다.
  note·examNote에서 어떤 단어의 문법 용어를 쓸 때는, 그 단어의 `anns` rt에 쓴 용어를
  **그대로** 쓴다. 쓰다가 rt가 틀렸다는 걸 알아차렸으면 note를 고치지 말고 **rt를 고쳐라**.
  note에 등장하지 않는 문법 포인트를 새로 지어내지도 말 것.
- ⚠️ **빨강(g)·보라(gv)·주황(tg)으로 표시한 것은 하나도 빠짐없이 note에서 다뤄라**
  (기계로 대조한다). 파랑(v)은 뜻만 보여 주는 표시라 루비로 끝나도 되지만, 어법 표시는
  '왜 색이 칠해졌는지'를 학생이 왼쪽만 보고는 알 수 없다. 표시해 놓고 설명하지 않으면
  그 색은 학생에게 수수께끼일 뿐이다.
  · 특히 **생략·도치처럼 눈에 보이지 않는 것**은 무엇이 어디서 생략·도치됐는지 반드시
    문장으로 밝혀라. 왼쪽에 "목적격 관대 생략"이라고만 떠 있고 note가 딴 이야기를 하면
    학생은 어느 자리가 생략인지 끝내 알 수 없다.
      RIGHT  note: "<code class="g">children</code> 뒤에 목적격 관계대명사가 생략되어…"
  · 한 문장에 표시가 많으면 두세 문장으로 나눠 쓰되, 표시한 것을 빠뜨리지는 마라.

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


def _drop_dangling_tag(html):
    """닫히지 않은 채 끝난 태그 조각을 잘라 낸다.

    모델이 해설을 '<code class=' 처럼 태그 도중에 끝내는 일이 실제로 관찰됐다
    (JSON 문자열 안의 따옴표를 잘못 이스케이프하면 그 자리에서 값이 끊긴다).
    그대로 innerHTML에 넣으면 브라우저가 미완성 태그로 보고 뒤 내용을 삼켜
    해설이 통째로 사라지거나 레이아웃이 깨진다. 마지막 '>' 뒤에 '<'가 남아 있으면
    거기서부터 버린다."""
    if not html or "<" not in html:
        return html
    cut = html.rfind("<")
    if cut > html.rfind(">"):
        return html[:cut].rstrip()
    return html


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

    return _drop_dangling_tag(_ANY_TAG_RE.sub(repl, html))


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


# 모델이 영한 혼용 문법 용어를 가끔 오타 낸다(특히 처리할 문법 포인트가 많은
# 긴 지문에서) — "to부정사"의 "to"가 발음이 비슷한 한글 "투"로 바뀌는 식.
# 프롬프트로는 100% 못 막으므로, 화면에 나가기 직전 기계적으로 바로잡는다.
# 같은 종류의 오타가 더 발견되면 이 목록에 추가하면 된다.
_KNOWN_TERM_FIXES = (
    (re.compile(r"투부정사"), "to부정사"),
)


def _fix_known_typos(text):
    if not text:
        return text
    for pat, repl in _KNOWN_TERM_FIXES:
        text = pat.sub(repl, text)
    return text


# 줄바꿈 금지를 붙일 최대 길이. 이보다 긴 대상은 그냥 접히게 둔다 —
# 좁은 화면에서 한 줄로 붙들면 카드 밖으로 삐져나가는 쪽이 더 나쁘기 때문.
_NOBREAK_MAX = 28


def _nobreak(word):
    """루비/형광 표시가 줄 끝에서 쪼개지지 않게 할지. 짧은 대상에만 적용한다.
    브라우저는 ruby의 본문이 두 줄로 나뉘면 위의 한글 설명까지 잘라서 나눠 붙인다
    ('For example,' + '예시' → 'For'에 '예', 'example,'에 '시'). 실제로 나던 오류."""
    return len(word) <= _NOBREAK_MAX and word.count(" ") <= 4


# 병렬 묶음에 준비된 색의 개수. 한 문장에 접속사가 이보다 많으면 첫 색으로 돌아간다
# (그렇게까지 접속사가 많은 문장은 드물고, 색을 더 늘리면 다른 표시와 헷갈린다).
_CONJ_GROUP_COLORS = 3


def _conj_group_class(grp):
    """묶음 번호 → CSS 클래스(cg1/cg2/cg3).

    값이 없거나 이상하면 1번(초록)으로 본다. 모델이 grp를 빠뜨려도 예전과 똑같이
    보이게 하려는 것 — 새 필드 때문에 화면이 깨지는 일은 없어야 한다."""
    try:
        n = int(grp)
    except (TypeError, ValueError):
        n = 1
    if n < 1:
        n = 1
    return f"cg{(n - 1) % _CONJ_GROUP_COLORS + 1}"


def _wrap_ann(word, a):
    """평문 영어 조각 word 에 역할(role)에 맞는 루비/색상/병렬번호를 입힌다."""
    role = (a.get("role") or "g").strip()
    rt = _esc_html(_fix_known_typos((a.get("rt") or "").strip()))
    w = _esc_html(word)
    num = a.get("num")
    numhtml = ""
    cg = _conj_group_class(a.get("grp"))
    if isinstance(num, (int, float)) and int(num) > 0:
        numhtml = f'<sup class="conj-num-top {cg}">{int(num)}</sup>'
    nb = " nobreak" if _nobreak(word) else ""
    if role == "conj":
        return numhtml + f'<span class="conj-hl {cg}{nb}">{w}</span>'
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
    # 자리 다툼에서는 색·루비 주석이 '번호만 붙이는' 주석(role "num")보다 먼저 자리를 잡는다.
    # 번호는 자리를 못 잡아도 assemble_eng이 앞에 꽂아 주지만, 색·루비는 자리를 잃으면
    # 통째로 사라진다. 병렬 안에 병렬일 때 바깥 요소의 번호 주석이 안쪽 구간을 통째로
    # 삼켜, 안쪽의 색·뜻이 화면에서 사라지던 것을 막는다.
    ordered = sorted(
        enumerate(anns or []),
        key=lambda p: (
            1 if isinstance(p[1], dict) and (p[1].get("role") or "").strip() == "num" else 0,
            p[0],
        ),
    )
    for _, a in ordered:
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


def _grp_no(a):
    """주석의 묶음 번호를 정수로. 없거나 이상하면 1번 묶음(_conj_group_class와 같은 규칙)."""
    try:
        n = int(a.get("grp"))
    except (TypeError, ValueError):
        n = 1
    return max(n, 1)


def _ann_number_marks(text, anns, spans):
    """자리를 못 잡아 버려진 병렬 번호를 '번호만' 꽂아 되살린다.

    병렬 안에 병렬이 있으면(A, B, and C₁ and C₂) 바깥 묶음의 세 번째 요소가
    "C₁ and C₂" 통째다. 그런데 그 안쪽 요소들이 먼저 자리를 차지하고 있어서
    바깥 요소의 주석이 겹침 방지에 걸려 통째로 버려졌다. 화면에는 ¹²만 남고 ³이
    사라져, 나열된 셋 중 하나가 없는 것처럼 보였다(실제로 나던 문제).

    번호는 낱말을 감싸지 않고 앞에 붙이기만 하므로, 자리가 겹쳐도 꽂을 수 있다.
    돌려주는 값은 (꽂을 위치, 번호 HTML) 목록이며 위치 오름차순이다."""
    placed = {id(a) for _, _, a in spans}
    shown = set()   # 이미 화면에 뜬 (묶음, 번호) — 같은 번호를 두 번 꽂지 않는다
    for _, _, a in spans:
        n = a.get("num")
        if isinstance(n, (int, float)) and int(n) > 0:
            shown.add((_grp_no(a), int(n)))
    free = [False] * len(text)   # 낱말 경계만 보고, 자리 다툼은 하지 않는다
    marks = []
    for a in anns or []:
        if not isinstance(a, dict) or id(a) in placed:
            continue
        n = a.get("num")
        if not (isinstance(n, (int, float)) and int(n) > 0):
            continue
        key = (_grp_no(a), int(n))
        if key in shown:
            continue
        t = (a.get("t") or "").strip()
        if not t:
            continue
        idx = _find_ann(text, t, free)
        if idx == -1:
            # 대상이 여러 chunk에 걸쳐 잘렸을 수 있다 — 첫 낱말만으로 다시 찾는다
            head = t.split()[0] if t.split() else ""
            idx = _find_ann(text, head, free) if head else -1
        if idx == -1:
            continue
        marks.append((idx, f'<sup class="conj-num-top {_conj_group_class(a.get("grp"))}">'
                           f'{int(n)}</sup>'))
        shown.add(key)
    marks.sort()
    return marks


def assemble_eng(text, anns):
    """모델이 준 평문 영어(text) 위에, 주석 목록(anns)의 대상 문자열을 찾아
    색상/루비/병렬번호를 겹쳐 최종 영어 HTML을 만든다. 매칭 안 되는 주석은 무시하되
    영어 원문은 항상 그대로 보존된다."""
    text = text or ""
    if not text:
        return ""
    spans = _ann_spans(text, anns)
    marks = _ann_number_marks(text, anns, spans)
    out = []
    pos = 0
    mi = 0

    def flush_marks(upto):
        """upto 앞에 있는 번호들을 먼저 꽂는다. 이미 지나간 자리(다른 주석 속)는 버린다."""
        nonlocal pos, mi
        while mi < len(marks) and marks[mi][0] <= upto:
            off, html = marks[mi]
            if off >= pos:
                out.append(_esc_html(text[pos:off]))
                out.append(html)
                pos = off
            mi += 1

    for st, en, a in spans:
        flush_marks(st)
        out.append(_esc_html(text[pos:st]))
        out.append(_wrap_ann(text[st:en], a))
        pos = en
    flush_marks(len(text))
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


# 보라(gv) 루비의 rt로 쓰면 안 되는 '문법 범주 이름'.
# 보라색이라는 것 자체가 어법+어휘를 뜻하므로 범주 이름을 또 적으면 학생이 얻는 정보가 0이다.
# 여기 있는 말"만"으로 이루어진 rt는 뜻이 아니라 분류라, 기계적으로 걸러 되돌려 보낸다.
_GV_CATEGORY_ONLY = {
    "숙어", "관용구", "관용어", "관용표현", "관용 표현", "전치사구", "구동사",
    "상관표현", "상관 표현", "상관접속사", "명사구", "동사구", "형용사구", "부사구",
    "분사구", "고정표현", "고정 표현", "표현", "보어 구문", "숙어 표현", "이디엄",
}

# 같은 단어를 두고 왼쪽 루비와 오른쪽 해설이 서로 다르게 부르면 모순인 용어 묶음.
# 한 묶음 안의 용어는 동시에 참일 수 없다 — 하나가 맞으면 나머지는 틀린 설명이다.
_CONFUSABLE_TERMS = (
    {"동명사", "현재분사"},
    {"가주어", "비인칭 주어", "지시대명사"},
    {"과거분사", "과거시제", "수동태"},
    {"주격 관계대명사", "목적격 관계대명사", "소유격 관계대명사", "관계부사"},
    {"관계대명사", "명사절 접속사", "부사절 접속사", "동격 접속사"},
    {"명사적 용법", "형용사적 용법", "부사적 용법"},
)


# 빗금으로 늘어놓으면 안 되는 '형태 이름'. 학생이 알고 싶은 것이 바로 둘 중 어느
# 쪽인지라, "형용사/분사"처럼 적으면 루비가 알려 주는 정보가 0이 된다.
_FORM_NAMES = {
    "형용사", "부사", "명사", "동사", "분사", "현재분사", "과거분사", "동명사",
    "부정사", "to부정사", "전치사", "접속사", "관계대명사", "관계부사", "보어",
}


def _slashed_forms(rt):
    """rt가 형태 이름 둘 이상을 빗금으로 늘어놓았는지. ("with+명사+형용사/분사" → True)"""
    if "/" not in rt:
        return False
    hits = 0
    for part in rt.split("/"):
        # "with+명사+형용사"처럼 앞에 틀이 붙어 있으면 마지막 조각만 본다
        tail = re.split(r"[+\s]", part.strip())[-1].strip()
        if tail in _FORM_NAMES:
            hits += 1
    return hits >= 2


def ruby_term_problems(result, limit=10):
    """루비(rt)가 규칙을 어긴 자리를 찾는다 — 지금은 보라(gv)만 본다.

    사용자가 가장 먼저 지적한 오류가 'give up the ghost → 관용구'처럼 뜻 대신 분류를
    적는 것이었다. 프롬프트로도 막지만 규칙은 확률이라, 확실히 판정되는 두 가지
    (범주 이름만 적음 / 한 단어에 gv)는 서버가 직접 세어 되돌려 보낸다."""
    out = []
    for s in result.get("sentences", []) or []:
        if not isinstance(s, dict):
            continue
        no = s.get("no")
        for c in s.get("chunks", []) or []:
            if not isinstance(c, dict):
                continue
            for a in c.get("anns", []) or []:
                if not isinstance(a, dict):
                    continue
                t = str(a.get("t") or "").strip()
                rt = str(a.get("rt") or "").strip()
                # 형태 후보를 빗금으로 늘어놓은 rt("형용사/분사")는 역할을 가리지 않고 걸러낸다.
                # 둘 중 무엇인지가 바로 학생이 알고 싶은 것이라, 나열하면 아무것도 알려 주지 못한다.
                if _slashed_forms(rt):
                    out.append(
                        f'{no}번 문장 "{t}" → 설명이 "{rt}"입니다. '
                        f"빗금으로 후보를 늘어놓지 말고 이 자리에 실제로 쓰인 형태 "
                        f"하나만 적으세요(예: 과거분사). 오른쪽 해설도 같은 이름으로 부르세요."
                    )
                    if len(out) >= limit:
                        return out
                if (a.get("role") or "").strip() != "gv":
                    continue
                if rt in _GV_CATEGORY_ONLY:
                    out.append(
                        f'{no}번 문장 "{t}" → 설명이 "{rt}"입니다. '
                        f"분류 이름 말고 이 문맥에서의 우리말 뜻을 적으세요."
                    )
                elif len(t.split()) < 2:
                    out.append(
                        f'{no}번 문장 "{t}"는 한 단어인데 보라(gv)로 표시했습니다. '
                        f'뜻을 보여 주려면 "v", 문법이면 "g"로 바꾸세요.'
                    )
                if len(out) >= limit:
                    return out
    return out


def term_conflicts(result, limit=10):
    """같은 단어를 왼쪽 루비와 오른쪽 해설이 다르게 부르는 자리를 찾는다.

    화면이 둘을 나란히 붙여 보여 주므로, 한 단어를 왼쪽에서 "현재분사",
    오른쪽에서 "동명사"라고 하면 학생은 어느 쪽이 맞는지 알 수 없다.

    오판(불필요한 재요청)을 피하려고 조건을 좁게 잡는다 — 해설이 그 단어를 실제로
    언급하고, 같은 묶음의 다른 용어를 쓰면서, 루비가 쓴 용어는 한 번도 쓰지 않은
    경우만 모순으로 본다. 한 문장에 동명사와 현재분사가 둘 다 있어 해설이 양쪽을
    모두 설명하는 경우는 걸러진다."""
    out = []
    for s in result.get("sentences", []) or []:
        if not isinstance(s, dict):
            continue
        no = s.get("no")
        note = _TAG_STRIP_RE.sub("", str(s.get("note") or "")) + " " + \
               _TAG_STRIP_RE.sub("", str(s.get("examNote") or ""))
        note = note.strip()
        if not note:
            continue
        for c in s.get("chunks", []) or []:
            if not isinstance(c, dict):
                continue
            for a in c.get("anns", []) or []:
                if not isinstance(a, dict):
                    continue
                if (a.get("role") or "").strip() not in ("g", "gv", "tg"):
                    continue
                t = str(a.get("t") or "").strip()
                rt = str(a.get("rt") or "").strip()
                if not t or not rt or t not in note:
                    continue  # 해설이 그 단어를 언급하지 않으면 대조할 수 없다
                for group in _CONFUSABLE_TERMS:
                    mine = [x for x in group if x in rt]
                    if len(mine) != 1:
                        continue
                    if mine[0] in note:
                        continue  # 해설도 같은 용어를 쓴다 — 모순 아님
                    others = [x for x in group if x != mine[0] and x in note]
                    if not others:
                        continue
                    out.append(
                        f'{no}번 문장 "{t}" — 루비는 "{mine[0]}", '
                        f'해설은 "{others[0]}"이라고 합니다. 둘 중 맞는 쪽으로 통일하세요.'
                    )
                    if len(out) >= limit:
                        return out
    return out


def broken_parallel_numbers(result, limit=10):
    """병렬 번호가 1부터 이어지지 않는 문장을 찾는다.

    2는 붙였는데 1이 없으면 화면에 위첨자 ²만 뜨고 짝이 없어, 무엇과 무엇이 병렬인지
    보이지 않는다. 앞쪽 요소에 이미 색 주석이 있을 때 거기에 num 붙이는 걸 잊어서
    생기는 실수라, 성실성에 맡기지 않고 기계로 한 번 더 센다.
    번호는 묶음(grp)마다 1,2,3…으로 매겨지므로 문장 안에서 묶음별로 나눠 검사한다.
    grp가 없으면 1번 묶음으로 본다(_conj_group_class와 같은 규칙)."""
    out = []
    for s in result.get("sentences", []) or []:
        if not isinstance(s, dict):
            continue
        groups = {}
        for c in s.get("chunks", []) or []:
            if not isinstance(c, dict):
                continue
            for a in c.get("anns", []) or []:
                if not isinstance(a, dict):
                    continue
                n = a.get("num")
                if not (isinstance(n, (int, float)) and int(n) > 0):
                    continue
                try:
                    g = int(a.get("grp"))
                except (TypeError, ValueError):
                    g = 1
                groups.setdefault(max(g, 1), set()).add(int(n))
        if not groups:
            continue
        eng = None
        for g in sorted(groups):
            nums = groups[g]
            missing = [n for n in range(1, max(nums) + 1) if n not in nums]
            # 접속사는 둘 이상을 잇는다 — 한 묶음에 번호가 하나뿐이면 짝을 못 찾은 것이다
            # (grp를 잘못 매겨 짝이 서로 다른 묶음으로 흩어졌을 때 이렇게 나타난다).
            lonely = not missing and len(nums) < 2
            if not missing and not lonely:
                continue
            if eng is None:
                eng = " ".join(
                    _TAG_STRIP_RE.sub("", (c.get("text") or ""))
                    for c in (s.get("chunks") or [])
                    if isinstance(c, dict)
                ).strip()
            if lonely:
                out.append(
                    f'{s.get("no")}번 문장 {g}번 묶음: 병렬 번호가 {sorted(nums)} 하나뿐입니다 '
                    f'— 짝이 되는 요소에도 같은 grp({g})로 번호를 붙이세요 "{eng[:90]}"'
                )
            else:
                out.append(
                    f'{s.get("no")}번 문장 {g}번 묶음: 병렬 번호 {sorted(nums)}만 있고 '
                    f'{missing}이(가) 빠졌습니다 — "{eng[:90]}"'
                )
            if len(out) >= limit:
                return out
    return out


# 등위접속사의 '뒤짝'. 상관접속사(both…and)는 앞짝+뒤짝이 한 묶음인 게 맞으므로,
# 한 묶음에 접속사가 몇 개인지는 이 뒤짝만 세어 판단한다.
_TAIL_CONJ = {"and", "or", "but", "nor"}


# 절 병렬 판정에 쓰는 조각들.
# 접속사 뒤에 '새 주어'가 나오면 그 접속사는 동사가 아니라 절을 잇고 있다는 뜻이다.
# 주어가 되풀이되지 않는 동사구 병렬("they study and work")과 갈리는 지점이 여기다.
_SUBJ_PRON_RE = re.compile(
    r"^(they|it|this|that|these|those|we|you|he|she|i|there)\b\s+[A-Za-z]", re.I
)
# 접속사와 새 주어 사이에 흔히 끼는 말 — 쉼표, 연결부사, 짧은 부사구
_AFTER_CONJ_SKIP_RE = re.compile(
    r"^(?:[,;\s]|consequently|therefore|thus|hence|then|also|moreover|furthermore|"
    r"subsequently|meanwhile|instead|however|in turn|as a result|so|yet|still|"
    r"[a-z]+ly)+", re.I
)
# 요소가 이 말로 시작하면 주어를 빼고 동사부터 묶은 것이다
_FINITE_START = {
    "is", "are", "was", "were", "am", "be", "been", "being",
    "has", "have", "had", "does", "do", "did",
    "can", "could", "will", "would", "shall", "should", "may", "might", "must",
}
# 요소 바로 앞이 이 말이면, 그 주어를 빼놓고 묶은 것이다
_PRECEDING_SUBJ_RE = re.compile(
    r"(?:^|[,;\s])(they|it|this|that|these|those|we|you|he|she|there)[,\s]+$", re.I
)
# 모델이 해설에서 스스로 '절을 연결한다'고 말한 경우
_NOTE_CLAUSE_RE = re.compile(r"절[을를]?\s*(?:서로\s*)?(?:연결|잇|이어|병렬)")


def _sentence_ann_positions(s):
    """문장의 모든 청크를 한 줄로 이어, 각 주석이 그 줄의 어디에 걸리는지 돌려준다.

    절 병렬인지 보려면 '접속사 뒤에 무엇이 오는가'를 읽어야 하는데, 그 뒤가 다음
    청크에 있는 일이 흔하다. 청크 경계를 지워야 판정할 수 있다.
    돌려주는 값은 (이어붙인 글, [(시작, 끝, 주석)…])."""
    pieces = []
    items = []
    base = 0
    for c in s.get("chunks", []) or []:
        if not isinstance(c, dict):
            continue
        text = _TAG_STRIP_RE.sub("", c.get("text", "") or "")
        used = [False] * len(text)
        for a in c.get("anns", []) or []:
            if not isinstance(a, dict):
                continue
            t = (a.get("t") or "").strip()
            if not t:
                continue
            pos = _find_ann(text, t, used)
            if pos < 0:
                continue
            for i in range(pos, pos + len(t)):
                used[i] = True
            items.append((base + pos, base + pos + len(t), a))
        pieces.append(text)
        base += len(text) + 1
    items.sort(key=lambda x: x[0])
    return " ".join(pieces), items


def clause_parallel_problems(result, limit=10):
    """절을 잇는 접속사인데 동사구만 묶어 놓은 자리를 찾는다.

    "They ¹convert the CO2 …, and consequently, they ²are viewed as …"처럼
    and가 완전한 절 둘을 잇는데 번호는 동사에만 붙는 일이 잦다. 그러면 학생은
    무엇과 무엇이 병렬인지 거꾸로 배운다 — 동사 둘이 병렬인 줄 안다.

    판정은 두 갈래다.
      · 접속사 뒤에 **새 주어**가 나오면 절 병렬이다. 주어를 되풀이하지 않는
        동사구 병렬("they study and work")과 여기서 갈린다 — 그쪽은 접속사 뒤가
        바로 동사라 걸리지 않는다.
      · 모델이 해설에서 스스로 '절을 연결한다'고 말했으면 그 말을 믿는다.
    그 두 경우에, 번호가 붙은 요소가 동사(조동사·be)부터 시작하거나 바로 앞에
    주어가 남아 있으면 '주어를 빼고 묶었다'로 본다."""
    out = []
    for s in result.get("sentences", []) or []:
        if not isinstance(s, dict):
            continue
        note = (
            _TAG_STRIP_RE.sub("", str(s.get("note") or "")) + " " +
            _TAG_STRIP_RE.sub("", str(s.get("examNote") or ""))
        )
        note_says_clause = bool(_NOTE_CLAUSE_RE.search(note))
        text, items = _sentence_ann_positions(s)
        if not items:
            continue

        # 묶음별로 접속사 위치와 번호 요소를 모은다
        groups = {}
        for st, en, a in items:
            g = groups.setdefault(_grp_no(a), {"conj": [], "els": []})
            role = (a.get("role") or "").strip()
            if role == "conj" and (a.get("t") or "").strip().lower() in _TAIL_CONJ:
                g["conj"].append((st, en))
            n = a.get("num")
            if isinstance(n, (int, float)) and int(n) > 0:
                g["els"].append((st, en, a))

        for g in sorted(groups):
            info = groups[g]
            if not info["conj"] or len(info["els"]) < 2:
                continue
            # 접속사 뒤에 새 주어가 오는가
            clause_level = note_says_clause
            for _st, en in info["conj"]:
                rest = text[en:en + 80].lstrip()
                rest = _AFTER_CONJ_SKIP_RE.sub("", rest).lstrip()
                if _SUBJ_PRON_RE.match(rest):
                    clause_level = True
                    break
            if not clause_level:
                continue

            for st, en, a in info["els"]:
                t = (a.get("t") or "").strip()
                head = t.split()[0].lower().strip(",.;:") if t.split() else ""
                left = text[max(0, st - 24):st]
                if head in _FINITE_START:
                    why = f'"{t}"가 동사부터 시작합니다'
                elif _PRECEDING_SUBJ_RE.search(left):
                    why = f'"{t}" 바로 앞에 주어가 빠져 있습니다'
                else:
                    continue
                out.append(
                    f'{s.get("no")}번 문장 {g}번 묶음: 이 접속사는 절 둘을 잇는데 '
                    f'{why} — 번호가 붙는 요소를 **주어부터 절 전체**로 넓히세요. '
                    f'(예: ¹They convert … and ²they are viewed as …) "{text[:90]}"'
                )
                if len(out) >= limit:
                    return out
                break   # 한 묶음에 한 번만 짚는다 — 고치는 방법은 어차피 같다
    return out


def conj_group_mixups(result, limit=10):
    """한 묶음(grp)에 등위접속사를 둘 이상 넣은 문장을 찾는다.

    접속사마다 묶음을 나누라고 일러 두어도, 병렬 안에 병렬이 있으면
    ("A, B, and C₁ and C₂") 두 접속사를 한 묶음으로 묶어 오는 일이 잦다.
    그러면 서버가 두 접속사에 같은 색을 칠하고 번호도 1,2,1,2로 겹쳐 매겨,
    화면에서 무엇과 무엇이 짝인지 알 수 없다 — 실제로 나던 문제다."""
    out = []
    for s in result.get("sentences", []) or []:
        if not isinstance(s, dict):
            continue
        groups = {}
        for c in s.get("chunks", []) or []:
            if not isinstance(c, dict):
                continue
            for a in c.get("anns", []) or []:
                if not isinstance(a, dict):
                    continue
                if (a.get("role") or "").strip() != "conj":
                    continue
                word = str(a.get("t") or "").strip().lower()
                if word not in _TAIL_CONJ:
                    continue
                groups.setdefault(_grp_no(a), []).append(word)
        for g in sorted(groups):
            words = groups[g]
            if len(words) < 2:
                continue
            eng = " ".join(
                _TAG_STRIP_RE.sub("", (c.get("text") or ""))
                for c in (s.get("chunks") or [])
                if isinstance(c, dict)
            ).strip()
            out.append(
                f'{s.get("no")}번 문장 {g}번 묶음에 접속사가 {len(words)}개'
                f'({", ".join(words)}) 들어 있습니다 — 접속사마다 묶음을 나누고'
                f'(grp 1,2,…), 바깥 묶음에는 안쪽 병렬 전체를 한 요소로 넣어 번호를'
                f' 빠짐없이 매기세요. "{eng[:90]}"'
            )
            if len(out) >= limit:
                return out
    return out


def _renumber_parallel(result):
    """묶음마다 병렬 번호를 글 순서대로 1,2,3…으로 다시 매긴다.

    모델이 번호를 2부터 시작하거나, 한 묶음 안 서로 다른 요소에 같은 번호(²…²)를
    붙여 오는 일이 있다. 그러면 화면에 짝 없는 위첨자가 떠서 무엇과 무엇이 병렬인지
    알 수 없다. 번호만큼은 '읽는 순서'가 곧 정답이라 서버가 직접 고칠 수 있다 —
    다시 물어보지 않는다(재요청은 느리고, 고쳐 온다는 보장도 없다).

    ▸ 같은 번호를 **두 번 써야 하는 경우는 그대로 둔다.**
      한 병렬 요소가 여러 조각으로 끊겨 있으면 각 조각에 같은 번호가 붙는다
      ("to grow in the wild / and there survive" 처럼 청크를 넘거나, 한 청크 안에서
      다른 말에 끼여 끊기거나). 그때 번호를 억지로 1·2로 갈라놓으면 한 요소가 둘로
      쪼개져 보인다.
      그래서 '같은 번호가 읽는 순서에서 **연달아** 나오면 한 요소'로 본다. 사이에
      그 묶음의 다른 번호가 끼어들면 그때만 다른 요소로 갈라 다시 매긴다.
      청크 경계는 보지 않는다 — 요소가 어디서 끊겼는지와 청크를 어디서 잘랐는지는
      서로 상관없는 일이기 때문이다.

    ▸ 짝이 아예 하나뿐인 묶음(모델이 병렬 상대를 못 찾은 경우)은 여기서 고치지
      못한다. 그건 broken_parallel_numbers가 잡아 모델에게 되묻는다."""
    for s in result.get("sentences", []) or []:
        if not isinstance(s, dict):
            continue
        groups = {}
        for ci, c in enumerate(s.get("chunks", []) or []):
            if not isinstance(c, dict):
                continue
            text = _TAG_STRIP_RE.sub("", c.get("text", "") or "")
            free = [False] * len(text)
            for oi, a in enumerate(c.get("anns", []) or []):
                if not isinstance(a, dict):
                    continue
                n = a.get("num")
                if not (isinstance(n, (int, float)) and int(n) > 0):
                    continue
                pos = _find_ann(text, (a.get("t") or "").strip(), free)
                groups.setdefault(_grp_no(a), []).append(
                    (ci, pos if pos >= 0 else len(text) + oi, oi, int(n), a)
                )
        for items in groups.values():
            items.sort(key=lambda x: (x[0], x[1], x[2]))
            new_no = 0
            prev_old = None   # 바로 앞 표시의 '원래' 번호
            for _ci, _pos, _oi, old, a in items:
                if old != prev_old:   # 번호가 바뀌는 자리에서만 다음 요소로 넘어간다
                    new_no += 1
                a["num"] = new_no     # 이어지는 조각이면 앞과 같은 번호를 그대로 받는다
                prev_old = old
    return result


# 왼쪽 표시 중 오른쪽 해설이 반드시 다뤄야 하는 것 — 빨강(어법)과 보라(어법+어휘).
# 파랑(v)은 뜻만 알려 주는 표시라 루비만으로 끝나도 되고, 노랑·형광은 연결어·병렬이라
# 해설에서 따로 설명할 것이 없다.
_NOTE_ROLES = ("g", "gv", "tg")
_RT_TOKEN_RE = re.compile(r"[+\s/·,()\[\]~]+")


def unexplained_marks(result, limit=10, per_sentence=3):
    """왼쪽에 표시해 놓고 오른쪽 해설이 한마디도 하지 않은 자리를 찾는다.

    화면이 왼쪽 표시와 오른쪽 해설을 나란히 붙여 보여 주므로, 색만 칠해져 있고
    설명이 없으면 학생은 '왜 여기에 색이 있지'에서 막힌다. 실제로 목적격 관계대명사
    생략을 왼쪽에만 표시하고 해설은 다른 이야기만 한 분석본이 나왔다.

    설명했는지는 두 가지로 본다 — 해설이 그 영어를 인용했거나, 루비에 적은 말을
    해설에서 다시 썼거나. 둘 다 아니면 설명이 빠진 것으로 본다."""
    out = []
    for s in result.get("sentences", []) or []:
        if not isinstance(s, dict):
            continue
        note = (
            _TAG_STRIP_RE.sub("", str(s.get("note") or "")) + " " +
            _TAG_STRIP_RE.sub("", str(s.get("examNote") or ""))
        ).strip()
        note_low = note.lower()
        found = 0
        for c in s.get("chunks", []) or []:
            if not isinstance(c, dict):
                continue
            for a in c.get("anns", []) or []:
                if not isinstance(a, dict):
                    continue
                role = (a.get("role") or "").strip()
                if role not in _NOTE_ROLES:
                    continue
                t = str(a.get("t") or "").strip()
                rt = str(a.get("rt") or "").strip()
                if not t or not rt:
                    continue
                if t.lower() in note_low:
                    continue      # 해설이 그 영어를 인용했다
                if any(tok and len(tok) >= 2 and tok in note
                       for tok in _RT_TOKEN_RE.split(rt)):
                    continue      # 루비에 적은 말을 해설에서 다시 썼다
                colour = "보라(어법+어휘)" if role == "gv" else "빨강(어법)"
                out.append(
                    f'{s.get("no")}번 문장: 왼쪽에 "{t}"를 {colour}으로 표시하고 '
                    f'"{rt}"라고 적었는데 해설에는 그 이야기가 없습니다 — '
                    f'무엇이 왜 그런지 해설에 한 문장 넣으세요.'
                )
                found += 1
                if len(out) >= limit:
                    return out
                if found >= per_sentence:
                    break
            if found >= per_sentence:
                break
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


def _analysis_regressed(retry, current, passage):
    """재요청 결과가 기존보다 나빠졌는지 본다.

    한 가지를 고쳐 오라고 다시 부르면 모델이 엉뚱하게 다른 것을 잃고 오는 일이 있다
    (문장이 줄거나, 영어가 빠지거나, 이미 잘 달려 있던 접속사·번호 표시를 지우거나).
    그런 결과는 채택하지 않고 기존 것을 유지한다."""
    return (
        len(retry.get("sentences") or []) < len(current.get("sentences") or [])
        or len(retry.get("_conjMiss") or []) > len(current.get("_conjMiss") or [])
        or len(retry.get("_numBroken") or []) > len(current.get("_numBroken") or [])
        or english_incomplete(retry, passage)
    )


def build_user_prompt(passage, target_grammar, mode, complete_hint=None,
                      english_fix=False, conj_hint=None, num_hint=None,
                      ruby_hint=None, conflict_hint=None, note_hint=None):
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
    if num_hint:
        # 1 없이 2만 붙은 자리 — 화면에 짝 없는 위첨자가 뜨는 것을 막는다
        lines.append(
            "⚠️ 아래 문장은 병렬 번호(묶음 grp 기준)가 1부터 이어지지 않습니다. 빠진 번호를 "
            "채우세요. 대개 앞쪽 병렬 요소에 이미 색 ann이 있어서 거기에 num을 붙이는 걸 잊은 "
            "경우입니다 — 새 ann을 만들지 말고 그 ann의 num·grp를 채우세요. "
            "'번호가 하나뿐'이라고 나온 묶음은 짝이 다른 grp로 잘못 흩어진 것이니, "
            "같은 접속사가 잇는 요소들이 모두 같은 grp를 갖도록 맞추세요. "
            "다시 보니 병렬이 아니었다면(앞말을 바꿔 말하는 동격의 or 등) "
            "붙어 있는 번호와 conj 표시를 모두 지우세요.\n"
            "'한 묶음에 접속사가 2개'라고 나온 곳은 병렬 안에 병렬이 있는 자리입니다. "
            "접속사마다 grp를 따로 주고(바깥 1, 안쪽 2), 바깥 묶음에는 안쪽 병렬 전체를 "
            "한 요소로 넣어 번호를 매기세요 — 예: 바깥 grp=1의 3번 요소 t=\"the challenges "
            "and triumphs\", 안쪽 grp=2는 challenges 1 / triumphs 2. 안쪽 ann과 자리가 "
            "겹쳐도 그대로 두세요(서버가 번호만 앞에 꽂습니다).\n"
            "'절 둘을 잇는데'라고 나온 곳은 접속사가 동사가 아니라 **절**을 잇는 자리입니다. "
            "번호가 붙는 요소를 동사구가 아니라 **주어부터 시작하는 절 전체**로 넓히세요 — "
            "t를 그 절의 첫 낱말(주어)부터 잡습니다. 절이 길어 한 청크에 안 들어가면 조각마다 "
            "같은 번호를 붙여 이어 주세요(번호를 나누지 마세요)."
        )
        for h in num_hint:
            lines.append("  · " + h)
    if ruby_hint:
        lines.append(
            "⚠️ 아래 루비(rt)가 규칙을 어겼습니다. 해당 ann만 고치고 나머지는 그대로 두세요."
        )
        for h in ruby_hint:
            lines.append("  · " + h)
    if conflict_hint:
        lines.append(
            "⚠️ 아래는 같은 단어를 왼쪽 루비와 오른쪽 해설이 서로 다르게 부르고 있습니다. "
            "화면이 둘을 나란히 보여 주므로 학생이 어느 쪽이 맞는지 알 수 없습니다. "
            "문장에서의 역할로 다시 판정해 맞는 용어 하나로 통일하세요 — 해설 문장을 "
            "적당히 바꾸는 것이 아니라, 틀린 쪽(대개 루비)을 고쳐야 합니다."
        )
        for h in conflict_hint:
            lines.append("  · " + h)
    if note_hint:
        lines.append(
            "⚠️ 아래는 왼쪽에 표시(빨강 g·보라 gv)만 해 두고 오른쪽 해설(note)이 그 이야기를 "
            "하지 않은 자리입니다. 화면이 둘을 나란히 붙여 보여 주므로, 색만 칠해져 있고 "
            "설명이 없으면 학생은 왜 표시됐는지 알 수 없습니다. 해당 문장의 note에 그 표시를 "
            "설명하는 문장을 넣으세요 — 무엇이(영어를 그대로 인용) 왜 그런 구조·뜻인지 "
            "한 문장이면 됩니다. 특히 생략·도치처럼 눈에 보이지 않는 것은 무엇이 어디서 "
            "생략·도치됐는지 반드시 밝히세요. 이미 있는 설명과 다른 표시는 그대로 두세요."
        )
        for h in note_hint:
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
    return "\n".join(lines)


def _gemini_call_with_retry(data, api_key, model, url=None, allow_fallback=True):
    """페이로드(JSON bytes)를 모델에 전송하고 재시도·모델 대체를 공통 처리한다
    (지문분석·문제제작 등 모든 Gemini 호출이 공유).
    - flash 429(속도 제한), 5xx(서버 과부하), 네트워크 오류 → 대기 후 자동 재시도
      (누적 대기가 MAX_RETRY_TOTAL을 넘으면 포기하고 명확한 한국어 오류로 안내)
    - 모델이 사라졌거나(400/404) 비-flash 429(할당량 0) → 사용 가능한 flash 모델로 자동 대체

    url: 기본값(None)이면 :generateContent로 보낸다. 인포그래픽처럼 부르는 곳이 다른
         기능은 여기에 주소를 넘긴다(모델명이 URL이 아니라 본문에 들어간다).
    allow_fallback: 모델이 없어졌을 때 다른 모델로 갈아타도 되는가. 이미지 생성처럼
         '대체할 만한 같은 종류의 모델'이 없는 호출은 False로 꺼야 한다 —
         그림 모델 자리에 글자 모델을 넣으면 엉뚱한 실패가 된다.

    성공 시 Gemini 응답 바디(dict)를 반환한다."""

    def _post(use_model):
        req = urllib.request.Request(
            url or GEMINI_URL.format(model=use_model),
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
        if model_gone and allow_fallback:
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


def _repair_truncated_json(text):
    """출력이 잘려 끊긴 JSON에서 '온전히 끝난 데까지'만 살려 낸다.

    쓰는 곳은 기출 시험지 유형 분석 하나뿐이다(salvage=True). 거기서는 30문항 중
    25문항이라도 표가 나오는 편이, 아무것도 못 보고 다시 올리는 것보다 낫기 때문이다.
    분석본·문제 제작에는 쓰지 않는다 — 반쪽짜리 결과물이 성공한 척 나가면 안 된다.

    되살릴 수 있는 지점은 '배열 안의 객체 하나가 막 닫힌 자리'다. 거기서 자르고 열려
    있는 괄호를 닫으면 그때까지 읽은 항목이 그대로 남는다. 못 살리면 None."""
    s = (text or "").strip()
    stack = []          # 지금 열려 있는 괄호들
    in_str = esc = False
    cut = None          # 자를 위치
    cut_stack = None    # 그 위치에서 닫아야 할 괄호들
    for i, ch in enumerate(s):
        if in_str:
            if esc:
                esc = False
            elif ch == "\\":
                esc = True
            elif ch == '"':
                in_str = False
            continue
        if ch == '"':
            in_str = True
        elif ch in "{[":
            stack.append(ch)
        elif ch in "}]":
            if stack:
                stack.pop()
            # 배열 안의 객체가 닫힌 자리만 후보로 삼는다(맨 바깥 객체는 제외)
            if ch == "}" and len(stack) >= 2 and stack[-1] == "[":
                cut, cut_stack = i + 1, list(stack)
    if cut is None:
        return None
    tail = "".join("]" if b == "[" else "}" for b in reversed(cut_stack))
    try:
        return json.loads(s[:cut] + tail)
    except json.JSONDecodeError:
        return None


def _extract_gemini_json(body, trunc_msg, salvage=False):
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
        if salvage:
            saved = _repair_truncated_json(text)
            if isinstance(saved, dict):
                saved["_truncated"] = True   # 호출부가 '어디까지 읽었는지' 알릴 수 있게
                return saved
        if finish == "MAX_TOKENS":
            raise RuntimeError(trunc_msg)
        raise RuntimeError("모델 응답을 JSON으로 해석하지 못했습니다.")
    if finish == "MAX_TOKENS":
        raise RuntimeError(trunc_msg)
    return result


def _gemini_json(payload, api_key, model, trunc_msg, salvage=False):
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
            return _extract_gemini_json(body, trunc_msg, salvage)
        except Recitation as e:
            last = e
            continue
    raise last


_ANALYZE_TRUNC_MSG = (
    "출력이 최대 길이에 도달해 분석이 잘렸습니다. 이 지문이 너무 길어서 그렇습니다. "
    "지문을 두세 문단으로 나눠 각각 따로 분석하세요."
)

# ── 부분 수정 ────────────────────────────────────────────────────────────────
# 검사가 문제를 찾으면 원래는 분석본 '전체'를 다시 만들게 했다. 접속사 하나 빠진
# 것을 고치자고 8,000토큰을 다시 생성하느라 한 번에 30초씩 걸렸고, 그 사이 멀쩡하던
# 다른 자리가 망가져 재요청 결과를 통째로 버리는 일도 잦았다.
#
# 문제가 지목된 문장만 고쳐 받아 원본에 끼워 넣으면 셋이 한꺼번에 해결된다.
# 출력이 줄어 빨라지고, 값이 싸지고, 손대지 않은 문장은 애초에 바뀔 수가 없다.

# 고쳐 받을 때는 sentences만 돌려받는다. 문장 하나의 모양은 전체 스키마와 같아야
# 하므로 거기서 그대로 빌려 쓴다(따로 적어 두면 한쪽만 고쳐져 어긋난다).
SENTENCE_FIX_SCHEMA = {
    "type": "OBJECT",
    "properties": {"sentences": GEMINI_SCHEMA["properties"]["sentences"]},
    "required": ["sentences"],
    "propertyOrdering": ["sentences"],
}

_HINT_NO_RE = re.compile(r"^\s*(\d+)\s*번\s*문장")


def hint_sentence_nos(*hint_lists):
    """검사 메시지에서 '몇 번 문장'인지 뽑는다.

    검사 함수들이 만드는 문구가 모두 "N번 문장…"으로 시작하므로 그 앞머리를 읽는다.
    번호를 못 읽은 항목이 하나라도 있으면 빈 집합을 돌려준다 — 그 경우 어느 문장을
    고쳐야 할지 확신할 수 없으니, 부분 수정 대신 예전처럼 전체를 다시 만들게 한다."""
    nos = set()
    for hints in hint_lists:
        for h in hints or ():
            m = _HINT_NO_RE.match(str(h))
            if not m:
                return set()
            nos.add(int(m.group(1)))
    return nos


def splice_sentences(result, fixed, targets):
    """고쳐 받은 문장을 원본에 끼워 넣은 새 분석본을 만든다.

    targets에 든 번호만 갈아 끼우고 나머지는 원본 그대로 둔다. 모델이 엉뚱한 문장을
    함께 돌려보내도 무시하고, 부탁한 문장을 안 돌려보냈으면 원본을 남긴다.
    원본은 건드리지 않는다 — 호출한 쪽이 '고친 게 더 나은지' 비교해야 하기 때문."""
    by_no = {}
    for s in (fixed or {}).get("sentences", []) or []:
        if not isinstance(s, dict):
            continue
        try:
            no = int(s.get("no"))
        except (TypeError, ValueError):
            continue
        if no in targets and s.get("chunks"):
            by_no[no] = s
    if not by_no:
        return None                      # 쓸 만한 게 없으면 실패로 본다
    out = dict(result)
    merged = []
    for s in result.get("sentences", []) or []:
        no = s.get("no") if isinstance(s, dict) else None
        merged.append(by_no.get(no, s))
    out["sentences"] = merged
    return out


def call_gemini(passage, target_grammar, mode, api_key, model, complete_hint=None,
                english_fix=False, conj_hint=None, num_hint=None,
                ruby_hint=None, conflict_hint=None, note_hint=None):
    api_key = (api_key or "").strip() or os.environ.get("GEMINI_API_KEY", "").strip()
    if not api_key:
        raise RuntimeError(
            "관리자가 아직 서버에 Gemini API 키(GEMINI_API_KEY)를 설정하지 않았습니다. "
            "관리자에게 문의하세요."
        )
    model = model if (model and _MODEL_RE.match(model)) else MODEL

    payload = {
        "systemInstruction": {"parts": [{"text": SYSTEM_PROMPT}]},
        "contents": [
            {
                "role": "user",
                "parts": [{"text": build_user_prompt(passage, target_grammar, mode,
                                                     complete_hint, english_fix, conj_hint,
                                                     num_hint, ruby_hint, conflict_hint,
                                                     note_hint)}],
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
    return finalize_analysis(result)


def finalize_analysis(result):
    """모델이 준 날것의 분석본을 화면에 낼 수 있는 형태로 마무리한다.

    검사 → 조립 → 정화 순서가 중요하다. 조립이 anns를 버리므로 검사는 그 전에 끝내야
    한다. 부분 수정도 고쳐 받은 문장을 날것 상태에서 끼워 넣은 뒤 이 함수를 다시 태워,
    처음부터 전체를 만든 것과 똑같은 과정을 거치게 한다."""
    # 고쳐 받을 때 '지금 이 문장이 어떤 상태인지' 보여 주려면 anns가 필요한데 아래
    # 조립 루프가 그것을 지운다. 그래서 지우기 전에 따로 떠 둔다(핸들러가 응답 전에
    # 지우는 다른 비공개 키들과 같은 취급이다).
    # 병렬 번호는 읽는 순서가 곧 정답이라 서버가 먼저 바로잡는다. 검사·백업보다
    # 앞에 두어야 고쳐 받을 때도, 화면에 나갈 때도 같은(바로잡힌) 번호를 본다.
    _renumber_parallel(result)
    result["_rawSents"] = copy.deepcopy(result.get("sentences") or [])
    # 등위접속사 누락 검사는 조립 '전'에 해야 한다 — 아래 루프가 anns를 버리기 때문.
    # 결과는 비공개 키로 얹어 두고, 핸들러가 재요청 판단에 쓴 뒤 응답 전에 지운다.
    missed = unmarked_conjunctions(result)
    # 번호가 빠진 것과 묶음을 잘못 합친 것은 화면에서 같은 증상(짝 없는 위첨자)으로
    # 나타나고 고치는 방법도 같아, 한 목록으로 모아 같은 재요청에 실어 보낸다.
    broken_nums = (broken_parallel_numbers(result) + conj_group_mixups(result)
                   + clause_parallel_problems(result))
    # 루비 규칙 위반·좌우 용어 모순도 조립 '전'에 검사한다(아래 루프가 anns를 버린다)
    ruby_bad = ruby_term_problems(result)
    conflicts = term_conflicts(result)
    note_miss = unexplained_marks(result)
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
                c["kor"] = _fix_known_typos(sanitize_inline(clean_korean(c["kor"])))
        if s.get("note"):
            s["note"] = _fix_known_typos(sanitize_inline(clean_note(s["note"])))
        if s.get("examNote"):
            # examNote는 원래 태그 없는 한국어라 sanitize까지 걸지 않지만,
            # 태그 도중에 끝난 조각만은 잘라 낸다(note와 같은 이유).
            s["examNote"] = _drop_dangling_tag(_fix_known_typos(s["examNote"]))
    # 요약 content 도 정화 (표/구조 태그가 레이아웃을 깨는 것을 서버에서도 차단)
    for item in result.get("summary", []):
        if isinstance(item, dict) and item.get("content"):
            item["content"] = _fix_known_typos(sanitize_inline(item["content"]))
    result["_conjMiss"] = missed
    result["_numBroken"] = broken_nums
    result["_rubyBad"] = ruby_bad
    result["_conflicts"] = conflicts
    result["_noteMiss"] = note_miss
    return result


FIX_TRUNC_MSG = (
    "문장 수정본이 잘렸습니다. 잠시 뒤 다시 시도하세요."
)

# 지목된 문장이 전체의 이 비율을 넘으면 부분 수정의 이점이 없다 — 그냥 전체를 다시
# 만든다(부분 수정은 '조금만 고쳐 받아 빨리 끝낸다'가 목적이다).
_FIX_MAX_SHARE = 0.5


def call_gemini_fix(passage, result, targets, api_key, model,
                    conj_hint=None, num_hint=None, ruby_hint=None, conflict_hint=None,
                    note_hint=None):
    """지목된 문장만 고쳐 받아 원본에 끼워 넣은 분석본을 돌려준다.

    전체를 다시 만들지 않으므로 빠르고 싸며, 손대지 않은 문장은 바뀔 수가 없다.
    고칠 수 없는 상황(원본 주석이 없다, 지목된 문장이 너무 많다, 모델이 쓸 만한 것을
    안 줬다)이면 None을 돌려준다 — 호출한 쪽이 예전처럼 전체 재요청으로 넘어간다."""
    raw = result.get("_rawSents") or []
    if not raw or not targets:
        return None
    if len(targets) > max(1, int(len(raw) * _FIX_MAX_SHARE)):
        return None
    subset = [s for s in raw if isinstance(s, dict) and s.get("no") in targets]
    if not subset:
        return None

    api_key = (api_key or "").strip() or os.environ.get("GEMINI_API_KEY", "").strip()
    if not api_key:
        raise RuntimeError(
            "관리자가 아직 서버에 Gemini API 키(GEMINI_API_KEY)를 설정하지 않았습니다. "
            "관리자에게 문의하세요."
        )
    model = model if (model and _MODEL_RE.match(model)) else MODEL

    lines = [
        "아래는 이미 만들어 둔 분석본 중 **문제가 지적된 문장들**입니다.",
        "지적된 부분만 고쳐서, **그 문장들만** 같은 형식으로 돌려주세요.",
        "",
        "지켜야 할 것:",
        "· 지적되지 않은 것은 무엇도 바꾸지 마세요 — 청크를 나눈 자리, 한국어 해석,",
        "  이미 올바른 주석, note, examTags, tag, isTopic 모두 그대로 두세요.",
        "· 문장 번호(no)는 그대로 두세요. 번호가 바뀌면 끼워 넣을 자리를 잃습니다.",
        "· 요청받은 문장만 돌려주세요. 다른 문장은 넣지 마세요.",
        "",
        "원문 지문(맥락 참고용):",
        passage.strip(),
        "",
        "고쳐야 할 문장들의 현재 상태(JSON):",
        json.dumps({"sentences": subset}, ensure_ascii=False),
        "",
        "지적된 문제:",
    ]
    for label, hints in (("등위접속사 누락", conj_hint), ("병렬 번호", num_hint),
                         ("루비 규칙 위반", ruby_hint), ("좌우 용어 모순", conflict_hint),
                         ("해설 누락", note_hint)):
        for h in hints or ():
            lines.append(f"  · [{label}] {h}")

    payload = {
        "systemInstruction": {"parts": [{"text": SYSTEM_PROMPT}]},
        "contents": [{"role": "user", "parts": [{"text": "\n".join(lines)}]}],
        "generationConfig": {
            "temperature": 0.2,
            "maxOutputTokens": 65536,
            "responseMimeType": "application/json",
            "responseSchema": SENTENCE_FIX_SCHEMA,
        },
    }
    fixed = _gemini_json(payload, api_key, model, FIX_TRUNC_MSG)

    merged = splice_sentences({"sentences": raw}, fixed, targets)
    if merged is None:
        return None
    # 끼워 넣은 문장은 원본 백업본(_rawSents)과 같은 객체를 가리킨다. 그대로 마무리
    # 처리에 넘기면 조립 루프가 원본의 anns까지 지워, 이 수정이 거부됐을 때 다음
    # 부분 수정이 갈 곳을 잃는다. 그래서 통째로 복사한 뒤 손댄다.
    out = copy.deepcopy({k: v for k, v in result.items() if k != "_rawSents"})
    out["sentences"] = copy.deepcopy(merged["sentences"])
    return finalize_analysis(out)


def refine_analysis(passage, target_grammar, mode, api_key, model, result, **hints):
    """검사가 짚은 문제를 고친 분석본을 돌려준다. (새 분석본, 부분수정이었는지) 쌍.

    먼저 지목된 문장만 고쳐 받아 본다. 그게 안 되는 상황이면 예전처럼 전체를 다시
    만든다 — 부분 수정은 빠르고 안전한 지름길일 뿐, 못 가면 원래 길로 가면 된다."""
    targets = hint_sentence_nos(*hints.values())
    if targets:
        try:
            fixed = call_gemini_fix(passage, result, targets, api_key, model, **hints)
        except (ProUnavailable, QuotaExceeded, NeedsPro):
            raise            # 모델·할당량 문제는 전체 재요청으로도 풀리지 않는다
        except Exception:
            fixed = None     # 그 밖의 실패는 전체 재요청에 맡긴다
        if fixed is not None:
            return fixed, True
    return call_gemini(passage, target_grammar, mode, api_key, model, **hints), False


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


# ══════════════ 워드(.docx)로 내보내기 ══════════════
# 만든 문제지를 선생님이 워드에서 직접 고칠 수 있게 내려준다. 인쇄는 이미 PDF로 되므로
# 이쪽의 목적은 오직 '편집'이다.
#
# .docx는 사실 XML 몇 개를 담은 ZIP이라 표준 zipfile만으로 만든다 — 새 pip 의존성이 없다.
# python-docx를 쓰지 않는 이유는 의존성도 있지만, 2단 조판(w:cols)처럼 정작 필요한 것을
# 결국 raw XML로 넣어야 해서 얻는 게 크지 않기 때문이다.
#
# ── 왜 데이터가 아니라 '화면이 그린 HTML'을 받는가 ──
# 문항 모양을 만드는 로직(보기 섞기·답란 그리기·빈칸 번호 매기기 등 8가지 format 분기)은
# app.js의 quizBodyHtml에 있다. 서버가 데이터에서 다시 그리려면 그 로직을 파이썬으로 한 벌
# 더 옮겨야 하는데, 문제 유형은 계속 늘어나므로(최근에도 영영풀이가 추가됐다) 두 벌이
# 조용히 어긋나게 된다. 그래서 그리는 곳은 app.js 하나로 두고, 여기서는 이미 그려진
# 결과를 Word 문단으로 옮기기만 한다.
#
# 표(정답 및 해설)는 여기서 다루지 않고 문단으로 편다 — 워드 표는 편집할 때 오히려
# 성가시고, 답지는 어차피 맨 뒤 별지라 표가 아니어도 읽힌다.

DOCX_NS = "http://schemas.openxmlformats.org/wordprocessingml/2006/main"

# A4 세로. 단위는 twip(1/1440인치)다. 여백 2cm = 1134.
_DOCX_PAGE = (
    '<w:pgSz w:w="11906" w:h="16838"/>'
    '<w:pgMar w:top="1134" w:right="1134" w:bottom="1134" w:left="1134"'
    ' w:header="708" w:footer="708" w:gutter="0"/>'
)


def _docx_esc(text):
    """XML 텍스트 이스케이프. 워드가 못 읽는 제어문자도 함께 턴다."""
    s = str(text if text is not None else "")
    s = s.replace("&", "&amp;").replace("<", "&lt;").replace(">", "&gt;")
    return "".join(ch for ch in s if ch >= " " or ch in "\t\n")


def _docx_run(text, bold=False, under=False, size=None, color=None):
    """글자 한 덩어리(run). size는 half-point라 10pt면 20이다."""
    if not text:
        return ""
    props = []
    if bold:
        props.append("<w:b/>")
    if under:
        props.append('<w:u w:val="single"/>')
    if color:
        props.append(f'<w:color w:val="{color}"/>')
    if size:
        props.append(f'<w:sz w:val="{size}"/><w:szCs w:val="{size}"/>')
    rpr = f"<w:rPr>{''.join(props)}</w:rPr>" if props else ""
    # xml:space="preserve" — 앞뒤 공백이 살아야 낱말이 붙지 않는다
    return f'<w:r>{rpr}<w:t xml:space="preserve">{_docx_esc(text)}</w:t></w:r>'


def _docx_para(runs_xml, style=None, align=None, space_after=120,
               keep_next=False, page_break=False, border_bottom=False):
    """문단 하나. runs_xml은 _docx_run들을 이어 붙인 문자열."""
    props = []
    if style:
        props.append(f'<w:pStyle w:val="{style}"/>')
    if keep_next:
        props.append("<w:keepNext/>")
    if border_bottom:
        props.append(
            '<w:pBdr><w:bottom w:val="single" w:sz="6" w:space="2" w:color="BFBFBF"/></w:pBdr>'
        )
    props.append(f'<w:spacing w:after="{space_after}" w:line="264" w:lineRule="auto"/>')
    if align:
        props.append(f'<w:jc w:val="{align}"/>')
    ppr = f"<w:pPr>{''.join(props)}</w:pPr>"
    brk = '<w:r><w:br w:type="page"/></w:r>' if page_break else ""
    return f"<w:p>{ppr}{brk}{runs_xml}</w:p>"


def _docx_sect(cols=1, next_page=False):
    """섹션 속성. 문단의 <w:pPr> 안에 넣으면 '그 문단까지'가 한 섹션이 되고,
    <w:body> 직속으로 두면 마지막 섹션에 적용된다.

    2단은 여기 w:cols로 낸다. 표로 2칸을 흉내 내면 칸 사이로 글이 흐르지 않아
    문항 하나를 지웠을 때 뒤가 따라 올라오지 않는다 — 편집이 목적이라 그건 못 쓴다."""
    kind = "nextPage" if next_page else "continuous"
    col = ('<w:cols w:num="2" w:space="425" w:equalWidth="1"/>' if cols == 2
           else '<w:cols w:space="425"/>')
    return f'<w:sectPr><w:type w:val="{kind}"/>{_DOCX_PAGE}{col}</w:sectPr>'


def _docx_blank_line():
    """답을 적는 빈 줄.

    글자(밑줄 친 공백)로 그리면 안 된다. 전각 공백은 폭이 두 배인 데다 줄바꿈이 걸리지
    않는 문자라, 한 줄에 빈칸이 두어 개만 들어가도 오른쪽 여백을 넘어가 줄이 무너진다.
    화면 CSS(.wb-writeline)가 하는 것과 같이 문단 아래 테두리로 그리면 폭이 늘 지면에
    맞고, 단이 1단이든 2단이든 알아서 그 폭을 따른다."""
    return (
        "<w:p><w:pPr>"
        '<w:pBdr><w:bottom w:val="single" w:sz="6" w:space="1" w:color="808080"/></w:pBdr>'
        '<w:spacing w:before="140" w:after="220" w:line="360" w:lineRule="auto"/>'
        "</w:pPr></w:p>"
    )


def _docx_sect_break(cols=1, next_page=False):
    """앞 섹션을 여기서 끊는 빈 문단. sectPr은 반드시 <w:pPr> 안에 들어가야 한다."""
    return f"<w:p><w:pPr>{_docx_sect(cols, next_page)}</w:pPr></w:p>"


_DOCX_STYLES = f"""<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<w:styles xmlns:w="{DOCX_NS}">
  <w:docDefaults><w:rPrDefault><w:rPr>
    <w:rFonts w:ascii="Malgun Gothic" w:hAnsi="Malgun Gothic"
              w:eastAsia="맑은 고딕" w:cs="Malgun Gothic"/>
    <w:sz w:val="20"/><w:szCs w:val="20"/>
  </w:rPr></w:rPrDefault></w:docDefaults>
  <w:style w:type="paragraph" w:styleId="Title1">
    <w:name w:val="DocTitle"/>
    <w:pPr><w:spacing w:after="240"/></w:pPr>
    <w:rPr><w:b/><w:sz w:val="32"/><w:szCs w:val="32"/></w:rPr>
  </w:style>
  <w:style w:type="paragraph" w:styleId="QNo">
    <w:name w:val="QuestionNo"/>
    <w:pPr><w:keepNext/><w:spacing w:before="180" w:after="60"/></w:pPr>
    <w:rPr><w:b/><w:sz w:val="22"/><w:szCs w:val="22"/></w:rPr>
  </w:style>
</w:styles>"""

_DOCX_CONTENT_TYPES = """<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">
  <Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>
  <Default Extension="xml" ContentType="application/xml"/>
  <Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/>
  <Override PartName="/word/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.styles+xml"/>
</Types>"""

_DOCX_RELS = """<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
  <Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/>
</Relationships>"""

_DOCX_DOC_RELS = """<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
  <Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/>
</Relationships>"""


class _QuizDocxParser(HTMLParser):
    """화면이 그린 문제지 HTML을 훑어 Word 문단 목록으로 옮긴다.

    구조를 클래스 이름으로 알아본다(app.js의 buildQuizHtml이 붙이는 것들):
        .qz-card       문항 한 개          .qz-no/.qz-type  번호·유형
        .qz-instruction 발문              .qz-passage      지문
        .qz-choices li  보기 ①~⑤          .qz-writeline    답 쓰는 줄
        .qz-answer-box  정답·해설         table.answerkey  뒤쪽 답지표

    굵게·밑줄은 <b>/<u>를 세어 겹침을 처리한다(문제 HTML에 허용된 태그는
    _QUIZ_ALLOWED_TAGS = br·u·b 뿐이라 이 셋만 보면 된다).

    답지(.qz-answer-box, table.answerkey)는 여기서 따로 모아 두었다가 맨 뒤에 붙인다 —
    문항 사이에 끼우지 않는 것은 학생용으로 뒷장만 떼어 낼 수 있게 하기 위해서다."""

    # 화면에만 필요한 것들 — 워드에는 옮기지 않는다.
    #   section     '정답 및 해설' 제목줄. 답지 제목은 이쪽에서 따로 붙이므로 두면 두 번 찍힌다
    #   exam-plan   배분표. '어느 문항을 어느 지문으로 만들었나'를 적은 제작 기록이라
    #               인쇄에서도 빠진다(examPlanTableHtml 주석 참고) — 워드도 같이 뺀다
    #   wb-answerbook-head  워크북 정답 별지의 '정답' 제목. 위 section과 같은 이유로 뺀다
    SKIP_CLASSES = ("qz-reveal-btn", "print-foot", "legend", "qz-scramble-tag",
                    "section", "exam-plan", "wb-answerbook-head")

    # 뒤에 구분 문자를 붙여야 하는 조각들 — 화면에서는 CSS 여백으로 떨어져 있지만
    # 글자만 뽑으면 "1주제", "①the value of travel"처럼 달라붙는다.
    SEP_AFTER = {"qz-no": ". ", "qz-num": " ", "qz-type": "  ", "qz-findko": " ",
                 "wb-no": ". ", "wb-ab-label": "  ", "wb-ab-stage": "  ",
                 # 단계 머리말의 좌·우 조각 (화면에서는 양끝으로 갈라져 있다)
                 "wb-run-l": "   ┃   "}

    # CSS로 선을 그려 두던 '답 쓰는 칸'. 워드에는 선이 안 넘어가므로 밑줄 친 공백으로 만든다.
    BLANK_CLASSES = ("qz-writeline", "qz-fixline", "qz-findline",
                     "wb-writeline", "wb-orderline", "wb-fixline")

    # 맨 뒤 별지로 모을 것들. 문항 사이에 끼우지 않는 이유는 학생용으로 뒷장만
    # 떼어 낼 수 있게 하기 위해서다.
    ANSWER_CLASSES = ("qz-answer-box", "answerkey", "wb-answerbook")

    # 새 쪽에서 시작할 것들. 워크북은 지문 하나가 section.wb-passage 한 벌이고
    # 그 안이 '제목(wb-titlebar) → 단계들(table.wb-page)'로 되어 있다.
    #
    #   PAGE_START  지문이 바뀌면 새 쪽. 제목이 그 쪽 맨 위에 온다.
    #   PAGE_ITEM   단계가 바뀌면 새 쪽. 단, 지문의 '첫' 단계는 제목과 같은 쪽에 붙인다 —
    #               떼어 놓으면 제목만 있는 쪽이 생기고 본문은 다음 쪽으로 넘어간다.
    #
    # 맨 처음 덩어리 앞에는 넣지 않는다(빈 쪽이 생긴다).
    PAGE_START_CLASSES = ("wb-passage",)
    PAGE_ITEM_CLASSES = ("wb-page",)

    # 문장 '안'에 들어가는 빈칸. 위의 BLANK_CLASSES와 달리 문단을 끊지 않는다.
    # qz-ox(진위형 괄호)는 여기 넣지 않는다 — HTML에 이미 '(　　)' 글자가 들어 있어
    # 따로 그려 주면 두 벌이 된다.
    INLINE_BLANK_CLASSES = ("wb-blank", "qz-fillrule")

    def __init__(self):
        super().__init__(convert_charrefs=True)
        self.body = []        # 문항 쪽 문단
        self.answers = []     # 답지 쪽 문단
        self._runs = []       # 지금 쌓는 중인 문단의 run들
        self._bold = 0
        self._under = 0
        self._skip = 0        # 0보다 크면 이 안의 글자는 버린다
        self._in_answer = 0   # 0보다 크면 답지 쪽으로 담는다
        self._pending = None  # 다음 문단에 줄 스타일
        self._depth_stack = []
        self._pages = 0       # 새 쪽에서 시작한 덩어리 수 (첫 덩어리 판별용)
        self._fresh_page = False  # 방금 지문 제목으로 쪽을 열었는가 (첫 단계 판별용)

    def _new_page(self):
        """여기서부터 새 쪽. 맨 처음에는 넣지 않는다 — 빈 쪽이 생긴다."""
        if self._pages:
            (self.answers if self._in_answer else self.body).append(
                _docx_para("", page_break=True, space_after=0)
            )
        self._pages += 1

    # ── 문단 경계 ────────────────────────────────────────────────
    def _flush(self, style=None, space_after=120):
        if not self._runs:
            return
        xml = _docx_para("".join(self._runs), style=style or self._pending,
                         space_after=space_after)
        (self.answers if self._in_answer else self.body).append(xml)
        self._runs = []
        self._pending = None

    def _add(self, text):
        if self._skip or not text:
            return
        self._runs.append(_docx_run(text, bold=self._bold > 0, under=self._under > 0))

    def _classes(self, attrs):
        d = dict(attrs)
        return (d.get("class") or "").split()

    # style="min-width:150px" 에서 숫자만 꺼낸다
    _WIDTH_RE = re.compile(r"(?:min-)?width\s*:\s*(\d+)\s*px")

    def _blank_text(self, attrs):
        """문장 한가운데 빈칸을 그릴 글자.

        밑줄 친 '공백'으로 그리면 안 된다. 줄 끝에 걸린 공백은 조판 규칙상 오른쪽 여백
        바깥에 매달리므로, 빈칸이 줄 끝에 오면 밑줄이 지면 밖으로 삐져나가 잘린다.
        밑줄 문자(_)는 공백이 아니라 내용이라 여백을 넘지 않고, 남은 자리에 못 들어가면
        통째로 다음 줄로 내려간다.

        길이는 화면과 맞춘다 — 화면은 정답 길이에 비례해 폭을 잡으므로
        (blankWidth = 답 글자수 × 9px, 70~230px) 그 값을 읽어 옮긴다. 전부 같은 길이면
        긴 답은 쓸 자리가 모자라고 짧은 답은 자리가 남는다."""
        m = self._WIDTH_RE.search(dict(attrs).get("style") or "")
        px = int(m.group(1)) if m else 90
        # 밑줄 문자는 폭이 평균 글자와 비슷하다 — 9px(답 한 글자)당 1.2자로 잡아
        # 쓸 자리를 조금 넉넉히 준다.
        return "_" * max(6, min(28, round(px / 9 * 1.2)))

    # ── 태그 ─────────────────────────────────────────────────────
    def handle_starttag(self, tag, attrs):
        cls = self._classes(attrs)
        if self._skip or any(c in self.SKIP_CLASSES for c in cls):
            self._skip += 1
            return
        if tag == "b" or tag == "strong":
            self._bold += 1
        elif tag == "u":
            self._under += 1
        elif tag == "span":
            if any(c in self.INLINE_BLANK_CLASSES for c in cls):
                # 문장 한가운데라 문단 테두리를 쓸 수 없다 — 밑줄 문자로 그린다
                # (_blank_text에 왜 공백이 아닌지 적어 두었다).
                # 밑줄 문자 자체가 선이므로 under는 걸지 않는다(걸면 선이 두 겹이 된다).
                self._runs.append(_docx_run(self._blank_text(attrs)))
            sep = next((self.SEP_AFTER[c] for c in cls if c in self.SEP_AFTER), None)
            self._depth_stack.append((("sep", sep) if sep else None, tag))
            return
        elif tag in ("td", "th"):
            # 답지표의 칸. 표를 만들지 않고 한 줄로 펴므로 칸 사이를 띄워 준다
            # (표는 워드에서 고치기 성가시고, 답지는 읽기만 하면 된다).
            self._depth_stack.append((("sep", "   "), tag))
            return
        elif tag == "br":
            # 문단 안 줄바꿈
            self._runs.append('<w:r><w:br/></w:r>')
        elif tag in ("div", "p", "li", "tr", "h1", "h2", "h3", "section", "ul", "table"):
            self._flush()
            if any(c in self.PAGE_START_CLASSES for c in cls):
                self._new_page()
                self._fresh_page = True   # 이 쪽의 첫 단계는 제목 아래에 이어 붙인다
            elif any(c in self.PAGE_ITEM_CLASSES for c in cls):
                if self._fresh_page:
                    self._fresh_page = False
                else:
                    self._new_page()
            if any(c in self.ANSWER_CLASSES for c in cls):
                self._in_answer += 1
                self._depth_stack.append(("answer", tag))
                return
            if any(c in self.BLANK_CLASSES for c in cls):
                # 글자가 아니라 테두리로 그린다 (_docx_blank_line 참고)
                (self.answers if self._in_answer else self.body).append(_docx_blank_line())
                return
            if "qz-no" in cls or "wb-no" in cls:
                self._pending = "QNo"
            if any(c in ("wb-heading", "wb-titlebar") for c in cls):
                self._pending = "QNo"
            if "qz-card" in cls or "wb-q" in cls:
                self._pending = None
        self._depth_stack.append((None, tag))

    def handle_endtag(self, tag):
        if self._skip:
            self._skip -= 1
            return
        if tag in ("b", "strong"):
            self._bold = max(0, self._bold - 1)
            return
        if tag == "u":
            self._under = max(0, self._under - 1)
            return
        if tag in ("span", "td", "th"):
            while self._depth_stack:
                kind, name = self._depth_stack.pop()
                if name == tag:
                    if isinstance(kind, tuple) and kind[0] == "sep":
                        self._add(kind[1])
                    break
            return
        if tag in ("div", "p", "li", "tr", "h1", "h2", "h3", "section", "ul", "table"):
            self._flush()
            while self._depth_stack:
                kind, name = self._depth_stack.pop()
                if name == tag:
                    if kind == "answer":
                        self._in_answer = max(0, self._in_answer - 1)
                    break

    def handle_data(self, data):
        text = re.sub(r"\s+", " ", data)
        if text.strip() or (self._runs and text == " "):
            self._add(text)

    def result(self):
        self._flush()
        return self.body, self.answers


def quiz_html_to_docx(result_html, title, answer_heading="정답 및 해설", columns=2):
    """결과 HTML → .docx bytes.

    쪽 구성: 제목(1단) → 본문(columns단) → 쪽 넘김 → 답지(1단).
    답지를 맨 뒤 별지로 빼는 것은 학생용으로 뒷장만 떼어 쓰기 위해서다.

    columns는 탭마다 다르다. 문제지·시험지는 2단이 기출 시험지 모양에 가깝지만,
    워크북은 한 단으로 낸다 — 단계마다 답을 적는 칸이 있어서 2단으로 좁히면 쓸 자리가
    모자라고, 단계가 여럿이라 칸을 넘나들며 읽는 것도 번거롭다."""
    # 1을 콕 집어 준 경우만 1단이다. 기본값이 2이므로 엉뚱한 값도 2로 떨어져야 앞뒤가 맞다.
    columns = 1 if columns == 1 else 2
    parser = _QuizDocxParser()
    parser.feed(result_html or "")
    body, answers = parser.result()

    out = []
    # 1) 제목 — 한 단으로 전체 폭을 쓴다
    out.append(_docx_para(_docx_run(title, bold=True, size=32),
                          style="Title1", border_bottom=True))
    out.append(_docx_sect_break(cols=1))
    # 2) 본문. 이 섹션은 nextPage로 끊어 답지가 새 쪽에서 시작하게 한다
    out.extend(body or [_docx_para(_docx_run("(내용이 없습니다)"))])
    out.append(_docx_sect_break(cols=columns, next_page=True))
    # 3) 답지 — 새 쪽, 한 단
    if answers:
        out.append(_docx_para(_docx_run(answer_heading, bold=True, size=28),
                              border_bottom=True))
        out.extend(answers)
    # 마지막 섹션 속성은 body 직속으로 둔다
    out.append(_docx_sect(cols=1))
    return build_docx("".join(out))


def build_docx(body_xml):
    """문단 XML을 받아 .docx 한 벌(bytes)로 묶는다."""
    document = (
        '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>'
        f'<w:document xmlns:w="{DOCX_NS}"><w:body>{body_xml}</w:body></w:document>'
    )
    buf = io.BytesIO()
    with zipfile.ZipFile(buf, "w", zipfile.ZIP_DEFLATED) as z:
        z.writestr("[Content_Types].xml", _DOCX_CONTENT_TYPES)
        z.writestr("_rels/.rels", _DOCX_RELS)
        z.writestr("word/_rels/document.xml.rels", _DOCX_DOC_RELS)
        z.writestr("word/styles.xml", _DOCX_STYLES)
        z.writestr("word/document.xml", document)
    return buf.getvalue()


CONTENT_TYPES = {
    ".html": "text/html; charset=utf-8",
    ".css": "text/css; charset=utf-8",
    ".js": "application/javascript; charset=utf-8",
    ".json": "application/json; charset=utf-8",
    ".svg": "image/svg+xml",
    ".ico": "image/x-icon",
    # png이 빠져 있어 logo.png·mark.png가 application/octet-stream으로 나가고 있었다.
    # 브라우저는 <img>라면 알아서 알아보지만, 카톡·페이스북이 미리보기 그림을 가져갈
    # 때는 형식을 보고 판단하므로 octet-stream이면 썸네일이 뜨지 않는다.
    ".png": "image/png",
    ".jpg": "image/jpeg",
    ".jpeg": "image/jpeg",
    ".webp": "image/webp",
    # 검색 로봇용 두 파일
    ".txt": "text/plain; charset=utf-8",
    ".xml": "application/xml; charset=utf-8",
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


def _was_previously_deleted(email):
    """이 이메일로 탈퇴한 적이 있는지 확인한다 — 탈퇴 후 재가입으로
    시작 잔액을 반복해서 받는 것(어뷰징)을 막는 데 쓴다."""
    _require_db()
    return DB.collection("deleted_accounts").document(email.strip().lower()).get().exists


def upsert_user(sub, email, name):
    _require_db()
    ref = DB.collection("users").document(sub)
    if not ref.get().exists:
        starting_krw = 0 if _was_previously_deleted(email) else DEFAULT_USER_KRW
        ref.set({
            "email": email, "name": name, "created_at": _now_iso(),
            "krw_remaining": starting_krw,
            # 가입 축하금은 돈을 받은 적이 없으므로 전액 무상이다(환불 대상이 아니다)
            "krw_free": starting_krw, "krw_paid": 0,
            # 방금 가입했으니 지금까지의 업데이트 소식은 이미 다 겪은 셈이다 —
            # 첫 로그인부터 지난 소식이 쏟아지지 않게 최신 번호로 맞춰 둔다.
            "last_seen_changelog": CHANGELOG[0]["version"] if CHANGELOG else 0,
        })
        _log_signup_grant(sub, starting_krw)
    else:
        ref.set({"email": email, "name": name}, merge=True)


def delete_user_account(user_id, by_admin=False):
    """계정 탈퇴 — 계정 문서와 그 계정이 저장해 둔 자료를 전부 지운다.
    되돌릴 수 없다(잔액도 함께 사라진다). 같은 이메일로 재가입해도 시작 잔액을
    다시 받지 못하도록 deleted_accounts에 이메일을 남겨 둔다(어뷰징 방지).

    by_admin: 관리자가 강제로 내보낸 경우. deleted_accounts에 남겨 두는 기록에만
    쓴다 — 나중에 '왜 이 이메일이 막혀 있나'를 가릴 근거가 된다.

    지운 계정의 세션도 여기서 함께 지운다. 본인 탈퇴는 호출부가 자기 토큰 하나를
    지우지만 그것만으로는 다른 기기에 남아 있는 세션이 살아 있고, 관리자 강제 탈퇴는
    애초에 지울 토큰을 손에 쥐고 있지도 않다. 남겨 두면 계정이 없는 채로 로그인
    상태만 유지되는 이상한 상태가 된다."""
    _require_db()
    snap = DB.collection("users").document(user_id).get()
    email = (snap.to_dict() or {}).get("email") if snap.exists else None
    for item in DB.collection("saved_items").where("user_id", "==", user_id).stream():
        item.reference.delete()
    # 이용 내역도 함께 지운다 — 탈퇴하면 다 사라진다고 안내하고 있고,
    # 계정이 없어진 뒤에도 남아 있을 이유가 없다.
    for row in DB.collection(POINT_LEDGER).where("user_id", "==", user_id).stream():
        row.reference.delete()
    for sess in DB.collection("sessions").where("user_id", "==", user_id).stream():
        sess.reference.delete()
    DB.collection("users").document(user_id).delete()
    if email:
        DB.collection("deleted_accounts").document(email.strip().lower()).set({
            "deleted_at": _now_iso(),
            "by_admin": bool(by_admin),
        })
    return email


def get_user_krw(user_id):
    _require_db()
    snap = DB.collection("users").document(user_id).get()
    if not snap.exists:
        return 0
    try:
        return int(snap.to_dict().get("krw_remaining", 0))
    except (TypeError, ValueError):
        return 0


# 로그인했을 때 "업데이트 소식" 플로팅 창에 띄우는 내용. 새로 든 것이 있으면 위에
# 새 항목을 추가한다(항상 이 목록의 첫 자리 = 최신). version은 순전히 순서 비교용
# 정수라 날짜와 무관하게 그냥 하나씩 늘리면 된다 — 날짜 문자열을 쓰면 같은 날
# 두 번 배포했을 때 비교가 애매해진다. 계정마다 얼마나 봤는지는 Firestore의
# last_seen_changelog(정수)로 추적한다 — localStorage는 열 때마다 통째로 비워지므로
# (파일 맨 위 주석 참고) 여기 쓰면 로그인마다 다시 뜬다.
CHANGELOG = [
    {
        "version": 1,
        "date": "2026-08-19",
        "items": [
            "단어장 — 지문 분석 없이도 직접 입력·사진·PDF로 단어장을 만들 수 있습니다. "
            "사진·PDF는 화면에 끌어다 놓거나 붙여넣기(Ctrl+V)만 하면 됩니다.",
            "단어장 — 워드(.docx) 파일로 내려받고, 무작위로 섞어 시험지를 만들 수 있습니다.",
            "지문 분석 — 인쇄했을 때 쪽이 어디서 넘어가는지 미리 보여주고, 표·문장 카드 "
            "단위로 쪽 경계를 옮기는 '쪽 구성' 기능이 생겼습니다.",
            "지문 분석 — 직접 수정하거나 쪽 구성을 바꾼 내용을 한 단계씩 무르는 "
            "'↩ 되돌리기' 버튼이 생겼습니다.",
            "문제 제작 — 영어 정의를 보고 낱말을 맞히는 '영영풀이' 유형이 "
            "객관식·주관식에 추가됐습니다.",
        ],
    },
    {
        "version": 2,
        "date": "2026-08-19",
        "items": [
            "문제 제작 — 밑줄 친 우리말을 <보기> 낱말·<조건>에 맞게 직접 쓰는 "
            "'조건 영작', 문장을 수동태·분사구문 등으로 바꿔 쓰는 '문장 전환' "
            "유형이 주관식에 추가됐습니다.",
            "지문 분석 — '요약 이미지' 만들기가 기본으로 켜집니다(전과 달리 "
            "지문당 요금이 자동으로 더 붙으니, 필요 없으면 체크를 해제하세요).",
            "지문 분석 — ⚠️ 요약 이미지는 사이트 저장함에 담기지 않습니다. "
            "그림이 필요하시면 인쇄 창에서 PDF로 먼저 저장해 두세요. "
            "인쇄·저장을 누를 때 이 경고를 함께 보여 드립니다.",
            "지문 분석 — 두 번 분석해 보강하던 '꼼꼼 검토'를 뺐습니다.",
        ],
    },
    {
        "version": 3,
        "date": "2026-08-19",
        "items": [
            "문제 제작 — 지문에 대한 영어 질문을 읽고 완전한 영어 문장으로 답을 직접 쓰는 "
            "'질문에 답하기' 유형이 주관식에 추가됐습니다.",
        ],
    },
    {
        "version": 4,
        "date": "2026-08-19",
        "items": [
            "문제 제작 — 객관식에 '목적', '심경', '지칭 추론' 유형이 추가됐습니다.",
        ],
    },
    {
        "version": 5,
        "date": "2026-08-19",
        "items": [
            "문제 제작 — 객관식에 '어법 분석'(밑줄 각각에 대한 설명 중 옳은 것 고르기), "
            "'옳은 문장 찾기'(다섯 문장 중 어법상 옳은 것 고르기), "
            "'영영풀이 오류 찾기' 유형이 추가됐습니다.",
        ],
    },
    {
        "version": 6,
        "date": "2026-08-20",
        "items": [
            "반/학생 관리 — 반을 만들어 학생을 등록하세요. 학생은 별도 화면"
            "(/student.html)에서 자기 이름만 입력해 바로 로그인해, 선생님이 낸 "
            "단어시험을 온라인으로 풀 수 있습니다. 결과는 이 화면의 '학생 관리' 탭에서 "
            "바로 확인됩니다. (학생 로그인이 이름만으로 이뤄지므로, 등록 시 이름이 "
            "다른 학생과 겹치면 등록이 거부됩니다.)",
            "단어시험은 지금 만든 단어장으로 즉시 낼 수 있고(객관식·주관식 선택 가능), "
            "인공지능을 부르지 않아 채점까지 무료입니다. 반 전체에 낼 수도, 학생 한 명을 "
            "골라 그 학생에게만 낼 수도 있습니다. 이미 낸 시험은 삭제할 수 있고, "
            "'시험 내기' 창에서 저장해 둔 다른 단어장을 바로 골라 낼 수도 있습니다.",
        ],
    },
    {
        "version": 7,
        "date": "2026-08-21",
        "items": [
            "워크북 제작 — 맨 앞 단계로 '좌지문 우해석'이 추가됐습니다. 지문 원문(왼쪽)과 "
            "우리말 해석(오른쪽)을 나란히 놓고 읽는 단계로, 다른 단계들처럼 필요 없으면 "
            "체크를 해제할 수 있습니다.",
        ],
    },
    {
        "version": 8,
        "date": "2026-08-22",
        "items": [
            "문제 제작 — 만들어 둔 문제의 순서만 다시 섞는 '🔀 문제 섞기' 버튼이 생겼습니다. "
            "인공지능을 다시 부르지 않아 요금이 들지 않으니, 같은 문제로 A형·B형 시험지를 "
            "한 번 값에 뽑을 수 있습니다. 저장함에서 불러온 자료에도 그대로 쓸 수 있습니다.",
            "문제 제작 — 출제 순서를 '유형 순서대로 / 지문 내 유형 섞기 / 전체 문항 섞기' "
            "셋 중에 고를 수 있습니다. '전체 문항 섞기'는 지문 구분 없이 모든 문항을 뒤섞어, "
            "같은 지문 문항이 몰려 나와 지문을 외워서 푸는 것을 막습니다.",
            "학생 단어시험 — 객관식 보기가 4개에서 5개로 늘었습니다. 찍어서 맞힐 확률이 "
            "줄어듭니다(단어장에 든 단어가 적으면 보기도 그만큼 줄어듭니다).",
        ],
    },
    {
        "version": 9,
        "date": "2026-08-24",
        "items": [
            "문제 제작 — 한 번에 200문항이 넘으면 예전에는 '줄여 주세요'라며 거부했지만, "
            "이제는 만들 문항 수·AI 호출 횟수·예상 요금을 보여 주고 "
            "'나눠서 진행 / 그대로 진행 / 취소' 중에 고를 수 있습니다. "
            "나눠서 진행하면 지문을 200문항씩 묶어 차례로 돌리고, 진행 표시에 "
            "'1/2 묶음'처럼 어디까지 왔는지 보여 드립니다. 지문과 유형을 다시 고를 "
            "필요가 없어졌습니다(요금 총액은 나눠도 같습니다).",
        ],
    },
    {
        "version": 10,
        "date": "2026-08-26",
        "items": [
            "학생 관리 — '이 반의 로그인 코드' 상자를 없애고, 그 자리에 '학생에게 알려 줄 "
            "주소'를 넣었습니다. 학생은 이미 오래전부터 자기 이름만 넣어 로그인하는데 "
            "화면 안내만 예전 방식('이 코드를 넣고 로그인합니다') 그대로였습니다. "
            "이제 학생에게 보낼 주소가 통째로 표시되고 [복사] 버튼으로 바로 복사해 "
            "문자·알림장에 붙여넣을 수 있습니다. 따로 알려 주실 코드는 없습니다.",
        ],
    },
]


def _unseen_updates(last_seen):
    """CHANGELOG 중 이 사용자가 아직 못 본 것만, 오래된 순으로 돌려준다.
    last_seen이 없으면(가입이 이 기능보다 오래된 계정) 전부 못 본 것으로 본다."""
    try:
        last_seen = int(last_seen or 0)
    except (TypeError, ValueError):
        last_seen = 0
    return [c for c in reversed(CHANGELOG) if c["version"] > last_seen]


def _account_payload(user_id):
    """/api/me와 로그인·회원가입 성공 응답이 공유하는 계정 정보 — 화면이 이름·잔액을
    표시하는 데 쓴다."""
    _require_db()
    info = DB.collection("users").document(user_id).get().to_dict() or {}
    krw, free, paid = _split_balance(info)
    return {
        "loggedIn": True,
        "email": info.get("email"),
        "name": info.get("name"),
        "krwRemaining": krw,
        # 유상/무상 구분 — 환불 대상은 유상분뿐이라 화면에서도 나눠 보여 준다
        "krwFree": free,
        "krwPaid": paid,
        # 반/학생 관리 탭을 보여줄지 — 관리자가 켜 준 선생님만 True
        "classroomApproved": bool(info.get("classroom_approved")),
        # 로그인마다 함께 내려준다 — 비어 있으면 화면이 아무것도 띄우지 않는다
        "updates": _unseen_updates(info.get("last_seen_changelog")),
    }


def _split_balance(d):
    """회원 문서에서 (전체, 무상, 유상) 잔액을 꺼낸다.

    유상/무상 구분이 없던 시절의 문서에는 krw_remaining 하나뿐이다. 그 잔액은 전부
    무상으로 본다 — 유료 전환 전이라 실제로 돈을 낸 사람이 아직 없기 때문이다.
    (환불 대상은 유상분뿐이므로, 옛 잔액을 유상으로 잡으면 없던 채무가 생긴다.)"""
    try:
        total = int(d.get("krw_remaining", 0) or 0)
    except (TypeError, ValueError):
        total = 0
    if "krw_free" not in d and "krw_paid" not in d:
        return total, total, 0
    try:
        free = int(d.get("krw_free", 0) or 0)
        paid = int(d.get("krw_paid", 0) or 0)
    except (TypeError, ValueError):
        free, paid = total, 0
    return free + paid, free, paid


def _ledger_row(user_id, kind, label, amount, paid_delta, free_delta, balance_after,
                expires_at=None):
    """원장 한 줄. 지문 원문은 절대 넣지 않는다 — 항목 이름만으로 충분하고,
    저작권 있는 교재 지문을 영구 보관할 이유가 없다."""
    now = datetime.now(timezone.utc)
    return {
        "user_id": user_id,
        "kind": kind,                 # use=사용 charge=유상충전 grant=무상지급 carry=이월
        "label": label,
        "amount": int(amount),        # 사용은 음수, 충전·지급은 양수
        "paid_delta": int(paid_delta),
        "free_delta": int(free_delta),
        "balance_after": int(balance_after),
        "created_at": now.isoformat(),
        "date_kst": now.astimezone(KST).strftime("%Y-%m-%d %H:%M"),
        # 무상 포인트 소멸 예정일. 지금은 FREE_POINT_EXPIRE_DAYS=0이라 항상 None이고,
        # 나중에 켜면 이 값을 가진 지급분부터 대상이 된다(이미 준 것은 소급되지 않는다).
        "expires_at": expires_at,
    }


def _free_expiry():
    if FREE_POINT_EXPIRE_DAYS <= 0:
        return None
    return (datetime.now(timezone.utc) + timedelta(days=FREE_POINT_EXPIRE_DAYS)).isoformat()


def _log_signup_grant(user_id, amount):
    """가입 축하금을 원장에 남긴다. 잔액은 계정 문서를 만들 때 이미 넣었으므로 여기서는
    기록만 한다. 기록이 실패했다고 가입까지 막을 이유는 없으므로 예외는 삼킨다."""
    if amount <= 0:
        return
    try:
        DB.collection(POINT_LEDGER).document().set(_ledger_row(
            user_id, "grant", "가입 축하 지급", amount, 0, amount, amount,
            expires_at=_free_expiry(),
        ))
    except Exception:
        traceback.print_exc()


def charge_krw(user_id, amount, label="사용", kind="use"):
    """생성이 성공했을 때만 부른다 — 정찰 가격제라 실패한 시도에는 과금하지 않는다
    (Gemini 실제 사용량과 무관하게 고정가라, 실패 시 청구하지 않는 게 정당하다).

    잔액 변경과 원장 기록을 한 트랜잭션으로 묶는다. 둘이 어긋나면 그 자체가 분쟁거리라
    (돈은 빠졌는데 내역이 없다), 따로 쓰면 안 된다.
    무상분부터 깎는다 — 유상분을 남겨 둬야 환불 요청에 답할 수 있다."""
    if amount <= 0:
        return
    _require_db()
    user_ref = DB.collection("users").document(user_id)
    row_ref = DB.collection(POINT_LEDGER).document()

    @firestore.transactional
    def _apply(tx):
        snap = user_ref.get(transaction=tx)
        if not snap.exists:
            raise ValueError("해당 회원을 찾을 수 없습니다.")
        _total, free, paid = _split_balance(snap.to_dict() or {})
        use_free = min(free, amount)
        use_paid = amount - use_free
        new_free, new_paid = free - use_free, paid - use_paid
        tx.update(user_ref, {
            "krw_remaining": new_free + new_paid,
            "krw_free": new_free,
            "krw_paid": new_paid,
        })
        tx.set(row_ref, _ledger_row(
            user_id, kind, label, -amount, -use_paid, -use_free, new_free + new_paid
        ))

    _apply(DB.transaction())


def add_krw(user_id, amount, kind, label):
    """잔액을 더한다. kind='charge'면 유상(환불 대상), 'grant'면 무상(소멸 대상).
    돌려주는 값은 더한 뒤의 전체 잔액."""
    _require_db()
    user_ref = DB.collection("users").document(user_id)
    row_ref = DB.collection(POINT_LEDGER).document()
    expires_at = _free_expiry() if kind == "grant" else None

    @firestore.transactional
    def _apply(tx):
        snap = user_ref.get(transaction=tx)
        if not snap.exists:
            raise ValueError("해당 회원을 찾을 수 없습니다.")
        _total, free, paid = _split_balance(snap.to_dict() or {})
        add_free = amount if kind == "grant" else 0
        add_paid = amount if kind != "grant" else 0
        new_free, new_paid = free + add_free, paid + add_paid
        tx.update(user_ref, {
            "krw_remaining": new_free + new_paid,
            "krw_free": new_free,
            "krw_paid": new_paid,
        })
        tx.set(row_ref, _ledger_row(
            user_id, kind, label, amount, add_paid, add_free, new_free + new_paid,
            expires_at=expires_at,
        ))
        return new_free + new_paid

    return _apply(DB.transaction())


def create_payment_intent(user_id, amount):
    """결제창을 열기 '전에' 부른다. 아직 포인트를 주지 않는다 — 결제가 실제로
    끝난 뒤 confirm_payment_intent가 포트원 서버에 직접 물어보고 나서야 지급한다.
    브라우저가 보고하는 성공 여부는 위조될 수 있으므로 그 자체를 근거로 쓰지 않는다."""
    _require_db()
    payment_id = f"pay-{secrets.token_hex(16)}"
    DB.collection("payment_intents").document(payment_id).set({
        "user_id": user_id,
        "amount": int(amount),
        "status": "pending",
        "created_at": _now_iso(),
    })
    return payment_id


def _fetch_portone_payment(payment_id):
    """포트원 서버에 결제 단건 조회. 실패하면 예외를 그대로 올린다 — 호출부가
    '확인 안 됨'과 '확인하다 실패함'을 구분해서 처리한다(전자만 결제 실패로 못 박는다)."""
    url = f"{PORTONE_API_BASE}/payments/{urllib.parse.quote(payment_id, safe='')}"
    req = urllib.request.Request(url, headers={"Authorization": f"PortOne {PORTONE_API_SECRET}"})
    with urllib.request.urlopen(req, timeout=15) as resp:
        return json.loads(resp.read().decode("utf-8"))


def confirm_payment_intent(user_id, payment_id):
    """결제창이 끝난 뒤 부른다. 포트원이 답한 결제 정보가 이 사용자·이 금액·이
    상점/채널과 정확히 맞을 때만 충전한다. 이미 처리된 결제(중복 호출·새로고침
    재시도)면 다시 주지 않고 지금 잔액만 돌려준다 — '결제 완료 표시'와 '충전'을
    같은 트랜잭션 안에서 함께 바꾸므로 이중 지급이 될 수 없다."""
    _require_db()
    intent_ref = DB.collection("payment_intents").document(payment_id)
    snap = intent_ref.get()
    if not snap.exists:
        raise ValueError("결제 요청을 찾을 수 없습니다.")
    intent = snap.to_dict() or {}
    if intent.get("user_id") != user_id:
        raise ValueError("본인의 결제가 아닙니다.")
    if intent.get("status") != "pending":
        return get_user_krw(user_id)  # 이미 처리됨 — 조용히 현재 잔액만 돌려준다

    amount = int(intent.get("amount", 0))
    try:
        payment = _fetch_portone_payment(payment_id)
    except Exception as e:
        raise ValueError(f"결제 확인에 실패했습니다: {e}")

    paid_amount = payment.get("amount") or {}
    ok = (
        payment.get("status") == "PAID"
        and int(paid_amount.get("total", -1)) == amount
        and paid_amount.get("currency") == "KRW"
        and payment.get("storeId") == PORTONE_STORE_ID
        and (payment.get("selectedChannel") or {}).get("key") == PORTONE_CHANNEL_KEY_CARD
    )
    if not ok:
        intent_ref.update({"status": "failed", "checked_at": _now_iso()})
        raise ValueError("결제가 확인되지 않았습니다.")

    user_ref = DB.collection("users").document(user_id)
    row_ref = DB.collection(POINT_LEDGER).document()

    @firestore.transactional
    def _apply(tx):
        i_snap = intent_ref.get(transaction=tx)
        u_snap = user_ref.get(transaction=tx)
        if (i_snap.to_dict() or {}).get("status") != "pending":
            return None  # 그 사이 다른 요청이 먼저 처리함 — 중복 지급 방지
        if not u_snap.exists:
            raise ValueError("해당 회원을 찾을 수 없습니다.")
        _total, free, paid = _split_balance(u_snap.to_dict() or {})
        new_free, new_paid = free, paid + amount
        tx.update(user_ref, {
            "krw_remaining": new_free + new_paid,
            "krw_free": new_free,
            "krw_paid": new_paid,
        })
        tx.set(row_ref, _ledger_row(
            user_id, "charge", "카드 결제 충전", amount, amount, 0, new_free + new_paid,
        ))
        tx.update(intent_ref, {"status": "completed", "confirmed_at": _now_iso()})
        return new_free + new_paid

    result = _apply(DB.transaction())
    return result if result is not None else get_user_krw(user_id)


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


# --- 관리자 로그인 (일반 회원 로그인과 완전히 별개) ---------------------------

# 무차별대입 방지 — 4자리 숫자 같은 짧은 비밀번호는 시도 횟수를 안 막으면 순식간에
# 뚫린다. IP별로 실패 횟수를 세어 잠깐 막는다. 서버 재시작하면 초기화되지만, 재시작
# 자체가 흔치 않고 그사이 시도 기록이 사라져도 큰 문제는 아니다.
_admin_login_fails = {}  # ip -> [실패시각, ...]
ADMIN_LOGIN_MAX_ATTEMPTS = 5
ADMIN_LOGIN_WINDOW = 300  # 5분


def _client_ip(handler):
    fwd = handler.headers.get("X-Forwarded-For", "")
    if fwd:
        return fwd.split(",")[0].strip()
    return handler.client_address[0]


def _admin_login_blocked(ip):
    now = time.monotonic()
    fails = [t for t in _admin_login_fails.get(ip, []) if now - t < ADMIN_LOGIN_WINDOW]
    _admin_login_fails[ip] = fails
    return len(fails) >= ADMIN_LOGIN_MAX_ATTEMPTS


def _admin_login_record_fail(ip):
    _admin_login_fails.setdefault(ip, []).append(time.monotonic())


def _admin_login_clear(ip):
    _admin_login_fails.pop(ip, None)


def verify_admin_password(username, password):
    if not ADMIN_PASSWORD:
        raise ValueError("관리자 로그인이 아직 설정되지 않았습니다 (ADMIN_PASSWORD 미설정).")
    # 아이디·비밀번호 둘 다 길이가 노출되지 않도록 compare_digest로 비교
    ok_user = secrets.compare_digest(username.strip(), ADMIN_USERNAME)
    ok_pass = secrets.compare_digest(password, ADMIN_PASSWORD)
    if not (ok_user and ok_pass):
        raise ValueError("아이디 또는 비밀번호가 올바르지 않습니다.")


def create_admin_session():
    _require_db()
    token = secrets.token_urlsafe(32)
    expires = datetime.now(timezone.utc) + timedelta(seconds=ADMIN_SESSION_MAX_AGE)
    DB.collection("admin_sessions").document(token).set({
        "created_at": _now_iso(),
        "expires_at": expires.isoformat(),
    })
    return token


def _admin_session_valid(handler):
    if DB is None:
        return False
    token = _parse_cookies(handler.headers.get("Cookie", "")).get("admin_session")
    if not token:
        return False
    ref = DB.collection("admin_sessions").document(token)
    snap = ref.get()
    if not snap.exists:
        return False
    try:
        expires = datetime.fromisoformat(snap.to_dict()["expires_at"])
    except Exception:
        return False
    if datetime.now(timezone.utc) >= expires:
        ref.delete()
        return False
    return True


def delete_admin_session(token):
    if DB is None or not token:
        return
    DB.collection("admin_sessions").document(token).delete()


def list_all_users():
    """회원 목록 — 이메일·이름·가입방식·잔액·가입일. 가입일 최신순."""
    _require_db()
    rows = []
    for doc in DB.collection("users").stream():
        d = doc.to_dict() or {}
        try:
            krw = int(d.get("krw_remaining", 0))
        except (TypeError, ValueError):
            krw = 0
        rows.append({
            "id": doc.id,
            "email": d.get("email", ""),
            "name": d.get("name", ""),
            "provider": "password" if d.get("password_hash") else "google",
            "krwRemaining": krw,
            "createdAt": d.get("created_at", ""),
            "classroomApproved": bool(d.get("classroom_approved")),
        })
    rows.sort(key=lambda r: r["createdAt"], reverse=True)
    return rows


def list_pending_signups():
    """가입을 시작했지만 아직 인증코드를 넣지 않은 사람들 — 이메일·이름·시작 시각만.

    회원 목록에는 users 문서가 있는 사람만 나온다. 인증을 못 끝내면 문서가 생기지
    않으므로, 메일이 안 나가는 상황에서는 '가입하려던 사람이 있었다는 사실' 자체가
    화면 어디에도 남지 않는다. 실제로 그렇게 이메일 가입이 통째로 막혀 있는데도
    한동안 아무도 몰랐다. 그래서 관리자 화면에 함께 띄운다.

    인증코드와 비밀번호 해시는 절대 내보내지 않는다 — 코드가 새면 남의 계정을
    대신 만들어 버릴 수 있다."""
    _require_db()
    rows = []
    for doc in DB.collection("pending_signups").stream():
        d = doc.to_dict() or {}
        rows.append({
            "email": d.get("email", "") or doc.id,
            "name": d.get("name", ""),
            "createdAt": d.get("created_at", ""),
        })
    rows.sort(key=lambda r: r["createdAt"], reverse=True)
    return rows


def recharge_user_krw(user_id, amount, kind="grant", label=None):
    """관리자가 임의로 잔액을 더하거나(양수) 뺀다(음수). 계정이 실제로 있는지는
    트랜잭션 안에서 확인한다.

    kind는 더할 때만 의미가 있다 — 'charge'는 실제로 돈을 받은 유상 충전(환불 대상),
    'grant'는 그냥 얹어 주는 무상 지급. 기본값이 무상인 것은, 결제사가 붙기 전까지
    관리자 충전은 전부 돈을 받지 않은 지급이기 때문이다."""
    amount = int(amount)
    if amount == 0:
        return get_user_krw(user_id)
    if amount > 0:
        return add_krw(user_id, amount, kind, label or ("관리자 충전" if kind == "charge" else "관리자 지급"))
    charge_krw(user_id, -amount, label or "관리자 차감", kind="adjust")
    return get_user_krw(user_id)


def _fold_old_ledger(user_id):
    """보관 기간(LEDGER_KEEP_MONTHS)이 지난 줄을 '이월' 한 줄로 접는다.

    포인트에 유효기간이 없어서 잔액은 몇 년이고 살아 있는데 근거만 사라지면,
    (지급+충전-사용=잔액) 검산이 영영 깨진다. 그래서 지우기 전에 합계를 한 줄 남긴다.

    정기 실행 장치(cron)가 없으므로 이용 내역을 열 때 겸사겸사 한다. 접을 게 없으면
    질의 한 번으로 끝나고, 실패해도 조회 자체는 계속되어야 하므로 호출부에서 삼킨다.

    order_by를 굳이 붙이는 이유: created_at에 범위 조건(<)을 걸면 Firestore가 그 필드로
    정렬하려 드는데, 방향을 안 적으면 오름차순으로 잡고 (user_id, created_at 오름차순)
    색인을 따로 요구한다. 목록 조회가 쓰는 색인은 내림차순이라 그것과 어긋나 매번
    실패했다. 어차피 오래된 줄을 전부 모아 합산할 뿐이라 순서는 상관없으므로,
    이미 있는 내림차순 색인에 맞춰 둔다(색인을 하나 더 만들 이유가 없다)."""
    cutoff = (datetime.now(timezone.utc) - timedelta(days=30 * LEDGER_KEEP_MONTHS)).isoformat()
    old = list(
        DB.collection(POINT_LEDGER)
        .where("user_id", "==", user_id)
        .where("created_at", "<", cutoff)
        .order_by("created_at", direction=firestore.Query.DESCENDING)
        .stream()
    )
    if len(old) < 2:  # 이월 줄 하나만 남은 상태면 접을 것이 없다
        return
    plus = minus = 0
    balance_after = 0
    latest = ""
    for doc in old:
        d = doc.to_dict() or {}
        amt = int(d.get("amount", 0) or 0)
        if amt >= 0:
            plus += amt
        else:
            minus += -amt
        created = d.get("created_at") or ""
        if created >= latest:      # 접기 직전 시점의 잔액을 이월 잔액으로 삼는다
            latest, balance_after = created, int(d.get("balance_after", 0) or 0)
    batch = DB.batch()
    row = _ledger_row(user_id, "carry", f"이전 내역 요약 (충전·지급 {plus:,}원 / 사용 {minus:,}원)",
                      0, 0, 0, balance_after)
    row["created_at"] = latest     # 목록에서 접힌 구간의 끝자리에 놓이도록
    batch.set(DB.collection(POINT_LEDGER).document(), row)
    for doc in old:
        batch.delete(doc.reference)
    batch.commit()


def list_usage(user_id, limit=50, before=None):
    """이용 내역 — 최신순. before(created_at)를 주면 그보다 과거만 돌려준다(더 보기)."""
    _require_db()
    try:
        _fold_old_ledger(user_id)
    except Exception:
        traceback.print_exc()   # 접기에 실패해도 내역은 보여 준다
    q = DB.collection(POINT_LEDGER).where("user_id", "==", user_id)
    if before:
        q = q.where("created_at", "<", before)
    q = q.order_by("created_at", direction=firestore.Query.DESCENDING).limit(int(limit))
    rows = []
    for doc in q.stream():
        d = doc.to_dict() or {}
        rows.append({
            "id": doc.id,
            "kind": d.get("kind"),
            "label": d.get("label"),
            "amount": int(d.get("amount", 0) or 0),
            "balanceAfter": int(d.get("balance_after", 0) or 0),
            "date": d.get("date_kst") or "",
            "createdAt": d.get("created_at") or "",
            "expiresAt": d.get("expires_at"),
        })
    return rows


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


# =============================================================================
# 반 · 학생 · 단어시험 (선생님이 반을 만들고 학생을 등록 → 학생은 코드로 로그인해
# 단어시험을 봄 → 결과가 선생님 화면에 모임). AI를 부르지 않는다 — 객관식 오답은
# 같은 단어장의 다른 뜻/단어에서 뽑고, 채점은 문자열 비교로 한다.
# =============================================================================

def _classroom_approved(user_id):
    """관리자가 이 선생님에게 학생 등록 기능을 켜 줬는지. 미성년자 데이터가 걸린
    기능이라 가입만으로는 못 쓰게 막아 둔다 — admin.html에서 관리자가 켠다."""
    _require_db()
    snap = DB.collection("users").document(user_id).get()
    return bool((snap.to_dict() or {}).get("classroom_approved")) if snap.exists else False


def set_classroom_approved(user_id, approved):
    _require_db()
    ref = DB.collection("users").document(user_id)
    if not ref.get().exists:
        raise ValueError("회원을 찾을 수 없습니다.")
    ref.update({"classroom_approved": bool(approved)})


# --- 반 · 학생 ---------------------------------------------------------------

def _gen_class_code():
    return "".join(secrets.choice(CLASS_CODE_ALPHABET) for _ in range(CLASS_CODE_LEN))


def _new_unique_class_code():
    """짧은 코드라 세션 토큰과 달리 겹칠 가능성을 실제로 확인해야 한다 — 있으면 다시 뽑는다."""
    for _ in range(5):
        code = _gen_class_code()
        if not DB.collection("class_codes").document(code).get().exists:
            return code
    raise RuntimeError("코드 생성에 반복 실패했습니다. 다시 시도해 주세요.")


def create_class(teacher_id, name):
    """반 하나에 코드 하나 — 학생별 코드 대신 반 전체가 코드 하나를 공유한다.
    학생은 이 코드로 반을 찾은 뒤, 목록에서 자기 이름을 골라 로그인한다(비밀번호
    구실을 하는 건 반 코드뿐이다 — 이름은 그냥 '나'를 고르는 용도지 인증 수단이
    아니다. 급우끼리 서로 코드를 알면 이름만으로 남 행세를 할 수 있다는 뜻이라,
    부정행위 방지는 여기서는 기술이 아니라 교실 안 관리에 맡긴다)."""
    _require_db()
    name = (name or "").strip()
    if not name:
        raise ValueError("반 이름을 입력하세요.")
    code = _new_unique_class_code()
    ref = DB.collection("classes").document()
    ref.set({"teacher_id": teacher_id, "name": name, "code": code, "created_at": _now_iso()})
    DB.collection("class_codes").document(code).set({"class_id": ref.id})
    return {"classId": ref.id, "code": code}


def list_classes(teacher_id):
    _require_db()
    rows = []
    for doc in DB.collection("classes").where("teacher_id", "==", teacher_id).stream():
        d = doc.to_dict() or {}
        rows.append({
            "id": doc.id, "name": d.get("name", ""), "code": d.get("code", ""),
            "createdAt": d.get("created_at", ""),
        })
    rows.sort(key=lambda r: r["createdAt"])
    return rows


def regenerate_class_code(teacher_id, class_id):
    _require_db()
    ref = DB.collection("classes").document(class_id)
    snap = ref.get()
    if not snap.exists or snap.to_dict().get("teacher_id") != teacher_id:
        raise ValueError("반을 찾을 수 없습니다.")
    old_code = snap.to_dict().get("code")
    new_code = _new_unique_class_code()
    ref.update({"code": new_code})
    DB.collection("class_codes").document(new_code).set({"class_id": class_id})
    if old_code:
        DB.collection("class_codes").document(old_code).delete()
    return new_code


def create_student(teacher_id, class_id, name):
    """학생 등록. 이름은 반을 가리지 않고 앱 전체에서 유일해야 한다 — 로그인
    (login_student)이 이제 반 코드 없이 이름만으로 students 전체를 검색하기
    때문에, 등록 시점에 동명이인을 막아 두지 않으면 나중에 둘 다 로그인이
    거부되는 사고가 난다."""
    _require_db()
    name = _norm_text(name)
    if not name:
        raise ValueError("학생 이름을 입력하세요.")
    c_snap = DB.collection("classes").document(class_id).get()
    if not c_snap.exists or c_snap.to_dict().get("teacher_id") != teacher_id:
        raise ValueError("반을 찾을 수 없습니다.")
    if list(DB.collection("students").where("name", "==", name).limit(1).stream()):
        raise ValueError("같은 이름의 학생이 이미 등록되어 있습니다. 학생 로그인이 이름만으로 이뤄지므로 이름이 겹치면 등록할 수 없습니다.")
    ref = DB.collection("students").document()
    ref.set({"teacher_id": teacher_id, "class_id": class_id, "name": name, "created_at": _now_iso()})
    return {"studentId": ref.id}


def list_students(teacher_id, class_id):
    _require_db()
    c_snap = DB.collection("classes").document(class_id).get()
    if not c_snap.exists or c_snap.to_dict().get("teacher_id") != teacher_id:
        raise ValueError("반을 찾을 수 없습니다.")
    rows = []
    for doc in DB.collection("students").where("class_id", "==", class_id).stream():
        d = doc.to_dict() or {}
        rows.append({"id": doc.id, "name": d.get("name", ""), "createdAt": d.get("created_at", "")})
    rows.sort(key=lambda r: r["createdAt"])
    return rows


def _delete_student_sessions(student_id):
    for doc in DB.collection("student_sessions").where("student_id", "==", student_id).stream():
        doc.reference.delete()


def delete_student(teacher_id, student_id):
    _require_db()
    ref = DB.collection("students").document(student_id)
    snap = ref.get()
    if not snap.exists or snap.to_dict().get("teacher_id") != teacher_id:
        raise ValueError("학생을 찾을 수 없습니다.")
    _delete_student_sessions(student_id)
    ref.delete()


# --- 학생 로그인 세션 (admin_sessions와 같은 모양, 다만 student_id를 함께 담는다) ---

def create_student_session(student_id):
    _require_db()
    token = secrets.token_urlsafe(32)
    expires = datetime.now(timezone.utc) + timedelta(seconds=STUDENT_SESSION_MAX_AGE)
    DB.collection("student_sessions").document(token).set({
        "student_id": student_id, "created_at": _now_iso(), "expires_at": expires.isoformat(),
    })
    return token


def delete_student_session(token):
    if DB is None or not token:
        return
    DB.collection("student_sessions").document(token).delete()


def _student_session_user(handler):
    """세션 쿠키로 로그인한 학생의 student_id. 없거나 만료됐으면 None."""
    if DB is None:
        return None
    token = _parse_cookies(handler.headers.get("Cookie", "")).get("student_session")
    if not token:
        return None
    ref = DB.collection("student_sessions").document(token)
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
    return sess.get("student_id")


# 무차별 대입 방지 — 관리자 로그인과 같은 방식(IP별 실패 횟수 제한)
_student_login_fails = {}
STUDENT_LOGIN_MAX_ATTEMPTS = 5
STUDENT_LOGIN_WINDOW = 300  # 5분


def _student_login_blocked(ip):
    now = time.monotonic()
    fails = [t for t in _student_login_fails.get(ip, []) if now - t < STUDENT_LOGIN_WINDOW]
    _student_login_fails[ip] = fails
    return len(fails) >= STUDENT_LOGIN_MAX_ATTEMPTS


def _student_login_record_fail(ip):
    _student_login_fails.setdefault(ip, []).append(time.monotonic())


def _student_login_clear(ip):
    _student_login_fails.pop(ip, None)


def login_student(name, ip):
    """학생 로그인 — 이름만 입력하면 로그인된다. 반 코드는 더 이상 묻지 않는다
    (학생 등록이 이미 반 하나에 속해 있으니 반 코드는 로그인에서 군더더기라는
    판단 — 다만 그만큼 로그인의 유일한 방어선이던 비밀값이 사라졌다는 뜻이기도
    하다. 이름을 아는 사람이면 누구나 그 학생으로 로그인할 수 있다).

    students 컬렉션 전체에서(반·선생님을 가리지 않고) 이름으로 찾는다 — 반을
    구분할 입력값이 없으므로 검색 범위를 반 하나로 좁힐 수가 없다. 그래서 다른
    선생님 반의 학생과 이름이 같아도 걸린다: 동명이인이면 누구로 로그인할지
    가릴 수 없으므로 거부한다(아무나 골라 로그인시키면 서로 다른 사람의 시험
    결과가 뒤섞인다). 흔한 이름일수록 이 충돌이 잦아질 수 있다."""
    if _student_login_blocked(ip):
        raise ValueError("시도가 너무 많습니다. 5분 뒤 다시 시도하세요.")
    name = _norm_text(name)
    if not name:
        raise ValueError("이름을 입력하세요.")
    _require_db()
    matches = list(DB.collection("students").where("name", "==", name).stream())
    if not matches:
        _student_login_record_fail(ip)
        raise ValueError("그 이름을 찾을 수 없습니다. 선생님께 확인해 주세요.")
    if len(matches) > 1:
        _student_login_record_fail(ip)
        raise ValueError("같은 이름의 학생이 여러 명입니다. 선생님께 문의해 주세요.")
    _student_login_clear(ip)
    student_id = matches[0].id
    return student_id, (matches[0].to_dict() or {}).get("name", "")


# --- 단어시험 (AI 없음) ------------------------------------------------------

_MEANING_SPLIT_RE = re.compile(r"[,;·、/]+")
_BRACKET_RE = re.compile(r"\[([^\]]*)\]")          # 수선[수리]하다 — 앞말 대신 쓸 수 있는 말
_PAREN_RE = re.compile(r"[(（][^)）]*[)）]")         # (건강 등을) 회복 — 부연 설명
# '~을 돌보다'의 '~'은 목적어 자리표시다. 기호만 지우면 '을 돌보다'가 남아 학생이
# 쓸 리 없는 형태가 되므로, 뒤에 붙은 조사까지 함께 지워 '돌보다'가 되게 한다.
_PLACEHOLDER_RE = re.compile(r"[~∼…]+\s*(?:에게서|에게|에서|으로|와|과|을|를|이|가|에|로|의)?")


def _norm_text(s):
    return re.sub(r"\s+", " ", (s or "").strip())


def _expand_brackets(text):
    """'수선[수리]하다' → ['수선하다', '수리하다'].
    사전에서 대괄호는 '앞말 대신 이 말을 써도 된다'는 표기다. 그대로 두면 학생이
    대괄호까지 타이핑해야 정답이 되어 사실상 맞힐 수 없다."""
    m = _BRACKET_RE.search(text)
    if not m:
        return [text]
    head, alt, tail = text[: m.start()], m.group(1).strip(), text[m.end() :]
    out = []
    for t in _expand_brackets(tail):   # 대괄호가 여러 개여도 모두 펼친다
        out.append(head + t)
        if alt:
            out.append(alt + t)
    return out


def _meaning_variants(text):
    """'빠른, 신속한'처럼 여러 뜻이 이어진 경우 각각을 정답 후보로 쪼갠다 —
    주관식 채점에서 그중 하나만 맞아도 정답 처리하기 위해서다.
    대괄호는 위처럼 펼치고, 괄호 안 부연 설명('(건강 등을) 회복')은 떼어 낸 형태도
    함께 인정한다. '~'·'…' 같은 자리표시 기호도 지운다.

    '하다'를 자동으로 붙이거나 떼지는 않는다 — 선생님이 '수선하다'라고만 적었으면
    '수선'은 오답이어야 한다(명사·동사를 구분해 가르치는 경우가 있다). 둘 다
    인정받고 싶으면 단어장에 둘 다 적으면 된다."""
    out, seen = [], set()

    def add(v):
        v = _norm_text(v)
        if v and v not in seen:
            seen.add(v)
            out.append(v)

    # 쪼갠 조각마다 받아 주되, 뜻을 전부 이어 쓴 답('custom, routine')도 인정한다 —
    # 다 아는 학생이 다 적었는데 틀리는 일이 없게 한다.
    whole = _norm_text(text)
    for part in [whole] + _MEANING_SPLIT_RE.split(whole):
        if not part.strip():
            continue
        # 단어장에 적힌 그대로 옮겨 쓴 답도 정답으로 받아 둔다(대괄호·기호 포함)
        for cand in [part] + _expand_brackets(part):
            no_paren = _PAREN_RE.sub(" ", cand)
            add(cand)
            add(no_paren)
            add(_PLACEHOLDER_RE.sub(" ", cand))
            add(_PLACEHOLDER_RE.sub(" ", no_paren))
    return out


def _answer_key(s):
    """채점용 비교 키 — 띄어쓰기를 무시하고 대소문자를 맞춘다.
    '회복 하다'와 '회복하다'를 다르게 채점할 이유가 없다."""
    return re.sub(r"\s+", "", (s or "")).lower()


def create_test_assignment(teacher_id, class_id, title, vocab, fmt, student_id=None, max_wrong=None):
    """출제 방향(영어→뜻 / 뜻→영어)은 더 이상 선생님이 고르지 않는다 — 문제마다
    _build_student_questions가 무작위로 섞어 낸다. 그래서 여기서는 객관식일 때
    두 방향 다 오답을 만들 수 있는지(서로 다른 뜻 2개 이상 '그리고' 서로 다른
    단어 2개 이상) 미리 확인해 둔다 — 어느 방향이 나올지 미리 알 수 없어서다.

    student_id가 없으면(기본) 반 전체에 낸다. 있으면 그 학생 한 명에게만 낸다 —
    student_name을 함께 스냅샷으로 저장해 두는 이유는 목록을 보여줄 때마다
    students 컬렉션을 또 읽지 않기 위해서다(학생이 나중에 이름을 바꾸거나
    삭제돼도 이 시험의 '누구에게 냈는지' 표시는 그대로 남는다).

    max_wrong=None이면(기본) 재시험 없이 1회로 끝난다(예전과 같은 동작 — 옛 시험도
    이 필드가 없어 그대로 호환된다). 정수면 '이 개수 이하로 틀려야 합격'이고,
    불합격이면 학생이 몇 번이고 다시 볼 수 있다(_get_student_attempts/
    _attempt_progress 참고) — 회차마다 문제를 다시 섞어 답 위치만 외워 통과하는
    것을 막는다(_build_student_questions의 round 인자)."""
    _require_db()
    c_snap = DB.collection("classes").document(class_id).get()
    if not c_snap.exists or c_snap.to_dict().get("teacher_id") != teacher_id:
        raise ValueError("반을 찾을 수 없습니다.")
    if fmt not in ("mcq", "saq"):
        raise ValueError("잘못된 시험 형식입니다.")
    student_name = None
    if student_id:
        s_snap = DB.collection("students").document(student_id).get()
        if not s_snap.exists or s_snap.to_dict().get("class_id") != class_id:
            raise ValueError("학생을 찾을 수 없습니다.")
        student_name = s_snap.to_dict().get("name", "")
    clean_vocab = []
    for item in (vocab or []):
        word = _norm_text(item.get("word"))
        meaning = _norm_text(item.get("meaning"))
        if not word or not meaning:
            continue
        clean_vocab.append({
            "word": word, "meaning": meaning,
            "pos": _norm_text(item.get("pos")),
            "synonym": _norm_text(item.get("synonym")),
            "antonym": _norm_text(item.get("antonym")),
        })
    if len(clean_vocab) < 2:
        raise ValueError("단어가 최소 2개는 있어야 시험을 만들 수 있습니다.")
    if fmt == "mcq":
        distinct_meanings = {w["meaning"] for w in clean_vocab}
        distinct_words = {w["word"] for w in clean_vocab}
        if len(distinct_meanings) < 2 or len(distinct_words) < 2:
            raise ValueError(
                "객관식으로 내려면 서로 다른 뜻과 서로 다른 단어가 각각 2개 이상 필요합니다 "
                "(영어→뜻·뜻→영어를 섞어 내다 보니 둘 다 필요합니다). 주관식으로 내보세요."
            )
    if max_wrong is not None:
        try:
            max_wrong = int(max_wrong)
        except (TypeError, ValueError):
            raise ValueError("허용 오답 수는 숫자여야 합니다.")
        if not (0 <= max_wrong <= len(clean_vocab)):
            raise ValueError(f"허용 오답 수는 0~{len(clean_vocab)} 사이여야 합니다.")
    ref = DB.collection("test_assignments").document()
    ref.set({
        "teacher_id": teacher_id, "class_id": class_id,
        "student_id": student_id, "student_name": student_name,
        "title": (title or "").strip() or "단어시험",
        "vocab": clean_vocab, "format": fmt, "max_wrong": max_wrong,
        "created_at": _now_iso(),
    })
    return ref.id


def update_assignment_retest(teacher_id, assignment_id, max_wrong):
    """이미 낸 시험의 재시험 기준(max_wrong)만 나중에 넣거나 바꾼다. 이미 제출된
    시도의 합격 여부는 그대로 둔다 — 그 시도를 볼 당시의 기준으로 이미 확정된
    결과라, 기준을 바꿨다고 지난 결과까지 소급해서 다시 매기지 않는다. 바뀐
    기준은 이 시점 이후 새로 제출하는 시도부터 적용된다."""
    _require_db()
    ref = DB.collection("test_assignments").document(assignment_id)
    snap = ref.get()
    if not snap.exists or snap.to_dict().get("teacher_id") != teacher_id:
        raise ValueError("시험을 찾을 수 없습니다.")
    word_count = len(snap.to_dict().get("vocab") or [])
    if max_wrong is not None:
        try:
            max_wrong = int(max_wrong)
        except (TypeError, ValueError):
            raise ValueError("허용 오답 수는 숫자여야 합니다.")
        if not (0 <= max_wrong <= word_count):
            raise ValueError(f"허용 오답 수는 0~{word_count} 사이여야 합니다.")
    ref.update({"max_wrong": max_wrong})
    return max_wrong


def list_assignments_for_class(teacher_id, class_id):
    _require_db()
    c_snap = DB.collection("classes").document(class_id).get()
    if not c_snap.exists or c_snap.to_dict().get("teacher_id") != teacher_id:
        raise ValueError("반을 찾을 수 없습니다.")
    rows = []
    for doc in DB.collection("test_assignments").where("class_id", "==", class_id).stream():
        d = doc.to_dict() or {}
        rows.append({
            "id": doc.id, "title": d.get("title", ""), "format": d.get("format"),
            "wordCount": len(d.get("vocab") or []), "createdAt": d.get("created_at", ""),
            "maxWrong": d.get("max_wrong"),
            # None이면 반 전체, 있으면 그 학생 한 명에게만 낸 시험
            "studentId": d.get("student_id"), "studentName": d.get("student_name"),
        })
    rows.sort(key=lambda r: r["createdAt"], reverse=True)
    return rows


def _build_student_questions(assignment_id, assignment, student_id, round):
    """학생에게 보여줄 문제(순서·방향·객관식 보기)를 결정적으로 만든다 — 저장 없이도
    같은 (시험,학생,회차) 조합이면 새로고침해도 항상 같은 문제가 나오고, 채점할 때도
    이 함수를 다시 불러 같은 정답과 대조한다.

    round를 시드에 넣는 이유 — 재시험(회차)마다 순서·방향·객관식 보기를 다시 섞어서,
    떨어진 회차의 '몇 번째 보기가 정답이었는지'를 외워 다음 회차를 통과하는 것을
    막는다. 문제마다 방향(영어→뜻 / 뜻→영어)을 무작위로 섞는다 — 오답 후보 풀도
    두 가지(뜻 풀·단어 풀)를 미리 만들어 두고, 그 문제의 방향에 맞는 풀에서만 뽑는다."""
    vocab = assignment.get("vocab") or []
    fmt = assignment.get("format", "saq")

    meaning_pool, seen_m = [], set()
    word_pool, seen_w = [], set()
    for item in vocab:
        if item["meaning"] not in seen_m:
            seen_m.add(item["meaning"])
            meaning_pool.append(item["meaning"])
        if item["word"] not in seen_w:
            seen_w.add(item["word"])
            word_pool.append(item["word"])

    order_rng = random.Random(f"{assignment_id}:{student_id}:{round}:order")
    order = list(range(len(vocab)))
    order_rng.shuffle(order)

    questions = []
    for idx in order:
        item = vocab[idx]
        q_rng = random.Random(f"{assignment_id}:{student_id}:{round}:{idx}")
        direction = "en2ko" if q_rng.random() < 0.5 else "ko2en"
        if direction == "en2ko":
            prompt, correct, pool = item["word"], item["meaning"], meaning_pool
        else:
            prompt, correct, pool = item["meaning"], item["word"], word_pool
        q = {"idx": idx, "direction": direction, "prompt": prompt}
        if fmt == "mcq":
            # 오답 4개 + 정답 1개 = 5지선다. 찍어서 맞힐 확률을 25%에서 20%로 낮춘다.
            # 단어장이 작아 후보가 모자라면 있는 만큼만 쓴다(보기가 3~4개로 줄 뿐 깨지지 않는다).
            candidates = [v for v in pool if v != correct]
            q_rng.shuffle(candidates)
            options = candidates[:4] + [correct]
            q_rng.shuffle(options)
            q["options"] = options
        questions.append(q)
    return questions


def _assignment_targets_student(assignment, student_id, student):
    """이 시험이 이 학생에게 배정된 것인지 — 반이 같아야 하고, 개별로 낸 시험
    (student_id가 있는 경우)이면 그 학생 본인이어야 한다. 반 전체로 낸 시험은
    student_id가 없어(None) 반만 같으면 누구에게나 열려 있다."""
    if student.get("class_id") != assignment.get("class_id"):
        return False
    target = assignment.get("student_id")
    return target is None or target == student_id


def _get_student_attempts(assignment_id, student_id):
    """이 시험에서 이 학생이 지금까지 본 회차들을 회차 순서대로 돌려준다."""
    _require_db()
    rows = [
        (doc.to_dict() or {})
        for doc in DB.collection("test_attempts")
        .where("assignment_id", "==", assignment_id)
        .where("student_id", "==", student_id)
        .stream()
    ]
    rows.sort(key=lambda d: d.get("round", 1))
    return rows


def _attempt_progress(assignment, attempts):
    """max_wrong 기준으로 지금까지의 시도를 훑어 (합격 여부, 합격한 회차, 다음에 볼
    회차)를 계산한다. max_wrong이 없으면(재시험 없는 시험) 1회 제출로 항상 '합격'
    취급 — 예전(회차 개념 없던 시절) 동작과 같다."""
    max_wrong = assignment.get("max_wrong")
    passed_round = None
    for a in attempts:
        if a.get("passed") or (max_wrong is None and a.get("round", 1) == 1):
            passed_round = a.get("round", 1)
            break
    next_round = (attempts[-1].get("round", 1) + 1) if attempts else 1
    return {
        "passed": passed_round is not None,
        "passedRound": passed_round,
        "nextRound": next_round,
    }


def get_test_detail_for_student(student_id, assignment_id):
    _require_db()
    s_snap = DB.collection("students").document(student_id).get()
    if not s_snap.exists:
        raise ValueError("학생 정보를 찾을 수 없습니다.")
    a_snap = DB.collection("test_assignments").document(assignment_id).get()
    if not a_snap.exists:
        raise ValueError("시험을 찾을 수 없습니다.")
    assignment = a_snap.to_dict()
    if not _assignment_targets_student(assignment, student_id, s_snap.to_dict()):
        raise ValueError("이 시험은 이 학생에게 배정되지 않았습니다.")
    attempts = _get_student_attempts(assignment_id, student_id)
    progress = _attempt_progress(assignment, attempts)
    if progress["passed"]:
        raise ValueError("이미 합격한 시험입니다.")
    round = progress["nextRound"]
    questions = _build_student_questions(assignment_id, assignment, student_id, round)
    return {
        "title": assignment.get("title", ""),
        "round": round,
        "format": assignment.get("format"),
        # idx·정답 값은 빼고 화면에 보여줄 것만 내보낸다(방향은 어느 언어로 답할지
        # 알아야 하니 내보낸다)
        "questions": [
            {"prompt": q["prompt"], "direction": q["direction"], "options": q.get("options")}
            for q in questions
        ],
    }


def get_test_vocab_for_student(student_id, assignment_id):
    """학생이 시험 보기 전(또는 합격한 뒤에도) 원본 단어 목록을 그대로 보고 외울 수
    있게 돌려준다. 문제(get_test_detail_for_student)와 달리 오답 선택지·순서 섞기가
    필요 없는 학습용이라, 이미 합격한 시험도 계속 열람할 수 있게 막지 않는다."""
    _require_db()
    s_snap = DB.collection("students").document(student_id).get()
    if not s_snap.exists:
        raise ValueError("학생 정보를 찾을 수 없습니다.")
    a_snap = DB.collection("test_assignments").document(assignment_id).get()
    if not a_snap.exists:
        raise ValueError("시험을 찾을 수 없습니다.")
    assignment = a_snap.to_dict()
    if not _assignment_targets_student(assignment, student_id, s_snap.to_dict()):
        raise ValueError("이 시험은 이 학생에게 배정되지 않았습니다.")
    vocab = assignment.get("vocab") or []
    return {
        "title": assignment.get("title", ""),
        "vocab": [{"word": v.get("word", ""), "meaning": v.get("meaning", "")} for v in vocab],
    }


def list_tests_for_student(student_id):
    _require_db()
    s_snap = DB.collection("students").document(student_id).get()
    if not s_snap.exists:
        raise ValueError("학생 정보를 찾을 수 없습니다.")
    class_id = s_snap.to_dict().get("class_id")
    rows = []
    for doc in DB.collection("test_assignments").where("class_id", "==", class_id).stream():
        d = doc.to_dict() or {}
        # 반 전체로 낸 시험(student_id 없음)과 이 학생 개인에게 낸 시험만 보여준다 —
        # 같은 반의 다른 학생 한 명에게만 낸 시험은 여기서 걸러진다.
        target = d.get("student_id")
        if target is not None and target != student_id:
            continue
        attempts = _get_student_attempts(doc.id, student_id)
        progress = _attempt_progress(d, attempts)
        last = attempts[-1] if attempts else None
        rows.append({
            "id": doc.id, "title": d.get("title", ""), "format": d.get("format"),
            "wordCount": len(d.get("vocab") or []), "createdAt": d.get("created_at", ""),
            "maxWrong": d.get("max_wrong"),
            "submitted": bool(attempts),
            "passed": progress["passed"], "passedRound": progress["passedRound"],
            "attemptCount": len(attempts),
            "score": last.get("score") if last else None,
            "total": last.get("total") if last else None,
        })
    rows.sort(key=lambda r: r["createdAt"], reverse=True)
    return rows


def grade_and_submit_attempt(assignment_id, student_id, answers):
    """이미 합격한 시험이면 다시 채점하지 않고 그 결과를 그대로 돌려준다. 아직이면
    다음 회차로 채점해 새 시도 기록을 남긴다 — 문서 ID를
    f"{assignment_id}_{student_id}_{round}"로 고정하고 create()의 존재 확인을
    '그 회차는 1회만 제출'하는 잠금으로 쓴다(경쟁 상태 걱정이 없다)."""
    _require_db()
    a_snap = DB.collection("test_assignments").document(assignment_id).get()
    if not a_snap.exists:
        raise ValueError("시험을 찾을 수 없습니다.")
    assignment = a_snap.to_dict()
    s_snap = DB.collection("students").document(student_id).get()
    if not s_snap.exists:
        raise ValueError("학생 정보를 찾을 수 없습니다.")
    student = s_snap.to_dict()
    if not _assignment_targets_student(assignment, student_id, student):
        raise ValueError("이 시험은 이 학생에게 배정되지 않았습니다.")

    attempts = _get_student_attempts(assignment_id, student_id)
    progress = _attempt_progress(assignment, attempts)
    if progress["passed"]:
        last = attempts[-1]
        return {
            "score": last.get("score", 0), "total": last.get("total", 0),
            "wrong": last.get("wrong", 0), "passed": True, "round": last.get("round", 1),
        }
    round = progress["nextRound"]

    vocab = assignment.get("vocab") or []
    fmt = assignment.get("format", "saq")
    max_wrong = assignment.get("max_wrong")
    questions = _build_student_questions(assignment_id, assignment, student_id, round)

    score = 0
    for i, q in enumerate(questions):
        item = vocab[q["idx"]]
        direction = q["direction"]
        given = _norm_text(answers[i] if i < len(answers or []) else "")
        if fmt == "mcq":
            correct = item["meaning"] if direction == "en2ko" else item["word"]
            ok = given == correct
        elif direction == "en2ko":
            accepted = {_answer_key(v) for v in _meaning_variants(item["meaning"])}
            ok = _answer_key(given) in accepted
        else:
            # 유의어도 'custom, routine'처럼 여러 개가 한 칸에 적히므로 같이 쪼갠다
            accepted = {_answer_key(v) for v in _meaning_variants(item["word"])}
            if item.get("synonym"):
                accepted |= {_answer_key(v) for v in _meaning_variants(item["synonym"])}
            ok = _answer_key(given) in accepted
        if ok:
            score += 1

    total = len(questions)
    wrong = total - score
    passed = (max_wrong is None) or (wrong <= max_wrong)
    row = {
        "assignment_id": assignment_id, "student_id": student_id, "round": round,
        "teacher_id": assignment.get("teacher_id"), "student_name": student.get("name", ""),
        "answers": list(answers or []), "score": score, "total": total,
        "wrong": wrong, "passed": passed, "submitted_at": _now_iso(),
    }
    attempt_ref = DB.collection("test_attempts").document(f"{assignment_id}_{student_id}_{round}")
    try:
        attempt_ref.create(row)
    except Exception:
        d = attempt_ref.get().to_dict() or {}
        return {
            "score": d.get("score", 0), "total": d.get("total", 0),
            "wrong": d.get("wrong", 0), "passed": d.get("passed", True),
            "round": d.get("round", round),
        }
    return {"score": score, "total": total, "wrong": wrong, "passed": passed, "round": round}


def list_attempts_for_assignment(teacher_id, assignment_id):
    """반 전체(또는 개별) 시험의 학생별 회차 기록 — 회차별 점수를 다 보여주고,
    몇 회차에 합격했는지도 함께 계산한다."""
    _require_db()
    a_snap = DB.collection("test_assignments").document(assignment_id).get()
    if not a_snap.exists or a_snap.to_dict().get("teacher_id") != teacher_id:
        raise ValueError("시험을 찾을 수 없습니다.")
    assignment = a_snap.to_dict()
    by_student = {}
    for doc in DB.collection("test_attempts").where("assignment_id", "==", assignment_id).stream():
        d = doc.to_dict() or {}
        sid = d.get("student_id")
        by_student.setdefault(sid, {"studentId": sid, "studentName": d.get("student_name", ""), "rounds": []})
        by_student[sid]["rounds"].append({
            "round": d.get("round", 1), "score": d.get("score", 0), "total": d.get("total", 0),
            "wrong": d.get("wrong", 0), "passed": d.get("passed", True),
            "submittedAt": d.get("submitted_at", ""),
        })
    rows = []
    for entry in by_student.values():
        entry["rounds"].sort(key=lambda r: r["round"])
        progress = _attempt_progress(assignment, entry["rounds"])
        entry["passed"] = progress["passed"]
        entry["passedRound"] = progress["passedRound"]
        rows.append(entry)
    rows.sort(key=lambda r: (r["rounds"][0]["submittedAt"] if r["rounds"] else ""))
    return rows


def delete_assignment(teacher_id, assignment_id):
    """시험(및 학생들이 이미 낸 답안)을 통째로 지운다. delete_student와 같은 모양 —
    소유권을 확인하고, 딸린 문서(test_attempts)부터 지운 뒤 본체를 지운다."""
    _require_db()
    ref = DB.collection("test_assignments").document(assignment_id)
    snap = ref.get()
    if not snap.exists or snap.to_dict().get("teacher_id") != teacher_id:
        raise ValueError("시험을 찾을 수 없습니다.")
    for doc in DB.collection("test_attempts").where("assignment_id", "==", assignment_id).stream():
        doc.reference.delete()
    ref.delete()


class Handler(BaseHTTPRequestHandler):
    server_version = "PassageAnalyzer/1.0"

    def log_message(self, fmt, *args):
        sys.stderr.write("%s - %s\n" % (self.address_string(), fmt % args))

    def _send_json(self, obj, status=200, cookies=None, headers=None):
        data = json.dumps(obj, ensure_ascii=False).encode("utf-8")
        self.send_response(status)
        self.send_header("content-type", "application/json; charset=utf-8")
        self.send_header("content-length", str(len(data)))
        # API 응답은 어디에도 쌓아 두지 않는다.
        # 잔액·회원 목록·이용 내역은 초 단위로 바뀌는 값인데, 지금까지 캐시 지시자도
        # 검증자(ETag·Last-Modified)도 없이 내보내고 있었다. 그런 응답은 브라우저가
        # 대개 캐시하지 않지만 '대개'일 뿐이고, 앞단 프록시(배포 플랫폼·학교망)가 끼면
        # 낡은 값이 되돌아올 수 있다. 한 줄로 그 여지를 없앤다.
        self.send_header("Cache-Control", "no-store")
        self.send_header("Pragma", "no-cache")   # 옛 프록시용
        for c in cookies or ():
            self.send_header("Set-Cookie", c)
        for k, v in (headers or {}).items():
            self.send_header(k, str(v))
        self.end_headers()
        self.wfile.write(data)

    def _session_cookie(self, token):
        """Max-Age를 일부러 붙이지 않는다 — 브라우저를 닫으면 함께 사라지는 쿠키가 된다.

        학원 공용 PC를 여럿이 번갈아 쓰는 자리라, 앞사람 로그인이 남아 있으면 뒷사람이
        그 계정으로 자료를 만들어 앞사람 잔액을 쓰게 된다. 화면 쪽도 같은 이유로 창을
        열 때마다 localStorage를 비우고 있는데(app.js 맨 위), 로그인만 30일씩 남아 있어
        취지가 반쪽이었다.

        서버에 남는 세션 기록은 SESSION_MAX_AGE까지 살아 있지만, 쿠키가 사라지면 그것을
        가리킬 방법이 없으므로 로그인은 끊긴다."""
        # Render 등 https 뒤에 있을 때만 Secure를 붙인다(로컬 http에서도 로그인이 되게).
        secure = "; Secure" if self.headers.get("X-Forwarded-Proto") == "https" else ""
        return f"session={token}; Path=/; HttpOnly; SameSite=Lax{secure}"

    def _cleared_session_cookie(self):
        secure = "; Secure" if self.headers.get("X-Forwarded-Proto") == "https" else ""
        return f"session=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0{secure}"

    def _admin_session_cookie(self, token, max_age):
        secure = "; Secure" if self.headers.get("X-Forwarded-Proto") == "https" else ""
        return f"admin_session={token}; Path=/; HttpOnly; SameSite=Lax; Max-Age={max_age}{secure}"

    def _cleared_admin_session_cookie(self):
        secure = "; Secure" if self.headers.get("X-Forwarded-Proto") == "https" else ""
        return f"admin_session=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0{secure}"

    def _student_session_cookie(self, token):
        secure = "; Secure" if self.headers.get("X-Forwarded-Proto") == "https" else ""
        return f"student_session={token}; Path=/; HttpOnly; SameSite=Lax; Max-Age={STUDENT_SESSION_MAX_AGE}{secure}"

    def _cleared_student_session_cookie(self):
        secure = "; Secure" if self.headers.get("X-Forwarded-Proto") == "https" else ""
        return f"student_session=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0{secure}"

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

        if path == "/api/pricing":
            # 비밀값이 아니다 — 화면이 '만들기' 누르기 전에 예상 비용을 보여주는 데 쓴다.
            # 로그인 여부와 무관하게 조회 가능(가격표일 뿐 실제 과금은 아니다).
            self._send_json({
                "analyze": PRICE_ANALYZE_KRW,
                # 지문 요약 인포그래픽 — 분석과 따로 부르므로 값도 따로 매긴다
                "infographic": PRICE_INFOGRAPHIC_KRW,
                "mcqPlain": PRICE_MCQ_PLAIN_KRW,
                "mcqTransform": PRICE_MCQ_TRANSFORM_KRW,
                "saq": PRICE_SAQ_KRW,
                "extraQuestion": PRICE_EXTRA_QUESTION_KRW,
                # 워크북은 고른 단계 수로 매긴다 — 화면이 같은 식으로 예상 비용을 계산한다
                "workbookStage": PRICE_WORKBOOK_STAGE_KRW,
                "workbookMax": PRICE_WORKBOOK_MAX_KRW,
                "reword": PRICE_REWORD_KRW,
                "ocr": PRICE_OCR_KRW,
                # 기출 유형 분석 — 기본 0원. 값이 붙어도 시험지 1벌당이지 쪽 수에 곱하지 않는다
                "examScan": PRICE_EXAMSCAN_KRW,
                # PDF에서 지문 꺼내기 — 규칙으로 나눌 때는 언제나 0원이고,
                # 'AI로 다시 시도'를 눌렀을 때만 이 값이 매겨진다
                "pdfSplit": PRICE_PDFSPLIT_KRW,
                # 단어장 탭 — 사진 인식은 매번, PDF는 규칙이 못 뽑아 AI로 다시 시도할 때만
                "vocabOcr": PRICE_VOCAB_OCR_KRW,
                "vocabPdf": PRICE_VOCAB_PDF_KRW,
            })
            return

        if path == "/api/me":
            user_id = _session_user(self)
            if not user_id:
                self._send_json({"loggedIn": False})
                return
            self._send_json(_account_payload(user_id))
            return

        if path == "/api/admin/me":
            self._send_json({"loggedIn": _admin_session_valid(self)})
            return

        if path == "/api/admin/users":
            if not _admin_session_valid(self):
                self._send_json({"error": "관리자 로그인이 필요합니다."}, 401)
                return
            try:
                # pending은 곁들이라, 실패해도 회원 목록까지 같이 죽이지는 않는다
                try:
                    pending = list_pending_signups()
                except Exception:
                    pending = []
                self._send_json({
                    "users": list_all_users(),
                    "pending": pending,
                    "mailReady": bool(SMTP_USER and SMTP_PASSWORD),
                })
            except Exception as e:
                self._send_json({"error": str(e)}, 500)
            return

        # 이용 내역 — 본인 것은 /api/usage, 관리자가 남의 것을 볼 때는 /api/admin/usage.
        # 세션 종류가 아예 달라서(회원 세션 / 관리자 세션) 경로를 나눈다.
        if path in ("/api/usage", "/api/admin/usage"):
            query = urllib.parse.parse_qs(self.path.split("?", 1)[1] if "?" in self.path else "")
            if path == "/api/usage":
                user_id = _session_user(self)
                if not user_id:
                    self._send_json({"error": "로그인이 필요합니다."}, 401)
                    return
            else:
                if not _admin_session_valid(self):
                    self._send_json({"error": "관리자 로그인이 필요합니다."}, 401)
                    return
                user_id = (query.get("userId") or [""])[0]
                if not user_id:
                    self._send_json({"error": "회원을 지정하세요."}, 400)
                    return
            before = (query.get("before") or [""])[0] or None
            try:
                rows = list_usage(user_id, limit=USAGE_PAGE_SIZE, before=before)
            except Exception as e:
                self._send_json({"error": f"이용 내역을 불러오지 못했습니다: {e}"}, 500)
                return
            # more: 한 쪽을 꽉 채웠으면 다음 쪽이 있을 수 있다는 뜻
            self._send_json({"items": rows, "more": len(rows) == USAGE_PAGE_SIZE})
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

        # --- 반 · 학생 · 단어시험 (선생님 쪽 GET) ---
        if path == "/api/classes":
            user_id = _session_user(self)
            if not user_id:
                self._send_json({"error": "로그인이 필요합니다."}, 401)
                return
            if not _classroom_approved(user_id):
                self._send_json({"error": "학생 등록 기능은 관리자 승인이 필요합니다."}, 403)
                return
            try:
                self._send_json({"classes": list_classes(user_id)})
            except Exception as e:
                self._send_json({"error": str(e)}, 500)
            return

        if path == "/api/students":
            user_id = _session_user(self)
            if not user_id:
                self._send_json({"error": "로그인이 필요합니다."}, 401)
                return
            # 소유권 검사(list_students 내부)만으로는 부족하다 — 승인이 취소된 뒤에도
            # 자기 반이면 그대로 통과한다. 신규 등록을 막는 세 곳(POST classes·
            # students·vocab-tests)과 같은 기준으로, 조회도 승인이 살아 있어야 한다.
            if not _classroom_approved(user_id):
                self._send_json({"error": "학생 등록 기능은 관리자 승인이 필요합니다."}, 403)
                return
            query = urllib.parse.parse_qs(self.path.split("?", 1)[1] if "?" in self.path else "")
            class_id = (query.get("classId") or [""])[0]
            if not class_id:
                self._send_json({"error": "반을 지정하세요."}, 400)
                return
            try:
                self._send_json({"students": list_students(user_id, class_id)})
            except ValueError as e:
                self._send_json({"error": str(e)}, 404)
            return

        if path == "/api/vocab-tests":
            user_id = _session_user(self)
            if not user_id:
                self._send_json({"error": "로그인이 필요합니다."}, 401)
                return
            if not _classroom_approved(user_id):
                self._send_json({"error": "학생 등록 기능은 관리자 승인이 필요합니다."}, 403)
                return
            query = urllib.parse.parse_qs(self.path.split("?", 1)[1] if "?" in self.path else "")
            class_id = (query.get("classId") or [""])[0]
            if not class_id:
                self._send_json({"error": "반을 지정하세요."}, 400)
                return
            try:
                self._send_json({"tests": list_assignments_for_class(user_id, class_id)})
            except ValueError as e:
                self._send_json({"error": str(e)}, 404)
            return

        if path == "/api/vocab-tests/results":
            user_id = _session_user(self)
            if not user_id:
                self._send_json({"error": "로그인이 필요합니다."}, 401)
                return
            if not _classroom_approved(user_id):
                self._send_json({"error": "학생 등록 기능은 관리자 승인이 필요합니다."}, 403)
                return
            query = urllib.parse.parse_qs(self.path.split("?", 1)[1] if "?" in self.path else "")
            assignment_id = (query.get("assignmentId") or [""])[0]
            if not assignment_id:
                self._send_json({"error": "시험을 지정하세요."}, 400)
                return
            try:
                self._send_json({"attempts": list_attempts_for_assignment(user_id, assignment_id)})
            except ValueError as e:
                self._send_json({"error": str(e)}, 404)
            return

        # --- 반 · 학생 · 단어시험 (학생 쪽 GET) ---
        if path == "/api/student/me":
            student_id = _student_session_user(self)
            if not student_id:
                self._send_json({"loggedIn": False})
                return
            snap = DB.collection("students").document(student_id).get() if DB else None
            if not snap or not snap.exists:
                self._send_json({"loggedIn": False})
                return
            self._send_json({"loggedIn": True, "name": snap.to_dict().get("name", "")})
            return

        if path == "/api/student/tests":
            student_id = _student_session_user(self)
            if not student_id:
                self._send_json({"error": "로그인이 필요합니다."}, 401)
                return
            try:
                self._send_json({"tests": list_tests_for_student(student_id)})
            except ValueError as e:
                self._send_json({"error": str(e)}, 404)
            return

        if path == "/api/student/tests/detail":
            student_id = _student_session_user(self)
            if not student_id:
                self._send_json({"error": "로그인이 필요합니다."}, 401)
                return
            query = urllib.parse.parse_qs(self.path.split("?", 1)[1] if "?" in self.path else "")
            assignment_id = (query.get("assignmentId") or [""])[0]
            if not assignment_id:
                self._send_json({"error": "시험을 지정하세요."}, 400)
                return
            try:
                self._send_json(get_test_detail_for_student(student_id, assignment_id))
            except ValueError as e:
                self._send_json({"error": str(e)}, 404)
            return

        if path == "/api/student/tests/vocab":
            student_id = _student_session_user(self)
            if not student_id:
                self._send_json({"error": "로그인이 필요합니다."}, 401)
                return
            query = urllib.parse.parse_qs(self.path.split("?", 1)[1] if "?" in self.path else "")
            assignment_id = (query.get("assignmentId") or [""])[0]
            if not assignment_id:
                self._send_json({"error": "시험을 지정하세요."}, 400)
                return
            try:
                self._send_json(get_test_vocab_for_student(student_id, assignment_id))
            except ValueError as e:
                self._send_json({"error": str(e)}, 404)
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
            body = body.replace(b"%%ASSET_V%%", _asset_version().encode("utf-8"))
        self.send_response(200)
        self.send_header("content-type", ctype)
        self.send_header("content-length", str(len(body)))
        # 앱을 이루는 세 파일은 캐시하지 않는다.
        # 여기에 아무 헤더도 안 붙이던 때는 브라우저가 제 나름의 기준으로 캐싱해서,
        #   로컬에서 - app.js를 고치고 새로고침해도 옛 코드가 돌아 '고쳤는데 안 바뀐다'가 되고
        #   배포에서 - 재배포 뒤 돌아온 사용자가 옛 JS로 새 API를 불러 엉뚱하게 실패했다.
        # 파일이름에 판(version)을 붙이는 방식이 정석이지만 빌드 도구가 없는 구조라,
        # 매번 받게 하는 쪽을 택한다(셋을 합쳐 200KB 남짓이라 감당할 수 있다).
        if target.suffix in (".html", ".js", ".css"):
            self.send_header("cache-control", "no-store, must-revalidate")
        else:
            # 그림·아이콘·폰트는 좀처럼 바뀌지 않으니 하루 동안 재사용하게 둔다
            self.send_header("cache-control", "public, max-age=86400")
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
        # keep-alive 연결에서는 같은 핸들러 인스턴스(=같은 스레드)가 요청을 여러 번
        # 처리할 수 있다 — 지난 요청의 흔적이 이번 요청으로 새어 들어오지 않도록
        # 요청마다 맨 먼저 초기화한다(안 하면 엉뚱한 사용자·가격이 새어 들어올 수 있다).
        self._auth_user_id = None
        self._pending_charge = 0
        self._pending_label = "사용"

        path = self.path.split("?", 1)[0]
        if path not in ("/api/analyze", "/api/models", "/api/quiz", "/api/workbook",
                        "/api/reword", "/api/ocr", "/api/examscan", "/api/pdfsplit",
                        "/api/infographic", "/api/docx", "/api/vocabocr", "/api/vocabpdf",
                        "/api/auth/google", "/api/auth/signup", "/api/auth/verify",
                        "/api/auth/login", "/api/logout", "/api/auth/delete",
                        "/api/account/recharge", "/api/account/recharge/confirm",
                        "/api/account/ack-update",
                        "/api/saved", "/api/saved/delete",
                        "/api/admin/login", "/api/admin/logout", "/api/admin/recharge",
                        "/api/admin/delete-user", "/api/admin/approve-classroom",
                        "/api/classes", "/api/classes/regenerate-code", "/api/students",
                        "/api/students/delete", "/api/vocab-tests", "/api/vocab-tests/delete",
                        "/api/vocab-tests/update",
                        "/api/student/login", "/api/student/logout", "/api/student/tests/submit"):
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
        # 그중 실제로 콘텐츠를 생성하는 여섯 개는 정찰 가격을 매겨 잔액도 미리 확인한다
        # (/api/models는 모델 목록만 조회할 뿐 요금이 없으므로 잔액 0이어도 된다).
        GENERATE_PATHS = ("/api/analyze", "/api/quiz", "/api/workbook",
                           "/api/reword", "/api/ocr", "/api/examscan", "/api/pdfsplit",
                           "/api/infographic", "/api/vocabocr", "/api/vocabpdf")
        # /api/docx는 AI를 부르지 않아 요금이 없다 — 로그인만 확인하고 정찰 가격은 매기지
        # 않는다(그래서 GENERATE_PATHS가 아니라 여기 따로 붙는다).
        if path in GENERATE_PATHS + ("/api/models", "/api/docx"):
            if DB is None:
                self._send_json(
                    {"error": "로그인 기능이 아직 설정되지 않았습니다 (관리자에게 문의하세요)."}, 503
                )
                return
            user_id = _session_user(self)
            if not user_id:
                self._send_json({"error": "로그인이 필요한 서비스입니다."}, 401)
                return
            self._auth_user_id = user_id
            if path in GENERATE_PATHS:
                # 이용 내역에 남길 항목 이름도 여기서 정한다 — 가격을 계산하는 자리가
                # 무엇을 몇 개 만드는지 아는 유일한 자리다. 지문 원문은 넣지 않는다.
                if path == "/api/analyze":
                    cost = PRICE_ANALYZE_KRW
                    self._pending_label = "지문 분석"
                elif path == "/api/infographic":
                    # 지문 1개에 그림 1장. 분석과 달리 한 번에 여러 장을 받지 않는다 —
                    # 1장에 8~12초가 걸려서 여러 장을 한 요청에 묶으면 프록시가 끊는다.
                    cost = PRICE_INFOGRAPHIC_KRW
                    self._pending_label = "요약 이미지"
                elif path == "/api/quiz":
                    quiz_items = parse_quiz_items(req.get("types"))
                    cost = _quiz_action_cost(quiz_items)
                    total_q = sum(n for _t, n in quiz_items)
                    self._pending_label = f"문제 제작 · {total_q}문항"
                elif path == "/api/workbook":
                    wb_stages = parse_workbook_stages(req.get("stages"))
                    cost = _workbook_cost(wb_stages)
                    self._pending_label = f"워크북 · {len(wb_stages)}단계"
                elif path == "/api/reword":
                    cost = PRICE_REWORD_KRW
                    self._pending_label = "지문 변형"
                elif path == "/api/examscan":
                    # 기본 0원 — 값을 매기지 않는 이유는 PRICE_EXAMSCAN_KRW 주석 참고.
                    # 관리자가 환경변수로 값을 매기면 그때부터 쪽 수와 무관하게 1벌당 이 값이다.
                    cost = PRICE_EXAMSCAN_KRW
                    pages = len(req.get("files") or ())
                    self._pending_label = f"기출 유형 분석 · {pages}쪽"
                elif path == "/api/pdfsplit":
                    # 규칙으로 나누는 길은 Gemini를 부르지 않으므로 언제나 0원이다.
                    # 'AI로 다시 시도'(ai=true)일 때만 값을 매긴다.
                    cost = PRICE_PDFSPLIT_KRW if req.get("ai") else 0
                    self._pending_label = "PDF에서 지문 꺼내기"
                elif path == "/api/vocabocr":
                    cost = PRICE_VOCAB_OCR_KRW
                    self._pending_label = "사진에서 단어장 인식"
                elif path == "/api/vocabpdf":
                    # PDF도 지문과 같은 원칙 — 규칙으로 뽑히면 0원, AI로 다시 시도할 때만 값을 매긴다.
                    cost = PRICE_VOCAB_PDF_KRW if req.get("ai") else 0
                    self._pending_label = "PDF에서 단어장 정리"
                else:  # /api/ocr
                    cost = PRICE_OCR_KRW
                    self._pending_label = "사진에서 지문 옮기기"
                remaining = get_user_krw(user_id)
                if remaining < cost:
                    self._send_json(
                        {
                            "error": f"잔액이 부족합니다 (필요 {cost:,}원 / 보유 {remaining:,}원). "
                                     "관리자에게 충전을 요청하세요.",
                            "code": "no_tokens",
                        },
                        402,
                    )
                    return
                self._pending_charge = cost

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
                _account_payload(sub),
                cookies=[self._session_cookie(token)],
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
            except MailNotConfigured as e:
                # 사용자 잘못이 아니다 — 서버가 아직 메일을 보낼 수 없는 상태다.
                self._send_json({"error": str(e), "code": "mail_off"}, 503)
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
            self._send_json(
                _account_payload(user_id),
                cookies=[self._session_cookie(token)],
            )
            return

        if path == "/api/auth/login":
            email = (req.get("email") or "").strip()
            password = req.get("password") or ""
            if not email or not password:
                self._send_json({"error": "이메일과 비밀번호를 입력하세요."}, 400)
                return
            try:
                user_id, _info = login_with_password(email, password)
                token = create_session(user_id)
            except ValueError as e:
                self._send_json({"error": str(e)}, 401)
                return
            except Exception as e:
                self._send_json({"error": f"로그인에 실패했습니다: {e}"}, 500)
                return
            self._send_json(
                _account_payload(user_id),
                cookies=[self._session_cookie(token)],
            )
            return

        if path == "/api/logout":
            token = _parse_cookies(self.headers.get("Cookie", "")).get("session")
            delete_session(token)
            self._send_json({"loggedIn": False}, cookies=[self._cleared_session_cookie()])
            return

        if path == "/api/auth/delete":
            if DB is None:
                self._send_json({"error": "로그인 기능이 아직 설정되지 않았습니다."}, 503)
                return
            token = _parse_cookies(self.headers.get("Cookie", "")).get("session")
            user_id = _session_user(self)
            if not user_id:
                self._send_json({"error": "로그인이 필요한 서비스입니다."}, 401)
                return
            try:
                delete_user_account(user_id)
            except Exception as e:
                self._send_json({"error": f"탈퇴 처리에 실패했습니다: {e}"}, 500)
                return
            delete_session(token)
            self._send_json({"loggedIn": False}, cookies=[self._cleared_session_cookie()])
            return

        if path == "/api/account/recharge":
            # 결제창을 열기 위한 '결제 요청 생성'. 여기서는 포인트를 주지 않는다 —
            # 결제창이 끝난 뒤 /api/account/recharge/confirm이 포트원 서버에 직접
            # 확인하고 나서야 지급한다(confirm_payment_intent 참고).
            if DB is None:
                self._send_json({"error": "로그인 기능이 아직 설정되지 않았습니다."}, 503)
                return
            user_id = _session_user(self)
            if not user_id:
                self._send_json({"error": "로그인이 필요한 서비스입니다."}, 401)
                return
            try:
                amount = int(req.get("amount"))
            except (TypeError, ValueError):
                self._send_json({"error": "충전 금액이 올바르지 않습니다."}, 400)
                return
            if amount <= 0 or amount > 10_000_000:
                self._send_json({"error": "충전 금액이 올바르지 않습니다."}, 400)
                return
            if not (PORTONE_STORE_ID and PORTONE_CHANNEL_KEY_CARD and PORTONE_API_SECRET):
                self._send_json({"error": "결제 기능이 아직 설정되지 않았습니다."}, 503)
                return
            payment_id = create_payment_intent(user_id, amount)
            self._send_json({
                "paymentId": payment_id,
                "storeId": PORTONE_STORE_ID,
                "channelKey": PORTONE_CHANNEL_KEY_CARD,
                "amount": amount,
                "orderName": f"English Lab 포인트 충전 {amount:,}원",
            })
            return

        if path == "/api/account/recharge/confirm":
            # 결제창이 끝난 뒤 부른다 — 실제 지급은 여기, confirm_payment_intent 안에서
            # 포트원 서버에 직접 확인한 뒤에만 이뤄진다.
            if DB is None:
                self._send_json({"error": "로그인 기능이 아직 설정되지 않았습니다."}, 503)
                return
            user_id = _session_user(self)
            if not user_id:
                self._send_json({"error": "로그인이 필요한 서비스입니다."}, 401)
                return
            payment_id = (req.get("paymentId") or "").strip()
            if not payment_id:
                self._send_json({"error": "결제 정보가 올바르지 않습니다."}, 400)
                return
            try:
                new_krw = confirm_payment_intent(user_id, payment_id)
            except ValueError as e:
                self._send_json({"error": str(e)}, 400)
                return
            self._send_json({"krwRemaining": new_krw})
            return

        # '업데이트 소식' 플로팅 창을 닫을 때 부른다. 지금 CHANGELOG의 맨 앞(최신) 번호로
        # last_seen_changelog를 맞춰 두면, 이 계정은 그 번호까지는 봤다고 다음 로그인부터
        # 간주된다 — 다른 기기로 로그인해도 다시 뜨지 않는다(세션이 아니라 계정에 남기 때문).
        if path == "/api/account/ack-update":
            if DB is None:
                self._send_json({"error": "로그인 기능이 아직 설정되지 않았습니다."}, 503)
                return
            user_id = _session_user(self)
            if not user_id:
                self._send_json({"error": "로그인이 필요한 서비스입니다."}, 401)
                return
            if CHANGELOG:
                DB.collection("users").document(user_id).set(
                    {"last_seen_changelog": CHANGELOG[0]["version"]}, merge=True
                )
            self._send_json({"ok": True})
            return

        if path == "/api/admin/login":
            ip = _client_ip(self)
            if _admin_login_blocked(ip):
                self._send_json(
                    {"error": f"로그인 시도가 너무 많습니다. {ADMIN_LOGIN_WINDOW // 60}분 뒤 다시 시도하세요."},
                    429,
                )
                return
            username = (req.get("username") or "").strip()
            password = req.get("password") or ""
            try:
                verify_admin_password(username, password)
            except ValueError as e:
                _admin_login_record_fail(ip)
                self._send_json({"error": str(e)}, 401)
                return
            _admin_login_clear(ip)
            try:
                token = create_admin_session()
            except Exception as e:
                self._send_json({"error": f"로그인에 실패했습니다: {e}"}, 500)
                return
            self._send_json(
                {"loggedIn": True},
                cookies=[self._admin_session_cookie(token, ADMIN_SESSION_MAX_AGE)],
            )
            return

        if path == "/api/admin/logout":
            token = _parse_cookies(self.headers.get("Cookie", "")).get("admin_session")
            delete_admin_session(token)
            self._send_json({"loggedIn": False}, cookies=[self._cleared_admin_session_cookie()])
            return

        if path == "/api/admin/recharge":
            if not _admin_session_valid(self):
                self._send_json({"error": "관리자 로그인이 필요합니다."}, 401)
                return
            user_id = req.get("userId") or ""
            try:
                amount = int(req.get("amount"))
            except (TypeError, ValueError):
                self._send_json({"error": "충전량은 정수여야 합니다."}, 400)
                return
            if not user_id or amount == 0:
                self._send_json({"error": "회원과 충전량을 지정하세요."}, 400)
                return
            # 기본은 무상 지급 — 결제사가 붙기 전까지 관리자 충전은 돈을 받지 않은
            # 지급이다. 실제로 입금을 확인하고 넣어 주는 경우에만 kind="charge".
            kind = "charge" if req.get("kind") == "charge" else "grant"
            try:
                new_balance = recharge_user_krw(user_id, amount, kind)
            except ValueError as e:
                self._send_json({"error": str(e)}, 404)
                return
            except Exception as e:
                self._send_json({"error": f"충전에 실패했습니다: {e}"}, 500)
                return
            self._send_json({"krwRemaining": new_balance})
            return

        # 관리자가 회원을 강제로 내보낸다. 되돌릴 수 없다 — 계정·저장 자료·이용 내역·
        # 잔액이 함께 사라진다. 그래서 대상 이메일을 함께 받아 서버가 한 번 더 대조한다.
        # 화면의 확인 창만 믿지 않는 이유: 목록이 낡아 있으면(그 사이 다른 창에서 지우고
        # 새로 가입했다면) 같은 자리에 다른 사람이 앉아 있을 수 있다. 그때는 지우지 않고
        # 409로 돌려보내 목록을 다시 받게 한다.
        if path == "/api/admin/delete-user":
            if not _admin_session_valid(self):
                self._send_json({"error": "관리자 로그인이 필요합니다."}, 401)
                return
            if DB is None:
                self._send_json({"error": "로그인 기능이 아직 설정되지 않았습니다."}, 503)
                return
            user_id = (req.get("userId") or "").strip()
            confirm_email = (req.get("email") or "").strip().lower()
            if not user_id or not confirm_email:
                self._send_json({"error": "회원과 이메일을 지정하세요."}, 400)
                return
            try:
                snap = DB.collection("users").document(user_id).get()
            except Exception as e:
                self._send_json({"error": f"회원을 조회하지 못했습니다: {e}"}, 500)
                return
            if not snap.exists:
                self._send_json({"error": "이미 없는 회원입니다. 목록을 새로 고쳐 주세요."}, 404)
                return
            actual = ((snap.to_dict() or {}).get("email") or "").strip().lower()
            if actual != confirm_email:
                self._send_json({
                    "error": "화면의 회원 정보가 서버와 다릅니다. 목록을 새로 고친 뒤 "
                             "다시 확인해 주세요.",
                }, 409)
                return
            try:
                delete_user_account(user_id, by_admin=True)
            except Exception as e:
                self._send_json({"error": f"탈퇴 처리에 실패했습니다: {e}"}, 500)
                return
            print(f"[관리자] 회원 강제 탈퇴: {actual}", flush=True)
            self._send_json({"deleted": True, "email": actual})
            return

        if path == "/api/admin/approve-classroom":
            if not _admin_session_valid(self):
                self._send_json({"error": "관리자 로그인이 필요합니다."}, 401)
                return
            user_id = (req.get("userId") or "").strip()
            if not user_id:
                self._send_json({"error": "회원을 지정하세요."}, 400)
                return
            try:
                set_classroom_approved(user_id, bool(req.get("approved")))
            except ValueError as e:
                self._send_json({"error": str(e)}, 404)
                return
            self._send_json({"ok": True})
            return

        # --- 반 · 학생 · 단어시험 (선생님 쪽 POST) ---
        if path == "/api/classes":
            user_id = _session_user(self)
            if not user_id:
                self._send_json({"error": "로그인이 필요합니다."}, 401)
                return
            if not _classroom_approved(user_id):
                self._send_json({"error": "학생 등록 기능은 관리자 승인이 필요합니다."}, 403)
                return
            try:
                result = create_class(user_id, req.get("name"))
            except ValueError as e:
                self._send_json({"error": str(e)}, 400)
                return
            self._send_json(result)
            return

        if path == "/api/classes/regenerate-code":
            user_id = _session_user(self)
            if not user_id:
                self._send_json({"error": "로그인이 필요합니다."}, 401)
                return
            if not _classroom_approved(user_id):
                self._send_json({"error": "학생 등록 기능은 관리자 승인이 필요합니다."}, 403)
                return
            try:
                code = regenerate_class_code(user_id, req.get("classId"))
            except ValueError as e:
                self._send_json({"error": str(e)}, 404)
                return
            self._send_json({"code": code})
            return

        if path == "/api/students":
            user_id = _session_user(self)
            if not user_id:
                self._send_json({"error": "로그인이 필요합니다."}, 401)
                return
            if not _classroom_approved(user_id):
                self._send_json({"error": "학생 등록 기능은 관리자 승인이 필요합니다."}, 403)
                return
            try:
                result = create_student(user_id, req.get("classId"), req.get("name"))
            except ValueError as e:
                self._send_json({"error": str(e)}, 400)
                return
            self._send_json(result)
            return

        if path == "/api/students/delete":
            user_id = _session_user(self)
            if not user_id:
                self._send_json({"error": "로그인이 필요합니다."}, 401)
                return
            # 삭제는 데이터를 줄이는 방향이라 막지 않는 쪽도 생각해 봤지만, 승인이
            # 취소된 계정이 학생 기록을 손댈 수 있는 길을 하나라도 열어 두면 그 자체가
            # 위험이다(예: 문제가 있어 승인을 취소했는데 그 계정이 증거가 될 기록을
            # 지울 수 있다). 나머지 넷과 같은 기준으로 막는다.
            if not _classroom_approved(user_id):
                self._send_json({"error": "학생 등록 기능은 관리자 승인이 필요합니다."}, 403)
                return
            try:
                delete_student(user_id, req.get("studentId"))
            except ValueError as e:
                self._send_json({"error": str(e)}, 404)
                return
            self._send_json({"deleted": True})
            return

        if path == "/api/vocab-tests":
            user_id = _session_user(self)
            if not user_id:
                self._send_json({"error": "로그인이 필요합니다."}, 401)
                return
            if not _classroom_approved(user_id):
                self._send_json({"error": "학생 등록 기능은 관리자 승인이 필요합니다."}, 403)
                return
            try:
                assignment_id = create_test_assignment(
                    user_id, req.get("classId"), req.get("title"),
                    req.get("vocab"), req.get("format"),
                    student_id=(req.get("studentId") or None),
                    max_wrong=req.get("maxWrong"),
                )
            except ValueError as e:
                self._send_json({"error": str(e)}, 400)
                return
            self._send_json({"assignmentId": assignment_id})
            return

        if path == "/api/vocab-tests/delete":
            user_id = _session_user(self)
            if not user_id:
                self._send_json({"error": "로그인이 필요합니다."}, 401)
                return
            # 학생 삭제와 같은 이유로 승인 여부를 다시 확인한다 — 이미 낸 시험과
            # 학생들이 제출한 답안까지 함께 지우는 동작이라 소유권만으로는 부족하다.
            if not _classroom_approved(user_id):
                self._send_json({"error": "학생 등록 기능은 관리자 승인이 필요합니다."}, 403)
                return
            try:
                delete_assignment(user_id, req.get("assignmentId"))
            except ValueError as e:
                self._send_json({"error": str(e)}, 404)
                return
            self._send_json({"deleted": True})
            return

        if path == "/api/vocab-tests/update":
            user_id = _session_user(self)
            if not user_id:
                self._send_json({"error": "로그인이 필요합니다."}, 401)
                return
            if not _classroom_approved(user_id):
                self._send_json({"error": "학생 등록 기능은 관리자 승인이 필요합니다."}, 403)
                return
            try:
                max_wrong = update_assignment_retest(
                    user_id, req.get("assignmentId"), req.get("maxWrong"),
                )
            except ValueError as e:
                self._send_json({"error": str(e)}, 400)
                return
            self._send_json({"maxWrong": max_wrong})
            return

        # --- 반 · 학생 · 단어시험 (학생 쪽 POST) ---
        if path == "/api/student/login":
            if DB is None:
                self._send_json({"error": "로그인 기능이 아직 설정되지 않았습니다."}, 503)
                return
            try:
                student_id, name = login_student(
                    req.get("name"), _client_ip(self),
                )
            except ValueError as e:
                self._send_json({"error": str(e)}, 401)
                return
            token = create_student_session(student_id)
            self._send_json({"loggedIn": True, "name": name},
                             cookies=[self._student_session_cookie(token)])
            return

        if path == "/api/student/logout":
            token = _parse_cookies(self.headers.get("Cookie", "")).get("student_session")
            delete_student_session(token)
            self._send_json({"loggedIn": False}, cookies=[self._cleared_student_session_cookie()])
            return

        if path == "/api/student/tests/submit":
            student_id = _student_session_user(self)
            if not student_id:
                self._send_json({"error": "로그인이 필요합니다."}, 401)
                return
            try:
                result = grade_and_submit_attempt(
                    req.get("assignmentId"), student_id, req.get("answers") or [],
                )
            except ValueError as e:
                self._send_json({"error": str(e)}, 400)
                return
            self._send_json(result)
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
            model = MODEL  # 워크북은 항상 Flash — 사용자가 모델을 고르지 않는다
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
            charge_krw(self._auth_user_id, self._pending_charge, self._pending_label)
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
            model = MODEL  # OCR은 항상 Flash — 사용자가 모델을 고르지 않는다
            partial = bool(req.get("partial"))
            try:
                ocr_result = call_gemini_ocr(file, api_key, model, partial)
                charge_krw(self._auth_user_id, self._pending_charge, self._pending_label)
                self._send_json(ocr_result)
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

        # 단어장 탭 — 사진에서 단어 목록 인식.
        if path == "/api/vocabocr":
            file = req.get("file")
            if not isinstance(file, dict):
                self._send_json({"error": "올릴 사진을 선택하세요."}, 400)
                return
            api_key = req.get("apiKey") or ""
            model = MODEL  # 항상 Flash — 사용자가 모델을 고르지 않는다
            try:
                result = call_gemini_vocab_ocr(file, api_key, model)
                charge_krw(self._auth_user_id, self._pending_charge, self._pending_label)
                self._send_json(result)
            except NeedsPro as e:
                self._send_json({"error": str(e), "code": "needs_pro"}, 429)
            except ProUnavailable as e:
                self._send_json({"error": str(e), "code": "pro_unavailable"}, 429)
            except QuotaExceeded as e:
                self._send_json({"error": str(e), "code": "quota"}, 429)
            except Exception as e:
                self._send_json({"error": str(e)}, 502)
            return

        # 단어장 탭 — PDF에서 단어 목록 가져오기. 기본 경로는 Gemini를 부르지 않는다 —
        # 글자층을 그대로 꺼내 규칙으로 뽑는다(요금 0원, 오타 없음). 규칙이 못 뽑은
        # 파일만 화면이 ai=true로 다시 보내 정리를 맡긴다.
        if path == "/api/vocabpdf":
            file = req.get("file")
            if not isinstance(file, dict):
                self._send_json({"error": "올릴 PDF를 선택하세요."}, 400)
                return
            mime = (file.get("mime") or "").lower().split(";")[0].strip()
            data = file.get("data") or ""
            if mime != PDF_MIME:
                self._send_json({"error": "PDF 파일만 올릴 수 있습니다."}, 400)
                return
            if not data:
                self._send_json({"error": "PDF 내용이 비어 있습니다."}, 400)
                return
            if len(data) > MAX_FILE_BYTES:
                self._send_json({
                    "error": f"PDF가 너무 큽니다 (최대 {MAX_FILE_BYTES // 1048576}MB). "
                             "쪽을 나눠 올려 주세요."
                }, 413)
                return
            try:
                raw_pdf = base64.b64decode(data)
            except Exception:
                self._send_json({"error": "PDF를 읽지 못했습니다 (파일이 손상된 것 같습니다)."}, 400)
                return
            try:
                pages = read_pdf_pages(raw_pdf)
            except RuntimeError as e:
                self._send_json({"error": str(e)}, 400)
                return
            if not any(pages):
                self._send_json({
                    "error": "이 PDF에는 글자가 들어 있지 않습니다 (사진을 찍어 만든 스캔본). "
                             "쪽을 사진으로 저장해 '📷 사진으로 인식'으로 올려 주세요.",
                    "code": "no_text",
                }, 422)
                return
            if req.get("ai"):
                # 원문 줄을 그대로 이어 보낸다 — 본문을 옮겨 적는 게 아니라 이미 뽑힌
                # 글자의 순서만 다시 맞추는 일이라 이미지보다 훨씬 가볍다.
                text = "\n".join(r["t"] for page in pages for r in page)
                if len(text) > 60000:
                    text = text[:60000]
                try:
                    found = call_gemini_vocab_pdf(text, req.get("apiKey") or "", MODEL)
                except QuotaExceeded as e:
                    self._send_json({"error": str(e), "code": "quota"}, 429)
                    return
                except Exception as e:
                    self._send_json({"error": str(e)}, 502)
                    return
                charge_krw(self._auth_user_id, self._pending_charge, self._pending_label)
                self._send_json({"mode": "ai", "items": found["items"], "note": found["note"]})
                return
            items = parse_vocab_lines_rule(pages)
            self._send_json({
                "mode": "rule",
                "items": items,
                # 규칙으로 못 뽑았다 — 화면이 'AI로 다시 시도'를 권할 수 있게 알린다
                "canAi": not items,
                "note": "",
            })
            return

        # 만든 문제지를 워드로 내려준다. AI를 부르지 않으므로 요금도 대기도 없다.
        # 화면이 이미 그려 놓은 HTML을 그대로 보내온다 — 왜 데이터가 아니라 HTML인지는
        # quiz_html_to_docx 위의 주석 참고.
        if path == "/api/docx":
            source = req.get("html")
            if not isinstance(source, str) or not source.strip():
                self._send_json({"error": "내보낼 내용이 없습니다. 먼저 문제를 만들어 주세요."}, 400)
                return
            if len(source) > MAX_BODY_BYTES:
                self._send_json({"error": "내용이 너무 큽니다."}, 413)
                return
            title = str(req.get("title") or "문제지").strip()[:120]
            answer_heading = str(req.get("answerHeading") or "정답 및 해설").strip()[:60]
            filename = str(req.get("filename") or title or "문제지").strip()[:120]
            # 단 수는 화면이 정한다 — 워크북만 1단이고 나머지는 2단이다
            columns = 1 if req.get("columns") == 1 else 2
            try:
                blob = quiz_html_to_docx(source, title, answer_heading, columns)
            except Exception as e:
                traceback.print_exc()
                self._send_json({"error": f"워드 파일을 만들지 못했습니다: {e}"}, 500)
                return
            # 파일명에 한글이 들어가므로 RFC 5987로도 함께 적는다. filename= 쪽은 옛
            # 브라우저용이라 아스키만 남기고, 실제로 쓰이는 것은 filename*= 쪽이다.
            ascii_name = re.sub(r"[^A-Za-z0-9._-]", "_", filename) or "document"
            quoted = urllib.parse.quote(f"{filename}.docx")
            self.send_response(200)
            self.send_header(
                "content-type",
                "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
            )
            self.send_header(
                "content-disposition",
                f'attachment; filename="{ascii_name}.docx"; filename*=UTF-8\'\'{quoted}',
            )
            self.send_header("content-length", str(len(blob)))
            self.send_header("cache-control", "no-store")
            self.end_headers()
            self.wfile.write(blob)
            return

        # 지문 요약 인포그래픽. 지문 '하나'만 받는다 — 한 장에 8~12초가 걸려서 여러 장을
        # 한 요청에 묶으면 배포 프록시가 응답을 기다리다 끊는다. 여러 지문은 화면이
        # 한 장씩 차례로 부른다.
        if path == "/api/infographic":
            passage = req.get("passage")
            if not isinstance(passage, str) or not passage.strip():
                self._send_json({"error": "요약할 지문을 넣어 주세요."}, 400)
                return
            try:
                result = call_gemini_infographic(passage, req.get("apiKey") or "")
                charge_krw(self._auth_user_id, self._pending_charge, self._pending_label)
                self._send_json(result)
            except NeedsPro as e:
                self._send_json({"error": str(e), "code": "needs_pro"}, 429)
            except ProUnavailable as e:
                self._send_json({"error": str(e), "code": "pro_unavailable"}, 429)
            except QuotaExceeded as e:
                self._send_json({"error": str(e), "code": "quota"}, 429)
            except Exception as e:
                self._send_json({"error": str(e)}, 502)
            return

        # PDF에서 지문 꺼내기. 사진 OCR과 달리 기본 경로는 Gemini를 부르지 않는다 —
        # 글자층을 그대로 꺼내 규칙으로 나눈다(요금 0원, 오타 없음).
        # 규칙이 못 나눈 파일만 화면이 ai=true로 다시 보내 경계를 물어본다.
        if path == "/api/pdfsplit":
            file = req.get("file")
            if not isinstance(file, dict):
                self._send_json({"error": "올릴 PDF를 선택하세요."}, 400)
                return
            mime = (file.get("mime") or "").lower().split(";")[0].strip()
            data = file.get("data") or ""
            if mime != PDF_MIME:
                self._send_json({"error": "PDF 파일만 올릴 수 있습니다."}, 400)
                return
            if not data:
                self._send_json({"error": "PDF 내용이 비어 있습니다."}, 400)
                return
            if len(data) > MAX_FILE_BYTES:
                self._send_json({
                    "error": f"PDF가 너무 큽니다 (최대 {MAX_FILE_BYTES // 1048576}MB). "
                             "쪽을 나눠 올려 주세요."
                }, 413)
                return
            try:
                raw_pdf = base64.b64decode(data)
            except Exception:
                self._send_json({"error": "PDF를 읽지 못했습니다 (파일이 손상된 것 같습니다)."}, 400)
                return
            try:
                pages = read_pdf_pages(raw_pdf)
            except RuntimeError as e:
                self._send_json({"error": str(e)}, 400)
                return
            if not any(pages):
                # 스캔본(그림만 든 PDF)이다 — 여기서는 꺼낼 글자가 없다.
                # 사진 OCR로 가야 하므로 화면이 알아볼 수 있게 code를 붙인다.
                self._send_json({
                    "error": "이 PDF에는 글자가 들어 있지 않습니다 (사진을 찍어 만든 스캔본). "
                             "쪽을 사진으로 저장해 '📷 사진에서 가져오기'로 올려 주세요.",
                    "code": "no_text",
                }, 422)
                return
            if req.get("ai"):
                try:
                    found = call_gemini_pdf_split(pages, req.get("apiKey") or "", MODEL)
                except QuotaExceeded as e:
                    self._send_json({"error": str(e), "code": "quota"}, 429)
                    return
                except Exception as e:
                    self._send_json({"error": str(e)}, 502)
                    return
                if not found["passages"]:
                    self._send_json({
                        "error": found["note"] or "이 PDF에서 영어 지문을 찾지 못했습니다."
                    }, 422)
                    return
                charge_krw(self._auth_user_id, self._pending_charge, self._pending_label)
                self._send_json({"mode": "ai", "passages": found["passages"],
                                 "note": found["note"]})
                return
            split = split_pdf_passages(pages)
            self._send_json({
                "mode": split["mode"],
                "passages": split["passages"],
                # 규칙으로 못 나눴다 — 화면이 'AI로 다시 시도'를 권할 수 있게 알린다
                "canAi": not split["passages"],
                "note": "",
            })
            return

        if path == "/api/examscan":
            files = req.get("files")
            if not isinstance(files, list) or not files:
                self._send_json({"error": "분석할 시험지를 올려 주세요."}, 400)
                return
            if len(files) > EXAM_MAX_PAGES:
                self._send_json({
                    "error": f"한 번에 {EXAM_MAX_PAGES}쪽까지 분석할 수 있습니다 "
                             f"(올린 쪽 수 {len(files)}쪽). 나눠서 올려 주세요."
                }, 400)
                return
            api_key = req.get("apiKey") or ""
            # 유형 분석은 항상 Pro — 사용자가 모델을 고르지 않는다.
            # 스캔본이라 글자가 흐리고 쪽마다 방향이 다른데다, 여기서 한 번 잘못 읽으면
            # 이후 만드는 문제가 통째로 어긋난다. 시험지 1벌에 한 번만 부르는 호출이라
            # Pro를 써도 총원가가 크게 늘지 않는다.
            model = MODEL_PRO
            # 화면이 쪽을 나눠 여러 번 부를 때, 이번 묶음이 전체 중 몇 쪽째인지.
            # 한 번에 다 보내면 배포 프록시(약 100초)가 응답을 기다리다 끊어 버린다.
            try:
                page_from = max(0, int(req.get("pageFrom") or 0))
                page_total = max(0, int(req.get("pageTotal") or 0))
            except (TypeError, ValueError):
                page_from = page_total = 0
            try:
                scan = call_gemini_exam_scan(files, api_key, model, page_from, page_total)
                charge_krw(self._auth_user_id, self._pending_charge, self._pending_label)
                self._send_json(scan)
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
            # '5개 이상 변형'만 Pro — 사용자가 모델을 고르지 않고 서버가 자동으로 정한다.
            model = MODEL_PRO if variation == "heavy" else MODEL
            try:
                reworded = call_gemini_reword(passage, variation, api_key, model)
                charge_krw(self._auth_user_id, self._pending_charge, self._pending_label)
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
            items = parse_quiz_items(req.get("types"))
            if not items:
                self._send_json({"error": "출제 유형을 하나 이상 선택하세요."}, 400)
                return
            api_key = req.get("apiKey") or ""
            # 지문을 '변형하는' 유형이 하나라도 섞여 있으면 그 호출 전체를 Pro로 올린다.
            # 화면이 이미 이런 유형끼리, 저런 유형끼리 묶어서 보내므로(chunkTypes 참고)
            # 한 호출 안에서 실제로 섞이는 일은 드물다.
            #
            # 기준은 '지문을 건드리느냐'다. 주제·제목·요지·내용일치·OX진위는 지문을 그대로
            # 두고 보기만 만들어 Flash로 충분하다. 반면 빈칸·어휘·어법·순서·문장삽입과
            # 주관식의 선택형·오류찾기·배열은 지문 자체를 고쳐 문제를 만든다. 심어 놓은
            # 오류가 진짜 오류여야 하고 나머지는 완벽해야 하는데, 이것이 맞는지는 서버가
            # 기계로 검사할 수 없다(분석본과 달리 첫 출력이 곧 최종본이다).
            #
            # 예전에는 이 조건에 '객관식이면서'가 붙어 있어 주관식은 아무리 지문을 변형해도
            # Flash로 갔다. 어법 선택형·틀린 어법 찾기가 객관식 어법 문제와 같은 난이도인데
            # 모델만 낮았던 것이라, 조건에서 객관식 제한을 뺐다.
            model = MODEL_PRO if any(
                t not in QUIZ_PLAIN_PASSAGE_TYPES for t, _ in items
            ) else MODEL
            variation = req.get("variation") or "verbatim"
            # 목표 어법 — 어법 계열 유형이 섞여 있을 때만 프롬프트에 실린다
            # (판단은 build_quiz_user_prompt가 한다). 길이는 넉넉히 잘라 둔다.
            quiz_grammar = (req.get("targetGrammar") or "").strip()[:200]
            t0 = time.monotonic()
            try:
                result = call_gemini_quiz(passage, items, api_key, model, variation=variation,
                                          target_grammar=quiz_grammar)
                # 문항 누락 방어 — 요청한 개수보다 적게 오면 한 번 더 요청해 채운다
                want = sum(n for _, n in items)
                for _ in range(2):
                    got = len(result.get("questions", []))
                    if got >= want:
                        break
                    if _over_budget(t0):  # 프록시가 끊기 전에 현재 결과라도 돌려준다
                        break
                    # 어떤 유형이 몇 문항 모자랐는지 짚어 주면 재요청 한 번에 채워질
                    # 확률이 높다 (유형당 여러 문항이 가능하므로 개수까지 함께 알린다).
                    made = Counter(
                        q.get("type") for q in result.get("questions", []) if isinstance(q, dict)
                    )
                    missing = [f"{t} {n - made[t]}문항" for t, n in items if made[t] < n]
                    retry = call_gemini_quiz(
                        passage, items, api_key, model,
                        short_hint=(missing or got), variation=variation,
                        target_grammar=quiz_grammar
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
                        passage, items, api_key, model, explain_hint=missing, variation=variation,
                        target_grammar=quiz_grammar
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
            charge_krw(self._auth_user_id, self._pending_charge, self._pending_label)
            self._send_json(result)
            return

        passage = (req.get("passage") or "").strip()
        if len(passage) < 20:
            self._send_json({"error": "분석할 영어 지문을 입력하세요 (20자 이상)."}, 400)
            return
        target_grammar = req.get("targetGrammar") or ""
        mode = req.get("mode") or "teacher"
        api_key = req.get("apiKey") or ""
        model = MODEL  # 지문 분석은 항상 Flash — 사용자가 모델을 고르지 않는다

        t0 = time.monotonic()
        trace = RefineTrace(t0)
        try:
            result = call_gemini(passage, target_grammar, mode, api_key, model)
            trace.first_done()
            # 문장 누락 방어 — 실제 문장 수보다 분석이 많이 부족하면 자동 보정 재요청
            expected = rough_sentence_count(passage)
            for _ in range(2):
                got = len(result.get("sentences", []))
                if got >= expected - 2:  # 약어로 인한 과다추정 대비 허용오차
                    break
                if trace.blocked("문장"):  # 프록시가 끊기 전에 현재 결과라도 돌려준다
                    break
                trace.retry("문장")
                result = call_gemini(
                    passage, target_grammar, mode, api_key, model,
                    complete_hint=(expected, got),
                )
            # 영어 원문 누락 방어 — 영어가 빠진 chunk가 있으면 자동으로 다시 요청
            for _ in range(2):
                if not english_incomplete(result, passage):
                    break
                if trace.blocked("영어"):
                    break
                trace.retry("영어")
                result = call_gemini(
                    passage, target_grammar, mode, api_key, model, english_fix=True
                )
            # 등위접속사 누락 방어 — 모델이 가장 자주 빠뜨리는 항목이라, 서버가 직접
            # 세어 빠진 자리를 짚어 준 뒤 다시 요청한다. 더 많이 표시해 온 결과만 채택해
            # 재요청이 오히려 표시를 지우고 오는 경우를 막는다.
            for _ in range(2):
                missed = result.get("_conjMiss") or []
                if not missed:
                    break
                if trace.blocked("접속사"):
                    break
                retry, part = refine_analysis(
                    passage, target_grammar, mode, api_key, model, result,
                    conj_hint=missed,
                )
                trace.retry("접속사", part)
                better = (
                    len(retry.get("_conjMiss") or []) < len(missed)
                    # 접속사를 더 찾아왔더라도 문장이나 영어를 잃었으면 채택하지 않는다
                    and len(retry.get("sentences") or []) >= len(result.get("sentences") or [])
                    and not english_incomplete(retry, passage)
                )
                if not better:
                    break
                result = retry
            # 병렬 번호 방어 — 1 없이 2만 붙어 짝 없는 위첨자가 뜨는 것을 막는다.
            # 접속사 보강이 끝난 뒤에 검사한다(위 재요청이 번호를 새로 붙이기도 하므로).
            for _ in range(2):
                broken = result.get("_numBroken") or []
                if not broken:
                    break
                if trace.blocked("번호"):
                    break
                retry, part = refine_analysis(
                    passage, target_grammar, mode, api_key, model, result,
                    num_hint=broken,
                )
                trace.retry("번호", part)
                better = (
                    len(retry.get("_numBroken") or []) < len(broken)
                    # 번호를 고쳤더라도 문장·영어·접속사 표시를 잃었으면 채택하지 않는다
                    and len(retry.get("sentences") or []) >= len(result.get("sentences") or [])
                    and len(retry.get("_conjMiss") or []) <= len(result.get("_conjMiss") or [])
                    and not english_incomplete(retry, passage)
                )
                if not better:
                    break
                result = retry
            # 루비 설명 방어 — 보라(gv)에 뜻 대신 분류 이름을 적은 자리를 고쳐 오게 한다.
            for _ in range(2):
                bad = result.get("_rubyBad") or []
                if not bad:
                    break
                if trace.blocked("루비"):
                    break
                retry, part = refine_analysis(
                    passage, target_grammar, mode, api_key, model, result,
                    ruby_hint=bad,
                )
                trace.retry("루비", part)
                if _analysis_regressed(retry, result, passage):
                    break
                if len(retry.get("_rubyBad") or []) >= len(bad):
                    break
                result = retry
            # 좌우 용어 모순 방어 — 같은 단어를 왼쪽 루비와 오른쪽 해설이 다르게 부르는 것.
            # 루비를 고친 뒤에 검사한다(위 재요청이 rt를 바꾸므로).
            for _ in range(2):
                bad = result.get("_conflicts") or []
                if not bad:
                    break
                if trace.blocked("좌우"):
                    break
                retry, part = refine_analysis(
                    passage, target_grammar, mode, api_key, model, result,
                    conflict_hint=bad,
                )
                trace.retry("좌우", part)
                if _analysis_regressed(retry, result, passage):
                    break
                if len(retry.get("_conflicts") or []) >= len(bad):
                    break
                result = retry
            # 표시만 하고 설명은 빠진 자리 방어 — 빨강(어법)·보라(어법+어휘)로 칠해 놓고
            # 오른쪽 해설이 그 이야기를 하지 않으면 학생은 왜 색이 있는지 알 수 없다.
            # 맨 뒤에 두는 이유: 앞의 보정들이 표시와 해설을 모두 건드리므로, 다 끝난
            # 상태에서 세어야 헛일이 없다.
            for _ in range(2):
                bad = result.get("_noteMiss") or []
                if not bad:
                    break
                if trace.blocked("해설"):
                    break
                retry, part = refine_analysis(
                    passage, target_grammar, mode, api_key, model, result,
                    note_hint=bad,
                )
                trace.retry("해설", part)
                if _analysis_regressed(retry, result, passage):
                    break
                if len(retry.get("_noteMiss") or []) >= len(bad):
                    break
                result = retry
            # 비공개 키는 여기서 전부 턴다. _rawSents는 분석본을 통째로 한 벌 더 담고
            # 있어, 남겨 두면 화면으로 가는 응답이 두 배가 된다.
            result.pop("_rawSents", None)
            result.pop("_conjMiss", None)
            result.pop("_numBroken", None)
            result.pop("_rubyBad", None)
            result.pop("_conflicts", None)
            result.pop("_noteMiss", None)
        except ProUnavailable as e:
            trace.log(model, passage, error="pro_unavailable")
            self._send_json({"error": str(e), "code": "pro_unavailable"}, 429)
            return
        except QuotaExceeded as e:
            trace.log(model, passage, error="quota")
            self._send_json({"error": str(e), "code": "quota"}, 429)
            return
        except Exception as e:
            trace.log(model, passage, error=type(e).__name__)
            self._send_json({"error": str(e)}, 502)
            return
        trace.log(model, passage)
        charge_krw(self._auth_user_id, self._pending_charge, self._pending_label)
        self._send_json(result)


def main():
    if not PUBLIC_DIR.is_dir():
        sys.exit(f"public 디렉터리를 찾을 수 없습니다: {PUBLIC_DIR}")
    server = ThreadingHTTPServer((HOST, PORT), Handler)
    key_set = "설정됨" if os.environ.get("GEMINI_API_KEY") else "미설정 (AI 기능 전체가 막힘)"
    login_set = "설정됨" if DB is not None else "미설정 (로그인·AI 기능 전체가 막힘)"
    google_set = "설정됨" if GOOGLE_CLIENT_ID else "미설정 (구글 로그인 버튼 비활성)"
    smtp_set = "설정됨" if (SMTP_USER and SMTP_PASSWORD) else "미설정 (인증코드가 서버 로그에만 출력됨)"
    # 지금 '실제로' 적용된 설정을 값과 출처까지 한 줄로 남긴다. render.yaml에 적힌
    # 값이 서비스에 적용되지 않는 일이 반복돼(대시보드에서 만든 서비스는 그 파일을
    # 읽지 않는다), 파일만 보고 설정을 짐작하다 엉뚱한 진단을 하는 것을 막기 위해서다.
    # 배포 로그에서 '[설정]'로 찾으면 된다.
    def _src(name):
        return CONFIG_SOURCE.get(name, "기본값")

    print(
        "[설정] "
        f"보정예산 {REFINE_BUDGET:.0f}초({_src('REFINE_BUDGET')}) | "
        f"재시도상한 {MAX_RETRY_TOTAL:.0f}초({_src('MAX_RETRY_TOTAL')}) | "
        f"호출타임아웃 {GEMINI_TIMEOUT:.0f}초({_src('GEMINI_TIMEOUT')}) | "
        f"모델 {MODEL}({_src('GEMINI_MODEL')}) | "
        f"Pro {MODEL_PRO}({_src('GEMINI_MODEL_PRO')})",
        file=sys.stderr,
    )
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
