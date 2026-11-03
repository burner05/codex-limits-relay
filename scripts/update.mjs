import fs from "node:fs";
import crypto from "node:crypto";

const TOKEN_URL = "https://auth.openai.com/oauth/token";
const USAGE_URL = "https://chatgpt.com/backend-api/wham/usage";
const CLIENT_ID = process.env.CLIENT_ID || "app_EMoamEEZ73f0CkXaXp7hrann";
const PUBLISH_URL = process.env.RELAY_PUBLISH_URL || "";
const PUBLISH_TOKEN = process.env.RELAY_PUBLISH_TOKEN || "";
const KEY = Buffer.from(process.env.TOKEN_KEY || "", "base64");
const REFRESH_MARGIN_MS = 24 * 60 * 60 * 1000;

if (KEY.length !== 32) {
  console.error("TOKEN_KEY must be 32 bytes, base64 encoded");
  process.exit(2);
}

function encrypt(plain) {
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv("aes-256-gcm", KEY, iv);
  const data = Buffer.concat([cipher.update(plain, "utf8"), cipher.final()]);
  return {
    v: 1,
    iv: iv.toString("base64"),
    tag: cipher.getAuthTag().toString("base64"),
    data: data.toString("base64"),
  };
}

function decrypt() {
  const box = JSON.parse(fs.readFileSync("token.enc", "utf8"));
  const decipher = crypto.createDecipheriv(
    "aes-256-gcm",
    KEY,
    Buffer.from(box.iv, "base64"),
  );
  decipher.setAuthTag(Buffer.from(box.tag, "base64"));
  return Buffer.concat([
    decipher.update(Buffer.from(box.data, "base64")),
    decipher.final(),
  ]).toString("utf8");
}

function loadAuth() {
  const plain = decrypt().trim();
  if (plain.startsWith("{")) return JSON.parse(plain);
  // Backwards compatibility with the first version, which stored only the
  // refresh token as a raw string.
  return { refresh_token: plain };
}

function saveAuth(auth) {
  fs.writeFileSync("token.enc", JSON.stringify(encrypt(JSON.stringify(auth))) + "\n");
}

function accountIdFromJwt(token) {
  try {
    const part = token.split(".")[1];
    const payload = JSON.parse(Buffer.from(part, "base64url").toString("utf8"));
    const auth = payload["https://api.openai.com/auth"] || {};
    return auth.chatgpt_account_id || "";
  } catch {
    return "";
  }
}

function windowOf(window) {
  if (!window) return null;
  return {
    percent: Number(window.used_percent || 0),
    resetsAt: Number(window.reset_at || 0) * 1000,
    windowSeconds: Number(window.limit_window_seconds || 0),
  };
}

async function seed() {
  const refresh = (process.env.REFRESH_TOKEN || "").trim();
  if (!refresh) throw new Error("REFRESH_TOKEN is missing");
  saveAuth({ refresh_token: refresh });
  console.log("seeded token.enc");
}

async function refreshAuth(auth) {
  const response = await fetch(TOKEN_URL, {
    method: "POST",
    headers: {
      "content-type": "application/x-www-form-urlencoded",
      "accept": "application/json",
    },
    body: new URLSearchParams({
      grant_type: "refresh_token",
      client_id: CLIENT_ID,
      refresh_token: auth.refresh_token,
    }),
  });
  const text = await response.text();
  if (!response.ok) {
    throw new Error(`refresh HTTP ${response.status} ${text.slice(0, 200)}`);
  }
  const token = JSON.parse(text);
  auth.refresh_token = token.refresh_token || auth.refresh_token;
  auth.access_token = token.access_token;
  auth.expires_at = Date.now() + Math.max(60, Number(token.expires_in || 3600) - 60) * 1000;
  saveAuth(auth);
  console.log("token refreshed, expires_in", token.expires_in);
  return auth;
}

function fetchUsage(accessToken, accountId) {
  return fetch(USAGE_URL, {
    headers: {
      "authorization": `Bearer ${accessToken}`,
      "chatgpt-account-id": accountId,
      "user-agent": "codex-cli/0.162.1",
      "accept": "application/json",
    },
  });
}

async function publish(usage) {
  if (!PUBLISH_URL || !PUBLISH_TOKEN) {
    console.log("publish target missing; skipping");
    return;
  }
  let lastError = null;
  for (let attempt = 1; attempt <= 3; attempt++) {
    try {
      const response = await fetch(PUBLISH_URL, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "x-publish-token": PUBLISH_TOKEN,
        },
        body: JSON.stringify(usage),
      });
      const text = await response.text();
      if (!response.ok) {
        throw new Error(`publish HTTP ${response.status} ${text.slice(0, 160)}`);
      }
      console.log("published");
      return;
    } catch (error) {
      lastError = error;
      if (attempt < 3) await new Promise((resolve) => setTimeout(resolve, 2000));
    }
  }
  throw lastError;
}

async function update() {
  let auth = loadAuth();
  const now = Date.now();

  if (!auth.access_token || !auth.expires_at || auth.expires_at < now + REFRESH_MARGIN_MS) {
    auth = await refreshAuth(auth);
  } else {
    console.log("cached access token still valid");
  }

  let accountId = accountIdFromJwt(auth.access_token);
  let response = await fetchUsage(auth.access_token, accountId);

  if (response.status === 401) {
    console.log("usage returned 401; refreshing token");
    auth = await refreshAuth(auth);
    accountId = accountIdFromJwt(auth.access_token);
    response = await fetchUsage(auth.access_token, accountId);
  }

  const text = await response.text();
  if (!response.ok) {
    throw new Error(`usage HTTP ${response.status} ${text.slice(0, 200)}`);
  }

  const data = JSON.parse(text);
  const rateLimit = data.rate_limit || {};
  const usage = {
    plan: data.plan_type || null,
    primary: windowOf(rateLimit.primary_window),
    secondary: windowOf(rateLimit.secondary_window),
    fetchedAt: Date.now(),
  };

  await publish(usage);
  console.log("usage", JSON.stringify(usage));
}

const run = process.argv.includes("--seed") ? seed : update;
run().catch((error) => {
  console.error(error && error.stack ? error.stack : String(error));
  process.exit(1);
});
