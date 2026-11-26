import { createServer } from 'vite';
import { loadDevEnv } from './env';

// The browser preview: the renderer on Vite, which runs on the in-process stand-in engine in a development build.
// `.env` loads first so vite.config sees APLOS_VITE_PORT.
loadDevEnv();
const vite = await createServer();
await vite.listen();
vite.printUrls();
