/* Which machine this is, and the pieces every screen that says so needs.
 *
 * This module exists because of a bug rather than a plan. The install command appears on TWO surfaces - the
 * guide at /connect and the Connections panel in settings, which is how most people actually reach it - and
 * only the first one learned about macOS. So somebody on a Mac opened settings and was handed a PowerShell
 * one-liner, which is exactly the failure the platform switch was built to prevent.
 *
 * The detection, the picker and the copyable command line now live in one place, so a third surface cannot
 * be half-right either.
 */
import { Apple, Copy, Download, Monitor } from 'lucide-react';
import { type ReactNode, useEffect, useState } from 'react';
import { Button, buttonVariants } from '@insightis/ui/Button';
import { cn } from '@insightis/ui/cn';
import { type AgentHealth, type HostOS, hostOS } from '@/lib/agent';

export interface Platform {
  os: HostOS;
  setOs: (os: HostOS) => void;
  /** Show the macOS copy. False for 'other' as well as for Windows - there is no Linux agent to offer. */
  mac: boolean;
  /** The browser would not say. Worth naming on screen rather than guessing silently. */
  unknown: boolean;
  /** What the window is called, since half the instructions on either platform mention it. */
  terminal: string;
}

/* Guessed from the browser, then corrected by fact.
 *
 * An agent that is already answering knows which platform it is on, and that outranks any user agent string.
 * Both remain switchable by hand, because reading one platform's steps out to somebody on the other is a
 * real thing that happens. */
export function usePlatform(health: AgentHealth | null): Platform {
  const [os, setOs] = useState<HostOS>(hostOS);
  useEffect(() => {
    if (health?.platform) setOs(health.platform);
  }, [health?.platform]);

  const mac = os === 'macos';
  return { os, setOs, mac, unknown: os === 'other', terminal: mac ? 'Terminal' : 'PowerShell' };
}

/* A command, copyable.
 *
 * Every command on these screens goes through this. A command somebody has to retype out of a paragraph is
 * a command they will get wrong, and the macOS path has four of them. */
export const Command = ({ text, onCopy }: { text: string; onCopy: (text: string) => void }) => (
  <div className="flex items-center gap-2 rounded-md border-stroke border bg-surface-card2 p-1.5">
    <code className="min-w-0 flex-1 overflow-x-auto whitespace-nowrap px-1 font-mono text-[0.78rem] text-ink-primary">
      {text}
    </code>
    <Button variant="ghost" size="sm" leftSlot={<Copy className="size-4" />} onClick={() => onCopy(text)}>
      Copy
    </Button>
  </div>
);

/** The two-way switch. Never hidden: a detected platform is a default, not a verdict. */
export const PlatformPicker = ({ platform, onPick }: {
  platform: Platform;
  onPick?: (os: HostOS) => void;
}) => (
  <div className="flex shrink-0 items-center gap-1 rounded-lg border-stroke border bg-surface-card2 p-1">
    {([
      { id: 'windows' as const, label: 'Windows', icon: <Monitor className="size-4" /> },
      { id: 'macos' as const, label: 'macOS', icon: <Apple className="size-4" /> },
    ]).map((choice) => (
      <button
        key={choice.id}
        type="button"
        onClick={() => { platform.setOs(choice.id); onPick?.(choice.id); }}
        className={cn(
          'inline-flex items-center gap-1.5 rounded-md px-2.5 py-1.5 text-[0.84rem] transition-colors duration-base',
          /* 'other' lights Windows, because that is what is being shown. Leaving both unlit reads as the
           * switch being broken rather than as "we could not tell". */
          (platform.mac ? choice.id === 'macos' : choice.id === 'windows')
            ? 'bg-brand-primary/15 font-semibold text-brand-primary'
            : 'text-ink-secondary hover:bg-state-hover',
        )}
      >
        {choice.icon}
        {choice.label}
      </button>
    ))}
  </div>
);

/* Granted, but the agent started before it was.
 *
 * macOS installs the event tap at startup, so a permission flipped afterwards does not reach the running
 * process. Detected rather than described: Accessibility granted with no tap is this case and no other. */
export const needsRestart = (health: AgentHealth | null): boolean =>
  !!health?.permissions?.accessibility && health?.canKeys === false;

/* A download, as a link.
 *
 * Not `<Button asChild>`, which cannot work with this Button and does not fail quietly: `asChild` renders a
 * Radix Slot, Slot demands exactly one child element, and Button always emits several - an icon, a span for
 * the label, another icon. Clicking the fold that contained one of these took the whole application down
 * with "Slot failed to slot onto its children", which is what somebody found by clicking it.
 *
 * `buttonVariants` is exported, so a real anchor can carry the same classes. A link that looks like a button
 * rather than a button pretending to be a link. */
export const DownloadLink = ({ href, name, children }: {
  href: string;
  name: string;
  children: ReactNode;
}) => (
  <a
    href={href}
    download={name}
    className={cn(buttonVariants({ variant: 'tertiary', size: 'sm' }), 'no-underline')}
  >
    <Download className="size-4" />
    <span className="align-text-top">{children}</span>
  </a>
);
