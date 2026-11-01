import React, { useEffect, useState } from "react";
import { ApiError } from "../lib/api";

export function Button(props: React.ButtonHTMLAttributes<HTMLButtonElement> & { loading?: boolean }) {
  const { className, loading, children, disabled, ...rest } = props;
  return (
    <button className={`btn ${className ?? ""}`} disabled={disabled || loading} aria-busy={loading || undefined} {...rest}>
      {children}
      {loading ? <Spinner dot /> : null}
    </button>
  );
}

export function CtaButton(props: React.AnchorHTMLAttributes<HTMLAnchorElement> & { tone?: "primary" | "secondary" }) {
  const { tone = "primary", children, ...rest } = props;
  return (
    <a className={`btn btn-${tone} btn-cta`} {...rest}>
      {children}
      <span className="arrow" aria-hidden="true">
        →
      </span>
    </a>
  );
}

export function Spinner({ dot }: { dot?: boolean }) {
  return <span aria-hidden="true">{dot ? "•" : "…"}</span>;
}

export function Field({
  label,
  error,
  children,
  hint,
}: {
  label: string;
  error?: string | null;
  hint?: string;
  children: React.ReactNode;
}) {
  const id = React.useId();
  return (
    <div className="field">
      <label htmlFor={id}>{label}</label>
      {children}
      {error && (
        <p className="error-text" role="alert">
          <span aria-hidden="true">⚠</span> {error}
        </p>
      )}
      {hint && <p className="status-text">{hint}</p>}
    </div>
  );
}

export interface InputProps extends React.InputHTMLAttributes<HTMLInputElement> {
  invalid?: boolean;
}

export function Input({ invalid, className, ...rest }: InputProps) {
  const id = React.useId();
  void id;
  return <input className={`input ${className ?? ""}`} aria-invalid={invalid || undefined} {...rest} />;
}

export function Panel({ className, children, heading }: { className?: string; children: React.ReactNode; heading?: string }) {
  return (
    <section className={`panel ${className ?? ""}`}>
      {heading ? <h3 className="panel-heading">{heading}</h3> : null}
      {children}
    </section>
  );
}

export function Modal({
  title,
  open,
  onClose,
  children,
}: {
  title: string;
  open: boolean;
  onClose?: () => void;
  children: React.ReactNode;
}) {
  if (!open) return null;
  return (
    <div className="modal-backdrop" role="dialog" aria-modal="true" aria-label={title}>
      <div className="modal">
        <h2 style={{ fontSize: 22 }}>{title}</h2>
        {children}
        {onClose && (
          <Button className="btn-small btn-secondary" onClick={onClose}>
            Back
          </Button>
        )}
      </div>
    </div>
  );
}

export function ErrorBanner({ error }: { error: string | null | ApiError }) {
  if (!error) return null;
  const message = typeof error === "string" ? error : error.message;
  return (
    <p className="error-text" role="alert">
      <span aria-hidden="true">⚠</span> {message}
    </p>
  );
}

const avatarPalette = ["avatar-lav", "avatar-coral", "avatar-panel"] as const;

export function Avatar({ name, playerId }: { name: string; playerId: string }) {
  const idx = Math.abs([...playerId].reduce((a, c) => a + c.charCodeAt(0), 0)) % 3;
  const initials = name
    .split(/\s+/)
    .map((w) => w[0])
    .slice(0, 2)
    .join("")
    .toUpperCase();
  return (
    <span className={`avatar ${avatarPalette[idx]}`} aria-hidden="true">
      {initials}
    </span>
  );
}

export function ReadyBadge({ ready }: { ready: boolean | null }) {
  if (ready === null) return null;
  return (
    <span className={`badge ${ready ? "badge-lavender" : "badge-coral"}`}>{ready ? "Word saved" : "Waiting"}</span>
  );
}

export function useNow(pollMs = 30000): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), pollMs);
    return () => clearInterval(t);
  }, [pollMs]);
  return now;
}
