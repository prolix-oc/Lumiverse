# Frontend development

Run commands from `frontend/` with Bun. `bun run build:checked` generates the
component metadata, checks TypeScript, builds the application and PWA, and
atomically promotes the validated bundle to `dist/`.

## Standard tooling

`bun run dev` uses bundled Vite development and the native React Compiler.
`bun run build` and `bun run build:checked` use the native Compiler and chunk
import maps, build the custom PWA worker, validate the staged output, and promote
it to `dist/`. The checked command also runs TypeScript. The map is embedded in
both application HTML entries and its JSON copy is precached with their assets.
The worker remains one self-contained file without an import map.

`dev:bundled` and `build:import-map` are compatibility aliases for the standard
commands; the latter now uses the normal checked build and `dist/` destination.
Use these explicit fallbacks while diagnosing a compiler, browser or plugin issue:

```sh
bun run dev:unbundled
LUMIVERSE_REACT_COMPILER=babel bun run dev
LUMIVERSE_REACT_COMPILER=babel bun run build:checked
LUMIVERSE_CHUNK_IMPORT_MAP=0 bun run build:checked
bun run build:legacy
```

`build:legacy` combines Babel compilation and builds without chunk import maps.
These are repository defaults; upstream still labels bundled development,
chunk import maps and the native Compiler experimental. Import maps require
`import.meta.resolve` in the browser. The standalone native-cache probe retains
its single-document build without maps.

Both Compiler implementations target React 19 and compile only functions
annotated with `'use memo'`. `App`, native character cards and pack cards opt in.
`MessageList` explicitly uses `'use no memo'` because TanStack Virtual's mutable
instance is incompatible with compiler memoization. Native diagnostics remain
visible. Its version-matched Android arm64 binding is explicitly pinned and
included in the existing Termux postinstall repair; builds continue to select
Android-aware Node in Termux-like environments.

Run the tooling regressions with:

```sh
bun test --isolate scripts/toolchain-defaults.test.ts scripts/react-compiler.test.tsx scripts/vite-chunks.test.ts scripts/build-frontend.test.ts scripts/module-boundaries.test.ts
```

The tests resolve actual Vite defaults and fallbacks, exercise production output
from both Compiler implementations, and check Effect Event callbacks, Activity
cleanup/state retention, card subtree reuse, locale chunk paths, import
boundaries and validated build promotion. A mapped build is rejected before
promotion when its map, inline maps or referenced assets are incomplete. The
Windows locked-directory fallback installs assets, map, HTML entries and worker
in that order.

From `scripts/e2e-diagnostics/`, install the matching browsers as described in
its README and run:

```sh
bun run check:vite-hmr
bun run check:pwa-build
bun run check:pwa-upgrade
bun run check:profile-transitions
bun run bench:compiler
```

The HMR check inherits the ordinary configuration for its standard case and
also exercises the unbundled fallback. The production smoke check includes the
authenticated application shell and its bootstrap/settings hydration. The
upgrade check builds isolated legacy,
standard and changed-locale generations, then verifies existing installations
through two worker updates and offline lazy locale loading. These checks use
fresh browser profiles and mock APIs; physical native WebViews still require
device testing.

For a full production build-time/size comparison, run
`bun run scripts/benchmark-react-compiler.ts`. For controlled runtime card
profiling, use `bench:compiler` in the diagnostics package. Both preserve `dist/`
and write raw samples under `.tmp/`. The runtime trial on October 28 measured
30 updates to 60 cards of each kind over seven alternating samples: Babel/native
medians were 5.7/5.6 ms with stable actions and 23.9/23.7 ms with replaced actions,
compared with 23.4/46.6 ms without compilation. These controlled card timings do
not measure whole-app interaction latency or native WebView performance.

The locale code-splitting group has `debugName: 'i18n-locales'` so Rolldown can
identify its functional name callback in timing reports. Both Compiler paths
preserve per-language chunk names and `assets/i18n/` paths.

## Retained panels and profile transitions

Display, Chat and Quick Replies settings mount on first visit. React's Activity
preserves their state and DOM while pausing hidden effects. Closing the settings
modal discards the retained UI. Profile disclosures also retain their expanded
state across Profile/Creator Notes tab changes, ending when the character changes.
Rich creator notes unmount on exit so hidden media cannot continue playing.

The profile tab body uses a scoped 160ms React ViewTransition. Reduced-motion
and efficiency preferences skip snapshots; browsers without the API render the
selected tab normally. Tabs retain keyboard focus and expose panel relationships.

## Landing gallery measurement snapshots

Opening a chat captures `virtualizer.takeSnapshot()` alongside the current DOM
scroll offset in the existing account-scoped landing snapshot. Returning to the
native gallery restores `initialMeasurementsCache`, `initialOffset`, and the
scroll margin. Only measured rows are persisted; other rows use estimates.
Snapshots also survive a reload in the chat route through the existing one-shot
session-storage bridge. They contain plain data, with no retained DOM or images.

Row keys/order, layout, column count, width, gap, estimate, viewport width, UI
scale, and font scale must match before cached measurements are accepted.
Malformed or older caches fall back to estimates and the saved offset. A
compatible card cache skips the initial `measure()` reset; subsequent responsive
changes still reset it. Compact rows retain their first measured height until
UI or font scaling changes. The first returning list consumes the saved state,
including when bootstrap
delays mounting it. Later layout switches cannot replay the return offset.
Extension-owned landing surfaces retain their DOM scroll-restoration behavior.

Run the regression tests and a reproducible initial-range comparison with:

```sh
bun test --isolate src/lib/landingVirtualSnapshot.test.ts src/components/landing/LandingPage.character-library.test.tsx
bun run scripts/benchmark-landing-snapshot.ts
```

The comparison uses synthetic variable-height rows and reports the initial
visible-row error with and without saved measurements, before DOM observers
run. It measures restoration accuracy, not frame rate or real chat latency.

Chat message snapshots remain separate work: bottom-pinning, streaming, swipes,
and HTML content require a different invalidation and reading-position policy.
See the [TanStack Virtualizer API](https://tanstack.com/virtual/latest/docs/api/virtualizer#takesnapshot).
