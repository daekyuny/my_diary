# Google 장기 연결 서버

정적 앱의 접근 토큰은 탭 세션에서 복원할 수 있지만 만료 후 갱신에는 서버가 필요합니다. `server/`는 Google 코드를 접근 토큰과 갱신 토큰으로 교환하는 Firebase Functions v2 서버입니다. 갱신 토큰은 AES-GCM으로 암호화한 `__session` HttpOnly/Secure/SameSite=Lax 쿠키에만 보관하며 브라우저 JavaScript에 반환하지 않습니다. 쿠키는 최대 180일 유지합니다. 명시적 연결 해제와 Google 권한 취소는 재로그인을 요구합니다.

## 최초 설정

1. Google Cloud 콘솔에서 기존 웹 OAuth 클라이언트의 **클라이언트 보안 비밀번호(client_secret)**를 확인합니다. 계정 비밀번호와 다릅니다.
2. `burndown-studio` 프로젝트의 Secret Manager에 `DIARY_GOOGLE_CLIENT_SECRET` 이름으로 등록합니다. 값은 OAuth 보안 비밀번호입니다. 채팅·Git·config.json에는 넣지 않습니다.
3. Firebase 프로젝트에 Functions를 사용할 수 있는 요금제/결제 설정과 배포 권한이 있어야 합니다. 최초 배포 시 Cloud Functions, Cloud Run, Artifact Registry, Cloud Build API가 활성화됩니다.
4. 프로젝트에서 실행합니다:

```sh
npm ci --prefix server
npx --yes firebase-tools deploy --only functions:diary-auth --project burndown-studio
```

5. 함수 배포 성공 후 GitHub 변수 `DIARY_AUTH_ENABLED`를 `true`로 설정하고 Hosting 배포를 실행합니다:

```sh
gh variable set DIARY_AUTH_ENABLED --body true
gh workflow run deploy.yml
```

Hosting 배포가 `/auth/**`를 `asia-northeast3`의 `diaryAuth` 함수에 연결하고 공개 설정 `authServer: true`를 기록합니다. 함수 배포 전에는 변수를 활성화하지 마세요. 기본값은 false이며 기존 토큰 방식으로 작동합니다. 장기 연결을 처음 켠 뒤에는 사용자에게 Google 권한 승인이 한 번 필요합니다.

허용 출처는 `https://daekyuny-diary.web.app`, `https://daekyuny-diary.firebaseapp.com`입니다. 같은 주소들이 OAuth 클라이언트의 승인된 JavaScript 원본에도 있어야 합니다. 팝업 코드 교환의 redirect_uri는 요청한 웹앱 원본입니다. 웹 클라이언트 ID는 server/handler.js와 config.json에서 일치해야 합니다.

Google 동의 화면이 외부 사용자용 **테스트 상태**이면 Sheets/Drive 권한의 갱신 토큰이 보통 7일 뒤 만료됩니다. 장기 이용에는 OAuth 앱 게시 상태도 확인해야 합니다. 권한 취소·비밀번호/보안 정책 변경 등으로 Google이 토큰을 무효화하면 재연결이 필요합니다.

## 검증

`npm test`는 쿠키 암호화/위변조/만료, 출처 검사, 코드 교환과 갱신을 검증합니다. 브라우저 테스트는 새로고침과 토큰 만료 후 서버 세션 복원을 확인합니다. 실제 Google 권한 승인과 장기 쿠키 동작은 배포된 앱에서 최초 연결 후 확인해야 합니다.

공식 안내: [Google 코드 모델](https://developers.google.com/identity/oauth2/web/guides/use-code-model), [서버 OAuth](https://developers.google.com/identity/protocols/oauth2/web-server), [토큰 만료 조건](https://developers.google.com/identity/protocols/oauth2#expiration).
