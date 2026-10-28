import assert from 'node:assert/strict';
import {createHash,randomBytes} from 'node:crypto';
import {mkdtemp,rm,writeFile,readFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {test} from 'node:test';
// @ts-expect-error plain ESM script without types
import {verifyDirectory,expectedAssets} from '../../scripts/verify-draft.mjs';

const VERSION='9.8.7';
type Result={ok:boolean;message:string;info?:boolean};
const names=(arch:string,ext:string)=>`Aplos-Mail-${VERSION}-${arch}.${ext}`;

/** An honest release: random bytes for each file, a matching latest-mac.yml, zip blockmaps only. */
async function makeDraft(mutate?:(dir:string)=>Promise<void>){
  const dir=await mkdtemp(join(tmpdir(),'verify-draft-test-'));
  const sums:Record<string,{sha512:string;size:number}>={};
  for(const arch of ['arm64','x64'])for(const ext of ['dmg','zip']){
    const bytes=randomBytes(2048+arch.length*ext.length);
    await writeFile(join(dir,names(arch,ext)),bytes);
    sums[names(arch,ext)]={sha512:createHash('sha512').update(bytes).digest('base64'),size:bytes.length};
  }
  for(const arch of ['arm64','x64'])await writeFile(join(dir,names(arch,'zip')+'.blockmap'),randomBytes(64));
  const z=[names('x64','zip'),names('arm64','zip')];
  const yml=`version: ${VERSION}\nfiles:\n`+z.map(f=>`  - url: ${f}\n    sha512: ${sums[f].sha512}\n    size: ${sums[f].size}\n`).join('')+`path: ${z[0]}\nsha512: ${sums[z[0]].sha512}\nreleaseDate: '2026-10-27T00:00:00.000Z'\n`;
  await writeFile(join(dir,'latest-mac.yml'),yml);
  await mutate?.(dir);
  return dir;
}
const failures=(r:Result[])=>r.filter(x=>!x.ok).map(x=>x.message);
async function run(mutate?:(dir:string)=>Promise<void>,version=VERSION){
  const dir=await makeDraft(mutate);
  try{return failures(await verifyDirectory(dir,version));}finally{await rm(dir,{recursive:true,force:true});}
}

test('expected set comes from the config: no DMG blockmaps because writeUpdateInfo is false',()=>{
  const want=expectedAssets(VERSION);
  assert.deepEqual(want.dmgs.sort(),[names('arm64','dmg'),names('x64','dmg')]);
  assert.deepEqual(want.blockmaps.sort(),[names('arm64','zip')+'.blockmap',names('x64','zip')+'.blockmap']);
});

test('an honest set passes',async()=>{assert.deepEqual(await run(),[]);});

test('a tampered sha512 fails',async()=>{
  const f=await run(async dir=>{
    const p=join(dir,'latest-mac.yml');
    const text=await readFile(p,'utf8');
    await writeFile(p,text.replace(/sha512: (\S{4})/,(_m,a)=>'sha512: '+(a==='AAAA'?'BBBB':'AAAA')));
  });
  assert.ok(f.some(m=>m.includes('sha512 mismatch')),f.join('\n'));
});

test('a changed file on disk fails sha512 and size',async()=>{
  const f=await run(dir=>writeFile(join(dir,names('arm64','zip')),randomBytes(100)));
  assert.ok(f.some(m=>m.includes('sha512 mismatch')));
  assert.ok(f.some(m=>m.includes('size mismatch')));
});

test('a wrong version fails',async()=>{
  const f=await run(undefined,'9.8.8');
  assert.ok(f.some(m=>m.includes('version is 9.8.7, expected 9.8.8')),f.join('\n'));
});

test('a missing blockmap fails',async()=>{
  const f=await run(dir=>rm(join(dir,names('x64','zip')+'.blockmap')));
  assert.ok(f.some(m=>m==='missing '+names('x64','zip')+'.blockmap'),f.join('\n'));
});

test('an extra unlisted file fails',async()=>{
  const f=await run(dir=>writeFile(join(dir,'notes.txt'),'hi'));
  assert.ok(f.some(m=>m.includes('unexpected file notes.txt')),f.join('\n'));
});

test('a file listed in the YAML but missing fails',async()=>{
  const f=await run(dir=>rm(join(dir,names('arm64','zip'))));
  assert.ok(f.some(m=>m.includes('lists '+names('arm64','zip')+' but the file is missing')),f.join('\n'));
});

test('a zip that the YAML does not list fails',async()=>{
  const f=await run(async dir=>{
    const p=join(dir,'latest-mac.yml');
    const lines=(await readFile(p,'utf8')).split('\n');
    const at=lines.findIndex(l=>l.includes('url: '+names('arm64','zip')));
    lines.splice(at,3);
    await writeFile(p,lines.join('\n'));
  });
  assert.ok(f.some(m=>m.includes('does not list it')),f.join('\n'));
});

test('a missing latest-mac.yml fails',async()=>{
  const f=await run(dir=>rm(join(dir,'latest-mac.yml')));
  assert.ok(f.some(m=>m==='missing latest-mac.yml'));
});

test('DMG blockmaps are expected if the config writes update info',async()=>{
  const build={artifactName:'Aplos-Mail-${version}-${arch}.${ext}',mac:{target:[{target:'dmg',arch:['arm64']},{target:'zip',arch:['arm64']}]},dmg:{writeUpdateInfo:true}};
  const want=expectedAssets(VERSION,build);
  assert.deepEqual(want.blockmaps.sort(),[names('arm64','dmg')+'.blockmap',names('arm64','zip')+'.blockmap']);
});
