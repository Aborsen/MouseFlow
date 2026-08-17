<#
.SYNOPSIS
  MouseFlow local agent. Records global mouse input and replays it, exposing a
  small HTTP API on loopback so the MouseFlow web app can drive it.

.DESCRIPTION
  The browser cannot see mouse events outside its own window, and cannot inject
  real OS clicks. This agent supplies both halves:

    recording  SetWindowsHookEx(WH_MOUSE_LL) on a dedicated message-pump thread
    replay     SendInput with absolute virtual-desktop coordinates

  It listens on http://127.0.0.1:<Port> and answers CORS + Private Network
  Access preflights so an https:// page (e.g. a Vercel deployment) can call it.

  API
    GET  /health          -> JSON {ok, version, screen, recording, playing}
    POST /record/start    -> JSON {ok}
    GET  /record/status   -> JSON {recording, count, elapsedMs}
    POST /record/stop     -> text/plain, one event per line (.mmmacro format)
    POST /replay          -> JSON {ok}   body: see FLOW BODY below
    GET  /replay/status   -> JSON {playing, step, steps, pass, passes, index, total}
    POST /replay/abort    -> JSON {ok}
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

Add-Type -TypeDefinition @'
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
        [DllImport("user32.dll")]
        public static extern bool GetCursorPos(out POINT lpPoint);
        [DllImport("user32.dll")]
        public static extern int GetSystemMetrics(int nIndex);
        [DllImport("user32.dll")]
        public static extern short GetAsyncKeyState(int vKey);

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
        public const string Version = "0.1.0";

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
            sb.Append("Access-Control-Allow-Private-Network: true\r\n");
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
Write-Host "  MouseFlow agent 0.1.0" -ForegroundColor Cyan
Write-Host "  listening   http://127.0.0.1:$Port"
Write-Host "  origin      $AllowOrigin"
Write-Host "  move filter $MoveThrottleMs ms / $MoveMinPx px"
Write-Host ""
if ($AllowOrigin -eq '*') {
    Write-Warning "Any site open in your browser can drive your mouse while this agent runs."
    Write-Warning "Pin it before sharing:  -AllowOrigin https://your-app.vercel.app"
    Write-Host ""
}
Write-Host "  Hold ESC to abort a replay. Ctrl+C to stop the agent." -ForegroundColor DarkGray
Write-Host ""

[MouseFlow.Agent]::ServeForever($Port)
