/**
 * Main's native methods on the stand-in. The stand-in engine serves engine methods only and refuses a desktop method
 * ("This method belongs to the desktop app"), because in Electron preload routes those to main. Development and tests
 * have no main, so this wraps the stand-in's session and answers the desktop methods `api` exposes with the honest
 * "nothing happened here" result: windows do not open, permissions are not granted, nothing is posted. Development and
 * tests only, like the stand-in; a release uses the real transport.
 */
import { parseArgs, type MethodName } from '@aplos/contract';
import type { EngineSession } from '@aplos/contract/client';

type Stub = (args: Record<string, unknown>) => unknown;

const ok = () => ({ ok: true as const });

/** Development and tests have no updater: the honest answer is that updates are off. */
const updatesOff = () => ({
  currentVersion: '0.0.0',
  status: { state: 'disabled' as const, reason: 'Updates are off in development builds.' },
});

/** The desktop methods the stand-in answers, by contract name. */
const STUBS: Readonly<Record<string, Stub>> = {
  'Window/openOnboarding': ok,
  'Window/finishOnboarding': ok,
  'Window/closeReady': ok,
  'Window/closeCancel': ok,
  'Notification/test': ok,
  'Update/status': updatesOff,
  'Update/check': updatesOff,
  'Update/later': updatesOff,
  'Update/restart': ok,
  'System/openSettings': ok,
  'Shell/open': ok,
  'File/save': () => ({ canceled: true }),
  'System/login': args => ({ enabled: args['enabled'] === true }),
  'System/defaultMail': () => ({ success: false }),
  'System/microphone': () => ({ granted: false, status: 'notDetermined' }),
  'System/notifications': () => ({ status: 'unknown' }),
};

/** Whether the stand-in answers this desktop method itself. */
export function isNativeStubbed(method: string): boolean {
  return Object.prototype.hasOwnProperty.call(STUBS, method);
}

/** `session` with the stubbed desktop methods answered locally; everything else goes to the stand-in unchanged. */
export function withNativeStubs(session: EngineSession): EngineSession {
  return {
    call(method, args, options) {
      const stub = isNativeStubbed(method) ? STUBS[method] : undefined;
      if (!stub) return session.call(method, args, options);
      // Main validates against the contract schema before it answers; so does the stand-in, with the same refusals.
      try {
        const parsed = parseArgs(method as MethodName, args) as Record<string, unknown>;
        return Promise.resolve(stub(parsed));
      } catch (error) {
        return Promise.reject(error);
      }
    },
    subscribe: listener => session.subscribe(listener),
    close: () => session.close(),
  };
}
