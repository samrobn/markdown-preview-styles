// Runs in the markdown preview webview (contributed via
// `markdown.previewScripts`). Computes per-element line-number gutter
// offsets so the line-number `::before` lands at the same x-coordinate
// regardless of list nesting depth.
//
// Why JS rather than pure CSS: VS Code sets `position: relative` on every
// `.code-line`, so each nested <li> is its own containing block. The
// effective `padding-inline-start` of the preview's `ul`/`ol` varies by
// build, theme, and user font size, so a static per-depth `em` offset
// can't match it precisely. Reading the actual offsetLeft at render time
// is the only way to get pixel-aligned numbers.
//
// Communicates with CSS via a single custom property per element:
//   --mps-before-left: <px>
// style.css consumes it in `body .code-line::before { left: var(--mps-before-left, -5em); }`.

(function () {
  // Target gutter column for the line number (px from body's content edge,
  // measured as a negative number because `::before`'s `left` is relative
  // to the .code-line's left edge and the gutter is to the left of that).
  // -64px ≈ -5em on a 12.8px ::before font; matches the historical default
  // for top-level paragraphs.
  const GUTTER_TARGET = -64;

  function align() {
    const body = document.body;
    if (!body) return;
    const bodyLeft = body.getBoundingClientRect().left;
    const bodyContentLeft = bodyLeft + parseFloat(getComputedStyle(body).paddingLeft || '0');
    const lines = document.querySelectorAll('.code-line');
    for (const el of lines) {
      // Skip elements INSIDE a table (rows/cells) - line numbers there are
      // suppressed by CSS. The <table> element itself still needs its
      // offset computed; otherwise it falls back to `-5em`, which differs
      // from `GUTTER_TARGET` whenever the root font-size isn't 16px (e.g.
      // VS Code's preview root is 14px → static fallback lands 8px to the
      // right of every other gutter number).
      if (el.tagName !== 'TABLE' && el.closest('table')) continue;
      const x = el.getBoundingClientRect().left;
      // We want ::before's left edge at (bodyContentLeft + GUTTER_TARGET).
      // ::before is absolute-positioned in el's coord space, so:
      //   ::before.left = target - el.left
      const beforeLeft = (bodyContentLeft + GUTTER_TARGET) - x;
      const value = `${beforeLeft}px`;
      // Idempotent write: skip if unchanged. Without this, every align()
      // rewrites the style attribute on every .code-line, which the
      // attribute-watching MutationObserver below would treat as a change
      // and schedule another align() - frame-by-frame feedback loop.
      if (el.style.getPropertyValue('--mps-before-left') !== value) {
        el.style.setProperty('--mps-before-left', value);
      }
    }
  }

  // Bridge for the editor-selection indicator on blank source lines.
  //
  // VS Code's preview script tracks the editor's caret line and toggles
  // `.code-active-line` on the corresponding `.code-line` element. For
  // reasons unclear from outside, it skips our `.mps-blank-line` placeholder
  // divs - they have `data-line` and `code-line` but never receive the
  // active class. The catch-all `::before` line-number rule plus our
  // `.code-active-line::before` highlight therefore can't brighten the
  // gutter number when the caret is on a truly blank source row.
  //
  // Listen for the same `onDidChangeTextEditorSelection` message VS Code's
  // script consumes, exact-match the source line against `.mps-blank-line`
  // placeholders, and apply `.mps-active-blank-line` ourselves. CSS targets
  // that class with the same brightened gutter treatment.
  //
  // Setting-gate: only acts when `showEditorSelection` is on body, which
  // VS Code sets iff `markdown.preview.markEditorSelection: true`. The CSS
  // rule is scoped the same way so the user toggling the setting off makes
  // both paths inert without a reload.
  window.addEventListener('message', (e) => {
    if (e.data?.type !== 'onDidChangeTextEditorSelection') return;
    if (!document.body.classList.contains('showEditorSelection')) return;
    const lineN = Math.floor(e.data.line);
    if (isNaN(lineN)) return;
    // Defer one frame so we run after VS Code's handler - otherwise it can
    // overwrite our class clearance for blank-line cases.
    requestAnimationFrame(() => {
      document.querySelectorAll('.mps-active-blank-line').forEach(el =>
        el.classList.remove('mps-active-blank-line')
      );
      const placeholder = document.querySelector(
        `.mps-blank-line[data-line="${lineN}"]`
      );
      if (placeholder) {
        placeholder.classList.add('mps-active-blank-line');
        // Caret is on a blank line: clear VS Code's stale `.code-active-line`
        // from whichever previous-content element it landed on, so we don't
        // have two brightened gutter numbers at once.
        document.querySelectorAll('.code-active-line').forEach(el =>
          el.classList.remove('code-active-line')
        );
      }
    });
  });

  // Run on initial load and any time the preview re-flows.
  let scheduled = false;
  function schedule() {
    if (scheduled) return;
    scheduled = true;
    requestAnimationFrame(() => { scheduled = false; align(); });
  }
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', schedule);
  } else {
    schedule();
  }
  window.addEventListener('resize', schedule);
  // Mutation observer catches preview re-renders.
  //
  // VS Code's "Open Preview to the Side" applies edits via an in-place DOM
  // diff (not a full innerHTML replace). When only attributes or text node
  // contents change, a `childList` observer doesn't fire - so we'd miss the
  // update and our per-element --mps-before-left values would become stale
  // (or get wiped by the diff and fall back to the static -5em, which is
  // mis-sized at the preview's 14px root). Watch attributes + characterData
  // too. The idempotent write in align() keeps this from looping.
  new MutationObserver(schedule).observe(document.body || document.documentElement, {
    childList: true,
    subtree: true,
    attributes: true,
    attributeFilter: ['style', 'class', 'data-line', 'data-mps-line'],
    characterData: true,
  });
})();
