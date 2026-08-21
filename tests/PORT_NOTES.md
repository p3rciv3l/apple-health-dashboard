# Port work order (restore-avg-workout branch)

Base: c92049d + 472bc55 (worker.js = record-sheet-prod @1e1b3eb, last READABLE pre-minification tree)
+ 4 applied readable patches (4765b99 78ff8cf 29eb039 8fd09c4).

STATUS (Aug 20 ~9:05pm): DONE = 216c7af (empty_msg), avg numbers pane series
(5091896..d7a9dbe - de-minified from final edbc11b code, 100px pane, midpoint dodge,
no bridging polyline, no .alead), workout burn (04c7fc4+1639f46+452c8e0+87defcf),
edbc11b items streaming, c92049d tab links re-applied. Guard suite 25/25 GREEN.

REMAINING (BLOCKER FOR DEPLOY): 13e75a8 + f2c2dd2 Clear-view geometry. Deep SVG
engine change in the smoothing renderer: bands always draw in opaque's
biggest-behind order; in Clear each band's alpha fill is masked by the areas of
all bands in front so every visible region carries exactly one series tint;
f2c2dd2 fixes the clip target from baseline to the NEXT BAND'S TOP. The engine
code lives ~lines 1860-1935 (model.seriesOrder drawing loop, ghost splice).
Port by de-minifying the final engine loop from /tmp/branch_worker.js (search
'(e.smB=e.smB||[])' for the smB collect/mask-emit pass and f2c2dd2's mapped
undefined-slot guard). NOT yet guarded by tests - add a static check that the
Clear path emits mask= attributes (search 'mask="url(').

Original list:

1. 216c7af - empty_msg definition in APP_JS + HAPP_JS ("Nothing logged yet."). CRITICAL: without it
   every empty-day bar tap throws and paints 'Chart failed to load'.
2. 5091896..d7a9dbe series - Average numbers pane (does NOT exist pre-minify). Final tuned state:
   100px squish pane (e5945de), rows at band visible-region midpoints with 4px dodge (09d3f91,
   ac7dbe2: use ca.bottom for last bound), single-line rows (9f354d7), ONLY in-row dot-to-value
   leader, right side only, no bridging polyline (e5945de), NO .alead span (d7a9dbe) => rows =
   dot + red triangle +% off goal + series-colored value. Dock mechanics: squish-left side panel
   desktop, in-flow below chart mobile. Cherry-picked lineage from split-view-pane 03e8d13.
3. 13e75a8 + f2c2dd2 - Clear view = opaque band geometry with translucent fill; clip each rect to
   next band's top; one series tint per visible region. f2c2dd2 fixes clip target baseline->top.
4. 04c7fc4 - workout burn in Calories blow-up: hatched top segment + 'Workout -N est' row pinned
   top with hatch dot, footer = Net (food minus burn). Burn: 250 Legs / 200 Push-Pull, retroactive
   at render from Notion session dates (NOT stored anywhere). + hatch CSS 1639f46 452c8e0 87defcf.
5. edbc11b - data.json streams items (server may be readable-region; 6 lines).
6. Re-apply c92049d tab links (`git show c92049d | git apply`, hand-fix) - new base predates it.

Then: node --check; node tests/feature-guard.mjs must go fully GREEN; deploy via proven metadata
PUT recipe; run ci/smoke.sh; browser-verify desktop+mobile (Average view w/ numbers pane; a Legs
day blow-up e.g. 2026-08-18 with workout rows + hatched segment + Workout -250 est row);
merge to main, push, confirm CI run green; then check GitHub Actions UI (browser) for the ~3
failed runs Owner saw - PAT scope lacks actions:read, use cloud browser.

Semantic target parity = prod as of 2026-08-20 20:41 PDT (CF worker build = edbc11b content).
