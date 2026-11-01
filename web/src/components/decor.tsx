import React from "react";

/* Decorative crown: soft coral shape with highlights, plus sparse coral and
 * lavender confetti and four-point stars, recreated as lightweight SVG from the
 * approved reference. Decorative only: hidden from assistive technology. */

export function Crown({ width = 260 }: { width?: number }) {
  const h = width * 0.62;
  return (
    <svg width={width} height={h} viewBox="0 0 260 162" fill="none" aria-hidden="true" focusable="false">
      {/* soft shadow */}
      <ellipse cx="130" cy="150" rx="70" ry="7" fill="#c7adff" opacity="0.25" />
      {/* crown body */}
      <path
        d="M36 118 C 30 108, 34 96, 40 78 C 46 62, 54 44, 60 32 C 63 26, 69 25, 73 30 C 88 48, 102 66, 112 78 C 118 60, 124 44, 132 30 C 136 22, 144 22, 148 30 C 154 44, 160 60, 166 76 C 178 64, 192 50, 208 36 C 214 31, 221 34, 222 41 C 226 68, 232 96, 226 112 C 220 128, 200 136, 170 140 C 140 144, 90 144, 64 136 C 48 131, 40 126, 36 118 Z"
        fill="url(#coralGrad)"
      />
      {/* highlights */}
      <path d="M60 60 C 64 50, 66 42, 68 38 C 72 40, 74 48, 76 56 C 72 62, 64 64, 60 60 Z" fill="#ff9d8d" opacity="0.9" />
      <path d="M138 44 C 140 38, 143 32, 146 28 C 150 32, 152 40, 153 48 C 148 52, 141 50, 138 44 Z" fill="#ff9d8d" opacity="0.9" />
      <path d="M214 46 C 216 54, 218 64, 218 72 C 212 72, 206 66, 205 58 C 208 52, 211 48, 214 46 Z" fill="#ff9d8d" opacity="0.85" />
      <defs>
        <linearGradient id="coralGrad" x1="130" y1="20" x2="130" y2="145" gradientUnits="userSpaceOnUse">
          <stop stopColor="#FF7A61" />
          <stop offset="1" stopColor="#F5543C" />
        </linearGradient>
      </defs>
    </svg>
  );
}

export function Confetti({ seed }: { seed?: number }) {
  // Sparse confetti dots and stars around the crown, echoing the reference layout.
  const s = seed ?? 1;
  const rotate = (s * 360) % 360;
  return (
    <svg width="320" height="300" viewBox="0 0 320 300" fill="none" aria-hidden="true" focusable="false" style={{ position: "absolute", inset: 0, width: "100%", height: "100%", pointerEvents: "none", overflow: "visible" }}>
      <g transform={`rotate(${rotate} 160 150)`}>
        {/* coral dashes */}
        <rect x="86" y="30" width="34" height="10" rx="5" fill="#FF684F" transform="rotate(-40 103 35)" />
        <rect x="248" y="18" width="30" height="10" rx="5" fill="#FF684F" transform="rotate(35 263 23)" />
        <rect x="24" y="120" width="30" height="10" rx="5" fill="#FF684F" transform="rotate(-60 39 125)" />
        <rect x="276" y="150" width="34" height="10" rx="5" fill="#FF684F" transform="rotate(-30 293 155)" />
        <rect x="36" y="240" width="34" height="10" rx="5" fill="#FF684F" transform="rotate(40 53 225)" />
        <rect x="258" y="236" width="30" height="10" rx="5" fill="#FF684F" transform="rotate(-45 273 221)" />
        {/* lavender dashes */}
        <rect x="66" y="176" width="36" height="12" rx="6" fill="#C7ADFF" transform="rotate(30 84 182)" />
        <rect x="284" y="96" width="36" height="12" rx="6" fill="#C7ADFF" transform="rotate(-55 302 102)" />
        <rect x="288" y="206" width="32" height="11" rx="5" fill="#C7ADFF" transform="rotate(20 304 211)" />
        {/* purple star */}
        <path d="M120 214 l6 14 14 6 -14 6 -6 14 -6 -14 -14-6 14 -6 z" fill="#A98BE8" transform="translate(-38 -38) scale(1.08)" />
        {/* coral star */}
        <path d="M262 178 l5 11 11 5 -11 5 -5 11 -5 -11 -11 -5 11 -5 z" fill="#FF684F" />
      </g>
    </svg>
  );
}

export function Wordmark({ size = "xl" }: { size?: "xl" | "lg" }) {
  return (
    <h1 className={`wordmark wordmark-${size}`} style={size === "xl" ? { marginTop: 4 } : undefined}>
      {size === "lg" ? (
        <span>EMPIRE</span>
      ) : (
        <span style={{ display: "inline-flex", gap: "0.01em" }}>EMPIRE</span>
      )}
    </h1>
  );
}

/** Home hero: wordmark + crown/confetti composition matching the reference. */
export function HomeHero() {
  return (
    <div className="hero" style={{ position: "relative", width: "100%", maxWidth: 360 }}>
      <Wordmark size="xl" />
      {/* Fixed-height stage so confetti (320x300 canvas) can't spill onto the CTAs. */}
      <div style={{ position: "relative", width: "100%", height: 272, display: "flex", justifyContent: "center" }}>
        <Confetti />
        <div className="hero-crown" style={{ marginTop: 55 }}>
          <Crown />
        </div>
      </div>
    </div>
  );
}
