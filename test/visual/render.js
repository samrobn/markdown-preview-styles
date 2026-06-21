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
const { execFileSync } = require('child_process');

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

// Populate the extension's workspace index from the fixtures directory so
// the harness can exercise wikilink resolution + transclusion paths. The
// real index is built from vscode.workspace.findFiles inside the running
// preview; here we seed it directly via the test seam.
function seedFixtureIndex() {
  const fixturesRoot = path.join(__dirname, 'fixtures');
  if (!fs.existsSync(fixturesRoot)) return;
  const index = new Map();
  const rootSortKey = fixturesRoot;
  const walk = (dir) => {
    for (const name of fs.readdirSync(dir)) {
      const abs = path.join(dir, name);
      const stat = fs.statSync(abs);
      if (stat.isDirectory()) walk(abs);
      else if (name.endsWith('.md')) ours.addToIndex(index, abs, rootSortKey);
    }
  };
  walk(fixturesRoot);
  ours.__setWikiStateForTest({ index, config: { enabled: true, embedNotes: true, embedMaxBytes: 262144 } });
}

function render(srcPath) {
  seedFixtureIndex();
  const md = new MarkdownIt({ html: true, linkify: true });
  ours.activate().extendMarkdownIt(md);
  md.use(pluginSourceMap);
  const src = fs.readFileSync(srcPath, 'utf8');
  const body = md.render(src);
  const css = fs.readFileSync(path.join(ROOT, 'style.css'), 'utf8');
  const previewJs = fs.readFileSync(path.join(ROOT, 'preview.js'), 'utf8');
  // Approximate VS Code preview defaults: dark background. style.css's own
  // body `padding-left: 5em` (applied above) gives the gutter ::before its
  // space, exactly as in the live preview - the harness adds no extra inset,
  // so the wide-content cap (`100vw - 8rem`) reserves the same room it does
  // live. The rendered HTML is wrapped in <div class="markdown-body"> as
  // VS Code does (verified in the markdown-language-features bundle) - top-
  // level blocks are children of that wrapper, NOT body, so selectors like
  // `.markdown-body > pre` are exercised faithfully. Omitting it once gave a
  // false positive on the wide-content breakout, which only matches the
  // wrapper's children.
  const html = `<!doctype html>
<html><head><meta charset="utf-8"><style>
${css}
/* Match VS Code's preview root font-size (14px). The harness used to inherit
   the browser default 16px, which silently hid bugs caused by the
   discrepancy between hard-coded pixel offsets (preview.js GUTTER_TARGET)
   and rem/em fallbacks in style.css. */
html { font-size: 14px; }
body { font-family: -apple-system, sans-serif; background: #1e1e1e; color: #ccc; }
/* Mirror VS Code's markdown.css chrome (html, body each get 0 26px padding) so
   the harness reproduces the live left inset, which the wide-content cap must
   clear: html padding-left (26px) + the default body margin (8px, never reset)
   + our body padding-left (5em gutter) = ~104px. Our style.css overrides body's
   left padding to 5em, so only mirror html's full padding and body's right. */
html { padding: 0 26px; }
body { padding-right: 26px; }
ul, ol { padding-inline-start: 30px; }
/* Mirror VS Code's markdown.css, which our style.css deliberately leaves to
   it: plain code blocks scroll over-cap content. (Highlighted blocks scroll on
   an inner code>div the harness doesn't build, so plain is the case we mirror.)
   Without this the harness wouldn't represent the live over-cap scroll, now
   that style.css adds no overflow of its own. */
pre:not(.hljs) { overflow: auto; }
/* Match VS Code's preview: every .code-line is position: relative so its
   ::before is contained within its own box, not the document body. */
.code-line { position: relative; }
</style></head>
<body class="vscode-dark">
<div class="markdown-body" dir="auto">
${body}
</div>
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
  results.push(sample('table.code-line:not(.mps-properties-table)', 'body table'));

  // Cross-sample consistency: every gutter sample above must land at the SAME
  // beforeX. The individual "in gutter range" checks tolerate ~70px of slop,
  // which let an 8px table shift slip through historically (preview.js skipped
  // the <table> itself, so it fell back to -5em - mismatched with GUTTER_TARGET
  // at the live preview's 14px root). Tolerance is 1px to absorb sub-pixel
  // rounding only.
  const gutterSamples = results.filter(r => r.beforeX !== undefined);
  const xs = gutterSamples.map(r => r.beforeX);
  const spread = xs.length ? Math.max(...xs) - Math.min(...xs) : 0;
  results.push({
    label: 'all gutter samples land at the same x',
    ok: spread <= 1,
    spread: Math.round(spread * 100) / 100,
    xs,
  });

  // ul/ol ::before suppression
  const ulEl = document.querySelector('ul.code-line');
  results.push({
    label: 'ul ::before display:none',
    ok: ulEl && getComputedStyle(ulEl, '::before').display === 'none',
    actual: ulEl ? getComputedStyle(ulEl, '::before').display : 'no ul.code-line',
  });

  // Callout-container ::before suppression. Callouts are rewritten from
  // blockquotes to div.mps-callout, and the container shares its source line
  // with its title row - the same duplicate-number issue as ul/ol, suppressed
  // by CSS. example.md has no plain blockquotes left (all are callouts), so we
  // assert against the container that actually carries the duplicate number.
  const calloutEl = document.querySelector('.mps-callout.code-line');
  results.push({
    label: 'callout container ::before display:none',
    ok: calloutEl && getComputedStyle(calloutEl, '::before').display === 'none',
    actual: calloutEl ? getComputedStyle(calloutEl, '::before').display : 'no .mps-callout.code-line',
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

  // Wide-content cap clears the scrollbar. A maximally-capped breakout block
  // (left edge + the resolved max-width) must leave room for the live vertical
  // scrollbar; 100vw includes the scrollbar but the usable width does not, so
  // an under-sized reserve lets a capped block poke past the viewport edge - a
  // small horizontal scroll. Needs the harness to carry VS Code's html/body
  // padding (above) for the left inset to match the live ~104px.
  const SCROLLBAR_ALLOWANCE = 15;
  const widthTable = document.querySelector('table.code-line:not(.mps-properties-table)');
  if (widthTable) {
    const leftInset = widthTable.getBoundingClientRect().left;
    const capPx = parseFloat(getComputedStyle(widthTable).maxWidth);
    const cappedRightEdge = leftInset + capPx;
    const clearance = window.innerWidth - cappedRightEdge;
    results.push({
      label: 'wide-content cap leaves room for the scrollbar',
      ok: clearance >= SCROLLBAR_ALLOWANCE,
      clearance: Math.round(clearance), need: SCROLLBAR_ALLOWANCE, leftInset: Math.round(leftInset), capPx: Math.round(capPx),
    });
  } else {
    results.push({ label: 'wide-content cap leaves room for the scrollbar', ok: false, reason: 'no body table to measure the cap on' });
  }

  // Breakout actually happens: the widest top-level table must exceed the
  // .markdown-body column. The cap-clearance check above catches a broken
  // selector (maxWidth -> 'none' -> NaN -> fails) but would still pass if
  // width:max-content were dropped - the table would then size to the
  // column and the breakout would be silently dead. (Needs example.md to keep
  // a table whose content is wider than the column - the Wide tables one.)
  const bodyTables = [...document.querySelectorAll('table.code-line:not(.mps-properties-table)')];
  const markdownBody = document.querySelector('.markdown-body');
  if (bodyTables.length && markdownBody) {
    const widest = bodyTables.reduce((a, b) => b.offsetWidth > a.offsetWidth ? b : a);
    const column = markdownBody.getBoundingClientRect().width;
    results.push({
      label: 'wide table breaks out past the column',
      ok: widest.offsetWidth > column,
      tableWidth: Math.round(widest.offsetWidth), column: Math.round(column),
    });
  } else {
    results.push({ label: 'wide table breaks out past the column', ok: false, reason: 'no body table or .markdown-body to measure' });
  }

  return JSON.stringify(results);
})()`;

// Block synchronously for `ms` without spawning a subprocess (no execSync('sleep')).
const sleepSync = (ms) => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);

function check(outPath) {
  const fileUrl = 'file://' + outPath;
  execFileSync('agent-browser', ['open', fileUrl], { stdio: 'inherit' });
  // preview.js sets --mps-before-left in the webview asynchronously (after
  // layout, on requestAnimationFrame). Measuring before it lands leaves the
  // gutter ::before on its static per-depth fallback, so the samples scatter
  // and the "same x" assertion flakes. Poll a deeply-nested .code-line until
  // the property is set before asserting.
  const readyProbe = `(() => { const el = document.querySelector('li.code-line[data-mps-list-depth="3"]'); return !!(el && el.style.getPropertyValue('--mps-before-left')); })()`;
  const deadline = Date.now() + 5000;
  while (Date.now() < deadline) {
    // A transient non-zero eval exit (e.g. the page mid-reflow) shouldn't crash
    // the run - treat it as "not ready yet" and keep polling until the deadline.
    try {
      if (execFileSync('agent-browser', ['eval', readyProbe]).toString().includes('true')) break;
    } catch (_) { /* keep polling */ }
    sleepSync(150);
  }
  // Pass the script as a single argv (execFileSync = no shell), so multi-line
  // quoting is a non-issue and we don't depend on `eval --base64`, which newer
  // agent-browser builds no longer decode. agent-browser prints the string
  // return value JSON-encoded, so the inner JSON.parse unwraps that quoting and
  // the outer one parses our results array.
  const raw = execFileSync('agent-browser', ['eval', PAGE_ASSERTIONS]).toString();
  const results = JSON.parse(JSON.parse(raw));
  let pass = 0, fail = 0;
  console.log('\nVisual assertions:');
  for (const r of results) {
    const status = r.ok ? 'PASS' : 'FAIL';
    // Different assertions surface different fields - show whichever's present.
    const detail = r.beforeX !== undefined
      ? `beforeX=${r.beforeX}, content=${r.content}`
      : r.spread !== undefined
        ? `spread=${r.spread}px, xs=[${r.xs.join(', ')}]`
        : r.actual !== undefined
        ? `actual=${r.actual}`
        : r.top !== undefined
          ? `top=${r.top}, liHeight=${r.liHeight}`
          : r.clearance !== undefined
            ? `clearance=${r.clearance}px (need >=${r.need}), leftInset=${r.leftInset}, cap=${r.capPx}`
            : r.tableWidth !== undefined
              ? `tableWidth=${r.tableWidth} > column=${r.column}`
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
