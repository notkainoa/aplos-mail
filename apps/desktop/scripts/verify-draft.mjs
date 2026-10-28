#!/usr/bin/env node
// Verify a release draft: expected files, latest-mac.yml version, and every listed SHA-512 and size.
// Usage: node scripts/verify-draft.mjs <dir-or-tag> [--repo notkainoa/aplos-mail] [--version x.y.z]
//   A directory is checked as it is. A tag (v0.2.3) is downloaded read-only with `gh release download`
//   into a temp directory that is deleted afterwards.
// The expected file set comes from build.* in apps/desktop/package.json, see expectedAssets().
import {createHash} from 'node:crypto';
import {createReadStream,existsSync,readFileSync,statSync} from 'node:fs';
import {mkdtemp,readdir,rm,stat} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {basename,join,resolve} from 'node:path';
import {fileURLToPath} from 'node:url';
import {execFileSync} from 'node:child_process';
import yaml from 'js-yaml';

const scriptDir=fileURLToPath(new URL('.',import.meta.url));
const DEFAULT_REPO='notkainoa/aplos-mail';

export function loadBuildConfig(){
  return JSON.parse(readFileSync(join(scriptDir,'..','package.json'),'utf8')).build;
}

/**
 * Derive the files a draft must hold from the electron-builder config.
 * zip targets always get a .blockmap (the differential updater needs it). A dmg only gets one when
 * dmg.writeUpdateInfo is not false; this app sets it to false, so DMG blockmaps are NOT expected.
 * Returns {dmgs, zips, blockmaps, feed, listed}: `listed` are the files latest-mac.yml must contain
 * (the updater payloads, i.e. the zips; DMGs are installed by hand and are not in the feed).
 */
export function expectedAssets(version,build=loadBuildConfig()){
  const pattern=build.artifactName||'${name}-${version}-${arch}.${ext}';
  const name=(arch,ext)=>pattern.replace('${version}',version).replace('${arch}',arch).replace('${ext}',ext).replace('${productName}',build.productName||'').replace('${name}',build.productName||'');
  const out={dmgs:[],zips:[],blockmaps:[],feed:'latest-mac.yml'};
  for(const entry of build.mac?.target??[]){
    const target=typeof entry==='string'?entry:entry.target;
    const arches=typeof entry==='string'?['x64','arm64']:entry.arch??['x64','arm64'];
    for(const arch of arches){
      const file=name(arch,target);
      if(target==='dmg'){out.dmgs.push(file);if(build.dmg?.writeUpdateInfo!==false)out.blockmaps.push(file+'.blockmap');}
      else if(target==='zip'){out.zips.push(file);out.blockmaps.push(file+'.blockmap');}
    }
  }
  out.listed=[...out.zips];
  return out;
}

async function sha512(file){
  const hash=createHash('sha512');
  for await(const chunk of createReadStream(file))hash.update(chunk);
  return hash.digest('base64');
}
async function sha256(file){
  const hash=createHash('sha256');
  for await(const chunk of createReadStream(file))hash.update(chunk);
  return hash.digest('hex');
}

/** Check a directory. Returns [{ok:boolean,message:string}] and never throws for a bad draft. */
export async function verifyDirectory(dir,version,build=loadBuildConfig()){
  const results=[];
  const pass=message=>results.push({ok:true,message});
  const fail=message=>results.push({ok:false,message});
  const info=message=>results.push({ok:true,info:true,message});
  const want=expectedAssets(version,build);
  const present=new Set(await readdir(dir));

  const required=[...want.dmgs,...want.zips,...want.blockmaps,want.feed];
  for(const file of required)present.has(file)?pass('present '+file):fail('missing '+file);
  for(const file of present){
    if(!required.includes(file))fail('unexpected file '+file+' (not part of the expected release set)');
  }
  if(!want.dmgs.some(f=>want.blockmaps.includes(f+'.blockmap')))info('no DMG blockmaps expected: build.dmg.writeUpdateInfo is false');

  if(!present.has(want.feed))return results;
  let feed;
  try{feed=yaml.load(readFileSync(join(dir,want.feed),'utf8'));}
  catch(error){fail(want.feed+' is not valid YAML: '+error.message);return results;}
  if(!feed||typeof feed!=='object'){fail(want.feed+' is empty or not a mapping');return results;}

  String(feed.version)===version?pass(`${want.feed} version is ${version}`):fail(`${want.feed} version is ${feed.version}, expected ${version}`);

  const entries=Array.isArray(feed.files)?feed.files:[];
  const listed=new Map();
  for(const entry of entries){
    const url=entry?.url;
    if(typeof url!=='string'){fail('a files[] entry in '+want.feed+' has no url');continue;}
    listed.set(url,entry);
  }
  for(const [url,entry] of listed){
    if(!present.has(url)){fail(`${want.feed} lists ${url} but the file is missing`);continue;}
    const file=join(dir,url);
    const size=statSync(file).size;
    size===Number(entry.size)?pass(`size ok ${url} (${size})`):fail(`size mismatch ${url}: file ${size}, yaml ${entry.size}`);
    const actual=await sha512(file);
    actual===entry.sha512?pass(`sha512 ok ${url}`):fail(`sha512 mismatch ${url}: file ${actual.slice(0,16)}..., yaml ${String(entry.sha512).slice(0,16)}...`);
  }
  for(const file of want.listed)if(!listed.has(file))fail(`${file} is in the release but ${want.feed} does not list it`);
  for(const file of present){
    if(required.includes(file)&&!want.listed.includes(file)&&!listed.has(file)&&file!==want.feed&&!file.endsWith('.blockmap'))
      info(`${file} is not in ${want.feed}; expected, DMGs are installed by hand (verify with the SHA-256 below)`);
  }
  // Top-level path/sha512 are what older updaters read; they must agree with the matching entry.
  if(feed.path!==undefined){
    const top=listed.get(feed.path);
    if(!top)fail(`${want.feed} path ${feed.path} is not in files[]`);
    else top.sha512===feed.sha512?pass('top-level path and sha512 agree with files[]'):fail('top-level sha512 differs from the files[] entry for '+feed.path);
  }
  for(const file of [...want.dmgs,...want.zips])if(present.has(file))info(`sha256 ${await sha256(join(dir,file))}  ${file}`);
  return results;
}

function parseArgs(argv){
  const args={repo:DEFAULT_REPO,version:undefined,target:undefined};
  for(let i=0;i<argv.length;i++){
    const a=argv[i];
    if(a==='--repo')args.repo=argv[++i];
    else if(a==='--version')args.version=argv[++i];
    else if(a.startsWith('--'))throw new Error('Unknown option '+a);
    else if(!args.target)args.target=a;
    else throw new Error('Unexpected argument '+a);
  }
  return args;
}

async function main(){
  let args;
  try{args=parseArgs(process.argv.slice(2));if(!args.target)throw new Error('missing <dir-or-tag>');}
  catch(error){console.error(error.message+'\nUsage: verify-draft.mjs <dir-or-tag> [--repo owner/name] [--version x.y.z]');process.exit(2);}

  const isDir=existsSync(args.target)&&statSync(args.target).isDirectory();
  let version=args.version;
  let dir=resolve(args.target);
  let temp;
  if(!isDir){
    if(!/^v\d/.test(args.target)){console.error(`${args.target} is neither a directory nor a version tag like v0.2.3`);process.exit(2);}
    version??=args.target.slice(1);
    temp=await mkdtemp(join(tmpdir(),'aplos-draft-'));
    dir=temp;
    try{execFileSync('gh',['release','download',args.target,'--repo',args.repo,'--dir',dir],{stdio:['ignore','inherit','inherit']});}
    catch{console.error('FAIL could not download '+args.target+' from '+args.repo);await rm(temp,{recursive:true,force:true});process.exit(1);}
  }
  if(!version){console.error('--version is required when checking a directory');process.exit(2);}
  let results;
  try{results=await verifyDirectory(dir,version);}
  finally{if(temp)await rm(temp,{recursive:true,force:true});}
  for(const r of results)console.log((r.info?'INFO ':r.ok?'PASS ':'FAIL ')+r.message);
  const failed=results.filter(r=>!r.ok).length;
  console.log(failed?`FAIL ${failed} check(s) failed for ${version}`:`PASS draft ${version} verified`);
  process.exit(failed?1:0);
}

if(process.argv[1]&&resolve(process.argv[1])===fileURLToPath(import.meta.url))await main();
