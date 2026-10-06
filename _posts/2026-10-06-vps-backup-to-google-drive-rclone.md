---
title: "Backing Up Linux Servers to Google Drive with rclone: A Complete Reproducible Walkthrough"
lang: en
permalink: /en/2026/10/06/vps-backup-to-google-drive-rclone/
description: "A complete, reproducible walkthrough of backing up a VPS and a home server to Google Drive with rclone: creating your own client_id, headless authorization, incremental sync, cron scheduling and failure alerts. Includes two traps I actually hit, with root-cause analysis of a token refresh bug I initially misattributed."
keywords: ["rclone backup", "Google Drive backup", "VPS backup", "rclone authorize", "rclone headless", "rclone 401", "Google Drive API", "nginx sites-enabled", "linux backup script", "crontab incremental backup", "rclone own client_id"]
mermaid: true
---

# Backing Up Linux Servers to Google Drive with rclone

I wanted two Linux machines backed up to Google Drive: a 4.9G VPS running x-ui, cloudflare_temp_email and memory-tree, and a home server running two dozen Docker containers.

rclone's documentation covers the configuration well, so the setup itself isn't hard. This walkthrough gives every step in **the order you actually execute them**, from creating a client_id to the cron job, with each piece copy-pasteable.

The last section covers the two places I actually got stuck, with root-cause analysis — including a token refresh bug I initially misattributed to Google.

**Prerequisites**

```
1. A Google account
2. A machine with a browser (your laptop is fine, used for OAuth authorization)
3. SSH access to the machine you're backing up
```

---

## 0. Create your own client_id (do this first, it's the slowest step in the console)

This is mandatory in 2026. From rclone's official docs:

> The shared client_id is being retired and will stop working during 2026, so creating your own is now strongly recommended.

(I confirmed that sentence appears in three places on [rclone.org/drive/](https://rclone.org/drive/), including the `--drive-client-id` flag description.)

**The steps:**

1. [Google Cloud Console](https://console.cloud.google.com/) → create a project
2. **APIs and Services → Library** → search `Google Drive API` → **Enable**
   - This is the easiest one to miss. Skip it and every API call fails with `Error 403: googleapi: Error 403: ... SERVICE_DISABLED`
3. **OAuth consent screen** → External → app name, support email, developer email
4. **Credentials → Create Credentials → OAuth client ID** → Application type: **Desktop app**
5. Record the `client_id` and `client_secret`

**On verification**: personal use (under 100 users) **does not require passing Google's verification review**. The app can stay in Testing state. Authorization works fine — you just get a "Google hasn't verified this app" banner at the top of the consent screen, which you dismiss with **Advanced → Continue**.

The one real consequence of staying in Testing: the `refresh_token` may carry an expiry field. Mine had `refresh_token_expires_in: 604799` (7 days). Publishing to Production removes that field and makes the token permanent. That's your call.

---

## 1. Get the token (the standard way on a headless server)

A server has no browser, so this step uses rclone's `authorize` command — **run it on your local machine with a browser**, not on the server.

```bash
# On your local machine (not the server)
rclone authorize "drive" "<client_id>" "<client_secret>"
```

The command prints a URL; open it in a browser, complete authorization, and the terminal prints a JSON blob:

```json
{
  "access_token": "ya29.a0AX...",
  "token_type": "Bearer",
  "refresh_token": "1//0eXxxxxx",
  "expiry": "2026-10-06T12:34:56.000000000+08:00",
  "scope": "https://www.googleapis.com/auth/drive"
}
```

**Keep this whole JSON** — the next step needs it.

> ⚠️ If you hand-roll a curl call to Google's token endpoint from the server (because you can't run `rclone authorize` there), you have to handle this contract yourself. That path has a trap — see [section 6](#61-hand-injected-tokens-cannot-refresh).

---

## 2. rclone config on the server

```bash
mkdir -p ~/.config/rclone && chmod 700 ~/.config/rclone
rclone config      # n for new → name: gdrive → type: drive → paste the JSON above
chmod 600 ~/.config/rclone/rclone.conf
```

Or write the config by hand (the equivalent of what `rclone config` produces):

```ini
[gdrive]
type = drive
scope = drive
client_id = <your client_id>.apps.googleusercontent.com
client_secret = <your client_secret>
token = <the whole JSON from step 1>
team_drive =
config_is_local = false
```

**Permissions must be 600** — the file holds a refresh_token that can read and write your entire Drive.

**On scope**: use `drive` (full) for personal backups. `drive.file` only reaches files the app created itself, which restricts rclone's ability to list directories and diff existing files.

**Verify**:

```bash
rclone lsd gdrive:
rclone about gdrive:      # remaining space and usage
```

---

## 3. Backing up a remote VPS (without staging it locally)

rclone supports `:sftp,host=...` connection strings, so it reads over SSH and writes straight to the cloud with no local staging — which mattered when the VPS only had 743M free.

Prerequisite: SSH key-based auth already set up on the VPS, and the sshd SFTP subsystem enabled (default).

```bash
#!/usr/bin/env bash
# VPS -> Google Drive
set -euo pipefail

VPS_HOST=203.0.113.10
VPS_USER=root
VPS_KEY=$HOME/.ssh/backup_key
SRC=":sftp,host=$VPS_HOST,user=$VPS_USER,key_file=$VPS_KEY:"
DEST="gdrive:backup/vps"
LOCK=/tmp/vps-backup.lock

EXCL=(
  --exclude='/proc/**' --exclude='/sys/**' --exclude='/dev/**'
  --exclude='/run/**' --exclude='/tmp/**' --exclude='/mnt/**'
  --exclude='/var/log/**' --exclude='/var/cache/**'
  --exclude='/var/lib/apt/**'
  --exclude='**/node_modules/**' --exclude='**/.npm/**' --exclude='**/.cache/**'
)

# without this, cron and a manual run write the same Drive dir concurrently
exec 9>"$LOCK"
flock -n 9 || { echo "another backup is running, skip"; exit 0; }

rclone copy "$SRC/" "$DEST" "${EXCL[@]}" \
  --transfers 4 --checkers 8 --sftp-concurrency 4 \
  --stats 30s --stats-one-line
```

The exclusion logic: virtual filesystems (unreadable), temp files, logs and package caches (rebuildable), and `node_modules` / `.npm` / `.cache` (an `npm install` brings those back). On the VPS those three categories totalled about 165M.

---

## 4. Incremental local backup (only what's expensive to recreate)

My local machine had 56G in use. The rule I settled on: **back up only what you'd have to rebuild or reconfigure by hand if it vanished.**

```bash
SOURCES=(
  /home/<user>            # projects, scripts, config, SSH keys, browser profiles
  /etc                    # nginx, firewall, panel config, systemd units
  /opt                    # code for self-hosted services
  /usr/local/x-ui         # the panel's database
  /var/lib/docker/volumes # container data (databases, credentials)
)

EXCL=(
  --exclude='**/venv/**' --exclude='**/.venv/**'
  --exclude='**/.cache/**' --exclude='**/node_modules/**'
  --exclude='**/.gradle/**' --exclude='**/go/pkg/**'
  --exclude='/var/lib/docker/overlay2/**'   # image layers, docker pull brings them back
  --exclude='/usr/lib/**' --exclude='/usr/share/**'
)

for s in "${SOURCES[@]}"; do
  [ -e "$s" ] || continue
  rclone copy "$s" "gdrive:backup/local$s" "${EXCL[@]}" \
    --transfers 4 --checkers 8
done
```

Excluding `overlay2` and `venv` took the local backup from 24G down to 12.8G.

`/var/lib/docker/volumes` is the one entry you must not exclude — the databases and credentials in there genuinely have to be recreated by hand. Image layers under `overlay2` come back with a `docker pull`.

---

## 5. Scheduling and failure alerts

```bash
#!/usr/bin/env bash
set -uo pipefail
export PATH="$HOME/.local/bin:$PATH"   # cron's PATH omits user bin dirs
TG_TOKEN="<your-bot-token>"
TG_CHAT="<your-chat-id>"

notify() {   # swap for any channel; Telegram Bot API shown here
  curl -s -X POST "https://api.telegram.org/bot$TG_TOKEN/sendMessage" \
    -d chat_id="$TG_CHAT" --data-urlencode "text=$1" > /dev/null
}

exec 9>/tmp/daily-backup.lock
flock -n 9 || exit 0

# preflight: the token can expire depending on OAuth app state or revocation
if ! rclone lsd gdrive:backup >/dev/null 2>&1; then
  notify "Backup did not run: Google token expired. Re-authorize with rclone authorize."
  exit 1
fi

~/bin/local-gdrive-backup.sh 2>&1 | tail -50
~/bin/vps-gdrive-backup.sh   2>&1 | tail -50

notify "Backup complete $(date '+%F %H:%M')
VPS $(rclone size gdrive:backup/vps | tail -1)
local $(rclone size gdrive:backup/local | tail -1)"
```

crontab:

```bash
30 5 * * * /home/<user>/bin/daily-gdrive-backup.sh >>/tmp/daily-backup.log 2>&1
```

**On frequency**: `rclone copy` uses file size and mtime to decide what needs uploading. Walking 140,000 directory entries takes a while, but only changed files actually transfer, typically tens of megabytes. A daily run costs much less than intuition suggests.

**On speed**: Drive rate-limits API calls for many small files. I measured throughput climbing from `130 KiB/s` to `1.28 MiB/s` — that's Drive's QPS ceiling, not your bandwidth (a hundred thousand files means a hundred thousand requests). So "scanning takes a long time" and "only a few MB actually transferred" can both be true.

**On quota**: the upload allowance varies by account type and isn't a single small fixed number. Daily increments of tens of MB aren't a concern. The 18G first run does exceed a typical personal account's daily allowance, so spread it over a couple of days (rclone reports a quota error rather than silently truncating).

---

## 6. The two places I actually got stuck

If you follow steps 0–5 you won't hit either of these. But I did, so here's what happened.

### 6.1 Hand-injected tokens cannot refresh

**Symptom**

```bash
$ rclone copy ./data gdrive:backup/
# 11:52 — all good, uploading starts
# 12:52 — exactly one hour later:
2026/09/30 12:52:26 ERROR : bin/who: Failed to copy: couldn't list directory:
  googleapi: Error 401: Request had invalid authentication credentials.
```

**Why it happened**

I couldn't run `rclone authorize` on the headless server, so I used curl and Python to call Google's token endpoint myself, then wrote the raw JSON response straight into `rclone.conf`.

The problem is the **contract** between two pieces of code:

OAuth 2.0 ([RFC 6749 §5.1](https://datatracker.ietf.org/doc/html/rfc6749#section-5.1)) specifies that token responses express lifetime as `expires_in` (relative seconds) and contain **no absolute timestamp**. Google follows this exactly.

rclone uses Go's `oauth2` package, which computes the absolute time itself:

```go
// golang.org/x/oauth2/internal/token.go
Expiry: time.Now().Add(time.Duration(expiresIn) * time.Second)
```

So **the JSON produced by `rclone authorize` does contain an `expiry` field** — rclone computed it before writing the file. The raw JSON I injected by hand didn't have it, so rclone read a zero value `time.Time{}`.

rclone's expiry decision (`lib/oauthutil/oauthutil.go`):

```go
func (ts *TokenSource) timeToExpiry() time.Duration {
	t := ts.token
	if t == nil {
		return 0
	}
	if t.Expiry.IsZero() {
		return 3e9 * time.Second // ~95 years
	}
	return time.Until(t.Expiry)
}
```

Zero value → returns 95 years → the refresh timer is set for 95 years → **it never refreshes**. rclone keeps using an `access_token` that stopped working an hour after it was minted.

The `// ~95 years` comment in the source is rclone's own plain-text way of saying "treat this as never expiring."

**So this is neither Google's bug nor rclone's — it's what happens when you inject data through a non-standard path.** The correct approach is `rclone authorize` from step 1.

**How to confirm it** (run this first on any similar 401):

```bash
# bypass rclone, ask Google directly whether the refresh_token still works
RT=$(python3 -c "
import json,pathlib
l=[x for x in (pathlib.Path.home()/'.config/rclone/rclone.conf').read_text().splitlines() if x.startswith('token =')][0]
print(json.loads(l.split(' = ',1)[1])['refresh_token'])")

curl -s https://oauth2.googleapis.com/token \
  -d client_id=<your client_id> \
  -d client_secret=<your client_secret> \
  -d grant_type=refresh_token \
  -d refresh_token="$RT"
```

A fresh `access_token` in the response means the refresh_token is fine and the problem is client-side expiry handling.

**A note on the hack I used as a stopgap**: I set `expiry` to `2020-01-01T00:00:00Z` and `access_token` to the string `"stale"` to force the refresh path. It works, but **don't use it in production** — it's a patch for improperly injected data. The right fix is to re-run `rclone authorize`. (One detail: `access_token` can't be left empty; an empty value makes rclone report `token expired and there's no refresh token`, because it sees an empty access_token and treats the whole token structure as invalid.)

### 6.2 nginx `sites-enabled` isn't necessarily a symlink

Unrelated to backups, but this one turned "Google's brand review won't pass" into six extra hours — worth writing down because it's easy to miss.

**Symptom**: the review reported "your home page is behind a login page", "app name doesn't match", and "privacy policy lacks sufficient content", while my curl showed 200, a correct `<h1>`, and enough text. Every reported error contradicted the measured state.

The investigation found the bare path returning 502:

```bash
for u in "https://example.com/oauth/" "https://example.com/oauth"; do
  printf '%-40s ' "$u"
  curl -s -o /dev/null -w 'code=%{http_code}\n' "$u"
done
```
```
https://example.com/oauth/    code=200
https://example.com/oauth     code=502    <- here
```

`location /oauth/` only matches the trailing-slash form, so the bare path fell through to `location /`. Adding `location = /oauth` fixed it.

**But that wasn't the whole story.** Checking the loaded config:

```bash
$ sudo nginx -T 2>/dev/null | grep -E '^# configuration file'
# configuration file /etc/nginx/sites-enabled/mysite:
# configuration file /etc/nginx/sites-enabled/mysite.bak-0204:      <- also loaded
# configuration file /etc/nginx/sites-enabled/mysite.bak-20260930:  <- also loaded
```

Two findings:

**First**: `include /etc/nginx/sites-enabled/*;` uses glob expansion (nginx's docs describe include as accepting a `mask`), so every non-hidden file in the directory loads — including `.bak`. Old config and backups were active simultaneously.

**Second**, and the part that actually cost me the time:

```bash
$ ls -la /etc/nginx/sites-enabled/mysite
-rw-r--r-- 1 root root 13047 /etc/nginx/sites-enabled/mysite
```

**It is not a symlink** — it's an ordinary file. And I had been editing `/etc/nginx/sites-available/mysite`. They're independent copies; changing one has no effect on the other. `nginx -t` passed every time and `systemctl reload nginx` succeeded every time, **on a file that wasn't being served at all.**

Worth noting: the `sites-available` / `sites-enabled` split is a **Debian / Ubuntu packaging convention**. Upstream nginx only ships `conf.d/*.conf`. The two directory names are bound by convention, not by the filesystem — a `cp` where an `ln -s` belonged silently breaks that binding.

**The correct fix** (my blog's first draft suggested switching to `include sites-available/*.conf`, which is wrong — that would load every draft config):

```bash
# 1. find files that aren't symlinks
find /etc/nginx/sites-enabled/ -maxdepth 1 -type f ! -type l -print

# 2. tighten the include glob to *.conf
#    include /etc/nginx/sites-enabled/*.conf;

# 3. clean up .bak files
find /etc/nginx/sites-enabled/ -type f ! -name '*.conf' -print
```

**Lesson: confirm which file is live before editing nginx.**

```bash
sudo nginx -T 2>/dev/null | grep -E '^# configuration file'
ls -la /etc/nginx/sites-enabled/
```

---

## 7. Where it ended up

```
VPS   gdrive:backup/vps      5.94 GB   110,728 files
home  gdrive:backup/local   12.87 GB   137,221 files
cron  05:30 daily, with token preflight and failure alerts
```

Roughly eight hours for the initial run (18G, 130k files), tens of MB per day after that.

Both traps in one line each:

1. **Don't hand-inject Google's raw token JSON into `rclone.conf`** — use `rclone authorize`, which converts `expires_in` into `expiry` for you. Skip that and rclone's `timeToExpiry()` treats the zero value as "95 years", so it never refreshes and starts returning 401 after an hour.
2. **Run `nginx -T` before editing** — files in `sites-enabled` may not be symlinks, and `include *` loads `.bak` files too.