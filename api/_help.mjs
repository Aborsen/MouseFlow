/* The product's own documentation, as something an AI can be asked.
 *
 * WHY A TOOL AND NOT A PARAGRAPH IN A PROMPT. "How does MouseFlow work?" is the question every assistant
 * connected to this account gets asked first, and until now there was nothing to answer it with. A model
 * answers such a question anyway - from the tool list, from the product's name, from whatever it read in
 * training - and the answer is fluent, specific and wrong in the places that matter: what is captured, what
 * is never captured, which half can replay what. A tool that returns the actual page is the difference
 * between an answer and a plausible one.
 *
 * WHERE THE TEXT COMES FROM, and this is the whole design: https://mouseflow.ai/docs, fetched. The site
 * emits every page as markdown at /docs/llms.json (see scripts/prerender.mjs in the MouseLanding repo), and
 * this reads that. It is not the convenient choice - it is a network call, and a second system that can be
 * down - but the alternative is a copy of the same prose kept in this repository, and a copy drifts. Two
 * texts disagreeing about what MouseFlow records is exactly the failure this product exists to argue
 * against, and a stale copy is worse than a fetch that failed: a failed fetch says so.
 *
 * WHAT IT DOES NOT DO. No model call, no summarising, no answering in its own words. It returns the
 * sections and their addresses; the assistant that asked already has a model in it, and a second voice
 * paraphrasing the docs on the way through is one more place for the answer to stop being true.
 */

/** Where the corpus lives. Overridable so a deploy can point at its own build of the site. */
export const DOCS_URL = process.env.MOUSEFLOW_DOCS_URL || 'https://mouseflow.ai/docs/llms.json';

/* Ten minutes. The docs change when somebody deploys the site, which is not often; a serverless instance
 * lives for minutes anyway, so this is about not fetching the corpus again for every question in one
 * conversation. */
export const DOCS_TTL_MS = 10 * 60_000;

/** How much text one answer may carry. Six pages of prose would push the conversation out of the way. */
export const HELP_CHARS = 9_000;
/** And how much of any single section, before it is cut and its address given instead. */
export const SECTION_CHARS = 2_400;

/* ------------------------------------------------------------------------------ reading the corpus */

let cache = { at: 0, corpus: null };

/** For tests, and for a deploy that wants a cold read. */
export const forgetDocs = () => { cache = { at: 0, corpus: null }; };

/**
 * The pages, or the last ones read and a reason. Never throws: a help tool that fails the request because
 * a marketing site is down is worse than one that says which page to open in a browser.
 */
export async function readDocs({ now = Date.now(), fetchImpl = fetch, url = DOCS_URL } = {}) {
  if (cache.corpus && now - cache.at < DOCS_TTL_MS) return { corpus: cache.corpus, why: '' };

  try {
    const res = await fetchImpl(url, { headers: { accept: 'application/json' } });
    if (!res.ok) throw new Error('HTTP ' + res.status);
    const body = await res.json();
    const pages = (body && Array.isArray(body.pages) ? body.pages : [])
      .filter((one) => one && one.id && typeof one.markdown === 'string');
    if (!pages.length) throw new Error('the corpus held no pages');
    cache = { at: now, corpus: { site: (body && body.site) || '', pages } };
    return { corpus: cache.corpus, why: '' };
  } catch (err) {
    /* Пришпиленной копии здесь нет нарочно - см. заголовок. Поэтому это не пустой ответ, а сказанная
     * причина и адрес: спросивший может открыть страницу сам, и это честнее любого угаданного абзаца. */
    return { corpus: cache.corpus, why: `The documentation could not be read (${err.message}).` };
  }
}

/* ------------------------------------------------------------------------------ pages into sections */

const STRIP_FRONTMATTER = /^---\n[\s\S]*?\n---\n/;

/**
 * One page's sections, in order, at the FINEST heading it has: `## ` first, and every `### ` under it as a
 * section of its own, named "Parent - Child".
 *
 * Не косметика, а то, попадёт ли ответ в ответ. «Making one» на странице про скиллы - это весь визард: три
 * шага и все их правила. Отданная целиком, она обрезается по потолку раньше, чем дойдёт до того абзаца, из
 * которого и был задан вопрос. Мелкий раздел и находится точнее, и влезает целиком.
 */
export function sectionsOf(page) {
  const body = String((page && page.markdown) || '').replace(STRIP_FRONTMATTER, '').trim();
  const out = [];
  const head = (part) => {
    const nl = part.indexOf('\n');
    return {
      heading: (nl > -1 ? part.slice(0, nl) : part).trim(),
      text: (nl > -1 ? part.slice(nl + 1) : '').trim(),
    };
  };

  const parts = body.split(/^## /m);
  const lead = parts.shift();
  if (lead && lead.trim()) out.push({ heading: '', text: lead.trim() });
  for (const part of parts) {
    const { heading, text } = head(part);
    const deeper = text.split(/^### /m);
    const own = (deeper.shift() || '').trim();
    out.push({ heading, text: own });
    for (const one of deeper) {
      const inner = head(one);
      out.push({ heading: heading + ' - ' + inner.heading, text: inner.text });
    }
  }
  return out.filter((one) => one.heading || one.text);
}

/* Слова, которые есть в любом вопросе и потому ничего не отбирают. Список короткий нарочно: чем длиннее
 * стоп-лист, тем выше шанс выбросить слово, которое в ЭТОМ продукте несёт смысл - «run», «type», «keys». */
const NOISE = new Set(['the', 'and', 'for', 'with', 'what', 'how', 'does', 'can', 'this', 'that', 'from',
  'are', 'was', 'you', 'your', 'not', 'but', 'its', 'about', 'when', 'why', 'who', 'where', 'mouseflow',
  'app', 'application', 'work', 'works', 'tell', 'explain']);

/** The words of a question that are worth matching on. */
export function termsOf(question) {
  return [...new Set(String(question || '').toLowerCase().match(/[a-z][a-z0-9-]{2,}/g) || [])]
    .filter((one) => !NOISE.has(one));
}

const count = (text, term) => {
  let n = 0;
  let at = text.indexOf(term);
  while (at > -1 && n < 6) { n++; at = text.indexOf(term, at + term.length); }
  return n;
};

/**
 * Sections that answer the question, best first. Weighted towards HEADINGS and page titles rather than
 * towards how often a word appears: "privacy" in the heading of the privacy page beats it said nine times
 * in passing somewhere else, which is how a person picks a page too.
 */
export function findHelp(corpus, question, { limit = 4 } = {}) {
  const terms = termsOf(question);
  if (!terms.length) return [];
  const hits = [];
  for (const page of corpus.pages) {
    const title = String(page.title || '').toLowerCase();
    for (const section of sectionsOf(page)) {
      const heading = section.heading.toLowerCase();
      const text = section.text.toLowerCase();
      let score = 0;
      for (const term of terms) {
        if (heading.includes(term)) score += 6;
        if (title.includes(term)) score += 3;
        score += count(text, term);
      }
      if (score > 0) hits.push({ page, section, score });
    }
  }
  hits.sort((a, b) => b.score - a.score || a.page.id.localeCompare(b.page.id));
  return hits.slice(0, limit);
}

/* ------------------------------------------------------------------------------ what the tool answers */

const cut = (text, max) => (text.length <= max ? text : text.slice(0, max - 1).trimEnd() + '…');

const linkOf = (page) => page.url || page.path || ('/docs/' + (page.slug || ''));

/** Every page, one line each. The answer when nothing was asked, and the fallback when nothing matched. */
export function pageList(corpus) {
  return corpus.pages
    .map((one) => `- **${one.title || one.id}** (\`${one.id}\`) - ${one.description || ''}\n  ${linkOf(one)}`)
    .join('\n');
}

/** One whole page, capped. */
export function pageText(corpus, wanted) {
  const key = String(wanted || '').trim().toLowerCase();
  const page = corpus.pages.find((one) => one.id === key || one.slug === key)
    || corpus.pages.find((one) => String(one.title || '').toLowerCase() === key);
  if (!page) {
    return {
      ok: false,
      text: `There is no documentation page called "${wanted}". The pages are:\n\n${pageList(corpus)}`,
    };
  }
  const body = String(page.markdown || '').replace(STRIP_FRONTMATTER, '').trim();
  return { ok: true, text: `# ${page.title || page.id}\n${linkOf(page)}\n\n${cut(body, HELP_CHARS)}` };
}

/**
 * The answer to a question: the sections that carry it, each with the page it is on and that page's
 * address, so whoever reads the reply can be pointed at the page rather than only quoted at.
 */
export function answerText(corpus, question) {
  const hits = findHelp(corpus, question);
  if (!hits.length) {
    return `Nothing in the documentation matched "${question}". The pages are:\n\n${pageList(corpus)}\n\n`
      + 'Ask for one of them by id to read it whole.';
  }
  let left = HELP_CHARS;
  const parts = [];
  for (const hit of hits) {
    const from = hit.page.title || hit.page.id;
    const head = `## ${hit.section.heading || from}\nFrom **${from}** - ${linkOf(hit.page)}\n\n`;
    const room = Math.min(SECTION_CHARS, left - head.length);
    if (room < 240) break;
    parts.push(head + cut(hit.section.text, room));
    left -= head.length + Math.min(hit.section.text.length, room);
  }
  return parts.join('\n\n---\n\n');
}

/**
 * The whole tool, in one call: what to say for a question, for a page, or for neither.
 *
 * A reason is prepended rather than thrown - see readDocs. When the site could not be read at all there is
 * no corpus to answer from, and saying so with the address of the docs is the honest end of it.
 */
export async function help({ question = '', page = '' } = {}, options = {}) {
  const { corpus, why } = await readDocs(options);
  if (!corpus) {
    return `${why} MouseFlow's documentation is at https://mouseflow.ai/docs and can be read there. `
      + 'Nothing about how the product works is answered from memory here, deliberately: an answer that was '
      + 'not read out of the documentation is a guess, and the questions people ask first are the ones '
      + 'about what is and is not recorded.';
  }
  const prefix = why ? `${why} Answering from the last copy that was read.\n\n` : '';
  if (page) return prefix + pageText(corpus, page).text;
  if (String(question).trim()) return prefix + answerText(corpus, question);
  return prefix + `MouseFlow's documentation, ${corpus.pages.length} pages:\n\n${pageList(corpus)}\n\n`
    + 'Ask again with a question to get the sections that answer it, or with a page id to read one whole.';
}
