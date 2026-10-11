"""Libyan collectibles discovery. Python 3.12+, standard library only."""
import argparse
import base64
import json
import os
from pathlib import Path
import re
import sys
import time
from datetime import datetime, timezone
from urllib.error import HTTPError, URLError
from urllib.parse import urlencode, urlparse
from urllib.request import Request, urlopen
from zoneinfo import ZoneInfo

ROOT = Path(__file__).resolve().parent
STATE = ROOT / 'data/state.json'


class BotError(Exception):
    pass


def required(name):
    value = os.environ.get(name, '').strip()
    if not value:
        raise BotError(f'Missing GitHub Actions secret: {name}')
    return value


def request_json(url, headers=None, data=None, service='API', retry=True):
    # Never include URLs, request bodies, responses, or exception strings in logs:
    # Telegram URLs contain the bot token.
    for attempt in range(3 if retry else 1):
        try:
            req = Request(url, headers=headers or {}, data=data)
            with urlopen(req, timeout=30) as response:
                return json.load(response)
        except HTTPError as exc:
            code = exc.code
            if retry and (code == 429 or code >= 500) and attempt < 2:
                try:
                    delay = min(60, max(1, int(exc.headers.get('Retry-After', '5'))))
                except ValueError:
                    delay = 5
                time.sleep(delay)
                continue
            hint = ''
            if service == 'eBay' and code in (401, 403):
                hint = ' Check production keys and Browse API production access.'
            if service == 'Telegram':
                hint = ' Check the token, chat ID, and that you pressed Start.'
            raise BotError(f'{service} returned HTTP {code}.{hint}') from None
        except (URLError, TimeoutError, OSError, ValueError):
            if retry and attempt < 2:
                time.sleep(3)
                continue
            raise BotError(f'{service} network or JSON response failure.') from None


def telegram(method, payload, retry=True):
    token = required('TELEGRAM_BOT_TOKEN')
    result = request_json(f'https://api.telegram.org/bot{token}/{method}',
                          {'Content-Type': 'application/json'},
                          json.dumps(payload).encode(), 'Telegram', retry)
    if not result.get('ok'):
        raise BotError('Telegram rejected the request. Check bot configuration.')
    return result['result']


def send(text):
    # Do not automatically retry sends: a timeout can occur after delivery.
    telegram('sendMessage', {'chat_id': required('TELEGRAM_CHAT_ID'),
                            'text': text[:4000],
                            'link_preview_options': {'is_disabled': True}}, retry=False)
    time.sleep(0.1)


def load_state():
    if not STATE.exists():
        return {'version': 1, 'seeded': False, 'seen': {}, 'pending': {}}
    try:
        state = json.loads(STATE.read_text())
        if state['version'] != 1 or not isinstance(state['seen'], dict) or not isinstance(state['pending'], dict):
            raise ValueError()
        return state
    except (ValueError, KeyError):
        raise BotError('Invalid state.json; restore the previous state commit before scanning.') from None


def save_state(state):
    STATE.parent.mkdir(exist_ok=True)
    temp = STATE.with_suffix('.tmp')
    temp.write_text(json.dumps(state, ensure_ascii=False, indent=2) + '\n')
    temp.replace(STATE)


def match(text, terms):
    return any(re.search(r'(?<!\w)' + re.escape(t.casefold()) + r'(?!\w)', text.casefold()) for t in terms)


def classify(item, config):
    title = item.get('title', '')
    categories = ' '.join(c.get('categoryName', '') for c in item.get('categories', []))
    if match(title + ' ' + categories, config['exclude_terms']):
        return None
    geo = match(title, config['geography_terms'])
    groups = [name for name, terms in config['interest_terms'].items() if match(title, terms)]
    watched = match(title, config.get('book_watchlist', [])) if config.get('book_watchlist') else False
    clothing_lead = match(title, config['clothing_lead_terms'])
    if not watched and not (geo and groups) and not clothing_lead:
        return None
    reasons = []
    if geo:
        reasons.append('Libyan place/name in title')
    if groups:
        reasons.append(', '.join(groups))
    if watched:
        reasons.append('book watchlist match')
    if clothing_lead and not geo:
        reasons.append('regional clothing lead; Libya unconfirmed')
    return {'score': 5 if watched else (4 if geo and groups else 2),
            'reason': '; '.join(reasons)}


def identity(item):
    # Collapse marketplace duplicates and item variations to the listing ID.
    if item.get('legacyItemId'):
        return str(item['legacyItemId'])
    raw = item['itemId']
    parts = raw.split('|')
    return parts[1] if len(parts) > 1 else raw


def record(item, marketplace, result):
    price = item.get('price') or item.get('currentBidPrice') or {}
    url = item.get('itemWebUrl', '')
    host = (urlparse(url).hostname or '').lower()
    if not host.startswith('www.ebay.') and not host.startswith('ebay.'):
        url = ''
    return {'title': item.get('title', '')[:250], 'url': url,
            'price': f"{price.get('value', '?')} {price.get('currency', '')}",
            'country': item.get('itemLocation', {}).get('country', '?'),
            'marketplace': marketplace, 'formats': ', '.join(item.get('buyingOptions', [])),
            'end': item.get('itemEndDate', ''), **result}


def message(item):
    return (f"{item['title']}\n{item['price']} | seller country: {item['country']} | {item['marketplace']}\n"
            f"{item['formats']}" + (f" | ends: {item['end']}" if item['end'] else '') +
            f"\nWhy flagged: {item['reason']}\nShipping/forwarding and origin need review.\n{item['url']}")


def ebay_token():
    credentials = required('EBAY_CLIENT_ID') + ':' + required('EBAY_CLIENT_SECRET')
    response = request_json('https://api.ebay.com/identity/v1/oauth2/token',
                            {'Authorization': 'Basic ' + base64.b64encode(credentials.encode()).decode(),
                             'Content-Type': 'application/x-www-form-urlencoded'},
                            urlencode({'grant_type': 'client_credentials',
                                       'scope': 'https://api.ebay.com/oauth/api_scope'}).encode(), 'eBay')
    if not response.get('access_token'):
        raise BotError('eBay did not return an application token.')
    return response['access_token']


def search(token, market, query, config):
    for page in range(config['max_pages']):
        params = {'q': query, 'sort': 'newlyListed', 'limit': config['page_size'],
                  'offset': page * config['page_size'],
                  'filter': 'buyingOptions:{FIXED_PRICE|AUCTION|BEST_OFFER}'}
        response = request_json('https://api.ebay.com/buy/browse/v1/item_summary/search?' + urlencode(params),
                                {'Authorization': 'Bearer ' + token,
                                 'X-EBAY-C-MARKETPLACE-ID': market}, service='eBay')
        yield from response.get('itemSummaries', [])
        if not response.get('next'):
            return
        if page + 1 == config['max_pages']:
            print(f'WARNING: page cap reached for {market}; query {query!r}. Some listings may be missed.')
        time.sleep(0.15)


def scan(state, config):
    token = ebay_token()
    found = {}
    # Fetch every configured search before sending or changing baseline state.
    # An API failure leaves the prior baseline intact.
    for market in config['marketplaces']:
        for query in config['queries'] + config.get('book_watchlist', []):
            for item in search(token, market, query, config):
                result = classify(item, config)
                if result:
                    key = identity(item)
                    candidate = record(item, market, result)
                    if key not in found or candidate['score'] > found[key]['score']:
                        found[key] = candidate
    now = datetime.now(timezone.utc).isoformat()
    if not state['seeded']:
        state['seen'].update({key: now for key in found})
        state['seeded'] = True
        save_state(state)
        send(f'Initial scan complete: {len(found)} matching existing listings recorded. '
             'They are the starting baseline. Future newly discovered matches will be alerted; '
             'discovery does not establish authenticity or rarity.')
        return
    for key, item in found.items():
        if key not in state['seen']:
            state['seen'][key] = now
            state['pending'][key] = {**item, 'discovered': now, 'instant_sent': False}
    save_state(state)
    delivered = 0
    for item in state['pending'].values():
        if item['score'] >= config['instant_threshold'] and not item['instant_sent']:
            if delivered >= config['max_instant_per_run']:
                break
            send('New Libyan collectibles lead\n\n' + message(item))
            item['instant_sent'] = True
            save_state(state)
            delivered += 1
    print(f'Scan complete: {len(found)} matches; {delivered} instant alerts delivered.')


def digest(state, config, force=False):
    local = datetime.now(ZoneInfo(config['timezone']))
    day = local.date().isoformat()
    if not force and (local.hour < config['digest_hour'] or state.get('last_digest') == day):
        return
    eligible = [(key, item) for key, item in state['pending'].items()
                if item['score'] < config['instant_threshold'] or item['instant_sent']]
    if not eligible:
        send('Daily Libyan collectibles digest: no new matches awaiting summary.')
    # One message per item allows saving progress after each successful send.
    # A mid-digest failure retries only the remaining items on the next run.
    for key, item in eligible[:config['max_digest_per_run']]:
        label = ' (previously alerted)' if item['instant_sent'] else ''
        send('Daily Libyan collectibles digest' + label + '\n\n' + message(item))
        del state['pending'][key]
        save_state(state)
    if len(eligible) <= config['max_digest_per_run']:
        state['last_digest'] = day
    save_state(state)
    print('Digest processing complete.')


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('mode', choices=['test', 'chat-id', 'scan', 'digest'])
    args = parser.parse_args()
    if args.mode == 'chat-id':
        updates = telegram('getUpdates', {'timeout': 0, 'allowed_updates': ['message']})
        chats = sorted({str(u['message']['chat']['id']) for u in updates
                        if u.get('message', {}).get('chat', {}).get('type') == 'private'})
        if not chats:
            raise BotError('Send /start or hello to your bot in Telegram now, then run chat-id again.')
        print('Private chat IDs (choose yours and save as TELEGRAM_CHAT_ID): ' + ', '.join(chats))
        print('No tokens, usernames, or message contents are printed.')
        return
    if args.mode == 'test':
        send('Libyan Collector Bot is connected to Telegram. eBay search is not enabled by this test.')
        print('Telegram test delivered.')
        return
    config = json.loads((ROOT / 'config.json').read_text())
    state = load_state()
    if args.mode == 'scan':
        scan(state, config)
        digest(state, config)
    else:
        digest(state, config, force=True)


if __name__ == '__main__':
    try:
        main()
    except BotError as exc:
        print(f'ERROR: {exc}', file=sys.stderr)
        sys.exit(1)
