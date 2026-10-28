// Checks that a built Aplos Mail .app is hardened the way plan 40 Q2 expects: fuses, Info.plist,
// signature and notarization, entitlements, designated requirement, no secrets in app.asar, and the
// aplos-symbols helper. Prints one PASS/FAIL/SKIP row per check and exits 1 on any FAIL.
//
// Usage: node scripts/verify-hardening.mjs <path-to-.app> [--expect release|adhoc] [--json] [--launch-checks]
//   --expect adhoc   a source build: skips notarization, stapling and the team checks, uses entitlements.adhoc.plist
//   --launch-checks  also starts the app with hostile flags (debug ports, ELECTRON_RUN_AS_NODE, NODE_OPTIONS).
//                    Off by default because it launches the real app, which shows a window today.
//
// A matched secret is never printed: rows name the file, the byte offset and a redacted marker.
import {spawn as nodeSpawn,spawnSync} from 'node:child_process';
import {createHash} from 'node:crypto';
import {accessSync,constants as fsConstants,existsSync,mkdtempSync,rmSync} from 'node:fs';
import {createRequire} from 'node:module';
import {tmpdir} from 'node:os';
import {basename,dirname,join,resolve} from 'node:path';
import {fileURLToPath} from 'node:url';

const require=createRequire(import.meta.url);
const here=dirname(fileURLToPath(import.meta.url));

export const BUNDLE_ID='com.aplos.mail';
export const TEAM_ID='VW9NDM428H';
/** The only bundle allowed to carry the Google client secret (scripts/build-main.mjs inlines it there). */
export const ENGINE_BUNDLE='dist/main/engine.cjs';
export const ENTITLEMENTS={release:join(here,'../build/entitlements.mac.plist'),adhoc:join(here,'../build/entitlements.adhoc.plist')};

/** Fuse name -> index in the wire, from @electron/fuses (FuseV1Options). */
export const FUSE_INDEX=require('@electron/fuses').FuseV1Options;
const FUSE_ON=49,FUSE_OFF=48,FUSE_REMOVED=114; // @electron/fuses FuseState
/** Plan 40 Q2 item 1 / ARCHITECTURE 2.5. */
export const EXPECTED_FUSES={
  RunAsNode:false,
  EnableNodeOptionsEnvironmentVariable:false,
  EnableNodeCliInspectArguments:false,
  EnableEmbeddedAsarIntegrityValidation:true,
  OnlyLoadAppFromAsar:true,
  EnableCookieEncryption:false, // Aplos stores no cookies; turning it on would only add Keychain use.
  GrantFileProtocolExtraPrivileges:true, // Stays on until the renderer is served from aplos-app:// (Q2 item 5).
};

const row=(id,status,reason)=>({id,status,reason});
const pass=(id,reason)=>row(id,'PASS',reason);
const fail=(id,reason)=>row(id,'FAIL',reason);
const skip=(id,reason)=>row(id,'SKIP',reason);
const lines=text=>String(text??'').split('\n').map(s=>s.trim()).filter(Boolean);
const firstLine=text=>lines(text)[0]?.slice(0,200)??'';
const lastLine=text=>lines(text).at(-1)?.slice(0,200)??'';

// ---- (1) fuses -------------------------------------------------------------------------------

const fuseState=state=>state===FUSE_ON?'on':state===FUSE_OFF?'off':state===FUSE_REMOVED?'removed':state===undefined?'missing':`state ${state}`;

/** `wire` is what @electron/fuses getCurrentFuseWire returns: {version:'1', 0:49, 1:48, ...}. */
export function checkFuses(wire){
  if(wire?.version!=='1')return fail('fuses',`unknown fuse wire version ${JSON.stringify(wire?.version)}`);
  const wrong=[];
  for(const [name,want] of Object.entries(EXPECTED_FUSES)){
    const state=wire[FUSE_INDEX[name]];
    if(state!==(want?FUSE_ON:FUSE_OFF))wrong.push(`${name} is ${fuseState(state)}, want ${want?'on':'off'}`);
  }
  return wrong.length?fail('fuses',wrong.join('; ')):pass('fuses',`all ${Object.keys(EXPECTED_FUSES).length} expected fuses match`);
}

// ---- (2) Info.plist --------------------------------------------------------------------------

const versionParts=value=>String(value).split('.').map(Number);
const sameVersion=(a,b)=>{const x=versionParts(a),y=versionParts(b);return x.every(n=>Number.isInteger(n))&&[0,1,2].every(i=>(x[i]??0)===(y[i]??0));};

export function checkMinimumMacos(info){
  const value=info?.LSMinimumSystemVersion;
  if(value===undefined)return fail('min-macos','Info.plist has no LSMinimumSystemVersion');
  return sameVersion(value,'13.0')?pass('min-macos','LSMinimumSystemVersion is 13.0'):fail('min-macos',`LSMinimumSystemVersion is ${value}, want 13.0 (Electron 44 needs macOS 13)`);
}

/** Electron's asar integrity hash is the SHA-256 of the archive's JSON header string. */
export const headerHash=headerString=>createHash('sha256').update(headerString).digest('hex');

/** `actualHash` is the hash of the shipped app.asar header, when known. */
export function checkAsarIntegrity(info,actualHash){
  const entry=info?.ElectronAsarIntegrity?.['Resources/app.asar'];
  if(!entry)return fail('asar-integrity','Info.plist has no ElectronAsarIntegrity entry for Resources/app.asar');
  if(entry.algorithm!=='SHA256'||!/^[0-9a-f]{64}$/.test(entry.hash??''))return fail('asar-integrity',`ElectronAsarIntegrity entry is malformed (algorithm ${entry.algorithm})`);
  if(actualHash!==undefined&&actualHash!==entry.hash)return fail('asar-integrity','ElectronAsarIntegrity hash does not match the app.asar header');
  return pass('asar-integrity',actualHash===undefined?'ElectronAsarIntegrity present':'ElectronAsarIntegrity present and matches the app.asar header');
}

// ---- (3) signature, Gatekeeper, stapling -----------------------------------------------------

/** Results are {status, stdout, stderr} from the command named in each check. */
export function checkCodesignVerify(result){
  // Skip codesign's progress lines and report the first real error.
  if(result.status!==0)result={...result,stderr:lines(result.stderr).filter(line=>!/^--(prepared|validated):/.test(line)).join('\n')};
  return result.status===0?pass('codesign','codesign --verify --strict --deep accepts the bundle'):fail('codesign',`codesign --verify --strict --deep: ${firstLine(result.stderr||result.stdout)||`exit ${result.status}`}`);
}

/** `details` is the stderr of `codesign -dv --verbose=4`. */
export function checkHardenedRuntime(details,expect){
  const flags=/flags=0x[0-9a-f]+\(([^)]*)\)/.exec(details??'')?.[1]??'';
  if(flags.split(',').includes('runtime'))return pass('hardened-runtime','main executable is signed with the hardened runtime');
  return expect==='adhoc'?skip('hardened-runtime','ad-hoc build is not signed with the hardened runtime (not required for source builds)'):fail('hardened-runtime','main executable is not signed with the hardened runtime');
}

export function checkGatekeeper(result,expect){
  if(expect==='adhoc')return skip('gatekeeper','ad-hoc build: not notarized by design');
  const text=`${result.stdout??''}\n${result.stderr??''}`;
  if(result.status!==0||!/: accepted/.test(text))return fail('gatekeeper',`spctl rejects the app: ${firstLine(text)||`exit ${result.status}`}`);
  if(!/source=Notarized Developer ID/.test(text))return fail('gatekeeper',`spctl source is not "Notarized Developer ID" (${firstLine(/source=.*/.exec(text)?.[0])})`);
  if(!text.includes(`(${TEAM_ID})`))return fail('gatekeeper',`spctl origin is not team ${TEAM_ID}`);
  return pass('gatekeeper','spctl: accepted, source=Notarized Developer ID');
}

export function checkStapler(result,expect){
  if(expect==='adhoc')return skip('stapler','ad-hoc build: no notarization ticket by design');
  const text=`${result.stdout??''}\n${result.stderr??''}`;
  return result.status===0&&/The validate action worked/.test(text)?pass('stapler','notarization ticket is stapled'):fail('stapler',`xcrun stapler validate: ${lastLine(text)||`exit ${result.status}`}`);
}

// ---- (4) entitlements ------------------------------------------------------------------------

/** Both arguments are plists already converted to plain objects. */
export function compareEntitlements(actual,expected,label){
  const problems=[];
  for(const key of Object.keys(expected))if(!(key in actual))problems.push(`missing ${key}`);
  for(const key of Object.keys(actual))if(!(key in expected))problems.push(`extra ${key}`);
  for(const key of Object.keys(expected))if(key in actual&&JSON.stringify(actual[key])!==JSON.stringify(expected[key]))problems.push(`${key} is ${JSON.stringify(actual[key])}, want ${JSON.stringify(expected[key])}`);
  return problems.length?fail('entitlements',`differ from ${label}: ${problems.join('; ')}`):pass('entitlements',`match ${label} exactly (${Object.keys(expected).length} keys)`);
}

// ---- (5) designated requirement --------------------------------------------------------------

const escapeRegExp=text=>text.replace(/[.*+?^${}()|[\]\\]/g,'\\$&');

/** `text` is the output of `codesign -d -r-`. */
export function checkDesignatedRequirement(text,expect){
  // codesign prints an implicit requirement (ad-hoc builds) as a comment: "# designated => cdhash H"…"".
  const line=lines(text).map(s=>s.replace(/^#\s*/,'')).find(s=>s.startsWith('designated =>'));
  if(!line)return fail('designated-requirement','codesign shows no designated requirement');
  const dr=line.slice('designated =>'.length).replace(/\/\*.*?\*\//g,'').replace(/\s+/g,' ').trim();
  const cdhashOnly=/\bcdhash\b/.test(dr)&&!/\banchor\b/.test(dr);
  if(expect==='adhoc')return skip('designated-requirement',cdhashOnly?'ad-hoc build: cdhash-only requirement, so Keychain trust resets on every rebuild (expected from source)':'ad-hoc build: team check not applicable');
  if(cdhashOnly)return fail('designated-requirement','cdhash-only requirement: Keychain trust would break on every update');
  const problems=[];
  if(!new RegExp(`\\bidentifier "?${escapeRegExp(BUNDLE_ID)}"?(?=\\s|$)`).test(dr))problems.push(`does not name identifier ${BUNDLE_ID}`);
  if(!/\banchor apple generic\b/.test(dr))problems.push('is not anchored to Apple');
  if(!new RegExp(`certificate leaf\\[subject\\.OU\\] ?= ?"?${TEAM_ID}"?(?=\\s|$)`).test(dr))problems.push(`does not pin certificate leaf subject.OU = ${TEAM_ID}`);
  if(/\bor\b/.test(dr))problems.push('has an "or" branch that could widen it');
  return problems.length?fail('designated-requirement',`requirement ${problems.join(', ')}`):pass('designated-requirement',`names ${BUNDLE_ID} and team ${TEAM_ID}`);
}

// ---- (6) app.asar scan -----------------------------------------------------------------------

/** Key-shaped strings that must never ship. `keep` is how many leading characters the redacted marker shows. */
export const KEY_PATTERNS=[
  {name:'Groq key',re:/gsk_[A-Za-z0-9]{20,}/g,keep:4},
  {name:'Anthropic key',re:/sk-ant-[A-Za-z0-9_-]{20,}/g,keep:7},
  {name:'OpenAI project key',re:/sk-proj-[A-Za-z0-9_-]{20,}/g,keep:8},
  {name:'OpenAI-style key',re:/sk-[A-Za-z0-9]{32,}/g,keep:3},
  {name:'Google API key',re:/AIza[0-9A-Za-z_-]{35}/g,keep:4},
  {name:'GitHub token',re:/gh[pousr]_[A-Za-z0-9]{36}/g,keep:4},
  {name:'GitHub token',re:/github_pat_[A-Za-z0-9_]{22,}/g,keep:11},
  {name:'private key',re:/-----BEGIN [A-Z0-9 ]*PRIVATE KEY-----/g,marker:'-----BEGIN … PRIVATE KEY-----',confirm:hasPemBody},
];
export const GOOGLE_SECRET={name:'Google client secret',re:/GOCSPX-[A-Za-z0-9_-]{20,}/g,keep:7};

/**
 * A PEM header only counts as a key when key material follows it: a base64 run of at least 48 characters
 * before the END line (spaces and "\\n" escapes removed). A bare header, as in a library's README, does not.
 */
export function hasPemBody(text,end){
  const body=text.slice(end,end+600).split('-----END')[0].replace(/\\[nr]|\s/g,'');
  return Math.max(0,...(body.match(/[A-Za-z0-9+/=]+/g)??[]).map(run=>run.length))>=48;
}

const redact=(pattern,match)=>pattern.marker??`${match.slice(0,pattern.keep)}…(redacted)`;
const isEnvFile=path=>{const name=basename(path);return name==='.env'||(name.startsWith('.env.')&&name!=='.env.example');};

function* matches(pattern,text){
  for(const m of text.matchAll(pattern.re))yield {offset:m.index,marker:redact(pattern,m[0]),confirmed:pattern.confirm?pattern.confirm(text,m.index+m[0].length):true};
}

/** `files` yields {path, data: Buffer} with archive-relative paths (no leading slash). */
export function scanFiles(files,{engineBundle=ENGINE_BUNDLE}={}){
  const result={files:0,envFiles:[],keys:[],googleSecrets:[],bareHeaders:[]};
  for(const {path,data} of files){
    result.files++;
    if(isEnvFile(path))result.envFiles.push(path);
    const text=data.toString('latin1'); // one char per byte, so offsets are byte offsets
    for(const pattern of KEY_PATTERNS)for(const {confirmed,...hit} of matches(pattern,text))(confirmed?result.keys:result.bareHeaders).push({path,name:pattern.name,...hit});
    for(const {confirmed,...hit} of matches(GOOGLE_SECRET,text))result.googleSecrets.push({path,name:GOOGLE_SECRET.name,...hit,allowed:path===engineBundle});
  }
  return result;
}

const describeHit=hit=>`${hit.path} @${hit.offset}: ${hit.marker} (${hit.name})`;
const listSome=(items,show)=>items.slice(0,5).map(show).join('; ')+(items.length>5?`; and ${items.length-5} more`:'');

export function asarRows(scan){
  const envRow=scan.envFiles.length?fail('asar-env',`.env file in app.asar: ${listSome(scan.envFiles,p=>p)}`):pass('asar-env',`no .env file among ${scan.files} files`);
  const bad=[...scan.keys,...scan.googleSecrets.filter(hit=>!hit.allowed)];
  if(bad.length)return [envRow,fail('asar-keys',`key-shaped strings: ${listSome(bad,describeHit)}`)];
  const allowed=scan.googleSecrets.filter(hit=>hit.allowed);
  let note=allowed.length?`; ${listSome(allowed,describeHit)} is inlined on purpose (RELEASING.md)`:'';
  if(scan.bareHeaders.length)note+=`; ${scan.bareHeaders.length} PEM header(s) without key material ignored (${listSome([...new Set(scan.bareHeaders.map(hit=>hit.path))],p=>p)})`;
  return [envRow,pass('asar-keys',`no key-shaped strings in ${scan.files} files${note}`)];
}

/** Every regular file in an asar (including unpacked ones), read lazily. */
export function* asarFiles(asarPath){
  const asar=require('@electron/asar');
  const {header}=asar.getRawHeader(asarPath);
  function* walk(node,prefix){
    for(const [name,child] of Object.entries(node.files??{})){
      const path=prefix?`${prefix}/${name}`:name;
      if(child.files)yield* walk(child,path);
      else if(!child.link)yield {path,data:asar.extractFile(asarPath,path)};
    }
  }
  yield* walk(header,'');
}

// ---- (7) aplos-symbols helper ----------------------------------------------------------------

/** `helper` is {exists, executable, verify: {status, stderr}, details: stderr of codesign -dv}. */
export function checkSymbolsHelper(helper,expect){
  const id='symbols-helper';
  if(!helper.exists)return fail(id,'Contents/Resources/bin/aplos-symbols is missing');
  if(!helper.executable)return fail(id,'aplos-symbols is not executable');
  if(helper.verify.status!==0)return fail(id,`aplos-symbols is not validly signed: ${firstLine(helper.verify.stderr)}`);
  const details=helper.details??'';
  if(expect==='adhoc')return pass(id,/Signature=adhoc/.test(details)?'present and signed (ad-hoc)':'present and signed');
  if(/Signature=adhoc/.test(details))return fail(id,'aplos-symbols is only ad-hoc signed');
  if(!details.includes(`TeamIdentifier=${TEAM_ID}`))return fail(id,`aplos-symbols is not signed by team ${TEAM_ID}`);
  return pass(id,`present and signed by team ${TEAM_ID}`);
}

// ---- launch checks (only with --launch-checks) -----------------------------------------------

// Built at runtime so the marker never appears in the command line itself.
export const RUN_AS_NODE_MARKER='aplos-ran-as-node';
const RUN_AS_NODE_CODE='process.stdout.write(["aplos","ran","as","node"].join("-"))';
export const LAUNCH_CASES=[
  {id:'launch-remote-debugging',what:'--remote-debugging-port=0',args:['--remote-debugging-port=0'],mustExit:true},
  {id:'launch-inspect',what:'--inspect=0',args:['--inspect=0'],mustExit:true},
  {id:'launch-run-as-node',what:'ELECTRON_RUN_AS_NODE=1 -e',args:['-e',RUN_AS_NODE_CODE],env:{ELECTRON_RUN_AS_NODE:'1'},runAsNode:true},
  {id:'launch-node-options',what:'NODE_OPTIONS=--inspect=0',args:[],env:{NODE_OPTIONS:'--inspect=0'}},
];
const DEBUGGER_LINE=/DevTools listening on|Debugger listening on/;

/** Pure verdict for one hostile launch. `result` is what launchOnce returns plus `devtoolsFile`. */
export function judgeLaunch(testCase,result,timeoutMs){
  const {id,what}=testCase;
  if(result.error)return fail(id,`could not start the app: ${firstLine(result.error.message)}`);
  if(DEBUGGER_LINE.test(result.output)||result.devtoolsFile)return fail(id,`${what} exposed a debugger`);
  // Node's own option parser rejects the leading --user-data-dir, so "bad option" also proves Node ran.
  if(testCase.runAsNode&&(result.output.includes(RUN_AS_NODE_MARKER)||/bad option:/.test(result.output)))return fail(id,'ELECTRON_RUN_AS_NODE was honoured: the app ran as Node');
  const how=result.timedOut?`still running after ${timeoutMs/1000}s, then killed`:`exited (code ${result.code??result.signal})`;
  if(testCase.mustExit&&result.timedOut)return fail(id,`${what}: no debugger seen, but the app was ${how}; a release must exit`);
  return pass(id,`${what}: no debugger, no Node code ran; ${how}`);
}

/** Starts the app once and collects its output; kills it after `timeoutMs`. `spawn` is injectable for tests. */
export function launchOnce({spawn,executable,args,env,timeoutMs}){
  return new Promise(done=>{
    let output='',timedOut=false,settled=false,child,timer,grace;
    const finish=extra=>{if(settled)return;settled=true;clearTimeout(timer);clearTimeout(grace);done({output,timedOut,...extra});};
    try{child=spawn(executable,args,{env,stdio:['ignore','pipe','pipe'],detached:true});}catch(error){return finish({error});}
    const collect=chunk=>{if(output.length<1_000_000)output+=String(chunk);};
    child.stdout?.on('data',collect);child.stderr?.on('data',collect);
    child.on('error',error=>finish({error}));
    child.on('close',(code,signal)=>finish({code,signal}));
    // Chromium helpers can hold the pipes open, so do not wait for 'close' forever after 'exit'.
    child.on('exit',(code,signal)=>{if(timedOut)return;clearTimeout(timer);grace=setTimeout(()=>finish({code,signal}),500);});
    timer=setTimeout(()=>{
      timedOut=true;
      try{process.kill(-child.pid,'SIGKILL');}catch{child.kill('SIGKILL');} // the whole process group
      grace=setTimeout(()=>finish({code:null,signal:'SIGKILL'}),2000);
    },timeoutMs);
  });
}

export async function runLaunchChecks({executable,spawn=nodeSpawn,timeoutMs=8000,baseEnv=process.env,makeTempDir=()=>mkdtempSync(join(tmpdir(),'aplos-hardening-')),removeDir=dir=>rmSync(dir,{recursive:true,force:true}),exists=existsSync}){
  const rows=[];
  for(const testCase of LAUNCH_CASES){
    const dir=makeTempDir();
    try{
      const env={...baseEnv,APLOS_DATA_DIR:dir};
      delete env.ELECTRON_RUN_AS_NODE;delete env.NODE_OPTIONS;
      Object.assign(env,testCase.env);
      const profile=join(dir,'chromium');
      const result=await launchOnce({spawn,executable,args:[`--user-data-dir=${profile}`,...testCase.args],env,timeoutMs});
      rows.push(judgeLaunch(testCase,{...result,devtoolsFile:exists(join(profile,'DevToolsActivePort'))},timeoutMs));
    }finally{removeDir(dir);}
  }
  return rows;
}

// ---- running the checks against an app -------------------------------------------------------

/** Runs a command without a shell. `input` goes to stdin. */
export function run(command,args,{input}={}){
  const result=spawnSync(command,args,{encoding:'utf8',input,maxBuffer:64*1024*1024});
  return {status:result.status??(result.error?-1:1),stdout:result.stdout??'',stderr:result.stderr??(result.error?.message||'')};
}

function plistObject(exec,{path,text}){
  const result=path?exec('plutil',['-convert','json','-o','-','--',path]):exec('plutil',['-convert','json','-o','-','-'],{input:text});
  if(result.status!==0)throw new Error(`plutil could not read ${path??'the plist'}: ${firstLine(result.stderr)}`);
  return JSON.parse(result.stdout);
}

async function attempt(id,fn){
  try{const out=await fn();return Array.isArray(out)?out:[out];}
  catch(error){return [fail(id,firstLine(error.message))];}
}

export async function verifyApp(appPath,{expect='release',launchChecks=false,exec:runCommand=run,spawn=nodeSpawn}={}){
  const app=resolve(appPath);
  // Tool messages repeat the full bundle path; shorten it so each row stays one readable line.
  const exec=(command,args,options)=>{const r=runCommand(command,args,options);const tidy=t=>[`/private${app}`,app].reduce((text,path)=>text.split(`${path}/`).join('').split(path).join(basename(app)),t);return {...r,stderr:tidy(r.stderr)};};
  const contents=join(app,'Contents');
  const asarPath=join(contents,'Resources','app.asar');
  const rows=[];
  const add=async(id,fn)=>rows.push(...await attempt(id,fn));
  let info={};

  await add('fuses',async()=>checkFuses(await require('@electron/fuses').getCurrentFuseWire(app)));
  await add('min-macos',()=>{info=plistObject(exec,{path:join(contents,'Info.plist')});return checkMinimumMacos(info);});
  await add('asar-integrity',()=>checkAsarIntegrity(info,headerHash(require('@electron/asar').getRawHeader(asarPath).headerString)));
  await add('codesign',()=>checkCodesignVerify(exec('codesign',['--verify','--strict','--deep',app])));
  await add('hardened-runtime',()=>checkHardenedRuntime(exec('codesign',['-dv','--verbose=4',app]).stderr,expect));
  await add('gatekeeper',()=>expect==='adhoc'?checkGatekeeper({},expect):checkGatekeeper(exec('spctl',['-a','-vv','-t','exec',app]),expect));
  await add('stapler',()=>expect==='adhoc'?checkStapler({},expect):checkStapler(exec('xcrun',['stapler','validate',app]),expect));
  await add('entitlements',()=>{
    const shown=exec('codesign',['-d','--entitlements',':-',app]);
    if(shown.status!==0)throw new Error(`codesign could not show entitlements: ${firstLine(shown.stderr)}`);
    const actual=shown.stdout.trim()?plistObject(exec,{text:shown.stdout}):{};
    const file=ENTITLEMENTS[expect];
    return compareEntitlements(actual,plistObject(exec,{path:file}),`build/${basename(file)}`);
  });
  await add('designated-requirement',()=>{const r=exec('codesign',['-d','-r-',app]);return checkDesignatedRequirement(`${r.stdout}\n${r.stderr}`,expect);});
  await add('asar-keys',()=>{
    if(!existsSync(asarPath))throw new Error('Contents/Resources/app.asar is missing');
    return asarRows(scanFiles(asarFiles(asarPath)));
  });
  await add('symbols-helper',()=>{
    const helper=join(contents,'Resources','bin','aplos-symbols');
    if(!existsSync(helper))return checkSymbolsHelper({exists:false},expect);
    let executable=true;try{accessSync(helper,fsConstants.X_OK);}catch{executable=false;}
    return checkSymbolsHelper({exists:true,executable,verify:exec('codesign',['--verify','--strict',helper]),details:exec('codesign',['-dv','--verbose=4',helper]).stderr},expect);
  });

  if(launchChecks){
    const name=info.CFBundleExecutable||'Aplos Mail';
    await add('launch',()=>runLaunchChecks({executable:join(contents,'MacOS',name),spawn}));
  }else for(const testCase of LAUNCH_CASES)rows.push(skip(testCase.id,'not run (pass --launch-checks; it launches the app)'));
  return rows;
}

export function formatTable(rows){
  const width=Math.max(...rows.map(r=>r.id.length));
  const lines=rows.map(r=>`${r.status.padEnd(4)}  ${r.id.padEnd(width)}  ${r.reason}`);
  const count=status=>rows.filter(r=>r.status===status).length;
  return [...lines,'',`${count('PASS')} passed, ${count('FAIL')} failed, ${count('SKIP')} skipped`].join('\n');
}

export function parseArgs(argv){
  const options={expect:'release',json:false,launchChecks:false,app:undefined};
  for(let i=0;i<argv.length;i++){
    const arg=argv[i];
    if(arg==='--json')options.json=true;
    else if(arg==='--launch-checks')options.launchChecks=true;
    else if(arg==='--expect')options.expect=argv[++i];
    else if(arg.startsWith('--expect='))options.expect=arg.slice('--expect='.length);
    else if(arg==='--help'||arg==='-h')options.help=true;
    else if(!arg.startsWith('-')&&!options.app)options.app=arg;
    else throw new Error(`unknown argument ${arg}`);
  }
  if(!options.help&&!options.app)throw new Error('missing the path to the .app');
  if(!['release','adhoc'].includes(options.expect))throw new Error(`--expect must be release or adhoc, not ${options.expect}`);
  if(options.app&&!resolve(options.app).endsWith('.app'))throw new Error(`${options.app} is not a .app bundle`);
  return options;
}

const USAGE='Usage: node scripts/verify-hardening.mjs <path-to-.app> [--expect release|adhoc] [--json] [--launch-checks]';

if(process.argv[1]&&resolve(process.argv[1])===fileURLToPath(import.meta.url)){
  let options;
  try{options=parseArgs(process.argv.slice(2));}catch(error){console.error(`verify-hardening: ${error.message}\n${USAGE}`);process.exit(2);}
  if(options.help){console.log(USAGE);process.exit(0);}
  if(!existsSync(options.app)){console.error(`verify-hardening: ${options.app} does not exist`);process.exit(2);}
  const rows=await verifyApp(options.app,options);
  const ok=!rows.some(r=>r.status==='FAIL');
  if(options.json)console.log(JSON.stringify({app:resolve(options.app),expect:options.expect,ok,rows},null,2));
  else console.log(`verify-hardening: ${resolve(options.app)} (expect ${options.expect})\n\n${formatTable(rows)}`);
  process.exit(ok?0:1);
}
