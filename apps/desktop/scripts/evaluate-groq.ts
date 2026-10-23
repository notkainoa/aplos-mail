import { loadDevEnv } from '../src/main/env';
import { mkdir, writeFile } from 'node:fs/promises';
import { createGroq } from '../src/main/groq';
import { askModel, qualityCases } from './quality/cases';

loadDevEnv();
const ai=createGroq();
if(!ai.available)throw new Error('Set GROQ_API_KEY in the backend environment to run live evaluations.');
const runs=Number(process.argv.find(a=>a.startsWith('--runs='))?.split('=')[1]??1);
if(!Number.isInteger(runs)||runs<1||runs>5)throw new Error('Use --runs=1 through --runs=5.');
const results:Array<{id:string;run:number;passed:boolean;ms:number;error?:string}>=[];
for(let run=1;run<=runs;run++)for(const item of qualityCases) {
  const start=performance.now();let error:string|undefined;
  try{await item.run(ai);}catch(e){error=e instanceof Error?e.message:'Evaluation failed';}
  results.push({id:item.id,run,passed:!error,ms:Math.round(performance.now()-start),...(error?{error}:{})});
  console.log(`${error?'FAIL':'PASS'} ${run}/${runs} ${item.id}`);
}
const report={date:new Date().toISOString(),model:process.env.GROQ_MODEL??'openai/gpt-oss-120b',askModel,provider:'Groq',syntheticContentOnly:true,runs,passed:results.filter(r=>r.passed).length,total:results.length,results};
await mkdir('artifacts',{recursive:true});await writeFile('artifacts/groq-evaluation.json',JSON.stringify(report,null,2));
console.log(`${report.passed}/${report.total} passed. Report: artifacts/groq-evaluation.json`);
if(report.passed!==report.total)process.exitCode=1;
