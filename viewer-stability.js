// Keep large, inactive card models out of the viewer's GPU/CPU cache.
customElements.whenDefined('model-viewer').then(() => {
  const Viewer = customElements.get('model-viewer');
  Viewer.modelCacheSize = 0;
  Viewer.minimumRenderScale = .25;
});

const stabilityViewer = document.querySelector('#obsidian-model');
const safeGraphics = new URLSearchParams(location.search).get('safe') === '1';
function reduceTextureMemory() {
  if (!safeGraphics) return;
  const sceneKey = Object.getOwnPropertySymbols(stabilityViewer).find(key => key.description === 'scene');
  const scene = stabilityViewer[sceneKey];
  if (!scene?.model) return;
  const textures = new Set();
  scene.model.traverse(object => {
    if (!object.isMesh || object.userData.cardSticker) return;
    for (const material of [object.material].flat()) {
      for (const value of Object.values(material)) if (value?.isTexture) textures.add(value);
    }
  });
  for (const texture of textures) {
    const image = texture.image;
    if (!image?.width || Math.max(image.width, image.height) <= 1024) continue;
    const canvas = document.createElement('canvas');
    const scale = 1024 / Math.max(image.width, image.height);
    canvas.width = Math.round(image.width * scale); canvas.height = Math.round(image.height * scale);
    canvas.getContext('2d').drawImage(image, 0, 0, canvas.width, canvas.height);
    texture.dispose(); texture.image = canvas; texture.needsUpdate = true;
  }
  stabilityViewer.shadowIntensity = 0;
  scene.queueRender();
}
stabilityViewer.addEventListener('load', reduceTextureMemory);
if (stabilityViewer.loaded) reduceTextureMemory();
