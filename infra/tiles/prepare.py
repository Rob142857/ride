#!/usr/bin/env python3
"""Prepare self-contained, licensed Australian basemap assets; does not start services."""
import hashlib
from contextlib import closing
import io
import json
from pathlib import Path
import sqlite3
import sys
import tarfile
import urllib.request
from adapt_style import TILE_REVISION, style_bundle, write_bundle

STYLE_VERSION = "v6.1.1"
FONT_VERSION = "v3.0.0"
RENDERED_MAX_ZOOM = 19
TILE_MARGIN = 32
MAX_RENDER_SIZE = 256 + 2 * TILE_MARGIN
BASE = Path(sys.argv[1] if len(sys.argv) > 1 else "/srv/ride-tiles").resolve()
ARCHIVE = BASE / "data/australia.mbtiles"
ATTRIBUTION = '<a href="https://www.openstreetmap.org/copyright">© OpenStreetMap contributors</a> · <a href="https://download.geofabrik.de/australia-oceania/australia.html">Geofabrik</a> · <a href="https://github.com/versatiles-org/versatiles-style">VersaTiles</a>'


def download(url):
    request = urllib.request.Request(url, headers={"User-Agent": "Ride Australia basemap setup (ride.incitat.io)"})
    with urllib.request.urlopen(request, timeout=120) as response:
        return response.read()


def extract_assets(raw, destination):
    destination.mkdir(parents=True, exist_ok=True)
    with tarfile.open(fileobj=io.BytesIO(raw), mode="r:gz") as archive:
        for member in archive:
            path = (destination / member.name).resolve()
            if destination.resolve() not in path.parents and path != destination.resolve():
                raise ValueError("Unsafe archive path")
            if member.isdir():
                path.mkdir(parents=True, exist_ok=True)
            elif member.isfile():
                path.parent.mkdir(parents=True, exist_ok=True)
                path.write_bytes(archive.extractfile(member).read())
            elif member.islnk():
                source = (destination / member.linkname).resolve()
                if destination.resolve() not in source.parents:
                    raise ValueError("Unsafe archive link")
                path.parent.mkdir(parents=True, exist_ok=True)
                # Copying these small duplicate glyphs works across filesystems.
                path.write_bytes(source.read_bytes())
            else:
                raise ValueError("Unsupported archive member")


if not ARCHIVE.is_file():
    raise SystemExit(f"Download the official Australia MBTiles to {ARCHIVE} first")

with closing(sqlite3.connect(f"file:{ARCHIVE}?mode=ro", uri=True)) as db:
    metadata = dict(db.execute("SELECT name,value FROM metadata"))
    if metadata.get("format") != "pbf":
        raise SystemExit("Expected Shortbread vector MBTiles (pbf)")
    if db.execute("PRAGMA quick_check").fetchone()[0] != "ok":
        raise SystemExit("MBTiles failed SQLite integrity check")
    # Reading one tile proves this is more than a valid, empty SQLite file.
    if not db.execute("SELECT length(tile_data) FROM tiles LIMIT 1").fetchone():
        raise SystemExit("MBTiles contains no tiles")

BASE.mkdir(parents=True, exist_ok=True)
styles_raw = download(f"https://github.com/versatiles-org/versatiles-style/releases/download/{STYLE_VERSION}/styles.tar.gz")
sprites_raw = download(f"https://github.com/versatiles-org/versatiles-style/releases/download/{STYLE_VERSION}/sprites.tar.gz")
fonts_raw = download(f"https://github.com/versatiles-org/versatiles-fonts/releases/download/{FONT_VERSION}/noto_sans.tar.gz")
extract_assets(sprites_raw, BASE / "sprites")
extract_assets(fonts_raw, BASE / "fonts")
with tarfile.open(fileobj=io.BytesIO(styles_raw), mode="r:gz") as archive:
    style = json.load(archive.extractfile("colorful/en.json"))

# Shortbread 1.0 has no ESA land-cover overlay; keep only OSM attribution.
source = style["sources"]["versatiles-shortbread"]
source.pop("tiles", None)
source["url"] = "mbtiles://{australia}"
source["attribution"] = ATTRIBUTION
source["bounds"] = list(map(float, metadata["bounds"].split(",")))
source["minzoom"] = int(metadata.get("minzoom", 0))
source["maxzoom"] = int(metadata["maxzoom"])
style["glyphs"] = "{fontstack}/{range}.pbf"
style["sprite"] = [{"id": "base", "url": "base"}]
style["name"] = "Ride Australia"

config = {
    "options": {
        "paths": {"root": "/data", "fonts": "fonts", "sprites": "sprites", "styles": "styles", "mbtiles": "data"},
        "frontPage": False,
        "serveStaticMaps": False,
        "allowRemoteMarkerIcons": False,
        "allowInlineMarkerImages": False,
        "serveAllFonts": False,
        "serveAllStyles": False,
        "maxScaleFactor": 1,
        "maxSize": MAX_RENDER_SIZE,
        "minRendererPoolSizes": [1],
        "maxRendererPoolSizes": [2],
        "tileMargin": TILE_MARGIN,
    },
    "styles": {
        "ride-australia": {
            "style": "ride-australia.json",
            # Raster display zoom is independent of the vector archive's
            # native zoom; MapLibre redraws overscaled vectors and labels.
            "tilejson": {"bounds": source["bounds"], "minzoom": source["minzoom"], "maxzoom": RENDERED_MAX_ZOOM, "attribution": ATTRIBUTION},
        }
    },
    "data": {"australia": {"mbtiles": "australia.mbtiles"}},
}
receipt = {
    "source": "https://download.geofabrik.de/australia-oceania/australia-shortbread-1.0.mbtiles",
    "license": "ODbL-1.0 (OpenStreetMap); MIT (VersaTiles style); OFL-1.1 (Noto Sans)",
    "styleVersion": STYLE_VERSION,
    "fontVersion": FONT_VERSION,
    "tileRevision": TILE_REVISION,
    "renderedMaxZoom": RENDERED_MAX_ZOOM,
    "tileMargin": TILE_MARGIN,
    "maxRenderSize": MAX_RENDER_SIZE,
    "archiveBytes": ARCHIVE.stat().st_size,
    "metadata": metadata,
    "assetsSha256": {"styles": hashlib.sha256(styles_raw).hexdigest(), "sprites": hashlib.sha256(sprites_raw).hexdigest(), "fonts": hashlib.sha256(fonts_raw).hexdigest()},
}
bundle = style_bundle(style, config, receipt)
write_bundle(BASE, bundle)

# Include upstream license notices with the self-hosted distribution.
for name, url in {
    "STYLE-LICENSE.txt": f"https://raw.githubusercontent.com/versatiles-org/versatiles-style/{STYLE_VERSION}/LICENSE.md",
    "FONT-LICENSE.txt": "https://raw.githubusercontent.com/notofonts/latin-greek-cyrillic/main/OFL.txt",
}.items():
    (BASE / name).write_bytes(download(url))
print(json.dumps({"prepared": str(BASE), "bounds": source["bounds"], "maxzoom": source["maxzoom"], "renderedMaxZoom": RENDERED_MAX_ZOOM, "tileMargin": TILE_MARGIN, "tileRevision": TILE_REVISION, "labelsLayerCount": len(bundle[1]["layers"]), "archiveBytes": ARCHIVE.stat().st_size}))
