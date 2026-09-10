# My Diary · 하루를 모으는 곳

PC·태블릿·모바일에서 같은 일기를 이어 쓰는 반응형 웹앱입니다. 개인 Google 계정으로 연결하며 **Google Drive의 `My Diary` 폴더 안에 스프레드시트 하나**를 원본 저장소로 사용합니다. PC에 Drive 폴더를 동기화할 필요가 없습니다.

## 작성과 탐색

- 목록·카드·월간 캘린더 보기, 날짜·태그·본문·추가항목·일정 메모 검색
- 같은 날짜의 여러 기록, 상단 고정, 보관함과 복원
- PC 사이드 메뉴와 넓은 편집 창, 모바일 하단 탐색과 전체 화면 편집
- 입력 중 기기 초안 저장, 입력을 멈추면 저장, Google 연결 시 Sheets에 반영
- 다른 기기의 변경은 화면에 돌아올 때와 화면이 열린 동안 약 25초 간격으로 확인
- **설정 → 추가 항목 관리:** 텍스트·숫자·날짜·선택 목록 항목 생성, 이름·입력 방식 수정, 숨김
- 추가 항목의 내부 ID는 이름 변경 후에도 유지합니다. 숨긴 항목도 과거 일기의 값은 남습니다. 일기에서 항목 제거는 그 일기에만 적용합니다.
- Google Calendar에서 선택한 날짜의 일정 가져오기, 직접 일정 작성, 일정별 메모
- 사진 원본 첨부·원본 보기, My Diary ZIP 백업, Google Keep ZIP 가져오기

로그인 전에는 기기에만 저장합니다. 연결 전 기록은 **설정 → 연결 전 기기 기록 가져오기**로 원하는 계정에 명시적으로 옮깁니다. Google 접근 토큰은 메모리에만 보관하므로 재접속·권한 만료 시 재연결이 필요할 수 있습니다. Docs의 글자 단위 실시간 공동 편집과는 다릅니다.

## 로컬 실행

Node.js 22 이상:

```bash
npm ci
npm run dev
```

`http://localhost:4173`을 엽니다. API 설정이 완료되기 전에도 로컬 기록과 반응형 화면을 사용할 수 있습니다.

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

Linux WebKit 실행에는 시스템 라이브러리가 필요할 수 있습니다. `npx playwright install-deps webkit`으로 설치합니다. `build`는 생성물인 `dist/`를 새로 만들어 정적 호스팅용 파일만 복사합니다. 개발 서버는 새로고침 때 JavaScript 번들을 갱신합니다.

## Google 연결 설정

1. 기존 OAuth 클라이언트가 있는 Google Cloud 프로젝트에서 **Google Sheets API, Google Drive API, Google Calendar API**를 활성화합니다. Calendar는 일정 기능에만 필요합니다.
2. Google Auth Platform에서 개인 계정은 **External / Testing**으로 설정하고 본인 Gmail을 테스트 사용자로 등록합니다.
3. 웹 OAuth 클라이언트의 승인된 JavaScript 원본에 `http://localhost:4173`과 배포 주소 `https://daekyuny-diary.web.app`을 추가합니다. 경로는 넣지 않습니다.
4. 앱의 Google 연결 버튼을 누르고 본인 계정으로 승인합니다.
5. 처음에는 **새 My Diary 시트 만들기**를 누릅니다. 기존 `My Diary` 폴더에 스프레드시트를 만들고 `일기`, `추가항목`, `일정`, `설정` 탭을 준비합니다. 기존 파일을 삭제하지 않습니다.
6. 다른 기기에서도 같은 웹앱 주소와 Google 계정으로 연결합니다. 앱이 만든 시트는 Drive의 앱 속성으로 찾으며 하나면 자동 선택합니다. 여러 개면 사용자가 선택합니다.

설정의 **기존 시트 찾기·연결**에서 파일을 다시 검색하고 연결할 수 있습니다. 시트 생성 도중 Sheets API 활성화·통신 문제로 초기 설정이 중단되면 기존 파일을 선택한 후 **초기 설정 이어서 완료**를 사용합니다. 기존 내용을 덮어쓰지 않고 누락된 필수 탭을 추가합니다.

Sheets와 사진에는 `drive.file`, 캘린더에는 별도로 `calendar.readonly`를 요청합니다. 앱이 만든 파일만 접근하는 범위이므로 다른 OAuth 앱이 만든 파일을 ID만 입력해 자동 접근할 수는 없습니다. 기존 폴더가 현재 OAuth 앱에 보이지 않으면 같은 이름의 폴더가 새로 만들어질 수 있습니다. 현재 저장소는 이전 일기 앱과 같은 OAuth 클라이언트를 사용합니다.

공개 클라이언트 ID는 `config.json`에 설정했습니다. 필요하면 앱 설정 또는 Git에서 제외된 `config.local.json`에서 바꿀 수 있습니다. **클라이언트 보안 비밀은 사용하지 않습니다.**

```json
{
  "googleClientId": "YOUR_CLIENT_ID.apps.googleusercontent.com",
  "notificationServer": ""
}
```

실제 Google 계정의 권한 승인·시트 생성은 사용자 로그인 후 별도 확인이 필요합니다. 자동 테스트는 외부 API를 모의하며 실제 계정의 자료를 사용하지 않습니다.

참고: [Sheets 권한](https://developers.google.com/workspace/sheets/api/scopes), [Google 토큰 모델](https://developers.google.com/identity/oauth2/web/guides/use-token-model), [Calendar 일정 조회](https://developers.google.com/workspace/calendar/api/v3/reference/events/list)

## 저장 구조와 충돌 처리

| 탭       | 저장 내용                                                                                   |
| -------- | ------------------------------------------------------------------------------------------- |
| 일기     | 수정 ID, 일기 ID, 이전 수정 ID, 저장 시각, 날짜, 제목, 미리보기, 태그, 고정·보관 상태, 본문 |
| 추가항목 | 수정 ID에 연결된 사용자 정의 항목 값, 사진·이전 자료의 메타데이터                           |
| 일정     | 수정 ID에 연결된 Google·직접 작성 일정과 메모                                               |
| 설정     | 형식 식별자와 사용자 정의 항목 설정                                                         |

Sheets에는 일반 DB의 조건부 갱신 트랜잭션이 없으므로, **수정할 때 새 행을 추가하고 이전 수정 ID로 연결**합니다. 앱 화면은 각 일기의 최신 상태만 보여줍니다. 여러 기기가 같은 이전 기록을 수정해도 두 내용을 남기고, 비교 후 합칠 수 있습니다. `일기`, `추가항목`, `일정` 추가는 하나의 `batchUpdate`에 묶습니다. 재시도 시 수정 ID를 확인하고, 응답 유실로 중복 행이 생겨도 동일 ID는 화면에서 하나로 취급합니다.

따라서 시트를 직접 열면 같은 일기의 수정 이력이 여러 행으로 보입니다. **새 기록·항목 변경은 웹앱에서 수행하는 것을 기본으로 합니다.** 행 전체의 정렬은 다시 읽을 때 ID로 찾지만, 셀 일부만 정렬하거나 수정 ID·연결 정보를 직접 고치면 읽기와 충돌 판단이 깨질 수 있습니다. 설정의 동시 변경은 마지막에 추가된 설정을 적용하고 앞선 값은 시트에 보존합니다.

목록은 제목·날짜·미리보기 등의 열만 읽고, 본문은 기록을 열거나 검색할 때 불러와 기기에 캐시합니다. 전체 본문 검색·백업·첫 가져오기는 데이터량에 비례해 느려질 수 있습니다. 현재 전체 검색은 미수신 본문을 순서대로 조회하며 API 한도에 도달하면 오류를 표시합니다. 대량 자료의 검색 인덱스·진행 재개·이력 압축은 후속 개선 대상입니다. 편집 이력이 누적되므로 장기 용량은 일기 편수뿐 아니라 수정 횟수도 고려해야 합니다.

본문은 편당 12만 자까지, 셀당 3만 자씩 네 칸으로 나누어 저장합니다. 입력은 수식이 아닌 문자열로 저장합니다. 사용자 항목·일정 단일 값은 45,000자 이내입니다. 서버 저장에 실패하면 로컬 기록과 원본 사진을 유지하며 저장 완료로 표시하지 않습니다.

참고: [Sheets 일괄 수정](https://developers.google.com/workspace/sheets/api/reference/rest/v4/spreadsheets/batchUpdate), [API 한도](https://developers.google.com/workspace/sheets/api/limits)

## 사진과 기존 데이터

사진 원본은 Google Drive의 `My Diary/attachments`에 저장하고 시트에는 파일 ID를 연결합니다. JPG·PNG·WebP·GIF, 사진당 10MB까지 지원합니다. 첨부 해제·보관은 Drive 원본 파일을 삭제하지 않습니다.

`keep-data.zip`은 **나중에 가져올 개인 원본**입니다. 프로젝트 루트에 보존하며 Git·개발 서버·배포 대상에서 제외합니다. 이 파일을 자동으로 읽거나 가져오지 않습니다.

앱 설정에서 ZIP을 직접 선택하면 다음을 지원합니다.

- Google Takeout Keep ZIP: `My Diary` 라벨이 있고 휴지통에 없는 메모를 가져옵니다. 제목 앞의 `YYYY-MM-DD` 날짜가 있으면 사용하고, 없으면 생성일을 사용합니다. 태그·지원하는 사진·고정·보관 상태를 보존합니다.
- My Diary ZIP: 수정 이력과 사진 원본을 가져옵니다.
- 같은 Keep 원본을 다시 가져와도 경로·생성 시각 기반 ID로 중복 기록을 막습니다. 이미 가져온 메모를 이후 변경한 ZIP의 갱신 병합은 별도 기능입니다.
- 지원하지 않는 첨부나 원본 누락은 가져오기 전에 오류로 알립니다. 입력 ZIP 100MB, 압축 해제 총 300MB까지 지원합니다.
- 백업은 기기에 알려진 모든 수정과 원본 사진을 포함합니다. 전체 최신 자료를 원하면 먼저 Google에 연결하고 새로고침합니다. 아직 본문·사진을 받지 못했으면 불완전한 백업을 성공으로 내보내지 않습니다.

이전 Drive 버전은 `/legacy.html`에 보존되어 있습니다. [이전 버전 사용 안내](docs/legacy-drive.md)를 참고하세요. 해당 화면의 Drive 동기화는 사용자가 직접 실행한 경우에만 수행됩니다. 새 앱의 저장은 Sheets를 사용합니다. 기존 Drive 파일 삭제는 사용자가 직접 진행합니다.

## 개발 구조와 배포

- `src/journal/app.js`: 화면 동작과 저장·연결 흐름
- `src/journal/views.js`, `icons.js`, `styles.css`: 목록·카드·캘린더, 반응형 화면
- `src/journal/sheets.js`: Sheets 스키마·원본 조회·행 추가·공통 항목 설정
- `src/journal/backup.js`: Keep/My Diary ZIP 가져오기와 백업
- `src/model.js`, `storage.js`, `google.js`, `sync.js`: 공통 모델·IndexedDB·Google API·사진 조회
- `src/app.js`, `legacy.html`: 이전 Drive 일기 앱
- `scripts/`: esbuild 번들·개발 서버·정적 빌드
- `tests/`: 모델·ZIP·API 요청 테스트와 Playwright PC·모바일 테스트
- `artifacts/journal-*.png`: 개인 데이터 없는 예시 기록의 화면 캡처

현재 배포 대상은 `burndown-studio` 프로젝트의 `daekyuny-diary` 사이트입니다. Firebase는 Hosting에만 사용하며 Firestore·Firebase Storage는 필요 없습니다. 기존 `.github/workflows/deploy.yml`은 검사 후 `main` push 시 배포합니다. 이번 작업은 로컬 구현이며 실제 사이트 배포는 별도입니다.

```bash
npm run build
npx firebase-tools deploy --only hosting:diary --project burndown-studio
```

기존 Worker 알림 코드와 날씨 모듈은 보존했으나 새 화면에는 아직 연결하지 않았습니다. 새 화면의 일정은 사용자가 선택해서 가져오는 방식입니다.

Sheets 요청은 공식 `https://sheets.googleapis.com/v4/` 주소로 전송합니다. 로그인한 계정에서 시트 연결 전에 작성한 임시 기록은 첫 시트 연결 시 업로드합니다. 로그인 전 기록은 설정의 **연결 전 기기 기록 가져오기**로 가져옵니다.
