# Libyan Collector Bot

Python scanner for Libyan clothing, watches, vinyl, books, maps and vintage objects across eBay US, Italy, Germany, France, UK and Spain. Telegram delivers stronger leads individually and uncertain regional clothing in a daily digest. Stamps and desert glass are excluded. Discovery does not establish authenticity or provenance.

## Run

Open Actions → Libyan Collector Bot → Run workflow, branch `main`, mode `scan`.
The first successful scan records existing listings as a baseline and sends a Telegram confirmation. Later scans alert newly discovered matches. API failures leave the baseline unchanged.

GitHub needs only `TELEGRAM_BOT_TOKEN` and `TELEGRAM_CHAT_ID` repository secrets. Cloudflare stores `EBAY_CLIENT_ID`, `EBAY_CLIENT_SECRET` and `EBAY_VERIFICATION_TOKEN`. The workflow authenticates to Cloudflare with GitHub OIDC; no shared bridge secret or eBay credentials are copied to GitHub. Only the main-branch collector workflow in this repository is accepted.

For hourly runs, set the Actions repository variable `ENABLE_EBAY` to `true` after the first live scan succeeds. Set it to `false` to pause. Runs are hourly at minute 17; GitHub schedules may be delayed. The digest runs on the first scan at/after 8 a.m. America/Chicago. Manual mode `digest` sends pending summaries. `test` tests Telegram alone; `chat-id` finds the chat ID after sending the bot a fresh message.

[Run workflow](https://github.com/ahmedamaar-lab/libyan-collector-bot/actions/workflows/collector.yml) · [Actions variables](https://github.com/ahmedamaar-lab/libyan-collector-bot/settings/variables/actions)

## Storage and deletion notices

Production discovery and delivery state lives in Cloudflare D1, not Git commits. The Worker uses `DB` bound to `libyan-collector-data`. Schema is in `cloudflare/schema.sql`. Revision checks stop concurrent or stale writes from restoring removed data. The legacy `data/state.json` is an empty local-development fixture and is not read by production scans.

The root endpoint verifies eBay challenge requests and notification signatures. Verified deletion notices are queued durably, matched against hashed seller references, applied to pending listing metadata, and redacted. Notices without a usable username conservatively clear pending metadata. Listing IDs and discovery timestamps in the deduplication index contain no seller names. Already delivered Telegram messages are not removed automatically. Raw seller names, feedback and precise location are excluded from search responses; only a suppression hash and seller country are retained.

Cloudflare source: `cloudflare/worker.mjs` and `cloudflare/collector.mjs`. Deploy both modules with entry point `worker.mjs`, preserving existing secrets and `DB` binding. The production endpoint is `https://libyan-collector-notifications.ahmedamaartrack.workers.dev/`. Preserve this exact URL (including trailing slash) for eBay challenge hashing. Production currently uses compatibility date `2026-10-14`.

## Search tuning

Edit `config.json` for keywords, marketplaces, exclusion terms and `book_watchlist`. Broad queries use up to two pages of 100 results; page-cap warnings indicate missed additional results. Seven queries over six marketplaces use up to 84 search calls per scan. No US-only shipping filter is applied; marketplace visibility still varies. Review shipping/forwarding and origin for each lead.

Individual alerts are capped at 15 per run; digest entries at 30. Excess remains queued. Telegram send timeouts can cause a duplicate after delivery. Failed state saves stop the run instead of overwriting concurrent changes. If repeated deletion notices interrupt a run, retry it after checking Worker logs.

## Checks

`python -m unittest discover -s tests -v`

`node --test cloudflare/test.mjs cloudflare/collector.test.mjs`

These verify offline behavior. A successful live scan is still needed to confirm Browse API access, OIDC and Telegram delivery together. eBay production key activation alone does not guarantee Browse API production access.

References: [GitHub OIDC](https://docs.github.com/en/actions/reference/security/oidc), [eBay account deletion](https://developer.ebay.com/develop/guides/sell/marketplace-user-account-deletion), [Browse API requirements](https://developer.ebay.com/api-docs/buy/buy-requirements.html).
