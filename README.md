# markdown-preview-styles

Local-only VS Code extension that customises the built-in markdown preview, globally across every workspace. Never published; sideloaded via symlink.

Two things it does:

1. Injects custom CSS into every preview (`markdown.previewStyles`).
2. Prepends an Obsidian-style **Properties** table above any markdown file with YAML frontmatter, plus a source-line gutter and other tweaks (`markdown.markdownItPlugins`).

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

## Example

`example.md` at the project root exercises every Properties-table feature in one file. Open the preview with `Cmd+K V` after install to verify everything renders.

## Current rules

- Caps preview width at 880px and left-aligns content (no centring).
- Removes the default `border-bottom` under `h1` and `h2` (Obsidian-style flat headings).
- Replaces VS Code's source-line hover indicator with permanent 1-indexed line numbers in a 4em left gutter; numbers also appear next to blank source lines.
- Default block margins on body content are zeroed so vertical spacing comes from blank-line placeholders - one source line ≈ one visual row, matching the editor's gutter rhythm.
- Inline code (backtick-quoted spans) shrunk to `0.9em`. Fenced code blocks inside `<pre>` are untouched.
- Renders YAML frontmatter as a Properties table with type-aware icons (text / list / tags / date / datetime / checkbox) and pill chips for `tags` and string arrays. Non-editable (v1).
- Auto-links `https://...` URLs in Properties values; styles `[[wiki-links]]` everywhere (in Properties values and document body). Wiki-links are not clickable - see Known limitations.
- Add `mps-hide: true` to a file's frontmatter to suppress the Properties table for that file.

## Supported frontmatter

Top-level scalars (string, boolean, null, ISO date `YYYY-MM-DD`, ISO datetime `YYYY-MM-DDTHH:MM[...]`), block-style arrays (`tags:` followed by `  - foo`), and inline arrays (`tags: [foo, bar]`). Numeric values stay as strings to preserve IDs like `task-id: 20260101`. Nested objects, multiline strings, anchors, and flow maps are not supported.

Date-only values are formatted without timezone shift so the day always matches what's in the YAML.

## Known limitations

- **Wiki-links and PARA refs (e.g. `[[TASK-…]]`, `parent: TASK-20260402-…`) are styled but not clickable.** Resolving them properly requires a workspace search (the referenced file is typically in a different folder from the source), which needs a command registration and async lookup. Out of scope for v1; revisit alongside other vault-aware features.

## Development

See [CLAUDE.md](CLAUDE.md) for the reload-by-change-type matrix, architecture gotchas, tests, and project conventions.
