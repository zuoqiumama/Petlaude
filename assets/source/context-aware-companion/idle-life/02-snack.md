# Idle Life — Snack Time

## When This Plays
Pet has been idle for 3+ minutes. Random trigger.

## Frames Needed: 2

### Frame 1 — Munching
The character holds a tiny cookie/snack in both hands near its mouth. Eyes closed happily, mouth in a content chewing expression. Small crumb particles near the mouth area.

### Frame 2 — Satisfied Belly Pat
The character pats its belly with one hand, the other hand is empty (cookie gone). Eyes are happy crescents, slight smile. Body posture is relaxed and satisfied.

## Prompt
(Attach reference image of the pet character)

```
Using the attached character as exact reference — same art style, proportions, colors, line weight.

Generate 2 separate PNG images, 512x512, transparent background, character centered at ~60-70% canvas size:

Image 1: The character holding a tiny cookie in both hands near its mouth, eyes closed happily, content chewing expression. A few small crumb particles near the mouth.

Image 2: The character patting its belly with one hand, other hand empty. Happy crescent eyes, satisfied smile, relaxed posture.

Do NOT change the character design. Only change the pose and expression. No background, no ground shadow, no borders.
```

## Animation Plan (Claude will implement)
- Frame 1 plays for 2.5s → crossfade to Frame 2 for 1.5s
- CSS: subtle side-to-side sway during munching (rotate -2deg → 2deg)
- Overlay: 2-3 small crumb particles float down with CSS animation (opacity fade + translateY)
