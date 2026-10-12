# Buildyboy client installer for Windows (PowerShell 5.1 or newer).
#
#   $env:BB_CODE='<PAIRCODE>'; irm __BB_URL__/install.ps1 | iex
#   $env:BB_UNINSTALL='1'; irm __BB_URL__/install.ps1 | iex
#
# What it does:
#   1. downloads the plugin marketplace tarball (__BB_URL__/plugin.tgz) to ~\.buildyboy\marketplace
#   2. pairs this machine with the one-time code and writes ~\.buildyboy\config.json
#   3. registers the plugin with `claude plugin marketplace add` + `claude plugin install`
#      (~\.claude\settings.json is never edited directly)
#   4. with $env:BB_RUNNER='1' and $env:BB_REPO pointing at a checkout of the repo: registers
#      `bb runner` as a Scheduled Task that starts at logon
#   5. sends a test event to the server
#
# Environment: BB_CODE, BB_RUNNER, BB_REPO, BB_NAME (machine name), BB_UNINSTALL, BB_YES (skip the
# delete confirmation), BB_URL (override the server), BUILDYBOY_HOME (default ~\.buildyboy),
# BB_SKIP_CLAUDE=1 (do not call the claude CLI; for tests).

function Install-Buildyboy {
    $ErrorActionPreference = 'Stop'
    try { [Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12 } catch { }

    $BbUrl = '__BB_URL__'
    if ($env:BB_URL) { $BbUrl = $env:BB_URL }
    $BbUrl = $BbUrl.TrimEnd('/')

    $BbHome = Join-Path $env:USERPROFILE '.buildyboy'
    if ($env:BUILDYBOY_HOME) { $BbHome = $env:BUILDYBOY_HOME }
    $TaskName = 'BuildyboyRunner'
    $StartupCmd = Join-Path $env:APPDATA 'Microsoft\Windows\Start Menu\Programs\Startup\buildyboy-runner.cmd'

    function Say($msg) { Write-Host $msg }
    function Step($msg) { Write-Host ''; Write-Host "==> $msg" -ForegroundColor Cyan }
    function Note($msg) { Write-Host "    $msg" }
    function Warn($msg) { Write-Host "WARN: $msg" -ForegroundColor Yellow }

    function Use-Claude {
        if ($env:BB_SKIP_CLAUDE -eq '1') { return $false }
        return [bool](Get-Command claude -ErrorAction SilentlyContinue)
    }

    function Get-BbArch {
        $a = $env:PROCESSOR_ARCHITECTURE
        if ($a -eq 'AMD64') { return 'x64' }
        if ($a -eq 'ARM64') { return 'arm64' }
        return $a.ToLower()
    }

    function Write-Utf8NoBom($path, $text) {
        [System.IO.File]::WriteAllText($path, $text, (New-Object System.Text.UTF8Encoding($false)))
    }

    # ---------------------------------------------------------------- uninstall
    if ($env:BB_UNINSTALL -eq '1') {
        Step 'Uninstalling Buildyboy from this machine'
        if (Use-Claude) {
            & claude plugin uninstall 'buildyboy@buildyboy'
            if ($LASTEXITCODE -ne 0) { Warn 'claude plugin uninstall failed (already removed?)' }
            & claude plugin marketplace remove buildyboy
            if ($LASTEXITCODE -ne 0) { Warn 'claude plugin marketplace remove failed (already removed?)' }
        } else {
            Note 'claude CLI skipped; to finish by hand run:'
            Note '  claude plugin uninstall buildyboy@buildyboy; claude plugin marketplace remove buildyboy'
        }
        if (Get-ScheduledTask -TaskName $TaskName -ErrorAction SilentlyContinue) {
            Unregister-ScheduledTask -TaskName $TaskName -Confirm:$false
            Note 'removed the runner Scheduled Task'
        }
        if (Test-Path $StartupCmd) {
            Remove-Item -Force $StartupCmd
            Note 'removed the runner Startup entry'
        }
        if (Test-Path $BbHome) {
            $yes = ($env:BB_YES -eq '1')
            if (-not $yes) {
                $reply = Read-Host "Delete $BbHome (config, token, marketplace, spool)? [y/N]"
                $yes = ($reply -match '^(y|yes)$')
            }
            if ($yes) {
                Remove-Item -Recurse -Force $BbHome
                Note "removed $BbHome"
            } else {
                Note "kept $BbHome (delete it with: Remove-Item -Recurse -Force '$BbHome')"
            }
        }
        Say ''
        Say 'Done. Revoke this machine on the server (Machines page) so its token stops working.'
        return
    }

    $Code = $env:BB_CODE
    $Cfg = Join-Path $BbHome 'config.json'
    if (-not $Code -and -not (Test-Path $Cfg)) {
        throw "No pairing code. Create one on the Machines page, then: `$env:BB_CODE='<PAIRCODE>'; irm $BbUrl/install.ps1 | iex"
    }
    if (-not (Get-Command tar -ErrorAction SilentlyContinue)) {
        throw 'tar.exe was not found (it ships with Windows 10 1803 and newer).'
    }

    # ------------------------------------------------------- 1. the marketplace
    Step "Downloading the plugin from $BbUrl/plugin.tgz"
    $tmp = Join-Path ([System.IO.Path]::GetTempPath()) ('buildyboy-' + [Guid]::NewGuid().ToString('N'))
    New-Item -ItemType Directory -Path $tmp | Out-Null
    try {
        $tgz = Join-Path $tmp 'plugin.tgz'
        Invoke-WebRequest -UseBasicParsing -Uri "$BbUrl/plugin.tgz" -OutFile $tgz
        $mp = Join-Path $tmp 'mp'
        New-Item -ItemType Directory -Path $mp | Out-Null
        & tar -xzf $tgz -C $mp
        if ($LASTEXITCODE -ne 0) { throw 'The plugin tarball could not be extracted.' }
        if (-not (Test-Path (Join-Path $mp '.claude-plugin\marketplace.json'))) {
            throw 'The tarball has no .claude-plugin/marketplace.json.'
        }
        New-Item -ItemType Directory -Force -Path $BbHome | Out-Null
        $dest = Join-Path $BbHome 'marketplace'
        if (Test-Path $dest) { Remove-Item -Recurse -Force $dest }
        Move-Item -Path $mp -Destination $dest
        Note "marketplace extracted to $dest"
    } finally {
        Remove-Item -Recurse -Force $tmp -ErrorAction SilentlyContinue
    }

    # ------------------------------------------------------------- 2. pairing
    Step 'Pairing this machine'
    if (-not $Code) {
        Note "already paired ($Cfg exists); set BB_CODE to pair again"
    } else {
        $payload = @{
            code     = $Code
            hostname = $env:COMPUTERNAME
            platform = 'win32'
            arch     = (Get-BbArch)
            user     = $env:USERNAME
        }
        if ($env:BB_NAME) { $payload['name'] = $env:BB_NAME }
        try {
            $res = Invoke-RestMethod -Method Post -Uri "$BbUrl/api/pair" -ContentType 'application/json; charset=utf-8' -Body ($payload | ConvertTo-Json)
        } catch {
            $detail = $_.Exception.Message
            if ($_.ErrorDetails -and $_.ErrorDetails.Message) { $detail = $_.ErrorDetails.Message }
            throw "Pairing failed: $detail (codes are single use and expire after 10 minutes)"
        }
        if (-not $res.token -or -not $res.machineId) { throw 'Unexpected pairing response.' }
        $url = $BbUrl
        if ($res.url) { $url = $res.url }
        $json = (@{ url = $url; token = $res.token; machineId = $res.machineId } | ConvertTo-Json)
        Write-Utf8NoBom $Cfg $json
        try {
            & icacls $Cfg /inheritance:r /grant:r "$($env:USERDOMAIN)\$($env:USERNAME):(R,W)" | Out-Null
        } catch {
            Warn "could not restrict permissions on $Cfg"
        }
        Note "paired as machine $($res.machineId); wrote $Cfg"
    }

    # ---------------------------------------------------------------- 3. plugin
    Step 'Registering the Claude Code plugin'
    $mpPath = Join-Path $BbHome 'marketplace'
    if (Use-Claude) {
        & claude plugin marketplace add $mpPath
        if ($LASTEXITCODE -ne 0) {
            Warn 'marketplace add failed (already added?); refreshing it instead'
            & claude plugin marketplace update buildyboy
        }
        & claude plugin install 'buildyboy@buildyboy'
        if ($LASTEXITCODE -ne 0) {
            Warn 'plugin install failed (already installed?); trying an update'
            & claude plugin update 'buildyboy@buildyboy'
            if ($LASTEXITCODE -ne 0) { Warn 'could not install or update the plugin; run the commands above by hand' }
        }
        if (-not (Get-Command node -ErrorAction SilentlyContinue)) {
            Warn "node was not found on PATH: the plugin's hook script needs Node to run"
        }
    } else {
        Note 'the claude CLI was not found (or BB_SKIP_CLAUDE=1). Install Claude Code, then run:'
        Note "  claude plugin marketplace add `"$mpPath`""
        Note '  claude plugin install buildyboy@buildyboy'
    }

    # ---------------------------------------------------------------- 4. runner
    if ($env:BB_RUNNER -eq '1') {
        Step 'Installing the runner (Scheduled Task at logon)'
        $repo = $env:BB_REPO
        if (-not $repo -or -not (Test-Path (Join-Path $repo 'cli\bb.ts'))) {
            Note 'the runner needs the app code. Clone the repo and point BB_REPO at it, then re-run:'
            Note '  git clone https://github.com/Narcis13/buildyboy; cd buildyboy; npm ci'
            Note "  `$env:BB_RUNNER='1'; `$env:BB_REPO=(Get-Location).Path; irm $BbUrl/install.ps1 | iex"
        } else {
            $node = (Get-Command node -ErrorAction SilentlyContinue)
            if (-not $node) { throw 'node is required for the runner.' }
            $bb = Join-Path $repo 'cli\bb.ts'
            try {
                $action = New-ScheduledTaskAction -Execute $node.Source -Argument "`"$bb`" runner" -WorkingDirectory $repo
                $trigger = New-ScheduledTaskTrigger -AtLogOn -User "$($env:USERDOMAIN)\$($env:USERNAME)"
                $settings = New-ScheduledTaskSettingsSet -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries -RestartCount 5 -RestartInterval (New-TimeSpan -Minutes 1) -ExecutionTimeLimit ([TimeSpan]::Zero)
                Register-ScheduledTask -TaskName $TaskName -Action $action -Trigger $trigger -Settings $settings -Description 'Buildyboy runner' -Force | Out-Null
                Start-ScheduledTask -TaskName $TaskName
                Note "Scheduled Task '$TaskName' registered and started"
            } catch {
                Warn "could not create the Scheduled Task ($($_.Exception.Message)); using a Startup-folder entry instead"
                $line = "@echo off`r`nstart `"`" /min `"$($node.Source)`" `"$bb`" runner`r`n"
                [System.IO.File]::WriteAllText($StartupCmd, $line)
                Note "wrote $StartupCmd (runs at your next logon)"
            }
        }
    }

    # ------------------------------------------------------------ 5. test event
    Step 'Sending a test event'
    $conf = Get-Content -Raw -Path $Cfg | ConvertFrom-Json
    $evUrl = $BbUrl
    if ($conf.url) { $evUrl = $conf.url }
    $body = @{
        envelopes = @(
            @{
                v           = 1
                ts          = [DateTimeOffset]::UtcNow.ToUnixTimeMilliseconds()
                env         = @{}
                hostname    = $env:COMPUTERNAME
                platform    = 'win32'
                user        = $env:USERNAME
                pid         = $PID
                ppid        = 0
                hookVersion = 'install'
                event       = @{
                    session_id      = "install-test-$($conf.machineId)"
                    hook_event_name = 'BuildyboyInstallTest'
                }
            }
        )
    } | ConvertTo-Json -Depth 6
    try {
        Invoke-RestMethod -Method Post -Uri "$evUrl/api/ingest" -ContentType 'application/json; charset=utf-8' -Headers @{ Authorization = "Bearer $($conf.token)" } -Body $body | Out-Null
        Note "test event accepted by $evUrl"
    } catch {
        Warn "the server rejected the test event: $($_.Exception.Message)"
    }

    Say ''
    Say "Buildyboy is installed on $($env:COMPUTERNAME). Start a new Claude Code session; it should appear on $BbUrl."
}

try {
    Install-Buildyboy
} catch {
    Write-Host ''
    Write-Host "ERROR: $($_.Exception.Message)" -ForegroundColor Red
}
