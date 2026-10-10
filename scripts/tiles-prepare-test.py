"""Exercise preparation with local fixture downloads and a minimal MBTiles archive."""
import contextlib
import io
import json
from pathlib import Path
import runpy
import sqlite3
import sys
import tarfile
import tempfile
from unittest.mock import patch


def archive_bytes(members):
    result = io.BytesIO()
    with tarfile.open(fileobj=result, mode="w:gz") as archive:
        for name, data in members.items():
            member = tarfile.TarInfo(name)
            member.size = len(data)
            archive.addfile(member, io.BytesIO(data))
    return result.getvalue()


style = {"sources": {"versatiles-shortbread": {"type": "vector", "tiles": ["https://example.test/vector"]}}, "layers": []}
assets = {
    "styles.tar.gz": archive_bytes({"colorful/en.json": json.dumps(style).encode()}),
    "sprites.tar.gz": archive_bytes({"base.json": b"{}", "base.png": b"fixture sprite"}),
    "noto_sans.tar.gz": archive_bytes({"noto_sans_regular/0-255.pbf": b"fixture glyph"}),
}


def download_fixture(request, timeout):
    assert timeout == 120
    return io.BytesIO(assets.get(request.full_url.rsplit("/", 1)[-1], b"Fixture license notice"))


with tempfile.TemporaryDirectory(prefix="ride-tile-prepare-test-") as temporary:
    root = Path(temporary)
    (root / "data").mkdir()
    with sqlite3.connect(root / "data/australia.mbtiles") as database:
        database.execute("CREATE TABLE metadata (name TEXT, value TEXT)")
        database.executemany("INSERT INTO metadata VALUES (?, ?)", [
            ("format", "pbf"), ("minzoom", "0"), ("maxzoom", "14"),
            ("bounds", "68.13342,-57.07106,169.0016,-8.809565"),
        ])
        database.execute("CREATE TABLE tiles (tile_data BLOB)")
        database.execute("INSERT INTO tiles VALUES (?)", (b"fixture vector tile",))
    database.close()
    script = Path(__file__).resolve().parents[1] / "infra/tiles/prepare.py"
    with patch.object(sys, "argv", [str(script), str(root)]), patch("urllib.request.urlopen", download_fixture), contextlib.redirect_stdout(io.StringIO()):
        runpy.run_path(str(script), run_name="__main__")

    prepared_style = json.loads((root / "styles/ride-australia.json").read_text(encoding="utf-8"))
    source = prepared_style["sources"]["versatiles-shortbread"]
    assert source["maxzoom"] == 14, "Vector source must keep the archive's native zoom"
    assert source["url"] == "mbtiles://{australia}"
    assert "tiles" not in source, "Prepared style must not retain external data requests"
    config = json.loads((root / "config.json").read_text(encoding="utf-8"))
    assert config["styles"]["ride-australia"]["tilejson"]["maxzoom"] == 19, "Raster metadata must allow display-zoom rendering"
    assert config["options"]["tileMargin"] == 32
    assert config["options"]["maxSize"] == 256 + 2 * 32
    assert config["options"]["maxScaleFactor"] == 1
    receipt = json.loads((root / "source-receipt.json").read_text(encoding="utf-8"))
    assert receipt["metadata"]["maxzoom"] == "14"
    assert receipt["renderedMaxZoom"] == 19
    assert receipt["tileMargin"] == 32
    assert receipt["maxRenderSize"] == 320
    assert receipt["tileRevision"] == "2026-10-10-1"
print("Tile preparation tests passed: native vector zoom, rendered raster zoom, tile margin, revision receipt and local source references.")
