# Brag Plan: Formelab

## What is this app?
Formelab hosts the little apps your AI builds for you: describe what you need in plain words, and it's live at its own link, with sign-in, storage and sharing already handled.

## The angle
The home page already says the bold thing: "SaaS is dead." The video takes it literally. We strike out SaaS, then prove the claim by showing one person typing a sentence and getting a working booking page, followed by a wall of real-looking apps that regular people made instead of buying software (a studio owner, a landlord, an agency, a couple planning a wedding).

## Hook (first 2-3 seconds)
The marker sticker "psst, you can build this stuff now" scribbles in, giant "SaaS" lands, and an orange line slashes through it on the first strong beat. "is dead." lands in purple.

## Key moments (the middle)
- A prompt box: "Make a class booking page for my studio" types out, send is clicked, and the real Class booking app from the home page builds in at `studio.formelab.app`.
- The cursor picks the 10:00am slot and a "New booking · Maya R. · Tue, 10:00am" toast pops: the app is already doing its job.
- "Built with Formelab": five more apps from the home page rail land one per beat, each captioned with who made it ("Rent tracker by a landlord with 12 units").

## Outro / punchline
Logo, "Software that fits you, not the other way around." is already said, so the end card is the mark, "SaaS is dead.", and the real CTA "Join the waitlist" getting clicked, with "Free early access." and formelab.ai.

## User flow worth showing
Describe it in plain words (prompt types) → it's live (the booking app appears at its own address) → someone uses it (slot clicked, "New booking" toast).

## Tone
- Preset: default
- Creative direction: confident indie launch, a little cheeky
- Interpretation: clean and warm like the home page, quick cuts on the beat, one joke (the strike-through) played big, then let the product prove it.

## Format: landscape — 1920x1080
## Duration: 21.6s

## Visual identity (from the project)
- Background: #FAFAF8 with the #E8E5DE 24px dot grid (home.css)
- Accent: #5B4CF5 (purple), pop #FF6B4A (orange strike and logo dot)
- Text: #111110, soft #6E6D68
- Display font: Bricolage Grotesque 800 (src/fonts)
- Body font: Inter
- Sticker font: Permanent Marker
- Strongest visual element: the "~~SaaS~~ is dead." hero and the showcase app cards (src/dashboard/home.ts, home.css), reused as-is

Privacy: the showcase apps already use fictional names (Ana Ruiz, Maya R., Priya, the Okafors); no real user data, emails or internal hosts appear. `studio.formelab.app` is an invented namespace.

## Share copy (draft)
SaaS is dead. I typed one sentence and got a class booking page with its own link. Formelab hosts whatever your AI builds for you.

## Audio direction
- Role: warm, upbeat bed with motion-matched accents
- Music: happy-beats-business-moves-vol-11 (114.84 BPM), from 0s, fade out over the last 1.2s
- Music treatment: enters at full bed level, ducks nothing (no voice), fades under the end card
- Music cue guidance: preset read (`cues/...vol-11...`). Strong cues locked: 1.60s (strike-through), 3.70s (logo reveal), 8.96s (app appears after send). Beat grid 13.70, 14.22, 14.76, 15.28, 15.81 for the five montage cards; the full set then holds to 18.44s so captions can be read. Outro lands on the 18.44 beat.
- Audio-reactive treatment: subtle; a soft purple glow behind the hero app card breathes with the bed's RMS. No waveforms.
- SFX posture: moderate, motion-matched
- Audio-coupled moments: strike-through thud, key ticks under the typed prompt, clicks on send / slot / CTA, a pop on the toast, soft card slides on the montage, one bell on the end card
- Restraint rule: keys quiet under the music, never more than one effect per beat, no effect without a cause on screen

## Storyboard

### Scene 1 — Hook — 0.00-3.70s (3.7s)
Sticker "psst, you can build this stuff now" (orange marker, tilted) draws in; "SaaS" lands at 0.4s; the strike line sweeps across at 1.60s; "is dead." lands at 2.12s. Hold.
Sequential/interaction: yes, sticker, word, strike, words in order
Audio intent: confident open
Audio-coupled idea: soft thud on the strike
Music: bed from 0s
Transition mood: blur swap → Scene 2

### Scene 2 — Reveal — 3.70-7.38s (3.7s)
Formelab logo (purple tilted mark with the orange dot) lands at 3.70s; "Software that fits you, not the other way around." comes in word by word, then holds ~2.8s.
Sequential/interaction: per-word reveal
Audio intent: lift
Audio-coupled idea: none beyond the beat
Transition mood: morph into the prompt box → Scene 3

### Scene 3 — Ask, it's live, it works — 7.38-13.18s (5.8s)
Label "Ask your AI to build". Prompt types "Make a class booking page for my studio"; cursor clicks send at 8.96s; the Class booking card (from home.ts) rises in with an address pill `studio.formelab.app` and a green "It's live." chip at 9.50s. Cursor clicks 10:00am at 11.06s; "New booking · Maya R. · Tue, 10:00am" toast pops at 11.60s. Hold.
Sequential/interaction: typing, two clicks, toast
Audio intent: playful demo
Audio-coupled idea: key ticks, clicks, toast pop
Transition mood: carry across → Scene 4

### Scene 4 — Built with Formelab — 13.18-18.44s (5.3s)
Label "Built with Formelab"; five showcase cards (Onboarding checklist, Rent tracker, Team poll, Cash dashboard, Wedding RSVPs) land one per beat 13.70-15.81s with their captions, then the full wall holds ~2.6s.
Sequential/interaction: card-by-card, then hold
Audio intent: momentum
Audio-coupled idea: soft card slide per card
Transition mood: dip / blur swap → Scene 5

### Scene 5 — End card — 18.44-21.60s (3.2s)
Logo, "SaaS is dead.", "Join the waitlist" button (cursor click at 19.49s), "Free early access." and formelab.ai. Holds 2s+ before the end.
Sequential/interaction: CTA click
Audio intent: payoff, then fade
Audio-coupled idea: bell on landing, click on CTA
Transition mood: end

**Music mood for this video:** upbeat
**Audio summary:** one bright bed carries the whole film, with a thud on the strike, keys and clicks for the demo, card slides on the wall and one bell on the end card before the music fades.

## Revision 2: the redesigned home page (fl/home-redesign)

Scenes 1, 2 and 5 now use the new home page design; scenes 3 and 4 are unchanged.

- **Scene 1, Hero, 0.00-7.38s:** logo top left; "Early Access now open" pill; "Software that fits you," word by word, then "not the other way around." in purple on the 1.60s strong cue; "Tell your AI what you need. Get an app that's yours." at 3.70s (strong cue) and the email box with "Request early access". It hands off straight to "Ask your AI to build". Replaces the old hook and reveal.
- **Scene 5, End card, 18.44-21.60s:** the new site's purple final card: "put your idea on the wall" (yellow marker), "What would you make?", "Leave your email and we'll send your invite.", the email box, and a cursor click on "Request early access" at 19.49s. Logo and formelab.ai below. The site's "Early access is free..." line was left out: too long to read in the time left.
- Colors follow the new tokens (canvas #FBFAF7, ink #1C1B19, soft #6B6862). "SaaS is dead." no longer appears.
- Poster: 5.5s, the finished hero.
