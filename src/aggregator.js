// Aggregates ad-level Northbeam rows into the shapes the dashboard tabs need.
// The raw data ships as one row per unique ad with parsed dimensions + metrics.
// Every view in the dashboard derives from aggregating across the ad array
// rather than storing pre-aggregated tables.

const THRESHOLDS = [
  { key: "$1K", min: 1000 },
  { key: "$5K", min: 5000 },
  { key: "$15K", min: 15000 },
  { key: "$25K", min: 25000 },
  { key: "$50K", min: 50000 },
  { key: "$100K", min: 100000 },
  { key: "$150K+", min: 150000 },
];

// Translate YYMMDD ad-creation dates into YYYY-MM buckets.
function yymmddToMonth(s) {
  if (!s || s.length !== 6 || !/^\d{6}$/.test(s)) return null;
  return `20${s.slice(0, 2)}-${s.slice(2, 4)}`;
}

// Aggregate a filtered list of ad records into summary metrics.
export function aggregate(ads) {
  const tot = ads.reduce(
    (a, r) => {
      a.spend += r.metrics.spend || 0;
      a.rev += r.metrics.meta_rev || 0;
      a.txns += r.metrics.meta_txns || 0;
      a.impressions += r.metrics.impressions || 0;
      a.visits += r.metrics.visits || 0;
      a.new_visits += r.metrics.new_visits || 0;
      a.count += 1;
      return a;
    },
    { spend: 0, rev: 0, txns: 0, impressions: 0, visits: 0, new_visits: 0, count: 0 }
  );
  return {
    ...tot,
    roas: tot.spend ? tot.rev / tot.spend : 0,
    cpm: tot.impressions ? (tot.spend / tot.impressions) * 1000 : 0,
    cpa: tot.txns ? tot.spend / tot.txns : null,
    aov: tot.txns ? tot.rev / tot.txns : null,
    pct_new_visits: tot.visits ? (tot.new_visits / tot.visits) * 100 : null,
  };
}

// Group ads by a dimension and aggregate each bucket.
export function groupBy(ads, dim) {
  const buckets = new Map();
  for (const ad of ads) {
    const key = ad[dim] ?? "(untagged)";
    if (!buckets.has(key)) buckets.set(key, []);
    buckets.get(key).push(ad);
  }
  return Array.from(buckets.entries())
    .map(([name, rows]) => ({ name, ads: rows, ...aggregate(rows) }))
    .sort((a, b) => b.spend - a.spend);
}

// Monthly breakdown indexed by the ad's creation date (YYMMDD from ad name).
export function monthly(ads) {
  const buckets = new Map();
  for (const ad of ads) {
    const m = yymmddToMonth(ad.date);
    if (!m) continue;
    if (!buckets.has(m)) buckets.set(m, { month: m, video: 0, image: 0, ads: [] });
    const b = buckets.get(m);
    b.ads.push(ad);
    if (ad.format === "VID" || ad.format === "FXVID") b.video += 1;
    else if (ad.format === "IMG") b.image += 1;
  }
  return Array.from(buckets.values())
    .map((b) => {
      const agg = aggregate(b.ads);
      return {
        month: b.month,
        total: b.ads.length,
        video: b.video,
        image: b.image,
        spend: agg.spend,
        revenue: agg.rev,
        purchases: agg.txns,
        roas: agg.roas,
        cpm: agg.cpm,
      };
    })
    .sort((a, b) => a.month.localeCompare(b.month));
}

// Win rate: for each month, count ads by spend threshold crossings. Returns
// the same shape as the old Excel-derived winRate table so existing tabs work.
export function winRate(ads, formatFilter = "blended") {
  let filtered = ads;
  if (formatFilter === "video") {
    filtered = ads.filter((a) => a.format === "VID" || a.format === "FXVID");
  } else if (formatFilter === "image") {
    filtered = ads.filter((a) => a.format === "IMG");
  }

  const byMonth = new Map();
  for (const ad of filtered) {
    const m = yymmddToMonth(ad.date);
    if (!m) continue;
    if (!byMonth.has(m)) byMonth.set(m, []);
    byMonth.get(m).push(ad);
  }

  const rows = Array.from(byMonth.entries())
    .sort((a, b) => a[0].localeCompare(b[0]))
    .map(([month, monthAds]) => {
      const thresholds = {};
      for (const t of THRESHOLDS) {
        const n = monthAds.filter((a) => (a.metrics.spend || 0) >= t.min).length;
        thresholds[t.key] = {
          n,
          rate: monthAds.length ? (n / monthAds.length) * 100 : 0,
        };
      }
      return { month, total: monthAds.length, thresholds };
    });

  // Append TOTAL row summing across all months.
  const totalThresholds = {};
  for (const t of THRESHOLDS) {
    const n = filtered.filter((a) => (a.metrics.spend || 0) >= t.min).length;
    totalThresholds[t.key] = {
      n,
      rate: filtered.length ? (n / filtered.length) * 100 : 0,
    };
  }
  rows.push({ month: "TOTAL", total: filtered.length, thresholds: totalThresholds });
  return rows;
}

// Convert a groupBy result into the "breakdown table" row shape used by the
// existing BreakdownTable component.
export function toBreakdownRows(groups) {
  return groups.map((g) => {
    const wrAds = g.ads;
    const wr = (min) =>
      wrAds.length
        ? (wrAds.filter((a) => (a.metrics.spend || 0) >= min).length / wrAds.length) *
          100
        : 0;
    return {
      name: g.name,
      creatives: g.count,
      ads: g.ads,
      spend: g.spend,
      revenue: g.rev,
      roas: g.roas,
      pct_new_visits: g.pct_new_visits,
      purchases: g.txns,
      aov: g.aov,
      ctr: null,
      hookRate: null,
      cpm: g.cpm,
      cpc: null,
      winRate1k: wr(1000),
      winRate15k: wr(15000),
      winRate50k: wr(50000),
    };
  });
}

// Unique values per dimension — used by the Data Clean Up tab.
export const DIMENSIONS = [
  "format",
  "ad_type",
  "icp",
  "problem",
  "creative_no",
  "agency",
  "batch_name",
  "creator_type",
  "creator_name",
  "hook",
  "wtad",
  "landing_page",
  "paid_seed",
  "winner",
  "convention",
];

export function dimensionValues(ads, dim) {
  const counts = new Map();
  const spendByValue = new Map();
  for (const ad of ads) {
    const v = ad[dim] ?? "(untagged)";
    counts.set(v, (counts.get(v) || 0) + 1);
    spendByValue.set(v, (spendByValue.get(v) || 0) + (ad.metrics.spend || 0));
  }
  return Array.from(counts.entries())
    .map(([value, n]) => ({ value, n, spend: spendByValue.get(value) || 0 }))
    .sort((a, b) => b.spend - a.spend);
}
