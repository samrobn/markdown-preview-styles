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

  // Broken-image fallback for Obsidian-style embeds (![[image.png]]).
  //
  // extension.js pushes a synthetic markdown-it `image` token with class
  // `mps-embed-image` and the raw path from the wiki syntax. VS Code's
  // preview leaves `src` as that raw path (it adds a `data-src` sentinel
  // and resolves the path at fetch time via the webview's base href). If
  // the file doesn't exist the <img> fires an `error` event.
  //
  // First error on a bare filename (no slash): retry with `attachments/`
  // prefixed. Matches the Obsidian convention where image assets live in
  // an attachments/ subdirectory next to the markdown file. Paths with a
  // slash are NOT retried - if the user wrote `![[sub/foo.png]]`, retrying
  // as `sub/attachments/foo.png` is more likely to surprise than help.
  //
  // Second error (or first when the path had a slash): add `.mps-broken`
  // so CSS can render the placeholder with the original path text.
  function setupBrokenImageFallback() {
    const imgs = document.querySelectorAll('img.mps-embed-image:not([data-mps-wired])');
    for (const img of imgs) {
      img.setAttribute('data-mps-wired', 'true');
      // Capture the raw path BEFORE any error fires. The fallback swap
      // mutates `src` to `attachments/<name>`, so without this snapshot
      // the broken-state placeholder would show the post-swap path
      // instead of the user's actual `![[name]]` argument.
      img.setAttribute('data-mps-original-src', img.getAttribute('src') || '');

      let loaded = false;
      let settled = false;
      img.addEventListener('load', () => { loaded = true; settled = true; });
      img.addEventListener('error', handleError);

      function handleError() {
        settled = true;
        // Lost-race protection on top of the load-listener: if the load
        // event managed to fire AND the error somehow fires later (browsers
        // shouldn't, but defence in depth), don't degrade a working image.
        if (loaded) return;
        if (!img.hasAttribute('data-mps-fallback-tried')) {
          img.setAttribute('data-mps-fallback-tried', 'true');
          const currentSrc = img.getAttribute('src') || '';
          // Case-insensitive check so capital-A `Attachments/` (a common
          // Obsidian customisation) also short-circuits the retry instead
          // of producing `Attachments/attachments/foo.png`.
          const lc = currentSrc.toLowerCase();
          // Narrow the retry to bare filenames - paths with a slash are
          // the user's explicit relative path and shouldn't be guessed at.
          // This matches the README documentation.
          const isBareFilename = currentSrc && !currentSrc.includes('/');
          const alreadyInAttachments = lc.includes('/attachments/') || lc.startsWith('attachments/');
          if (isBareFilename && !alreadyInAttachments) {
            img.setAttribute('src', 'attachments/' + currentSrc);
            settled = false; // retry pending - allow load/error to fire again
            return;
          }
        }
        if (!img.classList.contains('mps-broken')) {
          img.classList.add('mps-broken');
        }
      }

      // Race-guard for images that resolved BEFORE we attached listeners.
      // Previous approach (frame-delay + `loaded` flag) misclassified cached
      // images as broken: when VS Code's DOM diff cleared data-mps-wired on a
      // still-loaded <img>, the rewire attached fresh listeners after the
      // browser had already fired `load`. complete=true + loaded=false then
      // triggered a false handleError.
      //
      // img.decode() is the race-free check: resolves iff the browser can
      // decode the current bitmap (i.e. loaded successfully), rejects on any
      // decode/network failure. Works identically for cache-hit and fresh-
      // fetch, so the rewire path is now safe.
      if (img.complete) {
        img.decode().then(() => {
          loaded = true;
          settled = true;
        }).catch(() => {
          if (!settled) handleError();
        });
      }
    }
  }

  // Reset the wired state when VS Code's in-place DOM diff mutates an
  // existing <img>'s src. Without this, swapping `![[a.png]]` for
  // `![[b.png]]` in the source reuses the same <img> element with stale
  // data-mps-wired / data-mps-fallback-tried / data-mps-original-src,
  // so the new image inherits the previous one's broken-state behaviour.
  function rewireChangedImages() {
    const imgs = document.querySelectorAll('img.mps-embed-image[data-mps-wired]');
    for (const img of imgs) {
      const current = img.getAttribute('src') || '';
      const captured = img.getAttribute('data-mps-original-src') || '';
      // If src differs from the captured original AND it's not just the
      // attachments/ retry we issued ourselves, the diff swapped in a
      // genuinely new path - clear wired state so setupBrokenImageFallback
      // re-runs on the next schedule().
      if (current !== captured && current !== 'attachments/' + captured) {
        img.removeAttribute('data-mps-wired');
        img.removeAttribute('data-mps-fallback-tried');
        img.classList.remove('mps-broken');
      }
    }
  }

  // Run on initial load and any time the preview re-flows.
  let scheduled = false;
  function schedule() {
    if (scheduled) return;
    scheduled = true;
    requestAnimationFrame(() => {
      scheduled = false;
      align();
      rewireChangedImages();
      setupBrokenImageFallback();
    });
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
    // 'src' is included so that VS Code's in-place DOM diff swapping a src
    // on an existing <img> triggers rewireChangedImages, which clears the
    // wired state so the new src gets fresh fallback handling. We write
    // src ourselves during the attachments/ retry; that write is gated by
    // data-mps-fallback-tried (not in this filter) so it doesn't loop.
    attributeFilter: ['style', 'class', 'data-line', 'data-mps-line', 'src'],
    characterData: true,
  });
})();
