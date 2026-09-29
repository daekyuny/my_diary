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
  return view === 'calendar' && day ? `${day}에 새 기록 남기기` : '오늘은 어떤 하루였나요?';
}
export function weekday(date) {
  return new Date(`${date}T12:00:00`).toLocaleDateString('ko-KR', { weekday: 'long' });
}
export function todayLabel(now = new Date()) {
  return now.toLocaleDateString('ko-KR', {
    year: 'numeric',
    month: 'long',
    day: 'numeric',
    weekday: 'long',
  });
}
export const characterCount = (body) => `${body.length.toLocaleString()}자`;
