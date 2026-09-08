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

/** Which machine the reader is looking at. Undefined means "not connected", and then the wire's own
 *  vocabulary is used, because inventing one of the two would be wrong half the time. */
export type On = 'windows' | 'macos' | undefined;

/** What a step actually did, not just which verb it used - afterwards is when somebody is working out
 *  where a run went wrong. */
export function describe(did: Did, on: On = undefined): string {
  const input = (did.input ?? {}) as Record<string, any>;
  const at = Number.isFinite(input.x) && Number.isFinite(input.y) ? ` at ${input.x},${input.y}` : '';

  /* WHAT THE GESTURE WAS MADE WITH, as a prefix - `Shift-click at 481,179`. A person reading a bare
   * "click" for a Shift-click reads a step that did something else, and the transcript already writes
   * `Shift-clicked "Report.pdf"` for the recorded half: without this, the two halves of the same product
   * would describe the same gesture differently.
   *
   * Capitalised the way a chord is written, and in the order the format fixes rather than the order the
   * model happened to list them, so the same gesture always reads the same way. */
  const CHORD: Record<string, string> = { cmd: 'Cmd', ctrl: 'Ctrl', alt: 'Alt', shift: 'Shift' };
  const held = Array.isArray(input.modifiers)
    ? ['cmd', 'ctrl', 'alt', 'shift']
      .filter((key) => (input.modifiers as unknown[]).some((one) => String(one).toLowerCase() === key))
      .map((key) => CHORD[key])
    : [];
  const with_ = held.length ? `${held.join('+')}-` : '';

  switch (did.name) {
    case 'click':
      return `${with_}${input.double ? 'double-click' : input.button === 'right' ? 'right-click' : 'click'}${at}`;
    case 'hover':
      return `hover${at}`;
    case 'scroll': {
      const way = ['up', 'down', 'left', 'right'].includes(String(input.direction))
        ? String(input.direction)
        : (Number(input.amount) < 0 ? 'down' : 'up');
      return `${with_}scroll ${way}${at}`;
    }
    case 'refresh_page':
      return `reload ${input.title ?? input.process ?? 'the window in front'}`;
    case 'wait_for_window':
      return `wait for ${input.title ?? input.process ?? 'a window'} to ${
        input.until === 'disappears' ? 'close' : 'appear'}`;
    case 'type_text': {
      const text = String(input.text ?? '');
      const lines = text.split('\n').length;
      const shown = text.replace(/\n/g, ' ⏎ ');
      return `type "${shown.length > 60 ? `${shown.slice(0, 60)}…` : shown}"${lines > 1 ? ` (${lines} lines)` : ''}`;
    }
    case 'press_key': {
      /* `ctrl` НА ПРОВОДЕ - ЭТО КОМАНДНЫЙ МОДИФИКАТОР, а не клавиша Control: агент на маке ставит из него
       * ⌘ (см. Input.key). Строка при этом говорила «press Ctrl+V» - то есть называла нажатие, которого на
       * этой машине не было, и никакого Ctrl+V на маке действительно не существует.
       *
       * Стоило это дороже, чем выглядит. Владелец продукта прочитал свой собственный журнал, увидел там
       * виндовые аккорды и сделал ровно тот вывод, который эта строка предлагает: «он жмёт шорткаты
       * Windows, они на маке не работают». Вставка при этом работала - в том же прогоне ⌘V, ⌘N и ⌘S
       * сработали четырежды. Врущая подпись увела диагностику в сторону от настоящей причины.
       *
       * Платформа берётся у ПОДКЛЮЧЁННОГО агента. Для живого прогона это точно та машина, на которой он
       * идёт; для истории - почти всегда она же, а строки прогона платформы не несут вовсе. Без агента
       * остаётся словарь провода: выдумать одну из двух значит ошибаться в половине случаев. */
      const command = on === 'macos' ? 'Cmd' : 'Ctrl';
      const mods = [input.win && 'Win', input.ctrl && command, input.shift && 'Shift', input.alt && 'Alt']
        .filter(Boolean);
      return `press ${[...mods, input.key ?? '?'].join('+')}`;
    }
    case 'activate_window':
      return `switch to ${input.title ?? input.process ?? 'a window'}`;
    case 'capture_window':
      if (Number.isFinite(input.w) && Number.isFinite(input.h)) {
        return `capture ${input.w}x${input.h}${at}`;
      }
      return `capture ${input.title ?? input.process ?? 'the window in front'}`;
    case 'read_window':
      return `read ${input.title ?? input.process ?? 'the window in front'}`;
    case 'find_element':
      return `find "${input.name ?? '?'}"`;
    case 'scroll_to':
      return `scroll to ${input.to ?? '?'}`;
    case 'drag':
      return `${with_}drag ${at.trim() || 'from somewhere'} to ${input.toX},${input.toY}`;
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
    /* Отложено. В фиде это читалось как «defer_until» - машинное имя из ветки default, - а человек, глядящий
     * на прогон, который назвал время и остановился, обязан прочитать НА КОГДА. Местным временем, потому что
     * в этой же зоне он назвал час; ISO в строке фида не читает никто. */
    case 'defer_until': {
      const at = new Date(String(input.at ?? ''));
      const when = Number.isFinite(at.getTime())
        ? at.toLocaleString([], { weekday: 'short', hour: '2-digit', minute: '2-digit' })
        : String(input.at ?? 'later');
      return `set the run aside until ${when}`;
    }
    /* ПРОВЕРКА - читается как утверждение, а не как вызов инструмента: строка в отчёте по тесту это то,
     * что человек прочитает через неделю, и «expect present Send» ему ничего не скажет. */
    case 'expect': {
      const what = String(input.name ?? 'something');
      const text = input.text != null ? `"${String(input.text)}"` : '';
      switch (String(input.check ?? '')) {
        case 'present': return `check that "${what}" is there`;
        case 'absent': return `check that "${what}" is gone`;
        case 'value_is': return `check that "${what}" holds ${text}`;
        case 'value_contains': return `check that "${what}" contains ${text}`;
        case 'enabled': return `check that "${what}" can be used`;
        case 'disabled': return `check that "${what}" is not available`;
        default: return `check "${what}"`;
      }
    }
    case 'reached_checkpoint':
      return `announced checkpoint ${input.n ?? '?'}`;
    case 'finish':
      return 'finish';
    default:
      return did.name ?? 'step';
  }
}
