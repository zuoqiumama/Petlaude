# Context Reaction — Token Milestone Celebration

## When This Plays
Daily token usage reaches a round milestone (every 100k tokens).

## Frames Needed: 1

### Frame 1 — Jumping with Joy
The character jumping up in the air with both arms raised high, body lifted off the ground. Eyes squeezed shut with pure excitement, wide open smile. Energetic, celebratory pose.

## Prompt
(Attach reference image of the pet character)

```
Using the attached character as exact reference — same art style, proportions, colors, line weight.

Generate 1 PNG image, 512x512, transparent background, character centered at ~60-70% canvas size:

The character jumping up in the air with both arms raised high in celebration. Feet clearly off the ground. Eyes squeezed shut with pure excitement, wide open joyful smile. Maximum happiness pose, whole body expressing celebration.

Do NOT change the character design. Only change the pose and expression. No background, no ground shadow, no borders.
```

## Animation Plan (Claude will implement)
- Single frame, 3.5s single play
- CSS: jump arc (translateY 0 → -15px → 0, ease-in-out 0.6s) repeats 2x then settle
- CSS: slight rotation (-5deg → 5deg) during jump for liveliness
- Overlay: confetti particles — 8-12 small colored rectangles/circles (random colors from palette) scatter outward with CSS animation (random translateX/Y + rotate + opacity fade)
- Overlay: 2-3 small sparkle bursts (CSS scale 0→1→0 + opacity)
