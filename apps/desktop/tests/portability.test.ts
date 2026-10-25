import test from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync } from 'node:fs';
import { join } from 'node:path';
import { build } from 'esbuild';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { randomUUID } from 'node:crypto';
import { runInNewContext } from 'node:vm';
import ts from 'typescript';
import { createStore } from '../src/main/store';
import { createStagedMemory } from '../src/main/memory-stage';
import { createGroq } from '../src/main/groq';
import type { createEngineService } from '../src/engine/service';

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

test('the complete engine typechecks with browser libraries and no Node globals',()=>{
  const roots=readdirSync(engine).filter(f=>f.endsWith('.ts')).map(f=>join(engine,f));
  const program=ts.createProgram(roots,{target:ts.ScriptTarget.ES2023,module:ts.ModuleKind.ESNext,moduleResolution:ts.ModuleResolutionKind.Bundler,lib:['lib.es2023.d.ts','lib.dom.d.ts','lib.dom.iterable.d.ts'],types:[],strict:true,skipLibCheck:true,noEmit:true});
  const errors=ts.getPreEmitDiagnostics(program);
  assert.equal(errors.length,0,ts.formatDiagnosticsWithColorAndContext(errors,{getCurrentDirectory:()=>process.cwd(),getCanonicalFileName:f=>f,getNewLine:()=> '\n'}));
});

test('mail orchestration runs without process, Buffer, require or Node timer handles',async()=>{
  const result=await build({entryPoints:[join(engine,'service.ts')],bundle:true,platform:'neutral',format:'iife',globalName:'AplosEngine',mainFields:['module','main'],target:'es2022',write:false,logLevel:'silent'});
  // Browser-style numeric timer IDs deliberately have no Node .unref() method.
  let sequence=0;const handles=new Map<number,ReturnType<typeof setTimeout>>();
  const schedule=(fn:()=>void,ms:number,repeat=false)=>{const id=++sequence;handles.set(id,repeat?setInterval(fn,ms):setTimeout(fn,ms));return id;};
  const clear=(id:number)=>{const handle=handles.get(id);if(handle){clearTimeout(handle);clearInterval(handle);handles.delete(id);}};
  const context={structuredClone,URL,URLSearchParams,AbortController,AbortSignal,setTimeout:(fn:()=>void,ms:number)=>schedule(fn,ms),setInterval:(fn:()=>void,ms:number)=>schedule(fn,ms,true),clearTimeout:clear,clearInterval:clear};
  const create=runInNewContext(result.outputFiles[0].text+';AplosEngine.createEngineService',context) as typeof createEngineService;
  const dataDir=await mkdtemp(join(tmpdir(),'aplos-portable-service-'));
  const store=createStore(dataDir);
  let service:Awaited<ReturnType<typeof createEngineService>>|undefined;
  try{
    service=await create({store,staged:createStagedMemory(store.memory),providers:{},groq:createGroq({apiKey:''}),secure:false,randomUUID,autoSyncMs:0,demo:true});
    const initial=await service.invoke('state.get');assert.equal(initial.threads.length,18);
    assert.equal(runInNewContext('typeof process+","+typeof Buffer+","+typeof require',context),'undefined,undefined,undefined');
    await service.invoke('thread.update',{ids:['garden'],patch:{status:'later',todo:'Portable orchestration'}});
    assert.equal((await service.invoke('state.get')).threads.find((t:{id:string})=>t.id==='garden').todo,'Portable orchestration');
    await service.invoke('thread.undo');assert.equal((await service.invoke('state.get')).threads.find((t:{id:string})=>t.id==='garden').status,'new');
    const attachment=await service.invoke('attachment.get',{threadId:'garden',attachmentId:'att-notes'});assert.match(Buffer.from(attachment.data,'base64').toString(),/Community garden/);
    assert.ok((await service.invoke('search',{query:'gard has:attachment'})).some((t:{id:string})=>t.id==='garden'));
    const saved=await service.invoke('draft.save',{draft:{id:'portable-draft',accountId:'work',to:'reader@verification.example',cc:'',bcc:'',subject:'Portable send',html:'<p>Local portable engine check.</p>',attachments:[{name:'original.txt',type:'text/plain',data:'SGVsbG8='}],mode:'new',signature:false,revision:0}});
    assert.equal(saved.attachments[0].size,5);assert.ok(saved.attachments[0].id);
    await service.invoke('settings.update',{patch:{undoSeconds:0}});await service.invoke('draft.send',{id:saved.id});
    for(let i=0;i<100&&(await service.invoke('state.get')).drafts.some((d:{id:string})=>d.id===saved.id);i++)await new Promise(r=>setTimeout(r,10));
    assert.ok((await service.invoke('state.get')).threads.some((t:{subject:string})=>t.subject==='Portable send'));
    await assert.rejects(service.invoke('workflow.enable'),/unavailable/);
  }finally{if(service)await service.close();else store.close();for(const id of handles.keys())clear(id);await rm(dataDir,{recursive:true,force:true});}
});
