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


def aggregate_rows(csv_text: str, mappings: Optional[dict] = None, meta_names: Optional[dict] = None) -> list:
    """Collapse the multi-row-per-ad CSV into one parsed+enriched row per ad.

    The Northbeam CSV returns one row per (ad, attribution_model, attribution_window,
    accounting_mode) tuple. We filter to the chosen attribution combo, merge dedup
    duplicates by canonical name, and apply parse_ad_name.

    `meta_names` (optional): {ad_id: real_meta_name} — when Northbeam returns the
    synthetic "Ad ID: X, Adset ID: Y, Campaign ID: Z" placeholder (common for
    Advantage+/ASC ads), we substitute Meta's real name before parsing so the
    naming-convention parser can extract format/concept/creator/date dimensions.
    """
    meta_names = meta_names or {}
    reader = csv.DictReader(io.StringIO(csv_text))
    by_ad: dict[str, dict] = {}
    synth_overridden = 0
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

        ad_id = (row.get("ad_id") or "").strip()
        # Northbeam ships "Ad ID: X, Adset ID: Y, Campaign ID: Z" as a placeholder
        # for ~7k Advantage+ ads where their pipeline didn't pull the real name.
        # When we have Meta's actual name for this ad_id, swap it in BEFORE parsing
        # so the naming-convention dimensions get populated correctly.
        if ad_id.isdigit() and raw_name.startswith("Ad ID:") and ad_id in meta_names:
            raw_name = meta_names[ad_id]
            synth_overridden += 1

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

    if synth_overridden:
        print(f"  substituted Meta names for {synth_overridden} synthetic-named rows")
    return out


def load_mappings(path: pathlib.Path) -> dict:
    if not path.exists():
        return {}
    return json.loads(path.read_text())


def fetch_meta_previews(token: str, account_id: str, needed: set, cache: dict) -> dict:
    """Return {ad_id: {"preview_link": str, "thumbnail_url": str|None, "name": str|None}},
    starting from `cache` and topping up missing ids from Meta's Graph API.

    Uses the account-level /ads endpoint with pagination (limit=500). Stops
    early once every id in `needed` is covered. Gracefully returns the cache
    on rate-limit / network failures so future runs can retry without losing
    the links we already have.
    """
    result = dict(cache)
    # An entry missing a thumbnail OR a name is re-fetched so we can backfill
    # any field added in a later release without losing what we already have.
    missing = {
        x for x in needed
        if x not in result or not result[x].get("thumbnail_url") or not result[x].get("name")
    }
    if not missing:
        print(f"  Meta previews: cache covers all {len(needed)} ads — no API call needed")
        return result
    if not token or not account_id:
        print(f"  (Meta preview enrichment: {len(missing)} missing — token/account id not set, keeping cache)")
        return result
    base = "https://graph.facebook.com/v21.0"
    # Default /ads only returns active-ish ads; explicitly request every state
    # so historical/archived ads come back too.
    # Note: DELETED is rejected by Meta (Cannot request deleted objects).
    statuses = '["ACTIVE","PAUSED","PENDING_REVIEW","DISAPPROVED","PREAPPROVED","PENDING_BILLING_INFO","CAMPAIGN_PAUSED","ARCHIVED","ADSET_PAUSED","IN_PROCESS","WITH_ISSUES"]'
    from urllib.parse import quote
    # Adding creative{thumbnail_url} doubles per-row payload, so cap limit at
    # 200 to stay under Meta's "reduce the amount of data" 500 threshold.
    # image_url is dropped — heavier than thumbnail_url, and thumbnail_url is
    # all the dashboard needs (renders at 56px).
    fields = "id,name,preview_shareable_link,creative{thumbnail_url}"
    page_size = 200
    base_url = f"{base}/{account_id}/ads?fields={fields}&effective_status={quote(statuses)}&access_token={token}"
    url = f"{base_url}&limit={page_size}"
    pages = 0
    fetched = 0
    thumbed = 0
    named = 0
    rate_limit_retries = 0
    max_rate_limit_retries = 3  # 15 + 30 + 45 = 90 min total worst case
    while url and missing:
        try:
            with urlreq.urlopen(url, timeout=60) as r:
                body = json.loads(r.read().decode())
        except HTTPError as e:
            err_body = e.read().decode()[:300]
            # Meta 500 ("reduce the amount of data") on the very first page →
            # back off to a smaller page size and resume from the start. On
            # later pages, the cursor URL embeds limit, so just bail.
            if e.code == 500 and pages == 0 and page_size > 50:
                page_size = max(50, page_size // 2)
                print(f"  Meta API 500 on first page — retrying with limit={page_size}: {err_body[:120]}")
                url = f"{base_url}&limit={page_size}"
                continue
            # Meta 400 "too many calls" (account-level rate limit, code 80004) →
            # sleep through the cooldown window and resume on the same cursor.
            # Window is typically ~1 hour but decays gradually; back off
            # progressively up to 45 min then give up.
            is_rate_limit = (
                e.code == 400
                and ("too many calls" in err_body.lower() or "code\":80004" in err_body)
            )
            if is_rate_limit and rate_limit_retries < max_rate_limit_retries:
                rate_limit_retries += 1
                wait = 900 * rate_limit_retries  # 15, 30, 45 min
                print(f"  Meta rate-limit hit (attempt {rate_limit_retries}/{max_rate_limit_retries}) — sleeping {wait//60} min and resuming on the same cursor")
                time.sleep(wait)
                continue
            print(f"  Meta API {e.code} — keeping {len(result)} cached previews: {err_body}")
            break
        except Exception as e:
            print(f"  Meta API error — keeping cache: {type(e).__name__}: {e}")
            break
        for entry in body.get("data", []):
            ad_id = entry.get("id")
            link = entry.get("preview_shareable_link")
            creative = entry.get("creative") or {}
            thumb = creative.get("thumbnail_url")
            name = entry.get("name")
            if not ad_id or not link:
                continue
            existing = result.get(ad_id)
            if existing is None:
                result[ad_id] = {"preview_link": link, "thumbnail_url": thumb, "name": name}
                fetched += 1
                if thumb:
                    thumbed += 1
                if name:
                    named += 1
            else:
                if thumb and not existing.get("thumbnail_url"):
                    existing["thumbnail_url"] = thumb
                    thumbed += 1
                if name and not existing.get("name"):
                    existing["name"] = name
                    named += 1
            missing.discard(ad_id)
        pages += 1
        url = body.get("paging", {}).get("next")
        if pages % 10 == 0:
            print(f"  …{pages} pages, {fetched} new / {thumbed} thumbs / {named} names, {len(missing)} still missing")
    print(f"  Meta previews: {fetched} new + {thumbed} thumbs + {named} names across {pages} pages, {len(result)} total ({len(missing)} still missing)")
    return result


def load_previews_cache(path: pathlib.Path) -> dict:
    """Rebuild the ad_id→{preview_link, thumbnail_url, name} map from the previous
    manifest. The per-ad name lives in `meta_names` (a parallel dict keyed by
    ad_id) rather than on the ad record itself, since one record may aggregate
    several Meta ad ids and we need the name lookup to stay 1:1."""
    if not path.exists():
        return {}
    try:
        prev = json.loads(path.read_text())
    except Exception:
        return {}
    cache = {}
    meta_names_prev = prev.get("meta_names") or {}
    for ad in prev.get("ads", []):
        link = ad.get("preview_link")
        if not link:
            continue
        thumb = ad.get("thumbnail_url")
        for meta_id in ad.get("meta_ad_ids", []) or []:
            cache[meta_id] = {
                "preview_link": link,
                "thumbnail_url": thumb,
                "name": meta_names_prev.get(meta_id),
            }
    return cache


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

    # Pre-scan the CSV for all numeric ad_ids so we can fetch Meta data BEFORE
    # aggregation. We need Meta names available at parse time to override
    # Northbeam's synthetic "Ad ID: X, Adset ID: Y, Campaign ID: Z" placeholders
    # for Advantage+/ASC ads.
    print("Pre-scanning CSV for ad_ids…")
    pre_reader = csv.DictReader(io.StringIO(csv_text))
    ad_ids_in_csv = set()
    for row in pre_reader:
        if "Cash" not in (row.get("accounting_mode") or ""):
            continue
        ad_id = (row.get("ad_id") or "").strip()
        if ad_id.isdigit():
            ad_ids_in_csv.add(ad_id)
    print(f"  {len(ad_ids_in_csv)} unique numeric ad_ids in CSV")

    print("Fetching Meta ad previews + names…")
    meta_token = os.environ.get("META_ACCESS_TOKEN", "")
    meta_account = os.environ.get("META_AD_ACCOUNT_ID", "")
    cache = load_previews_cache(out_dir / "latest.json")
    print(f"  cache has {len(cache)} entries from previous run")
    previews = fetch_meta_previews(meta_token, meta_account, ad_ids_in_csv, cache)
    meta_names = {ad_id: data["name"] for ad_id, data in previews.items() if data.get("name")}
    print(f"  {len(meta_names)} ad names available for synthetic-name override")

    print("Parsing & aggregating…")
    ads = aggregate_rows(csv_text, mappings=mappings, meta_names=meta_names)
    print(f"  {len(ads)} unique ads")

    print("Attaching preview links + thumbnails to aggregated ads…")
    attached = 0
    thumbed = 0
    for ad in ads:
        entries = [previews[x] for x in ad.get("meta_ad_ids", []) if x in previews]
        if entries:
            ad["preview_link"] = entries[0]["preview_link"]
            thumb = next((e["thumbnail_url"] for e in entries if e.get("thumbnail_url")), None)
            if thumb:
                ad["thumbnail_url"] = thumb
                thumbed += 1
            if len(entries) > 1:
                ad["preview_links_all"] = [e["preview_link"] for e in entries]
            attached += 1
    print(f"  attached preview_link to {attached}/{len(ads)} ads ({thumbed} with thumbnails)")

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
        # Persist per-ad-id Meta names so the next run's cache can rehydrate the
        # synthetic-name override map without re-querying Meta for everything.
        "meta_names": meta_names,
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
