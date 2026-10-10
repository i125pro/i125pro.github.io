---
title: "Daily VPS Backups to Google Drive with rclone"
lang: en
permalink: /en/2026/10/06/vps-backup-to-google-drive-rclone/
description: "Step-by-step setup for daily incremental backups of a VPS and a home server to Google Drive with rclone, from creating your own client_id to cron scheduling and Telegram alerts. Plus two traps: a hand-written token that starts failing with 401 after an hour, and nginx sites-enabled files that aren't symlinks."
keywords: ["rclone backup", "Google Drive backup", "VPS backup", "rclone authorize", "rclone headless", "rclone 401", "Google Drive API", "nginx sites-enabled", "linux backup script", "crontab incremental backup", "rclone own client_id"]
mermaid: true
---

I wanted two Linux machines backed up to Google Drive: a small 4.9G VPS (running x-ui, cloudflare_temp_email and memory-tree) and my main machine at home (running two dozen Docker containers). I ended up with rclone doing an incremental backup every morning and sending a Telegram message if it fails. The setup isn't hard. The one thing that matters most: generate the token with `rclone authorize` instead of building it yourself, or you'll start getting 401 errors after an hour. Steps below are in the order you run them, and every command can be copied as is.

## What you need

A Google account, a computer with a browser (for clicking through authorization), and SSH access to the VPS.

## Step 1: Create your own client_id

The client_id is the "app ID card" rclone shows when it accesses your Drive. rclone's built-in shared client_id is being shut down this year. From the [official docs](https://rclone.org/drive/):

> The shared client_id is being retired and will stop working during 2026, so creating your own is now strongly recommended.

1. Open the [Google Cloud Console](https://console.cloud.google.com/) and create a project.
2. **APIs and Services → Library**, search for `Google Drive API`, click **Enable**. This is the easiest step to miss; skip it and you get `Error 403: googleapi: Error 403: ... SERVICE_DISABLED`.
3. **OAuth consent screen** (the confirmation page you see when authorizing): choose External, fill in the app name and the two email fields.
4. **Credentials → Create Credentials → OAuth client ID**, Application type **Desktop app**.
5. Note down the `client_id` and `client_secret`.

For personal use (fewer than 100 users) you don't need Google's verification review. Leave the app in Testing; when the consent page says "Google hasn't verified this app", click **Advanced → Continue**. The only effect of Testing is that the token may have a time limit: mine came with `refresh_token_expires_in: 604799`, which is 7 days. Publishing the app to Production removes that field.

## Step 2: Get the token on your local machine

After OAuth authorization Google gives you two things: an `access_token`, which is a temporary ticket that expires in an hour, and a `refresh_token`, which is like a membership card you can trade for a new ticket any time. rclone does the trading itself. The server has no browser, so you authorize on your local machine:

```bash
# On your local machine (not the server)
rclone authorize "drive" "<client_id>" "<client_secret>"
```

Open the link it prints, approve, and the terminal prints a JSON blob:

```json
{
  "access_token": "ya29.a0AX...",
  "token_type": "Bearer",
  "refresh_token": "1//0eXxxxxx",
  "expiry": "2026-10-06T12:34:56.000000000+08:00",
  "scope": "https://www.googleapis.com/auth/drive"
}
```

Save the whole thing. Note the `expiry` field; Trap 1 explains why it matters.

## Step 3: Configure rclone on the server

```bash
mkdir -p ~/.config/rclone && chmod 700 ~/.config/rclone
rclone config      # n for new → name: gdrive → type: drive → paste the JSON above
chmod 600 ~/.config/rclone/rclone.conf
```

Or write the config file by hand:

```ini
[gdrive]
type = drive
scope = drive
client_id = <your client_id>.apps.googleusercontent.com
client_secret = <your client_secret>
token = <the whole JSON from step 2>
team_drive =
config_is_local = false
```

Permissions must be 600: the refresh_token inside can read and write your entire Drive. For scope (how much access the app gets) use `drive`. `drive.file` only sees files the app created itself, which limits rclone when it lists folders and compares files. To verify:

```bash
rclone lsd gdrive:
rclone about gdrive:      # remaining space and usage
```

## Step 4: Back up the VPS without staging it on disk

rclone can read from the VPS over SFTP (file transfer over SSH) and upload as it reads, with nothing written to disk in between. My VPS had only 743M free, so this mattered. You need SSH key login set up first (SFTP is on by default).

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

`flock` is a file lock: if the last run hasn't finished, the new one skips. The excludes are virtual system directories that can't be read anyway, temp files, logs and package caches that can be rebuilt, and `node_modules`, `.npm` and `.cache` (an `npm install` brings them back). Those last three came to about 165M on my VPS.

## Step 5: Back up the local machine, only what you'd have to redo

The local machine had 56G in use. I only back up what I'd have to recreate or reconfigure by hand if it disappeared:

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

Excluding `overlay2` and `venv` brought it from 24G down to 12.8G. Never exclude `/var/lib/docker/volumes`: that's where the containers' databases and credentials live.

## Step 6: Run it daily and alert on failure

Save the two scripts as `~/bin/vps-gdrive-backup.sh` and `~/bin/local-gdrive-backup.sh`, then write a wrapper:

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

crontab, daily at 05:30:

```bash
30 5 * * * /home/<user>/bin/daily-gdrive-backup.sh >>/tmp/daily-backup.log 2>&1
```

- A daily run is cheap. `rclone copy` uses file size and modification time to find changes. Scanning 140,000 directory entries takes ten-odd minutes, but only tens of MB actually upload.
- Lots of small files is slow. Drive limits requests per second, and 100,000 files means 100,000 requests. I watched throughput climb from `130 KiB/s` to `1.28 MiB/s`; the bottleneck is Drive, not your bandwidth.
- Daily increments won't hit the quota. If the first full upload does, rclone reports a quota error rather than silently skipping files, and the next day's run picks up where it left off.

## Trap 1: A hand-built token starts failing with 401 after an hour

At first I didn't use `rclone authorize`, and exactly one hour into an upload this started:

```bash
$ rclone copy ./data gdrive:backup/
# 11:52 — all good, uploading starts
# 12:52 — exactly one hour later:
2026/09/30 12:52:26 ERROR : bin/who: Failed to copy: couldn't list directory:
  googleapi: Error 401: Request had invalid authentication credentials.
```

I had called Google's token endpoint myself with curl and Python and written the raw JSON response straight into `rclone.conf`. That JSON has no `expiry`: under the OAuth 2.0 spec ([RFC 6749 §5.1](https://datatracker.ietf.org/doc/html/rfc6749#section-5.1)) lifetime is given as `expires_in` (seconds remaining), not as a point in time. The Go `oauth2` package rclone uses does the conversion when it receives a token:

```go
// golang.org/x/oauth2/internal/token.go
Expiry: time.Now().Add(time.Duration(expiresIn) * time.Second)
```

So the output of `rclone authorize` has `expiry`, mine didn't, and rclone read an empty value. Here's the code that decides when to refresh (`lib/oauthutil/oauthutil.go`):

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

An empty value is treated as expiring in 95 years, so it never refreshes and keeps pushing an expired ticket. I caused this by going around the normal flow; the fix is to get a new token with `rclone authorize`.

Next time you see a similar 401, bypass rclone and check directly whether the membership card can still be traded for a ticket:

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

If you get a new `access_token`, the refresh_token is fine and the problem is rclone's expiry check.

My stopgap at the time was to set `expiry` to `2020-01-01T00:00:00Z` and `access_token` to `"stale"` to force a refresh. It works, but don't leave it that way. Don't leave `access_token` empty either, or rclone reports `token expired and there's no refresh token`.

## Trap 2: Files in nginx sites-enabled aren't always symlinks

This has nothing to do with backups, but it cost me six extra hours while getting through Google's brand review. The review kept saying "home page is behind a login page", "app name doesn't match" and "privacy policy lacks sufficient content", yet curl showed 200, the right title and plenty of text. Eventually I found the path without a trailing slash returned 502:

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

`location /oauth/` only matches the address with a slash, so `/oauth` fell through to `location /`. Adding `location = /oauth` fixed it. But my edits kept not taking effect, so I checked with `nginx -T` (prints every config file nginx actually loaded):

```bash
$ sudo nginx -T 2>/dev/null | grep -E '^# configuration file'
# configuration file /etc/nginx/sites-enabled/mysite:
# configuration file /etc/nginx/sites-enabled/mysite.bak-0204:      <- also loaded
# configuration file /etc/nginx/sites-enabled/mysite.bak-20260930:  <- also loaded
```

First problem: the `*` in `include /etc/nginx/sites-enabled/*;` loads every non-hidden file in the directory, `.bak` files included, so old and new configs were live at the same time. The second problem is what actually ate the time:

```bash
$ ls -la /etc/nginx/sites-enabled/mysite
-rw-r--r-- 1 root root 13047 /etc/nginx/sites-enabled/mysite
```

It's a regular file, not a symlink (a symlink is like a shortcut: editing the original edits it too). I had been editing `/etc/nginx/sites-available/mysite`. They were two independent copies, so `nginx -t` and `systemctl reload nginx` succeeded every time while I was editing the file nginx wasn't using.

Keeping configs in `sites-available` and links in `sites-enabled` is just a Debian / Ubuntu packaging convention; upstream nginx only has `conf.d/*.conf`. Whenever someone used `cp` instead of `ln -s`, the link quietly broke.

The fix (don't switch to `include sites-available/*.conf`, which would load every draft):

```bash
# 1. find files that aren't symlinks
find /etc/nginx/sites-enabled/ -maxdepth 1 -type f ! -type l -print

# 2. tighten the include glob to *.conf
#    include /etc/nginx/sites-enabled/*.conf;

# 3. list non-.conf files (like .bak), then clean them up
find /etc/nginx/sites-enabled/ -type f ! -name '*.conf' -print
```

Once the glob is tightened, the config you actually want also has to end in `.conf` to load; while you're at it, make it a symlink to the file in `sites-available`. Before editing nginx in future, check which file is live:

```bash
sudo nginx -T 2>/dev/null | grep -E '^# configuration file'
ls -la /etc/nginx/sites-enabled/
```

## Where it ended up

```
VPS   gdrive:backup/vps      5.94 GB   110,728 files
home  gdrive:backup/local   12.87 GB   137,221 files
cron  05:30 daily, with token preflight and failure alerts
```

The first full run took about 8 hours (18G, 130k files); after that it's tens of MB a day.
