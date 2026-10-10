---
title: "用 rclone 把 VPS 每天备份到 Google Drive"
lang: zh
permalink: /zh/:year/:month/:day/vps-backup-to-google-drive-rclone/
description: "用 rclone 把一台 VPS 和一台家用服务器每天增量备份到 Google Drive 的完整步骤，从自建 client_id 到 cron 定时和 Telegram 告警。另附两个坑：手工写入 token 导致一小时后 401，以及 nginx sites-enabled 里的文件不是符号链接。"
keywords: ["rclone备份", "Google Drive备份", "VPS备份", "rclone authorize", "rclone无头服务器", "rclone 401", "Google Drive API", "nginx sites-enabled", "Linux备份脚本", "crontab 增量备份", "rclone 自建client_id"]
mermaid: true
---

我想把两台 Linux 机器备份到 Google Drive：一台 4.9G 的小 VPS（跑着 x-ui、cloudflare_temp_email、memory-tree），一台家里的主力机（跑着二十多个 Docker 容器）。最后用 rclone 做成了每天凌晨自动增量备份、失败发 Telegram 通知。配置不难，最关键的一点：token 要用 `rclone authorize` 生成，别自己拼，否则一小时后就会报 401。下面按操作顺序写，命令都能直接复制。

## 准备

一个 Google 账号，一台能开浏览器的电脑（用来点授权），以及 VPS 的 SSH 访问权。

## 第一步：申请自己的 client_id

client_id 是 rclone 访问你云盘时用的"应用身份证"。rclone 自带的公共 client_id 今年要停用，[官方文档](https://rclone.org/drive/)原话：

> The shared client_id is being retired and will stop working during 2026, so creating your own is now strongly recommended.

1. 打开 [Google Cloud Console](https://console.cloud.google.com/)，新建一个项目。
2. **APIs and Services → Library**，搜 `Google Drive API`，点 **Enable**。最容易漏，漏了会报 `Error 403: googleapi: Error 403: ... SERVICE_DISABLED`。
3. **OAuth consent screen**（授权时看到的确认页）选 External，填应用名和两个邮箱。
4. **Credentials → Create Credentials → OAuth client ID**，Application type 选 **Desktop app**。
5. 记下 `client_id` 和 `client_secret`。

个人自用（少于 100 个用户）不用过 Google 审核，应用停在 Testing 状态即可，授权页提示"Google 尚未验证此应用"时点 **高级 → 继续前往**。Testing 的唯一影响是 token 可能有期限：我拿到的带着 `refresh_token_expires_in: 604799`，即 7 天。发布到 Production 后这个字段就没了。

## 第二步：在本地电脑上拿 token

OAuth 授权后 Google 给两样东西：`access_token` 是临时门票，一小时过期；`refresh_token` 是会员卡，随时能换新门票。rclone 会自己换。服务器没有浏览器，所以授权在本地电脑上做：

```bash
# 在你的本地电脑上执行（不是服务器）
rclone authorize "drive" "<client_id>" "<client_secret>"
```

在浏览器打开它打印的链接并同意，终端会输出一段 JSON：

```json
{
  "access_token": "ya29.a0AX...",
  "token_type": "Bearer",
  "refresh_token": "1//0eXxxxxx",
  "expiry": "2026-10-06T12:34:56.000000000+08:00",
  "scope": "https://www.googleapis.com/auth/drive"
}
```

整段存好。注意 `expiry` 字段，坑一会讲它为什么要紧。

## 第三步：在服务器上配置 rclone

```bash
mkdir -p ~/.config/rclone && chmod 700 ~/.config/rclone
rclone config      # 选 n 新建 → 名字填 gdrive → 类型选 drive → 按提示粘贴上面的 JSON
chmod 600 ~/.config/rclone/rclone.conf
```

或者直接手写配置文件：

```ini
[gdrive]
type = drive
scope = drive
client_id = <你的 client_id>.apps.googleusercontent.com
client_secret = <你的 client_secret>
token = <第二步拿到的整段 JSON>
team_drive =
config_is_local = false
```

权限必须是 600，里面的 refresh_token 能读写整个云盘。scope（授权范围）用 `drive`；`drive.file` 只能看到应用自己建的文件，rclone 列目录、比对文件会受限。验证：

```bash
rclone lsd gdrive:
rclone about gdrive:      # 看剩余空间和已用量
```

## 第四步：备份 VPS，不经过本机磁盘

rclone 能通过 SFTP（走 SSH 的文件传输）从 VPS 边读边传，不落盘。我的 VPS 只剩 743M，这点很关键。前提是配好 SSH 密钥免密登录（SFTP 默认开启）。

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

# 没有这行，cron 和手动触发会同时写同一个 Drive 目录
exec 9>"$LOCK"
flock -n 9 || { echo "another backup is running, skip"; exit 0; }

rclone copy "$SRC/" "$DEST" "${EXCL[@]}" \
  --transfers 4 --checkers 8 --sftp-concurrency 4 \
  --stats 30s --stats-one-line
```

`flock` 是文件锁，上次没跑完就跳过。排除的是读不了的虚拟目录、临时文件、能重建的日志和包缓存，以及 `node_modules`、`.npm`、`.cache`（`npm install` 就回来），后三类在我的 VPS 上约 165M。

## 第五步：备份本机，只备丢了就得重做的东西

本机已用 56G，只备丢了就得手工重做或重配的东西：

```bash
SOURCES=(
  /home/<user>            # 项目、脚本、配置、SSH key、浏览器 profile
  /etc                    # nginx、防火墙、面板配置、systemd unit
  /opt                    # 自建服务的代码
  /usr/local/x-ui         # 面板的数据库
  /var/lib/docker/volumes # 容器数据（数据库、凭证）
)

EXCL=(
  --exclude='**/venv/**' --exclude='**/.venv/**'
  --exclude='**/.cache/**' --exclude='**/node_modules/**'
  --exclude='**/.gradle/**' --exclude='**/go/pkg/**'
  --exclude='/var/lib/docker/overlay2/**'   # 镜像层，docker pull 就能回来
  --exclude='/usr/lib/**' --exclude='/usr/share/**'
)

for s in "${SOURCES[@]}"; do
  [ -e "$s" ] || continue
  rclone copy "$s" "gdrive:backup/local$s" "${EXCL[@]}" \
    --transfers 4 --checkers 8
done
```

排掉 `overlay2` 和 `venv` 后，从 24G 降到 12.8G。`/var/lib/docker/volumes` 千万别排除，容器的数据库和凭证都在里面。

## 第六步：每天定时跑，失败发通知

两个脚本存为 `~/bin/vps-gdrive-backup.sh` 和 `~/bin/local-gdrive-backup.sh`，再写个总脚本：

```bash
#!/usr/bin/env bash
set -uo pipefail
export PATH="$HOME/.local/bin:$PATH"   # cron 的 PATH 不含用户 bin 目录
TG_TOKEN="<your-bot-token>"
TG_CHAT="<your-chat-id>"

notify() {   # 换成任何通知渠道都行，这里用 Telegram Bot API
  curl -s -X POST "https://api.telegram.org/bot$TG_TOKEN/sendMessage" \
    -d chat_id="$TG_CHAT" --data-urlencode "text=$1" > /dev/null
}

exec 9>/tmp/daily-backup.lock
flock -n 9 || exit 0

# 预检：token 可能因为 OAuth 应用状态或撤销而过期
if ! rclone lsd gdrive:backup >/dev/null 2>&1; then
  notify "备份未执行：Google token 失效。用 rclone authorize 重新授权。"
  exit 1
fi

~/bin/local-gdrive-backup.sh 2>&1 | tail -50
~/bin/vps-gdrive-backup.sh   2>&1 | tail -50

notify "备份完成 $(date '+%F %H:%M')
VPS $(rclone size gdrive:backup/vps | tail -1)
本机 $(rclone size gdrive:backup/local | tail -1)"
```

crontab，每天 05:30：

```bash
30 5 * * * /home/<user>/bin/daily-gdrive-backup.sh >>/tmp/daily-backup.log 2>&1
```

- 每天跑不贵。`rclone copy` 靠文件大小和修改时间找变化，扫 14 万个目录项要十几分钟，实际只传几十 MB。
- 小文件多会很慢。Drive 限制每秒请求数，十万个文件就是十万次请求。我实测从 `130 KiB/s` 爬到 `1.28 MiB/s`，瓶颈在 Drive，不在带宽。
- 日常增量碰不到配额。首次全量如果撞上，rclone 会明确报配额错误而不是悄悄少传，隔天再跑会接着传。

## 坑一：自己拼的 token，一小时后开始 401

我一开始没用 `rclone authorize`，结果上传整整一小时后开始报错：

```bash
$ rclone copy ./data gdrive:backup/
# 11:52 一切正常，开始上传
# 12:52 —— 整整一小时后：
2026/09/30 12:52:26 ERROR : bin/who: Failed to copy: couldn't list directory:
  googleapi: Error 401: Request had invalid authentication credentials.
```

当时我用 curl 加 Python 自己请求 Google 的 token 接口，把返回的原始 JSON 直接写进 `rclone.conf`。问题是这份 JSON 没有 `expiry`：按 OAuth 2.0 规范（[RFC 6749 §5.1](https://datatracker.ietf.org/doc/html/rfc6749#section-5.1)），寿命用 `expires_in`（还剩多少秒）表示，不带具体时刻。rclone 用的 Go `oauth2` 库会在拿到 token 时自己换算：

```go
// golang.org/x/oauth2/internal/token.go
Expiry: time.Now().Add(time.Duration(expiresIn) * time.Second)
```

所以 `rclone authorize` 的输出有 `expiry`，我手写的没有，rclone 读到空值。它判断何时刷新的代码（`lib/oauthutil/oauthutil.go`）：

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

空值被当作 95 年后过期，于是永不刷新，一直拿着过期门票硬闯。这是我绕开正常流程造成的，解决办法就是用 `rclone authorize` 重拿 token。

以后遇到类似 401，可以绕开 rclone 直接试试会员卡还能不能换门票：

```bash
# 绕开 rclone，直接问 Google 能不能换到新 token
RT=$(python3 -c "
import json,pathlib
l=[x for x in (pathlib.Path.home()/'.config/rclone/rclone.conf').read_text().splitlines() if x.startswith('token =')][0]
print(json.loads(l.split(' = ',1)[1])['refresh_token'])")

curl -s https://oauth2.googleapis.com/token \
  -d client_id=<你的 client_id> \
  -d client_secret=<你的 client_secret> \
  -d grant_type=refresh_token \
  -d refresh_token="$RT"
```

能拿到新 `access_token`，说明 refresh_token 没问题，毛病在 rclone 的过期判断。

我当时的救急办法是把 `expiry` 改成 `2020-01-01T00:00:00Z`、`access_token` 改成 `"stale"`，逼它刷新。能用，但别长期这么干。`access_token` 不能留空，否则 rclone 会报 `token expired and there's no refresh token`。

## 坑二：nginx 的 sites-enabled 里不一定是符号链接

这个和备份无关，但让我在过 Google 品牌审核时多耗了六小时。审核一直报"首页在登录页后面""app name 不匹配""隐私政策内容不足"，我用 curl 测却是 200、标题对、内容够长。后来发现不带尾部斜杠的路径返回 502：

```bash
for u in "https://example.com/oauth/" "https://example.com/oauth"; do
  printf '%-40s ' "$u"
  curl -s -o /dev/null -w 'code=%{http_code}\n' "$u"
done
```
```
https://example.com/oauth/    code=200
https://example.com/oauth     code=502    ← 这里
```

`location /oauth/` 只匹配带斜杠的地址，`/oauth` 落到了 `location /`。加一条 `location = /oauth` 就好。但改完一直不生效，用 `nginx -T`（打印实际加载的全部配置）一查：

```bash
$ sudo nginx -T 2>/dev/null | grep -E '^# configuration file'
# configuration file /etc/nginx/sites-enabled/mysite:
# configuration file /etc/nginx/sites-enabled/mysite.bak-0204:      ← 也在加载
# configuration file /etc/nginx/sites-enabled/mysite.bak-20260930:  ← 也在加载
```

第一个问题：`include /etc/nginx/sites-enabled/*;` 的 `*` 会加载目录下所有非隐藏文件，包括 `.bak`，新旧配置同时生效。第二个才是真正耗时间的：

```bash
$ ls -la /etc/nginx/sites-enabled/mysite
-rw-r--r-- 1 root root 13047 /etc/nginx/sites-enabled/mysite
```

它是普通文件，不是符号链接（类似快捷方式，改原文件就等于改它）。我一直改的是 `/etc/nginx/sites-available/mysite`，两份是独立副本，`nginx -t` 和 `systemctl reload nginx` 每次都成功，改的却不是在用的那个。

`sites-available` 放配置、`sites-enabled` 放链接，只是 Debian / Ubuntu 的打包约定，nginx 官方只有 `conf.d/*.conf`。当初谁用 `cp` 代替了 `ln -s`，绑定就悄悄断了。

处理办法（别改成 `include sites-available/*.conf`，那会把所有草稿都加载进来）：

```bash
# 1. 找出非符号链接的文件
find /etc/nginx/sites-enabled/ -maxdepth 1 -type f ! -type l -print

# 2. 把 include 的通配符收紧到 *.conf，只加载 .conf
#    include /etc/nginx/sites-enabled/*.conf;

# 3. 列出非 .conf 的文件（如 .bak），确认后清理
find /etc/nginx/sites-enabled/ -type f ! -name '*.conf' -print
```

收紧之后，要用的配置也得以 `.conf` 结尾才会加载，最好顺手换成指向 `sites-available` 的符号链接。以后改 nginx 前先确认哪个文件在生效：

```bash
sudo nginx -T 2>/dev/null | grep -E '^# configuration file'
ls -la /etc/nginx/sites-enabled/
```

## 最终结果

```
VPS   gdrive:backup/vps      5.94 GB   110,728 个文件
本机  gdrive:backup/local   12.87 GB   137,221 个文件
cron  每天 05:30，带 token 预检和失败告警
```

第一次全量约 8 小时（18G，13 万文件），之后每天几十 MB。
