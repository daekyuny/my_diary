# My Diary · 하루의 조각

아이폰·아이패드·데스크톱에서 쓰는 개인용 일기 웹앱입니다. 일기와 사진 원본은 **본인 Google Drive**에 저장하며, 앱스토어 등록 없이 홈 화면에 추가할 수 있습니다.

## 첫 버전 기능

- 날짜별 작성·수정, 입력 중 기기 초안 저장, 잠시 멈추면 자동 저장
- **일기 날짜** 기준 정렬, 기간·태그 필터, 이름·숫자·본문·일정 메모 검색
- Google Drive의 `My Diary` 폴더에 Markdown 수정 버전과 사진 원본 저장
- JPG/PNG/WebP/GIF 사진·그림 첨부, 본문 삽입, 미리보기
- Markdown + 원본 이미지 + JSON 전체 버전의 ZIP 내보내기·가져오기
- 선택한 Google Calendar의 일정 제목·시간·장소를 해당 날짜에 가져오기
- 일정별 메모와 종료 알림 설정; 원본 일정이 변경되어도 메모 보존
- 날짜와 도시 또는 현재 위치에 맞는 날씨 저장, 출처·예보/과거 추정 구분
- 기기별 매일 알림·일정 종료 후 알림, PWA와 오프라인 초안

로컬 실행에는 계정이 필요 없습니다. **실제 Drive·Calendar 연결은 OAuth 설정, 예약 알림은 Worker 배포가 필요**합니다. 실제 계정과 iPhone 푸시 수신은 배포 후 확인해야 합니다.

## 실행과 검증

Node.js 22 이상을 사용합니다. 프런트엔드는 JavaScript ES modules와 CSS이며, 서버 렌더링이나 유료 데이터베이스가 필요 없습니다.

```bash
npm ci
npm run dev
```

`http://localhost:4173`을 엽니다. 처음에는 **기기에만 저장**되며 Drive 저장 완료로 표시하지 않습니다. 로그인 없이 작성, 사진, 필터, 백업을 확인할 수 있습니다.

```bash
npm test
npx playwright install chromium webkit
npm run test:e2e
npm run test:webkit
npm run format:check
npm run build
npm run preview
git diff --check
```

`build`는 `dist/`를 생성하며 `preview`도 4173 포트를 사용합니다. 테스트 캡처는 `artifacts/`, 실패 추적은 `test-results/`에 생성됩니다. 서비스 워커를 통한 오프라인 재접속 테스트는 Playwright 지원 범위에 따라 Chromium에서 실행하고 WebKit에서는 건너뜁니다. 외부 API 모의 테스트는 서비스 워커를 차단해 실제 API로 요청이 나가지 않도록 합니다. WebKit 테스트는 Linux에 시스템 라이브러리가 필요할 수 있습니다: `npx playwright install-deps webkit` (관리자 권한 필요). 브라우저 에뮬레이션은 실제 iPhone 알림 수신 검증을 대체하지 않습니다.

## Google 연결

1. 기존 Firebase에 연결된 Google Cloud 프로젝트 또는 새 프로젝트를 선택합니다.
2. **Google Drive API**, **Google Calendar API**를 활성화합니다.
3. Google Auth Platform의 동의 화면을 설정합니다. 개인 계정은 External / Testing으로 시작하고 본인 이메일을 테스트 사용자로 등록합니다.
4. **웹 애플리케이션 OAuth 클라이언트**를 만듭니다. 승인된 JavaScript 원본에 `http://localhost`, `http://localhost:4173`과 실제 배포 원본(예: `https://YOUR_PROJECT.web.app`)을 각각 추가합니다. 경로는 붙이지 않습니다.
5. 앱 설정에 `…apps.googleusercontent.com` 형식의 클라이언트 ID를 입력합니다. **Client Secret은 입력하지 않습니다.**
6. Google 연결 버튼으로 Drive 권한을 허용합니다. 캘린더는 별도로 읽기 권한을 요청합니다.

공개 설정을 배포에 포함하려면 `config.json` 또는 Git에서 제외된 `config.local.json`에 다음 값을 넣습니다. 빌드는 두 공개 값만 복사합니다.

```json
{
  "googleClientId": "YOUR_CLIENT_ID.apps.googleusercontent.com",
  "notificationServer": "https://my-diary-notify.YOUR_SUBDOMAIN.workers.dev"
}
```

권한은 `drive.file`과 선택적인 `calendar.readonly`입니다. 전체 Drive 읽기 권한을 요구하지 않습니다. 접근 토큰은 메모리에만 보관하므로 **새로 열었거나 토큰이 만료되면 Google 연결 버튼을 다시 눌러야 할 수 있습니다.** 재연결 전에는 기기에 저장합니다.

계정별 브라우저 저장소를 분리합니다. 로그인 전 기록은 **설정 → 연결 전 초안 가져오기**로 명시적으로 옮깁니다. 다른 계정으로 옮길 때는 연결 해제 후 재연결하고 ZIP을 가져옵니다. 기기 간에는 같은 OAuth 클라이언트와 배포 URL을 사용하세요. 새 OAuth 앱이 기존 파일에 접근하지 못하면 ZIP을 가져와 새 앱 소유 파일로 저장할 수 있습니다.

참고: [Google 토큰 모델](https://developers.google.com/identity/oauth2/web/guides/use-token-model), [Drive 권한](https://developers.google.com/workspace/drive/api/guides/api-specific-auth), [Calendar 조회](https://developers.google.com/workspace/calendar/api/v3/reference/events/list)

## Firebase 무료 배포

**Firebase Hosting의 Spark 요금제**를 사용합니다. App Hosting, Cloud Functions, Firebase Storage는 사용하지 않습니다. 일기는 Firestore가 아닌 **개인 Google Drive**에 저장합니다.

```bash
npm run build
npx firebase-tools login
npx firebase-tools hosting:sites:create YOUR_DIARY_SITE_ID --project YOUR_PROJECT_ID
npx firebase-tools target:apply hosting diary YOUR_DIARY_SITE_ID --project YOUR_PROJECT_ID
npx firebase-tools deploy --only hosting:diary --project YOUR_PROJECT_ID
```

프로젝트 ID와 일기용 사이트 ID를 실제 값으로 바꿉니다. 기존 프로젝트에 별도 Hosting 사이트를 추가하고 `diary` 대상으로 연결합니다. 이미 일기용 사이트를 만들었다면 `hosting:sites:create`는 생략합니다. 기존 웹사이트의 사이트 ID를 사용하지 마세요. `dist/`만 배포하며 저장소 루트나 비밀 파일은 배포하지 않습니다. 서비스 코드가 공개되어도 Google Drive의 일기·사진은 비공개입니다. 다른 정적 호스팅도 빌드 명령 `npm run build`, 출력 폴더 `dist`로 배포할 수 있습니다. 루트 경로(`/`) 배포를 전제로 합니다.

### GitHub Actions 자동 배포

이 저장소의 배포 대상은 `burndown-studio` 프로젝트의 일기 전용 `daekyuny-diary` 사이트입니다. `.firebaserc`에서 `diary` 대상으로 연결하며, 배포 주소는 `https://daekyuny-diary.web.app`입니다. OAuth 클라이언트의 승인된 JavaScript 원본에도 이 주소를 추가합니다.

`.github/workflows/deploy.yml`은 PR에서 기본 테스트, 코드 형식, Chromium·모바일 Chromium·WebKit 테스트와 빌드를 검사합니다. `main` push 또는 Actions의 **Run workflow** 실행 시 같은 검사를 통과한 뒤 Firebase Hosting의 실제 사이트에 `dist/`를 배포합니다. 알림 Worker는 별도 배포합니다.

저장소 **Settings → Secrets and variables → Actions**에 다음을 등록합니다.

| 종류     | 이름                       | 값                                                                         |
| -------- | -------------------------- | -------------------------------------------------------------------------- |
| Variable | `FIREBASE_PROJECT_ID`      | 배포 대상 Firebase 프로젝트 ID (필수)                                      |
| Variable | `FIREBASE_HOSTING_SITE`    | 별도로 만든 일기용 Hosting 사이트 ID (필수)                                |
| Secret   | `FIREBASE_SERVICE_ACCOUNT` | 해당 프로젝트에 Hosting 배포 권한을 가진 서비스 계정의 JSON 키 전체 (필수) |
| Variable | `GOOGLE_CLIENT_ID`         | 로컬 테스트에 사용한 OAuth 웹 클라이언트 ID (선택)                         |
| Variable | `NOTIFICATION_SERVER`      | 배포한 알림 Worker URL (선택)                                              |

서비스 계정은 [Firebase 공식 Action의 설정 안내](https://github.com/FirebaseExtended/action-hosting-deploy/blob/main/docs/service-account.md)에 따라 준비합니다. JSON 키는 GitHub Secret에 직접 등록하며 저장소에 커밋하지 않습니다. 필수 설정이 없으면 배포 단계가 오류 메시지와 함께 중단됩니다. 선택 변수는 비어 있으면 `config.json` 값을 사용하며, 클라이언트 ID는 배포 후 앱 설정에서도 입력할 수 있습니다.

배포 전에 기존 프로젝트 안에 일기용 Hosting 사이트를 별도로 만듭니다. Actions는 `FIREBASE_HOSTING_SITE`를 `diary` 대상으로 연결해 해당 사이트만 배포하며, 이 값이 없으면 배포를 중단합니다. [Firebase 다중 사이트 안내](https://firebase.google.com/docs/hosting/multisites)

OAuth 클라이언트의 승인된 JavaScript 원본에 일기 사이트 주소(예: `https://YOUR_DIARY_SITE_ID.web.app`)를 추가합니다. 기존 로컬 주소도 유지합니다. 배포 진행 상황과 결과는 저장소 **Actions → Test and deploy Firebase Hosting**에서 확인합니다. [Firebase GitHub 연동 안내](https://firebase.google.com/docs/hosting/github-integration)

## 무료 예약 알림 서버

**Cloudflare Workers Free + KV + Cron**을 사용합니다. 일기 본문·사진·Google 토큰을 서버로 보내지 않습니다. 서버에는 기기의 Web Push 구독 정보와 알림 시각, 일정 식별자·날짜만 저장하며 알림 문구도 일반 문구입니다.

1. Cloudflare 무료 계정을 만들고 `npx wrangler login`으로 로그인합니다.
2. KV와 비밀 키 파일을 준비합니다.

```bash
npx wrangler kv namespace create REMINDERS --config worker/wrangler.toml
node scripts/generate-push-keys.mjs
```

3. 출력된 namespace ID를 `worker/wrangler.toml`의 `id`에 넣습니다. `APP_ORIGIN`은 실제 Firebase 원본(마지막 `/` 없이), `VAPID_SUBJECT`는 본인 연락 이메일(`mailto:...`)로 바꿉니다.
4. 생성된 **`worker/.dev.vars`는 비밀 파일**입니다. 생성 스크립트는 기존 키를 덮어쓰지 않습니다. 다음 명령의 입력 프롬프트에 파일의 해당 값을 각각 붙여 넣습니다.

```bash
npx wrangler secret put VAPID_PUBLIC_KEY --config worker/wrangler.toml
npx wrangler secret put VAPID_PRIVATE_KEY --config worker/wrangler.toml
npx wrangler secret put OWNER_TOKEN --config worker/wrangler.toml
npx wrangler deploy --config worker/wrangler.toml
```

5. 앱 **설정 → 알림 설정**에 Worker URL과 `OWNER_TOKEN`을 넣습니다. `OWNER_TOKEN`과 VAPID 비밀 키는 공유하지 않습니다. 연결 키는 본인 기기에 저장되며 ZIP에는 포함되지 않습니다.
6. 아이폰·아이패드 Safari의 **공유 → 홈 화면에 추가** 후 그 아이콘으로 실행합니다. iOS/iPadOS 16.4 이상에서 알림을 허용하고 테스트 알림을 확인합니다.

알림 동작과 한계:

- 매일 알림은 설정 당시 기기 시간대를 사용합니다. 시간대 변경 시 설정을 다시 저장합니다.
- 일정 알림은 동기화 시 **앞으로 14일분**을 예약합니다. 변경·취소 후 앱에서 다시 동기화해야 반영됩니다. 종일 일정은 제외합니다.
- 무료 KV list 사용량을 고려해 **5분 간격**으로 확인합니다. 최대 약 5분의 처리 지연과 기기·네트워크 지연이 있을 수 있습니다. 15분 이상 지난 알림은 몰아서 보내지 않습니다.
- 기기 알림을 끌 때 서버 구독부터 삭제합니다. 네트워크 오류 시 해제가 완료됐다고 표시하지 않습니다.
- 단일 사용자·소수 기기용입니다. KV는 최종 일관성 저장소이므로 설정 반영 지연과 드문 중복 알림 가능성이 있습니다. 일기 보존과는 무관합니다.
- Web Push 암호화는 자동 테스트로 검증합니다. 무료 Worker의 실제 CPU 사용량, 외부 푸시 서비스 수신은 배포 로그와 실제 기기로 확인해야 합니다.

참고: [Worker 무료 한도](https://developers.cloudflare.com/workers/platform/limits/), [KV 가격](https://developers.cloudflare.com/kv/platform/pricing/), [Apple Web Push](https://webkit.org/blog/13878/web-push-for-web-apps-on-ios-and-ipados/)

## 데이터 보존과 이식

```text
My Diary/
  2026-09-09_<수정 버전 UUID>.md
  2026-09-09_<다음 수정 버전 UUID>.md
  attachments/
    <이미지 UUID>.jpg
```

각 수정은 새 파일로 저장합니다. 앞부분에 JSON 형식의 YAML front matter가 있고 뒤에는 일반 Markdown 본문이 있습니다. `schemaVersion`, `id`, `parents`, `savedAt`, `entry`로 구성되며, `entry`에는 날짜·제목·본문·태그·일정 메모·날씨·이미지 정보가 들어갑니다.

**이미지 원본을 먼저 올리고 일기 업로드가 성공한 후에만 저장 완료로 표시**합니다. 인터넷 단절·권한 만료·용량 부족 시 기기 초안/동기화 대기를 유지합니다. 실패 후 재시도는 파일의 고유 ID로 중복 여부를 확인합니다.

여러 기기가 같은 이전 버전을 수정하면 두 버전 모두 남습니다. 비교 후 본문·일정 메모·사진·태그를 합칠 수 있으며, 제목·날씨는 최근 버전을 선택합니다. 이전 자료도 버전 파일과 전체 백업에 보존합니다. 수정 버전을 자동 삭제하지 않으므로 Drive 공간 사용량은 누적됩니다.

ZIP 백업 구성:

```text
diary.json                        # 전체 버전, 복원용
2026-09-09_<일기 UUID>.md          # 최신 본문, 다른 앱으로 이식
attachments/                     # 사진 원본
history/                         # 충돌 포함 모든 수정 버전
README.txt
```

백업에는 **현재 기기에 불러온 기록**이 들어갑니다. 전체 최신 자료를 내보내려면 먼저 동기화합니다. 사진이 로컬에 없으면 Drive에서 내려받으며, 실패하면 불완전한 백업을 성공으로 내보내지 않습니다. 가져오기는 기존 버전을 덮어쓰지 않으며, 다른 계정의 파일 ID는 제거합니다.

첫 버전 제한: ZIP 가져오기 100MB, 압축 해제 총 250MB, 이미지 한 장 10MB. HEIC와 SVG는 받지 않습니다. 큰 사진 모음의 스트리밍 백업은 후속 개선 대상입니다. Google Keep 직접 가져오기는 구현 범위에 포함하지 않았습니다.

## 날씨와 위치

날짜를 선택한 뒤 **그날의 날씨 추가**에서 도시 또는 현재 위치를 선택합니다. 과거 날짜의 장소를 현재 위치로 자동 추정하지 않습니다. 위치 좌표·시간대·날짜를 함께 저장합니다.

최근 5일은 Open-Meteo Forecast API의 과거 구간, 그 이전은 Historical Weather API를 사용합니다. 오늘·미래는 예보, 과거는 모델/재분석 자료로 표시합니다. 일기 본문은 날씨 서비스에 보내지 않습니다. 개인 비상업용 무료 조건과 출처 표시를 따릅니다. [사용 조건](https://open-meteo.com/en/pricing), [과거 날씨 API](https://open-meteo.com/en/docs/historical-weather-api)

## 구조와 운영 조건

- `src/`: UI, 데이터 모델, IndexedDB, Drive·Calendar·날씨, 백업, 알림 클라이언트
- `worker/`: 개인 알림 API, Cron, 표준 Web Push 암호화
- `assets/`: 아이콘. PNG는 `scripts/icons.mjs`로 재생성
- `scripts/`: 개발 서버, 정적 빌드, 알림 키 생성
- `tests/`: 데이터·암호화 테스트 및 브라우저 테스트
- `artifacts/`: 테스트용 예시 기록의 화면 캡처
- `firebase.json`: 무료 Hosting 배포 설정

현재 무료 정책과 개인 사용량 범위에서 월 운영비 0원을 목표로 합니다. 정책의 영구 유지는 보장되지 않으며 Drive 저장공간은 본인 계정의 여유 공간을 사용합니다. Firebase는 Spark, Cloudflare는 Free를 유지하세요. 유료 요금제에 자동 가입하는 코드는 없습니다.

브라우저의 초안·사진은 IndexedDB에 저장됩니다. 브라우저 데이터 삭제나 OS 저장공간 정리로 **아직 동기화하지 않은 초안**이 사라질 수 있습니다. 앱 자체의 별도 암호화·잠금 기능은 첫 버전 범위에 포함하지 않았습니다.

배포 후 본인 계정으로 Drive 업로드/재연결, 두 기기 수정 충돌, 캘린더 변경·취소, 사진 포함 ZIP 복원, 실제 iPhone/iPad의 앱 종료 상태 알림을 확인하세요.
