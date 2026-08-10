/**
 * Windows installer for the MDF portal runner (dealer-rollout, Joe 2026-07-29).
 *
 * The Mac installer is a zsh script + LaunchAgents; Windows dealers (most of them) had
 * nothing — the console served them the macOS .sh, a dead file when clicked. This module
 * builds the Windows sibling as a DOUBLE-CLICKABLE .bat that carries a PowerShell payload:
 * the .bat header extracts everything after the ::PS1:: marker into %TEMP% and runs it with
 * -ExecutionPolicy Bypass (a bare downloaded .ps1 opens in Notepad when double-clicked, so
 * the .bat wrapper is what makes it one-click for a non-technical dealer).
 *
 * Prerequisites INSTALL THEMSELVES (Joe 2026-07-31, after the first real-Windows run stopped
 * at "Git is required"): Chrome/Git/Node are installed via winget when missing, then PATH is
 * re-read from the registry so the same session can see them. winget is absent on older
 * Windows and can be declined at the UAC prompt, so every check keeps its original
 * fail-safe: print the manual download URL and exit rather than proceeding half-installed.
 *
 * The PowerShell payload mirrors install.sh: ensure Chrome/Git/Node → clone the runner to
 * %LOCALAPPDATA%\LeadRider\mdf-runner → npm install → write .env (embedding the runner
 * token, same as the Mac flow) → register Scheduled Tasks for the dedicated CDP Chrome
 * (:9222, own profile, h-dnet.com) and the daemon (at-logon) plus a 5-minute WATCHDOG that
 * re-starts the daemon task (the KeepAlive equivalent; the daemon's cross-platform
 * singleton lock makes duplicate starts exit instantly) → start both → tell the human the
 * ONE manual step: log into h-dnet.com (MFA) in the Chrome window that opened.
 *
 * Quoting rule (load-bearing): the PowerShell builds Scheduled-Task argument strings by
 * CONCATENATING single-quoted pieces — no PowerShell backticks anywhere, so the payload
 * survives being embedded in this TypeScript template literal untouched.
 *
 * Pure builders — the endpoint passes config in; the eval asserts the emitted script.
 */

export type WindowsInstallerArgs = {
  apiBase: string;
  runnerToken: string;
  repoUrl: string;
  branch: string;
};

/** The PowerShell payload (the real installer). */
export function buildWindowsInstallerPs1(args: WindowsInstallerArgs): string {
  return `$ErrorActionPreference = "Stop"
Write-Host "Installing the LeadRider MDF runner (Windows)..."

# Registering Scheduled Tasks needs ADMIN. Without it the installer runs all the way through --
# clone, npm install, everything -- and dies on the very last step with "Access is denied"
# (HRESULT 0x80070005), leaving no task, so the runner never starts and never contacts the
# server. Every layer above then shows silence: the console just says "no active runner".
# Joe hit this 17 times on a real dealership PC (2026-07-31) with nothing pointing at the cause.
# So ask Windows for rights UP FRONT rather than failing at the end.
$principal = New-Object Security.Principal.WindowsPrincipal([Security.Principal.WindowsIdentity]::GetCurrent())
if (-not $principal.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)) {
  Write-Host "This installer needs administrator rights to register the runner's background tasks."
  Write-Host "Windows will ask you to approve - choose Yes. A new window will open and continue there."
  try {
    Start-Process -FilePath "powershell" -Verb RunAs -ArgumentList @(
      "-NoProfile", "-ExecutionPolicy", "Bypass", "-File", ('"' + $PSCommandPath + '"')
    ) | Out-Null
    Write-Host "Continuing in the administrator window. You can close this one."
  } catch {
    Write-Host ""
    Write-Host "Administrator rights were declined, so the install cannot finish."
    Write-Host "Right-click the installer file and choose 'Run as administrator', then try again."
  }
  Read-Host "Press Enter to close this window"
  exit 0
}

Write-Host ""
Write-Host "BEFORE YOU CONTINUE: only ONE runner computer can be active per dealership."
Write-Host "If another computer is still registered, open the LeadRider console and hit Reset on"
Write-Host "the runner FIRST. Installing here while the old computer is still active will finish"
Write-Host "successfully and then quietly never receive any work."
$proceed = Read-Host "Has the old runner computer been reset (or is this the first one)? [y/N]"
if ($proceed -notmatch '^[Yy]') {
  Write-Host "Stopped. Reset the old runner in the console, then run this installer again."
  Read-Host "Press Enter to exit"
  exit 1
}

$AppDir = Join-Path $env:LOCALAPPDATA "LeadRider\\mdf-runner"
$ProfileDir = Join-Path $env:LOCALAPPDATA "LeadRider\\mdf-chrome-profile"
$LogDir = Join-Path $env:LOCALAPPDATA "LeadRider\\logs"
New-Item -ItemType Directory -Force -Path $AppDir, $ProfileDir, $LogDir | Out-Null

function Find-Chrome {
  $candidates = @(
    (Join-Path $env:ProgramFiles "Google\\Chrome\\Application\\chrome.exe"),
    (Join-Path \${env:ProgramFiles(x86)} "Google\\Chrome\\Application\\chrome.exe"),
    (Join-Path $env:LOCALAPPDATA "Google\\Chrome\\Application\\chrome.exe")
  )
  foreach ($p in $candidates) { if ($p -and (Test-Path $p)) { return $p } }
  return $null
}

function Update-PathFromRegistry {
  $machinePath = [Environment]::GetEnvironmentVariable("Path", "Machine")
  $userPath = [Environment]::GetEnvironmentVariable("Path", "User")
  $env:Path = (@($machinePath, $userPath) | Where-Object { $_ }) -join ";"
}

function Install-WithWinget {
  param([string]$WingetId, [string]$Name)
  if (-not (Get-Command winget -ErrorAction SilentlyContinue)) { return $false }
  Write-Host ("Installing " + $Name + " for you. This can take a few minutes - approve the Windows prompt if it asks.")
  try {
    winget install -e --id $WingetId --silent --accept-package-agreements --accept-source-agreements | Out-Null
  } catch {
    Write-Host ("Automatic install of " + $Name + " did not finish.")
  }
  Update-PathFromRegistry
  return $true
}

function Ensure-Command {
  param([string]$CommandName, [string]$WingetId, [string]$Name, [string]$ManualUrl)
  if (Get-Command $CommandName -ErrorAction SilentlyContinue) { return }
  Install-WithWinget -WingetId $WingetId -Name $Name | Out-Null
  if (Get-Command $CommandName -ErrorAction SilentlyContinue) {
    Write-Host ($Name + " is installed.")
    return
  }
  Write-Host ($Name + " is required and could not be installed automatically. Install it from " + $ManualUrl + " (defaults are fine) then run this installer again.")
  Read-Host "Press Enter to exit"
  exit 1
}

$Chrome = Find-Chrome
if (-not $Chrome) {
  Install-WithWinget -WingetId "Google.Chrome" -Name "Google Chrome" | Out-Null
  $Chrome = Find-Chrome
}
if (-not $Chrome) {
  Write-Host "Google Chrome is required and could not be installed automatically. Install it from https://www.google.com/chrome/ then run this installer again."
  Read-Host "Press Enter to exit"
  exit 1
}
Ensure-Command -CommandName "git" -WingetId "Git.Git" -Name "Git" -ManualUrl "https://git-scm.com/download/win"
Ensure-Command -CommandName "npm" -WingetId "OpenJS.NodeJS.LTS" -Name "Node.js" -ManualUrl "https://nodejs.org/"

if (Test-Path (Join-Path $AppDir ".git")) {
  git -C $AppDir fetch --all --prune
  git -C $AppDir checkout ${args.branch}
  git -C $AppDir pull --ff-only
} else {
  if (Test-Path $AppDir) { Remove-Item -Recurse -Force $AppDir }
  git clone --branch ${args.branch} --depth 1 ${args.repoUrl} $AppDir
}

Set-Location $AppDir
npm install --no-audit --no-fund

# RE-IDENTIFY THIS COMPUTER (2026-08-10). The console Retire writes a tombstone keyed to this
# machine id and then tells you to run the installer - but the id lives outside the app folder,
# so reinstalling on the SAME computer returned the same id and was refused forever (hit twice
# in one hour on sales2). Dropping it makes the installer the recovery the console promises.
Remove-Item -Force -ErrorAction SilentlyContinue (Join-Path $env:USERPROFILE ".leadrider\\mdf-runner-machine.json")

$envLines = @(
  'MDF_PORTAL_API_BASE_URL=${args.apiBase}',
  'MDF_PORTAL_RUNNER_TOKEN=${args.runnerToken}',
  'MDF_PORTAL_CDP_URL=http://127.0.0.1:9222',
  'MDF_HDNET_URL=https://h-dnet.com',
  'MDF_PORTAL_USE_BROWSER_USE=0',
  'MDF_PORTAL_USE_SAVED_CHROME_LOGIN=1'
)
Set-Content -LiteralPath (Join-Path $AppDir ".env") -Value $envLines -Encoding UTF8

# --- Scheduled tasks: dedicated CDP Chrome + the runner daemon + a keep-alive watchdog ---
$chromeArgs = '--remote-debugging-port=9222 --user-data-dir="' + $ProfileDir + '" https://h-dnet.com'
$chromeAction = New-ScheduledTaskAction -Execute $Chrome -Argument $chromeArgs
$logonTrigger = New-ScheduledTaskTrigger -AtLogOn
Register-ScheduledTask -TaskName "LeadRider MDF Chrome" -Action $chromeAction -Trigger $logonTrigger -Force | Out-Null

$daemonArgs = '/c cd /d "' + $AppDir + '" && npm run mdf:portal:daemon >> "' + $LogDir + '\\mdf-runner.log" 2>&1'
$daemonAction = New-ScheduledTaskAction -Execute "cmd.exe" -Argument $daemonArgs
$daemonLogon = New-ScheduledTaskTrigger -AtLogOn
Register-ScheduledTask -TaskName "LeadRider MDF Runner" -Action $daemonAction -Trigger $daemonLogon -Force | Out-Null

$watchArgs = '/Run /TN "LeadRider MDF Runner"'
$watchAction = New-ScheduledTaskAction -Execute "schtasks.exe" -Argument $watchArgs
$watchTrigger = New-ScheduledTaskTrigger -Once -At (Get-Date).AddMinutes(5) -RepetitionInterval (New-TimeSpan -Minutes 5)
Register-ScheduledTask -TaskName "LeadRider MDF Runner Watchdog" -Action $watchAction -Trigger $watchTrigger -Force | Out-Null

Start-ScheduledTask -TaskName "LeadRider MDF Chrome"
Start-ScheduledTask -TaskName "LeadRider MDF Runner"

# CHECK IN so the server knows this computer exists (Joe, 2026-07-31: "why can't the installer
# show active in the computer"). Registration otherwise happens ONLY when the background daemon
# polls, so an install that succeeds while the daemon never starts is INDISTINGUISHABLE in the
# console from no install at all -- both read "no active runner". That ambiguity is what made a
# failed auto-start take an afternoon to find. Checking in here means the console can instead say
# "installed at <time>, but it has not checked in since", which names the real problem.
# The identity file is the SAME one the runner reads, and an existing one is never overwritten,
# so the installer and the daemon always agree on who this machine is.
$IdentityDir = Join-Path $env:USERPROFILE ".leadrider"
$IdentityPath = Join-Path $IdentityDir "mdf-runner-machine.json"
New-Item -ItemType Directory -Force -Path $IdentityDir | Out-Null
if (-not (Test-Path $IdentityPath)) {
  $identity = @{ id = [guid]::NewGuid().ToString(); name = $env:COMPUTERNAME }
  Set-Content -LiteralPath $IdentityPath -Value ($identity | ConvertTo-Json) -Encoding UTF8
}
try {
  $ident = Get-Content -LiteralPath $IdentityPath -Raw | ConvertFrom-Json
  $headers = @{
    "x-mdf-portal-token" = '${args.runnerToken}'
    "x-mdf-runner-machine-id" = $ident.id
    "x-mdf-runner-machine-name" = $ident.name
  }
  Invoke-WebRequest -Uri '${args.apiBase}/mdf/portal-runner/tasks?limit=1' -Headers $headers -UseBasicParsing -TimeoutSec 20 | Out-Null
  Write-Host "Checked in with LeadRider - this computer now shows in the console."
} catch {
  # Never fail the install on this: it is a reporting nicety, and the daemon registers anyway.
  Write-Host "Could not reach LeadRider to check in. The runner will register itself once it starts."
}

Write-Host ""
Write-Host "Installed."
Write-Host "NEXT STEP: a Chrome window opened at h-dnet.com - log in there now (approve MFA if asked)."
Write-Host "That Chrome window is the runner's browser: leave it open and do not use it for day-to-day browsing."
Write-Host "Reminder: only ONE runner computer can be active per dealership. If another computer is currently"
Write-Host "registered, reset the runner registration from the LeadRider console before using this one."
Read-Host "Press Enter to finish"
`;
}

/**
 * Wrap the PowerShell payload in a double-clickable .bat. The header copies everything
 * after the ::PS1:: marker line into %TEMP% and runs it with -ExecutionPolicy Bypass.
 */
export function buildWindowsInstallerBat(args: WindowsInstallerArgs): string {
  const ps1 = buildWindowsInstallerPs1(args);
  return [
    "@echo off",
    "setlocal",
    'set "PS1=%TEMP%\\leadrider-mdf-runner-install.ps1"',
    // Extract the payload (lines after ::PS1::) into the temp .ps1.
    "powershell -NoProfile -Command \"$m=$false; Get-Content -LiteralPath '%~f0' | ForEach-Object { if($m){$_} elseif($_ -eq '::PS1::'){$m=$true} } | Set-Content -LiteralPath '%PS1%' -Encoding UTF8\"",
    'powershell -NoProfile -ExecutionPolicy Bypass -File "%PS1%"',
    "exit /b",
    "::PS1::",
    ps1
  ].join("\r\n");
}
