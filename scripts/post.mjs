#!/usr/bin/env node
/**
 * Commish autoposter - publishes today's scheduled post to Instagram.
 *
 *   node scripts/post.mjs            # publish today's post
 *   node scripts/post.mjs --dry-run  # resolve + validate, publish nothing
 *   node scripts/post.mjs --date 2026-08-18
 *   node scripts/post.mjs --force    # ignore the posted ledger
 *
 * Env:
 *   IG_USER_ID      Instagram professional account id
 *   IG_ACCESS_TOKEN long-lived token (refreshed by refresh-token.mjs)
 *   GRAPH_HOST      default graph.instagram.com  (Instagram Login path)
 *                   use graph.facebook.com if you connected via Facebook Login
 *   GRAPH_VERSION   default v23.0
 *
 * Zero dependencies. Node 20+ (native fetch).
 *
 * Publishing is the two-step container flow Meta requires: POST /media to
 * stage each image, then POST /media_publish to push it live. Carousels stage
 * every slide as a child container first, then a parent that references them.
 */

import { readFile, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const QUEUE = path.join(ROOT, "queue.json");
const LEDGER = path.join(ROOT, "posted.json");

const HOST = process.env.GRAPH_HOST || "graph.instagram.com";
const VERSION = process.env.GRAPH_VERSION || "v23.0";
const IG_USER_ID = process.env.IG_USER_ID;
const TOKEN = process.env.IG_ACCESS_TOKEN;

const args = process.argv.slice(2);
const has = (f) => args.includes(f);
const argOf = (f) => {
  const i = args.indexOf(f);
  return i >= 0 ? args[i + 1] : undefined;
};
const DRY = has("--dry-run");
const FORCE = has("--force");

const log = (...a) => console.log(...a);
const fail = (m) => {
  console.error("ERROR:", m);
  process.exit(1);
};

/** Today in the queue's timezone, as YYYY-MM-DD. */
function localDate(tz) {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: tz,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(new Date());
}

async function graph(pathname, params, method = "POST") {
  const url = new URL(`https://${HOST}/${VERSION}/${pathname}`);
  const body = new URLSearchParams({ ...params, access_token: TOKEN });
  const res =
    method === "GET"
      ? await fetch(`${url}?${body}`)
      : await fetch(url, {
          method: "POST",
          body,
          headers: { "content-type": "application/x-www-form-urlencoded" },
        });

  const text = await res.text();
  let json;
  try {
    json = JSON.parse(text);
  } catch {
    fail(`${pathname}: non-JSON response (${res.status}): ${text.slice(0, 400)}`);
  }
  if (!res.ok || json.error) {
    const e = json.error || {};
    fail(
      `${pathname} -> ${res.status} ${e.type || ""} (code ${e.code}` +
        `${e.error_subcode ? `/${e.error_subcode}` : ""}): ${e.message || text}`
    );
  }
  return json;
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/**
 * Containers are processed asynchronously. Images are usually FINISHED
 * immediately, but a cold CDN fetch can take a few seconds, and publishing an
 * IN_PROGRESS container fails. Poll until it settles.
 */
async function waitReady(id, label, tries = 20) {
  for (let i = 0; i < tries; i++) {
    const { status_code, status } = await graph(
      id,
      { fields: "status_code,status" },
      "GET"
    );
    if (status_code === "FINISHED") return;
    if (status_code === "ERROR" || status_code === "EXPIRED") {
      fail(`${label}: container ${status_code} - ${status || "no detail"}`);
    }
    await sleep(Math.min(2000 + i * 500, 6000));
  }
  fail(`${label}: container never reached FINISHED`);
}

/** Confirm Meta can actually fetch the media before we ask it to. */
async function assertReachable(url) {
  let res;
  try {
    res = await fetch(url, { method: "HEAD", redirect: "follow" });
  } catch (e) {
    fail(`media unreachable: ${url} (${e.message})`);
  }
  if (!res.ok) fail(`media unreachable: ${url} -> HTTP ${res.status}`);
  const ct = res.headers.get("content-type") || "";
  if (!ct.startsWith("image/")) {
    fail(`media has content-type "${ct}", expected image/*: ${url}`);
  }
}

async function readLedger() {
  if (!existsSync(LEDGER)) return {};
  try {
    return JSON.parse(await readFile(LEDGER, "utf8"));
  } catch {
    return {};
  }
}

async function main() {
  if (!existsSync(QUEUE)) fail(`queue.json not found at ${QUEUE}`);
  const queue = JSON.parse(await readFile(QUEUE, "utf8"));
  const tz = queue.timezone || "America/Los_Angeles";
  const today = argOf("--date") || localDate(tz);

  const post = queue.posts.find((p) => p.date === today);
  if (!post) {
    log(`No post scheduled for ${today} (${tz}). Nothing to do.`);
    return;
  }

  const ledger = await readLedger();
  if (ledger[today] && !FORCE) {
    log(`${today} already published as media ${ledger[today].media_id}. Skipping.`);
    return;
  }

  const urls = post.media.map((m) => `${queue.base_url}/${m}`);
  log(`${today}  ${post.slug}  [${post.kind}, ${urls.length} image(s)]`);

  for (const u of urls) await assertReachable(u);
  log("  media reachable and image/*");

  if (DRY) {
    log("  --dry-run: stopping before publish");
    log("  caption:");
    log(
      post.caption
        .split("\n")
        .map((l) => `    | ${l}`)
        .join("\n")
    );
    return;
  }

  if (!IG_USER_ID || !TOKEN) fail("IG_USER_ID and IG_ACCESS_TOKEN must be set");

  let creationId;
  if (post.kind === "carousel") {
    const children = [];
    for (const [i, url] of urls.entries()) {
      const { id } = await graph(`${IG_USER_ID}/media`, {
        image_url: url,
        is_carousel_item: "true",
      });
      await waitReady(id, `slide ${i + 1}`);
      children.push(id);
      log(`  staged slide ${i + 1}/${urls.length}`);
    }
    const parent = await graph(`${IG_USER_ID}/media`, {
      media_type: "CAROUSEL",
      children: children.join(","),
      caption: post.caption,
    });
    await waitReady(parent.id, "carousel");
    creationId = parent.id;
  } else {
    const { id } = await graph(`${IG_USER_ID}/media`, {
      image_url: urls[0],
      caption: post.caption,
    });
    await waitReady(id, "image");
    creationId = id;
  }
  log(`  container ${creationId} ready`);

  const { id: mediaId } = await graph(`${IG_USER_ID}/media_publish`, {
    creation_id: creationId,
  });
  log(`  PUBLISHED media ${mediaId}`);

  ledger[today] = {
    slug: post.slug,
    media_id: mediaId,
    published_at: new Date().toISOString(),
  };
  await writeFile(LEDGER, JSON.stringify(ledger, null, 2) + "\n");

  const { quota_usage } = await graph(
    `${IG_USER_ID}/content_publishing_limit`,
    { fields: "quota_usage" },
    "GET"
  ).then((r) => r.data?.[0] || {});
  if (quota_usage !== undefined) log(`  quota used: ${quota_usage}/100 in 24h`);
}

main().catch((e) => fail(e.stack || e.message));
