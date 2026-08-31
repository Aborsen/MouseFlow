/* A written process, made from what was actually recorded.
 *
 * WHY A DOCUMENT AND NOT A CHAT ANSWER. This was asked for as the thing that makes automation possible, and
 * the two candidate shapes were an option in the chatbot and an object you can keep. A chat answer is read
 * once and scrolled past; a procedure is edited, disagreed with, corrected by somebody who actually does the
 * job, and read again next quarter. Only the second shape supports being wrong and then fixed, which is the
 * normal life of a written procedure - a generated one most of all.
 *
 * WHY OPENAI HERE AND CLAUDE EVERYWHERE ELSE. Asked for, explicitly: documents on gpt-5.6-terra at
 * reasoning effort medium, the assistant unchanged. So the model and the effort are PINNED in this file
 * rather than read from the deployment's OPENAI_MODEL - a document written at whatever the environment
 * happened to say would be a document whose provenance nobody can reconstruct, and the row stores both.
 *
 * WHAT IT IS WRITTEN FROM, and this is the whole of it: the transcript api/_transcript.js derives, reached
 * through the same tool the assistant uses to read one. Not the payload, not a second summariser. A line in
 * a document and a line in the Record panel therefore cannot disagree about what happened, and when the
 * transcript could only be delivered in part - a 6705-step recording does not fit in a prompt - the document
 * is told which ranges were left out and has to say so.
 */
import { ask } from './_provider.js';

/* PINNED, not defaulted. See the note above: the deployment's own OPENAI_MODEL drives the assistant's
 * optional OpenAI path, and a document has to be reproducible from its own row. */
export const DOC_MODEL = 'gpt-5.6-terra';
export const DOC_EFFORT = 'medium';

/* Room for a procedure. Long enough for a real one - the measured recordings here run to 142 places - and
 * short enough that a model asked for a document cannot answer with a book. */
export const DOC_TOKENS = 6000;

/* Ids are minted here rather than by the client, unlike chat_thread: a document does not exist before it is
 * written, and what writes it is a tool call on the server. */
export const newDocId = (random) => 'doc_' + random;

/* ---------------------------------------------------------------------------- the prompt
 *
 * Every rule below is here because its absence has a specific failure, and the failures are the same ones
 * this whole product is built against: a plausible number, a step that never happened, a procedure that
 * cannot be checked.
 */
export const DOC_SYSTEM = [
  'You write a process document from a recording of somebody doing the work. It will be read by a person',
  'who has to do the same job, and by somebody deciding whether to automate it.',
  '',
  'WHAT YOU ARE GIVEN. The transcript of one recording, as JSON: stretches of work, each in a named place',
  'and holding numbered steps. The numbers are the only handle anybody has on the evidence.',
  '',
  'RULES, and none of them is stylistic:',
  '- Every instruction you write must cite the step it came from, inline, like [step 41]. A range is',
  '  [steps 41-48]. A procedure whose lines cannot be traced back cannot be checked, and the one way prose',
  '  written from data goes wrong is a gap filled with something plausible.',
  '- Write nothing you did not read. If the transcript does not say why something was done, say that the',
  '  recording does not show why, and carry on. Do not supply a reason.',
  '- If the transcript says ranges of steps were omitted to fit, the document must say so, in its own',
  '  section, naming the ranges. A procedure that looks complete and is not is worse than a short one.',
  '- TYPED TEXT IS NOT RECORDED. The recorder stores that a key was pressed and which key, never the words.',
  '  So where the work involved typing, write which field was typed into and say that the content is not',
  '  recorded. Never invent the content, and never imply it was captured. Include this as a stated',
  '  limitation of the document rather than only as a remark in passing.',
  '- Pointer coordinates, window titles and control names are what the recording holds. Use the names.',
  '',
  'SHAPE. Markdown. A title on the first line as "# ...". Then, in this order and only these:',
  '  ## What this process does - two or three sentences.',
  '  ## Before you start - what has to be open or true, only if the transcript shows it.',
  '  ## Steps - numbered, one action each, each citing its step. This is the body of the document.',
  '  ## Where the time went - only if the transcript gives durations worth naming.',
  '  ## What this document cannot tell you - the omitted ranges, the typed text, anything the',
  '  transcript refused. Always present, never empty: there is always at least the typing.',
  '',
  'No preamble, no closing offer, no note about being an AI. Start with the "# " line.',
].join('\n');

/* What the model is shown, and it is deliberately the tool result rather than something reshaped for it.
 *
 * The assistant's own get_transcript already decides what fits, thins the stretches to a budget, and
 * REPORTS what it left out. Reshaping that here would be a second packer with a second idea of what fits,
 * and the two would disagree about which steps exist - which is exactly the disagreement the citations are
 * supposed to make impossible. */
export function docPrompt({ transcript, name, focus }) {
  const lines = [
    name ? 'The recording is called "' + String(name).slice(0, 200) + '".' : '',
    focus ? 'The person asking wants the document focused on: ' + String(focus).slice(0, 400) : '',
    '',
    'The transcript, as the assistant\'s own get_transcript returned it:',
    JSON.stringify(transcript),
  ];
  return lines.filter(Boolean).join('\n');
}

/* Write one. Returns { title, body, model, effort, usage } or throws ProviderError.
 *
 * THE TITLE IS TAKEN FROM THE BODY, not asked for separately: two fields for one name is two names, and the
 * one somebody will edit is the heading they can see. Falls back to the recording's name, and then to a
 * plain label - never to an empty string, because a document with no name is a row nobody can find. */
export async function writeDoc({ transcript, name, focus }) {
  const reply = await ask({
    model: DOC_MODEL,
    effort: DOC_EFFORT,
    system: DOC_SYSTEM,
    /* `text`, НЕ `content`. Это форма, которую читает api/_provider.js - см. buildTranscript в
     * api/chat.js, который её и строит. С `content` сообщение молча выпадало, input уходил пустым, и
     * OpenAI отвечал «One of input or previous_response_id or prompt or conversation must be provided»:
     * сообщение точное и совершенно не про то, что было не так. ask() теперь такой массив не пропустит. */
    messages: [{ role: 'user', text: docPrompt({ transcript, name, focus }) }],
    maxTokens: DOC_TOKENS,
  });

  /* Neither of these is a document, and both have been returned as one by a model before. Truncated means
   * the procedure stops mid-step, which is the worst possible place for a procedure to stop. */
  if (reply.stopReason === 'truncated') {
    throw new Error('the model ran out of room before finishing the document, so the procedure would stop '
      + 'mid-step. Ask for a narrower focus, or document a shorter recording.');
  }
  if (reply.stopReason === 'refused') {
    throw new Error('the model declined to write this document.');
  }

  const body = String(reply.text || '').trim();
  if (!body) throw new Error('the model returned nothing to save.');

  return {
    title: titleOf(body) || String(name || '').trim() || 'A recorded process',
    body,
    model: DOC_MODEL,
    effort: DOC_EFFORT,
    usage: reply.usage,
  };
}

/** The first `# ` heading, which is the name the document shows and therefore the name it has. */
export function titleOf(body) {
  for (const line of String(body || '').split('\n')) {
    const m = line.match(/^#\s+(.+?)\s*$/);
    if (m) return m[1].slice(0, 200);
  }
  return '';
}

/* Which steps a document claims to rest on.
 *
 * Parsed from the body rather than stored beside it, and that is the same decision as keeping the citations
 * inline: people edit the body afterwards, and a list kept elsewhere goes stale the moment a line moves.
 * Read on demand, so it is always about the text as it stands now. */
export function citedSteps(body) {
  const found = new Set();
  const text = String(body || '');
  /* Both spellings the prompt asks for, and only those: a looser pattern would read "step 3" out of a
   * sentence that was talking about something else. */
  for (const m of text.matchAll(/\[step\s+(\d+)\]/gi)) found.add(Number(m[1]));
  for (const m of text.matchAll(/\[steps\s+(\d+)\s*-\s*(\d+)\]/gi)) {
    const from = Number(m[1]);
    const to = Number(m[2]);
    /* A backwards range is a typo, not a range: taken as the two ends it names rather than expanded, which
     * would either loop for ever or silently swallow it. */
    if (to >= from && to - from <= 500) {
      for (let n = from; n <= to; n++) found.add(n);
    } else {
      found.add(from);
      found.add(to);
    }
  }
  return [...found].sort((a, b) => a - b);
}
