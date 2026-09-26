# HTML Islands

Self-contained styled HTML in chat messages is auto-extracted into a Shadow DOM container ("island"). This isolates card `<style>` rules from the chat UI and prevents markdown from corrupting interactive markup.

## Detection

A block-level element (`<div>`, `<section>`, `<article>`, `<aside>`, `<nav>`, `<main>`, `<header>`, `<footer>`, `<form>`, `<fieldset>`, `<figure>`, `<details>`) becomes an island when its content contains a `<style>` tag. Full HTML wrappers (`<html>`, `<body>`) containing authored styles are also isolated.

Blocks that use three or more inline `style="..."` attributes stay in the normal document tree so document-level CSS, controls, event delegation, and observers can reach them. Lumiverse places a light-DOM spacing shell around those blocks to reserve the same visual-effects bleed room as an island without creating a Shadow DOM boundary.

Standalone `<style>` blocks not inside a wrapper element are extracted together with any subsequent sibling HTML, including complete document-shaped markup.

## Markdown inside widget elements

Block markdown is only re-applied when text sits directly inside block containers such as `<div>`, `<section>`, `<article>`, `<blockquote>`, `<li>`, or table cells. Text inside phrasing-only or inline containers like `<span>`, `<a>`, `<strong>`, `<em>`, `<label>`, `<button>`, headings, paragraphs, and form controls is rendered with inline markdown only, so leading `+`, `-`, `*`, or `#` stay literal instead of turning into nested lists or headings that would break the surrounding HTML.

## Opting out with `data-no-island`

Add `data-no-island` to the outer block element's opening tag to render its content inline instead of inside a shadow root:

```html
<div data-no-island>
  <style>
    .my-panel { color: red; }
  </style>
  <div class="my-panel">Inline with the rest of the message.</div>
</div>
```

Useful when content needs:

- document-level click delegation (e.g. `[data-extension-trigger]` listeners on `document`)
- CSS cascade into surrounding DOM
- access from a `MutationObserver` watching the message subtree

The attribute may appear anywhere on the opening tag, including across multiple lines. Standalone `<style>` blocks cannot be opted out directly. Wrap them in a `<div data-no-island>` if you need them inline.

!!! warning "You own scoping and safety"
    Opting out disables both style isolation and the markdown-safety wrapper. Scope your selectors with a unique class prefix to avoid collisions with the chat UI, and ensure markdown will not misinterpret your content.

## Extension-controlled spacing

An extension can set `skipInlineCardWrapping: true` when registering its display resolver to disable automatic inline-card spacing wrappers in chats it owns. This requires `app_manipulation`. Other chats keep their default spacing; Shadow DOM island extraction and padding are unchanged.

Register the resolver before displaying the chat when possible. Existing messages update when the resolver or chat owner changes. Disposing the resolver or revoking the permission restores default wrapping. After permission is granted again, register the resolver again to enable the opt-out.
