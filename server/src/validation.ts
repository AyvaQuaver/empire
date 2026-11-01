import { AppError, ERR } from "./errors.js";

// Trim, collapse whitespace and NFKC-normalize. Reject control characters.
// Comparison is case-insensitive via a lowercase canonical form.
export type ValidationOk = { ok: true; display: string; normalized: string };
export type ValidationFail = {
  ok: false;
  code: string;
  message: string;
  field?: string;
};

export function normalizeText(value: unknown, maxLength: number, field: string): ValidationOk | ValidationFail {
  if (typeof value !== "string") {
    return fail("VALIDATION", "Please fill in this field.", field);
  }
  const text = value.normalize("NFKC").trim().replace(/\s+/g, " ");
  // Reject anything with remaining control characters (spec requirement).
  if (/[\u0000-\u001f\u007f-\u009f]/.test(text)) {
    return fail("VALIDATION", "This field contains characters that are not allowed.", field);
  }
  if (text.length === 0) return fail("VALIDATION", "Please fill in this field.", field);
  if (text.length > maxLength) {
    return fail("VALIDATION", `Keep this under ${maxLength} characters.`, field);
  }
  return { ok: true, display: text, normalized: text.toLowerCase() };
}

export function normalizeWord(value: unknown) {
  return normalizeText(value, 40, "word");
}

export function validateUsername(value: unknown): ValidationOk | ValidationFail {
  const base = normalizeText(value, 24, "username");
  if (!base.ok) return base;
  if (!/^[A-Za-z0-9_]{3,24}$/.test(base.display)) {
    return fail(
      "VALIDATION",
      "Use 3–24 letters, numbers or underscores (no spaces or symbols).",
      "username",
    );
  }
  return base;
}

export function passwordStrength(value: unknown): ValidationOk | ValidationFail {
  if (typeof value !== "string") return fail("VALIDATION", "Please enter a password.", "password");
  if (value.length < 8) return fail("VALIDATION", "Use at least 8 characters.", "password");
  if (value.length > 200) return fail("VALIDATION", "Use fewer than 200 characters.", "password");
  return { ok: true, display: value, normalized: value };
}

function fail(code: string, message: string, field?: string): ValidationFail {
  return { ok: false, code, message, field };
}

export function toAppError(v: ValidationFail): AppError {
  return new AppError(v.code, 400, v.message, v.field ? { field: v.field } : undefined);
}

export { ERR };
