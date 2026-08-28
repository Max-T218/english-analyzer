# 인터넷 배포 가이드 (다른 선생님들과 공유하기)

이 문서는 **명령어 없이 브라우저 클릭만으로** 이 앱을 인터넷에 올려,
다른 선생님들이 각자 접속해 쓸 수 있게 하는 방법입니다.

- 배포 플랫폼: **Render** (아래 설명은 무료 등급 기준입니다. 지금 운영 중인 englishlab.ai.kr은 유료 **Starter** 등급이라 잠들지 않습니다)
- 키 방식: **선생님마다 본인 Gemini 키 입력** (각자 브라우저에 저장 → 비용 각자 부담)

---

## 준비: 폴더 안의 파일들
아래 파일/폴더가 모두 있어야 합니다 (이미 만들어져 있음).
```
server.py
requirements.txt
render.yaml
public/            (index.html, style.css, app.js 포함)
```
> ⚠️ API 키가 적힌 파일은 없습니다. 키는 코드에 저장되지 않으니 그대로 올려도 안전합니다.

---

## 1단계 — GitHub에 코드 올리기 (브라우저만)

1. https://github.com 접속 → 가입/로그인
2. 오른쪽 위 **`+` → New repository**
3. 이름 입력(예: `eng-passage-analyzer`), **Public** 선택 → **Create repository**
4. 새 화면에서 **`uploading an existing file`** 링크 클릭
5. 위 "준비" 목록의 파일과 **`public` 폴더를 통째로** 드래그해서 올립니다
   - `public` 폴더를 끌어다 놓으면 `public/index.html` 처럼 폴더 구조가 유지됩니다.
6. 아래 **Commit changes** 클릭

---

## 2단계 — Render로 배포하기

1. https://render.com 접속 → **Sign in with GitHub** 로 가입/로그인(권장)
2. 대시보드에서 **New +** → **Web Service**
3. **Build and deploy from a Git repository** 선택 → 방금 만든 저장소 선택(Connect)
4. 대부분 `render.yaml` 을 인식해 설정이 자동으로 채워집니다.
   - 만약 수동 입력을 요구하면 아래처럼 넣으세요:
     - **Language/Runtime**: Python
     - **Build Command**: `pip install -r requirements.txt`
     - **Start Command**: `python server.py`
     - **Instance Type**: **Free**
5. **Create Web Service** 클릭 → 빌드가 끝나면(수 분) 상단에 주소가 생깁니다
   예: `https://eng-passage-analyzer.onrender.com`

---

## 3단계 — 공유

- 위 주소를 다른 선생님들께 전달하세요.
- 각 선생님은 접속 후 **상단 ‘Gemini API 키’** 칸에 **본인 키**를 넣고 사용합니다
  (키는 각자 브라우저에만 저장되어 다음에도 자동 적용).
- 학원 마크·정확도(모델) 설정도 각자 브라우저에 저장됩니다.

---

## 알아두면 좋은 점

- **무료 등급은 일정 시간 접속이 없으면 잠듭니다.** (운영 중인 englishlab.ai.kr은 유료 Starter라 해당 없습니다.) 그 뒤 첫 접속은 30초~1분 정도
  깨어나는 시간이 걸리고, 그다음부터는 정상 속도입니다.
- **코드를 수정하려면**: GitHub 저장소에서 해당 파일을 다시 업로드(교체)하면
  Render가 자동으로 다시 배포합니다.
- **모두 공용 키 하나로 쓰고 싶어지면**(각자 키 입력 없이):
  Render 서비스의 **Environment → Add Environment Variable** 에서
  `GEMINI_API_KEY` 에 키를 넣으면 됩니다. 단, URL을 아는 누구나 그 키로 쓰게 되므로
  접근 비밀번호를 함께 넣는 것을 권장합니다(원하시면 그 기능을 추가해 드립니다).

---

## 로컬(내 PC)에서 그냥 쓰는 방법은?
배포 없이 내 PC에서만 쓰려면 예전처럼:
```
python server.py
```
후 `http://localhost:8000` 접속하면 됩니다. (README.md 참고)
