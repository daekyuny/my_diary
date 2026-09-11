// HTML records the version that is actually running, independently of a worker
// that may have activated while this page was suspended on the home screen.
export function appUpdates({ onChange, preserve, reload = () => location.reload() }) {
  const version = document.querySelector('meta[name="diary-build"]')?.content;
  const development = !version || version === '__DIARY_BUILD__';
  const state = {
    version: development ? '개발 버전' : version,
    ready: false,
    checking: false,
    applying: false,
    message: '',
  };
  let registration,
    checking,
    lastCheck = 0;
  const notify = () => onChange({ ...state });
  const workerVersion = () =>
    new Promise((resolve) => {
      const worker = navigator.serviceWorker.controller;
      if (!worker) return resolve(null);
      const channel = new MessageChannel();
      const finish = (value) => {
        clearTimeout(timer);
        channel.port1.close();
        resolve(value);
      };
      const timer = setTimeout(() => finish(null), 1000);
      channel.port1.onmessage = (event) => finish(event.data?.version);
      worker.postMessage({ type: 'DIARY_VERSION' }, [channel.port2]);
    });
  async function check(force = false) {
    if (checking) return checking;
    if (!force && Date.now() - lastCheck < 60000) return;
    lastCheck = Date.now();
    checking = (async () => {
      state.checking = true;
      notify();
      try {
        if (development) {
          state.message = '개발 환경에서는 배포 버전을 확인하지 않습니다.';
          return;
        }
        if (!navigator.onLine) throw new Error('인터넷 연결 후 다시 확인해주세요.');
        if (!('serviceWorker' in navigator))
          throw new Error('이 브라우저에서는 업데이트를 적용할 수 없습니다.');
        const response = await fetch('/version.json', {
          cache: 'no-store',
          signal: AbortSignal.timeout(10000),
        });
        if (!response.ok) throw new Error('새 버전을 확인하지 못했습니다. 다시 시도해주세요.');
        const latest = (await response.json()).version;
        if (typeof latest !== 'string' || !latest)
          throw new Error('버전 정보를 확인하지 못했습니다.');
        if (latest === version) {
          state.ready = false;
          state.message = '최신 버전입니다.';
          return;
        }
        state.ready = false;
        state.message = '새 버전을 내려받는 중입니다…';
        notify();
        registration ||= await navigator.serviceWorker.register('/sw.js', {
          updateViaCache: 'none',
        });
        await registration.update();
        // Do not reload into an old shell if install/download has not completed.
        const deadline = Date.now() + 20000;
        while (Date.now() < deadline) {
          if ((await workerVersion()) === latest) {
            state.ready = true;
            state.target = latest;
            state.message =
              '새 버전이 준비되었습니다. 작성 중인 내용은 기기에 저장한 뒤 적용합니다.';
            return;
          }
          await new Promise((resolve) => setTimeout(resolve, 300));
        }
        throw new Error('업데이트 준비가 아직 끝나지 않았습니다. 잠시 후 다시 확인해주세요.');
      } catch (error) {
        state.message = error.message || '업데이트를 확인하지 못했습니다.';
      } finally {
        state.checking = false;
        notify();
      }
    })();
    try {
      await checking;
    } finally {
      checking = null;
    }
  }
  async function apply() {
    if (!state.ready || state.applying) return;
    state.applying = true;
    notify();
    try {
      if ((await workerVersion()) !== state.target)
        throw new Error('버전이 변경되었습니다. 업데이트를 다시 확인해주세요.');
      await preserve();
      reload();
    } catch (error) {
      state.message = error.message || '내용을 저장하지 못해 업데이트를 적용하지 않았습니다.';
    } finally {
      state.applying = false;
      notify();
    }
  }
  function start() {
    notify();
    if ('serviceWorker' in navigator) {
      navigator.serviceWorker
        .register('/sw.js', { updateViaCache: 'none' })
        .then((value) => {
          registration = value;
          return check();
        })
        .catch(() => {
          state.message = '업데이트 확인에 실패했습니다. 다시 시도해주세요.';
          notify();
        });
      navigator.serviceWorker.addEventListener('controllerchange', () => check(true));
    }
    const resume = () => {
      if (document.visibilityState === 'visible') check();
    };
    document.addEventListener('visibilitychange', resume);
    window.addEventListener('pageshow', resume);
    window.addEventListener('focus', resume);
    window.addEventListener('online', () => check(true));
  }
  return { start, check, apply };
}
