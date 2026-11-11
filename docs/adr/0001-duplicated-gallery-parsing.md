# Gallery parsing and reference fingerprinting stay duplicated across languages

The official card gallery is parsed in two places (the Python scraper in `model/cards_scraper.py` for the bundled card database, and Rust in `src-tauri/src/main.rs` for the in-app update), and the artwork fingerprint behind a reference is computed in three (Python, Rust, and the JS matcher that fingerprints scans). We keep it that way and hold the copies in step with shared fixtures under `tests/fixtures/` that every implementation must parse or reproduce identically. Collapsing them into one Rust implementation would make the model tooling depend on the desktop build, and the gallery format has changed rarely enough that the fixtures are the cheaper guard.

## Considered Options

- **One Rust implementation, exposed as a build-time command, replacing the Python scraper.** Rejected in the November 2026 architecture review: it couples the Python training and data pipeline to the Tauri toolchain for a duplication that has cost one coordinated change so far. Worth reopening if the gallery format starts changing often.
