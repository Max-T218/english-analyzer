#!/usr/bin/env python3
"""유료 충전 회원의 월별 포인트 사용량을 집계한다 — 정액 요금제 가격을 정할 근거용. **읽기 전용**(쓰기·삭제 없음).

실행 (서버를 띄운 터미널과 같은 환경 — GOOGLE_APPLICATION_CREDENTIALS_JSON이 있어야 한다):
    $env:PYTHONUTF8 = "1"
    python tools/usage_report.py            # 요약만
    python tools/usage_report.py --detail   # 회원별 한 줄(회원 id 앞 6자리만 — 이메일·이름은 찍지 않는다)

세는 기준
- 유료 회원: point_ledger에 kind="charge"(유상 충전)가 한 줄이라도 있는 회원. 관리자가 넣은 '관리자 충전'도
  같은 kind라 섞일 수 있다 — label이 '관리자 충전'인 줄은 --skip-admin으로 뺀다.
- 사용량: 같은 회원의 kind="use" 줄(금액은 음수) 합. 월은 한국 시간.
- '활동 월'만 평균에 넣는다(그 달에 1P라도 쓴 달). 쓴 적 없는 달까지 넣으면 평균이 내려간다.
- 학생 수: students 컬렉션에서 teacher_id가 그 회원인 문서 수(지금 등록된 수).
- 토큰: usage_records(2026-11-06부터 쌓임)의 input/output/thought 합. 원가 환산은 하지 않는다.
"""
import argparse
import collections
import json
import os
import statistics
import sys
from datetime import datetime, timedelta, timezone

from google.cloud import firestore
from google.oauth2 import service_account

KST = timezone(timedelta(hours=9))


def client():
    raw = os.environ.get("GOOGLE_APPLICATION_CREDENTIALS_JSON")
    if raw:
        info = json.loads(raw)
        creds = service_account.Credentials.from_service_account_info(info)
        return firestore.Client(credentials=creds, project=info.get("project_id"))
    if os.environ.get("GOOGLE_APPLICATION_CREDENTIALS"):
        return firestore.Client()
    sys.exit("Firestore 열쇠가 없습니다 — GOOGLE_APPLICATION_CREDENTIALS_JSON을 확인하세요.")


def month_of(iso):
    try:
        return datetime.fromisoformat(iso).astimezone(KST).strftime("%Y-%m")
    except Exception:
        return None


def pct(values, p):
    if not values:
        return 0
    s = sorted(values)
    k = max(0, min(len(s) - 1, int(round((p / 100) * (len(s) - 1)))))
    return s[k]


def line(name, values):
    if not values:
        return f"{name:<22} (자료 없음)"
    return (f"{name:<22} 평균 {statistics.mean(values):>9,.0f} · 중앙값 {statistics.median(values):>9,.0f}"
            f" · 상위10% {pct(values, 90):>9,.0f} · 최대 {max(values):>9,.0f}")


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--detail", action="store_true", help="회원별 한 줄도 찍는다")
    ap.add_argument("--skip-admin", action="store_true", help="'관리자 충전' 줄은 유료 결제로 세지 않는다")
    args = ap.parse_args()
    db = client()

    # 1) 유료 회원 찾기
    paid = {}
    for doc in db.collection("point_ledger").where("kind", "==", "charge").stream():
        d = doc.to_dict() or {}
        if args.skip_admin and str(d.get("label", "")).startswith("관리자"):
            continue
        uid = d.get("user_id")
        if not uid:
            continue
        p = paid.setdefault(uid, {"charged": 0, "n": 0, "first": d.get("created_at", "")})
        p["charged"] += int(d.get("amount", 0))
        p["n"] += 1
        if d.get("created_at", "") and d.get("created_at", "") < p["first"]:
            p["first"] = d["created_at"]
    print(f"유료 충전 회원 {len(paid)}명\n")
    if not paid:
        return

    rows = []
    for uid, info in paid.items():
        months = collections.Counter()
        for doc in db.collection("point_ledger").where("user_id", "==", uid).where("kind", "==", "use").stream():
            d = doc.to_dict() or {}
            m = month_of(d.get("created_at", ""))
            if m:
                months[m] += -int(d.get("amount", 0))
        students = sum(1 for _ in db.collection("students").where("teacher_id", "==", uid).select([]).stream())
        tokens = collections.Counter()
        for doc in db.collection("usage_records").where("user_id", "==", uid).stream():
            d = doc.to_dict() or {}
            for k in ("input", "output", "thought", "image"):
                tokens[k] += int(d.get(k, 0) or 0)
        total = sum(months.values())
        rows.append({
            "uid": uid, "charged": info["charged"], "charges": info["n"],
            "months": dict(months), "active": len(months), "total": total,
            "avg": (total / len(months)) if months else 0,
            "peak": max(months.values()) if months else 0,
            "students": students, "tokens": dict(tokens),
        })

    users = [r for r in rows if r["active"]]
    print(f"그중 포인트를 쓴 적 있는 회원 {len(users)}명 (안 쓴 회원 {len(rows) - len(users)}명)\n")

    print("── 회원별 '활동 월 평균 사용 포인트' 분포 ──")
    print(line("월평균(회원마다)", [r["avg"] for r in users]))
    print(line("가장 많이 쓴 달(회원마다)", [r["peak"] for r in users]))
    print(line("누적 충전액", [r["charged"] for r in rows]))

    # 2) 달별 한 건 한 건 — 회원×월
    cells = [v for r in users for v in r["months"].values()]
    print("\n── 회원×월 하나하나(그 달 쓴 포인트) ──")
    print(line("회원×월", cells))
    for lo, hi in ((0, 5000), (5000, 15000), (15000, 30000), (30000, 60000), (60000, 10**9)):
        n = sum(1 for v in cells if lo <= v < hi)
        label = f"{lo:,}~{hi:,}P" if hi < 10**9 else f"{lo:,}P 이상"
        print(f"  {label:<18} {n:>4}건 ({n * 100 / len(cells):.0f}%)")

    # 3) 학생 수
    st = [r["students"] for r in rows]
    print("\n── 학생관리 ──")
    print(f"학생을 등록한 유료 회원 {sum(1 for v in st if v)}명 / {len(rows)}명")
    print(line("등록 학생 수(0 제외)", [v for v in st if v]))

    # 4) 토큰(2026-11-06 이후)
    tk = [sum(r["tokens"].get(k, 0) for k in ("input", "output", "thought")) for r in users]
    print("\n── 토큰(2026-11-06 이후 기록, input+output+thought) ──")
    print(line("회원별 합계", [v for v in tk if v]))

    if args.detail:
        print("\n── 회원별 ──")
        print(f"{'회원':<8}{'충전합':>10}{'활동월':>6}{'월평균P':>10}{'최대월P':>10}{'학생':>6}")
        for r in sorted(rows, key=lambda r: -r["avg"]):
            print(f"{r['uid'][:6]:<8}{r['charged']:>10,}{r['active']:>6}{r['avg']:>10,.0f}{r['peak']:>10,}{r['students']:>6}")


if __name__ == "__main__":
    main()
