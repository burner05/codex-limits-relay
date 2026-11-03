import fs from "node:fs";
import crypto from "node:crypto";

const TOKEN_URL = "https://auth.openai.com/oauth/token";
const USAGE_URL = "https://chatgpt.com/backend-api/wham/usage";
const CLIENT_ID = process.env.CLIENT_ID || "app_EMoamEEZ73f0CkXaXp7hrann";
const KEY = Buffer.from(process.env.TOKEN_KEY || "", "base64");

if (KEY.length !== 32) {
  console.error("TOKEN_KEY must be 32 bytes, base64 encoded");
  process.exit(2);
}

function encryptToken(plain) {
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

function decryptToken() {
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
  fs.writeFileSync("token.enc", JSON.stringify(encryptToken(refresh)) + "\n");
  console.log("seeded token.enc");
}

async function update() {
  let refresh = decryptToken().trim();

  const tokenResponse = await fetch(TOKEN_URL, {
    method: "POST",
    headers: {
      "content-type": "application/x-www-form-urlencoded",
      "accept": "application/json",
    },
    body: new URLSearchParams({
      grant_type: "refresh_token",
      client_id: CLIENT_ID,
      refresh_token: refresh,
    }),
  });
  const tokenText = await tokenResponse.text();
  if (!tokenResponse.ok) {
    throw new Error(`refresh HTTP ${tokenResponse.status} ${tokenText.slice(0, 200)}`);
  }
  const token = JSON.parse(tokenText);
  refresh = token.refresh_token || refresh;

  // Persist rotation immediately, before any other network call can fail.
  fs.writeFileSync("token.enc", JSON.stringify(encryptToken(refresh)) + "\n");
  console.log("token refreshed");

  const accountId = accountIdFromJwt(token.access_token);
  if (!accountId) throw new Error("account id missing from access token");

  const usageResponse = await fetch(USAGE_URL, {
    headers: {
      "authorization": `Bearer ${token.access_token}`,
      "chatgpt-account-id": accountId,
      "user-agent": "codex-cli/0.162.1",
      "accept": "application/json",
    },
  });
  const usageText = await usageResponse.text();
  if (!usageResponse.ok) {
    fs.writeFileSync(
      "usage.json",
      JSON.stringify({ error: `usage HTTP ${usageResponse.status}`, fetchedAt: Date.now() }, null, 2) + "\n",
    );
    throw new Error(`usage HTTP ${usageResponse.status} ${usageText.slice(0, 200)}`);
  }

  const data = JSON.parse(usageText);
  const rateLimit = data.rate_limit || {};
  const usage = {
    plan: data.plan_type || null,
    primary: windowOf(rateLimit.primary_window),
    secondary: windowOf(rateLimit.secondary_window),
    fetchedAt: Date.now(),
  };
  fs.writeFileSync("usage.json", JSON.stringify(usage, null, 2) + "\n");
  console.log("usage", JSON.stringify(usage));
}

const run = process.argv.includes("--seed") ? seed : update;
run().catch((error) => {
  console.error(error && error.stack ? error.stack : String(error));
  process.exit(1);
});
