# Research: why legends show only their title

Question (issue #3): Legend cards display only the title printed on the card (e.g. "Daughter of the Void") and not the champion (e.g. "Kai'Sa"). Where does the name come from, and what data is available to build "champion plus title"?

Sources: the live official card gallery `https://playriftbound.com/en-us/card-gallery/` (fetched 2026-11-07, `__NEXT_DATA__` JSON, 1408 card entries), and this repository at commit `ceced3b`.

## Answer

The gallery's `name` field for a legend **is** the title. The champion name appears only in the card's `tags` array. The scraper copies `name` unchanged into the `name` column and into `card-hashes.json`, and every UI view and CSV export renders `cardData.name`. The champion is kept in `tags`, but nothing combines it with the name.

For every legend currently in the gallery (145 entries, 58 distinct titles), exactly one tag matches the name of a champion unit card. That tag is the champion, so "Champion, Title" can be built reliably. Do not use `tags[0]`, because 6 legends put other tags before the champion.

## What the gallery returns

The scraper reads `__NEXT_DATA__` (`model/cards_scraper.py:56-69`). The card list now lives at `props.pageProps.page.blades[2].cards.items`. The scraper's direct lookup reads `props.pageProps.blades` (`model/cards_scraper.py:82`), which is gone, so the list is found by the recursive fallback (`model/cards_scraper.py:91`, `:109-136`). This still works, but it is fragile.

A real legend entry (abridged; `id: "rad-175-167"`):

```json
{
  "name": "Agony's Embrace",
  "publicCode": "RAD-175/167",
  "cardType": { "type": [{ "id": "legend", "label": "Legend" }] },
  "tags": { "label": "Tags", "tags": ["Evelynn"] },
  "cardImage": { "accessibilityText": "Riftbound Legend: Agony's Embrace. Once each turn, ..." }
}
```

Fields checked on all 145 legend entries:

| Field | Content for legends |
|---|---|
| `name` | The printed title only ("Daughter of the Void", "Blind Monk", …). |
| `tags.tags` | Always present. Contains the champion, alone in 139 entries and together with other tags in 6. |
| `subtitle` | Present on only 4 legends (`OGS-017/019/021/023`), and its value is `"Starter"`, not a title. Do not use it for legends. |
| `cardType.superType` | `champion` appears only on those same 4 OGS starter legends. Nothing else on a legend marks the champion. |
| `cardImage.accessibilityText` | `"Riftbound Legend: <title>. <rules text>"`. The champion name is missing in 141 of 145 entries. |
| `text` | Rules text only. |

The gallery has no dedicated `champion` field. Champion **unit** cards use the opposite layout: `name` holds the champion and `subtitle` holds the title. For example, `OGN-039a/298` has `name: "Kai'Sa"`, `subtitle: "Survivor"`, `tags: ["Kai'Sa", "The Void"]`, and `cardType.superType: [champion]`.

### Legends with more than one tag (all 145 were checked)

| Code | Title | `tags` |
|---|---|---|
| RAD-141/167, RAD-169/167 | Hexplosives Expert | `["Yordle", "Ziggs"]` |
| VEN-155/166, VEN-197/166, VEN-197*/166 | Heart of the Tempest | `["Yordle", "Kennen"]` |
| VEN-192*/166 | Curator of the Sands | `["Dog", "Shurima", "Nasus"]` (VEN-192/166 has only `["Nasus"]`) |

In all 6 of these the champion is the last tag. That is an observation, not a documented rule. The reliable way to find the champion is the tag that equals the `name` of a unit with `cardType.superType` = `champion`. I checked this on the live data: every legend has exactly one such tag, with no ambiguity and no misses.

### Sample of title → champion pairs

| Code | Gallery `name` (title) | Champion (from `tags`) |
|---|---|---|
| OGN-247/298 | Daughter of the Void | Kai'Sa |
| OGN-257/298 | Blind Monk | Lee Sin |
| OGS-019/024 | Wuju Bladesman | Master Yi |
| UNL-191/219 | Wuju Master | Master Yi |
| RAD-155/167 | Exemplar of Demacia | Jarvan IV |
| SFD-201/221 | Chem-Baroness | Renata Glasc |
| VEN-153/166 | Matriarch of War | Ambessa |

A champion can have more than one legend (Master Yi has two). Each title maps to one champion.

## How the repo turns this into a displayed or exported name

1. **Scrape.** `normalize_card` sets `"name": raw.get("name", "")` (`model/cards_scraper.py:273`). Tags are stored separately as JSON (`:262`, `:283`). The scraper never reads `subtitle` or `cardType.superType`; it keeps only `type[0].id` (`:249-250`).
2. **Hash DB.** `generate_card_hashes` writes `name` and `tags` to `public/card-hashes.json` unchanged (`model/cards_scraper.py:529-547`).
3. **Runtime.** `resolveCardData` passes through `name: card.name` and `tags: card.tags` (`src/lib/cardData.js:10`, `:21`). It is called for every recognition result (`src/lib/cardRecognition.js:65,75,99,111`).
4. **Display.** Every view renders `cardData.name`, including:
   - `src/components/scanner/ScannerCardRow.jsx:50`
   - `src/components/scanner/ScannerCamera.jsx:357`
   - `src/components/scan/ScanTab.jsx:293,962,1117`
   - `src/components/scan/ScanAddAnimation.jsx:55`
   - `src/components/identify/CardDetailPanel.jsx:281`
   - `src/components/scanner/ManualScanReview.jsx:16`
   - toasts in `src/App.jsx:872,984,1053`

   Tags are shown only as chips in `CardDetailPanel.jsx:364-366`.
5. **Export.** `csvExporter.js` writes `card.cardData.name` as "Card Name" in both formats: CardNexus (`src/lib/csvExporter.js:144`) and Piltover Archive (`:170`).
6. **Search and sort.** Collection and scan search, plus name sorting, use `cardData.name` (`src/components/collection/CollectionTab.jsx:35,60,79`, `src/components/scan/ScanTab.jsx:193-207,429,448`).

## Things a fix has to keep working

These are observations, not recommendations.

- **OCR needs the printed title.** `CardTextIndex` matches OCR output against `normalizeCardName(card.name)` (`src/lib/cardTextIdentity.js:25`). `cardVisualProof.js:25-28` and the name-region sizing in `cardTextReader.js:14-19` also read `card.name`. The printed legend shows the title, so changing `name` itself to "Kai'Sa, Daughter of the Void" would break text verification. A separate display or export field avoids this.
- **Saved collections keep old names.** Collection entries store a `cardData` snapshot (`src/lib/collection.js:10-13`), which is saved to IndexedDB (`src/lib/indexedDB.js:115`). Collections saved before a fix will keep the title-only name unless they are re-resolved.
- **Export targets may expect a specific name.** I did not check whether CardNexus or Piltover Archive expect the title, the champion, or both for legends. Their importers own that decision.
- **Champion units drop their subtitle too.** For example, "Kai'Sa" is shown without "Survivor". The fix that adds titles to legends could cover this case as well.
