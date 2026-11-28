import { createHash } from 'node:crypto';

export function createFeaturedContentKey(subjectId: number, questionIds: number[]): string {
  const sorted = [...new Set(questionIds)].sort((a, b) => a - b);
  return createHash('sha256').update(`${subjectId}:${sorted.join(',')}`).digest('hex');
}
