---
name: tailscale
description: How claude-hub is exposed across devices via Tailscale (tailnet-only by default; optional Funnel for public). Use when the user asks about tailnet access, the `*.ts.net` URL, `tailscale serve`/`funnel`, HTTPS cert provisioning, or how to reach claude-hub from a phone/laptop.
---

# Sharing claude-hub via Tailscale

claude-hub binds `127.0.0.1` only — not reachable from LAN. Tailscale is the tested path for phone/laptop access without opening ports.

## Setup

1. Install [Tailscale](https://tailscale.com) on host running claude-hub and on each device you want to reach from. Free tier enough.
2. On host: `tailscale serve --bg --https=443 http://localhost:8002`. Gives `https://<host>.<tailnet>.ts.net/` proxied to claude-hub, Tailscale-managed Let's Encrypt cert + HTTPS termination on Tailscale side.
3. On any tailnet peer: open URL.

Stays inside tailnet — no public exposure. Works with no proxy code changes, including ttyd WebSocket upgrades and Vite HMR. To stop: `tailscale serve --https=443 off`.

## Public exposure (Funnel)

Want public reachability? `tailscale funnel` = same command, `funnel` substituted (needs `funnel` ACL attribute enabled in tailnet ACL). Think hard before flipping — claude-hub exposes interactive Claude Code sessions with full access to `~/projects`.

## Operational notes

- `tailscale serve` config stored on the daemon; survives reboots. Inspect: `tailscale serve status`.
- Cert auto-renews via Tailscale's ACME flow. No on-disk cert to manage.
- TLS+:443 binding lives on the Tailscale virtual interface. On WSL2 with `networkingMode=Mirrored`, the Windows-side tailscale daemon reaches `localhost:8002` directly. Self-loopback from inside WSL2 to the `*.ts.net` URL fails ("connection refused") — test from another peer or from Windows itself.
- To reconfigure from scratch: `tailscale serve --bg --https=443 http://localhost:8002`.
- Tear down: `tailscale serve --https=443 off`.

## Decision history

Evaluated Tailscale Funnel, Cloudflare Tunnel, ngrok, direct port forwarding. Stayed tailnet-private — no public access needed; minimal attack surface. If that changes, **Funnel** is lowest-friction (one command, reuses existing serve, same FQDN, free, ports 443/8443/10000 only). **Cloudflare Tunnel** = more robust if a real custom domain is wanted (DDoS, caching, HTTP/3, free, needs domain on Cloudflare).
