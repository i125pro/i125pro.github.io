---
title: "你的 Cloudflare 节点全挂了，但问题不在 IP"
lang: zh
permalink: /zh/:year/:month/:day/:title/
description: "10 个优选 IP 节点一夜之间全部失效。IP 没事，服务器没事，Cloudflare 也没封你。是 TLS SNI 字段里的某个字符串被 GFW 匹配到并重置了连接，换任何 IP 都救不回来。"
keywords: ["CF优选IP失效", "cloudflare 优选ip 不生效", "SNI 拦截", "SNI reset", "connection reset by peer", "cloudflare ip 被阻断", "优选IP节点全部超时", "GFW 阻断域名"]
mermaid: true
---

# 你的 Cloudflare 节点全挂了，但问题不在 IP

2026 年 9 月 30 日凌晨，我订阅里 10 个优选 IP 节点同时失效。我没动过任何配置。接下来六个小时，我把优选 IP 这个领域里几乎所有"常识"都验证成了错的。

**什么都没坏。** IP 是健康的，源站是健康的，Cloudflare 也是健康的。是 GFW 在按 SNI 里的字符串掐断连接。只要 SNI 含有 `cc.cd` 这五个字符，握手就完不成。换 IP 救不了，只有一个办法：换域名。

> 文中域名和 IP 都是占位符，真实信息已替换为 RFC 5737 文档保留段和 `.example` 域名，命令可以放心粘贴。文中的 Cloudflare IP（`198.41.x.x` 之类）是公开 anycast 基础设施，不算秘密。

## 症状

10 个节点，当天早上刚生成，分布在移动和联通两个运营商优化源上。全挂：

```bash
$ curl -v https://cdn.mydomain.example/
*   Trying 104.21.25.249:443...
* Connected to cdn.mydomain.example (104.21.25.249) port 443
*   Recv failure: Connection reset by peer
* OpenSSL SSL_connect: Connection reset by peer in connection to cdn.mydomain.example:443
curl: (35) Recv failure: Connection reset by peer
```

仔细看：**TCP 连上了，然后在 TLS 握手完成之前连接被重置。**

这个顺序就是 SNI 干预的指纹。服务器真挂了不长这样。

## 假设一：源站挂了

任何人的第一反应。换条路径直接打源站 IP：

```bash
$ curl --resolve cdn.mydomain.example:443:203.0.113.10 https://cdn.mydomain.example/
curl: (35) Recv failure: Connection reset by peer
```

RST。但源站好着呢。同一时间从源站自己走 Cloudflare 边缘 IP 访问同一个主机名，返回 `HTTP/1.1 101 Switching Protocols`。nginx 活着，ufw 放行 443，日志里什么都没有。

## 假设二：Cloudflare 封了优选 IP

合理怀疑，因为那年社区里全是 CF 要严打优选 IP 的说法。测法很简单：同一个 IP，换 SNI。

```bash
$ curl --resolve speed.cloudflare.com:443:198.41.209.164 \
    "https://speed.cloudflare.com/__down?bytes=5000000"
HTTP/1.1 200 OK

$ curl --resolve proxy.mydomain.example:443:198.41.209.164 \
    https://proxy.mydomain.example/
curl: (35) Recv failure: Connection reset by peer
```

一个 IP，两个主机名，相反的结果。Cloudflare 没封任何东西，IP 也没死。

## 假设三：换台 VPS 就好了

我有第二台机器，不同商家、不同地区。真是源站的问题，换机就能解决：

```bash
$ curl --resolve alt-server.example.org:443:198.51.100.20 https://alt-server.example.org/
curl: (35) Recv failure: Connection reset by peer
```

同样的 RST，跟那台机器毫无关系。变量从来不在服务器。

## 决定性的两行 tcpdump

猜来猜去绕了太多圈，我干脆不猜了，直接在源站盯着包，同时让客户端发一次请求：

```bash
sudo tcpdump -ni any "tcp[tcpflags] & (tcp-syn|tcp-rst) != 0 and tcp dst port 443" -vv
```

相关的包就两个，全文贴出来：

```
14:51:28.175281 ens3 In  IP 198.51.100.77.17652 > 203.0.113.10.443: Flags [S]
14:51:28.458155 ens3 In  IP 198.51.100.77.17652 > 203.0.113.10.443: Flags [R.]
```

看源地址。那个 RST 来自 `198.51.100.77`，也就是客户端自己，而且它的 ack（`486385868`）是服务端从没发过的序列号。源站一个包都没回。

客户端等 SYN-ACK 等不到，超时了，于是自己把连接重置了。

**源站没拒绝任何东西，它压根没被联系上。** 那个 SYN 在我 ISP 出口到 VPS 之间消失了。

我接着花了一个小时，在一台**一个包都没收到**的服务器上找防火墙规则。这一小时才是这件事真正的教训，后面再说。

## 锁定规则

怀疑到 SNI 过滤之后，测试设计就很简单了。固定 IP，只变主机名：

| ClientHello 里的 SNI | 结果 |
|---|---|
| `speed.cloudflare.com` | **200 OK** |
| `i.cd`、`us.ci`、`bot.cd`、`de5.net`、`cwu.cc`、`bbroot.com`、`kz.ci`、`xyz.ci`、`pc.ci` | TLS alert（包到了 Cloudflare） |
| `cc.cd` | **Connection reset** |

两种失败模式，它们的区别就是整个调查的结论。TLS alert 是 Cloudflare 回的，说明包到了、被正常处理了、没人干预。干净的 RST 说明连接在握手中途被杀了。

然后两个探测把规则钉死：

```bash
# .cd，但不是 cc.cd  →  存活
curl --resolve abc123def.cd:443:198.41.209.164 https://abc123def.cd/

# cc.cd，但这个域名根本不存在  →  reset
curl --resolve randxyz.cc.cd:443:198.41.209.164 https://randxyz.cc.cd/
```

**命中的是 `cc.cd` 这个字面子串。** 不是 `.cd` 这个 TLD，不是我的主机名，不是 IP，不是端口，就是 SNI 字段里那五个字符。

也不是端口级。同样的 reset 在 443、8443、80 端口的 Host 头上都出现。

**这正好解释了为什么 REALITY 节点一直没坏**：REALITY 借用 `www.nvidia.com` 这样的 SNI，ClientHello 里根本没有可匹配的东西。

```mermaid
flowchart LR
    A[客户端发出 SYN] --> B["SYN-ACK 始终不返回<br/>源站什么都没收到"]
    B --> C[客户端超时<br/>自己重置连接]
    C --> D[curl 报<br/>"Connection reset by peer"]

    style A fill:#1e2430,stroke:#4a5568,color:#e6e6e6
    style B fill:#3d1f1f,stroke:#a45050,color:#e6e6e6
    style C fill:#3d1f1f,stroke:#a45050,color:#e6e6e6
    style D fill:#3d1f1f,stroke:#a45050,color:#e6e6e6
```

这句报错是客户端自己的挫败，不是服务端的拒绝。把它读成"服务端拒绝"，就是我去错地方的原因。

## 为什么 TLS 分片救不了

既然是读 SNI，那最直接的对策就是藏 SNI。所有 VLESS 客户端都有 `fragment` 参数，把 ClientHello 拆成多个 TCP 段发出去，让任何一个包都不含完整域名。我早就开了。盒子自己的日志：

```
[TCP] dial 下载节点[DL|CF-CMCC-1] error: 162.159.133.16:443 connect error:
  read tcp 192.168.1.50:2738->162.159.133.16:443: connection reset by peer
```

分片开着，reset 照来。对过滤方来说重组是小儿科，跨分片匹配一样 trivial。分片能加点成本，改变不了结果。

## 换域名，改了五处

域名在 Cloudflare 代理的 VLESS 节点里是每一层都硬编码的，所以"换个域名"意味着换五个地方。其中两处把我坑得不轻。

**3x-ui 会回滚 config.json。** 我改了 `/usr/local/x-ui/bin/config.json` 然后重载，新主机名又变回 404。3x-ui 把入站配置存在 SQLite 里，每次重启都从数据库重新生成 `config.json`，我的修改每次都被静默还原。必须改 `/etc/x-ui/x-ui.db`，然后杀掉一个还占着 10086 端口的残留 xray 进程，改动才生效。

**证书是两个文件。** 我把加了新 SAN 的源站证书生成好放进去，结果拿到 `sslv3 alert handshake failure`。nginx 的 `ssl_certificate` 和 `ssl_certificate_key` 是两个独立文件，只换其中一个，握手就崩，而这个报错看起来特别像 Cloudflare 的问题。

五处改完，新旧两个主机名都返回 `101 Switching Protocols`，订阅 14 个节点，客户端代理实测 0.4 秒。旧域名还能用。

## 我浪费掉的那一小时的学费

tcpdump 是在第 90 分钟才用上的。前九十分钟我在查防火墙、读 nginx 配置、确认 ufw 规则、验证证书有效。每一步都是合理的工作，每一步都指向一台从未收到任何包的服务器。

原因值得说清楚。症状指向了一个地方，那个地方看起来还特别合理。`Connection reset by peer` 听起来像服务端拒绝，我就真的去找服务端的拒绝。这句话在"问题出在哪"上撒了谎，单看它我没有别的办法知道。

打破循环的是停下来想了一件事：**10 个同时挂掉的节点，共享什么？** 它们不共享 IP、商家、端口、配置文件。它们只共享一样东西：每一个 ClientHello 里那个主机名。当很多相似的东西同时挂掉，原因通常就是它们共享的那个东西。

## 六十秒版本

```bash
# 同一个 IP，两个 SNI 值。诊断到此为止。
curl -sS -o /dev/null -w "%{http_code}\n" --max-time 8 \
  --resolve speed.cloudflare.com:443:198.41.209.164 \
  "https://speed.cloudflare.com/__down?bytes=5000000"

curl -sS -o /dev/null -w "%{http_code}\n" --max-time 8 \
  --resolve your.domain.here:443:198.41.209.164 \
  https://your.domain.here/
```

第一个 200、第二个 reset，**问题在你的域名**。其他动作全是白费力气：换服务商、调 `-n` 和 `-dn`、等 Cloudflare "解除"一个它根本没下过的封禁。

想在动手之前先在线上确认一下：

```bash
sudo timeout 30 tcpdump -ni any \
  "tcp[tcpflags] & (tcp-syn|tcp-rst) != 0 and tcp dst port 443" -c 20
```

RST 的源地址等于客户端 IP、而且你的服务器全程没回过包，就是这个故障的签名。然后去找一个 SNI 不在名单上的域名。

## 延伸阅读

- [CloudflareSpeedTest](https://github.com/XIU2/CloudflareSpeedTest) 是个好工具，这次的问题从来不在工具
- [Great Firewall](https://en.wikipedia.org/wiki/Great_Firewall)：SNI 检查如何成为标准手段的背景
- [Deep Packet Inspection of Encrypted Traffic](https://www.usenix.org/conference/usenixsecurity20/presentation/han)：为什么分片 ClientHello 是一道减速带而不是一堵墙
