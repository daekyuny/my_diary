import { icon } from './icons.js';

let viewer;
export function openPhoto(photo, load) {
  viewer ||= createViewer();
  return viewer.open(photo, load);
}

function createViewer() {
  const dialog = document.createElement('dialog');
  dialog.id = 'photo-dialog';
  dialog.setAttribute('aria-label', '원본 사진');
  const button = (action, label, name) =>
    `<button type="button" class="icon-button" data-photo-action="${action}" aria-label="${label}" title="${label}">${icon(name)}</button>`;
  dialog.innerHTML = `<div class="photo-viewer">
    <header class="photo-toolbar">
      <strong>원본 사진</strong>
      <div class="photo-tools">
        ${button('out', '축소', 'zoomOut')}
        <output class="photo-zoom" aria-label="사진 배율">—</output>
        ${button('in', '확대', 'zoomIn')}
        <button type="button" data-photo-action="fit" title="사진 전체가 보이도록 맞추기">맞춤</button>
        <button type="button" data-photo-action="actual" title="원본 해상도 100%">100%</button>
        ${button('expand', '창 확대', 'window')}
        ${button('fullscreen', '전체 화면', 'fullscreen')}
        ${button('close', '사진 닫기', 'close')}
      </div>
    </header>
    <div class="photo-stage" tabindex="0" role="region" aria-label="사진 확대 및 이동" aria-describedby="photo-help">
      <img class="original-photo" alt="첨부 사진 원본" draggable="false" hidden />
      <p class="photo-status" role="status">원본을 불러오는 중…</p>
    </div>
    <footer class="photo-footer"><span id="photo-help">드래그로 이동 · 두 손가락으로 확대·축소 및 이동</span><a class="photo-download" hidden>원본 다운로드</a></footer>
  </div>`;
  document.body.append(dialog);
  const frame = dialog.querySelector('.photo-viewer');
  const stage = dialog.querySelector('.photo-stage');
  const img = dialog.querySelector('img');
  const status = dialog.querySelector('.photo-status');
  const download = dialog.querySelector('.photo-download');
  const control = (name) => dialog.querySelector(`[data-photo-action="${name}"]`);
  let scale = 1,
    fit = 1,
    x = 0,
    y = 0,
    ready = false,
    fitted = true;
  let url,
    generation = 0,
    gesture,
    fullscreenPending = false;
  const pointers = new Map();
  const clamp = (value, min, max) => Math.max(min, Math.min(max, value));
  function render() {
    if (!ready) return;
    const maxX = Math.max(0, (img.naturalWidth * scale - stage.clientWidth) / 2);
    const maxY = Math.max(0, (img.naturalHeight * scale - stage.clientHeight) / 2);
    x = clamp(x, -maxX, maxX);
    y = clamp(y, -maxY, maxY);
    img.style.transform = `translate(calc(-50% + ${x}px), calc(-50% + ${y}px)) scale(${scale})`;
    dialog.querySelector('.photo-zoom').textContent = `${Math.round(scale * 100)}%`;
    control('in').disabled = scale >= 1;
    control('out').disabled = scale <= fit;
    stage.classList.toggle('can-pan', maxX > 0 || maxY > 0);
  }
  function resize() {
    if (!ready || !stage.clientWidth || !stage.clientHeight) return;
    fit = Math.min(1, stage.clientWidth / img.naturalWidth, stage.clientHeight / img.naturalHeight);
    scale = fitted ? fit : clamp(scale, fit, 1);
    if (fitted) x = y = 0;
    pointers.clear();
    gesture = null;
    render();
  }
  new ResizeObserver(resize).observe(stage);
  function zoom(value, from = { x: 0, y: 0 }, to = from) {
    if (!ready) return;
    const next = clamp(value, fit, 1);
    x = to.x - ((from.x - x) * next) / scale;
    y = to.y - ((from.y - y) * next) / scale;
    scale = next;
    fitted = scale <= fit;
    render();
  }
  function measure() {
    const points = [...pointers.values()].slice(0, 2);
    if (!points.length) return null;
    return {
      x: points.reduce((sum, p) => sum + p.x, 0) / points.length,
      y: points.reduce((sum, p) => sum + p.y, 0) / points.length,
      distance:
        points.length === 2 ? Math.hypot(points[1].x - points[0].x, points[1].y - points[0].y) : 0,
    };
  }
  function point(event) {
    const bounds = stage.getBoundingClientRect();
    return {
      x: event.clientX - bounds.left - bounds.width / 2,
      y: event.clientY - bounds.top - bounds.height / 2,
    };
  }
  function startGesture() {
    const center = measure();
    gesture = center ? { ...center, scale, offsetX: x, offsetY: y } : null;
  }
  stage.addEventListener('pointerdown', (event) => {
    if (!ready || (event.pointerType === 'mouse' && event.button !== 0)) return;
    event.preventDefault();
    stage.focus({ preventScroll: true });
    pointers.set(event.pointerId, point(event));
    stage.setPointerCapture(event.pointerId);
    startGesture();
  });
  stage.addEventListener('pointermove', (event) => {
    if (!pointers.has(event.pointerId)) return;
    event.preventDefault();
    pointers.set(event.pointerId, point(event));
    const next = measure();
    const ratio = gesture.distance > 0 && next.distance > 0 ? next.distance / gesture.distance : 1;
    // Anchor to gesture start: separate pointer events must not make a two-finger
    // pan shrink the image when the first finger temporarily hits the zoom limit.
    scale = gesture.scale;
    x = gesture.offsetX;
    y = gesture.offsetY;
    zoom(gesture.scale * ratio, gesture, next);
  });
  const release = (event) => {
    pointers.delete(event.pointerId);
    startGesture();
  };
  for (const type of ['pointerup', 'pointercancel', 'lostpointercapture'])
    stage.addEventListener(type, release);
  stage.addEventListener(
    'wheel',
    (event) => {
      if (!ready) return;
      event.preventDefault();
      zoom(scale * Math.exp(-event.deltaY * 0.002), point(event));
    },
    { passive: false },
  );
  stage.addEventListener('dblclick', (event) => zoom(fitted ? 1 : fit, point(event)));
  stage.addEventListener('keydown', (event) => {
    const steps = {
      ArrowLeft: [60, 0],
      ArrowRight: [-60, 0],
      ArrowUp: [0, 60],
      ArrowDown: [0, -60],
    };
    if (steps[event.key]) {
      event.preventDefault();
      const [dx, dy] = steps[event.key];
      x += dx;
      y += dy;
      render();
    } else if (['+', '=', '-'].includes(event.key)) {
      event.preventDefault();
      zoom(scale * (event.key === '-' ? 0.8 : 1.25));
    }
  });
  function fullState() {
    const active =
      document.fullscreenElement === frame || frame.classList.contains('screen-fallback');
    control('fullscreen').setAttribute('aria-pressed', String(active));
    control('fullscreen').setAttribute('aria-label', active ? '전체 화면 종료' : '전체 화면');
    control('fullscreen').title = active ? '전체 화면 종료' : '전체 화면';
  }
  document.addEventListener('fullscreenchange', fullState);
  async function fullscreen() {
    if (fullscreenPending) return;
    if (document.fullscreenElement === frame) {
      await document.exitFullscreen();
    } else if (frame.classList.contains('screen-fallback')) {
      frame.classList.remove('screen-fallback');
    } else {
      fullscreenPending = true;
      const current = generation;
      try {
        if (!frame.requestFullscreen) throw new Error('unsupported');
        // Fullscreen cannot target a dialog itself; use its content element.
        await frame.requestFullscreen();
        if (current !== generation && document.fullscreenElement === frame)
          await document.exitFullscreen();
      } catch {
        if (dialog.open && current === generation) frame.classList.add('screen-fallback');
      } finally {
        fullscreenPending = false;
      }
    }
    fullState();
  }
  function clean() {
    generation++;
    ready = false;
    pointers.clear();
    gesture = null;
    if (document.fullscreenElement === frame) document.exitFullscreen().catch(() => {});
    frame.classList.remove('screen-fallback');
    img.removeAttribute('src');
    img.hidden = true;
    download.hidden = true;
    download.removeAttribute('href');
    if (url) URL.revokeObjectURL(url);
    url = null;
  }
  dialog.addEventListener('close', clean);
  dialog.addEventListener('cancel', (event) => {
    if (frame.classList.contains('screen-fallback')) {
      event.preventDefault();
      frame.classList.remove('screen-fallback');
      fullState();
    }
  });
  dialog.addEventListener('click', (event) => {
    const action = event.target.closest('[data-photo-action]')?.dataset.photoAction;
    if (action === 'close') dialog.close();
    if (action === 'in') zoom(scale * 1.25);
    if (action === 'out') zoom(scale / 1.25);
    if (action === 'actual') zoom(1);
    if (action === 'fit') {
      fitted = true;
      resize();
    }
    if (action === 'expand') {
      const expanded = dialog.classList.toggle('expanded');
      dialog.style.width = dialog.style.height = '';
      control('expand').setAttribute('aria-pressed', String(expanded));
      control('expand').setAttribute('aria-label', expanded ? '창 크기 복원' : '창 확대');
      control('expand').title = expanded ? '창 크기 복원' : '창 확대';
    }
    if (action === 'fullscreen') fullscreen().catch(() => {});
  });
  return {
    async open(photo, load) {
      clean();
      const current = generation;
      fitted = true;
      x = y = 0;
      status.hidden = false;
      status.textContent = '원본을 불러오는 중…';
      dialog.querySelector('.photo-zoom').textContent = '—';
      for (const name of ['in', 'out', 'fit', 'actual']) control(name).disabled = true;
      fullState();
      if (!dialog.open) dialog.showModal();
      control('close').focus();
      try {
        const blob = await load();
        if (current !== generation || !dialog.open) return;
        url = URL.createObjectURL(blob);
        img.src = url;
        await img.decode();
        if (current !== generation || !dialog.open) return;
        img.style.width = `${img.naturalWidth}px`;
        img.style.height = `${img.naturalHeight}px`;
        img.hidden = false;
        ready = true;
        status.hidden = true;
        download.href = url;
        download.download = photo.name;
        download.hidden = false;
        for (const name of ['fit', 'actual']) control(name).disabled = false;
        resize();
      } catch (error) {
        if (current === generation && dialog.open)
          status.textContent = `원본을 열지 못했습니다: ${error.message}`;
      }
    },
  };
}
