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
    POST /record/start    -> JSON {ok}
    GET  /record/status   -> JSON {recording, count, elapsedMs}
    POST /record/stop     -> text/plain, one event per line (.mmmacro format)
    POST /replay          -> JSON {ok}   body: see FLOW BODY below
    GET  /replay/status   -> JSON {playing, step, steps, pass, passes, index, total}
    POST /replay/abort    -> JSON {ok}
    GET  /shot            -> JSON {ok, png, w, h, scale, originX, originY}  a look at the screen
    GET  /windows         -> JSON {ok, windows:[{title, process, active, minimized, x, y, w, h}]}
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
#>
[CmdletBinding()]
param(
    [int]$Port = 8787,
    [string]$AllowOrigin = '*',
    [int]$MoveThrottleMs = 10,
    [int]$MoveMinPx = 3
)

$ErrorActionPreference = 'Stop'

# System.Drawing is referenced for /shot: capturing the screen is what lets the app act on a goal
# described in words rather than only replay something recorded earlier.
Add-Type -ReferencedAssemblies 'System.Drawing' -TypeDefinition @'
using System;
using System.Collections.Generic;
using System.Diagnostics;
using System.Globalization;
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
        public const uint LLMHF_INJECTED = 0x00000001;

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
        public const string Version = "0.3.0";

        static readonly object Gate = new object();
        static Native.HookProc _proc;   // must outlive the hook or the GC eats it
        static IntPtr _hook = IntPtr.Zero;

        static bool _recording;
        static List<Ev> _buffer = new List<Ev>();
        static Stopwatch _clock = new Stopwatch();
        static long _lastStamp;
        static int _lastX, _lastY;
        static bool _haveLast;
        static int _throttleMs = 10;
        static int _minPx = 3;

        static bool _playing;
        static bool _abort;
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
                return;
            }
            MSG msg;
            while (Native.GetMessage(out msg, IntPtr.Zero, 0, 0) > 0)
            {
                Native.TranslateMessage(ref msg);
                Native.DispatchMessage(ref msg);
            }
            Native.UnhookWindowsHookEx(_hook);
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

                if (action == "Mouse Movement")
                {
                    // The raw hook fires hundreds of moves a second. Keep only the
                    // ones that carry information: far enough apart in time AND space.
                    if (_haveLast)
                    {
                        int dx = Math.Abs(data.pt.X - _lastX);
                        int dy = Math.Abs(data.pt.Y - _lastY);
                        if ((now - _lastStamp) < _throttleMs) return;
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

                _lastStamp = now;
                _lastX = data.pt.X;
                _lastY = data.pt.Y;
                _haveLast = true;
            }
        }

        public static void RecordStart()
        {
            lock (Gate)
            {
                _buffer = new List<Ev>();
                _haveLast = false;
                _lastStamp = 0;
                _clock.Reset();
                _clock.Start();
                _recording = true;
            }
        }

        public static string RecordStop()
        {
            List<Ev> taken;
            lock (Gate)
            {
                _recording = false;
                _clock.Stop();
                taken = _buffer;
                _buffer = new List<Ev>();
            }
            return Serialize(taken);
        }

        public static string Serialize(List<Ev> list)
        {
            StringBuilder sb = new StringBuilder();
            for (int i = 0; i < list.Count; i++)
            {
                Ev e = list[i];
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
        public static int RecordCount { get { lock (Gate) { return _buffer.Count; } } }
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
                if (aborted) ReleaseAllButtons();
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

        static void Emit(Ev e)
        {
            int vx = Native.GetSystemMetrics(Native.SM_XVIRTUALSCREEN);
            int vy = Native.GetSystemMetrics(Native.SM_YVIRTUALSCREEN);
            int vw = Native.GetSystemMetrics(Native.SM_CXVIRTUALSCREEN);
            int vh = Native.GetSystemMetrics(Native.SM_CYVIRTUALSCREEN);
            if (vw < 2) vw = 2;
            if (vh < 2) vh = 2;

            int nx = (int)Math.Round((e.X - vx) * 65535.0 / (vw - 1));
            int ny = (int)Math.Round((e.Y - vy) * 65535.0 / (vh - 1));

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
                default: return;
            }

            INPUT[] inputs = new INPUT[1];
            inputs[0].type = Native.INPUT_MOUSE;
            inputs[0].mi.dx = nx;
            inputs[0].mi.dy = ny;
            inputs[0].mi.mouseData = data;
            inputs[0].mi.dwFlags = flags;
            inputs[0].mi.time = 0;
            inputs[0].mi.dwExtraInfo = IntPtr.Zero;
            Native.SendInput(1, inputs, Marshal.SizeOf(typeof(INPUT)));
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

            if (action == "type") return TypeText(Get(a, "text", ""));
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

            int textAt = line.IndexOf("text=", StringComparison.Ordinal);
            if (textAt >= 0)
            {
                found["text"] = line.Substring(textAt + 5);
                line = line.Substring(0, textAt);
            }

            string[] parts = line.Split(new char[] { ' ', '\t' }, StringSplitOptions.RemoveEmptyEntries);
            for (int i = 0; i < parts.Length; i++)
            {
                int eq = parts[i].IndexOf('=');
                if (eq <= 0) continue;
                string key = parts[i].Substring(0, eq).Trim().ToLowerInvariant();
                if (key == "text") continue;                     // already taken, whole and unsplit
                found[key] = parts[i].Substring(eq + 1).Trim();
            }
            return found;
        }

        static string Get(Dictionary<string, string> from, string key, string fallback)
        {
            string value;
            return from.TryGetValue(key, out value) ? value : fallback;
        }

        static string TypeText(string text)
        {
            if (text == null || text.Length == 0) return "nothing to type";
            if (text.Length > 4000) return "that is more text than this will type in one go";

            /* Sent as Unicode rather than as virtual keys: a keycode depends on the keyboard layout,
               and text typed through them comes out wrong on any layout but the author's. */
            for (int i = 0; i < text.Length; i++)
            {
                char c = text[i];
                if (c == '\n' || c == '\r')
                {
                    PressKey("Enter", false, false, false);
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
            Native.SendInput(1, inputs, Marshal.SizeOf(typeof(INPUTU)));
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
            Native.SendInput(1, inputs, Marshal.SizeOf(typeof(INPUTU)));
        }

        static string PressKey(string key, bool ctrl, bool shift, bool alt)
        {
            ushort vk = VkFor(key);
            if (vk == 0) return "unknown key: " + key;

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

            return "{\"ok\":true,\"windows\":[" + string.Join(",", items.ToArray()) + "]}";
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
            if (!Native.SetForegroundWindow(found))
            {
                SendVk(0x12, false);            // ALT down
                SendVk(0x12, true);             // ALT up - releases the foreground lock
                Thread.Sleep(30);
                if (!Native.SetForegroundWindow(found))
                {
                    return "that window would not come to the front - click it on the taskbar instead";
                }
            }
            Thread.Sleep(250);                  // let it paint before the next screenshot
            return null;
        }

        /* ------------------------------------------------------------------------- the seeing half
         *
         * The whole virtual desktop, shrunk to something a model can read without a picture the size
         * of a novel. `scale` is what it was shrunk by and originX/originY are where the desktop
         * starts - a multi-monitor origin is often negative - so a point on the picture maps back to
         * a point on the screen with two multiplications and an add. Nothing is written to disk.
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

            double scale = vw > maxWidth ? (double)maxWidth / vw : 1.0;
            int sw = (int)Math.Round(vw * scale);
            int sh = (int)Math.Round(vh * scale);

            using (System.Drawing.Bitmap full = new System.Drawing.Bitmap(vw, vh))
            {
                using (System.Drawing.Graphics g = System.Drawing.Graphics.FromImage(full))
                {
                    g.CopyFromScreen(vx, vy, 0, 0, new System.Drawing.Size(vw, vh));
                }
                using (System.Drawing.Bitmap small = new System.Drawing.Bitmap(full, sw, sh))
                using (System.IO.MemoryStream buffer = new System.IO.MemoryStream())
                {
                    small.Save(buffer, System.Drawing.Imaging.ImageFormat.Png);
                    string png = Convert.ToBase64String(buffer.ToArray());
                    StringBuilder sb = new StringBuilder();
                    sb.Append("{\"ok\":true,\"w\":").Append(sw.ToString(CultureInfo.InvariantCulture));
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
                Native.SendInput(1, inputs, Marshal.SizeOf(typeof(INPUT)));
            }
        }

        // ---------- flow body parsing ----------

        static Flow ParseFlow(string body)
        {
            Flow flow = new Flow();
            Step current = null;
            if (body == null) return flow;

            string[] lines = body.Replace("\r\n", "\n").Replace("\r", "\n").Split('\n');
            for (int i = 0; i < lines.Length; i++)
            {
                string line = lines[i].Trim();
                if (line.Length == 0) continue;
                if (line.StartsWith("#")) continue;

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
                int q = path.IndexOf('?');
                if (q >= 0) path = path.Substring(0, q);

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

                Route(stream, method, path, body, origin);
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

        static void Route(NetworkStream stream, string method, string path, string body, string origin)
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
                    /* Separate from canSee because it arrived later: an 0.2.0 agent can act on
                       pictures but cannot say what is already open, and the app degrades to that
                       rather than refusing to run. */
                    + ",\"canWindows\":true"
                    + "}";
                Respond(stream, 200, "application/json", json, origin);
                return;
            }

            if (path == "/record/start" && method == "POST")
            {
                if (_hook == IntPtr.Zero) { Respond(stream, 500, "application/json", "{\"ok\":false,\"error\":\"hook not installed\"}", origin); return; }
                RecordStart();
                Respond(stream, 200, "application/json", "{\"ok\":true}", origin);
                return;
            }

            if (path == "/record/status")
            {
                string json = "{\"recording\":" + (IsRecording ? "true" : "false")
                    + ",\"count\":" + RecordCount.ToString(CultureInfo.InvariantCulture)
                    + ",\"elapsedMs\":" + RecordElapsed.ToString(CultureInfo.InvariantCulture) + "}";
                Respond(stream, 200, "application/json", json, origin);
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
                /* Deliberately not while replaying: a picture taken mid-replay shows a screen that is
                   already moving, and a decision made from it acts on something that has gone. */
                if (IsPlaying) { Respond(stream, 409, "application/json", "{\"ok\":false,\"error\":\"busy replaying\"}", origin); return; }
                Respond(stream, 200, "application/json", Shot(1280), origin);
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

Write-Host ""
# Read from the compiled constant, never written twice. A hardcoded banner said 0.1.0 while the code
# was 0.2.0, so the one place a user checks which build they are running was the one place that lied.
Write-Host ("  MouseFlow agent " + [MouseFlow.Agent]::Version) -ForegroundColor Cyan
Write-Host "  listening   http://127.0.0.1:$Port"
Write-Host "  origin      $AllowOrigin"
Write-Host "  move filter $MoveThrottleMs ms / $MoveMinPx px"
Write-Host "  can see     yes - /shot, /do and /windows are available to the app"
Write-Host ""
if ($AllowOrigin -eq '*') {
    Write-Warning "Any site open in your browser can drive your mouse while this agent runs."
    Write-Warning "Pin it before sharing:  -AllowOrigin https://your-app.vercel.app"
    Write-Host ""
}
Write-Host "  Hold ESC to abort a replay. Ctrl+C to stop the agent." -ForegroundColor DarkGray
Write-Host ""

[MouseFlow.Agent]::ServeForever($Port)
