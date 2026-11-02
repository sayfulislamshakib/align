figma.showUI(__html__, { width: 280, height: 400, themeColors: true });

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

function isAncestor(ancestor, node) {
  let p = node.parent;
  while (p) {
    if (p.id === ancestor.id) return true;
    p = p.parent;
  }
  return false;
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

  if (isAncestor(first, second)) {
    figma.notify("1st layer contains the 2nd layer. Click \"Swap 1st & 2nd\" to move the inner layer.", { error: true });
    return null;
  }

  if (first.locked) {
    figma.notify(`"${first.name}" is locked. Unlock it to move.`, { error: true });
    return null;
  }

  if (!("x" in first) || !("y" in first) || !("width" in first) || !("width" in second)) {
    figma.notify("Selected layers do not support alignment.", { error: true });
    return null;
  }

  return { first, second, nodes };
}

function isInAutoLayoutFlow(node) {
  return Boolean(
    node.parent &&
    "layoutMode" in node.parent &&
    node.parent.layoutMode !== "NONE" &&
    (!("layoutPositioning" in node) || node.layoutPositioning !== "ABSOLUTE")
  );
}

function alignInAutoLayout(first, second, direction, gap) {
  const parent = first.parent;
  if (!parent || !("layoutMode" in parent)) return false;

  // Only adjust Auto Layout properties when aligning with its parent or a sibling in the same Auto Layout frame
  if (second.id !== parent.id && (!second.parent || second.parent.id !== parent.id)) {
    figma.notify(`"${first.name}" is inside an Auto Layout frame.`, { error: true });
    return true;
  }

  const isHorizontal = parent.layoutMode === "HORIZONTAL";

  switch (direction) {
    case "left":
      if (isHorizontal) {
        parent.primaryAxisAlignItems = "MIN";
      } else {
        parent.counterAxisAlignItems = "MIN";
      }
      if (gap > 0 && "paddingLeft" in parent) parent.paddingLeft = gap;
      break;
    case "right":
      if (isHorizontal) {
        parent.primaryAxisAlignItems = "MAX";
      } else {
        parent.counterAxisAlignItems = "MAX";
      }
      if (gap > 0 && "paddingRight" in parent) parent.paddingRight = gap;
      break;
    case "top":
      if (isHorizontal) {
        parent.counterAxisAlignItems = "MIN";
      } else {
        parent.primaryAxisAlignItems = "MIN";
      }
      if (gap > 0 && "paddingTop" in parent) parent.paddingTop = gap;
      break;
    case "bottom":
      if (isHorizontal) {
        parent.counterAxisAlignItems = "MAX";
      } else {
        parent.primaryAxisAlignItems = "MAX";
      }
      if (gap > 0 && "paddingBottom" in parent) parent.paddingBottom = gap;
      break;
    case "center-h":
      if (isHorizontal) {
        if (parent.primaryAxisAlignItems === "SPACE_BETWEEN") {
          parent.primaryAxisAlignItems = "CENTER";
        } else {
          parent.primaryAxisAlignItems = "CENTER";
        }
      } else {
        parent.counterAxisAlignItems = "CENTER";
      }
      break;
    case "center-v":
      if (isHorizontal) {
        parent.counterAxisAlignItems = "CENTER";
      } else {
        parent.primaryAxisAlignItems = "CENTER";
      }
      break;
    case "center":
      parent.primaryAxisAlignItems = "CENTER";
      parent.counterAxisAlignItems = "CENTER";
      break;
  }
  return true;
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
    const gap = typeof msg.gap === "number" && !isNaN(msg.gap) ? msg.gap : 0;

    if (isInAutoLayoutFlow(first)) {
      alignInAutoLayout(first, second, msg.direction, gap);
      sendSelectionState();
      return;
    }

    const firstRect = getAbsoluteBounds(first);
    const secondRect = getAbsoluteBounds(second);

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
      sendSelectionState();
    } catch (err) {
      figma.notify("Cannot move this layer (it may be inside a component instance).", { error: true });
    }
  }

  if (msg.type === "apply-gap") {
    const pair = validateAndPrepareNodes();
    if (!pair) return;

    const { first, second } = pair;
    const gap = typeof msg.gap === "number" && !isNaN(msg.gap) ? msg.gap : 0;

    if (isInAutoLayoutFlow(first)) {
      const parent = first.parent;
      if (parent && "itemSpacing" in parent && (second.id === parent.id || (second.parent && second.parent.id === parent.id))) {
        parent.itemSpacing = Math.max(0, gap);
      } else {
        figma.notify(`"${first.name}" is inside an Auto Layout frame.`, { error: true });
      }
      sendSelectionState();
      return;
    }

    const firstRect = getAbsoluteBounds(first);
    const secondRect = getAbsoluteBounds(second);

    const firstCenterX = firstRect.x + firstRect.width / 2;
    const firstCenterY = firstRect.y + firstRect.height / 2;
    const secondCenterX = secondRect.x + secondRect.width / 2;
    const secondCenterY = secondRect.y + secondRect.height / 2;

    let axis = msg.axis;
    if (axis === "auto") {
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

    let newAbsX = firstRect.x;
    let newAbsY = firstRect.y;

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

    try {
      setAbsolutePosition(first, newAbsX, newAbsY);
      sendSelectionState();
    } catch (err) {
      figma.notify("Cannot move this layer (it may be inside a component instance).", { error: true });
    }
  }

  if (msg.type === "close") {
    figma.closePlugin();
  }
};
