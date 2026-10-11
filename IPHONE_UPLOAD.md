# Upload this package from your iPhone

The GitHub connection could read the repository but its write request returned HTTP 403, Resource not accessible by integration. No files were uploaded. To retry direct upload, configure the connected GitHub app to include this repository and accept a write-permission update if offered. Do not send tokens in chat.

## Manual route

1. Download `libyan-collector-bot.zip` to Files. Keep it zipped.
2. In Safari open https://github.com/ahmedamaar-lab/libyan-collector-bot . Request Desktop Website if needed. On the empty-repository page choose **uploading an existing file** (or Add file → Upload files). Select the ZIP from Files and commit it to `main`.
3. Open **Code → Codespaces → Create codespace on main**. Use Safari desktop view. Codespaces usage is subject to your GitHub plan/allowance. Open the terminal in the browser editor.
4. Run these commands individually. The archive extracts files directly into the repository, including `.github/workflows/collector.yml`:

```bash
unzip -o libyan-collector-bot.zip
python -m unittest discover -s tests -v
git rm libyan-collector-bot.zip
git add bot.py config.json README.md IPHONE_UPLOAD.md .gitignore tests data .github
git commit -m "Install Libyan Collector Bot"
git push origin main
```

If a command fails, stop and share the error without credentials. If GitHub blocks pushing a workflow file, the connection needs workflow write permission; do not silently omit the workflow. Stop the Codespace after uploading.

5. Make the repository private under Settings → General → Danger Zone if it is public.
6. Follow README.md for `TELEGRAM_BOT_TOKEN`, the `chat-id` workflow, `TELEGRAM_CHAT_ID`, and the `test` workflow. You can test Telegram while eBay approval is pending.
7. Add production eBay credentials and enable `ENABLE_EBAY=true` only after a successful manual production scan.
