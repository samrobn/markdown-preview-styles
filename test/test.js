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

function makeMd() {
  const coreRules = [];
  const inlineRules = [];
  return {
    core: { ruler: { push(name, fn) { coreRules.push({ name, fn }); } } },
    inline: { ruler: { before(before, name, fn) { inlineRules.push({ before, name, fn }); } } },
    renderer: { rules: {} },
    _coreRules: coreRules,
    _inlineRules: inlineRules,
    runCore(src, tokens = []) {
      function Token(type, tag, nesting) {
        this.type = type; this.tag = tag; this.nesting = nesting;
        this.content = ''; this.block = false; this.attrs = null;
        this.map = null; this.level = 0;
      }
      Token.prototype.attrSet = function (name, value) {
        this.attrs = this.attrs || [];
        const i = this.attrs.findIndex(a => a[0] === name);
        if (i >= 0) this.attrs[i][1] = value;
        else this.attrs.push([name, value]);
      };
      const state = { src, tokens, Token };
      for (const r of coreRules) r.fn(state);
      return state;
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
  assert.match(html, /mps-wiki-link[^>]*>TASK-123<\/span>/);
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
  assert.match(html, /mps-wiki-link[^>]*>parent</);
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

test('wiki-link renderer wraps and escapes content', () => {
  const md = makeMd();
  activate().extendMarkdownIt(md);
  const fn = md.renderer.rules.mps_wikilink;
  assert.strictEqual(typeof fn, 'function', 'mps_wikilink renderer should be registered');
  const html = fn([{ content: 'foo & <bar>' }], 0);
  assert.strictEqual(html, '<span class="mps-wiki-link">foo &amp; &lt;bar&gt;</span>');
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

// ---- Summary ----------------------------------------------------------------

console.log(`\n${passed} pass, ${failed} fail`);
process.exit(failed ? 1 : 0);
