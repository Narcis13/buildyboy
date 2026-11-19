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
#
# Boot options (opt-in; they need an ELEVATED PowerShell and change nothing unless asked for). Give them as
# switches when the script runs from a checkout, or as environment variables with irm | iex:
#
#   .\deploy\install.ps1 -BootWsl -BootRunner            (from the repo checkout: boot options only)
#   $env:BB_BOOT_WSL='1'; $env:BB_BOOT_RUNNER='1'; irm __BB_URL__/install.ps1 | iex
#
#   -BootWsl      BB_BOOT_WSL=1      Scheduled Task 'Buildyboy WSL (boot)': at startup and every 5 minutes it
#                                    runs `wsl.exe -d <distro> --exec sleep infinity` as you ("run whether
#                                    user is logged on or not", S4U, no stored password). A running wsl
#                                    process keeps the distro, systemd and buildyboy.service up; the repeat
#                                    brings it back if WSL was updated or shut down.
#   -WslDistro X  BB_WSL_DISTRO=X    the distro for -BootWsl (default Ubuntu).
#   -BootRunner   BB_BOOT_RUNNER=1   Scheduled Task 'Buildyboy Runner (boot)': starts the runner at startup,
#                                    before anyone signs in (session 0: claude -p jobs work, hc launches wait
#                                    for a signed-in session). The at-logon runner task is re-registered so
#                                    that it ends the boot runner first when you sign in.
#   -BootOnly     BB_BOOT_ONLY=1     only the boot options: no download, pairing or plugin steps (implied
#                                    when the script runs from a checkout, where the server URL is unknown).
# BB_UNINSTALL=1 removes the boot tasks too.

function Install-Buildyboy {
    param([object[]]$Switches)
    $ErrorActionPreference = 'Stop'
    try { [Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12 } catch { }

    $BbUrl = '__BB_URL__'
    if ($env:BB_URL) { $BbUrl = $env:BB_URL }
    $BbUrl = $BbUrl.TrimEnd('/')

    $BbHome = Join-Path $env:USERPROFILE '.buildyboy'
    if ($env:BUILDYBOY_HOME) { $BbHome = $env:BUILDYBOY_HOME }
    $TaskName = 'BuildyboyRunner'
    $BootWslTask = 'Buildyboy WSL (boot)'
    $BootRunnerTask = 'Buildyboy Runner (boot)'
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

    # ------------------------------------------------------------ boot options
    function Test-Switch($name) {
        foreach ($s in $Switches) { if ("$s" -ieq "-$name") { return $true } }
        return $false
    }
    function Get-SwitchValue($name) {
        for ($i = 0; $i -lt @($Switches).Count - 1; $i++) {
            if ("$($Switches[$i])" -ieq "-$name") { return "$($Switches[$i + 1])" }
        }
        return $null
    }
    $BootWsl = ($env:BB_BOOT_WSL -eq '1') -or (Test-Switch 'BootWsl')
    $BootRunner = ($env:BB_BOOT_RUNNER -eq '1') -or (Test-Switch 'BootRunner')
    $WslDistro = Get-SwitchValue 'WslDistro'
    if (-not $WslDistro) { $WslDistro = $env:BB_WSL_DISTRO }
    if (-not $WslDistro) { $WslDistro = 'Ubuntu' }
    # run from a checkout, the server URL was never substituted: only the boot options make sense then
    $FromCheckout = ($BbUrl -eq ('__BB' + '_URL__'))
    $BootOnly = ($env:BB_BOOT_ONLY -eq '1') -or (Test-Switch 'BootOnly') -or $FromCheckout
    $State = @{ LogonDone = $false }

    function Test-Admin {
        try {
            $id = [Security.Principal.WindowsIdentity]::GetCurrent()
            return ([Security.Principal.WindowsPrincipal]$id).IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)
        } catch { return $false }
    }

    function Find-RepoRoot {
        $repo = $env:BB_REPO
        if (-not $repo -and $PSScriptRoot) { $repo = Split-Path -Parent $PSScriptRoot }
        if ($repo -and (Test-Path (Join-Path $repo 'cli\bb.ts'))) { return $repo }
        return $null
    }

    # The at-logon runner task. With $EndBoot its first action ends the boot runner (Stop-ScheduledTask; it
    # is harmless when that task is not running), so the runner of the signed-in session takes over.
    function Register-RunnerLogonTask($repo, $nodePath, [bool]$EndBoot, [bool]$StartNow) {
        $bb = Join-Path $repo 'cli\bb.ts'
        $actions = @()
        if ($EndBoot) {
            # always exits 0, so the runner action after it runs whether or not the boot runner was running
            $end = "Stop-ScheduledTask -TaskName '$BootRunnerTask' -ErrorAction SilentlyContinue; exit 0"
            $actions += New-ScheduledTaskAction -Execute 'powershell.exe' -Argument "-NoProfile -NonInteractive -WindowStyle Hidden -Command `"$end`""
        }
        $actions += New-ScheduledTaskAction -Execute $nodePath -Argument "`"$bb`" runner" -WorkingDirectory $repo
        $trigger = New-ScheduledTaskTrigger -AtLogOn -User "$($env:USERDOMAIN)\$($env:USERNAME)"
        $settings = New-ScheduledTaskSettingsSet -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries -RestartCount 5 -RestartInterval (New-TimeSpan -Minutes 1) -ExecutionTimeLimit ([TimeSpan]::Zero)
        Register-ScheduledTask -TaskName $TaskName -Action $actions -Trigger $trigger -Settings $settings -Description 'Buildyboy runner' -Force | Out-Null
        if ($StartNow) { Start-ScheduledTask -TaskName $TaskName }
        $State.LogonDone = $true
    }

    function Install-BootOptions {
        Step 'Installing the boot options (Scheduled Tasks that run at startup, before anyone signs in)'
        if (-not (Test-Admin)) {
            Warn 'the boot options need an elevated PowerShell (Run as administrator); skipping them.'
            Note 'Everything else was installed. For the boot options, open PowerShell as administrator and run:'
            Note '  .\deploy\install.ps1 -BootWsl -BootRunner        (from the repo checkout)'
            return
        }
        $me = "$($env:USERDOMAIN)\$($env:USERNAME)"
        # S4U: "run whether user is logged on or not" without a stored password (no network credentials)
        $principal = New-ScheduledTaskPrincipal -UserId $me -LogonType S4U -RunLevel Limited

        if ($BootWsl) {
            try {
                if ($WslDistro -notmatch '^[A-Za-z0-9][A-Za-z0-9._-]*$') { throw "unusable distro name '$WslDistro'" }
                $wsl = Join-Path $env:SystemRoot 'System32\wsl.exe'
                if (-not (Test-Path $wsl)) { throw 'wsl.exe was not found' }
                $action = New-ScheduledTaskAction -Execute $wsl -Argument "-d $WslDistro --exec sleep infinity"
                $trigger = New-ScheduledTaskTrigger -AtStartup
                # repeat every 5 minutes, indefinitely (the repetition of a throwaway -Once trigger)
                $rep = New-ScheduledTaskTrigger -Once -At (Get-Date) -RepetitionInterval (New-TimeSpan -Minutes 5)
                $trigger.Repetition = $rep.Repetition
                $settings = New-ScheduledTaskSettingsSet -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries -StartWhenAvailable -MultipleInstances IgnoreNew -ExecutionTimeLimit ([TimeSpan]::Zero)
                Register-ScheduledTask -TaskName $BootWslTask -Action $action -Trigger $trigger -Principal $principal -Settings $settings -Description "Keeps the WSL distro $WslDistro (and so buildyboy.service) running from boot" -Force | Out-Null
                Note "Scheduled Task '$BootWslTask' registered (at startup and every 5 minutes: wsl.exe -d $WslDistro --exec sleep infinity)"
                try {
                    Start-ScheduledTask -TaskName $BootWslTask
                    Note 'started it now'
                } catch {
                    Warn "registered, but it could not be started now ($($_.Exception.Message)); it starts at the next boot"
                }
            } catch {
                Warn "could not register '$BootWslTask' ($($_.Exception.Message))"
                Note 'If S4U is refused on this WSL or Windows version, register it as "Run only when user is logged on" (it then starts at logon only) or store your password in the task.'
            }
        }

        if ($BootRunner) {
            try {
                $repo = Find-RepoRoot
                $node = (Get-Command node -ErrorAction SilentlyContinue)
                if (-not $repo) { throw 'the runner needs the app code: set BB_REPO to a checkout of the repo, or run this script from it' }
                if (-not $node) { throw 'node is required for the runner' }
                $bb = Join-Path $repo 'cli\bb.ts'
                $action = New-ScheduledTaskAction -Execute $node.Source -Argument "`"$bb`" runner" -WorkingDirectory $repo
                $trigger = New-ScheduledTaskTrigger -AtStartup
                $settings = New-ScheduledTaskSettingsSet -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries -RestartCount 5 -RestartInterval (New-TimeSpan -Minutes 1) -ExecutionTimeLimit ([TimeSpan]::Zero)
                Register-ScheduledTask -TaskName $BootRunnerTask -Action $action -Trigger $trigger -Principal $principal -Settings $settings -Description 'Buildyboy runner at startup (session 0, before anyone signs in)' -Force | Out-Null
                Note "Scheduled Task '$BootRunnerTask' registered (at startup; no desktop session: claude -p jobs work, hc launches wait for a signed-in session)"
                if (-not $State.LogonDone) {
                    Register-RunnerLogonTask $repo $node.Source $true $false
                    Note "re-registered '$TaskName' so that it ends '$BootRunnerTask' first when you sign in (that stops any claude -p job the boot runner was running; the server marks it lost)"
                }
                Note 'the boot runner starts at the next boot; a runner you already have running is left alone'
            } catch {
                Warn "could not register '$BootRunnerTask' ($($_.Exception.Message))"
            }
        }
        Note "Check with: Get-ScheduledTask 'Buildyboy*'   and   wsl -l -v"
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
        foreach ($t in @($BootRunnerTask, $BootWslTask)) {
            if (Get-ScheduledTask -TaskName $t -ErrorAction SilentlyContinue) {
                try {
                    # The boot runner stops with its task. The WSL keep-alive keeps running until the next restart:
                    # stopping it would let WSL, and the Buildyboy server inside it, shut down.
                    if ($t -eq $BootRunnerTask) { Stop-ScheduledTask -TaskName $t -ErrorAction SilentlyContinue }
                    Unregister-ScheduledTask -TaskName $t -Confirm:$false
                    Note "removed the Scheduled Task '$t'"
                } catch {
                    Warn "could not remove '$t' ($($_.Exception.Message)); try again from an elevated PowerShell"
                }
            }
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

    if ($BootOnly) {
        if (-not ($BootWsl -or $BootRunner)) {
            throw 'Nothing to do: pass -BootWsl and/or -BootRunner (or set BB_BOOT_WSL=1 / BB_BOOT_RUNNER=1).'
        }
        Install-BootOptions
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
                Register-RunnerLogonTask $repo $node.Source $BootRunner $true
                Note "Scheduled Task '$TaskName' registered and started"
            } catch {
                Warn "could not create the Scheduled Task ($($_.Exception.Message)); using a Startup-folder entry instead"
                $line = "@echo off`r`nstart `"`" /min `"$($node.Source)`" `"$bb`" runner`r`n"
                [System.IO.File]::WriteAllText($StartupCmd, $line)
                Note "wrote $StartupCmd (runs at your next logon)"
            }
        }
    }

    # ------------------------------------------------------- 4b. boot options
    if ($BootWsl -or $BootRunner) { Install-BootOptions }

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
    Install-Buildyboy -Switches $args
} catch {
    Write-Host ''
    Write-Host "ERROR: $($_.Exception.Message)" -ForegroundColor Red
}
