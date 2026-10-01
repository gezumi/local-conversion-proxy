// `lcp fail-open`: what the watchdog runs when the proxy stops answering.
// Codex goes back to OpenAI directly: our config line removed, and a default
// model only the proxy can serve set aside (commented out, the recorded GPT
// model after it). Loads only the config editing code, so it works even when
// the proxy itself cannot start; the watchdog records the result in its state.

import { join } from 'node:path';
import { failOpenText, updateConfig } from './codex-config.mjs';
import { paths } from './paths.mjs';
import { readWatchdog, withStateLock } from './watchdog-state.mjs';

/** { changed, swapped }: whether config.toml changed, and the default model set aside ('' if none). */
export function failOpen(p = paths()) {
  const { fallback } = readWatchdog(p);
  let swapped = '';
  const r = updateConfig(join(p.codexHome, 'config.toml'), p.backupsDir, (text) => {
    const out = failOpenText(text, fallback);
    swapped = out.swapped;
    return out.text;
  });
  return { changed: r.changed, swapped };
}

/** Exit code for the watchdog: 0 changed (prints `swapped=<model>`), 3 nothing to change, 1 failed. */
export async function failOpenCommand() {
  try {
    const p = paths();
    const r = await withStateLock(p, () => failOpen(p));
    if (!r.changed) return 3;
    process.stdout.write(`swapped=${r.swapped}\n`);
    return 0;
  } catch (err) {
    process.stderr.write(`lcp fail-open: ${err?.message ?? err}\n`);
    return 1;
  }
}
