# Codex Limits Relay

Read-only usage feed for the phone dashboard.

- A GitHub Actions job runs every 5 minutes.
- It decrypts the stored Codex refresh token (AES-256-GCM, key in the
  `TOKEN_KEY` repository secret), refreshes the OAuth token, and fetches
  `https://chatgpt.com/backend-api/wham/usage`.
- It writes `usage.json` (only plan, percentages and reset times) and the new
  encrypted refresh token back to this public repository.
- The phone reads the data through a small Cloudflare Worker proxy, so the
  refresh token never leaves GitHub Actions and the public repo contains no
  account identifiers.

## Secret

`TOKEN_KEY`: 32 random bytes, base64 encoded. The token file is public but
useless without this key.

## Manual refresh

Run the **update-codex-usage** workflow from the Actions tab.

## Output

```json
{
  "plan": "plus",
  "primary": { "percent": 2, "resetsAt": 1793688619000, "windowSeconds": 18000 },
  "secondary": { "percent": 18, "resetsAt": 1793784070000, "windowSeconds": 604800 },
  "fetchedAt": 1793675000000
}
```

Codex data is updated on the GitHub Actions schedule (5 minute minimum), so it
can lag a few minutes behind the OpenCode data.
