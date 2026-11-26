import { createServer } from 'vite';

// The browser preview: the renderer on Vite, which runs on the in-process stand-in engine in a development build.
const vite = await createServer();
await vite.listen();
vite.printUrls();
