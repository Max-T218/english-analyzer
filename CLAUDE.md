# CLAUDE.md

이 저장소에서 작업할 때의 안내입니다.
사람이 읽을 기능 설명은 `README.md`, 배포 절차는 `DEPLOY.md`에 있습니다.
**하기로 정했지만 아직 안 만든 것은 `TODO.md`에 있습니다** — 새 작업을 시작하기 전에 한 번 보세요.

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
foreach ($n in 'GEMINI_API_KEY','GOOGLE_APPLICATION_CREDENTIALS_JSON','GOOGLE_CLIENT_ID','SMTP_USER','SMTP_PASSWORD','ADMIN_USERNAME','ADMIN_PASSWORD','PORTONE_STORE_ID','PORTONE_CHANNEL_KEY_CARD','PORTONE_API_SECRET','PORTONE_WEBHOOK_SECRET') {
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
`deleted_accounts`, `admin_sessions`, `payment_intents`.

따라서 로컬 테스트가 곧 실데이터 조작입니다.

- 회원가입 테스트 → 실서비스 회원 목록에 계정이 쌓입니다
- 분석·문제 생성 테스트 → **실제 잔액이 깎입니다**
- `/api/auth/delete`, `/api/admin/recharge` → **진짜 계정을 지우고 진짜 잔액을 바꿉니다**
- **`PORTONE_*` 환경변수가 실연동(live) 채널 값이면, 충전 테스트가 진짜 카드로 진짜 결제됩니다.**
  로컬에서 충전 버튼을 눌러 볼 때는 반드시 포트원 콘솔의 **테스트 채널** 값으로 띄운
  서버인지 먼저 확인하세요 — `create_payment_intent`/`confirm_payment_intent` 참고.

로그인이 필요한 기능을 확인할 때는 테스트용 계정을 쓰고, 삭제·충전 계열 API는 사용자가
명시적으로 요청하지 않는 한 로컬에서 호출하지 마세요.

### ⚠️ 반/학생 기능은 관리자 승인이 필요하고, 미성년자 데이터를 다룹니다

`users` 문서의 `classroom_approved`가 켜진 선생님만 반을 만들고 학생을 등록할 수
있습니다(`admin.html`에서 관리자가 켭니다 — 기본은 꺼짐). 학생 이름은 미성년자
개인정보일 수 있어, 로컬에서 이 기능을 테스트할 때도 실제 이름을 넣지 말고
"테스트"처럼 알아볼 수 없는 값을 쓰세요.

**학생 로그인에 반 코드가 없습니다 — 이름 하나만 입력하면 로그인됩니다**
(`login_student`). 학생 등록이 어차피 반 하나에 묶여 있으니 로그인에서 코드를
또 묻는 게 군더더기라고 판단해 뺐다. 그 대가로 **로그인에 비밀값이 전혀 없다** —
이름을 아는 사람이면(급우든 남이든) 누구나 그 학생으로 로그인할 수 있다. 이전
버전(코드+이름)에 있던 "코드를 모르면 이름을 알아도 못 들어간다"는 방어선이
사라졌다는 뜻이다. `class_codes`/반 코드를 만드는 코드는 서버에 그대로 있지만
(`create_class`/`regenerate_class_code`), **교사 화면에서는 뺐다** — 로그인에 쓰이지
않는 코드를 "이 코드를 넣고 로그인합니다"라고 안내하고 있어서, 선생님이 학생에게
쓸모없는 코드를 알려 주게 됐기 때문이다. 코드 로그인을 되살리기로 하면 서버는
그대로 두고 화면만 다시 붙이면 된다.

동명이인이면 이름만으로 누구인지 가릴 수 없어 사고(엉뚱한 사람으로 로그인,
시험 결과 뒤섞임)로 이어지므로 **두 군데서 막는다**: `create_student`가 등록
시점에 `students` 컬렉션 전체(반·선생님 안 가림)에서 같은 이름이 있으면 등록
자체를 거부하고, `login_student`도 혹시 남아 있는 기존 동명이인 데이터에 대비해
로그인 시점에 한 번 더 거부한다. 즉 이름은 반 하나가 아니라 **앱 전체에서
유일해야** 한다 — 흔한 이름일수록 다른 선생님 반과 충돌해 등록이 막힐 수 있다.
비밀번호처럼 해시할 게 없으므로(이름 자체가 조회 키), 무차별 대입은 IP별
실패 횟수 제한(`_student_login_blocked`)으로만 막습니다.

단어시험은 **반 전체**에 낼 수도, **학생 한 명**에게만 낼 수도 있습니다
(`create_test_assignment`의 `student_id` — 없으면 반 전체, 있으면 그 학생만).
`list_tests_for_student`·`get_test_detail_for_student`·`grade_and_submit_attempt`는
전부 `_assignment_targets_student`로 이 배정 대상을 확인합니다 — 반이 같아도
다른 학생 한 명에게만 낸 시험은 안 보입니다.

**재시험**: `create_test_assignment`의 `max_wrong`(없으면 1회로 끝, 있으면 "이
개수 이하로 틀려야 합격")을 기준으로 `_attempt_progress`가 합격 여부·합격 회차·
다음에 볼 회차를 계산합니다. `test_attempts` 문서 ID는 `{assignment_id}_{student_id}_{round}`로
회차마다 따로 쌓이고(옛 시험은 회차 개념이 없던 시절 문서라 `round` 필드가 없는데,
`_get_student_attempts`가 조회할 때 `round=1`로 취급해 예전 데이터도 그대로
호환됩니다), `_build_student_questions`도 시드에 `round`를 넣어 재시험마다 순서·
방향·객관식 보기를 다시 섞습니다 — 떨어진 회차의 보기 위치를 외워 통과하는 것을
막기 위해서입니다.

## 코드 지도

줄 번호는 수정할 때마다 밀리니 **심볼 이름으로 찾으세요.**

### `server.py`

| 찾을 것 | 앵커 |
|---|---|
| 환경변수·기본값 | 파일 상단 `HOST` ~ `PRICE_OCR_KRW` |
| 가격 계산 | `_quiz_type_base_price`, `_quiz_action_cost`, `_workbook_cost`(단계 수 × 단가, 상한 있음) |
| 포인트 원장(이용 내역)·유상무상 구분 | `POINT_LEDGER`, `_split_balance`, `charge_krw`, `add_krw`, `list_usage`, `_fold_old_ledger` |
| 유상 포인트 소진기한(5년) | `PAID_POINT_EXPIRE_YEARS`(일수가 아니라 햇수 — 윤일 때문에 1825일은 5주년보다 하루 이르다), `_plus_years`, `_paid_expiry`(KST 기준으로 잡는다), `_paid_lots`(충전분을 묶음으로 회원 문서에 둔다 — 원장은 18개월이면 접히는데 기한은 5년이라), `_draw_paid_lots`(기한 이른 것부터 쓴다), `_due_paid_lots`, `expire_due_paid`(cron이 없어 `_account_payload`에서 겸사겸사 훑는다) |
| 휴면계정(1년 미접속 → 전환, 30일 전 메일 통지) | `DORMANT_AFTER_DAYS`/`DORMANT_NOTICE_DAYS`, `_touch_login`(create_session 한 곳에서 last_login을 적고, 휴면이면 즉시 깨운다), `sweep_dormant_accounts`(cron이 없어 `_account_payload`에서 하루 한 번 훑는다 — `_sweep_due`가 간격을 막는다), `_send_dormant_notice`(**통지에 실패하면 전환하지 않는다** — 30일 전 통지는 전환의 전제 조건이다). 잔액은 건드리지 않는다 |
| 결제(포트원) — 결제창 열기 전 요청 생성 → 결제 후 서버가 직접 확인하고서만 충전 | `PORTONE_STORE_ID`/`PORTONE_CHANNEL_KEY_CARD`/`PORTONE_API_SECRET`, `create_payment_intent`, `confirm_payment_intent`(`payment_intents` 컬렉션, 브라우저가 보고하는 성공 여부를 그대로 믿지 않는다). **포트원 V2 응답의 필드 이름을 손볼 때는 스키마를 먼저 확인하세요** — `channel`을 `selectedChannel`로, 통화를 `amount` 안으로 잘못 읽어 실결제가 돈만 빠져나가고 충전이 안 되던 사고가 있었습니다 |
| 결제 취소 → 포인트 자동 회수(웹훅) | `PORTONE_WEBHOOK_SECRET`, `_verify_portone_webhook`(Standard Webhooks 규격 — 서명 대상은 `{id}.{시각}.{본문}`이라 **받은 그대로의 바이트**가 필요하다. 그래서 라우팅이 `_handle_post` 앞쪽, `raw`가 살아 있는 자리에 있다), `apply_payment_cancellation`(알림 금액을 믿지 않고 포트원에 다시 물어본다. 이미 쓴 포인트는 빼지 않고 남은 유상분에서만 회수하며, 누적 취소액 기준이라 같은 알림이 두 번 와도 한 번만 반영된다). 실패하면 일부러 200이 아닌 응답을 보내 포트원이 재전송하게 한다 |
| 반 · 학생 · 단어시험(AI 안 씀) | `_classroom_approved`/`set_classroom_approved`(관리자 승인 게이트), `create_class`/`regenerate_class_code`(반 하나당 코드 하나, `classes`/`class_codes` 컬렉션)/`create_student`/`delete_student`(`students` 컬렉션, 개별 코드 없음. `create_student`가 이름을 앱 전체에서 유일하도록 등록 시점에 동명이인을 거부한다), `login_student`(이름만 받아 로그인 — 반 코드 없음, `students` 전체를 이름으로 검색)/`create_student_session`/`_student_session_user`(학생 세션, `admin_sessions`와 같은 모양), `create_test_assignment`(`student_id`를 주면 그 학생 한 명에게만, 안 주면 반 전체에)/`_assignment_targets_student`(반 전체/개별 배정 판정, 조회·응시·제출 세 곳이 공유)/`_build_student_questions`(객관식 오답을 같은 단어장의 다른 뜻/단어에서 결정적으로 뽑음)/`grade_and_submit_attempt`(`test_assignments`/`test_attempts` 컬렉션, 문서 ID를 `{assignment_id}_{student_id}_{round}`로 고정해 그 회차의 중복 제출을 막음 — 재시험 기준은 아래 참고)/`_get_student_attempts`/`_attempt_progress`(합격 여부·합격 회차·다음 회차 계산)/`delete_assignment`(시험과 딸린 답안까지 삭제) |
| 동형 모의고사 제작 공개 범위 | **2026-09-27부터 모든 회원에게 열렸다** — `EXAM_OPEN_TO_ALL`(환경변수, 기본 켜짐)이면 `_exam_approved`가 늘 참이다. 다시 막으려면 Render에서 `EXAM_OPEN_TO_ALL=0` — 그때는 예전처럼 회원 문서의 `exam_approved`(관리자가 `/api/admin/approve-exam`으로 켠다)를 본다. `/api/examscan`·`/api/examocr`가 호출 앞에서 확인한다. 반/학생 승인(`classroom_approved`)과는 **별개의 플래그**다. 스위치가 켜져 있으면 `admin.html`의 모의고사 칸은 단추 대신 '전체 공개'로 보인다 |
| 동형 모의고사 상한 이벤트(2026-10-16까지) | `EXAM_EVENT_CAP_KRW`(9,900)/`EXAM_EVENT_UNTIL` — [📝 문제 제작] 한 번(여러 부 합쳐)에 받는 값의 **상한**. 문항마다 만들어질 때 받는 방식은 그대로다. 화면이 누를 때마다 `examRun`을 실어 보내고, 서버가 회원 문서의 `exam_event_run`에 그 누름의 누적액을 쌓아 `_exam_run_capped`로 깎는다(`_charge_and_send`에서 받기 직전에 다시 센다). 지어낸 `examRun`으로 상한을 무한히 쓰지 못하게 한 누름당 `EXAM_EVENT_RUN_MAX_Q`(120)문항까지만 상한이 걸린다. 끝나는 날이 지나면 저절로 꺼진다. 화면은 `public/app.js`의 `examEventCap`/`examRunPrice`/`examEventNote` |
| Firestore 연결 | `_load_firestore` |
| 회원가입·인증코드·비밀번호 | `start_signup`, `complete_signup`, `login_with_password`, `_hash_password` |
| 가입 동의(약관·개인정보·만14세) | `TERMS_VERSION`, `_consent_record`(화면을 거치지 않는 요청도 여기서 막는다), `upsert_user`(구글은 **계정을 새로 만들 때만** 동의를 따진다 — 로그인 창의 구글 버튼으로도 새 계정이 만들어지므로 화면이 아니라 서버에서 막아야 빠짐없다). 화면은 `public/app.js`의 `AGREE_BOXES`/`syncAgree`/`resetAgree` |
| Gemini 호출 공통(재시도·시간 예산) | `RETRY_MIN_WAIT`, `MAX_RETRY_TOTAL`, `_over_budget`, `RefineTrace`, `_parse_retry_delay` |
| 원가 실측(Render 로그) | `_log_usage`(`[usage] <기능이름> <모델> 입력 N(캐시 N) · 출력 N · 생각 N`). 기능 이름표는 2026-09-27에 넣었다 — 이전에는 모델 이름만 찍혀 어느 기능 호출인지 로그만으로 못 갈랐다. `_gemini_json`을 부르는 자리마다 `label="quiz"`처럼 넘긴다. 새 `call_gemini_*`를 추가하면 이 label도 함께 붙일 것 |
| Vertex AI로 부르는 길(청구처만 다르다) | `GEMINI_VIA_VERTEX`(기본 꺼짐), `_vertex_credentials`(Firestore와 같은 서비스 계정), `_vertex_try`(실패하면 None → `_gemini_call_with_retry`의 `_post`가 AI Studio로 다시 보낸다. 권한·한도 오류면 잠시 Vertex를 건너뛴다). 그림은 Interactions API가 Vertex에 없어 `call_gemini_infographic`이 `vertex_data`로 `:generateContent` 모양을 따로 넘긴다. **구글 클라우드 무료 체험 크레딧이 AI Studio 요금에는 안 쓰여서 만든 길이다**(2026-11-02 만료) |
| 기능별 프롬프트·스키마·호출 | `*_SCHEMA` / `*_SYSTEM_PROMPT` / `call_gemini_*` 3종 세트 — quiz, reword, ocr, workbook, vocab(`VOCAB_ITEMS_SCHEMA` 하나를 `call_gemini_vocab_ocr`/`call_gemini_vocab_pdf` 둘이 같이 씁니다). 지문 분석만 이름에 접두어가 없어 `GEMINI_SCHEMA` / `SYSTEM_PROMPT`입니다 |
| 시험지(스캔본)에서 읽기 — 쪽 그림을 Gemini에 직접 보낸다 | `call_gemini_exam_scan`/`EXAM_SCAN_SYSTEM_PROMPT`(발문만 읽어 유형표를 만든다 — **지문은 일부러 안 옮긴다**), `call_gemini_exam_ocr`/`EXAM_OCR_SYSTEM_PROMPT`/`normalize_exam_ocr`(그 구멍을 메우는 쪽. 지문만 옮겨 적고 발문·보기·각주·손글씨는 버린다), `EXAM_MAX_PAGES`. 둘 다 **Pro 고정**이고 `_exam_approved`를 거친다(지금은 `EXAM_OPEN_TO_ALL`로 모두에게 열림). 화면은 `public/app.js`의 `extractJpegs`(PDF 안의 JPEG를 그대로 꺼낸다 — 외부 라이브러리 없음)/`runExamScan`(유형 분석 — 3쪽씩)/`runExamOcr`(지문 옮겨 적기 — **2쪽씩 한 쪽 겹쳐**. 3쪽을 한 번에 보내면 글자를 빠뜨리는 것을 실측했다. 까닭은 그 함수 위 주석에 있다)/`passageKey`(같은 지문 가리기 — 앞머리와 꼬리 두 열쇠를 쓴다) |
| 기출 **여러 부**를 한 구성으로 합치기 | 쪽 그림마다 `doc`(몇째 부)이 붙는다 — 묶음이 부 경계를 넘지 않게 하고, 문항 번호 중복도 부마다 따로 센다(`seenByDoc`). 안 그러면 어느 시험지든 1·2·3번이 있어 **둘째 부가 통째로 버려진다**. `examDocNames`(부 이름) · `examDocScans`(이미 읽은 부 → 문항. 여기 있는 부는 다시 안 읽는다 — 한 부씩 올려 쌓는 길의 핵심이다) · `examShowScanResult`(한 부면 문항표, 여럿이면 합치기표) · `buildExamMergeRows`(**한 번이라도 나온 유형은 무조건 1문항**을 깔고 남는 자리만 빈도에 비례해 나눈다 — 평균만 내면 3년에 한 번 나온 유형이 반올림에서 사라지는데 정작 대비할 것이 그것이다) · `renderExamMerge`(부별 개수를 보여 주고 유형마다 ±로 고치게 한다) · `examMergeToQuestions`. 만든 시험지는 `examPaperSets`에 **쌓인다** — 저장본을 불러와 [📝 문제 제작]을 누르면 새 시험지가 불러온 것 뒤에 붙는다(B형을 이어 만드는 길). 따로 만들려면 `[🧹 만든 시험지 비우기]`(`clearExamPapers`) — 화면에서만 치우고 그 배분 조합은 `examAvoidPairs`에 남겨 `examUsedPairs`가 계속 피하며, `LOADED_SAVED.exam`을 지워 새 시험지가 불러온 저장본을 덮어쓰지 않게 한다 |
| 시험지 분석 리포트(탭) | **'기타'를 줄이는 길**(2026-09-30): 서버는 목록 밖 이름을 기타로 바꾸되 원래 이름을 `category_raw`로 남기고, 발문 프롬프트에 흔한 내신 발문 → 유형 짝을 적어 두었다. 화면의 `trendCat`은 ① 선생님이 고른 것(`catManual`) ② 목록 이름 ③ `category_raw`를 가까운 이름으로(`trendCatGuess`) ④ 기타면 발문(`prompt`) 낱말로 짐작(`TREND_CAT_RULES`) 순으로 정한다 — 저장본에 쓰지 않고 볼 때마다 계산하므로 규칙을 고치면 옛 저장본에도 반영된다. 그래도 남은 기타는 보고서 아래 화면 전용 `trendEtcHtml` 표에서 선생님이 분류를 고른다. 유형은 `kind`(이 앱으로 만들 수 있는 유형)가 아니라 **`category`**(보고서용 — `server.py`의 `EXAM_REPORT_CATEGORIES`, 중·고등 내신 공통 24가지)로 센다. `/api/examscan`이 문항마다 둘 다 돌려주며(`normalize_exam_scan`이 목록 밖 이름을 "기타"로 바꾼다), 동형 모의고사 탭은 `category`를 쓰지 않는다. 그래서 중학교 시험지(대화문·영영풀이·어법 개수 세기)도 빠짐없이 세어진다. 인쇄 쪽 구성(2026-09-29 사용자 확정 — 그림 먼저): 1쪽 표지 + `trendDashHtml`(한눈에 보는 출제 현황 — 숫자 칸·유형별 막대·영역별 비중) / 2쪽 핵심 요약 + `trendDashExtraHtml`(범위별 출제율) + **시험지 분석 총평**·대비 전략 / (시험지가 둘 이상일 때는 **합친 '한눈에 보는 출제 현황'을 싣지 않고** 1. 시험지별 분석(`trendPerExamHtml` 카드) → 2. 시험지별 유형 변화 → 3. 유형 출제 현황 표(둘 다 `.rp-keep`) → 새 쪽에 핵심 요약·총평. 2026-09-30 사용자 결정) `trendPerExamHtml`(**시험지별 분석** — 시험지마다 카드 한 장: 문항 수·선다/서답·영역 도넛·유형 막대(모든 카드가 같은 눈금)·'이 시험에서만' 나온 유형, 머리 띠 색은 `TREND_EXAM_COLORS`. 1쪽 숫자가 모든 시험지를 더한 값이라 시험 하나하나가 안 보였다 — 2026-09-30 사용자) + 유형 출제 현황 표(둘이 한 쪽에 들도록 카드를 촘촘히 했다: 18유형·3부 924px), 이어서 `.rp-keep`으로 `trendChangeHtml` — **모든 유형**을 한 줄씩, 시험지별 막대를 위아래로 겹친 그래프(`trendChangeBarsHtml` — 막대 색은 **시험지마다 하나**(`TREND_EXAM_COLORS`, 첫 시험 빨강·둘째 파랑·셋째 초록…, 범례와 같은 색 — 유형 색+진하기로 가렸을 땐 범례와 안 맞아 헷갈렸다), 오른쪽에 처음→마지막 증감 ▲/▼를 검정으로). 처음·마지막 비교(`trendChangeSummary` — 늘어난·줄어든)는 핵심 요약의 한 줄로만 싣는다(상자로 따로 두면 막대의 증감과 겹치고, 22유형·3부에서 쪽을 넘었다). 2026-09-30에 꺾은선(많이 나온 3가지 → 모든 유형)을 거쳐 이 모양이 됐다 — 모든 유형을 선으로 그리니 열 개 넘는 선이 엉켜 못 읽었다. **꺾은선으로 되돌리지 말 것** + 유형 출제 현황 표 / `trendCoverageHtml`. **부의 차례는 이른 시험 → 나중 시험**이다 — `trendSync`마다 `trendAutoSort`가 부 이름의 학년도·학기·차수(중간=1차, 기말=2차, `trendTimeKey`)로 정렬한다(하나라도 못 읽으면 안 건드린다). 올린 차례대로 두었더니 2학기 분석 뒤에 1학기 저장본을 더한 보고서가 증감을 거꾸로 적었다(2026-09-30). 부 목록의 ↑↓로 고치면 `trendOrderManual`이 켜져 자동 정렬을 멈추고, 저장본에 `manualOrder`로 담긴다. 범위 표는 출제 지문을 읽지 않은 부의 칸을 아예 뺀다. 유형 출제 현황 표(`rp-types`)는 `.rp-keep`(break-inside:avoid)으로 쪽 사이에서 안 잘리게 하고 이름·구분을 한 줄로 펴 촘촘히 했다 — 24유형·6부가 657px로 한 쪽에 든다. 시험지 이름은 공통 앞·뒤 낱말을 뗀 `trendShortNames`로 줄여 쓴다(안 그러면 '2026학년도 1학기 1…'처럼 잘려 둘이 같아 보인다). 각 쪽이 A4 한 장(687×1017px)에 드는지 실측해 맞췄다 — 칸을 더하면 다시 잴 것(`.trend-pg`가 쪽을 나눈다 — 화면에는 쪽 넘김이 없다). 범위 표에는 **출제된 지문만** 싣고 안 나온 지문은 표 아래 범위별 목록으로 모은다. 범위는 합친 칸(rowspan) 대신 머리줄로 나눈다 — 합친 칸은 인쇄에서 쪼개지지 않아 앞 쪽이 통째로 비었다. 보고서 제목에 `trendSchool`/`trendSubject`(학교 이름·학년 과목 칸, 저장본에 함께 담긴다)를 찍고, 부 이름은 분석이 읽은 고사 이름(`scan.title`)으로 채운다(손으로 고친 이름은 `nameEdited`로 지킨다). **`public/trend.js` 한 파일**(app.js 뒤에 로드, app.js의 전역을 씀). 동형 모의고사 탭과 **상태를 나누지 않는다** — 올리기(`trendAddFiles`)·분석(`trendRun` — 서버는 `/api/examscan` 그대로)·집계(`trendStats`, `buildExamMergeRows` 재사용)·보고서(`trendHtml`)·저장이 이 탭 것이다. AI 글(시험지 분석 총평)은 집계표만 받아 쓴다 — `/api/examtrend`, `call_gemini_exam_trend`/`EXAM_TREND_SYSTEM_PROMPT`(Flash 고정, `_exam_approved` 확인). **보고서 값은 여기서 1건당 정액으로 받는다**(`PRICE_EXAM_TREND_KRW` 기본 1,000P, 2026-09-29 결정) — 유형 분석·지문 읽기는 동형 모의고사와 가격을 같이 써서 무료로 둔다. 범위만 바뀌면 총평을 지우지 않고 `trendAiStale`로 안내만 한다(다시 쓰면 값이 또 나가므로). 시험 범위가 비어 있으면 지문을 읽지 않는다(`trendHasRange`), 저장본을 이어 붙일 때 범위는 가져오지 않는다. 승인은 동형 모의고사와 같다(`renderAccount`가 `trendTabBtn`을 함께 켜고 끈다). 저장은 저장함 tab `"trend"`(부별 문항 유형표 + AI 글, 쪽 그림은 안 담는다). `TAB_SAVE.trend`가 `beforeLoad`(하던 분석이 사라지니 묻는다)를 갖고, `loadSavedItem`은 이 탭 저장본을 불러올 때 다른 탭 결과를 지우지 않는다. `[➕ 저장한 분석 더하기]`가 `trendLoadMode="append"`로 여러 저장본을 이어 붙인다. 동형 모의고사 탭의 `[📂 분석 리포트에서 불러오기]`(`examLoadTrendBtn`)는 같은 저장본을 `savedLoadIntoExam`으로 가로채 `examApplyTrendItem`에 넘긴다 — 부마다 저장된 문항표(kind·engine·fit가 함께 들어 있다)를 `examDocScans`에 채워 합치기 표를 띄우고, 범위 지문은 시험 범위 칸에 넣는다(쪽 그림은 없어 지문 가져오기는 못 한다). 보고서 CSS `TREND_CSS` 한 벌을 화면과 인쇄 창(`trendPrint`, 새 창)이 같이 쓴다. 새 창이라 본문의 학원 마크(`.print-foot`)가 따라오지 않아 `trendBrandPrintCss`/`trendBrandPrintBody`가 따로 그린다 — 켜고 끄는 칸 없이 **넣은 것만** 찍는다 — 학원명·로고가 있으면 아래쪽(fixed + 같은 높이의 빈 tfoot, 그만큼 보고서를 zoom .95로 줄여 쪽 높이를 맞췄다), 워터마크 이미지(`BRAND_WM_STORE`, 학원 마크 칸의 `#brandWmFile` — 모든 탭이 같이 쓴다)가 있으면 뒷배경(쪽 전체). 다른 탭은 페이지를 그대로 인쇄하므로 `index.html`의 `#printWatermark`(style.css `.print-wm`, 인쇄에서만 fixed로 쪽마다 되풀이)가 같은 그림을 깐다. 학원 마크 입력 칸(`.brand-panel`)은 원래 이 탭에서 숨겨져 있어, `syncTabChrome`이 보고서의 `#trendBrandSlot`으로 옮겨 온다 — `trendRender`가 다시 그리기 전에 `moveBrandPanel(null)`로 꺼내 둔다(안 그러면 칸이 함께 지워진다). **시험 범위 대조**: 분석할 때 `trendReadPassages`가 `/api/examocr`로 출제 지문을 옮겨 적고(2쪽씩 한 쪽 겹쳐, `passageKey`로 중복 정리), `trendCoverage`가 시험 범위 지문(`trendRangeMgr` — 동형 모의고사 시험 범위 칸과 같은 `createPassageManager` 입력칸이라 이름·합치기·나누기·지문 저장·저장함/PDF 가져오기가 그대로 된다. 이름을 단 지문은 보고서에 그 이름으로 나온다. 지문 저장함에서 가져오면 `passageLoadTo.prepare`로 저장본 제목을 이름 앞에 붙여 "제목 · 본문1"이 되고, 보고서는 " · " 앞부분을 범위(저장본)로 보고 범위별 출제 수를 묶는다 — `prepare`는 `loadSavedItem`이 목적지 칸에 넣기 전에 부르는 선택 훅이다)과 세 낱말 묶음 겹침 비율(`TREND_MATCH_MIN` 0.3, 짧은 쪽 기준)로 짝을 짓는다. 지문 라벨의 번호(`trendLabelNos`)로 그 문항의 유형도 붙인다. 저장본(v2)에 부별 출제 지문과 범위를 함께 담는다 — 쪽 그림은 안 담으므로 지문을 안 읽고 저장한 부는 나중에 대조할 수 없다. **`trend.js`를 새로 만들었으므로 `_asset_version`의 파일 목록에 들어 있다** — 다른 정적 파일을 더하면 거기도 넣을 것 |
| PDF에서 지문 꺼내기 | `read_pdf_pages`(글자층+좌표 읽기), `_pdf_columns`(단 나누기), `split_pdf_passages`(문항형/문단형 판정), `_pdf_clean_passage`(번호·보기·정답교정 정리). 여기까지는 Gemini를 부르지 않습니다 — 규칙이 실패했을 때만 `call_gemini_pdf_split`이 '경계 줄 번호'만 물어봅니다 |
| 단어장 — 사진·PDF에서 단어 목록 가져오기 | `call_gemini_vocab_ocr`(사진), `parse_vocab_lines_rule`(PDF, 규칙만으로 "단어 — 뜻" 줄을 골라냄 · 0원), `call_gemini_vocab_pdf`(규칙이 못 뽑을 때만, `read_pdf_pages`가 이미 뽑아 둔 글자를 다시 보냄) |
| 출력 HTML 정리 | `sanitize_inline`, `sanitize_quiz_html`, `clean_korean`, `clean_note`, `normalize_ruby`, `fix_underline_bounds` |
| 라우팅 | `_handle_get`, 그리고 POST 쪽의 `if path == "/api/..."` 나열 |

### `public/app.js`

`/* ══════ 제목 ══════ */` 주석이 섹션 구분입니다. 주요 앵커:

`createPassageManager`(지문 입력칸 관리) · `TAB_SAVE`(탭별 저장 배선) · `runActiveTab` ·
`runOcr`(사진) · `runPdfImport`(PDF — 공용 칸과 시험 범위 칸 양쪽을 채운다) ·
`formatPassageBundle` / `parsePassageBundle` / `BUNDLE_LINE_RE`(지문 묶음을 텍스트로
주고받기 — 선생님끼리 카톡·메일로 나누는 길이다. '📋 지문 전체 복사'(입력칸에 있다 —
지문 저장함의 복사 단추는 2026-09-29에 뺐다)가 지문 사이에 `=== 지문 N · 이름 ===` 구분선을 끼워 넣고, 붙여넣기 처리가
그 구분선을 알아보고 칸을 나눈다. **두 함수는 한 벌이라 구분선 모양을 고치면 반드시
함께 고칠 것** — 옛 판으로 복사해 둔 글을 새 판이 못 읽게 된다. 지문이 하나면 구분선을
아예 안 붙인다. `syncSplitBtn`이 묶음일 때 `✂ 나누기`를 감추는 것도 같은 사정이다) ·
`buildAnalysisHtml` · `MCQ_TYPES` / `SAQ_TYPES` / `TYPE_MAX` ·
`renderAccount`(잔액 표시) · `setEditMode`(결과물 직접 수정) · `printDoc` ·
`undoOnce` / `pushUndo`(되돌리기 — 결과 화면 HTML을 통째로 찍어 쌓는다. 글자 수정과 쪽 구성이
같은 스택을 쓴다) ·
`setPagingMode` / `layoutPages` / `raiseAllPages`(지문 분석 '쪽 구성' — 덩어리 `.pg-blk`
단위로 쪽 경계를 옮긴다. 인쇄에 남는 건 `data-brk`뿐이고, 쪽 높이는 `PAGE_H_MM`이
`@page`·`.print-foot` 값을 그대로 따른다. `raiseAllPages`는 '⤴ 전체 올리기' — `data-brk="page"`를
한 번에 모두 풀어 빈자리를 채운다. 지문 하나에 기본 강제 쪽 나눔이 서너 군데(`data-brk-def="page"`)라
지문을 여럿 넣으면 올릴 자리가 100군데를 넘어, 하나씩 누르는 길만으로는 감당이 안 된다.
`pg-head`(지문 시작)는 건드리지 않는다) ·
`getVocabSets` / `replaceAnalyzeVocabSets` / `appendVocabSet`(단어장 저장소 — 지문 분석·직접
입력·사진·PDF 네 출처가 같은 `vocabSets`를 쓴다. `src` 태그로 구분해, 재분석은 `src:"analyze"`
세트만 갈아 끼우고 나머지는 남긴다) ·
`LIBRARY`(저장함을 보는 창 셋 — `passage`(지문) · `tab`(한 탭 것만, 어느 탭인지는
`savedOnlyTab`이 정한다) · `material`(제작 자료 전부). 저장본은 `saved_items` 한 곳에
쌓이고 **보는 창만 다르다** — 저장할 때 어디에 넣을지 고르게 하지 않는다.
`tab` 창은 탭마다 있는 '📂 불러오기'(`<탭>LoadBtn`)와 시험지 탭의
'📂 저장한 구성 불러오기'(`examLoadSpecBtn`) · '📂 저장한 시험지 불러오기'(`examLoadPaperBtn`)가 연다.
시험지 탭은 저장 종류가 둘이다 — 만든 시험지는 `exam`, 기출 구성만은 `examspec`
(화면 탭이 없어 `SAVED_TAB_HOME`으로 `exam` 탭을 연다). 2026-09-27 전에는 구성만 저장한 것도
`exam`으로 들어갔는데, `savedTabOf`가 내용(시험지 없이 구성표만)·제목('기출구성')으로 가려 `examspec`으로 다룬다. 창 문구는 글자일 수도 함수일
수도 있어 `libWord`로 꺼내고, 기본 문구와 달라야 하는 탭만 `TAB_LIBRARY_WORDS`에
적는다) ·
`openSavedList` / `loadSavedItem` / `passageLoadTo` / `passageSaveFrom`(저장함도 저장
종류도 한 벌인데 **담고 꺼내는 칸만 바꾼다**. 불러온 지문이
들어갈 칸만 바꾼다 — 기본은 공용 지문칸이고, 시험지 탭의 '📄 저장함에서 가져오기'로
열었을 때만 시험 범위 칸으로 간다. 이 길은 `clearAllTabResults`를 타지 않는다 —
기출 유형표를 보면서 지문을 채우는 중이라 그 표가 지워지면 안 된다) ·
`vocabEditorOpen` / `runVocabOcr` / `runVocabPdf`(단어장 직접 입력·사진·PDF — 인식 결과는
바로 저장되지 않고 편집 표를 거쳐 "이 단어장에 추가"를 눌러야 확정된다)

지문 칸 상한은 `MAX_PASSAGES`(40, 공용)와 `EXAM_PAPER_MAX_PASSAGES`(100, 시험지)입니다.
시험지 쪽이 큰 까닭은 거기 지문이 '골라 쓰는 풀'이라 늘려도 요금·시간이 문항 수 그대로이기
때문입니다(2026-09-27에 40 → 100). 두 상한이 달라서 저장본을 작은 칸으로 불러오면 넘친 만큼
빠지는데, `setJobs`가 빠진 수를 돌려주고 `passageDropNote`가 알립니다.
많이 담은 채 실행하면 시간이 지문 수만큼 곱해지므로 `costConfirmed`가 실행 직전에
한 번 더 알립니다(`MANY_PASSAGES_WARN`).

### `public/index.html`

탭 6개 — `analyze`, `mcq`, `saq`, `workbook`, `vocab`, `exam`.

그중 **둘은 서버가 허락해야 보입니다** — `exam`(동형 모의고사 제작,
`examTabBtn`)과 그 뒤에 붙는 `students`(반/학생 관리, `studentsTabBtn`)입니다.
`exam`은 2026-09-27부터 모든 회원에게 보이고(`EXAM_OPEN_TO_ALL`), `students`는 여전히
관리자가 승인한 선생님에게만 보입니다.
`renderAccount`가 각각 `examApproved`·`classroomApproved` 값으로 `hidden`을 켜고 끕니다.
승인이 꺼졌는데 마침 그 탭을 보고 있었다면 `hideExamTab`이 첫 탭으로 물러나게 합니다 —
단추만 감추면 화면이 남아 계속 쓸 수 있는 것처럼 보이기 때문입니다.
각각 `#tab-<id>` 섹션과 `#analyzeBtn` / `#mcqBtn` / `#saqBtn` / `#wbBtn` 실행 버튼을 가집니다.

### 검색으로 들어오는 문 — `public/*.html` 소개 페이지

`analyze` · `quiz` · `workbook` · `vocab` · `exam` · `faq` 여섯 쪽. 앱이 아니라
**검색 결과에서 눌러 들어오는 자리**라 `app.js`를 부르지 않고 가벼운 `page.css`
하나만 씁니다(까닭은 그 파일 맨 위 주석).

한 쪽짜리 앱이라 알릴 주소가 `/` 하나뿐이었고, 그래서 검색에서 잡을 수 있는 말도
그만큼밖에 없었습니다(서치콘솔이 '발견된 페이지 1'이라고 알려 줍니다). 선생님이
실제로 치는 말마다 쪽을 하나씩 두어 그 수를 늘린 것입니다.

- **새 쪽을 만들면 `public/sitemap.xml`에 반드시 함께 적으세요.**
- **어디서도 연결되지 않은 쪽은 사이트맵에 적어도 좀처럼 순위에 오르지 않습니다.**
  `index.html` 푸터(`site-footer-links`)와 각 쪽의 `.more` 칸이 그 연결입니다.
- `%%ASSET_V%%` 같은 치환 표시를 쓰면 안 됩니다 — `server.py`는 그 치환을
  `index.html`에만 해 주므로 다른 쪽에서는 글자 그대로 남아 깨진 주소가 됩니다.
- **요금 숫자를 적지 마세요.** 아래 '가격은 예외입니다' 항목과 같은 이유입니다.

### `public/student.html` + `public/student.js`

학생용 화면. `index.html`/`app.js`와 완전히 분리된 로그인(코드 입력, `student_session`
쿠키)·탭 전환 없는 단일 페이지입니다. `admin.html`처럼 정적 파일이라 서버에 경로
등록이 필요 없습니다. 지금은 같은 Render 서비스 안에서 경로만 나뉘어 있고, 나중에
필요하면 별도 배포로 떼어낼 수 있게 설계했습니다.

## 반드시 함께 고쳐야 하는 쌍

같은 표가 서버와 화면 양쪽에 있습니다. 한쪽만 고치면 **조용히 어긋납니다** — 화면이 허용한
요청을 서버가 잘라내거나, 가격이 문항 수에 걸려 있어 요금이 틀어집니다.

| `server.py` | `public/app.js` |
|---|---|
| `QUIZ_TYPE_MAX` | `TYPE_MAX` (안내 문구는 `TYPE_MAX_REASON`) |
| `QUIZ_TYPE_LABELS` | `MCQ_TYPES`, `SAQ_TYPES` |
| `MCQ_ONLY_TYPES` | `MCQ_TRANSFORM_TYPES` |
| `WORKBOOK_STAGE_IDS` | `WB_STAGES`의 id — 워크북 요금이 단계 수에 걸려 있다 |
| `EXAM_MAX_PAGES` | `EXAM_MAX_PAGES` — 기출을 여러 부 쌓으므로 한 부의 서너 배가 든다 |
| `QUIZ_HARD_RULES` 8~12번(주관식 유형) | `SAQ_HARD_TYPES` — 주관식 고난도가 되는 유형. 화면이 이 목록 밖의 유형은 고난도로 보내지 않는다 |
| `RECHARGE_AMOUNTS` | `index.html`의 `recharge-preset-btn` 금액 단추 — 금액 직접 입력은 카카오페이 입점 조건 때문에 뺐다(2026-09-27) |

**`outline`(주제 & 흐름 요약)은 두 자료가 같은 것을 만듭니다.** 규칙은
`_OUTLINE_RULES` 한 벌뿐이고 `SYSTEM_PROMPT`와 `BRIEF_SYSTEM_PROMPT`가 나눠 씁니다 —
**그러니 여기를 고치면 상세분석과 소책자가 함께 바뀝니다.** 2026-09-05에 합쳤습니다.
그전에는 양쪽에 따로 적어 두었는데 글이 조금씩 갈리면서 실제로 결과가 달라졌습니다.
다른 것은 **그리는 방식뿐입니다** — 상세분석은 상자를 두 줄로, 소책자는 한 줄로 눌러
그리고 문장 번호를 상자가 직접 듭니다(`public/app.js`의 `buildOutlineHtml` ↔
`buildBriefHtml`).

소개 페이지에도 같은 표가 **한 벌 더** 옮겨져 있습니다. 검색으로 들어온 분께
화면에 없는 유형을 광고하게 되므로 함께 고치세요.

| 출처 | 옮겨 적은 곳 |
|---|---|
| `QUIZ_TYPE_LABELS` / `MCQ_ONLY_TYPES` | `public/quiz.html`의 유형 목록(객관식 23 · 주관식 18) |
| `WORKBOOK_STAGE_IDS` / `WB_STAGES` | `public/workbook.html`의 9단계 |

**화면을 바꾸면 '만드는 법'도 같은 커밋에서 고치세요.** 탭마다 뜨는 [❓ 만드는 법] 창의
글은 `public/app.js`의 `HOWTO`에 손으로 적혀 있어, 화면과 자동으로 맞춰지지 않습니다.
단추를 더하거나 이름·순서를 바꾸거나, 선택지·칸이 생기거나 없어지거나, 선생님이 알아야 할
기능이 늘면 **그 즉시** 해당 탭의 `steps`/`tip`을 고칩니다 — 나중으로 미루면 쌓입니다
(2026-09-26에 한 번에 고쳤을 때 동형 모의고사는 단추 이름부터 틀려 있었습니다).
적은 단추 이름은 `index.html`의 실제 글자와 한 글자도 다르지 않아야 합니다(`＋`처럼 전각 기호 포함).
고친 뒤에는 브라우저에서 `openHowto('<탭>')`로 창을 열어 확인하세요.
창 아래 '이런 자료가 나옵니다' 예시 중 상세분석·객관식·주관식·워크북은 **실제 결과물 PDF의
쪽 그림**(`public/howto-<탭>-N.jpg`, `samplePagesHtml`)이라, 인쇄물 모양이 눈에 띄게 바뀌면
저절로 따라오지 않습니다 — PDF를 새로 뽑아 그림을 갈아 끼우세요(원본은 저장소 밖 `홍보/`의
2026-09-20 홍보용 PDF 네 개). 요약분석·단어장·동형 모의고사 예시는 코드가 그 자리에서 그려서 알아서 따라갑니다.

**약관을 고치면 판 번호도 함께 올리세요.** `public/terms.html`의 시행일과 `server.py`의
`TERMS_VERSION`은 같은 값이어야 합니다. 가입할 때 "이 사람이 어느 판에 동의했는지"를
계정에 적어 두는데, 번호를 안 올리면 옛 판에 동의한 사람과 새 판에 동의한 사람이
기록상 구분되지 않습니다. `public/refund.html`의 시행일도 같이 맞춥니다.

**가격은 예외입니다.** 서버가 유일한 출처이고 화면은 `/api/pricing`으로 받아 씁니다.
화면 쪽에 가격 숫자를 하드코딩하지 마세요.

## API 엔드포인트

**GET** — `/api/pricing` `/api/me` `/api/saved` `/api/saved/<id>` `/api/usage` `/api/admin/me`
`/api/admin/users` `/api/admin/usage`
`/api/classes` `/api/students` `/api/vocab-tests` `/api/vocab-tests/results`(선생님 쪽,
반/학생/시험 — `classId`/`assignmentId`를 쿼리 문자열로 받습니다)
`/api/student/me` `/api/student/tests` `/api/student/tests/detail`(학생 쪽,
`student_session` 쿠키로 인증)

**POST** — `/api/analyze` `/api/quiz` `/api/workbook` `/api/reword` `/api/ocr` `/api/pdfsplit`
`/api/examscan`(기출 시험지 → 문항 유형표) `/api/examtrend`(시험지 분석 리포트 총평 — 보고서 1건당 정액) `/api/examocr`(같은 쪽 그림 → 영어 지문. 둘 다 `_exam_approved` 확인 — 지금은 모두에게 열림)
`/api/vocabocr` `/api/vocabpdf` `/api/models`
`/api/auth/google` `/api/auth/signup` `/api/auth/verify` `/api/auth/login` `/api/auth/delete`
`/api/logout` `/api/account/recharge` `/api/account/recharge/confirm` `/api/account/ack-update`
`/api/portone/webhook`(포트원 → 서버. 로그인·세션이 없는 유일한 POST다)
`/api/saved` `/api/saved/delete` `/api/saved/rename`(이름만 바꾼다 — `rename_saved_item`)
`/api/admin/login` `/api/admin/logout` `/api/admin/recharge` `/api/admin/approve-classroom`
`/api/classes` `/api/classes/regenerate-code` `/api/students` `/api/students/delete`
`/api/vocab-tests` `/api/vocab-tests/delete`(선생님 쪽 — 위 GET들과 경로가 같은 것도 있음,
GET=조회/POST=생성. `/api/vocab-tests`에 `studentId`를 실으면 그 학생 한 명에게만 낸다)
`/api/student/login`(`name`만 — 반 코드 없이 이름만으로 로그인) `/api/student/logout`
`/api/student/tests/submit`

## 업데이트 소식(로그인 시 플로팅 창)

교사가 새 기능을 알아채도록, 로그인(또는 세션이 살아 있는 새로고침)마다 서버가
`server.py`의 `CHANGELOG`(`_account_payload` 바로 위) 중 그 계정이 아직 못 본 항목을
`/api/me`·로그인 응답의 `updates`에 실어 보냅니다. 화면은 `public/app.js`의
`showUpdatePanel`이 오른쪽 위 카드로 띄우고, "확인했습니다"를 누르면
`/api/account/ack-update`가 그 계정의 `last_seen_changelog`를 갱신해 다음부터
안 뜹니다(계정에 남기지 localStorage가 아닙니다 — 파일 맨 위에서 열 때마다
localStorage를 통째로 비우기 때문입니다).

**사용자가 눈에 띄게 체감할 기능을 배포할 때는 `CHANGELOG`에 새 항목을 추가하세요**
(`version`을 1씩 늘리고, `date`와 교사가 이해할 수 있는 한두 문장의 `items`를 적습니다).
내부 버그 수정·리팩터링처럼 화면에 드러나지 않는 변경은 넣지 않습니다.

소식은 **올린 지 `CHANGELOG_MAX_AGE_DAYS`(7일)가 지나면 저절로 안 뜹니다**
(`_changelog_fresh`). 오래 안 들어온 선생님에게 두 달 치가 한꺼번에 쏟아지면 읽지 않고
닫게 되고, 정작 어제 바뀐 것을 놓치기 때문입니다. 안 뜨게 된 항목은 목록에서 지워도
됩니다 — `last_seen_changelog`는 번호로만 견주므로 아무것도 어긋나지 않습니다.
`version` 번호는 지운 뒤에도 이어서 늘립니다.

## 하지 말 것

- **모델을 사용자가 고르게 만들지 마세요.** 기능마다 서버가 고정합니다 —
  `/api/quiz`는 고른 유형에 `QUIZ_PLAIN_PASSAGE_TYPES` 밖의 것이 **하나라도 섞이면**
  그 호출 전체가 `GEMINI_MODEL_PRO`(Pro)로 갑니다(객관식·주관식 구분 없음).
  객관식 탭의 난이도 **고난도**(`difficulty: "hard"`)도 유형과 상관없이 Pro이고,
  지시문 뒤에 `QUIZ_HARD_RULES`가 붙습니다(기본은 지시문·모델 모두 예전 그대로).
  지문변형 heavy도 Pro이고, 시험지 스캔을 읽는 `/api/examscan`·`/api/examocr`도 Pro입니다
  (글자가 흐리고 쪽마다 방향이 달라 여기서 잘못 읽으면 이후가 통째로 어긋납니다).
  나머지는 전부 `GEMINI_MODEL`(Flash)입니다.
  정찰 가격과 실제 원가가 어긋나지 않게 하기 위한 설계입니다.
- **`sanitize_*` / `clean_*`를 우회하지 마세요.** AI가 만든 HTML을 브라우저에 그대로
  넣는 구조라 이 함수들이 유일한 방어선입니다.
- **잔액 차감 시점을 바꾸지 마세요.** 요청 전에 잔액을 확인하고(부족하면 Gemini를 아예
  부르지 않음), **생성이 성공했을 때만** 차감합니다. 실패한 시도에 요금이 나가면 안 됩니다.
- **비밀값을 파일에 쓰지 마세요.** `.gitignore`가 `.env*`와 `service-account*.json`을
  막아두었지만, 코드 안에 박아 넣는 건 막지 못합니다. `origin`은 공개 저장소입니다.
- **`git push`는 곧 배포입니다.** Render가 `origin/main`의 push를 받아 자동 재배포합니다.
  사용자가 명시적으로 요청하지 않으면 push하지 마세요.
- **결제는 2026-09-02에 실연동으로 열렸습니다.** 예전에 여기 있던 "결제 코드는 올리면
  안 된다"는 금지는 풀렸습니다 — 실서비스(Render)의 `PORTONE_*`은 KG이니시스 실연동
  채널 값이고, 실결제로 충전·취소가 도는 것까지 확인했습니다. 다만 **로컬 환경변수는
  여전히 테스트 채널 값**이라, 로컬과 실서비스의 값이 다르다는 점을 잊지 마세요
  (위 "로컬 서버도 실서비스 Firestore를 씁니다" 항목 참고).
  카드사 심사는 10곳 중 5곳(롯데·BC·삼성·신한·NH)만 등록됐고 하나·우리·현대·국민·
  하나SK는 진행 중이라, **그 카드로는 아직 결제가 안 됩니다**(2026-09-02 기준).
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

## 문서와 코드가 어긋난 곳

작업 중 헷갈리지 않도록 적어 둡니다. **코드를 출처로 삼고**, 문서를 손볼 일이 생기면 함께 맞추세요.

지금은 알려진 것이 없습니다. (`DEPLOY.md`가 "선생님마다 본인 Gemini 키를 화면에
입력"하는 옛 방식으로 쓰여 있었는데, 2026-08-28에 지금 구조 — 관리자 키 하나 공유·
로그인 필수·포인트 차감 — 로 다시 썼습니다.)
