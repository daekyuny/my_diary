import { seal, unseal, cookie } from './session.js';
const CLIENT = '805909518243-3g88j6fhfkr7h4morn30r9cln0f2j070.apps.googleusercontent.com';
const ORIGINS = new Set([
  'https://daekyuny-diary.web.app',
  'https://daekyuny-diary.firebaseapp.com',
]);
export async function handleAuth(req, res, { secret, fetch = globalThis.fetch }) {
  res.set('Cache-Control', 'private, no-store');
  const origin = req.get('origin');
  if (req.method !== 'POST' || !ORIGINS.has(origin) || req.get('x-diary-auth') !== '1') {
    res.status(403).json({ error: '허용되지 않은 인증 요청입니다.' });
    return;
  }

  const encoded = (req.get('cookie') || '')
    .split(';')
    .map((s) => s.trim())
    .find((s) => s.startsWith('__session='))
    ?.slice(10);
  const session = encoded ? unseal(encoded, secret) : null;
  const action = req.path.split('/').at(-1);
  if (action === 'logout') {
    res.set('Set-Cookie', cookie('', 0));
    res.json({ ok: true });
    return;
  }
  const params = new URLSearchParams({ client_id: CLIENT, client_secret: secret });
  if (action === 'code' && typeof req.body?.code === 'string') {
    params.set('grant_type', 'authorization_code');
    params.set('code', req.body.code);
    params.set('redirect_uri', origin);
  } else if (action === 'token' && session) {
    params.set('grant_type', 'refresh_token');
    params.set('refresh_token', session.refresh);
  } else {
    res.status(401).json({ error: 'Google 최초 연결이 필요합니다.' });
    return;
  }
  try {
    const response = await fetch('https://oauth2.googleapis.com/token', {
      method: 'POST',
      body: params,
      signal: AbortSignal.timeout(20000),
    });
    const tokens = await response.json();
    if (!response.ok) {
      const errors = {
        invalid_client:
          'Google OAuth 클라이언트 ID와 서버의 클라이언트 보안 비밀번호가 일치하는지 확인해야 합니다. (invalid_client)',
        unauthorized_client:
          '이 Google OAuth 클라이언트에는 현재 인증 방식이 허용되지 않습니다. (unauthorized_client)',
        redirect_uri_mismatch:
          'Google OAuth 리디렉션 주소 설정을 확인해야 합니다. (redirect_uri_mismatch)',
        invalid_grant:
          'Google 인증 코드 또는 연결 권한이 만료되었거나 유효하지 않습니다. 다시 연결해주세요. (invalid_grant)',
      };
      const reason = Object.hasOwn(errors, tokens.error) ? tokens.error : 'unknown_oauth_error';
      console.warn('diary_auth_exchange_failed', { action, reason, status: response.status });
      if (tokens.error === 'invalid_grant') res.set('Set-Cookie', cookie('', 0));
      res.status(tokens.error === 'invalid_grant' ? 401 : 502).json({
        error:
          errors[reason] || 'Google 인증 서버가 연결을 거부했습니다. 잠시 후 다시 연결해주세요.',
      });
      return;
    }
    const refresh = tokens.refresh_token || (action === 'token' ? session?.refresh : null);
    if (!refresh) {
      res
        .status(401)
        .json({ error: '장기 연결 권한이 없습니다. Google 연결 권한을 다시 승인해주세요.' });
      return;
    }
    const expires = tokens.refresh_token ? Date.now() + 15552000000 : session.expires;
    res.set(
      'Set-Cookie',
      cookie(
        seal({ refresh, expires, scope: tokens.scope || session?.scope || '' }, secret),
        Math.max(0, Math.floor((expires - Date.now()) / 1000)),
      ),
    );
    res.json({
      access_token: tokens.access_token,
      expires_in: tokens.expires_in,
      scope: tokens.scope || session?.scope || '',
    });
  } catch {
    res.status(503).json({ error: 'Google 인증 서버의 응답이 지연됩니다. 다시 시도해주세요.' });
  }
}
