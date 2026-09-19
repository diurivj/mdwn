# Research: free/cheap Postgres and RR7 hosting landscape

Type: research
Status: resolved
Blocked by:

## Question

Given a **hard budget constraint** (free tier or near-free) and a TypeScript **RR7** app that needs a relational database:

- Which managed Postgres options have real, current free tiers, and what are their limits (storage, compute hours, connection limits, sleep/pause behaviour, egress)? Consider Neon, Supabase, Railway, and any others that matter; if libSQL/Turso or plain SQLite is a better fit for the constraints, say so and why.
- Which hosts run an **RR7 (server-rendered React Router v7)** app cheaply — Fly.io, Render, Railway, a small VPS, Cloudflare, others? Note cold starts, free-tier durability, and deploy friction.
- What is the realistic total monthly cost for a low-traffic personal app with open signup, and where does it first start to cost money?
- What are the privacy-relevant facts: where data is stored, whether the free tier permits it, and how hard it is to self-host later?

Findings go in `.scratch/mdwn/research/infra-landscape.md`, each claim cited to the provider's own pricing/docs pages (primary sources, current 2026 values; verify, don't recall).

## Answer

Full findings: `.scratch/mdwn/research/infra-landscape.md`.

- Best $0 combination: **Cloudflare Workers free + D1 free** (SQLite) or **Workers free + Neon free** via Hyperdrive (Postgres). No sleep, no card. Neon free is permanent: 0.5 GB storage, 100 CU-hours/project, 5 GB egress, scales to zero after 5 min (https://neon.com/pricing).
- Supabase free is real Postgres (500 MB, 200 connections) but **pauses after 7 days low activity** (https://supabase.com/docs/guides/platform/free-project-pausing).
- **Not $0 options**: Fly.io has no free tier for new customers (card required, https://fly.io/docs/about/discontinued-plans/); Render free Postgres **expires after 30 days** and free web services sleep 15 min (https://render.com/docs/free); Railway's $1/month free credit cannot run an always-on app (https://railway.com/pricing).
- First cost: **$5/month** (Cloudflare Workers Paid, or Railway Hobby), triggered by 100k req/day or the 10 ms CPU/invocation cap; or Neon Launch pay-as-you-go after 0.5 GB / 100 CU-hours. A Hetzner VPS (2 vCPU/4 GB) is ~€5.49–5.99/mo excluding IPv4 (https://docs.hetzner.com/general/infrastructure-and-availability/price-adjustment/).
- Turso/libSQL free is generous (5 GB, 500M reads/mo) but has **no DPA/SOC 2 on free**; plain SQLite needs a persistent disk, so it only fits a VPS (https://turso.tech/pricing).
- Privacy: Neon/Supabase pin data to a chosen region and include a DPA; no free tier offers customer-managed keys, so end-to-end encryption must be app-level (ticket 01). Postgres has the easiest self-hosting exit.
