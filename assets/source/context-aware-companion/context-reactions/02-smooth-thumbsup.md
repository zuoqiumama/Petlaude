# Context Reaction — Smooth Work Thumbs Up

## When This Plays
30+ minutes of continuous working state with zero errors.

## Frames Needed: 1

### Frame 1 — Proud Thumbs Up
The character giving an enthusiastic thumbs up with one hand raised high. Eyes are happy crescents (closed with joy), big confident smile. Chest puffed out slightly with pride.

## Prompt
(Attach reference image of the pet character)

```
Using the attached character as exact reference — same art style, proportions, colors, line weight.

Generate 1 PNG image, 512x512, transparent background, character centered at ~60-70% canvas size:

The character giving an enthusiastic thumbs up with one hand raised high. Eyes are happy crescents (closed with joy), big confident smile. Chest slightly puffed out with pride. The other arm at its side or on its hip. Cheerful, encouraging body language.

Do NOT change the character design. Only change the pose and expression. No background, no ground shadow, no borders.
```

## Animation Plan (Claude will implement)
- Single frame, 3s single play
- CSS: pop-in scale (0.8 → 1.05 → 1.0) on entry
- Thumb hand: subtle pulse (scale 1.0 → 1.08 → 1.0 repeat)
- Overlay: 3-4 small sparkle/star particles around the raised hand (CSS rotate + opacity + scale)
