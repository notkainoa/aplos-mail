/**
 * Pins the zone the Calendar tests were written in. Import it FIRST in every calendar test file (ES imports run in
 * order, and node re-reads `process.env.TZ` on assignment), so a plain `npm test` gives the same wall clocks and the
 * same Nov 1 2026 fall-back as `TZ=America/Los_Angeles`.
 */
process.env.TZ = 'America/Los_Angeles';
