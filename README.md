# markdown-preview-styles

Local-only VS Code extension that customises the built-in markdown preview, globally across every workspace. Never published; sideloaded via symlink.

Two things it does:

1. Injects custom CSS into every preview (`markdown.previewStyles`).
2. Prepends an Obsidian-style **Properties** table above any markdown file with YAML frontmatter (`markdown.markdownItPlugins`, see `extension.js`).

## How it works

VS Code's `markdown.previewStyles` contribution point loads any CSS bundled with an extension into every markdown preview, in every workspace, with no webview security restrictions. This sidesteps the limitations of the `markdown.styles` user setting, which rejects absolute paths and `file://` URLs and only accepts workspace-relative paths.

The Properties table is rendered by a markdown-it plugin registered via `extendMarkdownIt`. It extracts the leading `---` YAML block from `state.src`, parses it with a minimal in-tree parser (no `node_modules`), and prepends an `html_block` token to `state.tokens`. The original frontmatter block is hidden by VS Code's built-in handling, so it isn't duplicated.

**Implementation gotcha:** VS Code's preview calls `md.parse(src)` + `md.renderer.render(tokens, ...)` directly - it does NOT call `md.render(src)`. So wrapping or overriding `md.render` in `extendMarkdownIt` silently does nothing. Inject via `md.core.ruler.push(name, fn)`, `md.block.ruler.before(...)`, or `md.renderer.rules[type] = fn` - those sit inside the actual pipeline.

Supported frontmatter shapes: top-level scalars (string, number, boolean, null, ISO date, ISO datetime), block-style string arrays (`tags:` followed by `  - foo`), and inline arrays (`tags: [foo, bar]`). Nested objects, multiline strings, anchors, and flow maps are not supported.

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

## Current rules

- Caps preview width at 880px and left-aligns content (no centring).
- Renders YAML frontmatter as a Properties table above the document, with type-aware icons (text / list / tags / date / datetime / number / checkbox) and pill chips for `tags` and string arrays. Non-editable (v1).
