# Obsidian_rev — interactive 3D site

A responsive single-page viewer for the updated Obsidian card. The refreshed 2K GLB includes its materials and textures, with interactive cursor tilt and the studio lighting and reflection styling from the original site.

## Preview locally

Serve this folder over HTTP, then open the local address in a browser. For example, run `python -m http.server 8000` from this folder and visit `http://localhost:8000`.

## GitHub Pages

The included workflow deploys the site to GitHub Pages whenever code is pushed to `main`, and supports manual runs from Actions. It reassembles the uploaded GLB parts into the model file before publishing. Set **Settings → Pages → Build and deployment → Source** to **GitHub Actions** if it is not selected already.