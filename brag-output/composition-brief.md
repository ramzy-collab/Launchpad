# Hyperframes Composition Brief: Formelab

## Objective
Create a short launch-style brag video for Formelab.

## Output
- Composition directory: `brag-output/composition/`
- Rendered video: `brag-output/brag.mp4`
- Format: landscape — 1920x1080, 30fps
- Duration: 21.6 seconds

## Source Material
- Project root: the Launchpad repo
- Primary files read: `src/dashboard/home.ts` (hero, showcase apps, steps, CTA), `src/dashboard/home.css` (colors, fonts, showcase card styles), `src/dashboard/formelab.css` (`--fl-*` tokens), `README.md`, `CHANGELOG.md`, `src/fonts/`
- Product name: Formelab
- Tagline / strongest claim: "SaaS is dead."
- Key UI to reuse: the showcase `<figure>` cards from `home.ts` with their `home.css` styles, and the hero's strike-through
- Copy that must appear verbatim:
  - psst, you can build this stuff now
  - SaaS is dead.
  - Software that fits you, not the other way around.
  - Ask your AI to build
  - Built with Formelab
  - Join the waitlist
  - Free early access.

## Creative Direction
- Tone preset: default
- Creative direction: confident indie launch, a little cheeky
- Interpretation: warm and clean, cuts on the beat, the strike-through played big
- Angle: take "SaaS is dead." literally, then prove it with one typed sentence becoming a working app, and a wall of apps regular people made
- Hook: marker sticker, giant "SaaS", orange slash at 1.60s, "is dead." in purple
- Outro / punchline: logo, "SaaS is dead.", the "Join the waitlist" button clicked
- Avoid: generic SaaS language, abstract filler, redesigning the cards

## Visual Identity
- Background: #FAFAF8 with #E8E5DE 1px dots on a 24px grid
- Text: #111110 (soft #6E6D68)
- Accent: #5B4CF5; pop #FF6B4A
- Display font: Bricolage Grotesque 800 (`src/fonts/BricolageGrotesque_800ExtraBold.ttf`)
- Body font: Inter (bundled)
- Sticker: Permanent Marker (download into assets/fonts; if unavailable, Bricolage at a tilt)

## Storyboard
Use `brag-output/brag-plan.md` as the creative contract.
1. Hook — 3.7s — sticker, SaaS struck through, "is dead."
2. Reveal — 3.7s — logo, tagline word by word
3. Flow — 5.8s — prompt typed, send, booking app live, slot clicked, "New booking" toast
4. Wall — 5.3s — five showcase cards with captions, one per beat, then hold
5. End card — 3.2s — logo, "SaaS is dead.", Join the waitlist clicked, formelab.ai

## Audio
- Audio role: warm bed with motion-matched accents
- Music: `happy-beats-business-moves-vol-11-by-ende-dot-app.mp3`, fade out over the last 1.2s
- Music cue guidance: bundled preset `assets/music/cues/happy-beats-business-moves-vol-11-by-ende-dot-app.music-cues.json`; locks at 1.60, 3.70, 8.96; beat grid 13.70-15.81 for cards
- Audio-reactive treatment: subtle glow behind the hero app card
- Audio-coupled moments: strike thud, typing keys, clicks (send, slot, CTA), toast pop, card slides, end bell
- SFX analysis guidance: `sfx-analysis.md`; prefer low HF risk
- Credit: "Music: Sascha Ende, ende.app (CC BY 4.0)" in the share copy notes
