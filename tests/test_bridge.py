import os
import unittest
from unittest.mock import patch
import bot

class BridgeTests(unittest.TestCase):
    def test_service_identifies_itself_to_cloudflare(self):
        import io
        with patch.object(bot,'urlopen',return_value=io.BytesIO(b'{"ok":true}')) as opened:
            self.assertEqual(bot.request_json('https://receiver.example',{'Authorization':'Bearer fake'}),{'ok':True})
        request=opened.call_args.args[0]
        self.assertEqual(request.get_header('User-agent'),'LibyanCollectorBot/1.0')
        self.assertEqual(request.get_header('Authorization'),'Bearer fake')
    def setUp(self):
        self.bridge=patch.object(bot,'BRIDGE','https://receiver.example')
        self.bridge.start()
    def tearDown(self):
        self.bridge.stop()
    @patch.object(bot,'bridge_request')
    def test_remote_state_uses_revision_and_never_local_file(self,request):
        state={'version':1,'seeded':False,'seen':{},'pending':{}}
        request.side_effect=[{'state':state,'revision':7},{'revision':8}]
        with patch.object(bot.STATE.__class__,'write_text',side_effect=AssertionError('local write')):
            self.assertEqual(bot.load_state(),state)
            bot.save_state(state)
        self.assertEqual(request.call_args.args,('/collector/state',{'state':state,'revision':7}))
        self.assertEqual(bot.REVISION,8)
    @patch.object(bot,'bridge_request',side_effect=bot.BotError('conflict'))
    def test_conflict_stops_scan_before_send(self,request):
        state={'version':1,'seeded':True,'seen':{},'pending':{}}
        with patch.object(bot,'search',return_value=[]),patch.object(bot,'send') as send:
            with self.assertRaises(bot.BotError):
                bot.scan(state,{'marketplaces':['EBAY_US'],'queries':['Libya']})
            send.assert_not_called()
    @patch.dict(os.environ,{'ACTIONS_ID_TOKEN_REQUEST_URL':'https://github.example?x=1','ACTIONS_ID_TOKEN_REQUEST_TOKEN':'identity-secret'})
    @patch.object(bot,'request_json')
    def test_identity_and_proxy_are_separate_requests(self,request):
        request.side_effect=[{'value':'jwt'}, {'state':{},'revision':0}]
        bot.bridge_request('/collector/state')
        self.assertIn('audience=https%3A%2F%2Freceiver.example%2F',request.call_args_list[0].args[0])
        self.assertEqual(request.call_args_list[1].args[1]['Authorization'],'Bearer jwt')
    @patch.object(bot,'bridge_request',return_value={'itemSummaries':[{'itemId':'1'}],'next':False})
    def test_search_needs_no_ebay_secret(self,request):
        with patch.dict(os.environ,{},clear=True):
            self.assertEqual(bot.ebay_token(),'bridge-managed')
            self.assertEqual(list(bot.search('unused','EBAY_IT','Libya',{'max_pages':2,'page_size':100})),[{'itemId':'1'}])
