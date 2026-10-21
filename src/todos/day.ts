/** A "day" is a local calendar day that starts at `startHour`, so 1 a.m. work belongs to the day before. */
export type Day = string;

const DAY_RE = /^\d{4}-\d{2}-\d{2}$/;

function pad(n: number): string {
  return String(n).padStart(2, '0');
}

function format(date: Date): Day {
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
}

export function isDay(value: string): value is Day {
  if (!DAY_RE.test(value)) return false;
  const [y, m, d] = value.split('-').map(Number) as [number, number, number];
  return format(new Date(y, m - 1, d, 12)) === value;
}

/** Uses the same local-time boundary as `dayRange`, so both agree across DST changes. */
export function dayOf(ts: number, startHour: number): Day {
  const local = format(new Date(ts));
  return ts < dayRange(local, startHour).start ? addDays(local, -1) : local;
}

/** [start, end) in epoch ms for a day, honouring local time zone and DST. */
export function dayRange(day: Day, startHour: number): { start: number; end: number } {
  const [y, m, d] = day.split('-').map(Number) as [number, number, number];
  const start = new Date(y, m - 1, d, startHour).getTime();
  const end = new Date(y, m - 1, d + 1, startHour).getTime();
  return { start, end };
}

export function addDays(day: Day, n: number): Day {
  const [y, m, d] = day.split('-').map(Number) as [number, number, number];
  return format(new Date(y, m - 1, d + n, 12));
}

/** Monday of the week containing `day`. */
export function weekStart(day: Day): Day {
  const [y, m, d] = day.split('-').map(Number) as [number, number, number];
  const weekday = (new Date(y, m - 1, d, 12).getDay() + 6) % 7;
  return addDays(day, -weekday);
}

export function daysBetween(from: Day, to: Day): number {
  const a = dayRange(from, 12).start;
  const b = dayRange(to, 12).start;
  return Math.round((b - a) / 86_400_000);
}
