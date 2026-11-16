// Stops the leftover processes of a package before and after a step (SPEC §12.4): an orphaned dev server is reused by the
// next test run and gives false failures. Two targets only: processes whose command line names a file inside the
// package's worktree (`<worktree>\…` or `<worktree>/…`, so P1 never matches P10), and the process listening on the
// package's port. Windows: PowerShell with CIM and Get-NetTCPConnection (as arond's opreste-procese.sh); elsewhere `ps`
// and `lsof`. The values reach PowerShell through the environment, never through its script. A process is never matched
// by its working directory: the worker's interactive claude lives in the worktree and must survive the gates.
import { execFile } from 'node:child_process';
import { resolve, sep } from 'node:path';

const WIN = process.platform === 'win32';

const PS_SCRIPT = `
$ErrorActionPreference = 'SilentlyContinue'
$wt = $env:BB_STOP_WT; $port = $env:BB_STOP_PORT; $keep = @([int]$env:BB_STOP_SELF, [int]$env:BB_STOP_PARENT, $PID, 0, 4)
$targets = @()
if ($wt) {
  $e = [Management.Automation.WildcardPattern]::Escape($wt.TrimEnd([char[]]'\\/'))
  $f = $e.Replace('\\', '/'); $b = $e.Replace('/', '\\')
  $targets += @(Get-CimInstance Win32_Process | Where-Object {
    $_.CommandLine -and ($_.CommandLine -like "*$b\\*" -or $_.CommandLine -like "*$f/*")
  } | ForEach-Object { [int]$_.ProcessId })
}
if ($port) { $targets += @(Get-NetTCPConnection -LocalPort ([int]$port) -State Listen | ForEach-Object { [int]$_.OwningProcess }) }
$killed = @()
foreach ($p in ($targets | Where-Object { $keep -notcontains $_ } | Sort-Object -Unique)) { try { Stop-Process -Id $p -Force -ErrorAction Stop; $killed += $p } catch {} }
ConvertTo-Json -Compress @($killed)
`;

function run(cmd: string, args: string[], env?: NodeJS.ProcessEnv, timeoutMs = 60_000): Promise<string> {
  return new Promise((res) => {
    execFile(cmd, args, { env: env ?? process.env, timeout: timeoutMs, windowsHide: true, maxBuffer: 8 * 1024 * 1024, shell: false }, (_e, stdout) => res(String(stdout ?? '')));
  });
}

const portOk = (p: unknown) => /^\d{1,5}$/.test(String(p ?? '')) && +String(p) >= 1 && +String(p) <= 65535;

/** Kills the leftovers of a worktree and a port; returns the pids it stopped. Never throws. */
export async function stopLeftovers(o: { worktree?: string | null; port?: string | number | null }): Promise<number[]> {
  const wt = o.worktree ? resolve(o.worktree) : '';
  const port = portOk(o.port) ? String(o.port) : '';
  if ((!wt || wt.length < 4) && !port) return [];
  try {
    return WIN ? await stopWindows(wt, port) : await stopPosix(wt, port);
  } catch {
    return [];
  }
}

async function stopWindows(wt: string, port: string): Promise<number[]> {
  const ps = `${process.env.SystemRoot ?? 'C:\\Windows'}\\System32\\WindowsPowerShell\\v1.0\\powershell.exe`;
  const env = { ...process.env, BB_STOP_WT: wt, BB_STOP_PORT: port, BB_STOP_SELF: String(process.pid), BB_STOP_PARENT: String(process.ppid) };
  const out = await run(ps, ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command', PS_SCRIPT], env);
  const m = out.trim().split(/\r?\n/).pop() ?? '';
  try {
    const j = JSON.parse(m);
    return (Array.isArray(j) ? j : [j]).filter((n) => typeof n === 'number');
  } catch {
    return [];
  }
}

async function stopPosix(wt: string, port: string): Promise<number[]> {
  const keep = new Set([process.pid, process.ppid, 0, 1]);
  const targets = new Set<number>();
  if (wt) {
    for (const line of (await run('ps', ['-eo', 'pid=,args='])).split('\n')) {
      const m = /^\s*(\d+)\s+(.*)$/.exec(line);
      if (!m) continue;
      if (m[2].includes(wt + sep)) targets.add(+m[1]);
    }
  }
  if (port) for (const s of (await run('lsof', ['-nP', '-t', `-iTCP:${port}`, '-sTCP:LISTEN'])).split('\n')) if (/^\d+$/.test(s.trim())) targets.add(+s.trim());
  const killed: number[] = [];
  for (const pid of targets) {
    if (keep.has(pid)) continue;
    try {
      process.kill(pid, 'SIGKILL');
      killed.push(pid);
    } catch {
      // already gone
    }
  }
  return killed;
}
