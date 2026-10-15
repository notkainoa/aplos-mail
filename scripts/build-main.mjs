import {build} from 'esbuild';
import {mkdir,copyFile} from 'node:fs/promises';
await mkdir('dist/main',{recursive:true});
await build({entryPoints:['src/main/electron.ts'],outfile:'dist/main/electron.cjs',bundle:true,platform:'node',format:'cjs',target:'node22',packages:'external',sourcemap:false});
await build({entryPoints:['src/main/preload.ts'],outfile:'dist/main/preload.cjs',bundle:true,platform:'node',format:'cjs',target:'node22',external:['electron'],sourcemap:false});
await copyFile('assets/icon.png','dist/main/icon.png');

for(const variant of ['ink','sage','clay'])await copyFile(`assets/icon-${variant}.png`,`dist/main/icon-${variant}.png`);
