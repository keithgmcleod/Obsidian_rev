# Obsidian_rev — interactive 3D site

A responsive single-page viewer for the updated Obsidian card. The refreshed 2K GLB includes its materials and textures, with interactive cursor tilt and the studio lighting and reflection styling from the original site.

## Stickers

Pick artwork under **Make it yours**, then click the card to add it. Click and drag existing stickers to move them; overhang folds around the card edges and onto the back. Drag back onto the face to unfold. Size, Rotation and Folds adjust the selected sticker. PNG, WebP and JPEG imports stay in your browser. Undo and Clear affect the current card; placements remain separate when switching Blue and Obsidian and reset on page refresh.

Every sticker instance receives a fresh organic pattern, including repeated copies of the same design. Curved creases, small wrinkles and localized edge curls follow the artwork's actual transparent cutout. The pattern stays stable through moving, resizing, flipping and switching cards. **Folds** controls its strength; **New folds** gives only the selected sticker another variation. At zero strength, the organic folds and curls are flat while card-edge wrapping remains active.

Choose **Done placing**, then click a blank card area or press Enter to flip it. Clicking or dragging a sticker selects it instead of flipping the card. Palladium remains a placeholder, with sticker controls hidden until a model is supplied.

Sticker sheets sample the full model surface and approximate its rounded edges and thickness. Geometry attachment uses an isolated bridge to the existing pinned model-viewer 4.4.0 scene. Retest the bridge before upgrading. The original card models, materials, lighting, camera-orbit tilt and reflection behavior are preserved.

## Preview locally

Serve this folder over HTTP, then open the local address in a browser. For example, run `python -m http.server 8000` from this folder and visit `http://localhost:8000`.

## GitHub Pages

The included workflow deploys the site to GitHub Pages whenever code is pushed to `main`, and supports manual runs from Actions. It reassembles the uploaded GLB parts into the model file before publishing. Set **Settings → Pages → Build and deployment → Source** to **GitHub Actions** if it is not selected already.

Custom graffiti replaces Bilt 10x in the sticker picker. Enter up to 28 characters; the preview uses the bundled Knerd Fill font and gold bubble lettering. Click the card to place independent copies. Text is rendered locally in the browser. Each copy retains its own text, folds and edge wrapping.
