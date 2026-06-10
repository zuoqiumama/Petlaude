# Touch Reaction — Shake Off (After Drag Release)

## When This Plays
User drags the pet and releases it.

## Frames Needed: 2

### Frame 1 — Ruffled / Shaking
The character with a ruffled, messy appearance — fur/surface disheveled, body blurred slightly as if shaking vigorously. Eyes wide, startled expression. Motion lines on both sides suggesting rapid shaking.

### Frame 2 — Composed Again
The character back to a neat, composed appearance. Straightening up with a satisfied nod, eyes closed with a small dignified smile. "I'm fine" energy.

## Prompt
(Attach reference image of the pet character)

```
Using the attached character as exact reference — same art style, proportions, colors, line weight.

Generate 2 separate PNG images, 512x512, transparent background, character centered at ~60-70% canvas size:

Image 1: The character looking ruffled and disheveled after being grabbed — surface/fur messy, body slightly blurred as if shaking vigorously, eyes wide with a startled expression. Small motion lines on both sides of the body suggesting rapid side-to-side shaking.

Image 2: The character perfectly composed and neat again — straightening up with a satisfied expression, eyes closed with a small dignified smile, one hand smoothing its surface. Confident "I'm fine now" posture.

Do NOT change the character design. Only change the pose and expression. No background, no ground shadow, no borders.
```

## Animation Plan (Claude will implement)
- Frame 1 (1.2s) → Frame 2 (0.8s), single play
- CSS on Frame 1: rapid horizontal shake (translateX -4px → 4px, 0.08s period) — 15 oscillations
- CSS transition to Frame 2: smooth settle (translateX → 0, scale 0.97 → 1.0)
- Overlay: small puff/dust particles fly off during shake (CSS translateX outward + opacity fade)
