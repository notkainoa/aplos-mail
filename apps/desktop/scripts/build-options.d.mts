export function releaseBuild(env: Record<string, string | undefined>): boolean;
export function syntaxOptions(env: Record<string, string | undefined>): { minifySyntax?: true };
export const RELEASE_BANNER: string;
export function bannerOptions(env: Record<string, string | undefined>): { banner?: { js: string } };
export function isReleaseBundle(source: unknown): boolean;
