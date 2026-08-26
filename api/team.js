/* Teams: who may see whose work.
 *
 *   GET    /api/team                      my teams, my role in each, who else is in them
 *   GET    /api/team?id=X                 one team: members, their activity, pending invites, shared skills
 *   POST   /api/team                      { name }            make one; I am its owner
 *   POST   /api/team?id=X                 { email, role }     add somebody, or invite an address with no account
 *   POST   /api/team?id=X&remind=<email>  send a waiting invitation again              (owner, admin)
 *   POST   /api/team?id=X&share=<flow>    show one of MY skills to the team
 *   PATCH  /api/team?id=X                 { userId, role }    change a role                    (owner)
 *   PATCH  /api/team?id=X                 { name }            rename it                        (owner)
 *   DELETE /api/team?id=X                 leave it
 *   DELETE /api/team?id=X&user=<uuid>     remove somebody                                      (owner, admin)
 *   DELETE /api/team?id=X&invite=<email>  cancel an invitation                                 (owner, admin)
 *   DELETE /api/team?id=X&share=<flow>    stop showing one of my skills
 *   DELETE /api/team?id=X&team=1          delete the team                                      (owner)
 *
 * THREE ROLES, CHECKED IN THE QUERIES. Not a permission table: that earns its keep when somebody needs
 * "sees the dashboard but not the transcripts", and until that request exists it is a second product to keep
 * correct. Growing out of this into one is linear; the other direction is not.
 *
 * WHAT A TEAM DOES NOT DO. Joining one hands over nothing already recorded. ACTIVITY - that a person made a
 * recording, when, how a run ended - becomes visible to owners and admins, because a team that cannot see
 * whether it is working is not a team. CONTENT - the events, the transcript, the chat - stays private until
 * it is shared, one thing at a time, by the person who owns it. That is the same rule the gallery has always
 * had, and the reason is the same: a membership that retroactively opened everything somebody had ever
 * recorded would be a surprise about other people's screens.
 *
 * WHAT IS EMAILED, AND WHAT THE EMAIL IS WORTH. Adding somebody sends them one message: who added them,
 * what a team does and does not open, a link to the Teams page, and a line telling them to delete it if
 * they do not recognise it. The message carries NO AUTHORITY - the link is a deep link, not a token, and
 * membership is decided by the address on the account that opens it. So a forwarded message, a shared
 * inbox or a mail log hands nobody a seat. If this deployment has no mail configured, the invitation still
 * works exactly as it did before and the answer says so instead of implying a message is on its way.
 *
 * EVERY QUERY IS SCOPED BY THE CALLER'S OWN MEMBERSHIP, resolved from the credential and never from the
 * request. A team id in a query string is a claim, not a permission: `roleOf` turns it into one or into
 * nothing, and every write says which roles it accepts before it runs.
 */

import { neon } from '@neondatabase/serverless';
import { randomBytes } from 'node:crypto';
import { whoIsCalling } from './_session.js';
/* One derivation of "who may see whose work", shared with /api/insights - see api/_team-scope.js. A second
 * copy of roleOf would be a second place for the rule that decides whether one person sees another's work
 * to be right. */
import { manages, peopleFor, roleOf } from './_team-scope.js';
import { invitationMail, mailProblem, sendMail } from './_mail.js';
/* Server-side crashes reach Sentry from here. See api/_report.js — no dependency, and it
 * deliberately sends the route and the message, never the query string or the body. */
import { report, wrap } from './_report.js';
/* Один заголовочный набор на все маршруты - см. api/_cors.mjs. Семь копий этих строк разошлись
 * ровно в том месте, где это стоило дороже всего: chats.js отражал ЛЮБОЙ origin и выдавал
 * Allow-Credentials, то есть чужая страница читала разговоры человека его же кукой. */
import { cors } from './_cors.mjs';

const NAME_MAX = 60;
const TEAMS_PER_PERSON = 20;
const MEMBERS_MAX = 200;
const ROLES = ['owner', 'admin', 'member'];

/* This endpoint sends mail to an address the caller types, which is the shape of every open relay ever
 * built. Three things stand between it and that: only an owner or an admin of an existing team can reach
 * it, a team is capped at MEMBERS_MAX, and this - a ceiling on how many invitations one account can send
 * in an hour, counted from the invite rows themselves rather than from memory.
 *
 * From the rows on purpose: a serverless instance holds its own memory and a determined caller gets a
 * fresh one, so an in-process counter is a speed bump. A row was written for every invitation, so counting
 * them is both exact and free of state. */
const INVITES_PER_HOUR = 25;


const fail = (res, status, message) => res.status(status).json({ error: message });
const text = (value, max) => (value == null ? null : String(value).trim().slice(0, max) || null);
const newId = () => `t_${randomBytes(8).toString('hex')}`;

/* Anybody added by an address before they had an account.
 *
 * Claimed on read rather than on every request: joining a team matters the moment somebody looks at one, and
 * putting this in the hot path would cost every /api/sync a second query for a row that almost never exists.
 * Matched case-insensitively, because an address is not case-sensitive in the half that matters and people
 * type it either way. */
/* ПРИГЛАШЕНИЯ, КОТОРЫЕ ЖДУТ ОТВЕТА - а не членство, случившееся само.
 *
 * Раньше здесь стоял claimInvites: открытие страницы превращало приглашение в членство. Это делало
 * согласие побочным эффектом чтения - человек не соглашался, он просто зашёл, - и вместе со второй
 * половиной (существующий аккаунт вписывался в team_member напрямую, вообще без приглашения) давало
 * следующее: любой, кто знает чужой адрес, заводил команду, добавлял туда этого человека и читал его цели
 * прогонов, трассы шагов и заголовки записанных окон через /api/insights?team=…&person=…
 *
 * Теперь членства без действия не бывает. Приглашение показывается, и его принимают или отклоняют. */
async function pendingFor(sql, who) {
  if (!who.email) return [];
  return sql`
    select i.team_id as id, t.name, i.role, i.created_at,
           (select count(*)::int from team_member x where x.team_id = t.id) as members
    from team_invite i
    join team t on t.id = i.team_id and t.deleted_at is null
    where lower(i.email) = lower(${who.email})
    order by i.created_at
  `;
}

/** Согласие - действие, и оно совершается ровно здесь. */
async function acceptInvite(sql, who, teamId) {
  if (!who.email) return { status: 400, body: { error: 'this account has no email address' } };
  const [invite] = await sql`
    select i.role, i.invited_by from team_invite i
    join team t on t.id = i.team_id and t.deleted_at is null
    where i.team_id = ${teamId} and lower(i.email) = lower(${who.email})
    limit 1
  `;
  /* 404, а не 403: приглашения, которого нет, не существует и для того, кому его не присылали. */
  if (!invite) return { status: 404, body: { error: 'no invitation to that team' } };

  const [{ n }] = await sql`select count(*)::int as n from team_member where team_id = ${teamId}`;
  if (n >= MEMBERS_MAX) return { status: 400, body: { error: 'that team is full' } };

  await sql`
    insert into team_member (team_id, user_id, role, invited_by)
    values (${teamId}, ${who.id}, ${invite.role}, ${invite.invited_by})
    on conflict (team_id, user_id) do nothing
  `;
  await sql`delete from team_invite where team_id = ${teamId} and lower(email) = lower(${who.email})`;
  return { status: 200, body: { ok: true, joined: true } };
}

/** Отказ. Приглашение исчезает; пригласивший узнает об этом по тому, что человек не появился. */
async function declineInvite(sql, who, teamId) {
  if (!who.email) return { status: 400, body: { error: 'this account has no email address' } };
  await sql`delete from team_invite where team_id = ${teamId} and lower(email) = lower(${who.email})`;
  return { status: 200, body: { ok: true, joined: false } };
}

/* ------------------------------------------------------------------------------- reads */

async function myTeams(sql, who) {
  const teams = await sql`
    select t.id, t.name, t.created_at, m.role, m.joined_at,
           (select count(*)::int from team_member x where x.team_id = t.id) as members
    from team_member m
    join team t on t.id = m.team_id and t.deleted_at is null
    where m.user_id = ${who.id}
    order by t.created_at
  `;
  /* Whether a message would actually go anywhere, answered before somebody types an address rather than
   * after. The screen that adds people is the only place this matters, and being told "no email could be
   * sent" AFTER inviting four colleagues is the wrong minute to find out. */
  const problem = mailProblem();
  /* Приглашения - рядом со списком, а не отдельным запросом: экран Teams это единственное место, где на
   * них отвечают, и он и так сюда ходит. */
  const invitations = await pendingFor(sql, who);
  return { teams, invitations, mail: { configured: !problem, problem } };
}

/** One team. Activity is included only for the roles that may see it; a member gets the roster. */
async function oneTeam(sql, who, teamId) {
  const role = await roleOf(sql, teamId, who.id);
  if (!role) return null;

  const [team] = await sql`select id, name, created_at, created_by from team where id = ${teamId} and deleted_at is null`;
  if (!team) return null;

  const members = await sql`
    select user_id::text as id, role, joined_at from team_member where team_id = ${teamId} order by joined_at
  `;
  const people = await peopleFor(sql, members.map((m) => m.id));

  /* What each person HOLDS and when they were last busy - counts and dates, never content, and only for the
   * roles that run the team.
   *
   * ACCOUNT-WIDE, not team-scoped, and that is not an oversight to be tidied later: a recording belongs to
   * an account, and only a SHARE connects one to a team, so there is nothing to scope these by. An owner
   * sees "twelve recordings", not "twelve for us". Said here because the comment used to claim the
   * opposite, and a wrong comment about who can see what is worse than none. */
  let activity = new Map();
  if (manages(role)) {
    const ids = members.map((m) => m.id);
    const rows = ids.length ? await sql`
      select u.id::text as id,
             coalesce(f.recordings, 0)::int as recordings,
             coalesce(f.skills, 0)::int     as skills,
             coalesce(r.runs, 0)::int       as runs,
             f.last_recorded, r.last_run
      from (select unnest(${ids}::uuid[]) as id) u
      left join (
        select user_id,
               count(*) filter (where payload->>'role' is distinct from 'skill')::int as recordings,
               count(*) filter (where payload->>'role' = 'skill')::int as skills,
               max(updated_at) as last_recorded
        from user_flow where deleted_at is null group by user_id
      ) f on f.user_id = u.id
      left join (
        select user_id, count(*)::int as runs, max(started_at) as last_run
        from user_run group by user_id
      ) r on r.user_id = u.id
    ` : [];
    activity = new Map(rows.map((r) => [r.id, r]));
  }

  const invites = manages(role)
    ? await sql`select email, role, created_at from team_invite where team_id = ${teamId} order by created_at`
    : [];

  /* The skills people have deliberately shown this team. Names and owners, not payloads: opening one is a
   * separate act with an id in it, exactly as the admin screens work. */
  const shared = await sql`
    select s.flow_id, s.user_id::text as owner_id, s.shared_at, f.name, f.description, f.source, f.kind
    from team_share s
    join team_member m on m.team_id = s.team_id and m.user_id = s.user_id
    left join user_flow f on f.user_id = s.user_id and f.client_id = s.flow_id and f.deleted_at is null
    where s.team_id = ${teamId}
    order by s.shared_at desc
  `;

  return {
    team: { id: team.id, name: team.name, created: team.created_at, createdBy: team.created_by },
    you: { role },
    members: members.map((m) => {
      const person = people.get(m.id) || {};
      const act = activity.get(m.id);
      return {
        id: m.id,
        role: m.role,
        joined: m.joined_at,
        name: person.name ?? null,
        email: person.email ?? null,
        /* Absent rather than zero when the caller may not see it: nothing here should let a member work out
         * how busy a colleague is by reading a missing field as a number. */
        activity: act
          ? {
            recordings: act.recordings, skills: act.skills, runs: act.runs,
            lastRecorded: act.last_recorded, lastRun: act.last_run,
          }
          : null,
      };
    }),
    invites: invites.map((i) => ({ email: i.email, role: i.role, created: i.created_at })),
    shared: shared.map((s) => ({
      flowId: s.flow_id,
      ownerId: s.owner_id,
      owner: (people.get(s.owner_id) || {}).name ?? (people.get(s.owner_id) || {}).email ?? null,
      name: s.name ?? null,
      description: s.description ?? null,
      source: s.source ?? null,
      kind: s.kind ?? null,
      /* A share whose flow is gone. Said, not hidden: "this was shared and has since been deleted" is a
       * different fact from "this was never shared". */
      missing: s.name == null,
      at: s.shared_at,
    })),
  };
}

/* ------------------------------------------------------------------------------- writes */

async function createTeam(sql, who, body) {
  const name = text(body && body.name, NAME_MAX);
  if (!name) return { status: 400, body: { error: 'a team needs a name' } };
  const [{ n }] = await sql`
    select count(*)::int as n from team_member m join team t on t.id = m.team_id and t.deleted_at is null
    where m.user_id = ${who.id}
  `;
  if (n >= TEAMS_PER_PERSON) {
    return { status: 400, body: { error: `you are already in ${n} teams, which is the limit` } };
  }
  const id = newId();
  await sql`insert into team (id, name, created_by) values (${id}, ${name}, ${who.id})`;
  await sql`insert into team_member (team_id, user_id, role) values (${id}, ${who.id}, 'owner')`;
  return { status: 200, body: { ok: true, id, name } };
}

async function addMember(sql, who, teamId, body, origin) {
  const role = await roleOf(sql, teamId, who.id);
  if (!manages(role)) return { status: 404, body: { error: 'not found' } };

  const email = text(body && body.email, 200);
  const wanted = ROLES.includes(body && body.role) ? body.role : 'member';
  if (!email || !email.includes('@')) return { status: 400, body: { error: 'that is not an email address' } };
  /* Only an owner hands out the roles that can hand out roles. An admin who could make owners could make
   * themselves one, which is the same as having no roles at all. */
  if (wanted !== 'member' && role !== 'owner') {
    return { status: 403, body: { error: 'only the owner can add an owner or an admin' } };
  }

  const [{ n }] = await sql`select count(*)::int as n from team_member where team_id = ${teamId}`;
  if (n >= MEMBERS_MAX) return { status: 400, body: { error: 'this team is full' } };

  const [{ sent }] = await sql`
    select count(*)::int as sent from team_invite
    where invited_by = ${who.id} and created_at > now() - interval '1 hour'
  `;
  if (sent >= INVITES_PER_HOUR) {
    return { status: 429, body: { error: `that is ${sent} invitations in an hour, which is the limit. Try later.` } };
  }

  const [team] = await sql`select name from team where id = ${teamId} and deleted_at is null`;

  const found = await sql`
    select u.id::text as id from neon_auth."user" u where lower(to_jsonb(u)->>'email') = lower(${email}) limit 1
  `;
  /* ВСЕГДА ПРИГЛАШЕНИЕ, НИКОГДА ЧЛЕНСТВО.
   *
   * Здесь была развилка: если адрес принадлежит существующему аккаунту - вписать в team_member сразу.
   * То есть любой, кто знает чужой адрес, заводил команду, добавлял туда человека и получал доступ к его
   * целям прогонов, трассам шагов и заголовкам окон через /api/insights?team=…&person=… Человека при этом
   * никто не спрашивал, и узнать он мог только заглянув в Teams.
   *
   * Существует аккаунт или нет - разница только в том, что написать в письме («откройте приложение» против
   * «заведите аккаунт»); на то, кто попадёт в команду, она влиять не может.
   *
   * `already` - это не приглашение: человек уже в команде, и второе письмо ему не нужно. */
  const already = found.length > 0
    ? await sql`select 1 from team_member where team_id = ${teamId} and user_id = ${found[0].id} limit 1`
    : [];
  if (already.length) {
    return { status: 200, body: { ok: true, added: true, already: true, mailed: false } };
  }

  const [invited] = await sql`
    insert into team_invite (team_id, email, role, invited_by) values (${teamId}, ${email}, ${wanted}, ${who.id})
    on conflict (team_id, email) do update set role = excluded.role
    returning created_at
  `;

  const post = await tellThem(who, email, team && team.name, wanted, found.length > 0, origin);
  /* `added` теперь всегда false: никто не добавлен, приглашение отправлено. Поле оставлено, потому что
   * старый клиент его читает, и врать ему «добавлен» было бы хуже, чем сказать правду. */
  return { status: 200, body: { ok: true, added: false, invited: !!invited, ...post } };
}

/* Telling somebody they are in a team.
 *
 * Separated from the write above because it is a different kind of thing: the write either happened or it
 * did not, and this either reached somebody or did not. Both outcomes are reported - `mailed`, and `note`
 * in the words of somebody who has to act on it - because the two failure modes look identical from the
 * outside and want opposite responses. Mail is not configured on this deployment: go and set two variables.
 * Mail is configured and bounced: check the address. Silence would leave the person inviting to guess.
 */
async function tellThem(who, email, teamName, role, added, origin) {
  const url = `${origin}/team`;
  const { subject, text: body, html } = invitationMail({
    teamName,
    inviterName: who.name,
    inviterEmail: who.email,
    toEmail: email,
    url,
    hasAccount: added,
    role,
  });
  const out = await sendMail({ to: email, subject, text: body, html, replyTo: who.email || undefined });

  if (out.sent) {
    return {
      mailed: true,
      note: added
        ? `${email} is in, and has been emailed a link to the team.`
        : `${email} has no account here yet. They have been emailed: when they sign up with that address `
          + 'and open Teams, they are in.',
    };
  }
  /* The old behaviour, word for word, and it is still the true one when nothing can be sent: tell them
   * yourself. An invitation that quietly depended on a message arriving would be one that silently did
   * not happen. */
  return {
    mailed: false,
    mailProblem: out.why || null,
    note: added
      ? `${email} is in. No email was sent — ${out.why}. Tell them yourself.`
      : `${email} has no account here yet. They are on the list: when they sign up with that address and `
        + `open Teams, they will be in. No email was sent — ${out.why}. Tell them yourself.`,
  };
}

/* Sending it again, for an invitation that is still waiting.
 *
 * Its own verb rather than a repeat of the add, because re-adding somebody who is already on the list reads
 * as a change to their role when it is not one, and because a person who lost the first message should not
 * have to be removed and re-invited to get a second. */
async function remind(sql, who, teamId, email, origin) {
  const role = await roleOf(sql, teamId, who.id);
  if (!manages(role)) return { status: 404, body: { error: 'not found' } };

  const [invite] = await sql`
    select email, role from team_invite where team_id = ${teamId} and lower(email) = lower(${email})
  `;
  if (!invite) return { status: 404, body: { error: 'nobody is waiting on that address' } };

  const [team] = await sql`select name from team where id = ${teamId} and deleted_at is null`;
  const post = await tellThem(who, invite.email, team && team.name, invite.role, false, origin);
  return { status: post.mailed ? 200 : 502, body: { ok: post.mailed, ...post } };
}

/* Renaming a team.
 *
 * On the same verb as a role change because both are "change something about this team", and both are the
 * owner's alone. It exists at all because the screen has told every owner "you can rename it, delete it,
 * and move anybody's role" since the day teams shipped, and two of those three were true: there was no
 * route that changed a name. A sentence in an interface is a promise, and this is the cheaper half of
 * keeping it.
 */
async function renameTeam(sql, who, teamId, body) {
  const role = await roleOf(sql, teamId, who.id);
  if (role !== 'owner') return { status: 404, body: { error: 'not found' } };
  const name = text(body && body.name, NAME_MAX);
  if (!name) return { status: 400, body: { error: 'a team needs a name' } };
  const done = await sql`
    update team set name = ${name} where id = ${teamId} and deleted_at is null returning id
  `;
  if (!done.length) return { status: 404, body: { error: 'not found' } };
  return { status: 200, body: { ok: true, name } };
}

async function setRole(sql, who, teamId, body) {
  const role = await roleOf(sql, teamId, who.id);
  if (role !== 'owner') return { status: 404, body: { error: 'not found' } };
  const target = text(body && body.userId, 64);
  const wanted = ROLES.includes(body && body.role) ? body.role : null;
  if (!target || !wanted) return { status: 400, body: { error: 'a member and a role, please' } };
  if (target === who.id && wanted !== 'owner') {
    /* An owner demoting themselves while alone would leave a team nobody can manage. */
    const [{ n }] = await sql`select count(*)::int as n from team_member where team_id = ${teamId} and role = 'owner'`;
    if (n <= 1) return { status: 400, body: { error: 'make somebody else an owner first' } };
  }
  const done = await sql`
    update team_member set role = ${wanted} where team_id = ${teamId} and user_id = ${target} returning user_id
  `;
  if (!done.length) return { status: 404, body: { error: 'they are not in this team' } };
  return { status: 200, body: { ok: true } };
}

async function removeMember(sql, who, teamId, target) {
  const mine = await roleOf(sql, teamId, who.id);
  if (!mine) return { status: 404, body: { error: 'not found' } };
  const leaving = !target || target === who.id;
  if (!leaving && !manages(mine)) return { status: 403, body: { error: 'only an owner or admin can do that' } };

  const id = leaving ? who.id : target;
  const [them] = await sql`select role from team_member where team_id = ${teamId} and user_id = ${id}`;
  if (!them) return { status: 404, body: { error: 'they are not in this team' } };
  if (!leaving && them.role !== 'member' && mine !== 'owner') {
    return { status: 403, body: { error: 'only the owner can remove an owner or an admin' } };
  }
  if (them.role === 'owner') {
    const [{ n }] = await sql`select count(*)::int as n from team_member where team_id = ${teamId} and role = 'owner'`;
    if (n <= 1) return { status: 400, body: { error: 'a team needs an owner - hand it over first' } };
  }
  await sql`delete from team_member where team_id = ${teamId} and user_id = ${id}`;
  /* Their shares go with them. A share means "this person let the team see this", and they are no longer
   * this person's team. */
  await sql`delete from team_share where team_id = ${teamId} and user_id = ${id}`;
  return { status: 200, body: { ok: true, left: leaving } };
}

async function share(sql, who, teamId, flowId, on) {
  const role = await roleOf(sql, teamId, who.id);
  if (!role) return { status: 404, body: { error: 'not found' } };
  if (!on) {
    await sql`delete from team_share where team_id = ${teamId} and user_id = ${who.id} and flow_id = ${flowId}`;
    return { status: 200, body: { ok: true, shared: false } };
  }
  /* Only your own, and only something that exists. Sharing is a statement about your own work; there is no
   * shape of this request that can put somebody else's row in front of a team. */
  const mine = await sql`
    select client_id from user_flow where user_id = ${who.id} and client_id = ${flowId} and deleted_at is null
  `;
  if (!mine.length) return { status: 404, body: { error: 'you have nothing with that id' } };
  await sql`
    insert into team_share (team_id, user_id, flow_id) values (${teamId}, ${who.id}, ${flowId})
    on conflict (team_id, user_id, flow_id) do nothing
  `;
  return { status: 200, body: { ok: true, shared: true } };
}

async function deleteTeam(sql, who, teamId) {
  const role = await roleOf(sql, teamId, who.id);
  if (role !== 'owner') return { status: 404, body: { error: 'not found' } };
  /* Tombstoned, like a flow: the rows stay, the team stops existing for every read. Nobody's recordings are
   * touched by this - a team never held any. */
  await sql`update team set deleted_at = now() where id = ${teamId}`;
  return { status: 200, body: { ok: true, deleted: true } };
}

/* ------------------------------------------------------------------------------- the route */

async function handler(req, res) {
  cors(req, res, 'GET, POST, PATCH, DELETE, OPTIONS');
  if (req.method === 'OPTIONS') { res.status(204).end(); return; }
  if (!process.env.DATABASE_URL) return fail(res, 503, 'This deployment has no database configured.');

  const sql = neon(process.env.DATABASE_URL);
  let who;
  try {
    who = await whoIsCalling(req, sql);
  } catch (_) {
    who = null;
  }
  if (!who) return fail(res, 401, 'Sign in first.');

  const query = req.query || {};
  const teamId = text(query.id, 64);
  const body = req.body && typeof req.body === 'object' ? req.body : {};

  /* Where the link in an invitation points. Read from the request rather than from a constant, because this
   * app is served from more than one hostname - a preview deployment, the production one - and a link that
   * always named production would send somebody testing a preview to the wrong deployment's account. The
   * forwarded pair is what Vercel sets in front of the function; the plain host is what a local dev server
   * has. */
  const proto = String(req.headers['x-forwarded-proto'] || 'https').split(',')[0].trim();
  const host = String(req.headers['x-forwarded-host'] || req.headers.host || '').split(',')[0].trim();
  const origin = `${proto}://${host}`;

  try {
    if (req.method === 'GET') {
      if (!teamId) return res.status(200).json({ ok: true, ...(await myTeams(sql, who)) });
      const one = await oneTeam(sql, who, teamId);
      /* Not found rather than forbidden, and for the reason every other private read here uses it: a 403
       * confirms that the team exists to somebody who was never meant to learn that. */
      if (!one) return fail(res, 404, 'not found');
      return res.status(200).json({ ok: true, ...one });
    }

    if (req.method === 'POST') {
      const flowId = text(query.share, 80);
      const again = text(query.remind, 200);
      /* СОГЛАСИЕ - ДЕЙСТВИЕ ЧЕЛОВЕКА, И ТОЛЬКО ИЗ СЕССИИ.
       *
       * Токен коннектора получен по согласию, которое перечисляет ровно три возможности: видеть записи,
       * просить машину записать или запустить скилл, и не читать набранное. Вступления в команду от чужого
       * имени там нет, и его туда не добавит ни один список областей, которого пока не существует. */
      if (query.accept || query.decline) {
        if (who.via !== 'session') {
          return fail(res, 403, 'only a signed-in browser can answer an invitation');
        }
        if (!teamId) return fail(res, 400, 'which team?');
        const out = query.accept
          ? await acceptInvite(sql, who, teamId)
          : await declineInvite(sql, who, teamId);
        return res.status(out.status).json(out.body);
      }
      const out = !teamId ? await createTeam(sql, who, body)
        : flowId ? await share(sql, who, teamId, flowId, true)
          : again ? await remind(sql, who, teamId, again, origin)
            : await addMember(sql, who, teamId, body, origin);
      return res.status(out.status).json(out.body);
    }

    if (req.method === 'PATCH') {
      if (!teamId) return fail(res, 400, 'which team?');
      /* Смена роли и переименование - тоже не то, за чем приходил коннектор. См. ниже про DELETE. */
      if (who.via !== 'session') {
        return fail(res, 403, 'only a signed-in browser can change a team');
      }
      /* A body carrying a name renames; one carrying a member and a role moves them. Told apart by what
       * was sent rather than by a mode flag, since the two bodies have no field in common. */
      const out = body && body.name !== undefined
        ? await renameTeam(sql, who, teamId, body)
        : await setRole(sql, who, teamId, body);
      return res.status(out.status).json(out.body);
    }

    if (req.method === 'DELETE') {
      if (!teamId) return fail(res, 400, 'which team?');
      /* РАЗРУШИТЕЛЬНОЕ - ТОЛЬКО ИЗ БРАУЗЕРА, как в account.js и sync.js.
       *
       * Экран согласия коннектора обещает три вещи и ни одна из них не «удалить команду» или «выкинуть из
       * неё человека». Между тем DELETE /api/team?id=…&team=1 с Bearer-токеном сносил команду для всех её
       * участников, а вместе с ней - через каскад - и общие записи. Регистрация клиентов открыта, так что
       * клиентом мог стать кто угодно.
       *
       * Проверяется способ, а не область: областей у токенов пока нет вовсе, и притворяться, что есть,
       * значило бы завести вторую систему прав, которая ничего не проверяет. */
      if (who.via !== 'session') {
        return fail(res, 403, 'only a signed-in browser can change a team');
      }
      const flowId = text(query.share, 80);
      const invited = text(query.invite, 200);
      if (flowId) {
        const out = await share(sql, who, teamId, flowId, false);
        return res.status(out.status).json(out.body);
      }
      if (invited) {
        const role = await roleOf(sql, teamId, who.id);
        if (!manages(role)) return fail(res, 404, 'not found');
        await sql`delete from team_invite where team_id = ${teamId} and lower(email) = lower(${invited})`;
        return res.status(200).json({ ok: true });
      }
      if (query.team) {
        const out = await deleteTeam(sql, who, teamId);
        return res.status(out.status).json(out.body);
      }
      const out = await removeMember(sql, who, teamId, text(query.user, 64));
      return res.status(out.status).json(out.body);
    }

    return fail(res, 405, 'GET, POST, PATCH or DELETE');
  } catch (err) {
    await report(err, req, { route: 'team' });
    return fail(res, 500, err.message);
  }
}

/* The outer net: anything thrown before or around the handler's own try block. */
export default wrap(handler, 'team');
