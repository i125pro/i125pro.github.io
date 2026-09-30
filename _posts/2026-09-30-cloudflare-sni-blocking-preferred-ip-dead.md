---
title: "Your Cloudflare Nodes Died. It Wasn't the IPs."
lang: en
permalink: /en/:year/:month/:day/:title/
description: "Ten preferred-IP nodes died overnight. The IPs were fine, the server was fine, Cloudflare was fine. A string in the TLS SNI field was getting connections reset, and no amount of IP swapping would fix it."
keywords: ["cloudflare preferred ip", "cf preferred ip not working", "SNI reset", "SNI blocking GFW", "cloudflare ip blocked china", "vless SNI reset", "connection reset by peer cloudflare"]
mermaid: true
---

# Your Cloudflare Nodes Died. It Wasn't the IPs.

Overnight on September 30, 2026, all ten nodes in my preferred-IP subscription stopped working. I hadn't touched anything. What followed was six hours of proving that nearly everything I believed about preferred IPs was wrong.

Nothing was broken. The IPs were healthy, the origin server was healthy, Cloudflare was healthy. The GFW was resetting every TLS connection whose SNI contained the string `cc.cd`. Swapping IPs cannot fix that. Only a new domain can.

> Domains and IPs below are placeholders — real ones swapped for RFC 5737 documentation ranges and `.example` names, so the commands are safe to paste. The Cloudflare IPs (`198.41.x.x` and friends) are public anycast infrastructure, not a secret.

## The symptom

Ten nodes, freshly generated that morning, spread across two carrier-optimized sources. All dead:

```bash
$ curl -v https://cdn.mydomain.example/
*   Trying 104.21.25.249:443...
* Connected to cdn.mydomain.example (104.21.25.249) port 443
*   Recv failure: Connection reset by peer
* OpenSSL SSL_connect: Connection reset by peer in connection to cdn.mydomain.example:443
curl: (35) Recv failure: Connection reset by peer
```

Look closely at that: TCP connected, then the connection was reset before the TLS handshake finished. That sequence is the fingerprint of SNI-based interference. A dead server looks different.

## Hypothesis 1: the origin is down

The first thing anyone checks. Same hostname, straight at the origin IP:

```bash
$ curl --resolve cdn.mydomain.example:443:203.0.113.10 https://cdn.mydomain.example/
curl: (35) Recv failure: Connection reset by peer
```

Reset. But the origin was fine. From the origin itself, the same hostname over a Cloudflare edge IP returned `HTTP/1.1 101 Switching Protocols` minutes later. nginx was up, ufw allowed 443, nothing in the logs.

## Hypothesis 2: Cloudflare banned preferred IPs

Plausible, because that year the community was full of claims that CF was cracking down. Easy to test: same IP, different SNI.

```bash
$ curl --resolve speed.cloudflare.com:443:198.41.209.164 \
    "https://speed.cloudflare.com/__down?bytes=5000000"
HTTP/1.1 200 OK

$ curl --resolve proxy.mydomain.example:443:198.41.209.164 \
    https://proxy.mydomain.example/
curl: (35) Recv failure: Connection reset by peer
```

One IP, two hostnames, opposite results. Cloudflare was not blocking anything, and the IP was not dead.

## Hypothesis 3: move to a different VPS

I have a second server, different provider, different continent. If the origin were the problem, this would fix it:

```bash
$ curl --resolve alt-server.example.org:443:198.51.100.20 https://alt-server.example.org/
curl: (35) Recv failure: Connection reset by peer
```

Same reset, unrelated machine. The variable was never the server.

## The tcpdump line that ended it

Guessing had taken me in circles, so I stopped guessing and watched the packets on the origin while the client fired one request:

```bash
sudo tcpdump -ni any "tcp[tcpflags] & (tcp-syn|tcp-rst) != 0 and tcp dst port 443" -vv
```

Every relevant packet, in full:

```
14:51:28.175281 ens3 In  IP 198.51.100.77.17652 > 203.0.113.10.443: Flags [S]
14:51:28.458155 ens3 In  IP 198.51.100.77.17652 > 203.0.113.10.443: Flags [R.]
```

Read the source addresses. The RST comes from `198.51.100.77`, which is the client, and its ack (`486385868`) is a sequence number the server never sent. The origin never replied at all. The client waited for a SYN-ACK that could not arrive, timed out, and reset its own socket.

The origin was not refusing anything. It was never contacted. The SYN vanished somewhere between my ISP's edge and the VPS.

I spent the next hour looking for a firewall rule on a server that had not received a single packet. That hour is the actual lesson of this story, and I'll come back to it.

## Pinning down the rule

Once SNI filtering was the suspect, the test design got simple. Fix the IP, vary only the hostname:

| SNI in the ClientHello | Result |
|---|---|
| `speed.cloudflare.com` | **200 OK** |
| `i.cd`, `us.ci`, `bot.cd`, `de5.net`, `cwu.cc`, `bbroot.com`, `kz.ci`, `xyz.ci`, `pc.ci` | TLS alert (packet reached Cloudflare) |
| `cc.cd` | **Connection reset** |

Two failure modes, and the difference between them is the whole finding. A TLS alert means Cloudflare answered, which means the packet arrived and nothing interfered. A bare reset means something killed the connection mid-handshake.

Then two probes that fixed the rule in place:

```bash
# .cd, but not cc.cd  →  survives
curl --resolve abc123def.cd:443:198.41.209.164 https://abc123def.cd/

# cc.cd, but a hostname that does not exist  →  reset
curl --resolve randxyz.cc.cd:443:198.41.209.164 https://randxyz.cc.cd/
```

The match was the literal substring `cc.cd`. Not the `.cd` TLD, not my hostname, not the IP, not the port. Five characters in the SNI field.

It was not port-specific either. Same reset on 443 and on 8443, and on plain HTTP port 80 via the Host header. Which is exactly why the REALITY nodes on those same ports never broke: REALITY borrows a SNI like `www.nvidia.com`, so there is nothing in the ClientHello to match.

```mermaid
flowchart LR
    A[Client sends SYN] --> B["SYN-ACK never returns<br/>origin sees nothing"]
    B --> C[Client times out<br/>and resets its own socket]
    C --> D[curl reports<br/>"Connection reset by peer"]

    style A fill:#1e2430,stroke:#4a5568,color:#e6e6e6
    style B fill:#3d1f1f,stroke:#a45050,color:#e6e6e6
    style C fill:#3d1f1f,stroke:#a45050,color:#e6e6e6
    style D fill:#3d1f1f,stroke:#a45050,color:#e6e6e6
```

That error message is the client's own frustration, not a server's rejection. Reading it as a rejection is what sent me hunting in the wrong place.

## Why TLS fragmentation did not save it

If the filter reads SNI, the obvious workaround is to hide it. Every VLESS client supports `fragment`, which splits the ClientHello across several TCP segments so no single packet carries the full hostname. Mine was already enabled. From the box's own logs:

```
[TCP] dial 下载节点[DL|CF-CMCC-1] error: 162.159.133.16:443 connect error:
  read tcp 192.168.1.50:2738->162.159.133.16:443: connection reset by peer
```

Fragmentation on, reset anyway. Reassembly is trivial for the filter, and so is matching across fragments. Fragmentation adds a little cost. It does not change the outcome.

## The fix cost five changes

The domain name is hardcoded in every layer of a Cloudflare-proxied VLESS node, so "change the domain" means changing it in five places. Two of them bit me:

**3x-ui reverts config.json.** I edited `/usr/local/x-ui/bin/config.json` and reloaded. The new hostname returned 404 again. 3x-ui stores inbound settings in SQLite and regenerates `config.json` from that database on every restart, so the edit was silently reverted each time. The fix had to go into `/etc/x-ui/x-ui.db`, and then a stale xray process still holding port 10086 had to be killed before the change took effect.

**The certificate is two files.** I regenerated the origin cert with the new SAN and dropped it in, and got `sslv3 alert handshake failure`. nginx loads `ssl_certificate` and `ssl_certificate_key` as separate files. Updating one without the other breaks the handshake in a way that looks like a Cloudflare problem.

After those five changes, both the old and new hostnames returned `101 Switching Protocols`, the subscription had 14 nodes, and a client-side proxy test came back in 0.4 seconds. The old domain still works.

## The hour I wasted, and what it cost me

The tcpdump was at the 90-minute mark. Ninety minutes of checking firewalls, reading nginx configs, verifying ufw rules, testing whether the cert was valid. All of it was reasonable work. All of it was pointed at a server that had never received a packet.

The reason is worth naming: the symptom pointed somewhere, and the somewhere was plausible. "Connection reset by peer" sounds like a server-side rejection, so I went looking for a server-side rejection. The error message was a lie about where the problem lived, and I had no way to know that from the message alone.

What broke the loop was stopping to think about what all ten failing nodes had in common. They did not share an IP, a provider, a port, or a config file. They shared exactly one thing: the hostname in every single ClientHello. When many similar things fail at once, the cause is usually the thing they share.

## The sixty-second version

```bash
# Same IP, two SNI values. This is the whole diagnosis.
curl -sS -o /dev/null -w "%{http_code}\n" --max-time 8 \
  --resolve speed.cloudflare.com:443:198.41.209.164 \
  "https://speed.cloudflare.com/__down?bytes=5000000"

curl -sS -o /dev/null -w "%{http_code}\n" --max-time 8 \
  --resolve your.domain.here:443:198.41.209.164 \
  https://your.domain.here/
```

200 on the first, reset on the second, and your problem is your domain. Every other move — new provider, different `-n` and `-dn` values, waiting for Cloudflare to lift a ban it never imposed — is wasted effort.

If you want to confirm it on the wire before you touch anything:

```bash
sudo timeout 30 tcpdump -ni any \
  "tcp[tcpflags] & (tcp-syn|tcp-rst) != 0 and tcp dst port 443" -c 20
```

A reset whose source address equals the client's IP, arriving with no reply from your server, is the signature. Then go find a domain whose SNI is not on the list.

## Related reading

- [CloudflareSpeedTest](https://github.com/XIU2/CloudflareSpeedTest) is a good tool, and it was never the problem here
- [Great Firewall](https://en.wikipedia.org/wiki/Great_Firewall) for background on how SNI inspection became standard
- [Deep Packet Inspection of Encrypted Traffic](https://www.usenix.org/conference/usenixsecurity20/presentation/han) on why fragmenting a ClientHello is a speed bump rather than a wall
