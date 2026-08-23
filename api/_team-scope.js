/* Whose rows a request is allowed to count.
 *
 * WHY THIS IS ITS OWN FILE. Two endpoints now turn a team id into a permission - /api/team, which has
 * always done it, and /api/insights, which reads the whole team's numbers when a manager asks for them.
 * A second copy of `roleOf` would be a second place for the rule to be right, and the rule here is the one
 * that decides whether one person sees another person's work. There is exactly one derivation of it, and
 * both readers import it.
 *
 * THE RULE, in one line: a team id in a query string is a CLAIM, not a permission. `scopeFor` turns it into
 * a set of user ids or into an error, and it resolves the caller from the credential every time - never from
 * anything the request said about itself.
 *
 * WHO SEES THE TEAM'S NUMBERS. Owners and admins, and nobody else. That is not a new rule invented for the
 * dashboard: it is the same line db/008_team.sql draws and the team screen has always shown - a team that
 * cannot see whether it is working is not a team, so ACTIVITY (that somebody recorded, when, how a run
 * ended) is visible to the people running it. A member asking for the team scope is refused by name, and
 * sees their own numbers instead. What stays private in every scope is CONTENT - the events, the
 * transcript, the chat - which is opened one skill at a time by the person who owns it, and never by a role.
 */

const ROLES = ['owner', 'admin', 'member'];

/** The caller's role in one team, or null. The only thing that turns a team id into a permission. */
export async function roleOf(sql, teamId, userId) {
  const rows = await sql`
    select m.role from team_member m
    join team t on t.id = m.team_id and t.deleted_at is null
    where m.team_id = ${teamId} and m.user_id = ${userId}
  `;
  return rows.length ? rows[0].role : null;
}

export const manages = (role) => role === 'owner' || role === 'admin';

export const isRole = (role) => ROLES.includes(role);

/** Names and addresses for a set of ids, from the auth service's own table. */
export async function peopleFor(sql, ids) {
  if (!ids.length) return new Map();
  const rows = await sql`
    select u.id::text as id, to_jsonb(u) as who from neon_auth."user" u where u.id::text = any(${ids})
  `;
  const out = new Map();
  for (const row of rows) {
    const w = row.who || {};
    out.set(row.id, { name: w.name ?? null, email: w.email ?? null, image: w.image ?? null });
  }
  return out;
}

/* The set of accounts one request may count over.
 *
 * Personal is one id - the caller's - and is what every existing caller gets, because no `team` parameter
 * means the question was about them. A team scope is every member of that team, and only for the two roles
 * that run it.
 *
 * The two refusals say different things ON PURPOSE. Not-a-member is 404, the same answer /api/team gives,
 * because a 403 would confirm that a team with that id exists to somebody who was never meant to learn it.
 * A member who IS in the team gets 403 with a reason: they already know the team exists - they are in it -
 * so the useful answer is which roles may look, not a false "no such thing".
 */
export async function scopeFor(sql, who, teamId, personId) {
  if (!teamId) return { kind: 'personal', ids: [who.id], memberIds: [who.id] };

  const role = await roleOf(sql, teamId, who.id);
  if (!role) return { error: { status: 404, message: 'not found' } };
  if (!manages(role)) {
    return {
      error: {
        status: 403,
        message: 'Only an owner or an admin sees a team’s numbers. Yours are on the personal view.',
      },
    };
  }

  const [team] = await sql`select id, name from team where id = ${teamId} and deleted_at is null`;
  if (!team) return { error: { status: 404, message: 'not found' } };

  const members = await sql`select user_id::text as id, role from team_member where team_id = ${teamId}`;
  /* The caller is a member of their own team, so this already contains them; said explicitly because a
   * scope that quietly dropped the person asking would show a manager everybody's work except their own. */
  const ids = members.map((m) => m.id);

  /* Narrowing to ONE member - what a manager does to ask "and how is Margaryta getting on".
   *
   * The permission is unchanged and is still the team's: this only picks a subset of the accounts the
   * caller was already allowed to count. Which is exactly why it is checked against `ids` rather than
   * trusted - a uuid in a query string is no more a permission here than a team id is, and without this
   * line it would be a way to count any account on the deployment.
   *
   * `memberIds` deliberately keeps the WHOLE team even when narrowed, because the caller still has to be
   * able to offer the other names: a filter you cannot get out of is a dead end. */
  let chosen = null;
  if (personId) {
    if (!ids.includes(personId)) {
      return { error: { status: 404, message: 'nobody with that id is in this team' } };
    }
    chosen = personId;
  }

  return {
    kind: 'team',
    role,
    ids: chosen ? [chosen] : ids,
    memberIds: ids,
    members,
    person: chosen,
    team: { id: team.id, name: team.name },
  };
}
