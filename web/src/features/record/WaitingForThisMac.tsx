/* "Claude asked to start a recording here." — the offer, at the moment it means something.
 *
 * The failure this exists to remove was a silent one, and it was the product's fault rather than anybody's.
 * Somebody connected MouseFlow to Claude, said "start recording", and nothing happened: the request sat in
 * the queue because no computer was listening, the chat said so in a sentence they had to go looking to act
 * on, and this app — open on the same screen — showed an ordinary Record page with no hint that anything was
 * waiting. They went hunting through settings and concluded the product was broken.
 *
 * CONSENT AT THE MOMENT OF THE REQUEST, which is also the strongest kind. Letting a chat drive a computer is
 * a real permission and it should be asked for, but a switch buried on a settings screen is not asking — it
 * is hoping somebody guesses. Here the question arrives with its answer already in hand: something specific
 * is waiting, and one button lets it through.
 *
 * It never nags. Nothing is shown unless something is ACTUALLY queued and this machine is not taking work;
 * the moment either stops being true it goes away on its own.
 */
import { useCallback, useEffect, useState } from 'react';
import { Sparkles, X } from 'lucide-react';
import { Button } from '@insightis/ui/Button';
import { Typography } from '@insightis/ui/Typography';
import { linkAccount, type AgentHealth } from '@/lib/agent';
import { mintDeviceToken } from '@/lib/api';

interface Waiting {
  waiting: number;
  tools: string[];
}

/* Tool names are written for a model - mouseflow_start_recording - and read here by a person. Only the two
 * that can arrive while nothing is attached are named; anything else is "something", which is honest. */
const WHAT: Record<string, string> = {
  mouseflow_start_recording: 'to start a recording here',
  mouseflow_stop_recording: 'to stop the recording here',
};

const asked = (tools: string[]) => {
  const known = tools.map((t) => WHAT[t]).filter(Boolean);
  if (known.length) return known[0];
  return tools.length ? 'to run something here' : 'to do something here';
};

const EVERY_MS = 20_000;

export const WaitingForThisMac = ({
  health,
  port,
  onDone,
}: {
  health: AgentHealth | null;
  port: number;
  onDone: (said: string) => void;
}) => {
  const [waiting, setWaiting] = useState<Waiting | null>(null);
  const [busy, setBusy] = useState(false);
  const [hidden, setHidden] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);

  /* Only worth asking when this machine could be the answer: an agent that is already taking work will pick
   * it up on its own, and one that cannot be attached at all has nothing to offer. */
  const couldHelp = !!health && health.linked === false;

  const look = useCallback(async () => {
    if (!couldHelp) { setWaiting(null); return; }
    try {
      const res = await fetch('/api/mcp?pending=1', { credentials: 'same-origin' });
      const body = await res.json();
      setWaiting(res.ok && body && body.waiting > 0 ? body : null);
    } catch (_) {
      /* A failed look is not "nothing is waiting". It simply says nothing, which is what leaving the banner
       * as it was does. */
    }
  }, [couldHelp]);

  useEffect(() => {
    void look();
    const timer = setInterval(() => { void look(); }, EVERY_MS);
    return () => clearInterval(timer);
  }, [look]);

  if (!couldHelp || !waiting || hidden) return null;

  return (
    <div className="mb-3 flex flex-wrap items-start gap-3 rounded-xl border border-brand-primary/40 bg-brand-primary/10 p-3.5">
      <Sparkles aria-hidden className="mt-0.5 size-5 shrink-0 text-brand-primary" />
      <div className="min-w-0 flex-1">
        <Typography variant="span" weight="semibold" className="block text-[0.92rem]">
          Claude asked {asked(waiting.tools)}
          {waiting.waiting > 1 ? ` (and ${waiting.waiting - 1} more)` : ''}
        </Typography>
        <Typography variant="p" className="mt-0.5 text-ink-body text-[0.84rem] leading-relaxed">
          Nothing on this computer is listening yet, so it is sitting in the queue. Letting it through
          attaches this computer to your account: from then on a connected AI can start and stop recordings
          here and run your skills. Nothing reaches in — the agent asks. Switching it off again is
          “Let My AI Act On This Mac” in the agent’s own menu, the cursor icon at the top of the screen.
        </Typography>
        {problem && (
          <Typography variant="p" className="mt-1 text-[0.82rem] text-fb-red-text">{problem}</Typography>
        )}
      </div>
      <div className="flex shrink-0 items-center gap-1.5">
        <Button
          size="sm"
          isLoading={busy}
          onClick={async () => {
            setBusy(true);
            setProblem(null);
            try {
              /* Minted and handed across loopback in one go, so nothing is ever shown. The person said yes
               * to the thing they were already looking at, which is the whole of the ceremony. */
              const made = await mintDeviceToken('This computer');
              await linkAccount(port, made.token, location.origin);
              onDone('This computer is listening now — what was waiting will start in a moment.');
              setWaiting(null);
            } catch (err) {
              setProblem(err instanceof Error ? err.message : 'that did not work');
            } finally {
              setBusy(false);
            }
          }}
        >
          Let it through
        </Button>
        <Button
          variant="ghost"
          size="sm"
          aria-label="Not now"
          title="Not now — the request stays in the queue"
          onClick={() => setHidden(true)}
        >
          <X className="size-4" />
        </Button>
      </div>
    </div>
  );
};
