# Plain-text card lists accepted by riftbound.gg, Rift Atlas and Piltover Archive — 2026-11-08

Research for issue #12. The question: which plain-text card list format do riftbound.gg and similar Riftbound sites import? The answer covers quantity syntax, card names (legends and champions), print selection (alt art, `SP`, signed, overnumbered), foil, and section headers. It also says which formats are shared, so one text export could work on several sites.

"Riftatla" from the user report is **Rift Atlas** (`riftatlas.com`), a fan-made Riftbound deck builder and browser simulator with an **Import Deck** box ([changelog](https://riftatlas.com/changelog): "Pasting a long deck list … into Import Deck").

## Method and sources

None of the three sites publishes a format specification. Every rule below was read from the site's own production JavaScript, the code that runs when you paste. The bundles were fetched without logging in on 2026-11-08:

- **riftbound.gg** is built on the DotGG platform. Sources: `https://riftbound.gg/wp-content/plugins/dotgg-game/common/js/common.f39dd0f3da2ae957172e.js` (parser and matcher) and `…/games/riftbound/js/main.3e39a3cd01096caf40a5.js` (Riftbound config). The card catalog is the public `https://api.dotgg.gg/cgfw/getcards?game=riftbound` (1,829 entries). `https://riftbound.gg/decks/` returned HTTP 403 to curl. `/builder/` and `/collection/` loaded. Importing into a collection requires login (`"You need to be logged in to import a collection."`), so no import was test-run.
- **Rift Atlas**: `https://riftatlas.com/_next/static/chunks/070h4qx-04scc.js` (`parseDecklist`, `buildDecklistText`) and `…/39e3wd3w1rggj.js` (embedded card catalog, 1,534 entries, plus lookup functions), both loaded from `https://riftatlas.com/decks/new`.
- **Piltover Archive**: `https://piltoverarchive.com/_next/static/chunks/1i_c6m041ah0d.js` (Import Deck dialog) and `…/2lkhifh8dpdac.js` (text and TTS parsers), both loaded from `https://piltoverarchive.com/deckbuilder`. This covers **deck** import only. Collection import is behind sign-in (see `docs/export-name-formats.md` on branch `research/export-name-formats`). Text lines are matched to cards by a server call (`names: [...]`) that cannot be read from the client.
- The official Riftbound Locator (Carde.io) help pages turned up by search ([13773699](https://support.carde.io/en/articles/13773699-submit-a-riftbound-deck-for-an-event), [13766765](https://support.carde.io/en/articles/13766765-create-a-riftbound-deck-and-add-cards)) returned **HTTP 404**, so its "Paste Full Text" format is not covered.

Chunk filenames are content hashes and will change when a site redeploys. The quoted strings and regexes make the code easy to find again.

## Short answer

| | riftbound.gg (DotGG) | Rift Atlas | Piltover Archive (deck) |
|---|---|---|---|
| Line | `N Name (ID)` or `N Name` or `N_SET_NUM` | `N Name` or `N Name [ID]` | `N Name` (or TTS codes, separate tab) |
| `1x` | **No**, the line is skipped silently | **No**, "Could not parse" | **Yes** (`1x`, `1 x`, `1`) |
| Legend / champion name | DotGG name `Kai'Sa - Rebel`. `Kai'Sa, Rebel` is also accepted (`, ` → ` - `) | Any punctuation: `Kai'Sa, Rebel` = `Kai'Sa - Rebel` = `kaisa rebel` | `Kai'Sa, Rebel` (catalog name, exact) |
| Title only (`Agony's Embrace`) | Not matched | Not matched (suggestions only) | Not matched |
| Print selection | `(ID)` with DotGG id: `OGN-039a`, `OGN-299-STAR`, `RAD-SP4` | `[ID]` with Rift Atlas id: `OGN-039A`, `OGN-299S`, `RAD-SP4`, **case-sensitive** | Not possible in text. TTS tab: base/`a`/`b` only |
| Foil | Not expressible in text (text import counts everything as normal). CSV has a `Foil` column. | Not expressible | Not expressible |
| Section headers | Ignored, except `Sideboard:` and `Maybe:`/`Considering:`. The section comes from card type | **Required.** Lines before a known header are dropped | Optional, keyword-matched (`Legend:`, `## Runes`, …) |
| Collection import | Yes (CSV or text, login) | No (deck only) | CSV only, sign-in, not verified |

**Shared format.** One list works on all three: **`N Champion, Title`** (an integer, a space, the full catalog name with a comma) under the headers `Legend:`, `Champion:`, `MainDeck:`, `Battlefields:`, `Runes:`, `Sideboard:`. No code, no `x`. It cannot choose a print or mark foil. Each site picks its own default print for a name. Print-exact lists are site-specific: `(ID)` for riftbound.gg and `[ID]` for Rift Atlas, and the two sites spell the IDs differently.

## riftbound.gg (DotGG)

### Line format (`common.js`, parser table `B.riftbound`)

Each trimmed line is tried against these patterns in order:

1. `/^side\s*board\s*:?\s*$/i` switches to the sideboard. `/^(considering|maybe\s*board|maybe)\s*:?\s*$/i` switches to the maybeboard.
2. `/^[A-Za-z][A-Za-z ]*:\s*$/` matches any other header (`Legend:`, `Main Deck:`, `Runes:`), which is **skipped**. In the builder the section comes from card type (`boardForCard`, `cardTypesFixedOrder: ["Legend","Chosen Champion","Champion","Rune","Battlefield"]`).
3. `/^(\d+)\s+(.+?)\s+\(([A-Z0-9/]+(?:\s*-\s*[A-Z0-9/]+)+[a-z]?)\)\s*$/i` matches `3 Name (ID)`. **Only the ID is used.** It is upper-cased and the name text is ignored.
4. A TTS-style line: replace the first `x` with `|` and `_` with `|`, then split. Exactly 3 parts with a numeric first part makes `SET-NUM`, so `3_SFD_086` or `3xSFD_086`.
5. `/^(\d+)\s+(.+)$/` matches `N Name`, which is matched by name.

`1x Name` fits none of these and is **dropped without an error**. The placeholder shown in the UI is:

```
1 Ornn - Fire Below the Mountain (SFD-244)
3 World Atlas (SFD-086)
2 Tianna Crownguard (SFD-060)
or
3_SFD_086
2_OGN_045
```

The builder's own text export is `${count} ${name} (${id})`, with Legend and Champion lines first (`main.js`, `textExport`). The importer also accepts a Riftbound deck code (`getDeckFromCode`, the `@piltoverarchive/riftbound-deck-codes` encoding) and JSON `{deck:{…}}`.

### Matching (`k(e,t,n)`, `case "riftbound"`)

The lookup tries, in order:

1. ID, case-insensitive (`e.id?.toUpperCase() === n`).
2. Exact name, lower-cased.
3. The name with `", "` replaced by `" - "`. This is how `Kai'Sa, Rebel` finds `Kai'Sa - Rebel`.
4. `displayName`.

Name lookups use `Array.find`, so a name resolves to the **first catalog entry** with that name. For example, `Kai'Sa - Daughter of the Void` is shared by `OGN-247`, `OGN-299`, `OGN-299-STAR` and promos.

### DotGG catalog naming and IDs (`getcards?game=riftbound`)

- All 265 Legend entries and all 448 Champion entries use `Champion - Title`: `RAD-153` `Evelynn - Agony's Embrace`, `OGN-247` `Kai'Sa - Daughter of the Void`, `RAD-SP4` `Kai'Sa - Rebel`, `OGN-039a` `Kai'Sa - Survivor`.
- ID suffix shapes, with digits shown as `9`:
  - Base: `999` (1,210).
  - Alt art: `999a` (39, OGN only, lowercase) and `999A` (90, the other sets, uppercase). Also `999b`.
  - Signed: `999-STAR` (60), e.g. `OGN-299-STAR`.
  - Special prints: `SP9` (11).
  - Runes: `R99`, `R99a`, `R99b`.
  - Promos: `-P` (173), `-P2`, `-MB-P` / `-MP-P` (metal Best Of / Prize Wall), `-K-P`, `999a-P`, `-P-Champion`.
  - Oversized: `OGN-279/298`. Tokens: `T99…`.
  - Promo names carry a suffix, e.g. `OGN-247-P` `Kai'Sa - Daughter of the Void (Origins Release Event Promo)`.
- Each entry has `hasNormal` / `hasFoil` flags. Legends are foil-only (`hasNormal: "0"`).

### Collection import (CSV or "Deck format" text)

The collection import dialog says CSV or plain text. It offers a **Deck format — "3 Card Name (CARD-ID)"** checkbox that uses the parser above. Otherwise it treats the input as CSV:

> `Paste CSV data here:\nCardId,Normal,Foil,Name,Set\nCARD-001,1,0,Card Name,Set Name`

The drop-zone help in `main.js` lists three accepted formats: DotGG `CardId, Normal, Foil, Name, Set` (example `OGN-001, 1, 0, "Blazing Scorcher", "Origins"`), Collectr, and legacy `Normal Count, Foil Count, Card ID`.

- **Text (deck format) rows go in as `foil: 0`**, so a foil card cannot be imported from text.
- CSV headers are auto-detected (lower-cased):
  - id: `cardid`, `card id`, `id`, `card`
  - normal: `normal`, `standard`, `count`, `qty`, `quantity`, `amount`, `owned`, `regular`, `normal count`
  - foil (every match is summed): `foil`, `foils`, `foil count`, …
  - name: `name`, `cardname`, `card name`
  - set: `set code`, `setcode`, `set id`, `setid`, `edition code`, `set`
  - number: `number`, `card number`, `collector number`, …
- CSV rows are matched by (set, number), then ID, then **exact** name. Unlike the deck path, the CSV path does **not** convert `", "` to `" - "`.

**Why the app's current CSVs fail on riftbound.gg** (inference from the code above):

- **CardNexus CSV.** `Quantity` maps to normal, `Card Name` to name and `Collector Number` to number. `Expansion` is not a recognised set header, so (set, number) never matches and the row falls back to the name. `Agony's Embrace` and `Kai'Sa` do not match. `Finish` is ignored, so every row would count as normal.
- **Piltover CSV.** `Variant Number` is not a recognised ID header, so the row again falls back to the name. The `Foil` column holds `true`/`false`, which `parseInt` reads as 0. A foil row therefore adds its `Quantity` as normal and 0 foil.

On top of the name mismatch, foils are imported as normal cards.

## Rift Atlas

### Line format (`parseDecklist`)

- A **header** is a line ending in `:` or wrapped in `~~…~~`. The name is lower-cased, spaces are removed, and it is looked up in:
  - `legend`, `additionallegend(s)` → Legend
  - `champion(s)` → Champion
  - `maindeck`, `mainboard`, `main` → Main Deck
  - `battlefield(s)` → Battlefields
  - `rune(s)`, `runepool` → Runes
  - `sideboard`, `side` → Sideboard

  An unknown header gives `Unknown section header "…". Did you mean …?` and its section is ignored.
- A **card line** must match `/^(\d+)\s+/`, followed by a name, optionally ending in `[CODE]` with `CODE` matching `/\[([A-Za-z0-9-]+)\]$/`. Anything else gives `Could not parse "…". Expected format like "3 Card Name" or "3 Card Name [ABC-123]".` So **`1x` is rejected**, and `*` cannot appear in a code.
- **A card line before any known header is ignored** (`appeared before a known section header and was ignored`). Headers are therefore mandatory.
- Limit: 20,000 characters. In standard mode, the Main Deck holds at most 80 cards. There is no collection import.

Rift Atlas's own export (`buildDecklistText`) writes `Legend:`, `Champion:`, `MainDeck:`, `Battlefields:`, `Runes:`, `Sideboard:` (and `Additional Legends:` for Neeko decks) in that order, separated by blank lines. Lines read `N Name`. ` [CODE]` is added only when codes are requested or the name alone does not resolve.

### Matching

- **Code** (`A`): exact, case-sensitive lookup in the ID map (base IDs are also mapped through `baseCardId`). Then a fallback strips a trailing `S` (`/^([A-Z]{2,4}-[A-Z]*\d+[AB]?)S$/i`). If a code is given and the name does not match that card's name, the line gets `"…" does not match card code`.
- **Name** (`v` → `p`): lower-case the name, strip `'` and `’`, and collapse non-alphanumerics to one space. `Kai'Sa, Rebel`, `Kai'Sa - Rebel` and `kaisa rebel` are therefore all the same key. For a name, the preferred print is chosen: non-alt-art first, then the earliest set (OGN, SFD, OGS, ARC, VEN, UNL, RAD), then base over overnumbered (>221).
- An unknown name gets up to three "Did you mean" suggestions and is **not** imported.

### Catalog naming and IDs (embedded catalog)

- Names use `Champion, Title`: `RAD-153` `Evelynn, Agony's Embrace`, `RAD-SP4` `Kai'Sa, Rebel`, `OGN-299` `Kai'Sa, Daughter of the Void`.
- ID shapes:
  - Base `999`.
  - Alt art **uppercase** `999A` (OGN-039A included), `999B`.
  - Signed `999S` (`OGN-299S`, flagged `isAltArt`, `baseCardId: "OGN-299"`).
  - `SP9`, `999P` (promo), runes `R99`, tokens `T99`.

## Piltover Archive (deck builder)

The Import Deck dialog ("Import a deck from a code or text list") has three tabs.

- **Code**: a deck code (`CIAAA…`).
- **Text** (`r` in `2lkhifh8dpdac.js`):
  - `# Name` sets the deck name.
  - Headers are `## X` or `X:`, where X is letters and spaces. They are mapped by keyword: `additional` → Additional Legends, `legend`, `champion`/`chosen`, `battlefield`, `rune`, `sideboard`/`side`, `main`/`deck`.
  - A card line matches `/^(\d+)\s*x?\s+(.+)$/i`, so `3 Name`, `3x Name` and `3 x Name` all work.
  - A bare line becomes count 1. Lines starting with `#` or `//`, or ending in `:`, are skipped.
  - The default section is Main Deck.
  - Placeholder:

    ```
    Legend:
    1 Yasuo

    Additional Legends:
    1 Jinx

    Champion:
    1 Ahri

    MainDeck:
    3 Ionian Hookmaster
    2 Spirit Blade

    Battlefields:
    1 Ionia

    Runes:
    3 Rune of Haste
    ```

    The placeholder's bare champion names do not appear to match catalog names.
  - Names are sent to the server. The results are keyed by `card.name.toLowerCase()`, so the name must be the catalog name (`Kai'Sa, Rebel`, `Evelynn, Agony's Embrace`). Whether the server accepts short forms such as `Yasuo` is not visible.
  - The variant returned for a name is the server's choice. **Text cannot select a print.**
- **TTS** (`u`): space-separated `SET-NUM-K` tokens, `/^([A-Z]+)-(\d+)(?:-([123]))?$/`, where K is `1` = base, `2` = `a`, `3` = `b`. In a list of more than 40 tokens, the last 8 are the sideboard. This form **cannot express** `SP`, signed `*`, runes `R`, or promo suffixes.
- Piltover's own variant numbers are `OGN-039a` (lowercase), `OGN-299*`, `RAD-SP4` (see `docs/export-name-formats.md` on branch `research/export-name-formats`).
- The text export generator was not found in the deck-builder or deck-view chunks, so Piltover's exported text format is **not verified**.

## Print ID spellings compared

| App `code` (Riot gallery) | Piltover variant | riftbound.gg (DotGG) id | Rift Atlas id |
|---|---|---|---|
| `OGN-039/298` | `OGN-039` | `OGN-039` | `OGN-039` |
| `OGN-039a/298` | `OGN-039a` | `OGN-039a` (case-insensitive) | `OGN-039A` (must be upper) |
| `OGN-299*/298` | `OGN-299*` | `OGN-299-STAR` | `OGN-299S` |
| `RAD-SP4/005` | `RAD-SP4` | `RAD-SP4` | `RAD-SP4` |
| promo (`card.promo`) | `OGN-151b-Nexus` etc. | `OGN-247-P`, `-P2`, `-MB-P`, `-MP-P`, … | `…P` |

Base, alt-art and `SP` IDs convert mechanically to riftbound.gg (strip `/total`). Signed `*` → `-STAR`. Rift Atlas needs the code upper-cased and `*` → `S`. Promos cannot be converted reliably from the data the app holds.

## What the app has per card (`src/lib/csvExporter.js`, `src/lib/cardData.js`)

Each scanned card carries:

- `cardData.name`: the Riot gallery name. This is the title only for legends (`Agony's Embrace`) and drops the subtitle on champions (`Kai'Sa`).
- `cardData.code`: the gallery `publicCode`, e.g. `RAD-SP4/005` or `OGN-299*/298`.
- `cardData.collectorNumber`, derived from the code (e.g. `SP4`).
- `cardData.set` (prefix such as `OGN`) and `cardData.setName`.
- `cardData.rarity`.
- Per-scan `quantity`, `foil` (boolean), `promo` (boolean), `condition` and `language`.

Nothing in it holds the champion name or the full `Champion, Title` name, which every site's name matching needs. The code is enough to build riftbound.gg and Rift Atlas IDs for non-promo prints.

## Implications (inference, not verified by a live import)

- A **riftbound.gg collection** export should be the DotGG CSV `CardId,Normal,Foil,Name,Set` with DotGG IDs (`OGN-299-STAR`, `OGN-039a`, `RAD-SP4`). The ID is checked before the name, and this is the only format here that carries foil counts. A text list cannot carry foil.
- For **decks**, `N Champion, Title` under Rift Atlas-style headers works on all three sites. It needs the full name, which the app does not hold today (see issue #9 / `docs/export-name-formats.md`).
- `1x` should not be used. riftbound.gg skips such lines silently and Rift Atlas rejects them.

## Open questions

1. What does riftbound.gg's server-side import do when "Preview before importing" is off? That path posts the raw text with `textManualImport=1`, and its server parser is not visible. Is the result the same as the client parse?
2. What does Piltover Archive's server name lookup accept (short names, ` - ` separators)? Which variant does it return for a name with several prints? Finding out needs a test import, though the deck builder works without signing in.
3. How do the app's `promo` cards map to DotGG `-P` / `-P2` / `-MB-P` / `-MP-P` IDs and to Rift Atlas `…P` IDs? The gallery `publicCode` for promos was not checked.
4. Which text format does the official Riftbound Locator (Carde.io) "Paste Full Text" accept? Its help pages returned 404.
