"""Project the labelled plots from a plot layout in plot-layouts/ into every drone image and save one mask per image."""
import argparse
from pathlib import Path
import xml.etree.ElementTree as ET

import cv2
import numpy as np
import tifffile
import yaml
from tqdm import tqdm

# Folder with the plot layouts (YAML files) written by server.py.
PLOT_LAYOUTS_DIR = Path(__file__).resolve().parent / "plot-layouts"


def load_intrinsics(xml_path):
    """Read the camera matrix, distortion and image size from a Metashape calibration XML."""
    calib = ET.parse(xml_path).find(".//sensor/calibration")
    get = lambda tag: float(calib.findtext(tag, default="0"))  # missing tag -> 0

    w = int(calib.find("resolution").get("width"))
    h = int(calib.find("resolution").get("height"))
    f, cx, cy = get("f"), get("cx"), get("cy")

    K = np.array([[f, 0.0, w/2 + cx - 0.5],
                  [0.0, f,  h/2 + cy - 0.5],
                  [0.0, 0.0, 1.0]])

    # OpenCV order (k1, k2, p1, p2, k3); Metashape's P1/P2 are swapped
    dist = np.array([get("k1"), get("k2"), get("p2"), get("p1"), get("k3")])
    return K, dist, w, h


def load_extrinsics(txt_path):
    """Read the camera poses from a Metashape Omega Phi Kappa export and convert them to OpenCV."""
    extrinsics = []
    with open(txt_path, "r") as file:
        for line in file:
            if line.startswith("#"):
                continue

            line = line.strip().split("\t")
            img_name = line[0]

            w_t_c = np.array([float(i) for i in line[1:4]]) # metashape trans vec: position of the CCS wrt WCS
            m_R_w = np.array([float(i) for i in line[7:]]).reshape((3, 3)) # metashape rot mat: rotation of the WCS wrt metashape CS (z points up)

            # Step 1: m_R_w --> c_R_w: Flip the rotation so that z now points down (OpenCV convention)
            c_R_w = np.diag([1.0, -1.0, -1.0]) @ m_R_w

            # Step 2: w_t_c --> c_t_w: We have the position of the CCS wrt WCS given but OpenCV needs it otherway round.
            # Plugging the projection x center into x_c = w_R_w * x_w + c_t_w and solving for c_t_w leads to:
            c_t_w = -c_R_w @ w_t_c

            extrinsics.append({"img_name": img_name, "R": c_R_w, "t": c_t_w})
    return extrinsics


def undistortion_map(K, dist, w, h, rows_per_chunk=256):
    """Lookup table that warps a mask from the undistorted pinhole image into the real image.

    Why: distorting the plot corners directly fails for corners far outside the image (the lens
    polynomial explodes there) and would also keep the edges straight although the lens bends them.
    Instead the plots are drawn in the undistorted image and the whole mask is warped.
    """
    criteria = (cv2.TERM_CRITERIA_COUNT | cv2.TERM_CRITERIA_EPS, 100, 1e-8) # undistortion is iterative, make it precise
    xs = np.arange(w, dtype=np.float32)
    und = np.empty((h, w, 2), np.float32) # und[y, x] = undistorted position (x', y') of distorted pixel (x, y)
    for y0 in range(0, h, rows_per_chunk): # in chunks of rows to save memory
        ys = np.arange(y0, min(y0 + rows_per_chunk, h), dtype=np.float32)
        pts = np.stack(np.meshgrid(xs, ys), axis=-1).reshape(-1, 1, 2) # all distorted pixel positions of these rows
        und[y0:y0 + len(ys)] = cv2.undistortPoints(pts, K, dist, R=None, P=K, criteria=criteria).reshape(len(ys), w, 2) # P=K: result in pixels, not normalised

    # Canvas that contains every (x', y'), with a 1 px border
    offset = np.floor(und.reshape(-1, 2).min(axis=0)) - 1
    size = np.ceil(und.reshape(-1, 2).max(axis=0) - offset).astype(int) + 2
    und -= offset.astype(np.float32) # image coordinates -> canvas coordinates
    return und[..., 0], und[..., 1], offset, size


def draw_mask(plots, e, K, und_map, offset, size):
    """Draw all plots into the undistorted canvas (straight pinhole projection), then warp it into the real image."""
    map_x, map_y = und_map
    canvas = np.zeros((size[1], size[0]), np.uint16)
    for plot in plots:
        x_w = np.array(plot["corners"], dtype=np.float64) # corner WCS coordinates
        x_c = x_w @ e["R"].T + e["t"] # corner CCS coordinates
        if (x_c[:, 2] <= 0).any(): # behind the camera
            continue
        x_i = (x_c @ K.T)[:, :2] / x_c[:, 2:] - offset # undistorted canvas coordinates through pinhole projection
        if (x_i.max(axis=0) < 0).any() or (x_i.min(axis=0) >= size).any(): # not on the canvas
            continue
        cv2.fillPoly(canvas, [np.round(x_i).astype(np.int32)], int(plot["id"])) # fillPoly clips parts outside the canvas
    return cv2.remap(canvas, map_x, map_y, cv2.INTER_NEAREST)


def random_colors(n):
    """One distinct BGR colour per plot id, shuffled so neighbouring plots differ."""
    hsv = np.full((n, 1, 3), 255, np.uint8)
    hsv[:, 0, 0] = np.random.default_rng(0).permutation(n) * 180 // n
    return cv2.cvtColor(hsv, cv2.COLOR_HSV2BGR)[:, 0]


def save_preview(img_path, out_path, mask, names, colors, scale=0.1):
    """Save a downscaled JPEG of the image with the masks and plot labels drawn on top."""
    img = np.ascontiguousarray(tifffile.imread(img_path)[..., 2::-1])
    overlay = img.copy()
    overlay[mask > 0] = colors[mask[mask > 0]]
    vis = cv2.addWeighted(img, 0.5, overlay, 0.5, 0)
    vis = cv2.resize(vis, None, fx=scale, fy=scale, interpolation=cv2.INTER_AREA)
    small = cv2.resize(mask, (vis.shape[1], vis.shape[0]), interpolation=cv2.INTER_NEAREST)
    for plot_id in np.unique(small[small > 0]):
        ys, xs = np.nonzero(small == plot_id)
        text, org = names[plot_id], (int(xs.mean()), int(ys.mean()))  # label at the centre of the visible part
        cv2.putText(vis, text, org, cv2.FONT_HERSHEY_SIMPLEX, 1.0, (0, 0, 0), 4)  # black outline
        cv2.putText(vis, text, org, cv2.FONT_HERSHEY_SIMPLEX, 1.0, (255, 255, 255), 2)
    cv2.imwrite(str(out_path), vis)


def main():
    parser = argparse.ArgumentParser(description="Project the labelled plots into every drone image and save masks")
    parser.add_argument("project", type=Path, help="Project folder containing images/ and export/")
    parser.add_argument("--plots", default="plots.yaml",
                        help=f"Name of the YAML file in {PLOT_LAYOUTS_DIR}/ written by server.py")
    parser.add_argument("--preview", action="store_true", help="Also save downscaled preview JPEGs to <project>/preview")
    args = parser.parse_args()

    with open(PLOT_LAYOUTS_DIR / args.plots, "r") as file:
        plots = yaml.safe_load(file)["plots"]

    K, dist, w, h = load_intrinsics(args.project / "export" / "cam_intrinsics.xml")
    extrinsics = load_extrinsics(args.project / "export" / "cam_extrinsics.txt")

    mask_dir = args.project / "masks"
    mask_dir.mkdir(exist_ok=True)
    if args.preview:
        preview_dir = args.project / "preview"
        preview_dir.mkdir(exist_ok=True)
        colors = random_colors(max(p["id"] for p in plots) + 1)
        names = {p["id"]: f"{p['id']} {p['crop']}".strip() for p in plots}

    print("Building the undistortion map, this may take some time...")
    map_x, map_y, offset, size = undistortion_map(K, dist, w, h)

    for e in tqdm(extrinsics):
        mask = draw_mask(plots, e, K, (map_x, map_y), offset, size)
        tifffile.imwrite(mask_dir / f"{e['img_name']}.tiff", mask, compression="zlib")

        if args.preview:
            save_preview(args.project / "images" / f"{e['img_name']}.tiff",
                         preview_dir / f"{e['img_name']}.jpg", mask, names, colors)


if __name__ == "__main__":
    main()
