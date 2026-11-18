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
  Temporal.Instant.fromEpochMilliseconds(atMs).toLocaleString('en', {
    dateStyle: 'medium',
    timeStyle: 'short',
  });

/** "8:22 PM", for a row under a day's heading. */
export const clockTime = (atMs: number): string =>
  Temporal.Instant.fromEpochMilliseconds(atMs).toLocaleString('en', { timeStyle: 'short' });

/** The local calendar day a time falls on, as its first millisecond: a key to group by. */
export const dayOf = (atMs: number): number =>
  Temporal.Instant.fromEpochMilliseconds(atMs)
    .toZonedDateTimeISO(Temporal.Now.timeZoneId())
    .startOfDay().epochMilliseconds;

/** "Today", "Yesterday", "Monday, Nov 9", or with the year once it is not this one. */
export const dayLabel = (atMs: number, nowMs: number): string => {
  const timeZone = Temporal.Now.timeZoneId();
  const day = Temporal.Instant.fromEpochMilliseconds(atMs)
    .toZonedDateTimeISO(timeZone)
    .toPlainDate();
  const today = Temporal.Instant.fromEpochMilliseconds(nowMs)
    .toZonedDateTimeISO(timeZone)
    .toPlainDate();
  const days = day.until(today).days;
  if (days === 0) return 'Today';
  if (days === 1) return 'Yesterday';
  const isThisYear = day.year === today.year;
  return day.toLocaleString('en', {
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

export const MINUTE_MS = 60_000;
const HOUR_MS = 60 * MINUTE_MS;
export const DAY_MS = 24 * HOUR_MS;

/** "never expires", "expires in 12 days", "expires in 5 hours", "expires in 14 minutes", "expired". */
export const expiryWords = (expiresAt: number | null, nowMs: number): string => {
  if (expiresAt === null) return 'never expires';
  const left = expiresAt - nowMs;
  if (left <= 0) return 'expired';
  const minutes = Math.max(1, Math.round(left / 60_000));
  if (minutes < 60) return `expires in ${counted(minutes, 'minute')}`;
  const hours = Math.round(left / HOUR_MS);
  if (hours < 24) return `expires in ${counted(hours, 'hour')}`;
  return `expires in ${counted(Math.round(left / DAY_MS), 'day')}`;
};

/** A length of time in its largest whole unit: "15 minutes", "1 hour", "30 days". */
export const durationWords = (ms: number): string => {
  if (ms % DAY_MS === 0) return counted(ms / DAY_MS, 'day');
  if (ms % HOUR_MS === 0) return counted(ms / HOUR_MS, 'hour');
  return counted(Math.round(ms / 60_000), 'minute');
};

/** "Dec 1, 2026", for a day the owner picks or reads. */
export const exactDay = (atMs: number): string =>
  Temporal.Instant.fromEpochMilliseconds(atMs).toLocaleString('en', { dateStyle: 'medium' });

/** "removed for good in 27 days", in the largest whole unit left: what a Bin item says of its end. */
export const removedForGoodWords = (atMs: number, nowMs: number): string => {
  const left = Math.max(atMs - nowMs, MINUTE_MS);
  if (left >= DAY_MS) return `removed for good in ${counted(Math.round(left / DAY_MS), 'day')}`;
  if (left >= HOUR_MS) return `removed for good in ${counted(Math.round(left / HOUR_MS), 'hour')}`;
  return `removed for good in ${counted(Math.round(left / MINUTE_MS), 'minute')}`;
};
