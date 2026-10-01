// ---------------------------------------------------------------------------
// NOTE: This code was written by AI (Claude, Anthropic).
// ---------------------------------------------------------------------------
// Browser side of the plot labeler.
//
// All plots are kept in image PIXEL coordinates ([column, row]) in the
// `plots` array. The server converts them to UTM when saving the YAML file.
// Every plot has exactly 4 corners in the order
// top-left, top-right, bottom-right, bottom-left (for a rotation of 0 deg).

let info = null;          // image information from the server (/info)
let map = null;           // the Leaflet map
let plots = [];           // [{crop: "wheat", corners: [[col, row], ... x4]}]
let selected = new Set(); // indices into `plots`
let history = [];         // snapshots of `plots` for undo
let mode = "pan";         // "pan", "draw" or "angle"

let dragStart = null;     // first corner while drawing a rectangle
let angleStart = null;    // first point while measuring the angle
let preview = null;       // temporary shape shown while drawing / measuring
let polygons = [];        // Leaflet polygon of every plot (same order as `plots`)
let drag = null;          // current move / resize of existing rectangles (see startDrag)
let justDragged = false;  // true right after a drag, so the following click is ignored
let rotationEdit = null;  // corners before the rotation slider was moved (see onRotationInput)
const plotLayer = L.layerGroup();
const gridPreviewLayer = L.layerGroup(); // dashed preview of the grid split
const handleLayer = L.layerGroup();      // resize and rotation handles of the selected rectangle

// Resize handles: [su, sv] says which edges a handle moves.
// su: -1 = left edge, +1 = right edge, 0 = none; sv: -1 = top, +1 = bottom, 0 = none.
const HANDLES = [[-1, -1], [0, -1], [1, -1], [1, 0], [1, 1], [0, 1], [-1, 1], [-1, 0]];

const COLORS = ["#e6194b", "#3cb44b", "#ffe119", "#4363d8", "#f58231", "#911eb4",
                "#46f0f0", "#f032e6", "#bcf60c", "#fabebe", "#008080", "#e6beff",
                "#9a6324", "#fffac8", "#800000", "#aaffc3", "#808000", "#ffd8b1"];

const $ = (id) => document.getElementById(id);

// ---------------------------------------------------------------------------
// Setup
// ---------------------------------------------------------------------------

async function start() {
  info = await (await fetch("/info")).json();

  // A simple (non-geographic) map. At zoom level `max_zoom` one screen
  // pixel is one image pixel. Beyond that we allow 2 more zoom levels.
  map = L.map("map", {
    crs: L.CRS.Simple,
    minZoom: 0,
    maxZoom: info.max_zoom + 2,
    zoomSnap: 0.5,
    preferCanvas: true,       // faster with many rectangles
    boxZoom: false,
    doubleClickZoom: false,
  });

  const bounds = L.latLngBounds(toLatLng([0, info.height]), toLatLng([info.width, 0]));
  L.tileLayer("/tiles/{z}/{x}/{y}.png", {
    tileSize: info.tile_size,
    minZoom: 0,
    maxNativeZoom: info.max_zoom,
    maxZoom: info.max_zoom + 2,
    bounds: bounds,
    noWrap: true,
  }).addTo(map);
  map.fitBounds(bounds);
  plotLayer.addTo(map);
  gridPreviewLayer.addTo(map);
  handleLayer.addTo(map);

  map.on("mousedown", onMouseDown);
  map.on("mousemove", onMouseMove);
  map.on("mouseup", onMouseUp);
  map.on("click", onMapClick);
  map.on("zoomend", drawHandles); // the rotation handle keeps a fixed distance on screen
  document.addEventListener("mouseup", endDrag); // also if the mouse is released outside the map

  connectButtons();
  setMode("pan");

  // Continue with previously saved plots (if the YAML file already exists).
  plots = await (await fetch("/plots")).json();
  redraw();
  setStatus(`Loaded ${plots.length} plots. Saving to ${info.out}`);
}

function connectButtons() {
  $("mode-pan").onclick = () => setMode("pan");
  $("mode-draw").onclick = () => setMode("draw");
  $("mode-angle").onclick = () => setMode("angle");
  $("apply-crop").onclick = applyCropToSelection;
  $("selected-crop").onkeydown = (e) => { if (e.key === "Enter") applyCropToSelection(); };
  $("delete").onclick = deleteSelection;
  $("split").onclick = splitSelection;
  $("grid-rows").oninput = updateGridPreview;
  $("grid-cols").oninput = updateGridPreview;
  linkSliderAndNumber("grid-gap-rows", updateGridPreview);
  linkSliderAndNumber("grid-gap-cols", updateGridPreview);
  linkSliderAndNumber("selected-angle", onRotationInput);
  $("selected-angle").onchange = onRotationDone;       // slider released
  $("selected-angle-value").onchange = onRotationDone; // Enter pressed / field left
  $("undo").onclick = undo;
  $("show-labels").onchange = redraw;
  document.addEventListener("keydown", onKeyDown);
}

// Keep a slider and its number field (id + "-value") in sync,
// and call `onInput` whenever one of them changes.
function linkSliderAndNumber(id, onInput) {
  const slider = $(id), number = $(id + "-value");
  slider.oninput = () => { number.value = slider.value; onInput(); };
  number.oninput = () => { slider.value = number.value; onInput(); };
}

// ---------------------------------------------------------------------------
// Coordinate helpers
// ---------------------------------------------------------------------------

// Image pixel [col, row] -> Leaflet LatLng
function toLatLng(p) {
  return map.unproject(p, info.max_zoom);
}

// Leaflet LatLng -> image pixel [col, row]
function toPixel(latlng) {
  const p = map.project(latlng, info.max_zoom);
  return [p.x, p.y];
}

// Image pixel -> UTM [easting, northing] (only used to display the cursor position)
function toUtm(p) {
  const [a, b, c, d, e, f] = info.transform;
  return [a * p[0] + b * p[1] + c, d * p[0] + e * p[1] + f];
}

// Rotate point p around the origin by `angle` degrees.
function rotate(p, angle) {
  const r = angle * Math.PI / 180;
  return [p[0] * Math.cos(r) - p[1] * Math.sin(r),
          p[0] * Math.sin(r) + p[1] * Math.cos(r)];
}

// Rectangle with opposite corners p1 and p2, whose sides are rotated by `angle`.
// Idea: rotate both points so that the rectangle becomes axis-aligned,
// build the axis-aligned rectangle there, then rotate its corners back.
function rotatedRectangle(p1, p2, angle) {
  const a = rotate(p1, -angle);
  const b = rotate(p2, -angle);
  const left = Math.min(a[0], b[0]), right = Math.max(a[0], b[0]);
  const top = Math.min(a[1], b[1]), bottom = Math.max(a[1], b[1]);
  const corners = [[left, top], [right, top], [right, bottom], [left, bottom]];
  return corners.map((c) => rotate(c, angle));
}

function distance(p, q) {
  return Math.hypot(q[0] - p[0], q[1] - p[1]);
}

// Rotate point p around `center` by `angle` degrees.
function rotateAround(p, center, angle) {
  const r = rotate([p[0] - center[0], p[1] - center[1]], angle);
  return [r[0] + center[0], r[1] + center[1]];
}

// Rotation of a rectangle in degrees (direction of its top edge).
function angleOf(corners) {
  const [tl, tr] = corners;
  return Math.atan2(tr[1] - tl[1], tr[0] - tl[0]) * 180 / Math.PI;
}

// Point inside a rectangle, given as fractions (u, v) between 0 and 1:
// u goes from the left to the right edge, v from the top to the bottom edge.
function pointInRectangle(corners, u, v) {
  const [tl, tr, , bl] = corners;
  return [
    tl[0] + u * (tr[0] - tl[0]) + v * (bl[0] - tl[0]),
    tl[1] + u * (tr[1] - tl[1]) + v * (bl[1] - tl[1]),
  ];
}

// ---------------------------------------------------------------------------
// Drawing the plots on the map
// ---------------------------------------------------------------------------

function cropNames() {
  return [...new Set(plots.map((p) => p.crop).filter((c) => c))].sort();
}

function colorFor(crop) {
  if (!crop) return "#999999";
  return COLORS[cropNames().indexOf(crop) % COLORS.length];
}

function redraw() {
  if (rotationEdit) onRotationDone(); // save an unfinished rotation from the slider first
  plotLayer.clearLayers();
  polygons = [];
  const showLabels = $("show-labels").checked;

  plots.forEach((plot, index) => {
    const isSelected = selected.has(index);
    const polygon = L.polygon(plot.corners.map(toLatLng), {
      color: isSelected ? "#ffffff" : colorFor(plot.crop),
      weight: isSelected ? 3 : 2,
      fillColor: colorFor(plot.crop),
      fillOpacity: isSelected ? 0.05 : 0.15, // keep the image visible below the grid preview
    });
    if (showLabels && plot.crop) {
      polygon.bindTooltip(plot.crop, { permanent: true, direction: "center", className: "crop-label" });
    }
    polygon.on("click", (e) => onPlotClick(e, index));
    polygon.on("mousedown", (e) => {
      // Pressing the mouse on a selected rectangle moves all selected rectangles.
      if (mode === "pan" && selected.has(index)) startDrag(e, { type: "move" });
    });
    polygon.addTo(plotLayer);
    polygons.push(polygon);
  });

  updateSidebar();
  updateGridPreview();
  drawHandles();
}

// Show the 8 resize handles when exactly one rectangle is selected.
function drawHandles() {
  handleLayer.clearLayers();
  if (mode !== "pan" || selected.size !== 1) return;
  const index = [...selected][0];

  for (const [su, sv] of HANDLES) {
    const p = pointInRectangle(plots[index].corners, (su + 1) / 2, (sv + 1) / 2);
    const handle = L.circleMarker(toLatLng(p), {
      radius: 6, color: "#000000", weight: 1, fillColor: "#ffffff", fillOpacity: 1,
      bubblingMouseEvents: false,
    });
    handle.on("mousedown", (e) => startDrag(e, { type: "resize", index, su, sv }));
    handle.addTo(handleLayer);
  }

  // Rotation handle: 30 screen pixels outside the middle of the top edge.
  const corners = plots[index].corners;
  const top = pointInRectangle(corners, 0.5, 0);
  const center = pointInRectangle(corners, 0.5, 0.5);
  const offset = 30 * 2 ** (info.max_zoom - map.getZoom()); // 30 screen pixels in image pixels
  const d = distance(center, top);
  const p = [top[0] + (top[0] - center[0]) / d * offset, top[1] + (top[1] - center[1]) / d * offset];
  L.polyline([toLatLng(top), toLatLng(p)], { color: "#ffffff", weight: 1, interactive: false }).addTo(handleLayer);
  const handle = L.circleMarker(toLatLng(p), {
    radius: 7, color: "#000000", weight: 1, fillColor: "#ff9900", fillOpacity: 1,
    bubblingMouseEvents: false,
  });
  handle.on("mousedown", (e) => startDrag(e, { type: "rotate" }));
  handle.addTo(handleLayer);
}

function updateSidebar() {
  $("selection-count").textContent = selected.size;
  if (selected.size > 0) {
    const angle = angleOf(plots[[...selected][0]].corners).toFixed(1);
    $("selected-angle").value = angle;
    $("selected-angle-value").value = angle;
  }

  // Crop suggestions for the input fields
  $("crop-list").innerHTML = cropNames().map((c) => `<option value="${c}">`).join("");

  // Number of plots per crop
  const counts = {};
  plots.forEach((p) => { const c = p.crop || "(no crop)"; counts[c] = (counts[c] || 0) + 1; });
  $("summary").innerHTML = `<div>${plots.length} plots in total</div>` +
    Object.keys(counts).sort().map((c) =>
      `<div><span class="swatch" style="background:${colorFor(c === "(no crop)" ? "" : c)}"></span>${c}: ${counts[c]}</div>`
    ).join("");
}

function setPreview(layer) {
  if (preview) map.removeLayer(preview);
  preview = layer;
  if (preview) preview.addTo(map);
}

// ---------------------------------------------------------------------------
// Modes and mouse handling
// ---------------------------------------------------------------------------

function setMode(newMode) {
  mode = newMode;
  dragStart = null;
  angleStart = null;
  setPreview(null);

  // In draw / angle mode the mouse is needed for drawing, not for panning.
  if (mode === "pan") map.dragging.enable(); else map.dragging.disable();
  $("map").classList.toggle("drawing", mode !== "pan");
  drawHandles();

  for (const m of ["pan", "draw", "angle"]) {
    $("mode-" + m).classList.toggle("active", m === mode);
  }
  $("mode-hint").textContent = {
    pan: "Drag to move the map. Click rectangles to select them. " +
         "Drag a selected rectangle to move it, drag its white handles to resize it " +
         "and the orange handle to rotate it.",
    draw: "Drag with the mouse to draw a rectangle (uses the rotation below).",
    angle: "Click two points along the edge of a plot to set the rotation.",
  }[mode];
}

function onMouseDown(e) {
  if (mode === "draw") {
    dragStart = toPixel(e.latlng);
  }
}

function onMouseMove(e) {
  const p = toPixel(e.latlng);
  const utm = toUtm(p);
  $("cursor").textContent = `E ${utm[0].toFixed(3)}  N ${utm[1].toFixed(3)}`;

  if (drag) updateDrag(p);

  if (mode === "draw" && dragStart) {
    const corners = rotatedRectangle(dragStart, p, currentAngle());
    setPreview(L.polygon(corners.map(toLatLng), { color: "#ffffff", dashArray: "5 5", fillOpacity: 0.1 }));
  }
  if (mode === "angle" && angleStart) {
    setPreview(L.polyline([toLatLng(angleStart), e.latlng], { color: "#ffff00", weight: 2 }));
  }
}

function onMouseUp(e) {
  if (mode !== "draw" || !dragStart) return;
  const end = toPixel(e.latlng);
  const start = dragStart;
  dragStart = null;
  setPreview(null);

  // Ignore tiny rectangles (probably just a click): less than 5 screen pixels.
  const screenSize = map.latLngToContainerPoint(toLatLng(start)).distanceTo(e.containerPoint);
  if (screenSize < 5) return;

  saveUndoSnapshot();
  plots.push({ crop: $("new-crop").value.trim(), corners: rotatedRectangle(start, end, currentAngle()) });
  selected = new Set([plots.length - 1]);
  $("selected-crop").value = plots[plots.length - 1].crop;
  changed();
}

function onMapClick(e) {
  if (justDragged) return;
  if (mode === "pan") {
    // Click on empty space -> clear the selection
    selected.clear();
    redraw();
  }
  if (mode === "angle") {
    const p = toPixel(e.latlng);
    if (!angleStart) {
      angleStart = p;
      return;
    }
    // Angle of the clicked line. Plots are rectangles, so we bring the
    // angle into the range -45..45 deg (it does not matter which edge was clicked).
    let angle = Math.atan2(p[1] - angleStart[1], p[0] - angleStart[0]) * 180 / Math.PI;
    while (angle > 45) angle -= 90;
    while (angle <= -45) angle += 90;
    $("angle").value = angle.toFixed(2);
    setMode("draw");
  }
}

function onPlotClick(e, index) {
  if (mode !== "pan") return;
  L.DomEvent.stopPropagation(e); // do not clear the selection in onMapClick
  if (justDragged) return;

  if (e.originalEvent.shiftKey) {
    // Shift+click: add to / remove from the selection
    if (selected.has(index)) selected.delete(index); else selected.add(index);
  } else {
    selected = new Set([index]);
  }
  if (selected.size === 1) $("selected-crop").value = plots[[...selected][0]].crop;
  redraw();
}

function onKeyDown(e) {
  // Do not steal key presses while the user is typing in a text field.
  if (e.target.tagName === "INPUT") {
    if (e.key === "Escape") e.target.blur();
    return;
  }
  if (e.key === "p") setMode("pan");
  else if (e.key === "d") setMode("draw");
  else if (e.key === "a") setMode("angle");
  else if (e.key === "Delete" || e.key === "Backspace") deleteSelection();
  else if (e.key === "z" && (e.ctrlKey || e.metaKey)) undo();
  else if (e.key === "Escape") { setMode(mode); selected.clear(); redraw(); }
}

function currentAngle() {
  return parseFloat($("angle").value) || 0;
}

// ---------------------------------------------------------------------------
// Moving and resizing existing rectangles
// ---------------------------------------------------------------------------

// `options` is {type: "move"} or {type: "resize", index, su, sv}.
function startDrag(e, options) {
  map.dragging.disable(); // the mouse now moves the rectangle, not the map
  drag = {
    ...options,
    start: toPixel(e.latlng),
    original: plots.map((plot) => plot.corners), // corners before the drag
    undoSnapshot: JSON.stringify(plots),
    moved: false,
  };
}

function updateDrag(p) {
  const dx = p[0] - drag.start[0];
  const dy = p[1] - drag.start[1];

  if (drag.type === "move") {
    selected.forEach((i) => {
      plots[i].corners = drag.original[i].map((c) => [c[0] + dx, c[1] + dy]);
    });
  } else if (drag.type === "resize") {
    plots[drag.index].corners = resizedCorners(drag.original[drag.index], drag.su, drag.sv, p);
  } else if (drag.type === "rotate") {
    // Angle between "centre -> start of drag" and "centre -> mouse"
    const c = selectionCenter(drag.original);
    const startAngle = Math.atan2(drag.start[1] - c[1], drag.start[0] - c[0]);
    const mouseAngle = Math.atan2(p[1] - c[1], p[0] - c[0]);
    rotateSelection(drag.original, (mouseAngle - startAngle) * 180 / Math.PI);
  }
  drag.moved = true;
  updateSelectedShapes();
}

// Only update the changed rectangles on the map (redrawing everything would be slow).
function updateSelectedShapes() {
  selected.forEach((i) => polygons[i].setLatLngs(plots[i].corners.map(toLatLng)));
  drawHandles();
  updateGridPreview();
}

// Centre of all selected rectangles (using the corners in `cornerList`).
function selectionCenter(cornerList) {
  const points = [...selected].flatMap((i) => cornerList[i]);
  return [points.reduce((sum, p) => sum + p[0], 0) / points.length,
          points.reduce((sum, p) => sum + p[1], 0) / points.length];
}

// Rotate all selected rectangles by `angle` degrees around their common centre,
// starting from the corners in `cornerList`.
function rotateSelection(cornerList, angle) {
  const center = selectionCenter(cornerList);
  selected.forEach((i) => {
    plots[i].corners = cornerList[i].map((c) => rotateAround(c, center, angle));
  });
}

// The rotation slider / number field was changed: rotate the selection so that
// the first selected rectangle gets the chosen angle.
function onRotationInput() {
  if (selected.size === 0) return;
  if (!rotationEdit) {
    rotationEdit = { original: plots.map((plot) => plot.corners), undoSnapshot: JSON.stringify(plots) };
  }
  const target = parseFloat($("selected-angle-value").value);
  if (isNaN(target)) return; // e.g. only "-" typed so far
  const current = angleOf(rotationEdit.original[[...selected][0]]);
  rotateSelection(rotationEdit.original, target - current);
  updateSelectedShapes();
}

// Slider released or number entered: save the rotation.
function onRotationDone() {
  if (!rotationEdit) return;
  saveUndoSnapshot(rotationEdit.undoSnapshot);
  rotationEdit = null;
  changed();
}

function endDrag() {
  if (!drag) return;
  if (drag.moved) {
    saveUndoSnapshot(drag.undoSnapshot);
    changed();
    // The browser sends a click right after releasing the mouse; ignore it.
    justDragged = true;
    setTimeout(() => { justDragged = false; }, 0);
  }
  drag = null;
  if (mode === "pan") map.dragging.enable();
}

// Move the edges selected by su / sv to the mouse position p. The rectangle
// keeps its rotation: we work in the rectangle's own axes, where the top-left
// corner is (0, 0), the width goes along the top edge and the height along the left edge.
function resizedCorners(corners, su, sv, p) {
  const [tl, tr, , bl] = corners;
  const width = distance(tl, tr), height = distance(tl, bl);
  const ex = [(tr[0] - tl[0]) / width, (tr[1] - tl[1]) / width];   // unit vector to the right
  const ey = [(bl[0] - tl[0]) / height, (bl[1] - tl[1]) / height]; // unit vector downwards

  // Mouse position in the rectangle's own axes
  const mu = (p[0] - tl[0]) * ex[0] + (p[1] - tl[1]) * ex[1];
  const mv = (p[0] - tl[0]) * ey[0] + (p[1] - tl[1]) * ey[1];

  let left = 0, right = width, top = 0, bottom = height;
  if (su < 0) left = mu;
  if (su > 0) right = mu;
  if (sv < 0) top = mv;
  if (sv > 0) bottom = mv;

  // Dragging an edge past the opposite edge flips the rectangle; keep it at least 1 pixel wide.
  [left, right] = [Math.min(left, right), Math.max(left, right, Math.min(left, right) + 1)];
  [top, bottom] = [Math.min(top, bottom), Math.max(top, bottom, Math.min(top, bottom) + 1)];

  const at = (u, v) => [tl[0] + u * ex[0] + v * ey[0], tl[1] + u * ex[1] + v * ey[1]];
  return [at(left, top), at(right, top), at(right, bottom), at(left, bottom)];
}

// ---------------------------------------------------------------------------
// Editing actions
// ---------------------------------------------------------------------------

function applyCropToSelection() {
  if (selected.size === 0) return;
  saveUndoSnapshot();
  const crop = $("selected-crop").value.trim();
  selected.forEach((i) => { plots[i].crop = crop; });
  changed();
}

function deleteSelection() {
  if (selected.size === 0) return;
  saveUndoSnapshot();
  plots = plots.filter((_, i) => !selected.has(i));
  selected.clear();
  changed();
}

// Grid settings from the sidebar (gaps converted from metres to pixels).
function gridSettings() {
  return {
    rows: parseInt($("grid-rows").value),
    cols: parseInt($("grid-cols").value),
    gapRows: (parseFloat($("grid-gap-rows-value").value) || 0) / info.pixel_size_m,
    gapCols: (parseFloat($("grid-gap-cols-value").value) || 0) / info.pixel_size_m,
  };
}

// Draw the grid that "Apply grid" would create, as dashed lines, without changing any plots.
function updateGridPreview() {
  gridPreviewLayer.clearLayers();
  const { rows, cols, gapRows, gapCols } = gridSettings();
  if (!(rows >= 1) || !(cols >= 1)) return;
  if (rows === 1 && cols === 1) return; // nothing to split

  selected.forEach((index) => {
    const cells = gridCells(plots[index], rows, cols, gapRows, gapCols);
    if (!cells) return; // gaps too large for this rectangle
    for (const cell of cells) {
      L.polygon(cell.corners.map(toLatLng), {
        color: "#ffff00", weight: 1.5, dashArray: "4 4", fill: false, interactive: false,
      }).addTo(gridPreviewLayer);
    }
  });
}

// Replace every selected rectangle by a rows x cols grid of smaller rectangles.
function splitSelection() {
  const { rows, cols, gapRows, gapCols } = gridSettings();
  if (selected.size === 0 || !(rows >= 1) || !(cols >= 1)) return;
  for (const index of selected) {
    if (!gridCells(plots[index], rows, cols, gapRows, gapCols)) {
      alert("The gaps are larger than the selected rectangle.");
      return;
    }
  }

  saveUndoSnapshot();
  const newPlots = [];
  plots.forEach((plot, index) => {
    if (selected.has(index)) {
      newPlots.push(...gridCells(plot, rows, cols, gapRows, gapCols));
    } else {
      newPlots.push(plot);
    }
  });
  plots = newPlots;
  // Clear the selection, otherwise the preview would immediately show the new cells split again.
  selected.clear();
  changed();
}

// Returns rows x cols plots (row by row, starting top-left) inside `plot`,
// or null if the gaps do not fit into the rectangle.
function gridCells(plot, rows, cols, gapRows, gapCols) {
  const [tl, tr, , bl] = plot.corners;
  const at = (u, v) => pointInRectangle(plot.corners, u, v);
  const gapU = gapCols / distance(tl, tr);           // gap as fraction of the width
  const gapV = gapRows / distance(tl, bl);           // gap as fraction of the height
  const cellU = (1 - (cols - 1) * gapU) / cols;      // cell width as fraction
  const cellV = (1 - (rows - 1) * gapV) / rows;      // cell height as fraction
  if (cellU <= 0 || cellV <= 0) return null;

  const cells = [];
  for (let r = 0; r < rows; r++) {
    for (let c = 0; c < cols; c++) {
      const u0 = c * (cellU + gapU), u1 = u0 + cellU;
      const v0 = r * (cellV + gapV), v1 = v0 + cellV;
      cells.push({ crop: plot.crop, corners: [at(u0, v0), at(u1, v0), at(u1, v1), at(u0, v1)] });
    }
  }
  return cells;
}

function saveUndoSnapshot(snapshot = JSON.stringify(plots)) {
  history.push(snapshot);
  if (history.length > 100) history.shift();
}

function undo() {
  if (history.length === 0) return;
  plots = JSON.parse(history.pop());
  selected.clear();
  changed();
}

// Call after every change: redraw the map and save to the server.
function changed() {
  redraw();
  save();
}

// Only one save at a time: saving can take a moment (the server reads the
// corner heights from the DEM), and an older save must not overwrite a newer one.
let saving = false;
let saveAgain = false;

async function save() {
  if (saving) {
    saveAgain = true; // save once more (with the newest plots) when the current save is done
    return;
  }
  saving = true;
  try {
    const response = await fetch("/plots", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(plots),
    });
    const result = await response.json();
    if (result.warning) {
      setStatus(`Saved ${result.saved} plots. ${result.warning}`, true);
    } else {
      setStatus(`Saved ${result.saved} plots to ${result.file}`);
    }
  } catch (err) {
    setStatus("ERROR while saving: " + err, true);
  }
  saving = false;
  if (saveAgain) {
    saveAgain = false;
    save();
  }
}

function setStatus(text, isError = false) {
  $("status").textContent = text;
  $("status").style.color = isError ? "red" : "";
}

start();
