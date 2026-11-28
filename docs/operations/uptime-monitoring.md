# Uptime monitoring spec

What external monitors to set up, what they should check, how alerts route. Operator-implementable spec — the actual configuration lives in third-party dashboards.

## Choice of monitoring service

Recommended: **Healthchecks.io** for cron monitoring, **Pingdom** for synthetic HTTP checks.

Healthchecks.io chosen for crons because the dead-man-switch model fits our cron-driven license-revocation refresh and dunning emails. Pingdom for HTTP because Cloudflare's built-in monitoring is included but doesn't alert in 30-second intervals.

Both have free tiers that cover MVP needs:
- Healthchecks.io: 20 free checks
- Pingdom: limited but enough for landing + 3 API endpoints

## What to monitor

### HTTP synthetic checks (Pingdom)

| Check name | URL | Method | Interval | Expected | Alert |
|---|---|---|---|---|---|
| Landing page | `https://aster-lang.cloud/` | GET | 60 s | 200 or 307 within 3 s | PagerDuty P1 |
| Dashboard | `https://aster-lang.cloud/dashboard` | GET | 60 s | 200 or 307 within 5 s | PagerDuty P1 |
| API health | `https://policy.aster-lang.dev/q/health` | GET | 30 s | 200 + JSON `{"status":"UP"}` | PagerDuty P0 |
| Auth callback | `https://aster-lang.cloud/api/auth/csrf` | GET | 60 s | 200 + JSON | PagerDuty P1 |
| Stripe webhook target | `https://aster-lang.cloud/api/stripe/webhook` | OPTIONS | 5 min | 4xx (we only accept POST) | PagerDuty P2 |
| Lexicon endpoint | `https://policy.aster-lang.dev/api/v1/lexicons` | GET | 60 s | 200 + JSON | PagerDuty P2 |

Pattern: shorter interval for higher-severity checks. 30s on API health because aster-api crashes are the highest-blast-radius issue.

### Cron monitoring (Healthchecks.io)

For each cron in `src/app/api/cron/`, create a Healthchecks.io check. The cron POSTs a heartbeat to Healthchecks at the start and end of each run; if Healthchecks doesn't see a heartbeat within the grace period, it pages.

| Cron | Expected interval | Grace | Heartbeat URL env |
|---|---|---|---|
| `/api/cron/license-revocation-refresh` | 6 h | 1 h | `HEALTHCHECKS_LICENSE_REVOCATION_URL` |
| `/api/cron/dunning-emails` | 24 h | 2 h | `HEALTHCHECKS_DUNNING_URL` |
| `/api/cron/auto-downgrade` | 24 h | 2 h | `HEALTHCHECKS_AUTO_DOWNGRADE_URL` |
| `/api/cron/ai-anomaly-scan` | 1 h | 15 min | `HEALTHCHECKS_AI_ANOMALY_URL` |
| `/api/cron/ai-circuit-check` | 5 min | 2 min | `HEALTHCHECKS_AI_CIRCUIT_URL` |
| `/api/cron/api-quota-alerts` | 30 min | 10 min | `HEALTHCHECKS_API_QUOTA_URL` |
| `/api/cron/cleanup-nonces` | 1 h | 15 min | `HEALTHCHECKS_NONCE_CLEANUP_URL` |
| `/api/cron/byok-healthcheck` | 1 h | 15 min | `HEALTHCHECKS_BYOK_URL` |
| `/api/cron/telemetry-uploader` | 6 h | 1 h | `HEALTHCHECKS_TELEMETRY_URL` |
| `/api/cron/telemetry-retention-gc` | 24 h | 2 h | `HEALTHCHECKS_TELEMETRY_GC_URL` |
| `/api/cron/user-purge` | 24 h | 2 h | `HEALTHCHECKS_USER_PURGE_URL` |
| `/api/cron/guard-orphan-notify` | 5 min | 5 min | `HEALTHCHECKS_GUARD_ORPHAN_NOTIFY_URL` |

Pattern in each cron route: wrap the handler in a try/finally that posts to the heartbeat URL. Example wiring at `src/lib/healthcheck-heartbeat.ts` (will land in a follow-up commit).

## Alert routing

### PagerDuty service

Single PagerDuty service `aster-prod-saas` with three escalation policies:

| Severity | Policy | First responder | Escalation |
|---|---|---|---|
| **P0** | "critical" | On-call (15 min ack) → secondary (10 min) → head of eng | Anyone available |
| **P1** | "high" | On-call (15 min ack) → secondary | Skip head of eng |
| **P2** | "business hours" | On-call when on shift; queue otherwise | None |

### Slack

`#alerts-prod` channel: every alert mirrored regardless of severity. Volume target: < 5 messages/day on a healthy week. >10/day = alert tuning needed.

### Status page

[https://status.aster-lang.cloud/](https://status.aster-lang.cloud/) — public-facing. Updated manually during incidents (see `incident-response.md`). Pingdom can post automatically but we keep it human-curated to avoid false positives spamming the page.

## Service-account credentials

Each monitor needs a stable service-account credential.

For authenticated checks (login flow):
- User: `monitoring@aster-lang.cloud`
- Stored in 1Password vault `aster-prod-ops`
- Rotated quarterly via `secrets-rotation.md` Section "ZAP / Monitoring service account"

For unauthenticated checks (landing, health):
- No credential needed

## What we do NOT monitor

- **Worker cold-start latency** — Cloudflare's responsibility, not in our SLO
- **Hyperdrive pool wait time** — Cloudflare dashboard surfaces it; we don't alert on it (would page on every pool refresh)
- **AI provider availability** — OpenAI/Anthropic status pages; circuit breaker handles it gracefully
- **Customer-specific dashboards** — too noisy, would page on every customer's free-tier limit

## Implementation checklist (one-time setup)

- [ ] Sign up for Pingdom + Healthchecks.io with `monitoring@aster-lang.cloud`
- [ ] Add the 6 HTTP checks listed above
- [ ] Generate 11 Healthchecks.io URLs; store as Cloudflare Worker secrets per the env names in table
- [ ] Update each cron route to call `recordHealthcheckHeartbeat()` at start + finish (see follow-up commit)
- [ ] Wire PagerDuty service + escalation policy
- [ ] Add `#alerts-prod` Slack channel webhook to both Pingdom and Healthchecks
- [ ] Verify each check with an intentional failure (curl to a known-bad path), confirm alert fires
- [ ] Document the credentials + dashboard URLs in `secrets-rotation.md` and 1Password

## Cost note

Total cost at GA scale: ~$30/month for Pingdom Starter + $0 (free tier) for Healthchecks. Acceptable line item. Re-evaluate at >10k MAU when we may want Datadog-tier integration.

## Related

- [`slo.md`](slo.md) — the SLOs these monitors measure against
- [`incident-response.md`](../runbooks/incident-response.md) — what to do when a monitor fires
- [`on-call.md`](../runbooks/on-call.md) — pager hours by severity
