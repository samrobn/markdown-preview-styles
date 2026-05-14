#!/usr/bin/env node
// Visual verification harness for the markdown preview.
//
// VS Code's preview is the only place the real CSS/DOM combination runs,
// but it's a closed webview - we can't connect agent-browser to it. This
// script reproduces the rendering pipeline locally so we CAN inspect it:
//
//   - real markdown-it (test-only dev dep)
//   - our extension.js plugin
//   - VS Code's pluginSourceMap copied verbatim from microsoft/vscode
//     extensions/markdown-language-features/src/markdownEngine.ts
//
// Result: a faithful approximation of VS Code's preview DOM, openable
// in any browser. Useful for diagnosing whether a styling problem is in
// the extension itself or in VS Code's caching/loading behaviour.
//
// Usage:
//   npm install --prefix test/visual    # one-time
//   node test/visual/render.js          # writes test/visual/out.html
//   node test/visual/render.js check    # also runs computed-style assertions
//                                       # via agent-browser (must be installed)

const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');

const ROOT = path.resolve(__dirname, '..', '..');
const MarkdownIt = require('markdown-it');
const ours = require(path.join(ROOT, 'extension.js'));

// Copied verbatim from microsoft/vscode markdownEngine.ts (MIT-licensed).
// Keep in sync with upstream if VS Code's source-map plugin evolves.
const pluginSourceMap = (md) => {
  md.core.ruler.push('source_map_data_attribute', (state) => {
    for (const token of state.tokens) {
      if (token.map && token.type !== 'inline') {
        token.attrSet('data-line', String(token.map[0]));
        token.attrJoin('class', 'code-line');
        token.attrJoin('dir', 'auto');
      }
    }
  });
  const orig = md.renderer.rules['html_block'];
  if (orig) {
    md.renderer.rules['html_block'] = (tokens, idx, options, env, self) => (
      `<div ${self.renderAttrs(tokens[idx])} ></div>\n` + orig(tokens, idx, options, env, self)
    );
  }
};

function render(srcPath) {
  const md = new MarkdownIt({ html: true, linkify: true });
  ours.activate().extendMarkdownIt(md);
  md.use(pluginSourceMap);
  const src = fs.readFileSync(srcPath, 'utf8');
  const body = md.render(src);
  const css = fs.readFileSync(path.join(ROOT, 'style.css'), 'utf8');
  const previewJs = fs.readFileSync(path.join(ROOT, 'preview.js'), 'utf8');
  // Approximate VS Code preview defaults: dark background, sensible body
  // padding so absolute-positioned gutter ::before's aren't clipped at x=0.
  const html = `<!doctype html>
<html><head><meta charset="utf-8"><style>
${css}
body { font-family: -apple-system, sans-serif; background: #1e1e1e; color: #ccc; margin-left: 6em; }
ul, ol { padding-inline-start: 30px; }
/* Match VS Code's preview: every .code-line is position: relative so its
   ::before is contained within its own box, not the document body. */
.code-line { position: relative; }
</style></head>
<body class="vscode-dark">
${body}
<script>${previewJs}</script>
</body></html>`;
  const out = path.join(__dirname, 'out.html');
  fs.writeFileSync(out, html);
  return out;
}

// Assertions executed inside the page via agent-browser eval.
// 1) Gutter line numbers land inside body's left padding at every depth.
// 2) <ul>/<ol> ::before is suppressed (duplicate-number prevention).
// 3) A parent <li> containing a nested .code-line anchors its ::before
//    to the top of its own row, not the centre of the whole tall box.
const PAGE_ASSERTIONS = `(() => {
  const results = [];
  const gutterMax = parseFloat(getComputedStyle(document.body).paddingLeft);
  const sample = (sel, label) => {
    const el = document.querySelector(sel);
    if (!el) return { label, ok: false, reason: 'no element matching ' + sel };
    const before = getComputedStyle(el, '::before');
    const elRect = el.getBoundingClientRect();
    const bodyRect = document.body.getBoundingClientRect();
    const beforeX = (elRect.left - bodyRect.left) + parseFloat(before.left);
    const inGutter = beforeX >= -1 && beforeX < gutterMax;
    return { label, ok: inGutter, beforeX, gutterMax, content: before.content };
  };
  results.push(sample('p.code-line', 'top-level paragraph'));
  results.push(sample('li.code-line[data-mps-list-depth="1"]', 'top-level li'));
  results.push(sample('li.code-line[data-mps-list-depth="2"]', 'nested li'));
  results.push(sample('li.code-line[data-mps-list-depth="3"]', 'doubly-nested li'));

  // ul/ol ::before suppression
  const ulEl = document.querySelector('ul.code-line');
  results.push({
    label: 'ul ::before display:none',
    ok: ulEl && getComputedStyle(ulEl, '::before').display === 'none',
    actual: ulEl ? getComputedStyle(ulEl, '::before').display : 'no ul.code-line',
  });

  // blockquote ::before suppression (callout container shares its line with
  // its first <p> child, same duplicate-number issue as ul/ol).
  const bqEl = document.querySelector('blockquote.code-line');
  results.push({
    label: 'blockquote ::before display:none',
    ok: bqEl && getComputedStyle(bqEl, '::before').display === 'none',
    actual: bqEl ? getComputedStyle(bqEl, '::before').display : 'no blockquote.code-line',
  });

  // Parent <li> with nested .code-line should NOT have ::before vertically
  // centred. Top value should not be 50%/half-the-height; anchored to top
  // means the resolved 'top' is small (a few px / 0.3em).
  const parentLi = document.querySelector('li.code-line:has(.code-line)');
  if (parentLi) {
    const top = parseFloat(getComputedStyle(parentLi, '::before').top);
    const liHeight = parentLi.getBoundingClientRect().height;
    // If anchored top, top is small relative to li height (well under 25%).
    // If centred, top is roughly half the li's height.
    const isAnchoredTop = top < liHeight * 0.25;
    results.push({
      label: 'parent-li ::before anchored to top',
      ok: isAnchoredTop,
      top, liHeight,
    });
  } else {
    results.push({ label: 'parent-li ::before anchored to top', ok: false, reason: 'no parent li.code-line with nested .code-line found' });
  }

  return JSON.stringify(results);
})()`;

function check(outPath) {
  const fileUrl = 'file://' + outPath;
  execSync(`agent-browser open ${JSON.stringify(fileUrl)}`, { stdio: 'inherit' });
  // Base64 transport avoids shell-escaping issues with multi-line scripts.
  const b64 = Buffer.from(PAGE_ASSERTIONS).toString('base64');
  const raw = execSync(`agent-browser eval --base64 ${b64}`).toString();
  const results = JSON.parse(JSON.parse(raw));
  let pass = 0, fail = 0;
  console.log('\nVisual assertions:');
  for (const r of results) {
    const status = r.ok ? 'PASS' : 'FAIL';
    // Different assertions surface different fields - show whichever's present.
    const detail = r.beforeX !== undefined
      ? `beforeX=${r.beforeX}, content=${r.content}`
      : r.actual !== undefined
        ? `actual=${r.actual}`
        : r.top !== undefined
          ? `top=${r.top}, liHeight=${r.liHeight}`
          : (r.reason || '');
    console.log(`  ${status}  ${r.label}: ${detail}`);
    r.ok ? pass++ : fail++;
  }
  console.log(`\n${pass} pass, ${fail} fail`);
  return fail === 0;
}

const example = path.join(ROOT, 'example.md');
const out = render(example);
console.log('Rendered ' + out);
if (process.argv[2] === 'check') {
  const ok = check(out);
  process.exit(ok ? 0 : 1);
}
