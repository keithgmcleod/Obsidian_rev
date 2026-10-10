const viewer = document.querySelector("#obsidian-model");
const stage = document.querySelector(".viewer-stage");
const progressFill = document.querySelector(".progress-fill");
const loadState = document.querySelector(".load-state");

const frontTilt = { yaw: 15, pitch: 15 };
const baseOrientation = { roll: 0, pitch: -15, yaw: -15 };
let pointer = { x: 0, y: 0 };
let currentPointer = { x: 0, y: 0 };
let frame = 0;
let activeOrientation = { ...baseOrientation };
let reflectionFrame = 0;

function updateCardTilt() {
  currentPointer.x += (pointer.x - currentPointer.x) * 0.1;
  currentPointer.y += (pointer.y - currentPointer.y) * 0.1;

  const settled = Math.abs(pointer.x - currentPointer.x) < 0.001
    && Math.abs(pointer.y - currentPointer.y) < 0.001;
  if (settled) {
    currentPointer = { ...pointer };
  }

  const yaw = -currentPointer.x * frontTilt.yaw;
  const pitch = -currentPointer.y * frontTilt.pitch;
  const orientation = [
    baseOrientation.roll,
    baseOrientation.pitch + pitch,
    baseOrientation.yaw + yaw,
  ].map((angle) => angle + "deg").join(" ");
  activeOrientation = {
    roll: baseOrientation.roll,
    pitch: baseOrientation.pitch + pitch,
    yaw: baseOrientation.yaw + yaw,
  };
  viewer.orientation = orientation;
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
  if (!viewer?.getDimensions || !viewer?.getCameraOrbit || !viewer?.getCameraTarget) return;
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

  const rect = viewer.getBoundingClientRect();
  const transform = window.getComputedStyle(viewer).transform;
  const scale = transform === "none" ? 1 : Math.hypot(new DOMMatrixReadOnly(transform).c, new DOMMatrixReadOnly(transform).d);
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

window.addEventListener("pointermove", moveWithPointer, { passive: true, capture: true });
stage.addEventListener("pointerleave", resetCards, { passive: true });
window.addEventListener("blur", resetCards);
window.addEventListener("resize", queueReflectionAlignment, { passive: true });
new ResizeObserver(queueReflectionAlignment).observe(stage);

viewer.addEventListener("progress", (event) => {
  progressFill.style.width = Math.round(event.detail.totalProgress * 100) + "%";
});

viewer.addEventListener("load", () => {
  updateCardTilt();
  queueReflectionAlignment();
  progressFill.style.width = "100%";
  window.setTimeout(() => loadState?.setAttribute("hidden", ""), 350);
});

viewer.addEventListener("error", () => {
  const label = loadState?.querySelector("span:last-child");
  if (label) label.textContent = "Model could not be loaded";
});
