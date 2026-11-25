# benweiller.com

The portfolio site of Ben Weiller, built from the design canvas
("Ben Weiller Portfolio — Homepage concepts", https://claude.ai/artifact/3NrZ1E1BoouUa6nup9bPBv).
The written record of every design decision is `claude/design-spec.md` in the "Creative Site" Claude Project.

## How it works

Every page of the site **is** its design board. The boards are copied unchanged from the canvas into
`design/boards/` (`*.dc.html`), and `src/dc-lite.js` (a small engine on React) runs each board's markup and
`class Component extends DCLogic` logic in the browser, exactly as the canvas does.
Each page holds its desktop board and its mobile board; the engine picks one on load:

- phones (under 768px wide) get the mobile board;
- iPads / touch tablets get the mobile homepage and menu, and the desktop project, about and contact pages.

`tools/routes.mjs` says which boards make each page and what its URL is. `tools/build.mjs` writes `dist/`:
it swaps the canvas asset links (`/_blob/<id>`) for files in `design/assets/`, swaps board links
(`Project-BMW.dc.html`) for page URLs (`/bmw/`), and bundles the engine.

```
npm run build      # -> dist/
npm run serve      # -> http://localhost:8788
```

Cloudflare Pages builds and deploys `dist/` on every push to `main` (build command `npm run build`, output `dist`).

## Changing the design after launch

1. Make and agree the change on the design canvas (any thread in the "Creative Site" Project can open it).
2. Copy the changed board file(s) from the canvas (`project/<Board>.dc.html`) into `design/boards/`, unchanged.
   New or replaced images, films and fonts go into `design/assets/` named `<blob id>.<ext>`
   (the id is the 32-character code after `/_blob/` in the board).
3. A new page: add a line to `tools/routes.mjs`.
4. `npm run build` — it lists any asset or board link it couldn't resolve. Commit and push; the site redeploys in a minute or two.
5. Update `claude/design-spec.md` in the Project.

## Keeping it clean (checked by the build)

**The intention (Ben, Nov 24): the most efficient, cleanest, most effective code possible.** Every change *replaces* the
original instead of fixing or updating on top of it, so a board always reads as if it had been written that way from the
start. That holds for the forms of piling-up the build can't see, too.

In practice, for every change:
- **Edit the value where it lives** and delete what it replaces in the same change: never a second rule, an override, a
  compensating value (a negative margin to cancel a gap, an opacity to hide something) or a workaround next to the original.
- **One source for each thing**: a value is written once, in the one place that owns it (the site shell for the page
  background, a class for what its elements share, the element itself for what's only its own).
- **No dead code**: when something stops being used, remove it and everything that only it used (rules, classes,
  @keyframes, script values, state, helpers, hidden elements).
- **If the cleanest version means rewriting a block, rewrite it**, then prove nothing on screen changed (below).

The build checks the families of ways code piles up (`tools/audit-boards.mjs`, every board the site uses):
- **force**: a value forced over another (`!important` anywhere);
- **outside**: an element changed from outside by matching its inline style (`[style*=…]`, `[style^=…]`, any form);
- **repeat**: the same thing written twice (a selector twice in one context, a property twice in one rule, `@keyframes`
  twice, an inline style setting a property its own class sets);
- **dead**: code that does nothing (CSS for unused classes, `@keyframes` nothing runs, empty rules, values the script
  hands the markup that it never uses, state nothing reads).

Every board is at zero, so `tools/audit-baseline.json` is the rule: the build stops if any board gets worse, and if the
site's own code (`tools/build.mjs`, `src/*.js`) forces a value or matches inline styles. Fix the board (on the canvas),
never raise the baseline. `node tools/audit-boards.mjs` lists every finding by name. If a new kind of piling-up turns up
that these checks miss, add a check for its whole family to the audit, not a one-off note.

To show a cleanup changes nothing, serve the previous build on a second port and run
`node tools/compare-pages.mjs http://localhost:8789 http://localhost:8788 /heelys/ …` (`--only=desktop` / `--only=iphone`):
it compares every visible element's position, size and computed look, with the menu open, the expanded view open and
stepped, and the first keyboard focus stops. It needs Playwright (`PLAYWRIGHT=…/playwright/index.mjs` if not installed here).

## Pages

| URL | desktop board | mobile board |
|---|---|---|
| / | Bloburblur | Mobile-Home |
| /work/ | Menu-Blob-Bold | Mobile-Menu-List |
| /kia-k5-gt/ … /vicks-vaporub/ | Project-* | Mobile-* |
| /who-me/ | About-A | Mobile-About |
| /contact/ | Contact-A | Mobile-Contact |
| 404 | Page-404 | Mobile-404 |

## Hosting

- Cloudflare Pages project, connected to this repo.
- Domain benweiller.com: registered at GoDaddy, nameservers pointed to Cloudflare; apex + www on the Pages project.
- No analytics (by design).
