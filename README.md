# markdown-preview-styles

Local-only VS Code extension that injects custom CSS into the built-in markdown preview, globally across every workspace. Never published; sideloaded via symlink.

## How it works

VS Code's `markdown.previewStyles` contribution point loads any CSS bundled with an extension into every markdown preview, in every workspace, with no webview security restrictions. This sidesteps the limitations of the `markdown.styles` user setting, which rejects absolute paths and `file://` URLs and only accepts workspace-relative paths.

Reference: https://code.visualstudio.com/api/extension-guides/markdown-extension

## Install / re-install

The extension is symlinked into VS Code's extensions directory:

```
~/.vscode/extensions/local.markdown-preview-styles-0.0.1  →  ~/Dev/vscode-extensions/markdown-preview-styles
```

If the symlink is missing (new machine, accidental deletion):

```bash
ln -s ~/Dev/vscode-extensions/markdown-preview-styles \
      ~/.vscode/extensions/local.markdown-preview-styles-0.0.1
```

The symlink folder name must match `<publisher>.<name>-<version>` from `package.json` for VS Code to load it.

## Making changes

- Edit `style.css` and **fully quit + reopen VS Code** (Cmd+Q, then relaunch). Reload Window is not enough for sideloaded extensions to re-read their contributed files.
- For schema/manifest changes in `package.json`, bump the version in both `package.json` and the symlink folder name.
- No build step. No `node_modules`. No publishing.

## Current rules

- Caps preview width at 880px and left-aligns content (no centring).
