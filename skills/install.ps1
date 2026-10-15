<#
.SYNOPSIS
  Install the skills in this folder globally for Claude Code on this machine.

.DESCRIPTION
  Each skill folder (one containing SKILL.md) is linked, not copied, so edits in
  this repo take effect everywhere at once:
    Windows: %USERPROFILE%\.claude\skills\<skill>  -> directory junction (no admin needed)
    WSL:     ~/.claude/skills/<skill>              -> symlink to /mnt/c/... (if WSL is installed)
  Idempotent. Refuses to replace a real folder of the same name.

.EXAMPLE
  powershell -NoProfile -ExecutionPolicy Bypass -File skills\install.ps1
  powershell -NoProfile -ExecutionPolicy Bypass -File skills\install.ps1 -Uninstall
#>
param([switch]$Uninstall, [string]$Distro = 'Ubuntu')

$ErrorActionPreference = 'Stop'
$here = Split-Path -Parent $MyInvocation.MyCommand.Path
$skills = Get-ChildItem -Path $here -Directory | Where-Object { Test-Path (Join-Path $_.FullName 'SKILL.md') }
$winTarget = Join-Path $env:USERPROFILE '.claude\skills'
New-Item -ItemType Directory -Force -Path $winTarget | Out-Null

$haveWsl = $false
try { & wsl.exe -d $Distro -e true 2>$null; $haveWsl = ($LASTEXITCODE -eq 0) } catch { }

foreach ($s in $skills) {
  $link = Join-Path $winTarget $s.Name
  $existing = Get-Item -LiteralPath $link -Force -ErrorAction SilentlyContinue
  if ($existing -and -not $existing.LinkType) {
    Write-Host "SKIP  $link is a real folder, not a link; remove it yourself if it is an old copy"
  } elseif ($Uninstall) {
    if ($existing) { $existing.Delete(); Write-Host "unlinked  $link" }
  } else {
    if ($existing) { $existing.Delete() }
    New-Item -ItemType Junction -Path $link -Target $s.FullName | Out-Null
    Write-Host "linked    $link -> $($s.FullName)"
  }

  if ($haveWsl) {
    # C:\a\b -> /mnt/c/a/b
    $drive = $s.FullName.Substring(0, 1).ToLower()
    $wslSrc = "/mnt/$drive" + ($s.FullName.Substring(2) -replace '\\', '/')
    $name = $s.Name
    if ($Uninstall) {
      & wsl.exe -d $Distro -e sh -c "if [ -L ~/.claude/skills/$name ]; then rm ~/.claude/skills/$name && echo 'unlinked  WSL ~/.claude/skills/$name'; fi"
    } else {
      & wsl.exe -d $Distro -e sh -c "mkdir -p ~/.claude/skills && if [ -e ~/.claude/skills/$name ] && [ ! -L ~/.claude/skills/$name ]; then echo 'SKIP  WSL ~/.claude/skills/$name is a real folder'; else ln -sfn '$wslSrc' ~/.claude/skills/$name && echo 'linked    WSL ~/.claude/skills/$name -> $wslSrc'; fi"
    }
  }
}
if (-not $haveWsl) { Write-Host "(WSL distro '$Distro' not reachable: linked on Windows only)" }
Write-Host 'Start a new Claude Code session to pick the skills up.'
