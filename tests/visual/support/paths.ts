import { join, resolve } from 'node:path';

/** The gallery's own port, apart from the e2e preview (4417) and the dev server (5173). */
export const galleryPort = Number(process.env.APLOS_VISUAL_PORT) || 4427;
export const galleryOrigin = `http://127.0.0.1:${galleryPort}`;

export const repoRoot = resolve(import.meta.dirname, '..', '..', '..');
/** Shots, overlays and the JSON report of a run. Git ignores `artifacts/`. */
export const visualDir = join(repoRoot, 'artifacts', 'visual');
