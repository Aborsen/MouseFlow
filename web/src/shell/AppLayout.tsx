/* The shell every route renders inside: the sidebar, a slim top bar, and the settings dialog.
 *
 * The top bar carries the page's name and the agent's status, because the status is true everywhere and
 * belongs where it can always be seen - and clicking it opens the screen about it, rather than toggling a
 * panel over the page you are working on.
 */
import { Outlet, useRouterState } from '@tanstack/react-router';
import { useState } from 'react';
import { cn } from '@insightis/ui/cn';
import { Typography } from '@insightis/ui/Typography';
import { AGENT_WANTS } from '@/lib/agent';
import { useAgent } from '@/lib/store';
import { AccountProvider } from './AccountProvider';
import { AppSidebar } from './AppSidebar';
import { SettingsDialog, type SettingsScreen } from './SettingsDialog';

const TITLES: Record<string, string> = {
  '/record': 'Record',
  '/create': 'Create the flow',
  '/skills': 'Skills',
  '/gallery': 'Gallery',
  '/insights': 'Insights',
  '/connect': 'Connections',
};

const Shell = () => {
  const [settings, setSettings] = useState<SettingsScreen | null>(null);
  const { health, stale } = useAgent();
  const path = useRouterState({ select: (s) => s.location.pathname });

  return (
    <div className="flex min-h-screen items-stretch bg-surface-page">
      <AppSidebar onOpenSettings={(screen) => setSettings(screen ?? 'account')} />

      <div className="flex min-w-0 flex-1 flex-col">
        <header className="sticky top-0 z-20 flex items-center gap-3 border-stroke border-b bg-surface-page/85 px-5 py-3 backdrop-blur">
          <Typography variant="h1" weight="semibold" className="text-[0.98rem]">
            {TITLES[path] ?? 'MouseFlow'}
          </Typography>

          <button
            type="button"
            onClick={() => setSettings('connections')}
            title={
              stale
                ? `This app expects ${AGENT_WANTS}. Click for the command that starts the current one.`
                : health
                  ? 'The local agent is connected. To stop it, close its PowerShell window.'
                  : 'Click for the command that starts it'
            }
            className={cn(
              'ms-auto inline-flex items-center gap-2 rounded-full border px-3 py-1.5 text-[0.8rem]',
              'hover:border-stroke-hover',
              health && !stale && 'border-stroke text-ink-body',
              stale && 'border-fb-attention/50 text-fb-attention',
              !health && 'border-fb-red/40 text-fb-red-text',
            )}
          >
            <span
              className={cn(
                'size-[7px] rounded-full',
                health && !stale && 'bg-fb-green',
                stale && 'bg-fb-attention',
                !health && 'bg-fb-red',
              )}
            />
            {health
              ? stale
                ? `Agent ${health.version} · update to ${AGENT_WANTS}`
                : `Agent ${health.version} · ${health.screen.w}×${health.screen.h}`
              : 'Agent offline'}
          </button>
        </header>

        <main className="min-w-0 flex-1">
          <Outlet />
        </main>
      </div>

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
