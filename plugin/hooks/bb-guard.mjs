#!/usr/bin/env node
// Buildyboy guard (SPEC §12.8): a PreToolUse hook on Write, Edit, MultiEdit and NotebookEdit that keeps a factory worker
// out of the paths its package may not change. It applies only in a session started for a package (BB_TASK is set)
// whose worktree holds `.factory/guard.json`, which the runner's `prepare` step writes (runner/kit/steps.ts):
//
//   { "version": 1, "taskId": "P1", "lineFile": "factory.json", "acceptance": "tests/acceptance/P1",
//     "protected": ["factory.json", "tests/acceptance/**", "db/migrations/*.sql", …], "qaRole": "qa" }
//
// Paths are relative to the worktree (the folder that holds `.factory/`), with `/`, and may use `*` (one segment) and
// `**` (any depth); a plain path also covers everything under it. A worker (any BB_ROLE but `qaRole`) may not write the
// line file, the acceptance folder, a protected path or the guard file itself; outside the worktree it is not concerned.
// QA (BB_ROLE = qaRole) may write only inside its acceptance folder.
//
// It is defence in depth: G2 and G5 decide. So it fails open, always: no BB_TASK, no guard file, unreadable input or
// guard, any error → print nothing and exit 0. It never touches the network. Zero dependencies, Node built-ins only.
import { readFileSync, realpathSync, statSync } from 'node:fs';
import { basename, dirname, join, resolve } from 'node:path';

const TOOLS = new Set(['Write', 'Edit', 'MultiEdit', 'NotebookEdit']);
const GUARD_REL = '.factory/guard.json';
/** case-insensitive file systems: compare paths folded to lower case */
const FOLD = process.platform === 'win32' || process.platform === 'darwin';
const fold = (s) => (FOLD ? s.toLowerCase() : s);

function readStdin() {
  return new Promise((done) => {
    const chunks = [];
    const t = setTimeout(() => done(Buffer.concat(chunks).toString('utf8')), 2000);
    process.stdin.on('data', (c) => chunks.push(c));
    process.stdin.on('end', () => {
      clearTimeout(t);
      done(Buffer.concat(chunks).toString('utf8'));
    });
    process.stdin.on('error', () => {
      clearTimeout(t);
      done('');
    });
  });
}

/** The nearest folder at or above `dir` that holds `.factory/guard.json`, or null. */
function findRoot(dir) {
  let d = resolve(dir);
  for (let i = 0; i < 128; i++) {
    try {
      if (statSync(join(d, GUARD_REL)).isFile()) return d;
    } catch {
      // keep going up
    }
    const up = dirname(d);
    if (up === d) return null;
    d = up;
  }
  return null;
}

/** Follows every link in the part of `abs` that exists (a symlink or an 8.3 short name cannot hide a folder), keeps the rest. */
function real(abs) {
  const tail = [];
  let cur = abs;
  for (let i = 0; i < 256; i++) {
    try {
      return join(realpathSync.native(cur), ...tail);
    } catch {
      const up = dirname(cur);
      if (up === cur) return abs;
      tail.unshift(basename(cur));
      cur = up;
    }
  }
  return abs;
}

/**
 * An absolute path in one spelling, with `/`: `.` and `..` resolved against `cwd`, the Windows forms `C:\a`, `C:/a`,
 * `\\?\C:\a` and Git Bash's `/c/a` made the same, and links followed.
 */
function canonical(raw, cwd) {
  let p = String(raw).replace(/\\/g, '/');
  if (process.platform === 'win32') {
    p = p.replace(/^\/\/[?.]\//, '');
    const m = /^\/([a-zA-Z])(\/.*)?$/.exec(p);
    if (m) p = `${m[1]}:${m[2] || '/'}`;
  }
  return real(resolve(cwd, p)).replace(/\\/g, '/').replace(/\/+$/, '');
}

/** `path` relative to `root` (`a/b.ts`), '' for the root itself, or null when it is outside. */
function relativeTo(path, root) {
  const p = fold(path);
  const r = fold(root);
  if (p === r) return '';
  return p.startsWith(`${r}/`) ? path.slice(root.length + 1) : null;
}

/** A guard entry or a relative path in the form we compare: `/`, no leading `./`, no trailing `/`. */
const tidy = (s) => String(s).replace(/\\/g, '/').replace(/^(\.\/)+/, '').replace(/\/+$/, '');
const under = (rel, dir) => !!dir && (fold(rel) === fold(dir) || fold(rel).startsWith(`${fold(dir)}/`));

/** Does the relative path match a guard entry? A plain entry covers itself and everything under it. */
function matches(rel, entry) {
  const e = tidy(entry);
  if (!e) return false;
  if (!e.includes('*')) return under(rel, e);
  const re = e
    .split('**')
    .map((part) => part.split('*').map((x) => x.replace(/[.+^${}()|[\]\\?]/g, '\\$&')).join('[^/]*'))
    .join('.*');
  return new RegExp(`^${re}(/.*)?$`, FOLD ? 'i' : '').test(rel);
}

function deny(reason) {
  return JSON.stringify({ hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision: 'deny', permissionDecisionReason: reason } });
}

/** The hook's output for one input: a deny decision, or '' to stay silent. Throws on anything unexpected (→ fail open). */
function decide(e, env) {
  const task = env.BB_TASK;
  if (!task || !e || typeof e !== 'object' || !TOOLS.has(e.tool_name)) return '';
  const input = e.tool_input && typeof e.tool_input === 'object' ? e.tool_input : {};
  const target = e.tool_name === 'NotebookEdit' ? (input.notebook_path ?? input.file_path) : input.file_path;
  if (typeof target !== 'string' || !target.trim()) return '';
  const cwd = typeof e.cwd === 'string' && e.cwd ? e.cwd : process.cwd();
  const root = findRoot(cwd) ?? findRoot(dirname(canonical(target, cwd)));
  if (!root) return '';
  const g = JSON.parse(readFileSync(join(root, GUARD_REL), 'utf8'));
  if (!g || typeof g !== 'object' || typeof g.acceptance !== 'string' || !Array.isArray(g.protected)) return '';

  const rel = relativeTo(canonical(target, cwd), canonical(root, root));
  const acceptance = tidy(g.acceptance);
  const id = typeof g.taskId === 'string' && g.taskId ? g.taskId : task;
  const qaRole = typeof g.qaRole === 'string' && g.qaRole ? g.qaRole : 'qa';

  if (env.BB_ROLE === qaRole) {
    if (rel !== null && under(rel, acceptance)) return '';
    return deny(
      `Buildyboy guard: QA for ${id} writes only inside its acceptance folder ${acceptance}/, and ${rel ?? target} is outside it. ` +
        'Put the tests there. What the worker must provide for them (a handle, a route, test data) goes into CONTRACT.md in that folder; ' +
        'anything else goes into your final answer.',
    );
  }
  if (rel === null) return '';
  if (fold(rel) === GUARD_REL) {
    return deny(`Buildyboy guard: ${rel} is the factory's guard file, written by the runner for ${id}. Leave it as it is.`);
  }
  const lineFile = typeof g.lineFile === 'string' ? tidy(g.lineFile) : '';
  if (lineFile && fold(rel) === fold(lineFile)) {
    return deny(
      `Buildyboy guard: ${rel} is the project's line file (the factory's commands and gates); a worker may not change it. ` +
        `If ${id}'s specification really asks for this change, finish everything else and end your final message with ` +
        `"FACTORY-STATUS: question <the change you need in ${lineFile}>": the owner decides.`,
    );
  }
  if (under(rel, acceptance)) {
    return deny(
      `Buildyboy guard: ${rel} is one of ${id}'s acceptance tests (${acceptance}/), written by QA before the code and checked by gate G2; ` +
        'a worker never changes them. Make the code pass them. If a test looks wrong, say which one and why in your final message ' +
        '(FACTORY-STATUS: question …) and go on with the rest.',
    );
  }
  const hit = g.protected.find((p) => typeof p === 'string' && matches(rel, p));
  if (!hit) return '';
  const accRoot = /^(.+)\/\*\*$/.exec(tidy(hit));
  if (accRoot && under(acceptance, accRoot[1])) {
    return deny(
      `Buildyboy guard: ${rel} is another package's acceptance test (${tidy(hit)}); a worker may not change it. ` +
        'If your change breaks it, say which test and why in your final message (FACTORY-STATUS: question …).',
    );
  }
  return deny(
    `Buildyboy guard: ${rel} is protected by the project's line file (paths.protected: ${tidy(hit)}); a worker may not change it. ` +
      `If ${id}'s specification really needs it changed, finish everything else and end your final message with ` +
      '"FACTORY-STATUS: question <the change you need>": the owner decides.',
  );
}

let out = '';
(async () => {
  if (!process.env.BB_TASK) return; // not a factory session: nothing to read, nothing to say
  out = decide(JSON.parse(await readStdin()), process.env);
})()
  .catch(() => {
    out = '';
  })
  .finally(() => {
    // pipes are async on POSIX: exit only once stdout has flushed
    if (out) process.stdout.write(out, () => process.exit(0));
    else process.exit(0);
  });
