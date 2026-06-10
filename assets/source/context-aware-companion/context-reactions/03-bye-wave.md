# Context Reaction — Session End Wave

## When This Plays
An agent process exits (session ends).

## Frames Needed: 2

### Frame 1 — Wave Left
The character with one hand raised and tilted to the left in a wave gesture. Soft bittersweet smile, eyes open and looking forward. The body faces the viewer.

### Frame 2 — Wave Right
Same pose but the raised hand tilts to the right. Same expression.

## Prompt
(Attach reference image of the pet character)

```
Using the attached character as exact reference — same art style, proportions, colors, line weight.

Generate 2 separate PNG images, 512x512, transparent background, character centered at ~60-70% canvas size:

Image 1: The character waving goodbye — one hand raised above its head, palm open, hand tilted to the LEFT. Soft bittersweet smile (happy but a little sad). Eyes open, looking forward. Body facing the viewer.

Image 2: Identical pose but the raised hand is now tilted to the RIGHT. Same expression and body position.

Do NOT change the character design. Only change the pose and expression. No background, no ground shadow, no borders.
```

## Animation Plan (Claude will implement)
- Alternate Frame 1 ↔ Frame 2 rapidly (0.4s each) for wave motion, 3 cycles
- Total duration 2.5s, single play
- CSS: slight body sway (translateX -2px → 2px) synced with wave
- Overlay: none
