---
title: "用 rclone 把 VPS 备份到 Google Drive：完整可复现流程"
lang: zh
permalink: /zh/:year/:month/:day/vps-backup-to-google-drive-rclone/
description: "把 VPS 和家目录主机备份到 Google Drive 的完整可复现流程：自建 client_id、无头服务器授权、增量同步、cron 定时与失败告警。附两个真实踩过的坑及其根因分析——手工注入 token 导致无法续期、nginx sites-enabled 里的文件不一定是符号链接。"
keywords: ["rclone备份", "Google Drive备份", "VPS备份", "rclone authorize", "rclone无头服务器", "rclone 401", "Google Drive API", "nginx sites-enabled", "Linux备份脚本", "crontab 增量备份", "rclone 自建client_id"]
mermaid: true
---

我想把两台 Linux 机器备份到 Google Drive：一台 4.9G 的 VPS（跑着 x-ui、cloudflare_temp_email、memory-tree），一台家里的主力机（跑着二十多个 Docker 容器）。

rclone 的文档写得清楚，配置本身不难。这篇文章按**你实际会执行的顺序**给出所有步骤，从申请 client_id 到 cron 定时，每一步都能复制就跑。

文章的最后一节写了我真正栽跟头的两个地方，以及它们的根因——包括一个我一开始归因完全错误的 bug。

**前置条件**

```
1. 一个 Google 账号
2. 一台能开浏览器的电脑（本地笔记本即可，用来完成 OAuth 授权）
3. 目标机器的 SSH 访问权（备份 VPS 时需要）
```

---

## 0. 申请自己的 client_id（先做这步，因为在控制台里最花时间）

2026 年必须自建。rclone 官方文档原文：

> The shared client_id is being retired and will stop working during 2026, so creating your own is now strongly recommended.

（我在 [rclone.org/drive/](https://rclone.org/drive/) 上确认了这句话在三个地方出现，包括 `--drive-client-id` 参数说明。）

**流程：**

1. [Google Cloud Console](https://console.cloud.google.com/) → 新建项目
2. **APIs and Services → Library** → 搜索 `Google Drive API` → **Enable**
   - 这步最容易漏。漏了会在调用时报 `Error 403: googleapi: Error 403: ... SERVICE_DISABLED`
3. **OAuth consent screen** → External → 填应用名、支持邮箱、开发者邮箱
4. **Credentials → Create Credentials → OAuth client ID** → Application type 选 **Desktop app**
5. 记下 `client_id` 和 `client_secret`

**关于审核**：个人自用（少于 100 用户）**不需要通过 Google 的验证审核**。OAuth 应用保持在 Testing 状态就能授权，只会在授权页顶部显示「Google 尚未验证此应用」，点 **高级 → 继续前往** 即可。

Testing 状态唯一的实际影响是：`refresh_token` 可能带一个有效期字段，我拿到的那个是 `refresh_token_expires_in: 604799`（7 天）。发布到 Production 后这个字段消失，token 变永久。你自己决定要不要折腾发布。

---

## 1. 拿 token（无头服务器的标准做法）

服务器上没有浏览器，所以这一步要用 rclone 提供的 `authorize` 命令 —— **在本地能开浏览器的机器上跑**，而不是在服务器上。

```bash
# 在你的本地电脑上执行（不是服务器）
rclone authorize "drive" "<client_id>" "<client_secret>"
```

命令会打印一个 URL，在浏览器里打开完成授权，然后终端里输出一大段 JSON。它长这样：

```json
{
  "access_token": "ya29.a0AX...",
  "token_type": "Bearer",
  "refresh_token": "1//0eXxxxxx",
  "expiry": "2026-10-06T12:34:56.000000000+08:00",
  "scope": "https://www.googleapis.com/auth/drive"
}
```

**把这整段 JSON 留好**，下一步要用。

> ⚠️ 如果你想在服务器上用 curl 直接调 Google 的 token 接口，需要自己处理这个 JSON —— 那条路会踩坑，见第 6 节。用 `rclone authorize` 就没这个问题。

---

## 2. 服务器上的 rclone 配置

```bash
mkdir -p ~/.config/rclone && chmod 700 ~/.config/rclone
rclone config      # 选 n 新建 → 名字填 gdrive → 类型选 drive → 按提示粘贴上面的 JSON
chmod 600 ~/.config/rclone/rclone.conf
```

或者直接手写配置文件（`rclone config` 生成的等价物）：

```ini
[gdrive]
type = drive
scope = drive
client_id = <你的 client_id>.apps.googleusercontent.com
client_secret = <你的 client_secret>
token = <第 1 步拿到的整段 JSON>
team_drive =
config_is_local = false
```

**权限必须是 600** —— 里面有能读写你整个云盘的 refresh_token。

**关于 scope**：个人备份用 `drive`（全域）。`drive.file` 只能访问该应用自己创建的文件，rclone 列举目录和比对已有文件时会受限。

**验证**：

```bash
rclone lsd gdrive:
rclone about gdrive:      # 看剩余空间和已用量
```

---

## 3. 备份远端 VPS（不落本机磁盘）

rclone 支持 `:sftp,host=...` 连接串，可以从 SSH 直接读远端、写到云端，中间不落盘 —— VPS 磁盘只剩 743M 的时候这个很关键。

前提：VPS 上已配置好 SSH 公钥免密登录，且 sshd 支持 SFTP 子系统（默认支持）。

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

排除项的逻辑：虚拟文件系统（不可读）、临时文件、日志和包缓存（可重建）、以及 `node_modules` / `.npm` / `.cache`（`npm install` 就能回来）。VPS 上这三类加起来约 165M。

---

## 4. 本机增量备份（只备不可再生的）

我本机 56G 已用。原则是**只备丢了就得重新做或重新配的东西**：

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

排掉 `overlay2` 和 `venv` 之后，本机从 24G 降到 12.8G。

`/var/lib/docker/volumes` 是最不能排除的一项 —— 里面那些数据库和凭证丢了是真的得重新配。`overlay2` 里的镜像层 `docker pull` 一下就回来了。

---

## 5. 定时 + 失败告警

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

crontab：

```bash
30 5 * * * /home/<user>/bin/daily-gdrive-backup.sh >>/tmp/daily-backup.log 2>&1
```

**关于频率**：`rclone copy` 靠文件大小和 mtime 判断要传什么，扫 14 万个目录项要十几分钟，但实际传输只有变化的部分（通常几十 MB）。每日跑的实际成本比直觉低得多。

**关于速度**：Drive 对大量小文件的 API 调用有限流。我实测速率从 `130 KiB/s` 爬到 `1.28 MiB/s` —— 这不是本地带宽，是 Drive 的 QPS 限制（十万个文件就是十万次请求）。所以「扫目录很久」和「实际只传了几十 MB」可以同时成立。

**关于配额**：上传额度因账号类型而异，不是一个固定的小数字。日常增量几十 MB 完全不用担心。首轮 18G 确实超出了一般个人账号的日额度，分几天传完就行（rclone 会报配额错误而不是静默截断）。

---

## 6. 我真正栽跟头的两个地方

前面五步顺利的话你不会碰到这两个。但我遇到了，所以写下来。

### 6.1 手工注入 token 导致无法续期

**症状**

```bash
$ rclone copy ./data gdrive:backup/
# 11:52 一切正常，开始上传
# 12:52 —— 整整一小时后：
2026/09/30 12:52:26 ERROR : bin/who: Failed to copy: couldn't list directory:
  googleapi: Error 401: Request had invalid authentication credentials.
```

**为什么会这样**

我在无头服务器上没法跑 `rclone authorize`，于是用 curl + Python 自己请求 Google 的 token 接口，然后把返回的原始 JSON 直接写进 `rclone.conf`。

问题出在两段代码之间的**契约**：

OAuth 2.0 规范（[RFC 6749 §5.1](https://datatracker.ietf.org/doc/html/rfc6749#section-5.1)）规定 token 响应用 `expires_in`（相对秒数）表示寿命，**不包含绝对时间戳**。Google 严格遵守这个规范。

而 rclone 用的是 Go 的 `oauth2` 库，它在拿到 token 时会自己算：

```go
// golang.org/x/oauth2/internal/token.go
Expiry: time.Now().Add(time.Duration(expiresIn) * time.Second)
```

也就是说，**`rclone authorize` 生成的 JSON 里是有 `expiry` 字段的**，因为 rclone 在写文件前已经算好了。我手工灌进去的原始 JSON 没有这个字段，rclone 读到零值 `time.Time{}`。

rclone 判断要不要刷新的逻辑（`lib/oauthutil/oauthutil.go`）：

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

零值 → 返回 95 年 → 刷新定时器设成 95 年 → **永不刷新**。它就一直拿着那个一小时后就失效的 `access_token` 硬用。

源码里的注释 `// ~95 years` 就是「永不过期」的白纸黑字表述。

**所以这不是 Google 的 bug，也不是 rclone 的 bug，是我用非标准方式注入数据造成的。** 正确做法就是第 1 节的 `rclone authorize`。

**验证方法**（以后遇到类似的 401 可以先跑这个）

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

能换到新的 `access_token` → refresh_token 是好的，问题在客户端的过期判断。

**顺便说一个我一开始的应急 hack**：我手工把 `expiry` 写成 `2020-01-01T00:00:00Z`、`access_token` 写成字符串 `"stale"`，强制它走刷新路径。这确实能跑通，但**不要用在生产** —— 那是给非标准注入数据打的补丁，正确解法是用 `rclone authorize` 重新拿一份。（另一个细节：`access_token` 不能留空，留空 rclone 会报 `token expired and there's no refresh token`，因为它读到空 access_token 就认为整个 token 结构无效。）

### 6.2 nginx `sites-enabled` 里的文件不一定是符号链接

这个和备份无关，但它让「Google 品牌审核一直不通过」多烧了六个小时 —— 记下来是因为它足够隐蔽。

**症状**：审核页面报「首页在登录页后面」「app name 不匹配」「隐私政策内容不足」，但我 curl 实测 200、标题正确、内容够长。报错和实测逐条矛盾。

排查后发现裸路径返回 502：

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

`location /oauth/` 只匹配带尾斜杠的，裸路径落到 `location /` 上。加上 `location = /oauth` 就好了。

**但这不是全部原因。** 查生效配置发现：

```bash
$ sudo nginx -T 2>/dev/null | grep -E '^# configuration file'
# configuration file /etc/nginx/sites-enabled/mysite:
# configuration file /etc/nginx/sites-enabled/mysite.bak-0204:      ← 也在加载
# configuration file /etc/nginx/sites-enabled/mysite.bak-20260930:  ← 也在加载
```

两个发现：

**第一**：`include /etc/nginx/sites-enabled/*;` 用 glob 展开（nginx 文档说 include 支持 `mask` 通配），目录里所有非隐藏文件都会被加载 —— 包括 `.bak`。旧配置和备份同时生效。

**第二**，也是真正浪费我时间的：

```bash
$ ls -la /etc/nginx/sites-enabled/mysite
-rw-r--r-- 1 root root 13047 /etc/nginx/sites-enabled/mysite
```

**它不是符号链接**，是普通文件。而我一直在改 `/etc/nginx/sites-available/mysite`。两个独立的副本，改一个对另一个没有任何影响 —— `nginx -t` 每次通过，`systemctl reload nginx` 每次成功，**只是完全改的是另一个文件**。

需要说明的是：`sites-available` / `sites-enabled` 这套约定是 **Debian / Ubuntu 的打包惯例**，nginx 官方配置里只有 `conf.d/*.conf`。也就是说这两个目录名在「约定」层面绑定，在「文件系统」层面不绑定 —— 任何时候 `cp` 代替 `ln -s` 都会静默失去绑定关系。

**正确处理方式**（我博客初稿里写的「改成 `include sites-available/*.conf`」是错的，那会把所有草稿配置全量加载）：

```bash
# 1. 找出非符号链接的文件
find /etc/nginx/sites-enabled/ -maxdepth 1 -type f ! -type l -print

# 2. 把 include 的通配符收紧到 *.conf，只加载 .conf
#    include /etc/nginx/sites-enabled/*.conf;

# 3. 清理 .bak 文件
find /etc/nginx/sites-enabled/ -type f ! -name '*.conf' -print
```

**教训：改 nginx 前先确认哪个文件真正生效。**

```bash
sudo nginx -T 2>/dev/null | grep -E '^# configuration file'
ls -la /etc/nginx/sites-enabled/
```

---

## 7. 最终状态

```
VPS   gdrive:backup/vps      5.94 GB   110,728 个文件
本机  gdrive:backup/local   12.87 GB   137,221 个文件
cron  每天 05:30，带 token 预检和失败告警
```

首轮约 8 小时（18G，13 万文件），之后每天几十 MB。

两个坑一句话版：

1. **别手工往 `rclone.conf` 里塞 Google 的原始 token JSON** —— 用 `rclone authorize`，它会自己把 `expires_in` 换算成 `expiry`。少这一步，rclone 源码里 `timeToExpiry()` 会把零值当成「95 年」，于是永不刷新，一小时后开始 401。
2. **改 nginx 前先 `nginx -T`** —— `sites-enabled` 里的文件可能不是符号链接，而 `include *` 会把 `.bak` 一起加载。