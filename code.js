const UI_WIDTH = 176;
figma.showUI(__html__, { width: UI_WIDTH, height: 158, themeColors: true });

let orderedSelectionIds = [];
let pairOverrideState = 0; // 0 = auto ("parent" if inside frame), 1 = 1st->2nd, 2 = 2nd->1st
let lastSelectionSignature = "";

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
    return figma.currentPage.selection.filter(isValidNode);
  } catch (err) {
    return [];
  }
}

function isAncestor(ancestor, node) {
  if (!isValidNode(ancestor) || !isValidNode(node)) return false;
  try {
    for (let p = node.parent; p; p = p.parent) {
      if (p.id === ancestor.id) return true;
    }
  } catch (err) {}
  return false;
}

// Nearest ancestor that defines local coordinates (skips GROUP and BOOLEAN_OPERATION)
function getCoordinateParent(node) {
  if (!isValidNode(node)) return null;
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

function getParentFrame(node) {
  const p = getCoordinateParent(node);
  if (!p || p.type === "PAGE" || p.type === "DOCUMENT") return null;
  return "width" in p && "height" in p ? p : null;
}

function getNonMovableReason(node, checkInstanceSublayer = true) {
  if (!isValidNode(node)) return "no longer exists";
  try {
    if (!("x" in node) || !("y" in node) || !("width" in node)) {
      return "does not support positioning";
    }
    for (let c = node; c && c.type !== "PAGE" && c.type !== "DOCUMENT"; c = c.parent) {
      if ("locked" in c && c.locked) return "is locked";
    }
    if (
      node.parent &&
      "layoutMode" in node.parent &&
      node.parent.layoutMode !== "NONE" &&
      (!("layoutPositioning" in node) || node.layoutPositioning !== "ABSOLUTE")
    ) {
      return "is inside an Auto Layout frame";
    }
    if (checkInstanceSublayer && typeof node.id === "string" && node.id.startsWith("I")) {
      for (let p = node.parent; p && p.type !== "PAGE" && p.type !== "DOCUMENT"; p = p.parent) {
        if (p.type === "SLOT") break;
        if (p.type === "INSTANCE") return "is a fixed layer inside a component instance";
      }
    }
    return null;
  } catch (err) {
    return "cannot be modified";
  }
}

function isMovableNode(node) {
  return getNonMovableReason(node) === null;
}

function getParentAlignmentPairs(nodes) {
  if (!nodes.length) return null;
  const leafNodes = nodes.filter(
    (n) => !nodes.some((other) => other.id !== n.id && isAncestor(n, other))
  );
  if (!leafNodes.length) return null;

  const pairs = [];
  for (const node of leafNodes) {
    const parentFrame = getParentFrame(node);
    if (!parentFrame) return null;
    pairs.push({ node, parentFrame });
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
  if (notifyUI) sendSelectionState();
}

function getOrderedNodes() {
  syncSelectionOrder(false);
  const map = new Map(getValidSelection().map((n) => [n.id, n]));
  return orderedSelectionIds.map((id) => map.get(id)).filter(Boolean);
}

function getAbsoluteBounds(node) {
  try {
    if (node.absoluteBoundingBox) {
      const b = node.absoluteBoundingBox;
      return { x: b.x, y: b.y, width: b.width, height: b.height };
    }
    const t = node.absoluteTransform;
    return { x: t[0][2], y: t[1][2], width: node.width, height: node.height };
  } catch (err) {
    return null;
  }
}

function getGroupBounds(nodes) {
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  for (const n of nodes) {
    const r = getAbsoluteBounds(n);
    if (!r) continue;
    if (r.x < minX) minX = r.x;
    if (r.y < minY) minY = r.y;
    if (r.x + r.width > maxX) maxX = r.x + r.width;
    if (r.y + r.height > maxY) maxY = r.y + r.height;
  }
  if (!isFinite(minX)) return null;
  return { x: minX, y: minY, width: maxX - minX, height: maxY - minY };
}

function cleanNum(v) {
  return Math.round(v * 1000) / 1000;
}

function computeCurrentGapInfo(first, second) {
  if (!isValidNode(first) || !isValidNode(second)) return null;
  const r1 = getAbsoluteBounds(first);
  const r2 = getAbsoluteBounds(second);
  if (!r1 || !r2) return null;

  if (isAncestor(second, first)) {
    return {
      h: Math.min(cleanNum(r1.x - r2.x), cleanNum(r2.x + r2.width - (r1.x + r1.width))),
      v: Math.min(cleanNum(r1.y - r2.y), cleanNum(r2.y + r2.height - (r1.y + r1.height))),
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

function detectActiveSpot(first, second) {
  const r1 = getAbsoluteBounds(first);
  const r2 = getAbsoluteBounds(second);
  if (!r1 || !r2) return "center";

  const tol = 1.5;
  const c1x = r1.x + r1.width / 2;
  const c2x = r2.x + r2.width / 2;
  const c1y = r1.y + r1.height / 2;
  const c2y = r2.y + r2.height / 2;

  const h =
    Math.abs(r1.x - r2.x) <= tol
      ? "left"
      : Math.abs(r1.x + r1.width - (r2.x + r2.width)) <= tol
        ? "right"
        : Math.abs(c1x - c2x) <= tol
          ? "center"
          : c1x < c2x - r2.width * 0.15
            ? "left"
            : c1x > c2x + r2.width * 0.15
              ? "right"
              : "center";

  const v =
    Math.abs(r1.y - r2.y) <= tol
      ? "top"
      : Math.abs(r1.y + r1.height - (r2.y + r2.height)) <= tol
        ? "bottom"
        : Math.abs(c1y - c2y) <= tol
          ? "center"
          : c1y < c2y - r2.height * 0.15
            ? "top"
            : c1y > c2y + r2.height * 0.15
              ? "bottom"
              : "center";

  return v === "center" && h === "center" ? "center" : `${v}-${h}`;
}

function shouldUseParentMode(nodes, parentPairs) {
  if (!parentPairs || !parentPairs.length) return false;
  if (nodes.length === 1 || nodes.length > 2) return true;
  return pairOverrideState === 0;
}

function sendSelectionState() {
  const nodes = getOrderedNodes();
  const parentPairs = getParentAlignmentPairs(nodes);

  if (shouldUseParentMode(nodes, parentPairs)) {
    const uniqueParentIds = new Set(parentPairs.map((p) => p.parentFrame.id));
    const firstLabel =
      parentPairs.length === 1 ? parentPairs[0].node.name : `${parentPairs.length} items`;
    const secondLabel =
      uniqueParentIds.size === 1
        ? parentPairs[0].parentFrame.name
        : `Each (${uniqueParentIds.size})`;
    const canSwapToPair =
      nodes.length === 2 &&
      !isAncestor(nodes[0], nodes[1]) &&
      !isAncestor(nodes[1], nodes[0]);

    figma.ui.postMessage({
      type: "selection-updated",
      mode: "parent",
      count: parentPairs.length,
      first: { id: "multi-children", name: firstLabel },
      second: { id: "multi-parents", name: secondLabel },
      canSwap: canSwapToPair,
      activeSpot: detectActiveSpot(parentPairs[0].node, parentPairs[0].parentFrame),
      gapInfo: computeCurrentGapInfo(parentPairs[0].node, parentPairs[0].parentFrame),
    });
    return;
  }

  const first = nodes[0] || null;
  const second = nodes[1] || null;
  const firstSummary = isValidNode(first)
    ? {
        id: first.id,
        name: nodes.length > 2 ? `${nodes.length - 1} items` : first.name,
      }
    : null;
  const secondSummary = isValidNode(second) ? { id: second.id, name: second.name } : null;
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
    activeSpot: firstSummary && secondSummary ? detectActiveSpot(first, second) : "center",
    gapInfo: firstSummary && secondSummary ? computeCurrentGapInfo(first, second) : null,
  });
}

function setAbsolutePosition(node, targetAbsX, targetAbsY) {
  const currentAbs = getAbsoluteBounds(node);
  if (!currentAbs) return false;

  const deltaAbsX = targetAbsX - currentAbs.x;
  const deltaAbsY = targetAbsY - currentAbs.y;
  if (Math.abs(deltaAbsX) < 1e-6 && Math.abs(deltaAbsY) < 1e-6) return false;

  let localDx = deltaAbsX;
  let localDy = deltaAbsY;

  const coordParent = getCoordinateParent(node);
  if (coordParent && "absoluteTransform" in coordParent) {
    const m = coordParent.absoluteTransform;
    const det = m[0][0] * m[1][1] - m[0][1] * m[1][0];
    if (Math.abs(det) > 1e-8) {
      localDx = (m[1][1] * deltaAbsX - m[0][1] * deltaAbsY) / det;
      localDy = (-m[1][0] * deltaAbsX + m[0][0] * deltaAbsY) / det;
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

function computeAlignedPosition(r1, r2, dir) {
  let x = r1.x;
  let y = r1.y;

  if (dir.includes("left")) x = r2.x;
  else if (dir.includes("right")) x = r2.x + r2.width - r1.width;
  else if (dir === "center" || dir === "center-h" || dir.endsWith("-center")) {
    x = r2.x + (r2.width - r1.width) / 2;
  }

  if (dir.includes("top")) y = r2.y;
  else if (dir.includes("bottom")) y = r2.y + r2.height - r1.height;
  else if (dir === "center" || dir === "center-v" || dir.startsWith("center-")) {
    y = r2.y + (r2.height - r1.height) / 2;
  }

  return { x, y };
}

function computeGapPosition(r1, r2, inside, rawAxis, gap) {
  const c1x = r1.x + r1.width / 2;
  const c1y = r1.y + r1.height / 2;
  const c2x = r2.x + r2.width / 2;
  const c2y = r2.y + r2.height / 2;

  let axis = rawAxis;
  if (axis === "auto") {
    if (inside) {
      const distH = Math.min(Math.abs(r1.x - r2.x), Math.abs(r2.x + r2.width - (r1.x + r1.width)));
      const distV = Math.min(Math.abs(r1.y - r2.y), Math.abs(r2.y + r2.height - (r1.y + r1.height)));
      axis = distH <= distV ? "h" : "v";
    } else {
      const sepX = Math.max(r1.x - (r2.x + r2.width), r2.x - (r1.x + r1.width));
      const sepY = Math.max(r1.y - (r2.y + r2.height), r2.y - (r1.y + r1.height));
      axis =
        sepX > 0 || sepY > 0
          ? sepX >= sepY
            ? "h"
            : "v"
          : Math.abs(c1x - c2x) >= Math.abs(c1y - c2y)
            ? "h"
            : "v";
    }
  }

  let x = r1.x;
  let y = r1.y;

  if (inside) {
    if (axis === "h") x = c1x <= c2x ? r2.x + gap : r2.x + r2.width - r1.width - gap;
    else if (axis === "v") y = c1y <= c2y ? r2.y + gap : r2.y + r2.height - r1.height - gap;
  } else {
    if (axis === "h") x = c1x < c2x ? r2.x - r1.width - gap : r2.x + r2.width + gap;
    else if (axis === "v") y = c1y < c2y ? r2.y - r1.height - gap : r2.y + r2.height + gap;
  }

  return { x, y };
}

function moveNodesAsGroup(movingNodes, targetNode, inside, calcTargetPos) {
  const groupRect = getGroupBounds(movingNodes);
  const targetRect = getAbsoluteBounds(targetNode);
  if (!groupRect || !targetRect) return false;

  const targetPos = calcTargetPos(groupRect, targetRect, inside);
  const deltaX = targetPos.x - groupRect.x;
  const deltaY = targetPos.y - groupRect.y;

  let anyMoved = false;
  for (const node of movingNodes) {
    const r = getAbsoluteBounds(node);
    if (r && setAbsolutePosition(node, r.x + deltaX, r.y + deltaY)) {
      anyMoved = true;
    }
  }
  return anyMoved;
}

function executeAction(groupMode, calcTargetPos) {
  const nodes = getOrderedNodes();
  const parentPairs = getParentAlignmentPairs(nodes);

  // Parent Mode (or Alt/Option Group Mode when items are inside parent frames)
  if ((shouldUseParentMode(nodes, parentPairs) || (groupMode && parentPairs && parentPairs.length >= 2)) && parentPairs) {
    let anyMoved = false;
    let blockedReason = null;
    let blockedName = "";

    if (groupMode && parentPairs.length > 1) {
      // Group movable nodes by their parentFrame so items in each parent frame move together as a group
      const byParent = new Map();
      for (const { node, parentFrame } of parentPairs) {
        const reason = getNonMovableReason(node, false);
        if (reason) {
          blockedReason = reason;
          blockedName = node.name;
          continue;
        }
        if (!byParent.has(parentFrame.id)) {
          byParent.set(parentFrame.id, { parentFrame, items: [] });
        }
        byParent.get(parentFrame.id).items.push(node);
      }

      for (const { parentFrame, items } of byParent.values()) {
        try {
          if (moveNodesAsGroup(items, parentFrame, true, calcTargetPos)) {
            anyMoved = true;
          }
        } catch (err) {
          blockedReason = "cannot be moved";
          blockedName = items[0] ? items[0].name : "";
        }
      }
    } else {
      for (const { node, parentFrame } of parentPairs) {
        const reason = getNonMovableReason(node, false);
        if (reason) {
          blockedReason = reason;
          blockedName = node.name;
          continue;
        }
        try {
          const r1 = getAbsoluteBounds(node);
          const r2 = getAbsoluteBounds(parentFrame);
          if (r1 && r2) {
            const pos = calcTargetPos(r1, r2, true);
            if (setAbsolutePosition(node, pos.x, pos.y)) anyMoved = true;
          }
        } catch (err) {
          blockedReason = "cannot be moved";
          blockedName = node.name;
        }
      }
    }

    if (anyMoved) figma.commitUndo();
    else if (blockedReason) {
      figma.notify(`Cannot move "${blockedName}" because it ${blockedReason}.`, { error: true });
    }
    sendSelectionState();
    return;
  }

  if (nodes.length < 2) {
    figma.notify("Please select at least 2 frames or layers.", { error: true });
    return;
  }

  const target = nodes[1];
  const movingCandidates = nodes.filter((n, idx) => idx !== 1);

  if (!isValidNode(target) || !("width" in target) || !("height" in target)) {
    figma.notify("Selected target layer does not support alignment.", { error: true });
    return;
  }

  const movableItems = [];
  let blockedReason = null;
  let blockedName = "";

  for (const item of movingCandidates) {
    if (!isValidNode(item)) continue;
    if (isAncestor(item, target)) {
      figma.notify("Moving layer contains the target layer. Click \"Swap\" to move the inner layer.", { error: true });
      return;
    }
    const reason = getNonMovableReason(item, false);
    if (reason) {
      blockedReason = reason;
      blockedName = item.name;
      continue;
    }
    movableItems.push(item);
  }

  if (!movableItems.length) {
    if (blockedReason) {
      figma.notify(`Cannot move "${blockedName}" because it ${blockedReason}.`, { error: true });
    }
    return;
  }

  try {
    let anyMoved = false;
    const inside = isAncestor(target, movableItems[0]);

    if (groupMode && movableItems.length > 1) {
      anyMoved = moveNodesAsGroup(movableItems, target, inside, calcTargetPos);
    } else {
      const r2 = getAbsoluteBounds(target);
      if (r2) {
        for (const item of movableItems) {
          const r1 = getAbsoluteBounds(item);
          if (r1) {
            const pos = calcTargetPos(r1, r2, isAncestor(target, item));
            if (setAbsolutePosition(item, pos.x, pos.y)) anyMoved = true;
          }
        }
      }
    }

    if (anyMoved) figma.commitUndo();
    sendSelectionState();
  } catch (err) {
    figma.notify(`Cannot move "${movableItems[0].name}".`, { error: true });
  }
}

syncSelectionOrder(true);
figma.on("selectionchange", () => syncSelectionOrder(true));
figma.on("currentpagechange", () => {
  orderedSelectionIds = [];
  pairOverrideState = 0;
  lastSelectionSignature = "";
  syncSelectionOrder(true);
});

figma.ui.onmessage = (msg) => {
  if (!msg || !msg.type) return;

  if (msg.type === "resize" && typeof msg.height === "number") {
    figma.ui.resize(UI_WIDTH, Math.max(80, Math.round(msg.height)));
    return;
  }

  if (msg.type === "ui-ready") {
    syncSelectionOrder(true);
    return;
  }

  if (msg.type === "swap-order") {
    const nodes = getOrderedNodes();
    const parentPairs = getParentAlignmentPairs(nodes);

    if (
      nodes.length === 2 &&
      parentPairs &&
      !isAncestor(nodes[0], nodes[1]) &&
      !isAncestor(nodes[1], nodes[0])
    ) {
      if (pairOverrideState === 0) {
        pairOverrideState = 1;
        ensureMovableFirst(nodes);
      } else if (pairOverrideState === 1 && !getNonMovableReason(nodes[1]) && !isAncestor(nodes[1], nodes[0])) {
        [orderedSelectionIds[0], orderedSelectionIds[1]] = [orderedSelectionIds[1], orderedSelectionIds[0]];
        pairOverrideState = 2;
      } else {
        if (pairOverrideState === 2) {
          [orderedSelectionIds[0], orderedSelectionIds[1]] = [orderedSelectionIds[1], orderedSelectionIds[0]];
        }
        pairOverrideState = 0;
        ensureMovableFirst(nodes);
      }
      sendSelectionState();
      return;
    }

    if (nodes.length >= 2) {
      const [first, second] = nodes;
      const reason = getNonMovableReason(second);
      if (reason) {
        figma.notify(`"${second.name}" ${reason} and cannot be set as the moving layer.`, { error: true });
        return;
      }
      if (isAncestor(second, first)) {
        figma.notify(`"${second.name}" contains "${first.name}" and cannot be set as the moving layer.`, { error: true });
        return;
      }
      [orderedSelectionIds[0], orderedSelectionIds[1]] = [orderedSelectionIds[1], orderedSelectionIds[0]];
      sendSelectionState();
    }
    return;
  }

  if (msg.type === "align") {
    executeAction(Boolean(msg.group), (r1, r2) => computeAlignedPosition(r1, r2, msg.direction));
  } else if (msg.type === "apply-gap") {
    const gap = typeof msg.gap === "number" && !isNaN(msg.gap) ? msg.gap : 0;
    executeAction(Boolean(msg.group), (r1, r2, inside) => computeGapPosition(r1, r2, inside, msg.axis, gap));
  }
};
