# Card names and codes expected by CardNexus and Piltover Archive — 2026-11-07

Research for issue #9. Question: for CardNexus and Piltover Archive, which card name does each expect for legends and champion units, and which code format does each accept for alt-art and special prints such as `SP4/005`? The answer determines whether the CSV export should keep the Riot gallery `name` or build "champion, title".

## Short answer

| | Piltover Archive | CardNexus |
|---|---|---|
| Legend name | `Champion, Title`, e.g. `Kai'Sa, Daughter of the Void` (catalog data, public) | **Not public.** Catalog pages return HTTP 403 to automated fetches; import template requires the app. Name match is documented as exact. |
| Champion unit name | `Champion, Subtitle`, e.g. `Kai'Sa, Survivor` (catalog data, public) | **Not public**, same reason. |
| Code for special prints | Variant Number `RAD-SP4`, `VEN-SP1` (set prefix, hyphen, `SP<n>`, no `/005`) | "Print number" is free text: documented examples are `223/264`, `EN001`, `12a`. No Riftbound `SP` example. |
| How rows are matched | **Not public.** Import and export pages require sign-in. | CardNexus ID > vendor ID > print number with name or expansion > name alone (documented). |

The app currently sends the gallery name, such as `Daughter of the Void` or `Kai'Sa`, to both targets. That name does not match the Piltover Archive catalog name for legends or champion units. CardNexus is documented to match names exactly, so if its catalog uses the same names (not verified), the gallery name would fail there too.

## Piltover Archive

### Sources and access

- Public card library: `https://piltoverarchive.com/cards?page=1` … `?page=31` (fetched 2026-11-07). Each page embeds JSON variant records with `variantNumber`, `variantType`, `variantTypes`, `variantLabel`, `rarity`, `set{name,prefix}` and `card{name,type,super,tags}`. All 31 pages were parsed, yielding 1,460 variants.
- Collection import and export are private. `https://piltoverarchive.com/collection/import` and `/collection/export` redirect to `/sign-in`, and the same happens for any `/collection/*` path. Therefore neither the existence of these routes nor the importer's matching rules could be confirmed. No public import documentation was found on `/news` or `/learn`. Piltover Archive's own account announced collection tracking in late October 2025 ([X announcement](https://x.com/PiltoverArch/status/1984054789513383975)). I found no public CSV specification from Piltover Archive. The CSV header used by the app (`csvExporter.js:29-45`) cannot be verified against a primary source without signing in.

### Names (catalog)

`card.name` combines champion and title or subtitle with `", "` for both legends and champion units. The champion is also in `tags`.

| Variant Number | card.name | type / super | page |
|---|---|---|---|
| `OGN-247` | `Kai'Sa, Daughter of the Void` | Legend | `?page=6` |
| `OGN-299` / `OGN-299*` | `Kai'Sa, Daughter of the Void` | Legend (Overnumbered / Overnumbered Signed) | `?page=8` |
| `OGN-039` / `OGN-039a` | `Kai'Sa, Survivor` | Unit / Champion | `?page=1` |
| `RAD-SP4` | `Kai'Sa, Rebel` | Unit / Champion | `?page=31` |
| `VEN-SP1` | `Kai'Sa, Survivor` | Unit / Champion | `?page=26` |

All 151 Legend variants use `Champion, Title` (for example `SFD-181 Rumble, Mechanized Menace`). Of 361 Champion units, the only name without a comma is `RAD-114 Riven Deserter`. That catalog entry appears to be an error and suggests the importer may not normalise names.

### Variant Number formats seen

Format counts across the 1,460 variants, with digits shown as `9`:

- `PFX-999`: 1,211. Alt art uses `PFX-999a`: 121, or `PFX-999b`: 7.
- Signed: `PFX-999*`, 50. The star is retained, as in `OGN-299*`.
- Runes: `PFX-R99`, 18, and `PFX-R99a`, 18. Tokens: `PFX-T99`, 14.
- Special prints: `PFX-SP9`, 11. These are `VEN-SP1`…`VEN-SP6` and `RAD-SP1`…`RAD-SP5`. They carry `rarity: "Showcase"`, `variantType: "Alt Art"` and labels such as `"K/DA"` or `"Crystal Rose"`. `RAD-SP4` has `variantTypes: ["Alt Art","Overnumbered"]`.
- Promos and events use suffixed numbers: `OGN-151b-Nexus`, `OGN-197b-Nexus`, `OGN-193b-Regionals`, `OGN-263-Worlds`, `RAD-042a-RCTop`, `RAD-157-Prize`. Their own sets include `OGS-001…024` (Proving Grounds) and `ARC-001…` (Arcane Box Set).

No variant number contains `/total`. The `/005` denominator is never part of a Piltover variant number.

## CardNexus

### Sources and access

- `https://www.cardnexus.com/riftbound` returns HTTP 403 to both `curl` and WebFetch. No CardNexus catalog page for a Riftbound card could be read, so **CardNexus's Riftbound card names and print-number formats are not publicly verifiable here.**
- [Importing your inventory from a CSV](https://help.cardnexus.com/articles/0020599-importing-your-inventory-from-a-csv):
  - Headers are auto-detected and mapped, so there is no fixed header list. Fields include Quantity, Expansion ("Set name or set code both work"), Finish, Condition, Language and Variant ("only on some games").
  - Identifier ranking: CardNexus ID "Perfect"; Vendor ID (Cardmarket, TCGplayer, …) "Excellent", matched across the whole game; Print number "Good" "(with the card name or the expansion)"; Card name alone "Risky".
  - Print number examples: "223/264, EN001 or 12a". Nothing is specific to Riftbound.
  - Error "Card not found": "The name and print number combination does not exist for that expansion."
  - Step 1 offers **Download template** with "the right column titles and a few filled-in example rows for the game you picked". That template is inside the app and could not be retrieved, so the Riftbound template is not public here.
- [Importing cards from a deck list or text](https://help.cardnexus.com/articles/0885595-importing-cards-from-a-deck-list-or-text) / [`0800160`](https://help.cardnexus.com/articles/0800160-importing-cards-from-a-deck-list-or-text): "we match the name exactly and will not correct an approximate spelling for you". It also says "Magic: The Gathering, Flesh and Blood and Riftbound have their own dedicated rules" but does not describe the Riftbound rules.

### Implications (inference, not verified)

- Name match is exact, and a wrong name plus print number yields "Card not found". The export therefore needs CardNexus's catalog name. Which name form CardNexus uses for Riftbound legends and champions is unknown. Riftbound marketplaces usually include both champion and title, but those are not CardNexus sources.
- The `Expansion` value `OGNX`, used for promos (`csvExporter.js:146`), has no public CardNexus source.
- A vendor ID would avoid name matching entirely. Piltover Archive's catalog exposes `cardmarketId` and `tcgplayerId` per variant; the Riot gallery data stored by this app does not.

## What the app sends today (`src/lib/csvExporter.js`)

Card data comes from the Riot gallery. `src-tauri/src/main.rs:680-690` stores gallery `name`, `collectorNumber` (as `number`) and `publicCode` (as `code`, e.g. `RAD-SP4/005`). `src/lib/cardData.js:4-7` derives `collectorNumber` from the code: `RAD-SP4/005` → `SP4`.

### CardNexus row (`csvExporter.js:143-157`, headers `:19-27`)

| Column | Value | `Daughter of the Void` OGN-247 | `RAD-SP4/005` |
|---|---|---|---|
| Card Name | `cardData.name` (gallery) | `Daughter of the Void` | `Kai'Sa` (subtitle `Rebel` dropped) |
| Collector Number | `collectorNumber` with `*` stripped (`:145`) | `247` | `SP4` |
| Expansion | `OGNX` if promo, else `cardData.set`, else `OGN` (`:146`) | `OGN` | `RAD` |
| Condition / Language | user value or `Near Mint` / `English` | | |
| Finish | `Foil` / `Standard` (`:155`) | | |

Stripping `*` turns signed `299*` into `299`, the same value as the non-signed overnumbered printing.

### Piltover Archive row (`csvExporter.js:159-185`, headers `:29-45`)

| Column | Value | vs. Piltover catalog |
|---|---|---|
| Variant Number | `code` before `/` (`:81-89`) → `OGN-247`, `OGN-299*`, `RAD-SP4` | **Matches** PA format, including `*` and `SP` |
| Card Name | gallery `name` (`:170`) → `Daughter of the Void`, `Kai'Sa` | **Differs**: PA has `Kai'Sa, Daughter of the Void`, `Kai'Sa, Rebel` |
| Set | `setName` or `set` (`:64-66`) | PA set name, e.g. `Origins`, `Radiance` (gallery value not checked) |
| Set Prefix | `set` (`:74-79`) | PA prefix `OGN`, `RAD` |
| Rarity | title-cased gallery rarity (`:173`) | PA uses `Rare`, `Showcase`, … |
| Variant Type | `Promo` / `Overnumbered` / `Showcase` / `Standard` (`:105-111`) | **Differs for SP/alt art**: PA uses `Alt Art` (and `Overnumbered`), never `Showcase`. `RAD-SP4` → app `Showcase`, PA `Alt Art`. |
| Variant Label | `<Set> Promo` / `Overnumbered` / `<PFX> Foil` / `Alt Art` / `Foil` / `Standard` (`:113-141`) | **Differs** for SP (`Alt Art` vs PA `K/DA`, `Crystal Rose`), signed (`Overnumbered` vs `Overnumbered Signed`), and promos (`Origins Promo` vs `OGN Nexus Night Promo` etc.) |
| Foil | `true`/`false` | |
| Quantity, Language, Condition | user values | |
| Grading ×3, Notes | empty | |

Because Piltover Archive's importer is behind sign-in, it is unknown which of these columns it uses as the key. If it uses Variant Number, the current export probably works despite the wrong names. If it uses Card Name, or checks Card Name against Variant Number, legends and champion units will fail.

## Open questions

1. Does Piltover Archive's importer match on Variant Number, Card Name or both? Answering this requires a signed-in test import, for example one legend row with `Daughter of the Void` and one with `Kai'Sa, Daughter of the Void`.
2. What does CardNexus's Riftbound **Download template** contain, and what are its catalog names and print numbers for legends, champions and `SP` prints? This requires a signed-in CardNexus account.
3. Do promo variant numbers in the Riot gallery `publicCode` match Piltover Archive's suffixed numbers, such as `OGN-151b-Nexus`? The gallery data was not checked here.
