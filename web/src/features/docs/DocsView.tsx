/* Process documents: read one, correct it, put a version back.
 *
 * WHY THIS SCREEN EXISTS AT ALL. A generated procedure is wrong somewhere - that is its normal condition,
 * not its failure - and the person who knows where is the one who does the job. So the whole design question
 * was "what does it take to disagree with this document", and the answer is: read it beside its evidence,
 * change a line, and be able to go back. Everything here serves those three.
 *
 * WHAT IS NOT HERE, deliberately: no writing. A document is made by asking the assistant, because making one
 * means reading a transcript and paying a model, and both belong where the assistant's rules and budget
 * already are. This screen says so rather than offering a button that would be a second route to it.
 *
 * NO MARKDOWN LIBRARY. The bodies are written to one shape by one prompt - a heading, a few named sections,
 * a numbered list - and rendering that is a fold over lines. A dependency for six cases would be larger
 * than the feature, and the same argument the dashboard makes about chart libraries. The one thing rendering
 * has to get right is the citations, and no library would know about those.
 */
import { useNavigate, useParams } from '@tanstack/react-router';
import {
  ArrowLeft,
  ArrowRight,
  BookText,
  Bot,
  Clock,
  Download,
  FileText,
  Loader2,
  Pencil,
  RotateCcw,
  Save,
  Sparkles,
  Trash2,
  TriangleAlert,
  User,
  X,
} from 'lucide-react';
import { type ReactNode, useCallback, useEffect, useMemo, useState } from 'react';
import { Button } from '@insightis/ui/Button';
import { Typography } from '@insightis/ui/Typography';
import { cn } from '@insightis/ui/cn';
import { Said, type SaidNote } from '@/components/Said';
import { usePageChrome } from '@/shell/Surface';
import { docxFromMarkdown, docxName } from './docx';

/* ------------------------------------------------------------------ what the endpoint sends */

interface DocRow {
  id: string;
  title: string;
  opening: string | null;
  flowIds: string[];
  model: string | null;
  effort: string | null;
  revision: number;
  bytes: number;
  created: string | null;
  updated: string | null;
}

interface DocFull {
  id: string;
  title: string;
  body: string;
  flowIds: string[];
  model: string | null;
  effort: string | null;
  revision: number;
  created: string | null;
  updated: string | null;
}

interface Version {
  revision: number;
  title: string;
  body: string;
  /** 'model' or 'person' — the distinction is the point of keeping versions at all. */
  writtenBy: 'model' | 'person';
  at: string | null;
}

const list = <T,>(v: T[] | undefined | null): T[] => (Array.isArray(v) ? v : []);

const call = async <T,>(url: string, init?: RequestInit): Promise<T> => {
  const res = await fetch(url, { credentials: 'same-origin', ...init });
  const body = (await res.json().catch(() => null)) as (T & { error?: { message?: string } }) | null;
  /* The endpoint's own words. It knows whether this was a 404, a 409 or a deployment with no database, and
   * "something went wrong" would throw away the only useful thing on the screen. */
  if (!res.ok || !body) throw new Error(body?.error?.message ?? `the server answered ${res.status}`);
  return body;
};

const fmtWhen = (iso: string | null): string => {
  if (!iso) return 'unknown';
  const then = +new Date(iso);
  if (!Number.isFinite(then)) return 'unknown';
  const mins = Math.floor((Date.now() - then) / 60000);
  if (mins < 1) return 'just now';
  if (mins < 60) return `${mins} min ago`;
  const hours = Math.floor(mins / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.floor(hours / 24);
  /* «1 day», не «1 days». Мелочь, которую видно в первой же строке списка версий, и ровно та мелочь, по
     которой читатель решает, писал ли это кто-нибудь внимательный. */
  if (days < 14) return days === 1 ? 'a day ago' : `${days} days ago`;
  return new Date(then).toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
};

/* ------------------------------------------------------------------ rendering the body
 *
 * THE CITATIONS ARE THE POINT. Every instruction in a generated document carries [step 41] or
 * [steps 41-48], and a reader following the procedure needs to reach the evidence - so they are rendered as
 * buttons and not as text. Pressing one opens the recording it came from, at that step.
 *
 * Split on the citation pattern rather than searched for: replacing matches in a string would mean building
 * HTML, and this file has no business producing markup from text it did not write.
 */
const CITE = /(\[steps?\s+\d+(?:\s*-\s*\d+)?\])/gi;

const Cited = ({ text, onOpen }: { text: string; onOpen?: (step: number) => void }) => (
  <>
    {text.split(CITE).map((piece, i) => {
      const m = piece.match(/^\[steps?\s+(\d+)(?:\s*-\s*(\d+))?\]$/i);
      if (!m) return <span key={i}>{piece}</span>;
      const from = Number(m[1]);
      return (
        <button
          key={i}
          type="button"
          onClick={() => onOpen?.(from)}
          title={`Open the recording at step ${from}`}
          className={cn(
            'mx-0.5 rounded bg-brand-primary/12 px-1 py-px align-baseline font-medium text-[0.78rem]',
            'text-brand-primary tabular-nums transition-colors duration-fast hover:bg-brand-primary/20',
            'focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-1',
            'focus-visible:outline-brand-primary',
          )}
        >
          {piece.replace(/[[\]]/g, '')}
        </button>
      );
    })}
  </>
);

/* One pass over the lines. Six cases, because six is what the prompt asks for - and a case it does not
 * recognise is rendered as a paragraph rather than dropped: a document is text somebody edits afterwards,
 * and a renderer that silently swallows an unexpected line loses their work in front of them. */
const Markdown = ({ body, onOpenStep }: { body: string; onOpenStep?: (step: number) => void }) => {
  const blocks = useMemo(() => {
    const out: { kind: string; text: string; n?: number }[] = [];
    for (const raw of String(body || '').split('\n')) {
      const line = raw.replace(/\s+$/, '');
      if (!line.trim()) { out.push({ kind: 'gap', text: '' }); continue; }
      const h1 = line.match(/^#\s+(.*)$/);
      if (h1) { out.push({ kind: 'h1', text: h1[1] }); continue; }
      const h2 = line.match(/^###?\s+(.*)$/);
      if (h2) { out.push({ kind: 'h2', text: h2[1] }); continue; }
      const num = line.match(/^\s*(\d+)[.)]\s+(.*)$/);
      if (num) { out.push({ kind: 'step', text: num[2], n: Number(num[1]) }); continue; }
      const bullet = line.match(/^\s*[-*+]\s+(.*)$/);
      if (bullet) { out.push({ kind: 'bullet', text: bullet[1] }); continue; }
      out.push({ kind: 'p', text: line });
    }
    return out;
  }, [body]);

  return (
    <div className="max-w-[76ch] space-y-1">
      {blocks.map((block, i) => {
        if (block.kind === 'gap') return <div key={i} className="h-2" />;
        if (block.kind === 'h1') {
          return (
            <Typography key={i} variant="h2" weight="semibold" className="mt-1 text-[1.35rem] leading-tight tracking-tight">
              {block.text}
            </Typography>
          );
        }
        if (block.kind === 'h2') {
          return (
            <Typography key={i} variant="h3" weight="semibold" className="mt-4 text-[0.95rem] uppercase tracking-wide text-ink-secondary">
              {block.text}
            </Typography>
          );
        }
        if (block.kind === 'step') {
          return (
            <div key={i} className="flex gap-2.5 rounded-md px-1 py-1 odd:bg-surface-chips/40">
              <span className="w-6 shrink-0 text-right font-semibold text-[0.82rem] text-ink-inactive tabular-nums">
                {block.n}
              </span>
              <span className="min-w-0 flex-1 break-words text-[0.9rem] leading-relaxed text-ink-body">
                <Cited text={block.text} onOpen={onOpenStep} />
              </span>
            </div>
          );
        }
        if (block.kind === 'bullet') {
          return (
            <div key={i} className="flex gap-2.5 px-1">
              <span className="shrink-0 text-ink-inactive">·</span>
              <span className="min-w-0 flex-1 break-words text-[0.9rem] leading-relaxed text-ink-body">
                <Cited text={block.text} onOpen={onOpenStep} />
              </span>
            </div>
          );
        }
        return (
          <Typography key={i} variant="p" className="break-words text-[0.9rem] leading-relaxed text-ink-body">
            <Cited text={block.text} onOpen={onOpenStep} />
          </Typography>
        );
      })}
    </div>
  );
};

/* ------------------------------------------------------------------ the list */

const Empty = ({ children }: { children: ReactNode }) => (
  <Typography variant="p" className="text-ink-inactive text-[0.86rem]">{children}</Typography>
);

const DocsList = ({ docs, onOpen }: { docs: DocRow[]; onOpen: (id: string) => void }) => (
  <div className="space-y-2">
    {docs.map((doc) => (
      <button
        key={doc.id}
        type="button"
        onClick={() => onOpen(doc.id)}
        className={cn(
          'block w-full rounded-xl border-stroke border bg-surface-card p-4 text-left',
          'transition-colors duration-fast hover:border-brand-primary/40',
          'focus-visible:outline focus-visible:outline-2 focus-visible:outline-brand-primary',
        )}
      >
        <div className="flex flex-wrap items-baseline gap-x-2 gap-y-1">
          <Typography variant="span" weight="semibold" className="min-w-0 break-words text-[0.98rem]">
            {doc.title || 'Untitled'}
          </Typography>
          {/* Кем написан - рядом с именем, а не в подписи снизу: у сгенерированной процедуры это первое,
              что нужно знать, и «ревизия 1» значит «никто ещё не правил». */}
          <span className="inline-flex items-center gap-1 rounded-full bg-surface-chips px-1.5 py-0.5 text-[0.7rem] text-ink-inactive">
            {doc.revision > 1 ? <User className="size-3" /> : <Bot className="size-3" />}
            {doc.revision > 1 ? `edited · rev ${doc.revision}` : 'as written'}
          </span>
        </div>
        {doc.opening && (
          <Typography variant="p" className="mt-1 max-w-[80ch] break-words text-ink-secondary text-[0.84rem]">
            {doc.opening}
          </Typography>
        )}
        <div className="mt-1.5 flex flex-wrap gap-x-3 text-[0.75rem] text-ink-inactive">
          <span>{fmtWhen(doc.updated)}</span>
          {doc.model && <span>· {doc.model}</span>}
          <span>· from {doc.flowIds.length} recording{doc.flowIds.length === 1 ? '' : 's'}</span>
        </div>
      </button>
    ))}
  </div>
);

/* ------------------------------------------------------------------ the screen */

/* ВЛОЖЕННЫЙ ВИД - для вкладки внутри Галереи, где заголовок и отступы страницы уже чужие.
 *
 * Один компонент, а не два: список и один документ делят всё состояние, которое имеет значение - что
 * загружено, что отказало, что сказано, - и разделение продублировало бы это ради одного условия. Признак
 * `embedded` снимает только оболочку, потому что оболочка и есть единственное, что у вкладки своё. */
export const DocsView = ({ embedded = false }: { embedded?: boolean } = {}) => {
  const page = usePageChrome();
  const navigate = useNavigate();
  /* The route declares an optional param, so this screen is both the list and one document. One component
   * because the two share every piece of state that matters - what was loaded, what failed, what was said -
   * and splitting them would duplicate all of it to save one conditional. */
  const params = useParams({ strict: false }) as { docId?: string };
  const openId = params.docId || null;

  const [docs, setDocs] = useState<DocRow[] | null>(null);
  const [doc, setDoc] = useState<DocFull | null>(null);
  const [versions, setVersions] = useState<Version[]>([]);
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);
  const [note, setNote] = useState<SaidNote | null>(null);

  /* Editing is a MODE, not a field, and the draft is separate from the document: a save that failed must
   * leave the typing on screen. Losing an edit to a 409 would be the one unforgivable thing here. */
  const [draft, setDraft] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [showVersions, setShowVersions] = useState(false);
  const [armed, setArmed] = useState(false);

  const loadList = useCallback(async () => {
    setBusy(true);
    setProblem(null);
    try {
      const body = await call<{ docs: DocRow[] }>('/api/docs');
      setDocs(list(body.docs));
    } catch (err) {
      setProblem(err instanceof Error ? err.message : 'the documents could not be read');
    } finally {
      setBusy(false);
    }
  }, []);

  const loadOne = useCallback(async (id: string) => {
    setBusy(true);
    setProblem(null);
    try {
      const body = await call<{ doc: DocFull; versions: Version[] }>(`/api/docs?doc=${encodeURIComponent(id)}`);
      setDoc(body.doc);
      setVersions(list(body.versions));
      /* Черновик сбрасывается при загрузке: он принадлежит той ревизии, которую человек открыл, и
         перенесённый на новую был бы правкой поверх текста, которого правивший не видел. */
      setDraft(null);
      setArmed(false);
    } catch (err) {
      setProblem(err instanceof Error ? err.message : 'that document could not be read');
      setDoc(null);
    } finally {
      setBusy(false);
    }
  }, []);

  useEffect(() => {
    if (openId) void loadOne(openId);
    else { setDoc(null); setVersions([]); void loadList(); }
  }, [openId, loadOne, loadList]);

  const save = useCallback(async () => {
    if (!doc || draft == null) return;
    setSaving(true);
    setNote(null);
    try {
      const body = await call<{ revision: number; truncated?: boolean }>(
        `/api/docs?doc=${encodeURIComponent(doc.id)}`,
        {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          /* Ревизия, которую человек открыл, едет обратно: две вкладки на одном документе - это не
             экзотика, а то, что происходит, когда открывают версию, из которой копируют, рядом с той,
             которую правят. Сервер откажет, а не сольёт. */
          body: JSON.stringify({ body: draft, revision: doc.revision }),
        },
      );
      setNote({
        text: body.truncated
          ? `Saved as revision ${body.revision}, but the text was longer than this store allows and was cut. Check the end of it.`
          : `Saved as revision ${body.revision}. The previous text is kept.`,
        kind: body.truncated ? 'bad' : 'good',
      });
      setDraft(null);
      await loadOne(doc.id);
    } catch (err) {
      /* Черновик НЕ сбрасывается: отказ - это причина показать, что произошло, а не потерять набранное. */
      setNote({ text: err instanceof Error ? err.message : 'that could not be saved', kind: 'bad' });
    } finally {
      setSaving(false);
    }
  }, [doc, draft, loadOne]);

  const revertTo = useCallback(async (revision: number) => {
    if (!doc) return;
    setSaving(true);
    try {
      const body = await call<{ revision: number; restoredFrom: number }>(
        `/api/docs?doc=${encodeURIComponent(doc.id)}`,
        {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ revision }),
        },
      );
      setNote({
        /* Сказано, что откат НЕ стёр то, что заменил: иначе «поставить обратно» читается как выбор без
           возврата, и его не нажимают. */
        text: `Revision ${body.restoredFrom} is back, saved forward as ${body.revision} — so what it `
          + 'replaced is still there to return to.',
        kind: 'good',
      });
      setShowVersions(false);
      await loadOne(doc.id);
    } catch (err) {
      setNote({ text: err instanceof Error ? err.message : 'that revision could not be put back', kind: 'bad' });
    } finally {
      setSaving(false);
    }
  }, [doc, loadOne]);

  const remove = useCallback(async () => {
    if (!doc) return;
    if (!armed) {
      setArmed(true);
      setNote({
        text: 'This removes the document. Its versions are kept, and the recording it was written from is '
          + 'untouched. Press the bin again to go ahead, or dismiss this line to leave it alone.',
        kind: 'bad',
      });
      return;
    }
    setSaving(true);
    try {
      await call(`/api/docs?doc=${encodeURIComponent(doc.id)}`, { method: 'DELETE' });
      void navigate({ to: '/docs' });
    } catch (err) {
      setArmed(false);
      setNote({ text: err instanceof Error ? err.message : 'that could not be removed', kind: 'bad' });
    } finally {
      setSaving(false);
    }
  }, [armed, doc, navigate]);

  /* Тот же таймер и то же правило, что в панели расшифровки: снимая взведение, снимаем и предупреждение -
     иначе слова говорят «нажмите ещё раз», когда нажатие уже только взводит заново. */
  useEffect(() => {
    if (!armed) return;
    const timer = setTimeout(() => {
      setArmed(false);
      setNote((was) => (was && /Press the bin again/.test(was.text) ? null : was));
    }, 6000);
    return () => clearTimeout(timer);
  }, [armed]);

  const openStep = useCallback((step: number) => {
    /* В запись, на этом шаге. Экран записи читает это из адреса - см. RecordView; если запись удалена,
       он это и скажет, что честнее, чем гасить ссылку заранее по догадке. */
    const flow = doc && doc.flowIds[0];
    if (!flow) return;
    void navigate({ to: '/record', search: { flow, step } as never });
  }, [doc, navigate]);

  /* ОДНА выгрузка на два формата: браузерная половина у них одна и та же, и две копии этих шести строк
     разошлись бы в имени файла или в отзыве URL. */
  const sendFile = useCallback((bytes: BlobPart, type: string, name: string) => {
    const url = URL.createObjectURL(new Blob([bytes], { type }));
    const a = document.createElement('a');
    a.href = url;
    a.download = name;
    a.click();
    /* Отзывается в следующем такте, а не сразу: Safari успевает отменить ещё не начавшуюся загрузку, если
       адрес освободить в том же. */
    setTimeout(() => URL.revokeObjectURL(url), 0);
  }, []);

  const downloadMarkdown = useCallback(() => {
    if (!doc) return;
    /* Markdown как есть - это ИСХОДНИК документа, а не его экспорт: то, что лежит в строке, и то, что
       скачивается, обязаны быть одним текстом, иначе «отправил коллеге» и «открыл у себя» показывают
       разное. */
    sendFile(doc.body, 'text/markdown;charset=utf-8',
      (docxName(doc.title).replace(/\.docx$/, '') || 'process') + '.md');
  }, [doc, sendFile]);

  const downloadDocx = useCallback(() => {
    if (!doc) return;
    /* Собирается ЗДЕСЬ, без маршрута и без зависимости - см. features/docs/docx.ts. Тело уже на экране,
       результат - несколько килобайт, и обратный круг к серверу добавил бы двоичный ответ ради того, что
       и так лежит в памяти. */
    sendFile(docxFromMarkdown(doc.body, { title: doc.title }),
      'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
      docxName(doc.title));
  }, [doc, sendFile]);

  /* ------------------------------------------------------------------ one document */

  if (openId) {
    const editing = draft != null;
    return (
      <div className={cn('min-w-0', page.scroll, page.gutter)}>
        <header className="mb-4 flex flex-wrap items-start gap-3">
          <Button
            variant="ghost"
            size="sm"
            leftSlot={<ArrowLeft className="size-4" />}
            /* В ВКЛАДКУ, а не в /docs: список документов живёт в Галерее, и «все документы» обязано
               приводить туда, где он действительно есть. */
            onClick={() => void navigate({ to: '/gallery', search: { tab: 'documents' } as never })}
          >
            All documents
          </Button>
          <span className="ms-auto flex flex-wrap items-center gap-1.5">
            {editing ? (
              <>
                <Button size="sm" leftSlot={<Save className="size-4" />} isLoading={saving} onClick={() => void save()}>
                  Save
                </Button>
                <Button variant="secondary" size="sm" onClick={() => setDraft(null)}>Cancel</Button>
              </>
            ) : (
              <>
                <Button
                  variant="secondary"
                  size="sm"
                  leftSlot={<Pencil className="size-4" />}
                  disabled={!doc}
                  onClick={() => setDraft(doc?.body ?? '')}
                >
                  Correct it
                </Button>
                <Button
                  variant="ghost"
                  size="sm"
                  leftSlot={<Clock className="size-4" />}
                  disabled={versions.length === 0}
                  onClick={() => setShowVersions((v) => !v)}
                >
                  {versions.length} version{versions.length === 1 ? '' : 's'}
                </Button>
                {/* Два формата, и порядок не случаен: Word - то, что отправляют коллеге, Markdown - то,
                    что лежит в строке. Первым стоит тот, за которым приходят чаще. */}
                <Button
                  variant="ghost"
                  size="sm"
                  leftSlot={<Download className="size-4" />}
                  disabled={!doc}
                  onClick={downloadDocx}
                >
                  Word
                </Button>
                <Button
                  variant="ghost"
                  size="sm"
                  disabled={!doc}
                  title="The Markdown this document is stored as — the same text, not a conversion of it"
                  onClick={downloadMarkdown}
                >
                  .md
                </Button>
                {/* Тот же размер взведённой и невзведённой - см. панель расшифровки: рост кнопки в ряду,
                    который не сжимается, сжимает заголовок рядом с ней. */}
                <Button
                  variant={armed ? 'destructive' : 'destructiveOutline'}
                  size="sm"
                  className="!size-8 !p-0"
                  aria-label={armed ? 'Remove this document — press again to confirm' : 'Remove this document'}
                  title={armed ? 'Press again to remove it' : 'Remove this document'}
                  isLoading={saving && armed}
                  onClick={() => void remove()}
                >
                  <Trash2 className="size-4" />
                </Button>
              </>
            )}
          </span>
        </header>

        <Said
          note={note}
          variant="inline"
          className="mb-3"
          onDismiss={armed ? () => { setArmed(false); setNote(null); } : undefined}
        />

        {problem && (
          <section className="rounded-xl border-fb-red/40 border bg-surface-card p-4">
            <div className="flex items-center gap-1.5">
              <TriangleAlert className="size-4 text-fb-red-text" />
              <Typography variant="span" weight="semibold" className="text-[0.9rem] text-fb-red-text">
                This document could not be read
              </Typography>
            </div>
            <Typography variant="p" className="mt-1 max-w-[70ch] text-ink-secondary text-[0.86rem]">
              {problem}
            </Typography>
          </section>
        )}

        {busy && !doc && <Empty>Reading it…</Empty>}

        {doc && (
          <>
            {/* Кем и чем написан - до текста, а не под ним: это условие, при котором читают всё
                остальное. */}
            <div className="mb-3 flex flex-wrap items-center gap-x-3 gap-y-1 text-[0.76rem] text-ink-inactive">
              <span className="inline-flex items-center gap-1">
                <Bot className="size-3.5" />
                {doc.model ? `first written by ${doc.model}` : 'written from a recording'}
                {doc.effort ? ` · effort ${doc.effort}` : ''}
              </span>
              <span>· revision {doc.revision}</span>
              <span>· changed {fmtWhen(doc.updated)}</span>
            </div>

            {showVersions && (
              <section className="mb-4 rounded-xl border-stroke border bg-surface-card p-4">
                <div className="mb-2 flex items-center gap-1.5">
                  <Clock className="size-4 text-ink-secondary" />
                  <Typography variant="h3" weight="semibold" className="text-[0.95rem]">What it said before</Typography>
                  <button
                    type="button"
                    aria-label="Close the versions"
                    className="ms-auto text-ink-inactive hover:text-ink-primary"
                    onClick={() => setShowVersions(false)}
                  >
                    <X className="size-4" />
                  </button>
                </div>
                <Typography variant="p" className="mb-2.5 max-w-[74ch] text-ink-inactive text-[0.78rem]">
                  Putting one back does not erase what it replaces - it is saved forward as a new revision,
                  so there is always a way onwards as well as back.
                </Typography>
                <ul className="space-y-1.5">
                  {versions.map((v) => (
                    <li
                      key={v.revision}
                      className="flex flex-wrap items-center gap-x-2 gap-y-1 rounded-lg border-stroke border bg-surface-chips px-3 py-2"
                    >
                      <span className="font-semibold text-[0.82rem] text-ink-primary tabular-nums">rev {v.revision}</span>
                      <span className="inline-flex items-center gap-1 text-[0.76rem] text-ink-secondary">
                        {v.writtenBy === 'model' ? <Bot className="size-3" /> : <User className="size-3" />}
                        {v.writtenBy === 'model' ? 'the model' : 'a person'}
                      </span>
                      <span className="text-[0.76rem] text-ink-inactive">{fmtWhen(v.at)}</span>
                      {v.revision !== doc.revision && (
                        <Button
                          variant="ghost"
                          size="sm"
                          className="ms-auto"
                          leftSlot={<RotateCcw className="size-3.5" />}
                          isLoading={saving}
                          onClick={() => void revertTo(v.revision)}
                        >
                          Put this back
                        </Button>
                      )}
                      {v.revision === doc.revision && (
                        <span className="ms-auto text-[0.74rem] text-ink-inactive">on screen now</span>
                      )}
                    </li>
                  ))}
                </ul>
              </section>
            )}

            {editing ? (
              <>
                <Typography variant="p" className="mb-2 max-w-[74ch] text-ink-inactive text-[0.78rem]">
                  Markdown, as it is stored. Leave the [step 41] citations where they belong to the line -
                  they are what lets a reader check a claim against the recording.
                </Typography>
                <textarea
                  value={draft}
                  onChange={(e) => setDraft(e.target.value)}
                  spellCheck
                  className={cn(
                    'min-h-[24rem] w-full rounded-xl border-stroke border bg-surface-card p-3',
                    'font-mono text-[0.82rem] leading-relaxed text-ink-body',
                    'focus:border-input-focus focus:outline-none',
                  )}
                />
              </>
            ) : (
              <section className="rounded-xl border-stroke border bg-surface-card p-5">
                <Markdown body={doc.body} onOpenStep={openStep} />
              </section>
            )}
          </>
        )}
      </div>
    );
  }

  /* ------------------------------------------------------------------ the list */

  return (
    <div className={cn('min-w-0', embedded ? '' : cn(page.scroll, page.gutter))}>
      {/* Заголовок только у самостоятельной страницы: во вкладке он уже есть у Галереи, и второй под
          первым - это два заголовка об одном. Объяснение при этом остаётся в обоих видах: то, что
          сгенерированную процедуру надо править, - не украшение шапки, а условие пользования ею. */}
      <header className="mb-4">
        {!embedded && (
          <>
            <Typography variant="span" className="block text-[0.7rem] uppercase tracking-wide text-ink-inactive">
              Written processes
            </Typography>
            <Typography variant="h2" weight="semibold" className="mt-0.5 text-[1.5rem] leading-tight tracking-tight">
              What the work actually is, written down
            </Typography>
          </>
        )}
        <Typography variant="p" className="mt-1 max-w-[76ch] text-ink-inactive text-[0.86rem]">
          Each of these was written from a recording, and every line cites the step it came from. A generated
          procedure is wrong somewhere — that is the normal case — so they are meant to be corrected by
          whoever does the job. Every save keeps the previous text.
        </Typography>
      </header>

      <Said note={note} variant="inline" className="mb-3" />

      {problem && (
        <section className="mb-4 rounded-xl border-fb-red/40 border bg-surface-card p-4">
          <div className="flex items-center gap-1.5">
            <TriangleAlert className="size-4 text-fb-red-text" />
            <Typography variant="span" weight="semibold" className="text-[0.9rem] text-fb-red-text">
              The documents could not be read
            </Typography>
          </div>
          <Typography variant="p" className="mt-1 max-w-[70ch] text-ink-secondary text-[0.86rem]">
            {problem}
          </Typography>
          <Button size="sm" className="mt-3" onClick={() => void loadList()}>Try again</Button>
        </section>
      )}

      {busy && !docs && <Empty>Reading them…</Empty>}

      {docs && docs.length === 0 && (
        <section className="rounded-xl border-stroke border bg-surface-card p-5">
          <div className="flex items-center gap-1.5">
            <BookText className="size-4 text-ink-secondary" />
            <Typography variant="h3" weight="semibold" className="text-[0.95rem]">Nothing written yet</Typography>
          </div>
          {/* НЕТ КНОПКИ «написать», и это не упущение: написать документ значит прочитать расшифровку и
              заплатить модели, а это живёт там, где уже действуют правила и потолки ассистента. Вторая
              дорога к тому же действию была бы вторым местом, где решают, что можно. */}
          <Typography variant="p" className="mt-1 max-w-[70ch] text-ink-secondary text-[0.88rem]">
            Documents are written by asking the assistant on the Dashboard — “write up the process in that
            recording”. It reads the transcript, cites every step, and says plainly what the recording cannot
            show: nothing anybody typed is stored, so the words in a field are never in the document.
          </Typography>
          <div className="mt-3 flex flex-wrap gap-2">
            <Button
              size="sm"
              leftSlot={<Sparkles className="size-4" />}
              onClick={() => void navigate({ to: '/dashboard' })}
            >
              Ask the assistant
            </Button>
            <Button
              variant="secondary"
              size="sm"
              leftSlot={<FileText className="size-4" />}
              rightSlot={<ArrowRight className="size-4" />}
              onClick={() => void navigate({ to: '/record' })}
            >
              See the recordings
            </Button>
          </div>
        </section>
      )}

      {docs && docs.length > 0 && (
        <DocsList docs={docs} onOpen={(id) => void navigate({ to: '/docs/$docId', params: { docId: id } })} />
      )}

      {busy && docs && (
        <div className="mt-3 flex items-center gap-1.5 text-[0.8rem] text-ink-inactive">
          <Loader2 className="size-3.5 animate-spin" />
          reading
        </div>
      )}
    </div>
  );
};
