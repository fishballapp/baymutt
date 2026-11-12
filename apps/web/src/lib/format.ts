// Every time, size and count the dashboard shows is written here, so one screen never says it
// differently from another.

const UNITS = [
  ['year', 365 * 24 * 3600],
  ['month', 30 * 24 * 3600],
  ['day', 24 * 3600],
  ['hour', 3600],
  ['minute', 60],
] as const;

const relative = new Intl.RelativeTimeFormat('en', { numeric: 'auto' });

/** "3 hours ago", "yesterday", "just now". A time ahead of this clock is "just now". */
export const ago = (atMs: number, nowMs: number): string => {
  const seconds = Math.round((Math.min(atMs, nowMs) - nowMs) / 1000);
  const unit = UNITS.find(([, size]) => Math.abs(seconds) >= size);
  if (unit === undefined) return 'just now';
  const [name, size] = unit;
  return relative.format(Math.round(seconds / size), name);
};

/** "Nov 11, 2026, 8:22 PM". */
export const exactTime = (atMs: number): string =>
  new Date(atMs).toLocaleString('en', { dateStyle: 'medium', timeStyle: 'short' });

/** "8:22 PM", for a row under a day's heading. */
export const clockTime = (atMs: number): string =>
  new Date(atMs).toLocaleTimeString('en', { timeStyle: 'short' });

/** The local calendar day a time falls on, as its first millisecond: a key to group by. */
export const dayOf = (atMs: number): number => new Date(atMs).setHours(0, 0, 0, 0);

/** "Today", "Yesterday", "Monday, Nov 9", or with the year once it is not this one. */
export const dayLabel = (atMs: number, nowMs: number): string => {
  const days = Math.round((dayOf(nowMs) - dayOf(atMs)) / (24 * 3600 * 1000));
  if (days === 0) return 'Today';
  if (days === 1) return 'Yesterday';
  const isThisYear = new Date(atMs).getFullYear() === new Date(nowMs).getFullYear();
  return new Date(atMs).toLocaleDateString('en', {
    weekday: 'long',
    month: 'short',
    day: 'numeric',
    ...(isThisYear ? {} : { year: 'numeric' }),
  });
};

/** A sealed value's size as a person reads it. */
export const bytes = (count: number): string =>
  count < 1000 ? `${count} B` : `${(count / 1000).toFixed(1)} kB`;

/** "1 secret", "4 secrets". */
export const counted = (count: number, one: string, many = `${one}s`): string =>
  `${count} ${count === 1 ? one : many}`;
