/* One published flow, as a card.
 *
 * The design this follows puts a graphic band across the top with three or four linked boxes in it. Drawing
 * that literally would be decoration - so the boxes hold the one thing a flow has that looks exactly like
 * that and is true: the applications it moves through, in the order it touched them. A flow that goes
 * Outlook then Excel then Chrome IS a chain of three, and a reader learns whether it belongs to their work
 * before reading a word of the description.
 *
 * What is NOT on the card: a like count, a verified badge, an editorial star. None of the three exists in
 * the data, and a number nobody can produce is worse than a gap where it would have been.
 */
import { ArrowRight, Check, Download, Monitor } from 'lucide-react';
import { Button } from '@insightis/ui/Button';
import { Typography } from '@insightis/ui/Typography';
import { cn } from '@insightis/ui/cn';
import type { GallerySkill } from '@/lib/api';
import { appLabel, sizeOf } from './collections';

const initial = (name: string) => (name.trim()[0] || '?').toUpperCase();

export const FlowCard = ({
  skill, installed, installing, onInstall, onTry,
}: {
  skill: GallerySkill;
  installed: boolean;
  installing: boolean;
  onInstall: () => void;
  onTry: () => void;
}) => {
  /* Four, then a count. The chain is meant to be read at a glance, and a flow that touches nine
   * applications tells you more by saying nine than by listing nine. */
  const apps = [...new Set(skill.origins.map(appLabel).filter(Boolean))];
  const chain = apps.slice(0, 4);
  const more = apps.length - chain.length;

  return (
    <li className="flex min-w-0 flex-col overflow-hidden rounded-xl border-stroke border bg-surface-card">
      {/* The band. Its height is fixed so a row of cards lines up whether their flows touch one
        * application or nine. */}
      <div className="relative flex h-[5.5rem] items-center gap-1.5 overflow-hidden border-stroke/60 border-b bg-gradient-to-br from-surface-card2 via-surface-card2 to-brand-tertiary/[0.16] px-3">
        <span
          className={cn(
            'absolute top-2.5 left-3 rounded-md px-1.5 py-0.5 text-[0.68rem] font-semibold uppercase tracking-wide',
            skill.kind === 'created'
              ? 'bg-brand-tertiary/20 text-brand-tertiary'
              : 'bg-brand-primary/15 text-brand-primary',
          )}
        >
          {skill.kind}
        </span>

        {/* Installs, top right, and only when somebody has. A zero in a pill is a claim of measurement
          * where there is nothing to measure. */}
        {skill.installs > 0 && (
          <span className="absolute top-2.5 right-3 inline-flex items-center gap-1 rounded-md bg-surface-card/80 px-1.5 py-0.5 text-[0.7rem] font-semibold text-ink-secondary tabular-nums">
            <Download className="size-3" />
            {skill.installs}
          </span>
        )}

        <div className="mt-5 flex min-w-0 flex-1 items-center gap-1.5 overflow-hidden">
          {chain.length ? (
            <>
              {chain.map((app, i) => (
                <span key={app} className="flex min-w-0 items-center gap-1.5">
                  {i > 0 && <span className="h-px w-3 shrink-0 bg-stroke" aria-hidden />}
                  <span className="max-w-[8rem] truncate rounded-md border-stroke border bg-surface-card px-2 py-1 text-[0.74rem] text-ink-secondary">
                    {app}
                  </span>
                </span>
              ))}
              {more > 0 && (
                <span className="shrink-0 text-[0.72rem] text-ink-inactive">+{more}</span>
              )}
            </>
          ) : (
            /* Nothing recorded, said as nothing recorded. An empty band with three grey boxes in it would
              * look like an answer. */
            <span className="text-[0.74rem] text-ink-inactive">
              No applications recorded on this one
            </span>
          )}
        </div>
      </div>

      <div className="flex min-w-0 flex-1 flex-col p-3.5">
        <Typography variant="h3" weight="semibold" className="truncate text-[0.92rem]">
          {skill.name}
        </Typography>
        <Typography variant="p" className="mt-0.5 mb-3 line-clamp-2 flex-1 text-ink-secondary text-[0.82rem]">
          {skill.description || 'No description was published with it.'}
        </Typography>

        <div className="mb-3 flex min-w-0 items-center gap-2">
          {skill.author.image ? (
            <img
              src={skill.author.image}
              alt=""
              className="size-5 shrink-0 rounded-full object-cover"
            />
          ) : (
            <span className="grid size-5 shrink-0 place-items-center rounded-full bg-brand-tertiary/20 text-[0.66rem] font-semibold text-brand-tertiary">
              {initial(skill.author.name || '?')}
            </span>
          )}
          <span className="min-w-0 flex-1 truncate text-[0.76rem] text-ink-inactive">
            {skill.author.name || 'someone'}
          </span>
          <span className="shrink-0 text-[0.74rem] text-ink-inactive tabular-nums">{sizeOf(skill)}</span>
        </div>

        {/* Wrapping, because neither button wraps its own label: `Install` and `Try in Record` are 215px
            of min-content side by side, and a card in the extension's panel is 206px wide. */}
        <div className="flex flex-wrap items-center gap-1.5">
          <Button
            size="sm"
            variant={installed ? 'ghost' : 'primary'}
            leftSlot={installed ? <Check className="size-4" /> : <Download className="size-4" />}
            isLoading={installing}
            onClick={onInstall}
          >
            {installed ? 'Install again' : 'Install'}
          </Button>
          <Button variant="ghost" size="sm" leftSlot={<Monitor className="size-4" />} onClick={onTry}>
            Try in Record
          </Button>
          {installed && (
            /* Said once, in the one place it changes what somebody does next: installing again is allowed
              * and it overwrites the copy on the account rather than making a second one. */
            <span className="ms-auto inline-flex items-center gap-1 text-[0.72rem] text-fb-green">
              on your account <ArrowRight className="size-3" />
            </span>
          )}
        </div>
      </div>
    </li>
  );
};
