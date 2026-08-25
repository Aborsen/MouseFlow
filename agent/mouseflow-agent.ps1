<#
.SYNOPSIS
  MouseFlow local agent. Records global mouse input and replays it, exposing a
  small HTTP API on loopback so the MouseFlow web app can drive it.

.DESCRIPTION
  The browser cannot see mouse events outside its own window, and cannot inject
  real OS clicks. This agent supplies both halves:

    recording  SetWindowsHookEx(WH_MOUSE_LL) on a dedicated message-pump thread
    replay     SendInput with absolute virtual-desktop coordinates

  It listens on http://127.0.0.1:<Port> and answers CORS preflights so an https://
  page (e.g. a Vercel deployment) can call it. Note that reaching loopback from a
  public origin also needs the user's Local Network Access permission in Chrome 142+;
  that is granted in the browser and cannot be granted by any response header here.

  API
    GET  /health          -> JSON {ok, version, screen, recording, playing}
    POST /record/start    -> JSON {ok}   ?moveMs=250 thins the pointer path for a long session
    GET  /record/status   -> JSON {recording, count, elapsedMs, part, moveMs}
    POST /record/drain    -> text/plain, what has piled up so far; RECORDING CONTINUES
    POST /record/stop     -> text/plain, one event per line (.mmmacro format)
    POST /replay          -> JSON {ok}   body: see FLOW BODY below
    GET  /replay/status   -> JSON {playing, step, steps, pass, passes, index, total}
    POST /replay/abort    -> JSON {ok}
    GET  /shot            -> JSON {ok, png, w, h, scale, originX, originY}  a look at the screen
    GET  /windows         -> JSON {ok, windows:[{title, process, active, minimized, x, y, w, h}]}
    GET  /pulse           -> JSON {ok, grid}  64x36 grey samples: cheap enough to poll while waiting
    GET  /shot?w=640      -> a smaller picture, for a caller told its request was too large
    POST /do              -> JSON {ok}   one action; body is key=value, see ACTION BODY below
    POST /autostart/enable  -> JSON {ok} - drops a launcher in the Startup folder
    POST /autostart/disable -> JSON {ok} - removes it

  FLOW BODY (text/plain)
    startDelay=3000
    flowRepeat=forever
    STEP repeat=2 speed=1.0 delayAfter=500
    1 | 1074 | 159 | 791 | Left Click Down
    2 | 1074 | 159 | 63 | Left Click Release
    STEP repeat=1 speed=2.0 delayAfter=0
    1 | 900 | 300 | 120 | Left Click Down
    ...

  ACTION BODY (text/plain)
    action=click x=1074 y=159 button=left double=0
    action=move x=400 y=300
    action=scroll x=400 y=300 amount=-3
    action=type text=hello there
    action=type enc=b64 nl=shift text=<base64 UTF-8>   multi-line text, newlines intact
    action=key key=Enter ctrl=0 shift=0 alt=0
    action=activate title=Outlook            (or process=outlook)

  /windows exists because a screenshot is not the whole truth. An application that is minimised, or
  behind another window, is invisible to a picture - and something acting only on pictures will happily
  launch a second copy of a program that is already running, which is exactly what happened. The list
  says what is open; `activate` is how to get to it without opening anything.

  /shot and /do are what let the app describe a goal in words and have it carried out here rather
  than only replaying something recorded earlier: one is how it sees, the other is how it acts. Both
  work in virtual-desktop coordinates, the same space replay uses, and /shot reports the scale it
  shrank the image by so a point on the picture maps back to a point on the screen.

  Event lines use the Mini Mouse Macro layout: index | X | Y | delayMs | action
  where delayMs is the wait BEFORE the event. Lines starting with # are ignored.

  repeat / flowRepeat accept a count or the word 'forever' (0 means the same).
  flowRepeat=forever is how "restart the whole sequence when it ends" is
  expressed; repeat=forever on a single step loops just that step.

.PARAMETER Port
  Loopback port to listen on. Default 8787.

.PARAMETER AllowOrigin
  Origin allowed to call the agent. '*' echoes whatever Origin asks, which lets
  ANY site you visit drive your mouse while the agent runs. Pin it to your
  deployment for anything beyond a local demo, e.g.
    -AllowOrigin https://mouse-flow.vercel.app

.PARAMETER MoveThrottleMs
  Minimum gap between recorded move events. Default 10.

.PARAMETER MoveMinPx
  Minimum cursor travel before a move is recorded. Default 3.

.EXAMPLE
  .\mouseflow-agent.ps1

.EXAMPLE
  .\mouseflow-agent.ps1 -Port 8787 -AllowOrigin https://mouse-agent.vercel.app

.EXAMPLE
  # Start without downloading anything first. Autostart is unavailable this way,
  # because there is no local file for the logon launcher to point at.
  & ([scriptblock]::Create((irm https://mouse-agent.vercel.app/agent/mouseflow-agent.ps1))) -AllowOrigin https://mouse-agent.vercel.app

.NOTES
  Hold ESC during replay to abort. Ctrl+C stops the agent.
  The low-level hook stays installed for the agent's lifetime but events are
  only stored between /record/start and /record/stop.

  A SESSION THAT LASTS A WORKING DAY

  Eight hours does not fit, and what it does not fit is not a time limit - there is none - it is BYTES.
  Measured over the recordings this project actually made: 69 bytes an event, 23-42 events a second, so
  1.5-2.9 KB/s. The app refuses a payload over 400KB, which arrives around the third minute, and /record/stop
  used to be the only way events left the agent - so eight hours meant ~830,000 events held in memory and
  returned in one string.

  Two things answer that, and both are needed:

    /record/drain      takes what has piled up and KEEPS RECORDING. The caller writes each chunk away as its
                       own recording, so memory never holds more than one chunk. The clock is not reset, so
                       elapsedMs stays the time of the SESSION - a chunk that says 30 minutes and a session
                       that says eight hours are both true and both readable.

    ?moveMs=250        pointer movement is 93.75% of the events and 88.6% of the bytes (measured, same
                       place). At the 10ms default that is up to a hundred samples a second of a path that
                       nothing reads - not the transcript, not the story, not the analytics; they read
                       clicks, scrolls, keys and the change of window. At 250ms the "was somebody at this
                       machine" signal survives and a 30-minute chunk fits in those 400KB.

  Replay of a thinned recording is coarser, and deliberately so: an eight-hour session is recorded to be
  READ, not replayed. A short recording keeps the 10ms default and replays exactly as before.
#>
[CmdletBinding()]
param(
    [int]$Port = 8787,
    [string]$AllowOrigin = '*',
    [int]$MoveThrottleMs = 10,
    [int]$MoveMinPx = 3,
    # The tray icon is how a person reaches the agent - starting and stopping a recording without the
    # browser, and seeing that one is running. Off for a headless run or when something about the tray
    # itself is being debugged; the HTTP half is identical either way.
    [switch]$NoTray
)

$ErrorActionPreference = 'Stop'

# System.Drawing is referenced for /shot: capturing the screen is what lets the app act on a goal
# described in words rather than only replay something recorded earlier.
Add-Type -ReferencedAssemblies 'System.Drawing','System.Windows.Forms','UIAutomationClient','UIAutomationTypes','WindowsBase' -TypeDefinition @'
using System;
using System.Collections.Generic;
using System.Diagnostics;
using System.Windows.Automation;
using System.Globalization;
using System.IO;
using System.Net;
using System.Net.Sockets;
using System.Runtime.InteropServices;
using System.Text;
using System.Threading;

namespace MouseFlow
{
    public struct POINT { public int X; public int Y; }

    [StructLayout(LayoutKind.Sequential)]
    public struct RECT { public int Left; public int Top; public int Right; public int Bottom; }

    [StructLayout(LayoutKind.Sequential)]
    public struct MSLLHOOKSTRUCT
    {
        public POINT pt;
        public uint mouseData;
        public uint flags;
        public uint time;
        public IntPtr dwExtraInfo;
    }

    [StructLayout(LayoutKind.Sequential)]
    public struct MSG
    {
        public IntPtr hwnd;
        public uint message;
        public IntPtr wParam;
        public IntPtr lParam;
        public uint time;
        public POINT pt;
    }

    [StructLayout(LayoutKind.Sequential)]
    public struct MOUSEINPUT
    {
        public int dx;
        public int dy;
        public uint mouseData;
        public uint dwFlags;
        public uint time;
        public IntPtr dwExtraInfo;
    }

    [StructLayout(LayoutKind.Sequential)]
    public struct INPUT
    {
        public uint type;
        public MOUSEINPUT mi;
    }

    [StructLayout(LayoutKind.Sequential)]
    public struct KEYBDINPUT
    {
        public ushort wVk;
        public ushort wScan;
        public uint dwFlags;
        public uint time;
        public IntPtr dwExtraInfo;
    }

    /* A real INPUT is a union, and the OS checks cbSize against the whole thing - so a struct
       carrying only KEYBDINPUT would be the wrong size and SendInput would reject it. Explicit
       layout gives the union its true size on 32- and 64-bit alike, rather than hand-counting
       padding that differs between them. */
    [StructLayout(LayoutKind.Explicit)]
    public struct INPUTDATA
    {
        [FieldOffset(0)] public MOUSEINPUT mi;
        [FieldOffset(0)] public KEYBDINPUT ki;
    }

    [StructLayout(LayoutKind.Sequential)]
    public struct INPUTU
    {
        public uint type;
        public INPUTDATA u;
    }

    /* The low-level keyboard hook's payload.
     *
     * `flags` is read, to tell an injected key from a person's. `vkCode` and `scanCode` are NOT read
     * anywhere in this file and must not be: the recording says a key was pressed and when, never which,
     * and the cheapest way to keep that promise is for the code that could break it not to exist. A field
     * has to be declared for the struct layout to match; declaring it is not reading it. */
    [StructLayout(LayoutKind.Sequential)]
    public struct KBDLLHOOKSTRUCT
    {
        public uint vkCode;
        public uint scanCode;
        public uint flags;
        public uint time;
        public IntPtr dwExtraInfo;
    }

    public static class Native
    {
        public delegate IntPtr HookProc(int nCode, IntPtr wParam, IntPtr lParam);

        [DllImport("user32.dll", SetLastError = true)]
        public static extern IntPtr SetWindowsHookEx(int idHook, HookProc lpfn, IntPtr hMod, uint dwThreadId);
        [DllImport("user32.dll", SetLastError = true)]
        public static extern bool UnhookWindowsHookEx(IntPtr hhk);
        [DllImport("user32.dll")]
        public static extern IntPtr CallNextHookEx(IntPtr hhk, int nCode, IntPtr wParam, IntPtr lParam);
        [DllImport("user32.dll")]
        public static extern int GetMessage(out MSG lpMsg, IntPtr hWnd, uint wMsgFilterMin, uint wMsgFilterMax);
        [DllImport("user32.dll")]
        public static extern bool TranslateMessage(ref MSG lpMsg);
        [DllImport("user32.dll")]
        public static extern IntPtr DispatchMessage(ref MSG lpMsg);
        [DllImport("user32.dll", SetLastError = true)]
        public static extern uint SendInput(uint nInputs, INPUT[] pInputs, int cbSize);
        [DllImport("user32.dll", SetLastError = true)]
        public static extern uint SendInput(uint nInputs, INPUTU[] pInputs, int cbSize);
        [DllImport("user32.dll")]
        public static extern bool GetCursorPos(out POINT lpPoint);
        [DllImport("user32.dll")]
        public static extern int GetSystemMetrics(int nIndex);
        [DllImport("user32.dll")]
        public static extern short GetAsyncKeyState(int vKey);
        [DllImport("user32.dll", CharSet = CharSet.Unicode)]
        public static extern short VkKeyScan(char ch);

        public delegate bool EnumProc(IntPtr hWnd, IntPtr lParam);
        [DllImport("user32.dll")]
        public static extern bool EnumWindows(EnumProc callback, IntPtr lParam);
        [DllImport("user32.dll")]
        public static extern bool IsWindowVisible(IntPtr hWnd);
        [DllImport("user32.dll")]
        public static extern bool IsIconic(IntPtr hWnd);
        [DllImport("user32.dll", CharSet = CharSet.Unicode)]
        public static extern int GetWindowText(IntPtr hWnd, StringBuilder text, int count);
        [DllImport("user32.dll", CharSet = CharSet.Unicode)]
        public static extern int GetWindowTextLength(IntPtr hWnd);
        [DllImport("user32.dll")]
        public static extern IntPtr GetForegroundWindow();

        /* Which window is under a point, and its top-level ancestor. WindowFromPoint answers with the deepest
         * child - a button rather than the application - and a recording wants the application, so every
         * lookup climbs to GA_ROOT. Both are window-manager calls: cheap, and they answer even for a process
         * that exposes no accessibility tree at all, which is what makes an Electron app still say "Claude". */
        [DllImport("user32.dll")]
        public static extern IntPtr WindowFromPoint(POINT point);
        [DllImport("user32.dll")]
        public static extern IntPtr GetAncestor(IntPtr hWnd, uint flags);
        public const uint GA_ROOT = 2;
        [DllImport("user32.dll")]
        public static extern bool SetForegroundWindow(IntPtr hWnd);
        [DllImport("user32.dll")]
        public static extern bool ShowWindow(IntPtr hWnd, int nCmdShow);
        [DllImport("user32.dll")]
        public static extern uint GetWindowThreadProcessId(IntPtr hWnd, out uint processId);
        [DllImport("user32.dll")]
        public static extern bool GetWindowRect(IntPtr hWnd, out RECT rect);
        [DllImport("user32.dll")]
        public static extern IntPtr GetWindow(IntPtr hWnd, uint cmd);
        [DllImport("user32.dll")]
        public static extern bool AttachThreadInput(uint attachTo, uint attachFrom, bool attach);
        [DllImport("user32.dll")]
        public static extern bool BringWindowToTop(IntPtr hWnd);
        [DllImport("kernel32.dll")]
        public static extern uint GetCurrentThreadId();
        /* Windows Store apps keep hidden windows around that are visible by every other measure. Asking
           the compositor whether one is "cloaked" is the only way to tell them from real ones, and
           without it the list is half phantoms. */
        [DllImport("dwmapi.dll")]
        public static extern int DwmGetWindowAttribute(IntPtr hWnd, int attribute, out int value, int size);

        public const int SW_RESTORE = 9;
        public const uint GW_OWNER = 4;
        public const int DWMWA_CLOAKED = 14;

        public const uint INPUT_KEYBOARD = 1;
        public const uint KEYEVENTF_KEYUP = 0x0002;
        public const uint KEYEVENTF_UNICODE = 0x0004;

        public const int WH_MOUSE_LL = 14;
        public const int WH_KEYBOARD_LL = 13;
        public const uint LLMHF_INJECTED = 0x00000001;
        public const uint LLKHF_INJECTED = 0x00000010;

        public const int WM_KEYDOWN = 0x0100;
        public const int WM_SYSKEYDOWN = 0x0104;

        public const int WM_MOUSEMOVE = 0x0200;
        public const int WM_LBUTTONDOWN = 0x0201;
        public const int WM_LBUTTONUP = 0x0202;
        public const int WM_RBUTTONDOWN = 0x0204;
        public const int WM_RBUTTONUP = 0x0205;
        public const int WM_MBUTTONDOWN = 0x0207;
        public const int WM_MBUTTONUP = 0x0208;
        public const int WM_MOUSEWHEEL = 0x020A;

        public const uint INPUT_MOUSE = 0;
        public const uint MOUSEEVENTF_MOVE = 0x0001;
        public const uint MOUSEEVENTF_LEFTDOWN = 0x0002;
        public const uint MOUSEEVENTF_LEFTUP = 0x0004;
        public const uint MOUSEEVENTF_RIGHTDOWN = 0x0008;
        public const uint MOUSEEVENTF_RIGHTUP = 0x0010;
        public const uint MOUSEEVENTF_MIDDLEDOWN = 0x0020;
        public const uint MOUSEEVENTF_MIDDLEUP = 0x0040;
        public const uint MOUSEEVENTF_WHEEL = 0x0800;
        public const uint MOUSEEVENTF_VIRTUALDESK = 0x4000;
        public const uint MOUSEEVENTF_ABSOLUTE = 0x8000;

        public const int SM_XVIRTUALSCREEN = 76;
        public const int SM_YVIRTUALSCREEN = 77;
        public const int SM_CXVIRTUALSCREEN = 78;
        public const int SM_CYVIRTUALSCREEN = 79;
        public const int VK_ESCAPE = 0x1B;
    }

    public class Ev
    {
        public int X;
        public int Y;
        public int DelayMs;
        public string Action;
        public int Wheel;

        /* Where this happened, when it could be resolved. Null on a move (nothing worth naming, and there
         * are hundreds), and null on a click the resolver could not read - an elevated window, an Electron
         * app that names nothing, or a queue that was still catching up when recording stopped. Null means
         * "not known", never "nothing there", and the transcript has to keep that distinction. */
        public string Process;
        public string Window;
        public string Control;
        public string ControlType;
        /* The page it landed on, when it landed on one. Origin and path - the cut happens in PageUrl(),
         * before the value ever reaches this object. Null on everything that is not a browser. */
        public string Url;
    }

    public class Step
    {
        public List<Ev> Events = new List<Ev>();
        public int Repeat = 1;
        public double Speed = 1.0;
        public int DelayAfterMs = 0;
    }

    public class Flow
    {
        public List<Step> Steps = new List<Step>();
        public int StartDelayMs = 0;
        public int Repeat = 1;      // 0 == until aborted
    }

    public static class Agent
    {
        public const string Version = "0.9.4";

        static readonly object Gate = new object();
        static Native.HookProc _proc;   // must outlive the hook or the GC eats it
        static IntPtr _hook = IntPtr.Zero;
        static Native.HookProc _kbProc; // same reason, separately rooted
        static IntPtr _kbHook = IntPtr.Zero;

        static bool _recording;
        /* A recording ended at the AGENT - from the tray - waiting for the app to take delivery. Serialized
         * text rather than events: the resolver has already finished with it, and text is what /record/stop
         * returns anyway. Spilled to disk the moment it exists, because every way this process ends would
         * otherwise destroy the one thing the tray promised to save. */
        static string _heldText;
        static int _heldEvents;
        /// True between "capture stopped" and "the hold is safely on disk".
        static bool _ending;

        static string HeldPath
        {
            get
            {
                return Path.Combine(
                    Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData),
                    "MouseFlow", "held-recording.mmmacro");
            }
        }

        /* A hold left by an earlier process - the agent was restarted before the app collected. Loaded, not
         * discarded: somebody pressed Save. Unless it parses to zero events, which cannot be delivered as
         * anything and would wedge /record/start behind a refusal forever. */
        public static void LoadHeld()
        {
            try
            {
                string p = HeldPath;
                if (!File.Exists(p)) return;
                string text = File.ReadAllText(p);
                int events = 0;
                foreach (string line in text.Split('\n'))
                {
                    string t = line.Trim();
                    if (t.Length > 0 && !t.StartsWith("#")) events++;
                }
                if (events > 0) { lock (Gate) { _heldText = text; _heldEvents = events; } }
                else File.Delete(p);
            }
            catch { /* An unreadable hold is one that cannot be delivered; it must not stop the agent. */ }
        }
        /* How many mouse buttons are down. A Focus marker must never be written while a gesture is in
         * progress - it splits the press from its release - and "is a gesture in progress" cannot be read
         * off the last buffered event, which was the first version of this guard: the pointer drifts, a
         * Mouse Movement lands between the press and the marker, and the guard sees no click. Counted
         * instead, from the events themselves. */
        static int _held;
        static List<Ev> _buffer = new List<Ev>();
        static Stopwatch _clock = new Stopwatch();
        static long _lastStamp;
        static int _lastX, _lastY;
        static bool _haveLast;
        static int _throttleMs = 10;
        static int _minPx = 3;
        /* The throttle this SESSION is using, and the one to go back to.
         *
         * A long session thins the pointer path; the next short recording must not inherit that. Two fields
         * rather than one, because the default arrives from the command line and a session override must not
         * overwrite it - a recording started with -MoveThrottleMs 25 and then one long session would
         * otherwise silently become a 250ms recorder for the rest of the run. */
        static int _sessionMs = 10;
        /* How many times this session has been drained. Not the number of chunks the caller kept - it cannot
         * know that - but the number handed out, which is what makes a chunk identifiable in a session. */
        static int _part;

        static bool _playing;
        static bool _abort;
        /* Events a replay could not perform. A recording with typing in it cannot be replayed faithfully -
         * nothing in it says which keys - and a replay that quietly pressed nothing for the two minutes
         * somebody spent typing would report a clean run. Counted, and reported by /replay/status. */
        static int _unplayable;
        /* How many presses were aimed somewhere other than the recorded point. Reported, because a replay
         * that quietly moved where it clicked is a replay whose report cannot be trusted. */
        static int _retargeted;
        static int _stepIdx, _stepCount, _pass, _passes, _evIdx, _evCount;
        static int _flowPass, _flowPasses;

        public static string LastError = "";
        public static string ScriptPath = "";   // empty when started via irm|iex - no file to autostart
        public static int Port = 8787;

        // ---------- recording ----------

        public static void Configure(int throttleMs, int minPx)
        {
            _throttleMs = throttleMs;
            _minPx = minPx;
        }

        public static void StartHookPump()
        {
            Thread t = new Thread(new ThreadStart(PumpThread));
            t.IsBackground = true;
            t.Name = "MouseFlowHook";
            t.Start();
        }

        static void PumpThread()
        {
            _proc = new Native.HookProc(HookCallback);
            _hook = Native.SetWindowsHookEx(Native.WH_MOUSE_LL, _proc, IntPtr.Zero, 0);
            if (_hook == IntPtr.Zero)
            {
                LastError = "SetWindowsHookEx failed: " + Marshal.GetLastWin32Error().ToString(CultureInfo.InvariantCulture);
                /* Without this hook the agent records nothing at all, and the only sign of it today is a
                   flag in /health that somebody has to go and look at. */
                Crash.Say(LastError, "hook.mouse");
                return;
            }

            /* The keyboard hook is not fatal if it fails. Mouse recording is the product; knowing that
             * somebody typed for two minutes is an improvement on top of it, and an agent that refused to
             * start over a missing improvement would be a worse agent. */
            _kbProc = new Native.HookProc(KeyCallback);
            _kbHook = Native.SetWindowsHookEx(Native.WH_KEYBOARD_LL, _kbProc, IntPtr.Zero, 0);
            if (_kbHook == IntPtr.Zero)
            {
                LastError = "keyboard hook failed (" + Marshal.GetLastWin32Error().ToString(CultureInfo.InvariantCulture)
                    + "); recording continues without typing";
            }
            MSG msg;
            while (Native.GetMessage(out msg, IntPtr.Zero, 0, 0) > 0)
            {
                Native.TranslateMessage(ref msg);
                Native.DispatchMessage(ref msg);
            }
            Native.UnhookWindowsHookEx(_hook);
            if (_kbHook != IntPtr.Zero) Native.UnhookWindowsHookEx(_kbHook);
        }

        /* A keystroke, and only that it happened.
         *
         * The struct is marshalled to read one flag - whether this key was injected, because a replay
         * pressing keys must not be recorded as a person typing - and vkCode is never touched. Auto-repeat
         * arrives as ordinary key-downs and is kept: holding a key IS time spent typing, and filtering it
         * would need the key identity this deliberately does not have. */
        static IntPtr KeyCallback(int nCode, IntPtr wParam, IntPtr lParam)
        {
            if (nCode >= 0)
            {
                int msg = wParam.ToInt32();
                if (msg == Native.WM_KEYDOWN || msg == Native.WM_SYSKEYDOWN)
                {
                    bool active;
                    lock (Gate) { active = _recording; }
                    if (active)
                    {
                        KBDLLHOOKSTRUCT data = (KBDLLHOOKSTRUCT)Marshal.PtrToStructure(lParam, typeof(KBDLLHOOKSTRUCT));
                        if ((data.flags & Native.LLKHF_INJECTED) == 0)
                        {
                            string named = NamedKey((int)data.vkCode);
                            if (named != null) CaptureNamedKey(named); else CaptureKey();
                        }
                    }
                }
            }
            return Native.CallNextHookEx(IntPtr.Zero, nCode, wParam, lParam);
        }

        /* Keys that cannot spell anything, and chords that are instructions rather than text.
         *
         * Same rule as the macOS agent, and the same reason: without it a recording cannot say that the
         * work ended by pressing Send, so a skill made from one types the message and never sends it.
         * Everything capable of producing a character still goes to CaptureKey() and is counted without
         * ever being identified - every letter, every digit, and every Shift chord, because a capital
         * letter is still a letter.
         *
         * ALT IS NOT A COMMAND MODIFIER HERE, and that is the Windows-shaped trap. On many layouts AltGr
         * is Ctrl+Alt and composes characters - Polish, Ukrainian, Hungarian - so a chord holding both is
         * text being typed, not a command being given, and reading it would read the text. Ctrl without
         * Alt, or the Windows key.
         *
         * The codes are the ones VkFor() below already uses to PLAY these keys, so the two directions
         * cannot drift apart: Enter 0x0D, Tab 0x09, Escape 0x1B, Backspace 0x08, Delete 0x2E, the arrows
         * 0x25-0x28 and the page keys 0x21-0x24. */
        static string NamedKey(int vk)
        {
            string name = null;
            switch (vk)
            {
                case 0x0D: name = "Enter"; break;
                case 0x09: name = "Tab"; break;
                case 0x1B: name = "Escape"; break;
                case 0x08: name = "Backspace"; break;
                case 0x2E: name = "Delete"; break;
                case 0x25: name = "Left"; break;
                case 0x26: name = "Up"; break;
                case 0x27: name = "Right"; break;
                case 0x28: name = "Down"; break;
                case 0x21: name = "PageUp"; break;
                case 0x22: name = "PageDown"; break;
                case 0x23: name = "End"; break;
                case 0x24: name = "Home"; break;
                default: break;
            }

            bool ctrl = (Native.GetAsyncKeyState(0x11) & 0x8000) != 0;
            bool alt = (Native.GetAsyncKeyState(0x12) & 0x8000) != 0;
            bool shift = (Native.GetAsyncKeyState(0x10) & 0x8000) != 0;
            bool win = ((Native.GetAsyncKeyState(0x5B) & 0x8000) != 0)
                    || ((Native.GetAsyncKeyState(0x5C) & 0x8000) != 0);
            bool commanded = (ctrl && !alt) || win;

            if (name == null)
            {
                /* A letter or digit, and only under a command chord. The virtual key IS the shortcut -
                 * Ctrl+C is Ctrl plus VK_C whatever the layout prints on the key - which is the same thing
                 * VkFor's comment says about playing one back. */
                if (!commanded) return null;
                if (vk >= 0x41 && vk <= 0x5A) name = ((char)vk).ToString();
                else if (vk >= 0x30 && vk <= 0x39) name = ((char)vk).ToString();
                else return null;
            }

            string prefix = "";
            if (win) prefix += "Win+";
            if (ctrl && !alt) prefix += "Ctrl+";
            if (alt && !ctrl) prefix += "Alt+";
            if (shift) prefix += "Shift+";
            return prefix + name;
        }

        /* A key that carries no text, recorded BY NAME. Never coalesced: two presses of Enter are two
         * things that happened, and each resolves the focused element, because a commit is only an
         * instruction when it says what it committed. */
        static void CaptureNamedKey(string name)
        {
            Ev pending = null;
            lock (Gate)
            {
                long now = _clock.ElapsedMilliseconds;
                Ev e = new Ev();
                e.X = _lastX;
                e.Y = _lastY;
                e.DelayMs = _buffer.Count == 0 ? 0 : (int)(now - _lastStamp);
                e.Action = "Key " + name;
                _buffer.Add(e);
                _lastStamp = now;
                pending = e;
            }
            if (pending != null) EnqueueFocused(pending);
        }

        static void CaptureKey()
        {
            Ev first = null;
            lock (Gate)
            {
                long now = _clock.ElapsedMilliseconds;
                Ev e = new Ev();
                /* The pointer has not moved for this event, so the last known position is used rather than
                 * a GetCursorPos in the hook. The five-column format needs a coordinate; typing does not
                 * have one, and the transcript never reads it for a key. */
                e.X = _lastX;
                e.Y = _lastY;
                e.DelayMs = _buffer.Count == 0 ? 0 : (int)(now - _lastStamp);
                e.Action = "Key Down";
                bool continuing = _buffer.Count > 0 && _buffer[_buffer.Count - 1].Action == "Key Down";
                _buffer.Add(e);
                _lastStamp = now;
                // One resolution per RUN of typing. Sixty keystrokes into one field is one answer.
                if (!continuing) first = e;
            }
            if (first != null) EnqueueFocused(first);
        }

        static IntPtr HookCallback(int nCode, IntPtr wParam, IntPtr lParam)
        {
            if (nCode >= 0)
            {
                bool active;
                lock (Gate) { active = _recording; }
                if (active)
                {
                    MSLLHOOKSTRUCT data = (MSLLHOOKSTRUCT)Marshal.PtrToStructure(lParam, typeof(MSLLHOOKSTRUCT));
                    bool injected = (data.flags & Native.LLMHF_INJECTED) != 0;
                    if (!injected) Capture(wParam.ToInt32(), data);
                }
            }
            return Native.CallNextHookEx(IntPtr.Zero, nCode, wParam, lParam);
        }

        static void Capture(int msg, MSLLHOOKSTRUCT data)
        {
            string action = null;
            int wheel = 0;

            switch (msg)
            {
                case Native.WM_MOUSEMOVE: action = "Mouse Movement"; break;
                case Native.WM_LBUTTONDOWN: action = "Left Click Down"; break;
                case Native.WM_LBUTTONUP: action = "Left Click Release"; break;
                case Native.WM_RBUTTONDOWN: action = "Right Click Down"; break;
                case Native.WM_RBUTTONUP: action = "Right Click Release"; break;
                case Native.WM_MBUTTONDOWN: action = "Middle Click Down"; break;
                case Native.WM_MBUTTONUP: action = "Middle Click Release"; break;
                case Native.WM_MOUSEWHEEL:
                    wheel = (short)((data.mouseData >> 16) & 0xFFFF);
                    action = wheel >= 0 ? "Scroll Up" : "Scroll Down";
                    break;
                default: return;
            }

            lock (Gate)
            {
                long now = _clock.ElapsedMilliseconds;

                if (action.EndsWith("Click Down")) _held++;
                else if (action.EndsWith("Click Release") || action.EndsWith("Click Up")) { if (_held > 0) _held--; }

                if (action == "Mouse Movement")
                {
                    // The raw hook fires hundreds of moves a second. Keep only the
                    // ones that carry information: far enough apart in time AND space.
                    if (_haveLast)
                    {
                        int dx = Math.Abs(data.pt.X - _lastX);
                        int dy = Math.Abs(data.pt.Y - _lastY);
                        if ((now - _lastStamp) < _sessionMs) return;
                        if (dx < _minPx && dy < _minPx) return;
                    }
                }

                Ev e = new Ev();
                e.X = data.pt.X;
                e.Y = data.pt.Y;
                e.DelayMs = _buffer.Count == 0 ? 0 : (int)(now - _lastStamp);
                e.Action = action;
                e.Wheel = wheel;
                _buffer.Add(e);

                /* Clicks only, and only the DOWN: the release is the same target a moment later, and a move
                 * has no target worth naming. Queued rather than resolved - see the resolver. */
                if (action.EndsWith("Click Down")) Enqueue(e, data.pt.X, data.pt.Y);

                _lastStamp = now;
                _lastX = data.pt.X;
                _lastY = data.pt.Y;
                _haveLast = true;
            }
        }

        /* ------------------------------------------------------------------ where a click landed
         *
         * A queue and one worker, because the alternative is doing this inside the hook. A low-level hook
         * that takes longer than LowLevelHooksTimeout (300ms by default) is removed by Windows without
         * telling anybody, and the first UIA call on a thread costs 122ms. So the hook does the cheap part -
         * it already has the coordinates - and the worker does the slow part while the person keeps working.
         *
         * Bounded on purpose. If the worker falls behind, the events at the back of the queue lose their
         * context rather than the recording losing events: a click with no context is a small loss, a click
         * that never got recorded is a wrong recording. `_dropped` counts what was skipped so /record/stop
         * can report it instead of quietly returning a thinner transcript.
         */
        class Pending
        {
            public Ev Target;
            public int X;
            public int Y;
            /* Two kinds of question. A click asks "what is at this point" - WindowFromPoint and
             * AutomationElement.FromPoint. A keystroke asks "what has focus" - GetForegroundWindow and
             * AutomationElement.FocusedElement - because the pointer is wherever it was left and says
             * nothing about where the typing went. */
            public bool Focused;
        }

        static readonly Queue<Pending> _toResolve = new Queue<Pending>();
        static readonly object ResolveGate = new object();
        static Thread _resolver;
        static bool _resolverStop;
        static int _dropped;
        const int QueueMax = 400;

        static void Enqueue(Ev e, int x, int y)
        {
            lock (ResolveGate)
            {
                if (_toResolve.Count >= QueueMax) { _dropped++; return; }
                Pending p = new Pending();
                p.Target = e;
                p.X = x;
                p.Y = y;
                _toResolve.Enqueue(p);
            }
        }

        static void EnqueueFocused(Ev e)
        {
            lock (ResolveGate)
            {
                if (_toResolve.Count >= QueueMax) { _dropped++; return; }
                Pending p = new Pending();
                p.Target = e;
                p.Focused = true;
                _toResolve.Enqueue(p);
            }
        }

        static void ResolveLoop()
        {
            while (true)
            {
                Pending job = null;
                lock (ResolveGate)
                {
                    if (_toResolve.Count > 0) job = _toResolve.Dequeue();
                    else if (_resolverStop) return;
                }
                if (job == null)
                {
                    /* Idle, so this is where the foreground window gets watched. No second hook and no
                     * second message pump: SetWinEventHook needs one, this thread is already awake, and a
                     * poll every 15ms is far finer than a person can switch windows. */
                    try { NoteForeground(); }
                    catch { /* a window that vanished mid-read is not worth ending the resolver for */ }
                    Thread.Sleep(15);
                    continue;
                }

                try { if (job.Focused) DescribeFocused(job); else Describe(job); }
                catch { /* One unreadable control must not end the resolver for the rest of the recording. */ }
            }
        }

        /* ------------------------------------------------------------------ which application, per step
         *
         * A click hit-tests its own target, so it always knew where it was. Nothing else did: a scroll, a
         * wait and a run of typing carry no position worth testing, and a transcript placed them in
         * whichever segment a click had last opened. A `Focus` event closes that - it is not an action, it
         * is a marker saying the work moved, and it is the only thing that can place a step that clicked
         * nothing.
         *
         * Runs on the resolver thread while it has nothing else to do, which is why it costs nothing.
         */
        static IntPtr _lastFront = IntPtr.Zero;

        static void NoteForeground()
        {
            IntPtr front = Native.GetForegroundWindow();
            if (front == IntPtr.Zero || front == _lastFront) return;

            Ev e = null;
            lock (Gate)
            {
                if (!_recording) { _lastFront = front; return; }
                /* Never during a gesture. A click that gives a window focus fires this watcher while the
                 * button is still down, and a marker inserted there turns one click into an unreleased press
                 * and a stray release - two wrong steps out of a note that was only meant to add context.
                 *
                 * `_held`, not the last event: the first version of this looked at whether the last buffered
                 * event was a Click Down, and a pointer that drifted one pixel in the meantime put a Mouse
                 * Movement in between and walked straight through the guard. That is not hypothetical - it
                 * is what happened, 142ms after a press on a Teams sharing bar.
                 *
                 * `_lastFront` is deliberately not updated, so the change is noticed again next tick, once
                 * the button is up. */
                if (_held > 0) return;

                long now = _clock.ElapsedMilliseconds;
                e = new Ev();
                e.X = _lastX;
                e.Y = _lastY;
                e.DelayMs = _buffer.Count == 0 ? 0 : (int)(now - _lastStamp);
                e.Action = "Focus";
                _buffer.Add(e);
                _lastStamp = now;
            }
            _lastFront = front;
            /* Window only. A foreground change has no control under it, and inventing one from the pointer -
             * which is wherever it was left - would attribute a name to a step it had nothing to do with. */
            DescribeWindow(e, front);
        }

        /* What has focus, for a run of typing. Read at resolve time rather than at the keystroke, so a
         * person who types and immediately clicks elsewhere can have the later window recorded here - the
         * resolver is normally a few milliseconds behind, and the alternative is a UIA call inside the
         * keyboard hook, which is how a hook gets removed by Windows for being slow. */
        static void DescribeFocused(Pending job)
        {
            IntPtr hwnd = Native.GetForegroundWindow();
            if (hwnd != IntPtr.Zero) DescribeWindow(job.Target, hwnd);

            AutomationElement el = AutomationElement.FocusedElement;
            if (el == null) return;

            string name = null;
            string type = null;
            AutomationElement at = el;
            /* Three levels, not five: what has focus is usually the field itself, and a climb from a text
             * area lands on the document and then on the window, which is already known. */
            for (int climbed = 0; climbed <= 3 && at != null; climbed++)
            {
                string candidate = null;
                string kind = null;
                try
                {
                    candidate = at.Current.Name;
                    kind = at.Current.LocalizedControlType;
                }
                catch { break; }

                if (type == null) type = kind;
                if (!string.IsNullOrEmpty(candidate)) { name = candidate; type = kind; break; }

                try { at = TreeWalker.ControlViewWalker.GetParent(at); }
                catch { break; }
            }

            job.Target.Control = string.IsNullOrEmpty(name) ? null : Clip(name, 120);
            job.Target.ControlType = string.IsNullOrEmpty(type) ? null : Clip(type, 40);
            /* The typing job too: a typing run is where a portable skill's inputs go, and a step saying
             * which page it went into is the difference between an instruction and a guess. */
            job.Target.Url = PageUrl(el);
        }

        /* The title and the process, from the window manager rather than from an accessibility provider -
         * which is why it works where UIA does not: an Electron app that names no controls still says
         * "Claude". Shared by every path that needs to name a window. */
        static void DescribeWindow(Ev target, IntPtr hwnd)
        {
            if (target == null || hwnd == IntPtr.Zero) return;
            IntPtr top = Native.GetAncestor(hwnd, Native.GA_ROOT);
            if (top != IntPtr.Zero) hwnd = top;

            target.Window = TitleOf(hwnd);
            uint pid;
            Native.GetWindowThreadProcessId(hwnd, out pid);
            if (pid == 0) return;
            try
            {
                using (Process proc = Process.GetProcessById((int)pid))
                {
                    target.Process = proc.ProcessName;
                }
            }
            catch { /* Exited between the event and now. The title is still worth keeping. */ }
        }

        /* The window first, because it is cheap and it works even where UIA does not: a process name and a
         * title come from the window manager, not from an accessibility provider, so an Electron app that
         * names no controls still says "Claude". Then the control, which is the part worth having. */
        static void Describe(Pending job)
        {
            DescribeWindow(job.Target, Native.WindowFromPoint(new POINT { X = job.X, Y = job.Y }));

            AutomationElement el = AutomationElement.FromPoint(new System.Windows.Point(job.X, job.Y));
            if (el == null) return;

            /* Climb for a name. A hit test often lands on an unnamed `group` or `custom` wrapper while the
             * thing a person would call the target is its parent - measured, this takes naming from 59/106
             * to 82/110. Five levels, because beyond that the answer is the window and the window is
             * already known. */
            string name = null;
            string type = null;
            AutomationElement at = el;
            for (int climbed = 0; climbed <= 5 && at != null; climbed++)
            {
                string candidate = null;
                string kind = null;
                try
                {
                    candidate = at.Current.Name;
                    kind = at.Current.LocalizedControlType;
                }
                catch { break; }   // the element went away mid-read; whatever was found so far stands

                if (type == null) type = kind;
                if (!string.IsNullOrEmpty(candidate)) { name = candidate; type = kind; break; }

                try { at = TreeWalker.ControlViewWalker.GetParent(at); }
                catch { break; }
            }

            job.Target.Control = string.IsNullOrEmpty(name) ? null : Clip(name, 120);
            job.Target.ControlType = string.IsNullOrEmpty(type) ? null : Clip(type, 40);
            job.Target.Url = PageUrl(el);
        }

        /* The address of the page a click landed on, ORIGIN AND PATH ONLY.
         *
         * In Chromium and in Edge the Document element carries the url as its ValuePattern - that is where
         * a browser puts it, and it is the same in both. Found by climbing UP from what was hit, never by
         * searching down: PROTOCOL.md forbids walking the tree on this path because a full control-view
         * walk is 0.6-4.4 seconds per window, and FindFirst over a browser's descendants is exactly that
         * walk. Climbing is bounded and cheap, and a page element always has a Document above it.
         *
         * WHY THE CUT IS HERE. A query string is where a session token, a one-time sign-in link and
         * whatever somebody typed into a search box live. Everything past this point copies the payload
         * around - to the account, to a model, into files people download and forward - so a value that
         * never entered the recording cannot leak from any of them. Cutting it downstream would mean every
         * one of those paths had to remember to.
         *
         * Nothing found is the normal answer, not a failure: a desktop application has no Document with a
         * url in it, and the export that wants one says so rather than inventing it.
         */
        static string PageUrl(AutomationElement from)
        {
            AutomationElement at = from;
            for (int climbed = 0; climbed <= 8 && at != null; climbed++)
            {
                try
                {
                    if (at.Current.ControlType == ControlType.Document)
                    {
                        object pattern;
                        if (at.TryGetCurrentPattern(ValuePattern.Pattern, out pattern))
                        {
                            string raw = ((ValuePattern)pattern).Current.Value;
                            return Bare(raw);
                        }
                        return null;
                    }
                    at = TreeWalker.ControlViewWalker.GetParent(at);
                }
                catch { return null; }   // the element went away mid-read
            }
            return null;
        }

        /* Origin and path. Uri rather than string surgery: a url with a colon in its path, or one with no
         * path at all, is where hand-rolled splitting goes wrong. */
        static string Bare(string raw)
        {
            if (string.IsNullOrEmpty(raw)) return null;
            Uri parsed;
            if (!Uri.TryCreate(raw, UriKind.Absolute, out parsed)) return null;
            if (parsed.Scheme != Uri.UriSchemeHttp && parsed.Scheme != Uri.UriSchemeHttps) return null;
            string path = parsed.AbsolutePath == "/" ? "" : parsed.AbsolutePath;
            return Clip(parsed.GetLeftPart(UriPartial.Authority) + path, 300);
        }

        static string Clip(string text, int max)
        {
            if (text == null) return null;
            text = text.Replace("\r", " ").Replace("\n", " ").Replace("|", "/").Trim();
            return text.Length <= max ? text : text.Substring(0, max - 1) + "\u2026";
        }

        static string TitleOf(IntPtr hwnd)
        {
            StringBuilder sb = new StringBuilder(300);
            Native.GetWindowText(hwnd, sb, sb.Capacity);
            string title = sb.ToString();
            return string.IsNullOrEmpty(title) ? null : Clip(title, 160);
        }

        /* The tray's "Stop and Save Recording". Capture stops NOW; the events are HELD, because the agent
         * has no account to put them on - the app does, and its Record page collects a held recording
         * through the ordinary /record/stop the moment it notices. `recording:false` with `count>0` on
         * /record/status is the signal, and it is unambiguous because a client-driven stop never leaves
         * that state behind. Same contract the macOS agent implements; see PROTOCOL.md. */
        public static void EndFromTray()
        {
            /* The buffer is taken in the SAME critical section that drops the flag, and that is the whole
             * correctness of this function. Dropping _recording first and taking the buffer after the
             * resolver wait leaves up to 1.5 seconds where /record/status answers recording:false with
             * count>0 - the protocol's "a hold is waiting" signal - while nothing is held yet: the app's
             * quarter-second poll lands there, calls /record/stop, gets the LIVE path, and this function
             * then finds an empty buffer and holds nothing. The recording survives by the ordinary door,
             * but the spill never happens and the tray says nothing was captured. */
            bool was;
            List<Ev> taken;
            int part; int moveMs; long elapsed;
            lock (Gate)
            {
                was = _recording;
                _recording = false;
                _clock.Stop();
                taken = _buffer;
                _buffer = new List<Ev>();
                /* Held from this instant: _ending covers the gap until the text exists, and both the status
                 * route and RecordStop read it, so no caller can see a hold that is not there yet. */
                _ending = was && taken.Count > 0;
                _heldEvents = taken.Count;
                part = _part; moveMs = _sessionMs; elapsed = _clock.ElapsedMilliseconds;
            }
            if (!was) return;

            if (taken.Count == 0)
            {
                /* Nothing was captured, so there is nothing to hold - and holding nothing would wedge
                 * /record/start behind a refusal for a recording that does not exist. */
                lock (Gate) { _heldEvents = 0; }
                lock (ResolveGate) { _resolverStop = true; }
                return;
            }

            /* Same bounded wait as a client stop, so the held events carry their control names. */
            for (int waited = 0; waited < 1500; waited += 50)
            {
                lock (ResolveGate) { if (_toResolve.Count == 0) break; }
                Thread.Sleep(50);
            }
            int lost;
            lock (ResolveGate) { _resolverStop = true; lost = _dropped; }

            /* Serialized and spilled OUTSIDE Gate, because the low-level hook takes that same lock on every
             * mouse message: a long session is hundreds of thousands of events, and a hook proc blocked
             * across that plus a multi-megabyte write is a hook Windows silently removes for overrunning
             * LowLevelHooksTimeout - the hazard this file documents elsewhere and must not create here.
             * _ending is what makes it safe: a hold is already declared. */
            StringBuilder head = new StringBuilder();
            head.Append("#part\tn=").Append((part + 1).ToString(CultureInfo.InvariantCulture));
            head.Append("\telapsedMs=").Append(elapsed.ToString(CultureInfo.InvariantCulture));
            head.Append("\tevents=").Append(taken.Count.ToString(CultureInfo.InvariantCulture));
            head.Append("\tmoveMs=").Append(moveMs.ToString(CultureInfo.InvariantCulture));
            head.Append("\tdropped=").Append(lost.ToString(CultureInfo.InvariantCulture)).Append("\n");
            string text = head.ToString() + Serialize(taken);
            try
            {
                string p = HeldPath;
                Directory.CreateDirectory(Path.GetDirectoryName(p));
                File.WriteAllText(p, text);
            }
            catch { /* Memory still holds it; the app is usually seconds away. */ }

            lock (Gate)
            {
                _heldText = text;
                _heldEvents = taken.Count;
                _ending = false;
            }
        }

        /* Returns null when the recording started, or the reason it did not - a hold waiting to be saved.
         *
         * moveMs = 0 means "the default this agent was started with". Not -1 and not a nullable: the wire
         * carries a query string, an absent parameter parses to 0, and 0 samples a second is not a thing
         * anybody can want - so the harmless value is the one that means "unspecified". */
        public static string RecordStart(int moveMs)
        {
            lock (Gate)
            {
                if (_heldText != null || _ending)
                {
                    /* Atomic with the state it protects: starting over a hold destroys the one thing the
                     * tray promised to save. */
                    return "a recording stopped at the agent is waiting to be saved - the app's Record page"
                        + " collects it as soon as it is open, and then Record works again";
                }
                /* Clamped, not trusted. A caller asking for 5000 would record four events an hour and call
                 * it a session; one asking for 1 would fill the buffer faster than the drain empties it. */
                _sessionMs = moveMs <= 0 ? _throttleMs : Math.Max(5, Math.Min(2000, moveMs));
                _part = 0;
                _buffer = new List<Ev>();
                _haveLast = false;
                _lastStamp = 0;
                _clock.Reset();
                _clock.Start();
                _recording = true;
            }

            lock (ResolveGate)
            {
                _toResolve.Clear();
                _dropped = 0;
                _resolverStop = false;
                /* Zeroed, not carried: the first Focus event of a recording should name where the recording
                 * STARTED, and a value left over from a previous one would suppress it. */
                _lastFront = IntPtr.Zero;
                // Nothing is held at the start of a recording, whatever was held at the end of the last one.
                _held = 0;
            }

            /* MTA, deliberately. A UIA client on an STA thread marshals every call through that thread's
             * message pump, which is the pump the hook is using - and the point of this thread is to not
             * touch that pump. */
            if (_resolver == null || !_resolver.IsAlive)
            {
                _resolver = new Thread(new ThreadStart(ResolveLoop));
                _resolver.IsBackground = true;
                _resolver.SetApartmentState(ApartmentState.MTA);
                _resolver.Start();
            }
            return null;
        }

        /* Take what has piled up and KEEP RECORDING.
         *
         * The difference from RecordStop is what is NOT touched, and each omission is load-bearing:
         *
         *   _clock       runs on, so elapsedMs stays the time of the session. A chunk knows its own length
         *                by its events; only the session can say how far in it is.
         *   _recording   stays true, or the hook stops capturing between two drains - and the gap would be
         *                invisible afterwards, which is the worst kind.
         *   _lastStamp   stays, so the move filter keeps its reference point across the boundary instead of
         *                letting one unthrottled burst through at the start of every chunk.
         *   _haveLast    stays, same reason.
         *   _held        stays: a drain can land in the middle of a drag, and zeroing the counter would let
         *                a Focus marker split the press from its release in the NEXT chunk.
         *   _lastFront   stays, so a window that did not change is not re-announced every chunk.
         *
         * The first event of the new chunk gets DelayMs 0 because the buffer is empty, which is what a chunk
         * that starts at its own first event should say. The gap across the boundary is not lost - it is in
         * elapsedMs, where it can be read deliberately rather than hidden inside a delay.
         */
        public static string RecordDrain()
        {
            List<Ev> taken;
            long elapsed;
            int part;
            lock (Gate)
            {
                if (!_recording) return null;
                taken = _buffer;
                _buffer = new List<Ev>();
                elapsed = _clock.ElapsedMilliseconds;
                _part++;
                part = _part;
            }

            /* Same bounded wait as the stop, and for the same reason: the resolver writes the application
             * and control names ONTO the events just taken, and serializing ahead of it would drop the name
             * of the last click of every chunk. Shorter than the stop's 1500ms because a drain happens at a
             * clock boundary rather than at a click - whatever is still in flight is seconds old already -
             * and because this one has a person's next thirty minutes waiting behind it. */
            for (int waited = 0; waited < 400; waited += 25)
            {
                lock (ResolveGate) { if (_toResolve.Count == 0) break; }
                Thread.Sleep(25);
            }

            int dropped;
            lock (ResolveGate) { dropped = _dropped; }

            /* A `#part` line above the events. Every reader of this format already skips lines starting with
             * `#` - that is how `#ctx` rides along - so a chunk loads in an older reader exactly as a plain
             * recording does, and a newer one gets to know which chunk it is holding. */
            StringBuilder head = new StringBuilder();
            head.Append("#part\tn=").Append(part.ToString(CultureInfo.InvariantCulture));
            head.Append("\telapsedMs=").Append(elapsed.ToString(CultureInfo.InvariantCulture));
            head.Append("\tevents=").Append(taken.Count.ToString(CultureInfo.InvariantCulture));
            head.Append("\tmoveMs=").Append(_sessionMs.ToString(CultureInfo.InvariantCulture));
            head.Append("\tdropped=").Append(dropped.ToString(CultureInfo.InvariantCulture));
            head.Append("\n");
            return head.ToString() + Serialize(taken);
        }

        public static string RecordStop()
        {
            /* A hold being written is a hold: wait for it rather than racing past it into the live path,
             * which is empty by then anyway. Bounded by the same budget the resolver wait uses. */
            for (int waited = 0; waited < 2000; waited += 50)
            {
                lock (Gate) { if (!_ending) break; }
                Thread.Sleep(50);
            }
            List<Ev> taken;
            lock (Gate)
            {
                if (_heldText != null)
                {
                    /* Taking delivery of a hold: the text was serialized when the tray stopped the
                     * recording, so there is nothing to wait for - hand it over and forget it, on disk too. */
                    string text = _heldText;
                    _heldText = null;
                    _heldEvents = 0;
                    try { File.Delete(HeldPath); } catch { }
                    return text;
                }
                _recording = false;
                _clock.Stop();
                taken = _buffer;
                _buffer = new List<Ev>();
            }

            /* Give the resolver a moment to finish what it already has. Bounded, because a recording that
             * hangs on stop is worse than a transcript missing the last control name - and whatever is still
             * unresolved simply stays null, which the format already means as "not known". */
            for (int waited = 0; waited < 1500; waited += 50)
            {
                lock (ResolveGate) { if (_toResolve.Count == 0) break; }
                Thread.Sleep(50);
            }
            lock (ResolveGate) { _resolverStop = true; }

            return Serialize(taken);
        }

        /* Context rides on a COMMENT line above its event.
         *
         * The .mmmacro line is `index | X | Y | delayMs | action` and anything reading it - Mini Mouse Macro
         * itself included - would choke on a sixth column. Lines starting with # are already ignored by
         * every reader of this format, including web/src/lib/macro.ts, so an older reader loads the recording
         * exactly as it did before and a newer one gets the context. Deliberately not JSON: a tab-separated
         * pair list survives a title containing a quote, a brace or a colon without an encoder.
         */
        static void WriteContext(StringBuilder sb, Ev e)
        {
            if (e.Process == null && e.Window == null && e.Control == null && e.Url == null) return;
            sb.Append("#ctx");
            if (e.Process != null) { sb.Append("\tapp="); sb.Append(e.Process); }
            if (e.Window != null) { sb.Append("\twindow="); sb.Append(e.Window); }
            if (e.Control != null) { sb.Append("\tcontrol="); sb.Append(e.Control); }
            if (e.ControlType != null) { sb.Append("\ttype="); sb.Append(e.ControlType); }
            /* Added after the four that were always here. PROTOCOL.md: unknown keys are skipped rather than
             * being an error, so an older reader loads this exactly as it did before. */
            if (e.Url != null) { sb.Append("\turl="); sb.Append(e.Url); }
            sb.Append("\n");
        }

        public static string Serialize(List<Ev> list)
        {
            StringBuilder sb = new StringBuilder();
            for (int i = 0; i < list.Count; i++)
            {
                Ev e = list[i];
                WriteContext(sb, e);
                sb.Append((i + 1).ToString(CultureInfo.InvariantCulture));
                sb.Append(" | ");
                sb.Append(e.X.ToString(CultureInfo.InvariantCulture));
                sb.Append(" | ");
                sb.Append(e.Y.ToString(CultureInfo.InvariantCulture));
                sb.Append(" | ");
                sb.Append(e.DelayMs.ToString(CultureInfo.InvariantCulture));
                sb.Append(" | ");
                sb.Append(e.Action);
                sb.Append("\n");
            }
            return sb.ToString();
        }

        public static bool IsRecording { get { lock (Gate) { return _recording; } } }
        /* _ending counts as held: between the flag dropping and the text existing the events are already
         * out of the buffer, and a count of zero there would read as "nothing was recorded". */
        public static int RecordCount { get { lock (Gate) { return (_heldText != null || _ending) ? _heldEvents : _buffer.Count; } } }
        /// What the TRAY shows. The wire signal is RecordCount over /record/status, not this.
        public static bool HasHeld { get { lock (Gate) { return _heldText != null; } } }
        public static int HeldEvents { get { lock (Gate) { return _heldEvents; } } }
        /// Without the mouse hook nothing can be recorded, so the tray must not offer to start one.
        public static bool HookInstalled { get { return _hook != IntPtr.Zero; } }
        public static int RecordPart { get { lock (Gate) { return _part; } } }
        public static int RecordMoveMs { get { lock (Gate) { return _sessionMs; } } }
        public static long RecordElapsed { get { lock (Gate) { return _clock.ElapsedMilliseconds; } } }
        public static bool IsPlaying { get { lock (Gate) { return _playing; } } }

        public static string ReplayStatusJson()
        {
            lock (Gate)
            {
                return "{\"playing\":" + (_playing ? "true" : "false")
                    + ",\"step\":" + _stepIdx.ToString(CultureInfo.InvariantCulture)
                    + ",\"steps\":" + _stepCount.ToString(CultureInfo.InvariantCulture)
                    + ",\"pass\":" + _pass.ToString(CultureInfo.InvariantCulture)
                    + ",\"passes\":" + _passes.ToString(CultureInfo.InvariantCulture)
                    + ",\"flowPass\":" + _flowPass.ToString(CultureInfo.InvariantCulture)
                    + ",\"flowPasses\":" + _flowPasses.ToString(CultureInfo.InvariantCulture)
                    + ",\"index\":" + _evIdx.ToString(CultureInfo.InvariantCulture)
                    + ",\"total\":" + _evCount.ToString(CultureInfo.InvariantCulture)
                    /* Events this replay skipped because it cannot perform them - keystrokes, whose keys
                       were never recorded, and focus markers, which are notes rather than actions. Without
                       this a replay of a recording that was half typing reports a clean run. */
                    + ",\"unplayable\":" + _unplayable.ToString(CultureInfo.InvariantCulture)
                    + ",\"retargeted\":" + _retargeted.ToString(CultureInfo.InvariantCulture)
                    + "}";
            }
        }

        // ---------- replay ----------

        public static void Abort() { lock (Gate) { _abort = true; } }

        public static string StartReplay(string body)
        {
            lock (Gate) { if (_playing) return "already playing"; }

            Flow flow = ParseFlow(body);
            if (flow.Steps.Count == 0) return "no steps in body";

            int totalEvents = 0;
            for (int i = 0; i < flow.Steps.Count; i++) totalEvents += flow.Steps[i].Events.Count;
            if (totalEvents == 0) return "flow contains no events";

            lock (Gate)
            {
                _playing = true;
                _abort = false;
                _unplayable = 0;
                _retargeted = 0;
                _stepIdx = 0;
                _stepCount = flow.Steps.Count;
                _pass = 0;
                _passes = 0;
                _flowPass = 0;
                _flowPasses = flow.Repeat;
                _evIdx = 0;
                _evCount = 0;
            }

            ReplayJob job = new ReplayJob(flow);
            Thread t = new Thread(new ThreadStart(job.Run));
            t.IsBackground = true;
            t.Name = "MouseFlowReplay";
            t.Start();
            return null;
        }

        class ReplayJob
        {
            Flow _flow;
            public ReplayJob(Flow flow) { _flow = flow; }

            public void Run()
            {
                try
                {
                    if (!SleepAbortable(_flow.StartDelayMs)) { Finish(true); return; }

                    // Repeat <= 0 means loop until aborted, at both flow and step level.
                    bool flowForever = _flow.Repeat <= 0;
                    int flowTarget = flowForever ? int.MaxValue : _flow.Repeat;

                    for (int fp = 1; fp <= flowTarget; fp++)
                    {
                        lock (Gate) { _flowPass = fp; }

                        for (int s = 0; s < _flow.Steps.Count; s++)
                        {
                            Step st = _flow.Steps[s];
                            bool stepForever = st.Repeat <= 0;
                            int stepTarget = stepForever ? int.MaxValue : st.Repeat;

                            for (int p = 1; p <= stepTarget; p++)
                            {
                                lock (Gate)
                                {
                                    _stepIdx = s + 1;
                                    _pass = p;
                                    _passes = stepForever ? 0 : st.Repeat;
                                    _evCount = st.Events.Count;
                                    _evIdx = 0;
                                }

                                for (int i = 0; i < st.Events.Count; i++)
                                {
                                    if (ShouldStop()) { Finish(true); return; }
                                    Ev e = st.Events[i];
                                    if (!SleepAbortable((int)Math.Round(e.DelayMs / st.Speed))) { Finish(true); return; }
                                    Emit(e);
                                    lock (Gate) { _evIdx = i + 1; }
                                }

                                if (st.DelayAfterMs > 0 && !SleepAbortable(st.DelayAfterMs)) { Finish(true); return; }
                            }
                        }
                    }
                    Finish(false);
                }
                catch (Exception ex)
                {
                    LastError = ex.Message;
                    Finish(true);
                }
            }

            void Finish(bool aborted)
            {
                /* Unconditionally, not only on abort: a flow whose last event is a button-down used to
                 * leave the mouse held down over the desktop, and everything after it dragged. */
                ReleaseAllButtons();
                lock (Gate) { _playing = false; }
            }
        }

        static bool ShouldStop()
        {
            lock (Gate) { if (_abort) return true; }
            return (Native.GetAsyncKeyState(Native.VK_ESCAPE) & 0x8000) != 0;
        }

        // Thread.Sleep resolution is ~15 ms, so spin the tail to keep short gaps honest.
        static bool SleepAbortable(int ms)
        {
            if (ms <= 0) return !ShouldStop();
            Stopwatch sw = Stopwatch.StartNew();
            while (sw.Elapsed.TotalMilliseconds < ms)
            {
                if (ShouldStop()) return false;
                double remaining = ms - sw.Elapsed.TotalMilliseconds;
                if (remaining > 30) Thread.Sleep(15);
                else Thread.SpinWait(1500);
            }
            return true;
        }

        /* How many events the last injection actually delivered, and what Windows said if it did not.
         * Checked at the top of DoAction's return path rather than at each call site, so no action can
         * forget to look. */
        static int _injected;
        static int _injectFailures;
        static int _lastError;

        static void ResetInjection()
        {
            _injected = 0;
            _injectFailures = 0;
            _lastError = 0;
        }

        static string InjectionProblem()
        {
            if (_injectFailures == 0) return null;
            string reason;
            switch (_lastError)
            {
                case 5:
                    reason = "access denied - the window in front is running as administrator, and " +
                        "input from an ordinary program cannot reach it";
                    break;
                case 0:
                    reason = "the screen may be locked, or a secure prompt has the desktop";
                    break;
                default:
                    reason = "Windows error " + _lastError.ToString(CultureInfo.InvariantCulture);
                    break;
            }
            return "the input was refused: " + reason;
        }

        static void Injected(uint sent, uint wanted)
        {
            if (sent >= wanted) { _injected += (int)sent; return; }
            _injectFailures++;
            _lastError = Marshal.GetLastWin32Error();
        }

        static void Emit(Ev e)
        {
            int vx = Native.GetSystemMetrics(Native.SM_XVIRTUALSCREEN);
            int vy = Native.GetSystemMetrics(Native.SM_YVIRTUALSCREEN);
            int vw = Native.GetSystemMetrics(Native.SM_CXVIRTUALSCREEN);
            int vh = Native.GetSystemMetrics(Native.SM_CYVIRTUALSCREEN);
            if (vw < 2) vw = 2;
            if (vh < 2) vh = 2;

            /* Aim by NAME before pressing, when the recording left one.
             *
             * Only on the press, and the release follows wherever the press went - releasing at the
             * recorded coordinate after pressing somewhere else turns one click into a drag across the
             * window, which PROTOCOL.md says outright and which is the failure worth avoiding here. */
            int ax = e.X;
            int ay = e.Y;
            if (IsPress(e.Action)) Retarget(e, ref ax, ref ay);

            int nx = (int)Math.Round((ax - vx) * 65535.0 / (vw - 1));
            int ny = (int)Math.Round((ay - vy) * 65535.0 / (vh - 1));

            uint flags = Native.MOUSEEVENTF_MOVE | Native.MOUSEEVENTF_ABSOLUTE | Native.MOUSEEVENTF_VIRTUALDESK;
            uint data = 0;

            switch (e.Action)
            {
                case "Mouse Movement": break;
                case "Left Click Down": flags |= Native.MOUSEEVENTF_LEFTDOWN; break;
                case "Left Click Release":
                case "Left Click Up": flags |= Native.MOUSEEVENTF_LEFTUP; break;
                case "Right Click Down": flags |= Native.MOUSEEVENTF_RIGHTDOWN; break;
                case "Right Click Release":
                case "Right Click Up": flags |= Native.MOUSEEVENTF_RIGHTUP; break;
                case "Middle Click Down": flags |= Native.MOUSEEVENTF_MIDDLEDOWN; break;
                case "Middle Click Release":
                case "Middle Click Up": flags |= Native.MOUSEEVENTF_MIDDLEUP; break;
                case "Scroll Up": flags |= Native.MOUSEEVENTF_WHEEL; data = 120; break;
                case "Scroll Down": flags |= Native.MOUSEEVENTF_WHEEL; data = unchecked((uint)-120); break;

                /* Named rather than left to `default`, because these two are not malformed lines - they are
                 * events this agent writes on purpose and cannot perform. A keystroke has no key in it, and
                 * a Focus is a note about what happened, not something to do. The pause before each is
                 * still waited out by the caller, so a replay keeps the shape of the original; it just
                 * presses nothing where a person typed. Counted so /replay/status can say so. */
                case "Key Down":
                case "Focus":
                    lock (Gate) { _unplayable++; }
                    return;

                default:
                    /* A key recorded BY NAME is played, through the same PressKey the /do route uses.
                     *
                     * The case above catches "Key Down" FIRST and that order is the guard: parsed as a
                     * name, the legacy anonymous typing event reads as a key called "Down", so replaying
                     * somebody typing would press the down arrow once per keystroke. It is excluded again
                     * here by name, for the reader who moves these branches around. */
                    if (action != null && action.StartsWith("Key ") && action != "Key Down")
                    {
                        string spec = action.Substring(4);
                        string[] parts = spec.Split('+');
                        string name = parts.Length > 0 ? parts[parts.Length - 1] : "";
                        bool wantCtrl = false, wantShift = false, wantAlt = false;
                        for (int m = 0; m < parts.Length - 1; m++)
                        {
                            string mod = parts[m].ToLowerInvariant();
                            if (mod == "ctrl") wantCtrl = true;
                            else if (mod == "shift") wantShift = true;
                            else if (mod == "alt") wantAlt = true;
                        }
                        if (PressKey(name, wantCtrl, wantShift, wantAlt) != null)
                        {
                            /* PressKey refused the name - a recording from a later build naming a key this
                             * one does not know. Counted, never guessed at. */
                            lock (Gate) { _unplayable++; }
                        }
                        return;
                    }
                    return;
            }

            INPUT[] inputs = new INPUT[1];
            inputs[0].type = Native.INPUT_MOUSE;
            inputs[0].mi.dx = nx;
            inputs[0].mi.dy = ny;
            inputs[0].mi.mouseData = data;
            inputs[0].mi.dwFlags = flags;
            inputs[0].mi.time = 0;
            inputs[0].mi.dwExtraInfo = IntPtr.Zero;
            Injected(Native.SendInput(1, inputs, Marshal.SizeOf(typeof(INPUT))), 1);
        }

        static bool IsPress(string action)
        {
            return action == "Left Click Down" || action == "Right Click Down" || action == "Middle Click Down";
        }

        /* Where this click should actually land.
         *
         * The recorded point is a guess about a layout, and the name is the thing. Hit-test the point; if
         * what is under it is already the named control, nothing to do - which is the common case and costs
         * one UIA call. If it is something else, look ONE LEVEL among the siblings of whatever IS there:
         * a re-laid-out row of tabs, buttons or list rows keeps its neighbours exactly there, and that is
         * the case that fails. Not a tree walk - PROTOCOL.md forbids walking because a full control-view
         * walk is 0.6-4.4 seconds per window, and the same arithmetic applies on this side.
         *
         * Everything here fails soft: no name, no element, no clickable point, or UIA throwing because the
         * screen moved under it, all mean "press where it was recorded". A replay that refused because an
         * accessibility call failed would be worse than one that aimed by coordinate.
         */
        static void Retarget(Ev e, ref int x, ref int y)
        {
            if (e == null || string.IsNullOrEmpty(e.Control)) return;
            try
            {
                AutomationElement at = AutomationElement.FromPoint(new System.Windows.Point(x, y));
                if (at == null) return;
                if (string.Equals(at.Current.Name, e.Control, StringComparison.Ordinal)) return;

                AutomationElement parent = TreeWalker.ControlViewWalker.GetParent(at);
                if (parent == null) return;
                AutomationElement found = parent.FindFirst(TreeScope.Children,
                    new PropertyCondition(AutomationElement.NameProperty, e.Control));
                if (found == null) return;

                System.Windows.Point where;
                if (!found.TryGetClickablePoint(out where)) return;
                x = (int)Math.Round(where.X);
                y = (int)Math.Round(where.Y);
                lock (Gate) { _retargeted++; }
            }
            catch { /* the screen moved under the read; the recorded point stands */ }
        }

        /* ---------------------------------------------------------------- one action at a time
         *
         * Replay performs a recording; these perform a decision. The web app describes a goal, a model
         * looks at /shot and picks the next thing to do, and this is where that lands. Same SendInput
         * path as replay, so what the OS sees is identical - the difference is only who chose it.
         */

        /* Ev is a field-holder with no constructor; the existing code fills one in place, so this
           does the same rather than adding a constructor other code would then have two ways to use. */
        static Ev At(int x, int y, string action)
        {
            Ev e = new Ev();
            e.X = x;
            e.Y = y;
            e.DelayMs = 0;
            e.Action = action;
            return e;
        }

        public static string DoAction(string body)
        {
            Dictionary<string, string> a = ParseFields(body);
            string action = Get(a, "action", "");
            ResetInjection();

            string problem = Perform(action, a);
            if (problem != null) return problem;
            /* An action that was accepted, encoded and sent, and that the OS then discarded, must not be
             * reported as done. Checked once, here, so every action is covered by construction. */
            return InjectionProblem();
        }

        static string Perform(string action, Dictionary<string, string> a)
        {
            if (action == "type")
            {
                /* Base64 when the text has anything in it the line-based format cannot carry - a newline
                 * above all. `text=` runs to the end of the line by design, so a literal newline would
                 * end the field; flattening them to spaces instead is what turned a five-paragraph email
                 * into one inline sentence and left the model fighting its own formatting afterwards.
                 *
                 * nl=shift presses Shift+Enter for each break: in a chat box, and in some comment fields,
                 * a plain Enter sends rather than breaks the line. */
                string typing = Get(a, "text", "");
                if (Get(a, "enc", "") == "b64")
                {
                    typing = DecodeB64(typing);
                    if (typing == null) return "the text was not valid base64";
                }
                return TypeText(typing, Get(a, "nl", "enter") == "shift");
            }
            if (action == "activate") return Activate(Get(a, "title", ""), Get(a, "process", ""));
            if (action == "key")
            {
                return PressKey(Get(a, "key", ""), Get(a, "ctrl", "0") == "1",
                    Get(a, "shift", "0") == "1", Get(a, "alt", "0") == "1");
            }

            int x, y;
            if (!int.TryParse(Get(a, "x", ""), NumberStyles.Integer, CultureInfo.InvariantCulture, out x) ||
                !int.TryParse(Get(a, "y", ""), NumberStyles.Integer, CultureInfo.InvariantCulture, out y))
            {
                return "x and y are required for " + (action.Length > 0 ? action : "an action");
            }

            /* On the screen, or not at all. Windows CLAMPS an out-of-range absolute coordinate to the
             * edge of the desktop, so a bad point does not fail - it clicks a corner, which is both
             * wrong and occasionally destructive. Better a message the model can correct from. */
            int vx = Native.GetSystemMetrics(Native.SM_XVIRTUALSCREEN);
            int vy = Native.GetSystemMetrics(Native.SM_YVIRTUALSCREEN);
            int vw = Native.GetSystemMetrics(Native.SM_CXVIRTUALSCREEN);
            int vh = Native.GetSystemMetrics(Native.SM_CYVIRTUALSCREEN);
            if (x < vx || y < vy || x >= vx + vw || y >= vy + vh)
            {
                return "x=" + x.ToString(CultureInfo.InvariantCulture) + " y=" +
                    y.ToString(CultureInfo.InvariantCulture) + " is off the screen - the desktop runs " +
                    vx.ToString(CultureInfo.InvariantCulture) + "," + vy.ToString(CultureInfo.InvariantCulture) +
                    " to " + (vx + vw - 1).ToString(CultureInfo.InvariantCulture) + "," +
                    (vy + vh - 1).ToString(CultureInfo.InvariantCulture);
            }

            if (action == "move")
            {
                Emit(At(x, y, "Mouse Movement"));
                return null;
            }

            if (action == "scroll")
            {
                int amount;
                if (!int.TryParse(Get(a, "amount", "-3"), NumberStyles.Integer, CultureInfo.InvariantCulture, out amount)) amount = -3;
                Emit(At(x, y, "Mouse Movement"));
                int steps = Math.Min(20, Math.Abs(amount));
                for (int i = 0; i < steps; i++)
                {
                    Emit(At(x, y, amount > 0 ? "Scroll Up" : "Scroll Down"));
                    Thread.Sleep(25);
                }
                return null;
            }

            if (action == "click")
            {
                string button = Get(a, "button", "left");
                bool twice = Get(a, "double", "0") == "1";
                string down = button == "right" ? "Right Click Down" : (button == "middle" ? "Middle Click Down" : "Left Click Down");
                string up = button == "right" ? "Right Click Release" : (button == "middle" ? "Middle Click Release" : "Left Click Release");

                /* Moved first and given a moment to land. Clicking at a position the pointer has not
                   reached yet is how a click ends up on whatever was under the old position. */
                Emit(At(x, y, "Mouse Movement"));
                Thread.Sleep(40);
                Emit(At(x, y, down));
                Thread.Sleep(30);
                Emit(At(x, y, up));
                if (twice)
                {
                    Thread.Sleep(60);
                    Emit(At(x, y, down));
                    Thread.Sleep(30);
                    Emit(At(x, y, up));
                }
                return null;
            }

            return "unknown action: " + action;
        }

        static Dictionary<string, string> ParseFields(string body)
        {
            /* key=value pairs, and `text` takes the rest of the line - so typed text may contain
               spaces and equals signs without needing a quoting rule nobody would remember. */
            Dictionary<string, string> found = new Dictionary<string, string>();
            if (body == null) return found;
            string line = body.Replace("\r", " ").Replace("\n", " ").Trim();

            /* `text` and `title` both run to the end of the line: one is a message, the other a window
             * title, and both contain spaces. Taken at a TOKEN boundary only - a caption containing
             * "subtitle=" or "action=click" is then just characters in a title rather than a field that
             * overrides the action. Whichever marker comes first wins the rest of the line, so the two
             * can never both claim it. */
            int rest = -1;
            string restKey = null;
            foreach (string marker in new string[] { "text=", "title=" })
            {
                int at = FindField(line, marker);
                if (at >= 0 && (rest < 0 || at < rest)) { rest = at; restKey = marker.Substring(0, marker.Length - 1); }
            }
            if (rest >= 0)
            {
                found[restKey] = line.Substring(rest + restKey.Length + 1);
                line = line.Substring(0, rest);
            }

            string[] parts = line.Split(new char[] { ' ', '\t' }, StringSplitOptions.RemoveEmptyEntries);
            for (int i = 0; i < parts.Length; i++)
            {
                int eq = parts[i].IndexOf('=');
                if (eq <= 0) continue;
                string key = parts[i].Substring(0, eq).Trim().ToLowerInvariant();
                if (key == "text" || key == "title") continue;   // already taken, whole and unsplit
                found[key] = parts[i].Substring(eq + 1).Trim();
            }
            return found;
        }

        /* A field marker only counts at the start of a token. Without this, "subtitle=" contains "title="
         * and the parse would begin four characters into the wrong word. */
        static int FindField(string line, string marker)
        {
            int at = 0;
            while (at <= line.Length - marker.Length)
            {
                int hit = line.IndexOf(marker, at, StringComparison.Ordinal);
                if (hit < 0) return -1;
                if (hit == 0 || line[hit - 1] == ' ' || line[hit - 1] == '\t') return hit;
                at = hit + 1;
            }
            return -1;
        }

        static string Get(Dictionary<string, string> from, string key, string fallback)
        {
            string value;
            return from.TryGetValue(key, out value) ? value : fallback;
        }

        /* UTF-8, so anything the user might actually write survives - accents, quotes, an em dash. */
        public static string DecodeB64(string encoded)
        {
            if (encoded == null) return null;
            try
            {
                return Encoding.UTF8.GetString(Convert.FromBase64String(encoded.Trim()));
            }
            catch (Exception)
            {
                return null;
            }
        }

        static string TypeText(string text, bool shiftNewline)
        {
            if (text == null || text.Length == 0) return "nothing to type";
            if (text.Length > 8000) return "that is more text than this will type in one go";

            /* Sent as Unicode rather than as virtual keys: a keycode depends on the keyboard layout,
               and text typed through them comes out wrong on any layout but the author's. */
            for (int i = 0; i < text.Length; i++)
            {
                char c = text[i];
                if (c == '\r') continue;                 // CRLF is one break, not two
                if (c == '\n')
                {
                    PressKey("Enter", false, shiftNewline, false);
                    /* A break usually makes the application do something - reflow a paragraph, start a
                     * list item, grow a box - and typing into it mid-reflow drops characters. */
                    Thread.Sleep(60);
                    continue;
                }
                SendUnicode(c, false);
                SendUnicode(c, true);
                Thread.Sleep(6);
            }
            return null;
        }

        static void SendUnicode(char c, bool up)
        {
            INPUTU[] inputs = new INPUTU[1];
            inputs[0].type = Native.INPUT_KEYBOARD;
            inputs[0].u.ki.wVk = 0;
            inputs[0].u.ki.wScan = (ushort)c;
            inputs[0].u.ki.dwFlags = Native.KEYEVENTF_UNICODE | (up ? Native.KEYEVENTF_KEYUP : 0);
            inputs[0].u.ki.time = 0;
            inputs[0].u.ki.dwExtraInfo = IntPtr.Zero;
            Injected(Native.SendInput(1, inputs, Marshal.SizeOf(typeof(INPUTU))), 1);
        }

        static void SendVk(ushort vk, bool up)
        {
            INPUTU[] inputs = new INPUTU[1];
            inputs[0].type = Native.INPUT_KEYBOARD;
            inputs[0].u.ki.wVk = vk;
            inputs[0].u.ki.wScan = 0;
            inputs[0].u.ki.dwFlags = up ? Native.KEYEVENTF_KEYUP : 0;
            inputs[0].u.ki.time = 0;
            inputs[0].u.ki.dwExtraInfo = IntPtr.Zero;
            Injected(Native.SendInput(1, inputs, Marshal.SizeOf(typeof(INPUTU))), 1);
        }

        /* What the keyboard layout itself requires to produce this character. */
        static void ModifiersFor(string key, ref bool ctrl, ref bool shift, ref bool alt)
        {
            if (key == null || key.Length != 1) return;
            short scan = Native.VkKeyScan(key[0]);
            if (scan == -1) return;
            int state = (scan >> 8) & 0xFF;
            if ((state & 1) != 0) shift = true;
            if ((state & 2) != 0) ctrl = true;
            if ((state & 4) != 0) alt = true;
        }

        static string PressKey(string key, bool ctrl, bool shift, bool alt)
        {
            ushort vk = VkFor(key);
            if (vk == 0) return "unknown key: " + key;
            ModifiersFor(key, ref ctrl, ref shift, ref alt);

            if (ctrl) SendVk(0x11, false);
            if (shift) SendVk(0x10, false);
            if (alt) SendVk(0x12, false);
            SendVk(vk, false);
            Thread.Sleep(25);
            SendVk(vk, true);
            if (alt) SendVk(0x12, true);
            if (shift) SendVk(0x10, true);
            if (ctrl) SendVk(0x11, true);
            return null;
        }

        static ushort VkFor(string key)
        {
            if (key == null || key.Length == 0) return 0;
            /* A single character goes through the layout, because a shortcut IS a keycode - Ctrl+C is
               Ctrl plus VK_C, not Ctrl plus the letter c. Text uses TypeText instead. */
            if (key.Length == 1)
            {
                short scan = Native.VkKeyScan(key[0]);
                if (scan == -1) return 0;
                return (ushort)(scan & 0xFF);
            }
            /* The high byte carries the modifiers the LAYOUT needs for that character - shift for an
             * uppercase letter or a percent sign, AltGr for others. Dropping it turned key=A into a
             * lowercase a and key=% into 5; see ModifiersFor, which PressKey folds in. */

            switch (key.ToLowerInvariant())
            {
                case "enter": case "return": return 0x0D;
                case "tab": return 0x09;
                case "escape": case "esc": return 0x1B;
                case "backspace": return 0x08;
                case "delete": case "del": return 0x2E;
                case "space": return 0x20;
                case "up": case "arrowup": return 0x26;
                case "down": case "arrowdown": return 0x28;
                case "left": case "arrowleft": return 0x25;
                case "right": case "arrowright": return 0x27;
                case "home": return 0x24;
                case "end": return 0x23;
                case "pageup": return 0x21;
                case "pagedown": return 0x22;
                case "f1": return 0x70;
                case "f2": return 0x71;
                case "f3": return 0x72;
                case "f4": return 0x73;
                case "f5": return 0x74;
                case "f6": return 0x75;
                case "f11": return 0x7A;
                case "f12": return 0x7B;
                case "win": return 0x5B;
                default: return 0;
            }
        }

        /* The screen as 2,304 grey samples, base64'd. Enough to tell movement from stillness, small
         * enough to poll. */
        /* The 64x36 grey reduction itself, which two callers want: /pulse, and the wait inside a goal run
           that this agent now carries out for itself. Null when there is no screen to look at. */
        public static byte[] Grid()
        {
            int vx = Native.GetSystemMetrics(Native.SM_XVIRTUALSCREEN);
            int vy = Native.GetSystemMetrics(Native.SM_YVIRTUALSCREEN);
            int vw = Native.GetSystemMetrics(Native.SM_CXVIRTUALSCREEN);
            int vh = Native.GetSystemMetrics(Native.SM_CYVIRTUALSCREEN);
            if (vw < 2 || vh < 2) return null;

            using (System.Drawing.Bitmap full = new System.Drawing.Bitmap(vw, vh))
            {
                using (System.Drawing.Graphics g = System.Drawing.Graphics.FromImage(full))
                {
                    g.CopyFromScreen(vx, vy, 0, 0, new System.Drawing.Size(vw, vh));
                }
                using (System.Drawing.Bitmap tiny = new System.Drawing.Bitmap(full, 64, 36))
                {
                    byte[] grey = new byte[64 * 36];
                    for (int y = 0; y < 36; y++)
                    {
                        for (int x = 0; x < 64; x++)
                        {
                            System.Drawing.Color c = tiny.GetPixel(x, y);
                            grey[y * 64 + x] = (byte)((c.R * 77 + c.G * 150 + c.B * 29) >> 8);
                        }
                    }
                    return grey;
                }
            }
        }

        public static string Pulse()
        {
            byte[] grey = Grid();
            if (grey == null) return "{\"ok\":false,\"error\":\"no screen\"}";
            return "{\"ok\":true,\"grid\":\"" + Convert.ToBase64String(grey) + "\"}";
        }

        /* ------------------------------------------------------------- what is already open
         *
         * A screenshot shows what is in front. It says nothing about the mail client sitting minimised
         * on the taskbar - so a decision made from pictures alone opens a second copy of it, which is
         * both wrong and hard to undo. This is the other half of seeing.
         *
         * Only real, top-level, titled windows: no tool windows, no owned dialogs of other apps, and
         * nothing the compositor has cloaked.
         */
        public static string WindowsJson()
        {
            return "{\"ok\":true,\"windows\":" + WindowsArray() + "}";
        }

        /* Just the array. The goal run sends this to the deployment, and the macOS agent sends the same
           shape - a wrapper on one side and an array on the other is exactly the kind of difference that
           is invisible until the model is told nothing is open. */
        public static string WindowsArray()
        {
            List<string> items = new List<string>();
            IntPtr front = Native.GetForegroundWindow();

            Native.EnumWindows(delegate(IntPtr hWnd, IntPtr lParam)
            {
                if (!Native.IsWindowVisible(hWnd)) return true;
                if (Native.GetWindow(hWnd, Native.GW_OWNER) != IntPtr.Zero) return true;

                int length = Native.GetWindowTextLength(hWnd);
                if (length < 1) return true;
                StringBuilder title = new StringBuilder(length + 1);
                Native.GetWindowText(hWnd, title, title.Capacity);
                string text = title.ToString().Trim();
                if (text.Length == 0) return true;

                int cloaked = 0;
                if (Native.DwmGetWindowAttribute(hWnd, Native.DWMWA_CLOAKED, out cloaked, 4) == 0 && cloaked != 0)
                {
                    return true;
                }

                string process = "";
                try
                {
                    uint pid;
                    Native.GetWindowThreadProcessId(hWnd, out pid);
                    process = Process.GetProcessById((int)pid).ProcessName;
                }
                catch (Exception) { /* it exited between the two calls; the title is still useful */ }

                RECT r;
                Native.GetWindowRect(hWnd, out r);

                /* Real applications, not their furniture. Chat apps in particular keep small titled
                   helper windows around - notification hosts, drag proxies - which pass every other
                   test here and would pad the list with things nobody can switch to. A minimised
                   window reports a 160x28 rect by convention, so it is exempt from the size test
                   rather than being caught by it. */
                bool small = (r.Right - r.Left) < 200 || (r.Bottom - r.Top) < 120;
                if (small && !Native.IsIconic(hWnd)) return true;

                /* The desktop itself. Explorer's shell window is titled, top-level and visible, and
                   there is nothing to switch to - listing it only invites an attempt. */
                if (text == "Program Manager") return true;

                StringBuilder item = new StringBuilder();
                item.Append("{\"title\":\"").Append(JsonEscape(text)).Append("\"");
                item.Append(",\"process\":\"").Append(JsonEscape(process)).Append("\"");
                item.Append(",\"active\":").Append(hWnd == front ? "true" : "false");
                item.Append(",\"minimized\":").Append(Native.IsIconic(hWnd) ? "true" : "false");
                item.Append(",\"x\":").Append(r.Left.ToString(CultureInfo.InvariantCulture));
                item.Append(",\"y\":").Append(r.Top.ToString(CultureInfo.InvariantCulture));
                item.Append(",\"w\":").Append((r.Right - r.Left).ToString(CultureInfo.InvariantCulture));
                item.Append(",\"h\":").Append((r.Bottom - r.Top).ToString(CultureInfo.InvariantCulture));
                item.Append("}");
                items.Add(item.ToString());
                return true;
            }, IntPtr.Zero);

            return "[" + string.Join(",", items.ToArray()) + "]";
        }

        /* Bringing one to the front.
         *
         * SetForegroundWindow is refused when the calling process is not itself in the foreground -
         * Windows protects against exactly this - so a minimised window is restored first and, if the
         * call is still refused, a tap of ALT clears the foreground lock and it is tried once more.
         * Whether it worked is reported rather than assumed, because a click on the taskbar is a fair
         * fallback and only the caller can decide to take it.
         */
        public static string Activate(string title, string process)
        {
            IntPtr found = IntPtr.Zero;
            string wanted = (title ?? "").Trim().ToLowerInvariant();
            string wantedProcess = (process ?? "").Trim().ToLowerInvariant();
            if (wanted.Length == 0 && wantedProcess.Length == 0) return "title or process is required";

            Native.EnumWindows(delegate(IntPtr hWnd, IntPtr lParam)
            {
                if (found != IntPtr.Zero) return false;
                if (!Native.IsWindowVisible(hWnd)) return true;
                if (Native.GetWindow(hWnd, Native.GW_OWNER) != IntPtr.Zero) return true;

                int length = Native.GetWindowTextLength(hWnd);
                if (length < 1) return true;
                StringBuilder sb = new StringBuilder(length + 1);
                Native.GetWindowText(hWnd, sb, sb.Capacity);
                string text = sb.ToString().ToLowerInvariant();

                string name = "";
                try
                {
                    uint pid;
                    Native.GetWindowThreadProcessId(hWnd, out pid);
                    name = Process.GetProcessById((int)pid).ProcessName.ToLowerInvariant();
                }
                catch (Exception) { }

                bool titleMatches = wanted.Length > 0 && text.IndexOf(wanted, StringComparison.Ordinal) >= 0;
                bool processMatches = wantedProcess.Length > 0 &&
                    name.IndexOf(wantedProcess, StringComparison.Ordinal) >= 0;
                if (titleMatches || processMatches) found = hWnd;
                return found == IntPtr.Zero;
            }, IntPtr.Zero);

            if (found == IntPtr.Zero) return "no open window matches that";

            if (Native.IsIconic(found)) Native.ShowWindow(found, Native.SW_RESTORE);

            /* Windows refuses SetForegroundWindow from a process that is not itself in front. The trick
             * that is everywhere on the internet - tap ALT to release the foreground lock - is a real
             * keystroke, and ALT is not a harmless one: in Outlook and the rest of Office it opens the
             * ribbon key tips, so the next text typed is read as accelerator keys and vanishes. A window
             * that came to the front by that route was a window about to swallow the message.
             *
             * Attaching to the target's input queue asks for the same permission without pressing
             * anything. Detached again immediately: leaving two threads' input queues joined makes each
             * one's stalls the other's.
             */
            /* Attached to the thread that owns the FOREGROUND window, not to the target's.
             *
             * The lock belongs to whoever is in front: Windows grants the foreground change to a thread
             * that shares the current foreground's input queue. Attaching to the target instead borrows
             * the permissions of the window we are trying to reach, which is the wrong end of the
             * problem and works only by accident. */
            uint frontPid;
            IntPtr frontWindow = Native.GetForegroundWindow();
            uint frontThread = frontWindow == IntPtr.Zero
                ? 0 : Native.GetWindowThreadProcessId(frontWindow, out frontPid);
            uint self = Native.GetCurrentThreadId();
            uint targetThread = frontThread;
            bool attached = targetThread != 0 && targetThread != self &&
                Native.AttachThreadInput(self, targetThread, true);
            try
            {
                Native.BringWindowToTop(found);
                Native.SetForegroundWindow(found);
            }
            finally
            {
                if (attached) Native.AttachThreadInput(self, targetThread, false);
            }

            Thread.Sleep(250);                  // let it paint before the next screenshot

            /* Checked rather than assumed. Windows can decline all of this - a full-screen app, an
             * elevated window - and reporting success while the wrong window has focus is how typing
             * ends up somewhere nobody asked for. */
            if (Native.GetForegroundWindow() != found)
            {
                return "that window would not come to the front - click it on the taskbar instead";
            }
            return null;
        }

        /* ------------------------------------------------------------------------- the seeing half
         *
         * The whole virtual desktop, shrunk to something a model can read without a picture the size
         * of a novel. `scale` is what it was shrunk by and originX/originY are where the desktop
         * starts - a multi-monitor origin is often negative - so a point on the picture maps back to
         * a point on the screen with two multiplications and an add. Nothing is written to disk.
         */
        /* JPEG, and a pixel budget rather than a width.
         *
         * A PNG of a desktop is a screenshot of text, which PNG stores faithfully and expensively: the
         * same screen is six to thirty times smaller as JPEG at quality 85, and a model reading a
         * screen cannot tell the difference. That mattered because the whole turn - picture, prompt,
         * tools, history - goes through a request body with a limit, and a busy screen could exceed it.
         *
         * Scaling by WIDTH alone was wrong for the same reason: two monitors side by side are 3840 wide
         * and one above another is 2160 tall, and only the second of those blows a byte budget that
         * width cannot see. Megapixels are what cost bytes, so megapixels are what is budgeted.
         */
        public static string Shot(int maxWidth)
        {
            int vx = Native.GetSystemMetrics(Native.SM_XVIRTUALSCREEN);
            int vy = Native.GetSystemMetrics(Native.SM_YVIRTUALSCREEN);
            int vw = Native.GetSystemMetrics(Native.SM_CXVIRTUALSCREEN);
            int vh = Native.GetSystemMetrics(Native.SM_CYVIRTUALSCREEN);
            if (vw < 2 || vh < 2) return "{\"ok\":false,\"error\":\"no screen\"}";
            if (maxWidth < 320) maxWidth = 320;
            if (maxWidth > 2560) maxWidth = 2560;

            /* Two limits, and the tighter wins: the caller's width, and a pixel budget scaled to it so
             * asking for a smaller picture really does buy fewer bytes on a tall desktop too. */
            double byWidth = vw > maxWidth ? (double)maxWidth / vw : 1.0;
            double budget = (double)maxWidth * maxWidth * 0.5625;      // 16:9 worth of pixels
            double byArea = Math.Sqrt(budget / ((double)vw * vh));
            double scale = Math.Min(1.0, Math.Min(byWidth, byArea));
            int sw = Math.Max(1, (int)Math.Round(vw * scale));
            int sh = Math.Max(1, (int)Math.Round(vh * scale));

            using (System.Drawing.Bitmap full = new System.Drawing.Bitmap(vw, vh))
            {
                using (System.Drawing.Graphics g = System.Drawing.Graphics.FromImage(full))
                {
                    g.CopyFromScreen(vx, vy, 0, 0, new System.Drawing.Size(vw, vh));
                }
                using (System.Drawing.Bitmap small = new System.Drawing.Bitmap(full, sw, sh))
                using (System.IO.MemoryStream buffer = new System.IO.MemoryStream())
                {
                    System.Drawing.Imaging.ImageCodecInfo jpeg = null;
                    foreach (System.Drawing.Imaging.ImageCodecInfo codec in
                             System.Drawing.Imaging.ImageCodecInfo.GetImageEncoders())
                    {
                        if (codec.MimeType == "image/jpeg") jpeg = codec;
                    }

                    string mime = "image/jpeg";
                    if (jpeg != null)
                    {
                        using (System.Drawing.Imaging.EncoderParameters ps =
                               new System.Drawing.Imaging.EncoderParameters(1))
                        {
                            ps.Param[0] = new System.Drawing.Imaging.EncoderParameter(
                                System.Drawing.Imaging.Encoder.Quality, 85L);
                            small.Save(buffer, jpeg, ps);
                        }
                    }
                    else
                    {
                        // No JPEG encoder is close to impossible on Windows, but a picture beats none.
                        Crash.Say("no JPEG encoder on this PC; sending PNG instead", "shot", "warning");
                        small.Save(buffer, System.Drawing.Imaging.ImageFormat.Png);
                        mime = "image/png";
                    }

                    string png = Convert.ToBase64String(buffer.ToArray());
                    StringBuilder sb = new StringBuilder();
                    sb.Append("{\"ok\":true,\"format\":\"").Append(mime).Append("\"");
                    sb.Append(",\"bytes\":").Append(buffer.Length.ToString(CultureInfo.InvariantCulture));
                    sb.Append(",\"w\":").Append(sw.ToString(CultureInfo.InvariantCulture));
                    sb.Append(",\"h\":").Append(sh.ToString(CultureInfo.InvariantCulture));
                    sb.Append(",\"scale\":").Append(scale.ToString("0.####", CultureInfo.InvariantCulture));
                    sb.Append(",\"originX\":").Append(vx.ToString(CultureInfo.InvariantCulture));
                    sb.Append(",\"originY\":").Append(vy.ToString(CultureInfo.InvariantCulture));
                    sb.Append(",\"png\":\"").Append(png).Append("\"}");
                    return sb.ToString();
                }
            }
        }

        static void ReleaseAllButtons()
        {
            uint[] ups = new uint[] { Native.MOUSEEVENTF_LEFTUP, Native.MOUSEEVENTF_RIGHTUP, Native.MOUSEEVENTF_MIDDLEUP };
            for (int i = 0; i < ups.Length; i++)
            {
                INPUT[] inputs = new INPUT[1];
                inputs[0].type = Native.INPUT_MOUSE;
                inputs[0].mi.dwFlags = ups[i];
                // Counted like every other injection, so "no unchecked SendInput" is a rule with no
                // exceptions - even on a cleanup path where nobody reads the answer.
                Injected(Native.SendInput(1, inputs, Marshal.SizeOf(typeof(INPUT))), 1);
            }
        }

        // ---------- flow body parsing ----------

        /* One `#ctx` line into the fields it names. Tab-separated `key=value`; the value takes the rest of
         * the field unsplit, because a window title contains spaces and an equals sign as often as not.
         * Unknown keys are ignored rather than being an error - that is what lets an agent add one. */
        static Ev ParseCtx(string line)
        {
            Ev ctx = new Ev();
            string[] fields = line.Split('\t');
            for (int f = 1; f < fields.Length; f++)
            {
                int eq = fields[f].IndexOf('=');
                if (eq <= 0) continue;
                string key = fields[f].Substring(0, eq).Trim().ToLowerInvariant();
                string val = fields[f].Substring(eq + 1).Trim();
                if (val.Length == 0) continue;
                if (key == "app") ctx.Process = val;
                else if (key == "window") ctx.Window = val;
                else if (key == "control") ctx.Control = val;
                else if (key == "type") ctx.ControlType = val;
                else if (key == "url") ctx.Url = val;
            }
            return ctx;
        }

        static Flow ParseFlow(string body)
        {
            Flow flow = new Flow();
            Step current = null;
            /* Attaches to exactly ONE event - the next one - and is cleared by it. A `#ctx` that leaked
             * onto later events would aim a whole run at one control. */
            Ev pending = null;
            if (body == null) return flow;

            string[] lines = body.Replace("\r\n", "\n").Replace("\r", "\n").Split('\n');
            for (int i = 0; i < lines.Length; i++)
            {
                string line = lines[i].Trim();
                if (line.Length == 0) continue;
                /* `#ctx` is READ now, not skipped.
                 *
                 * It was dropped here, which is why a replay on this platform had nothing but coordinates:
                 * the recording knew it clicked "Send" and the replay knew only 1074,159. Everything after
                 * this - aiming by name when the layout moved - rests on the line above the event, and it
                 * was being thrown away three characters into the parse. Any other comment still is. */
                if (line.StartsWith("#"))
                {
                    if (line.StartsWith("#ctx", StringComparison.OrdinalIgnoreCase)) pending = ParseCtx(line);
                    continue;
                }

                if (line.StartsWith("startDelay=", StringComparison.OrdinalIgnoreCase))
                {
                    int v;
                    if (int.TryParse(line.Substring(11).Trim(), NumberStyles.Integer, CultureInfo.InvariantCulture, out v)) flow.StartDelayMs = v;
                    continue;
                }

                if (line.StartsWith("flowRepeat=", StringComparison.OrdinalIgnoreCase))
                {
                    string val = line.Substring(11).Trim().ToLowerInvariant();
                    int v;
                    if (val == "forever" || val == "0") flow.Repeat = 0;
                    else if (int.TryParse(val, NumberStyles.Integer, CultureInfo.InvariantCulture, out v)) flow.Repeat = v;
                    continue;
                }

                if (line.StartsWith("STEP", StringComparison.OrdinalIgnoreCase))
                {
                    current = new Step();
                    string[] parts = line.Split(new char[] { ' ', '\t' }, StringSplitOptions.RemoveEmptyEntries);
                    for (int p = 1; p < parts.Length; p++)
                    {
                        int eq = parts[p].IndexOf('=');
                        if (eq <= 0) continue;
                        string key = parts[p].Substring(0, eq).ToLowerInvariant();
                        string val = parts[p].Substring(eq + 1);
                        if (key == "repeat")
                        {
                            int v;
                            if (val.ToLowerInvariant() == "forever" || val == "0") current.Repeat = 0;
                            else if (int.TryParse(val, NumberStyles.Integer, CultureInfo.InvariantCulture, out v)) current.Repeat = v;
                        }
                        else if (key == "speed")
                        {
                            double d;
                            if (double.TryParse(val, NumberStyles.Float, CultureInfo.InvariantCulture, out d) && d > 0) current.Speed = d;
                        }
                        else if (key == "delayafter")
                        {
                            int v;
                            if (int.TryParse(val, NumberStyles.Integer, CultureInfo.InvariantCulture, out v)) current.DelayAfterMs = v;
                        }
                    }
                    flow.Steps.Add(current);
                    continue;
                }

                if (current == null)
                {
                    current = new Step();
                    flow.Steps.Add(current);
                }

                string[] cols = line.Split('|');
                if (cols.Length < 5) continue;
                int x, y, delay;
                if (!int.TryParse(cols[1].Trim(), NumberStyles.Integer, CultureInfo.InvariantCulture, out x)) continue;
                if (!int.TryParse(cols[2].Trim(), NumberStyles.Integer, CultureInfo.InvariantCulture, out y)) continue;
                if (!int.TryParse(cols[3].Trim(), NumberStyles.Integer, CultureInfo.InvariantCulture, out delay)) continue;

                Ev e = new Ev();
                e.X = x;
                e.Y = y;
                e.DelayMs = delay;
                e.Action = string.Join("|", cols, 4, cols.Length - 4).Trim();
                if (pending != null)
                {
                    e.Process = pending.Process;
                    e.Window = pending.Window;
                    e.Control = pending.Control;
                    e.ControlType = pending.ControlType;
                    e.Url = pending.Url;
                    pending = null;
                }
                current.Events.Add(e);
            }

            return flow;
        }

        // ---------- autostart ----------
        //
        // A shortcut in the user's Startup folder, which needs no admin rights and is trivial
        // to undo. The command it writes is built only from the agent's OWN launch arguments -
        // nothing from the HTTP request reaches it - so a hostile page cannot turn this into a
        // "run my script at logon" primitive. It is still persistence, so it is refused unless
        // the operator pinned -AllowOrigin.

        public static string AutostartFile()
        {
            return Environment.GetFolderPath(Environment.SpecialFolder.Startup) + "\\MouseFlowAgent.cmd";
        }

        public static bool AutostartEnabled()
        {
            try { return System.IO.File.Exists(AutostartFile()); }
            catch { return false; }
        }

        public static bool CanAutostart()
        {
            return ScriptPath.Length > 0 && AllowOrigin != "*";
        }

        public static string EnableAutostart()
        {
            if (ScriptPath.Length == 0)
                return "the agent was started from a pipe, so there is no file to run at logon - download mouseflow-agent.ps1 and start it from the file instead";
            if (AllowOrigin == "*")
                return "restart the agent with -AllowOrigin set to your app origin before enabling autostart";

            try
            {
                string cmd = "@echo off\r\n"
                    + "rem Created by the MouseFlow agent. Delete this file to stop it starting at logon.\r\n"
                    + "start \"\" powershell -NoProfile -WindowStyle Hidden -ExecutionPolicy Bypass -File \""
                    + ScriptPath + "\" -Port " + Port.ToString(CultureInfo.InvariantCulture)
                    + " -AllowOrigin " + AllowOrigin + "\r\n";
                System.IO.File.WriteAllText(AutostartFile(), cmd);
                Console.WriteLine("  autostart enabled -> " + AutostartFile());
                return null;
            }
            catch (Exception ex) { return ex.Message; }
        }

        public static string DisableAutostart()
        {
            try
            {
                if (System.IO.File.Exists(AutostartFile()))
                {
                    System.IO.File.Delete(AutostartFile());
                    Console.WriteLine("  autostart disabled");
                }
                return null;
            }
            catch (Exception ex) { return ex.Message; }
        }

        // ---------- HTTP ----------

        public static string AllowOrigin = "*";

        public static void ServeForever(int port)
        {
            TcpListener listener = new TcpListener(IPAddress.Loopback, port);
            listener.Start();
            while (true)
            {
                TcpClient client = listener.AcceptTcpClient();
                Thread t = new Thread(new ParameterizedThreadStart(HandleClient));
                t.IsBackground = true;
                t.Start(client);
            }
        }

        static void HandleClient(object state)
        {
            TcpClient client = (TcpClient)state;
            try
            {
                client.NoDelay = true;
                NetworkStream stream = client.GetStream();
                stream.ReadTimeout = 8000;

                // headers
                MemoryStreamLite head = new MemoryStreamLite();
                byte[] one = new byte[1];
                int consecutive = 0;
                while (consecutive < 2)
                {
                    int n = stream.Read(one, 0, 1);
                    if (n <= 0) return;
                    head.Add(one[0]);
                    if (one[0] == (byte)'\n') consecutive++;
                    else if (one[0] != (byte)'\r') consecutive = 0;
                    if (head.Count > 65536) return;
                }

                string headText = Encoding.UTF8.GetString(head.ToArray());
                string[] headLines = headText.Replace("\r\n", "\n").Split('\n');
                if (headLines.Length == 0) return;

                string[] requestLine = headLines[0].Split(' ');
                if (requestLine.Length < 2) return;
                string method = requestLine[0].ToUpperInvariant();
                string path = requestLine[1];
                /* The query travels beside the path, not inside it.
                 *
                 * It used to be cut off here and nowhere else looked at the request line again - so `?w=640`
                 * reached no handler, and /shot answered a caller asking for a small picture with the same
                 * 200KB one it had just refused. Every route compares `path == "/health"` and so on, which
                 * only works on a clean path; the answer is a second argument, not twenty rewritten routes. */
                string query = "";
                int q = path.IndexOf('?');
                if (q >= 0)
                {
                    query = path.Substring(q + 1);
                    path = path.Substring(0, q);
                }

                int contentLength = 0;
                string origin = null;
                for (int i = 1; i < headLines.Length; i++)
                {
                    int colon = headLines[i].IndexOf(':');
                    if (colon <= 0) continue;
                    string name = headLines[i].Substring(0, colon).Trim().ToLowerInvariant();
                    string value = headLines[i].Substring(colon + 1).Trim();
                    if (name == "content-length") int.TryParse(value, out contentLength);
                    else if (name == "origin") origin = value;
                }

                string body = "";
                if (contentLength > 0)
                {
                    byte[] buf = new byte[contentLength];
                    int read = 0;
                    while (read < contentLength)
                    {
                        int n = stream.Read(buf, read, contentLength - read);
                        if (n <= 0) break;
                        read += n;
                    }
                    body = Encoding.UTF8.GetString(buf, 0, read);
                }

                Route(stream, method, path, query, body, origin);
            }
            catch (Exception ex)
            {
                LastError = ex.Message;
            }
            finally
            {
                try { client.Close(); } catch { }
            }
        }

        class MemoryStreamLite
        {
            List<byte> _b = new List<byte>(1024);
            public void Add(byte x) { _b.Add(x); }
            public int Count { get { return _b.Count; } }
            public byte[] ToArray() { return _b.ToArray(); }
        }

        /* One number out of a query string. Written once because it was about to exist twice: /shot had its
         * own copy of exactly this, and two hand-rolled parsers of the same thing drift - the second one gets
         * the `&` case wrong, or the culture, and only under a query nobody tests. */
        static int QueryInt(string query, string name, int fallback)
        {
            int q = query.IndexOf(name + "=", StringComparison.Ordinal);
            if (q < 0) return fallback;
            string tail = query.Substring(q + name.Length + 1);
            int amp = tail.IndexOf('&');
            if (amp >= 0) tail = tail.Substring(0, amp);
            int parsed;
            if (!int.TryParse(tail, NumberStyles.Integer, CultureInfo.InvariantCulture, out parsed)) return fallback;
            return parsed;
        }

        static void Route(NetworkStream stream, string method, string path, string query, string body, string origin)
        {
            if (method == "OPTIONS") { Respond(stream, 204, "text/plain", "", origin); return; }

            if (path == "/health")
            {
                POINT p;
                Native.GetCursorPos(out p);
                string json = "{\"ok\":true,\"version\":\"" + Version + "\""
                    + ",\"screen\":{\"x\":" + Native.GetSystemMetrics(Native.SM_XVIRTUALSCREEN).ToString(CultureInfo.InvariantCulture)
                    + ",\"y\":" + Native.GetSystemMetrics(Native.SM_YVIRTUALSCREEN).ToString(CultureInfo.InvariantCulture)
                    + ",\"w\":" + Native.GetSystemMetrics(Native.SM_CXVIRTUALSCREEN).ToString(CultureInfo.InvariantCulture)
                    + ",\"h\":" + Native.GetSystemMetrics(Native.SM_CYVIRTUALSCREEN).ToString(CultureInfo.InvariantCulture) + "}"
                    + ",\"cursor\":{\"x\":" + p.X.ToString(CultureInfo.InvariantCulture) + ",\"y\":" + p.Y.ToString(CultureInfo.InvariantCulture) + "}"
                    + ",\"hook\":" + (_hook != IntPtr.Zero ? "true" : "false")
                    + ",\"recording\":" + (IsRecording ? "true" : "false")
                    + ",\"playing\":" + (IsPlaying ? "true" : "false")
                    + ",\"autostart\":" + (AutostartEnabled() ? "true" : "false")
                    + ",\"canAutostart\":" + (CanAutostart() ? "true" : "false")
                    + ",\"originPinned\":" + (AllowOrigin != "*" ? "true" : "false")
                    /* So the app can tell an older agent from this one and say which. A missing
                       endpoint answers 404, which reads as "broken" rather than "out of date". */
                    + ",\"canSee\":true"
                    /* Whether this PC can be attached to an account at all, and whether it is taking work.
                       The app shows "Let Claude drive this computer" only when `linked` is PRESENT - absent
                       means "this build cannot", not "off" - so an older agent degrades to hiding the
                       button rather than offering one that 404s. */
                    + ",\"linked\":" + (Account.Linked ? "true" : "false")
                    + ",\"taking\":" + (Account.Taking ? "true" : "false")
                    /* Separate from canSee because it arrived later: an 0.2.0 agent can act on
                       pictures but cannot say what is already open, and the app degrades to that
                       rather than refusing to run. */
                    + ",\"canWindows\":true"
                    /* Whether a click gets a name. The version number nearly says this and missed the
                       case that happened: an 0.5.0 started before the resolver existed and one started
                       after it are identical from outside, and the difference is whether a transcript
                       reads "clicked the New mail button in OUTLOOK" or "clicked at 1030,1053". An
                       older agent omits the field, which is the answer. */
                    + ",\"canName\":true"
                    /* Whether typing is recorded AS AN EVENT - that a key was pressed and when, never
                       which key. A recording from an older agent has no typing in it at all, so a
                       transcript cannot tell "did not type" from "was not recorded", and this is how it
                       can. False, not absent, when the keyboard hook failed to install: the agent runs
                       without it rather than refusing to start. */
                    + ",\"canKeys\":" + (_kbHook != IntPtr.Zero ? "true" : "false")
                    /* Whether a recording can outlast one response. Without /record/drain the only way
                       events leave is /record/stop, so a session is bounded by what fits in memory and in
                       one string - and the app must offer a short recording rather than a day-long one it
                       cannot actually take delivery of. */
                    + ",\"canDrain\":true"
                    /* Which implementation answered. There are two now, and the Connections screen shows a
                       different install command for each - guessing that from the browser's user agent gets
                       it wrong for anybody helping somebody else set up. */
                    + ",\"platform\":\"windows\""
                    + "}";
                Respond(stream, 200, "application/json", json, origin);
                return;
            }

            /* Proving the crash pipe works, on the machine it has to work on.

               There is no other way to check it: a real fault cannot be arranged on demand, and "we would
               have heard about it" is exactly the assumption that makes a silent reporter survive for
               months. Sends one event and says whether there was anywhere to send it. */
            if (path == "/crash-test" && method == "POST")
            {
                if (string.IsNullOrEmpty(Account.Token))
                {
                    Respond(stream, 409, "application/json", "{\"ok\":false,\"error\":\"this PC is not "
                        + "attached to an account, so there is nowhere to report a crash to\"}", origin);
                    return;
                }
                /* `reported` is the deployment's own answer, and it is true only if Sentry took the event.
                   A test that said "sent" and meant "handed to a socket" is the test that lets a silent
                   reporter live. */
                bool reported = Crash.Test();
                Respond(stream, 200, "application/json",
                    "{\"ok\":true,\"reported\":" + (reported ? "true" : "false") + "}", origin);
                return;
            }

            if (path == "/record/start" && method == "POST")
            {
                if (_hook == IntPtr.Zero) { Respond(stream, 500, "application/json", "{\"ok\":false,\"error\":\"hook not installed\"}", origin); return; }
                /* ?moveMs= thins the pointer path for a session meant to last hours. Absent keeps the
                 * default, so every existing caller records exactly as it did. */
                string refused = RecordStart(QueryInt(query, "moveMs", 0));
                if (refused != null)
                {
                    Respond(stream, 409, "application/json",
                        "{\"ok\":false,\"error\":\"" + JsonEscape(refused) + "\"}", origin);
                    return;
                }
                Respond(stream, 200, "application/json",
                    "{\"ok\":true,\"moveMs\":" + RecordMoveMs.ToString(CultureInfo.InvariantCulture) + "}", origin);
                return;
            }

            if (path == "/record/status")
            {
                /* `count` is what is in the buffer NOW, which after a drain is not what the session has
                 * recorded - the caller adds up the chunks it was handed. `part` is how the two are told
                 * apart: 0 means nothing has been drained and count is the whole recording. */
                string json = "{\"recording\":" + (IsRecording ? "true" : "false")
                    + ",\"count\":" + RecordCount.ToString(CultureInfo.InvariantCulture)
                    + ",\"part\":" + RecordPart.ToString(CultureInfo.InvariantCulture)
                    + ",\"moveMs\":" + RecordMoveMs.ToString(CultureInfo.InvariantCulture)
                    + ",\"elapsedMs\":" + RecordElapsed.ToString(CultureInfo.InvariantCulture) + "}";
                Respond(stream, 200, "application/json", json, origin);
                return;
            }

            if (path == "/record/drain" && method == "POST")
            {
                string chunk = RecordDrain();
                /* 409, not an empty body: "nothing was recorded in the last half hour" and "the recording is
                 * not running" are different answers, and a chunker that cannot tell them apart writes an
                 * empty part every thirty minutes for as long as the tab stays open. */
                if (chunk == null)
                {
                    Respond(stream, 409, "application/json", "{\"ok\":false,\"error\":\"not recording\"}", origin);
                    return;
                }
                Respond(stream, 200, "text/plain", chunk, origin);
                return;
            }

            if (path == "/record/stop" && method == "POST")
            {
                Respond(stream, 200, "text/plain", RecordStop(), origin);
                return;
            }

            if (path == "/replay" && method == "POST")
            {
                string err = StartReplay(body);
                if (err != null) { Respond(stream, 409, "application/json", "{\"ok\":false,\"error\":\"" + JsonEscape(err) + "\"}", origin); return; }
                Respond(stream, 200, "application/json", "{\"ok\":true}", origin);
                return;
            }

            if (path == "/replay/status")
            {
                Respond(stream, 200, "application/json", ReplayStatusJson(), origin);
                return;
            }

            if (path == "/replay/abort" && method == "POST")
            {
                Abort();
                Respond(stream, 200, "application/json", "{\"ok\":true}", origin);
                return;
            }

            if (path == "/shot")
            {
                /* ?w= so a caller that has just been told its request was too large can ask for a
                 * smaller picture instead of giving up. Shot clamps the range itself. */
                int want = QueryInt(query, "w", 1280);
                /* Deliberately not while replaying: a picture taken mid-replay shows a screen that is
                   already moving, and a decision made from it acts on something that has gone. */
                if (IsPlaying) { Respond(stream, 409, "application/json", "{\"ok\":false,\"error\":\"busy replaying\"}", origin); return; }
                Respond(stream, 200, "application/json", Shot(want), origin);
                return;
            }

            /* A fingerprint of the screen rather than a picture of it: 64x36 grey samples, which is all
             * "has anything changed" needs. Waiting used to fetch a whole screenshot every 1.5 seconds
             * and throw all but 2KB of it away. */
            if (path == "/pulse")
            {
                if (IsPlaying) { Respond(stream, 409, "application/json", "{\"ok\":false,\"error\":\"busy replaying\"}", origin); return; }
                Respond(stream, 200, "application/json", Pulse(), origin);
                return;
            }

            if (path == "/windows")
            {
                Respond(stream, 200, "application/json", WindowsJson(), origin);
                return;
            }

            if (path == "/do" && method == "POST")
            {
                if (IsPlaying) { Respond(stream, 409, "application/json", "{\"ok\":false,\"error\":\"busy replaying\"}", origin); return; }
                string problem = DoAction(body);
                if (problem != null) { Respond(stream, 400, "application/json", "{\"ok\":false,\"error\":\"" + JsonEscape(problem) + "\"}", origin); return; }
                Respond(stream, 200, "application/json", "{\"ok\":true}", origin);
                return;
            }

            /* Attaching this PC to an account, and detaching it.

               Handed over across loopback by the app, which is signed in as the person - so nobody reads a
               token, copies one, or keeps one anywhere. The same pairing the extension gets over its
               bridge, for the same reason: a credential a person has to carry is a credential a person
               mislays. */
            if (path == "/account")
            {
                if (method == "DELETE")
                {
                    Account.Forget();
                    Respond(stream, 200, "application/json", "{\"ok\":true,\"linked\":false}", origin);
                    return;
                }
                if (method != "POST")
                {
                    Respond(stream, 405, "application/json",
                        "{\"ok\":false,\"error\":\"POST or DELETE\"}", origin);
                    return;
                }
                Dictionary<string, string> fields = ParseFields(body);
                string token = Get(fields, "token", null);
                if (token == null || !token.StartsWith("mf_"))
                {
                    Respond(stream, 400, "application/json",
                        "{\"ok\":false,\"error\":\"a MouseFlow device token, which starts with mf_\"}", origin);
                    return;
                }
                string accountBase = Get(fields, "base", null);
                /* Taking work is the point of attaching, so it is on unless the caller says otherwise - and
                   the tray says so from the moment it is, which is where somebody would look to turn it
                   off. */
                bool taking = Get(fields, "taking", "1") != "0";
                Account.Set(token, accountBase, taking);
                /* The tray is NOT poked from here. It reads the state when its menu opens, and touching a
                   ToolStripMenuItem from this thread is a cross-thread call into WinForms - the class of
                   bug that shows up once, on somebody else's machine. */
                Respond(stream, 200, "application/json",
                    "{\"ok\":true,\"linked\":true,\"taking\":" + (taking ? "true" : "false") + "}", origin);
                return;
            }

            if (path == "/autostart/enable" && method == "POST")
            {
                string err = EnableAutostart();
                if (err != null) { Respond(stream, 409, "application/json", "{\"ok\":false,\"error\":\"" + JsonEscape(err) + "\"}", origin); return; }
                Respond(stream, 200, "application/json", "{\"ok\":true}", origin);
                return;
            }

            if (path == "/autostart/disable" && method == "POST")
            {
                string err = DisableAutostart();
                if (err != null) { Respond(stream, 409, "application/json", "{\"ok\":false,\"error\":\"" + JsonEscape(err) + "\"}", origin); return; }
                Respond(stream, 200, "application/json", "{\"ok\":true}", origin);
                return;
            }

            if (path == "/")
            {
                Respond(stream, 200, "text/html", "<!doctype html><meta charset=utf-8><title>MouseFlow agent</title>"
                    + "<body style=\"font:14px system-ui;padding:2rem\"><h1>MouseFlow agent " + Version + "</h1>"
                    + "<p>Running. Leave this window open and use the MouseFlow web app.</p>", origin);
                return;
            }

            Respond(stream, 404, "application/json", "{\"ok\":false,\"error\":\"no such endpoint\"}", origin);
        }

        static void Respond(NetworkStream stream, int status, string contentType, string body, string origin)
        {
            byte[] payload = Encoding.UTF8.GetBytes(body == null ? "" : body);
            string allow = AllowOrigin;
            if (allow == "*" && origin != null) allow = origin;   // PNA preflight dislikes a bare *

            StringBuilder sb = new StringBuilder();
            sb.Append("HTTP/1.1 ").Append(status.ToString(CultureInfo.InvariantCulture)).Append(" ").Append(StatusText(status)).Append("\r\n");
            sb.Append("Content-Type: ").Append(contentType).Append("; charset=utf-8\r\n");
            sb.Append("Content-Length: ").Append(payload.Length.ToString(CultureInfo.InvariantCulture)).Append("\r\n");
            sb.Append("Access-Control-Allow-Origin: ").Append(allow).Append("\r\n");
            sb.Append("Access-Control-Allow-Methods: GET, POST, OPTIONS\r\n");
            sb.Append("Access-Control-Allow-Headers: Content-Type\r\n");
            // No Access-Control-Allow-Private-Network here on purpose. Chrome 142 replaced
            // Private Network Access with Local Network Access, which is a user permission -
            // the old response header grants nothing, and emitting it only implies the
            // loopback hop is handled server-side when it is not.
            sb.Append("Access-Control-Max-Age: 600\r\n");
            sb.Append("Vary: Origin\r\n");
            sb.Append("Cache-Control: no-store\r\n");
            sb.Append("Connection: close\r\n\r\n");

            byte[] header = Encoding.UTF8.GetBytes(sb.ToString());
            stream.Write(header, 0, header.Length);
            if (payload.Length > 0) stream.Write(payload, 0, payload.Length);
            stream.Flush();
        }

        /* The same escaper, reachable from Account and Courier. They build JSON for the account rather
           than for a browser, and a second escaper would be a second place to get a quote wrong. */
        public static string JsonText(string s) { return JsonEscape(s); }

        static string JsonEscape(string s)
        {
            if (s == null) return "";
            StringBuilder sb = new StringBuilder(s.Length + 8);
            for (int i = 0; i < s.Length; i++)
            {
                char c = s[i];
                if (c == '"') sb.Append("\\\"");
                else if (c == '\\') sb.Append("\\\\");
                else if (c == '\n') sb.Append("\\n");
                else if (c == '\r') sb.Append("\\r");
                else if (c == '\t') sb.Append("\\t");
                else if (c < ' ') sb.Append("\\u").Append(((int)c).ToString("x4", CultureInfo.InvariantCulture));
                else sb.Append(c);
            }
            return sb.ToString();
        }

        static string StatusText(int status)
        {
            switch (status)
            {
                case 200: return "OK";
                case 204: return "No Content";
                case 404: return "Not Found";
                case 409: return "Conflict";
                case 500: return "Internal Server Error";
                default: return "OK";
            }
        }
    }

    /* Reading JSON, in the smallest thing that can read one claim response.

       WHY NOT JavaScriptSerializer, WHICH IS ONE LINE. It needs System.Web.Extensions in the Add-Type
       reference list, and that assembly does not exist on .NET Core - so a user who ran the install command
       in PowerShell 7 instead of Windows PowerShell would get a failed Add-Type and NO AGENT AT ALL, not a
       courier that misbehaves. The blast radius decided this: a parser bug stops jobs being claimed, a bad
       assembly reference stops the agent existing.

       So it reads what it has to read and nothing more, and every failure path returns null rather than
       throwing - the caller treats an unreadable answer as "no work", which is the safe reading.

       It is a real parser rather than a regex over the response, because one of the fields is a REPLAY BODY:
       a multi-line blob full of escaped quotes and newlines. Pulling that out with a pattern is how a skill
       replays half of itself. */
    public static class Json
    {
        public static object Parse(string text)
        {
            if (string.IsNullOrEmpty(text)) return null;
            try
            {
                int i = 0;
                return Value(text, ref i);
            }
            catch { return null; }
        }

        static void Ws(string s, ref int i)
        {
            while (i < s.Length && (s[i] == ' ' || s[i] == '\t' || s[i] == '\n' || s[i] == '\r')) i++;
        }

        static object Value(string s, ref int i)
        {
            Ws(s, ref i);
            if (i >= s.Length) throw new FormatException("nothing here");
            char c = s[i];
            if (c == '{') return Obj(s, ref i);
            if (c == '[') return Arr(s, ref i);
            if (c == '"') return Str(s, ref i);
            if (c == 't') { Word(s, ref i, "true"); return true; }
            if (c == 'f') { Word(s, ref i, "false"); return false; }
            if (c == 'n') { Word(s, ref i, "null"); return null; }
            return Num(s, ref i);
        }

        static void Word(string s, ref int i, string word)
        {
            if (i + word.Length > s.Length || s.Substring(i, word.Length) != word)
                throw new FormatException("not " + word);
            i += word.Length;
        }

        static Dictionary<string, object> Obj(string s, ref int i)
        {
            Dictionary<string, object> map = new Dictionary<string, object>();
            i++;
            Ws(s, ref i);
            if (i < s.Length && s[i] == '}') { i++; return map; }
            while (true)
            {
                Ws(s, ref i);
                string key = Str(s, ref i);
                Ws(s, ref i);
                if (i >= s.Length || s[i] != ':') throw new FormatException("expected a colon");
                i++;
                map[key] = Value(s, ref i);
                Ws(s, ref i);
                if (i < s.Length && s[i] == ',') { i++; continue; }
                if (i < s.Length && s[i] == '}') { i++; return map; }
                throw new FormatException("unterminated object");
            }
        }

        static List<object> Arr(string s, ref int i)
        {
            List<object> list = new List<object>();
            i++;
            Ws(s, ref i);
            if (i < s.Length && s[i] == ']') { i++; return list; }
            while (true)
            {
                list.Add(Value(s, ref i));
                Ws(s, ref i);
                if (i < s.Length && s[i] == ',') { i++; continue; }
                if (i < s.Length && s[i] == ']') { i++; return list; }
                throw new FormatException("unterminated array");
            }
        }

        static string Str(string s, ref int i)
        {
            if (i >= s.Length || s[i] != '"') throw new FormatException("expected a string");
            i++;
            StringBuilder sb = new StringBuilder();
            while (i < s.Length)
            {
                char c = s[i++];
                if (c == '"') return sb.ToString();
                if (c != '\\') { sb.Append(c); continue; }
                if (i >= s.Length) break;
                char e = s[i++];
                if (e == '"') sb.Append('"');
                else if (e == '\\') sb.Append('\\');
                else if (e == '/') sb.Append('/');
                else if (e == 'b') sb.Append('\b');
                else if (e == 'f') sb.Append('\f');
                else if (e == 'n') sb.Append('\n');
                else if (e == 'r') sb.Append('\r');
                else if (e == 't') sb.Append('\t');
                else if (e == 'u')
                {
                    if (i + 4 > s.Length) break;
                    sb.Append((char)Convert.ToInt32(s.Substring(i, 4), 16));
                    i += 4;
                }
                else throw new FormatException("unknown escape");
            }
            throw new FormatException("unterminated string");
        }

        static object Num(string s, ref int i)
        {
            int start = i;
            while (i < s.Length && "-+.eE0123456789".IndexOf(s[i]) >= 0) i++;
            if (i == start) throw new FormatException("not a number");
            return double.Parse(s.Substring(start, i - start), CultureInfo.InvariantCulture);
        }

        /* ---------------------------------------------------------------- reading one out */

        public static object Child(object node, string key)
        {
            Dictionary<string, object> map = node as Dictionary<string, object>;
            if (map == null) return null;
            object v;
            return map.TryGetValue(key, out v) ? v : null;
        }

        public static string Text(object node, string key) { return Child(node, key) as string; }

        public static int Int(object node, string key, int fallback)
        {
            object v = Child(node, key);
            return v is double ? (int)(double)v : fallback;
        }

        public static bool Truth(object node, string key, bool fallback)
        {
            object v = Child(node, key);
            return v is bool ? (bool)v : fallback;
        }
    }

    /* ================================================================ the account

       Taking work from the account: what makes "start recording on my PC" possible from a chat that is not
       on this PC.

       The thing it solves is a DIRECTION, not a feature. This agent listens on loopback and nothing on the
       internet can reach it - deliberately, and that is not going to change. So the machine asks: it holds a
       token, long-polls the account for a job, does it, and says how it went. No inbound path to this
       computer exists at any point, and an agent that is not taking work makes no outbound call at all.

       OFF UNTIL SOMEBODY SWITCHES IT ON, and visible in the tray while it is. Everything else this agent
       does happens because something on this machine asked; this is the one thing it would do because a
       service said so, and that difference belongs where the person can see it and turn it off.

       The token is handed over by the app across loopback - the same pairing the extension gets - so nobody
       has to read one, copy one, or keep one anywhere. It is written under LocalApplicationData, which is
       the per-user profile: another standard user on the same PC cannot read it. That is the Windows
       equivalent of the 0600 the macOS agent sets, and it is stated in the docs rather than left to be
       discovered.

       This mirrors the Swift agent's Account and Courier, deliberately and almost line for line. The two
       implementations answering one contract is the whole point of agent/PROTOCOL.md, and a courier that
       drifted would be a Windows machine that silently stopped being drivable. */
    public static class Account
    {
        static readonly object Gate = new object();
        static string _token;
        static string _base = "https://mouseflowapp.vercel.app";
        static bool _taking;

        static string Dir
        {
            get
            {
                return Path.Combine(
                    Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData), "MouseFlow");
            }
        }

        static string StatePath { get { return Path.Combine(Dir, "account.json"); } }

        public static bool Linked { get { lock (Gate) { return !string.IsNullOrEmpty(_token); } } }
        public static bool Taking { get { lock (Gate) { return !string.IsNullOrEmpty(_token) && _taking; } } }
        public static string Token { get { lock (Gate) { return _token; } } }
        public static string Base { get { lock (Gate) { return _base; } } }

        /* Read once at startup. A missing or unreadable file means "not linked", which is the safe answer. */
        public static void Load()
        {
            try
            {
                if (!File.Exists(StatePath)) return;
                object raw = Json.Parse(File.ReadAllText(StatePath, Encoding.UTF8));
                string token = Json.Text(raw, "token");
                if (string.IsNullOrEmpty(token)) return;
                string b = Json.Text(raw, "base");
                lock (Gate)
                {
                    _token = token;
                    if (!string.IsNullOrEmpty(b)) _base = b;
                    _taking = Json.Truth(raw, "taking", false);
                }
            }
            catch { /* Not linked is the safe reading of a file that cannot be read. */ }
        }

        static void Save()
        {
            try
            {
                Directory.CreateDirectory(Dir);
                string json;
                lock (Gate)
                {
                    if (string.IsNullOrEmpty(_token))
                    {
                        if (File.Exists(StatePath)) File.Delete(StatePath);
                        return;
                    }
                    json = "{\"token\":\"" + Agent.JsonText(_token) + "\",\"base\":\"" + Agent.JsonText(_base)
                        + "\",\"taking\":" + (_taking ? "true" : "false") + "}";
                }
                File.WriteAllText(StatePath, json, Encoding.UTF8);
            }
            catch { /* An unwritable profile is not a reason to refuse the pairing that is already in memory. */ }
        }

        public static void Set(string token, string b, bool taking)
        {
            lock (Gate)
            {
                _token = token;
                if (!string.IsNullOrEmpty(b)) _base = b;
                _taking = taking;
            }
            Save();
        }

        public static void SetTaking(bool on)
        {
            lock (Gate) { if (!string.IsNullOrEmpty(_token)) _taking = on; }
            Save();
        }

        public static void Forget()
        {
            lock (Gate) { _token = null; _taking = false; }
            Save();
        }
    }

    /* Falling over where nobody is looking.

       This agent runs in a window, or from the Startup folder, on somebody else's PC. When it breaks what
       happens today is a line on a console nobody is watching. The deployment and the browser have had
       crash reporting for a while; the two programs that actually touch the mouse were the blind half.

       IT REPORTS THROUGH THE ACCOUNT, not to Sentry directly. This agent already dials the deployment with
       a device token, so ?worker=crash needs no DSN of its own - one less secret inside a program people
       download - and what arrives is already attached to an account and to this build. The cost is real and
       worth saying: a failure whose cause is "cannot reach the deployment" cannot travel this way.

       ONCE PER PROCESS PER THING, because a hook that will not install fails every time it is tried, and a
       reporter that says so every time is a reporter somebody mutes.

       NEVER BLOCKS AND NEVER THROWS. Something has just gone wrong; a reporter that made the caller wait,
       or that failed on top of the failure, would be worse than none. */
    public static class Crash
    {
        static readonly object Gate = new object();
        static readonly Dictionary<string, bool> Told = new Dictionary<string, bool>();

        public static void Say(string message, string where)
        {
            Say(message, where, "error");
        }

        /* The same event, sent and WAITED FOR, for /crash-test only.

           Fire-and-forget is right for a real fault and useless for a test: the whole question a test asks
           is whether the thing arrived, and the deployment's answer carries `reported` - which is true only
           when Sentry itself took it. Without this, checking the pipe means somebody opening a dashboard
           and deciding how long to keep refreshing. */
        public static bool Test()
        {
            string token = Account.Token;
            string root = Account.Base;
            if (string.IsNullOrEmpty(token) || string.IsNullOrEmpty(root)) return false;

            string body = "{\"type\":\"AgentError\",\"message\":\"crash reporting test from this PC\""
                + ",\"where\":\"crash-test\",\"level\":\"warning\",\"platform\":\"windows\",\"version\":\""
                + Agent.JsonText(Agent.Version) + "\"}";
            string answer = Send(root + "/api/mcp?worker=crash", token, body, true);
            if (answer == null) return false;
            return Json.Truth(Json.Parse(answer), "reported", false);
        }

        public static void Say(string message, string where, string level)
        {
            string token = Account.Token;
            string root = Account.Base;
            /* Not linked: there is nowhere to send it and nobody to attach it to. The console still has it. */
            if (string.IsNullOrEmpty(token) || string.IsNullOrEmpty(root)) return;
            if (string.IsNullOrEmpty(message)) return;

            string key = where + "|" + message;
            lock (Gate)
            {
                if (Told.ContainsKey(key)) return;
                Told[key] = true;
            }

            string stack = "";
            try { stack = Tidy(new StackTrace(1, true).ToString()); }
            catch { stack = ""; }

            StringBuilder sb = new StringBuilder();
            sb.Append("{\"type\":\"AgentError\",\"message\":\"").Append(Agent.JsonText(message))
              .Append("\",\"where\":\"").Append(Agent.JsonText(where))
              .Append("\",\"level\":\"").Append(Agent.JsonText(level))
              .Append("\",\"platform\":\"windows\",\"version\":\"").Append(Agent.JsonText(Agent.Version))
              .Append("\"");
            if (stack.Length > 0) sb.Append(",\"stack\":\"").Append(Agent.JsonText(stack)).Append("\"");
            sb.Append("}");
            string body = sb.ToString();

            /* Fire and forget, off whatever thread noticed. Nothing waits for this and nothing reads the
               answer: there is no useful thing to do about a crash report that did not arrive. */
            Thread t = new Thread(delegate() { Send(root + "/api/mcp?worker=crash", token, body, false); });
            t.IsBackground = true;
            t.Start();
        }

        /* The user's profile directory out of a trace. It carries their account name and says nothing
           useful. */
        static string Tidy(string text)
        {
            if (string.IsNullOrEmpty(text)) return "";
            string home = "";
            try { home = Environment.GetFolderPath(Environment.SpecialFolder.UserProfile); }
            catch { home = ""; }
            string cut = home.Length > 0 ? text.Replace(home, "~") : text;
            return cut.Length > 4000 ? cut.Substring(0, 4000) : cut;
        }

        /* Its own sender rather than the courier's. That one waits ninety seconds because it long-polls;
           a crash report that held a thread for a minute and a half would be a second fault. */
        static string Send(string url, string token, string body, bool wantAnswer)
        {
            try
            {
                HttpWebRequest req = (HttpWebRequest)WebRequest.Create(url);
                req.Method = "POST";
                req.ContentType = "application/json";
                req.Headers.Add("Authorization", "Bearer " + token);
                req.Timeout = 10000;
                req.ReadWriteTimeout = 10000;
                req.KeepAlive = false;
                byte[] payload = Encoding.UTF8.GetBytes(body);
                req.ContentLength = payload.Length;
                using (Stream s = req.GetRequestStream()) s.Write(payload, 0, payload.Length);
                using (HttpWebResponse res = (HttpWebResponse)req.GetResponse())
                {
                    if (!wantAnswer) return null;
                    using (StreamReader r = new StreamReader(res.GetResponseStream(), Encoding.UTF8))
                        return r.ReadToEnd();
                }
            }
            catch { /* Nothing to do about it, and nothing worth saying twice. */ }
            return null;
        }
    }

    /* The one outward-facing loop: ask for work, do it, say how it went.

       Long-polling rather than a fast poll - the endpoint holds the request open for up to half a minute
       with nothing to say - so an idle machine costs one request a minute rather than twenty, and an idle
       wait costs no CPU at either end. Backs off to a minute on failure, because an agent that hammers a
       deployment which is down makes the outage worse.

       One job at a time, and no queue of its own. There is one mouse. */
    public static class Courier
    {
        const int ClaimWaitSeconds = 25;
        static int _backoff = 2;

        public static void Begin()
        {
            /* Windows PowerShell's default is whatever ServicePointManager was left at, and on 5.1 that can
               still be TLS 1.0 - which every current deployment refuses at the handshake. Setting it here
               rather than at startup keeps it next to the only code that makes an outbound call. */
            try { ServicePointManager.SecurityProtocol = SecurityProtocolType.Tls12; }
            catch { /* A runtime without TLS 1.2 cannot reach the account at all; the request will say so. */ }

            Thread t = new Thread(new ThreadStart(Loop));
            t.IsBackground = true;
            t.Name = "mouseflow.courier";
            t.Start();
        }

        static void Loop()
        {
            while (true)
            {
                if (!Account.Taking) { Thread.Sleep(5000); continue; }

                string token = Account.Token;
                string root = Account.Base;
                int status;
                /* `kind: agent` says what this claimer is. Nothing depends on it - the WORKER declares
                   itself and that is what the queue reads, because a worker updates with `git pull` and an
                   agent is a compiled binary somebody has to reinstall. Sent anyway: it is true and costs
                   a field. */
                /* `steps: true` is what makes a goal skill claimable here at all. The queue asks the
                   claimer what it can do rather than assuming, for the reason written at that end: an agent
                   is a compiled binary somebody has to reinstall, so one that predates this goes on not
                   being given goals instead of taking one and answering that it does not understand. */
                string answer = Post(root + "/api/mcp?worker=claim", token,
                    "{\"worker\":\"" + Agent.JsonText(Environment.MachineName)
                    + "\",\"kind\":\"agent\",\"steps\":true,\"wait\":"
                    + ClaimWaitSeconds.ToString(CultureInfo.InvariantCulture) + "}", out status);

                if (status == 401 || status == 403)
                {
                    /* The token was revoked, or the account is gone. Stopping is the honest response:
                       retrying a refused credential for ever is a log nobody reads and a request nobody
                       wanted. */
                    Account.SetTaking(false);
                    Console.WriteLine("[mouseflow] the account refused this PC's token - taking work is now "
                        + "off. Pair again from the app.");
                    continue;
                }

                if (answer == null || status != 200)
                {
                    Console.WriteLine("[mouseflow] could not ask for work (HTTP " + status.ToString(CultureInfo.InvariantCulture)
                        + ") - waiting " + _backoff.ToString(CultureInfo.InvariantCulture) + "s");
                    /* Only at the top of the backoff: by then this PC has been unable to reach its account
                       for minutes. If the cause is the network rather than the account, this will not get
                       out either, which is honest. */
                    if (_backoff >= 60)
                    {
                        Crash.Say("cannot ask the account for work (HTTP "
                            + status.ToString(CultureInfo.InvariantCulture) + ")", "courier.claim");
                    }
                    Thread.Sleep(_backoff * 1000);
                    _backoff = Math.Min(60, _backoff * 2);
                    continue;
                }

                _backoff = 2;
                object job = Json.Child(Json.Parse(answer), "job");
                string id = Json.Text(job, "id");
                if (string.IsNullOrEmpty(id)) continue;   // nothing to do; the long poll simply timed out

                /* A goal is not carried, it is driven: the deployment decides one action at a time and
                   this end does them. It also closes the job itself, at the step that finishes - so there
                   is nothing to report here, and reporting would only overwrite what it said. */
                if (Json.Truth(job, "goal", false))
                {
                    Drive(root, token, id);
                    continue;
                }

                bool ok;
                string said;
                string body = Carry(job, out ok, out said);
                Report(root, token, id, ok, said, body);
            }
        }

        /* ------------------------------------------------------------------ carrying out a goal

           A goal skill is a sentence somebody wrote, carried out by a model that looks at the screen and
           chooses one action at a time. Until now that loop had to run on this machine, in a separate node
           process the user installed alongside this agent, for one reason: it talked to 127.0.0.1. Nothing
           else about it was local - the model call always went out over the network.

           So it moved, and this end became the hands:

               this  --POST ?worker=step { shot, windows, results }-->  the deployment decides
               this  <-------------  { actions: [...] }  -------------
                     does them, takes a new picture, posts again

           One request per step. Nothing reconnects between steps because there is no gap between them: the
           reply to one step is what produces the next. The decision takes several seconds, which is why the
           request is allowed to be slow - it is the model thinking, not a stall.

           WHAT THIS END NEVER DECIDES: what to do. It reports what it sees and does what it is told. */

        const int StepFirstWidth = 1280;
        const int SettlePollMs = 1500;
        const int SettleQuietFrames = 2;
        /* Every third screen look, so a cancellation lands inside four and a half seconds of a wait that
           may run for two minutes. Anything asked for while this end sits still is worth one small
           request. */
        const int StopEveryPolls = 3;
        /* Whether a stop arrived while this end was busy. Set by the wait, read by the driver. */
        static bool _stopSeen = false;

        static void Drive(string root, string token, string id)
        {
            int width = StepFirstWidth;
            string results = "";

            while (true)
            {
                /* One mouse. A replay started from the app while this is running would fight it for the
                   pointer, and the run is the thing that can be resumed - so this one gives way. */
                if (Agent.IsPlaying)
                {
                    Report(root, token, id, false, "This PC started replaying something else while the goal "
                        + "was running, so the run was stopped.", null);
                    return;
                }
                if (string.IsNullOrEmpty(Account.Token)) return;   // unpaired mid-run: nowhere to report to

                string shot = Agent.Shot(width);
                StringBuilder sb = new StringBuilder();
                sb.Append("{\"id\":\"").Append(Agent.JsonText(id)).Append("\",\"shot\":").Append(shot)
                  .Append(",\"windows\":").Append(Agent.WindowsArray())
                  .Append(",\"results\":[").Append(results).Append("]}");

                /* One retry, and only for the failures that pass.

                   A run is minutes long and a deployment can be swapped under it - that is a few seconds of
                   5xx, and losing a half-finished run to it is a poor trade for one extra request. A 4xx is
                   different: a revoked token or a refused body will say the same thing twice. */
                int status = 0;
                string answer = null;
                for (int attempt = 0; attempt < 2; attempt++)
                {
                    answer = Post(root + "/api/mcp?worker=step", token, sb.ToString(), out status);
                    if (answer != null && status == 200) break;
                    if (attempt == 0 && (status == 0 || status >= 500))
                    {
                        Console.WriteLine("[mouseflow] a step of the goal run did not land (HTTP "
                            + status.ToString(CultureInfo.InvariantCulture) + "); one more try");
                        Thread.Sleep(2000);
                        continue;
                    }
                    break;
                }

                if (answer == null || status != 200)
                {
                    Console.WriteLine("[mouseflow] the goal run was refused (HTTP "
                        + status.ToString(CultureInfo.InvariantCulture) + ")");
                    Crash.Say("a goal step was refused: HTTP "
                        + status.ToString(CultureInfo.InvariantCulture), "courier.step");
                    Report(root, token, id, false, status == 0
                        ? "This PC lost contact with the account part-way through the run."
                        : "The account refused a step of this run (HTTP "
                          + status.ToString(CultureInfo.InvariantCulture) + ").", null);
                    return;
                }

                object raw = Json.Parse(answer);
                /* Over, one way or another - finished, cancelled, or the job is gone. The deployment has
                   already written the outcome; saying anything here would only overwrite it. */
                if (Json.Truth(raw, "done", false)) return;

                /* Too large to send. Not a failure and not a step: take a smaller picture and ask again
                   with no results, because nothing was done. */
                int shrink = Json.Int(raw, "shrink", 0);
                if (shrink > 0)
                {
                    width = Math.Max(320, shrink);
                    results = "";
                    continue;
                }

                List<object> actions = Json.Child(raw, "actions") as List<object>;
                List<string> got = new List<string>();
                if (actions != null)
                {
                    foreach (object action in actions)
                    {
                        got.Add(Perform(action, root, token, id));
                        /* A stop that arrived while this was waiting. The rest of the turn is abandoned and
                           the results so far are posted anyway: the deployment answers "done", writes the
                           run to the account and clears the row, which is tidier than this end deciding
                           any of that. */
                        if (_stopSeen) break;
                    }
                }
                if (_stopSeen) _stopSeen = false;
                results = string.Join(",", got.ToArray());
            }
        }

        /// One instruction from the deployment, and what to say came of it.
        static string Perform(object action, string root, string token, string job)
        {
            string id = Json.Text(action, "id");
            if (id == null) id = "";

            if (Json.Text(action, "kind") == "wait")
            {
                int ms = Math.Min(120000, Math.Max(200, Json.Int(action, "ms", 2000)));
                int waited;
                int quietFor;
                bool quiet = Settle(ms, root, token, job, out waited, out quietFor);
                /* Numbers, not a sentence. What the model is told about a wait is one of the things both
                   ends have to say identically, so the wording is composed at the deployment from these. */
                return "{\"id\":\"" + Agent.JsonText(id) + "\",\"quiet\":" + (quiet ? "true" : "false")
                    + ",\"waited\":" + waited.ToString(CultureInfo.InvariantCulture)
                    + ",\"quietFor\":" + quietFor.ToString(CultureInfo.InvariantCulture) + "}";
            }

            string line = Json.Text(action, "body");
            if (string.IsNullOrEmpty(line))
            {
                return "{\"id\":\"" + Agent.JsonText(id) + "\",\"isError\":true,\"output\":\"nothing to do\"}";
            }
            string bad = Agent.DoAction(line);
            if (bad != null)
            {
                return "{\"id\":\"" + Agent.JsonText(id) + "\",\"isError\":true,\"output\":\""
                    + Agent.JsonText(bad) + "\"}";
            }
            /* A moment for the screen to react before the next picture, or it shows the state before this.
               The same 350ms the app's own loop leaves. */
            Thread.Sleep(350);
            return "{\"id\":\"" + Agent.JsonText(id) + "\",\"output\":\"done\"}";
        }

        /* Waiting, done here rather than by asking the model to look again.

           A wait used to cost a screenshot and a decision, so waiting for a page to load burned the budget
           the run needed to finish it. The 64x36 fingerprint is 3KB and costs nothing, and the numbers here
           are the ones the app's own loop uses - 1.5s between looks, two still frames, a mean difference of
           3 out of 255 being the line between dither and movement. They agree on purpose. */
        static bool Settle(int limitMs, string root, string token, string job, out int waited, out int quietFor)
        {
            DateTime started = DateTime.UtcNow;
            byte[] last = null;
            DateTime quietSince = DateTime.MinValue;
            int polls = 0;
            waited = 0;
            quietFor = 0;

            while ((int)(DateTime.UtcNow - started).TotalMilliseconds < limitMs)
            {
                Thread.Sleep(SettlePollMs);
                /* Every third look, so a stop is noticed inside a long wait rather than two minutes after
                   it. Not every look: this one is a request to the account, and the screen check is not. */
                polls++;
                if (polls % StopEveryPolls == 0 && Cancelled(root, token, job))
                {
                    _stopSeen = true;
                    waited = (int)(DateTime.UtcNow - started).TotalMilliseconds;
                    return false;
                }
                byte[] now = null;
                try { now = Agent.Grid(); }
                catch { now = null; }
                if (now == null) break;   // no screen to watch; the next picture reports it properly

                if (last != null && !Moved(last, now))
                {
                    if (quietSince == DateTime.MinValue) quietSince = DateTime.UtcNow;
                    int still = (int)(DateTime.UtcNow - quietSince).TotalMilliseconds;
                    int frames = (int)Math.Round((double)still / SettlePollMs) + 1;
                    if (frames >= SettleQuietFrames)
                    {
                        waited = (int)(DateTime.UtcNow - started).TotalMilliseconds;
                        quietFor = still;
                        return true;
                    }
                }
                else
                {
                    quietSince = DateTime.MinValue;
                }
                last = now;
            }

            waited = (int)(DateTime.UtcNow - started).TotalMilliseconds;
            return false;
        }

        /* Has this job been called off? The queue already answers exactly this, for the worker, and a wait
           is the one place where the next step is too far away to find out. */
        static bool Cancelled(string root, string token, string job)
        {
            try
            {
                HttpWebRequest req = (HttpWebRequest)WebRequest.Create(
                    root + "/api/mcp?worker=state&id=" + Uri.EscapeDataString(job));
                req.Method = "GET";
                req.Headers.Add("Authorization", "Bearer " + token);
                req.Timeout = 8000;
                req.ReadWriteTimeout = 8000;
                req.KeepAlive = false;
                using (HttpWebResponse res = (HttpWebResponse)req.GetResponse())
                using (StreamReader r = new StreamReader(res.GetResponseStream(), Encoding.UTF8))
                {
                    string state = Json.Text(Json.Parse(r.ReadToEnd()), "state");
                    return state != null && state != "claimed";
                }
            }
            catch { return false; }   // no answer is not an answer; the next step will find out
        }

        static bool Moved(byte[] a, byte[] b)
        {
            if (a.Length != b.Length) return true;
            long sum = 0;
            for (int i = 0; i < a.Length; i++) sum += Math.Abs((int)a[i] - (int)b[i]);
            return (double)sum / a.Length > 3;
        }

        /* ------------------------------------------------------------------ doing it */

        static string Carry(object job, out bool ok, out string said)
        {
            string command = Json.Text(job, "command");

            if (command == "#record.start")
            {
                if (!Agent.HookInstalled)
                {
                    ok = false;
                    said = "This PC has no input hook, so nothing would be captured.";
                    return null;
                }
                if (Agent.IsPlaying) { ok = false; said = "It is replaying something right now."; return null; }
                string refused = Agent.RecordStart(Json.Int(Json.Child(job, "args"), "moveMs", 0));
                if (refused != null) { ok = false; said = refused; return null; }
                ok = true;
                said = "Recording. It captures clicks, drags, scrolls and pointer movement, and that a key "
                    + "was pressed - never which key.";
                return null;
            }

            if (command == "#record.stop")
            {
                if (!Agent.IsRecording) { ok = false; said = "Nothing was recording."; return null; }
                ok = true;
                said = "";
                return Agent.RecordStop();
            }

            string replay = Json.Text(job, "body");
            if (!string.IsNullOrEmpty(replay))
            {
                /* A skill, as a replay body the deployment built. Everything that makes it a skill - the
                   events, the parameters, the tool definition - stayed there; what arrives here is the
                   format this agent has always spoken. */
                string raise = Json.Text(job, "activate");
                if (!string.IsNullOrEmpty(raise)) { Agent.DoAction(raise); Thread.Sleep(350); }

                string refused = Agent.StartReplay(replay);
                if (refused != null) { ok = false; said = refused; return null; }

                /* Waited out here rather than reported as started: an answer that arrives before the work
                   has happened has told the caller nothing. */
                DateTime until = DateTime.UtcNow.AddMinutes(30);
                while (Agent.IsPlaying && DateTime.UtcNow < until) Thread.Sleep(400);
                if (Agent.IsPlaying)
                {
                    ok = false;
                    said = "It was still replaying after thirty minutes.";
                    return null;
                }
                ok = true;
                said = "Replayed it on this PC. What the applications did with it is not something MouseFlow "
                    + "can see; the actions were sent.";
                return null;
            }

            ok = false;
            said = "This PC was asked to do something it does not understand. Its agent may be older than "
                + "the account expects.";
            return null;
        }

        static void Report(string root, string token, string id, bool ok, string said, string body)
        {
            StringBuilder sb = new StringBuilder();
            sb.Append("{\"id\":\"").Append(Agent.JsonText(id)).Append("\",\"ok\":").Append(ok ? "true" : "false")
              .Append(",\"said\":\"").Append(Agent.JsonText(said == null ? "" : said)).Append("\"");
            if (body != null)
            {
                sb.Append(",\"body\":\"").Append(Agent.JsonText(body)).Append("\"");
                /* What this agent is, at the moment of the recording - the only moment the answer exists.
                   The row the deployment writes stamps it, exactly as the app's own does. */
                sb.Append(",\"health\":{\"version\":\"").Append(Agent.JsonText(Agent.Version))
                  .Append("\",\"canName\":true,\"canKeys\":").Append(Agent.HookInstalled ? "true" : "false").Append("}");
            }
            sb.Append("}");

            int status;
            if (Post(root + "/api/mcp?worker=report", token, sb.ToString(), out status) == null)
            {
                /* The work happened and the answer did not arrive. Said out loud, because the person on the
                   other end is being told nothing picked it up while something did. */
                Console.WriteLine("[mouseflow] the outcome of " + id + " could not be reported");
            }
        }

        /* ------------------------------------------------------------------ the wire */

        static string Post(string url, string token, string body, out int status)
        {
            status = 0;
            try
            {
                HttpWebRequest req = (HttpWebRequest)WebRequest.Create(url);
                req.Method = "POST";
                req.ContentType = "application/json";
                req.Headers.Add("Authorization", "Bearer " + token);
                /* Longer than the endpoint's own wait, so a long poll that answers at the last moment is an
                   answer rather than a timeout this end invented. */
                req.Timeout = 90000;
                req.ReadWriteTimeout = 90000;
                req.KeepAlive = false;

                byte[] payload = Encoding.UTF8.GetBytes(body);
                req.ContentLength = payload.Length;
                using (Stream s = req.GetRequestStream()) s.Write(payload, 0, payload.Length);

                using (HttpWebResponse res = (HttpWebResponse)req.GetResponse())
                {
                    status = (int)res.StatusCode;
                    using (StreamReader r = new StreamReader(res.GetResponseStream(), Encoding.UTF8))
                        return r.ReadToEnd();
                }
            }
            catch (WebException ex)
            {
                HttpWebResponse res = ex.Response as HttpWebResponse;
                if (res != null)
                {
                    status = (int)res.StatusCode;
                    try
                    {
                        using (StreamReader r = new StreamReader(res.GetResponseStream(), Encoding.UTF8))
                            return r.ReadToEnd();
                    }
                    catch { return null; }
                }
                return null;
            }
            catch { return null; }
        }
    }

    /* The tray icon: what the agent looks like to a person.
     *
     * The macOS agent grew a menu bar item for a reason that applies here in reverse. There, a login item
     * with no window left the user no way to stop it; here the console window IS the stop button, and that
     * is a stop button which also has to stay open, cannot say whether a recording is running, and cannot
     * start one. So: an icon that shows the state, starts and stops a recording, and quits.
     *
     * Its own STA thread with its own Application.Run, and that is not a detail. NotifyIcon and
     * ContextMenuStrip need an STA thread with a message pump; the agent already has a pump, but it belongs
     * to the low-level hooks, and a hook pump that stalls is a hook Windows silently removes
     * (LowLevelHooksTimeout). Nothing about drawing a menu may ever run on that thread. ServeForever owns
     * the main thread, so the tray gets a third of its own.
     *
     * Everything the menu does is a call into Agent, which is locked - the tray holds no state of its own. */
    public static class Tray
    {
        static System.Windows.Forms.NotifyIcon _icon;
        static System.Windows.Forms.ContextMenuStrip _menu;
        static System.Windows.Forms.ToolStripMenuItem _start;
        static System.Windows.Forms.ToolStripMenuItem _stop;
        static System.Windows.Forms.ToolStripMenuItem _heldNote;
        static System.Windows.Forms.ToolStripMenuItem _taking;
        static System.Windows.Forms.ToolStripSeparator _sep;
        static System.Drawing.Icon _idleIcon;
        static System.Drawing.Icon _liveIcon;
        static bool _showingLive;
        static Thread _thread;

        public static string LastError;

        public static void Start()
        {
            _thread = new Thread(new ThreadStart(Pump));
            _thread.IsBackground = true;
            _thread.SetApartmentState(ApartmentState.STA);
            _thread.Start();
        }

        /* Drawn rather than shipped: a .ps1 fetched and run in memory has no file next to it to load an
         * icon from, which is the whole shape of this agent's install. A ring when idle, a filled dot when
         * recording - the same "recording light" the macOS status item shows. */
        static System.Drawing.Icon Dot(bool filled)
        {
            using (System.Drawing.Bitmap bmp = new System.Drawing.Bitmap(16, 16))
            {
                using (System.Drawing.Graphics g = System.Drawing.Graphics.FromImage(bmp))
                {
                    g.SmoothingMode = System.Drawing.Drawing2D.SmoothingMode.AntiAlias;
                    g.Clear(System.Drawing.Color.Transparent);
                    if (filled)
                    {
                        using (System.Drawing.SolidBrush b = new System.Drawing.SolidBrush(System.Drawing.Color.FromArgb(230, 70, 70)))
                            g.FillEllipse(b, 2, 2, 12, 12);
                    }
                    else
                    {
                        using (System.Drawing.Pen p = new System.Drawing.Pen(System.Drawing.Color.FromArgb(230, 230, 230), 2f))
                            g.DrawEllipse(p, 3, 3, 10, 10);
                    }
                }
                return System.Drawing.Icon.FromHandle(bmp.GetHicon());
            }
        }

        static void Pump()
        {
            try
            {
                _idleIcon = Dot(false);
                _liveIcon = Dot(true);

                _menu = new System.Windows.Forms.ContextMenuStrip();
                System.Windows.Forms.ToolStripMenuItem header = new System.Windows.Forms.ToolStripMenuItem("MouseFlow agent " + Agent.Version);
                header.Enabled = false;
                _menu.Items.Add(header);
                System.Windows.Forms.ToolStripMenuItem note = new System.Windows.Forms.ToolStripMenuItem("Records only between Start and Stop");
                note.Enabled = false;
                _menu.Items.Add(note);
                _menu.Items.Add(new System.Windows.Forms.ToolStripSeparator());

                _start = new System.Windows.Forms.ToolStripMenuItem("Start Recording");
                _start.Click += delegate { OnStart(); };
                _menu.Items.Add(_start);

                _stop = new System.Windows.Forms.ToolStripMenuItem("Stop and Save Recording");
                _stop.Click += delegate { OnStop(); };
                _menu.Items.Add(_stop);

                /* Where a stopped recording IS, said in the menu, because "I pressed Save and nothing
                 * visible happened" reads as loss. */
                _heldNote = new System.Windows.Forms.ToolStripMenuItem("");
                _heldNote.Enabled = false;
                _menu.Items.Add(_heldNote);

                /* Taking work is the only thing this agent does because a SERVICE said so; everything
                 * else happens because something on this machine asked. That difference belongs where the
                 * person can see it and turn it off, which on Windows is here. */
                _taking = new System.Windows.Forms.ToolStripMenuItem("");
                _taking.Click += delegate { OnTaking(); };
                _menu.Items.Add(_taking);

                _sep = new System.Windows.Forms.ToolStripSeparator();
                _menu.Items.Add(_sep);

                System.Windows.Forms.ToolStripMenuItem quit = new System.Windows.Forms.ToolStripMenuItem("Quit MouseFlow Agent");
                quit.Click += delegate
                {
                    /* Taken down first: an icon whose process is gone lingers in the tray until somebody
                     * hovers over it, which reads as an agent that would not quit. */
                    try { _icon.Visible = false; _icon.Dispose(); } catch { }
                    Environment.Exit(0);
                };
                _menu.Items.Add(quit);

                _menu.Opening += delegate { Refresh(); };

                _icon = new System.Windows.Forms.NotifyIcon();
                _icon.Icon = _idleIcon;
                _icon.Text = "MouseFlow agent";
                _icon.ContextMenuStrip = _menu;
                _icon.Visible = true;

                /* The icon is also the recording light. One second is finer than a person can see a state
                 * change, and the tick costs a locked bool. */
                System.Windows.Forms.Timer light = new System.Windows.Forms.Timer();
                light.Interval = 1000;
                light.Tick += delegate
                {
                    bool live = Agent.IsRecording;
                    if (live != _showingLive)
                    {
                        _showingLive = live;
                        _icon.Icon = live ? _liveIcon : _idleIcon;
                        _icon.Text = live ? "MouseFlow agent - recording" : "MouseFlow agent";
                    }
                };
                light.Start();

                Refresh();
                System.Windows.Forms.Application.Run();
            }
            catch (Exception ex)
            {
                /* A tray that cannot be drawn must not take the agent with it: the HTTP half is the
                 * product, the icon is how a person reaches it. Said in the banner, not swallowed. */
                LastError = ex.Message;
            }
        }

        /* Shown when the menu opens, which is the only moment visibility matters. */
        static void Refresh()
        {
            bool recording = Agent.IsRecording;
            bool held = Agent.HasHeld;
            _start.Visible = !recording && !held && Agent.HookInstalled;
            _stop.Visible = recording;
            /* Only once this PC is attached: an item that says "not taking work" to somebody who has
               never paired is an offer to switch on something they have not got. */
            _taking.Visible = Account.Linked;
            _taking.Text = Account.Taking
                ? "Taking work from your account - click to stop"
                : "Not taking work - click to start";

            _heldNote.Visible = held;
            if (held)
            {
                _heldNote.Text = "Recording saved here - the app collects it ("
                    + Agent.HeldEvents.ToString(CultureInfo.InvariantCulture) + " events)";
            }
            _sep.Visible = true;
        }

        /* Off the tray thread, both of them: EndFromTray waits up to 1.5s for the resolver - which is still
         * naming the very clicks that opened this menu - and a menu that freezes while it works reads as a
         * hung agent. */
        static void OnTaking()
        {
            Account.SetTaking(!Account.Taking);
        }

        static void OnStart()
        {
            Thread t = new Thread(new ThreadStart(delegate { Agent.RecordStart(0); }));
            t.IsBackground = true;
            t.SetApartmentState(ApartmentState.MTA);
            t.Start();
        }

        static void OnStop()
        {
            Thread t = new Thread(new ThreadStart(delegate
            {
                Agent.EndFromTray();
                /* Said out loud. The menu closes the instant it is clicked and the recording goes nowhere
                 * visible - to the person who pressed Save, silence and loss look identical. */
                try
                {
                    int n = Agent.HeldEvents;
                    _icon.BalloonTipTitle = "Recording saved";
                    _icon.BalloonTipText = n > 0
                        ? n.ToString(CultureInfo.InvariantCulture)
                            + " events kept - open MouseFlow and they go to your account"
                        : "Nothing was captured in it.";
                    _icon.ShowBalloonTip(4000);
                }
                catch { }
            }));
            t.IsBackground = true;
            t.SetApartmentState(ApartmentState.MTA);
            t.Start();
        }
    }

}
'@

[MouseFlow.Agent]::Configure($MoveThrottleMs, $MoveMinPx)
[MouseFlow.Agent]::AllowOrigin = $AllowOrigin
[MouseFlow.Agent]::Port = $Port
# Empty when the script was piped in rather than run from a file. Autostart needs a real path.
if ($PSCommandPath) { [MouseFlow.Agent]::ScriptPath = $PSCommandPath }
[MouseFlow.Agent]::StartHookPump()

Start-Sleep -Milliseconds 250
$err = [MouseFlow.Agent]::LastError
if ($err) { throw "Could not install the mouse hook: $err" }

# A recording stopped from the tray and never collected - this process is the second one, and the events
# are on disk where the first one left them. Loaded before anything can start a new recording over them.
[MouseFlow.Agent]::LoadHeld()

# Whether this PC is attached to an account, read before anything can ask for work. A missing or unreadable
# file means "not linked", which is the safe answer - see the Account class.
[MouseFlow.Account]::Load()
# The one outward-facing loop. It does nothing at all until somebody switches taking on from the app, and
# an agent that is not taking work makes no outbound call.
[MouseFlow.Courier]::Begin()

if (-not $NoTray) { [MouseFlow.Tray]::Start() }

Write-Host ""
# Read from the compiled constant, never written twice. A hardcoded banner said 0.1.0 while the code
# was 0.2.0, so the one place a user checks which build they are running was the one place that lied.
Write-Host ("  MouseFlow agent " + [MouseFlow.Agent]::Version) -ForegroundColor Cyan
Write-Host "  listening   http://127.0.0.1:$Port"
Write-Host "  origin      $AllowOrigin"
Write-Host "  move filter $MoveThrottleMs ms / $MoveMinPx px"
Write-Host "  can see     yes - /shot, /do and /windows are available to the app"
# Said in the banner as well as the tray: this is the one thing the agent does because a service asked, and
# somebody reading a console window should not have to open a menu to find out whether it is on.
if ([MouseFlow.Account]::Linked) {
    if ([MouseFlow.Account]::Taking) {
        Write-Host "  account     attached - taking work (turn it off in the tray)" -ForegroundColor Yellow
    } else {
        Write-Host "  account     attached - not taking work"
    }
} else {
    Write-Host "  account     not attached - nothing reaches in"
}
if ($NoTray) {
    Write-Host "  tray        off (-NoTray) - start and stop from the app"
} else {
    Start-Sleep -Milliseconds 300
    $trayErr = [MouseFlow.Tray]::LastError
    if ($trayErr) {
        Write-Host "  tray        NOT shown: $trayErr" -ForegroundColor Yellow
        Write-Host "              the agent works; start and stop from the app instead"
    } else {
        Write-Host "  tray        in the notification area - start and stop a recording there"
    }
}
$heldAtStart = [MouseFlow.Agent]::HeldEvents
if ($heldAtStart -gt 0) {
    Write-Host "  waiting     a recording of $heldAtStart events is held for the app to collect" -ForegroundColor Cyan
}
Write-Host ""
if ($AllowOrigin -eq '*') {
    Write-Warning "Any site open in your browser can drive your mouse while this agent runs."
    Write-Warning "Pin it before sharing:  -AllowOrigin https://your-app.vercel.app"
    Write-Host ""
}
Write-Host "  Hold ESC to abort a replay. Ctrl+C to stop the agent." -ForegroundColor DarkGray
Write-Host ""

[MouseFlow.Agent]::ServeForever($Port)
