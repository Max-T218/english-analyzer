# 배포 안내

이 앱이 어떻게 인터넷에 올라가 있는지, 무엇을 건드리면 무엇이 바뀌는지 적어 둡니다.
기능 설명은 `README.md`, 코드 지도는 `CLAUDE.md`에 있습니다.

## 지금 어떻게 돌아가고 있나

| | |
|---|---|
| 주소 | https://englishlab.ai.kr |
| 플랫폼 | Render (Web Service) |
| 서비스 이름 | `ara-analyzer` (Service ID `srv-d9grtgkvikkc73a0e9ag`) |
| 요금제 | **Starter**(유료) — 무료 등급은 15분 놀면 잠들어 다음 접속이 1분 가까이 걸린다 |
| 저장소 | `Max-T218/english-analyzer`의 `main` |
| 배포 방식 | **`origin/main`에 push하면 자동 재배포** (Auto-Deploy). 30초 안팎 걸린다 |
| 데이터 | Google Firestore (서비스 계정 JSON 하나로 접근) |

**⚠️ `render.yaml`은 지금 서비스에 적용되지 않습니다.** 이 서비스는 대시보드에서
직접 만들어졌고, 그 파일은 '새로 만들 때 쓰는 설계도'로만 남아 있습니다. 실제
설정을 바꾸려면 **Render 대시보드 → 해당 서비스 → Environment** 탭에서 직접
넣어야 합니다. 지금 무엇이 적용돼 있는지는 배포 로그에서 `[설정]`으로 시작하는
줄 하나를 보면 됩니다 — `기본값`이라고 적힌 항목은 환경변수가 아니라 `server.py`의
값을 쓰는 중입니다.

## 배포하기

```
git push origin main
```

이게 전부입니다. Render가 push를 감지해 `pip install -r requirements.txt` 후
`python server.py`로 다시 띄웁니다. 대시보드의 **Deploys** 목록에서 진행 상황과
`Live` 표시를 볼 수 있고, 문제가 생기면 그 자리에서 **Rollback**으로 이전 배포로
되돌릴 수 있습니다.

**배포 직후에는 로그인 한 번을 꼭 확인하세요.** `requirements.txt`가 매 배포마다
새로 설치되는데, 구글 클라이언트 라이브러리가 올라가면서 Firestore 접근이 통째로
깨진 적이 있습니다(그 사고 때문에 지금은 네 패키지의 버전을 못박아 두었습니다 —
`requirements.txt`의 경고 참고). **로그인이 막히면 AI 기능 전체가 함께 막힙니다.**

## 환경변수 (Render 대시보드 → Environment)

전체 목록과 기본값은 `README.md`의 "설정 (환경변수)" 표에 있습니다. 배포에 반드시
필요한 것만 추리면:

| 변수 | 없으면 |
|---|---|
| `GEMINI_API_KEY` | **AI 기능 전체가 막힘.** 관리자 키 하나를 모든 로그인 사용자가 함께 쓴다 |
| `GOOGLE_APPLICATION_CREDENTIALS_JSON` | **로그인이 막히고, 그래서 AI 기능도 전부 막힘** (Firestore 서비스 계정 JSON 전체 내용) |
| `ADMIN_PASSWORD` | `/admin.html` 관리자 로그인이 항상 거부됨 |
| `GOOGLE_CLIENT_ID` | 구글 로그인 버튼만 비활성화 (이메일·비밀번호 로그인은 됨) |
| `SMTP_USER` / `SMTP_PASSWORD` | 회원가입 인증코드가 메일로 안 가고 서버 로그에만 찍힘 |
| `PORTONE_STORE_ID` / `PORTONE_CHANNEL_KEY_CARD` / `PORTONE_API_SECRET` | 포인트 충전(결제)이 동작하지 않음 |

**🚨 `PORTONE_*`는 지금 KG이니시스 테스트 채널 값입니다.** 실연동 심사가 끝나고
실제 채널 키로 바꾼 뒤 실결제로 한 번 확인하기 전까지는, 결제 관련 변경을 배포하지
마세요. 자세한 경위는 `CLAUDE.md`의 "하지 말 것"에 있습니다.

**비밀값은 이 저장소에 넣지 마세요.** `origin`은 공개 저장소입니다. `.gitignore`가
`.env*`와 `service-account*.json`을 막아 두었지만, 코드 안에 박아 넣는 것까지는
막지 못합니다.

## 요금 구조 (예전 방식과 달라진 점)

예전에는 **선생님마다 본인 Gemini 키를 화면에 입력**해 각자 비용을 부담하는 구조였고,
이 문서도 그 방식으로 쓰여 있었습니다. 지금은 다릅니다.

- 화면에 **키 입력칸이 없습니다.** 관리자 키 하나를 모두가 함께 씁니다.
- 대신 **로그인이 필수**이고, 계정마다 **포인트(원)** 잔액이 있습니다.
  기능을 쓸 때마다 정해진 값이 차감되고, 새 계정에는 `DEFAULT_USER_KRW`(기본 10,000원)이
  지급됩니다.
- 잔액은 사용자가 **카드로 충전**하거나(포트원), 관리자가 `/admin.html`에서 넣어 줍니다.
- 가격은 **서버가 유일한 출처**입니다. 화면은 `/api/pricing`으로 받아 씁니다 —
  화면 쪽에 가격을 하드코딩하지 마세요.

## 로컬에서 띄우기

```powershell
$env:PYTHONUTF8 = "1"
python server.py     # http://localhost:8000
```

**⚠️ 로컬 서버도 실서비스 Firestore를 봅니다.** dev/prod 분리가 없어서, 로컬에서 한
회원가입·생성 테스트가 실제 회원 목록과 실제 잔액에 그대로 반영됩니다. 자세한
주의사항은 `CLAUDE.md`를 보세요.

## 도메인

`englishlab.ai.kr`이 이 서비스에 연결돼 있습니다. 대시보드의 서비스 화면 위쪽에서
연결 상태를 볼 수 있고, 내부 주소로 보이는 `english-analyzer-cy35:10000`은 예전
서비스 이름이 남은 것이라 바깥 주소와는 상관이 없습니다.
