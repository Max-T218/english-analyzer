// 학생 앱(홈 화면 아이콘)용 서비스워커.
// 시험·로그인은 늘 서버와 직접 통신해야 하므로 아무것도 저장해 두지 않는다 —
// 안드로이드 크롬이 '설치 가능한 앱'으로 인정하려면 이 파일이 있어야 해서 둔다.
self.addEventListener("install", () => self.skipWaiting());
self.addEventListener("activate", (e) => e.waitUntil(self.clients.claim()));
self.addEventListener("fetch", () => {});
