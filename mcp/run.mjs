/* Running one skill on this machine. The half that needs a mouse.
 *
 * Split out of server.mjs because there are now two things that ask for a run and only one way to do it:
 * the stdio server, where the decider is on the same machine, and the worker, where the decider is in the
 * cloud and this end claimed the job. A second copy of the replay path in the worker would be a second
 * answer to "how is a skill run", and the first divergence would be invisible - one route raising the window
 * and the other not.
 *
 * Nothing here knows about MCP, queues or JSON-RPC. It takes a skill and arguments and returns a sentence.
 */

const REPLAY_POLL_MS = 700;
/* Half an hour is right for a real replay - a long recording at half speed is a long time - and hopeless
 * for a test, where a transient turns into a thirty-minute hang instead of a failure with a message. Same
 * escape hatch the worker's poll has, and for the same reason: it exists to make the loop testable, not to
 * be tuned. */
const REPLAY_MAX_MS = Number(process.env.MOUSEFLOW_REPLAY_MAX_MS || 30 * 60 * 1000);
const ALLOWED_SPEEDS = [0.5, 1, 1.5, 2, 4];

const nowIso = () => new Date().toISOString();
export const runId = (prefix) => `${prefix}_${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;

/** A skill's payload as extension/skills.js expects one. */
const asSkill = (flow) => ({
  ...(flow.payload || {}),
  id: flow.id,
  name: flow.name,
  params: (flow.payload && flow.payload.params) || [],
});

export function makeRunner({ lib, port, base, token, say }) {
  const at = base.replace(/\/$/, '');

  /* Best effort, and reported. A run whose outcome never reached the account makes the dashboard wrong. */
  async function logRun(run) {
    try {
      const res = await fetch(`${at}/api/sync`, {
        method: 'POST',
        headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
        body: JSON.stringify({ runs: [run] }),
      });
      if (!res.ok) say(`the run was not logged to the account: HTTP ${res.status}`);
    } catch (err) {
      say(`the run was not logged to the account: ${err.message}`);
    }
  }

  async function health() {
    try {
      return { ok: true, health: await lib.agent.health(port) };
    } catch (err) {
      return {
        ok: false,
        why: err && err.offline
          ? `No MouseFlow agent answered on 127.0.0.1:${port}. It has to be running on this machine for `
            + 'anything here to happen - the app\'s Connections screen has the one-line install command.'
          : `The agent answered with an error: ${err.message}`,
      };
    }
  }

  /** A recorded desktop skill: raise the window it belongs to, then replay it and wait. */
  async function replay(flow, structure, args, isAborted) {
    const payload = flow.payload || {};
    const events = Array.isArray(payload.events) ? payload.events : [];
    if (!events.length) {
      return { ok: false, text: 'This skill holds no events, so there is nothing to replay.' };
    }

    const repeat = Math.min(999, Math.max(1, Math.round(Number(args.repeat) || 1)));
    const asked = Number(args.speed);
    const speed = ALLOWED_SPEEDS.includes(asked) ? asked : 1;
    const notes = [];
    if (args.speed !== undefined && speed !== asked) {
      notes.push(`speed ${args.speed} is not one of ${ALLOWED_SPEEDS.join(', ')}, so it ran at 1.`);
    }

    /* The window this was recorded in, brought forward first.
     *
     * A replay is coordinates and clicks and has no idea what is under them. The Record page does exactly
     * this before playing a row, for exactly this reason, and a skill payload carries the same `windows` the
     * recording did. Best effort: a window that has since closed should not refuse a run somebody asked for,
     * and the note says what was tried. */
    const front = Array.isArray(payload.windows) ? payload.windows[0] : null;
    if (front && (front.title || front.process)) {
      const body = `action=activate ${front.process ? `process=${front.process} ` : ''}`
        + `${front.title ? `title=${front.title}` : ''}`.trim();
      try {
        await lib.agent.doAction(port, body.trim());
        await new Promise((done) => setTimeout(done, 350));
      } catch (_) {
        notes.push(`${front.title || front.process} could not be brought to the front; it may not be open.`);
      }
    }

    const recording = { id: flow.id, name: flow.name, events, windows: payload.windows || [] };
    const body = lib.macro.flowBody(
      [{ recordingId: flow.id, repeat, speed, delayAfterMs: 0 }],
      [recording],
      { startDelayMs: 0, flowRepeat: 1, flowForever: false },
    );

    const startedAt = nowIso();
    try {
      await lib.agent.replay(port, body);
    } catch (err) {
      return { ok: false, text: `The agent would not start the replay: ${err.message}` };
    }

    /* Wait for it, because an answer that arrives before the work happened has told the caller nothing. */
    let last = null;
    const until = Date.now() + REPLAY_MAX_MS;
    while (Date.now() < until) {
      if (isAborted()) break;
      await new Promise((done) => setTimeout(done, REPLAY_POLL_MS));
      try {
        last = await lib.agent.replayStatus(port);
      } catch (_) {
        /* A status that cannot be read is not a failed replay - the agent may be busy injecting. Keep
         * waiting; the deadline is the backstop. */
        continue;
      }
      if (!last.playing) break;
    }

    const stopped = isAborted();
    const timedOut = !stopped && last && last.playing;
    const played = last ? last.index : events.length;
    const unplayable = last ? last.unplayable : 0;
    const retargeted = last ? last.retargeted : 0;

    if (unplayable) {
      notes.push(`${unplayable} event${unplayable === 1 ? '' : 's'} could not be played. Keystroke content `
        + 'is never stored by MouseFlow, so typing in a recording is not replayed - if this skill needed to '
        + 'type something, that part did not happen.');
    }
    if (retargeted) {
      notes.push(`${retargeted} click${retargeted === 1 ? ' was' : 's were'} re-aimed by name because what `
        + 'was recorded there had moved.');
    }

    const outcome = stopped ? 'stopped' : timedOut ? 'failed' : 'ok';
    await logRun({
      id: runId('mcp'),
      kind: 'replay',
      flowId: flow.id,
      goal: `${flow.name} (called as ${structure.toolName})`,
      outcome,
      summary: notes.join(' ') || null,
      error: timedOut ? 'the replay was still running after 30 minutes' : null,
      startedAt,
      finishedAt: nowIso(),
    });

    const head = stopped
      ? `Stopped. ${played} of ${events.length} events had been replayed.`
      : timedOut
        ? 'The replay was still running after 30 minutes and is no longer being waited for. '
          + 'Call mouseflow_stop to end it.'
        : `Replayed "${flow.name}" — ${events.length} event${events.length === 1 ? '' : 's'}`
          + `${repeat > 1 ? `, ${repeat} times` : ''}${speed !== 1 ? `, at ${speed}×` : ''}.`;

    /* A replay holds input, not outcome: nothing stored says whether the screen did what was wanted, and
     * the only honest report is what was sent, plus what could not be. */
    const caveat = outcome === 'ok'
      ? ' What the applications did with it is not something MouseFlow can see; the actions were sent.'
      : '';
    return { ok: outcome === 'ok', text: [head + caveat, ...notes].join('\n') };
  }

  /** A skill written as a goal: fill its template, then let the decision loop drive. */
  async function goal(flow, args, isAborted) {
    const skill = asSkill(flow);
    /* extension/skills.js owns both of these, and missingParams goes first as its own comment instructs:
     * fillGoal substitutes an empty string for anything it cannot resolve, so calling it alone turns a
     * missing argument into a goal with a hole in it and a run that does something almost right. */
    const missing = lib.skills.missingParams(skill, args);
    if (missing.length) {
      return {
        ok: false,
        text: `This skill needs ${missing.join(', ')}. Ask the user for the missing value rather than `
          + 'guessing one: the goal is carried out on their real computer and cannot be undone from here.',
      };
    }

    const text = lib.skills.fillGoal(skill, args);
    if (!text || !text.trim()) {
      return { ok: false, text: 'This skill has no goal text to carry out.' };
    }

    const startedAt = nowIso();
    const seen = [];
    let result;
    try {
      result = await lib.engine.runOnDesktop({
        goal: text,
        machine: lib.agent.localMachine(port),
        onEvent: (event) => {
          if (event.type === 'tool' && event.name) seen.push(event.name);
          if (event.type === 'error') say(`run: ${event.message || 'error'}`);
        },
        isAborted,
      });
    } catch (err) {
      result = { ok: false, error: err.message, steps: [] };
    }

    const outcome = isAborted() ? 'stopped' : result.ok ? 'ok' : 'failed';
    await logRun({
      id: runId('mcp'),
      kind: 'agent',
      flowId: flow.id,
      goal: text,
      outcome,
      summary: result.said || null,
      error: result.ok ? null : result.error || null,
      steps: result.steps || [],
      startedAt,
      finishedAt: nowIso(),
    });

    const took = `${(result.steps || []).length} action${(result.steps || []).length === 1 ? '' : 's'}`;
    if (outcome === 'stopped') return { ok: false, text: `Stopped after ${took}.` };
    if (!result.ok) {
      return {
        ok: false,
        text: `The run did not finish: ${result.error || 'no reason was given'}. It took ${took}`
          + `${seen.length ? ` (${[...new Set(seen)].join(', ')})` : ''}.`,
      };
    }
    return { ok: true, text: `${result.said || 'Done.'} (${took})` };
  }

  /* ------------------------------------------------------------------ the timer
   *
   * Recording is the one thing the queue carries that is not a skill: an instruction to the agent. Start is
   * a single call. Stop hands the five-column body back UNCHANGED - turning it into a row on the account is
   * saveRecording() in api/mcp.js, not this.
   *
   * That split is deliberate and it is what makes this process replaceable. Everything a claimer would
   * otherwise have to know - the payload shape, the flow id, the stamp that says a row is a recording, the
   * parser - lives on the server in one copy. What is left here is "ask the agent, hand back what it said",
   * which is small enough for the agent itself to do.
   */
  async function command(what, args) {
    const h = await health();
    if (!h.ok) return { ok: false, text: h.why };

    if (what === '#record.start') {
      if (h.health.recording) {
        return { ok: false, text: 'It is already recording. Stop it first, or leave it running.' };
      }
      if (h.health.playing) {
        return { ok: false, text: 'It is replaying something right now, so it will not start recording on '
          + 'top of that.' };
      }
      const moveMs = Math.min(1000, Math.max(0, Math.round(Number(args && args.moveMs) || 0)));
      try {
        await lib.agent.recordStart(port, moveMs || undefined);
      } catch (err) {
        return { ok: false, text: `The agent would not start recording: ${err.message}` };
      }
      return {
        ok: true,
        text: 'Recording. It captures clicks, drags, scrolls and pointer movement, and that a key was '
          + 'pressed - never which key. Call mouseflow_stop_recording to end it and save it.'
          + (moveMs ? ` Pointer movement is sampled every ${moveMs}ms.` : ''),
      };
    }

    if (what === '#record.stop') {
      if (!h.health.recording) return { ok: false, text: 'Nothing was recording.' };

      let body;
      try {
        body = await lib.agent.recordStop(port);
      } catch (err) {
        return { ok: false, text: `The agent would not stop: ${err.message}` };
      }

      /* Handed over raw. Turning the five-column body into a row happens on the server - see saveRecording
       * in api/mcp.js - so that the thing which claims the job does not have to know about payload shapes,
       * flow ids or the stamp that says a row is a recording. That is what lets the AGENT claim it directly
       * and this worker stop being necessary. The answer the caller reads is written there too, from what
       * was actually saved rather than from what was sent. */
      return { ok: true, text: '', body, health: h.health };
    }

    return { ok: false, text: `The machine was asked to do "${what}", which it does not know how to do.` };
  }

  /** The one entry point: a skill, its arguments, and a way to be told to stop. */
  async function call({ flow, structure }, args, isAborted = () => false) {
    if (structure.runner !== 'agent') {
      return {
        ok: false,
        text: `"${flow.name}" aims at elements in a web page, so the MouseFlow browser extension is the half `
          + 'that can replay it. This end drives the desktop agent, which has no page to aim at. Ask the '
          + 'user to run it from the extension.',
      };
    }
    const h = await health();
    if (!h.ok) return { ok: false, text: h.why };

    return structure.kind === 'created'
      ? goal(flow, args, isAborted)
      : replay(flow, structure, args, isAborted);
  }

  return { health, call, command, logRun };
}
