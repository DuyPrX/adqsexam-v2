/**
 * Timezone-normalisation helpers for `<input type="datetime-local">` pickers.
 *
 * The DB stores `timestamptz` (an absolute instant, rendered as UTC by
 * PostgREST) while a `datetime-local` input works in the browser's LOCAL wall
 * clock and has no timezone component. Passing one straight into the other
 * silently shifts the instant by the teacher's UTC offset — which, in
 * Asia/Saigon (UTC+7), means an exam meant to open at 08:00 would open at 01:00.
 *
 * These two functions are the only sanctioned bridge between the two worlds:
 *   - toLocalDatetimeString : DB value (UTC ISO)  -> input value (local wall clock)
 *   - toUtcIsoString        : input value (local) -> DB value (UTC ISO)
 *
 * The round-trip is lossless only at minute precision, which is exactly what
 * `datetime-local` captures (seconds are dropped, by design).
 */

/**
 * Converts a stored ISO-8601 UTC timestamp into the `YYYY-MM-DDTHH:mm` string a
 * `datetime-local` input expects, expressed in the browser's local timezone.
 *
 * Returns `''` for null/invalid input so it can be dropped straight into
 * `value={...}` without a guard at the call site.
 */
export function toLocalDatetimeString(isoString: string | null): string {
  if (!isoString) return '';

  const date = new Date(isoString);
  if (Number.isNaN(date.getTime())) return '';

  const pad = (value: number) => String(value).padStart(2, '0');
  // getFullYear/getMonth/... are all local-time accessors, so this produces the
  // wall clock the teacher actually sees, not the UTC one.
  return (
    `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}` +
    `T${pad(date.getHours())}:${pad(date.getMinutes())}`
  );
}

/**
 * Converts a `datetime-local` value (`YYYY-MM-DDTHH:mm`) into a UTC ISO-8601
 * string for Supabase.
 *
 * `new Date('2026-10-02T08:00')` is parsed as LOCAL time (no trailing `Z`), so
 * `.toISOString()` yields the correct UTC instant — e.g. `2026-10-02T01:00:00Z`
 * for UTC+7. Returns `null` for empty/invalid input, which clears the bound.
 */
export function toUtcIsoString(localDatetimeStr: string | null): string | null {
  if (!localDatetimeStr || !localDatetimeStr.trim()) return null;

  const date = new Date(localDatetimeStr);
  if (Number.isNaN(date.getTime())) return null;

  return date.toISOString();
}

/**
 * Whole days remaining before a Trash item is purged, rounded up.
 *
 * Returns 0 once the deadline has passed. A 7-day window opened one minute ago
 * therefore reports "7 ngày" (not 6), which is what a teacher expects from a
 * "time remaining" label.
 */
export function daysUntil(isoString: string | null, now: number = Date.now()): number {
  if (!isoString) return 0;

  const target = new Date(isoString).getTime();
  if (Number.isNaN(target)) return 0;

  const remainingMs = target - now;
  if (remainingMs <= 0) return 0;
  return Math.ceil(remainingMs / 86_400_000);
}
