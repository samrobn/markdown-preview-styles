# Visual verification harness

Reproduces VS Code's markdown preview rendering pipeline locally so the CSS/DOM combo can be inspected outside the closed webview.

## Why it exists

VS Code's preview is the only place the real CSS and the final DOM combine, but the webview is sandboxed - no CDP endpoint, no devtools attach. When line-number gutter or any other CSS-sensitive layout looks wrong in the preview, the question "is the bug in our CSS or in VS Code's loading/cache" is otherwise unanswerable without manual webview devtools.

This harness:

- runs real `markdown-it` (test-only dev dep)
- runs our `extension.js` plugin
- runs the exact `pluginSourceMap` copied verbatim from `microsoft/vscode/extensions/markdown-language-features/src/markdownEngine.ts` (the thing that adds `.code-line` + `data-line` to every token)

Output is a single HTML file openable in any browser. With `agent-browser` installed, the same harness also runs computed-style assertions via CDP.

## Setup

```bash
npm install --prefix test/visual
```

`node_modules/` is gitignored. Re-run after pulling if `package.json` changes.

## Usage

```bash
# Render example.md → test/visual/out.html
node test/visual/render.js

# Render + run computed-style assertions via agent-browser
node test/visual/render.js check
```

`check` opens the file in agent-browser's Chrome session, samples the `::before` `left` of each line-number gutter at depths 1/2/3, and asserts each sits inside body's left padding (the gutter). Exits non-zero on fail - wire into pre-commit or CI like `test/test.js`.

## Limits

- Approximates VS Code's preview, doesn't BE it. Cache problems and theme-variable resolution inside the real webview can still produce different visual results.
- Only covers what's rendered into `body` - no Properties table styling tests yet (frontmatter renders fine, but no assertions on the table).
- `pluginSourceMap` is a copy of upstream code. If VS Code ever changes how `.code-line` is added, this harness drifts until it's updated.
