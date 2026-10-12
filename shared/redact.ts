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
  { name: 'anthropic/openai key', pattern: String.raw`\bsk-[A-Za-z0-9_-]{16,}`, flags: 'g' },
  { name: 'stripe key', pattern: String.raw`\b(?:sk|rk|pk)_(?:live|test)_[A-Za-z0-9]{10,}`, flags: 'g' },
  { name: 'github token', pattern: String.raw`\b(?:ghp|gho|ghu|ghs|ghr)_[A-Za-z0-9]{20,}`, flags: 'g' },
  { name: 'github fine-grained token', pattern: String.raw`\bgithub_pat_[A-Za-z0-9_]{20,}`, flags: 'g' },
  { name: 'slack token', pattern: String.raw`\bxox[abposr]-[A-Za-z0-9-]{10,}`, flags: 'g' },
  { name: 'npm token', pattern: String.raw`\bnpm_[A-Za-z0-9]{30,}`, flags: 'g' },
  { name: 'google api key', pattern: String.raw`\bAIza[0-9A-Za-z_-]{30,}`, flags: 'g' },
  { name: 'aws access key', pattern: String.raw`\b(?:AKIA|ASIA)[A-Z0-9]{16}\b`, flags: 'g' },
  { name: 'aws secret', pattern: String.raw`(aws_secret_access_key\s*[=:]\s*)["']?[A-Za-z0-9/+=]{40}["']?`, flags: 'gi', replace: `$1${MASK}` },
  { name: 'jwt', pattern: String.raw`\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}`, flags: 'g' },
  { name: 'bearer', pattern: String.raw`(Bearer\s+)[A-Za-z0-9._~+/=-]{8,}`, flags: 'gi', replace: `$1${MASK}` },
  { name: 'url credentials', pattern: String.raw`(\b[a-z][a-z0-9+.-]*://[^\s:/@]+:)[^\s@/]+@`, flags: 'gi', replace: `$1${MASK}@` },
  { name: 'password flag', pattern: String.raw`(--?(?:password|passwd|pass|token|secret)(?:=|\s+))("[^"]*"|'[^']*'|\S+)`, flags: 'gi', replace: `$1${MASK}` },
  { name: 'secret assignment', pattern: String.raw`((?:password|passwd|pwd|secret|api[_-]?key|token|[a-z0-9]_key)\s*[=:]\s*)("[^"\s]+"|'[^'\s]+'|[^\s&"',;]+)`, flags: 'gi', replace: `$1${MASK}` },
  { name: 'private key', pattern: String.raw`-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----`, flags: 'g' },
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

let cachedKey = '';
let cachedRules = defaultCompiled;

/** Default rules plus the user's extra rules from Settings (cached until they change). */
export function rulesWith(extra: RedactRule[] | null | undefined): { re: RegExp; replace: string }[] {
  if (!extra?.length) return defaultCompiled;
  const key = JSON.stringify(extra);
  if (key !== cachedKey) {
    cachedKey = key;
    cachedRules = [...defaultCompiled, ...compileRules(extra)];
  }
  return cachedRules;
}

const ENV_MASK = MASK + ' (.env file content not stored)';
const WRITE_TOOLS = new Set(['Write', 'Edit', 'MultiEdit', 'NotebookEdit']);

/**
 * Redacts a hook event. Besides the generic rules, anything read from or written to a `.env*` file is dropped entirely.
 */
export function redactHookEvent<T extends Record<string, unknown>>(event: T, compiled = defaultCompiled): T {
  const e = redactValue(event, compiled) as Record<string, unknown>;
  const input = e.tool_input as Record<string, unknown> | undefined;
  if (!input || !isEnvFile(input.file_path ?? input.notebook_path)) return e as T;
  if (e.tool_name === 'Read' && 'tool_response' in e) e.tool_response = ENV_MASK;
  if (WRITE_TOOLS.has(String(e.tool_name))) {
    for (const k of ['content', 'old_string', 'new_string', 'new_source']) if (k in input) input[k] = ENV_MASK;
    if (Array.isArray(input.edits)) input.edits = input.edits.map(() => ({ old_string: ENV_MASK, new_string: ENV_MASK }));
    if ('tool_response' in e) e.tool_response = ENV_MASK;
  }
  return e as T;
}

/**
 * Redacts a transcript JSONL line. Contents read from or written to `.env*` files are dropped: tool_use inputs of
 * writes, and tool_results of reads (matched by id across lines when possible, and by the line's own toolUseResult).
 */
export function redactTranscriptLine(line: string, envToolUseIds: Set<string>, compiled = defaultCompiled): string {
  let obj: unknown;
  try {
    obj = JSON.parse(line);
  } catch {
    return redactText(line, compiled);
  }
  const top = obj as Record<string, unknown> | null;
  const tur = top && typeof top === 'object' ? (top.toolUseResult as Record<string, unknown> | undefined) : undefined;
  const turFile = tur && typeof tur === 'object' ? ((tur.file as Record<string, unknown> | undefined)?.filePath ?? tur.filePath) : undefined;
  const lineIsEnv = isEnvFile(turFile);
  const visit = (v: unknown): void => {
    if (!v || typeof v !== 'object') return;
    if (Array.isArray(v)) return v.forEach(visit);
    const o = v as Record<string, unknown>;
    const input = o.input as Record<string, unknown> | undefined;
    if (o.type === 'tool_use' && input && isEnvFile(input.file_path ?? input.notebook_path)) {
      if (typeof o.id === 'string') envToolUseIds.add(o.id);
      if (WRITE_TOOLS.has(String(o.name))) o.input = { file_path: input.file_path ?? input.notebook_path, content: ENV_MASK };
    }
    if (o.type === 'tool_result' && (lineIsEnv || (typeof o.tool_use_id === 'string' && envToolUseIds.has(o.tool_use_id)))) o.content = ENV_MASK;
    for (const x of Object.values(o)) visit(x);
  };
  visit(obj);
  if (lineIsEnv && tur) top!.toolUseResult = { filePath: turFile, content: ENV_MASK };
  return JSON.stringify(redactValue(obj, compiled));
}
