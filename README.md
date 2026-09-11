# My Diary · 하루를 모으는 곳

PC·태블릿·모바일에서 같은 일기를 이어 쓰는 반응형 웹앱입니다. 개인 Google 계정으로 연결하며 **Google Drive의 앱 전용 공간(`appDataFolder`)**에 일기 JSON과 사진을 저장합니다. 일반 Drive 화면과 PC 미러링 폴더에 새 일기 파일이 나타나지 않습니다. 다른 작업 폴더의 미러링 설정은 유지할 수 있습니다.

## 작성과 탐색

- 목록·카드·월간 캘린더 보기, 날짜·태그·제목·기기에 보관된 본문·일정 메모 검색
- 같은 날짜의 여러 기록, 상단 고정, 목록에서 삭제, 휴지통과 복원
- PC 사이드 메뉴와 넓은 편집 창, 모바일 하단 탐색과 전체 화면 편집
- 기존 일기는 읽기 모드로 열고 제목 옆 수정 버튼으로 편집, 새 일기는 바로 작성
- 하단 저장 버튼으로 기기에 기록한 뒤 목록으로 복귀, 클라우드 전송은 백그라운드 처리하며 완료 알림 표시
- 변경 없으면 저장 비활성화, 미저장 상태에서 닫기 확인
- 다른 기기의 변경은 화면에 돌아올 때와 화면이 열린 동안 약 25초 간격으로 확인
- Google Calendar에서 선택한 날짜의 일정 가져오기, 직접 일정 작성, 일정별 메모
- 사진 원본 첨부·원본 보기, My Diary ZIP 백업, Google Keep ZIP 가져오기

로그인 전에는 기기에만 저장합니다. 연결 전 기록은 **설정 → 연결 전 기기 기록 가져오기**로 원하는 계정에 명시적으로 옮깁니다. 접근 토큰은 탭 세션에 보관해 새로고침 시 복원합니다. 장기 인증 서버를 활성화하면 만료 토큰도 자동 갱신합니다. 서버 설정 전에는 만료 후 재연결이 필요합니다. Docs의 글자 단위 실시간 공동 편집과는 다릅니다.

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
5. 기존 사용자는 Google에 다시 연결해 `drive.appdata` 권한을 승인합니다. 기존 시트가 하나면 자동으로 복사·검증 후 이전합니다. 여러 개면 **기존 일기 찾기·이전**에서 선택합니다. 신규 사용자는 **새 일기 저장소 만들기**를 누릅니다.
6. 모든 PC와 모바일에서 같은 Google 계정, 같은 OAuth 앱 프로젝트, 최신 앱 버전을 사용합니다. 새 저장소는 앱 속성으로 자동 발견합니다. OAuth 프로젝트를 바꾸면 기존 앱 전용 데이터에 접근하지 못할 수 있습니다.

`drive.appdata`는 새 일기·사진 저장, `drive.file`은 기존 시트와 사진을 읽어 이전하는 데 사용합니다. 캘린더에는 선택적으로 `calendar.readonly`를 요청합니다. Google Auth Platform의 데이터 액세스 설정에도 새 범위를 등록하세요. 기존 로그인 토큰에 권한이 없으면 자동 이전하지 않고 재연결을 안내합니다.

이전 과정은 원본 시트에 쓰거나 원본 사진을 삭제하지 않습니다. 중단되면 다시 연결하여 재시도할 수 있습니다. 다른 기기의 구버전 앱은 이전된 데이터를 알지 못하므로 이전 중에는 기존 시트에 쓰는 작업을 멈추고, 이후 모든 기기에서 최신 앱을 사용하세요.

공개 클라이언트 ID는 `config.json`에 설정했습니다. 필요하면 앱 설정 또는 Git에서 제외된 `config.local.json`에서 바꿀 수 있습니다. **클라이언트 보안 비밀은 사용하지 않습니다.**

```json
{
  "googleClientId": "YOUR_CLIENT_ID.apps.googleusercontent.com",
  "notificationServer": ""
}
```

실제 Google 계정의 권한 승인·앱 전용 저장소 접근은 사용자 로그인 후 별도 확인이 필요합니다. 자동 테스트는 외부 API를 모의하며 실제 계정의 자료를 사용하지 않습니다.

참고: [Sheets 권한](https://developers.google.com/workspace/sheets/api/scopes), [Google 토큰 모델](https://developers.google.com/identity/oauth2/web/guides/use-token-model), [Calendar 일정 조회](https://developers.google.com/workspace/calendar/api/v3/reference/events/list)

## 저장 구조와 이전

- `root`: 이전 완료 표시, 검증된 초기 일기 파일 목록, 초기 휴지통 설정
- `seed`: 기존 시트에서 읽어 검증한 일기 JSON. 완료 표시가 참조하는 파일만 읽습니다.
- `revision`: 일기별 불변 수정본과 부모 버전 ID. 동일 버전 재전송은 중복 표시되지 않습니다.
- `asset`: 원본과 최대 480px JPEG 썸네일. 일기별 소유 공간으로 분리합니다.
- `retention`, `purge`: 휴지통 설정과 완전 삭제 표식

기존 시트는 읽기 전용 스냅샷으로 가져옵니다. 본문·태그·일정·사진·휴지통 상태를 옮기고, 업로드한 각 파일을 다시 내려받아 SHA-256으로 검증합니다. 복사 전후 시트 스냅샷이 다르면 전환하지 않습니다. 실패한 이전의 미완성 일기는 완료 표시가 없어 노출되지 않습니다. 기존 시트의 최신 일기만 가져오며 과거 시트 행은 원본에 보존합니다.

**기존 `My Diary` 폴더와 시트·사진은 자동 삭제하지 않습니다.** 따라서 이미 미러링된 기존 사본은 그대로 남습니다. 새 데이터는 숨김 공간에 저장됩니다. 모든 기기에서 이전 결과를 확인하고 ZIP 백업을 확보한 후 기존 폴더를 정리해야 기존 미러링 사본의 공간도 회수됩니다. 구버전 앱에서 이후 수정한 내용은 새 저장소로 자동 병합되지 않습니다.

수정본은 덮어쓰지 않습니다. 동시에 같은 일기를 수정하면 두 내용을 모두 보존하고 충돌 해결 버튼을 표시합니다. 한쪽을 별도 일기로 보존한 뒤 두 부모를 연결한 해결 버전을 저장합니다. 세 기기 이상 충돌은 남은 충돌을 이어서 해결합니다. 일기 파일 목록은 페이지를 나누어 조회하며, 한번 읽은 불변 버전은 OAuth 클라이언트·Google 계정·저장소별 IndexedDB 캐시에 보관하여 새로고침 후에도 재사용합니다. 매번 서버 파일 목록과 삭제 표식을 확인하고, 캐시에 없는 JSON만 최대 6개씩 병렬로 읽습니다. 캐시를 사용할 수 없으면 서버에서 다시 읽으며 미전송 기록은 별도로 보존합니다. 첫 연결이나 캐시 삭제 후에는 저장된 수정본 수에 비례한 조회 비용이 듭니다. 사진 원본은 이 캐시에 저장하지 않습니다.

휴지통은 0/7/30/90/365일(기본 30일)을 지원합니다. 기간이 지난 일기의 삭제 표식을 먼저 저장한 후 본문 버전과 그 일기 소유의 사진을 삭제합니다. 중단된 삭제는 재연결 때 다시 시도합니다. 삭제 표식은 오래된 오프라인 기기가 일기를 되살리지 못하게 유지합니다. 충돌 중인 일기는 자동 완전 삭제하지 않습니다.

앱 전용 데이터는 Drive 화면에서 직접 열거나 공유할 수 없습니다. Drive 설정에서 앱 데이터를 삭제하면 데이터가 소실될 수 있으므로 앱의 ZIP 백업을 사용하세요. 숨김 공간은 암호화된 개인 금고와 같은 별도의 종단간 암호화를 제공하는 기능은 아닙니다.

참고: [앱 전용 공간과 제약](https://developers.google.com/workspace/drive/api/guides/appdata)

## 사진과 기기 캐시

JPG·PNG·WebP·GIF, 사진당 10MB까지 지원합니다. 일기를 열면 썸네일을 읽고 클릭할 때 원본을 가져옵니다. 업로드와 일기 저장이 끝난 원본 캐시는 정리하며 새로 열어본 앱 전용 원본은 지속 저장하지 않습니다. 썸네일 캐시는 정리 시 최대 20MB로 제한하고 미전송 기록·초안의 첨부는 보호합니다. 브라우저 자체의 HTTP 캐시는 별개입니다.

첨부 해제 시 현재 일기에서 연결을 없애지만, 동시 수정과 과거 버전의 참조를 보호하기 위해 클라우드 사진은 일기 완전 삭제 때 정리합니다. 사진은 일기별로 소유하며 충돌 사본의 사진은 별도로 보관하므로 한 일기를 완전 삭제해도 사본의 사진이 지워지지 않습니다. 구글 포토에는 접근하지 않습니다.

`keep-data.zip`은 **나중에 가져올 개인 원본**입니다. 프로젝트 루트에 보존하며 Git·개발 서버·배포 대상에서 제외합니다. 이 파일을 자동으로 읽거나 가져오지 않습니다.

앱 설정에서 ZIP을 직접 선택하면 다음을 지원합니다.

- Google Takeout Keep ZIP: `My Diary` 라벨이 있고 휴지통에 없는 메모를 가져옵니다. 제목 앞의 `YYYY-MM-DD` 날짜가 있으면 사용하고, 없으면 생성일을 사용합니다. 태그·지원하는 사진·고정·보관 상태를 보존합니다.
- My Diary ZIP: 현재 일기와 사진 원본을 가져옵니다. 과거 이력이 포함된 ZIP은 일기별 최신 값만 사용합니다.
- 같은 Keep 원본을 다시 가져와도 경로·생성 시각 기반 ID로 중복 기록을 막습니다. 이미 가져온 메모를 이후 변경한 ZIP의 갱신 병합은 별도 기능입니다.
- 지원하지 않는 첨부나 원본 누락은 가져오기 전에 오류로 알립니다. 입력 ZIP 100MB, 압축 해제 총 300MB까지 지원합니다.
- 백업은 기기에 알려진 모든 수정과 원본 사진을 포함합니다. 전체 최신 자료를 원하면 먼저 Google에 연결하고 새로고침합니다. 아직 본문·사진을 받지 못했으면 불완전한 백업을 성공으로 내보내지 않습니다.

이전 Drive 버전은 `/legacy.html`에 보존되어 있습니다. [이전 버전 사용 안내](docs/legacy-drive.md)를 참고하세요. 해당 화면의 Drive 동기화는 사용자가 직접 실행한 경우에만 수행됩니다. 새 앱의 저장은 앱 전용 공간을 사용합니다. 기존 Drive 파일 삭제는 사용자가 직접 진행합니다.

## 개발 구조와 배포

- `src/journal/app.js`: 화면 동작과 저장·연결 흐름
- `src/journal/views.js`, `icons.js`, `styles.css`: 목록·카드·캘린더, 반응형 화면
- `src/journal/appdata.js`: 앱 전용 저장소·검증된 이전·버전 충돌·휴지통 정리
- `src/journal/sheets.js`: 기존 시트 해석과 이전 버전 호환 코드
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

기존 시트 읽기는 공식 `https://sheets.googleapis.com/v4/`를 사용합니다. 새 일기 저장은 Drive API를 사용하며 Sheets API에 쓰지 않습니다. 로그인 전 기록은 설정의 **연결 전 기기 기록 가져오기**로 옮깁니다.

장기 연결 서버의 설정과 배포: [인증 서버 안내](docs/auth-server.md). 보안 비밀은 프런트엔드 설정이나 Git에 넣지 않습니다.

저장은 기기 저장 후 백그라운드에서 순차 전송합니다. 업로드와 검증에 실패하면 기기 기록이 남아 다음 동기화에서 재시도합니다. 브라우저를 닫으면 전송은 중단되지만 미전송 기기 데이터는 보존합니다.

새 저장소의 브라우저 검증: `npm run test:e2e -- --grep 'private storage|existing Sheets migrate'`. `tests/browser/sheets.spec.js`는 기존 시트의 읽기 전용 이전과 실패 복구를 검증합니다. 실제 Google 계정의 OAuth 승인, 앱 데이터 접근, Drive 데스크톱 미러링 제외는 모의 API 테스트만으로 검증되지 않습니다.
