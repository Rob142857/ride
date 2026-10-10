#!/usr/bin/env python3
"""Derive the Ride basemap and transparent labels without downloading assets."""
import argparse
from copy import deepcopy
import json
from pathlib import Path

BASE_STYLE_ID = "ride-australia"
LABELS_STYLE_ID = "ride-australia-labels"
TILE_REVISION = "2026-10-10-2"


def derive_styles(original):
    """Keep symbol placement identical; expose highways at their data minzoom."""
    base = deepcopy(original)
    # Shortbread supplies motorway/trunk/primary at style zoom 5/6/8. The
    # upstream fade starts with an invisible first stop, which unnecessarily
    # hides the available geometry for another full zoom. Do not lower the
    # layer minzoom: no style can create roads absent from the archive.
    adjusted = []
    road_ids = {f"street-{kind}{suffix}"
                for kind in ("motorway", "trunk", "primary")
                for suffix in ("", ":outline")}
    for layer in base["layers"]:
        if layer["id"] not in road_ids:
            continue
        paint = layer["paint"]
        for prop, visible_width in (("line-opacity", 1),
                                    ("line-width", 2 if layer["id"].endswith(":outline") else 1)):
            value = paint[prop]
            if (not isinstance(value, list) or value[:3] != ["interpolate", ["linear"], ["zoom"]]
                    or len(value) < 7 or value[3] != layer["minzoom"]):
                raise ValueError(f"Unexpected upstream highway expression: {layer['id']} {prop}")
            if value[4] == 0:
                value[4] = visible_width
        adjusted.append(layer["id"])
    if set(adjusted) != road_ids:
        raise ValueError("Expected all six upstream highway face/casing layers")

    labels = deepcopy(base)
    labels["name"] = "Ride Australia labels"
    labels["layers"] = [deepcopy(layer) for layer in base["layers"] if layer["type"] == "symbol"]
    if not labels["layers"]:
        raise ValueError("Style has no symbols to render")
    # A sky/fog root can draw pixels independently of style layers. Preserve
    # the projection and all placement settings, but remove this backdrop.
    labels.pop("sky", None)
    labels.pop("fog", None)
    return base, labels


def style_bundle(original, config, receipt):
    """Return two styles and a config/receipt preserving existing service options."""
    base, labels = derive_styles(original)
    updated_config = deepcopy(config)
    base_entry = updated_config["styles"][BASE_STYLE_ID]
    base_entry["style"] = f"{BASE_STYLE_ID}.json"
    labels_entry = deepcopy(base_entry)
    labels_entry["style"] = f"{LABELS_STYLE_ID}.json"
    updated_config["styles"][LABELS_STYLE_ID] = labels_entry
    updated_receipt = deepcopy(receipt)
    updated_receipt["tileRevision"] = TILE_REVISION
    updated_receipt["derivedStyles"] = {
        "base": BASE_STYLE_ID,
        "labels": LABELS_STYLE_ID,
        "labelsLayerCount": len(labels["layers"]),
        "labelsLayerTypes": ["symbol"],
        "labelsPreserveSymbolOrderAndPlacement": True,
        "highwayFirstZoomVisibility": {"motorway": 5, "trunk": 6, "primary": 8},
        "notes": "256-pixel raster display zoom is style zoom + 1; data and label availability are unchanged.",
    }
    return base, labels, updated_config, updated_receipt


def write_bundle(destination, bundle):
    destination = Path(destination)
    (destination / "styles").mkdir(parents=True, exist_ok=True)
    base, labels, config, receipt = bundle
    for relative, value in ((f"styles/{BASE_STYLE_ID}.json", base),
                            (f"styles/{LABELS_STYLE_ID}.json", labels),
                            ("config.json", config),
                            ("source-receipt.json", receipt)):
        (destination / relative).write_text(json.dumps(value, ensure_ascii=False, indent=2), encoding="utf-8")


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("existing", type=Path, help="Existing prepared tile directory (read only)")
    parser.add_argument("--output", required=True, type=Path, help="Separate staged candidate directory")
    args = parser.parse_args()
    existing, output = args.existing.resolve(), args.output.resolve()
    if output == existing or existing in output.parents or output in existing.parents:
        parser.error("Output must be outside the existing deployment directory")
    if output.exists() and any(output.iterdir()):
        parser.error("Output must be an empty staged candidate directory")
    config = json.loads((existing / "config.json").read_text(encoding="utf-8"))
    style_file = Path(config["styles"][BASE_STYLE_ID]["style"])
    if style_file.is_absolute() or ".." in style_file.parts:
        parser.error("Expected a relative base-style filename")
    style = json.loads((existing / "styles" / style_file).read_text(encoding="utf-8"))
    receipt = json.loads((existing / "source-receipt.json").read_text(encoding="utf-8"))
    bundle = style_bundle(style, config, receipt)
    write_bundle(output, bundle)
    print(json.dumps({"candidate": str(output), "tileRevision": TILE_REVISION,
                      "labelsLayerCount": len(bundle[1]["layers"])}))


if __name__ == "__main__":
    main()
