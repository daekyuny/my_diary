import { icon, hydrateIcons } from './icons.js';
import { escape, visibleGroups, cards, calendarHTML, validateDefinition } from './views.js';
import { SheetsRepository, findSheets, createSheet, initializeSheet } from './sheets.js';
import { parseArchive, stableKeepIds, makeBackup } from './backup.js';
import { newEntry, localDate, validDate, makeRevision, mergeEvents } from '../model.js';
import { entryGroups, expired } from './current.js';
import * as store from '../storage.js';
import * as google from '../google.js';
import { createPhoto, previewBlob, uploadPhoto, cleanLocalPhotos } from './photos.js';
import { assetBlob } from '../sync.js';

const $ = (selector) => document.querySelector(selector);
hydrateIcons();
let settings;
try {
  settings = JSON.parse(localStorage.getItem('my-diary-sheets-settings') || '{}');
} catch {
  settings = {};
}
let account = settings.account || null,
  repository = null,
  groups = [],
  definitions = [],
  entry = null,
  parents = [],
  activeRevision = '',
  dirty = false,
  busy = false,
  editing = true,
  desiredFocus = null,
  loadGeneration = 0,
  syncing = false,
  syncWork = null,
  syncAgain = false,
  syncImages = [],
  syncProgress = '',
  updateReady = false,
  closeRequested = false,
  savedContent = null,
  ready = false;
let draftWrite = Promise.resolve(),
  saveTimer,
  toastTimer,
  searchTimer,
  searchGeneration = 0,
  photoGeneration = 0,
  urls = [],
  collection = 'journal',
  day = '',
  month = localDate().slice(0, 7),
  visibleLimit = 40,
  lastRefresh = 0;
let view = ['list', 'board', 'calendar'].includes(settings.view) ? settings.view : 'list';
const owner = () =>
  account
    ? `sheets-${account.permissionId}-${settings.sheets?.[account.permissionId] || 'unassigned'}`
    : 'sheets-local';
function persistSettings() {
  localStorage.setItem('my-diary-sheets-settings', JSON.stringify(settings));
}
function toast(message, error = false) {
  clearTimeout(toastTimer);
  $('#toast').textContent = message;
  $('#toast').classList.toggle('error', error);
  $('#toast').hidden = false;
  toastTimer = setTimeout(() => ($('#toast').hidden = true), error ? 13000 : 5000);
}
function locks(value) {
  $('#editor-form')
    .querySelectorAll('input,textarea,select,button')
    .forEach((el) => (el.disabled = value));
  for (const id of [
    'new-entry',
    'quick-entry',
    'bottom-new',
    'sync',
    'connect',
    'banner-connect',
    'settings-connect',
    'disconnect',
    'select-sheet',
    'find-sheets',
    'create-sheet',
    'repair-sheet',
    'import',
    'export',
    'move-local',
    'new-definition',
    'purge-trash',
    'save-retention',
  ])
    $('#' + id).disabled = value;
}
async function task(fn) {
  if (busy || !ready) return;
  busy = true;
  locks(true);
  connection();
  try {
    return await fn();
  } catch (error) {
    $('#cloud-error').textContent = error.message || '작업을 완료하지 못했습니다.';
    $('#cloud-error').hidden = false;
    toast(error.message || '작업을 완료하지 못했습니다.', true);
  } finally {
    busy = false;
    locks(false);
    connection();
    if (desiredFocus && $('#editor-dialog').open) desiredFocus.focus({ preventScroll: true });
    desiredFocus = null;
    if (closeRequested) {
      closeRequested = false;
      task(closeEditor);
    }
  }
}
function connection() {
  const online = google.connected() && navigator.onLine;
  const pending = groups.filter((group) => !group.latest.sheetSaved).length;
  $('#connection').textContent =
    busy || syncing
      ? '저장·연결 중…'
      : !navigator.onLine
        ? '오프라인 · 기기 저장'
        : online && repository
          ? pending
            ? '클라우드 저장 대기'
            : 'Sheets 연결됨'
          : online
            ? '시트 연결 필요 · 기기 저장'
            : account
              ? 'Google 재연결 필요'
              : '기기에 저장';
  $('#sync-progress').textContent =
    syncProgress || (pending ? `${pending}개 기록이 이 기기에서 저장을 기다립니다.` : '');
  $('#resume-sync').hidden = !pending || !repository;
  $('#resume-sync').disabled = busy || syncing || !navigator.onLine;
  $('#apply-update').hidden = !updateReady;
  $('#apply-update').disabled = busy || syncing || dirty;
  $('#connect-banner').hidden = Boolean(online && repository);
  $('#account-name').textContent = account?.displayName || '나만의 일기장';
  $('#account-caption').textContent = account?.emailAddress || 'Google Sheets에 연결하세요';
  $('#avatar').textContent = (account?.displayName || 'M').slice(0, 1);
  $('#settings-account').textContent = account
    ? `${account.emailAddress} · ${online ? 'Google 연결됨' : '재연결 필요'}`
    : '연결 전 기록은 이 기기에만 저장됩니다.';
  $('#save').disabled = busy || !dirty;
  document
    .querySelectorAll('.record, [data-delete-entry]')
    .forEach((button) => (button.disabled = busy));
  $('#disconnect').hidden = !account;
  for (const id of [
    'disconnect',
    'select-sheet',
    'find-sheets',
    'create-sheet',
    'repair-sheet',
    'import',
    'export',
    'move-local',
    'purge-trash',
  ])
    $('#' + id).disabled = busy || syncing;
  for (const id of ['connect', 'banner-connect', 'settings-connect']) {
    $('#' + id).disabled = busy || syncing || online;
  }
  $('#sheet-options').hidden = false;
  $('#sheet-select').parentElement.hidden = !$('#sheet-select').options.length;
  $('#select-sheet').hidden = !$('#sheet-select').options.length;
  $('#repair-sheet').hidden = !$('#sheet-select').options.length;
  $('#open-sheet').hidden = !repository;
  $('#create-sheet').hidden = Boolean(repository) || Boolean($('#sheet-select').options.length);
  $('#sheet-help').textContent = repository
    ? '연결된 시트가 있습니다. 내 시트 열기에서 저장 위치와 내용을 확인하세요.'
    : !online
      ? '새 시트 만들기를 누르면 Google 로그인부터 진행합니다. 로그인 후 기존 시트가 없으면 생성할 수 있습니다.'
      : $('#sheet-select').options.length
        ? '기존 시트를 선택해 연결해주세요.'
        : '아직 시트가 연결되지 않았습니다. 새 My Diary 시트 만들기를 눌러주세요.';
  if (repository) $('#open-sheet').href = repository.url;
  if (!$('#settings-dialog').open)
    $('#trash-days').value = String(repository?.retentionDays ?? settings.trashDays ?? 30);
  $('#move-local').hidden = !account || !repository;
  $('#sheet-details').textContent = repository
    ? `시트 ID: ${repository.id} · 시트에서 확인한 일기 ${repository.index.filter((r) => !r.entry.deletedAt).length}개 · 휴지통 ${repository.index.filter((r) => r.entry.deletedAt).length}개 · 이 기기 저장 대기 ${pending}개${online ? '' : ' · 재연결 후 최신 개수 확인'}`
    : '연결된 시트 없음 · 현재 기록은 이 기기에만 저장됩니다.';
  if (entry)
    $('#save-state').textContent = dirty
      ? '저장하지 않은 변경'
      : groups.find((g) => g.latest.entry.id === entry.id)?.heads.length > 1
        ? '다른 기기 수정 확인'
        : groups.find((g) => g.latest.id === activeRevision)?.latest.sheetSaved
          ? '✓ Sheets 저장 완료'
          : activeRevision
            ? '✓ 기기에 저장'
            : '새 기록';
}
function filter() {
  return {
    query: $('#search').value.trim(),
    tag: $('#tag-filter').value,
    from: $('#from').value,
    to: $('#to').value,
    collection,
    order: $('#sort').value,
  };
}
function render() {
  const tags = [...new Set(groups.flatMap((g) => g.latest.entry.tags))].sort(),
    tag = $('#tag-filter').value;
  $('#tag-filter').innerHTML =
    '<option value="">모든 태그</option>' +
    tags.map((t) => `<option value="${escape(t)}">${escape(t)}</option>`).join('');
  $('#tag-filter').value = tag;
  $('#sidebar-labels').innerHTML = tags.length
    ? tags
        .map(
          (t) =>
            `<button class="label-link ${t === tag ? 'active' : ''}" data-label="${escape(t)}">${escape(t)}</button>`,
        )
        .join('')
    : '<p class="muted">기록에 태그를 붙여 모아보세요.</p>';
  $('#tag-suggestions').innerHTML = tags
    .map((t) => `<option value="${escape(t)}"></option>`)
    .join('');
  const base = filter(),
    shown = visibleGroups(groups, { ...base, ...(view === 'calendar' ? { month, day } : {}) });
  $('#records').className = `records ${view === 'board' ? 'board' : 'list'}`;
  $('#records').innerHTML =
    cards(
      shown.slice(0, visibleLimit),
      view,
      Boolean(base.query || base.tag || base.from || base.to || day || collection !== 'journal'),
    ) +
    (shown.length > visibleLimit
      ? '<button id="load-more" class="button">기록 더 보기</button>'
      : '');
  $('#result-count').textContent = `${shown.length}개의 기록`;
  $('#total-count').textContent = groups.filter((g) => !g.latest.entry.archived).length;
  $('#page-title').innerHTML =
    {
      journal: view === 'calendar' ? '날짜로 보는 기록' : '나의 기록',
      pinned: '고정한 기록',
      archive: '삭제한 기록',
    }[collection] + '<span class="title-dot">.</span>';
  $('#page-description').textContent =
    collection === 'archive'
      ? '잠시 접어둔 기억도 이곳에 그대로.'
      : collection === 'pinned'
        ? '자주 꺼내 보고 싶은 나의 순간들.'
        : '평범한 하루에도, 기억하고 싶은 순간은 있으니까.';
  $('#quick-label').textContent =
    view === 'calendar' && day ? `${day}에 새 기록 남기기` : '오늘은 어떤 하루였나요?';
  $('#calendar').hidden = view !== 'calendar';
  if (view === 'calendar')
    $('#calendar').innerHTML = calendarHTML(month, day, visibleGroups(groups, base));
  $('#reset-filters').hidden = !(base.query || base.tag || base.from || base.to);
  document.querySelectorAll('[data-collection]').forEach((button) => {
    button.classList.toggle('active', button.dataset.collection === collection);
    button.setAttribute('aria-pressed', String(button.dataset.collection === collection));
  });
  document
    .querySelectorAll('[data-view]')
    .forEach((button) => button.setAttribute('aria-pressed', String(button.dataset.view === view)));
  for (const id of ['bottom-journal', 'bottom-calendar', 'bottom-pinned'])
    $('#' + id).classList.toggle(
      'active',
      id ===
        (collection === 'pinned'
          ? 'bottom-pinned'
          : view === 'calendar'
            ? 'bottom-calendar'
            : 'bottom-journal'),
    );
  connection();
}
async function load() {
  const generation = ++loadGeneration;
  const revisions = await store.all('revisions');
  for (const r of revisions) {
    if (r.entry.archived && !r.entry.deletedAt) {
      r.entry.archived = false;
      await store.put('revisions', r);
    }
  }
  if (generation !== loadGeneration) return;
  groups = entryGroups(revisions);
  const keep = new Set(groups.map((g) => g.latest.id));
  for (const r of revisions) if (!keep.has(r.id)) await store.remove('revisions', r.id);
  if (generation === loadGeneration) render();
}
async function hydrate(revision) {
  if (!revision.summary) return revision;
  if (!repository || !google.connected())
    throw new Error('이 기기에 아직 본문이 없습니다. Google에 연결해 불러와주세요.');
  const full = await repository.read(revision);
  await store.put('revisions', full);
  return full;
}
async function refresh() {
  if (!repository || !google.connected() || !navigator.onLine) return;
  const remote = await repository.list();
  definitions = repository.settings;
  settings.definitions ||= {};
  settings.definitions[account.permissionId] = definitions;
  persistSettings();
  const local = new Map((await store.all('revisions')).map((r) => [r.id, r]));
  const current = new Set(remote.map((r) => r.id));
  for (const r of local.values())
    if (r.sheetSaved && !current.has(r.id)) await store.remove('revisions', r.id);
  for (const revision of remote) {
    const existing = local.get(revision.id);
    const pending = [...local.values()].find(
      (r) => r.entry.id === revision.entry.id && !r.sheetSaved,
    );
    if (pending && pending.id !== revision.id) continue;
    await store.mergeRemoteRevision(
      existing && !existing.summary
        ? { ...existing, sheetSaved: true, row: revision.row, tab: revision.tab }
        : revision,
    );
  }
  await load();
  lastRefresh = Date.now();
  if (entry && !dirty && !editing) {
    const group = groups.find((g) => g.latest.entry.id === entry.id);
    if (group && group.heads.length === 1 && group.latest.id !== activeRevision) {
      const r = await hydrate(group.latest);
      entry = structuredClone(r.entry);
      savedContent = JSON.stringify(entry);
      parents = [r.id];
      activeRevision = r.id;
      fillEditor();
    }
  }
}
function changed() {
  if (!entry) return;
  dirty = JSON.stringify(entry) !== savedContent;
  connection();
}

async function save(sync = true, commit = false) {
  clearTimeout(saveTimer);
  await draftWrite;
  if (dirty && commit) {
    const previous = groups.find((g) => g.latest.entry.id === entry.id)?.latest;
    const revision = {
      ...makeRevision(entry, parents),
      remoteKnown: Boolean(previous?.sheetSaved || previous?.remoteKnown),
    };
    await store.replaceCurrent(revision);
    activeRevision = revision.id;
    parents = [revision.id];
    dirty = false;
    savedContent = JSON.stringify(entry);
    await load();
  }
  if (sync) await syncCloud();
  connection();
}
function syncCloud() {
  if (!repository || !google.connected() || !navigator.onLine) return Promise.resolve();
  if (syncWork) {
    syncAgain = true;
    return syncWork;
  }
  syncing = true;
  connection();
  syncWork = (async () => {
    let saved = false;
    do {
      syncAgain = false;
      const pending = (await store.all('revisions')).filter((r) => !r.sheetSaved && !r.summary);
      syncImages = pending.flatMap((r) => r.entry.images);
      for (let offset = 0; offset < pending.length;) {
        const batch = [];
        let bytes = 0;
        while (offset < pending.length && batch.length < 20) {
          const size = new TextEncoder().encode(JSON.stringify(pending[offset])).length;
          if (batch.length && bytes + size > 500000) break;
          bytes += size;
          batch.push(pending[offset++]);
        }
        for (const revision of batch) {
          for (const image of revision.entry.images) await uploadPhoto(image);
          for (const removed of revision.entry.removedImages || []) {
            const original = await store.get('assets', removed.id);
            removed.driveId ||= original?.driveId;
            const thumb = await store.get(
              'assets',
              removed.thumbnail?.id || `${removed.id}-thumbnail`,
            );
            if (thumb?.driveId)
              removed.thumbnail = {
                id: thumb.id,
                name: thumb.name,
                type: thumb.type,
                driveId: thumb.driveId,
              };
          }
          await store.acknowledgeRevision(revision);
        }
        syncProgress = `이번 묶음 ${batch.length}개를 Sheets에 저장하고 있습니다. 전체 저장 대기 ${pending.length - offset + batch.length}개`;
        connection();
        await repository.saveMany(batch);
        for (const revision of batch) {
          delete revision.entry.removedImages;
          await store.acknowledgeRevision({ ...revision, sheetSaved: true, remoteKnown: true });
          saved = true;
        }
        await load();
      }
      await load();
    } while (syncAgain || (await store.all('revisions')).some((r) => !r.sheetSaved && !r.summary));
    if (!entry && !busy) await refresh();
    syncImages = [];
    await cleanLocalPhotos(entry?.images || []);
    syncProgress = '';
    $('#cloud-error').hidden = true;
    if (saved && !syncAgain) toast('Google Sheets에 저장했습니다.');
  })()
    .catch((error) => {
      syncProgress = '전송이 중단되었습니다. 남은 기록은 기기에 보관됩니다.';
      $('#cloud-error').textContent = error.message;
      $('#cloud-error').hidden = false;
      throw error;
    })
    .finally(() => {
      syncWork = null;
      syncing = false;
      syncImages = [];
      connection();
      if (syncAgain) queueMicrotask(() => syncCloud().catch((error) => toast(error.message, true)));
    });
  return syncWork;
}
function saveAndClose() {
  if (!editing || !dirty || busy) return;
  task(async () => {
    await save(false, true);
    await closeEditor();
    toast('기기에 저장했습니다.');
    return true;
  }).then((committed) => {
    if (!committed) return;
    resumeConnection().catch((error) => toast(`기기에 저장되어 있습니다. ${error.message}`, true));
  });
}
async function openEntry(id, date = day || localDate()) {
  await save(false);
  const group = groups.find((g) => g.latest.entry.id === id);
  const revision = group ? await hydrate(group.latest) : null;
  entry = revision ? structuredClone(revision.entry) : { ...newEntry(date), fields: [] };
  parents = revision ? [revision.id] : [];
  activeRevision = revision?.id || '';
  dirty = false;
  editing = !revision;
  savedContent = JSON.stringify(entry);
  const draft = await store.get('drafts', entry.id);
  if (draft) {
    entry = draft.entry;
    parents = draft.parents;
    dirty = true;
    editing = true;
  }
  fillEditor();
  if (!$('#editor-dialog').open) $('#editor-dialog').showModal();
  desiredFocus = editing ? $('#entry-title') : $('#edit-entry');
}
function fieldDefinition(field) {
  return definitions.find((d) => d.id === field.id) || { ...field, type: 'text', options: [] };
}
function renderFields() {
  $('#fields-empty').hidden = Boolean(entry.fields?.length);
  $('#fields').innerHTML = (entry.fields || [])
    .map((field, i) => {
      const def = { ...fieldDefinition(field) };
      if (
        !['text', 'number', 'date', 'select'].includes(def.type) ||
        (def.type === 'date' && field.value && !validDate(field.value)) ||
        (def.type === 'number' && field.value && !Number.isFinite(Number(field.value)))
      )
        def.type = 'text';
      const id = `field-value-${i}`;
      const input =
        def.type === 'select'
          ? `<select id="${id}" data-field-value="${i}"><option value="">선택 안 함</option>${[...new Set([...(def.options || []), ...(field.value ? [field.value] : [])])].map((option) => `<option value="${escape(option)}" ${option === field.value ? 'selected' : ''}>${escape(option)}</option>`).join('')}</select>`
          : `<input id="${id}" data-field-value="${i}" type="${def.type || 'text'}" value="${escape(field.value)}" ${def.type === 'number' ? 'step="any"' : ''}/>`;
      return `<div class="field-row"><label for="${id}">${escape(def.name)}</label>${input}<button type="button" data-remove-field="${i}" aria-label="${escape(def.name)} 항목 제거">${icon('close')}</button></div>`;
    })
    .join('');
}
function renderReading() {
  $('#editor-form').classList.toggle('reading', !editing);
  $('#reading-title').textContent = entry.title || '제목 없는 일기';
  $('#reading-date').textContent = entry.date;
  $('#reading-body').textContent = entry.body;
  $('#reading-details').innerHTML = [
    entry.tags.length
      ? `<p class="reading-tags">${entry.tags.map((tag) => escape('#' + tag)).join(' ')}</p>`
      : '',
    ...(entry.fields || []).map(
      (field) =>
        `<p><strong>${escape(fieldDefinition(field).name)}</strong> ${escape(field.value || '—')}</p>`,
    ),
    ...(entry.calendarTemplate === false ? [] : entry.events).map(
      (event) =>
        `<article class="reading-event"><h2>${escape(event.title)}</h2><small>${escape(event.allDay ? '종일' : event.start ? new Date(event.start).toLocaleTimeString('ko-KR', { hour: '2-digit', minute: '2-digit' }) : '')} ${escape(event.location || '')}</small><p>${escape(event.note || '')}</p></article>`,
    ),
  ].join('');
}
$('#edit-entry').onclick = () => {
  editing = true;
  renderReading();
  renderPhotos();
  $('#entry-title').focus();
};
function fillEditor() {
  renderReading();
  $('#entry-title').value = entry.title;
  $('#entry-body').value = entry.body;
  $('#entry-tags').value = entry.tags.join(', ');
  $('#entry-date').value = entry.date;
  $('#entry-weekday').textContent = new Date(`${entry.date}T12:00:00`).toLocaleDateString('ko-KR', {
    weekday: 'long',
  });
  $('#pin-entry').setAttribute('aria-pressed', String(Boolean(entry.pinned)));
  $('#pin-entry').setAttribute('aria-label', entry.pinned ? '상단 고정 해제' : '상단 고정');
  $('#archive-entry span:last-child').textContent = entry.archived ? '복원하기' : '삭제하기';
  $('#word-count').textContent = `${entry.body.length.toLocaleString()}자`;
  renderFields();
  renderEvents();
  renderPhotos();
  connection();
}
function renderEvents() {
  $('#events').innerHTML = (entry.calendarTemplate === false ? [] : entry.events)
    .map(
      (event, i) =>
        `<article><div class="event-top"><input data-event-title="${i}" value="${escape(event.title)}" aria-label="일정 제목"/><button type="button" data-remove-event="${i}" aria-label="${escape(event.title)} 일정 제거">${icon('close')}</button></div><small>${escape(event.allDay ? '종일' : event.start ? new Date(event.start).toLocaleTimeString('ko-KR', { hour: '2-digit', minute: '2-digit' }) : '')} ${escape(event.location || '')}</small><textarea data-event-note="${i}" aria-label="일정 메모" placeholder="이 일정에서 기억할 것">${escape(event.note)}</textarea></article>`,
    )
    .join('');
}
async function renderPhotos() {
  const generation = ++photoGeneration;
  urls.forEach(URL.revokeObjectURL);
  urls = [];
  $('#photos').innerHTML = '';
  for (const image of entry.images) {
    const figure = document.createElement('figure');
    figure.innerHTML = editing
      ? `<button type="button" class="remove-photo" data-remove-photo="${escape(image.id)}">첨부 삭제</button>`
      : '';
    $('#photos').append(figure);
    try {
      const blob = await previewBlob(image);
      if (generation !== photoGeneration) return;
      const url = URL.createObjectURL(blob);
      urls.push(url);
      figure.insertAdjacentHTML(
        'afterbegin',
        `<button type="button" class="photo-preview" data-open-photo="${escape(image.id)}" aria-label="원본 사진 보기"><img src="${url}" alt="첨부 사진 미리보기"/></button>`,
      );
    } catch {
      if (generation === photoGeneration)
        figure.insertAdjacentText('beforeend', ' · Google 연결 후 원본 확인');
    }
  }
}
async function closeEditor() {
  if (dirty && !window.confirm('저장하지 않은 변경 내용이 있습니다. 저장하지 않고 닫을까요?'))
    return;
  if (entry) await store.remove('drafts', entry.id);
  dirty = false;
  savedContent = null;
  $('#editor-dialog').close();
  entry = null;
  photoGeneration++;
  urls.forEach(URL.revokeObjectURL);
  urls = [];
  await cleanLocalPhotos(syncImages);
}
function small(title, html) {
  $('#small-title').textContent = title;
  $('#small-body').innerHTML = html;
  if (!$('#small-dialog').open) $('#small-dialog').showModal();
}
function openSettings() {
  $('#setting-client').value = settings.googleClientId || '';
  renderDefinitions();
  connection();
  $('#settings-dialog').showModal();
}
function renderDefinitions() {
  $('#definitions').innerHTML = definitions.length
    ? definitions
        .map(
          (def) =>
            `<div class="definition ${def.hidden ? 'inactive' : ''}"><div><strong>${escape(def.name)}</strong><small>${{ text: '텍스트', number: '숫자', date: '날짜', select: '선택 목록' }[def.type]}${def.hidden ? ' · 숨김' : ''}</small></div><button data-edit-definition="${escape(def.id)}">수정</button><button data-hide-definition="${escape(def.id)}">${def.hidden ? '다시 사용' : '숨기기'}</button></div>`,
        )
        .join('')
    : '<p class="muted">아직 정한 항목이 없습니다. 자주 기록할 정보를 추가해보세요.</p>';
}
async function saveDefinition(def) {
  validateDefinition(def);
  if (account) {
    if (!repository || !google.connected())
      throw new Error('항목 설정을 다른 기기와 함께 쓰려면 Google에 다시 연결해주세요.');
    await repository.saveField(def);
  }
  definitions = [...definitions.filter((d) => d.id !== def.id), def];
  settings.definitions ||= {};
  settings.definitions[account?.permissionId || 'local'] = definitions;
  persistSettings();
  renderDefinitions();
  if (entry) renderFields();
}
function definitionDialog(
  def = { id: crypto.randomUUID(), name: '', type: 'text', options: [] },
  attach = false,
) {
  small(
    '추가 항목 설정',
    `<form id="definition-form"><label class="form-label">항목 이름<input id="definition-name" value="${escape(def.name)}" placeholder="예: 장소, 읽은 책, 운동 시간" maxlength="50" required/></label><label class="form-label">입력 방식<select id="definition-type">${[
      ['text', '텍스트'],
      ['number', '숫자'],
      ['date', '날짜'],
      ['select', '선택 목록'],
    ]
      .map(
        ([value, label]) =>
          `<option value="${value}" ${value === def.type ? 'selected' : ''}>${label}</option>`,
      )
      .join(
        '',
      )}</select></label><label id="definition-options-label" class="form-label" ${def.type !== 'select' ? 'hidden' : ''}>선택지 · 쉼표로 구분<input id="definition-options" value="${escape((def.options || []).join(', '))}" placeholder="서울, 부산, 제주"/></label><p>항목 이름은 기존 기록에도 반영됩니다. 입력 방식을 바꾸어도 저장된 값은 보존합니다.</p><button class="primary" type="submit">항목 저장</button></form>`,
  );
  $('#definition-type').onchange = () =>
    ($('#definition-options-label').hidden = $('#definition-type').value !== 'select');
  $('#definition-form').onsubmit = (event) => {
    event.preventDefault();
    task(async () => {
      const next = {
        ...def,
        name: $('#definition-name').value.trim(),
        type: $('#definition-type').value,
        options: [
          ...new Set(
            $('#definition-options')
              .value.split(',')
              .map((v) => v.trim())
              .filter(Boolean),
          ),
        ],
      };
      await saveDefinition(next);
      if (attach && entry && !entry.fields?.some((field) => field.id === next.id)) {
        entry.fields ||= [];
        entry.fields.push({ id: next.id, name: next.name, value: '' });
        changed();
        renderFields();
      }
      $('#small-dialog').close();
      if (attach) $('#fields input:last-of-type, #fields select:last-of-type')?.focus();
    });
  };
}
async function selectRepository(id, closeSettings = true) {
  const candidate = new SheetsRepository(id);
  await candidate.prepare();
  await candidate.compact();
  await save(false);
  const previousOwner = owner();
  const unattached = previousOwner.endsWith('-unassigned')
    ? { revisions: await store.all('revisions'), assets: await store.all('assets') }
    : null;
  repository = candidate;
  if (settings.sheetFolders?.[id]) google.useFolder(settings.sheetFolders[id]);
  settings.sheets ||= {};
  settings.sheets[account.permissionId] = id;
  persistSettings();
  if (previousOwner !== owner()) {
    $('#editor-dialog').close();
    entry = null;
    await store.openStore(owner());
    if (unattached) {
      for (const asset of unattached.assets) await store.put('assets', asset);
      for (const revision of unattached.revisions)
        if (!(await store.get('revisions', revision.id))) await store.put('revisions', revision);
    }
    await recover();
    await load();
  }
  await save();
  await purgeTrash(false);
  $('#cloud-error').hidden = true;
  $('#sheet-options').hidden = true;
  if (closeSettings) $('#settings-dialog').close();
  toast('같은 Google 계정의 기기에서 이 시트를 함께 사용합니다.');
}
function connect(calendar = false, choose = false) {
  if (!ready || busy) return;
  settings.googleClientId = $('#settings-dialog').open
    ? $('#setting-client').value.trim()
    : settings.googleClientId;
  persistSettings();
  google.configureGoogle(settings.googleClientId, Boolean(settings.authServer));
  if (!settings.googleClientId) {
    openSettings();
    return;
  }
  // Keep OAuth call synchronous with the click for mobile popup permission.
  const authorization =
    google.connected() && (!calendar || google.hasCalendar())
      ? Promise.resolve()
      : google.authorize(calendar);
  task(async () => {
    await authorization;
    await save(false);
    const identity = await google.identity();
    if (account?.permissionId !== identity.permissionId) {
      $('#editor-dialog').close();
      entry = null;
      repository = null;
      account = identity;
      definitions = settings.definitions?.[identity.permissionId] || [];
      settings.account = identity;
      persistSettings();
      await store.openStore(owner());
      await recover();
      await load();
    } else {
      account = identity;
      settings.account = identity;
      persistSettings();
    }
    const files = await findSheets();
    for (const file of files) {
      if (file.parents?.[0]) {
        settings.sheetFolders ||= {};
        settings.sheetFolders[file.id] = file.parents[0];
      }
    }
    const preferred = files.find((file) => file.id === settings.sheets?.[account.permissionId]);
    const showFiles = () => {
      openSettings();
      $('#sheet-options').hidden = false;
      $('#sheet-select').innerHTML = files
        .map(
          (file) =>
            `<option value="${escape(file.id)}">${escape(file.name)} · ${escape(file.id.slice(-8))}</option>`,
        )
        .join('');
      $('#select-sheet').hidden = !files.length;
      $('#repair-sheet').hidden = !files.length;
      $('#create-sheet').hidden = Boolean(files.length);
    };
    if (!choose && (preferred || files.length === 1)) {
      try {
        await selectRepository((preferred || files[0]).id);
      } catch (error) {
        showFiles();
        throw error;
      }
    } else {
      showFiles();
      toast(
        files.length
          ? '사용할 My Diary 시트를 선택해주세요.'
          : 'My Diary 폴더에 새 시트를 만들 준비가 됐습니다.',
      );
    }
  });
}
async function recover() {
  for (const draft of await store.all('drafts')) {
    const revision = makeRevision(draft.entry, draft.parents);
    await store.replaceCurrent(revision);
  }
}
function setView(next) {
  view = next;
  settings.view = next;
  persistSettings();
  day = '';
  visibleLimit = 40;
  render();
}
function resetFilters() {
  $('#search').value = '';
  $('#tag-filter').value = '';
  $('#from').value = '';
  $('#to').value = '';
  searchGeneration++;
  $('#search-state').textContent = '';
  render();
}
async function searchBodies() {
  const generation = ++searchGeneration;
  if (!$('#search').value.trim()) {
    $('#search-state').textContent = '';
    return;
  }
  const missing = groups.flatMap((g) => g.heads).filter((r) => r.summary);
  if (!missing.length) return;
  if (!repository || !google.connected()) {
    $('#search-state').textContent =
      '기기에 불러온 내용에서 검색합니다. 전체 본문은 Google 연결 후 검색할 수 있어요.';
    return;
  }
  $('#search-state').textContent = '아직 불러오지 않은 본문도 검색하고 있어요…';
  // Sequential requests avoid a burst across the per-user Sheets quota.
  for (const revision of missing) {
    if (generation !== searchGeneration) return;
    await hydrate(revision);
  }
  if (generation === searchGeneration) {
    await load();
    $('#search-state').textContent = '전체 본문 검색 완료';
  }
}
function download(blob, name) {
  const url = URL.createObjectURL(blob),
    link = document.createElement('a');
  link.href = url;
  link.download = name;
  link.click();
  setTimeout(() => URL.revokeObjectURL(url), 60000);
}

$('#entry-title').oninput = (e) => {
  entry.title = e.target.value;
  changed();
};
$('#entry-body').oninput = (e) => {
  entry.body = e.target.value;
  $('#word-count').textContent = `${entry.body.length.toLocaleString()}자`;
  changed();
};
$('#entry-tags').oninput = (e) => {
  entry.tags = [
    ...new Set(
      e.target.value
        .split(',')
        .map((t) => t.trim().replace(/^#/, ''))
        .filter(Boolean),
    ),
  ];
  changed();
};
$('#entry-date').onchange = (e) => {
  if (validDate(e.target.value)) {
    entry.date = e.target.value;
    changed();
    $('#entry-weekday').textContent = new Date(`${entry.date}T12:00:00`).toLocaleDateString(
      'ko-KR',
      { weekday: 'long' },
    );
  }
};
$('#new-entry').onclick = $('#bottom-new').onclick = () => task(() => openEntry(null, localDate()));
$('#quick-entry').onclick = () => task(() => openEntry());
$('#records').onclick = (e) => {
  const remove = e.target.closest('[data-delete-entry]');
  if (remove) {
    task(() => deleteEntry(remove.dataset.deleteEntry));
    return;
  }
  const button = e.target.closest('[data-entry]');
  if (button) task(() => openEntry(button.dataset.entry));
  if (e.target.closest('#empty-new')) task(() => openEntry());
  if (e.target.closest('#load-more')) {
    visibleLimit += 40;
    render();
  }
};
function requestClose() {
  if (busy) closeRequested = true;
  else task(closeEditor);
}
$('#editor-form').onsubmit = (e) => {
  e.preventDefault();
  saveAndClose();
};
$('#save').onclick = (e) => {
  e.preventDefault();
  saveAndClose();
};
$('#close-editor').onclick = requestClose;
$('#editor-dialog').addEventListener('cancel', (e) => {
  e.preventDefault();
  task(closeEditor);
});
$('#pin-entry').onclick = () => {
  entry.pinned = !entry.pinned;
  changed();
  fillEditor();
};
$('#archive-entry').onclick = () => {
  entry.deletedAt = entry.deletedAt ? '' : new Date().toISOString();
  entry.archived = Boolean(entry.deletedAt);
  changed();
  fillEditor();
};
$('#search').oninput = () => {
  visibleLimit = 40;
  render();
  clearTimeout(searchTimer);
  searchTimer = setTimeout(() => {
    if (!document.querySelector('dialog[open]')) task(searchBodies);
  }, 500);
};
for (const id of ['tag-filter', 'sort', 'from', 'to'])
  $('#' + id).onchange = () => {
    visibleLimit = 40;
    render();
  };
$('#period-button').onclick = () => ($('#period').hidden = !$('#period').hidden);
$('#period-clear').onclick = () => {
  $('#from').value = '';
  $('#to').value = '';
  render();
};
$('#reset-filters').onclick = resetFilters;
$('#sidebar-labels').onclick = (e) => {
  const b = e.target.closest('[data-label]');
  if (b) {
    $('#tag-filter').value = b.dataset.label;
    render();
  }
};
$('#clear-label').onclick = () => {
  $('#tag-filter').value = '';
  render();
};
document
  .querySelectorAll('[data-view]')
  .forEach((b) => (b.onclick = () => setView(b.dataset.view)));
document.querySelectorAll('[data-collection]').forEach(
  (b) =>
    (b.onclick = () => {
      collection = b.dataset.collection;
      day = '';
      render();
    }),
);
$('#nav-calendar').onclick = $('#bottom-calendar').onclick = () => {
  collection = 'journal';
  setView('calendar');
};
$('#bottom-journal').onclick = () => {
  collection = 'journal';
  setView('list');
};
$('#bottom-pinned').onclick = () => {
  collection = 'pinned';
  render();
};
$('#calendar').onchange = (e) => {
  if (e.target.id === 'calendar-month' && /^\d{4}-(0[1-9]|1[0-2])$/.test(e.target.value)) {
    month = e.target.value;
    day = '';
    render();
  }
};
$('#calendar').onclick = (e) => {
  const date = e.target.closest('[data-day]'),
    step = e.target.closest('[data-month-step]');
  if (date) day = date.dataset.day;
  else if (step) {
    const d = new Date(`${month}-01T12:00:00`);
    d.setMonth(d.getMonth() + Number(step.dataset.monthStep));
    month = localDate(d).slice(0, 7);
    day = '';
  } else if (e.target.closest('#calendar-today')) {
    month = localDate().slice(0, 7);
    day = localDate();
  } else if (e.target.closest('#clear-day')) day = '';
  render();
};
$('#fields').oninput = (e) => {
  if (e.target.dataset.fieldValue !== undefined) {
    entry.fields[Number(e.target.dataset.fieldValue)].value = e.target.value;
    changed();
  }
};
$('#fields').onchange = (e) => {
  if (e.target.matches('select')) $('#fields').oninput(e);
};
$('#fields').onclick = (e) => {
  const b = e.target.closest('[data-remove-field]');
  if (b) {
    entry.fields.splice(Number(b.dataset.removeField), 1);
    changed();
    renderFields();
  }
};
$('#add-field').onclick = () => {
  const available = definitions.filter(
    (def) => !def.hidden && !entry.fields?.some((f) => f.id === def.id),
  );
  small(
    '이 하루에 항목 추가',
    available
      .map(
        (def) =>
          `<button class="pick-field" data-add-field="${escape(def.id)}">${escape(def.name)}${icon('plus')}</button>`,
      )
      .join('') +
      '<p>목록에 없는 항목은 설정 → 추가 항목 관리에서 만들 수 있습니다.</p><button id="create-field-here" class="primary">새 항목 만들기</button>',
  );
  $('#small-body').onclick = (e) => {
    const b = e.target.closest('[data-add-field]');
    if (b) {
      const def = definitions.find((d) => d.id === b.dataset.addField);
      entry.fields ||= [];
      entry.fields.push({ id: def.id, name: def.name, value: '' });
      changed();
      renderFields();
      $('#small-dialog').close();
    }
  };
  $('#create-field-here').onclick = () => definitionDialog(undefined, true);
};
$('#events').oninput = (e) => {
  if (e.target.dataset.eventTitle !== undefined) {
    const item = entry.events[Number(e.target.dataset.eventTitle)];
    item.title = e.target.value;
    item.overrides = { ...item.overrides, title: item.title };
  }
  if (e.target.dataset.eventNote !== undefined)
    entry.events[Number(e.target.dataset.eventNote)].note = e.target.value;
  changed();
};
$('#events').onclick = (e) => {
  const b = e.target.closest('[data-remove-event]');
  if (b) {
    const [removed] = entry.events.splice(Number(b.dataset.removeEvent), 1);
    entry.removedEventKeys = [...new Set([...(entry.removedEventKeys || []), removed.key])];
    changed();
    renderEvents();
  }
};
$('#add-event').onclick = () => {
  entry.calendarTemplate = true;
  entry.events.push({
    key: `manual:${crypto.randomUUID()}`,
    title: '새 일정',
    note: '',
    start: entry.date,
    end: entry.date,
    allDay: true,
    manual: true,
  });
  changed();
  renderEvents();
};
$('#get-events').onclick = () => {
  if (!google.hasCalendar()) {
    const date = entry.date;
    const auth = google.authorize(true);
    task(async () => {
      await auth;
      const identity = await google.identity();
      if (identity.permissionId !== account?.permissionId) {
        google.disconnect();
        throw new Error('일기와 같은 Google 계정으로 캘린더를 연결해주세요.');
      }
      await getCalendar(date);
    });
  } else task(() => getCalendar(entry.date));
};
async function getCalendar(date) {
  const calendars = await google.calendars();
  small(
    '가져올 Google 캘린더',
    `<p>${escape(date)}의 일정을 가져옵니다. Google 일정 원본은 수정하지 않습니다.</p>${calendars.map((c) => `<label class="form-label"><input type="checkbox" name="calendar-choice" value="${escape(c.id)}" ${c.primary ? 'checked' : ''}/> ${escape(c.summary)}</label>`).join('')}<button id="import-events" class="primary">선택한 일정 가져오기</button>`,
  );
  $('#import-events').onclick = () =>
    task(async () => {
      const from = new Date(`${date}T00:00:00`),
        to = new Date(from);
      to.setDate(to.getDate() + 1);
      const incoming = [];
      for (const input of document.querySelectorAll('[name=calendar-choice]:checked'))
        incoming.push(...(await google.events(input.value, from, to)));
      entry.events = mergeEvents(entry.events, incoming, entry.removedEventKeys || []);
      entry.calendarTemplate = true;
      dirty = true;
      renderEvents();
      $('#small-dialog').close();
      await save();
    });
}
$('#photos').onclick = (e) => {
  const open = e.target.closest('[data-open-photo]');
  if (open) {
    const image = entry.images.find((item) => item.id === open.dataset.openPhoto);
    small('원본 사진', '<p>원본을 불러오는 중…</p>');
    task(async () => {
      const url = URL.createObjectURL(await assetBlob(image));
      urls.push(url);
      if ($('#small-dialog').open)
        $('#small-body').innerHTML =
          `<img class="original-photo" src="${url}" alt="첨부 사진 원본"/><p><a href="${url}" download="${escape(image.name)}">원본 다운로드</a></p>`;
    });
    return;
  }
  const b = e.target.closest('[data-remove-photo]');
  if (b) {
    const removed = entry.images.find((image) => image.id === b.dataset.removePhoto);
    entry.removedImages = [...(entry.removedImages || []), removed];
    entry.images = entry.images.filter((image) => image.id !== b.dataset.removePhoto);
    changed();
    renderPhotos();
  }
};
$('#add-photo').onclick = () => $('#photo-input').click();
$('#photo-input').onchange = () =>
  task(async () => {
    for (const file of $('#photo-input').files) {
      const image = await createPhoto(file);
      entry.images.push(image);
      changed();
    }
    dirty = true;
    $('#photo-input').value = '';
    await renderPhotos();
    await save();
  });
$('#open-settings').onclick =
  $('#mobile-settings').onclick =
  $('#bottom-settings').onclick =
    openSettings;
$('#close-settings').onclick = () => $('#settings-dialog').close();
$('#close-small').onclick = () => {
  $('#small-dialog').close();
  $('#small-body').onclick = null;
};
$('#new-definition').onclick = () => definitionDialog();
$('#definitions').onclick = (e) => {
  const edit = e.target.closest('[data-edit-definition]'),
    hide = e.target.closest('[data-hide-definition]');
  if (edit) definitionDialog(definitions.find((d) => d.id === edit.dataset.editDefinition));
  if (hide)
    task(() => {
      const def = definitions.find((d) => d.id === hide.dataset.hideDefinition);
      return saveDefinition({ ...def, hidden: !def.hidden });
    });
};
$('#connect').onclick =
  $('#banner-connect').onclick =
  $('#settings-connect').onclick =
    () => connect();
$('#sync').onclick = () => {
  if (!google.connected()) connect();
  else
    task(async () => {
      await save();
      await refresh();
      toast('최신 기록을 불러왔습니다.');
    });
};
$('#find-sheets').onclick = () => connect(false, true);
$('#create-sheet').onclick = () => {
  if (!google.connected()) return connect();
  task(async () => {
    const created = await createSheet();
    await selectRepository(created.id);
  });
};
$('#select-sheet').onclick = () => task(() => selectRepository($('#sheet-select').value));
$('#repair-sheet').onclick = () =>
  task(async () => {
    const id = $('#sheet-select').value;
    await initializeSheet(id);
    await selectRepository(id);
  });
$('#disconnect').onclick = () =>
  task(async () => {
    await save(false);
    google.disconnect();
    account = null;
    repository = null;
    settings.account = null;
    persistSettings();
    entry = null;
    $('#editor-dialog').close();
    await store.openStore(owner());
    definitions = settings.definitions?.local || [];
    await recover();
    await load();
    renderDefinitions();
    $('#sheet-options').hidden = true;
    $('#sheet-select').innerHTML = '';
  });
$('#import').onclick = () => $('#import-input').click();
$('#import-input').onchange = () =>
  task(async () => {
    const file = $('#import-input').files[0];
    if (!file) return;
    if (file.size > 100 * 1024 * 1024) throw new Error('100MB 이하 ZIP을 선택해주세요.');
    toast('ZIP을 확인하고 있습니다…');
    const parsed = parseArchive(new Uint8Array(await file.arrayBuffer()));
    await stableKeepIds(parsed.revisions);
    const existing = new Set((await store.all('revisions')).map((r) => r.id));
    const fresh = parsed.revisions.filter((r) => !existing.has(r.id));
    const ids = new Set(fresh.flatMap((r) => r.entry.images).map((i) => i.id));
    for (const asset of parsed.assets) if (ids.has(asset.id)) await store.put('assets', asset);
    for (const r of fresh) await store.put('revisions', r);
    await load();
    $('#import-input').value = '';
    toast(`${fresh.length}개 기록을 가져왔습니다. 클라우드 저장을 진행합니다.`);
    return true;
  }).then((imported) => {
    if (imported)
      resumeConnection().catch((error) =>
        toast(`남은 기록은 기기에 저장되어 있습니다. ${error.message}`, true),
      );
  });
window.addEventListener('sheets-quota-wait', (event) => {
  syncProgress = `Google 요청 한도로 ${Math.ceil(event.detail.delay / 1000)}초 후 자동 재시도합니다.`;
  connection();
  toast(
    `Google 요청 한도로 ${Math.ceil(event.detail.delay / 1000)}초 후 자동으로 계속합니다. 남은 기록은 기기에 보관됩니다.`,
  );
});
$('#export').onclick = () =>
  task(async () => {
    await save();
    if (repository && google.connected()) await refresh();
    const revisions = [];
    for (const r of await store.all('revisions')) revisions.push(await hydrate(r));
    download(await makeBackup(revisions, assetBlob), `my-diary-${localDate()}.zip`);
    toast('일기와 사진 원본을 ZIP으로 내보냈습니다.');
  });
$('#move-local').onclick = () =>
  task(async () => {
    if (!repository || !google.connected())
      throw new Error('먼저 Google에 연결하고 저장할 시트를 선택해주세요.');
    await save(false);
    const currentOwner = owner();
    let revisions, assets;
    try {
      await store.openStore('sheets-local');
      await recover();
      revisions = await store.all('revisions');
      assets = await store.all('assets');
    } finally {
      await store.openStore(currentOwner);
    }
    for (const def of settings.definitions?.local || []) {
      if (!definitions.some((existing) => existing.id === def.id)) await saveDefinition(def);
    }
    for (const asset of assets) await store.put('assets', asset);
    for (const r of revisions)
      if (!(await store.get('revisions', r.id))) await store.put('revisions', r);
    await load();
    await save();
    toast('연결 전 기록을 이 계정에 가져왔습니다.');
  });
$('#resume-sync').onclick = () => resumeConnection().catch((error) => toast(error.message, true));
$('#apply-update').onclick = () => {
  if (!busy && !syncing && !dirty) location.reload();
};
async function resumeConnection() {
  if (account && settings.authServer && !google.connected()) {
    syncing = true;
    connection();
    try {
      await google.restoreSession();
    } finally {
      if (!syncWork) syncing = false;
      connection();
    }
  }
  await save();
}
function backgroundSync() {
  if (
    document.querySelector('dialog[open]') ||
    document.activeElement?.matches('input,textarea,select,[contenteditable]')
  )
    return;
  if (busy || syncing) return;
  resumeConnection().catch((error) => toast(error.message, true));
}
window.addEventListener('online', backgroundSync);
document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'visible' && Date.now() - lastRefresh > 15000) backgroundSync();
});
setInterval(() => {
  connection();
  if (
    document.visibilityState === 'visible' &&
    (google.connected() || (account && settings.authServer)) &&
    Date.now() - lastRefresh > 20000
  )
    backgroundSync();
}, 25000);
window.addEventListener('beforeunload', (e) => {
  if (dirty || busy || syncing) {
    e.preventDefault();
    e.returnValue = '';
  }
});
document.addEventListener('keydown', (e) => {
  if (!(e.ctrlKey || e.metaKey)) return;
  if (e.key.toLowerCase() === 's' && entry) {
    e.preventDefault();
    saveAndClose();
  }
  if (e.key.toLowerCase() === 'k' && !$('#editor-dialog').open) {
    e.preventDefault();
    $('#search').focus();
  }
});
async function start() {
  const config = await fetch('/config.json')
    .then((r) => r.json())
    .catch(() => ({}));
  settings = { ...config, ...settings, authServer: Boolean(config.authServer) };
  google.configureGoogle(settings.googleClientId, Boolean(settings.authServer));
  await store.openStore(owner());
  await recover();
  definitions = settings.definitions?.[account?.permissionId || 'local'] || [];
  await load();
  if (account && settings.sheets?.[account.permissionId])
    repository = new SheetsRepository(settings.sheets[account.permissionId]);
  $('#today').textContent = new Date().toLocaleDateString('ko-KR', {
    year: 'numeric',
    month: 'long',
    day: 'numeric',
    weekday: 'long',
  });
  ready = true;
  locks(false);
  connection();
  if ('serviceWorker' in navigator) {
    const wasControlled = Boolean(navigator.serviceWorker.controller);
    navigator.serviceWorker.addEventListener('controllerchange', () => {
      if (!wasControlled) return;
      updateReady = true;
      connection();
      toast('새 버전이 준비되었습니다. 설정에서 새 버전을 적용해주세요.');
    });
    navigator.serviceWorker.register('/sw.js', { updateViaCache: 'none' }).catch(() => {});
  }
  if (account)
    task(async () => {
      if (await google.restoreSession()) {
        const identity = await google.identity();
        if (identity.permissionId !== account.permissionId)
          throw new Error('Google 계정이 달라 다시 연결해야 합니다.');
        const files = await findSheets();
        const file =
          files.find((f) => f.id === settings.sheets?.[account.permissionId]) ||
          (files.length === 1 ? files[0] : null);
        if (file) {
          if (file.parents?.[0]) {
            settings.sheetFolders ||= {};
            settings.sheetFolders[file.id] = file.parents[0];
          }
          await selectRepository(file.id, false);
        }
      }
    });
}
start().catch((error) => toast(`일기장을 열지 못했습니다: ${error.message}`, true));

async function deleteEntry(id) {
  const group = groups.find((g) => g.latest.entry.id === id);
  if (!group) return;
  const r = await hydrate(group.latest);
  const e = structuredClone(r.entry);
  e.deletedAt = e.deletedAt ? '' : new Date().toISOString();
  e.archived = Boolean(e.deletedAt);
  await store.replaceCurrent({
    ...makeRevision(e, [r.id]),
    remoteKnown: Boolean(r.sheetSaved || r.remoteKnown),
  });
  await load();
  await save();
  toast(e.deletedAt ? '휴지통으로 이동했습니다.' : '일기를 복원했습니다.');
}
async function purgeTrash(ask = true) {
  const days = repository?.retentionDays ?? settings.trashDays ?? 30;
  if (
    ask &&
    !window.confirm(`${days}일 이상 지난 휴지통 기록을 완전 삭제할까요? 복원할 수 없습니다.`)
  )
    return;
  let ids;
  if (repository) {
    if (!google.connected()) throw new Error('완전 삭제하려면 Google에 연결해주세요.');
    ids = await repository.purge(days);
  } else ids = groups.filter((g) => expired(g.latest.entry, days)).map((g) => g.latest.entry.id);
  for (const r of await store.all('revisions'))
    if (ids.includes(r.entry.id)) await store.remove('revisions', r.id);
  for (const d of await store.all('drafts'))
    if (ids.includes(d.entry.id)) await store.remove('drafts', d.id);
  await cleanLocalPhotos(syncImages);
  await load();
  if (repository) await refresh();
  if (ask) toast(`${ids.length}개 일기를 완전 삭제했습니다.`);
}
$('#save-retention').onclick = () =>
  task(async () => {
    const days = Number($('#trash-days').value);
    if (account && (!repository || !google.connected()))
      throw new Error('Google에 연결한 후 기간을 설정해주세요.');
    if (repository) await repository.saveRetention(days);
    settings.trashDays = days;
    persistSettings();
    toast('휴지통 보관 기간을 저장했습니다. 다음 연결부터 기간이 지난 기록을 완전 삭제합니다.');
  });
$('#purge-trash').onclick = () => task(() => purgeTrash(true));
