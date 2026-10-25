import {build} from 'esbuild';
import {mkdir,copyFile,rm} from 'node:fs/promises';
import {execFileSync} from 'node:child_process';
import {checkReleaseOAuth,oauthDefines} from './oauth-defines.mjs';
if(process.env.APLOS_RELEASE_BUILD==='1'){
  try{for(const warning of checkReleaseOAuth(process.env))console.warn(`build-main: ${warning}`);}
  catch(error){console.error(`build-main: ${error.message}`);process.exit(1);}
}
const define=oauthDefines(process.env);
await mkdir('dist/main',{recursive:true});
await build({entryPoints:['src/main/electron.ts'],outfile:'dist/main/electron.cjs',bundle:true,platform:'node',format:'cjs',target:'node22',packages:'external',sourcemap:false,define});
await build({entryPoints:['src/main/engine-host.ts'],outfile:'dist/main/engine.cjs',bundle:true,platform:'node',format:'cjs',target:'node22',packages:'external',sourcemap:false,define});
await build({entryPoints:['src/main/preload.ts'],outfile:'dist/main/preload.cjs',bundle:true,platform:'node',format:'cjs',target:'node22',external:['electron'],sourcemap:false});
await copyFile('assets/icon.png','dist/main/icon.png');

// Universal (arm64 + x86_64) so both release architectures get a working helper.
if(process.platform==='darwin'){
  await mkdir('dist/bin',{recursive:true});
  const slices=['arm64','x86_64'].map(arch=>{const out=`dist/bin/aplos-symbols-${arch}`;execFileSync('swiftc',['-O','-target',`${arch}-apple-macos12`,'native/symbols.swift','-o',out],{stdio:'inherit'});return out;});
  execFileSync('lipo',['-create',...slices,'-output','dist/bin/aplos-symbols'],{stdio:'inherit'});
  await Promise.all(slices.map(file=>rm(file)));
}
