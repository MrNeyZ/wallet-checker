/* global React, UI, MOCK */
const { useState, useEffect, useMemo, useRef } = React;
const { Icon, Badge, Label, StatTile, Check } = UI;

// ════════════════════════════════════════════════════════════════
// BURNER PAGE — single wallet, 4 tabs, NFT/SPL/empty, sticky bar
// ════════════════════════════════════════════════════════════════
const BURN_TABS = [
  { key: "nfts", label: "NFTs", filter: t => t.type === "NFT" || t.type === "pNFT" },
  { key: "core", label: "Core", filter: t => t.type === "Core" },
  { key: "tokens", label: "Tokens" },
  { key: "empty", label: "Empty Accounts" },
];

function BurnerPage({ wallet, onConnect }) {
  const [tab, setTab] = useState("nfts");
  const [scanState, setScanState] = useState("idle"); // idle | scanning | done
  const [scanProgress, setScanProgress] = useState(0);
  const [scanStep, setScanStep] = useState(0);
  const [selected, setSelected] = useState(new Set());
  const [confirming, setConfirming] = useState(false);

  // Auto-run a scan demo on connect, advance through scan steps
  useEffect(() => {
    if (!wallet) { setScanState("idle"); setScanProgress(0); setSelected(new Set()); return; }
    if (scanState !== "idle") return;
    setScanState("scanning");
    setScanProgress(0); setScanStep(0);
    const steps = ["RPC accounts", "DAS NFTs", "pNFT discovery", "Core assets", "SPL classify", "Audit"];
    let p = 0; let s = 0;
    const id = setInterval(() => {
      p += 6 + Math.random() * 10;
      if (p > (s + 1) * (100 / steps.length)) s = Math.min(s + 1, steps.length - 1);
      setScanProgress(Math.min(p, 100));
      setScanStep(s);
      if (p >= 100) { clearInterval(id); setScanState("done"); }
    }, 220);
    return () => clearInterval(id);
  }, [wallet]);

  const rescan = () => { setScanState("idle"); setSelected(new Set()); };

  // Filter items per tab
  const items = useMemo(() => {
    if (tab === "nfts") return MOCK.nfts.filter(n => n.type === "NFT" || n.type === "pNFT");
    if (tab === "core") return MOCK.nfts.filter(n => n.type === "Core");
    if (tab === "tokens") return MOCK.splFungible;
    return MOCK.emptyAccounts;
  }, [tab]);

  const itemIds = items.map(i => i.id);
  const selectedHere = itemIds.filter(id => selected.has(id));
  const allHere = items.length > 0 && selectedHere.length === items.length;
  const someHere = selectedHere.length > 0 && !allHere;

  const totalSelected = selected.size;
  const totalReclaim = useMemo(() => {
    let s = 0;
    const all = [...MOCK.nfts, ...MOCK.splFungible, ...MOCK.emptyAccounts];
    for (const i of all) if (selected.has(i.id)) s += (i.reclaim || 0);
    return s;
  }, [selected]);

  const counts = {
    nfts: MOCK.nfts.filter(n => n.type === "NFT" || n.type === "pNFT").length,
    core: MOCK.nfts.filter(n => n.type === "Core").length,
    tokens: MOCK.splFungible.length,
    empty: MOCK.emptyAccounts.length,
  };

  const totalItems = scanState === "done" ? Object.values(counts).reduce((a,b) => a+b, 0) : null;
  const totalReclaimMax = scanState === "done"
    ? [...MOCK.nfts, ...MOCK.splFungible, ...MOCK.emptyAccounts].reduce((s,i) => s + (i.reclaim || 0), 0)
    : null;

  const toggle = (id) => setSelected(prev => {
    const n = new Set(prev); n.has(id) ? n.delete(id) : n.add(id); return n;
  });
  const toggleAll = () => setSelected(prev => {
    const n = new Set(prev);
    if (allHere) itemIds.forEach(id => n.delete(id));
    else itemIds.forEach(id => n.add(id));
    return n;
  });

  if (!wallet) {
    return (
      <div className="vl-page is-narrow col gap-lg">
        <div className="vl-card vl-empty" style={{ padding: 40 }}>
          <div className="icon"><Icon name="wallet" size={20}/></div>
          <div className="title">Connect a wallet to begin</div>
          <div className="sub">
            The burner scans Phantom or Solflare wallets for burnable NFTs, empty SPL accounts,
            and dust tokens. Every burn requires audit pass + wallet match + explicit sign.
          </div>
          <button className="vl-btn vl-btn-primary" style={{ marginTop: 6 }} onClick={onConnect}>
            <Icon name="wallet" size={12}/> Connect wallet
          </button>
        </div>
      </div>
    );
  }

  return (
    <div className="vl-page is-narrow col gap-lg">
      {/* Scan progress / status */}
      {scanState !== "done" ? (
        <ScanStrip progress={scanProgress} step={scanStep}/>
      ) : (
        <div className="row" style={{ justifyContent: "space-between", flexWrap: "wrap", gap: 8 }}>
          <div className="row gap-sm mono" style={{ fontSize: 11, color: "var(--vl-green)" }}>
            <span style={{ width: 7, height: 7, borderRadius: "50%", background: "var(--vl-green)", boxShadow: "0 0 8px rgba(79,182,125,0.6)" }}/>
            Scan complete · {totalItems} items · 4.2s
          </div>
          <button className="vl-btn vl-btn-ghost is-sm" onClick={rescan}><Icon name="refresh" size={11}/> Rescan</button>
        </div>
      )}

      {/* Stat tiles */}
      <div className="vl-stat-strip">
        <StatTile label="Items Found" value={totalItems !== null ? totalItems.toLocaleString() : "—"} sub={totalItems !== null ? `NFT ${counts.nfts} · Core ${counts.core} · SPL ${counts.tokens} · Empty ${counts.empty}` : "scanning…"} loading={scanState === "scanning"}/>
        <StatTile label="Selected" value={totalSelected > 0 ? totalSelected.toLocaleString() : "—"} sub={totalSelected > 0 ? "across all sections" : "select items below"} accent={totalSelected > 0 ? "purple" : "muted"}/>
        <StatTile label="Est. Reclaim" value={totalSelected > 0 ? `${totalReclaim.toFixed(4)} ◎` : (totalReclaimMax ? `${totalReclaimMax.toFixed(4)} ◎` : "—")} sub={totalSelected > 0 ? "from current selection" : (totalReclaimMax ? "max possible" : "scan to populate")} accent="green"/>
        <StatTile label="Est. Network Fee" value={totalSelected > 0 ? `${(totalSelected * 0.000005).toFixed(6)} ◎` : "—"} sub={totalSelected > 0 ? `${Math.ceil(totalSelected / 10)} tx` : "depends on selection"} accent="muted"/>
      </div>

      {/* Tabs */}
      <nav className="vl-tabstrip" role="tablist">
        {BURN_TABS.map(t => (
          <button key={t.key} role="tab" onClick={() => setTab(t.key)} className={`vl-tab ${tab === t.key ? "is-active" : ""}`}>
            {t.label} <span className="count num">{counts[t.key]}</span>
          </button>
        ))}
      </nav>

      {/* Section body */}
      <div className="vl-burn-card">
        <div style={{ padding: "10px 12px", borderBottom: "1px solid var(--vl-border)", display: "flex", alignItems: "center", gap: 10, flexWrap: "wrap" }}>
          <label className="row gap-sm" style={{ cursor: "pointer" }}>
            <Check checked={allHere} indeterminate={someHere} onChange={toggleAll}/>
            <span style={{ fontWeight: 600, fontSize: 12 }}>
              {selectedHere.length > 0
                ? `${selectedHere.length} of ${items.length} selected`
                : `Select all (${items.length})`}
            </span>
          </label>
          <span className="spacer"/>
          <div className="vl-search hide-mobile" style={{ width: 180 }}>
            <Icon name="search" size={12}/>
            <input placeholder="Filter…"/>
          </div>
          <button className="vl-btn vl-btn-ghost is-sm hide-mobile"><Icon name="filter" size={11}/> Sort</button>
        </div>

        {scanState === "scanning" ? (
          <SkeletonGrid kind={tab}/>
        ) : tab === "nfts" || tab === "core" ? (
          <CollectionGroups items={items} selected={selected} onToggle={toggle} setSelected={setSelected} wallet={wallet}/>
        ) : (
          <RowList items={items} kind={tab} selected={selected} onToggle={toggle}/>
        )}
      </div>

      {/* Sticky action bar */}
      {totalSelected > 0 && (
        <div className="vl-action-bar">
          <div className="left">
            <span className="pip"/>
            <div className="meta">
              <div className="mono" style={{ fontSize: 10, color: "var(--vl-fg-3)", letterSpacing: 0.4, textTransform: "uppercase", fontWeight: 600 }}>Burner · {tab.toUpperCase()}</div>
              <div style={{ fontSize: 12, color: "var(--vl-fg-2)" }}>
                <b style={{ color: "var(--vl-fg)" }}>{totalSelected}</b> item{totalSelected === 1 ? "" : "s"} staged · <b style={{ color: "var(--vl-green)" }}>+{totalReclaim.toFixed(4)} ◎</b> reclaim
              </div>
            </div>
          </div>
          <div className="right">
            <button className="vl-btn vl-btn-ghost is-sm hide-mobile" onClick={() => setSelected(new Set())}>Clear</button>
            <button className="vl-btn vl-btn-burn" onClick={() => setConfirming(true)}>
              <Icon name="flame" size={12}/> Burn selected
              <span className="mono" style={{ fontSize: 10, opacity: 0.85, marginLeft: 2 }}>· {totalSelected}</span>
            </button>
          </div>
        </div>
      )}

      {confirming && (
        <BurnConfirm
          count={totalSelected}
          reclaim={totalReclaim}
          onClose={() => setConfirming(false)}
          onConfirm={() => { setConfirming(false); setSelected(new Set()); }}
        />
      )}
    </div>
  );
}

function BurnerHeader({ wallet, onConnect }) {
  return (
    <div className="row" style={{ alignItems: "flex-end", flexWrap: "wrap", gap: 12 }}>
      <div className="col gap-sm" style={{ flex: 1, minWidth: 240 }}>
        <Label>Solana wallet burner</Label>
        <h1 className="vl-h1">Reclaim rent</h1>
        <div className="muted" style={{ fontSize: 12 }}>
          Burn unwanted NFTs, dust tokens, and close empty SPL accounts to reclaim SOL.
        </div>
      </div>
      <div className="row gap-sm">
        {wallet && (
          <>
            <span className="vl-wallet-pill">
              <span className="ico"/>{wallet.slice(0,4)}…{wallet.slice(-4)}
            </span>
            <button className="vl-btn vl-btn-ghost is-sm" title="Copy"><Icon name="copy" size={11}/></button>
            <button className="vl-btn vl-btn-ghost is-sm" title="Solscan"><Icon name="ext" size={11}/></button>
          </>
        )}
      </div>
    </div>
  );
}

function ScanStrip({ progress, step }) {
  const steps = ["RPC accounts", "DAS NFTs", "pNFT discovery", "Core assets", "SPL classify", "Audit"];
  return (
    <div className="vl-scan">
      <div className="vl-scan-head">
        <div className="status"><span className="spin"/>Scanning wallet · <b>{steps[step]}</b></div>
        <div className="mono" style={{ fontSize: 11, color: "var(--vl-fg-3)" }}>{Math.round(progress)}%</div>
      </div>
      <div className="vl-progress"><div className="bar" style={{ width: `${progress}%` }}/></div>
      <div className="vl-scan-steps">
        {steps.map((s, i) => (
          <span key={s} className={`vl-scan-step ${i < step ? "is-done" : i === step ? "is-active" : ""}`}>
            {i < step ? <Icon name="check" size={9}/> : null}{s}
          </span>
        ))}
      </div>
    </div>
  );
}

function NftTile({ nft, selected, onToggle }) {
  // Split "Collection #1234" into name + id; fall back to whole name.
  const m = /^(.*?)\s*#(\S+)$/.exec(nft.name || "");
  const nm = m ? m[1] : nft.name;
  const idNo = m ? `#${m[2]}` : "";
  return (
    <div className={`vl-nft-row ${selected ? "is-selected" : ""}`} onClick={onToggle} title={nft.name}>
      <Check checked={selected} onChange={onToggle} onClick={e => e.stopPropagation()}/>
      <div className="thumb"><div className="ph">{nft.collection.slice(0,2).toUpperCase()}</div></div>
      <div className="name">{nm}</div>
      <div className="id">{idNo}</div>
    </div>
  );
}

function CollectionGroups({ items, selected, onToggle, setSelected, wallet }) {
  // Group items by collection.
  const groups = React.useMemo(() => {
    const m = new Map();
    for (const n of items) {
      if (!m.has(n.collection)) m.set(n.collection, []);
      m.get(n.collection).push(n);
    }
    return [...m.entries()].map(([name, list]) => ({ name, list }));
  }, [items]);

  const shortAddr = wallet ? `${wallet.slice(0,4)}…${wallet.slice(-4)}` : "—";

  return (
    <div className="vl-coll-groups">
      {groups.map(g => {
        const ids = g.list.map(i => i.id);
        const all = ids.every(id => selected.has(id));
        const some = ids.some(id => selected.has(id)) && !all;
        const selN = ids.filter(id => selected.has(id)).length;
        const toggleSection = () => setSelected(prev => {
          const n = new Set(prev);
          if (all) ids.forEach(id => n.delete(id));
          else ids.forEach(id => n.add(id));
          return n;
        });
        const pickN = () => {
          const n = Math.min(10, ids.length);
          setSelected(prev => {
            const s = new Set(prev);
            ids.slice(0, n).forEach(id => s.add(id));
            return s;
          });
        };
        return (
          <section key={g.name} className="vl-coll-section">
            <header className="vl-coll-head">
              <div className="vl-coll-title">
                <span className="vl-coll-name">{g.name}</span>
                <span className="vl-coll-count">{g.list.length}</span>
                <span className="vl-coll-addr mono">{shortAddr}</span>
                {selN > 0 && <span className="vl-coll-sel mono">{selN} sel</span>}
              </div>
              <div className="row gap-sm">
                <button className="vl-btn vl-btn-ghost is-xs" onClick={pickN} title="Pick first 10"><span className="mono">10</span> Pick</button>
                <button className="vl-btn vl-btn-ghost is-xs" onClick={toggleSection}>
                  {all ? "Deselect" : "Select all"}
                </button>
              </div>
            </header>
            <div className="vl-nft-rows">
              {g.list.map(n => (
                <NftTile key={n.id} nft={n} selected={selected.has(n.id)} onToggle={() => onToggle(n.id)}/>
              ))}
            </div>
          </section>
        );
      })}
    </div>
  );
}

function RowList({ items, kind, selected, onToggle }) {
  return (
    <table className="vl-table vl-table-burn" style={{ borderRadius: 0 }}>
      <thead>
        <tr>
          <th style={{ width: 32 }}></th>
          <th>{kind === "tokens" ? "Token" : "Mint"}</th>
          {kind === "tokens" && <th className="num col-balance">Balance</th>}
          {kind === "tokens" && <th className="num col-value">Value</th>}
          <th className="num">Reclaim</th>
          <th className="col-ext"></th>
        </tr>
      </thead>
      <tbody>
        {items.map(it => (
          <tr key={it.id} className={selected.has(it.id) ? "is-selected" : ""} onClick={() => onToggle(it.id)}>
            <td><Check checked={selected.has(it.id)} onChange={() => onToggle(it.id)}/></td>
            <td className="mono">
              <span style={{ color: "var(--vl-fg)" }}>{it.symbol}</span>
              {it.mint && <span className="muted col-mint-extra" style={{ marginLeft: 6, fontSize: 10 }}>{it.mint}</span>}
            </td>
            {kind === "tokens" && <td className="num mono col-balance">{it.balance}</td>}
            {kind === "tokens" && <td className="num mono col-value">${it.valueUsd.toFixed(2)}</td>}
            <td className="num mono pos">+{it.reclaim.toFixed(4)}</td>
            <td className="num col-ext"><button className="vl-btn vl-btn-ghost is-sm"><Icon name="ext" size={10}/></button></td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}

function SkeletonGrid({ kind }) {
  if (kind === "nfts" || kind === "core") {
    return (
      <div className="vl-coll-groups">
        {Array.from({ length: 2 }).map((_, s) => (
          <section key={s} className="vl-coll-section">
            <header className="vl-coll-head">
              <div className="vl-coll-title">
                <div className="vl-skel" style={{ width: 80, height: 11 }}/>
                <div className="vl-skel" style={{ width: 22, height: 14, borderRadius: 7 }}/>
                <div className="vl-skel" style={{ width: 60, height: 9 }}/>
              </div>
              <div className="vl-skel" style={{ width: 64, height: 18, borderRadius: 4 }}/>
            </header>
            <div className="vl-nft-rows">
              {Array.from({ length: 7 }).map((__, i) => (
                <div key={i} className="vl-nft-row" style={{ pointerEvents: "none" }}>
                  <div className="vl-skel" style={{ width: 14, height: 14, borderRadius: 3 }}/>
                  <div className="vl-skel" style={{ width: 28, height: 28, borderRadius: 4 }}/>
                  <div className="vl-skel" style={{ height: 10, width: "72%" }}/>
                  <div className="vl-skel" style={{ height: 10, width: 28 }}/>
                </div>
              ))}
            </div>
          </section>
        ))}
      </div>
    );
  }
  return null;
}

function TokenSkeleton() {
  return (
    <div style={{ padding: 0 }}>
      {Array.from({ length: 6 }).map((_, i) => (
        <div key={i} className="row" style={{ padding: "6px 10px", borderBottom: "1px solid var(--vl-border)" }}>
          <div className="vl-skel" style={{ width: 14, height: 14 }}/>
          <div className="vl-skel" style={{ height: 10, flex: 1, maxWidth: 200 }}/>
          <div className="spacer"/>
          <div className="vl-skel" style={{ height: 10, width: 50 }}/>
        </div>
      ))}
    </div>
  );
}

function BurnConfirm({ count, reclaim, onClose, onConfirm }) {
  const [ack, setAck] = useState(false);
  const [simulating, setSimulating] = useState(true);
  const [auditOk, setAuditOk] = useState(false);
  useEffect(() => {
    const id = setTimeout(() => { setSimulating(false); setAuditOk(true); }, 1300);
    return () => clearTimeout(id);
  }, []);
  return (
    <div className="vl-modal-backdrop" onClick={onClose}>
      <div className="vl-modal" onClick={e => e.stopPropagation()}>
        <div className="vl-modal-head">
          <div className="col gap-sm">
            <Label style={{ color: "var(--vl-red)" }}>Confirm burn</Label>
            <div className="vl-h2">{count} item{count === 1 ? "" : "s"} · +{reclaim.toFixed(4)} ◎ reclaim</div>
          </div>
          <button className="vl-btn vl-btn-ghost is-sm" onClick={onClose}><Icon name="x" size={12}/></button>
        </div>
        <div className="vl-modal-body col">
          <div className="vl-warn-strip">
            <span className="dot"/>
            This action is permanent. Burned assets cannot be recovered.
          </div>
          <div className="col gap-sm">
            <div className="row" style={{ justifyContent: "space-between", padding: "6px 0" }}>
              <span className="muted mono" style={{ fontSize: 11 }}>Simulation</span>
              <span className={"mono " + (simulating ? "muted" : "pos")} style={{ fontSize: 11 }}>
                {simulating ? "running…" : "✓ pass"}
              </span>
            </div>
            <div className="row" style={{ justifyContent: "space-between", padding: "6px 0" }}>
              <span className="muted mono" style={{ fontSize: 11 }}>Audit</span>
              <span className={"mono " + (auditOk ? "pos" : "muted")} style={{ fontSize: 11 }}>
                {auditOk ? "✓ pass · 0 risk flags" : "pending…"}
              </span>
            </div>
            <div className="row" style={{ justifyContent: "space-between", padding: "6px 0" }}>
              <span className="muted mono" style={{ fontSize: 11 }}>Wallet match</span>
              <span className="mono pos" style={{ fontSize: 11 }}>✓ connected</span>
            </div>
            <div className="row" style={{ justifyContent: "space-between", padding: "6px 0" }}>
              <span className="muted mono" style={{ fontSize: 11 }}>Transactions</span>
              <span className="mono" style={{ fontSize: 11 }}>{Math.ceil(count / 10)} batched</span>
            </div>
          </div>
          <label className="row gap-sm" style={{ cursor: "pointer", padding: "8px 10px", border: "1px solid var(--vl-border)", borderRadius: 8, background: "rgba(0,0,0,0.18)" }}>
            <Check checked={ack} onChange={e => setAck(e.target.checked)}/>
            <span style={{ fontSize: 12 }}>I understand this is irreversible.</span>
          </label>
        </div>
        <div className="vl-modal-foot">
          <button className="vl-btn vl-btn-ghost" onClick={onClose}>Cancel</button>
          <button className="vl-btn vl-btn-burn" disabled={!ack || simulating} onClick={onConfirm}>
            <Icon name="flame" size={12}/> Sign & send
          </button>
        </div>
      </div>
    </div>
  );
}

window.BurnerPage = BurnerPage;
