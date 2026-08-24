/*
 MouseFlow agent for macOS — the second implementation of agent/PROTOCOL.md.

 Same port, same paths, same bodies as the Windows agent. The client (web/src/lib/agent.ts) is shared and
 knows nothing about which platform answered; the only per-platform difference is the command shown on the
 Connections screen. Where this file departs from the PowerShell agent it is because the platform forces it,
 and each of those is commented where it happens.

 WHAT MACOS FORCES, AND WHERE IT SHOWS UP

 1. Permissions are the install story, not a detail. Posting events and reading another application's
    accessibility tree need Accessibility; capturing the screen and reading other applications' window
    titles need Screen Recording. Both are granted by the user, per-binary, in System Settings, and cannot
    be granted by any code here. So /health reports them honestly rather than claiming a capability the
    first call will silently fail at: `canSee` follows Screen Recording and `canName` follows Accessibility.
    On Windows both are unconditionally true; here a false is a real answer and the Connections screen says
    which switch to flip.

 2. Points, not pixels. CGEvent works in global display points; a screenshot comes back in backing pixels,
    which on a Retina display is twice that. This is the same trap the Windows agent hit from the other
    direction (input in physical pixels, a recording made at one display scale replaying wrong at another),
    and it is handled the same way: /shot reports `scale` and `originX`/`originY`, the client converts in
    exactly one place, and everything crossing the wire is in the space CGEvent accepts.

 3. The event tap has a timeout, like the Windows hook, and the OS disables it rather than telling anybody.
    Same rule as the protocol states: the tap queues coordinates, a worker resolves them, and .tapDisabledBy*
    is caught and the tap re-enabled.

 UNVERIFIED, AND SAID SO
 This was written on Windows, so it has never been compiled or run. install-mac.sh compiles it on the
 machine that will use it — which is also what keeps it out of Gatekeeper's way, since a binary built
 locally is never quarantined. The first run is therefore the first compile: if this file has a mistake in
 it, swiftc says so before anything is installed.
*/

import AppKit
import ApplicationServices
import CoreGraphics
import Darwin
import Foundation
import ImageIO
import ScreenCaptureKit

let VERSION = "0.8.2"

// ---------------------------------------------------------------- arguments

/* Same three the Windows agent takes, same defaults. `--allow-origin` is echoed as a response header and,
 * as on Windows, is not used to reject anything - see the Authentication section of the protocol, which is
 * being replaced and which a second implementation must not invent its own answer to. */
var port: UInt16 = 8787
var allowOrigin = "*"
var moveThrottleMsDefault = 10
var moveMinPx = 3

do {
    var args = Array(CommandLine.arguments.dropFirst())
    while let arg = args.first {
        args.removeFirst()
        switch arg {
        case "--port":
            if let v = args.first, let n = UInt16(v) { port = n; args.removeFirst() }
        case "--allow-origin":
            if let v = args.first { allowOrigin = v; args.removeFirst() }
        case "--move-throttle-ms":
            if let v = args.first, let n = Int(v) { moveThrottleMsDefault = n; args.removeFirst() }
        case "--move-min-px":
            if let v = args.first, let n = Int(v) { moveMinPx = n; args.removeFirst() }
        case "--probe":
            /* A fresh process gets a fresh TCC verdict - the whole reason this flag exists. The verdict is
             * read once, at process start, and never again (Apple's model: System Settings offers "Quit &
             * Reopen" when a switch is flipped on a running app), so the agent asks a child of its own
             * binary what the settings say NOW. Non-prompting reads only, and nothing else is touched: no
             * socket, no tap, no banner - the parent parses this one line as JSON. */
            print("{\"accessibility\":\(Permission.accessibility ? "true" : "false")"
                + ",\"screenRecording\":\(Permission.screenRecording ? "true" : "false")}")
            exit(0)
        case "--help", "-h":
            print("""
            mouseflow-agent \(VERSION)

              --port N              listen on 127.0.0.1:N (default 8787)
              --allow-origin URL    echoed in Access-Control-Allow-Origin
              --move-throttle-ms N  minimum gap between recorded moves (default 10)
              --move-min-px N       minimum cursor travel before a move is recorded (default 3)
            """)
            exit(0)
        default:
            break
        }
    }
}

// ---------------------------------------------------------------- permissions

/* Asked, not assumed, and asked separately for each one.
 *
 * The failure this prevents is specific and was already met on Windows in a different form: an agent that
 * cannot read the accessibility tree still records perfectly good coordinates, so the recording looks fine
 * and the transcript is a list of numbers. Here the same shape of failure would be a screenshot API that
 * returns nil and a window list with no titles in it - which reads as "the screen is empty", not as "you
 * have not granted this". So both are reported on /health and the app says which switch to flip. */
enum Permission {
    /// Accessibility: needed to POST input, to tap events, and to read any other application's tree.
    static var accessibility: Bool { AXIsProcessTrusted() }

    /// Screen Recording: needed for /shot, /pulse, and for other applications' window TITLES in /windows.
    static var screenRecording: Bool {
        if #available(macOS 10.15, *) { return CGPreflightScreenCaptureAccess() }
        return true
    }

    /* Asking again, at the moment the answer is actually needed.
     *
     * Asking only at startup is not enough, and a login item makes it worse rather than better: launchd
     * starts the agent when somebody logs in, which is minutes or hours before they open the app and press
     * Record. A dialog shown then is a dialog shown to an empty chair, and nothing ever asks a second time -
     * so the agent sits there reporting no access, with a switch in System Settings that was never offered.
     *
     * Called from /record/start and /shot, which are the moments a person has just asked for the thing the
     * permission is for. Cheap when it is already granted: the check is a function call and the prompt only
     * appears when the answer is not stored. */
    static func askForAccessibility() {
        if accessibility { return }
        let key = kAXTrustedCheckOptionPrompt.takeUnretainedValue() as String
        _ = AXIsProcessTrustedWithOptions([key: kCFBooleanTrue] as CFDictionary)
    }

    static func askForScreen() {
        if #available(macOS 10.15, *), !screenRecording {
            _ = CGRequestScreenCaptureAccess()
        }
    }

    /* Both prompts are one-shot and only appear if the answer is not already stored, so calling them at
     * startup costs nothing when the permissions are in place - and when they are not, the dialog is the
     * clearest possible instruction. */
    static func ask() {
        if !accessibility {
            let key = kAXTrustedCheckOptionPrompt.takeUnretainedValue() as String
            _ = AXIsProcessTrustedWithOptions([key: kCFBooleanTrue] as CFDictionary)
        }
        if #available(macOS 10.15, *), !screenRecording {
            _ = CGRequestScreenCaptureAccess()
        }
    }
}

// ---------------------------------------------------------------- geometry

/* The desktop as one rectangle, in POINTS, which is the space CGEvent speaks.
 *
 * A display placed left of or above the main one gives a negative origin, exactly as on Windows, so the
 * origin travels with every screenshot rather than being assumed to be zero. */
struct Desktop {
    static var rect: CGRect {
        var union = CGRect.null
        var count: UInt32 = 0
        CGGetActiveDisplayList(0, nil, &count)
        if count == 0 { return CGRect(x: 0, y: 0, width: 1920, height: 1080) }
        var ids = [CGDirectDisplayID](repeating: 0, count: Int(count))
        CGGetActiveDisplayList(count, &ids, &count)
        for id in ids.prefix(Int(count)) {
            union = union.isNull ? CGDisplayBounds(id) : union.union(CGDisplayBounds(id))
        }
        return union.isNull ? CGRect(x: 0, y: 0, width: 1920, height: 1080) : union
    }

    /* The one display a point is on.
     *
     * Needed because a screenshot now comes from a single display rather than from the whole desktop - see
     * Screen.grab. Bounds checking still uses the union: a click on the second monitor is a legitimate click
     * even when the agent cannot see that monitor. */
    static func displayContaining(_ point: CGPoint) -> CGRect {
        var count: UInt32 = 0
        CGGetActiveDisplayList(0, nil, &count)
        if count > 0 {
            var ids = [CGDirectDisplayID](repeating: 0, count: Int(count))
            CGGetActiveDisplayList(count, &ids, &count)
            for id in ids.prefix(Int(count)) {
                let bounds = CGDisplayBounds(id)
                if bounds.contains(point) { return bounds }
            }
        }
        return CGDisplayBounds(CGMainDisplayID())
    }

    /// Refused rather than clamped. The OS would place an out-of-bounds click somewhere real; the protocol
    /// says bounds-check and report, because a click that lands "somewhere" is worse than one that did not.
    static func contains(x: Double, y: Double) -> Bool {
        let r = rect.insetBy(dx: -1, dy: -1)
        return x >= r.minX && x <= r.maxX && y >= r.minY && y <= r.maxY
    }
}

// ---------------------------------------------------------------- small helpers

func clip(_ text: String, _ max: Int) -> String {
    if text.count <= max { return text }
    return String(text.prefix(max - 1)) + "\u{2026}"
}

func jsonString(_ s: String) -> String {
    var out = "\""
    for ch in s.unicodeScalars {
        switch ch {
        case "\"": out += "\\\""
        case "\\": out += "\\\\"
        case "\n": out += "\\n"
        case "\r": out += "\\r"
        case "\t": out += "\\t"
        default:
            if ch.value < 0x20 {
                out += String(format: "\\u%04x", ch.value)
            } else {
                out.unicodeScalars.append(ch)
            }
        }
    }
    return out + "\""
}

func jsonBool(_ b: Bool) -> String { b ? "true" : "false" }

/// One number out of a query string, written once because /shot and /record/start both want one.
func queryInt(_ query: String, _ name: String, _ fallback: Int) -> Int {
    for pair in query.split(separator: "&") {
        let parts = pair.split(separator: "=", maxSplits: 1)
        if parts.count == 2, parts[0] == Substring(name), let n = Int(parts[1]) { return n }
    }
    return fallback
}

// ================================================================ recording

/* One recorded event.
 *
 * A class, not a struct, and that is load-bearing: the resolver worker writes the application and control
 * names ONTO an event after it was buffered, so the buffer and the queue have to be looking at the same
 * object. With value semantics the worker would name a copy and throw it away.
 */
final class Ev {
    var x = 0
    var y = 0
    var delayMs = 0
    var action = ""
    /* The unlocalised half of the context. `type` is kAXRoleDescription, which is the language of the
     * MACHINE - a Russian Mac says "кнопка папки с закладками" where an English one says "bookmark folder
     * button" - so anything reading it has to be a translator. These are role tokens, the same words on
     * every machine, which is what lets a transcript say WHERE a click landed without speaking the user's
     * language. `inName` is the exception and is content, not vocabulary: quoted, never matched. */
    var role: String?
    var subrole: String?
    var container: String?
    var containerName: String?
    var app: String?
    var window: String?
    var control: String?
    var controlType: String?
    var url: String?
}

/// A resolution job. `target` is the event to write the names onto once they are known.
final class Pending {
    let target: Ev
    let x: Double
    let y: Double
    /// Focused element rather than the point under the pointer - see the protocol on `Key Down`.
    let focused: Bool
    init(target: Ev, x: Double = 0, y: Double = 0, focused: Bool = false) {
        self.target = target
        self.x = x
        self.y = y
        self.focused = focused
    }
}

/* Events posted by this agent carry a mark, so a replay is not recorded as a person working.
 *
 * The Windows agent reads LLMHF_INJECTED off the hook struct. macOS has no such flag for "somebody
 * synthesised this", so the agent stamps its own: every event it posts sets eventSourceUserData, and the tap
 * skips anything carrying it. That covers the case that matters - our own replay - and leaves another
 * application's synthetic input looking like input, which is the honest answer since it is indistinguishable.
 */
let INJECTED_MARK: Int64 = 0x4D4F5553_45464C4F  // "MOUSEFLO"

final class Recorder {
    static let shared = Recorder()

    private let gate = NSLock()
    private let resolveGate = NSLock()

    private var buffer: [Ev] = []
    private var recording = false
    /* A recording ended at the AGENT, waiting for the app to take delivery. Serialized text, not events:
     * the resolver has already finished with it, and text is what /record/stop returns anyway. Spilled to
     * disk the moment it exists, because every way this process ends - a crash, a logout, the permission
     * watcher's own self-restart - would otherwise destroy the one thing the menu item promised to save. */
    private var heldText: String?
    private var heldEvents = 0
    /// True for the moment between "capture stopped" and "the hold is safely on disk".
    private var ending = false

    private static var heldPath: String {
        FileManager.default.homeDirectoryForCurrentUser.path
            + "/Library/Application Support/MouseFlow/held-recording.mmmacro"
    }

    private init() {
        /* A hold left by an earlier process - the agent restarted before the app collected. Loaded, not
         * discarded: the person pressed Save. Unless it parses to zero events, in which case it is deleted:
         * an empty hold cannot be delivered as anything, and holding it would wedge /record/start behind a
         * 409 for a recording the app can see no reason to collect. */
        if let text = try? String(contentsOfFile: Recorder.heldPath, encoding: .utf8) {
            let events = text.split(separator: "\n").filter { !$0.hasPrefix("#") && !$0.isEmpty }.count
            if events > 0 {
                heldText = text
                heldEvents = events
            } else {
                try? FileManager.default.removeItem(atPath: Recorder.heldPath)
            }
        }
    }
    private var startNanos: UInt64 = 0
    private var stoppedElapsed: UInt64 = 0
    private var lastStamp = 0
    private var lastX = 0
    private var lastY = 0
    private var haveLast = false
    /* How many mouse buttons are down. A Focus marker must never be written between a press and its release
     * - the transcript pairs a click by looking at the very next event - and "is a gesture in progress"
     * cannot be read off the last buffered event: the pointer drifts, a Mouse Movement lands in between, and
     * the guard sees no click. That is not hypothetical, it is what happened on Windows 142ms after a press
     * on a Teams sharing bar. Counted from the events instead. */
    private var held = 0

    /* The throttle THIS session is using, and the default to fall back to. Two fields rather than one: a
     * long session thins the pointer path, and the next short recording must not inherit that. */
    private var sessionMs = 10
    private var part = 0

    private var queue: [Pending] = []
    private var dropped = 0
    private let queueMax = 400
    private var resolverStop = false
    private var resolverRunning = false
    private var lastFrontPid: pid_t = 0

    // ---------------------------------------------------------------- clock

    private var elapsedMs: Int {
        if !recording { return Int(stoppedElapsed / 1_000_000) }
        return Int((DispatchTime.now().uptimeNanoseconds - startNanos) / 1_000_000)
    }

    // ---------------------------------------------------------------- lifecycle

    /// `moveMs == 0` means "the default this agent was started with" - an absent query parameter parses to
    /// zero, and zero samples a second is not something anybody can want, so the harmless value is the one
    /// that means unspecified.
    func start(moveMs: Int) -> String? {
        gate.lock()
        if heldText != nil || ending {
            /* Atomic with the state it protects: a check on the route and an act in here would leave a gap
             * an endFromAgent could land in, and starting over a hold destroys it. */
            gate.unlock()
            return "a recording stopped at the agent is waiting to be saved - the app's Record page"
                + " collects it as soon as it is open, and then Record works again"
        }
        sessionMs = moveMs <= 0 ? moveThrottleMsDefault : min(2000, max(5, moveMs))
        part = 0
        buffer = []
        haveLast = false
        lastStamp = 0
        startNanos = DispatchTime.now().uptimeNanoseconds
        stoppedElapsed = 0
        recording = true
        gate.unlock()

        resolveGate.lock()
        queue = []
        dropped = 0
        resolverStop = false
        /* Zeroed, not carried: the first Focus event of a recording should name where the recording STARTED,
         * and a value left over from the last one would suppress it. */
        lastFrontPid = 0
        held = 0
        resolveGate.unlock()

        startResolverIfNeeded()
        return nil
    }

    /* Take what has piled up and KEEP RECORDING.
     *
     * What is NOT touched is the load-bearing part, and it is the same list as on Windows: the clock runs on,
     * so elapsedMs stays the time of the SESSION rather than of the chunk; lastStamp and haveLast stay, or
     * one unthrottled burst gets through at the start of every chunk; held stays, so a drain landing
     * mid-drag cannot let a Focus marker split the next chunk's press from its release; lastFrontPid stays,
     * so an unchanged window is not re-announced every chunk.
     *
     * Returns nil when there is no recording, which the route turns into a 409 - "nothing happened in the
     * last half hour" and "there is no recording" have to be distinguishable, or a chunker writes an empty
     * part every half hour for as long as the tab is open. */
    func drain() -> String? {
        gate.lock()
        if !recording { gate.unlock(); return nil }
        let taken = buffer
        buffer = []
        let at = elapsedMs
        part += 1
        let n = part
        let ms = sessionMs
        gate.unlock()

        /* The same bounded wait as the stop, for the same reason: the resolver writes names onto the events
         * just taken, and serialising ahead of it would drop the name of the last click of every chunk.
         * Shorter than the stop's wait because a drain lands on a clock boundary rather than on a click -
         * whatever is still in flight is seconds old - and because a person's next half hour is behind it. */
        waitForResolver(upToMs: 400)

        resolveGate.lock()
        let lost = dropped
        resolveGate.unlock()

        var head = "#part\tn=\(n)\telapsedMs=\(at)\tevents=\(taken.count)"
        head += "\tmoveMs=\(ms)\tdropped=\(lost)\n"
        return head + Recorder.serialize(taken)
    }

    /* The menu bar's "Stop and Save Recording". Capture stops NOW; the events stay, because the agent has
     * no account to put them on - the app does, and its Record page collects a held recording through the
     * ordinary /record/stop the moment it notices. `recording:false` with `count>0` on /record/status is
     * the signal, and it is unambiguous because a client-driven stop never leaves that state behind. */
    func endFromAgent() {
        /* The buffer is taken in the SAME critical section that drops the flag, and that is the whole
         * correctness of this function. Dropping `recording` first and taking the buffer after the resolver
         * wait leaves up to 1.5 seconds where /record/status answers `recording:false` with `count>0` - the
         * protocol's "a hold is waiting" signal - while nothing is held yet: the app's quarter-second poll
         * lands there, calls /record/stop, and gets the LIVE path, so the events go out by the ordinary door
         * and this function then finds an empty buffer and holds nothing. The recording survives, but the
         * spill never happens and the agent reports that nothing was captured. */
        gate.lock()
        let was = recording
        stoppedElapsed = recording ? (DispatchTime.now().uptimeNanoseconds - startNanos) : stoppedElapsed
        recording = false
        let taken = buffer
        buffer = []
        /* Held from this instant: `ending` covers the gap until the text exists, and both /record/status
         * and /record/stop read it, so no caller can see a hold that is not there yet. */
        ending = was && !taken.isEmpty
        heldEvents = taken.count
        let session = (part: part, moveMs: sessionMs, elapsed: stoppedElapsed)
        gate.unlock()
        guard was else { return }

        if taken.isEmpty {
            /* Nothing was captured, so there is nothing to hold - and holding nothing would wedge
             * /record/start behind a 409 for a recording that does not exist. The stop still happened;
             * the app notices `recording:false` and finishes its own bookkeeping. */
            gate.lock(); heldEvents = 0; gate.unlock()
            resolveGate.lock(); resolverStop = true; resolveGate.unlock()
            print("  recording      stopped from the menu bar - nothing was captured")
            return
        }

        /* Same bounded wait as a client stop, so the held events carry their control names. */
        waitForResolver(upToMs: 1500)
        resolveGate.lock()
        resolverStop = true
        resolveGate.unlock()
        /* Serialized and spilled OUTSIDE the gate, because the tap callback takes that same lock on every
         * mouse event: a long session is hundreds of thousands of events, and a tap held across that plus a
         * multi-megabyte write is a tap the OS disables for overrunning its timeout. `ending` is what makes
         * this safe - a hold is already declared, so nothing can start a recording or take delivery of a
         * half-written one.
         *
         * The same #part line a drain writes, so the session clock and the part number survive with the
         * hold - a tail collected after an agent restart would otherwise claim elapsedMs 0 and sort before
         * part one. Every reader of the format already skips # lines. */
        resolveGate.lock()
        let lost = dropped
        resolveGate.unlock()
        var text = "#part\tn=\(session.part + 1)\telapsedMs=\(Int(session.elapsed / 1_000_000))"
        text += "\tevents=\(taken.count)\tmoveMs=\(session.moveMs)\tdropped=\(lost)\n"
        text += Recorder.serialize(taken)
        try? FileManager.default.createDirectory(
            atPath: (Recorder.heldPath as NSString).deletingLastPathComponent,
            withIntermediateDirectories: true)
        try? text.write(toFile: Recorder.heldPath, atomically: true, encoding: .utf8)

        gate.lock()
        heldText = text
        heldEvents = taken.count
        ending = false
        gate.unlock()
        print("  recording      stopped from the menu bar - \(taken.count) events held for the app to save")
    }

    /// The menu reads this to say a hold is waiting; the permission watcher reads `busyEnding` so a
    /// self-restart can never land between "capture stopped" and "the hold is safely on disk".
    var heldStatus: (held: Bool, events: Int) {
        gate.lock(); defer { gate.unlock() }
        return (heldText != nil, heldEvents)
    }
    var busyEnding: Bool { gate.lock(); defer { gate.unlock() }; return ending }

    func stop() -> String {
        /* A hold being written is a hold: wait for it rather than racing past it into the live path, which
         * is empty by then anyway. Bounded by the same budget the resolver wait uses. */
        for _ in 0..<40 {
            gate.lock()
            let mid = ending
            gate.unlock()
            if !mid { break }
            usleep(50_000)
        }
        gate.lock()
        if let text = heldText {
            /* Taking delivery of a hold: the text was serialized when the menu stopped the recording, so
             * there is nothing to wait for - hand it over and forget it, on disk too. */
            heldText = nil
            heldEvents = 0
            gate.unlock()
            try? FileManager.default.removeItem(atPath: Recorder.heldPath)
            return text
        }
        let taken = buffer
        buffer = []
        stoppedElapsed = recording ? (DispatchTime.now().uptimeNanoseconds - startNanos) : stoppedElapsed
        recording = false
        gate.unlock()

        /* Bounded, because a recording that hangs on stop is worse than a transcript missing the last
         * control name - and whatever is still unresolved simply stays absent, which the format already
         * means as "not known". */
        waitForResolver(upToMs: 1500)
        resolveGate.lock()
        resolverStop = true
        resolveGate.unlock()

        return Recorder.serialize(taken)
    }

    private func waitForResolver(upToMs limit: Int) {
        var waited = 0
        while waited < limit {
            resolveGate.lock()
            let empty = queue.isEmpty
            resolveGate.unlock()
            if empty { return }
            usleep(25_000)
            waited += 25
        }
    }

    // ---------------------------------------------------------------- status

    var isRecording: Bool { gate.lock(); defer { gate.unlock() }; return recording }

    func status() -> (recording: Bool, count: Int, part: Int, moveMs: Int, elapsedMs: Int) {
        gate.lock()
        defer { gate.unlock() }
        /* `ending` counts as held: between the flag dropping and the text existing the events are already
         * out of the buffer, and a count of zero there would read as "nothing was recorded". */
        return (recording, (heldText != nil || ending) ? heldEvents : buffer.count, part, sessionMs, elapsedMs)
    }

    // ---------------------------------------------------------------- capture

    /* Called from the tap. Does the minimum and returns: the protocol's rule is that nothing on the input
     * path may resolve anything, because a tap that overruns its timeout is disabled by the OS without
     * telling anybody - the same failure the Windows hook has with LowLevelHooksTimeout. */
    func capture(action: String, x: Int, y: Int) {
        var toQueue: Ev?
        gate.lock()
        if recording {
            let now = elapsedMs

            if action.hasSuffix("Click Down") {
                held += 1
            } else if action.hasSuffix("Click Release") {
                if held > 0 { held -= 1 }
            }

            /* The raw tap fires hundreds of moves a second. Keep only the ones that carry information:
             * far enough apart in time AND space.
             *
             * When one is dropped the last position is deliberately NOT updated - the distance is measured
             * from the last RECORDED point, not from the last seen one. Measuring from the last seen point
             * would filter a slow deliberate drag out of existence: two pixels at a time never clears a
             * three-pixel threshold, however far the pointer eventually travels. */
            var keep = true
            if action == "Mouse Movement", haveLast {
                let dx = abs(x - lastX)
                let dy = abs(y - lastY)
                if (now - lastStamp) < sessionMs { keep = false }
                if dx < moveMinPx && dy < moveMinPx { keep = false }
            }

            if keep {
                let e = Ev()
                e.x = x
                e.y = y
                e.delayMs = buffer.isEmpty ? 0 : (now - lastStamp)
                e.action = action
                buffer.append(e)
                lastStamp = now
                lastX = x
                lastY = y
                haveLast = true
                // Clicks only, and only the button-down: a move has no target worth naming and there are
                // hundreds of them; the release is the same target a moment later.
                if action.hasSuffix("Click Down") { toQueue = e }
            }
        }
        gate.unlock()

        if let e = toQueue { enqueue(Pending(target: e, x: Double(x), y: Double(y))) }
    }

    /* A key was pressed, and when. NEVER which key.
     *
     * This is the whole design and it is not negotiable: "five of those ten minutes went on typing in
     * Outlook" needs the timing and nothing else, and a tap that reads key codes has captured a password
     * whether or not it stores one. The tap callback below is handed a CGEvent it could read the keycode
     * from; it does not, and this function is not given one. */
    func captureKey() {
        var first: Ev?
        gate.lock()
        if recording {
            let now = elapsedMs
            let e = Ev()
            /* The pointer has not moved for this event, so the last known position is used. The five-column
             * format needs a coordinate; typing does not have one, and no reader takes it for a key. */
            e.x = lastX
            e.y = lastY
            e.delayMs = buffer.isEmpty ? 0 : (now - lastStamp)
            e.action = "Key Down"
            let continuing = buffer.last?.action == "Key Down"
            buffer.append(e)
            lastStamp = now
            // One resolution per RUN of typing. Sixty keystrokes into one field is one answer.
            if !continuing { first = e }
        }
        gate.unlock()

        if let e = first { enqueue(Pending(target: e, focused: true)) }
    }

    // ---------------------------------------------------------------- resolver

    private func enqueue(_ job: Pending) {
        resolveGate.lock()
        if queue.count >= queueMax {
            /* If the worker falls behind, drop the CONTEXT, never the event. A recording missing a name is
             * incomplete; a recording missing a click is wrong. */
            dropped += 1
        } else {
            queue.append(job)
        }
        resolveGate.unlock()
    }


    private func startResolverIfNeeded() {
        resolveGate.lock()
        let already = resolverRunning
        resolverRunning = true
        resolveGate.unlock()
        if already { return }

        let thread = Thread {
            while true {
                var job: Pending?
                self.resolveGate.lock()
                if !self.queue.isEmpty { job = self.queue.removeFirst() }
                let ending = job == nil && self.resolverStop
                self.resolveGate.unlock()

                if ending {
                    self.resolveGate.lock()
                    self.resolverRunning = false
                    self.resolveGate.unlock()
                    return
                }

                guard let job = job else {
                    /* Idle, so this is where the frontmost application gets watched. No second observer and
                     * no second run loop: this thread is already awake, and a poll every 15ms is far finer
                     * than a person can switch windows. */
                    self.noteForeground()
                    usleep(15_000)
                    continue
                }

                if job.focused {
                    Accessibility.describeFocused(job)
                } else {
                    Accessibility.describe(job)
                }
            }
        }
        thread.stackSize = 512 * 1024
        thread.start()
    }

    /* The foreground application changed - a marker saying the work moved.
     *
     * Not an action. It is the only per-step answer for a scroll, a wait or a run of typing, all of which
     * hit-test nothing and would otherwise sit in whichever segment a click last opened. */
    private func noteForeground() {
        guard let front = NSWorkspace.shared.frontmostApplication else { return }
        let pid = front.processIdentifier

        // Nothing to do when the front has not moved, and nothing to record when not recording - but the
        // pid is still remembered, so the first marker of the next recording says where it BEGAN.
        gate.lock()
        let same = pid == lastFrontPid
        let live = recording
        let gesture = held > 0
        if !live || same { lastFrontPid = pid; gate.unlock(); return }
        /* Never during a gesture. A click that gives a window focus fires this watcher while the button is
         * still down, and a marker inserted there turns one click into an unreleased press and a stray
         * release. lastFrontPid is deliberately NOT updated, so the change is noticed again next tick once
         * the button is up. */
        if gesture { gate.unlock(); return }
        gate.unlock()

        /* Named BEFORE it is buffered. Writing onto an event already in the buffer races a drain that may be
         * serialising it - and there is nothing to gain from it here, since both the application and the
         * window title are known before the marker is made.
         *
         * Window only. A foreground change has no control under it, and inventing one from the pointer -
         * which is wherever it was last left - would be a name for something nobody touched. */
        let appName = clip(front.localizedName ?? "", 80)
        let title = Accessibility.frontWindowTitle(pid: pid)

        gate.lock()
        // Re-checked under the lock: naming took a moment, and a button may have gone down in it.
        if recording && held == 0 && pid != lastFrontPid {
            let now = elapsedMs
            let e = Ev()
            e.x = lastX
            e.y = lastY
            e.delayMs = buffer.isEmpty ? 0 : (now - lastStamp)
            e.action = "Focus"
            e.app = appName.isEmpty ? nil : appName
            e.window = title
            buffer.append(e)
            lastStamp = now
            lastFrontPid = pid
        }
        gate.unlock()
    }

    // ---------------------------------------------------------------- serialise

    /* Context rides on a COMMENT line above its event.
     *
     * The .mmmacro line is `index | X | Y | delayMs | action` and anything reading it would choke on a sixth
     * column. Lines starting with # are already skipped by every reader of this format, so an older reader
     * loads the recording exactly as before and a newer one gets the context. Deliberately not JSON: a
     * tab-separated pair list survives a title containing a quote, a brace or a colon without an encoder. */
    static func serialize(_ list: [Ev]) -> String {
        var out = ""
        out.reserveCapacity(list.count * 48)
        var index = 1
        for e in list {
            if e.app != nil || e.window != nil || e.control != nil || e.controlType != nil {
                out += "#ctx"
                if let v = e.app { out += "\tapp=" + v }
                if let v = e.window { out += "\twindow=" + v }
                if let v = e.control { out += "\tcontrol=" + v }
                if let v = e.controlType { out += "\ttype=" + v }
                /* Added after the four that were always here, and ignorable: the format says unknown keys
                 * are skipped rather than being an error, so an older reader loads this exactly as before. */
                if let v = e.role { out += "\trole=" + v }
                if let v = e.subrole { out += "\tsubrole=" + v }
                if let v = e.container { out += "\tin=" + v }
                if let v = e.containerName { out += "\tinName=" + v }
                if let v = e.url { out += "\turl=" + v }
                out += "\n"
            }
            out += "\(index) | \(e.x) | \(e.y) | \(e.delayMs) | \(e.action)\n"
            index += 1
        }
        return out
    }
}

// ================================================================ accessibility

/* What was under the pointer, and what has focus.
 *
 * The macOS half of `#ctx`. The mechanism differs from Windows and the output line does not: UI Automation's
 * AutomationElement.FromPoint becomes AXUIElementCopyElementAtPosition, and the climb for a name walks
 * kAXParentAttribute instead of TreeWalker.
 *
 * Two rules from the protocol are the whole design here:
 *   - NEVER walk the tree. Hit-test the point and climb for a name. A full tree walk was measured at 0.6-4.4
 *     seconds per window on Windows, and AX is not faster.
 *   - ABSENT MEANS NOT KNOWN, never "nothing there". So every one of these returns nil rather than a
 *     placeholder, and serialize() omits the field. A transcript has to keep that difference.
 */
/// What a climb found: the name, and the tokens that say what and where it was.
struct Named {
    var control: String?
    var type: String?
    var role: String?
    var subrole: String?
    var container: String?
    var containerName: String?
    /* The page a click landed on, when it landed on one. Origin and path only - see webURL below. */
    var url: String?
}

enum Accessibility {
    private static let systemWide = AXUIElementCreateSystemWide()

    /* Applications already asked to expose their full tree. Once each, for the life of the agent. */
    private static var awakened = Set<pid_t>()
    private static let awakenGate = NSLock()

    /* Ask an application to build its accessibility tree.
     *
     * Chromium builds it LAZILY and only when it detects an assistive technology, so a click anywhere in a
     * web page resolves to nothing at all: the window is there and everything inside it is invisible. That
     * is not a subtlety, it is the difference between "clicked Delete" and "clicked on something Google
     * Chrome did not name" - measured against the same browser on Windows, which names 146 clicks out of
     * 151.
     *
     * `AXManualAccessibility` is the switch Chromium reads. `AXEnhancedUserInterface` is the older one that
     * Electron applications and VS Code read. Both are set, because an agent cannot know which kind of
     * application it is looking at and setting the wrong one costs nothing.
     *
     * Lazily and once per process: a full tree costs the application memory and time, and it should only be
     * paid for where there would otherwise be nothing to read. */
    /// Returns whether this was the FIRST ask for this pid - the caller that woke an application knows the
    /// tree it asked for is still being built, and may want to look again after it has had time.
    @discardableResult
    private static func awaken(pid: pid_t) -> Bool {
        guard pid > 0 else { return false }
        awakenGate.lock()
        let already = awakened.contains(pid)
        if !already { awakened.insert(pid) }
        awakenGate.unlock()
        if already { return false }

        let app = AXUIElementCreateApplication(pid)
        /* AXManualAccessibility first, and the older flag only where the newer one means nothing. Not
         * politeness: AXEnhancedUserInterface is VoiceOver's own signal and AppKit changes window-geometry
         * behaviour under it - the reason window managers toggle it off around every move they make.
         * Chromium added AXManualAccessibility precisely as the side-effect-free way for a client like this
         * one to ask, so the fallback only fires where it is not understood (older Electron - and ordinary
         * applications, which is no worse than what was set before). */
        let err = AXUIElementSetAttributeValue(app, "AXManualAccessibility" as CFString, kCFBooleanTrue)
        if err == .cannotComplete {
            /* The application is busy or still launching - the ask never landed, so it must not count as
             * asked, or the one chance to wake this process is spent on a message that went nowhere. */
            awakenGate.lock()
            awakened.remove(pid)
            awakenGate.unlock()
            return true
        }
        if err != .success {
            AXUIElementSetAttributeValue(app, "AXEnhancedUserInterface" as CFString, kCFBooleanTrue)
        }
        return true
    }

    /// Ask the frontmost application for its tree BEFORE the first click needs it. Chromium answers the
    /// asking asynchronously, so the tree a recording will read is requested when Record is pressed, not
    /// when the first click has already come up empty.
    static func prime() {
        guard Permission.accessibility else { return }
        if let front = NSWorkspace.shared.frontmostApplication { awaken(pid: front.processIdentifier) }
    }

    private static func copyAttr(_ element: AXUIElement, _ attribute: String) -> CFTypeRef? {
        var value: CFTypeRef?
        let err = AXUIElementCopyAttributeValue(element, attribute as CFString, &value)
        return err == .success ? value : nil
    }

    /* Flattened before it can meet the format: #ctx is a tab-separated line and the event line is
     * pipe-separated, so an interior tab, newline or pipe in a value would shear the record. Tooltips
     * (kAXHelp) are the first source where multi-line text is COMMON, but a window title always could have
     * carried one. Same substitutions as the Windows agent's Clip. */
    static func ctxClean(_ raw: String, _ max: Int = 120) -> String? {
        let flat = raw.map { ch -> Character in
            if ch == "\t" || ch == "\n" || ch == "\r" { return " " }
            if ch == "|" { return "/" }
            return ch
        }
        let trimmed = String(flat).trimmingCharacters(in: .whitespacesAndNewlines)
        return trimmed.isEmpty ? nil : clip(trimmed, max)
    }

    private static func stringAttr(_ element: AXUIElement, _ attribute: String) -> String? {
        guard let raw = copyAttr(element, attribute) as? String else { return nil }
        return ctxClean(raw)
    }

    /* The address of the page a click landed on, ORIGIN AND PATH ONLY.
     *
     * WHY IT IS CUT HERE, in the agent, rather than anywhere downstream. A query string is where a session
     * token, a one-time sign-in link and whatever somebody typed into a search box live. Everything past
     * this point copies the payload around - it is pushed to the account, handed to a model, written into
     * a SKILL.md that gets downloaded and forwarded - and a value that never entered the recording cannot
     * leak from any of them. Cutting it later would mean every one of those paths had to remember to.
     *
     * That has a cost and it is real: a flow whose page is `?view=list` loses the part that made it that
     * page. The exported file says so, so a person can put it back.
     *
     * AXURL is a CFURL, not a string - the one attribute here that is not - which is why this cannot go
     * through stringAttr. */
    private static func webURL(_ element: AXUIElement) -> String? {
        guard let raw = copyAttr(element, kAXURLAttribute as String) else { return nil }
        guard CFGetTypeID(raw) == CFURLGetTypeID() else { return nil }
        guard var parts = URLComponents(url: (raw as! URL), resolvingAgainstBaseURL: false) else { return nil }
        guard let scheme = parts.scheme?.lowercased(), scheme == "http" || scheme == "https" else { return nil }
        parts.query = nil
        parts.fragment = nil
        guard let text = parts.string else { return nil }
        return ctxClean(text)
    }

    private static func elementAttr(_ element: AXUIElement, _ attribute: String) -> AXUIElement? {
        guard let raw = copyAttr(element, attribute) else { return nil }
        guard CFGetTypeID(raw) == AXUIElementGetTypeID() else { return nil }
        return (raw as! AXUIElement)
    }

    /// The name a person would use for the application that owns this element.
    /// Better than Windows manages, as the protocol notes: "Microsoft Outlook", not a process called outlook.
    private static func appName(of element: AXUIElement) -> String? {
        var pid: pid_t = 0
        guard AXUIElementGetPid(element, &pid) == .success, pid > 0 else { return nil }
        guard let running = NSRunningApplication(processIdentifier: pid) else { return nil }
        if let name = running.localizedName, !name.isEmpty { return clip(name, 80) }
        return nil
    }

    /* A name for the thing itself, then for its parent, and so on - at most five levels.
     *
     * The same depth the Windows agent settled on. A button usually names itself; a cell in a table names
     * nothing and its row does; past five the answer is the window, which is already recorded separately. */
    /* Containers worth naming a click by. Not every ancestor is a place - AXGroup is scaffolding and says
     * nothing - so only the roles a person would recognise as somewhere: a toolbar, a tab strip, a list, a
     * table, the page itself. */
    private static let containerRoles: Set<String> = [
        "AXToolbar", "AXMenuBar", "AXMenu", "AXTabGroup", "AXList", "AXOutline",
        "AXTable", "AXWebArea", "AXSheet", "AXDrawer",
    ]

    private static func nameByClimbing(_ start: AXUIElement) -> Named {
        var element: AXUIElement? = start
        var depth = 0
        var hitType: String?
        var out = Named()
        out.role = stringAttr(start, kAXRoleAttribute)
        out.subrole = stringAttr(start, kAXSubroleAttribute)

        /* The container is looked for on the SAME walk that looks for a name, and a little past it: the
         * name usually turns up within a level or two and the toolbar holding it is a level or two above
         * that. Eight is where a browser's page wrapper gives way to the window, which is recorded already. */
        func look(_ e: AXUIElement) {
            guard out.container == nil, let role = stringAttr(e, kAXRoleAttribute),
                  containerRoles.contains(role) else { return }
            out.container = role
            out.containerName = stringAttr(e, kAXTitleAttribute) ?? stringAttr(e, kAXDescriptionAttribute)
            /* On the SAME walk that was already looking for a container, and only when that container is a
             * web area - which is the only element that carries an address. No extra traversal: the
             * protocol forbids walking on the input path because it costs seconds, and this is that walk. */
            if role == "AXWebArea" { out.url = webURL(e) }
        }

        var walker: AXUIElement? = start
        var up = 0
        while let w = walker, up < 8, out.container == nil {
            look(w)
            walker = elementAttr(w, kAXParentAttribute)
            up += 1
        }

        while let current = element, depth < 5 {
            let type = stringAttr(current, kAXRoleDescriptionAttribute)
            if depth == 0 { hitType = type }
            if let name = stringAttr(current, kAXTitleAttribute) { out.control = name; out.type = type; return out }
            /* The label is its own element for a form field: AXTitleUIElement points at the static text
             * that names it, the way <label for> names an input, and the text of a static text lives in its
             * value. */
            if let label = elementAttr(current, kAXTitleUIElementAttribute),
               let name = stringAttr(label, kAXValueAttribute) ?? stringAttr(label, kAXTitleAttribute) {
                out.control = name; out.type = type; return out
            }
            /* Description and value, in that order, because a great many controls carry no title: an icon
             * button has kAXDescription - and in Chromium every aria-label lands there - a text field has
             * kAXValue and nothing else. Value only on the element itself, never a parent's: a parent's
             * value is the document. */
            if let name = stringAttr(current, kAXDescriptionAttribute) { out.control = name; out.type = type; return out }
            if depth == 0, let name = stringAttr(current, kAXValueAttribute) { out.control = name; out.type = type; return out }
            /* Help is the tooltip. Last, because it describes rather than names - but a toolbar button that
             * names itself nowhere else usually says exactly the right thing here. */
            if let name = stringAttr(current, kAXHelpAttribute) { out.control = name; out.type = type; return out }
            element = elementAttr(current, kAXParentAttribute)
            depth += 1
        }
        /* Nothing named itself. The kind of thing that was hit still travels: "clicked a button" beats
         * "clicked", and the Windows agent has always reported type without name. */
        out.type = hitType
        return out
    }

    /// The window title of the frontmost window of a process.
    static func frontWindowTitle(pid: pid_t) -> String? {
        guard Permission.accessibility, pid > 0 else { return nil }
        let app = AXUIElementCreateApplication(pid)
        if let window = elementAttr(app, kAXFocusedWindowAttribute),
           let title = stringAttr(window, kAXTitleAttribute) {
            return title
        }
        if let window = elementAttr(app, kAXMainWindowAttribute) {
            return stringAttr(window, kAXTitleAttribute)
        }
        return nil
    }

    private static func pointAttr(_ element: AXUIElement, _ attribute: String) -> CGPoint? {
        guard let raw = copyAttr(element, attribute) else { return nil }
        guard CFGetTypeID(raw) == AXValueGetTypeID() else { return nil }
        var point = CGPoint.zero
        return AXValueGetValue(raw as! AXValue, .cgPoint, &point) ? point : nil
    }

    private static func sizeAttr(_ element: AXUIElement, _ attribute: String) -> CGSize? {
        guard let raw = copyAttr(element, attribute) else { return nil }
        guard CFGetTypeID(raw) == AXValueGetTypeID() else { return nil }
        var size = CGSize.zero
        return AXValueGetValue(raw as! AXValue, .cgSize, &size) ? size : nil
    }

    /// The middle of an element, in the same points CGEvent takes.
    private static func centreOf(_ element: AXUIElement) -> CGPoint? {
        guard let origin = pointAttr(element, kAXPositionAttribute),
              let size = sizeAttr(element, kAXSizeAttribute),
              size.width > 1, size.height > 1 else { return nil }
        return CGPoint(x: origin.x + size.width / 2, y: origin.y + size.height / 2)
    }

    /* The same sources, in the same order, as nameByClimbing reads when RECORDING - a name that was
     * recorded from a label element or a tooltip must be findable at replay, or aiming by it silently never
     * fires for exactly the controls the wider fallbacks were added for. */
    private static func nameOf(_ element: AXUIElement) -> String? {
        if let name = stringAttr(element, kAXTitleAttribute) { return name }
        if let label = elementAttr(element, kAXTitleUIElementAttribute),
           let name = stringAttr(label, kAXValueAttribute) ?? stringAttr(label, kAXTitleAttribute) {
            return name
        }
        return stringAttr(element, kAXDescriptionAttribute)
            ?? stringAttr(element, kAXValueAttribute)
            ?? stringAttr(element, kAXHelpAttribute)
    }

    /* Two names for the same thing?
     *
     * Exact match after trimming and folding case, plus a prefix rule, because a tab title is truncated by
     * the tab strip and gets shorter as more tabs open - "Netflix - Watch TV Show..." and "Netflix" are the
     * same tab. Six characters is the floor: any shorter and a prefix matches half the window. */
    private static func sameName(_ a: String, _ b: String) -> Bool {
        let x = a.trimmingCharacters(in: .whitespacesAndNewlines).lowercased()
        let y = b.trimmingCharacters(in: .whitespacesAndNewlines).lowercased()
        if x.isEmpty || y.isEmpty { return false }
        if x == y { return true }
        if min(x.count, y.count) < 6 { return false }
        return x.hasPrefix(y) || y.hasPrefix(x)
    }

    private static func childrenOf(_ element: AXUIElement) -> [AXUIElement] {
        guard let raw = copyAttr(element, kAXChildrenAttribute) as? [AXUIElement] else { return [] }
        return raw
    }

    /// The child whose frame contains the point - the bounded step DOWN for a hit test that stopped at a
    /// container. Sixty children at most, the same cap the replay aimer uses on siblings. The SMALLEST
    /// containing frame wins, not the first listed: kAXChildren order is source order, and an unnamed
    /// container routinely leads with a full-bleed background child whose frame contains every point -
    /// the most specific frame is the thing a person actually sees. Hidden children do not count.
    private static func childAt(_ element: AXUIElement, x: Double, y: Double) -> AXUIElement? {
        var best: AXUIElement?
        var bestArea = Double.greatestFiniteMagnitude
        for child in childrenOf(element).prefix(60) {
            if let hidden = copyAttr(child, kAXHiddenAttribute) as? Bool, hidden { continue }
            guard let origin = pointAttr(child, kAXPositionAttribute),
                  let size = sizeAttr(child, kAXSizeAttribute),
                  size.width > 1, size.height > 1 else { continue }
            guard x >= origin.x, x <= origin.x + size.width,
                  y >= origin.y, y <= origin.y + size.height else { continue }
            let area = Double(size.width) * Double(size.height)
            if area < bestArea { bestArea = area; best = child }
        }
        return best
    }

    /* Where to click, given where it was recorded and WHAT was there.
     *
     * Returns nil when the point is already right, or when nothing better can be found - the caller then
     * uses the coordinate, exactly as before.
     *
     * This is the fix for a replay opening the wrong browser tab. Nothing was a pixel out: a tab strip
     * re-lays-out when the number of tabs changes, so a coordinate recorded at five tabs lands on a
     * different tab at six. Precision cannot help; the name can, and the recording has it.
     *
     * One level up, not a tree walk. The protocol forbids walking on the input path because it costs
     * seconds, and the same arithmetic applies here - but the siblings of the thing actually hit are where a
     * re-laid-out row of tabs, buttons or list rows keeps its neighbours, which is the case that fails. */
    static func aim(at point: CGPoint, expecting name: String, kind: String?) -> CGPoint? {
        guard Permission.accessibility, !name.isEmpty else { return nil }

        var element: AXUIElement?
        guard AXUIElementCopyElementAtPosition(systemWide, Float(point.x), Float(point.y), &element) == .success,
              let hit = element else { return nil }

        /* Aiming by name needs names to exist. In a browser that has not been asked for its tree there are
         * none, so every correction would silently decline - and the replay would look like it had checked. */
        var pid: pid_t = 0
        if AXUIElementGetPid(hit, &pid) == .success { awaken(pid: pid) }

        // Already on it: say so by returning nothing to change.
        if let now = nameOf(hit), sameName(now, name) { return nil }

        guard let parent = elementAttr(hit, kAXParentAttribute) else { return nil }
        let siblings = childrenOf(parent).prefix(60)
        for sibling in siblings {
            guard let title = nameOf(sibling), sameName(title, name) else { continue }
            /* The kind has to agree when the recording knew it: a tab and the page inside it can carry the
             * same title, and clicking the page instead of the tab does nothing at all. */
            if let wanted = kind, !wanted.isEmpty,
               let role = stringAttr(sibling, kAXRoleDescriptionAttribute),
               !sameName(role, wanted) {
                continue
            }
            guard let centre = centreOf(sibling), Desktop.contains(x: centre.x, y: centre.y) else { continue }
            return centre
        }
        return nil
    }

    /* The window under a point, from the window server - the fallback when the accessibility hit test gives
     * nothing. Front to back, ordinary windows only (layer 0 - the menu bar, the Dock and overlays live on
     * other layers), first one whose bounds contain the point. The owner's name never needs a permission;
     * the title needs Screen Recording and is honestly absent without it. */
    static func windowAt(x: Double, y: Double) -> (app: String?, title: String?)? {
        let options: CGWindowListOption = [.optionOnScreenOnly, .excludeDesktopElements]
        guard let list = CGWindowListCopyWindowInfo(options, kCGNullWindowID) as? [[String: Any]] else {
            return nil
        }
        for info in list {
            guard (info[kCGWindowLayer as String] as? Int) == 0 else { continue }
            guard let bounds = info[kCGWindowBounds as String] as? [String: Double],
                  let wx = bounds["X"], let wy = bounds["Y"],
                  let ww = bounds["Width"], let wh = bounds["Height"],
                  x >= wx, x <= wx + ww, y >= wy, y <= wy + wh else { continue }
            let app = (info[kCGWindowOwnerName as String] as? String).flatMap { ctxClean($0, 80) }
            let title = (info[kCGWindowName as String] as? String).flatMap { ctxClean($0, 120) }
            if app == nil && title == nil { return nil }
            return (app, title)
        }
        return nil
    }

    /* What is under a point. Runs on the resolver thread, never on the tap. */
    static func describe(_ job: Pending) {
        guard Permission.accessibility else { return }
        var element: AXUIElement?
        let err = AXUIElementCopyElementAtPosition(systemWide, Float(job.x), Float(job.y), &element)
        guard err == .success, let hit = element else {
            /* The hit test failed - but "which application, which window" does not need the tree. The
             * Windows agent answers those from the window manager (the window AT THE POINT, never the
             * foreground - a right-click into a background window does not activate it), and an Electron
             * application that names no controls still says "Claude". Same here: the front-to-back window
             * list, first window under the point. Control stays honestly absent. */
            if let under = windowAt(x: job.x, y: job.y) {
                job.target.app = under.app
                job.target.window = under.title
            }
            return
        }

        var pid: pid_t = 0
        let hasPid = AXUIElementGetPid(hit, &pid) == .success

        var named = nameByClimbing(hit)

        /* Nothing had a name. Before believing that, ask the application to build its tree and look once
         * more: a browser that has never seen an assistive technology answers exactly like this - a window,
         * and nothing inside it. The retry costs one hit test and only happens the first time a given
         * application comes up empty. */
        if named.control == nil, hasPid {
            awaken(pid: pid)
            var again: AXUIElement?
            if AXUIElementCopyElementAtPosition(systemWide, Float(job.x), Float(job.y), &again) == .success,
               let second = again {
                let retry = nameByClimbing(second)
                if retry.control != nil { named = retry }
            }
            /* And that is the only look back. A later re-read of the same coordinates was tried and
             * rejected: a click CHANGES the screen, and a name read after the change belongs to whatever
             * arrived, not to what was pressed. The tree-not-built-yet gap is closed from the other side -
             * prime() asks the frontmost application for its tree when Record is pressed, before the first
             * click needs it. */
        }

        /* The tab strip case, measured on a real machine: in Chromium the hit test for a tab returns an
         * unnamed GROUP that covers the whole strip, and the tab is that group's CHILD - visible to a
         * person, one level down, and unreachable by climbing UP. So when every cheaper answer came back
         * empty: among the hit element's children, the one whose frame contains the point, twice at most.
         * Not a tree walk - two frame-checked steps, and only after the climb and the awaken retry both
         * said nothing. */
        if named.control == nil {
            var node = hit
            for _ in 0..<2 {
                guard let child = childAt(node, x: job.x, y: job.y) else { break }
                let read = nameByClimbing(child)
                if read.control != nil { named = read; break }
                node = child
            }
        }

        job.target.app = appName(of: hit)
        job.target.control = named.control
        job.target.controlType = named.type
        job.target.role = named.role
        job.target.subrole = named.subrole
        job.target.container = named.container
        job.target.containerName = named.containerName
        job.target.url = named.url
        if hasPid { job.target.window = frontWindowTitle(pid: pid) }
    }

    /* What has FOCUS, which is a different question from what is under the pointer.
     *
     * Used for a run of typing: the pointer is wherever it was last left, and the field being typed into is
     * the only honest answer to "where did this go". */
    static func describeFocused(_ job: Pending) {
        guard Permission.accessibility else { return }
        guard let front = NSWorkspace.shared.frontmostApplication else { return }
        let pid = front.processIdentifier
        job.target.app = clip(front.localizedName ?? "", 80).isEmpty ? nil : clip(front.localizedName ?? "", 80)
        job.target.window = frontWindowTitle(pid: pid)

        /* Typing into a web page has the same problem as clicking in one: without the tree there is no
         * focused element to find, so the field somebody typed into has no name. */
        awaken(pid: pid)
        let app = AXUIElementCreateApplication(pid)
        guard let focused = elementAttr(app, kAXFocusedUIElementAttribute) else { return }
        let named = nameByClimbing(focused)
        job.target.control = named.control
        job.target.controlType = named.type
        job.target.role = named.role
        job.target.subrole = named.subrole
        job.target.container = named.container
        job.target.containerName = named.containerName
        /* The typing job too: a typing run is where a portable skill's inputs go, and a step saying which
         * page it went into is the difference between an instruction and a guess. */
        job.target.url = named.url
    }
}

// ================================================================ windows

/* What is open, because a screenshot is not the whole truth.
 *
 * An application that is minimised or behind another window is invisible to a picture, and something acting
 * only on pictures will happily launch a second copy of a program that is already running - which is what
 * happened on Windows, and is why this endpoint exists.
 */
struct WindowInfo {
    var title: String
    var process: String
    var active: Bool
    var minimized: Bool
    var x: Int
    var y: Int
    var w: Int
    var h: Int
    var pid: pid_t
}

enum Windows {
    /* Names of the shell's own windows, which are windows in the API's sense and not in a person's. The
     * Windows agent had the same list under different names (DWM-cloaked Store windows, the desktop shell,
     * helper windows too small to be real). */
    private static let shell: Set<String> = [
        "Window Server", "Dock", "SystemUIServer", "Spotlight", "Notification Center",
        "Control Center", "WindowManager", "Wallpaper", "コントロールセンター",
    ]

    static func list() -> [WindowInfo] {
        /* .optionAll rather than .optionOnScreenOnly, because a minimised window is exactly the case this
         * endpoint exists for and the on-screen list does not contain one. */
        let options: CGWindowListOption = [.optionAll, .excludeDesktopElements]
        guard let raw = CGWindowListCopyWindowInfo(options, kCGNullWindowID) as? [[String: Any]] else {
            return []
        }
        let frontPid = NSWorkspace.shared.frontmostApplication?.processIdentifier ?? -1
        var out: [WindowInfo] = []
        var seenFrontmost = false

        for entry in raw {
            let layer = entry[kCGWindowLayer as String] as? Int ?? 0
            // Layer 0 is a normal application window. Everything else is a menu, a panel or an overlay.
            if layer != 0 { continue }

            let owner = (entry[kCGWindowOwnerName as String] as? String) ?? ""
            if owner.isEmpty || shell.contains(owner) { continue }

            let alpha = entry[kCGWindowAlpha as String] as? Double ?? 1
            if alpha < 0.05 { continue }

            guard let boundsDict = entry[kCGWindowBounds as String] as? [String: Any],
                  let bounds = CGRect(dictionaryRepresentation: boundsDict as CFDictionary) else { continue }
            // Too small to be a real window: helper and shadow windows land here.
            if bounds.width < 40 || bounds.height < 40 { continue }

            let pid = pid_t(entry[kCGWindowOwnerPID as String] as? Int ?? 0)
            let onscreen = (entry[kCGWindowIsOnscreen as String] as? Bool) ?? false

            /* The title needs Screen Recording. Without it every window reports an empty name, so the app
             * falls back to the owner - which is a real answer ("Microsoft Outlook") rather than a blank row
             * that reads as "nothing is open". */
            var title = (entry[kCGWindowName as String] as? String) ?? ""
            if title.trimmingCharacters(in: .whitespaces).isEmpty { title = owner }

            /* Frontmost is the FIRST window of the frontmost process in this list, which is ordered
             * front-to-back. Marking every window of that process active would tell the model there are
             * four active windows. */
            var active = false
            if pid == frontPid && !seenFrontmost && onscreen {
                active = true
                seenFrontmost = true
            }

            out.append(WindowInfo(
                title: clip(title, 160),
                process: clip(owner, 80),
                active: active,
                /* macOS cannot separate "minimised" from "on another Space" through this list, and to the
                 * caller they mean the same thing: it is open, it is not visible, and action=activate is
                 * what gets to it. Said here rather than guessed at by the reader. */
                minimized: !onscreen,
                x: Int(bounds.origin.x),
                y: Int(bounds.origin.y),
                w: Int(bounds.width),
                h: Int(bounds.height),
                pid: pid
            ))
            if out.count >= 60 { break }
        }
        return out
    }

    /* Compared without its spaces, on both sides.
     *
     * The client strips whitespace out of `process`, and that is right rather than sloppy: a Windows process
     * name has none, and on the wire `process=` does not take the rest of the line, so a space would break
     * the field. But on macOS the space is IN the name - both the localized name and the executable are
     * "Google Chrome" - so "googlechrome" was being compared with "google chrome" and never matched. Hence
     * "switch to Google Chrome" failing where "switch to Chrome" worked. */
    private static func squashed(_ text: String) -> String {
        text.lowercased().filter { !$0.isWhitespace }
    }

    private static func names(of app: NSRunningApplication) -> [String] {
        var out: [String] = []
        if let name = app.localizedName { out.append(name) }
        if let exe = app.executableURL?.lastPathComponent { out.append(exe) }
        if let bundle = app.bundleIdentifier {
            out.append(bundle)
            // "com.google.Chrome" also answers to "Chrome", which is what a person would say.
            if let last = bundle.split(separator: ".").last { out.append(String(last)) }
        }
        return out
    }

    /// Bring something to the front without opening anything.
    static func activate(title: String?, process: String?) -> String? {
        let apps = NSWorkspace.shared.runningApplications.filter { $0.activationPolicy == .regular }
        let asked = [process, title].compactMap { $0 }.filter { !$0.isEmpty }

        for wanted in asked {
            let want = squashed(wanted)
            if want.isEmpty { continue }

            for app in apps where names(of: app).contains(where: { squashed($0).contains(want) }) {
                return raise(app)
            }

            /* By window title, which is what the model has been reading. The window list carries the owning
             * pid, so the title leads to the application without a second search. */
            for window in list() where squashed(window.title).contains(want) {
                if let app = NSRunningApplication(processIdentifier: window.pid) { return raise(app) }
            }
        }

        /* Word by word, and only then. "Google Chrome" should find Chrome and "Microsoft Outlook" should find
         * Outlook - a caller naming an application in full is not a caller naming the wrong one. Four
         * characters is the floor: shorter words match half the machine. */
        for wanted in asked {
            for word in wanted.split(whereSeparator: { $0.isWhitespace }) where word.count >= 4 {
                let want = squashed(String(word))
                for app in apps where names(of: app).contains(where: { squashed($0).contains(want) }) {
                    return raise(app)
                }
            }
        }

        /* Says what IS open. "Nothing matches" leaves the caller guessing, and a model's next guess costs a
         * step; a list turns it into a choice. */
        let open = apps.compactMap { $0.localizedName }.prefix(8).joined(separator: ", ")
        if open.isEmpty { return "nothing matches, and nothing is open to match" }
        return "nothing open matches that title or process. Open right now: " + open
    }

    private static func raise(_ app: NSRunningApplication) -> String? {
        /* Unminimise first, then activate. Activating a minimised application on macOS raises nothing
         * visible, so the click that follows would land on whatever is actually in front - the same class of
         * failure as replaying into a window that has moved on. */
        if Permission.accessibility {
            let axApp = AXUIElementCreateApplication(app.processIdentifier)
            var windows: CFTypeRef?
            if AXUIElementCopyAttributeValue(axApp, kAXWindowsAttribute as CFString, &windows) == .success,
               let list = windows as? [AXUIElement] {
                for window in list.prefix(8) {
                    var minimized: CFTypeRef?
                    if AXUIElementCopyAttributeValue(window, kAXMinimizedAttribute as CFString, &minimized) == .success,
                       let isMin = minimized as? Bool, isMin {
                        AXUIElementSetAttributeValue(window, kAXMinimizedAttribute as CFString, kCFBooleanFalse)
                    }
                }
                if let first = list.first {
                    AXUIElementPerformAction(first, kAXRaiseAction as CFString)
                }
            }
        }
        /* ignoringOtherApps does nothing from macOS 14 on, and saying so in a warning on every build is
         * worse than the two lines it takes to stop asking for it. */
        /* The deprecated thing is the OPTION, not the method, so an empty set is the same call without the
         * warning - and on macOS 14 and later the option was doing nothing anyway. */
        let ok: Bool
        if #available(macOS 14.0, *) {
            ok = app.activate()
        } else {
            ok = app.activate(options: [])
        }
        return ok ? nil : "macOS refused to bring \(app.localizedName ?? "it") forward"
    }
}

// ================================================================ seeing

/* Somewhere for an async capture to leave its answer. `@unchecked Sendable` because the semaphore is what
 * orders the two accesses: nothing reads it until the Task has signalled. */
private final class Captured: @unchecked Sendable {
    var value: (image: CGImage, frame: CGRect)?
}

enum Screen {
    /* One picture, through ScreenCaptureKit, because the old way is gone.
     *
     * CGWindowListCreateImage is not deprecated on macOS 15 - it is UNAVAILABLE: "Please use
     * ScreenCaptureKit instead", and the header marks it obsoleted. There is no keeping it behind an
     * #available either, since referencing it at all fails to compile against that SDK. So this is the only
     * path, and macOS 14 is the floor for seeing the screen at all; everything else still works below it.
     *
     * Two things this changes, and both are improvements. SCK scales during capture, so the picture arrives
     * at the size we want instead of being captured huge and shrunk. And it captures ONE DISPLAY - which is
     * a real limitation on a multi-monitor desk, and is why the frame reports the bounds of the display it
     * actually took rather than the union of all of them. A coordinate measured on the returned picture then
     * still maps back onto the right screen; what the agent cannot do is see the other one.
     *
     * Synchronous on purpose: every route here answers on its own thread and the client has a deadline. The
     * semaphore blocks that worker thread, never the accept loop. */
    @available(macOS 14.0, *)
    private static func grab(width: Int, height: Int) -> (image: CGImage, frame: CGRect)? {
        guard Permission.screenRecording else { return nil }

        let waiter = DispatchSemaphore(value: 0)
        /* The result travels in an object rather than a captured `var`: mutating a local from inside a Task
         * is a warning under Swift 5 and an error under Swift 6, and which one this gets compiled with is
         * somebody else's machine to decide. */
        let slot = Captured()

        Task {
            defer { waiter.signal() }
            do {
                /* Desktop windows excluded and on-screen only: the wallpaper and off-screen windows are not
                 * what anybody is looking at, and asking for less is faster. */
                let content = try await SCShareableContent.excludingDesktopWindows(
                    true, onScreenWindowsOnly: true
                )
                /* The display the pointer is on, falling back to the first. A person driving one window has
                 * that window under their cursor, and capturing the other monitor would be a picture of
                 * something nobody asked about. */
                let cursor = CGEvent(source: nil)?.location ?? .zero
                let display = content.displays.first(where: {
                    CGDisplayBounds($0.displayID).contains(cursor)
                }) ?? content.displays.first
                guard let display else { return }

                let filter = SCContentFilter(display: display, excludingWindows: [])
                let config = SCStreamConfiguration()
                config.width = max(1, width)
                config.height = max(1, height)
                config.captureResolution = .best
                config.showsCursor = true

                let image = try await SCScreenshotManager.captureImage(
                    contentFilter: filter, configuration: config
                )
                slot.value = (image, CGDisplayBounds(display.displayID))
            } catch {
                // Reported by the caller as a missing permission or a screen that could not be read.
            }
        }

        /* Bounded: a capture that never returns would hold this thread for the life of the agent, and the
         * client has already given up by then. */
        if waiter.wait(timeout: .now() + 8) == .timedOut { return nil }
        return slot.value
    }

    private static func resize(_ image: CGImage, _ w: Int, _ h: Int, gray: Bool) -> CGContext? {
        let space = gray ? CGColorSpaceCreateDeviceGray() : CGColorSpaceCreateDeviceRGB()
        let info: UInt32 = gray
            ? CGImageAlphaInfo.none.rawValue
            : CGImageAlphaInfo.premultipliedLast.rawValue
        guard let ctx = CGContext(
            data: nil, width: w, height: h, bitsPerComponent: 8,
            bytesPerRow: gray ? w : w * 4, space: space, bitmapInfo: info
        ) else { return nil }
        ctx.interpolationQuality = .medium
        ctx.draw(image, in: CGRect(x: 0, y: 0, width: w, height: h))
        return ctx
    }

    /* A picture, sized to a pixel budget rather than a fixed width, because a vision payload is priced in
     * pixels.
     *
     * `scale` is picture pixels per screen POINT, and that distinction is the macOS trap: CGEvent works in
     * points, a capture comes back in backing pixels, and on a Retina display those differ by two. The
     * client's one conversion is `screen = origin + picture / scale`, so as long as the returned picture is
     * `points * scale` wide, a point measured on it lands where it was measured. Capturing at full
     * resolution and then shrinking to that width is what makes it true on both kinds of display. */
    static func shot(want: Int) -> String {
        guard #available(macOS 14.0, *) else {
            return "{\"ok\":false,\"error\":\"seeing the screen needs macOS 14 or newer - "
                + "the API this used before was removed\"}"
        }

        /* The frame is worked out from the display the capture will come from, and that is a chicken and egg:
         * the size is needed before the capture and the display is known after it. Solved by measuring
         * against the display the CURSOR is on, which is the same one grab() will choose. */
        let cursor = CGEvent(source: nil)?.location ?? .zero
        let here = Desktop.displayContaining(cursor)
        let vw = Double(here.width)
        let vh = Double(here.height)
        if vw < 2 || vh < 2 { return "{\"ok\":false,\"error\":\"no screen\"}" }

        /* Two limits, and the tighter wins: the caller's width, and a pixel budget scaled to it so a large
         * display does not arrive as a novel. */
        let budget = 1_200_000.0
        let byWidth = Double(max(160, min(4096, want))) / vw
        let byArea = (budget / (vw * vh)).squareRoot()
        let scale = min(1.0, min(byWidth, byArea))
        let sw = max(1, Int((vw * scale).rounded()))
        let sh = max(1, Int((vh * scale).rounded()))

        guard let got = grab(width: sw, height: sh) else {
            return "{\"ok\":false,\"error\":\"macOS has not granted Screen Recording to this agent - "
                + "switch it on and it picks the grant up by itself within a few seconds - "
                + "System Settings, Privacy & Security, Screen Recording\"}"
        }

        let data = NSMutableData()
        guard let dest = CGImageDestinationCreateWithData(data, "public.jpeg" as CFString, 1, nil) else {
            return "{\"ok\":false,\"error\":\"no JPEG encoder\"}"
        }
        CGImageDestinationAddImage(dest, got.image, [kCGImageDestinationLossyCompressionQuality: 0.85] as CFDictionary)
        guard CGImageDestinationFinalize(dest) else {
            return "{\"ok\":false,\"error\":\"the screen could not be encoded\"}"
        }

        /* Measured off the picture that actually arrived, not off what was asked for: SCK may hand back a
         * slightly different size, and a scale computed from the request would then be wrong by that much -
         * which is a click landing next to its target rather than on it. */
        let actual = Double(got.image.width) / Double(got.frame.width)

        let b64 = (data as Data).base64EncodedString()
        /* A full MIME type, not an extension. The client puts this straight into a model request, where
         * anything other than image/jpeg, image/png, image/gif or image/webp is a 400 - and "jpeg" on its
         * own is exactly that 400. The Windows agent has always sent the long form; the protocol document
         * said the short one, and this followed the document. */
        var json = "{\"ok\":true,\"format\":\"image/jpeg\",\"bytes\":\(data.length)"
        json += ",\"png\":\"\(b64)\""
        json += ",\"w\":\(got.image.width),\"h\":\(got.image.height)"
        json += ",\"scale\":\(String(format: "%.4f", actual))"
        json += ",\"originX\":\(Int(got.frame.origin.x)),\"originY\":\(Int(got.frame.origin.y))}"
        return json
    }

    /* A fingerprint of the screen rather than a picture of it: 64x36 greyscale samples, about 3KB, which is
     * all "has anything changed" needs. Without it every "is it done yet?" costs a full screenshot and a
     * model call.
     *
     * The same luminance weights as the Windows agent, although the client only ever compares two grids for
     * difference - matching them costs nothing and means the two agents cannot disagree about what "the
     * screen changed" means. */
    static func pulse() -> String {
        guard #available(macOS 14.0, *) else {
            return "{\"ok\":false,\"error\":\"seeing the screen needs macOS 14 or newer\"}"
        }
        /* Captured small and then squashed to 64x36. The aspect ratio is deliberately not kept: the client
         * only ever compares one grid with the next, and matching the Windows agent's 64x36 exactly means
         * the two cannot disagree about what "the screen changed" means. */
        guard let got = grab(width: 128, height: 72) else {
            return "{\"ok\":false,\"error\":\"macOS has not granted Screen Recording to this agent\"}"
        }
        guard let ctx = resize(got.image, 64, 36, gray: false), let data = ctx.data else {
            return "{\"ok\":false,\"error\":\"no screen\"}"
        }
        let bytes = data.bindMemory(to: UInt8.self, capacity: 64 * 36 * 4)
        var grey = [UInt8](repeating: 0, count: 64 * 36)
        for i in 0..<(64 * 36) {
            let r = Int(bytes[i * 4])
            let g = Int(bytes[i * 4 + 1])
            let b = Int(bytes[i * 4 + 2])
            grey[i] = UInt8((r * 77 + g * 150 + b * 29) >> 8)
        }
        return "{\"ok\":true,\"grid\":\"\(Data(grey).base64EncodedString())\"}"
    }
}

// ================================================================ acting

/* Named keys, by virtual keycode.
 *
 * macOS keycodes are positional rather than alphabetic, so a table is unavoidable for the named keys. Text
 * does not go through it: `action=type` sets a unicode string on a synthetic event, which types any character
 * on any keyboard layout without a keymap. */
let KEY_CODES: [String: CGKeyCode] = [
    "return": 36, "enter": 36, "tab": 48, "space": 49, "delete": 51, "backspace": 51,
    "escape": 53, "esc": 53, "forwarddelete": 117, "del": 117,
    "left": 123, "right": 124, "down": 125, "up": 126,
    "home": 115, "end": 119, "pageup": 116, "pagedown": 121,
    "f1": 122, "f2": 120, "f3": 99, "f4": 118, "f5": 96, "f6": 97, "f7": 98, "f8": 100,
    "f9": 101, "f10": 109, "f11": 103, "f12": 111,
    "a": 0, "b": 11, "c": 8, "d": 2, "e": 14, "f": 3, "g": 5, "h": 4, "i": 34, "j": 38,
    "k": 40, "l": 37, "m": 46, "n": 45, "o": 31, "p": 35, "q": 12, "r": 15, "s": 1,
    "t": 17, "u": 32, "v": 9, "w": 13, "x": 7, "y": 16, "z": 6,
    "0": 29, "1": 18, "2": 19, "3": 20, "4": 21, "5": 23, "6": 22, "7": 26, "8": 28, "9": 25,
]

enum Input {
    private static func source() -> CGEventSource? {
        CGEventSource(stateID: .hidSystemState)
    }

    /// Every event this agent posts carries the mark, so the tap can tell a replay from a person.
    private static func send(_ event: CGEvent?) {
        guard let event else { return }
        event.setIntegerValueField(.eventSourceUserData, value: INJECTED_MARK)
        event.post(tap: .cghidEventTap)
    }

    /* There is no return value to check.
     *
     * The Windows agent checks SendInput's, because input that never arrived being reported as success is a
     * lie the model then builds on. CGEventPost returns nothing at all, so the check has to happen before:
     * without Accessibility every posted event is silently discarded, and that is the failure that actually
     * occurs. Checked once, here, and reported in the words of the thing the user has to do. */
    static func refusal() -> String? {
        if !Permission.accessibility {
            return "macOS has not granted Accessibility to MouseFlow Agent, so it cannot click or type - "
                + "switch it on in System Settings, Privacy & Security, Accessibility"
        }
        return nil
    }

    static func move(x: Double, y: Double) {
        send(CGEvent(mouseEventSource: source(), mouseType: .mouseMoved,
                     mouseCursorPosition: CGPoint(x: x, y: y), mouseButton: .left))
    }

    static func click(x: Double, y: Double, button: String, double: Bool) {
        let point = CGPoint(x: x, y: y)
        let (down, up, which): (CGEventType, CGEventType, CGMouseButton) = {
            switch button.lowercased() {
            case "right": return (.rightMouseDown, .rightMouseUp, .right)
            case "middle": return (.otherMouseDown, .otherMouseUp, .center)
            default: return (.leftMouseDown, .leftMouseUp, .left)
            }
        }()

        move(x: x, y: y)
        usleep(20_000)

        for pass in 1...(double ? 2 : 1) {
            for type in [down, up] {
                if let event = CGEvent(mouseEventSource: source(), mouseType: type,
                                       mouseCursorPosition: point, mouseButton: which) {
                    /* clickState is what makes two clicks a double click rather than two clicks. Without it
                     * a "double" opens nothing, which looks like the coordinates being wrong. */
                    event.setIntegerValueField(.mouseEventClickState, value: Int64(pass))
                    send(event)
                }
            }
            if double && pass == 1 { usleep(60_000) }
        }
    }

    static func scroll(x: Double, y: Double, amount: Int) {
        move(x: x, y: y)
        usleep(20_000)
        /* One event per notch, because a single event with a large delta is treated as a fling by some
         * applications and scrolls further than asked. */
        let steps = min(30, abs(amount))
        let direction: Int32 = amount >= 0 ? 1 : -1
        for _ in 0..<max(1, steps) {
            send(CGEvent(scrollWheelEvent2Source: source(), units: .line,
                         wheelCount: 1, wheel1: direction, wheel2: 0, wheel3: 0))
            usleep(12_000)
        }
    }

    /* Any text, on any layout, without a keymap: a synthetic key event carrying a unicode string. */
    static func type(_ text: String) {
        /* In small pieces rather than one event: a synthetic key event carries a bounded unicode string, and
         * a paragraph handed over in one go arrives truncated. */
        for chunk in Array(text).chunked(into: 16) {
            let piece = String(chunk)
            guard let down = CGEvent(keyboardEventSource: source(), virtualKey: 0, keyDown: true),
                  let up = CGEvent(keyboardEventSource: source(), virtualKey: 0, keyDown: false) else { continue }
            var utf16 = Array(piece.utf16)
            down.keyboardSetUnicodeString(stringLength: utf16.count, unicodeString: &utf16)
            up.keyboardSetUnicodeString(stringLength: utf16.count, unicodeString: &utf16)
            send(down)
            send(up)
            usleep(8_000)
        }
    }

    /* One named key, with modifiers.
     *
     * `ctrl=1` becomes COMMAND, and that is a deliberate translation rather than an oversight. The action
     * grammar was written on Windows, where Ctrl+C is copy; on macOS the same intention is Cmd+C, and a
     * created skill that says ctrl=1 key=c means "copy". Posting a literal Control+C here would send an
     * interrupt to a terminal instead. `cmd=` and `meta=` are accepted as themselves for a caller that knows
     * which platform it is talking to, and `raw-ctrl=` asks for the literal Control key. */
    static func key(_ name: String, ctrl: Bool, shift: Bool, alt: Bool, cmd: Bool, rawCtrl: Bool) -> String? {
        guard let code = KEY_CODES[name.lowercased()] else { return "no key called \(name)" }
        var flags: CGEventFlags = []
        if shift { flags.insert(.maskShift) }
        if alt { flags.insert(.maskAlternate) }
        if rawCtrl { flags.insert(.maskControl) }
        if ctrl || cmd { flags.insert(.maskCommand) }

        guard let down = CGEvent(keyboardEventSource: source(), virtualKey: code, keyDown: true),
              let up = CGEvent(keyboardEventSource: source(), virtualKey: code, keyDown: false) else {
            return "macOS refused to make that key event"
        }
        down.flags = flags
        up.flags = flags
        send(down)
        send(up)
        return nil
    }
}

extension Array {
    func chunked(into size: Int) -> [[Element]] {
        stride(from: 0, to: count, by: size).map { Array(self[$0..<Swift.min($0 + size, count)]) }
    }
}

// ================================================================ the action body

/* `key=value` pairs separated by spaces, with two rules that were learned the hard way on Windows and are
 * repeated here because they are properties of the FORMAT, not of the platform:
 *
 *   - `text=` and `title=` take the REST OF THE LINE, unsplit. They contain spaces.
 *   - a marker only counts at the START of a token, or `subtitle=` matches `title=` and the parse begins
 *     four characters into the wrong word.
 */
func parseAction(_ body: String) -> [String: String] {
    let line = body.split(separator: "\n", maxSplits: 1).first.map(String.init) ?? ""
    var out: [String: String] = [:]
    let tokens = line.split(separator: " ").map(String.init)
    var i = 0
    while i < tokens.count {
        let token = tokens[i]
        guard let eq = token.firstIndex(of: "=") else { i += 1; continue }
        let name = String(token[token.startIndex..<eq])
        let value = String(token[token.index(after: eq)...])

        /* Takes the rest of the line, like text and title: a label contains spaces, and splitting it on the
         * first one would aim at "New" when the button says "New message". */
        if name == "text" || name == "title" || name == "name" {
            let rest = ([value] + tokens[(i + 1)...]).joined(separator: " ")
            out[name] = rest
            break
        }
        out[name] = value
        i += 1
    }
    return out
}

func doAction(_ body: String) -> String? {
    let fields = parseAction(body)
    let action = (fields["action"] ?? "").lowercased()
    if let refusal = Input.refusal(), action != "activate" { return refusal }

    let x = Double(fields["x"] ?? "") ?? 0
    let y = Double(fields["y"] ?? "") ?? 0
    let needsPoint = ["click", "move", "scroll"].contains(action)
    if needsPoint && !Desktop.contains(x: x, y: y) {
        /* Refused rather than clamped: macOS would place the click at the nearest real coordinate, so an
         * out-of-bounds instruction would land on something and be reported as success. */
        let r = Desktop.rect
        return "\(Int(x)),\(Int(y)) is off the desktop "
            + "(\(Int(r.minX)),\(Int(r.minY)) to \(Int(r.maxX)),\(Int(r.maxY)))"
    }

    switch action {
    case "click":
        /* `name=` is what the caller believes it is clicking, in the words on screen. A coordinate read off a
         * downscaled screenshot is a point; a name is the target, and they part company the moment anything
         * re-lays-out - a tab strip does it every time the number of tabs changes. Same aim as the replay
         * uses, and it only ever moves the click when the point is on something ELSE by that name's
         * reckoning. */
        var at = CGPoint(x: x, y: y)
        if let label = fields["name"], !label.isEmpty,
           let better = Accessibility.aim(at: at, expecting: label, kind: nil) {
            at = better
        }
        Input.click(x: at.x, y: at.y, button: fields["button"] ?? "left",
                    double: (fields["double"] ?? "0") == "1")
        return nil
    case "move":
        Input.move(x: x, y: y)
        return nil
    case "scroll":
        Input.scroll(x: x, y: y, amount: Int(fields["amount"] ?? "") ?? -3)
        return nil
    case "type":
        var text = fields["text"] ?? ""
        if (fields["enc"] ?? "") == "b64" {
            guard let data = Data(base64Encoded: text), let decoded = String(data: data, encoding: .utf8) else {
                return "that text is not base64 UTF-8"
            }
            text = decoded
        }
        if text.isEmpty { return "nothing to type" }

        let newline = (fields["nl"] ?? "").lowercased()
        if newline.isEmpty || !text.contains("\n") {
            Input.type(text.replacingOccurrences(of: "\n", with: " "))
            return nil
        }
        /* `nl=enter` presses Return between lines, `nl=shift` presses Shift+Return - which is the difference
         * between sending an email and typing a paragraph into one. The pause after a line break is not
         * politeness: typing straight through it loses characters while the application reflows. */
        let lines = text.split(separator: "\n", omittingEmptySubsequences: false).map(String.init)
        for (index, one) in lines.enumerated() {
            if !one.isEmpty { Input.type(one) }
            if index < lines.count - 1 {
                if let bad = Input.key("return", ctrl: false, shift: newline == "shift",
                                       alt: false, cmd: false, rawCtrl: false) {
                    return bad
                }
                usleep(220_000)
            }
        }
        return nil
    case "key":
        let name = fields["key"] ?? ""
        if name.isEmpty { return "which key?" }
        return Input.key(
            name,
            ctrl: (fields["ctrl"] ?? "0") == "1",
            shift: (fields["shift"] ?? "0") == "1",
            alt: (fields["alt"] ?? "0") == "1",
            cmd: (fields["cmd"] ?? fields["meta"] ?? "0") == "1",
            rawCtrl: (fields["raw-ctrl"] ?? "0") == "1"
        )
    case "activate":
        return Windows.activate(title: fields["title"], process: fields["process"])
    default:
        return "no action called \(action.isEmpty ? "(none given)" : action)"
    }
}

// ================================================================ replay

/* What the recording knew about a click's target, carried into the replay.
 *
 * `flowBody` used to send five columns and nothing else, so a replay had coordinates while the recording it
 * came from knew the name of the thing it clicked. Comment lines were already skipped by every reader of this
 * format, so the context could always have travelled - it simply was not sent. */
struct ReplayCtx {
    var control: String?
    var type: String?
}

struct ReplayStep {
    var repeats = 1
    var speed = 1.0
    var delayAfterMs = 0
    var events: [(x: Int, y: Int, delayMs: Int, action: String, ctx: ReplayCtx?)] = []
}

final class Replayer {
    static let shared = Replayer()

    private let gate = NSLock()
    private var playing = false
    private var abort = false
    private var stepIdx = 0
    private var stepCount = 0
    private var pass = 0
    private var passes = 0
    private var evIdx = 0
    private var evCount = 0
    private var flowPass = 0
    private var flowPasses = 0
    /* Events a replay could not perform. A recording with typing in it cannot be replayed faithfully -
     * nothing in it says which keys - and a replay that quietly pressed nothing for the two minutes somebody
     * spent typing would report a clean run. */
    private var unplayable = 0
    /* Clicks that were aimed by name instead of by coordinate. Reported rather than silent: a replay that
     * quietly moved where it clicked is a replay whose report cannot be trusted, and this is the number that
     * says how much of the run was the coordinates and how much was the names. */
    private var retargeted = 0
    /// Every button this replay is holding, so every exit path can let go of them.
    private var down: Set<String> = []
    /* Where the last press actually landed after aiming. The release has to follow it: releasing at the
     * recorded coordinate after pressing somewhere else turns one click into a drag across the window. */
    private var aimed: CGPoint?

    private func aimedPoint() -> CGPoint? { gate.lock(); defer { gate.unlock() }; return aimed }

    var isPlaying: Bool { gate.lock(); defer { gate.unlock() }; return playing }

    func statusJson() -> String {
        gate.lock()
        defer { gate.unlock() }
        return "{\"playing\":\(jsonBool(playing)),\"step\":\(stepIdx),\"steps\":\(stepCount)"
            + ",\"pass\":\(pass),\"passes\":\(passes),\"index\":\(evIdx),\"total\":\(evCount)"
            + ",\"flowPass\":\(flowPass),\"flowPasses\":\(flowPasses),\"unplayable\":\(unplayable)"
            + ",\"retargeted\":\(retargeted)}"
    }

    func requestAbort() {
        gate.lock()
        abort = true
        gate.unlock()
    }

    /* Interruptible, and that is the point: the protocol says check the stop flag before every event AND
     * inside every sleep. A replay that only checks between events is unstoppable during a three-second
     * pause, which is most of its life. */
    private func nap(_ ms: Int) -> Bool {
        var left = ms
        while left > 0 {
            gate.lock()
            let stop = abort
            gate.unlock()
            if stop { return false }
            /* A held ESC as a hardware-level escape hatch, copied from the Windows agent: when a replay is
             * driving the pointer, reaching the app's Abort button with the mouse is a race. */
            if CGEventSource.keyState(.combinedSessionState, key: 53) { return false }
            let slice = min(25, left)
            usleep(UInt32(slice * 1000))
            left -= slice
        }
        gate.lock()
        let stop = abort
        gate.unlock()
        return !stop
    }

    func start(body: String) -> String? {
        gate.lock()
        if playing { gate.unlock(); return "already replaying" }
        if let refusal = Input.refusal() { gate.unlock(); return refusal }
        gate.unlock()

        var startDelay = 0
        var flowRepeat = 1
        var steps: [ReplayStep] = []
        var current: ReplayStep?

        /* The context of the NEXT event line, from a `#ctx` comment above it - the same way it travels in a
         * recording. */
        var pending: ReplayCtx?

        for raw in body.split(separator: "\n", omittingEmptySubsequences: true) {
            let line = raw.trimmingCharacters(in: .whitespaces)
            if line.hasPrefix("#ctx") {
                var ctx = ReplayCtx()
                for field in line.dropFirst(4).split(separator: "\t") {
                    let parts = field.split(separator: "=", maxSplits: 1)
                    guard parts.count == 2 else { continue }
                    let value = String(parts[1])
                    if parts[0] == "control" { ctx.control = value }
                    if parts[0] == "type" { ctx.type = value }
                }
                pending = (ctx.control == nil && ctx.type == nil) ? nil : ctx
                continue
            }
            if line.isEmpty || line.hasPrefix("#") { continue }

            if line.hasPrefix("startDelay=") {
                startDelay = Int(line.dropFirst("startDelay=".count)) ?? 0
                continue
            }
            if line.hasPrefix("flowRepeat=") {
                let v = String(line.dropFirst("flowRepeat=".count))
                // `forever` and `0` mean the same thing, as the protocol says.
                flowRepeat = (v == "forever") ? 0 : (Int(v) ?? 1)
                continue
            }
            if line.hasPrefix("STEP") {
                if let done = current { steps.append(done) }
                var step = ReplayStep()
                for token in line.split(separator: " ").dropFirst() {
                    let parts = token.split(separator: "=", maxSplits: 1)
                    guard parts.count == 2 else { continue }
                    switch parts[0] {
                    case "repeat": step.repeats = (parts[1] == "forever") ? 0 : (Int(parts[1]) ?? 1)
                    case "speed": step.speed = Double(parts[1]) ?? 1.0
                    case "delayAfter": step.delayAfterMs = Int(parts[1]) ?? 0
                    default: break
                    }
                }
                current = step
                continue
            }

            let cols = line.split(separator: "|").map { $0.trimmingCharacters(in: .whitespaces) }
            guard cols.count >= 5 else { continue }
            if current == nil { current = ReplayStep() }
            current?.events.append((
                x: Int(cols[1]) ?? 0,
                y: Int(cols[2]) ?? 0,
                delayMs: Int(cols[3]) ?? 0,
                action: cols[4],
                ctx: pending
            ))
            pending = nil
        }
        if let done = current { steps.append(done) }
        if steps.isEmpty || steps.allSatisfy({ $0.events.isEmpty }) { return "nothing to replay" }

        gate.lock()
        playing = true
        abort = false
        unplayable = 0
        retargeted = 0
        stepIdx = 0
        stepCount = steps.count
        flowPass = 0
        flowPasses = flowRepeat
        down = []
        gate.unlock()

        let thread = Thread { self.run(steps: steps, startDelay: startDelay, flowRepeat: flowRepeat) }
        thread.stackSize = 512 * 1024
        thread.start()
        return nil
    }

    private func run(steps: [ReplayStep], startDelay: Int, flowRepeat: Int) {
        /* Released on EVERY exit path, including the failure paths: a replay that dies holding the left
         * mouse button leaves the machine unusable, and that is not a hypothetical - it is why the protocol
         * says so twice. */
        defer {
            releaseEverything()
            gate.lock()
            playing = false
            gate.unlock()
        }

        if startDelay > 0, !nap(startDelay) { return }

        var flowLoop = 0
        while true {
            flowLoop += 1
            gate.lock(); flowPass = flowLoop; gate.unlock()

            for (index, step) in steps.enumerated() {
                gate.lock()
                stepIdx = index + 1
                passes = step.repeats
                evCount = step.events.count
                gate.unlock()

                var loop = 0
                while true {
                    loop += 1
                    gate.lock(); pass = loop; gate.unlock()

                    for (evIndex, event) in step.events.enumerated() {
                        gate.lock(); evIdx = evIndex + 1; gate.unlock()

                        let wait = step.speed > 0 ? Int(Double(event.delayMs) / step.speed) : event.delayMs
                        if !nap(wait) { return }
                        if !perform(event) { return }
                    }

                    if step.repeats != 0 && loop >= step.repeats { break }
                    if !nap(60) { return }
                }

                if step.delayAfterMs > 0, !nap(step.delayAfterMs) { return }
            }

            if flowRepeat != 0 && flowLoop >= flowRepeat { break }
            if !nap(120) { return }
        }
    }

    /// False means stop - either aborted or refused.
    private func perform(_ event: (x: Int, y: Int, delayMs: Int, action: String, ctx: ReplayCtx?)) -> Bool {
        var x = Double(event.x)
        var y = Double(event.y)

        /* Aim by name where the recording knew one, and only on the press: the release belongs at whatever
         * point the press ended up at, or a click becomes a drag from one place to another.
         *
         * Cleared on EVERY press, not only on the ones that carry a name. Setting it without clearing it
         * leaves the last aimed point behind, and the next release - belonging to a click that was never
         * re-aimed - would go there instead: a click that presses in one place and releases in another,
         * which is a drag nobody asked for. */
        if event.action.hasSuffix("Click Down") {
            var better: CGPoint?
            if let name = event.ctx?.control, !name.isEmpty {
                better = Accessibility.aim(at: CGPoint(x: x, y: y), expecting: name, kind: event.ctx?.type)
            }
            if let point = better {
                x = point.x
                y = point.y
            }
            gate.lock()
            aimed = better
            if better != nil { retargeted += 1 }
            gate.unlock()
        }
        /* The release follows the press, wherever the press went. */
        if event.action.hasSuffix("Click Release"), let at = aimedPoint() {
            x = at.x
            y = at.y
        }

        switch event.action {
        case "Mouse Movement":
            Input.move(x: x, y: y)
        case "Left Click Down":
            hold("left"); post(.leftMouseDown, x, y, .left)
        case "Left Click Release":
            release("left"); post(.leftMouseUp, x, y, .left)
        case "Right Click Down":
            hold("right"); post(.rightMouseDown, x, y, .right)
        case "Right Click Release":
            release("right"); post(.rightMouseUp, x, y, .right)
        case "Middle Click Down":
            hold("middle"); post(.otherMouseDown, x, y, .center)
        case "Middle Click Release":
            release("middle"); post(.otherMouseUp, x, y, .center)
        case "Scroll Up":
            Input.scroll(x: x, y: y, amount: 3)
        case "Scroll Down":
            Input.scroll(x: x, y: y, amount: -3)

        /* Named here rather than dropped through the default, exactly as on Windows.
         *
         * A keystroke has no key in it - by design, see the protocol - and a Focus is a note, not an action.
         * Both are counted and reported as `unplayable`, because a replay that pressed nothing for the two
         * minutes somebody spent typing must not come back looking like a clean run. The pause before each
         * one is still waited out, so the replay keeps the shape of the original. */
        case "Key Down", "Focus":
            gate.lock(); unplayable += 1; gate.unlock()

        default:
            gate.lock(); unplayable += 1; gate.unlock()
        }
        return true
    }

    private func post(_ type: CGEventType, _ x: Double, _ y: Double, _ button: CGMouseButton) {
        guard let source = CGEventSource(stateID: .hidSystemState) else { return }
        guard let event = CGEvent(mouseEventSource: source, mouseType: type,
                                 mouseCursorPosition: CGPoint(x: x, y: y), mouseButton: button) else { return }
        event.setIntegerValueField(.eventSourceUserData, value: INJECTED_MARK)
        event.post(tap: .cghidEventTap)
    }

    private func hold(_ name: String) { gate.lock(); down.insert(name); gate.unlock() }
    private func release(_ name: String) { gate.lock(); down.remove(name); gate.unlock() }

    private func releaseEverything() {
        gate.lock()
        let holding = down
        down = []
        gate.unlock()
        guard !holding.isEmpty else { return }
        let at = CGEvent(source: nil)?.location ?? .zero
        for name in holding {
            switch name {
            case "right": post(.rightMouseUp, at.x, at.y, .right)
            case "middle": post(.otherMouseUp, at.x, at.y, .center)
            default: post(.leftMouseUp, at.x, at.y, .left)
            }
        }
    }
}

// ================================================================ the event tap

var eventTap: CFMachPort?

/* The tap callback. Fast, and reads nothing it does not need.
 *
 * Two rules live here, both from the protocol:
 *
 *   - NOTHING is resolved on this path. The tap has a timeout and macOS disables it rather than telling
 *     anybody - the same failure as a Windows hook overrunning LowLevelHooksTimeout - so this queues and
 *     returns, and a worker thread does the accessibility calls.
 *   - a key event is counted, never read. `.keyboardEventKeycode` is available on the event handed in here
 *     and is deliberately not touched: a tap that reads key codes has captured a password whether or not it
 *     stores one.
 */
private func tapCallback(
    proxy: CGEventTapProxy, type: CGEventType, event: CGEvent, refcon: UnsafeMutableRawPointer?
) -> Unmanaged<CGEvent>? {
    /* Re-enabled rather than logged. When the OS disables a tap the agent keeps running and records nothing,
     * which looks exactly like a recording of an idle machine. */
    if type == .tapDisabledByTimeout || type == .tapDisabledByUserInput {
        if let tap = eventTap { CGEvent.tapEnable(tap: tap, enable: true) }
        return Unmanaged.passUnretained(event)
    }

    // Our own replay, not a person. See INJECTED_MARK.
    if event.getIntegerValueField(.eventSourceUserData) == INJECTED_MARK {
        return Unmanaged.passUnretained(event)
    }

    let point = event.location
    let x = Int(point.x.rounded())
    let y = Int(point.y.rounded())

    switch type {
    case .mouseMoved, .leftMouseDragged, .rightMouseDragged, .otherMouseDragged:
        /* A drag is its own event type on macOS, not a move with a button down. Recording only .mouseMoved
         * would give a press, no motion and a release - a drag that replays as a click. */
        Recorder.shared.capture(action: "Mouse Movement", x: x, y: y)
    case .leftMouseDown:
        Recorder.shared.capture(action: "Left Click Down", x: x, y: y)
    case .leftMouseUp:
        Recorder.shared.capture(action: "Left Click Release", x: x, y: y)
    case .rightMouseDown:
        Recorder.shared.capture(action: "Right Click Down", x: x, y: y)
    case .rightMouseUp:
        Recorder.shared.capture(action: "Right Click Release", x: x, y: y)
    case .otherMouseDown:
        Recorder.shared.capture(action: "Middle Click Down", x: x, y: y)
    case .otherMouseUp:
        Recorder.shared.capture(action: "Middle Click Release", x: x, y: y)
    case .scrollWheel:
        let delta = event.getIntegerValueField(.scrollWheelEventDeltaAxis1)
        Recorder.shared.capture(action: delta >= 0 ? "Scroll Up" : "Scroll Down", x: x, y: y)
    case .keyDown:
        /* A key was pressed, and when. Never which.
         *
         * One difference from Windows worth naming: a bare modifier arrives as .flagsChanged, not .keyDown,
         * and is not subscribed to here - so holding Shift alone is not counted as typing, where on Windows
         * it is. Both answers are defensible and the transcript only reads density and duration, so the
         * cheaper one wins. */
        Recorder.shared.captureKey()
    default:
        break
    }

    return Unmanaged.passUnretained(event)
}

/* Installed on its own thread with its own run loop. A tap needs one, and the HTTP accept loop owns the
 * main thread. */
let installGate = NSLock()

func installTap() -> Bool {
    /* Idempotent under a lock, because two callers can want it at once: the /record/start handler on an
     * HTTP thread and the permission watcher on its own. Two live taps would record every event twice. */
    installGate.lock()
    defer { installGate.unlock() }
    if eventTap != nil { return true }
    guard Permission.accessibility else { return false }

    /* Built in a loop rather than as one expression.
     *
     * Twelve `1 << rawValue` terms joined by `|` made the compiler give up: "unable to type-check this
     * expression in reasonable time". Swift's type checker searches over every overload of `<<` and `|` for
     * every term, and the search is exponential. A list and a loop cost nothing and cannot blow up. */
    let watched: [CGEventType] = [
        .mouseMoved,
        .leftMouseDown, .leftMouseUp,
        .rightMouseDown, .rightMouseUp,
        .otherMouseDown, .otherMouseUp,
        /* Dragging is its own type on macOS, not a move with a button held. Without these three a drag
         * records as a press, nothing, and a release - a drag that replays as a click. */
        .leftMouseDragged, .rightMouseDragged, .otherMouseDragged,
        .scrollWheel,
        .keyDown,
    ]
    var mask: CGEventMask = 0
    for type in watched {
        mask |= CGEventMask(1) << CGEventMask(type.rawValue)
    }

    /* .listenOnly, which is not an optimisation: a tap that can alter events is a tap that can drop them,
     * and a recorder must never change what the person is doing while it watches. */
    guard let tap = CGEvent.tapCreate(
        tap: .cgSessionEventTap,
        place: .headInsertEventTap,
        options: .listenOnly,
        eventsOfInterest: mask,
        callback: tapCallback,
        userInfo: nil
    ) else { return false }

    eventTap = tap
    let thread = Thread {
        let loop = CFRunLoopGetCurrent()
        let source = CFMachPortCreateRunLoopSource(kCFAllocatorDefault, tap, 0)
        CFRunLoopAddSource(loop, source, .commonModes)
        CGEvent.tapEnable(tap: tap, enable: true)
        CFRunLoopRun()
    }
    thread.name = "MouseFlowTap"
    thread.start()
    return true
}

// ================================================================ autostart

// ================================================================ the account

/* Taking work from the account: what makes "start recording on my Mac" possible from a chat that is not on
 * this Mac.
 *
 * The thing it solves is a DIRECTION, not a feature. This agent listens on loopback and nothing on the
 * internet can reach it - deliberately, and that is not going to change. So the machine asks: it holds a
 * token, long-polls the account for a job, does it, and says how it went. No inbound path to this computer
 * exists at any point, and an agent that is not taking work makes no outbound call at all.
 *
 * OFF UNTIL SOMEBODY SWITCHES IT ON, and visible in the menu bar while it is. Everything else here happens
 * because something on this machine asked; this is the one thing the agent would do because a service said
 * so, and that difference belongs where the person can see it and turn it off.
 *
 * The token is handed over by the app across loopback - the same pairing the extension gets - so nobody has
 * to read one, copy one, or keep one anywhere. It is written 0600 beside the held recording, which is the
 * same exposure as any credential in a home directory and is stated in the docs rather than left to be
 * discovered.
 */
/* Where the courier says things. stdout is what the launchd job records, and the installer's doctor prints
 * it - the same place the startup banner and the permission watcher already speak. */
func log(_ words: String) {
    print("[mouseflow] " + words)
}

enum Account {
    struct Link {
        var token: String
        var base: String
        var taking: Bool
    }

    private static let gate = NSLock()
    private static var current: Link?

    private static var dir: String {
        FileManager.default.homeDirectoryForCurrentUser.path + "/Library/Application Support/MouseFlow"
    }
    private static var path: String { dir + "/account.json" }

    static var link: Link? {
        gate.lock(); defer { gate.unlock() }
        return current
    }

    /// Read once at startup. A missing or unreadable file means "not linked", which is the safe answer.
    static func load() {
        guard let data = FileManager.default.contents(atPath: path),
              let raw = (try? JSONSerialization.jsonObject(with: data)) as? [String: Any],
              let token = raw["token"] as? String, !token.isEmpty else { return }
        let base = (raw["base"] as? String) ?? "https://mouseflowapp.vercel.app"
        let taking = (raw["taking"] as? Bool) ?? false
        gate.lock()
        current = Link(token: token, base: base, taking: taking)
        gate.unlock()
    }

    private static func write(_ link: Link?) {
        guard let link = link else {
            try? FileManager.default.removeItem(atPath: path)
            return
        }
        try? FileManager.default.createDirectory(atPath: dir, withIntermediateDirectories: true)
        let json: [String: Any] = ["token": link.token, "base": link.base, "taking": link.taking]
        guard let data = try? JSONSerialization.data(withJSONObject: json) else { return }
        /* Replaced rather than written over, and 0600: a credential that was briefly world-readable was
         * world-readable. */
        try? FileManager.default.removeItem(atPath: path)
        FileManager.default.createFile(atPath: path, contents: data,
                                       attributes: [.posixPermissions: NSNumber(value: Int16(0o600))])
    }

    static func set(token: String, base: String, taking: Bool) {
        gate.lock()
        current = Link(token: token, base: base, taking: taking)
        let copy = current
        gate.unlock()
        write(copy)
    }

    static func setTaking(_ on: Bool) {
        gate.lock()
        if current != nil { current!.taking = on }
        let copy = current
        gate.unlock()
        write(copy)
    }

    static func forget() {
        gate.lock()
        current = nil
        gate.unlock()
        write(nil)
    }
}

/* The one outward-facing loop: ask for work, do it, say how it went.
 *
 * Long-polling rather than a fast poll - the endpoint holds the request open for up to half a minute with
 * nothing to say - so an idle machine costs one request a minute rather than twenty, and an idle wait costs
 * no CPU at either end. Backs off to a minute on failure, because an agent that hammers a deployment which
 * is down makes the outage worse.
 *
 * One job at a time, and no queue of its own. There is one mouse.
 */
enum Courier {
    private static let claimWaitSeconds = 25
    private static var backoff: UInt32 = 2

    enum Claimed {
        case job(Job)
        case idle
        case failed(String)
    }

    struct Job {
        var id: String
        var command: String?
        /// A replay body, built by the deployment for a skill. The agent never has to know what a skill is.
        var body: String?
        /// `action=activate ...`, for the window the recording belongs to. Best effort, exactly as the app does it.
        var activate: String?
        var moveMs: Int
    }

    static func begin() {
        Thread.detachNewThread {
            Thread.current.name = "mouseflow.courier"
            loop()
        }
    }

    private static func loop() {
        while true {
            guard let link = Account.link, link.taking else {
                sleep(5)
                continue
            }
            switch claim(link) {
            case .failed(let why):
                log("could not ask for work: \(why) - waiting \(backoff)s")
                sleep(backoff)
                backoff = min(60, backoff * 2)
            case .idle:
                backoff = 2
            case .job(let job):
                backoff = 2
                let done = carry(job)
                report(link, id: job.id, done: done)
            }
        }
    }

    /* ------------------------------------------------------------------ the wire */

    private static func request(_ url: URL, token: String, body: Data?) -> (Int, Data)? {
        var req = URLRequest(url: url)
        req.httpMethod = body == nil ? "GET" : "POST"
        req.setValue("Bearer " + token, forHTTPHeaderField: "Authorization")
        if body != nil { req.setValue("application/json", forHTTPHeaderField: "Content-Type") }
        req.httpBody = body
        /* Longer than the endpoint's own wait, so a long poll that answers at the last moment is an answer
         * rather than a timeout this end invented. */
        req.timeoutInterval = 90

        let done = DispatchSemaphore(value: 0)
        var out: (Int, Data)?
        URLSession.shared.dataTask(with: req) { data, response, _ in
            if let http = response as? HTTPURLResponse {
                out = (http.statusCode, data ?? Data())
            }
            done.signal()
        }.resume()
        _ = done.wait(timeout: .now() + 100)
        return out
    }

    private static func claim(_ link: Account.Link) -> Claimed {
        guard let url = URL(string: link.base + "/api/mcp?worker=claim") else {
            return .failed("the account address is not a URL")
        }
        /* `kind: agent` says what this claimer is. Nothing depends on it - the WORKER declares itself and
         * that is what the queue reads, because a worker updates with `git pull` and an agent is a compiled
         * binary somebody has to reinstall. Sent anyway: it is true, it costs a field, and it is what the
         * server would read if the decision were ever made the other way round. */
        let ask: [String: Any] = ["worker": Host.current().localizedName ?? "this Mac",
                                  "kind": "agent",
                                  "wait": claimWaitSeconds]
        guard let body = try? JSONSerialization.data(withJSONObject: ask),
              let (status, data) = request(url, token: link.token, body: body) else {
            return .failed("no answer from the account")
        }
        if status == 401 || status == 403 {
            /* The token was revoked, or the account is gone. Stopping is the honest response: retrying a
             * refused credential for ever is a log nobody reads and a request nobody wanted. */
            Account.setTaking(false)
            log("the account refused this Mac's token - taking work is now off. Pair again from the app.")
            return .idle
        }
        guard status == 200,
              let raw = (try? JSONSerialization.jsonObject(with: data)) as? [String: Any] else {
            return .failed("HTTP \(status)")
        }
        guard let job = raw["job"] as? [String: Any], let id = job["id"] as? String else { return .idle }
        let args = (job["args"] as? [String: Any]) ?? [:]
        return .job(Job(id: id,
                        command: job["command"] as? String,
                        body: job["body"] as? String,
                        activate: job["activate"] as? String,
                        moveMs: (args["moveMs"] as? Int) ?? 0))
    }

    private static func report(_ link: Account.Link, id: String, done: Done) {
        guard let url = URL(string: link.base + "/api/mcp?worker=report") else { return }
        var said: [String: Any] = ["id": id, "ok": done.ok, "said": done.said]
        if let body = done.body {
            said["body"] = body
            /* What this agent is, at the moment of the recording - the only moment the answer exists. The
             * row the deployment writes stamps it, exactly as the app's own does. */
            said["health"] = ["version": VERSION,
                              "canName": Permission.accessibility,
                              "canKeys": eventTap != nil]
        }
        guard let data = try? JSONSerialization.data(withJSONObject: said) else { return }
        if request(url, token: link.token, body: data) == nil {
            /* The work happened and the answer did not arrive. Said out loud, because the person on the
             * other end is being told nothing picked it up while something did. */
            log("the outcome of \(id) could not be reported")
        }
    }

    /* ------------------------------------------------------------------ doing it */

    struct Done {
        var ok: Bool
        var said: String
        /// A stopped recording, as the agent hands it over. The deployment turns it into a row.
        var body: String?
    }

    private static func carry(_ job: Job) -> Done {
        if job.command == "#record.start" {
            if eventTap == nil {
                return Done(ok: false, said: "This Mac has no input hook, so nothing would be captured - "
                    + "MouseFlow needs Accessibility in System Settings, Privacy & Security.", body: nil)
            }
            if Replayer.shared.isPlaying {
                return Done(ok: false, said: "It is replaying something right now.", body: nil)
            }
            if let refused = Recorder.shared.start(moveMs: job.moveMs) {
                return Done(ok: false, said: refused, body: nil)
            }
            DispatchQueue.global().async { Accessibility.prime() }
            return Done(ok: true, said: "Recording. It captures clicks, drags, scrolls and pointer "
                + "movement, and that a key was pressed - never which key.", body: nil)
        }

        if job.command == "#record.stop" {
            if !Recorder.shared.isRecording {
                return Done(ok: false, said: "Nothing was recording.", body: nil)
            }
            return Done(ok: true, said: "", body: Recorder.shared.stop())
        }

        if let body = job.body {
            /* A skill, as a replay body the deployment built. Everything that makes it a skill - the events,
             * the parameters, the tool definition - stayed there; what arrives here is the format this agent
             * has always spoken. */
            if let raise = job.activate {
                _ = doAction(raise)
                Thread.sleep(forTimeInterval: 0.35)
            }
            if let refused = Replayer.shared.start(body: body) {
                return Done(ok: false, said: refused, body: nil)
            }
            /* Waited out here rather than reported as started: an answer that arrives before the work has
             * happened has told the caller nothing. */
            let until = Date().addingTimeInterval(30 * 60)
            while Replayer.shared.isPlaying && Date() < until { Thread.sleep(forTimeInterval: 0.4) }
            if Replayer.shared.isPlaying {
                return Done(ok: false, said: "It was still replaying after thirty minutes.", body: nil)
            }
            return Done(ok: true, said: "Replayed it on this Mac. What the applications did with it is not "
                + "something MouseFlow can see; the actions were sent.", body: nil)
        }

        return Done(ok: false, said: "This Mac was asked to do something it does not understand. Its agent "
            + "may be older than the account expects.", body: nil)
    }
}

/* A LaunchAgent, which is the macOS answer to the Startup folder.
 *
 * Unlike the Windows agent this is always available: there the piped one-liner leaves no file for a launcher
 * to point at, and here there is always a binary on disk because there is no way to run this without
 * compiling it first. */
enum Autostart {
    static let label = "com.mouseflow.agent"

    static var plistPath: String {
        FileManager.default.homeDirectoryForCurrentUser
            .appendingPathComponent("Library/LaunchAgents/\(label).plist").path
    }

    static var enabled: Bool { FileManager.default.fileExists(atPath: plistPath) }

    /* Somewhere for the startup banner to go.
     *
     * Under launchd the agent's own output goes nowhere, and that banner is the one thing worth reading when
     * it will not work: it says whether the event tap installed and whether this process is even the kind
     * that can be granted anything. */
    static var logPath: String {
        FileManager.default.homeDirectoryForCurrentUser
            .appendingPathComponent("Library/Logs/mouseflow-agent.log").path
    }

    static var binary: String {
        let raw = CommandLine.arguments.first ?? ""
        if raw.hasPrefix("/") { return raw }
        return FileManager.default.currentDirectoryPath + "/" + raw
    }

    static func enable() -> String? {
        let plist = """
        <?xml version="1.0" encoding="UTF-8"?>
        <!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
        <plist version="1.0">
        <dict>
          <key>Label</key><string>\(label)</string>
          <key>ProgramArguments</key>
          <array>
            <string>\(binary)</string>
            <string>--port</string><string>\(port)</string>
            <string>--allow-origin</string><string>\(allowOrigin)</string>
          </array>
          <key>RunAtLoad</key><true/>
          <key>KeepAlive</key><true/>
          <key>ProcessType</key><string>Interactive</string>
          <key>StandardOutPath</key><string>\(logPath)</string>
          <key>StandardErrorPath</key><string>\(logPath)</string>
        </dict>
        </plist>
        """
        do {
            let dir = (plistPath as NSString).deletingLastPathComponent
            try FileManager.default.createDirectory(atPath: dir, withIntermediateDirectories: true)
            try plist.write(toFile: plistPath, atomically: true, encoding: .utf8)
        } catch {
            return "the launch agent could not be written: \(error.localizedDescription)"
        }
        /* Loaded now as well as written, so "it will start when you log in" is not the only thing that
         * became true - the same command run twice is not an error for launchctl.
         *
         * The same content the installer writes, deliberately: both write ONE file under one label, and
         * writing different things there means pressing "Enable autostart" quietly downgrades what the
         * installer set up - no KeepAlive, and nowhere for the banner to go. */
        let task = Process()
        task.executableURL = URL(fileURLWithPath: "/bin/launchctl")
        task.arguments = ["load", "-w", plistPath]
        try? task.run()
        task.waitUntilExit()
        return nil
    }

    /* What launchd says about our label: whether the job is loaded at all, and whether THIS process is it.
     * `open` parents to launchd too, so ppid answers nothing; launchctl naming our pid is the answer. The
     * pid is matched as a whole line - "pid = 123" must not match "pid = 12345". */
    static func launchdView() -> (loaded: Bool, ownsThisProcess: Bool) {
        let task = Process()
        task.executableURL = URL(fileURLWithPath: "/bin/launchctl")
        task.arguments = ["print", "gui/\(getuid())/\(label)"]
        let pipe = Pipe()
        task.standardOutput = pipe
        task.standardError = Pipe()
        do { try task.run() } catch { return (false, false) }
        /* Read to EOF before waiting, so a chatty launchctl can never fill the pipe and deadlock the wait. */
        let out = String(data: pipe.fileHandleForReading.readDataToEndOfFile(), encoding: .utf8) ?? ""
        task.waitUntilExit()
        guard task.terminationStatus == 0 else { return (false, false) }
        let owns = out.split(separator: "\n").contains {
            $0.trimmingCharacters(in: .whitespaces) == "pid = \(getpid())"
        }
        return (true, owns)
    }

    static func disable() -> String? {
        let task = Process()
        task.executableURL = URL(fileURLWithPath: "/bin/launchctl")
        task.arguments = ["unload", "-w", plistPath]
        try? task.run()
        task.waitUntilExit()
        try? FileManager.default.removeItem(atPath: plistPath)
        return nil
    }
}

// ================================================================ permission watch

/* Requests in flight, so the permission watcher never exits under one. `recording` alone cannot answer -
 * Recorder.stop clears it as its FIRST act and then spends up to 1.5 seconds serializing the transcript
 * into the response; an exit inside that window destroys the recording it is delivering. */
enum Busy {
    private static let gate = NSLock()
    private static var inFlight = 0
    static var count: Int { gate.lock(); defer { gate.unlock() }; return inFlight }
    static func enter() { gate.lock(); inFlight += 1; gate.unlock() }
    static func leave() { gate.lock(); inFlight -= 1; gate.unlock() }
}

/* A granted permission is not reliably usable until the process restarts, so the agent restarts itself.
 *
 * Measured on a real machine, and the two permissions behave differently: Screen Recording's verdict NEVER
 * refreshed in a running process (ten minutes, twice), while Accessibility's sometimes does - but even then
 * an event tap that failed to install while untrusted stays uninstalled, because nothing re-asks. macOS
 * knows all this: System Settings offers applications with windows a "Quit & Reopen" dialog when their
 * switch is flipped. An agent with no window gets nothing, and the user gets a checked switch that does not
 * work.
 *
 * So while a permission is missing, a fresh child of this binary (--probe) is asked every few seconds what
 * the settings say NOW - a fresh process reads the live answer. The moment the answer changes, this process
 * exits cleanly and launchd (KeepAlive) starts it again: granted, tap installed, /health green, and the
 * Connections screen ticks over without anybody pressing anything. The TCC store's mtime (readable even
 * though the store itself is not) is the backstop signal in case the probe cannot run. Three refusals keep
 * it honest: never mid-recording or mid-replay, at most once a minute (remembered on disk, because the
 * process doing the remembering is the one that exits), and only when this process IS the launchd job - a
 * --foreground run is told to restart by hand instead of silently dying. */
enum PermissionWatch {
    /* Accessibility and Screen Recording both land in the system store on current macOS; older versions
     * split them. Watching both costs two stats. */
    private static var tccStores: [String] {
        [
            "/Library/Application Support/com.apple.TCC/TCC.db",
            FileManager.default.homeDirectoryForCurrentUser.path
                + "/Library/Application Support/com.apple.TCC/TCC.db",
        ]
    }

    private static func storeStamps() -> [Date] {
        tccStores.compactMap {
            (try? FileManager.default.attributesOfItem(atPath: $0))?[.modificationDate] as? Date
        }
    }

    /* Whether launchd's job for our label is THIS process - the one kind of run exit(0) resurrects. */
    private static func launchdManaged() -> Bool { Autostart.launchdView().ownsThisProcess }

    /* What the settings say now, from a process young enough to know. nil when the probe could not run. */
    private static func probe() -> (accessibility: Bool, screenRecording: Bool)? {
        let task = Process()
        task.executableURL = URL(fileURLWithPath: Autostart.binary)
        task.arguments = ["--probe"]
        let pipe = Pipe()
        task.standardOutput = pipe
        task.standardError = Pipe()
        do { try task.run() } catch { return nil }
        /* Bounded, so a wedged child cannot wedge the watcher. */
        let deadline = Date(timeIntervalSinceNow: 5)
        while task.isRunning && Date() < deadline { usleep(50_000) }
        if task.isRunning { task.terminate(); return nil }
        let out = String(data: pipe.fileHandleForReading.readDataToEndOfFile(), encoding: .utf8) ?? ""
        guard out.contains("\"accessibility\":") else { return nil }
        return (out.contains("\"accessibility\":true"), out.contains("\"screenRecording\":true"))
    }

    /* The self-restart throttle, on disk because the process that remembers is the one that exits.
     *
     * Two speeds for two kinds of evidence. A probe-CONFIRMED grant can only happen once per permission, so
     * it restarts after 10 seconds - fast enough that flipping the second switch right after the first
     * still lands "within a few seconds", and still a brake if a pathological machine hands the fresh
     * process the stale answer too. The mtime signal fires for ANY application's TCC change, so it waits a
     * full minute. */
    private static func stampRestart(confirmed: Bool) -> Bool {
        let dir = FileManager.default.homeDirectoryForCurrentUser.path
            + "/Library/Application Support/MouseFlow"
        let path = dir + "/restart-stamp"
        let now = Date().timeIntervalSince1970
        if let text = try? String(contentsOfFile: path, encoding: .utf8),
           let last = Double(text.trimmingCharacters(in: .whitespacesAndNewlines)),
           now - last < (confirmed ? 10 : 60) {
            return false
        }
        /* The directory exists on any installed machine; a --foreground run from a checkout is the one that
         * needs it made - and a throttle that silently stops throttling is worse than a mkdir. */
        try? FileManager.default.createDirectory(atPath: dir, withIntermediateDirectories: true)
        try? "\(now)".write(toFile: path, atomically: true, encoding: .utf8)
        return true
    }

    static func start() {
        if Permission.accessibility && Permission.screenRecording { return }
        let thread = Thread {
            let managed = launchdManaged()
            var lastStamps = storeStamps()
            var toldToRestart = false
            print(managed
                ? "  watching       for the grant - the agent restarts itself to pick it up, nothing to press"
                : "  watching       for the grant - this run is not under launchd, so restart it by hand once granted")
            var ticksSinceProbe = 999
            while true {
                Thread.sleep(forTimeInterval: 3)

                /* Accessibility's verdict CAN refresh live in a running process (measured - unlike Screen
                 * Recording's, which never did), so when it has, the tap goes in NOW, not when the user
                 * happens to press Record. */
                if Permission.accessibility, eventTap == nil, installTap() {
                    print("  input tap      installed - Accessibility arrived")
                }
                /* Everything arrived AND is in use? Then there is nothing left to watch. The tap check is
                 * not decoration: granted-but-no-tap must keep the watcher alive, retrying the install. */
                if Permission.accessibility && Permission.screenRecording && eventTap != nil { return }

                /* The stat is the cheap tick; the probe is a process spawn, so it runs when the store
                 * CHANGED - the proven signal of a grant landing - and every tenth tick regardless, in case
                 * a store this build does not know about is the one that moved. A user who deliberately
                 * declines a permission is not billed a spawn every three seconds for the rest of the day. */
                let stamps = storeStamps()
                let storeChanged = stamps != lastStamps
                lastStamps = stamps
                ticksSinceProbe += 1
                var confirmed = false
                var probeAnswered = false
                if storeChanged || ticksSinceProbe >= 10 {
                    ticksSinceProbe = 0
                    if let fresh = probe() {
                        probeAnswered = true
                        confirmed = (fresh.accessibility && !Permission.accessibility)
                            || (fresh.screenRecording && !Permission.screenRecording)
                    }
                }
                /* The probe's answer is final: it read the live database. The mtime alone only counts when
                 * the probe could not run - any application's TCC change moves these files, and "someone,
                 * somewhere, was granted something" is not a reason to restart when a fresh process just
                 * said our own switches are still off. */
                let arrived = confirmed || (storeChanged && !probeAnswered)
                if !arrived { continue }

                if !managed {
                    if !toldToRestart {
                        toldToRestart = true
                        print("  permissions    changed in System Settings - restart the agent to pick them up")
                    }
                    continue
                }
                if !stampRestart(confirmed: confirmed) { continue }
                /* Not while anything is happening: a recording, a replay, or a response still being
                 * written. Recorder.stop clears `recording` FIRST and then spends up to 1.5s serializing -
                 * an exit inside that window destroys the recording it is delivering - so the in-flight
                 * request count is the guard that actually covers it. */
                if Recorder.shared.isRecording || Recorder.shared.busyEnding
                    || Replayer.shared.isPlaying || Busy.count > 0 { continue }
                print("  permissions    granted in System Settings - restarting to pick them up"
                    + " (launchd starts the agent again at once)")
                usleep(300_000)
                if Recorder.shared.isRecording || Recorder.shared.busyEnding
                    || Replayer.shared.isPlaying || Busy.count > 0 { continue }
                exit(0)
            }
        }
        thread.name = "MouseFlowPermissionWatch"
        thread.start()
    }
}

// ================================================================ HTTP

struct Response {
    var status = 200
    var contentType = "application/json"
    var body = ""
}

func respond(_ fd: Int32, _ res: Response) {
    let reason: String = {
        switch res.status {
        case 200: return "OK"
        case 204: return "No Content"
        case 400: return "Bad Request"
        case 404: return "Not Found"
        case 405: return "Method Not Allowed"
        case 409: return "Conflict"
        case 500: return "Internal Server Error"
        default: return "OK"
        }
    }()
    let bytes = Array(res.body.utf8)
    var head = "HTTP/1.1 \(res.status) \(reason)\r\n"
    head += "Content-Type: \(res.contentType); charset=utf-8\r\n"
    head += "Content-Length: \(bytes.count)\r\n"
    /* Echoed, never used to reject - the same as the Windows agent, and the same single seam the protocol
     * says to leave for the authentication design that is being chosen. */
    head += "Access-Control-Allow-Origin: \(allowOrigin)\r\n"
    head += "Access-Control-Allow-Methods: GET, POST, OPTIONS\r\n"
    head += "Access-Control-Allow-Headers: content-type\r\n"
    head += "Access-Control-Max-Age: 600\r\n"
    head += "Cache-Control: no-store\r\n"
    head += "Connection: close\r\n\r\n"

    var out = Array(head.utf8)
    out.append(contentsOf: bytes)
    out.withUnsafeBufferPointer { buffer in
        var sent = 0
        while sent < buffer.count {
            let n = write(fd, buffer.baseAddress! + sent, buffer.count - sent)
            if n <= 0 { break }
            sent += n
        }
    }
}

func readRequest(_ fd: Int32) -> (method: String, path: String, query: String, body: String)? {
    var raw = [UInt8]()
    var chunk = [UInt8](repeating: 0, count: 4096)
    var headerEnd: Int?

    // Headers first, then exactly Content-Length bytes of body.
    while headerEnd == nil {
        let n = recv(fd, &chunk, chunk.count, 0)
        if n <= 0 { return nil }
        raw.append(contentsOf: chunk[0..<n])
        if let found = find(raw, Array("\r\n\r\n".utf8)) { headerEnd = found + 4 }
        if raw.count > 1_000_000 { return nil }
    }
    guard let start = headerEnd,
          let head = String(bytes: raw[0..<start], encoding: .utf8) else { return nil }

    let lines = head.split(separator: "\r\n", omittingEmptySubsequences: true).map(String.init)
    guard let requestLine = lines.first else { return nil }
    let parts = requestLine.split(separator: " ").map(String.init)
    guard parts.count >= 2 else { return nil }

    let method = parts[0].uppercased()
    var path = parts[1]
    var query = ""
    /* The query travels beside the path, not inside it: every route compares the path exactly, and cutting
     * the query off without keeping it is how the Windows agent quietly ignored `?w=` for months. */
    if let mark = path.firstIndex(of: "?") {
        query = String(path[path.index(after: mark)...])
        path = String(path[path.startIndex..<mark])
    }

    var length = 0
    for line in lines.dropFirst() {
        let bits = line.split(separator: ":", maxSplits: 1).map { $0.trimmingCharacters(in: .whitespaces) }
        if bits.count == 2, bits[0].lowercased() == "content-length" { length = Int(bits[1]) ?? 0 }
    }

    var body = [UInt8](raw[start...])
    while body.count < length {
        let n = recv(fd, &chunk, chunk.count, 0)
        if n <= 0 { break }
        body.append(contentsOf: chunk[0..<n])
    }
    return (method, path, query, String(bytes: body.prefix(length), encoding: .utf8) ?? "")
}

func find(_ haystack: [UInt8], _ needle: [UInt8]) -> Int? {
    guard haystack.count >= needle.count else { return nil }
    for i in 0...(haystack.count - needle.count) {
        var hit = true
        for j in 0..<needle.count where haystack[i + j] != needle[j] { hit = false; break }
        if hit { return i }
    }
    return nil
}

// ================================================================ routes

func route(method: String, path: String, query: String, body: String) -> Response {
    if method == "OPTIONS" { return Response(status: 204, contentType: "text/plain", body: "") }

    switch path {
    case "/health":
        let screen = Desktop.rect
        let cursor = CGEvent(source: nil)?.location ?? .zero
        let status = Recorder.shared.status()
        var json = "{\"ok\":true,\"version\":\(jsonString(VERSION))"
        json += ",\"platform\":\"macos\""
        json += ",\"screen\":{\"x\":\(Int(screen.origin.x)),\"y\":\(Int(screen.origin.y))"
        json += ",\"w\":\(Int(screen.width)),\"h\":\(Int(screen.height))}"
        json += ",\"cursor\":{\"x\":\(Int(cursor.x)),\"y\":\(Int(cursor.y))}"
        json += ",\"hook\":\(jsonBool(eventTap != nil))"
        json += ",\"recording\":\(jsonBool(status.recording))"
        json += ",\"playing\":\(jsonBool(Replayer.shared.isPlaying))"
        json += ",\"autostart\":\(jsonBool(Autostart.enabled))"
        json += ",\"canAutostart\":true"
        json += ",\"originPinned\":\(jsonBool(allowOrigin != "*"))"
        /* Whether this Mac is attached to an account, and whether it is taking work from it. Two facts, not
         * one: attached and not taking is the normal resting state, and an app that showed them as one
         * would offer to pair a Mac that is already paired. */
        json += ",\"linked\":\(jsonBool(Account.link != nil))"
        json += ",\"taking\":\(jsonBool(Account.link?.taking == true))"
        /* The capability flags, and on this platform two of them are answers rather than constants. A
         * version number cannot say whether the user has granted Screen Recording, and an agent that claims
         * it can see returns a black picture instead of an explanation. */
        json += ",\"canSee\":\(jsonBool(Permission.screenRecording))"
        json += ",\"canWindows\":true"
        json += ",\"canName\":\(jsonBool(Permission.accessibility))"
        json += ",\"canKeys\":\(jsonBool(eventTap != nil))"
        json += ",\"canDrain\":true"
        /* Named separately from the flags, because the two switches are in different panes of System
         * Settings and "permissions missing" is not an instruction. */
        json += ",\"permissions\":{\"accessibility\":\(jsonBool(Permission.accessibility))"
        json += ",\"screenRecording\":\(jsonBool(Permission.screenRecording))}"
        json += "}"
        return Response(body: json)

    case "/record/start":
        if method != "POST" { return Response(status: 405, body: "{\"ok\":false,\"error\":\"POST\"}") }
        if eventTap == nil {
            /* Ask, and only then refuse. This is the moment the permission is for - somebody has just
             * pressed Record - and it may be the first moment anybody was watching: the agent starts at
             * login, so a dialog shown then went to an empty chair. */
            Permission.askForAccessibility()
            /* The tap may be installable now, if the answer came from a dialog that is already answered. */
            if installTap() {
                /* A recording ended at the agent is HELD, not gone - starting over it would destroy the one
                 * thing the menu bar promised to save. The refusal comes from start() itself, atomically. */
                if let refused = Recorder.shared.start(moveMs: queryInt(query, "moveMs", 0)) {
                    return Response(status: 409, body: "{\"ok\":false,\"error\":\(jsonString(refused))}")
                }
                DispatchQueue.global().async { Accessibility.prime() }
                return Response(body: "{\"ok\":true,\"moveMs\":\(Recorder.shared.status().moveMs)}")
            }
            /* Said as the thing to do, not as a state. Without Accessibility there is no tap, and a
             * recording started here would come back empty with no explanation. */
            return Response(status: 500, body: "{\"ok\":false,\"error\":"
                + jsonString("macOS is asking for Accessibility now - say yes, and press Record again. If no"
                    + " dialog appeared, switch on MouseFlow Agent in System Settings, Privacy & Security,"
                    + " Accessibility - the agent notices the grant within a few seconds and restarts itself,"
                    + " and Record works from then on") + "}")
        }
        if let refused = Recorder.shared.start(moveMs: queryInt(query, "moveMs", 0)) {
            return Response(status: 409, body: "{\"ok\":false,\"error\":\(jsonString(refused))}")
        }
        /* Off this thread: priming makes a synchronous call INTO the frontmost application, and a
         * beach-balling one would hold the reply past the client's deadline for this route. A head start is
         * still a head start when it lands a moment after the recording opens. */
        DispatchQueue.global().async { Accessibility.prime() }
        return Response(body: "{\"ok\":true,\"moveMs\":\(Recorder.shared.status().moveMs)}")

    case "/record/status":
        let s = Recorder.shared.status()
        return Response(body: "{\"recording\":\(jsonBool(s.recording)),\"count\":\(s.count)"
            + ",\"part\":\(s.part),\"moveMs\":\(s.moveMs),\"elapsedMs\":\(s.elapsedMs)}")

    case "/record/drain":
        if method != "POST" { return Response(status: 405, body: "{\"ok\":false,\"error\":\"POST\"}") }
        guard let chunk = Recorder.shared.drain() else {
            return Response(status: 409, body: "{\"ok\":false,\"error\":\"not recording\"}")
        }
        return Response(contentType: "text/plain", body: chunk)

    case "/record/stop":
        if method != "POST" { return Response(status: 405, body: "{\"ok\":false,\"error\":\"POST\"}") }
        return Response(contentType: "text/plain", body: Recorder.shared.stop())

    case "/replay":
        if method != "POST" { return Response(status: 405, body: "{\"ok\":false,\"error\":\"POST\"}") }
        if let bad = Replayer.shared.start(body: body) {
            return Response(status: 409, body: "{\"ok\":false,\"error\":\(jsonString(bad))}")
        }
        return Response(body: "{\"ok\":true}")

    case "/replay/status":
        return Response(body: Replayer.shared.statusJson())

    case "/replay/abort":
        Replayer.shared.requestAbort()
        return Response(body: "{\"ok\":true}")

    case "/shot":
        /* Deliberately not while replaying: a picture taken mid-replay shows a screen that is already
         * moving, and a decision made from it acts on something that has gone. */
        if Replayer.shared.isPlaying {
            return Response(status: 409, body: "{\"ok\":false,\"error\":\"busy replaying\"}")
        }
        /* Same reason as /record/start: this is the moment the permission is for, and it may be the first
         * moment anybody is looking. */
        Permission.askForScreen()
        return Response(body: Screen.shot(want: queryInt(query, "w", 1280)))

    case "/pulse":
        if Replayer.shared.isPlaying {
            return Response(status: 409, body: "{\"ok\":false,\"error\":\"busy replaying\"}")
        }
        return Response(body: Screen.pulse())

    case "/windows":
        let items = Windows.list().map { w in
            "{\"title\":\(jsonString(w.title)),\"process\":\(jsonString(w.process))"
                + ",\"active\":\(jsonBool(w.active)),\"minimized\":\(jsonBool(w.minimized))"
                + ",\"x\":\(w.x),\"y\":\(w.y),\"w\":\(w.w),\"h\":\(w.h)}"
        }
        return Response(body: "{\"ok\":true,\"windows\":[\(items.joined(separator: ","))]}")

    case "/do":
        if method != "POST" { return Response(status: 405, body: "{\"ok\":false,\"error\":\"POST\"}") }
        if Replayer.shared.isPlaying {
            return Response(status: 409, body: "{\"ok\":false,\"error\":\"busy replaying\"}")
        }
        if let bad = doAction(body) {
            return Response(status: 400, body: "{\"ok\":false,\"error\":\(jsonString(bad))}")
        }
        return Response(body: "{\"ok\":true}")

    /* Attaching this Mac to an account, and detaching it.
     *
     * Handed over across loopback by the app, which is signed in as the person - so nobody reads a token,
     * copies one, or keeps one anywhere. The same pairing the extension gets over its bridge, for the same
     * reason: a credential a person has to carry is a credential a person mislays. */
    case "/account":
        if method == "DELETE" {
            Account.forget()
            return Response(body: "{\"ok\":true,\"linked\":false}")
        }
        if method != "POST" { return Response(status: 405, body: "{\"ok\":false,\"error\":\"POST or DELETE\"}") }
        let fields = parseAction(body)
        guard let token = fields["token"], token.hasPrefix("mf_") else {
            return Response(status: 400, body: "{\"ok\":false,\"error\":"
                + jsonString("a MouseFlow device token, which starts with mf_") + "}")
        }
        let base = fields["base"] ?? "https://mouseflowapp.vercel.app"
        /* Taking work is the point of attaching, so it is on unless the caller says otherwise - and the menu
         * bar says so from the moment it is, which is where somebody would look to turn it off. */
        let taking = (fields["taking"] ?? "1") != "0"
        Account.set(token: token, base: base, taking: taking)
        return Response(body: "{\"ok\":true,\"linked\":true,\"taking\":\(jsonBool(taking))}")

    case "/autostart/enable":
        if method != "POST" { return Response(status: 405, body: "{\"ok\":false,\"error\":\"POST\"}") }
        if let bad = Autostart.enable() {
            return Response(status: 500, body: "{\"ok\":false,\"error\":\(jsonString(bad))}")
        }
        /* enable() just loaded a KeepAlive job whose plist names this very port. When THIS process is not
         * that job - it was opened by hand, or by the "Quit & Reopen" dialog - the job is already being
         * respawned into "port already in use" against our socket, forever. So once this response is out
         * the door and nothing is recording, replaying or in flight, the port is handed over: listener
         * closed, job kicked, exit - and launchd's process, with the installer's arguments, takes it from
         * here. Waiting for idle is unbounded on purpose: a crash-looping login item is noise, a killed
         * recording is loss. */
        if !Autostart.launchdView().ownsThisProcess {
            let thread = Thread {
                while Busy.count > 0 || Recorder.shared.isRecording || Replayer.shared.isPlaying {
                    usleep(250_000)
                }
                print("autostart enabled - handing the port to the login item")
                close(listener)
                let kick = Process()
                kick.executableURL = URL(fileURLWithPath: "/bin/launchctl")
                kick.arguments = ["kickstart", "gui/\(getuid())/\(Autostart.label)"]
                try? kick.run()
                kick.waitUntilExit()
                usleep(200_000)
                exit(0)
            }
            thread.name = "MouseFlowHandover"
            thread.start()
        }
        return Response(body: "{\"ok\":true}")

    case "/autostart/disable":
        if method != "POST" { return Response(status: 405, body: "{\"ok\":false,\"error\":\"POST\"}") }
        _ = Autostart.disable()
        return Response(body: "{\"ok\":true}")

    case "/":
        return Response(contentType: "text/plain", body: "MouseFlow agent \(VERSION) (macOS)\n")

    default:
        return Response(status: 404, body: "{\"ok\":false,\"error\":\"no such path\"}")
    }
}

// ================================================================ main

/* A double is handed back to the login item, not raced for the port.
 *
 * macOS itself creates the double: the "Quit & Reopen" button next to a permission switch relaunches the
 * bundle with `open` - NO ARGUMENTS, so no port pin and no origin pin - and that instance wins the port
 * while launchd's KeepAlive respawns the real job into "port already in use" over and over. Seen on a real
 * machine within a minute of the dialog. So an ARGUMENT-LESS instance that is not the launchd job, while
 * the job is loaded, starts the job and gets out of the way - same agent, same port, the arguments the
 * installer chose. The argument count is the signature of the pathology: every deliberate run - the
 * installer's --foreground exec, a hand-run --port 9999, the plist itself - passes arguments, and none of
 * those must be evicted; the Finder and `open` pass none. A --probe child never reaches this line, and a
 * machine with the login item unloaded (--no-login, or a bootout for debugging) is untouched.
 *
 * And never step aside to a corpse: the exit only happens once something is actually answering the port,
 * or this instance carries on and serves - a plist pointing at a deleted binary must not turn "double-click
 * the app to recover" into silence. */
if CommandLine.arguments.count == 1 {
    let launchdView = Autostart.launchdView()
    if launchdView.loaded, !launchdView.ownsThisProcess {
        print("the login item owns this agent - starting it and stepping aside")
        let handover = Process()
        handover.executableURL = URL(fileURLWithPath: "/bin/launchctl")
        handover.arguments = ["kickstart", "gui/\(getuid())/\(Autostart.label)"]
        try? handover.run()
        handover.waitUntilExit()
        var served = false
        for _ in 0..<20 {
            let probe = socket(AF_INET, SOCK_STREAM, 0)
            if probe >= 0 {
                var address = sockaddr_in()
                address.sin_len = UInt8(MemoryLayout<sockaddr_in>.size)
                address.sin_family = sa_family_t(AF_INET)
                address.sin_port = port.bigEndian
                address.sin_addr = in_addr(s_addr: in_addr_t(0x7F00_0001).bigEndian)
                let connected = withUnsafePointer(to: &address) { pointer in
                    pointer.withMemoryRebound(to: sockaddr.self, capacity: 1) { sockaddrPointer in
                        connect(probe, sockaddrPointer, socklen_t(MemoryLayout<sockaddr_in>.size))
                    }
                }
                close(probe)
                if connected == 0 { served = true; break }
            }
            usleep(100_000)
        }
        if served { exit(0) }
        print("the login item did not come up - carrying on in this process")
    }
}

/* Line-buffered, or the log stays empty forever.
 *
 * Swift's `print` block-buffers when its output is not a terminal, and this process never exits - so under
 * launchd the startup banner sat in a buffer that was never flushed. The banner is the one thing worth
 * reading when nothing works: it says whether the event tap installed and whether this process is even the
 * kind that can be granted anything. An empty log read as "it printed nothing", which was wrong. */
setvbuf(stdout, nil, _IOLBF, 0)
setvbuf(stderr, nil, _IOLBF, 0)

Permission.ask()
/* Touched BEFORE the tap exists, so Recorder.init's one disk read (the reloaded hold) happens now, on this
 * thread - the tap callback dereferences Recorder.shared on the first input event, and that is the one
 * path the resolver rules keep clear of I/O. */
_ = Recorder.shared.heldStatus
let tapped = installTap()

let listener = socket(AF_INET, SOCK_STREAM, 0)
if listener < 0 {
    FileHandle.standardError.write("cannot open a socket\n".data(using: .utf8)!)
    exit(1)
}
var yes: Int32 = 1
setsockopt(listener, SOL_SOCKET, SO_REUSEADDR, &yes, socklen_t(MemoryLayout<Int32>.size))

var address = sockaddr_in()
address.sin_len = UInt8(MemoryLayout<sockaddr_in>.size)
address.sin_family = sa_family_t(AF_INET)
address.sin_port = port.bigEndian
/* Loopback only, never 0.0.0.0. The protocol says so and it is the difference between a helper for this
 * machine and a remote control for anyone on the network. */
address.sin_addr = in_addr(s_addr: in_addr_t(0x7F00_0001).bigEndian)

let bound = withUnsafePointer(to: &address) { pointer in
    pointer.withMemoryRebound(to: sockaddr.self, capacity: 1) { sockaddrPointer in
        bind(listener, sockaddrPointer, socklen_t(MemoryLayout<sockaddr_in>.size))
    }
}
if bound < 0 {
    FileHandle.standardError.write(
        "port \(port) is already in use - another agent is probably running\n".data(using: .utf8)!)
    exit(1)
}
if listen(listener, 128) < 0 {
    FileHandle.standardError.write("cannot listen on \(port)\n".data(using: .utf8)!)
    exit(1)
}

/* Whether this process can hold a permission of its own at all.
 *
 * On macOS a bare executable is not its own subject: TCC blames the RESPONSIBLE process, which for something
 * launched from a terminal is the terminal. Inside an .app bundle, launched with `open`, it is itself - which
 * is why the installer builds one. Worth printing, because "Accessibility is missing" and "this process can
 * never be granted Accessibility" look identical from the outside and have different answers. */
let bundled = Bundle.main.bundleIdentifier != nil
let axLine = Permission.accessibility
    ? "granted - clicks, typing and control names work"
    : bundled
        ? "MISSING - switch on MouseFlow Agent in System Settings, then restart it"
        : "MISSING - and this is running as a loose binary, which cannot be granted it. Re-run the installer"
let screenLine = Permission.screenRecording
    ? "granted - screenshots and window titles work"
    : "MISSING - screenshots and window titles will be empty"
let tapLine = tapped ? "installed" : "NOT installed - grant Accessibility, then start it again"

print("""

  MouseFlow agent \(VERSION) (macOS)
  listening     http://127.0.0.1:\(port)
  origin        \(allowOrigin)
  move filter   \(moveThrottleMsDefault) ms / \(moveMinPx) px
  accessibility \(axLine)
  screen        \(screenLine)
  input tap     \(tapLine)

  Recording only happens between Start and Stop. Typed text is never captured - only that a key was
  pressed, and when. Ctrl+C to stop the agent.

""")

/* Started after the banner so its own lines land under it. Does nothing when both permissions are already
 * in place. */
PermissionWatch.start()

/* Whether this Mac is attached to an account, read from disk, and the loop that asks it for work.
 *
 * The loop is started unconditionally and does nothing until the switch is on: an agent that had to be
 * restarted to begin taking work would make the menu item a lie. Nothing leaves this machine while it is
 * off - not a poll, not a heartbeat. */
Account.load()
if let link = Account.link {
    print(link.taking
        ? "attached to an account and taking work from it - switch it off in the menu bar"
        : "attached to an account, not taking work - switch it on in the menu bar")
}
Courier.begin()

let queue = DispatchQueue(label: "mouseflow.http", attributes: .concurrent)
let acceptThread = Thread {
    while true {
        let client = accept(listener, nil, nil)
        if client < 0 { continue }
        queue.async {
            Busy.enter()
            defer { Busy.leave() }
            defer { close(client) }
            /* A deadline on the socket, because every endpoint has one on the client side and a half-open
             * connection holding a thread is worse than a refusal. */
            var timeout = timeval(tv_sec: 20, tv_usec: 0)
            setsockopt(client, SOL_SOCKET, SO_RCVTIMEO, &timeout, socklen_t(MemoryLayout<timeval>.size))
            setsockopt(client, SOL_SOCKET, SO_SNDTIMEO, &timeout, socklen_t(MemoryLayout<timeval>.size))

            guard let request = readRequest(client) else { return }
            let result = route(
                method: request.method, path: request.path, query: request.query, body: request.body
            )
            respond(client, result)
        }
    }
}
acceptThread.name = "MouseFlowHTTP"
acceptThread.start()

/* The main thread belongs to the menu bar from here on.
 *
 * The one thing users could not do was STOP the agent: it is a login item with no window, launchd's
 * KeepAlive resurrects a pkill, and closing the terminal that installed it never owned it. On Windows the
 * agent dies with its console window, so this is the macOS answer to the same need - a status item saying
 * the recorder exists, with the two honest ways out. LSUIElement was already true, which is exactly the
 * mode a menu-bar-only application runs in; nothing appears in the Dock. */
let app = NSApplication.shared
app.setActivationPolicy(.accessory)

final class MenuActions: NSObject, NSMenuDelegate {
    /* "Stop and Save Recording" exists only while there is one - shown when the menu opens, which is the
     * only moment visibility matters. */
    func menuNeedsUpdate(_ menu: NSMenu) {
        let recording = Recorder.shared.isRecording
        stopSaveItem?.isHidden = !recording
        let held = Recorder.shared.heldStatus
        /* Start shows when it would work: idle, nothing held, and Accessibility either granted already or
         * grantable by the tap install the action attempts. Not while a hold waits - starting would be
         * refused anyway, and the note right below says why. */
        startItem?.isHidden = recording || held.held || !Permission.accessibility
        heldNoteItem?.isHidden = !held.held
        if held.held {
            heldNoteItem?.title = "Recording saved here — the app collects it (\(held.events) events)"
        }
        stopSaveSeparator?.isHidden = !recording && !held.held && (startItem?.isHidden ?? true)

        /* Shown only once this Mac is attached to an account: an item that cannot do anything until
         * something else has happened elsewhere is a question, not a control. */
        let link = Account.link
        takingItem?.isHidden = link == nil
        takingItem?.state = link?.taking == true ? .on : .off
        takingNoteItem?.isHidden = link == nil
        /* Says which of the two states it is in, rather than what the switch would do - a tick can be read
         * either way at a glance, and this is the one item where reading it wrong matters. */
        takingNoteItem?.title = link?.taking == true
            ? "It asks your account for work — nothing reaches in"
            : "Off. Nothing leaves this Mac."
        takingSeparator?.isHidden = link == nil
    }

    /* Taking work from the account, switched here because here is where it is visible.
     *
     * The one thing this agent does that was not asked for by something on this machine. It is off until
     * somebody turns it on, it says so while it is on, and this is the switch - not a setting in a web page
     * on another screen, which is where a person would not think to look for it. */
    @objc func toggleTaking() {
        guard let link = Account.link else { return }
        Account.setTaking(!link.taking)
    }

    /* Stop the recording and hold it for the app: the agent has no account, the app's Record page does, and
     * it collects a held recording the moment it looks. The user never has to bring the browser forward.
     * Off the main thread: endFromAgent waits up to 1.5s for the resolver - which is still naming the very
     * clicks that operated this menu - and the menu bar must not freeze for it. The flag drops in the first
     * microseconds either way. */
    @objc func stopAndSave() {
        DispatchQueue.global().async { Recorder.shared.endFromAgent() }
    }

    /* Start a recording without the app, the mirror of stopping without it. The same start the route runs:
     * the tap goes in if it can, the held guard inside Recorder.start refuses atomically (the item is
     * hidden while a hold waits, but hidden is not a lock), and the frontmost application - the one the
     * person is about to work in - is asked for its tree with the same head start Record gets. Stopping
     * from the app OR from this menu both work afterwards; the app's page collects either way. */
    @objc func startRecording() {
        DispatchQueue.global().async {
            if eventTap == nil, !installTap() { return }
            if Recorder.shared.start(moveMs: 0) != nil { return }
            Accessibility.prime()
        }
    }

    /* Stops the agent until the next login: launchd forgets the job for this session (bootout), so
     * KeepAlive does not resurrect it, and RunAtLoad brings it back at sign-in. The exit is the fallback
     * for a run launchd does not manage, where dying IS stopping. */
    @objc func stopUntilLogin() {
        let task = Process()
        task.executableURL = URL(fileURLWithPath: "/bin/launchctl")
        task.arguments = ["bootout", "gui/\(getuid())/\(Autostart.label)"]
        try? task.run()
        task.waitUntilExit()
        exit(0)
    }

    /// Stops the agent AND takes it out of login items - off until reinstalled or re-enabled in the app.
    @objc func quitForGood() {
        _ = Autostart.disable()
        exit(0)
    }
}
let menuActions = MenuActions()

let statusItem = NSStatusBar.system.statusItem(withLength: NSStatusItem.squareLength)
if let button = statusItem.button {
    if let icon = NSImage(systemSymbolName: "cursorarrow.click.2",
                          accessibilityDescription: "MouseFlow Agent") {
        icon.isTemplate = true
        button.image = icon
    } else {
        button.title = "MF"
    }
}
let menu = NSMenu()
let header = NSMenuItem(title: "MouseFlow Agent \(VERSION)", action: nil, keyEquivalent: "")
header.isEnabled = false
menu.addItem(header)
let note = NSMenuItem(title: "Records only between Start and Stop", action: nil, keyEquivalent: "")
note.isEnabled = false
menu.addItem(note)
menu.addItem(.separator())
/* Visible only while recording - see menuNeedsUpdate. */
var stopSaveItem: NSMenuItem?
var stopSaveSeparator: NSMenuItem?
var startItem: NSMenuItem?
let startRec = NSMenuItem(title: "Start Recording",
                          action: #selector(MenuActions.startRecording), keyEquivalent: "")
startRec.target = menuActions
startRec.isHidden = true
menu.addItem(startRec)
startItem = startRec
let stopSave = NSMenuItem(title: "Stop and Save Recording",
                          action: #selector(MenuActions.stopAndSave), keyEquivalent: "")
stopSave.target = menuActions
stopSave.isHidden = true
menu.addItem(stopSave)
stopSaveItem = stopSave
/* Where a stopped recording IS, said in the menu, because "I pressed Save and nothing visible happened"
 * reads as loss. Disabled: it is a statement, not an action. */
var heldNoteItem: NSMenuItem?
let heldNote = NSMenuItem(title: "", action: nil, keyEquivalent: "")
heldNote.isEnabled = false
heldNote.isHidden = true
menu.addItem(heldNote)
heldNoteItem = heldNote
let stopSaveSep = NSMenuItem.separator()
stopSaveSep.isHidden = true
menu.addItem(stopSaveSep)
stopSaveSeparator = stopSaveSep
/* Visible only when this Mac is attached to an account - see menuNeedsUpdate. */
var takingItem: NSMenuItem?
var takingNoteItem: NSMenuItem?
var takingSeparator: NSMenuItem?
/* Named to be RECOGNISED, not to be accurate about the mechanism.
 *
 * "Take Work From My Account" describes exactly what the agent does and told a person nothing: they had
 * turned it on in the app, where it is called letting an AI drive this computer, and then met a different
 * sentence in the menu and asked what it was. Two names for one switch is two switches, as far as anybody
 * reading them is concerned. The note underneath carries the mechanism, the way the recorder's note does. */
let taking = NSMenuItem(title: "Let My AI Act On This Mac",
                        action: #selector(MenuActions.toggleTaking), keyEquivalent: "")
taking.target = menuActions
taking.isHidden = true
menu.addItem(taking)
takingItem = taking
let takingNote = NSMenuItem(title: "", action: nil, keyEquivalent: "")
takingNote.isEnabled = false
takingNote.isHidden = true
menu.addItem(takingNote)
takingNoteItem = takingNote
let takingSep = NSMenuItem.separator()
takingSep.isHidden = true
menu.addItem(takingSep)
takingSeparator = takingSep

let stopItem = NSMenuItem(title: "Stop Until Next Login",
                          action: #selector(MenuActions.stopUntilLogin), keyEquivalent: "")
stopItem.target = menuActions
menu.addItem(stopItem)
let quitItem = NSMenuItem(title: "Quit and Turn Off Start at Login",
                          action: #selector(MenuActions.quitForGood), keyEquivalent: "")
quitItem.target = menuActions
menu.addItem(quitItem)
menu.autoenablesItems = false
menu.delegate = menuActions
statusItem.menu = menu

/* The icon is also the recording light: the plain cursor when idle, a record mark while a recording runs.
 * Checked once a second on the main run loop - a person cannot flip states faster than they can see. */
let idleIcon = statusItem.button?.image
let liveIcon = NSImage(systemSymbolName: "record.circle",
                       accessibilityDescription: "MouseFlow Agent - recording")
liveIcon?.isTemplate = true
var iconShowsLive = false
Timer.scheduledTimer(withTimeInterval: 1.0, repeats: true) { _ in
    let recording = Recorder.shared.isRecording
    if recording != iconShowsLive {
        iconShowsLive = recording
        if let want = recording ? liveIcon : idleIcon { statusItem.button?.image = want }
    }
}

app.run()
