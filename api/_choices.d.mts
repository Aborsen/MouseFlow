/** Ровно те поля шага, которые читают функции ниже. Визард передаёт свою `Line`, у которой есть все. */
export interface ChoiceLike {
  n?: number;
  action?: string;
  control?: string | null;
  controlType?: string | null;
  where?: string | null;
  host?: string | null;
  url?: string | null;
}

/** Одна серия кликов по странице: где спросить, после чего это было и сколько кликов она накрывает. */
export interface ChoiceRun {
  /** Шаг, на котором стоит вопрос: названный клик, открывший выбор. */
  n: number;
  /** Его имя - « Add filter». Для подписи вопроса. */
  after: string | null;
  /** Номера самих кликов по странице. Все они прячутся: за них отвечает вопрос на `n`. */
  steps: number[];
  clicks: number;
  where: string | null;
}

export const OWN_RECORDER_CONTROLS: string[];
export const OWN_AGENT_MARK: string;
export const CONTAINER_TYPES: string[];

export function isOwnRecorderControl(line: ChoiceLike): boolean;
export function isContainerClick(line: ChoiceLike): boolean;
export function choiceRuns(lines: ChoiceLike[]): {
  runs: ChoiceRun[];
  anchors: Map<number, ChoiceRun>;
  hushed: Set<number>;
};
