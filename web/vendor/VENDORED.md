# The Insightis design system, vendored

`insightis-ui/` is a **verbatim copy** of `frontend/packages/ui` from
`https://git.devart.com/devart/ai-innovations-team/simplebi/insightis` — the whole package, its own layout
intact, all 44 components, the tokens, the Tailwind config, even the Storybook stories. `vendored.json` in
each directory records the commit it came from.

`insightis-typescript-config/` is `frontend/packages/typescript-config` from the same repo. It is here for
one reason: `insightis-ui/tsconfig.json` extends `@insightis/typescript-config/react-library.json` by
package name, and Vite's esbuild pass reads that tsconfig when it transforms a vendored file. It is
installed as a local package (`"@insightis/typescript-config": "file:vendor/insightis-typescript-config"`)
so the `extends` resolves without editing the file.

## Updating it

```bash
npm run sync:ui:check   # what would change, touching nothing
npm run sync:ui         # replace the copy with upstream master
npm run sync:ui -- --ref some-branch
npm run build           # typecheck + build, which is where a breaking change shows up
```

Needs network and your Devart GitLab credentials. `--from <path>` copies from a checkout you already have
instead of cloning.

## The rules that keep it updatable

**Never edit anything under these directories.** A sync replaces them wholesale, so an edit here is work
that disappears the next time somebody updates. The script refuses to run when the tree has uncommitted
changes, which catches the honest mistake but not a committed one. Changes to the design system belong
upstream, where the other apps using it get them too.

**The app bends to the package, not the other way round.** Their files import each other as
`@insightis/ui/Typography` and `@insightis/ui/cn`, and one reaches for the workspace's own `@/hooks/…`
alias. Rather than rewrite 227 files on every sync, those specifiers are resolved:

- `vite.config.ts` — the `DESIGN_SYSTEM` alias list, for the dev server and the build
- `tsconfig.json` — the same map again as `paths`, for the typechecker

Both mirror the `exports` block in `insightis-ui/package.json`. If a sync adds a new export there, add it to
both; the suite checks they agree.

**Our own code imports it the same way**, `@insightis/ui/Button` rather than a relative path into `vendor/`,
so an example lifted from their repo compiles here unchanged.

**Tailwind consumes their config as a preset** (`tailwind.config.ts`) instead of transcribing it. What used
to be a 110-line copy of their theme is now three content globs.

## What this costs

- **CSS.** The content globs include the vendored tree, so Tailwind emits classes for all 44 components
  whether or not this app renders them (~100 kB raw, ~17 kB gzipped). The alternative — globbing only the
  components we import today — means the first person to use `Sheet` gets an unstyled one and no clue why.
- **Typechecking.** `tsc` covers the files the app actually imports, pulled in through those imports; the
  rest of the tree is not in the program. So a sync cannot break the build with a component nobody uses,
  and a component's first use is when its types get checked. If that first use fails under our stricter
  options (`noUnusedLocals`, and their `noUncheckedIndexedAccess` which we do not set), fix it upstream.
- **Nothing in the JS bundle.** Unused components are never in the module graph — verified by grepping the
  build output for `react-day-picker`, `sonner` and friends.

## Provenance

This is Devart-internal code in a private repository (`Aborsen/Mouse`). It stays that way. If the repo is
ever made public, this directory has to come out first.
