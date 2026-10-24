import type {Target} from './release';

// Which build fits the visitor's computer. Chromium browsers say so directly (User-Agent Client Hints). Safari and
// Firefox on a Mac report "Intel" in every user agent, so there the graphics renderer decides: Apple silicon Macs
// report an Apple GPU. A phone or tablet gets no automatic download. `?platform=mac-x64` overrides it, for testing.
type Hints={platform?:string;architecture?:string;mobile?:boolean};
type NavigatorWithHints=Navigator&{userAgentData?:{mobile:boolean;platform:string;getHighEntropyValues(keys:string[]):Promise<Hints>}};

export type Detected={target:Target|null;mobile:boolean};
const targets:Target[]=['mac-arm64','mac-x64','win-x64','win-arm64','linux-x64','linux-arm64'];

export async function detect():Promise<Detected> {
  const forced=new URLSearchParams(location.search).get('platform');
  if(targets.includes(forced as Target))return {target:forced as Target,mobile:false};
  const nav=navigator as NavigatorWithHints;
  const ua=navigator.userAgent;
  // iPadOS asks for desktop pages as a Mac; a touch screen gives it away.
  const mobile=nav.userAgentData?.mobile??(/iPhone|iPad|iPod|Android/i.test(ua)||(/Macintosh/.test(ua)&&navigator.maxTouchPoints>1));
  if(mobile)return {target:null,mobile:true};
  let os=/Mac/.test(ua)?'mac':/Windows/.test(ua)?'win':/Linux|X11/.test(ua)?'linux':null;
  let arm:boolean|null=/aarch64|arm64/i.test(ua)?true:null;
  try{
    const hints=await nav.userAgentData?.getHighEntropyValues(['platform','architecture']);
    if(hints?.platform)os=hints.platform==='macOS'?'mac':hints.platform==='Windows'?'win':hints.platform==='Linux'?'linux':os;
    if(hints?.architecture)arm=hints.architecture==='arm';
  }catch{/* hints are optional */}
  if(!os)return {target:null,mobile:false};
  if(os==='mac'&&arm===null)arm=appleGpu()??true; // most Macs sold since 2020 are Apple silicon
  return {target:`${os}-${arm?'arm64':'x64'}` as Target,mobile:false};
}

function appleGpu():boolean|null {
  try{
    const gl=document.createElement('canvas').getContext('webgl');
    const info=gl?.getExtension('WEBGL_debug_renderer_info');
    const renderer=gl&&info?String(gl.getParameter(info.UNMASKED_RENDERER_WEBGL)):'';
    if(/Apple (M\d|GPU)/.test(renderer))return true;
    if(/Intel|AMD|Radeon|NVIDIA/i.test(renderer))return false;
  }catch{/* no WebGL */}
  return null;
}
