/* The team endpoint: its shapes, and the one way to talk to it.
 *
 * WHY THIS FILE EXISTS. These types were declared inside TeamView, which was right while TeamView was the
 * only reader - the same note sits over the transcript's own types, and it says the move happens "the moment
 * a second one appears". Two appeared: the dashboard's scope picker reads the same list to decide whose
 * numbers it may show, and AccountProvider now holds the list so that reading it twice per visit stops.
 *
 * The transport comes too. `/api/team` answers with TWO error shapes - `{ error: "words" }` from api/team.js
 * and `{ error: { message } }` from the dev mock and a couple of older routes - and reading only the first
 * turns the second into the string "[object Object]" on screen, which is a bug report nobody can act on.
 * That was worked out once here; a second caller writing its own `fetch` would work it out again or not.
 */

export type TeamRole = 'owner' | 'admin' | 'member';

export interface TeamRow {
  id: string;
  name: string;
  role: TeamRole;
  members: number;
  created_at?: string;
}

/** Whether a message would actually reach anybody, answered by the endpoint before an address is typed. */
export interface MailState { configured: boolean; problem: string | null }

/* ПРИГЛАШЕНИЕ, КОТОРОЕ ЖДЁТ ОТВЕТА.
 *
 * Раньше приглашений на клиенте не существовало вовсе: сервер превращал их в членство сам, при первом же
 * чтении списка. То есть согласие было побочным эффектом того, что человек открыл страницу - а для
 * существующего аккаунта его не спрашивали и того меньше, там шла прямая запись в team_member.
 *
 * Отсутствует у ответа старого развёртывания, поэтому необязательное. */
export interface TeamInvite {
  id: string;
  name: string;
  role: TeamRole;
  members: number;
  created_at?: string;
}

/** What `GET /api/team` answers with. `mail` is absent on a deployment older than that field. */
export interface TeamList { teams: TeamRow[]; invitations?: TeamInvite[]; mail?: MailState }

/* See the note above: both shapes, and a status when neither is there. */
const saidWrong = (body: unknown, status: number): string => {
  const said = (body as { error?: unknown } | null)?.error;
  if (typeof said === 'string' && said.trim()) return said;
  const nested = (said as { message?: unknown } | null | undefined)?.message;
  if (typeof nested === 'string' && nested.trim()) return nested;
  return `HTTP ${status}`;
};

/** Any call on `/api/team`: the list, one team, and every change to either. Throws the endpoint's own words. */
export const callTeams = async <T,>(path: string, init?: RequestInit): Promise<T> => {
  const res = await fetch(`/api/team${path}`, { credentials: 'same-origin', ...init });
  const body = await res.json().catch(() => null);
  if (!res.ok) throw new Error(saidWrong(body, res.status));
  return body as T;
};
