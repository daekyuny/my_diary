import { base64, bytes, unbase64, validEndpoint, sendPush } from './push.js';

export async function deviceKey(endpoint) {
  return `device:${base64(new Uint8Array(await crypto.subtle.digest('SHA-256', bytes(endpoint))))}`;
}

export function validateSchedule(body) {
  const subscription = body?.subscription;
  if (
    !validEndpoint(subscription?.endpoint) ||
    typeof subscription?.keys?.auth !== 'string' ||
    typeof subscription?.keys?.p256dh !== 'string'
  )
    throw new Error('Invalid subscription');
  if (
    unbase64(subscription.keys.auth).length !== 16 ||
    unbase64(subscription.keys.p256dh).length !== 65
  )
    throw new Error('Invalid subscription keys');
  if (!/^([01]\d|2[0-3]):[0-5]\d$/.test(body.time)) throw new Error('Invalid daily time');
  new Intl.DateTimeFormat('en', { timeZone: body.timezone }).format();
  if (typeof body.timezone !== 'string' || !Array.isArray(body.events) || body.events.length > 500)
    throw new Error('Invalid schedule');
  const events = body.events.map((event) => {
    if (
      typeof event.id !== 'string' ||
      event.id.length > 1024 ||
      !Number.isFinite(Date.parse(event.at)) ||
      !/^\d{4}-\d{2}-\d{2}$/.test(event.date)
    )
      throw new Error('Invalid event');
    return { id: event.id, at: event.at, date: event.date };
  });
  return {
    subscription,
    daily: Boolean(body.daily),
    time: body.time,
    timezone: body.timezone,
    events,
  };
}

export function dueReminders(config, now = new Date()) {
  const parts = Object.fromEntries(
    new Intl.DateTimeFormat('en-CA', {
      timeZone: config.timezone,
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      hourCycle: 'h23',
    })
      .formatToParts(now)
      .map((part) => [part.type, part.value]),
  );
  const date = `${parts.year}-${parts.month}-${parts.day}`;
  const minutes = Number(parts.hour) * 60 + Number(parts.minute);
  const [hour, minute] = config.time.split(':').map(Number);
  const due = [];
  const dailyId = `daily:${date}`;
  if (
    config.daily &&
    minutes >= hour * 60 + minute &&
    minutes < hour * 60 + minute + 15 &&
    !config.sent?.[dailyId]
  )
    due.push({
      id: dailyId,
      date,
      title: '오늘의 한 줄을 남겨볼까요?',
      body: '기억하고 싶은 이름, 숫자, 작은 순간을 적어보세요.',
    });
  for (const event of config.events) {
    const id = `event:${event.id}:${event.at}`;
    const age = now.getTime() - Date.parse(event.at);
    if (age >= 0 && age < 15 * 60000 && !config.sent?.[id])
      due.push({
        id,
        date: event.date,
        title: '일정이 끝났어요',
        body: '방금 있었던 일을 일기에 남겨보세요.',
      });
  }
  return due;
}

function headers(env) {
  return {
    'Access-Control-Allow-Origin': env.APP_ORIGIN,
    'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
    'Access-Control-Allow-Headers': 'Authorization, Content-Type',
    'Content-Type': 'application/json',
    'Cache-Control': 'no-store',
    Vary: 'Origin',
  };
}

export default {
  async fetch(request, env) {
    const reply = (data, status = 200) =>
      new Response(JSON.stringify(data), { status, headers: headers(env) });
    if (request.headers.get('Origin') !== env.APP_ORIGIN)
      return reply({ error: 'Origin not allowed' }, 403);
    if (request.method === 'OPTIONS')
      return new Response(null, { status: 204, headers: headers(env) });
    if (
      !env.OWNER_TOKEN ||
      env.OWNER_TOKEN.length < 32 ||
      request.headers.get('Authorization') !== `Bearer ${env.OWNER_TOKEN}`
    )
      return reply({ error: 'Unauthorized' }, 401);
    const path = new URL(request.url).pathname;
    if (request.method === 'GET' && path === '/config')
      return reply({ publicKey: env.VAPID_PUBLIC_KEY });
    if (request.method !== 'POST') return reply({ error: 'Not found' }, 404);
    try {
      if (Number(request.headers.get('Content-Length')) > 150000)
        return reply({ error: 'Payload too large' }, 413);
      const text = await request.text();
      if (text.length > 150000) return reply({ error: 'Payload too large' }, 413);
      const body = JSON.parse(text);
      if (path === '/subscribe') {
        const config = validateSchedule(body);
        const key = await deviceKey(config.subscription.endpoint);
        const previous = await env.REMINDERS.get(key, 'json');
        await env.REMINDERS.put(
          key,
          JSON.stringify({
            ...config,
            sent: previous?.sent || {},
            updatedAt: new Date().toISOString(),
          }),
        );
        return reply({ ok: true });
      }
      if (path === '/unsubscribe' || path === '/test') {
        if (!validEndpoint(body.endpoint)) return reply({ error: 'Invalid endpoint' }, 400);
        const key = await deviceKey(body.endpoint);
        if (path === '/unsubscribe') {
          await env.REMINDERS.delete(key);
          return reply({ ok: true });
        }
        const config = await env.REMINDERS.get(key, 'json');
        if (!config) return reply({ error: 'Device not registered' }, 404);
        await sendPush(
          config.subscription,
          {
            title: 'My Diary 알림이 준비됐어요',
            body: '이제 기억하고 싶은 순간을 놓치지 마세요.',
            url: env.APP_ORIGIN,
            tag: 'my-diary-test',
          },
          env,
        );
        return reply({ ok: true });
      }
      return reply({ error: 'Not found' }, 404);
    } catch (error) {
      console.error('Notification request failed:', error.message);
      return reply({ error: 'Invalid request or push service unavailable' }, 400);
    }
  },
  async scheduled(controller, env) {
    const now = new Date(controller.scheduledTime);
    let cursor;
    do {
      const list = await env.REMINDERS.list({
        prefix: 'device:',
        limit: 100,
        ...(cursor ? { cursor } : {}),
      });
      for (const item of list.keys) {
        const config = await env.REMINDERS.get(item.name, 'json');
        if (!config) continue;
        const due = dueReminders(config, now);
        if (!due.length) continue;
        config.sent ||= {};
        let expired = false;
        for (const reminder of due) {
          try {
            const status = await sendPush(
              config.subscription,
              {
                title: reminder.title,
                body: reminder.body,
                url: `${env.APP_ORIGIN}/?date=${reminder.date}`,
                tag: reminder.id,
              },
              env,
            );
            if (status === 404 || status === 410) {
              await env.REMINDERS.delete(item.name);
              expired = true;
              break;
            }
            config.sent[reminder.id] = now.toISOString();
          } catch (error) {
            console.error('Push delivery failed:', error.message);
          }
        }
        if (!expired) {
          config.sent = Object.fromEntries(
            Object.entries(config.sent).filter(
              ([, sentAt]) => now - new Date(sentAt) < 16 * 86400000,
            ),
          );
          // Reload to avoid overwriting a newer user schedule. A deleted device stays deleted.
          const latest = await env.REMINDERS.get(item.name, 'json');
          if (latest)
            await env.REMINDERS.put(
              item.name,
              JSON.stringify({ ...latest, sent: { ...latest.sent, ...config.sent } }),
            );
        }
      }
      cursor = list.list_complete ? undefined : list.cursor;
    } while (cursor);
  },
};
