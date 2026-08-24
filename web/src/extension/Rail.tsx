/* The panel's rail: the app's sidebar, in the app's order, with the app's words.
 *
 * ALL SIX ARE IN HERE, and each is the panel-sized half of its screen rather than a smaller copy of it.
 * What a person does while looking at a page is done here in full - record, describe, run a skill - and
 * what needs room to read or has consequences for other people is summarised here and opened in the app
 * with one press. Every screen says which it is.
 *
 * Same order and the same words as web/src/shell/AppSidebar.tsx, deliberately: somebody who has used the
 * app should not have to learn a second vocabulary for the same product.
 */
import {
  ChartNoAxesColumn, CircleDot, FolderOpen, LayoutGrid, Sparkles, Users,
} from 'lucide-react';
import { cn } from '@insightis/ui/cn';

export type Screen = 'record' | 'create' | 'skills' | 'dashboard' | 'teams' | 'gallery';

const ITEMS = [
  { id: 'record' as Screen, label: 'Record', icon: CircleDot },
  { id: 'create' as Screen, label: 'Create', icon: Sparkles },
  { id: 'skills' as Screen, label: 'Skills', icon: FolderOpen },
  { id: 'dashboard' as Screen, label: 'Dash', icon: ChartNoAxesColumn },
  { id: 'teams' as Screen, label: 'Teams', icon: Users },
  { id: 'gallery' as Screen, label: 'Gallery', icon: LayoutGrid },
];

export const Rail = ({ screen, onGo }: { screen: Screen; onGo: (screen: Screen) => void }) => (
  <nav
    aria-label="Sections"
    className="flex w-[3.75rem] shrink-0 flex-col items-center gap-1 border-stroke border-e bg-surface-card py-2"
  >
    {ITEMS.map(({ id, label, icon: Icon }) => (
      <button
        key={id}
        type="button"
        title={label}
        aria-label={label}
        aria-current={screen === id ? 'page' : undefined}
        onClick={() => onGo(id)}
        className={cn(
          'flex w-[3.1rem] flex-col items-center gap-0.5 rounded-lg py-1.5 text-[0.62rem]',
          'transition-colors duration-base',
          screen === id
            ? 'bg-state-pressed text-brand-primary'
            : 'text-ink-inactive hover:bg-state-hover hover:text-ink-secondary',
        )}
      >
        <Icon className="size-[18px]" />
        {label}
      </button>
    ))}
  </nav>
);
