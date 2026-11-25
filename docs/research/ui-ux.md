# p0rtal UI/UX spec: hospitality POS

Researched 2026-11-25. Decisions come first, then the evidence. Contrast ratios are WCAG 2.x values, calculated from the hex values shown.

---

## Decisions

### Font
- **Primary UI font: Inter.** Install with `npm i @fontsource-variable/inter` (v5.3.0, OFL-1.1). Import `@fontsource-variable/inter/opsz.css`, which includes the wght 100–900 and opsz 14–32 axes. The family name is `'Inter Variable'`.
- **No separate display font.** With `font-optical-sizing: auto`, Inter switches to its Display design at large sizes.
- **Global features:** `font-feature-settings: "cv05","cv08"` gives a tailed l and a serifed I.
- **Numbers:** for money, time, quantities and table numbers, use `font-variant-numeric: tabular-nums`.
- **Codes:** for PINs, order IDs and check numbers, use `font-feature-settings: "ss02"` (the disambiguation set, which includes a slashed 0) with `tabular-nums`.
- **Why Inter:** it is the only candidate with an optical-size axis, so one file serves 13px badges through 100px+ wall numerals. It ships `tnum`, `zero`, `ss02` and `cv05`/`cv08` for 0/O and 1/l/I, and it has a tall x-height (0.546). It is the most proven product-UI face and can be self-hosted from npm for offline precaching.

### Theme
- **Defaults:**
  - FOH terminals: **dark**.
  - KDS and wall screens: **always dark**.
  - Manager reports: follow `prefers-color-scheme`.
- **Per-device override:** "Dark / Daylight", stored locally. Toast sets its POS Display Theme per device the same way.
- **Trade-off:** NN/g reports that light mode reads better for small text. We offset this with an 16–18px base size and muted-text contrast of at least 6.8:1. Use Daylight on patios.

### Color tokens

Contrast is shown as the minimum and maximum across the three surfaces in each theme.

| Token | Dark | Contrast (dark) | Light | Contrast (light) |
|---|---|---|---|---|
| `--bg` | `#0E1116` | — | `#F5F6F8` | — |
| `--surface` (cards, tiles) | `#161A21` | — | `#FFFFFF` | — |
| `--surface-2` (rail, chips; raised in dark) | `#1F242D` | — | `#ECEEF2` | — |
| `--text` | `#F1F3F6` | 14.0–17.0 | `#11151B` | 15.8–18.3 |
| `--text-muted` | `#A3ACB9` | 6.8–8.3 | `#525B68` | 5.9–6.9 |
| `--border` (decorative only) | `#2A303A` | 1.2–1.4 | `#D9DDE3` | 1.2–1.4 |
| `--border-strong` (inputs, tile edges) | `#6B7585` | 3.3–4.1 | `#767F8D` | 3.5–4.1 |
| `--accent` (iris; also focus ring) | `#8E8CFF` | 5.5–6.6 | `#4F46E5` | 5.4–6.3 |
| `--accent-pressed` | `#7A77F0` | — | `#4338CA` | — |
| `--on-accent` | `#0E1116` | 6.6 on accent / 5.2 on pressed | `#FFFFFF` | 6.3 / 7.9 |
| `--success` | `#4ADE80` | 8.9–10.9 | `#116B34` | 5.7–6.6 |
| `--warning` | `#FBBF24` | 9.3–11.3 | `#9A4A05` | 5.4–6.3 |
| `--danger` | `#FF7A7A` | 6.2–7.5 | `#B42228` | 5.7–6.6 |
| `--info` | `#4CC3F5` | 7.7–9.4 | `#03649A` | 5.5–6.4 |
| `--on-status` (text on solid status fill) | `#0E1116` | 7.5–11.3 | `#FFFFFF` | 6.3–6.6 |
| `--accent-soft` | `#262551` | accent on it 5.0 | `#ECEBFE` | 5.4 |
| `--success-soft` | `#10291B` | 8.9 | `#E2F5E7` | 5.8 |
| `--warning-soft` | `#2E2307` | 9.3 | `#FCEFD9` | 5.5 |
| `--danger-soft` | `#3A1618` | 6.4 | `#FDE6E6` | 5.5 |
| `--info-soft` | `#0B2634` | 7.8 | `#DFF0FA` | 5.5 |

- **AA on every surface:** all status colors pass 4.5:1 as text on every surface. `--text` on any soft fill is at least 12.9:1.
- **Status color jobs:** soft fills cover large areas; saturated colors are only for borders, icons and text. TVs over-saturate color, per Fire TV guidance.
- **Accent:** one iris accent, kept distinct from all four status hues.
- **No pure black or white:** never `#000` or `#FFF` in dark mode (Material dark theme guidance).

### Type scale
- **Interactive root:** `html { font-size: clamp(1rem, 0.875rem + 0.3125vw, 1.125rem); }` This gives 16px up to 640px wide and 18px from 1280px. It is rem-based, so user zoom still works (WCAG 1.4.4).
- **Wall root:** `html[data-surface="wall"] { font-size: clamp(1rem, 1.4583vw * var(--wall-scale, 1), 5rem); }`
  - This gives 28px at 1920 and 56px at 3840, so 1080p and 4K show an identical layout.
  - `--wall-scale` takes S/M/L/XL values of 0.85/1/1.2/1.45, set per device.
  - On wall screens, also set `--fs-2xl: 2rem; --fs-3xl: 3rem; --fs-display: 4.5rem` so vw isn't applied twice.

| Token | Value | px (16→18 root) | Use |
|---|---|---|---|
| `--fs-xs` | `0.8125rem` | 13–14.6 | badges, meta |
| `--fs-sm` | `0.875rem` | 14–15.8 | secondary, modifiers |
| `--fs-md` | `1rem` | 16–18 | body, buttons, ticket lines |
| `--fs-lg` | `1.25rem` | 20–22.5 | item tiles, pane titles |
| `--fs-xl` | `1.5rem` | 24–27 | screen titles |
| `--fs-2xl` | `clamp(1.75rem, 1.4rem + 1.2vw, 2.25rem)` | 28–40 | ticket total |
| `--fs-3xl` | `clamp(2.25rem, 1.6rem + 2.4vw, 3.5rem)` | 36–63 | KPIs, Pay amount |
| `--fs-display` | `clamp(3rem, 1.8rem + 5vw, 6rem)` | 48–108 | clock, PIN screen |

- **Zoom-safe clamps:** every clamp has max ≤ 2.5 × min. This is the Barvian/OddBird rule for staying zoom-safe under 1.4.4.
- **Line height:** 1.1 for numerals, 1.25 for labels, 1.5 for body.
- **Weight:** 400 body, 500 labels, 600 item names and buttons, 700 totals and KDS table numbers.

### Spacing, radii, shadows, motion
- **Spacing (rem):** `--space-1…8` = `.25 .5 .75 1 1.5 2 3 4`, which is 4/8/12/16/24/32/48/64px at a 16px root. Because everything is rem, the root clamp scales type, spacing and touch targets together.
- **Radii:** `--radius-xs .25rem` for badges, `-sm .5rem` for buttons and inputs, `-md .75rem` for tiles, table cards and tickets, `-lg 1.25rem` for sheets, `-full 999px` for avatars, pills and PIN keys.
- **Light shadows:**
  - `--shadow-1: 0 1px 2px rgb(17 21 27/.06), 0 1px 3px rgb(17 21 27/.10)`
  - `--shadow-2: 0 2px 4px rgb(17 21 27/.06), 0 8px 16px rgb(17 21 27/.10)`
  - `--shadow-3: 0 12px 24px rgb(17 21 27/.12), 0 24px 48px rgb(17 21 27/.16)`
- **Dark shadows:** elevation comes from stepping the surface (bg → surface → surface-2) plus a 1px `--border` ring.
  - `--shadow-2: 0 0 0 1px var(--border), 0 8px 24px rgb(0 0 0/.45)`
  - `--shadow-3: … 0 24px 48px rgb(0 0 0/.6)`
- **State layers:** overlay `--text` at 8% for hover and 10% for pressed. These are Material 3 values.
- **Motion:** `--dur-fast 90ms`, `--dur-base 160ms`, `--dur-slow 240ms`, easing `cubic-bezier(.2,.8,.2,1)`.

### Touch targets

| Element | Minimum | Gap |
|---|---|---|
| Any control (floor) | 44×44px (WCAG 2.5.5 AAA, Apple 44pt) | 8px |
| Buttons, steppers, chips | 48px tall (Material 48dp) | 8px |
| Menu item tiles | 72×128px (`4.5rem × 8rem`), S/M/L setting | 8px |
| Pay / Send | 56px tall; Pay spans the ticket pane | 12px |
| PIN keys | 72×72px, digits ≥ `--fs-xl` | 12px |
| Login face tiles | 96px avatar + name text | 12px |

### Breakpoints
These follow M3/Android window size classes, written in `em` because media queries use the initial font size.
- **compact** `<37.5em` (600px): phone.
- **medium** `37.5–52.5em` (840): tablet portrait.
- **expanded** `52.5–75em` (1200): tablet landscape.
- **large** `75–100em` (1600): laptop.
- **xl** `≥100em`: desktop and TV.
- **Containers:** container queries (`container-type: inline-size`) on the ticket pane (compact lines below 20rem) and on report cards. KPI numerals use `clamp(var(--fs-2xl), 12cqi, var(--fs-3xl))`.
- **Wall mode:** route-based `data-surface="wall"`. Never UA-sniff.
- **Line length:** prose max `70ch`. Reports cap at `120rem`, centred, with `repeat(auto-fit, minmax(20rem,1fr))`.
- **Test at:** 320, 600, 840, 1200, 1600, 1920 and 3840px, plus 200% zoom.

---

## 1. Order-taking screen
- **Tablet landscape, 3 panes:**
  - Category rail (10–12rem).
  - Item grid `repeat(auto-fill, minmax(8rem,1fr))`, with search and Open Item above it.
  - Ticket (22–26rem) with a sticky footer: totals, Send (secondary), **Pay $total** (primary).
  - What others do: Toast Quick Order puts the check on the left, TouchBistro puts the order top-right, and Square puts the check beside item details. We default to the ticket on the right, with a "mirror layout" setting.
- **Tablet portrait:**
  - Categories become a horizontally scrolling chip row, and the grid fills the screen.
  - The ticket is a bottom sheet whose collapsed bar reads "5 items · $42.50 · Pay".
- **Phone (Toast Go pattern):**
  - The menu comes first, and the check stacks above it as items are added.
  - Send/Hold are pinned to the bottom, and Pay is always visible.
  - Split, Discount and Service charge go in the overflow menu.
- **Modifiers:**
  - Open in place of the grid, or full-screen on phones. No modal stacks.
  - Required groups come first ("Required · choose 1") and auto-advance. The item is added as soon as they're satisfied (Square auto-progression).
  - All groups are visible at once in fixed positions per menu group, and color-coded, for muscle memory (Toast Open View).
  - The last row is **Note**, with quick chips (No onion, Allergy, To go) and a keyboard.
- **Quantity:**
  - Tap a tile again to add 1; the tile shows a count badge.
  - Each line has an inline − qty + stepper (44px each).
  - Tapping the qty opens a keypad.
  - "Repeat" duplicates a line with its modifiers.
- **Void and discount:**
  - Line actions: qty, repeat, delete, note, discount, course, seat (Toast item options).
  - Unsent lines delete instantly, with undo.
  - Sent lines go through **Void**, which asks for a reason and, if configured, a manager PIN.
  - A discount shows as its own negative tagged line.
  - Swipe can reveal actions, but buttons must offer the same actions (Apple: alternatives to gestures).
- **Why it's fast:** one tap adds an item, positions stay stable, there are no modal stacks, the total is always visible, and writes go local-first with no network wait.

## 2. Tables and reservations
- **Industry reference:**
  - Lightspeed: no color = no order, green = in progress, orange = ready, red = receipt printed but unpaid.
  - Square: tables turn yellow, then red, after time thresholds.
  - Toast cards: guests, open timer, spend and server initials.
- **p0rtal table states.** Every state pairs color with an icon, text and a border style.

| State | Fill / border | Icon | Label | Border |
|---|---|---|---|---|
| Free | surface / `--border-strong` | — | "T12 · 4 seats" | 1px solid |
| Reserved | `--info-soft` / `--info` | calendar-clock | "Res 19:30 · Patel 4" | 2px **dashed** |
| Seated | `--accent-soft` / `--accent` | users | "Seated · 6m" | 2px solid |
| Ordered | `--success-soft` / `--success` | utensils | "Ordered · 18m · $64" | 2px solid |
| Needs bill | `--danger-soft` / `--danger` | receipt | "Bill · $112" | 3px solid |

- **Timer chip:** goes neutral → `--warning` with a clock icon → `--danger` with "!". Defaults are 45 and 75 min, configurable.
- **Server:** shown with an initials badge only, not a second border color.
- **Reservations, two views:**
  - **List**, grouped by time slot: party size, name, notes, allergy icon.
  - **Timeline**, with tables as rows and time as columns (Oddle, Tock). It has a "now" line, and blocked time is striped (Tock), which works without color.
- **Seating:** drag to seat, or use the **Seat** button.

## 3. KDS and wall display
- **Readability numbers:**
  - Fire TV: body text at least 28px at 1080p; keep UI out of the outer 5%.
  - tvOS: 29pt default, 23pt minimum.
  - Smashing: "go larger", with about 10:1 contrast.
- **Distance rule:** cap height should be 4–8 mm per metre of viewing distance. This comes from signage rules of 1in/25ft (Daktronics) and 1in/10ft (Signs.com).
- **Item text needed at 2.5 m (1080p):**
  - 32" screen: 37–75px.
  - 43" screen: 28–55px.
  - 55" screen: 22–43px.
  - So the per-device `--wall-scale` is mandatory.
- **Ticket at a 28px root:**
  - Header: table number 2rem/700 top-left (Toast), order type as text plus border color, elapsed `mm:ss` 1.5rem tabular.
  - Items: "2×" in bold plus the name at 1.25rem/600. Modifiers at 1rem, indented.
  - Allergies: a `--danger-soft` pill with ⚠ and "ALLERGY: nuts". Toast uses red text only.
- **Aging:**
  - At T1 (8 min): `--warning` header with a clock icon.
  - At T2 (12 min): `--danger` header, "LATE" label and a thicker border. Pulse only if motion is allowed.
  - Thresholds are configurable, like Square's yellow/red timers.
- **Layout:**
  - `repeat(auto-fill, minmax(15rem,1fr))` gives 4 columns at 1080p, oldest first.
  - Overflow shows "+N more" instead of scrolling.
  - Bumped items stay visible, muted and struck through, with a **Recall** button.
- **Contrast and TV setup:** `--text` on `--bg` is 17:1. Set TVs to Just Scan/PC mode; otherwise turn on a 5% safe inset.

## 4. Touch targets (evidence)
- **Platform minimums:**
  - Apple: 44×44pt (28 min), tvOS 66pt.
  - Material: 48dp (about 9 mm) with 8dp spacing.
  - WCAG 2.5.8 (AA): 24×24px or 24px spacing. WCAG 2.5.5 (AAA): 44×44.
- **POS vendors:**
  - Toast, Square and Cashdesk offer S/M/L size settings but publish no dimensions.
  - Oracle OSCAR's standard key is 54×54px with a 2px gap.
  - Our 72px tiles and PIN keys are larger on purpose: staff are moving and their hands are often wet.
- **Login flow:**
  - Face grid with photo plus name, showing clocked-in staff first.
  - Tap a face to get the PIN pad. PINs are variable length (Toast allows 3–8 digits), shown as dots, and auto-submit at the stored length.
  - On error: shake, vibrate and `role="alert"`. The keyboard also works.

## 5. Fonts compared
All nine fonts are OFL-1.1 and on npm as `@fontsource-variable/<id>` v5.3.x. Feature support marked "unverified" had no primary source.

| Font | id | Axes | `tnum` | 0/O, 1/l/I | Verdict |
|---|---|---|---|---|---|
| **Inter** | `inter` | wght 100–900, opsz 14–32, ital | yes | `zero`, `ss02`, `cv05`, `cv08` | **Pick** |
| Geist | `geist` | wght 100–900, ital | yes (3rd-party) | tailed l; no slashed 0 in Sans | display-first, no opsz |
| Figtree | `figtree` | wght 300–900, ital | unverified | geometric, I/l close | no feature docs |
| Manrope | `manrope` | wght 200–800 | unverified | — | no italics |
| Plus Jakarta Sans | `plus-jakarta-sans` | wght 200–800, ital | yes (v2.6) | — | stylish, weaker when small |
| Atkinson Hyperlegible Next | `atkinson-hyperlegible-next` | wght 200–800, ital | tabular exists (CTAN) | built for glyph distinction | best raw legibility, quirky; possible accessibility option |
| IBM Plex Sans | `ibm-plex-sans` | wght 100–700, wdth 75–100, ital | yes | slashed 0, clear 1/l/I | runner-up, corporate |
| Public Sans | `public-sans` | wght 100–900, ital | yes | tailed l | unmaintained |
| Onest | `onest` | wght 100–900 | unverified | — | no italics |

## 6. Micro-interactions
- **Press feedback:**
  - `:active` applies `scale(.97)` plus the 10% state layer for 90ms, triggered on pointerdown.
  - `touch-action: manipulation` removes the tap delay.
  - Set a transparent `-webkit-tap-highlight-color`.
  - Never depend on hover.
- **Haptics:**
  - `navigator.vibrate(10)` when an item is added; `[30,40,30]` on errors.
  - Feature-detect first. It needs user activation, and **WebKit/iOS has never shipped it**, so it can only be an extra on top of visual feedback.
- **Optimistic updates:**
  - Ticket edits, table states and clock-ins commit to IndexedDB instantly and queue for sync. Each line shows a pending glyph until it syncs.
  - **Payments are never optimistic:** show "Processing…" until confirmed.
- **Undo toasts:**
  - Used for remove, unsent void and bump.
  - They stay until the next action or 8s, whichever is longer (Apple advises minimising time-boxed UI; WCAG 2.2.1). The action can also be undone from order history.
  - Position: bottom-centre on phones, bottom-left on tablets, away from Pay.
- **Skeletons:** only for remote loads over 300ms (reports). Local-first screens render from cache.
- **Sync pill in the top bar** (icon plus text):
  - "Synced"
  - "Offline · 3 queued" (`--warning`)
  - "Sync failed · Retry" (`--danger`)
  - A one-time banner appears when the device goes offline (Square pattern). Detect with `online`/`offline` events plus a heartbeat fetch, because `navigator.onLine` gives false positives.
- **Reduced motion:** under `prefers-reduced-motion: reduce`, swap transforms, shakes and pulses for opacity or static color changes. The state change must stay visible.

## 7. Accessibility essentials
- **Focus:**
  - `:focus-visible { outline: 2px solid var(--accent); outline-offset: 2px }` (2.4.7).
  - Set `scroll-padding` so sticky bars never hide the focused element (2.4.11).
- **Live regions:**
  - The ticket summary uses `aria-live="polite" aria-atomic="true"`, debounced by 500ms: "5 items, total $42.50".
  - Toasts use `role="status"`; errors use `role="alert"` (4.1.3).
- **Never color alone (1.4.1):** tables, KDS aging, sync and allergies all carry icon plus text, plus a border or pattern. Charts get direct labels.
- **Non-text contrast (1.4.11):** `--border-strong` (≥3.3:1) on input, tile and toggle edges.
- **Zoom:** interactive screens use rem only and survive 200% zoom (1.4.4).
- **Labels:**
  - Face tiles show the name as text, and the photo uses `alt=""`.
  - PIN keys get `aria-label`.
  - The PIN field announces "3 of 4 digits".

---

## Sources
- Toast ordering screens: https://support.toasttab.com/en/article/New-POS-Experience-Ordering-Screens
- Toast Open View: https://support.toasttab.com/en/article/Get-Started-Open-View
- Toast tables: https://support.toasttab.com/en/article/New-POS-Managing-Tables
- Toast KDS appearance: https://support.toasttab.com/en/article/Customize-the-Appearance-of-KDS-Tickets
- Toast display theme: https://support.toasttab.com/en/article/Setting-Up-the-New-POS-Experience
- Toast passcodes: https://support.toasttab.com/en/article/Find-Change-or-Fix-Your-POS-Access-Code-Passcode
- Square Real Time Check View: https://squareup.com/help/ca/en/article/8633-set-up-and-manage-real-time-check-view-for-restaurants
- Square auto-progression: https://squareup.com/help/us/en/article/8280
- Square table indicators: https://squareup.com/help/us/en/article/8146-customize-table-management-settings
- Square KDS: https://squareup.com/help/us/en/article/7944-get-started-with-square-kds-android
- Square offline mode: https://squareup.com/help/article/5095-process-payments-with-offline-mode
- Lightspeed table status: https://resto-support.lightspeedhq.com/hc/en-us/articles/226306187-Understanding-table-status
- TouchBistro: https://cdn.touchbistro.com/help/articles/taking-orders
- Tock timeline: https://tock.zendesk.com/hc/en-us/articles/21837347541652
- Oddle timeline: https://www.oddle.me/docs/help-center/reservations/how-do-i-use-timeline-view
- Oracle OSCAR key size: https://docs.oracle.com/cd/E67482_01/oscar/pdf/4560/OnlineHelp_4560/TouchLayout.html
- Apple HIG Accessibility: https://developer.apple.com/design/human-interface-guidelines/accessibility
- Android touch targets: https://support.google.com/accessibility/android/answer/7101858
- M3 state-layer tokens: https://flutter.googlesource.com/mirrors/flutter.git/+/a38abc864ce67fad39cad7808235b06e10137f7c/dev/tools/gen_defaults/data/state.json
- Window size classes: https://developer.android.com/develop/ui/compose/layouts/adaptive/window-size-classes
- Material dark theme: https://m2.material.io/design/color/dark-theme
- WCAG 2.2:
  - https://www.w3.org/WAI/WCAG22/Understanding/target-size-minimum
  - https://www.w3.org/WAI/WCAG22/Understanding/target-size-enhanced
  - https://www.w3.org/WAI/WCAG22/Understanding/non-text-contrast
  - https://www.w3.org/WAI/WCAG22/Understanding/use-of-color
  - https://www.w3.org/WAI/WCAG22/Understanding/status-messages
  - https://www.w3.org/WAI/WCAG22/Understanding/focus-not-obscured-minimum
  - https://www.w3.org/WAI/WCAG22/Understanding/resize-text
- Android TV typography: https://developer.android.com/design/ui/tv/guides/styles/typography
- Fire TV UX: https://developer.amazon.com/docs/fire-tv/design-and-user-experience-guidelines.html
- Smashing, Designing for TV: https://smashingmagazine.com/2025/09/designing-tv-principles-patterns-practical-guidance/
- Daktronics viewing distance: https://www.daktronics.com/en-us/support/kb/000030569
- Signs.com letter height: https://www.signs.com/blog/?p=16381
- NN/g dark mode: https://www.nngroup.com/articles/dark-mode/
- Fluid type and zoom:
  - https://smashingmagazine.com/2023/11/addressing-accessibility-concerns-fluid-type
  - https://oddbird.net/2025/08/26/type-visual
  - https://adrianroselli.com/2019/12/responsive-type-and-zoom.html
- Vibration API:
  - https://developer.mozilla.org/en-US/docs/Web/API/Navigator/vibrate
  - https://caniuse.com/vibration
- Inter: https://rsms.me/inter/
- Geist vs Inter: https://fontalternatives.com/blog/geist-vs-inter-vs-satoshi-product-ui/
- Fontsource:
  - https://fontsource.org/fonts/atkinson-hyperlegible-next/install
  - https://api.fontsource.org/v1/variable/inter (axes for all 9 checked here)
  - https://registry.npmjs.org/@fontsource-variable/inter
- Atkinson Next tabular figures: https://www.ctan.org/tex-archive/fonts/atkinson
- Plus Jakarta Sans changelog: https://github.com/tokotype/PlusJakartaSans
- Public Sans: https://github.com/uswds/public-sans
- Figtree: https://github.com/erikdkennedy/figtree
