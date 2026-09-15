# Research: free/cheap Postgres and RR7 hosting landscape

Type: research
Status: open
Blocked by:

## Question

Given a **hard budget constraint** (free tier or near-free) and a TypeScript **RR7** app that needs a relational database:

- Which managed Postgres options have real, current free tiers, and what are their limits (storage, compute hours, connection limits, sleep/pause behaviour, egress)? Consider Neon, Supabase, Railway, and any others that matter; if libSQL/Turso or plain SQLite is a better fit for the constraints, say so and why.
- Which hosts run an **RR7 (server-rendered React Router v7)** app cheaply — Fly.io, Render, Railway, a small VPS, Cloudflare, others? Note cold starts, free-tier durability, and deploy friction.
- What is the realistic total monthly cost for a low-traffic personal app with open signup, and where does it first start to cost money?
- What are the privacy-relevant facts: where data is stored, whether the free tier permits it, and how hard it is to self-host later?

Findings go in `.scratch/mdwn/research/infra-landscape.md`, each claim cited to the provider's own pricing/docs pages (primary sources, current 2026 values; verify, don't recall).

## Answer
