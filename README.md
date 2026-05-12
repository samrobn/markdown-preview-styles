# markdown-preview-styles

Local-only VS Code extension that customises the built-in markdown preview, globally across every workspace. Never published; sideloaded via symlink.

Two things it does:

1. Injects custom CSS into every preview (`markdown.previewStyles`).
2. Prepends an Obsidian-style **Properties** table above any markdown file with YAML frontmatter (`markdown.markdownItPlugins`, see `extension.js`).

## How it works

VS Code's `markdown.previewStyles` contribution point loads any CSS bundled with an extension into every markdown preview, in every workspace, with no webview security restrictions. This sidesteps the limitations of the `markdown.styles` user setting, which rejects absolute paths and `file://` URLs and only accepts workspace-relative paths.

The Properties table is rendered by a markdown-it plugin registered via `extendMarkdownIt`. It extracts the leading `---` YAML block from `state.src`, parses it with a minimal in-tree parser (no `node_modules`), and prepends an `html_block` token to `state.tokens`. The original frontmatter block is hidden by VS Code's built-in handling, so it isn't duplicated.

**Implementation gotcha:** VS Code's preview calls `md.parse(src)` + `md.renderer.render(tokens, ...)` directly - it does NOT call `md.render(src)`. So wrapping or overriding `md.render` in `extendMarkdownIt` silently does nothing. Inject via `md.core.ruler.push(name, fn)`, `md.block.ruler.before(...)`, or `md.renderer.rules[type] = fn` - those sit inside the actual pipeline.

Supported frontmatter shapes: top-level scalars (string, boolean, null, ISO date `YYYY-MM-DD`, ISO datetime `YYYY-MM-DDTHH:MM[...]`), block-style arrays (`tags:` followed by `  - foo`), and inline arrays (`tags: [foo, bar]`). Numeric-looking values stay as strings to preserve IDs like `task-id: 20260101`. Nested objects, multiline strings, anchors, and flow maps are not supported.

Inside Properties string values, `https://...` URLs become clickable links. `[[wiki-links]]` are styled both inside Properties values and anywhere in the document body (via a markdown-it inline rule). Wiki-links are not yet clickable - no vault resolution. Date-only values are formatted without timezone shift so the day always matches what's in the YAML.

Reference: https://code.visualstudio.com/api/extension-guides/markdown-extension

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

Remove any older versioned symlinks (e.g. `local.markdown-preview-styles-0.0.1`) so VS Code doesn't load both.

## Making changes

Minimum reload step by change type (verified empirically):

| Change                                            | Minimum reload                                       |
|---------------------------------------------------|------------------------------------------------------|
| `extension.js`                                    | Disable + re-enable extension (Extensions sidebar)   |
| `style.css`                                       | Close + reopen the preview tab (Cmd+Q if that fails) |
| `package.json` (contributions, capabilities, etc) | **Cmd+Q and relaunch** - manifest is scanned at startup |
| Version bump in `package.json`                    | Rename symlink folder to match, then Cmd+Q           |

`Developer: Reload Window` is rarely enough for any of these - the markdown preview caches its compiled markdown-it instance across window reloads.

No build step. No `node_modules`. No publishing.

## Example

`example.md` at the project root exercises every Properties-table feature in one file (every type, pill rendering, wiki-link, URL, date, datetime, empty value, flat headings). Open the preview with Cmd+K V to verify rendering after changes.

## Current rules

- Caps preview width at 880px and left-aligns content (no centring).
- Removes the default `border-bottom` under `h1` and `h2` (Obsidian-style flat headings).
- Suppresses VS Code's source-line hover indicator (the left-edge bar that appeared on hover) and replaces it with permanent line numbers in a 3.5em left gutter, sourced from `data-line` attributes that VS Code already emits on body blocks.
- Renders YAML frontmatter as a Properties table above the document, with type-aware icons (text / list / tags / date / datetime / checkbox) and pill chips for `tags` and string arrays. Non-editable (v1).
- Auto-links `https://...` URLs in Properties string values.
- Styles `[[wiki-links]]` everywhere - in Properties values and in the document body. Not clickable (see Known limitations).
- Add `mps-hide: true` to a file's frontmatter to suppress the Properties table for that file.

## Known limitations

- **Wiki-links and PARA refs (e.g. `[[TASK-…]]`, `parent: TASK-20260402-…`) are styled but not clickable.** Resolving them properly requires a workspace search (the referenced file is typically in a different folder from the source), which needs a command registration and async lookup. Out of scope for v1; revisit alongside other vault-aware features.
