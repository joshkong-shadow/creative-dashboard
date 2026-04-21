import { useEffect, useMemo, useState } from "react";
import {
  BarChart, Bar, Line, XAxis, YAxis, CartesianGrid, Tooltip, Legend,
  ResponsiveContainer, Cell, ComposedChart,
} from "recharts";
import {
  aggregate, groupBy, monthly, winRate, toBreakdownRows,
  DIMENSIONS, dimensionValues,
} from "./aggregator.js";

const fmt = (n) => n == null ? "—" : n >= 1000000 ? `$${(n/1000000).toFixed(1)}M` : n >= 1000 ? `$${(n/1000).toFixed(0)}K` : `$${n.toFixed(0)}`;
const fmtFull = (n) => `$${Math.round(n).toLocaleString()}`;
const fmtNum = (n) => n == null ? "—" : Number(n).toLocaleString();
const fmtPct = (n) => n == null ? "—" : `${Number(n).toFixed(1)}%`;

const TABS = ["Overview", "Win Rate", "Concepts", "Agencies", "Creators", "Breakdowns", "Analysis", "Data Clean Up"];
const THRESHOLDS = ["$1K", "$5K", "$15K", "$25K", "$50K", "$100K", "$150K+"];

const RoasBadge = ({ roas }) => {
  const r = roas ?? 0;
  const bg = r >= 1.2 ? "#dcfce7" : r >= 1.0 ? "#f0fdf4" : r >= 0.8 ? "#fef9c3" : "#fee2e2";
  const color = r >= 1.2 ? "#166534" : r >= 1.0 ? "#15803d" : r >= 0.8 ? "#854d0e" : "#991b1b";
  return <span style={{ background: bg, color, padding: "2px 8px", borderRadius: 4, fontWeight: 600, fontSize: 13 }}>{r.toFixed(2)}x</span>;
};

const th = { padding: "8px 10px", color: "#64748b", fontWeight: 600, fontSize: 11, textTransform: "uppercase", letterSpacing: 0.3 };
const td = { padding: "8px 10px", color: "#334155", fontSize: 12 };

// Convert YYMMDD ↔ YYYY-MM-DD for <input type="date"> round-trips.
const yymmddToIso = (s) => s && /^\d{6}$/.test(s) ? `20${s.slice(0, 2)}-${s.slice(2, 4)}-${s.slice(4, 6)}` : "";
const isoToYymmdd = (s) => s && /^\d{4}-\d{2}-\d{2}$/.test(s) ? s.slice(2, 4) + s.slice(5, 7) + s.slice(8, 10) : null;

// Creation-date range picker shown above the tabs.
function DateRangePicker({ bounds, start, end, setStart, setEnd }) {
  if (!bounds) return null;
  const minIso = yymmddToIso(bounds.min);
  const maxIso = yymmddToIso(bounds.max);
  const isFiltered = start || end;
  return (
    <div style={{ display: "flex", alignItems: "center", gap: 10, marginBottom: 16, padding: "10px 14px", background: "#fff", border: "1px solid #e2e8f0", borderRadius: 8, flexWrap: "wrap" }}>
      <div style={{ fontSize: 11, color: "#64748b", fontWeight: 600, textTransform: "uppercase", letterSpacing: 0.3 }}>Ad creation date</div>
      <input type="date" value={yymmddToIso(start) || minIso} min={minIso} max={maxIso}
        onChange={e => setStart(isoToYymmdd(e.target.value))}
        style={{ padding: "4px 8px", borderRadius: 6, border: "1px solid #d1d5db", fontSize: 12, color: "#334155" }} />
      <span style={{ color: "#94a3b8", fontSize: 12 }}>→</span>
      <input type="date" value={yymmddToIso(end) || maxIso} min={minIso} max={maxIso}
        onChange={e => setEnd(isoToYymmdd(e.target.value))}
        style={{ padding: "4px 8px", borderRadius: 6, border: "1px solid #d1d5db", fontSize: 12, color: "#334155" }} />
      {isFiltered && (
        <button onClick={() => { setStart(null); setEnd(null); }}
          style={{ padding: "4px 10px", border: "1px solid #d1d5db", background: "#fff", color: "#64748b", borderRadius: 6, cursor: "pointer", fontSize: 11, fontWeight: 600 }}>Reset</button>
      )}
      <span title="Filters ads by the date encoded in the ad name (YYMMDD). This is the creative's birthdate — not the activity window. Spend/revenue shown are lifetime totals for ads created in this range."
        style={{ marginLeft: "auto", fontSize: 10, color: "#94a3b8", cursor: "help", fontStyle: "italic" }}>
        ⓘ Filters by ad creation date, not activity — spend shown is lifetime for ads in this range
      </span>
    </div>
  );
}

// Sortable header that cycles through desc → asc → none on click.
function SortHeader({ label, col, sort, setSort, align = "right" }) {
  const active = sort.col === col;
  const arrow = active ? (sort.dir === "desc" ? "↓" : "↑") : "";
  const onClick = () => {
    if (!active) return setSort({ col, dir: "desc" });
    if (sort.dir === "desc") return setSort({ col, dir: "asc" });
    return setSort({ col: "_spend", dir: "desc" }); // reset to default
  };
  return (
    <th
      onClick={onClick}
      style={{ ...th, textAlign: align, cursor: "pointer", userSelect: "none", color: active ? "#0f172a" : "#64748b" }}
      title="Click to sort"
    >
      {label} {arrow}
    </th>
  );
}

// Sort helper: respects string / number / nulls.
function sortRows(rows, col, dir) {
  const mul = dir === "desc" ? -1 : 1;
  return rows.slice().sort((a, b) => {
    let va = a[col], vb = b[col];
    if (va == null && vb == null) return 0;
    if (va == null) return 1;
    if (vb == null) return -1;
    if (typeof va === "string" && typeof vb === "string") return mul * va.localeCompare(vb);
    return mul * (va - vb);
  });
}

// --------- Ad list modal (shown when a bucket row is clicked) ---------
function AdListModal({ open, title, subtitle, ads, onClose }) {
  const [sort, setSort] = useState({ col: "spend", dir: "desc" });
  const sortedAds = useMemo(() => {
    if (!ads) return [];
    return ads.slice().sort((a, b) => {
      const mul = sort.dir === "desc" ? -1 : 1;
      let va = sort.col === "spend" ? a.metrics.spend
             : sort.col === "rev" ? a.metrics.meta_rev
             : sort.col === "roas" ? a.metrics.roas
             : sort.col === "new_visits" ? a.metrics.new_visits
             : sort.col === "visits" ? a.metrics.visits
             : sort.col === "ad_name" ? a.ad_name
             : a.metrics[sort.col];
      let vb = sort.col === "spend" ? b.metrics.spend
             : sort.col === "rev" ? b.metrics.meta_rev
             : sort.col === "roas" ? b.metrics.roas
             : sort.col === "new_visits" ? b.metrics.new_visits
             : sort.col === "visits" ? b.metrics.visits
             : sort.col === "ad_name" ? b.ad_name
             : b.metrics[sort.col];
      if (va == null) return 1;
      if (vb == null) return -1;
      if (typeof va === "string" && typeof vb === "string") return mul * va.localeCompare(vb);
      return mul * (va - vb);
    });
  }, [ads, sort]);

  if (!open) return null;

  const downloadCsv = () => {
    const headers = ["ad_name", "convention", "format", "ad_type", "icp", "problem", "creator_name", "agency", "batch_name", "hook", "wtad", "landing_page", "winner", "spend", "meta_rev", "meta_txns", "visits", "new_visits", "impressions"];
    const escape = (v) => v == null ? "" : typeof v === "string" && /[",\n]/.test(v) ? `"${v.replace(/"/g, '""')}"` : String(v);
    const lines = [headers.join(",")];
    for (const a of sortedAds) {
      lines.push(headers.map(h => escape(h in a.metrics ? a.metrics[h] : a[h])).join(","));
    }
    const blob = new Blob([lines.join("\n")], { type: "text/csv" });
    const url = URL.createObjectURL(blob);
    const link = document.createElement("a");
    link.href = url;
    link.download = `${title.replace(/[^a-z0-9]+/gi, "_")}_ads.csv`;
    link.click();
    URL.revokeObjectURL(url);
  };

  return (
    <div onClick={onClose} style={{ position: "fixed", inset: 0, background: "rgba(15,23,42,0.5)", zIndex: 1000, display: "flex", alignItems: "center", justifyContent: "center", padding: 24 }}>
      <div onClick={e => e.stopPropagation()} style={{ background: "#fff", borderRadius: 12, padding: 20, width: "min(1100px, 100%)", maxHeight: "85vh", display: "flex", flexDirection: "column", boxShadow: "0 20px 40px rgba(0,0,0,0.2)" }}>
        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-start", marginBottom: 12 }}>
          <div>
            <h3 style={{ margin: 0, fontSize: 15, fontWeight: 700, color: "#0f172a" }}>{title}</h3>
            {subtitle && <p style={{ margin: "4px 0 0", fontSize: 12, color: "#64748b" }}>{subtitle}</p>}
            <p style={{ margin: "4px 0 0", fontSize: 11, color: "#94a3b8" }}>{sortedAds.length.toLocaleString()} ads</p>
          </div>
          <div style={{ display: "flex", gap: 8 }}>
            <button onClick={downloadCsv} style={{ padding: "6px 12px", border: "1px solid #d1d5db", background: "#fff", borderRadius: 6, cursor: "pointer", fontSize: 12, fontWeight: 600, color: "#334155" }}>Download CSV ({sortedAds.length})</button>
            <button onClick={onClose} style={{ padding: "6px 12px", border: "none", background: "#0f172a", color: "#fff", borderRadius: 6, cursor: "pointer", fontSize: 12, fontWeight: 600 }}>Close</button>
          </div>
        </div>
        <div style={{ overflow: "auto", flex: 1 }}>
          <table style={{ width: "100%", borderCollapse: "collapse", fontSize: 11 }}>
            <thead style={{ position: "sticky", top: 0, background: "#fff", zIndex: 1 }}>
              <tr style={{ borderBottom: "2px solid #e2e8f0" }}>
                <SortHeader label="Ad Name" col="ad_name" sort={sort} setSort={setSort} align="left" />
                <th style={{ ...th, textAlign: "center" }}>Preview</th>
                <SortHeader label="Spend" col="spend" sort={sort} setSort={setSort} />
                <SortHeader label="Revenue" col="rev" sort={sort} setSort={setSort} />
                <SortHeader label="ROAS" col="roas" sort={sort} setSort={setSort} />
                <SortHeader label="% Visits (New)" col="new_visits" sort={sort} setSort={setSort} />
                <SortHeader label="Visits" col="visits" sort={sort} setSort={setSort} />
                <SortHeader label="Txns" col="meta_txns" sort={sort} setSort={setSort} />
              </tr>
            </thead>
            <tbody>
              {sortedAds.slice(0, 500).map((a, i) => {
                const pctNew = a.metrics.visits ? (a.metrics.new_visits / a.metrics.visits) * 100 : null;
                const adIds = a.meta_ad_ids || [];
                return (
                  <tr key={i} style={{ borderBottom: "1px solid #f1f5f9" }}>
                    <td style={{ ...td, fontSize: 10, fontFamily: "ui-monospace, monospace", maxWidth: 400, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }} title={a.ad_name}>{a.ad_name}</td>
                    <td style={{ ...td, textAlign: "center" }}>
                      {adIds.length > 0 ? (
                        <a href={`https://www.facebook.com/ads/library/?id=${adIds[0]}`} target="_blank" rel="noopener noreferrer"
                          title={adIds.length > 1 ? `${adIds.length} Meta ad IDs — opens first` : `Meta ad ID: ${adIds[0]}`}
                          style={{ color: "#2563eb", textDecoration: "none", fontSize: 10, fontWeight: 600 }}>
                          View{adIds.length > 1 ? ` (${adIds.length})` : ""} ↗
                        </a>
                      ) : <span style={{ color: "#cbd5e1", fontSize: 10 }}>—</span>}
                    </td>
                    <td style={{ ...td, textAlign: "right" }}>{fmt(a.metrics.spend)}</td>
                    <td style={{ ...td, textAlign: "right" }}>{fmt(a.metrics.meta_rev)}</td>
                    <td style={{ ...td, textAlign: "right" }}><RoasBadge roas={a.metrics.roas} /></td>
                    <td style={{ ...td, textAlign: "right" }}>{fmtPct(pctNew)}</td>
                    <td style={{ ...td, textAlign: "right", color: "#64748b" }}>{fmtNum(a.metrics.visits)}</td>
                    <td style={{ ...td, textAlign: "right", color: "#64748b" }}>{fmtNum(a.metrics.meta_txns)}</td>
                  </tr>
                );
              })}
            </tbody>
          </table>
          {sortedAds.length > 500 && <p style={{ fontSize: 11, color: "#94a3b8", marginTop: 12, textAlign: "center" }}>Showing top 500 — CSV export includes all {sortedAds.length.toLocaleString()}.</p>}
        </div>
      </div>
    </div>
  );
}

// --------- Sortable breakdown table (used across Concepts / Agencies / Creators / ICP) ---------
function BreakdownTable({ rows, nameLabel = "Name", onRowClick }) {
  const [sort, setSort] = useState({ col: "spend", dir: "desc" });
  const cols = [
    { key: "name", label: nameLabel, align: "left" },
    { key: "creatives", label: "Ads" },
    { key: "spend", label: "Spend" },
    { key: "revenue", label: "Revenue" },
    { key: "roas", label: "ROAS" },
    { key: "pct_new_visits", label: "% Visits (New)" },
    { key: "purchases", label: "Purchases" },
    { key: "aov", label: "AOV" },
    { key: "cpm", label: "CPM" },
    { key: "winRate1k", label: "WR $1K" },
    { key: "winRate15k", label: "WR $15K" },
    { key: "winRate50k", label: "WR $50K" },
  ];
  const sorted = useMemo(() => sortRows(rows, sort.col, sort.dir), [rows, sort]);
  return (
    <table style={{ width: "100%", borderCollapse: "collapse", fontSize: 12 }}>
      <thead>
        <tr style={{ borderBottom: "2px solid #e2e8f0" }}>
          {cols.map(c => <SortHeader key={c.key} label={c.label} col={c.key} sort={sort} setSort={setSort} align={c.align || "right"} />)}
        </tr>
      </thead>
      <tbody>
        {sorted.map((r, i) => (
          <tr key={i} onClick={() => onRowClick?.(r)} style={{ borderBottom: "1px solid #f1f5f9", cursor: onRowClick ? "pointer" : "default" }}
              onMouseEnter={e => onRowClick && (e.currentTarget.style.background = "#f8fafc")}
              onMouseLeave={e => onRowClick && (e.currentTarget.style.background = "transparent")}>
            <td style={{ ...td, fontWeight: 600 }}>{r.name}</td>
            <td style={{ ...td, textAlign: "right", color: "#64748b" }}>{fmtNum(r.creatives)}</td>
            <td style={{ ...td, textAlign: "right", fontWeight: 500 }}>{fmt(r.spend)}</td>
            <td style={{ ...td, textAlign: "right" }}>{fmt(r.revenue)}</td>
            <td style={{ ...td, textAlign: "right" }}><RoasBadge roas={r.roas} /></td>
            <td style={{ ...td, textAlign: "right" }}>{fmtPct(r.pct_new_visits)}</td>
            <td style={{ ...td, textAlign: "right", color: "#64748b" }}>{fmtNum(r.purchases)}</td>
            <td style={{ ...td, textAlign: "right", color: "#64748b" }}>{r.aov ? `$${r.aov.toFixed(0)}` : "—"}</td>
            <td style={{ ...td, textAlign: "right", color: "#64748b" }}>{r.cpm ? `$${r.cpm.toFixed(1)}` : "—"}</td>
            <td style={{ ...td, textAlign: "right" }}>{fmtPct(r.winRate1k)}</td>
            <td style={{ ...td, textAlign: "right" }}>{fmtPct(r.winRate15k)}</td>
            <td style={{ ...td, textAlign: "right" }}>{fmtPct(r.winRate50k)}</td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}

// --------- Win Rate table with sortable columns ---------
function WinRateTable({ wrData }) {
  const [sort, setSort] = useState({ col: "month", dir: "desc" });
  const { total, rows } = useMemo(() => {
    const total = wrData.find(r => r.month === "TOTAL");
    const rest = wrData.filter(r => r.month !== "TOTAL");
    const mul = sort.dir === "desc" ? -1 : 1;
    const sorted = rest.slice().sort((a, b) => {
      if (sort.col === "month") return mul * a.month.localeCompare(b.month);
      if (sort.col === "total") return mul * (a.total - b.total);
      // threshold key — sort by rate
      const ra = a.thresholds[sort.col]?.rate ?? 0;
      const rb = b.thresholds[sort.col]?.rate ?? 0;
      return mul * (ra - rb);
    });
    return { total, rows: sorted };
  }, [wrData, sort]);
  return (
    <div style={{ background: "#fff", borderRadius: 10, padding: 16, border: "1px solid #e2e8f0", overflowX: "auto" }}>
      <table style={{ width: "100%", borderCollapse: "collapse", fontSize: 12 }}>
        <thead>
          <tr style={{ borderBottom: "2px solid #e2e8f0" }}>
            <SortHeader label="Month" col="month" sort={sort} setSort={setSort} align="left" />
            <SortHeader label="Launched" col="total" sort={sort} setSort={setSort} />
            {THRESHOLDS.map(t => <SortHeader key={t} label={t} col={t} sort={sort} setSort={setSort} align="center" />)}
          </tr>
        </thead>
        <tbody>
          {rows.map((row, i) => (
            <tr key={i} style={{ borderBottom: "1px solid #f1f5f9" }}>
              <td style={td}>{row.month}</td>
              <td style={{ ...td, textAlign: "right" }}>{row.total.toLocaleString()}</td>
              {THRESHOLDS.map(t => {
                const d = row.thresholds[t];
                return (
                  <td key={t} style={{ padding: "6px 6px", textAlign: "center" }}>
                    <div style={{ fontSize: 13, fontWeight: 600, color: "#0f172a" }}>{d?.n ?? 0}</div>
                    <div style={{ fontSize: 10, color: (d?.rate ?? 0) >= 10 ? "#16a34a" : (d?.rate ?? 0) < 2 ? "#dc2626" : "#64748b" }}>{(d?.rate ?? 0).toFixed(1)}%</div>
                  </td>
                );
              })}
            </tr>
          ))}
          {total && (
            <tr style={{ borderBottom: "1px solid #f1f5f9", background: "#f8fafc", fontWeight: 700 }}>
              <td style={td}>{total.month}</td>
              <td style={{ ...td, textAlign: "right" }}>{total.total.toLocaleString()}</td>
              {THRESHOLDS.map(t => {
                const d = total.thresholds[t];
                return (
                  <td key={t} style={{ padding: "6px 6px", textAlign: "center" }}>
                    <div style={{ fontSize: 13, fontWeight: 600, color: "#0f172a" }}>{d?.n ?? 0}</div>
                    <div style={{ fontSize: 10, color: (d?.rate ?? 0) >= 10 ? "#16a34a" : (d?.rate ?? 0) < 2 ? "#dc2626" : "#64748b" }}>{(d?.rate ?? 0).toFixed(1)}%</div>
                  </td>
                );
              })}
            </tr>
          )}
        </tbody>
      </table>
    </div>
  );
}

// --------- Multi-dim grouping used by Analysis + Creator × Concept ---------
function multiGroupBy(ads, dims) {
  const buckets = new Map();
  for (const ad of ads) {
    const key = dims.map(d => ad[d] ?? "(untagged)").join(" × ");
    if (!buckets.has(key)) buckets.set(key, { key, ads: [], values: dims.map(d => ad[d] ?? "(untagged)") });
    buckets.get(key).ads.push(ad);
  }
  return Array.from(buckets.values()).map(b => ({ name: b.key, values: b.values, ads: b.ads, ...aggregate(b.ads) }));
}

// ====================== Main component ======================
export default function Dashboard() {
  const [manifest, setManifest] = useState(null);
  const [error, setError] = useState(null);
  const [tab, setTab] = useState("Overview");

  // Win Rate state
  const [wrFormat, setWrFormat] = useState("blended");
  const [wrThreshold, setWrThreshold] = useState("$1K");

  // Breakdowns state
  const [bdView, setBdView] = useState("ICP");
  const [ccSearch, setCcSearch] = useState("");
  const [ccMinSpend, setCcMinSpend] = useState(5000);

  // Analysis state. Each "rule" is {dim, values:Set} — empty set = "all values for this dim".
  const [anRules, setAnRules] = useState([{ dim: "problem", values: new Set() }]);
  const [anMetric, setAnMetric] = useState("spend");
  const [anMinSpend, setAnMinSpend] = useState(0);
  const [anTopN, setAnTopN] = useState(20);
  const [anExclusions, setAnExclusions] = useState({}); // {dim: Set of excluded values} — secondary exclude-list filter

  // Data Clean Up state
  const [cleanDim, setCleanDim] = useState("icp");
  const [mappings, setMappings] = useState({}); // {dim: {oldVal: newVal}}
  const [cleanSelectedValue, setCleanSelectedValue] = useState(null);
  const [savedAt, setSavedAt] = useState(null);

  // Creation-date filter. Null = "full range"; otherwise YYMMDD strings.
  const [dateStart, setDateStart] = useState(null);
  const [dateEnd, setDateEnd] = useState(null);

  // Global modal state (shared across tabs)
  const [modalState, setModalState] = useState({ open: false, title: "", subtitle: "", ads: [] });
  const openModal = (title, subtitle, ads) => setModalState({ open: true, title, subtitle, ads });
  const closeModal = () => setModalState(s => ({ ...s, open: false }));

  useEffect(() => {
    fetch(`${import.meta.env.BASE_URL}data/latest.json`)
      .then(r => {
        if (!r.ok) throw new Error(`${r.status}: ${r.statusText}`);
        return r.json();
      })
      .then(setManifest)
      .catch(e => setError(String(e)));
    // Load saved mappings from localStorage.
    try {
      const saved = localStorage.getItem("creative_dashboard_mappings");
      if (saved) setMappings(JSON.parse(saved));
    } catch {}
  }, []);

  // Bounds of ad creation dates in the raw data (YYMMDD strings).
  const dateBounds = useMemo(() => {
    const dates = (manifest?.ads ?? []).map(a => a.date).filter(d => d && /^\d{6}$/.test(d));
    if (!dates.length) return null;
    return { min: dates.reduce((a, b) => a < b ? a : b), max: dates.reduce((a, b) => a > b ? a : b) };
  }, [manifest]);

  // Apply mappings + creation-date filter to ads.
  const ads = useMemo(() => {
    let raw = manifest?.ads ?? [];
    if (dateStart || dateEnd) {
      raw = raw.filter(a => {
        if (!a.date || !/^\d{6}$/.test(a.date)) return false;
        if (dateStart && a.date < dateStart) return false;
        if (dateEnd && a.date > dateEnd) return false;
        return true;
      });
    }
    if (!Object.keys(mappings).length) return raw;
    return raw.map(a => {
      const copy = { ...a };
      for (const [dim, map] of Object.entries(mappings)) {
        if (copy[dim] != null && map[copy[dim]]) copy[dim] = map[copy[dim]];
      }
      return copy;
    });
  }, [manifest, mappings, dateStart, dateEnd]);

  const totals = useMemo(() => aggregate(ads), [ads]);
  const monthlyData = useMemo(() => monthly(ads), [ads]);
  const wrData = useMemo(() => winRate(ads, wrFormat), [ads, wrFormat]);
  const problems = useMemo(() => toBreakdownRows(groupBy(ads, "problem")), [ads]);
  const agencies = useMemo(() => toBreakdownRows(groupBy(ads, "agency")), [ads]);
  const creators = useMemo(() => toBreakdownRows(groupBy(ads, "creator_name")), [ads]);
  const icps = useMemo(() => toBreakdownRows(groupBy(ads, "icp")), [ads]);

  // Creator × Concept with filter
  const creatorConceptGroups = useMemo(() => {
    const filtered = ads.filter(a =>
      (a.metrics.spend || 0) >= ccMinSpend &&
      (!ccSearch || [a.creator_name, a.problem].some(v => (v || "").toLowerCase().includes(ccSearch.toLowerCase())))
    );
    return multiGroupBy(filtered, ["creator_name", "problem"])
      .map(g => ({ ...g, name: g.values.join(" × ") }))
      .sort((a, b) => b.spend - a.spend);
  }, [ads, ccMinSpend, ccSearch]);

  // ---- Analysis: apply inclusion rules, exclusions, then build tree ----
  const analysisAds = useMemo(() => {
    return ads.filter(a => {
      // Inclusion: for each rule with selected values, ad must match
      for (const rule of anRules) {
        if (!rule.dim || rule.values.size === 0) continue;
        const v = a[rule.dim] ?? "(untagged)";
        if (!rule.values.has(v)) return false;
      }
      // Exclusions
      for (const [dim, excluded] of Object.entries(anExclusions)) {
        if (excluded.size === 0) continue;
        const v = a[dim] ?? "(untagged)";
        if (excluded.has(v)) return false;
      }
      return true;
    });
  }, [ads, anRules, anExclusions]);

  // Build tree: dims = anRules ordered
  const analysisTree = useMemo(() => {
    const dims = anRules.map(r => r.dim).filter(Boolean);
    if (dims.length === 0) return [];
    const build = (ads, dimsLeft) => {
      const [d, ...rest] = dimsLeft;
      const groups = new Map();
      for (const ad of ads) {
        const v = ad[d] ?? "(untagged)";
        if (!groups.has(v)) groups.set(v, []);
        groups.get(v).push(ad);
      }
      return Array.from(groups.entries())
        .map(([v, rows]) => ({
          value: v,
          dim: d,
          ads: rows,
          agg: aggregate(rows),
          children: rest.length ? build(rows, rest) : null,
        }))
        .filter(n => n.agg.spend >= anMinSpend || dimsLeft.length < dims.length)
        .sort((a, b) => (b.agg[anMetric] ?? 0) - (a.agg[anMetric] ?? 0));
    };
    const root = build(analysisAds, dims);
    // Top-level: respect topN + min spend
    return root.filter(n => n.agg.spend >= anMinSpend).slice(0, anTopN);
  }, [analysisAds, anRules, anMetric, anMinSpend, anTopN]);

  // Flat list for the chart (top-level nodes only)
  const analysisChartData = useMemo(() =>
    analysisTree.map(n => ({ name: n.value, ...n.agg })),
    [analysisTree]
  );

  // Dimension values per dim (for exclude filter + Data Clean Up).
  const cleanValuesForDim = useMemo(() => dimensionValues(ads, cleanDim), [ads, cleanDim]);

  // Data Clean Up: sample ads for the selected value
  const cleanSampleAds = useMemo(() => {
    if (!cleanSelectedValue) return [];
    const target = cleanSelectedValue === "(untagged)" ? null : cleanSelectedValue;
    return ads.filter(a => a[cleanDim] === target || (a[cleanDim] == null && cleanSelectedValue === "(untagged)"));
  }, [ads, cleanDim, cleanSelectedValue]);

  // Mapping editor helpers
  const setMapping = (dim, oldVal, newVal) => {
    setMappings(m => {
      const nextDim = { ...(m[dim] || {}) };
      if (!newVal || newVal === oldVal) delete nextDim[oldVal];
      else nextDim[oldVal] = newVal;
      const next = { ...m, [dim]: nextDim };
      if (!Object.keys(nextDim).length) delete next[dim];
      return next;
    });
  };

  const [saveState, setSaveState] = useState({ status: "idle", msg: "" }); // idle | saving | ok | err
  const [patModalOpen, setPatModalOpen] = useState(false);
  const [categoryInspector, setCategoryInspector] = useState(null); // {dim, target} | null

  const pushToGithub = async (pat) => {
    setSaveState({ status: "saving", msg: "Pushing to GitHub…" });
    const repo = "joshkong-shadow/creative-dashboard";
    const path = "data/mappings.json";
    const api = `https://api.github.com/repos/${repo}/contents/${path}`;
    const headers = { Authorization: `token ${pat.trim()}`, Accept: "application/vnd.github+json" };
    try {
      let sha;
      const head = await fetch(api, { headers });
      if (head.ok) sha = (await head.json()).sha;
      else if (head.status !== 404) throw new Error(`GET ${path}: ${head.status}`);
      const content = btoa(unescape(encodeURIComponent(JSON.stringify(mappings, null, 2))));
      const put = await fetch(api, {
        method: "PUT",
        headers: { ...headers, "Content-Type": "application/json" },
        body: JSON.stringify({
          message: `chore(mappings): update via dashboard @ ${new Date().toISOString()}`,
          content,
          ...(sha ? { sha } : {}),
        }),
      });
      if (!put.ok) {
        const body = await put.text();
        if (put.status === 401 || put.status === 403) {
          localStorage.removeItem("creative_dashboard_gh_pat");
          setSaveState({ status: "err", msg: "Saved token rejected. Re-enter PAT." });
          setPatModalOpen(true);
          return;
        }
        throw new Error(`${put.status}: ${body.slice(0, 200)}`);
      }
      const res = await put.json();
      const sha7 = res.commit?.sha?.slice(0, 7) || "ok";
      setSaveState({ status: "ok", msg: `Committed to GitHub — ${sha7}` });
      // Blunt confirmation so the user can't miss it.
      window.alert(`✓ Mappings pushed to GitHub (commit ${sha7}). Next data refresh will pick them up.`);
    } catch (err) {
      const msg = String(err).slice(0, 300);
      setSaveState({ status: "err", msg });
      window.alert(`Save failed: ${msg}`);
    }
  };

  const saveMappings = () => {
    // Immediate visible state so the user always sees the click register, even
    // if the button handler hands off to a modal or a slow API call.
    setSaveState({ status: "saving", msg: "Saving…" });
    localStorage.setItem("creative_dashboard_mappings", JSON.stringify(mappings));
    setSavedAt(new Date());
    const pat = localStorage.getItem("creative_dashboard_gh_pat");
    if (pat) pushToGithub(pat);
    else { setPatModalOpen(true); setSaveState({ status: "idle", msg: "" }); }
  };

  const handlePatSaved = (pat) => {
    localStorage.setItem("creative_dashboard_gh_pat", pat.trim());
    setPatModalOpen(false);
    pushToGithub(pat);
  };

  const handlePatSkipped = () => {
    setPatModalOpen(false);
    const blob = new Blob([JSON.stringify(mappings, null, 2)], { type: "application/json" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a"); a.href = url; a.download = "mappings.json"; a.click();
    URL.revokeObjectURL(url);
    setSaveState({ status: "ok", msg: "Downloaded mappings.json (skipped GitHub sync)" });
  };

  const clearGithubPat = () => {
    localStorage.removeItem("creative_dashboard_gh_pat");
    setSaveState({ status: "ok", msg: "GitHub token cleared — you'll be prompted on next save." });
  };

  if (error) return <div style={{ padding: 24, fontFamily: "sans-serif", color: "#991b1b" }}>Error loading data: {error}</div>;
  if (!manifest) return <div style={{ padding: 24, fontFamily: "sans-serif", color: "#64748b" }}>Loading Northbeam data…</div>;

  const ALL_DIMS_LABELS = {
    format: "Format", ad_type: "Ad Type", icp: "ICP", problem: "Concept/Problem",
    creative_no: "Creative No.", agency: "Agency", batch_name: "Batch",
    creator_type: "Creator Type", creator_name: "Creator", hook: "Hook",
    wtad: "WTAD", landing_page: "Landing Page", paid_seed: "Paid/Seed",
    winner: "Winner", convention: "Convention",
  };

  const METRIC_MAP = {
    spend: { label: "Spend", fmt },
    rev: { label: "Revenue", fmt },
    roas: { label: "ROAS", fmt: v => v == null ? "—" : `${v.toFixed(2)}x` },
    pct_new_visits: { label: "% Visits (New)", fmt: fmtPct },
    count: { label: "# Ads", fmt: fmtNum },
    txns: { label: "Purchases", fmt: fmtNum },
    cpm: { label: "CPM", fmt: v => v == null ? "—" : `$${v.toFixed(2)}` },
    aov: { label: "AOV", fmt: v => v == null ? "—" : `$${v.toFixed(0)}` },
  };

  return (
    <div style={{ fontFamily: "'SF Pro Display', -apple-system, sans-serif", background: "#f8fafc", minHeight: "100vh", padding: "24px 20px" }}>
      <div style={{ maxWidth: 1280, margin: "0 auto" }}>
        <h1 style={{ fontSize: 22, fontWeight: 700, color: "#0f172a", margin: 0 }}>IM8 Meta Creative Performance Report</h1>
        <p style={{ color: "#64748b", fontSize: 13, margin: "4px 0 4px" }}>
          {manifest.period.start.slice(0, 10)} → {manifest.period.end.slice(0, 10)} · {ads.length.toLocaleString()} unique ads · Attribution: {manifest.attribution.primary}
        </p>
        <p style={{ color: "#94a3b8", fontSize: 11, margin: "0 0 12px" }}>
          Last refreshed: {new Date(manifest.generated_at).toLocaleString()} · {Object.keys(mappings).length} dims mapped
        </p>

        <DateRangePicker
          bounds={dateBounds}
          start={dateStart}
          end={dateEnd}
          setStart={setDateStart}
          setEnd={setDateEnd}
        />

        <div style={{ display: "flex", gap: 4, marginBottom: 20, background: "#e2e8f0", borderRadius: 8, padding: 3, overflowX: "auto" }}>
          {TABS.map(t => (
            <button key={t} onClick={() => setTab(t)} style={{
              flex: 1, padding: "8px 0", border: "none", borderRadius: 6, cursor: "pointer", fontSize: 12, fontWeight: 600, whiteSpace: "nowrap",
              background: tab === t ? "#fff" : "transparent", color: tab === t ? "#0f172a" : "#64748b",
              boxShadow: tab === t ? "0 1px 3px rgba(0,0,0,0.1)" : "none"
            }}>{t}</button>
          ))}
        </div>

        {tab === "Overview" && (
          <div>
            <div style={{ display: "grid", gridTemplateColumns: "repeat(5, 1fr)", gap: 12, marginBottom: 20 }}>
              {[
                { label: "Total Spend", value: fmt(totals.spend), sub: "Meta-reported" },
                { label: "Total Revenue", value: fmt(totals.rev), sub: "7d click + 1d view" },
                { label: "Blended ROAS", value: `${totals.roas.toFixed(2)}x`, sub: "rev / spend" },
                { label: "% Visits (New)", value: fmtPct(totals.pct_new_visits), sub: `${fmtNum(totals.visits)} visits` },
                { label: "Total Purchases", value: fmtNum(totals.txns), sub: `${ads.length.toLocaleString()} unique ads` },
              ].map((kpi, i) => (
                <div key={i} style={{ background: "#fff", borderRadius: 10, padding: "16px 14px", border: "1px solid #e2e8f0" }}>
                  <div style={{ fontSize: 10, color: "#94a3b8", fontWeight: 600, textTransform: "uppercase", letterSpacing: 0.5 }}>{kpi.label}</div>
                  <div style={{ fontSize: 20, fontWeight: 700, color: "#0f172a", marginTop: 4 }}>{kpi.value}</div>
                  <div style={{ fontSize: 11, color: "#94a3b8", marginTop: 2 }}>{kpi.sub}</div>
                </div>
              ))}
            </div>

            <div style={{ background: "#fff", borderRadius: 10, padding: 20, border: "1px solid #e2e8f0", marginBottom: 20 }}>
              <h3 style={{ fontSize: 14, fontWeight: 600, margin: "0 0 16px", color: "#334155" }}>Monthly Spend vs Revenue & ROAS (by ad creation month)</h3>
              <ResponsiveContainer width="100%" height={280}>
                <ComposedChart data={monthlyData}>
                  <CartesianGrid strokeDasharray="3 3" stroke="#f1f5f9" />
                  <XAxis dataKey="month" tick={{ fontSize: 11, fill: "#94a3b8" }} />
                  <YAxis yAxisId="left" tick={{ fontSize: 11, fill: "#94a3b8" }} tickFormatter={v => fmt(v)} />
                  <YAxis yAxisId="right" orientation="right" tick={{ fontSize: 11, fill: "#94a3b8" }} domain={[0, 1.5]} tickFormatter={v => `${v}x`} />
                  <Tooltip formatter={(v, n) => n === "ROAS" ? `${v.toFixed(2)}x` : fmtFull(v)} />
                  <Legend wrapperStyle={{ fontSize: 11 }} />
                  <Bar yAxisId="left" dataKey="spend" fill="#93c5fd" name="Spend" radius={[3, 3, 0, 0]} />
                  <Bar yAxisId="left" dataKey="revenue" fill="#86efac" name="Revenue" radius={[3, 3, 0, 0]} />
                  <Line yAxisId="right" dataKey="roas" stroke="#f97316" strokeWidth={2.5} dot={{ r: 4 }} name="ROAS" />
                </ComposedChart>
              </ResponsiveContainer>
            </div>

            <div style={{ background: "#fff", borderRadius: 10, padding: 20, border: "1px solid #e2e8f0" }}>
              <h3 style={{ fontSize: 14, fontWeight: 600, margin: "0 0 16px", color: "#334155" }}>Monthly Creative Volume (Video vs Image)</h3>
              <ResponsiveContainer width="100%" height={240}>
                <BarChart data={monthlyData}>
                  <CartesianGrid strokeDasharray="3 3" stroke="#f1f5f9" />
                  <XAxis dataKey="month" tick={{ fontSize: 11, fill: "#94a3b8" }} />
                  <YAxis tick={{ fontSize: 11, fill: "#94a3b8" }} />
                  <Tooltip />
                  <Legend wrapperStyle={{ fontSize: 11 }} />
                  <Bar dataKey="video" fill="#818cf8" name="Video" stackId="a" />
                  <Bar dataKey="image" fill="#fbbf24" name="Image" stackId="a" radius={[3, 3, 0, 0]} />
                </BarChart>
              </ResponsiveContainer>
            </div>
          </div>
        )}

        {tab === "Win Rate" && (
          <div>
            <div style={{ display: "flex", gap: 12, marginBottom: 16 }}>
              <div style={{ display: "flex", gap: 3, background: "#e2e8f0", borderRadius: 6, padding: 2 }}>
                {["blended", "video", "image"].map(f => (
                  <button key={f} onClick={() => setWrFormat(f)} style={{
                    padding: "6px 14px", border: "none", borderRadius: 5, cursor: "pointer", fontSize: 12, fontWeight: 600,
                    background: wrFormat === f ? "#fff" : "transparent", color: wrFormat === f ? "#0f172a" : "#64748b",
                  }}>{f === "blended" ? "All" : f === "video" ? "Video" : "Image"}</button>
                ))}
              </div>
              <select value={wrThreshold} onChange={e => setWrThreshold(e.target.value)}
                style={{ padding: "6px 10px", borderRadius: 6, border: "1px solid #d1d5db", fontSize: 12, fontWeight: 600, color: "#334155" }}>
                {THRESHOLDS.map(t => <option key={t} value={t}>Threshold: {t}</option>)}
              </select>
            </div>

            <div style={{ background: "#fff", borderRadius: 10, padding: 20, border: "1px solid #e2e8f0", marginBottom: 16 }}>
              <h3 style={{ fontSize: 14, fontWeight: 600, margin: "0 0 12px", color: "#334155" }}>
                Win Rate Trend — {wrThreshold} ({wrFormat === "blended" ? "All" : wrFormat === "video" ? "Video Only" : "Image Only"})
              </h3>
              <ResponsiveContainer width="100%" height={240}>
                <ComposedChart data={wrData.filter(d => d.month !== "TOTAL")}>
                  <CartesianGrid strokeDasharray="3 3" stroke="#f1f5f9" />
                  <XAxis dataKey="month" tick={{ fontSize: 11, fill: "#94a3b8" }} />
                  <YAxis yAxisId="left" tick={{ fontSize: 11, fill: "#94a3b8" }} />
                  <YAxis yAxisId="right" orientation="right" tick={{ fontSize: 11, fill: "#94a3b8" }} tickFormatter={v => `${v}%`} />
                  <Tooltip formatter={(v, n) => n === "Win Rate" ? `${v.toFixed(1)}%` : v} />
                  <Legend wrapperStyle={{ fontSize: 11 }} />
                  <Bar yAxisId="left" dataKey="total" fill="#cbd5e1" name="Total Launched" radius={[3, 3, 0, 0]} />
                  <Line yAxisId="right" type="monotone" stroke="#ef4444" strokeWidth={2.5} dot={{ r: 4 }} name="Win Rate"
                    dataKey={(d) => d.thresholds[wrThreshold]?.rate || 0} />
                </ComposedChart>
              </ResponsiveContainer>
            </div>

            <WinRateTable wrData={wrData} />
          </div>
        )}

        {tab === "Concepts" && (
          <div style={{ background: "#fff", borderRadius: 10, padding: 16, border: "1px solid #e2e8f0", overflowX: "auto" }}>
            <h3 style={{ fontSize: 14, fontWeight: 600, margin: "0 0 12px", color: "#334155" }}>Problem / Concept Performance ({problems.length} concepts) · <span style={{ fontWeight: 400, color: "#94a3b8" }}>click a row to drill into ads</span></h3>
            <BreakdownTable rows={problems} nameLabel="Concept" onRowClick={r => openModal(`Concept: ${r.name}`, `${r.creatives} ads · Spend ${fmt(r.spend)}`, r.ads)} />
          </div>
        )}

        {tab === "Agencies" && (
          <div style={{ background: "#fff", borderRadius: 10, padding: 16, border: "1px solid #e2e8f0", overflowX: "auto" }}>
            <h3 style={{ fontSize: 14, fontWeight: 600, margin: "0 0 12px", color: "#334155" }}>Agency / Team Performance ({agencies.length} agencies) · <span style={{ fontWeight: 400, color: "#94a3b8" }}>click a row to drill into ads</span></h3>
            <BreakdownTable rows={agencies} nameLabel="Agency" onRowClick={r => openModal(`Agency: ${r.name}`, `${r.creatives} ads · Spend ${fmt(r.spend)}`, r.ads)} />
          </div>
        )}

        {tab === "Creators" && (
          <div style={{ background: "#fff", borderRadius: 10, padding: 16, border: "1px solid #e2e8f0", overflowX: "auto" }}>
            <h3 style={{ fontSize: 14, fontWeight: 600, margin: "0 0 12px", color: "#334155" }}>Creator Performance ({creators.length} creators) · <span style={{ fontWeight: 400, color: "#94a3b8" }}>click a row to drill into ads</span></h3>
            <BreakdownTable rows={creators} nameLabel="Creator" onRowClick={r => openModal(`Creator: ${r.name}`, `${r.creatives} ads · Spend ${fmt(r.spend)}`, r.ads)} />
          </div>
        )}

        {tab === "Breakdowns" && (
          <div>
            <div style={{ display: "flex", gap: 3, background: "#e2e8f0", borderRadius: 6, padding: 2, marginBottom: 16, width: "fit-content" }}>
              {["ICP", "Creator × Concept"].map(v => (
                <button key={v} onClick={() => setBdView(v)} style={{
                  padding: "6px 14px", border: "none", borderRadius: 5, cursor: "pointer", fontSize: 12, fontWeight: 600,
                  background: bdView === v ? "#fff" : "transparent", color: bdView === v ? "#0f172a" : "#64748b",
                }}>{v}</button>
              ))}
            </div>

            {bdView === "ICP" && (
              <div style={{ background: "#fff", borderRadius: 10, padding: 16, border: "1px solid #e2e8f0", overflowX: "auto" }}>
                <h3 style={{ fontSize: 14, fontWeight: 600, margin: "0 0 12px", color: "#334155" }}>Performance by ICP ({icps.length} segments)</h3>
                <BreakdownTable rows={icps} nameLabel="ICP" onRowClick={r => openModal(`ICP: ${r.name}`, `${r.creatives} ads · Spend ${fmt(r.spend)}`, r.ads)} />
              </div>
            )}

            {bdView === "Creator × Concept" && (
              <div>
                <div style={{ display: "flex", gap: 12, alignItems: "center", marginBottom: 12, flexWrap: "wrap" }}>
                  <input type="text" placeholder="Search creator or concept..." value={ccSearch} onChange={e => setCcSearch(e.target.value)}
                    style={{ padding: "6px 10px", borderRadius: 6, border: "1px solid #d1d5db", fontSize: 12, width: 240 }} />
                  <label style={{ fontSize: 12, color: "#64748b" }}>Min spend: <strong style={{ color: "#0f172a" }}>{fmt(ccMinSpend)}</strong></label>
                  <input type="range" min={0} max={500000} step={1000} value={ccMinSpend} onChange={e => setCcMinSpend(+e.target.value)} style={{ width: 200 }} />
                  <span style={{ fontSize: 12, color: "#94a3b8" }}>{creatorConceptGroups.length} rows · click to drill in</span>
                </div>
                <div style={{ background: "#fff", borderRadius: 10, padding: 16, border: "1px solid #e2e8f0", overflowX: "auto", maxHeight: 600, overflowY: "auto" }}>
                  <BreakdownTable rows={creatorConceptGroups.map(g => ({
                    name: g.name, creatives: g.count, ads: g.ads, spend: g.spend, revenue: g.rev, roas: g.roas,
                    pct_new_visits: g.pct_new_visits, purchases: g.txns, aov: g.aov, cpm: g.cpm,
                    winRate1k: (g.ads.filter(a => (a.metrics.spend||0) >= 1000).length / (g.ads.length||1)) * 100,
                    winRate15k: (g.ads.filter(a => (a.metrics.spend||0) >= 15000).length / (g.ads.length||1)) * 100,
                    winRate50k: (g.ads.filter(a => (a.metrics.spend||0) >= 50000).length / (g.ads.length||1)) * 100,
                  }))} nameLabel="Creator × Concept" onRowClick={r => openModal(r.name, `${r.creatives} ads · Spend ${fmt(r.spend)}`, r.ads)} />
                </div>
              </div>
            )}
          </div>
        )}

        {tab === "Analysis" && (
          <AnalysisTab
            ads={ads}
            ALL_DIMS_LABELS={ALL_DIMS_LABELS}
            METRIC_MAP={METRIC_MAP}
            anRules={anRules} setAnRules={setAnRules}
            anMetric={anMetric} setAnMetric={setAnMetric}
            anMinSpend={anMinSpend} setAnMinSpend={setAnMinSpend}
            anTopN={anTopN} setAnTopN={setAnTopN}
            anExclusions={anExclusions} setAnExclusions={setAnExclusions}
            analysisTree={analysisTree}
            analysisChartData={analysisChartData}
            openModal={openModal}
          />
        )}

        {tab === "Data Clean Up" && (
          <div>
            <div style={{ background: "#fff", borderRadius: 10, padding: 16, border: "1px solid #e2e8f0", marginBottom: 16 }}>
              <div style={{ display: "flex", justifyContent: "space-between", alignItems: "start", marginBottom: 12, gap: 12 }}>
                <p style={{ fontSize: 12, color: "#64748b", margin: 0, maxWidth: 720 }}>
                  Review unique values parsed from ad names. Click any value to preview 10 sample ads + download full CSV.
                  Use <strong>Edit</strong> to reclassify a value into an existing category or create a new one (e.g. <code>MULTIPLESUPP</code> → <code>MULTISUPP</code>).
                  Save pushes <code>data/mappings.json</code> to GitHub so the next data refresh picks it up.
                </p>
                <div style={{ display: "flex", gap: 8, alignItems: "center" }}>
                  {saveState.status === "ok" && <span style={{ fontSize: 11, color: "#16a34a", maxWidth: 240 }} title={saveState.msg}>✓ {saveState.msg}</span>}
                  {saveState.status === "err" && <span style={{ fontSize: 11, color: "#dc2626", maxWidth: 240 }} title={saveState.msg}>✕ {saveState.msg}</span>}
                  {saveState.status === "saving" && <span style={{ fontSize: 11, color: "#64748b" }}>Saving…</span>}
                  {savedAt && saveState.status === "idle" && <span style={{ fontSize: 11, color: "#16a34a" }}>Saved {savedAt.toLocaleTimeString()}</span>}
                  <button onClick={saveMappings} disabled={saveState.status === "saving"}
                    style={{ padding: "6px 14px", border: "none", background: saveState.status === "saving" ? "#94a3b8" : "#0f172a", color: "#fff", borderRadius: 6, cursor: saveState.status === "saving" ? "wait" : "pointer", fontSize: 12, fontWeight: 600 }}>
                    Save mappings
                  </button>
                  <button onClick={clearGithubPat} title="Clear saved GitHub token"
                    style={{ padding: "6px 8px", border: "1px solid #d1d5db", background: "#fff", color: "#64748b", borderRadius: 6, cursor: "pointer", fontSize: 11 }}>
                    ⚙
                  </button>
                </div>
              </div>
              <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
                {DIMENSIONS.map(d => {
                  const mapped = Object.keys(mappings[d] || {}).length;
                  return (
                    <button key={d} onClick={() => { setCleanDim(d); setCleanSelectedValue(null); }} style={{
                      padding: "4px 10px", border: "1px solid #d1d5db", borderRadius: 5, cursor: "pointer",
                      fontSize: 12, fontWeight: 600,
                      background: cleanDim === d ? "#0f172a" : "#fff",
                      color: cleanDim === d ? "#fff" : "#64748b",
                    }}>{d}{mapped > 0 && <span style={{ marginLeft: 4, fontSize: 10, color: cleanDim === d ? "#86efac" : "#16a34a" }}>· {mapped}</span>}</button>
                  );
                })}
              </div>
            </div>

            <div style={{ display: "grid", gridTemplateColumns: cleanSelectedValue ? "1fr 380px" : "1fr", gap: 16 }}>
              <div style={{ background: "#fff", borderRadius: 10, padding: 16, border: "1px solid #e2e8f0", overflowX: "auto" }}>
                <h3 style={{ fontSize: 14, fontWeight: 600, margin: "0 0 12px", color: "#334155" }}>
                  {cleanDim} — {cleanValuesForDim.length} unique values
                </h3>
                <CleanupTable values={cleanValuesForDim} mappings={mappings[cleanDim] || {}} setMapping={(o, n) => setMapping(cleanDim, o, n)} selected={cleanSelectedValue} onSelect={setCleanSelectedValue}
                  onInspectCategory={(target) => setCategoryInspector({ dim: cleanDim, target })} />
              </div>

              {cleanSelectedValue && (
                <div style={{ background: "#fff", borderRadius: 10, padding: 16, border: "1px solid #e2e8f0" }}>
                  <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 8 }}>
                    <h3 style={{ fontSize: 13, fontWeight: 600, margin: 0, color: "#334155" }}>Sample ads: <code>{cleanSelectedValue}</code></h3>
                    <button onClick={() => setCleanSelectedValue(null)} style={{ border: "none", background: "transparent", color: "#94a3b8", cursor: "pointer", fontSize: 14 }}>×</button>
                  </div>
                  <p style={{ fontSize: 11, color: "#94a3b8", margin: "0 0 10px" }}>
                    {cleanSampleAds.length} ads · showing 10 ·
                    <button onClick={() => openModal(`${cleanDim}=${cleanSelectedValue}`, `${cleanSampleAds.length} ads`, cleanSampleAds)}
                      style={{ marginLeft: 6, border: "none", background: "transparent", color: "#2563eb", cursor: "pointer", fontSize: 11, fontWeight: 600 }}>see all / download CSV</button>
                  </p>
                  <div style={{ fontSize: 10, fontFamily: "ui-monospace, monospace", color: "#334155", maxHeight: 400, overflowY: "auto" }}>
                    {cleanSampleAds.slice(0, 10).map((a, i) => (
                      <div key={i} style={{ padding: "6px 0", borderBottom: "1px solid #f1f5f9", wordBreak: "break-all" }}>
                        <div style={{ fontSize: 10, color: "#94a3b8" }}>{fmt(a.metrics.spend)} spend · {fmtNum(a.metrics.meta_txns)} txns</div>
                        {a.ad_name}
                      </div>
                    ))}
                  </div>
                </div>
              )}
            </div>
          </div>
        )}
      </div>

      <AdListModal open={modalState.open} title={modalState.title} subtitle={modalState.subtitle} ads={modalState.ads} onClose={closeModal} />
      <PatModal open={patModalOpen} onSave={handlePatSaved} onSkip={handlePatSkipped} onClose={() => setPatModalOpen(false)} />
      {categoryInspector && (
        <CategoryMembersModal
          dim={categoryInspector.dim}
          target={categoryInspector.target}
          mappings={mappings}
          values={dimensionValues(manifest?.ads ?? [], categoryInspector.dim)}
          onRemove={(raw) => setMapping(categoryInspector.dim, raw, "")}
          onClose={() => setCategoryInspector(null)}
        />
      )}
    </div>
  );
}

// -------- Cleanup table subcomponent (sortable, clickable, Edit-popover) --------
function CleanupTable({ values, mappings, setMapping, selected, onSelect, onInspectCategory }) {
  const [sort, setSort] = useState({ col: "spend", dir: "desc" });
  const [editingValue, setEditingValue] = useState(null);

  const sorted = useMemo(() => {
    const mul = sort.dir === "desc" ? -1 : 1;
    return values.slice().sort((a, b) => {
      const va = a[sort.col], vb = b[sort.col];
      if (typeof va === "string") return mul * va.localeCompare(vb);
      return mul * (va - vb);
    });
  }, [values, sort]);

  // Union of raw values + existing mapping targets — these are the "categories" available.
  const categories = useMemo(() => {
    const set = new Set(values.map(v => v.value));
    for (const target of Object.values(mappings)) if (target) set.add(target);
    return Array.from(set).sort((a, b) => String(a).localeCompare(String(b)));
  }, [values, mappings]);

  // Reverse index: for each target, list of raw values that merge into it.
  const mergedInto = useMemo(() => {
    const m = {};
    for (const [raw, target] of Object.entries(mappings)) {
      if (!target) continue;
      (m[target] ||= []).push(raw);
    }
    return m;
  }, [mappings]);

  return (
    <>
      <table style={{ width: "100%", borderCollapse: "collapse", fontSize: 12 }}>
        <thead>
          <tr style={{ borderBottom: "2px solid #e2e8f0" }}>
            <SortHeader label="Value" col="value" sort={sort} setSort={setSort} align="left" />
            <SortHeader label="Ads" col="n" sort={sort} setSort={setSort} />
            <SortHeader label="Total Spend" col="spend" sort={sort} setSort={setSort} />
            <th style={{ ...th, textAlign: "left" }}>Mapped to</th>
            <th style={{ ...th, textAlign: "right" }}></th>
          </tr>
        </thead>
        <tbody>
          {sorted.slice(0, 300).map((v) => {
            const mapped = mappings[v.value];
            return (
              <tr key={v.value} onClick={() => onSelect(v.value)}
                  style={{ borderBottom: "1px solid #f1f5f9", cursor: "pointer", background: selected === v.value ? "#eff6ff" : "transparent" }}>
                <td style={{ ...td, fontFamily: "ui-monospace, monospace" }}>{v.value}</td>
                <td style={{ ...td, textAlign: "right", color: "#64748b" }}>{fmtNum(v.n)}</td>
                <td style={{ ...td, textAlign: "right" }}>{fmt(v.spend)}</td>
                <td style={{ ...td, fontFamily: "ui-monospace, monospace" }} onClick={e => e.stopPropagation()}>
                  {mapped ? (
                    <button onClick={() => onInspectCategory?.(mapped)}
                      title="Click to see everything merged into this master category"
                      style={{ background: "#dcfce7", color: "#166534", padding: "2px 8px", borderRadius: 4, fontWeight: 600, border: "none", cursor: "pointer", fontFamily: "ui-monospace, monospace", fontSize: 12 }}>
                      {mapped} ↗
                    </button>
                  ) : mergedInto[v.value]?.length ? (
                    <button onClick={() => onInspectCategory?.(v.value)}
                      title={`${mergedInto[v.value].length} value(s) merged into this master category — click to see`}
                      style={{ background: "#e0e7ff", color: "#3730a3", padding: "2px 8px", borderRadius: 4, fontWeight: 600, border: "none", cursor: "pointer", fontFamily: "ui-monospace, monospace", fontSize: 11 }}>
                      +{mergedInto[v.value].length} merged ↗
                    </button>
                  ) : <span style={{ color: "#cbd5e1" }}>—</span>}
                </td>
                <td style={{ ...td, textAlign: "right" }} onClick={e => e.stopPropagation()}>
                  <button onClick={() => setEditingValue(v.value)}
                    style={{ padding: "3px 10px", border: "1px solid #d1d5db", background: "#fff", borderRadius: 5, cursor: "pointer", fontSize: 11, fontWeight: 600, color: "#334155" }}>
                    Edit
                  </button>
                  {mapped && (
                    <button onClick={() => setMapping(v.value, "")} title="Clear mapping"
                      style={{ marginLeft: 4, padding: "3px 6px", border: "1px solid #fecaca", background: "#fff", color: "#dc2626", borderRadius: 5, cursor: "pointer", fontSize: 11, fontWeight: 600 }}>
                      ×
                    </button>
                  )}
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
      {editingValue != null && (
        <EditCategoryModal
          value={editingValue}
          current={mappings[editingValue] || ""}
          categories={categories.filter(c => c !== editingValue)}
          onSave={(newVal) => { setMapping(editingValue, newVal); setEditingValue(null); }}
          onClose={() => setEditingValue(null)}
        />
      )}
    </>
  );
}

// -------- GitHub PAT entry modal (replaces window.prompt which Pages can block) --------
function PatModal({ open, onSave, onSkip, onClose }) {
  const [pat, setPat] = useState("");
  if (!open) return null;
  const submit = () => { if (pat.trim()) onSave(pat); };
  return (
    <div onClick={onClose} style={{ position: "fixed", inset: 0, background: "rgba(15,23,42,0.55)", zIndex: 2100, display: "flex", alignItems: "center", justifyContent: "center", padding: 20 }}>
      <div onClick={e => e.stopPropagation()}
        style={{ background: "#fff", borderRadius: 10, width: 480, boxShadow: "0 20px 40px rgba(0,0,0,0.2)" }}>
        <div style={{ padding: "16px 18px", borderBottom: "1px solid #e2e8f0" }}>
          <div style={{ fontSize: 15, fontWeight: 700, color: "#0f172a" }}>Sync mappings to GitHub</div>
          <div style={{ fontSize: 12, color: "#64748b", marginTop: 4 }}>Paste a GitHub Personal Access Token to push <code>data/mappings.json</code> to the repo. Stored in this browser only.</div>
        </div>
        <div style={{ padding: "14px 18px" }}>
          <a href="https://github.com/settings/personal-access-tokens/new" target="_blank" rel="noopener noreferrer"
            style={{ fontSize: 11, color: "#2563eb", textDecoration: "none", fontWeight: 600 }}>Create a fine-grained PAT (repo contents: R&W) →</a>
          <input
            type="password"
            autoFocus
            value={pat}
            onChange={e => setPat(e.target.value)}
            onKeyDown={e => { if (e.key === "Enter") submit(); }}
            placeholder="github_pat_... or ghp_..."
            style={{ width: "100%", marginTop: 10, padding: "8px 10px", borderRadius: 6, border: "1px solid #d1d5db", fontSize: 12, fontFamily: "ui-monospace, monospace" }}
          />
          <div style={{ fontSize: 10, color: "#94a3b8", marginTop: 6 }}>Token stays in localStorage. Clear it anytime via the ⚙ button on the Data Clean Up tab.</div>
        </div>
        <div style={{ padding: "12px 18px", borderTop: "1px solid #e2e8f0", display: "flex", gap: 8, justifyContent: "flex-end" }}>
          <button onClick={onSkip}
            style={{ padding: "6px 12px", border: "1px solid #d1d5db", background: "#fff", color: "#64748b", borderRadius: 6, cursor: "pointer", fontSize: 12, fontWeight: 600 }}>
            Skip (download JSON)
          </button>
          <button onClick={submit} disabled={!pat.trim()}
            style={{ padding: "6px 14px", border: "none", background: pat.trim() ? "#0f172a" : "#cbd5e1", color: "#fff", borderRadius: 6, cursor: pat.trim() ? "pointer" : "not-allowed", fontSize: 12, fontWeight: 600 }}>
            Save & push to GitHub
          </button>
        </div>
      </div>
    </div>
  );
}

// -------- Category members modal — shows all raw values currently resolving to a target --------
function CategoryMembersModal({ dim, target, mappings, values, onRemove, onClose }) {
  const dimMappings = mappings[dim] || {};
  // Members = raw values explicitly mapped to this target, plus the target itself if it's a native raw value.
  const members = useMemo(() => {
    const mapped = Object.entries(dimMappings).filter(([, t]) => t === target).map(([raw]) => raw);
    const self = values.find(v => v.value === target) && !dimMappings[target] ? [target] : [];
    const all = [...new Set([...self, ...mapped])];
    return all.map(raw => {
      const stat = values.find(v => v.value === raw);
      return { raw, n: stat?.n ?? 0, spend: stat?.spend ?? 0, isSelf: raw === target && !dimMappings[raw] };
    }).sort((a, b) => b.spend - a.spend);
  }, [dim, target, mappings, values, dimMappings]);
  const totals = members.reduce((a, m) => ({ n: a.n + m.n, spend: a.spend + m.spend }), { n: 0, spend: 0 });
  return (
    <div onClick={onClose} style={{ position: "fixed", inset: 0, background: "rgba(15,23,42,0.5)", zIndex: 2050, display: "flex", alignItems: "center", justifyContent: "center", padding: 20 }}>
      <div onClick={e => e.stopPropagation()}
        style={{ background: "#fff", borderRadius: 10, width: 520, maxHeight: "80vh", display: "flex", flexDirection: "column", boxShadow: "0 20px 40px rgba(0,0,0,0.2)" }}>
        <div style={{ padding: "14px 16px", borderBottom: "1px solid #e2e8f0" }}>
          <div style={{ fontSize: 11, color: "#94a3b8", fontWeight: 600, textTransform: "uppercase", letterSpacing: 0.3 }}>Master category · {dim}</div>
          <div style={{ fontSize: 15, fontWeight: 700, color: "#0f172a", fontFamily: "ui-monospace, monospace" }}>{target}</div>
          <div style={{ fontSize: 11, color: "#64748b", marginTop: 2 }}>{members.length} member{members.length !== 1 ? "s" : ""} · {fmtNum(totals.n)} ads · {fmt(totals.spend)}</div>
        </div>
        <div style={{ overflowY: "auto", flex: 1 }}>
          {members.map(m => (
            <div key={m.raw} style={{ display: "flex", alignItems: "center", padding: "8px 14px", borderBottom: "1px solid #f1f5f9", gap: 10 }}>
              <div style={{ flex: 1, fontFamily: "ui-monospace, monospace", fontSize: 12 }}>
                {m.raw}
                {m.isSelf && <span style={{ marginLeft: 6, fontSize: 9, color: "#64748b", background: "#f1f5f9", padding: "1px 5px", borderRadius: 3 }}>CANONICAL</span>}
              </div>
              <div style={{ fontSize: 11, color: "#64748b", minWidth: 60, textAlign: "right" }}>{fmtNum(m.n)}</div>
              <div style={{ fontSize: 11, color: "#334155", minWidth: 70, textAlign: "right", fontWeight: 500 }}>{fmt(m.spend)}</div>
              {!m.isSelf && (
                <button onClick={() => onRemove(m.raw)} title="Remove this mapping"
                  style={{ border: "1px solid #fecaca", background: "#fff", color: "#dc2626", borderRadius: 4, cursor: "pointer", fontSize: 10, padding: "2px 6px", fontWeight: 600 }}>
                  Unmap
                </button>
              )}
            </div>
          ))}
          {members.length === 0 && <div style={{ padding: 20, textAlign: "center", fontSize: 11, color: "#94a3b8" }}>No members yet</div>}
        </div>
        <div style={{ padding: "10px 14px", borderTop: "1px solid #e2e8f0", display: "flex", justifyContent: "flex-end" }}>
          <button onClick={onClose}
            style={{ padding: "6px 14px", border: "none", background: "#0f172a", color: "#fff", borderRadius: 6, cursor: "pointer", fontSize: 12, fontWeight: 600 }}>Close</button>
        </div>
      </div>
    </div>
  );
}

// -------- Edit category modal (pick existing or create new) --------
function EditCategoryModal({ value, current, categories, onSave, onClose }) {
  const [search, setSearch] = useState("");
  const [creating, setCreating] = useState(false);
  const [newName, setNewName] = useState("");

  const filtered = useMemo(
    () => categories.filter(c => !search || String(c).toLowerCase().includes(search.toLowerCase())),
    [categories, search]
  );

  return (
    <div onClick={onClose} style={{ position: "fixed", inset: 0, background: "rgba(15,23,42,0.5)", zIndex: 2000, display: "flex", alignItems: "center", justifyContent: "center" }}>
      <div onClick={e => e.stopPropagation()}
        style={{ background: "#fff", borderRadius: 10, width: 420, maxHeight: "80vh", display: "flex", flexDirection: "column", boxShadow: "0 20px 40px rgba(0,0,0,0.2)" }}>
        <div style={{ padding: "14px 16px", borderBottom: "1px solid #e2e8f0" }}>
          <div style={{ fontSize: 11, color: "#94a3b8", fontWeight: 600, textTransform: "uppercase", letterSpacing: 0.3 }}>Reclassify</div>
          <div style={{ fontSize: 13, fontWeight: 700, color: "#0f172a", fontFamily: "ui-monospace, monospace", marginTop: 2, wordBreak: "break-all" }}>{value}</div>
          {current && <div style={{ fontSize: 11, color: "#64748b", marginTop: 4 }}>Currently mapped to <strong style={{ color: "#166534" }}>{current}</strong></div>}
        </div>
        <div style={{ padding: "10px 12px", borderBottom: "1px solid #e2e8f0" }}>
          <input autoFocus placeholder="Search existing categories…" value={search} onChange={e => setSearch(e.target.value)}
            style={{ width: "100%", padding: "6px 10px", borderRadius: 6, border: "1px solid #d1d5db", fontSize: 12 }} />
        </div>
        <div style={{ overflowY: "auto", flex: 1, maxHeight: 320 }}>
          {filtered.map(c => (
            <div key={c} onClick={() => onSave(c)}
              style={{ padding: "8px 14px", fontSize: 12, fontFamily: "ui-monospace, monospace", cursor: "pointer", borderBottom: "1px solid #f1f5f9", background: c === current ? "#eff6ff" : "transparent", display: "flex", alignItems: "center", gap: 6 }}
              onMouseEnter={e => e.currentTarget.style.background = "#f8fafc"}
              onMouseLeave={e => e.currentTarget.style.background = c === current ? "#eff6ff" : "transparent"}>
              {c === current && <span style={{ color: "#16a34a", fontSize: 11 }}>✓</span>}
              <span>{c}</span>
            </div>
          ))}
          {filtered.length === 0 && <div style={{ padding: 20, textAlign: "center", fontSize: 11, color: "#94a3b8" }}>No matches</div>}
        </div>
        <div style={{ padding: "10px 12px", borderTop: "1px solid #e2e8f0", display: "flex", gap: 8, alignItems: "center" }}>
          {creating ? (
            <>
              <input autoFocus placeholder="New category name" value={newName} onChange={e => setNewName(e.target.value)}
                onKeyDown={e => { if (e.key === "Enter" && newName.trim()) onSave(newName.trim()); }}
                style={{ flex: 1, padding: "6px 10px", borderRadius: 6, border: "1px solid #d1d5db", fontSize: 12, fontFamily: "ui-monospace, monospace" }} />
              <button onClick={() => newName.trim() && onSave(newName.trim())}
                style={{ padding: "6px 12px", border: "none", background: "#0f172a", color: "#fff", borderRadius: 6, cursor: "pointer", fontSize: 12, fontWeight: 600 }}>Save</button>
              <button onClick={() => { setCreating(false); setNewName(""); }}
                style={{ padding: "6px 10px", border: "1px solid #d1d5db", background: "#fff", color: "#64748b", borderRadius: 6, cursor: "pointer", fontSize: 12 }}>Cancel</button>
            </>
          ) : (
            <>
              <button onClick={() => setCreating(true)}
                style={{ padding: "6px 12px", border: "1px dashed #94a3b8", background: "#fff", color: "#334155", borderRadius: 6, cursor: "pointer", fontSize: 12, fontWeight: 600 }}>+ Create new category</button>
              <span style={{ marginLeft: "auto", fontSize: 11, color: "#94a3b8" }}>Click a category to apply</span>
            </>
          )}
        </div>
      </div>
    </div>
  );
}

// -------- Chip multiselect for a dimension's values --------
function ValuePicker({ ads, dim, selected, onToggle, onClear }) {
  const [open, setOpen] = useState(false);
  const [search, setSearch] = useState("");
  const values = useMemo(() => dim ? dimensionValues(ads, dim) : [], [ads, dim]);
  const filtered = useMemo(
    () => values.filter(v => !search || String(v.value).toLowerCase().includes(search.toLowerCase())),
    [values, search]
  );
  const selArr = Array.from(selected);

  return (
    <div style={{ position: "relative", flex: 1, minWidth: 280 }}>
      <div onClick={() => setOpen(o => !o)}
        style={{ display: "flex", gap: 4, flexWrap: "wrap", alignItems: "center", padding: "6px 10px", background: "#fff", border: "1px solid #d1d5db", borderRadius: 6, cursor: "pointer", minHeight: 32 }}>
        {selArr.length === 0 ? (
          <span style={{ color: "#94a3b8", fontSize: 12 }}>{dim ? `All ${values.length} values` : "Pick a dimension first"}</span>
        ) : (
          <>
            {selArr.slice(0, 4).map(v => (
              <span key={v} style={{ fontSize: 11, background: "#dbeafe", color: "#1e40af", padding: "2px 6px", borderRadius: 4, display: "inline-flex", alignItems: "center", gap: 4 }}>
                {v}
                <button onClick={e => { e.stopPropagation(); onToggle(v); }} style={{ border: "none", background: "transparent", color: "#1e40af", cursor: "pointer", padding: 0, fontSize: 12 }}>×</button>
              </span>
            ))}
            {selArr.length > 4 && <span style={{ fontSize: 11, color: "#64748b" }}>+{selArr.length - 4} more</span>}
          </>
        )}
        <span style={{ marginLeft: "auto", color: "#94a3b8", fontSize: 11 }}>▾</span>
      </div>
      {open && dim && (
        <div style={{ position: "absolute", top: "100%", left: 0, right: 0, marginTop: 4, background: "#fff", border: "1px solid #d1d5db", borderRadius: 6, boxShadow: "0 6px 16px rgba(0,0,0,0.1)", zIndex: 20, maxHeight: 320, overflowY: "auto" }}>
          <div style={{ padding: 8, borderBottom: "1px solid #e2e8f0", position: "sticky", top: 0, background: "#fff", display: "flex", gap: 8, alignItems: "center" }}>
            <input autoFocus placeholder="Search values…" value={search} onChange={e => setSearch(e.target.value)}
              style={{ flex: 1, padding: "4px 8px", borderRadius: 4, border: "1px solid #e2e8f0", fontSize: 11 }} />
            {selArr.length > 0 && <button onClick={onClear} style={{ border: "none", background: "transparent", color: "#dc2626", cursor: "pointer", fontSize: 11, fontWeight: 600 }}>Clear</button>}
            <button onClick={() => setOpen(false)} style={{ border: "none", background: "transparent", color: "#64748b", cursor: "pointer", fontSize: 14 }}>×</button>
          </div>
          {filtered.slice(0, 200).map(v => (
            <label key={v.value} style={{ display: "flex", alignItems: "center", gap: 8, padding: "4px 10px", cursor: "pointer", fontSize: 11 }}>
              <input type="checkbox" checked={selected.has(v.value)} onChange={() => onToggle(v.value)} />
              <span style={{ fontFamily: "ui-monospace, monospace", flex: 1 }}>{v.value}</span>
              <span style={{ color: "#94a3b8" }}>{v.n}</span>
            </label>
          ))}
          {filtered.length > 200 && <div style={{ padding: 8, fontSize: 10, color: "#94a3b8", textAlign: "center" }}>Showing 200 of {filtered.length} — refine search.</div>}
        </div>
      )}
    </div>
  );
}

// -------- Tree table with expand/collapse + leaf drilldown --------
function TreeTable({ nodes, dimLabels, onLeafClick }) {
  const [expanded, setExpanded] = useState(new Set());
  const [sortCol, setSortCol] = useState("spend");
  const [sortDir, setSortDir] = useState("desc");
  const toggle = (path) => setExpanded(s => {
    const next = new Set(s);
    if (next.has(path)) next.delete(path);
    else next.add(path);
    return next;
  });
  const sortHeader = (label, col, align = "right") => {
    const active = sortCol === col;
    return (
      <th key={col} onClick={() => { if (active) setSortDir(d => d === "desc" ? "asc" : "desc"); else { setSortCol(col); setSortDir("desc"); } }}
        style={{ ...th, textAlign: align, cursor: "pointer", userSelect: "none", color: active ? "#0f172a" : "#64748b" }}>
        {label} {active && (sortDir === "desc" ? "↓" : "↑")}
      </th>
    );
  };
  const sortNodes = (nodes) => {
    const mul = sortDir === "desc" ? -1 : 1;
    return nodes.slice().sort((a, b) => {
      if (sortCol === "value") return mul * String(a.value).localeCompare(String(b.value));
      const va = a.agg[sortCol], vb = b.agg[sortCol];
      if (va == null) return 1;
      if (vb == null) return -1;
      return mul * (va - vb);
    });
  };
  const rows = [];
  const walk = (nodes, depth, parentPath) => {
    for (const n of sortNodes(nodes)) {
      const path = parentPath ? `${parentPath}\u241F${n.value}` : n.value;
      const isLeaf = !n.children;
      const isOpen = expanded.has(path);
      rows.push({ n, depth, path, isLeaf, isOpen });
      if (!isLeaf && isOpen) walk(n.children, depth + 1, path);
    }
  };
  walk(nodes, 0, "");

  return (
    <table style={{ width: "100%", borderCollapse: "collapse", fontSize: 12 }}>
      <thead>
        <tr style={{ borderBottom: "2px solid #e2e8f0" }}>
          {sortHeader(dimLabels.join(" / "), "value", "left")}
          {sortHeader("Ads", "count")}
          {sortHeader("Spend", "spend")}
          {sortHeader("Revenue", "rev")}
          {sortHeader("ROAS", "roas")}
          {sortHeader("% Visits (New)", "pct_new_visits")}
          {sortHeader("Purchases", "txns")}
          {sortHeader("AOV", "aov")}
          {sortHeader("CPM", "cpm")}
        </tr>
      </thead>
      <tbody>
        {rows.map(r => (
          <tr key={r.path}
            onClick={() => r.isLeaf ? onLeafClick(r.n, r.path) : toggle(r.path)}
            style={{ borderBottom: "1px solid #f1f5f9", cursor: "pointer", background: r.depth === 0 ? "transparent" : r.depth === 1 ? "#fafbfd" : "#f1f5f9" }}
            onMouseEnter={e => (e.currentTarget.style.background = "#eff6ff")}
            onMouseLeave={e => (e.currentTarget.style.background = r.depth === 0 ? "transparent" : r.depth === 1 ? "#fafbfd" : "#f1f5f9")}>
            <td style={{ ...td, paddingLeft: 10 + r.depth * 20, fontWeight: r.depth === 0 ? 600 : 500 }}>
              <span style={{ display: "inline-block", width: 14, color: "#94a3b8" }}>{!r.isLeaf ? (r.isOpen ? "▼" : "▶") : "•"}</span>
              {r.n.value}
              <span style={{ fontSize: 10, color: "#94a3b8", marginLeft: 6 }}>({r.n.agg.count})</span>
            </td>
            <td style={{ ...td, textAlign: "right", color: "#64748b" }}>{fmtNum(r.n.agg.count)}</td>
            <td style={{ ...td, textAlign: "right", fontWeight: 500 }}>{fmt(r.n.agg.spend)}</td>
            <td style={{ ...td, textAlign: "right" }}>{fmt(r.n.agg.rev)}</td>
            <td style={{ ...td, textAlign: "right" }}><RoasBadge roas={r.n.agg.roas} /></td>
            <td style={{ ...td, textAlign: "right" }}>{fmtPct(r.n.agg.pct_new_visits)}</td>
            <td style={{ ...td, textAlign: "right", color: "#64748b" }}>{fmtNum(r.n.agg.txns)}</td>
            <td style={{ ...td, textAlign: "right", color: "#64748b" }}>{r.n.agg.aov ? `$${r.n.agg.aov.toFixed(0)}` : "—"}</td>
            <td style={{ ...td, textAlign: "right", color: "#64748b" }}>{r.n.agg.cpm ? `$${r.n.agg.cpm.toFixed(1)}` : "—"}</td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}

// -------- Analysis tab with row-based rule picker + tree table --------
function AnalysisTab({ ads, ALL_DIMS_LABELS, METRIC_MAP, anRules, setAnRules, anMetric, setAnMetric, anMinSpend, setAnMinSpend, anTopN, setAnTopN, anExclusions, setAnExclusions, analysisTree, analysisChartData, openModal }) {
  const [expandedExcludeDim, setExpandedExcludeDim] = useState(null);

  const setRuleDim = (i, dim) => setAnRules(rs => rs.map((r, idx) => idx === i ? { dim, values: new Set() } : r));
  const toggleRuleValue = (i, v) => setAnRules(rs => rs.map((r, idx) => {
    if (idx !== i) return r;
    const next = new Set(r.values);
    if (next.has(v)) next.delete(v); else next.add(v);
    return { ...r, values: next };
  }));
  const clearRuleValues = (i) => setAnRules(rs => rs.map((r, idx) => idx === i ? { ...r, values: new Set() } : r));
  const removeRule = (i) => setAnRules(rs => rs.filter((_, idx) => idx !== i));
  const addRule = () => setAnRules(rs => rs.length < 3 ? [...rs, { dim: "", values: new Set() }] : rs);

  const toggleExclude = (dim, value) => {
    setAnExclusions(ex => {
      const set = new Set(ex[dim] || []);
      if (set.has(value)) set.delete(value); else set.add(value);
      return { ...ex, [dim]: set };
    });
  };

  const excludeDimValues = useMemo(() => expandedExcludeDim ? dimensionValues(ads, expandedExcludeDim).slice().sort((a, b) => String(a.value).localeCompare(String(b.value))).slice(0, 100) : [], [ads, expandedExcludeDim]);

  // Dims actually used (non-empty)
  const activeDims = anRules.map(r => r.dim).filter(Boolean);
  const usedDims = new Set(activeDims);

  return (
    <div>
      <div style={{ background: "#fff", borderRadius: 10, padding: 16, border: "1px solid #e2e8f0", marginBottom: 16 }}>
        <h3 style={{ fontSize: 13, fontWeight: 700, color: "#334155", margin: "0 0 10px" }}>Concept Analysis</h3>

        {/* Rule rows */}
        <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
          {anRules.map((rule, i) => (
            <div key={i} style={{ display: "flex", gap: 8, alignItems: "center" }}>
              <span style={{ width: 20, color: "#94a3b8", fontSize: 12, textAlign: "center" }}>{i + 1}</span>
              <select value={rule.dim} onChange={e => setRuleDim(i, e.target.value)}
                style={{ padding: "6px 10px", borderRadius: 6, border: "1px solid #d1d5db", fontSize: 12, minWidth: 160, background: "#fff" }}>
                <option value="">Pick dimension…</option>
                {Object.entries(ALL_DIMS_LABELS).map(([k, lbl]) => {
                  const disabled = usedDims.has(k) && k !== rule.dim;
                  return <option key={k} value={k} disabled={disabled}>{lbl}{disabled ? " (used)" : ""}</option>;
                })}
              </select>
              <span style={{ color: "#94a3b8" }}>›</span>
              <ValuePicker
                ads={ads}
                dim={rule.dim}
                selected={rule.values}
                onToggle={v => toggleRuleValue(i, v)}
                onClear={() => clearRuleValues(i)}
              />
              <button onClick={() => removeRule(i)} title="Remove row"
                style={{ border: "none", background: "transparent", color: "#94a3b8", cursor: "pointer", fontSize: 16, padding: 4 }}>🗑</button>
            </div>
          ))}
        </div>

        {anRules.length < 3 && (
          <button onClick={addRule} style={{ marginTop: 10, padding: "6px 12px", border: "1px dashed #d1d5db", background: "#fff", borderRadius: 6, cursor: "pointer", fontSize: 12, fontWeight: 600, color: "#2563eb" }}>+ Add dimension</button>
        )}

        {/* Controls row */}
        <div style={{ display: "grid", gridTemplateColumns: "repeat(4, 1fr)", gap: 12, alignItems: "end", marginTop: 12, paddingTop: 12, borderTop: "1px solid #e2e8f0" }}>
          <div>
            <label style={{ fontSize: 11, color: "#64748b", fontWeight: 600, display: "block", marginBottom: 4 }}>CHART METRIC</label>
            <select value={anMetric} onChange={e => setAnMetric(e.target.value)} style={{ width: "100%", padding: "6px 8px", borderRadius: 6, border: "1px solid #d1d5db", fontSize: 12 }}>
              {Object.entries(METRIC_MAP).map(([k, v]) => <option key={k} value={k}>{v.label}</option>)}
            </select>
          </div>
          <div>
            <label style={{ fontSize: 11, color: "#64748b", fontWeight: 600, display: "block", marginBottom: 4 }}>MIN SPEND</label>
            <select value={anMinSpend} onChange={e => setAnMinSpend(+e.target.value)} style={{ width: "100%", padding: "6px 8px", borderRadius: 6, border: "1px solid #d1d5db", fontSize: 12 }}>
              <option value={0}>None</option>
              <option value={1000}>$1K+</option>
              <option value={10000}>$10K+</option>
              <option value={50000}>$50K+</option>
              <option value={100000}>$100K+</option>
            </select>
          </div>
          <div>
            <label style={{ fontSize: 11, color: "#64748b", fontWeight: 600, display: "block", marginBottom: 4 }}>TOP N (top level)</label>
            <select value={anTopN} onChange={e => setAnTopN(+e.target.value)} style={{ width: "100%", padding: "6px 8px", borderRadius: 6, border: "1px solid #d1d5db", fontSize: 12 }}>
              <option value={10}>Top 10</option>
              <option value={20}>Top 20</option>
              <option value={50}>Top 50</option>
              <option value={200}>Top 200</option>
            </select>
          </div>
          <div style={{ fontSize: 11, color: "#64748b" }}>
            <strong style={{ color: "#0f172a" }}>{analysisTree.length}</strong> top-level groups
          </div>
        </div>

        {/* Exclude values section (kept as secondary tool) */}
        <div style={{ marginTop: 12, borderTop: "1px solid #e2e8f0", paddingTop: 12 }}>
          <label style={{ fontSize: 11, color: "#64748b", fontWeight: 600, display: "block", marginBottom: 6 }}>EXCLUDE VALUES (secondary filter)</label>
          <div style={{ display: "flex", gap: 6, flexWrap: "wrap", alignItems: "center" }}>
            {Object.keys(ALL_DIMS_LABELS).map(k => {
              const excluded = anExclusions[k]?.size || 0;
              return (
                <button key={k} onClick={() => setExpandedExcludeDim(expandedExcludeDim === k ? null : k)} style={{
                  padding: "4px 10px", border: "1px solid #d1d5db", borderRadius: 5, cursor: "pointer",
                  fontSize: 11, fontWeight: 600,
                  background: expandedExcludeDim === k ? "#fef3c7" : "#fff",
                  color: excluded > 0 ? "#c2410c" : "#64748b",
                }}>{ALL_DIMS_LABELS[k]}{excluded > 0 && ` (−${excluded})`}</button>
              );
            })}
            {Object.values(anExclusions).some(s => s.size > 0) &&
              <button onClick={() => setAnExclusions({})} style={{ fontSize: 11, border: "none", background: "transparent", color: "#dc2626", cursor: "pointer", fontWeight: 600 }}>Clear all exclusions</button>
            }
          </div>
          {expandedExcludeDim && (
            <div style={{ marginTop: 10, padding: 10, background: "#f8fafc", borderRadius: 6, maxHeight: 240, overflowY: "auto" }}>
              <div style={{ fontSize: 11, color: "#64748b", marginBottom: 6 }}>Check values to exclude from <strong>{ALL_DIMS_LABELS[expandedExcludeDim]}</strong>:</div>
              <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fill, minmax(200px, 1fr))", gap: 4 }}>
                {excludeDimValues.map(v => (
                  <label key={v.value} style={{ display: "flex", alignItems: "center", gap: 6, fontSize: 11, cursor: "pointer" }}>
                    <input type="checkbox" checked={anExclusions[expandedExcludeDim]?.has(v.value) || false} onChange={() => toggleExclude(expandedExcludeDim, v.value)} />
                    <span style={{ fontFamily: "ui-monospace, monospace", fontSize: 10 }}>{v.value}</span>
                    <span style={{ color: "#94a3b8", fontSize: 10 }}>({v.n})</span>
                  </label>
                ))}
              </div>
            </div>
          )}
        </div>
      </div>

      {activeDims.length > 0 && (
        <>
          <div style={{ background: "#fff", borderRadius: 10, padding: 16, border: "1px solid #e2e8f0", overflowX: "auto" }}>
            <h3 style={{ fontSize: 13, fontWeight: 600, margin: "0 0 4px", color: "#334155" }}>Breakdown</h3>
            <p style={{ fontSize: 11, color: "#94a3b8", margin: "0 0 10px" }}>Click a row to expand to the next dimension. Click a leaf row to see ad-level data.</p>
            <TreeTable
              nodes={analysisTree}
              dimLabels={activeDims.map(d => ALL_DIMS_LABELS[d])}
              onLeafClick={(node, path) => openModal(path.replaceAll("\u241F", " › "), `${node.agg.count} ads · Spend ${fmt(node.agg.spend)}`, node.ads)}
            />
          </div>
        </>
      )}
    </div>
  );
}

