---
doc-type: example
task-id: 20260101
title: Properties table showcase
status: draft
priority: medium
published: true
tags: [obsidian, vscode, markdown, demo]
contributors:
  - alice
  - bob
  - charlie
parent: [[TASK-20260101-ABCD-example-parent]]
reference: https://code.visualstudio.com/api/extension-guides/markdown-extension
description: See [[parent-task]] for background, or visit https://example.com for more.
created: 2026-05-07
modified: 2026-05-12T14:30
completed:
blocked-on:
---

# Heading 1 - flat, no border

Body text below the Properties table. The preview is capped at 880px and left-aligned.

## Heading 2 - also flat

Default VS Code preview adds a `border-bottom` under `h1` / `h2`. This extension removes it for an Obsidian-like flat-heading look.

### Heading 3 - VS Code default

`h3` and below are unchanged.

## What each property demonstrates

| Property       | Feature exercised                                                          |
|----------------|----------------------------------------------------------------------------|
| `task-id`      | Numeric-looking strings stay as strings (no `parseInt`). No quoting needed. |
| `published`    | Booleans render with the checkbox icon.                                     |
| `tags`         | Inline string arrays render as pills.                                       |
| `contributors` | Block-style string arrays also render as pills.                             |
| `parent`       | `[[wiki-link]]` values are detected and styled (no resolution yet).        |
| `reference`    | `https://...` URLs become clickable.                                        |
| `description`  | Wiki-links and URLs within the same string both render.                     |
| `created`      | `YYYY-MM-DD` formats to `dd/mm/yyyy` with no timezone shift.                |
| `modified`     | `YYYY-MM-DDTHH:MM` formats to `dd/mm/yyyy, HH:MM` (local time).             |
| `completed`    | Empty values show as italicised "Empty".                                    |

## Opt-out

Add `mps-hide: true` to a file's frontmatter to suppress the Properties table for that one file. Not used here, obviously.

## Inline checks

URLs in body text are unaffected by this extension - markdown-it handles those: <https://example.com>. Wiki-links in body text are also unaffected: `[[these-stay-literal]]`.
