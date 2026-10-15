<#
.SYNOPSIS
  Map <name>.contzo.lol to 127.0.0.1 in this PC's hosts file (or remove the mapping).

.DESCRIPTION
  This Windows machine owns the public IP the contzo.lol names point at, but it
  cannot connect to that IP from itself, so browsers here time out on every
  contzo.lol site. Mapping the name to 127.0.0.1 sends local requests straight to
  Caddy inside WSL (mirrored networking), which serves the same site with the
  same certificate. Other devices keep using public DNS.

  Needs administrator rights: when not elevated it relaunches itself through a
  UAC prompt, which the user approves.

.EXAMPLE
  powershell -NoProfile -ExecutionPolicy Bypass -File add-hosts-entry.ps1 -Name edgy
  powershell -NoProfile -ExecutionPolicy Bypass -File add-hosts-entry.ps1 -Name edgy -Remove
#>
param(
  [Parameter(Mandatory = $true)][string]$Name,
  [string]$Zone = 'contzo.lol',
  [switch]$Remove
)

$fqdn = if ($Name -like "*.$Zone") { $Name } else { "$Name.$Zone" }
$hostsFile = "$env:SystemRoot\System32\drivers\etc\hosts"

$principal = New-Object Security.Principal.WindowsPrincipal([Security.Principal.WindowsIdentity]::GetCurrent())
if (-not $principal.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)) {
  $argList = @('-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', "`"$PSCommandPath`"", '-Name', $fqdn, '-Zone', $Zone)
  if ($Remove) { $argList += '-Remove' }
  Write-Host "Asking for administrator rights (UAC) to edit $hostsFile ..."
  $p = Start-Process -FilePath 'powershell.exe' -ArgumentList $argList -Verb RunAs -Wait -PassThru
  if ($p.ExitCode -ne 0) { Write-Host "The elevated run failed (exit $($p.ExitCode))."; exit $p.ExitCode }
  # Report the result from the non-elevated side, where the caller sees output.
  $now = Select-String -Path $hostsFile -Pattern "(\s)$([regex]::Escape($fqdn))(\s|$)" -Quiet
  if ($Remove) { Write-Host $(if ($now) { "Still present: $fqdn" } else { "Removed: $fqdn" }) }
  else { Write-Host $(if ($now) { "OK: $fqdn -> 127.0.0.1" } else { "Not added: $fqdn" }) }
  exit 0
}

$lines = [System.Collections.Generic.List[string]](Get-Content -Path $hostsFile)
$pattern = "^\s*127\.0\.0\.1\s.*(\s)$([regex]::Escape($fqdn))(\s|$)"

if ($Remove) {
  $out = foreach ($l in $lines) {
    if ($l -match $pattern) {
      $rest = ($l -split '\s+' | Where-Object { $_ -and $_ -ne $fqdn })
      if ($rest.Count -gt 1) { $rest -join ' ' }  # keep other names on that line
    } else { $l }
  }
  Set-Content -Path $hostsFile -Value $out -Encoding ASCII
} elseif (-not ($lines | Where-Object { $_ -match $pattern })) {
  # Join the existing contzo line if there is one, so the file stays tidy.
  $idx = -1
  for ($i = 0; $i -lt $lines.Count; $i++) {
    if ($lines[$i] -match "^\s*127\.0\.0\.1\s+.*$([regex]::Escape($Zone))") { $idx = $i; break }
  }
  if ($idx -ge 0) { $lines[$idx] = $lines[$idx].TrimEnd() + " $fqdn" } else { $lines.Add("127.0.0.1 $fqdn") }
  Set-Content -Path $hostsFile -Value $lines -Encoding ASCII
}
ipconfig /flushdns | Out-Null
exit 0
