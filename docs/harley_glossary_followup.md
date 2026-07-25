# Harley knowledge layer — deferred parser-comprehension follow-up

Companion to the deterministic alias-map layer shipped in the "Harley knowledge layer:
slang + attribute + engine glossary" PR (Joe glossary, 2026-07-24). That PR shipped the
**phrase → catalog-code** parts (model slang, attribute/body-style → group, segment
reconcile, FLHR/FLHRC split) in `services/api/src/domain/model_codes_by_family.json` plus
the governance hooks in `detectGenericWatchFamilyLabel` (index.ts), pinned by
`scripts/harley_slang_glossary_eval.ts`.

Everything below is **NOT a phrase→code map** — it is comprehension (year-band inference,
make routing, clarify behavior, modification notes). Per AGENTS.md it must be taught with
typed `inventory_entity` parser few-shots + schema fields (in `services/api/src/domain/llmDraft.ts`),
never regex, and pinned by additive parser fixtures (`inventory_entity:eval`). Approve-first
(Tier 2) — open a PR, never auto-merge. **Never fabricate a catalog code, kit content, or
year Joe did not specify.**

## 1. Engine era → YEAR BAND (Table 3), combines with the model
Teach: `"twin cam Road King"` → model = Road King, year_min 1999 / year_max 2016. The alias
map already narrows `twin cam` to a model GROUP; the parser adds the **year band** and pairs
it with the named model.
- flathead 1929–1973 · knucklehead/knuckle 1936–1947 · panhead/pan 1948–1965 ·
  shovelhead/shovel 1966–1984 · ironhead 1957–1985 · evo/evolution/blockhead 1984–1999 ·
  evo sportster 1986–2022 · twin cam/twincam/tc 1999–2016 (tc88 1999–2006, tc96 2007–2016,
  tc103 2010–2016, tc110 2009–2016) · m8/milwaukee-eight/milwaukee-8/wafflehead 2017+
  (107 2017+, 114 2017+, 117 2017+, 121 2023+) · revolution 2001–2017 · revolution max/
  rev max/revmax 2021+ (975 → 2022+ Nightster, 1250 → 2021+ Sportster S / Pan Am).
- **Generator vs alternator Shovelhead (Joe 7/24):** generator shovel / generator
  shovelhead / pan shovel / pan-shovel / slab-side / flat-side shovel = EARLY generator
  Shovelhead **1966–1969**; cone/alternator Shovel = 1970–1984.

### Fuel delivery → year band (family-specific, NARROWS only, never sole resolver)
`carbureted/carb {model}` = older, `fuel injected/EFI/injected {model}` = newer. Cutovers:
Touring ≤2001 carb / 2002+ EFI · Softail ≤2000 / 2001+ · Dyna ≤2003 / 2006+ ·
Sportster ≤2006 / 2007+ · whole lineup all-EFI by 2007–08.

## 2. Anniversary editions → YEAR (Table 4), combines with the model
year = 1903 + N: 90th→1993, 95th→1998, 100th→2003, 105th→2008, 110th→2013, 115th→2018,
120th→2023, 125th→2028. `"120th anniversary Street Glide"` → 2023 Street Glide, limited/
numbered flag. Model-specific too (`Fat Boy 30th` = 2020). Bare "anniversary" → CLARIFY.

## 3. Collections / limited editions (Table 4) — tag → CLARIFY; named edition → its model
- **Icons** / **Enthusiast** alone → CLARIFY which. Named editions carry a limited/serialized
  flag and are usually collector/special-order/used context, not general new stock:
  Electra Glide Revival, Low Rider El Diablo, Electra Glide Highway King, Hydra-Glide Revival,
  Fat Boy Gray Ghost (Icons); G.I. Edition, Fast Johnnie, Tobacco Fade, Liberty Edition
  (Enthusiast, map to their base models).
- **Vintage/collector special editions (Joe 7/24) — recognize + CLARIFY year, NO current
  code, never new stock:**
  - `confederate` / `confederate edition` = 1977 Confederate Edition (FLH Shovelhead + XLH Ironhead).
  - `liberty edition` is **AMBIGUOUS across THREE years → CLARIFY**: 1976 Bicentennial /
    1986 Statue of Liberty / 2026 Enthusiast. (Deliberately NOT an alias-map key.)
  - `sturgis` → CLARIFY: 1980 FXB Sturgis (Shovelhead belt-drive) or 1991 FXDB Sturgis (first Dyna).
  - `vr1000` / `vr-1000` / `vr 1000` = HD VR1000 superbike (1994–2001, ~50 built; V-Rod
    Revolution engine ancestor). Ultra-rare collector, no current code.

## 4. Buell (Table 5) → TRADE-IN make, never HD stock
Buell = HD's discontinued sport brand (1983–2009). Recognize `buell`, `blast`, `lightning`
(+ Buell context), `firebolt`, `ulysses`, `thunderbolt`, `cyclone`, `1125R/1125CR`,
`S1/X1/XB9/XB12/CityX/S2/S3/M2/RR1000/RR1200/RS1200/RW750` as a **Buell trade-in** → route to
appraisal, never map to an HD model or book as HD stock. **Collision (glossary-flagged):**
Buell "Lightning" must NOT trip HD's LIGHTWEIGHT family key — Buell context (make=Buell, or a
paired S1/XB/etc. token) must win. The shipped PR already pins deterministically that no Buell
term is an HD alias (`harley_slang_glossary_eval.ts`); the parser must add the positive
trade-routing.

## 5. Ambiguous → CLARIFY, never hard-resolve (governance)
`883` (Iron 883 vs older Sportster 883), `1200` (several Sportster 1200s), `iron` (Iron 883
model vs Ironhead engine era), `low rider` (base/S/ST), `bobber`, `naked`, `standard`,
`sporty` (which Sportster), `cafe racer`/`café racer` (default CLARIFY; vintage/trade context
→ HD XLCR 1977–78 Sportster Café Racer, or **Buell 1125CR = a Buell trade**, not HD stock),
displacement numbers (107/114/etc → narrow year/trim, never alone pick a model). None of these
are alias-map keys today (pinned) — the parser must emit a clarify turn, never guess.

## 6. Installed KIT / accessory / custom → base model still resolves (Joe 7/24)
When a customer names an installed kit/accessory, the **BASE MODEL still resolves**; the kit
is a **modification note for trade value, NEVER a different model**, and must never defeat
model resolution or fire a wrong-model signal.
- `"Fat Boy with the Night Stalker kit"` → model = **Fat Boy** + a "Night Stalker kit"
  HD-modification note. Night Stalker was a **real HD-offered kit** for the Fat Boy
  (older/obscure) — a known HD kit, not unknown aftermarket. Do NOT fabricate its contents or
  years (Joe did not specify).
- Generic kits (`Stage IV`, `big bore kit`, aftermarket exhaust, etc.) → same rule: base model
  resolves, add a modified/aftermarket flag, don't fabricate an unknown kit's spec.
- Add an `inventory_entity` few-shot + fixture pinning: kit mention → correct base model + a
  modification flag, NOT a mis-resolve or a different model.

## 7. Police / authority variants (Table 2c) — combine with base model; some real codes
`police` / `authority` / `cop bike` combines with the base model → the police variant; bare
`police` → CLARIFY base. `ex-police` / `former police` / `retired police` → USED police bike,
trade/used context. Real P-codes exist in the catalog for some (resolve real codes) and are
recognize-only for the discontinued ones:
- Electra Glide Police = **FLHTP** · Road King Police = **FLHP** · Road Glide Police =
  **FLTRXP** (all present in `model_codes_by_family.json`; the `police pursuit` alias already
  covers FXDP/FXRP). Dyna Defender = FXDP (2002–03, discontinued) · XL883 police (recognize-only).
- **Fast-follow candidate for the deterministic layer:** `electra glide police`→FLHTP,
  `road king police`→FLHP, `road glide police`→FLTRXP are real-code aliases that mirror
  existing codes and could move to `model_codes_by_family.json` with an eval case; deferred
  here only to keep the current PR green and un-churned.

## 8. Vintage race/street XR + Aermacchi (Tables 4b) — recognize-only, trade/collector
- `xr750` / `xr-750` = XR750 flat-track racer (1970+, race-only, iconic collector, NO code).
  `xr1000` = 1983–84 street Sportster (rare, recognize-only). `xr1200`/`xr1200x` = 2008–12
  street (xr1200 already in the alias map).
- **Aermacchi (Table 4b) — handle like Buell:** HD's Italian small-bike era 1960–78 (Sprint
  250/350, Rapido, Baja, SS/SX two-strokes, Z-90/X-90). Recognize the era/brand via the parser
  (the frontier model knows the lineup — do NOT exhaustively enumerate), all recognize-only / no
  current code → route to appraisal, never new stock, never fabricate specs.

## 9. Search by physical SPEC (Table 2d) — feature → GROUP, NARROW/clarify
Customers shop by a feature, not a model name. Curate a feature→group map (like the fairing
groups), since the catalog likely lacks tire/spec fields — NARROW or clarify, never resolve one
bike or fire a watch.
- `wide tire` / `fat tire` / `fat rear` / `240` / `240mm` → fat-rear group: Breakout 240
  (2013+), Fat Boy 240 (2018+), Night Rod Special / V-Rod Muscle 240, Rocker.
- `v-rod with a wide tire` → Night Rod Special / V-Rod Muscle.
- Spec→year hint: Fat Boy rear tire grew 130→150→200 (2010)→240 (2018+).

## 10. Generation / redesign era → year band (near Table 3) — NARROW/clarify
- `project rushmore` / `rushmore` → 2014+ Touring.
- `gen 2 touring` → **per-dealer authoritative mapping (Joe 7/24): the NEW-design +
  new-infotainment touring generation, staged by model** — 2023+ CVO Street Glide & CVO Road
  Glide → 2024+ (non-CVO) Street Glide & Road Glide → 2026+ the rest of Touring + Trikes
  (Electra Glide/Ultra, Road King, Tri Glide, Freewheeler). So `gen 2 street glide` = 2024+
  Street Glide (new design); `gen 2 cvo road glide` = 2023+. It is a year+design signal that
  NARROWS by model. Soft fallback: some enthusiasts historically meant the 2014 Rushmore —
  clarify ONLY if the customer's context clearly points to an older bike. **This is a
  per-dealer definition** — a concrete reason the alias/knowledge layer must be per-dealer
  swappable.
- `mono shock softail` → 2018+ Softail; `twin shock` / `hidden shock softail` → ≤2017 Softail.
These NARROW the year for the named model; never hard-resolve/fire/claim specificity.
