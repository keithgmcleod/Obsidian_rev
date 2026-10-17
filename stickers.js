import * as THREE from 'three';

const viewer = document.querySelector('#obsidian-model');
const status = document.querySelector('#sticker-status');
const picker = document.querySelector('.sticker-picker');
const sizeInput = document.querySelector('#sticker-size');
const rotationInput = document.querySelector('#sticker-rotation');
const foldsInput = document.querySelector('#sticker-folds');
const finishInput = document.querySelector('#sticker-finish');
const paintColour = document.querySelector('#spray-colour');
const paintPalette = document.querySelector('#paint-palette');
const paletteColours = [
  ['Light blue', '#97c6ea'], ['Red', '#ef3340'], ['Yellow', '#ffdf00'],
  ['White', '#ffffff'], ['Lime green', '#b6ef3c'],
];
let nextPaintColour = null;
paintPalette.style.gridTemplateColumns = 'repeat(5, 1fr)';
function randomPaintColour() {
  return paletteColours[Math.floor(Math.random() * paletteColours.length)][1];
}
function syncPaintPalette() {
  paintPalette.querySelectorAll('button').forEach(button => button.setAttribute('aria-pressed', String(button.dataset.colour === paintColour.value)));
}
function choosePaintColour(colour) {
  if (!paletteColours.some(([, value]) => value === colour)) return;
  nextPaintColour = colour;
  paintColour.value = colour; syncPaintPalette();
  const entry = selectedEntry || entries().at(-1);
  if (ready && entry?.finish === 'spray') {
    entry.paintColour = colour; rebuild(entry);
    message('Paint colour updated. Choose a palette colour to customize this placement.');
  } else message('Paint colour selected. Choose Spray paint to apply it.');
}
paletteColours.forEach(([name, colour]) => {
  const button = document.createElement('button');
  button.type = 'button'; button.title = name; button.setAttribute('aria-label', name);
  button.dataset.colour = colour; button.style.backgroundColor = colour;
  button.addEventListener('click', () => choosePaintColour(colour)); paintPalette.append(button);
});
syncPaintPalette();
const assets = [
  ['v-ring-seal-bilt-neighborhood', 'Bilt neighborhood'],
  ['v-diecut-rent-day', 'Rent day'],
  ['v-badge-have-a-good-rent-day', 'Have a good rent day'],
  ['v-diecut-neighborhood', 'Neighbourhood'],
  [null, 'Custom graffiti'],
  ['v-hello-soho', 'Hello Soho'],
];
const designs = assets.map(([slug, label]) => ({ url: slug ? `./stickers/${slug}.webp` : null, label, custom: !slug }));
const loader = new THREE.TextureLoader();
const textureCache = new Map();
const cards = new Map();
let scene, model, meshes = [], activeDesign = null, ready = false, generation = 0;
let surfaceRenderer;
let selectedEntry = null, drag = null, dragFrame = 0, suppressClickUntil = 0;
let cardAvailable = !viewer.hidden;
const alphaMasks = new WeakMap();
const silhouettes = new WeakMap();
const foldSeeds = new Set();
let foldSequence = 0;
let stickerSequence = 0;
const wetPaint = new Set();
let paintFrame = 0;
function animatePaint(now) {
  paintFrame = 0;
  for (const entry of wetPaint) {
    entry.paintProgress.value = Math.min(1, Math.max(0, (now - entry.paintStarted) / 4200));
    if (entry.paintProgress.value === 1) wetPaint.delete(entry);
  }
  render();
  if (wetPaint.size) paintFrame = requestAnimationFrame(animatePaint);
}

function freshFoldSeed(design) {
  let hash = 2166136261;
  for (const character of design) hash = Math.imul(hash ^ character.charCodeAt(0), 16777619);
  let seed = (crypto.getRandomValues(new Uint32Array(1))[0] ^ hash ^ Math.imul(++foldSequence, 2654435761)) >>> 0;
  while (foldSeeds.has(seed)) seed = (seed + 2654435761) >>> 0;
  foldSeeds.add(seed); return seed;
}
function seededRandom(seed) {
  return () => {
    seed |= 0; seed = seed + 0x6D2B79F5 | 0;
    let value = Math.imul(seed ^ seed >>> 15, 1 | seed);
    value ^= value + Math.imul(value ^ value >>> 7, 61 | value);
    return ((value ^ value >>> 14) >>> 0) / 4294967296;
  };
}
function silhouetteFor(texture) {
  if (silhouettes.has(texture)) return silhouettes.get(texture);
  const resolution = 128, aspect = texture.image.height / texture.image.width;
  const canvas = document.createElement('canvas'); canvas.width = canvas.height = resolution;
  const context = canvas.getContext('2d', { willReadFrequently: true });
  context.drawImage(texture.image, 0, 0, resolution, resolution);
  const pixels = context.getImageData(0, 0, resolution, resolution).data;
  const inside = new Uint8Array(resolution * resolution), distance = new Float32Array(inside.length);
  const contour = [], interior = [];
  const dx = 1 / (resolution - 1), dy = aspect / (resolution - 1), diagonal = Math.hypot(dx, dy);
  for (let i = 0; i < inside.length; i++) inside[i] = pixels[i * 4 + 3] > 24 ? 1 : 0;
  for (let y = 0; y < resolution; y++) for (let x = 0; x < resolution; x++) {
    const i = y * resolution + x;
    distance[i] = inside[i] && x > 0 && y > 0 && x < resolution - 1 && y < resolution - 1 ? 1000 : 0;
    if (!inside[i]) continue;
    const point = { u: x * dx, v: 1 - y / (resolution - 1) };
    interior.push(point);
    if (!x || !y || x === resolution - 1 || y === resolution - 1 ||
        !inside[i - 1] || !inside[i + 1] || !inside[i - resolution] || !inside[i + resolution]) contour.push(point);
  }
  for (let y = 1; y < resolution - 1; y++) for (let x = 1; x < resolution - 1; x++) {
    const i = y * resolution + x;
    distance[i] = Math.min(distance[i], distance[i - 1] + dx, distance[i - resolution] + dy,
      distance[i - resolution - 1] + diagonal, distance[i - resolution + 1] + diagonal);
  }
  for (let y = resolution - 2; y > 0; y--) for (let x = resolution - 2; x > 0; x--) {
    const i = y * resolution + x;
    distance[i] = Math.min(distance[i], distance[i + 1] + dx, distance[i + resolution] + dy,
      distance[i + resolution - 1] + diagonal, distance[i + resolution + 1] + diagonal);
  }
  const result = { resolution, aspect, distance, contour, interior, dx, dy };
  silhouettes.set(texture, result); return result;
}
function organicProfile(entry) {
  const shape = silhouetteFor(entry.texture), random = seededRandom(entry.seed);
  const range = (min, max) => min + (max - min) * random();
  const pick = list => list[Math.floor(random() * list.length)] || { u: 0.5, v: 0.5 };
  const creases = Array.from({ length: 2 + Math.floor(random() * 3) }, () => {
    const anchor = pick(shape.interior), angle = range(0, Math.PI);
    return { ...anchor, cos: Math.cos(angle), sin: Math.sin(angle), width: range(0.008, 0.025),
      length: range(0.14, 0.46), curve: range(-1.1, 1.1), amplitude: range(0.3, 1.15), phase: range(0, Math.PI * 2) };
  });
  const curls = [];
  const curlCount = 1 + Math.floor(random() * 3);
  for (let i = 0; i < curlCount; i++) {
    let anchor = pick(shape.contour);
    for (let attempt = 0; attempt < 20 && curls.some(c => Math.hypot(c.u - anchor.u, (c.v - anchor.v) * shape.aspect) < 0.14); attempt++) anchor = pick(shape.contour);
    curls.push({ ...anchor, depth: Math.min(range(0.035, 0.075), shape.aspect * 0.24),
      span: range(0.07, 0.18), angle: range(2.0, 3.0), phase: range(0, Math.PI * 2) });
  }
  const wrinkles = Array.from({ length: 2 + Math.floor(random() * 4) }, () => ({
    ...pick(shape.interior), angle: range(0, Math.PI * 2), frequency: range(22, 48),
    phase: range(0, Math.PI * 2), spread: range(0.06, 0.17), amplitude: range(0.035, 0.14),
  }));
  return { shape, creases, curls, wrinkles };
}
function organicDeformation(profile, u, v, amount, result) {
  const { shape } = profile, { resolution, aspect, distance } = shape;
  result.x = result.y = result.z = result.ridges = 0;
  if (amount <= 0) return result;
  for (const crease of profile.creases) {
    const x = u - crease.u, y = (v - crease.v) * aspect;
    const along = x * crease.cos + y * crease.sin;
    const across = -x * crease.sin + y * crease.cos - crease.curve * along * along - Math.sin(along * 15 + crease.phase) * 0.003;
    result.ridges += crease.amplitude * Math.exp(-Math.pow(across / crease.width, 2) - Math.pow(along / crease.length, 4));
  }
  for (const wrinkle of profile.wrinkles) {
    const x = u - wrinkle.u, y = (v - wrinkle.v) * aspect;
    const wave = Math.sin((x * Math.cos(wrinkle.angle) + y * Math.sin(wrinkle.angle)) * wrinkle.frequency + wrinkle.phase);
    result.ridges += wrinkle.amplitude * wave * wave * Math.exp(-(x * x + y * y) / (wrinkle.spread * wrinkle.spread));
  }
  const ix = THREE.MathUtils.clamp(Math.round(u * (resolution - 1)), 1, resolution - 2);
  const iy = THREE.MathUtils.clamp(Math.round((1 - v) * (resolution - 1)), 1, resolution - 2);
  const index = iy * resolution + ix, inset = distance[index];
  let nx = (distance[index - 1] - distance[index + 1]) / (2 * shape.dx);
  let ny = (distance[index + resolution] - distance[index - resolution]) / (2 * shape.dy);
  const normalLength = Math.hypot(nx, ny);
  if (normalLength > 0.0001) { nx /= normalLength; ny /= normalLength; }
  else return result;
  for (const curl of profile.curls) {
    if (inset >= curl.depth) continue;
    const x = u - curl.u, y = (v - curl.v) * aspect;
    const envelope = Math.exp(-(x * x + y * y) / (2 * curl.span * curl.span));
    const travel = curl.depth - inset;
    const angle = travel / curl.depth * curl.angle * Math.sqrt(amount) * envelope;
    if (angle < 0.0001) continue;
    const height = travel * (1 - Math.cos(angle)) / angle;
    if (height <= result.z) continue;
    const retreat = travel * (Math.sin(angle) / angle - 1);
    result.x = nx * retreat; result.y = ny * retreat; result.z = height;
  }
  return result;
}

function pointerRay(event) {
  model.updateWorldMatrix(true, true);
  const rect = viewer.getBoundingClientRect(), ray = new THREE.Raycaster();
  ray.setFromCamera(new THREE.Vector2((event.clientX - rect.left) / rect.width * 2 - 1,
    1 - (event.clientY - rect.top) / rect.height * 2), scene.camera);
  return ray;
}
function pickSticker(ray) {
  const hits = ray.intersectObjects(entries().map(entry => entry.decal).filter(Boolean), false);
  const surfaceHit = hits.length ? ray.intersectObjects(meshes, false)[0] : null;
  for (const hit of hits) {
    if (surfaceHit && hit.distance > surfaceHit.distance + 0.0001) continue;
    const texture = hit.object.material.map;
    if (!alphaMasks.has(texture)) {
      const canvas = document.createElement('canvas'); canvas.width = canvas.height = 256;
      const context = canvas.getContext('2d', { willReadFrequently: true });
      context.drawImage(texture.image, 0, 0, 256, 256);
      alphaMasks.set(texture, context.getImageData(0, 0, 256, 256).data);
    }
    const x = THREE.MathUtils.clamp(Math.floor(hit.uv.x * 256), 0, 255);
    const y = THREE.MathUtils.clamp(Math.floor((1 - hit.uv.y) * 256), 0, 255);
    if (alphaMasks.get(texture)[(y * 256 + x) * 4 + 3] > 12) {
      return entries().find(entry => entry.decal === hit.object);
    }
  }
  return null;
}
function selectSticker(entry) {
  selectedEntry = entry;
  if (entry.finish === 'spray') { paintColour.value = entry.paintColour; syncPaintPalette(); }
  foldsInput.disabled = entry.finish === 'spray';
  sizeInput.value = entry.size; rotationInput.value = entry.rotation; foldsInput.value = entry.folds ?? 35;
  message(entry.finish === 'spray' ? 'Paint selected. Drag to move it, or adjust size and rotation.' : 'Sticker selected. Drag to move it, or adjust size, rotation and folds.');
}
function moveDraggedSticker() {
  dragFrame = 0;
  if (!drag || !ready) return;
  const hit = pointerRay(drag.pointer).ray.intersectPlane(drag.plane, new THREE.Vector3());
  if (!hit) return;
  const target = meshes[drag.entry.meshIndex];
  const candidate = hit.add(drag.offset);
  const edge = boundaryAt(drag.frame, candidate);
  const image = drag.entry.texture.image;
  const width = drag.frame.width * .28 * drag.entry.size / 100 * stickerScale(drag.entry);
  const limit = Math.min(width, width * image.height / image.width) * 0.25;
  if (edge.distance > limit) candidate.addScaledVector(edge.outward, limit - edge.distance);
  drag.entry.point.copy(target.worldToLocal(candidate));
  rebuild(drag.entry);
}
function finishDrag(event) {
  if (!drag || (event?.pointerId != null && drag.id !== event.pointerId)) return;
  if (event?.type === 'pointerup') {
    drag.pointer = { clientX: event.clientX, clientY: event.clientY };
    if (dragFrame) cancelAnimationFrame(dragFrame);
    moveDraggedSticker();
  } else if (dragFrame) cancelAnimationFrame(dragFrame);
  dragFrame = 0;
  const id = drag.id; drag = null; suppressClickUntil = performance.now() + 500;
  viewer.classList.remove('dragging-sticker');
  if (viewer.hasPointerCapture(id)) viewer.releasePointerCapture(id);
  message('Sticker selected. Drag to move it, or adjust size, rotation and folds.');
}
viewer.addEventListener('pointerdown', event => {
  if (!ready || event.button !== 0 || !event.isPrimary) return;
  const ray = pointerRay(event), entry = pickSticker(ray);
  if (!entry) { selectedEntry = null; suppressClickUntil = 0; return; }
  selectSticker(entry);
  const target = meshes[entry.meshIndex];
  const center = target.localToWorld(entry.point.clone());
  const reference = entry.normal.clone().applyNormalMatrix(new THREE.Matrix3().getNormalMatrix(target.matrixWorld));
  const frame = cardFrame(reference);
  const plane = new THREE.Plane().setFromNormalAndCoplanarPoint(frame.normal, center);
  const hit = ray.ray.intersectPlane(plane, new THREE.Vector3());
  if (!hit) return;
  drag = { id: event.pointerId, entry, frame, plane, offset: center.sub(hit), pointer: { clientX: event.clientX, clientY: event.clientY } };
  viewer.classList.add('dragging-sticker'); viewer.setPointerCapture(event.pointerId);
  event.preventDefault();
});
viewer.addEventListener('pointermove', event => {
  if (!ready) return;
  if (drag) {
    if (event.pointerId !== drag.id) return;
    drag.pointer = { clientX: event.clientX, clientY: event.clientY };
    if (!dragFrame) dragFrame = requestAnimationFrame(moveDraggedSticker);
    event.preventDefault();
  } else viewer.classList.toggle('over-sticker', !!pickSticker(pointerRay(event)));
});
viewer.addEventListener('pointerup', finishDrag);
viewer.addEventListener('pointercancel', finishDrag);
viewer.addEventListener('lostpointercapture', finishDrag);
window.addEventListener('blur', () => finishDrag());
viewer.addEventListener('pointerleave', () => viewer.classList.remove('over-sticker'));

function cardFrame(referenceNormal) {
  let body, area = 0, dimensions;
  for (const mesh of meshes) {
    if (!mesh.geometry.boundingBox) mesh.geometry.computeBoundingBox();
    const size = mesh.geometry.boundingBox.getSize(new THREE.Vector3()).multiply(mesh.getWorldScale(new THREE.Vector3()));
    const axes = ['x', 'y', 'z'].sort((a, b) => size[b] - size[a]);
    const candidate = size[axes[0]] * size[axes[1]];
    if (candidate > area) { area = candidate; body = mesh; dimensions = { size, axes }; }
  }
  const axis = name => new THREE.Vector3().setComponent(['x', 'y', 'z'].indexOf(name), 1);
  const normal = axis(dimensions.axes[2]).applyNormalMatrix(new THREE.Matrix3().getNormalMatrix(body.matrixWorld)).normalize();
  if (normal.dot(referenceNormal) < 0) normal.negate();
  const right = axis(dimensions.axes[0]).transformDirection(body.matrixWorld);
  const up = normal.clone().cross(right).normalize();
  const center = body.localToWorld(body.geometry.boundingBox.getCenter(new THREE.Vector3()));
  const min = new THREE.Vector3(Infinity, Infinity, Infinity), max = new THREE.Vector3(-Infinity, -Infinity, -Infinity);
  const corner = new THREE.Vector3(), relative = new THREE.Vector3();
  for (const mesh of meshes) {
    const box = mesh.geometry.boundingBox;
    const size = box.getSize(new THREE.Vector3()).multiply(mesh.getWorldScale(new THREE.Vector3()));
    const sorted = [size.x, size.y, size.z].sort((a, b) => b - a);
    if (sorted[0] * sorted[1] < area * 0.8) continue;
    for (const x of [box.min.x, box.max.x]) for (const y of [box.min.y, box.max.y]) for (const z of [box.min.z, box.max.z]) {
      relative.copy(corner.set(x, y, z).applyMatrix4(mesh.matrixWorld)).sub(center);
      const p = new THREE.Vector3(relative.dot(right), relative.dot(up), relative.dot(normal));
      min.min(p); max.max(p);
    }
  }
  const offset = min.clone().add(max).multiplyScalar(0.5);
  center.addScaledVector(right, offset.x).addScaledVector(up, offset.y).addScaledVector(normal, offset.z);
  const width = max.x - min.x, height = max.y - min.y, thickness = max.z - min.z;
  return { normal, right, up, center, width, height, front: thickness / 2, back: -thickness / 2, radius: height * 0.045 };
}

// Signed distance and nearest boundary of the card's rounded rectangle. Its
// outward direction also defines the cross-section used to turn onto the back.
function boundaryAt(frame, point, result = { outward: new THREE.Vector3() }) {
  const dx = point.x - frame.center.x, dy = point.y - frame.center.y, dz = point.z - frame.center.z;
  const x = dx * frame.right.x + dy * frame.right.y + dz * frame.right.z;
  const y = dx * frame.up.x + dy * frame.up.y + dz * frame.up.z;
  const qx = Math.abs(x) - (frame.width / 2 - frame.radius);
  const qy = Math.abs(y) - (frame.height / 2 - frame.radius);
  const ax = Math.max(qx, 0), ay = Math.max(qy, 0), length = Math.hypot(ax, ay);
  const distance = length + Math.min(Math.max(qx, qy), 0) - frame.radius;
  let nx, ny;
  if (length > 0) { nx = Math.sign(x) * ax / length; ny = Math.sign(y) * ay / length; }
  else { nx = qx > qy ? Math.sign(x) : 0; ny = qx > qy ? 0 : Math.sign(y); }
  result.x = x; result.y = y; result.distance = distance; result.nx = nx; result.ny = ny;
  result.outward.copy(frame.right).multiplyScalar(nx).addScaledVector(frame.up, ny);
  return result;
}

// Render the complete card into an orthographic height field. This includes
// separate chip/logo meshes and prior stickers; sampling a single hit mesh
// would let those raised details punch through the new sheet.
function captureSurface(center, normal, up, width, height, cardWidth) {
  surfaceRenderer ||= new THREE.WebGLRenderer({ alpha: true, antialias: false });
  const resolution = 128, range = cardWidth * 0.2;
  const capture = new THREE.Scene();
  const camera = new THREE.OrthographicCamera(-width / 2, width / 2, height / 2, -height / 2, range * 0.01, range * 2);
  camera.position.copy(center).addScaledVector(normal, range);
  camera.up.copy(up); camera.lookAt(center); camera.updateMatrixWorld();
  const materials = [];
  model.traverse(object => {
    if (!object.isMesh || !object.visible) return;
    const material = new THREE.ShaderMaterial({
      side: THREE.DoubleSide,
      uniforms: { mask: { value: object.userData.cardSticker ? object.material.map : null }, masked: { value: !!object.userData.cardSticker } },
      vertexShader: 'varying vec2 vUv; void main(){vUv=uv; gl_Position=projectionMatrix*modelViewMatrix*vec4(position,1.0);}',
      fragmentShader: `uniform sampler2D mask; uniform bool masked; varying vec2 vUv;
        void main(){
          if(masked && texture2D(mask,vUv).a < 0.04) discard;
          vec3 packed=fract(gl_FragCoord.z*vec3(1.0,255.0,65025.0));
          packed-=packed.yzz*vec3(1.0/255.0,1.0/255.0,0.0);
          gl_FragColor=vec4(packed,1.0);
        }`,
    });
    materials.push(material);
    const copy = new THREE.Mesh(object.geometry, material);
    copy.matrixAutoUpdate = false; copy.matrix.copy(object.matrixWorld); capture.add(copy);
  });
  const target = new THREE.WebGLRenderTarget(resolution, resolution, { minFilter: THREE.NearestFilter, magFilter: THREE.NearestFilter });
  const pixels = new Uint8Array(resolution * resolution * 4);
  try {
    surfaceRenderer.setRenderTarget(target); surfaceRenderer.setClearColor(0, 0);
    surfaceRenderer.clear(); surfaceRenderer.render(capture, camera);
    surfaceRenderer.readRenderTargetPixels(target, 0, 0, resolution, resolution, pixels);
  } finally {
    surfaceRenderer.setRenderTarget(null); target.dispose(); materials.forEach(material => material.dispose());
  }
  const elevations = new Float32Array(resolution * resolution);
  for (let i = 0; i < elevations.length; i++) {
    const offset = i * 4;
    const depth = pixels[offset] / 255 + pixels[offset + 1] / 65025 + pixels[offset + 2] / 16581375;
    elevations[i] = pixels[offset + 3] ? range - (camera.near + depth * (camera.far - camera.near)) : 0;
  }
  // Conservative dilation bridges tiny gaps, bevels and sampling boundaries.
  // A soft envelope lets vinyl bend over relief instead of copying every edge.
  const sample = (u, v) => {
    const cx = Math.round(u * (resolution - 1)), cy = Math.round(v * (resolution - 1));
    let elevation = -Infinity;
    for (let y = -3; y <= 3; y++) for (let x = -3; x <= 3; x++) {
      const ix = THREE.MathUtils.clamp(cx + x, 0, resolution - 1);
      const iy = THREE.MathUtils.clamp(cy + y, 0, resolution - 1);
      const distance = Math.hypot(x * width, y * height) / resolution;
      elevation = Math.max(elevation, elevations[iy * resolution + ix] - distance * 0.07);
    }
    return elevation;
  };
  return sample;
}

// Geometry attachment bridge for this site's pinned model-viewer 4.4.0. Keep isolated:
// the public materials API cannot add decal meshes. Fail visibly on API changes.
function getScene() {
  const symbol = Object.getOwnPropertySymbols(viewer).find(key => key.description === 'scene');
  const result = symbol && viewer[symbol];
  if (!result?.model || !result?.camera || typeof result.queueRender !== 'function') {
    throw new Error('Sticker attachment is unavailable with this viewer version.');
  }
  return result;
}
function guardUnpresentedARScene() {
  // model-viewer 4.4 calls its AR scene updater on ordinary orientation edits,
  // even before an AR scene exists. Keep normal card flips from dereferencing
  // that null scene, without changing the path for an active AR presentation.
  let owner = viewer, rendererSymbol;
  while (owner && !rendererSymbol) {
    rendererSymbol = Object.getOwnPropertySymbols(owner).find(key => key.description === 'renderer');
    owner = Object.getPrototypeOf(owner);
  }
  const ar = rendererSymbol && viewer[rendererSymbol]?.arRenderer;
  if (!ar || ar.stickerSceneGuard) return;
  const update = ar.onUpdateScene;
  ar.onUpdateScene = (...args) => {
    if (ar.presentedScene) return update.apply(ar, args);
  };
  ar.stickerSceneGuard = true;
}
const cardKey = () => viewer.getAttribute('src');
const entries = () => cards.get(cardKey()) || [];
function message(text) { status.textContent = text; }
function render() { scene?.queueRender(); }
const graffitiEditor = document.querySelector('#graffiti-editor');
const graffitiInput = document.querySelector('#graffiti-text');
const graffitiCanvas = document.querySelector('#graffiti-preview');
const customDesign = designs.find(design => design.custom);
let fontPromise, draftRevision = 0;
async function updateGraffiti() {
  const revision = ++draftRevision;
  customDesign.url = null;
  const text = graffitiInput.value.trim();
  const context = graffitiCanvas.getContext('2d');
  context.clearRect(0, 0, graffitiCanvas.width, graffitiCanvas.height);
  if (!text) { if (activeDesign === customDesign) message('Type some text to create your graffiti sticker.'); return; }
  try {
    fontPromise ||= new FontFace('Sticker Knerd', 'url("./fonts/knerd-fill.otf")').load().then(font => { document.fonts.add(font); return font; });
    await fontPromise;
    if (revision !== draftRevision) return;
    // Include the actual bubble glyph bounds and both vinyl outlines in the canvas.
    const size = 180, border = 46;
    context.font = `${size}px "Sticker Knerd"`;
    const metrics = context.measureText(text);
    const left = Math.max(0, metrics.actualBoundingBoxLeft), right = Math.max(metrics.width, metrics.actualBoundingBoxRight);
    const ascent = metrics.actualBoundingBoxAscent, descent = metrics.actualBoundingBoxDescent;
    const scale = Math.min(1, 1800 / (left + right + border * 2));
    graffitiCanvas.width = Math.ceil((left + right + border * 2) * scale);
    graffitiCanvas.height = Math.ceil((ascent + descent + border * 2) * scale);
    context.scale(scale, scale); context.font = `${size}px "Sticker Knerd"`;
    context.lineJoin = 'round'; context.miterLimit = 2;
    const x = border + left, y = border + ascent;
    context.strokeStyle = '#fffdf7'; context.lineWidth = 49; context.strokeText(text, x, y);
    context.strokeStyle = '#151515'; context.lineWidth = 25; context.strokeText(text, x, y);
    const gold = context.createLinearGradient(0, border, 0, border + ascent + descent);
    gold.addColorStop(0, '#E8CB94'); gold.addColorStop(1, '#876313');
    context.fillStyle = gold; context.fillText(text, x, y);
    customDesign.url = graffitiCanvas.toDataURL('image/png'); customDesign.text = text;
    // Keep a separate glyph-only mask for paint: no vinyl border or black outline.
    const paintCanvas = document.createElement('canvas');
    paintCanvas.width = graffitiCanvas.width; paintCanvas.height = graffitiCanvas.height;
    const paintContext = paintCanvas.getContext('2d');
    paintContext.scale(scale, scale); paintContext.font = `${size}px "Sticker Knerd"`;
    paintContext.fillStyle = '#fff'; paintContext.fillText(text, x, y);
    customDesign.paintUrl = paintCanvas.toDataURL('image/png');
    picker.querySelector('.graffiti-choice').replaceChildren(Object.assign(document.createElement('img'), { src: customDesign.url, alt: '' }));
    if (activeDesign === customDesign) message('Your graffiti is ready. Click the card to place a copy.');
  } catch (error) {
    fontPromise = null;
    if (activeDesign === customDesign) message('The graffiti font could not load. Select Custom graffiti to retry.');
    console.error(error);
  }
}
graffitiInput.addEventListener('input', updateGraffiti);
function setDesign(design) {
  selectedEntry = null;
  activeDesign = design;
  foldsInput.disabled = finishInput.value === 'spray';
  graffitiEditor.hidden = !design?.custom;
  if (design?.custom) updateGraffiti();
  viewer.classList.toggle('placing-sticker', !!design);
  picker.querySelectorAll('button').forEach((button, i) => button.setAttribute('aria-pressed', String(designs[i] === design)));
  message(design ? `${design.label} selected. Click the card surface to place it.` : 'Move your pointer to tilt the card.');
}
function addButton(design) {
  const button = document.createElement('button');
  button.type = 'button'; button.title = design.label;
  button.setAttribute('aria-label', design.label); button.setAttribute('aria-pressed', 'false');
  if (design.custom) { button.classList.add('graffiti-choice'); button.textContent = 'Your text'; }
  else { const image = document.createElement('img'); image.src = design.url; image.alt = ''; button.append(image); }
  button.addEventListener('click', () => setDesign(design)); picker.append(button);
}
designs.forEach(addButton);
function textureFor(design) {
  if (!textureCache.has(design.url)) {
    textureCache.set(design.url, loader.loadAsync(design.url).then(texture => {
      texture.colorSpace = THREE.SRGBColorSpace; texture.anisotropy = 8; return texture;
    }).catch(error => { textureCache.delete(design.url); throw error; }));
  }
  return textureCache.get(design.url);
}
function graffitiPaintTexture(source, colour, seed, rotation = 0, textDesign = true) {
  const random = seededRandom(seed), mask = document.createElement('canvas');
  const scale = Math.min(1, 1200 / source.image.width), padding = 48;
  const angle = THREE.MathUtils.degToRad(rotation);
  const sw = source.image.width * scale, sh = source.image.height * scale;
  const rotatedWidth = Math.abs(Math.cos(angle)) * sw + Math.abs(Math.sin(angle)) * sh;
  const rotatedHeight = Math.abs(Math.sin(angle)) * sw + Math.abs(Math.cos(angle)) * sh;
  const w = Math.ceil(rotatedWidth) + padding * 2;
  const h = Math.ceil(rotatedHeight) + padding * 2 + 210;
  mask.width = w; mask.height = h;
  const ink = mask.getContext('2d', { willReadFrequently: true });
  // Rotate the artwork first, then paint gravity-aligned drips in card coordinates.
  ink.save(); ink.translate(w / 2, padding + rotatedHeight / 2); ink.rotate(-angle);
  ink.drawImage(source.image, -sw / 2, -sh / 2, sw, sh); ink.restore();
  const pixels = ink.getImageData(0, 0, w, h).data;
  const reveal = document.createElement('canvas'); reveal.width = w; reveal.height = h;
  const revealContext = reveal.getContext('2d'); revealContext.lineCap = 'round';
  // Drips begin on the lower edges of the actual letters, never on a sticker border.
  ink.fillStyle = colour; ink.strokeStyle = colour; ink.lineCap = 'round';
  const count = Math.max(4, Math.min(16, Math.round(w / 95)));
  for (let drip = 0; drip < count; drip++) {
    let x, y = -1;
    for (let attempt = 0; attempt < 40 && y < 0; attempt++) {
      x = Math.floor(padding + random() * (w - padding * 2));
      for (let row = h - 211; row >= padding; row--) if (pixels[(row * w + x) * 4 + 3] > 180) { y = row; break; }
    }
    if (y < 0) continue;
    const length = .75 * (40 + Math.pow(random(), .7) * 155), thickness = 3 * (2.5 + random() * 5.5);
    const drift = (random() - .5) * 7;
    ink.beginPath(); ink.moveTo(x, y - 3);
    ink.bezierCurveTo(x + drift, y + length * .35, x - drift, y + length * .8, x + drift * .4, y + length);
    ink.lineWidth = thickness; ink.stroke();
    const gradient = revealContext.createLinearGradient(0, y - 15, 0, y + length + thickness);
    gradient.addColorStop(0, '#000'); gradient.addColorStop(1, '#fff');
    revealContext.strokeStyle = gradient; revealContext.lineWidth = thickness + 65;
    revealContext.beginPath(); revealContext.moveTo(x, y);
    revealContext.bezierCurveTo(x + drift, y + length * .35, x - drift, y + length * .8, x + drift * .4, y + length);
    revealContext.stroke();
    ink.beginPath(); ink.ellipse(x + drift * .4, y + length, thickness * .65, thickness, 0, 0, Math.PI * 2); ink.fill();
  }
  ink.globalCompositeOperation = 'source-in'; ink.fillRect(0, 0, w, h);
  const canvas = document.createElement('canvas'); canvas.width = w; canvas.height = h;
  const context = canvas.getContext('2d', { willReadFrequently: true });
  // Two soft coats give the edges a cloud of overspray around the solid letters.
  context.filter = 'blur(20px)'; context.globalAlpha = .42; context.drawImage(mask, 0, 0);
  context.filter = 'blur(3px)'; context.globalAlpha = .5; context.drawImage(mask, 0, 0);
  context.filter = 'blur(0.8px)'; context.globalAlpha = .99; context.drawImage(mask, 0, 0);
  // Blur the paint coats once; never run a canvas filter for every pigment dot.
  context.filter = 'none';
  const image = context.getImageData(0, 0, w, h), data = image.data;
  for (let i = 3; i < data.length; i += 4) {
    const grain = random();
    // Fine pigment variation inside the text and sparse droplets in the spray cloud.
    const pixel = (i - 3) / 4, x = pixel % w, y = Math.floor(pixel / w);
    const mottling = .97 + .02 * Math.sin(x * .073 + Math.sin(y * .09) * 2) + .01 * Math.sin(y * .13 + x * .037);
    if (data[i] > 150) {
      data[i] = Math.round(data[i] * (.94 + grain * .06) * mottling);
      const tone = .96 + random() * .04;
      data[i - 3] *= tone; data[i - 2] *= tone; data[i - 1] *= tone;
    } else {
      // Sparse, opaque pigment grains make a sprayed fringe rather than a smooth glow.
      const coverage = data[i] / 255;
      data[i] = grain < Math.min(.9, coverage * 1.8) ? Math.round(170 + random() * 85) : 0;
    }
    data[i] = Math.round(data[i] * .99);
  }
  context.putImageData(image, 0, 0);
  // Uneven gaps break up the coat into islands of pigment.
  context.globalCompositeOperation = 'destination-out'; context.globalAlpha = .06;
  for (let gap = 0; gap < Math.floor(w * h / 900); gap++) {
    const x = Math.floor(random() * w), y = Math.floor(random() * h);
    if (data[(y * w + x) * 4 + 3] < 20) continue;
    context.beginPath(); context.ellipse(x, y, .25 + random() * .6, .25 + random() * .5, random() * Math.PI, 0, Math.PI * 2); context.fill();
  }
  context.globalCompositeOperation = 'source-over';
  context.fillStyle = colour; context.globalAlpha = .28;
  // A bounded cloud of mixed-size droplets follows the paint's feathered perimeter.
  // Filters stay disabled here: individual particles must remain cheap to draw.
  context.filter = 'none';
  for (let dot = 0; dot < Math.min(16000, Math.floor(w * h / 16)); dot++) {
    const x = Math.floor(random() * w), y = Math.floor(random() * h);
    const alpha = data[(y * w + x) * 4 + 3];
    if (alpha < 4 || alpha > 235) continue;
    const scatter = random() < .12 ? 52 : 22;
    const px = x + (random() - .5) * scatter, py = y + (random() - .5) * scatter;
    const radius = random() < .06 ? 1.8 + random() * 3 : .3 + Math.pow(random(), 2) * 1.3;
    context.globalAlpha = .58 + random() * .42;
    context.beginPath(); context.ellipse(px, py, radius, radius * (.65 + random() * .5), random() * Math.PI, 0, Math.PI * 2); context.fill();
  }
  const texture = new THREE.CanvasTexture(canvas);
  const revealPixels = revealContext.getImageData(0, 0, w, h);
  for (let i = 3; i < pixels.length; i += 4) if (pixels[i] > 8) revealPixels.data[i] = 0;
  revealContext.putImageData(revealPixels, 0, 0);
  const revealTexture = new THREE.CanvasTexture(reveal);
  texture.userData.dripReveal = revealTexture;
  texture.addEventListener('dispose', () => revealTexture.dispose());
  texture.userData.paintAnchorOffset = (h / 2 - padding - rotatedHeight / 2) / w;
  texture.colorSpace = THREE.SRGBColorSpace; texture.anisotropy = 8;
  return texture;
}
function sprayTexture(source, colour, seed, designKey, rotation = 0) {
  const canvas = document.createElement('canvas');
  const scale = Math.min(1, 1000 / Math.max(source.image.width, source.image.height));
  canvas.width = Math.round(source.image.width * scale); canvas.height = Math.round(source.image.height * scale);
  const context = canvas.getContext('2d', { willReadFrequently: true });
  context.drawImage(source.image, 0, 0, canvas.width, canvas.height);
  const image = context.getImageData(0, 0, canvas.width, canvas.height), pixels = image.data;
  const circular = /v-ring-seal|v-badge/.test(designKey);
  const lettering = /v-diecut-rent-day|v-diecut-neighborhood/.test(designKey);
  for (let y = 0; y < canvas.height; y++) for (let x = 0; x < canvas.width; x++) {
    const i = (y * canvas.width + x) * 4;
    const r = pixels[i], g = pixels[i + 1], b = pixels[i + 2];
    const chroma = Math.max(r,g,b) - Math.min(r,g,b), light = (r + g + b) / 3;
    let ink = lettering ? chroma > 42 && light > 65 : light > 120 && (chroma > 28 || light > 175);
    if (circular) {
      const dx = (x / canvas.width - .5) * 2, dy = (y / canvas.height - .5) * 2;
      // Remove the vinyl perimeter and cut support bridges through the stencil.
      const radius = Math.hypot(dx, dy), angle = Math.atan2(dy, dx);
      const bridge = Math.abs(Math.sin(angle * 2 + .32)) < .018;
      ink = ink && radius < .92 && !bridge;
    }
    pixels[i] = pixels[i + 1] = pixels[i + 2] = 255;
    pixels[i + 3] = ink ? pixels[i + 3] : 0;
  }
  context.putImageData(image, 0, 0);
  return graffitiPaintTexture({ image: canvas }, colour, seed, rotation, lettering);
}
function disposeDecal(entry) {
  wetPaint.delete(entry);
  entry.decal?.removeFromParent(); entry.decal?.geometry.dispose();
  entry.decal?.material.dispose(); entry.decal = null;
}
function uprightRotation(rotation) {
  return Math.max(-20, Math.min(20, Number(rotation) || 0));
}
function rebuild(entry) {
  entry.rotation = uprightRotation(entry.rotation);
  disposeDecal(entry);
  if (entry.finish === 'spray' && (entry.paintRotation !== entry.rotation || entry.renderedPaintColour !== entry.paintColour)) {
    if (entry.paintRotation != null) entry.texture.dispose();
    entry.texture = entry.customText
      ? graffitiPaintTexture(entry.paintSource, entry.paintColour, entry.seed, entry.rotation)
      : sprayTexture(entry.paintSource, entry.paintColour, entry.seed, entry.designKey, entry.rotation);
    entry.paintRotation = entry.rotation;
    entry.renderedPaintColour = entry.paintColour;
    entry.organic = null;
  }
  const target = meshes[entry.meshIndex];
  if (!target) return;
  model.updateWorldMatrix(true, true);
  const worldPoint = target.localToWorld(entry.point.clone());
  const referenceNormal = entry.normal.clone().applyNormalMatrix(new THREE.Matrix3().getNormalMatrix(target.matrixWorld)).normalize();
  const frame = cardFrame(referenceNormal);
  const worldNormal = frame.normal;
  const angle = entry.finish === 'spray' ? 0 : THREE.MathUtils.degToRad(entry.rotation);
  const right = frame.right.clone().multiplyScalar(Math.cos(angle)).addScaledVector(frame.up, Math.sin(angle));
  const up = frame.up.clone().multiplyScalar(Math.cos(angle)).addScaledVector(frame.right, -Math.sin(angle));
  const width = frame.width * .28 * entry.size / 100 * stickerScale(entry);
  if (entry.finish === 'spray') worldPoint.addScaledVector(frame.up, -width * (entry.texture.userData.paintAnchorOffset || 0));
  const image = entry.texture.image;
  const height = width * image.height / image.width;
  const surface = captureSurface(worldPoint, worldNormal, up, width, height, frame.width);
  const geometry = new THREE.PlaneGeometry(width, height, 128, 128);
  const positions = geometry.attributes.position;
  const uvs = geometry.attributes.uv;
  const foldAmount = entry.finish === 'spray' ? 0 : (entry.folds ?? 35) / 100;
  entry.seed ??= freshFoldSeed(entry.designKey || 'import');
  entry.organic ||= organicProfile(entry);
  const clearance = frame.width * 0.0009;
  const lift = width * 0.026 * foldAmount;
  const point = new THREE.Vector3();
  const flat = new THREE.Vector3();
  const edgeState = { outward: new THREE.Vector3() };
  const deformation = {};
  const anchorDepth = worldPoint.clone().sub(frame.center).dot(worldNormal);
  const bendRadius = frame.front + clearance;
  let backSurface = null, wrappedVertices = 0;
  for (let i = 0; i < positions.count; i++) {
    const u = uvs.getX(i), v = uvs.getY(i);
    organicDeformation(entry.organic, u, v, foldAmount, deformation);
    const x = (u - 0.5 + deformation.x) * width;
    const y = (v - 0.5) * height + deformation.y * width;
    const folds = lift * deformation.ridges + width * deformation.z;
    flat.copy(worldPoint).addScaledVector(right, x).addScaledVector(up, y);
    const edge = boundaryAt(frame, flat, edgeState);
    if (edge.distance <= 0) {
      const faceHeight = anchorDepth + Math.max(surface(u, v), surface(u + deformation.x, v + deformation.y * width / height));
      point.copy(frame.center).addScaledVector(frame.right, edge.x).addScaledVector(frame.up, edge.y)
        .addScaledVector(worldNormal, Math.max(frame.front, faceHeight) + clearance + folds);
    } else {
      wrappedVertices++;
      const angle = Math.min(Math.PI, edge.distance / bendRadius);
      const remainder = Math.max(0, edge.distance - Math.PI * bendRadius);
      const across = bendRadius * Math.sin(angle) - remainder;
      const px = edge.x - edge.nx * edge.distance + edge.nx * across;
      const py = edge.y - edge.ny * edge.distance + edge.ny * across;
      let depth = bendRadius * Math.cos(angle);
      if (angle === Math.PI) {
        backSurface ||= captureSurface(frame.center, worldNormal.clone().negate(), frame.up, frame.width, frame.height, frame.width);
        depth = -Math.max(-frame.back, backSurface(0.5 - px / frame.width, 0.5 + py / frame.height)) - clearance;
      }
      point.copy(frame.center).addScaledVector(frame.right, px).addScaledVector(frame.up, py).addScaledVector(worldNormal, depth);
      point.addScaledVector(edge.outward, Math.sin(angle) * folds).addScaledVector(worldNormal, Math.cos(angle) * folds);
    }
    positions.setXYZ(i, point.x, point.y, point.z);
  }
  geometry.applyMatrix4(target.matrixWorld.clone().invert());
  geometry.computeVertexNormals(); geometry.computeBoundingSphere();
  const material = new THREE.MeshPhysicalMaterial({ map: entry.texture, transparent: true,
    side: THREE.DoubleSide, alphaTest: entry.finish === 'spray' ? .002 : .025, roughness: entry.finish === 'spray' ? .95 : .38, metalness: 0,
    clearcoat: entry.finish === 'spray' ? 0 : .28, clearcoatRoughness: 0.42, depthWrite: true,
    polygonOffset: true, polygonOffsetFactor: -1, polygonOffsetUnits: -1 });
  if (entry.finish === 'spray') {
    entry.paintStarted ??= performance.now();
    entry.paintProgress ||= { value: matchMedia('(prefers-reduced-motion: reduce)').matches ? 1 : 0 };
    material.onBeforeCompile = shader => {
      shader.uniforms.dripReveal = { value: entry.texture.userData.dripReveal };
      shader.uniforms.dripProgress = entry.paintProgress;
      shader.fragmentShader = 'uniform sampler2D dripReveal; uniform float dripProgress;\n' + shader.fragmentShader;
      shader.fragmentShader = shader.fragmentShader.replace('#include <alphamap_fragment>', '#include <alphamap_fragment>\nvec4 drip = texture2D(dripReveal, vMapUv);\ndiffuseColor.a *= mix(1.0, smoothstep(drip.r - 0.04, drip.r + 0.04, dripProgress * 1.1), drip.a);');
    };
    if (entry.paintProgress.value < 1) { wetPaint.add(entry); if (!paintFrame) paintFrame = requestAnimationFrame(animatePaint); }
  }
  if (entry.finish !== 'spray') material.onBeforeCompile = shader => {
    shader.fragmentShader = shader.fragmentShader.replace('#include <color_fragment>', '#include <color_fragment>\nif (!gl_FrontFacing) diffuseColor.rgb = vec3(0.92);');
  };
  entry.decal = new THREE.Mesh(geometry, material); entry.decal.name = entry.finish === 'spray' ? 'Spray-painted outline' : 'Card sticker';
  entry.decal.userData.finish = entry.finish;
  entry.decal.renderOrder = 10 + entries().indexOf(entry); entry.decal.userData.cardSticker = true;
  entry.decal.userData.noHit = true;
  entry.decal.userData.folds = entry.folds ?? 35;
  entry.decal.userData.foldSeed = entry.seed;
  entry.decal.userData.stickerId = entry.id;
  entry.decal.userData.customText = entry.customText;
  entry.decal.userData.wrappedVertices = wrappedVertices;
  entry.decal.userData.edgeWrap = true;
  target.add(entry.decal); render();
}
async function place(event) {
  if (performance.now() < suppressClickUntil) return;
  if (!ready || !activeDesign) return;
  if (!activeDesign.url) { message('Type your graffiti text and wait for the preview before placing it.'); return; }
  const rect = viewer.getBoundingClientRect();
  const ray = new THREE.Raycaster(); model.updateWorldMatrix(true, true);
  ray.setFromCamera(new THREE.Vector2((event.clientX - rect.left) / rect.width * 2 - 1, 1 - (event.clientY - rect.top) / rect.height * 2), scene.camera);
  const hit = ray.intersectObjects(meshes, false).find(result => result.face);
  if (!hit) { message('Click directly on the card to attach a sticker.'); return; }
  const stamp = generation, key = cardKey(), design = { ...activeDesign };
  const entry = { meshIndex: meshes.indexOf(hit.object), point: hit.object.worldToLocal(hit.point.clone()),
    normal: hit.face.normal.clone(), size: randomSliderValue(sizeInput), rotation: randomSliderValue(rotationInput), folds: randomSliderValue(foldsInput),
    id: ++stickerSequence, seed: freshFoldSeed(design.url), designKey: design.url, customText: design.custom ? design.text : null,
    finish: finishInput.value, paintColour: nextPaintColour || randomPaintColour(), decal: null };
  nextPaintColour = null;
  message('Attaching sticker…');
  try {
    entry.texture = await textureFor(entry.finish === 'spray' && design.custom ? { url: design.paintUrl } : design);
    if (generation !== stamp || cardKey() !== key) return;
    if (entry.finish === 'spray') {
      entry.paintSource = entry.texture;
      entry.folds = 0;
    }
    if (!cards.has(key)) cards.set(key, []);
    cards.get(key).push(entry); rebuild(entry); selectedEntry = entry;
    if (entry.finish === 'spray') { paintColour.value = entry.paintColour; syncPaintPalette(); }
    foldsInput.disabled = entry.finish === 'spray';
    sizeInput.value = entry.size; rotationInput.value = entry.rotation; foldsInput.value = entry.folds;
    message(entry.finish === 'spray' ? `${design.label} sprayed onto the card. Adjust size or rotation, or place another.` : `${design.label} attached. Adjust size, rotation or folds, or click to place another.`);
  } catch (error) { console.error(error); message('Could not load this sticker. Try importing a PNG or WebP.'); }
}
function stickerScale(entry) {
  const base = entry.customText || entry.designKey === './stickers/v-diecut-neighborhood.webp' ? 2 : 1;
  const textDesign = entry.customText || /v-diecut-rent-day|v-diecut-neighborhood/.test(entry.designKey);
  return base * (textDesign ? 1.35 : 1);
}
function randomSliderValue(input) {
  const minimum = Number(input.min), step = Number(input.step) || 1;
  const steps = Math.floor((Number(input.max) - minimum) / step);
  return minimum + Math.floor(Math.random() * (steps + 1)) * step;
}
viewer.addEventListener('click', event => {
  if (activeDesign || drag || performance.now() < suppressClickUntil) event.preventDefault();
}, true);
viewer.addEventListener('click', place);
function activateModel() {
  if (!cardAvailable) return;
  generation++; ready = false;
  try {
    guardUnpresentedARScene();
    scene = getScene(); model = scene.model; meshes = [];
    model.traverse(object => { if (object.isMesh && !object.userData.cardSticker) meshes.push(object); });
    entries().forEach(disposeDecal);
    entries().forEach(rebuild); ready = true;
    message(activeDesign ? 'Click the card surface to attach your sticker.' : 'Pick a sticker, then click the card to attach it.');
  } catch (error) { console.error(error); message(error.message); }
}
viewer.addEventListener('load', activateModel);
viewer.addEventListener('card-selection', event => {
  cardAvailable = event.detail.hasModel;
  document.querySelector('.sticker-tools').hidden = !cardAvailable;
  if (!cardAvailable) releaseSheets();
  else if (!event.detail.sourceChanged && viewer.loaded) activateModel();
});
// Detach custom geometry before model-viewer caches/clones a glTF scene. Its
// material API only knows the original glTF primitive associations.
function releaseSheets() {
  finishDrag(); selectedEntry = null;
  ready = false; generation++;
  for (const list of cards.values()) list.forEach(disposeDecal);
}
document.addEventListener('click', event => {
  const option = event.target.closest('[data-card-variant], [data-card]');
  if (option && !option.disabled && option.getAttribute('aria-pressed') !== 'true') releaseSheets();
}, true);
new MutationObserver(releaseSheets).observe(viewer, { attributes: true, attributeFilter: ['src'] });
document.querySelector('#sticker-done').addEventListener('click', () => setDesign(null));
document.querySelector('#sticker-new-folds').addEventListener('click', () => {
  if (!ready) return;
  const entry = selectedEntry || entries().at(-1);
  if (!entry) { message('Add or select a sticker to give it a new fold pattern.'); return; }
  if (entry.finish === 'spray') { message('Spray paint follows the card surface and has no paper folds.'); return; }
  entry.seed = freshFoldSeed(entry.designKey || 'import'); entry.organic = null;
  rebuild(entry);
  message('New organic folds and curls applied to this sticker.');
});
document.querySelector('#sticker-undo').addEventListener('click', () => {
  generation++; const entry = entries().pop(); if (entry) { disposeDecal(entry); if (entry.finish === 'spray') entry.texture.dispose(); }
  if (selectedEntry === entry) selectedEntry = null;
  render(); message(entry ? 'Last sticker removed.' : 'This card has no stickers yet.');
});
document.querySelector('#sticker-clear').addEventListener('click', () => {
  selectedEntry = null;
  generation++; entries().forEach(entry => { disposeDecal(entry); if (entry.finish === 'spray') entry.texture.dispose(); }); cards.set(cardKey(), []); render(); message('Stickers cleared from this card.');
});
for (const input of [sizeInput, rotationInput, foldsInput]) input.addEventListener('input', () => {
  if (!ready) return;
  const entry = selectedEntry || entries().at(-1); if (!entry) return;
  entry.size = Number(sizeInput.value); entry.rotation = Number(rotationInput.value); entry.folds = entry.finish === 'spray' ? 0 : Number(foldsInput.value); rebuild(entry);
});
finishInput.addEventListener('change', () => {
  selectedEntry = null;
  foldsInput.disabled = finishInput.value === 'spray';
  message(finishInput.value === 'spray' ? 'Spray outline selected. Choose a design and click the card to paint it.' : 'Vinyl sticker selected. Choose a design and click the card to attach it.');
});
document.querySelector('#sticker-file').addEventListener('change', async event => {
  const file = event.target.files[0]; if (!file) return;
  if (!['image/png', 'image/webp', 'image/jpeg'].includes(file.type) || file.size > 20 * 1024 * 1024) {
    message('Choose a PNG, WebP, or JPEG image under 20 MB.'); return;
  }
  const url = URL.createObjectURL(file), design = { url, label: file.name };
  try { await textureFor(design); designs.push(design); addButton(design); setDesign(design); }
  catch { URL.revokeObjectURL(url); message('This image could not be opened.'); }
  event.target.value = '';
});
document.querySelector('.sticker-tools').hidden = !cardAvailable;
if (viewer.loaded) activateModel();
