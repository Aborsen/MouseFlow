/* /mcp — the page about the part of MouseFlow that is not a screen.
 *
 * Everything else this product does has a page you can look at while it happens: you press Record and watch
 * the timer, you open Skills and see the list. The MCP server is the one component whose whole job is to be
 * used from somewhere else, which means the only way anybody finds out what it can do is by being told. A
 * server nobody can describe is a server nobody adds.
 *
 * PUBLIC, and deliberately. A page explaining how to connect an AI to an account is read by somebody
 * deciding whether to have an account at all, and by an administrator who will never sign in but has to say
 * yes to it. AccountProvider lets this path through its wall, and AppLayout renders it bare — no sidebar, no
 * agent pill: furniture for a product you are already inside, in front of somebody who may not be.
 *
 * Everything factual on it comes from features/mcp/facts.ts, which the test suite checks against api/mcp.js.
 * A product page that promises a tool the server does not have is the same defect as a button that is not
 * there, and this repository has shipped that one already.
 */
import { Link } from '@tanstack/react-router';
import { ArrowLeft, Check, Copy, ShieldCheck, Sparkles, TerminalSquare } from 'lucide-react';
import { useState } from 'react';
import { Button } from '@insightis/ui/Button';
import { Typography } from '@insightis/ui/Typography';
import { cn } from '@insightis/ui/cn';
import { CONNECT_WAYS, MCP_TOOLS, TOOL_GROUPS, type ToolGroup, mcpUrl } from './facts';

const Mark = () => (
  <svg viewBox="0 0 24 24" aria-hidden className="size-5 text-logo-mark">
    <path d="M5 4l14 8-6 1.6L10.5 20z" fill="currentColor" />
  </svg>
);

const Section = ({ id, title, lead, children }: {
  id: string;
  title: string;
  lead?: string;
  children: React.ReactNode;
}) => (
  <section id={id} className="border-stroke border-t py-10 sm:py-14">
    <Typography variant="h3" weight="semibold" className="text-[1.35rem] sm:text-[1.6rem]">
      {title}
    </Typography>
    {lead && (
      <Typography variant="p" className="mt-2 max-w-[68ch] text-[0.95rem] text-ink-body leading-relaxed">
        {lead}
      </Typography>
    )}
    <div className="mt-6">{children}</div>
  </section>
);

/** The address, with the one thing anybody wants to do to it. */
const Address = ({ url }: { url: string }) => {
  const [copied, setCopied] = useState(false);
  return (
    <div className="flex flex-wrap items-center gap-2 rounded-xl border-stroke border bg-surface-card2 p-2">
      <code className="min-w-0 flex-1 overflow-x-auto whitespace-nowrap px-2 py-1 font-mono text-[0.86rem] text-ink-primary">
        {url}
      </code>
      <Button
        size="sm"
        variant={copied ? 'secondary' : 'primary'}
        leftSlot={copied ? <Check className="size-4" /> : <Copy className="size-4" />}
        onClick={async () => {
          try {
            await navigator.clipboard.writeText(url);
            setCopied(true);
            setTimeout(() => setCopied(false), 2000);
          } catch (_) {
            /* Blocked clipboards happen, and the address is already selectable above. Saying nothing is
             * better than an error about a convenience. */
          }
        }}
      >
        {copied ? 'Copied' : 'Copy'}
      </Button>
    </div>
  );
};

const GROUP_ORDER: ToolGroup[] = ['read', 'machine', 'control'];

const GROUP_TONE: Record<ToolGroup, string> = {
  read: 'border-fb-green/40 bg-fb-green/[0.06]',
  machine: 'border-brand-primary/40 bg-brand-primary/[0.07]',
  control: 'border-stroke bg-surface-card2',
};

export const McpView = () => {
  const url = mcpUrl();
  const ways = CONNECT_WAYS(url);

  return (
    <div className="min-h-screen bg-surface-page text-ink-primary">
      <header className="sticky top-0 z-20 border-stroke border-b bg-surface-page/85 backdrop-blur">
        <div className="mx-auto flex max-w-[62rem] items-center gap-3 px-5 py-3">
          <Link to="/record" className="flex items-center gap-2.5" title="MouseFlow">
            <Mark />
            <Typography variant="span" weight="semibold">MouseFlow</Typography>
          </Link>
          <span className="text-ink-inactive text-[0.8rem]">/ MCP</span>
          <Link
            to="/record"
            className="ms-auto inline-flex items-center gap-1.5 rounded-full border-stroke border px-3 py-1.5 text-[0.8rem] text-ink-body hover:border-stroke-hover hover:text-ink-primary"
          >
            <ArrowLeft className="size-3.5" />
            Open the app
          </Link>
        </div>
      </header>

      <div className="mx-auto max-w-[62rem] px-5 pb-20">
        {/* ------------------------------------------------------------------ the hero */}
        <section className="py-12 sm:py-16">
          <span className="inline-flex items-center gap-1.5 rounded-full border border-brand-primary/40 bg-brand-primary/10 px-2.5 py-1 font-semibold text-[0.72rem] text-brand-primary uppercase tracking-wide">
            <Sparkles className="size-3.5" />
            Model Context Protocol
          </span>
          <Typography
            variant="h1"
            weight="semibold"
            className="mt-4 max-w-[20ch] text-[2rem] leading-[1.1] sm:text-[2.75rem]"
          >
            Your own desktop, as tools an AI can call.
          </Typography>
          <Typography variant="p" className="mt-4 max-w-[62ch] text-[1rem] text-ink-body leading-relaxed">
            MouseFlow records what you do on your computer and can play it back. The MCP server is how a
            chat gets to that: it can read what you have recorded, tell you where your time went, start and
            stop the recorder on your machine, and run a skill you made — through the same agent the Record
            button uses, on the same computer, with nothing new installed.
          </Typography>

          <div className="mt-7 grid gap-2">
            <Typography variant="span" weight="semibold" className="text-[0.82rem] text-ink-secondary">
              Add this address to Claude, or to anything else that speaks MCP
            </Typography>
            <Address url={url} />
            <Typography variant="p" className="text-[0.82rem] text-ink-inactive">
              It signs you in with the MouseFlow account you already have. No token to copy, no secret to
              keep, and everyone who adds it sees only their own account.
            </Typography>
          </div>

          <div className="mt-8 grid gap-3 sm:grid-cols-3">
            {[
              {
                icon: <ShieldCheck className="size-4 text-brand-primary" />,
                title: 'Nothing reaches in',
                body: 'No inbound path to your computer exists. Your machine asks the account whether there '
                  + 'is work, and only while you have said it may.',
              },
              {
                icon: <TerminalSquare className="size-4 text-brand-primary" />,
                title: 'Reading needs nothing running',
                body: 'Recordings, transcripts, runs and totals answer straight from the account — with '
                  + 'your computer asleep, off, or somewhere else entirely.',
              },
              {
                icon: <Sparkles className="size-4 text-brand-primary" />,
                title: 'Your skills, as tools',
                body: 'Every skill on the account is offered under its own name, with the arguments its '
                  + 'author actually left open. Nothing else can be asked for.',
              },
            ].map((card) => (
              <div key={card.title} className="rounded-xl border-stroke border bg-surface-card p-4">
                <div className="flex items-center gap-2">
                  {card.icon}
                  <Typography variant="span" weight="semibold" className="text-[0.9rem]">
                    {card.title}
                  </Typography>
                </div>
                <Typography variant="p" className="mt-1.5 text-[0.84rem] text-ink-body leading-relaxed">
                  {card.body}
                </Typography>
              </div>
            ))}
          </div>
        </section>

        {/* ------------------------------------------------------------------ the tools */}
        <Section
          id="tools"
          title="What it can do"
          lead="Nine built-in tools, plus one for each skill on your account. They fall into groups that
                fail in completely different ways, which is why the groups are named rather than left to be
                discovered: one half answers from the account, the other needs your computer to be awake and
                listening."
        >
          <div className="grid gap-4">
            {GROUP_ORDER.map((group) => (
              <div key={group} className={cn('rounded-xl border p-4 sm:p-5', GROUP_TONE[group])}>
                <Typography variant="span" weight="semibold" className="block text-[0.98rem]">
                  {TOOL_GROUPS[group].title}
                </Typography>
                <Typography variant="p" className="mt-1 max-w-[70ch] text-[0.86rem] text-ink-body leading-relaxed">
                  {TOOL_GROUPS[group].note}
                </Typography>
                <ul className="mt-4 grid gap-3">
                  {MCP_TOOLS.filter((tool) => tool.group === group).map((tool) => (
                    <li key={tool.name} className="rounded-lg border-stroke border bg-surface-card p-3">
                      <code className="font-mono font-semibold text-[0.84rem] text-brand-primary">
                        {tool.name}
                      </code>
                      <Typography variant="p" className="mt-1 max-w-[74ch] text-[0.86rem] text-ink-body leading-relaxed">
                        {tool.what}
                      </Typography>
                      <Typography variant="p" className="mt-1 font-mono text-[0.76rem] text-ink-inactive">
                        {tool.args}
                      </Typography>
                    </li>
                  ))}
                </ul>
              </div>
            ))}
          </div>

          <div className="mt-4 rounded-xl border-stroke border bg-surface-card2 p-4">
            <Typography variant="span" weight="semibold" className="block text-[0.9rem]">
              And one tool per skill
            </Typography>
            <Typography variant="p" className="mt-1 max-w-[74ch] text-[0.86rem] text-ink-body leading-relaxed">
              A skill you recorded is offered with the two knobs a replay really has —{' '}
              <code className="font-mono text-[0.8rem]">repeat</code> and{' '}
              <code className="font-mono text-[0.8rem]">speed</code>. A skill you described in words is
              offered with the parameters its goal declares, and a parameter the author left no example for
              is <strong>required</strong>, so a call with a hole in it is refused by name rather than run
              with a guess. What the model is told about a skill is the same sentence the Skills page shows
              you, because both are generated from the skill itself.
            </Typography>
          </div>
        </Section>

        {/* ------------------------------------------------------------------ connecting */}
        <Section
          id="connect"
          title="Connecting it"
          lead="Three ways in. The first is the one to use unless you have a reason not to."
        >
          <div className="grid gap-4">
            {ways.map((way, index) => (
              <div key={way.id} className="rounded-xl border-stroke border bg-surface-card p-4 sm:p-5">
                <div className="flex flex-wrap items-baseline gap-x-3 gap-y-1">
                  <span className="grid size-6 shrink-0 place-items-center rounded-full bg-brand-primary/15 font-semibold text-[0.78rem] text-brand-primary">
                    {index + 1}
                  </span>
                  <Typography variant="span" weight="semibold" className="text-[0.98rem]">
                    {way.label}
                  </Typography>
                  <Typography variant="span" className="text-[0.84rem] text-ink-inactive">
                    {way.lead}
                  </Typography>
                </div>
                <ol className="mt-3 grid gap-2">
                  {way.steps.map((step) => (
                    <li key={step} className="text-[0.88rem] text-ink-body leading-relaxed">
                      {step.startsWith('$ ') ? (
                        <code className="block overflow-x-auto whitespace-nowrap rounded-md border-stroke border bg-surface-card2 px-2.5 py-2 font-mono text-[0.8rem] text-ink-primary">
                          {step.slice(2)}
                        </code>
                      ) : (
                        <span className="flex gap-2">
                          <span aria-hidden className="text-ink-inactive">·</span>
                          <span>{step}</span>
                        </span>
                      )}
                    </li>
                  ))}
                </ol>
                {way.note && (
                  <Typography variant="p" className="mt-3 max-w-[74ch] text-[0.82rem] text-ink-inactive leading-relaxed">
                    {way.note}
                  </Typography>
                )}
              </div>
            ))}
          </div>
        </Section>

        {/* ------------------------------------------------------------------ identity */}
        <Section
          id="identity"
          title="Who it lets in"
          lead="One account per connection, resolved from the credential on every single request. There is
                no route that takes an account id and no code path that reads one out of a message — which
                matters because the thing calling these tools is a language model, and one hallucinated id
                would otherwise be a way into somebody else's work."
        >
          <div className="grid gap-4 sm:grid-cols-2">
            <div className="rounded-xl border-stroke border bg-surface-card p-4">
              <Typography variant="span" weight="semibold" className="block text-[0.92rem]">
                Signing in with your account
              </Typography>
              <Typography variant="p" className="mt-1.5 text-[0.86rem] text-ink-body leading-relaxed">
                The connector registers itself, sends you to MouseFlow’s ordinary sign-in — Google, or your
                email and password — and asks you to approve on a page that lists what it will be able to
                do. What it ends up holding identifies <strong>you</strong>, not the installation. So a team
                adds one address and each person sees their own recordings, their own skills and their own
                machine. Every grant is listed under <strong>Settings → My account</strong> and revoking one
                cuts it off at once, access and refresh together.
              </Typography>
            </div>
            <div className="rounded-xl border-stroke border bg-surface-card p-4">
              <Typography variant="span" weight="semibold" className="block text-[0.92rem]">
                Or a device token, where there is no browser
              </Typography>
              <Typography variant="p" className="mt-1.5 text-[0.86rem] text-ink-body leading-relaxed">
                A token beginning <code className="font-mono text-[0.8rem]">mf_</code>, made under
                Settings → My account and shown once — only its hash is kept. It is the same credential the
                browser extension pairs with. It identifies an <em>installation</em> rather than a person,
                which is exactly why a connector an organisation installs once for everybody should not use
                one: everyone behind it would share a single account.
              </Typography>
            </div>
          </div>

          <div className="mt-4 rounded-xl border-stroke border bg-surface-card2 p-4">
            <Typography variant="p" className="max-w-[76ch] text-[0.85rem] text-ink-body leading-relaxed">
              For anybody checking the mechanism rather than taking it on trust: authorisation codes are
              single-use and last five minutes, PKCE is required and only S256 is accepted, redirect
              addresses are matched exactly against what the client registered, refresh tokens rotate on
              every use, and consent is a form somebody submits — never something a link can do on its own.
              Discovery is the documented chain: an unauthenticated call is refused with a pointer to the
              protected-resource document, which names the authorisation server, which names its endpoints.
            </Typography>
          </div>
        </Section>

        {/* ------------------------------------------------------------------ doing things */}
        <Section
          id="doing"
          title="When it asks your computer to do something"
          lead="Reading is a database question. Recording and replaying are not — they happen on a real
                machine with a real mouse — so they take a different path, and the difference is worth
                understanding before you connect anything."
        >
          <ol className="grid gap-3">
            {[
              {
                title: 'The request becomes a job on your account',
                body: 'Nothing on the internet can dial into your computer, and nothing should be able to. '
                  + 'So a call like "start recording" is written down on the account instead.',
              },
              {
                title: 'Your computer asks whether there is any',
                body: 'The MouseFlow agent — the one already running for the Record button — asks your '
                  + 'account for work, takes the job, does it through the same code path the app uses, and '
                  + 'reports back. The connection only ever goes outward.',
              },
              {
                title: 'The app asks you first, at the moment it matters',
                body: 'If nothing on that computer is listening yet, a banner appears in MouseFlow saying '
                  + 'what was asked for — “Claude asked to start a recording here” — with one button that '
                  + 'lets it through. Consent arrives with the request rather than as a switch somebody has '
                  + 'to guess about in advance.',
              },
              {
                title: 'And you can switch it off where you can see it',
                body: 'The agent’s own menu — the cursor icon at the top of the screen — carries “Let My AI '
                  + 'Act On This Mac”. Off, it makes no outbound call at all: no polling, nothing. The same '
                  + 'switch is in the app under Settings → Connections.',
              },
              {
                title: 'The answer waits for the work',
                body: 'A tool that returned before anything happened would have told the caller nothing, so '
                  + 'the call waits about 25 seconds. If the work is longer than that, the answer names a '
                  + 'run id, and mouseflow_run_status reports on it. mouseflow_stop cancels.',
              },
            ].map((step, n) => (
              <li key={step.title} className="flex gap-3 rounded-xl border-stroke border bg-surface-card p-4">
                <span className="grid size-6 shrink-0 place-items-center rounded-full bg-brand-primary/15 font-semibold text-[0.78rem] text-brand-primary">
                  {n + 1}
                </span>
                <div className="min-w-0">
                  <Typography variant="span" weight="semibold" className="block text-[0.9rem]">
                    {step.title}
                  </Typography>
                  <Typography variant="p" className="mt-1 max-w-[74ch] text-[0.86rem] text-ink-body leading-relaxed">
                    {step.body}
                  </Typography>
                </div>
              </li>
            ))}
          </ol>
        </Section>

        {/* ------------------------------------------------------------------ the refusals */}
        <Section
          id="limits"
          title="What it will not do"
          lead="The list is short and it is the reason this is safe to hand to a model at all."
        >
          <ul className="grid gap-3 sm:grid-cols-2">
            {[
              {
                title: 'No free-text goal',
                body: 'There is no tool that runs a sentence on your desktop. A skill is bounded by what '
                  + 'its author recorded or wrote; a sentence is bounded by nothing.',
              },
              {
                title: 'It cannot read what you typed',
                body: 'The recorder captures that a key was pressed, never which key. Nothing anywhere '
                  + 'holds the text, so nothing can hand it over — including this.',
              },
              {
                title: 'No raw events',
                body: 'Tools answer with metadata and prose. There is no way to pull the recorded stream of '
                  + 'coordinates and clicks out of an account through here.',
              },
              {
                title: 'One thing at a time',
                body: 'There is one mouse. A second request while something is running is refused with what '
                  + 'is already going, rather than queued behind it.',
              },
              {
                title: 'Browser skills are listed, not run',
                body: 'A skill that aims at elements in a web page needs the MouseFlow extension to replay '
                  + 'it. It is still listed — being told you have eleven skills and offered four is worse '
                  + 'than useless — and it refuses with the reason.',
              },
              {
                title: 'It cannot see your agent',
                body: 'The agent listens on your machine’s own loopback and this server is not on that '
                  + 'machine. mouseflow_status reports what the account knows and says plainly which half '
                  + 'it cannot see, rather than guessing.',
              },
            ].map((item) => (
              <li key={item.title} className="rounded-xl border-stroke border bg-surface-card p-4">
                <Typography variant="span" weight="semibold" className="block text-[0.9rem]">
                  {item.title}
                </Typography>
                <Typography variant="p" className="mt-1 text-[0.86rem] text-ink-body leading-relaxed">
                  {item.body}
                </Typography>
              </li>
            ))}
          </ul>
        </Section>

        <section className="border-stroke border-t py-10">
          <div className="flex flex-wrap items-center gap-3">
            <Link to="/record">
              <Button size="sm">Open MouseFlow</Button>
            </Link>
            <Link to="/connect">
              <Button size="sm" variant="secondary">Install the agent</Button>
            </Link>
            <Typography variant="span" className="text-[0.82rem] text-ink-inactive">
              The whole reference, including every error sentence and what to do about it, is
              <code className="mx-1 font-mono text-[0.78rem]">docs/product/21-mcp.md</code>
              in the repository.
            </Typography>
          </div>
        </section>
      </div>
    </div>
  );
};
