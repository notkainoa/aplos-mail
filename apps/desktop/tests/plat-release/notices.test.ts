import assert from 'node:assert/strict';
import {execFileSync} from 'node:child_process';
import {mkdirSync,mkdtempSync,rmSync,writeFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join,resolve} from 'node:path';
import {test} from 'node:test';
// @ts-expect-error plain ESM script without types
import {collectPackages,renderNotices,checkNotices} from '../../scripts/notices.mjs';

const desktop=resolve(import.meta.dirname,'../..');
const repoRoot=resolve(desktop,'../..');

function fakePackage(root:string,name:string,pkg:object,files:Record<string,string>={}){
  const dir=join(root,'node_modules',name);
  mkdirSync(dir,{recursive:true});
  writeFileSync(join(dir,'package.json'),JSON.stringify({name,version:'1.0.0',...pkg}));
  for(const [file,text] of Object.entries(files))writeFileSync(join(dir,file),text);
}

test('every package in npm ls --omit=dev appears in the generated notices',()=>{
  const {packages}=collectPackages(desktop);
  const text=renderNotices(packages,{});
  const tree=JSON.parse(execFileSync('npm',['ls','--omit=dev','--all','--json','-w','@aplos/desktop'],{cwd:repoRoot,encoding:'utf8',maxBuffer:64*1024*1024,stdio:['ignore','pipe','ignore']}));
  const expected=new Set<string>();
  const walk=(deps:Record<string,{version?:string;dependencies?:object}>|undefined)=>{
    for(const [name,node] of Object.entries(deps??{})){
      if(node.version&&name!=='@aplos/desktop')expected.add(`${name}@${node.version}`);
      walk(node.dependencies as never);
    }
  };
  walk(tree.dependencies);
  assert.ok(expected.size>20,'npm ls returned a suspiciously small tree');
  const absent=[...expected].filter(id=>!text.includes(`Package: ${id}\n`));
  assert.deepEqual(absent,[]);
  assert.deepEqual(checkNotices(text,packages),{absent:[],unlicensed:[]});
});

test('output is sorted and deterministic',()=>{
  const {packages}=collectPackages(desktop);
  const ids=packages.map((p:{name:string;version:string})=>`${p.name}@${p.version}`);
  assert.deepEqual(ids,[...ids].sort((x:string,y:string)=>x<y?-1:x>y?1:0).sort((x:string,y:string)=>{const nx=x.slice(0,x.lastIndexOf('@')),ny=y.slice(0,y.lastIndexOf('@'));return nx<ny?-1:nx>ny?1:0;}));
  assert.ok(renderNotices(packages,{})===renderNotices(collectPackages(desktop).packages,{}));
});

test('a fake tree: unlicensed package is flagged, identical license text is printed once',()=>{
  const root=mkdtempSync(join(tmpdir(),'notices-test-'));
  try{
    writeFileSync(join(root,'package.json'),JSON.stringify({name:'fake',version:'0.0.0',dependencies:{good:'1',twin:'1',bare:'1'},devDependencies:{devonly:'1'}}));
    fakePackage(root,'good',{license:'MIT',repository:{url:'git+https://example.test/good.git'},dependencies:{nested:'1'}},{LICENSE:'MIT text\r\n'});
    fakePackage(root,'nested',{license:'ISC'},{'LICENSE.md':'MIT text'});
    fakePackage(root,'twin',{license:'MIT'},{LICENCE:'MIT text',NOTICE:'A notice'});
    fakePackage(root,'bare',{});
    fakePackage(root,'devonly',{license:'MIT'});
    const {packages,missing}=collectPackages(root);
    assert.deepEqual(packages.map((p:{name:string})=>p.name),['bare','good','nested','twin']);
    assert.deepEqual(missing,[]);
    const text=renderNotices(packages,{});
    assert.equal(text.split('MIT text').length-1,1);
    assert.ok(text.includes('A notice'));
    assert.ok(!text.includes('devonly'));
    assert.ok(text.includes('Repository: https://example.test/good.git'));
    assert.deepEqual(checkNotices(text,packages),{absent:[],unlicensed:['bare@1.0.0']});
    assert.deepEqual(checkNotices(text.replace('Package: twin@1.0.0','Package: x'),packages).absent,['twin@1.0.0']);
    // The CLI exits 1 in --check mode and names the offender.
    const out=join(root,'notices.txt');
    execFileSync(process.execPath,[join(desktop,'scripts/notices.mjs'),'--root',root,'--out',out]);
    let failure:{status?:number;stderr?:Buffer}={};
    try{execFileSync(process.execPath,[join(desktop,'scripts/notices.mjs'),'--root',root,'--out',out,'--check'],{stdio:'pipe'});}catch(error){failure=error as typeof failure;}
    assert.equal(failure.status,1);
    assert.match(String(failure.stderr),/no license field: bare@1.0.0/);
  }finally{rmSync(root,{recursive:true,force:true});}
});

test('a declared dependency that is not installed is reported',()=>{
  const root=mkdtempSync(join(tmpdir(),'notices-test-'));
  try{
    writeFileSync(join(root,'package.json'),JSON.stringify({name:'fake',version:'0.0.0',dependencies:{ghost:'1'}}));
    assert.deepEqual(collectPackages(root).missing,['ghost']);
  }finally{rmSync(root,{recursive:true,force:true});}
});
