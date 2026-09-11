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
  Which page the agent answers. Left out, it answers MouseFlow's own pages and
  anything on localhost, and refuses everything else - a request from any other
  site is turned away before it reaches a route.

  Pass an origin to narrow that to exactly one:
    -AllowOrigin https://mouse-agent.vercel.app

  Pass '*' to turn the check off entirely. That is what this agent did by default
  until 0.9.7, and it means any site open in your browser can press keys on this
  machine - CORS does not stop that, because a keystroke needs no reply.

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
    [string]$AllowOrigin = '',
    [int]$MoveThrottleMs = 10,
    [int]$MoveMinPx = 3,
    # The tray icon is how a person reaches the agent - starting and stopping a recording without the
    # browser, and seeing that one is running. Off for a headless run or when something about the tray
    # itself is being debugged; the HTTP half is identical either way.
    [switch]$NoTray,
    # ТРЕБОВАТЬ КЛЮЧ НА КАЖДОМ ЗАПРОСЕ, КРОМЕ /health.
    #
    # Ключ печатается и показывается в трее ВСЕГДА; этот флаг решает, отвергать ли без него. По умолчанию
    # выключен: на машине одного человека процесс, запущенный им же, и без нас может нажать клавишу через
    # SendInput - ключ от него не защищает, а вставлять его пришлось бы каждому.
    #
    # А вот на машине, которой владеют тесты, он нужен, и именно от того, чего Origin не ловит: loopback
    # доступен ЛЮБОЙ сессии на этой машине - другому пользователю по RDP, через смену пользователя, - и
    # такой сессии SendInput в чужой рабочий стол недоступен, а HTTP-запрос доступен. Отсюда и флаг:
    # включается на QA-машине, где это единственная дверь.
    [switch]$RequireKey
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

        /* THE WINDOW THIS AGENT IS RUNNING IN. Zero when there is no console at all, which is the normal
         * case under autostart - it launches with -WindowStyle Hidden. Zero means there is nothing to
         * protect, not that protection failed. */
        [DllImport("kernel32.dll")]
        public static extern IntPtr GetConsoleWindow();

        /* A window's OWN pixels, whatever is on top of it. CopyFromScreen photographs the screen, so
         * anything overlapping the target lands in the picture - which is exactly how a capture of a dialog
         * came back as a picture of the terminal that was covering it. PW_RENDERFULLCONTENT is Windows 8.1
         * and later and handles DWM-composited windows, Chromium included. */
        [DllImport("user32.dll")]
        public static extern bool PrintWindow(IntPtr hWnd, IntPtr hdcBlt, uint nFlags);
        public const uint PW_RENDERFULLCONTENT = 0x00000002;

        /* WHO STARTED US. There is no Win32 call for a parent process id - Process.Parent is PowerShell 7,
         * and System.Management is an assembly this agent does not load. ntdll it is: the field has been in
         * the same place since Windows 2000, and everything that reports a process tree on Windows reads it
         * this way. Only the two members that matter are named; the reserved words are placeholders of the
         * right size. */
        [StructLayout(LayoutKind.Sequential)]
        public struct PROCESS_BASIC_INFORMATION
        {
            public IntPtr Reserved1;
            public IntPtr PebBaseAddress;
            public IntPtr Reserved2;
            public IntPtr Reserved3;
            public IntPtr UniqueProcessId;
            public IntPtr InheritedFromUniqueProcessId;
        }

        [DllImport("ntdll.dll")]
        public static extern int NtQueryInformationProcess(IntPtr handle, int infoClass,
            ref PROCESS_BASIC_INFORMATION info, int length, out int written);
        [DllImport("user32.dll")]
        public static extern short GetAsyncKeyState(int vKey);
        [DllImport("user32.dll", CharSet = CharSet.Unicode)]
        public static extern short VkKeyScan(char ch);

        /* Keeping the agent's own border out of the agent's own screenshots. WDA_EXCLUDEFROMCAPTURE makes
           the window invisible to every capture path including BitBlt, which is what CopyFromScreen is
           underneath - so one call covers Shot and Grid both. It needs Windows 10 2004; on anything older
           it returns false and the border is simply visible in the picture, which is stated in
           PROTOCOL.md rather than left to be discovered. The border is STILL then, never animated, so even
           there it cannot make the stillness guard think the screen is moving. */
        public const uint WDA_NONE = 0x00000000;
        public const uint WDA_EXCLUDEFROMCAPTURE = 0x00000011;
        [DllImport("user32.dll", SetLastError = true)]
        public static extern bool SetWindowDisplayAffinity(IntPtr hWnd, uint dwAffinity);

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
        /* Класс окна. Нужен ровно одному месту - узнать панель задач под нажатием (Shell_TrayWnd), не
         * разбирая подписей кнопок, которые зависят от языка системы. */
        [DllImport("user32.dll", CharSet = CharSet.Unicode)]
        public static extern int GetClassName(IntPtr hWnd, StringBuilder buffer, int max);
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
        /* SIDEWAYS. Absent until 0.12.0, and its absence was a hole in three directions at once: a person's
         * horizontal scroll was not RECORDED (this message never reached the hook's switch), a recording
         * carrying one could not be REPLAYED (no flag), and no action could COMMAND one. Meanwhile the
         * transcript has parsed "Scroll Left" and "Scroll Right" all along - the reading side was ready for
         * something no part of the writing side could produce. */
        public const int WM_MOUSEHWHEEL = 0x020E;

        public const uint INPUT_MOUSE = 0;
        public const uint MOUSEEVENTF_MOVE = 0x0001;
        public const uint MOUSEEVENTF_LEFTDOWN = 0x0002;
        public const uint MOUSEEVENTF_LEFTUP = 0x0004;
        public const uint MOUSEEVENTF_RIGHTDOWN = 0x0008;
        public const uint MOUSEEVENTF_RIGHTUP = 0x0010;
        public const uint MOUSEEVENTF_MIDDLEDOWN = 0x0020;
        public const uint MOUSEEVENTF_MIDDLEUP = 0x0040;
        public const uint MOUSEEVENTF_WHEEL = 0x0800;
        public const uint MOUSEEVENTF_HWHEEL = 0x1000;
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
        /* HOW LONG THE NAME WAS, when it was too long to be a label and therefore not recorded. Written
         * instead of the name, never beside it - see RecordName. Zero means there was nothing to drop. */
        public int NameLength;
        /* The page it landed on, when it landed on one. Origin and path - the cut happens in PageUrl(),
         * before the value ever reaches this object. Null on everything that is not a browser. */
        public string Url;

        /* WHICH MODIFIERS WERE HELD when this gesture was made: "Shift", "Ctrl+Shift", "Alt". Null when
         * none were, and NEVER the empty string - see PROTOCOL.md, which the macOS agent has followed
         * since 0.21.0 and this one did not follow at all.
         *
         * Only on a button-DOWN and on a scroll. Not on a movement, not on a release, not on a key, and
         * the reason for the first exclusion is a promise rather than file size: a per-move sample of
         * global keyboard state, intersected with the per-keystroke timeline this format already keeps,
         * recovers the shift-and-compose mask of text the format promises NOT to keep. A release needs
         * none because the replay holds the modifier from a press to its pair; a scroll carries its own
         * because it has no pair.
         *
         * Not caught, and said here rather than left to be found: a modifier pressed or released
         * MID-DRAG. Copying in File Explorer by starting a drag and then pressing Ctrl records as a
         * plain drag, which is a move rather than a copy. */
        public string Mods;

        /* ГДЕ ЭТО БЫЛО, когда сказать ЧТО не получилось.
         *
         * Заполняется только у шага БЕЗ имени - либо дерево не назвало ничего, либо имя оказалось
         * содержимым и его отбросило правило длины. Это подпись ближайшего ЭЛЕМЕНТА УПРАВЛЕНИЯ и сторона,
         * с которой от него оказалась точка: «ниже „Expanded“». Никогда не то, на что нажали, - поэтому
         * отдельное поле, а не Control: читатель, увидевший имя в Control, решит, что нажали по нему.
         *
         * Почему не «искать имя усерднее». Измерено на живом окне Chrome: под курсором всегда безымянная
         * группа, а единственное названное, СОДЕРЖАЩЕЕ точку, - элемент Text с абзацем, который человек
         * читает. Поднять потолки поиска значит начать записывать содержимое, то есть вернуть ровно ту
         * утечку, из-за которой имя и отбрасывается. Ориентир - это место, а не содержимое. */
        public string Near;
        public string Side;

        /* ГДЕ БЫЛО ОКНО И ГДЕ БЫЛ ЭЛЕМЕНТ - в экранных пикселях, на момент клика.
         *
         * ЗАЧЕМ. Точка на экране верна ровно до первого переезда окна. Человек сдвинул Outlook на другой
         * монитор, развернул его, поменял разрешение - и «нажать в 1074,159» попадает в пустоту или, хуже,
         * в соседнюю кнопку. Имея прямоугольник окна ТОГДА и его же СЕЙЧАС, повтор пересчитывает точку
         * (api/_anchor.mjs); имея прямоугольник элемента, он знает, насколько точка от его центра, - и
         * когда контрол находится по имени, целится в него, а не в геометрию.
         *
         * БЕСПЛАТНО. Прямоугольник окна - это GetWindowRect, вызов оконного менеджера; прямоугольник
         * элемента УЖЕ прочитан тем же попаданием, которое дало имя. Второго обхода дерева здесь нет - и
         * не может быть, это правило протокола.
         *
         * HasWin/HasEl, а не нули: окно в 0,0 существует, а «не измерено» - это другое. Ноль как признак
         * отсутствия - тот самый случай, где absent путают с false. */
        public bool HasWin;
        public int WinX;
        public int WinY;
        public int WinW;
        public int WinH;
        public bool HasEl;
        public int ElX;
        public int ElY;
        public int ElW;
        public int ElH;
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
        public const string Version = "0.29.0";

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
        /* Сколько нажатий по панели задач сыграно как «показать окно», а не как клик. Отдельно от
         * retargeted: там нажатие сдвинули, здесь - заменили другим действием, и отчёт обязан это различать. */
        static int _switched;
        /* Какие кнопки мыши ДЕРЖИТ ПОВТОР - биты MOUSEEVENTF_*DOWN. Нужно ровно одному месту: финишу, который
         * отпускает то, что держал, а не все три кнопки подряд. См. ReleaseHeldButtons. */
        static uint _heldByReplay;
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

        /* The chord as a chord is spelled, in the fixed order PROTOCOL.md gives: Cmd, Ctrl, Alt, Shift.
         * Empty when nothing is held, because the caller must write no field at all in that case.
         *
         * `Cmd` IS THE WINDOWS KEY HERE, and that needs saying because it looks like a mistake. macOS
         * writes `Cmd` for Command; the token has to mean the same KIND of key on both sides or a
         * recording does not survive crossing platforms. Windows has no Command, and its system modifier
         * in this position is Win - so Win is what fills the slot. `Ctrl` stays the literal Control key on
         * both, which is the whole point of the token being separate.
         *
         * GetAsyncKeyState rather than GetKeyState: the question is what a person had physically held at
         * this instant, not what the message queue thinks the focused window's state was. Called from the
         * hook, where the budget is 300ms (LowLevelHooksTimeout) - four reads of a keyboard bit are free
         * at that scale, which is why this is not queued to the resolver the way a name is. */
        static string ChordMods()
        {
            bool win = ((Native.GetAsyncKeyState(0x5B) & 0x8000) != 0)
                    || ((Native.GetAsyncKeyState(0x5C) & 0x8000) != 0);
            bool ctrl = (Native.GetAsyncKeyState(0x11) & 0x8000) != 0;
            bool alt = (Native.GetAsyncKeyState(0x12) & 0x8000) != 0;
            bool shift = (Native.GetAsyncKeyState(0x10) & 0x8000) != 0;

            StringBuilder mods = new StringBuilder();
            if (win) mods.Append("Cmd");
            if (ctrl) { if (mods.Length > 0) mods.Append("+"); mods.Append("Ctrl"); }
            if (alt) { if (mods.Length > 0) mods.Append("+"); mods.Append("Alt"); }
            if (shift) { if (mods.Length > 0) mods.Append("+"); mods.Append("Shift"); }
            return mods.ToString();
        }

        /* Which events carry one. Held apart from ChordMods so the RULE reads on its own line, and so the
         * recorder and the replay cannot drift: a scroll has no pair, a press has one. */
        static bool CarriesMods(string action)
        {
            return action != null
                && (action.EndsWith("Click Down") || action.StartsWith("Scroll"));
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
                /* Positive is RIGHT here, which is the opposite convention to the vertical wheel where
                 * positive is up (away from the user). Windows defines it that way; getting it backwards
                 * would record every sideways scroll as its mirror image. */
                case Native.WM_MOUSEHWHEEL:
                    wheel = (short)((data.mouseData >> 16) & 0xFFFF);
                    action = wheel >= 0 ? "Scroll Right" : "Scroll Left";
                    break;
                default: return;
            }

            /* BEFORE the lock, deliberately. The resolver thread waits on Gate, and asking the keyboard
             * four questions inside the lock would put those reads on the critical path of every one of
             * the hundreds of movements a second that also take it. Outside, they cost the hook alone. */
            string mods = CarriesMods(action) ? ChordMods() : "";

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
                /* Null and not "", so WriteContext tests one thing and the wire never carries an empty
                 * value. PROTOCOL.md: absent means none were held. */
                if (mods.Length > 0) e.Mods = mods;
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

        /* How often the title is asked for, and how long a new one must hold before it is believed. Same
           numbers as the macOS agent, because the two produce one format and a recording should not read
           differently depending on which machine made it. GetWindowText is cheap where the mac's
           accessibility round trip is not, but the SETTLE is not about cost - a page in flight shows two or
           three titles on the way to the one it keeps, and marking each puts places in a recording that
           nobody visited. */
        const int TitleLookMs = 400;
        const int TitleSettleMs = 700;
        static string _lastFrontTitle = null;
        static string _titleCandidate = null;
        static long _titleCandidateAt = 0;
        static long _lastTitleLook = 0;

        static void NoteForeground()
        {
            IntPtr front = Native.GetForegroundWindow();
            if (front == IntPtr.Zero) return;
            bool moved = front != _lastFront;

            Ev e = null;
            bool titled = false;
            lock (Gate)
            {
                if (!_recording)
                {
                    _lastFront = front;
                    _lastFrontTitle = null;
                    _titleCandidate = null;
                    return;
                }
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
                /* A WINDOW THAT CHANGED WHAT IT IS SHOWING, not only a different window coming forward.
                 *
                 * `_lastFront` is a handle, and a browser navigating from one page to the next keeps the
                 * same one - so a recording could say which link was clicked and never where it led. The
                 * title is the only thing that moves, and it is read on a clock rather than every tick. */
                if (!moved)
                {
                    if (now - _lastTitleLook < TitleLookMs) return;
                    _lastTitleLook = now;
                    string seen = TitleOf(front);
                    string had = _lastFrontTitle == null ? "" : _lastFrontTitle;
                    if (seen != null && seen.Length > 0 && seen != had)
                    {
                        if (_titleCandidate == seen && now - _titleCandidateAt >= TitleSettleMs)
                        {
                            titled = true;
                        }
                        else if (_titleCandidate != seen)
                        {
                            _titleCandidate = seen;
                            _titleCandidateAt = now;
                        }
                    }
                    else if (seen == had)
                    {
                        _titleCandidate = null;
                    }
                    if (!titled) return;
                }

                e = new Ev();
                e.X = _lastX;
                e.Y = _lastY;
                e.DelayMs = _buffer.Count == 0 ? 0 : (int)(now - _lastStamp);
                e.Action = "Focus";
                _buffer.Add(e);
                _lastStamp = now;
            }
            _lastFront = front;
            _lastFrontTitle = TitleOf(front);
            _titleCandidate = null;
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

            RecordName(job.Target, name, type);
            /* The typing job too: a typing run is where a portable skill's inputs go, and a step saying
             * which page it went into is the difference between an instruction and a guess. */
            job.Target.Url = PageUrl(el);
        }

        /* A NAME LONG ENOUGH TO BE CONTENT IS NOT RECORDED, and the number is measured rather than picked.
         *
         * WHAT WENT WRONG. A click on a message in Teams was recorded as
         * `clicked "Привет, та такие конторы обычно данные потом у себя сторят… Дима не захочет"` - somebody
         * else's conversation, in a recording, on an account, in every export. The accessibility name of a
         * chat message IS the message. Nothing was read wrongly; the control is genuinely called that.
         *
         * AND THE TYPE CANNOT TELL THEM APART. Measured over three applications' live trees: in Outlook an
         * `option` runs 275-376 characters and a `radio button` 174; a `menu item` 130; in Teams a `group`
         * reaches 523 and a `tree item` 123. Those are the same types that carry three-character labels.
         *
         * THE LENGTH CAN, and cleanly. The longest name on anything a person PRESSES was 43 characters
         * (a combo box) and 41 (a button), across all three. File Explorer had nothing over 60 at all.
         * Everything above 60 in the sample was content: a message, an email in a list, a chat summary.
         *
         * So over 60 characters the name is dropped and its LENGTH is written instead. What is left is
         * enough for a reader - "clicked a 147-character piece of text" places the step - and there is
         * nothing in the recording to leak, redact later, or think about before sharing it.
         *
         * WHAT THIS DOES NOT CATCH, said plainly rather than left to be discovered: a SHORT name that
         * happens to be content. A spell-check menu named "Spelling, сторят" carries one typed word in
         * sixteen characters, and no length rule can tell that from a label. See
         * docs/product/19-limits-and-known-gaps.md. */
        const int NameMax = 60;

        static void RecordName(Ev target, string name, string type)
        {
            if (target == null) return;
            target.ControlType = string.IsNullOrEmpty(type) ? null : Clip(type, 40);
            if (string.IsNullOrEmpty(name)) { target.Control = null; return; }
            if (name.Length > NameMax)
            {
                target.Control = null;
                target.NameLength = name.Length;
                return;
            }
            target.Control = Clip(name, 120);
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
            IntPtr under = Native.WindowFromPoint(new POINT { X = job.X, Y = job.Y });
            DescribeWindow(job.Target, under);

            /* ПРЯМОУГОЛЬНИК ОКНА - ОДНИМ ВЫЗОВОМ ОКОННОГО МЕНЕДЖЕРА, и именно ТОП-УРОВНЕВОГО: переезжает и
               меняет размер окно, а не дочерний контейнер под точкой. Это то же окно, которое перечисляет
               /windows, - иначе повтору было бы не с чем сопоставить якорь. */
            IntPtr top = under == IntPtr.Zero ? IntPtr.Zero : Native.GetAncestor(under, Native.GA_ROOT);
            if (top == IntPtr.Zero) top = under;
            if (top != IntPtr.Zero)
            {
                RECT wr;
                if (Native.GetWindowRect(top, out wr) && wr.Right > wr.Left && wr.Bottom > wr.Top)
                {
                    job.Target.HasWin = true;
                    job.Target.WinX = wr.Left;
                    job.Target.WinY = wr.Top;
                    job.Target.WinW = wr.Right - wr.Left;
                    job.Target.WinH = wr.Bottom - wr.Top;
                }
            }

            AutomationElement el = AutomationElement.FromPoint(new System.Windows.Point(job.X, job.Y));
            if (el == null) return;

            /* Climb for a name. A hit test often lands on an unnamed `group` or `custom` wrapper while the
             * thing a person would call the target is its parent - measured, this takes naming from 59/106
             * to 82/110. Five levels, because beyond that the answer is the window and the window is
             * already known. */
            string name = null;
            string type = null;
            AutomationElement at = el;
            /* ЭЛЕМЕНТ, ЧЬЁ ИМЯ В ИТОГЕ ЗАПИСАНО, - ЕГО ЖЕ ПРЯМОУГОЛЬНИК. Не того, на который попала точка:
               по имени повтор потом ищет ИМЕННО названное, и мерить надо то же самое. Читается на том же
               подъёме, который уже идёт за именем, - второго обхода нет. */
            AutomationElement named = null;
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
                if (!string.IsNullOrEmpty(candidate)) { name = candidate; type = kind; named = at; break; }

                try { at = TreeWalker.ControlViewWalker.GetParent(at); }
                catch { break; }
            }

            /* Nothing named it on the way UP - so look DOWN to the point before giving up. This is where a
             * taskbar icon gets its name; NamedUnder has the measurements. */
            if (string.IsNullOrEmpty(name))
            {
                AutomationElement best = null;
                double bestArea = double.MaxValue;
                int examined = 0;
                NamedUnder(el, new System.Windows.Point(job.X, job.Y), 6,
                           ref best, ref bestArea, ref examined);
                if (best != null)
                {
                    try
                    {
                        name = best.Current.Name;
                        type = best.Current.LocalizedControlType;
                        named = best;
                    }
                    catch { /* found and then gone; the coordinates still describe the step */ }
                }
            }

            RecordName(job.Target, name, type);
            job.Target.Url = PageUrl(el);

            /* ПРЯМОУГОЛЬНИК НАЗВАННОГО ЭЛЕМЕНТА - из того же попадания, что дало имя. Читается ТОЛЬКО когда
               имя действительно записалось: правило длины могло его отбросить (тогда это содержимое, а не
               подпись, и искать по нему нечего), а без имени повтору целиться не во что - остаётся окно. */
            if (named != null && !string.IsNullOrEmpty(job.Target.Control))
            {
                try
                {
                    System.Windows.Rect box = named.Current.BoundingRectangle;
                    if (box.Width > 0 && box.Height > 0 && !double.IsInfinity(box.Width))
                    {
                        job.Target.HasEl = true;
                        job.Target.ElX = (int)Math.Round(box.X);
                        job.Target.ElY = (int)Math.Round(box.Y);
                        job.Target.ElW = (int)Math.Round(box.Width);
                        job.Target.ElH = (int)Math.Round(box.Height);
                    }
                }
                catch { /* элемент исчез между чтением имени и чтением рамки: остаётся окно */ }
            }

            /* ТОЛЬКО когда имени нет. Если по клику есть подпись, ориентир не нужен и стоил бы чтения окна
               ни за что; а `namelen` без имени - это тот же случай «сказать нечего», только по другой
               причине, и ориентир там нужен так же. */
            if (string.IsNullOrEmpty(job.Target.Control))
            {
                string side;
                string near = NearestLandmark(Native.WindowFromPoint(new POINT { X = job.X, Y = job.Y }),
                                              job.X, job.Y, out side);
                /* Обрезка по краям — показал прогон: проводник отдаёт " Search scratchpad", TMetric
                   "Отчёты " и " Timeline menu". Пробел внутри значения провод переживает (поля разделены
                   табуляциями), а в кавычках транскрипта он выглядит опечаткой. */
                if (near != null) near = near.Trim();
                if (!string.IsNullOrEmpty(near))
                {
                    job.Target.Near = Clip(near, 120);
                    job.Target.Side = side;
                }
            }
        }

        /* ЧТО ГОДИТСЯ В ОРИЕНТИР - список типов, полученный замером, а не выбранный.
         *
         * Замер по двенадцати живым окнам (Teams, Chrome, Claude, Outlook PWA, четыре проводника,
         * PowerShell, Notepad, MouseFlow) - по каждому типу число элементов, медиана и максимум длины имени
         * и три самых коротких примера:
         *
         *   Button       420  медиана 11  макс 114   'Cut' 'New'          <- ориентир
         *   Edit         504  медиана  4  макс  23   'Type' 'Size' 'Name' <- ориентир (подпись поля)
         *   TabItem       48  медиана 24  макс 157   'View' 'Help'        <- ориентир
         *   Text         332  медиана 10  макс 432   '3' '1'              <- СОДЕРЖИМОЕ
         *   ListItem     134  медиана 13  макс 390   ...                  <- СОДЕРЖИМОЕ (сообщение в Teams)
         *   DataItem       8  медиана 28  макс 108   'Почему не проходит' <- СОДЕРЖИМОЕ (ячейка таблицы)
         *   Group         88  медиана 13  макс 326   'New' 'Tags'         <- СОДЕРЖИМОЕ (те самые 1745)
         *
         * Text, ListItem, DataItem и Group исключены потому, что их короткие примеры выглядят как подписи,
         * а длинные - это чужой текст: тип не различает, различает только длина, и полагаться на неё здесь
         * нельзя, потому что короткое сообщение в чате пройдёт любой порог.
         *
         * Document и Pane исключены по другой причине: они не врут, они не ЛОКАЛИЗУЮТ. «Ниже „Claude“» про
         * элемент во весь экран не говорит ничего. */
        static readonly string[] LandmarkTypes = new string[] {
            "button", "split button", "tab item", "menu item", "hyperlink", "link", "check box",
            "radio button", "combo box", "edit", "tool bar", "toolbar", "tree item",
        };

        static bool IsLandmarkType(string localized)
        {
            if (string.IsNullOrEmpty(localized)) return false;
            string kind = localized.Trim().ToLowerInvariant();
            for (int i = 0; i < LandmarkTypes.Length; i++)
            {
                if (kind == LandmarkTypes[i]) return true;
            }
            return false;
        }

        /* Названные элементы окна, на пару секунд.
         *
         * Без кэша каждый безымянный клик стоил бы своего FindAll - 0-319 мс по замеру, - а на странице
         * вроде claude.ai безымянны ПОДРЯД все клики, то есть плата была бы за каждый. Две секунды выбраны
         * так, чтобы серия кликов в одном окне обошлась одним чтением, а переключение окна прочиталось
         * заново: разметка за две секунды не переезжает, а окно - переезжает.
         *
         * Живёт на потоке-резолвере, который и так медленный и уже не на крючке. */
        class WindowRead
        {
            public DateTime At;
            public List<AutomationElement> Named;
        }

        static readonly Dictionary<IntPtr, WindowRead> _reads = new Dictionary<IntPtr, WindowRead>();
        static readonly object ReadGate = new object();
        const int ReadTtlMs = 2000;

        static List<AutomationElement> NamedIn(IntPtr hwnd)
        {
            if (hwnd == IntPtr.Zero) return null;
            lock (ReadGate)
            {
                /* Просрочённое выбрасывается по пути, иначе долгая сессия растит этот словарь без границы -
                   то же правило, что у _mute. */
                List<IntPtr> over = new List<IntPtr>();
                foreach (KeyValuePair<IntPtr, WindowRead> entry in _reads)
                {
                    if ((DateTime.UtcNow - entry.Value.At).TotalMilliseconds > ReadTtlMs) over.Add(entry.Key);
                }
                foreach (IntPtr key in over) _reads.Remove(key);

                WindowRead have;
                if (_reads.TryGetValue(hwnd, out have)) return have.Named;
            }

            AutomationElement root;
            try { root = AutomationElement.FromHandle(hwnd); }
            catch { return null; }
            if (root == null) return null;

            string problem;
            /* Через тот же Search, что и всё остальное: у него дедлайн, глушение окна по ручке на минуту и
               предел в три висящих чтения. Отдельный путь пришлось бы снабжать этим заново. */
            AutomationElementCollection found = Search(root, hwnd, NamedAndVisible(), 2000, out problem);
            List<AutomationElement> list = new List<AutomationElement>();
            if (found != null)
            {
                foreach (AutomationElement el in found) list.Add(el);
            }
            lock (ReadGate)
            {
                WindowRead fresh = new WindowRead();
                fresh.At = DateTime.UtcNow;
                fresh.Named = list;
                _reads[hwnd] = fresh;
            }
            return list;
        }

        /* Насколько велик элемент, чтобы ещё считаться ориентиром. Панель во весь экран - не ориентир, даже
           если у неё есть имя: «ниже» относительно неё не сообщает ничего. Порог в четверть площади
           экрана 1920x1080. */
        const double LandmarkAreaMax = 520000;

        /* Подпись ближайшего элемента управления и сторона, с которой от него точка.
         *
         * ПОВТОРЯЮЩЕЕСЯ ИМЯ - НЕ ОРИЕНТИР, и это правило нашлось в том же замере: 'Header' встречается в
         * окне пять раз, 'Separator' дважды, 'Select a message' у шестнадцати флажков подряд. «Ниже
         * „Header“» не говорит, ниже какого. Уникальность в пределах окна - дешёвая проверка, снимающая
         * весь этот класс сразу. */
        static string NearestLandmark(IntPtr hwnd, int x, int y, out string side)
        {
            side = null;
            List<AutomationElement> named = NamedIn(hwnd);
            if (named == null || named.Count == 0) return null;

            Dictionary<string, int> seen = new Dictionary<string, int>();
            List<AutomationElement> fit = new List<AutomationElement>();
            for (int i = 0; i < named.Count; i++)
            {
                string name, kind;
                System.Windows.Rect box;
                try
                {
                    name = named[i].GetCachedPropertyValue(AutomationElement.NameProperty) as string;
                    kind = named[i].GetCachedPropertyValue(
                        AutomationElement.LocalizedControlTypeProperty) as string;
                    box = (System.Windows.Rect)named[i].GetCachedPropertyValue(
                        AutomationElement.BoundingRectangleProperty);
                }
                catch { continue; }

                if (string.IsNullOrEmpty(name) || name.Length > NameMax) continue;
                if (!IsLandmarkType(kind)) continue;
                if (box.Width <= 0 || box.Height <= 0) continue;
                if (box.Width * box.Height > LandmarkAreaMax) continue;

                int count;
                seen[name] = seen.TryGetValue(name, out count) ? count + 1 : 1;
                fit.Add(named[i]);
            }

            AutomationElement best = null;
            double bestDistance = double.MaxValue;
            System.Windows.Rect bestBox = new System.Windows.Rect();
            string bestName = null;
            for (int i = 0; i < fit.Count; i++)
            {
                string name;
                System.Windows.Rect box;
                try
                {
                    name = fit[i].GetCachedPropertyValue(AutomationElement.NameProperty) as string;
                    box = (System.Windows.Rect)fit[i].GetCachedPropertyValue(
                        AutomationElement.BoundingRectangleProperty);
                }
                catch { continue; }
                if (name == null || seen[name] > 1) continue;

                /* Расстояние до ПРЯМОУГОЛЬНИКА, а не до его центра: у широкой кнопки центр может быть
                   дальше, чем у мелкой, стоящей вплотную, и «ближайшим» тогда становится не то, что
                   человек видит рядом. */
                double dx = x < box.X ? box.X - x : (x > box.X + box.Width ? x - (box.X + box.Width) : 0);
                double dy = y < box.Y ? box.Y - y : (y > box.Y + box.Height ? y - (box.Y + box.Height) : 0);
                double distance = Math.Sqrt(dx * dx + dy * dy);
                if (distance < bestDistance)
                {
                    bestDistance = distance;
                    best = fit[i];
                    bestBox = box;
                    bestName = name;
                }
            }

            /* Дальше этого ориентир перестаёт быть ориентиром: «в 600 пикселях ниже „Отправить“» - это не
               место, это другое место. Полторы сотни пикселей - примерно та дистанция, на которой человек
               ещё связывает две вещи глазами. */
            if (best == null || bestDistance > 220) return null;

            if (bestDistance == 0) side = "in";
            else if (y < bestBox.Y) side = "above";
            else if (y > bestBox.Y + bestBox.Height) side = "below";
            else if (x < bestBox.X) side = "left";
            else side = "right";
            return bestName;
        }

        /* THE SMALLEST NAMED THING CONTAINING THE POINT, searched DOWNWARDS.
         *
         * WHY IT EXISTS. Every click on the Windows 11 taskbar came back as an unnamed `pane`, so a
         * transcript read "clicked on the desktop or the taskbar, at 898,1050" and never said which icon -
         * which is the one thing the reader wanted. The name was not missing. It was in the other
         * direction. Measured on a live desktop: AutomationElement.FromPoint over a taskbar button answers
         * with Shell_TrayWnd, the whole 1920x48 window, and the climb above that reaches the desktop root,
         * which is also unnamed. The button is FOUR LEVELS BELOW, inside a XAML island that the shell's
         * HWND provider does not hit-test into:
         *
         *   Shell_TrayWnd -> Windows.UI.Input.InputSite.WindowClass -> Taskbar.TaskbarFrame
         *     -> button "Google Chrome - 1 running window"   at 895,1032  44x48
         *
         * and the click in the complaint was at 898,1050, inside that rectangle. Start, the tray icons, the
         * clock and Show Desktop all name themselves the same way and were all being reported as nothing.
         *
         * THE SMALLEST AREA WINS, NOT THE FIRST FOUND, and that is measured rather than tidy. Shell_TrayWnd
         * lists a leftover ReBarWindow32 before the island, and it HAS a named child - "Running
         * applications" - so a depth-first search returns the strip and stops. The most specific rectangle
         * under the pointer is the thing a person means, and the strip merely contains it.
         *
         * THIS IS NOT THE TREE WALK PROTOCOL.md FORBIDS. That rule is about SEARCHING a subtree - FindFirst
         * over a browser's descendants, measured at 0.6-4.4 seconds per window. Only children whose
         * rectangle contains the point are opened here, so this follows a path down - a few, where windows
         * overlap - instead of sweeping one. Measured over every taskbar button, the tray, Start and the
         * clock: 32 elements read, 37ms warm, 153ms on the first call of a session. The caps are the
         * guarantee rather than the average: six levels, forty siblings a level, a hundred and twenty
         * elements in total.
         *
         * AND IT CANNOT MAKE AN EXISTING STEP WORSE, which is the property worth having in something people
         * install as a binary and update by hand: it runs only where the climb found no name at all, so
         * every step it can change is one that today says nothing. The measured 70.8% that already carry a
         * name never reach it.
         *
         * The macOS agent has had the same idea since 0.9.3 - see namedUnder/childrenAt there, written for
         * Chrome's tab strip. It differs in one respect: it takes the first name depth-first among the three
         * smallest candidates, which is what the taskbar's leftover strip defeats. Two shapes, one on each
         * platform, and the difference is deliberate.
         */
        static void NamedUnder(AutomationElement from, System.Windows.Point p, int depth,
                               ref AutomationElement best, ref double bestArea, ref int examined)
        {
            if (from == null || depth <= 0 || examined >= 120) return;
            AutomationElement kid;
            try { kid = TreeWalker.ControlViewWalker.GetFirstChild(from); }
            catch { return; }

            int seen = 0;
            while (kid != null && seen < 40 && examined < 120)
            {
                seen++;
                examined++;
                try
                {
                    /* Wider than a pixel, and finite: an offscreen element reports an infinite rectangle,
                     * and a hairline separator with a name would otherwise win on area every time. The same
                     * guard the macOS side uses on kAXSize. */
                    System.Windows.Rect box = kid.Current.BoundingRectangle;
                    if (box.Width > 1 && box.Height > 1
                        && !double.IsInfinity(box.Width) && !double.IsInfinity(box.Height)
                        && box.Contains(p))
                    {
                        double area = box.Width * box.Height;
                        string named = kid.Current.Name;
                        if (!string.IsNullOrEmpty(named) && area < bestArea)
                        {
                            best = kid;
                            bestArea = area;
                        }
                        NamedUnder(kid, p, depth - 1, ref best, ref bestArea, ref examined);
                    }
                }
                catch { /* this one went away mid-read; its siblings are still worth asking */ }

                try { kid = TreeWalker.ControlViewWalker.GetNextSibling(kid); }
                catch { break; }
            }
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

        /* A WINDOW TITLE THAT IS A URL LOSES ITS QUERY STRING, for exactly the reason PageUrl does.
         *
         * A page with no <title> is titled by its address, and a sign-in redirect is precisely such a page.
         * Seen in a real recording on this machine:
         *
         *   auth.doubleword.ai/u/login?state=hKFo2SAwNTh5Q2dOX2cOWVBSZkxfVy15VkFla3FQdXhTbjdaeaFur3V…
         *
         * That `state` is a one-time sign-in token, and it was going into the recording, onto the account,
         * into every export and past every reader - while three feet away in this same file PageUrl cuts the
         * query off the `url` field on the argument that a query string is where "a session token, a
         * one-time sign-in link and whatever somebody typed into a search box" live. The rule was right and
         * the title walked straight around it.
         *
         * Only when the whole title parses as an http or https URL. A title that merely CONTAINS a question
         * mark is a sentence, and cutting sentences at punctuation would mangle every ordinary window. */
        static string TitleOf(IntPtr hwnd)
        {
            StringBuilder sb = new StringBuilder(300);
            Native.GetWindowText(hwnd, sb, sb.Capacity);
            string title = sb.ToString();
            if (string.IsNullOrEmpty(title)) return null;
            string bare = BareTitle(title);
            return Clip(bare == null ? title : bare, 160);
        }

        /* Origin and path, or null when this is not a URL at all. Separate from Bare only because Bare takes
           what a browser reported and this takes what a window manager reported - same cut, same reason. */
        static string BareTitle(string title)
        {
            string said = title.Trim();
            if (said.IndexOf('?') < 0) return null;          // nothing to cut; the common case, and cheap
            if (said.IndexOf(' ') >= 0) return null;          // a sentence, not an address
            string probe = said;
            /* Chrome shows the address without a scheme, and Uri needs one to parse. Trying https first is a
             * guess about the scheme and it does not matter: only the authority and the path are kept. */
            if (probe.IndexOf("://", StringComparison.Ordinal) < 0) probe = "https://" + probe;
            Uri parsed;
            if (!Uri.TryCreate(probe, UriKind.Absolute, out parsed)) return null;
            if (parsed.Scheme != Uri.UriSchemeHttp && parsed.Scheme != Uri.UriSchemeHttps) return null;
            if (string.IsNullOrEmpty(parsed.Host) || parsed.Host.IndexOf('.') < 0) return null;
            string path = parsed.AbsolutePath == "/" ? "" : parsed.AbsolutePath;
            /* The scheme is dropped again if it was not there to begin with: putting one in would change
               what the transcript shows for every ordinary page. */
            string origin = said.StartsWith("http", StringComparison.OrdinalIgnoreCase)
                ? parsed.GetLeftPart(UriPartial.Authority)
                : parsed.Host + (parsed.IsDefaultPort ? "" : ":" + parsed.Port.ToString(CultureInfo.InvariantCulture));
            return origin + path;
        }

        /* The tray's "Stop and Save Recording". Capture stops NOW; the events are HELD, because the agent
         * has no account to put them on - the app does, and its Record page collects a held recording
         * through the ordinary /record/stop the moment it notices. `recording:false` with `count>0` on
         * /record/status is the signal, and it is unambiguous because a client-driven stop never leaves
         * that state behind. Same contract the macOS agent implements; see PROTOCOL.md. */
        /* ГДЕ КОНЧАЕТСЯ ЗАПИСЬ И НАЧИНАЕТСЯ НАШЕ СОБСТВЕННОЕ МЕНЮ.
         *
         * Сообщено с прогона, и это была настоящая поломка: человек остановил запись через трей, и клик по
         * «Stop and Save Recording» попал В ЗАПИСЬ. Повтор в конце снова открывал меню агента и снова
         * нажимал ту же кнопку - то есть запускал новую запись, потому что кнопка на том же месте. Запись
         * не должна содержать то, чем её остановили: это не работа человека, это управление инструментом.
         *
         * Метка ставится в момент, когда НАШЕ меню открывается (ContextMenuStrip.Opening), и указывает на
         * последнее НАЖАТИЕ в буфере - то самое, которым меню и открыли. Никаких часов и никаких догадок по
         * времени: всё, что после этого нажатия, сделано в нашем меню.
         *
         * Обновляется при каждом открытии, поэтому «открыл, закрыл, поработал десять минут, снова открыл и
         * нажал Стоп» отрежет только второе открытие. Читается только этим путём - у остановки по HTTP свой
         * хвост (кнопка в самом приложении), и его снимает приложение. */
        static int _ownMenuAt = -1;

        public static void MarkOwnMenu()
        {
            lock (Gate)
            {
                if (!_recording) { _ownMenuAt = -1; return; }
                int at = _buffer.Count;
                /* Назад до последнего нажатия, но недалеко: клик по значку в трее - это последние события в
                 * буфере, а не что-то в глубине. Сорок - это движения мыши к трею плюс сам клик. */
                for (int i = _buffer.Count - 1; i >= 0 && i >= _buffer.Count - 40; i--)
                {
                    if (IsPress(_buffer[i].Action)) { at = i; break; }
                }
                _ownMenuAt = at;
            }
        }

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
                /* ХВОСТ НАШЕГО МЕНЮ ОТРЕЗАН ЗДЕСЬ - до того, как счётчики и признак «есть что отдать»
                 * посчитаны по нему: иначе запись из одного клика по «Stop and Save» отдалась бы как
                 * запись с одним событием, и повтор нажал бы Стоп ещё раз. */
                if (_ownMenuAt >= 0 && _ownMenuAt <= taken.Count)
                {
                    taken = taken.GetRange(0, _ownMenuAt);
                    /* И движения к трею - за ним: сами по себе они безвредны, но запись, кончающаяся
                     * дорогой в угол экрана, при повторе туда же и уводит курсор. */
                    while (taken.Count > 0 && taken[taken.Count - 1].Action == "Mouse Movement")
                    {
                        taken.RemoveAt(taken.Count - 1);
                    }
                }
                _ownMenuAt = -1;
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
            /* НИ ОДИН МОДИФИКАТОР НЕ ЗАЖАТ, КОГДА ЗАПИСЬ НАЧИНАЕТСЯ - и это про обещание, а не про удобство.
               Буква называется только под командным аккордом (см. commanded в хуке, где он строится по
               GetAsyncKeyState). При залипшем Ctrl каждое нажатие человека читается как аккорд, и буква
               НАЗЫВАЕТСЯ - в записи, которую экспортируют и пересылают. Залипнуть он мог от чужого
               приложения, от зависшей клавиши или от прошлого запуска агента, умершего посреди аккорда. */
            ReleaseModifiers();

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
            /* EVERY FIELD THIS LINE CAN CARRY, and the guard was short of three of them.
             *
             * A Cmd+scroll is the case that made it matter: a scroll is not sent for name resolution at
             * all, so a modifier is the ONLY thing in its context - and a guard testing four fields out of
             * seven dropped the whole line, losing exactly one of the four gestures, silently. `namelen`
             * and `type` were reachable the same way. The macOS half tests all of them; this one now does
             * too, and PROTOCOL.md says outright that a `#ctx` line may carry `mods` and nothing else. */
            if (e.Process == null && e.Window == null && e.Control == null && e.ControlType == null
                && e.Url == null && e.NameLength == 0 && e.Mods == null && e.Near == null
                && !e.HasWin && !e.HasEl) return;
            sb.Append("#ctx");
            if (e.Process != null) { sb.Append("\tapp="); sb.Append(e.Process); }
            if (e.Window != null) { sb.Append("\twindow="); sb.Append(e.Window); }
            if (e.Control != null) { sb.Append("\tcontrol="); sb.Append(e.Control); }
            /* Never both: a redacted name has no `control=`, so an older reader sees a step with a type and
             * no name - which is what it would have shown for an unnamed control, and is safe. A newer one
             * reads this and can say how much text was there. PROTOCOL.md: unknown keys are skipped. */
            else if (e.NameLength > 0)
            {
                sb.Append("\tnamelen=");
                sb.Append(e.NameLength.ToString(CultureInfo.InvariantCulture));
            }
            if (e.ControlType != null) { sb.Append("\ttype="); sb.Append(e.ControlType); }
            /* Added after the four that were always here. PROTOCOL.md: unknown keys are skipped rather than
             * being an error, so an older reader loads this exactly as it did before. */
            if (e.Url != null) { sb.Append("\turl="); sb.Append(e.Url); }
            /* LAST, which is where the macOS agent writes it. Not cosmetic: `mods` is the one field whose
             * value is a token list, and a reader that took the rest of the line for it (the way `title=`
             * and `app=` are taken) would swallow anything written after it. Nothing is written after it
             * today - and keeping both agents in one order means nothing has to be. */
            if (e.Mods != null) { sb.Append("\tmods="); sb.Append(e.Mods); }
            /* ПОСЛЕ mods, чтобы не сдвинуть порядок, который держат тесты обеих платформ. Поля разделены
               табуляциями, так что пробел внутри значения ничего не ломает - правило «забирает остаток
               строки» относится к проводу ДЕЙСТВИЙ, где разделитель пробел, а не к этой строке. */
            if (e.Side != null) { sb.Append("\tside="); sb.Append(e.Side); }
            if (e.Near != null) { sb.Append("\tnear="); sb.Append(e.Near); }
            /* ЯКОРЬ - ПОСЛЕДНИМ, восемью числами: окно и элемент в экранных пикселях. Неизвестные ключи
               PROTOCOL.md велит пропускать, поэтому старый читатель загружает эту запись ровно как прежде,
               а новый пересчитывает точку, когда окно переехало (api/_anchor.mjs). */
            if (e.HasWin)
            {
                sb.Append("\twx="); sb.Append(e.WinX.ToString(CultureInfo.InvariantCulture));
                sb.Append("\twy="); sb.Append(e.WinY.ToString(CultureInfo.InvariantCulture));
                sb.Append("\tww="); sb.Append(e.WinW.ToString(CultureInfo.InvariantCulture));
                sb.Append("\twh="); sb.Append(e.WinH.ToString(CultureInfo.InvariantCulture));
            }
            if (e.HasEl)
            {
                sb.Append("\tex="); sb.Append(e.ElX.ToString(CultureInfo.InvariantCulture));
                sb.Append("\tey="); sb.Append(e.ElY.ToString(CultureInfo.InvariantCulture));
                sb.Append("\tew="); sb.Append(e.ElW.ToString(CultureInfo.InvariantCulture));
                sb.Append("\teh="); sb.Append(e.ElH.ToString(CultureInfo.InvariantCulture));
            }
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
                    /* Нажатия по панели задач, сыгранные как «показать окно». Читается страницей рядом с
                       retargeted - см. TaskbarSwitch. */
                    + ",\"switched\":" + _switched.ToString(CultureInfo.InvariantCulture)
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

            /* The border, on the same two edges as _playing and for the same reason it is released in
               Finish: an indicator that stays lit after the thing it announces has stopped lies in the one
               direction an indicator must never lie. */
            Acting.Begin("replay");
            lock (Gate)
            {
                _playing = true;
                _abort = false;
                _unplayable = 0;
                _retargeted = 0;
                _switched = 0;
                _heldByReplay = 0;
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

                                /* Индекс отпускания, которое не играть: его нажатие сыграно как «показать
                                 * окно», и отпускание без нажатия само по себе - событие (см. финиш). */
                                int skipRelease = -1;
                                for (int i = 0; i < st.Events.Count; i++)
                                {
                                    if (ShouldStop()) { Finish(true); return; }
                                    Ev e = st.Events[i];
                                    if (!SleepAbortable((int)Math.Round(e.DelayMs / st.Speed))) { Finish(true); return; }
                                    if (i == skipRelease)
                                    {
                                        skipRelease = -1;
                                    }
                                    else
                                    {
                                        int pair = TaskbarSwitch(st.Events, i);
                                        if (pair >= 0) skipRelease = pair;
                                        else Emit(e);
                                    }
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
                ReleaseHeldButtons();
                /* And the same argument for a modifier, which is worse: a button left down is visible and
                 * one click fixes it, while a Shift left down is invisible and silently changes every
                 * keystroke and click the person makes next. Reached whenever a modified drag is cut short
                 * - Escape, a stop from the app, a recording whose part boundary fell between a press and
                 * its release.
                 *
                 * AFTER the buttons, and macOS does it BEFORE them. Not an inconsistency - the platforms
                 * differ in what a modifier IS. There the flag rides on each posted event, and the button-up
                 * is posted with the gesture's flags explicitly, so releasing the latch first changes
                 * nothing about it. Here the modifier is a held key and the mouse event carries no flags at
                 * all, so a button-up sent after the key is up arrives UNMODIFIED - and an Alt-drag whose
                 * drop lands without Alt is a move where a copy was recorded. The button closes the
                 * gesture; the modifier has to outlive it. */
                DropMods();
                Acting.End("replay");
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

        /* WHAT A REPLAY IS CURRENTLY HOLDING DOWN, and why this is a field rather than a local.
         *
         * THE PLATFORM DIFFERENCE, which is the whole of this half. On macOS a posted mouse event carries
         * its own modifier flags, and a measurement settled that those flags are SUFFICIENT - a window
         * reported the same NSEvent.modifierFlags for an event sent with flags only as for one sent with
         * the key physically held. So the macOS agent presses no key at all. A Windows MOUSEINPUT has no
         * field for a modifier: SendInput's mouse event cannot say "with Shift". The only way to make a
         * click a Shift-click here is to hold the actual key down - which is GLOBAL MACHINE STATE, not a
         * property of the event, and therefore has to be released by whoever pressed it or it stays held
         * for the person afterwards. That is the same class of bug 0.19.0 found on macOS, where a latched
         * Command turned the next typing into Command+Z.
         *
         * So: pressed at a button-down, released at its pair, and released again unconditionally in
         * Finish() - next to ReleaseHeldButtons, for exactly the reason its comment gives about a flow
         * whose last event is a button-down. A recording that was cut off between a press and its release
         * is not hypothetical; that is what a part boundary in a long session can look like.
         *
         * Not a set of booleans but the keycodes in press order, so the release can walk them backwards.
         * Win outermost and released last, the same order PressKey uses and for the same reason: the shell
         * watches for Win going down and up with nothing between, and letting go of it first can leave the
         * Start menu sitting on top of whatever the gesture did. */
        static readonly List<ushort> _gestureMods = new List<ushort>();

        /* The token list to keycodes, in press order. Unknown tokens are data rather than an error, which
         * is what PROTOCOL.md says about every value in this format and what lets the other agent add one.
         *
         * Both sides of each modifier are NOT used here, unlike ReleaseModifiers: pressing the generic
         * VK_SHIFT is how you ask for Shift, while asking WHETHER shift is held has to check left and
         * right separately. Asymmetric on purpose. */
        static List<ushort> ModKeys(string mods)
        {
            List<ushort> keys = new List<ushort>();
            if (string.IsNullOrEmpty(mods)) return keys;
            string[] tokens = mods.Split('+');
            bool win = false, ctrl = false, alt = false, shift = false;
            for (int i = 0; i < tokens.Length; i++)
            {
                string token = tokens[i].Trim().ToLowerInvariant();
                if (token == "cmd" || token == "command" || token == "win") win = true;
                else if (token == "ctrl" || token == "control") ctrl = true;
                else if (token == "alt" || token == "option") alt = true;
                else if (token == "shift") shift = true;
            }
            if (win) keys.Add(0x5B);
            if (ctrl) keys.Add(0x11);
            if (shift) keys.Add(0x10);
            if (alt) keys.Add(0x12);
            return keys;
        }

        static void HoldMods(string mods)
        {
            List<ushort> keys = ModKeys(mods);
            if (keys.Count == 0) return;
            /* SOMEBODY ELSE'S FIRST. A modifier latched by another application, a stuck physical key or a
             * previous agent that died mid-chord is ADDED to what this gesture asked for: a Shift-click
             * under a latched Ctrl is a Ctrl+Shift-click, which selects a range where a range was not
             * wanted. Same guard, same reason, as the first thing PressKey does. */
            ReleaseModifiers();
            for (int i = 0; i < keys.Count; i++)
            {
                SendVk(keys[i], false);
                _gestureMods.Add(keys[i]);
            }
        }

        static void DropMods()
        {
            for (int i = _gestureMods.Count - 1; i >= 0; i--)
            {
                try { SendVk(_gestureMods[i], true); }
                catch { /* cleanup must not throw past the thing it was called to clean up after */ }
            }
            _gestureMods.Clear();
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
                case "Scroll Right": flags |= Native.MOUSEEVENTF_HWHEEL; data = 120; break;
                case "Scroll Left": flags |= Native.MOUSEEVENTF_HWHEEL; data = unchecked((uint)-120); break;

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
                    if (e.Action != null && e.Action.StartsWith("Key ") && e.Action != "Key Down")
                    {
                        string spec = e.Action.Substring(4);
                        string[] parts = spec.Split('+');
                        string name = parts.Length > 0 ? parts[parts.Length - 1] : "";
                        bool wantCtrl = false, wantShift = false, wantAlt = false, wantWin = false;
                        for (int m = 0; m < parts.Length - 1; m++)
                        {
                            string mod = parts[m].ToLowerInvariant();
                            if (mod == "ctrl") wantCtrl = true;
                            else if (mod == "shift") wantShift = true;
                            else if (mod == "alt") wantAlt = true;
                            /* Read as well as written from 0.12.0: a chord recorded on a build that can hold
                             * Win must replay as that chord rather than as its remainder. An older recording
                             * simply never contains the word. */
                            else if (mod == "win" || mod == "cmd") wantWin = true;
                        }
                        if (PressKey(name, wantCtrl, wantShift, wantAlt, wantWin) != null)
                        {
                            /* PressKey refused the name - a recording from a later build naming a key this
                             * one does not know. Counted, never guessed at. */
                            lock (Gate) { _unplayable++; }
                        }
                        return;
                    }
                    return;
            }

            /* AFTER Retarget and immediately before the injection, which is the narrowest window this
             * can sit in. Retarget makes UIA calls that can take a second or more, and a modifier held
             * across them is held across them for the whole machine - including for whatever the person
             * is doing if they are still at the keyboard. */
            bool holding = false;
            if (e.Mods != null && IsPress(e.Action)) { HoldMods(e.Mods); holding = true; }
            /* A scroll has no pair, so it holds and lets go around itself. `#ctx mods=Cmd` on a scroll is
             * the one line in this format whose context is nothing but a modifier. */
            else if (e.Mods != null && e.Action != null && e.Action.StartsWith("Scroll"))
            {
                HoldMods(e.Mods);
                holding = true;
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

            /* Что держим - для финиша, который отпускает ровно это. См. ReleaseHeldButtons. */
            lock (Gate)
            {
                uint downBits = flags & (Native.MOUSEEVENTF_LEFTDOWN | Native.MOUSEEVENTF_RIGHTDOWN | Native.MOUSEEVENTF_MIDDLEDOWN);
                _heldByReplay |= downBits;
                if ((flags & Native.MOUSEEVENTF_LEFTUP) != 0) _heldByReplay &= ~Native.MOUSEEVENTF_LEFTDOWN;
                if ((flags & Native.MOUSEEVENTF_RIGHTUP) != 0) _heldByReplay &= ~Native.MOUSEEVENTF_RIGHTDOWN;
                if ((flags & Native.MOUSEEVENTF_MIDDLEUP) != 0) _heldByReplay &= ~Native.MOUSEEVENTF_MIDDLEDOWN;
            }

            /* A press KEEPS them - through the movements of a drag and until its release, which is why
             * this is not a symmetric hold/release around one event. The release event itself carries no
             * `mods` (PROTOCOL.md: not written on a release), so the test is what we are holding, not what
             * the line says.
             *
             * A second press while one is still held - two buttons down at once - lets go at the first
             * release rather than the second. Named because it is a real limit and not worth the
             * bookkeeping: nothing this format records produces it, since a recording of two overlapping
             * modified drags is not something a person makes by hand. */
            if (holding && e.Action != null && e.Action.StartsWith("Scroll")) DropMods();
            else if (_gestureMods.Count > 0
                && e.Action != null
                && (e.Action.EndsWith("Click Release") || e.Action.EndsWith("Click Up"))) DropMods();
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

        /* THE SAME EVENT, CARRYING A MODIFIER - which is the whole of the action grammar's half.
         *
         * Emit() already holds whatever an event's `Mods` names and lets go when the gesture closes; it was
         * written for a recording being replayed. An action asking for a Shift-click therefore needs no
         * mechanism of its own, only this: put the value on the event. That is deliberate rather than
         * merely short. Two code paths for "make this click a Shift-click" would drift, and the way they
         * would drift is invisible - one of them quietly performing the plain gesture.
         *
         * `mods` IS THE SAME VALUE AS IN A RECORDING, spelled the same way, and it means the same thing:
         * the physical keys. That differs from `ctrl=` on `action=key`, where the field means the COMMAND
         * modifier (Ctrl here, Command on macOS) because a shortcut is what that path is for. A Ctrl-click
         * is not a Command-click - one multi-selects and the other opens a link in a background tab - so a
         * gesture cannot use the portable-shortcut reading. PROTOCOL.md says this at length. */
        static Ev At(int x, int y, string action, string mods)
        {
            Ev e = At(x, y, action);
            if (!string.IsNullOrEmpty(mods)) e.Mods = mods;
            return e;
        }

        /* What the caller asked to hold, or null. Empty and whitespace both mean nothing, so a caller that
         * builds `mods=` out of an empty list is answered the same as one that omitted it. */
        static string AskedMods(Dictionary<string, string> a)
        {
            string said = Get(a, "mods", "").Trim();
            return said.Length > 0 ? said : null;
        }

        /* WHAT AN ACTION HAS TO SAY FOR ITSELF, when "done" is not the whole answer.
         *
         * Every action until 0.10.0 answered with nothing or with a problem, and `{"ok":true}` was the whole
         * reply. Capturing a window and reading the clipboard both produce a FACT the caller needs - a path,
         * a size, the text that was there - and there was nowhere to put it.
         *
         * Nowhere new, as it turns out. The deployment already passes an action's `output` straight to the
         * model when it is anything other than "done" (see resultBlocks in api/_step.mjs), so this is the
         * channel being used rather than a channel being added. A static beside _injectFailures and
         * _lastError, cleared at the start of every action for the same reason they are: one action runs at
         * a time on this path - /do refuses while a replay is going - and a value left over from the last
         * one would be reported as this one's. */
        static string _output;

        static void ResetOutput() { _output = null; }

        static void Say(string text) { _output = text; }

        /** Read once and cleared, so it cannot be reported twice. */
        public static string TakeOutput()
        {
            string said = _output;
            _output = null;
            return said;
        }

        public static string DoAction(string body)
        {
            /* THE BORDER LIGHTS HERE, NOT IN THE /do ROUTE, and that is not a tidy-up.
             *
             * It started in the route, and that was one caller short. DoAction has three: a step of a goal
             * run (already held by "goal"), the /do route, and Carry(), which performs the action in a
             * claimed job's `activate` field BEFORE starting the replay. The third held nothing - a window
             * was brought to the front, with the real jump a SetForegroundWindow makes, while no border was
             * up and /health answered that nobody was driving. The mistake was not in the route; it was in
             * what counts as the start of an action. That is DoAction, the one place all three pass
             * through, so the rule moved to where it is single. The macOS agent had the same hole in the
             * same shape and got the same move.
             *
             * A LEASE rather than a hold: an action has no end anybody reports. The browser driver runs the
             * loop and never tells the agent where a run begins or ends - what arrives is /shot, /windows,
             * up to 75 seconds of silence while the model thinks, then /do. A lease long enough to bridge a
             * turn would make "lit" accurate and "out" a lie for a minute and a quarter after the end, and
             * an indicator that lies AFTER the end is worse than one that blinks.
             *
             * BEFORE the parse and before the work: the point is to be lit WHILE the machine is being
             * touched, and an action refused a moment later was still an attempt to touch it. */
            Acting.Touch();

            Dictionary<string, string> a = ParseFields(body);
            string action = Get(a, "action", "");
            ResetInjection();
            ResetOutput();

            string problem = Perform(action, a);
            if (problem != null) return problem;
            /* An action that was accepted, encoded and sent, and that the OS then discarded, must not be
             * reported as done. Checked once, here, so every action is covered by construction. */
            return InjectionProblem();
        }

        /* ---------------------------------------------------------- the one window it will not touch
         *
         * THIS AGENT IS A POWERSHELL SCRIPT, so the terminal it was started from is a window it can type
         * into - and typing Ctrl+C there stops the run that is doing the typing.
         *
         * Not hypothetical. In a watched run the model needed a screenshot, found that press_key had no
         * PrintScreen, and went to write itself a capture tool in PowerShell. It opened a second tab, typed
         * a P/Invoke one-liner, pressed Ctrl+C - and wrote a note to its own successor saying "tab 1 is the
         * agent's own session (DO NOT type/Ctrl+C there)". It worked out the hazard on its own and left a
         * warning in prose. A warning in prose is not a guard.
         *
         * WHOLE WINDOW, not a tab, because Windows Terminal hosts every tab in ONE HWND: there is no such
         * thing as protecting tab 1 and allowing tab 2. That makes the refusal broader than the danger, and
         * the message says what to do about it - a second terminal window is a different HWND and is fine.
         *
         * Also this process's own windows: the tray menu is ours, and "Stop and Save Recording" is on it.
         *
         * Zero console means nothing to protect. Under autostart the agent runs with -WindowStyle Hidden and
         * has no console at all, and in that state every window on the machine is somebody else's.
         */
        /* WHAT COUNTS AS OURS, and it is three things rather than one - which took a measurement to find
         * out. The first version of this read GetConsoleWindow() and stopped there. On the machine this was
         * written for that returns ZERO, and the reason is the whole point: Windows Terminal hosts its
         * shells over a pseudoconsole, so there is no console window to find. The guard would have been
         * inert in exactly the environment it was written for, and nothing would have said so.
         *
         * Measured instead. A shell inside Windows Terminal sits like this:
         *
         *   powershell.exe(28132) <- WindowsTerminal.exe(26852, owns CASCADIA_HOSTING_WINDOW_CLASS)
         *                         <- explorer.exe(owns Progman and every File Explorer window)
         *
         * Three things follow. The visible window belongs to the PARENT process, not to us and not to a
         * console. Two tabs are two child processes of ONE window, so there is no such thing as protecting
         * one tab. And the next link up is explorer - so a walk one level too far would refuse the desktop
         * and the taskbar, which is the opposite of useful.
         *
         * So: our own windows, plus the console window when there is a real one (the classic conhost case,
         * where GetConsoleWindow does work), plus the windows of host processes up the chain - stopping at
         * the first that owns a visible window, and never crossing into the shell.
         */
        static readonly string[] NotAHost = new string[] {
            "explorer", "services", "svchost", "wininit", "winlogon", "csrss", "taskeng", "taskhostw",
        };

        static IntPtr _ownConsole = (IntPtr)(-1);
        static HashSet<int> _ownPids;

        static IntPtr OwnConsole()
        {
            if (_ownConsole != (IntPtr)(-1)) return _ownConsole;
            IntPtr console = IntPtr.Zero;
            try { console = Native.GetConsoleWindow(); }
            catch { console = IntPtr.Zero; }
            /* A pseudoconsole has no window, and a window that is not visible is not one anybody can click
             * into - either way there is nothing here to protect and the process walk is what matters. */
            if (console != IntPtr.Zero && !Native.IsWindowVisible(console)) console = IntPtr.Zero;
            if (console != IntPtr.Zero)
            {
                IntPtr top = Native.GetAncestor(console, Native.GA_ROOT);
                if (top != IntPtr.Zero) console = top;
            }
            _ownConsole = console;
            return _ownConsole;
        }

        /* The parent process id, and a check that the parent is really the parent: process ids are reused,
         * and a recycled id belonging to something started AFTER us is not our host. */
        static int HostOf(int pid, DateTime childStarted)
        {
            try
            {
                using (Process child = Process.GetProcessById(pid))
                {
                    Native.PROCESS_BASIC_INFORMATION info = new Native.PROCESS_BASIC_INFORMATION();
                    int written;
                    if (Native.NtQueryInformationProcess(child.Handle, 0, ref info,
                            Marshal.SizeOf(typeof(Native.PROCESS_BASIC_INFORMATION)), out written) != 0)
                    {
                        return 0;
                    }
                    int parent = info.InheritedFromUniqueProcessId.ToInt32();
                    if (parent <= 0) return 0;
                    using (Process up = Process.GetProcessById(parent))
                    {
                        if (up.StartTime > childStarted) return 0;
                        foreach (string bad in NotAHost)
                        {
                            if (string.Equals(up.ProcessName, bad, StringComparison.OrdinalIgnoreCase)) return 0;
                        }
                        return parent;
                    }
                }
            }
            catch { return 0; }
        }

        static bool ShowsAWindow(int pid)
        {
            bool found = false;
            try
            {
                Native.EnumWindows(delegate(IntPtr hWnd, IntPtr lParam)
                {
                    if (found) return false;
                    if (!Native.IsWindowVisible(hWnd)) return true;
                    if (Native.GetWindowTextLength(hWnd) < 1) return true;
                    uint owner;
                    Native.GetWindowThreadProcessId(hWnd, out owner);
                    if ((int)owner == pid) found = true;
                    return !found;
                }, IntPtr.Zero);
            }
            catch { return false; }
            return found;
        }

        static HashSet<int> OwnPids()
        {
            if (_ownPids != null) return _ownPids;
            HashSet<int> pids = new HashSet<int>();
            try
            {
                Process me = Process.GetCurrentProcess();
                pids.Add(me.Id);
                int at = me.Id;
                DateTime started = me.StartTime;
                /* Four levels is more than any real chain needs - shell, host, and the window owner - and
                 * the walk stops at the first host that owns a window anyway. */
                for (int level = 0; level < 4; level++)
                {
                    int host = HostOf(at, started);
                    if (host == 0) break;
                    pids.Add(host);
                    if (ShowsAWindow(host)) break;   // this is the terminal a person can see and click into
                    at = host;
                    try { started = Process.GetProcessById(host).StartTime; }
                    catch { break; }
                }
            }
            catch { /* whatever was collected stands; an empty set simply protects nothing */ }
            _ownPids = pids;
            return _ownPids;
        }

        /** The refusal, or null when that window is somebody else's and may be driven. */
        static string Mine(IntPtr hwnd)
        {
            if (hwnd == IntPtr.Zero) return null;
            IntPtr top = Native.GetAncestor(hwnd, Native.GA_ROOT);
            if (top != IntPtr.Zero) hwnd = top;

            IntPtr console = OwnConsole();
            if (console != IntPtr.Zero && hwnd == console) return Refusal(true);

            try
            {
                uint pid;
                Native.GetWindowThreadProcessId(hwnd, out pid);
                if (pid == 0) return null;
                if (!OwnPids().Contains((int)pid)) return null;
                return Refusal((int)pid != Process.GetCurrentProcess().Id);
            }
            catch { return null; }
        }

        static string Refusal(bool terminal)
        {
            if (!terminal)
            {
                return "that window belongs to the MouseFlow agent itself - driving it would be the run "
                    + "operating its own controls.";
            }
            return "that window is the terminal this agent is running in, and a keystroke there "
                + "can stop the run that sent it. Every tab of that terminal is the same window, so there "
                + "is no safe tab in it. Nothing here can be typed into - say so and carry on. If a command "
                + "line is genuinely part of the task, the agent has to be started somewhere else: from a "
                + "different terminal application, or from autostart, where it has no terminal at all.";
        }

        static string Perform(string action, Dictionary<string, string> a)
        {
            /* THE FOCUS-AIMED ACTIONS ARE GUARDED FIRST, and by the foreground window rather than by a
             * point: typing goes wherever focus is, which is precisely how a keystroke meant for a form
             * ends up in the terminal running the agent. */
            if (action == "type" || action == "key")
            {
                string mine = Mine(Native.GetForegroundWindow());
                if (mine != null) return mine;
            }

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
            if (action == "activate")
            {
                /* Refused before it happens rather than after: bringing this agent's own terminal to the
                 * front is how the NEXT action, aimed at whatever is in front, lands in it. */
                IntPtr wanted = WindowMatching(Get(a, "title", ""), Get(a, "process", ""));
                if (wanted != IntPtr.Zero)
                {
                    string mine = Mine(wanted);
                    if (mine != null) return mine;
                }
                return Activate(Get(a, "title", ""), Get(a, "process", ""));
            }

            /* ------------------------------------------------------------------ 0.10.0: reading back */

            if (action == "clipread")
            {
                string had = null;
                string failed = OnSta(delegate { had = System.Windows.Forms.Clipboard.GetText(); });
                if (failed != null) return failed;
                if (string.IsNullOrEmpty(had)) { Say("the clipboard holds no text"); return null; }
                /* Capped where it is READ, not where it is shown: the deployment cuts an action's output at
                 * 2000 characters anyway, and sending a 40MB clipboard across loopback to be thrown away is
                 * work nobody asked for. Said out loud when it happens, because a silently halved value that
                 * the model then types somewhere is worse than no value. */
                if (had.Length > 4000)
                {
                    Say("the clipboard holds " + had.Length.ToString(CultureInfo.InvariantCulture)
                        + " characters; the first 4000 are: " + had.Substring(0, 4000));
                    return null;
                }
                Say("the clipboard holds: " + had);
                return null;
            }

            if (action == "clipwrite")
            {
                string put = Get(a, "text", "");
                if (Get(a, "enc", "") == "b64")
                {
                    put = DecodeB64(put);
                    if (put == null) return "the text was not valid base64";
                }
                if (put.Length == 0) return "nothing to put on the clipboard";
                string failed = OnSta(delegate { System.Windows.Forms.Clipboard.SetText(put); });
                if (failed != null) return failed;
                Say("put " + put.Length.ToString(CultureInfo.InvariantCulture)
                    + " characters on the clipboard");
                return null;
            }

            if (action == "capture") return Capture(a);

            /* ------------------------------------------------------------------ 0.11.0: aiming by name */

            if (action == "read") return ReadWindow(a);
            if (action == "find") return FindElement(a);
            /* ------------------------------------------------------ 0.28.0: clicking by name
             *
             * Рядом с find нарочно: они делят разрешение имени (NamedHits), и читателю, который придёт
             * менять правило поиска, надо видеть сразу обоих, кто по этому правилу отвечает. */
            if (action == "clickname") return ClickNamed(a);
            if (action == "scrollto") return ScrollTo(a);

            /* ------------------------------------------------------------------ 0.12.0 */

            if (action == "refresh") return Refresh(a);
            if (action == "waitwindow") return WaitForWindow(a);

            if (action == "open")
            {
                string url = Get(a, "url", "");
                string app = Get(a, "app", "");
                if (url.Length > 0) return OpenUrl(url);
                if (app.Length > 0) return OpenApp(app);
                return "open needs a url or an app name";
            }
            if (action == "key")
            {
                /* `cmd` and `meta` read onto Ctrl, which is the mirror of the macOS agent reading `win`. A
                   skill created on a Mac says cmd=1 for the command modifier, and on Windows that modifier
                   IS Ctrl - while the Windows key is `win` and stays separate. A field one half sends and
                   the other ignores is a chord that loses a modifier without saying so, which is exactly how
                   Win+D became a bare D in the other direction. */
                return PressKey(Get(a, "key", ""),
                    Get(a, "ctrl", "0") == "1" || Get(a, "cmd", "0") == "1" || Get(a, "meta", "0") == "1",
                    Get(a, "shift", "0") == "1", Get(a, "alt", "0") == "1",
                    Get(a, "win", "0") == "1");
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

            /* AND THE POINT-AIMED ONES, once there is a point to test. Below the bounds check on purpose:
             * "that is off the screen" is the more useful answer for a coordinate that is off the screen. */
            {
                string mine = Mine(Native.WindowFromPoint(new POINT { X = x, Y = y }));
                if (mine != null) return mine;
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

                /* SIDEWAYS, when asked for. Absent `dir` keeps the old reading exactly - the sign of
                 * `amount` chooses up or down - so a caller written before 0.12.0 behaves as it did. */
                string dir = Get(a, "dir", "").Trim().ToLowerInvariant();
                string which;
                if (dir == "left") which = "Scroll Left";
                else if (dir == "right") which = "Scroll Right";
                else if (dir == "up") which = "Scroll Up";
                else if (dir == "down") which = "Scroll Down";
                else if (dir.Length > 0) return "dir is up, down, left or right - not \"" + dir + "\"";
                else which = amount > 0 ? "Scroll Up" : "Scroll Down";

                /* THE COUNT IS REPORTED, and that is the fix rather than the cap.
                 *
                 * It used to be Math.Min(20, ...) and the answer was `{"ok":true}` - so a request for fifty
                 * notches delivered twenty and reported success, and the model then reasoned about a
                 * position it had not reached. This is the same sin the transcript has a long note about
                 * (`summary.applications` reading 24 for a recording that touched thirty windows):
                 * under-delivery presented as a fact.
                 *
                 * There is still a ceiling, because `amount=100000` is a request nobody meant and forty
                 * minutes of wheel is not a better answer than a sentence. It is six times higher than the
                 * old one, and when it bites it says so. */
                int wanted = Math.Abs(amount);
                int steps = Math.Min(120, wanted);
                Emit(At(x, y, "Mouse Movement"));
                /* HELD ONCE AROUND THE WHOLE RUN, not per notch - and this is the one action where the
                 * value is not simply put on the event. A scroll has no pair, so Emit holds and releases
                 * around each notch it sees; for a hundred notches that is a hundred presses and releases
                 * of Ctrl, which is both wasteful and a different gesture from what was asked - a zoom that
                 * restarts is not a zoom that continues. try/finally because Thread.Sleep sits inside the
                 * loop: an abort thrown into that window would leave the key down for the whole machine. */
                string scrollMods = AskedMods(a);
                if (scrollMods != null) HoldMods(scrollMods);
                try
                {
                    for (int i = 0; i < steps; i++)
                    {
                        Emit(At(x, y, which));
                        Thread.Sleep(25);
                    }
                }
                finally { if (scrollMods != null) DropMods(); }
                if (steps != wanted)
                {
                    Say("scrolled " + steps.ToString(CultureInfo.InvariantCulture) + " notches, not "
                        + wanted.ToString(CultureInfo.InvariantCulture)
                        + " - 120 is as much as one scroll does. Call it again, or use scroll_to");
                }
                return null;
            }

            if (action == "drag")
            {
                int tx, ty;
                if (!int.TryParse(Get(a, "tx", ""), NumberStyles.Integer, CultureInfo.InvariantCulture, out tx) ||
                    !int.TryParse(Get(a, "ty", ""), NumberStyles.Integer, CultureInfo.InvariantCulture, out ty))
                {
                    return "drag needs tx and ty - where to let go";
                }
                string minedTarget = Mine(Native.WindowFromPoint(new POINT { X = tx, Y = ty }));
                if (minedTarget != null) return minedTarget;
                return Drag(x, y, tx, ty, AskedMods(a));
            }

            if (action == "click")
            {
                return ClickAt(x, y, Get(a, "button", "left"), Get(a, "double", "0") == "1", AskedMods(a));
            }

            /* Named, and said in a way that distinguishes "no such action anywhere" from "not on this
             * machine": capture, clipread, clipwrite and open landed on Windows in 0.10.0 and the macOS
             * agent does not have them yet. A model told only "unknown action" tries a workaround; one told
             * which platform it is on stops. */
            if (action == "capture" || action == "clipread" || action == "clipwrite" || action == "open")
            {
                return "this agent is too old for " + action + " - it arrived in 0.10.0. Update the agent.";
            }
            if (action == "refresh" || action == "waitwindow")
            {
                return "this agent is too old for " + action + " - it arrived in 0.12.0. Update the agent.";
            }
            if (action == "read" || action == "find" || action == "scrollto" || action == "drag")
            {
                return "this agent is too old for " + action + " - it arrived in 0.11.0. Update the agent.";
            }
            return "unknown action: " + action;
        }

        /* ---------------------------------------------------------------- 0.10.0: the machinery

           STA, because the clipboard demands it. Clipboard.GetText and SetImage both throw on a thread that
           is not single-threaded-apartment, and every thread in this agent is a plain background thread -
           the HTTP handlers, the resolver, the courier. A thread per call rather than one kept alive: the
           clipboard is touched a few times a run, and a long-lived STA thread is a message pump to own.

           Joined with a limit, because the clipboard can be held open by another application - a clipboard
           manager, a remote desktop client - and a call that never returns would hang the whole action. */
        static string OnSta(ThreadStart work)
        {
            Exception failure = null;
            Thread worker = new Thread(delegate()
            {
                try { work(); }
                catch (Exception e) { failure = e; }
            });
            worker.SetApartmentState(ApartmentState.STA);
            worker.IsBackground = true;
            worker.Start();
            if (!worker.Join(6000)) return "the clipboard did not answer in six seconds - another program may be holding it open";
            if (failure != null) return "the clipboard refused: " + failure.Message;
            return null;
        }

        /* Where captures go, and what stops them accumulating.
         *
         * Under LOCALAPPDATA rather than Pictures or Downloads: these are working files of a run, not
         * something somebody chose to save, and putting them among a person's own pictures makes them that
         * person's problem to sort out. A run that captures thirty windows leaves thirty files, so the
         * folder prunes itself - by age first, and then by count, because a hundred captures in one hour is
         * as much a runaway as a hundred over a month. */
        static string CaptureDir()
        {
            string dir = Path.Combine(
                Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData),
                "MouseFlow\\captures");
            Directory.CreateDirectory(dir);
            try
            {
                List<FileInfo> files = new List<FileInfo>();
                foreach (FileInfo f in new DirectoryInfo(dir).GetFiles("*.png")) files.Add(f);
                DateTime cutoff = DateTime.UtcNow.AddDays(-7);
                files.Sort(delegate(FileInfo x, FileInfo y) { return y.LastWriteTimeUtc.CompareTo(x.LastWriteTimeUtc); });
                for (int i = 0; i < files.Count; i++)
                {
                    if (i >= 200 || files[i].LastWriteTimeUtc < cutoff)
                    {
                        try { files[i].Delete(); } catch { /* in use, or gone already */ }
                    }
                }
            }
            catch { /* pruning is housekeeping; a capture must not fail because of it */ }
            return dir;
        }

        /* One window, or a rectangle, or whatever is in front.
         *
         * BY WINDOW IS THE POINT. A capture of the screen is a capture of whatever is on top, and in the run
         * this was written for that was the terminal covering the dialog the model was trying to photograph -
         * it never once managed to confirm the dialog was even open. PrintWindow asks the window to draw
         * ITSELF, so what is in front of it does not matter. It fails on a few windows (some older
         * hardware-accelerated surfaces), and the fallback then photographs that patch of screen, which is
         * better than nothing and is said out loud so nobody reads an occluded picture as a clean one. */
        static string Capture(Dictionary<string, string> a)
        {
            /* THE REGION IS REPORTED IN THE COORDINATES THE CALLER SENT IT IN, which it was not until
             * 0.14.0. `read_window` answers in screenshot pixels and this answered in screen pixels, so a
             * model that asked for a region and read the reply back got numbers from the other system - and
             * in a watched run it spent a step correcting itself over exactly that. */
            ReadGeometry(a);
            /* Initialised, because `&&` short-circuits and the compiler cannot see that a false chain
             * means the window branch is taken - it only sees four maybe-unassigned locals. */
            int rx = 0, ry = 0, rw = 0, rh = 0;
            bool haveRegion = int.TryParse(Get(a, "x", ""), NumberStyles.Integer, CultureInfo.InvariantCulture, out rx)
                && int.TryParse(Get(a, "y", ""), NumberStyles.Integer, CultureInfo.InvariantCulture, out ry)
                && int.TryParse(Get(a, "w", ""), NumberStyles.Integer, CultureInfo.InvariantCulture, out rw)
                && int.TryParse(Get(a, "h", ""), NumberStyles.Integer, CultureInfo.InvariantCulture, out rh);

            string title = Get(a, "title", "");
            string process = Get(a, "process", "");
            IntPtr target = IntPtr.Zero;
            string what;

            if (haveRegion)
            {
                if (rw < 2 || rh < 2) return "a region needs a width and height of at least 2 pixels";
                what = "the region " + ToShotSize(rw).ToString(CultureInfo.InvariantCulture) + "x"
                    + ToShotSize(rh).ToString(CultureInfo.InvariantCulture) + " at "
                    + ToShotX(rx).ToString(CultureInfo.InvariantCulture) + ","
                    + ToShotY(ry).ToString(CultureInfo.InvariantCulture);
            }
            else
            {
                if (title.Length > 0 || process.Length > 0)
                {
                    target = WindowMatching(title, process);
                    if (target == IntPtr.Zero)
                    {
                        return "no open window matches " + (title.Length > 0 ? "title \"" + title + "\"" : "process " + process)
                            + " - the list of open windows under the screenshot is what is actually there";
                    }
                }
                else
                {
                    target = Native.GetForegroundWindow();
                    if (target == IntPtr.Zero) return "nothing is in front to capture";
                }
                IntPtr top = Native.GetAncestor(target, Native.GA_ROOT);
                if (top != IntPtr.Zero) target = top;
                if (Native.IsIconic(target))
                {
                    return "that window is minimised, and a minimised window has nothing to draw - "
                        + "activate_window first, then capture it";
                }
                RECT box;
                if (!Native.GetWindowRect(target, out box)) return "could not measure that window";
                rx = box.Left;
                ry = box.Top;
                rw = box.Right - box.Left;
                rh = box.Bottom - box.Top;
                if (rw < 2 || rh < 2) return "that window has no size to capture";
                what = TitleOf(target);
                what = what == null ? "that window" : "\"" + what + "\"";
            }

            /* Deliberately NOT guarded by Mine(): a picture of a window changes nothing, and photographing
             * this agent's own terminal is a reasonable thing to want when something has gone wrong in it. */
            string path = Path.Combine(CaptureDir(),
                "capture-" + DateTime.Now.ToString("yyyyMMdd-HHmmss-fff", CultureInfo.InvariantCulture) + ".png");
            bool drewItself = false;
            try
            {
                using (System.Drawing.Bitmap shot = new System.Drawing.Bitmap(rw, rh))
                {
                    using (System.Drawing.Graphics g = System.Drawing.Graphics.FromImage(shot))
                    {
                        if (target != IntPtr.Zero)
                        {
                            IntPtr hdc = g.GetHdc();
                            try { drewItself = Native.PrintWindow(target, hdc, Native.PW_RENDERFULLCONTENT); }
                            finally { g.ReleaseHdc(hdc); }
                        }
                        if (!drewItself)
                        {
                            g.CopyFromScreen(rx, ry, 0, 0, new System.Drawing.Size(rw, rh));
                        }
                    }
                    shot.Save(path, System.Drawing.Imaging.ImageFormat.Png);
                    /* On the clipboard TOO, not instead: the two are wanted by different callers. Pasting
                     * into a document wants the clipboard; attaching to a report wants the file. */
                    System.Drawing.Bitmap copy = new System.Drawing.Bitmap(shot);
                    string failed = OnSta(delegate
                    {
                        try { System.Windows.Forms.Clipboard.SetImage(copy); }
                        finally { copy.Dispose(); }
                    });

                    /* The size once. A region already names its own dimensions, and "the region 200x120 at
                     * 100,100, 200x120, to ..." is the sort of thing that reads as a bug in the sentence. */
                    string said = "captured " + what
                        + (haveRegion ? "" : ", " + ToShotSize(rw).ToString(CultureInfo.InvariantCulture) + "x"
                            + ToShotSize(rh).ToString(CultureInfo.InvariantCulture))
                        + ", to " + path;
                    said += failed == null
                        ? " and onto the clipboard - paste it with Control+V"
                        : ". It is NOT on the clipboard: " + failed;
                    if (target != IntPtr.Zero && !drewItself)
                    {
                        said += ". That window would not draw itself, so this is a photograph of that patch "
                            + "of screen - anything in front of it is in the picture";
                    }
                    Say(said);
                    return null;
                }
            }
            catch (Exception e)
            {
                return "could not capture: " + e.Message;
            }
        }

        /* ---------------------------------------------------------------- 0.11.0: seeing by name

           THE RULE THIS BENDS, AND THE MEASUREMENT THAT SAYS IT MAY. PROTOCOL.md forbids walking a window's
           tree on the input path, at 0.6-4.4 seconds per window. That number is about a RECURSION FROM THIS
           PROCESS - GetFirstChild, GetNextSibling, one cross-process call per element - and it is still
           true: measured here, an uncapped ControlViewWalker recursion over a 241-element window took 347ms
           and grows with the tree.

           A single FindAll with the condition on the SERVER side is a different call: the provider walks its
           own tree in its own process and answers once. Measured across eighteen real top-level windows -
           dbForge Studio, Outlook, Teams, Chrome, File Explorer, an Electron app - it ran from 0 to 319ms,
           with dbForge at 187ms for 28 named elements. Against a model turn of eight to fifty seconds that
           is nothing, and it is spent because the model ASKED rather than on every click.

           Bounded anyway, on a worker thread with a deadline: a provider that hangs must not take the action
           with it. An application that will not answer is a fact worth reporting, not a reason to wait.
        */
        /* THE NAME CONDITION STAYS, and this is the measurement that settled it rather than a caution.
         *
         * macOS lists an entirely unnamed text field, because it has a VALUE; this condition drops it,
         * because it has no name. That asymmetry was written down as a gap with "relaxing it changes the
         * size of every Windows result set and was not worth doing blind". Measured over fourteen live
         * top-level windows - Teams, Outlook (PWA), Chrome, an Electron app, three File Explorers, Notepad,
         * dbForge:
         *
         *   named + visible + control              0 - 335 elements   (what this returns)
         *   visible + control                      +23 to +108 more   (Outlook 229 -> 337, Teams 184 -> 275)
         *   (named OR has a value) + visible       +0 or +1
         *
         * So the targeted version - the one that would close the asymmetry - found ONE extra element on two
         * windows out of fourteen, and both were useless: a read-only Document, and an unnamed 13x14
         * checkbox with an empty value. ValueOf skips both anyway, the first for being read-only and the
         * second for being empty. Every element with a value in that sample was already named.
         *
         * Dropping the condition outright is the expensive one and it buys the same nothing: a quarter to a
         * half more elements, against a read that already truncates at 28 and says how many it left out.
         * More elements there is not more information, it is a shorter list of the ones that matter.
         *
         * If an unnamed editable field does show up on some machine, the shape to reach for is
         * `Not(And(Name=="", IsValuePatternAvailable==false))` - equivalent to "named or has a value" and
         * measured to return exactly the same set as the Or form, which was checked because a wrong claim
         * about UIA condition trees nearly went into this comment. */
        static Condition NamedAndVisible()
        {
            return new AndCondition(
                new NotCondition(new PropertyCondition(AutomationElement.NameProperty, "")),
                new PropertyCondition(AutomationElement.IsOffscreenProperty, false),
                new PropertyCondition(AutomationElement.IsControlElementProperty, true));
        }

        /* A search with a deadline - and a counter, because a deadline alone leaks.
         *
         * MEASURED, NOT IMAGINED: dbForge Studio answered this same call in 187ms one hour and stopped
         * answering entirely the next - not slowly, and not only from a worker thread but from the main one
         * too. An application that has gone busy, or is showing something its provider is stuck behind,
         * simply does not reply. That is what the deadline is for.
         *
         * But abandoning the thread is not free: it stays blocked inside the call, and a model that tries
         * again would spawn another. The first attempt at that was a single global lock, and it was WORSE
         * THAN THE LEAK - measured, on this machine: one hung dbForge poisoned every later read, so a window
         * that answers in 400ms was refused for the rest of the session because an unrelated application
         * had stopped talking an hour earlier. A cure that disables the feature is not a cure.
         *
         * So: the window that timed out is muted BY HANDLE for a minute - a retry on it costs nothing
         * instead of another whole deadline - and up to three searches may be outstanding before anything is
         * refused outright. Other windows are unaffected, which is the property the global lock destroyed.
         * The counter is cleared by each worker whenever it eventually returns, so nothing needs a restart.
         */
        static int _stuck;
        static readonly Dictionary<IntPtr, DateTime> _mute = new Dictionary<IntPtr, DateTime>();

        static AutomationElementCollection Search(AutomationElement root, IntPtr hwnd, Condition what,
                                                 int budgetMs, out string problem)
        {
            lock (_mute)
            {
                /* Pruned on the way past, so a long session cannot grow this without bound. */
                List<IntPtr> over = new List<IntPtr>();
                foreach (KeyValuePair<IntPtr, DateTime> entry in _mute)
                {
                    if (entry.Value <= DateTime.UtcNow) over.Add(entry.Key);
                }
                foreach (IntPtr key in over) _mute.Remove(key);

                if (hwnd != IntPtr.Zero && _mute.ContainsKey(hwnd))
                {
                    problem = "that window did not answer a moment ago and has not been asked again - it is "
                        + "busy, or showing something its accessibility interface is stuck behind. Work from "
                        + "the screenshot for this one; other windows still read normally";
                    return null;
                }
            }

            if (Thread.VolatileRead(ref _stuck) >= 3)
            {
                problem = "three windows are not answering their accessibility interface, so nothing more "
                    + "will be asked for now. Work from the screenshot instead";
                return null;
            }

            AutomationElementCollection found = null;
            Exception failure = null;
            Interlocked.Increment(ref _stuck);
            Thread worker = new Thread(delegate()
            {
                try
                {
                    /* CACHED, and the difference is not a detail: reading Name, type, rectangle and enabled
                     * off each element AFTERWARDS is one cross-process call per property per element. Asked
                     * for up front instead - one call, the provider fills them in as it walks - and measured
                     * on the same two windows either way: File Explorer 2039ms to 852ms, an Electron app
                     * 2656ms to 570ms. Two to four times faster rather than the order of magnitude the
                     * FindAll-only measurement suggested, because the walk itself is now the cost. Same
                     * information; the only thing to remember is that callers read the CACHE.
                     *
                     * Activated on THIS thread, because a CacheRequest is thread-local and the FindAll it
                     * has to cover runs here. */
                    CacheRequest wanted = new CacheRequest();
                    wanted.Add(AutomationElement.NameProperty);
                    wanted.Add(AutomationElement.LocalizedControlTypeProperty);
                    wanted.Add(AutomationElement.BoundingRectangleProperty);
                    wanted.Add(AutomationElement.IsEnabledProperty);
                    /* Added in 0.17.0 for ValueOf: what is IN a field, and whether that field is a password.
                     * Asked for here rather than read afterwards for exactly the reason the four above are -
                     * a property read off the element later is another cross-process call each. */
                    wanted.Add(AutomationElement.IsPasswordProperty);
                    wanted.Add(ValuePattern.ValueProperty);
                    wanted.Add(ValuePattern.IsReadOnlyProperty);
                    wanted.TreeScope = TreeScope.Element;
                    using (wanted.Activate())
                    {
                        found = root.FindAll(TreeScope.Descendants, what);
                    }
                }
                catch (Exception e) { failure = e; }
                finally { Interlocked.Decrement(ref _stuck); }
            });
            worker.IsBackground = true;
            worker.Start();
            if (!worker.Join(budgetMs))
            {
                if (hwnd != IntPtr.Zero)
                {
                    lock (_mute) { _mute[hwnd] = DateTime.UtcNow.AddSeconds(60); }
                }
                problem = "that window did not answer within "
                    + (budgetMs / 1000).ToString(CultureInfo.InvariantCulture)
                    + " seconds - it is busy, or showing something its accessibility interface is stuck "
                    + "behind. Work from the screenshot instead";
                return null;
            }
            problem = failure == null ? null : "that window would not describe itself: " + failure.Message;
            return found;
        }

        /* Which window to look at: the one asked for, or whatever is in front.
         *
         * THE TITLE IS A PARAMETER, not a field read from `a`, and that is a bug fixed rather than a style
         * choice. `find` needs two free-text values - which window, and what to look for inside it - and the
         * wire format gives an action exactly ONE field that may contain spaces. So `find` spends its one
         * such field on the NAME it is looking for and selects the window by process or by what is in front;
         * reading `title` from `a` here meant a find for "Help" went looking for a WINDOW called Help. */
        static AutomationElement WindowToRead(string title, string process, out IntPtr found,
                                              out string problem)
        {
            problem = null;
            found = IntPtr.Zero;
            title = title ?? "";
            process = process ?? "";
            IntPtr hwnd;
            if (title.Length > 0 || process.Length > 0)
            {
                hwnd = WindowMatching(title, process);
                if (hwnd == IntPtr.Zero)
                {
                    problem = "no open window matches "
                        + (title.Length > 0 ? "title \"" + title + "\"" : "process " + process)
                        + " - the list of open windows under the screenshot is what is actually there";
                    return null;
                }
            }
            else
            {
                hwnd = Native.GetForegroundWindow();
                if (hwnd == IntPtr.Zero) { problem = "nothing is in front to read"; return null; }
            }
            IntPtr top = Native.GetAncestor(hwnd, Native.GA_ROOT);
            if (top != IntPtr.Zero) hwnd = top;
            found = hwnd;
            try
            {
                AutomationElement el = AutomationElement.FromHandle(hwnd);
                if (el == null) problem = "that window has no accessibility tree at all";
                return el;
            }
            catch (Exception e)
            {
                problem = "could not reach that window: " + e.Message;
                return null;
            }
        }

        /* SCREEN PIXELS OUT, SCREENSHOT PIXELS IN - and this is the one place the agent converts.
         *
         * Everywhere else the deployment converts, in actionBody, because everywhere else coordinates travel
         * INWARDS and one place to do it is the rule. These actions send coordinates OUTWARDS, which has
         * never had a home, and the alternative is worse than a second site: a model reading positions in
         * screen pixels off one action and clicking in screenshot pixels with the next would be two
         * coordinate systems in one conversation, which is a class of wrong nobody would spot until a click
         * landed somewhere strange on a scaled screenshot.
         *
         * The deployment sends the same three numbers the screenshot reported. Absent - an older deployment,
         * or a caller with no picture - means one to one, which is what those numbers were before /shot
         * started scaling. */
        static double _shotScale = 1.0;
        static int _shotOx;
        static int _shotOy;

        static void ReadGeometry(Dictionary<string, string> a)
        {
            double scale;
            if (!double.TryParse(Get(a, "scale", ""), NumberStyles.Float, CultureInfo.InvariantCulture, out scale)
                || scale <= 0) scale = 1.0;
            int ox, oy;
            if (!int.TryParse(Get(a, "ox", ""), NumberStyles.Integer, CultureInfo.InvariantCulture, out ox)) ox = 0;
            if (!int.TryParse(Get(a, "oy", ""), NumberStyles.Integer, CultureInfo.InvariantCulture, out oy)) oy = 0;
            _shotScale = scale;
            _shotOx = ox;
            _shotOy = oy;
        }

        static int ToShotX(double screenX) { return (int)Math.Round((screenX - _shotOx) * _shotScale); }
        static int ToShotY(double screenY) { return (int)Math.Round((screenY - _shotOy) * _shotScale); }
        static int ToShotSize(double px) { return (int)Math.Round(px * _shotScale); }

        /* WHAT IS IN A FIELD, and why the recording still refuses to look.
         *
         * The two paths part company here on purpose. A RECORDING never takes typed text: it is stored,
         * exported into a SKILL.md, downloaded and forwarded, and the promise the agent prints on the record
         * screen is about that. READING A WINDOW is the other path - the model calls it between turns, the
         * answer lives for one turn and is stored nowhere (a run writes `{tool, input, ms}`; the action's
         * output never reaches the row).
         *
         * And the thing this "reveals" was already sent: the screenshot of a save dialog CONTAINS the typed
         * name, in every frame. Refusing to name what was already pictured protected nothing - it made the
         * model guess. Measured on macOS, where the same blindness cost a 198-second run nine repeated steps
         * out of fourteen: the file name was typed FOUR times by three different mechanisms because nothing
         * could say whether it had landed.
         *
         * A PASSWORD IS NOT PART OF THAT, on either path and under any wording. IsPassword first, before
         * anything is read.
         *
         * Read-only is skipped too, which is the mirror of the macOS rule (`AXUIElementIsAttributeSettable`
         * on the value): a read-only ValuePattern is a label wearing a pattern, not something somebody
         * typed - and it is already in `name`.
         *
         * Clipped short and deliberately: the value of a document body is the document, and the deployment
         * cuts an action's output at 2000 characters. Eighty is enough to read back a file name and not
         * enough to carry off a text. */
        const int ValueMax = 80;

        /* Поле пароля - это ПОЛЕ, и его надо видеть. Отдельно от значения, потому что пустое поле и поле
           пароля иначе выглядят в ответе одинаково, и модель, решившая, что поле просто пустое, напечатает
           в него то, что собиралась. Найдено пробой на macOS - окно с двумя полями, обычным и защищённым. */
        static bool IsSecret(AutomationElement el)
        {
            try
            {
                object secret = el.GetCachedPropertyValue(AutomationElement.IsPasswordProperty);
                return secret is bool && (bool)secret;
            }
            catch { return false; }
        }

        static string ValueOf(AutomationElement el)
        {
            try
            {
                if (IsSecret(el)) return null;
                object locked = el.GetCachedPropertyValue(ValuePattern.IsReadOnlyProperty);
                if (!(locked is bool) || (bool)locked) return null;
                string said = el.GetCachedPropertyValue(ValuePattern.ValueProperty) as string;
                if (string.IsNullOrEmpty(said)) return null;
                return Clip(said.Replace("\r", " ").Replace("\n", " ").Replace("\t", " "), ValueMax);
            }
            /* An element that does not support ValuePattern has nothing cached under it, and that is the
               ordinary case rather than a fault - a button is not a field. Caught narrowly, so it does not
               cost the element its whole line. */
            catch { return null; }
        }

        /* One element, described the way the model will read it back. */
        static string Line(string kind, string name, System.Windows.Rect box, bool enabled, string value,
            bool secret)
        {
            return (string.IsNullOrEmpty(kind) ? "element" : kind)
                + " \"" + Clip(name, 60) + "\""
                + " at " + ToShotX(box.X).ToString(CultureInfo.InvariantCulture) + ","
                + ToShotY(box.Y).ToString(CultureInfo.InvariantCulture)
                + " " + ToShotSize(box.Width).ToString(CultureInfo.InvariantCulture) + "x"
                + ToShotSize(box.Height).ToString(CultureInfo.InvariantCulture)
                /* `= "…"` AFTER the rectangle and before "(disabled)", so the line reads left to right as
                   what it is, where it is, what is in it. Same order as the macOS half.
                   A password field says so in words rather than showing nothing: nothing is what an EMPTY
                   field shows, and the two must not read alike. */
                + (secret ? " = (password, not read)" : (value == null ? "" : " = \"" + value + "\""))
                + (enabled ? "" : " (disabled)");
        }

        static bool Usable(System.Windows.Rect box)
        {
            return box.Width > 1 && box.Height > 1
                && !double.IsInfinity(box.Width) && !double.IsInfinity(box.Height);
        }

        /* WHAT IS ON THIS WINDOW, by name.
         *
         * The answer to a model aiming at a coordinate read off a downscaled screenshot: it can read the
         * names instead. Capped twice - by count and by characters - because the deployment cuts an action's
         * output at 2000 characters and a list silently halved there would be a list the model trusts and
         * should not. What was left out is said out loud. */
        static string ReadWindow(Dictionary<string, string> a)
        {
            ReadGeometry(a);
            string problem;
            IntPtr hwnd;
            AutomationElement root = WindowToRead(Get(a, "title", ""), Get(a, "process", ""),
                out hwnd, out problem);
            if (root != null)
            {
                AutomationElementCollection all = Search(root, hwnd, NamedAndVisible(), 4000, out problem);
                if (all != null)
                {
                    List<string> lines = new List<string>();
                    HashSet<string> seen = new HashSet<string>();
                    int skipped = 0;
                    int budget = 1500;
                    foreach (AutomationElement el in all)
                    {
                        try
                        {
                            System.Windows.Rect box = (System.Windows.Rect)el.GetCachedPropertyValue(
                                AutomationElement.BoundingRectangleProperty);
                            if (!Usable(box)) { continue; }
                            string line = Line(
                                (string)el.GetCachedPropertyValue(AutomationElement.LocalizedControlTypeProperty),
                                (string)el.GetCachedPropertyValue(AutomationElement.NameProperty),
                                box,
                                (bool)el.GetCachedPropertyValue(AutomationElement.IsEnabledProperty),
                                ValueOf(el), IsSecret(el));
                            /* The same control reported twice - a wrapper and its label with one name and
                             * one rectangle - is one thing to a reader. */
                            if (!seen.Add(line)) continue;
                            if (lines.Count >= 40 || budget - line.Length < 0) { skipped++; continue; }
                            budget -= line.Length + 1;
                            lines.Add(line);
                        }
                        catch { skipped++; }
                    }
                    if (lines.Count == 0)
                    {
                        Say("that window names nothing readable - normal for an Electron application, a "
                            + "canvas, or a window running as administrator. The screenshot is what there is");
                        return null;
                    }
                    /* The window's own name out of the tree rather than a second GetWindowText round trip:
                     * the element is already here and has already answered once. */
                    string where = null;
                    try { where = root.Current.Name; } catch { where = null; }
                    string said = lines.Count.ToString(CultureInfo.InvariantCulture) + " named things on \""
                        + Clip(string.IsNullOrEmpty(where) ? "that window" : where, 60)
                        + "\", positions in screenshot pixels: " + string.Join("; ", lines.ToArray());
                    if (skipped > 0)
                    {
                        said += ". " + skipped.ToString(CultureInfo.InvariantCulture)
                            + " more were left out for room - ask for a narrower window, or use find with a "
                            + "name if you know what you are looking for";
                    }
                    Say(said);
                    return null;
                }
            }
            return problem == null ? "could not read that window" : problem;
        }

        /* WHERE ONE NAMED THING IS - the answer to "is it there, and where".
         *
         * Exact name first, because it is one server-side call and it is what a model that has just read the
         * window will pass back. Then a case-insensitive contains over the same filtered list, because a
         * person types "About" for a menu item called "About...". Ambiguity is REPORTED rather than resolved:
         * two controls with the same name is a fact the model needs, and picking one silently is how a click
         * lands on the wrong row. */
        /* КОГО НАЗЫВАЮТ ЭТИМ ИМЕНЕМ - одним разрешением на всех, кто спрашивает.
         *
         * Вынесено из FindElement, когда появился clickname, и вынесено ЦЕЛИКОМ, а не переписано: «есть ли
         * такое имя на окне» и «нажми по этому имени» не имеют права разойтись в том, что нашли. Ровно та
         * же причина, по которой ScrollTo зовёт FindElement, а не повторяет его правило: два ответа на один
         * вопрос расходятся молча, и расхождение видно только по клику не туда.
         *
         * Порядок тот же и он не случаен: точное имя одним серверным вызовом - это то, что передаст обратно
         * модель, только что прочитавшая окно; потом регистронезависимая часть имени по тому же
         * отфильтрованному списку, потому что человек пишет "About" про пункт меню "About...".
         *
         * НЕОДНОЗНАЧНОСТЬ ЗДЕСЬ НЕ РЕШАЕТСЯ. Список отдаётся целиком, и что с ним делать - дело
         * вызывающего: find про два совпадения рассказывает, clickname отказывается нажимать. Выбрать
         * первый молча - это клик по чужой строке, отчитавшийся успехом.
         *
         * Отсечка по Usable - ЗДЕСЬ, а не у каждого читателя: элемент шириной в пиксель нельзя ни описать,
         * ни нажать, а посчитанный совпадением он превращает «нашёл одно» в «подходит два». */
        static List<AutomationElement> NamedHits(Dictionary<string, string> a, string wanted,
            out string problem)
        {
            /* No window title here on purpose - see WindowToRead. `find` looks at whatever is in front, or
             * in the process it was given, and spends its one free-text field on the name. */
            IntPtr hwnd;
            AutomationElement root = WindowToRead("", Get(a, "process", ""), out hwnd, out problem);
            if (root == null)
            {
                if (problem == null) problem = "could not read that window";
                return null;
            }

            AutomationElementCollection exact = Search(root, hwnd,
                new AndCondition(new PropertyCondition(AutomationElement.NameProperty, wanted),
                    new PropertyCondition(AutomationElement.IsOffscreenProperty, false)),
                4000, out problem);
            List<AutomationElement> hits = new List<AutomationElement>();
            if (exact != null)
            {
                foreach (AutomationElement el in exact) hits.Add(el);
            }

            if (hits.Count == 0)
            {
                AutomationElementCollection all = Search(root, hwnd, NamedAndVisible(), 4000, out problem);
                if (all == null)
                {
                    if (problem == null) problem = "could not read that window";
                    return null;
                }
                string low = wanted.ToLowerInvariant();
                foreach (AutomationElement el in all)
                {
                    try
                    {
                        string name = (string)el.GetCachedPropertyValue(AutomationElement.NameProperty);
                        if (name != null && name.ToLowerInvariant().IndexOf(low, StringComparison.Ordinal) >= 0)
                        {
                            hits.Add(el);
                        }
                    }
                    catch { }
                }
            }

            List<AutomationElement> usable = new List<AutomationElement>();
            foreach (AutomationElement el in hits)
            {
                try
                {
                    System.Windows.Rect box = (System.Windows.Rect)el.GetCachedPropertyValue(
                        AutomationElement.BoundingRectangleProperty);
                    if (Usable(box)) usable.Add(el);
                }
                catch { }
            }
            /* Обнулено НАРОЧНО: Search мог оставить здесь жалобу на первый, точный проход, после которого
             * второй прошёл успешно. Вернуть список И проблему значит дать вызывающему выбирать, что из
             * этого правда. */
            problem = null;
            return usable;
        }

        /* Где на окне то, что называется этим именем - и ничего больше: find ТОЛЬКО СМОТРИТ. */
        static string FindElement(Dictionary<string, string> a)
        {
            ReadGeometry(a);
            string wanted = Get(a, "title", "").Trim();
            if (wanted.Length == 0) return "find needs a name to look for";

            string problem;
            List<AutomationElement> hits = NamedHits(a, wanted, out problem);
            if (hits == null) return problem == null ? "could not read that window" : problem;

            List<string> said = new List<string>();
            foreach (AutomationElement el in hits)
            {
                try
                {
                    System.Windows.Rect box = (System.Windows.Rect)el.GetCachedPropertyValue(
                        AutomationElement.BoundingRectangleProperty);
                    int cx = ToShotX(box.X + box.Width / 2);
                    int cy = ToShotY(box.Y + box.Height / 2);
                    said.Add(Line(
                            (string)el.GetCachedPropertyValue(AutomationElement.LocalizedControlTypeProperty),
                            (string)el.GetCachedPropertyValue(AutomationElement.NameProperty),
                            box,
                            (bool)el.GetCachedPropertyValue(AutomationElement.IsEnabledProperty),
                            ValueOf(el), IsSecret(el))
                        + ", centre " + cx.ToString(CultureInfo.InvariantCulture) + ","
                        + cy.ToString(CultureInfo.InvariantCulture));
                    if (said.Count >= 6) break;
                }
                catch { }
            }

            if (said.Count == 0)
            {
                Say("nothing on that window is called \"" + Clip(wanted, 60) + "\". Read the window to see "
                    + "what it does call things, or look at the screenshot - it may not be there at all");
                return null;
            }
            if (said.Count == 1)
            {
                Say("found " + said[0] + " - click the centre");
                return null;
            }
            Say(said.Count.ToString(CultureInfo.InvariantCulture) + " things match \"" + Clip(wanted, 60)
                + "\", so the name alone does not say which: " + string.Join("; ", said.ToArray())
                + ". Pick by position, or use a longer name");
            return null;
        }

        /* ЖЕСТ КЛИКА - ОДНОЙ РЕАЛИЗАЦИЕЙ, потому что нажимать умеют два вызывающих.
         *
         * Раньше это тело лежало внутри ветки `action == "click"`, и когда появился clickname, выбор был:
         * скопировать двенадцать строк или вынести их. Копия разошлась бы - и разошлась бы именно в
         * мелочах, которые тут все выстраданы: движение перед нажатием, пауза, чтобы оно долетело,
         * модификатор на нажатии и НЕ на движении, и повторное нажатие с тем же модификатором у
         * двойного клика. Разошедшуюся копию видно только по тому, что один из двух путей делает не тот
         * жест, о котором отчитался. */
        static string ClickAt(int x, int y, string button, bool twice, string mods)
        {
            string down = button == "right" ? "Right Click Down" : (button == "middle" ? "Middle Click Down" : "Left Click Down");
            string up = button == "right" ? "Right Click Release" : (button == "middle" ? "Middle Click Release" : "Left Click Release");

            /* Moved first and given a moment to land. Clicking at a position the pointer has not
               reached yet is how a click ends up on whatever was under the old position.
               The MOVE carries no modifier: a hover under Shift is not a thing anyone asks for, and
               holding it across the settle only widens the window in which it is held for the whole
               machine. */
            Emit(At(x, y, "Mouse Movement"));
            Thread.Sleep(40);
            Emit(At(x, y, down, mods));
            Thread.Sleep(30);
            Emit(At(x, y, up));
            if (twice)
            {
                Thread.Sleep(60);
                /* The SECOND press needs it too. Emit lets go at a release, which is right for a
                   gesture and means the second half of a double-click starts from nothing held. Miss
                   this and a Shift-double-click is a Shift-click followed by a plain one - two
                   different things, and the second would deselect what the first selected. */
                Emit(At(x, y, down, mods));
                Thread.Sleep(30);
                Emit(At(x, y, up));
            }
            return null;
        }

        /* НАЖАТЬ ПО ИМЕНИ - один ход вместо двух, и это самая дорогая экономия во всём цикле.
         *
         * Модель, чтобы нажать кнопку, ходит дважды: find отвечает координатой, и ответ приезжает только со
         * следующим снимком, потом click бьёт в эту координату. Ход стоит 5,035 мс медианой - измерено на
         * девяноста днях прогонов, - а всё, что делает эта функция, около 30 мс. Тринадцать ходов в
         * успешном прогоне, и треть из них на формах - это они.
         *
         * ЧЕМ ЭТО ОТЛИЧАЕТСЯ ОТ `name=` НА КЛИКЕ ПО КООРДИНАТЕ. Там имя - подсказка: точка ведущая, а имя
         * лишь сдвигает прицел, если под точкой оказалось другое (см. Retarget). Здесь точки нет вовсе, и
         * разница видна в отказе: клик с ненайденным name всё равно нажмёт, где сказано, а это
         * НЕ НАЖМЁТ НИЧЕГО и скажет почему.
         *
         * И ТРИ ОТКАЗА ВМЕСТО НАЖАТИЯ, каждый - ради того, чтобы не отчитаться успехом о ненажатом:
         * имени нет на окне; подходит несколько - тогда имя не говорит, какое из них, и выбрать за модель
         * значит нажать по чужой строке; найденное выключено - нажатие по выключенному не делает ничего, а
         * "done" про него это ложное зелёное, ровно то, чего этот код не делает нигде.
         *
         * Центр прямоугольника, а не TryGetClickablePoint: find говорит модели "click the centre", и две
         * функции, разошедшиеся в том, ЧТО такое центр найденного, - это find, показавший одну точку, и
         * clickname, нажавший другую. */
        static string ClickNamed(Dictionary<string, string> a)
        {
            ReadGeometry(a);
            string wanted = Get(a, "title", "").Trim();
            if (wanted.Length == 0) return "clickname needs a name to click";

            string problem;
            List<AutomationElement> hits = NamedHits(a, wanted, out problem);
            if (hits == null) return problem == null ? "could not read that window" : problem;

            if (hits.Count == 0)
            {
                return "nothing on that window is called \"" + Clip(wanted, 60) + "\", so nothing was "
                    + "clicked. Read the window to see what it does call things, or look at the screenshot - "
                    + "it may not be there at all";
            }

            if (hits.Count > 1)
            {
                /* Перечислено, а не просто посчитано: модели нужно, ПО ЧЕМУ выбирать - по положению или по
                 * более длинному имени, - и тот же список ей отдаёт find. Та же отсечка на шести. */
                List<string> said = new List<string>();
                foreach (AutomationElement el in hits)
                {
                    try
                    {
                        System.Windows.Rect box = (System.Windows.Rect)el.GetCachedPropertyValue(
                            AutomationElement.BoundingRectangleProperty);
                        said.Add(Line(
                            (string)el.GetCachedPropertyValue(AutomationElement.LocalizedControlTypeProperty),
                            (string)el.GetCachedPropertyValue(AutomationElement.NameProperty),
                            box,
                            (bool)el.GetCachedPropertyValue(AutomationElement.IsEnabledProperty),
                            ValueOf(el), IsSecret(el))
                            + ", centre " + ToShotX(box.X + box.Width / 2).ToString(CultureInfo.InvariantCulture)
                            + "," + ToShotY(box.Y + box.Height / 2).ToString(CultureInfo.InvariantCulture));
                        if (said.Count >= 6) break;
                    }
                    catch { }
                }
                /* НИ ОДНОГО НЕ УДАЛОСЬ ОПИСАТЬ - и тогда сказать «0 подходит» было бы неправдой о том,
                 * что нашлось. Элементы прошли через NamedHits, то есть прямоугольник у них читался; если
                 * второе чтение отказало, значит экран поехал под руками, и это ровно то, о чём и надо
                 * сказать. Отсутствие описания - не отсутствие совпадений. */
                if (said.Count == 0)
                {
                    return hits.Count.ToString(CultureInfo.InvariantCulture) + " things are called \""
                        + Clip(wanted, 60) + "\" but none of them would say where it is - the screen moved "
                        + "while it was being read. Nothing was clicked; look again";
                }
                return said.Count.ToString(CultureInfo.InvariantCulture) + " things match \""
                    + Clip(wanted, 60) + "\", so the name alone does not say which to click and NOTHING was "
                    + "clicked: " + string.Join("; ", said.ToArray())
                    + ". Click one of those centres, or use a longer name";
            }

            AutomationElement one = hits[0];
            System.Windows.Rect found;
            string kind;
            string name;
            bool enabled;
            try
            {
                found = (System.Windows.Rect)one.GetCachedPropertyValue(
                    AutomationElement.BoundingRectangleProperty);
                kind = (string)one.GetCachedPropertyValue(AutomationElement.LocalizedControlTypeProperty);
                name = (string)one.GetCachedPropertyValue(AutomationElement.NameProperty);
                enabled = (bool)one.GetCachedPropertyValue(AutomationElement.IsEnabledProperty);
            }
            catch (Exception e)
            {
                return "found \"" + Clip(wanted, 60) + "\" but could not read where it is: " + e.Message;
            }

            if (!enabled)
            {
                return (string.IsNullOrEmpty(kind) ? "what is called" : kind + " \"" + Clip(name, 60) + "\"")
                    + " is DISABLED, so nothing was clicked - clicking it would have done nothing and "
                    + "reported success. Something else has to happen first";
            }

            int cx = (int)Math.Round(found.X + found.Width / 2);
            int cy = (int)Math.Round(found.Y + found.Height / 2);

            /* ТА ЖЕ ПРОВЕРКА ГРАНИЦ, что у координатного пути, и по той же причине: Windows не отказывает
             * в точке за краем стола, она ПРИЖИМАЕТ её к краю - то есть кривой прямоугольник от чужого
             * провайдера стал бы кликом по углу экрана. Здесь это ещё менее ожидаемо, чем там: точку никто
             * не называл. */
            int vx = Native.GetSystemMetrics(Native.SM_XVIRTUALSCREEN);
            int vy = Native.GetSystemMetrics(Native.SM_YVIRTUALSCREEN);
            int vw = Native.GetSystemMetrics(Native.SM_CXVIRTUALSCREEN);
            int vh = Native.GetSystemMetrics(Native.SM_CYVIRTUALSCREEN);
            if (cx < vx || cy < vy || cx >= vx + vw || cy >= vy + vh)
            {
                return "\"" + Clip(wanted, 60) + "\" says it is at "
                    + cx.ToString(CultureInfo.InvariantCulture) + ","
                    + cy.ToString(CultureInfo.InvariantCulture)
                    + ", which is off the screen, so nothing was clicked";
            }

            /* И НАШЕ СОБСТВЕННОЕ ОКНО - отказом, как на всяком другом пути. Имя ищется на окне впереди, а
             * впереди вполне может стоять MouseFlow. */
            string mine = Mine(Native.WindowFromPoint(new POINT { X = cx, Y = cy }));
            if (mine != null) return mine;

            string failed = ClickAt(cx, cy, Get(a, "button", "left"), Get(a, "double", "0") == "1",
                AskedMods(a));
            if (failed != null) return failed;

            /* КУДА нажали - в пикселях снимка, теми же тремя числами наружу, какими они приехали внутрь.
             * Модель после этого знает, где на экране оказалась цель, и следующий ход может целиться сам. */
            Say("clicked " + (string.IsNullOrEmpty(kind) ? "" : kind + " ") + "\"" + Clip(name, 60)
                + "\" at " + ToShotX(found.X + found.Width / 2).ToString(CultureInfo.InvariantCulture) + ","
                + ToShotY(found.Y + found.Height / 2).ToString(CultureInfo.InvariantCulture));
            return null;
        }

        /* SCROLLING UNTIL SOMETHING IS TRUE, in one action instead of one model turn per wheel burst.
         *
         * `to=end` and `to=start` stop when the screen stops changing - which is what reaching the end of a
         * list looks like from outside. Any other value is a NAME, and the loop stops when that name is
         * there. Both are capped, and the cap is reported: a scroll that gave up after forty bursts is a
         * different fact from a scroll that arrived, and a model told only "done" would believe it arrived.
         *
         * Why this is an action and not composition: composing it costs a model turn per burst, measured at
         * eight to fifty seconds each in a watched run, against about 25ms for a burst here. */
        static string ScrollTo(Dictionary<string, string> a)
        {
            ReadGeometry(a);
            string to = Get(a, "to", "").Trim();
            if (to.Length == 0) return "scrollto needs to=end, to=start, or a name to scroll to";
            bool up = string.Equals(to, "start", StringComparison.OrdinalIgnoreCase);
            bool toEdge = up || string.Equals(to, "end", StringComparison.OrdinalIgnoreCase);

            /* Initialised for the same reason the capture region is: `&&` short-circuits, so the compiler
             * cannot see that a false chain means the window centre is used instead. */
            int x = 0, y = 0;
            bool havePoint =
                int.TryParse(Get(a, "x", ""), NumberStyles.Integer, CultureInfo.InvariantCulture, out x)
                && int.TryParse(Get(a, "y", ""), NumberStyles.Integer, CultureInfo.InvariantCulture, out y);
            if (!havePoint)
            {
                IntPtr front = Native.GetForegroundWindow();
                RECT box;
                if (front == IntPtr.Zero || !Native.GetWindowRect(front, out box))
                {
                    return "scrollto needs x and y - where to put the pointer before scrolling";
                }
                x = (box.Left + box.Right) / 2;
                y = (box.Top + box.Bottom) / 2;
            }
            string mine = Mine(Native.WindowFromPoint(new POINT { X = x, Y = y }));
            if (mine != null) return mine;

            const int Bursts = 40;
            int did = 0;
            int still = 0;
            for (int burst = 0; burst < Bursts; burst++)
            {
                if (!toEdge)
                {
                    Dictionary<string, string> look = new Dictionary<string, string>(a);
                    look["title"] = to;
                    /* Reusing find, not reimplementing it: the same exact-then-contains rule, so "scroll to
                     * it" and "is it there" can never disagree about whether it is there. */
                    string missing = FindElement(look);
                    string answer = TakeOutput();
                    if (missing == null && answer != null && !answer.StartsWith("nothing on that window"))
                    {
                        Say("scrolled " + did.ToString(CultureInfo.InvariantCulture) + " times and "
                            + answer);
                        return null;
                    }
                }

                byte[] before = null;
                try { before = Grid(); } catch { before = null; }

                Emit(At(x, y, "Mouse Movement"));
                for (int notch = 0; notch < 3; notch++)
                {
                    Emit(At(x, y, up ? "Scroll Up" : "Scroll Down"));
                    Thread.Sleep(25);
                }
                did++;

                byte[] after = null;
                try { after = Grid(); } catch { after = null; }
                if (before != null && after != null && GridQuiet(before, after))
                {
                    still++;
                    /* Twice, not once: a list that redraws a moment late looks still for one comparison. */
                    if (still >= 2) break;
                }
                else still = 0;
            }

            if (toEdge)
            {
                Say("scrolled " + (up ? "up" : "down") + " " + did.ToString(CultureInfo.InvariantCulture)
                    + " times" + (still >= 2
                        ? " and the screen stopped changing, which is what the " + (up ? "start" : "end")
                            + " looks like"
                        : ", which is as far as one scrollto goes - call it again if there is more"));
                return null;
            }
            Say("scrolled " + did.ToString(CultureInfo.InvariantCulture) + " times and \"" + Clip(to, 60)
                + "\" still is not there. It may be somewhere else, or named something else - read the window");
            return null;
        }

        /* ---------------------------------------------------------------- 0.12.0: waiting for one thing

           A QUIET SCREEN, measured here rather than by asking the model to look again. The same fingerprint
           and the same threshold the courier's wait uses - see GridMoved - because two answers to "has this
           settled" would settle differently. Returns how long it waited, so a caller can say whether it
           arrived or ran out. */
        static bool SettleHere(int limitMs, out int waited)
        {
            DateTime started = DateTime.UtcNow;
            byte[] last = null;
            int still = 0;
            waited = 0;
            while (true)
            {
                waited = (int)(DateTime.UtcNow - started).TotalMilliseconds;
                if (waited >= limitMs) return false;
                byte[] now = null;
                try { now = Grid(); } catch { now = null; }
                if (last != null && now != null && GridQuiet(last, now))
                {
                    /* Two still frames, not one: a page that redraws a moment late looks settled once. */
                    if (++still >= 2) return true;
                }
                else still = 0;
                last = now;
                Thread.Sleep(400);
            }
        }

        /* RELOAD, and the point is the waiting rather than the keystroke.
         *
         * F5 has always been available through press_key, so this is not a new capability - it is three
         * model turns collapsed into one: bring the window forward, press the key, wait for it to finish.
         * Each of those turns cost eight to fifty seconds in a watched run, against about a second here. */
        static string Refresh(Dictionary<string, string> a)
        {
            string title = Get(a, "title", "");
            string process = Get(a, "process", "");
            if (title.Length > 0 || process.Length > 0)
            {
                IntPtr wanted = WindowMatching(title, process);
                if (wanted == IntPtr.Zero)
                {
                    return "no open window matches "
                        + (title.Length > 0 ? "title \"" + title + "\"" : "process " + process);
                }
                string mine = Mine(wanted);
                if (mine != null) return mine;
                string failed = Activate(title, process);
                if (failed != null) return failed;
                Thread.Sleep(250);
            }
            else
            {
                string mine = Mine(Native.GetForegroundWindow());
                if (mine != null) return mine;
            }

            string refused = PressKey("f5", false, false, false, false);
            if (refused != null) return refused;

            int waited;
            bool quiet = SettleHere(20000, out waited);
            Say("pressed F5 and waited " + (waited / 1000.0).ToString("0.0", CultureInfo.InvariantCulture)
                + "s" + (quiet
                    ? " - the screen has stopped changing"
                    : ", and it is still changing. Look, and wait again if it is not ready"));
            return null;
        }

        /* WAITING FOR A WINDOW rather than for the screen, which is a different question and the one that
           actually gets asked: "has the Save dialog appeared", "has the splash gone".
         *
         * The alternative was the choreography the failed run had to invent - sleep twenty seconds and hope
         * something has happened by then - and a fixed sleep is both too long when it works and too short
         * when it does not. */
        static string WaitForWindow(Dictionary<string, string> a)
        {
            string title = Get(a, "title", "");
            string process = Get(a, "process", "");
            if (title.Length == 0 && process.Length == 0) return "waitwindow needs a title or a process";
            bool wantGone = Get(a, "until", "appears").Trim().ToLowerInvariant() == "disappears";

            int limitMs;
            if (!int.TryParse(Get(a, "ms", "20000"), NumberStyles.Integer, CultureInfo.InvariantCulture, out limitMs))
            {
                limitMs = 20000;
            }
            if (limitMs < 500) limitMs = 500;
            if (limitMs > 120000) limitMs = 120000;

            DateTime started = DateTime.UtcNow;
            while (true)
            {
                bool there = WindowMatching(title, process) != IntPtr.Zero;
                int waited = (int)(DateTime.UtcNow - started).TotalMilliseconds;
                if (there != wantGone)
                {
                    Say((wantGone ? "it was gone" : "it appeared") + " after "
                        + (waited / 1000.0).ToString("0.0", CultureInfo.InvariantCulture) + "s");
                    return null;
                }
                if (waited >= limitMs)
                {
                    /* NOT an error: "it did not appear" is an answer about the world, and a model told this
                     * failed would look for a fault in the waiting rather than in the expectation. */
                    Say("waited " + (waited / 1000.0).ToString("0.0", CultureInfo.InvariantCulture)
                        + "s and it " + (wantGone ? "is still there" : "has not appeared")
                        + ". The window list under the screenshot is what is actually open");
                    return null;
                }
                Thread.Sleep(250);
            }
        }

        /* PRESS, MOVE, RELEASE - which could not be composed from what existed, because click sends the
           press and the release together and nothing sent one without the other.
         *
         * Interpolated rather than jumped: an application that reads the drag decides what is happening from
         * the moves in between, and a press followed by a release somewhere else is not a drag to a list
         * that wants to see the row travel. Twelve steps is enough for that and short enough not to be a
         * performance. */
        static string Drag(int x1, int y1, int x2, int y2) { return Drag(x1, y1, x2, y2, null); }

        static string Drag(int x1, int y1, int x2, int y2, string mods)
        {
            Emit(At(x1, y1, "Mouse Movement"));
            Thread.Sleep(40);
            /* ONLY THE PRESS carries it, and the release is what lets go - so the modifier is held across
               every movement in between. That is the difference between an Alt-drag (copy) and an Alt-press
               followed by an ordinary drag (move), and it is decided here by NOT repeating the value on the
               movements rather than by any code that reads it. */
            Emit(At(x1, y1, "Left Click Down", mods));
            Thread.Sleep(80);
            const int Steps = 12;
            for (int i = 1; i <= Steps; i++)
            {
                int ix = x1 + (int)Math.Round((x2 - x1) * (double)i / Steps);
                int iy = y1 + (int)Math.Round((y2 - y1) * (double)i / Steps);
                Emit(At(ix, iy, "Mouse Movement"));
                Thread.Sleep(16);
            }
            Thread.Sleep(80);
            Emit(At(x2, y2, "Left Click Release"));
            return null;
        }

        /* http and https ONLY, and that is the whole security story of this action: it hands a URL to
           whatever the machine has registered for the web, which is a browser. A scheme is a choice of
           PROGRAM - file:, ms-settings:, and anything an installed application registered - so accepting
           any scheme would make this "run something", and there is a separate action for that with its own
           narrowing. Origin and path are kept as given; a query string is a legitimate part of a link here,
           unlike in a recording, because nothing is being stored. */
        static string OpenUrl(string url)
        {
            Uri parsed;
            if (!Uri.TryCreate(url, UriKind.Absolute, out parsed))
            {
                return "that is not a full URL - it needs the scheme, as in https://docs.new";
            }
            if (parsed.Scheme != Uri.UriSchemeHttp && parsed.Scheme != Uri.UriSchemeHttps)
            {
                return "only http and https can be opened this way, and that is " + parsed.Scheme
                    + ": - a scheme chooses which program handles it, which is a different question";
            }
            try
            {
                Process.Start(new ProcessStartInfo(parsed.AbsoluteUri) { UseShellExecute = true });
                Say("opened " + parsed.AbsoluteUri + " in the default browser - it may take a moment to appear");
                return null;
            }
            catch (Exception e) { return "could not open that link: " + e.Message; }
        }

        /* A NAME, NEVER A COMMAND LINE, and the distinction is the entire point of the shape.
         *
         * Arguments are what turn "open an application" into "run this": `powershell -EncodedCommand ...` is
         * a name plus arguments, and refusing the arguments refuses that whole class without keeping a list
         * of dangerous program names - a list which is wrong the moment somebody installs something not on
         * it. Paths are refused for the same reason: a path is how you name a program that is not on PATH,
         * including one just written to disk.
         *
         * WHAT THIS IS NOT is a security boundary, and pretending otherwise would be the dishonest part.
         * The model can already open a terminal by clicking one and type into it - that is what happened in
         * the run this wave came from. What actually holds the line is the prompt's boundaries, the user
         * watching, and the refusal above to touch the agent's own window. This action is here so the model
         * does not have to improvise, and it is narrow so that improvising through it is no easier than
         * improvising without it.
         */
        static string OpenApp(string app)
        {
            string name = app.Trim();
            if (name.Length == 0 || name.Length > 80) return "an application name, up to 80 characters";
            if (name.IndexOfAny(new char[] { '\\', '/', ':', '"', '\'', '|', '&', '<', '>', '%', '^' }) >= 0)
            {
                return "a NAME, not a path or a command line - \"notepad\", \"excel\", \"Google Chrome\". "
                    + "For a web page use open_url instead";
            }
            /* A space is legitimate in a name ("Google Chrome") and is also how arguments are written, so the
             * two cannot be told apart by looking. A leading dash on any word is what an argument looks
             * like, and that is refusable without refusing names. */
            foreach (string word in name.Split(' '))
            {
                if (word.StartsWith("-") || word.StartsWith("+"))
                {
                    return "that looks like a command line rather than a name - this action opens an "
                        + "application and cannot pass it arguments";
                }
            }
            try
            {
                Process.Start(new ProcessStartInfo(name) { UseShellExecute = true });
                Say("asked Windows to open " + name + " - it may take a few seconds to appear, and a fresh "
                    + "screenshot is how to tell whether it did");
                return null;
            }
            catch (Exception e)
            {
                return "Windows would not open \"" + name + "\": " + e.Message
                    + " - if it is already running, activate_window is the way to it";
            }
        }

        static Dictionary<string, string> ParseFields(string body)
        {
            /* key=value pairs, and `text` takes the rest of the line - so typed text may contain
               spaces and equals signs without needing a quoting rule nobody would remember. */
            Dictionary<string, string> found = new Dictionary<string, string>();
            if (body == null) return found;
            string line = body.Replace("\r", " ").Replace("\n", " ").Trim();

            /* `text`, `title` and `app` all run to the end of the line: a message, a window title and an
             * application name, and all three contain spaces - "Google Chrome" is a name, not a name plus
             * an argument. Taken at a TOKEN boundary only - a caption containing "subtitle=" or
             * "action=click" is then just characters in a title rather than a field that overrides the
             * action. Whichever marker comes first wins the rest of the line, so no two can both claim it. */
            int rest = -1;
            string restKey = null;
            foreach (string marker in new string[] { "text=", "title=", "app=" })
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
                if (key == "text" || key == "title" || key == "app") continue;   // already taken, whole and unsplit
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

            /* Набор обязан быть набором. Юникодный ввод ниже модификаторов и не читает - в отличие от macOS,
               где залипший Command превращал каждую букву в аккорд, - но зажатый Ctrl всё равно меняет то,
               как приложение поймёт то, что придёт следом, и это единственное место, где его дёшево снять
               перед длинным вводом. */
            ReleaseModifiers();

            /* Sent as Unicode rather than as virtual keys: a keycode depends on the keyboard layout,
               and text typed through them comes out wrong on any layout but the author's. */
            for (int i = 0; i < text.Length; i++)
            {
                char c = text[i];
                if (c == '\r') continue;                 // CRLF is one break, not two
                if (c == '\n')
                {
                    PressKey("Enter", false, shiftNewline, false, false);
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

        /* What the keyboard layout itself requires to produce this character - and NOT for a letter or a
           digit, which VkFor now resolves as a keycode. Left in for `%`, which is Shift+5 on one layout and
           a different key on another.

           Skipping letters here is not tidiness: for `A` the layout would add Shift, so `press_key key=A`
           with ctrl set would send Ctrl+Shift+A - a different shortcut from the one that was asked for. */
        static void ModifiersFor(string key, ref bool ctrl, ref bool shift, ref bool alt)
        {
            if (key == null || key.Length != 1) return;
            char one = key[0];
            if ((one >= 'a' && one <= 'z') || (one >= 'A' && one <= 'Z') || (one >= '0' && one <= '9')) return;
            short scan = Native.VkKeyScan(key[0]);
            if (scan == -1) return;
            int state = (scan >> 8) & 0xFF;
            if ((state & 1) != 0) shift = true;
            if ((state & 2) != 0) ctrl = true;
            if ((state & 4) != 0) alt = true;
        }

        /* WIN IS A MODIFIER NOW, and that was the gap: `win` has been in the table as a KEY since 0.7.0,
           but with only ctrl/shift/alt to hold down there was no way to express Win+Shift+S. A watched run
           tried Alt+PrintScreen, then Alt+Snapshot, then gave up and pressed Shift+S - which typed a capital
           S into somebody's dialog and taught nobody anything.
         *
         * Worth having even though capture_window is the better route to a screenshot: Win+D, Win+E, Win+L
         * and Win+arrow are how people actually drive the shell, and none of them was reachable. */
        /* ОТПУСТИТЬ ВСЁ, ЧТО ЗАЖАТО НЕ НАМИ, и это половина, которой на этой стороне не было.
         *
         * Половина аварии, найденной на macOS, здесь невозможна по устройству: у клавиатурного SendInput нет
         * поля флагов вовсе - модификатор на Windows и ЕСТЬ глобальное состояние клавиш, - так что событию
         * нечего наследовать и нечего штамповать. А PressKey и так жмёт и отпускает каждый модификатор
         * настоящей виртуальной клавишей.
         *
         * Но ВТОРОЙ половины не было совсем: ничего не снимало модификатор, залипший ЧУЖИМ приложением,
         * зависшей физической клавишей или прошлым запуском агента, умершим посреди аккорда. А последствия
         * те же самые, и одно из них - про обещание, а не про точность: рекордер строит префикс `Ctrl+`
         * по GetAsyncKeyState, и буква называется только под командным аккордом. При залипшем Ctrl КАЖДОЕ
         * нажатие человека читается как аккорд, и буква НАЗЫВАЕТСЯ - ровно то, что произошло бы на маке.
         *
         * Обе стороны у каждого модификатора: 0xA0-0xA5 - это левые и правые Shift, Ctrl и Alt, и общий
         * 0x10/0x11/0x12 их не различает. Отпускается то, что действительно зажато, и ничего больше. */
        static readonly int[] ModifierKeys = new int[] {
            0x10, 0xA0, 0xA1,     // Shift, левый, правый
            0x11, 0xA2, 0xA3,     // Ctrl,  левый, правый
            0x12, 0xA4, 0xA5,     // Alt,   левый, правый
            0x5B, 0x5C,           // Win,   левый, правый
        };

        public static void ReleaseModifiers()
        {
            foreach (int vk in ModifierKeys)
            {
                try
                {
                    if ((Native.GetAsyncKeyState(vk) & 0x8000) != 0) SendVk((ushort)vk, true);
                }
                catch { /* уборка не должна ронять то, ради чего её позвали */ }
            }
        }

        static string PressKey(string key, bool ctrl, bool shift, bool alt, bool win)
        {
            ushort vk = VkFor(key);
            if (vk == 0) return "unknown key: " + key;
            ModifiersFor(key, ref ctrl, ref shift, ref alt);

            /* Чужое - до того, как строить своё: модификатор, залипший не нами, не снимается ниже и при этом
               ДОБАВЛЯЕТСЯ к тому, о чём просили. Ctrl+R под залипшим Shift - это Ctrl+Shift+R, другая
               команда, и PressKey отчиталась бы об успехе. */
            ReleaseModifiers();

            /* Win outermost, released last, and that order is not arbitrary: the shell watches for the Win
             * key going down and up with nothing between it, and a release order that lets go of Win first
             * can leave the Start menu open on top of whatever the chord was meant to do. */
            /* try/finally, потому что между нажатием и отпусканием стоит Thread.Sleep(25): прерывание,
               брошенное в это окно, оставило бы модификатор зажатым - на Windows это ГЛОБАЛЬНОЕ состояние
               клавиши, а не флаг на событии, так что зажатым он остался бы для всей машины. */
            try
            {
                if (win) SendVk(0x5B, false);
                if (ctrl) SendVk(0x11, false);
                if (shift) SendVk(0x10, false);
                if (alt) SendVk(0x12, false);
                SendVk(vk, false);
                Thread.Sleep(25);
                SendVk(vk, true);
            }
            finally
            {
                if (alt) SendVk(0x12, true);
                if (shift) SendVk(0x10, true);
                if (ctrl) SendVk(0x11, true);
                if (win) SendVk(0x5B, true);
            }
            return null;
        }

        static ushort VkFor(string key)
        {
            if (key == null || key.Length == 0) return 0;
            /* A LETTER OR A DIGIT IS ITS OWN KEYCODE, and asking the layout for one was a bug with teeth.
             *
             * The comment that used to be here had the principle exactly right - "a shortcut IS a keycode:
             * Ctrl+C is Ctrl plus VK_C, not Ctrl plus the letter c" - and then called VkKeyScan, which
             * answers FOR THE CURRENT KEYBOARD LAYOUT. Measured on this machine with a Russian layout
             * active, which is one of three installed:
             *
             *   'a' -> -1    'A' -> -1    'c' -> -1    'v' -> -1    's' -> -1    'z' -> -1
             *   '1' -> 0x31  '%' -> 0x35
             *
             * There is no key on a Russian layout that produces a Latin 'v', so VkKeyScan refuses, and
             * PressKey turned that into "unknown key: v". Which means that whenever a non-Latin layout was
             * active, EVERY letter shortcut on the machine was refused - Ctrl+A, Ctrl+C, Ctrl+V, Ctrl+S,
             * Ctrl+Z. Typing was unaffected, because TypeText sends unicode scan codes and never consults a
             * layout, so the failure looked intermittent and specific to shortcuts. A watched run spent
             * dozens of steps deleting a title one Backspace at a time because Ctrl+A would not work.
             *
             * VK_A..VK_Z are 0x41..0x5A and VK_0..VK_9 are 0x30..0x39 on every layout, because that is what
             * a virtual key IS. Case is irrelevant to the keycode; whether Shift is held is the caller's
             * business and is passed separately.
             *
             * VkKeyScan is still right for everything else. `%` and `/` genuinely differ by layout, and the
             * layout is the only thing that knows which key and which modifiers produce them. */
            if (key.Length == 1)
            {
                char one = key[0];
                if (one >= 'a' && one <= 'z') return (ushort)(one - 'a' + 0x41);
                if (one >= 'A' && one <= 'Z') return (ushort)(one - 'A' + 0x41);
                if (one >= '0' && one <= '9') return (ushort)(one - '0' + 0x30);

                short scan = Native.VkKeyScan(one);
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
                /* F7 TO F10 WERE MISSING, while the tool description promised "F1-F12" - so the model paid
                 * a step to discover each one that did not exist. Wave 01 made the description honest;
                 * this makes the description unnecessary. */
                case "f7": return 0x76;
                case "f8": return 0x77;
                case "f9": return 0x78;
                case "f10": return 0x79;
                case "f11": return 0x7A;
                case "f12": return 0x7B;
                /* VK_SNAPSHOT. Both spellings, because "PrintScreen" is what a person calls it and
                 * "Snapshot" is what Windows calls it, and a run tried both. */
                case "printscreen": case "prtsc": case "snapshot": return 0x2C;
                case "insert": case "ins": return 0x2D;
                case "menu": case "contextmenu": return 0x5D;
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

        /* ONE FINGERPRINT, TWO QUESTIONS - and they want opposite biases. The long version of this, with the
           measurements, is beside gridStirred in api/_brain.mjs; the numbers here must match those.

           "Did anything happen?" is asked after an action and a wrong NO ends runs - six in a row stops the
           run. "Has it stopped?" is asked by a wait and a wrong NO burns the whole limit. Until 0.14.0 both
           were one `mean > 3` test, and typing fifteen characters measures a mean of 0.049 - so renaming a
           document read as nothing happening, and a real run was stopped for it.

           The numbers are read off a measured table: level 8 because level 4 sees thirteen cells on an idle
           screen and level 8 sees none; ONE cell because the smallest change measured five against zero
           twice. A caret is invisible here because a cell is a 30x30 average, and the pointer is invisible
           because CopyFromScreen does not capture the cursor - which is what keeps the stillness guard
           alive. A single character is invisible to both, and nothing on this grid can fix that. */
        const int StirLevel = 8;
        const int StirCells = 1;
        const int QuietMean = 3;

        /** Did anything happen? Counts cells that changed STRONGLY - the noise floor is zero of them. */
        public static bool GridStirred(byte[] a, byte[] b)
        {
            if (a == null || b == null) return true;
            if (a.Length != b.Length) return true;
            int cells = 0;
            for (int i = 0; i < a.Length; i++)
            {
                if (Math.Abs((int)a[i] - (int)b[i]) > StirLevel && ++cells >= StirCells) return true;
            }
            return false;
        }

        /** Has it stopped? Keeps the mean, which is what makes a caret and a dither not count as motion. */
        public static bool GridQuiet(byte[] a, byte[] b)
        {
            if (a == null || b == null) return false;
            if (a.Length != b.Length) return false;
            long sum = 0;
            for (int i = 0; i < a.Length; i++) sum += Math.Abs((int)a[i] - (int)b[i]);
            return (double)sum / a.Length <= QuietMean;
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
                /* AND LISTED, for the same reason - see WindowMatching. The old filter meant a model could
                 * not even learn the dialog's title from the list under its screenshot, so it had nothing to
                 * pass to capture_window and nothing to activate. Reported as `dialog` rather than silently,
                 * because "a dialog is open" is often the most important fact about a screen. */

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
                item.Append(",\"dialog\":")
                    .Append(Native.GetWindow(hWnd, Native.GW_OWNER) != IntPtr.Zero ? "true" : "false");
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
        /* THE LOOKUP, LIFTED OUT OF Activate, because three callers need it now: activating a window,
           capturing one, and refusing to touch this agent's own. Left exactly as it was - a case-insensitive
           substring on the title OR on the process name, first match wins - so nothing about which window
           `activate_window` finds has changed. IntPtr.Zero for "no match" and for "nothing was asked for";
           the caller says which of those it minds. */
        public static IntPtr WindowMatching(string title, string process)
        {
            IntPtr found = IntPtr.Zero;
            string wanted = (title ?? "").Trim().ToLowerInvariant();
            string wantedProcess = (process ?? "").Trim().ToLowerInvariant();
            if (wanted.Length == 0 && wantedProcess.Length == 0) return IntPtr.Zero;

            Native.EnumWindows(delegate(IntPtr hWnd, IntPtr lParam)
            {
                if (found != IntPtr.Zero) return false;
                if (!Native.IsWindowVisible(hWnd)) return true;
                /* OWNED WINDOWS ARE NOT SKIPPED HERE ANY MORE, and that was a real failure rather than a
                 * preference. A modal dialog is owned by the window that opened it, so the old filter
                 * excluded every dialog - and a dialog is the thing capture_window is most often pointed at.
                 * Watched on a live desktop:
                 *
                 *   OWNED  WindowsForms10...  dbforgesql  About dbForge Studio for SQL Server
                 *
                 * `capture_window title=About` answered "no open window matches", which is what the model
                 * was told while the dialog was on screen in front of it. Visible and titled is the test;
                 * an owner is not a reason to pretend a window is not there. */

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
            return found;
        }

        public static string Activate(string title, string process)
        {
            string wanted = (title ?? "").Trim();
            string wantedProcess = (process ?? "").Trim();
            if (wanted.Length == 0 && wantedProcess.Length == 0) return "title or process is required";

            IntPtr found = WindowMatching(title, process);

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

        /* ОТПУСКАЕТСЯ ТО, ЧТО ДЕРЖАЛИ, - НЕ ВСЕ ТРИ КНОПКИ.
         *
         * Сообщено с прогона, и на снимке это было видно буквально: в конце КАЖДОГО повтора на последней
         * позиции курсора открывалось контекстное меню браузера. Запись была чистой - ни одного правого
         * клика, - а меню открывал сам финиш: он слал RIGHTUP безусловно, «на всякий случай», а Windows
         * открывает контекстное меню именно на ОТПУСКАНИИ правой кнопки (DefWindowProc делает из
         * WM_RBUTTONUP WM_CONTEXTMENU, нажатия для этого не нужно). Отпускание кнопки, которую никто не
         * нажимал, - это не уборка, это ещё одно действие.
         *
         * Поэтому ведётся счёт: Emit отмечает каждую кнопку, которую нажал, и снимает отметку на её
         * отпускании, а финиш отпускает ровно отмеченные. macOS делает то же самое (`holding = down`),
         * и это тот случай, где Windows стоило сравнить с ней раньше. */
        static void ReleaseHeldButtons()
        {
            uint held;
            lock (Gate) { held = _heldByReplay; _heldByReplay = 0; }
            if (held == 0) return;
            uint[] downs = new uint[] { Native.MOUSEEVENTF_LEFTDOWN, Native.MOUSEEVENTF_RIGHTDOWN, Native.MOUSEEVENTF_MIDDLEDOWN };
            uint[] ups = new uint[] { Native.MOUSEEVENTF_LEFTUP, Native.MOUSEEVENTF_RIGHTUP, Native.MOUSEEVENTF_MIDDLEUP };
            for (int i = 0; i < ups.Length; i++)
            {
                if ((held & downs[i]) == 0) continue;
                INPUT[] inputs = new INPUT[1];
                inputs[0].type = Native.INPUT_MOUSE;
                inputs[0].mi.dwFlags = ups[i];
                // Counted like every other injection, so "no unchecked SendInput" is a rule with no
                // exceptions - even on a cleanup path where nobody reads the answer.
                Injected(Native.SendInput(1, inputs, Marshal.SizeOf(typeof(INPUT))), 1);
            }
        }

        /* КЛИК ПО ПАНЕЛИ ЗАДАЧ - ЭТО «ПОКАЗАТЬ ОКНО», А НЕ КООРДИНАТА.
         *
         * Сообщено с прогона: запись начиналась кликом по кнопке терминала на панели задач, повтор его
         * воспроизвёл - и терминал СВЕРНУЛСЯ. Координата была верной до пикселя; неверной была семантика.
         * Кнопка панели задач ПЕРЕКЛЮЧАЕТ: окно позади - поднять, окно впереди - свернуть. Страница перед
         * повтором уже подняла то окно, в котором записаны клики, так что записанный «поднять» сыграл как
         * «свернуть», и шесть следующих кликов ушли в то, что оказалось под ним.
         *
         * То же действие, но идемпотентное, у агента уже есть: Activate. Чем его звать - говорит САМА
         * ЗАПИСЬ: сразу за таким нажатием стоит пометка Focus с окном, которое это нажатие вывело вперёд.
         * Никакого разбора подписей («Terminal - 1 running window» - это текст на языке системы): панель
         * узнаётся по классу окна под точкой, окно - по пометке.
         *
         * ТОЛЬКО ПО ЗАГОЛОВКУ, не по процессу: WindowMatching берёт первое окно, у которого совпал ИЛИ
         * заголовок, ИЛИ процесс, и с process=chrome первым попадётся любое окно Chrome - то есть снова
         * MouseFlow. Своё окно не поднимается, как и в /do. Не сошлось хоть что-то - нажатие играется как
         * записано: клик по кнопке, которую не удалось понять, всё ещё лучше, чем не сделать ничего.
         *
         * Возвращает индекс ОТПУСКАНИЯ, которое теперь не играть, или -1, если нажатие обычное. */
        static int TaskbarSwitch(List<Ev> events, int i)
        {
            Ev e = events[i];
            if (e == null || e.Action != "Left Click Down") return -1;
            if (!OnTaskbar(e.X, e.Y)) return -1;

            int release = -1;
            Ev focus = null;
            /* Недалеко: пометка стоит через отпускание и несколько движений. Следующее нажатие - граница:
             * пометка за ним говорит уже про него. */
            for (int k = i + 1; k < events.Count && k <= i + 24; k++)
            {
                Ev n = events[k];
                if (n == null) continue;
                if (release < 0 && (n.Action == "Left Click Release" || n.Action == "Left Click Up")) { release = k; continue; }
                if (n.Action == "Focus" && !string.IsNullOrEmpty(n.Window)) { focus = n; break; }
                if (IsPress(n.Action)) break;
            }
            if (release < 0 || focus == null) return -1;

            IntPtr wanted = WindowMatching(focus.Window, "");
            if (wanted == IntPtr.Zero) return -1;
            if (Mine(wanted) != null) return -1;
            if (Activate(focus.Window, "") != null) return -1;
            lock (Gate) { _switched++; }
            return release;
        }

        /* Панель задач под точкой - по классу верхнего окна, Shell_TrayWnd (и Shell_SecondaryTrayWnd на
         * втором мониторе). Класс, а не подпись: подпись зависит от языка системы, класс - нет. */
        static bool OnTaskbar(int x, int y)
        {
            IntPtr under = Native.WindowFromPoint(new POINT { X = x, Y = y });
            if (under == IntPtr.Zero) return false;
            IntPtr top = Native.GetAncestor(under, Native.GA_ROOT);
            if (top == IntPtr.Zero) top = under;
            StringBuilder sb = new StringBuilder(64);
            if (Native.GetClassName(top, sb, sb.Capacity) == 0) return false;
            string cls = sb.ToString();
            return cls == "Shell_TrayWnd" || cls == "Shell_SecondaryTrayWnd";
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
                /* Read as written. `Cmd` here means the Windows key on this platform and Command on the
                 * other - see ChordMods - and `Ctrl` means the literal Control key on both, which is why
                 * it is a separate token from the `ctrl=` of the action grammar. */
                else if (key == "mods") ctx.Mods = val;
                /* Читается, но повтором НЕ используется: ориентир описывает, где это было, а не куда
                   нажимать. Прицел работает по `control`; довод тот же, по которому это отдельное поле. */
                else if (key == "side") ctx.Side = val;
                else if (key == "near") ctx.Near = val;
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
                    /* FIELD BY FIELD, which is why this line has to exist and why its absence was invisible.
                     * ParseCtx read `mods` correctly, Serialize wrote it correctly, and the value died here
                     * - so every modified gesture replayed unmodified and reported a clean run, which is
                     * precisely the defect the rest of this change removes. A copy that enumerates fields
                     * needs an entry per field; found by running a round trip, not by reading the code. */
                    e.Mods = pending.Mods;
                    e.Near = pending.Near;
                    e.Side = pending.Side;
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
            /* Явный пин, а не просто "не звёздочка": по умолчанию AllowOrigin теперь пуст, и без
               этой второй половины автозапуск стал бы доступен ненастроенному агенту. */
            return ScriptPath.Length > 0 && AllowOrigin.Length > 0 && AllowOrigin != "*";
        }

        public static string EnableAutostart()
        {
            if (ScriptPath.Length == 0)
                return "the agent was started from a pipe, so there is no file to run at logon - download mouseflow-agent.ps1 and start it from the file instead";
            if (AllowOrigin.Length == 0 || AllowOrigin == "*")
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

        /* ПУСТАЯ СТРОКА, А НЕ ЗВЁЗДОЧКА - и это та же правка, что в Swift-агенте.
           Раньше -AllowOrigin только отражался в заголовок и не отвергал ничего, а по умолчанию стоял "*",
           так что агент, запущенный без аргументов, принимал action=type и action=key от ЛЮБОЙ страницы,
           открытой в браузере. CORS этому не мешает: он мешает прочитать ответ, а не отправить запрос и
           выполнить его - и ни нажатию клавиши, ни печати ответ не нужен.
           Пусто теперь значит "собственные страницы продукта и loopback", а не "все". */
        public static string AllowOrigin = "";

        /* КЛЮЧ НА LOOPBACK - и три решения, которые надо назвать вслух.
         *
         * ПОЧЕМУ ОН ВООБЩЕ НУЖЕН, если в OriginAllowed сказано «локальный процесс и так может всё». Для
         * процесса ТОГО ЖЕ пользователя это правда и ключ ему не помеха: он вызовет SendInput напрямую.
         * Неправда это для ДРУГОЙ СЕССИИ на той же машине - другой пользователь по RDP, смена
         * пользователя, служба под своей учётной записью. Такой сессии чужой рабочий стол через SendInput
         * недоступен, а loopback доступен, и до этого ключа она могла печатать в него как угодно. Ровно
         * этот случай и есть «машина, которой владеют тесты».
         *
         * ПОЧЕМУ ОТКРЫТ ТОЛЬКО /health, а не «/health, /windows и /shot», как предлагал план. Потому что
         * снимок экрана и список окон - это СОДЕРЖИМОЕ, а не метаданные: заголовки окон это «Inbox -
         * Outlook» и имена документов, а /shot - это весь рабочий стол целиком. Довод «человек это и так
         * видит» верен для человека ЗА этой машиной и неверен для чужой сессии, от которой ключ и
         * защищает, - то есть он оправдывает открытыми ровно те две двери, через которые утекает самое
         * важное. Открытым остаётся /health, и он обязан: по нему находят агента и узнают, что нужен ключ.
         *
         * ПОЧЕМУ СРАВНЕНИЕ ПОСТОЯННОГО ВРЕМЕНИ. Ключ проверяется по сети, пусть и по петлевой; побайтовое
         * сравнение с ранним выходом отдаёт длину совпавшего префикса временем ответа. Дёшево сделать
         * правильно, поэтому незачем делать иначе. */
        public static string LoopbackKey = "";
        public static bool KeyRequired = false;

        /* Base64url: ключ переносят копированием - из трея в поле на странице, иногда через мессенджер, -
         * и `+`, `/` и `=` в таком пути ломаются молча. 32 байта, потому что это ключ, а не пароль. */
        public static void MakeKey()
        {
            byte[] bytes = new byte[32];
            using (System.Security.Cryptography.RandomNumberGenerator rng =
                System.Security.Cryptography.RandomNumberGenerator.Create())
            {
                rng.GetBytes(bytes);
            }
            LoopbackKey = Convert.ToBase64String(bytes)
                .Replace('+', '-').Replace('/', '_').TrimEnd('=');
        }

        /* Постоянного времени, и длина сравнивается тоже - но не выходом, а тем, что разная длина даёт
         * гарантированное несовпадение. */
        public static bool KeyMatches(string said)
        {
            if (LoopbackKey.Length == 0) return false;
            if (said == null) return false;
            if (said.Length != LoopbackKey.Length) return false;
            int diff = 0;
            for (int i = 0; i < said.Length; i++) diff |= said[i] ^ LoopbackKey[i];
            return diff == 0;
        }

        /* Одна дверь открыта - та, по которой узнают, что остальные закрыты. */
        public static bool NeedsKey(string path)
        {
            if (!KeyRequired) return false;
            return path != "/health";
        }

        /* Собственные origin'ы продукта. Два, потому что развёртывания два, и агент, отказывающий
           второму, - это агент, который "просто не находится". */
        public static readonly string[] ShippedOrigins = new string[] {
            "https://mouseflowapp.vercel.app",
            "https://mouse-agent.vercel.app"
        };

        /* КТО ВООБЩЕ МОЖЕТ ГОВОРИТЬ С ЭТИМ АГЕНТОМ. Тот же порядок проверок, что в originAllowed() у
           macOS-агента, и то же поведение на каждой ветке - PROTOCOL.md запрещает две схемы на два агента.

           Отсутствие Origin - это не браузер: curl, mcp/worker.mjs, node fetch. Пропускается, и это не
           дыра ДЛЯ ПРОЦЕССА ТОГО ЖЕ ПОЛЬЗОВАТЕЛЯ: страница Origin не подделает, его ставит браузер, а
           такой процесс и так может всё - вызвать SendInput сам, прочитать account.json.

           А вот ДРУГАЯ СЕССИЯ на этой машине - второй пользователь по RDP, смена пользователя, служба
           под своей учётной записью - чужой рабочий стол через SendInput не тронет, а сюда постучится.
           От неё Origin не защищает вовсе, и защищает ключ: см. LoopbackKey и -RequireKey. */
        public static bool OriginAllowed(string origin)
        {
            if (origin == null || origin.Length == 0) return true;
            if (AllowOrigin == "*") return true;
            if (AllowOrigin.Length > 0) return origin == AllowOrigin;
            for (int i = 0; i < ShippedOrigins.Length; i++)
            {
                if (origin == ShippedOrigins[i]) return true;
            }
            /* Хост проверяется целиком, через Uri, а не началом строки: https://localhost.evil.example
               начинается с "https://localhost" и по префиксу прошло бы внутрь. */
            Uri parsed;
            if (Uri.TryCreate(origin, UriKind.Absolute, out parsed))
            {
                string host = parsed.Host;
                bool web = parsed.Scheme == "http" || parsed.Scheme == "https";
                if (web && (host == "localhost" || host == "127.0.0.1" || host == "::1")) return true;
            }
            return false;
        }

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
                string key = null;
                for (int i = 1; i < headLines.Length; i++)
                {
                    int colon = headLines[i].IndexOf(':');
                    if (colon <= 0) continue;
                    string name = headLines[i].Substring(0, colon).Trim().ToLowerInvariant();
                    string value = headLines[i].Substring(colon + 1).Trim();
                    if (name == "content-length") int.TryParse(value, out contentLength);
                    else if (name == "origin") origin = value;
                    else if (name == "x-mouseflow-key") key = value;
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

                /* ПОРОГ. Перед Route, а не внутри маршрутов: маршрут, добавленный завтра,
                   наследует проверку, а не забывает её. */
                if (!OriginAllowed(origin))
                {
                    Respond(stream, 403, "application/json",
                        "{\"ok\":false,\"error\":\"this agent does not answer that page - it is pinned to another origin\"}",
                        origin);
                }
                /* КЛЮЧ - ЗДЕСЬ ЖЕ, РЯДОМ С ПОРОГОМ ПО ORIGIN, и по той же причине: маршрут, добавленный
                   завтра, наследует проверку, а не забывает её. OPTIONS проходит: предполётный запрос
                   ставит браузер, ключа в нём нет и быть не может, а выполнить он ничего не выполняет. */
                else if (method != "OPTIONS" && NeedsKey(path) && !KeyMatches(key))
                {
                    Respond(stream, 401, "application/json",
                        "{\"ok\":false,\"error\":\"this agent needs its pairing key - it was started with "
                        + "-RequireKey. Copy the key from the agent's tray menu and paste it on the "
                        + "Connections screen.\",\"needsKey\":true}",
                        origin);
                }
                else
                {
                    Route(stream, method, path, query, body, origin);
                }
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
                    /* Who is driving this PC right now - the same list the border is lit from. Empty means
                       nobody. Makes the border checkable from outside without looking at the screen. */
                    + ",\"acting\":[" + Acting.WhoJson() + "]"
                    + ",\"autostart\":" + (AutostartEnabled() ? "true" : "false")
                    + ",\"canAutostart\":" + (CanAutostart() ? "true" : "false")
                    + ",\"originPinned\":" + (AllowOrigin.Length > 0 && AllowOrigin != "*" ? "true" : "false")
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
                    /* Нажатие по имени, одним действием вместо двух ходов (0.28.0). Флагом, а не
                     * версией, по той же причине, что у canName и canAnchor: мозг предлагает
                     * инструмент только там, где он есть, а инструмент, которого агент не умеет,
                     * стоит ровно того хода, который он должен был сэкономить. */
                    + ",\"canClickName\":true"
                    /* ДВА ФАКТА, А НЕ ОДИН: «умею ключ» и «требую ключ». Клиент, читающий одно поле, не
                     * отличил бы агента, который ключа не понимает, от того, кто его не требует, - а
                     * решения это разные: первому не надо посылать заголовок вовсе, второму надо, если он
                     * у нас есть. То же разделение, что у linked/taking. */
                    + ",\"canAuth\":true"
                    + ",\"keyRequired\":" + (KeyRequired ? "true" : "false")
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
                    /* Несёт ли клик прямоугольники окна и элемента, по которым повтор пересчитывает точку
                       после переезда окна. Флагом, а не версией, по той же причине, что у canName: запись,
                       сделанная старым агентом, якоря не имеет, и повтор обязан честно сказать «сыграно как
                       записано», а не делать вид, что перепривязал. См. api/_anchor.mjs. */
                    + ",\"canAnchor\":true"
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
                /* `output` only when there is one, so `{"ok":true}` stays exactly what it was for the eight
                   actions that have nothing to report. A capture and a clipboard read do have something,
                   and the caller composes the sentence from it - see actionSaid in api/_brain.mjs, which
                   both drivers use so the two cannot word it differently. */
                string said = TakeOutput();
                Respond(stream, 200, "application/json",
                    said == null
                        ? "{\"ok\":true}"
                        : "{\"ok\":true,\"output\":\"" + JsonEscape(said) + "\"}",
                    origin);
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
            /* ЭХО ТОЛЬКО ТОМУ, КОМУ РАЗРЕШЕНО. Пока запрос выполнялся в любом случае, отражение ничего
               не разрешало - разрешать было нечего. Теперь отвергает OriginAllowed выше, и отразить
               отказанному значило бы выдать ему право читать ответ, которого он не получил. */
            string allow = AllowOrigin.Length == 0 ? (origin == null ? "" : origin) : AllowOrigin;
            if (allow == "*" && origin != null) allow = origin;   // PNA preflight dislikes a bare *
            if (origin != null && !OriginAllowed(origin)) allow = "";

            StringBuilder sb = new StringBuilder();
            sb.Append("HTTP/1.1 ").Append(status.ToString(CultureInfo.InvariantCulture)).Append(" ").Append(StatusText(status)).Append("\r\n");
            sb.Append("Content-Type: ").Append(contentType).Append("; charset=utf-8\r\n");
            sb.Append("Content-Length: ").Append(payload.Length.ToString(CultureInfo.InvariantCulture)).Append("\r\n");
            if (allow.Length > 0) sb.Append("Access-Control-Allow-Origin: ").Append(allow).Append("\r\n");
            /* DELETE перечислен, и без него "Отсоединить" в приложении не работало вовсе: браузер шлёт
               preflight, не находит метода и отказывает сам, а экран сообщает, что агент недоступен -
               хотя агент жив и по-прежнему привязан к аккаунту. */
            sb.Append("Access-Control-Allow-Methods: GET, POST, DELETE, OPTIONS\r\n");
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
            /* Not linked: there is nowhere to send it and nobody to attach it to. The console still has it.

               И НЕ БЕРЁТ РАБОТУ - тоже молчит, как на macOS. Меню и документация говорят про этот
               переключатель буквально: выключен - ничего не уходит. Опрос очереди останавливался, репортер
               крашей нет, и предложение было неправдой ровно настолько, насколько его и читают. */
            if (string.IsNullOrEmpty(token) || string.IsNullOrEmpty(root)) return;
            if (!Account.Taking) return;
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

       Long-polling rather than a fast poll - the endpoint holds the request open with nothing to say - so
       an idle machine costs a handful of requests a minute rather than twenty, and an idle wait costs no CPU
       at either end. Backs off to a minute on failure, because an agent that hammers a deployment which is
       down makes the outage worse.

       IT WAS A LONG POLL AND IT IS NOT ANY MORE. Asking the endpoint to hold the connection 25 seconds is
       asking for longer than a serverless function is allowed to live, so every idle poll was cut in flight -
       and this loop called each one a failure to reach the account.

       WHY IT IS NOT A LONG POLL ANY MORE, with the arithmetic, because the obvious fix is the wrong one.
       A held request is billed for its whole length, so what matters is function time over wall time:

         wait 25, cut at ~10, then 2s of backoff   10s per 12s   83%   50 function-seconds a minute
         wait 6, ask again at once                  6s per 6s   100%   60   - worse, and this was the plan
         no wait at all, 3s between asks          0.4s per 3.4s  12%    7   - what this does

       Shortening the wait alone makes an idle machine MORE expensive, because the only rest in the old loop
       came from the failure path's sleep. A claim with no wait answers in about four tenths of a second, and
       the sleep between asks is the part that costs nothing at either end. The price is latency: a job
       queued while this machine is asleep waits up to three seconds instead of being picked up mid-poll.
       Once per run, against a seventh of the compute.

       One job at a time, and no queue of its own. There is one mouse. */
    public static class Courier
    {
        /* Nothing held open: the endpoint answers whether it has work and this end sleeps instead. See the
           arithmetic above for why a shorter hold was the wrong fix. */
        const int ClaimWaitSeconds = 0;
        /* Between asks while there is nothing to do. The only latency this adds is to a job queued during
           the gap, and it is what makes an idle machine nearly free. */
        const int IdleSleepSeconds = 3;
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

                /* A LONG POLL THAT WAS CUT IS NOT A REFUSAL, and telling them apart is the whole of this
                   branch. `Post` returns the body or null, and null with a status of 200 means the headers
                   arrived and the body did not - the answer was on its way when whatever serves it stopped.
                   That is a hosting limit, not an account that cannot be reached, and it used to print
                   "could not ask for work (HTTP 200)" - a sentence that sent people to reinstall the agent.

                   It also must not escalate: backing off to a minute over this makes an idle machine slower
                   to pick up work for a reason that has nothing to do with the account, and at the top of the
                   backoff it filed a crash report about it. */
                if (status == 200 && answer == null)
                {
                    Console.WriteLine("[mouseflow] the account's answer was cut off mid-reply - asking again");
                    Thread.Sleep(1000);
                    continue;
                }

                if (answer == null || status != 200)
                {
                    /* Nothing completed at all (status 0) reads differently from an answer that says no. */
                    Console.WriteLine(status == 0
                        ? "[mouseflow] no answer from the account - waiting " + _backoff.ToString(CultureInfo.InvariantCulture) + "s"
                        : "[mouseflow] the account refused to hand out work (HTTP "
                          + status.ToString(CultureInfo.InvariantCulture) + ") - waiting "
                          + _backoff.ToString(CultureInfo.InvariantCulture) + "s");
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
                if (string.IsNullOrEmpty(id))
                {
                    // Nothing to do. The sleep is the whole saving - see the arithmetic at the top.
                    Thread.Sleep(IdleSleepSeconds * 1000);
                    continue;
                }

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

               this  --POST ?worker=step { shot, windows, results, caps }-->  the deployment decides
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
            /* THE ONE PATH WITH EXACT EDGES, so the one where the border burns steadily for the whole run.
               try/finally rather than a call at the end: this method returns from a dozen places, and a
               paired call would cover one of them. */
            Acting.Begin("goal");
            try { DriveInner(root, token, id); }
            finally { Acting.End("goal"); }
        }

        static void DriveInner(string root, string token, string id)
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
                  /* ЧТО ЭТА МАШИНА УМЕЕТ - с КАЖДЫМ шагом, а не один раз при получении работы.
                   *
                   * Иначе никак: на этом пути облако не может спросить агента ни о чём - агент сам держит
                   * запрос, а до его 127.0.0.1 оттуда не достаёт. Это то самое правило «машина
                   * спрашивает, ничто не тянется внутрь».
                   *
                   * И каждый шаг, а не один раз, потому что дёшево и потому что верно: строка работы живёт
                   * между шагами, а агент - нет, и объявление, сделанное при старте, пережило бы факт,
                   * который описывает. Те же флаги и то же написание, что в /health: два места, называющие
                   * одну возможность по-разному, - это возможность, о которой один из читателей не
                   * узнает. */
                  .Append(",\"caps\":{\"canClickName\":true}")
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
            /* The screen BEFORE, so the answer can say whether the action did anything. The same 64x36
               fingerprint the wait uses, and it costs about as much as nothing. */
            byte[] before = null;
            try { before = Agent.Grid(); } catch { before = null; }

            string bad = Agent.DoAction(line);
            if (bad != null)
            {
                return "{\"id\":\"" + Agent.JsonText(id) + "\",\"isError\":true,\"output\":\""
                    + Agent.JsonText(bad) + "\"}";
            }
            /* A moment for the screen to react before the next picture, or it shows the state before this.
               The same 350ms the app's own loop leaves - and the comparison has to come after it, or every
               action is judged before the screen has had a chance to react and all of them look inert. */
            Thread.Sleep(350);

            /* A FACT, never a sentence. The wording is composed at the deployment, exactly as it is for a
               wait: two agents phrasing this differently would teach the model two different habits. Null
               when either fingerprint could not be taken - "could not tell" is not "did not move". */
            string stirred = "null";
            try
            {
                byte[] after = Agent.Grid();
                if (before != null && after != null) stirred = Moved(before, after) ? "true" : "false";
            }
            catch { stirred = "null"; }
            /* "done" unless the action had something to say. The deployment passes any other value
               straight to the model (resultBlocks in api/_step.mjs), which is why this needs no new field
               and no new shape - the channel was already there and empty. */
            string told = Agent.TakeOutput();
            return "{\"id\":\"" + Agent.JsonText(id) + "\",\"output\":\""
                + Agent.JsonText(told == null ? "done" : told) + "\",\"moved\":"
                + stirred + "}";
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

        /* Moved to Agent.GridMoved in 0.11.0, because scroll_to needs the same question answered - "has
           this stopped changing" - and a second copy of a threshold is a second copy that drifts. Kept as a
           forwarder rather than replaced at the call sites: the name reads better here. */
        static bool Moved(byte[] a, byte[] b) { return Agent.GridStirred(a, b); }

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
                  .Append("\",\"canName\":true,\"canClickName\":true,\"canKeys\":").Append(Agent.HookInstalled ? "true" : "false").Append("}");
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
    /* WHAT IS HAPPENING ON THIS COMPUTER RIGHT NOW, SAID ON THE COMPUTER ITSELF.
     *
     * A run starts silently: the pointer moves on its own, a window rises, text appears in a field. The
     * person sitting here used to learn about it by discovering the mouse had stopped obeying them - which
     * is the moment they are already fighting the run and the run is already fighting them. A page in a
     * browser on another monitor is not an answer to that, and a courier run arrives from the account with
     * no browser open at all.
     *
     * The macOS agent carries the same two classes, hook for hook, and PROTOCOL.md carries the four traps
     * an agent's own window has to clear. In short, and each one measured rather than reasoned about:
     * /windows must not list it (here: it has no title, and the enumerator drops untitled windows before
     * anything else), clicks must pass through it (WS_EX_TRANSPARENT), it must not take focus
     * (WS_EX_NOACTIVATE plus ShowWithoutActivation), and it must stay out of the agent's own screenshots
     * (WDA_EXCLUDEFROMCAPTURE).
     *
     * AND IT DOES NOT MOVE. No pulsing, no breathing. The 64x36 fingerprint that decides "the screen
     * moved" and "it has settled" compares two consecutive frames: a still border subtracts from itself
     * and means nothing, a pulsing one would mean the screen is always moving - every wait would sit out
     * its limit and every action would report that it had worked. This is not a decoration that was
     * declined; it is a decoration that would break the run.
     */
    public static class Acting
    {
        /* Long enough that the border does not blink between two actions of one turn (an action plus the
           350ms the screen is given to react), short enough that "out" means out. */
        public const double LeaseSeconds = 6;

        static readonly object Gate = new object();
        /* A SET, NOT A COUNT. A counter has a failure a set does not: one path that forgets to decrement
           leaves the border lit until the agent restarts - an "you are being driven" light burning while
           nobody is driving. A name can be removed twice and nothing happens. */
        static readonly System.Collections.Generic.List<string> _drivers = new System.Collections.Generic.List<string>();
        static DateTime _leaseUntil = DateTime.MinValue;

        /* The rule itself, pure and taking its clock as an argument, because the only way to check a lease
           is to run it - see check-csharp.mjs. Two silent ways to be wrong live here: a border that does
           not go out after the end, and one that goes out in the middle. */
        public static bool FrameShows(int drivers, DateTime leaseUntil, DateTime now)
        {
            return drivers > 0 || now < leaseUntil;
        }

        public static bool On
        {
            get { lock (Gate) { return FrameShows(_drivers.Count, _leaseUntil, DateTime.UtcNow); } }
        }

        /// Who is driving, as the body of a JSON array. Empty when nobody is.
        public static string WhoJson()
        {
            List<string> names = new List<string>();
            lock (Gate)
            {
                foreach (string d in _drivers) names.Add("\"" + d + "\"");
                if (DateTime.UtcNow < _leaseUntil && !_drivers.Contains("action")) names.Add("\"action\"");
            }
            names.Sort();
            return string.Join(",", names.ToArray());
        }

        public static void Begin(string driver)
        {
            lock (Gate) { if (!_drivers.Contains(driver)) _drivers.Add(driver); }
            Frame.Sync();
        }

        public static void End(string driver)
        {
            lock (Gate) { _drivers.Remove(driver); }
            Frame.Sync();
        }

        /// Extend the lease. For an action nobody will report the end of.
        public static void Touch()
        {
            /* NOT ON A MACHINE WHERE THE BORDER CANNOT BE HIDDEN FROM CAPTURE, and this is the one place
             * the two platforms genuinely differ.
             *
             * "Survivable because it never animates" is true of goal and replay, which hold across a whole
             * run, and FALSE of this one. The lease is six seconds and a model turn is eight to fifty, so
             * on the browser-driven path the border is out when the driver takes its `before` fingerprint
             * and up when it takes `after` - it animates across the one comparison that decides whether an
             * action did anything, on every single turn. Worse, a wait watches consecutive frames for
             * stillness, and a lease expiring in the middle of one means the wait never goes quiet and
             * sits out its whole limit.
             *
             * Windows older than 10 2004 has no WDA_EXCLUDEFROMCAPTURE, so there the border is in the
             * agent's own pictures. There it is not shown for this driver at all: a border that breaks the
             * run it is warning about is worse than no border, and goal and replay - which hold steady and
             * cannot animate - still show one. /health then reports no `action` driver, which is the
             * truth, because none is lit. */
            if (!Frame.HiddenFromCapture) return;
            lock (Gate) { _leaseUntil = DateTime.UtcNow.AddSeconds(LeaseSeconds); }
            Frame.Sync();
        }
    }

    /// The border itself. One window per screen, and only ever on the tray's STA thread.
    public static class Frame
    {
        /* MouseFlow's own accent. Not red: this is not a failure and not a system alert. */
        static readonly System.Drawing.Color Lime = System.Drawing.Color.FromArgb(0xbd, 0xff, 0x7a);
        const int Thickness = 5;

        const int WS_EX_TRANSPARENT = 0x00000020;
        const int WS_EX_TOOLWINDOW = 0x00000080;
        const int WS_EX_LAYERED = 0x00080000;
        const int WS_EX_NOACTIVATE = 0x08000000;

        static System.Windows.Forms.Form _pump;
        static readonly List<System.Windows.Forms.Form> _windows = new List<System.Windows.Forms.Form>();
        static bool _up;

        class Border : System.Windows.Forms.Form
        {
            public Border(System.Drawing.Rectangle bounds)
            {
                /* NO TITLE, and that is load-bearing rather than tidy: WindowsArray drops every window
                   whose title length is zero before it tests anything else, so this one never reaches the
                   model as something to aim at. Same for the click resolver. */
                Text = "";
                FormBorderStyle = System.Windows.Forms.FormBorderStyle.None;
                StartPosition = System.Windows.Forms.FormStartPosition.Manual;
                ShowInTaskbar = false;
                TopMost = true;
                Bounds = bounds;
                /* The interior is keyed out, so what is left on screen is the stroke and nothing else. */
                BackColor = System.Drawing.Color.Black;
                TransparencyKey = System.Drawing.Color.Black;
                DoubleBuffered = true;
            }

            protected override System.Windows.Forms.CreateParams CreateParams
            {
                get
                {
                    System.Windows.Forms.CreateParams cp = base.CreateParams;
                    /* TRANSPARENT so every click - the person's and the agent's - passes through to the
                       window underneath; NOACTIVATE so raising it never steals focus from the field the
                       run is about to type into; TOOLWINDOW so it is out of Alt-Tab; LAYERED for the
                       colour key. Without the first of these the border would swallow every click on the
                       screen, which is the whole product. */
                    cp.ExStyle |= WS_EX_TRANSPARENT | WS_EX_NOACTIVATE | WS_EX_TOOLWINDOW | WS_EX_LAYERED;
                    return cp;
                }
            }

            /// Shown without ever becoming the active window.
            protected override bool ShowWithoutActivation { get { return true; } }

            protected override void OnHandleCreated(EventArgs e)
            {
                base.OnHandleCreated(e);
                /* False on Windows older than 10 2004 - the call does not exist there. The ANSWER is kept,
                   not discarded: Acting.Touch consults it, because the six-second lease is the one driver
                   that would animate the border across the driver's own before/after comparison. */
                bool hidden = false;
                try { hidden = Native.SetWindowDisplayAffinity(Handle, Native.WDA_EXCLUDEFROMCAPTURE); }
                catch (Exception) { hidden = false; }
                NoteAffinity(hidden);
            }

            protected override void OnPaint(System.Windows.Forms.PaintEventArgs e)
            {
                using (System.Drawing.Pen pen = new System.Drawing.Pen(Lime, Thickness))
                {
                    /* Inset, or half the stroke would be drawn off the edge of the screen and the border
                       would read half as thick as it was asked to be. */
                    pen.Alignment = System.Drawing.Drawing2D.PenAlignment.Inset;
                    e.Graphics.DrawRectangle(pen, 0, 0, Width - 1, Height - 1);
                }
            }
        }

        /* ITS OWN THREAD, AND THAT IS THE WHOLE POINT OF THIS BLOCK.
         *
         * The border used to be attached from inside Tray.Pump, ninety lines into a try whose catch exists
         * precisely to swallow a tray that cannot be drawn - and `_icon.Visible = true` really does throw
         * when the notification area is unavailable (no Explorer shell, a locked-down or RDP session). It
         * was also skipped entirely by -NoTray, whose own documentation promises "the HTTP half is
         * identical either way". Both meant the same thing: the machine fully drivable - /do served, the
         * courier claiming goals - with nothing on any screen saying so, while /health cheerfully answered
         * acting:["goal"]. An indicator that can be silently absent is worse than none, because /health is
         * how the absence would have been noticed.
         *
         * So the border no longer depends on a decoration. It gets what the tray gets: an STA thread with
         * its own Application.Run, started unconditionally. macOS never had this hole - there the border
         * lives on NSApplication, which always runs. */
        public static string LastError;
        static Thread _thread;
        static bool _hidden;

        /// Whether this Windows can keep the border out of the agent's own pictures. See Acting.Touch.
        public static bool HiddenFromCapture { get { return _hidden; } }

        internal static void NoteAffinity(bool hidden) { _hidden = hidden; }

        public static void Start()
        {
            _thread = new Thread(new ThreadStart(Pump));
            _thread.IsBackground = true;
            _thread.SetApartmentState(ApartmentState.STA);
            _thread.Start();
        }

        static void Pump()
        {
            try
            {
                /* The pump is an invisible window whose only job is to own a handle on this thread, so
                   Sync can marshal onto it from the HTTP worker, the courier and the replay thread alike.
                   Everything that touches a Form must happen here. */
                _pump = new System.Windows.Forms.Form();
                _pump.Text = "";
                _pump.FormBorderStyle = System.Windows.Forms.FormBorderStyle.None;
                _pump.ShowInTaskbar = false;
                _pump.StartPosition = System.Windows.Forms.FormStartPosition.Manual;
                _pump.Bounds = new System.Drawing.Rectangle(-32000, -32000, 1, 1);
                IntPtr forced = _pump.Handle;   // creating the handle is the point of the line
                GC.KeepAlive(forced);

                Probe();

                /* A MONITOR PLUGGED IN MID-RUN. Raise() reads Screen.AllScreens once and Apply() returns
                   early while the border is already up, so without this the set of borders is frozen for
                   the length of a run - and a courier goal run is minutes. The screen that just joined
                   would be driven with no border at all, and a disconnected one's window would be moved by
                   Windows onto the primary as a rectangle of the wrong size. macOS answers the same event
                   with didChangeScreenParametersNotification; this is that, and the two agents were
                   shipping different behaviour under one version number until they both did. */
                Microsoft.Win32.SystemEvents.DisplaySettingsChanged += delegate { ScreensChanged(); };

                /* Putting the border out when the lease runs out. Lighting it is an event and calls Sync
                   itself; a lease EXPIRING is not an event, and only something watching the clock notices
                   it. This used to be the tray's timer, which is exactly how the border came to depend on
                   the tray. */
                System.Windows.Forms.Timer clock = new System.Windows.Forms.Timer();
                clock.Interval = 1000;
                clock.Tick += delegate { Apply(); };
                clock.Start();

                System.Windows.Forms.Application.Run();
            }
            catch (Exception ex)
            {
                /* Said in the banner rather than swallowed: an agent that cannot show the border can still
                   drive the machine, and the person is entitled to know which of those is true. */
                LastError = ex.Message;
            }
        }

        /* One throwaway border, off-screen, to learn whether this Windows honours the capture exclusion -
           asked ONCE at startup because Acting.Touch needs the answer before the first action, not after
           the first border. A real Border rather than a plain Form, so what is measured is what will be
           used. */
        static void Probe()
        {
            try
            {
                using (Border probe = new Border(new System.Drawing.Rectangle(-32000, -32000, 1, 1)))
                {
                    IntPtr forced = probe.Handle;
                    GC.KeepAlive(forced);
                }
            }
            catch (Exception) { NoteAffinity(false); }
        }

        /// A monitor was added, removed or re-resolutioned. Rebuild, but only if the border is up.
        static void ScreensChanged()
        {
            System.Windows.Forms.Form pump = _pump;
            if (pump == null || !pump.IsHandleCreated) return;
            try
            {
                pump.BeginInvoke((System.Windows.Forms.MethodInvoker)delegate
                {
                    if (!_up) return;
                    Raise();
                });
            }
            catch (Exception) { }
        }

        /// Bring the border into line with Acting. Safe to call from any thread, any number of times.
        public static void Sync()
        {
            System.Windows.Forms.Form pump = _pump;
            if (pump == null || !pump.IsHandleCreated) return;
            try { pump.BeginInvoke((System.Windows.Forms.MethodInvoker)delegate { Apply(); }); }
            catch (Exception) { /* the tray is going away; there is nothing to keep in line */ }
        }

        /// STA thread only. Also called by the tray's one-second tick, which is what expires the lease.
        public static void Apply()
        {
            bool want;
            try { want = Acting.On; }
            catch (Exception) { return; }
            if (want == _up) return;
            _up = want;
            if (want) Raise(); else Drop();
        }

        static void Raise()
        {
            /* Rebuilt on every raise rather than once at startup: between two runs a monitor may have been
               unplugged, added or re-resolutioned. Windows are cheap and runs are rare. */
            Drop();
            foreach (System.Windows.Forms.Screen screen in System.Windows.Forms.Screen.AllScreens)
            {
                try
                {
                    Border b = new Border(screen.Bounds);
                    _windows.Add(b);
                    b.Show();
                }
                catch (Exception) { /* one screen failing is not a reason to leave the others unmarked */ }
            }
        }

        static void Drop()
        {
            foreach (System.Windows.Forms.Form w in _windows)
            {
                try { w.Close(); w.Dispose(); } catch (Exception) { }
            }
            _windows.Clear();
        }
    }

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

                /* Refresh обновляет надписи; MarkOwnMenu запоминает, что дальше в буфере - уже наше
                 * меню, а не работа человека. См. EndFromTray. */
                _menu.Opening += delegate { Refresh(); Agent.MarkOwnMenu(); };

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
# КЛЮЧ - ДО ТОГО, как поднимется сокет. Агент, успевший принять хоть один запрос без ключа, - это окно,
# и на медленной машине оно шире. Делается ВСЕГДА, даже без -RequireKey: тогда он просто показан и ничего
# не сторожит, и человек, решивший включить флаг, уже знает, где ключ.
[MouseFlow.Agent]::MakeKey()
[MouseFlow.Agent]::KeyRequired = [bool]$RequireKey
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

# The border that says this machine is being driven. Unconditionally, and BEFORE the tray: it is a safety
# indicator, not a decoration, and it must not be able to go missing because a notification icon would not
# draw or because -NoTray was passed.
[MouseFlow.Frame]::Start()

if (-not $NoTray) { [MouseFlow.Tray]::Start() }

Write-Host ""
# Read from the compiled constant, never written twice. A hardcoded banner said 0.1.0 while the code
# was 0.2.0, so the one place a user checks which build they are running was the one place that lied.
Write-Host ("  MouseFlow agent " + [MouseFlow.Agent]::Version) -ForegroundColor Cyan
Write-Host "  listening   http://127.0.0.1:$Port"
if ($RequireKey) {
    # ПЕЧАТАЕТСЯ ТОЛЬКО КОГДА ТРЕБУЕТСЯ, и это не экономия строк: ключ, напечатанный без нужды, приучает
    # его копировать, а ключ, который копируют без нужды, начинают хранить в переписке.
    Write-Host ""
    Write-Host "  pairing key $([MouseFlow.Agent]::LoopbackKey)"
    Write-Host "              every request except /health needs it, as X-MouseFlow-Key."
    Write-Host "              Paste it on the app's Connections screen for this machine."
    Write-Host ""
}
if ($AllowOrigin) {
    Write-Host "  origin      $AllowOrigin"
} else {
    Write-Host "  origin      the app's own pages, plus localhost (default)"
}
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
# The border is a safety indicator, so whether it works is a banner line and not something to find out by
# watching the mouse move without one. Three states, and the third is why it is said at all.
$frameErr = [MouseFlow.Frame]::LastError
if ($frameErr) {
    Write-Host "  border      NOT shown: $frameErr" -ForegroundColor Yellow
    Write-Host "              this PC can still be driven, and nothing on screen will say so"
} elseif (-not [MouseFlow.Frame]::HiddenFromCapture) {
    Write-Host "  border      shown for runs, but this Windows cannot hide it from screenshots" -ForegroundColor Yellow
    Write-Host "              (needs Windows 10 2004+), so single actions do not light it"
} else {
    Write-Host "  border      lime, round every screen, while something is driving this PC"
}

$heldAtStart = [MouseFlow.Agent]::HeldEvents
if ($heldAtStart -gt 0) {
    Write-Host "  waiting     a recording of $heldAtStart events is held for the app to collect" -ForegroundColor Cyan
}
Write-Host ""
if ($AllowOrigin -eq '*') {
    Write-Warning "-AllowOrigin '*' turns the check OFF: any site open in your browser can drive your mouse."
    Write-Warning "Drop the flag to go back to answering only the app's own pages."
    Write-Host ""
}
Write-Host "  Hold ESC to abort a replay. Ctrl+C to stop the agent." -ForegroundColor DarkGray
Write-Host ""

[MouseFlow.Agent]::ServeForever($Port)
