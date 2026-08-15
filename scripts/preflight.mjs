#!/usr/bin/env node
/**
 * Preflight - run this before the first live post, and any time posting breaks.
 *
 *   node scripts/preflight.mjs
 *
 * Checks, in order:
 *   1. env vars present
 *   2. token valid, and which account it actually points at
 *   3. account is a professional (Business/Creator) account
 *   4. publishing quota headroom
 *   5. every image in queue.json is publicly reachable and served as image/*
 *   6. queue dates are sane (no gaps, no past-dated backlog about to fire)
 *
 * Exits non-zero on the first hard failure so CI can gate on it.
 */

import { readFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const HOST = process.env.GRAPH_HOST || "graph.instagram.com";
const VERSION = process.env.GRAPH_VERSION || "v23.0";
const { IG_USER_ID, IG_ACCESS_TOKEN: TOKEN } = process.env;

let failed = false;
const ok = (m) => console.log(`  PASS  ${m}`);
const bad = (m) => {
  console.log(`  FAIL  ${m}`);
  failed = true;
};
const warn = (m) => console.log(`  WARN  ${m}`);
const step = (n, m) => console.log(`\n${n}. ${m}`);

async function get(pathname, fields) {
  const qs = new URLSearchParams({ access_token: TOKEN });
  if (fields) qs.set("fields", fields);
  const res = await fetch(`https://${HOST}/${VERSION}/${pathname}?${qs}`);
  const json = await res.json().catch(() => ({}));
  return { res, json };
}

console.log(`Commish autopost preflight\n  host=${HOST} version=${VERSION}`);

step(1, "Credentials");
if (!TOKEN) bad("IG_ACCESS_TOKEN not set");
else ok(`IG_ACCESS_TOKEN present (${TOKEN.length} chars)`);
if (!IG_USER_ID) bad("IG_USER_ID not set");
else ok(`IG_USER_ID = ${IG_USER_ID}`);

if (TOKEN && IG_USER_ID) {
  step(2, "Token and account");
  const { res, json } = await get(IG_USER_ID, "id,username,account_type");
  if (!res.ok || json.error) {
    bad(`token rejected: ${json.error?.message || res.status}`);
  } else {
    ok(`authenticated as @${json.username}`);
    if (json.id !== IG_USER_ID) {
      warn(`token resolves to id ${json.id}, IG_USER_ID says ${IG_USER_ID}`);
    }
    step(3, "Account type");
    const t = (json.account_type || "").toUpperCase();
    if (["BUSINESS", "CREATOR", "MEDIA_CREATOR"].includes(t)) {
      ok(`account_type = ${t}`);
    } else if (!t) {
      warn("account_type not returned; verify it is Business or Creator in the app");
    } else {
      bad(`account_type = ${t}. Publishing requires Business or Creator.`);
    }

    step(4, "Publishing quota");
    const q = await get(`${IG_USER_ID}/content_publishing_limit`, "quota_usage");
    const used = q.json?.data?.[0]?.quota_usage;
    if (used === undefined) warn("quota unavailable (not fatal)");
    else if (used >= 100) bad(`quota exhausted: ${used}/100 in the last 24h`);
    else ok(`quota used ${used}/100 in the last 24h`);
  }
}

step(5, "Queue media reachability");
const QUEUE = path.join(ROOT, "queue.json");
if (!existsSync(QUEUE)) {
  bad("queue.json missing. Run: python3 build_queue.py");
} else {
  const queue = JSON.parse(await readFile(QUEUE, "utf8"));
  const urls = queue.posts.flatMap((p) => p.media.map((m) => `${queue.base_url}/${m}`));
  console.log(`  checking ${urls.length} images at ${queue.base_url} ...`);
  let badCount = 0;
  const results = await Promise.all(
    urls.map(async (u) => {
      try {
        const r = await fetch(u, { method: "HEAD", redirect: "follow" });
        const ct = r.headers.get("content-type") || "";
        if (!r.ok) return `${u} -> HTTP ${r.status}`;
        if (!ct.startsWith("image/")) return `${u} -> content-type ${ct}`;
        return null;
      } catch (e) {
        return `${u} -> ${e.message}`;
      }
    })
  );
  for (const r of results) {
    if (r) {
      if (badCount < 5) bad(r);
      badCount++;
    }
  }
  if (badCount === 0) ok(`all ${urls.length} images reachable and image/*`);
  else if (badCount > 5) bad(`... and ${badCount - 5} more unreachable`);

  step(6, "Schedule sanity");
  const tz = queue.timezone || "America/Los_Angeles";
  const today = new Intl.DateTimeFormat("en-CA", {
    timeZone: tz,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(new Date());
  const dates = queue.posts.map((p) => p.date).sort();
  const past = dates.filter((d) => d < today);
  const dup = dates.filter((d, i) => dates[i - 1] === d);
  if (dup.length) bad(`duplicate dates in queue: ${[...new Set(dup)].join(", ")}`);
  else ok("one post per date");
  if (past.length) {
    warn(
      `${past.length} date(s) already in the past (${past[0]} .. ${past.at(-1)}). ` +
        "These will never fire; the poster only publishes the current day."
    );
  }
  const upcoming = dates.filter((d) => d >= today);
  ok(`${upcoming.length} post(s) still ahead, next on ${upcoming[0] || "none"}`);

  // Gaps read as an abandoned account to the algorithm; flag them.
  for (let i = 1; i < upcoming.length; i++) {
    const gap = (new Date(upcoming[i]) - new Date(upcoming[i - 1])) / 86400000;
    if (gap > 2) {
      warn(`${gap}-day gap between ${upcoming[i - 1]} and ${upcoming[i]}`);
      break;
    }
  }
}

console.log(failed ? "\nPREFLIGHT FAILED" : "\nPREFLIGHT OK");
process.exit(failed ? 1 : 0);
