/* One recording, handed to the assistant on the Dashboard.
 *
 * Written into a module rather than into the URL, which is the same choice `features/record/adopt.ts` makes
 * and for the same reason: the assistant is a component the Dashboard owns, the handoff is a one-shot
 * intention rather than a location, and a search param on a route with no `validateSearch` is a typing
 * argument that buys nothing here. The cost is that the result is not a link somebody can share, which is
 * fine for "open this in the assistant" and would not be for a saved conversation.
 *
 * Taken exactly once. If the Dashboard is opened again by hand it must not re-ask the last question - that
 * would put the same request at the top of an empty thread every time somebody navigated there, and it is
 * the kind of thing that reads as the app deciding what you wanted.
 */
let pending: { id: string; name: string } | null = null;

/** Called by the transcript panel, just before navigating to the Dashboard. */
export function askAbout(id: string, name: string) {
  pending = { id, name };
}

/** Consumed by the Dashboard on mount. Null on every visit that was not sent from a recording. */
export function takeAsk(): { id: string; name: string } | null {
  const was = pending;
  pending = null;
  return was;
}

/* The question, in one place because two of them would drift and this one is doing real work: it names the
 * recording AND its id, because the id is what `get_transcript` needs and a name is what a person will
 * recognise in the reply. Phrased as the three things a recording is actually opened to answer. */
export function openingQuestion(ask: { id: string; name: string }): string {
  return `Analyse my recording "${ask.name}" (id ${ask.id}). What happened in it, where did the time go, `
    + 'and is there anything in it worth automating or cutting?';
}
