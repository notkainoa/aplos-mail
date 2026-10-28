import { execFile } from 'node:child_process';
import { existsSync } from 'node:fs';

const request =
  /^[a-z0-9.]{1,80}:\d{1,3}(\.\d)?:\d{1,3}(\.\d)?:(ultralight|thin|light|regular|medium|semibold|bold|heavy|black)$/;

// System symbols only exist on macOS; elsewhere callers fall back to bundled vector icons.
export function symbolRenderer(tool: string | undefined) {
  const cache = new Map<string, string>();
  const available = process.platform === 'darwin' && !!tool && existsSync(tool);
  return async function render(items: unknown, scale: unknown): Promise<Record<string, string>> {
    if (!available || !Array.isArray(items)) return {};
    const factor = scale === 3 ? 3 : 2;
    const wanted = [
      ...new Set(
        items.filter((item): item is string => typeof item === 'string' && request.test(item)),
      ),
    ].slice(0, 400);
    const missing = wanted.filter(item => !cache.has(`${factor}|${item}`));
    if (missing.length) {
      const output = await new Promise<string>(resolve =>
        execFile(
          tool!,
          [String(factor), ...missing],
          { maxBuffer: 32 * 1024 * 1024, timeout: 15_000 },
          (error, stdout) => resolve(error ? '{}' : stdout),
        ),
      );
      let parsed: Record<string, string> = {};
      try {
        parsed = JSON.parse(output);
      } catch {
        parsed = {};
      }
      for (const item of missing)
        cache.set(
          `${factor}|${item}`,
          typeof parsed[item] === 'string' && parsed[item].startsWith('data:image/png;base64,')
            ? parsed[item]
            : '',
        );
    }
    const result: Record<string, string> = {};
    for (const item of wanted) {
      const value = cache.get(`${factor}|${item}`);
      if (value) result[item] = value;
    }
    return result;
  };
}
