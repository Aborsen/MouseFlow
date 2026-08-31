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
/* ЧЕГО от ассистента хотят, а не только О ЧЁМ. Две кнопки открывают его об одной записи с разными
 * просьбами - разобрать её или написать по ней процесс, - и намерение едет вместе с записью, потому что
 * иначе вторая кнопка была бы первой с другой надписью. */
export type Want = 'analyse' | 'document';

let pending: { id: string; name: string; want: Want } | null = null;

/** Called by the transcript panel, just before navigating to the Dashboard. */
export function askAbout(id: string, name: string, want: Want = 'analyse') {
  pending = { id, name, want };
}

/** Consumed by the Dashboard on mount. Null on every visit that was not sent from a recording. */
export function takeAsk(): { id: string; name: string; want: Want } | null {
  const was = pending;
  pending = null;
  return was;
}

/* The questions, in ONE place because separate ones would drift, and both are doing real work: each names
 * the recording AND its id, because the id is what get_transcript needs and the name is what a person will
 * recognise in the reply.
 *
 * The document one asks for the TOOL BY NAME. Not to be clever about prompting: write_process_doc writes a
 * row and costs a model call, and "document this" without naming it is an invitation to answer with prose
 * in the chat instead - which is the shape this whole feature exists to replace. It also says where to send
 * the person afterwards, because a document written and not mentioned is a document nobody opens. */
export function openingQuestion(ask: { id: string; name: string; want?: Want }): string {
  if (ask.want === 'document') {
    return `Write the process document for my recording "${ask.name}" (id ${ask.id}) using `
      + 'write_process_doc. Then tell me its title and that it is in the Documents tab of the Gallery, '
      + 'where I can correct it - do not paste the document into the chat.';
  }
  return `Analyse my recording "${ask.name}" (id ${ask.id}). What happened in it, where did the time go, `
    + 'and is there anything in it worth automating or cutting?';
}
