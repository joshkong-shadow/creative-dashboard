"""IM8 Meta ad-name parser.

Handles two conventions:

NEW (post mid-March 2026, marked by trailing `*`):
  YYMMDD_FORMAT_ADTYPE_ICP_PROBLEM_CREATIVENO_AGENCY_BATCHNAME_CREATORTYPE_CREATORNAME_HOOK_WTAD_LDP*

OLD (pre mid-March 2026):
  FORMAT_CREATIVENUMBER_BATCHNAME_CREATORNAME_PAID/SEED_CONCEPT_HOOK_YYMMDD
  (some OLD ads also have trailing _WTAD_LDP tokens)

Either convention may carry a trailing winner tag, e.g. ` -WIN26MW2`,
which we extract as {winner, winner_year, winner_month, winner_week}.
Any other trailing suffixes are stripped.
"""
import re
from typing import Optional

VALID_FORMATS = {"VID", "IMG", "CRS", "COL", "FXVID", "IE"}

# Winner tag: "WIN" + YY + optional (month letters + "W" + week digits).
# Supports: WIN26, WIN26W4, WIN26MW2, WIN26FW4, WIN26MARW3, WIN26-M3-W2.
# The month slot is 0-3 letters (may be absent for WIN26W4 style).
WINNER_RE = re.compile(
    r"(?:[\s_\-]+|\b)"
    r"WIN"
    r"(?P<year>\d{2})"
    r"(?:[-_\s]*"
    r"(?P<month>[A-Z]{0,3})"
    r"W(?P<week>\d{1,2})"
    r")?",
    re.IGNORECASE,
)

DATE_RE = re.compile(r"^\d{6}$")


def _clean(token: Optional[str]) -> Optional[str]:
    if token is None:
        return None
    t = token.strip()
    if not t or t.upper() == "NA":
        return None
    return t


def parse_ad_name(name: str) -> dict:
    """Parse an ad name into a structured dict.

    Every key is always present (None if not applicable) so downstream
    pivoting code can assume a stable schema.
    """
    result = {
        "ad_name": name,
        "convention": None,          # "new" | "old" | "unknown"
        "format": None,
        "ad_type": None,             # NEW only
        "icp": None,                 # NEW only
        "problem": None,             # NEW
        "concept": None,             # OLD (and mirrored to `problem` for unified pivot)
        "creative_no": None,
        "agency": None,              # NEW only
        "batch_name": None,
        "creator_type": None,        # NEW only
        "creator_name": None,
        "hook": None,
        "wtad": None,
        "landing_page": None,
        "date": None,                # YYMMDD string
        "paid_seed": None,           # OLD only
        "winner": None,              # e.g. "WIN26MW2"
        "winner_year": None,         # "2026"
        "winner_month": None,        # "M3"
        "winner_week": None,         # "W2"
        "dedup_key": None,
    }

    if not isinstance(name, str) or not name.strip():
        return result

    working = name.strip()

    # 1. Extract winner tag (may appear anywhere near the end, usually after space/dash)
    winner_match = WINNER_RE.search(working)
    if winner_match:
        year = winner_match.group("year")
        month = winner_match.group("month")
        week = winner_match.group("week")
        # Reconstruct canonical tag preserving the month letters as given.
        tag = f"WIN{year}"
        if month:
            tag += month.upper()
        if week:
            tag += f"W{int(week)}"
        result["winner"] = tag
        result["winner_year"] = f"20{year}"
        if month:
            result["winner_month"] = month.upper()
        if week:
            result["winner_week"] = f"W{int(week)}"
        working = working[: winner_match.start()].rstrip(" -_")

    # 2. Strip trailing junk / other suffixes separated by " -"
    # (e.g., " -v2", " -retest") — anything after a " -" that isn't WIN
    # Only strip if it comes AFTER the last underscore block
    while True:
        m = re.search(r"\s+-\s*[A-Za-z0-9]+$", working)
        if not m:
            break
        working = working[: m.start()].rstrip()

    # 3. Strip trailing asterisk = NEW convention marker
    new_marked = False
    if working.endswith("*"):
        new_marked = True
        working = working[:-1].rstrip()

    tokens = working.split("_")

    # 4. Classify: NEW if marked by * OR if 13 tokens with 6-digit first token
    is_new = new_marked or (
        len(tokens) >= 12 and DATE_RE.match(tokens[0])
    )

    if is_new:
        result["convention"] = "new"
        # Canonical 13 tokens:
        #   YYMMDD_FORMAT_ADTYPE_ICP_PROBLEM_CREATIVENO_AGENCY_BATCHNAME_CREATORTYPE_CREATORNAME_HOOK_WTAD_LDP
        # Real data occasionally has 12 tokens — most commonly WTAD is omitted
        # (the field is implicit NA for non-whitelisted/partnership ads).
        # We detect this by checking whether token 11 looks like a WTAD code
        # (WTAD/PTAD/NA) vs a landing-page string.
        if len(tokens) >= 13:
            result["date"] = _clean(tokens[0])
            result["format"] = _clean(tokens[1])
            result["ad_type"] = _clean(tokens[2])
            result["icp"] = _clean(tokens[3])
            result["problem"] = _clean(tokens[4])
            result["creative_no"] = _clean(tokens[5])
            result["agency"] = _clean(tokens[6])
            result["batch_name"] = _clean(tokens[7])
            result["creator_type"] = _clean(tokens[8])
            result["creator_name"] = _clean(tokens[9])
            result["hook"] = _clean(tokens[10])
            result["wtad"] = _clean(tokens[11])
            # LDP may span multiple tokens via parentheses (e.g. PDP(LONGEVITY) safe but
            # some LDPs split like GET_PDP — join what's left).
            result["landing_page"] = _clean("_".join(tokens[12:]))
        elif len(tokens) == 12:
            # Ambiguous 12-token variant. If token 10 is a WTAD sentinel the LDP
            # slot is token 11; otherwise the WTAD slot is absent and token 11 is LDP.
            result["date"] = _clean(tokens[0])
            result["format"] = _clean(tokens[1])
            result["ad_type"] = _clean(tokens[2])
            result["icp"] = _clean(tokens[3])
            result["problem"] = _clean(tokens[4])
            result["creative_no"] = _clean(tokens[5])
            result["agency"] = _clean(tokens[6])
            result["batch_name"] = _clean(tokens[7])
            result["creator_type"] = _clean(tokens[8])
            result["creator_name"] = _clean(tokens[9])
            result["hook"] = _clean(tokens[10])
            if tokens[10].upper() in {"WTAD", "PTAD", "NA"}:
                # Token 10 is actually WTAD, meaning HOOK was omitted.
                result["hook"] = None
                result["wtad"] = _clean(tokens[10])
                result["landing_page"] = _clean(tokens[11])
            else:
                result["wtad"] = None
                result["landing_page"] = _clean(tokens[11])
        elif len(tokens) >= 8:
            # Severe partial — best effort on leading fields only.
            result["date"] = _clean(tokens[0])
            result["format"] = _clean(tokens[1])
            result["ad_type"] = _clean(tokens[2])
            result["icp"] = _clean(tokens[3])
            result["problem"] = _clean(tokens[4])
    elif len(tokens) >= 8 and tokens[0].upper() in VALID_FORMATS:
        result["convention"] = "old"
        # Expected 8 tokens base: FORMAT_CREATIVENO_BATCH_CREATOR_PAID/SEED_CONCEPT_HOOK_YYMMDD
        result["format"] = _clean(tokens[0])
        result["creative_no"] = _clean(tokens[1])
        result["batch_name"] = _clean(tokens[2])
        result["creator_name"] = _clean(tokens[3])
        result["paid_seed"] = _clean(tokens[4])
        result["concept"] = _clean(tokens[5])
        # Mirror OLD concept into problem so unified dashboard can pivot on "problem"
        result["problem"] = result["concept"]
        result["hook"] = _clean(tokens[6])
        # Date: token 7, then optionally WTAD + LDP tokens after
        if DATE_RE.match(tokens[7]):
            result["date"] = tokens[7]
            if len(tokens) > 8:
                result["wtad"] = _clean(tokens[8])
            if len(tokens) > 9:
                result["landing_page"] = _clean("_".join(tokens[9:]))
        else:
            # Date slot has junk — fall through
            result["date"] = None
    else:
        result["convention"] = "unknown"

    # 5. Dedup key — the canonical name without the winner tag, trailing suffixes,
    # or NEW asterisk. Matches Excel dedup rules.
    result["dedup_key"] = working

    return result


if __name__ == "__main__":
    import json
    import sys

    samples = [
        "260319_VID_VSL_MEDRL_IMMUNITY_H2B1SS1_ACH_DEM_KOL_NA_IFYOUDONTRECOGNISE_NA_FEELAGAINLDP*",
        "260406_IMG_NA_GENL_12HALLMARKS_C43B_NER_NERMARW2_NA_NA_THEBETTERWAY_NA_PDP(LONGEVITY)*",
        "IMG_C57B_NERFEBW4_NA_NA_WELCOMEKIT_CLAIMYOURFREE_260406_NA_PDP(LONGEVITY)",
        "260305_VID_VSL_GENE_GUTHEALTH_2_INT_ICP_NA_NA_IFYOUHAVEIBS_NA_WHATSMISSINGLDP* -WIN26MW2",
        "VID_3_KOLUGC_DRJEREMYLONDON_PAID_ALLINONE_IM8SALLINONE_260219_PTAD_SAV2 -WIN26FW4",
        "260227_VID_CREATORTH_GENL_IMMUNITY_SS1_ACH-ILLIA-83(1)_NA_NA_THEELEVENMOSTPOTENT_NA_PDP(LONGEVITY)*",
    ]
    for s in samples:
        print(f"\n--- {s}")
        print(json.dumps(parse_ad_name(s), indent=2))
