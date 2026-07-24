@echo off
chcp 65001 >nul
cd /d "%~dp0"
echo 영어 지문 분석본 웹앱 (Google Gemini)
echo 브라우저에서 http://localhost:8000 접속 후 화면에서 API 키를 입력하세요.
echo (또는 setx GEMINI_API_KEY "AIza..." 로 환경변수 설정 가능)
echo.
python server.py
pause
