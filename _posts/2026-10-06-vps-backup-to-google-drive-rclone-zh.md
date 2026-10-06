---
title: "用 rclone 把 VPS 备份到 Google Drive：三个让我卡了两天的坑"
lang: zh
permalink: /zh/:year/:month/:day/vps-backup-to-google-drive-rclone/
description: "把两台 Linux 机器（VPS + 家目录主机）备份到 Google Drive 的完整过程。真正卡住我的不是配置，是三个反直觉的坑：Google token 没有 expiry 字段导致永久 401、nginx sites-enabled 不是符号链接导致改了五次不生效、以及 rclone 内置 client_id 已在 2026 年淘汰。附可复现的完整脚本。"
keywords: ["rclone备份", "Google Drive备份", "VPS备份", "OAuth refresh_token", "rclone 401", "Google Drive API", "nginx sites-enabled", "Linux备份脚本", "Google云盘备份"]
mermaid: true
---

我想把两台 Linux 机器备份到 Google Drive：一台 4.9G 的 VPS（跑着 x-ui、cloudflare_temp_email、memory-tree），一台家里的主力机（跑着二十多个 Docker 容器）。

配置本身不难，`rclone` 文档写得清清楚楚。但真正卡住我的不是配置，是三个反直觉的坑——每一个都表现为「错误信息和真实原因完全无关」。

先把结论放这儿：

> **1. Google 返回的 token JSON 没有 `expiry` 字段，rclone 会认为它永不过期，然后一直用那个只活 1 小时的 `access_token`，1 小时后开始刷 401。**
>
> **2. `nginx` 的 `sites-enabled/xxx` 通常是符号链接，但它可以不是。我改了五次 `sites-available`，一次都没生效。**
>
> **3. rclone 内置的公共 `client_id` 正在 2026 年内停用。别再用官方文档里那条「留空 client_id」的捷径了。**

下面按「你可能正需要什么」排：先给能直接跑的脚本，再讲三个坑，最后是我最后悔的判断失误。

---

## 一、直接能跑的版本

如果你只想抄走能用的东西，这三段就够了。

### 1.1 一个真的能用的 rclone 配置

这是我最后落到实地的配置，注意 `expiry` 那行——它不是可选项。

```ini
[gdrive]
type = drive
scope = drive
client_id = <你的 client_id>.apps.googleusercontent.com
client_secret = <你的 client_secret>
token = {"access_token":"stale","refresh_token":"<refresh_token>","token_type":"Bearer","expiry":"2020-01-01T00:00:00Z","scope":"https://www.googleapis.com/auth/drive"}
team_drive =
config_is_local = false
```

两个反直觉的点：

- `access_token` 故意填字符串 `"stale"`。留空的话 rclone 会判定整个 token 无效，直接拒绝启动。
- `expiry` 故意写过去的时间（2020 年）。这逼 rclone 每次都走 refresh 路径，而不是试图复用那个已经过期的 `access_token`。

为什么需要这么 hack，原因见[第二节](#二坑-1google-的-token-没有-expiry-字段)。

配置文件权限记得设 `600`：

```bash
chmod 600 ~/.config/rclone/rclone.conf
```

### 1.2 备份远端 VPS（不落本机磁盘）

`rclone` 支持 `:sftp,host=...` 这种连接串，可以直接从 SSH 读远端、写到云端，中间不落盘：

```bash
#!/usr/bin/env bash
# VPS -> Google Drive，配置直接放数组里，跑起来只要一行 rclone
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

# ponytail: 没有这行，两个进程会同时写同一个 Drive 目录
exec 9>"$LOCK"
flock -n 9 || { echo "another backup is running, skip"; exit 0; }

rclone copy "$SRC/" "$DEST" "${EXCL[@]}" \
  --transfers 4 --checkers 8 --sftp-concurrency 4 \
  --stats 30s --stats-one-line
```

`flock` 那三行值得单独说：如果你同时有 cron 和手动触发，没有它会跑出两个 rclone 同时写同一个目录，Drive 侧的表现是随机的一批文件重复上传。

### 1.3 本机增量备份（只备不可再生的）

本机 56G 已用，直接全传太浪费。原则是**只备丢了就得重新做/重新配的东西**：

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
  --exclude='/var/lib/docker/overlay2/**'   # 镜像层，可重建
  --exclude='/usr/lib/**' --exclude='/usr/share/**'
)

for s in "${SOURCES[@]}"; do
  rclone copy "$s" "gdrive:backup/local$s" "${EXCL[@]}" \
    --transfers 4 --checkers 8
done
```

`overlay2` 和 `venv` 排除掉之后，本机从 24G 降到 12.8G。最重要的是 `/var/lib/docker/volumes`——容器里那些数据库和凭证丢了是真的得重新配，`overlay2` 里的镜像层 `docker pull` 一下就回来了。

### 1.4 定时 + 失败通知

```bash
#!/usr/bin/env bash
set -uo pipefail
# ponytail: cron 的 PATH 不含 ~/.local/bin，之前 hermes 报 command not found
export PATH="$HOME/.local/bin:$PATH"
TARGET="telegram:<your_chat_id>"

exec 9>/tmp/daily-backup.lock
flock -n 9 || exit 0

# 预检：token 可能因为 OAuth 应用还在 Testing 状态而过期
if ! rclone lsd gdrive:backup >/dev/null 2>&1; then
  hermes send -t "$TARGET" "备份未执行：Google token 失效。重新授权后重跑。"
  exit 1
fi

~/bin/local-gdrive-backup.sh 2>&1 | tail -50
~/bin/vps-gdrive-backup.sh   2>&1 | tail -50

hermes send -t "$TARGET" "备份完成 $(date '+%F %H:%M')"
```

那个 `export PATH` 是个很小的坑，但我第一次写 cron 时踩了：TG 通知里的 `hermes` 找不到，脚本却显示成功退出，日志里只有一行 `command not found`。

crontab：

```bash
30 5 * * * /home/<user>/bin/daily-gdrive-backup.sh >>/tmp/daily-backup.log 2>&1
```

**关于频率的选择**：我一开始纠结"要不要每日全量"。后来想明白了——`rclone copy` 靠文件大小和 mtime 判断是否需要上传，扫 14 万个文件目录要十几分钟，但实际传输的只有变化的部分（通常几十 MB）。所以每日跑的实际成本远低于直觉，值得。

**关于 10GB 上传配额**：Google Drive 每天 10GB 上传上限。首次全量 18GB 会超，但 `rclone` 遇到配额错误会报错而不是静默截断，分几天传完就行。日常增量几十 MB，完全不用担心。

---

## 二、坑 1：Google 的 token 没有 `expiry` 字段

这是最坑的一个，因为它让**错误信息完全指错了方向**。

### 症状

```bash
$ rclone copy ./data gdrive:backup/
# 11:52 一切正常，文件开始上传
# 12:52 —— 整整一小时后，开始刷：
2026/09/30 12:52:26 ERROR : bin/who: Failed to copy: couldn't list directory:
  googleapi: Error 401: Request had invalid authentication credentials.
```

**授权明明是 20 分钟前刚做的，token 怎么会过期？**

### 我走的弯路

我的第一反应是「配置文件里少了 `client_id` / `client_secret`，rclone 没法续期」。这个判断不算错——续期确实需要这两个字段。但我把它们加进去之后，**401 依然存在**。

然后我开始怀疑 DNS、怀疑代理、怀疑 Drive API 状态、怀疑 rclone 版本，甚至去查了 `refresh_token_expires_in` 是不是 7 天到期所以提前失效了。一路错下去。

### 真正的机制

OAuth 有两种 token：

| token | 寿命 | 作用 |
|---|---|---|
| `access_token` | **1 小时** | 实际调 API 用 |
| `refresh_token` | 长期（发布后永久） | 换新的 `access_token` |

正常逻辑是：`access_token` 过期 → 用 `refresh_token` 换一个 → 继续。

rclone 靠 `expiry` 字段判断要不要换。问题是 **Google 的 token 接口返回的 JSON 里没有这个字段**：

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

有 `expires_in`（3600 秒），但**没有 `expiry`**（绝对时间戳）。rclone 读不到 `expiry`，就认为「这个 token 没有过期时间，那就是永久有效」，于是从不触发 refresh，一直拿那个 1 小时后就已经失效的 `access_token` 硬用。

到 12:52 它终于过期了，而且 rclone 永远不会自己恢复。

### 验证方法

用 curl 直接打 Google 的 token 端点，绕开 rclone 看真实返回：

```bash
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

如果这一步返回了新的 `access_token`，说明 refresh_token 是好的，问题在 rclone 的过期判断——也就是我遇到的这个。

### 修复

手工补上 `expiry`，写成过去的时间，强制 rclone 走 refresh 路径：

```python
import json, os, pathlib

tok = json.load(open("/tmp/gtok.json"))   # 刚从 Google 换来的原始 token
full = {
    "access_token": "stale",                   # 非空但无效 → 逼它去 refresh
    "refresh_token": tok["refresh_token"],
    "token_type": "Bearer",
    "expiry": "2020-01-01T00:00:00Z",          # 已经过去 → 立即过期
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

修完立刻验证：

```bash
rclone lsd gdrive:backup                              # 能列出目录 = refresh 成功
echo ok | rclone rcat gdrive:backup/.probe && rclone cat gdrive:backup/.probe && rclone delete gdrive:backup/.probe
```

三个都过，就说明 rclone 已经能自己续期了。

**注意**：上面脚本里 `access_token` 写的是 `"stale"` 而不是 `""`。我一开始留空，结果 rclone 直接报 `token expired and there's no refresh token` —— 它读到空的 access_token 就认为整个 token 结构无效，连 refresh_token 都不看。

---

## 三、坑 2：nginx 的 sites-enabled 不一定是符号链接

这个坑和 OAuth 无关，但它让「Google 审核一直不过」这件事多烧了我六个小时。

### 症状

Google 的品牌合规审查反复报：

```
Your home page is behind a login page.
Your home page does not explain the purpose of your app.
The app name "myapp" does not match the app name on your home page.
```

我 curl 实测发现页面完全正常：

```bash
$ curl -sI https://example.com/oauth/ | head -1
HTTP/2 200
$ curl -s https://example.com/oauth/ | grep -o '<h1>.*</h1>'
<h1>myapp</h1>
```

200、没有跳转、标题和 app name 一致。报错和实测**逐条矛盾**。

### 排查过程

我用 curl 分别测了带尾斜杠和不带：

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

裸路径 502。Google 的抓取器请求的正是**不带尾斜杠**的版本。

### 但这不是全部原因

我加上 `location = /oauth` 之后，裸路径确实变成 200 了，可 Google 依然报同样的五条错。查生效配置才发现真正的问题：

```bash
$ sudo nginx -T 2>/dev/null | grep -E '^# configuration file'
# configuration file /etc/nginx/sites-enabled/mysite:
# configuration file /etc/nginx/sites-enabled/mysite.bak-0204:      ← 这个也在加载
# configuration file /etc/nginx/sites-enabled/mysite.bak-20260930:  ← 这个也在
```

两个发现：

**第一**，`include /etc/nginx/sites-enabled/*;` 会把目录里**所有文件**都加载，包括 `.bak` 备份文件。我的旧配置和备份同时在生效。

**第二**，也是我白白浪费时间的那个：

```bash
$ ls -la /etc/nginx/sites-enabled/mysite
-rw-r--r-- 1 root root 13047 /etc/nginx/sites-enabled/mysite
```

**它不是符号链接。** 是个独立的 `-rw-r--r--` 普通文件。

而我一直在改 `/etc/nginx/sites-available/mysite`。两个文件是各自独立的副本，改后者对前者没有任何影响。我改了五次，每次 `nginx -t` 都通过、每次 `systemctl reload nginx` 都成功——**只是完全改的是另一个文件**。

### 教训

改 nginx 配置之前，先确认真正生效的是哪个文件：

```bash
# 方法 1：看 nginx 实际加载了什么
sudo nginx -T 2>/dev/null | grep -E '^# configuration file'

# 方法 2：看是不是符号链接
ls -la /etc/nginx/sites-enabled/
```

如果 `sites-enabled/mysite` 不是指向 `sites-available/mysite` 的符号链接，那这两个目录的命名就是在骗你。此时应该考虑改用 `include /etc/nginx/sites-available/*.conf;` 而不是 `sites-enabled/*`，至少不会踩这个坑。

至于 Google 为什么抓的是不带尾斜杠的路径——我不确定它是否有某种规范化逻辑，但结论是：**合规页面要同时支持带斜杠和不带尾斜杠两种形式**。这是可复现的最低要求。

---

## 四、坑 3：rclone 内置的公共 client_id 正在被淘汰

Google 授权那一步，rclone 官方文档写的是：

> If you have your own client ID you can use that, or leave client_id and client_secret blank to use rclone's shared client ID.

「留空就用 rclone 内置的共享 client_id」——听起来是明显的捷径。**但这个捷径在 2026 年已经不成立了。**

rclone 的官方文档现在写着：

> rclone's shared Google Drive client_id is being retired and will stop working during 2026.

两个问题：

1. **它会停。** 用它建的任何配置，到 2026 年底都会失效。
2. **全局共享配额极低。** 所有用这个 client_id 的用户共享 10 TPS 的额度，你备份几万个小文件时很容易撞限流。

所以自建 client_id 不是「麻烦的过度设计」，而是**必须**。我最后是这么建的：

1. [Google Cloud Console](https://console.cloud.google.com/) → 新建项目
2. **APIs 和 Services → Library** → 搜索 `Google Drive API` → Enable（这一步不能漏，漏了会报 `SERVICE_DISABLED`）
3. **OAuth consent screen** → External → 填应用名、支持邮箱、开发者邮箱
4. **Credentials → Create Credentials → OAuth client ID** → Application type 选 **Desktop app**
5. 把 client_id 和 client_secret 填进 rclone 配置

关于 scope，个人备份用 `https://www.googleapis.com/auth/drive`（全域）比 `drive.file` 更省事——`drive.file` 只能访问应用自己创建的文件，rclone 的某些操作（比如列目录、比对已有文件）会受限。

---

## 五、我最后悔的判断：把「配置问题」和「环境问题」混在一起查

这次排查我犯的最大错误，是**在一个假设上花了太多时间，没有及时去验证它的前提**。

我的假设链是：

```
401 出现
  → 假设 A：token 过期
    → 假设 A1：client_id/secret 缺失（我加上了，401 还在）
      → 假设 A2：token 本身有问题（我去测 refresh_token，也没测到底）
        → 假设 A3：是不是 7 天过期所以提前失效了（查了 expires_in）
```

我从头到尾没有问过一个问题：**「为什么是整整一小时之后才开始失败？」**

如果我在第 5 分钟问这个问题，直接就能定位到 `expires_in = 3600`。观察到的**时间特征**是最强的线索，而我没有把它当线索用。

如果你也遇到「rclone 401 / OAuth 莫名失效」这类问题，建议的排查顺序是：

```bash
# 1. 先看时间特征。是「授权后立刻失败」还是「N 小时后失败」？
#    一小时 = access_token 寿命
#    七天 = refresh_token 寿命（Testing 状态的 OAuth 应用）

# 2. 绕开 rclone，直接打 Google 的 token 端点
#    能换到新 token = refresh_token 没问题，问题在客户端的过期判断

# 3. 看原始 token JSON 里有没有 expiry 字段
python3 -c "
import json,pathlib
l=[x for x in (pathlib.Path.home()/'.config/rclone/rclone.conf').read_text().splitlines() if x.startswith('token =')][0]
print(json.loads(l.split(' = ',1)[1]).keys())"
#    没有 'expiry' = 你和我遇到了同一个问题
```

---

## 六、最后的状态

```
VPS   gdrive:backup/vps      5.94 GB   110,728 个文件
本机  gdrive:backup/local   12.87 GB   137,221 个文件
cron  每天 05:30，带 token 预检和 TG 通知
```

驱动：约 8 小时（首轮），增量每天几十 MB。

第一次全量上传 Drive 限速很明显——`rclone` 报 `130 KiB/s` → `1.28 MiB/s` 逐步爬升。这不是本地带宽的问题，是 Drive 对大量小文件的 API 调用限流（一万个文件就是一万次请求）。所以「扫目录耗时十几分钟」和「实际传输只有几十 MB」是可以同时成立的。

三个坑的复现要点：

1. **Google token 缺 `expiry`** — 症状是「授权后正好一小时开始刷 401」，修复是手工补 `expiry` 字段
2. **nginx sites-enabled 不一定是符号链接** — 先 `nginx -T` 确认生效文件，再动手
3. **rclone 公共 client_id 2026 年内停用** — 必须自建，别抄文档里的留空捷径