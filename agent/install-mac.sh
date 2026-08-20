#!/bin/bash
#
# MouseFlow agent installer for macOS.
#
#   curl -fsSL https://mouseflowapp.vercel.app/agent/install-mac.sh | bash -s -- \
#     --origin https://mouseflowapp.vercel.app
#
# WHY THIS COMPILES INSTEAD OF DOWNLOADING A BINARY
#
# The Windows agent is fetched and run in memory with nothing installed. macOS has no equivalent, and the two
# honest options are a signed and notarised .app or a script the user then grants permissions to. There is no
# Apple Developer certificate in this project, so a downloaded binary would arrive quarantined and Gatekeeper
# would refuse it - the user would have to strip the quarantine attribute by hand, which is both worse advice
# and worse security than what this does. A binary compiled ON this machine is never quarantined.
#
# WHY IT BUILDS AN .app RATHER THAN LEAVING THE BINARY LOOSE
#
# This is not packaging taste, it is the difference between the agent working and not. On macOS a bare
# executable launched from Terminal is not its own subject as far as permissions go: TCC blames the
# RESPONSIBLE PROCESS, which is Terminal. So the Accessibility prompt either never appears or asks about
# Terminal, the agent never gets a row of its own in System Settings, and the only way to grant it anything is
# to hand Accessibility to your terminal emulator - a far larger permission than this needs, and one most
# people would never find.
#
# A binary inside an .app bundle, launched with `open`, is its own responsible process. It gets its own
# prompt, naming itself, and its own switch in the list. That is the whole reason for the bundle; it is
# otherwise a directory with a plist in it.
#
# The whole script is a function called at the very end. Piping to bash executes what has arrived so far, so
# a download cut off halfway would otherwise run half an installer.

set -euo pipefail

main() {
  local origin="https://mouseflowapp.vercel.app"
  local port="8787"
  local run="yes"
  local foreground="no"
  local action="install"

  while [ $# -gt 0 ]; do
    case "$1" in
      --origin) origin="${2:-}"; shift 2 ;;
      --port) port="${2:-}"; shift 2 ;;
      --no-run) run="no"; shift ;;
      --foreground) foreground="yes"; shift ;;
      --uninstall) action="uninstall"; shift ;;
      --help|-h)
        cat <<'USAGE'
mouseflow install-mac.sh

  --origin URL   the page the agent will answer (default https://mouseflowapp.vercel.app)
  --port N       loopback port (default 8787)
  --no-run       install and stop, do not start it
  --foreground   run it in this window instead of detached, so its output is visible.
                 Note: launched this way it inherits Terminal's permissions rather than
                 having its own, which is exactly the problem the .app bundle solves.
                 For debugging a build, not for daily use.
  --uninstall    stop it, remove the launch agent and the installed files
USAGE
        return 0 ;;
      *) shift ;;
    esac
  done

  local home_dir="${HOME}"
  local install_dir="${home_dir}/Library/Application Support/MouseFlow"
  local app="${install_dir}/MouseFlow Agent.app"
  local binary="${app}/Contents/MacOS/mouseflow-agent"
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
    10.*|11.*|12.*|13.*)
      # Not refused: recording, replay and window listing all work. Seeing the screen does not - the API that
      # did it was removed from macOS 15 and its replacement starts at 14 - so /shot and /pulse will say so.
      echo "macOS ${version}: recording and replay will work, but screenshots need macOS 14 or newer."
      echo "The API that used to do it was removed and its replacement starts there."
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

  # ---------------------------------------------------------------- fetch
  mkdir -p "${app}/Contents/MacOS"

  echo "Fetching the agent source from ${origin}"
  # Named main.swift on purpose: top-level code is unambiguous in a file with that name, whatever the
  # toolchain version thinks about a single-file compile.
  local incoming="${install_dir}/incoming.swift"
  if ! curl -fsSL "${origin}/agent/mouseflow-agent.swift" -o "$incoming"; then
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

  # An older install left the binary loose in the folder. It cannot hold a permission of its own, which is
  # why the bundle exists now, so it goes.
  rm -f "${install_dir}/mouseflow-agent"

  # ---------------------------------------------------------------- build
  # A rebuild costs the permissions, so it only happens when there is something to rebuild.
  #
  # macOS ties a permission grant to the exact binary - the path AND its checksum - so recompiling an
  # unchanged source produces a different binary and every grant becomes invalid. Running this command twice
  # is expected rather than unusual: the event tap is installed at startup, which is BEFORE anybody has
  # flipped the switch in System Settings, so the agent has to be restarted once after granting.
  local rebuild="yes"
  if [ -x "$binary" ] && [ -f "$source" ] && cmp -s "$incoming" "$source"; then
    rebuild="no"
  fi

  if [ "$rebuild" = "no" ]; then
    rm -f "$incoming"
    echo "Unchanged since the last install, so not rebuilt — the permissions you granted stay valid."
  else
    mv -f "$incoming" "$source"
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

    # The plist is what makes this a bundle rather than a folder, and the bundle is what gives the agent an
    # identity of its own in System Settings. LSUIElement keeps it out of the Dock and the app switcher: it
    # has no window and nothing to switch to.
    cat > "${app}/Contents/Info.plist" <<PLIST
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>CFBundleName</key><string>MouseFlow Agent</string>
  <key>CFBundleDisplayName</key><string>MouseFlow Agent</string>
  <key>CFBundleIdentifier</key><string>com.mouseflow.agent</string>
  <key>CFBundleExecutable</key><string>mouseflow-agent</string>
  <key>CFBundlePackageType</key><string>APPL</string>
  <key>CFBundleShortVersionString</key><string>0.8.0</string>
  <key>LSMinimumSystemVersion</key><string>13.0</string>
  <key>LSUIElement</key><true/>
  <key>NSAppleEventsUsageDescription</key>
  <string>MouseFlow records what you do and replays it, at your request.</string>
</dict>
</plist>
PLIST

    # Ad-hoc signed, over the whole bundle, which is what gives the permission entry something stable to
    # attach to. It is not a Developer ID signature and does not pretend to be one.
    codesign --force --deep --sign - --identifier com.mouseflow.agent "$app" >/dev/null 2>&1 || true
    echo "Built: ${app}"
  fi

  if [ "$run" = "no" ]; then
    echo
    echo "Not started, as asked. Start it with:"
    echo "  open \"${app}\" --args --port ${port} --allow-origin ${origin}"
    return 0
  fi

  # ---------------------------------------------------------------- run
  if [ "$foreground" = "yes" ]; then
    echo
    echo "Running in this window. Its permissions will be Terminal's, not its own — see --help."
    echo
    exec "$binary" --port "$port" --allow-origin "$origin"
  fi

  # `open`, not exec, and that is the point of all of the above: launched this way the agent is its own
  # responsible process, so the permission prompt names IT and it gets its own switch in System Settings.
  # Launched as a child of Terminal it would inherit Terminal's identity and never appear in the list.
  open "$app" --args --port "$port" --allow-origin "$origin"

  cat <<PERMS

Two permissions, both granted by you in System Settings, neither grantable by any installer:

  Accessibility     so it can record clicks, read what you clicked on, and click for you
  Screen Recording  so it can take a screenshot and read other applications' window titles

macOS will ask the first time the agent needs each one, and the dialog will say "MouseFlow Agent". If you
miss it, the switch is in System Settings under Privacy & Security - look for MouseFlow Agent in the list.

The event tap is installed when the agent starts, which is before you have flipped the switch, so after
granting Accessibility it has to be restarted once:

  pkill -f mouseflow-agent && open "${app}" --args --port ${port} --allow-origin ${origin}

PERMS

  # Said by asking it, not by assuming. The agent detaches, so there is no output to read - and "it started"
  # is worth nothing next to "it answered".
  local waited=0
  while [ "$waited" -lt 12 ]; do
    if curl -fsS --max-time 1 "http://127.0.0.1:${port}/health" >/dev/null 2>&1; then
      echo "Running, and answering on 127.0.0.1:${port}."
      local reply
      reply="$(curl -fsS --max-time 2 "http://127.0.0.1:${port}/health" 2>/dev/null || echo '')"
      case "$reply" in
        *'"canName":false'*)
          echo "Accessibility is NOT granted yet, so nothing can be recorded. Grant it, then run the"
          echo "restart command above."
          ;;
        *'"canSee":false'*)
          echo "Screen Recording is not granted, so screenshots and window titles will be missing."
          ;;
        *)
          echo "Both permissions look granted. Go back to the app and press Record."
          ;;
      esac
      if [ "$was_running" = "yes" ]; then
        echo "(the previous agent was stopped first, so the port was free)"
      fi
      echo
      echo "To stop it:  pkill -f mouseflow-agent"
      return 0
    fi
    sleep 1
    waited=$((waited + 1))
  done

  echo "It was started but is not answering on 127.0.0.1:${port} yet." >&2
  echo "Run it in this window to see why:  bash <(curl -fsSL ${origin}/agent/install-mac.sh) --foreground --origin ${origin}" >&2
  return 1
}

main "$@"
