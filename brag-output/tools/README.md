# Building the brag videos

Both videos (`../brag.mp4`, 1920x1080, and `../brag-vertical.mp4`, 1080x1920) come from one template.
Edit the template, then run `./build.sh` to rebuild both.

| File | What it is |
| --- | --- |
| `index.tpl.html` | The video: every scene, its styles and its GSAP timeline. Times are seconds on the music's beat grid (114.84 BPM, beats at 1.60 + 0.5236·n). |
| `vertical.css` | The phone layout, added on top of the template for the vertical version. |
| `gen.mjs` | Fills the template (headline words, typed prompts, sound effects, home page cards, AI logos, music loudness, cursor targets) and writes `../composition*/index.html`. |
| `targets.cjs` | Opens a generated composition in Chromium and measures where the cursor has to click; writes the JSON `gen.mjs` takes. |
| `targets-*.json` | The last measured targets for each format. |
| `figs.json` | The six showcase cards from the home page (`src/dashboard/home.ts`). |
| `rms.json`, `rms.py` | The music's loudness per frame (for the glow behind the live app), and the script that measured it. |
| `build.sh` | Generate, measure, check, render and bake the poster, for both formats. |

- `gen.mjs` reads the AI logos from `src/dashboard/logos.ts`, so the video always shows the product's own marks.
- To refresh `figs.json` after the home page cards change:
  `npx esbuild src/dashboard/home.ts --bundle --platform=node --format=esm --outfile=/tmp/home.mjs --loader:.md=text --loader:.css=text --loader:.wasm=binary`,
  then save the `<figure>` blocks of `(await import("/tmp/home.mjs")).homePage().text()` as a JSON array.
- Adding time in the middle: move every later scene, tween and sound effect by a whole number of beats, so cuts stay on the beat.
- Music: Sascha Ende, ende.app (CC BY 4.0). Sound effects: Kenney and unicae_games (CC0).
