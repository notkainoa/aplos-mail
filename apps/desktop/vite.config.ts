import { defineConfig } from 'vite';
import { fileURLToPath } from 'node:url';
// Development ports can move (APLOS_VITE_PORT / APLOS_API_PORT) so several checkouts preview side by side; the CSP follows them.
const vitePort=Number(process.env.APLOS_VITE_PORT)||5173,apiPort=Number(process.env.VITE_APLOS_API_PORT||process.env.APLOS_API_PORT)||4317;
// The workspace packages are TypeScript source; the alias matches the tsconfig paths.
const packages=fileURLToPath(new URL('../../packages/',import.meta.url));
export default defineConfig({base:'./',resolve:{alias:[{find:/^@aplos\/(engine|contract)\//,replacement:`${packages}$1/src/`}]},server:{host:'127.0.0.1',port:vitePort,strictPort:true,watch:{ignored:['**/release/**','**/dist/**','**/artifacts/**']}},build:{outDir:'dist/renderer'},
  plugins:[{name:'aplos-dev-ports',apply:'serve',transformIndexHtml:html=>html.replace('http://127.0.0.1:5173 ws://127.0.0.1:5173 http://127.0.0.1:4317',`http://127.0.0.1:${vitePort} ws://127.0.0.1:${vitePort} http://127.0.0.1:${apiPort}`)}]});
