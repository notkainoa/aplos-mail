// The `knownSubject` dep of the Google connect (connect.ts) over a store lookup, with a bounded wait. The connect revokes a
// refused grant only when this answers exactly `false`, so a slow, failing or throwing lookup answers `true` (known):
// the unused grant stays at Google rather than risk ending one an Aplos account relies on.

export const knownSubjectTimeoutMs = 2_000;

export interface KnownSubjectOptions {
  timeoutMs?: number;
}

export function boundedKnownSubject(
  lookup: (subject: string) => boolean | Promise<boolean>,
  options: KnownSubjectOptions = {},
): (subject: string) => Promise<boolean> {
  const timeoutMs = options.timeoutMs ?? knownSubjectTimeoutMs;
  return async subject => {
    let timer: ReturnType<typeof setTimeout> | undefined;
    const timeout = new Promise<true>(resolve => {
      timer = setTimeout(() => resolve(true), timeoutMs);
    });
    try {
      const answer = await Promise.race([Promise.resolve().then(() => lookup(subject)), timeout]);
      return answer === false ? false : true;
    } catch {
      return true;
    } finally {
      clearTimeout(timer);
    }
  };
}
