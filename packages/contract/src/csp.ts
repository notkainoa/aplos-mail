import * as z from 'zod/mini';

/**
 * The renderer's CSP forbids `eval`, which zod's JIT object parser uses (ARCH 9.3). Call this once, before any schema
 * parses, in any process whose CSP has no `'unsafe-eval'`. The engine and main do not need it.
 */
export function configureZodForCsp(): void {
  z.config({ jitless: true });
}
