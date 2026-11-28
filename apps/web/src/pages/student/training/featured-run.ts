import type { FeaturedRunPayload } from '@/services/api';

export const FEATURED_HANDOFF_KEY = 'training:targeted';
export const FEATURED_RETURN_PATH = '/student/featured-sets';

/** 精选题必须沿用服务端 open 返回的 sessionUid；客户端不得自行生成。 */
export function saveFeaturedRunHandoff(payload: FeaturedRunPayload): void {
  sessionStorage.setItem(
    FEATURED_HANDOFF_KEY,
    JSON.stringify({
      sessionId: null,
      sessionUid: payload.sessionUid,
      questions: payload.questions,
      title: payload.title,
      mode: 'featured',
    }),
  );
}

export function featuredRunPath(
  payload: FeaturedRunPayload,
  returnTo = FEATURED_RETURN_PATH,
): string {
  const qs = new URLSearchParams({
    subjectId: String(payload.subjectId),
    returnTo,
  });
  return `/student/training/targeted/run?${qs.toString()}`;
}
