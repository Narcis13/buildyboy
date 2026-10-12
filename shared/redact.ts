// Masks likely secrets before anything is stored. Rules are plain regexes so they can be tested and extended.

export interface RedactRule {
  name: string;
  pattern: string;
  flags?: string;
  /** replacement; `$1` etc. keep a prefix */
  replace?: string;
}

export const MASK = '[REDACTED]';

export const DEFAULT_RULES: RedactRule[] = [
  { name: 'anthropic/openai key', pattern: '\\bsk-[A-Za-z0-9_-]{16,}', flags: 'g' },
  { name: 'github token', pattern: '\\b(?:ghp|gho|ghu|ghs|ghr)_[A-Za-z0-9]{20,}', flags: 'g' },
  { name: 'github fine-grained token', pattern: '\\bgithub_pat_[A-Za-z0-9_]{20,}', flags: 'g' },
  { name: 'aws access key', pattern: '\\b(?:AKIA|ASIA)[A-Z0-9]{16}\\b', flags: 'g' },
  { name: 'aws secret', pattern: '(aws_secret_access_key\\s*[=:]\\s*)["\']?[A-Za-z0-9/+=]{40}["\']?', flags: 'gi', replace: `$1${MASK}` },
  { name: 'jwt', pattern: '\\beyJ[A-Za-z0-9_-]{8,}\\.[A-Za-z0-9_-]{8,}\\.[A-Za-z0-9_-]{8,}', flags: 'g' },
  { name: 'bearer', pattern: '(Bearer\\s+)[A-Za-z0-9._~+/=-]{8,}', flags: 'gi', replace: `$1${MASK}` },
  { name: 'password assignment', pattern: '((?:password|passwd|pwd|secret|api[_-]?key|token)\\s*[=:]\\s*)("[^"\\s]+"|\'[^\'\\s]+\'|[^\\s&"\',;]+)', flags: 'gi', replace: `$1${MASK}` },
  { name: 'private key', pattern: '-----BEGIN [A-Z ]*PRIVATE KEY-----[\\s\\S]*?-----END [A-Z ]*PRIVATE KEY-----', flags: 'g' },
];

export function compileRules(rules: RedactRule[]): { re: RegExp; replace: string }[] {
  const out: { re: RegExp; replace: string }[] = [];
  for (const r of rules) {
    try {
      out.push({ re: new RegExp(r.pattern, r.flags ?? 'g'), replace: r.replace ?? MASK });
    } catch {
      // ignore invalid user-supplied rules
    }
  }
  return out;
}

const defaultCompiled = compileRules(DEFAULT_RULES);

export function redactText(text: string, compiled = defaultCompiled): string {
  let out = text;
  for (const { re, replace } of compiled) {
    re.lastIndex = 0;
    out = out.replace(re, replace);
  }
  return out;
}

/** True for paths whose content should never be stored (`.env`, `.env.local`, ...). */
export function isEnvFile(path: unknown): boolean {
  if (typeof path !== 'string') return false;
  const base = path.split(/[\\/]/).pop() ?? '';
  return /^\.env(\..*)?$/i.test(base) && !/\.(example|sample|template)$/i.test(base);
}

/** Deep-redacts every string inside a JSON value. */
export function redactValue<T>(value: T, compiled = defaultCompiled): T {
  if (typeof value === 'string') return redactText(value, compiled) as T;
  if (Array.isArray(value)) return value.map((v) => redactValue(v, compiled)) as T;
  if (value && typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value)) out[k] = redactValue(v, compiled);
    return out as T;
  }
  return value;
}

/**
 * Redacts a hook event. Besides the generic rules, the output of a Read on a `.env*` file is dropped entirely.
 */
export function redactHookEvent<T extends Record<string, unknown>>(event: T, compiled = defaultCompiled): T {
  const e = redactValue(event, compiled) as Record<string, unknown>;
  const input = e.tool_input as Record<string, unknown> | undefined;
  if (e.tool_name === 'Read' && input && isEnvFile(input.file_path) && 'tool_response' in e) {
    e.tool_response = `${MASK} (.env file content not stored)`;
  }
  return e as T;
}

/** Redacts transcript JSONL content blocks that carry `.env` file reads (tool_result after a Read of .env). */
export function redactTranscriptLine(line: string, envToolUseIds: Set<string>, compiled = defaultCompiled): string {
  let obj: unknown;
  try {
    obj = JSON.parse(line);
  } catch {
    return redactText(line, compiled);
  }
  const visit = (v: unknown): void => {
    if (!v || typeof v !== 'object') return;
    if (Array.isArray(v)) return v.forEach(visit);
    const o = v as Record<string, unknown>;
    if (o.type === 'tool_use' && o.name === 'Read' && isEnvFile((o.input as Record<string, unknown> | undefined)?.file_path) && typeof o.id === 'string') {
      envToolUseIds.add(o.id);
    }
    if (o.type === 'tool_result' && typeof o.tool_use_id === 'string' && envToolUseIds.has(o.tool_use_id)) {
      o.content = `${MASK} (.env file content not stored)`;
    }
    for (const x of Object.values(o)) visit(x);
  };
  visit(obj);
  const o = obj as Record<string, unknown> | null;
  if (o && typeof o === 'object' && 'toolUseResult' in o) {
    const tur = o.toolUseResult as Record<string, unknown> | undefined;
    const file = tur && typeof tur === 'object' ? (tur.file as Record<string, unknown> | undefined) : undefined;
    if (file && isEnvFile(file.filePath)) file.content = `${MASK} (.env file content not stored)`;
  }
  return JSON.stringify(redactValue(obj, compiled));
}
