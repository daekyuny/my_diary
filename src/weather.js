import { localDate, validDate, weatherLabel } from './model.js';

async function json(url) {
  const response = await fetch(url, { signal: AbortSignal.timeout(15000) });
  if (!response.ok)
    throw new Error('날씨 서비스에 연결하지 못했습니다. 잠시 후 다시 시도해주세요.');
  return response.json();
}

export async function findLocations(name) {
  const params = new URLSearchParams({ name, count: '6', language: 'ko', format: 'json' });
  return (
    (await json(`https://geocoding-api.open-meteo.com/v1/search?${params}`)).results?.map(
      (place) => ({
        name: [place.name, place.admin1, place.country].filter(Boolean).join(', '),
        latitude: place.latitude,
        longitude: place.longitude,
        timezone: place.timezone,
      }),
    ) || []
  );
}

export function currentLocation() {
  return new Promise((resolve, reject) => {
    if (!navigator.geolocation)
      return reject(new Error('이 브라우저는 위치 찾기를 지원하지 않습니다.'));
    navigator.geolocation.getCurrentPosition(
      ({ coords }) =>
        resolve({
          name: `현재 위치 (${coords.latitude.toFixed(3)}, ${coords.longitude.toFixed(3)})`,
          latitude: coords.latitude,
          longitude: coords.longitude,
          timezone: 'auto',
        }),
      () => reject(new Error('위치 권한을 허용하거나 도시를 직접 검색해주세요.')),
      { timeout: 15000, maximumAge: 60000 },
    );
  });
}

export async function fetchWeather(date, location) {
  if (
    !validDate(date) ||
    !Number.isFinite(location.latitude) ||
    !Number.isFinite(location.longitude)
  )
    throw new Error('날짜와 위치를 먼저 선택해주세요.');
  const daysAgo = (Date.parse(localDate()) - Date.parse(date)) / 86400000;
  if (daysAgo < -15) throw new Error('날씨 예보는 앞으로 15일까지만 조회할 수 있습니다.');
  const archive = daysAgo > 5;
  const params = new URLSearchParams({
    latitude: String(location.latitude),
    longitude: String(location.longitude),
    start_date: date,
    end_date: date,
    daily: 'weather_code,temperature_2m_max,temperature_2m_min',
    timezone: location.timezone || 'auto',
  });
  const result = await json(
    `${archive ? 'https://archive-api.open-meteo.com/v1/archive' : 'https://api.open-meteo.com/v1/forecast'}?${params}`,
  );
  const daily = result.daily;
  if (daily?.temperature_2m_min?.[0] == null || daily?.weather_code?.[0] == null)
    throw new Error('해당 날짜의 날씨 자료가 아직 없습니다.');
  return {
    date,
    location,
    code: daily.weather_code[0],
    label: weatherLabel(daily.weather_code[0]),
    min: daily.temperature_2m_min[0],
    max: daily.temperature_2m_max[0],
    kind: archive ? '과거 날씨 · 재분석 추정' : daysAgo > 0 ? '최근 날씨 · 모델 자료' : '예보',
    source: 'Open-Meteo',
    fetchedAt: new Date().toISOString(),
  };
}
