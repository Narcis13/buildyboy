<#
.SYNOPSIS
  Check that <name>.contzo.lol resolves to the WSL host, the way the internet sees it.

.EXAMPLE
  powershell -NoProfile -ExecutionPolicy Bypass -File check-dns.ps1 -Name edgy

  Asks Namecheap's own nameservers first (the source of truth, no caching), then
  Cloudflare and Google. Also detects a *.contzo.lol wildcard record, the
  "Host field holds the full name" mistake, and whether this PC's hosts file maps
  the name to 127.0.0.1 (needed here, because this PC cannot reach its own public IP).

  Exit code 0 when the authoritative answer is the expected IP, 1 otherwise.
#>
param(
  [Parameter(Mandatory = $true)][string]$Name,
  [string]$Zone = 'contzo.lol',
  [string]$ExpectedIp = '109.99.176.213'
)

$fqdn = if ($Name -like "*.$Zone") { $Name } else { "$Name.$Zone" }
$label = $fqdn.Substring(0, $fqdn.Length - $Zone.Length - 1)

# Returns the A records, an empty array for "name does not exist", or $null when the
# query itself failed (timeout, unreachable server) so that is never mistaken for NXDOMAIN.
function Get-A([string]$host_, [string]$server) {
  try {
    $r = Resolve-DnsName -Name $host_ -Type A -Server $server -DnsOnly -QuickTimeout -ErrorAction Stop
    return , @($r | Where-Object { $_.Type -eq 'A' } | ForEach-Object { $_.IPAddress })
  } catch {
    if ($_.FullyQualifiedErrorId -like 'DNS_ERROR_RCODE_NAME_ERROR*' -or $_.Exception.Message -match 'does not exist') { return , @() }
    $script:lastError = $_.Exception.Message
    return $null
  }
}

Write-Host "DNS check for $fqdn (expected $ExpectedIp)"
$ok = $false
foreach ($server in 'dns1.registrar-servers.com', 'dns2.registrar-servers.com', '1.1.1.1', '8.8.8.8') {
  $ips = Get-A $fqdn $server
  if ($null -eq $ips) { $shown = "query failed: $script:lastError"; $mark = '?? ' }
  elseif ($ips.Count) { $shown = $ips -join ', '; $mark = if ($ips -contains $ExpectedIp) { 'OK ' } else { '-- ' } }
  else { $shown = 'does not exist'; $mark = '-- ' }
  Write-Host ("  {0}{1,-28} {2}" -f $mark, $server, $shown)
  # Namecheap's own servers are the source of truth; either one answering right is enough.
  if ($server -like 'dns*' -and $null -ne $ips -and ($ips -contains $ExpectedIp)) { $ok = $true }
}

$probe = 'zz-wildcard-probe-' + (Get-Random -Maximum 99999) + ".$Zone"
$wild = Get-A $probe 'dns1.registrar-servers.com'
if ($null -eq $wild) {
  Write-Host "  wildcard check failed (dns1 did not answer)"
} elseif ($wild.Count) {
  Write-Host "  wildcard *.$Zone exists ($($wild -join ', ')): every new subdomain already resolves"
} else {
  Write-Host "  no wildcard *.$Zone record: each subdomain needs its own A record"
}

$double = Get-A "$fqdn.$Zone" 'dns1.registrar-servers.com'
if ($null -ne $double -and $double.Count -and -not $ok) {
  Write-Host "  MISTAKE: '$fqdn.$Zone' exists. In Namecheap the Host field must be just '$label', not the full name."
}

$hostsFile = "$env:SystemRoot\System32\drivers\etc\hosts"
$mapped = Select-String -Path $hostsFile -Pattern "^\s*127\.0\.0\.1\s.*(\s|^)$([regex]::Escape($fqdn))(\s|$)" -Quiet
if ($mapped) {
  Write-Host "  hosts file: $fqdn -> 127.0.0.1 (browsers on this PC can open it)"
} else {
  Write-Host "  hosts file: no entry. On this PC the site will time out until one is added (add-hosts-entry.ps1)."
}

if ($ok) { Write-Host 'Verdict: DNS is live.'; exit 0 }
Write-Host "Verdict: not live yet. Namecheap > Domain List > $Zone > Manage > Advanced DNS > Add New Record:"
Write-Host "  Type A Record | Host $label | Value $ExpectedIp | TTL Automatic, then click the green checkmark."
exit 1
