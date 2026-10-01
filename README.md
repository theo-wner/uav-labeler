<!-- NOTE: This file was written by AI (Claude, Anthropic). -->
# UAV Labeler

Label agricultural plots once on the orthophoto, then get a plot mask for every uav image.

1. **`server.py`**: draw and label the plots in the browser on the orthophoto → `plot-layouts/plots.yaml`
   (UTM corners with soil height, and the crop).
2. **`annotate.py`**: project the plots into every uav image → one mask per image.

## Setup

```bash
uv venv .venv && source .venv/bin/activate && uv pip install -r requirements.txt
```

Expected project layout (exports from Metashape):

```
<project>/
├── images/<name>.tiff          # uav images
└── export/
    ├── ortho.tif               # orthophoto (tiled, with overviews: gdaladdo -r average ortho.tif)
    ├── cam_intrinsics.xml      # camera calibration (Agisoft XML)
    └── cam_extrinsics.txt      # camera poses (Omega Phi Kappa, with rotation matrix)
└── processed/
    └── <project>.files/
        └── 0\
            └── 0\
                └── elevation\  # DEM created by metashape
```

## 1. Label the plots

```bash
python server.py <project>/export/ortho.tif \
    <project>/processed/<project>.files/0/0/elevation --out plots.yaml
```

Open http://localhost:8000 (remote: `ssh -L 8000:localhost:8000 <server>`).
The second argument is the DEM: the `elevation` folder of the Metashape project or a DEM GeoTIFF.
`--out` is just a file name: plot layouts are always saved in and loaded from the `plot-layouts/`
folder next to the scripts (created automatically), so `--out plots.yaml` writes `plot-layouts/plots.yaml`.

- **A** – measure angle: click two points along a plot edge to set the rotation.
- **D** – draw: type a crop, drag a rectangle.
- **Grid** – split a large rectangle into rows × columns with adjustable gaps.
- **P** – select (Shift for more), move, resize, rotate, change crop, Del to delete.
- **Ctrl+Z** – undo.

Every change is saved to `plot-layouts/plots.yaml` immediately and loaded again on restart.
Corner heights are the **soil** height (5th percentile of the DEM within 1 m)

## 2. Create the masks

```bash
python annotate.py <project> --plots plots.yaml [--preview]
```

`--plots` is the name of a layout in `plot-layouts/` (default `plots.yaml`).

- `<project>/masks/<name>.tiff`: uint16 mask, pixel value = plot id, 0 = background.
  Written for every image (all zeros if no plot is visible); every plot overlapping the image is drawn.
- `<project>/preview/<name>.jpg` (with `--preview`): downscaled image with coloured masks and labels.
