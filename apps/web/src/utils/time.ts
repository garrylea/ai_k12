// Relative time formatting for conversation lists (e.g. "2天前", "3小时前").
const MIN = 60 * 1000;
const HOUR = 60 * MIN;
const DAY = 24 * HOUR;

export function relativeTime(iso: string): string {
  const then = new Date(iso).getTime();
  if (Number.isNaN(then)) return '';
  const diff = Date.now() - then;
  if (diff < MIN) return '刚刚';
  if (diff < HOUR) return `${Math.floor(diff / MIN)}分钟前`;
  if (diff < DAY) return `${Math.floor(diff / HOUR)}小时前`;
  if (diff < 30 * DAY) return `${Math.floor(diff / DAY)}天前`;
  const d = new Date(then);
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}

// Strip the trailing " · MM-DD HH:MM" timestamp the backend appends to
// auto-generated conversation titles (see apps/server ai.service.ts
// maybeUpdateTitle: `${topic} · ${time}`). The relative time shown beneath
// each list item already conveys recency, so this suffix is redundant in
// the UI. Returns '' for null/empty so callers can fall back to a default.
export function stripTitleDate(title: string | null | undefined): string {
  if (!title) return '';
  return title.replace(/\s*[·•]\s*\d{1,2}-\d{1,2}\s+\d{1,2}:\d{2}\s*$/, '').trim();
}
