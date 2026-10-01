// Journal controller: owns screen state and wires DOM events to the modules below.
import { renderBody } from '../body-links.js';
import { revisionCache } from './revision-cache.js';
import { openPhoto } from './photo-viewer.js';
import { appUpdates } from './updates.js';
import { hydrateIcons } from './icons.js';
import {
  escape,
  visibleGroups,
  cards,
  calendarHTML,
  tagOptionsHTML,
  tagLinksHTML,
  tagSuggestionsHTML,
  readingDetailsHTML,
  eventsHTML,
  conflictHTML,
  calendarChoiceHTML,
  repositoryOptionsHTML,
  quickEntryVisible,
  readingPosition,
} from './views.js';
import {
  connectionLabel,
  repositoryDetails,
  saveStateLabel,
  pageTitle,
  pageDescription,
  quickLabel,
  dateLabel,
  todayLabel,
  characterCount,
} from './labels.js';
import { findRepositories, createRepository, openRepository } from './appdata.js';
import { newEntry, localDate, validDate, makeRevision, mergeEvents } from '../model.js';
import { expired, nextRevision } from './current.js';
import { $, toast, small, confirmDialog, download } from './dom.js';
import { loadSettings, saveSettings, ownerKey } from './settings.js';
import {
  loadGroups,
  pendingRevisions,
  conflictedRevisions,
  recoverDrafts,
  adoptRecords,
  snapshotStore,
  collectStore,
  removeEntries,
} from './local.js';
import { hydrateRevision, pullRemote } from './remote.js';
import { batches, pushBatch } from './cloud-sync.js';
import { importArchive, exportArchive } from './transfer.js';
import { eventsForDate, manualEvent } from './calendar.js';
import * as store from '../storage.js';
import * as google from '../google.js';
import { createPhoto, previewBlob, uploadPhoto, cleanLocalPhotos, assetBlob } from './photos.js';

hydrateIcons();
let settings = loadSettings();
let account = settings.account || null,
  repository = null,
  groups = [],
  entry = null,
  parents = [],
  activeRevision = '',
  conflictingRevision = null,
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
  updateApplying = false,
  closeRequested = false,
  savedContent = null,
  connecting = false,
  ready = false;
let draftWrite = Promise.resolve(),
  saveTimer,
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
const owner = () => ownerKey(account, settings);
// Display preferences belong to this device and apply before the first render.
function applyDisplay() {
  document.documentElement.dataset.textSize = ['small', 'large'].includes(settings.textSize)
    ? settings.textSize
    : 'normal';
}
applyDisplay();
const persistSettings = () => saveSettings(settings);
const working = () => busy || syncing || connecting;
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
    'select-repository',
    'create-repository',
    'import',
    'export',
    'move-local',
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
  $('#sync').classList.toggle('is-syncing', working());
  $('#sync').setAttribute('aria-busy', String(working()));
  const online = google.connected() && navigator.onLine;
  const pending = groups.filter((group) => !group.latest.sheetSaved).length;
  $('#connection').textContent = connectionLabel({
    working: working(),
    onLine: navigator.onLine,
    connected: google.connected(),
    repository,
    pending,
    account,
  });
  $('#sync-progress').textContent =
    syncProgress || (pending ? `${pending}개 기록이 이 기기에서 저장을 기다립니다.` : '');
  $('#resume-sync').hidden = !pending || !repository;
  $('#resume-sync').disabled = working() || !navigator.onLine;
  $('#update-banner').hidden = !updateReady;
  document.querySelectorAll('[data-apply-update]').forEach((button) => {
    button.hidden = !updateReady;
    button.disabled = working() || updateApplying;
  });
  $('#connect-banner').hidden = Boolean(online && repository && google.hasAppData());
  $('#account-name').textContent = account?.displayName || '나만의 일기장';
  $('#account-caption').textContent = account?.emailAddress || 'Google에 연결하세요';
  $('#avatar').textContent = (account?.displayName || 'M').slice(0, 1);
  $('#settings-account').textContent = account
    ? `${account.emailAddress} · ${online ? 'Google 연결됨' : '재연결 필요'}`
    : '연결 전 기록은 이 기기에만 저장됩니다.';
  $('#save').disabled = busy || !dirty;
  document.querySelectorAll('.record').forEach((button) => (button.disabled = busy));
  $('#disconnect').hidden = !account;
  for (const id of [
    'disconnect',
    'select-repository',
    'create-repository',
    'import',
    'export',
    'move-local',
    'purge-trash',
  ])
    $('#' + id).disabled = working();
  for (const id of ['connect', 'banner-connect', 'settings-connect']) {
    $('#' + id).disabled = working() || (online && google.hasAppData());
  }
  $('#create-repository').hidden = Boolean(repository) || !$('#repository-options').hidden;
  $('#repository-help').textContent = repository
    ? '일기와 사진은 Drive의 앱 전용 공간에 저장됩니다. 같은 계정의 다른 기기에서도 최신 앱으로 연결해주세요.'
    : 'Google 연결 후 앱 전용 저장소를 만들거나 기존 저장소에 연결합니다.';
  if (!$('#settings-dialog').open)
    $('#trash-days').value = String(repository?.retentionDays ?? settings.trashDays ?? 30);
  $('#move-local').hidden = !account || !repository;
  $('#repository-details').textContent = repositoryDetails(repository, pending, online);
  if (entry && !editing) readingNav();
  if (entry)
    $('#save-state').textContent = saveStateLabel({
      dirty,
      conflicted: groups.find((g) => g.latest.entry.id === entry.id)?.heads.length > 1,
      cloudSaved: groups.find((g) => g.latest.id === activeRevision)?.latest.sheetSaved,
      activeRevision,
    });
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
function shownGroups(base = filter()) {
  return visibleGroups(groups, { ...base, ...(view === 'calendar' ? { month, day } : {}) });
}
function render() {
  const tags = [...new Set(groups.flatMap((g) => g.latest.entry.tags))].sort(),
    tag = $('#tag-filter').value;
  $('#tag-filter').innerHTML = tagOptionsHTML(tags);
  $('#tag-filter').value = tag;
  $('#sidebar-labels').innerHTML = tagLinksHTML(tags, tag);
  $('#tag-suggestions').innerHTML = tagSuggestionsHTML(tags);
  const base = filter(),
    shown = shownGroups(base);
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
  $('#page-title').innerHTML = pageTitle(collection, view) + '<span class="title-dot">.</span>';
  $('#page-description').textContent = pageDescription(collection);
  $('#quick-label').textContent = quickLabel(view, day);
  $('#quick-entry').hidden = !quickEntryVisible(groups, { collection, view, day });
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
  const loaded = await loadGroups({ cancelled: () => generation !== loadGeneration });
  if (!loaded) return;
  groups = loaded;
  if (generation === loadGeneration) render();
}
const cloud = () => (repository && google.connected() ? repository : null);
const hydrate = (revision) => hydrateRevision(cloud(), revision);
let lastCompact = 0;
// Housekeeping after connecting or syncing: at most hourly, never surfaced as an error.
async function compactCloud() {
  if (!cloud() || !navigator.onLine || Date.now() - lastCompact < 3600000) return;
  lastCompact = Date.now();
  try {
    await repository.compact();
  } catch {
    /* Compaction is retried on a later connection. */
  }
}
async function refresh(options = {}) {
  if (!cloud() || !navigator.onLine) return;
  await pullRemote(repository, options);
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
    const revision = nextRevision(entry, parents, previous);
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
      const pending = await pendingRevisions();
      syncImages = pending.flatMap((r) => r.entry.images);
      let remaining = pending.length;
      for (const batch of batches(pending)) {
        try {
          await pushBatch(repository, batch, () => {
            syncProgress = `이번 묶음 ${batch.length}개를 클라우드에 저장하고 있습니다. 전체 저장 대기 ${remaining}개`;
            connection();
          });
        } catch (error) {
          if (error.conflict) {
            await load();
            syncAgain = true;
          }
          throw error;
        }
        remaining -= batch.length;
        saved = true;
        await load();
      }
      await load();
    } while (syncAgain || (await pendingRevisions()).length);
    // Other devices are polled anyway; reuse the listing taken while pushing this batch.
    if (!entry && !busy) await refresh({ maxAge: 15000 });
    await compactCloud();
    syncImages = [];
    await cleanLocalPhotos(entry?.images || []);
    const conflicts = await conflictedRevisions();
    syncProgress = conflicts.length
      ? `${conflicts.length}개 일기에 수정 충돌이 있습니다. 해당 일기를 열어 확인해주세요.`
      : '';
    $('#cloud-error').hidden = !conflicts.length;
    if (saved && !syncAgain) toast('Google 클라우드에 저장했습니다.');
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
  conflictingRevision = revision?.conflict ? revision : null;
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
function renderReading() {
  $('#resolve-conflict').hidden = !conflictingRevision;
  $('#editor-form').classList.toggle('reading', !editing);
  $('#reading-title').textContent = entry.title || '제목 없는 일기';
  $('#reading-date').textContent = dateLabel(entry.date);
  renderBody($('#reading-body'), entry.body);
  $('#reading-details').innerHTML = readingDetailsHTML(entry);
}
$('#resolve-conflict').onclick = () => {
  const revision = conflictingRevision;
  small('양쪽에서 수정된 일기', conflictHTML(revision));
  $('#keep-conflict-copy').onclick = () =>
    task(async () => {
      if (dirty) throw new Error('편집 중인 내용을 먼저 저장하거나 닫은 후 충돌을 확인해주세요.');
      const copy = makeRevision({
        ...revision.entry,
        id: crypto.randomUUID(),
        title: `${revision.entry.title || '제목 없는 일기'} (기기 수정본)`,
      });
      await store.put('revisions', copy);
      if (revision.cloudConflict)
        for (const image of copy.entry.images)
          await uploadPhoto(image, `${repository.id}:${copy.entry.id}`);
      await store.replaceCurrent(
        revision.cloudConflict ? await repository.resolve(revision, copy) : revision.conflict,
      );
      conflictingRevision = null;
      $('#small-dialog').close();
      await closeEditor();
      await load();
      await save();
    });
};
function readingNav() {
  const { index, total, previous, next } = readingPosition(shownGroups(), entry.id);
  $('#entry-position').textContent = index < 0 ? '' : `${index + 1} / ${total}`;
  $('#prev-entry').disabled = busy || !previous;
  $('#next-entry').disabled = busy || !next;
}
// Step to the neighbouring diary in reading mode only; edits and other dialogs stay put.
function moveEntry(step, trigger = null) {
  if (!entry || editing || dirty || busy || $('#photo-dialog')?.open || $('#small-dialog').open)
    return;
  const position = readingPosition(shownGroups(), entry.id);
  const id = step < 0 ? position.previous : position.next;
  if (!id) return;
  task(async () => {
    await openEntry(id);
    $('#editor-dialog').scrollTop = 0;
    const after = readingPosition(shownGroups(), id);
    if (trigger && (step < 0 ? after.previous : after.next)) desiredFocus = trigger;
  });
}
$('#prev-entry').onclick = (e) => moveEntry(-1, e.currentTarget);
$('#next-entry').onclick = (e) => moveEntry(1, e.currentTarget);
let swipe = null;
$('#editor-form').addEventListener(
  'touchstart',
  (e) => {
    swipe =
      !editing && e.touches.length === 1
        ? { x: e.touches[0].clientX, y: e.touches[0].clientY }
        : null;
  },
  { passive: true },
);
$('#editor-form').addEventListener('touchend', (e) => {
  if (!swipe) return;
  const touch = e.changedTouches[0],
    dx = touch.clientX - swipe.x,
    dy = touch.clientY - swipe.y;
  swipe = null;
  // A mostly horizontal stroke turns the page; selecting text with a long press does not.
  if (Math.abs(dx) > 70 && Math.abs(dy) < Math.abs(dx) * 0.5 && !String(getSelection()))
    moveEntry(dx < 0 ? 1 : -1);
});
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
  $('#entry-date-label').textContent = dateLabel(entry.date);
  $('#pin-entry').setAttribute('aria-pressed', String(Boolean(entry.pinned)));
  $('#pin-entry').setAttribute('aria-label', entry.pinned ? '상단 고정 해제' : '상단 고정');
  $('#archive-entry span:last-child').textContent = entry.archived ? '복원하기' : '삭제하기';
  $('#word-count').textContent = characterCount(entry.body);
  renderEvents();
  renderPhotos();
  connection();
}
function renderEvents() {
  $('#events').innerHTML = eventsHTML(entry);
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
  if (
    dirty &&
    !(await confirmDialog(
      '저장하지 않은 변경',
      '저장하지 않은 변경 내용이 있습니다. 저장하지 않고 닫을까요?',
      { accept: '저장하지 않고 닫기', danger: true },
    ))
  )
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
function openSettings() {
  $('#setting-client').value = settings.googleClientId || '';
  $('#text-size').value = document.documentElement.dataset.textSize;
  connection();
  $('#settings-dialog').showModal();
}
async function selectRepository(id, closeSettings = true) {
  const candidate = await openRepository(id, {
    cacheStore: revisionCache(JSON.stringify([settings.googleClientId, account.permissionId, id])),
    progress: (message) => {
      syncProgress = message;
      connection();
    },
  });
  await candidate.list();
  await save(false);
  const previousOwner = owner();
  const unattached = previousOwner.endsWith('-unassigned') ? await snapshotStore() : null;
  repository = candidate;
  settings.sheets ||= {};
  settings.sheets[account.permissionId] = id;
  persistSettings();
  if (previousOwner !== owner()) {
    $('#editor-dialog').close();
    entry = null;
    await store.openStore(owner());
    if (unattached) await adoptRecords(unattached);
    await recoverDrafts();
    await load();
  }
  await save();
  await purgeTrash(false);
  // Pull the other devices' records now, reusing the listing fetched a moment ago.
  await refresh({ maxAge: 15000 });
  await compactCloud();
  $('#cloud-error').hidden = true;
  $('#repository-options').hidden = true;
  if (closeSettings) $('#settings-dialog').close();
  toast('같은 Google 계정의 기기에서 앱 전용 저장소를 함께 사용합니다.');
}
function connect(calendar = false) {
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
    google.connected() && google.hasAppData() && (!calendar || google.hasCalendar())
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
      settings.account = identity;
      persistSettings();
      await store.openStore(owner());
      await recoverDrafts();
      await load();
    } else {
      account = identity;
      settings.account = identity;
      persistSettings();
    }
    const files = await findRepositories();
    const preferred = files.find((file) => file.id === settings.sheets?.[account.permissionId]);
    const showFiles = () => {
      openSettings();
      $('#repository-options').hidden = !files.length;
      $('#repository-select').innerHTML = repositoryOptionsHTML(files);
      $('#create-repository').hidden = Boolean(files.length);
    };
    if (preferred || files.length === 1) {
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
          ? '연결할 일기 저장소를 선택해주세요.'
          : '새 앱 전용 저장소를 만들 준비가 됐습니다.',
      );
    }
  });
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
  const bounds = filter();
  if (!bounds.from && !bounds.to && !day) {
    $('#search-state').textContent =
      '전체 제목·미리보기와 기기에 보관된 본문에서 검색합니다. 과거 본문은 날짜를 좁혀 검색하거나 기록을 열어 확인하세요.';
    return;
  }
  $('#search-state').textContent = '선택한 날짜 범위의 본문을 검색하고 있어요…';
  // Sequential requests keep the Drive API usage steady.
  for (const revision of missing.filter(
    (r) =>
      (!bounds.from || r.entry.date >= bounds.from) &&
      (!bounds.to || r.entry.date <= bounds.to) &&
      (!day || r.entry.date === day),
  )) {
    if (generation !== searchGeneration) return;
    await hydrate(revision);
  }
  if (generation === searchGeneration) {
    await load();
    $('#search-state').textContent = '전체 본문 검색 완료';
  }
}
$('#entry-title').oninput = (e) => {
  entry.title = e.target.value;
  changed();
};
$('#entry-body').oninput = (e) => {
  entry.body = e.target.value;
  $('#word-count').textContent = characterCount(entry.body);
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
    $('#entry-date-label').textContent = dateLabel(entry.date);
  }
};
// The native date input sits invisibly over the formatted date; open its picker on click.
$('#entry-date').onclick = (e) => {
  try {
    e.target.showPicker?.();
  } catch {
    /* Browsers without showPicker open their own picker on tap. */
  }
};
$('#new-entry').onclick = $('#bottom-new').onclick = () => task(() => openEntry(null, localDate()));
$('#quick-entry').onclick = () => task(() => openEntry());
$('#records').onclick = (e) => {
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
  if (!editing) {
    // Reading mode acts at once: the entry is closed, moved, and offered an undo toast.
    const id = entry.id;
    task(async () => {
      await closeEditor();
      await deleteEntry(id);
      return true;
    }).then((moved) => moved && syncInBackground());
    return;
  }
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
  entry.events.push(manualEvent(entry.date));
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
  small('가져올 Google 캘린더', calendarChoiceHTML(date, calendars));
  $('#import-events').onclick = () =>
    task(async () => {
      const chosen = [...document.querySelectorAll('[name=calendar-choice]:checked')].map(
        (input) => input.value,
      );
      const incoming = await eventsForDate(date, chosen);
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
    openPhoto(image, () => assetBlob(image));
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
$('#text-size').onchange = (e) => {
  settings.textSize = e.target.value;
  persistSettings();
  applyDisplay();
};
$('#close-small').onclick = () => {
  $('#small-dialog').close();
  $('#small-body').onclick = null;
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
$('#create-repository').onclick = () => {
  if (!google.connected() || !google.hasAppData()) return connect();
  task(async () => {
    const created = await createRepository();
    await selectRepository(created.id);
  });
};
$('#select-repository').onclick = () => task(() => selectRepository($('#repository-select').value));
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
    await recoverDrafts();
    await load();
    $('#repository-options').hidden = true;
    $('#repository-select').innerHTML = '';
  });
$('#import').onclick = () => $('#import-input').click();
$('#import-input').onchange = () =>
  task(async () => {
    const file = $('#import-input').files[0];
    if (!file) return;
    toast('ZIP을 확인하고 있습니다…');
    const imported = await importArchive(file);
    await load();
    $('#import-input').value = '';
    toast(`${imported}개 기록을 가져왔습니다. 클라우드 저장을 진행합니다.`);
    return true;
  }).then((imported) => {
    if (imported)
      resumeConnection().catch((error) =>
        toast(`남은 기록은 기기에 저장되어 있습니다. ${error.message}`, true),
      );
  });
$('#export').onclick = () =>
  task(async () => {
    await save();
    if (cloud()) await refresh();
    const archive = await exportArchive({ repository: cloud(), hydrate });
    download(archive.blob, archive.name);
    toast('일기와 사진 원본을 ZIP으로 내보냈습니다.');
  });
$('#move-local').onclick = () =>
  task(async () => {
    if (!repository || !google.connected())
      throw new Error('먼저 Google에 연결하고 저장소를 선택해주세요.');
    await save(false);
    await adoptRecords(await collectStore(ownerKey(null, settings), owner()));
    await load();
    await save();
    toast('연결 전 기록을 이 계정에 가져왔습니다.');
  });
$('#resume-sync').onclick = () => resumeConnection().catch((error) => toast(error.message, true));
const updates = appUpdates({
  onChange(state) {
    updateReady = state.ready;
    updateApplying = state.applying;
    $('#app-version').textContent = state.version;
    $('#update-status').textContent = state.message;
    $('#check-update').disabled = state.checking || state.applying;
    $('#check-update').textContent = state.checking ? '업데이트 확인 중…' : '업데이트 확인';
    connection();
  },
  async preserve() {
    if (busy || syncing) throw new Error('진행 중인 저장이 끝난 뒤 업데이트를 적용해주세요.');
    busy = true;
    locks(true);
    connection();
    try {
      await save(false, true);
    } catch (error) {
      toast('작성 내용을 기기에 저장하지 못해 업데이트를 적용하지 않았습니다.', true);
      throw error;
    } finally {
      busy = false;
      locks(false);
      connection();
    }
  },
});
$('#check-update').onclick = () => updates.check(true);
document.querySelectorAll('[data-apply-update]').forEach((button) => {
  button.onclick = () => updates.apply();
});
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
  if (
    ['ArrowLeft', 'ArrowRight'].includes(e.key) &&
    !(e.ctrlKey || e.metaKey || e.altKey || e.shiftKey) &&
    $('#editor-dialog').open &&
    !e.target.matches('input,textarea,select,[contenteditable]')
  ) {
    if (!editing && !$('#photo-dialog')?.open) {
      e.preventDefault();
      moveEntry(e.key === 'ArrowLeft' ? -1 : 1);
    }
    return;
  }
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
  await recoverDrafts();
  await load();
  $('#today').textContent = todayLabel();
  ready = true;
  locks(false);
  connection();
  updates.start();
  if (account) reconnect();
}
// Reconnect without locking the editor: local records are already on screen, and the
// repository stays the same, so writing can start before the cloud round trips finish.
async function reconnect() {
  connecting = true;
  connection();
  try {
    if (await google.restoreSession()) {
      if (!google.hasAppData()) {
        repository = null;
        toast('앱 전용 저장소 권한이 필요합니다. Google에 다시 연결해주세요.');
        return;
      }
      const identity = await google.identity();
      if (identity.permissionId !== account.permissionId)
        throw new Error('Google 계정이 달라 다시 연결해야 합니다.');
      const preferred = settings.sheets?.[account.permissionId];
      if (preferred) {
        // The cached listing lets a known repository open without discovering it again.
        try {
          await selectRepository(preferred, false);
          return;
        } catch (error) {
          if (!error.missingRepository) throw error;
        }
      }
      const files = await findRepositories();
      const file = files.find((f) => f.id === preferred) || (files.length === 1 ? files[0] : null);
      if (file) await selectRepository(file.id, false);
    }
  } catch (error) {
    $('#cloud-error').textContent = error.message || '연결을 완료하지 못했습니다.';
    $('#cloud-error').hidden = false;
    toast(error.message || '연결을 완료하지 못했습니다.', true);
  } finally {
    connecting = false;
    connection();
  }
}
start().catch((error) => toast(`일기장을 열지 못했습니다: ${error.message}`, true));

const syncInBackground = () =>
  resumeConnection().catch((error) => toast(`기기에 저장되어 있습니다. ${error.message}`, true));
// Moves a diary to the trash (or back) on the device; the cloud push runs afterwards so the
// undo toast stays usable while it is in flight.
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
  connection();
  if (e.deletedAt)
    toast('휴지통으로 이동했습니다.', false, {
      label: '되돌리기',
      run: () =>
        task(async () => {
          await deleteEntry(id);
          return true;
        }).then((restored) => restored && syncInBackground()),
    });
  else toast('일기를 복원했습니다.');
}
async function purgeTrash(ask = true) {
  const days = repository?.retentionDays ?? settings.trashDays ?? 30;
  if (
    ask &&
    !(await confirmDialog(
      '휴지통 완전 삭제',
      `${days}일 이상 지난 휴지통 기록을 완전 삭제할까요? 복원할 수 없습니다.`,
      { accept: '완전 삭제', danger: true },
    ))
  )
    return;
  let ids;
  if (repository) {
    if (!google.connected()) throw new Error('완전 삭제하려면 Google에 연결해주세요.');
    ids = await repository.purge(days);
  } else ids = groups.filter((g) => expired(g.latest.entry, days)).map((g) => g.latest.entry.id);
  await removeEntries(ids);
  await cleanLocalPhotos(syncImages);
  await load();
  if (repository && ids.length) await refresh();
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
