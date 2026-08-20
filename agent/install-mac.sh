#!/bin/bash
#
# MouseFlow agent installer for macOS.
#
#   curl -fsSL https://mouseflowapp.vercel.app/agent/install-mac.sh | bash -s -- \
#     --origin https://mouseflowapp.vercel.app
#
# WHY THIS COMPILES INSTEAD OF DOWNLOADING A BINARY
#
# The Windows agent is fetched and run in memory with nothing installed. macOS has no equivalent, and the
# two honest options are a signed and notarised .app or a script the user then grants permissions to. There
# is no Apple Developer certificate in this project, so a downloaded binary would arrive quarantined and
# Gatekeeper would refuse it - the user would have to strip the quarantine attribute by hand, which is both
# worse advice and worse security than what this does.
#
# A binary compiled ON this machine is never quarantined. So the source is fetched, compiled here with the
# Swift toolchain Apple ships, and installed as a plain executable. The cost is Xcode Command Line Tools;
# the gain is no certificate, no notarisation, no Gatekeeper dialog, and a first run that can actually be
# completed by the person reading it.
#
# The whole script is a function called at the very end. Piping to bash executes what has arrived so far, so
# a download cut off halfway would otherwise run half an installer.

set -euo pipefail

main() {
  local origin="https://mouseflowapp.vercel.app"
  local port="8787"
  local run="yes"
  local action="install"

  while [ $# -gt 0 ]; do
    case "$1" in
      --origin) origin="${2:-}"; shift 2 ;;
      --port) port="${2:-}"; shift 2 ;;
      --no-run) run="no"; shift ;;
      --uninstall) action="uninstall"; shift ;;
      --help|-h)
        cat <<'USAGE'
mouseflow install-mac.sh

  --origin URL   the page the agent will answer (default https://mouseflowapp.vercel.app)
  --port N       loopback port (default 8787)
  --no-run       install and stop, do not start it
  --uninstall    stop it, remove the launch agent and the installed files
USAGE
        return 0 ;;
      *) shift ;;
    esac
  done

  local home_dir="${HOME}"
  local install_dir="${home_dir}/Library/Application Support/MouseFlow"
  local binary="${install_dir}/mouseflow-agent"
  local source="${install_dir}/main.swift"
  local plist="${home_dir}/Library/LaunchAgents/com.mouseflow.agent.plist"

  if [ "$action" = "uninstall" ]; then
    launchctl unload -w "$plist" 2>/dev/null || true
    rm -f "$plist"
    pkill -f "mouseflow-agent" 2>/dev/null || true
    rm -rf "$install_dir"
    echo "MouseFlow agent removed. The Accessibility and Screen Recording entries stay in System Settings;"
    echo "remove them there if you want them gone."
    return 0
  fi

  # ---------------------------------------------------------------- checks
  if [ "$(uname -s)" != "Darwin" ]; then
    echo "This installer is for macOS. On Windows use the PowerShell one-liner on the Connections screen." >&2
    return 1
  fi

  local version
  version="$(sw_vers -productVersion 2>/dev/null || echo "0")"
  case "$version" in
    10.*|11.*|12.*)
      # Not refused: the APIs used here go back to 10.15 and the screen-capture permission arrived in 10.15.
      echo "macOS ${version} - older than this was written against (14+). It may work; if it does not, the"
      echo "compiler will say so in a moment rather than failing later."
      ;;
  esac

  if ! command -v swiftc >/dev/null 2>&1; then
    cat <<'NEEDS_TOOLS' >&2
The Swift compiler is not installed, and this installer builds the agent here rather than downloading a
binary - see the note at the top of this file for why.

Run this, accept the dialog, wait for it to finish, then run this installer again:

  xcode-select --install

NEEDS_TOOLS
    return 1
  fi

  # ---------------------------------------------------------------- fetch and build
  mkdir -p "$install_dir"

  echo "Fetching the agent source from ${origin}"
  # Named main.swift on purpose: top-level code is unambiguous in a file with that name, whatever the
  # toolchain version thinks about a single-file compile.
  if ! curl -fsSL "${origin}/agent/mouseflow-agent.swift" -o "$source"; then
    echo "Could not download ${origin}/agent/mouseflow-agent.swift" >&2
    return 1
  fi

  local was_running="no"
  if pgrep -f "mouseflow-agent" >/dev/null 2>&1; then
    was_running="yes"
    echo "Stopping the agent that is already running"
    pkill -f "mouseflow-agent" 2>/dev/null || true
    sleep 1
  fi

  echo "Compiling (a few seconds)"
  # -O because the event tap runs on every mouse move and a debug build spends real time there.
  if ! swiftc -O -o "$binary" "$source" 2>"${install_dir}/build.log"; then
    echo "The agent did not compile. The compiler said:" >&2
    echo >&2
    sed 's/^/  /' "${install_dir}/build.log" >&2
    echo >&2
    echo "That log is at ${install_dir}/build.log" >&2
    return 1
  fi
  chmod +x "$binary"

  # Ad-hoc signed, which gives it a stable identifier for the permission entries. It is not a Developer ID
  # signature and does not pretend to be one.
  codesign --force --sign - --identifier com.mouseflow.agent "$binary" >/dev/null 2>&1 || true

  echo "Installed: ${binary}"

  # ---------------------------------------------------------------- permissions
  cat <<'PERMS'

Two permissions, both granted by you in System Settings, neither grantable by any installer:

  Accessibility     so it can record clicks, read what you clicked on, and click for you
  Screen Recording  so it can take a screenshot and read other applications' window titles

The agent will ask for both the first time it needs them. If you have already granted them to an OLDER
build, macOS may ask again: the permission is tied to the exact binary, and this one was just rebuilt.
PERMS

  if [ "$run" = "no" ]; then
    echo
    echo "Not started, as asked. Start it with:"
    echo "  \"${binary}\" --port ${port} --allow-origin ${origin}"
    return 0
  fi

  # Opens the pane rather than describing where it is. Harmless if the permission is already granted.
  open "x-apple.systempreferences:com.apple.preference.security?Privacy_Accessibility" >/dev/null 2>&1 || true

  cat <<PERMS2

Starting the agent. Leave this window open - closing it is how you stop it, exactly as on Windows.
It answers ${origin} on 127.0.0.1:${port} and has no outbound network code of its own.

PERMS2

  if [ "$was_running" = "yes" ]; then
    echo "(the previous one was stopped first, so the port is free)"
    echo
  fi

  # exec, so Ctrl-C reaches the agent and closing the window stops it - the same relationship the PowerShell
  # window has with the Windows agent.
  exec "$binary" --port "$port" --allow-origin "$origin"
}

main "$@"
