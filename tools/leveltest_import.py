"""레벨테스트 시험지를 Firestore에 올린다(한 번만 돌리는 관리자 도구).

원본은 학원이 따로 쓰던 레벨테스트 사이트(leveltestara)의 index.html 한 파일이다 —
문항·정답(GRADES/TESTS), 듣기 음성(AUDIO_TRACKS), 그림(IMAGES)이 모두 그 안의
<script>에 들어 있다. 그 학원만 쓰는 자료라 **공개 저장소에는 데이터를 넣지 않고**
이 스크립트만 둔다. 서버(server.py)는 Firestore에서 읽어 승인된 선생님의 응시 링크로만
내보낸다.

  leveltest_sets/{setId}      문항·정답 JSON(data) + 이름·순서·시간제한
  leveltest_media/{name}__{i} 음성·그림 조각(문서 1MiB 한도라 나눠 담는다)

쓰는 법 (PowerShell, 저장소 폴더에서):
  $env:PYTHONUTF8 = "1"
  python tools/leveltest_import.py <원본 index.html 또는 압축 zip> --dry-run   # 읽기만, 요약 출력
  python tools/leveltest_import.py <원본 index.html 또는 압축 zip>             # Firestore에 올린다

다시 돌리면 같은 문서를 덮어쓴다(시험지를 고친 뒤 다시 올리는 길). 응시 결과는 건드리지 않는다.
"""
import json
import re
import sys
import zipfile
from datetime import datetime, timezone

MEDIA_CHUNK = 900_000          # 바이트 — 문서 하나 1MiB 한도 안에 넉넉히
SET_IDS = ["phonics", "elem_low", "elem_mid", "elem_high", "ms_hs_a", "ms_hs_b", "ms_hs_c", "ms_hs_d"]


# ── 자바스크립트 값(객체 리터럴) → 파이썬 값 ──
# 원본은 JSON이 아니다(따옴표 없는 키·작은따옴표·끝 쉼표·주석·50 * 60 같은 곱셈).
class JsParser:
    _STR = {'"': re.compile(r'(?:[^"\\]|\\.)*', re.S), "'": re.compile(r"(?:[^'\\]|\\.)*", re.S),
            "`": re.compile(r"(?:[^`\\]|\\.)*", re.S)}
    _NUM = re.compile(r"[0-9.\s*+\-/()]+")
    _IDENT = re.compile(r"[A-Za-z_$][A-Za-z0-9_$]*")

    def __init__(self, text, pos, env=None):
        self.s, self.i, self.env = text, pos, env or {}

    def ws(self):
        s = self.s
        while self.i < len(s):
            c = s[self.i]
            if c in " \t\r\n":
                self.i += 1
            elif s.startswith("//", self.i):
                j = s.find("\n", self.i)
                self.i = len(s) if j < 0 else j + 1
            elif s.startswith("/*", self.i):
                self.i = s.index("*/", self.i) + 2
            else:
                break

    def value(self):
        self.ws()
        c = self.s[self.i]
        if c == "{":
            return self.obj()
        if c == "[":
            return self.arr()
        if c in "\"'`":
            return self.string()
        if c.isdigit() or c in "-(.":
            m = self._NUM.match(self.s, self.i)
            expr = m.group(0).rstrip()
            # 끝에 붙은 쉼표 앞 공백까지만 먹는다 — 식에는 숫자와 사칙연산만 있다
            self.i += len(expr)
            if not re.fullmatch(r"[0-9.\s*+\-/()]+", expr):
                raise ValueError(f"숫자 식을 읽지 못했습니다: {expr!r}")
            v = eval(expr, {"__builtins__": {}}, {})  # 숫자·연산자만 통과한 식
            return int(v) if float(v).is_integer() else v
        m = self._IDENT.match(self.s, self.i)
        if not m:
            raise ValueError(f"{self.i}에서 값을 읽지 못했습니다: {self.s[self.i:self.i + 40]!r}")
        self.i = m.end()
        word = m.group(0)
        if word == "true":
            return True
        if word == "false":
            return False
        if word in ("null", "undefined"):
            return None
        if word in self.env:
            return self.env[word]
        raise ValueError(f"모르는 이름: {word}")

    def string(self):
        q = self.s[self.i]
        m = self._STR[q].match(self.s, self.i + 1)
        raw = m.group(0)
        self.i = m.end() + 1
        if "\\" not in raw:
            return raw
        out, k = [], 0
        while k < len(raw):
            c = raw[k]
            if c != "\\":
                out.append(c)
                k += 1
                continue
            n = raw[k + 1]
            if n == "u":
                out.append(chr(int(raw[k + 2:k + 6], 16)))
                k += 6
            elif n == "x":
                out.append(chr(int(raw[k + 2:k + 4], 16)))
                k += 4
            else:
                out.append({"n": "\n", "t": "\t", "r": "\r", "b": "\b", "f": "\f", "v": "\v", "0": "\0"}.get(n, n))
                k += 2
        return "".join(out)

    def obj(self):
        self.i += 1
        out = {}
        while True:
            self.ws()
            if self.s[self.i] == "}":
                self.i += 1
                return out
            c = self.s[self.i]
            if c in "\"'`":
                key = self.string()
            else:
                m = re.compile(r"[A-Za-z0-9_$]+").match(self.s, self.i)
                key = m.group(0)
                self.i = m.end()
            self.ws()
            if self.s[self.i] != ":":
                raise ValueError(f"{self.i}: 키 {key} 뒤에 ':'가 없습니다")
            self.i += 1
            out[key] = self.value()
            self.ws()
            if self.s[self.i] == ",":
                self.i += 1

    def arr(self):
        self.i += 1
        out = []
        while True:
            self.ws()
            if self.s[self.i] == "]":
                self.i += 1
                return out
            out.append(self.value())
            self.ws()
            if self.s[self.i] == ",":
                self.i += 1


def read_const(html, name, env=None):
    m = re.search(r"\bconst\s+" + re.escape(name) + r"\s*=\s*", html)
    if not m:
        raise ValueError(f"{name}을(를) 찾지 못했습니다")
    return JsParser(html, m.end(), env).value()


def load_html(path):
    if path.lower().endswith(".zip"):
        with zipfile.ZipFile(path) as z:
            name = next(n for n in z.namelist() if n.endswith("index.html"))
            return z.read(name).decode("utf-8")
    with open(path, encoding="utf-8") as f:
        return f.read()


def media_mime(b):
    if b.startswith(b"\x89PNG"):
        return "image/png"
    if b.startswith(b"\xff\xd8"):
        return "image/jpeg"
    if b.startswith(b"ID3") or b[:2] in (b"\xff\xfb", b"\xff\xf3", b"\xff\xf2"):
        return "audio/mpeg"
    return "application/octet-stream"


# ── 밑줄 보정 (2026-10-21 사용자: '밑줄 친'인데 밑줄이 안 보인다) ──
# 원본 사이트는 밑줄 위치를 빠뜨린 문항이 있었다. 다시 올려도 고친 것이 남게 여기서 고친다.
# 원본에 밑줄 정보가 아예 없는 문항 — 정답의 근거가 되는 동사 자리로 정했다(원본 출제자 확인 필요)
UNDERLINE_CHOICES = {
    ("elem_high", "grammar", 6): {"A": "Did", "B": "looked", "C": "Do", "D": "bought", "E": "Do"},
    ("elem_high", "grammar", 13): {"A": "studies", "B": "closes", "C": "washes", "D": "eats", "E": "go"},
}
_CIRCLED = "①②③④⑤"


def _wrap_u(text, phrase, after=""):
    """text 속 phrase 첫 자리를 <u>로 감싼다(after가 있으면 그 글자 바로 뒤의 것만). 못 찾으면 None."""
    pat = (re.escape(after) if after else r"(?<![A-Za-z])") + "(" + re.escape(phrase) + r")(?![A-Za-z])"
    m = re.search(pat, text)
    if not m:
        return None
    return text[:m.start(1)] + "<u>" + m.group(1) + "</u>" + text[m.end(1):]


def fix_underlines(tests):
    """밑줄이 빠진 문항을 고친다. 돌려주는 값: 고친 내역(사람이 볼 글)."""
    log = []
    for gid, t in tests.items():
        for sec in t.get("sections") or []:
            for grp in sec.get("groups") or []:
                for q in grp.get("questions") or []:
                    key = (gid, sec.get("id"), q.get("n"))
                    stem = str(q.get("q") or "")
                    # ① 보기 문장마다 정해 둔 낱말
                    if key in UNDERLINE_CHOICES and q.get("choices"):
                        for letter, word in UNDERLINE_CHOICES[key].items():
                            new = _wrap_u(str(q["choices"].get(letter) or ""), word)
                            if new and "<u>" not in str(q["choices"][letter]):
                                q["choices"][letter] = new
                        log.append(f"{key} 보기에 밑줄")
                        continue
                    if "밑줄" not in stem:
                        continue
                    # ② 발문의 '밑줄 친 <영어 구절>의/이/가…' → 지문에서 그 구절
                    m = re.search(r"밑줄\s*친\s+([A-Za-z][A-Za-z ,'\-]*[A-Za-z])\s*(?:이|가|의|와|과|을|를|은|는)", stem)
                    passage = str(grp.get("passage") or "")
                    # 지문에 ①~⑤가 있으면(①he ②he…) 한 곳이 아니라 번호마다 그어야 한다 — ③으로 넘긴다
                    if m and passage and "<u>" not in passage and not any(c in passage for c in _CIRCLED):
                        new = _wrap_u(passage, m.group(1))
                        if new:
                            grp["passage"] = new
                            log.append(f"{key} 지문에 밑줄: {m.group(1)}")
                            continue
                    # ③ 보기가 ①~⑤ 번호 뒤의 말이면(지문이 발문에 붙어 있는 경우 포함) 그 말들
                    ch = q.get("choices") or {}
                    if ch and "<u>" not in stem + passage:
                        target = "passage" if any(c in passage for c in _CIRCLED) else "q"
                        text = passage if target == "passage" else stem
                        hits = 0
                        for k, letter in enumerate(sorted(ch)):
                            if k >= len(_CIRCLED):
                                break
                            new = _wrap_u(text, re.sub(r"<[^>]+>|^[①-⑤]", "", str(ch[letter])).strip(), after=_CIRCLED[k])
                            if new:
                                text, hits = new, hits + 1
                        if hits:
                            if target == "passage":
                                grp["passage"] = text
                            else:
                                q["q"] = text
                            log.append(f"{key} 번호 뒤 {hits}곳에 밑줄")
    return log


def build(html):
    """원본에서 시험지 8개와 음성·그림을 꺼낸다. 문항 모양을 검사해 이상하면 멈춘다."""
    import base64
    grades = read_const(html, "GRADES")
    env = {}
    for name in ("MOVERS", "STARTERS", "FLYERS", "PHONICS", "TYPE_A", "TYPE_B", "TYPE_C", "TYPE_D"):
        env[name] = read_const(html, name)
    tests = read_const(html, "TESTS", env)
    for line in fix_underlines(tests):
        print("  밑줄 보정:", line)
    audio = read_const(html, "AUDIO_TRACKS")
    images = read_const(html, "IMAGES")

    order = {g["id"]: k for k, g in enumerate(grades)}
    sets = []
    problems = []
    for gid in SET_IDS:
        t = tests.get(gid)
        g = next((x for x in grades if x["id"] == gid), None)
        if not t or not g:
            problems.append(f"{gid}: 시험지가 없습니다")
            continue
        n = 0
        for sec in t["sections"]:
            for grp in sec["groups"]:
                for q in grp["questions"]:
                    n += 1
                    typ = q.get("type") or ("mc" if sec["id"] == "listening" else "")
                    if typ not in ("mc", "mc_multi", "fill", "order"):
                        problems.append(f"{gid} {sec['id']} {q.get('n')}: 모르는 문제 모양 {typ!r}")
                    if typ in ("mc", "mc_multi") and not (q.get("choices") or q.get("choiceImages")):
                        problems.append(f"{gid} {sec['id']} {q.get('n')}: 보기가 없습니다")
                    if q.get("answer") in (None, "", []):
                        problems.append(f"{gid} {sec['id']} {q.get('n')}: 정답이 없습니다")
                    for key in [q.get("image")] + list((q.get("choiceImages") or {}).values()):
                        if key and key not in images:
                            problems.append(f"{gid} {sec['id']} {q.get('n')}: 그림 {key} 없음")
        if t.get("hasListening") and t.get("audioKey") not in audio:
            problems.append(f"{gid}: 음성 {t.get('audioKey')} 없음")
        sets.append({
            "id": gid,
            "label": g["label"],
            "gradeLabel": t.get("gradeLabel") or g["label"],
            "order": order.get(gid, 99),
            "timeLimitSec": int(t.get("timeLimitSec") or 0),
            "hasListening": bool(t.get("hasListening")),
            "audioKey": t.get("audioKey") or "",
            "audioLabel": t.get("audioLabel") or "",
            "questionCount": n,
            "test": t,
        })
    media = {}
    for key, b64 in list(audio.items()) + list(images.items()):
        raw = base64.b64decode(b64)
        media[key] = (media_mime(raw), raw)
    return sets, media, problems


def upload(sets, media):
    from google.cloud import firestore
    db = firestore.Client()
    now = datetime.now(timezone.utc).isoformat()
    for s in sets:
        doc = {k: v for k, v in s.items() if k != "test"}
        doc["data"] = json.dumps(s["test"], ensure_ascii=False)
        doc["updated_at"] = now
        db.collection("leveltest_sets").document(s["id"]).set(doc)
        print(f"  시험지 {s['id']} ({s['questionCount']}문항, {len(doc['data']):,}자)")
    # 옛 조각이 남지 않게 지우고 다시 담는다(조각 수가 줄 수 있다)
    for key, (mime, raw) in media.items():
        for old in db.collection("leveltest_media").where("name", "==", key).stream():
            old.reference.delete()
        parts = [raw[i:i + MEDIA_CHUNK] for i in range(0, len(raw), MEDIA_CHUNK)] or [b""]
        for i, part in enumerate(parts):
            db.collection("leveltest_media").document(f"{key}__{i}").set({
                "name": key, "mime": mime, "i": i, "n": len(parts), "data": part, "updated_at": now,
            })
        print(f"  자료 {key} {mime} {len(raw):,}바이트 → {len(parts)}조각")


def main():
    args = [a for a in sys.argv[1:] if not a.startswith("--")]
    if not args:
        print(__doc__)
        sys.exit(1)
    sets, media, problems = build(load_html(args[0]))
    for s in sets:
        print(f"{s['id']:10} {s['gradeLabel']:24} {s['questionCount']:3}문항 "
              f"시간 {s['timeLimitSec'] // 60}분 듣기 {s['audioKey'] or '-'}")
    print(f"음성·그림 {len(media)}개, 합계 {sum(len(r) for _, r in media.values()):,}바이트")
    if problems:
        print("\n문제가 있습니다 — 올리지 않습니다:")
        for p in problems:
            print("  -", p)
        sys.exit(2)
    if "--dry-run" in sys.argv:
        if "--dump" in sys.argv:
            print(json.dumps([s["test"] for s in sets], ensure_ascii=False, indent=1))
        return
    print("\nFirestore에 올립니다…")
    upload(sets, media)
    print("끝.")


if __name__ == "__main__":
    main()
