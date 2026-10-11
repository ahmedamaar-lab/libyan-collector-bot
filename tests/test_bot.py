import copy
import json
from pathlib import Path
import tempfile
import unittest
from unittest.mock import patch
import bot
CONFIG = json.loads((bot.ROOT / 'config.json').read_text())

def listing(title='Libya vintage pocket watch', item_id='v1|123|0'):
    return {'title': title, 'itemId': item_id, 'itemWebUrl': 'https://www.ebay.it/itm/123',
            'price': {'value': '80', 'currency': 'EUR'}}

class BehaviorTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.state_patch = patch.object(bot, 'STATE', Path(self.temp.name) / 'state.json')
        self.state_patch.start()
        self.config = copy.deepcopy(CONFIG)
        self.config['marketplaces'] = ['EBAY_US', 'EBAY_IT']
        self.config['queries'] = ['Libya']
    def tearDown(self):
        self.state_patch.stop()
        self.temp.cleanup()
    def test_multilingual(self):
        for title in ['Libia orologio', 'Libye carte ancienne', 'Libyen Schallplatte', 'ليبيا كتاب']:
            self.assertEqual(bot.classify(listing(title), CONFIG)['score'], 4)
    def test_exclusions(self):
        for title in ['Libya stamps vintage', 'Libia francobolli', 'Libyen Briefmarken',
                      'Libyan desert glass antique', 'Tripoli Lebanon vintage map']:
            self.assertIsNone(bot.classify(listing(title), CONFIG))
    def test_clothing_without_provenance(self):
        self.assertEqual(bot.classify(listing('Antique embroidered burnous'), CONFIG)['score'], 2)
    def test_geography_alone(self):
        self.assertIsNone(bot.classify(listing('Tripoli new mug'), CONFIG))
    def test_book_watchlist(self):
        config = copy.deepcopy(CONFIG)
        config['book_watchlist'] = ['Test Book Title']
        self.assertEqual(bot.classify(listing('Rare Test Book Title'), config)['score'], 5)
    def test_variation_duplicates(self):
        self.assertEqual(bot.identity(listing(item_id='v1|123|0')),
                         bot.identity(listing(item_id='v1|123|456')))
    @patch.object(bot, 'send')
    @patch.object(bot, 'ebay_token', return_value='fake')
    def test_baseline_then_alert_once(self, token, send):
        state = bot.load_state()
        with patch.object(bot, 'search', return_value=[listing()]):
            bot.scan(state, self.config)
        self.assertEqual(send.call_count, 1)
        send.reset_mock()
        with patch.object(bot, 'search', return_value=[listing(), listing(item_id='v1|999|0')]):
            bot.scan(state, self.config)
            bot.scan(state, self.config)
        self.assertEqual(send.call_count, 1)
        self.assertTrue(bot.load_state()['pending']['999']['instant_sent'])
    @patch.object(bot, 'ebay_token', return_value='fake')
    def test_send_failure_remains_pending(self, token):
        state = bot.load_state()
        state['seeded'] = True
        with patch.object(bot, 'search', return_value=[listing()]), patch.object(bot, 'send', side_effect=bot.BotError('failed')):
            with self.assertRaises(bot.BotError):
                bot.scan(state, self.config)
        self.assertFalse(bot.load_state()['pending']['123']['instant_sent'])
    @patch.object(bot, 'ebay_token', return_value='fake')
    def test_fetch_failure_leaves_baseline(self, token):
        state = bot.load_state()
        with patch.object(bot, 'search', side_effect=bot.BotError('failed')):
            with self.assertRaises(bot.BotError):
                bot.scan(state, self.config)
        self.assertFalse(state['seeded'])
        self.assertFalse(state['seen'])
    def test_partial_digest_progress(self):
        state = bot.load_state()
        state['seeded'] = True
        entry = bot.record(listing(), 'EBAY_IT', {'score': 2, 'reason': 'lead'})
        state['pending'] = {key: {**entry, 'instant_sent': False} for key in ['1', '2']}
        with patch.object(bot, 'send', side_effect=[None, bot.BotError('failed')]):
            with self.assertRaises(bot.BotError):
                bot.digest(state, CONFIG, force=True)
        self.assertEqual(list(bot.load_state()['pending']), ['2'])
        self.assertNotIn('last_digest', bot.load_state())
    def test_corrupt_state_fails_closed(self):
        bot.STATE.write_text('{broken')
        with self.assertRaises(bot.BotError):
            bot.load_state()
    def test_errors_do_not_leak_tokens(self):
        from urllib.error import HTTPError
        with patch.object(bot, 'urlopen', side_effect=HTTPError('https://api.telegram.org/botSECRET', 403, 'secret', {}, None)):
            with self.assertRaises(bot.BotError) as caught:
                bot.request_json('https://api.telegram.org/botSECRET', service='Telegram')
        self.assertNotIn('SECRET', str(caught.exception))

if __name__ == '__main__':
    unittest.main()
