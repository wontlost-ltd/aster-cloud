/**
 * Bootstrap an admin user.
 *
 * Idempotent — re-running for an existing email upserts the password
 * hash + flips isAdmin=true + mustChangePassword=true. The credentials
 * are read from env so the actual values never land in git:
 *
 *   ADMIN_EMAIL              required
 *   ADMIN_INITIAL_PASSWORD   required (sent to the operator out-of-band;
 *                            the user is force-rotated on first login)
 *   ADMIN_NAME               optional (defaults to "Admin")
 *
 * Usage:
 *   ADMIN_EMAIL=<admin email> \
 *   ADMIN_INITIAL_PASSWORD='<strong one-time password>' \
 *     pnpm seed:admin
 *
 * Why a script (not a migration): admin provisioning is operator-
 * driven, not schema-driven. Migrations should not contain
 * environment-specific secrets. A one-shot script keeps the password
 * out of source control and out of every replayed migration.
 */

import 'dotenv/config';
import bcrypt from 'bcryptjs';
import postgres from 'postgres';
import { drizzle } from 'drizzle-orm/postgres-js';
import { eq } from 'drizzle-orm';
import { randomUUID } from 'crypto';
import * as schema from '@/db/schema';

async function main() {
  const email = (process.env.ADMIN_EMAIL || '').toLowerCase().trim();
  const password = process.env.ADMIN_INITIAL_PASSWORD || '';
  const name = process.env.ADMIN_NAME || 'Admin';

  if (!email || !password) {
    console.error(
      '[seed-admin] ADMIN_EMAIL and ADMIN_INITIAL_PASSWORD env vars are required.',
    );
    process.exit(1);
  }
  if (password.length < 8) {
    console.error('[seed-admin] ADMIN_INITIAL_PASSWORD must be at least 8 chars.');
    process.exit(1);
  }
  const dbUrl = process.env.DATABASE_URL;
  if (!dbUrl) {
    console.error('[seed-admin] DATABASE_URL is required.');
    process.exit(1);
  }

  // bcrypt cost 12 matches the production hashPassword() in src/auth.ts.
  const passwordHash = await bcrypt.hash(password, 12);

  const sql = postgres(dbUrl, { max: 1 });
  const db = drizzle(sql, { schema });

  try {
    const existing = await db.query.users.findFirst({
      where: eq(schema.users.email, email),
      columns: { id: true },
    });

    if (existing) {
      await db
        .update(schema.users)
        .set({
          passwordHash,
          isAdmin: true,
          mustChangePassword: true,
        })
        .where(eq(schema.users.id, existing.id));
      console.warn(
        `[seed-admin] updated existing user ${email} (id=${existing.id}): isAdmin=true, mustChangePassword=true`,
      );
    } else {
      const id = randomUUID();
      await db.insert(schema.users).values({
        id,
        email,
        name,
        passwordHash,
        isAdmin: true,
        mustChangePassword: true,
        // emailVerified is set since this is an operator-provisioned
        // account — bypasses the welcome-email flow's verification
        // requirement (you already know who this is).
        emailVerified: new Date(),
        plan: 'pro',
      });
      console.warn(
        `[seed-admin] created new admin user ${email} (id=${id})`,
      );
    }
    console.warn(
      '[seed-admin] done. The user must change their password on first login.',
    );
  } finally {
    await sql.end();
  }
}

main().catch((err) => {
  console.error('[seed-admin] failed:', err);
  process.exit(1);
});
