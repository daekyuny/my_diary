// User-facing text derived from app state. Pure functions so they can be unit tested.
export function connectionLabel({ working, onLine, connected, repository, pending, account }) {
  if (working) return '저장·연결 중…';
  if (!onLine) return '오프라인 · 기기 저장';
  if (connected && repository) return pending ? '클라우드 저장 대기' : '클라우드 연결됨';
  if (connected) return '저장소 연결 필요 · 기기 저장';
  return account ? 'Google 재연결 필요' : '기기에 저장';
}
export function repositoryDetails(repository, pending, online) {
  if (!repository) return '연결된 저장소 없음 · 현재 기록은 이 기기에만 저장됩니다.';
  const active = repository.index.filter((r) => !r.entry.deletedAt).length,
    trashed = repository.index.length - active;
  return `저장소 ID: ${repository.id} · 클라우드 일기 ${active}개 · 휴지통 ${trashed}개 · 이 기기 저장 대기 ${pending}개${online ? '' : ' · 재연결 후 최신 개수 확인'}`;
}
export function saveStateLabel({ dirty, conflicted, cloudSaved, activeRevision }) {
  if (dirty) return '저장하지 않은 변경';
  if (conflicted) return '다른 기기 수정 확인';
  if (cloudSaved) return '✓ 클라우드 저장 완료';
  return activeRevision ? '✓ 기기에 저장' : '새 기록';
}
export function pageTitle(collection, view) {
  return {
    journal: view === 'calendar' ? '날짜로 보는 기록' : '나의 기록',
    pinned: '고정한 기록',
    archive: '삭제한 기록',
  }[collection];
}
export function pageDescription(collection) {
  return collection === 'archive'
    ? '잠시 접어둔 기억도 이곳에 그대로.'
    : collection === 'pinned'
      ? '자주 꺼내 보고 싶은 나의 순간들.'
      : '평범한 하루에도, 기억하고 싶은 순간은 있으니까.';
}
export function quickLabel(view, day) {
  if (view !== 'calendar' || !day) return '오늘 기록 남기기';
  const [, month, date] = day.split('-').map(Number);
  return `${month}월 ${date}일에 새 기록 남기기`;
}
const WEEKDAYS = ['일', '월', '화', '수', '목', '금', '토'];
// One date style across reading, editing and the calendar: "2026년 9월 29일 화요일".
export function dateLabel(date) {
  const [year, month, day] = date.split('-').map(Number);
  return `${year}년 ${month}월 ${day}일 ${WEEKDAYS[new Date(year, month - 1, day).getDay()]}요일`;
}
export function monthLabel(month) {
  const [year, m] = month.split('-').map(Number);
  return `${year}년 ${m}월`;
}
export function todayLabel(now = new Date()) {
  return now.toLocaleDateString('ko-KR', {
    year: 'numeric',
    month: 'long',
    day: 'numeric',
    weekday: 'long',
  });
}
// Video length as shown on its preview: 0:07, 3:25, 1:02:03.
export function durationLabel(seconds = 0) {
  const s = Math.max(0, Math.round(seconds)),
    h = Math.floor(s / 3600),
    m = Math.floor((s % 3600) / 60),
    pad = (n) => String(n).padStart(2, '0');
  return h ? `${h}:${pad(m)}:${pad(s % 60)}` : `${m}:${pad(s % 60)}`;
}
export const characterCount = (body) => `${body.length.toLocaleString()}자`;
