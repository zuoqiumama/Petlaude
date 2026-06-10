# Idle Life — Curious (Mouse Hover)

## When This Plays
User's mouse cursor hovers near the pet for 3+ seconds while idle.

## Frames Needed: 1

### Frame 1 — Curious Head Tilt
The character tilting its head to one side, eyes wide and curious, leaning slightly forward as if examining something. One eyebrow slightly raised. Attentive, interested body language.

## Prompt
(Attach reference image of the pet character)

```
Using the attached character as exact reference — same art style, proportions, colors, line weight.

Generate 1 PNG image, 512x512, transparent background, character centered at ~60-70% canvas size:

The character tilting its head to one side with wide curious eyes, leaning slightly forward as if examining something interesting. One eyebrow slightly raised. Attentive, interested body language. Mouth slightly open in wonder.

Do NOT change the character design. Only change the pose and expression. No background, no ground shadow, no borders.
```

## Animation Plan (Claude will implement)
- Single frame with CSS animation
- Gentle head tilt oscillation (rotate -5deg → 0 → 5deg) over 2s
- Overlay: small "?" symbol floats above head, bobs gently (translateY oscillation + opacity pulse)
