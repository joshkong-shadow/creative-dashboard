#!/usr/bin/env python3
"""Fetch IM8 ad-level performance data from Northbeam, parse naming convention,
and emit enriched JSON for the dashboard.

Runs in two contexts:
- Local dev: reads env vars NORTHBEAM_API_KEY + NORTHBEAM_CLIENT_ID
- GitHub Actions: same env vars, populated from repo secrets

Output written to public/data/latest.json (overwrite each run) plus an archival
snapshot at public/data/history/YYYY-MM-DD.json.gz.
"""
import csv
import gzip
import io
import json
import os
import pathlib
import sys
import time
from datetime import datetime, timedelta, timezone
from typing import Iterable, Optional
from urllib import request as urlreq
from urllib.error import HTTPError

from parse_ad_name import parse_ad_name

API_BASE = "https://api.northbeam.io/v1"

# --- Configuration ---------------------------------------------------------
# Change these to switch the dashboard's attribution lens.
ATTRIBUTION_MODEL = "northbeam_custom__va"   # Clicks + Modeled Views
ATTRIBUTION_WINDOW = "7"                      # Days — approximates 7-day click + 1-day view
ACCOUNTING_MODE = "accrual"                   # Revenue accrued when spend happens

PLATFORMS = ["Facebook Ads"]                  # Add TikTok / Google Ads later
LOOKBACK_DAYS = 180

METRICS = [
    # Spend & impressions — platform reported, attribution-independent
    "spend", "impressions", "ctr", "cpm",
    # Meta's reported 7d click + 1d view attribution (matches Meta Ads Manager,
    # matches the Excel the user has been working with).
    "metaOffsitePixelPurchases7DClick1DView",
    "metaOffsitePixelRevenue7DClick1DView",
    "metaROAS7DClick1DView",
    # Northbeam's own attributed metrics — kept as an alternate lens.
    "rev", "txns", "roas", "aov", "cac",
    # Visit metrics — raw counts so we can compute % new accurately at any group level.
    "visits", "newVisits",
]


def _api_key() -> str:
    key = os.environ.get("NORTHBEAM_API_KEY")
    if not key:
        sys.exit("ERROR: NORTHBEAM_API_KEY not set")
    return key


def _client_id() -> str:
    cid = os.environ.get("NORTHBEAM_CLIENT_ID")
    if not cid:
        sys.exit("ERROR: NORTHBEAM_CLIENT_ID not set")
    return cid


def _headers() -> dict:
    return {
        "Authorization": _api_key(),
        "Data-Client-ID": _client_id(),
        "Content-Type": "application/json",
    }


def _request(method: str, path: str, body: Optional[dict] = None) -> dict:
    data = json.dumps(body).encode() if body is not None else None
    req = urlreq.Request(API_BASE + path, data=data, headers=_headers(), method=method)
    # Very mild backoff for 429s.
    for attempt in range(5):
        try:
            with urlreq.urlopen(req, timeout=120) as r:
                return json.loads(r.read().decode())
        except HTTPError as e:
            if e.code == 429 and attempt < 4:
                wait = 20 * (attempt + 1)
                print(f"  rate-limited, waiting {wait}s…", flush=True)
                time.sleep(wait)
                continue
            print(f"  HTTP {e.code}: {e.read().decode()}", flush=True)
            raise
    raise RuntimeError("exhausted retries")


def submit_export(start_iso: str, end_iso: str) -> str:
    payload = {
        "level": "ad",
        "time_granularity": "DAILY",
        "period_type": "FIXED",
        "period_options": {
            "period_starting_at": start_iso,
            "period_ending_at": end_iso,
        },
        "breakdowns": [{"key": "Platform (Northbeam)", "values": PLATFORMS}],
        "options": {"remove_zero_spend": True, "include_ids": True},
        "attribution_options": {
            "attribution_models": [ATTRIBUTION_MODEL],
            "attribution_windows": [ATTRIBUTION_WINDOW],
            "accounting_modes": [ACCOUNTING_MODE],
        },
        "metrics": [{"id": m} for m in METRICS],
    }
    res = _request("POST", "/exports/data-export", payload)
    return res["id"]


def poll_export(job_id: str, timeout_sec: int = 600) -> str:
    deadline = time.time() + timeout_sec
    while time.time() < deadline:
        res = _request("GET", f"/exports/data-export/result/{job_id}")
        status = res.get("status")
        if status == "SUCCESS":
            return res["result"][0]
        if status == "FAILED":
            raise RuntimeError(f"export failed: {res}")
        time.sleep(5)
    raise TimeoutError(f"export {job_id} did not finish in {timeout_sec}s")


def download_csv(url: str) -> str:
    with urlreq.urlopen(url, timeout=300) as r:
        return r.read().decode()


def _safe_float(v: str) -> Optional[float]:
    if v is None or v == "":
        return None
    try:
        return float(v)
    except ValueError:
        return None


def _safe_int(v: str) -> Optional[int]:
    f = _safe_float(v)
    return int(f) if f is not None else None


def aggregate_rows(csv_text: str, mappings: Optional[dict] = None) -> list:
    """Collapse the multi-row-per-ad CSV into one parsed+enriched row per ad.

    The Northbeam CSV returns one row per (ad, attribution_model, attribution_window,
    accounting_mode) tuple. We filter to the chosen attribution combo, merge dedup
    duplicates by canonical name, and apply parse_ad_name.
    """
    reader = csv.DictReader(io.StringIO(csv_text))
    by_ad: dict[str, dict] = {}
    # Northbeam returns duplicate rows per attribution combo (Accrual-7d and Cash-lifetime
    # under the VA model). Meta-reported metrics are passthrough and identical across
    # combos, but NB-attributed metrics differ. We keep Cash snapshot (lifetime) rows
    # because `rev`/`transactions` are populated there — matches "purchases conv value"
    # semantics from the Excel.
    for row in reader:
        if "Cash" not in (row.get("accounting_mode") or ""):
            continue

        raw_name = row.get("ad_name", "").strip()
        if not raw_name:
            continue
        parsed = parse_ad_name(raw_name)
        dedup = parsed["dedup_key"] or raw_name

        # Two attribution lenses captured per ad:
        #   meta_*  — what Meta Ads Manager reports (7d click + 1d view)
        #   nb_*    — what Northbeam attributes (Cash snapshot)
        metrics = {
            "spend": _safe_float(row.get("spend")) or 0.0,
            "impressions": _safe_int(row.get("imprs")) or 0,
            "ctr_raw": _safe_float(row.get("ctr")) or 0.0,
            # Meta-reported 7d-click + 1d-view (passthrough from FB Ads Manager)
            "meta_rev": _safe_float(row.get("fb_website_purchases_conversion_value_7d_click_1d_view")) or 0.0,
            "meta_txns": _safe_float(row.get("fb_website_purchases_7d_click_1d_view")) or 0.0,
            # NB attributed (Cash snapshot lens)
            "nb_rev": _safe_float(row.get("rev")) or 0.0,
            "nb_txns": _safe_float(row.get("transactions")) or 0.0,
            # Visit counts — used to compute % new visits at any aggregation level.
            "visits": _safe_float(row.get("visits")) or 0.0,
            "new_visits": _safe_float(row.get("new_visits")) or 0.0,
        }

        ad_id = (row.get("ad_id") or "").strip()
        # Only keep numeric platform ad IDs (Meta ad IDs) — UTM kind rows echo ad_name here.
        meta_ad_id = ad_id if ad_id.isdigit() else None

        if dedup in by_ad:
            agg = by_ad[dedup]
            for k, v in metrics.items():
                agg["metrics"][k] += v
            # Track all Meta ad IDs that roll up into this dedup.
            agg["meta_campaigns"].add(row.get("campaign_name", ""))
            agg["meta_adsets"].add(row.get("adset_name", ""))
            if meta_ad_id:
                agg["meta_ad_ids"].add(meta_ad_id)
        else:
            by_ad[dedup] = {
                **parsed,
                "metrics": metrics,
                "meta_campaigns": {row.get("campaign_name", "")},
                "meta_adsets": {row.get("adset_name", "")},
                "meta_ad_ids": {meta_ad_id} if meta_ad_id else set(),
            }

    # Compute derived metrics and apply mappings.
    out = []
    for rec in by_ad.values():
        m = rec["metrics"]
        # Default lens: Meta 7d click + 1d view
        m["roas"] = round(m["meta_rev"] / m["spend"], 4) if m["spend"] else 0
        m["cpm"] = round((m["spend"] / m["impressions"]) * 1000, 4) if m["impressions"] else 0
        m["cpa"] = round(m["spend"] / m["meta_txns"], 4) if m["meta_txns"] else None
        m["aov"] = round(m["meta_rev"] / m["meta_txns"], 2) if m["meta_txns"] else None
        # Mirror into primary "rev"/"transactions" for the UI default.
        m["rev"] = m["meta_rev"]
        m["transactions"] = m["meta_txns"]

        if mappings:
            for dim, mapping in mappings.items():
                if dim in rec and rec[dim] in mapping:
                    rec[dim] = mapping[rec[dim]]

        rec["meta_campaigns"] = sorted(rec["meta_campaigns"])
        rec["meta_adsets"] = sorted(rec["meta_adsets"])
        rec["meta_ad_ids"] = sorted(rec["meta_ad_ids"])
        out.append(rec)

    return out


def load_mappings(path: pathlib.Path) -> dict:
    if not path.exists():
        return {}
    return json.loads(path.read_text())


def main():
    repo_root = pathlib.Path(__file__).resolve().parent.parent
    out_dir = repo_root / "public" / "data"
    history_dir = out_dir / "history"
    out_dir.mkdir(parents=True, exist_ok=True)
    history_dir.mkdir(parents=True, exist_ok=True)

    mappings = load_mappings(repo_root / "data" / "mappings.json")

    now = datetime.now(timezone.utc)
    end = now.replace(hour=0, minute=0, second=0, microsecond=0)
    start = end - timedelta(days=LOOKBACK_DAYS)
    start_iso = start.isoformat().replace("+00:00", "Z")
    end_iso = end.isoformat().replace("+00:00", "Z")

    print(f"Fetching Northbeam ad-level data: {start_iso} → {end_iso}")
    print(f"Attribution: {ATTRIBUTION_MODEL} / {ATTRIBUTION_WINDOW}d / {ACCOUNTING_MODE}")
    print(f"Platforms: {', '.join(PLATFORMS)}")

    job_id = submit_export(start_iso, end_iso)
    print(f"Job {job_id} submitted, polling…")
    url = poll_export(job_id)
    print("Downloading CSV…")
    csv_text = download_csv(url)
    print(f"  {len(csv_text)} bytes")

    print("Parsing & aggregating…")
    ads = aggregate_rows(csv_text, mappings=mappings)
    print(f"  {len(ads)} unique ads")

    manifest = {
        "generated_at": now.isoformat(),
        "period": {"start": start_iso, "end": end_iso},
        "attribution": {
            "model": ATTRIBUTION_MODEL,
            "window_days": ATTRIBUTION_WINDOW,
            "accounting_mode": ACCOUNTING_MODE,
        },
        "platforms": PLATFORMS,
        "ad_count": len(ads),
        "ads": ads,
    }

    latest_path = out_dir / "latest.json"
    latest_path.write_text(json.dumps(manifest, separators=(",", ":"), default=str))
    print(f"Wrote {latest_path} ({latest_path.stat().st_size // 1024} KB)")

    stamp = now.strftime("%Y-%m-%d_%H%M")
    snap_path = history_dir / f"{stamp}.json.gz"
    with gzip.open(snap_path, "wt") as f:
        json.dump(manifest, f, separators=(",", ":"), default=str)
    print(f"Snapshot → {snap_path}")


if __name__ == "__main__":
    main()
