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

Two consecutive source lines with no blank line between them - with `markdown.preview.breaks: true` they render as separate visual lines; without that setting they collapse into one paragraph joined by a space.

First line of a soft-break pair.
Second line, no blank line above it.

URLs in body text are handled by markdown-it: <https://example.com>.

Wiki-links in body text get the same `.mps-wiki-link` styling as Properties values, and resolve against a workspace-wide index of `.md` files. Clicking a resolved link navigates in-place (no OS prompt, preview mode), the same as a plain `[text](relative.md)` link.

### Wiki-link and embed formats

Every supported `[[...]]` / `![[...]]` form, with a live example resolving against the fixtures in `test/visual/fixtures/notes/`:

- **Basic** - `[[related-document]]` → [[related-document]]. Resolved by basename, case-insensitively; the shortest path wins on collision.
- **Heading fragment** - `[[short-note#Section A]]` → [[short-note#Section A]]. The href anchor is slugified to match the heading's id.
- **Block fragment** - `[[old-task^archived-block]]` → [[old-task^archived-block]]. Targets a `^block-id` marker (block ids are `[A-Za-z0-9_-]`).
- **Alias** - `[[related-document|see the neighbour]]` → [[related-document|see the neighbour]]. Resolves the name, displays the alias. Fragment goes before the pipe: `[[name#heading|alias]]`.
- **Same-document fragment** - `[[#Lists]]` → [[#Lists]]. Empty name, so it links to a heading in *this* file.
- **Folder-qualified** - `[[notes/short-note]]` → [[notes/short-note]]. A path prefix is accepted (Foam/Dendron style); only the final basename is matched.
- **Note transclusion** - `![[short-note#Section A]]` inlines the target's content in an `.mps-embed-note` container, falling back to a link when the target is missing, over `embedMaxBytes`, or a cycle is detected (block demo below).
- **Image embed** - `![[image.png]]` renders the file inline; `![[image.png|N]]` constrains the width to N px (aspect ratio preserved). Resolves document-relative, not via the index (block demos in *Image embeds* below).

A `[[...]]` with no index match stays a document-relative link, and the backtick form `` `[[related-document]]` `` renders as literal text.

Note transclusion, `![[short-note#Section A]]`:

![[short-note#Section A]]

## Lists

Unordered list with `*` markers:

* First item
* Second item with a longer line that wraps onto a second visual row to check hanging indentation
* Third item
  * Nested with two-space indent
  * Another nested item
    * Third level
* Back to top level

Unordered list with `-` markers:

- Alpha
- Bravo
- Charlie
  - Charlie one
  - Charlie two
- Delta

Ordered list:

1. Read the file
2. Make the change
3. Run the tests
   1. Unit tests first
   2. Then integration
4. Commit

Mixed nesting (ordered inside unordered, and vice versa):

- Outer bullet
  1. Inner step one
  2. Inner step two
- Another outer bullet
  1. Inner step

Task list with `- [ ]` and `- [x]`:

- [ ] Open task
- [x] Completed task
- [ ] Task with **bold** and `code` and a [[wiki-link]] inside
- [x] Completed task that wraps across two lines to verify the checkbox stays aligned with the first line, not the second
- [ ] Parent task
  - [x] Subtask done
  - [ ] Subtask pending
  - [ ] Subtask with its own children
    - [x] Grandchild done
    - [ ] Grandchild pending

## Image embeds

The `![[image]]` format from the list above, at block size to exercise width and broken-image handling.

Bare embed (full width up to the 880px preview cap):

![[attachments/example-image.svg]]

Width-constrained:

![[attachments/example-image.svg|200]]

Bare filename with the `attachments/` fallback (preview.js retries with `attachments/` prefix on first error):

![[example-image.svg]]

Non-image extension degrades to a wiki-link rather than an embed:

![[example-document.pdf]]

Deliberately missing image - exercises the broken-image placeholder:

![[example-broken.png]]

## Code blocks

Fenced block with a language hint - markdown-it forwards the tag to VS Code's syntax highlighter, which colours tokens against the active theme:

```js
function greet(name) {
  return `Hello, ${name}!`;
}
console.log(greet('world'));
```

Fenced block with no language - rendered in the editor monospace font with no highlighting:

```
plain text
  indentation
    is preserved
end.
```

Different language, to confirm theme colours track per language:

```python
def fizzbuzz(n: int) -> str:
    if n % 15 == 0: return "FizzBuzz"
    if n % 3 == 0:  return "Fizz"
    if n % 5 == 0:  return "Buzz"
    return str(n)
```

Indented code block (markdown's pre-fenced syntax - four leading spaces, no language hint possible):

    const subtotal = items.reduce(
      (sum, item) => sum + item.price,
      0
    );

A fence inside a fence - use more backticks on the outer pair so the inner ` ``` ` survives:

````md
```js
const x = 1;
```
````

Long lines grow the block rightward into the free space beside the 880px text column, up to the window edge - then scroll. Wide source stays on one line as far as the window allows, instead of being squashed into the prose column:

```js
const veryLongVariableName = someFunctionThatTakesMany(argumentOne, argumentTwo, argumentThree, argumentFour, argumentFive, argumentSix);
```

## Wide tables

A table with more columns than the 880px column can hold grows rightward into the free space rather than squashing every cell, capping at the window edge (where cells start to wrap). Narrow the window to watch it reflow. A table that fits the column - like the Properties one above - is left untouched.

| Endpoint         | Method | Auth   | Rate limit | Request body        | Success | Notes                                                                        |
|------------------|--------|--------|------------|---------------------|---------|------------------------------------------------------------------------------|
| `/api/users`     | GET    | Bearer | 100/min    | -                   | 200     | Paginated; pass `?page=` and `?limit=` query params. Defaults to 20 per page. |
| `/api/users/:id` | GET    | Bearer | 100/min    | -                   | 200     | Returns 404 when the id is unknown, or 410 if the user was permanently deleted. |
| `/api/users`     | POST   | Bearer | 20/min     | `{name, email}`     | 201     | Email must be globally unique; responds 409 Conflict on collision.            |
| `/api/users/:id` | PATCH  | Bearer | 20/min     | `{name?, email?}`   | 200     | Partial update; omitted fields are left exactly as-is, no-op bodies still 200. |
| `/api/sessions`  | POST   | None   | 5/min      | `{email, password}` | 200     | Sets the httpOnly session cookie on success; 401 with a generic bad-credentials message. |

## Callouts

Obsidian-style callouts using the `> [!type]` syntax. Each callout has a type, an optional custom title, and body content.

> [!note] Default note
> Plain note with a one-line body. The default type for unrecognised callout keywords.

> [!abstract] Abstract / summary / tldr
> Short overview of a longer document. Aliases: `summary`, `tldr`.

> [!info] Informational
> Neutral context the reader should know about, but not act on.

> [!todo] Outstanding action
> Something the reader needs to do later. Distinct from `tip` - this is a task, not advice.

> [!tip] Helpful suggestion
> Optional advice that improves the outcome. Aliases: `hint`, `important`.

> [!success] Confirmed working
> The thing described above has been verified. Aliases: `check`, `done`.

> [!question] Open question
> Something not yet resolved. Aliases: `help`, `faq`.

> [!warning] £50 threshold on full cart, not partial fulfilment
>
> _Discovered 2026-05-07_
>
> The ≥£50 trigger uses the **full cart total** - including items fulfilled elsewhere and digital products - not just the partial portion. Lightweight low-value parcels therefore route the premium service whenever cart additions push the total over £50. Aliases: `caution`, `attention`.

> [!failure] Known broken
> The described approach was tried and didn't work. Aliases: `fail`, `missing`.

> [!danger] Do not do this
> Hard rule - taking this action causes data loss or breaks a downstream system. Aliases: `error`.

> [!bug] Tracked defect
> A specific bug currently open. Link to the ticket in the body.

> [!example] Worked example
> Step-by-step illustration of the concept. Often paired with a code block.
>
> ```js
> const total = items.reduce((sum, item) => sum + item.price, 0);
> ```

> [!quote] Source attribution
> "The preview is capped at 880px and left-aligned." - this file, three sections up.

### Variants

> [!info]- Foldable, default collapsed
> Append `-` to the type to make the callout foldable and start it collapsed.

> [!info]+ Foldable, default expanded
> Append `+` to the type to make the callout foldable but start it expanded.

> [!warning]
> Callout with no custom title - the type name is used as the heading.

> [!info] Nested callouts
> Callouts can contain other callouts by indenting the inner `>` prefix.
>
> > [!tip] Nested tip
> > Useful when a side-note needs its own side-note.
