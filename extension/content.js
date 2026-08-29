/* MouseFlow content script - capture and replay inside a page.
 *
 * This is the web counterpart to the desktop agent. The crucial difference is what a step
 * points at: the desktop agent records absolute screen pixels, which break the moment a
 * window moves. Here we record the ELEMENT, plus where inside it the click landed. That
 * survives window resizes, layout shifts, scrolling and different screen resolutions.
 *
 * Motion is recorded the same way the agent records it - a sample every frame or so - and
 * replayed as interpolated animation, so a flow looks the same in the browser as it does on
 * the desktop. The one honest difference is that the agent moves the real pointer, so it
 * gets hover styling and cross-application reach for free; a page can only draw a pointer
 * and raise the events, which leaves CSS :hover dark. Everything else matches.
 *
 * Injected on demand by the background worker, never declared in the manifest, so nothing
 * runs in a page until the user actually starts recording or replaying.
 */

(() => {
  'use strict';

  /* Only ONE generation of this script may be wired up in a page, and it must be the newest.
   *
   * Keying this on the manifest version did not cover the case the comment named: reloading an
   * unpacked extension does not change the version, so a same-version reload still bailed out and
   * left the orphaned copy in charge.
   *
   * What identifies a generation is its extension CONTEXT, not the version - and a generation can
   * be ASKED whether its context is still valid, because an orphaned one loses chrome.runtime. So
   * each generation leaves a marker carrying a liveness probe. A newer copy runs the previous
   * marker's probe: if it answers, that generation is alive and this injection is a no-op; if it
   * does not, the previous generation is orphaned and is switched off. The marker object is
   * shared, so every handler still held by the old closure sees `live` go false.
   */
  const previous = window.__mouseflowContent;
  const priorObject = previous && typeof previous === 'object';
  if (priorObject && typeof previous.alive === 'function' && previous.alive()) return;
  if (priorObject) previous.live = false;

  const generation = {
    live: true,
    alive: () => {
      try { return !!chrome.runtime.id; } catch (_) { return false; }
    },
  };
  window.__mouseflowContent = generation;

  // An orphaned generation may have left its cursor or trail behind, and can no longer be asked
  // to clean up after itself.
  if (previous) {
    for (const node of document.querySelectorAll('[data-mouseflow]')) node.remove();
  }

  const SCROLL_MIN_MS = 120;    // scroll events fire in floods; thin them
  const WAIT_TIMEOUT_MS = 8000; // how long replay waits for a missing element

  /* Motion sampling, mirroring the desktop agent's -MoveThrottleMs / -MoveMinPx.
   * The agent keeps a sample every 10ms / 3px; one animation frame and 4px is the same
   * idea at the resolution a browser can actually redraw at. */
  const MOVE_MIN_MS = 16;
  const MOVE_MIN_PX = 4;
  const MOVE_FLUSH_MS = 250;    // motion is batched to the worker; clicks never are
  const HOVER_MS = 50;          // how often replay re-aims hover events while travelling

  const IS_TOP = window === window.top;

  let capturing = false;
  let lastScrollAt = 0;

  /* ------------------------------------------------------------- selectors */

  // Framework-generated ids are worse than useless as selectors - they change on
  // every build or every mount, so a recording made against one is dead on arrival.
  function isStableId(id) {
    if (!id || id.length > 60) return false;
    if (/\d{4,}/.test(id)) return false;                 // counters
    if (/^[0-9a-f]{8,}$/i.test(id)) return false;        // hashes
    if (/^(:|r[0-9a-z]{2,}$|mui-|radix-|headlessui-)/i.test(id)) return false;
    return true;
  }

  function quote(value) {
    return '"' + String(value).replace(/["\\]/g, '\\$&') + '"';
  }

  function attrSelector(el) {
    for (const attr of ['data-testid', 'data-test-id', 'data-test', 'data-qa', 'data-cy']) {
      const v = el.getAttribute(attr);
      if (v) return '[' + attr + '=' + quote(v) + ']';
    }
    if (isStableId(el.id)) return '#' + CSS.escape(el.id);
    const name = el.getAttribute('name');
    if (name && /^(input|select|textarea|button)$/i.test(el.tagName)) {
      return el.tagName.toLowerCase() + '[name=' + quote(name) + ']';
    }
    const label = el.getAttribute('aria-label');
    if (label && label.length < 60) return el.tagName.toLowerCase() + '[aria-label=' + quote(label) + ']';
    return null;
  }

  function nthOfType(el) {
    const parent = el.parentElement;
    if (!parent) return el.tagName.toLowerCase();
    const siblings = [...parent.children].filter((c) => c.tagName === el.tagName);
    const base = el.tagName.toLowerCase();
    if (siblings.length === 1) return base;
    return base + ':nth-of-type(' + (siblings.indexOf(el) + 1) + ')';
  }

  // Shortest path that still resolves uniquely: stop climbing as soon as an
  // ancestor gives us a stable anchor.
  function selectorFor(el) {
    const direct = attrSelector(el);
    if (direct && document.querySelectorAll(direct).length === 1) return direct;

    const parts = [];
    let node = el;
    while (node && node.nodeType === 1 && node !== document.documentElement) {
      const anchor = attrSelector(node);
      if (anchor) {
        parts.unshift(anchor);
        const candidate = parts.join(' > ');
        if (document.querySelectorAll(candidate).length === 1) return candidate;
        parts.shift();
      }
      parts.unshift(nthOfType(node));
      const candidate = parts.join(' > ');
      if (document.querySelectorAll(candidate).length === 1) return candidate;
      node = node.parentElement;
    }
    return parts.join(' > ');
  }

  function visibleText(el) {
    const text = (el.innerText || el.textContent || '').trim().replace(/\s+/g, ' ');
    return text.slice(0, 80);
  }

  function describe(el, clientX, clientY) {
    const rect = el.getBoundingClientRect();
    return {
      selector: selectorFor(el),
      tag: el.tagName.toLowerCase(),
      text: visibleText(el),
      // Where in the element the pointer was, as a fraction. Replaying the fraction
      // rather than a pixel offset keeps the click on target when the box resizes.
      rx: rect.width ? Math.min(1, Math.max(0, (clientX - rect.left) / rect.width)) : 0.5,
      ry: rect.height ? Math.min(1, Math.max(0, (clientY - rect.top) / rect.height)) : 0.5,
    };
  }

  /* --------------------------------------------------------------- capture */

  /* Every event is handed to the background worker the instant it happens, rather than
   * buffered here and collected at the end.
   *
   * The buffer used to live in this script, which meant a page navigation destroyed
   * everything recorded up to that point - the recording silently kept only whatever
   * happened after the last page load. Any real flow ("open Gmail, click Compose, send")
   * navigates, so that was most of the recording. The worker also owns the clock, so
   * timings stay continuous instead of restarting with each page's performance.now().
   */
  function push(partial) {
    if (!capturing) return;
    try {
      chrome.runtime.sendMessage({ mf: 'capture/event', event: partial });
    } catch (_) {
      // Extension context invalidated (reloaded mid-recording). Nothing useful to do.
    }
  }

  /* A double click has to be worked out, not read off the event.
   *
   * This used to test `ev.detail > 1`, but `detail` is 0 on a pointerdown - the click count only
   * appears on click and dblclick - so it was never true and no recording ever contained a double
   * click. Two presses close together in time and place on the same element is what one is.
   */
  const DBLCLICK_MS = 400;
  const DBLCLICK_PX = 6;
  let lastDownAt = 0;
  let lastDownX = 0;
  let lastDownY = 0;
  let lastDownEl = null;

  function onPointerDown(ev) {
    if (!capturing || !generation.live || !ev.isTrusted) return;
    const el = ev.target;
    if (!el || el.nodeType !== 1) return;
    // Motion recorded so far has to reach the worker before the click does, or the
    // sequence arrives scrambled. Sends from one frame keep their order, so flushing
    // first is enough.
    flushMoves();

    const at = performance.now();
    const isDouble = ev.button === 0 && lastDownEl === el &&
      at - lastDownAt < DBLCLICK_MS &&
      Math.abs(ev.clientX - lastDownX) <= DBLCLICK_PX &&
      Math.abs(ev.clientY - lastDownY) <= DBLCLICK_PX;
    lastDownAt = at;
    lastDownX = ev.clientX;
    lastDownY = ev.clientY;
    lastDownEl = el;

    // The worker folds a dblclick into the click it already recorded rather than appending a
    // second step - two steps would replay as three clicks.
    push(Object.assign({
      action: isDouble ? 'dblclick' : 'click',
      button: ev.button,
    }, describe(el, ev.clientX, ev.clientY)));
  }

  /* Motion is recorded, not just the clicks.
   *
   * This is the whole reason a replayed flow looked broken next to the desktop agent. The
   * agent hooks WM_MOUSEMOVE and keeps a sample every 10ms / 3px, so replay walks the real
   * cursor along the path the user actually took. This script recorded clicks only, which
   * left replay nothing to draw between them - the same work performed, but unreadable.
   *
   * Samples are batched rather than sent one at a time: a click has to reach the worker
   * before the page can navigate away, but motion is worth at most one flush interval,
   * and 60 messages a second per frame is not.
   */
  let moveBuf = [];
  let moveTimer = null;
  let lastMoveAt = 0;           // performance.now() of the last KEPT sample
  let lastMoveX = 0;
  let lastMoveY = 0;
  let haveMove = false;

  function onPointerMove(ev) {
    if (!capturing || !generation.live || !ev.isTrusted) return;
    const now = performance.now();
    const x = ev.clientX;
    const y = ev.clientY;

    // Far enough apart in time AND space, exactly as the agent filters its hook.
    if (haveMove) {
      if (now - lastMoveAt < MOVE_MIN_MS) return;
      if (Math.abs(x - lastMoveX) < MOVE_MIN_PX && Math.abs(y - lastMoveY) < MOVE_MIN_PX) return;
    }

    moveBuf.push({
      x: Math.round(x),
      y: Math.round(y),
      dt: haveMove ? Math.round(now - lastMoveAt) : 0,
    });
    lastMoveAt = now;
    lastMoveX = x;
    lastMoveY = y;
    haveMove = true;

    if (!moveTimer) moveTimer = setTimeout(flushMoves, MOVE_FLUSH_MS);
  }

  /* `age` back-dates the batch for the worker.
   *
   * The worker owns the clock, because a page's performance.now() restarts on navigation,
   * so it stamps events as they arrive. A batch arrives up to a flush interval late, and
   * taking that at face value would insert the lag into the replay. Reporting how long ago
   * the last sample was taken lets the worker put the run back where it belongs.
   */
  function flushMoves() {
    if (moveTimer) {
      clearTimeout(moveTimer);
      moveTimer = null;
    }
    if (!moveBuf.length) return;
    const points = moveBuf;
    moveBuf = [];
    try {
      chrome.runtime.sendMessage({
        mf: 'capture/moves',
        points,
        age: Math.max(0, Math.round(performance.now() - lastMoveAt)),
      });
    } catch (_) {
      // Extension context invalidated (reloaded mid-recording).
    }
  }

  /* Recording is mouse-only, by design.
   *
   * Text entry used to be captured here. It is not any more: typed text turned out to
   * be the unreliable half of recording (fields that never fire the events we listened
   * for, framework-controlled inputs, editors inside iframes), and a recording that
   * silently drops the text is worse than one that never claimed to carry it. Typing a
   * value is also the part that most often needs to differ between runs, which a fixed
   * recording cannot express anyway.
   *
   * "Create the flow" handles anything involving text - it is told what to write, so it
   * has no capture step to get wrong.
   *
   * Replay still understands `fill`, `redacted` and `key` steps so older recordings and
   * imported .mmmacro files keep working; nothing produces them any more.
   */

  /* Scroll does not bubble, which is why this listens in the capture phase - but it then recorded
   * the WINDOW's offsets whatever had actually scrolled, so scrolling a pane, a list or a dialog
   * replayed as a no-op. Record the thing that scrolled. */
  function onScroll(ev) {
    if (!capturing || !generation.live) return;
    const now = performance.now();
    if (now - lastScrollAt < SCROLL_MIN_MS) return;
    lastScrollAt = now;
    flushMoves();

    const target = ev && ev.target;
    const inner = target && target.nodeType === 1 &&
      target !== document.documentElement && target !== document.body;
    if (inner) {
      push(Object.assign({
        action: 'scroll',
        scrollLeft: Math.round(target.scrollLeft),
        scrollTop: Math.round(target.scrollTop),
      }, describe(target, 0, 0)));
      return;
    }
    push({ action: 'scroll', scrollX: Math.round(scrollX), scrollY: Math.round(scrollY) });
  }

  function startCapture() {
    if (capturing) return;
    capturing = true;
    haveMove = false;
    moveBuf = [];
    addEventListener('pointerdown', onPointerDown, true);
    addEventListener('pointermove', onPointerMove, { capture: true, passive: true });
    addEventListener('scroll', onScroll, true);
    // A frame that is not the top one needs to know where it sits before its samples mean
    // anything in the tab's coordinate space.
    trackOffset(true);
  }

  function stopCapture() {
    if (capturing) flushMoves();
    capturing = false;
    removeEventListener('pointerdown', onPointerDown, true);
    removeEventListener('pointermove', onPointerMove, { capture: true });
    removeEventListener('scroll', onScroll, true);
    trackOffset(false);
  }

  /* ---------------------------------------------------------------- replay */

  function sleep(ms) {
    return new Promise((done) => setTimeout(done, ms));
  }

  // Pages navigate, render late and animate. Poll rather than assume the node is there.
  async function resolve(ev) {
    const deadline = Date.now() + WAIT_TIMEOUT_MS;
    while (Date.now() < deadline) {
      let el = null;
      try {
        el = document.querySelector(ev.selector);
      } catch (_) {
        // A selector recorded on another page version may not even parse.
      }
      // Fall back to matching the same tag by its visible text, which survives
      // class churn and re-ordering that breaks an nth-of-type path.
      if (!el && ev.text) {
        el = [...document.getElementsByTagName(ev.tag)]
          .find((n) => visibleText(n) === ev.text) || null;
      }
      if (el && el.isConnected) return el;
      await sleep(120);
    }
    throw new Error('could not find ' + (ev.text ? '"' + ev.text + '"' : ev.selector));
  }

  function pointAt(el, ev) {
    const r = el.getBoundingClientRect();
    return {
      clientX: Math.round(r.left + (ev.rx == null ? 0.5 : ev.rx) * r.width),
      clientY: Math.round(r.top + (ev.ry == null ? 0.5 : ev.ry) * r.height),
    };
  }

  /* `buttons` is a bitmask of what is held DOWN at the moment of the event, and only a
   * `*down` event is such a moment. Everything else - up, click, move, over, out - happens
   * with nothing pressed.
   *
   * This used to read `type === 'mouseup' || type === 'click' ? 0 : 1`, which missed
   * `pointerup`: every release told the page a button was still held. An app that tracks
   * pointer events therefore never saw the drag end, and the next pointer movement extended
   * it. In Excel Online that is a cell drag - which is what drew a line from the clicked cell
   * to the pointer and looked like the extension scribbling on the document. It was Excel
   * being dragged, not anything of ours being drawn.
   *
   * `pressure` follows the same rule: a real mouse reports 0.5 while a button is down and 0
   * otherwise, and an ink surface reads pressure 0 as "not drawing".
   */
  function fire(el, type, point, extra) {
    const down = type === 'pointerdown' || type === 'mousedown';
    const init = Object.assign({
      bubbles: true,
      cancelable: true,
      composed: true,
      view: window,
      clientX: point.clientX,
      clientY: point.clientY,
      button: 0,
      buttons: down ? 1 : 0,
    }, extra);
    const Ctor = type.startsWith('pointer') ? PointerEvent : MouseEvent;
    if (Ctor === PointerEvent) {
      init.pointerType = init.pointerType || 'mouse';
      init.pressure = init.pressure == null ? (down ? 0.5 : 0) : init.pressure;
    }
    el.dispatchEvent(new Ctor(type, init));
  }

  /* Keys, pressed properly.
   *
   * Two things were missing and both made a shortcut a silent no-op. There were no modifiers, so
   * Control+Shift+C could not be expressed at all. And `keyCode` was absent: it is deprecated and
   * read-only, and the KeyboardEvent constructor ignores it in the init dictionary, but plenty of
   * long-lived applications - Gmail among them - still branch on it. So it is defined onto the
   * event afterwards.
   *
   * The cost of getting this wrong was not a visible error. press_key reported success every time
   * while doing nothing, and the agent went on to spend twenty steps clicking around for a control
   * that one shortcut would have opened.
   */
  const KEY_CODES = {
    Enter: 13, Escape: 27, Tab: 9, Backspace: 8, Delete: 46, ' ': 32,
    ArrowLeft: 37, ArrowUp: 38, ArrowRight: 39, ArrowDown: 40,
    Home: 36, End: 35, PageUp: 33, PageDown: 34,
  };

  function keyCodeFor(key) {
    if (KEY_CODES[key] != null) return KEY_CODES[key];
    if (key.length === 1) return key.toUpperCase().charCodeAt(0);
    return 0;
  }

  function pressKey(target, spec) {
    const key = String(spec.key || '');
    if (!key) return;
    const legacy = keyCodeFor(key);
    const init = {
      key,
      code: key.length === 1 ? 'Key' + key.toUpperCase() : key,
      bubbles: true,
      cancelable: true,
      composed: true,
      ctrlKey: !!spec.ctrl,
      shiftKey: !!spec.shift,
      altKey: !!spec.alt,
      metaKey: !!spec.meta,
    };
    // keypress is not raised for modified or non-printing keys, and faking it confuses editors.
    const types = spec.ctrl || spec.alt || spec.meta || key.length > 1
      ? ['keydown', 'keyup']
      : ['keydown', 'keypress', 'keyup'];

    for (const type of types) {
      const ev = new KeyboardEvent(type, init);
      try {
        Object.defineProperty(ev, 'keyCode', { get: () => legacy });
        Object.defineProperty(ev, 'which', { get: () => legacy });
      } catch (_) {
        // Frozen in some environments; key and code still carry.
      }
      target.dispatchEvent(ev);
    }
  }

  // React and Vue track the value through the prototype setter, so assigning
  // el.value directly leaves their state stale and the change is discarded.
  function setValue(el, value) {
    const proto = el instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype
      : el instanceof HTMLSelectElement ? HTMLSelectElement.prototype
      : HTMLInputElement.prototype;
    const setter = Object.getOwnPropertyDescriptor(proto, 'value');
    if (setter && setter.set) setter.set.call(el, value);
    else el.value = value;
    el.dispatchEvent(new Event('input', { bubbles: true }));
    el.dispatchEvent(new Event('change', { bubbles: true }));
  }

  /* Rich-text hosts (Gmail, Notion) keep their own model of the document and ignore a
   * textContent assignment. execCommand is deprecated but remains the only widely
   * supported way to make an editor process text as if it were typed - it raises the
   * beforeinput/input pair the editor is listening for. Falls back to a manual range
   * edit where execCommand is unavailable. */
  function setEditableText(el, text) {
    const range = document.createRange();
    range.selectNodeContents(el);
    const sel = getSelection();
    sel.removeAllRanges();
    sel.addRange(range);

    let inserted = false;
    try {
      inserted = document.execCommand('insertText', false, text);
    } catch (_) {
      inserted = false;
    }
    if (!inserted) {
      el.textContent = text;
      el.dispatchEvent(new InputEvent('input', { bubbles: true, data: text, inputType: 'insertText' }));
    }
    sel.removeAllRanges();
  }

  /* --------------------------------------------- one cursor, one coordinate space */

  /* Where this frame sits inside the top frame.
   *
   * The drawn cursor lives in the top frame only (see below), so every coordinate has to
   * be expressed in that frame's viewport. A frame cannot read its own position when it is
   * cross-origin - but its PARENT can: the iframe element is in the parent's DOM, and the
   * parent can tell which of its iframes sent a message by comparing event.source. Each
   * frame therefore asks its parent, and the parent answers with its own offset already
   * added, so the value composes all the way up through nested frames.
   *
   * Messages here are page-visible, so a hostile page could answer with a wrong offset or
   * ask us to draw a cursor. Both are cosmetic: nothing in this channel grants a capability
   * or carries page content.
   */

  let frameOffset = { x: 0, y: 0, known: IS_TOP };
  let offsetTimer = null;

  function askOffset() {
    if (IS_TOP) return;
    try { parent.postMessage({ __mf: 'offset?' }, '*'); } catch (_) {}
  }

  // A parent scrolling or resizing moves this frame without anything happening inside it,
  // so the answer is refreshed on a timer for as long as it is needed.
  function trackOffset(on) {
    if (IS_TOP) return;
    if (on && !offsetTimer) {
      askOffset();
      offsetTimer = setInterval(askOffset, 1000);
    } else if (!on && offsetTimer) {
      clearInterval(offsetTimer);
      offsetTimer = null;
    }
  }

  function toTop(x, y) {
    return { x: x + frameOffset.x, y: y + frameOffset.y };
  }

  function offsetReplyFor(source) {
    for (const f of document.querySelectorAll('iframe, frame')) {
      let win = null;
      try { win = f.contentWindow; } catch (_) { continue; }
      if (win !== source) continue;
      const r = f.getBoundingClientRect();
      // The document starts inside the border and padding, not at the element's edge.
      let bx = 0;
      let by = 0;
      try {
        const cs = getComputedStyle(f);
        bx = (parseFloat(cs.borderLeftWidth) + parseFloat(cs.paddingLeft)) || 0;
        by = (parseFloat(cs.borderTopWidth) + parseFloat(cs.paddingTop)) || 0;
      } catch (_) {
        // Unstyleable frame; the rect alone is close enough.
      }
      return {
        __mf: 'offset',
        x: r.left + bx + frameOffset.x,
        y: r.top + by + frameOffset.y,
        known: frameOffset.known,
      };
    }
    return null;
  }

  addEventListener('message', (ev) => {
    const data = ev.data;
    if (!data || typeof data !== 'object' || typeof data.__mf !== 'string') return;

    if (data.__mf === 'offset?') {
      const reply = offsetReplyFor(ev.source);
      if (reply) {
        try { ev.source.postMessage(reply, '*'); } catch (_) {}
      }
      return;
    }

    if (data.__mf === 'offset' && ev.source === parent) {
      frameOffset = { x: data.x || 0, y: data.y || 0, known: !!data.known };
      return;
    }

    // Only the top frame draws. Anything else arriving here is not ours to act on.
    // The options travel with the message: the top frame may not have run a step itself,
    // so it cannot be assumed to have been told what to draw.
    if (data.__mf === 'cursor' && IS_TOP) {
      applyOptions(data.opts);
      paint(data.op, data.x, data.y);
    }
  });

  /* ------------------------------------------------- visible cursor during replay */

  /* A drawn cursor, because the real one cannot be moved from a page.
   *
   * Synthetic events arrive instantly and invisibly: the OS pointer never moves, so a
   * replay that is working perfectly looks identical to one doing nothing. This draws a
   * pointer that travels along the recorded path and pulses where it clicks.
   *
   * Three things make it read like the desktop agent rather than a slideshow:
   *  - it moves every animation frame, driven by requestAnimationFrame, instead of hopping
   *    from click to click on a CSS transition;
   *  - there is exactly ONE per tab, in the top frame, addressed in top-frame coordinates.
   *    A per-frame cursor stranded a copy in every iframe a flow passed through, and each
   *    new one animated in from off-screen because it was born at (-200,-200) with the
   *    transition already attached;
   *  - it can drag a short trail, so the line it travelled is visible and not just where it
   *    happens to be standing. Off by default: on a page of its own content - a spreadsheet
   *    grid especially - a line drawn across it reads as part of the document.
   *
   * Both the pointer and the trail are user settings, carried in with each step. Turning the
   * pointer off suppresses only the DRAWING: the run is paced and the hover events raised
   * exactly as before, so a flow behaves identically whether or not it is being watched.
   *
   * Styles are set through CSSOM rather than markup so a strict style-src CSP cannot blank
   * it, and everything is pointer-events:none so it never intercepts the clicks it is
   * illustrating - which also keeps it out of elementFromPoint while aiming hover.
   */

  const SVG_NS = 'http://www.w3.org/2000/svg';
  const TRAIL_MAX = 40;
  let cursor = null;
  let cursorPos = { x: -200, y: -200 };
  let trailTimer = null;

  let showPointer = true;
  let showTrail = false;

  function applyOptions(opts) {
    if (!opts) return;
    if (typeof opts.pointer === 'boolean') showPointer = opts.pointer;
    if (typeof opts.trail === 'boolean') showTrail = opts.trail;
  }

  function ensureCursor() {
    if (cursor && cursor.root.isConnected) return cursor;

    // Built only when wanted - an empty SVG stretched over the viewport is still a node in
    // every page we touch, and there is no reason to add one nobody asked for.
    let trail = null;
    let line = null;
    if (showTrail) {
      trail = document.createElementNS(SVG_NS, 'svg');
      // Tagged so a later build can sweep it away; see the versioned guard at the top.
      trail.setAttribute('data-mouseflow', 'trail');
      Object.assign(trail.style, {
        position: 'fixed', left: '0px', top: '0px', width: '100%', height: '100%',
        zIndex: '2147483646', pointerEvents: 'none', overflow: 'visible', opacity: '1',
        transition: 'opacity 420ms linear',
      });
      line = document.createElementNS(SVG_NS, 'polyline');
      line.setAttribute('fill', 'none');
      line.setAttribute('stroke', '#4c8dff');
      line.setAttribute('stroke-width', '2');
      line.setAttribute('stroke-linecap', 'round');
      line.setAttribute('stroke-linejoin', 'round');
      line.setAttribute('opacity', '.45');
      trail.appendChild(line);
    }

    const root = document.createElement('div');
    root.setAttribute('data-mouseflow', 'cursor');
    Object.assign(root.style, {
      position: 'fixed', left: '0px', top: '0px',
      zIndex: '2147483647', pointerEvents: 'none',
      // No transition on transform: the position is animated frame by frame. A transition
      // here is what made a freshly created cursor slide in from the corner of the page.
      transform: 'translate(' + cursorPos.x + 'px, ' + cursorPos.y + 'px)',
      willChange: 'transform',
    });

    const ripple = document.createElement('div');
    Object.assign(ripple.style, {
      position: 'absolute', left: '-14px', top: '-14px',
      width: '28px', height: '28px', borderRadius: '50%',
      border: '2px solid #4c8dff', background: 'rgba(76,141,255,.18)',
      opacity: '0', transform: 'scale(.3)',
    });

    const arrow = document.createElementNS(SVG_NS, 'svg');
    arrow.setAttribute('width', '24');
    arrow.setAttribute('height', '24');
    arrow.setAttribute('viewBox', '0 0 24 24');
    arrow.style.filter = 'drop-shadow(0 1px 3px rgba(0,0,0,.55))';
    const path = document.createElementNS(SVG_NS, 'path');
    path.setAttribute('d', 'M5 2.5l14.5 8.2-6.4 1.7L10.6 19z');
    path.setAttribute('fill', '#ffffff');
    path.setAttribute('stroke', '#16181d');
    path.setAttribute('stroke-width', '1.4');
    path.setAttribute('stroke-linejoin', 'round');
    arrow.appendChild(path);

    root.append(ripple, arrow);
    const host = document.body || document.documentElement;
    if (trail) host.append(trail);
    host.append(root);
    cursor = { root, ripple, trail, line, pts: [] };
    return cursor;
  }

  // Places the cursor with no trail, for picking up where a previous tab left off.
  function cursorSeed(x, y) {
    const c = ensureCursor();
    cursorPos = { x, y };
    c.pts = [];
    if (c.line) {
      c.line.setAttribute('points', '');
      c.trail.style.opacity = '1';
    }
    c.root.style.transform = 'translate(' + x.toFixed(1) + 'px, ' + y.toFixed(1) + 'px)';
  }

  function cursorSet(x, y) {
    const c = ensureCursor();
    cursorPos = { x, y };
    c.root.style.transform = 'translate(' + x.toFixed(1) + 'px, ' + y.toFixed(1) + 'px)';
    if (!c.line) return;

    c.pts.push(x.toFixed(0) + ',' + y.toFixed(0));
    if (c.pts.length > TRAIL_MAX) c.pts.shift();
    c.line.setAttribute('points', c.pts.join(' '));

    // The trail is a record of motion, so it fades once motion stops rather than hanging
    // over a page that looks idle.
    c.trail.style.opacity = '1';
    if (trailTimer) clearTimeout(trailTimer);
    trailTimer = setTimeout(() => {
      if (cursor && cursor.trail) cursor.trail.style.opacity = '0';
    }, 260);
  }

  function cursorPulse() {
    const c = ensureCursor();
    const s = c.ripple.style;
    // Restart the animation from scratch: kill the transition, reset, force a reflow.
    s.transition = 'none';
    s.transform = 'scale(.3)';
    s.opacity = '.95';
    void c.ripple.offsetWidth;
    s.transition = 'transform 360ms ease-out, opacity 360ms ease-out';
    s.transform = 'scale(2)';
    s.opacity = '0';
  }

  function cursorHide() {
    if (trailTimer) {
      clearTimeout(trailTimer);
      trailTimer = null;
    }
    if (cursor) {
      cursor.root.remove();
      if (cursor.trail) cursor.trail.remove();
      cursor = null;
    }
  }

  function paint(op, x, y) {
    if (op === 'set') cursorSet(x, y);
    else if (op === 'seed') cursorSeed(x, y);
    else if (op === 'pulse') cursorPulse();
    else if (op === 'hide') cursorHide();
  }

  /* Steps run in the frame that owns the element, but the cursor is in the top frame, so
   * a frame that is not the top one paints by proxy. In a page with no iframes - the
   * common case - this is a direct call and no message is sent at all. */
  function draw(op, x, y) {
    // `hide` always goes through: it is cleanup, and the setting may have been turned off
    // while a cursor from an earlier run is still on the page.
    if (!showPointer && op !== 'hide') return;
    if (IS_TOP) { paint(op, x, y); return; }
    try {
      top.postMessage({
        __mf: 'cursor', op, x, y,
        opts: { pointer: showPointer, trail: showTrail },
      }, '*');
    } catch (_) {}
  }

  /* ------------------------------------------------------- driving the cursor */

  const MIN_TRAVEL_MS = 140;
  const MAX_TRAVEL_MS = 620;
  const TRAVEL_PX_PER_MS = 1.8;
  const HOVER_SKIP_PX = 6;

  function nextFrame() {
    return new Promise((done) => requestAnimationFrame(done));
  }

  function easeInOut(t) {
    return t < 0.5 ? 2 * t * t : 1 - Math.pow(-2 * t + 2, 2) / 2;
  }

  let hoverAt = 0;
  let hoverEl = null;

  /* Fires the pointer events a real cursor would raise as it passes over the page, so
   * menus and toolbars that open on hover behave during replay the way they do for a
   * person - the desktop agent gets this for free by moving the actual pointer.
   *
   * CSS :hover does NOT light up: the browser drives that from the real pointer and no
   * synthetic event can reach it. So hover STYLING stays dark while JS-driven hover works.
   * That gap cannot be closed from inside a page.
   */
  function hover(x, y) {
    const now = performance.now();
    if (now - hoverAt < HOVER_MS) return;
    hoverAt = now;

    let el = null;
    try { el = document.elementFromPoint(x, y); } catch (_) { return; }
    if (!el) return;

    // buttons:0 - this is a hover, and a move reporting a held button reads as a drag.
    const point = { clientX: x, clientY: y };
    const opts = { pointerId: 1, isPrimary: true, buttons: 0 };
    if (el !== hoverEl) {
      if (hoverEl && hoverEl.isConnected) {
        fire(hoverEl, 'pointerout', point, opts);
        fire(hoverEl, 'mouseout', point, { buttons: 0 });
      }
      fire(el, 'pointerover', point, opts);
      fire(el, 'mouseover', point, { buttons: 0 });
      hoverEl = el;
    }
    fire(el, 'pointermove', point, opts);
    fire(el, 'mousemove', point, { buttons: 0 });
  }

  /* Straight-line travel, for the steps that carry no recorded motion of their own:
   * older recordings, imported .mmmacro files, and "Create the flow", which works from a
   * written goal and so has no path by definition.
   *
   * Duration scales with distance, so a nudge is quick and a cross-screen sweep is not.
   * A flat 260ms for both was the other half of why replay looked mechanical.
   */
  async function travelTo(target, from) {
    if (!from || from.x == null) {
      // Nothing to travel from - first step of a run, or a tab we have not drawn in yet.
      draw('seed', target.x, target.y);
      return target;
    }
    const dx = target.x - from.x;
    const dy = target.y - from.y;
    const dist = Math.hypot(dx, dy);
    // Already there: a recorded path normally ends on its target, and re-sliding to the
    // same spot is the stutter it would introduce before every click.
    if (dist < HOVER_SKIP_PX) {
      draw('set', target.x, target.y);
      return target;
    }

    const ms = Math.max(MIN_TRAVEL_MS, Math.min(MAX_TRAVEL_MS, dist / TRAVEL_PX_PER_MS));
    const t0 = performance.now();
    for (;;) {
      await nextFrame();
      const k = Math.min(1, (performance.now() - t0) / ms);
      const e = easeInOut(k);
      const x = from.x + dx * e;
      const y = from.y + dy * e;
      draw('set', x, y);
      hover(x - frameOffset.x, y - frameOffset.y);
      if (k >= 1) break;
    }
    return target;
  }

  /* Replays one recorded run of motion.
   *
   * Playback is driven by elapsed time against each sample's offset from the start of the
   * run, not by a chain of sleeps: sleeping per sample would accumulate every timer's
   * overshoot, so a few hundred samples would finish visibly late. Between samples the
   * position is interpolated, which is what turns a 60-per-second sample stream into
   * motion that is smooth regardless of how coarsely it was recorded.
   *
   * Samples are frame-local, as captured, and converted to top-frame space at the last
   * moment - so a frame that has moved since recording takes its cursor with it.
   */
  async function performPath(ev, from) {
    const pts = (ev.points || []).filter((p) => p && Number.isFinite(p.x) && Number.isFinite(p.y));
    if (!pts.length) return null;
    const speed = ev.speed > 0 ? ev.speed : 1;

    const at = [0];
    for (let i = 1; i < pts.length; i++) {
      at[i] = at[i - 1] + Math.max(0, (pts[i].dt || 0) / speed);
    }
    const total = at[at.length - 1];

    let end = toTop(pts[0].x, pts[0].y);

    /* Continuity: the run starts wherever the last one ended, even in another tab.
     *
     * A recorded run does not necessarily begin where the previous step left the pointer -
     * after a tab switch it begins wherever the mouse happened to be in THAT tab, which can
     * be most of the screen away. Snapping there is a genuine discontinuity, and it is the
     * one an end-to-end run showed as a 743px jump. So the gap is travelled, not skipped. */
    if (from && from.x != null) {
      draw('seed', from.x, from.y);
      await travelTo(end, from);
    }

    draw('set', end.x, end.y);

    const t0 = performance.now();
    while (pts.length > 1) {
      await nextFrame();
      const elapsed = performance.now() - t0;
      if (elapsed >= total) break;

      let i = 0;
      // Where are we in the run? Samples are ordered, so walk forward to the current one.
      while (i < pts.length - 1 && at[i + 1] <= elapsed) i++;
      const a = pts[i];
      const b = pts[Math.min(i + 1, pts.length - 1)];
      const span = at[Math.min(i + 1, at.length - 1)] - at[i];
      const k = span > 0 ? Math.min(1, (elapsed - at[i]) / span) : 1;
      const lx = a.x + (b.x - a.x) * k;
      const ly = a.y + (b.y - a.y) * k;

      end = toTop(lx, ly);
      draw('set', end.x, end.y);
      hover(lx, ly);
    }

    const stop = pts[pts.length - 1];
    end = toTop(stop.x, stop.y);
    draw('set', end.x, end.y);
    hover(stop.x, stop.y);
    return end;
  }

  /* Outlines whatever a step is about to act on.
   *
   * Without this a replay is invisible when the page reacts subtly or not at all, and
   * "it did nothing" is indistinguishable from "it clicked the wrong thing" or "it
   * clicked the right thing and the app ignored it". The flash answers that instantly.
   */
  function flash(el) {
    try {
      const outline = el.style.outline;
      const offset = el.style.outlineOffset;
      el.style.outline = '2px solid #4c8dff';
      el.style.outlineOffset = '2px';
      setTimeout(() => {
        el.style.outline = outline;
        el.style.outlineOffset = offset;
      }, 350);
    } catch (_) {
      // inline styles blocked; the step itself still runs
    }
  }

  async function perform(ev, from) {
    if (ev.action === 'scroll') {
      // A container scroll carries a selector and the element's own offsets; a window scroll does
      // not. Older recordings only ever have the window form.
      if (ev.selector) {
        const box = await resolve(ev);
        box.scrollLeft = ev.scrollLeft || 0;
        box.scrollTop = ev.scrollTop || 0;
        return null;
      }
      scrollTo({ left: ev.scrollX, top: ev.scrollY, behavior: 'instant' });
      return null;
    }

    const el = await resolve(ev);
    el.scrollIntoView({ block: 'center', inline: 'center', behavior: 'instant' });
    flash(el);

    // Send the drawn pointer to the target and let it get there before acting, so the
    // click is something the user watches happen rather than infers afterwards.
    const point = pointAt(el, ev);
    const target = await travelTo(toTop(point.clientX, point.clientY), from);
    if (ev.action === 'click' || ev.action === 'dblclick') draw('pulse');

    switch (ev.action) {
      case 'click':
      case 'dblclick': {
        /* Replay the button that was recorded. `button` was stored on every click step and then
         * never read, so a right or middle click replayed as a left click - and a page that only
         * opens its menu on button 2 did nothing at all.
         *
         * `buttons` encodes the same thing differently: a bitmask, left 1, right 2, middle 4. */
        const button = ev.button === 1 || ev.button === 2 ? ev.button : 0;
        const held = button === 2 ? 2 : button === 1 ? 4 : 1;
        const withButton = { button };
        const whileDown = { button, buttons: held };

        fire(el, 'pointerover', point, { pointerId: 1, isPrimary: true });
        fire(el, 'mouseover', point);
        fire(el, 'pointerdown', point, Object.assign({ pointerId: 1, isPrimary: true }, whileDown));
        fire(el, 'mousedown', point, whileDown);
        if (el.focus) el.focus({ preventScroll: true });
        fire(el, 'pointerup', point, Object.assign({ pointerId: 1, isPrimary: true }, withButton));
        fire(el, 'mouseup', point, withButton);
        /* A right press raises contextmenu, not click. Chrome's own menu cannot be opened from a
         * page, but an app with its own menu is listening for exactly this. */
        if (button === 2) {
          fire(el, 'contextmenu', point, withButton);
        } else {
          fire(el, 'click', point, Object.assign({ detail: 1 }, withButton));
          if (ev.action === 'dblclick') {
            fire(el, 'click', point, Object.assign({ detail: 2 }, withButton));
            fire(el, 'dblclick', point, Object.assign({ detail: 2 }, withButton));
          }
        }
        return target;
      }
      case 'fill':
        if (el.focus) el.focus({ preventScroll: true });
        if (ev.editable || el.isContentEditable) {
          setEditableText(el, ev.value);
        } else {
          setValue(el, ev.value);
        }
        return target;
      case 'redacted':
        if (el.focus) el.focus({ preventScroll: true });
        throw new Error('this step recorded a password field and was not stored - type it yourself, then resume');
      case 'key': {
        pressKey(el, ev);
        return target;
      }
      default:
        throw new Error('unknown action ' + ev.action);
    }
  }

  /* ----------------------------------------------------- agent mode (describe) */

  /* "Create the flow" needs a different page view than recording does.
   *
   * Recording knows which element the user touched. An agent working from a written
   * goal has to be told what is on the page, cheaply enough to put in a prompt: a
   * numbered list of interactive elements with their accessible names. Refs are indices
   * into a snapshot held here, so the model never sees or invents a CSS selector.
   */

  let refs = [];

  /* Which snapshot the refs belong to.
   *
   * read_page snapshots EVERY frame, so every frame ends up holding a populated `refs` array -
   * and a ref is just an index, so ref 0 exists in most of them. An action delivered to more than
   * one frame would therefore be performed more than once, by frames pointing at different
   * elements. The worker stamps each action with the id of the snapshot it actually used, and a
   * frame holding a different one stays silent: it neither acts nor answers, so it cannot win a
   * broadcast either.
   */
  let snapshotId = null;
  let snapshotSeq = 0;

  const AGENT_SELECTOR = [
    'a[href]', 'button', 'input', 'select', 'textarea',
    '[role="button"]', '[role="link"]', '[role="textbox"]', '[role="combobox"]',
    '[role="tab"]', '[role="menuitem"]', '[role="option"]', '[role="checkbox"]',
    '[contenteditable="true"]',
  ].join(',');

  function isVisible(el) {
    const rect = el.getBoundingClientRect();
    if (rect.width < 2 || rect.height < 2) return false;
    const style = getComputedStyle(el);
    return style.visibility !== 'hidden' && style.display !== 'none' && style.opacity !== '0';
  }

  // The name a person would use for this control, in the order a screen reader would try.
  function accessibleName(el) {
    const aria = el.getAttribute('aria-label');
    if (aria) return aria.trim();

    const labelledBy = el.getAttribute('aria-labelledby');
    if (labelledBy) {
      const parts = labelledBy.split(/\s+/)
        .map((id) => document.getElementById(id))
        .filter(Boolean)
        .map((n) => visibleText(n));
      if (parts.length) return parts.join(' ');
    }

    if (el.labels && el.labels.length) return visibleText(el.labels[0]);

    const text = visibleText(el);
    if (text) return text;

    const hint = (el.getAttribute('placeholder') || el.getAttribute('title') ||
                  el.getAttribute('name') || '').trim();
    if (hint) return hint;

    /* The `value` attribute names a push button ("Submit", "Search") and is the only
     * label such an element has. On every other input it is CONTENT, not a name — and
     * for a password field it is the secret itself, which excluding the `value` property
     * further down does nothing to stop leaking through here. Buttons only. */
    const type = (el.getAttribute('type') || '').toLowerCase();
    if (el.tagName === 'INPUT' && ['submit', 'button', 'reset'].includes(type)) {
      return (el.getAttribute('value') || '').trim();
    }
    return '';
  }

  // The dialog on top, if there is one. Gmail's compose window is a [role=dialog].
  function openDialog() {
    const found = [...document.querySelectorAll('[role="dialog"], dialog[open], [aria-modal="true"]')]
      .filter((d) => isVisible(d));
    // Last in DOM order is the one on top in practice.
    return found.length ? found[found.length - 1] : null;
  }

  // The element inside `root` that actually scrolls, if any.
  function scrollableWithin(root) {
    if (!root) return null;
    const scrolls = (el) => {
      if (el.scrollHeight <= el.clientHeight + 4) return false;
      try { return /(auto|scroll)/.test(getComputedStyle(el).overflowY); } catch (_) { return false; }
    };
    if (scrolls(root)) return root;
    for (const el of root.querySelectorAll('*')) if (scrolls(el)) return el;
    return null;
  }

  function onScreen(el) {
    const r = el.getBoundingClientRect();
    return r.bottom > 0 && r.right > 0 && r.top < innerHeight && r.left < innerWidth;
  }

  /* What to show, and in what order.
   *
   * The cap used to keep the first N in DOM order. On a Gmail inbox that is 120 message rows and
   * no compose form: the agent had opened a compose window, could not see its To or Subject
   * fields, and abandoned it for another approach - twice, leaving two empty compose windows
   * behind. The elements were there, just past the cap.
   *
   * A person looks at the dialog that just opened, not the page behind it. So an open dialog's
   * controls come first, then whatever is actually on screen, then the rest.
   */
  function snapshot(limit, compact) {
    refs = [];
    snapshotSeq++;
    snapshotId = (IS_TOP ? 'top' : 'frame') + ':' + snapshotSeq + ':' +
      Math.random().toString(36).slice(2, 8);

    const out = [];
    const seen = new Set();
    const dialog = openDialog();

    const candidates = [...document.querySelectorAll(AGENT_SELECTOR)].filter((el) => {
      if (seen.has(el) || !isVisible(el)) return false;
      seen.add(el);
      return true;
    });
    // Stable, so DOM order still decides within a band.
    const band = (el) => (dialog && dialog.contains(el) ? 0 : onScreen(el) ? 1 : 2);
    candidates.sort((a, b) => band(a) - band(b));
    seen.clear();

    for (const el of candidates) {
      if (out.length >= limit) break;
      seen.add(el);

      const type = (el.getAttribute('type') || '').toLowerCase();
      const entry = {
        ref: refs.length,
        tag: el.tagName.toLowerCase(),
        role: el.getAttribute('role') || type || null,
        name: accessibleName(el).slice(0, 90) || null,
      };
      if (/^(input|textarea|select)$/i.test(el.tagName) && type !== 'password') {
        entry.value = String(el.value == null ? '' : el.value).slice(0, 90);
      }
      refs.push(el);
      out.push(entry);
    }

    return {
      snapshotId,
      url: location.href,
      title: document.title,
      /* A short text sample so the model can tell "search results loaded" from "still on the
       * form" without another round trip. Omitted from the snapshot attached to every action -
       * that one is about what changed, and the sample is the expensive half. */
      text: compact ? undefined
        : (document.body ? document.body.innerText : '').replace(/\s+/g, ' ').trim().slice(0, 1500),
      elements: out,
      // Named, so the model knows a dialog is open and that its controls are the ones listed first.
      dialog: dialog ? (accessibleName(dialog) || 'dialog').slice(0, 60) : null,
      shown: out.length,
      total: candidates.length,
      truncated: candidates.length > out.length,
    };
  }

  function elementFor(ref) {
    const el = refs[ref];
    if (!el) throw new Error('ref ' + ref + ' is not in the current snapshot - read the page again');
    if (!el.isConnected) throw new Error('ref ' + ref + ' has left the page - read the page again');
    return el;
  }

  /* Wait until the page stops changing, instead of guessing how long it takes.
   *
   * The worker slept a flat 500ms after a click. Gmail can take longer than that to open a compose
   * window, so the next read_page saw the page as it was before - which is how the agent ends up
   * repeating or abandoning work it had already done. Settling on an actual quiet period fixes the
   * cause rather than moving the guess.
   */
  function settle(quietMs = 250, maxMs = 2500) {
    if (typeof MutationObserver !== 'function') return sleep(quietMs);
    return new Promise((done) => {
      let quiet = null;
      let cap = null;
      let observer = null;
      const stop = () => {
        if (observer) observer.disconnect();
        clearTimeout(quiet);
        clearTimeout(cap);
        done();
      };
      const restart = () => {
        clearTimeout(quiet);
        quiet = setTimeout(stop, quietMs);
      };
      try {
        observer = new MutationObserver(restart);
        observer.observe(document.documentElement || document.body,
          { childList: true, subtree: true, attributes: true });
      } catch (_) {
        sleep(quietMs).then(done);
        return;
      }
      cap = setTimeout(stop, maxMs);
      restart();
    });
  }

  /* What the page looks like now.
   *
   * Attached to the result of every action, because the alternative was costing a whole turn per
   * action: the prompt said to read_page after anything that changes the page, and a run doing so
   * spent twenty of its forty steps looking rather than acting - and ran out mid-task. Smaller and
   * text-free, since it answers "what changed", not "what is this page".
   */
  function afterState() {
    try {
      return snapshot(60, true);
    } catch (_) {
      return null;
    }
  }

  async function agentAct(cmd, from) {
    if (cmd.action === 'scroll') {
      const by = (cmd.amount || 600) * (cmd.direction === 'up' ? -1 : 1);
      /* Scroll the thing a person would scroll. An open dialog is its own scroll container, so
       * scrolling the window did nothing at all - a wasted step, and read_page then reported an
       * unchanged page, which reads like the page having no more content. */
      const box = scrollableWithin(openDialog());
      if (box) {
        box.scrollTop += by;
      } else {
        scrollBy({ top: by, behavior: 'instant' });
      }
      await settle(120, 800);
      return { ok: true, scrolled: box ? 'dialog' : 'page', page: afterState() };
    }

    if (cmd.action === 'press_key') {
      const target = document.activeElement || document.body;
      pressKey(target, cmd);
      /* Enter inside a form is expected to submit it, and a synthetic keydown alone will not - but
       * only for a bare Enter. Control+Enter is a shortcut the app handles itself, and submitting
       * on top of it would fire twice. */
      const bare = !cmd.ctrl && !cmd.alt && !cmd.meta && !cmd.shift;
      if (cmd.key === 'Enter' && bare && target.form &&
          typeof target.form.requestSubmit === 'function') {
        target.form.requestSubmit();
      }
      await settle(150, 1200);
      return { ok: true, page: afterState() };
    }

    const el = elementFor(cmd.ref);
    el.scrollIntoView({ block: 'center', inline: 'center', behavior: 'instant' });
    flash(el);

    // Same drawn pointer as replay, so watching the agent work looks like watching a
    // person work rather than fields changing by themselves. There is no recorded path to
    // follow here, so the cursor travels to the target under its own easing.
    const at = pointAt(el, { rx: 0.5, ry: 0.5 });
    const cursorEnd = await travelTo(toTop(at.clientX, at.clientY), from);

    /* НАВЕДЕНИЕ, И ОНО УЖЕ ПОЧТИ БЫЛО НАПИСАНО. travelTo выше ведёт указатель до цели и по дороге сам
     * поднимает pointerover/mouseover/mouseout - то есть работа сделана, а дойти до неё было нечем: у
     * модели не было такого инструмента. Управление, которое существует только под указателем -
     * «Архивировать» в строке письма, выпадающее меню в шапке, - без этого не нажать вовсе, и провал
     * тихий: в снимок такие элементы не попадают (фильтр isVisible), так что и ref, о котором спросить,
     * не появляется. Здесь только settle и снимок ПОСЛЕ: смысл наведения в том, что страница сейчас
     * изменится. */
    if (cmd.action === 'hover') {
      await settle();
      return { ok: true, cursor: cursorEnd, page: afterState() };
    }

    if (cmd.action === 'click') {
      draw('pulse');
      const point = pointAt(el, { rx: 0.5, ry: 0.5 });
      /* Какая кнопка и сколько раз. Повтор записи это умел с самого начала - у записанного клика есть
       * `button`, а `dblclick` это отдельное действие, - а модель попросить не могла ни того, ни другого:
       * инструмент нёс только ref. Правый клик без contextmenu ничего не открывает, а двойной без
       * detail:2 и dblclick большинство приложений не считают двойным. */
      const button = cmd.button === 'right' ? 2 : cmd.button === 'middle' ? 1 : 0;
      const held = button === 2 ? 2 : button === 1 ? 4 : 1;
      const press = (detail) => {
        fire(el, 'pointerdown', point, { pointerId: 1, isPrimary: true, button, buttons: held });
        fire(el, 'mousedown', point, { button, buttons: held });
        if (el.focus) el.focus({ preventScroll: true });
        fire(el, 'pointerup', point, { pointerId: 1, isPrimary: true, button, buttons: 0 });
        fire(el, 'mouseup', point, { button, buttons: 0 });
        if (button === 0) fire(el, 'click', point, { detail, button, buttons: 0 });
      };
      press(1);
      if (cmd.double) {
        press(2);
        fire(el, 'dblclick', point, { detail: 2, button, buttons: 0 });
      }
      if (button === 2) fire(el, 'contextmenu', point, { button: 2, buttons: 0 });
      // Let whatever the click started finish before we describe the page again.
      await settle();
      return { ok: true, cursor: cursorEnd, page: afterState() };
    }

    if (cmd.action === 'type') {
      if (el.focus) el.focus({ preventScroll: true });
      if (el.isContentEditable) setEditableText(el, cmd.text);
      else setValue(el, cmd.text);
      if (cmd.submit) {
        pressKey(el, { key: 'Enter' });
        if (el.form && typeof el.form.requestSubmit === 'function') el.form.requestSubmit();
        await settle(150, 1200);
      } else {
        await settle(120, 800);
      }
      return { ok: true, cursor: cursorEnd, page: afterState() };
    }

    throw new Error('unknown agent action ' + cmd.action);
  }

  /* --------------------------------------------------------------- messages */

  chrome.runtime.onMessage.addListener((msg, sender, respond) => {
    // A superseded generation stands down rather than racing the current one to answer.
    if (!generation.live) return;
    if (!msg || typeof msg.mf !== 'string') return;

    if (msg.mf === 'ping') { respond({ ok: true, url: location.href, capturing }); return; }
    if (msg.mf === 'capture/start') { startCapture(); respond({ ok: true }); return; }
    if (msg.mf === 'capture/stop') { stopCapture(); respond({ ok: true }); return; }

    /* Every step reports where it left the cursor, and is told where the last one left it.
     * The worker holds that between steps, because the cursor is per-tab and per-frame
     * while the position has to be continuous across both - the alternative was each new
     * frame starting from nowhere, which is what made the cursor appear out of thin air. */
    if (msg.mf === 'replay/event') {
      trackOffset(true);
      applyOptions(msg.opts);
      perform(msg.event, msg.from).then(
        (cursor) => respond({ ok: true, cursor: cursor || null }),
        (err) => respond({ ok: false, error: err.message })
      );
      return true;   // async responder
    }

    if (msg.mf === 'replay/path') {
      trackOffset(true);
      applyOptions(msg.opts);
      performPath(msg.event, msg.from).then(
        (cursor) => respond({ ok: true, cursor: cursor || null }),
        (err) => respond({ ok: false, error: err.message })
      );
      return true;
    }

    if (msg.mf === 'cursor/hide') {
      cursorHide();
      trackOffset(false);
      respond({ ok: true });
      return;
    }

    /* Self-test: prove this page can be driven, independently of any recording.
     * Walks the drawn cursor around a square and pulses at each corner. If the user
     * sees this, injection and drawing both work and any failure is replay-specific;
     * if they see nothing, the problem is upstream of replay entirely. */
    if (msg.mf === 'cursor/demo') {
      (async () => {
        trackOffset(true);
        // The point of the self-test is to answer "can this page be drawn in at all", so it
        // draws regardless of the setting - otherwise turning the pointer off would make the
        // diagnostic report nothing and look like the failure it exists to rule out.
        showPointer = true;
        const w = innerWidth, h = innerHeight;
        const corners = [[w * 0.3, h * 0.3], [w * 0.7, h * 0.3], [w * 0.7, h * 0.6], [w * 0.3, h * 0.6]];
        // Walks the square with the same animator replay uses, so seeing this pass means
        // the smooth path works here and not merely that something can be drawn.
        let from = toTop(corners[3][0], corners[3][1]);
        draw('seed', from.x, from.y);
        for (const [x, y] of corners) {
          from = await travelTo(toTop(x, y), from);
          draw('pulse');
          await sleep(140);
        }
        await sleep(400);
        draw('hide');
      })().catch(() => {});
      // Answer immediately - the caller should not wait out the animation.
      respond({ ok: true, url: location.href, viewport: innerWidth + 'x' + innerHeight });
      return;
    }

    /* A fingerprint of the page, for waiting on.
     *
     * Not a snapshot: a snapshot is for a model to read and costs a step to fetch. This is a handful of
     * numbers the worker can poll as often as it likes, to answer one question - has anything changed?
     * Text length and element count move when a page is loading, rendering, or streaming an answer, and
     * sit still when it has finished.
     */
    if (msg.mf === 'agent/pulse') {
      const text = document.body ? document.body.innerText || '' : '';
      respond({
        ok: true,
        state: document.readyState,
        // Sampled rather than hashed whole: on a long document the hash would cost more than it saves.
        chars: text.length,
        head: text.slice(0, 200),
        tail: text.slice(-200),
        elements: document.querySelectorAll('a,button,input,select,textarea,[role],[contenteditable]').length,
        /* A spinner is often the only thing moving on a page that is working, and it is usually one of
         * these. Counting them separately means "still busy" survives text that happens not to change. */
        busy: document.querySelectorAll(
          '[aria-busy="true"],progress,[role="progressbar"],.spinner,.loading,[class*="spinner"],[class*="loading"]'
        ).length,
      });
      return;
    }

    if (msg.mf === 'agent/snapshot') {
      try { respond({ ok: true, page: snapshot(msg.limit || 120) }); }
      catch (err) { respond({ ok: false, error: err.message }); }
      return;
    }

    if (msg.mf === 'agent/act') {
      // Not our snapshot, not our action. Silence rather than an error: a broadcast resolves with
      // whichever frame answers first, so answering at all would be enough to do damage.
      if (msg.snapshotId && msg.snapshotId !== snapshotId) return;
      trackOffset(true);
      applyOptions(msg.opts);
      agentAct(msg.command, msg.from).then(
        (res) => respond(res),
        (err) => respond({ ok: false, error: err.message })
      );
      return true;
    }
  });

  // Recording survives in-page navigation only if the worker re-injects us; tell it so.
  chrome.runtime.sendMessage({ mf: 'content/ready', url: location.href }).catch(() => {});
})();
