/* The assistant, over everything else.
 *
 * FULL BLEED, INCLUDING THE RAIL, which is the one screen here that does that. Every other screen is a
 * thing you glance at beside a page; this one is a conversation, and a conversation in a 340px column with
 * a 60px rail beside it is a conversation in a straw. So it covers the panel and carries its own way out.
 *
 * It answers from the account's own recordings and runs - what was recorded, how runs ended, which flows
 * repeat - not from the page in front of you. That is worth saying on the screen, because a panel attached
 * to a browser tab implies otherwise.
 */
import { useEffect, useRef, useState } from 'react';
import { Loader2, Send, Sparkles, X } from 'lucide-react';
import { Button } from '@insightis/ui/Button';
import { Typography } from '@insightis/ui/Typography';
import { cn } from '@insightis/ui/cn';
import { Said, type SaidNote } from '@/components/Said';
import { ask } from './worker';

interface Turn { role: 'you' | 'it'; text: string }

/* Three that can be answered from what is stored, so a first question is never a guess about what this
 * knows. The same three the app opens with. */
const OPENERS = [
  'Where did my time go last week?',
  'Which flow do I repeat most?',
  'Why did my last run fail?',
];

export const AssistantScreen = ({ onClose }: { onClose: () => void }) => {
  const [turns, setTurns] = useState<Turn[]>([]);
  const [question, setQuestion] = useState('');
  const [busy, setBusy] = useState(false);
  const [note, setNote] = useState<SaidNote | null>(null);
  const bottom = useRef<HTMLDivElement>(null);

  useEffect(() => { bottom.current?.scrollIntoView({ block: 'end' }); }, [turns, busy]);

  const send = async (text: string) => {
    const asked = text.trim();
    if (!asked || busy) return;
    setNote(null);
    setQuestion('');
    setTurns((was) => [...was, { role: 'you', text: asked }]);
    setBusy(true);
    /* The history that travels is what was said, in the shape /api/chat takes - and it is bounded on both
     * sides, here and in the worker. */
    const history = turns.map((t) => ({ role: t.role === 'you' ? 'user' : 'assistant', content: t.text }));
    const res = await ask('app/ask', { question: asked, history });
    setBusy(false);
    if (!res.ok) { setNote({ text: res.error ?? 'It did not answer.', kind: 'bad' }); return; }
    setTurns((was) => [...was, { role: 'it', text: String(res.answer ?? '') }]);
  };

  return (
    /* Over the rail as well as the content: absolute inside the panel's own box, which both frames give it. */
    <div className="absolute inset-0 z-40 flex flex-col bg-surface-page">
      <header className="flex items-center gap-2 border-stroke border-b px-3 py-2">
        <Sparkles className="size-4 text-brand-tertiary" />
        <Typography variant="span" weight="semibold" className="flex-1 text-[0.9rem]">Assistant</Typography>
        <button
          type="button"
          onClick={onClose}
          aria-label="Close the assistant"
          title="Close"
          className="grid size-7 place-items-center rounded-md text-ink-inactive hover:bg-state-hover hover:text-ink-primary"
        >
          <X className="size-4" />
        </button>
      </header>

      <div className="flex min-h-0 flex-1 flex-col gap-2 overflow-y-auto p-3">
        {turns.length === 0 && (
          <>
            <Typography variant="p" className="text-ink-inactive text-[0.8rem] leading-relaxed">
              It answers from what this account has recorded and run — where the time went, which flow
              repeats, how a run ended. Not from the page you are looking at.
            </Typography>
            <div className="mt-1 flex flex-col gap-1.5">
              {OPENERS.map((opener) => (
                <button
                  key={opener}
                  type="button"
                  onClick={() => void send(opener)}
                  className="rounded-lg border border-brand-primary/40 px-2.5 py-1.5 text-left text-[0.8rem] text-ink-body transition-colors duration-base hover:bg-state-hover"
                >
                  {opener}
                </button>
              ))}
            </div>
          </>
        )}

        {turns.map((turn, i) => (
          <div
            key={i}
            className={cn(
              'max-w-[92%] rounded-lg px-2.5 py-2 text-[0.82rem] leading-relaxed whitespace-pre-wrap break-words',
              turn.role === 'you'
                ? 'ms-auto bg-state-pressed text-ink-primary'
                : 'border border-stroke/45 bg-surface-card text-ink-body',
            )}
          >
            {turn.text}
          </div>
        ))}

        {busy && (
          <span className="flex items-center gap-1.5 text-[0.78rem] text-ink-inactive">
            <Loader2 className="size-3.5 animate-spin" />
            Reading your history…
          </span>
        )}

        <Said note={note} onDismiss={() => setNote(null)} variant="inline" />
        <div ref={bottom} />
      </div>

      <div className="flex items-end gap-1.5 border-stroke border-t p-2.5">
        <textarea
          value={question}
          onChange={(ev) => setQuestion(ev.target.value)}
          onKeyDown={(ev) => {
            if (ev.key === 'Enter' && !ev.shiftKey) { ev.preventDefault(); void send(question); }
          }}
          rows={2}
          placeholder="Ask about your recordings and runs…"
          aria-label="Ask about your recordings and runs"
          className="min-h-[2.75rem] flex-1 resize-none rounded-md border-stroke border bg-surface-card2 px-2.5 py-1.5 text-[0.85rem] text-ink-primary placeholder:text-ink-inactive focus:border-input-focus focus:outline-none"
        />
        <Button
          size="sm"
          aria-label="Ask"
          disabled={!question.trim() || busy}
          onClick={() => void send(question)}
          leftSlot={<Send className="size-4" />}
        />
      </div>
    </div>
  );
};
