#!/usr/bin/env bash
# The worker, as a login item, so nobody has to keep a terminal open.
#
# NOBODY NEEDS THIS ANY MORE, and that is the first thing to say. Until agent 0.9.0 a goal skill could only
# run on a machine that also ran this, because the decision loop talked to 127.0.0.1. It does not any more:
# the agent posts the screen to the deployment, the deployment decides, the agent acts. One install, done.
#
# WHAT IS LEFT IS ONE REASON, and it is a real one: with this running, the loop runs on YOUR machine, so the
# screenshots never leave it. The deployment sees the outcome and not the screen. If that matters to you,
# install this; if it does not, do not.
#
# The worker asks the account for work, does it through the local agent, and reports back. The direction
# never reverses, which is why there is no inbound path to this computer at all. While it is running the
# queue still prefers the agent for goals - see the note about both being listening in docs/product/21-mcp.md
# - so the two cannot end up driving one mouse at once.
#
# The objection to it was never the process, it was babysitting a terminal. launchd removes that: this
# registers the same login item the agent uses, with the same KeepAlive, so it starts when you sign in and
# comes back if it dies. After this you never think about it again.
#
#   bash mcp/install-worker-mac.sh              install, prompting for the token
#   bash mcp/install-worker-mac.sh --status     is it running, and what does it say
#   bash mcp/install-worker-mac.sh --uninstall  take it off
#
# THE TOKEN. It is a device token - Settings -> My account -> Pair a device, shown once - and it ends up in
# the plist, which is a file in your home directory readable by you. That is the same exposure as any
# credential in a launchd job or an env file, and it is worth knowing rather than discovering: anybody who
# can read your home directory can read it. Revoke it in the app if that stops being acceptable.
set -euo pipefail

LABEL="com.mouseflow.worker"
PLIST="${HOME}/Library/LaunchAgents/${LABEL}.plist"
LOG="${HOME}/Library/Logs/mouseflow-worker.log"
REPO="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
WORKER="${REPO}/mcp/worker.mjs"
URL="${MOUSEFLOW_URL:-https://mouseflowapp.vercel.app}"
PORT="${MOUSEFLOW_AGENT_PORT:-8787}"

say() { printf '%s\n' "$*"; }

uninstall() {
  launchctl bootout "gui/$(id -u)/${LABEL}" 2>/dev/null || launchctl unload -w "$PLIST" 2>/dev/null || true
  rm -f "$PLIST"
  say "Taken off. The token in the plist went with it; revoke it in the app if you want it dead for good."
  exit 0
}

status() {
  if launchctl print "gui/$(id -u)/${LABEL}" >/dev/null 2>&1; then
    say "Registered with launchd."
    launchctl print "gui/$(id -u)/${LABEL}" 2>/dev/null | grep -E '^\s+(state|pid) =' || true
  else
    say "Not registered. Run this script with no arguments to install it."
  fi
  if [ -f "$LOG" ]; then
    say ""
    say "Last few lines of ${LOG}:"
    tail -n 8 "$LOG"
  fi
  exit 0
}

case "${1:-}" in
  --uninstall) uninstall ;;
  --status) status ;;
esac

# Node, and a version that can run the app's own TypeScript modules - which is what the worker does rather
# than carrying a copy of them. Checked here rather than left to fail inside launchd, where the message
# would land in a log nobody is looking at yet.
if ! command -v node >/dev/null 2>&1; then
  say "No node on PATH. Install Node 22.18 or newer (24 LTS is the safe answer) and run this again."
  exit 1
fi
NODE="$(command -v node)"
NODE_MAJOR="$("$NODE" -p 'process.versions.node.split(".")[0]')"
NODE_MINOR="$("$NODE" -p 'process.versions.node.split(".")[1]')"
if [ "$NODE_MAJOR" -lt 22 ] || { [ "$NODE_MAJOR" -eq 22 ] && [ "$NODE_MINOR" -lt 18 ]; }; then
  say "Node $("$NODE" -p 'process.versions.node') is too old. The worker runs the app's own TypeScript"
  say "modules instead of a compiled copy, which needs 22.18 or newer."
  exit 1
fi

[ -f "$WORKER" ] || { say "Cannot find ${WORKER}. Run this from inside the repository."; exit 1; }

TOKEN="${MOUSEFLOW_TOKEN:-}"
if [ -z "$TOKEN" ]; then
  say "Device token, from the app: Settings -> My account -> Pair a device. It is shown once."
  # Read without echoing, so it is not left on screen or in the shell's history.
  printf 'Paste it here: '
  read -rs TOKEN
  printf '\n'
fi
# What a token is, checked before it is written into a file that will retry it for sixty seconds at a time.
#
# `mf_` plus base64url of 32 random bytes - api/sync.js - so exactly 46 characters, always. The prefix alone
# used to be the whole check, and it let through the one mistake this prompt invites: it does not echo, so
# somebody who is not sure the paste landed pastes again. That produces a 92-character string with the right
# prefix, which installs cleanly and then fails auth forever - and the only message is "mint a new one",
# which sends them to make a second token that will fail exactly the same way.
TOKEN_LEN=${#TOKEN}
case "$TOKEN" in
  mf_*) : ;;
  *) say "That does not start with \"mf_\", so it is not a MouseFlow device token."; exit 1 ;;
esac
if [ "$TOKEN_LEN" -ne 46 ]; then
  half=$((TOKEN_LEN / 2))
  if [ $((TOKEN_LEN % 2)) -eq 0 ] && [ "${TOKEN:0:$half}" = "${TOKEN:$half}" ]; then
    say "That looks like the same token pasted twice ($TOKEN_LEN characters, and the two halves match)."
    say "This prompt does not echo, which is why it is easy to do. Run it again and paste once."
  else
    say "A device token is 46 characters; that one is $TOKEN_LEN. Copy the whole of it, and only it."
  fi
  exit 1
fi

mkdir -p "$(dirname "$PLIST")"
cat > "$PLIST" <<PLIST
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>${LABEL}</string>
  <key>ProgramArguments</key>
  <array>
    <string>${NODE}</string>
    <string>${WORKER}</string>
  </array>
  <key>EnvironmentVariables</key>
  <dict>
    <key>MOUSEFLOW_TOKEN</key><string>${TOKEN}</string>
    <key>MOUSEFLOW_URL</key><string>${URL}</string>
    <key>MOUSEFLOW_AGENT_PORT</key><string>${PORT}</string>
  </dict>
  <key>RunAtLoad</key><true/>
  <key>KeepAlive</key><true/>
  <!-- Somewhere to read. Under launchd the worker's output goes nowhere otherwise, and what it says when it
       cannot reach the account or the agent is the one thing worth seeing when it will not work. -->
  <key>StandardOutPath</key><string>${LOG}</string>
  <key>StandardErrorPath</key><string>${LOG}</string>
</dict>
</plist>
PLIST
# Readable by you and nobody else: there is a credential in it.
chmod 600 "$PLIST"

# bootout then bootstrap, for the same reason the agent's installer does it: a plist that is already loaded
# is not reloaded by bootstrap alone, and the old one would keep the old token.
launchctl bootout "gui/$(id -u)/${LABEL}" 2>/dev/null || true
launchctl bootstrap "gui/$(id -u)" "$PLIST" 2>/dev/null \
  || { launchctl unload -w "$PLIST" 2>/dev/null || true; launchctl load -w "$PLIST" 2>/dev/null || true; }

say ""
say "Installed. It starts when you sign in and comes back if it dies."
say "  what it says   tail -f ${LOG}"
say "  is it up       bash mcp/install-worker-mac.sh --status"
say "  take it off    bash mcp/install-worker-mac.sh --uninstall"
say ""
say "Ask your MCP client for mouseflow_status - it should now say a machine is listening."
