import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

export interface ClientConfig {
  url: string;
  token: string;
  machineId: string;
  name?: string;
}

/** ~/.buildyboy, or BUILDYBOY_HOME (tests). */
export function bbHome(): string {
  return process.env.BUILDYBOY_HOME || join(homedir(), '.buildyboy');
}

export function readClientConfig(): Partial<ClientConfig> {
  const file = join(bbHome(), 'config.json');
  const fromFile = existsSync(file) ? (JSON.parse(readFileSync(file, 'utf8')) as Partial<ClientConfig>) : {};
  return {
    ...fromFile,
    url: process.env.BUILDYBOY_URL || fromFile.url,
    token: process.env.BUILDYBOY_TOKEN || fromFile.token,
  };
}

export function writeClientConfig(cfg: ClientConfig) {
  mkdirSync(bbHome(), { recursive: true });
  writeFileSync(join(bbHome(), 'config.json'), JSON.stringify(cfg, null, 2), { mode: 0o600 });
}
