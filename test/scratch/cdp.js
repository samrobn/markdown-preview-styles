// Raw-CDP driver for a scratch-profile VS Code instance (see the CLAUDE.md
// "scratch-profile instance CAN expose CDP" gotcha for launch/shutdown/
// sideload hygiene). Plain Node, no deps - global WebSocket + fetch.
//
//   const { connect } = require('./cdp.js');
//   const cdp = await connect(9377);
//   await cdp.page.paletteRun('Reopen Editor With...');    // F1-based; verifies the palette opened
//   await cdp.page.clickQuickRow('Reopen Editor With...');
//   await cdp.page.clickQuickRow('Markdown Preview');
//   const frame = await cdp.refreshFrame();                // attach to the (new) preview webview
//   await frame.innerEval('window.scrollBy(0, 500)');      // scroll the preview content
//   await cdp.page.screenshot('/abs/path/state.png');
//   cdp.close();
//
// Driving gotchas baked in (documented in CLAUDE.md): palette opens via F1
// (Cmd+Shift+P doesn't register over CDP); Input.insertText corrupts the
// document if the palette failed to open, so paletteRun checks the widget
// first; quickpick rows are clicked by DOM rect (ArrowDown counts are
// non-deterministic); don't send mouse-wheel at webview coordinates - the
// call hangs on both page and iframe targets, use frame.innerEval.

const fs = require('fs');

function session(wsUrl) {
  const pending = new Map();
  let messageId = 0;
  const ws = new WebSocket(wsUrl);
  const ready = new Promise((resolve, reject) => {
    ws.onopen = () => resolve();
    ws.onerror = () => reject(new Error('CDP websocket failed: ' + wsUrl));
    ws.onclose = () => reject(new Error('CDP websocket closed before open: ' + wsUrl));
  });
  ws.onmessage = (event) => {
    const message = JSON.parse(event.data);
    if (message.id && pending.has(message.id)) {
      pending.get(message.id)(message.result || message);
      pending.delete(message.id);
    }
  };
  const send = (method, params = {}) => new Promise((resolve) => {
    const id = ++messageId;
    pending.set(id, resolve);
    ws.send(JSON.stringify({ id, method, params }));
  });
  const evaluate = async (expression) => {
    const result = await send('Runtime.evaluate', { expression, returnByValue: true });
    if (result.exceptionDetails) {
      throw new Error('evaluate failed: ' + JSON.stringify(result.exceptionDetails).slice(0, 300));
    }
    return result.result ? result.result.value : result;
  };
  return { ready, send, evaluate, close: () => ws.close() };
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function pageHelpers(page) {
  const key = async (name, code, virtualKey, modifiers = 0) => {
    await page.send('Input.dispatchKeyEvent', { type: 'keyDown', modifiers, key: name, code, windowsVirtualKeyCode: virtualKey });
    await page.send('Input.dispatchKeyEvent', { type: 'keyUp', modifiers, key: name, code, windowsVirtualKeyCode: virtualKey });
  };
  const click = async (x, y) => {
    await page.send('Input.dispatchMouseEvent', { type: 'mousePressed', x, y, button: 'left', clickCount: 1 });
    await page.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x, y, button: 'left', clickCount: 1 });
  };
  return {
    ...page,
    key,
    click,
    typeText: (text) => page.send('Input.insertText', { text }),
    screenshot: async (path) => {
      const result = await page.send('Page.captureScreenshot', { format: 'png' });
      fs.writeFileSync(path, Buffer.from(result.data, 'base64'));
    },
    // F1 -> verify the quick-input widget actually opened -> type the filter.
    // Follow with clickQuickRow (or key('Enter', ...) if the filter is exact).
    paletteRun: async (filterText) => {
      await key('F1', 'F1', 112);
      await sleep(700);
      const widgetState = await page.evaluate(
        `(() => { const widget = document.querySelector('.quick-input-widget'); return widget ? getComputedStyle(widget).display : 'absent'; })()`);
      if (widgetState === 'absent' || widgetState === 'none') {
        throw new Error('command palette did not open - aborting before insertText corrupts the document');
      }
      await page.send('Input.insertText', { text: filterText });
      await sleep(700);
    },
    clickQuickRow: async (labelSubstring) => {
      const rows = await page.evaluate(
        `[...document.querySelectorAll('.quick-input-widget .monaco-list-row')].map(row => { const rect = row.getBoundingClientRect(); return { label: row.getAttribute('aria-label'), x: Math.round(rect.left + rect.width / 2), y: Math.round(rect.top + rect.height / 2) }; })`);
      const row = rows.find((candidate) => candidate.label && candidate.label.includes(labelSubstring));
      if (!row) throw new Error(`no quickpick row matching "${labelSubstring}" in: ${rows.map((candidate) => candidate.label).join(' | ')}`);
      await click(row.x, row.y);
      await sleep(1000);
    },
  };
}

function frameHelpers(frame) {
  return {
    ...frame,
    // Evaluate inside the preview's content document. The iframe target is
    // the outer webview host (empty document); the rendered markdown lives in
    // the same-origin inner iframe.
    innerEval: (expression) => frame.evaluate(
      `(() => { const inner = document.getElementById('active-frame') || document.querySelector('iframe');
        return (function (window, document) { return (${expression}); })(inner.contentWindow, inner.contentDocument); })()`),
  };
}

async function connect(port) {
  const listTargets = () => fetch(`http://127.0.0.1:${port}/json/list`).then((response) => response.json());
  const targets = await listTargets();
  const pageTarget = targets.find((target) => target.type === 'page');
  if (!pageTarget) throw new Error(`no page target on port ${port} - is the scratch instance running with --remote-debugging-port?`);
  const page = pageHelpers(session(pageTarget.webSocketDebuggerUrl));
  await page.ready;

  let frame = null;
  const cdp = {
    targets,
    page,
    frame: null,
    sleep,
    // Webview targets appear when a preview opens and change identity on
    // rebuild - re-resolve after opening or reopening a preview.
    refreshFrame: async () => {
      if (frame) frame.close();
      const frameTarget = (await listTargets()).find(
        (target) => target.type === 'iframe' && target.url.startsWith('vscode-webview://'));
      if (!frameTarget) throw new Error('no vscode-webview iframe target - is a preview open?');
      frame = frameHelpers(session(frameTarget.webSocketDebuggerUrl));
      await frame.ready;
      cdp.frame = frame;
      return frame;
    },
    close: () => { page.close(); if (frame) frame.close(); },
  };
  try { await cdp.refreshFrame(); } catch { /* no preview open yet - call refreshFrame() after opening one */ }
  return cdp;
}

module.exports = { connect, sleep };
