/**
 * US equity market session clock — America/New_York, weekdays 09:30–16:00 ET.
 * Holidays are intentionally ignored in the prototype.
 */

export type MarketStatus = 'open' | 'closed';

const fmt = new Intl.DateTimeFormat('en-US', {
  timeZone: 'America/New_York',
  weekday: 'short',
  hour: '2-digit',
  minute: '2-digit',
  hour12: false,
});

export function nyParts(now: Date = new Date()): { weekday: string; minutes: number } {
  const parts = fmt.formatToParts(now);
  const get = (t: string) => parts.find((p) => p.type === t)?.value ?? '';
  const hour = Number(get('hour')) % 24;
  const minute = Number(get('minute'));
  return { weekday: get('weekday'), minutes: hour * 60 + minute };
}

export function usMarketStatus(now: Date = new Date()): MarketStatus {
  const { weekday, minutes } = nyParts(now);
  const weekend = weekday === 'Sat' || weekday === 'Sun';
  if (weekend) return 'closed';
  const open = 9 * 60 + 30;
  const close = 16 * 60;
  return minutes >= open && minutes < close ? 'open' : 'closed';
}

/** Minutes until the next session transition (for a humane subtitle). */
export function minutesToNextTransition(now: Date = new Date()): number {
  const { weekday, minutes } = nyParts(now);
  const open = 9 * 60 + 30;
  const close = 16 * 60;
  const weekend = weekday === 'Sat' || weekday === 'Sun';
  if (!weekend && minutes >= open && minutes < close) return close - minutes;
  if (!weekend && minutes < open) return open - minutes;
  // after close or weekend: next weekday open
  const daysAhead = weekday === 'Fri' ? 3 : weekday === 'Sat' ? 2 : 1;
  return daysAhead * 24 * 60 - minutes + open;
}

export function fmtDuration(mins: number): string {
  if (mins < 60) return `${mins}m`;
  const h = Math.floor(mins / 60);
  const m = mins % 60;
  if (h < 24) return m ? `${h}h ${m}m` : `${h}h`;
  const d = Math.floor(h / 24);
  return `${d}d ${h % 24}h`;
}
