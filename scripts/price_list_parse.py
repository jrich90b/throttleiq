#!/usr/bin/env python3
import json
import re
from pathlib import Path


def parse_money(value: str) -> int:
    return int(value.replace("$", "").replace(",", "").strip())


def main() -> int:
    raw_path = Path("data/price_list_raw.txt")
    if not raw_path.exists():
        print("Missing data/price_list_raw.txt. Run scripts/price_list_extract.py first.")
        return 1

    out_path = Path("services/api/data/price_list_msrp_2026.json")

    lines = raw_path.read_text(encoding="utf-8", errors="ignore").splitlines()

    models: dict[str, dict] = {}
    current_key: str | None = None

    for raw in lines:
        line = raw.strip()
        if not line:
            continue
        if line.startswith("====="):
            continue
        if "Family Model Model Name" in line:
            continue
        if "CONFIDENTIAL PRICE LIST" in line or "MODEL YEAR" in line or "updated" in line:
            continue
        if "Anti-Lock Braking" in line or "Security System" in line or "RIder Safety" in line:
            continue

        if " DOM " in line and "$" in line:
            tokens = line.split()
            try:
                dom_index = tokens.index("DOM")
            except ValueError:
                continue
            try:
                msrp_index = next(i for i, t in enumerate(tokens) if t.startswith("$"))
            except StopIteration:
                continue

            family = tokens[0]
            model_code = tokens[1] if len(tokens) > 1 else ""
            spec_code = tokens[dom_index - 1] if dom_index - 1 >= 0 else ""
            model_name = " ".join(tokens[2:dom_index - 1]).strip()
            option_segment = " ".join(tokens[dom_index + 1:msrp_index]).strip()
            option_type = ""
            option_name = ""
            option_spec = ""
            match = re.search(r"(Trim-Color|Color)", option_segment)
            if match:
                option_type = match.group(1)
                option_spec = option_segment[: match.start()].strip()
                option_name = option_segment[match.end() :].strip()
            else:
                option_spec = tokens[dom_index + 1] if dom_index + 1 < len(tokens) else ""
                option_name = " ".join(tokens[dom_index + 2:msrp_index]).strip()
            base_msrp = parse_money(tokens[msrp_index])

            key = f"{family}|{model_code}|{model_name}"
            current_key = key

            trims = []
            if option_type in ("Trim", "Trim-Color") and option_name:
                trims.append(
                    {
                        "spec": option_spec,
                        "type": option_type,
                        "name": option_name,
                        "adder": 0,
                        "msrp": base_msrp
                    }
                )

            models[key] = {
                "family": family,
                "model_code": model_code,
                "model_name": model_name,
                "spec_code": spec_code,
                "base_msrp": base_msrp,
                "base_option_type": option_type,
                "base_option_spec": option_spec,
                "base_option_name": option_name,
                "colors": [
                    {
                        "name": option_name,
                        "adder": 0
                    }
                ],
                "color_adders": [],
                "trims": trims,
                "trim_adders": []
            }
            continue

        if current_key and " Color " in line and "$" in line:
            tokens = line.split()
            if len(tokens) < 3:
                continue
            if tokens[1] != "Color":
                continue
            try:
                msrp_index = next(i for i, t in enumerate(tokens) if t.startswith("$"))
            except StopIteration:
                continue
            name = " ".join(tokens[2:msrp_index]).strip()
            adder = parse_money(tokens[msrp_index])
            entry = models.get(current_key)
            if not entry:
                continue
            entry["colors"].append({"name": name, "adder": adder})
            entry["color_adders"].append(adder)
            continue

        if current_key and "Trim" in line and "$" in line and "DOM" not in line:
            tokens = line.split()
            try:
                msrp_index = next(i for i, t in enumerate(tokens) if t.startswith("$"))
            except StopIteration:
                continue
            descriptor = " ".join(tokens[:msrp_index]).strip()
            match = re.search(r"(Trim-Color|Trim)", descriptor)
            if not match:
                continue
            trim_type = match.group(1)
            trim_spec = descriptor[: match.start()].strip()
            trim_name = descriptor[match.end() :].strip()
            trim_name = trim_name.lstrip("-").strip()
            trim_price = parse_money(tokens[msrp_index])
            entry = models.get(current_key)
            if not entry:
                continue
            base_msrp = entry["base_msrp"]
            trim_adder = trim_price - base_msrp if trim_price >= base_msrp else trim_price
            trim_msrp = base_msrp + trim_adder
            entry["trims"].append(
                {
                    "spec": trim_spec,
                    "type": trim_type,
                    "name": trim_name,
                    "adder": trim_adder,
                    "msrp": trim_msrp
                }
            )
            entry["trim_adders"].append(trim_adder)

    # finalize: compute ranges and dedupe colors
    result = []
    for entry in models.values():
        color_adders = entry.get("color_adders", [])
        max_adder = max(color_adders) if color_adders else 0
        min_msrp = entry["base_msrp"]
        trim_adders = entry.get("trim_adders", [])
        max_trim_adder = max(trim_adders) if trim_adders else 0
        max_msrp = entry["base_msrp"] + max_adder + max_trim_adder
        # dedupe colors by name (keep lowest adder if duplicates)
        seen = {}
        for color in entry.get("colors", []):
            name_key = color["name"].strip().lower()
            adder = int(color["adder"])
            if name_key in seen:
                seen[name_key]["adder"] = min(seen[name_key]["adder"], adder)
            else:
                seen[name_key] = {"name": color["name"], "adder": adder}
        entry["colors"] = sorted(seen.values(), key=lambda c: (c["adder"], c["name"]))
        # dedupe trims by spec+name (keep lowest adder if duplicates)
        trim_seen = {}
        for trim in entry.get("trims", []):
            key = f"{trim.get('spec','').strip().lower()}|{trim.get('name','').strip().lower()}"
            adder = int(trim.get("adder", 0))
            if key in trim_seen:
                if adder < int(trim_seen[key]["adder"]):
                    trim_seen[key] = trim
            else:
                trim_seen[key] = trim
        entry["trims"] = sorted(
            trim_seen.values(), key=lambda t: (int(t.get("adder", 0)), t.get("name", ""))
        )
        entry["msrp_range"] = {"min": min_msrp, "max": max_msrp}
        entry["max_color_adder"] = max_adder
        entry["max_trim_adder"] = max_trim_adder
        entry.pop("color_adders", None)
        entry.pop("trim_adders", None)
        result.append(entry)

    result = sorted(result, key=lambda e: (e["family"], e["model_name"]))
    out_path.write_text(json.dumps(result, indent=2), encoding="utf-8")
    print(f"Wrote {out_path} ({len(result)} models)")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
