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
const hljs = require('highlight.js');
const ours = require(path.join(ROOT, 'extension.js'));

// Mirror VS Code's fence highlighting (markdown-language-features 1.127
// bundle): the engine's highlight option returns hljs.highlight(...).value
// (raw spans, no wrapper), and a renderer wrapper attrJoins class "hljs"
// onto the fence token - markdown-it renders fence-token attrs on the
// inner <code>, so live fences are <pre><code class="hljs language-x">.
// The pre itself never carries .hljs in this build, so markdown.css's
// pre:not(.hljs) padding arm styles every pre.
const vscodeHighlight = (code, lang) => {
  if (lang && hljs.getLanguage(lang)) {
    try {
      return hljs.highlight(code, { language: lang, ignoreIllegals: true }).value;
    } catch { /* fall through to markdown-it's own escaping */ }
  }
  return '';
};
const pluginFenceHljsClass = (md) => {
  const orig = md.renderer.rules.fence;
  md.renderer.rules.fence = (tokens, idx, options, env, self) => {
    const token = tokens[idx];
    if (token.map && token.map.length) token.attrJoin('class', 'hljs');
    return orig ? orig(tokens, idx, options, env, self) : self.renderToken(tokens, idx, options);
  };
};

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
  const md = new MarkdownIt({ html: true, linkify: true, highlight: vscodeHighlight });
  ours.activate().extendMarkdownIt(md);
  md.use(pluginSourceMap);
  md.use(pluginFenceHljsClass);
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
<html><head><meta charset="utf-8">
<!-- out.html lives in test/visual/, two levels below the repo root that
     style.css's relative url()s (bundled fonts, attachments/ retries)
     resolve against live (VS Code uses the stylesheet's own webview URI).
     A base href re-roots EVERY relative URL in the inlined CSS and the
     rendered body - robust against any future quote style or path shape,
     unlike the regex rewrite it replaced. example.md's deliberately-
     missing images still 404 (they exist nowhere under the root). -->
<base href="../../">
<style>
/* This chrome-mirror block deliberately precedes the style.css block:
   live, the webview defaults + markdown.css load BEFORE contributed
   previewStyles, so our stylesheet's same-specificity overrides (e.g.
   the body font) must also come later here or the cascade lies. */
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
/* Mirror VS Code's markdown.css body line-height AND the real form of the
   var: the preview emits --markdown-line-height as a UNITLESS multiplier
   (dist/extension.js: \`--markdown-line-height: \${e.lineHeight}\`, setting
   default 1.6), never a px length. Leaving the var unset here once let an
   invalid length-calc in style.css pass on the 22px fallback while being
   dropped live - set it unitless so the harness exercises what VS Code
   actually serves. */
html { --markdown-line-height: 1.6; }
/* Mirror the theme variables the live webview injects (Dark Modern values).
   Without them every var(--vscode-*) in style.css silently takes its
   fallback - links and wiki-links flattened to body-text grey in out.html
   while rendering blue live, which misreports colour fidelity. Keep this
   list in sync with the --vscode-* vars style.css consumes. */
html {
  --vscode-foreground: #cccccc;
  --vscode-descriptionForeground: rgba(204, 204, 204, 0.7);
  --vscode-textLink-foreground: #4daafc;
  --vscode-badge-background: #616161;
  --vscode-badge-foreground: #f8f8f8;
  --vscode-charts-green: #89d185;
  --vscode-editorLineNumber-foreground: #858585;
  --vscode-editorLineNumber-activeForeground: #c6c6c6;
  --vscode-editorWidget-background: #202020;
  --vscode-editorWidget-border: #454545;
  --vscode-errorForeground: #f48771;
  --vscode-textBlockQuote-background: rgba(127, 127, 127, 0.1);
  --vscode-font-family: -apple-system, BlinkMacSystemFont, sans-serif;
  --vscode-editor-font-family: Menlo, Monaco, "Courier New", monospace;
  --vscode-editor-foreground: #cccccc;
  --vscode-textCodeBlock-background: rgba(255, 255, 255, 0.04);
  --vscode-widget-border: rgba(255, 255, 255, 0.07);
  --vscode-textPreformat-foreground: #d0d0d0;
  --vscode-textPreformat-background: #3c3c3c;
}
/* Mirror the webview host's DEFAULT stylesheet (browser/pre/index.html),
   which loads before any extension CSS in every webview - it's what gives
   inline code its chip. Dark Modern values for the two tokens above. */
code {
  color: var(--vscode-textPreformat-foreground);
  background-color: var(--vscode-textPreformat-background);
  padding: 1px 3px;
  border-radius: 4px;
}
pre code { padding: 0; }
body { line-height: var(--markdown-line-height, 22px); }
ul, ol { padding-inline-start: 30px; }
/* Mirror VS Code's markdown.css code-block chrome, which our style.css
   deliberately leaves to it (padding/radius/overflow, panel background,
   editor-font code). In the 1.127 bundle the hljs class lands on the inner
   <code> (fence-token attrs), never the <pre>, so the pre:not(.hljs) arm
   styles every pre - including the over-cap scroll the width tests need. */
code {
  font-family: var(--vscode-editor-font-family, "SF Mono", Monaco, Menlo, monospace);
  font-size: 1em;
  line-height: 1.357em;
}
pre:not(.hljs),
pre.hljs code > div {
  padding: 16px;
  border-radius: 3px;
  overflow: auto;
}
pre code {
  display: inline-block;
  color: var(--vscode-editor-foreground);
  tab-size: 4;
  background: none;
}
pre {
  background-color: var(--vscode-textCodeBlock-background);
  border: 1px solid var(--vscode-widget-border);
}
/* Match VS Code's preview: every .code-line is position: relative so its
   ::before is contained within its own box, not the document body. */
.code-line { position: relative; }
</style><style>
${css}
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

  // Code-block gutter number. The <code>'s own ::before is clipped by the
  // pre's scroll box, so preview.js mirrors the source-map line onto the
  // <pre> (class mps-pre-line + data-mps-line) and CSS renders the number
  // there: one number per block, matching the code's line, anchored to the
  // top edge. The clipped inner number is suppressed outright so nothing
  // double-renders in overflow-visible contexts (live pre.hljs).
  //
  // CRITICAL: the pre must stay position: static. A positioned pre becomes
  // its own ::before's containing block, and its overflow: auto scrollport
  // then clips the number exactly like the inner one - computed styles look
  // right while nothing paints (screenshot-verified false green). Static
  // keeps the containing block (.markdown-body / an ancestor .code-line)
  // outside the scroller, so the number escapes the clip. The ::before's
  // left/top are therefore relative to that ancestor, not the pre - the
  // gutter-x below is computed against the offsetParent.
  const preEl = document.querySelector('.markdown-body > pre.mps-pre-line');
  const preInner = preEl && preEl.querySelector('.code-line[data-mps-line]');
  results.push({
    label: 'code block pre is static (a positioned pre clips its own number)',
    ok: !!(preEl && getComputedStyle(preEl).position === 'static'),
    actual: preEl ? getComputedStyle(preEl).position : 'no pre.mps-pre-line',
  });
  if (preEl && preEl.offsetParent) {
    const before = getComputedStyle(preEl, '::before');
    const cbRect = preEl.offsetParent.getBoundingClientRect();
    const bodyRect = document.body.getBoundingClientRect();
    const preRect = preEl.getBoundingClientRect();
    const beforeX = (cbRect.left - bodyRect.left) + parseFloat(before.left);
    results.push({
      label: 'code block (pre)',
      ok: beforeX >= -1 && beforeX < gutterMax,
      beforeX, gutterMax, content: before.content,
    });
    const beforeYAbs = cbRect.top + parseFloat(before.top);
    results.push({
      label: 'code block number anchored to the top edge',
      ok: Math.abs(beforeYAbs - preRect.top) < 8,
      top: Math.round((beforeYAbs - preRect.top) * 100) / 100, liHeight: preRect.height,
    });
  } else {
    results.push({ label: 'code block (pre)', ok: false, reason: 'no pre.mps-pre-line with offsetParent' });
    results.push({ label: 'code block number anchored to the top edge', ok: false, reason: 'no pre.mps-pre-line with offsetParent' });
  }
  // getComputedStyle resolves attr() - content comes back as the quoted
  // rendered string (e.g. "162"), so compare against the attribute value.
  const preContent = preEl ? getComputedStyle(preEl, '::before').content.replace(/^"|"$/g, '') : null;
  results.push({
    label: 'code block pre mirrors the fence line number',
    ok: !!(preEl && preInner &&
           preEl.getAttribute('data-mps-line') === preInner.getAttribute('data-mps-line') &&
           preContent === preEl.getAttribute('data-mps-line')),
    actual: preEl
      ? 'pre=' + preEl.getAttribute('data-mps-line') + ' inner=' + (preInner && preInner.getAttribute('data-mps-line')) + ' content=' + preContent
      : 'no pre.mps-pre-line',
  });
  results.push({
    label: 'inner code-line number suppressed inside pre',
    ok: !!(preInner && getComputedStyle(preInner, '::before').display === 'none'),
    actual: preInner ? getComputedStyle(preInner, '::before').display : 'no inner code-line',
  });

  // Indented code blocks are the OTHER pre shape: markdown-it's code_block
  // renderer puts the source-map attrs on the <pre> itself (fence puts them
  // on the inner <code>). That pre carries .code-line, so it must still be
  // static (our .code-line positioning rule excludes pres) and mirrored.
  const selfPre = document.querySelector('pre.code-line[data-mps-line]');
  if (selfPre && selfPre.offsetParent) {
    const beforeSelf = getComputedStyle(selfPre, '::before');
    const cbRectSelf = selfPre.offsetParent.getBoundingClientRect();
    const bodyRectSelf = document.body.getBoundingClientRect();
    const beforeXSelf = (cbRectSelf.left - bodyRectSelf.left) + parseFloat(beforeSelf.left);
    results.push({
      label: 'indented code block (pre.code-line)',
      ok: getComputedStyle(selfPre).position === 'static' &&
          selfPre.classList.contains('mps-pre-line') &&
          beforeXSelf >= -1 && beforeXSelf < gutterMax,
      beforeX: beforeXSelf, gutterMax,
      content: beforeSelf.content + ' pos=' + getComputedStyle(selfPre).position + ' mirrored=' + selfPre.classList.contains('mps-pre-line'),
    });
  } else {
    results.push({ label: 'indented code block (pre.code-line)', ok: false, reason: 'no pre.code-line[data-mps-line] with offsetParent' });
  }

  // Embed-wrapping paragraph number alignment. A block embed alone on its
  // source line is parser-split (a div can't nest in a p) into an EMPTY
  // p.code-line followed by the .mps-embed-note box as a sibling. The
  // zero-height paragraph still carries the line number; unfixed, its
  // centred ::before sits at the split point, crowding the preceding
  // blank-line number. It should sit on the box's first text row.
  const embedP = [...document.querySelectorAll('p.code-line')].find(p =>
    !p.textContent.trim() && p.nextElementSibling &&
    p.nextElementSibling.classList.contains('mps-embed-note'));
  if (embedP) {
    const beforeEmbed = getComputedStyle(embedP, '::before');
    const boxRect = embedP.nextElementSibling.getBoundingClientRect();
    // Measure the box's first text row directly (Range) - no line-height
    // arithmetic, which computes as 'normal' here.
    const firstText = document.createTreeWalker(embedP.nextElementSibling, NodeFilter.SHOW_TEXT).nextNode();
    const range = document.createRange();
    range.selectNodeContents(firstText);
    const rowRect = range.getClientRects()[0];
    const firstLineCentre = rowRect.top + rowRect.height / 2;
    // The pseudo's own box can't be rect-measured; reconstruct its centre
    // from top + half its line box, folding in any translateY.
    const translateY = beforeEmbed.transform.startsWith('matrix')
      ? parseFloat(beforeEmbed.transform.split(',')[5]) : 0;
    const numCentre = embedP.getBoundingClientRect().top + parseFloat(beforeEmbed.top)
      + translateY + parseFloat(beforeEmbed.lineHeight) / 2;
    results.push({
      label: 'embed-paragraph number sits on the box first text row',
      ok: Math.abs(numCentre - firstLineCentre) < 3,
      top: Math.round((numCentre - firstLineCentre) * 100) / 100,
      liHeight: Math.round(boxRect.height),
    });
  } else {
    results.push({ label: 'embed-paragraph number sits on the box first text row', ok: false, reason: 'no empty p.code-line + .mps-embed-note pair found' });
  }

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

  // Heading typography: the bundled Martian Mono must actually LOAD (a
  // computed font-family reports the specified stack whether or not the
  // woff2 resolved - fonts.check is the only load-proving signal), and the
  // heading rules must consume the custom properties (weight 300, 40px h1 /
  // 24px h2 at the 14px root; colour stays the theme default).
  const h1 = document.querySelector('.markdown-body h1');
  const h2 = document.querySelector('.markdown-body h2');
  if (h1 && h2) {
    const h1Style = getComputedStyle(h1);
    const h1Px = parseFloat(h1Style.fontSize);
    // Check family/weight on h2 as well as h1: the sizes come from
    // per-level rules, so a regression narrowing the grouped h1-h6
    // font-family/weight rule to h1 alone would otherwise pass on
    // h2's size while h2 silently fell back to the body font.
    const h2Style = getComputedStyle(h2);
    const h2Px = parseFloat(h2Style.fontSize);
    results.push({
      label: 'heading font: Martian Mono loads and applies',
      ok: document.fonts.check('300 1em "Martian Mono"') &&
          h1Style.fontFamily.includes('Martian Mono') &&
          h1Style.fontWeight === '300' &&
          h2Style.fontFamily.includes('Martian Mono') &&
          h2Style.fontWeight === '300' &&
          h1Px > 39 && h1Px < 41 &&
          h2Px > 23 && h2Px < 25 &&
          h1Style.color === getComputedStyle(document.body).color,
      actual: 'loaded=' + document.fonts.check('300 1em "Martian Mono"') +
        ' family=' + h1Style.fontFamily.split(',')[0] + '/' + h2Style.fontFamily.split(',')[0] +
        ' weight=' + h1Style.fontWeight + '/' + h2Style.fontWeight +
        ' h1=' + h1Style.fontSize + ' h2=' + h2Px + 'px color=' + h1Style.color,
    });
  } else {
    results.push({ label: 'heading font: Martian Mono loads and applies', ok: false, reason: 'no h1/h2 in .markdown-body' });
  }

  // Body prose font: Quattro must load and win the cascade over the
  // chrome-mirror's body rule (style.css loads after markdown.css live -
  // the harness mirrors that order; a regression here means the blocks
  // got reordered).
  const bodyFamily = getComputedStyle(document.body).fontFamily;
  results.push({
    label: 'body font: iA Writer Quattro loads and applies',
    ok: document.fonts.check('1em "iA Writer Quattro"') &&
        bodyFamily.includes('iA Writer Quattro'),
    actual: 'loaded=' + document.fonts.check('1em "iA Writer Quattro"') +
      ' family=' + bodyFamily.split(',')[0],
  });

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
  // Ready = the first align pass has run AND the measurement is stable: the
  // pre top var must match a fresh geometry read, since early passes measure
  // mid-settle (fonts loading, broken-image placeholders swapping in) and
  // the observer only converges it on the following frames.
  const readyProbe = `(() => {
    // The typography assertion needs the bundled woff2 resolved, and early
    // gutter passes measure mid-font-swap anyway - wait for all font loads.
    if (document.fonts.status !== 'loaded') return false;
    const li = document.querySelector('li.code-line[data-mps-list-depth="3"]');
    if (!li || !li.style.getPropertyValue('--mps-before-left')) return false;
    const pre = document.querySelector('.markdown-body > pre.mps-pre-line');
    if (!pre) return true; // no code block to wait for
    const cb = pre.offsetParent;
    if (!cb) return false;
    const measured = parseFloat(pre.style.getPropertyValue('--mps-pre-top'));
    const actual = pre.getBoundingClientRect().top - cb.getBoundingClientRect().top;
    return Math.abs(measured - actual) < 1;
  })()`;
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
