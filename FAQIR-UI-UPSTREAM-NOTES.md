# Faqir UI 1.2.5: notes for upstream

Findings from building Buildyboy's user manual (`/docs`, 20 pages) with **`@faqir-ui/template` 1.2.5** (server-side
rendering) and **`@faqir-ui/core` 1.2.5** (the `slate` theme bundle and `faqir-core.min.js`), installed from npm. They
are written to be picked up in a future faqir-ui session. Each item gives what happened, a minimal repro, what Buildyboy
does about it today, and a suggested fix.

Where Buildyboy's integration lives: `server/docs/engine.ts` (compile, render, CSS subset), `server/routes/docs.ts`,
`server/docs/templates/**/*.faqir`, `server/docs/assets/docs.css`, and `tests/docs.test.ts`, which guards against
several of the issues below.

Every rendered page passes `faqir audit` (CLI 1.2.5) with zero findings, and the pages run with no console errors in
headless Chrome at 1366×900 and 390×844, light and dark.

---

## Bugs

### 1. `table` cannot be called from the template language

`@faqir-ui/template/registry` lists `table` under `unavailable`:

```
table - table: boolean prop "no-resize" declares an attr but is not a valid prop name
```

`+table` is therefore `unknown-component`. Tables are among the most common things in server-rendered pages: the manual
has 9 of them, all written as plain `div(data-ui="table") > table(data-part="table") > thead(data-part="thead")…`
markup, which the compiler does not check.

**Fix:** map the `no-resize` prop to a valid argument name (for example `noResize`, or `resize` with an `off` value) in
the bindings IR. Add a registry test asserting that every recipe in the registry is callable, or listed with an
intentional reason. Today `checkbox`, `radio`, `switch` and `toggle` are also unavailable, because their `templates.html`
root is a sample group rather than one component.

### 2. A prose line without its `|` silently becomes an element, and nothing catches it

```
p
  Open the app now
```

compiles with **no diagnostics** and renders `<p><Open>the app now</Open></p>`. `faqir audit` on that output also
passes. In a documentation-sized template it is the easiest mistake to make, and it is invisible until someone reads the
page.

**Fix:** add a compile diagnostic `unknown-tag`. A tag name that is not an HTML or SVG element and has no hyphen (custom
elements must contain one) is almost always a missing pipe; say so in the message ("did you mean `| Open the app now`?").
Add a matching audit rule for hand-written HTML.

*Buildyboy's workaround:* `tests/docs.test.ts` rejects any element outside an allowlist.

### 3. Inline elements followed by punctuation render with a visible space

Whitespace rule 1 (§12.1, every node on its own line) means:

```
p
  | Run
  code npm ci
  | , then continue.
```

renders as `Run <code>npm ci</code> , then continue.`, with a space before the comma. The same thing happens with `(`
before an element and `)` `.` `;` `:` after one. Prose in a manual is full of these: the 20 pages here have hundreds.
There is no inline-tag syntax and no whitespace control, so the only escape is `raw`, which gives up the escaping
guarantees.

**Fix, any of:**
- Pug-style inline tags in text, for example `| Run #[code npm ci], then continue.` This is the most ergonomic.
- A glue marker on piped text that suppresses the line break before it (for example `|<, then continue.`).
- Have the renderer omit the break before a text node that starts with closing punctuation, and after one that ends
  with opening punctuation. This needs no new syntax.

*Buildyboy's workaround:* `glueInline()` in `server/docs/engine.ts`. It is a post-render regex that removes the newline
and indentation between an inline closing tag and punctuation, and between opening punctuation and an inline element. A
test (`never puts a space before punctuation`) keeps the output clean.

### 4. Repeating parts cannot be filled, so lists of items need hand-written markup

Calls to `stepper`, `timeline`, `breadcrumb`, `description-list`, `key-value`, `tabs` and `accordion` render exactly one
reference item, or two empty sample items. You cannot pass N steps, N tabs or N accordion items. §11.4 says so ("A
required part that repeats in the reference tree … is not fillable"), but this is the common case for these components.
`+accordion` and `+tabs` therefore produce empty triggers and panels that are useless as output.

**Fix:** allow a fill to repeat when its part repeats, and let the call repeat the part's wrapper for each fill:

```
+timeline
  @item
    @title Install
  @item
    @title Pair
```

Or allow `each` directly under a call, around fills. Tabs and accordion need paired fills (`@tab` with `@panel`, and
`@trigger` with `@content`), with the ids and ARIA wiring derived per pair.

### 5. Unfilled optional parts still render as empty elements and take up space

```
+card(title="Watch every session")
  @body
    p …
```

renders an empty `<p data-part="description"></p>` and an empty `<div data-part="footer"></div>`. With the shipped CSS
this leaves a visible gap between the title and the body, and padding at the bottom of the card. `+callout` likewise
renders an empty `<span data-part="icon"></span>`.

**Fix:** when an optional part's reference content was only sample placeholders, and the call neither fills it nor sets
its prop, omit the element. Alternatively, ship `:empty { display: none }` rules for optional parts in each component's
CSS.

*Buildyboy's workaround:* in `docs.css`, `[data-ui="card"] [data-part="description"]:empty` (and the footer and callout
icon) get `display: none`.

### 6. Packaging: the language spec is not in the npm package

`@faqir-ui/template/README.md` says "The full language is specified in [`docs/template.md`](../../docs/template.md)".
That relative link points outside the tarball (`LICENSE`, `README.md`, `package.json` and `src/` only), so npm consumers
and agents reading `node_modules` have no grammar, no list of diagnostic codes and no AST reference. I had to read it from
a local checkout of the repository.

**Fix:** ship `docs/template.md` in the package (`"files": ["src", "README.md", "template.md"]`) and link to it, or use
an absolute GitHub URL pinned to the version tag.

### 7. Packaging and discoverability

- `npm search @faqir-ui` lists core, forms, rules, mcp, react and vue, but **not** `@faqir-ui/template`. It is
  published (`npm view @faqir-ui/template` works), so check its search metadata (keywords and description are present;
  it may need a re-index).
- The CLI README's *CLI Reference* says "Twenty-four commands" and never mentions `faqir template`, although
  `faqir help` lists it ("Install the @faqir-ui/template engine and this project's component table").
- The CLI README's *Packages* table links `packages/template/README.md`, which only resolves inside the repository.

---

## Rough edges

### 8. Optional partial parameters need `??` at every use

A partial reads only its parameters, and a missing one is the render error `missing`. An optional flag therefore has to
be written `phone ?? false` every time it is read:

```
figure(data-docs="shot" data-docs-shape=phone ?? false ? "phone" : false)
  img(… width=phone ?? false ? "390" : "1280" height=phone ?? false ? "844" : "800")
```

**Suggestion:** a parameter declaration with defaults at the top of a partial, for example
`params phone=false caption=""`. It would also document the partial's interface and let `compile` report an include that
passes an unknown parameter.

### 9. HTML entities in literal text are escaped, with no warning

`code claude --resume &lt;id&gt;` renders as the visible text `&lt;id&gt;`. This is specified (§6: "Write the
character, not an entity"), but anyone coming from HTML or Pug writes entities by reflex, and I did so in three places.

**Suggestion:** a compile warning, or a diagnostic, for `&name;` and `&#…;` sequences in literal text.

### 10. `card` titles are always `<h3>`

The reference tree hard-codes `h3 data-part="title"`. A grid of cards directly under an `h1`, or nested under an `h3`,
breaks the heading order, which `faqir audit` checks with `heading-order` elsewhere. The call cannot change the level.

**Suggestion:** a `level` argument (or `heading="h2|h3|h4"`) on components whose title part is a heading.

### 11. The `prose` base styles lists and tables, but not `dl`, `figure` or `details`

`[data-ui="prose"]` covers `p`, headings, `ul`, `ol`, `li`, `pre`, `code`, `blockquote`, `hr`, `img` and `table`.
Definition lists (`dl`/`dt`/`dd`), the natural markup for "every button and what it does", get no spacing at all:
terms and definitions run together. `figure` and `figcaption` are not styled either.

*Buildyboy's workaround:* `dl` rules in `docs.css`.

**Suggestion:** add `dl`, `dt`, `dd`, `figure` and `figcaption` to `base/prose.css`.

### 12. The CSS bundle is all or nothing for the npm path

Each `dist/faqir.<theme>.css` is about **728 KB** raw (about 138 KB gzipped) and contains all 105 components. The CLI
path (`faqir add`) trims that list, but a project that consumes `@faqir-ui/core` from npm has no way to do so, even
though the template engine knows exactly which components a page draws.

*Buildyboy's workaround:* `subsetCss()` in `server/docs/engine.ts`. It renders every page once at startup, collects the
`data-ui` values in the output, and keeps the bundle's `tokens/*`, `themes/*` and `base/*` sections plus only the
`primitives|recipes|patterns/<name>.css` sections in use. It splits on the bundle's `/* === path === */` markers. The
result is about 185 KB raw. It works only because those markers are reliable, and they are not a documented contract.

**Suggestions:**
- Ship `dist/<theme>/base.css` plus `dist/components/<name>.css`, or document the section markers as a stable contract.
- Export a helper, for example `subsetBundle(css, components)`.
- Have `compile` add the CSS components a template uses to the AST, beside `requires` (which lists only JavaScript), so
  a host can build per-page CSS without rendering first.

### 13. `cluster` wraps by design; a toolbar needs it not to

A top bar with a brand on the left and a `cluster` of two buttons on the right wrapped onto two lines at 390 px. The
cluster's whole point is to wrap, but toolbars, button rows and header actions want `nowrap` (and the content to shrink).

**Suggestion:** a `data-wrap="false"` (or `data-nowrap`) option on `cluster`. `stack` already has `data-wrap`.

### 14. Theme density is stated but not applied

The `slate` theme says it "was designed at" `compact` density, and expects the project to set `data-density="compact"`
on the root. The prebuilt bundle and the template layer give no hint of this, so a page using the bundle as is gets
`comfortable`.

**Suggestion:** mention it in `@faqir-ui/core`'s README next to each theme, or expose it in `cdn.json` / theme metadata so
a host can apply it.

---

## What worked well

- **Compile once, render per request** is the right split for a server. Compiling every template at startup turned
  template mistakes into startup failures (and test failures), never into a reader's 500. Holes made it trivial to put
  the server's real public URL into every copy-pasteable command.
- **Diagnostics are excellent.** `missing-slot`, with the slot's name and line and column, caught three mistakes on the
  first compile. `bad-value` lists the allowed values.
- **Escaping by default and the URL policy** meant no thought had to go into putting data into `href`s and text.
- **`pre` is handled exactly right.** No indentation, and piped lines are joined with `\n`, so code blocks are
  copy-paste exact.
- **Audit-clean output:** all 20 pages pass `faqir audit` with zero findings, including the hand-written protocol markup.
- **`data-theme` on `<html>`** happens to be the same attribute the host app already used for its dark and light toggle,
  so the manual and the app share one theme preference with no glue code.
- **`faqir-core.min.js`** took over the server-rendered `table` and `collapsible` markup without any client code.
