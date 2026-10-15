import {spawn} from 'node:child_process';
import {existsSync} from 'node:fs';
import {resolve} from 'node:path';
import {config} from 'dotenv';
config({path:resolve('.env'),quiet:true});
const executable=resolve('release/mac-arm64/Aplos Mail.app/Contents/MacOS/Aplos Mail');
if(!existsSync(executable)){console.error('Run npm run package first.');process.exit(1);}
const child=spawn(executable,[],{env:process.env,stdio:'inherit'});
child.on('error',e=>{console.error(e.message);process.exitCode=1;});
child.on('exit',code=>{process.exitCode=code??0;});
