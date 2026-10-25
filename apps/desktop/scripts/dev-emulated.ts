import { loadDevEnv } from '../src/main/env';
import { startServer } from '../src/main/server';
import { createEmulatedSession } from './emulation/session';

const liveAI=process.argv.includes('--live-ai');
if(liveAI)loadDevEnv();
const flag=(name:string)=>Number(process.argv.find(a=>a.startsWith(`--${name}=`))?.split('=')[1])||0;
// Starts empty like a fresh install (--demo adds the demo). --threads=N adds synthetic Google mail, --latency=MS slows each
// request so the setup screen's progress can be watched, and --fail-sync=N makes Google refuse the next N mail syncs.
const session=await createEmulatedSession(liveAI,{demo:process.argv.includes('--demo'),threads:flag('threads'),latencyMs:flag('latency'),fakeAI:process.argv.includes('--fake-ai')});
for(let i=0;i<flag('fail-sync');i++)session.emulator.failNext('google','GET','/threads',403,{error:{code:403,message:'Gmail API has not been used in project 000000000000 before or it is disabled. Enable it by visiting the Google Cloud console then retry. (Emulated refusal.)',errors:[{reason:'accessNotConfigured'}]}});
try {
  const service=await session.createService();
  await startServer({service,onClose:session.close,loadEnv:false});
  console.log('LOCAL PROVIDER EMULATION — temporary synthetic mailbox; no external mail delivery.');
  console.log('In Settings → Accounts, add Google or Outlook. Sign-in is simulated through the real OAuth callback.');
  console.log(liveAI?'AI uses the backend Groq environment key.':process.argv.includes('--fake-ai')?'AI is a local stand-in that returns labelled emulated summaries.':'AI disabled. Add --live-ai to use Groq with synthetic mail, or --fake-ai for a local stand-in.');
}catch(error){await session.close();console.error(error instanceof Error?error.message:'Emulated launch failed');process.exitCode=1;}
