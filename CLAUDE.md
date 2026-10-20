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
`deleted_accounts`, `admin_sessions`, `payment_intents`, `saved_images`(요약 이미지 — 저장본에 딸린 그림), `brand_marks`(학원 마크 — 문서 `{uid}`=학원명, `{uid}__logo`·`{uid}__wm`=그림. `/api/brand` GET/POST, 화면 `brandPull`(로그인 때 받기)·`brandPush`(**[💾 계정에 저장] 단추를 눌렀을 때만** 바꾼 칸을 올린다 — 2026-10-19 사용자 결정, 처음엔 바꿀 때마다 저절로 올렸다)·`brandClearLocal`(로그아웃 때 화면에서 지우기), 그림은 `shrinkBrandImage`로 줄여 보낸다. 탈퇴 때 함께 지운다).

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

**학생 로그인은 선생님이 정해 준 아이디 + 비밀번호입니다**(2026-10-12 — 이전엔 이름만
입력하면 로그인돼 비밀값이 없었다). 선생님이 등록할 때 이름·아이디·비밀번호를 직접
정하고(`create_student`), 이후 `update_student`(`/api/students/update`)로 셋 모두
고칠 수 있다 — 비밀번호를 잊은 학생은 선생님이 새로 정해 주는 것이 '초기화'다.
학생도 직접 바꿀 수 있고(`change_student_password`, `/api/student/password`) 그러면
`pw_set_by`가 `student`가 되어 선생님도 모르는 비밀번호가 된다. 비밀번호는 `_hash_password`
해시로만 저장해 **선생님도 현재 값을 볼 수 없다**(등록 때 따로 적어 두라고 화면이 안내한다).
아이디는 **앱 전체에서 유일**하다 — `student_login_ids` 컬렉션(문서 ID = 아이디)에
`create()`로 선점해 동시 요청에도 한쪽만 통과한다(`_claim_login_id`/`_release_login_id`).
형식은 영문 소문자·숫자·`.`·`_`·`-` 3~20자, 비밀번호는 4~64자이고 **영문 대소문자를 구분하지 않는다**(`_pw_key` — 해시 전·대조 전에 소문자로 바꾼다). 등록 화면에는 비밀번호 칸이 없고 **항상 `STUDENT_PW_DEFAULT`(`1234`)로 등록된다**(서버는 `password`가 비면 기본값을 쓰고, 보내면 그 값을 쓴다). 학생이 한 번도 직접 바꾸지 않았으면(`pw_set_by != student`) 로그인 응답의 `pwChanged`가 false라 화면이 비밀번호 변경 안내창을 띄운다. **이름은 이제 화면에
보이는 용도일 뿐이라 겹쳐도 된다**(동명이인 허용). 아이디나 비밀번호가 바뀌면 그 학생의
기존 세션(`student_sessions`)을 지워 로그인을 끊는다. 무차별 대입 방지는 아이디별
5회/5분 + IP별 40회/5분을 함께 건다(`_student_login_blocked` — 한 교실이 같은 IP로
보이므로 IP만 보면 반 전체가 잠긴다). 아이디/비밀번호 어느 쪽이 틀렸는지는 일부러
같은 문구로 답한다. 반 이름 변경(`rename_class`)·삭제(`delete_class` — 딸린 학생·시험·답안·반 코드를 함께 지운다)와 학생의 반 이동(`update_student`의 `class_id` — 옮겨 갈 반이 내 반인지 확인, 이전 반에서 낸 시험의 답안은 그 시험에 남는다)이 있다. `class_codes`/반 코드를 만드는 코드는 서버에 남아 있지만
(`create_class`/`regenerate_class_code`) 로그인에 쓰이지 않아 **교사 화면에서는 뺐다.**
**배포 후 옛 학생(이름만 있고 `login_id` 없는 문서)은 로그인할 수 없다** — 기존 기록은
지우기로 했다(2026-10-12).

단어시험은 **반 전체**에 낼 수도, **학생 한 명**에게만 낼 수도 있습니다
(`create_test_assignment`의 `student_id` — 없으면 반 전체, 있으면 그 학생만).
`list_tests_for_student`·`get_test_detail_for_student`·`grade_and_submit_attempt`는
전부 `_assignment_targets_student`로 이 배정 대상을 확인합니다 — 반이 같아도
다른 학생 한 명에게만 낸 시험은 안 보입니다.
시험 내기 창의 '낼 단어장'은 체크 목록이라(`assignVocabSourceList`, 2026-10-19) 지금 화면의 단어장과
저장한 단어장 **여러 개를 한 시험으로 합쳐** 낸다 — `recomputeAssignVocabRows`가 목록 차례대로
잇고 같은 단어(대소문자 무시)는 처음 것 하나만 둔다. 둘 이상 고르면 **'단어장마다 따로 시험 내기'**(2026-10-20, `assignVocabGroups`/`assignVocabEach`)도 고를 수 있다 — 단어장마다 `/api/vocab-tests`를 한 번씩 부르고 단어장 이름이 시험 제목이 된다. 저장본을 펼칠 때는 `savedVocabOn`이 `off`인 단원을 뺀다(책 통째 저장본이 1,800단어로 나왔다). 서버는 단어 목록만 받으므로 바뀐 것이 없다.

**성적표**(2026-10-12): 채점할 때(`grade_and_submit_attempt`) 문제마다 번호·문제·내 답·정답·맞음을
`test_attempts` 문서의 `details`에 함께 저장한다(이 값이 없는 옛 답안은 `hasDetails:false`로 표시).
그걸로 ① 학생 결과 화면의 '틀린 단어'(`wrongItems`, `get_result_for_student` —
`/api/student/tests/result`) ② 시험별 성적표(`list_attempts_for_assignment` — 대상 학생을 모두
싣고 안 낸 학생은 '미제출', 삭제된 학생의 답안은 `removed`로 남는다) ③ 학생별 성적표
(`get_student_report` — `/api/students/report`, 시험별 결과 + 모든 시험을 합친 '자주 틀린 단어')를
만든다. 학생 표의 '최근 성적'은 `list_students`가 `_class_tests_and_attempts`로 반의 시험·답안을
한 번에 읽어 계산한다(시험 수만큼 쿼리). **인쇄본에는 틀린 단어를 싣지 않는다**(2026-10-15 사용자 결정 — 시험별 성적표의 틀린 단어 펼치기·학생별의 자주 틀린 단어 모두 화면 전용). **반 전체 월간 성적표**(`classReportPrintBtn`)는 학생마다 `/api/students/report`를 4개씩 나눠 받아 `studentReportPrintableHtml`을 `.rp-batch-page`(쪽 나눔)로 이어 인쇄 창 하나에 담는다 — 코멘트는 규칙 초안, 같은 달로 열어 고친 코멘트가 있으면 그 글. 학생별 성적표는 **월간**이 기본이다 — 화면의 월 선택(`<input type=month>`)이 그 달의 시작·끝을 한국 시간
기준 ISO 시각으로 바꿔 `start`/`end`로 보내고(`reportPeriod`), 서버(`get_student_report`)는 그 기간에
제출한 회차만 센다(시간대는 서버가 추측하지 않는다). 기간 안에 만들어졌는데 안 본 시험은 '미응시'로 싣는다.
화면은 시험별 막대그래프(`reportChartSvg` — 막대=기간 내 최고 점수, 빨간 선=합격선, 검은 눈금=첫 시도)와
코멘트 초안(`buildReportComment` — 평균·추이·만점·재시험·미통과·미응시·자주 틀린 단어를 규칙으로 이어 쓴
것, **AI를 안 불러 요금이 없다**)을 기본으로 채워 두고, 성적표의 **[✨ AI로 코멘트 쓰기]**는 `/api/studentcomment`(`call_gemini_student_comment`, Flash 고정, `PRICE_STUDENT_COMMENT_KRW` 기본 50P, `_classroom_approved` 확인)로 더 자연스러운 글을 쓴다. **학생 이름은 AI에 보내지 않는다**(미성년자 개인정보) — 프롬프트가 이름 자리를 `{학생}`으로 쓰게 하고 화면이 이름으로 바꿔 넣는다. 서버 가격은 `/api/pricing`의 `studentComment`로 내려가 버튼 옆에 표시된다. 코멘트는 선생님이 고친 뒤 인쇄할 수 있다. 인쇄는 `openPrintWindow`(새 창)이고, **디자인은 시험지 분석 리포트(`trend.js`)와 같은 틀을 빌려 쓴다** — `TREND_CSS`(표지 머리 `.rp-head`·숫자 카드 `.trend-tile`·번호 소제목 `h4.sec`)와 학원 마크·워터마크 설정(`trendBrand`/`trendBrandPrintCss`/`trendBrandPrintBody`)을 그대로 쓰고, 성적표에만 필요한 CSS는 `app.js`의 `REPORT_CSS`에 더했다. 월간·시험별 두 성적표가 `reportHeadHtml`/`reportTilesHtml`/`statusTagHtml`을 같이 쓴다. **분석 리포트 CSS를 고치면 성적표도 함께 바뀐다**(`trend.js`가 `app.js`보다 나중에 로드되지만 호출은 클릭 때라 문제없다). 화면은 `public/app.js`의
`renderTestResults`/`renderStudentReport`/`studentLastScoreHtml`.

**재시험**: `create_test_assignment`의 `max_wrong`(없으면 1회로 끝, 있으면 "이
개수 이하로 틀려야 합격")을 기준으로 `_attempt_progress`가 합격 여부·합격 회차·
다음에 볼 회차를 계산합니다. `test_attempts` 문서 ID는 `{assignment_id}_{student_id}_{round}`로
회차마다 따로 쌓이고(옛 시험은 회차 개념이 없던 시절 문서라 `round` 필드가 없는데,
`_get_student_attempts`가 조회할 때 `round=1`로 취급해 예전 데이터도 그대로
호환됩니다), `_build_student_questions`도 시드에 `round`를 넣어 재시험마다 순서·
방향·객관식 보기를 다시 섞습니다 — 떨어진 회차의 보기 위치를 외워 통과하는 것을
막기 위해서입니다.

**문제 시험**(2026-10-12): 객관식·주관식·혼합 탭의 `[🏫 반에 시험 내기]`(`<prefix>AssignBtn`, 승인된 선생님 +
결과가 있을 때만 보인다 — `syncQuizAssignBtns`)로 만든 문제를 학생이 사이트에서 푼다. 단어시험과 **같은 컬렉션**
(`test_assignments`/`test_attempts`)에 `kind:"quiz"`로 들어가 반 삭제·학생 표·성적표가 그대로 함께 다룬다. 서버는
`create_quiz_assignment`(문항을 `_qt_clean_question`으로 다시 거른다 — HTML은 `sanitize_quiz_html`)·`_qt_student_view`(정답을 뺀
모양 — pick/verb/fill은 지문을 `segments`로 쪼개 칸 자리만 남긴다)·`submit_quiz_attempt`·`quiz_review`·`grade_quiz_unit`.
채점은 답 칸 하나씩(`_qt_units`) 하지만 **화면에는 점수를 보이지 않고 문항 단위 맞음·틀림 개수만**
보인다(`_qt_q_counts` → `qc`, 화면 `QT.countsText` — 사용자 결정. 문제 시험은 성적표의 점수 그래프·평균에서도 빠진다). 비교는 `_qt_key`(대소문자·따옴표·문장부호 무시, 철자는 본다).
`QUIZ_TEST_FREE_FORMATS`(조건 영작·문장 전환·질문에 답하기·짧은 서술)는 모범답안과 다르면 `ok:None`(확인 대기)로 두고
선생님이 결과의 [답안 보기]에서 [맞음]/[틀림]을 누른다(`/api/quiz-tests/grade`). **한 번만 응시**하고 제출 즉시 정답·해설을
보여 준다(사용자 결정). 답안은 `qdetails`에 담는다 — 단어시험의 `details`와 이름을 나눈 까닭은 `_wrong_items`·자주 틀린 단어가
`details`를 단어 기록으로 읽기 때문이다. 상태값은 합격/불합격 대신 `done`(제출). 문항 그리기는 `public/quiztest.js`(`window.QT`)
한 벌을 학생 화면(`student.js`의 `openQuiz`/`showQuizResult`)과 선생님 화면(`renderQuizTestResults`/`loadQuizAnswers`)이 같이 쓴다.
상한 `QUIZ_TEST_MAX_QUESTIONS`(100) — 화면 `app.js`에도 같은 이름의 값이 있다.
**학생 관리 탭의 [＋ 시험 출제]**(`goVocabTabBtn` → `openTestPicker`, 2026-10-20)는 저장해 둔 단어장·객관식·주관식·혼합·문법·워크북 저장본 목록을 띄우고, 고른 저장본을 받아 단어장이면 `openVocabAssign(id, 제목)`(그 저장본을 체크해 연다), 나머지는 각 탭의 시험 내기와 같은 변환(`quizQuestionsFromEntries` · 문법의 `looseOrder` · `wbQuestionsForStudents`+`settings.stages`)으로 `openQuizAssign`을 연다 — 탭을 열거나 화면의 작업을 건드리지 않는다(예전엔 단어장 탭으로 넘어가기만 했다). **워크북도 같은 길로 낸다**(`wbAssignBtn` → `wbQuestionsForStudents`, `source:"workbook"` — 목록 이름표만 다르다).
단계 하나 = 문항 하나로 그 단계의 문장을 모은다. 빈칸 완성·동사형·어법 고르기·어색한 곳 찾기는 문제 시험의
fill·verb·pick·fix 모양을 그대로 쓰고, 워크북 전용 모양 `QUIZ_TEST_WB_FORMATS`(read=좌지문 우해석·채점 없음 /
order=순서 배열·자동 / wbwrite=영작 연습·다르면 확인 대기 / paraorder=문단 배열)를 더했다. **해석 연습하기는 뺀다**(답이
여러 모양 — 2026-10-12 사용자 결정). 문단 배열 섞기는 인쇄본과 같아야 해서 `wbParaParts`, 어색한 곳 본문은 `wbFixBodyHtml`로 떼어 함께 쓴다.

## 코드 지도

줄 번호는 수정할 때마다 밀리니 **심볼 이름으로 찾으세요.**

### `server.py`

| 찾을 것 | 앵커 |
|---|---|
| 환경변수·기본값 | 파일 상단 `HOST` ~ `PRICE_OCR_KRW` |
| 가격 계산 | `_quiz_type_base_price`, `_quiz_action_cost`, `_workbook_cost`(단계 수 × 단가, 상한 있음) |
| 포인트 원장(이용 내역)·유상무상 구분 | `POINT_LEDGER`, `_split_balance`, `charge_krw`, `add_krw`, `list_usage`, `_fold_old_ledger` |
| 유상 포인트 소진기한(5년) | `PAID_POINT_EXPIRE_YEARS`(일수가 아니라 햇수 — 윤일 때문에 1825일은 5주년보다 하루 이르다), `_plus_years`, `_paid_expiry`(KST 기준으로 잡는다), `_paid_lots`(충전분을 묶음으로 회원 문서에 둔다 — 원장은 18개월이면 접히는데 기한은 5년이라), `_draw_paid_lots`(기한 이른 것부터 쓴다), `_due_paid_lots`, `expire_due_paid`(cron이 없어 `_account_payload`에서 겸사겸사 훑는다) |
| 휴면계정(1년 미접속 → 전환, 30일 전 메일 통지) | `DORMANT_AFTER_DAYS`/`DORMANT_NOTICE_DAYS`, `_touch_login`(create_session 한 곳에서 last_login을 적고, 휴면이면 즉시 깨운다), `_touch_active`(세션이 30일 가므로 로그인 때만 적으면 매일 쓰는 회원도 last_login이 멈춰 휴면 판정이 틀어진다 — `_session_user`가 하루 한 번 `_touch_login`을 불러 접속일을 갱신한다), `sweep_dormant_accounts`(cron이 없어 `_account_payload`에서 하루 한 번 훑는다 — `_sweep_due`가 간격을 막는다), `_send_dormant_notice`(**통지에 실패하면 전환하지 않는다** — 30일 전 통지는 전환의 전제 조건이다). 잔액은 건드리지 않는다 |
| 결제(포트원) — 결제창 열기 전 요청 생성 → 결제 후 서버가 직접 확인하고서만 충전 | `PORTONE_STORE_ID`/`PORTONE_CHANNEL_KEY_CARD`/`PORTONE_API_SECRET`, `create_payment_intent`, `confirm_payment_intent`(`payment_intents` 컬렉션, 브라우저가 보고하는 성공 여부를 그대로 믿지 않는다). **포트원 V2 응답의 필드 이름을 손볼 때는 스키마를 먼저 확인하세요** — `channel`을 `selectedChannel`로, 통화를 `amount` 안으로 잘못 읽어 실결제가 돈만 빠져나가고 충전이 안 되던 사고가 있었습니다 |
| 결제 취소 → 포인트 자동 회수(웹훅) | `PORTONE_WEBHOOK_SECRET`, `_verify_portone_webhook`(Standard Webhooks 규격 — 서명 대상은 `{id}.{시각}.{본문}`이라 **받은 그대로의 바이트**가 필요하다. 그래서 라우팅이 `_handle_post` 앞쪽, `raw`가 살아 있는 자리에 있다), `apply_payment_cancellation`(알림 금액을 믿지 않고 포트원에 다시 물어본다. 이미 쓴 포인트는 빼지 않고 남은 유상분에서만 회수하며, 누적 취소액 기준이라 같은 알림이 두 번 와도 한 번만 반영된다). 실패하면 일부러 200이 아닌 응답을 보내 포트원이 재전송하게 한다 |
| 반 · 학생 · 단어시험(AI 안 씀) | `_classroom_approved`/`set_classroom_approved`(관리자 승인 게이트), `create_class`/`regenerate_class_code`(반 하나당 코드 하나, `classes`/`class_codes` 컬렉션)/`create_student`/`delete_student`(`students` 컬렉션, 개별 코드 없음. `create_student`·`update_student`가 이름·아이디·비밀번호를 받고 아이디는 `student_login_ids`로 앱 전체 유일, `change_student_password`는 학생 본인용), `login_student`(아이디+비밀번호, 아이디별·IP별 실패 제한)/`create_student_session`/`_student_session_user`(학생 세션, `admin_sessions`와 같은 모양), `create_test_assignment`(`student_id`를 주면 그 학생 한 명에게만, 안 주면 반 전체에)/`_assignment_targets_student`(반 전체/개별 배정 판정, 조회·응시·제출 세 곳이 공유)/`_build_student_questions`(객관식 오답을 같은 단어장의 다른 뜻/단어에서 결정적으로 뽑음)/`grade_and_submit_attempt`(`test_assignments`/`test_attempts` 컬렉션, 문서 ID를 `{assignment_id}_{student_id}_{round}`로 고정해 그 회차의 중복 제출을 막음 — 재시험 기준은 아래 참고)/`_get_student_attempts`/`_attempt_progress`(합격 여부·합격 회차·다음 회차 계산)/`delete_assignment`(시험과 딸린 답안까지 삭제) |
| 동형 모의고사 제작 공개 범위 | **2026-09-27부터 모든 회원에게 열렸다** — `EXAM_OPEN_TO_ALL`(환경변수, 기본 켜짐)이면 `_exam_approved`가 늘 참이다. 다시 막으려면 Render에서 `EXAM_OPEN_TO_ALL=0` — 그때는 예전처럼 회원 문서의 `exam_approved`(관리자가 `/api/admin/approve-exam`으로 켠다)를 본다. `/api/examscan`·`/api/examocr`가 호출 앞에서 확인한다. 반/학생 승인(`classroom_approved`)과는 **별개의 플래그**다. 스위치가 켜져 있으면 `admin.html`의 모의고사 칸은 단추 대신 '전체 공개'로 보인다 |
| 동형 모의고사 상한 이벤트(2026-10-16까지) | `EXAM_EVENT_CAP_KRW`(9,900)/`EXAM_EVENT_UNTIL` — [📝 문제 제작] 한 번(여러 부 합쳐)에 받는 값의 **상한**. 문항마다 만들어질 때 받는 방식은 그대로다. 화면이 누를 때마다 `examRun`을 실어 보내고, 서버가 회원 문서의 `exam_event_run`에 그 누름의 누적액을 쌓아 `_exam_run_capped`로 깎는다(`_charge_and_send`에서 받기 직전에 다시 센다). 지어낸 `examRun`으로 상한을 무한히 쓰지 못하게 한 누름당 `EXAM_EVENT_RUN_MAX_Q`(120)문항까지만 상한이 걸린다. 끝나는 날이 지나면 저절로 꺼진다. 화면은 `public/app.js`의 `examEventCap`/`examRunPrice`/`examEventNote` |
| 단어장 칸 — 동형 모의고사 '시험 범위 단어장' + 문제 탭(객관식·주관식·혼합) 공용 지문칸 아래 '단어장'(2026-10-08) | 화면 `public/app.js`의 `createVocabBox(prefix, getTexts, scope)` 한 벌을 `examVocab`·`quizVocab` 두 칸이 쓴다(HTML id가 모두 `<prefix>…` — `From`/`FileBtn`/`File`/`Status`/`ClearBtn`/`ToSyn`/`ToBook`/`Hint`). `quizVocabWrap`은 `syncTabChrome`이 문제 탭에서만 보인다. `parseVocabLines`(칸에서 표제어·뜻·`= 유의어`를 꺼낸다 — 단어장 책의 `0001` 번호도 뗀다)/`vocabEntryRe`(흔한 변화형·숙어 자리표시까지 맞춘다)/`forText`(지문마다 나오는 단어만, 최대 30개)/`sync`(못 찾은 단어 안내)/`fillList`(단어장 탭 저장본에서 가져오기)/사진·PDF는 `/api/vocabocr`·`/api/vocabpdf`(칸에 붙여넣기·끌어다 놓기도 된다). 지문 저장본(`TAB_SAVE.passage`)에 `targetVocab`으로 함께 담긴다(`passageSaveFrom.vocab`/`passageLoadTo.vocab`). 문제 탭은 지문 변형 '원문 그대로'·'단어 변형' 세트에서 단어장 바꿔 싣기를 한다 — 단어 변형 세트는 `/api/reword`에 `fill:5`를 실어 단어장 단어를 먼저 바꾸고 모자란 만큼만 다른 낱말로 채우며(서버 `parse_reword_fill`·프롬프트 [C], 호출은 한 번이라 값 그대로), 단어장 칸이 비었거나 바꿔 싣기 체크가 꺼져 있으면 일반 단어 변형이다. `/api/quiz`의 `targetWords` → 서버 `parse_target_words`(`QUIZ_TARGET_WORDS_MAX` — 화면 `VOCAB_BOX_PER_PASSAGE`와 **같은 값**) → `build_quiz_user_prompt`가 `QUIZ_VOCAB_TYPES`가 섞였을 때만 지시를 싣는다(목표 어법과 같은 구조). 저장본에는 `targetVocab`(칸 글 그대로). 요금·모델 변화 없음. **단어장으로 지문 바꿔 싣기**: 체크박스 둘(`<prefix>ToSyn` ① 지문 속 단어장 단어 → 유의어, 줄 끝 `= 유의어` / `<prefix>ToBook` ② 지문에 없는 단어장 단어를 뜻이 같은 자리에 심기) → `swapBody`가 지문마다 `/api/reword`(variation `"vocab"`, `toSynonym`/`toVocab`)를 `runExamPaper`의 문항 만들기 **전에 한 번** 부른다(A·B형이 같은 바꾼 지문을 쓴다). 서버 `REWORD_VOCAB_SYSTEM_PROMPT`/`parse_reword_vocab`(`REWORD_VOCAB_SYN_MAX`·`REWORD_VOCAB_ADD_MAX` ↔ 화면 `VOCAB_BOX_SYN_MAX`·`VOCAB_BOX_ADD_MAX`), Flash, 값은 `PRICE_REWORD_KRW` 지문당. 바뀐 낱말은 `q.__variations` → `markVariations`(화면 형광, 인쇄 안 찍힘). 구성표의 `examMergeAdd`(**기출에 없는 유형 더하기**, 줄에 `added`)로 영영풀이 쓰기 같은 유형을 넣는다 — 총 문항 수를 고쳐도 더한 줄의 개수는 그대로 둔다. 2단계(지문 없이 단어장만으로 내는 문항)는 기출에 실제로 나오는지 보고 정하기로 함 |
| 지문 변형이 고르는 낱말의 범위 — 2022 개정 교육과정 기본 어휘(2026-10-20 사용자) | `curriculum_vocab_2022.csv`(교육부 [별책14] 영어과 교육과정 [별표 3]을 옮긴 것 — 3,000단어 = 초등 800·중학교·공통 1,200·고등 선택 1,000, 표제어·다른 철자·함께 실린 파생어). `_load_curriculum_vocab`(파일이 없으면 이 기능만 꺼진다)·`_curriculum_prompt(school)`(규칙 `REWORD_CURRICULUM_RULES` + 목록을 `/api/reword` 지시문 뒤에 붙인다 — 지시문 쪽이라 학교급마다 같은 앞부분이 캐시를 탄다. 중학교면 초등·중학교·공통만, 약 1만6천 자 / 고등 약 2만5천 자). AI가 **스스로 고르는** 낱말(단어 변형·[A] 유의어 없을 때·[C] 채우기)을 이 목록에서 **먼저** 고르게 한다 — 맞는 낱말이 없으면 목록 밖도 쓴다(사용자: "안에서만이 아니라 우선"). 중학교는 초등·중학교·공통 목록만 싣고 밖의 낱말도 중학생 수준으로, 선생님 단어장 단어·유의어는 목록 밖이어도 그대로 쓴다. 화면이 `/api/reword`에 `school`을 싣는다(문제 탭 학교급·동형 모의고사 `examSchoolEl`). 목록 밖으로 얼마나 나가는지는 `_curriculum_offlist`/`_curriculum_known`(굴절·흔한 접사·불규칙 짐작)이 Render 로그에 `[reword] 교육과정 밖으로 보이는 낱말`로만 남긴다 — 화면에는 안 보인다 |
| Firestore 연결 | `_load_firestore` |
| 회원가입·인증코드·비밀번호 | `start_signup`, `complete_signup`, `login_with_password`, `_hash_password` |
| 가입 동의(약관·개인정보·만14세) | `TERMS_VERSION`, `_consent_record`(화면을 거치지 않는 요청도 여기서 막는다), `upsert_user`(구글은 **계정을 새로 만들 때만** 동의를 따진다 — 로그인 창의 구글 버튼으로도 새 계정이 만들어지므로 화면이 아니라 서버에서 막아야 빠짐없다). 화면은 `public/app.js`의 `AGREE_BOXES`/`syncAgree`/`resetAgree` |
| Gemini 호출 공통(재시도·시간 예산) | `RETRY_MIN_WAIT`, `MAX_RETRY_TOTAL`, `_over_budget`, `RefineTrace`, `_parse_retry_delay`. 보정 예산 `REFINE_BUDGET`은 Render(`RENDER` 환경변수)에서 기본 55초, 로컬은 무제한 — 프록시가 약 100초에서 화면 연결을 끊기 때문(2026-10-13) |
| 끊긴 요청 다시 받기(값 두 번 안 내기) | `_hold_get`/`_hold_put`(다 만든 결과를 요청번호로 10분 보관), `_inflight_claim`/`_inflight_release`(**만드는 중**인 요청번호 — 같은 번호가 다시 오면 새로 만들지 않고 최대 `INFLIGHT_WAIT_SECONDS` 기다렸다가 결과를 주고, 그래도 안 끝났으면 409 `in_progress`). 화면은 `public/app.js`의 `postGenerate`(`GEN_WAIT_MAX`) |
| 원가 실측(Render 로그) | `_log_usage`(`[usage] <기능이름> <모델> 입력 N(캐시 N) · 출력 N · 생각 N`). 기능 이름표는 2026-09-27에 넣었다 — 이전에는 모델 이름만 찍혀 어느 기능 호출인지 로그만으로 못 갈랐다. `_gemini_json`을 부르는 자리마다 `label="quiz"`처럼 넘긴다. 새 `call_gemini_*`를 추가하면 이 label도 함께 붙일 것 |
| Vertex AI로 부르는 길(청구처가 다르다 — **Flash 단가는 Vertex가 AI Studio의 2배**, Pro는 같다. 크레딧을 다 쓰면 끈다 — 2026-10-19 사용자 결정) | `GEMINI_VIA_VERTEX`(기본 꺼짐), `_vertex_credentials`(Firestore와 같은 서비스 계정), `_vertex_try`(실패하면 None → `_gemini_call_with_retry`의 `_post`가 AI Studio로 다시 보낸다. 권한·한도 오류면 잠시 Vertex를 건너뛴다. 붐빔(429)·5xx는 다시 보내며 버티는데, 한 요청의 1차 호출은 `VERTEX_RETRY_BUDGET`(Render 300초)까지, 둘째 이후 호출(분석 보정 등)은 `VERTEX_LATER_RETRY_BUDGET`(기본 30초)까지만 — 보정이 300초를 버텨 분석 하나가 345초 걸린 일이 있었다(2026-10-13). 차례는 `_VERTEX_CALLS`가 요청마다 센다). 그림은 Interactions API가 Vertex에 없어 `call_gemini_infographic`이 `vertex_data`로 `:generateContent` 모양을 따로 넘긴다. **구글 클라우드 무료 체험 크레딧이 AI Studio 요금에는 안 쓰여서 만든 길이다**(2026-11-02 만료). **회원별 원가 라벨**(2026-10-19): `_vertex_post`가 본문 앞에 `labels`(`teacher`=`_vertex_cost_tag(회원 id)`, `feature`=API 경로 끝)를 끼워 넣어(`_vertex_with_labels`) 구글 결제 보고서 '그룹화 기준 → 라벨'에서 선생님별·기능별 실제 원가를 볼 수 있다. 라벨은 요청마다 `_handle_post`가 정하고(`_vertex_set_labels`, 스레드별 값 — 일을 새 스레드로 넘기면 옮겨 줘야 한다, `call_gemini_vocab_pdf` 묶음 참고), Vertex로 간 호출만 잡힌다(AI Studio는 라벨을 안 받는다). 관리자 화면 회원 표의 이메일 아래 작은 글자가 그 회원의 `teacher` 값이다 |
| 기능별 프롬프트·스키마·호출 | `*_SCHEMA` / `*_SYSTEM_PROMPT` / `call_gemini_*` 3종 세트 — quiz, reword, ocr, workbook, vocab(`VOCAB_ITEMS_SCHEMA` 하나를 `call_gemini_vocab_ocr`/`call_gemini_vocab_pdf` 둘이 같이 씁니다). 지문 분석만 이름에 접두어가 없어 `GEMINI_SCHEMA` / `SYSTEM_PROMPT`입니다 |
| 시험지(스캔본)에서 읽기 — 쪽 그림을 Gemini에 직접 보낸다 | `call_gemini_exam_scan`/`EXAM_SCAN_SYSTEM_PROMPT`(발문만 읽어 유형표를 만든다 — **지문은 일부러 안 옮긴다**), `call_gemini_exam_ocr`/`EXAM_OCR_SYSTEM_PROMPT`/`normalize_exam_ocr`(그 구멍을 메우는 쪽. 지문만 옮겨 적고 발문·보기·각주·손글씨는 버린다), `EXAM_MAX_PAGES`. 둘 다 **Pro 고정**이고 `_exam_approved`를 거친다(지금은 `EXAM_OPEN_TO_ALL`로 모두에게 열림). 화면은 `public/app.js`의 `extractJpegs`(PDF 안의 JPEG를 그대로 꺼낸다 — 외부 라이브러리 없음)/`runExamScan`(유형 분석 — 3쪽씩)/`runExamOcr`(지문 옮겨 적기 — **2쪽씩 한 쪽 겹쳐**. 3쪽을 한 번에 보내면 글자를 빠뜨리는 것을 실측했다. 까닭은 그 함수 위 주석에 있다)/`passageKey`(같은 지문 가리기 — 앞머리와 꼬리 두 열쇠를 쓴다) |
| 기출 **여러 부**를 한 구성으로 합치기 | 쪽 그림마다 `doc`(몇째 부)이 붙는다 — 묶음이 부 경계를 넘지 않게 하고, 문항 번호 중복도 부마다 따로 센다(`seenByDoc`). 안 그러면 어느 시험지든 1·2·3번이 있어 **둘째 부가 통째로 버려진다**. `examDocNames`(부 이름) · `examDocScans`(이미 읽은 부 → 문항. 여기 있는 부는 다시 안 읽는다 — 한 부씩 올려 쌓는 길의 핵심이다) · `examShowScanResult`(한 부면 문항표, 여럿이면 합치기표) · `buildExamMergeRows`(**한 번이라도 나온 유형은 무조건 1문항**을 깔고 남는 자리만 빈도에 비례해 나눈다 — 평균만 내면 3년에 한 번 나온 유형이 반올림에서 사라지는데 정작 대비할 것이 그것이다) · `renderExamMerge`(부별 개수를 보여 주고 유형마다 ±로 고치게 한다) · `examMergeToQuestions`. 만든 시험지는 `examPaperSets`에 **쌓인다** — 저장본을 불러와 [📝 문제 제작]을 누르면 새 시험지가 불러온 것 뒤에 붙는다(B형을 이어 만드는 길). 따로 만들려면 `[🧹 만든 시험지 비우기]`(`clearExamPapers`) — 화면에서만 치우고 그 배분 조합은 `examAvoidPairs`에 남겨 `examUsedPairs`가 계속 피하며, `LOADED_SAVED.exam`을 지워 새 시험지가 불러온 저장본을 덮어쓰지 않게 한다 |
| 시험지 분석 리포트(탭) | **목표 문법 출제 확인**(2026-10-12): `/api/examscan`이 문항마다 묻는 문법 포인트(`grammar` — "관계대명사 whose"·"가정법 과거"…, `_exam_grammar`가 5개까지 정리)를 돌려주고, 탭의 `#trendGrammar`(목표 문법, 쉼표로 여럿, 저장본 `targetGrammar`)를 적으면 `trendGrammarHtml`이 핵심 요약 아래에 시험지별 출제 문항 번호·안 나온 문법·목표 밖 문법을 싣는다. 이름 맞대기는 `trendGrammarHit`(띄어쓰기·기호를 떼고 서로 품는지 + `TREND_GRAMMAR_ALIASES`, 목표에 영어 낱말을 짚었으면 그 낱말이 있어야 한다 — whose ≠ that). 문법 정보가 없는 시험지(이 기능 전 저장본)는 표에 '정보 없음'으로 적고, 보고서 아래 화면 전용 `trendGrammarEditHtml`(문항별 문법 — 어법·서술형 문항마다 목표 문법 단추 켜고 끄기·직접 적기, `q.grammar`에 들어가 저장본에 남는다)으로 채운다. 시험 범위 칸에 지문 저장본을 불러오면 그 저장본의 `targetGrammar`를 목표 문법 칸에 **합쳐** 넣는다(`passageLoadTo.grammarMerge` — 단원마다 차례로 불러오므로 덮어쓰지 않는다). **'기타'를 줄이는 길**(2026-09-30): 서버는 목록 밖 이름을 기타로 바꾸되 원래 이름을 `category_raw`로 남기고, 발문 프롬프트에 흔한 내신 발문 → 유형 짝을 적어 두었다. 화면의 `trendCat`은 ① 선생님이 고른 것(`catManual`) ② 목록 이름 ③ `category_raw`를 가까운 이름으로(`trendCatGuess`) ④ 기타면 발문(`prompt`) 낱말로 짐작(`TREND_CAT_RULES`) 순으로 정한다 — 저장본에 쓰지 않고 볼 때마다 계산하므로 규칙을 고치면 옛 저장본에도 반영된다. 그래도 남은 기타는 보고서 아래 화면 전용 `trendEtcHtml` 표에서 선생님이 분류를 고른다. 그 표에는 **문항 그림**도 붙는다 — `/api/examscan`이 문항마다 `page`(그 요청 안에서 몇째 그림)·`box`([ymin,xmin,ymax,xmax] 0~1000)를 돌려주고, 화면이 부 전체 쪽 번호 `pg`로 바꿔 담아 두었다가 `trendCropOf`가 쪽 그림에서 잘라 `q.crop`(폭 640px JPEG)에 둔다. 저장본에는 **기타 문항 그림만** `TREND_CROP_MAX`(8)장까지 담는다(Firestore 문서 1MB). 쪽 그림이 없는 부(저장본에서 불러온 것·통째 PDF)는 자를 수 없다. 유형은 `kind`(이 앱으로 만들 수 있는 유형)가 아니라 **`category`**(보고서용 — `server.py`의 `EXAM_REPORT_CATEGORIES`, 중·고등 내신 공통 24가지)로 센다. `/api/examscan`이 문항마다 둘 다 돌려주며(`normalize_exam_scan`이 목록 밖 이름을 "기타"로 바꾼다), 동형 모의고사 탭은 `category`를 쓰지 않는다. 그래서 중학교 시험지(대화문·영영풀이·어법 개수 세기)도 빠짐없이 세어진다. 인쇄 쪽 구성(2026-09-29 사용자 확정 — 그림 먼저): 1쪽 표지 + `trendDashHtml`(한눈에 보는 출제 현황 — 숫자 칸·유형별 막대·영역별 비중) / 2쪽 핵심 요약 + `trendDashExtraHtml`(범위별 출제율) + **시험지 분석 총평**·대비 전략 / (시험지가 둘 이상일 때는 **합친 '한눈에 보는 출제 현황'을 싣지 않고** 1. 시험지별 분석(`trendPerExamHtml` 카드) → 2. 시험지별 유형 변화 → 3. 유형 출제 현황 표(둘 다 `.rp-keep`) → 새 쪽에 핵심 요약·총평. 2026-09-30 사용자 결정) `trendPerExamHtml`(**시험지별 분석** — 시험지마다 카드 한 장: 문항 수·선다/서답·영역 도넛·유형 막대(모든 카드가 같은 눈금)·'이 시험에서만' 나온 유형, 머리 띠 색은 `TREND_EXAM_COLORS`. 1쪽 숫자가 모든 시험지를 더한 값이라 시험 하나하나가 안 보였다 — 2026-09-30 사용자) + 유형 출제 현황 표(둘이 한 쪽에 들도록 카드를 촘촘히 했다: 18유형·3부 924px), 이어서 `.rp-keep`으로 `trendChangeHtml` — **모든 유형**을 한 줄씩, 시험지별 막대를 위아래로 겹친 그래프(`trendChangeBarsHtml` — 막대 색은 **시험지마다 하나**(`TREND_EXAM_COLORS`, 첫 시험 빨강·둘째 파랑·셋째 초록…, 범례와 같은 색 — 유형 색+진하기로 가렸을 땐 범례와 안 맞아 헷갈렸다), 오른쪽에 처음→마지막 증감 ▲/▼를 검정으로). 처음·마지막 비교(`trendChangeSummary` — 늘어난·줄어든)는 핵심 요약의 한 줄로만 싣는다(상자로 따로 두면 막대의 증감과 겹치고, 22유형·3부에서 쪽을 넘었다). 2026-09-30에 꺾은선(많이 나온 3가지 → 모든 유형)을 거쳐 이 모양이 됐다 — 모든 유형을 선으로 그리니 열 개 넘는 선이 엉켜 못 읽었다. **꺾은선으로 되돌리지 말 것** + 유형 출제 현황 표 / `trendCoverageHtml`. **부의 차례는 이른 시험 → 나중 시험**이다 — `trendSync`마다 `trendAutoSort`가 부 이름의 학년도·학기·차수(중간=1차, 기말=2차, `trendTimeKey`)로 정렬한다(하나라도 못 읽으면 안 건드린다). 올린 차례대로 두었더니 2학기 분석 뒤에 1학기 저장본을 더한 보고서가 증감을 거꾸로 적었다(2026-09-30). 부 목록의 ↑↓로 고치면 `trendOrderManual`이 켜져 자동 정렬을 멈추고, 저장본에 `manualOrder`로 담긴다. 범위 표는 출제 지문을 읽지 않은 부의 칸을 아예 뺀다. 유형 출제 현황 표(`rp-types`)는 `.rp-keep`(break-inside:avoid)으로 쪽 사이에서 안 잘리게 하고 이름·구분을 한 줄로 펴 촘촘히 했다 — 24유형·6부가 657px로 한 쪽에 든다. 시험지 이름은 공통 앞·뒤 낱말을 뗀 `trendShortNames`로 줄여 쓴다(안 그러면 '2026학년도 1학기 1…'처럼 잘려 둘이 같아 보인다). 각 쪽이 A4 한 장(687×1017px)에 드는지 실측해 맞췄다 — 칸을 더하면 다시 잴 것(`.trend-pg`가 쪽을 나눈다 — 화면에는 쪽 넘김이 없다). 범위 표에는 **출제된 지문만** 싣고 안 나온 지문은 표 아래 범위별 목록으로 모은다. 범위는 합친 칸(rowspan) 대신 머리줄로 나눈다 — 합친 칸은 인쇄에서 쪼개지지 않아 앞 쪽이 통째로 비었다. 보고서 제목에 `trendSchool`/`trendSubject`(학교 이름·학년 과목 칸, 저장본에 함께 담긴다)를 찍고, 부 이름은 분석이 읽은 고사 이름(`scan.title`)으로 채운다(손으로 고친 이름은 `nameEdited`로 지킨다). **`public/trend.js` 한 파일**(app.js 뒤에 로드, app.js의 전역을 씀). 동형 모의고사 탭과 **상태를 나누지 않는다** — 올리기(`trendAddFiles`)·분석(`trendRun` — 서버는 `/api/examscan` 그대로)·집계(`trendStats`, `buildExamMergeRows` 재사용)·보고서(`trendHtml`)·저장이 이 탭 것이다. AI 글(시험지 분석 총평)은 집계표만 받아 쓴다 — `/api/examtrend`, `call_gemini_exam_trend`/`EXAM_TREND_SYSTEM_PROMPT`(Flash 고정, `_exam_approved` 확인). **값은 쪽당이다**(2026-10-20 사용자 결정 — 처음엔 보고서 1건 1,000P 정액이었는데 원가는 쪽 수를 따라가 3부를 범위까지 대조하면 손해였다): 이 탭이 `/api/examscan`·`/api/examocr`에 `trend:true`를 실어 보내면 서버가 `_trend_page_cost`로 유형 분석 1쪽당 `PRICE_TREND_SCAN_PAGE_KRW`(100P), 범위 대조(지문 옮겨 적기) 1쪽당 `PRICE_TREND_OCR_PAGE_KRW`(100P)를 받고, 총평은 `PRICE_EXAM_TREND_KRW`(300P). 쪽은 그림 한 장 = 1쪽, 통째 PDF는 `_pdf_page_count`로 그 안의 쪽 수다(부로 세지 않는 까닭: 사진은 한 번에 고른 묶음이 한 부라 시험지 몇 개인지 알 수 없다). 지문 옮겨 적기는 2쪽씩 한 쪽 겹쳐 읽으므로 화면이 이미 값을 낸 쪽(`d.ocrPaid`)을 `paidIdx`로 알려 빼게 한다. **동형 모의고사 탭은 `trend` 표시가 없어 그대로 무료다**(사용자 결정) — 표시를 빼고 보내면 무료로 읽힌다는 빈틈은 알고 둔 것이다(쪽당 원가 수십 원). 범위만 바뀌면 총평을 지우지 않고 `trendAiStale`로 안내만 한다(다시 쓰면 값이 또 나가므로). 시험 범위가 비어 있으면 지문을 읽지 않는다(`trendHasRange`), 저장본을 이어 붙일 때 범위는 가져오지 않는다. 승인은 동형 모의고사와 같다(`renderAccount`가 `trendTabBtn`을 함께 켜고 끈다). 저장은 저장함 tab `"trend"`(부별 문항 유형표 + AI 글, 쪽 그림은 안 담는다). `TAB_SAVE.trend`가 `beforeLoad`(하던 분석이 사라지니 묻는다)를 갖고, `loadSavedItem`은 이 탭 저장본을 불러올 때 다른 탭 결과를 지우지 않는다. `[➕ 저장한 분석 더하기]`가 `trendLoadMode="append"`로 여러 저장본을 이어 붙인다. 동형 모의고사 탭의 `[📂 분석 리포트에서 불러오기]`(`examLoadTrendBtn`)는 같은 저장본을 `savedLoadIntoExam`으로 가로채 `examApplyTrendItem`에 넘긴다 — 부마다 저장된 문항표(kind·engine·fit가 함께 들어 있다)를 `examDocScans`에 채워 합치기 표를 띄우고, 범위 지문은 시험 범위 칸에 넣는다(쪽 그림은 없어 지문 가져오기는 못 한다). `[📰 카드뉴스 만들기]`(`trendCardsOpen`/`trendCardsBuild`)는 같은 집계로 1080×1080 canvas 카드를 그려 PNG로 내려받게 한다(AI·요금 없음). 보고서 CSS `TREND_CSS` 한 벌을 화면과 인쇄 창(`trendPrint`, 새 창)이 같이 쓴다. 새 창이라 본문의 학원 마크(`.print-foot`)가 따라오지 않아 `trendBrandPrintCss`/`trendBrandPrintBody`가 따로 그린다 — 켜고 끄는 칸 없이 **넣은 것만** 찍는다 — 학원명·로고가 있으면 아래쪽(fixed + 같은 높이의 빈 tfoot, 그만큼 보고서를 zoom .95로 줄여 쪽 높이를 맞췄다), 워터마크 이미지(`BRAND_WM_STORE`, 학원 마크 칸의 `#brandWmFile` — 모든 탭이 같이 쓴다)가 있으면 뒷배경(쪽 전체). 다른 탭은 페이지를 그대로 인쇄하므로 `index.html`의 `#printWatermark`(style.css `.print-wm`, 인쇄에서만 fixed로 쪽마다 되풀이)가 같은 그림을 깐다. 학원 마크 입력 칸(`.brand-panel`)은 원래 이 탭에서 숨겨져 있어, `syncTabChrome`이 보고서의 `#trendBrandSlot`으로 옮겨 온다 — `trendRender`가 다시 그리기 전에 `moveBrandPanel(null)`로 꺼내 둔다(안 그러면 칸이 함께 지워진다). **시험 범위 대조**: 분석할 때 `trendReadPassages`가 `/api/examocr`로 출제 지문을 옮겨 적고(2쪽씩 한 쪽 겹쳐, `passageKey`로 중복 정리), `trendCoverage`가 시험 범위 지문(`trendRangeMgr` — 동형 모의고사 시험 범위 칸과 같은 `createPassageManager` 입력칸이라 이름·합치기·나누기·지문 저장·저장함/PDF 가져오기가 그대로 된다. 이름을 단 지문은 보고서에 그 이름으로 나온다. 지문 저장함에서 가져오면 `passageLoadTo.prepare`로 저장본 제목을 이름 앞에 붙여 "제목 · 본문1"이 되고, 보고서는 " · " 앞부분을 범위(저장본)로 보고 범위별 출제 수를 묶는다 — `prepare`는 `loadSavedItem`이 목적지 칸에 넣기 전에 부르는 선택 훅이다)과 세 낱말 묶음 겹침 비율(`TREND_MATCH_MIN` 0.3, 짧은 쪽 기준)로 짝을 짓는다. 지문 라벨의 번호(`trendLabelNos`)로 그 문항의 유형도 붙인다. 저장본(v2)에 부별 출제 지문과 범위를 함께 담는다 — 쪽 그림은 안 담으므로 지문을 안 읽고 저장한 부는 나중에 대조할 수 없다. **`trend.js`를 새로 만들었으므로 `_asset_version`의 파일 목록에 들어 있다** — 다른 정적 파일을 더하면 거기도 넣을 것 |
| 문법문제 출제 마법사(2026-10-20) | 화면 **`public/grammar.js` 한 파일**(app.js 뒤에 로드, trend.js와 같은 방식). 화면은 다른 탭과 같은 결(옅은 칸·①~⑤ 번호·파란 [문제 만들기])이다 — 처음엔 참고한 사이트처럼 STEP 머리줄·노란 [미리보기]였는데 그 사이트 티가 난다고 바꿨다(2026-10-20). ① 레벨(`GRAMMAR_GRADES` — 초등 고학년 · 중등 Level 1~3 · 수능 Level. 처음엔 초3~4·초5~6·중1·중2·중3·고등이었는데 다른 사이트를 따라 한 티가 난다고 바꿨다(2026-10-20). 목차의 `g`는 그대로 0=초등 저학년…5=고등이고, 레벨의 `lv`와 견준다) → STEP 2 문법 항목 → STEP 3 세부 분류(목차 `GRAMMAR_CATALOG` — 세부 항목마다 처음 배우는 학년 `g`와, 지문 모드에서 ✓를 다는 짐작용 정규식 `re`) → STEP 4 고른 항목(직접 적기도 된다) → STEP 5 객관식·주관식 개수(합 50까지, '고르게'/'항목마다 직접')·문제 모양(체크 + 🤖 AI가 그중 골라 섞기)·1단/2단. **목차는 화면에만 있다** — 서버는 세부 항목 이름을 글자로 받으므로 목차를 고쳐도 서버는 그대로다(이름은 '항목 › 세부'로 80자까지 — `parse_grammar_request`가 자른다). 수능 Level(`g: 5`) 항목은 고등 문법서(천일문 고등 GRAMMAR 101단원) 목차와 견줘 빠진 것을 채웠다(2026-10-20 — 동사 vs 준동사·that vs what·관계대명사 vs 관계부사 같은 수능 어법 판별 항목 포함). 흔한 낱말로만 걸리는 항목(that/what 등)은 지문 ✓ 짐작식 `re`를 일부러 두지 않는다 — 모든 지문에 ✓가 붙는다. 서버 `/api/grammar` → `parse_grammar_request` → `call_gemini_grammar`(문항 자리 `_grammar_slots`를 `GRAMMAR_CHUNK`(5)개씩 나눠 **동시에** Flash로 부르고(처음엔 10개씩이었는데 한 묶음이 40~120초 걸려 실서비스에서 연결이 자주 끊겼다 — 2026-10-20, 문항 하나에 약 6~8초), 묶음마다 문장 소재 `_GRAMMAR_THEMES`를 달리 주며, 같은 문장 `_grammar_qkey`는 빼서 빠진 자리와 함께 한 번 더 채운다). 문항은 **문제 시험과 같은 format**(mc·verb·fill·fix·convert·write·compose)으로 `_grammar_finish` → `_qt_clean_question`을 거쳐 나가므로, 화면은 문제 탭의 `buildQuizHtml`로 그리고 [🏫 반에 시험 내기]도 `openQuizAssign` 그대로다(`gkind`는 값을 셀 때 쓰는 표시라 시험에는 빼고 보낸다. 한 문항만 AI로 다시 만드는 [🔄 이 문제 다시]는 2026-10-20에 뺐다 — 한 문항에 지시문을 통째로 보내 값을 따로 매겨야 해 선생님이 납득하기 어려웠다. 마음에 안 드는 문항은 [✏️ 고치기]로 직접 고친다). 값: **시험지 한 장에 기본 `PRICE_GRAMMAR_BASE_KRW`(100P) + 문제당 `PRICE_GRAMMAR_PER_Q_KRW`(10P)**, 객관식·주관식을 합쳐 센다(`_grammar_cost` ↔ 화면 `grCost`, **받아 낸 문항 수로** 매긴다). 기본 10문제(객관식 5 + 주관식 5, `grState.mcTotal`/`saTotal`)면 200P, 50문제 600P(2026-10-20 사용자 결정 — 처음엔 객관식·주관식을 따로 세어 기본값이 두 번 붙었다). 실측(2026-10-20, AI Studio 단가): 20문항 약 49원·10문항 약 16원 — 문항당 2~2.5원(Vertex면 2배). **정답 번호는 서버가 먼저 정한다**(`_grammar_slots`의 `target` — 1~5를 섞은 한 벌씩 돌려 나눈다. AI에 맡겼더니 20문항에서 ③이 8번·⑤가 0번이었다). 프롬프트로 알려 주고, AI가 어기면 `_grammar_place_answer`가 보기 두 개를 맞바꾸고 해설의 번호(①~⑤·'2번')도 `_grammar_remap_numbers`로 함께 고친다(밑줄·개수 문제는 못 바꿔 AI가 지킨 번호를 둔다). 같은 항목의 문항은 `nth`(이 항목의 n번째)로 오류 수법이 겹치지 않게 한다. **옳은 문장의 개수(`mc_count`)는 AI가 개수를 말하지 않는다** — `countItems`(문장 5개 + 판정 + 근거)를 받아 `_grammar_build_count`가 개수를 세어 정답·해설을 만든다(AI가 개수를 직접 말했더니 판정과 어긋나 정답이 틀렸다). **기계 검사 `_grammar_flawed`**(걸리면 문항을 버리고 빠진 자리와 함께 최대 두 번 다시 채운다): 해설의 혼잣말("다시 점검" 등)·너무 긴 해설, 콤마 뒤 `which` 바로 뒤의 동사 빈칸(수일치가 갈린다), 조건 "N단어"와 모범 답안 단어 수 불일치, 바꿀 것 없는 동사형((design|design)), <보기> 없는 조건 영작, `why + to부정사`(한국 교재 규칙이지만 영어권에서 쓰여 정답이 갈린다), 자리가 바뀔 수 있는 부사(`_GRAMMAR_MOVABLE` — first·later 등)가 든 배열 영작(다른 어순도 정답이 되는데 `alts` 없이 나왔다) — 프롬프트로 금지만 해서는 막히지 않아 코드로 막았다(2026-10-20). **주관식 복수 정답**: 빈칸·동사형은 괄호 안에 '(|whom / who / that)', 고쳐 쓰기는 `right`에 'whom / who / that', 문장 정답(배열·전환·조건 영작)은 `answerText`(대표 하나) + `alts`(나머지, `_qt_clean_question`이 저장하고 `_qt_units`가 '/'로 이어 정답 칸에 넣는다 — `_qt_accepts`가 '/'로 갈라 어느 것이든 맞음). 배열 영작의 <보기>는 `answerText`만 흩으므로 정답 칸에 두 문장을 섞어 넣지 않는다. **문법 마법사에서 낸 시험의 배열 영작은 어순만 다르면 틀림이 아니라 '확인 대기'다**(2026-10-20 사용자 결정 — 자리가 바뀔 수 있는 부사 등으로 다른 어순도 정답일 수 있다): 화면이 [🏫 반에 시험 내기]에서 `write` 문항에 `looseOrder:true`를 달아 보내고, 서버 `_qt_clean_question`이 저장하며 `_qt_grade_question`이 정답(또는 `alts`)과 같은 낱말을 같은 개수 썼는데 맞지 않으면(`_qt_same_words`) `ok:None`으로 두어 선생님이 결과의 [답안 보기]에서 [맞음]/[틀림]을 누른다. 다른 탭의 서술형 배열은 이 표시가 없어 그대로 정답과 다르면 틀림이다. 정답표(`quizAnswerLabel`)가 `alts`를 함께 보인다. 청구서 실측(2026-10-19 PDT): Vertex 3.8 Flash 100만 토큰당 입력 약 2,037원·출력 약 10,197원, AI Studio는 그 절반. 원가율은 AI Studio 기준 약 15~35%이고, 크레딧이 끝난 뒤 Vertex 스위치를 켜 둔 채면 50문제에서 약 70%까지 오른다. [✏️ 고치기]는 화면 HTML이 아니라 문항 값(`grState.questions`)을 고친다(저장·시험 내기가 값을 쓰므로). 저장은 tab `"grammar"`. 공용 지문칸은 '넣은 지문으로'일 때만 보인다(`grammarWantsPassage` ↔ app.js `syncTabChrome`) |
| PDF에서 지문 꺼내기 | `read_pdf_pages`(글자층+좌표 읽기), `_pdf_columns`(단 나누기), `split_pdf_passages`(문항형/문단형 판정), `_pdf_clean_passage`(번호·보기·정답교정 정리), `_pdf_unspace_letters`(양쪽 정렬로 글자마다 빈칸이 든 줄 'p r o c e s s .  B a s e d'을 되붙인다 — 낱말 사이가 빈칸 둘 이상일 때만), `_pdf_drop_running_heads`(쪽마다 같은 머리말을 지운다 — 책처럼 홀짝 쪽 머리말이 다르면 홀수·짝수 쪽을 따로 세되 한글이나 숫자뿐인 줄만, 2026-10-21). 여기까지는 Gemini를 부르지 않습니다 — 규칙이 실패했을 때만 `call_gemini_pdf_split`이 '경계 줄 번호'만 물어봅니다 |
| 모의고사 문제지 → 원래 지문(2026-10-20) | 학생용 문제지는 빈칸·순서·삽입이 풀리지 않은 채라 위 규칙 길로는 그 지문이 빠진다(고1 10월 모의고사 28지문 중 13개만 나왔다). `/api/mockrestore` → `call_gemini_mock_restore`가 PDF를 **통째로**(inlineData) Pro에 보내 `MOCK_RESTORE_RANGES`(18~24·25~30·31~35·36~40·41~45)로 나눠 **동시에** 풀게 하고, 되살린 지문(`MOCK_RESTORE_SCHEMA` — no·type·text·answer·change)을 번호 순으로 돌려준다. 정답표 없이 AI가 푼다(사용자 결정) — 화면이 고른 답을 모두 보여 선생님이 맞춰 보게 한다. 글자를 서버가 뽑아 정답만 끼우는 길은 2단 시험지의 줄 순서가 섞여(29번 첫 줄이 30번 발문 사이에 낀다) 버렸다. 옮겨 적기가 대부분이라 temperature 0.15(RECITATION — `call_gemini_exam_ocr`과 같다). 값은 되살린 지문 1개당 `PRICE_MOCK_RESTORE_KRW`(30P — 2026-10-20 사용자 결정: 처음 꺼내기는 무료이고 이것은 다른 유료 기능으로 이어지는 입구라 원가(지문당 약 18원)만 넘기면 된다), 잔액은 쪽 수×4(4~28지문)로 미리 본다. 실측: 8쪽 문제지 25지문 50초, 입력 5.2천×5·출력+생각 약 2.1만 토큰(원가 약 430원). 화면은 따로 단추 없이 **[📄 PDF에서 가져오기](`runPdfImport`)가 묻는다** — 29번을 넘는 번호가 보이면 풀어야 할 문항(`MOCK_SOLVE_NOS` 29~39·41~45 + 규칙이 못 꺼낸 번호)을 모아 선택 창(`askMockFill` — [🧩 AI로 자동 채우기](지문당 값) / [원문 그대로 두기](무료))을 띄우고(2026-10-20 사용자 — 무료로 열면 원가가 커서), AI면 `mockRestoreInto`가 그 번호만 `nos`로 보내 문항 번호를 이름으로 달아 `appendJobs`한다. 서버는 `parse_mock_nos`·`_mock_nos_of`로 그 번호 밖의 지문을 버려, 규칙으로 무료로 꺼낸 지문에 값을 또 받지 않는다. **정답표(선택, 2026-10-21 사용자 — AI가 푼 답은 틀릴 수 있다)**: 선택 창에 정답을 글로 붙여 넣거나(`keyText`) PDF·사진(`keyFile`, base64 4MB `MOCK_KEY_FILE_MAX` — 화면에도 같은 이름)을 올리면 AI가 풀지 않고 그 답대로 되살린다. 글은 `parse_mock_answer_key`가 번호 → ①~⑤로 읽어(짝 꼴 '31 ②'·'31. 2', 가로 표 두 줄, 평가원 '번호 정답 배점' 표 — 줄을 넘어 짝짓지 않는다) 범위마다 그 번호만 보내고, 못 읽은 글은 그대로, 파일은 두 번째 파일로 보낸다. 번호를 읽은 정답표면 AI의 답에 그 번호(①~⑤)가 들어 있는지 견줘 `keyMismatch`로, 정답표에 없어 AI가 푼 지문은 `keyed:false`로 돌려 화면이 빨간 줄로 짚는다. 값은 같다. 실측(2025 9월 고3 모평): 정답표 PDF로 31·32·36·38 모두 정답, 31번을 일부러 틀리게 준 글 정답표도 그대로 따랐다 |
| 단어장 — 사진·PDF에서 단어 목록 가져오기 | **번호 붙은 단어장 책**(예: 어휘끝 — 쪽마다 'Unit 01 …' 단원 하나, 단어 8.5pt·뜻 6pt가 서로 다른 칸)은 `parse_vocab_book_pdf`가 **쪽별로 나눠** `{title, page, items}`로 돌려준다(2026-10-15, 0원 — 글자 위치로 짝짓는다: `_book_page_items`가 5pt 4자리 번호를 닻으로 삼아 같은 칸에서 다음 닻 전까지의 글자를 그 단어의 뜻·품사로 본다, `_book_title`이 쪽 머리글을 'Unit 01 수능 고빈출 최중요 어휘'로 잇는다, 띄어쓰기는 공백 글자가 아니라 글자 간격으로 정한다 — 이 책은 공백·탭 글자가 겹쳐 있다). `/api/vocabpdf`가 `mode:"book"`+`sections`로 답하고, 화면(`runVocabPdf`)이 쪽마다 `src:"book"` 세트를 만든다 — 둘 이상이면 `off:true`(아무것도 안 고른 채)로 두고 `renderVocabSource`의 **[📚 쓸 단어장 고르기]**(`activeVocabSets`)로 단원을 체크해 쓴다. 거기 **[💾 고른 단원 따로 저장]**(`saveVocabSetsEach`, 2026-10-20)이 체크한 단원을 '책 이름 · 단원 이름' 저장본으로 하나씩 저장한다(같은 이름의 단어장 저장본은 덮어쓴다) — 통째 저장만 있어 단원 하나를 쓰려면 PDF를 다시 올려야 했다. 실측: 어휘끝 45단원·1,800단어가 번호 1~1800까지 빠짐·중복 없이 나온다. 다른 모양의 책은 이 길이 빈 목록을 돌려 아래 기존 규칙·AI 길로 간다. 사진 인식은 그대로(쪽 나누기 없음). 사진: `call_gemini_vocab_ocr`, 그 밖의 PDF: `parse_vocab_lines_rule`(규칙만으로 "단어 — 뜻" 줄을 골라냄 · 0원), `call_gemini_vocab_pdf`(규칙이 못 뽑을 때만, `read_pdf_pages`가 이미 뽑아 둔 글자를 다시 보냄) |
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
`setWbPaging` / `wbLayoutPages` / `wbSimulate`(워크북 '쪽 구성', 2026-10-19 — 단위는 지문 상자 `.wb-passage`와 둘째 단계부터의
`table.wb-page`(`wbPageUnits`)이고 인쇄에 남는 건 그 `data-brk`뿐이다. 처음 상태(`wbDefaultBrk`)는 style.css 인쇄 규칙 — 단계마다 새 쪽,
단어 쓰기끼리는 잇기 — 과 같다. 워크북 단계는 여러 쪽에 걸쳐 이어지므로 지문 상세분석의 `layoutPages`를 쓰지 않고
`wbSimulate`가 문항(`.wb-q`)을 하나씩 담아 쪽을 센다 — `wbCountPages`(쪽 조이기 안내)도 같은 함수다. 실제 인쇄와 쪽 수가 맞는 것을
헤드리스 크롬 PDF로 확인했다. 다시 그려도 같은 자리의 나눔은 남지만 출력 순서(지문별/단계별)를 바꾸면 처음 상태가 되고, 저장본에는 안 담긴다) ·
워크북 단계 인쇄 순서는 **체크한 차례**다(`wbStageOrder`/`wbPickedStages`, 2026-10-19 — 예전엔 칸 차례로 고정). 저장본 `settings.stages`가 그 차례를 담는다.
쪽 구성 화면의 단계마다 `[▲ 앞으로]·[▼ 뒤로]`(`wbMoveStage` — 화면에 그려진 단계(`wbShownStages`)끼리 맞바꾸고 받아 둔 결과로 다시 그린다)가 있고,
다시 그릴 때 `drawWorkbook`이 단위의 `data-key`(지문·단계 자리, `buildWorkbookHtml`/`buildWorkbookByStage`가 단다)로 쪽 나눔을 되찾는다 ·
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
`savedPick`/`loadPickedItems`(지문 저장함에서 **여러 저장본을 체크한 차례대로** 한꺼번에 불러온다 — 체크박스 번호표가 곧 차례이고, 받은 저장본을 한 덩어리 가짜 저장본(`_multi`)으로 합쳐 `loadSavedItem`에 한 번만 넘기므로 '이어 붙일까'·'같은 지문 건너뛸까'도 한 번만 묻는다. 목록 응답 `n`=지문 개수, 입력칸 상한 40개[시험 범위 칸 100개]를 선택 바가 미리 알린다. 합친 저장본은 `LOADED_SAVED`에 기억하지 않는다) · `openSavedList` / `loadSavedItem` / `passageLoadTo` / `passageSaveFrom`(저장함도 저장
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

탭 — `analyze`, `brief`, `mcq`, `saq`, `mix`, `grammar`(문법문제 마법사, `public/grammar.js`), `workbook`, `vocab`, `exam`, `trend`, `students`.
사이드바에서는 `analyze`·`brief`가 상위 단추 **'📖 지문 분석'**(상세분석 / 요약분석) 아래로, `mcq`·`saq`·`mix` 셋이 **'📝 문제 제작'**(객관식 / 주관식 / 객관식+주관식) 아래로 묶여 있다(`TAB_GROUPS`) — 하위 버튼은 그대로 `.tab-btn`+`data-tab`이라 저장함 불러오기 등이 누르는 길은 안 바뀌고, 상위 단추의 켜짐·하위 줄의 보임은 `syncTabGroups`가 맞춘다. `mix`(객관식+주관식, 2026-10-06)는 두 유형을 한 시험지에 섞는 탭이다 —
`setupQuizTab`을 `prefix:"mix"`로 한 번 더 부르는 것뿐이고(`MIX_TYPES` = `MCQ_TYPES` + `SAQ_TYPES`,
고난도 가능 유형 `MIX_HARD_TYPES`), 서버는 유형 이름만 보고 요금·모델을 정하므로
**서버 변경은 없다**(`CHANGELOG`만). **세 문제 탭 모두** 만들기를 누르면 `generate()`가 지문마다 못 만드는 유형(대화문이 아닌 지문의 대화문 유형 · 문장이 4개 미만인 지문의 문장삽입)을 **시작 전에** 빼고 그 기준으로 금액을 보여 준다(`dropKind`/`jobPlanOf`). 이 기준은 `server.py`의 `fit_quiz_items`와 **한 벌**이다 — 화면의 `roughSentenceCount`·`isDialogueText`는 서버의 `rough_sentence_count`·`is_dialogue`를 옮긴 것이라 한쪽을 고치면 반드시 함께 고칠 것(어긋나도 서버가 한 번 더 거르므로 요금은 안전하지만 확인창 금액이 틀린다). **`MCQ_TYPES`·`SAQ_TYPES`에 유형을 더하면 혼합 탭에도
자동으로 들어가지만, 두 목록 사이에 같은 `id`가 생기면 안 된다**(`TYPE_MAX`·요금 조회가 id로 갈린다).

그중 **둘은 서버가 허락해야 보입니다** — `exam`(동형 모의고사 제작,
`examTabBtn`)과 그 뒤에 붙는 `students`(반/학생 관리, `studentsTabBtn`)입니다.
`exam`은 2026-09-27부터 모든 회원에게 보이고(`EXAM_OPEN_TO_ALL`), `students`는 여전히
관리자가 승인한 선생님에게만 보입니다.
`renderAccount`가 각각 `examApproved`·`classroomApproved` 값으로 `hidden`을 켜고 끕니다.
승인이 꺼졌는데 마침 그 탭을 보고 있었다면 `hideExamTab`이 첫 탭으로 물러나게 합니다 —
단추만 감추면 화면이 남아 계속 쓸 수 있는 것처럼 보이기 때문입니다.
각각 `#tab-<id>` 섹션과 `#analyzeBtn` / `#mcqBtn` / `#saqBtn` / `#wbBtn` 실행 버튼을 가집니다.

**첫 화면(로그인 전 `#gate`)과 로그인·가입 창**(2026-10-14): 첫 화면 머리(`.gate-hero`)는 왼쪽 글·[지문 넣어 보기](가입 창), 오른쪽 '넣은 지문 → 나온 결과물' 미리보기(`#gateDemo`, 탭을 누르면 같은 지문의 결과물 그림이 바뀐다 — app.js `gateDemo`)다. 가운데 큰 제목 + 단추 둘, 로고 + 큰 광고 문구 가입 창은 다른 서비스와 똑같아 보인다는 의견으로 이 모양이 됐다(2026-10-14). 그 아래 기능별 실제 결과물 그림 카드(`.gate-tour`, 누르면 그 기능의 소개 쪽).
가입 창은 제목 '회원가입' → 가입하면 받는 것(`.auth-perks`, 금액은 적지 않는다) → 동의 → 구글 → [이메일로 가입하기](`signupEmailOpen`, 눌러야 이메일 칸이 펼쳐진다)
순이고, 두 창 아래에서 서로 오간다(`signupToLogin`/`loginToSignup`). 소개 쪽의 단추는 `/?signup=1`로 와서 가입 창을 바로 연다
(`openAuthFromUrl`, `?login=1`은 로그인 창). 로그인 뒤 탭을 아직 안 고른 화면에는 같은 그림 카드(`START_TOUR`/`.start-tour`)가
지문 칸 아래에 나오고, 탭을 고르면 감춘다 — 승인이 필요한 탭은 단추가 숨으면 카드도 숨는다.

### 검색으로 들어오는 문 — `public/*.html` 소개 페이지

`analyze` · `brief` · `quiz` · `workbook` · `vocab` · `exam` · `trend` · `textbook` · `faq` 아홉 쪽(`brief`·`trend`·`textbook`은 2026-10-14에 더했다 — `textbook`은 교재 이름으로 찾는 선생님용 — 처음엔 네이버 검색어 1위 "수능완성 영어 분석본"에 맞췄다가, 그 교재 내신은 1학기에 끝나 2026-10-15에 고1·2 기말 범위(교과서 공통영어·영어Ⅰ·Ⅱ + 학력평가 + 부교재) 중심으로 고쳐 쓰고 수능특강·수능완성은 한 칸으로 남겼다. 교재·교과서 지문 자체는 싣지 않는다). 앱이 아니라
**검색 결과에서 눌러 들어오는 자리**라 `app.js`를 부르지 않고 가벼운 `page.css`
하나만 씁니다(까닭은 그 파일 맨 위 주석).

한 쪽짜리 앱이라 알릴 주소가 `/` 하나뿐이었고, 그래서 검색에서 잡을 수 있는 말도
그만큼밖에 없었습니다(서치콘솔이 '발견된 페이지 1'이라고 알려 줍니다). 선생님이
실제로 치는 말마다 쪽을 하나씩 두어 그 수를 늘린 것입니다.

- **새 쪽을 만들면 `public/sitemap.xml`에 반드시 함께 적으세요.**
- **어디서도 연결되지 않은 쪽은 사이트맵에 적어도 좀처럼 순위에 오르지 않습니다.**
  `index.html` 푸터(`site-footer-links`)와 각 쪽의 `.more` 칸이 그 연결입니다.
- 결과물 예시 그림은 앱의 `howto-*.jpg`를 그대로 쓴다(`page.css`의 `.shots`) — 그림을 갈아 끼우면 소개 쪽도 함께 바뀐다.
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
| `WORKBOOK_STAGE_IDS` | `WB_STAGES`의 id — 워크북 요금이 단계 수에 걸려 있다. 11(목표어법 배열 영작, 2026-10-16)만은 고를 때만 AI가 재료(`grammarArrange`)를 만들고(`_workbook_schema`), 공용 `targetGrammar` 칸을 받으며(비면 AI가 지문에서 고른다), 기출 유형 매칭이 켜지 않게 `WORKBOOK_STAGE_LABELS`에는 넣지 않았다. **12(내용 O/X)는 서버 목록에 일부러 없다** — 워크북 호출이 아니라 화면이 주관식 OX진위(`/api/quiz`)를 지문마다 기본·고난도로 따로 불러 만들고(`wbOxCalls`, 결과는 `data.ox`), 값도 주관식 OX 값을 받는다(`wbOxCost`). 워크북 값에 넣으면 두 번 받는다 |
| `EXAM_MAX_PAGES` | `EXAM_MAX_PAGES` — 기출을 여러 부 쌓으므로 한 부의 서너 배가 든다 |
| `QUIZ_HARD_RULES` 8~12번(주관식 유형) | `SAQ_HARD_TYPES` — 주관식 고난도가 되는 유형. 화면이 이 목록 밖의 유형은 고난도로 보내지 않는다 |
| `RECHARGE_AMOUNTS` | `index.html`의 `recharge-preset-btn` 금액 단추 — 금액 직접 입력은 카카오페이 입점 조건 때문에 뺐다(2026-09-27) |
| `GRAMMAR_GRADES` · `GRAMMAR_MC_SHAPES` · `GRAMMAR_SA_SHAPES` · `GRAMMAR_MAX_QUESTIONS` | `public/grammar.js`의 같은 이름(상한은 `GRAMMAR_MAX_Q`) — 열쇠가 어긋나면 서버가 그 학년·모양을 버린다 |

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
| `QUIZ_TYPE_LABELS` / `MCQ_ONLY_TYPES` | `public/quiz.html`의 유형 목록(객관식 23 · 중학교 내신 13 · 주관식 18) |
| `WORKBOOK_STAGE_IDS` / `WB_STAGES` | `public/workbook.html`의 11단계 |

**화면을 바꾸면 '만드는 법'도 같은 커밋에서 고치세요.** 탭마다 뜨는 [❓ 만드는 법] 창의
글은 `public/app.js`의 `HOWTO`에 손으로 적혀 있어, 화면과 자동으로 맞춰지지 않습니다.
단추를 더하거나 이름·순서를 바꾸거나, 선택지·칸이 생기거나 없어지거나, 선생님이 알아야 할
기능이 늘면 **그 즉시** 해당 탭의 `steps`/`tip`을 고칩니다 — 나중으로 미루면 쌓입니다
(2026-09-26에 한 번에 고쳤을 때 동형 모의고사는 단추 이름부터 틀려 있었습니다).
적은 단추 이름은 `index.html`의 실제 글자와 한 글자도 다르지 않아야 합니다(`＋`처럼 전각 기호 포함).
고친 뒤에는 브라우저에서 `openHowto('<탭>')`로 창을 열어 확인하세요.
**단계마다 붙은 실제 화면 사진**(`HOWTO.<탭>.shots` → `public/howto-step-<탭>-N.jpg`, 2026-10-18)도 저절로 따라오지 않습니다 — 그 단계의 단추·칸 모양이 바뀌면 실서비스에서 다시 찍어 갈아 끼우세요. 사진에는 **가격 숫자·학교 이름·교재 지문이 들어가지 않게** 잘라 냈습니다(가격은 바뀌고, 나머지는 공개하면 안 됩니다). 글은 길면 안 읽는다는 사용자 의견으로 탭마다 3~6단계 한두 줄로 줄였으니, 새 내용은 화면의 칸 아래 안내문에 쓰고 만드는 법에는 꼭 필요한 것만 더하세요.
창 아래 '이런 자료가 나옵니다' 예시 중 상세분석·객관식·주관식·워크북은 **실제 결과물 PDF의
쪽 그림**(`public/howto-<탭>-N.jpg`, `samplePagesHtml`)이라, 인쇄물 모양이 눈에 띄게 바뀌면
저절로 따라오지 않습니다 — PDF를 새로 뽑아 그림을 갈아 끼우세요(원본은 저장소 밖 `홍보/`의
2026-09-20 홍보용 PDF 네 개). 단어장·동형 모의고사 예시는 코드가 그 자리에서 그려서 알아서 따라갑니다.
**요약분석 예시(`howto-brief-1/2.png`)는 `SAMPLE_BRIEF`를 그린 화면을 헤드리스 크롬으로 찍은 그림**이라 따라오지 않으니, `SAMPLE_BRIEF`나 요약분석 CSS를 고치면 다시 찍으세요.
객관식·주관식 예시(`howto-mcq-*`·`howto-saq-*`)는 2026-10-07에 같은 지문으로 `call_gemini_quiz`를 직접 불러(요금 차감 없이) 새로 만들고, 앱의 `buildQuizHtml`+인쇄 CSS를 헤드리스 크롬으로 찍은 그림이다. 제목은 "예시 객관식문제"·"예시 주관식".
**모든 탭 예시는 같은 지문(*Desirable Difficulty*)을 씁니다** — 새 예시를 만들 때도 이 지문으로 맞추세요.
같은 예시(`HOWTO_SAMPLE`)가 **각 탭의 실행 버튼 아래에도** 접이식 '📄 결과물 예시'로 보입니다(`ensureTabSample`, 탭을 처음 열 때 한 번 만들고 결과가 생기면 감춥니다) — 그림을 갈아 끼우면 두 곳이 함께 바뀝니다. 새 탭에 예시를 붙이려면 `HOWTO_SAMPLE`에 더하고 `TAB_SAMPLE_RESULT`에 그 탭의 결과 칸 id를 적으세요.

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
`/api/students/report`(학생 한 명 성적표) `/api/studentcomment`(성적표 코멘트 AI 작성 — 선생님 쪽, 요금 있음) `/api/student/tests/result`(학생 본인의 지난 결과)
`/api/student/me` `/api/student/tests` `/api/student/tests/detail`(학생 쪽,
`student_session` 쿠키로 인증)

**POST** — `/api/analyze` `/api/quiz` `/api/grammar`(문법문제 마법사) `/api/workbook` `/api/reword` `/api/ocr` `/api/pdfsplit`
`/api/mockrestore`(학생용 모의고사 문제지 → AI가 풀어 되살린 원래 지문) `/api/examscan`(기출 시험지 → 문항 유형표) `/api/examtrend`(시험지 분석 리포트 총평 — 보고서 1건당 정액) `/api/examocr`(같은 쪽 그림 → 영어 지문. 둘 다 `_exam_approved` 확인 — 지금은 모두에게 열림)
`/api/vocabocr` `/api/vocabpdf` `/api/models`
`/api/auth/google` `/api/auth/signup` `/api/auth/verify` `/api/auth/login` `/api/auth/delete`
`/api/logout` `/api/account/recharge` `/api/account/recharge/confirm` `/api/account/ack-update`
`/api/portone/webhook`(포트원 → 서버. 로그인·세션이 없는 유일한 POST다)
`/api/saved` `/api/saved/delete` `/api/saved/rename`(이름만 바꾼다 — `rename_saved_item`)
`/api/saved-image`(저장본에 딸린 요약 이미지 한 장을 올린다 — 저장본 문서는 1MiB 한도라 그림은 `saved_images` 컬렉션에 한 장에 문서 하나로 따로 담고, 저장본 `payload.images`에는 목록(entry·lang·key)만 둔다. 읽기는 GET `/api/saved-image/<저장본id>/<key>`. 저장본 삭제·덮어쓰기·회원 탈퇴 때 `prune_item_images`/`delete_user_account`가 함께 지운다. 화면은 `public/app.js`의 `uploadInfographics`/`loadInfographics`)
`/api/admin/login` `/api/admin/logout` `/api/admin/recharge` `/api/admin/approve-classroom`
`/api/classes` `/api/classes/regenerate-code` `/api/students` `/api/students/delete`
`/api/vocab-tests` `/api/vocab-tests/delete`(선생님 쪽 — 위 GET들과 경로가 같은 것도 있음,
GET=조회/POST=생성. `/api/vocab-tests`에 `studentId`를 실으면 그 학생 한 명에게만 낸다)
`/api/student/login`(`loginId`+`password`) `/api/student/logout` `/api/student/password`(학생 본인 비밀번호 변경) `/api/students/update`(선생님이 이름·아이디·비밀번호 수정)
`/api/student/tests/submit`
`/api/quiz-tests`(문제 시험 내기) `/api/quiz-tests/grade`(확인 대기 칸 채점) — GET `/api/quiz-tests/attempt`(학생 한 명 답안)

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

- **학교급(중학교)과 대화문 유형**(2026-10-01): 객관식·주관식·동형 모의고사 탭의 '학교급'이 중학교면 요청에 `school: "middle"`이 실리고 서버가 `QUIZ_MIDDLE_RULES`를 지시문 뒤에 붙인다(모델·요금은 그대로). 대화문 6유형(`QUIZ_DIALOGUE_TYPES` — 대화 순서·어색한 응답·대화 빈칸·대화 내용 일치/불일치·답할 수 없는 질문)은 대화문에서만 만든다 — 줄 첫머리 말하는 사람 표시가 넷 이상 — 두 번 이상 말한 사람의 줄만 센다, 안내문의 "Date:/Time:/Place:"가 대화문으로 잡혀서(`is_dialogue` ↔ 화면 `isDialogueText`, **기준을 함께 고칠 것**). 아니면 `fit_quiz_items`가 빼고 요금도 매기지 않으며, 동형 모의고사 배분(`examEligible`)도 대화문 지문에만 붙인다. **중학교면 한 지문으로 최대 3문항**(`EXAM_MIDDLE_PASSAGE_USES`, 2026-10-02 — 중학교 시험은 [12-13]·[15-18]처럼 지문 하나로 여러 문항을 낸다)까지 낼 수 있다 — 단 대원칙 1(한 문항의 지문이 다른 문항의 정답을 보여 주면 안 된다)이 지켜지는 조합만: 같은 지문에 둘째로 붙는 문항과 그 지문의 앞선 문항이 모두 지문을 가공 없이 싣는 유형(`examIsPlainType` — 주제·제목·내용 일치·대화 내용 일치 등)이어야 한다. 빈칸·어휘·어법처럼 지문을 고치는 유형이 붙은 지문은 한 문항에만 쓴다. 지문이 넉넉하면 먼저 퍼뜨려 배분하고(`maxUses=1`), 모자라 실패할 때만 재사용 배분을 쓴다. **그래도 모자라면 멈추지 않는다**(2026-10-04 사용자: "입력한 지문 내에서 해결하도록" — 지문 12개 · 26문항 2부에서 '24개 필요'로 멈췄다): `runExamPaperFlow`가 `planExamPaperOnce`의 `rx`를 차례로 푼다 — `basis`(대화/본문 비율을 선호로만) → `mix`(지문을 고치는 유형끼리도 한 지문 공유, 문항을 고르게 퍼뜨림 — 대원칙 1을 푸는 것) → `pairs`(A·B형 (지문, 유형) 겹침 허용, 피하기만) → `fit`(문장 수 조건을 80자로) → `dup`(같은 지문에 같은 유형·같은 묶음 허용, 피하기만 — 지문 6개 · 26문항에서 내용 일치 계열 일곱 문항이 이 규칙만으로 막혔다). 같은 유형·묶음 수가 지문 수보다 많으면 앞 단계를 건너뛰고 바로 `dup`로 간다. 고등학교도 같다. 푼 경우 `examRelaxNote`가 '답이 비칠 수 있는 곳' 수를 시험 범위 칸 아래에 알린다. 셈부터 안 맞으면 엄격한 배분은 건너뛴다(안 그러면 몇 초 멈췄다). **기출의 대화문/본문 비율을 따른다**(2026-10-02 — 기출은 대화 기반이 21%인데 만든 시험지는 70%였다): `/api/examscan`이 문항마다 `basis`("대화"|"본문")를 읽고, 화면은 합치기 표의 유형 줄마다 대화 기반 개수(`row.dlg`)를 세어 `examMergeToQuestions`가 그 비율대로 `basis`를 나눠 담으며, `planExamPaper`가 `basis`대로 대화문/본문 지문에**만** 붙인다(`examSlotWantsDlg` — 처음엔 선호로만 두었더니 본문이 모자랄 때 조용히 대화문으로 넘어가 대화 15 : 본문 8이 됐다. 지금은 모자라면 `runExamPaperFlow`가 시작 전에 "본문 N개 더"라고 알리고 멈춘다). basis를 모르는 옛 분석·저장본은 `examQBasis`가 유형·분류·발문으로 짐작한다. 배분은 되돌아가며 찾는다(백트래킹, `planExamPaperOnce` — 욕심쟁이 한 번으로는 지문이 딱 맞는 구성에서 막혔다). **지문이 모자라거나 대화/본문 비율이 어긋날 때만** 같은 과(이름 끝 번호를 뗀 앞부분이 같은 `examLessonKey`)의 이웃한 짧은 본문 둘을 이은 가상 지문(`examMergedJobs`, 230단어 이하·하나는 110단어 미만, 번호 10000+)을 후보에 더해 다시 짜고 더 나은 쪽을 쓴다 — 중학교 시험 지문은 교과서 토막 2~3개를 이은 100~170단어다(기출 94부 실측). 이은 지문은 원래 지문 둘을 차지해 한 부 안에서 함께 쓰이지 않는다(`occ`). 사실상 같은 문제가 한 지문에 겹치지 않게 `EXAM_FAMILY`(일치·불일치 계열, 주제·제목·요지·목적, 영영풀이 계열)는 지문 하나에 한 번만 붙는다. **대화문 출제 방식은 중학교 기출 6부(동중 2022·2024 네 부 · 호성중 · 아중중, 2026-10-04)를 따른다**: 대화문 어법은 밑줄 ①~⑤가 아니라 '대화 어법·어휘 선택'(대화 속 네모 (A)(B)(C))·'짝지어진 대화 어법'(흐름 및 어법)으로, 대화 후 할 일·관계·장소·심경은 '대화 상황 파악'으로 낸다. 대화 순서는 앞 맥락 + 네 덩이 (A)~(D), 대화 내용 일치 보기는 영어, 발문은 '다음 대화', 말하는 사람 표시는 쌍점을 붙인다(`with_dialogue_colons`). 동형 모의고사는 대화문에 본문용 유형(어법·무관한 문장·삽입·함축·주제…)을 붙이지 않고(`EXAM_DIALOGUE_OK`/`examTypeOkOnDialogue`), 지문이 모자라도 대화문은 지문을 고치는 문항끼리 나눠 쓰지 않는다(답이 보여서). 기출은 한 대화로 여러 문항을 낼 때 대화를 한 번 싣고 '[3~4]'로 묶는다 — 이 앱은 문항마다 지문을 따로 싣기 때문에 아직 그렇게 못 한다. 유형을 고른 근거는 중학교 기출 11부(273문항) 실측 — 대화문 발문이 약 31%였다. 짝지어진 대화(대화문 유형이지만 지문 없이 보기 다섯 쌍 — 화면은 빈 지문 상자를 안 그린다)와 낱말·문법 쓰임 유형(문법 쓰임 같은 것·다른 것, 다의어 같은 뜻 — 지문의 낱말 하나에 밑줄을 긋고 보기 문장을 새로 짓는다)은 전주호성중 3학년 기출(6·7·13·17·5번)을 보고 더했다.
- **모델을 사용자가 고르게 만들지 마세요.** 기능마다 서버가 고정합니다 —
  `/api/quiz`는 고른 유형에 `QUIZ_PLAIN_PASSAGE_TYPES` 밖의 것이 **하나라도 섞이면**
  그 호출 전체가 `GEMINI_MODEL_PRO`(Pro)로 갑니다(객관식·주관식 구분 없음).
  객관식 탭의 난이도 **고난도**(`difficulty: "hard"`)도 유형과 상관없이 Pro이고,
  지시문 뒤에 `QUIZ_HARD_RULES`가 붙습니다(기본은 지시문·모델 모두 예전 그대로).
  지문변형 heavy('5개 이상')도 Pro이고(화면에서는 2026-10-18에 뺐고 서버만 옛 요청용으로 남았다 — 문제 탭 지문 변형은 '원문 그대로 / 단어 변형' 둘뿐), 시험지 스캔을 읽는 `/api/examscan`·`/api/examocr`도 Pro입니다
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
