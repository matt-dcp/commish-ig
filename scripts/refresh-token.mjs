#!/usr/bin/env node
/**
 * Refresh the Instagram long-lived access token.
 *
 * Long-lived tokens last 60 days. A token that goes 60 days without a refresh
 * is dead and cannot be revived - you have to redo the OAuth handshake by
 * hand. This runs weekly so the campaign never silently stops posting.
 *
 *   node scripts/refresh-token.mjs
 *
 * Env:
 *   IG_ACCESS_TOKEN   current long-lived token
 *   GITHUB_TOKEN      optional; if set (plus GITHUB_REPOSITORY), the new token
 *                     is written straight back into the repo secret so the
 *                     rotation is fully unattended
 *
 * Writes the new token to $GITHUB_OUTPUT when running under Actions.
 */

import { appendFile } from "node:fs/promises";
import { createHash } from "node:crypto";

const TOKEN = process.env.IG_ACCESS_TOKEN;
if (!TOKEN) {
  console.error("ERROR: IG_ACCESS_TOKEN not set");
  process.exit(1);
}

const fingerprint = (t) => createHash("sha256").update(t).digest("hex").slice(0, 12);

const res = await fetch(
  "https://graph.instagram.com/refresh_access_token?" +
    new URLSearchParams({ grant_type: "ig_refresh_token", access_token: TOKEN })
);
const body = await res.json().catch(() => ({}));

if (!res.ok || body.error) {
  console.error(
    `ERROR: refresh failed (${res.status}):`,
    body.error?.message || JSON.stringify(body)
  );
  console.error(
    "If the token is already expired it cannot be refreshed. Re-run the " +
      "one-time OAuth handshake in SETUP.md step 6."
  );
  process.exit(1);
}

const days = Math.round((body.expires_in || 0) / 86400);
console.log(`Refreshed. old=${fingerprint(TOKEN)} new=${fingerprint(body.access_token)}`);
console.log(`Valid for ${days} more days.`);

if (process.env.GITHUB_OUTPUT) {
  await appendFile(process.env.GITHUB_OUTPUT, `token=${body.access_token}\n`);
  await appendFile(process.env.GITHUB_OUTPUT, `days=${days}\n`);
}

// Push the rotated token back into the repo secret so nothing needs a human.
const { GITHUB_TOKEN, GITHUB_REPOSITORY } = process.env;
if (GITHUB_TOKEN && GITHUB_REPOSITORY) {
  const api = `https://api.github.com/repos/${GITHUB_REPOSITORY}/actions/secrets`;
  const h = {
    authorization: `Bearer ${GITHUB_TOKEN}`,
    accept: "application/vnd.github+json",
  };
  const key = await fetch(`${api}/public-key`, { headers: h }).then((r) => r.json());
  if (!key.key) {
    console.error("WARN: could not read repo public key; secret not rotated");
    process.exit(0);
  }
  // libsodium sealed box, via the pure-JS implementation Actions ships.
  const sodium = await import("libsodium-wrappers").then((m) => m.default);
  await sodium.ready;
  const sealed = sodium.crypto_box_seal(
    sodium.from_string(body.access_token),
    sodium.from_base64(key.key, sodium.base64_variants.ORIGINAL)
  );
  const put = await fetch(`${api}/IG_ACCESS_TOKEN`, {
    method: "PUT",
    headers: { ...h, "content-type": "application/json" },
    body: JSON.stringify({
      encrypted_value: sodium.to_base64(sealed, sodium.base64_variants.ORIGINAL),
      key_id: key.key_id,
    }),
  });
  console.log(
    put.ok
      ? "Repo secret IG_ACCESS_TOKEN rotated."
      : `WARN: secret rotation failed (${put.status})`
  );
}
