# Context Reaction — Error Comfort

## When This Plays
3+ errors within 10 minutes. Plays once during idle after the error streak.

## Frames Needed: 2

### Frame 1 — Worried Look
The character with a worried/sympathetic expression — eyebrows angled up in concern, sweat drop on forehead, hands clasped together nervously.

### Frame 2 — Offering Tissue
The character extending one arm forward, holding a small tissue/handkerchief toward the viewer. Still worried expression but with a gentle encouraging half-smile. "It's okay" energy.

## Prompt
(Attach reference image of the pet character)

```
Using the attached character as exact reference — same art style, proportions, colors, line weight.

Generate 2 separate PNG images, 512x512, transparent background, character centered at ~60-70% canvas size:

Image 1: The character looking worried and sympathetic — eyebrows angled upward in concern, a small sweat drop on its forehead, hands clasped together nervously.

Image 2: The character extending one arm forward holding a small white tissue/handkerchief toward the viewer. Still worried eyebrows but now with a gentle encouraging half-smile. Caring, supportive body language.

Do NOT change the character design. Only change the pose and expression. No background, no ground shadow, no borders.
```

## Animation Plan (Claude will implement)
- Frame 1 (1.5s) → Frame 2 (2.5s), single play
- CSS on Frame 2: arm extends forward (translateX 3px ease-out)
- Overlay: sweat drop on Frame 1 (CSS opacity pulse), small heart on Frame 2 (float up + fade)
