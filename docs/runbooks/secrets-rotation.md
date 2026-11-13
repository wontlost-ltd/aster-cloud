# Secrets rotation runbook

Quarterly cadence (or immediately on suspected compromise). One operator can do the whole list in ~2 hours.

## What's in scope

| Secret | Where it lives | Rotation impact | Blast radius if leaked |
|---|---|---|---|
| `AUTH_SECRET` / `NEXTAUTH_SECRET` | Cloudflare Worker secret | All sessions invalidated → users sign in again | Attacker can forge sessions for any user |
| `CRON_SECRET` | Cloudflare Worker secret + each cron caller | Cron jobs fail until both sides rotated | Attacker can drive cron endpoints (telemetry, license refresh, dunning) |
| `ASTER_PLAN_GATE_HMAC_KEY` | Worker secret + aster-api k8s ExternalSecret | PlanGate snapshot push fails until both sides match | Attacker can forge plan-tier upgrades |
| `ASTER_FACT_SIGNING_KEY` | Cloudflare Worker secret | 只换 secret 而不在各租户启用新 kid → cloud 停止附签名事实（登记照常；1.3.0 后高风险模块 DENY） | 可为任何已启用 cloud 签发方的租户伪造 `principal.*` 事实 |
| `AI_KEY_ENCRYPTION_SECRET` | Worker secret | **All BYOK keys must be re-encrypted** | Attacker can decrypt every customer's stored OpenAI/Anthropic/Vertex key |
| `LICENSE_KEY` (on-prem only) | Per-customer K8s Secret | On-prem deployment immediate re-verify | Attacker on prem can sign their own licenses |
| `STRIPE_WEBHOOK_SECRET` | Worker secret + Stripe dashboard | Stripe webhooks fail until both sides match | Attacker can forge subscription state changes |
| `RESEND_API_KEY` | Worker secret | Outbound email fails until rotated | Attacker can send email as `*@aster-lang.cloud` |
| `DATABASE_URL` password | Hyperdrive binding | Connection failures until both sides match | Direct DB access |
| `ARGOCD_AUTH_TOKEN` | GitHub Actions secret | CI auto-sync fails | Attacker can force-sync K3S apps |
| `ZAP_SCAN_USER_PASSWORD` | GitHub Actions secret + DB user row | Authenticated scan in CI fails | Read-only-ish access via scan service account |

## Pre-rotation checklist

- [ ] Notify on-call (post in #ops): "rotating <secret> at <ETA>; expect <impact>"
- [ ] Verify you have current value in 1Password (in case rollback needed)
- [ ] Confirm there's no active incident — don't rotate during a fire
- [ ] Pick a low-traffic window (Saturday 2 AM AEST = best)

## Procedures

### `AUTH_SECRET` (NextAuth session signing)

```bash
# 1. Generate new secret
NEW_SECRET=$(openssl rand -base64 48)
echo "$NEW_SECRET" | 1password vault item create

# 2. Write to Cloudflare Worker
echo "$NEW_SECRET" | wrangler secret put AUTH_SECRET --name aster-cloud
echo "$NEW_SECRET" | wrangler secret put NEXTAUTH_SECRET --name aster-cloud

# 3. Trigger redeploy (Cloudflare auto-picks-up on next request anyway,
#    but force-rolling means the rotation moment is deterministic):
wrangler deploy --name aster-cloud

# 4. Verify all active sessions invalidated:
#    Open a private browser → aster-lang.cloud → expect redirect to /signin
```

**Impact**: every logged-in user gets bumped to sign-in page on their next request. No data loss. Users with valid credentials sign right back in.

**Rollback**: `wrangler secret put` with the previous value within 5 minutes restores all sessions (clients haven't refreshed their tokens yet).

---

### `CRON_SECRET`

```bash
# 1. Generate
NEW=$(openssl rand -base64 32)

# 2. Update Worker
echo "$NEW" | wrangler secret put CRON_SECRET --name aster-cloud

# 3. Update GitHub Actions secret (used by aster-api cron caller):
gh secret set CRON_SECRET --repo wontlost-ltd/aster-api --body "$NEW"

# 4. Trigger one cron manually to verify both sides agree:
curl -X POST https://aster-lang.cloud/api/cron/license-revocation-refresh \
  -H "Authorization: Bearer $NEW" \
  -i | head -5
# expected: HTTP/2 200 (or 204 for air-gapped SKU)
```

**Impact**: any cron in-flight at rotation time fails (the next scheduled run picks up the new secret). No customer-visible effect.

---

### `AI_KEY_ENCRYPTION_SECRET` ⚠️ HIGH-RISK

**This rotation requires re-encrypting every customer's BYOK key.** Don't do it casually.

```bash
# Pre-flight: count what gets touched
psql "$DATABASE_URL" -c "SELECT count(*) FROM \"AiKeyBinding\" WHERE active=true;"

# 1. Generate new
NEW=$(openssl rand -base64 32)

# 2. Run the dual-key re-encryption migration (script lives in scripts/):
OLD_AI_KEY_ENCRYPTION_SECRET=<current> \
NEW_AI_KEY_ENCRYPTION_SECRET="$NEW" \
DATABASE_URL=<...> \
  pnpm tsx scripts/rotate-byok-encryption-secret.ts
# The script reads each row with pgp_sym_decrypt(old), re-encrypts
# with pgp_sym_encrypt(new), and writes atomically. Logs each
# AiKeyBinding.id processed for audit.

# 3. THEN flip the Worker secret:
echo "$NEW" | wrangler secret put AI_KEY_ENCRYPTION_SECRET --name aster-cloud

# 4. Smoke test: as a real user with a BYOK key, hit anything that
#    actually decrypts (e.g. /api/policies/draft AI generate). If the
#    decrypt fails the Worker logs include pgp_sym_decrypt error +
#    requestId.
```

**Impact if rotation script fails mid-way**: some rows on old secret, some on new — every customer whose row didn't complete loses BYOK service. The rotate script writes a checkpoint file in `/tmp/byok-rotation-progress.json` so a retry resumes from the last completed row.

**Rollback**: if you've already flipped the Worker secret, re-run rotation with OLD and NEW swapped to undo. If you haven't yet flipped — abort, do nothing, BYOK keeps working on the old secret.

> **Important**: A clean install (zero BYOK rows yet) has no rotation cost — just `wrangler secret put` and ship. Confirm with `psql -c "SELECT count(*) FROM \"AiKeyBinding\";"` before assuming you need the script.

---

### `ASTER_FACT_SIGNING_KEY`（cloud 平台签发方，ADR 0040 §11 D3 / ADR 0046 §11.7 裁定 4）

一行 JSON `{"issuer","kid","privateKey","publicKey"}`。aster-api 按 `issuer#kid` 存公钥，所以轮换 = 换 kid，顺序不可反：

```bash
# 1. 生成新 kid 的密钥并直接写入 Worker（输出含私钥，不落盘、不贴工单）
pnpm --silent fact-key:gen --kid <new-kid> | wrangler secret put ASTER_FACT_SIGNING_KEY --name aster-cloud
# 2. 各租户 owner 在 /teams/<id>/settings（个人：/settings/fact-issuers）「启用 Aster Cloud 签发方」登记新 kid
#    —— 未启用新 kid 的租户从此刻起不再收到事实（cloud 只在 issuer#kid 已启用且公钥一致时附）
# 3. 确认各租户已启用新 kid 后，再在同一页面吊销旧 kid
```

**为什么先启用后吊销**：吊销会让 aster-api 联动过期依赖该签发方事实的待审批（`expiredReason: fact_issuer_revoked`）。先吊销旧 kid 会让仍在审批中的决策过期。

**泄露时**：立即在所有租户吊销旧 kid（接受待审批过期），再按 1–2 步换新 kid。

---

### `LICENSE_KEY` (on-prem only)

License rotation is **the customer's responsibility**, triggered by:
- License approaching expiry (renewal flow at sales)
- License-key-ceremony rotates the Ed25519 signing key (rare, see [`license-key-ceremony-rehearsal.md`](license-key-ceremony-rehearsal.md))

For SaaS deployments: N/A — SaaS doesn't read `LICENSE_KEY`.

---

### `STRIPE_WEBHOOK_SECRET`

```bash
# 1. In Stripe Dashboard → Developers → Webhooks → "aster-cloud prod"
#    → Roll signing secret → copy new value
NEW="whsec_..."

# 2. Update Worker:
echo "$NEW" | wrangler secret put STRIPE_WEBHOOK_SECRET --name aster-cloud
wrangler deploy --name aster-cloud

# 3. Verify: Stripe Dashboard → Webhooks → Send test event → 200 OK
```

**Impact**: subscription state updates from Stripe (subscription.updated, invoice.paid, etc.) fail until both sides match. Affects auto-tier-flip on payment.

---

### `RESEND_API_KEY`

```bash
# 1. Resend dashboard → API Keys → create new
NEW="re_..."

# 2. Update Worker:
echo "$NEW" | wrangler secret put RESEND_API_KEY --name aster-cloud
wrangler deploy --name aster-cloud

# 3. Smoke: trigger a password-reset email to a test account →
#    verify Resend dashboard shows the send.

# 4. Revoke OLD key in Resend dashboard once new is confirmed
```

---

### `DATABASE_URL` password (Hyperdrive binding)

```bash
# 1. Generate strong password in Postgres
psql "$DATABASE_URL" -c "ALTER ROLE aster_app WITH PASSWORD 'new-strong-password';"

# 2. Update Hyperdrive binding via Cloudflare dashboard or:
wrangler hyperdrive update <HYPERDRIVE_ID> \
  --connection-string "postgresql://aster_app:new-strong-password@host:5432/aster_cloud"

# 3. No deploy needed — Hyperdrive picks up the new conn string on
#    next pool refresh. Verify by reading /api/auth/session — if it
#    returns user data, the new conn works.
```

**Impact**: connection failures during the few seconds between Postgres ALTER and Hyperdrive picking up new string. Reads + writes return 5xx. Always do in low-traffic window.

---

### `ARGOCD_AUTH_TOKEN` + `ZAP_SCAN_USER_PASSWORD`

GitHub-Actions-only secrets, no runtime impact:

```bash
# ARGOCD: generate via ArgoCD UI → User Info → Generate Token
gh secret set ARGOCD_AUTH_TOKEN --repo wontlost-ltd/aster-cloud --body "<token>"

# ZAP_SCAN_USER_PASSWORD: rotate the DB user row too
psql "$DATABASE_URL" -c "UPDATE \"User\" SET password_hash='<new bcrypt>' WHERE email='security-scan@aster-lang.cloud';"
gh secret set ZAP_SCAN_USER_PASSWORD --repo wontlost-ltd/aster-cloud --body "<new>"
```

## Post-rotation

- [ ] Update 1Password records with new values (delete old after 7 days)
- [ ] Update the inventory in this runbook if any procedure surprised you
- [ ] Note rotation in `docs/runbooks/secrets-rotation-log.md` (append-only timeline)
- [ ] Schedule next rotation: 90 days from today

## Emergency rotation (suspected leak)

If you have reason to believe a secret leaked (laptop stolen, ex-employee, CI log exposure):

1. **Rotate immediately**, don't wait for the maintenance window
2. **All secrets**: rotate ALL of them, not just the suspected one — assume rotation skill is now in attacker's playbook
3. **Audit**: query `SecurityEvent` table for activity in the past 30 days against any affected endpoint
4. **Customer notification**: if BYOK encryption secret leaked → notify all customers with active `AiKeyBinding` rows (DSAR-equivalent)
5. **Post-mortem**: file via [`post-mortem-template.md`](post-mortem-template.md) within 72 hours
