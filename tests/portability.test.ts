import test from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync } from 'node:fs';
import { join } from 'node:path';
import { build } from 'esbuild';

const engine=join(import.meta.dirname,'..','src','engine');

test('the engine bundles for a platform without Node, so a mobile app can reuse it',async()=>{
  const files=readdirSync(engine).filter(f=>f.endsWith('.ts'));
  const result=await build({
    stdin:{contents:files.map(f=>`export * from './${f.replace(/\.ts$/,'')}';`).join('\n'),resolveDir:engine,loader:'ts'},
    bundle:true,platform:'neutral',format:'esm',mainFields:['module','main'],target:'es2022',write:false,metafile:true,logLevel:'silent',
  });
  const imports=Object.values(result.metafile.inputs).flatMap(input=>input.imports.map(i=>i.path));
  assert.deepEqual(imports.filter(path=>path.startsWith('node:')||/^(fs|path|crypto|os|net|tls|http|https|child_process|electron)$/.test(path)),[],'no Node or Electron modules');
  const code=result.outputFiles[0].text;
  assert.doesNotMatch(code,/\brequire\(/,'no CommonJS requires left for a runtime to resolve');
  assert.ok(code.length<400_000,`engine bundle stays small (${code.length} bytes)`);
});
