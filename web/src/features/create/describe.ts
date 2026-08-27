/* Одна строка про один шаг - и одна на всё приложение.
 *
 * Живёт отдельно от CreateView, потому что читателей стало два и они смотрят на РАЗНОЕ: бегущий прогон
 * читает события цикла (`RunEvent`, у которого действие лежит в `name`), а история читает строку с
 * аккаунта (`steps[]`, у которой оно лежит в `tool`). Одно и то же действие, две формы записи - и если бы
 * функций было две, «click at 220,540» в живом фиде и «click» в истории разошлись бы молча, а человек,
 * который смотрит на них по очереди, решил бы, что это разные вещи.
 *
 * Поэтому здесь принимается общий знаменатель - имя и вход, - а формы приводят к нему вызывающие.
 */

/** Действие в той форме, в какой его помнят обе стороны: как называется и с чем вызвано. */
export interface Did {
  name?: string;
  input?: Record<string, unknown> | null;
}

/** Шаг прогона, как он лежит на аккаунте. `tool` - то же, что `name` у события цикла. */
export const asDid = (step: { tool?: string; input?: Record<string, unknown> | null }): Did =>
  ({ name: step.tool, input: step.input });

/** What a step actually did, not just which verb it used - afterwards is when somebody is working out
 *  where a run went wrong. */
export function describe(did: Did): string {
  const input = (did.input ?? {}) as Record<string, any>;
  const at = Number.isFinite(input.x) && Number.isFinite(input.y) ? ` at ${input.x},${input.y}` : '';
  switch (did.name) {
    case 'click':
      return `${input.double ? 'double-click' : input.button === 'right' ? 'right-click' : 'click'}${at}`;
    case 'hover':
      return `hover${at}`;
    case 'scroll':
      return `scroll ${Number(input.amount) < 0 ? 'down' : 'up'}${at}`;
    case 'type_text': {
      const text = String(input.text ?? '');
      const lines = text.split('\n').length;
      const shown = text.replace(/\n/g, ' ⏎ ');
      return `type "${shown.length > 60 ? `${shown.slice(0, 60)}…` : shown}"${lines > 1 ? ` (${lines} lines)` : ''}`;
    }
    case 'press_key': {
      const mods = [input.ctrl && 'Ctrl', input.shift && 'Shift', input.alt && 'Alt'].filter(Boolean);
      return `press ${[...mods, input.key ?? '?'].join('+')}`;
    }
    case 'activate_window':
      return `switch to ${input.title ?? input.process ?? 'a window'}`;
    case 'capture_window':
      if (Number.isFinite(input.w) && Number.isFinite(input.h)) {
        return `capture ${input.w}x${input.h}${at}`;
      }
      return `capture ${input.title ?? input.process ?? 'the window in front'}`;
    case 'clipboard_read':
      return 'read the clipboard';
    case 'clipboard_write': {
      const text = String(input.text ?? '').replace(/\n/g, ' ⏎ ');
      return `copy "${text.length > 48 ? `${text.slice(0, 48)}…` : text}"`;
    }
    case 'open_url':
      return `open ${input.url ?? 'a link'}`;
    case 'open_app':
      return `start ${input.name ?? 'an application'}`;
    case 'wait':
      return 'wait for the screen to settle';
    /* Заметка - единственный шаг, ЧЬЁ СОДЕРЖИМОЕ и есть смысл шага: «note» без текста не говорит ничего,
     * ради чего модель её вызывала. Обрезается, потому что строка живёт в одну строку фида. */
    case 'note': {
      const written = String(input.text ?? '').trim();
      return written ? `noted "${written.length > 72 ? `${written.slice(0, 72)}…` : written}"` : 'noted';
    }
    case 'reached_checkpoint':
      return `announced checkpoint ${input.n ?? '?'}`;
    case 'finish':
      return 'finish';
    default:
      return did.name ?? 'step';
  }
}
