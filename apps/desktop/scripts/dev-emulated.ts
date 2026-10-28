import { loadDevEnv } from '../src/main/env';
import { startServer } from '../src/main/server';
import { createEmulatedSession } from './emulation/session';

const liveAI = process.argv.includes('--live-ai');
if (liveAI) loadDevEnv();
const session = await createEmulatedSession(liveAI);
try {
  const service = await session.createService();
  await startServer({ service, onClose: session.close, loadEnv: false });
  console.log('LOCAL PROVIDER EMULATION — temporary synthetic mailbox; no external mail delivery.');
  console.log(
    'In Settings → Accounts, add Google or Outlook. Sign-in is simulated through the real OAuth callback.',
  );
  console.log(
    liveAI
      ? 'AI uses the backend Groq environment key.'
      : 'AI disabled. Add --live-ai to use Groq with synthetic mail.',
  );
} catch (error) {
  await session.close();
  console.error(error instanceof Error ? error.message : 'Emulated launch failed');
  process.exitCode = 1;
}
