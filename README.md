# markdown-preview-styles

[![CI](https://github.com/samrobn/markdown-preview-styles/actions/workflows/ci.yml/badge.svg)](https://github.com/samrobn/markdown-preview-styles/actions/workflows/ci.yml)

Local-only VS Code extension that customises the built-in markdown preview, globally across every workspace. Never published; sideloaded via symlink.

Two things it does:

1. Injects custom CSS into every preview (`markdown.previewStyles`).
2. Prepends an Obsidian-style **Properties** table above any markdown file with YAML frontmatter, plus a source-line gutter and other tweaks (`markdown.markdownItPlugins`).

![Preview of example.md with the extension active](docs/preview.png)

## Install / re-install

The extension is symlinked into VS Code's extensions directory. The folder name must match `<publisher>.<name>-<version>` from `package.json`:

```
~/.vscode/extensions/local.markdown-preview-styles-0.1.0  →  ~/Dev/vscode-extensions/markdown-preview-styles
```

If the symlink is missing (new machine, accidental deletion, or after a version bump):

```bash
ln -s ~/Dev/vscode-extensions/markdown-preview-styles \
      ~/.vscode/extensions/local.markdown-preview-styles-0.1.0
```

Remove any older versioned symlinks (e.g. `local.markdown-preview-styles-0.0.1`) so VS Code doesn't load both, then fully quit and relaunch VS Code (`Cmd+Q`).

## Related VS Code settings

The extension's defaults assume a few preview settings. Only `breaks` differs from VS Code's stock defaults; the others are noted for awareness:

- `"markdown.preview.breaks": true` - renders consecutive source lines as separate lines (Obsidian-style). Without this, a single newline collapses into a space within the same paragraph.
- `"markdown.preview.lineHeight": 1.6` *(default)* - `.mps-blank-line` is calibrated to `1.06lh` against this; changing it shifts the gutter rhythm.
- `"markdown.preview.fontSize": 15` - this repo is calibrated at 15 (VS Code's stock default is 14). The `em`-based spacing in `style.css` scales with whatever you set here.
- `"markdown.preview.linkify": true` *(default)* - auto-links bare URLs in body text; complements our Properties-value URL linking.
- `"markdown.preview.markEditorSelection": true` *(default)* - shows the editor-caret line in the preview. The hover-indicator variant is suppressed (line numbers occupy that pseudo-element); the active-line is instead highlighted by brightening its gutter line number, same convention as the editor.
- `"markdown.preview.doubleClickToSwitchToEditor": false` - VS Code defaults this to `true`; disable if you'd rather double-click select text in the preview than jump back to the editor. The visible line-number gutter still lets you eyeball the source row.
- `"markdown.preview.typographer": false` *(default)* - enable if you want smart quotes (`"x"` → `"x"`) and en/em dash auto-conversion.

## Example

`example.md` at the project root exercises every Properties-table feature in one file. Open the preview with `Cmd+K V` after install to verify everything renders.

## Current rules

- Caps preview width at 880px and left-aligns content (no centring).
- Removes the default `border-bottom` under `h1` and `h2` (Obsidian-style flat headings).
- Replaces VS Code's source-line hover indicator with permanent 1-indexed line numbers in a 4em left gutter; numbers also appear next to blank source lines.
- Default block margins on body content are zeroed so vertical spacing comes from blank-line placeholders - one source line ≈ one visual row, matching the editor's gutter rhythm.
- Inline code (backtick-quoted spans) shrunk to `0.9em`. Fenced code blocks inside `<pre>` are untouched.
- Renders YAML frontmatter as a Properties table with type-aware icons (text / list / tags / date / datetime / checkbox) and pill chips for `tags` and string arrays. Non-editable (v1).
- Auto-links `https://...` URLs in Properties values; styles `[[wiki-links]]` everywhere (in Properties values and document body) as `<a>` tags with basename-without-extension visible text - so `[[notes/2026-meeting]]` displays as `2026-meeting`. VS Code's webview resolves relative `href`s on click via the document-link handler.
- Renders Obsidian-style image embeds (`![[image.png]]`, with optional `![[image.png|N]]` for a px width). Path resolution is document-relative; bare filenames are retried under `attachments/` on first error. Non-image extensions degrade to a wiki-link rather than an embed. Failed loads show a dashed placeholder with the original path.
- Add `mps-hide: true` to a file's frontmatter to suppress the Properties table for that file.

## Supported frontmatter

Top-level scalars (string, boolean, null, ISO date `YYYY-MM-DD`, ISO datetime `YYYY-MM-DDTHH:MM[...]`), block-style arrays (`tags:` followed by `  - foo`), and inline arrays (`tags: [foo, bar]`). Numeric values stay as strings to preserve IDs like `task-id: 20260101`. Nested objects, multiline strings, anchors, and flow maps are not supported.

Date-only values are formatted without timezone shift so the day always matches what's in the YAML.

## Known limitations

- **Wiki-link resolution is document-relative, not vault-wide.** A bare `[[note-name]]` won't find `note-name.md` somewhere else in the workspace - it tries to resolve relative to the current file. For image embeds, the resolver also retries with an `attachments/` prefix on first error. Vault-wide basename resolution would need a workspace index and is out of scope for now.
- **Wiki-link `<a>` clicks go through VS Code's webview link handler.** Non-existent targets surface a "file not found" toast rather than navigating anywhere - no in-preview broken-link styling.
- **Image embed visible-text change.** Wiki-link display text is the path's basename without extension (matches Obsidian). Existing notes that used directory-prefixed wiki-links like `[[notes/2026-meeting]]` now show just `2026-meeting`. The full path remains in the `href`.

## Development

See [CLAUDE.md](CLAUDE.md) for the reload-by-change-type matrix, architecture gotchas, tests, and project conventions.
