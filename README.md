# commish-ig

Instagram campaign assets and publishing automation for [commish.golf](https://commish.golf).

**This repo is public for one reason:** the Instagram Graph API fetches media by
URL rather than accepting an upload, so the images have to be reachable by Meta.
Served via GitHub Pages at `https://matt-dcp.github.io/commish-ig/`.

No application code and no credentials live here. Tokens are GitHub Actions
secrets (`IG_USER_ID`, `IG_ACCESS_TOKEN`).

| Path | |
|---|---|
| `out/` | 71 rendered post images |
| `queue.json` | The posting schedule, one entry per date |
| `posted.json` | Ledger of what has published, makes re-runs idempotent |
| `scripts/` | Poster, token refresher, preflight checker |

Source of truth for the content is `marketing/campaign/` in the Commish repo.
Assets here are generated; edit the spec there and re-render.

## Operating

```bash
node scripts/preflight.mjs            # check token, account, quota, all media URLs
node scripts/post.mjs --dry-run       # resolve today's post, publish nothing
node scripts/post.mjs --date 2026-08-18
```

Daily publishing runs from Actions. To pause: Actions tab, *Daily Instagram
post*, Disable workflow.
