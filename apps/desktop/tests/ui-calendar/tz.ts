// Imported first by the ui-calendar tests: the harness's zone, before any fixture computes a local time.
process.env.TZ = 'America/Los_Angeles';
export const HARNESS_TZ = process.env.TZ;
