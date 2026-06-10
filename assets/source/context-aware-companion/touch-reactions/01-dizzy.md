# Touch Reaction — Dizzy (Rapid Click)

## When This Plays
User clicks the pet 6+ times rapidly.

## Frames Needed: 1

### Frame 1 — Dizzy & Dazed
The character looking dizzy and disoriented — spiral/swirl eyes (or X-shaped eyes), wobbling posture, one hand on its head as if steadying itself. Comedic dazed expression, mouth in a wavy line.

## Prompt
(Attach reference image of the pet character)

```
Using the attached character as exact reference — same art style, proportions, colors, line weight.

Generate 1 PNG image, 512x512, transparent background, character centered at ~60-70% canvas size:

The character looking dizzy and disoriented — eyes replaced with spirals or X shapes, wobbling unsteady posture, one hand on top of its head as if trying to steady itself. Comedic dazed expression, mouth drawn as a small wavy line. Body tilted slightly to one side.

Do NOT change the character design. Only change the pose and expression. No background, no ground shadow, no borders.
```

## Animation Plan (Claude will implement)
- Single frame, 2.5s single play
- CSS: wobble (rotate -8deg → 8deg, 0.3s period) that gradually dampens
- CSS: slight horizontal drift (translateX -3px → 3px synced with wobble)
- Overlay: 3 small star shapes orbit around the head in a circle (CSS rotate on a circular path + scale pulse)
