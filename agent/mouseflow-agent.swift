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

let VERSION = "0.27.0"

// ---------------------------------------------------------------- arguments

/* Same three the Windows agent takes, same defaults.
 *
 * `--allow-origin` IS USED TO REJECT, and until 0.9.7 it was not - it was echoed into a header and nothing
 * else, on both agents, with a comment saying the protocol was choosing an authentication design and a
 * second implementation must not invent one. That reading was wrong in a way that cost the whole machine:
 * a pin that is not enforced is not an unfinished feature, it is a listener on 127.0.0.1 that will take
 * `action=key key=space cmd=1`, `action=type text=Terminal`, `action=type text=curl … | sh` from ANY page
 * open in Safari or Firefox and press the keys. CORS never stopped that, because CORS stops a page READING
 * a reply, not the request being sent and carried out - and none of those need a reply.
 *
 * Enforcing the pin is not a new scheme. It is the scheme this agent already ships, already documents and
 * already reports on /health as `originPinned`; the only thing missing was the `if`.
 *
 * DEFAULT IS NOT "EVERYONE" ANY MORE. It used to be `*`, and a no-argument agent - which is what "Quit &
 * Reopen" starts - was therefore wide open. The default is now the product's own origins plus loopback for
 * development, so an agent nobody configured still talks to the app and still refuses evil.example.
 * `--allow-origin X` replaces the list; `--allow-origin '*'` restores the old behaviour for anyone who
 * needs it, and says so loudly in the banner. */
var port: UInt16 = 8787
/* Собственные origin'ы продукта: с них приходит приложение, и на них же указывает установщик. Два, потому
 * что развёртывания два, и агент, отказывающий второму, - это агент, который «просто не находится». */
let SHIPPED_ORIGINS = [
    "https://mouseflowapp.vercel.app",
    "https://mouse-agent.vercel.app",
]
var allowOrigin = ""
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
    /* Как ДЛИННО было то, что не записали. Едет ВМЕСТО имени, никогда рядом с ним - см. recordName. Ноль
     * значит, что отбрасывать было нечего. */
    var nameLength = 0
    var url: String?
    /* Модификаторы, зажатые в момент ЖЕСТА - только у нажатия кнопки и у прокрутки.
     *
     * Не у движения, и это не про размер файла. Тап отдаёт движения десятками в секунду; выборка
     * глобального состояния клавиатуры на каждом из них, пересечённая с потактовой лентой нажатий, которую
     * формат и так хранит, восстанавливает маску Shift и композиции для текста, который формат обещает не
     * хранить. Одна выборка на осознанный жест такой возможности не даёт.
     *
     * И не у отпускания: повтор держит модификатор от нажатия до его пары, так что второй записи не нужно.
     *
     * Сказано вслух и то, чего это НЕ ловит: модификатор, нажатый или отпущенный ПОСРЕДИ перетаскивания -
     * копирование в Finder, где сначала тянут, а потом дожимают Option, - не записывается. Поставить `mods`
     * на отпускание значило бы, что нажатие и отпускание одного жеста расходятся во мнении о нём, и каждому
     * читателю пришлось бы их мирить. */
    var mods: String?

    /* ГДЕ ЭТО БЫЛО, когда сказать ЧТО не получилось - подпись ближайшего элемента УПРАВЛЕНИЯ и сторона, с
     * которой от него оказалась точка. Только у шага без имени. Никогда не то, на что нажали: читатель,
     * увидевший имя в `control`, решит, что нажали по нему, - поэтому отдельные поля. */
    var near: String?
    var side: String?

    /* ГДЕ БЫЛО ОКНО И ГДЕ БЫЛ ЭЛЕМЕНТ - в тех же точках, в которых работает CGEvent, на момент клика.
     *
     * Точка на экране верна ровно до первого переезда окна: человек сдвинул окно на другой монитор,
     * развернул его, поменял разрешение - и «нажать в 1074,159» попадает в пустоту или в соседнюю кнопку.
     * Имея прямоугольник окна ТОГДА и его же СЕЙЧАС, повтор пересчитывает точку (api/_anchor.mjs).
     *
     * Оба читаются на той работе, которая и так идёт: окно - из того же списка CGWindowList, который уже
     * отвечает на «какое окно под точкой», элемент - из того же попадания, что дало имя. Второго обхода
     * дерева здесь нет и быть не может: это правило протокола.
     *
     * Optional, а не нули: окно в 0,0 существует, а «не измерено» - это другое. */
    var winRect: CGRect?
    var elRect: CGRect?
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

/* Keys that cannot spell anything, on any layout.
 *
 * The rule is that, and not "keys we happen to find useful": Return, Tab, Escape, the arrows and the page
 * keys produce no character anywhere, so naming them reveals nothing a password could hide in. Every other
 * key reaches the anonymous path.
 *
 * Codes are the system's own, from Carbon's Events.h (kVK_*), not from memory: Return 0x24, keypad Enter
 * 0x4C, Tab 0x30, Delete 0x33, Escape 0x35, Home 0x73, PageUp 0x74, ForwardDelete 0x75, End 0x77,
 * PageDown 0x79, and the arrows 0x7B-0x7E.
 *
 * OPTION IS NOT A COMMAND MODIFIER, deliberately. On many layouts ⌥ with a letter composes a character - ⌥e
 * is an accent - so treating it as a command would be a way of reading text. Command and Control only. */
let NAMED_KEYS: [Int64: String] = [
    0x24: "Enter", 0x4C: "Enter", 0x30: "Tab", 0x35: "Escape",
    0x33: "Backspace", 0x75: "Delete",
    0x7B: "Left", 0x7C: "Right", 0x7D: "Down", 0x7E: "Up",
    0x73: "Home", 0x77: "End", 0x74: "PageUp", 0x79: "PageDown",
]

/* МОДИФИКАТОРЫ КАК КЛАВИШИ, и порядок событий аккорда - отдельно от их отправки.
 *
 * Отдельно ровно затем, чтобы это можно было ВЫПОЛНИТЬ в тесте: правило про залипший Command проверяется
 * тем, что последний шаг несёт пустые флаги, а тест, который для этого нажимает клавиши на живой машине,
 * никто не станет держать в наборе.
 *
 * Порядок фиксирован (Command, Shift, Option, Control) и снимается в обратном, по одному флагу за раз -
 * так это выглядит с настоящей клавиатуры, и приложение, которое смотрит на flagsChanged, видит связную
 * последовательность. */
/* ФЛАГ ОДИН, А КЛАВИШ ДВЕ. У Command, Shift, Option и Control есть левая и правая, и флаг у них общий -
 * различить по состоянию нельзя. Отпуская только левую, мы отпускаем клавишу, которую человек не нажимал,
 * и НЕ отпускаем ту, которую он держит: у правого Shift флаг остаётся, а система получает лишний up.
 * Нажимаем левую (синтетическому аккорду сторона безразлична), отпускаем обе. */
let MODIFIER_KEYS: [(flag: CGEventFlags, left: CGKeyCode, right: CGKeyCode)] = [
    (.maskCommand, 55, 54), (.maskShift, 56, 60), (.maskAlternate, 58, 61), (.maskControl, 59, 62),
]

/// Что послать за один аккорд: нажать модификаторы, нажать клавишу, отпустить клавишу, отпустить
/// модификаторы. ПОСЛЕДНИЙ шаг обязан нести пустые флаги - без него Command остаётся зажатым для всей
/// машины, и следующий набор уходит аккордами. Измерено; см. Input.send.
func chordSteps(_ flags: CGEventFlags, key: CGKeyCode)
    -> [(code: CGKeyCode, down: Bool, flags: CGEventFlags)] {
    var out: [(code: CGKeyCode, down: Bool, flags: CGEventFlags)] = []
    for one in MODIFIER_KEYS where flags.contains(one.flag) {
        out.append((one.left, true, flags))
    }
    out.append((key, true, flags))
    out.append((key, false, flags))
    var still = flags
    for one in MODIFIER_KEYS.reversed() where flags.contains(one.flag) {
        still.remove(one.flag)
        /* Правая тоже, и до левой: отпускаем то, что нажимали, последним, а флаг снимаем один раз. */
        out.append((one.right, false, still))
        out.append((one.left, false, still))
    }
    return out
}

/// Отпускание того, что уже зажато, без нажатия чего-либо.
func releaseSteps(_ held: CGEventFlags) -> [(code: CGKeyCode, down: Bool, flags: CGEventFlags)] {
    var out: [(code: CGKeyCode, down: Bool, flags: CGEventFlags)] = []
    var still = held
    for one in MODIFIER_KEYS.reversed() where held.contains(one.flag) {
        still.remove(one.flag)
        out.append((one.right, false, still))
        out.append((one.left, false, still))
    }
    return out
}

/* The held modifiers, in a fixed order so the same chord always reads the same way. Shift is included for a
 * NAMED key - Shift+Tab goes backwards, which is a different instruction - and is never enough on its own
 * to make a character key readable. */
/* МОДИФИКАТОРЫ ЖЕСТА, теми же словами, что у аккорда клавиатуры, и без хвостового `+`.
 *
 * Порядок фиксирован, чтобы один и тот же жест всегда читался одинаково: разбор сравнивает токены, а не
 * множества. Пусто - значит ничего не держали, и тогда ключ на провод не уходит вовсе.
 *
 * ЧЕТЫРЕ МАСКИ И НИ ОДНОЙ БОЛЬШЕ. Ни caps lock, ни Fn: у ноутбучных стрелок стоит `.maskSecondaryFn`, и
 * стоит начать его читать, как каждое нажатие стрелки станет «Fn+Down». Фильтр через четыре маски - это же
 * и то, что не пускает сюда `.maskAlphaShift`. */
/* Токены `mods` во флаги - ОДНО место, и оно вынесено сюда именно потому, что теперь у него два
 * вызывающих: повтор записи и грамматика действий. Скопированная таблица разошлась бы, и разошлась бы
 * невидимо - одна из двух молча делала бы жест без модификатора.
 *
 * Незнакомый токен - данные, а не ошибка: так формат говорит про каждое своё значение (см. PROTOCOL.md), и
 * так другой агент может добавить новый, не ломая этого. */
func MouseFlowModFlags(_ mods: String?) -> CGEventFlags {
    guard let mods, !mods.isEmpty else { return [] }
    var out: CGEventFlags = []
    for token in mods.split(separator: "+") {
        switch token.trimmingCharacters(in: .whitespaces).lowercased() {
        case "cmd", "command", "win": out.insert(.maskCommand)
        case "shift": out.insert(.maskShift)
        case "alt", "option": out.insert(.maskAlternate)
        case "ctrl", "control": out.insert(.maskControl)
        default: break
        }
    }
    return out
}

func chordName(_ flags: CGEventFlags) -> String {
    var parts: [String] = []
    if flags.contains(.maskCommand) { parts.append("Cmd") }
    if flags.contains(.maskControl) { parts.append("Ctrl") }
    if flags.contains(.maskAlternate) { parts.append("Alt") }
    if flags.contains(.maskShift) { parts.append("Shift") }
    return parts.joined(separator: "+")
}

func chordPrefix(_ flags: CGEventFlags) -> String {
    var parts: [String] = []
    if flags.contains(.maskCommand) { parts.append("Cmd") }
    if flags.contains(.maskControl) { parts.append("Ctrl") }
    if flags.contains(.maskAlternate) { parts.append("Alt") }
    if flags.contains(.maskShift) { parts.append("Shift") }
    return parts.isEmpty ? "" : parts.joined(separator: "+") + "+"
}

/* The letter of a Command or Control chord, asked of the event itself rather than of a table.
 *
 * A hardcoded keycode-to-letter map is a US-layout assumption that is wrong on the first machine that is
 * not one. The event already knows what the key produces on THIS layout, so it is asked - and only ever
 * when a command modifier is held, which is the whole of the safety argument. */
func commandLetter(_ event: CGEvent) -> String? {
    var length = 0
    var chars = [UniChar](repeating: 0, count: 4)
    event.keyboardGetUnicodeString(maxStringLength: 4, actualStringLength: &length, unicodeString: &chars)
    guard length > 0, let scalar = Unicode.Scalar(chars[0]) else { return nil }
    let text = String(Character(scalar)).uppercased()
    /* Only a printable single character is a shortcut worth naming; a control code is what ⌃ produces and
     * says nothing a reader could use. */
    guard text.count == 1, text.rangeOfCharacter(from: .alphanumerics) != nil else { return nil }
    return text
}

/* Events posted by this agent carry a mark, so a replay is not recorded as a person working.
 *
 * The Windows agent reads LLMHF_INJECTED off the hook struct. macOS has no such flag for "somebody
 * synthesised this", so the agent stamps its own: every event it posts sets eventSourceUserData, and the tap
 * skips anything carrying it. That covers the case that matters - our own replay - and leaves another
 * application's synthetic input looking like input, which is the honest answer since it is indistinguishable.
 */
let INJECTED_MARK: Int64 = 0x4D4F5553_45464C4F  // "MOUSEFLO"

/* How often the front window's TITLE is asked for, and how long a new one must hold before it is believed.
 *
 * 400ms because the question costs an accessibility round trip and its answer changes a few times a
 * minute; 700ms because a page in flight shows two or three titles on the way to the one it settles on,
 * and marking each would put places in a recording that nobody visited. */
let TITLE_LOOK_MS = 400
let TITLE_SETTLE_MS = 700

final class Recorder {
    static let shared = Recorder()

    private let gate = NSLock()
    private let resolveGate = NSLock()

    private var buffer: [Ev] = []
    private var recording = false
    /* Где в буфере кончилась работа человека и началось НАШЕ меню - см. markOwnMenu и endFromAgent.
     * -1 значит «меню не открывали», и тогда не отрезается ничего. */
    private var ownMenuAt = -1
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
    /* The window title the last marker named, and a candidate waiting to prove it is real.
     *
     * A recording knew when the work moved to a different APPLICATION and never when the same one changed
     * what it was showing - so a browser navigating from one page to the next left no trace, and a
     * transcript could say which link was clicked but never where it led. */
    private var lastFrontTitle: String? = nil
    private var titleCandidate: String? = nil
    private var titleCandidateAt: Int = 0
    private var lastTitleLook: Int = 0

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
        /* НИ ОДИН МОДИФИКАТОР НЕ ЗАЖАТ, КОГДА ЗАПИСЬ НАЧИНАЕТСЯ - и это про обещание, а не про удобство.
         *
         * Обещание записи: клавиша, которая может что-то написать, никогда не называется. Держится оно на
         * том, что БУКВА читается только под Command или Control (см. tapCallback): аккорд - это команда
         * приложению, и пароль никто не набирает, держа Command.
         *
         * А теперь то, что это ломало. До 0.19.0 аккорд агента оставлял Command зажатым для ВСЕЙ машины -
         * измерено, `CGEventSource.flagsState` возвращал Cmd и не переставал. Прогон в десять утра оставлял
         * это состояние, запись в одиннадцать начиналась при зажатом Command, и тогда КАЖДОЕ нажатие
         * человека приходило с maskCommand - то есть читалось как аккорд, и буква НАЗЫВАЛАСЬ. Обещание
         * переставало быть правдой ровно там, где на него полагаются.
         *
         * Само залипание чинится в Input; здесь стоит второй замок, потому что залипнуть модификатор мог и
         * не от нас - от чужого приложения, от прошлой сборки этого агента, от зависшей физической клавиши.
         * Запись начинается с чистого состояния, чего бы это ни стоило одному нажатию. */
        Input.releaseModifiers()
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
        lastFrontTitle = nil
        titleCandidate = nil
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
    /* ГДЕ КОНЧАЕТСЯ ЗАПИСЬ И НАЧИНАЕТСЯ НАШЕ СОБСТВЕННОЕ МЕНЮ.
     *
     * Сообщено с прогона на Windows, и мера здесь та же, потому что механика та же: человек остановил
     * запись из меню агента, и клик по «Stop and Save Recording» попал В ЗАПИСЬ - а повтор в конце снова
     * открыл меню и снова нажал ту же кнопку, то есть начал новую запись. Запись не должна содержать то,
     * чем её остановили.
     *
     * Метка ставится, когда открывается НАШЕ меню (menuNeedsUpdate - единственный момент, когда это
     * известно), и указывает на последнее НАЖАТИЕ в буфере: то, которым меню и открыли. */
    func markOwnMenu() {
        gate.lock()
        defer { gate.unlock() }
        guard recording else { ownMenuAt = -1; return }
        var at = buffer.count
        /* Назад до последнего нажатия и недалеко: клик по строке меню - это конец буфера. */
        var i = buffer.count - 1
        while i >= 0, i >= buffer.count - 40 {
            if buffer[i].action.hasSuffix("Click Down") { at = i; break }
            i -= 1
        }
        ownMenuAt = at
    }

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
        var taken = buffer
        buffer = []
        /* ХВОСТ НАШЕГО МЕНЮ ОТРЕЗАН ЗДЕСЬ - до того, как посчитан признак «есть что отдать»: иначе запись
         * из одного клика по «Stop and Save» отдалась бы как запись с одним событием, и повтор нажал бы
         * Стоп ещё раз. Движения к строке меню уходят вместе с ним. */
        if ownMenuAt >= 0, ownMenuAt <= taken.count {
            taken = Array(taken.prefix(ownMenuAt))
            while let last = taken.last, last.action == "Mouse Movement" { taken.removeLast() }
        }
        ownMenuAt = -1
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
    func capture(action: String, x: Int, y: Int, mods: String = "") {
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
                /* Пусто - значит ничего не держали, и на провод ключ не уйдёт. Вызывающий передаёт их
                 * только у нажатия и у прокрутки - см. поле `mods` у Ev о том, почему не у движения. */
                if !mods.isEmpty { e.mods = mods }
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

    /* A key that COULD spell something was pressed, and when. Never which key.
     *
     * The guarantee is unchanged and it is still not negotiable: a tap that reads key codes has captured a
     * password whether or not it stores one, so no key capable of producing a character is ever identified.
     * Every letter, digit and punctuation mark comes here, including every Shift chord - a capital letter
     * is still a letter. This function is not given the event, so it cannot read one even by accident.
     *
     * What changed is the OTHER set. Keys that cannot spell anything on any layout - Return, Tab, Escape,
     * the arrows - and chords held with Command or Control, which are commands rather than text, are named
     * by captureNamedKey below. The reason is not convenience: without them a recording cannot know that
     * the work ended by pressing Send, so a skill made from it silently stops one step short of doing the
     * job, and the person finds out on a real machine. See NAMED_KEYS. */
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

    /* A key that carries no text, recorded BY NAME.
     *
     * Never coalesced, unlike a run of typing: two presses of Return are two things that happened, and
     * folding them into one would lose a step. Each one resolves the focused element, because "pressed
     * Enter" is only an instruction when it says where. */
    func captureNamedKey(_ name: String) {
        var pending: Ev?
        gate.lock()
        if recording {
            let now = elapsedMs
            let e = Ev()
            e.x = lastX
            e.y = lastY
            e.delayMs = buffer.isEmpty ? 0 : (now - lastStamp)
            e.action = "Key " + name
            buffer.append(e)
            lastStamp = now
            pending = e
        }
        gate.unlock()

        if let e = pending { enqueue(Pending(target: e, focused: true)) }
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
        if !live { lastFrontPid = pid; lastFrontTitle = nil; titleCandidate = nil; gate.unlock(); return }
        /* Never during a gesture. A click that gives a window focus fires this watcher while the button is
         * still down, and a marker inserted there turns one click into an unreleased press and a stray
         * release. lastFrontPid is deliberately NOT updated, so the change is noticed again next tick once
         * the button is up. */
        if gesture { gate.unlock(); return }
        /* THE TITLE IS READ ON A CLOCK, the application on every tick. This watcher runs on the resolver
         * thread every 15ms while it is idle, and frontWindowTitle() is an accessibility round trip - asking
         * sixty-six times a second would spend the recorder's budget on a question whose answer changes a
         * few times a minute. A foreground change stays immediate; only the title waits its turn. */
        let now = elapsedMs
        if same && now - lastTitleLook < TITLE_LOOK_MS { gate.unlock(); return }
        lastTitleLook = now
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
        if recording && held == 0 {
            let moved = pid != lastFrontPid
            let settled = clip(title ?? "", 120)
            /* A NEW TITLE HAS TO HOLD STILL BEFORE IT COUNTS.
             *
             * A page in flight is a sequence of titles - the old one, then the address, then "Loading", then
             * the real one - and marking each would fill a recording with places nobody visited. So a title
             * that differs from the last marked one becomes a candidate, and only becomes a marker once it
             * is still saying the same thing a moment later. A page that settles gets one marker; a page
             * that flickers gets none until it stops.
             *
             * An application change is NOT delayed this way: that one is a fact the moment it happens. */
            var titled = false
            if !moved && !settled.isEmpty && settled != (lastFrontTitle ?? "") {
                if titleCandidate == settled, elapsedMs - titleCandidateAt >= TITLE_SETTLE_MS {
                    titled = true
                } else if titleCandidate != settled {
                    titleCandidate = settled
                    titleCandidateAt = elapsedMs
                }
            } else if settled == (lastFrontTitle ?? "") {
                titleCandidate = nil
            }

            if moved || titled {
                let stamp = elapsedMs
                let e = Ev()
                e.x = lastX
                e.y = lastY
                e.delayMs = buffer.isEmpty ? 0 : (stamp - lastStamp)
                /* The same action for both, deliberately. Downstream a Focus opens a segment and emits no
                 * step of its own, which is exactly what a navigation wants - and every reader that exists,
                 * including older builds and imported files, already handles it. A new action value would
                 * have arrived at those readers as "not one of the actions this agent records". What
                 * widened is the meaning: the foreground WINDOW changed, whether because a different
                 * application came forward or because the same one changed what it is showing. */
                e.action = "Focus"
                e.app = appName.isEmpty ? nil : appName
                e.window = title
                buffer.append(e)
                lastStamp = stamp
                lastFrontPid = pid
                lastFrontTitle = settled.isEmpty ? nil : settled
                titleCandidate = nil
            }
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
            /* И `mods` держит строку живой. Иначе Cmd+прокрутка теряется целиком и молча: она не идёт на
             * разрешение имён вовсе, так что кроме модификатора у неё в контексте ничего и нет. Пропустить
             * это в guard'е - невидимая ошибка, теряющая ровно один из четырёх жестов. */
            if e.app != nil || e.window != nil || e.control != nil || e.controlType != nil
                || e.nameLength > 0 || e.mods != nil || e.near != nil
                || e.winRect != nil || e.elRect != nil {
                out += "#ctx"
                if let v = e.app { out += "\tapp=" + v }
                if let v = e.window { out += "\twindow=" + v }
                if let v = e.control { out += "\tcontrol=" + v }
                /* Никогда оба - см. recordName. Старый читатель видит шаг с типом и без имени, то есть то
                 * же, что он показал бы для безымянного элемента; новый читает это и может сказать,
                 * сколько текста там было. PROTOCOL.md: незнакомые ключи пропускаются. */
                else if e.nameLength > 0 { out += "\tnamelen=\(e.nameLength)" }
                if let v = e.controlType { out += "\ttype=" + v }
                /* Added after the four that were always here, and ignorable: the format says unknown keys
                 * are skipped rather than being an error, so an older reader loads this exactly as before. */
                if let v = e.role { out += "\trole=" + v }
                if let v = e.subrole { out += "\tsubrole=" + v }
                if let v = e.container { out += "\tin=" + v }
                if let v = e.containerName { out += "\tinName=" + v }
                if let v = e.url { out += "\turl=" + v }
                if let v = e.mods { out += "\tmods=" + v }
                /* После mods и в том же порядке, что на Windows: сторона перед именем. */
                if let v = e.side { out += "\tside=" + v }
                if let v = e.near { out += "\tnear=" + v }
                /* ЯКОРЬ - ПОСЛЕДНИМ, восемью числами, теми же ключами и в том же порядке, что на Windows.
                 * Незнакомые ключи PROTOCOL.md велит пропускать, поэтому старый читатель загружает запись
                 * ровно как прежде, а новый пересчитывает точку после переезда окна (api/_anchor.mjs). */
                if let r = e.winRect {
                    out += "\twx=\(Int(r.origin.x.rounded()))\twy=\(Int(r.origin.y.rounded()))"
                    out += "\tww=\(Int(r.size.width.rounded()))\twh=\(Int(r.size.height.rounded()))"
                }
                if let r = e.elRect {
                    out += "\tex=\(Int(r.origin.x.rounded()))\tey=\(Int(r.origin.y.rounded()))"
                    out += "\tew=\(Int(r.size.width.rounded()))\teh=\(Int(r.size.height.rounded()))"
                }
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
/* A hard ceiling on how much of a tree one search may look at.
 *
 * Depth alone cannot bound a search whose fan-out is unknown - five levels of sixty children is millions of
 * nodes, and this runs on the input path where seconds are not available. Counting visits bounds it whatever
 * shape the application turns out to have. */
final class Budget {
    private var left: Int
    init(_ nodes: Int = 400) { left = nodes }
    func spend() -> Bool {
        if left <= 0 { return false }
        left -= 1
        return true
    }
}

struct Named {
    var control: String?
    var type: String?
    var role: String?
    var subrole: String?
    var container: String?
    var containerName: String?
    /* The page a click landed on, when it landed on one. Origin and path only - see webURL below. */
    var url: String?
    /* Рамка ТОГО элемента, чьё имя записано, - не того, на который попала точка. По имени повтор потом
     * ищет именно названное, и мерить надо то же самое. Читается там же, где найдено имя. */
    var frame: CGRect?
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
    /* Разложено надвое, и вторая половина - не украшение. Имя МЕРЯЮТ, прежде чем решить, оставлять ли его
     * (см. recordName), а обрезанное до 120 имя длиной 376 символов сообщает о себе «120» - то есть ровно
     * то число, по которому нельзя понять, сколько текста там было. */
    static func flatten(_ raw: String) -> String? {
        let flat = raw.map { ch -> Character in
            if ch == "\t" || ch == "\n" || ch == "\r" { return " " }
            if ch == "|" { return "/" }
            return ch
        }
        let trimmed = String(flat).trimmingCharacters(in: .whitespacesAndNewlines)
        return trimmed.isEmpty ? nil : trimmed
    }

    static func ctxClean(_ raw: String, _ max: Int = 120) -> String? {
        guard let text = flatten(raw) else { return nil }
        return clip(text, max)
    }

    /* ПОДПИСЬ ИЛИ СОДЕРЖИМОЕ, И ОТЛИЧАЕТ ИХ ДЛИНА.
     *
     * Имя элемента-сообщения в дереве доступности И ЕСТЬ это сообщение, а тип их не различает: в Outlook
     * `option` бывает 275-376 символов, а `radio button` 174 - те же типы, что несут трёхсимвольные
     * подписи. Длина различает чисто: самое длинное имя на том, что человек НАЖИМАЕТ, - 43 символа
     * (combo box) и 41 (button) по трём приложениям; в Проводнике нет ничего выше 60. Всё, что длиннее,
     * в замере оказывалось содержимым - письмом, сообщением, строкой чата.
     *
     * Поэтому выше 60 имя не пишется, а пишется его ДЛИНА. Читателю этого хватает - «нажал на кусок текста
     * в 147 символов» ставит шаг на место, - а в записи не остаётся ничего, что нужно вычищать перед тем,
     * как ею поделиться.
     *
     * ЧЕГО ЭТО НЕ ЛОВИТ, сказано прямо, а не оставлено на обнаружение: КОРОТКОЕ имя, оказавшееся
     * содержимым. Пункт проверки орфографии «Spelling, сторят» несёт набранное слово в шестнадцати
     * символах, и никакое правило длины не отличит его от подписи. См. docs/product/19-limits-and-known-gaps.md.
     *
     * Ровно то же число и ровно тот же выбор, что у RecordName в Windows-агенте; читающая сторона
     * (nameOrLength в api/_transcript.js) применяет то же правило и к старым записям. */
    static let NAME_MAX = 60

    static func recordName(_ target: Ev, name: String?, type: String?) {
        target.controlType = (type?.isEmpty ?? true) ? nil : clip(type!, 40)
        guard let name, !name.isEmpty else { target.control = nil; return }
        if name.count > NAME_MAX {
            /* Никогда оба: у вырезанного имени нет `control=`, так что старый читатель видит шаг с типом и
             * без имени - то есть ровно то, что он показал бы для безымянного элемента, и это безопасно. */
            target.control = nil
            target.nameLength = name.count
            return
        }
        target.control = clip(name, 120)
    }

    private static func stringAttr(_ element: AXUIElement, _ attribute: String) -> String? {
        guard let raw = copyAttr(element, attribute) as? String else { return nil }
        return ctxClean(raw)
    }

    /// The same read, at FULL LENGTH, for the attributes a name may come out of. recordName is what decides
    /// whether such a value is kept at all, and it decides by measuring - so the measurement has to happen
    /// before anything shortens it.
    private static func nameAttr(_ element: AXUIElement, _ attribute: String) -> String? {
        guard let raw = copyAttr(element, attribute) as? String else { return nil }
        return flatten(raw)
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

    /* ЗНАЧЕНИЕ ЭЛЕМЕНТА - ЭТО ИМЯ ТОЛЬКО У ТОГО, ЧТО НАЗЫВАЕТ СЕБЯ ЗНАЧЕНИЕМ.
     *
     * У поля ввода значение - это то, что в него набрали. Агент печатает на экране записи, что нажатия не
     * записываются, и это правда про клавиатуру: обработчик читает только коды клавиш. Но имя элемента
     * бралось из kAXValue, а у текстового поля kAXValue И ЕСТЬ его содержимое - так что набранное попадало
     * в запись через другую дверь. Проверено на настоящих записях: 14 имён из 108 длиннее сорока символов,
     * и среди них дословно фраза, набранная в поиске Google, лежащая там трижды.
     *
     * Обещание, которое неверно наполовину, хуже отсутствующего: его читают как «моего текста здесь нет».
     *
     * Спрашивается не список ролей, а САМО СВОЙСТВО: можно ли в это значение писать. Поле ввода отвечает
     * да, статический текст - нет, и это не зависит ни от языка, ни от того, какие роли придумает
     * следующая версия macOS. Роли всё же проверяются тоже - как второй замок на том, что дороже всего
     * стоит перепутать. */
    private static let TYPED_ROLES: Set<String> = [
        "AXTextField", "AXTextArea", "AXComboBox", "AXSearchField",
    ]

    /* ПОЛЕ ПАРОЛЯ - ОТДЕЛЬНЫЙ ЗАМОК, а не ветка другого правила, и стоит он на КАЖДОМ пути.
     *
     * Ниже правило про набранный текст расходится надвое: запись его не берёт никогда, а чтение окна берёт,
     * потому что модели это нужно и снимок ей это и так показывает. Пароль не расходится: он не читается ни
     * там, ни там. Вынесено в собственную функцию именно поэтому - правило, живущее внутри другого правила,
     * теряется вместе с ним, когда то правило меняют. Его и меняют прямо сейчас. */
    private static func isSecure(_ element: AXUIElement) -> Bool {
        if let sub = stringAttr(element, kAXSubroleAttribute), sub == "AXSecureTextField" { return true }
        return false
    }

    private static func holdsTypedText(_ element: AXUIElement) -> Bool {
        if isSecure(element) { return true }
        if let role = stringAttr(element, kAXRoleAttribute), TYPED_ROLES.contains(role) { return true }
        var settable: DarwinBoolean = false
        if AXUIElementIsAttributeSettable(element, kAXValueAttribute as CFString, &settable) == .success,
           settable.boolValue {
            return true
        }
        return false
    }

    /* @param valueMayName можно ли вообще смотреть на kAXValue. describeFocused передаёт false: у элемента,
     *   в котором стоит каретка, значение - это набранное по определению, и никакой проверки роли тут не
     *   нужно, потому что вопрос уже решён тем, ЧТО это за элемент. */
    private static func nameByClimbing(_ start: AXUIElement, valueMayName: Bool = true) -> Named {
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
            if let name = nameAttr(current, kAXTitleAttribute) { out.control = name; out.type = type; out.frame = frameOf(current); return out }
            /* The label is its own element for a form field: AXTitleUIElement points at the static text
             * that names it, the way <label for> names an input, and the text of a static text lives in its
             * value.
             *
             * ЭТО ЧУЖОЕ значение, и потому остаётся: читается подпись «Кому», а не то, что набрали в поле
             * под ней. Именно этот путь и делает запрет ниже терпимым - поля с подписью имя сохраняют. */
            if let label = elementAttr(current, kAXTitleUIElementAttribute),
               let name = nameAttr(label, kAXValueAttribute) ?? nameAttr(label, kAXTitleAttribute) {
                out.control = name; out.type = type; out.frame = frameOf(current); return out
            }
            /* Description and value, in that order, because a great many controls carry no title: an icon
             * button has kAXDescription - and in Chromium every aria-label lands there - a text field has
             * kAXValue and nothing else. Value only on the element itself, never a parent's: a parent's
             * value is the document. */
            if let name = nameAttr(current, kAXDescriptionAttribute) { out.control = name; out.type = type; out.frame = frameOf(current); return out }
            if depth == 0, valueMayName, !holdsTypedText(current),
               let name = nameAttr(current, kAXValueAttribute) {
                out.control = name; out.type = type; out.frame = frameOf(current); return out
            }
            /* Help is the tooltip. Last, because it describes rather than names - but a toolbar button that
             * names itself nowhere else usually says exactly the right thing here. */
            if let name = nameAttr(current, kAXHelpAttribute) { out.control = name; out.type = type; out.frame = frameOf(current); return out }
            element = elementAttr(current, kAXParentAttribute)
            depth += 1
        }
        /* Nothing named itself. The kind of thing that was hit still travels: "clicked a button" beats
         * "clicked", and the Windows agent has always reported type without name. */
        out.type = hitType
        return out
    }

    /* ЗАГОЛОВОК, КОТОРЫЙ ЯВЛЯЕТСЯ АДРЕСОМ, ТЕРЯЕТ СТРОКУ ЗАПРОСА - и это та же самая обрезка, что у
     * webURL двумя экранами выше, только источник другой.
     *
     * У страницы без <title> заголовком окна становится её адрес, и страница-редирект входа - ровно такая.
     * Из настоящей записи: `auth.doubleword.ai/u/login?state=hKFo2SAw…`, где `state` - одноразовый токен
     * входа. Он уходил в запись, на аккаунт, в каждый экспорт и мимо каждого читателя - в то время как в
     * этом же файле webURL режет query у поля `url` ровно на том основании, что «строка запроса - это
     * место, где живут сессионный токен, одноразовая ссылка и то, что человек набрал в поиске». Правило
     * было верным, а заголовок обходил его стороной.
     *
     * ТОЛЬКО когда заголовок ЦЕЛИКОМ разбирается как http- или https-адрес. Заголовок, который просто
     * СОДЕРЖИТ вопросительный знак, - это предложение, и резать предложения по пунктуации значило бы
     * испортить «What is a good name? - Google Search» и все остальные обычные окна. */
    static func bareTitle(_ title: String) -> String? {
        let said = title.trimmingCharacters(in: .whitespacesAndNewlines)
        if !said.contains("?") { return nil }        // резать нечего; обычный случай, и он дешёвый
        if said.contains(" ") { return nil }         // предложение, а не адрес
        /* Chrome показывает адрес без схемы, а разбор её требует. Подстановка https - это догадка о схеме,
         * и она ни на что не влияет: наружу идут только authority и путь. */
        let probe = said.contains("://") ? said : "https://" + said
        guard let parts = URLComponents(string: probe) else { return nil }
        guard let scheme = parts.scheme?.lowercased(), scheme == "http" || scheme == "https" else { return nil }
        guard let host = parts.host, host.contains(".") else { return nil }
        let path = parts.path == "/" ? "" : parts.path
        let port = parts.port.map { ":\($0)" } ?? ""
        /* Схема возвращается только если она была: дописать её значило бы изменить то, что транскрипт
         * показывает для каждой обычной страницы. */
        let hadScheme = said.lowercased().hasPrefix("http")
        return (hadScheme ? "\(scheme)://\(host)\(port)" : "\(host)\(port)") + path
    }

    /// A window's title, cut and only then shortened - the cut has to see the whole address, or a title
    /// clipped mid-query would be measured and trimmed as if the tail were part of the path.
    private static func titleOf(_ window: AXUIElement) -> String? {
        guard let raw = copyAttr(window, kAXTitleAttribute as String) as? String,
              let flat = flatten(raw) else { return nil }
        return clip(bareTitle(flat) ?? flat, 120)
    }

    /// The window title of the frontmost window of a process.
    static func frontWindowTitle(pid: pid_t) -> String? {
        guard Permission.accessibility, pid > 0 else { return nil }
        let app = AXUIElementCreateApplication(pid)
        if let window = elementAttr(app, kAXFocusedWindowAttribute),
           let title = titleOf(window) {
            return title
        }
        if let window = elementAttr(app, kAXMainWindowAttribute) {
            return titleOf(window)
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

    /* Рамка элемента - те же две пары атрибутов, что читает centreOf, только целиком.
     *
     * Нужна записи: по ней повтор знает, где элемент БЫЛ, и насколько точка отстояла от его центра. Ноль по
     * ширине или высоте - это не рамка, а «не измерено»: у скрытого элемента бывает и такое. */
    static func frameOf(_ element: AXUIElement) -> CGRect? {
        guard let origin = pointAttr(element, kAXPositionAttribute),
              let size = sizeAttr(element, kAXSizeAttribute),
              size.width > 0, size.height > 0 else { return nil }
        return CGRect(origin: origin, size: size)
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
    /* EVERY child that contains the point, smallest first - not just the smallest one.
     *
     * Chrome's tab strip is why this is a list. TabStrip has two children with the IDENTICAL rectangle:
     * TabContainerImpl, which holds the tabs, and TabStrip::TabDragContextImpl, which holds nothing at all.
     * Choosing between them by area is a coin toss, and the losing side is a dead end - which is how a click
     * on a browser tab came back as "clicked on something Google Chrome did not name" while a click inside
     * the page it opened named itself perfectly well. Read off Chrome's own native tree at
     * chrome://accessibility, and confirmed from the outside: aiming at a tab by name could not find it.
     */
    private static func childrenAt(_ element: AXUIElement, x: Double, y: Double) -> [AXUIElement] {
        var hits: [(element: AXUIElement, area: Double)] = []
        for child in childrenOf(element).prefix(60) {
            if let hidden = copyAttr(child, kAXHiddenAttribute) as? Bool, hidden { continue }
            guard let origin = pointAttr(child, kAXPositionAttribute),
                  let size = sizeAttr(child, kAXSizeAttribute),
                  size.width > 1, size.height > 1 else { continue }
            guard x >= origin.x, x <= origin.x + size.width,
                  y >= origin.y, y <= origin.y + size.height else { continue }
            hits.append((child, Double(size.width) * Double(size.height)))
        }
        return hits.sorted { $0.area < $1.area }.map { $0.element }
    }

    /* The first named thing UNDER a point.
     *
     * Depth four, not two. A Chrome tab sits three levels below the strip's region view
     * - TabStripRegionView, TabStrip, TabContainerImpl, Tab - so a two-step descent stopped one short of
     * the only element in that chain carrying a name, every time.
     *
     * Bounded on purpose, and the bounds are the point: this runs while somebody is working, and walking an
     * application's whole tree costs seconds. Four levels, the three smallest candidates at each, first
     * name wins.
     */
    private static func namedUnder(_ element: AXUIElement, x: Double, y: Double, depth: Int = 0) -> Named? {
        guard depth < 4 else { return nil }
        for child in childrenAt(element, x: x, y: y).prefix(3) {
            let read = nameByClimbing(child)
            if read.control != nil { return read }
            if let deeper = namedUnder(child, x: x, y: y, depth: depth + 1) { return deeper }
        }
        return nil
    }

    /* Descend from the hit element; if that dead-ends, step OUT one level and descend again, twice.
     *
     * The dead end is the whole bug, and it is not hypothetical. In Chrome the hit test inside a tab strip
     * lands on TabStrip::TabDragContextImpl - a node covering the tabs exactly, with NO children at all -
     * so descending from it finds nothing at any depth. The tab container is its sibling and the tab is one
     * step below that. Taken from Chrome's own native tree at chrome://accessibility and replayed over that
     * tree: from the drag context, descending alone finds nothing and climbing one level finds the tab.
     */
    private static func namedAround(_ hit: AXUIElement, x: Double, y: Double) -> Named? {
        var node: AXUIElement? = hit
        for _ in 0..<3 {
            guard let here = node else { break }
            if let found = namedUnder(here, x: x, y: y) { return found }
            node = elementAttr(here, kAXParentAttribute)
        }
        return nil
    }

    /* One element under a point, for callers that want a place rather than a name. */
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

        /* Siblings were not enough, and a browser tab is the case that proves it.
         *
         * The hit test inside a tab strip lands on TabStrip's drag-context child, whose siblings are the
         * drag context and the tab CONTAINER - the tabs themselves are one level further down, so a
         * sibling-only scan could never see them. That is not a small gap: aiming by name exists precisely
         * because a tab strip re-lays out when the number of tabs changes, so the ONE case this was written
         * for was the one case it silently declined - and a replay went on clicking a coordinate that now
         * belongs to a different tab, reporting success.
         *
         * Bounded the same way as the naming descent, and only reached when the cheap answer failed. */
        return namedDeep(parent, matching: name, kind: kind)
    }

    /* An element with this name anywhere in a bounded part of the subtree, and where its centre is.
     *
     * Depth three from the hit element's parent, sixty children a level, first match wins. Deliberately not
     * a full walk: this runs on the input path, where seconds are not available. */
    private static func namedDeep(_ element: AXUIElement, matching name: String, kind: String?,
                                  depth: Int = 0, budget: Budget = Budget()) -> CGPoint? {
        guard depth < 5, budget.spend() else { return nil }
        for child in childrenOf(element).prefix(60) {
            if let title = nameOf(child), sameName(title, name) {
                let kindAgrees: Bool = {
                    guard let wanted = kind, !wanted.isEmpty,
                          let role = stringAttr(child, kAXRoleDescriptionAttribute) else { return true }
                    return sameName(role, wanted)
                }()
                if kindAgrees, let centre = centreOf(child), Desktop.contains(x: centre.x, y: centre.y) {
                    return centre
                }
            }
            if let found = namedDeep(child, matching: name, kind: kind, depth: depth + 1, budget: budget) {
                return found
            }
        }
        return nil
    }

    /* The window under a point, from the window server - the fallback when the accessibility hit test gives
     * nothing. Front to back, ordinary windows only (layer 0 - the menu bar, the Dock and overlays live on
     * other layers), first one whose bounds contain the point. The owner's name never needs a permission;
     * the title needs Screen Recording and is honestly absent without it. */
    /* Прямоугольник окна отдаётся ЗАОДНО: он уже прочитан этим же перебором (kCGWindowBounds), и второй
     * проход за ним был бы вторым списком окон ради тех же четырёх чисел. */
    static func windowAt(x: Double, y: Double) -> (app: String?, title: String?, rect: CGRect?)? {
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
            /* Через ту же обрезку: этот путь наполняет `window=` в записи ровно так же, как frontWindowTitle,
             * и адрес с токеном не должен зависеть от того, ответило ли дерево доступности. */
            let title = (info[kCGWindowName as String] as? String)
                .flatMap { flatten($0) }
                .map { clip(bareTitle($0) ?? $0, 120) }
            let rect = CGRect(x: wx, y: wy, width: ww, height: wh)
            if app == nil && title == nil { return (nil, nil, rect) }
            return (app, title, rect)
        }
        return nil
    }

    // ---------------------------------------------------------------- reading a window by name

    /* ПРАВИЛО, КОТОРОЕ ЭТО ГНЁТ, И ПОЧЕМУ ЗДЕСЬ МОЖНО.
     *
     * PROTOCOL.md запрещает обходить дерево окна: на пути ВВОДА это стоит секунды, и потому запись
     * прицеливается хит-тестом и подъёмом за именем. Здесь путь другой: `read` и `find` зовёт МОДЕЛЬ,
     * между ходами, вместо того чтобы читать координаты с уменьшенного скриншота, - и ход модели стоит
     * восемь-пятьдесят секунд. Обход в две с половиной секунды на этом фоне не стоит ничего, а промах
     * мимо кнопки стоит целого хода.
     *
     * Ограничен тремя способами сразу, и каждый закрывает свою форму провала: узлы - на неизвестную
     * ветвистость (пять уровней по шестьдесят детей - это миллионы), глубина - на дерево-цепочку,
     * секунды - на приложение, которое отвечает медленно. Плюс AXUIElementSetMessagingTimeout: приложение
     * может замолчать совсем, и на Windows это стоило отдельной механики с глушением по хэндлу.
     */
    struct Seen {
        var name: String
        var kind: String
        var frame: CGRect
        var enabled: Bool
        /* Что В ПОЛЕ, когда это поле ввода - см. readableValue. Отсутствует у всего остального, и отсутствует
         * у поля пароля тоже. */
        var value: String?
        /* И ОТДЕЛЬНО - что это поле пароля. Пустое поле и поле пароля иначе выглядят в ответе ОДИНАКОВО
         * (ни там, ни там значения нет), и модель, прочитавшая «поле без содержимого», начнёт в него
         * печатать. Сказать «пароль, не читаю» - это не утечка, а снятие двусмысленности. */
        var secret = false
    }

    /// Какое окно читать - и предложение, объясняющее, почему никакое.
    enum Target {
        case found(AXUIElement, String)
        case none(String)
    }

    static func windowToRead(title: String, process: String) -> Target {
        guard Permission.accessibility else {
            return .none("macOS has not granted Accessibility to MouseFlow Agent, so it cannot read a "
                + "window - switch it on in System Settings, Privacy & Security, Accessibility")
        }
        let asked = !title.isEmpty || !process.isEmpty
        let info = asked ? Windows.matching(title: title, process: process) : Windows.front()
        guard let info else {
            return .none(asked
                ? "no open window matches " + (title.isEmpty ? "process \(process)" : "title \"\(title)\"")
                    + " - the list of open windows under the screenshot is what is actually there"
                : "nothing is in front to read")
        }

        /* Chromium builds its accessibility tree LAZILY and only once it detects an assistive technology, so
         * the FIRST read of such an application returns the window and nothing inside it. Measured here on a
         * real Mac: `read` of a Chrome window came back with two entries, both the size of the window.
         * describe() has always handled this with a look-back; this path had no such thing and would have
         * reported "that window names nothing readable" for every browser, once, convincingly.
         *
         * Only on the first ask for a given application in the life of this process, so it costs nothing
         * afterwards - and the wait is here rather than in each caller, so `read` and `find` cannot disagree
         * about whether the tree was ready. */
        if awaken(pid: info.pid) { Thread.sleep(forTimeInterval: 0.4) }
        let app = AXUIElementCreateApplication(info.pid)
        /* Приложение может замолчать - на Windows это измерено: dbForge описал себя за 187 мс в один час и
         * не ответил вовсе в следующий, с любого потока. Здесь на это есть системный предел, и он ставится
         * на элемент приложения, а не на общесистемный. */
        AXUIElementSetMessagingTimeout(app, 4.0)

        var chosen: AXUIElement?
        let windows = copyAttr(app, kAXWindowsAttribute as String) as? [AXUIElement] ?? []
        if !title.isEmpty {
            let want = title.lowercased()
            chosen = windows.first { (stringAttr($0, kAXTitleAttribute) ?? "").lowercased().contains(want) }
        }
        if chosen == nil {
            chosen = elementAttr(app, kAXFocusedWindowAttribute)
                ?? elementAttr(app, kAXMainWindowAttribute)
                ?? windows.first
        }
        guard let window = chosen else {
            return .none("\"\(info.title)\" is open but does not expose a window to read - normal for a "
                + "window running under another user, or one drawn entirely on a canvas. The screenshot is "
                + "what there is")
        }
        return .found(window, info.title)
    }

    /* ПОДПИСЬ ЭЛЕМЕНТА - только подпись, никогда содержимое. Тот же порядок источников, что у записи. */
    private static func readableName(_ element: AXUIElement) -> String? {
        if let name = nameAttr(element, kAXTitleAttribute) { return name }
        if let label = elementAttr(element, kAXTitleUIElementAttribute),
           let name = nameAttr(label, kAXValueAttribute) ?? nameAttr(label, kAXTitleAttribute) {
            return name
        }
        if let name = nameAttr(element, kAXDescriptionAttribute) { return name }
        if !holdsTypedText(element), let name = nameAttr(element, kAXValueAttribute) { return name }
        return nameAttr(element, kAXHelpAttribute)
    }

    /* ЧТО В ПОЛЕ - и здесь пути ЗАПИСИ и ЧТЕНИЯ расходятся сознательно.
     *
     * Запись не берёт набранное никогда: она хранится, экспортируется в SKILL.md, скачивается и
     * пересылается, и обещание, которое агент печатает на экране записи, - про неё. Чтение окна - другой
     * путь: его зовёт модель между ходами, ответ живёт один ход и не сохраняется никуда (прогон пишет
     * `{tool, input, ms}` - см. _step.mjs, вывод действия в строку не попадает).
     *
     * И ГЛАВНОЕ: то, что здесь «раскрывается», модели уже прислали. Снимок листа сохранения СОДЕРЖИТ
     * набранное имя, в каждом кадре. Отказ назвать то, что уже показано, не защищал ничего - он заставлял
     * модель угадывать.
     *
     * Измерено, из-за чего это написано: в прогоне на 198 секунд имя файла было набрано ЧЕТЫРЕ раза тремя
     * разными способами - печатью, второй печатью и через буфер обмена, - потому что проверить «долетело
     * ли» было нечем. Девять шагов из четырнадцати в этом блоке были повторами, около шестидесяти секунд.
     *
     * Обрезано коротко и намеренно: значение AXTextArea - это весь документ, а вывод действия деплой режет
     * на 2000 символах. Восьмидесяти хватает, чтобы узнать имя файла и не хватает, чтобы вывезти текст.
     * Поле пароля не читается здесь ни при каких условиях - см. isSecure. */
    private static let VALUE_MAX = 80

    private static func readableValue(_ element: AXUIElement) -> String? {
        guard !isSecure(element), holdsTypedText(element) else { return nil }
        guard let raw = nameAttr(element, kAXValueAttribute), !raw.isEmpty else { return nil }
        return clip(raw, VALUE_MAX)
    }

    private static func describeOne(_ element: AXUIElement) -> Seen? {
        let name = readableName(element)
        let value = readableValue(element)
        let typed = holdsTypedText(element)
        /* ПОЛЕ ВВОДА ПОКАЗЫВАЕТСЯ ВСЕГДА, даже безымянное и даже пустое - и обе оговорки найдены пробой,
         * а не рассуждением.
         *
         * Раньше требовалось имя. У поля ввода подписи обычно нет (kAXTitle пусто, значение ему было
         * запрещено), так что поле имени в листе сохранения не попадало в ответ ВОВСЕ - то самое поле, ради
         * которого всё это и писалось. Первая правка чинила это через наличие ЗНАЧЕНИЯ, и оставляла две
         * дыры ровно там, где больно: ПУСТОЕ поле (до того, как в него напечатали, - то есть в тот момент,
         * когда его и надо найти) и поле ПАРОЛЯ (значение запрещено навсегда) оставались невидимы. Модель
         * не может кликнуть в то, чего не видит.
         *
         * Поэтому условие - «есть подпись, ИЛИ есть значение, ИЛИ это вообще поле ввода». */
        guard (name?.isEmpty == false) || value != nil || typed else { return nil }
        guard let origin = pointAttr(element, kAXPositionAttribute),
              let size = sizeAttr(element, kAXSizeAttribute),
              size.width > 1, size.height > 1,
              size.width.isFinite, size.height.isFinite else { return nil }
        let kind = stringAttr(element, kAXRoleDescriptionAttribute)
            ?? stringAttr(element, kAXRoleAttribute) ?? "element"
        var enabled = true
        if let flag = copyAttr(element, kAXEnabledAttribute as String) as? Bool { enabled = flag }
        return Seen(name: name ?? "", kind: kind, frame: CGRect(origin: origin, size: size),
                    enabled: enabled, value: value, secret: isSecure(element))
    }

    /* ЧТО ГОДИТСЯ В ОРИЕНТИР. Список получен замером на Windows по двенадцати живым окнам - Button с
     * медианой имени 11 символов, Edit с медианой 4, TabItem с 24 - и тем же замером исключены Text,
     * ListItem, DataItem и Group: их короткие примеры выглядят подписями, а длинные это чужой текст.
     * Document и Pane исключены по другой причине - они не локализуют: «ниже „Claude“» про элемент во весь
     * экран не сообщает ничего.
     *
     * Здесь сравнивается kAXRoleDescription, то есть та же человеческая строка, что записывается в `type`,
     * и поэтому список один на две платформы. Держится тестом, сравнивающим оба файла. */
    static let landmarkKinds: Set<String> = [
        "button", "split button", "tab item", "menu item", "hyperlink", "link", "check box",
        "radio button", "combo box", "edit", "text field", "tool bar", "toolbar", "tree item",
    ]

    /* Панель во весь экран - не ориентир, и ориентир в шестистах пикселях - другое место, а не это.
     * Те же два числа, что на Windows. */
    static let landmarkAreaMax: CGFloat = 520_000
    static let landmarkReachMax: CGFloat = 220

    /* Подпись ближайшего элемента управления и сторона, с которой от него точка.
     *
     * ПОВТОРЯЮЩЕЕСЯ ИМЯ - НЕ ОРИЕНТИР: 'Header' встречается в окне пять раз, 'Select a message' у
     * шестнадцати флажков подряд, и «ниже „Header“» не говорит, ниже какого. Уникальность в пределах окна -
     * дешёвая проверка, снимающая весь класс сразу. */
    static func nearestLandmark(in root: AXUIElement, x: Double, y: Double) -> (near: String, side: String)? {
        let point = CGPoint(x: x, y: y)
        var counts: [String: Int] = [:]
        var fit: [Seen] = []
        for one in namedThings(in: root, nodes: 600, seconds: 1.2) {
            let name = one.name.trimmingCharacters(in: .whitespacesAndNewlines)
            guard !name.isEmpty, name.count <= NAME_MAX else { continue }
            guard landmarkKinds.contains(one.kind.lowercased()) else { continue }
            guard one.frame.width > 0, one.frame.height > 0 else { continue }
            guard one.frame.width * one.frame.height <= landmarkAreaMax else { continue }
            counts[name, default: 0] += 1
            fit.append(one)
        }

        var best: Seen?
        var bestDistance = CGFloat.greatestFiniteMagnitude
        for one in fit {
            let name = one.name.trimmingCharacters(in: .whitespacesAndNewlines)
            guard counts[name] == 1 else { continue }
            /* Расстояние до ПРЯМОУГОЛЬНИКА, а не до центра: у широкой кнопки центр может быть дальше, чем
             * у мелкой, стоящей вплотную, и «ближайшим» тогда становится не то, что видит человек. */
            let box = one.frame
            let dx = point.x < box.minX ? box.minX - point.x
                : (point.x > box.maxX ? point.x - box.maxX : 0)
            let dy = point.y < box.minY ? box.minY - point.y
                : (point.y > box.maxY ? point.y - box.maxY : 0)
            let distance = (dx * dx + dy * dy).squareRoot()
            if distance < bestDistance { bestDistance = distance; best = one }
        }

        guard let found = best, bestDistance <= landmarkReachMax else { return nil }
        let box = found.frame
        let side: String
        if bestDistance == 0 { side = "in" }
        else if point.y < box.minY { side = "above" }
        else if point.y > box.maxY { side = "below" }
        else if point.x < box.minX { side = "left" }
        else { side = "right" }
        return (found.name.trimmingCharacters(in: .whitespacesAndNewlines), side)
    }

    /// Breadth first, so the things a person sees first are the things that fit in the answer.
    static func namedThings(in root: AXUIElement, nodes: Int = 1500, seconds: Double = 2.5) -> [Seen] {
        var out: [Seen] = []
        var queue: [(element: AXUIElement, depth: Int)] = [(root, 0)]
        var head = 0
        var left = nodes
        let stop = Date().addingTimeInterval(seconds)

        while head < queue.count, left > 0 {
            if Date() >= stop { break }
            let here = queue[head]
            head += 1
            left -= 1
            if here.depth > 0, let seen = describeOne(here.element) { out.append(seen) }
            if here.depth >= 12 { continue }
            for child in childrenOf(here.element).prefix(80) {
                if let hidden = copyAttr(child, kAXHiddenAttribute) as? Bool, hidden { continue }
                queue.append((child, here.depth + 1))
            }
            if queue.count > 6000 { break }
        }
        return out
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
                /* Дерево не ответило - но окно есть, и его прямоугольник тоже: повтор сможет пересчитать
                 * точку относительно окна, даже когда назвать элемент было нечем. */
                job.target.winRect = under.rect
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
        if named.control == nil, let found = namedAround(hit, x: job.x, y: job.y) {
            named = found
        }

        job.target.app = appName(of: hit)
        recordName(job.target, name: named.control, type: named.type)
        job.target.role = named.role
        job.target.subrole = named.subrole
        job.target.container = named.container
        job.target.containerName = named.containerName
        job.target.url = named.url
        if hasPid { job.target.window = frontWindowTitle(pid: pid) }

        /* ЯКОРЬ. Прямоугольник окна - из того же списка CGWindowList, который отвечает «какое окно под
         * точкой»; прямоугольник элемента - из того попадания, что дало имя, и ТОЛЬКО когда имя
         * действительно записалось: правило длины могло его отбросить, а без имени целиться повтору не во
         * что - остаётся окно. */
        job.target.winRect = windowAt(x: job.x, y: job.y)?.rect
        if job.target.control != nil { job.target.elRect = named.frame }

        /* ТОЛЬКО когда имени нет: при живой подписи ориентир не нужен и стоил бы обхода дерева ни за что.
         * Обход здесь короче, чем у read_window (600 узлов против 1500, 1.2 с против 2.5), потому что это
         * не ответ модели, а приписка к шагу: лучше не найти ориентир, чем задержать резолвер. */
        if job.target.control == nil, hasPid,
           let found = nearestLandmark(in: AXUIElementCreateApplication(pid),
                                       x: Double(job.x), y: Double(job.y)) {
            job.target.near = clip(found.near, 120)
            job.target.side = found.side
        }
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
        /* valueMayName: false - и это не осторожность, а определение. Сфокусированный элемент это тот, в
         * который сейчас печатают; его значение не может быть ничем, кроме набранного. */
        let named = nameByClimbing(focused, valueMayName: false)
        recordName(job.target, name: named.control, type: named.type)
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

            let onscreenNow = (entry[kCGWindowIsOnscreen as String] as? Bool) ?? false
            /* ЛЕСА ПАНЕЛИ СОХРАНЕНИЯ - НЕ ОКНО, КОТОРОЕ КТО-ТО ИМЕЛ В ВИДУ.
             *
             * Диалоги «Открыть» и «Сохранить» на macOS рисует отдельный процесс, и в списке окон он
             * оставляет несколько СВОИХ, ни одно из которых не на экране: видимая панель - это лист на окне
             * приложения, которое её открыло. Измерено: три записи «Open and Save Panel Service», все
             * `minimized`, при живой панели на экране.
             *
             * Модели они показывались как «свёрнутое окно, которое можно активировать», и в наблюдённом
             * прогоне она честно попробовала: `activate title=Открыть` совпало с одной из них, а поднять
             * XPC-службу macOS не даёт - «macOS refused to bring Open and Save Panel Service (Pages)
             * forward». Ход потрачен на окно, которого нет.
             *
             * Отфильтровано ТОЛЬКО когда оно вне экрана: панель, показанная отдельным окном, а не листом
             * (runModal вместо begin), на экране будет, и её прятать нельзя - в неё придётся целиться. */
            if !onscreenNow && owner.hasPrefix("Open and Save Panel Service") { continue }

            let alpha = entry[kCGWindowAlpha as String] as? Double ?? 1
            if alpha < 0.05 { continue }

            guard let boundsDict = entry[kCGWindowBounds as String] as? [String: Any],
                  let bounds = CGRect(dictionaryRepresentation: boundsDict as CFDictionary) else { continue }
            // Too small to be a real window: helper and shadow windows land here.
            if bounds.width < 40 || bounds.height < 40 { continue }

            let pid = pid_t(entry[kCGWindowOwnerPID as String] as? Int ?? 0)
            let onscreen = onscreenNow

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

    /* The window under a point, front to back, on-screen only - the owner of what a click would land on.
     * Used by the guard above and by nothing else: naming a click's target is the accessibility path's job
     * and it answers a different question. */
    static func at(x: Double, y: Double) -> WindowInfo? {
        for window in list() where !window.minimized {
            if x >= Double(window.x), x <= Double(window.x + window.w),
               y >= Double(window.y), y <= Double(window.y + window.h) {
                return window
            }
        }
        return nil
    }

    /// Whatever is in front, when an action was given no window to aim at.
    static func front() -> WindowInfo? {
        let all = list()
        return all.first(where: { $0.active }) ?? all.first(where: { !$0.minimized })
    }

    /* ONE OPEN WINDOW, by title or by process - the thing `capture`, `refresh` and `waitwindow` all need to
     * agree about. `list()` is ordered front to back, so an equally good match that is nearer the front
     * wins, and an ACTIVE one wins outright: "the Save dialog" means the one in front of you. */
    static func matching(title: String, process: String) -> WindowInfo? {
        let wantTitle = title.trimmingCharacters(in: .whitespacesAndNewlines).lowercased()
        let wantProcess = squashed(process)
        if wantTitle.isEmpty && wantProcess.isEmpty { return nil }

        var best: WindowInfo?
        for window in list() {
            if !wantProcess.isEmpty && !squashed(window.process).contains(wantProcess) { continue }
            if !wantTitle.isEmpty && !window.title.lowercased().contains(wantTitle) { continue }
            if window.active { return window }
            if best == nil { best = window }
        }
        return best
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
        /* Совпавшее окно, которое принадлежит процессу без собственного места в Dock. См. ниже. */
        var helper: String?

        for wanted in asked {
            let want = squashed(wanted)
            if want.isEmpty { continue }

            for app in apps where names(of: app).contains(where: { squashed($0).contains(want) }) {
                return raise(app)
            }

            /* By window title, which is what the model has been reading. The window list carries the owning
             * pid, so the title leads to the application without a second search. */
            for window in list() where squashed(window.title).contains(want) {
                guard let app = NSRunningApplication(processIdentifier: window.pid) else { continue }
                /* НЕ ВСЁ, У ЧЕГО ЕСТЬ ОКНО, МОЖНО ВЫВЕСТИ ВПЕРЁД. Служебный процесс - панель сохранения,
                 * системный диалог - живёт без activation policy `.regular`, и activate() у него всегда
                 * возвращает false. Отказ «macOS refused to bring … forward» читается как поломка macOS, а
                 * на деле это окно, которое и так впереди: панель - лист на окне того, кто её открыл.
                 * Запоминается и пропускается, чтобы шанс достался владельцу, а если владельца не нашлось -
                 * чтобы сказать об этом словами, из которых видно, что делать. */
                if app.activationPolicy != .regular {
                    if helper == nil { helper = app.localizedName ?? window.process }
                    continue
                }
                return raise(app)
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

        /* Совпало, но поднять нечего - и это НЕ «не нашли». Модель, которой сказали «ничего не совпало»,
         * пойдёт открывать заново то, что уже открыто; ей надо сказать, что это такое и что с этим делать. */
        if let helper {
            return "\"\(asked.first ?? "")\" belongs to \(helper), which macOS will not bring forward on its "
                + "own - a system open/save panel is a sheet on the window that opened it, and it is "
                + "already in front of that window. Aim at it directly: click it, or read the window to "
                + "see what it calls things."
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
    private static func grab(width: Int, height: Int, near: CGPoint? = nil) -> (image: CGImage, frame: CGRect)? {
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
                let cursor = near ?? (CGEvent(source: nil)?.location ?? .zero)
                let display = content.displays.first(where: {
                    CGDisplayBounds($0.displayID).contains(cursor)
                }) ?? content.displays.first
                guard let display else { return }

                /* НАШИ СОБСТВЕННЫЕ ОКНА - ВОН ИЗ КАДРА, и это не косметика.
                 *
                 * Начиная с 0.22.0 у агента есть окно на весь экран - рамка, говорящая человеку, что
                 * машину сейчас ведут (см. Acting ниже). Если оставить её в кадре, она попадает и в
                 * снимок, который видит модель, и в отпечаток 64x36, по которому обе стороны решают,
                 * шевельнулся ли экран, - а зажигается и гаснет она ровно на границах хода. То есть
                 * каждый прогон начинался бы с кадра, где «что-то изменилось», и это изменение было бы
                 * наше собственное.
                 *
                 * По pid, а не по списку конкретных окон: меню в строке состояния - тоже наше окно, и
                 * открытое меню в снимке модели нужно ей не больше, чем рамка. Одно правило вместо
                 * двух. */
                let ours = content.windows.filter {
                    $0.owningApplication?.processID == ProcessInfo.processInfo.processIdentifier
                }
                let filter = SCContentFilter(display: display, excludingWindows: ours)
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
            Crash.say("no JPEG encoder on this Mac", at: "shot")
            return "{\"ok\":false,\"error\":\"no JPEG encoder\"}"
        }
        CGImageDestinationAddImage(dest, got.image, [kCGImageDestinationLossyCompressionQuality: 0.85] as CFDictionary)
        guard CGImageDestinationFinalize(dest) else {
            Crash.say("the screen could not be encoded as JPEG", at: "shot")
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
    /* The 64x36 grey reduction itself, which two callers want: /pulse, and the wait inside a goal run that
     * this agent now carries out for itself. The aspect ratio is deliberately not kept - a caller only ever
     * compares one grid with the next, and matching the Windows agent's 64x36 exactly means the two cannot
     * disagree about what "the screen changed" means. */
    static func grid() -> [UInt8]? {
        guard #available(macOS 14.0, *) else { return nil }
        guard let got = grab(width: 128, height: 72) else { return nil }
        guard let ctx = resize(got.image, 64, 36, gray: false), let data = ctx.data else { return nil }
        let bytes = data.bindMemory(to: UInt8.self, capacity: 64 * 36 * 4)
        var grey = [UInt8](repeating: 0, count: 64 * 36)
        for i in 0..<(64 * 36) {
            let r = Int(bytes[i * 4])
            let g = Int(bytes[i * 4 + 1])
            let b = Int(bytes[i * 4 + 2])
            grey[i] = UInt8((r * 77 + g * 150 + b * 29) >> 8)
        }
        return grey
    }

    static func pulse() -> String {
        guard #available(macOS 14.0, *) else {
            return "{\"ok\":false,\"error\":\"seeing the screen needs macOS 14 or newer\"}"
        }
        guard let grey = grid() else {
            return "{\"ok\":false,\"error\":\"macOS has not granted Screen Recording to this agent\"}"
        }
        return "{\"ok\":true,\"grid\":\"\(Data(grey).base64EncodedString())\"}"
    }

    /* ОДНО ОКНО, А НЕ ЭКРАН, и в этом весь смысл действия.
     *
     * Снимок экрана - это снимок того, что сверху, и в прогоне, ради которого это писалось на Windows,
     * сверху был терминал, закрывавший диалог, который модель пыталась сфотографировать: подтвердить, что
     * диалог вообще открыт, ей так и не удалось ни разу. Там ответом был PrintWindow - просьба к окну
     * нарисовать СЕБЯ. Здесь ответ лучше: SCContentFilter(desktopIndependentWindow:) снимает именно это
     * окно, что бы перед ним ни стояло, - и в отличие от PrintWindow не отказывает на аппаратно
     * ускоренных поверхностях. Оговорки про «окно не нарисовало себя» здесь поэтому нет. */
    @available(macOS 14.0, *)
    static func window(pid: pid_t, titled: String) -> (image: CGImage, frame: CGRect)? {
        guard Permission.screenRecording else { return nil }
        let waiter = DispatchSemaphore(value: 0)
        let slot = Captured()

        Task {
            defer { waiter.signal() }
            do {
                let content = try await SCShareableContent.excludingDesktopWindows(
                    false, onScreenWindowsOnly: true
                )
                let want = titled.lowercased()
                let mine = content.windows.filter { $0.owningApplication?.processID == pid }
                let picked = mine.first(where: { ($0.title ?? "").lowercased() == want })
                    ?? mine.first(where: { ($0.title ?? "").lowercased().contains(want) })
                    ?? mine.max(by: { $0.frame.width * $0.frame.height < $1.frame.width * $1.frame.height })
                guard let picked else { return }

                let filter = SCContentFilter(desktopIndependentWindow: picked)
                let config = SCStreamConfiguration()
                let scale = CGFloat(filter.pointPixelScale)
                config.width = max(1, Int((filter.contentRect.width * scale).rounded()))
                config.height = max(1, Int((filter.contentRect.height * scale).rounded()))
                config.captureResolution = .best
                config.showsCursor = false
                let image = try await SCScreenshotManager.captureImage(
                    contentFilter: filter, configuration: config
                )
                slot.value = (image, picked.frame)
            } catch {
                // Reported by the caller as a window that could not be photographed.
            }
        }
        if waiter.wait(timeout: .now() + 8) == .timedOut { return nil }
        return slot.value
    }

    /* Кусок экрана, в ТОЧКАХ: одна точка картинки - одна точка экрана. Съёмка идёт с того дисплея, на
     * котором лежит сам прямоугольник, а не с того, где курсор, - иначе область со второго монитора
     * возвращала бы кусок первого. */
    @available(macOS 14.0, *)
    static func region(_ rect: CGRect) -> CGImage? {
        let here = Desktop.displayContaining(rect.origin)
        guard here.width > 1, here.height > 1 else { return nil }
        guard let got = grab(width: Int(here.width), height: Int(here.height),
                             near: CGPoint(x: rect.midX, y: rect.midY)) else { return nil }
        let scale = Double(got.image.width) / Double(got.frame.width)
        let cut = CGRect(
            x: (rect.origin.x - got.frame.origin.x) * scale,
            y: (rect.origin.y - got.frame.origin.y) * scale,
            width: rect.width * scale,
            height: rect.height * scale
        ).intersection(CGRect(x: 0, y: 0, width: got.image.width, height: got.image.height))
        guard cut.width >= 2, cut.height >= 2 else { return nil }
        return got.image.cropping(to: cut)
    }
}

/* Куда ложатся снимки, и что не даёт им копиться.
 *
 * Под ~/Library/Caches, а не в «Изображения» и не в «Загрузки»: это рабочие файлы прогона, а не то, что
 * человек решил сохранить, и класть их среди своих картинок значит делать их проблемой этого человека.
 * Прогон, снявший тридцать окон, оставляет тридцать файлов - поэтому папка чистит себя сама: сначала по
 * возрасту, потом по количеству, потому что сотня снимков за час - такой же разгон, как сотня за месяц. */
enum Captures {
    static func directory() -> URL {
        let base = FileManager.default.urls(for: .cachesDirectory, in: .userDomainMask).first
            ?? URL(fileURLWithPath: NSTemporaryDirectory())
        let dir = base.appendingPathComponent("MouseFlow/captures", isDirectory: true)
        try? FileManager.default.createDirectory(at: dir, withIntermediateDirectories: true)
        prune(dir)
        return dir
    }

    private static func prune(_ dir: URL) {
        let keys: [URLResourceKey] = [.contentModificationDateKey]
        guard let all = try? FileManager.default.contentsOfDirectory(
            at: dir, includingPropertiesForKeys: keys, options: [.skipsHiddenFiles]
        ) else { return }
        let pngs = all.filter { $0.pathExtension.lowercased() == "png" }
        let dated = pngs.map { url -> (URL, Date) in
            let when = (try? url.resourceValues(forKeys: Set(keys)))?.contentModificationDate ?? Date.distantPast
            return (url, when)
        }.sorted { $0.1 > $1.1 }
        let cutoff = Date().addingTimeInterval(-7 * 24 * 3600)
        for (index, one) in dated.enumerated() where index >= 200 || one.1 < cutoff {
            /* Уборка - это уборка: снимок не должен падать из-за файла, который кто-то держит открытым. */
            try? FileManager.default.removeItem(at: one.0)
        }
    }

    /// PNG on disk. Returns the path, or the sentence saying why not.
    static func write(_ image: CGImage) -> (path: String?, problem: String?) {
        let stamp = DateFormatter()
        stamp.locale = Locale(identifier: "en_US_POSIX")
        stamp.dateFormat = "yyyyMMdd-HHmmss-SSS"
        let url = directory().appendingPathComponent("capture-\(stamp.string(from: Date())).png")
        guard let dest = CGImageDestinationCreateWithURL(url as CFURL, "public.png" as CFString, 1, nil) else {
            return (nil, "no PNG encoder on this Mac")
        }
        CGImageDestinationAddImage(dest, image, nil)
        guard CGImageDestinationFinalize(dest) else { return (nil, "the picture could not be written") }
        return (url.path, nil)
    }

    /// И на буфер ТОЖЕ, а не вместо: вставить в документ хочет один вызывающий, приложить к отчёту - другой.
    static func toClipboard(_ image: CGImage) -> String? {
        let rep = NSBitmapImageRep(cgImage: image)
        guard let png = rep.representation(using: .png, properties: [:]) else {
            return "the picture could not be encoded for the clipboard"
        }
        let board = NSPasteboard.general
        board.clearContents()
        return board.setData(png, forType: .png) ? nil : "macOS refused the clipboard"
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
    /* The aliases the Windows table accepts, so a skill that says `arrowup` does not fail on one platform
     * for a reason nobody can read from the message. */
    "arrowleft": 123, "arrowright": 124, "arrowdown": 125, "arrowup": 126,
    "home": 115, "end": 119, "pageup": 116, "pagedown": 121,
    "f1": 122, "f2": 120, "f3": 99, "f4": 118, "f5": 96, "f6": 97, "f7": 98, "f8": 100,
    "f9": 101, "f10": 109, "f11": 103, "f12": 111,
    "a": 0, "b": 11, "c": 8, "d": 2, "e": 14, "f": 3, "g": 5, "h": 4, "i": 34, "j": 38,
    "k": 40, "l": 37, "m": 46, "n": 45, "o": 31, "p": 35, "q": 12, "r": 15, "s": 1,
    "t": 17, "u": 32, "v": 9, "w": 13, "x": 7, "y": 16, "z": 6,
    "0": 29, "1": 18, "2": 19, "3": 20, "4": 21, "5": 23, "6": 22, "7": 26, "8": 28, "9": 25,
    /* kVK_Help sits where Insert sits on a PC keyboard, which is what a skill written on Windows means by
     * it. Added when the Windows table grew Insert, so the two stay in step. */
    "insert": 114, "ins": 114, "help": 114,
]

/* KEYS THE WINDOWS TABLE HAS AND THIS PLATFORM DOES NOT, named so the refusal says something useful.
 *
 * A skill created on Windows can carry any of these, and "no key called printscreen" sends a model looking
 * for a spelling mistake in its own instruction. Each genuinely has no equivalent here, and for each there
 * is something else to do - so the message says what. Held in step with the Windows table by a test: every
 * name one platform accepts is either accepted here or refused here BY NAME. */
let NO_SUCH_KEY_HERE: [String: String] = [
    "printscreen": "there is no PrintScreen key on macOS - use capture_window, which saves a file AND sets "
        + "the clipboard",
    "prtsc": "there is no PrintScreen key on macOS - use capture_window instead",
    "snapshot": "there is no PrintScreen key on macOS - use capture_window instead",
    "menu": "there is no Menu key on macOS - right-click instead, which is click with button=right",
    "contextmenu": "there is no Menu key on macOS - right-click instead, which is click with button=right",
    "win": "there is no Windows key on macOS. In this grammar `ctrl` already means Command, which is the "
        + "modifier that key stands in for",
]

/* ---------------------------------------------------------------- the one window it will not touch
 *
 * ЭТОТ АГЕНТ - ПРОГРАММА В ТЕРМИНАЛЕ, когда его запустили из терминала, и тогда окно этого терминала -
 * окно, в которое он умеет печатать; а Ctrl+C, напечатанный туда, останавливает прогон, который это и
 * печатает.
 *
 * Не гипотеза. В наблюдаемом прогоне на Windows модели понадобился снимок, у press_key не оказалось
 * PrintScreen, и она пошла писать себе утилиту захвата: открыла вторую вкладку, набрала однострочник,
 * нажала Ctrl+C - и оставила записку следующему за собой: «вкладка 1 - сессия самого агента (НЕ печатать,
 * НЕ Ctrl+C)». Она вывела опасность сама и оставила предупреждение прозой. Предупреждение прозой - не
 * охрана.
 *
 * ОХРАНА СТРОИТСЯ НА ДЕРЕВЕ ПРОЦЕССОВ, а не на «своём окне», и это урок, привезённый с Windows: там первая
 * версия читала GetConsoleWindow(), а под Windows Terminal он возвращает ноль - охрана была мертва ровно в
 * той среде, для которой писалась. На macOS та же форма: агент - это `main` в оболочке, оболочка - дочерний
 * процесс Terminal.app или iTerm2, и ВИДИМОЕ ОКНО ПРИНАДЛЕЖИТ РОДИТЕЛЮ. Поэтому: getppid() вверх по цепочке
 * до первого предка, у которого есть видимое окно, - это и есть терминал, который видит человек.
 *
 * И НЕ ДАЛЬШЕ. Ещё один уровень вверх - это Finder, Dock и launchd, и запретить их значило бы запретить
 * рабочий стол: на Windows тот же лишний шаг упёрся бы в explorer.
 *
 * Плюс собственные окна: строка меню наша, и «Stop and Save Recording» на ней.
 *
 * Под автозапуском родитель - launchd, окон у него нет, и цепочка обрывается на первом же шаге: в этом
 * состоянии каждое окно на машине - чужое, и это правильно.
 *
 * Запрет ШИРЕ опасности - защищено всё окно терминала, а не одна вкладка, - потому что вкладки одного окна
 * это один процесс-хозяин и разделить их нечем. Сообщение говорит, что с этим делать. */
enum Own {
    /* Программы, которые никогда не считаются «терминалом, в котором мы запущены»: у них есть окна, но эти
     * окна - рабочий стол и панель, то есть весь экран. */
    private static let notAHost: Set<String> = [
        "launchd", "loginwindow", "Finder", "Dock", "WindowServer", "SystemUIServer", "logind",
    ]

    private static var cached: Set<pid_t>?
    private static let gate = NSLock()

    /// The parent of a process, asked of the kernel - Foundation has no such thing.
    private static func parent(of pid: pid_t) -> pid_t {
        var info = kinfo_proc()
        var size = MemoryLayout<kinfo_proc>.stride
        var mib: [Int32] = [CTL_KERN, KERN_PROC, KERN_PROC_PID, pid]
        guard sysctl(&mib, 4, &info, &size, nil, 0) == 0, size > 0 else { return 0 }
        return info.kp_eproc.e_ppid
    }

    /// Does this process own a window a person could click into?
    private static func hasVisibleWindow(_ pid: pid_t) -> Bool {
        let options: CGWindowListOption = [.optionOnScreenOnly, .excludeDesktopElements]
        guard let list = CGWindowListCopyWindowInfo(options, kCGNullWindowID) as? [[String: Any]] else {
            return false
        }
        for info in list {
            guard (info[kCGWindowLayer as String] as? Int) == 0 else { continue }
            guard pid_t(info[kCGWindowOwnerPID as String] as? Int ?? 0) == pid else { continue }
            guard let bounds = info[kCGWindowBounds as String] as? [String: Double],
                  (bounds["Width"] ?? 0) > 40, (bounds["Height"] ?? 0) > 40 else { continue }
            return true
        }
        return false
    }

    /// Имя процесса, а не приложения: у оболочки нет NSRunningApplication, и спросить её имя можно только
    /// у ядра. Пустая строка значит «не удалось узнать» - и это не повод остановить подъём.
    private static func name(of pid: pid_t) -> String {
        if let app = NSRunningApplication(processIdentifier: pid)?.localizedName, !app.isEmpty { return app }
        var info = kinfo_proc()
        var size = MemoryLayout<kinfo_proc>.stride
        var mib: [Int32] = [CTL_KERN, KERN_PROC, KERN_PROC_PID, pid]
        guard sysctl(&mib, 4, &info, &size, nil, 0) == 0, size > 0 else { return "" }
        return withUnsafePointer(to: &info.kp_proc.p_comm) {
            $0.withMemoryRebound(to: CChar.self, capacity: Int(MAXCOMLEN) + 1) { String(cString: $0) }
        }
    }

    /// This process, plus the terminal showing it - worked out once, because a process tree does not move.
    static func pids() -> Set<pid_t> {
        gate.lock()
        defer { gate.unlock() }
        if let cached { return cached }

        var out: Set<pid_t> = [getpid()]
        var walker = parent(of: getpid())
        var up = 0
        while walker > 1, up < 6 {
            if notAHost.contains(name(of: walker)) { break }
            out.insert(walker)
            if hasVisibleWindow(walker) { break }   // это и есть терминал, который видит человек
            walker = parent(of: walker)
            up += 1
        }
        cached = out
        return out
    }

    /// The sentence, or nil when this window is somebody else's and may be used.
    static func refusal(pid: pid_t) -> String? {
        guard pid > 0, pids().contains(pid) else { return nil }
        if pid == getpid() {
            return "that is this agent's own window, and driving it would be driving the thing doing the "
                + "driving. Aim somewhere else"
        }
        return "that window belongs to the terminal this agent is running in - typing or clicking there can "
            + "stop the run that is doing the typing. Open a SECOND terminal window if you need one; it is "
            + "a different window and is fine"
    }
}

/* ГОРИЗОНТАЛЬНАЯ ОСЬ, И ЕЁ ЗНАК - В ОДНОМ МЕСТЕ.
 *
 * Дыра была тройная: боковую прокрутку человека нельзя было записать (тап читал только ось 1), нельзя было
 * повторить ("Scroll Left"/"Scroll Right" уходили в default и считались непроигрываемыми) и нельзя было
 * скомандовать (`dir=` не читался вовсе). Все три чинятся здесь, и все три обязаны согласиться о знаке -
 * поэтому и запись, и впрыск спрашивают ОДНУ функцию, а не пишут по знаку каждая.
 *
 * ЧИСЛО, КОТОРОЕ НЕ ИЗМЕРЕНО НА ЭТОЙ ПЛАТФОРМЕ, и сказать об этом честнее, чем промолчать. На Windows
 * соглашение задокументировано: у MOUSEEVENTF_HWHEEL положительное - вправо. У CGEvent оси 2 заголовок
 * системы знака не называет вовсе (CGEventTypes.h говорит только «изменение горизонтальной позиции»), а
 * весь сторонний код, который делает это годами, отрицает X при впрыске - то есть ПОЛОЖИТЕЛЬНОЕ ЗНАЧИТ
 * ВЛЕВО, как у NSEvent.scrollingDeltaX. Так и написано ниже.
 *
 * Если это окажется зеркально - меняется одна строка, и меняется сразу у обеих половин. Проверяется за
 * минуту: записать боковую прокрутку в любом приложении с горизонтальным списком и посмотреть в
 * транскрипте, что записалось, "Scroll Left" или "Scroll Right". */
enum Sideways {
    /// false: положительная ось 2 - это ВЛЕВО.
    static let rightIsPositive = false

    /// Сколько положить в wheel2 на один щелчок в названную сторону.
    static func wheel2(right: Bool) -> Int32 { (right == rightIsPositive) ? 1 : -1 }

    /// Как назвать то, что пришло с тапа.
    static func name(delta: Int64) -> String {
        let right = rightIsPositive ? delta > 0 : delta < 0
        return right ? "Scroll Right" : "Scroll Left"
    }
}

enum Input {
    private static func source() -> CGEventSource? {
        CGEventSource(stateID: .hidSystemState)
    }

    /* КАЖДОЕ СОБЫТИЕ НЕСЁТ РОВНО ТЕ МОДИФИКАТОРЫ, О КОТОРЫХ ЕГО ПОПРОСИЛИ, И НИ ОДНОГО ЛИШНЕГО.
     *
     * `flags` со значением по умолчанию, а не «не трогать»: событие, созданное из источника
     * `.hidSystemState` и не получившее флагов, ЗАБИРАЕТ ТЕКУЩЕЕ СОСТОЯНИЕ МОДИФИКАТОРОВ СИСТЕМЫ. До этой
     * правки флаги ставила только key(...), а move, click, scroll и type не ставили вовсе - и потому
     * наследовали то, что осталось от предыдущего аккорда.
     *
     * ИЗМЕРЕНО на живой машине тапом, который печатал флаги событий с нашей меткой. После одного
     * `action=key key=a ctrl=1`:
     *
     *   keyDown   mods=Cmd  text=""    <- сам аккорд, как и просили
     *   mouseDown mods=Cmd             <- клик стал Cmd-кликом
     *   scroll    mods=Cmd             <- прокрутка стала Cmd-прокруткой, то есть зумом
     *   keyDown   mods=Cmd  text="z"   <- набор буквы стал Cmd+Z, то есть отменой
     *
     * То есть после ЛЮБОГО аккорда набор «mouse test4» уходил как Cmd+M (свернуть окно), Cmd+O, Cmd+U,
     * Cmd+S (сохранить ещё раз), Cmd+E, Cmd+T. Ни один символ не попадал в поле, macOS пищала на те
     * сочетания, которым нечего делать, и модель честно писала «the typing didn't land». */
    private static func send(_ event: CGEvent?, flags: CGEventFlags = []) {
        guard let event else { return }
        event.flags = flags
        event.setIntegerValueField(.eventSourceUserData, value: INJECTED_MARK)
        event.post(tap: .cghidEventTap)
    }

    /* Модификаторы как КЛАВИШИ, потому что отпускать нужно клавишу, а не флаг.
     *
     * Второй половиной той же аварии было то, что состояние залипало ГЛОБАЛЬНО: после аккорда
     * `CGEventSource.flagsState(.combinedSessionState)` возвращал Cmd и не переставал - то есть вся машина,
     * включая собственный ввод человека, считала Command зажатым. Чистых флагов на наших событиях мало,
     * нужно отпускание.
     *
     * Способ выбран замером, а не по обычаю. Четыре варианта на живой машине:
     *   A  down/up с флагами, как было              -> Cmd остаётся
     *   B  + keyUp(Command) с пустыми флагами       -> (none)
     *   C  полный аккорд с клавишей-модификатором   -> (none)
     *   D  flagsChanged с пустыми флагами           -> (none)
     * Взят C: так делает настоящая клавиатура, и приложение, которое смотрит на flagsChanged - а таких
     * много, - видит связную последовательность, а не букву под флагом, взявшимся ниоткуда. */
    /// Отпустить всё, что осталось зажатым - кем угодно, включая прошлую сборку этого агента.
    static func releaseModifiers() {
        for step in releaseSteps(CGEventSource.flagsState(.combinedSessionState)) {
            send(CGEvent(keyboardEventSource: source(), virtualKey: step.code, keyDown: step.down),
                 flags: step.flags)
        }
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

    /* `flags` со значением по умолчанию: движение само по себе модификатора не несёт, а движение ВНУТРИ
     * модифицированного перетаскивания несёт - его передаёт повтор. */
    static func move(x: Double, y: Double, flags: CGEventFlags = []) {
        send(CGEvent(mouseEventSource: source(), mouseType: .mouseMoved,
                     mouseCursorPosition: CGPoint(x: x, y: y), mouseButton: .left), flags: flags)
    }

    static func click(x: Double, y: Double, button: String, double: Bool,
                      flags: CGEventFlags = []) {
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
                    /* НА ОБЕИХ ПОЛОВИНКАХ, нажатии и отпускании. Измерено при разборе повтора: флаги на
                     * посланном событии ДОСТАТОЧНЫ - окно сообщило одинаковый modifierFlags для события с
                     * флагом и для события с физически зажатой клавишей, - поэтому клавиша здесь не
                     * нажимается вовсе. Но они и ЗАЩЁЛКИВАЮТСЯ в состоянии сессии, ровно как аккорд на
                     * клавиатуре, поэтому ниже стоит снятие.
                     *
                     * ЧЕРЕЗ send, А НЕ ПРИСВОЕНИЕМ ДО НЕГО: send ставит `event.flags = flags`
                     * БЕЗУСЛОВНО, и по умолчанию это []. Присвоить флаги и позвать send(event) - значит
                     * поставить их и тут же снять, отправив жест без модификатора, пока код выше выглядит
                     * правильным. send при этом единственное место, ставящее метку впрыска, так что это и
                     * есть верная единственная дверь. */
                    send(event, flags: flags)
                }
            }
            if double && pass == 1 { usleep(60_000) }
        }
        /* Жест закрылся - модификатор отпускается. Не отпустить значит отдать следующему клику чужой
         * Option, а человеку за клавиатурой - зажатую клавишу; это тот самый дефект, который 0.19.0 нашёл
         * измерением, а не чтением. */
        if !flags.isEmpty { releaseModifiers() }
    }

    /* Половинки щелчка, порознь - для перетаскивания, которое click составить не может: он посылает
     * нажатие и отпускание вместе. */
    static func press(x: Double, y: Double, down: Bool, flags: CGEventFlags = []) {
        if down { move(x: x, y: y); usleep(40_000) }
        send(CGEvent(mouseEventSource: source(), mouseType: down ? .leftMouseDown : .leftMouseUp,
                     mouseCursorPosition: CGPoint(x: x, y: y), mouseButton: .left), flags: flags)
    }

    /// Движение С ЗАЖАТОЙ КНОПКОЙ - на macOS это отдельный тип события, и приложение, слушающее
    /// перетаскивание, .mouseMoved не увидит вовсе.
    static func dragTo(x: Double, y: Double, flags: CGEventFlags = []) {
        /* И НА ДВИЖЕНИЯХ ТОЖЕ, а не только на нажатии - иначе Option-перетаскивание распадается на
         * Option-нажатие и обычное перетаскивание, что в Finder есть разница между копированием и
         * перемещением. Проверено на живой машине при разборе повтора: флаг стоял на нажатии, на движении
         * и на отпускании. */
        send(CGEvent(mouseEventSource: source(), mouseType: .leftMouseDragged,
                     mouseCursorPosition: CGPoint(x: x, y: y), mouseButton: .left), flags: flags)
    }

    /* `dir` - up, down, left or right. Пусто значит по-старому: сторону выбирает знак `amount`, так что
     * вызывающий, написанный до этой сборки, ведёт себя ровно как раньше.
     *
     * СЧЁТ ОТДАЁТСЯ, И ЭТО ПОЧИНКА, А НЕ ПОТОЛОК. Было `min(30, abs(amount))` и ответ `{"ok":true}` - то
     * есть запрос на пятьдесят щелчков доставлял тридцать и отчитывался успехом, а модель дальше
     * рассуждала о положении, до которого не доехала. Тот же грех, что у `summary.applications`,
     * показавшего 24 для записи, тронувшей тридцать окон: недопоставка, поданная как факт.
     *
     * Потолок остался, потому что `amount=100000` - это не то, что кто-то имел в виду, а сорок минут
     * колеса не лучший ответ, чем предложение. Он вчетверо выше прежнего, ровно как на Windows, и когда
     * он срабатывает - об этом говорят вслух. */
    static func scroll(x: Double, y: Double, amount: Int, dir: String = "",
                       flags: CGEventFlags = []) -> String? {
        let way = dir.trimmingCharacters(in: .whitespaces).lowercased()
        var sideways = false
        var positive = false
        switch way {
        case "left": sideways = true; positive = false
        case "right": sideways = true; positive = true
        case "up": positive = true
        case "down": positive = false
        case "": positive = amount >= 0
        default: return "dir is up, down, left or right - not \"\(way)\""
        }

        move(x: x, y: y, flags: flags)
        usleep(20_000)
        /* One event per notch, because a single event with a large delta is treated as a fling by some
         * applications and scrolls further than asked. */
        let wanted = abs(amount)
        let steps = max(1, min(120, wanted))
        let wheel1: Int32 = sideways ? 0 : (positive ? 1 : -1)
        let wheel2: Int32 = sideways ? Sideways.wheel2(right: positive) : 0
        for _ in 0..<steps {
            send(CGEvent(scrollWheelEvent2Source: source(), units: .line,
                         wheelCount: sideways ? 2 : 1, wheel1: wheel1, wheel2: wheel2, wheel3: 0),
                 flags: flags)
            usleep(12_000)
        }
        if steps != wanted && wanted > 0 {
            Output.say("scrolled \(steps) notches, not \(wanted) - 120 is as much as one scroll does. "
                + "Call it again, or use scroll_to")
        }
        /* У ПРОКРУТКИ ПАРЫ НЕТ, поэтому снимает она за собой сама - здесь, внутри, а не у вызывающего.
         * Повтор снимал у себя, и пока вызывающий был один, этого хватало; со вторым (грамматика действий)
         * второй вызывающий унаследовал бы защёлкнутый Command на всю машину. Повторное снятие у повтора
         * безвредно, а функция теперь безопасна для любого, кто её позовёт. */
        if !flags.isEmpty { releaseModifiers() }
        return nil
    }

    /* Any text, on any layout, without a keymap: a synthetic key event carrying a unicode string. */
    static func type(_ text: String) {
        /* И НИКОГДА НЕ АККОРДОМ, что бы ни случилось раньше. Флаги ниже ставятся в пустые, но этого мало:
         * пока система считает Command зажатым, она так и разбирает то, что мы шлём. Отпускается здесь, а
         * не только в key(), потому что залипнуть могло что угодно - другое приложение, прошлая сборка
         * этого агента, зависший физический модификатор, - а набор обязан быть набором в любом случае. */
        releaseModifiers()
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
    static func key(_ name: String, ctrl: Bool, shift: Bool, alt: Bool, cmd: Bool, rawCtrl: Bool,
                    win: Bool) -> String? {
        let wanted = name.lowercased()
        /* WIN IS REFUSED RATHER THAN MAPPED, and that is the honest one of two bad choices. Turning it into
         * Command would send a DIFFERENT shortcut under the same name - Win+D shows the desktop on Windows,
         * Cmd+D duplicates on macOS - and a chord that quietly means something else is worse than one that
         * says it cannot be pressed. A caller that wants Command has `ctrl`, which is what that field means
         * in this grammar. Checked before the key, because the modifier is the part that cannot work.
         *
         * The Windows half has sent this field since 0.12.0 and this function read five modifiers and not
         * that one, so Win+D arrived as a bare D with no complaint at all. */
        if win { return NO_SUCH_KEY_HERE["win"] }
        if let why = NO_SUCH_KEY_HERE[wanted] { return why }
        guard let code = KEY_CODES[wanted] else { return "no key called \(name)" }
        var flags: CGEventFlags = []
        if shift { flags.insert(.maskShift) }
        if alt { flags.insert(.maskAlternate) }
        if rawCtrl { flags.insert(.maskControl) }
        if ctrl || cmd { flags.insert(.maskCommand) }

        /* СНАЧАЛА ОТПУСТИТЬ ЧУЖОЕ, и это не осторожность, а условие правильности.
         *
         * chordSteps снимает только те модификаторы, о которых её попросили. Модификатор, залипший НЕ от нас
         * - другим приложением, зависшей физической клавишей, прошлой сборкой этого агента, - не снимается и
         * при этом ДОБАВЛЯЕТСЯ к тому, что просили: система читает аккорд из своего состояния, а не из наших
         * намерений. `key=tab` под залипшим Command становится переключателем приложений, `key=w` закрывает
         * окно, `key=delete` в Finder отправляет в корзину, а `key=r ctrl=1` под залипшим Shift становится
         * Cmd+Shift+R. И key() возвращала nil - то есть «сделано» - в каждом из этих случаев.
         *
         * Ценой этого человек, ФИЗИЧЕСКИ держащий модификатор, его теряет. Во время прогона это верный
         * размен: прогон обязан сделать то, о чём его попросили, а не то, что получилось из чужого пальца. */
        releaseModifiers()

        /* ВСЕ СОБЫТИЯ СОЗДАЮТСЯ ДО ТОГО, КАК ОТПРАВЛЕНО ХОТЬ ОДНО.
         *
         * send() молча роняет nil, а события модификаторов создавались прямо в цикле и не проверялись - в
         * отличие от двух событий самой клавиши. Уроненное НАЖАТИЕ - это несработавший аккорд, и это видно.
         * Уроненное ОТПУСКАНИЕ - это Command, оставшийся зажатым для всей машины, и key() отвечала на это
         * «ок». Аккорд либо уходит целиком, либо не уходит вовсе и говорит об этом. */
        let plan = chordSteps(flags, key: code)
        var events: [(CGEvent, CGEventFlags)] = []
        for step in plan {
            guard let event = CGEvent(keyboardEventSource: source(), virtualKey: step.code,
                                      keyDown: step.down) else {
                return "macOS refused to make that key event"
            }
            events.append((event, step.flags))
        }
        for (event, stepFlags) in events { send(event, flags: stepFlags) }
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
/* НАРУЖУ - В ПИКСЕЛЯХ СКРИНШОТА.
 *
 * Всё остальное в actionBody (api/_brain.mjs) переводит ВНУТРЬ: точку с картинки в точку на экране, и одно
 * место для этого - правило. Часть действий отвечает КООРДИНАТАМИ, а это движение в обратную сторону, и его
 * делает агент - той же формулой, наизнанку. Альтернатива хуже: разговор, в котором позиции прочитаны с
 * read_window в экранных пикселях, а клики посылаются в пиксели скриншота, и промах на любом
 * масштабированном экране.
 *
 *   screen -> shot:  (v - ox) * scale
 *
 * Читается в начале каждого действия, которое умеет отвечать координатами; отсутствие полей значит
 * scale=1, ox=0, oy=0 - то есть «экранные пиксели», как было до 0.14.0. */
enum Geometry {
    private static var scale = 1.0
    private static var ox = 0.0
    private static var oy = 0.0
    private static let gate = NSLock()

    static func read(_ fields: [String: String]) {
        let asked = Double(fields["scale"] ?? "") ?? 1.0
        gate.lock()
        scale = asked > 0 ? asked : 1.0
        ox = Double(fields["ox"] ?? "") ?? 0
        oy = Double(fields["oy"] ?? "") ?? 0
        gate.unlock()
    }

    static func shotX(_ screenX: Double) -> Int {
        gate.lock(); defer { gate.unlock() }
        return Int(((screenX - ox) * scale).rounded())
    }

    static func shotY(_ screenY: Double) -> Int {
        gate.lock(); defer { gate.unlock() }
        return Int(((screenY - oy) * scale).rounded())
    }

    static func shotSize(_ px: Double) -> Int {
        gate.lock(); defer { gate.unlock() }
        return Int((px * scale).rounded())
    }
}

/// One element, described the way the model will read it back.
func elementLine(_ seen: Accessibility.Seen) -> String {
    (seen.kind.isEmpty ? "element" : seen.kind)
        + " \"\(clip(seen.name, 60))\""
        + " at \(Geometry.shotX(seen.frame.origin.x)),\(Geometry.shotY(seen.frame.origin.y))"
        + " \(Geometry.shotSize(seen.frame.width))x\(Geometry.shotSize(seen.frame.height))"
        /* `= "…"` ПОСЛЕ прямоугольника и до «(disabled)», так что строка читается слева направо как
         * «что это, где это, что в нём». Пусто у всего, что не поле ввода.
         *
         * У поля пароля - слова вместо значения, а не пустота: пустое поле и поле пароля иначе неразличимы,
         * и модель, решившая, что поле просто пустое, напечатает пароль в отчёт о своих действиях. */
        + (seen.secret ? " = (password, not read)" : (seen.value.map { " = \"\($0)\"" } ?? ""))
        + (seen.enabled ? "" : " (disabled)")
}

/* ЧТО НА ЭТОМ ОКНЕ, ПО ИМЕНАМ.
 *
 * Ответ модели, целящейся в координату, прочитанную с уменьшенного скриншота: она может прочитать имена.
 * Ограничено дважды - по числу и по символам, - потому что деплой режет вывод действия на 2000 символах, а
 * молча укороченный там список - это список, которому модель верит и не должна. Что не влезло, названо
 * вслух. */
func doRead(_ fields: [String: String]) -> String? {
    Geometry.read(fields)
    let target = Accessibility.windowToRead(title: fields["title"] ?? "", process: fields["process"] ?? "")
    guard case let .found(window, where_) = target else {
        if case let .none(problem) = target { return problem }
        return "could not read that window"
    }

    var lines: [String] = []
    var seenLines = Set<String>()
    var skipped = 0
    var budget = 1500
    for one in Accessibility.namedThings(in: window) {
        let line = elementLine(one)
        /* Один и тот же элемент, названный дважды - обёртка и её подпись с одним именем и одним
         * прямоугольником, - для читателя одна вещь. */
        if !seenLines.insert(line).inserted { continue }
        if lines.count >= 40 || budget - line.count < 0 { skipped += 1; continue }
        budget -= line.count + 1
        lines.append(line)
    }

    if lines.isEmpty {
        Output.say("that window names nothing readable - normal for a canvas, a game, or an application "
            + "that has not been asked for its accessibility tree. The screenshot is what there is")
        return nil
    }
    var said = "\(lines.count) named things on \"\(clip(where_, 60))\", positions in screenshot pixels: "
        + lines.joined(separator: "; ")
    if skipped > 0 {
        said += ". \(skipped) more were left out for room - ask for a narrower window, or use find with a "
            + "name if you know what you are looking for"
    }
    Output.say(said)
    return nil
}

/* ГДЕ ОДНА НАЗВАННАЯ ВЕЩЬ - ответ на «есть ли она, и где».
 *
 * Сначала точное имя, потом вхождение без учёта регистра, потому что человек пишет «About» для пункта
 * «About…». Неоднозначность СООБЩАЕТСЯ, а не решается: два элемента с одним именем - это факт, который
 * модели нужен, и молча выбрать один значит кликнуть не по той строке. */
/// Найденное, либо предложение о том, почему искать было негде. Не Result: Swift требует, чтобы ошибка
/// была Error, а здесь она - фраза для модели, и заводить ради неё тип значило бы усложнить то, что читают.
func findThings(_ fields: [String: String], wanted: String) -> (hits: [Accessibility.Seen], problem: String?) {
    /* Заголовка окна здесь нет намеренно: `find` смотрит на то, что впереди, или на названный процесс, а
     * своё единственное свободнотекстовое поле тратит на ИМЯ. */
    let target = Accessibility.windowToRead(title: "", process: fields["process"] ?? "")
    guard case let .found(window, _) = target else {
        if case let .none(problem) = target { return ([], problem) }
        return ([], "could not read that window")
    }
    let all = Accessibility.namedThings(in: window)
    let exact = all.filter { $0.name == wanted }
    if !exact.isEmpty { return (exact, nil) }
    let low = wanted.lowercased()
    return (all.filter { $0.name.lowercased().contains(low) }, nil)
}

func doFind(_ fields: [String: String]) -> String? {
    Geometry.read(fields)
    let wanted = (fields["title"] ?? "").trimmingCharacters(in: .whitespacesAndNewlines)
    if wanted.isEmpty { return "find needs a name to look for" }

    let looked = findThings(fields, wanted: wanted)
    if let problem = looked.problem { return problem }
    let hits = looked.hits

    var said: [String] = []
    for one in hits.prefix(6) {
        let cx = Geometry.shotX(one.frame.midX)
        let cy = Geometry.shotY(one.frame.midY)
        said.append(elementLine(one) + ", centre \(cx),\(cy)")
    }

    if said.isEmpty {
        Output.say("nothing on that window is called \"\(clip(wanted, 60))\". Read the window to see what "
            + "it does call things, or look at the screenshot - it may not be there at all")
        return nil
    }
    if said.count == 1 {
        Output.say("found " + said[0] + " - click the centre")
        return nil
    }
    Output.say("\(said.count) things match \"\(clip(wanted, 60))\", so the name alone does not say which: "
        + said.joined(separator: "; ") + ". Pick by position, or use a longer name")
    return nil
}

/* ТИХИЙ ЭКРАН, измеренный здесь, а не спрошенный у модели ещё раз. Тот же отпечаток и тот же порог, что у
 * ожидания в курьере (Courier.quiet), потому что два ответа на «оно устоялось» устоялись бы по-разному.
 * Возвращает, сколько ждали, - чтобы вызывающий мог сказать, дождался он или вышло время. */
func settleHere(_ limitMs: Int) -> (quiet: Bool, waitedMs: Int) {
    let started = Date()
    var last: [UInt8]?
    var still = 0
    while true {
        let waited = Int(Date().timeIntervalSince(started) * 1000)
        if waited >= limitMs { return (false, waited) }
        let now = Screen.grid()
        if let was = last, let now, Courier.quiet(was, now) {
            still += 1
            /* Дважды, а не один раз: список, перерисовавшийся мгновением позже, выглядит неподвижным на
             * одном сравнении. */
            if still >= 2 { return (true, waited) }
        } else {
            still = 0
        }
        last = now
        Thread.sleep(forTimeInterval: 0.35)
    }
}

/* ПРОКРУТКА, ПОКА ЧТО-ТО НЕ СТАНЕТ ПРАВДОЙ - одним действием вместо хода модели на каждую порцию колеса.
 *
 * `to=end` и `to=start` останавливаются, когда экран перестал меняться: снаружи именно так и выглядит
 * достигнутый край списка. Любое другое значение - ИМЯ, и цикл останавливается, когда это имя нашлось. Оба
 * ограничены, и ограничение сообщается: прокрутка, сдавшаяся после сорока порций, - другой факт, чем
 * прокрутка, доехавшая, и модель, которой сказали только «done», поверила бы, что доехала.
 *
 * Почему это действие, а не композиция: композиция стоит хода модели на порцию - восемь-пятьдесят секунд в
 * наблюдаемом прогоне против примерно 25 мс здесь. */
func doScrollTo(_ fields: [String: String]) -> String? {
    Geometry.read(fields)
    let to = (fields["to"] ?? "").trimmingCharacters(in: .whitespacesAndNewlines)
    if to.isEmpty { return "scrollto needs to=end, to=start, or a name to scroll to" }
    let up = to.lowercased() == "start"
    let toEdge = up || to.lowercased() == "end"

    var x = Double(fields["x"] ?? "") ?? .nan
    var y = Double(fields["y"] ?? "") ?? .nan
    if !x.isFinite || !y.isFinite {
        guard let front = Windows.front() else {
            return "scrollto needs x and y - where to put the pointer before scrolling"
        }
        x = Double(front.x) + Double(front.w) / 2
        y = Double(front.y) + Double(front.h) / 2
    }
    if let mine = Own.refusal(pid: Windows.at(x: x, y: y)?.pid ?? 0) { return mine }

    let bursts = 40
    var did = 0
    var still = 0

    for _ in 0..<bursts {
        if !toEdge {
            var look = fields
            look["title"] = to
            /* Переиспользуется find, а не переписывается: то же правило «точное, потом вхождение», чтобы
             * «прокрути до неё» и «она там?» не могли разойтись в ответе. */
            let looked = findThings(look, wanted: to)
            if let problem = looked.problem { return problem }
            if let first = looked.hits.first {
                let cx = Geometry.shotX(first.frame.midX)
                let cy = Geometry.shotY(first.frame.midY)
                Output.say("scrolled \(did) times and found " + elementLine(first)
                    + ", centre \(cx),\(cy) - click the centre")
                return nil
            }
        }

        let before = Screen.grid()
        _ = Input.scroll(x: x, y: y, amount: 3, dir: up ? "up" : "down")
        did += 1

        let after = Screen.grid()
        if let a = before, let b = after, Courier.quiet(a, b) {
            still += 1
            if still >= 2 { break }
        } else {
            still = 0
        }
    }

    if toEdge {
        Output.say("scrolled \(up ? "up" : "down") \(did) times" + (still >= 2
            ? " and the screen stopped changing, which is what the \(up ? "start" : "end") looks like"
            : ", which is as far as one scrollto goes - call it again if there is more"))
        return nil
    }
    Output.say("scrolled \(did) times and \"\(clip(to, 60))\" still is not there. It may be somewhere else, "
        + "or named something else - read the window")
    return nil
}

/* ОДНО ОКНО, ИЛИ ПРЯМОУГОЛЬНИК, ИЛИ ТО, ЧТО ВПЕРЕДИ.
 *
 * Область сообщается В ТЕХ КООРДИНАТАХ, В КОТОРЫХ ЕЁ ПРИСЛАЛИ: read_window отвечает в пикселях скриншота, и
 * снимок, отвечающий в экранных, заставил бы модель разговаривать двумя системами координат сразу.
 *
 * НЕ охраняется Own.refusal намеренно: снимок ничего не меняет, а сфотографировать терминал, в котором
 * что-то пошло не так, - разумное желание. */
func doCapture(_ fields: [String: String]) -> String? {
    guard #available(macOS 14.0, *) else {
        return "capturing a window needs macOS 14 or newer - the API this used before was removed"
    }
    Geometry.read(fields)

    let rx = Double(fields["x"] ?? "") ?? .nan
    let ry = Double(fields["y"] ?? "") ?? .nan
    let rw = Double(fields["w"] ?? "") ?? .nan
    let rh = Double(fields["h"] ?? "") ?? .nan
    let haveRegion = [rx, ry, rw, rh].allSatisfy { $0.isFinite }

    var image: CGImage?
    var what: String
    var size: String

    if haveRegion {
        if rw < 2 || rh < 2 { return "a region needs a width and height of at least 2 pixels" }
        what = "the region \(Geometry.shotSize(rw))x\(Geometry.shotSize(rh)) at "
            + "\(Geometry.shotX(rx)),\(Geometry.shotY(ry))"
        /* Размер один раз: область уже назвала свои размеры, и «the region 200x120 at 100,100, 200x120, to
         * …» читается как ошибка в предложении. */
        size = ""
        image = Screen.region(CGRect(x: rx, y: ry, width: rw, height: rh))
        if image == nil {
            return "could not photograph that region - macOS may not have granted Screen Recording, or the "
                + "rectangle is off every display"
        }
    } else {
        let title = fields["title"] ?? ""
        let process = fields["process"] ?? ""
        let info = (title.isEmpty && process.isEmpty)
            ? Windows.front()
            : Windows.matching(title: title, process: process)
        guard let info else {
            return (title.isEmpty && process.isEmpty)
                ? "nothing is in front to capture"
                : "no open window matches "
                    + (title.isEmpty ? "process \(process)" : "title \"\(title)\"")
                    + " - the list of open windows under the screenshot is what is actually there"
        }
        if info.minimized {
            return "\"\(info.title)\" is minimised or on another Space, and a window nobody can see has "
                + "nothing to draw - activate_window first, then capture it"
        }
        guard let got = Screen.window(pid: info.pid, titled: info.title) else {
            return "could not photograph \"\(info.title)\" - macOS has not granted Screen Recording to this "
                + "agent, or that window closed while it was being taken"
        }
        image = got.image
        what = "\"\(info.title)\""
        size = ", \(Geometry.shotSize(got.frame.width))x\(Geometry.shotSize(got.frame.height))"
    }

    guard let picture = image else { return "could not capture" }
    let written = Captures.write(picture)
    guard let path = written.path else { return "could not capture: \(written.problem ?? "unknown")" }
    let failed = Captures.toClipboard(picture)

    var said = "captured \(what)\(size), to \(path)"
    said += failed == nil
        ? " and onto the clipboard - paste it with Command+V"
        : ". It is NOT on the clipboard: \(failed!)"
    Output.say(said)
    return nil
}

/* АКТИВИРОВАТЬ, ПЕРЕЗАГРУЗИТЬ, ДОЖДАТЬСЯ. Смысл в ожидании: три хода модели в один.
 *
 * Cmd+R, а не F5: на macOS перезагрузка страницы - это Command+R, и F5 в браузере здесь не делает ничего. */
func doRefresh(_ fields: [String: String]) -> String? {
    let title = fields["title"] ?? ""
    let process = fields["process"] ?? ""
    if !title.isEmpty || !process.isEmpty {
        guard let wanted = Windows.matching(title: title, process: process) else {
            return "no open window matches "
                + (title.isEmpty ? "process \(process)" : "title \"\(title)\"")
        }
        if let mine = Own.refusal(pid: wanted.pid) { return mine }
        if let failed = Windows.activate(title: title, process: process) { return failed }
        Thread.sleep(forTimeInterval: 0.25)
    } else if let mine = Own.refusal(pid: Windows.front()?.pid ?? 0) {
        return mine
    }

    if let refused = Input.key("r", ctrl: true, shift: false, alt: false, cmd: false, rawCtrl: false,
                               win: false) {
        return refused
    }
    let outcome = settleHere(20000)
    Output.say("pressed Command+R and waited "
        + String(format: "%.1f", Double(outcome.waitedMs) / 1000) + "s"
        + (outcome.quiet
            ? " - the screen has stopped changing"
            : ", and it is still changing. Look, and wait again if it is not ready"))
    return nil
}

/* ЖДАТЬ ОКНА, а не экрана - это другой вопрос, и именно его и задают: «появился ли диалог сохранения»,
 * «ушёл ли сплэш».
 *
 * Альтернативой была хореография, которую пришлось изобретать провалившемуся прогону, - поспать двадцать
 * секунд и надеяться, - а фиксированный сон и слишком долог, когда работает, и слишком короток, когда нет. */
func doWaitWindow(_ fields: [String: String]) -> String? {
    let title = fields["title"] ?? ""
    let process = fields["process"] ?? ""
    if title.isEmpty && process.isEmpty { return "waitwindow needs a title or a process" }
    let wantGone = (fields["until"] ?? "appears").trimmingCharacters(in: .whitespaces).lowercased()
        == "disappears"
    var limitMs = Int(fields["ms"] ?? "") ?? 20000
    limitMs = max(500, min(120_000, limitMs))

    let started = Date()
    while true {
        let there = Windows.matching(title: title, process: process) != nil
        let waited = Int(Date().timeIntervalSince(started) * 1000)
        if there != wantGone {
            Output.say((wantGone ? "it was gone" : "it appeared") + " after "
                + String(format: "%.1f", Double(waited) / 1000) + "s")
            return nil
        }
        if waited >= limitMs {
            /* НЕ ошибка: «оно не появилось» - это ответ про мир, и модель, которой сказали, что действие
             * не удалось, стала бы искать неисправность в ожидании, а не в ожидаемом. */
            Output.say("waited " + String(format: "%.1f", Double(waited) / 1000) + "s and it "
                + (wantGone ? "is still there" : "has not appeared")
                + ". The window list under the screenshot is what is actually open")
            return nil
        }
        Thread.sleep(forTimeInterval: 0.25)
    }
}

/* НАЖАТЬ, ПРОВЕСТИ, ОТПУСТИТЬ - то, чего нельзя было составить из имеющегося: click посылает нажатие и
 * отпускание вместе, и ничто не посылало одно без другого.
 *
 * С промежуточными точками, а не прыжком: приложение, читающее перетаскивание, решает по движениям МЕЖДУ, и
 * нажатие с отпусканием в другом месте - не перетаскивание для списка, который хочет увидеть, как строка
 * едет. Двенадцать шагов - этого хватает и это не представление.
 *
 * .leftMouseDragged, а не .mouseMoved: на macOS движение с зажатой кнопкой - отдельный тип события, и
 * приложение, слушающее перетаскивание, движения другого типа не увидит вовсе. */
func doDrag(x: Double, y: Double, tx: Double, ty: Double, flags: CGEventFlags = []) -> String? {
    Input.press(x: x, y: y, down: true, flags: flags)
    Thread.sleep(forTimeInterval: 0.08)
    let steps = 12
    for i in 1...steps {
        let ix = x + (tx - x) * Double(i) / Double(steps)
        let iy = y + (ty - y) * Double(i) / Double(steps)
        Input.dragTo(x: ix, y: iy, flags: flags)
        Thread.sleep(forTimeInterval: 0.016)
    }
    Thread.sleep(forTimeInterval: 0.08)
    Input.press(x: tx, y: ty, down: false, flags: flags)
    /* Флаг защёлкивается в состоянии сессии - измерено, - поэтому закрытый жест его снимает. */
    if !flags.isEmpty { Input.releaseModifiers() }
    return nil
}

/* http и https ТОЛЬКО, и в этом вся история безопасности этого действия: оно отдаёт адрес тому, что машина
 * зарегистрировала для вебa, то есть браузеру. Схема - это ВЫБОР ПРОГРАММЫ (file:, x-apple-, и всё, что
 * зарегистрировало установленное приложение), так что принимать любую схему значило бы сделать это
 * действие «запусти что-нибудь», а для этого есть отдельное действие со своим сужением. Строка запроса
 * здесь остаётся: в ссылке она законная часть, в отличие от записи, потому что ничего не сохраняется. */
func doOpenUrl(_ url: String) -> String? {
    guard let parsed = URL(string: url), let scheme = parsed.scheme?.lowercased() else {
        return "that is not a full URL - it needs the scheme, as in https://docs.new"
    }
    if scheme != "http" && scheme != "https" {
        return "only http and https can be opened this way, and that is \(scheme): - a scheme chooses "
            + "which program handles it, which is a different question"
    }
    guard NSWorkspace.shared.open(parsed) else { return "macOS refused to open that link" }
    Output.say("opened \(parsed.absoluteString) in the default browser - it may take a moment to appear")
    return nil
}

/* ИМЯ, НИКОГДА НЕ КОМАНДНАЯ СТРОКА, и это различие - весь смысл формы.
 *
 * Аргументы - это то, что превращает «открой приложение» в «выполни это»: `osascript -e …` - это имя плюс
 * аргументы, и отказ от аргументов отказывает всему этому классу, не заводя списка опасных имён - списка,
 * который неверен в тот момент, когда кто-нибудь что-нибудь установит. Пути отказываются по той же причине:
 * путь - это способ назвать программу, которой нет в обычных местах, включая только что записанную на диск.
 *
 * ЧЕМ ЭТО НЕ ЯВЛЯЕТСЯ - границей безопасности, и делать вид, что является, было бы нечестной частью. Модель
 * и так может открыть терминал, щёлкнув по нему, и напечатать туда - именно это и произошло в прогоне, из
 * которого выросла эта волна. Линию держат границы промпта, смотрящий человек и отказ выше трогать
 * собственное окно агента. Это действие здесь для того, чтобы модель не импровизировала, и оно узкое,
 * чтобы импровизировать ЧЕРЕЗ него было не легче, чем мимо. */
func doOpenApp(_ app: String) -> String? {
    let name = app.trimmingCharacters(in: .whitespacesAndNewlines)
    if name.isEmpty || name.count > 80 { return "an application name, up to 80 characters" }
    if name.rangeOfCharacter(from: CharacterSet(charactersIn: "/\\:\"'|&<>%^;$`")) != nil {
        return "a NAME, not a path or a command line - \"Safari\", \"Terminal\", \"Google Chrome\". "
            + "For a web page use open_url instead"
    }
    /* Пробел законен в имени («Google Chrome») и он же - способ писать аргументы, так что по виду их не
     * различить. Ведущий дефис у любого слова - это то, как выглядит аргумент, и отказать ему можно, не
     * отказывая именам. */
    for word in name.split(separator: " ") where word.hasPrefix("-") || word.hasPrefix("+") {
        return "that looks like a command line rather than a name - this action opens an application and "
            + "cannot pass it arguments"
    }

    /* Найдено, а не запущено по имени: NSWorkspace.launchApplication(_:) снят с производства, а `open -a`
     * - это подпроцесс, то есть ровно та дверь, которую отказ от аргументов и закрывает. */
    var found: URL?
    if name.contains(".") {
        found = NSWorkspace.shared.urlForApplication(withBundleIdentifier: name)
    }
    if found == nil {
        let places = ["/Applications", "/System/Applications", "/System/Applications/Utilities",
                      "/Applications/Utilities",
                      NSHomeDirectory() + "/Applications"]
        let want = name.lowercased()
        outer: for place in places {
            guard let entries = try? FileManager.default.contentsOfDirectory(atPath: place) else { continue }
            for entry in entries where entry.lowercased() == want + ".app" {
                found = URL(fileURLWithPath: place + "/" + entry)
                break outer
            }
        }
    }
    guard let target = found else {
        return "no application called \"\(name)\" is installed where applications live. If it is already "
            + "running, activate_window reaches it by name"
    }

    NSWorkspace.shared.openApplication(at: target, configuration: NSWorkspace.OpenConfiguration())
    Output.say("asked macOS to open \(name) - it may take a few seconds to appear, and a fresh screenshot "
        + "is how to tell whether it did")
    return nil
}

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
         * first one would aim at "New" when the button says "New message".
         *
         * `app` is here for the same reason and was MISSING, which is not a cosmetic divergence: the Windows
         * parser has run `text`, `title` and `app` to the end of the line since 0.10.0, so `open app=Google
         * Chrome` arrived here as "Google" - an application nobody has - while `open app=Terminal -e
         * whoami` arrived as a bare "Terminal" and OPENED IT, walking straight past the refusal in
         * doOpenApp that exists to stop exactly that. Caught by running it. */
        if name == "text" || name == "title" || name == "name" || name == "app" {
            let rest = ([value] + tokens[(i + 1)...]).joined(separator: " ")
            out[name] = rest
            break
        }
        out[name] = value
        i += 1
    }
    return out
}

/* КАНАЛ ОТВЕТА: действие, которому есть что сказать, говорит это словами.
 *
 * До сих пор действие умело ответить только «ок» или ошибкой, и потому capture с clipread нечем было
 * ответить - снимок сделан, а куда он лёг, никто не узнает. Нового в протоколе при этом нет: деплой уже
 * передаёт модели любой `output`, отличный от "done" (resultBlocks в api/_step.mjs), - то есть это
 * используемый канал, а не добавляемый.
 *
 * СЛОВА СОБИРАЮТСЯ ЗДЕСЬ, А НЕ НА ДЕПЛОЕ, и это ровно та причина, по которой у Windows-агента то же самое
 * лежит в Say/TakeOutput: обе реализации обязаны говорить модели одно и то же, а сказать одно и то же
 * можно только одинаковыми предложениями.
 *
 * Сбрасывается в начале каждого действия: на этом пути в каждый момент идёт ровно одно действие (/do
 * отказывает, пока идёт повтор), и значение, оставшееся от прошлого, было бы отчётом об этом. Читается
 * один раз и очищается, чтобы не отчитаться дважды. */
enum Output {
    private static var text: String?
    private static let gate = NSLock()

    static func reset() { gate.lock(); text = nil; gate.unlock() }

    static func say(_ words: String) { gate.lock(); text = words; gate.unlock() }

    /// Read once and cleared, so it cannot be reported twice.
    static func take() -> String? {
        gate.lock()
        defer { gate.unlock() }
        let said = text
        text = nil
        return said
    }
}

func doAction(_ body: String) -> String? {
    /* РАМКА ЗАЖИГАЕТСЯ ЗДЕСЬ, А НЕ В МАРШРУТЕ /do, И ЭТО НЕ ПЕРЕСТАНОВКА.
     *
     * Сначала аренда стояла в маршруте, и этого было ровно на один вызов мало. У doAction три
     * вызывающих: ход прогона по цели (там уже держит `goal`), маршрут /do - и carry(), которая
     * выполняет действие из поля `activate` полученной работы ПЕРЕД тем, как начать повтор. Третий не
     * держал ничего: окно поднималось на передний план - SetForegroundWindow с настоящим прыжком окна, -
     * а рамки не было, и /health в эту секунду отвечал, что машину не ведёт никто. Аудит нашёл это на
     * Windows; здесь оказалось то же самое, потому что ошибка была не в платформе, а в том, ЧТО считать
     * началом действия. Начало действия - это doAction, единственное место, через которое проходят все
     * трое. Правило переехало туда, где оно одно.
     *
     * АРЕНДА, А НЕ УДЕРЖАНИЕ: у действия нет конца, о котором кто-то сообщит. Браузерный драйвер ведёт
     * прогон сам и агенту про его границы не рассказывает - агент видит /shot, /windows, до 75 секунд
     * тишины, пока думает модель, потом /do. Аренда длиной в ход сделала бы «горит» точным и «погасла»
     * ложным на минуту с четвертью после конца, а индикатор, который врёт ПОСЛЕ конца, хуже мигающего.
     *
     * ДО разбора и до выполнения: смысл рамки - гореть, пока машину трогают, а действие, отвергнутое
     * мгновением позже, всё равно было попыткой её тронуть. */
    Acting.touch()

    let fields = parseAction(body)
    let action = (fields["action"] ?? "").lowercased()
    Output.reset()
    if let refusal = Input.refusal(), action != "activate" { return refusal }

    /* ДЕЙСТВИЯ, ЦЕЛЯЩИЕСЯ В ФОКУС, ОХРАНЯЮТСЯ ПЕРВЫМИ, и по переднему окну, а не по точке: набор уходит
     * туда, где фокус, - ровно так нажатие, предназначенное форме, и попадает в терминал, где запущен
     * агент. */
    if action == "type" || action == "key" {
        if let mine = Own.refusal(pid: NSWorkspace.shared.frontmostApplication?.processIdentifier ?? 0) {
            return mine
        }
    }

    let x = Double(fields["x"] ?? "") ?? 0
    let y = Double(fields["y"] ?? "") ?? 0
    let needsPoint = ["click", "move", "scroll", "drag"].contains(action)
    if needsPoint && !Desktop.contains(x: x, y: y) {
        /* Refused rather than clamped: macOS would place the click at the nearest real coordinate, so an
         * out-of-bounds instruction would land on something and be reported as success. */
        let r = Desktop.rect
        return "\(Int(x)),\(Int(y)) is off the desktop "
            + "(\(Int(r.minX)),\(Int(r.minY)) to \(Int(r.maxX)),\(Int(r.maxY)))"
    }
    /* И ЦЕЛЯЩИЕСЯ В ТОЧКУ - когда точка уже проверена: «это за пределами экрана» - более полезный ответ
     * для координаты, которая за пределами экрана. */
    if needsPoint, let mine = Own.refusal(pid: Windows.at(x: x, y: y)?.pid ?? 0) { return mine }

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
        /* `mods` ЗДЕСЬ - ФИЗИЧЕСКИЕ КЛАВИШИ, и это сознательно не то же, что `ctrl=` у `action=key`, где
         * поле значит КОМАНДНЫЙ модификатор (Command здесь, Ctrl на Windows), потому что там речь о
         * сочетании клавиш. Control-клик и Command-клик - разные жесты: один открывает контекстное меню,
         * другой открывает ссылку в фоновой вкладке. Переносимого «командного» чтения для жеста не
         * существует, поэтому его тут и нет. То же значение и то же написание, что в записи. */
        Input.click(x: at.x, y: at.y, button: fields["button"] ?? "left",
                    double: (fields["double"] ?? "0") == "1",
                    flags: MouseFlowModFlags(fields["mods"]))
        return nil
    case "move":
        Input.move(x: x, y: y)
        return nil
    case "scroll":
        return Input.scroll(x: x, y: y, amount: Int(fields["amount"] ?? "") ?? -3,
                            dir: fields["dir"] ?? "", flags: MouseFlowModFlags(fields["mods"]))
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
                                       alt: false, cmd: false, rawCtrl: false, win: false) {
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
            rawCtrl: (fields["raw-ctrl"] ?? "0") == "1",
            win: (fields["win"] ?? "0") == "1"
        )
    case "activate":
        /* Отказано ДО того, как случится, а не после: вывести собственный терминал агента вперёд - это то,
         * как СЛЕДУЮЩЕЕ действие, целящееся в переднее окно, попадает в него. */
        if let wanted = Windows.matching(title: fields["title"] ?? "", process: fields["process"] ?? ""),
           let mine = Own.refusal(pid: wanted.pid) {
            return mine
        }
        return Windows.activate(title: fields["title"], process: fields["process"])

    // ---------------------------------------------------------------- 0.10.0: reading back

    case "clipread":
        guard let had = NSPasteboard.general.string(forType: .string), !had.isEmpty else {
            Output.say("the clipboard holds no text")
            return nil
        }
        /* Обрезано там, где ЧИТАЕТСЯ, а не там, где показывается: деплой всё равно режет вывод действия на
         * 2000 символах, и гонять 40МБ буфера через loopback, чтобы их выбросить, - работа, которой никто
         * не просил. Сказано вслух, потому что молча ополовиненное значение, которое модель потом куда-то
         * впечатает, хуже, чем никакого. */
        if had.count > 4000 {
            Output.say("the clipboard holds \(had.count) characters; the first 4000 are: "
                + String(had.prefix(4000)))
            return nil
        }
        Output.say("the clipboard holds: " + had)
        return nil

    case "clipwrite":
        var put = fields["text"] ?? ""
        if (fields["enc"] ?? "") == "b64" {
            guard let data = Data(base64Encoded: put), let decoded = String(data: data, encoding: .utf8) else {
                return "that text is not base64 UTF-8"
            }
            put = decoded
        }
        if put.isEmpty { return "nothing to put on the clipboard" }
        NSPasteboard.general.clearContents()
        guard NSPasteboard.general.setString(put, forType: .string) else {
            return "macOS refused the clipboard"
        }
        Output.say("put \(put.count) characters on the clipboard")
        return nil

    case "capture":
        return doCapture(fields)

    case "open":
        let url = fields["url"] ?? ""
        let app = fields["app"] ?? ""
        if !url.isEmpty { return doOpenUrl(url) }
        if !app.isEmpty { return doOpenApp(app) }
        return "open needs a url or an app name"

    // ---------------------------------------------------------------- 0.11.0: aiming by name

    case "read":
        return doRead(fields)
    case "find":
        return doFind(fields)
    case "scrollto":
        return doScrollTo(fields)
    case "drag":
        let tx = Double(fields["tx"] ?? "") ?? .nan
        let ty = Double(fields["ty"] ?? "") ?? .nan
        guard tx.isFinite, ty.isFinite else { return "drag needs tx and ty - where to let go" }
        if !Desktop.contains(x: tx, y: ty) {
            let r = Desktop.rect
            return "\(Int(tx)),\(Int(ty)) is off the desktop "
                + "(\(Int(r.minX)),\(Int(r.minY)) to \(Int(r.maxX)),\(Int(r.maxY)))"
        }
        if let mine = Own.refusal(pid: Windows.at(x: tx, y: ty)?.pid ?? 0) { return mine }
        return doDrag(x: x, y: y, tx: tx, ty: ty, flags: MouseFlowModFlags(fields["mods"]))

    // ---------------------------------------------------------------- 0.12.0

    case "refresh":
        return doRefresh(fields)
    case "waitwindow":
        return doWaitWindow(fields)
    /* Отказов по имени здесь больше нет, и это то, ради чего волна писалась: десять действий, которые
     * назывались «пока не сделано на macOS», сделаны. Отказ, оставленный при живой реализации, отвергал бы
     * рабочее действие - поэтому убирается вместе с ней, а не отдельным заходом. */
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
    /* Модификаторы жеста, как записаны: `Shift`, `Cmd+Shift`, `Alt`. Сырая строка хранится ВМЕСТЕ с
     * разобранными флагами, чтобы значение переживало круговой путь нетронутым, как все прочие ключи. */
    var mods: String?

    /* ГДЕ ЭТО БЫЛО, когда сказать ЧТО не получилось - подпись ближайшего элемента УПРАВЛЕНИЯ и сторона.
     *
     * Заполняется только у шага без имени. Измерено на Windows, но верно и здесь по той же причине: в
     * веб-приложении под курсором безымянная группа, а единственное названное, СОДЕРЖАЩЕЕ точку, - элемент
     * с абзацем, который человек читает. Искать имя усерднее значит записывать содержимое. */
    var near: String?
    var side: String?

    /* ЗДЕСЬ `Ctrl` ЗНАЧИТ КЛАВИШУ CONTROL, а не «командный модификатор», и это сознательное расхождение с
     * путём `Key <аккорд>`, где Input.key сворачивает `ctrl` в Command - там грамматика писалась на Windows,
     * и `ctrl=1 key=c` значит «копировать».
     *
     * Здесь запись говорит, что человек ФИЗИЧЕСКИ держал. Control-клик на маке открывает контекстное меню;
     * повторить его как Cmd-клик значит сделать другой жест и отчитаться о чистом прогоне. Это самый
     * вероятный способ ошибиться в этой правке, поэтому написано здесь, а не подразумевается.
     *
     * Известная цена, названная вслух: запись Ctrl-клика, сделанная на Windows (там это множественный
     * выбор), воспроизведётся на маке как Control-клик, то есть контекстное меню. Верного перевода без
     * знания платформы записи не существует, а тело записи её не несёт. Дешёвое будущее решение - токен
     * платформы в заголовке `#part`; в эту волну он не входит. */
    /* Разбор живёт в modFlags(_:) - там же, где его читает грамматика действий. Раньше он был здесь, и
     * пока читатель был один, это было верно; со вторым читателем копия стала бы расхождением. */
    var modFlags: CGEventFlags { return MouseFlowModFlags(mods) }
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
    /* Модификаторы, которые несёт СЕЙЧАС ОТКРЫТОЕ нажатие - от press до его release.
     *
     * Записан модификатор только на нажатии и на прокрутке (см. PROTOCOL.md: у перетаскивания движения
     * между press и release своего `#ctx` не несут), так что отпускание и движения берут его отсюда. Иначе
     * Option-перетаскивание было бы Option-нажатием и обычным перетаскиванием - в Finder это разница между
     * копированием и перемещением, и обнаружилась бы она на чужих файлах. */
    private var gestureMods: CGEventFlags = []
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

        /* Повтор начинается с чистого состояния - по той же причине, что и запись. Залипший модификатор
         * превращает первый же клик повтора в Cmd-клик, а «Key Enter» - в Cmd+Enter, и повтор при этом
         * отчитается о безупречном прогоне: он делал ровно то, что записано, а система прочла другое. */
        Input.releaseModifiers()

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
                    if parts[0] == "mods" { ctx.mods = value }
                    /* Читается, но повтором НЕ используется: ориентир говорит, где это было, а не куда
                     * жать. Прицел работает по `control`. */
                    if parts[0] == "side" { ctx.side = value }
                    if parts[0] == "near" { ctx.near = value }
                }
                /* И `mods` держит строку живой. Без этой половины получается функция, которая работает для
                 * названных элементов и молча не работает везде остальном - то есть форма, проходящая
                 * демонстрацию: Cmd+прокрутка имени не несёт никогда. */
                pending = (ctx.control == nil && ctx.type == nil && ctx.mods == nil
                           && ctx.near == nil) ? nil : ctx
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
        /* Рамка - по тем же путям выхода и по той же причине: индикатор «вами управляют», который остался
         * гореть после того, как управление кончилось, врёт ровно в ту сторону, в которую индикатору врать
         * нельзя. begin здесь, а не в start(body:), потому что здесь есть defer, покрывающий все выходы. */
        Acting.begin(.replay)
        /* Released on EVERY exit path, including the failure paths: a replay that dies holding the left
         * mouse button leaves the machine unusable, and that is not a hypothetical - it is why the protocol
         * says so twice. */
        defer {
            releaseEverything()
            Acting.end(.replay)
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

        /* МОДИФИКАТОРЫ ЖЕСТА, и берутся они по-разному у трёх видов событий.
         *
         * Нажатие и прокрутка несут свои: у них есть собственный `#ctx`. Отпускание и движения между
         * press и release своего не несут по устройству формата - они берут то, что открыло жест. Иначе
         * Option-перетаскивание распалось бы на Option-нажатие и обычное перетаскивание, а в Finder это
         * разница между копированием и перемещением. */
        let carried = event.ctx?.modFlags ?? []
        if event.action.hasSuffix("Click Down") { gate.lock(); gestureMods = carried; gate.unlock() }
        let mods: CGEventFlags = {
            if event.action.hasSuffix("Click Down") { return carried }
            if event.action.hasPrefix("Scroll") { return carried }
            gate.lock(); defer { gate.unlock() }
            return gestureMods
        }()

        switch event.action {
        case "Mouse Movement":
            Input.move(x: x, y: y, flags: mods)
        case "Left Click Down":
            hold("left"); post(.leftMouseDown, x, y, .left, flags: mods)
        case "Left Click Release":
            release("left"); post(.leftMouseUp, x, y, .left, flags: mods)
        case "Right Click Down":
            hold("right"); post(.rightMouseDown, x, y, .right, flags: mods)
        case "Right Click Release":
            release("right"); post(.rightMouseUp, x, y, .right, flags: mods)
        case "Middle Click Down":
            hold("middle"); post(.otherMouseDown, x, y, .center, flags: mods)
        case "Middle Click Release":
            release("middle"); post(.otherMouseUp, x, y, .center, flags: mods)
        case "Scroll Up":
            _ = Input.scroll(x: x, y: y, amount: 3, dir: "up", flags: mods)
        case "Scroll Down":
            _ = Input.scroll(x: x, y: y, amount: 3, dir: "down", flags: mods)
        /* Названы здесь, иначе боковая прокрутка человека уходит в default и считается непроигрываемой.
         * Транскрипт разбирает эти два слова с самого начала - читающая сторона давно готова. */
        case "Scroll Left":
            _ = Input.scroll(x: x, y: y, amount: 3, dir: "left", flags: mods)
        case "Scroll Right":
            _ = Input.scroll(x: x, y: y, amount: 3, dir: "right", flags: mods)

        /* Named here rather than dropped through the default, exactly as on Windows.
         *
         * A keystroke has no key in it - by design, see the protocol - and a Focus is a note, not an action.
         * Both are counted and reported as `unplayable`, because a replay that pressed nothing for the two
         * minutes somebody spent typing must not come back looking like a clean run. The pause before each
         * one is still waited out, so the replay keeps the shape of the original. */
        case "Key Down", "Focus":
            gate.lock(); unplayable += 1; gate.unlock()

        default:
            /* A key recorded BY NAME - "Key Enter", "Key Cmd+S" - is played. Anonymous typing is not, and
             * cannot be: the case above catches "Key Down" FIRST, which matters more than it looks. Parsed
             * naively, that legacy action reads as a key called "Down" and a replay of somebody typing
             * would press the down arrow once per keystroke. Order is the guard, and the guard is tested. */
            if event.action.hasPrefix("Key "), event.action != "Key Down" {
                let spec = String(event.action.dropFirst(4))
                var parts = spec.split(separator: "+").map(String.init)
                let name = parts.popLast() ?? ""
                let mods = Set(parts.map { $0.lowercased() })
                /* `win` read here too: a chord recorded on Windows from 0.12.0 can name it, and replaying
                 * the remainder of a chord is replaying a different chord. It is refused on this platform
                 * rather than mapped - see NO_SUCH_KEY_HERE - and a refusal is counted, not guessed at. */
                if Input.key(name, ctrl: mods.contains("ctrl"), shift: mods.contains("shift"),
                             alt: mods.contains("alt"), cmd: mods.contains("cmd"), rawCtrl: false,
                             win: mods.contains("win")) == nil {
                    break
                }
                /* Input.key refused the name - an agent from a later build naming a key this one does not
                 * know. Counted, not guessed at. */
                gate.lock(); unplayable += 1; gate.unlock()
                break
            }
            gate.lock(); unplayable += 1; gate.unlock()
        }

        /* И ОТПУСТИТЬ ИХ, КОГДА ЖЕСТ ЗАКРЫЛСЯ.
         *
         * Флагов на событии достаточно, чтобы приложение увидело модификатор, - это измерено. Измерено и
         * второе: событие, посланное с флагом, ЗАЛИПАЕТ в состоянии сессии ровно так же, как аккорд на
         * клавиатуре, и `flagsState` продолжает возвращать Alt, пока его не отпустят. Оставить так - значит
         * отдать следующему клику повтора чужой модификатор, а человеку за клавиатурой - зажатый Option.
         *
         * Только когда жест что-то держал: отпускание на каждом клике стоило бы четырёх лишних событий на
         * каждый шаг ни за чем. */
        if !mods.isEmpty && event.action.hasSuffix("Click Release") { Input.releaseModifiers() }
        if !mods.isEmpty && event.action.hasPrefix("Scroll") { Input.releaseModifiers() }

        return true
    }

    private func post(_ type: CGEventType, _ x: Double, _ y: Double, _ button: CGMouseButton,
                      flags: CGEventFlags = []) {
        guard let source = CGEventSource(stateID: .hidSystemState) else { return }
        guard let event = CGEvent(mouseEventSource: source, mouseType: type,
                                 mouseCursorPosition: CGPoint(x: x, y: y), mouseButton: button) else { return }
        /* Пустые флаги ЯВНО, ровно как в Input.send и по той же причине: событие из `.hidSystemState` без
         * флагов забирает состояние системы, а повтор, в котором есть аккорд, оставляет это состояние
         * зажатым - и следующий клик повтора становится Cmd-кликом. Здесь у повтора своя копия отправки,
         * так что правило приходится повторить; тест держит обе половины вместе.
         *
         * И ФЛАГОВ ДОСТАТОЧНО, чтобы жест стал модифицированным - это измерено на живой машине, а не
         * выведено: окно, сообщавшее, что видит, показало `NSEvent.modifierFlags = Alt` для события,
         * посланного ТОЛЬКО с флагами, ровно так же, как для события с физически зажатой клавишей. Держать
         * клавишу не нужно. См. releaseEverything о том, почему после жеста всё равно нужно отпускать. */
        event.flags = flags
        event.setIntegerValueField(.eventSourceUserData, value: INJECTED_MARK)
        event.post(tap: .cghidEventTap)
    }

    private func hold(_ name: String) { gate.lock(); down.insert(name); gate.unlock() }
    /// Возвращает, закрылся ли жест этим отпусканием - вызывающий по этому решает, пора ли отпускать
    /// модификаторы.
    @discardableResult
    private func release(_ name: String) -> Bool {
        gate.lock()
        down.remove(name)
        /* Жест закрыт - модификаторы больше не его. Держать их дальше значило бы отдать следующему клику
         * чужой Option. */
        let closed = down.isEmpty
        if closed { gestureMods = [] }
        gate.unlock()
        return closed
    }

    private func releaseEverything() {
        /* И МОДИФИКАТОРЫ ТОЖЕ - ВЫШЕ проверки на зажатые кнопки мыши, а не после неё.
         *
         * Повтор, последним действием которого был аккорд («Key Cmd+S» - обычный конец записи), кнопок мыши
         * не держит: `holding` пуст, и всё, что стоит ниже guard, в этом случае мёртвый код - то есть ровно
         * в том случае, ради которого это и пишется. Ошибка, которую легко сделать и невозможно заметить:
         * повтор выглядел бы убирающим за собой и не убирал бы. */
        Input.releaseModifiers()

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
        Recorder.shared.capture(action: "Left Click Down", x: x, y: y, mods: chordName(event.flags))
    case .leftMouseUp:
        Recorder.shared.capture(action: "Left Click Release", x: x, y: y)
    case .rightMouseDown:
        Recorder.shared.capture(action: "Right Click Down", x: x, y: y, mods: chordName(event.flags))
    case .rightMouseUp:
        Recorder.shared.capture(action: "Right Click Release", x: x, y: y)
    case .otherMouseDown:
        Recorder.shared.capture(action: "Middle Click Down", x: x, y: y, mods: chordName(event.flags))
    case .otherMouseUp:
        Recorder.shared.capture(action: "Middle Click Release", x: x, y: y)
    case .scrollWheel:
        /* ОБЕ ОСИ. Ось 1 - вертикаль, ось 2 - горизонталь, и до сих пор читалась только первая: боковая
         * прокрутка записывалась как "Scroll Up" с нулевой дельтой, то есть как движение не в ту сторону.
         * Ось выбирается по тому, где больше движения, потому что трекпад даёт обе сразу. */
        let up = event.getIntegerValueField(.scrollWheelEventDeltaAxis1)
        let side = event.getIntegerValueField(.scrollWheelEventDeltaAxis2)
        /* У прокрутки свой `mods`, потому что пары у неё нет: повтор держит модификатор от нажатия до
         * отпускания, а прокрутке держать не от чего. */
        let wheelMods = chordName(event.flags)
        if side != 0 && abs(side) >= abs(up) {
            Recorder.shared.capture(action: Sideways.name(delta: side), x: x, y: y, mods: wheelMods)
        } else {
            Recorder.shared.capture(action: up >= 0 ? "Scroll Up" : "Scroll Down", x: x, y: y,
                                    mods: wheelMods)
        }
    case .keyDown:
        /* Two paths, and which one a key takes is decided by whether it can spell anything.
         *
         * One difference from Windows worth naming: a bare modifier arrives as .flagsChanged, not .keyDown,
         * and is not subscribed to here - so holding Shift alone is not counted as typing, where on Windows
         * it is. Both answers are defensible and the transcript only reads density and duration, so the
         * cheaper one wins. */
        let code = event.getIntegerValueField(.keyboardEventKeycode)
        let flags = event.flags
        let commanded = flags.contains(.maskCommand) || flags.contains(.maskControl)
        if let named = NAMED_KEYS[code] {
            Recorder.shared.captureNamedKey(chordPrefix(flags) + named)
        } else if commanded, let letter = commandLetter(event) {
            /* Read ONLY under Command or Control. A chord is an instruction to the application - Save,
             * Copy, Send - and nobody types a password holding Command. Without the modifier this branch is
             * never reached and the key stays anonymous. */
            Recorder.shared.captureNamedKey(chordPrefix(flags) + letter)
        } else {
            Recorder.shared.captureKey()
        }
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

/* Falling over where nobody is looking.
 *
 * This agent runs under launchd on somebody else's Mac. When it breaks, what happens today is a line in
 * ~/Library/Logs/mouseflow-agent.log, which is a file nobody opens until they are already asking why
 * nothing works. The deployment and the browser have had crash reporting for a while; the two programs
 * that actually touch the mouse were the blind half.
 *
 * IT REPORTS THROUGH THE ACCOUNT, not to Sentry directly. This agent already dials the deployment with a
 * device token, so ?worker=crash needs no DSN of its own - one less secret inside a program people
 * download - and what arrives is already attached to an account and to this build. The cost is real and
 * worth saying: a failure whose cause is "cannot reach the deployment" cannot travel this way, and stays
 * in the log where it always was.
 *
 * ONCE PER PROCESS PER THING. A hook that will not install fails every time it is tried, and a reporter
 * that says so every time is a reporter somebody mutes. The first one is the useful one.
 *
 * NEVER BLOCKS AND NEVER THROWS. Something has just gone wrong; a reporter that made the caller wait, or
 * that failed on top of the failure, would be worse than none.
 */
enum Crash {
    private static let gate = NSLock()
    private static var told = Set<String>()

    /// The home directory out of a backtrace. It carries the user's account name and says nothing useful.
    private static func tidy(_ line: String) -> String {
        let home = FileManager.default.homeDirectoryForCurrentUser.path
        return home.isEmpty ? line : line.replacingOccurrences(of: home, with: "~")
    }

    /* The same event, sent and WAITED FOR, for /crash-test only.
     *
     * Fire-and-forget is right for a real fault and useless for a test: the whole question a test asks is
     * whether the thing arrived, and the deployment's answer carries `reported` - which is true only when
     * Sentry itself took it. Without this, checking the pipe means somebody opening a dashboard and
     * deciding how long to keep refreshing. */
    static func test() -> Bool {
        guard let link = Account.link, let url = URL(string: link.base + "/api/mcp?worker=crash"),
              let data = try? JSONSerialization.data(withJSONObject: [
                  "type": "AgentError",
                  "message": "crash reporting test from this Mac",
                  "where": "crash-test",
                  "level": "warning",
                  "platform": "macos",
                  "version": VERSION,
              ]) else { return false }

        var req = URLRequest(url: url)
        req.httpMethod = "POST"
        req.setValue("Bearer " + link.token, forHTTPHeaderField: "Authorization")
        req.setValue("application/json", forHTTPHeaderField: "Content-Type")
        req.httpBody = data
        req.timeoutInterval = 15

        let done = DispatchSemaphore(value: 0)
        var reported = false
        URLSession.shared.dataTask(with: req) { body, response, _ in
            if let http = response as? HTTPURLResponse, http.statusCode == 200, let body = body,
               let raw = (try? JSONSerialization.jsonObject(with: body)) as? [String: Any] {
                reported = raw["reported"] as? Bool == true
            }
            done.signal()
        }.resume()
        _ = done.wait(timeout: .now() + 20)
        return reported
    }

    static func say(_ message: String, at where_: String, level: String = "error", trace: Bool = true) {
        /* Not linked: there is nowhere to send it and nobody to attach it to. The log still has it.
         *
         * И НЕ БЕРЁТ РАБОТУ - тоже молчит. Раньше здесь стояла проверка только на привязку, а меню и
         * документация говорят про этот переключатель буквально: «Off. Nothing leaves this Mac» и «off, it
         * makes no outbound call at all». Опрос очереди действительно останавливался - Courier `taking`
         * проверяет, - а репортер крашей нет, и предложение было неправдой ровно настолько, насколько его
         * и читают: как обещание, что выключатель означает тишину.
         *
         * Цена известна и принята: краш привязанного, но неработающего агента до нас не доедет. Обещание,
         * данное человеку про его собственную машину, стоит дороже телеметрии - тем более что в логе агента
         * и в его меню этот краш по-прежнему есть. */
        guard let link = Account.link, link.taking,
              let url = URL(string: link.base + "/api/mcp?worker=crash") else { return }

        let key = where_ + "|" + message
        gate.lock()
        let first = told.insert(key).inserted
        gate.unlock()
        guard first else { return }

        let stack = trace
            ? Thread.callStackSymbols.prefix(12).map(tidy).joined(separator: "\n")
            : ""
        var said: [String: Any] = [
            "type": "AgentError",
            "message": message,
            "where": where_,
            "level": level,
            "platform": "macos",
            "version": VERSION,
        ]
        if !stack.isEmpty { said["stack"] = stack }
        guard let data = try? JSONSerialization.data(withJSONObject: said) else { return }

        var req = URLRequest(url: url)
        req.httpMethod = "POST"
        req.setValue("Bearer " + link.token, forHTTPHeaderField: "Authorization")
        req.setValue("application/json", forHTTPHeaderField: "Content-Type")
        req.httpBody = data
        req.timeoutInterval = 10
        /* Fire and forget, off whatever thread noticed. Nothing waits for this and nothing reads the answer:
         * there is no useful thing to do about a crash report that did not arrive. */
        URLSession.shared.dataTask(with: req) { _, _, _ in }.resume()
    }
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
    /* Nothing held open: the endpoint answers whether it has work and this end sleeps instead.
     *
     * A held request is billed for its whole length, so what counts is function time over wall time. Holding
     * 25 seconds against a ten-second function ceiling meant every idle poll was cut in flight - about 50
     * function-seconds a wall minute, and a log line calling each cut a failure to reach the account.
     * Shortening the hold to 6 would have made it 60, because the only rest in that loop came from the
     * failure path's sleep. A claim with no wait answers in about four tenths of a second; with three
     * seconds between asks that is nearer 7. The cost is up to three seconds before a queued job is picked
     * up, once per run. */
    private static let claimWaitSeconds = 0
    private static let idleSleepSeconds: UInt32 = 3
    private static var backoff: UInt32 = 2

    enum Claimed {
        case job(Job)
        case idle
        /* The answer started and stopped: headers, then nothing. A hosting limit cutting a long poll, not an
         * account that cannot be reached - and worth its own case, because the two want opposite responses.
         * A refusal should back off; this should simply ask again. */
        case cut
        case failed(String)
    }

    struct Job {
        var id: String
        var command: String?
        /// A replay body, built by the deployment for a skill. The agent never has to know what a skill is.
        var body: String?
        /// `action=activate ...`, for the window the recording belongs to. Best effort, exactly as the app does it.
        var activate: String?
        /* Whether this one needs a model in the loop. A recorded skill is a body to replay; a created one is
         * a goal, and a goal is decided one action at a time by something that is not on this machine. */
        var goal: Bool
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
                /* Only once it has stopped being a hiccup. At the top of the backoff this machine has been
                 * unable to reach its account for minutes, which is worth a report - and if the cause is the
                 * network rather than the account, the report will not get out either, which is honest. */
                if backoff >= 60 { Crash.say("cannot ask the account for work: \(why)", at: "courier.claim") }
                sleep(backoff)
                backoff = min(60, backoff * 2)
            case .cut:
                /* Asked again, promptly, and NOT backed off: an idle machine should not become slower to pick
                 * up work because the thing serving the poll has a time limit. Nor is it a crash report. */
                log("the account's answer was cut off mid-reply - asking again")
                sleep(1)
            case .idle:
                backoff = 2
                // Nothing to do. The sleep is the whole saving - see the note on claimWaitSeconds.
                sleep(idleSleepSeconds)
            case .job(let job):
                backoff = 2
                /* A goal is not carried, it is driven: the deployment decides one action at a time and this
                 * end does them. It also closes the job itself, at the step that finishes - so there is
                 * nothing to report here, and reporting would only overwrite what it said. */
                if job.goal {
                    drive(link, id: job.id)
                } else {
                    let done = carry(job)
                    report(link, id: job.id, done: done)
                }
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
        /* `steps: true` is what makes a goal skill claimable here at all. The queue asks the claimer what
         * it can do rather than assuming, for the reason written at that end: an agent is a compiled binary
         * somebody has to reinstall, so one that predates this goes on not being given goals instead of
         * taking one and answering that it does not understand. */
        let ask: [String: Any] = ["worker": Host.current().localizedName ?? "this Mac",
                                  "kind": "agent",
                                  "steps": true,
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
        /* Parsed ONCE, and a 200 whose body will not parse is an answer that started and stopped - the reply
         * was on its way. It used to come back as `.failed("HTTP 200")`, which reads as the account refusing
         * to answer and sent people to reinstall the agent. */
        let parsed = try? JSONSerialization.jsonObject(with: data)
        if status == 200 && parsed == nil { return .cut }
        guard status == 200, let raw = parsed as? [String: Any] else {
            return .failed("HTTP \(status)")
        }
        guard let job = raw["job"] as? [String: Any], let id = job["id"] as? String else { return .idle }
        let args = (job["args"] as? [String: Any]) ?? [:]
        return .job(Job(id: id,
                        command: job["command"] as? String,
                        body: job["body"] as? String,
                        activate: job["activate"] as? String,
                        goal: job["goal"] as? Bool == true,
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

    /* ------------------------------------------------------------------ carrying out a goal

       A goal skill is a sentence somebody wrote, carried out by a model that looks at the screen and
       chooses one action at a time. Until now that loop had to run on this machine, in a separate node
       process the user installed alongside this agent, for one reason: it talked to 127.0.0.1. Nothing
       else about it was local - the model call always went out over the network.

       So it moved, and this end became the hands:

           this  ──POST ?worker=step { shot, windows, results }──►  the deployment decides
           this  ◄──────────  { actions: [...] }  ──────────────
                 does them, takes a new picture, posts again

       One request per step. Nothing reconnects between steps because there is no gap between them: the
       reply to one step is what produces the next. The decision takes several seconds, which is why the
       request is allowed to be slow - it is the model thinking, not a stall.

       WHAT THIS END NEVER DECIDES: what to do. It reports what it sees and does what it is told, and the
       one judgement it makes is refusing to start while something else is driving the mouse. */

    private static let stepFirstWidth = 1280
    private static let settlePollMs = 1500
    private static let settleQuietFrames = 2
    /* Every third screen look, so a cancellation lands inside four and a half seconds of a wait that may
     * run for two minutes. Anything asked for while this end sits still is worth one small request. */
    private static let stopEveryPolls = 3

    private static func drive(_ link: Account.Link, id: String) {
        guard let url = URL(string: link.base + "/api/mcp?worker=step") else { return }
        /* ЕДИНСТВЕННЫЙ ПУТЬ, У КОТОРОГО ЕСТЬ ТОЧНЫЕ ГРАНИЦЫ, и поэтому единственный, где рамка горит
         * ровно весь прогон. Курьер знает и начало (работа взята), и конец (эта функция вернулась) - а
         * возвращается она из восьми мест, так что defer, а не парный вызов в конце. */
        Acting.begin(.goal)
        defer { Acting.end(.goal) }
        var width = stepFirstWidth
        var results: [String] = []

        while true {
            /* One mouse. A replay started from the app while this is running would fight it for the
               pointer, and the run is the thing that can be resumed - so this one gives way and says so. */
            if Replayer.shared.isPlaying {
                report(link, id: id, done: Done(ok: false, said: "This Mac started replaying something "
                    + "else while the goal was running, so the run was stopped.", body: nil))
                return
            }
            guard Account.link != nil else { return }   // unpaired mid-run: there is nowhere to report to

            let shot = Screen.shot(want: width)
            let windows = Windows.list().prefix(24).map { w in
                "{\"title\":\(jsonString(w.title)),\"process\":\(jsonString(w.process))"
                    + ",\"active\":\(jsonBool(w.active)),\"minimized\":\(jsonBool(w.minimized))}"
            }.joined(separator: ",")

            let body = "{\"id\":\(jsonString(id)),\"shot\":\(shot),\"windows\":[\(windows)]"
                + ",\"results\":[\(results.joined(separator: ","))]}"
            guard let data = body.data(using: .utf8) else { return }

            /* One retry, and only for the failures that pass.
             *
             * A run is minutes long and a deployment can be swapped under it - that is a few seconds of
             * 5xx, and losing a half-finished run to it is a poor trade for one extra request. A 4xx is
             * different: a revoked token or a refused body will say the same thing twice. */
            var status = 0
            var answer = Data()
            for attempt in 0..<2 {
                if let (got, payload) = request(url, token: link.token, body: data) {
                    status = got
                    answer = payload
                } else {
                    status = 0
                }
                if status == 200 { break }
                if attempt == 0 && (status == 0 || status >= 500) {
                    log("a step of the goal run did not land (HTTP \(status)); one more try")
                    Thread.sleep(forTimeInterval: 2)
                    continue
                }
                break
            }

            guard status == 200,
                  let raw = (try? JSONSerialization.jsonObject(with: answer)) as? [String: Any] else {
                log("the goal run was refused: HTTP \(status)")
                Crash.say("a goal step was refused: HTTP \(status)", at: "courier.step")
                report(link, id: id, done: Done(ok: false, said: status == 0
                    ? "This Mac lost contact with the account part-way through the run."
                    : "The account refused a step of this run (HTTP \(status)).", body: nil))
                return
            }

            /* Over, one way or another - finished, cancelled, or the job is gone. The deployment has
               already written the outcome; saying anything here would only overwrite it. */
            if raw["done"] as? Bool == true { return }

            /* Too large to send. Not a failure and not a step: take a smaller picture and ask again with
               no results, because nothing was done. */
            if let smaller = raw["shrink"] as? Int {
                width = max(320, smaller)
                results = []
                continue
            }

            let actions = (raw["actions"] as? [[String: Any]]) ?? []
            var out: [String] = []
            for action in actions {
                out.append(perform(action, link: link, id: id))
                /* A stop that arrived while this was waiting. The rest of the turn is abandoned and the
                 * results so far are posted anyway: the deployment answers "done", writes the run to the
                 * account and clears the row, which is tidier than this end deciding any of that. */
                if stopSeen { break }
            }
            results = out
            if stopSeen { stopSeen = false }
        }
    }

    /* Whether a stop arrived while this end was busy. Set by the wait, read by the driver: a wait can last
     * two minutes, and "cancelled" has to mean something inside that. */
    private static var stopSeen = false

    /// One instruction from the deployment, and what to say came of it.
    private static func perform(_ action: [String: Any], link: Account.Link, id job: String) -> String {
        let id = (action["id"] as? String) ?? ""
        if (action["kind"] as? String) == "wait" {
            let ms = min(120_000, max(200, (action["ms"] as? Int) ?? 2000))
            let outcome = settle(ms) { cancelled(link, id: job) }
            /* Numbers, not a sentence. What the model is told about a wait is one of the things both ends
               have to say identically, so the wording is composed at the deployment from these. */
            return "{\"id\":\(jsonString(id)),\"quiet\":\(jsonBool(outcome.quiet))"
                + ",\"waited\":\(outcome.waited),\"quietFor\":\(outcome.quietFor)}"
        }

        let line = (action["body"] as? String) ?? ""
        if line.isEmpty {
            return "{\"id\":\(jsonString(id)),\"isError\":true,\"output\":\"nothing to do\"}"
        }
        /* The screen BEFORE, so the answer can say whether the action did anything.
           The fingerprint is the same 64x36 the wait uses and costs about thirty milliseconds. */
        let before = Screen.grid()

        if let bad = doAction(line) {
            return "{\"id\":\(jsonString(id)),\"isError\":true,\"output\":\(jsonString(bad))}"
        }
        /* A moment for the screen to react before the next picture, or it shows the state before this. The
           same 350ms the app's own loop leaves - and the comparison has to happen after it, or every action
           is compared before the screen has had a chance to react and all of them look inert. */
        Thread.sleep(forTimeInterval: 0.35)

        /* A FACT, never a sentence. What the model is told is composed at the deployment, exactly as it is
           for a wait - two agents phrasing this differently would teach it two different habits. Absent
           when either fingerprint could not be taken: "could not tell" is not "did not move". */
        var stirred = "null"
        if let a = before, let b = Screen.grid() { stirred = jsonBool(self.stirred(a, b)) }
        /* "done", если действию нечего сказать. Всё остальное деплой передаёт модели как есть
           (resultBlocks в api/_step.mjs) - поэтому здесь не нужно ни нового поля, ни новой формы: канал
           был на месте и был пуст. */
        let told = Output.take()
        return "{\"id\":\(jsonString(id)),\"output\":\(jsonString(told ?? "done")),"
            + "\"moved\":\(stirred)}"
    }

    /* Waiting, done here rather than by asking the model to look again.
     *
     * A wait used to cost a screenshot and a decision, so waiting for a page to load burned the budget the
     * run needed to finish it. The 64x36 fingerprint is 3KB and costs nothing, and the numbers below are
     * the ones the app's own loop uses - 1.5s between looks, two still frames, a mean difference of 3 out
     * of 255 being the line between dither and movement. They agree on purpose. */
    private static func settle(_ limitMs: Int,
                              stopped: () -> Bool = { false }) -> (quiet: Bool, waited: Int, quietFor: Int) {
        let started = Date()
        var last: [UInt8]?
        var quietSince: Date?
        var polls = 0
        let since = { (from: Date) in Int(Date().timeIntervalSince(from) * 1000) }

        while since(started) < limitMs {
            Thread.sleep(forTimeInterval: Double(settlePollMs) / 1000)
            /* Every third look, so a stop is noticed inside a long wait rather than two minutes after it.
             * Not every look: this one is a request to the account, and the screen check is not. */
            polls += 1
            if polls % stopEveryPolls == 0, stopped() {
                stopSeen = true
                return (false, since(started), 0)
            }
            guard let now = Screen.grid() else { break }   // no screen to watch; the next picture reports it
            if let was = last, quiet(was, now) {
                if quietSince == nil { quietSince = Date() }
                let frames = Int((Double(since(quietSince!)) / Double(settlePollMs)).rounded()) + 1
                if frames >= settleQuietFrames {
                    return (true, since(started), since(quietSince!))
                }
            } else {
                quietSince = nil
            }
            last = now
        }
        return (false, since(started), 0)
    }

    /* Has this job been called off? The queue already answers exactly this, for the worker, and a wait is
     * the one place where the next step is too far away to find out. */
    private static func cancelled(_ link: Account.Link, id: String) -> Bool {
        guard let escaped = id.addingPercentEncoding(withAllowedCharacters: .alphanumerics),
              let url = URL(string: link.base + "/api/mcp?worker=state&id=" + escaped),
              let (status, data) = request(url, token: link.token, body: nil), status == 200,
              let raw = (try? JSONSerialization.jsonObject(with: data)) as? [String: Any] else {
            return false                    // no answer is not an answer; the next step will find out
        }
        return (raw["state"] as? String) != "claimed"
    }

    /* ONE FINGERPRINT, TWO QUESTIONS - and they want opposite biases. The measurements are beside
     * gridStirred in api/_brain.mjs and the numbers here must match them; agent/test-contract.mjs holds the
     * two agents to the same pair.
     *
     * "Did anything happen?" is asked after an action, and a wrong NO ends runs - six in a row stops one.
     * "Has it stopped?" is asked by a wait, and a wrong NO burns the whole limit. Until 0.14.0 both were the
     * one mean test below, and typing fifteen characters measures a mean of 0.049 over 2304 cells: a text
     * edit is a few cells changing a lot, not many changing a little. A real run renamed a document, typed
     * into it, and was stopped for having changed nothing.
     *
     * NOT VERIFIED BY RUNNING IT on this platform - the measurements behind the numbers were taken on
     * Windows, and this is the same arithmetic over the same 64x36 grid rather than a separate judgement. */
    private static let stirLevel = 8
    private static let stirCells = 1
    private static let quietMean = 3.0

    /** Did anything happen? Counts cells that changed strongly; an idle screen measured zero of them. */
    private static func stirred(_ a: [UInt8], _ b: [UInt8]) -> Bool {
        if a.count != b.count { return true }
        var cells = 0
        for i in 0..<a.count where abs(Int(a[i]) - Int(b[i])) > stirLevel {
            cells += 1
            if cells >= stirCells { return true }
        }
        return false
    }

    /** Has it stopped? Keeps the mean, which is what makes a caret and a dither not count as motion. */
    /* Не private: тот же вопрос задают действия `scrollto` и `refresh`, и задавать его вторым кодом с
     * теми же числами значило бы завести второй ответ на «оно перестало меняться». Числа остаются здесь. */
    static func quiet(_ a: [UInt8], _ b: [UInt8]) -> Bool {
        if a.count != b.count { return false }
        var sum = 0
        for i in 0..<a.count { sum += abs(Int(a[i]) - Int(b[i])) }
        return Double(sum) / Double(a.count) <= quietMean
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

func respond(_ fd: Int32, _ res: Response, origin: String? = nil) {
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
    /* ЭХО ТОЛЬКО ТОГО, КОМУ РАЗРЕШЕНО. Раньше здесь отражался любой присланный Origin, и это было
     * безобидно ровно до тех пор, пока запрос всё равно выполнялся: отражение ничего не разрешало, потому
     * что и запрещать было нечему. Теперь запрещает originAllowed выше, и отражать отказанного значило бы
     * выдать ему разрешение читать ответ, которого он не получил.
     *
     * Звёздочка заменяется на сам Origin, когда он есть: Chrome не принимает "*" в ответе на приветственный
     * запрос к локальной сети, и когда-то два агента расходились ровно здесь.
     *
     * Preflight с чужого origin остаётся без этих заголовков вовсе - браузер сам не отправит настоящий
     * запрос, - а запрос без preflight упирается в 403 выше. Оба пути закрыты. */
    var allow = allowOrigin.isEmpty ? (origin ?? "") : allowOrigin
    if allow == "*", let asked = origin { allow = asked }
    if let asked = origin, !originAllowed(asked) { allow = "" }
    if !allow.isEmpty { head += "Access-Control-Allow-Origin: \(allow)\r\n" }
    /* DELETE перечислен, и без него «Отсоединить» в приложении не работало вовсе: браузер шлёт preflight,
     * не находит метода в списке и отказывает сам, а экран сообщает, что агент недоступен - хотя агент жив
     * и по-прежнему привязан к аккаунту. Единственная кнопка, отзывающая «пусть ИИ водит этот компьютер»,
     * не работала из-за отсутствующего слова в заголовке. */
    head += "Access-Control-Allow-Methods: GET, POST, DELETE, OPTIONS\r\n"
    head += "Access-Control-Allow-Headers: content-type\r\n"
    head += "Access-Control-Max-Age: 600\r\n"
    /* Because the answer above now depends on the request. Without this a cache could hand one origin's
     * answer to another and the second would be refused for a reason nothing on either side records. */
    head += "Vary: Origin\r\n"
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

func readRequest(_ fd: Int32) -> (method: String, path: String, query: String, body: String, origin: String?)? {
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
    /* The Origin is read so it can be ECHOED, never so it can be used to reject: the agent's answer to
     * who may talk to it is --allow-origin, checked elsewhere, and a second gate here would be a second
     * place for the two agents to disagree. */
    var origin: String?
    for line in lines.dropFirst() {
        let bits = line.split(separator: ":", maxSplits: 1).map { $0.trimmingCharacters(in: .whitespaces) }
        guard bits.count == 2 else { continue }
        let name = bits[0].lowercased()
        if name == "content-length" { length = Int(bits[1]) ?? 0 }
        if name == "origin", !bits[1].isEmpty { origin = bits[1] }
    }

    var body = [UInt8](raw[start...])
    while body.count < length {
        let n = recv(fd, &chunk, chunk.count, 0)
        if n <= 0 { break }
        body.append(contentsOf: chunk[0..<n])
    }
    return (method, path, query, String(bytes: body.prefix(length), encoding: .utf8) ?? "", origin)
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

/* КТО ВООБЩЕ МОЖЕТ ГОВОРИТЬ С ЭТИМ АГЕНТОМ.
 *
 * Отсутствие Origin - это НЕ браузер: curl, mcp/worker.mjs, node fetch. Такие пропускаются, и это не дыра.
 * Страница forge'ить Origin не может - его ставит браузер, - а локальный процесс, который мог бы обойтись
 * без него, и так может всё: прочитать account.json, вызвать osascript, нажать клавиши сам. Порог здесь
 * стоит против УДАЛЁННОЙ страницы, и ровно её он и держит.
 *
 * Loopback разрешён без пина по той же причине: `npm run dev` на localhost:4400 - это разработка продукта,
 * а злонамеренный локальный сервер уже находится по ту сторону порога, где выигрывать нечего.
 *
 * Звёздочка означает то, что означала: не проверять. Теперь её надо попросить.
 */
func originAllowed(_ origin: String?) -> Bool {
    guard let origin, !origin.isEmpty else { return true }   // не браузер
    if allowOrigin == "*" { return true }                     // открыт намеренно
    if !allowOrigin.isEmpty { return origin == allowOrigin }  // закреплён оператором
    if SHIPPED_ORIGINS.contains(origin) { return true }
    /* Схема проверяется вместе с хостом: `https://localhost.evil.example` начинается с чего угодно, если
     * сравнивать по префиксу, поэтому сравнивается порт-за-портом только то, что действительно loopback. */
    if let url = URL(string: origin), let host = url.host,
       host == "localhost" || host == "127.0.0.1" || host == "[::1]",
       url.scheme == "http" || url.scheme == "https" {
        return true
    }
    return false
}

/** Что видит страница, которой отказали. Без заголовков CORS - ей и читать нечего. */
func refusedOrigin(_ origin: String) -> Response {
    Response(status: 403, contentType: "application/json",
             body: "{\"ok\":false,\"error\":" + jsonString(
                "this agent does not answer " + origin
                + " — it is pinned to another page. If this is your own deployment, restart the agent with "
                + "--allow-origin " + origin) + "}")
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
        /* Кто ведёт машину прямо сейчас - тот же список, по которому поднята рамка. Пустой - никто.
         * Отвечает на вопрос «это агент шевелит мышь или у меня что-то сломалось», не требуя смотреть
         * на экран, и делает поведение рамки проверяемым снаружи. */
        json += ",\"acting\":[" + Acting.who.map { jsonString($0) }.joined(separator: ",") + "]"
        json += ",\"autostart\":\(jsonBool(Autostart.enabled))"
        json += ",\"canAutostart\":\(jsonBool(!allowOrigin.isEmpty && allowOrigin != "*"))"
        /* «Закреплён» - это про то, что оператор НАЗВАЛ страницу, а не про то, что проверка есть.
         * Проверка теперь есть всегда; пустое значение означает умолчание, а не открытость. */
        json += ",\"originPinned\":\(jsonBool(!allowOrigin.isEmpty && allowOrigin != "*"))"
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
        /* Несёт ли клик прямоугольники окна и элемента - по ним повтор пересчитывает точку после переезда
         * окна. Следует Accessibility по той же причине, что canName: без разрешения дерево не отвечает
         * ничем, а якорь элемента читается из него. Прямоугольник окна пришёл бы и так (CGWindowList
         * разрешения не требует), но обещать половину значило бы обещать перепривязку, которой не будет. */
        json += ",\"canAnchor\":\(jsonBool(Permission.accessibility))"
        /* Named separately from the flags, because the two switches are in different panes of System
         * Settings and "permissions missing" is not an instruction. */
        json += ",\"permissions\":{\"accessibility\":\(jsonBool(Permission.accessibility))"
        json += ",\"screenRecording\":\(jsonBool(Permission.screenRecording))}"
        json += "}"
        return Response(body: json)

    /* Proving the crash pipe works, on the machine it has to work on.
     *
     * There is no other way to check it: a real fault cannot be arranged on demand, and "we would have
     * heard about it" is exactly the assumption that makes a silent reporter survive for months. Sends one
     * event and says whether the account took it. */
    case "/crash-test":
        if method != "POST" { return Response(status: 405, body: "{\"ok\":false,\"error\":\"POST\"}") }
        guard Account.link != nil else {
            return Response(status: 409, body: "{\"ok\":false,\"error\":\"this Mac is not attached to an "
                + "account, so there is nowhere to report a crash to\"}")
        }
        /* `reported` is the deployment's own answer, and it is true only if Sentry took the event. A test
         * that said "sent" and meant "handed to a socket" is the test that lets a silent reporter live. */
        let reported = Crash.test()
        return Response(body: "{\"ok\":true,\"reported\":\(jsonBool(reported))}")

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
        /* `output` только когда он есть, чтобы `{"ok":true}` осталось ровно тем же для действий, которым
         * сказать нечего. У снимка и у чтения буфера есть что, и предложение из этого собирает вызывающий -
         * см. actionSaid в api/_brain.mjs, который читают оба драйвера, чтобы они не сформулировали
         * по-разному. */
        if let said = Output.take() {
            return Response(body: "{\"ok\":true,\"output\":\(jsonString(said))}")
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
        /* ЯВНЫЙ ПИН, как на Windows - и как документация утверждала про оба, будучи правой про один.
         *
         * Автозапуск ставит job с KeepAlive: агент переживает выход, перезагрузку и pkill. Установить его -
         * решение другого веса, чем всё остальное здесь, и порог для него отдельный: не «страница, которой
         * мы отвечаем», а «оператор, который назвал страницу». Умолчание (свои origin'ы плюс loopback)
         * годится, чтобы работать; чтобы прописаться навсегда - нет. */
        if allowOrigin.isEmpty || allowOrigin == "*" {
            return Response(status: 409, body: "{\"ok\":false,\"error\":" + jsonString(
                "restart the agent with --allow-origin set to your app origin before enabling autostart")
                + "}")
        }
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
/* Permitted and still would not install. That is a fault, not a pending grant - the pending grant is the
 * ordinary state of a fresh install and is not worth reporting. */
if !tapped, Permission.accessibility {
    Crash.say("the input hook would not install although Accessibility is granted", at: "installTap")
}

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
  origin        \(allowOrigin.isEmpty ? "the app's own pages, plus localhost (default)" : allowOrigin)
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
            /* ПОРОГ. Перед switch, а не внутри маршрутов: маршрут, добавленный завтра, наследует проверку,
             * а не забывает её. Это тот самый один шов, который PROTOCOL.md просил оставить. */
            let result: Response
            if !originAllowed(request.origin) {
                result = refusedOrigin(request.origin ?? "")
            } else {
                result = route(
                    method: request.method, path: request.path, query: request.query, body: request.body
                )
            }
            respond(client, result, origin: request.origin)
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
/* ЧТО ПРОИСХОДИТ НА ЭТОМ КОМПЬЮТЕРЕ ПРЯМО СЕЙЧАС, СКАЗАННОЕ НА САМОМ КОМПЬЮТЕРЕ.
 *
 * ЗАЧЕМ. Прогон, которым управляет модель, начинается беззвучно: указатель вдруг едет сам, окно
 * поднимается, в поле появляется текст. Человек, сидящий за этим Mac, узнавал об этом по тому, что мышь
 * перестала его слушаться - то есть в тот момент, когда он уже мешает прогону, а прогон мешает ему.
 * «Невозможно понять, когда он начался» - это ровно та жалоба, и отвечать на неё надо ЗДЕСЬ: страница в
 * браузере на другом мониторе не считается, а курьерский прогон приходит с аккаунта, и браузер при нём
 * может быть не открыт вовсе.
 *
 * ПОЧЕМУ РАМКА, А НЕ КУРСОР. Курсор был первым предложением, и на macOS он невозможен: NSCursor
 * принадлежит тому приложению, над окном которого указатель, и оно переустанавливает свой курсор на
 * каждое движение мыши. Публичного системного сеттера - того, чем на Windows является SetSystemCursor -
 * в macOS нет. Измерено обе стороны: сквозной оверлей не получил ни одного cursorUpdate, а оверлей,
 * который его получал бы, обязан принимать события мыши - то есть съедать все клики, ломая ровно то,
 * ради чего агент существует.
 *
 * ПОЧЕМУ ОНА НЕ ЛОМАЕТ АГЕНТА - четыре способа, и каждый закрыт измерением, а не рассуждением:
 *
 *   /windows и windowAt   оба отбрасывают всё, у чего слой не 0. Окно на уровне CGShieldingWindowLevel()
 *                         отчитывается слоем 2147483628 - замерено, - так что модель эту рамку не видит
 *                         и прицелиться в неё не может. Ни строки фильтра дописывать не пришлось.
 *   клики                 ignoresMouseEvents = true: синтетический клик, посланный в точку поверх
 *                         рамки, дошёл до окна под ней - замерено.
 *   фокус                 пока рамка поднята, frontmostApplication не меняется - замерено; borderless
 *                         к тому же canBecomeKey = false сам по себе, и поднимается она
 *                         orderFrontRegardless, который никого не активирует.
 *   снимки экрана         sharingType = .none плюс excludingWindows в фильтре SCK - см. Screen.grab.
 *
 * И ОНА НЕ ДВИЖЕТСЯ. Не мигает, не пульсирует, не дышит. Отпечаток экрана 64x36, по которому обе стороны
 * решают «экран шевельнулся» и «уже устоялось», сравнивает два ПОДРЯД идущих кадра: неподвижная рамка
 * вычитается сама из себя и не значит ничего, а пульсирующая означала бы, что экран шевелится всегда -
 * каждое ожидание досиживало бы до предела, а каждое действие отчитывалось бы как подействовавшее. Это
 * не украшение, от которого отказались; это украшение, которое сломало бы прогон. Вычитание из кадра
 * делает вопрос спорным дважды, и оба замка стоят нарочно: один - на случай, если второй не сработает.
 */

/// Кто именно ведёт машину. Строкой - чтобы то же множество можно было проверить, не заводя экрана.
enum Driving: String {
    /// Прогон по цели, взятый курьером с аккаунта. Единственный путь с точными границами.
    case goal
    /// Повтор записи. Границы тоже точные.
    case replay
    /// Действие, только что выполненное. Границ нет - см. аренду.
    case action
}

/* ЧИСТАЯ И НАВЕРХУ ФАЙЛА, потому что единственный способ проверить аренду - выполнить её.
 *
 * Правило в одну строку, но ошибиться в нём можно двумя способами, и оба тихие: рамка, не гаснущая
 * после конца, и рамка, гаснущая посреди прогона. Регулярка над исходником сказала бы, что здесь
 * написано что-то похожее на правильное; check-swift.mjs вырезает эту функцию и ВЫПОЛНЯЕТ её. */
func frameShows(drivers: Set<String>, leaseUntil: Date, now: Date) -> Bool {
    return !drivers.isEmpty || now < leaseUntil
}

/// Ведут ли эту машину прямо сейчас, и кто.
enum Acting {
    /* Аренда одиночного действия. Достаточно длинная, чтобы рамка не моргала между действиями одного
     * хода (действие плюс 350мс на реакцию экрана), и достаточно короткая, чтобы «погасла» значило
     * «погасла». Ход модели длиннее - см. комментарий у Acting.touch() в начале doAction. */
    static let leaseSeconds: TimeInterval = 6

    private static let gate = NSLock()
    /* МНОЖЕСТВО, А НЕ СЧЁТЧИК. У счётчика есть отказ, которого у множества нет: путь, забывший вычесть,
     * оставляет рамку гореть до перезапуска агента - то есть индикатор «вами управляют» горит, когда
     * никто не управляет. Имя можно снять дважды, и ничего не случится. */
    private static var drivers: Set<String> = []
    private static var leaseUntil = Date.distantPast

    /// Горит ли рамка. Читается и из фонового потока, и с главного.
    static var on: Bool {
        gate.lock()
        defer { gate.unlock() }
        return frameShows(drivers: drivers, leaseUntil: leaseUntil, now: Date())
    }

    /// Кто ведёт - для строки состояния и для /health.
    static var who: [String] {
        gate.lock()
        defer { gate.unlock() }
        var out = drivers.sorted()
        if Date() < leaseUntil, !out.contains(Driving.action.rawValue) { out.append(Driving.action.rawValue) }
        return out
    }

    static func begin(_ driver: Driving) {
        gate.lock()
        drivers.insert(driver.rawValue)
        gate.unlock()
        ScreenFrame.sync()
    }

    static func end(_ driver: Driving) {
        gate.lock()
        drivers.remove(driver.rawValue)
        gate.unlock()
        ScreenFrame.sync()
    }

    /// Продлить аренду. Для действия, у которого никто не сообщит о конце.
    static func touch() {
        gate.lock()
        leaseUntil = Date().addingTimeInterval(leaseSeconds)
        gate.unlock()
        ScreenFrame.sync()
    }
}

/// Сама рамка. Одно окно на каждый экран, только с главного потока.
final class ScreenFrame {
    static let shared = ScreenFrame()

    private var windows: [NSWindow] = []
    private var up = false

    /* Толщина в ПУНКТАХ, а не в пикселях: на Retina окно всё равно живёт в пунктах, и рамка одинаковой
     * видимой ширины на обоих типах экрана - это одно число, а не два. */
    private static let thickness: CGFloat = 5

    /// Лайм продукта - #bdff7a. Не красный: это не отказ, и не системное предупреждение.
    private static let colour = NSColor(srgbRed: 0xbd / 255.0, green: 0xff / 255.0,
                                        blue: 0x7a / 255.0, alpha: 0.92)

    private final class Border: NSView {
        override var isFlipped: Bool { false }
        override func draw(_ dirty: NSRect) {
            /* Внутрь на половину толщины: NSBezierPath рисует по осевой линии, и без этого половина
             * рамки оказалась бы за краем экрана - то есть невидимой, и рамка читалась бы вдвое тоньше
             * заказанной. Радиус - под скруглённый угол современных Mac; на прямоугольном экране он
             * просто не виден. */
            let inset = ScreenFrame.thickness / 2
            let path = NSBezierPath(roundedRect: bounds.insetBy(dx: inset, dy: inset),
                                    xRadius: 11, yRadius: 11)
            path.lineWidth = ScreenFrame.thickness
            ScreenFrame.colour.setStroke()
            path.stroke()
        }
    }

    private func make(_ screen: NSScreen) -> NSWindow {
        let window = NSWindow(contentRect: screen.frame, styleMask: .borderless,
                              backing: .buffered, defer: false)
        window.isOpaque = false
        window.backgroundColor = .clear
        window.hasShadow = false
        /* Сквозная. Без этой строки рамка съедала бы каждый клик на экране - и человека, и агента. */
        window.ignoresMouseEvents = true
        /* Выше всего, что рисует приложение, включая полноэкранные окна и Dock. */
        window.level = NSWindow.Level(rawValue: Int(CGShieldingWindowLevel()))
        /* Первый замок против попадания в кадр - см. Screen.grab про второй. Заодно означает, что рамку
         * не увидит и тот, кому этот экран показывают по Zoom: она предупреждает того, кто сидит за
         * машиной, а не всех, кто смотрит. */
        window.sharingType = .none
        /* На всех рабочих столах, поверх полноэкранного окна, и мимо Cmd-Tab. .stationary - чтобы она не
         * уезжала вместе с рабочим столом при переключении: экран остаётся тем же экраном. */
        window.collectionBehavior = [.canJoinAllSpaces, .stationary, .fullScreenAuxiliary, .ignoresCycle]
        window.contentView = Border(frame: NSRect(origin: .zero, size: screen.frame.size))
        window.setFrame(screen.frame, display: false)
        return window
    }

    /// Привести рамку в соответствие с Acting. Можно звать откуда угодно и сколько угодно раз.
    static func sync() {
        if Thread.isMainThread { shared.apply() } else { DispatchQueue.main.async { shared.apply() } }
    }

    private func apply() {
        let want = Acting.on
        if want == up { return }
        up = want
        want ? raise() : drop()
    }

    private func raise() {
        /* Строятся заново на каждый подъём, а не один раз при старте: между двумя прогонами монитор
         * могли отключить, добавить или пересчитать по разрешению. Окна дешёвые, прогоны редкие. */
        drop()
        windows = NSScreen.screens.map(make)
        /* orderFrontRegardless, а не makeKeyAndOrderFront: второй активировал бы агента и увёл фокус из
         * того окна, в котором прогон как раз собирается что-то нажать. */
        windows.forEach { $0.orderFrontRegardless() }
    }

    private func drop() {
        windows.forEach { $0.orderOut(nil) }
        windows = []
    }

    /// Монитор подключили или отключили, пока рамка горит - перестроить под новый набор экранов.
    func screensChanged() {
        guard up else { return }
        raise()
    }
}

let app = NSApplication.shared
app.setActivationPolicy(.accessory)

final class MenuActions: NSObject, NSMenuDelegate {
    /* "Stop and Save Recording" exists only while there is one - shown when the menu opens, which is the
     * only moment visibility matters. */
    func menuNeedsUpdate(_ menu: NSMenu) {
        let recording = Recorder.shared.isRecording
        /* И ЗАПОМНИТЬ, ЧТО ДАЛЬШЕ В БУФЕРЕ - УЖЕ НАШЕ МЕНЮ. Это единственный момент, когда про открытие
         * известно; клик, которым его открыли, из записи выпадет. См. Recorder.markOwnMenu. */
        Recorder.shared.markOwnMenu()
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
    /* Гашение по истечении аренды. Зажигается рамка сразу - Acting.touch() зовёт sync() сам, - а вот
     * истечение аренды это не событие, и заметить его может только тот, кто смотрит на часы. Секунды
     * хватает: рамка гаснет через 6 секунд после последнего действия, и седьмая ничего не меняет.
     * Тот же таймер, что и у иконки, а не свой: два таймера на одну строку состояния - это два. */
    ScreenFrame.sync()
}

/* Монитор подключили, отключили или пересчитали разрешение. Без этого рамка на новом экране не
 * появилась бы, а на отключённом осталась бы окном в никуда. */
NotificationCenter.default.addObserver(
    forName: NSApplication.didChangeScreenParametersNotification, object: nil, queue: .main
) { _ in ScreenFrame.shared.screensChanged() }

app.run()
