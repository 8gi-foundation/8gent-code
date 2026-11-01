# GitHub -> Discord Webhook Setup

After running `bun scripts/setup-github-webhook.ts`, the webhook URL is stored in `.env` as `DISCORD_GITHUB_WEBHOOK_URL`.

## Steps to add the webhook to GitHub

1. Go to the repo **Settings** > **Webhooks** > **Add webhook**
2. **Payload URL:** Paste the webhook URL from `.env` with `/github` appended:
   ```
   https://discord.com/api/webhooks/<id>/<token>/github
   ```
3. **Content type:** `application/json`
4. **Secret:** Leave blank (Discord handles auth via the token in the URL)
5. **Which events would you like to trigger this webhook?** Select "Let me select individual events" and check:
   - Pull requests
   - Pushes
   - Issues
   - Issue comments
6. **Active:** Yes (checked)
7. Click **Add webhook**

## What it does

GitHub will POST event payloads to the Discord webhook. Discord's `/github` endpoint automatically formats them into rich embeds showing:

- PR opened/closed/merged
- Push commits
- Issues opened/closed
- Issue comments

## Security

- The webhook URL contains a secret token - never commit it to the repo
- It is stored in `.env` which is gitignored
- If compromised, delete the webhook in Discord server settings and re-run the setup script
