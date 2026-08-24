<#
  The worker, as a startup item, so nobody has to keep a PowerShell window open.

  The worker is the half that lets a decider anywhere - Claude on a phone, in a browser, in a connector - run
  a GOAL skill on THIS machine. A recorded skill is a body of coordinates and the agent replays it by itself;
  a created skill needs a model in the loop, one action a turn, and the agent has no model in it. So that
  path goes through here. It asks the account for work, does it through the local agent, and reports back.
  The direction never reverses, which is why there is no inbound path to this computer at all.

  This mirrors mcp/install-worker-mac.sh, which is the reference. Where the two differ it is because the
  platforms do: launchd has KeepAlive and a plist, Windows has the Startup folder and a .cmd, and a
  Startup-folder item is started once at sign-in and NOT restarted if it dies. That difference is real and
  is stated below rather than papered over.

    powershell -ExecutionPolicy Bypass -File mcp\install-worker-windows.ps1              install
    powershell -ExecutionPolicy Bypass -File mcp\install-worker-windows.ps1 -Status      is it running
    powershell -ExecutionPolicy Bypass -File mcp\install-worker-windows.ps1 -Uninstall   take it off

  THE TOKEN. It is a device token - Settings -> My account -> Pair a device, shown once - and it ends up in
  the .cmd, which is a file in your own profile. That is the same exposure as any credential in a startup
  script or an env file, and it is worth knowing rather than discovering: anybody who can read your profile
  can read it. Revoke it in the app if that stops being acceptable.
#>
[CmdletBinding()]
param(
    [switch]$Status,
    [switch]$Uninstall,
    # Taken from the environment when it is set, so an unattended install never has to be typed into.
    [string]$Token = $env:MOUSEFLOW_TOKEN,
    [string]$Url = $(if ($env:MOUSEFLOW_URL) { $env:MOUSEFLOW_URL } else { 'https://mouseflowapp.vercel.app' }),
    [int]$AgentPort = $(if ($env:MOUSEFLOW_AGENT_PORT) { [int]$env:MOUSEFLOW_AGENT_PORT } else { 8787 })
)

$ErrorActionPreference = 'Stop'

$Repo    = Split-Path -Parent (Split-Path -Parent $MyInvocation.MyCommand.Path)
$Worker  = Join-Path $Repo 'mcp\worker.mjs'
$Startup = [Environment]::GetFolderPath('Startup')
$CmdFile = Join-Path $Startup 'MouseFlowWorker.cmd'
$LogDir  = Join-Path $env:LOCALAPPDATA 'MouseFlow'
$Log     = Join-Path $LogDir 'worker.log'

function Say([string]$text) { Write-Host $text }

# ---------------------------------------------------------------- taking it off

if ($Uninstall) {
    # The running one first: removing the .cmd only stops the NEXT sign-in, and somebody who just asked for
    # it to be off means now.
    Get-CimInstance Win32_Process -Filter "Name = 'node.exe'" -ErrorAction SilentlyContinue |
        Where-Object { $_.CommandLine -and $_.CommandLine -like '*worker.mjs*' } |
        ForEach-Object {
            Say "  stopping worker (pid $($_.ProcessId))"
            Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue
        }
    if (Test-Path $CmdFile) { Remove-Item $CmdFile -Force }
    Say "Taken off. The token in the startup file went with it; revoke it in the app if you want it dead for good."
    exit 0
}

# ---------------------------------------------------------------- is it up

if ($Status) {
    if (Test-Path $CmdFile) {
        Say "Registered: $CmdFile"
    } else {
        Say "Not registered. Run this with no arguments to install it."
    }
    $running = @(Get-CimInstance Win32_Process -Filter "Name = 'node.exe'" -ErrorAction SilentlyContinue |
        Where-Object { $_.CommandLine -and $_.CommandLine -like '*worker.mjs*' })
    if ($running.Count -gt 0) {
        Say "Running: pid $($running[0].ProcessId)"
    } else {
        Say "Not running. It starts at sign-in; to start it now without signing out, run the .cmd above."
    }
    if (Test-Path $Log) {
        Say ""
        Say "Last few lines of ${Log}:"
        Get-Content $Log -Tail 8
    }
    exit 0
}

# ---------------------------------------------------------------- installing

# Node, and a version that can run the app's own TypeScript modules - which is what the worker does rather
# than carrying a copy of them. Checked here rather than left to fail at sign-in, where the message would
# land in a log nobody is looking at yet.
$node = (Get-Command node -ErrorAction SilentlyContinue)
if (-not $node) {
    Say "No node on PATH. Install Node 22.18 or newer (24 LTS is the safe answer) and run this again."
    exit 1
}
$nodePath = $node.Source
$version = (& $nodePath -p 'process.versions.node')
$major = [int]($version.Split('.')[0])
$minor = [int]($version.Split('.')[1])
if ($major -lt 22 -or ($major -eq 22 -and $minor -lt 18)) {
    Say "Node $version is too old. The worker runs the app's own TypeScript modules instead of a compiled"
    Say "copy, which needs 22.18 or newer."
    exit 1
}

if (-not (Test-Path $Worker)) {
    Say "Cannot find $Worker. Run this from inside the repository."
    exit 1
}

if (-not $Token) {
    Say "Device token, from the app: Settings -> My account -> Pair a device. It is shown once."
    # Read without echoing, so it is not left on screen or in the console's history.
    $secure = Read-Host -Prompt 'Paste it here' -AsSecureString
    $Token = [Runtime.InteropServices.Marshal]::PtrToStringBSTR(
        [Runtime.InteropServices.Marshal]::SecureStringToBSTR($secure))
}
# See the note in install-worker-mac.sh: the prefix alone let through a token pasted twice, which installs
# cleanly and then fails auth forever while telling somebody to mint a new one.
if (-not $Token.StartsWith('mf_')) {
    Say 'That does not start with "mf_", so it is not a MouseFlow device token.'
    exit 1
}
if ($Token.Length -ne 46) {
    $half = [int]($Token.Length / 2)
    if ($Token.Length % 2 -eq 0 -and $Token.Substring(0, $half) -ceq $Token.Substring($half)) {
        Say "That looks like the same token pasted twice ($($Token.Length) characters, and the two halves match)."
        Say 'This prompt does not echo, which is why it is easy to do. Run it again and paste once.'
    } else {
        Say "A device token is 46 characters; that one is $($Token.Length). Copy the whole of it, and only it."
    }
    exit 1
}

New-Item -ItemType Directory -Force -Path $LogDir | Out-Null

# `start ""` with a hidden window, the same shape the agent's own autostart uses: a Startup-folder entry
# that opened a console would put a window in front of somebody at every sign-in.
$cmd = @"
@echo off
rem MouseFlow worker - runs goal skills on this machine. Written by mcp\install-worker-windows.ps1.
rem Delete this file, or run that script with -Uninstall, to stop it starting at sign-in.
set "MOUSEFLOW_TOKEN=$Token"
set "MOUSEFLOW_URL=$Url"
set "MOUSEFLOW_AGENT_PORT=$AgentPort"
start "" /b "$nodePath" "$Worker" >> "$Log" 2>&1
"@
Set-Content -Path $CmdFile -Value $cmd -Encoding ASCII

Say ""
Say "Installed. It starts when you sign in."
Say "  what it says   Get-Content '$Log' -Wait -Tail 20"
Say "  is it up       powershell -ExecutionPolicy Bypass -File mcp\install-worker-windows.ps1 -Status"
Say "  take it off    powershell -ExecutionPolicy Bypass -File mcp\install-worker-windows.ps1 -Uninstall"
Say ""
# Unlike launchd's KeepAlive there is no supervisor here: the Startup folder starts a thing once. Said
# plainly, because a worker that died quietly and a worker that was never installed look identical from the
# other end - the caller is told "nothing picked this up" in both cases.
Say "Note: Windows starts this once at sign-in and does not restart it if it dies. -Status says whether it"
Say "is up; if it is not, run the .cmd in your Startup folder or sign out and back in."
Say ""
Say "Start it now without signing out:"
Say "  & '$CmdFile'"
Say ""
Say "Then ask your MCP client for mouseflow_status - it should say a machine is listening."
