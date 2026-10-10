"""Style invariants for base-map fallback and the transparent labels overlay."""
from copy import deepcopy
import json
from pathlib import Path
import subprocess
import sys
import tempfile
import unittest

from adapt_style import derive_styles, style_bundle, write_bundle, TILE_REVISION


def fixture():
    roads = []
    for kind, zoom in (("motorway", 5), ("trunk", 6), ("primary", 8)):
        for suffix in (":outline", ""):
            roads.append({"id": f"street-{kind}{suffix}", "type": "line", "source": "osm",
                          "source-layer": "streets", "minzoom": zoom,
                          "filter": ["==", ["get", "kind"], kind],
                          "paint": {"line-color": "#ffeaaa", "line-opacity": ["interpolate", ["linear"], ["zoom"], zoom, 0, zoom + 1, 1],
                                    "line-width": ["interpolate", ["linear"], ["zoom"], zoom, 0, zoom + 1, 2, 14, 5]}})
    return {"version": 8, "name": "Ride Australia", "glyphs": "{fontstack}/{range}.pbf",
            "sprite": [{"id": "base", "url": "base"}],
            "sources": {"osm": {"type": "vector", "url": "mbtiles://{australia}", "maxzoom": 14}},
            "sky": {"sky-color": "#ffffff"}, "projection": {"type": "globe"},
            "layers": [{"id": "background", "type": "background"},
                       {"id": "land", "type": "fill", "source": "osm"}, *roads,
                       {"id": "road-names", "type": "symbol", "source": "osm", "source-layer": "street_labels",
                        "minzoom": 12, "layout": {"symbol-placement": "line", "text-field": ["get", "name"],
                                                "text-allow-overlap": False},
                        "paint": {"text-halo-color": "#ffffff", "text-halo-width": 2}},
                       {"id": "poi", "type": "symbol", "source": "osm", "source-layer": "pois",
                        "layout": {"icon-image": "base:restaurant", "text-field": ["get", "name"]}}]}


CONFIG = {"options": {"tileMargin": 32, "minRendererPoolSizes": [1], "maxRendererPoolSizes": [2]},
          "data": {"australia": {"mbtiles": "australia.mbtiles"}},
          "styles": {"ride-australia": {"style": "ride-australia.json", "tilejson": {"minzoom": 0, "maxzoom": 19}},
                     "unrelated": {"style": "other.json"}}}


class StyleTests(unittest.TestCase):
    def test_symbols_keep_order_filters_collision_and_halos(self):
        original = fixture()
        before = deepcopy(original)
        base, labels = derive_styles(original)
        symbols = [layer for layer in before["layers"] if layer["type"] == "symbol"]
        self.assertEqual(original, before)
        self.assertEqual(labels["layers"], symbols)
        self.assertEqual([l for l in base["layers"] if l["type"] == "symbol"], symbols)
        self.assertEqual([l["id"] for l in base["layers"]], [l["id"] for l in original["layers"]])
        for key in ("sources", "sprite", "glyphs", "projection"):
            self.assertEqual(labels[key], base[key])
        self.assertNotIn("sky", labels)
        self.assertNotIn("fog", labels)
        self.assertTrue(all(l["type"] == "symbol" for l in labels["layers"]))
        labels["sources"]["osm"]["maxzoom"] = 1
        self.assertEqual(base["sources"]["osm"]["maxzoom"], 14)

    def test_highways_visible_at_first_available_zoom_without_new_geometry(self):
        original = fixture()
        base, _ = derive_styles(original)
        originals = {layer["id"]: layer for layer in original["layers"]}
        for layer in base["layers"]:
            if layer["type"] != "line":
                continue
            old = originals[layer["id"]]
            self.assertEqual(layer["minzoom"], old["minzoom"])
            self.assertEqual(layer["filter"], old["filter"])
            self.assertEqual(layer["paint"]["line-color"], old["paint"]["line-color"])
            for prop in ("line-width", "line-opacity"):
                self.assertGreater(layer["paint"][prop][4], 0)
                self.assertEqual(layer["paint"][prop][5:], old["paint"][prop][5:])
        self.assertEqual(derive_styles(base)[0], base)

    def test_upstream_drift_fails_before_generating_candidate(self):
        style = fixture()
        style["layers"][2]["paint"]["line-width"] = 2
        with self.assertRaisesRegex(ValueError, "Unexpected upstream"):
            derive_styles(style)

    def test_config_and_source_receipt_preserve_existing_service_and_data(self):
        config_before, receipt = deepcopy(CONFIG), {"archiveBytes": 123, "assetsSha256": {"fonts": "pinned"}}
        bundle = style_bundle(fixture(), CONFIG, receipt)
        self.assertEqual(CONFIG, config_before)
        self.assertEqual(bundle[2]["options"], CONFIG["options"])
        self.assertEqual(bundle[2]["data"], CONFIG["data"])
        self.assertEqual(bundle[2]["styles"]["unrelated"], CONFIG["styles"]["unrelated"])
        self.assertEqual(bundle[2]["styles"]["ride-australia-labels"]["tilejson"], CONFIG["styles"]["ride-australia"]["tilejson"])
        self.assertEqual(bundle[3]["tileRevision"], TILE_REVISION)
        self.assertEqual(bundle[3]["assetsSha256"], receipt["assetsSha256"])
        self.assertEqual(bundle[3]["archiveBytes"], 123)

    def test_cli_stages_existing_assets_and_does_not_touch_input(self):
        with tempfile.TemporaryDirectory() as temp:
            root = Path(temp)
            existing, candidate = root / "existing", root / "candidate"
            write_bundle(existing, style_bundle(fixture(), CONFIG, {"archiveBytes": 123}))
            before = {p.relative_to(existing): p.read_bytes() for p in existing.rglob("*.json")}
            command = [sys.executable, str(Path(__file__).with_name("adapt_style.py")), str(existing), "--output", str(candidate)]
            result = subprocess.run(command, capture_output=True, text=True, check=True)
            self.assertEqual(json.loads(result.stdout)["tileRevision"], TILE_REVISION)
            self.assertTrue((candidate / "styles/ride-australia-labels.json").is_file())
            self.assertFalse((candidate / "data").exists())
            self.assertEqual(before, {p.relative_to(existing): p.read_bytes() for p in existing.rglob("*.json")})
            command[-1] = str(existing)
            rejected = subprocess.run(command, capture_output=True, text=True)
            self.assertNotEqual(rejected.returncode, 0)


if __name__ == "__main__":
    unittest.main()
