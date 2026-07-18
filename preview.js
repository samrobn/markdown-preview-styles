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

  // Code blocks: the fence's source-map attrs land on an element INSIDE the
  // <pre> (the <code> in plain markdown-it), whose gutter ::before sits 64px
  // left of it - within the pre's box, which VS Code's markdown.css scrolls
  // (overflow: auto), clipping the number. Mirror the line onto the <pre>
  // itself so CSS can render the block's single number outside any scroll
  // box. Idempotent writes (skip when unchanged) keep the attribute-watching
  // MutationObserver from looping, same pattern as align().
  function mirrorPreLineNumbers() {
    for (const pre of document.querySelectorAll('pre')) {
      // Two shapes: fences carry the source-map attrs on the inner <code>
      // (first mapped descendant wins - a fence has exactly one); indented
      // code blocks carry them on the <pre> itself. Table-nested pres stay
      // unnumbered like all other table content, and a pre whose inner
      // attrs the in-place DOM diff wiped drops its stale mirror rather
      // than showing a number that no longer maps to a source line.
      const inner = pre.querySelector('.code-line[data-mps-line]');
      const ownLine = pre.classList.contains('code-line') && pre.getAttribute('data-mps-line');
      if ((!inner && !ownLine) || pre.closest('table')) {
        if (pre.classList.contains('mps-pre-line')) {
          pre.classList.remove('mps-pre-line');
          // data-mps-line on a .code-line pre is the pipeline's, not our
          // mirror's - leave it.
          if (!pre.classList.contains('code-line')) pre.removeAttribute('data-mps-line');
        }
        continue;
      }
      const line = inner ? inner.getAttribute('data-mps-line') : ownLine;
      if (pre.getAttribute('data-mps-line') !== line) pre.setAttribute('data-mps-line', line);
      if (!pre.classList.contains('mps-pre-line')) pre.classList.add('mps-pre-line');
    }
  }

  function align() {
    const body = document.body;
    if (!body) return;
    const bodyLeft = body.getBoundingClientRect().left;
    const bodyContentLeft = bodyLeft + parseFloat(getComputedStyle(body).paddingLeft || '0');
    // pre.mps-pre-line carries the mirrored code-block number (set above),
    // so it needs the same measured offset as every .code-line.
    const lines = document.querySelectorAll('.code-line, pre.mps-pre-line');
    for (const el of lines) {
      // Skip elements INSIDE a table (rows/cells) - line numbers there are
      // suppressed by CSS. The <table> element itself still needs its
      // offset computed; otherwise it falls back to `-5em`, which differs
      // from `GUTTER_TARGET` whenever the root font-size isn't 16px (e.g.
      // VS Code's preview root is 14px → static fallback lands 8px to the
      // right of every other gutter number).
      if (el.tagName !== 'TABLE' && el.closest('table')) continue;
      // pre.mps-pre-line is deliberately static (a positioned pre's own
      // overflow scrollport would clip its ::before - see style.css), so
      // its number positions against the nearest positioned ancestor.
      // Measure left AND top within that containing block instead of the
      // element itself.
      if (el.tagName === 'PRE') {
        const cb = el.offsetParent;
        if (!cb) continue;
        const cbRect = cb.getBoundingClientRect();
        const elRect = el.getBoundingClientRect();
        const preLeft = `${(bodyContentLeft + GUTTER_TARGET) - cbRect.left}px`;
        const preTop = `${elRect.top - cbRect.top}px`;
        if (el.style.getPropertyValue('--mps-before-left') !== preLeft) {
          el.style.setProperty('--mps-before-left', preLeft);
        }
        if (el.style.getPropertyValue('--mps-pre-top') !== preTop) {
          el.style.setProperty('--mps-pre-top', preTop);
        }
        continue;
      }
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
          // Chromium renders its native [glyph][alt] fallback with no gap,
          // and both halves are anonymous internals no CSS box can separate
          // (word-spacing is inert; a spacer ::before lands before the
          // glyph; a leading space in alt renders only when set AFTER the
          // placeholder has painted - set during this error handler it
          // collapses). Instead: blank the alt, which collapses the native
          // fallback entirely, and let CSS draw the placeholder - ::before
          // icon + ::after filename from data-mps-alt, spaced by margin.
          const altText = (img.getAttribute('alt') || '').trim();
          if (altText) {
            img.setAttribute('data-mps-alt', altText);
            // alt="" conventionally marks an img decorative; role="img" +
            // aria-label keeps the placeholder in the accessibility tree
            // with the filename as its accessible name.
            img.setAttribute('aria-label', altText);
            img.setAttribute('role', 'img');
          }
          img.setAttribute('alt', '');
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
        if (img.hasAttribute('data-mps-alt')) {
          // The DOM diff patches the NEW image's alt in with its src; only
          // fall back to the stash when the diff left alt blanked. An
          // unconditional restore here once overwrote the new image's alt
          // with the previous image's stashed one.
          if (!img.getAttribute('alt')) {
            img.setAttribute('alt', img.getAttribute('data-mps-alt'));
          }
          img.removeAttribute('data-mps-alt');
          img.removeAttribute('aria-label');
          img.removeAttribute('role');
        }
      } else if (img.classList.contains('mps-broken') &&
                 img.hasAttribute('data-mps-alt') && img.getAttribute('alt')) {
        // The diff can also re-sync a blanked alt back to the render's
        // non-blank value without touching src (extension.js always emits
        // one) - Chromium's native [glyph][alt] fallback then reappears
        // jammed against the CSS-drawn placeholder. Re-blank it; the write
        // only fires when alt is non-empty, so no observer loop.
        img.setAttribute('alt', '');
      }
    }
  }

  // Interactive task-list checkboxes: wrap each rendered checkbox (Markdown
  // All in One's markdown-it-task-lists markup - without that extension no
  // checkboxes render and this is a no-op) in a real anchor whose href is a
  // vscode:// deep link; extension.js's UriHandler flips the marker on the
  // source line. The mechanism is load-bearing and non-obvious - see the
  // CLAUDE.md gotcha (only a REAL anchor activated by a REAL click launches
  // the protocol from the webview) before changing any of it.
  let cachedSettingsRaw = null;
  let cachedSource = null;
  function previewSource() {
    const meta = document.getElementById('vscode-markdown-preview-data');
    const raw = meta && meta.dataset.settings;
    if (!raw) return null;
    // Memoised on the raw JSON - this runs on every schedule() pass.
    if (raw !== cachedSettingsRaw) {
      cachedSettingsRaw = raw;
      try {
        cachedSource = JSON.parse(raw).source || null;
      } catch {
        cachedSource = null;
      }
    }
    return cachedSource;
  }

  function toggleHref(source, line) {
    return 'vscode://local.markdown-preview-styles/toggle?doc=' +
      encodeURIComponent(source) + '&line=' + encodeURIComponent(line);
  }

  function retrofitTaskCheckboxes() {
    const source = previewSource();
    if (!source) return;
    for (const box of document.querySelectorAll('input.task-list-item-checkbox')) {
      const listItem = box.closest('li.task-list-item');
      if (!listItem) continue;
      // Transcluded content's data-line is slice-relative - wrong document.
      if (listItem.closest('.mps-embed-note')) continue;
      // Label-wrap renderers (markdown-it-task-lists label mode) would turn
      // every label-text click into a synthetic input click bubbling through
      // the anchor - leave those checkboxes inert rather than misfiring.
      if (box.closest('label')) continue;
      const line = listItem.getAttribute('data-line');
      if (line === null) continue;
      let anchor = box.parentElement;
      if (!anchor.classList.contains('mps-task-toggle')) {
        anchor = document.createElement('a');
        anchor.className = 'mps-task-toggle';
        // The anchor is the single interactive control; the input is
        // presentation. One tab stop, checkbox semantics for AT, and no
        // keyboard path to the input (whose native Space toggle would set
        // dirty checkedness and fight attribute-driven state).
        anchor.setAttribute('role', 'checkbox');
        anchor.setAttribute('aria-label', 'Toggle task');
        box.replaceWith(anchor);
        anchor.appendChild(box);
        box.tabIndex = -1;
        box.setAttribute('aria-hidden', 'true');
      }
      // Idempotent writes - the attribute-watching MutationObserver re-runs
      // this pass on every change it makes; unchanged passes settle.
      const href = toggleHref(source, line);
      if (anchor.getAttribute('href') !== href) anchor.setAttribute('href', href);
      const checkedNow = box.hasAttribute('checked') ? 'true' : 'false';
      if (anchor.getAttribute('aria-checked') !== checkedNow) {
        anchor.setAttribute('aria-checked', checkedNow);
      }
    }
  }

  // Optimistic flip: the real round trip (protocol launch -> source edit ->
  // save -> debounced re-render) lags noticeably behind the click, so flip
  // the box immediately; the next render confirms or corrects it.
  document.addEventListener('click', (event) => {
    // Modified or non-primary clicks divert the navigation (open-elsewhere
    // semantics) - don't flip a box whose toggle may never fire.
    if (event.button !== 0 || event.ctrlKey || event.metaKey ||
        event.shiftKey || event.altKey) return;
    const target = event.target;
    if (!target || !target.closest) return;
    const anchor = target.closest('a.mps-task-toggle');
    if (!anchor) return;
    const box = anchor.querySelector('input');
    if (!box) return;
    // Re-derive the href from the CURRENT data-line before the native
    // activation reads it - a DOM patch may have renumbered lines after the
    // last (rAF-debounced) retrofit pass, and a stale line would flip a
    // neighbouring item.
    const listItem = anchor.closest('li.task-list-item');
    const source = previewSource();
    const line = listItem && listItem.getAttribute('data-line');
    if (source && line !== null) {
      anchor.setAttribute('href', toggleHref(source, line));
    }
    // Flip the ATTRIBUTE, not the property: a property write sets the
    // input's dirty-checkedness flag, after which the DOM differ's
    // attribute-level patches stop affecting rendered state. The input is
    // never property-written or directly interacted with (pointer-events
    // none, tabIndex -1), so default checkedness stays authoritative and
    // repaints immediately.
    if (box.hasAttribute('checked')) box.removeAttribute('checked');
    else box.setAttribute('checked', '');
    anchor.setAttribute('aria-checked', box.hasAttribute('checked') ? 'true' : 'false');
    // No preventDefault: the anchor's native activation IS the toggle.
  }, true);

  // Run on initial load and any time the preview re-flows.
  let scheduled = false;
  function schedule() {
    if (scheduled) return;
    scheduled = true;
    requestAnimationFrame(() => {
      scheduled = false;
      mirrorPreLineNumbers();
      align();
      rewireChangedImages();
      setupBrokenImageFallback();
      retrofitTaskCheckboxes();
    });
  }
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', schedule);
  } else {
    schedule();
  }
  window.addEventListener('resize', schedule);
  // Font loading reflows the document without any DOM mutation, so the
  // observer never fires and measured offsets (notably the pre top vars)
  // go stale. Re-align once the fonts settle.
  if (document.fonts && document.fonts.ready) document.fonts.ready.then(schedule);
  // Same class of problem, ongoing: a successful late image load (or any
  // other resource-driven height change) reflows everything below it with
  // no attribute/class mutation and no resize. The pre numbers position
  // against an ancestor via a measured top, so they'd strand mid-air until
  // the next keystroke. Watching the content wrapper's size catches every
  // such reflow; align()'s idempotent writes keep it from looping. Not
  // covered by the visual harness - every scriptable DOM change also fires
  // the MutationObserver, so the mutation-free trigger can't be synthesised
  // there; verified by reasoning against a slow remote image.
  if (typeof ResizeObserver !== 'undefined') {
    new ResizeObserver(schedule).observe(
      document.querySelector('.markdown-body') || document.body || document.documentElement
    );
  }
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
    // 'alt' is included so a diff re-syncing a blanked broken-image alt
    // triggers the re-blank guard in rewireChangedImages; our own alt
    // writes there are conditional on a non-empty value, so no loop.
    attributeFilter: ['style', 'class', 'data-line', 'data-mps-line', 'src', 'alt'],
    characterData: true,
  });
})();
