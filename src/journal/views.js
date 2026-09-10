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
        ...(e.fields || []).flatMap((f) => [f.name, f.value]),
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
      return `${heading}<button class="record" data-entry="${escape(e.id)}"><span class="record-date"><strong>${view === 'board' ? `${date.getMonth() + 1}월 ${date.getDate()}일` : String(date.getDate()).padStart(2, '0')}</strong><small>${date.toLocaleDateString('ko-KR', { weekday: 'short' })}</small></span><span class="record-content"><span class="record-top"><h2>${escape(e.title || '제목 없는 하루')}</h2>${e.pinned ? `<span class="pin-mark">${icon('pin')}</span>` : ''}</span><p>${escape(e.body.replace(/!\[[^\]]*\]\(diary-image:[^)]+\)/g, '') || '이날의 순간을 남겨보세요.')}</p><span class="record-meta"><span class="record-tags">${e.tags
        .slice(0, 4)
        .map((tag) => `<span>#${escape(tag)}</span>`)
        .join(
          '',
        )}</span>${attachments}${group.heads.length > 1 ? '<span class="conflicted">다른 기기 수정 확인</span>' : !group.latest.sheetSaved ? '<span class="pending">기기 저장</span>' : ''}</span></span><span class="record-end">${icon('chevron')}</span></button>`;
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
