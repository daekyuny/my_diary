# Repository Guidelines

개인용 일기 웹앱 **My Diary**의 저장소입니다. 사용자는 한 명(저장소 소유자)이며 대화와 커밋 본문, UI 문구는 한국어, 커밋 제목과 코드 식별자는 영어를 씁니다. 기능·운영 설명은 `README.md`, 결정 이력은 `docs/current-direction.md`에 있습니다. 이 파일은 작업 규칙만 다룹니다.

## Project Structure

프런트엔드는 빌드 도구 없는 ES modules + CSS이며 esbuild는 번들링에만 씁니다. 프레임워크와 런타임 의존성은 `fflate` 하나뿐입니다.

- `index.html`, `src/journal/`: 현재 앱. `app.js`가 화면 상태와 이벤트를 쥔 컨트롤러이고 나머지는 역할별 모듈입니다.
  - `appdata.js`: Google Drive `appDataFolder` 저장소. 2026-09 시트 이전 때 만든 `seed` 파일도 여기서 읽습니다.
  - `remote.js`, `cloud-sync.js`: 저장소 목록을 기기와 병합(pull), 대기 수정본을 묶어 전송(push)
  - `local.js`, `settings.js`, `transfer.js`: IndexedDB 조회·초안 복구·스토어 간 복사, localStorage 설정, ZIP 가져오기·내보내기
  - `views.js`, `labels.js`, `icons.js`, `dom.js`, `photo-viewer.js`: HTML 템플릿, 상태 문구, 아이콘, `$`·toast·download, 사진 뷰어
  - `photos.js`, `backup.js`, `calendar.js`, `updates.js`, `revision-cache.js`, `current.js`: 사진, ZIP 인코딩, Calendar 조회, 앱 업데이트, 수정본 캐시, 수정본 그룹화·연결
  - 순수 함수(`views.js`, `labels.js`, `current.js`, `cloud-sync.js`의 `batches`)는 `tests/journal-modules.test.mjs`에서 검증합니다.
- `src/*.js`: 두 앱이 공유하는 기반. `model.js`(수정본 스키마·검증), `storage.js`(IndexedDB), `google.js`(OAuth·Drive·Calendar 요청), `sync.js`, `body-links.js`
- `legacy.html`, `src/app.js`, `src/weather.js`, `src/notifications.js`, `src/backup.js`, `src/styles.css`: 이전 세대 Drive 폴더 기반 앱. 유지만 하며 변경하지 않습니다.
- `server/`: 토큰 갱신용 Firebase Functions. `worker/`: 푸시 알림용 Cloudflare Worker. 둘 다 별도 배포합니다.
- `scripts/`: 개발 서버·빌드·아이콘 생성. `tests/`: Node 단위 테스트(`*.test.mjs`)와 `tests/browser/` Playwright 테스트
- `vendor/`, `dist/`, `artifacts/`, `test-results/`는 생성물이므로 커밋하지 않습니다.

## Build, Test, and Development Commands

Node.js 22 이상. 처음에는 `npm ci`를 실행합니다.

```bash
npm run dev            # http://localhost:4173, 번들과 아이콘을 생성한 뒤 정적 서비스
npm test               # Node 단위 테스트
npm run test:e2e       # Playwright chromium + mobile-chromium (사전에 npx playwright install chromium)
npm run test:webkit    # Playwright iPhone WebKit (Linux는 install-deps 필요)
npm run format:check   # Prettier 검사, CI 필수
npm run build          # dist/ 생성
git diff --check
```

CI(`.github/workflows/deploy.yml`)는 위 검사를 모두 통과해야 `main` push 시 Firebase Hosting에 배포합니다. 브라우저 테스트는 Google API를 라우트 모의로 대체하며 실제 계정에 접근하지 않습니다.

## Coding Style

- Prettier 설정(`.prettierrc.json`): 작은따옴표, 후행 쉼표, 100자. 커밋 전에 `npm run format:check`를 통과시킵니다.
- 2칸 들여쓰기, LF, 파일 끝 개행(`.editorconfig`).
- 모듈은 `camelCase` 함수와 `kebab-case` 파일명을 씁니다. DOM 접근은 `id` 기반이며 `index.html`의 id를 바꾸면 `app.js`와 브라우저 테스트를 함께 고칩니다.
- 사용자에게 보이는 문구와 오류 메시지는 한국어로 씁니다.
- 새 기능은 `src/journal/` 아래 역할별 모듈로 나누고 `app.js`에는 상태와 이벤트 연결만 남깁니다.

## Data Compatibility

실제 일기 데이터가 이미 저장되어 있으므로 다음은 이전 코드 없이 바꾸지 않습니다.

- `localStorage` 키 `my-diary-sheets-settings`와 그 필드
- IndexedDB 스토어 이름과 소유자 키 형식(`sheets-<permissionId>-<repositoryId>`, `sheets-local`)
- Drive `appProperties`의 `format`(`my-diary-private-v1`), `namespace`, `kind`, `key` 규칙
- `model.js`의 수정본 스키마와 `validateRevision` 규칙
- 서비스 워커 `sw.js`의 `SHELL` 목록과 `scripts/build.mjs`의 버전 해시 파일 목록(파일을 추가·삭제하면 함께 갱신)

## Testing Guidelines

- 순수 로직은 `tests/*.test.mjs`에 `node:test`로 추가합니다. 테스트 이름은 검증하는 동작을 문장으로 씁니다.
- 화면 동작은 `tests/browser/*.spec.js`에 추가하고 `helpers.js`, `appdata-helpers.js`의 모의 라우트를 재사용합니다.
- 동작 변경 PR은 `npm test`와 `npm run test:e2e`를 실행하고, 실행하지 못한 검사는 그렇다고 밝힙니다.

## Commit & Pull Request Guidelines

- 커밋 제목은 영어 명령형 한 줄(`Add zoomable photo viewer`, `Fix WebKit photo fixtures`). 필요하면 본문에 이유를 적습니다.
- 한 커밋에는 한 가지 변경만 담고, 생성물과 개인 데이터(`keep-data.zip`, `imports/`, `config.local.json`)는 커밋하지 않습니다.
- 커밋과 배포는 사용자가 요청할 때만 합니다. `main`에 push하면 곧바로 실제 사이트에 배포됩니다.
- PR에는 변경 이유, 실행한 검사, UI 변경 시 캡처를 적습니다.
