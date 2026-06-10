# Idle Life — Wander

## When This Plays
Pet has been idle for 5+ minutes. Low probability (15%). Triggers actual window movement (50-80px sideways).

## Frames Needed: 1

### Frame 1 — Walking Pose
The character in a mid-step walking pose, one foot forward, arms swinging naturally. Curious expression, looking slightly to one side. Light and bouncy body language.

## Prompt
(Attach reference image of the pet character)

```
Using the attached character as exact reference — same art style, proportions, colors, line weight.

Generate 1 PNG image, 512x512, transparent background, character centered at ~60-70% canvas size:

The character in a mid-step walking pose — one foot forward, the other pushing off, arms swinging naturally in opposite direction to legs. Curious expression, eyes looking slightly to one side. Bouncy, light body language suggesting a casual stroll.

Do NOT change the character design. Only change the pose and expression. No background, no ground shadow, no borders.
```

## Animation Plan (Claude will implement)
- Single frame with CSS animation: gentle up-down bounce (translateY 0 → -4px → 0) at 0.5s interval to simulate steps
- Window actually moves via `windowMove` config (Electron setBounds)
- Duration 2.5s, then crossfade back to idle SVG
