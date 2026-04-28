"use client";

// Gate — visual port of VictoryLabs' Gate.tsx (1:1).
//
// Source: https://github.com/MrNeyZ/nft-live-feed/blob/main/frontend/src/runtime/Gate.tsx
//
// Differences vs. upstream:
//   - Wallet detection / connect / address display / change-wallet — REMOVED.
//   - Mode-select screen — REMOVED.
//   - Auth = single passphrase compared server-side against WEB_PASSWORD via
//     the existing loginAction (web/app/login/actions.ts). On success the
//     server action redirects; on failure it returns { ok: false, error }
//     and we surface that in the .vl-error slot.
//
// The CSS string (GATE_CSS) is verbatim from upstream — every gate-* and
// vl-* class is preserved. Only the JSX was reshaped to drop the wallet
// step, so layout / spacing / fonts / animations are pixel-identical.

import { useRef, useState, useTransition } from "react";

interface LoginFormProps {
  next: string;
  action: (formData: FormData) => Promise<{ ok: false; error: string } | void>;
}

export default function LoginForm({ next, action }: LoginFormProps) {
  const [pw, setPw] = useState("");
  const [err, setErr] = useState<string | null>(null);
  const [pending, startTransition] = useTransition();
  const formRef = useRef<HTMLFormElement | null>(null);

  function onSubmit(formData: FormData) {
    setErr(null);
    startTransition(async () => {
      const result = await action(formData);
      if (result && result.ok === false) setErr(result.error);
    });
  }

  const busy = pending;
  const canSubmit = pw.length > 0 && !busy;

  return (
    <>
      <style>{GATE_CSS}</style>
      <div className="gate-root">
        <div className="gate-stage gate-reveal">
          <Wordmark />
          <div className="gate-hero-stack">
            <h1 className="gate-headline">Access Required</h1>
            <p className="gate-sub">
              Sign in with your passphrase to enter the control plane.
            </p>
          </div>

          <form ref={formRef} action={onSubmit} className="gate-form">
            <input type="hidden" name="next" value={next} />
            <div className="vl-wallet-field">
              <span className="vl-dot" />
              <input
                autoFocus
                type="password"
                name="password"
                className="vl-passphrase"
                placeholder="enter passphrase"
                value={pw}
                onChange={(e) => setPw(e.target.value)}
                disabled={busy}
                autoComplete="current-password"
              />
              <button
                type="submit"
                className="vl-arrow"
                disabled={!canSubmit}
                aria-label="Enter"
              >
                {busy ? <Dots /> : "→"}
              </button>
            </div>
            <div className="gate-field-row">
              {err ? (
                <div className="vl-error">
                  <span className="vl-err-dot" />
                  {err.toLowerCase()}
                </div>
              ) : (
                <span />
              )}
              <span />
            </div>
          </form>
        </div>
      </div>
    </>
  );
}

const Dots = () => (
  <span style={{ letterSpacing: 4, fontSize: 14 }}>
    <span className="gate-dot">.</span>
    <span className="gate-dot">.</span>
    <span className="gate-dot">.</span>
  </span>
);

// VictoryLabs wordmark — verbatim from upstream Gate.tsx.
// Source PNG must live at /web/public/brand/victorylabs.png so this
// resolves to /brand/victorylabs.png at runtime. See deploy notes.
function Wordmark() {
  return (
    <img
      src="/brand/victorylabs.png"
      alt="VictoryLabs"
      width={264}
      height={79}
      className="vl-wordmark"
      draggable={false}
    />
  );
}

// ── Handoff CSS (verbatim port from upstream Gate.tsx) ─────────────────────
// Do not refactor. Class names (gate-*, vl-*) are kept unchanged so the
// visual layer is byte-identical to the source.

const GATE_CSS = `
@import url('https://fonts.googleapis.com/css2?family=Playfair+Display:wght@700&display=swap');

.gate-root, .gate-root *, .gate-root *::before, .gate-root *::after {
  box-sizing: border-box;
}
.gate-root {
  position: fixed; inset: 0;
  min-height: 100vh;
  padding: 60px 24px;
  display: flex; align-items: center; justify-content: center;
  color: #aaaabf;
  font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif;
  font-size: 11px;
  background: #050308;
  background-image:
    radial-gradient(ellipse 140% 55% at 65% -5%, rgba(80, 50, 150, 0.10) 0%, transparent 65%),
    radial-gradient(ellipse 70%  40% at  5% 90%, rgba(50, 30, 100, 0.07) 0%, transparent 60%);
  overflow-x: hidden;
  overflow-y: auto;
}
.gate-root::before {
  content: "";
  position: absolute; inset: 0; pointer-events: none;
  background:
    radial-gradient(ellipse 50% 40% at 50% 65%, rgba(128, 104, 216, 0.08) 0%, transparent 70%);
}

/* Animations */
@keyframes gateBusyDots {
  0%, 80%, 100% { opacity: 0.25; transform: translateY(0); }
  40%           { opacity: 1;    transform: translateY(-1px); }
}
.gate-dot       { animation: gateBusyDots 1.2s infinite both; display: inline-block; }
.gate-dot:nth-child(2) { animation-delay: 0.15s; }
.gate-dot:nth-child(3) { animation-delay: 0.30s; }

@keyframes gateReveal {
  from { opacity: 0; transform: translateY(6px); }
  to   { opacity: 1; transform: none; }
}
.gate-reveal { animation: gateReveal 0.22s ease-out both; }

/* Wordmark — text fallback; layout-equivalent slot. */
.vl-wordmark {
  display: block;
  user-select: none;
}

/* Primary CTA — kept from upstream so future buttons can opt in via .vl-cta. */
.vl-cta {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  min-width: 260px;
  height: 52px;
  padding: 0 28px;
  font-family: inherit;
  font-size: 12.5px;
  font-weight: 700;
  letter-spacing: 2.5px;
  text-transform: uppercase;
  color: #0c0a1a;
  background: linear-gradient(180deg, #c2a8f5 0%, #9378dd 100%);
  border: 1px solid rgba(255, 255, 255, 0.18);
  border-radius: 8px;
  cursor: pointer;
  box-shadow:
    0 1px 0 rgba(255, 255, 255, 0.22) inset,
    0 -1px 0 rgba(0, 0, 0, 0.22) inset,
    0 2px 0 rgba(22, 14, 42, 0.75),
    0 6px 14px -4px rgba(128, 104, 216, 0.45);
  transition: transform 0.14s, box-shadow 0.14s, background 0.14s;
}
.vl-cta:hover:not([disabled]) {
  transform: translateY(-1px);
  background: linear-gradient(180deg, #cdb6f8 0%, #9f84e8 100%);
  box-shadow:
    0 1px 0 rgba(255, 255, 255, 0.28) inset,
    0 -1px 0 rgba(0, 0, 0, 0.22) inset,
    0 3px 0 rgba(22, 14, 42, 0.75),
    0 8px 16px -4px rgba(128, 104, 216, 0.55);
}
.vl-cta:active:not([disabled]) {
  transform: translateY(1px);
  background: linear-gradient(180deg, #9378dd 0%, #7a63c4 100%);
  box-shadow:
    0 1px 0 rgba(255, 255, 255, 0.08) inset,
    0 0 0 rgba(22, 14, 42, 0.75),
    0 3px 8px -3px rgba(128, 104, 216, 0.3);
}
.vl-cta[disabled] {
  cursor: not-allowed;
  color: #4a4766;
  background: linear-gradient(180deg, #332a4d 0%, #241e39 100%);
  border-color: rgba(255, 255, 255, 0.05);
  box-shadow: 0 1px 0 rgba(255, 255, 255, 0.04) inset, 0 2px 0 rgba(10, 6, 20, 0.5);
  transform: none;
}

/* Wallet field (now hosts only the passphrase input + arrow submit) */
.vl-wallet-field {
  display: flex;
  align-items: stretch;
  gap: 0;
  width: 100%;
  max-width: 420px;
  height: 52px;
  border: 1px solid rgba(168, 144, 232, 0.22);
  border-radius: 10px;
  background:
    linear-gradient(180deg, rgba(26, 20, 48, 0.7) 0%, rgba(18, 13, 36, 0.7) 100%);
  box-shadow:
    inset 0 1px 0 rgba(255, 255, 255, 0.04),
    0 8px 24px -8px rgba(0, 0, 0, 0.55);
  overflow: hidden;
  transition: border-color 0.14s, box-shadow 0.14s;
}
.vl-wallet-field:focus-within {
  border-color: rgba(168, 144, 232, 0.5);
  box-shadow:
    inset 0 1px 0 rgba(255, 255, 255, 0.05),
    0 0 0 1px rgba(168, 144, 232, 0.25),
    0 8px 24px -8px rgba(0, 0, 0, 0.55);
}
.vl-wallet-field .vl-dot {
  flex-shrink: 0;
  align-self: center;
  width: 6px; height: 6px;
  margin-left: 14px;
  border-radius: 50%;
  background: #a890e8;
  box-shadow: 0 0 10px rgba(168, 144, 232, 0.8);
}
.vl-wallet-field .vl-wallet-text {
  align-self: center;
  padding: 0 12px;
  font-family: 'SF Mono', 'Fira Code', monospace;
  font-size: 12.5px;
  font-weight: 500;
  color: #c4b3f0;
  letter-spacing: 0.2px;
  flex-shrink: 0;
  min-width: 0;
  border-right: 1px solid rgba(168, 144, 232, 0.14);
  margin-right: 2px;
  height: 32px; display: flex; align-items: center;
}
.vl-wallet-field input.vl-passphrase {
  flex: 1;
  min-width: 0;
  padding: 0 14px;
  background: transparent;
  border: none;
  outline: none;
  font-family: inherit;
  font-size: 13.5px;
  color: #e8e6f2;
  caret-color: #a890e8;
  letter-spacing: 0.2px;
}
.vl-wallet-field input.vl-passphrase::placeholder {
  color: #55556a;
  letter-spacing: 0.5px;
}
.vl-wallet-field input.vl-passphrase:disabled {
  color: #55556e;
}

/* 3D arrow button, right-aligned inside the wallet field */
.vl-arrow {
  flex-shrink: 0;
  width: 44px;
  height: 44px;
  align-self: center;
  margin-right: 4px;
  display: flex; align-items: center; justify-content: center;
  font-family: inherit;
  font-size: 16px;
  font-weight: 600;
  color: #0c0a1a;
  background: linear-gradient(180deg, #c2a8f5 0%, #9378dd 100%);
  border: 1px solid rgba(255, 255, 255, 0.18);
  border-radius: 8px;
  cursor: pointer;
  box-shadow:
    0 1px 0 rgba(255, 255, 255, 0.22) inset,
    0 -1px 0 rgba(0, 0, 0, 0.22) inset,
    0 2px 0 rgba(22, 14, 42, 0.75),
    0 6px 14px -4px rgba(128, 104, 216, 0.45);
  transition: transform 0.14s, box-shadow 0.14s, background 0.14s;
}
.vl-arrow:hover:not([disabled]) {
  transform: translateY(-1px);
  background: linear-gradient(180deg, #cdb6f8 0%, #9f84e8 100%);
  box-shadow:
    0 1px 0 rgba(255, 255, 255, 0.28) inset,
    0 -1px 0 rgba(0, 0, 0, 0.22) inset,
    0 3px 0 rgba(22, 14, 42, 0.75),
    0 8px 16px -4px rgba(128, 104, 216, 0.55);
}
.vl-arrow:active:not([disabled]) {
  transform: translateY(1px);
  box-shadow:
    0 1px 0 rgba(255, 255, 255, 0.08) inset,
    0 0 0 rgba(22, 14, 42, 0.75),
    0 3px 8px -3px rgba(128, 104, 216, 0.3);
  background: linear-gradient(180deg, #9378dd 0%, #7a63c4 100%);
}
.vl-arrow[disabled] {
  cursor: not-allowed;
  color: #4a4766;
  background: linear-gradient(180deg, #332a4d 0%, #241e39 100%);
  box-shadow: 0 1px 0 rgba(255, 255, 255, 0.04) inset, 0 2px 0 rgba(10, 6, 20, 0.5);
  transform: none;
}

.vl-change {
  background: none; border: none; cursor: pointer;
  font-family: 'SF Mono', 'Fira Code', monospace;
  font-size: 10px;
  font-weight: 500;
  letter-spacing: 1.5px;
  color: #6a6a84;
  padding: 4px 2px;
  transition: color 0.12s;
  align-self: flex-end;
}
.vl-change:hover { color: #c4b3f0; }

.vl-error {
  display: flex; align-items: center; gap: 8px;
  font-family: 'SF Mono', 'Fira Code', monospace;
  font-size: 11px;
  color: #d87575;
  letter-spacing: 0.5px;
}
.vl-error .vl-err-dot {
  width: 6px; height: 6px; border-radius: 50%;
  background: #d87575; box-shadow: 0 0 8px rgba(216, 117, 117, 0.5);
}

/* Stage + supporting layout (matches upstream's v2 column) */
.gate-stage {
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 44px;
  width: 100%;
  max-width: 460px;
  position: relative;
  z-index: 1;
}
.gate-hero-stack {
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 14px;
}
.gate-headline {
  font-family: 'Playfair Display', 'Georgia', serif;
  font-size: 44px;
  font-weight: 700;
  letter-spacing: -1px;
  line-height: 1.05;
  color: #f4f2fa;
  text-align: center;
  text-shadow: 0 0 24px rgba(168, 144, 232, 0.14);
  margin: 0;
}
.gate-sub {
  font-size: 13px;
  color: #8888a8;
  letter-spacing: 0.2px;
  text-align: center;
  max-width: 340px;
  line-height: 1.55;
  margin: 0;
}
.gate-form {
  display: flex;
  flex-direction: column;
  align-items: stretch;
  gap: 10px;
  width: 100%;
  max-width: 420px;
}
.gate-field-row {
  display: flex;
  justify-content: space-between;
  align-items: center;
  min-height: 18px;
}
`;
