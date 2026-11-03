# Codex Limits Relay

Read-only Codex usage feed for the phone dashboard.

## Flow

1. A Cloudflare Worker Cron Trigger dispatches the GitHub Actions job every 5 minutes.
2. It decrypts `token.enc` (AES-256-GCM, key in the `TOKEN_KEY` secret).
3. It reuses the cached access token when possible; otherwise it refreshes the
   Codex OAuth token and writes the new encrypted token.
4. It fetches `https://chatgpt.com/backend-api/wham/usage`.
5. It pushes the percentages to the Cloudflare Worker (`POST /publish`).
6. The phone reads `GET /usage` from the Worker.

The public repository contains only:

- the workflow and a small Node script,
- an encrypted token file (useless without `TOKEN_KEY`),
- no account IDs or email addresses.

## Secrets and variables

- `TOKEN_KEY` (secret): 32 random bytes, base64 encoded.
- `RELAY_PUBLISH_TOKEN` (secret): shared token for the Worker `/publish`.
- `RELAY_PUBLISH_URL` (variable): `https://codex-limits-relay.erdibaba3.workers.dev/publish`.
- `CLIENT_ID` is public (`app_EMoamEEZ73f0CkXaXp7hrann`).

## Output

```json
{
  "plan": "plus",
  "primary": { "percent": 2, "resetsAt": 1793688619000, "windowSeconds": 18000 },
  "secondary": { "percent": 18, "resetsAt": 1793784070000, "windowSeconds": 604800 },
  "fetchedAt": 1793675929356
}
```

## Re-seeding the Codex login

If the refresh token is revoked, create a fresh Codex login (outside the Mac's
normal `~/.codex`), then replace `token.enc`:

```sh
CODEX_HOME="$HOME/.codex-relay" codex login --device-auth
cd codex-limits-relay
TOKEN_KEY="$(cat ~/.codex-relay/token_key)" \
REFRESH_TOKEN="$(python3 -c 'import json,os;print(json.load(open(os.path.expanduser("~/.codex-relay/auth.json")))["tokens"]["refresh_token"])')" \
node scripts/update.mjs --seed
git add token.enc && git commit -m "reseed codex token" && git push
```

## Freshness

The Cloudflare cron runs every 5 minutes; GitHub can take a few more seconds
to start the job and Cloudflare KV can take up to a minute to propagate a new
write. The phone therefore shows Codex data with a small lag, unlike the
OpenCode data which is fetched every 30 seconds directly from opencode.ai.
