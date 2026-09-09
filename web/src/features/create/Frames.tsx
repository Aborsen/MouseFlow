/* Кадры прогона: полоска миниатюр под его шагами.
 *
 * ЗАЧЕМ ЭТО ВООБЩЕ. Провалившаяся проверка в словах - это утверждение об экране, на который больше нельзя
 * посмотреть. «"Saved" is not on the window» ровно настолько же надёжно, насколько надёжен разбор, который
 * это сказал, - в этом весь смысл `expect`, - но человек, читающий красную строку в девять утра, хочет
 * знать, ПОЧЕМУ там этого не было, и никакие слова его туда не приведут. Регрессионный набор, чьи провалы
 * нельзя разобрать, кончается одним: его перестают читать.
 *
 * СПИСОК И КАРТИНКИ - ДВА ЗАПРОСА, и это не педантизм. Двенадцать кадров это до трёх мегабайт; панель
 * истории показывает десять прогонов. Список приезжает без картинок (килобайт), а содержимое кадра - только
 * когда на него нажали, и браузер кэширует его на сутки: снимок момента не меняется никогда.
 *
 * И НИЧЕГО НЕ СПРАШИВАЕТСЯ ЗАРАНЕЕ. Кадры есть у горстки прогонов - у тех, что делали проверки или упали, -
 * поэтому список спрашивается только когда человек раскрыл прогон. Опрос всех подряд «на случай, если есть»
 * это десять запросов в никуда при каждом открытии панели.
 */
import { useCallback, useEffect, useState } from 'react';
import { Camera, CircleAlert, CircleCheck, X } from 'lucide-react';
import { Typography } from '@insightis/ui/Typography';
import { cn } from '@insightis/ui/cn';
import { type Artifact, artifactBytes, artifactsOf } from '@/lib/api';

/** Вид кадра словами - подпись, а не машинное имя. */
const named = (kind: string) =>
  kind === 'failure' ? 'where it failed' : kind === 'final' ? 'the last screen' : 'what it proved';

const icon = (kind: string) =>
  kind === 'failure'
    ? <CircleAlert className="size-3 text-fb-red-text" />
    : kind === 'check'
      ? <CircleCheck className="size-3 text-fb-green" />
      : <Camera className="size-3 text-ink-inactive" />;

export const Frames = ({ runId }: { runId: string }) => {
  const [rows, setRows] = useState<Artifact[] | null>(null);
  const [open, setOpen] = useState<{ id: string; src: string; said: string | null } | null>(null);
  const [failed, setFailed] = useState(false);

  useEffect(() => {
    let stop = false;
    artifactsOf(runId)
      .then((body) => { if (!stop) setRows(body.artifacts); })
      /* Отказ - не «кадров нет»: полоска просто не рисуется, и это честнее пустой рамки с обещанием.
       * Самая частая причина - миграция не применена на этом деплое, и тогда кадров нет ни у кого. */
      .catch(() => { if (!stop) setFailed(true); });
    return () => { stop = true; };
  }, [runId]);

  const look = useCallback(async (one: Artifact) => {
    try {
      const body = await artifactBytes(one.id);
      setOpen({
        id: one.id,
        src: `data:${body.artifact.mime};base64,${body.artifact.bytes}`,
        said: body.artifact.said,
      });
    } catch (_) {
      setFailed(true);
    }
  }, []);

  if (failed || !rows || !rows.length) return null;

  return (
    <div className="mt-2">
      <Typography variant="span" className="mb-1 block text-[0.7rem] uppercase tracking-wide text-ink-inactive">
        Kept frames · {rows.length}
      </Typography>
      <div className="flex flex-wrap gap-1.5">
        {rows.map((one) => (
          <button
            key={one.id}
            type="button"
            onClick={() => void look(one)}
            title={one.said || named(one.kind)}
            className={cn(
              'flex items-center gap-1 rounded-md border px-1.5 py-1 text-[0.72rem] transition-colors',
              one.kind === 'failure'
                ? 'border-fb-red/40 bg-fb-red/10 text-fb-red-text hover:bg-fb-red/20'
                : 'border-stroke bg-surface-card2 text-ink-secondary hover:bg-surface-chips',
            )}
          >
            {icon(one.kind)}
            <span className="tabular-nums">step {one.stepNo + 1}</span>
            <span className="text-ink-inactive">· {named(one.kind)}</span>
          </button>
        ))}
      </div>

      {/* Полноразмерный кадр. Без библиотеки диалогов: это картинка и крестик, а не разговор - и поверх
        * панели истории, у которой свой скролл. */}
      {open && (
        <div
          className="fixed inset-0 z-50 flex flex-col items-center justify-center gap-2 bg-black/80 p-4"
          onClick={() => setOpen(null)}
          role="presentation"
        >
          <img
            src={open.src}
            alt={open.said || 'the screen at that step'}
            className="max-h-[80vh] max-w-full rounded-lg border-stroke border object-contain"
          />
          {open.said && (
            <Typography variant="p" className="max-w-[80ch] text-center text-[0.82rem] text-white/90">
              {open.said}
            </Typography>
          )}
          <button
            type="button"
            aria-label="Close"
            className="flex items-center gap-1 rounded-md bg-white/10 px-2 py-1 text-[0.8rem] text-white/90"
            onClick={() => setOpen(null)}
          >
            <X className="size-3.5" /> Close
          </button>
        </div>
      )}
    </div>
  );
};
