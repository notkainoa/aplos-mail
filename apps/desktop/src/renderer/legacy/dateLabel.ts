// Pure date wording shared by list rows and the reader; kept free of DOM so it can be tested in Node.
const startOfDay = (d: Date) => new Date(d.getFullYear(), d.getMonth(), d.getDate());

/**
 * "10:00 AM" today, "Yesterday", "Friday" within the last six days (Tomorrow/weekday ahead for future dates),
 * otherwise "Oct 14", or "Oct 14, 2025" in another year. `withTime` adds the time to every label but today's.
 */
export function dateLabel(date: string, withTime = false, now = new Date()) {
  const d = new Date(date);
  if (Number.isNaN(+d)) return '';
  const time = d.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
  // Rounding absorbs the 23- and 25-hour days around daylight-saving changes.
  const days = Math.round((+startOfDay(now) - +startOfDay(d)) / 86400000);
  if (days === 0) return time;
  const at = (label: string) => (withTime ? `${label} ${time}` : label);
  if (days === 1) return at('Yesterday');
  if (days === -1) return at('Tomorrow');
  // A week back is the same weekday as today, so only the six days in between get a name.
  if (Math.abs(days) < 7) return at(d.toLocaleDateString([], { weekday: 'long' }));
  const day = d.toLocaleDateString([], {
    month: 'short',
    day: 'numeric',
    ...(d.getFullYear() === now.getFullYear() ? {} : { year: 'numeric' }),
  });
  return withTime ? `${day}, ${time}` : day;
}

/** "Friday, October 16, 2026 at 10:00 AM" for places with room for the whole date. */
export function fullDate(date: string) {
  const d = new Date(date);
  if (Number.isNaN(+d)) return '';
  return d.toLocaleString([], {
    weekday: 'long',
    month: 'long',
    day: 'numeric',
    year: 'numeric',
    hour: 'numeric',
    minute: '2-digit',
  });
}
