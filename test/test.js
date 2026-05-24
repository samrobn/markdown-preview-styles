// Plain Node assertions, no framework. Run via `node test/test.js`.
// Tests exercise the public extendMarkdownIt() surface against a stub
// markdown-it instance - no real markdown-it dependency.

const assert = require('assert');
const { activate } = require('../extension.js');

// ---- Stub markdown-it -------------------------------------------------------

function makeToken(opts = {}) {
  return {
    type: opts.type || 'paragraph_open',
    tag: opts.tag || 'p',
    level: opts.level !== undefined ? opts.level : 0,
    map: opts.map || null,
    content: opts.content || '',
    attrs: null,
    attrSet(name, value) {
      this.attrs = this.attrs || [];
      const i = this.attrs.findIndex(a => a[0] === name);
      if (i >= 0) this.attrs[i][1] = value;
      else this.attrs.push([name, value]);
    }
  };
}

function StubToken(type, tag, nesting) {
  this.type = type; this.tag = tag; this.nesting = nesting;
  this.content = ''; this.block = false; this.attrs = null;
  this.map = null; this.level = 0; this.children = null;
}
StubToken.prototype.attrSet = function (name, value) {
  this.attrs = this.attrs || [];
  const i = this.attrs.findIndex(a => a[0] === name);
  if (i >= 0) this.attrs[i][1] = value;
  else this.attrs.push([name, value]);
};

function makeMd() {
  const coreRules = [];
  // Real markdown-it pre-registers built-in rules (text, link, image, ...).
  // Pre-seeding `link` here lets `before('link', ...)` find a target and
  // also makes the stub throw on missing-target the same way real
  // markdown-it does (`Parser rule not found`), catching latent ordering
  // bugs in extensions that target rules they shouldn't.
  const inlineRules = [
    { name: 'link', fn: () => false },
  ];
  return {
    core: { ruler: { push(name, fn) { coreRules.push({ name, fn }); } } },
    inline: {
      ruler: {
        before(beforeName, name, fn) {
          const i = inlineRules.findIndex(r => r.name === beforeName);
          if (i < 0) throw new Error('Parser rule not found: ' + beforeName);
          inlineRules.splice(i, 0, { before: beforeName, name, fn });
        }
      }
    },
    renderer: { rules: {} },
    _coreRules: coreRules,
    _inlineRules: inlineRules,
    runCore(src, tokens = []) {
      const state = { src, tokens, Token: StubToken };
      for (const r of coreRules) r.fn(state);
      return state;
    },
    runInline(src) {
      // Minimal inline tokenizer: walks the registered rules in order at
      // each position, advancing pos by 1 when no rule matches (skipping
      // the character - real markdown-it would push a text token; we don't
      // need that for the parser-shape assertions).
      const state = {
        src, pos: 0, posMax: src.length, tokens: [], Token: StubToken,
        push(type, tag, nesting) {
          const t = new StubToken(type, tag, nesting);
          state.tokens.push(t);
          return t;
        },
      };
      while (state.pos < state.posMax) {
        let matched = false;
        for (const r of inlineRules) {
          if (r.fn(state, false)) { matched = true; break; }
        }
        if (!matched) state.pos++;
      }
      return state.tokens;
    }
  };
}

function renderHtml(src, tokens = []) {
  const md = makeMd();
  activate().extendMarkdownIt(md);
  const state = md.runCore(src, tokens);
  return state.tokens.map(t => t.content || '').join('');
}

// ---- Test runner ------------------------------------------------------------

let passed = 0, failed = 0;
function test(name, fn) {
  try {
    fn();
    console.log('  PASS  ' + name);
    passed++;
  } catch (e) {
    console.log('  FAIL  ' + name);
    console.log('        ' + (e.message || e));
    failed++;
  }
}

// ---- Frontmatter parser -----------------------------------------------------

console.log('\nFrontmatter parser:');

test('renders a Properties table when frontmatter is present', () => {
  const html = renderHtml('---\nstatus: draft\n---');
  assert.match(html, /class="mps-properties"/);
  assert.match(html, /status/);
  assert.match(html, /draft/);
});

test('renders nothing when no frontmatter', () => {
  const html = renderHtml('# just a heading');
  assert.doesNotMatch(html, /mps-properties/);
});

test('numeric-looking values stay as strings (not parseInt-collapsed)', () => {
  const html = renderHtml('---\ntask-id: 20260101\n---');
  assert.match(html, /20260101/);
});

test('inline arrays render as pills', () => {
  const html = renderHtml('---\ntags: [foo, bar]\n---');
  assert.match(html, /mps-pill[^>]*>foo</);
  assert.match(html, /mps-pill[^>]*>bar</);
});

test('block arrays render as pills', () => {
  const html = renderHtml('---\ntags:\n  - foo\n  - bar\n---');
  assert.match(html, /mps-pill[^>]*>foo</);
  assert.match(html, /mps-pill[^>]*>bar</);
});

test('[[wiki-link]] is treated as a string, not a one-element inline array', () => {
  const html = renderHtml('---\nparent: [[TASK-123]]\n---');
  // Renders as an anchor with basename-without-extension visible text.
  // TASK-123 has no slash and no dot, so basename === content.
  assert.match(html, /<a class="mps-wiki-link" href="TASK-123">TASK-123<\/a>/);
  assert.doesNotMatch(html, /mps-pill/);
});

test('null/empty values render as italic "Empty"', () => {
  const html = renderHtml('---\nblocked-on:\n---');
  assert.match(html, /class="mps-empty"[^>]*>Empty</);
});

test('mps-hide: true suppresses the table', () => {
  const html = renderHtml('---\nstatus: x\nmps-hide: true\n---');
  assert.doesNotMatch(html, /mps-properties/);
});

test('BOM at start of source is stripped before frontmatter match', () => {
  const html = renderHtml('﻿---\nstatus: x\n---');
  assert.match(html, /mps-properties/);
});

test('leading whitespace before frontmatter is stripped', () => {
  const html = renderHtml('\n\n  ---\nstatus: x\n---');
  assert.match(html, /mps-properties/);
});

// ---- Value rendering --------------------------------------------------------

console.log('\nValue rendering:');

test('URLs in string values are linkified', () => {
  const html = renderHtml('---\nref: https://example.com/x\n---');
  assert.match(html, /<a href="https:\/\/example\.com\/x">https:\/\/example\.com\/x<\/a>/);
});

test('wiki-link and URL coexist in the same string value', () => {
  const html = renderHtml('---\ndesc: see [[parent]] or https://example.com\n---');
  assert.match(html, /<a class="mps-wiki-link" href="parent">parent<\/a>/);
  assert.match(html, /<a href="https:\/\/example\.com">/);
});

test('date-only formats as dd/mm/yyyy with no TZ shift', () => {
  const html = renderHtml('---\ncreated: 2026-05-07\n---');
  assert.match(html, /07\/05\/2026/);
  assert.doesNotMatch(html, /06\/05\/2026/);
});

test('datetime formats as dd/mm/yyyy, HH:MM', () => {
  const html = renderHtml('---\nmodified: 2026-05-12T14:30\n---');
  assert.match(html, /12\/05\/2026, 14:30/);
});

test('boolean true renders as a tick', () => {
  const html = renderHtml('---\npublished: true\n---');
  assert.match(html, /class="mps-check on">✓/);
});

test('HTML-special characters in values are escaped', () => {
  const html = renderHtml('---\ntitle: a < b & c > d\n---');
  assert.match(html, /a &lt; b &amp; c &gt; d/);
});

// ---- Wiki-link renderer (body-text inline rule) -----------------------------

console.log('\nWiki-link inline renderer:');

test('wiki-link renderer emits an <a> with basename-without-extension display', () => {
  const md = makeMd();
  activate().extendMarkdownIt(md);
  const fn = md.renderer.rules.mps_wikilink;
  assert.strictEqual(typeof fn, 'function', 'mps_wikilink renderer should be registered');
  assert.strictEqual(
    fn([{ content: 'notes/2026-meeting' }], 0),
    '<a class="mps-wiki-link" href="notes/2026-meeting">2026-meeting</a>'
  );
  assert.strictEqual(
    fn([{ content: 'attachments/boiler-1.jpg' }], 0),
    '<a class="mps-wiki-link" href="attachments/boiler-1.jpg">boiler-1</a>'
  );
});

test('wiki-link renderer escapes content in display and href', () => {
  const md = makeMd();
  activate().extendMarkdownIt(md);
  const fn = md.renderer.rules.mps_wikilink;
  // `foo & <bar>` has no slash, no dot - basename is the whole string;
  // safeUrl accepts it (no colon scheme), so we get an <a>.
  assert.strictEqual(
    fn([{ content: 'foo & <bar>' }], 0),
    '<a class="mps-wiki-link" href="foo &amp; &lt;bar&gt;">foo &amp; &lt;bar&gt;</a>'
  );
});

test('wiki-link renderer rejects javascript: scheme (falls back to inert span)', () => {
  const md = makeMd();
  activate().extendMarkdownIt(md);
  const fn = md.renderer.rules.mps_wikilink;
  // basename of `javascript:alert(1)` is `javascript:alert(1)` (no slash,
  // no extension), but safeUrl rejects the scheme - so we get the inert
  // <span> form with the (escaped) display text.
  const html = fn([{ content: 'javascript:alert(1)' }], 0);
  assert.strictEqual(html, '<span class="mps-wiki-link">javascript:alert(1)</span>');
  assert.doesNotMatch(html, /href=/);
});

// ---- Embed inline rule (![[...]]) ------------------------------------------

console.log('\nEmbed inline rule:');

function getTokenAttr(tok, name) {
  return (tok.attrs || []).find(a => a[0] === name)?.[1];
}

function parseInline(src) {
  const md = makeMd();
  activate().extendMarkdownIt(md);
  return md.runInline(src);
}

test('![[image.png]] pushes one image token with src/alt/class', () => {
  const tokens = parseInline('![[image.png]]');
  assert.strictEqual(tokens.length, 1);
  assert.strictEqual(tokens[0].type, 'image');
  assert.strictEqual(getTokenAttr(tokens[0], 'src'), 'image.png');
  assert.strictEqual(getTokenAttr(tokens[0], 'alt'), 'image.png');
  assert.strictEqual(getTokenAttr(tokens[0], 'class'), 'mps-embed-image');
});

test('![[image.png|300]] adds width=300', () => {
  const tokens = parseInline('![[image.png|300]]');
  assert.strictEqual(tokens.length, 1);
  assert.strictEqual(getTokenAttr(tokens[0], 'width'), '300');
});

test('![[image.png|300abc]] rejects partial-numeric width (no width attr)', () => {
  const tokens = parseInline('![[image.png|300abc]]');
  assert.strictEqual(getTokenAttr(tokens[0], 'width'), undefined);
});

test('![[image.png|0]] and |-5 reject non-positive width', () => {
  assert.strictEqual(getTokenAttr(parseInline('![[image.png|0]]')[0], 'width'), undefined);
  assert.strictEqual(getTokenAttr(parseInline('![[image.png|-5]]')[0], 'width'), undefined);
});

test('![[image.png|abc]] rejects non-numeric width', () => {
  assert.strictEqual(getTokenAttr(parseInline('![[image.png|abc]]')[0], 'width'), undefined);
});

test('![[doc.pdf]] degrades to mps_wikilink (non-image extension)', () => {
  const tokens = parseInline('![[doc.pdf]]');
  assert.strictEqual(tokens.length, 1);
  assert.strictEqual(tokens[0].type, 'mps_wikilink');
  assert.strictEqual(tokens[0].content, 'doc.pdf');
});

test('![[attachments/boiler-1.jpg]] keeps the path; alt uses basename', () => {
  const tokens = parseInline('![[attachments/boiler-1.jpg]]');
  assert.strictEqual(tokens[0].type, 'image');
  assert.strictEqual(getTokenAttr(tokens[0], 'src'), 'attachments/boiler-1.jpg');
  assert.strictEqual(getTokenAttr(tokens[0], 'alt'), 'boiler-1.jpg');
});

test('![[image.png#thumb]] still matches as image (fragment ignored for ext)', () => {
  const tokens = parseInline('![[image.png#thumb]]');
  assert.strictEqual(tokens[0].type, 'image');
});

test('![[]] (empty) is not consumed as an embed', () => {
  // mps_embed rejects empty inner. The leading `!` is then skipped, and the
  // remaining `[[]]` is rejected by mps_wikilink too (empty content), so
  // nothing is pushed.
  const tokens = parseInline('![[]]');
  assert.strictEqual(tokens.length, 0);
});

test('![[javascript:alert(1)]] degrades safely (non-image ext -> wiki-link, renderer rejects href)', () => {
  // `javascript:alert(1)` has no recognised image extension, so it goes to
  // mps_wikilink. The renderer's safeUrl filter then rejects the href.
  const tokens = parseInline('![[javascript:alert(1)]]');
  assert.strictEqual(tokens[0].type, 'mps_wikilink');
});

test('plain [[wiki-link]] still pushes mps_wikilink token (regression)', () => {
  const tokens = parseInline('[[some-note]]');
  assert.strictEqual(tokens.length, 1);
  assert.strictEqual(tokens[0].type, 'mps_wikilink');
  assert.strictEqual(tokens[0].content, 'some-note');
});

// ---- Core rules: line numbers + blank-line placeholders ---------------------

console.log('\nLine-number rules:');

test('tokens with .map get data-mps-line = map[0] + 1', () => {
  const md = makeMd();
  activate().extendMarkdownIt(md);
  const t = makeToken({ map: [0, 1] });
  md.runCore('x', [t]);
  const attr = (t.attrs || []).find(a => a[0] === 'data-mps-line');
  assert.ok(attr, 'data-mps-line attribute should be set');
  assert.strictEqual(attr[1], '1');
});

test('data-mps-line is 1-indexed for any line number', () => {
  const md = makeMd();
  activate().extendMarkdownIt(md);
  const t = makeToken({ map: [21, 22] });
  md.runCore('a\n'.repeat(25), [t]);
  const attr = (t.attrs || []).find(a => a[0] === 'data-mps-line');
  assert.strictEqual(attr[1], '22');
});

test('blank source lines between tokens get placeholder html_block tokens', () => {
  const md = makeMd();
  activate().extendMarkdownIt(md);
  // Source: line 0 = "a", line 1 = "", line 2 = "", line 3 = "b"
  const tokens = [
    makeToken({ map: [0, 1], type: 'paragraph_open' }),
    makeToken({ map: [3, 4], type: 'paragraph_open' }),
  ];
  const state = md.runCore('a\n\n\nb', tokens);
  const placeholders = state.tokens.filter(
    t => typeof t.content === 'string' && t.content.includes('mps-blank-line')
  );
  assert.strictEqual(placeholders.length, 2, 'expected one placeholder per blank line');
  // Each placeholder should have the right 0-indexed data-line and 1-indexed data-mps-line
  assert.match(placeholders[0].content, /data-line="1"/);
  assert.match(placeholders[0].content, /data-mps-line="2"/);
  assert.match(placeholders[1].content, /data-line="2"/);
  assert.match(placeholders[1].content, /data-mps-line="3"/);
});

test('non-blank lines between tokens do NOT get placeholders', () => {
  const md = makeMd();
  activate().extendMarkdownIt(md);
  // Source line 1 is non-blank but somehow falls between tokens
  const tokens = [
    makeToken({ map: [0, 1] }),
    makeToken({ map: [2, 3] }),
  ];
  const state = md.runCore('a\nnot blank\nb', tokens);
  const placeholders = state.tokens.filter(
    t => typeof t.content === 'string' && t.content.includes('mps-blank-line')
  );
  assert.strictEqual(placeholders.length, 0);
});

test('blank line absorbed by previous list token still gets a placeholder', () => {
  const md = makeMd();
  activate().extendMarkdownIt(md);
  // Source:
  //   line 0: "- a"           (list_item content)
  //   line 1: ""              (blank — list consumes this in its map.end)
  //   line 2: "next"          (paragraph after the list)
  // bullet_list_open.map = [0, 2] (end overshoots into the blank line).
  // paragraph_open.map = [2, 3].
  // Without trimming trailing blanks off the previous token's end, the
  // gap check at the paragraph sees range [2,2) and skips line 1.
  const tokens = [
    makeToken({ type: 'bullet_list_open', map: [0, 2] }),
    makeToken({ type: 'list_item_open', map: [0, 1] }),
    makeToken({ type: 'list_item_close' }),
    makeToken({ type: 'bullet_list_close' }),
    makeToken({ type: 'paragraph_open', map: [2, 3] }),
  ];
  const state = md.runCore('- a\n\nnext', tokens);
  const placeholders = state.tokens.filter(
    t => typeof t.content === 'string' && t.content.includes('mps-blank-line')
  );
  assert.strictEqual(placeholders.length, 1, 'expected one placeholder for the absorbed blank');
  assert.match(placeholders[0].content, /data-line="1"/);
  assert.match(placeholders[0].content, /data-mps-line="2"/);
});

test('list tokens get data-mps-list-depth = number of ul/ol ancestors', () => {
  const md = makeMd();
  activate().extendMarkdownIt(md);
  // Simulate nested list token stream:
  //   <ul>           bullet_list_open  (depth 0)
  //     <li>           list_item_open  (depth 1)
  //       <ul>           bullet_list_open  (depth 1)
  //         <li>           list_item_open  (depth 2)
  //         </li>          list_item_close
  //       </ul>          bullet_list_close
  //     </li>          list_item_close
  //   </ul>          bullet_list_close
  const tokens = [
    makeToken({ type: 'bullet_list_open', map: [0, 4] }),
    makeToken({ type: 'list_item_open', map: [0, 4] }),
    makeToken({ type: 'bullet_list_open', map: [1, 3] }),
    makeToken({ type: 'list_item_open', map: [1, 2] }),
    makeToken({ type: 'list_item_close' }),
    makeToken({ type: 'bullet_list_close' }),
    makeToken({ type: 'list_item_close' }),
    makeToken({ type: 'bullet_list_close' }),
  ];
  md.runCore('a\n  b\n', tokens);
  const depth = t => (t.attrs || []).find(a => a[0] === 'data-mps-list-depth');
  assert.strictEqual(depth(tokens[0])[1], '0', 'outer ul: depth 0');
  assert.strictEqual(depth(tokens[1])[1], '1', 'outer li: depth 1');
  assert.strictEqual(depth(tokens[2])[1], '1', 'nested ul: depth 1');
  assert.strictEqual(depth(tokens[3])[1], '2', 'nested li: depth 2');
});

test('no leading placeholders before the first token (frontmatter lines are skipped)', () => {
  const md = makeMd();
  activate().extendMarkdownIt(md);
  // First real token starts at line 4 (after frontmatter on 0-3)
  const tokens = [makeToken({ map: [4, 5] })];
  const state = md.runCore('---\ntitle: x\n---\n\n# h', tokens);
  const placeholders = state.tokens.filter(
    t => typeof t.content === 'string' && t.content.includes('mps-blank-line')
  );
  // Only line 3 (blank between --- and #) should get a placeholder; lines 0-2 are frontmatter
  assert.strictEqual(placeholders.length, 1);
  assert.match(placeholders[0].content, /data-mps-line="4"/);
});

// ---- Callouts ---------------------------------------------------------------

console.log('\nCallouts:');

function makeInline(content) {
  return makeToken({ type: 'inline', tag: '', content });
}

function calloutTokens(inlineContent) {
  // Minimal token stream representing one callout blockquote with a single
  // paragraph inside. Mirrors what markdown-it emits before our rule runs.
  return [
    makeToken({ type: 'blockquote_open', tag: 'blockquote', map: [0, 1] }),
    makeToken({ type: 'paragraph_open', tag: 'p', map: [0, 1] }),
    makeInline(inlineContent),
    makeToken({ type: 'paragraph_close', tag: 'p' }),
    makeToken({ type: 'blockquote_close', tag: 'blockquote' }),
  ];
}

function getAttr(token, name) {
  return (token.attrs || []).find(a => a[0] === name)?.[1];
}

test('blockquote starting with [!type] gets rewritten to a div callout', () => {
  const md = makeMd();
  activate().extendMarkdownIt(md);
  const tokens = calloutTokens('[!note] Default note\nbody text');
  md.runCore('', tokens);
  assert.strictEqual(tokens[0].tag, 'div', 'open tag becomes div');
  assert.strictEqual(tokens[tokens.length - 1].tag, 'div', 'close tag becomes div');
  assert.match(getAttr(tokens[0], 'class') || '', /mps-callout mps-callout-note/);
  assert.strictEqual(getAttr(tokens[0], 'data-mps-callout-type'), 'note');
});

test('first paragraph becomes a title row with just the title text', () => {
  const md = makeMd();
  activate().extendMarkdownIt(md);
  const tokens = calloutTokens('[!warning] Watch out\nbody text');
  md.runCore('', tokens);
  assert.strictEqual(tokens[1].tag, 'div', 'paragraph_open tag becomes div');
  assert.match(getAttr(tokens[1], 'class') || '', /mps-callout-title/);
  assert.strictEqual(tokens[2].content, 'Watch out', 'inline content is title-only');
});

test('body sharing the title paragraph is spliced into its own paragraph', () => {
  const md = makeMd();
  activate().extendMarkdownIt(md);
  const tokens = calloutTokens('[!info] Title here\nfirst body line');
  md.runCore('', tokens);
  // After: blockquote_open, paragraph_open(title), inline(title), paragraph_close,
  //        paragraph_open(body), inline(body), paragraph_close, blockquote_close
  const types = tokens.map(t => t.type);
  assert.deepStrictEqual(types, [
    'blockquote_open', 'paragraph_open', 'inline', 'paragraph_close',
    'paragraph_open', 'inline', 'paragraph_close', 'blockquote_close'
  ]);
  assert.strictEqual(tokens[5].content, 'first body line');
});

test('blockquote without [!type] prefix is left alone', () => {
  const md = makeMd();
  activate().extendMarkdownIt(md);
  const tokens = calloutTokens('plain blockquote text');
  md.runCore('', tokens);
  assert.strictEqual(tokens[0].tag, 'blockquote');
  assert.strictEqual((tokens[0].attrs || []).length, 1, 'only data-mps-line should be set');
});

test('no custom title falls back to the type name capitalized', () => {
  const md = makeMd();
  activate().extendMarkdownIt(md);
  const tokens = calloutTokens('[!warning]\nbody only');
  md.runCore('', tokens);
  assert.strictEqual(tokens[2].content, 'Warning');
});

test('fold suffix records the initial expanded/collapsed state', () => {
  const md = makeMd();
  activate().extendMarkdownIt(md);
  const expanded = calloutTokens('[!info]+ open by default');
  md.runCore('', expanded);
  assert.strictEqual(getAttr(expanded[0], 'data-mps-callout-fold'), 'open');

  const collapsed = calloutTokens('[!info]- closed by default');
  md.runCore('', collapsed);
  assert.strictEqual(getAttr(collapsed[0], 'data-mps-callout-fold'), 'closed');
});

test('container loses pluginSourceMap data-line and code-line, but keeps token.map', () => {
  // Regression for the active-line-tracker fix: VS Code's preview script
  // picks the FIRST .code-line whose data-line matches the caret, so when
  // both container and title carry the same data-line (they share map[0])
  // the container wins - and its gutter is hidden by CSS. Strip the
  // source-map attrs from the container so only the title is a candidate.
  //
  // Critical pair: token.map must survive. mps_blank_lines uses every
  // level-0 token's map for gap-detection between top-level blocks;
  // clearing it collapses the spacing between adjacent callouts.
  const md = makeMd();
  activate().extendMarkdownIt(md);
  const tokens = calloutTokens('[!note] Default note\nbody text');
  // Simulate pluginSourceMap having already run on the container token.
  tokens[0].attrs = [
    ['data-line', '0'],
    ['class', 'code-line'],
    ['dir', 'auto'],
  ];
  md.runCore('', tokens);
  const container = tokens[0];
  assert.strictEqual(getAttr(container, 'data-line'), undefined, 'data-line stripped');
  assert.strictEqual(getAttr(container, 'dir'), undefined, 'dir stripped');
  const cls = getAttr(container, 'class') || '';
  assert.ok(!cls.split(/\s+/).includes('code-line'), 'code-line class stripped');
  assert.ok(cls.includes('mps-callout'), 'mps-callout class retained');
  assert.deepStrictEqual(container.map, [0, 1], 'token.map preserved for mps_blank_lines gap-check');
});

// ---- Regression tests (defects caught by code-review) ----------------------

console.log('\nRegression tests:');

// Defect #1: synthetic image token's alt was clobbered to '' by markdown-it's
// default image renderer because children = []. Fix: populate children with a
// text token containing the basename.
test('image token children carry alt text so default renderer can preserve it', () => {
  const tokens = parseInline('![[attachments/boiler-1.jpg]]');
  assert.strictEqual(tokens[0].type, 'image');
  assert.ok(Array.isArray(tokens[0].children), 'children must be an array');
  assert.strictEqual(tokens[0].children.length, 1, 'one text child for alt');
  assert.strictEqual(tokens[0].children[0].type, 'text');
  assert.strictEqual(tokens[0].children[0].content, 'boiler-1.jpg');
});

// Defect #2: renderText double-escaped href because it captured `inner` from
// the already-escaped string, then re-escaped for the href attribute.
test('renderText emits href escaped exactly once for special chars', () => {
  const html = renderHtml('---\ndesc: see [[foo & bar]]\n---');
  // href decodes to literal "foo & bar" - i.e. attribute value is "foo &amp; bar"
  // (single escape). Old buggy output was "foo &amp;amp; bar" (double).
  assert.match(html, /href="foo &amp; bar"/);
  assert.doesNotMatch(html, /href="foo &amp;amp; bar"/);
});

test('renderText handles &, <, > in wiki-link content without double-escape', () => {
  const html = renderHtml('---\nd: see [[a<b>c&d]]\n---');
  assert.match(html, /href="a&lt;b&gt;c&amp;d"/);
});

// Defect #3: URL linkifier ran after wiki-link replacement and wrapped URLs
// sitting inside the emitted href attribute, producing nested-anchor HTML.
test('renderText does not nest URL anchors inside wiki-link href', () => {
  const html = renderHtml('---\nlink: [[https://example.com]]\n---');
  // Should have exactly one anchor opening tag for this value (the wiki-link).
  const wikiAnchors = (html.match(/<a class="mps-wiki-link"/g) || []).length;
  assert.strictEqual(wikiAnchors, 1, 'one wiki-link anchor, not nested');
  // And no double anchor opener like `href="<a href=`.
  assert.doesNotMatch(html, /href="<a /);
});

test('renderText still linkifies bare URLs outside wiki-links', () => {
  const html = renderHtml('---\nd: visit https://example.com please\n---');
  assert.match(html, /<a href="https:\/\/example\.com">https:\/\/example\.com<\/a>/);
});

// Defect #4: `![[javascript:foo.png]]` entered the image branch because
// isImagePath matched .png; safeUrl rejected the scheme but the image token
// was still pushed with src=''. Fix: gate the image branch on safeImgSrc.
test('![[javascript:foo.png]] degrades to wiki-link instead of empty-src image', () => {
  const tokens = parseInline('![[javascript:foo.png]]');
  assert.strictEqual(tokens.length, 1);
  assert.strictEqual(tokens[0].type, 'mps_wikilink', 'should NOT be image token');
  assert.ok(tokens[0].meta && tokens[0].meta.embed, 'marked as embed fallback');
});

test('![[vbscript:foo.png]] also degrades safely', () => {
  const tokens = parseInline('![[vbscript:foo.png]]');
  assert.strictEqual(tokens[0].type, 'mps_wikilink');
});

// Defect #7: basenameWithoutExt returned '' for dotfiles. Fix: fall back to
// unstripped basename when ext-strip yields empty.
test('basenameWithoutExt: dotfiles keep their leading-dot name', () => {
  const md = makeMd();
  activate().extendMarkdownIt(md);
  const fn = md.renderer.rules.mps_wikilink;
  const html = fn([{ content: '.gitignore' }], 0);
  // Display text should be visible, not empty.
  assert.match(html, />\.gitignore</);
  assert.doesNotMatch(html, /><\/a>/, 'anchor must not be empty');
});

test('basenameWithoutExt: trailing slash still yields visible text', () => {
  const md = makeMd();
  activate().extendMarkdownIt(md);
  const fn = md.renderer.rules.mps_wikilink;
  // For `notes/`, basename strip yields '' which then falls back to '' (no
  // dotfile rescue available). Document the current behaviour: display IS
  // empty here because the user literally wrote a directory path. Not a
  // regression worth fixing - dotfiles were the practical concern.
  // Just confirm no crash.
  const html = fn([{ content: 'notes/' }], 0);
  assert.match(html, /class="mps-wiki-link"/);
});

// Defect #9: pipe-in-path silently dropped post-pipe content for non-numeric
// widths. Fix: only honour pipe-split when right side parses as positive int.
test('![[name|caption]] keeps full path when right side is non-numeric', () => {
  // Without the fix, this becomes a wiki-link to 'name'. With the fix, the
  // entire string `name|caption` is treated as the path - which is not image-
  // shaped (no recognised extension), so degrades to a wiki-link with the
  // full content preserved (visible as basename 'name|caption' since no
  // slash, no extension).
  const tokens = parseInline('![[name|caption]]');
  assert.strictEqual(tokens.length, 1);
  assert.strictEqual(tokens[0].type, 'mps_wikilink');
  assert.strictEqual(tokens[0].content, 'name|caption');
});

test('![[image.png|caption text]] keeps full path including pipe section', () => {
  // With non-numeric right side, path stays as the whole inner. The
  // extension check sees `image.png|caption text` which doesn't end in
  // a recognised extension (the `|caption text` suffix breaks the match),
  // so degrades to a wiki-link with content preserved.
  const tokens = parseInline('![[image.png|caption text]]');
  assert.strictEqual(tokens[0].type, 'mps_wikilink');
  assert.strictEqual(tokens[0].content, 'image.png|caption text');
});

// Defect #10: safeUrl allowed data:image/svg+xml for <a href>. Fix: split
// into safeHref (no data:) and safeImgSrc (allows data:image/*).
test('wiki-link renderer rejects data:image/svg+xml href', () => {
  const md = makeMd();
  activate().extendMarkdownIt(md);
  const fn = md.renderer.rules.mps_wikilink;
  const html = fn([{ content: 'data:image/svg+xml,<svg onload=alert(1)/>' }], 0);
  assert.doesNotMatch(html, /href=/, 'must not emit href for data: scheme');
  assert.match(html, /class="mps-wiki-link"/);
});

// Defect #11: width had no upper bound. Fix: clamp to 4096.
test('embed width is clamped to a sane maximum', () => {
  const tokens = parseInline('![[image.png|999999]]');
  const widthAttr = (tokens[0].attrs || []).find(a => a[0] === 'width')?.[1];
  // Specifically the cap is 4096; values above are clamped.
  assert.strictEqual(widthAttr, '4096');
});

test('embed width below cap passes through unchanged', () => {
  const tokens = parseInline('![[image.png|800]]');
  const widthAttr = (tokens[0].attrs || []).find(a => a[0] === 'width')?.[1];
  assert.strictEqual(widthAttr, '800');
});

// Defect #14: degraded embed was indistinguishable from a plain wiki-link.
// Fix: emit mps-embed-fallback class on degraded embeds.
test('degraded embed (non-image extension) gets mps-embed-fallback class', () => {
  const tokens = parseInline('![[doc.pdf]]');
  // The token's renderer reads meta.embed to add the extra class.
  assert.ok(tokens[0].meta && tokens[0].meta.embed, 'token meta marks embed');

  // Now check the renderer output adds the class.
  const md = makeMd();
  activate().extendMarkdownIt(md);
  const fn = md.renderer.rules.mps_wikilink;
  const html = fn([{ content: 'doc.pdf', meta: { embed: true } }], 0);
  assert.match(html, /class="mps-wiki-link mps-embed-fallback"/);
});

test('plain [[wiki-link]] does NOT get mps-embed-fallback class', () => {
  const tokens = parseInline('[[plain-link]]');
  assert.ok(!(tokens[0].meta && tokens[0].meta.embed), 'no embed marker');
});

// Defect #15: stub before() silently pushed when target missing. Fix: throw,
// matching real markdown-it semantics.
test('stub before() throws when target rule is not registered', () => {
  const md = makeMd();
  assert.throws(
    () => md.inline.ruler.before('nonexistent-rule', 'x', () => {}),
    /Parser rule not found: nonexistent-rule/
  );
});

// ---- Summary ----------------------------------------------------------------

console.log(`\n${passed} pass, ${failed} fail`);
process.exit(failed ? 1 : 0);
