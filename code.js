figma.showUI(__html__, { width: 240, height: 112, themeColors: true });

// Track selection order because Figma's selection array does not always preserve click order.
let orderedSelectionIds = [];
// Mode when items have parent frames: "parent" (align each item to its parent frame) or "pair" (align 1st to 2nd)
let pairOverrideState = 0; // 0 = auto ("parent" if inside frame), 1 = 1st->2nd, 2 = 2nd->1st
let lastSelectionSignature = "";

// Safely verify that a node proxy (especially an instance sublayer or table cell) still exists
function isValidNode(node) {
  if (!node) return false;
  try {
    if (node.removed) return false;
    void node.name;
    void node.parent;
    return true;
  } catch (err) {
    return false;
  }
}

function getValidSelection() {
  try {
    const raw = figma.currentPage.selection;
    const valid = [];
    for (let i = 0; i < raw.length; i++) {
      if (isValidNode(raw[i])) {
        valid.push(raw[i]);
      }
    }
    return valid;
  } catch (err) {
    return [];
  }
}

function isAncestor(ancestor, node) {
  if (!isValidNode(ancestor) || !isValidNode(node)) return false;
  try {
    let p = node.parent;
    while (p) {
      if (p.id === ancestor.id) return true;
      p = p.parent;
    }
  } catch (err) {
    return false;
  }
  return false;
}

function isLockedOrHasLockedAncestor(node) {
  try {
    let curr = node;
    while (curr && curr.type !== "PAGE" && curr.type !== "DOCUMENT") {
      if ("locked" in curr && curr.locked) return true;
      curr = curr.parent;
    }
  } catch (err) {
    return false;
  }
  return false;
}

function isReadOnlyInstanceSublayer(node) {
  try {
    if (!node || typeof node.id !== "string" || !node.id.startsWith("I")) {
      return false;
    }
    let p = node.parent;
    while (p && p.type !== "PAGE" && p.type !== "DOCUMENT") {
      if (p.type === "SLOT") return false;
      if (p.type === "INSTANCE") return true;
      p = p.parent;
    }
  } catch (err) {
    return false;
  }
  return false;
}

function isInAutoLayoutFlow(node) {
  try {
    return Boolean(
      node.parent &&
      "layoutMode" in node.parent &&
      node.parent.layoutMode !== "NONE" &&
      (!("layoutPositioning" in node) || node.layoutPositioning !== "ABSOLUTE")
    );
  } catch (err) {
    return false;
  }
}

function getNonMovableReason(node, checkInstanceSublayer = true) {
  if (!isValidNode(node)) {
    return "no longer exists";
  }
  try {
    if (!("x" in node) || !("y" in node) || !("width" in node)) {
      return "does not support positioning";
    }
    if (isLockedOrHasLockedAncestor(node)) {
      return "is locked";
    }
    if (isInAutoLayoutFlow(node)) {
      return "is inside an Auto Layout frame";
    }
    if (checkInstanceSublayer && isReadOnlyInstanceSublayer(node)) {
      return "is a fixed layer inside a component instance";
    }
    return null;
  } catch (err) {
    return "cannot be modified";
  }
}

function isMovableNode(node) {
  return getNonMovableReason(node) === null;
}

// Find the nearest parent frame/container (excluding PAGE, DOCUMENT, GROUP, BOOLEAN_OPERATION)
function getParentFrame(node) {
  if (!isValidNode(node)) return null;
  try {
    let p = node.parent;
    while (p && (p.type === "GROUP" || p.type === "BOOLEAN_OPERATION")) {
      p = p.parent;
    }
    if (!p || p.type === "PAGE" || p.type === "DOCUMENT") {
      return null;
    }
    if ("width" in p && "height" in p) {
      return p;
    }
    return null;
  } catch (err) {
    return null;
  }
}

// Filter out selected nodes that are ancestors of other selected nodes
function getLeafSelectedNodes(nodes) {
  return nodes.filter(
    (n) => !nodes.some((other) => other.id !== n.id && isAncestor(n, other))
  );
}

// Returns [{ node, parentFrame }] if the selection should align each item to its parent frame
function getParentAlignmentPairs(nodes) {
  if (nodes.length === 0) return null;

  // If 2 nodes are selected and one is the ancestor of the other, that is already child -> parent
  const leafNodes = getLeafSelectedNodes(nodes);
  if (leafNodes.length === 0) return null;

  const pairs = [];
  for (let i = 0; i < leafNodes.length; i++) {
    const parentFrame = getParentFrame(leafNodes[i]);
    if (!parentFrame) {
      return null;
    }
    pairs.push({ node: leafNodes[i], parentFrame });
  }
  return pairs;
}

function ensureMovableFirst(validSelection) {
  if (orderedSelectionIds.length < 2) return;
  const map = new Map(validSelection.map((n) => [n.id, n]));
  const first = map.get(orderedSelectionIds[0]);
  const second = map.get(orderedSelectionIds[1]);
  if (!first || !second) return;

  const firstCanMove = isMovableNode(first) && !isAncestor(first, second);
  const secondCanMove = isMovableNode(second) && !isAncestor(second, first);

  if (!firstCanMove && secondCanMove) {
    orderedSelectionIds[0] = second.id;
    orderedSelectionIds[1] = first.id;
  }
}

function syncSelectionOrder(notifyUI = true) {
  const currentSelection = getValidSelection();
  const currentIds = new Set(currentSelection.map((n) => n.id));

  orderedSelectionIds = orderedSelectionIds.filter((id) => currentIds.has(id));

  for (const node of currentSelection) {
    if (!orderedSelectionIds.includes(node.id)) {
      orderedSelectionIds.push(node.id);
    }
  }

  const sig = [...currentIds].sort().join(",");
  if (sig !== lastSelectionSignature) {
    lastSelectionSignature = sig;
    pairOverrideState = 0;
  }

  if (pairOverrideState === 0) {
    ensureMovableFirst(currentSelection);
  }

  if (notifyUI) {
    sendSelectionState();
  }
}

function getOrderedNodes() {
  syncSelectionOrder(false);
  const currentSelection = getValidSelection();
  const map = new Map(currentSelection.map((n) => [n.id, n]));
  return orderedSelectionIds.map((id) => map.get(id)).filter(Boolean);
}

function getAbsoluteBounds(node) {
  try {
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
  } catch (err) {
    return null;
  }
}

function cleanNum(v) {
  return Math.round(v * 1000) / 1000;
}

function computeCurrentGapInfo(first, second) {
  if (!isValidNode(first) || !isValidNode(second)) return null;
  try {
    if (!("width" in first) || !("width" in second)) return null;
    const r1 = getAbsoluteBounds(first);
    const r2 = getAbsoluteBounds(second);
    if (!r1 || !r2) return null;

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
  } catch (err) {
    return null;
  }
}

function safeNodeSummary(node) {
  if (!isValidNode(node)) return null;
  try {
    return { id: node.id, name: node.name, type: node.type };
  } catch (err) {
    return null;
  }
}

function shouldUseParentMode(nodes, parentPairs) {
  if (!parentPairs || parentPairs.length === 0) return false;
  // When 1 item inside a frame or 3+ items inside frame(s) are selected, always use parent mode
  if (nodes.length === 1 || nodes.length > 2) return true;
  // When 2 items inside frame(s) are selected: use parent mode unless the user toggled to pair mode via Swap
  if (pairOverrideState !== 0) return false;
  return true;
}

function sendSelectionState() {
  const nodes = getOrderedNodes();
  const parentPairs = getParentAlignmentPairs(nodes);
  const useParentMode = shouldUseParentMode(nodes, parentPairs);

  if (useParentMode && parentPairs) {
    const movingNames = parentPairs.map((p) => p.node.name);
    const uniqueParents = [];
    const seenParentIds = new Set();
    for (let i = 0; i < parentPairs.length; i++) {
      const pf = parentPairs[i].parentFrame;
      if (!seenParentIds.has(pf.id)) {
        seenParentIds.add(pf.id);
        uniqueParents.push(pf);
      }
    }

    const firstLabel =
      parentPairs.length === 1
        ? parentPairs[0].node.name
        : `${parentPairs.length} items (${movingNames.join(", ")})`;

    const secondLabel =
      uniqueParents.length === 1
        ? `${uniqueParents[0].name} (Parent)`
        : `Each Parent (${uniqueParents.length})`;

    const canSwapToPair =
      nodes.length === 2 &&
      !isAncestor(nodes[0], nodes[1]) &&
      !isAncestor(nodes[1], nodes[0]);

    figma.ui.postMessage({
      type: "selection-updated",
      mode: "parent",
      count: parentPairs.length,
      first: { id: "multi-children", name: firstLabel, type: "GROUP" },
      second: { id: "multi-parents", name: secondLabel, type: "FRAME" },
      canSwap: canSwapToPair,
      gapInfo: computeCurrentGapInfo(parentPairs[0].node, parentPairs[0].parentFrame),
    });
    return;
  }

  const first = nodes[0] || null;
  const second = nodes[1] || null;
  const firstSummary = safeNodeSummary(first);
  const secondSummary = safeNodeSummary(second);

  const canSwap = Boolean(
    firstSummary &&
    secondSummary &&
    ((isMovableNode(second) && !isAncestor(second, first)) || Boolean(parentPairs))
  );

  figma.ui.postMessage({
    type: "selection-updated",
    mode: "pair",
    count: nodes.length,
    first: firstSummary,
    second: secondSummary,
    canSwap,
    gapInfo: firstSummary && secondSummary ? computeCurrentGapInfo(first, second) : null,
  });
}

// Initialize on launch
syncSelectionOrder(true);

figma.on("selectionchange", () => {
  syncSelectionOrder(true);
});

figma.on("currentpagechange", () => {
  orderedSelectionIds = [];
  pairOverrideState = 0;
  lastSelectionSignature = "";
  syncSelectionOrder(true);
});

// Find the nearest ancestor that defines a local coordinate system for node.x / node.y
function getCoordinateParent(node) {
  try {
    let p = node.parent;
    while (p && (p.type === "GROUP" || p.type === "BOOLEAN_OPERATION")) {
      p = p.parent;
    }
    return p;
  } catch (err) {
    return null;
  }
}

function setAbsolutePosition(node, targetAbsX, targetAbsY) {
  const currentAbs = getAbsoluteBounds(node);
  if (!currentAbs) return false;

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

function alignSingleNodeToTarget(first, second, direction) {
  const firstRect = getAbsoluteBounds(first);
  const secondRect = getAbsoluteBounds(second);
  if (!firstRect || !secondRect) return false;

  let newAbsX = firstRect.x;
  let newAbsY = firstRect.y;

  switch (direction) {
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
      return false;
  }

  return setAbsolutePosition(first, newAbsX, newAbsY);
}

function applyGapSingleNodeToTarget(first, second, rawAxis, gap) {
  const firstRect = getAbsoluteBounds(first);
  const secondRect = getAbsoluteBounds(second);
  if (!firstRect || !secondRect) return false;

  const firstCenterX = firstRect.x + firstRect.width / 2;
  const firstCenterY = firstRect.y + firstRect.height / 2;
  const secondCenterX = secondRect.x + secondRect.width / 2;
  const secondCenterY = secondRect.y + secondRect.height / 2;

  const childInsideTarget = isAncestor(second, first);

  let axis = rawAxis;
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

  return setAbsolutePosition(first, newAbsX, newAbsY);
}

function validateAndPreparePairNodes(nodes) {
  if (nodes.length < 2) {
    figma.notify("Please select at least 2 frames or layers.", { error: true });
    return null;
  }

  const first = nodes[0];
  const second = nodes[1];

  if (!isValidNode(first) || !isValidNode(second)) {
    syncSelectionOrder(true);
    return null;
  }

  if (isAncestor(first, second)) {
    figma.notify("1st layer contains the 2nd layer. Click \"Swap\" to move the inner layer.", { error: true });
    return null;
  }

  const reason = getNonMovableReason(first, false);
  if (reason) {
    figma.notify(`Cannot move "${first.name}" because it ${reason}.`, { error: true });
    return null;
  }

  if (!("width" in second) || !("height" in second)) {
    figma.notify("Selected target layer does not support alignment.", { error: true });
    return null;
  }

  return { first, second };
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
    const nodes = getOrderedNodes();
    const parentPairs = getParentAlignmentPairs(nodes);

    // If 2 items inside frame(s) are selected, cycle: Parent Mode (0) -> 1st to 2nd (1) -> 2nd to 1st (2) -> Parent Mode (0)
    if (
      nodes.length === 2 &&
      parentPairs &&
      !isAncestor(nodes[0], nodes[1]) &&
      !isAncestor(nodes[1], nodes[0])
    ) {
      if (pairOverrideState === 0) {
        pairOverrideState = 1;
        ensureMovableFirst(nodes);
        sendSelectionState();
        return;
      } else if (pairOverrideState === 1) {
        const second = nodes[1];
        const reason = getNonMovableReason(second);
        if (!reason && !isAncestor(second, nodes[0])) {
          const temp = orderedSelectionIds[0];
          orderedSelectionIds[0] = orderedSelectionIds[1];
          orderedSelectionIds[1] = temp;
          pairOverrideState = 2;
          sendSelectionState();
          return;
        } else {
          pairOverrideState = 0;
          sendSelectionState();
          return;
        }
      } else {
        // Swap back original order and return to parent mode
        const temp = orderedSelectionIds[0];
        orderedSelectionIds[0] = orderedSelectionIds[1];
        orderedSelectionIds[1] = temp;
        pairOverrideState = 0;
        ensureMovableFirst(nodes);
        sendSelectionState();
        return;
      }
    }

    if (orderedSelectionIds.length >= 2) {
      const validSelection = getValidSelection();
      const map = new Map(validSelection.map((n) => [n.id, n]));
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
    const nodes = getOrderedNodes();
    const parentPairs = getParentAlignmentPairs(nodes);

    if (shouldUseParentMode(nodes, parentPairs) && parentPairs) {
      let anyMoved = false;
      let blockedReason = null;
      let blockedName = "";

      for (let i = 0; i < parentPairs.length; i++) {
        const { node, parentFrame } = parentPairs[i];
        const reason = getNonMovableReason(node, false);
        if (reason) {
          blockedReason = reason;
          blockedName = node.name;
          continue;
        }
        try {
          if (alignSingleNodeToTarget(node, parentFrame, msg.direction)) {
            anyMoved = true;
          }
        } catch (err) {
          blockedReason = "cannot be moved";
          blockedName = node.name;
        }
      }

      if (anyMoved) {
        figma.commitUndo();
      } else if (blockedReason) {
        figma.notify(`Cannot move "${blockedName}" because it ${blockedReason}.`, { error: true });
      }
      sendSelectionState();
      return;
    }

    const pair = validateAndPreparePairNodes(nodes);
    if (!pair) return;

    try {
      const moved = alignSingleNodeToTarget(pair.first, pair.second, msg.direction);
      if (moved) figma.commitUndo();
      sendSelectionState();
    } catch (err) {
      figma.notify(`Cannot move "${pair.first.name}".`, { error: true });
    }
  }

  if (msg.type === "apply-gap") {
    const nodes = getOrderedNodes();
    const parentPairs = getParentAlignmentPairs(nodes);
    const gap = typeof msg.gap === "number" && !isNaN(msg.gap) ? msg.gap : 0;

    if (shouldUseParentMode(nodes, parentPairs) && parentPairs) {
      let anyMoved = false;
      let blockedReason = null;
      let blockedName = "";

      for (let i = 0; i < parentPairs.length; i++) {
        const { node, parentFrame } = parentPairs[i];
        const reason = getNonMovableReason(node, false);
        if (reason) {
          blockedReason = reason;
          blockedName = node.name;
          continue;
        }
        try {
          if (applyGapSingleNodeToTarget(node, parentFrame, msg.axis, gap)) {
            anyMoved = true;
          }
        } catch (err) {
          blockedReason = "cannot be moved";
          blockedName = node.name;
        }
      }

      if (anyMoved) {
        figma.commitUndo();
      } else if (blockedReason) {
        figma.notify(`Cannot move "${blockedName}" because it ${blockedReason}.`, { error: true });
      }
      sendSelectionState();
      return;
    }

    const pair = validateAndPreparePairNodes(nodes);
    if (!pair) return;

    try {
      const moved = applyGapSingleNodeToTarget(pair.first, pair.second, msg.axis, gap);
      if (moved) figma.commitUndo();
      sendSelectionState();
    } catch (err) {
      figma.notify(`Cannot move "${pair.first.name}".`, { error: true });
    }
  }

  if (msg.type === "close") {
    figma.closePlugin();
  }
};
