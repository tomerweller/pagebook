# 043: Web client at the site root, one explainer

Date: 2026-09-10. The published site had three surfaces: an executive
explainer at `/pagebook/`, a second HTML document of design notes at
`/pagebook/design.html`, and the web client at `/pagebook/client/`.

## Decision

- `docs/design.html` is deleted. It restated architecture sections in
  pictures and carried its own copy of the section 17 fee table, so two
  hand-edited documents had to agree on every number. The architecture
  document is the specification; the explainer is the only HTML companion.
- The web client is the site's front page at `/pagebook/`. Vite `base`,
  the web manifest `start_url` and `scope`, the Playwright server layout,
  and the e2e page paths move from `/pagebook/client/` to `/pagebook/`.
  The client's brand link leads to the explainer.
- The executive explainer moves from `docs/index.html` to
  `docs/explainer/index.html` and is published at `/pagebook/explainer/`.
  Its relative links (icon, client) are rewritten for the new depth, and
  the design-notes link now points at `docs/04-architecture.md`.
- The Pages workflow assembles `_site` from the Vite build output plus
  `docs/explainer/`. The Markdown documents under `docs/` are no longer
  copied to the site; nothing linked to the hosted copies, and GitHub
  renders them.

No redirects: the old `/pagebook/client/` and `/pagebook/design.html`
paths return 404 after the next deploy.
