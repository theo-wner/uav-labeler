# ---------------------------------------------------------------------------
# NOTE: This code was written by AI (Claude, Anthropic).
# ---------------------------------------------------------------------------
"""
Plot labeler - web server.

Serves a (very large) GeoTIFF as map tiles to the browser and stores the
labelled plot rectangles as a YAML file with UTM corner coordinates.
The height of every corner is read from a DEM, e.g. the elevation model
inside the Metashape project (option --dem).

Usage:
    python server.py /path/to/ortho.tif --dem /path/to/project.files/0/0/elevation --out plots.yaml
    (the YAML file is saved in plot-layouts/plots.yaml)
Then open http://localhost:8000 in a browser.

How the tiling works:
    The browser (Leaflet) asks for 256x256 tiles at zoom level z.
    At the highest zoom level (MAX_ZOOM) one tile pixel = one image pixel.
    Every zoom level lower halves the resolution. We simply read the
    corresponding window from the GeoTIFF with a small output shape;
    GDAL then automatically uses the internal overviews, so this is fast
    even for files that are tens of gigabytes large.
"""

import argparse
import io
import math
import os
import threading
import xml.etree.ElementTree as ET
import zipfile

import numpy as np
import rasterio
import yaml
from flask import Flask, Response, jsonify, request, send_from_directory
from PIL import Image
from rasterio.windows import Window, from_bounds

TILE_SIZE = 256
# The height of a corner is the height of the SOIL, even if the corner lies on
# plants: the DEM contains the top of the plants, so we look at all DEM pixels
# within SOIL_SEARCH_RADIUS_M around the corner (this reaches the soil of the
# paths between the plots) and take a low percentile of their heights.
# A low percentile instead of the minimum ignores single noise pixels below the ground.
SOIL_SEARCH_RADIUS_M = 1.0
SOIL_PERCENTILE = 5
# All plot layouts (YAML files) are saved in and loaded from this folder next to the scripts.
PLOT_LAYOUTS_DIR = os.path.join(os.path.dirname(os.path.abspath(__file__)), "plot-layouts")

parser = argparse.ArgumentParser(description="Browser-based plot labeler for large GeoTIFFs")
parser.add_argument("tif", help="Path to the (large) GeoTIFF orthophoto")
parser.add_argument("dem", help="DEM for the corner heights: either the 'elevation' folder of a Metashape "
                                  "project (<project>.files/0/0/elevation) or a DEM GeoTIFF. "
                                  "Must use the same coordinate system as the orthophoto.")
parser.add_argument("--out", default="plots.yaml",
                    help=f"Name of the YAML file in {PLOT_LAYOUTS_DIR}/ to write the labelled plots to")
parser.add_argument("--host", default="127.0.0.1", help="Use 0.0.0.0 to make it reachable from other machines")
parser.add_argument("--port", type=int, default=8000)
args = parser.parse_args()
os.makedirs(PLOT_LAYOUTS_DIR, exist_ok=True)
OUT_PATH = os.path.join(PLOT_LAYOUTS_DIR, args.out)

# Read the basic image information once.
with rasterio.open(args.tif) as src:
    WIDTH, HEIGHT = src.width, src.height
    TRANSFORM = src.transform  # pixel (col, row) -> UTM (x, y)
    CRS = src.crs.to_string() if src.crs else "unknown"
    BAND_COUNT = src.count

# Zoom level at which one tile pixel equals one image pixel.
MAX_ZOOM = math.ceil(math.log2(max(WIDTH, HEIGHT) / TILE_SIZE))

# rasterio datasets must not be shared between threads,
# so every server thread opens its own copy of the file.
thread_data = threading.local()


def get_dataset():
    if not hasattr(thread_data, "dataset"):
        thread_data.dataset = rasterio.open(args.tif)
    return thread_data.dataset


# ---------------------------------------------------------------------------
# Coordinate conversion helpers (pixel <-> UTM)
# ---------------------------------------------------------------------------

def pixel_to_utm(col, row):
    x, y = TRANSFORM * (col, row)
    return [round(x, 3), round(y, 3)]  # millimetre precision is plenty


def utm_to_pixel(x, y):
    col, row = ~TRANSFORM * (x, y)
    return [col, row]


# ---------------------------------------------------------------------------
# Heights from the DEM
# ---------------------------------------------------------------------------
# Metashape stores its DEM ("elevation") as many GeoTIFF tiles plus an index
# file (doc.xml inside elevation.zip) that says where the DEM starts, how large
# a pixel is and which tile file belongs to which tile position.

def read_metashape_dem_index(folder):
    with zipfile.ZipFile(os.path.join(folder, "elevation.zip")) as archive:
        doc = ET.fromstring(archive.read("doc.xml"))
    left = float(doc.find("params/extent/left").text)
    top = float(doc.find("params/extent/top").text)
    right = float(doc.find("params/extent/right").text)
    width = int(doc.find("params/dimensions/width").text)
    tile_width = int(doc.find("params/dimensions/tileWidth").text)
    tiles = {}  # (x, y) tile position -> file name
    for tile in doc.findall("tiles/tile"):
        tiles[(int(tile.get("x")), int(tile.get("y")))] = tile.find("path").text
    return {
        "left": left,
        "top": top,
        "tile_size_m": tile_width * (right - left) / width,  # size of one tile in metres
        "tiles": tiles,
    }


if args.dem is None:
    DEM_INDEX = None
    print("NOTE: no --dem given, the corners are saved without heights.")
elif os.path.isdir(args.dem):
    DEM_INDEX = read_metashape_dem_index(args.dem)
else:
    DEM_INDEX = None  # a single DEM GeoTIFF, no tiles

height_cache = {}      # (easting, northing) -> height; unchanged corners are not read again
open_dem_files = {}    # file path -> opened rasterio dataset
dem_lock = threading.Lock()  # rasterio datasets must not be used by two threads at once


def dem_files_for(left, bottom, right, top):
    """All DEM files that cover a part of this area."""
    if DEM_INDEX is None:
        return [args.dem]  # single GeoTIFF
    size = DEM_INDEX["tile_size_m"]
    files = []
    for x in range(math.floor((left - DEM_INDEX["left"]) / size), math.floor((right - DEM_INDEX["left"]) / size) + 1):
        for y in range(math.floor((DEM_INDEX["top"] - top) / size), math.floor((DEM_INDEX["top"] - bottom) / size) + 1):
            name = DEM_INDEX["tiles"].get((x, y))  # Metashape leaves out empty tiles
            if name:
                files.append(os.path.join(args.dem, name))
    return files


def read_soil_height(easting, northing):
    """Soil height around a point (see SOIL_SEARCH_RADIUS_M), or None if the DEM has no data there."""
    r = SOIL_SEARCH_RADIUS_M
    area = (easting - r, northing - r, easting + r, northing + r)  # left, bottom, right, top

    # Collect the DEM heights in the area. It can reach over several DEM tiles.
    heights = []
    for path in dem_files_for(*area):
        if path not in open_dem_files:
            open_dem_files[path] = rasterio.open(path)
        dem = open_dem_files[path]
        nodata = dem.nodata if dem.nodata is not None else -32767  # -32767 = Metashape's "no data"
        values = dem.read(1, window=from_bounds(*area, transform=dem.transform),
                          boundless=True, fill_value=nodata)  # boundless: the area may reach over the tile border
        heights.append(values[(values != nodata) & np.isfinite(values)])

    heights = np.concatenate(heights) if heights else np.array([])
    if heights.size == 0:
        return None
    return round(float(np.percentile(heights, SOIL_PERCENTILE)), 3)


def get_heights(points):
    """Heights in metres for a list of [easting, northing] points (None where unknown)."""
    if args.dem is None:
        return [None] * len(points)
    with dem_lock:
        for easting, northing in points:
            if (easting, northing) not in height_cache:
                height_cache[(easting, northing)] = read_soil_height(easting, northing)
        return [height_cache[(easting, northing)] for easting, northing in points]


# ---------------------------------------------------------------------------
# Web server
# ---------------------------------------------------------------------------

app = Flask(__name__, static_folder="static")


@app.route("/")
def index():
    return send_from_directory("static", "index.html")


@app.route("/info")
def info():
    """Everything the browser needs to know about the image."""
    return jsonify(
        width=WIDTH,
        height=HEIGHT,
        max_zoom=MAX_ZOOM,
        tile_size=TILE_SIZE,
        crs=CRS,
        pixel_size_m=abs(TRANSFORM.a),
        transform=list(TRANSFORM)[:6],  # x = a*col + b*row + c, y = d*col + e*row + f
        tif=os.path.abspath(args.tif),
        out=OUT_PATH,
    )


@app.route("/tiles/<int:z>/<int:x>/<int:y>.png")
def tile(z, x, y):
    # Size of this tile measured in full-resolution image pixels.
    scale = 2 ** (MAX_ZOOM - z)
    size = TILE_SIZE * scale
    col0, row0 = x * size, y * size

    # Tile completely outside the image -> empty transparent tile.
    if col0 >= WIDTH or row0 >= HEIGHT:
        return Response(empty_tile(), mimetype="image/png")

    # Clip the window at the image border (last row/column of tiles).
    width = min(size, WIDTH - col0)
    height = min(size, HEIGHT - row0)
    out_w = max(1, round(width / scale))
    out_h = max(1, round(height / scale))

    bands = [1, 2, 3, 4] if BAND_COUNT >= 4 else [1, 2, 3][:BAND_COUNT]
    data = get_dataset().read(
        bands,
        window=Window(col0, row0, width, height),
        out_shape=(len(bands), out_h, out_w),
    )

    # Put the (possibly smaller) data into a full RGBA tile.
    rgba = np.zeros((TILE_SIZE, TILE_SIZE, 4), dtype=np.uint8)
    pixels = np.moveaxis(data, 0, -1)  # (bands, h, w) -> (h, w, bands)
    if len(bands) == 1:
        pixels = np.repeat(pixels, 3, axis=2)  # grey image -> RGB
    rgba[:out_h, :out_w, :pixels.shape[2]] = pixels[:, :, :4]
    if len(bands) < 4:
        rgba[:out_h, :out_w, 3] = 255  # no alpha band -> fully opaque

    buffer = io.BytesIO()
    Image.fromarray(rgba, "RGBA").save(buffer, format="PNG", compress_level=1)
    return Response(buffer.getvalue(), mimetype="image/png",
                    headers={"Cache-Control": "max-age=86400"})


def empty_tile():
    buffer = io.BytesIO()
    Image.new("RGBA", (TILE_SIZE, TILE_SIZE)).save(buffer, format="PNG")
    return buffer.getvalue()


@app.route("/plots", methods=["GET"])
def load_plots():
    """Load previously saved plots (so you can continue labelling later)."""
    if not os.path.exists(OUT_PATH):
        return jsonify([])
    with open(OUT_PATH) as f:
        content = yaml.safe_load(f) or {}
    plots = []
    for plot in content.get("plots", []):
        # Corners are [easting, northing, height]; the height is not needed here.
        corners_px = [utm_to_pixel(corner[0], corner[1]) for corner in plot["corners"]]
        plots.append({"crop": plot.get("crop", ""), "corners": corners_px})
    return jsonify(plots)


@app.route("/plots", methods=["POST"])
def save_plots():
    """Receive all plots (in pixel coordinates) and write them as YAML in UTM, with heights."""
    plots_px = request.get_json()

    # Convert all corners to UTM and look up their heights in one go.
    corners_utm = [pixel_to_utm(col, row) for plot in plots_px for col, row in plot["corners"]]
    heights = get_heights(corners_utm)
    warning = None
    missing = heights.count(None)
    if args.dem is None:
        warning = "No heights: start the server with --dem."
    elif missing:
        warning = f"{missing} corners have no height (outside the DEM or in a hole of the DEM)."

    plots = []
    for i, plot in enumerate(plots_px):
        corners = []
        for j in range(4):
            easting, northing = corners_utm[4 * i + j]
            corners.append([easting, northing, heights[4 * i + j]])
        plots.append({"id": i + 1, "crop": plot["crop"], "corners": corners})

    content = {
        "source_image": os.path.abspath(args.tif),
        "crs": CRS,
        "corner_format": "[easting, northing, height] in metres",
        "height_source": os.path.abspath(args.dem) if args.dem else None,
        "height_note": f"soil height: {SOIL_PERCENTILE}th percentile of the DEM within "
                       f"{SOIL_SEARCH_RADIUS_M} m around each corner (ignores plants), "
                       "in the vertical reference of the DEM, not converted",
        "corner_order": "top-left, top-right, bottom-right, bottom-left (as seen in the image)",
        "plots": plots,
    }
    with open(OUT_PATH, "w") as f:
        yaml.dump(content, f, sort_keys=False, default_flow_style=None)
    return jsonify(saved=len(plots), file=OUT_PATH, warning=warning)


if __name__ == "__main__":
    print(f"Image: {WIDTH} x {HEIGHT} px, CRS {CRS}, max zoom {MAX_ZOOM}")
    print(f"Saving plots to: {OUT_PATH}")
    print(f"Open http://{args.host}:{args.port} in your browser")
    app.run(host=args.host, port=args.port, threaded=True)
