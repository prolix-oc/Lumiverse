# HTML Islands

Self-contained styled HTML in chat messages is auto-extracted into a Shadow DOM container ("island"). This isolates card `<style>` rules from the chat UI and prevents markdown from corrupting interactive markup.

## Detection

A block-level element (`<div>`, `<section>`, `<article>`, `<aside>`, `<nav>`, `<main>`, `<header>`, `<footer>`, `<form>`, `<fieldset>`, `<figure>`, `<details>`) becomes an island when its content contains either a `<style>` tag or three or more `style="..."` attributes.

Standalone `<style>` blocks not inside a wrapper element are extracted together with any subsequent sibling HTML.

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
