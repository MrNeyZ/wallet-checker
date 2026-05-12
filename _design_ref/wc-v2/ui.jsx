/* global React */
const { useState, useEffect, useMemo, useRef } = React;

// ── Icons (inline tiny SVGs) ───────────────────────────────
function Icon({ name, size = 14, ...rest }) {
  const stroke = "currentColor";
  const sw = 1.6;
  const map = {
    search: <><circle cx="11" cy="11" r="6"/><path d="m20 20-3.5-3.5"/></>,
    plus: <><path d="M12 5v14"/><path d="M5 12h14"/></>,
    flame: <><path d="M12 22c4 0 7-3 7-6.5 0-2.5-2-4-3-6-1-2 .5-3.5-1-5-1 2-3 3-3 6-1-2-3-2-3 0 0 4-3 5-3 7 0 3 3 4.5 6 4.5z"/></>,
    chevron: <><path d="m6 9 6 6 6-6"/></>,
    chevronR: <><path d="m9 6 6 6-6 6"/></>,
    x: <><path d="M18 6 6 18"/><path d="m6 6 12 12"/></>,
    check: <><path d="M20 6 9 17l-5-5"/></>,
    refresh: <><path d="M3 12a9 9 0 0 1 15-6.7L21 8"/><path d="M21 3v5h-5"/><path d="M21 12a9 9 0 0 1-15 6.7L3 16"/><path d="M3 21v-5h5"/></>,
    settings: <><circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 1 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 1 1-4 0v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 1 1-2.83-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 1 1 0-4h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 1 1 2.83-2.83l.06.06a1.65 1.65 0 0 0 1.82.33H9a1.65 1.65 0 0 0 1-1.51V3a2 2 0 1 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 1 1 2.83 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82V9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 1 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z"/></>,
    alert: <><path d="M12 9v4"/><path d="M12 17h.01"/><path d="m4.93 19 7.07-13 7.07 13H4.93z"/></>,
    wallet: <><path d="M3 7a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2v10a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V7z"/><path d="M16 13h.01"/></>,
    copy: <><rect x="9" y="9" width="11" height="11" rx="2"/><path d="M5 15V5a2 2 0 0 1 2-2h10"/></>,
    ext: <><path d="M15 3h6v6"/><path d="M10 14 21 3"/><path d="M21 14v5a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5"/></>,
    filter: <><path d="M3 6h18"/><path d="M7 12h10"/><path d="M10 18h4"/></>,
  };
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke={stroke} strokeWidth={sw} strokeLinecap="round" strokeLinejoin="round" {...rest}>
      {map[name] || null}
    </svg>
  );
}

function Logo() {
  return (
    <div className="vl-logo" aria-label="VictoryLabs">
      <span className="v">Victory</span><span className="l">Labs</span>
    </div>
  );
}

function TopNav({ tab, onTab, wallet, onConnect, onDisconnect }) {
  return (
    <header className="vl-topnav">
      <div className="vl-topnav-inner">
        <div className="row gap-lg">
          <Logo/>
          <nav className="vl-topnav-tabs" role="tablist">
            {["Groups","Burner","Activity","Alerts"].map(t => (
              <button key={t} role="tab"
                onClick={() => onTab(t.toLowerCase())}
                className={`vl-topnav-tab ${tab === t.toLowerCase() ? "is-active" : ""}`}>
                {t}
              </button>
            ))}
          </nav>
        </div>
        <div className="vl-topnav-right">
          <span className="vl-conn-pill hide-mobile">
            <span className="dot"/> mainnet · helius
          </span>
          {wallet ? (
            <button className="vl-conn-pill" onClick={onDisconnect} title="Disconnect">
              <span className="ico" style={{
                width: 14, height: 14, borderRadius: "50%",
                background: "linear-gradient(135deg, var(--vl-purple), #e42575)"
              }}/>
              {wallet.slice(0,4)}…{wallet.slice(-4)}
            </button>
          ) : (
            <button className="vl-btn vl-btn-primary is-sm" onClick={onConnect}>
              <Icon name="wallet" size={12}/> Connect
            </button>
          )}
        </div>
      </div>
    </header>
  );
}

// ── Reusable bits ──────────────────────────────────────
function Badge({ tone = "neutral", children }) {
  return <span className={`vl-badge is-${tone}`}>{children}</span>;
}
function Label({ children, className = "" }) {
  return <div className={`vl-label ${className}`}>{children}</div>;
}
function StatTile({ label, value, sub, accent, loading }) {
  return (
    <div className="vl-tile col gap-sm" style={{ minWidth: 0 }}>
      <Label>{label}</Label>
      {loading ? (
        <div className="vl-skel" style={{ height: 22, width: "60%" }}/>
      ) : (
        <div className={`vl-stat-value ${accent ? `is-${accent}` : ""}`}>{value}</div>
      )}
      {sub && <div className="mono" style={{ fontSize: 10, color: "var(--vl-fg-4)" }}>{sub}</div>}
    </div>
  );
}
function Check({ checked, indeterminate, onChange, ...rest }) {
  const ref = useRef(null);
  useEffect(() => { if (ref.current) ref.current.indeterminate = !!indeterminate; }, [indeterminate]);
  return (
    <input ref={ref} type="checkbox" className={`vl-check ${indeterminate ? "is-indeterminate" : ""}`}
      checked={!!checked} onChange={onChange} {...rest}/>
  );
}

// ── Floating layout-mode switcher (mirrors live-feed/Gate FloatingLayoutModeSwitcher) ──
// Three modes: pc / laptop / phone. Persists in localStorage 'vl.layoutMode'.
// Applies `data-layout="<mode>"` on <html>. CSS reads that attribute to
// retarget a small set of layout tokens and rules. Default = laptop.
const LAYOUT_MODES = [
  { key: "pc",     label: "PC",     title: "2560×1440 — 27–32 in monitor" },
  { key: "laptop", label: "Laptop", title: "1920×1080 — 13 in (default)" },
  { key: "phone",  label: "Phone",  title: "Mobile viewport" },
];
function readLayoutMode() {
  try {
    const v = localStorage.getItem("vl.layoutMode");
    return (v === "pc" || v === "laptop" || v === "phone") ? v : "laptop";
  } catch { return "laptop"; }
}
function applyLayoutMode(m) {
  if (typeof document !== "undefined") document.documentElement.dataset.layout = m;
}
function FloatingLayoutModeSwitcher() {
  const [mode, setMode] = useState("laptop");
  const btnRefs = useRef([]);
  const [pill, setPill] = useState({ left: 0, width: 0, primed: false });
  useEffect(() => { const m = readLayoutMode(); setMode(m); applyLayoutMode(m); }, []);
  useEffect(() => {
    const idx = LAYOUT_MODES.findIndex(m => m.key === mode);
    const el = btnRefs.current[idx];
    if (!el) return;
    setPill(prev => ({ left: el.offsetLeft, width: el.offsetWidth, primed: prev.primed || true }));
  }, [mode]);
  const pick = (m) => {
    setMode(m);
    try { localStorage.setItem("vl.layoutMode", m); } catch {}
    applyLayoutMode(m);
  };
  return (
    <div role="group" aria-label="UI layout mode" style={{
      position: "fixed", right: 12, bottom: 32, zIndex: 9999,
      display: "inline-flex", alignItems: "center",
      padding: 2, gap: 2, borderRadius: 5,
      border: "1px solid rgba(168,144,232,0.45)",
      background: "rgba(20,14,34,0.94)",
      backdropFilter: "blur(8px)",
      boxShadow: "0 4px 14px rgba(0,0,0,0.5), 0 0 0 1px rgba(168,144,232,0.14)",
    }}>
      <span aria-hidden style={{
        position: "absolute", top: 2, bottom: 2,
        left: pill.left, width: pill.width,
        background: "rgba(168,144,232,0.22)",
        border: "1px solid rgba(168,144,232,0.35)",
        borderRadius: 3,
        transition: pill.primed
          ? "left 0.22s cubic-bezier(0.4,0,0.2,1), width 0.22s cubic-bezier(0.4,0,0.2,1)"
          : "none",
        pointerEvents: "none", zIndex: 0,
      }}/>
      {LAYOUT_MODES.map((m, i) => (
        <button key={m.key} ref={el => { btnRefs.current[i] = el; }}
          type="button" title={m.title} onClick={() => pick(m.key)}
          style={{
            position: "relative", zIndex: 1,
            padding: "3px 7px", fontSize: 9.5, fontWeight: 700,
            letterSpacing: "0.4px", borderRadius: 3,
            border: "none", background: "transparent",
            color: mode === m.key ? "#d0c8e4" : "#8f8fa8",
            cursor: "pointer", textTransform: "uppercase",
            transition: "color 0.18s ease",
            fontFamily: "inherit", minWidth: 32,
          }}>{m.label}</button>
      ))}
    </div>
  );
}

window.UI = { Icon, Logo, TopNav, Badge, Label, StatTile, Check, FloatingLayoutModeSwitcher };
