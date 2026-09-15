# Infrastructure landscape: free/cheap Postgres + RR7 hosting

Researched 2026-09-15. Every claim below is cited to the provider's own pricing or
docs page (primary source). Where a value could not be confirmed on a primary page,
it is marked **unverified** rather than guessed. Free tiers change often — re-check
before locking the stack (ticket `08-lock-stack-and-hosting`).

Constraints driving this: hard budget (free or near-free), TypeScript **RR7**
(React Router v7 framework mode, server-rendered), relational database, open
signup, privacy as a core value, never monetized.

---

## 0. Bottom line

- **Cheapest genuinely-free combination: Cloudflare Workers (free) + Cloudflare D1
  (free)** — $0/month, no sleep, no pause, no card. Cost is that D1 is SQLite, not
  Postgres, and Workers free allows only 10 ms CPU per invocation.
- **Cheapest genuinely-free *Postgres*: Neon free + a free host** — $0/month,
  permanent, no card, 0.5 GB storage, 100 CU-hours/project, scales to zero after
  5 min. This is the closest match to the stated "Postgres-family" preference.
- **Supabase free** is the other real free Postgres, but pauses the project after
  7 days of low activity.
- **Fly.io has no free tier for new customers** (pay-as-you-go, card required since
  Oct 2024). **Render free Postgres self-destructs after 30 days.** **Railway free
  credit ($1/month) cannot run an always-on app.** Those three are not $0 options.
- **First real cost** arrives at roughly one of: Cloudflare Workers Paid **$5/mo**
  (if the daily request or CPU limits are exceeded), Railway Hobby **$5/mo**, Neon
  Launch **pay-as-you-go** (only if you outgrow 0.5 GB / 100 CU-hours / 5 GB egress),
  or a Hetzner VPS at **€5.49–5.99/mo (~$6.50–7)**.
- **Privacy**: none of the free DB tiers offer customer-managed encryption keys, so
  the server can read all content (relevant to ticket `01-define-privacy-model`).
  Region choice pins data location for Neon/Supabase; Turso pins per-region S3.
  Neon and Supabase include a DPA; **Turso's free plan explicitly does not**.

---

## 1. Managed Postgres free tiers

### 1.1 Neon — best free Postgres fit

Source: <https://neon.com/pricing>, <https://neon.com/faqs/free-plan-limits-and-quotas>

- Free plan is **permanent, not a trial; no credit card required**.
- Included per project per month: **100 projects, 10 branches/project, 100 CU-hours
  compute, 0.5 GB storage, 5 GB public network transfer (egress)**.
- Compute autoscales up to **2 CU (~8 GB RAM)** and **suspends automatically after
  5 minutes of inactivity (scale-to-zero)**; suspended compute costs $0.
- Hitting *any* free limit (100 CU-hours, 0.5 GB storage, 5 GB egress) **suspends
  compute until the next billing month** — it does not silently bill you.
- Paid **Launch** is pay-as-you-go with **no monthly minimum**: compute
  **$0.106/CU-hour**, storage **$0.35/GB-month**, egress 500 GB/project included then
  $0.10/GB, extra branches $1.50/branch-month. Invoices under $0.50 are not collected.
- 0.5 GB is the binding constraint for a document vault (markdown is small, but
  comments, accounts, and indexes count). 100 CU-hours is generous given scale-to-zero.
- Region is **fixed at project creation** and cannot be changed. AWS regions include
  Frankfurt (`aws-eu-central-1`) and London (`aws-eu-west-2`), plus US, Singapore,
  Sydney, São Paulo. Source: <https://neon.com/docs/introduction/regions>
- Security: SSL/TLS required (supports `verify-full`), AES-256 at rest, proxy in
  front of the DB. Source: <https://neon.com/docs/security/security-overview>
- DPA is embedded in the terms of service / MSA for all Neon customers (GDPR).
  Source: <https://neon.com/blog/gdpr-compliance-and-neon> and
  <https://neon.com/pdf/DPA.pdf>
- Free-plan positioning is "prototypes, side projects, and small teams" — a personal
  vault with open signup sits inside that, but a runaway public signup could hit the
  0.5 GB/e gress caps and freeze compute until the next month.

### 1.2 Supabase — real free Postgres, but it sleeps

Source: <https://supabase.com/pricing>

- Free ($0): **500 MB database size** (Shared CPU, 500 MB RAM), **5 GB egress**,
  5 GB cached egress, 1 GB file storage, **50,000 MAU**, unlimited API requests,
  **max 2 active projects**, **200 concurrent peak connections**.
- **Free projects are paused after 1 week of inactivity.** A project is "inactive"
  if it does not receive sufficient user database activity over the past week; "a
  few user requests to the database each day" is typically enough to avoid pausing.
  Paused projects can be restored within **1 year**; paid plans never pause.
  Source: <https://supabase.com/docs/guides/platform/free-project-pausing>
- Connection limits on the free **Nano** compute size: **60 direct connections,
  200 pooler connections**. Source:
  <https://supabase.com/docs/guides/troubleshooting/how-to-change-max-database-connections-_BQ8P5>
- Direct connections are **IPv6-only on free**; the shared pooler (Supavisor) is
  IPv4 on every plan and is the recommended path from serverless/edge.
  Source: <https://supabase.com/docs/guides/database/connecting-to-postgres>
- Region is chosen at project creation; EU regions (Ireland, London, Paris,
  Frankfurt, Zurich, Stockholm) keep the primary DB, Auth, and Storage in-region.
  Source: <https://supabase.com/regions>,
  <https://supabase.com/docs/guides/security/gdpr-compliance>
- Supabase bundles Auth/Storage/PostgREST, which mdwn does not need if it owns its
  own auth (see ticket `02-research-passkeys`) — but it is still the only free
  Postgres with a full dashboard.

### 1.3 Railway — no usable free tier

Source: <https://railway.com/pricing>, <https://docs.railway.com/pricing/plans>

- **Free** is $0/month with **$1 of free credit per month** (credit does not roll
  over), max **1 vCPU / 0.5 GB RAM per service**, 1 project, 1 replica, 0.5 GB volume.
- New accounts start a **30-day trial with a one-time $5 credit**, then drop to the
  $1/month free plan.
- Usage rates: RAM **$10/GB-month**, CPU **$20/vCPU-month**, volume storage
  **$0.15/GB-month**, egress **$0.05/GB**. $1/month of credit buys ≈0.05 vCPU-month
  or ≈0.1 GB-month of RAM — **far short of a 24/7 app plus database**.
- Hobby is **$5/month** and includes $5 of usage; that is a flat, predictable step up.
- Railway can host a Postgres service ("deploy any open-source database") on the same
  volumes, which makes the DB part of the same bill.

### 1.4 Render Postgres — free, but expires in 30 days

Source: <https://render.com/docs/free>

- Free Render Postgres: **1 GB fixed storage**, only one per workspace,
  **expires 30 days after creation**. After expiry there is a **14-day grace period**,
  then Render **deletes the database and all data**. No backups, no managed
  connection pooling, maintenance/restarts at any time.
- Conclusion: fine for a throwaway prototype, **not viable for a real vault**.

### 1.5 Prisma Postgres — full free stack, small quota

Source: <https://www.prisma.io/pricing>

- Free forever, no card: **200k operations/month, 500 MB storage, 50 databases**,
  scale-to-zero when idle, **10 pooled / 10 direct connections**, no backups on free,
  GDPR compliance listed on free (HIPAA/SOC 2 are paid).
- Prisma also offers **Prisma Compute** on the same free plan: 1M requests/month,
  360 GB-hours memory/month, 4 active vCPU-hours/month, 10 GB egress — i.e. **host
  and database on one free allowance**. Whether Prisma Compute runs an arbitrary RR7
  Node server is **unverified**; the pricing page frames it as request/memory/CPU
  metered compute, not a container host.
- 200k operations/month is low: a page load doing several queries exhausts it quickly,
  so this is only attractive as an all-in-one demo, not as the vault backend.

### 1.6 Turso (libSQL/SQLite) — generous free tier, SQLite semantics

Source: <https://turso.tech/pricing>

- Free: **100 databases, 5 GB storage, 500M rows read/month, 10M rows written/month,
  3 GB monthly syncs, 1-day point-in-time restore**, community support.
- The free plan's feature table shows **DPA: No, Audit Logs: No, IP allow lists: No,
  SOC 2: No, BYOK encryption: No, HIPAA: No** (those start on paid tiers).
- Databases "never sleep"; idle databases cost only storage.
  Source: <https://turso.tech/pricing>
- Data durability: "All data on Turso Cloud is durable on either S3, or S3 Express …
  Each database region has its own S3 bucket, guaranteeing that data doesn't leave
  the jurisdiction where the compute takes place."
  Source: <https://turso.tech/blog/how-does-the-turso-cloud-keep-your-data-durable-and-safe>
- Encryption at rest is volume-level; BYOK is Pro/Enterprise only.
  Source: <https://docs.turso.tech/cloud/encryption>
- Primary region is set per database group and cannot be changed (replicas can move).
  Source: <https://turso.tech/blog/turso-aws-beta>

### 1.7 Cloudflare D1 — SQLite, not Postgres

Source: <https://developers.cloudflare.com/d1/platform/pricing/>

- Workers Free plan: **5M rows read/day, 100k rows written/day, 5 GB total storage**.
  Free limits reset daily at 00:00 UTC; exceeding a daily limit makes queries fail
  until reset. **No egress/throughput charges.** Scale-to-zero (no compute billing).
- Workers Paid removes daily limits: first 25B rows read/month included then
  $0.001/million; first 50M rows written/month then $1.00/million; first 5 GB storage
  then $0.75/GB-month.
- D1 is SQLite-compatible, so the ORM/schema work differs from a Postgres target.

---

## 2. libSQL/Turso vs plain SQLite

- **Plain SQLite is only viable on a host with a persistent disk.** Render free web
  services have an ephemeral filesystem and cannot attach a disk, and local file
  changes are lost on redeploy, restart, or spin-down.
  Source: <https://render.com/docs/free>. Cloudflare Workers/Pages have no
  persistent writable filesystem at all. So "plain SQLite" implies a VPS.
- **Turso/libSQL is the managed form of SQLite** and avoids sleeping, offers 5 GB
  free, and replicates across regions. On the free tier it is far more generous than
  Postgres free tiers on storage, but it is not Postgres and its free tier has **no
  DPA and no SOC 2** (see 1.6).
- **SQLite/libSQL trade-off for mdwn**: the workload is a tree of markdown docs plus
  accounts, comments, and directory-sharing grants — single-writer SQLite handles this
  fine at personal scale. The risks are (a) the app is coupled to SQLite SQL/dialect
  and would need a migration if it later moves to Postgres, and (b) free-tier
  compliance (no DPA), which matters given privacy is a core value.
- **Postgres remains the better default for a "Postgres-family" decision**: RR7 ships
  an official Node+Docker+Postgres template with Drizzle
  (<https://reactrouter.com/start/framework/deploying>), and a Postgres dump/restore
  is the easiest self-hosting exit (see §5).
- **If the chosen host is Cloudflare Workers**, then D1 (or Turso) is the natural fit
  and plain SQLite is not. If the chosen host is a VPS, plain SQLite is cheapest and
  has no third-party data processor at all.

---

## 3. Cheap RR7 (React Router v7) hosting

RR7 server-renders via adapters and can be deployed as Node (Docker, Express) or to
Cloudflare Workers; official Node templates list Fly.io, Railway, DigitalOcean, and
any Docker host. Source: <https://reactrouter.com/start/framework/deploying>.
Cloudflare maintains an official RR7 template with the Vite plugin:
<https://developers.cloudflare.com/workers/framework-guides/web-apps/react-router/>.

### 3.1 Fly.io — no free tier for new customers

Source: <https://fly.io/docs/about/discontinued-plans/>, <https://fly.io/docs/about/pricing/>

- "Fly.io no longer offers plans to new customers." The old **Hobby/Launch/Scale
  plans were deprecated on October 7, 2024**, and free allowances are **honored only
  for organizations that were on those plans before that date**.
- Legacy free allowances (pre-2024 accounts only): up to **3 shared-cpu-1x 256 MB
  VMs, 3 GB persistent volume storage, 100 GB NA/EU egress (30 GB APAC/etc.)**.
- New customers are on **Pay As You Go and must keep a credit card on file**.
- Price for a `shared-cpu-1x` 256 MB machine is about **$2.02/month** (varies by
  region). A running app plus a small Postgres VM is therefore not free.
- **Verdict: not a $0 option in 2026. No sleep/cold-start issue because there is no
  free tier to sleep.**

### 3.2 Render — free web service, sleeps and spins down

Source: <https://render.com/docs/free>

- Free web service **spins down after 15 minutes without inbound HTTP/WebSocket
  traffic** and takes **about one minute to spin back up** (a loading page is shown).
- **750 free instance hours per workspace per month**; if exhausted, all free web
  services are suspended until the next month. Hours reset monthly.
- **Ephemeral filesystem** — uploads and local SQLite files are lost on redeploy,
  restart, or spin-down. No persistent disks on free.
- Render states explicitly: **"Do not use them for production applications."**
- Render may suspend a free service that initiates "an uncommonly high volume of
  traffic" to external services (e.g. an external database) — relevant if mdwn runs
  on Render free while the DB is at Neon.
- Paid compute plans do not spin down. **Free Postgres expires in 30 days** (§1.4).

### 3.3 Railway — $5/month Hobby is the first step

Source: <https://railway.com/pricing>, <https://docs.railway.com/pricing/plans>

- Free plan ($1/month credit, 1 vCPU/0.5 GB) cannot sustain an always-on RR7 server.
- **Hobby ($5/month, includes $5 usage)** gives up to 48 vCPU / 48 GB RAM per service,
  5 GB volume, 6 replicas, 7-day logs, global regions — comfortable for a low-traffic
  app and a Postgres service.
- Deploy friction is low: RR7's official Node+Docker and Node+Postgres templates list
  Railway as a target (<https://reactrouter.com/start/framework/deploying>).

### 3.4 Cloudflare Workers — $0, no cold-start spin-down, tight CPU cap

Source: <https://developers.cloudflare.com/workers/platform/pricing/>,
<https://developers.cloudflare.com/workers/platform/limits/>

- Free: **100,000 requests/day** (across all Workers, UTC day), **10 ms CPU time per
  invocation**, 128 MB memory, 100 Workers. Static-asset requests are free and
  unlimited. No egress charges.
- Paid: **$5/month minimum**, 10M requests/month included then $0.30/million,
  30M CPU-ms/month included then $0.02/million CPU-ms, max 5 min CPU per invocation.
- **No spin-down/cold-start penalty** in the Render sense; Workers start per request.
- **The risk is the 10 ms CPU cap.** A server-rendered page that does DB queries,
  markdown parsing, and session/auth work can exceed 10 ms CPU; when it does, the
  failure mode is errors, not a bill. This is the most likely trigger for the first $5.
- Cloudflare also offers **Hyperdrive** (free tier: 100k DB queries/day) to pool
  connections to an external Postgres, so Workers-free + Neon-free is a supported
  combination at $0. Source: <https://developers.cloudflare.com/workers/platform/pricing/>

### 3.5 Small VPS (Hetzner) — ~€5.49–5.99/month, full control

Source: <https://docs.hetzner.com/general/infrastructure-and-availability/price-adjustment/>

- Current cloud prices after the 15 June 2026 adjustment (Germany/Finland, excluding
  IPv4): **CX23 €5.49/mo (~$6.49)** for 2 vCPU / 4 GB RAM / 40 GB NVMe, and
  **CAX11 €5.99/mo (~$6.99)** ARM. Hourly billing; monthly cap.
- Prices **exclude IPv4**, which is a separate add-on. Hetzner is GDPR-compliant and
  offers EU (Germany/Finland) and US (Ashburn/Hillsboro) locations.
  Source: <https://www.hetzner.com/cloud/cost-optimized/>
- This is the only option where **the database can be a local Postgres instance or a
  plain SQLite file with zero third-party data processor**, and where there is no
  sleep, no pause, and no per-request cap. It is also the most ops work (patching,
  backups, TLS, deploy).

### 3.6 Other hosts noted

- **Prisma Compute** free tier (1M requests/month, 360 GB-hours memory, 4 vCPU-hours,
  10 GB egress) is an all-in-one host+DB candidate, but whether it runs an arbitrary
  RR7 Node server is **unverified**. Source: <https://www.prisma.io/pricing>
- RR7's deploy docs also list Vercel, Netlify, DigitalOcean App Platform, and
  Hostinger. Vercel/Netlify free tiers and their commercial-use terms were **not
  verified** against primary sources in this pass and should be checked before use.

---

## 4. Realistic monthly cost and where cost first appears

Assume: one small RR7 server, one small relational DB, low traffic (a personal vault
with open signup but few active users), almost no egress.

| Configuration | Monthly cost | Notes |
| --- | --- | --- |
| Cloudflare Workers free + D1 free | **$0** | No sleep/pause; SQLite; 10 ms CPU cap |
| Cloudflare Workers free + Neon free (via Hyperdrive) | **$0** | Postgres; scale-to-zero cold starts |
| Render free web + Neon free | **$0** | Render sleeps after 15 min (~1 min wake); Render may suspend high external traffic |
| Supabase free only | **$0** | Pauses after 7 days low activity |
| Railway Free | **not viable** | $1/month credit < always-on cost |
| Railway Hobby | **$5** | Flat, predictable; includes $5 usage |
| Cloudflare Workers Paid | **$5** | Needed when 100k req/day or 10 ms CPU is exceeded |
| Hetzner CX23/CAX11 VPS | **~€5.49–5.99 (~$6.50–7)** | Excludes IPv4; most control and ops |
| Neon Launch overage | **a few $** | Only after 0.5 GB / 100 CU-hours / 5 GB egress |
| Fly.io Pay As You Go | **~$2 +** | Card required; no free tier |

**Where cost first appears:**

1. **Cloudflare route**: the first cost is **$5/month Workers Paid**, triggered by
   exceeding 100k requests/day *or* the 10 ms CPU-per-invocation cap — not by storage.
   D1 storage overage can be avoided up to 5 GB.
2. **Neon route**: the first cost is Neon Launch pay-as-you-go, triggered by exceeding
   **0.5 GB storage, 100 CU-hours, or 5 GB egress**, or by wanting a non-sleeping
   production DB. Because compute scales to zero, a truly idle app can stay at $0
   indefinitely; cost appears with sustained traffic.
3. **Railway route**: **$5/month Hobby** is effectively the entry price.
4. **VPS route**: **~$6.50–7/month** from day one — no free step.
5. **Open signup is the wildcard**: public signup invites bots, so egress/row-read
   limits (Cloudflare 100k req/day; Neon 5 GB egress; D1 100k rows written/day) can be
   hit by abuse rather than by real users. Rate limiting is unscheduled on the map
   (see "Abuse/rate limiting once open signup meets the public internet").

**Best $0 recommendation:** Cloudflare Workers free + Neon free (Hyperdrive), or
Workers free + D1 free if SQLite is acceptable. Budget **$5/month** as the realistic
near-free number for the first paid step.

---

## 5. Privacy-relevant facts

**Where data is stored (and whether it can move):**

- **Neon**: project lives in one fixed AWS region chosen at creation, e.g. Frankfurt
  or London for EU. Region **cannot be changed** — you create a new project and
  migrate. Source: <https://neon.com/docs/introduction/regions>
- **Supabase**: one primary region per project; EU regions keep DB + Auth + Storage
  in-region. Source: <https://supabase.com/regions>,
  <https://supabase.com/docs/guides/security/gdpr-compliance>
- **Turso**: each database has a primary region and per-region S3 buckets; data "does
  not leave the jurisdiction where the compute takes place", primary cannot change.
  Source: <https://turso.tech/blog/how-does-the-turso-cloud-keep-your-data-durable-and-safe>
- **Cloudflare D1**: runs on Cloudflare's global network; no per-region pinning claim
  was verified on a primary page in this pass. **Unverified.**
- **Render/Fly**: both publish region lists, but free-tier placement was not verified.

**Does the free tier permit this use?**

- **Neon** free is permanent and aimed at "prototypes, side projects, and small
  teams" — a personal vault fits, though a public open-signup app is a heavier use
  than "side project". Source: <https://neon.com/pricing>
- **Render** explicitly says free instances are **"not for production applications"**
  and may suspend services generating high external traffic.
  Source: <https://render.com/docs/free>
- **Supabase** free is a starter tier that pauses idle projects; no "no production"
  ban was found, but the pause behaviour is incompatible with an always-available vault.
  Source: <https://supabase.com/docs/guides/platform/free-project-pausing>
- **Cloudflare Workers/D1** free has no stated non-production restriction; limits are
  technical (requests/CPU/rows). Source:
  <https://developers.cloudflare.com/workers/platform/pricing/>
- **Turso** free is aimed at "personal projects, MVPs, and learning environments".
  Source: <https://turso.tech/blog/turso-cloud-debuts-the-new-developer-plan>

**DPA / compliance on each free tier:**

- **Neon**: DPA embedded in terms for all customers; GDPR-compliant.
  Source: <https://neon.com/blog/gdpr-compliance-and-neon>
- **Supabase**: DPA available; GDPR-compliant deployments on EU regions.
  Source: <https://supabase.com/docs/guides/security/gdpr-compliance>
- **Turso**: **free plan explicitly lists DPA: No, SOC 2: No, BYOK: No** (paid tiers
  add these). Source: <https://turso.tech/pricing>
- **Prisma Postgres**: GDPR listed on the free plan; HIPAA/SOC 2 paid.
  Source: <https://www.prisma.io/pricing>
- **Render free**: free tier is "not for production"; compliance features (SOC 2 etc.)
  were not verified for free. Source: <https://render.com/docs/free>

**Can the provider read the content?** None of the free tiers offer customer-managed
encryption keys (Turso BYOK is Pro/Enterprise; Neon HIPAA is Scale; Supabase BYOK is
not a free feature). So on every free option the DB operator can technically read
stored markdown. This is the decisive privacy fact for ticket `01-define-privacy-model`:
if "server can't read content" is required, it must be implemented in the app
(client-side encryption), not obtained from the host.

**Self-hosting difficulty later:**

- **Postgres (Neon/Supabase/Prisma/Railway/Render)**: easiest to leave — `pg_dump`
  and restore into self-hosted Postgres. No app SQL changes. This is a strong argument
  for Postgres for a privacy-first, never-monetized app that may later move in-house.
- **Turso/libSQL**: the data is SQLite; `sqld`/libSQL can be self-hosted, and the raw
  SQLite file is portable, but moving to Postgres later would require an app/SQL
  migration. Exporting off Turso Cloud is straightforward in principle (SQLite dump).
- **Cloudflare D1**: SQLite-based; exportable, but lock-in comes from Workers bindings
  and SQLite dialect. Moving to Postgres later is a rewrite of the data layer.
- **Plain SQLite on a VPS**: already self-hosted and portable; only backups are your
  responsibility.

---

## 6. Open questions / unverified

- Whether **Prisma Compute** can host an arbitrary RR7 Node server (pricing page is
  ambiguous). Check <https://www.prisma.io/docs> before relying on it.
- **Cloudflare D1 data residency** on free.
- **Render and Fly.io free-tier region placement** (Fly has no free tier now anyway).
- **Vercel/Netlify free-tier** commercial-use terms and RR7 fit.
- Supabase **Pro price** (to avoid pausing) was not cleanly captured from the pricing
  page; read it at <https://supabase.com/pricing> before quoting a number.
- Hetzner **IPv4 add-on** cost and included traffic volume were not confirmed from a
  primary page in this pass.

---

## Sources (primary)

- <https://neon.com/pricing>
- <https://neon.com/faqs/free-plan-limits-and-quotas>
- <https://neon.com/docs/introduction/regions>
- <https://neon.com/docs/security/security-overview>
- <https://neon.com/blog/gdpr-compliance-and-neon>
- <https://neon.com/pdf/DPA.pdf>
- <https://supabase.com/pricing>
- <https://supabase.com/docs/guides/platform/free-project-pausing>
- <https://supabase.com/docs/guides/database/connecting-to-postgres>
- <https://supabase.com/docs/guides/troubleshooting/how-to-change-max-database-connections-_BQ8P5>
- <https://supabase.com/regions>
- <https://supabase.com/docs/guides/security/gdpr-compliance>
- <https://railway.com/pricing>
- <https://docs.railway.com/pricing/plans>
- <https://render.com/docs/free>
- <https://fly.io/docs/about/discontinued-plans/>
- <https://fly.io/docs/about/pricing/>
- <https://developers.cloudflare.com/workers/platform/pricing/>
- <https://developers.cloudflare.com/workers/platform/limits/>
- <https://developers.cloudflare.com/workers/framework-guides/web-apps/react-router/>
- <https://developers.cloudflare.com/d1/platform/pricing/>
- <https://turso.tech/pricing>
- <https://turso.tech/blog/how-does-the-turso-cloud-keep-your-data-durable-and-safe>
- <https://turso.tech/blog/turso-cloud-debuts-the-new-developer-plan>
- <https://turso.tech/blog/turso-aws-beta>
- <https://docs.turso.tech/cloud/encryption>
- <https://www.prisma.io/pricing>
- <https://docs.hetzner.com/general/infrastructure-and-availability/price-adjustment/>
- <https://www.hetzner.com/cloud/cost-optimized/>
- <https://reactrouter.com/start/framework/deploying>
