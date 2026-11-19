/**
 * Errors the runner may print. Only a RunnerError's message is shown to the owner: its text is
 * written by this code and holds no input. Anything else (a JSON parse error, a network error, a
 * file error) can quote what it was reading, which for a mis-pasted vault file could be a token, so
 * only its class name is printed.
 */
export class RunnerError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'RunnerError';
  }
}

export function printableMessage(error: unknown, fallback: string): string {
  if (error instanceof RunnerError) return error.message;
  return error instanceof Error ? `${fallback} (${error.name})` : fallback;
}
