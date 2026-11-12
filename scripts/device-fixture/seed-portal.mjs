// Executed with the locked Portal TypeScript loader and a disposable database.
import { randomBytes, randomUUID } from "node:crypto";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
const source = (name) => pathToFileURL(resolve("src", name)).href;
const { db } = await import(source("services/db.ts"));
const { migrate } = await import(source("services/migrate.ts"));
const { passwordHash, encrypt, hash, base32 } = await import(source("auth/crypto.ts"));
try {
  await migrate();
  const password = passwordHash(process.env.FIXTURE_PASSWORD);
  for (const role of ["administrator", "member"]) {
    const id = randomUUID();
    await db.query(
      "INSERT INTO users(id,email,password_hash,role,mfa_secret) VALUES($1,$2,$3,$4,$5)",
      [
        id,
        role + "@example.invalid",
        password,
        role,
        role === "administrator" ? encrypt(base32(randomBytes(20))) : null,
      ],
    );
    await db.query(
      "INSERT INTO identity_profiles(user_id,display_name,email_verified_at) VALUES($1,$2,now())",
      [id, "Fixture " + role],
    );
    if (role === "member") {
      await db.query(
        "INSERT INTO identity_product_access(user_id,product,role,status) VALUES($1,'farmer','user','active')",
        [id],
      );
    } else {
      for (const code of JSON.parse(process.env.FIXTURE_RECOVERY_CODES)) {
        await db.query(
          "INSERT INTO mfa_recovery(user_id,code_hash) VALUES($1,$2)",
          [id, hash(code)],
        );
      }
    }
  }
} finally {
  await db.end();
}
