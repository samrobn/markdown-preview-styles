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
