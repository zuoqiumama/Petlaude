# Idle Life — Yawn & Stretch

## When This Plays
Pet has been idle (no coding session active) for 2+ minutes. Random trigger.

## Frames Needed: 2

### Frame 1 — Mid-Yawn
The character is yawning with mouth wide open. One arm stretches upward above its head, the other hand covers the side of its mouth. Eyes are squeezed shut. Body leaning back slightly.

### Frame 2 — Post-Stretch Settle
The character finishes stretching, arms coming back down, eyes half-open with a relaxed/sleepy expression. Slight slouch. Looks content.

## Prompt
(Attach reference image of the pet character)

```
Using the attached character as exact reference — same art style, proportions, colors, line weight.

Generate 2 separate PNG images, 512x512, transparent background, character centered at ~60-70% canvas size:

Image 1: The character mid-yawn — mouth wide open, one arm stretching up above head, other hand covering mouth, eyes squeezed shut, body leaning back slightly.

Image 2: The character settling after a stretch — arms lowering, eyes half-open, relaxed sleepy expression, slight slouch, content look.

Do NOT change the character design. Only change the pose and expression. No background, no ground shadow, no borders.
```

## Animation Plan (Claude will implement)
- Frame 1 → Frame 2 crossfade over 3s
- CSS: gentle vertical bounce (translateY -3px → 0) during stretch
- Overlay: none
