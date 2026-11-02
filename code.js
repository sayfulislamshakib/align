figma.showUI(__html__, { width: 280, height: 395, themeColors: true });

// Track selection order because Figma's selection array does not always preserve click order.
let orderedSelectionIds = [];

function syncSelectionOrder(notifyUI = true) {
  const currentSelection = figma.currentPage.selection;
  const currentIds = new Set(currentSelection.map((n) => n.id));

  // Keep existing IDs that are still selected, preserving their selection order
  orderedSelectionIds = orderedSelectionIds.filter((id) => currentIds.has(id));

  // Append newly selected nodes
  for (const node of currentSelection) {
    if (!orderedSelectionIds.includes(node.id)) {
      orderedSelectionIds.push(node.id);
    }
  }

  if (notifyUI) {
    sendSelectionState();
  }
}

function getOrderedNodes() {
  syncSelectionOrder(false);
  const map = new Map(figma.currentPage.selection.map((n) => [n.id, n]));
  return orderedSelectionIds.map((id) => map.get(id)).filter(Boolean);
}

function sendSelectionState() {
  const nodes = getOrderedNodes();
  figma.ui.postMessage({
    type: "selection-updated",
    count: nodes.length,
    first: nodes[0] ? { id: nodes[0].id, name: nodes[0].name, type: nodes[0].type } : null,
    second: nodes[1] ? { id: nodes[1].id, name: nodes[1].name, type: nodes[1].type } : null,
  });
}

// Initialize on launch
syncSelectionOrder(true);

figma.on("selectionchange", () => {
  syncSelectionOrder(true);
});

figma.on("currentpagechange", () => {
  orderedSelectionIds = [];
  syncSelectionOrder(true);
});

function getAbsoluteBounds(node) {
  if (node.absoluteBoundingBox) {
    return {
      x: node.absoluteBoundingBox.x,
      y: node.absoluteBoundingBox.y,
      width: node.absoluteBoundingBox.width,
      height: node.absoluteBoundingBox.height,
    };
  }
  const t = node.absoluteTransform;
  return {
    x: t[0][2],
    y: t[1][2],
    width: node.width,
    height: node.height,
  };
}

// Find the nearest ancestor that defines a local coordinate system for node.x / node.y
function getCoordinateParent(node) {
  let p = node.parent;
  while (p && (p.type === "GROUP" || p.type === "BOOLEAN_OPERATION")) {
    p = p.parent;
  }
  return p;
}

function setAbsolutePosition(node, targetAbsX, targetAbsY) {
  const currentAbs = getAbsoluteBounds(node);
  const deltaAbsX = targetAbsX - currentAbs.x;
  const deltaAbsY = targetAbsY - currentAbs.y;

  if (Math.abs(deltaAbsX) < 1e-6 && Math.abs(deltaAbsY) < 1e-6) {
    return;
  }

  const coordParent = getCoordinateParent(node);
  if (coordParent && "absoluteTransform" in coordParent) {
    const m = coordParent.absoluteTransform;
    const a = m[0][0];
    const b = m[0][1];
    const c = m[1][0];
    const d = m[1][1];
    const det = a * d - b * c;

    if (Math.abs(det) > 1e-8) {
      const localDx = (d * deltaAbsX - b * deltaAbsY) / det;
      const localDy = (-c * deltaAbsX + a * deltaAbsY) / det;
      node.x += localDx;
      node.y += localDy;
      return;
    }
  }

  node.x += deltaAbsX;
  node.y += deltaAbsY;
}

function validateAndPrepareNodes() {
  const nodes = getOrderedNodes();

  if (nodes.length < 2) {
    figma.notify("Please select at least 2 frames or layers.", { error: true });
    return null;
  }

  const first = nodes[0];  // 1st selected: node to move
  const second = nodes[1]; // 2nd selected: reference/anchor node

  if (first.locked) {
    figma.notify(`"${first.name}" is locked. Unlock it to move.`, { error: true });
    return null;
  }

  if (!("x" in first) || !("y" in first) || !("width" in first) || !("width" in second)) {
    figma.notify("Selected layers do not support alignment.", { error: true });
    return null;
  }

  // Handle Auto Layout parent on the moving node
  if (
    first.parent &&
    "layoutMode" in first.parent &&
    first.parent.layoutMode !== "NONE" &&
    "layoutPositioning" in first &&
    first.layoutPositioning !== "ABSOLUTE"
  ) {
    try {
      first.layoutPositioning = "ABSOLUTE";
    } catch (err) {
      figma.notify("Cannot move layer inside an Auto Layout frame.", { error: true });
      return null;
    }
  }

  return { first, second };
}

figma.ui.onmessage = (msg) => {
  if (!msg || !msg.type) return;

  if (msg.type === "resize" && typeof msg.height === "number") {
    figma.ui.resize(280, Math.max(200, Math.round(msg.height)));
    return;
  }

  if (msg.type === "ui-ready") {
    syncSelectionOrder(true);
    return;
  }

  if (msg.type === "swap-order") {
    syncSelectionOrder(false);
    if (orderedSelectionIds.length >= 2) {
      const temp = orderedSelectionIds[0];
      orderedSelectionIds[0] = orderedSelectionIds[1];
      orderedSelectionIds[1] = temp;
      sendSelectionState();
    }
    return;
  }

  if (msg.type === "align") {
    const pair = validateAndPrepareNodes();
    if (!pair) return;

    const { first, second } = pair;
    const firstRect = getAbsoluteBounds(first);
    const secondRect = getAbsoluteBounds(second);
    const gap = typeof msg.gap === "number" && !isNaN(msg.gap) ? msg.gap : 0;

    let newAbsX = firstRect.x;
    let newAbsY = firstRect.y;

    switch (msg.direction) {
      case "left":
        newAbsX = secondRect.x + gap;
        break;
      case "right":
        newAbsX = secondRect.x + secondRect.width - firstRect.width - gap;
        break;
      case "top":
        newAbsY = secondRect.y + gap;
        break;
      case "bottom":
        newAbsY = secondRect.y + secondRect.height - firstRect.height - gap;
        break;
      case "center-h":
        newAbsX = secondRect.x + (secondRect.width - firstRect.width) / 2;
        break;
      case "center-v":
        newAbsY = secondRect.y + (secondRect.height - firstRect.height) / 2;
        break;
      case "center":
        newAbsX = secondRect.x + (secondRect.width - firstRect.width) / 2;
        newAbsY = secondRect.y + (secondRect.height - firstRect.height) / 2;
        break;
      default:
        return;
    }

    try {
      setAbsolutePosition(first, newAbsX, newAbsY);
    } catch (err) {
      figma.notify("Cannot move this layer (it may be inside a component instance).", { error: true });
    }
  }

  if (msg.type === "apply-gap") {
    const pair = validateAndPrepareNodes();
    if (!pair) return;

    const { first, second } = pair;
    const firstRect = getAbsoluteBounds(first);
    const secondRect = getAbsoluteBounds(second);
    const gap = typeof msg.gap === "number" && !isNaN(msg.gap) ? msg.gap : 0;

    const firstCenterX = firstRect.x + firstRect.width / 2;
    const firstCenterY = firstRect.y + firstRect.height / 2;
    const secondCenterX = secondRect.x + secondRect.width / 2;
    const secondCenterY = secondRect.y + secondRect.height / 2;

    let axis = msg.axis;
    if (axis === "auto") {
      const dx = Math.abs(firstCenterX - secondCenterX);
      const dy = Math.abs(firstCenterY - secondCenterY);
      axis = dx >= dy ? "h" : "v";
    }

    let newAbsX = firstRect.x;
    let newAbsY = firstRect.y;

    if (axis === "h") {
      // Place 1st frame at `gap` distance horizontally from 2nd frame on its current side
      if (firstCenterX < secondCenterX) {
        newAbsX = secondRect.x - firstRect.width - gap;
      } else {
        newAbsX = secondRect.x + secondRect.width + gap;
      }
    } else if (axis === "v") {
      // Place 1st frame at `gap` distance vertically from 2nd frame on its current side
      if (firstCenterY < secondCenterY) {
        newAbsY = secondRect.y - firstRect.height - gap;
      } else {
        newAbsY = secondRect.y + secondRect.height + gap;
      }
    }

    try {
      setAbsolutePosition(first, newAbsX, newAbsY);
    } catch (err) {
      figma.notify("Cannot move this layer (it may be inside a component instance).", { error: true });
    }
  }

  if (msg.type === "close") {
    figma.closePlugin();
  }
};
