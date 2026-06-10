# Context Reaction — Break Reminder

## When This Plays
Continuous coding session running for 1+ hour without breaks.

## Frames Needed: 1

### Frame 1 — Holding Sign
The character holding up a small rectangular sign/placard with both hands. Concerned but caring expression — eyebrows slightly furrowed, gentle worried smile. The sign is blank (text will be added programmatically so it can be localized).

## Prompt
(Attach reference image of the pet character)

```
Using the attached character as exact reference — same art style, proportions, colors, line weight.

Generate 1 PNG image, 512x512, transparent background, character centered at ~60-70% canvas size:

The character holding up a small blank rectangular white sign/placard with both hands, arms extended slightly forward. The sign is plain white with a thin border (text will be added later). Concerned but caring expression — eyebrows slightly furrowed with worry, gentle encouraging smile. Body leaning slightly forward.

The sign should be clearly visible and large enough to fit a short word. Approximately 30-40% of the character's body width.

Do NOT change the character design. Only change the pose and expression. No background, no ground shadow, no borders.
```

## Animation Plan (Claude will implement)
- Single frame, 5s single play
- Sign text added as SVG `<text>` element: "Break!" (en) / "休息一下!" (zh) — localized via i18n
- CSS: sign gently waves (rotate -3deg → 3deg oscillation, 1s period)
- Overlay: small clock icon floats near top-right of character (CSS opacity pulse)
