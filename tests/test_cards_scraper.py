import copy
import json
import pathlib
import sys
import tempfile
import unittest
from collections.abc import Callable
from unittest.mock import patch
from io import BytesIO

sys.path.insert(0, str(pathlib.Path(__file__).resolve().parents[1] / 'model'))
import cards_scraper as scraper
from PIL import Image

FIXTURES = pathlib.Path(__file__).resolve().parent / 'fixtures'
GALLERY_SAMPLE = json.loads((FIXTURES / 'card-gallery-next-data.json').read_text(encoding='utf-8'))
GALLERY_EXPECTED = json.loads((FIXTURES / 'card-gallery-expected.json').read_text(encoding='utf-8'))


def gallery_sample() -> dict:
    return copy.deepcopy(GALLERY_SAMPLE)


def no_fetch(url: str) -> dict:
    raise AssertionError(f'unexpected list API request: {url}')


def parsed_summary(next_data: dict, fetch_page: Callable[[str], dict] = no_fetch) -> list[dict]:
    cards = [scraper.normalize_card(raw) for raw in scraper.extract_cards(next_data, fetch_page)]
    return [{'id': c['id'], 'code': c['public_code'], 'subtitle': c['subtitle']} for c in cards]


class GalleryParserTests(unittest.TestCase):
    def test_sample_gallery_parses_to_the_expected_ids_codes_and_subtitles(self):
        self.assertEqual(parsed_summary(gallery_sample()), GALLERY_EXPECTED)

    def test_old_page_props_blades_shape_still_parses_through_the_fallback(self):
        sample = gallery_sample()
        page = sample['props']['pageProps'].pop('page')
        gallery = page['blades'][2]
        gallery['type'] = 'renamedGalleryBlade'
        extra = copy.deepcopy(gallery['cards']['items'][2])
        extra.update(id='rad-sp4-005-copy', publicCode='RAD-SP4/005b')
        gallery['cards']['items'].append(extra)
        sample['props']['pageProps']['blades'] = page['blades']
        expected = GALLERY_EXPECTED + [{'id': 'rad-sp4-005-copy', 'code': 'RAD-SP4/005b', 'subtitle': 'Rebel'}]
        self.assertEqual(parsed_summary(sample), expected)

    def test_paging_is_followed_when_the_page_was_not_fully_prefetched(self):
        sample = gallery_sample()
        cards = sample['props']['pageProps']['page']['blades'][2]['cards']
        items = cards['items']
        cards['items'] = items[:2]
        cards['async']['metadata']['prefetchAll'] = False
        cards['async']['metadata']['totalItems'] = 9999
        cards['async']['linkdata']['next'] = '/list?from=2'
        pages = {
            '/list?from=2': {'items': items[2:4], 'linkdata': {'next': '/list?from=4'}},
            '/list?from=4': {'items': items[3:], 'linkdata': {'next': None}},
        }
        requested = []

        def fetch_page(url):
            requested.append(url)
            return copy.deepcopy(pages[url])

        self.assertEqual(parsed_summary(sample, fetch_page), GALLERY_EXPECTED)
        self.assertEqual(requested, ['/list?from=2', '/list?from=4'])

    def test_a_fully_prefetched_page_never_calls_the_list_api(self):
        sample = gallery_sample()
        sample['props']['pageProps']['page']['blades'][2]['cards']['async']['metadata']['totalItems'] = 9999
        self.assertEqual(parsed_summary(sample), GALLERY_EXPECTED)


class CardRecordSubtitleTests(unittest.TestCase):
    def build_hashes(self, directory: str, prepare_db: Callable[[str], None] | None = None) -> dict[str, dict]:
        root = pathlib.Path(directory)
        db_path = str(root / 'riftbound.db')
        hashes_path = root / 'card-hashes.json'
        if prepare_db:
            prepare_db(db_path)
        cards = [scraper.normalize_card(raw) for raw in scraper.extract_cards(gallery_sample(), no_fetch)]
        for card in cards:
            card['image_path'] = f"{card['id']}.webp"
            Image.new('RGB', (80, 110), 'green').save(root / card['image_path'], format='WEBP')
        conn = scraper.init_db(db_path)
        scraper.insert_cards(conn, cards)
        conn.close()
        with patch.object(scraper, 'DB_PATH', db_path), patch.object(scraper, 'BASE_DIR', directory), \
                patch.object(scraper, 'HASHES_PATH', str(hashes_path)):
            scraper.generate_card_hashes()
        records = json.loads(hashes_path.read_text(encoding='utf-8'))['cards']
        return {record['id']: record for record in records}

    def test_subtitle_reaches_the_card_records(self):
        with tempfile.TemporaryDirectory() as directory:
            records = self.build_hashes(directory)
        self.assertEqual(records['rad-sp4-005']['subtitle'], 'Rebel')
        self.assertEqual(records['ogn-247-298']['subtitle'], '')

    def test_an_existing_database_without_subtitles_gains_them(self):
        def old_database(db_path):
            conn = scraper.sqlite3.connect(db_path)
            conn.execute('CREATE TABLE cards (id TEXT PRIMARY KEY, name TEXT NOT NULL, collector_number INTEGER, '
                         'public_code TEXT, set_id TEXT, set_name TEXT, domains TEXT, rarity TEXT, card_type TEXT, '
                         'energy INTEGER, might INTEGER, tags TEXT, illustrator TEXT, text TEXT, orientation TEXT, '
                         'image_url TEXT, image_path TEXT)')
            conn.commit()
            conn.close()

        with tempfile.TemporaryDirectory() as directory:
            records = self.build_hashes(directory, old_database)
        self.assertEqual(records['rad-sp4-005']['subtitle'], 'Rebel')


class CardImageUpdateTests(unittest.TestCase):
    def test_existing_images_survive_a_partial_update_and_failed_cards_retry(self):
        with tempfile.TemporaryDirectory() as directory, patch.object(scraper, 'CARDS_DIR', directory):
            old = pathlib.Path(directory) / 'rad-001.webp'
            Image.new('RGB', (80, 110), 'red').save(old, format='WEBP')
            original = old.read_bytes()
            cards = [{'id': 'rad-001', 'image_url': 'old'}, {'id': 'rad-219', 'image_url': 'new'}]
            with patch.object(scraper, '_download_single_image', return_value=('rad-219', False)) as download:
                self.assertEqual(scraper.download_images(cards), ['rad-219'])
                download.assert_called_once_with(cards[1])
            self.assertEqual(old.read_bytes(), original)
            with patch.object(scraper, '_download_single_image', return_value=('rad-219', True)) as download:
                self.assertEqual(scraper.download_images(cards), [])
                download.assert_called_once_with(cards[1])

    def test_interrupted_replacement_preserves_the_previous_image(self):
        with tempfile.TemporaryDirectory() as directory, patch.object(scraper, 'CARDS_DIR', directory):
            old = pathlib.Path(directory) / 'rad-001.webp'
            old.write_bytes(b'previous image')
            with patch.object(scraper.SESSION, 'get', side_effect=OSError('offline')), patch.object(scraper.time, 'sleep'):
                self.assertEqual(scraper._download_single_image({'id': 'rad-001', 'image_url': 'new'}), ('rad-001', False))
            self.assertEqual(old.read_bytes(), b'previous image')
            self.assertFalse(pathlib.Path(str(old) + '.tmp').exists())

    def test_successful_landscape_download_is_stored_as_portrait(self):
        buffer = BytesIO()
        Image.new('RGB', (110, 80), 'blue').save(buffer, format='PNG')
        response = unittest.mock.Mock(content=buffer.getvalue())
        with tempfile.TemporaryDirectory() as directory, patch.object(scraper, 'CARDS_DIR', directory), patch.object(scraper.SESSION, 'get', return_value=response):
            self.assertEqual(scraper._download_single_image({'id': 'rad-001', 'image_url': 'new'}), ('rad-001', True))
            with Image.open(pathlib.Path(directory) / 'rad-001.webp') as image:
                self.assertLess(image.width, image.height)


if __name__ == '__main__':
    unittest.main()
