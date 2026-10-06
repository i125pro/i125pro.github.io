---
title: "Backing Up Linux Servers to Google Drive with rclone: Three Gotchas That Cost Me Two Days"
lang: en
permalink: /en/2026/10/06/vps-backup-to-google-drive-rclone/
description: "Backing up two Linux machines (a VPS and a home server) to Google Drive. What actually blocked me wasn't the configuration but three counter-intuitive traps: Google's token JSON has no expiry field so rclone never refreshes, nginx sites-enabled isn't necessarily a symlink, and rclone's shared client_id is being retired in 2026. Complete reproducible scripts."
keywords: ["rclone backup", "Google Drive backup", "VPS backup", "OAuth refresh_token", "rclone 401", "Google Drive API", "nginx sites-enabled", "linux backup script", "backup to google drive"]
mermaid: true
---

# Backing Up Linux Servers to Google Drive with rclone

I wanted two Linux machines backed up to Google Drive: a 4.9G VPS running x-ui, cloudflare_temp_email and memory-tree, and a home server running two dozen Docker containers.

The configuration itself isn't hard. The rclone docs cover it. What actually cost me two days wasn't the configuration — it was three counter-intuitive traps, each of which presented error messages pointing somewhere other than the real cause.

The short version:

> **1. Google's token response has no `expiry` field, so rclone assumes it never expires, then keeps using the one-hour `access_token` and starts throwing 401 after sixty minutes.**
>
> **2. `nginx`'s `sites-enabled/xxx` is usually a symlink but it can be a plain file. I edited `sites-available` five times and none of it took effect.**
>
> **3. rclone's built-in shared `client_id` is being retired during 2026. The "just leave client_id blank" shortcut in the official docs is going away.**

Below is ordered by what you probably need: working scripts first, then the three traps, then the judgment mistake I'm most regretful of.

---

## 1. The version that actually works

If you just want something runnable, these three sections are self-contained.

### 1.1 A rclone config that survives past one hour

This is what ended up in production. The `expiry` line is not optional.

```ini
[gdrive]
type = drive
scope = drive
client_id = <your client_id>.apps.googleusercontent.com
client_secret = <your client_secret>
token = {"access_token":"stale","refresh_token":"<refresh_token>","token_type":"Bearer","expiry":"2020-01-01T00:00:00Z","scope":"https://www.googleapis.com/auth/drive"}
team_drive =
config_is_local = false
```

Two counter-intuitive details:

- `access_token` is deliberately set to the string `"stale"`. If you leave it empty, rclone considers the entire token invalid and refuses to start.
- `expiry` is deliberately set in the past (2020). That forces rclone down the refresh path every time instead of trying to reuse an already-expired `access_token`.

Why the hack is necessary is explained in [section 2](#2-trap-1-googles-token-has-no-expiry-field).

Lock down the config file:

```bash
chmod 600 ~/.config/rclone/rclone.conf
```

### 1.2 Backing up a remote VPS without staging it locally

rclone supports connection strings like `:sftp,host=...`, so it can read over SSH and write straight to the cloud with no local staging:

```bash
#!/usr/bin/env bash
# VPS -> Google Drive
set -euo pipefail

VPS_HOST=45.196.219.171
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

# without this, cron and a manual run can write the same Drive dir concurrently
exec 9>"$LOCK"
flock -n 9 || { echo "another backup is running, skip"; exit 0; }

rclone copy "$SRC/" "$DEST" "${EXCL[@]}" \
  --transfers 4 --checkers 8 --sftp-concurrency 4 \
  --stats 30s --stats-one-line
```

Those three `flock` lines deserve their own note. Without them, a cron run and a manual run overlap, and on the Drive side you see a random subset of files uploaded twice.

### 1.3 Incremental local backup (only what's expensive to recreate)

The home server had 56G in use. Backing up all of it was wasteful. The rule I settled on: **back up only what you'd have to rebuild or reconfigure by hand if it vanished.**

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
  --exclude='/var/lib/docker/overlay2/**'   # image layers, rebuildable
  --exclude='/usr/lib/**' --exclude='/usr/share/**'
)

for s in "${SOURCES[@]}"; do
  rclone copy "$s" "gdrive:backup/local$s" "${EXCL[@]}" \
    --transfers 4 --checkers 8
done
```

Excluding `overlay2` and `venv` took the local backup from 24G down to 12.8G. The important entry is `/var/lib/docker/volumes` — the databases and credentials in there genuinely have to be recreated by hand. Image layers under `overlay2` come back with a `docker pull`.

### 1.4 Scheduling and failure alerts

```bash
#!/usr/bin/env bash
set -uo pipefail
# cron's PATH does not include ~/.local/bin; without this, hermes is "command not found"
export PATH="$HOME/.local/bin:$PATH"
TARGET="telegram:<your_chat_id>"

exec 9>/tmp/daily-backup.lock
flock -n 9 || exit 0

# preflight: the token can expire while the OAuth app is still in Testing
if ! rclone lsd gdrive:backup >/dev/null 2>&1; then
  hermes send -t "$TARGET" "Backup did not run: Google token expired. Re-authorize and retry."
  exit 1
fi

~/bin/local-gdrive-backup.sh 2>&1 | tail -50
~/bin/vps-gdrive-backup.sh   2>&1 | tail -50

hermes send -t "$TARGET" "Backup complete $(date '+%F %H:%M')"
```

That `export PATH` is a small trap, but my first cron version hit it. `hermes` wasn't found, the script still exited successfully, and the only evidence was one line of `command not found` in the log.

crontab:

```bash
30 5 * * * /home/<user>/bin/daily-gdrive-backup.sh >>/tmp/daily-backup.log 2>&1
```

**On frequency**: I initially agonized over whether a daily full run made sense. Then it clicked — `rclone copy` uses size and mtime to decide what needs uploading. Walking 140,000 directory entries takes a while, but only the changed files actually transfer, typically tens of megabytes. So the real cost of a daily run is much lower than intuition suggests.

**On the 10GB daily quota**: Google Drive allows 10GB of uploads per day. The first full run at 18GB exceeds it. rclone reports a quota error rather than silently truncating, so you can spread the initial run over a few days. Daily increments of tens of MB aren't a concern.

---

## 2. Trap 1: Google's token has no `expiry` field

This was the worst one, because it makes **the error message point somewhere other than the cause**.

### Symptom

```bash
$ rclone copy ./data gdrive:backup/
# 11:52 — everything fine, files start uploading
# 12:52 — exactly one hour later:
2026/09/30 12:52:26 ERROR : bin/who: Failed to copy: couldn't list directory:
  googleapi: Error 401: Request had invalid authentication credentials.
```

**The authorization was twenty minutes old. How can the token be expired?**

### The detour I took

My first reaction was "the config is missing `client_id` / `client_secret`, so rclone can't renew." That wasn't a wrong guess — renewal does need both. But I added them and **the 401 persisted**.

Then I suspected DNS, the proxy, the Drive API enablement state, the rclone version, and eventually whether the `refresh_token_expires_in` field meant it had expired early. All wrong turns.

### The actual mechanism

OAuth has two tokens:

| token | lifetime | purpose |
|---|---|---|
| `access_token` | **1 hour** | making actual API calls |
| `refresh_token` | long-lived (permanent once published) | minting new `access_token`s |

Normal flow: `access_token` expires → exchange `refresh_token` → continue.

rclone decides whether to refresh based on an `expiry` field. The problem is **Google's token endpoint doesn't return that field**:

```json
{
  "access_token": "ya29.a0AX...",
  "expires_in": 3599,
  "refresh_token": "1//0eX...",
  "scope": "https://www.googleapis.com/auth/drive",
  "token_type": "Bearer",
  "refresh_token_expires_in": 604799
}
```

There's `expires_in` (3600 seconds) but **no `expiry`** (an absolute timestamp). With no `expiry` to read, rclone concludes "this token has no expiry time, so it's permanently valid" and never triggers a refresh — holding onto an `access_token` that stops working sixty minutes later.

At 12:52 it finally fails, and rclone can never recover on its own.

### How to confirm it

Hit Google's token endpoint directly with curl, bypassing rclone:

```bash
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

If this returns a fresh `access_token`, your `refresh_token` is fine and the problem is rclone's expiry handling — which is exactly what I hit.

### The fix

Add `expiry` by hand, set in the past, forcing rclone down the refresh path:

```python
import json, os, pathlib

tok = json.load(open("/tmp/gtok.json"))   # raw token just obtained from Google
full = {
    "access_token": "stale",                   # non-empty but bogus -> forces refresh
    "refresh_token": tok["refresh_token"],
    "token_type": "Bearer",
    "expiry": "2020-01-01T00:00:00Z",          # already past -> refresh immediately
    "scope": tok.get("scope", "drive"),
}

p = pathlib.Path.home() / ".config/rclone/rclone.conf"
p.write_text(
    "[gdrive]\ntype = drive\nscope = drive\n"
    f"client_id = {CID}\nclient_secret = {SEC}\n"
    "token = " + json.dumps(full, separators=(",", ":")) + "\n"
    "team_drive =\nconfig_is_local = false\n"
)
os.chmod(p, 0o600)
```

Verify immediately:

```bash
rclone lsd gdrive:backup                              # lists the dir => refresh works
echo ok | rclone rcat gdrive:backup/.probe && rclone cat gdrive:backup/.probe && rclone delete gdrive:backup/.probe
```

All three passing means rclone can renew on its own.

**One detail**: the script above sets `access_token` to `"stale"`, not `""`. I tried empty first and rclone reported `token expired and there's no refresh token` — reading an empty `access_token`, it treats the whole token structure as invalid and never looks at the refresh token.

---

## 3. Trap 2: nginx `sites-enabled` isn't necessarily a symlink

Unrelated to OAuth, but this one turned "Google keeps rejecting my compliance review" into six extra hours.

### Symptom

Google's brand compliance review kept reporting:

```
Your home page is behind a login page.
Your home page does not explain the purpose of your app.
The app name "myapp" does not match the app name on your home page.
```

I curled the pages myself and they were fine:

```bash
$ curl -sI https://example.com/oauth/ | head -1
HTTP/2 200
$ curl -s https://example.com/oauth/ | grep -o '<h1>.*</h1>'
<h1>myapp</h1>
```

200, no redirect, `<h1>` matching the app name. **Every reported error contradicts the actual state.**

### The investigation

I tested with and without the trailing slash:

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

The bare path 502'd. Google's crawler requests exactly that variant.

### But that wasn't the whole story

After adding `location = /oauth` the bare path returned 200, and Google reported the identical five errors anyway. Checking the loaded config revealed the real problem:

```bash
$ sudo nginx -T 2>/dev/null | grep -E '^# configuration file'
# configuration file /etc/nginx/sites-enabled/mysite:
# configuration file /etc/nginx/sites-enabled/mysite.bak-0204:      <- also loaded
# configuration file /etc/nginx/sites-enabled/mysite.bak-20260930:  <- also loaded
```

Two findings.

**First**: `include /etc/nginx/sites-enabled/*;` loads *every* file in the directory, including `.bak` backups. My old config and the backups were all active at once.

**Second**, and the reason I wasted the time:

```bash
$ ls -la /etc/nginx/sites-enabled/mysite
-rw-r--r-- 1 root root 13047 /etc/nginx/sites-enabled/mysite
```

**It's not a symlink.** An ordinary `-rw-r--r--` regular file.

And I had been editing `/etc/nginx/sites-available/mysite` the whole time. They're independent copies; editing one has no effect on the other. I made five edits, and each `nginx -t` passed and each `systemctl reload nginx` succeeded — **on a file that wasn't being served at all.**

### Lesson

Before editing nginx config, confirm which file is actually live:

```bash
# method 1: ask nginx what it loaded
sudo nginx -T 2>/dev/null | grep -E '^# configuration file'

# method 2: check for symlinks
ls -la /etc/nginx/sites-enabled/
```

If `sites-enabled/mysite` isn't a symlink pointing at `sites-available/mysite`, then those two directory names are lying to you. Worth considering `include /etc/nginx/sites-available/*.conf;` instead, which removes the confusion entirely.

As for why Google fetches the path without the trailing slash — I'm not certain whether it normalizes, but the practical requirement is clear: **compliance pages need to serve both with and without the trailing slash.**

---

## 4. Trap 3: rclone's shared client_id is being retired

The rclone docs on Google authorization say:

> If you have your own client ID you can use that, or leave client_id and client_secret blank to use rclone's shared client ID.

"Leaving them blank uses rclone's built-in shared client ID" reads like an obvious shortcut. **In 2026, that shortcut is already dying.**

rclone's own documentation now states:

> rclone's shared Google Drive client_id is being retired and will stop working during 2026.

Two problems:

1. **It's going away.** Any config built on it breaks by the end of 2026.
2. **The global quota is tiny.** Everyone using that client_id shares a 10 TPS budget, which you'll hit while uploading tens of thousands of small files.

So creating your own client_id isn't unnecessary ceremony — it's **mandatory**. Here's how:

1. [Google Cloud Console](https://console.cloud.google.com/) → create a project
2. **APIs and Services → Library** → search `Google Drive API` → Enable (easy to miss; skipping it gives you `SERVICE_DISABLED`)
3. **OAuth consent screen** → External → app name, support email, developer email
4. **Credentials → Create Credentials → OAuth client ID** → Application type: **Desktop app**
5. Put the client_id and client_secret into the rclone config

On scopes: for personal backup, `https://www.googleapis.com/auth/drive` (full) is easier than `drive.file` — `drive.file` only reaches files the app created, which restricts some rclone operations like listing and diffing existing files.

---

## 5. The judgment mistake I regret most

The biggest error in this whole investigation was **spending too long inside one assumption without checking its premise.**

My chain of assumptions:

```
401 appears
  -> assumption A: the token expired
    -> assumption A1: client_id/secret missing (I added them, 401 continued)
      -> assumption A2: the token itself is bad (I tested refresh, but never finished)
        -> assumption A3: maybe the 7-day expiry killed it early (I read expires_in)
```

At no point did I ask: **"why did it start failing exactly one hour later?"**

Had I asked that at minute five, `expires_in = 3600` would have handed me the answer. The *timing* was the strongest clue available and I treated it as noise.

If you hit `rclone 401` or unexplained OAuth failures, this order works:

```bash
# 1. Look at the timing first. "Fails immediately after auth" and "fails N hours
#    later" point at completely different things.
#    1 hour = access_token lifetime
#    7 days = refresh_token lifetime (OAuth app in Testing state)

# 2. Bypass rclone, hit Google's token endpoint directly.
#    Fresh access_token => refresh_token is fine, the problem is client-side expiry logic.

# 3. Check whether the raw token JSON even has an expiry field
python3 -c "
import json,pathlib
l=[x for x in (pathlib.Path.home()/'.config/rclone/rclone.conf').read_text().splitlines() if x.startswith('token =')][0]
print(json.loads(l.split(' = ',1)[1]).keys())"
#    No 'expiry' => you're hitting the same thing I did.
```

---

## 6. Where it ended up

```
VPS   gdrive:backup/vps      5.94 GB   110,728 files
home  gdrive:backup/local   12.87 GB   137,221 files
cron  05:30 daily, with token preflight and a Telegram alert
```

Wall time: roughly eight hours for the initial run, tens of MB per day after that.

Drive throttles noticeably on the first full upload — rclone climbed from `130 KiB/s` to `1.28 MiB/s`. That's not local bandwidth; it's Drive rate-limiting API calls for many small files (ten thousand files means ten thousand requests). So "scanning takes a while" and "only a few MB actually transferred" can both be true at once.

The three traps in one line each:

1. **Google's token has no `expiry`** — symptom is "401s start exactly one hour after authorizing"; fix is to add the field by hand.
2. **nginx `sites-enabled` isn't necessarily a symlink** — confirm the live file with `nginx -T` before editing.
3. **rclone's shared client_id dies during 2026** — build your own; don't copy the "leave it blank" shortcut.