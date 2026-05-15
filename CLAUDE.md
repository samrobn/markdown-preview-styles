# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What this is

A local-only, sideloaded VS Code extension. Two surfaces:

1. `style.css` injected via `markdown.previewStyles` - tweaks every markdown preview.
2. `extension.js` registered via `markdown.markdownItPlugins` - extends markdown-it with core rules and an inline rule (Properties table from YAML frontmatter, line-number gutter, blank-line placeholders, wiki-link styling).

Never published. Installed by symlinking the repo into `~/.vscode/extensions/local.markdown-preview-styles-<version>/`. Install / re-symlink steps are in `README.md`.

## Commands

```bash
node test/test.js              # unit tests - plain Node, no framework, no node_modules
node test/visual/render.js     # render example.md to test/visual/out.html
node test/visual/render.js check  # + computed-style assertions via agent-browser
```

No build step at the top level. No `node_modules` in repo root. No publish step. Exits non-zero on test failure - safe to wire into a pre-commit hook.

Unit tests use a stub markdown-it (no real markdown-it dependency) and cover the public `extendMarkdownIt()` surface: frontmatter parsing (numeric IDs stay strings, BOM/whitespace stripped, `[[wiki-link]]` disambiguated from `[inline, array]`, `mps-hide: true` opt-out), value rendering (URLs, wiki-links, dates, HTML escaping), the line-number core rules (1-indexed `data-mps-line`, blank-line placeholder injection), and `data-mps-list-depth` tracking on list tokens.

The visual harness in `test/visual/` runs real markdown-it + our plugin + VS Code's `pluginSourceMap` (copied verbatim from upstream) to produce a faithful DOM clone of the preview. Use it when a CSS/DOM bug needs verification outside VS Code's closed webview - `agent-browser` can attach and report computed styles. It's the only way to distinguish "our CSS is wrong" from "VS Code is serving cached CSS" without manual webview devtools. Test-only dev deps live under `test/visual/` (gitignored `node_modules/`); the repo root stays dependency-free.

## Reload after a change

| Change                                            | Minimum reload                                       |
|---------------------------------------------------|------------------------------------------------------|
| `extension.js`                                    | Disable + re-enable extension (Extensions sidebar)   |
| `style.css`                                       | Close + reopen the preview tab                       |
| `preview.js`                                      | Close + reopen the preview tab                       |
| `package.json` (contributes/capabilities/main)    | Full Cmd+Q and relaunch                              |
| Version bump in `package.json`                    | Rename symlink folder to match, then Cmd+Q           |

`Developer: Reload Window` is rarely enough - the markdown preview caches its compiled markdown-it instance across window reloads.

## Architecture gotchas (hard-won; do not relearn)

### VS Code's preview does NOT call `md.render()`

It calls `md.parse(src) + md.renderer.render(tokens, ...)` directly. Overriding or wrapping `md.render` silently does nothing. Inject via:

- `md.core.ruler.push(name, fn)` - mutate `state.tokens` / read `state.src` post-parse
- `md.block.ruler.before(...)` - participate in block parsing
- `md.inline.ruler.before('link', name, fn)` - inline rules; `[[wiki-link]]` must be `before('link')` so it's consumed before markdown-it tries to read it as a reference link
- `md.renderer.rules[type] = fn` - per-token-type rendering

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

## Project conventions

- **No runtime dependencies.** The in-tree `parseFrontmatter` is intentional - it covers Obsidian-shaped frontmatter (top-level scalars, block/inline string arrays). Do not propose adding `js-yaml` without an explicit conversation. Test-only dev deps in `test/` would be acceptable if the gap matters.
- **No `node_modules`.** Same reason. Stated invariant in the README.
- **Numeric-looking values stay strings.** `parseScalar` deliberately doesn't `parseInt` / `parseFloat`. Preserves IDs like `task-id: 20260101`. Don't re-introduce numeric parsing.
- **`:where()` for body-level resets** so user or theme CSS can still override.
- **`rem`, not `em`, for line-number font-size** - `em` scales with parent so numbers next to headings would render larger.
- **British English** in user-facing strings and docs (centring, colour). Code identifiers stay as the syntax requires (CSS `color`, etc.).
- **`[[wiki-link]]` is treated as a string in frontmatter.** `parseFrontmatter` checks for `[[...]]` before falling through to the `[a, b]` inline-array branch, otherwise `parent: [[TASK-123]]` would parse as a one-element array.

## Files

- `extension.js` - `activate()` + `extendMarkdownIt(md)`. Two core rules (`mps_blank_lines`, `mps_frontmatter`), one inline rule (`mps_wikilink`) and its renderer.
- `style.css` - all CSS contributed via `markdown.previewStyles`. Line-number gutter, hover-indicator suppression, Properties table, heading and inline-code tweaks.
- `preview.js` - contributed via `markdown.previewScripts`, runs in the webview. Measures each `.code-line`'s `offsetLeft` and sets `--mps-before-left` so the line-number gutter aligns at every nesting depth.
- `example.md` - exercises every feature; preview to visually verify changes.
- `test/test.js` - assertions against a stub markdown-it (no real markdown-it dep). Run via `node test/test.js`.
- `package.json` - manifest. Contributes `markdown.markdownItPlugins: true` and `markdown.previewStyles: ["./style.css"]`. `capabilities.untrustedWorkspaces.supported: true` so the extension runs in restricted-mode workspaces.
