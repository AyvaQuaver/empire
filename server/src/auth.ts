import crypto from "node:crypto";
import { config } from "./config.js";
import type { DB } from "./db.js";

// scrypt password hashing via the Node standard library — no invented crypto.
// Format: scrypt$<salt hex>$<key hex>, with an application pepper from the environment.

function scrypt(password: string, salt: string, keylen: number): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    crypto.scrypt(password, salt, keylen, (err, key) =>
      err ? reject(err) : resolve(key),
    );
  });
}

export async function hashPassword(password: string): Promise<string> {
  const salt = crypto.randomBytes(16).toString("hex");
  const key = await scrypt(password, salt + pepper(), 64);
  return `scrypt$${salt}$${key.toString("hex")}`;
}

export async function verifyPassword(password: string, stored: string): Promise<boolean> {
  const parts = stored.split("$");
  if (parts.length !== 3 || parts[0] !== "scrypt") return false;
  const salt = parts[1];
  const expected = parts[2];
  const actual = await scrypt(password, salt + pepper(), 64);
  return crypto.timingSafeEqual(actual, Buffer.from(expected, "hex"));
}

// Equal-cost work for unknown accounts, so sign-in timing does not enumerate users.
export async function dummyHashWork(): Promise<void> {
  await hashPassword("dummy-password-equal-cost");
}

function pepper(): string {
  return config.sessionSecret;
}

export interface UserData {
  id: string;
  username: string;
  username_canonical: string;
  email: string;
  email_canonical: string;
  email_verified_at: number | null;
  created_at: number;
}

export function getUser(db: DB, id: string): UserData | null {
  const row = db
    .prepare(
      "SELECT id, username, username_canonical, email, email_canonical, email_verified_at, created_at FROM users WHERE id = ?",
    )
    .get(id) as UserData | undefined;
  return row ?? null;
}
