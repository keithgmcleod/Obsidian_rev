const viewer = document.querySelector("#obsidian-model");
const stage = document.querySelector(".viewer-stage");
const progressFill = document.querySelector(".progress-fill");
const loadState = document.querySelector(".load-state");
const placeholder = document.querySelector("#model-placeholder");
const placeholderName = document.querySelector("#placeholder-name");
const title = document.querySelector("#page-title");
const intro = document.querySelector("#card-intro");
const detailsCopy = document.querySelector("#details-copy");
const selectorButtons = [...document.querySelectorAll("[data-card]")];

const cards = {
  blue: {
    name: "BILT Blue",
    title: "BILT BLUE",
    intro: "Precision, made tangible.<br />A closer look at every edge.",
    details: "The BILT Blue card is presented as a high-detail 3D model, composed for the web.",
    source: "./bilt-blue-2k.glb?v=blue-hologram-obsidian-part",
    specs: { format: "GLB 2.0", parts: "3 objects", geometry: "1,295,072 triangles", download: "47.8 MB" },
  },
  obsidian: {
    name: "BILT Obsidian",
    title: "BILT OBSIDIAN",
    intro: "Precision, made tangible.<br />A closer look at every edge.",
    details: "The BILT Obsidian card is presented as a high-detail 3D model, composed for the web.",
    source: "./obsidian-2k.glb?v=obsidian-roughness-plus50",
    specs: { format: "GLB 2.0", parts: "6 objects", geometry: "948,664 triangles", download: "43.8 MB" },
  },
  palladium: {
    name: "BILT Palladium",
    title: "BILT PALLADIUM",
    intro: "A polished expression of precision and light.",
    details: "Explore the BILT Palladium card as a high-detail 3D model, baked for the web.",
    source: "./palladium-2k.glb?v=palladium-edge-bump-removed-20261018",
    specs: { format: "GLB 2.0", parts: "6 objects", geometry: "3,783,112 triangles", download: "23.1 MB" },
  },
};

const frontTilt = { yaw: 15, pitch: 15 };
const baseOrientation = { roll: 0, pitch: -15, yaw: -15 };
const baseCameraOrbit = { theta: 0, phi: 82, radius: "110%" };
let pointer = { x: 0, y: 0 };
let currentPointer = { x: 0, y: 0 };
let frame = 0;
let activeOrientation = { ...baseOrientation };
let reflectionFrame = 0;
let selectedCard = "obsidian";
let showingBack = false;
let sideYaw = 0;
let blueMetalnessAdjustedModel = null;

function selectCard(cardId, updateAddress = true) {
  const previousSource = viewer.getAttribute('src');
  const card = cards[cardId] ? cards[cardId] : cards.obsidian;
  selectedCard = cards[cardId] ? cardId : "obsidian";
  showingBack = false;
  sideYaw = 0;
  setPhysicalCardPose();
  viewer.setAttribute("aria-pressed", "false");
  viewer.setAttribute("aria-label", `${card.name} card, front side. Activate to view the back.`);

  selectorButtons.forEach((button) => {
    const selected = button.dataset.card === selectedCard;
    button.setAttribute("aria-pressed", String(selected));
  });

  title.innerHTML = card.title + '<span class="period">.</span>';
  intro.innerHTML = card.intro;
  detailsCopy.textContent = card.details;
  document.title = card.name.toUpperCase() + " — BILT card study";
  placeholderName.textContent = card.title;

  if (card.source) {
    if (viewer.getAttribute("src") !== card.source) viewer.setAttribute("src", card.source);
    viewer.setAttribute("alt", card.name + " card in a centered 3D view");
    viewer.hidden = false;
    viewer.setAttribute("aria-hidden", "false");
    placeholder.hidden = true;
  } else {
    viewer.hidden = true;
    viewer.setAttribute("aria-hidden", "true");
    placeholder.hidden = false;
  }

  for (const [key, value] of Object.entries(card.specs || {})) {
    const target = document.querySelector('[data-spec="' + key + '"]');
    if (target) target.textContent = value;
  }
  if (!card.specs) {
    document.querySelector('[data-spec="format"]').textContent = "Awaiting GLB";
    document.querySelector('[data-spec="parts"]').textContent = "—";
    document.querySelector('[data-spec="geometry"]').textContent = "—";
    document.querySelector('[data-spec="download"]').textContent = "—";
  }

  resetCards();
  queueCardTilt();
  queueReflectionAlignment();
  viewer.dispatchEvent(new CustomEvent('card-selection', {
    detail: { hasModel: !!card.source, sourceChanged: previousSource !== card.source },
  }));
  if (updateAddress) {
    const url = new URL(window.location.href);
    url.searchParams.set("card", selectedCard);
    window.history.replaceState({}, "", url);
  }
}

function flipCard(event) {
  if (event?.defaultPrevented || viewer.classList.contains('placing-sticker') || viewer.classList.contains('dragging-sticker')) return;
  if (!cards[selectedCard]?.source) return;
  showingBack = !showingBack;
  setPhysicalCardPose();
  const side = showingBack ? "back" : "front";
  const action = showingBack ? "front" : "back";
  const card = cards[selectedCard];
  viewer.setAttribute("aria-pressed", String(showingBack));
  viewer.setAttribute("aria-label", `${card.name} card, showing the ${side} side. Activate to view the ${action}.`);
  viewer.setAttribute("title", `Card ${side}. Click or press Enter to turn to the ${action}.`);
  queueCardTilt();
}

function setPhysicalCardPose() {
  // Mirror the card's pitch on the reverse face so its top edge leans away
  // from the rear camera, matching the front-side presentation.
  activeOrientation = {
    ...baseOrientation,
    pitch: showingBack ? -baseOrientation.pitch : baseOrientation.pitch,
  };
  viewer.setAttribute(
    "orientation",
    `${activeOrientation.roll}deg ${activeOrientation.pitch}deg ${activeOrientation.yaw}deg`,
  );
  queueReflectionAlignment();
}

function updateCardTilt() {
  if (viewer.classList.contains('dragging-sticker')) { frame = 0; return; }
  currentPointer.x += (pointer.x - currentPointer.x) * 0.1;
  currentPointer.y += (pointer.y - currentPointer.y) * 0.1;

  const pointerSettled = Math.abs(pointer.x - currentPointer.x) < 0.001
    && Math.abs(pointer.y - currentPointer.y) < 0.001;
  if (pointerSettled) currentPointer = { ...pointer };

  const targetSideYaw = showingBack ? 180 : 0;
  sideYaw += (targetSideYaw - sideYaw) * 0.12;
  const sideSettled = Math.abs(targetSideYaw - sideYaw) < 0.05;
  if (sideSettled) sideYaw = targetSideYaw;
  const settled = pointerSettled && sideSettled;

  // Orbit the camera around the card instead of changing model orientation.
  // This keeps the HDR environment fixed and avoids model-viewer scene update errors.
  const tiltDirection = showingBack ? -1 : 1;
  const theta = baseCameraOrbit.theta + sideYaw + currentPointer.x * frontTilt.yaw * tiltDirection;
  const phi = baseCameraOrbit.phi + currentPointer.y * frontTilt.pitch * tiltDirection;
  viewer.cameraOrbit = `${theta}deg ${phi}deg ${baseCameraOrbit.radius}`;
  queueReflectionAlignment();

  frame = 0;
  if (!settled) frame = window.requestAnimationFrame(updateCardTilt);
}

function queueCardTilt() {
  if (!frame) frame = window.requestAnimationFrame(updateCardTilt);
}

function rotatePoint(point, orientation) {
  const toRadians = (degrees) => degrees * Math.PI / 180;
  const roll = toRadians(orientation.roll);
  const pitch = toRadians(orientation.pitch);
  const yaw = toRadians(orientation.yaw);
  const cosR = Math.cos(roll), sinR = Math.sin(roll);
  const cosP = Math.cos(pitch), sinP = Math.sin(pitch);
  const cosY = Math.cos(yaw), sinY = Math.sin(yaw);
  const y1 = point.y * cosR - point.z * sinR;
  const z1 = point.y * sinR + point.z * cosR;
  const x2 = point.x * cosP + z1 * sinP;
  const z2 = -point.x * sinP + z1 * cosP;
  return {
    x: x2 * cosY - y1 * sinY,
    y: x2 * sinY + y1 * cosY,
    z: z2,
  };
}

function updateReflectionAlignment() {
  if (selectedCard !== "obsidian" || !viewer?.getDimensions || !viewer?.getCameraOrbit || !viewer?.getCameraTarget) return;
  const bounds = viewer.getDimensions();
  const orbit = viewer.getCameraOrbit();
  const target = viewer.getCameraTarget();
  const height = viewer.offsetHeight;
  if (!height || !bounds?.x || !bounds?.y || !bounds?.z || !orbit?.radius) return;

  const theta = orbit.theta;
  const phi = orbit.phi;
  const camera = {
    x: target.x + orbit.radius * Math.sin(phi) * Math.sin(theta),
    y: target.y + orbit.radius * Math.cos(phi),
    z: target.z + orbit.radius * Math.sin(phi) * Math.cos(theta),
  };
  const forward = { x: target.x - camera.x, y: target.y - camera.y, z: target.z - camera.z };
  const forwardLength = Math.hypot(forward.x, forward.y, forward.z) || 1;
  forward.x /= forwardLength; forward.y /= forwardLength; forward.z /= forwardLength;
  let right = { x: -forward.z, y: 0, z: forward.x };
  const rightLength = Math.hypot(right.x, right.z) || 1;
  right.x /= rightLength; right.z /= rightLength;
  const up = {
    x: right.y * forward.z - right.z * forward.y,
    y: right.z * forward.x - right.x * forward.z,
    z: right.x * forward.y - right.y * forward.x,
  };
  const fov = (viewer.getFieldOfView?.() || 28) * Math.PI / 180;
  const focalLength = height / (2 * Math.tan(fov / 2));
  const half = { x: bounds.x / 2, y: bounds.y / 2, z: bounds.z / 2 };
  let modelBottom = -Infinity;

  for (const x of [-half.x, half.x]) {
    for (const y of [-half.y, half.y]) {
      for (const z of [-half.z, half.z]) {
        const point = rotatePoint({ x, y, z }, activeOrientation);
        const dx = target.x + point.x - camera.x;
        const dy = target.y + point.y - camera.y;
        const dz = target.z + point.z - camera.z;
        const depth = dx * forward.x + dy * forward.y + dz * forward.z;
        if (depth <= 0) continue;
        const vertical = dx * up.x + dy * up.y + dz * up.z;
        modelBottom = Math.max(modelBottom, height / 2 - focalLength * vertical / depth);
      }
    }
  }
  if (!Number.isFinite(modelBottom)) return;

  const transform = window.getComputedStyle(viewer).transform;
  const matrix = transform === "none" ? null : new DOMMatrixReadOnly(transform);
  const scale = matrix ? Math.hypot(matrix.c, matrix.d) : 1;
  const safeScale = scale || 1;
  const fixedGap = 26;
  const reflectionOffset = (modelBottom * safeScale + fixedGap) / safeScale - height;
  viewer.style.setProperty("--reflection-offset", reflectionOffset.toFixed(2) + "px");
}

function queueReflectionAlignment() {
  if (reflectionFrame) return;
  reflectionFrame = window.requestAnimationFrame(() => {
    reflectionFrame = 0;
    updateReflectionAlignment();
  });
}

function moveWithPointer(event) {
  if (viewer.classList.contains('placing-sticker') || viewer.classList.contains('dragging-sticker')) return;
  const bounds = stage.getBoundingClientRect();
  const inside = event.clientX >= bounds.left && event.clientX <= bounds.right
    && event.clientY >= bounds.top && event.clientY <= bounds.bottom;
  if (!inside) {
    resetCards();
    return;
  }

  pointer = {
    x: Math.max(-1, Math.min(1, ((event.clientX - bounds.left) / bounds.width - 0.5) * 2)),
    y: Math.max(-1, Math.min(1, ((event.clientY - bounds.top) / bounds.height - 0.5) * 2)),
  };
  queueCardTilt();
}

function resetCards() {
  if (pointer.x === 0 && pointer.y === 0) return;
  pointer = { x: 0, y: 0 };
  queueCardTilt();
}

selectorButtons.forEach((button) => {
  button.addEventListener("click", () => selectCard(button.dataset.card));
});
viewer.addEventListener("click", flipCard);
viewer.addEventListener("keydown", (event) => {
  if (event.key === "Enter" || event.key === " ") {
    event.preventDefault();
    flipCard();
  }
});
window.addEventListener("pointermove", moveWithPointer, { passive: true, capture: true });
stage.addEventListener("pointerleave", resetCards, { passive: true });
window.addEventListener("blur", resetCards);
window.addEventListener("resize", queueReflectionAlignment, { passive: true });
new ResizeObserver(queueReflectionAlignment).observe(stage);

viewer.addEventListener("progress", (event) => {
  if (progressFill) progressFill.style.width = Math.round(event.detail.totalProgress * 100) + "%";
});

function reduceBlueMetalness() {
  const model = viewer.model;
  if (selectedCard !== "blue" || !model || model === blueMetalnessAdjustedModel) return;

  for (const material of model.materials || []) {
    if ((material.name || "").toLowerCase().includes("hologram")) continue;
    const pbr = material.pbrMetallicRoughness;
    if (!pbr || typeof pbr.metallicFactor !== "number") continue;
    pbr.setMetallicFactor(Math.max(0, pbr.metallicFactor * 0.9));
  }
  blueMetalnessAdjustedModel = model;
}

viewer.addEventListener("load", () => {
  reduceBlueMetalness();
  updateCardTilt();
  queueReflectionAlignment();
  if (progressFill) progressFill.style.width = "100%";
  window.setTimeout(() => loadState?.setAttribute("hidden", ""), 350);
});

viewer.addEventListener("error", (event) => {
  const label = loadState?.querySelector("span:last-child");
  if (label) label.textContent = "Model could not be loaded";
});

const requestedCard = new URLSearchParams(window.location.search).get("card");
selectCard(requestedCard || "obsidian", false);
