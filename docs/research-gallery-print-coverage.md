# Research: which prints the official card gallery lists

Resolves issue #2 (part of map #1). Researched 2026-11-07 against repo commit `ceced3b`.

## Answer

The official gallery lists alt-art, showcase, SP-coded, overnumbered, signature, token and rune prints, but **no promo prints**. Each print is its own entry with its own `id`, `publicCode` and image. Kai'Sa's rebel alt art is in the gallery as `RAD-SP4/005`, in set `RAD` (Radiance), with name `Kai'Sa`, subtitle `Rebel`, rarity `showcase` and id `rad-sp4-005`.

The scraper and the app keep every gallery print as a separate card. Nothing is deduped by name or by number: every key is the gallery `id`, which is unique across all 1408 entries. Some information is lost along the way (the subtitle, the letter prefix of the collector number in the hash DB, and the `*` on export), but no prints are dropped or merged. The only prints that need custom cards are **promos**, plus any print missing from the gallery entirely (see open questions).

## Sources

- Gallery page: <https://playriftbound.com/en-us/card-gallery/>, fetched 2026-11-07. Its `__NEXT_DATA__` holds the cards at `props.pageProps.page.blades[2].cards.items`: 1408 items, in a blade of `type: "riftboundCardGallery"`.
- The list API behind that blade (named in the blade's `cards.async.linkdata`): <https://content.publishing.riotgames.com/publishing-content/v2.0/public/channel/riftbound_website/list/riftbound_gallery_cards?locale=en_US&from=0&limit=200>, paged `from=0…1400`. All pages together return **the same 1408 ids** as the SSR payload. The response metadata says `totalItems: 1416` and `prefetchAll: true`.
- Set list (`blades[2].sets.items`): OGN Origins (max 298), OGS Proving Grounds (24), RAD Radiance (167), SFD Spiritforged (221), UNL Unleashed (219), VEN Vendetta (166). There is no promo set.
- Repo code: `model/cards_scraper.py`, `src/lib/cardData.js`, `src/lib/cardMatcher.js`, `src/lib/csvExporter.js`, `src/lib/collection.js`.
- To check the scraper's own behaviour, its `extract_next_data` → `extract_cards` → `normalize_card` were run on the fetched HTML, with the image libraries stubbed out. Result: 1408 raw cards became 1408 unique normalized ids, with 0 empty image URLs and 0 duplicate image URLs.

## Print kinds in the gallery (live data, 1408 entries)

| Kind | `publicCode` pattern | Count | Rarity in data | Sets | Example (id → code, name, subtitle) |
|---|---|---|---|---|---|
| Normal | `SET-NNN/TTT` (NNN ≤ TTT) | 1095 | common/uncommon/rare/epic (never showcase) | all 6 incl. OGS | `unl-131-219` → `UNL-131/219` Abandon |
| Alt art | `SET-NNNa/TTT` | 120 | showcase | OGN, UNL, SFD, VEN, RAD | `ogn-039a-298` → `OGN-039a/298` Kai'Sa, Survivor |
| SP-coded special | `SET-SPn/00k` | 11 | showcase | RAD (SP1–5/005), VEN (SP1–6/006) | `rad-sp4-005` → `RAD-SP4/005` Kai'Sa, Rebel |
| Overnumbered | `SET-NNN/TTT` (NNN > TTT) | 109 | showcase (108), epic (1: `UNL-238/219` Baron Nashor) | all main sets | `sfd-227-221` → `SFD-227/221` Ahri, Inquisitive |
| Signature (starred overnumbered) | `SET-NNN*/TTT` | 45 | showcase | OGN, UNL, SFD, VEN | `sfd-227-star-221` → `SFD-227*/221` Ahri |
| Token | `SET-Tnn` (no total) | 10 | common | UNL 8, SFD 1, VEN 1 | `unl-t01` → `UNL-T01` Baron Pit |
| Rune | `SET-Rnn` | 12 | common | RAD 6, VEN 6 | `rad-r04` → `RAD-R04` Body Rune |
| Rune alt art | `SET-Rnna` | 6 | showcase | RAD | `rad-r04a` → `RAD-R04a` Body Rune |
| Promo | — | 0 | — | — | No promo set, code or flag exists in the data |

Notes:

- **No separate "showcase" code family exists.** In the data, "showcase" is a rarity (290 entries), shared by the alt-art, SP, overnumbered, signature and rune alt-art prints. No normal-coded print has showcase rarity.
- **Every alt-art and signature print has its base print in the data too**: all 120 `…a/…` codes have a matching plain code, and all 45 `…*/…` codes have the same-number overnumbered code.
- **Card names do not carry the variant.** All seven Kai'Sa prints are named `Kai'Sa`; the epithet lives in a separate `subtitle` field (`Rebel`, `Survivor`, `Evolutionary`). 152 names have more than one print, e.g. Ahri ×9 and Kai'Sa ×7. Only the `id` and `publicCode` tell prints apart. Both are unique across the dataset.
- **The `collectorNumber` field is numeric only**: `RAD-SP4/005` → 4, `UNL-T01` → 1, `RAD-R04a` → 4, `SFD-227*/221` → 227. 186 `(set, collectorNumber)` pairs are shared by more than one print, e.g. `rad-sp4-005` and `rad-004-167`.
- **Proving Grounds (`OGS`) is a 24-card product** with normal codes `OGS-001/024…024/024`, separate from the Origins `OGN` prints.

## Pipeline: what drops, dedupes or merges

### `model/cards_scraper.py`

- **Locating the card list**: the fast path at `model/cards_scraper.py:82-88` reads `props.pageProps.blades`. That key **no longer exists**: the blades now sit under `props.pageProps.page.blades`. The scraper falls through to `_find_cards_recursive` (`:91`, `:109-136`), which finds the first list longer than 5 whose first item has `cardImage` (`:104-106`). Today that list is the full 1408-item list, at depth 7, within the depth limit of 10 (`:120`). So nothing is lost now, but the scraper relies on the fallback.
- **SSR only, no pagination**: the scraper reads only the server-rendered `__NEXT_DATA__` (`:43-69`) and never calls the paged list API. Today the SSR payload holds every item the API returns (1408). If the site stops prefetching all pages (`prefetchAll`), the scraper would silently get only the first page.
- **No filtering by kind**: `normalize_card` (`:228-289`) maps every raw card one-to-one. `id` is `raw["id"]` (`:270`), and `public_code` keeps the full code (`:275`). Fields that are dropped: `subtitle` (the epithet that tells e.g. Kai'Sa prints apart), `effect`, `power` and `mightBonus`. `collector_number` is the numeric `collectorNumber` (`:274`), so the `SP`/`T`/`R` prefix and the `a`/`*` markers survive **only in `public_code`**.
- **DB key**: `id TEXT PRIMARY KEY` (`:305`) with `INSERT OR REPLACE` (`:336-345`). Gallery ids are unique, so nothing gets overwritten.
- **Image download**: deduped by `id` only (`:396`). There are no shared image URLs.
- **Rows dropped on the way to the hash DB**:
  - `generate_card_hashes` skips a card whose image file is missing or unreadable (`:500-509`).
  - `main` leaves out of the DB update any card whose *changed* image failed to refresh (`:595-596`).
  - Both depend on download failures, not on the print kind.
- **Hash output**: `number` = `collector_number` (`:532`) and `code` = `public_code` (`:533`). Sorting is by `(set, zfill(number), id)` (`:550`), so prints with the same number stay separate entries.

### App

- `src/lib/cardMatcher.js:117-122` `supplementWithBundledCards`: adds bundled cards whose `id` is not in the local DB. It merges by `id` only, so it never collapses variants. Because it only adds, prints removed from the gallery would persist from the bundle.
- `src/lib/cardData.js:4-7` `resolveCardData`: rebuilds `collectorNumber` from `code`, so the SP/T/R prefix and the `a`/`*` markers come back (`RAD-SP4/005` → `SP4`, `SFD-227*/221` → `227*`).
- `src/lib/collection.js:35-43` `getCardVariantKey`: the collection is keyed by `cardData.id` plus finish, promo, condition and language, so separate prints never merge in the collection.
- `src/lib/csvExporter.js` (export only, the DB is not affected):
  - **CardNexus** removes `*` from the collector number (`:145`). A signature `SFD-227*/221` and the overnumbered `SFD-227/221` therefore export the same row key (name `Ahri`, `227`, `SFD`). This is a merge in effect on export.
  - **Piltover**: variant number = code before `/` (`:81-83`), which keeps `*`, `a` and `SP`. `isOvernumbered` (`:91-97`) removes non-digits from `collectorNumber`, so signatures are also labelled `Overnumbered` (`:108`, `:121`); signature and overnumbered are not told apart. SP and `a` prints get the `Showcase` type (`:109`) and the `Alt Art` label (`:129-133`).
  - **Promo** is a user toggle (`card.promo`) only. CardNexus hardcodes set `OGNX` for every promo (`:146`), and Piltover uses `"<Set> Promo"` (`:68-72`). No gallery data backs promos.

## Consequences for the catalog (map #1)

- Normal, alt-art (`a`), SP, overnumbered, signature (`*`), token and rune prints can all come from the gallery as-is.
- **Promos need custom cards**: the gallery has none.
- If the custom-card merge keys on name or `(set, number)`, it will collide. Key on gallery `id` or the full `publicCode`.

## Open questions surfaced

1. **The list API reports `totalItems: 1416` but returns 1408 items** across all pages, the same as the SSR payload. What are the 8 missing entries: hidden or unreleased prints, or a count artefact? Unknown from public data.
2. Should the scraper capture `subtitle`, so the UI and exports can tell apart same-name prints (e.g. "Kai'Sa, Rebel")?
3. Should the scraper's fast path be updated to `props.pageProps.page.blades`, or switch to the paged list API, so it does not depend on the recursive fallback and on `prefetchAll`?
4. Should the CardNexus export keep the signature `*` (or otherwise tell it apart), and should the promo set stop being hardcoded to `OGNX` for non-Origins cards?
