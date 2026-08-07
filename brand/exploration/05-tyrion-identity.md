# TYRION — Brand Identity Kit

> **Master of Coin.** Your household finances, managed by someone clever.

A single name that is simultaneously the **product** (a UI you open), the **agent** (a voice you ask), and an **actor** (“Tyrion found…”) — the same shape as OWL. Named for the wittiest, most honest Master of Coin in fiction; the meaning (he literally ran the crown’s treasury) and the agent-voice (he’s a *character*) are both native to the name.

---

## 1. Positioning
- **What it is:** an autonomous + assistive finance agent with its own UI — syncs Monarch, reconciles bills against OWL’s documents, attributes kids’ spending, forecasts cash flow, and alerts — surfaced inside / alongside Mission Control.
- **One-liner:** *“Tyrion counts the coin so you don’t have to.”*
- **Elevator:** Tyrion watches every account, pays every debt once and on time, tells you the truth about your money — and makes you smile while doing it.

## 2. The universe (how it sits beside OWL & Mission Control)
Think of **Mission Control** as the capital / small council, and its specialists as officers:
- **OWL** — the **Maester**: reads the documents, keeps the knowledge (Organize · Watch · Learn).
- **TYRION** — the **Master of Coin**: watches the money, pays the debts, forecasts the treasury.

Two characters, one realm. It gives the whole system a coherent “small council of agents” story without either name copying the other. OWL owns *amber-on-navy, wise night-bird*; Tyrion owns *gold-on-charcoal, witty Master of Coin*. Distinct lanes, same restrained dark-first family.

## 3. Personality & voice
**Tyrion’s register:** witty, dry, candid, pragmatic. On your side, but will always tell you the unflattering truth about your money. *“I count, and I know things.”*

**Do**
- Dry wit and the occasional wry aside — earned, not forced.
- Radical honesty about spending, delivered kindly.
- Brevity. Every word earns its place (inherited from OWL’s “concise, not terse”).
- Confidence without arrogance; clever without smug.

**Don’t**
- Never mean, scolding, or shaming about money.
- Keep it **family-safe** — this app has your kids in it; skip the show’s wine/brothel edge.
- Don’t bury the UI in GoT quotes. Wit is *felt*, not stated (same principle as OWL’s “skip the puns”). A light seasoning, not the whole meal.

**Microcopy examples**
- **Onboarding:** “A Lannister always pays his debts. Let’s make sure you do too — on time, and exactly once.”
- **Sync complete:** “Fetched 42 transactions. Three are pretending to be groceries.”
- **Duplicate caught:** “You paid PSE&G twice this month. Generous, but unnecessary — want me to flag it?”
- **Kid over limit:** “Jake’s past his weekly limit. Shall I have a word, or will you?”
- **All clear (empty state):** “Every bill paid, once, on time. A rare and beautiful thing.”
- **Forecast:** “At this pace you’ll close the month about $840 ahead. Nicely done.”
- **Subscription audit:** “You’re paying for two music services. Even I can only listen to one at a time.”

## 4. Taglines
- **Primary:** *Master of Coin.*
- *Always pays your debts.*
- *I count, and I know things.* (hero line)
- *Counts the coin so you don’t have to.*
- *Every bill paid — once, on time.* (the reconciliation promise)

## 5. Logo & marks
- **Primary mark — “The Coin”:** a minimal gold roundel with a reeded (milled) edge and an embossed serif **“T”**. Reads instantly as a coin (Master of *Coin*) and as the monogram. Favicon-perfect at 16px.
- **Wordmark:** “Tyrion” set in a refined high-contrast serif; optionally the dot of a lowercase variant or the counter of the “o” rendered as a tiny coin.
- **Agent avatar:** the coin as a circular chat avatar; an “active/speaking” variant with a faint gold glint along the reeded edge.
- **Recurring motif:** the **reeded coin-edge** as a UI accent — dividers, and **progress rings drawn as stacked coins** (savings goals, budget fill).
- **Avoid:** the literal Lannister lion / house sigil (too on-the-nose + IP). The coin is cleaner and ownable-feeling.

## 6. Color system
Dark-first. Gold is a *brand* accent used sparingly (~5%, OWL-style discipline) — **never** a status color.

| Role | Hex | Use |
|------|-----|-----|
| Brand gold | `#C9A24A` | wordmark, coin mark, active nav, key accents |
| Gold highlight | `#E6C260` | hovers, glints, small emphasis |
| Oxblood (house deep) | `#6A2233` | section headers, deep decorative panels (NOT status) |
| Charcoal base | `#15171C` | app background |
| Surface elevated | `#1D2027` | bars, sheets |
| Card | `#23272F` | cards, rows |
| Parchment (text) | `#F3ECDD` | primary text |
| Muted text | `#A9A293` | secondary text |
| Dim text | `#6E6A60` | metadata |

**Status colors (sacred — kept unambiguous, per OWL’s finance rule):**
| Status | Hex |
|--------|-----|
| Success | `#2FB170` |
| Warning | `#E7A13A` |
| Error | `#D2453D` |
| Info | `#4F8FF7` |

**Guardrail:** brand **gold is yellow-brass**; **warning is orange-amber** — keep them visually separated and **never place the gold accent adjacent to a warning badge** (the one trap OWL flagged). Gold = decoration/brand; amber = “pay attention.”

## 7. Typography
- **Display / wordmark:** a refined high-contrast serif (e.g., *Cormorant Garamond* or *Playfair Display*) — house-sigil gravitas; distinguishes Tyrion from OWL’s geometric *Space Grotesk* while staying in the same restrained family.
- **UI / body:** *Inter* — fast, accessible, data-friendly.
- **Figures / data:** a **tabular-figures mono** (e.g., *JetBrains Mono* / *Commit Mono*) — numbers align in columns; essential for a money app.
- **Ethos:** serif for *character* (headings, the name, empty states), sans for *clarity* (UI), mono for *money* (every dollar amount).

## 8. Design ethos
- **“Wealth is quiet.”** Mostly charcoal + parchment; gold appears only where it matters. Restraint reads as competence and trust.
- **Coins as a system:** progress toward goals shown as stacking/filling coins; the reeded edge recurs as a subtle texture.
- **Wit in copy, calm in chrome:** the personality lives in the words (notifications, empty states), not in loud visuals — the interface itself stays composed, even when Tyrion is being funny.
- **Dark-first, light-capable:** dark is primary; a light “parchment” theme uses charcoal ink on cream with the same gold + oxblood accents.

## 9. System identity
- **Subdomain:** `tyrion.socko.us` (neutral fallback `coin.socko.us`).
- **Alert source label:** “Tyrion” (e.g., in Mission Control’s unified alert feed: *“Tyrion · Bill due in 3 days”*).
- **Service / container names:** `tyrion`, `tyrion-bridge` (the Monarch FastAPI service), `tyrion-mcp`.
- **Favicon / app icon:** the gold coin mark.
- **In-app signature:** the “Always pays your debts” motto in the footer / login.

## 10. Where the GoT reference should (and shouldn’t) show
- **Show (subtle, delightful):** the *“Always pays your debts”* motto; the coin mark; a witty empty-state or two; the login tagline.
- **Don’t (overdone):** wall-to-wall show quotes, character art, the lion sigil, or anything that ages into cringe on daily use. Same guiding principle OWL used: the reference is a *seasoning*. The name and the coin already carry the personality — let the finances be the star.

---

### Quick-start checklist (if/when you build it)
- [ ] Gold coin favicon + wordmark in the app top-left
- [ ] Alert source “Tyrion” wired into Mission Control’s feed
- [ ] Tabular-mono for all currency figures
- [ ] One signature empty-state line + the debts motto on login
- [ ] Charcoal/parchment dark theme with gold reserved for accents only
