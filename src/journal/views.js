import { icon } from './icons.js';
import { localDate } from '../model.js';
export const escape = (text = '') =>
  String(text).replace(
    /[&<>"']/g,
    (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c],
  );
export function visibleGroups(
  groups,
  {
    query = '',
    tag = '',
    from = '',
    to = '',
    collection = 'journal',
    month = '',
    day = '',
    order = 'desc',
  } = {},
) {
  const needle = query.normalize('NFKC').toLocaleLowerCase();
  return groups
    .filter(({ latest: { entry: e } }) => {
      const text = [
        e.title,
        e.body,
        ...e.tags,
        ...e.events.flatMap((event) => [event.title, event.note]),
      ]
        .join('\n')
        .normalize('NFKC')
        .toLocaleLowerCase();
      return (
        (collection === 'archive' ? e.archived : !e.archived) &&
        (collection !== 'pinned' || e.pinned) &&
        (!needle || text.includes(needle)) &&
        (!tag || e.tags.includes(tag)) &&
        (!from || e.date >= from) &&
        (!to || e.date <= to) &&
        (!month || e.date.startsWith(month)) &&
        (!day || e.date === day)
      );
    })
    .sort(
      (a, b) =>
        Number(Boolean(b.latest.entry.pinned)) - Number(Boolean(a.latest.entry.pinned)) ||
        (order === 'asc' ? 1 : -1) * a.latest.entry.date.localeCompare(b.latest.entry.date) ||
        b.latest.savedAt.localeCompare(a.latest.savedAt),
    );
}
export function cards(groups, view, hasFilter = false) {
  if (!groups.length)
    return `<div class="empty"><span class="empty-symbol">${icon(hasFilter ? 'search' : 'book')}</span><h2>${hasFilter ? '찾는 기록이 아직 없어요' : '첫 번째 하루를 남겨보세요'}</h2><p>${hasFilter ? '검색어나 날짜, 태그를 바꿔 찾아보세요.' : '거창하지 않아도 좋아요.<br/>오늘 기억하고 싶은 순간 하나면 충분해요.'}</p>${hasFilter ? '' : `<button id="empty-new" class="primary">${icon('plus')} 첫 기록 쓰기</button>`}</div>`;
  let previous = '';
  return groups
    .map((group) => {
      const e = group.latest.entry,
        date = new Date(`${e.date}T12:00:00`),
        section = e.pinned ? '고정한 기록' : `${date.getFullYear()}년 ${date.getMonth() + 1}월`;
      const heading =
        section !== previous
          ? `<div class="month-label">${escape(section)}<small>—</small></div>`
          : '';
      previous = section;
      const attachments = e.images.length ? `<span>${icon('photo')}${e.images.length}</span>` : '';
      return `${heading}<div class="record-wrap"><button class="record" data-entry="${escape(e.id)}"><span class="record-date"><strong>${view === 'board' ? `${date.getMonth() + 1}월 ${date.getDate()}일` : String(date.getDate()).padStart(2, '0')}</strong><small>${date.toLocaleDateString('ko-KR', { weekday: 'short' })}</small></span><span class="record-content"><span class="record-top"><h2>${escape(e.title || '제목 없는 하루')}</h2>${e.pinned ? `<span class="pin-mark">${icon('pin')}</span>` : ''}</span><p>${escape(e.body.replace(/!\[[^\]]*\]\(diary-image:[^)]+\)/g, '') || '이날의 순간을 남겨보세요.')}</p><span class="record-meta"><span class="record-tags">${e.tags
        .slice(0, 4)
        .map((tag) => `<span>#${escape(tag)}</span>`)
        .join(
          '',
        )}</span>${attachments}${group.latest.conflict || group.heads.length > 1 ? '<span class="conflicted">다른 기기 수정 확인</span>' : !group.latest.sheetSaved ? '<span class="pending">기기 저장</span>' : ''}</span></span><span class="record-end">${icon('chevron')}</span></button><button class="record-delete" data-delete-entry="${escape(e.id)}" aria-label="${escape(e.title || '제목 없는 하루')} ${e.deletedAt ? '복원' : '삭제'}">${e.deletedAt ? '복원' : '삭제'}</button></div>`;
    })
    .join('');
}
export function calendarHTML(month, day, groups) {
  const [year, m] = month.split('-').map(Number),
    counts = new Map();
  groups.forEach(({ latest: { entry: e } }) => counts.set(e.date, (counts.get(e.date) || 0) + 1));
  return `<div class="month-bar"><button data-month-step="-1" aria-label="이전 달">${icon('back')}</button><input id="calendar-month" type="month" aria-label="캘린더 월" value="${month}"/><button data-month-step="1" aria-label="다음 달">${icon('arrow')}</button><button id="calendar-today">오늘</button><button id="clear-day">선택 해제</button></div><div class="month-grid">${['일', '월', '화', '수', '목', '금', '토'].map((d) => `<span>${d}</span>`).join('')}${'<span class="blank"></span>'.repeat(new Date(year, m - 1, 1).getDay())}${Array.from(
    { length: new Date(year, m, 0).getDate() },
    (_, i) => {
      const date = `${month}-${String(i + 1).padStart(2, '0')}`;
      return `<button data-day="${date}" class="${date === localDate() ? 'today' : ''}" aria-label="${date}, 일기 ${counts.get(date) || 0}개" aria-pressed="${date === day}"><span>${i + 1}</span><small>${counts.get(date) ? `${counts.get(date)}개의 기록` : ''}</small></button>`;
    },
  ).join('')}</div>`;
}
export function validateDefinition(field) {
  if (!field.name.trim() || field.name.length > 50)
    throw new Error('항목 이름은 1~50자로 입력해주세요.');
  if (!['text', 'number', 'date', 'select'].includes(field.type))
    throw new Error('지원하지 않는 입력 방식입니다.');
  if (field.type === 'select' && !field.options?.length)
    throw new Error('선택지를 하나 이상 입력해주세요.');
  return field;
}
export const visibleEvents = (entry) => (entry.calendarTemplate === false ? [] : entry.events);
export const eventTime = (event) =>
  event.allDay
    ? '종일'
    : event.start
      ? new Date(event.start).toLocaleTimeString('ko-KR', { hour: '2-digit', minute: '2-digit' })
      : '';
export function tagOptionsHTML(tags) {
  return (
    '<option value="">모든 태그</option>' +
    tags.map((t) => `<option value="${escape(t)}">${escape(t)}</option>`).join('')
  );
}
export function tagLinksHTML(tags, active) {
  return tags.length
    ? tags
        .map(
          (t) =>
            `<button class="label-link ${t === active ? 'active' : ''}" data-label="${escape(t)}">${escape(t)}</button>`,
        )
        .join('')
    : '<p class="muted">기록에 태그를 붙여 모아보세요.</p>';
}
export function tagSuggestionsHTML(tags) {
  return tags.map((t) => `<option value="${escape(t)}"></option>`).join('');
}
export function readingDetailsHTML(entry) {
  return [
    entry.tags.length
      ? `<p class="reading-tags">${entry.tags.map((tag) => escape('#' + tag)).join(' ')}</p>`
      : '',
    ...visibleEvents(entry).map(
      (event) =>
        `<article class="reading-event"><h2>${escape(event.title)}</h2><small>${escape(eventTime(event))} ${escape(event.location || '')}</small><p>${escape(event.note || '')}</p></article>`,
    ),
  ].join('');
}
export function eventsHTML(entry) {
  return visibleEvents(entry)
    .map(
      (event, i) =>
        `<article><div class="event-top"><input data-event-title="${i}" value="${escape(event.title)}" aria-label="일정 제목"/><button type="button" data-remove-event="${i}" aria-label="${escape(event.title)} 일정 제거">${icon('close')}</button></div><small>${escape(eventTime(event))} ${escape(event.location || '')}</small><textarea data-event-note="${i}" aria-label="일정 메모" placeholder="이 일정에서 기억할 것">${escape(event.note)}</textarea></article>`,
    )
    .join('');
}
export function conflictHTML(revision) {
  return `<p>같은 일기가 다른 기기에서도 수정됐습니다. 기기 수정본과 클라우드 기록을 별도로 보존할 수 있습니다.</p><h3>이 기기</h3><pre>${escape(revision.entry.body)}</pre><h3>클라우드</h3><pre>${escape(revision.conflict.entry.body)}</pre><button id="keep-conflict-copy" class="primary">기기 수정본을 별도 일기로 보존</button>`;
}
export function calendarChoiceHTML(date, calendars) {
  return `<p>${escape(date)}의 일정을 가져옵니다. Google 일정 원본은 수정하지 않습니다.</p>${calendars.map((c) => `<label class="form-label"><input type="checkbox" name="calendar-choice" value="${escape(c.id)}" ${c.primary ? 'checked' : ''}/> ${escape(c.summary)}</label>`).join('')}<button id="import-events" class="primary">선택한 일정 가져오기</button>`;
}
export function repositoryOptionsHTML(files) {
  return files
    .map(
      (file) =>
        `<option value="${escape(file.id)}">${escape(file.name)} · ${escape(file.id.slice(-8))}</option>`,
    )
    .join('');
}
