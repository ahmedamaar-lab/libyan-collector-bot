# Libyan Collector Bot

Python 3.12, standard library only. Finds leads for Libyan clothing, vintage objects, watches, vinyl, books and maps. Excludes stamps and desert glass using available title/category text. Hourly scans, individual alerts for stronger matches, and a daily digest at about 8 a.m. America/Chicago. Discovery does not establish rarity, authenticity or provenance.

## iPhone setup: Telegram first

Use Safari; choose Request Desktop Website if a GitHub menu is hidden.

1. Make the repository private if needed: Settings → General → Danger Zone → Change repository visibility → Private. GitHub reported this repository as public during setup. Never put credentials in files.
2. Settings → Secrets and variables → Actions → Secrets → New repository secret: add `TELEGRAM_BOT_TOKEN` with the token from BotFather.
3. Open your bot in Telegram and send `/start`, then a fresh `hello` immediately before the next step.
4. Actions → Libyan Collector Bot → Run workflow: choose branch `main`, mode `chat-id`, then run. Open the run → collector → Run bot to see your private chat ID. If multiple IDs appear, identify yours before continuing. This mode sends nothing and prints no tokens, names or messages. If empty, send another message and repeat. Incoming updates expire; getUpdates cannot operate if this bot has an active webhook.
5. Add another repository secret: `TELEGRAM_CHAT_ID`, with your numeric chat ID.
6. Run the workflow in mode `test`. Expect “Libyan Collector Bot is connected to Telegram.” This live test is still required; local unit tests do not prove delivery.

Shortcuts:
- [Repository settings](https://github.com/ahmedamaar-lab/libyan-collector-bot/settings)
- [Actions secrets](https://github.com/ahmedamaar-lab/libyan-collector-bot/settings/secrets/actions)
- [Run the bot](https://github.com/ahmedamaar-lab/libyan-collector-bot/actions/workflows/collector.yml)
- [Actions variables](https://github.com/ahmedamaar-lab/libyan-collector-bot/settings/variables/actions)

## Enable live eBay searches after approval

Developer-account approval and Browse API production access are distinct. Production keys alone may not permit live searches. Confirm production Browse API access. [eBay requirements](https://developer.ebay.com/api-docs/buy/buy-requirements.html).

1. Add secrets `EBAY_CLIENT_ID` (production App ID) and `EBAY_CLIENT_SECRET` (production Cert ID). Do not use Sandbox keys, Dev ID or a short-lived pasted access token. The bot requests an application token per run.
2. Run mode `scan`. The first successful scan records existing matching listings as the baseline and sends one confirmation. It does not alert those old listings. A failed search leaves the baseline unchanged.
3. Settings → Secrets and variables → Actions → Variables: add `ENABLE_EBAY` with value `true`. Scheduled scans are gated off until this is set. Remove it or set `false` to pause.
4. Subsequent scans send stronger leads individually and uncertain regional clothing leads in the daily digest. The digest includes individually alerted items with a label. Manual mode `digest` processes pending listings without needing eBay access.

## Search scope and tuning

`config.json` searches eBay US, Italy, Germany, France, UK and Spain. Other auction sites are not integrated. It uses alternate Libya spellings, Tripolitania/Cyrenaica names, Arabic, burnus and farmila variants. Tripoli and regional clothing can have non-Libyan origins; explicit Lebanon references are excluded, but attribution needs human review.

There is no explicit US-only shipping filter. Marketplace visibility can still limit domestic-only listings; this does not guarantee complete coverage. Seller country is displayed. Check shipping eligibility, cost and forwarding on each listing.

- Add specific titles to `book_watchlist`; they are searched independently. No titles have been supplied yet.
- Tune `interest_terms` and `exclude_terms`. Geography alone is not enough to alert; wording and language can cause missed matches or false positives. Modern reproductions may be flagged.
- `max_pages` is two pages of 100 results per query/marketplace. Page-cap warnings in Actions logs mean additional listings may have been missed. Narrow overloaded queries or increase the cap within your API quota.
- Seven queries across six marketplaces use up to 84 search calls per scan plus one OAuth call. Book titles add calls. Verify your actual API quota before increasing scope or frequency.
- Individual alerts are capped at 15 per run, digest at 30. Excess remains queued. A failed send stays pending. A timeout after Telegram accepted a message can produce a duplicate on a later run.

## Durable duplicate tracking

`data/state.json` tracks listing IDs across marketplaces and variations and is committed to `main` after each scan/digest, including partial failures. It contains listing metadata, no credentials or chat IDs. It does not rely on an expiring Actions cache. Do not reset state unless you want a new baseline.

Actions must be allowed to write repository contents. Branch rules preventing pushes to `main` must be resolved before enabling scans. A failed “Save duplicate and delivery state” step means progress was not persisted and alerts may repeat. Workflows are serialized; avoid editing state during a run.

The default schedule is hourly at minute 17, with alerts after each scan rather than in real time. GitHub schedules can be delayed or dropped. The daily digest runs on the first successful scan at/after 8 a.m. Chicago time. Review Actions errors and check your private repository's Actions minutes allowance; reduce frequency if needed.

Local checks: `python -m unittest discover -s tests -v`. Live Telegram delivery and eBay access require your private configuration and have not been verified during development.

References: [marketplaces](https://developer.ebay.com/api-docs/buy/ref-marketplace-supported.html), [search filters](https://developer.ebay.com/api-docs/buy/static/ref-buy-browse-filters.html), [Telegram API](https://core.telegram.org/bots/api), [GitHub schedules](https://docs.github.com/en/actions/reference/workflows-and-actions/events-that-trigger-workflows#schedule).
