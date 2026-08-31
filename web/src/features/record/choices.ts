/* Выбор, которого запись не увидела, - как его видит приложение.
 *
 * Та же схема, что у typing.ts: реализация лежит в `api/_choices.mjs`, чтобы узловой набор тестов гонял её
 * против настоящих записей, а здесь - окно приложения в неё.
 */
export { choiceRuns, isContainerClick, isOwnRecorderControl } from '../../../../api/_choices.mjs';
export type { ChoiceRun, ChoiceLike } from '../../../../api/_choices.mjs';
