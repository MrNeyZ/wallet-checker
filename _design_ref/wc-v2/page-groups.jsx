/* global React, UI, MOCK */
const { useState, useEffect, useMemo } = React;
const { Icon, Badge, Label, StatTile, Check } = UI;

// ════════════════════════════════════════════════════════════════
// GROUPS LIST
// ════════════════════════════════════════════════════════════════
function GroupsPage({ onOpenGroup }) {
  const [filter, setFilter] = useState("");
  const [creating, setCreating] = useState(false);
  const groups = useMemo(() =>
    MOCK.groups.filter(g => g.name.toLowerCase().includes(filter.toLowerCase())),
    [filter]
  );

  return (
    <div className="vl-page col gap-lg">
      <div className="row" style={{ alignItems: "flex-end", flexWrap: "wrap", gap: 12 }}>
        <div className="col gap-sm" style={{ flex: 1, minWidth: 240 }}>
          <Label>Wallet groups</Label>
          <h1 className="vl-h1">Groups</h1>
          <div className="muted" style={{ fontSize: 12 }}>
            Track PnL, portfolio, and reclaim across wallet sets. {MOCK.groups.length} active.
          </div>
        </div>
        <div className="row gap-sm">
          <div className="vl-search" style={{ width: 220 }}>
            <span className="icon"><Icon name="search" size={13}/></span>
            <input placeholder="Filter groups…" value={filter} onChange={e => setFilter(e.target.value)}/>
          </div>
          <button className="vl-btn vl-btn-primary" onClick={() => setCreating(true)}>
            <Icon name="plus" size={12}/> New group
          </button>
        </div>
      </div>

      {/* System status row */}
      <div className="vl-card">
        <div className="vl-card-head">
          <div className="row gap-sm"><Label>System status</Label>
            <span className="muted" style={{ fontSize: 11 }}>· 2 pollers running</span>
          </div>
          <button className="vl-btn vl-btn-ghost is-sm"><Icon name="refresh" size={11}/> Refresh</button>
        </div>
        <div className="vl-card-body" style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(140px, 1fr))", gap: 10 }}>
          {[
            ["SolanaTracker", true],
            ["Helius", true],
            ["Telegram", true],
            ["API auth", true],
            ["RPC", true],
            ["Backups", false],
          ].map(([k, on]) => (
            <div key={k} className="row gap-sm" style={{ fontSize: 12 }}>
              <span style={{
                width: 7, height: 7, borderRadius: "50%",
                background: on ? "var(--vl-green)" : "var(--vl-fg-4)",
                boxShadow: on ? "0 0 8px rgba(79,182,125,0.6)" : "none"
              }}/>
              <span style={{ fontWeight: 600 }}>{k}</span>
              <span style={{ marginLeft: "auto", fontSize: 10, color: on ? "var(--vl-green)" : "var(--vl-fg-3)" }} className="mono">{on ? "ON" : "OFF"}</span>
            </div>
          ))}
        </div>
      </div>

      {/* Groups table */}
      <div className="vl-table-wrap">
        <div style={{ padding: "10px 14px", display: "flex", alignItems: "center", justifyContent: "space-between", borderBottom: "1px solid var(--vl-border)" }}>
          <div className="row gap-sm">
            <Label>All groups</Label>
            <Badge tone="neutral">{groups.length}</Badge>
          </div>
          <div className="muted mono" style={{ fontSize: 10 }}>Last updated 4s ago</div>
        </div>
        <table className="vl-table">
          <thead>
            <tr>
              <th>Group</th>
              <th>Wallets</th>
              <th className="num">Portfolio</th>
              <th className="num">PnL 24h</th>
              <th className="num">PnL all</th>
              <th className="num">Reclaim</th>
              <th>Last scan</th>
              <th></th>
            </tr>
          </thead>
          <tbody>
            {groups.map(g => (
              <tr key={g.id} onClick={() => onOpenGroup(g.id)} style={{ cursor: "pointer" }}>
                <td>
                  <div className="row gap-sm">
                    <span style={{ fontWeight: 600 }}>{g.name}</span>
                    {g.hot && <Badge tone="purple">live</Badge>}
                  </div>
                  <div className="muted mono" style={{ fontSize: 10, marginTop: 2 }}>{g.id} · {g.createdAt}</div>
                </td>
                <td><span className="mono">{g.wallets}</span></td>
                <td className="num mono">${g.portfolioUsd.toLocaleString()}</td>
                <td className={"num mono " + (g.pnl24h >= 0 ? "pos" : "neg")}>
                  {g.pnl24h >= 0 ? "+" : ""}${Math.abs(g.pnl24h).toLocaleString()}
                </td>
                <td className={"num mono " + (g.pnlAll >= 0 ? "pos" : "neg")}>
                  {g.pnlAll >= 0 ? "+" : ""}${Math.abs(g.pnlAll).toLocaleString()}
                </td>
                <td className="num mono">{g.reclaim.toFixed(2)} ◎</td>
                <td className="muted mono" style={{ fontSize: 11 }}>{g.lastScan}</td>
                <td className="num"><Icon name="chevronR" size={14}/></td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      {creating && (
        <div className="vl-modal-backdrop" onClick={() => setCreating(false)}>
          <div className="vl-modal" onClick={e => e.stopPropagation()}>
            <div className="vl-modal-head">
              <div className="col gap-sm">
                <Label>Create</Label>
                <div className="vl-h2">New group</div>
              </div>
              <button className="vl-btn vl-btn-ghost is-sm" onClick={() => setCreating(false)}><Icon name="x" size={12}/></button>
            </div>
            <div className="vl-modal-body col">
              <div className="col gap-sm">
                <Label>Name</Label>
                <input className="vl-input" autoFocus placeholder="e.g. Alpha hunters"/>
              </div>
              <div className="col gap-sm">
                <Label>Description (optional)</Label>
                <input className="vl-input" placeholder="What's this group for?"/>
              </div>
            </div>
            <div className="vl-modal-foot">
              <button className="vl-btn vl-btn-ghost" onClick={() => setCreating(false)}>Cancel</button>
              <button className="vl-btn vl-btn-primary" onClick={() => setCreating(false)}>Create</button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

window.GroupsPage = GroupsPage;
