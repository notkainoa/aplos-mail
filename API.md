# Engine contract

The renderer, main and the engine share contract v1 in `packages/contract`: each method's zod schemas are in `src/api/` and the method registry in `src/registry/`. `npm run generate -w @aplos/contract` writes the method tables (`generated/methods.generated.ts`) and `generated/openapi.json`. A failed method rejects with a contract error (`src/contract-error.ts`); secrets never appear in results or errors.

The renderer calls engine methods over `window.aplosEngine`: main gives each window's main frame its own MessagePort to the engine's utility process (`apps/desktop/src/host/transports/port.ts`). Main answers the desktop methods itself (`Window/*`, `System/*`, `Update/*`, `File/*`, `Shell/open`, `App/info`, `Engine/*`, `Diagnostics/copy`) in `apps/desktop/src/main/engine-real.ts`, through the handler table in `src/shared/desktop-v1.ts`.

`window.aplos` (`src/main/preload.ts`, `src/shared/native-bridge.ts`) carries only main's native handlers, by their handler names, and main's events: `prepare-close` (answered with `window.closeReady` or `window.closeCancel`), menu commands, `navigate`, update status, fullscreen and the sealed mail frame's keys.
