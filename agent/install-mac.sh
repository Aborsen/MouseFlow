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
# WHY IT IS AN .app AND NOT A LOOSE BINARY
#
# Not packaging taste: on macOS a bare executable is not its own subject as far as permissions go. TCC blames
# the RESPONSIBLE process, which for anything launched from a terminal is Terminal. So a loose binary gets no
# prompt of its own, never appears in System Settings, and the only way to grant it anything is to hand
# Accessibility to your terminal emulator. A binary inside a bundle, launched with `open` or by launchd, is
# its own responsible process: its own prompt, naming itself, and its own switch.
#
# WHY A REBUILD LOSES THE PERMISSION, AND WHAT IS DONE ABOUT IT
#
# This is the thing that keeps biting. TCC stores a grant against the app's code signature, and for an ad-hoc
# signature that means the CDHASH of the binary. Rebuild, and the hash changes: the entry stays in System
# Settings, still switched on, and the new binary is not the one it was granted to. The switch is checked and
# the agent says no - which reads as macOS lying, and is in fact macOS being exact.
#
# So after a real rebuild the stale entry is reset, which turns "checked but broken" back into "asks you
# again". One prompt beats one mystery. And --fix-permissions does only that, for when the state is already
# wrong.
#
# The whole script is a function called at the very end. Piping to bash executes what has arrived so far, so
# a download cut off halfway would otherwise run half an installer.

set -euo pipefail

BUNDLE_ID="com.mouseflow.agent"

main() {
  local origin="https://mouseflowapp.vercel.app"
  local port="8787"
  local run="yes"
  local foreground="no"
  local at_login="yes"
  local action="install"

  while [ $# -gt 0 ]; do
    case "$1" in
      --origin) origin="${2:-}"; shift 2 ;;
      --port) port="${2:-}"; shift 2 ;;
      --no-run) run="no"; shift ;;
      --no-login) at_login="no"; shift ;;
      --foreground) foreground="yes"; shift ;;
      --fix-permissions) action="fix"; shift ;;
      --doctor) action="doctor"; shift ;;
      --uninstall) action="uninstall"; shift ;;
      --help|-h)
        cat <<'USAGE'
mouseflow install-mac.sh

  --origin URL        the page the agent will answer (default https://mouseflowapp.vercel.app)
  --port N            loopback port (default 8787)
  --no-login          do not start it at login (it is a login item by default, so
                      there is nothing to launch by hand, ever)
  --no-run            install and stop, do not start it now
  --foreground        run it in this window so its output is visible. Note: launched
                      this way it inherits Terminal's permissions rather than having
                      its own - for debugging a build, not for daily use.
  --fix-permissions   clear the stale permission entries and restart it, for when
                      System Settings shows it switched on and the agent still says
                      it has no access. A rebuild changes the binary's signature and
                      the old grant no longer matches it.
  --doctor            print everything about the install in one go - version, signature,
                      login item, port, permissions, log tail. Paste the output when
                      something does not work; "it does not work" is not a diagnosis
                      and this is what turns it into one.
  --uninstall         stop it, remove the login item and the installed files
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
  local plist="${home_dir}/Library/LaunchAgents/${BUNDLE_ID}.plist"

  # ---------------------------------------------------------------- uninstall
  if [ "$action" = "uninstall" ]; then
    launchctl bootout "gui/$(id -u)/${BUNDLE_ID}" 2>/dev/null || launchctl unload -w "$plist" 2>/dev/null || true
    rm -f "$plist"
    pkill -f "mouseflow-agent" 2>/dev/null || true
    rm -rf "$install_dir"
    echo "MouseFlow agent removed. Its entries stay in System Settings; clear them with:"
    echo "  tccutil reset Accessibility ${BUNDLE_ID}"
    echo "  tccutil reset ScreenCapture ${BUNDLE_ID}"
    return 0
  fi

  # ---------------------------------------------------------------- fix permissions only
  if [ "$action" = "fix" ]; then
    if [ ! -x "$binary" ]; then
      echo "Nothing installed at ${app} - run the installer first." >&2
      return 1
    fi
    forget_permissions
    pkill -f "mouseflow-agent" 2>/dev/null || true
    sleep 1
    open "$app" --args --port "$port" --allow-origin "$origin"
    cat <<FIXED

Cleared. macOS has forgotten the old grants, so it will ASK again - which is the
point: the entry it was showing you belonged to an older build of the binary.

Say yes to both dialogs. If one does not appear, the switches are in System
Settings, Privacy & Security, under Accessibility and Screen Recording.
FIXED
    wait_for_health "$port"
    return $?
  fi

  # ---------------------------------------------------------------- doctor
  if [ "$action" = "doctor" ]; then
    doctor "$app" "$binary" "$source" "$plist" "$port" "$install_dir"
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
      # did it was removed from macOS 15 and its replacement starts at 14 - so /shot and /pulse say so.
      echo "macOS ${version}: recording and replay will work, but screenshots need macOS 14 or newer."
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

  if pgrep -f "mouseflow-agent" >/dev/null 2>&1; then
    echo "Stopping the agent that is already running"
    pkill -f "mouseflow-agent" 2>/dev/null || true
    sleep 1
  fi

  # An older install left the binary loose in the folder. It cannot hold a permission of its own, which is
  # why the bundle exists now, so it goes.
  rm -f "${install_dir}/mouseflow-agent"

  # ---------------------------------------------------------------- build
  # A rebuild costs the permissions, so it only happens when there is something to rebuild.
  local rebuilt="no"
  if [ -x "$binary" ] && [ -f "$source" ] && cmp -s "$incoming" "$source"; then
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
    write_plist_info "$app"
    # Ad-hoc, over the whole bundle. Not a Developer ID signature and does not pretend to be one.
    codesign --force --deep --sign - --identifier "$BUNDLE_ID" "$app" >/dev/null 2>&1 || true
    rebuilt="yes"
    echo "Built: ${app}"
  fi

  # ---------------------------------------------------------------- the stale-grant problem
  if [ "$rebuilt" = "yes" ]; then
    # The binary changed, so any existing grant was made to a different signature. Clearing it means macOS
    # asks again instead of showing a switch that is on and does nothing.
    forget_permissions
    echo "The agent was rebuilt, so macOS will ask for permission again — the entry it had belonged to the"
    echo "previous build. This is why a checked switch could stop working."
  fi

  # ---------------------------------------------------------------- login item
  if [ "$at_login" = "yes" ]; then
    write_login_item "$plist" "$binary" "$port" "$origin"
    echo "Set to start when you log in, so there is nothing to launch by hand."
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

  # launchd if it is a login item, `open` otherwise. Either way the agent is its own responsible process,
  # which is what gives it a permission of its own; a child of Terminal would inherit Terminal's.
  if [ "$at_login" = "yes" ]; then
    launchctl kickstart -k "gui/$(id -u)/${BUNDLE_ID}" 2>/dev/null \
      || open "$app" --args --port "$port" --allow-origin "$origin"
  else
    open "$app" --args --port "$port" --allow-origin "$origin"
  fi

  cat <<PERMS

Two permissions, both granted by you in System Settings, neither grantable by any installer:

  Accessibility     so it can record clicks, read what you clicked on, and click for you
  Screen Recording  so it can take a screenshot and read other applications' window titles

macOS asks the first time it needs each one, and the dialog says "MouseFlow Agent". The switches are in
System Settings, Privacy & Security.

If a switch is ON and the agent still says it has no access, the entry belongs to an older build of the
binary - the grant is tied to the exact signature. That is what this fixes:

  bash <(curl -fsSL ${origin}/agent/install-mac.sh) --fix-permissions --origin ${origin}

PERMS

  wait_for_health "$port"
}

# ---------------------------------------------------------------- pieces

write_plist_info() {
  local app="$1"
  # The plist is what makes this a bundle rather than a folder, and the bundle is what gives the agent an
  # identity of its own in System Settings. LSUIElement keeps it out of the Dock and the app switcher: it has
  # no window and nothing to switch to.
  cat > "${app}/Contents/Info.plist" <<PLIST
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>CFBundleName</key><string>MouseFlow Agent</string>
  <key>CFBundleDisplayName</key><string>MouseFlow Agent</string>
  <key>CFBundleIdentifier</key><string>${BUNDLE_ID}</string>
  <key>CFBundleExecutable</key><string>mouseflow-agent</string>
  <key>CFBundlePackageType</key><string>APPL</string>
  <key>CFBundleShortVersionString</key><string>0.8.0</string>
  <key>LSMinimumSystemVersion</key><string>13.0</string>
  <key>LSUIElement</key><true/>
</dict>
</plist>
PLIST
}

# The login item, which is the answer to "how do I launch this".
#
# KeepAlive so a crash or a stray pkill brings it back, RunAtLoad so signing in is all it takes. launchd
# starts it as its own responsible process, which is what keeps its permission its own.
write_login_item() {
  local plist="$1" binary="$2" port="$3" origin="$4"
  mkdir -p "$(dirname "$plist")"
  cat > "$plist" <<PLIST
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>${BUNDLE_ID}</string>
  <key>ProgramArguments</key>
  <array>
    <string>${binary}</string>
    <string>--port</string><string>${port}</string>
    <string>--allow-origin</string><string>${origin}</string>
  </array>
  <key>RunAtLoad</key><true/>
  <key>KeepAlive</key><true/>
  <key>ProcessType</key><string>Interactive</string>
  <!-- Somewhere to read. Under launchd the agent's own output goes nowhere, so the banner that says which
       permission is missing and whether the tap installed is invisible - which is the one thing worth seeing
       when it will not work. -->
  <key>StandardOutPath</key><string>${HOME}/Library/Logs/mouseflow-agent.log</string>
  <key>StandardErrorPath</key><string>${HOME}/Library/Logs/mouseflow-agent.log</string>
</dict>
</plist>
PLIST

  # bootout then bootstrap, because a plist that is already loaded is not reloaded by bootstrap alone - and
  # the old one would keep the old port and origin.
  launchctl bootout "gui/$(id -u)/${BUNDLE_ID}" 2>/dev/null || true
  launchctl bootstrap "gui/$(id -u)" "$plist" 2>/dev/null \
    || { launchctl unload -w "$plist" 2>/dev/null || true; launchctl load -w "$plist" 2>/dev/null || true; }
}

# Everything about this install, in one paste.
#
# Written because every round of "it does not work" was spent establishing things the machine can say for
# itself in two seconds - and because the failures here are indistinguishable from the outside: a missing
# permission, a permission granted to a previous build, a login item that never registered and a process that
# is not the kind that can hold a permission at all all look like an agent that says no.
doctor() {
  local app="$1" binary="$2" source="$3" plist="$4" port="$5" install_dir="$6"
  local uid; uid="$(id -u)"

  echo "=============== mouseflow doctor ==============="
  echo "macOS         $(sw_vers -productVersion 2>/dev/null || echo '?')  ($(uname -m))"
  if command -v swiftc >/dev/null 2>&1; then
    echo "swiftc        $(swiftc --version 2>/dev/null | head -1)"
  else
    echo "swiftc        MISSING - run: xcode-select --install"
  fi

  echo
  echo "--- what is installed ---"
  if [ -x "$binary" ]; then
    echo "binary        $binary"
    echo "built         $(date -r "$binary" '+%Y-%m-%d %H:%M' 2>/dev/null || echo '?')"
    echo "source        $([ -f "$source" ] && date -r "$source" '+%Y-%m-%d %H:%M' || echo 'missing')"
    # The signature is what a permission is granted TO. A different cdhash is a different app to TCC, which
    # is why a switch can be on and mean nothing.
    echo "signature     $(codesign -dv "$app" 2>&1 | grep -E '^Identifier|^CDHash' | tr '\n' ' ' || echo '?')"
    echo "bundle id     $(/usr/libexec/PlistBuddy -c 'Print :CFBundleIdentifier' "${app}/Contents/Info.plist" 2>/dev/null || echo 'NO Info.plist - this is a loose binary and cannot hold a permission')"
  else
    echo "binary        NOT INSTALLED at ${binary}"
  fi
  if [ -f "${install_dir}/build.log" ] && [ -s "${install_dir}/build.log" ]; then
    echo "last build had output:"
    sed 's/^/  /' "${install_dir}/build.log" | tail -20
  fi

  echo
  echo "--- login item ---"
  if [ -f "$plist" ]; then
    echo "plist         $plist"
    echo "keepalive     $(/usr/libexec/PlistBuddy -c 'Print :KeepAlive' "$plist" 2>/dev/null || echo '?')"
    echo "args          $(/usr/libexec/PlistBuddy -c 'Print :ProgramArguments' "$plist" 2>/dev/null | tr '\n' ' ')"
  else
    echo "plist         NOT REGISTERED - it will not start at login"
  fi
  echo "launchd       $(launchctl print "gui/${uid}/${BUNDLE_ID}" 2>/dev/null | grep -E '^\s*state = |^\s*pid = ' | tr -d ' ' | tr '\n' ' ' || echo 'not loaded')"
  echo "processes     $(pgrep -fl mouseflow-agent 2>/dev/null | head -3 | tr '\n' ';' || echo 'none running')"

  echo
  echo "--- is it answering ---"
  echo "port ${port}    $(lsof -nP -iTCP:"${port}" -sTCP:LISTEN 2>/dev/null | tail -1 || echo 'nothing listening')"
  local health
  health="$(curl -fsS --max-time 2 "http://127.0.0.1:${port}/health" 2>/dev/null || echo '')"
  if [ -n "$health" ]; then
    echo "$health" | python3 -m json.tool 2>/dev/null || echo "$health"
  else
    echo "/health       no answer"
  fi

  echo
  echo "--- its own log (last 25 lines) ---"
  if [ -f "${HOME}/Library/Logs/mouseflow-agent.log" ]; then
    tail -25 "${HOME}/Library/Logs/mouseflow-agent.log"
  else
    echo "no log yet at ~/Library/Logs/mouseflow-agent.log"
  fi
  echo "==============================================="
}

# Forget the grants so macOS asks again rather than showing one that no longer applies.
forget_permissions() {
  tccutil reset Accessibility "$BUNDLE_ID" >/dev/null 2>&1 || true
  tccutil reset ScreenCapture "$BUNDLE_ID" >/dev/null 2>&1 || true
}

# Said by asking it, not by assuming. The agent detaches, so there is no output to read - and "it started" is
# worth nothing next to "it answered".
wait_for_health() {
  local port="$1" waited=0 reply=''
  while [ "$waited" -lt 15 ]; do
    reply="$(curl -fsS --max-time 1 "http://127.0.0.1:${port}/health" 2>/dev/null || echo '')"
    if [ -n "$reply" ]; then
      echo "Running, and answering on 127.0.0.1:${port}."
      case "$reply" in
        *'"canName":false'*)
          echo "Accessibility is NOT in effect yet, so nothing can be recorded. Grant it when asked, or"
          echo "switch on MouseFlow Agent in System Settings — then it will pick it up on its own."
          ;;
        *'"canSee":false'*)
          echo "Screen Recording is not granted, so screenshots and window titles will be missing."
          ;;
        *)
          echo "Both permissions are in effect. Go back to the app and press Record."
          ;;
      esac
      echo
      echo "To stop it:    launchctl bootout gui/$(id -u)/${BUNDLE_ID}"
      echo "To start it:   launchctl kickstart -k gui/$(id -u)/${BUNDLE_ID}"
      echo "Its own log:   tail -f ~/Library/Logs/mouseflow-agent.log"
      return 0
    fi
    sleep 1
    waited=$((waited + 1))
  done

  echo "It was started but is not answering on 127.0.0.1:${port} yet." >&2
  echo "Run it in this window to see why:" >&2
  echo "  bash <(curl -fsSL ${origin:-https://mouseflowapp.vercel.app}/agent/install-mac.sh) --foreground" >&2
  return 1
}

main "$@"
