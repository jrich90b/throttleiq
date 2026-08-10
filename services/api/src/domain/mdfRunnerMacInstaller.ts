// macOS MDF runner installer (extracted from index.ts 2026-08-10 — the Windows sibling already
// lived in mdfRunnerWindowsInstaller.ts, and index.ts sits on its size ceiling). Pure builder: the
// route stays in index.ts and only supplies the per-dealer values.
//
// This installer deliberately does NOT wipe the machine identity. A version that did recovered the
// retire-lockout but handed out a fresh identity on every install, so two runner processes on one PC
// registered as two computers and fought over the single slot. Recovery from a retirement lives in
// the runner, which re-identifies ONCE on a runner_revoked reply.

// The public base URL the installer bakes into the runner's .env. Lives here with the installers,
// its only callers (moved out of index.ts 2026-08-10 — that file sits on its size ceiling).
export function externalApiBase(req: any): string {
  const configured =
    process.env.MDF_PORTAL_PUBLIC_API_BASE_URL ||
    process.env.LEADRIDER_API_BASE_URL ||
    process.env.PUBLIC_API_BASE_URL ||
    "";
  if (configured.trim()) return configured.trim().replace(/\/$/, "");
  const proto = String(req.headers["x-forwarded-proto"] || req.protocol || "https").split(",")[0].trim();
  const host = String(req.headers["x-forwarded-host"] || req.headers.host || "").split(",")[0].trim();
  return host ? `${proto}://${host}` : "";
}

export function shellSingleQuote(value: string): string {
  return `'${String(value).replace(/'/g, `'\\''`)}'`;
}

export function buildMacInstallerScript(args: {
  apiBase: string;
  runnerToken: string;
  repoUrl: string;
  branch: string;
}): string {
  const { apiBase, runnerToken, repoUrl, branch } = args;
  const appDir = "${HOME}/.leadrider/mdf-runner";
  return `#!/bin/zsh
set -euo pipefail

APP_DIR="${appDir}"
PROFILE_DIR="\${HOME}/.leadrider/mdf-chrome-profile"
LOG_DIR="\${HOME}/Library/Logs"
PLIST_RUNNER="\${HOME}/Library/LaunchAgents/ai.leadrider.mdf-portal-runner.plist"
PLIST_CHROME="\${HOME}/Library/LaunchAgents/ai.leadrider.mdf-chrome.plist"

echo "Installing LeadRider MDF runner..."
mkdir -p "\${APP_DIR}" "\${PROFILE_DIR}" "\${LOG_DIR}" "\${HOME}/Library/LaunchAgents"

if ! command -v git >/dev/null 2>&1; then
  echo "Git is required. Install Xcode Command Line Tools when prompted, then rerun this installer."
  xcode-select --install || true
  exit 1
fi

if ! command -v npm >/dev/null 2>&1; then
  echo "Node.js/npm is required. Install Node.js LTS from https://nodejs.org/ then rerun this installer."
  exit 1
fi

if [ -d "\${APP_DIR}/.git" ]; then
  git -C "\${APP_DIR}" fetch --all --prune
  git -C "\${APP_DIR}" checkout ${shellSingleQuote(branch)}
  git -C "\${APP_DIR}" pull --ff-only
else
  rm -rf "\${APP_DIR}"
  git clone --branch ${shellSingleQuote(branch)} --depth 1 ${shellSingleQuote(repoUrl)} "\${APP_DIR}"
fi

cd "\${APP_DIR}"
npm install

# ONE identity file for this computer, named here so the installer and the daemon cannot disagree
# (2026-08-10). Two identities on one machine make it register as two computers, and they then fight
# over the single runner slot.
cat > "\${APP_DIR}/.env" <<ENV
MDF_PORTAL_RUNNER_MACHINE_PATH=\${HOME}/.leadrider/mdf-runner-machine.json
MDF_PORTAL_API_BASE_URL=${apiBase}
MDF_PORTAL_RUNNER_TOKEN=${runnerToken}
MDF_PORTAL_CDP_URL=http://127.0.0.1:9222
MDF_HDNET_URL=https://h-dnet.com
MDF_PORTAL_USE_SAVED_CHROME_LOGIN=1
MDF_PORTAL_USE_BROWSER_HARNESS_RESCUE=1
ENV

if [ -x "\${HOME}/bin/browser-harness" ]; then
  echo "browser-harness already installed."
elif command -v python3 >/dev/null 2>&1; then
  echo "Installing browser-harness fallback..."
  mkdir -p "\${HOME}/Developer"
  if [ -d "\${HOME}/Developer/browser-harness/.git" ]; then
    git -C "\${HOME}/Developer/browser-harness" pull --ff-only || true
  else
    git clone https://github.com/browser-use/browser-harness.git "\${HOME}/Developer/browser-harness" || true
  fi
  if [ -d "\${HOME}/Developer/browser-harness" ]; then
    python3 -m venv "\${HOME}/Developer/browser-harness/.venv" || true
    "\${HOME}/Developer/browser-harness/.venv/bin/python" -m pip install -U pip >/dev/null 2>&1 || true
    "\${HOME}/Developer/browser-harness/.venv/bin/pip" install -e "\${HOME}/Developer/browser-harness" >/dev/null 2>&1 || true
    mkdir -p "\${HOME}/.local/bin" "\${HOME}/bin" "\${HOME}/.codex/skills/browser-harness"
    ln -sf "\${HOME}/Developer/browser-harness/.venv/bin/browser-harness" "\${HOME}/.local/bin/browser-harness"
    ln -sf "\${HOME}/.local/bin/browser-harness" "\${HOME}/bin/browser-harness"
    ln -sf "\${HOME}/Developer/browser-harness/SKILL.md" "\${HOME}/.codex/skills/browser-harness/SKILL.md" || true
  fi
fi

cat > "\${PLIST_CHROME}" <<PLIST
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>ai.leadrider.mdf-chrome</string>
  <key>ProgramArguments</key>
  <array>
    <string>/Applications/Google Chrome.app/Contents/MacOS/Google Chrome</string>
    <string>--remote-debugging-port=9222</string>
    <string>--user-data-dir=\${PROFILE_DIR}</string>
    <string>https://h-dnet.com</string>
  </array>
  <key>RunAtLoad</key><true/>
  <key>KeepAlive</key><false/>
  <key>StandardOutPath</key><string>\${LOG_DIR}/leadrider-mdf-chrome.out.log</string>
  <key>StandardErrorPath</key><string>\${LOG_DIR}/leadrider-mdf-chrome.err.log</string>
</dict>
</plist>
PLIST

cat > "\${PLIST_RUNNER}" <<PLIST
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>ai.leadrider.mdf-portal-runner</string>
  <key>ProgramArguments</key>
  <array>
    <string>/bin/zsh</string>
    <string>-lc</string>
    <string>cd "\${APP_DIR}" &amp;&amp; /usr/bin/env npm run mdf:portal:daemon</string>
  </array>
  <key>WorkingDirectory</key><string>\${APP_DIR}</string>
  <key>RunAtLoad</key><true/>
  <key>KeepAlive</key><true/>
  <key>StandardOutPath</key><string>\${LOG_DIR}/leadrider-mdf-runner.out.log</string>
  <key>StandardErrorPath</key><string>\${LOG_DIR}/leadrider-mdf-runner.err.log</string>
</dict>
</plist>
PLIST

launchctl unload "\${PLIST_RUNNER}" >/dev/null 2>&1 || true
launchctl unload "\${PLIST_CHROME}" >/dev/null 2>&1 || true
launchctl load "\${PLIST_CHROME}"
launchctl load "\${PLIST_RUNNER}"

echo ""
echo "LeadRider MDF runner installed."
echo "A dedicated Chrome window should open to H-DNet. Log into H-DNet there and save the password in Chrome if you want the runner to use Chrome autofill on future logins."
echo "The runner never reads or stores H-DNet credentials. If autofill/MFA needs help, finish login in that Chrome window, then use MDF Assistant > Start portal draft."
echo "Runner logs:"
echo "  \${LOG_DIR}/leadrider-mdf-runner.out.log"
echo "  \${LOG_DIR}/leadrider-mdf-runner.err.log"
`;
}
