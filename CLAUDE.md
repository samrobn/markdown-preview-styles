# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What this is

A local-only, sideloaded VS Code extension. Three surfaces:

1. `style.css` injected via `markdown.previewStyles` - tweaks every markdown preview.
2. `extension.js` registered via `markdown.markdownItPlugins` - extends markdown-it with core rules (`mps_block_anchors`, `mps_callouts`, `mps_blank_lines`, `mps_frontmatter`) and inline rules (`mps_embed`, `mps_wikilink`) for the Properties table, line-number gutter, blank-line placeholders, callouts, Obsidian-style wikilinks (workspace-wide resolution with alias / `#heading` / `^block` fragments), and `![[name]]` note transclusion.
3. `preview.js` registered via `markdown.previewScripts` - runs in the webview for per-element line-number gutter alignment and broken-image fallback.

`activate(context)` also builds a workspace `.md` index (used by the wikilink resolver) and registers `FileSystemWatcher`s per indexed root.

Never published. Installed by symlinking the repo into `~/.vscode/extensions/local.markdown-preview-styles-<version>/`. Install / re-symlink steps are in `README.md`.

## Commands

```bash
node test/test.js              # unit tests - plain Node, no framework, no node_modules
node test/visual/render.js     # render example.md to test/visual/out.html
node test/visual/render.js check  # + computed-style assertions via agent-browser
```

No build step at the top level. No `node_modules` in repo root. No publish step. Exits non-zero on test failure - safe to wire into a pre-commit hook.

Unit tests use a stub markdown-it (no real markdown-it dependency) and cover the public `extendMarkdownIt()` surface: frontmatter parsing (numeric IDs stay strings, BOM/whitespace stripped, `[[wiki-link]]` disambiguated from `[inline, array]`, `mps-hide: true` opt-out), value rendering (URLs, wiki-links, dates, HTML escaping), the line-number core rules (1-indexed `data-mps-line`, blank-line placeholder injection), `data-mps-list-depth` tracking on list tokens, callout rewriting, the wikilink target parser (`parseWikilinkTarget`) and resolver (`resolveWikilinkTarget`), index machinery (`addToIndex`/`removeFromIndex`), the `mps_wikilink` inline rule against an injected index, the `mps_block_anchors` core rule, and note transclusion paths (resolved hit, embedNotes off, oversized target, cycle cap, image-still-works regression).

The visual harness in `test/visual/` runs real markdown-it + our plugin + VS Code's `pluginSourceMap` (copied verbatim from upstream) to produce a faithful DOM clone of the preview. Use it when a CSS/DOM bug needs verification outside VS Code's closed webview - `agent-browser` can attach and report computed styles. It's the only way to distinguish "our CSS is wrong" from "VS Code is serving cached CSS" without manual webview devtools. Test-only dev deps live under `test/visual/` (gitignored `node_modules/`); the repo root stays dependency-free.

`test/visual/fixtures/notes/` holds a small set of files the harness uses to seed the workspace index via the `__setWikiStateForTest` test seam - lets the harness exercise wikilink resolution and `![[note]]` transclusion paths against real `markdown-it`. Add fixtures here when verifying new resolver/embed behaviour visually.

**Harness `node_modules` corruption (was misdiagnosed as a Node 25 mdurl bug):** a partial/corrupt install under `test/visual/node_modules` throws `MODULE_NOT_FOUND` for files a package's `package.json` points at - seen as `mdurl` missing `build/index.cjs.js` *and* `lib/encode.mjs`, and `entities` missing its `generated/` files - when `markdown-it` loads. It is **not** Node-version-specific (a freshly-downloaded tarball of the same package is complete), and `npm install mdurl@2.0.0 --force` does **not** fix it. Fix: `rm -rf test/visual/node_modules && npm install`. The live VS Code preview path is unaffected.

**`render.js check` transport:** the installed `agent-browser` no longer decodes `eval --base64`, so `check` passes the assertion script as a single `execFileSync` argv and polls until preview.js has set `--mps-before-left` before measuring (otherwise the gutter-alignment samples race the webview's `requestAnimationFrame` and flake). Don't revert either to `--base64` or to a bare open-then-eval.

## Reload after a change

| Change                                            | Minimum reload                                       |
|---------------------------------------------------|------------------------------------------------------|
| `extension.js`                                    | Disable + re-enable extension (Extensions sidebar)   |
| `style.css`                                       | Close + reopen the preview tab                       |
| `preview.js`                                      | Close + reopen the preview tab                       |
| `package.json` (contributes/capabilities/main)    | Full Cmd+Q and relaunch                              |
| Version bump in `package.json`                    | Rename symlink folder to match, then Cmd+Q           |
| `markdownPreviewStyles.wikilinks.*` settings      | None - `onDidChangeConfiguration` rebuilds the index live |
| Adding/removing/renaming a `.md` file             | None - `FileSystemWatcher` updates the index live    |

`Developer: Reload Window` is rarely enough - the markdown preview caches its compiled markdown-it instance across window reloads.

## Architecture gotchas (hard-won; do not relearn)

### VS Code's preview does NOT call `md.render()`

It calls `md.parse(src) + md.renderer.render(tokens, ...)` directly. Overriding or wrapping `md.render` silently does nothing. Inject via:

- `md.core.ruler.push(name, fn)` - mutate `state.tokens` / read `state.src` post-parse
- `md.block.ruler.before(...)` - participate in block parsing
- `md.inline.ruler.before('link', name, fn)` - inline rules; `[[wiki-link]]` must be `before('link')` so it's consumed before markdown-it tries to read it as a reference link
- `md.renderer.rules[type] = fn` - per-token-type rendering

### VS Code wraps preview content in `.markdown-body`, not bare `body`

VS Code's `markdown-language-features` emits the body as `<div class="markdown-body" dir="auto">${renderedHtml}</div>` (verified in the installed bundle). So top-level blocks - paragraphs, `<pre>`, `<table>`, headings - are children of that **wrapper**, not direct children of `body`. A `body > pre` / `body > table` selector matches **nothing** in the live preview. Target top-level blocks via `.markdown-body > X` (the wide-content breakout rule does this) or a descendant selector that excludes the nesting containers. Don't add a `body > X` arm "for safety" - nothing renders content under bare `body`, so it's dead.

The visual harness historically rendered content directly under `body`, omitting this wrapper - so `body >` selectors passed in the harness yet silently did nothing live (a false positive that only eyeballing the real preview catches; the webview exposes no CDP). `render.js` now wraps content in `.markdown-body` to match VS Code. Keep it that way: any selector that distinguishes top-level from nested blocks depends on the wrapper being present in both places.

**Harness fidelity, twice-bitten - mirror VS Code's CSS chrome too, and know what the harness can't show.** Beyond the wrapper, the harness must reproduce VS Code's `markdown.css` chrome that affects geometry: `html, body { padding: 0 26px }` (plus the never-reset 8px default body margin) put the content's left edge ~104px in, not at the gutter's 5em. A viewport-edge cap (`max-width: calc(100vw - Nrem)`) must clear that whole inset **and** the vertical scrollbar - `100vw` includes the scrollbar but the usable width doesn't. The harness omitted that padding and so under-stated the inset; worse, **headless Chromium renders 0-width (overlay) scrollbars**, so the harness can never reproduce scrollbar-induced horizontal overflow directly. Test the invariant instead (left inset + resolved cap + scrollbar allowance ≤ `innerWidth`), and confirm the actual scroll live. When a layout bug "can't be reproduced in the harness", suspect a chrome/scrollbar the harness doesn't model before doubting the report.

### The hover indicator lives on `::before`, not the element

VS Code's source-line hover bar is `.vscode-dark.showEditorSelection .code-line:hover::before { border-left: 3px solid ...; }`. Setting `border-left: 0` on `.code-line:hover` does nothing. Target the `::before` directly with `!important`.

### The hover `::before` stretches vertically

On hover, VS Code also sets `bottom: 0` on the same `::before`, which (combined with our `top: 50%`) makes the box stretch to ~50% of parent height. With `transform: translateY(-50%)`, the centre point shifts and absolutely-positioned content jumps. Lock `bottom: auto; height: auto` on the `::before` to prevent this.

### Nested list line numbers need per-element measurement, not static CSS

We set `position: relative` on every `.code-line` in `style.css` (VS Code's bundled `markdown.css` only applies it via `body.showEditorSelection .code-line` and as of 1.120 that setting no longer defaults on - see the markEditorSelection gotcha below). Each `<li>` is therefore its own containing block, so the base `left: -5em` on the line-number `::before` is taken from that li's left edge - not from body. Nested items are indented by their parent `<ul>`'s `padding-inline-start`, so the line number drifts into the content area at each nesting level.

What didn't work:

- **CSS anchor positioning** (`anchor-name` on body, `left: anchor(--mps-body left)` on `::before`) silently fails in VS Code's webview - the call resolves to `auto`. Don't go back to it without verifying support in the target Electron build first.
- **Static per-depth `em` overrides** (`.code-line[data-mps-list-depth="N"]::before { left: -Xem }`) get close but never pixel-aligned, because the preview's effective `padding-inline-start` varies by theme, user font size, and Electron build. Iteration converges slowly and is fragile.

Working fix: `preview.js` runs in the webview (contributed via `markdown.previewScripts`), reads each `.code-line`'s `offsetLeft` at render time, and sets `--mps-before-left: <px>` on the element. `style.css` consumes it via `left: var(--mps-before-left, <static-fallback>) !important`. Static fallbacks per `data-mps-list-depth` cover the brief window before the script runs. The `extension.js` core rule still emits `data-mps-list-depth` so the fallbacks have something to bind to.

Two follow-on cleanups the live measurement made necessary:

- **Suppress `::before` on `<ul>`/`<ol>` containers.** A nested `<ul>` opens on the same source line as its first `<li>`, so both carry the same `data-mps-line` and render duplicate, overlapping numbers. The `<li>`'s number is the useful one.
- **For `.code-line` elements that contain other `.code-line` elements** (typically an `<li>` wrapping a nested `<ul>`), anchor the line number to the top of the element instead of vertical-centre - otherwise the number drops down into the middle of the nested content. CSS uses `:has(.code-line)` + `top: 0.3em; transform: none`.

### Line numbers are 0-indexed in markdown-it

`token.map[0]` and `data-line` (which VS Code emits) are both 0-indexed. The editor gutter is 1-indexed. We do not modify `data-line` - VS Code's double-click-to-jump source-mapping reads it. A core rule sets a parallel `data-mps-line = map[0] + 1` attribute via `token.attrSet`, and CSS reads that.

### Blank source lines have no DOM

Blank lines aren't blocks, so markdown-it emits no tokens for them. The `mps_blank_lines` core rule walks tokens with `.map`, finds gaps, and injects `<div class="code-line mps-blank-line" data-line="N" data-mps-line="N+1">` html_block tokens for each blank source line. Default block margins on `p`, `h1-h6`, `ul`, `ol`, etc. are zeroed (low-specificity via `:where()`) so vertical spacing comes primarily from these placeholders.

`bullet_list_open.map[1]` overshoots past the list's last content line into the blank line that terminates the list - markdown-it treats that blank as part of the list. Without intervention, the gap-check loop's `lastEnd = end` skips over it and no placeholder renders, producing a smaller visible gap between the list and the next block than between any other two top-level blocks. The rule trims trailing blanks off each top-level token's `map.end` before advancing `lastEnd`.

### `console.log` from extension code doesn't surface here

In this VS Code build, `console.log` does not appear in the `Log (Extension Host)` Output channel even though `activate()` and `extendMarkdownIt()` are clearly running. For diagnostics, write to `/tmp/mps-trace.log` via `fs.appendFileSync`, or use `vscode.window.showInformationMessage()` for unmissable toasts. Webview DevTools is available via Command Palette → **Developer: Open Webview Developer Tools** for inspecting preview CSS / DOM.

For runtime values inside `preview.js` (where neither `fs` nor toasts work), persist them to `data-mps-debug-*` attributes on the element you're inspecting. Then Command Palette → **Developer: Open Webview Developer Tools** → Elements panel → `Cmd+F` to find the element → hover over the attribute to see its full value. Works without any console access and survives across re-renders.

### The webview doesn't expose CDP

VS Code's renderer process isn't launched with `--remote-debugging-port`, so `agent-browser connect` has nothing to attach to. For headless DOM/computed-style inspection use `test/visual/` (it runs real markdown-it + our plugin + the verbatim `pluginSourceMap`); for the live preview, either open Webview DevTools via the Command Palette, or temporarily wrap `md.renderer.render` to write the rendered HTML to disk. Computer-use can drive VS Code's UI (tier "click") for forced reloads.

### `em` on `::before` resolves against the pseudo's own font-size

`::before` carries `font-size: 0.8rem` so `1em` in its `left` / `width` / `padding-right` is `0.8rem`, NOT the parent's 1em. Easy to miscalculate when triangulating gutter offsets from pixel measurements - convert through the 0.8 × root_font_size factor.

The absolute pixel value depends on root font-size:
- Browser default / visual harness: root = 16px, so 1em on `::before` = 12.8px, `-5em` = -64px.
- VS Code preview: root = 14px, so 1em on `::before` = 11.2px, `-5em` = -56px.

The static fallback `-5em` in style.css therefore matches `GUTTER_TARGET = -64px` only in the harness, not in the live preview. Any `.code-line` element that doesn't get `--mps-before-left` written by preview.js will visibly drift right by ~8px in the actual preview. Keep preview.js's skip list minimal - the table-skip rule already uses `el.tagName !== 'TABLE' && el.closest('table')` so the `<table>` itself is measured.

### Preview-to-the-side edits are an in-place DOM diff, not a re-render

When the preview pane is open beside the editor and the user types, VS Code applies the new HTML as an in-place diff to the existing DOM. Many updates change only attributes or text-node contents without inserting or removing any elements - so a `childList`-only MutationObserver misses them. The symptom: line numbers misalign after any edit (before and after save) because preview.js never re-runs and `--mps-before-left` either becomes stale (layout shifted) or gets cleared by the diff (CSS fallback `-5em` takes over, ~8px off in the live preview - see previous gotcha).

Fix: observe `attributes` (filtered to `style`, `class`, `data-line`, `data-mps-line`) and `characterData` in addition to `childList`. With attribute observation, every `setProperty` we make would fire the observer and schedule another align - a frame-by-frame loop. Guard against it with **idempotent writes**: read the current `--mps-before-left` and skip `setProperty` when unchanged. A `scheduled` flag around `requestAnimationFrame` coalesces N mutation records into one align call per frame.

### `markdown.preview.markEditorSelection` default flipped to `false` in VS Code 1.120

The setting used to default `true`; now it defaults `false`. The body class `showEditorSelection` is what triggered VS Code's bundled `body.showEditorSelection .code-line { position: relative }` rule. Without it, our absolutely-positioned `::before` line numbers lose their per-line containing block and anchor to body, stacking off-screen. Our `style.css` now sets `.code-line { position: relative }` unconditionally to insulate against this and any future toggle of the setting.

The same body class also gates our active-line gutter brightening (`body.showEditorSelection .code-active-line::before { ... }`) and the `preview.js` blank-line bridge (which checks `document.body.classList.contains('showEditorSelection')` before doing any work). So with the setting at its new default, the active-line UX is silent end-to-end. Suggest users set `"markdown.preview.markEditorSelection": true` if they want the indicator back. The README's "Related VS Code settings" section now flags this.

### Callout container and title share the same `data-line`

The blockquote_open token and its first paragraph_open token start on the same source line, so both end up with `map[0] = N` and (via pluginSourceMap) both render with `data-line="N"` + `code-line` class. VS Code's active-line tracker picks the **first** `.code-line` element in document order whose `data-line` matches the caret - that's the container. Its gutter number is suppressed by CSS (the title's number is the visible one), so clicks on the title row showed no brightening at all.

Fix in `mps_callouts`: after the tag rewrites, strip `data-line`, `dir`, and the `code-line` class from the container token's attrs. Only the title carries source-map attributes now, so the active-line tracker exact-matches the title.

Critical: keep `token.map` intact on the container. `mps_blank_lines` walks every **level-0 token's** `.map` for gap detection between top-level blocks (the level check excludes nested content inside blockquotes/lists). Clearing `.map` on the container removes it from the gap-check entry points, and the placeholder that separates adjacent callouts collapses - they render touching with no visible gap.

The visual harness re-adds `data-line` + `code-line` to the container because its pluginSourceMap is registered after our rules (md.use order), whereas VS Code's load order is the reverse. So the harness output looks like the strip didn't happen; the live preview is where it matters.

### Synthetic image tokens need `children`, not just `alt` attrs

VS Code's preview overrides `md.renderer.rules.image` but calls the previous (default) renderer after rewriting `src`. The default markdown-it image renderer does `attrs[alt] = renderInlineAsText(token.children, ...)` on every render — so an empty `children` array clobbers any `alt` attribute we set on the token. When pushing a synthetic `image` token via `state.push('image', 'img', 0)`, populate `tok.children` with a `text` token carrying the alt content; setting `tok.content` alone is not enough.

```js
const altTok = new state.Token('text', '', 0);
altTok.content = altText;
tok.children = [altTok];
```

Found while implementing `![[image.png]]` embeds. Unit tests caught nothing because they assert on the parser output before the renderer runs; only render-level tests or the live preview surface it.

### `naturalWidth === 0` is NOT a reliable broken-image signal

Chromium reports `naturalWidth = naturalHeight = 0` for any SVG whose `<svg>` root has no `width`, no `height`, AND no `viewBox` (no intrinsic dimensions per CSS Images spec) — even when the load *succeeded*. Don't use `(img.complete && img.naturalWidth === 0 && img.naturalHeight === 0)` as a "did it fail" heuristic — viewBox-less SVGs (common in Figma/Illustrator exports and hand-written icons) get misclassified as broken.

### Use `img.decode()` for broken-image detection, not a `loaded` flag

`addEventListener('load', ...)` doesn't fire for listeners attached after the image already completed (cached re-wires). A flag-based race-guard (`if (img.complete && !loaded) handleError()`) misclassifies cached images as broken. Use `img.decode()` — Promise resolves iff the browser can decode, rejects on failure, same behaviour for cache-hit and fresh-fetch.

### Pseudo-elements DO render on a broken `<img>` in this Chromium build

`::before` and `::after` are normally suppressed on replaced elements (e.g. `<img>`), but once an `<img>` fails to load, Chromium drops the replaced-element treatment and renders pseudo-elements normally. Verified empirically. Useful for dashed-box / icon / filename treatments on `.mps-broken`.

But: CSS `gap` on an inline-flex parent does NOT add space between an `<img>`'s `::before` and `::after`, because they're not direct flex children of the parent — they're laid out inside the `<img>`'s own box. Use an explicit `margin-right` on `::before` instead of relying on `gap`.

### VS Code does NOT rewrite `<img src>` to a webview URI in the DOM

Counterintuitive but verified by live DevTools inspection: VS Code's preview adds a `data-src` attribute as a sentinel and resolves paths at fetch time via the document's `<base href>`. The `src` attribute on the `<img>` element stays as whatever raw path the token emitted (e.g. `example-image.svg`, `attachments/foo.png`).

This means `preview.js` can `getAttribute('src')` and operate on the user's actual path string — no need to parse webview URIs, no `vscode-webview-resource://` URL surgery. The `attachments/` fallback in `preview.js` works because `setAttribute('src', 'attachments/' + name)` re-triggers VS Code's fetch-time resolution.

### `env.currentDocument` is a `vscode.Uri`, not a `TextDocument`

The `mps_wikilink` renderer needs the previewed document's on-disk path to emit a *document-relative* href (the only href form that routes through VS Code's `openLink` channel for native in-preview navigation — no OS prompt, opens in preview not raw editor). It reads that path from `env.currentDocument` at render time.

`currentDocument` is a `vscode.Uri`, so its path is at **`cd.fsPath`** — there is NO `cd.uri`. Verified against the 1.122 bundle (`markdown-language-features/dist/extension.js`), where `MarkdownEngine.render` builds the env as:

```js
{ containingImages: new Set, currentDocument: typeof e === "string" ? void 0 : e.uri, resourceProvider: r, slugifier: ... }
```

Reading `cd.uri.fsPath` (the `TextDocument` shape) returns `undefined`, `docPath` falls to `null`, and every resolved wikilink takes the `vscode://file/...` fallback — OS prompt + raw editor.

**The incremental-edit trap (the load-bearing half).** `currentDocument` is `undefined` on the in-place edit render path. When you type into a preview-to-the-side, VS Code's `renderBody` re-renders with the spliced document *text*: `let o = innerChanges?.length ? uae(e.getText(), innerChanges) : e` — a **string** when there are inner changes — and `MarkdownEngine.render`'s string branch sets `currentDocument: void 0`. So `cd.fsPath` works on the full render (open, save, focus change, scroll, refresh) but vanishes after the first keystroke, re-emitting the `vscode://file` href exactly when you go to click it. A fix that only reads `currentDocument` looks correct on open and regresses on edit — see the "in-place DOM diff" gotcha above for why the morphed-in HTML carries the stale href.

The robust source is **`env.resourceProvider`** — the `MarkdownPreview` instance itself, passed identically on *both* render paths (`renderDocument(r, this, ...)` and `renderBody(r, this, a)` both forward `this`). It exposes `get resource()` (the previewed doc's Uri). So the renderer reads, in order: `cd.fsPath` (Uri) → `cd.uri.fsPath` (TextDocument, older/future builds) → `rp.resource.fsPath` (survives the incremental path) → `env.resource.fsPath` (speculative — never observed in 1.122) → `null` (→ `vscode://file` fallback). Verified live: on every render, both `cd.fsPath` and `rp.resource.fsPath` carried the correct absolute path and agreed. The visual harness calls `md.render(src)` with no env, so it never exercises any of this — only the live preview (or a render-level test passing a Uri-shaped `currentDocument` / a `{resource}`-bearing `resourceProvider`) surfaces it.

How the relative href reaches preview-mode navigation: the webview click handler (`media/index.js`) posts `openLink` for any schemeless href; the extension host's `resolveLinkTarget(href, resource)` runs `resolveInternalDocumentLink`, which `joinPath(dirname(previewResource), href)` for a relative href (and re-roots to the workspace folder for a `/`-leading one — which is why bare-absolute hrefs ENOENT-double). When `markdown.preview.openMarkdownLinks` is `inPreview` (the default) and the target is markdown, it opens in the preview. A cross-root `extraIndexRoots` target therefore works too: `path.relative` yields a `../../…/vault/note.md` chain that joins back to the absolute path. `data-href` is deliberately NOT emitted on the wikilink `<a>` (VS Code only adds it to its own `link_open` tokens): the click handler falls back to `href` when `data-href` is absent, so the schemeless `href` alone is sufficient. Adding it would be cargo-cult.

Known edge cases left unhandled (rare, no clean fix): wikilinking from an untitled/unsaved buffer (`Uri.fsPath` of an `untitled:` doc is a dirless junk path, so `path.relative` misfires — the old `vscode://file` path happened to work there); and Windows cross-drive targets (`path.win32.relative` returns a `D:\…` absolute → the click handler's `/^[a-z\-]+:/i` treats `D:` as a non-allowlisted scheme → silent drop). Irrelevant to this macOS-only sideload; documented so a future port knows.

### `activate(context)` requires `vscode`, but unit tests don't have one

Wikilink resolution needs `vscode.workspace.findFiles` + `FileSystemWatcher`, so `require('vscode')` is mandatory inside `activate`. But the unit-test harness runs in plain Node with no VS Code extension host - `require('vscode')` throws `MODULE_NOT_FOUND`. Wrap the require in try/catch and treat absence as "no workspace context, skip index init":

```js
let vscode;
try { vscode = require('vscode'); } catch (_) { return; }
```

Test stubs reach the same code via `activate({ subscriptions: [] })` - the `subscriptions` property is the duck-type the production VS Code `context` always has. If a test stub omits it (`activate()` with no arg), the gate `if (context && context.subscriptions)` keeps the init path off.

### Module-level mutable state lives in `extension.js` now

Before the wikilink upgrade, `extension.js` had zero module-level mutable state - every render was a pure transformation of the source string. The workspace index changes that: `wikiIndex` (Map), `wikiConfig` (resolved settings), `wikiRoots` (canonical paths), `_activeWatchers` (disposables across rebuilds), and the injectable I/O hooks (`wikiReadFile`, `wikiStatFile`) all live at module top-level. The inline rules close over them via the `resolveWikilinkTarget` / `tryEmitTranscludeToken` helpers.

Consequence for tests: state leaks across tests unless reset. Use `__setWikiStateForTest({ index, config, readFile, statFile })` to inject and `__resetWikiStateForTest()` to clear. The `withIndex` / `withTranscludeFixtures` helpers in `test/test.js` wrap this in try/finally so a thrown assertion doesn't poison the next test.

### Calling `md.render()` from inside a renderer rule is fine - VS Code's "doesn't call render" gotcha is about INCOMING, not outgoing

The earlier gotcha "VS Code's preview does NOT call `md.render()`" is about VS Code invoking *our* plugin - it bypasses `md.render` and calls `parse + renderer.render` directly, so wrapping `md.render` to intercept input does nothing. **We are still free to call `md.render()` ourselves on derived input.** The note-transclusion path does exactly this: the `mps_embed_note` renderer reads the target file, slices to the fragment, and recurses via `md.render(slice, env)` to produce the embedded body. The recursion guard is `env.mpsEmbedDepth` (capped at 2) carried through the env object.

This is *not* a "wrap VS Code's render" - it's a fresh render call on a fresh substring with no expectation that VS Code's own preview pipeline will route through it. Safe pattern.

But the recursion re-runs the **entire core-rule pipeline** on the embedded slice, and some core rules emit host-document-scoped output that must NOT run inside an embed. `mps_blank_lines` would stamp `data-line` / `data-mps-line` numbered from the *slice's* line 0 (colliding with the host's line numbers, misleading VS Code's active-line tracker and double-click-to-jump) and `mps_block_anchors` would emit a second `id="mps-block-<id>"` (duplicate id, invalid HTML, ambiguous scroll target). Both gate on `state.env.mpsEmbedDepth`: `mps_blank_lines` skips entirely (embedded content carries no gutter); `mps_block_anchors` still strips the `^id` marker for clean text but suppresses the id. `mps_callouts` deliberately still runs (callouts are content, not source-mapping); `mps_frontmatter` is a no-op because the slice has already had its frontmatter stripped. Any new source-mapping core rule must add the same `mpsEmbedDepth` gate.

### Heading anchors must match VS Code's GitHub slugifier

A `[[note#heading]]` href anchor (`#slug`) only scrolls to the heading if `slug` equals the `id` VS Code renders on the heading element. The extension does NOT set heading ids itself - VS Code's preview does, via the **GitHub slugifier** (verified against the 1.122 bundle: `heading.trim().toLowerCase().replace(<unicode-symbol-regex>, "").replace(/\s/g, "-")`). The single `slugifyHeading` helper reproduces it with `replace(/[^\p{L}\p{N}\p{M}_\- ]/gu, "").replace(/\s/g, "-")` - the key properties a naive `[^a-z0-9-]` slug gets wrong: **Unicode letters are kept** (`Café` → `café`, not `caf`) and **whitespace is replaced per-character not collapsed** (`a  b` → `a--b`). Do not "simplify" it back to an ASCII-only class. Not reproduced: the `-1`/`-2` suffixing VS Code adds to duplicate headings (a wikilink to a repeated heading targets the first). `env.slugifier` is a stateful builder (`add` only, dedup-tracking) so it can't be borrowed for a one-off fragment without corrupting the ToC counter - hence the standalone helper.

### The bespoke wikilink parser is the deliberate choice

`markdown-it-wikilinks` exists, supports the pact subset (`name|alias|#heading`), and is what Foam uses. We did not adopt it. Reasons (capturing so future-me doesn't re-litigate):

- **No-runtime-deps rule (Project conventions below).** Adopting the library means either an `npm install` step that violates the no-`node_modules` invariant, or vendoring an unmaintained-since-2023 file we now own anyway.
- **Block refs and non-image transclusion are layered on top regardless** - the library doesn't help with those.
- **Total bespoke parser is ~50 lines.** Worth owning for the invariant.

`parseWikilinkTarget` (canonical fragment-before-pipe order: `name(#heading|^block)?(\|alias)?`) is THE parser - all paths use it. Don't add a second one.

### Workspace index ordering across multiple roots

Within a single root, ordering is shortest-path then alphabetical (intuitive "the closest file wins"). Across roots (workspace folders + `extraIndexRoots`), the `rootSortKey` (canonicalised root path) dominates - so "shortest path" only carries meaning *within* one root. A deeply nested file in an earlier-alphabetical root beats a top-level file in a later root with the same basename. README documents this; tests cover it (`resolveWikilinkTarget: cross-root ordering by rootSortKey then path`).

Don't try to make "shortest path" global - it would require a notion of "canonical" root that the user can't reasonably specify.

## Project conventions

- **No runtime dependencies.** The in-tree `parseFrontmatter` and `parseWikilinkTarget` are intentional - they cover the shape we need without pulling in `js-yaml` or `markdown-it-wikilinks`. Do not propose adding either without an explicit conversation; see "bespoke wikilink parser is the deliberate choice" gotcha above for the wikilink-parser rationale. Test-only dev deps in `test/` would be acceptable if the gap matters.
- **No `node_modules`.** Same reason. Stated invariant in the README.
- **Numeric-looking values stay strings.** `parseScalar` deliberately doesn't `parseInt` / `parseFloat`. Preserves IDs like `task-id: 20260101`. Don't re-introduce numeric parsing.
- **`:where()` for body-level resets** so user or theme CSS can still override.
- **`rem`, not `em`, for line-number font-size** - `em` scales with parent so numbers next to headings would render larger.
- **British English** in user-facing strings and docs (centring, colour). Code identifiers stay as the syntax requires (CSS `color`, etc.).
- **`[[wiki-link]]` is treated as a string in frontmatter.** `parseFrontmatter` checks for `[[...]]` before falling through to the `[a, b]` inline-array branch, otherwise `parent: [[TASK-123]]` would parse as a one-element array.
- **Public repo - no personal paths in shipped files.** `README.md` setting examples use `~/Documents/notes`, not the iCloud vault path. `package.json` configuration descriptions stay generic. Personal config (e.g. an actual `extraIndexRoots` vault entry) goes in user settings only.
- **Settings UX: zero-config working case.** The four `markdownPreviewStyles.wikilinks.*` keys default such that the extension works for a fresh user with nothing configured. `enabled: true` (workspace-wide resolution on), `extraIndexRoots: []` (no extra surface), `embedNotes: true` (transclusion on), `embedMaxBytes: 262144` (safe cap). Don't change defaults without considering the no-config case.
- **Workspace-aware character.** The extension started as a pure markdown-it plugin with no awareness of VS Code's API. The wikilink upgrade added `require('vscode')`, workspace indexing, `FileSystemWatcher`s, and `onDidChangeConfiguration` handling - a real VS Code extension shape. New features can take advantage of this (e.g. read settings, query workspace state). But the markdown-it pipeline itself should stay framework-free where possible - `parseWikilinkTarget` and `resolveWikilinkTarget` have no `vscode` dependency, which is what makes them unit-testable in plain Node.

## Files

- `extension.js` - `activate(context)` + `extendMarkdownIt(md)`. Four core rules (`mps_block_anchors`, `mps_callouts`, `mps_blank_lines`, `mps_frontmatter`), two inline rules (`mps_embed`, `mps_wikilink`) and their renderers (`mps_wikilink`, `mps_embed_note`). Workspace `.md` index built on activate, maintained by per-root `FileSystemWatcher`s. Module-level mutable state: `wikiIndex`, `wikiConfig`, `wikiRoots`, `_activeWatchers`, `wikiReadFile`, `wikiStatFile`. Exports the resolver / parser / index helpers + `__setWikiStateForTest` / `__resetWikiStateForTest` for tests and the visual harness.
- `style.css` - all CSS contributed via `markdown.previewStyles`. Line-number gutter, hover-indicator suppression, Properties table, callouts, heading and inline-code tweaks, image embeds (`mps-embed-image` + broken-image fallback), note transclusion (`mps-embed-note` container + `mps-embed-cycle` style).
- `preview.js` - contributed via `markdown.previewScripts`, runs in the webview. Measures each `.code-line`'s `offsetLeft` and sets `--mps-before-left` so the line-number gutter aligns at every nesting depth. Also handles the `attachments/` retry and broken-image styling for image embeds.
- `example.md` - exercises every feature; preview to visually verify changes.
- `test/test.js` - assertions against a stub markdown-it (no real markdown-it dep). Run via `node test/test.js`. 100+ tests across frontmatter, value rendering, wikilink/embed inline rules, line-number core rules, callouts, wikilink parser, workspace resolver, index machinery, mps_wikilink with workspace resolution, block-anchor rule, and note transclusion.
- `test/visual/` - real-`markdown-it` harness (see "visual harness" section above). `fixtures/notes/` seeds the workspace index for wikilink/transclude verification.
- `package.json` - manifest. Contributes `markdown.markdownItPlugins: true`, `markdown.previewStyles: ["./style.css"]`, `markdown.previewScripts: ["./preview.js"]`, and `configuration` with the four `markdownPreviewStyles.wikilinks.*` keys. `capabilities.untrustedWorkspaces.supported: true` and `virtualWorkspaces: true` so the extension runs in restricted-mode workspaces.
