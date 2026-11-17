"""수능 빈출 낱말 목록(ksat_frequent_words.txt) 만들기 + 내부 점검용 수능 통계.

- 저장소 루트의 ksat_frequent_words.txt — 서버가 화면에 드러내지 않고 단어 뽑기·핵심 어휘·어휘 문항 출제 자리를
  고를 때 '참고'로 AI에 알려 준다(server.py _ksat_frequent / _ksat_in_passage). 낱말만 담는다.
- ksat_baseline.json(학년도별 어휘 비율·분야 수·낱말 뜻)은 **지문 파일 옆(저장소 밖)**에만 쓴다 — 사이트에 올리지
  않는다(2026-11-18 사용자: 받은 자료라 공유하면 문제가 될 수 있다). 낱말 세기 규칙을 점검할 때 본다.
수능 지문 원문은 저장소·사이트에 싣지 않는다. 지문 파일은 저장소 밖에 둔다.

    $env:PYTHONUTF8 = "1"
    python tools/ksat_baseline.py <passages_data.js> [--no-ai] [--words 800]

- passages_data.js: { "[수능] 2014년 11월 - 18번": [제목, 영어 원문, 해석, …], … } 꼴(영어 원문만 쓴다, 해석은 안 읽는다).
- 25~28번(도표·인물·안내문)은 뺀다 — 탭이 모의고사 PDF에서 처음에 빼 두는 번호와 같게 해야 견줄 수 있다.
- 소재 분류와 뜻은 우리 AI로 새로 만든다(server.py의 call_gemini_topic_scan·call_gemini_topic_words, GEMINI_API_KEY 원가만).
  다른 사람이 붙인 분류·해석은 쓰지 않는다. AI 결과는 같은 폴더의 캐시에 두어 다시 돌려도 값이 다시 나가지 않는다.
- 시험 연도 '2014년 11월'은 2015학년도 수능으로 적는다.
"""
import argparse
import concurrent.futures as cf
import datetime
import json
import os
import re
import sys

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
sys.path.insert(0, ROOT)
import server  # noqa: E402

WORDS_OUT = os.path.join(ROOT, "ksat_frequent_words.txt")
# 목록상 '고등(선택)'으로 잡히지만 학생 누구나 아는 낱말(파생어로 목록에 실려 고등 차례가 된 것)
HI_SKIP = {"different", "important"}
WORDS_HEAD = ("# 수능 빈출 낱말 — 한 줄에 하나. ① 2022 개정 교육과정 기본 어휘(3,000단어) 밖인데 수능의 서로 다른 지문 두 개 이상에 "
              "나온 것(많이 나온 차례) 다음에 ② 교육과정 '고등(선택)' 낱말 중 서로 다른 지문 세 개 이상에 나온 것.\n"
              "# {label} 독해 지문(18~45번, 25~28번 제외)을 tools/ksat_baseline.py로 세어 만들었다({made}).\n"
              "# 화면에는 보이지 않는다 — 단어 뽑기·핵심 어휘·어휘 문항 출제 자리를 고를 때 AI에 참고로 알려 준다"
              "(server.py _ksat_frequent·_ksat_in_passage).\n")
SKIP_NOS = {25, 26, 27, 28}
KEY_RE = re.compile(r"(\d{4})년\s*(\d{1,2})월\s*-\s*(\d{1,2})(?:\s*~\s*(\d{1,2}))?번")


def load_passages(path):
    s = open(path, encoding="utf-8").read()
    data = json.loads(s[s.index("{"):s.rindex("}") + 1])
    years = {}
    for key, val in data.items():
        m = KEY_RE.search(key)
        if not m or not isinstance(val, list) or len(val) < 2:
            continue
        no = int(m.group(3))
        if no in SKIP_NOS:
            continue
        year = int(m.group(1)) + 1          # 시험 본 해 + 1 = 학년도
        text = re.sub(r"\s+", " ", str(val[1])).strip()
        if len(text) < 100:
            continue
        name = f"{no}~{m.group(4)}번" if m.group(4) else f"{no}번"
        years.setdefault(year, []).append({"id": f"y{year}n{no}", "name": name, "text": text, "no": no})
    return [{"name": f"{y}학년도", "year": y, "passages": sorted(ps, key=lambda p: p["no"])}
            for y, ps in sorted(years.items())]


def load_cache(path):
    try:
        return json.load(open(path, encoding="utf-8"))
    except (OSError, ValueError):
        return {}


def save_cache(path, obj):
    with open(path, "w", encoding="utf-8") as f:
        json.dump(obj, f, ensure_ascii=False)


def run_topics(rounds, cache):
    todo = [p for r in rounds for p in r["passages"] if p["id"] not in cache]
    parts = [todo[i:i + server.TOPIC_SCAN_BATCH] for i in range(0, len(todo), server.TOPIC_SCAN_BATCH)]
    print(f"소재 분석: {len(todo)}지문 남음 ({len(parts)}번 호출)")
    with cf.ThreadPoolExecutor(4) as ex:
        futs = [ex.submit(server.call_gemini_topic_scan, part, "", "") for part in parts]
        for f in cf.as_completed(futs):
            try:
                for it in f.result()["items"]:
                    cache[it["id"]] = {k: it[k] for k in ("field", "genre", "topic", "keywords")}
            except Exception as e:   # 한 묶음이 실패해도 나머지는 남긴다 — 다시 돌리면 빠진 것만 한다
                print("  실패:", e)
    return cache


def run_meanings(words, rounds, cache):
    todo = [w for w in words if w["word"] not in cache]
    parts = [todo[i:i + server.TOPIC_WORDS_MAX] for i in range(0, len(todo), server.TOPIC_WORDS_MAX)]
    print(f"뜻 달기: {len(todo)}낱말 남음 ({len(parts)}번 호출)")

    # 12년 공통 단어장이라 문장 하나의 뜻(capacity → '자격')이 아니라 사전식 기본 뜻을 단다 — 예문을 보내지 않는다
    def one(part):
        return server.call_gemini_topic_words([{"word": w["word"], "example": ""} for w in part], "", "")

    with cf.ThreadPoolExecutor(3) as ex:
        for f in cf.as_completed([ex.submit(one, part) for part in parts]):
            try:
                for it in f.result()["items"]:
                    cache[it["word"].lower()] = {"pos": it["pos"], "meaning": it["meaning"], "synonym": it["synonym"]}
            except Exception as e:
                print("  실패:", e)
    return cache


def word_years(w, rounds):
    pat = re.compile(r"\b(" + "|".join(re.escape(x) for x in [w["word"]] + list(w["forms"])) + r")\b", re.I)
    return sum(1 for r in rounds if any(pat.search(p["text"]) for p in r["passages"]))


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("passages")
    ap.add_argument("--no-ai", action="store_true", help="AI를 부르지 않고 어휘 통계만(소재·뜻은 캐시에 있는 것만)")
    ap.add_argument("--words", type=int, default=1200, help="빈출 어휘 단어장에 넣을 낱말 수 상한")
    ap.add_argument("--cache", help="AI 결과 캐시(기본: 지문 파일 옆 ksat_cache.json — 저장소 밖)")
    ap.add_argument("--dump", help="3,000단어 밖 낱말 전체를 이 파일에 적는다(내부 점검용 — 저장소에 넣지 말 것)")
    a = ap.parse_args()
    a.cache = a.cache or os.path.join(os.path.dirname(os.path.abspath(a.passages)), "ksat_cache.json")

    rounds = load_passages(a.passages)
    n_pass = sum(len(r["passages"]) for r in rounds)
    print(f"{len(rounds)}회 · {n_pass}지문")

    server.TOPIC_OFFLIST_MAX = 100000     # 도구에서는 전부 받는다
    st = server.topic_vocab_stats(rounds)
    print("전체 비율", st["coverage"], "낱말", st["tokens"], "목록 밖", st["offlistTotal"])
    if a.dump:
        with open(a.dump, "w", encoding="utf-8") as f:
            for w in st["offlist"]:
                f.write(f"{w['word']}\t{w['count']}\t{w['passages']}\t{','.join(w['forms'])}\n")

    cache = load_cache(a.cache)
    topics = cache.setdefault("topics", {})
    means = cache.setdefault("meanings", {})
    if not a.no_ai:
        run_topics(rounds, topics)
        save_cache(a.cache, cache)

    # 빈출 어휘: 3,000단어 밖 낱말을 많이 나온 차례로(화면이 '2번 이상'·'모두'를 고르게 한다)
    pick = st["offlist"][:a.words]
    if not a.no_ai:
        run_meanings(pick, rounds, means)
        save_cache(a.cache, cache)

    fields, genres, by_year = {}, {}, []
    for r in rounds:
        fc = {}
        for p in r["passages"]:
            t = topics.get(p["id"])
            if not t:
                continue
            fc[t["field"]] = fc.get(t["field"], 0) + 1
            fields[t["field"]] = fields.get(t["field"], 0) + 1
            genres[t["genre"]] = genres.get(t["genre"], 0) + 1
        by_year.append(fc)

    words = []
    for w in pick:
        m = means.get(w["word"].lower())
        if not m or not m.get("meaning"):
            continue
        words.append({"word": w["word"], "count": w["count"], "passages": w["passages"],
                      "years": word_years(w, rounds), "pos": m["pos"], "meaning": m["meaning"],
                      "synonym": m.get("synonym", "")})

    first, last = rounds[0]["year"], rounds[-1]["year"]
    out = {
        "v": 1,
        "made": datetime.date.today().isoformat(),
        "label": f"수능 {first}~{last}학년도",
        "note": f"수능 {len(rounds)}회 · 18~45번(25~28번 도표·안내문 제외) {n_pass}지문",
        "rounds": len(rounds),
        "passages": n_pass,
        "tokens": st["tokens"],
        "coverage": st["coverage"],
        "offlistTotal": st["offlistTotal"],
        "years": [{"name": r["name"], "tokens": sr["tokens"], "coverage": sr["coverage"], "fields": fc}
                  for r, sr, fc in zip(rounds, st["rounds"], by_year)],
        "fields": fields,
        "genres": genres,
        "topicDone": sum(fields.values()),
        "words": words,
    }
    stats_out = os.path.join(os.path.dirname(os.path.abspath(a.passages)), "ksat_baseline.json")   # 저장소 밖
    with open(stats_out, "w", encoding="utf-8") as f:
        json.dump(out, f, ensure_ascii=False, separators=(",", ":"))
    # ① 3,000단어 밖 — 서로 다른 지문 2개 이상  ② 교육과정 '고등(선택)' 낱말 — 서로 다른 지문 3개 이상(2026-11-18 사용자:
    # 학생이 실제로 어려워하는 수능 단어는 대부분 고등 단계 낱말이다)
    freq = [w["word"].lower() for w in st["offlist"] if w["passages"] >= 2 and w["word"].isalpha()]
    hi_where, hi_count = {}, {}
    for r in rounds:
        for p in r["passages"]:
            for base, _low, _cap in server._topic_tokens(p["text"]):
                h = server._curriculum_rank(base)
                if h and h[0] == 2:
                    hi_where.setdefault(h[1], set()).add(p["id"])
                    hi_count[h[1]] = hi_count.get(h[1], 0) + 1
    hi = sorted((k for k, v in hi_where.items() if len(v) >= 3 and k not in HI_SKIP and k.isalpha()),
                key=lambda k: (-len(hi_where[k]), -hi_count[k], k))
    freq += [k for k in hi if k not in freq]
    with open(WORDS_OUT, "w", encoding="utf-8", newline="\n") as f:
        f.write(WORDS_HEAD.format(label=out["label"], made=out["made"]) + "\n".join(freq) + "\n")
    print(f"→ {stats_out} · 분야 {out['topicDone']}지문 · 뜻 단 낱말 {len(words)}개")
    print(f"→ {WORDS_OUT} · 수능 빈출 낱말 {len(freq)}개")


if __name__ == "__main__":
    main()
