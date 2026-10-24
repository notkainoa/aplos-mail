import type {Target} from './release';

// Which build fits the visitor's computer. Chromium browsers say so directly (User-Agent Client Hints). Safari and
// Firefox on a Mac report "Intel" in every user agent, so there the graphics renderer may tell; when it does not, the
// page suggests Apple silicon but waits for the visitor instead of downloading a guess. A phone, tablet or Chromebook
// gets no automatic download. `?platform=mac-x64` overrides it, for testing.
type Hints={platform?:string;architecture?:string;mobile?:boolean};
type NavigatorWithHints=Navigator&{userAgentData?:{mobile:boolean;platform:string;getHighEntropyValues(keys:string[]):Promise<Hints>}};

// `sure` is false when the build is a best guess (a Mac whose chip the browser will not reveal).
export type Detected={target:Target|null;mobile:boolean;sure:boolean};
const targets:Target[]=['mac-arm64','mac-x64','win-x64','win-arm64','linux-x64','linux-arm64'];

export async function detect():Promise<Detected> {
  const forced=new URLSearchParams(location.search).get('platform');
  if(targets.includes(forced as Target))return {target:forced as Target,mobile:false,sure:true};
  const nav=navigator as NavigatorWithHints;
  const ua=navigator.userAgent;
  // iPadOS asks for desktop pages as a Mac; a touch screen gives it away.
  // Android tablets and "desktop site" mode report mobile:false in the hints, so the user agent is checked as well.
  const mobile=!!nav.userAgentData?.mobile||/iPhone|iPad|iPod|Android/i.test(ua)||(/Macintosh/.test(ua)&&navigator.maxTouchPoints>1);
  if(mobile)return {target:null,mobile:true,sure:true};
  if(/CrOS/.test(ua))return {target:null,mobile:false,sure:true}; // ChromeOS: no build, and its user agent says Linux
  let os=/Mac/.test(ua)?'mac':/Windows/.test(ua)?'win':/Linux|X11/.test(ua)?'linux':null;
  let arm:boolean|null=/aarch64|arm64/i.test(ua)?true:null;
  try{
    const hints=await nav.userAgentData?.getHighEntropyValues(['platform','architecture']);
    if(hints?.platform==='Android'||hints?.platform==='Chrome OS')return {target:null,mobile:hints.platform==='Android',sure:true};
    if(hints?.platform)os=hints.platform==='macOS'?'mac':hints.platform==='Windows'?'win':hints.platform==='Linux'?'linux':os;
    if(hints?.architecture)arm=hints.architecture==='arm';
  }catch{/* hints are optional */}
  if(!os)return {target:null,mobile:false,sure:true};
  let sure=true;
  if(os==='mac'&&arm===null){arm=appleGpu();if(arm===null){arm=true;sure=false;}} // most Macs sold since 2020 are Apple silicon
  return {target:`${os}-${arm?'arm64':'x64'}` as Target,mobile:false,sure};
}

function appleGpu():boolean|null {
  try{
    const gl=document.createElement('canvas').getContext('webgl');
    const info=gl?.getExtension('WEBGL_debug_renderer_info');
    const renderer=gl&&info?String(gl.getParameter(info.UNMASKED_RENDERER_WEBGL)):'';
    // Safari reports "Apple GPU" on every Mac, Intel ones included, so only a named Apple chip counts.
    if(/Apple M\d/.test(renderer))return true;
    if(/Intel|AMD|Radeon|NVIDIA/i.test(renderer))return false;
  }catch{/* no WebGL */}
  return null;
}
