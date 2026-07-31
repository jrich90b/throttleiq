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
