export class AppError extends Error {
  code: string;
  status: number;
  details?: Record<string, unknown>;

  constructor(code: string, status: number, message: string, details?: Record<string, unknown>) {
    super(message);
    this.code = code;
    this.status = status;
    this.details = details;
  }
}

// Stable error codes the client maps to friendly copy.
export const ERR = {
  UNAUTHENTICATED: "UNAUTHENTICATED",
  FORBIDDEN: "FORBIDDEN",
  NOT_FOUND: "NOT_FOUND",
  VALIDATION: "VALIDATION",
  RATE_LIMITED: "RATE_LIMITED",
  CONFLICT: "CONFLICT",
  STATE: "STATE",
  WORD_TAKEN: "WORD_TAKEN",
  NAME_TAKEN: "NAME_TAKEN",
  ROOM_FULL: "ROOM_FULL",
  TOO_FEW_PLAYERS: "TOO_FEW_PLAYERS",
  ROOM_STARTED: "ROOM_STARTED",
  LOCKED: "LOCKED",
  EXPIRED: "EXPIRED",
  CANCELLED: "CANCELLED",
  SPEAKER_ACTIVE: "SPEAKER_ACTIVE",
  USERNAME_TAKEN: "USERNAME_TAKEN",
  EMAIL_TAKEN: "EMAIL_TAKEN",
  INVALID_CREDENTIALS: "INVALID_CREDENTIALS",
  INVALID_TOKEN: "INVALID_TOKEN",
  EMAIL_FAILED: "EMAIL_FAILED",
  INTERNAL: "INTERNAL",
} as const;
