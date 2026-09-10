export const KEEP_READ_SCOPE = 'https://www.googleapis.com/auth/keep.readonly';
export const KEEP_PROBE_URL = 'https://keep.googleapis.com/v1/notes?pageSize=1&fields=notes(name)';

export async function probeKeep(token, fetcher = fetch) {
  const response = await fetcher(KEEP_PROBE_URL, {
    method: 'GET',
    headers: { Authorization: `Bearer ${token}` },
    cache: 'no-store',
    credentials: 'omit',
    redirect: 'error',
    signal: AbortSignal.timeout(20000),
  });
  const data = await response.json().catch(() => null);
  if (response.ok) {
    if (
      !data ||
      typeof data !== 'object' ||
      Array.isArray(data) ||
      (data.notes !== undefined && !Array.isArray(data.notes))
    )
      return {
        stage: 'API',
        http: response.status,
        success: false,
        message: '정상적인 목록 응답이 아닙니다. 접근 성공으로 판정하지 않습니다.',
      };
    return {
      stage: 'API',
      http: response.status,
      success: true,
      foundNote: Boolean(data.notes?.length),
      message:
        '공식 Keep 목록 조회에 성공했습니다. 본문 수정·라벨 지원 여부와는 별도의 결과입니다.',
    };
  }
  // Deliberately return only diagnostic fields, never a raw API response.
  const clean = (value) =>
    String(value || '')
      .replaceAll(token, '[토큰 제외]')
      .slice(0, 2000);
  return {
    stage: 'API',
    http: response.status,
    success: false,
    status: clean(data?.error?.status),
    message: clean(data?.error?.message || 'API 요청 실패'),
    reasons: (data?.error?.details || []).map((detail) => clean(detail.reason)).filter(Boolean),
    hint: '이 오류만으로 개인 계정 제한이라고 단정하지 말고 API 활성화·OAuth 권한·오류 사유를 함께 확인하세요.',
  };
}
