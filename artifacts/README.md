# 화면 검증 자료

## 현재 Sheets 앱 · 2026-09-11

- [목록](journal-list-chromium.png) · [모바일 목록](journal-list-mobile-chromium.png)
- [읽기](journal-reading-chromium.png) · [모바일 읽기](journal-reading-mobile-chromium.png)
- [편집](journal-editor-chromium.png) · [모바일 편집](journal-editor-mobile-chromium.png)

추가항목 제거·최근 100개 캐시·변경분 동기화·충돌 보존을 포함한 PC·모바일 Chromium 검사와 Safari 엔진 검사를 CI에서 통과했습니다. 아래 내용은 이전 Drive 버전 당시의 기록이며, 그때의 미완료 항목이 현재 상태를 뜻하지는 않습니다.

## 첫 버전 검증 기록

검증일: 2026-09-09. 화면 캡처의 내용은 테스트가 생성한 예시이며 실제 사용자 일기가 아닙니다.

- [데스크톱 화면](chromium.png)
- [모바일 크기 화면](mobile-chromium.png)

## 통과한 검증

- Node 테스트 13개: 수정 분기 보존·병합, 날짜 정렬, 이름·숫자 검색, 일정 메모 보존, 이식 형식, 잘못된 백업 거부, 알림 시간대·중복 방지, Web Push 암호화 복호화, VAPID 서명, 서버 접근 제한
- Chromium 브라우저 테스트 18개: 데스크톱과 모바일 크기에서 작성·수정·재실행, 사진 삽입, ZIP 내보내기/복원, 날씨 저장, Google 연결 전후 데이터 분리, 업로드 실패 재시도, 동시 수정 병합, 캘린더 변경/취소, 오프라인 재실행·초안 복구
- 정적 빌드, Prettier 검사, `git diff --check`

Google Drive·Calendar·날씨의 브라우저 테스트는 요청/응답을 모의 처리합니다. 실제 사용자 계정, Google OAuth 팝업, 실제 API 업로드 성공이나 아이폰 푸시 수신을 검증했다고 의미하지 않습니다.

## 환경 제약

이 Linux 환경에는 Chromium의 NSS/NSPR 라이브러리와 한글 글꼴이 없어서 Ubuntu 패키지를 `/tmp/my-diary-browser-libs`에 추출해 테스트에만 사용했습니다. 시스템 설정은 변경하지 않았습니다.

```bash
FONTCONFIG_FILE=/tmp/my-diary-browser-libs/fonts.conf \
LD_LIBRARY_PATH=/tmp/my-diary-browser-libs/extracted/usr/lib/x86_64-linux-gnu \
npm run test:e2e
```

WebKit 바이너리는 다운로드했지만 시스템 의존성 설치가 관리자 비밀번호를 요구해 실제 실행하지 못했습니다. `npm run test:webkit` 검증과 실제 iPhone/iPad의 홈 화면 실행·Google 연결·푸시 수신 확인은 남아 있습니다.

## 실제 서비스 연결 시 남은 확인

1. 본인 Google OAuth 클라이언트와 Firebase 프로젝트 설정
2. Drive 업로드·재연결과 두 기기의 동시 수정 확인
3. Calendar 변경·취소 후 메모 유지 확인
4. Cloudflare 알림 Worker 배포, 무료 CPU 한도와 실제 푸시 수신 확인
5. 사진을 포함한 실제 Drive 데이터의 ZIP 백업·복원 확인
