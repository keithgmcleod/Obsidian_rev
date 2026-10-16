# Sticker integration verification

Checked October 16, 2026 against the refreshed viewer's original model-viewer 4.4.0 and Three.js 0.183.0 dependencies.

## Passed

- Six sticker designs, including the Neighbourhood lettering replacement, load locally from this repository.
- Dragging over right, left, top, bottom and rounded corners wraps artwork onto the reverse face on Blue and Obsidian. Geometry remains finite and a single sticker stays attached. Front and back screenshots were inspected.
- Moving the visible front section back onto the face unfolds it.
- Sticker placement and dragging do not flip the card. Done placing followed by a blank click or Enter still flips it.
- Fold adjustments change actual sheet geometry; imports, undo, clear and placing on the back work.
- Each model restores its own placements. The Palladium placeholder hides sticker tools. Returning to an already loaded model restores its stickers even when its source URL has not changed.
- The mobile layout has no horizontal overflow.
- The existing model parts, HDR files, roughness scripts, Blue metallic adjustment, hologram transfer and deployment workflow are unchanged.
- Organic variation checks place three copies of one design and verify independent seeds. New folds changes only the selected instance's seed and vertex positions. Zero strength removes the deformation; restoring the prior strength reproduces the same shape. Moving and card switching preserve the profile. All six bundled designs produce finite geometry, and repeated-copy screenshots were inspected.

## Compatibility notes

The original live viewer independently reproduced an existing effects-module import failure: `three` does not export `LuminanceFormat` for model-viewer-effects 1.5.0 with its existing Three.js 0.183.0 import map. Those effects dependencies are unchanged to preserve the current rendering. The sticker tests exclude exactly that existing import error and observed no new browser errors.

The original live viewer also reproduced model-viewer 4.4.0's AR scene updater dereferencing a null scene during an ordinary card flip. The isolated sticker bridge now skips that updater until an AR scene actually exists; active AR presentations keep the original updater. The initial Obsidian source URL is aligned with the existing app source to avoid a duplicate load and stale initialization.

Surface attachment and wrapping use height sampling and a rounded rectangular card approximation, with a small clearance from the card. This is not a cloth simulation. Placements remain in memory and reset on page reload.

Organic profiles use per-instance random seeds combined with the artwork identity. A cached aspect-aware distance field finds the actual alpha cut boundary. Each seed defines two to four curved creases, two to five wrinkles, and one to three localized curls. Curl geometry bends in-plane as well as lifting off the card; it is not just a color or normal-map effect. Profiles are retained on their sticker entry and regenerated only for a fresh placement or New folds.
