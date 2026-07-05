// Markdown preview frontmatter renderer.
// Extracts YAML frontmatter from each preview's source and prepends a
// Properties table above the rendered markdown. Non-editable in v1.

const fs = require('fs');
const path = require('path');
const os = require('os');

const FRONTMATTER_RE = /^---\r?\n([\s\S]+?)\r?\n---\s*(?:\r?\n|$)/;

// ---- Wikilink resolver state -----------------------------------------------
//
// Module-level state populated by activate(context). The extendMarkdownIt
// rules close over these via the accessor functions below, so tests can
// swap state without re-registering rules.
//
// `wikiIndex` is a Map<basenameLowercase, string[]> of absolute paths. Each
// bucket is pre-sorted: within a single indexed root, ascending by separator
// count then alphabetical (so resolveWikilinkTarget can return the head).
// Across roots (multi-root + extraIndexRoots), entries are interleaved by
// alphabetical-by-root-path, then by relative-path within the root.
let wikiIndex = new Map();
let wikiConfig = {
  enabled: true,
  extraIndexRoots: [],
  embedNotes: true,
  embedMaxBytes: 262144,
};
// Roots are tracked alongside the index for cross-root tiebreak ordering.
// Each entry is { absPath, sortKey } - sortKey is the canonicalised path
// used for ordering. Filled by activate(); empty in unit tests.
let wikiRoots = [];

// Injectable for tests so transclusion can run without real disk I/O.
let wikiReadFile = (absPath) => fs.readFileSync(absPath, 'utf8');
let wikiStatFile = (absPath) => fs.statSync(absPath);

function __setWikiStateForTest(state) {
  if (state.index !== undefined) wikiIndex = state.index;
  if (state.config !== undefined) wikiConfig = { ...wikiConfig, ...state.config };
  if (state.roots !== undefined) wikiRoots = state.roots;
  if (state.readFile !== undefined) wikiReadFile = state.readFile;
  if (state.statFile !== undefined) wikiStatFile = state.statFile;
}

function __resetWikiStateForTest() {
  wikiIndex = new Map();
  wikiConfig = { enabled: true, extraIndexRoots: [], embedNotes: true, embedMaxBytes: 262144 };
  wikiRoots = [];
  wikiReadFile = (absPath) => fs.readFileSync(absPath, 'utf8');
  wikiStatFile = (absPath) => fs.statSync(absPath);
}

// Parse the inner content of a [[...]] or ![[...]] into its three parts.
// Canonical order is fragment-before-pipe: `name(#heading|^block)?(\|alias)?`.
// Reverse order (`name|alias#heading`) is NOT recognised - the pipe wins,
// so `alias#heading` is the literal label and the trailing fragment is part
// of the display text rather than a scroll target. This matches Obsidian's
// canonical form and `markdown-it-wikilinks`' native parse.
function parseWikilinkTarget(inner) {
  if (typeof inner !== 'string') return { name: '', fragment: null, alias: null };
  // Split at the FIRST pipe. Everything to the right is the alias verbatim.
  const pipeIdx = inner.indexOf('|');
  const namePart = pipeIdx >= 0 ? inner.slice(0, pipeIdx) : inner;
  const alias = pipeIdx >= 0 ? inner.slice(pipeIdx + 1) : null;
  // Fragment lives on the name side, anchored at the end of namePart so a `#`
  // in the basename (unlikely but legal) isn't mistaken for a heading marker.
  //   `^block`   - restricted to the canonical block-id charset, so `^a b`
  //                isn't half-parsed into an id the anchor can never match.
  //   `#heading` - any run not containing another `#`/`^` (slugified later).
  // The name part may be empty: `[[#heading]]` / `[[^block]]` are valid
  // same-document fragment links (the resolver/renderer treat an empty name as
  // "current document").
  let name = namePart;
  let fragment = null;
  const blockMatch = namePart.match(new RegExp('^(.*?)(\\^' + BLOCK_ID_RE.source + ')$'));
  const headingMatch = namePart.match(/^(.*?)(#[^#^]+)$/);
  if (blockMatch) {
    name = blockMatch[1];
    fragment = blockMatch[2];
  } else if (headingMatch) {
    name = headingMatch[1];
    fragment = headingMatch[2];
  }
  return { name, fragment, alias };
}

// Sort comparator for an index bucket. Across roots (multi-root + extra),
// the root sort key dominates. Within a single root, ascending by separator
// count (shortest path wins on basename collision), then alphabetical for a
// deterministic final tiebreak. Roots are sorted alphabetically by their
// canonicalised path so "shortest path" only carries meaning within one root.
function indexBucketCompare(a, b) {
  if (a.rootSortKey !== b.rootSortKey) {
    return a.rootSortKey < b.rootSortKey ? -1 : 1;
  }
  const sepA = (a.absPath.match(/\//g) || []).length;
  const sepB = (b.absPath.match(/\//g) || []).length;
  if (sepA !== sepB) return sepA - sepB;
  return a.absPath < b.absPath ? -1 : (a.absPath > b.absPath ? 1 : 0);
}

function addToIndex(index, absPath, rootSortKey) {
  const basename = path.basename(absPath, path.extname(absPath)).toLowerCase();
  const bucket = index.get(basename) || [];
  if (bucket.some(e => e.absPath === absPath)) return;
  bucket.push({ absPath, rootSortKey: rootSortKey || '' });
  bucket.sort(indexBucketCompare);
  index.set(basename, bucket);
}

function removeFromIndex(index, absPath) {
  const basename = path.basename(absPath, path.extname(absPath)).toLowerCase();
  const bucket = index.get(basename);
  if (!bucket) return;
  const filtered = bucket.filter(e => e.absPath !== absPath);
  if (filtered.length === 0) index.delete(basename);
  else index.set(basename, filtered);
}

// Resolve a wikilink target name (already stripped of fragment and alias)
// to an absolute path via the workspace index. Returns null on miss.
// Case-insensitive on the basename to match Obsidian. Tolerates a trailing
// `.md` (Obsidian writes `[[name]]` for `name.md` but accepts `[[name.md]]`)
// and a folder prefix in the wikilink (`[[folder/name]]` - Foam/Dendron form)
// by looking up only the final basename.
function resolveWikilinkTarget(name, indexOverride) {
  const idx = indexOverride || wikiIndex;
  if (!name) return null;
  const stripped = name.replace(/\.md$/i, '');
  const basename = stripped.replace(/^.*\//, '').toLowerCase();
  const hits = idx.get(basename);
  if (!hits || hits.length === 0) return null;
  return hits[0].absPath;
}

// Strip YAML frontmatter from a markdown source string.
function stripFrontmatter(src) {
  return src.replace(FRONTMATTER_RE, '');
}

// Slice a markdown source string to the section under `#heading` or the
// single block carrying `^block-id`. Returns the full body when fragment
// is null. Returns '' when the fragment isn't found - caller decides
// whether that's a fallback condition.
function sliceToFragment(src, fragment) {
  if (!fragment) return src;
  if (fragment[0] === '^') {
    const id = fragment.slice(1);
    const re = new RegExp('^(.*\\s\\^' + id.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + ')\\s*$', 'm');
    const m = src.match(re);
    return m ? m[1].replace(new RegExp('\\s+\\^' + BLOCK_ID_RE.source + '\\s*$'), '') : '';
  }
  // Heading fragment: find a heading line matching (case-insensitive,
  // slug-equivalent) the requested heading, take content until the next
  // same-or-higher-level heading.
  const wantSlug = slugifyHeading(fragment.slice(1));
  const lines = src.split(/\r?\n/);
  let startIdx = -1;
  let startLevel = 0;
  for (let i = 0; i < lines.length; i++) {
    const m = lines[i].match(/^(#{1,6})\s+(.+?)\s*$/);
    if (!m) continue;
    const slug = slugifyHeading(m[2]);
    if (slug === wantSlug) {
      startIdx = i + 1;
      startLevel = m[1].length;
      break;
    }
  }
  if (startIdx < 0) return '';
  const out = [];
  for (let i = startIdx; i < lines.length; i++) {
    const m = lines[i].match(/^(#{1,6})\s+/);
    if (m && m[1].length <= startLevel) break;
    out.push(lines[i]);
  }
  return out.join('\n');
}

// Try to emit an mps_embed_note token for a non-image embed target.
// Returns true if a transclude token was pushed (caller skips the
// wiki-link fallback). Returns false on any condition that prevents
// transclusion - the caller's wiki-link fallback then runs.
function tryEmitTranscludeToken(state, path) {
  if (!wikiConfig.enabled || !wikiConfig.embedNotes) return false;
  const parsed = parseWikilinkTarget(path);
  if (!parsed.name) return false;
  const resolved = resolveWikilinkTarget(parsed.name);
  if (!resolved) return false;
  // Cheap size gate before reading. Skip if stat fails - the renderer
  // will surface the failure via the cycle/fallback path.
  try {
    // >= so the documented cap is a hard limit, and embedMaxBytes: 0 means
    // "never transclude" (every size, including 0, is >= 0).
    const stat = wikiStatFile(resolved);
    if (stat.size >= wikiConfig.embedMaxBytes) return false;
  } catch (_) {
    return false;
  }
  const tok = state.push('mps_embed_note', '', 0);
  tok.meta = {
    resolvedPath: resolved,
    fragment: parsed.fragment,
    alias: parsed.alias,
    originalTarget: path,
  };
  return true;
}

// Slugify a heading the way VS Code's preview does, so a `[[note#heading]]`
// href anchor matches the `id` VS Code renders on the heading element. This is
// the GitHub slugifier (verified against the 1.122 bundle's GithubSlugifier):
// trim, lowercase, strip punctuation/symbols, whitespace → '-'.
//
// The character class keeps Unicode letters/numbers/marks plus `_`/`-` and
// strips everything else - so `Café` → `café` and `へや 部屋` → `へや-部屋`,
// matching the bundle. (The bundle uses an explicit ~2KB Unicode code-point
// regex; the \p{...} classes reproduce its output for any realistic heading
// without vendoring that table.) Whitespace is replaced per-character (not
// collapsed), so `a  b` → `a--b`, again matching GitHub. Duplicate-heading
// `-1`/`-2` disambiguation is NOT reproduced - a wikilink to a repeated
// heading targets the first.
function slugifyHeading(text) {
  return String(text).trim().toLowerCase()
    .replace(/[^\p{L}\p{N}\p{M}_\- ]/gu, '')
    .replace(/\s/g, '-');
}

// Canonical block-id character class. A `^block` reference and the
// `id="mps-block-<id>"` anchor it targets must agree on what a block id is, or
// the link resolves to nothing. mps_block_anchors only ever mints ids from
// this class, so parseWikilinkTarget and the slice/anchor paths use it too.
const BLOCK_ID_RE = /[A-Za-z0-9_-]+/;

// Convert a parsed fragment into the URL-anchor form used in hrefs.
// `#heading` → `#heading-slug`. `^block` → `#mps-block-<id>`. null → ''.
function fragmentToAnchor(fragment) {
  if (!fragment) return '';
  if (fragment[0] === '^') {
    return '#mps-block-' + fragment.slice(1);
  }
  return '#' + slugifyHeading(fragment.slice(1));
}

// Percent-encode each path segment, preserving the `/` separators. Used in
// place of encodeURI for hrefs because encodeURI leaves `#`, `?`, and `&`
// unescaped - a resolved target named e.g. `report?draft.md` would otherwise
// emit an href the click handler truncates at the `?`. encodeURIComponent
// escapes all three, and splitting on `/` keeps the path structure intact.
function encodePathSegments(p) {
  return String(p).split('/').map(encodeURIComponent).join('/');
}

// Pull the previewed document's on-disk path from the render env. VS Code
// populates env with `{ currentDocument, containingImages, slugifier,
// resourceProvider }` for the markdown preview.
//
// currentDocument is a vscode.Uri, NOT a TextDocument - verified against the
// 1.122 bundle, where MarkdownEngine.render builds `currentDocument: typeof e
// == "string" ? void 0 : e.uri`. A Uri exposes `.fsPath` directly and has NO
// `.uri` property. The `cd.uri.fsPath` arm is a fallback for the TextDocument
// shape (older/future builds).
//
// currentDocument is undefined on the incremental render path: when you type
// into a preview-to-the-side, VS Code re-renders with the spliced document
// TEXT (a string), and the string branch sets `currentDocument: void 0`. So
// relying on currentDocument alone re-introduces the vscode://file fallback
// after every keystroke. env.resourceProvider is the MarkdownPreview itself
// (passed identically on both render paths) and exposes `.resource` (the
// previewed document's Uri) - so it survives the incremental path.
function docPathFromEnv(env) {
  const cd = env && env.currentDocument;
  const rp = env && env.resourceProvider;
  return (cd && cd.fsPath) ||
         (cd && cd.uri && cd.uri.fsPath) ||
         (rp && rp.resource && rp.resource.fsPath) ||
         (env && env.resource && env.resource.fsPath) ||
         null;
}

// Build the href for a wikilink whose target RESOLVED to an absolute disk path.
// Three shapes:
//   1. docPath known → a path relative from the previewed document to the
//      target. VS Code's click handler sees a schemeless string, posts an
//      `openLink` message, and the extension host resolves it relative to the
//      preview resource - in-preview navigation, no OS prompt, preview mode.
//      This is the path built-in `[text](relative.md)` links take.
//   2. docPath unknown → `vscode://file/...` URI. The `vscode:` scheme is in
//      the click-handler allowlist, so the OS routes it back to VS Code. Costs
//      one OS prompt and opens the raw editor, but works across any path.
//   3. target IS the previewed document AND there's a fragment (self-link
//      like [[current#section]]) → just the fragment, so the click scrolls in
//      place instead of reloading. A bare self-link ([[current]], no fragment)
//      falls through to the relative path (its own basename) - a normal
//      reload link, NOT an empty href (which the renderer would mistake for a
//      rejected dangerous scheme and render as an inert span).
// Bare-absolute and `file://` hrefs were both tried and are wrong: VS Code
// concatenates a bare-absolute onto the preview dir (ENOENT on the doubled
// path), and `file://` is dropped by the click handler's scheme tests.
// resolvedPath is sourced from vscode.workspace.findFiles - not user input -
// so it doesn't need safeHref screening.
function buildResolvedHref(resolvedPath, fragment, docPath) {
  const anchor = fragmentToAnchor(fragment);
  if (docPath) {
    if (resolvedPath === docPath && anchor) return anchor; // self-link w/fragment → scroll in place
    let rel = path.relative(path.dirname(docPath), resolvedPath);
    rel = rel.split(path.sep).join('/'); // Windows backslashes → URL slashes
    return encodePathSegments(rel) + anchor;
  }
  // vscode://file needs a `/` between authority and path. POSIX absolute
  // paths carry their own; a Windows drive path (C:\notes\foo.md) doesn't,
  // so normalise to /C:/notes/foo.md. The drive segment keeps its literal
  // `:` - vscode://file/C:/... is VS Code's documented shape.
  const p = String(resolvedPath);
  if (WINDOWS_DRIVE_RE.test(p)) {
    const rest = p.slice(2).split('\\').join('/');
    return 'vscode://file/' + p.slice(0, 2) + encodePathSegments(rest) + anchor;
  }
  return 'vscode://file' + encodePathSegments(p) + anchor;
}

// Expand `~` and `~/...` in a path string. No-op on absolute paths.
function expandTilde(p) {
  if (typeof p !== 'string' || !p.startsWith('~')) return p;
  if (p === '~') return os.homedir();
  if (p.startsWith('~/')) return path.join(os.homedir(), p.slice(2));
  return p; // ~user form not supported - rare and platform-specific
}


function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, c => (
    { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]
  ));
}

// Single ASCII letter + `:` + path separator = a Windows drive root. Shared
// by checkScheme (don't reject `C:` as a URL scheme) and buildResolvedHref
// (vscode://file needs /C:/... normalisation) so the two can't drift.
const WINDOWS_DRIVE_RE = /^[a-z]:[\\/]/i;

const IMAGE_EXT_RE = /\.(png|jpe?g|gif|webp|svg|avif|bmp|ico)(?:[?#]|$)/i;
function isImagePath(p) { return IMAGE_EXT_RE.test(String(p)); }

const MAX_EMBED_WIDTH = 4096;

function basenameWithoutExt(p) {
  const base = String(p).replace(/^.*\//, '');
  // Returning the unstripped basename when ext-strip yields empty handles
  // dotfiles like .gitignore (would otherwise render as an empty anchor).
  const stripped = base.replace(/\.[^.]+$/, '');
  return stripped || base;
}

// Two URL-safety guards with different policies for href vs src contexts.
// Both reject relative paths NEVER (relative is the common case) and parse
// a scheme prefix only to filter dangerous protocols.
function checkScheme(raw) {
  const trimmed = String(raw).trim();
  // A single letter + `:` + path separator is a Windows drive root
  // (C:/notes, C:\notes), not a URL scheme - pass it through. Drive-relative
  // `C:foo` (no separator) still parses as a scheme and gets rejected; no
  // 1-char scheme is in either allowlist so nothing dangerous slips in.
  if (WINDOWS_DRIVE_RE.test(trimmed)) return { trimmed, scheme: null };
  const schemeMatch = trimmed.match(/^([a-z][a-z0-9+.-]*):/i);
  return { trimmed, scheme: schemeMatch ? schemeMatch[1].toLowerCase() : null };
}

// For <a href>. Rejects javascript:, vbscript:, file:, data: (including
// data:image/svg+xml - SVG can carry inline scripts that execute when the
// browser navigates to the URL as a document). Allows http(s) and mailto.
function safeHref(raw) {
  const { trimmed, scheme } = checkScheme(raw);
  if (!scheme) return trimmed;
  if (scheme === 'http' || scheme === 'https' || scheme === 'mailto') return trimmed;
  return '';
}

// For <img src>. Rejects javascript:, vbscript:, file:, data:text/html etc.
// Allows http(s) and the data:image/* subset (SVG rendered through an <img>
// element is sandboxed - scripts don't execute - so the data URL is safe in
// this context but unsafe in href).
function safeImgSrc(raw) {
  const { trimmed, scheme } = checkScheme(raw);
  if (!scheme) return trimmed;
  if (scheme === 'http' || scheme === 'https') return trimmed;
  if (scheme === 'data' && /^data:image\//i.test(trimmed)) return trimmed;
  return '';
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
  // No 'number' type: parseScalar keeps numeric frontmatter as strings (see
  // CLAUDE.md), so a value is never a number - don't re-add the dead branch.
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

// Tokenise the raw value into a sequence of `{type, content}` segments,
// rendering each segment with the correct escaping policy for its context.
// Tokenising first (rather than chained string.replace) avoids two bugs the
// old implementation had: double-escaping wiki-link hrefs (the regex captured
// from an already-escaped string and then escaped the href again), and the
// URL linkifier matching URLs inside an emitted <a href>'s attribute value
// (because it ran second on a string that already contained anchor HTML).
function renderText(value, docPath) {
  const src = String(value);
  // Combined regex: wiki-link OR URL. The wiki-link branch wins when both
  // could match the same position because it's listed first in the alternation.
  const TOKEN_RE = /\[\[([^\]\n]+)\]\]|(https?:\/\/[^\s<>'"]+)/g;
  let out = '';
  let lastIndex = 0;
  let m;
  while ((m = TOKEN_RE.exec(src)) !== null) {
    out += escapeHtml(src.slice(lastIndex, m.index));
    if (m[1] !== undefined) {
      // Wiki-link. Resolve it the same way the body mps_wikilink renderer
      // does - parse the alias/fragment, resolve against the workspace index,
      // build the href - so frontmatter wikilinks navigate and honour alias
      // syntax instead of emitting a literal `name|alias` href.
      const inner = m[1];
      const parsed = parseWikilinkTarget(inner);
      const display = escapeHtml(parsed.alias != null
        ? parsed.alias
        : basenameWithoutExt(parsed.name || inner));
      const resolved = wikiConfig.enabled ? resolveWikilinkTarget(parsed.name) : null;
      const href = resolved
        ? buildResolvedHref(resolved, parsed.fragment, docPath)
        : safeHref((parsed.name || inner) + fragmentToAnchor(parsed.fragment));
      out += href
        ? `<a class="mps-wiki-link" href="${escapeHtml(href)}">${display}</a>`
        : `<span class="mps-wiki-link">${display}</span>`;
    } else {
      // Bare URL. m[2] is the raw URL from the source.
      const url = m[2];
      const href = safeHref(url);
      const escapedDisplay = escapeHtml(url);
      out += href
        ? `<a href="${escapeHtml(href)}">${escapedDisplay}</a>`
        : escapedDisplay;
    }
    lastIndex = TOKEN_RE.lastIndex;
  }
  out += escapeHtml(src.slice(lastIndex));
  return out;
}

function renderValue(value, type, docPath) {
  if (value === null || value === undefined || value === '' || (Array.isArray(value) && value.length === 0)) {
    return '<span class="mps-empty">Empty</span>';
  }
  if (type === 'tags' || (type === 'list' && value.every(v => typeof v === 'string'))) {
    return `<div class="mps-pills">${value.map(v => `<span class="mps-pill">${escapeHtml(v)}</span>`).join('')}</div>`;
  }
  if (type === 'list') {
    return value.map(v => renderText(v, docPath)).join(', ');
  }
  if (type === 'date' || type === 'datetime') {
    return `<span class="mps-date">${formatDate(value)}</span>`;
  }
  if (type === 'checkbox') {
    return value ? '<span class="mps-check on">✓</span>' : '<span class="mps-check off">✗</span>';
  }
  return renderText(value, docPath);
}

// docPath (previewed document's path, from docPathFromEnv) lets frontmatter
// wikilinks resolve to a document-relative href like body wikilinks do; it's
// undefined when called without a render env (the inner pieces fall back to
// the vscode://file form, which still navigates).
function renderProperties(data, docPath) {
  const entries = Object.entries(data);
  if (entries.length === 0) return '';
  const rows = entries.map(([key, value]) => {
    const type = detectType(key, value);
    const icon = ICONS[type] || ICONS.text;
    return `<tr class="mps-prop" data-type="${type}">`
      + `<td class="mps-prop-key"><span class="mps-prop-icon">${icon}</span><span class="mps-prop-name">${escapeHtml(key)}</span></td>`
      + `<td class="mps-prop-value">${renderValue(value, type, docPath)}</td>`
      + `</tr>`;
  }).join('');
  return `<aside class="mps-properties" aria-label="Frontmatter properties"><div class="mps-properties-title">Properties</div><table class="mps-properties-table"><tbody>${rows}</tbody></table></aside>`;
}

// Build the workspace index from VS Code's workspace API. Returns an
// array of { vscode, watchers } so deactivate can dispose. No-op outside
// of a VS Code host (vscode require throws in unit tests / Node-only runs).
async function initWorkspaceIndex(context) {
  let vscode;
  try {
    vscode = require('vscode');
  } catch (_) {
    return; // Not running inside VS Code (unit test or harness). Skip.
  }

  const config = vscode.workspace.getConfiguration('markdownPreviewStyles.wikilinks');
  wikiConfig = {
    enabled: config.get('enabled', true),
    extraIndexRoots: config.get('extraIndexRoots', []),
    embedNotes: config.get('embedNotes', true),
    embedMaxBytes: config.get('embedMaxBytes', 262144),
  };

  // Hot-reload when the user flips settings.
  context.subscriptions.push(
    vscode.workspace.onDidChangeConfiguration(e => {
      if (e.affectsConfiguration('markdownPreviewStyles.wikilinks')) {
        rebuildWorkspaceIndex(context, vscode).catch(err =>
          console.warn('markdown-preview-styles: index rebuild failed', err)
        );
      }
    })
  );

  // Initial build. (rebuildWorkspaceIndex triggers a preview refresh on
  // completion so previews opened before the index built pick up resolution.)
  await rebuildWorkspaceIndex(context, vscode);

  // React to workspace folder add/remove without forcing a full reload.
  context.subscriptions.push(
    vscode.workspace.onDidChangeWorkspaceFolders(() => {
      rebuildWorkspaceIndex(context, vscode).catch(err =>
        console.warn('markdown-preview-styles: index rebuild failed', err)
      );
    })
  );
}

// Watchers from the previous rebuild - disposed before each fresh build.
let _activeWatchers = [];
// Monotonic rebuild counter. rebuildWorkspaceIndex is async with awaits
// (findFiles per root), so a config change firing during the initial build
// can interleave a second rebuild with the first. Each call captures the
// generation at entry and bails after every await if a newer rebuild has
// started - otherwise two rebuilds both add to the shared index and both push
// watchers, leaving duplicate live watchers (double index events) and orphans
// that never get disposed.
let _rebuildGeneration = 0;

async function rebuildWorkspaceIndex(context, vscode) {
  const myGen = ++_rebuildGeneration;
  const superseded = () => myGen !== _rebuildGeneration;

  // Re-read config in case this rebuild was triggered by a config change.
  const config = vscode.workspace.getConfiguration('markdownPreviewStyles.wikilinks');
  wikiConfig = {
    enabled: config.get('enabled', true),
    extraIndexRoots: config.get('extraIndexRoots', []),
    embedNotes: config.get('embedNotes', true),
    embedMaxBytes: config.get('embedMaxBytes', 262144),
  };

  // Tear down previous watchers - and drop them from context.subscriptions,
  // which is only ever pushed to, so dead handles would otherwise accumulate
  // across config/workspace-folder rebuilds until deactivate.
  for (const w of _activeWatchers) {
    w.dispose();
    const idx = context.subscriptions.indexOf(w);
    if (idx !== -1) context.subscriptions.splice(idx, 1);
  }
  _activeWatchers = [];

  wikiIndex = new Map();
  wikiRoots = [];

  if (!wikiConfig.enabled) return;

  // Collect roots: workspace folders + extraIndexRoots, deduplicated by
  // canonical absolute path. Missing extra roots are warned-and-skipped.
  const seen = new Set();
  const roots = [];
  for (const folder of (vscode.workspace.workspaceFolders || [])) {
    const canonical = canonicalisePath(folder.uri.fsPath);
    if (canonical && !seen.has(canonical)) {
      seen.add(canonical);
      roots.push({ absPath: folder.uri.fsPath, canonical });
    }
  }
  for (const raw of wikiConfig.extraIndexRoots) {
    const expanded = expandTilde(raw);
    const canonical = canonicalisePath(expanded);
    if (!canonical) {
      console.warn('markdown-preview-styles: extraIndexRoots path not found, skipping:', raw);
      continue;
    }
    if (seen.has(canonical)) continue;
    seen.add(canonical);
    roots.push({ absPath: expanded, canonical });
  }

  wikiRoots = roots;

  // findFiles + watcher per root. Per-root patterns keep the watcher set
  // explicit and let us tag each indexed path with its root's sort key.
  // Watchers accumulate in a local array and are only committed to the shared
  // _activeWatchers / context.subscriptions once we know this rebuild won the
  // race; a superseded rebuild disposes them instead of leaking them.
  const watchers = [];
  for (const root of roots) {
    const rootSortKey = root.canonical;
    const pattern = new vscode.RelativePattern(root.absPath, '**/*.md');
    const exclude = '**/node_modules/**';
    try {
      const uris = await vscode.workspace.findFiles(pattern, exclude);
      if (superseded()) { for (const w of watchers) w.dispose(); return; }
      for (const uri of uris) addToIndex(wikiIndex, uri.fsPath, rootSortKey);
    } catch (err) {
      console.warn('markdown-preview-styles: findFiles failed for root', root.absPath, err);
    }

    const watcher = vscode.workspace.createFileSystemWatcher(pattern);
    watcher.onDidCreate(uri => addToIndex(wikiIndex, uri.fsPath, rootSortKey));
    watcher.onDidDelete(uri => removeFromIndex(wikiIndex, uri.fsPath));
    // onDidChange is a no-op - content edits don't move the file.
    watchers.push(watcher);
  }

  // Commit this rebuild's watchers now that it owns the index.
  _activeWatchers = watchers;
  for (const w of watchers) context.subscriptions.push(w);

  // Refresh any already-open markdown previews. They may have rendered
  // against an empty or stale index; the refresh re-runs the rules with
  // the now-current wikiIndex/wikiConfig in scope. No-op when no previews
  // are open. Wrapped because the command may be unavailable in some
  // VS Code builds.
  try {
    await vscode.commands.executeCommand('markdown.preview.refresh');
  } catch (_) {}
}

// Returns the canonical (realpath-resolved) absolute path, or null if the
// path doesn't exist or isn't accessible. Used to deduplicate symlinked or
// overlapping roots without crashing on missing extraIndexRoots entries.
function canonicalisePath(p) {
  try {
    return fs.realpathSync(p);
  } catch (_) {
    return null;
  }
}

function activate(context) {
  // Async index build runs in the background. Rules registered by
  // extendMarkdownIt close over wikiIndex/wikiConfig which start at sensible
  // defaults and get replaced once findFiles completes. Any preview that
  // rendered against the empty initial index gets a programmatic refresh
  // when the build finishes (see rebuildWorkspaceIndex tail).
  if (context && context.subscriptions) {
    initWorkspaceIndex(context).catch(err =>
      console.warn('markdown-preview-styles: index init failed', err)
    );
  }
  return {
    extendMarkdownIt(md) {
      // ![[path]] and ![[path|N]] - Obsidian-style image embeds.
      // Registered before `link` (markdown-it's built-in inline link rule)
      // so we get a shot at `![[...]]` before markdown-it tries to read
      // it as an image-reference-link. The `!` prefix check ensures we
      // never collide with mps_wikilink (which gates on `[`), so the
      // relative ordering of the two custom rules doesn't matter.
      md.inline.ruler.before('link', 'mps_embed', function (state, silent) {
        const src = state.src;
        const start = state.pos;
        if (src.charCodeAt(start) !== 0x21 /* ! */) return false;
        if (src.charCodeAt(start + 1) !== 0x5B /* [ */) return false;
        if (src.charCodeAt(start + 2) !== 0x5B) return false;
        const max = state.posMax;
        let end = -1;
        for (let i = start + 3; i < max - 1; i++) {
          const c = src.charCodeAt(i);
          if (c === 0x0A /* \n */) return false;
          if (c === 0x5D /* ] */ && src.charCodeAt(i + 1) === 0x5D) { end = i; break; }
        }
        if (end < 0) return false;
        const inner = src.slice(start + 3, end);
        if (!inner.trim()) return false;
        // Pipe-split is only honoured when the right side parses as a
        // positive integer width. Anything else (Obsidian's caption syntax,
        // a literal `|` in the path, junk) leaves the full inner as the path.
        // The old behaviour silently dropped post-pipe content for non-numeric
        // values, hiding the embed's filename when it contained a literal `|`.
        let path = inner.trim();
        let width = null;
        const pipeIdx = inner.indexOf('|');
        if (pipeIdx >= 0) {
          const left = inner.slice(0, pipeIdx).trim();
          const right = inner.slice(pipeIdx + 1).trim();
          if (left && /^\d+$/.test(right)) {
            const parsed = parseInt(right, 10);
            if (parsed > 0) {
              path = left;
              width = Math.min(parsed, MAX_EMBED_WIDTH);
            }
          }
        }
        if (!path) return false;
        if (!silent) {
          // Image branch only fires when the path is BOTH image-shaped AND
          // accepted by safeImgSrc. A `javascript:foo.png`-shaped path passes
          // isImagePath (because of the .png suffix) but is rejected by
          // safeImgSrc - so falls through to the wiki-link branch where
          // safeHref strips the dangerous scheme. Without this gate, the
          // image token was pushed with src='' and rendered as a broken
          // <img> (defence-in-depth gap).
          const imageSrc = isImagePath(path) ? safeImgSrc(path) : '';
          if (imageSrc) {
            // Push a synthetic markdown-it `image` token. VS Code's preview
            // overrides md.renderer.rules.image to rewrite `src` and register
            // the file in containingImages (preview auto-reloads when the
            // attachment changes on disk). Going through the native renderer
            // is the only way to inherit both behaviours.
            //
            // The default image renderer overwrites attrs[alt] via
            // renderInlineAsText(token.children) - so we must populate
            // children with a text token containing the alt content, not
            // leave it empty (the natural inclination). Token.content is
            // unused by the default renderer; children is what matters.
            // Alt is the full basename WITH extension. For accessibility
            // it's the technical identifier; for the broken-image fallback
            // (which renders the alt next to the browser's broken glyph)
            // the extension is useful context ("it was looking for a .png").
            // The wiki-link display elsewhere uses basename-without-ext for
            // readability in body text - different context.
            const altText = String(path).replace(/^.*\//, '');
            const tok = state.push('image', 'img', 0);
            tok.attrs = [
              ['src', imageSrc],
              ['alt', altText],
              ['class', 'mps-embed-image'],
            ];
            if (width !== null) tok.attrs.push(['width', String(width)]);
            tok.content = altText;
            const altTok = new state.Token('text', '', 0);
            altTok.content = altText;
            tok.children = [altTok];
          } else {
            // Non-image OR image-shaped-but-rejected-scheme. Try transcluding
            // (when enabled, target resolves, and size is under cap); otherwise
            // degrade to a wiki-link with meta.embed for the fallback style.
            const transcluded = tryEmitTranscludeToken(state, path);
            if (!transcluded) {
              const tok = state.push('mps_wikilink', '', 0);
              tok.content = path;
              // Resolve here too, so a target that simply wasn't transcluded
              // (embedNotes off, or over the size cap) still gets a working
              // href instead of degrading to a dead bare-name link. Mirrors
              // the mps_wikilink parse rule's resolution.
              const parsed = parseWikilinkTarget(path);
              tok.meta = { embed: true, parsed };
              if (wikiConfig.enabled) {
                const resolved = resolveWikilinkTarget(parsed.name);
                if (resolved) tok.meta.resolvedPath = resolved;
              }
            }
          }
        }
        state.pos = end + 2;
        return true;
      });

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
          // Parse + resolve at token-emit time so the renderer is a pure
          // function over the token's meta. Resolution is skipped when the
          // workspace index is disabled - the renderer then falls back to
          // emitting `content` as a relative href (current behaviour).
          const parsed = parseWikilinkTarget(content);
          token.meta = token.meta || {};
          token.meta.parsed = parsed;
          if (wikiConfig.enabled) {
            const resolved = resolveWikilinkTarget(parsed.name);
            if (resolved) {
              token.meta.resolvedPath = resolved;
              // Document URI lookup happens at RENDER time, not parse time.
              // VS Code's inline rules run before `env` is populated with
              // `currentDocument`, so probing state.env here returns an empty
              // object. The renderer rule receives env as its 4th arg, and
              // by that point currentDocument is available.
            }
          }
        }
        state.pos = end + 2;
        return true;
      });
      // Renderer for the inline transclude token emitted by mps_embed's
      // non-image branch. Reads the resolved file, slices to the fragment,
      // strips frontmatter, and re-renders via the same markdown-it
      // instance with env.mpsEmbedDepth incremented. Depth >= 2 short-
      // circuits to a cycle-fallback link (matches the depth-cap AC).
      md.renderer.rules.mps_embed_note = function (tokens, idx, options, env, self) {
        const tok = tokens[idx];
        const meta = tok.meta || {};
        const e = env || {};
        const depth = e.mpsEmbedDepth || 0;
        // Every degrade path (cycle cap, fragment-miss, read error) renders the
        // same fallback link: a real clickable href via buildResolvedHref (NOT
        // the bare absolute resolvedPath, which VS Code can't navigate), and
        // display text from the parsed target so an alias / fragment in the
        // original `![[...]]` shows cleanly rather than literally.
        const parsedTarget = parseWikilinkTarget(meta.originalTarget || '');
        const fallbackDisplay = parsedTarget.alias != null
          ? parsedTarget.alias
          : basenameWithoutExt(parsedTarget.name || meta.originalTarget || '');
        const fallbackLink = (extraClass) => {
          const cls = 'mps-wiki-link mps-embed-fallback' + (extraClass ? ' ' + extraClass : '');
          const href = meta.resolvedPath
            ? buildResolvedHref(meta.resolvedPath, meta.fragment, docPathFromEnv(e))
            : '';
          if (!href) return `<span class="${cls}">${escapeHtml(fallbackDisplay)}</span>`;
          return `<a class="${cls}" href="${escapeHtml(href)}">${escapeHtml(fallbackDisplay)}</a>`;
        };
        // Cycle-cap: at depth 2, refuse to expand. mps-embed-cycle marks it
        // visually distinct from a fresh embed.
        if (depth >= 2) return fallbackLink('mps-embed-cycle');
        let body = '';
        try {
          const raw = wikiReadFile(meta.resolvedPath);
          const stripped = stripFrontmatter(raw);
          const sliced = sliceToFragment(stripped, meta.fragment);
          if (!sliced) return fallbackLink(); // fragment not found in target
          const innerEnv = Object.assign({}, e, { mpsEmbedDepth: depth + 1 });
          if (typeof md.render === 'function') {
            body = md.render(sliced, innerEnv);
          } else {
            // Stub markdown-it in unit tests has no render(). Emit the raw
            // sliced source so the wrapper assertion still passes; the real
            // VS Code preview path uses the live md.render.
            body = escapeHtml(sliced);
          }
        } catch (err) {
          // Read failure (race with index, permissions). Fall back to a
          // link rather than crashing the whole preview render.
          return fallbackLink();
        }
        return `<div class="mps-embed-note" data-source="${escapeHtml(meta.resolvedPath)}"><div class="mps-embed-note-body">${body}</div></div>`;
      };

      md.renderer.rules.mps_wikilink = function (tokens, idx, options, env) {
        const tok = tokens[idx];
        const content = tok.content || '';
        // Derive parse lazily so the renderer keeps working when called
        // directly (frontmatter renderText, unit tests) with only .content.
        const parsed = (tok.meta && tok.meta.parsed) || parseWikilinkTarget(content);
        // Display: alias if given; else the basename; else (pure fragment, no
        // name) the fragment's own text - the heading/block id minus its
        // leading marker - rather than the raw `#frag` content.
        const display = parsed.alias != null
          ? parsed.alias
          : (parsed.name
              ? basenameWithoutExt(parsed.name)
              : (parsed.fragment ? parsed.fragment.slice(1) : content));
        // docPath (previewed document's path) is read from env at RENDER time -
        // see docPathFromEnv for why parse-time isn't reliable and why both
        // currentDocument and resourceProvider.resource are consulted.
        const docPath = docPathFromEnv(env);
        // Three href shapes, in priority order:
        //   - resolved target → buildResolvedHref (relative / vscode://file /
        //     bare-fragment self-link); resolver output is trusted, no safeHref.
        //   - no index hit → safeHref-guarded raw name (rejects dangerous
        //     schemes, preserves the pre-resolution document-relative behaviour).
        let href;
        const meta = tok.meta || {};
        if (meta.resolvedPath) {
          href = buildResolvedHref(meta.resolvedPath, parsed.fragment, docPath);
        } else if (parsed.name) {
          // Unresolved named link: document-relative raw name + anchor.
          href = safeHref(parsed.name + fragmentToAnchor(parsed.fragment));
        } else if (parsed.fragment) {
          // Pure fragment ([[#heading]] / [[^block]]): same-document anchor,
          // no name. Using `content` here would double the fragment (content
          // already IS the fragment) and feed safeHref a leading-# string.
          href = fragmentToAnchor(parsed.fragment);
        } else {
          href = safeHref(content);
        }
        // Tokens emitted by mps_embed for non-image embeds carry meta.embed so
        // the rendered anchor can be styled distinctly.
        const classes = ['mps-wiki-link'];
        if (tok.meta && tok.meta.embed) classes.push('mps-embed-fallback');
        const cls = classes.join(' ');
        // Empty href falls back to the inert span - covers [[javascript:...]]
        // and similar dangerous schemes.
        if (!href) return `<span class="${cls}">${escapeHtml(display)}</span>`;
        return `<a class="${cls}" href="${escapeHtml(href)}">${escapeHtml(display)}</a>`;
      };

      // Block-ref anchors: `^block-id` at the end of a paragraph or list item
      // creates a scroll target. Walks the token stream looking for inline
      // tokens whose content ends with ` ^id`, strips the marker, and adds
      // `id="mps-block-<id>"` to the wrapping block-level open token.
      // Runs unconditionally so any preview containing ^id markers gets the
      // anchor regardless of whether a wikilink targets it. Must run before
      // mps_callouts so a marker on a callout's first line still works.
      md.core.ruler.push('mps_block_anchors', function (state) {
        const tokens = state.tokens;
        // Inside a transcluded embed, still strip the ^id marker (so the
        // embedded text reads cleanly) but DON'T emit id="mps-block-<id>" -
        // the host document already carries that id (or will, if the note is
        // also open standalone), and a duplicate id is invalid HTML with an
        // ambiguous scroll target.
        const embedded = !!(state.env && state.env.mpsEmbedDepth);
        for (let i = 0; i < tokens.length; i++) {
          const tok = tokens[i];
          if (tok.type !== 'inline' || !tok.content) continue;
          // Trailing block marker: optional whitespace, then ^id (Crockford-
          // safe alphanumerics + hyphen), then end of content.
          const m = tok.content.match(/^([\s\S]*?)\s\^([A-Za-z0-9_-]+)\s*$/);
          if (!m) continue;
          // Find the wrapping block-level open token. Walk backwards from
          // this inline token; the open is the most recent token whose
          // .nesting === 1 at the same level - 1 of this inline (which sits
          // at level = open.level + 1). For our purposes, scan back for the
          // first open token whose tag is one of the carriers we recognise.
          let openIdx = -1;
          for (let j = i - 1; j >= 0; j--) {
            const t = tokens[j];
            if (t.nesting === -1) continue; // skip close tokens
            // Prefer list_item_open if it directly precedes; else fall back
            // to paragraph_open / heading_open as the carrier.
            if (t.type === 'paragraph_open' || t.type === 'heading_open') {
              openIdx = j;
              // Look one more step back: if the immediately preceding open
              // is list_item_open at the same source line, hoist to it so
              // the anchor lands on the <li> not the inner <p>.
              const prev = tokens[j - 1];
              if (prev && prev.type === 'list_item_open') openIdx = j - 1;
              break;
            }
            if (t.type === 'list_item_open') { openIdx = j; break; }
            if (t.nesting === 1) { openIdx = j; break; }
          }
          if (openIdx < 0) continue;
          if (!embedded) tokens[openIdx].attrSet('id', 'mps-block-' + m[2]);
          // Strip the marker from inline content and re-parse children if
          // the inline parser is available (real markdown-it). Stub markdown-it
          // in tests has no inline.parse, so leave children as-is - tests
          // assert on .content, which is the load-bearing surface.
          tok.content = m[1].replace(/\s+$/, '');
          if (state.md && state.md.inline && typeof state.md.inline.parse === 'function') {
            const out = [];
            state.md.inline.parse(tok.content, state.md, state.env || {}, out);
            tok.children = out;
          }
        }
      });

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
          // Strip source-map attrs from the container so VS Code's
          // active-line tracker doesn't pick it. pluginSourceMap gives
          // every token with .map the `data-line` + `code-line` pair so
          // its `ce()` finder can match it. The container and the title
          // share the same line, which means both end up in the candidate
          // list - and the container (first in DOM order) wins. Its
          // gutter number is hidden by CSS, so the user sees nothing
          // brighten when the caret is on the title line. Drop the attrs
          // here so only the title carries them.
          //
          // We deliberately keep .map intact: mps_blank_lines below uses
          // every level-0 token's map for gap detection between top-level
          // blocks, and clearing it leaves the gap between adjacent
          // callouts un-spaced. In VS Code's load order pluginSourceMap
          // runs BEFORE this rule, so stripping the attrs here is final.
          // The harness order is reversed and pluginSourceMap re-adds
          // them, but visually it doesn't matter - the catch-all CSS
          // suppresses the container's gutter regardless.
          if (open.attrs) {
            open.attrs = open.attrs.filter(a => a[0] !== 'data-line' && a[0] !== 'dir');
            const classAttr = open.attrs.find(a => a[0] === 'class');
            if (classAttr) {
              classAttr[1] = classAttr[1].split(/\s+/).filter(c => c && c !== 'code-line').join(' ');
              if (!classAttr[1]) open.attrs = open.attrs.filter(a => a[0] !== 'class');
            }
          }
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
        // Skip inside a transcluded embed: the line numbers and blank-line
        // placeholders are source-mapped to the EMBEDDED note's lines, not the
        // host document's, so emitting them injects data-line/data-mps-line
        // values that collide with the host's and mislead VS Code's active-line
        // tracker / double-click-to-jump. Embedded content carries no gutter.
        if (state.env && state.env.mpsEmbedDepth) return;
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
          html = renderProperties(data, docPathFromEnv(state.env));
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
exports.parseWikilinkTarget = parseWikilinkTarget;
exports.resolveWikilinkTarget = resolveWikilinkTarget;
exports.addToIndex = addToIndex;
exports.removeFromIndex = removeFromIndex;
exports.expandTilde = expandTilde;
exports.buildResolvedHref = buildResolvedHref;
exports.safeHref = safeHref;
exports.safeImgSrc = safeImgSrc;
exports.__setWikiStateForTest = __setWikiStateForTest;
exports.__resetWikiStateForTest = __resetWikiStateForTest;
// Exported for the concurrency test (rebuild generation guard). Takes the
// same (context, vscode) it gets in production; a test passes a mock vscode.
exports.__rebuildWorkspaceIndexForTest = rebuildWorkspaceIndex;
