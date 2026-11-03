figma.showUI(__html__, { width: 240, height: 112, themeColors: true });

// Track selection order because Figma's selection array does not always preserve click order.
let orderedSelectionIds = [];

function isAncestor(ancestor, node) {
  let p = node.parent;
  while (p) {
    if (p.id === ancestor.id) return true;
    p = p.parent;
  }
  return false;
}

function isLockedOrHasLockedAncestor(node) {
  let curr = node;
  while (curr && curr.type !== "PAGE" && curr.type !== "DOCUMENT") {
    if ("locked" in curr && curr.locked) return true;
    curr = curr.parent;
  }
  return false;
}

function isInsideInstance(node) {
  let p = node.parent;
  while (p && p.type !== "PAGE" && p.type !== "DOCUMENT") {
    if (p.type === "INSTANCE") return true;
    p = p.parent;
  }
  return false;
}

function isInAutoLayoutFlow(node) {
  return Boolean(
    node.parent &&
    "layoutMode" in node.parent &&
    node.parent.layoutMode !== "NONE" &&
    (!("layoutPositioning" in node) || node.layoutPositioning !== "ABSOLUTE")
  );
}

function getNonMovableReason(node) {
  if (!node || !("x" in node) || !("y" in node) || !("width" in node)) {
    return "does not support positioning";
  }
  if (isLockedOrHasLockedAncestor(node)) {
    return "is locked";
  }
  if (isInAutoLayoutFlow(node)) {
    return "is inside an Auto Layout frame";
  }
  if (isInsideInstance(node)) {
    return "is inside a component instance";
  }
  return null;
}

function isMovableNode(node) {
  return getNonMovableReason(node) === null;
}

function ensureMovableFirst() {
  if (orderedSelectionIds.length < 2) return;
  const map = new Map(figma.currentPage.selection.map((n) => [n.id, n]));
  const first = map.get(orderedSelectionIds[0]);
  const second = map.get(orderedSelectionIds[1]);
  if (!first || !second) return;

  // If 1st is non-movable (or contains 2nd) while 2nd is movable, put the movable layer 1st
  const firstCanMove = isMovableNode(first) && !isAncestor(first, second);
  const secondCanMove = isMovableNode(second) && !isAncestor(second, first);

  if (!firstCanMove && secondCanMove) {
    orderedSelectionIds[0] = second.id;
    orderedSelectionIds[1] = first.id;
  }
}

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

  ensureMovableFirst();

  if (notifyUI) {
    sendSelectionState();
  }
}

function getOrderedNodes() {
  syncSelectionOrder(false);
  const map = new Map(figma.currentPage.selection.map((n) => [n.id, n]));
  return orderedSelectionIds.map((id) => map.get(id)).filter(Boolean);
}

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

function cleanNum(v) {
  return Math.round(v * 1000) / 1000;
}

function computeCurrentGapInfo(first, second) {
  if (!first || !second || !("width" in first) || !("width" in second)) return null;
  const r1 = getAbsoluteBounds(first);
  const r2 = getAbsoluteBounds(second);

  if (isAncestor(second, first)) {
    const leftGap = cleanNum(r1.x - r2.x);
    const rightGap = cleanNum((r2.x + r2.width) - (r1.x + r1.width));
    const topGap = cleanNum(r1.y - r2.y);
    const bottomGap = cleanNum((r2.y + r2.height) - (r1.y + r1.height));
    return {
      h: Math.min(leftGap, rightGap),
      v: Math.min(topGap, bottomGap),
      inside: true,
    };
  }

  const sepX = Math.max(r1.x - (r2.x + r2.width), r2.x - (r1.x + r1.width));
  const sepY = Math.max(r1.y - (r2.y + r2.height), r2.y - (r1.y + r1.height));
  return {
    h: cleanNum(Math.max(0, sepX)),
    v: cleanNum(Math.max(0, sepY)),
    inside: false,
  };
}

function sendSelectionState() {
  const nodes = getOrderedNodes();
  const first = nodes[0] || null;
  const second = nodes[1] || null;
  const canSwap = Boolean(
    first &&
    second &&
    isMovableNode(second) &&
    !isAncestor(second, first)
  );

  figma.ui.postMessage({
    type: "selection-updated",
    count: nodes.length,
    first: first ? { id: first.id, name: first.name, type: first.type } : null,
    second: second ? { id: second.id, name: second.name, type: second.type } : null,
    canSwap,
    gapInfo: computeCurrentGapInfo(first, second),
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
    return false;
  }

  let localDx = deltaAbsX;
  let localDy = deltaAbsY;

  const coordParent = getCoordinateParent(node);
  if (coordParent && "absoluteTransform" in coordParent) {
    const m = coordParent.absoluteTransform;
    const a = m[0][0];
    const b = m[0][1];
    const c = m[1][0];
    const d = m[1][1];
    const det = a * d - b * c;

    if (Math.abs(det) > 1e-8) {
      localDx = (d * deltaAbsX - b * deltaAbsY) / det;
      localDy = (-c * deltaAbsX + a * deltaAbsY) / det;
    }
  }

  const newX = cleanNum(node.x + localDx);
  const newY = cleanNum(node.y + localDy);
  let moved = false;
  if (node.x !== newX) {
    node.x = newX;
    moved = true;
  }
  if (node.y !== newY) {
    node.y = newY;
    moved = true;
  }
  return moved;
}

function validateAndPrepareNodes() {
  const nodes = getOrderedNodes();

  if (nodes.length < 2) {
    figma.notify("Please select at least 2 frames or layers.", { error: true });
    return null;
  }

  const first = nodes[0];  // 1st selected: node to move
  const second = nodes[1]; // 2nd selected: reference/anchor node

  if (isAncestor(first, second)) {
    figma.notify("1st layer contains the 2nd layer. Click \"Swap\" to move the inner layer.", { error: true });
    return null;
  }

  const reason = getNonMovableReason(first);
  if (reason) {
    figma.notify(`Cannot move "${first.name}" because it ${reason}.`, { error: true });
    return null;
  }

  if (!("width" in second) || !("height" in second)) {
    figma.notify("Selected target layer does not support alignment.", { error: true });
    return null;
  }

  return { first, second, nodes };
}

figma.ui.onmessage = (msg) => {
  if (!msg || !msg.type) return;

  if (msg.type === "resize" && typeof msg.height === "number") {
    figma.ui.resize(240, Math.max(80, Math.round(msg.height)));
    return;
  }

  if (msg.type === "ui-ready") {
    syncSelectionOrder(true);
    return;
  }

  if (msg.type === "swap-order") {
    syncSelectionOrder(false);
    if (orderedSelectionIds.length >= 2) {
      const map = new Map(figma.currentPage.selection.map((n) => [n.id, n]));
      const first = map.get(orderedSelectionIds[0]);
      const second = map.get(orderedSelectionIds[1]);
      if (first && second) {
        const reason = getNonMovableReason(second);
        if (reason) {
          figma.notify(`"${second.name}" ${reason} and cannot be set as the moving layer.`, { error: true });
          return;
        }
        if (isAncestor(second, first)) {
          figma.notify(`"${second.name}" contains "${first.name}" and cannot be set as the moving layer.`, { error: true });
          return;
        }
      }
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

    let newAbsX = firstRect.x;
    let newAbsY = firstRect.y;

    switch (msg.direction) {
      case "left":
        newAbsX = secondRect.x;
        break;
      case "right":
        newAbsX = secondRect.x + secondRect.width - firstRect.width;
        break;
      case "top":
        newAbsY = secondRect.y;
        break;
      case "bottom":
        newAbsY = secondRect.y + secondRect.height - firstRect.height;
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
      const moved = setAbsolutePosition(first, newAbsX, newAbsY);
      if (moved) figma.commitUndo();
      sendSelectionState();
    } catch (err) {
      figma.notify(`Cannot move "${first.name}".`, { error: true });
    }
  }

  if (msg.type === "apply-gap") {
    const pair = validateAndPrepareNodes();
    if (!pair) return;

    const { first, second } = pair;
    const gap = typeof msg.gap === "number" && !isNaN(msg.gap) ? msg.gap : 0;

    const firstRect = getAbsoluteBounds(first);
    const secondRect = getAbsoluteBounds(second);

    const firstCenterX = firstRect.x + firstRect.width / 2;
    const firstCenterY = firstRect.y + firstRect.height / 2;
    const secondCenterX = secondRect.x + secondRect.width / 2;
    const secondCenterY = secondRect.y + secondRect.height / 2;

    const childInsideTarget = isAncestor(second, first);

    let axis = msg.axis;
    if (axis === "auto") {
      if (childInsideTarget) {
        const distH = Math.min(
          Math.abs(firstRect.x - secondRect.x),
          Math.abs((secondRect.x + secondRect.width) - (firstRect.x + firstRect.width))
        );
        const distV = Math.min(
          Math.abs(firstRect.y - secondRect.y),
          Math.abs((secondRect.y + secondRect.height) - (firstRect.y + firstRect.height))
        );
        axis = distH <= distV ? "h" : "v";
      } else {
        const sepX = Math.max(
          firstRect.x - (secondRect.x + secondRect.width),
          secondRect.x - (firstRect.x + firstRect.width)
        );
        const sepY = Math.max(
          firstRect.y - (secondRect.y + secondRect.height),
          secondRect.y - (firstRect.y + firstRect.height)
        );
        if (sepX > 0 || sepY > 0) {
          axis = sepX >= sepY ? "h" : "v";
        } else {
          const dx = Math.abs(firstCenterX - secondCenterX);
          const dy = Math.abs(firstCenterY - secondCenterY);
          axis = dx >= dy ? "h" : "v";
        }
      }
    }

    let newAbsX = firstRect.x;
    let newAbsY = firstRect.y;

    if (childInsideTarget) {
      // 1st is inside 2nd: apply gap as inner padding from the nearest edge of 2nd
      if (axis === "h") {
        if (firstCenterX <= secondCenterX) {
          newAbsX = secondRect.x + gap;
        } else {
          newAbsX = secondRect.x + secondRect.width - firstRect.width - gap;
        }
      } else if (axis === "v") {
        if (firstCenterY <= secondCenterY) {
          newAbsY = secondRect.y + gap;
        } else {
          newAbsY = secondRect.y + secondRect.height - firstRect.height - gap;
        }
      }
    } else {
      // 1st and 2nd are separate layers: apply gap as outer spacing between them
      if (axis === "h") {
        if (firstCenterX < secondCenterX) {
          newAbsX = secondRect.x - firstRect.width - gap;
        } else {
          newAbsX = secondRect.x + secondRect.width + gap;
        }
      } else if (axis === "v") {
        if (firstCenterY < secondCenterY) {
          newAbsY = secondRect.y - firstRect.height - gap;
        } else {
          newAbsY = secondRect.y + secondRect.height + gap;
        }
      }
    }

    try {
      const moved = setAbsolutePosition(first, newAbsX, newAbsY);
      if (moved) figma.commitUndo();
      sendSelectionState();
    } catch (err) {
      figma.notify(`Cannot move "${first.name}".`, { error: true });
    }
  }

  if (msg.type === "close") {
    figma.closePlugin();
  }
};
