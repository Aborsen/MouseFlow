/* MouseFlow content script - capture and replay inside a page.
 *
 * This is the web counterpart to the desktop agent. The crucial difference is what a step
 * points at: the desktop agent records absolute screen pixels, which break the moment a
 * window moves. Here we record the ELEMENT, plus where inside it the click landed. That
 * survives window resizes, layout shifts, scrolling and different screen resolutions.
 *
 * Injected on demand by the background worker, never declared in the manifest, so nothing
 * runs in a page until the user actually starts recording or replaying.
 */

(() => {
  'use strict';

  // Injected repeatedly across recordings; only wire up once.
  if (window.__mouseflowContent) return;
  window.__mouseflowContent = true;

  const MOVE_MIN_MS = 120;      // scroll events fire in floods; thin them
  const WAIT_TIMEOUT_MS = 8000; // how long replay waits for a missing element

  let capturing = false;
  let events = [];
  let startedAt = 0;
  let lastStamp = 0;
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

  function push(partial) {
    const now = performance.now();
    events.push(Object.assign({
      delay: events.length === 0 ? 0 : Math.round(now - lastStamp),
    }, partial));
    lastStamp = now;
  }

  function onPointerDown(ev) {
    if (!capturing || !ev.isTrusted) return;
    const el = ev.target;
    if (!el || el.nodeType !== 1) return;
    push(Object.assign({
      action: ev.detail > 1 ? 'dblclick' : 'click',
      button: ev.button,
    }, describe(el, ev.clientX, ev.clientY)));
  }

  function onChange(ev) {
    if (!capturing || !ev.isTrusted) return;
    const el = ev.target;
    if (!el || !/^(input|textarea|select)$/i.test(el.tagName)) return;
    const type = (el.getAttribute('type') || '').toLowerCase();
    if (type === 'password') {
      // Never store a typed password. Record the focus so the flow still stops here.
      push(Object.assign({ action: 'redacted' }, describe(el, 0, 0)));
      return;
    }
    if (type === 'checkbox' || type === 'radio') return;   // the click already covers it
    push(Object.assign({ action: 'fill', value: el.value }, describe(el, 0, 0)));
  }

  function onKeyDown(ev) {
    if (!capturing || !ev.isTrusted) return;
    if (!['Enter', 'Tab', 'Escape', 'ArrowDown', 'ArrowUp'].includes(ev.key)) return;
    const el = ev.target && ev.target.nodeType === 1 ? ev.target : document.body;
    push(Object.assign({ action: 'key', key: ev.key }, describe(el, 0, 0)));
  }

  function onScroll() {
    if (!capturing) return;
    const now = performance.now();
    if (now - lastScrollAt < MOVE_MIN_MS) return;
    lastScrollAt = now;
    push({ action: 'scroll', scrollX: Math.round(scrollX), scrollY: Math.round(scrollY) });
  }

  function startCapture() {
    events = [];
    startedAt = performance.now();
    lastStamp = startedAt;
    capturing = true;
    addEventListener('pointerdown', onPointerDown, true);
    addEventListener('change', onChange, true);
    addEventListener('keydown', onKeyDown, true);
    addEventListener('scroll', onScroll, true);
  }

  function stopCapture() {
    capturing = false;
    removeEventListener('pointerdown', onPointerDown, true);
    removeEventListener('change', onChange, true);
    removeEventListener('keydown', onKeyDown, true);
    removeEventListener('scroll', onScroll, true);
    return { events, durationMs: Math.round(performance.now() - startedAt) };
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

  function fire(el, type, point, extra) {
    const init = Object.assign({
      bubbles: true,
      cancelable: true,
      composed: true,
      view: window,
      clientX: point.clientX,
      clientY: point.clientY,
      button: 0,
      buttons: type === 'mouseup' || type === 'click' ? 0 : 1,
    }, extra);
    const Ctor = type.startsWith('pointer') ? PointerEvent : MouseEvent;
    el.dispatchEvent(new Ctor(type, init));
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

  async function perform(ev) {
    if (ev.action === 'scroll') {
      scrollTo({ left: ev.scrollX, top: ev.scrollY, behavior: 'instant' });
      return;
    }

    const el = await resolve(ev);
    el.scrollIntoView({ block: 'center', inline: 'center', behavior: 'instant' });
    await sleep(30);
    const point = pointAt(el, ev);

    switch (ev.action) {
      case 'click':
      case 'dblclick': {
        fire(el, 'pointerover', point, { pointerId: 1, isPrimary: true });
        fire(el, 'mouseover', point);
        fire(el, 'pointerdown', point, { pointerId: 1, isPrimary: true });
        fire(el, 'mousedown', point);
        if (el.focus) el.focus({ preventScroll: true });
        fire(el, 'pointerup', point, { pointerId: 1, isPrimary: true });
        fire(el, 'mouseup', point);
        fire(el, 'click', point, { detail: 1 });
        if (ev.action === 'dblclick') {
          fire(el, 'click', point, { detail: 2 });
          fire(el, 'dblclick', point, { detail: 2 });
        }
        return;
      }
      case 'fill':
        if (el.focus) el.focus({ preventScroll: true });
        setValue(el, ev.value);
        return;
      case 'redacted':
        if (el.focus) el.focus({ preventScroll: true });
        throw new Error('this step recorded a password field and was not stored - type it yourself, then resume');
      case 'key': {
        const init = { key: ev.key, code: ev.key, bubbles: true, cancelable: true, composed: true };
        el.dispatchEvent(new KeyboardEvent('keydown', init));
        el.dispatchEvent(new KeyboardEvent('keyup', init));
        return;
      }
      default:
        throw new Error('unknown action ' + ev.action);
    }
  }

  /* --------------------------------------------------------------- messages */

  chrome.runtime.onMessage.addListener((msg, sender, respond) => {
    if (!msg || typeof msg.mf !== 'string') return;

    if (msg.mf === 'ping') { respond({ ok: true, url: location.href }); return; }
    if (msg.mf === 'capture/start') { startCapture(); respond({ ok: true }); return; }
    if (msg.mf === 'capture/count') { respond({ ok: true, count: events.length }); return; }
    if (msg.mf === 'capture/stop') { respond(Object.assign({ ok: true }, stopCapture())); return; }

    if (msg.mf === 'replay/event') {
      perform(msg.event).then(
        () => respond({ ok: true }),
        (err) => respond({ ok: false, error: err.message })
      );
      return true;   // async responder
    }
  });

  // Recording survives in-page navigation only if the worker re-injects us; tell it so.
  chrome.runtime.sendMessage({ mf: 'content/ready', url: location.href }).catch(() => {});
})();
