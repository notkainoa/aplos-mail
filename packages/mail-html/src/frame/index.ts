// The sealed frame's building blocks (ARCH 10, html-4): token registry, render cache, headers,
// the reporter script and the `Mail/serve` response builder. Pure: no DOM, no Node.

export {
  FRAME_ORIGIN,
  frameUrl,
  isToken,
  parseFramePath,
  parseFrameUrl,
  tokenOf,
  type FrameRoute,
  type FrameTarget,
} from './paths';
export {
  FrameTokens,
  MAX_TOKENS_PER_WINDOW,
  UNFETCHED_TTL_MS,
  type FrameImagePolicy,
  type FrameRecord,
  type FrameRenderInput,
  type FrameTokensOptions,
  type IssuedFrame,
} from './tokens';
export { Lru, RENDER_CACHE_SIZE, renderKey, type RenderKeyParts } from './lru';
export {
  RASTER_TYPES,
  frameCsp,
  frameHeaders,
  isRasterType,
  notFound,
  resourceHeaders,
  type FrameHeaders,
  type RasterType,
  type ServeResponse,
} from './headers';
export { REPORTER_SOURCE, reporterHash, reporterTag, withReporter } from './reporter';
export { sniffRaster } from './sniff';
export { serveFrame, type ServeDeps, type ServeRequest, type ServedBytes } from './serve';
