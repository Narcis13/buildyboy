// herdr (`hc`) integration on the machine side. The server never runs hc; the runner does (SPEC §11.4).
import { existsSync } from 'node:fs';
import { delimiter, join } from 'node:path';

/** hc's path: BUILDYBOY_HC, an explicit config path, herdr-core's default Windows install, then PATH. */
export function findHc(configured?: string): string | null {
  const candidates = [process.env.BUILDYBOY_HC, configured];
  if (process.platform === 'win32' && process.env.LOCALAPPDATA) candidates.push(join(process.env.LOCALAPPDATA, 'Programs', 'herdr-core', 'hc.exe'));
  for (const dir of (process.env.PATH ?? '').split(delimiter).filter(Boolean)) candidates.push(join(dir, process.platform === 'win32' ? 'hc.exe' : 'hc'));
  return candidates.find((c): c is string => !!c && existsSync(c)) ?? null;
}
