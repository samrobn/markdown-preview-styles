// Plain Node assertions, no framework. Run via `node test/test.js`.
// Tests exercise the public extendMarkdownIt() surface against a stub
// markdown-it instance - no real markdown-it dependency.

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const {
  activate,
  parseWikilinkTarget,
  resolveWikilinkTarget,
  addToIndex,
  removeFromIndex,
  __setWikiStateForTest,
  __resetWikiStateForTest,
  __rebuildWorkspaceIndexForTest,
  buildResolvedHref,
  safeHref,
  safeImgSrc,
  markChangedDocument,
  refreshStalePreviewOnTabActivation,
  refreshStalePreviewOnWindowFocus,
  flipTaskMarker,
  parseToggleDeepLink,
} = require('../extension.js');

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
    runCore(src, tokens = [], env = undefined) {
      const state = { src, tokens, Token: StubToken, env };
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

// Async tests register a thunk here; runAsyncTests() awaits them before the
// summary. Kept separate from the synchronous `test` so the bulk of the suite
// stays simple.
const asyncTests = [];
function testAsync(name, fn) {
  asyncTests.push(async () => {
    try {
      await fn();
      console.log('  PASS  ' + name);
      passed++;
    } catch (e) {
      console.log('  FAIL  ' + name);
      console.log('        ' + (e.message || e));
      failed++;
    }
  });
}
async function runAsyncTests() {
  for (const t of asyncTests) await t();
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
  // Unresolved (empty index) → document-relative raw name, unchanged behaviour.
  assert.match(html, /<a class="mps-wiki-link" href="parent">parent<\/a>/);
  assert.match(html, /<a href="https:\/\/example\.com">/);
});

// Frontmatter wikilinks resolve against the workspace index and honour alias
// syntax, the same as body wikilinks - previously they emitted a literal
// `href="name|alias"` and never resolved. (renderHtml runs with no env, so the
// resolved href takes the vscode://file form; with a render env it would be
// document-relative - covered by the body-renderer env tests.)
test('frontmatter wikilink resolves against the index (Properties value)', () => {
  __setWikiStateForTest({ index: (() => { const i = new Map(); addToIndex(i, '/root/notes/parent.md', ''); return i; })(), config: { enabled: true } });
  try {
    const html = renderHtml('---\nrelated: [[parent]]\n---');
    assert.match(html, /href="vscode:\/\/file\/root\/notes\/parent\.md"/);
    assert.match(html, />parent</);
  } finally {
    __resetWikiStateForTest();
  }
});

test('frontmatter wikilink honours alias and does not emit a literal pipe href', () => {
  __setWikiStateForTest({ index: (() => { const i = new Map(); addToIndex(i, '/root/notes/meeting.md', ''); return i; })(), config: { enabled: true } });
  try {
    const html = renderHtml('---\nparent: [[meeting|Weekly sync]]\n---');
    assert.match(html, />Weekly sync</);
    assert.doesNotMatch(html, /meeting\|Weekly sync/); // no literal pipe anywhere
    assert.match(html, /href="vscode:\/\/file\/root\/notes\/meeting\.md"/);
  } finally {
    __resetWikiStateForTest();
  }
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

test('mps_blank_lines is skipped inside a transcluded embed (no placeholders, no data-mps-line)', () => {
  const md = makeMd();
  activate().extendMarkdownIt(md);
  const tokens = [
    makeToken({ map: [0, 1], type: 'paragraph_open' }),
    makeToken({ map: [3, 4], type: 'paragraph_open' }),
  ];
  // Embedded render: env carries mpsEmbedDepth.
  const state = md.runCore('a\n\n\nb', tokens, { mpsEmbedDepth: 1 });
  const placeholders = state.tokens.filter(
    t => typeof t.content === 'string' && t.content.includes('mps-blank-line')
  );
  assert.strictEqual(placeholders.length, 0, 'no blank-line placeholders inside an embed');
  // And no data-mps-line stamped on the host-colliding tokens.
  assert.strictEqual(getTokenAttr(tokens[0], 'data-mps-line'), undefined);
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

// ---- Wikilink target parser -------------------------------------------------

console.log('\nWikilink target parser:');

test('parseWikilinkTarget: bare name', () => {
  assert.deepStrictEqual(parseWikilinkTarget('foo'), { name: 'foo', fragment: null, alias: null });
});

test('parseWikilinkTarget: name with heading fragment', () => {
  assert.deepStrictEqual(parseWikilinkTarget('foo#bar'), { name: 'foo', fragment: '#bar', alias: null });
});

test('parseWikilinkTarget: name with block fragment', () => {
  assert.deepStrictEqual(parseWikilinkTarget('foo^bar'), { name: 'foo', fragment: '^bar', alias: null });
});

test('parseWikilinkTarget: name with alias', () => {
  assert.deepStrictEqual(parseWikilinkTarget('foo|display'), { name: 'foo', fragment: null, alias: 'display' });
});

test('parseWikilinkTarget: canonical fragment-before-pipe (heading + alias)', () => {
  assert.deepStrictEqual(parseWikilinkTarget('foo#bar|display'), { name: 'foo', fragment: '#bar', alias: 'display' });
});

test('parseWikilinkTarget: canonical fragment-before-pipe (block + alias)', () => {
  assert.deepStrictEqual(parseWikilinkTarget('foo^bar|display'), { name: 'foo', fragment: '^bar', alias: 'display' });
});

test('parseWikilinkTarget: reverse-order (pipe-then-#) keeps # in alias verbatim', () => {
  // Documents the non-support: `foo|display#bar` is NOT parsed as fragment.
  // The pipe wins; everything to its right is the alias literally.
  assert.deepStrictEqual(parseWikilinkTarget('foo|display#bar'), { name: 'foo', fragment: null, alias: 'display#bar' });
});

test('parseWikilinkTarget: empty input', () => {
  assert.deepStrictEqual(parseWikilinkTarget(''), { name: '', fragment: null, alias: null });
});

test('parseWikilinkTarget: non-string returns empty parse', () => {
  assert.deepStrictEqual(parseWikilinkTarget(null), { name: '', fragment: null, alias: null });
  assert.deepStrictEqual(parseWikilinkTarget(undefined), { name: '', fragment: null, alias: null });
});

// #6: a ^block fragment is only recognised when the id matches the canonical
// block-id charset ([A-Za-z0-9_-]). A space or dot means it's NOT a valid
// block ref, so it's left in the name rather than half-parsed into an id the
// anchor can never match.
test('parseWikilinkTarget: ^block with a space is not a block fragment', () => {
  assert.deepStrictEqual(parseWikilinkTarget('note^a b'), { name: 'note^a b', fragment: null, alias: null });
});

test('parseWikilinkTarget: ^block with a dot is not a block fragment', () => {
  assert.deepStrictEqual(parseWikilinkTarget('note^v1.2'), { name: 'note^v1.2', fragment: null, alias: null });
});

test('parseWikilinkTarget: ^block with valid id chars is a block fragment', () => {
  assert.deepStrictEqual(parseWikilinkTarget('note^blk_1-a'), { name: 'note', fragment: '^blk_1-a', alias: null });
});

// #8: a pure-fragment target ([[#heading]] / [[^block]]) has an empty name -
// a same-document link, the way Obsidian treats it.
test('parseWikilinkTarget: pure heading fragment has empty name', () => {
  assert.deepStrictEqual(parseWikilinkTarget('#Section A'), { name: '', fragment: '#Section A', alias: null });
});

test('parseWikilinkTarget: pure block fragment has empty name', () => {
  assert.deepStrictEqual(parseWikilinkTarget('^blk1'), { name: '', fragment: '^blk1', alias: null });
});

// #5: fragmentToAnchor's heading slug matches VS Code's GithubSlugifier, so
// the href anchor lines up with the rendered heading id - including Unicode
// letters (kept) and consecutive whitespace (each char → a hyphen).
test('mps_wikilink heading anchor keeps Unicode letters (GitHub slug parity)', () => {
  withIndex([{ absPath: '/root/notes/note.md' }], () => {
    const md = makeMd();
    activate({ subscriptions: [] }).extendMarkdownIt(md);
    const tokens = md.runInline('[[note#Café]]');
    const env = { currentDocument: { fsPath: '/root/docs/cur.md' } };
    const html = md.renderer.rules.mps_wikilink(tokens, 0, {}, env);
    // café, not caf - the é is preserved so the anchor matches the rendered
    // heading id (which VS Code/GitHub also slugs to literal "café").
    assert.match(html, /#café"/);
  });
});

test('mps_wikilink heading anchor replaces each whitespace char (a  b -> a--b)', () => {
  withIndex([{ absPath: '/root/notes/note.md' }], () => {
    const md = makeMd();
    activate({ subscriptions: [] }).extendMarkdownIt(md);
    const tokens = md.runInline('[[note#A  B]]'); // two spaces
    const env = { currentDocument: { fsPath: '/root/docs/cur.md' } };
    const html = md.renderer.rules.mps_wikilink(tokens, 0, {}, env);
    assert.match(html, /#a--b"/);
  });
});

// ---- Wikilink resolver ------------------------------------------------------

console.log('\nWikilink resolver:');

// Helper: build a test index from a list of {absPath, rootSortKey} entries.
function makeIndex(entries) {
  const idx = new Map();
  const { addToIndex } = require('../extension.js');
  for (const e of entries) addToIndex(idx, e.absPath, e.rootSortKey || '');
  return idx;
}

test('resolveWikilinkTarget: hit on single match', () => {
  const idx = makeIndex([{ absPath: '/root/notes/foo.md' }]);
  assert.strictEqual(resolveWikilinkTarget('foo', idx), '/root/notes/foo.md');
});

test('resolveWikilinkTarget: miss returns null', () => {
  const idx = makeIndex([{ absPath: '/root/notes/foo.md' }]);
  assert.strictEqual(resolveWikilinkTarget('bar', idx), null);
});

test('resolveWikilinkTarget: case-insensitive on basename', () => {
  const idx = makeIndex([{ absPath: '/root/Notes/Foo.md' }]);
  assert.strictEqual(resolveWikilinkTarget('foo', idx), '/root/Notes/Foo.md');
  assert.strictEqual(resolveWikilinkTarget('FOO', idx), '/root/Notes/Foo.md');
  assert.strictEqual(resolveWikilinkTarget('FoO', idx), '/root/Notes/Foo.md');
});

test('resolveWikilinkTarget: shortest-path tiebreak within single root', () => {
  const idx = makeIndex([
    { absPath: '/root/a/b/c/foo.md' },
    { absPath: '/root/foo.md' },
    { absPath: '/root/a/foo.md' },
  ]);
  assert.strictEqual(resolveWikilinkTarget('foo', idx), '/root/foo.md');
});

test('resolveWikilinkTarget: alphabetical tiebreak when paths are same depth', () => {
  const idx = makeIndex([
    { absPath: '/root/zeta/foo.md' },
    { absPath: '/root/alpha/foo.md' },
    { absPath: '/root/beta/foo.md' },
  ]);
  assert.strictEqual(resolveWikilinkTarget('foo', idx), '/root/alpha/foo.md');
});

test('resolveWikilinkTarget: tolerates trailing .md in the wikilink', () => {
  const idx = makeIndex([{ absPath: '/root/foo.md' }]);
  assert.strictEqual(resolveWikilinkTarget('foo.md', idx), '/root/foo.md');
});

test('resolveWikilinkTarget: tolerates folder prefix in the wikilink', () => {
  // `[[some/foo]]` is the Foam/Dendron path-prefix form. We resolve by
  // basename only - the prefix is hint, not constraint.
  const idx = makeIndex([{ absPath: '/root/notes/foo.md' }]);
  assert.strictEqual(resolveWikilinkTarget('some/foo', idx), '/root/notes/foo.md');
});

test('resolveWikilinkTarget: empty target returns null', () => {
  const idx = makeIndex([{ absPath: '/root/foo.md' }]);
  assert.strictEqual(resolveWikilinkTarget('', idx), null);
});

test('resolveWikilinkTarget: cross-root ordering by rootSortKey then path', () => {
  // Two roots: /a/ comes before /z/ alphabetically. Both contain foo.md.
  // /a/deep/nested/foo.md should still beat /z/foo.md because rootSortKey
  // dominates - shortest-path only matters within one root.
  const idx = makeIndex([
    { absPath: '/z/foo.md', rootSortKey: '/z' },
    { absPath: '/a/deep/nested/foo.md', rootSortKey: '/a' },
  ]);
  assert.strictEqual(resolveWikilinkTarget('foo', idx), '/a/deep/nested/foo.md');
});

// ---- Index machinery --------------------------------------------------------

console.log('\nIndex add/remove:');

test('addToIndex stores by lowercase basename', () => {
  const { addToIndex } = require('../extension.js');
  const idx = new Map();
  addToIndex(idx, '/root/Foo.md', '');
  assert.ok(idx.has('foo'));
  assert.ok(!idx.has('Foo'));
});

test('addToIndex deduplicates the same absPath', () => {
  const { addToIndex } = require('../extension.js');
  const idx = new Map();
  addToIndex(idx, '/root/foo.md', '');
  addToIndex(idx, '/root/foo.md', '');
  assert.strictEqual(idx.get('foo').length, 1);
});

test('removeFromIndex drops the entry and the bucket when empty', () => {
  const { addToIndex, removeFromIndex } = require('../extension.js');
  const idx = new Map();
  addToIndex(idx, '/root/foo.md', '');
  removeFromIndex(idx, '/root/foo.md');
  assert.strictEqual(idx.has('foo'), false);
});

test('removeFromIndex preserves other entries in the same bucket', () => {
  const { addToIndex, removeFromIndex } = require('../extension.js');
  const idx = new Map();
  addToIndex(idx, '/root/a/foo.md', '');
  addToIndex(idx, '/root/b/foo.md', '');
  removeFromIndex(idx, '/root/a/foo.md');
  assert.strictEqual(idx.get('foo').length, 1);
  assert.strictEqual(idx.get('foo')[0].absPath, '/root/b/foo.md');
});

// ---- mps_wikilink with workspace resolution ---------------------------------

console.log('\nWiki-link rule with workspace resolution:');

function withIndex(entries, fn) {
  const idx = new Map();
  for (const e of entries) addToIndex(idx, e.absPath, e.rootSortKey || '');
  __setWikiStateForTest({ index: idx, config: { enabled: true } });
  try {
    return fn();
  } finally {
    __resetWikiStateForTest();
  }
}

test('mps_wikilink rule resolves [[name]] against the index and emits resolved href', () => {
  withIndex([{ absPath: '/root/notes/foo.md' }], () => {
    const md = makeMd();
    activate({ subscriptions: [] }).extendMarkdownIt(md);
    const tokens = md.runInline('[[foo]]');
    assert.strictEqual(tokens.length, 1);
    assert.strictEqual(tokens[0].type, 'mps_wikilink');
    assert.ok(tokens[0].meta, 'token has meta');
    assert.strictEqual(tokens[0].meta.resolvedPath, '/root/notes/foo.md');
  });
});

// VS Code's preview passes env.currentDocument as a vscode.Uri (verified
// against the 1.122 bundle: `currentDocument: typeof e == "string" ? void 0
// : e.uri`). A Uri exposes `.fsPath` directly - it has NO `.uri` property.
// When the previewed document's path is known, the renderer must emit a
// path RELATIVE to that document, schemeless, so VS Code's webview click
// handler posts an `openLink` message (native in-preview navigation, no OS
// prompt) instead of falling back to the `vscode://file/...` URI (which
// triggers an OS prompt and opens the raw editor).
test('mps_wikilink renderer emits a document-relative href when currentDocument is a Uri (fsPath)', () => {
  withIndex([{ absPath: '/root/notes/foo.md' }], () => {
    const md = makeMd();
    activate({ subscriptions: [] }).extendMarkdownIt(md);
    const tokens = md.runInline('[[foo]]');
    // Uri shape: .fsPath present, NO .uri. This is the live VS Code env.
    const env = { currentDocument: { fsPath: '/root/docs/current.md' } };
    const html = md.renderer.rules.mps_wikilink(tokens, 0, {}, env);
    // Relative from /root/docs to /root/notes/foo.md is ../notes/foo.md.
    assert.match(html, /href="\.\.\/notes\/foo\.md"/);
    // Crucially NOT the vscode:// fallback - that's the OS-prompt path.
    assert.doesNotMatch(html, /vscode:/);
  });
});

// Older builds / a future shape change may pass a TextDocument (with .uri.fsPath).
// The renderer tolerates both so the relative-path behaviour survives either way.
test('mps_wikilink renderer also reads currentDocument.uri.fsPath (TextDocument shape)', () => {
  withIndex([{ absPath: '/root/notes/foo.md' }], () => {
    const md = makeMd();
    activate({ subscriptions: [] }).extendMarkdownIt(md);
    const tokens = md.runInline('[[foo]]');
    const env = { currentDocument: { uri: { fsPath: '/root/docs/current.md' } } };
    const html = md.renderer.rules.mps_wikilink(tokens, 0, {}, env);
    assert.match(html, /href="\.\.\/notes\/foo\.md"/);
    assert.doesNotMatch(html, /vscode:/);
  });
});

// A heading fragment must ride along on the relative href so the embedded
// anchor still scrolls to the right place after navigation.
test('mps_wikilink renderer appends fragment to the document-relative href', () => {
  withIndex([{ absPath: '/root/notes/foo.md' }], () => {
    const md = makeMd();
    activate({ subscriptions: [] }).extendMarkdownIt(md);
    const tokens = md.runInline('[[foo#Section A]]');
    const env = { currentDocument: { fsPath: '/root/docs/current.md' } };
    const html = md.renderer.rules.mps_wikilink(tokens, 0, {}, env);
    assert.match(html, /href="\.\.\/notes\/foo\.md#section-a"/);
    assert.doesNotMatch(html, /vscode:/);
  });
});

// The incremental live-edit path (typing into a preview-to-the-side) calls
// VS Code's MarkdownEngine.render with the document TEXT (a string), so
// env.currentDocument is undefined. env.resourceProvider (the MarkdownPreview
// instance, passed on every render path) exposes `.resource` - the previewed
// document's Uri - so docPath survives. Without this, the relative href
// reverted to the vscode://file fallback after every keystroke.
test('mps_wikilink renderer reads env.resourceProvider.resource when currentDocument is absent (incremental edit path)', () => {
  withIndex([{ absPath: '/root/notes/foo.md' }], () => {
    const md = makeMd();
    activate({ subscriptions: [] }).extendMarkdownIt(md);
    const tokens = md.runInline('[[foo]]');
    // Incremental render env: no currentDocument, resourceProvider has .resource.
    const env = { resourceProvider: { resource: { fsPath: '/root/docs/current.md' } } };
    const html = md.renderer.rules.mps_wikilink(tokens, 0, {}, env);
    assert.match(html, /href="\.\.\/notes\/foo\.md"/);
    assert.doesNotMatch(html, /vscode:/);
  });
});

// currentDocument wins over resourceProvider when both are present (full
// render path) - they agree in practice, but pin the precedence.
test('mps_wikilink renderer prefers currentDocument over resourceProvider when both present', () => {
  withIndex([{ absPath: '/root/notes/foo.md' }], () => {
    const md = makeMd();
    activate({ subscriptions: [] }).extendMarkdownIt(md);
    const tokens = md.runInline('[[foo]]');
    const env = {
      currentDocument: { fsPath: '/root/docs/current.md' },
      resourceProvider: { resource: { fsPath: '/elsewhere/other.md' } },
    };
    const html = md.renderer.rules.mps_wikilink(tokens, 0, {}, env);
    // Relative from /root/docs (currentDocument), not /elsewhere.
    assert.match(html, /href="\.\.\/notes\/foo\.md"/);
  });
});

// No docPath available from ANY source (truly empty env) → fall back to the
// vscode://file URI so the link still works cross-path, just with the
// OS-prompt friction.
test('mps_wikilink renderer falls back to vscode://file when no docPath in env', () => {
  withIndex([{ absPath: '/root/notes/foo.md' }], () => {
    const md = makeMd();
    activate({ subscriptions: [] }).extendMarkdownIt(md);
    const tokens = md.runInline('[[foo]]');
    const html = md.renderer.rules.mps_wikilink(tokens, 0, {}, {});
    assert.match(html, /href="vscode:\/\/file\/root\/notes\/foo\.md"/);
  });
});

test('mps_wikilink rule renders [[name|alias]] with alias as display text', () => {
  withIndex([{ absPath: '/root/foo.md' }], () => {
    const md = makeMd();
    activate({ subscriptions: [] }).extendMarkdownIt(md);
    const tokens = md.runInline('[[foo|My display]]');
    const html = md.renderer.rules.mps_wikilink(tokens, 0);
    assert.match(html, />My display</);
    assert.match(html, /href="[^"]*foo\.md"/);
  });
});

test('mps_wikilink rule renders [[name#heading]] with #heading appended to href', () => {
  withIndex([{ absPath: '/root/foo.md' }], () => {
    const md = makeMd();
    activate({ subscriptions: [] }).extendMarkdownIt(md);
    const tokens = md.runInline('[[foo#Section A]]');
    const html = md.renderer.rules.mps_wikilink(tokens, 0);
    // Slugified heading appears in the href. The slug strategy is "lowercase,
    // replace whitespace with -" - matches markdown-it's default header anchor.
    assert.match(html, /href="[^"]*foo\.md#section-a"/);
  });
});

test('mps_wikilink rule renders [[name^block]] with #mps-block-<id> in href', () => {
  withIndex([{ absPath: '/root/foo.md' }], () => {
    const md = makeMd();
    activate({ subscriptions: [] }).extendMarkdownIt(md);
    const tokens = md.runInline('[[foo^xyz123]]');
    const html = md.renderer.rules.mps_wikilink(tokens, 0);
    assert.match(html, /href="[^"]*foo\.md#mps-block-xyz123"/);
  });
});

test('mps_wikilink rule combined: [[name#heading|alias]] keeps alias for display, heading in href', () => {
  withIndex([{ absPath: '/root/foo.md' }], () => {
    const md = makeMd();
    activate({ subscriptions: [] }).extendMarkdownIt(md);
    const tokens = md.runInline('[[foo#Section A|Pretty name]]');
    const html = md.renderer.rules.mps_wikilink(tokens, 0);
    assert.match(html, />Pretty name</);
    assert.match(html, /href="[^"]*foo\.md#section-a"/);
  });
});

test('mps_wikilink rule reverse-order [[name|alias#heading]] renders alias#heading verbatim, no anchor jump', () => {
  withIndex([{ absPath: '/root/foo.md' }], () => {
    const md = makeMd();
    activate({ subscriptions: [] }).extendMarkdownIt(md);
    const tokens = md.runInline('[[foo|My display#Section]]');
    const html = md.renderer.rules.mps_wikilink(tokens, 0);
    // The pipe wins; #Section is part of the alias display text.
    assert.match(html, />My display#Section</);
    // No fragment in the href.
    assert.doesNotMatch(html, /href="[^"]*#/);
  });
});

test('mps_wikilink rule: unresolved [[name]] falls back to inert span carrying display text', () => {
  withIndex([], () => {
    const md = makeMd();
    activate({ subscriptions: [] }).extendMarkdownIt(md);
    const tokens = md.runInline('[[never-existed]]');
    const html = md.renderer.rules.mps_wikilink(tokens, 0);
    // Per ticket AC: "failed resolution renders an inert span exactly as today".
    // Today's behaviour is actually an <a> with the relative path - VS Code's
    // webview link handler then fails to navigate. We preserve that: when there
    // is NO workspace index hit, we keep the document-relative href so the
    // existing behaviour is unchanged in workspaces that don't use the index.
    // The "inert span" is reserved for dangerous-scheme rejection.
    assert.match(html, /class="mps-wiki-link"/);
    assert.match(html, />never-existed</);
  });
});

// Pure-fragment links ([[#heading]] / [[^block]]) render a single same-
// document anchor with the fragment text as display - NOT the raw `#frag`
// content doubled with a re-slugified copy (the bug the empty-name path
// originally had: `(parsed.name || content) + fragmentToAnchor(...)` produced
// `#Lists#lists`).
test('mps_wikilink pure heading fragment [[#Heading]] emits a single same-document anchor', () => {
  withIndex([], () => {
    const md = makeMd();
    activate({ subscriptions: [] }).extendMarkdownIt(md);
    const tokens = md.runInline('[[#Section Two]]');
    const html = md.renderer.rules.mps_wikilink(tokens, 0);
    assert.match(html, /href="#section-two"/);
    assert.doesNotMatch(html, /#section-two#/); // not doubled
    assert.match(html, />Section Two</); // display is the heading text, not "#Section Two"
  });
});

test('mps_wikilink pure block fragment [[^block]] emits a single same-document anchor', () => {
  withIndex([], () => {
    const md = makeMd();
    activate({ subscriptions: [] }).extendMarkdownIt(md);
    const tokens = md.runInline('[[^my-block]]');
    const html = md.renderer.rules.mps_wikilink(tokens, 0);
    assert.match(html, /href="#mps-block-my-block"/);
    assert.match(html, />my-block</); // display is the block id, not "^my-block"
  });
});

test('mps_wikilink rule: enabled=false skips index lookup, document-relative behaviour', () => {
  withIndex([{ absPath: '/root/foo.md' }], () => {
    __setWikiStateForTest({ config: { enabled: false } });
    const md = makeMd();
    activate({ subscriptions: [] }).extendMarkdownIt(md);
    const tokens = md.runInline('[[foo]]');
    // When disabled, the rule should still parse the inner content but skip
    // the resolver. resolvedPath is null/undefined; href is the raw inner.
    assert.strictEqual(tokens[0].meta && tokens[0].meta.resolvedPath, undefined);
    const html = md.renderer.rules.mps_wikilink(tokens, 0);
    assert.match(html, /href="foo"/);
  });
});

test('mps_wikilink rule: javascript: scheme still rejected via safeHref', () => {
  withIndex([], () => {
    const md = makeMd();
    activate({ subscriptions: [] }).extendMarkdownIt(md);
    const tokens = md.runInline('[[javascript:alert(1)]]');
    const html = md.renderer.rules.mps_wikilink(tokens, 0);
    assert.doesNotMatch(html, /href=/);
    assert.match(html, /<span class="mps-wiki-link">/);
  });
});

// ---- Windows drive-letter paths ----------------------------------------------

console.log('\nWindows drive-letter paths:');

test('buildResolvedHref fallback emits vscode://file/C:/... for a Windows path', () => {
  const href = buildResolvedHref('C:\\notes\\foo.md', null, null);
  assert.strictEqual(href, 'vscode://file/C:/notes/foo.md');
});

test('buildResolvedHref fallback unchanged for a POSIX path', () => {
  const href = buildResolvedHref('/root/notes/foo.md', null, null);
  assert.strictEqual(href, 'vscode://file/root/notes/foo.md');
});

test('safeHref passes a drive-absolute path through, not a scheme rejection', () => {
  assert.strictEqual(safeHref('C:/notes/foo.md'), 'C:/notes/foo.md');
  assert.strictEqual(safeHref('C:\\notes\\foo.md'), 'C:\\notes\\foo.md');
});

test('safeImgSrc passes a drive-absolute path through', () => {
  assert.strictEqual(safeImgSrc('C:/diagram.png'), 'C:/diagram.png');
});

test('safeHref/safeImgSrc still reject dangerous schemes', () => {
  assert.strictEqual(safeHref('javascript:alert(1)'), '');
  assert.strictEqual(safeHref('vbscript:MsgBox(1)'), '');
  assert.strictEqual(safeImgSrc('javascript:alert(1)'), '');
  assert.strictEqual(safeImgSrc('vbscript:MsgBox(1)'), '');
});

test('drive-relative C:foo (no separator) is still scheme-rejected', () => {
  assert.strictEqual(safeHref('c:foo'), '');
});

// Note: on a real Windows port the click handler still drops unresolved
// drive-letter hrefs (its scheme allowlist regex matches `C:` - see the
// CLAUDE.md known edge cases); this asserts the href is emitted, not that
// navigation succeeds.
test('unresolved [[C:/notes/foo]] renders an href, not an inert span', () => {
  withIndex([], () => {
    const md = makeMd();
    activate({ subscriptions: [] }).extendMarkdownIt(md);
    const tokens = md.runInline('[[C:/notes/foo]]');
    const html = md.renderer.rules.mps_wikilink(tokens, 0);
    assert.match(html, /href="C:\/notes\/foo"/);
  });
});

test('![[C:/diagram.png]] stays an image token, not a rejected fallback', () => {
  withIndex([], () => {
    const md = makeMd();
    activate({ subscriptions: [] }).extendMarkdownIt(md);
    const tokens = md.runInline('![[C:/diagram.png]]');
    assert.strictEqual(tokens[0].type, 'image');
  });
});

// ---- Block-anchor core rule (mps_block_anchors) -----------------------------

console.log('\nBlock anchor rule:');

test('mps_block_anchors: trailing ^id on a paragraph sets id on paragraph_open and strips marker', () => {
  const md = makeMd();
  activate({ subscriptions: [] }).extendMarkdownIt(md);
  const tokens = [
    makeToken({ type: 'paragraph_open', tag: 'p', map: [0, 1] }),
    makeInline('some text ^xyz123'),
    makeToken({ type: 'paragraph_close', tag: 'p' }),
  ];
  md.runCore('some text ^xyz123', tokens);
  assert.strictEqual(getAttr(tokens[0], 'id'), 'mps-block-xyz123');
  assert.strictEqual(tokens[1].content, 'some text', 'marker stripped from inline content');
});

test('mps_block_anchors: ^id in the middle is NOT a marker (only end-of-block)', () => {
  const md = makeMd();
  activate({ subscriptions: [] }).extendMarkdownIt(md);
  const tokens = [
    makeToken({ type: 'paragraph_open', tag: 'p', map: [0, 1] }),
    makeInline('some ^xyz text continues'),
    makeToken({ type: 'paragraph_close', tag: 'p' }),
  ];
  md.runCore('', tokens);
  assert.strictEqual(getAttr(tokens[0], 'id'), undefined);
  assert.strictEqual(tokens[1].content, 'some ^xyz text continues');
});

test('mps_block_anchors inside an embed strips the marker but does NOT set a duplicate id', () => {
  const md = makeMd();
  activate({ subscriptions: [] }).extendMarkdownIt(md);
  const tokens = [
    makeToken({ type: 'paragraph_open', tag: 'p', map: [0, 1] }),
    makeInline('some text ^xyz123'),
    makeToken({ type: 'paragraph_close', tag: 'p' }),
  ];
  // Embedded render: env carries mpsEmbedDepth.
  md.runCore('some text ^xyz123', tokens, { mpsEmbedDepth: 1 });
  assert.strictEqual(getAttr(tokens[0], 'id'), undefined, 'no id inside an embed (would duplicate the host)');
  assert.strictEqual(tokens[1].content, 'some text', 'marker still stripped for clean text');
});

test('mps_block_anchors: trailing ^id on a list item sets id on list_item_open', () => {
  const md = makeMd();
  activate({ subscriptions: [] }).extendMarkdownIt(md);
  const tokens = [
    makeToken({ type: 'list_item_open', tag: 'li', map: [0, 1] }),
    makeToken({ type: 'paragraph_open', tag: 'p', map: [0, 1] }),
    makeInline('item text ^abc'),
    makeToken({ type: 'paragraph_close', tag: 'p' }),
    makeToken({ type: 'list_item_close', tag: 'li' }),
  ];
  md.runCore('', tokens);
  assert.strictEqual(getAttr(tokens[0], 'id'), 'mps-block-abc', 'id on li, not p');
  assert.strictEqual(tokens[2].content, 'item text');
});

test('mps_block_anchors: paragraphs without ^id markers are untouched', () => {
  const md = makeMd();
  activate({ subscriptions: [] }).extendMarkdownIt(md);
  const tokens = [
    makeToken({ type: 'paragraph_open', tag: 'p', map: [0, 1] }),
    makeInline('plain text'),
    makeToken({ type: 'paragraph_close', tag: 'p' }),
  ];
  md.runCore('', tokens);
  assert.strictEqual(getAttr(tokens[0], 'id'), undefined);
  assert.strictEqual(tokens[1].content, 'plain text');
});

// ---- Note transclusion (![[note]]) ------------------------------------------

console.log('\nNote transclusion:');

// Helpers to drive transclusion paths without touching disk. The extension
// uses injectable readFile/statFile via __setWikiStateForTest.
function withTranscludeFixtures(files, fn) {
  const idx = new Map();
  for (const file of Object.keys(files)) addToIndex(idx, file, '');
  const readFile = (absPath) => {
    if (!(absPath in files)) throw new Error('ENOENT: ' + absPath);
    return files[absPath];
  };
  const statFile = (absPath) => {
    if (!(absPath in files)) throw new Error('ENOENT: ' + absPath);
    return { size: Buffer.byteLength(files[absPath], 'utf8') };
  };
  __setWikiStateForTest({ index: idx, config: { enabled: true, embedNotes: true, embedMaxBytes: 262144 }, readFile, statFile });
  try {
    return fn();
  } finally {
    __resetWikiStateForTest();
  }
}

test('![[name]] for an indexed .md target emits a transclude token, not an image', () => {
  withTranscludeFixtures({ '/root/foo.md': '# Foo\n\nbody' }, () => {
    const md = makeMd();
    activate({ subscriptions: [] }).extendMarkdownIt(md);
    const tokens = md.runInline('![[foo]]');
    assert.strictEqual(tokens.length, 1);
    assert.strictEqual(tokens[0].type, 'mps_embed_note');
    assert.strictEqual(tokens[0].meta.resolvedPath, '/root/foo.md');
  });
});

test('![[name]] when embedNotes=false degrades to mps_wikilink with mps-embed-fallback', () => {
  withTranscludeFixtures({ '/root/foo.md': '# Foo' }, () => {
    __setWikiStateForTest({ config: { embedNotes: false } });
    const md = makeMd();
    activate({ subscriptions: [] }).extendMarkdownIt(md);
    const tokens = md.runInline('![[foo]]');
    assert.strictEqual(tokens[0].type, 'mps_wikilink');
    assert.ok(tokens[0].meta && tokens[0].meta.embed);
  });
});

test('![[name]] when target unresolved degrades to mps_wikilink with mps-embed-fallback', () => {
  withTranscludeFixtures({}, () => {
    const md = makeMd();
    activate({ subscriptions: [] }).extendMarkdownIt(md);
    const tokens = md.runInline('![[not-in-index]]');
    assert.strictEqual(tokens[0].type, 'mps_wikilink');
    assert.ok(tokens[0].meta && tokens[0].meta.embed);
  });
});

test('![[name]] for an oversized target degrades to fallback', () => {
  const big = 'x'.repeat(300000); // > default 262144
  withTranscludeFixtures({ '/root/foo.md': big }, () => {
    const md = makeMd();
    activate({ subscriptions: [] }).extendMarkdownIt(md);
    const tokens = md.runInline('![[foo]]');
    assert.strictEqual(tokens[0].type, 'mps_wikilink');
    assert.ok(tokens[0].meta && tokens[0].meta.embed);
  });
});

test('![[name]] for a target exactly at embedMaxBytes degrades to fallback', () => {
  const content = 'x'.repeat(64);
  withTranscludeFixtures({ '/root/foo.md': content }, () => {
    __setWikiStateForTest({ config: { embedMaxBytes: 64 } });
    const md = makeMd();
    activate({ subscriptions: [] }).extendMarkdownIt(md);
    const tokens = md.runInline('![[foo]]');
    assert.strictEqual(tokens[0].type, 'mps_wikilink');
    assert.ok(tokens[0].meta && tokens[0].meta.embed);
  });
});

test('embedMaxBytes: 0 disables transclusion even for a 0-byte target', () => {
  withTranscludeFixtures({ '/root/foo.md': '' }, () => {
    __setWikiStateForTest({ config: { embedMaxBytes: 0 } });
    const md = makeMd();
    activate({ subscriptions: [] }).extendMarkdownIt(md);
    const tokens = md.runInline('![[foo]]');
    assert.strictEqual(tokens[0].type, 'mps_wikilink');
    assert.ok(tokens[0].meta && tokens[0].meta.embed);
  });
});

test('![[image.png]] unchanged - still image token, not transclude', () => {
  withTranscludeFixtures({}, () => {
    const md = makeMd();
    activate({ subscriptions: [] }).extendMarkdownIt(md);
    const tokens = md.runInline('![[pic.png]]');
    assert.strictEqual(tokens[0].type, 'image');
  });
});

test('mps_embed_note renderer wraps content in mps-embed-note container', () => {
  withTranscludeFixtures({ '/root/foo.md': '# Foo\n\nbody text' }, () => {
    const md = makeMd();
    activate({ subscriptions: [] }).extendMarkdownIt(md);
    const tokens = md.runInline('![[foo]]');
    const html = md.renderer.rules.mps_embed_note(tokens, 0);
    assert.match(html, /class="mps-embed-note"/);
    assert.match(html, /data-source="\/root\/foo\.md"/);
    assert.match(html, /class="mps-embed-note-body"/);
  });
});

// ---- Embed / fallback href construction -------------------------------------

console.log('\nEmbed fallback hrefs:');

const RENDER_ENV = { currentDocument: { fsPath: '/root/docs/current.md' } };

// #1: the three mps_embed_note degrade paths (cycle cap, fragment-miss, read
// error) must emit a clickable href via buildResolvedHref - a path relative to
// the previewed document - NOT the bare absolute resolvedPath that VS Code
// can't navigate (it concatenates onto the preview dir -> ENOENT).
test('mps_embed_note cycle-cap fallback emits a document-relative href, not a bare absolute path', () => {
  withTranscludeFixtures({ '/root/notes/foo.md': '# Foo\n\nbody' }, () => {
    const md = makeMd();
    activate({ subscriptions: [] }).extendMarkdownIt(md);
    const tokens = md.runInline('![[foo]]');
    // Force the cycle cap by rendering at depth 2.
    const env = Object.assign({ mpsEmbedDepth: 2 }, RENDER_ENV);
    const html = md.renderer.rules.mps_embed_note(tokens, 0, {}, env);
    assert.match(html, /class="[^"]*mps-embed-cycle[^"]*"/);
    assert.match(html, /href="\.\.\/notes\/foo\.md"/);
    assert.doesNotMatch(html, /href="\/root/); // not the bare absolute path
  });
});

test('mps_embed_note read-error fallback emits a document-relative href, not a bare absolute path', () => {
  // Target is indexed (so resolvedPath is set) but readFile throws (not in
  // the fixtures map) -> the catch fallback fires.
  const idx = new Map();
  addToIndex(idx, '/root/notes/foo.md', '');
  __setWikiStateForTest({
    index: idx,
    config: { enabled: true, embedNotes: true, embedMaxBytes: 262144 },
    readFile: () => { throw new Error('ENOENT'); },
    statFile: () => ({ size: 10 }),
  });
  try {
    const md = makeMd();
    activate({ subscriptions: [] }).extendMarkdownIt(md);
    const tokens = md.runInline('![[foo]]');
    const html = md.renderer.rules.mps_embed_note(tokens, 0, {}, RENDER_ENV);
    assert.match(html, /href="\.\.\/notes\/foo\.md"/);
    assert.doesNotMatch(html, /href="\/root/);
  } finally {
    __resetWikiStateForTest();
  }
});

// #12: fallback display text comes from the parsed target, so an alias shows
// cleanly instead of the literal "name|alias".
test('mps_embed_note fallback shows the alias, not the raw name|alias label', () => {
  const idx = new Map();
  addToIndex(idx, '/root/notes/foo.md', '');
  __setWikiStateForTest({
    index: idx,
    config: { enabled: true, embedNotes: true, embedMaxBytes: 262144 },
    readFile: () => { throw new Error('ENOENT'); },
    statFile: () => ({ size: 10 }),
  });
  try {
    const md = makeMd();
    activate({ subscriptions: [] }).extendMarkdownIt(md);
    const tokens = md.runInline('![[foo|Nice Alias]]');
    const html = md.renderer.rules.mps_embed_note(tokens, 0, {}, RENDER_ENV);
    assert.match(html, />Nice Alias</);
    assert.doesNotMatch(html, /foo\|Nice Alias/);
  } finally {
    __resetWikiStateForTest();
  }
});

// #2: a resolvable target that simply wasn't transcluded (embedNotes off, or
// over the size cap) must keep a working href, not degrade to a dead bare name.
test('embedNotes=false resolvable ![[name]] keeps a document-relative href (not a bare-name dead link)', () => {
  withTranscludeFixtures({ '/root/notes/foo.md': '# Foo' }, () => {
    __setWikiStateForTest({ config: { embedNotes: false } });
    const md = makeMd();
    activate({ subscriptions: [] }).extendMarkdownIt(md);
    const tokens = md.runInline('![[foo]]');
    assert.strictEqual(tokens[0].type, 'mps_wikilink');
    assert.strictEqual(tokens[0].meta.resolvedPath, '/root/notes/foo.md');
    const html = md.renderer.rules.mps_wikilink(tokens, 0, {}, RENDER_ENV);
    assert.match(html, /href="\.\.\/notes\/foo\.md"/);
    assert.doesNotMatch(html, /href="foo"/);
  });
});

test('oversized resolvable ![[name]] keeps a document-relative href', () => {
  const big = 'x'.repeat(300000);
  withTranscludeFixtures({ '/root/notes/foo.md': big }, () => {
    const md = makeMd();
    activate({ subscriptions: [] }).extendMarkdownIt(md);
    const tokens = md.runInline('![[foo]]');
    assert.strictEqual(tokens[0].meta.resolvedPath, '/root/notes/foo.md');
    const html = md.renderer.rules.mps_wikilink(tokens, 0, {}, RENDER_ENV);
    assert.match(html, /href="\.\.\/notes\/foo\.md"/);
  });
});

// #14: a note that wiki-links to itself emits just the fragment, so the click
// scrolls in place instead of reloading the document.
test('mps_wikilink self-link WITH fragment (resolvedPath === docPath) emits a bare fragment href', () => {
  withIndex([{ absPath: '/root/docs/current.md' }], () => {
    const md = makeMd();
    activate({ subscriptions: [] }).extendMarkdownIt(md);
    const tokens = md.runInline('[[current#Section A]]');
    const env = { currentDocument: { fsPath: '/root/docs/current.md' } };
    const html = md.renderer.rules.mps_wikilink(tokens, 0, {}, env);
    assert.match(html, /href="#section-a"/);
    assert.doesNotMatch(html, /current\.md/);
  });
});

// A bare self-link (no fragment) must stay a clickable link (its own
// basename), NOT collapse to an empty href - an empty href would be mistaken
// for a rejected dangerous scheme and render as an inert <span>.
test('mps_wikilink bare self-link (no fragment) emits a clickable link, not an inert span', () => {
  withIndex([{ absPath: '/root/docs/current.md' }], () => {
    const md = makeMd();
    activate({ subscriptions: [] }).extendMarkdownIt(md);
    const tokens = md.runInline('[[current]]');
    const env = { currentDocument: { fsPath: '/root/docs/current.md' } };
    const html = md.renderer.rules.mps_wikilink(tokens, 0, {}, env);
    assert.match(html, /<a class="mps-wiki-link" href="current\.md">/);
    assert.doesNotMatch(html, /<span/);
  });
});

// ---- Concurrent index rebuild guard (#10) -----------------------------------

console.log('\nConcurrent index rebuild guard:');

// A mock vscode whose findFiles is gated on an external promise, so the test
// can interleave two rebuilds: start #1 (findFiles pending), start #2 (resolves
// immediately), then resolve #1. The superseded #1 must dispose its own watcher
// and NOT commit it, leaving only #2's watcher live.
function makeMockVscode(findFilesGate) {
  const created = []; // every watcher created, with a disposed flag
  // Use a real existing dir so canonicalisePath (fs.realpathSync) keeps the
  // root - a non-existent path would be filtered out and findFiles never run.
  const realRoot = require('os').tmpdir();
  return {
    created,
    workspace: {
      workspaceFolders: [{ uri: { fsPath: realRoot } }],
      getConfiguration: () => ({ get: (k, d) => (k === 'enabled' ? true : d) }),
      findFiles: () => findFilesGate(),
      createFileSystemWatcher: () => {
        const w = {
          disposed: false,
          onDidCreate() {},
          onDidDelete() {},
          dispose() { this.disposed = true; },
        };
        created.push(w);
        return w;
      },
    },
    RelativePattern: function (base, glob) { this.base = base; this.glob = glob; },
    commands: { executeCommand: async () => {} },
  };
}

testAsync('a superseded rebuild bails without leaving a duplicate or orphan watcher', async () => {
  __resetWikiStateForTest();
  // Rebuild #1: findFiles blocks until we release it.
  let release1;
  const gate1 = () => new Promise(res => { release1 = res; });
  const vscode1 = makeMockVscode(gate1);
  const ctx = { subscriptions: [] };
  const p1 = __rebuildWorkspaceIndexForTest(ctx, vscode1);

  // Rebuild #2 starts while #1 is awaiting findFiles; its findFiles resolves
  // immediately. This bumps the generation, superseding #1.
  const vscode2 = makeMockVscode(() => Promise.resolve([{ fsPath: '/ws/b.md' }]));
  const p2 = __rebuildWorkspaceIndexForTest(ctx, vscode2);
  await p2;

  // Now release #1's findFiles. It detects (after the await) that it's
  // superseded and bails - BEFORE creating its watcher, so it leaves nothing.
  release1([{ fsPath: '/ws/a.md' }]);
  await p1;

  // The superseded rebuild created no watcher (it bailed at the post-findFiles
  // generation check). Only the winner's watcher exists, is live, and is the
  // sole entry registered for disposal - no duplicate, no orphan.
  assert.strictEqual(vscode1.created.length, 0, 'superseded rebuild created no watcher');
  const w2 = vscode2.created[0];
  assert.ok(w2 && !w2.disposed, "winning rebuild's watcher should be live");
  assert.ok(ctx.subscriptions.includes(w2), "winner's watcher registered in context.subscriptions");
  assert.strictEqual(ctx.subscriptions.length, 1, 'exactly one watcher registered (no leak)');
  __resetWikiStateForTest();
});

// Repeated rebuilds (config/workspace-folder churn) must not accumulate dead
// watcher disposables in context.subscriptions - each rebuild disposes the
// previous watchers, so only the live ones should remain registered.
testAsync('repeated rebuilds do not retain dead watcher handles in context.subscriptions', async () => {
  __resetWikiStateForTest();
  const ctx = { subscriptions: [] };
  const mocks = [];
  for (let round = 0; round < 3; round++) {
    const mock = makeMockVscode(() => Promise.resolve([]));
    mocks.push(mock);
    await __rebuildWorkspaceIndexForTest(ctx, mock);
  }
  const live = ctx.subscriptions.filter(entry => !entry.disposed);
  assert.strictEqual(live.length, 1, 'exactly one live watcher registered');
  assert.strictEqual(ctx.subscriptions.length, 1,
    `dead disposables retained: ${ctx.subscriptions.length - 1}`);
  assert.strictEqual(mocks[2].created[0].disposed, false, 'final watcher live');
  __resetWikiStateForTest();
});

// ---- Stale-preview mitigation (upstream vscode#147718) ----------------------

function mdChangeEvent(uri, opts = {}) {
  return {
    document: { languageId: opts.languageId || 'markdown', uri: { toString: () => uri } },
    contentChanges: opts.emptyChanges ? [] : [{ text: 'x' }],
  };
}

function previewTab(uri, opts = {}) {
  const tab = { isActive: opts.isActive !== false };
  if (!opts.noInput) {
    tab.input = {
      viewType: opts.viewType || 'vscode.markdown.preview.editor',
      uri: uri === null ? undefined : { toString: () => uri },
    };
  }
  return tab;
}

test('markChangedDocument: records a markdown content change', () => {
  const changed = new Set();
  markChangedDocument(changed, mdChangeEvent('file:///a.md'));
  assert.ok(changed.has('file:///a.md'));
});

test('markChangedDocument: ignores non-markdown documents', () => {
  const changed = new Set();
  markChangedDocument(changed, mdChangeEvent('file:///a.js', { languageId: 'javascript' }));
  assert.strictEqual(changed.size, 0);
});

test('markChangedDocument: ignores events with no content changes', () => {
  const changed = new Set();
  markChangedDocument(changed, mdChangeEvent('file:///a.md', { emptyChanges: true }));
  assert.strictEqual(changed.size, 0);
});

testAsync('refreshStalePreviewOnTabActivation: refreshes and clears when a marked preview tab activates', async () => {
  const changed = new Set(['file:///a.md', 'file:///b.md']);
  let refreshes = 0;
  const fired = await refreshStalePreviewOnTabActivation(
    changed, { changed: [previewTab('file:///a.md')] }, () => { refreshes++; });
  assert.strictEqual(fired, true);
  assert.strictEqual(refreshes, 1);
  // markdown.preview.refresh is global - every preview re-baselines, so all
  // marks present at dispatch clear, not just the activated resource.
  assert.strictEqual(changed.size, 0);
});

testAsync('refreshStalePreviewOnTabActivation: no refresh for an unmarked resource', async () => {
  const changed = new Set(['file:///other.md']);
  let refreshes = 0;
  const fired = await refreshStalePreviewOnTabActivation(
    changed, { changed: [previewTab('file:///a.md')] }, () => { refreshes++; });
  assert.strictEqual(fired, false);
  assert.strictEqual(refreshes, 0);
  assert.ok(changed.has('file:///other.md'));
});

testAsync('refreshStalePreviewOnTabActivation: skips inactive tabs', async () => {
  const changed = new Set(['file:///a.md']);
  let refreshes = 0;
  await refreshStalePreviewOnTabActivation(
    changed, { changed: [previewTab('file:///a.md', { isActive: false })] }, () => { refreshes++; });
  assert.strictEqual(refreshes, 0);
});

testAsync('refreshStalePreviewOnTabActivation: skips non-preview tabs and missing inputs', async () => {
  const changed = new Set(['file:///a.md']);
  let refreshes = 0;
  await refreshStalePreviewOnTabActivation(changed, {
    changed: [
      previewTab('file:///a.md', { viewType: 'vscode.markdown.editor' }),
      previewTab('file:///a.md', { noInput: true }),
      previewTab(null),
    ],
  }, () => { refreshes++; });
  assert.strictEqual(refreshes, 0);
});

testAsync('refreshStalePreviewOnTabActivation: ignores opened tabs (fresh webviews render full)', async () => {
  const changed = new Set(['file:///a.md']);
  let refreshes = 0;
  const fired = await refreshStalePreviewOnTabActivation(
    changed, { opened: [previewTab('file:///a.md')], changed: [] }, () => { refreshes++; });
  assert.strictEqual(fired, false);
  assert.strictEqual(refreshes, 0);
});

testAsync('refreshStalePreviewOnTabActivation: refreshes once for multiple marked tabs', async () => {
  const changed = new Set(['file:///a.md', 'file:///b.md']);
  let refreshes = 0;
  await refreshStalePreviewOnTabActivation(changed, {
    changed: [previewTab('file:///a.md'), previewTab('file:///b.md')],
  }, () => { refreshes++; });
  assert.strictEqual(refreshes, 1);
});

testAsync('refreshStalePreviewOnTabActivation: a failed refresh keeps marks so the next activation retries', async () => {
  const changed = new Set(['file:///a.md']);
  const fired = await refreshStalePreviewOnTabActivation(
    changed, { changed: [previewTab('file:///a.md')] },
    () => Promise.reject(new Error('command unavailable')));
  assert.strictEqual(fired, true);
  assert.ok(changed.has('file:///a.md'), 'mark survives a failed refresh');
  let refreshes = 0;
  await refreshStalePreviewOnTabActivation(
    changed, { changed: [previewTab('file:///a.md')] }, () => { refreshes++; });
  assert.strictEqual(refreshes, 1, 'retried on the next activation');
  assert.strictEqual(changed.size, 0);
});

testAsync('refreshStalePreviewOnTabActivation: a mark added mid-refresh survives the clear', async () => {
  const changed = new Set(['file:///a.md']);
  await refreshStalePreviewOnTabActivation(
    changed, { changed: [previewTab('file:///a.md')] },
    async () => { changed.add('file:///b.md'); });
  assert.ok(!changed.has('file:///a.md'), 'serviced mark cleared');
  assert.ok(changed.has('file:///b.md'), 'in-flight mark kept - its render may predate the change');
});

// ---- Stale-preview window-focus refresh -------------------------------------
// Marks added while the window is unfocused (an external writer editing while
// the user is away) are serviced when the window regains focus - the webview
// can be destroyed and restored without any tab event while away, so the
// tab-activation path alone never fires.

function tabGroupsOf(...tabs) {
  return { all: [{ tabs }] };
}

test('markChangedDocument: window unfocused adds the mark to the unfocused set too', () => {
  const changed = new Set();
  const unfocused = new Set();
  markChangedDocument(changed, mdChangeEvent('file:///a.md'), unfocused, false);
  assert.ok(changed.has('file:///a.md'));
  assert.ok(unfocused.has('file:///a.md'));
});

test('markChangedDocument: window focused leaves the unfocused set empty', () => {
  const changed = new Set();
  const unfocused = new Set();
  markChangedDocument(changed, mdChangeEvent('file:///a.md'), unfocused, true);
  assert.ok(changed.has('file:///a.md'));
  assert.strictEqual(unfocused.size, 0);
});

testAsync('refreshStalePreviewOnWindowFocus: refocus refreshes and clears both sets for an active marked-unfocused preview tab', async () => {
  const changed = new Set(['file:///a.md', 'file:///b.md']);
  const unfocused = new Set(['file:///a.md']);
  let refreshes = 0;
  const fired = await refreshStalePreviewOnWindowFocus(
    changed, unfocused, { focused: true },
    tabGroupsOf(previewTab('file:///a.md')), () => { refreshes++; });
  assert.strictEqual(fired, true);
  assert.strictEqual(refreshes, 1);
  // The refresh is global, so all marks present at dispatch clear.
  assert.strictEqual(changed.size, 0);
  assert.strictEqual(unfocused.size, 0);
});

testAsync('refreshStalePreviewOnWindowFocus: no refresh when only focused-time marks exist', async () => {
  const changed = new Set(['file:///a.md']);
  const unfocused = new Set();
  let refreshes = 0;
  const fired = await refreshStalePreviewOnWindowFocus(
    changed, unfocused, { focused: true },
    tabGroupsOf(previewTab('file:///a.md')), () => { refreshes++; });
  assert.strictEqual(fired, false);
  assert.strictEqual(refreshes, 0);
  assert.ok(changed.has('file:///a.md'), 'focused-time mark left for tab activation');
});

testAsync('refreshStalePreviewOnWindowFocus: no refresh on losing focus', async () => {
  const changed = new Set(['file:///a.md']);
  const unfocused = new Set(['file:///a.md']);
  let refreshes = 0;
  const fired = await refreshStalePreviewOnWindowFocus(
    changed, unfocused, { focused: false },
    tabGroupsOf(previewTab('file:///a.md')), () => { refreshes++; });
  assert.strictEqual(fired, false);
  assert.strictEqual(refreshes, 0);
});

testAsync('refreshStalePreviewOnWindowFocus: no refresh when the marked tab is inactive or not a preview', async () => {
  const changed = new Set(['file:///a.md']);
  const unfocused = new Set(['file:///a.md']);
  let refreshes = 0;
  const fired = await refreshStalePreviewOnWindowFocus(
    changed, unfocused, { focused: true },
    tabGroupsOf(
      previewTab('file:///a.md', { isActive: false }),
      previewTab('file:///a.md', { viewType: 'vscode.markdown.editor' }),
      previewTab(null),
      previewTab('file:///a.md', { noInput: true })),
    () => { refreshes++; });
  assert.strictEqual(fired, false);
  assert.strictEqual(refreshes, 0);
  assert.ok(unfocused.has('file:///a.md'), 'mark kept for a later activation or refocus');
});

testAsync('refreshStalePreviewOnWindowFocus: a failed refresh keeps marks so the next refocus retries', async () => {
  const changed = new Set(['file:///a.md']);
  const unfocused = new Set(['file:///a.md']);
  const fired = await refreshStalePreviewOnWindowFocus(
    changed, unfocused, { focused: true },
    tabGroupsOf(previewTab('file:///a.md')),
    () => Promise.reject(new Error('command unavailable')));
  assert.strictEqual(fired, true);
  assert.ok(changed.has('file:///a.md'), 'mark survives a failed refresh');
  assert.ok(unfocused.has('file:///a.md'), 'unfocused mark survives a failed refresh');
});

testAsync('refreshStalePreviewOnWindowFocus: a mark added mid-refresh survives the clear', async () => {
  const changed = new Set(['file:///a.md']);
  const unfocused = new Set(['file:///a.md']);
  await refreshStalePreviewOnWindowFocus(
    changed, unfocused, { focused: true },
    tabGroupsOf(previewTab('file:///a.md')),
    async () => { changed.add('file:///b.md'); unfocused.add('file:///b.md'); });
  assert.ok(!changed.has('file:///a.md'), 'serviced mark cleared');
  assert.ok(changed.has('file:///b.md'), 'in-flight mark kept');
  assert.ok(unfocused.has('file:///b.md'), 'in-flight unfocused mark kept');
});

testAsync('refreshStalePreviewOnTabActivation: also clears serviced unfocused marks', async () => {
  const changed = new Set(['file:///a.md']);
  const unfocused = new Set(['file:///a.md']);
  await refreshStalePreviewOnTabActivation(
    changed, { changed: [previewTab('file:///a.md')] }, () => {}, unfocused);
  assert.strictEqual(changed.size, 0);
  assert.strictEqual(unfocused.size, 0, 'a serviced mark cannot re-fire on the next refocus');
});

// ---- flipTaskMarker (preview checkbox toggle) -------------------------------

test('flipTaskMarker: unchecked bullet flips to x', () => {
  assert.deepStrictEqual(flipTaskMarker('- [ ] Open task'), { column: 3, marker: 'x' });
});

test('flipTaskMarker: checked bullet flips to space', () => {
  assert.deepStrictEqual(flipTaskMarker('- [x] Done'), { column: 3, marker: ' ' });
});

test('flipTaskMarker: uppercase X flips to space', () => {
  assert.deepStrictEqual(flipTaskMarker('- [X] Done'), { column: 3, marker: ' ' });
});

test('flipTaskMarker: indented subtask keeps indent in the column', () => {
  assert.deepStrictEqual(flipTaskMarker('  - [ ] Subtask'), { column: 5, marker: 'x' });
});

test('flipTaskMarker: star and plus bullets accepted', () => {
  assert.deepStrictEqual(flipTaskMarker('* [ ] a'), { column: 3, marker: 'x' });
  assert.deepStrictEqual(flipTaskMarker('+ [x] b'), { column: 3, marker: ' ' });
});

test('flipTaskMarker: ordered-list task items accepted', () => {
  assert.deepStrictEqual(flipTaskMarker('1. [ ] step'), { column: 4, marker: 'x' });
  assert.deepStrictEqual(flipTaskMarker('12) [x] step'), { column: 5, marker: ' ' });
});

test('flipTaskMarker: non-task lines return null', () => {
  assert.strictEqual(flipTaskMarker('plain text'), null);
  assert.strictEqual(flipTaskMarker('- ordinary bullet'), null);
  assert.strictEqual(flipTaskMarker('- [] empty brackets'), null);
  assert.strictEqual(flipTaskMarker('- [y] wrong marker'), null);
  assert.strictEqual(flipTaskMarker('[ ] no list marker'), null);
  assert.strictEqual(flipTaskMarker(''), null);
});

test('flipTaskMarker: column points at the marker character itself', () => {
  const line = '  - [x] verify';
  const flip = flipTaskMarker(line);
  assert.strictEqual(line[flip.column], 'x');
  const flipped = line.slice(0, flip.column) + flip.marker + line.slice(flip.column + 1);
  assert.strictEqual(flipped, '  - [ ] verify');
});

test('flipTaskMarker: blockquote-nested task items accepted', () => {
  assert.deepStrictEqual(flipTaskMarker('> - [ ] quoted'), { column: 5, marker: 'x' });
  assert.deepStrictEqual(flipTaskMarker('> > - [x] deep'), { column: 7, marker: ' ' });
});

// ---- parseToggleDeepLink (deep-link query contract) -------------------------

// The query arrives percent-decoded once (vscode.Uri semantics), exactly
// undoing preview.js's encodeURIComponent. These tests pin the parse side of
// the contract; the literal-href test below pins the producer side.
test('parseToggleDeepLink: well-formed link parses', () => {
  assert.deepStrictEqual(
    parseToggleDeepLink('/toggle', 'doc=file:///notes/a.md&line=12'),
    { doc: 'file:///notes/a.md', line: 12 });
});

test('parseToggleDeepLink: wrong path rejected', () => {
  assert.strictEqual(parseToggleDeepLink('/other', 'doc=file:///a.md&line=1'), null);
});

test('parseToggleDeepLink: missing, empty, or non-numeric line rejected', () => {
  assert.strictEqual(parseToggleDeepLink('/toggle', 'doc=file:///a.md'), null);
  assert.strictEqual(parseToggleDeepLink('/toggle', 'doc=file:///a.md&line='), null);
  assert.strictEqual(parseToggleDeepLink('/toggle', 'doc=file:///a.md&line=-1'), null);
  assert.strictEqual(parseToggleDeepLink('/toggle', 'doc=file:///a.md&line=x'), null);
  assert.strictEqual(parseToggleDeepLink('/toggle', ''), null);
  assert.strictEqual(parseToggleDeepLink('/toggle', undefined), null);
});

test('parseToggleDeepLink: empty doc rejected', () => {
  assert.strictEqual(parseToggleDeepLink('/toggle', 'doc=&line=3'), null);
});

test('parseToggleDeepLink: doc value keeps %, +, &, and = intact', () => {
  // URLSearchParams would mangle every one of these - the regex must not.
  const doc = 'file:///notes/100%25 done + c&d=e.md';
  const parsed = parseToggleDeepLink('/toggle', `doc=${doc}&line=0`);
  assert.deepStrictEqual(parsed, { doc, line: 0 });
});

test('toggle deep link: preview.js builds the exact shape extension.js parses', () => {
  const previewSrc = fs.readFileSync(path.join(__dirname, '..', 'preview.js'), 'utf8');
  // Producer-side pin: the href builder must target our authority and path
  // with doc first and line last (the parser anchors on that order).
  assert.ok(
    previewSrc.includes("'vscode://local.markdown-preview-styles/toggle?doc=' +"),
    'preview.js href builder drifted from the parsed contract');
  assert.ok(
    previewSrc.includes("'&line=' + encodeURIComponent(line)"),
    'preview.js line param drifted from the parsed contract');
  // Round trip: build a query the way preview.js does, decode once the way
  // vscode.Uri does, and the parser must recover the original values.
  const source = 'file:///Users/someone/my notes/100% done.md';
  const line = 42;
  const encodedQuery = 'doc=' + encodeURIComponent(source) + '&line=' + encodeURIComponent(line);
  const parsed = parseToggleDeepLink('/toggle', decodeURIComponent(encodedQuery));
  assert.deepStrictEqual(parsed, { doc: source, line });
});

// ---- Summary ----------------------------------------------------------------

runAsyncTests().then(() => {
  console.log(`\n${passed} pass, ${failed} fail`);
  process.exit(failed ? 1 : 0);
});
