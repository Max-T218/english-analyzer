# CLAUDE.md

이 저장소에서 작업할 때의 안내입니다.
사람이 읽을 기능 설명은 `README.md`, 배포 절차는 `DEPLOY.md`에 있습니다.

## 이 프로젝트

영어 지문을 붙여넣으면 Gemini가 **분석본·객관식·주관식·워크북·단어장**을 만들어 주는
교사용 웹앱입니다.

- **백엔드**: `server.py` 한 파일 (약 4,000줄, 그중 5분의 1이 Gemini 프롬프트 문자열).
  Python 표준 라이브러리 `http.server`로 직접 라우팅합니다 — Flask도 FastAPI도 쓰지 않습니다.
- **프런트**: `public/` 정적 파일. 빌드 도구·번들러·프레임워크 없음. 바닐라 JS 한 파일
  (`app.js`, 156KB)입니다.
- **저장소**: Firestore. pip 의존성은 둘뿐입니다 — `google-cloud-firestore`(로그인·저장),
  `pdfminer.six`(PDF에서 지문 꺼내기. 없으면 그 기능만 꺼지고 서버는 그대로 뜹니다 —
  `PDF_READY` 참고).
- **배포**: Render (`render.yaml`). `origin/main`에 push하면 자동 재배포됩니다.

## 실행

터미널을 열면 **항상 먼저** 이 줄을 넣으세요.

```powershell
$env:PYTHONUTF8 = "1"
```

코드·프롬프트·오류 메시지가 전부 한글입니다. 이걸 빼면 콘솔 출력이 `?????`로 깨져
엉뚱한 원인을 짚게 됩니다.

```powershell
python server.py     # Python 3.14.6 → http://localhost:8000
```

포트를 바꾸려면 `$env:PORT = "8001"`. 8000이 이미 물려 있으면:

```powershell
Get-NetTCPConnection -LocalPort 8000 -State Listen | ForEach-Object { Stop-Process -Id $_.OwningProcess -Force }
```

### 환경변수

사용자(User) 수준 환경변수에 들어 있고 터미널이 그대로 상속받습니다. **키를 코드에 넣거나
`.env` 파일을 만들지 마세요.** 지금 무엇이 채워져 있는지는 값을 찍지 말고 이걸로 확인하세요.

```powershell
foreach ($n in 'GEMINI_API_KEY','GOOGLE_APPLICATION_CREDENTIALS_JSON','GOOGLE_CLIENT_ID','SMTP_USER','SMTP_PASSWORD','ADMIN_USERNAME','ADMIN_PASSWORD') {
  $v = [Environment]::GetEnvironmentVariable($n, 'User')
  "{0,-38} {1}" -f $n, $(if ($v) { "설정됨" } else { "없음" })
}
```

`GOOGLE_APPLICATION_CREDENTIALS_JSON`(Firestore)이 없으면 로그인이 안 되고, **로그인이 AI
기능의 전제 조건이라 분석·문제·워크북 전체가 함께 막힙니다.** AI 기능을 로컬에서 실제로 돌려
확인해야 하는 작업이라면 먼저 확인하고, 비어 있으면 사용자에게 알리세요 — 인증을 임시로
끄거나 우회하는 코드를 넣지 마세요.

전체 환경변수 목록과 기본값은 `README.md`의 "설정 (환경변수)" 표에 있습니다.

### ⚠️ 로컬 서버도 실서비스 Firestore를 씁니다

dev/prod 분리가 없습니다. 서비스 계정 JSON 하나의 프로젝트를 로컬 서버와 배포 서버가
똑같이 바라봅니다 — 컬렉션은 `users`, `sessions`, `saved_items`, `pending_signups`,
`deleted_accounts`, `admin_sessions`.

따라서 로컬 테스트가 곧 실데이터 조작입니다.

- 회원가입 테스트 → 실서비스 회원 목록에 계정이 쌓입니다
- 분석·문제 생성 테스트 → **실제 잔액이 깎입니다**
- `/api/auth/delete`, `/api/admin/recharge` → **진짜 계정을 지우고 진짜 잔액을 바꿉니다**

로그인이 필요한 기능을 확인할 때는 테스트용 계정을 쓰고, 삭제·충전 계열 API는 사용자가
명시적으로 요청하지 않는 한 로컬에서 호출하지 마세요.

## 코드 지도

줄 번호는 수정할 때마다 밀리니 **심볼 이름으로 찾으세요.**

### `server.py`

| 찾을 것 | 앵커 |
|---|---|
| 환경변수·기본값 | 파일 상단 `HOST` ~ `PRICE_OCR_KRW` |
| 가격 계산 | `_quiz_type_base_price`, `_quiz_action_cost`, `_workbook_cost`(단계 수 × 단가, 상한 있음) |
| 포인트 원장(이용 내역)·유상무상 구분 | `POINT_LEDGER`, `_split_balance`, `charge_krw`, `add_krw`, `list_usage`, `_fold_old_ledger` |
| Firestore 연결 | `_load_firestore` |
| 회원가입·인증코드·비밀번호 | `start_signup`, `complete_signup`, `login_with_password`, `_hash_password` |
| Gemini 호출 공통(재시도·시간 예산) | `RETRY_MIN_WAIT`, `MAX_RETRY_TOTAL`, `_over_budget`, `RefineTrace`, `_parse_retry_delay` |
| 기능별 프롬프트·스키마·호출 | `*_SCHEMA` / `*_SYSTEM_PROMPT` / `call_gemini_*` 3종 세트 — quiz, reword, ocr, workbook. 지문 분석만 이름에 접두어가 없어 `GEMINI_SCHEMA` / `SYSTEM_PROMPT`입니다 |
| PDF에서 지문 꺼내기 | `read_pdf_pages`(글자층+좌표 읽기), `_pdf_columns`(단 나누기), `split_pdf_passages`(문항형/문단형 판정), `_pdf_clean_passage`(번호·보기·정답교정 정리). 여기까지는 Gemini를 부르지 않습니다 — 규칙이 실패했을 때만 `call_gemini_pdf_split`이 '경계 줄 번호'만 물어봅니다 |
| 출력 HTML 정리 | `sanitize_inline`, `sanitize_quiz_html`, `clean_korean`, `clean_note`, `normalize_ruby`, `fix_underline_bounds` |
| 라우팅 | `_handle_get`, 그리고 POST 쪽의 `if path == "/api/..."` 나열 |

### `public/app.js`

`/* ══════ 제목 ══════ */` 주석이 섹션 구분입니다. 주요 앵커:

`createPassageManager`(지문 입력칸 관리) · `TAB_SAVE`(탭별 저장 배선) · `runActiveTab` ·
`runOcr`(사진) · `runPdfImport`(PDF — 공용 칸과 시험 범위 칸 양쪽을 채운다) ·
`buildAnalysisHtml` · `MCQ_TYPES` / `SAQ_TYPES` / `TYPE_MAX` ·
`renderAccount`(잔액 표시) · `setEditMode`(결과물 직접 수정) · `printDoc` ·
`undoOnce` / `pushUndo`(되돌리기 — 결과 화면 HTML을 통째로 찍어 쌓는다. 글자 수정과 쪽 구성이
같은 스택을 쓴다) ·
`setPagingMode` / `layoutPages`(지문 분석 '쪽 구성' — 덩어리 `.pg-blk` 단위로 쪽 경계를 옮긴다.
인쇄에 남는 건 `data-brk`뿐이고, 쪽 높이는 `PAGE_H_MM`이 `@page`·`.print-foot` 값을 그대로 따른다)

지문 칸 상한은 `MAX_PASSAGES`(40, 공용)와 `EXAM_PAPER_MAX_PASSAGES`(40, 시험지)입니다.
많이 담은 채 실행하면 시간이 지문 수만큼 곱해지므로 `costConfirmed`가 실행 직전에
한 번 더 알립니다(`MANY_PASSAGES_WARN`).

### `public/index.html`

탭 5개 — `analyze`, `mcq`, `saq`, `workbook`, `vocab`.
각각 `#tab-<id>` 섹션과 `#analyzeBtn` / `#mcqBtn` / `#saqBtn` / `#wbBtn` 실행 버튼을 가집니다.

## 반드시 함께 고쳐야 하는 쌍

같은 표가 서버와 화면 양쪽에 있습니다. 한쪽만 고치면 **조용히 어긋납니다** — 화면이 허용한
요청을 서버가 잘라내거나, 가격이 문항 수에 걸려 있어 요금이 틀어집니다.

| `server.py` | `public/app.js` |
|---|---|
| `QUIZ_TYPE_MAX` | `TYPE_MAX` (안내 문구는 `TYPE_MAX_REASON`) |
| `QUIZ_TYPE_LABELS` | `MCQ_TYPES`, `SAQ_TYPES` |
| `MCQ_ONLY_TYPES` | `MCQ_TRANSFORM_TYPES` |
| `WORKBOOK_STAGE_IDS` | `WB_STAGES`의 id — 워크북 요금이 단계 수에 걸려 있다 |

**가격은 예외입니다.** 서버가 유일한 출처이고 화면은 `/api/pricing`으로 받아 씁니다.
화면 쪽에 가격 숫자를 하드코딩하지 마세요.

## API 엔드포인트

**GET** — `/api/pricing` `/api/me` `/api/saved` `/api/saved/<id>` `/api/usage` `/api/admin/me`
`/api/admin/users` `/api/admin/usage` `/api/_probe`(임시, 아래 참고)

**POST** — `/api/analyze` `/api/quiz` `/api/workbook` `/api/reword` `/api/ocr` `/api/pdfsplit`
`/api/models`
`/api/auth/google` `/api/auth/signup` `/api/auth/verify` `/api/auth/login` `/api/auth/delete`
`/api/logout` `/api/account/recharge` `/api/saved` `/api/saved/delete` `/api/admin/login`
`/api/admin/logout` `/api/admin/recharge`

## 하지 말 것

- **모델을 사용자가 고르게 만들지 마세요.** 기능마다 서버가 고정합니다 —
  객관식·지문변형형과 지문변형 heavy만 `GEMINI_MODEL_PRO`(Pro), 나머지는 전부
  `GEMINI_MODEL`(Flash). 정찰 가격과 실제 원가가 어긋나지 않게 하기 위한 설계입니다.
- **`sanitize_*` / `clean_*`를 우회하지 마세요.** AI가 만든 HTML을 브라우저에 그대로
  넣는 구조라 이 함수들이 유일한 방어선입니다.
- **잔액 차감 시점을 바꾸지 마세요.** 요청 전에 잔액을 확인하고(부족하면 Gemini를 아예
  부르지 않음), **생성이 성공했을 때만** 차감합니다. 실패한 시도에 요금이 나가면 안 됩니다.
- **비밀값을 파일에 쓰지 마세요.** `.gitignore`가 `.env*`와 `service-account*.json`을
  막아두었지만, 코드 안에 박아 넣는 건 막지 못합니다. `origin`은 공개 저장소입니다.
- **`git push`는 곧 배포입니다.** Render가 `origin/main`의 push를 받아 자동 재배포합니다.
  사용자가 명시적으로 요청하지 않으면 push하지 마세요.
- 이 폴더는 **Google Drive 동기화 경로**(`G:\...`)입니다. 파일 감시가 늦을 수 있으니,
  외부에서 바뀐 파일은 캐시를 믿지 말고 다시 읽으세요.

## 고친 뒤 확인하는 방법

자동 테스트는 없습니다. 대신 이 순서로 확인하세요.

**1. `server.py` 문법**

```powershell
python -m py_compile server.py
```

**2. 서버가 뜨고 응답하는지**

```powershell
$env:PYTHONUTF8 = "1"; python server.py
```

다른 터미널에서:

```powershell
curl.exe -s -o NUL -w "%{http_code}`n" http://localhost:8000/
```

**3. `app.js` 문법**

이 PC에는 Node·Deno·Bun이 없습니다. JS는 명령줄로 검사할 방법이 없으니, 서버를 띄우고
브라우저로 `http://localhost:8000`에 접속해 **콘솔 오류를 읽어 확인하세요.** 문법 오류가
있으면 `app.js`가 아예 실행되지 않아 버튼이 전부 죽으므로 바로 드러납니다.

**4. UI 동작은 브라우저로 직접 눌러 확인하세요.**

이게 가장 중요합니다. 최근 고친 버그들 — 등위접속사가 여럿일 때 묶음별 색 분리, 문항 수 1에서
`−`를 눌렀을 때, 저장함에서 불러올 때 이전 결과물이 남던 문제 — 은 전부 코드만 읽어선 드러나지
않고 실제로 클릭해봐야 나타난 것들입니다. "코드를 고쳤으니 됐다"로 끝내지 마세요.

**5. `git log --oneline`을 먼저 읽으세요.**

커밋 메시지가 한 줄 한글 서술문이고 무엇을 왜 고쳤는지가 들어 있어, 최근 작업 맥락을 잡는 가장
빠른 길입니다. 새 커밋도 같은 형식으로 쓰세요.

## 지금 임시로 켜둔 것

`GET /api/_probe` — 배포 프록시가 '응답 없는 요청'을 몇 초에서 끊는지 재기 위한 측정용입니다.
`PROBE_ENABLED` 환경변수가 있을 때만 존재합니다. 측정이 끝나면 그 변수를 지우고
`_handle_get` 안의 해당 블록도 **함께 삭제**해야 합니다.

## 문서와 코드가 어긋난 곳

작업 중 헷갈리지 않도록 적어 둡니다. **코드를 출처로 삼고**, 문서를 손볼 일이 생기면 함께 맞추세요.

- `DEPLOY.md`는 "선생님마다 본인 Gemini 키를 화면에 입력"하는 옛 방식으로 쓰여 있습니다.
  현재 구조는 관리자 키 하나를 모든 로그인 사용자가 공유하고, 화면에는 키 입력칸이 없습니다.
