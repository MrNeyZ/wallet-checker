/* global React, UI, MOCK */
const { useState, useEffect, useMemo } = React;
const { Icon, Badge, Label, StatTile, Check } = UI;

// ════════════════════════════════════════════════════════════════
// GROUP DETAIL — Hero + tabs: Positions / Activity / Cleaner / Alerts / Settings
// ════════════════════════════════════════════════════════════════
function GroupDetailPage({ groupId, onBack }) {
  const group = MOCK.groups.find(g => g.id === groupId) || MOCK.groups[0];
  const [tab, setTab] = useState("cleaner");
  const tabs = [
    { key: "positions", label: "Positions" },
    { key: "activity", label: "Activity" },
    { key: "cleaner", label: "Cleaner", count: MOCK.wallets.length },
    { key: "alerts", label: "Alerts", count: 3 },
    { key: "settings", label: "Settings" },
  ];

  return (
    <div className="vl-page col gap-lg">
      <button onClick={onBack} className="muted" style={{ background: "transparent", border: "none", padding: 0, fontSize: 12, textAlign: "left", cursor: "pointer" }}>
        ← Back to groups
      </button>

      {/* Hero */}
      <div className="vl-card is-hero">
        <div style={{ padding: "16px 18px", display: "grid", gridTemplateColumns: "1fr auto", gap: 18, alignItems: "center" }}>
          <div className="col gap-sm">
            <div className="row gap-sm">
              <Label>Group</Label>
              {group.hot && <Badge tone="purple">live</Badge>}
            </div>
            <h1 className="vl-h1" style={{ fontSize: 28 }}>{group.name}</h1>
            <div className="row gap-lg muted" style={{ fontSize: 11, flexWrap: "wrap" }}>
              <span className="mono">{group.wallets} wallets</span>
              <span>·</span>
              <span className="mono">last scan {group.lastScan}</span>
              <span>·</span>
              <span className="mono">created {group.createdAt}</span>
            </div>
          </div>
          <div style={{ display: "grid", gridTemplateColumns: "repeat(3, auto)", gap: 22, alignItems: "end", whiteSpace: "nowrap" }} className="hide-mobile">
            <div className="col gap-sm" style={{ textAlign: "right" }}>
              <Label>Portfolio</Label>
              <div className="vl-stat-value">${group.portfolioUsd.toLocaleString()}</div>
            </div>
            <div className="col gap-sm" style={{ textAlign: "right" }}>
              <Label>PnL 24h</Label>
              <div className={"vl-stat-value " + (group.pnl24h >= 0 ? "is-green" : "is-red")}>
                {group.pnl24h >= 0 ? "+" : "−"}${Math.abs(group.pnl24h).toLocaleString()}
              </div>
            </div>
            <div className="col gap-sm" style={{ textAlign: "right" }}>
              <Label>Reclaim avail.</Label>
              <div className="vl-stat-value is-purple">{group.reclaim.toFixed(2)} ◎</div>
            </div>
          </div>
        </div>
      </div>

      {/* Tabs */}
      <nav className="vl-tabstrip" role="tablist">
        {tabs.map(t => (
          <button key={t.key} role="tab" onClick={() => setTab(t.key)} className={`vl-tab ${tab === t.key ? "is-active" : ""}`}>
            {t.label}{t.count != null && <span className="count num">{t.count}</span>}
          </button>
        ))}
      </nav>

      {tab === "positions" && <PositionsTab group={group}/>}
      {tab === "activity" && <ActivityTab/>}
      {tab === "cleaner" && <CleanerTab/>}
      {tab === "alerts" && <AlertsTab/>}
      {tab === "settings" && <SettingsTab/>}
    </div>
  );
}

// ─────── Positions ───────
function PositionsTab({ group }) {
  const [sort, setSort] = useState("portfolio");
  const rows = useMemo(() => {
    const sorted = [...MOCK.positions];
    if (sort === "portfolio") sorted.sort((a, b) => b.portfolioUsd - a.portfolioUsd);
    if (sort === "pnl24") sorted.sort((a, b) => b.pnl24h - a.pnl24h);
    if (sort === "pnlAll") sorted.sort((a, b) => b.pnlAll - a.pnlAll);
    return sorted;
  }, [sort]);
  return (
    <div className="col gap-lg">
      <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(160px, 1fr))", gap: 10 }}>
        <StatTile label="Total portfolio" value={`$${group.portfolioUsd.toLocaleString()}`} sub="across 7 wallets" />
        <StatTile label="Realized PnL" value={`+$${group.pnlAll.toLocaleString()}`} accent="green" sub="all time" />
        <StatTile label="Win rate" value="54%" sub="184 / 340 trades" />
        <StatTile label="Tokens held" value="48" sub="12 with PnL > $100" accent="purple"/>
      </div>
      <div className="vl-table-wrap">
        <div className="vl-card-head">
          <div className="row gap-sm"><Label>Wallet positions</Label><Badge tone="neutral">{rows.length}</Badge></div>
          <div className="row gap-sm">
            <select className="vl-input" style={{ width: 140, padding: "5px 10px" }} value={sort} onChange={e => setSort(e.target.value)}>
              <option value="portfolio">Sort: Portfolio</option>
              <option value="pnl24">Sort: PnL 24h</option>
              <option value="pnlAll">Sort: PnL all</option>
            </select>
          </div>
        </div>
        <table className="vl-table">
          <thead>
            <tr>
              <th>Wallet</th>
              <th className="num">Portfolio</th>
              <th className="num">PnL 24h</th>
              <th className="num">PnL all</th>
              <th className="num">Win rate</th>
              <th className="num">Trades</th>
              <th className="num">Tokens</th>
            </tr>
          </thead>
          <tbody>
            {rows.map(r => (
              <tr key={r.wallet.address}>
                <td>
                  <div className="row gap-sm">
                    <span className="ico" style={{ width: 16, height: 16, borderRadius: "50%", background: "linear-gradient(135deg, var(--vl-purple), #e42575)" }}/>
                    <span style={{ fontWeight: 600 }}>{r.wallet.label}</span>
                    <span className="muted mono" style={{ fontSize: 10 }}>{r.wallet.short}</span>
                  </div>
                </td>
                <td className="num mono">${r.portfolioUsd.toLocaleString()}</td>
                <td className={"num mono " + (r.pnl24h >= 0 ? "pos" : "neg")}>{r.pnl24h >= 0 ? "+" : "−"}${Math.abs(r.pnl24h).toLocaleString()}</td>
                <td className={"num mono " + (r.pnlAll >= 0 ? "pos" : "neg")}>{r.pnlAll >= 0 ? "+" : "−"}${Math.abs(r.pnlAll).toLocaleString()}</td>
                <td className="num mono">{Math.round(r.winRate * 100)}%</td>
                <td className="num mono">{r.trades}</td>
                <td className="num mono">{r.tokens}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}

// ─────── Activity ───────
function ActivityTab() {
  return (
    <div className="col gap-lg">
      <div className="vl-card">
        <div className="vl-card-head"><Label>Filters</Label></div>
        <div className="vl-card-body row" style={{ flexWrap: "wrap", gap: 8 }}>
          <div className="vl-search" style={{ width: 180 }}><Icon name="search" size={12}/><input placeholder="Token…"/></div>
          <select className="vl-input" style={{ width: 130 }}><option>Any side</option><option>Buys</option><option>Sells</option></select>
          <select className="vl-input" style={{ width: 130 }}><option>Any program</option><option>Jupiter</option><option>Pumpfun</option></select>
          <input className="vl-input" placeholder="min USD" style={{ width: 120 }}/>
          <span className="spacer"/>
          <button className="vl-btn vl-btn-ghost is-sm"><Icon name="refresh" size={11}/> Reset</button>
        </div>
      </div>
      <div className="vl-table-wrap">
        <div className="vl-card-head"><Label>Recent trades</Label><Badge tone="neutral">{MOCK.recentTrades.length}</Badge></div>
        <table className="vl-table">
          <thead><tr><th>Side</th><th>Token</th><th>Wallet</th><th>Program</th><th className="num">USD</th><th className="num">Age</th></tr></thead>
          <tbody>
            {MOCK.recentTrades.map(t => (
              <tr key={t.id}>
                <td><Badge tone={t.side === "buy" ? "green" : "red"}>{t.side}</Badge></td>
                <td><b className="mono">{t.token}</b></td>
                <td><span className="mono muted" style={{ fontSize: 11 }}>{t.wallet.label} · {t.wallet.short}</span></td>
                <td><span className="mono muted">{t.program}</span></td>
                <td className="num mono">${t.usd.toLocaleString()}</td>
                <td className="num mono muted">{t.age}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}

// ─────── Cleaner — multi-wallet group cleaner ───────
function CleanerTab() {
  const [scanState, setScanState] = useState("idle"); // idle | scanning | done
  const [scanProgress, setScanProgress] = useState(0);
  const [walletStates, setWalletStates] = useState({}); // wallet.address -> {status, items, reclaim}
  const [expanded, setExpanded] = useState(new Set());
  const [selectedWallets, setSelectedWallets] = useState(new Set());

  // simulate group-wide scan
  const runScan = () => {
    setScanState("scanning");
    setScanProgress(0);
    const wallets = MOCK.wallets;
    let idx = 0;
    const initial = {};
    wallets.forEach(w => { initial[w.address] = { status: "queued", items: 0, reclaim: 0 }; });
    setWalletStates(initial);
    const tick = () => {
      if (idx >= wallets.length) { setScanState("done"); return; }
      const w = wallets[idx];
      setWalletStates(prev => ({ ...prev, [w.address]: { status: "scanning", items: 0, reclaim: 0 } }));
      setTimeout(() => {
        const items = Math.floor(Math.random() * 50) + 4;
        const reclaim = items * 0.00204;
        setWalletStates(prev => ({ ...prev, [w.address]: { status: "done", items, reclaim } }));
        idx++;
        setScanProgress(Math.round((idx / wallets.length) * 100));
        tick();
      }, 320);
    };
    tick();
  };

  useEffect(() => { runScan(); /* eslint-disable-next-line */ }, []);

  const totalItems = Object.values(walletStates).reduce((s, w) => s + (w.items || 0), 0);
  const totalReclaim = Object.values(walletStates).reduce((s, w) => s + (w.reclaim || 0), 0);
  const totalSelectedReclaim = MOCK.wallets.filter(w => selectedWallets.has(w.address)).reduce((s, w) => s + (walletStates[w.address]?.reclaim || 0), 0);
  const totalSelectedItems = MOCK.wallets.filter(w => selectedWallets.has(w.address)).reduce((s, w) => s + (walletStates[w.address]?.items || 0), 0);

  const toggleAllWallets = () => {
    const completed = MOCK.wallets.filter(w => walletStates[w.address]?.status === "done").map(w => w.address);
    if (selectedWallets.size === completed.length) setSelectedWallets(new Set());
    else setSelectedWallets(new Set(completed));
  };
  const toggleWallet = (addr) => setSelectedWallets(prev => {
    const n = new Set(prev); n.has(addr) ? n.delete(addr) : n.add(addr); return n;
  });
  const toggleExpand = (addr) => setExpanded(prev => {
    const n = new Set(prev); n.has(addr) ? n.delete(addr) : n.add(addr); return n;
  });

  return (
    <div className="col gap-lg">
      <div className="vl-warn-strip">
        <span className="dot"/>
        Group cleaner runs scans across all wallets in parallel. Burns still require per-wallet sign.
      </div>

      {/* Group stats */}
      <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(160px, 1fr))", gap: 10 }}>
        <StatTile label="Wallets scanned" value={`${Object.values(walletStates).filter(w => w.status === "done").length} / ${MOCK.wallets.length}`} sub={scanState === "scanning" ? "in progress…" : "complete"} accent="purple"/>
        <StatTile label="Total burnable" value={totalItems.toLocaleString()} sub="NFTs · SPL · empty" loading={scanState === "scanning"}/>
        <StatTile label="Group reclaim" value={`${totalReclaim.toFixed(4)} ◎`} accent="green" sub="max possible" loading={scanState === "scanning"}/>
        <StatTile label="Selected" value={selectedWallets.size > 0 ? `${selectedWallets.size} wallet${selectedWallets.size === 1 ? "" : "s"}` : "—"} accent={selectedWallets.size > 0 ? "purple" : "muted"} sub={selectedWallets.size > 0 ? `${totalSelectedItems} items · ${totalSelectedReclaim.toFixed(4)} ◎` : "select wallets below"}/>
      </div>

      {scanState === "scanning" && (
        <div className="vl-scan">
          <div className="vl-scan-head">
            <div className="status"><span className="spin"/>Scanning <b>{MOCK.wallets.length}</b> wallets · concurrency 5</div>
            <div className="mono" style={{ fontSize: 11, color: "var(--vl-fg-3)" }}>{scanProgress}%</div>
          </div>
          <div className="vl-progress"><div className="bar" style={{ width: `${scanProgress}%` }}/></div>
        </div>
      )}

      {/* Wallet list */}
      <div className="vl-card">
        <div className="vl-card-head" style={{ flexWrap: "wrap", gap: 8 }}>
          <label className="row gap-sm" style={{ cursor: "pointer" }}>
            <Check
              checked={selectedWallets.size > 0 && selectedWallets.size === MOCK.wallets.filter(w => walletStates[w.address]?.status === "done").length}
              indeterminate={selectedWallets.size > 0 && selectedWallets.size < MOCK.wallets.length}
              onChange={toggleAllWallets}/>
            <Label style={{ marginBottom: 0 }}>Wallets</Label>
            <Badge tone="neutral">{MOCK.wallets.length}</Badge>
          </label>
          <span className="spacer"/>
          <div className="vl-search hide-mobile" style={{ width: 180 }}><Icon name="search" size={12}/><input placeholder="Filter…"/></div>
          <button className="vl-btn vl-btn-ghost is-sm" onClick={() => runScan()}><Icon name="refresh" size={11}/> Rescan all</button>
        </div>

        <ul style={{ listStyle: "none", margin: 0, padding: 0 }}>
          {MOCK.wallets.map(w => {
            const ws = walletStates[w.address] || { status: "queued", items: 0, reclaim: 0 };
            const isExpanded = expanded.has(w.address);
            const isSelected = selectedWallets.has(w.address);
            return (
              <li key={w.address}>
                <div className="row gap-sm" style={{
                  padding: "10px 14px",
                  borderBottom: "1px solid var(--vl-border)",
                  background: isSelected ? "rgba(168,144,232,0.08)" : "rgba(0,0,0,0.16)",
                  transition: "background var(--vl-motion)",
                  cursor: "pointer",
                }} onClick={() => ws.status === "done" && toggleExpand(w.address)}>
                  <Check checked={isSelected} disabled={ws.status !== "done"} onChange={e => { e.stopPropagation(); toggleWallet(w.address); }} onClick={e => e.stopPropagation()}/>
                  <span className="ico" style={{ width: 18, height: 18, borderRadius: "50%", background: "linear-gradient(135deg, var(--vl-purple), #e42575)", flexShrink: 0 }}/>
                  <div className="col" style={{ minWidth: 0, gap: 1 }}>
                    <div className="row gap-sm">
                      <b style={{ fontSize: 13 }}>{w.label}</b>
                      <span className="muted mono" style={{ fontSize: 10 }}>{w.short}</span>
                    </div>
                    <div className="mono muted" style={{ fontSize: 10 }}>
                      {ws.status === "queued" && "queued · waiting…"}
                      {ws.status === "scanning" && <span style={{ color: "var(--vl-purple-2)" }}>scanning…</span>}
                      {ws.status === "done" && <span><span style={{ color: "var(--vl-green)" }}>✓</span> {ws.items} items · +{ws.reclaim.toFixed(4)} ◎</span>}
                    </div>
                  </div>
                  <span className="spacer"/>
                  {ws.status === "scanning" && <span className="spin" style={{ width: 12, height: 12, borderRadius: "50%", border: "1.5px solid rgba(168,144,232,0.25)", borderTopColor: "var(--vl-purple)", animation: "vl-spin 0.8s linear infinite" }}/>}
                  {ws.status === "done" && (
                    <>
                      <Badge tone="purple">{ws.items}</Badge>
                      <Badge tone="green">+{ws.reclaim.toFixed(4)} ◎</Badge>
                      <Icon name={isExpanded ? "chevron" : "chevronR"} size={14}/>
                    </>
                  )}
                </div>
                {isExpanded && ws.status === "done" && (
                  <div style={{ background: "rgba(0,0,0,0.28)", padding: "12px 14px 14px", borderBottom: "1px solid var(--vl-border)" }}>
                    <div className="row gap-sm" style={{ marginBottom: 10, flexWrap: "wrap" }}>
                      {["nfts", "core", "tokens", "empty"].map((k, i) => (
                        <Badge key={k} tone="neutral">
                          {k} · {Math.max(1, Math.round(ws.items * [0.5, 0.05, 0.2, 0.25][i]))}
                        </Badge>
                      ))}
                      <span className="spacer"/>
                      <button className="vl-btn vl-btn-ghost is-sm"><Icon name="ext" size={11}/> Open in burner</button>
                    </div>
                    <div className="vl-nft-grid">
                      {MOCK.nfts.slice(0, 6).map(n => (
                        <div key={n.id} className="vl-nft-tile">
                          <div className="art"><div className="placeholder">{n.collection}</div></div>
                          <div className="meta">
                            <div className="name">{n.name}</div>
                            <div className="sub"><span>{n.type}</span><span className="reclaim">+{n.reclaim.toFixed(4)}</span></div>
                          </div>
                        </div>
                      ))}
                    </div>
                  </div>
                )}
              </li>
            );
          })}
        </ul>
      </div>

      {selectedWallets.size > 0 && (
        <div className="vl-action-bar">
          <div className="left">
            <span className="pip"/>
            <div className="meta">
              <div className="mono" style={{ fontSize: 10, color: "var(--vl-fg-3)", letterSpacing: 0.4, textTransform: "uppercase", fontWeight: 600 }}>Group cleaner</div>
              <div style={{ fontSize: 12, color: "var(--vl-fg-2)" }}>
                <b style={{ color: "var(--vl-fg)" }}>{selectedWallets.size}</b> wallets · {totalSelectedItems} items · <b style={{ color: "var(--vl-green)" }}>+{totalSelectedReclaim.toFixed(4)} ◎</b>
              </div>
            </div>
          </div>
          <div className="right">
            <button className="vl-btn vl-btn-ghost is-sm hide-mobile" onClick={() => setSelectedWallets(new Set())}>Clear</button>
            <button className="vl-btn vl-btn-burn"><Icon name="flame" size={12}/> Queue burns</button>
          </div>
        </div>
      )}
    </div>
  );
}

function AlertsTab() {
  return (
    <div className="vl-card vl-empty">
      <div className="icon"><Icon name="alert" size={20}/></div>
      <div className="title">3 server-side alert rules</div>
      <div className="sub">Telegram delivery is configured. Rules fire on matching trades across this group.</div>
      <button className="vl-btn vl-btn-primary is-sm" style={{ marginTop: 6 }}><Icon name="plus" size={12}/> Add rule</button>
    </div>
  );
}
function SettingsTab() {
  return (
    <div className="vl-card vl-empty">
      <div className="icon"><Icon name="settings" size={20}/></div>
      <div className="title">Group settings</div>
      <div className="sub">Manage wallet membership, labels, and group-level scan defaults.</div>
    </div>
  );
}

window.GroupDetailPage = GroupDetailPage;
