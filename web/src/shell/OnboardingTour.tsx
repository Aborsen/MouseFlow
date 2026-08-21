/* The first run, explained one place at a time.
 *
 * Five things in the sidebar and a command to run on this machine is not a lot, but it is five more than
 * somebody has ever seen before, and the one that matters most - the agent - is invisible until it is
 * installed. So the tour walks down the nav in the order the product is actually used, and ENDS on the
 * Connections screen with the install command in front of them, which is the only step that leaves
 * something behind.
 *
 * The spotlight is measured, never guessed: `data-tour` on each nav link and `getBoundingClientRect` at the
 * moment the step opens. The sidebar collapses to a rail under 820px and can be collapsed by hand, so the
 * rectangle is re-measured on resize and whenever that happens - a highlight drawn at a remembered
 * coordinate is a highlight around nothing.
 *
 * Four panels rather than one with a hole cut in it. `clip-path` with an even-odd fill is the tidier
 * answer and is not reliable enough to bet a first run on; four blurred rectangles around a gap need
 * nothing but arithmetic, and the gap is exactly the element.
 *
 * Shown once per browser, under the same kind of namespaced key the sidebar and the theme already use -
 * and skippable at every step, because somebody who knows what they are looking at should not have to
 * click through six panels to reach it.
 */
import { useCallback, useEffect, useLayoutEffect, useState } from 'react';
import { setPref } from '@/lib/api';
import { useAccount } from '@/shell/AccountProvider';
import { Button } from '@insightis/ui/Button';
import { Typography } from '@insightis/ui/Typography';
import { cn } from '@insightis/ui/cn';

const SEEN = 'mouseflow.onboarded';
/** The same fact, kept against the ACCOUNT. See the note on `seen` below for why both exist. */
const SEEN_PREF = 'onboarded';

/** Whether the tour has already run in this browser. Written only when it finishes or is skipped. */
export const tourSeen = (): boolean => {
  try {
    return localStorage.getItem(SEEN) === '1';
  } catch (_) {
    /* Private mode: the tour runs every time rather than not at all. */
    return false;
  }
};

const markSeen = () => {
  try {
    localStorage.setItem(SEEN, '1');
  } catch (_) { /* private mode */ }
};

/** Start the tour again from anywhere - Settings has a button for it. */
export const restartTour = () => {
  try {
    localStorage.removeItem(SEEN);
  } catch (_) { /* private mode */ }
  /* The account remembers too, so asking to see it again has to clear BOTH - otherwise the tour opens
   * once and never again after a reload, which reads as the button being broken. */
  void setPref(SEEN_PREF, '');
  window.dispatchEvent(new Event('mouseflow:tour'));
};

interface Step {
  /** The `data-tour` value of the element to point at, or null for a step that points at nothing. */
  target: string | null;
  title: string;
  body: string;
}

/* Said in the order the product is used, and each one says what the thing IS rather than which button to
 * press: a tour that reads like a list of controls teaches nothing that the controls do not already say. */
const STEPS: Step[] = [
  {
    target: '/record',
    title: 'Record what you do',
    body: 'Press Record, work the way you normally would, and stop when you are done. Every click is kept '
      + 'with the name of the thing you clicked — "Send", not "1074, 159". Typing is kept as the fact that '
      + 'you typed and when, never as the words.',
  },
  {
    target: '/create',
    title: 'Or say what you want done',
    body: 'Describe the job in a sentence and it works from a picture of your screen — so it reaches a '
      + 'spreadsheet, a folder or any window, not only a browser tab. It is the newest part, which is why '
      + 'it is marked Beta.',
  },
  {
    target: '/skills',
    title: 'Keep the good ones as skills',
    body: 'A recording you keep becomes a skill: run it again whenever the same job comes back, or hand it '
      + 'to Create as one step of something larger.',
  },
  {
    target: '/gallery',
    title: 'Start from someone else’s work',
    body: 'Skills other people have shared. Take one, and it is yours to run and to change — a good way to '
      + 'see what this can do before recording anything at all.',
  },
  {
    target: '/dashboard',
    title: 'See where the time went',
    body: 'What your recordings add up to: which applications the work happens in, how long each stretch '
      + 'took, and what keeps repeating — which is usually the thing worth automating next.',
  },
  {
    target: null,
    title: 'One thing to install',
    body: 'The agent is the half that works outside the browser — it is what records your clicks and moves '
      + 'the mouse for you. It runs only on this machine, answers only this app, and takes one command to '
      + 'install. That command is on the next screen.',
  },
];

interface Props {
  /** Opens the Connections screen for the last step. */
  onOpenConnections: () => void;
}

interface Rect { top: number; left: number; width: number; height: number }

export const OnboardingTour = ({ onOpenConnections }: Props) => {
  const { account, flows, loaded } = useAccount();

  /* Whether this person has seen it, asked of the ACCOUNT first and the browser second.
   *
   * localStorage alone was a fact about a BROWSER, and the difference is not academic: the same person on
   * their phone, or after clearing a cache, was shown a first-run tour they had already finished - and on
   * the day this shipped, so was every existing user, because no browser anywhere had the flag yet.
   *
   * Three answers, any one of which means "not new": the account says so; this browser says so; or the
   * account already holds work, which is the one that covers everybody who was here before the flag
   * existed. Nothing is shown until the account has actually answered - `loaded` - because "no flows yet"
   * and "not asked yet" look identical and one of them is a tour over somebody's existing work. */
  const seenOnAccount = account?.prefs?.[SEEN_PREF] === '1';
  const hasWork = flows.length > 0;
  const [open, setOpen] = useState(false);
  useEffect(() => {
    if (!loaded) return;
    if (seenOnAccount || hasWork || tourSeen()) return;
    setOpen(true);
  }, [loaded, seenOnAccount, hasWork]);
  const [index, setIndex] = useState(0);
  const [rect, setRect] = useState<Rect | null>(null);

  /* Restartable from Settings, so somebody who skipped it on day one can ask for it on day two. */
  useEffect(() => {
    const again = () => { setIndex(0); setOpen(true); };
    window.addEventListener('mouseflow:tour', again);
    return () => window.removeEventListener('mouseflow:tour', again);
  }, []);

  const step = STEPS[index];
  const last = index === STEPS.length - 1;

  /* Measured, and re-measured whenever anything that moves the sidebar happens: the rail collapses under
   * 820px and by hand, and a highlight at a remembered coordinate is a highlight around nothing. */
  const measure = useCallback(() => {
    if (!step?.target) { setRect(null); return; }
    const el = document.querySelector(`[data-tour="${step.target}"]`);
    if (!el) { setRect(null); return; }
    const r = el.getBoundingClientRect();
    setRect({ top: r.top, left: r.left, width: r.width, height: r.height });
  }, [step]);

  useLayoutEffect(() => {
    if (!open) return;
    measure();
    const onResize = () => measure();
    window.addEventListener('resize', onResize);
    const aside = document.querySelector('aside[data-tight]');
    const mo = aside
      ? new MutationObserver(() => measure())
      : null;
    if (aside && mo) mo.observe(aside, { attributes: true, attributeFilter: ['data-tight'] });
    return () => {
      window.removeEventListener('resize', onResize);
      mo?.disconnect();
    };
  }, [open, measure]);

  const finish = useCallback(() => {
    markSeen();
    /* Best effort, and deliberately not awaited: a tour that shows twice because one write failed is a far
     * smaller harm than a close button that hangs. */
    void setPref(SEEN_PREF, '1');
    setOpen(false);
  }, []);

  /* The last step OPENS Connections rather than having opened it already.
   *
   * Opening it under the tour was tried and is a trap: the settings dialog is modal, so Radix takes pointer
   * events away from everything outside it - including this panel, whose buttons then did nothing and left
   * the last step with no way out. Handing over is also simply better: the screen arrives unblurred, with
   * nothing on top of the command somebody is meant to copy. */
  const openConnections = useCallback(() => {
    markSeen();
    void setPref(SEEN_PREF, '1');
    setOpen(false);
    onOpenConnections();
  }, [onOpenConnections]);

  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') { finish(); return; }
      if (e.key === 'ArrowRight' || e.key === 'Enter') {
        setIndex((i) => (i < STEPS.length - 1 ? i + 1 : i));
      }
      if (e.key === 'ArrowLeft') setIndex((i) => (i > 0 ? i - 1 : i));
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [open, finish]);

  if (!open || !step) return null;

  const pad = 6;
  const hole = rect
    ? {
      top: Math.max(0, rect.top - pad),
      left: Math.max(0, rect.left - pad),
      width: rect.width + pad * 2,
      height: rect.height + pad * 2,
    }
    : null;

  /* Beside the thing it is describing, and inside the window whatever the thing's height: a panel that
   * runs off the bottom of a short viewport is a panel with its buttons missing. */
  const PANEL_W = 340;
  const panelLeft = hole
    ? Math.min(hole.left + hole.width + 20, window.innerWidth - PANEL_W - 20)
    : Math.max(20, (window.innerWidth - PANEL_W) / 2);
  const panelTop = hole
    ? Math.min(Math.max(16, hole.top - 12), Math.max(16, window.innerHeight - 300))
    : Math.max(16, window.innerHeight / 2 - 160);

  const veil = 'fixed bg-surface-page/70 backdrop-blur-sm transition-opacity duration-base';

  return (
    <div className="fixed inset-0 z-[60]" role="dialog" aria-modal="true" aria-label="Getting started">
      {hole ? (
        /* Four panels around the gap. The gap is the element, so the element stays sharp and clickable-
         * looking while everything else recedes; no clip-path, nothing to support-detect. */
        <>
          <div className={veil} style={{ top: 0, left: 0, right: 0, height: hole.top }} />
          <div className={veil} style={{ top: hole.top + hole.height, left: 0, right: 0, bottom: 0 }} />
          <div className={veil} style={{ top: hole.top, left: 0, width: hole.left, height: hole.height }} />
          <div
            className={veil}
            style={{ top: hole.top, left: hole.left + hole.width, right: 0, height: hole.height }}
          />
          <div
            className="pointer-events-none fixed rounded-lg ring-2 ring-brand-primary transition-all duration-base"
            style={{ top: hole.top, left: hole.left, width: hole.width, height: hole.height }}
          />
        </>
      ) : (
        <div className={cn(veil, 'inset-0')} />
      )}

      <div
        className="fixed w-[340px] rounded-xl border border-stroke bg-surface-card p-5 shadow-lg
                   transition-all duration-base"
        style={{ top: panelTop, left: panelLeft }}
      >
        <Typography variant="span" className="text-ink-inactive text-xs">
          {index + 1} of {STEPS.length}
        </Typography>
        <Typography variant="h2" weight="semibold" className="mt-1 text-[1.05rem]">
          {step.title}
        </Typography>
        <Typography variant="p" className="mt-2 text-ink-body leading-relaxed">
          {step.body}
        </Typography>

        <div className="mt-5 flex items-center gap-2">
          <Button variant="ghost" size="sm" onClick={finish}>
            {last ? 'Close' : 'Skip'}
          </Button>
          <div className="ms-auto flex items-center gap-2">
            {index > 0 && (
              <Button variant="secondary" size="sm" onClick={() => setIndex((i) => i - 1)}>
                Back
              </Button>
            )}
            {last ? (
              <Button size="sm" onClick={openConnections}>
                Set up the agent
              </Button>
            ) : (
              <Button size="sm" onClick={() => setIndex((i) => i + 1)}>
                Next
              </Button>
            )}
          </div>
        </div>
      </div>
    </div>
  );
};
