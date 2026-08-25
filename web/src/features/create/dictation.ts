/* Диктовка цели голосом.
 *
 * ЛОКАЛЬНО, ЕСЛИ МОЖНО - и это не оптимизация, а главное решение в файле. По умолчанию Chrome отправляет
 * звук с микрофона на свои серверы; для продукта, который смотрит в экран и обещает говорить, что именно
 * уходит с машины, тихо добавить такое было бы повторением ошибки, которую мы уже один раз отзывали.
 *
 * Поэтому порядок такой: спросить `available({ processLocally: true })`, и если язык есть на устройстве -
 * поставить `processLocally = true`, чтобы звук не покидал машину вовсе. Если пакета нет, но он
 * скачиваемый - предложить скачать. Если локально язык не поддерживается - работать через сервер, но
 * СКАЗАТЬ ОБ ЭТОМ до нажатия, а не после.
 *
 * `where` - это то, что читает человек, поэтому оно часть состояния, а не деталь реализации.
 *
 * Типы объявлены здесь: lib.dom ещё не знает ни `processLocally`, ни статических available()/install(),
 * а `any` в этом месте спрятал бы ровно те поля, ради которых всё написано.
 */
import { useCallback, useEffect, useRef, useState } from 'react';

interface RecognitionAlternative { transcript: string }
interface RecognitionResult { isFinal: boolean; 0: RecognitionAlternative; length: number }
interface RecognitionResultList { length: number; [i: number]: RecognitionResult }
interface RecognitionEvent { resultIndex: number; results: RecognitionResultList }
interface RecognitionErrorEvent { error: string }

interface Recognition extends EventTarget {
  lang: string;
  continuous: boolean;
  interimResults: boolean;
  maxAlternatives: number;
  processLocally?: boolean;
  start(): void;
  stop(): void;
  abort(): void;
  onresult: ((e: RecognitionEvent) => void) | null;
  onerror: ((e: RecognitionErrorEvent) => void) | null;
  onend: (() => void) | null;
}

type Availability = 'available' | 'downloading' | 'downloadable' | 'unavailable';

interface RecognitionClass {
  new (): Recognition;
  available?(o: { langs: string[]; processLocally?: boolean; quality?: string }): Promise<Availability>;
  install?(o: { langs: string[]; processLocally?: boolean }): Promise<boolean>;
}

const Speech = (): RecognitionClass | null => {
  const w = window as unknown as {
    SpeechRecognition?: RecognitionClass;
    webkitSpeechRecognition?: RecognitionClass;
  };
  return w.SpeechRecognition ?? w.webkitSpeechRecognition ?? null;
};

/** Where the audio goes. `unknown` until asked - never assumed, because the answer decides what we say. */
export type Where = 'unknown' | 'on-this-computer' | 'a-server' | 'downloadable' | 'no';

/* Язык, на котором человек говорит.
 *
 * Берётся из браузера, а не задаётся константой: без явного `lang` Chrome распознаёт как английский, и
 * русская речь превращается в кашу, которая выглядит как поломка распознавания, а не как неверная
 * настройка. Отдельного выбора языка тут пока нет - если браузер и речь разойдутся, это будет видно
 * сразу же по первому слову, а не спрятано. */
export const dictationLang = () => navigator.language || 'en-US';

/* Название языка словами, для строки, которую читают. Intl уже умеет это на языке самого интерфейса. */
export function langName(tag: string): string {
  try {
    return new Intl.DisplayNames([tag], { type: 'language' }).of(tag) ?? tag;
  } catch (_) {
    return tag;
  }
}

export interface Dictation {
  supported: boolean;
  listening: boolean;
  where: Where;
  lang: string;
  problem: string | null;
  /** Пока говорят: то, что уже распознано, но ещё может измениться. Не дописывается в цель. */
  interim: string;
  start: () => void;
  stop: () => void;
  /** Скачать языковой пакет, чтобы уйти с сервера на устройство. */
  install: () => Promise<void>;
}

/* Что сказать про ошибку.
 *
 * `not-allowed` - самая частая и самая тупиковая: разрешение на микрофон отклонено, и повторное нажатие
 * не покажет запрос снова, потому что браузер его запомнил. Строка обязана назвать выход, а не событие. */
function inWords(code: string): string {
  if (code === 'not-allowed' || code === 'service-not-allowed') {
    return 'The microphone was refused. Allow it for this site in the address bar, then try again.';
  }
  if (code === 'no-speech') return 'Nothing was heard.';
  if (code === 'audio-capture') return 'No microphone was found.';
  if (code === 'network') return 'Recognition needs the network and could not reach it.';
  if (code === 'aborted') return '';
  return `Dictation stopped: ${code}.`;
}

/**
 * @param onText  Called with each FINAL piece. Interim text never arrives here - a goal that rewrote
 *                itself while somebody was still speaking would be unreadable to edit.
 */
export function useDictation(onText: (text: string) => void): Dictation {
  const Klass = Speech();
  const lang = dictationLang();
  const [listening, setListening] = useState(false);
  const [where, setWhere] = useState<Where>('unknown');
  const [problem, setProblem] = useState<string | null>(null);
  const [interim, setInterim] = useState('');
  const live = useRef<Recognition | null>(null);
  /* Колбэк в ref: распознавание живёт дольше рендера, и пересоздавать его из-за нового замыкания значило бы
   * обрывать человека на полуслове. */
  const sink = useRef(onText);
  sink.current = onText;

  /* Спрашивается один раз, до первого нажатия: строка про то, куда уйдёт звук, должна стоять на экране
   * ДО того, как микрофон включат, а не появляться задним числом. */
  useEffect(() => {
    if (!Klass) { setWhere('no'); return; }
    let gone = false;
    void (async () => {
      try {
        if (!Klass.available) { setWhere('a-server'); return; }
        const local = await Klass.available({ langs: [lang], processLocally: true, quality: 'dictation' });
        if (gone) return;
        if (local === 'available') { setWhere('on-this-computer'); return; }
        if (local === 'downloadable' || local === 'downloading') { setWhere('downloadable'); return; }
        const remote = await Klass.available({ langs: [lang], processLocally: false, quality: 'dictation' });
        if (gone) return;
        setWhere(remote === 'available' ? 'a-server' : 'no');
      } catch (_) {
        /* Спросить не вышло - значит и утверждать, что звук останется на машине, нельзя. */
        if (!gone) setWhere('a-server');
      }
    })();
    return () => { gone = true; };
  }, [Klass, lang]);

  const stop = useCallback(() => {
    live.current?.stop();
  }, []);

  const start = useCallback(() => {
    if (!Klass || live.current) return;
    setProblem(null);
    setInterim('');

    const rec = new Klass();
    rec.lang = lang;
    rec.continuous = true;
    rec.interimResults = true;
    rec.maxAlternatives = 1;
    /* Только когда мы ПРОВЕРИЛИ, что язык есть на устройстве. Ставить это вслепую - значит получить отказ
     * там, где сервер сработал бы, и человек услышит «не работает» вместо текста. */
    if (where === 'on-this-computer') rec.processLocally = true;

    rec.onresult = (event) => {
      let pending = '';
      for (let i = event.resultIndex; i < event.results.length; i++) {
        const result = event.results[i];
        const text = result[0]?.transcript ?? '';
        if (result.isFinal) sink.current(text);
        else pending += text;
      }
      setInterim(pending);
    };
    rec.onerror = (event) => {
      const said = inWords(event.error);
      if (said) setProblem(said);
    };
    rec.onend = () => {
      live.current = null;
      setListening(false);
      setInterim('');
    };

    try {
      rec.start();
      live.current = rec;
      setListening(true);
    } catch (_) {
      /* start() на уже запущенном экземпляре бросает; состояние тогда врёт, если его не сбросить. */
      live.current = null;
      setListening(false);
    }
  }, [Klass, lang, where]);

  const install = useCallback(async () => {
    if (!Klass?.install) return;
    setProblem(null);
    try {
      const ok = await Klass.install({ langs: [lang], processLocally: true });
      setWhere(ok ? 'on-this-computer' : 'a-server');
    } catch (_) {
      setProblem('The language pack could not be downloaded.');
    }
  }, [Klass, lang]);

  /* Микрофон не должен пережить экран, с которого его включили. */
  useEffect(() => () => { live.current?.abort(); live.current = null; }, []);

  return {
    supported: !!Klass && where !== 'no',
    listening, where, lang, problem, interim, start, stop, install,
  };
}
