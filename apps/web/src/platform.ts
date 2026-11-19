import type { Target } from './release';

// Which Mac build fits the visitor's computer, for when there is a public release to offer. Chromium browsers say so
// directly (User-Agent Client Hints). Safari and Firefox on a Mac report "Intel" in every user agent, so there the
// graphics renderer may tell; when it does not, the page suggests Apple silicon but marks it as a guess. Anything that
// is not a Mac gets no suggestion. `?platform=mac-x64` overrides it, for testing.
type Hints = { platform?: string; architecture?: string; mobile?: boolean };
type NavigatorWithHints = Navigator & {
  userAgentData?: {
    mobile: boolean;
    platform: string;
    getHighEntropyValues(keys: string[]): Promise<Hints>;
  };
};

// `sure` is false when the build is a best guess (a Mac whose chip the browser will not reveal).
export type Detected = { target: Target | null; sure: boolean };
const targets: Target[] = ['mac-arm64', 'mac-x64'];

export async function detect(): Promise<Detected> {
  const forced = new URLSearchParams(location.search).get('platform');
  if (targets.includes(forced as Target)) return { target: forced as Target, sure: true };
  const nav = navigator as NavigatorWithHints;
  const ua = navigator.userAgent;
  // iPadOS asks for desktop pages as a Mac; a touch screen gives it away.
  const mobile =
    !!nav.userAgentData?.mobile ||
    /iPhone|iPad|iPod|Android/i.test(ua) ||
    (/Macintosh/.test(ua) && navigator.maxTouchPoints > 1);
  let mac = !mobile && /Mac/.test(ua);
  let arm: boolean | null = /aarch64|arm64/i.test(ua) ? true : null;
  try {
    const hints = await nav.userAgentData?.getHighEntropyValues(['platform', 'architecture']);
    if (hints?.platform) mac = !mobile && hints.platform === 'macOS';
    if (hints?.architecture) arm = hints.architecture === 'arm';
  } catch {
    /* hints are optional */
  }
  if (!mac) return { target: null, sure: true };
  let sure = true;
  if (arm === null) {
    arm = appleGpu();
    if (arm === null) {
      arm = true; // most Macs sold since 2020 are Apple silicon
      sure = false;
    }
  }
  return { target: arm ? 'mac-arm64' : 'mac-x64', sure };
}

function appleGpu(): boolean | null {
  try {
    const gl = document.createElement('canvas').getContext('webgl');
    const info = gl?.getExtension('WEBGL_debug_renderer_info');
    const renderer = gl && info ? String(gl.getParameter(info.UNMASKED_RENDERER_WEBGL)) : '';
    // Safari reports "Apple GPU" on every Mac, Intel ones included, so only a named Apple chip counts.
    if (/Apple M\d/.test(renderer)) return true;
    if (/Intel|AMD|Radeon|NVIDIA/i.test(renderer)) return false;
  } catch {
    /* no WebGL */
  }
  return null;
}
