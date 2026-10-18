"""모델 비교 — 같은 지문·같은 유형으로 call_gemini_quiz를 모델별로 돌려 토큰·원가·시간·품질 신호를 견준다.

server.py의 call_gemini_quiz를 그대로 불러 쓰므로 프롬프트·스키마·검사(_check_*)가 실서비스와 같다.
Firestore·잔액·로그인은 건드리지 않는다(Gemini만 부른다). 단 GEMINI_API_KEY 호출 요금은 실제로 나간다.

사용:
  $env:PYTHONUTF8 = "1"
  python tools/compare_models.py --passages my_passages.txt
  python tools/compare_models.py --passages my_passages.txt --types 빈칸,어법,순서 --difficulty hard --repeat 2

지문 파일: 지문 사이를 `===` 한 줄로 나눈다. 결과(문항 원문)는 --out 폴더에 저장하니 사람이 눈으로 확인할 것 —
아래 자동 지표는 '형식이 깨졌는가'만 잡고 '정답이 유일한가'는 못 가른다.

⚠️ server.py는 모델 이름에 "pro"가 들어 있는지로 분기한다(call_gemini_quiz의 thinkingLevel low, 지문 변형 heavy).
   gemini-4-argon에는 "pro"가 없어 기본 유형 호출에서 생각이 low로 눌린다. 그래서 --argon-thinking 기본값(default)은
   생각 설정을 빼고 부른다 — Pro와 같은 조건으로 견주기 위해서다. 서버에 올릴 때는 이 분기를 따로 고쳐야 한다.
"""
import argparse
import json
import os
import statistics
import sys
import time
from datetime import date
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))
import server  # noqa: E402  (main()은 __main__ 가드 안이라 서버가 뜨지 않는다)

# 100만 토큰당 USD (제3자 집계 기준 — 구글 가격 페이지로 다시 확인할 것). 생각 토큰은 출력 요금.
PRICES = {
    "flash": (0.75, 3.75),
    "pro": (2.00, 12.00),          # 프롬프트 20만 토큰 이하
    "argon": (2.00, 10.00),        # ~2026-11-30
    "argon-dec": (4.00, 20.00),    # 2026-12-01~
}


def price_key(model, argon_dec):
    m = model.lower()
    if "argon" in m:
        return "argon-dec" if argon_dec else "argon"
    return "pro" if "pro" in m else "flash"


def load_passages(paths):
    out = []
    for p in paths:
        text = Path(p).read_text(encoding="utf-8")
        for chunk in text.split("\n===\n"):
            chunk = chunk.strip()
            if chunk:
                out.append(chunk)
    return out


def quality_signals(result, items):
    """형식 수준 지표. 정답 유일성·해설 정확성은 사람이 봐야 한다."""
    qs = [q for q in (result or {}).get("questions", []) if isinstance(q, dict)]
    want = sum(n for _, n in items)
    bad_answer = no_expl = bad_choices = 0
    for q in qs:
        ch = q.get("choices") or []
        ans = q.get("answer")
        if ch:
            if len(ch) != 5:
                bad_choices += 1
            if not isinstance(ans, int) or not (1 <= ans <= len(ch)):
                bad_answer += 1
            elif len(set(map(str, ch))) != len(ch):
                bad_choices += 1
        if not str(q.get("explanation") or q.get("explainKo") or "").strip():
            no_expl += 1
    return {"got": len(qs), "want": want, "bad_answer": bad_answer,
            "bad_choices": bad_choices, "no_expl": no_expl}


def main():
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--passages", nargs="+", required=True, help="지문 파일(지문 사이는 === 한 줄)")
    ap.add_argument("--models", default="gemini-3.1-pro-preview,gemini-4-argon")
    ap.add_argument("--types", default="빈칸,어법,순서,문장삽입,함축의미,무관한 문장",
                    help="쉼표로 유형(1문항씩). QUIZ_TYPE_LABELS의 이름")
    ap.add_argument("--difficulty", default="normal", choices=["normal", "hard"])
    ap.add_argument("--variation", default="verbatim", help="verbatim|light|heavy 등 QUIZ_VARIATIONS")
    ap.add_argument("--repeat", type=int, default=1, help="같은 조건 반복 횟수(편차 보기)")
    ap.add_argument("--argon-thinking", default="default", choices=["default", "low"],
                    help="default=생각 설정 생략(Pro와 같은 조건), low=서버 기본 분기 그대로")
    ap.add_argument("--dec-price", action="store_true", help="Argon 12/1 이후 단가로 계산")
    ap.add_argument("--krw", type=float, default=1400.0, help="환율(원/USD)")
    ap.add_argument("--out", default="compare_out", help="문항 원문·요약 JSON을 저장할 폴더")
    ap.add_argument("--dry-run", action="store_true", help="호출 없이 계획만 출력")
    a = ap.parse_args()

    passages = load_passages(a.passages)
    models = [m.strip() for m in a.models.split(",") if m.strip()]
    items, skipped = server.fit_quiz_items([{"id": t.strip(), "count": 1} for t in a.types.split(",") if t.strip()],
                                           passages[0] if passages else "")
    print(f"지문 {len(passages)}개 · 모델 {models} · 유형 {items} · 난이도 {a.difficulty} · 반복 {a.repeat}")
    n_calls = len(passages) * len(models) * a.repeat
    print(f"호출 {n_calls}회 예정" + ("" if not skipped else f" (참고: 첫 지문에서 뺀 유형 있음: {skipped})"))
    if a.dry_run:
        return
    if not os.environ.get("GEMINI_API_KEY", "").strip():
        sys.exit("GEMINI_API_KEY가 없습니다. (환경변수에서 읽습니다 — 코드에 넣지 마세요)")

    # 호출마다 토큰·실제 응답 모델·호출 횟수(RECITATION 재시도 포함)를 모은다.
    cur = {}
    orig_log, orig_call = server._log_usage, server._gemini_call_with_retry

    def log_hook(body, model, label=""):
        u = (body or {}).get("usageMetadata") or {}
        cur["in"] = cur.get("in", 0) + u.get("promptTokenCount", 0)
        cur["out"] = cur.get("out", 0) + u.get("candidatesTokenCount", 0)
        cur["think"] = cur.get("think", 0) + u.get("thoughtsTokenCount", 0)
        cur["served"] = (body or {}).get("modelVersion") or cur.get("served")
        cur["calls"] = cur.get("calls", 0) + 1
        orig_log(body, model, label)

    server._log_usage = log_hook

    if a.argon_thinking == "default":
        orig_json = server._gemini_json

        def json_hook(payload, api_key, model, *rest, **kw):
            if "argon" in (model or "").lower():
                payload.get("generationConfig", {}).pop("thinkingConfig", None)
            return orig_json(payload, api_key, model, *rest, **kw)

        server._gemini_json = json_hook

    out_dir = Path(a.out)
    out_dir.mkdir(parents=True, exist_ok=True)
    rows = []
    for pi, passage in enumerate(passages, 1):
        for model in models:
            for rep in range(1, a.repeat + 1):
                cur.clear()
                t0 = time.time()
                err, result = "", None
                try:
                    result = server.call_gemini_quiz(
                        passage, items, "", model, variation=a.variation, difficulty=a.difficulty)
                except Exception as e:  # noqa: BLE001 — 실패도 한 줄의 결과다
                    err = f"{type(e).__name__}: {e}"[:200]
                sec = time.time() - t0
                pk = price_key(model, a.dec_price)
                pin, pout = PRICES[pk]
                usd = (cur.get("in", 0) * pin + (cur.get("out", 0) + cur.get("think", 0)) * pout) / 1e6
                served = cur.get("served") or "?"
                q = quality_signals(result, items) if result else {}
                row = {"passage": pi, "model": model, "rep": rep, "ok": not err, "err": err,
                       "sec": round(sec, 1), "in": cur.get("in", 0), "out": cur.get("out", 0),
                       "think": cur.get("think", 0), "calls": cur.get("calls", 0),
                       "served": served, "usd": round(usd, 5), "krw": round(usd * a.krw, 1), **q}
                if served != "?" and model.lower() not in str(served).lower():
                    row["warn"] = f"요청 {model} ≠ 응답 {served} (모델 대체 의심)"
                rows.append(row)
                print(("✓" if row["ok"] else "✗"), json.dumps(row, ensure_ascii=False), flush=True)
                if result:
                    (out_dir / f"p{pi}_{model}_r{rep}.json").write_text(
                        json.dumps(result, ensure_ascii=False, indent=1), encoding="utf-8")

    server._log_usage, server._gemini_call_with_retry = orig_log, orig_call
    (out_dir / f"summary_{date.today()}.json").write_text(
        json.dumps(rows, ensure_ascii=False, indent=1), encoding="utf-8")

    # 모델별 요약
    print("\n══ 모델별 요약 ══")
    print(f"{'모델':28} {'성공':>5} {'평균초':>7} {'입력':>7} {'출력':>7} {'생각':>7} {'원/회':>7} "
          f"{'오류답':>6} {'보기이상':>7} {'해설無':>6} {'문항부족':>7}")
    for m in models:
        rs = [r for r in rows if r["model"] == m]
        ok = [r for r in rs if r["ok"]]
        if not ok:
            print(f"{m:28} {0:>2}/{len(rs):<2} (전부 실패: {rs[0]['err'] if rs else ''})")
            continue
        avg = lambda k: statistics.mean(r[k] for r in ok)  # noqa: E731
        short = sum(1 for r in ok if r["got"] < r["want"])
        print(f"{m:28} {len(ok):>2}/{len(rs):<2} {avg('sec'):>7.1f} {avg('in'):>7.0f} {avg('out'):>7.0f} "
              f"{avg('think'):>7.0f} {avg('krw'):>7.1f} {sum(r['bad_answer'] for r in ok):>6} "
              f"{sum(r['bad_choices'] for r in ok):>7} {sum(r['no_expl'] for r in ok):>6} {short:>7}")
    warns = [r for r in rows if r.get("warn")]
    if warns:
        print("\n⚠️ 모델 대체 의심:", *{r["warn"] for r in warns}, sep="\n  ")
    print(f"\n문항 원문은 {out_dir}/ 에 있습니다. 정답이 유일한지·해설이 맞는지는 눈으로 보세요.")


if __name__ == "__main__":
    main()
