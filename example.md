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

Wiki-links in body text get the same `.mps-wiki-link` styling as Properties values:

**See**: [[related-document]] for background (one step → another step → final step).

The version in backticks renders as literal text for contrast: `[[related-document]]`. Wiki-links are still not clickable.

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

Obsidian-style image embeds. `![[path]]` renders the file inline if the extension is image-like; `![[path|N]]` constrains the width to N px (aspect ratio preserved). Path resolution is document-relative.

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

Long lines overflow horizontally rather than wrapping, so wide source stays legible:

```js
const veryLongVariableName = someFunctionThatTakesMany(argumentOne, argumentTwo, argumentThree, argumentFour, argumentFive, argumentSix);
```

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
