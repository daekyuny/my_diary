import { KEEP_READ_SCOPE, probeKeep } from './keep-probe-core.js';
const $ = (id) => document.getElementById(id);
$('origin').textContent = location.origin;
let sequence = 0;
function show(result) {
  $('result').textContent = JSON.stringify(
    { checkedAt: new Date().toISOString(), ...result },
    null,
    2,
  );
  $('copy').disabled = false;
}
$('test').onclick = () => {
  const id = $('client-id').value.trim();
  if (!/^[\w.-]+\.apps\.googleusercontent\.com$/.test(id)) {
    show({ stage: '설정', message: '웹 애플리케이션 OAuth 클라이언트 ID를 입력해주세요.' });
    return;
  }
  const oauth = globalThis.google?.accounts?.oauth2;
  if (!oauth) {
    show({
      stage: '설정',
      message:
        'Google 로그인 스크립트가 로드되지 않았습니다. 네트워크나 차단 확장 프로그램을 확인해주세요.',
    });
    return;
  }
  const run = ++sequence;
  $('test').disabled = true;
  show({
    stage: 'OAuth',
    message:
      'Google 로그인 창에서 개인 Gmail 계정을 선택하세요. 창에 오류가 뜨면 오류 코드를 확인해주세요.',
  });
  try {
    oauth
      .initTokenClient({
        client_id: id,
        scope: KEEP_READ_SCOPE,
        include_granted_scopes: false,
        callback: async (response) => {
          if (run !== sequence) return;
          try {
            if (response.error) {
              show({
                stage: 'OAuth',
                success: false,
                error: response.error,
                description: response.error_description || '',
              });
              return;
            }
            if (!response.access_token || !oauth.hasGrantedAllScopes(response, KEEP_READ_SCOPE)) {
              show({
                stage: 'OAuth',
                success: false,
                message: 'Keep 읽기 권한이 발급되지 않았습니다. API 호출은 하지 않았습니다.',
              });
              return;
            }
            show({ stage: 'API', message: 'Keep 읽기 권한 발급됨. 메모 목록을 조회하는 중…' });
            const result = await probeKeep(response.access_token);
            if (run === sequence) show(result);
          } catch {
            show({
              stage: '네트워크',
              success: false,
              message:
                '조회 시간 초과 또는 네트워크·CORS 오류입니다. 계정 지원 여부를 판정할 수 없습니다.',
            });
          } finally {
            response.access_token = ''; // Not persisted or exposed in the UI/logs.
            $('test').disabled = false;
          }
        },
        error_callback: (error) => {
          if (run !== sequence) return;
          show({
            stage: '로그인 창',
            success: false,
            error: error.type || 'unknown',
            message:
              '팝업이 열리지 않았거나 닫혔습니다. Google 오류 화면이 있었다면 해당 오류를 따로 확인해주세요.',
          });
          $('test').disabled = false;
        },
      })
      .requestAccessToken({ prompt: 'select_account' });
  } catch {
    show({ stage: 'OAuth', success: false, message: 'Google 로그인 요청을 시작하지 못했습니다.' });
    $('test').disabled = false;
  }
};
$('copy').onclick = async () => {
  try {
    await navigator.clipboard.writeText($('result').textContent);
    $('copy').textContent = '복사됨';
  } catch {
    $('copy').textContent = '결과를 직접 선택해 복사해주세요';
  }
};
try {
  const config = await fetch('/config.json').then((response) => response.json());
  let settings = {};
  try {
    settings = JSON.parse(localStorage.getItem('my-diary-settings') || '{}');
  } catch {}
  $('client-id').value = config.googleClientId || settings.googleClientId || '';
} catch {}
$('test').disabled = false;
show({ stage: '준비', message: 'OAuth 클라이언트 ID를 확인하고 읽기 테스트를 눌러주세요.' });
