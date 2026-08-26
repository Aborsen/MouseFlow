/* The shell every route renders inside: the sidebar, a slim top bar, and the settings dialog.
 *
 * The top bar carries the page's name and the agent's status, because the status is true everywhere and
 * belongs where it can always be seen - and clicking it opens the screen about it, rather than toggling a
 * panel over the page you are working on.
 */
import { Outlet, useRouterState } from '@tanstack/react-router';
import { useEffect, useState } from 'react';
import { cn } from '@insightis/ui/cn';
import { Typography } from '@insightis/ui/Typography';
import { AGENT_WANTS, type LoopbackTrouble } from '@/lib/agent';
import { watchForNewBuild } from '@/lib/build';
import { askAgent, useAgent } from '@/lib/store';
import { AccountProvider, isAuthPath, isPublicPath } from './AccountProvider';
import { AppSidebar } from './AppSidebar';
import { SettingsDialog, type SettingsScreen } from './SettingsDialog';
import { OnboardingTour } from './OnboardingTour';
/* Makes this browser and the account agree, on load and on every change, without asking. Mounted here rather
 * than on the Record page because signing in on another machine can land anywhere, and waiting for somebody to
 * visit the right page before their recordings appear is the same bug in a longer form. */
import { Reconciler } from '@/features/record/Reconciler';

const TITLES: Record<string, string> = {
  '/record': 'Record',
  '/create': 'Create the flow',
  '/skills': 'Skills',
  '/gallery': 'Gallery',
  '/dashboard': 'Dashboard',
  '/team': 'Teams',
  // Still routed, because it was live and is linked from outside the app.
  '/insights': 'Dashboard',
  '/connect': 'Connections',
};

const Shell = () => {
  /* Sign-in, sign-up and reset are whole pages, not screens inside the app: a sidebar to a product you have
   * not entered, and an agent pill above a form, are furniture for somebody who is already here. Read from
   * the router so a navigation between them re-evaluates. */
  /* The admin has a frame of its own, so the product's must stand aside - otherwise there are two
   * sidebars and two headers, one of them leading somewhere the admin did not ask to go. */
  /* And /mcp, which is a page about the product rather than a screen inside it: a sidebar and an agent
   * pill above it would be furniture belonging to an app the reader may not have. */
  const bare = useRouterState({
    select: (s) => isAuthPath(s.location.pathname)
      || isPublicPath(s.location.pathname)
      || s.location.pathname.startsWith('/admin'),
  });
  if (bare) return <Outlet />;
  return <ShellFrame />;
};

/* What the pill says when there is no agent on the line.
 *
 * "Agent offline" used to cover four different situations, and the one it described accurately was the
 * rarest. The other three all end with somebody reinstalling an agent that was already running, because
 * that is the only instruction the words suggest. In particular a browser that refused the request and a
 * machine with nothing listening produce the SAME TypeError, so the pill has to be told which it was
 * rather than working it out from the failure.
 *
 * Tone matters as much as wording: red reads as broken, and "not looked yet" is not broken.
 */
const quiet = (asked: boolean, trouble: LoopbackTrouble | null) => {
  if (!asked) {
    return {
      label: 'Check for agent',
      title: 'Nothing has been asked yet. Click to look for the agent on this computer — your browser '
        + 'may ask permission to reach the local network, which is the request being made.',
      bad: false,
    };
  }
  if (trouble === 'blocked') {
    return {
      label: 'Blocked by browser',
      title: 'The agent may well be running: this browser refused the request to the local network. '
        + 'Click for how to allow it again.',
      bad: false,
    };
  }
  if (trouble === 'ungranted') {
    return {
      label: 'Allow local network',
      title: 'Reaching the agent needs this browser\'s local network permission. Click to try again and '
        + 'answer Allow.',
      bad: false,
    };
  }
  return { label: 'Agent offline', title: 'Click for the command that starts it', bad: true };
};

const ShellFrame = () => {
  const [settings, setSettings] = useState<SettingsScreen | null>(null);
  const { health, stale, asked, trouble } = useAgent();
  const path = useRouterState({ select: (s) => s.location.pathname });
  const away = quiet(asked, trouble);
  /* Whether a newer build of this page exists. Said, never acted on: reloading somebody's page for them
   * throws away a half-typed goal to deliver a change they did not ask for. */
  const [updated, setUpdated] = useState(false);
  useEffect(() => watchForNewBuild(() => setUpdated(true)), []);

  return (
    <div className="page-glow flex min-h-screen items-stretch bg-surface-page">
      <Reconciler />
      <AppSidebar onOpenSettings={(screen) => setSettings(screen ?? 'account')} />

      <div className="flex min-w-0 flex-1 flex-col">
        {/* ВЫСОТА ЗАДАНА, а не получается. Страница, которая занимает остаток окна, вычитает высоту этой
          * шапки числом (Surface.APP_PAGE_HEIGHT), и число это было догадкой: вычиталось 3.25rem, а шапка
          * с её содержимым выходила 65px. Тринадцать пикселей, и видно их было снизу - правая колонка на
          * Create уезжала под нижний край окна вместе со своим нижним отступом, так что сверху зазор был,
          * а снизу нет. Теперь высота здесь объявлена, а не складывается из padding'а и того, что внутрь
          * положили: h-16 - это ровно те 4rem, которые вычитает Surface, и разойтись им больше негде. */}
        <header className="sticky top-0 z-20 flex h-16 items-center gap-3 border-stroke border-b bg-surface-page/85 px-5 backdrop-blur">
          <Typography variant="h1" weight="semibold" className="text-[0.98rem]">
            {TITLES[path] ?? 'MouseFlow'}
          </Typography>

          {/* Beside the agent pill, because they answer the same question - "is what I am looking at
            * current" - and the one that was wrong was wrong BECAUSE this one was missing: a page a
            * version behind cannot tell anybody their agent is a version behind. */}
          {updated && (
            <button
              type="button"
              onClick={() => window.location.reload()}
              title="A newer version of MouseFlow has been deployed. Reloading gets it; nothing you have
                already saved is affected."
              className={cn(
                'ms-auto inline-flex items-center gap-2 rounded-full border px-3 py-1.5 text-[0.8rem]',
                'border-fb-attention/50 text-fb-attention hover:border-stroke-hover',
              )}
            >
              <span className="size-[7px] rounded-full bg-fb-attention" />
              Update available · Reload
            </button>
          )}

          <button
            type="button"
            onClick={() => {
              /* THE GESTURE. This press is what the browser's local-network prompt hangs off, which is the
               * whole reason the first request waits for it. Asking before opening the panel means the
               * prompt and the panel explaining it arrive together. */
              if (!health) askAgent();
              setSettings('connections');
            }}
            title={
              stale
                ? `This app expects ${AGENT_WANTS}. Click for the command that starts the current one.`
                : health
                  ? 'The local agent is connected. To stop it, close its PowerShell window.'
                  : away.title
            }
            className={cn(
              'inline-flex items-center gap-2 rounded-full border px-3 py-1.5 text-[0.8rem]',
              !updated && 'ms-auto',
              'hover:border-stroke-hover',
              health && !stale && 'border-stroke text-ink-body',
              stale && 'border-fb-attention/50 text-fb-attention',
              !health && !away.bad && 'border-stroke text-ink-body',
              !health && away.bad && 'border-fb-red/40 text-fb-red-text',
            )}
          >
            <span
              className={cn(
                'size-[7px] rounded-full',
                health && !stale && 'bg-fb-green',
                stale && 'bg-fb-attention',
                !health && !away.bad && 'bg-ink-inactive',
                !health && away.bad && 'bg-fb-red',
              )}
            />
            {health
              ? stale
                ? `Agent ${health.version} · update to ${AGENT_WANTS}`
                : `Agent ${health.version} · ${health.screen.w}×${health.screen.h}`
              : away.label}
          </button>
        </header>

        <main className="min-w-0 flex-1">
          <Outlet />
        </main>
      </div>

      <OnboardingTour onOpenConnections={() => setSettings('connections')} />

      <SettingsDialog
        open={settings !== null}
        screen={settings ?? 'account'}
        onScreen={setSettings}
        onClose={() => setSettings(null)}
      />
    </div>
  );
};

export const AppLayout = () => (
  <AccountProvider>
    <Shell />
  </AccountProvider>
);
