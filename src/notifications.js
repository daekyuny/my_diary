import { localDate } from './model.js';

export function decodeBase64(value) {
  return Uint8Array.from(atob(value.replace(/-/g, '+').replace(/_/g, '/')), (char) =>
    char.charCodeAt(0),
  );
}

async function api(config, path, body) {
  if (!config?.server || !config?.secret)
    throw new Error('알림 서버 주소와 연결 키를 설정해주세요.');
  const url = new URL(config.server);
  if (url.protocol !== 'https:' && url.hostname !== 'localhost')
    throw new Error('알림 서버는 HTTPS 주소여야 합니다.');
  const response = await fetch(`${url.origin}${path}`, {
    method: body ? 'POST' : 'GET',
    headers: {
      Authorization: `Bearer ${config.secret}`,
      ...(body ? { 'Content-Type': 'application/json' } : {}),
    },
    ...(body ? { body: JSON.stringify(body) } : {}),
  });
  if (!response.ok)
    throw new Error(`알림 서버 연결 실패 (${response.status}). 주소와 연결 키를 확인해주세요.`);
  return response.json();
}

export async function enablePush(config) {
  if (!('serviceWorker' in navigator) || !('PushManager' in window))
    throw new Error('홈 화면에 추가한 지원 브라우저에서 알림을 설정해주세요.');
  const { publicKey } = await api(config, '/config');
  const registration = await navigator.serviceWorker.ready;
  const existing = await registration.pushManager.getSubscription();
  if (existing?.options?.applicationServerKey) {
    const current = new Uint8Array(existing.options.applicationServerKey);
    const next = decodeBase64(publicKey);
    if (current.length !== next.length || current.some((byte, index) => byte !== next[index])) {
      throw new Error(
        '다른 알림 서버의 구독이 남아 있습니다. 기존 설정에서 알림을 끈 뒤 새 서버를 연결해주세요.',
      );
    }
  }
  const subscription =
    existing ||
    (await registration.pushManager.subscribe({
      userVisibleOnly: true,
      applicationServerKey: decodeBase64(publicKey),
    }));
  return subscription.toJSON();
}

export async function syncReminders(config, events) {
  const delay = Number(config.delay || 0) * 60000;
  const reminders = events
    .map((event) => ({
      id: event.key,
      at: new Date(new Date(event.end).getTime() + delay).toISOString(),
      date: localDate(new Date(event.start)),
    }))
    .filter((event) => Date.parse(event.at) > Date.now());
  await api(config, '/subscribe', {
    subscription: config.subscription,
    daily: Boolean(config.daily),
    time: config.time || '21:00',
    timezone: config.timezone,
    events: reminders,
  });
}

export async function disablePush(config) {
  const registration = await navigator.serviceWorker.ready;
  const subscription = await registration.pushManager.getSubscription();
  if (config?.subscription)
    await api(config, '/unsubscribe', { endpoint: config.subscription.endpoint });
  await subscription?.unsubscribe();
}
export const testPush = (config) =>
  api(config, '/test', { endpoint: config?.subscription?.endpoint });
