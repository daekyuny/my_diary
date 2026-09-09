export const SCHEMA_VERSION = 1;

export function localDate(date = new Date()) {
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`;
}

export function validDate(value) {
  return (
    typeof value === 'string' &&
    /^\d{4}-\d{2}-\d{2}$/.test(value) &&
    !Number.isNaN(Date.parse(value)) &&
    new Date(value).toISOString().slice(0, 10) === value
  );
}

export function newEntry(date = localDate()) {
  return {
    id: crypto.randomUUID(),
    date,
    title: '',
    body: '',
    tags: [],
    events: [],
    images: [],
    weather: null,
  };
}

export function validateEntry(entry) {
  if (
    !entry ||
    typeof entry.id !== 'string' ||
    !/^[\w-]{1,100}$/.test(entry.id) ||
    !validDate(entry.date)
  )
    throw new Error('올바르지 않은 일기 형식입니다.');
  for (const field of ['title', 'body'])
    if (typeof entry[field] !== 'string') throw new Error('일기 내용이 올바르지 않습니다.');
  for (const field of ['tags', 'events', 'images'])
    if (!Array.isArray(entry[field])) throw new Error('일기 목록 형식이 올바르지 않습니다.');
  if (!entry.tags.every((tag) => typeof tag === 'string'))
    throw new Error('태그 형식이 올바르지 않습니다.');
  if (
    !entry.images.every(
      (img) =>
        /^[\w-]{1,100}$/.test(img.id) &&
        typeof img.name === 'string' &&
        /^image\/(jpeg|png|webp|gif)$/.test(img.type),
    )
  )
    throw new Error('지원하지 않는 첨부 이미지입니다.');
  if (
    !entry.events.every(
      (event) =>
        typeof event.key === 'string' &&
        typeof event.title === 'string' &&
        typeof event.note === 'string',
    )
  )
    throw new Error('일정 형식이 올바르지 않습니다.');
  if (entry.weather != null) {
    const weather = entry.weather;
    if (
      !validDate(weather.date) ||
      typeof weather.label !== 'string' ||
      typeof weather.kind !== 'string' ||
      !Number.isFinite(weather.min) ||
      !Number.isFinite(weather.max) ||
      typeof weather.location?.name !== 'string' ||
      !Number.isFinite(weather.location.latitude) ||
      !Number.isFinite(weather.location.longitude)
    ) {
      throw new Error('날씨 형식이 올바르지 않습니다.');
    }
  }
  return entry;
}

export function makeRevision(entry, parents = []) {
  validateEntry(entry);
  return {
    schemaVersion: SCHEMA_VERSION,
    id: crypto.randomUUID(),
    parents: [...new Set(parents)],
    savedAt: new Date().toISOString(),
    entry: structuredClone(entry),
  };
}

export function validateRevision(revision) {
  if (
    !revision ||
    revision.schemaVersion !== SCHEMA_VERSION ||
    typeof revision.id !== 'string' ||
    !/^[\w-]{1,100}$/.test(revision.id) ||
    !Array.isArray(revision.parents) ||
    !revision.parents.every(
      (id) => typeof id === 'string' && /^[\w-]{1,100}$/.test(id) && id !== revision.id,
    ) ||
    typeof revision.savedAt !== 'string' ||
    !Number.isFinite(Date.parse(revision.savedAt))
  )
    throw new Error('지원하지 않는 일기 버전입니다.');
  validateEntry(revision.entry);
  return revision;
}

// Revisions are immutable: concurrent edits become separate heads, never overwritten.
export function heads(revisions) {
  const parents = new Set(revisions.flatMap((revision) => revision.parents));
  return revisions
    .filter((revision) => !parents.has(revision.id))
    .sort((a, b) => b.savedAt.localeCompare(a.savedAt) || b.id.localeCompare(a.id));
}

export function entryGroups(revisions) {
  const groups = new Map();
  for (const revision of revisions) {
    const key = revision.entry.id;
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(revision);
  }
  return [...groups.values()].map((versions) => ({
    versions,
    heads: heads(versions),
    latest: heads(versions)[0],
  }));
}

export function filterGroups(
  groups,
  { query = '', tag = '', from = '', to = '', order = 'desc' } = {},
) {
  const needle = query.normalize('NFKC').toLocaleLowerCase();
  return groups
    .filter(({ latest: { entry } }) => {
      const text = [
        entry.title,
        entry.body,
        ...entry.tags,
        ...entry.events.flatMap((e) => [e.title, e.note]),
      ]
        .join('\n')
        .normalize('NFKC')
        .toLocaleLowerCase();
      return (
        text.includes(needle) &&
        (!tag || entry.tags.includes(tag)) &&
        (!from || entry.date >= from) &&
        (!to || entry.date <= to)
      );
    })
    .sort(
      (a, b) => (order === 'asc' ? 1 : -1) * a.latest.entry.date.localeCompare(b.latest.entry.date),
    );
}

export function mergeEvents(existing, incoming) {
  const next = new Map(incoming.map((event) => [event.key, event]));
  const result = existing.map((event) => {
    if (!next.has(event.key)) return { ...event, missing: true };
    const update = next.get(event.key);
    next.delete(event.key);
    return { ...event, ...update, note: event.note, remind: event.remind, missing: false };
  });
  return [...result, ...next.values()];
}

export function calendarEvent(event, calendarId) {
  return {
    key: `${calendarId}:${event.id}`,
    calendarId,
    eventId: event.id,
    title: event.summary || '(제목 없는 일정)',
    start: event.start?.dateTime || event.start?.date,
    end: event.end?.dateTime || event.end?.date,
    allDay: Boolean(event.start?.date),
    location: event.location || '',
    note: '',
    remind: !event.start?.date,
    missing: false,
  };
}

export function eventDate(event) {
  return event.allDay ? event.start : localDate(new Date(event.start));
}

export function imageFileName(image) {
  const ext = { 'image/jpeg': 'jpg', 'image/png': 'png', 'image/webp': 'webp', 'image/gif': 'gif' }[
    image.type
  ];
  return `${image.id}.${ext}`;
}

export function markdown(entry) {
  let body = entry.body;
  for (const image of entry.images)
    body = body.replaceAll(`diary-image:${image.id}`, `attachments/${imageFileName(image)}`);
  const lines = [
    `# ${entry.date}${entry.title ? ` · ${entry.title}` : ''}`,
    '',
    entry.tags.map((tag) => `#${tag}`).join(' '),
    '',
    body,
  ];
  if (entry.weather)
    lines.push(
      '',
      `> 날씨: ${entry.weather.label} · ${entry.weather.min}–${entry.weather.max}°C · ${entry.weather.location.name}`,
      `> ${entry.weather.kind} · Open-Meteo (https://open-meteo.com/) · ${entry.weather.date}`,
    );
  for (const event of entry.events)
    lines.push(
      '',
      `## ${event.title} (예정된 일정)`,
      `${event.start} – ${event.end}${event.location ? ` · ${event.location}` : ''}`,
      '',
      event.note || '_기록을 남겨보세요._',
    );
  for (const image of entry.images)
    if (!entry.body.includes(`diary-image:${image.id}`))
      lines.push(
        '',
        `![${image.name.replace(/[\[\]]/g, '')}](attachments/${imageFileName(image)})`,
      );
  return `${lines.join('\n').trim()}\n`;
}

export function revisionFile(revision) {
  const portable = {
    schemaVersion: revision.schemaVersion,
    id: revision.id,
    parents: revision.parents,
    savedAt: revision.savedAt,
    entry: revision.entry,
  };
  return `---\n${JSON.stringify(portable, null, 2)}\n---\n\n${markdown(revision.entry)}`;
}

export function parseRevision(text) {
  const match = /^---\n([\s\S]*?)\n---\n/.exec(text);
  if (!match) throw new Error('일기 메타데이터가 없습니다.');
  return validateRevision(JSON.parse(match[1]));
}

export function weatherLabel(code) {
  if (code === 0) return '맑음';
  if (code <= 3) return '구름 조금 / 흐림';
  if (code <= 48) return '안개';
  if (code <= 67) return '비';
  if (code <= 77) return '눈';
  if (code <= 82) return '소나기';
  if (code <= 86) return '눈 소나기';
  return '뇌우';
}
