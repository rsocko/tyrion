# DESIGN.md — Tyrion Visual World

> The committed visual world. Codified with Impeccable (v3.5.0). Detector-clean.
> Incumbent authority: `tyrion-brandkit.html`. Product truth: `PRODUCT.md`.

## 1. POV — "The Master of Coin's ledger"
A quiet, dark, precise interface with one warm metal running through it. Feels
like a private counting-house: charcoal, hairlines, tabular figures — with gold
reserved for identity and moments of worth. Wit lives in the **copy**, never in
loud chrome. The opposite of neon fintech.

## 2. Design tokens

### Color (semantic, not decorative)
| Token | Hex | Use |
|---|---|---|
| `--gold` | `#C9A24A` | Brand accent, wordmark, coin. **~5% max. Never a status.** |
| `--gold-hi` | `#E6C260` | Gradient top, hovers, emphasis figures in chat |
| `--oxblood` | `#6A2233` | Secondary brand / deep highlight (sparingly) |
| `--parchment` | `#F3ECDD` | Primary text on dark |
| `--bg` | `#15171C` | App base |
| `--elevated` | `#1D2027` | Panels / chat surface |
| `--card` | `#23272F` | Cards, rows |
| `--card-2` | `#2A2F38` | Track fills, inner chips |
| `--muted` | `#A9A293` | Secondary text |
| `--dim` | `#6E6A60` | Tertiary / captions |
| `--hair` | `rgba(243,236,221,.08)` | Hairline borders |
| `--success` | `#2FB170` | Paid / on-track |
| `--warning` | `#E7A13A` | Due soon / near limit |
| `--error` | `#D2453D` | Overdue / duplicate |
| `--info` | `#4F8FF7` | Pending / neutral notice |

**Guardrail:** gold and `--warning` amber must never touch — they read alike.
Charts use the category palette below, never status hues.

### Category palette (spending, desaturated to sit on charcoal)
Housing `#C9A24A` · Groceries `#7FA66A` · Dining `#C9743D` · Transport `#4F8FA8`
· Utilities/Subs `#8A6FB0` · Health `#5FA3A0` · Shopping `#B08968` · Entertainment `#A56FA0`

### Per-kid attribution (fixed color + monogram)
Assign one stable color per child, reused across triage, charts, chips, alerts.
Seed set: `#4F8FA8`, `#C9743D`, `#7FA66A`. Monogram avatar, dark text on color.

### Type
| Role | Face | Notes |
|---|---|---|
| Display / wordmark | **Cormorant Garamond** 600–700 | High-contrast serif = character. Garnish only (see §3a) |
| Interface / body | **IBM Plex Sans** 400–700 | Engineered ledger/enterprise sans; pairs with the mono. Locked default — off the "overused" list |
| Figures / data | **JetBrains Mono** + `tabular-nums` | Money always tabular so columns align |

**Sans candidates (swappable — it's one CSS var `--ui-font`):** live A/B switcher in `tyrion-dashboard.html`.
| Face | Character | Verdict |
|---|---|---|
| **IBM Plex Sans** *(current / preferred)* | Engineered, ledger/enterprise; pairs w/ Plex Mono | Leaning "counting-house" — user's pick |
| **Hanken Grotesk** | Warm humanist grotesque, a little softer | 2nd — if we want friendlier |
| **Public Sans** | Neutral, civic, Treasury-commissioned | 3rd — safe/meaning bonus |
| **Instrument Sans** | Modern, slight flare, distinctive | If we want more edge |
| **Source Sans 3** | Adobe humanist workhorse, very readable | Neutral all-rounder |
| **Atkinson Hyperlegible** | Legibility-first (Braille Institute); disambiguated glyphs | Thematic for a money app; distinctive |
| *(Söhne / Neue Haas)* | Premium fintech neutrality | Paid — skip for a personal build |
All are free and clear of Impeccable's overused-font list. Body copy reads "Public
Sans" below — treat as `--ui-font`; **current default is IBM Plex Sans**.

### Spacing / radius / elevation / motion
- Space scale (4px base): 4 · 8 · 12 · 16 · 20 · 24 · 32 · 48 · 64
- Radius: sm 6 · md 10 · lg 14 · pill 999 · coin = circle
- Shadow: sm `0 1px 2px rgba(0,0,0,.45)` · md `0 6px 18px` · lg `0 16px 40px`
- Focus/active gold glow: `0 0 0 3px rgba(201,162,74,.22)`
- Motion: fast 120ms · base 160–180ms · slow 300ms · easing `cubic-bezier(.2,0,0,1)`. Honor `prefers-reduced-motion`.
- Breakpoints: 640 · 768 · 1024 · 1280

## 3. Logo & avatar — "The Coin"
Gold reeded roundel (radial highlight top-left), embossed serif **T**, subtle
inner ring. Wordmark: `Tyrion` in Cormorant with a gold period. **Never** a
literal Lannister lion.

**Three optical cuts (renderer picks by target size — silhouette constant):**
| Cut | Size | Interior |
|---|---|---|
| **Full** | ≥56px | Reeded edge + inner ring + emboss + true high-contrast serif T |
| **Simplified** | 24–52px | Reeding dropped, **inner ring kept** for depth; solid rim; T grown ~20% and re-centered |
| **Micro** | ≤20px | Inner ring gone but a **solid coin rim stays** (never a bare disc); T fattened with a stroke |

**Degradation principle:** detail drops from the inside out — reeding first, then the
inner ring — but **a coin edge (rim or reeding) is the last thing to go**. The mark
must always read as a coin, never a plain circle with a letter.

**Applies to every finish, not just the gold coin.** The monochrome, inverted, and
outline variants carry the *same* size-tiered detailing — prefer reeding **and** the
inner ring at large sizes, keep at least the inner ring at mid sizes, and only fall
back to a bare rim when truly small. Inverted (charcoal coin / gold T) and flat-gold
tiles used on home-screens and installed-app icons therefore get `cInvFull` /
`cMonoFull` (reeded edge + inner ring) at ≥56px and `cInvSimple` (inner ring) at
24–52px — so a monochrome or app-tile coin is never a flat disc with a T.

Clear space = ½ coin diameter. Min size = 16px (micro). App tiles: coin at ~62%
of a rounded-square (22% radius) so OS masks never clip. See `tyrion-logo-lab.html`.

## 3a. Serif philosophy — where the Cormorant lives (and where it must not)
The serif is the *character*, so it is a **garnish, not the meal**. Overuse makes
it costume drama and hurts scanning.

**Serif (Cormorant) — allowed:** the wordmark; the coin's T; page/section hero
titles (h1/h2); a single italic "role" or motto line; empty-state one-liners in
Tyrion's voice. That's it.

**Never serif:** numbers/money (always mono, tabular), buttons, labels, form
fields, table/row text, nav, alerts, tooltips, any dense UI. Rule of thumb: if a
user *reads it to act*, it's IBM Plex Sans; if they *feel it*, it can be Cormorant.
Target ≤ ~10% of on-screen text in serif.

## 4. Components (see kit)
Buttons (gold primary / secondary / ghost) · status pills (dot + tint) ·
transaction rows (icon + merchant + tabular amount) · kid chips · coin-ring
progress (SVG stroke-dashoffset) · category bars · chat bubbles (coin avatar,
gold-tinted user bubble, typing dots) · alert cards (**tinted leading badge, no
side-tab**) · skeleton/empty/error states.

## 5. The agent surface
Coin = Tyrion's avatar. Bubbles left-aligned; emphasized money in `--gold-hi`.
Suggested prompts as ghost pills. Voice: witty, candid, brief, family-safe.

## 6. Alerts → Mission Control
Every alert carries a `TYRION` source label (mono, gold, uppercase) into MC's
feed. Severity shown by the badge color + copy tone, not a colored side border.

## 7. Voice matrix
| Context | Line |
|---|---|
| Hero | "I count, and I know things." |
| Motto | "Always pays your debts." |
| Onboarding | "A Lannister always pays his debts. Let's make sure you do too — on time, and exactly once." |
| All clear | "Every bill paid, once, on time. A rare and beautiful thing." |
| Duplicate | "You paid Verizon twice this month. Generous. Shall I flag it for a refund?" |
| Forecast | "At this pace you'll close the month about $840 ahead. Nicely done." |
Rules: dry not mean; observation over instruction; PG always.

## 8. Accessibility floor
Parchment `#F3ECDD` on `#15171C` ≈ 14:1. Never color-alone for status — pair
with icon/label/pill text. Visible gold focus ring. Reduced-motion honored.
Tabular figures for all money.

## 9. The realm (family fit)
Mission Control = the capital/small council (blue hub). OWL = the Maester
(amber-on-navy, documents). Tyrion = the Master of Coin (gold-on-charcoal,
money). Shared: dark-first, restrained, one accent, character-name-as-agent.

## 10. Impeccable status
Detector: **clean** (`detect.mjs` → `[]`). Fixed: removed side-tab accent
borders on alerts; replaced Inter with a civic sans, then locked **IBM Plex Sans**
as the interface face (both off the overused-font list).
Mode: **Operate**. Re-run `node ~/.agents/skills/impeccable/scripts/detect.mjs
--json tyrion-brandkit.html` after UI edits.
