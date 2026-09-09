import {
  localDate,
  validDate,
  newEntry,
  makeRevision,
  entryGroups,
  filterGroups,
  mergeEvents,
  markdown,
} from './model.js';
import * as store from './storage.js';
import * as google from './google.js';
import { syncDrive, assetBlob } from './sync.js';
import { findLocations, currentLocation, fetchWeather } from './weather.js';
import { exportBackup, importBackup } from './backup.js';
import { enablePush, disablePush, syncReminders, testPush } from './notifications.js';

const $ = (selector) => document.querySelector(selector);
const escape = (text = '') =>
  String(text).replace(
    /[&<>"']/g,
    (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c],
  );
let settings = store.readSettings();
let entry = newEntry();
let parentIds = [];
let groups = [];
let dirty = false;
let busy = false;
let account = null;
let draftWrite = Promise.resolve();
let calendarList = [];
let objectUrls = [];
let toastTimer;
let cloudTimer;
let initialized = false;
let activeRevisionId = '';
let reminderDirty = false;

function toast(message, error = false) {
  clearTimeout(toastTimer);
  $('#toast').textContent = message;
  $('#toast').classList.toggle('error', error);
  $('#toast').hidden = false;
  toastTimer = setTimeout(
    () => {
      $('#toast').hidden = true;
    },
    error ? 12000 : 5500,
  );
}

async function task(fn) {
  if (busy) return;
  busy = true;
  $('#editor-fields').disabled = true;
  for (const id of ['save', 'sync', 'entry-date', 'connect-google', 'banner-connect', 'new-entry'])
    $(`#${id}`).disabled = true;
  try {
    await fn();
  } catch (error) {
    console.error(error);
    toast(error.message || '작업을 완료하지 못했습니다.', true);
  } finally {
    busy = false;
    $('#editor-fields').disabled = false;
    for (const id of [
      'save',
      'sync',
      'entry-date',
      'connect-google',
      'banner-connect',
      'new-entry',
    ])
      $(`#${id}`).disabled = false;
    updateConnection();
  }
}

function persistSettings() {
  store.saveSettings(settings);
}

function updateConnection() {
  const online = google.connected();
  $('#drive-title').textContent = account ? account.emailAddress : '내 Google Drive';
  $('#drive-status').textContent = online
    ? '연결됨 · 원본은 내 드라이브에'
    : account
      ? '재연결 필요 · 초안은 기기에'
      : '연결 전 · 기기에만 저장';
  $('#connection-banner').hidden = online;
  $('#connection-banner span').textContent = account
    ? '드라이브 연결을 갱신하면 저장을 이어갑니다.'
    : '일기를 내 드라이브에 안전하게 보관하세요.';
  if (!dirty && initialized) updateSaveState();
}

function updateSaveState(message) {
  if (message) {
    $('#save-state').textContent = message;
    return;
  }
  if (dirty) {
    $('#save-state').textContent = '기기 초안 · 동기화 대기';
    return;
  }
  const current = groups.find((group) => group.latest.entry.id === entry.id);
  const revision = current?.versions.find((r) => r.id === activeRevisionId) || current?.latest;
  $('#save-state').textContent = revision
    ? revision.driveId
      ? '✓ 드라이브 저장 완료'
      : '기기에 저장 · 동기화 대기'
    : '아직 작성 전';
}

async function refreshGroups() {
  groups = entryGroups(await store.all('revisions'));
  renderList();
  updateSaveState();
}

async function recoverDrafts() {
  // Recover every date, including a draft left just before closing the browser.
  for (const draft of await store.all('drafts')) {
    await store.put('revisions', makeRevision(draft.entry, draft.parents));
    await store.remove('drafts', draft.id);
  }
}

function renderList() {
  const filter = {
    query: $('#search').value,
    tag: $('#tag-filter').value,
    from: $('#filter-from').value,
    to: $('#filter-to').value,
    order: $('#sort').value,
  };
  const tags = [...new Set(groups.flatMap((group) => group.latest.entry.tags))].sort();
  $('#tag-filter').innerHTML =
    '<option value="">모든 태그</option>' +
    tags.map((tag) => `<option value="${escape(tag)}">${escape(tag)}</option>`).join('');
  if (tags.includes(filter.tag)) $('#tag-filter').value = filter.tag;
  const shown = filterGroups(groups, filter);
  $('#entry-count').textContent = groups.length;
  $('#result-count').textContent = shown.length;
  $('#entries').innerHTML = shown.length
    ? shown
        .map((group) => {
          const current = group.latest.entry;
          const day = new Date(`${current.date}T12:00:00`).toLocaleDateString('ko-KR', {
            month: 'long',
            day: 'numeric',
            weekday: 'short',
          });
          return `<button class="entry-card ${current.id === entry.id ? 'selected' : ''}" data-entry="${escape(current.id)}"><div class="card-date"><span>${escape(day)}</span><span>${group.heads.length > 1 ? '수정 충돌' : group.latest.driveId ? '✓' : '○'}</span></div><h3>${escape(current.title || '제목 없는 하루')}</h3><p>${escape(current.body || (current.events.length ? `${current.events.length}개의 예정된 일정` : '기억할 순간을 남겨보세요.'))}</p>${
            current.tags.length
              ? `<div class="card-tags">${current.tags
                  .slice(0, 4)
                  .map((tag) => `<span>#${escape(tag)}</span>`)
                  .join('')}</div>`
              : ''
          }</button>`;
        })
        .join('')
    : `<div class="empty-list"><span>✳</span><h3>${groups.length ? '일치하는 기록이 없어요' : '첫 번째 조각을 남겨보세요'}</h3><p>${groups.length ? '검색어나 날짜, 태그를 바꿔보세요.' : '오늘 기억하고 싶은 것 하나.<br />짧은 한 줄이면 충분해요.'}</p></div>`;
}

function setHeading() {
  $('#entry-date').value = entry.date;
  const date = new Date(`${entry.date}T12:00:00`);
  $('#entry-heading').textContent = date.toLocaleDateString('ko-KR', {
    year: 'numeric',
    month: 'long',
    day: 'numeric',
  });
  $('#entry-weekday').textContent = date
    .toLocaleDateString('en-US', { weekday: 'long' })
    .toUpperCase();
}

async function renderEditor() {
  for (const url of objectUrls) URL.revokeObjectURL(url);
  objectUrls = [];
  setHeading();
  $('#entry-title').value = entry.title;
  $('#entry-body').value = entry.body;
  $('#entry-tags').value = entry.tags.join(', ');
  $('#word-count').textContent = `${entry.body.length.toLocaleString()}자`;
  $('#weather-card').hidden = !entry.weather;
  if (entry.weather) {
    const w = entry.weather;
    $('#weather-card').innerHTML =
      `<div class="weather-detail">☀ ${escape(w.label)} · ${escape(w.min)}–${escape(w.max)}°C · ${escape(w.location.name)}<br /><small>${escape(w.date)} · ${escape(w.kind)} · <a href="https://open-meteo.com/" target="_blank" rel="noopener noreferrer">Open-Meteo</a></small><button id="remove-weather" class="text-button">제거</button></div>`;
    $('#remove-weather').onclick = () => {
      entry.weather = null;
      changed();
      renderEditor();
    };
  }
  $('#event-cards').innerHTML = entry.events
    .map(
      (event, index) =>
        `<article class="event-card"><header><div><small>▦ 예정된 일정${event.missing ? ' · 원본 변경/삭제 또는 조회 범위에서 제외됨' : ''}</small><h3>${escape(event.title)}</h3><small>${event.allDay ? '종일' : `${formatTime(event.start)} – ${formatTime(event.end)}`}${event.location ? ` · ${escape(event.location)}` : ''}</small></div><label><input type="checkbox" data-event-reminder="${index}" ${event.remind ? 'checked' : ''} ${event.allDay || event.missing ? 'disabled' : ''} />종료 알림</label></header><textarea data-event-note="${index}" aria-label="${escape(event.title)} 기록" placeholder="실제로 있었던 일, 기억하고 싶은 내용을 남겨보세요.">${escape(event.note)}</textarea></article>`,
    )
    .join('');
  const group = groups.find((g) => g.latest.entry.id === entry.id);
  $('#conflict').hidden = !group || group.heads.length < 2;
  if (group?.heads.length > 1) {
    $('#conflict').innerHTML =
      `다른 기기에서 수정한 버전 ${group.heads.length}개가 있습니다. 모두 보존되어 있습니다. <button id="compare-versions">비교하고 정리</button>`;
    $('#compare-versions').onclick = compareVersions;
  }
  $('#image-gallery').innerHTML = entry.images
    .map(
      (image) =>
        `<figure class="image-tile" data-image="${escape(image.id)}"><div class="image-placeholder">사진 불러오는 중…</div><figcaption>${escape(image.name)}</figcaption><button class="text-button" data-insert-image="${escape(image.id)}">본문에 삽입</button><button class="text-button" data-remove-image="${escape(image.id)}">제거</button></figure>`,
    )
    .join('');
  const renderEntryId = entry.id;
  for (const image of entry.images) {
    try {
      const blob = await assetBlob(image);
      if (entry.id !== renderEntryId) return;
      const url = URL.createObjectURL(blob);
      objectUrls.push(url);
      const placeholder = $(`[data-image="${image.id}"] .image-placeholder`);
      if (placeholder) {
        const img = document.createElement('img');
        img.src = url;
        img.alt = image.name;
        placeholder.replaceWith(img);
      }
    } catch {
      const placeholder = $(`[data-image="${image.id}"] .image-placeholder`);
      if (placeholder) placeholder.textContent = '사진을 보려면 Google을 다시 연결해주세요.';
    }
  }
  updateSaveState();
  if (!$('#preview').hidden) await renderPreview();
}

function formatTime(value) {
  return new Date(value).toLocaleTimeString('ko-KR', {
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
  });
}

function changed() {
  dirty = true;
  const snapshot = { id: entry.id, entry: structuredClone(entry), parents: [...parentIds] };
  draftWrite = draftWrite
    .catch(() => {})
    .then(() => store.put('drafts', snapshot))
    .then(() => updateSaveState())
    .catch((error) => {
      updateSaveState('저장 실패 · 화면을 닫지 마세요');
      toast(`기기 저장 실패: ${error.message}`, true);
      throw error;
    });
  // A rejection remains observable by saveEntry without becoming an unhandled rejection.
  draftWrite.catch(() => {});
  // Keep a local draft on every input; make a revision and sync after a pause.
  clearTimeout(cloudTimer);
  cloudTimer = setTimeout(() => {
    if (!busy && dirty) task(() => saveEntry(true));
  }, 1800);
}

async function saveEntry(sync = false) {
  clearTimeout(cloudTimer);
  await draftWrite;
  if (dirty) {
    const revision = makeRevision(entry, parentIds);
    await store.put('revisions', revision);
    parentIds = [revision.id];
    activeRevisionId = revision.id;
    dirty = false;
    await store.remove('drafts', entry.id);
    await refreshGroups();
  }
  if (sync && google.connected()) {
    updateSaveState('드라이브에 저장 중…');
    await syncDrive(updateSaveState);
    await refreshGroups();
    // Local editing can continue from its own branch if a remote head appeared.
    const group = groups.find((g) => g.latest.entry.id === entry.id);
    if (group?.heads.length > 1) await renderEditor();
  }
  if (sync && reminderDirty && settings.notifications?.subscription) {
    await updateReminderSchedule();
    reminderDirty = false;
  }
  updateSaveState();
}

async function openEntry(id, date) {
  await saveEntry(false);
  const group =
    groups.find((g) => g.latest.entry.id === id) ||
    (!id && groups.find((g) => g.latest.entry.date === date));
  entry = group ? structuredClone(group.latest.entry) : newEntry(date || localDate());
  parentIds = group ? [group.latest.id] : [];
  activeRevisionId = group?.latest.id || '';
  const draft = await store.get('drafts', entry.id);
  if (draft) {
    entry = draft.entry;
    parentIds = draft.parents;
    dirty = true;
  }
  document.body.classList.remove('list-mode');
  $('#preview').hidden = true;
  renderList();
  await renderEditor();
  history.replaceState(null, '', `?date=${entry.date}`);
  if (google.hasCalendar() && settings.calendarIds?.length) await importCalendarDay();
}

async function connect(calendar = false) {
  // authorize must be called directly from a click to preserve the iOS popup gesture.
  const authorization = google.authorize(calendar);
  await task(async () => {
    await saveEntry(false);
    await authorization;
    const user = await google.identity();
    if (account && account.permissionId !== user.permissionId) {
      google.disconnect();
      throw new Error('다른 구글 계정입니다. 설정에서 연결을 해제한 후 다시 연결해주세요.');
    }
    if (!account) {
      await draftWrite;
      account = user;
      settings.account = user;
      persistSettings();
      await store.openStore(user.permissionId);
      await recoverDrafts();
      entry = newEntry();
      parentIds = [];
      activeRevisionId = '';
      dirty = false;
    }
    await syncDrive(updateSaveState);
    await refreshGroups();
    await openEntry(null, localDate());
    if (calendar) {
      calendarList = await google.calendars();
      showCalendarDialog();
    }
    toast('Google Drive에 연결했습니다. 연결 전 초안은 설정에서 가져올 수 있습니다.');
  });
}

function dialog(title, html) {
  $('#dialog-title').textContent = title;
  $('#dialog-body').innerHTML = html;
  if (!$('#dialog').open) $('#dialog').showModal();
}
function closeDialog() {
  $('#dialog').close();
}

function settingsDialog() {
  dialog(
    '나의 일기장 설정',
    `<p class="dialog-copy">일기와 사진은 내 Google Drive의 My Diary 폴더에 저장됩니다. 연결 전 기록은 이 브라우저에만 남습니다.</p><label class="form-field">Google OAuth 웹 클라이언트 ID<input id="setting-client" value="${escape(settings.googleClientId || '')}" placeholder="…apps.googleusercontent.com" /><small>클라이언트 ID는 공개 설정값입니다. 비밀번호나 Client Secret은 입력하지 마세요.</small></label><div class="dialog-actions"><button id="save-settings" class="primary">설정 저장</button><button id="settings-connect" class="button">Google 연결</button>${account ? '<button id="disconnect" class="button">연결 해제</button>' : ''}</div><hr /><h3>데이터 보관</h3><p class="dialog-copy">ZIP에는 일반 Markdown, 사진 원본, 모든 수정 버전이 포함됩니다. 다른 계정으로 옮길 때도 사용할 수 있습니다.</p><div class="dialog-actions"><button id="settings-export" class="button">ZIP 내보내기</button><button id="settings-import" class="button">ZIP 가져오기</button>${account ? '<button id="import-local" class="button">연결 전 초안 가져오기</button>' : ''}</div><p class="dialog-copy">아이폰·아이패드: Safari 공유 메뉴 → 홈 화면에 추가.<br />일정 연동과 알림 설정은 아래에서 열 수 있습니다.</p><div class="dialog-actions"><button id="settings-calendar" class="button">캘린더 설정</button><button id="settings-reminders" class="button">알림 설정</button></div><p class="dialog-copy">날씨: <a href="https://open-meteo.com/" target="_blank" rel="noopener noreferrer">Open-Meteo</a> · 개인 비상업용 무료 API. 위치는 날씨를 요청할 때만 전달합니다.</p>`,
  );
  $('#save-settings').onclick = () => {
    settings.googleClientId = $('#setting-client').value.trim();
    persistSettings();
    google.configureGoogle(settings.googleClientId);
    toast('설정을 저장했습니다.');
  };
  $('#settings-connect').onclick = () => {
    settings.googleClientId = $('#setting-client').value.trim();
    persistSettings();
    google.configureGoogle(settings.googleClientId);
    closeDialog();
    connect();
  };
  if ($('#disconnect'))
    $('#disconnect').onclick = () =>
      task(async () => {
        await saveEntry(false);
        google.disconnect();
        account = null;
        delete settings.account;
        persistSettings();
        await store.openStore();
        entry = newEntry();
        dirty = false;
        parentIds = [];
        activeRevisionId = '';
        await refreshGroups();
        await openEntry(null, localDate());
        closeDialog();
        toast('연결을 해제했습니다. 드라이브 원본은 보존됩니다.');
      });
  $('#settings-export').onclick = exportClick;
  $('#settings-import').onclick = () => $('#import-input').click();
  if ($('#import-local'))
    $('#import-local').onclick = () =>
      task(async () => {
        await saveEntry(false);
        const owner = account.permissionId;
        let revisions;
        let assets;
        try {
          await store.openStore();
          const drafts = await store.all('drafts');
          for (const draft of drafts)
            await store.put('revisions', makeRevision(draft.entry, draft.parents));
          revisions = await store.all('revisions');
          assets = await store.all('assets');
        } finally {
          await store.openStore(owner);
        }
        for (const asset of assets)
          if (!(await store.get('assets', asset.id))) await store.put('assets', asset);
        for (const revision of revisions)
          if (!(await store.get('revisions', revision.id))) await store.put('revisions', revision);
        await syncDrive(updateSaveState);
        await refreshGroups();
        closeDialog();
        toast(`${revisions.length}개 버전을 가져왔습니다.`);
      });
  $('#settings-calendar').onclick = openCalendarSettings;
  $('#settings-reminders').onclick = remindersDialog;
}

async function exportClick() {
  await task(async () => {
    await saveEntry(false);
    const blob = await exportBackup();
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `my-diary-${localDate()}.zip`;
    a.click();
    setTimeout(() => URL.revokeObjectURL(url), 60000);
    toast('현재 기기에 불러온 모든 기록을 내보냈습니다. 최신 원본은 먼저 동기화해주세요.');
  });
}

function weatherDialog() {
  dialog(
    '그날, 그곳의 날씨',
    `<p class="dialog-copy"><b>${escape(entry.date)}</b>의 날씨를 찾습니다. 지난 일기를 쓸 때는 그날 머물렀던 장소를 선택해주세요.</p><label class="form-field">도시 이름<input id="location-query" placeholder="서울, 부산, Tokyo…" /></label><div class="dialog-actions"><button id="search-location" class="primary">도시 검색</button><button id="current-location" class="button">현재 위치 사용</button></div><div id="location-results"></div><p class="dialog-copy">과거 날씨는 재분석·모델 자료이며, 오늘과 미래 날짜는 예보입니다. 위치 권한은 현재 위치 버튼을 눌렀을 때만 요청합니다.</p>`,
  );
  const search = () =>
    task(async () => {
      const query = $('#location-query').value.trim();
      if (query.length < 2) throw new Error('도시 이름을 두 글자 이상 입력해주세요.');
      const locations = await findLocations(query);
      $('#location-results').innerHTML = locations.length
        ? locations
            .map(
              (location, index) =>
                `<button class="location-result" data-location="${index}">${escape(location.name)}</button>`,
            )
            .join('')
        : '<p class="dialog-copy">검색 결과가 없습니다. 영문 도시명으로도 검색해보세요.</p>';
      document.querySelectorAll('[data-location]').forEach((button) => {
        button.onclick = () => useLocation(locations[Number(button.dataset.location)]);
      });
    });
  $('#search-location').onclick = search;
  $('#location-query').onkeydown = (event) => {
    if (event.key === 'Enter') search();
  };
  $('#current-location').onclick = () =>
    task(async () => {
      const location = await currentLocation();
      entry.weather = await fetchWeather(entry.date, location);
      changed();
      closeDialog();
      await renderEditor();
      await saveEntry(true);
    });
}

function useLocation(location) {
  return task(async () => {
    entry.weather = await fetchWeather(entry.date, location);
    changed();
    closeDialog();
    await renderEditor();
    await saveEntry(true);
  });
}

function openCalendarSettings() {
  if (!google.hasCalendar()) {
    dialog(
      'Google 캘린더 연결',
      '<p class="dialog-copy">선택한 캘린더의 일정 제목·시간·장소를 일기에 가져옵니다. 일정은 읽기만 하며 원본을 변경하지 않습니다.</p><button id="authorize-calendar" class="primary">캘린더 읽기 권한 연결</button>',
    );
    $('#authorize-calendar').onclick = () => {
      closeDialog();
      connect(true);
    };
  } else
    task(async () => {
      calendarList = await google.calendars();
      showCalendarDialog();
    });
}

function showCalendarDialog() {
  dialog(
    '가져올 캘린더',
    `<p class="dialog-copy">일정 아래에 직접 기록을 덧붙일 수 있습니다. 원본 일정이 변경되어도 작성한 메모는 보존됩니다.</p>${calendarList.map((calendar) => `<label class="check-row"><input type="checkbox" name="calendar" value="${escape(calendar.id)}" ${(settings.calendarIds || []).includes(calendar.id) ? 'checked' : ''} />${escape(calendar.summary)}</label>`).join('')}<div class="dialog-actions"><button id="save-calendars" class="primary">선택 저장 · 일정 가져오기</button></div>`,
  );
  $('#save-calendars').onclick = () =>
    task(async () => {
      settings.calendarIds = [...document.querySelectorAll('input[name="calendar"]:checked')].map(
        (input) => input.value,
      );
      persistSettings();
      closeDialog();
      await importCalendarDay();
      await updateReminderSchedule();
    });
}

async function importCalendarDay() {
  if (!google.hasCalendar() || !settings.calendarIds?.length) {
    openCalendarSettings();
    return;
  }
  const from = new Date(`${entry.date}T00:00:00`);
  const to = new Date(from);
  to.setDate(to.getDate() + 1);
  const incoming = (
    await Promise.all(settings.calendarIds.map((id) => google.events(id, from, to)))
  ).flat();
  const merged = mergeEvents(entry.events, incoming);
  if (JSON.stringify(merged) !== JSON.stringify(entry.events)) {
    entry.events = merged;
    changed();
    await renderEditor();
    await saveEntry(true);
  }
  toast(`${incoming.length}개의 일정을 가져왔습니다.`);
}

function remindersDialog() {
  const notification = settings.notifications || {};
  dialog(
    '잊지 않도록, 기록 알림',
    `<p class="dialog-copy">아이폰·아이패드는 iOS/iPadOS 16.4 이상에서 홈 화면에 추가한 뒤 알림을 허용해주세요. 예약 알림 서버를 연결하면 앱을 닫아도 받을 수 있습니다. 서버가 5분마다 확인하므로 설정 시각보다 최대 약 5분 늦을 수 있습니다.</p><label class="form-field">알림 서버 주소<input id="notify-url" type="url" placeholder="https://my-diary-notify.…workers.dev" value="${escape(notification.server || settings.notificationServer || '')}" /></label><label class="form-field">개인 알림 서버 연결 키<input id="notify-secret" type="password" autocomplete="off" value="${escape(notification.secret || '')}" /><small>배포 시 설정한 OWNER_TOKEN. Google 비밀번호가 아닙니다. 이 기기에만 보관합니다.</small></label><label class="check-row"><input id="notify-daily" type="checkbox" ${notification.daily ? 'checked' : ''} />매일 기록 알림</label><label class="form-field">매일 알림 시각<input id="notify-time" type="time" value="${escape(notification.time || '21:00')}" /></label><label class="check-row"><input id="notify-events" type="checkbox" ${notification.events ? 'checked' : ''} />일정 종료 후 알림</label><label class="form-field">일정이 끝난 뒤<select id="notify-delay"><option value="0">바로</option><option value="10">10분 후</option><option value="30">30분 후</option><option value="60">1시간 후</option></select></label><p class="dialog-copy">시간대: ${escape(Intl.DateTimeFormat().resolvedOptions().timeZone)}<br />일정 알림은 동기화 시 앞으로 14일분을 예약합니다. 캘린더 변경은 앱에서 다시 동기화해야 반영됩니다. 종일 일정은 종료 알림에서 제외합니다.</p><div class="dialog-actions"><button id="enable-notifications" class="primary">이 기기 알림 켜기·저장</button><button id="test-notification" class="button">테스트 알림</button><button id="disable-notifications" class="button">이 기기 알림 끄기</button></div><p class="dialog-copy">${notification.lastSync ? `마지막 알림 동기화: ${escape(new Date(notification.lastSync).toLocaleString('ko-KR'))}` : '알림 서버 미연결'}</p>`,
  );
  $('#notify-delay').value = String(notification.delay || 0);
  $('#enable-notifications').onclick = () => {
    const config = {
      server: $('#notify-url').value.trim().replace(/\/$/, ''),
      secret: $('#notify-secret').value.trim(),
      daily: $('#notify-daily').checked,
      time: $('#notify-time').value,
      events: $('#notify-events').checked,
      delay: Number($('#notify-delay').value),
      timezone: Intl.DateTimeFormat().resolvedOptions().timeZone,
    };
    // Request permission in the user gesture before any network await.
    const permission =
      'Notification' in window ? Notification.requestPermission() : Promise.resolve('unsupported');
    task(async () => {
      if ((await permission) !== 'granted')
        throw new Error('알림 권한을 허용해주세요. 아이폰은 홈 화면에서 일기장을 열어야 합니다.');
      const subscription = await enablePush(config);
      settings.notifications = { ...config, subscription };
      persistSettings();
      await updateReminderSchedule();
      closeDialog();
      toast('이 기기의 알림 설정을 저장했습니다.');
    });
  };
  $('#disable-notifications').onclick = () =>
    task(async () => {
      await disablePush(settings.notifications);
      delete settings.notifications;
      persistSettings();
      closeDialog();
      toast('이 기기의 알림을 껐습니다.');
    });
  $('#test-notification').onclick = () =>
    task(async () => {
      await testPush(settings.notifications);
      toast('테스트 알림을 보냈습니다.');
    });
}

async function updateReminderSchedule() {
  const config = settings.notifications;
  if (!config?.subscription) return;
  let upcoming = [];
  if (config.events) {
    if (!google.hasCalendar() || !settings.calendarIds?.length)
      throw new Error('일정 알림을 갱신하려면 캘린더 연결과 선택이 필요합니다.');
    const from = new Date();
    const to = new Date(Date.now() + 14 * 86400000);
    upcoming = (
      await Promise.all(settings.calendarIds.map((id) => google.events(id, from, to)))
    ).flat();
    const overrides = new Map(
      groups
        .flatMap((group) => group.latest.entry.events)
        .map((event) => [event.key, event.remind]),
    );
    upcoming = upcoming.filter((event) => !event.allDay && overrides.get(event.key) !== false);
  }
  await syncReminders(config, upcoming);
  config.lastSync = new Date().toISOString();
  persistSettings();
}

function compareVersions() {
  const group = groups.find((g) => g.latest.entry.id === entry.id);
  dialog(
    '두 기록을 모두 보존하기',
    `<p class="dialog-copy">서로 다른 기기에서 작성한 내용입니다. 버전을 선택해 읽거나 모든 본문과 일정 메모를 하나의 기록으로 합칠 수 있습니다. 이전 버전도 남습니다.</p>${group.heads.map((revision, index) => `<article class="event-card"><small>${escape(new Date(revision.savedAt).toLocaleString('ko-KR'))}</small><h3>${escape(revision.entry.title)}</h3><p style="white-space:pre-wrap;overflow-wrap:anywhere">${escape(revision.entry.body)}</p><button class="button" data-version="${index}">이 버전 열기</button></article>`).join('')}<div class="dialog-actions"><button id="merge-versions" class="primary">모든 내용을 합쳐 새 버전 저장</button></div>`,
  );
  document.querySelectorAll('[data-version]').forEach((button) => {
    button.onclick = () =>
      task(async () => {
        await saveEntry(false);
        const revision = group.heads[Number(button.dataset.version)];
        entry = structuredClone(revision.entry);
        parentIds = [revision.id];
        activeRevisionId = revision.id;
        dirty = false;
        closeDialog();
        await renderEditor();
      });
  });
  $('#merge-versions').onclick = () =>
    task(async () => {
      const versions = group.heads;
      entry = structuredClone(versions[0].entry);
      entry.body = [...new Set(versions.map((revision) => revision.entry.body))].join(
        '\n\n--- 다른 기기의 기록 ---\n\n',
      );
      entry.tags = [...new Set(versions.flatMap((revision) => revision.entry.tags))];
      entry.images = [
        ...new Map(
          versions.flatMap((revision) => revision.entry.images).map((image) => [image.id, image]),
        ).values(),
      ];
      const events = new Map();
      for (const revision of versions)
        for (const event of revision.entry.events) {
          const old = events.get(event.key);
          events.set(
            event.key,
            old
              ? {
                  ...old,
                  note: [...new Set([old.note, event.note].filter(Boolean))].join('\n\n---\n\n'),
                }
              : structuredClone(event),
          );
        }
      entry.events = [...events.values()];
      parentIds = versions.map((revision) => revision.id);
      changed();
      closeDialog();
      await saveEntry(true);
      await renderEditor();
      toast(
        '모든 내용을 합쳤습니다. 제목과 날씨는 최근 버전을 사용하며 이전 버전도 백업에 남습니다.',
      );
    });
}

async function renderPreview() {
  const container = $('#preview');
  container.replaceChildren();
  // Text-only rendering prevents HTML/script injection from diary, calendar, and imported files.
  const parts = entry.body.split(/(!\[[^\]]*\]\(diary-image:[\w-]+\))/g);
  for (const part of parts) {
    const match = /^!\[([^\]]*)\]\(diary-image:([\w-]+)\)$/.exec(part);
    const image = match && entry.images.find((image) => image.id === match[2]);
    if (image) {
      try {
        const url = URL.createObjectURL(await assetBlob(image));
        objectUrls.push(url);
        const img = document.createElement('img');
        img.src = url;
        img.alt = match[1];
        container.append(img);
      } catch {
        container.append(document.createTextNode('[사진: Google 재연결 필요]'));
      }
    } else container.append(document.createTextNode(part));
  }
}

function bind() {
  $('#entry-title').oninput = (event) => {
    entry.title = event.target.value;
    changed();
  };
  $('#entry-body').oninput = (event) => {
    entry.body = event.target.value;
    $('#word-count').textContent = `${entry.body.length.toLocaleString()}자`;
    changed();
  };
  $('#entry-tags').oninput = (event) => {
    entry.tags = [
      ...new Set(
        event.target.value
          .split(',')
          .map((tag) => tag.trim().replace(/^#/, ''))
          .filter(Boolean),
      ),
    ];
    changed();
  };
  $('#entry-date').onchange = () => {
    const date = $('#entry-date').value;
    if (validDate(date)) task(() => openEntry(null, date));
    else setHeading();
  };
  $('#save').onclick = () =>
    task(async () => {
      await saveEntry(true);
      if (settings.notifications?.events) await updateReminderSchedule();
      toast(
        google.connected()
          ? '드라이브에 저장했습니다.'
          : '이 기기에 저장했습니다. 드라이브 저장은 Google 연결 후 가능합니다.',
      );
    });
  $('#sync').onclick = () => {
    if (!google.connected()) {
      if (!settings.googleClientId) settingsDialog();
      else connect();
      return;
    }
    task(async () => {
      await saveEntry(true);
      const date = entry.date;
      await openEntry(entry.id, date);
      await updateReminderSchedule();
      toast('동기화를 완료했습니다.');
    });
  };
  $('#new-entry').onclick = () => task(() => openEntry(null, localDate()));
  $('#entries').onclick = (event) => {
    const button = event.target.closest('[data-entry]');
    if (button) task(() => openEntry(button.dataset.entry));
  };
  for (const id of ['search', 'tag-filter', 'sort', 'filter-from', 'filter-to'])
    $(`#${id}`).addEventListener(id === 'search' ? 'input' : 'change', renderList);
  $('#toggle-dates').onclick = () => {
    $('#date-filters').hidden = !$('#date-filters').hidden;
  };
  $('#clear-filters').onclick = () => {
    $('#filter-from').value = '';
    $('#filter-to').value = '';
    renderList();
  };
  $('#show-journal').onclick = $('#back-list').onclick = () => {
    document.body.classList.add('list-mode');
  };
  $('#connect-google').onclick = $('#banner-connect').onclick = () => {
    if (!settings.googleClientId) settingsDialog();
    else connect();
  };
  $('#open-settings').onclick = settingsDialog;
  $('#open-calendar').onclick = openCalendarSettings;
  $('#calendar-button').onclick = () => {
    if (!google.hasCalendar() || !settings.calendarIds?.length) openCalendarSettings();
    else task(importCalendarDay);
  };
  $('#open-reminders').onclick = remindersDialog;
  $('#weather-button').onclick = weatherDialog;
  $('#close-dialog').onclick = closeDialog;
  $('#export').onclick = exportClick;
  $('#import-input').onchange = (event) =>
    task(async () => {
      const file = event.target.files[0];
      if (!file) return;
      await saveEntry(false);
      const count = await importBackup(file);
      await refreshGroups();
      event.target.value = '';
      closeDialog();
      toast(`${count}개 버전을 가져왔습니다. Google 연결 후 동기화하면 드라이브에도 저장됩니다.`);
    });
  $('#add-image').onclick = () => $('#image-input').click();
  $('#image-input').onchange = (event) =>
    task(async () => {
      for (const file of event.target.files) {
        if (!/^image\/(jpeg|png|webp|gif)$/.test(file.type))
          throw new Error('JPG, PNG, WebP, GIF 이미지를 선택해주세요. HEIC는 JPG로 변환해주세요.');
        if (file.size > 10 * 1024 * 1024) throw new Error('사진 한 장은 10MB 이하로 선택해주세요.');
        const image = { id: crypto.randomUUID(), name: file.name, type: file.type };
        await store.put('assets', { ...image, blob: file });
        entry.images.push(image);
        changed();
      }
      event.target.value = '';
      await renderEditor();
      await saveEntry(true);
    });
  $('#image-gallery').onclick = (event) => {
    const insert = event.target.closest('[data-insert-image]');
    const remove = event.target.closest('[data-remove-image]');
    if (insert) {
      const image = entry.images.find((image) => image.id === insert.dataset.insertImage);
      const textarea = $('#entry-body');
      const start = textarea.selectionStart;
      const end = textarea.selectionEnd;
      entry.body =
        entry.body.slice(0, start) +
        `\n![${image.name.replace(/[\[\]]/g, '')}](diary-image:${image.id})\n` +
        entry.body.slice(end);
      changed();
      renderEditor();
    }
    if (remove) {
      entry.images = entry.images.filter((image) => image.id !== remove.dataset.removeImage);
      entry.body = entry.body.replace(
        new RegExp(`!\\[[^\\]]*\\]\\(diary-image:${remove.dataset.removeImage}\\)`, 'g'),
        '',
      );
      changed();
      renderEditor();
    }
  };
  $('#event-cards').oninput = (event) => {
    if (event.target.dataset.eventNote != null) {
      entry.events[Number(event.target.dataset.eventNote)].note = event.target.value;
      changed();
    }
  };
  $('#event-cards').onchange = (event) => {
    if (event.target.dataset.eventReminder != null) {
      entry.events[Number(event.target.dataset.eventReminder)].remind = event.target.checked;
      reminderDirty = true;
      changed();
    }
  };
  $('#toggle-preview').onclick = () => {
    $('#preview').hidden = !$('#preview').hidden;
    if (!$('#preview').hidden) task(renderPreview);
  };
  document.addEventListener('keydown', (event) => {
    if (!(event.ctrlKey || event.metaKey)) return;
    if (event.key.toLowerCase() === 's') {
      event.preventDefault();
      task(() => saveEntry(true));
    }
    if (event.key.toLowerCase() === 'k') {
      event.preventDefault();
      document.body.classList.add('list-mode');
      $('#search').focus();
    }
  });
  window.addEventListener('online', () => {
    if (google.connected()) task(() => saveEntry(true));
  });
  window.addEventListener('beforeunload', (event) => {
    if (dirty) {
      event.preventDefault();
      event.returnValue = '';
    }
  });
  setInterval(updateConnection, 60000);
}

async function start() {
  const config = await fetch('/config.json')
    .then((response) => response.json())
    .catch(() => ({}));
  settings = { ...config, ...settings };
  google.configureGoogle(settings.googleClientId);
  account = settings.account || null;
  await store.openStore(account?.permissionId);
  await recoverDrafts();
  await refreshGroups();
  const requested = new URLSearchParams(location.search).get('date');
  const date = validDate(requested) ? requested : localDate();
  await openEntry(null, date);
  const drafts = await store.all('drafts');
  const draft = drafts.find((draft) => draft.entry.date === date);
  if (draft) {
    entry = draft.entry;
    parentIds = draft.parents;
    dirty = true;
    await renderEditor();
  }
  $('#today-label').textContent = new Date().toLocaleDateString('ko-KR', {
    year: 'numeric',
    month: 'long',
    day: 'numeric',
    weekday: 'long',
  });
  bind();
  initialized = true;
  $('#editor-fields').disabled = false;
  updateConnection();
  if ('serviceWorker' in navigator)
    navigator.serviceWorker
      .register('/sw.js')
      .catch(() => toast('오프라인 기능 등록에 실패했습니다. HTTPS 연결을 확인해주세요.', true));
}
start().catch((error) => toast(`일기장을 열지 못했습니다: ${error.message}`, true));
