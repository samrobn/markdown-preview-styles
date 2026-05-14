// Markdown preview frontmatter renderer.
// Extracts YAML frontmatter from each preview's source and prepends a
// Properties table above the rendered markdown. Non-editable in v1.

const FRONTMATTER_RE = /^---\r?\n([\s\S]+?)\r?\n---\s*(?:\r?\n|$)/;

function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, c => (
    { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]
  ));
}

function unquote(s) {
  if (s.length >= 2) {
    const first = s[0], last = s[s.length - 1];
    if ((first === '"' && last === '"') || (first === "'" && last === "'")) {
      return s.slice(1, -1);
    }
  }
  return s;
}

function parseScalar(raw) {
  const s = raw.trim();
  if (s === '' || s === 'null' || s === '~') return null;
  if (s === 'true') return true;
  if (s === 'false') return false;
  return unquote(s);
}

// Minimal YAML subset: top-level `key: value` lines, block-style string arrays
// (`key:` then indented `- item`), and inline arrays (`key: [a, b]`).
// Does not handle nested objects, multiline strings, anchors, or flow maps.
function parseFrontmatter(text) {
  const lines = text.split(/\r?\n/);
  const out = {};
  let i = 0;
  while (i < lines.length) {
    const line = lines[i];
    if (!line.trim() || line.trim().startsWith('#')) { i++; continue; }
    const m = line.match(/^([A-Za-z0-9_\-]+):\s*(.*)$/);
    if (!m) { i++; continue; }
    const key = m[1];
    const rawValue = m[2];

    if (rawValue === '') {
      const items = [];
      let j = i + 1;
      while (j < lines.length) {
        const next = lines[j];
        const listMatch = next.match(/^\s+-\s+(.*)$/);
        if (listMatch) {
          items.push(unquote(listMatch[1].trim()));
          j++;
        } else if (next.trim() === '') {
          j++;
        } else {
          break;
        }
      }
      out[key] = items.length > 0 ? items : null;
      i = items.length > 0 ? j : i + 1;
    } else if (rawValue.startsWith('[[') && rawValue.endsWith(']]')) {
      out[key] = parseScalar(rawValue);
      i++;
    } else if (rawValue.startsWith('[') && rawValue.endsWith(']')) {
      const inner = rawValue.slice(1, -1).trim();
      out[key] = inner === '' ? [] : inner.split(',').map(s => parseScalar(s.trim()));
      i++;
    } else {
      out[key] = parseScalar(rawValue);
      i++;
    }
  }
  return out;
}

const ICONS = {
  text:     '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><line x1="17" x2="3" y1="6" y2="6"/><line x1="21" x2="8" y1="12" y2="12"/><line x1="17" x2="3" y1="18" y2="18"/></svg>',
  list:     '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><line x1="8" x2="21" y1="6" y2="6"/><line x1="8" x2="21" y1="12" y2="12"/><line x1="8" x2="21" y1="18" y2="18"/><line x1="3" x2="3.01" y1="6" y2="6"/><line x1="3" x2="3.01" y1="12" y2="12"/><line x1="3" x2="3.01" y1="18" y2="18"/></svg>',
  tags:     '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M20.59 13.41l-7.17 7.17a2 2 0 0 1-2.83 0L2 12V2h10l8.59 8.59a2 2 0 0 1 0 2.82z"/><line x1="7" x2="7.01" y1="7" y2="7"/></svg>',
  date:     '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="4" width="18" height="18" rx="2"/><line x1="16" x2="16" y1="2" y2="6"/><line x1="8" x2="8" y1="2" y2="6"/><line x1="3" x2="21" y1="10" y2="10"/></svg>',
  datetime: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="10"/><polyline points="12 6 12 12 16 14"/></svg>',
  number:   '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><line x1="4" x2="20" y1="9" y2="9"/><line x1="4" x2="20" y1="15" y2="15"/><line x1="10" x2="8" y1="3" y2="21"/><line x1="16" x2="14" y1="3" y2="21"/></svg>',
  checkbox: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="9 11 12 14 22 4"/><path d="M21 12v7a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h11"/></svg>',
};

// Lucide-style icons keyed by canonical callout type. Stroked SVGs so they
// pick up the title's currentColor and inherit the per-type accent set in
// style.css. Aliases share the canonical icon via CALLOUT_ALIASES below.
const CALLOUT_ICONS = {
  note:     '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 20h9"/><path d="M16.5 3.5a2.121 2.121 0 1 1 3 3L7 19l-4 1 1-4Z"/></svg>',
  abstract: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="8" y="2" width="8" height="4" rx="1" ry="1"/><path d="M16 4h2a2 2 0 0 1 2 2v14a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2V6a2 2 0 0 1 2-2h2"/><path d="M12 11h4"/><path d="M12 16h4"/><path d="M8 11h.01"/><path d="M8 16h.01"/></svg>',
  info:     '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="10"/><line x1="12" y1="16" x2="12" y2="12"/><line x1="12" y1="8" x2="12.01" y2="8"/></svg>',
  todo:     '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M22 11.08V12a10 10 0 1 1-5.93-9.14"/><polyline points="22 4 12 14.01 9 11.01"/></svg>',
  tip:      '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M8.5 14.5A2.5 2.5 0 0 0 11 12c0-1.38-.5-2-1-3-1.072-2.143-.224-4.054 2-6 .5 2.5 2 4.9 4 6.5 2 1.6 3 3.5 3 5.5a7 7 0 1 1-14 0c0-1.153.433-2.294 1-3a2.5 2.5 0 0 0 2.5 2.5z"/></svg>',
  success:  '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="20 6 9 17 4 12"/></svg>',
  question: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="10"/><path d="M9.09 9a3 3 0 0 1 5.83 1c0 2-3 3-3 3"/><line x1="12" y1="17" x2="12.01" y2="17"/></svg>',
  warning:  '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M10.29 3.86 1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.71 3.86a2 2 0 0 0-3.42 0z"/><line x1="12" y1="9" x2="12" y2="13"/><line x1="12" y1="17" x2="12.01" y2="17"/></svg>',
  failure:  '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="10"/><line x1="15" y1="9" x2="9" y2="15"/><line x1="9" y1="9" x2="15" y2="15"/></svg>',
  danger:   '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polygon points="13 2 3 14 12 14 11 22 21 10 12 10 13 2"/></svg>',
  bug:      '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="8" y="6" width="8" height="14" rx="4"/><path d="M19 7l-3 2"/><path d="M5 7l3 2"/><path d="M19 19l-3-2"/><path d="M5 19l3-2"/><path d="M20 13h-4"/><path d="M4 13h4"/><path d="M10 4l1 2"/><path d="M14 4l-1 2"/></svg>',
  example:  '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><line x1="8" y1="6" x2="21" y2="6"/><line x1="8" y1="12" x2="21" y2="12"/><line x1="8" y1="18" x2="21" y2="18"/><line x1="3" y1="6" x2="3.01" y2="6"/><line x1="3" y1="12" x2="3.01" y2="12"/><line x1="3" y1="18" x2="3.01" y2="18"/></svg>',
  quote:    '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M3 21c3 0 7-1 7-8V5c0-1.25-.757-2.017-2-2H4c-1.25 0-2 .75-2 1.972V11c0 1.25.75 2 2 2 1 0 1 0 1 1v1c0 1-1 2-2 2s-1 .008-1 1.031V20c0 1 0 1 1 1z"/><path d="M15 21c3 0 7-1 7-8V5c0-1.25-.757-2.017-2-2h-4c-1.25 0-2 .75-2 1.972V11c0 1.25.75 2 2 2 1 0 1 0 1 1v1c0 1-1 2-2 2s-1 .008-1 1.031V20c0 1 0 1 1 1z"/></svg>',
};

const CALLOUT_ALIASES = {
  summary: 'abstract', tldr: 'abstract',
  hint: 'tip', important: 'tip',
  check: 'success', done: 'success',
  help: 'question', faq: 'question',
  caution: 'warning', attention: 'warning',
  fail: 'failure', missing: 'failure',
  error: 'danger',
  cite: 'quote',
};

function calloutIcon(type) {
  const canonical = CALLOUT_ALIASES[type] || type;
  return CALLOUT_ICONS[canonical] || CALLOUT_ICONS.note;
}

function detectType(key, value) {
  if (key === 'tags') return 'tags';
  if (Array.isArray(value)) return 'list';
  if (typeof value === 'boolean') return 'checkbox';
  if (typeof value === 'number') return 'number';
  if (typeof value === 'string') {
    if (/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}/.test(value)) return 'datetime';
    if (/^\d{4}-\d{2}-\d{2}$/.test(value)) return 'date';
  }
  return 'text';
}

function formatDate(value) {
  const s = String(value);
  const dateOnly = s.match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (dateOnly) return `${dateOnly[3]}/${dateOnly[2]}/${dateOnly[1]}`;
  const d = new Date(s);
  if (isNaN(d.getTime())) return escapeHtml(s);
  const pad = n => String(n).padStart(2, '0');
  const dmy = `${pad(d.getDate())}/${pad(d.getMonth() + 1)}/${d.getFullYear()}`;
  if (/T\d{2}:\d{2}/.test(s)) {
    return `${dmy}, ${pad(d.getHours())}:${pad(d.getMinutes())}`;
  }
  return dmy;
}

function renderText(value) {
  let s = escapeHtml(String(value));
  s = s.replace(/\[\[([^\]\n]+)\]\]/g, '<span class="mps-wiki-link">$1</span>');
  s = s.replace(/https?:\/\/[^\s<>'"]+/g, url => `<a href="${url}">${url}</a>`);
  return s;
}

function renderValue(value, type) {
  if (value === null || value === undefined || value === '' || (Array.isArray(value) && value.length === 0)) {
    return '<span class="mps-empty">Empty</span>';
  }
  if (type === 'tags' || (type === 'list' && value.every(v => typeof v === 'string'))) {
    return `<div class="mps-pills">${value.map(v => `<span class="mps-pill">${escapeHtml(v)}</span>`).join('')}</div>`;
  }
  if (type === 'list') {
    return value.map(renderText).join(', ');
  }
  if (type === 'date' || type === 'datetime') {
    return `<span class="mps-date">${formatDate(value)}</span>`;
  }
  if (type === 'checkbox') {
    return value ? '<span class="mps-check on">✓</span>' : '<span class="mps-check off">✗</span>';
  }
  return renderText(value);
}

function renderProperties(data) {
  const entries = Object.entries(data);
  if (entries.length === 0) return '';
  const rows = entries.map(([key, value]) => {
    const type = detectType(key, value);
    const icon = ICONS[type] || ICONS.text;
    return `<tr class="mps-prop" data-type="${type}">`
      + `<td class="mps-prop-key"><span class="mps-prop-icon">${icon}</span><span class="mps-prop-name">${escapeHtml(key)}</span></td>`
      + `<td class="mps-prop-value">${renderValue(value, type)}</td>`
      + `</tr>`;
  }).join('');
  return `<aside class="mps-properties" aria-label="Frontmatter properties"><div class="mps-properties-title">Properties</div><table class="mps-properties-table"><tbody>${rows}</tbody></table></aside>`;
}

function activate() {
  return {
    extendMarkdownIt(md) {
      md.inline.ruler.before('link', 'mps_wikilink', function (state, silent) {
        const src = state.src;
        const start = state.pos;
        if (src.charCodeAt(start) !== 0x5B /* [ */) return false;
        if (src.charCodeAt(start + 1) !== 0x5B) return false;
        const max = state.posMax;
        let end = -1;
        for (let i = start + 2; i < max - 1; i++) {
          const c = src.charCodeAt(i);
          if (c === 0x0A /* \n */) return false;
          if (c === 0x5D /* ] */ && src.charCodeAt(i + 1) === 0x5D) { end = i; break; }
        }
        if (end < 0) return false;
        const content = src.slice(start + 2, end);
        if (!content) return false;
        if (!silent) {
          const token = state.push('mps_wikilink', '', 0);
          token.content = content;
        }
        state.pos = end + 2;
        return true;
      });
      md.renderer.rules.mps_wikilink = function (tokens, idx) {
        return `<span class="mps-wiki-link">${escapeHtml(tokens[idx].content)}</span>`;
      };

      // Obsidian-style callouts: `> [!type] Optional title` at the start of a
      // blockquote becomes a div with separated title + body. Has to run before
      // mps_blank_lines so the line-number rule sees the rewritten tag names.
      md.core.ruler.push('mps_callouts', function (state) {
        const tokens = state.tokens;
        for (let i = 0; i < tokens.length; i++) {
          const open = tokens[i];
          if (open.type !== 'blockquote_open') continue;
          const para = tokens[i + 1];
          const inline = tokens[i + 2];
          const paraClose = tokens[i + 3];
          if (!para || para.type !== 'paragraph_open') continue;
          if (!inline || inline.type !== 'inline') continue;
          if (!paraClose || paraClose.type !== 'paragraph_close') continue;

          // [!type] | [!type]- | [!type]+ followed by optional title text on
          // the rest of the same line, then optional body content separated
          // by a newline.
          const m = inline.content.match(/^\[!([A-Za-z]+)\]([-+]?)(?:[ \t]+([^\n]*))?(?:\n([\s\S]*))?$/);
          if (!m) continue;

          const type = m[1].toLowerCase();
          const fold = m[2];
          const title = (m[3] || '').trim();
          const body = m[4] || '';

          open.tag = 'div';
          open.attrJoin = open.attrJoin || function (name, value) {
            this.attrs = this.attrs || [];
            const i = this.attrs.findIndex(a => a[0] === name);
            if (i >= 0) this.attrs[i][1] = this.attrs[i][1] ? this.attrs[i][1] + ' ' + value : value;
            else this.attrs.push([name, value]);
          };
          open.attrJoin('class', `mps-callout mps-callout-${type}`);
          open.attrSet('data-mps-callout-type', type);
          if (fold) open.attrSet('data-mps-callout-fold', fold === '+' ? 'open' : 'closed');

          // Find matching blockquote_close at the same level.
          let depth = 1;
          for (let j = i + 1; j < tokens.length; j++) {
            if (tokens[j].type === 'blockquote_open') depth++;
            else if (tokens[j].type === 'blockquote_close') {
              depth--;
              if (depth === 0) { tokens[j].tag = 'div'; break; }
            }
          }

          // First paragraph becomes the title row.
          para.tag = 'div';
          para.attrJoin = para.attrJoin || open.attrJoin;
          para.attrJoin('class', 'mps-callout-title');
          paraClose.tag = 'div';

          // Re-parse inline content via the real inline parser when available
          // (real markdown-it exposes state.md); fall back to a plain text
          // token for the unit-test stub which doesn't ship an inline parser.
          const reparse = (src) => {
            const out = [];
            if (state.md && state.md.inline && typeof state.md.inline.parse === 'function') {
              state.md.inline.parse(src, state.md, state.env, out);
            } else {
              const t = new state.Token('text', '', 0);
              t.content = src;
              out.push(t);
            }
            return out;
          };

          // Title text: explicit > falls back to the type name capitalized.
          const titleText = title || (type.charAt(0).toUpperCase() + type.slice(1));
          inline.content = titleText;
          inline.children = reparse(titleText);
          // Prepend the per-type SVG as html_inline so it lands inside the
          // title div alongside the text. Wrapped in a span for CSS hooks.
          const iconToken = new state.Token('html_inline', '', 0);
          iconToken.content = `<span class="mps-callout-icon">${calloutIcon(type)}</span>`;
          inline.children.unshift(iconToken);

          // Body content (when title and first body line shared one paragraph)
          // becomes its own paragraph spliced in after the title row.
          if (body.trim()) {
            const bodyOpen = new state.Token('paragraph_open', 'p', 1);
            bodyOpen.block = true;
            bodyOpen.level = para.level;
            const bodyInline = new state.Token('inline', '', 0);
            bodyInline.content = body;
            bodyInline.children = reparse(body);
            bodyInline.level = para.level + 1;
            const bodyClose = new state.Token('paragraph_close', 'p', -1);
            bodyClose.block = true;
            bodyClose.level = para.level;
            tokens.splice(i + 4, 0, bodyOpen, bodyInline, bodyClose);
          }
        }
      });

      md.core.ruler.push('mps_blank_lines', function (state) {
        const lines = (state.src || '').split(/\r?\n/);
        const result = [];
        let lastEnd = 0;
        let listDepth = 0;
        for (const token of state.tokens) {
          if (token.map) {
            token.attrSet('data-mps-line', String(token.map[0] + 1));
          }
          // List nesting depth = count of ul/ol ancestors. Used by style.css
          // to shift the line-number gutter left for nested items, because
          // VS Code's `.code-line { position: relative }` makes each nested
          // li its own containing block. Set BEFORE incrementing so a
          // bullet_list_open at depth 0 records 0, then nested items see 1+.
          if (token.type === 'bullet_list_open' || token.type === 'ordered_list_open') {
            token.attrSet('data-mps-list-depth', String(listDepth));
            listDepth++;
          } else if (token.type === 'bullet_list_close' || token.type === 'ordered_list_close') {
            listDepth--;
          } else if (token.type === 'list_item_open') {
            token.attrSet('data-mps-list-depth', String(listDepth));
          }
          if (token.level === 0 && token.map) {
            const [start, end] = token.map;
            for (let n = lastEnd; n < start; n++) {
              if ((lines[n] || '').trim() === '') {
                const placeholder = new state.Token('html_block', '', 0);
                placeholder.content = `<div class="code-line mps-blank-line" data-line="${n}" data-mps-line="${n + 1}"></div>\n`;
                placeholder.map = [n, n + 1];
                result.push(placeholder);
              }
            }
            result.push(token);
            // markdown-it's `bullet_list_open.map[1]` can overshoot past the
            // list's last content line and into trailing blank lines (the
            // list "consumes" its terminator). Don't let those blanks get
            // absorbed - trim them so the next iteration's gap check still
            // sees them and emits a placeholder for each.
            let actualEnd = end;
            while (actualEnd > start && (lines[actualEnd - 1] || '').trim() === '') {
              actualEnd--;
            }
            lastEnd = actualEnd;
          } else {
            result.push(token);
          }
        }
        state.tokens = result;
      });

      md.core.ruler.push('mps_frontmatter', function (state) {
        const src = (state.src || '').replace(/^﻿/, '').replace(/^\s+/, '');
        const match = src.match(FRONTMATTER_RE);
        if (!match) return;
        let html;
        try {
          const data = parseFrontmatter(match[1]);
          if (data['mps-hide'] === true) return;
          html = renderProperties(data);
        } catch (e) {
          html = `<div class="mps-properties-error">Failed to parse frontmatter: ${escapeHtml(e.message)}</div>`;
        }
        const token = new state.Token('html_block', '', 0);
        token.content = html;
        token.block = true;
        state.tokens.unshift(token);
      });
      return md;
    }
  };
}

exports.activate = activate;
