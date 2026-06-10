# Context Reaction — First Session of the Day

## When This Plays
First coding session starts today (no prior session since midnight).

## Frames Needed: 2

### Frame 1 — Morning Stretch
The character stretching both arms up high above its head, body elongated, eyes closed, mouth open in a big yawn/stretch. Just woke up energy.

### Frame 2 — Energetic Hello
The character waving hello with one hand, eyes wide open and bright, big excited smile. Body bouncy and alert. Full of energy, ready to work.

## Prompt
(Attach reference image of the pet character)

```
Using the attached character as exact reference — same art style, proportions, colors, line weight.

Generate 2 separate PNG images, 512x512, transparent background, character centered at ~60-70% canvas size:

Image 1: The character in a big morning stretch — both arms reaching up high above its head, body elongated, eyes closed, mouth open in a yawn. Just-woke-up energy.

Image 2: The character waving hello energetically — one hand waving, eyes wide open and bright, big excited smile. Bouncy alert posture, full of energy, ready to start the day.

Do NOT change the character design. Only change the pose and expression. No background, no ground shadow, no borders.
```

## Animation Plan (Claude will implement)
- Frame 1 (1.5s) → Frame 2 (1.5s), single play
- CSS on Frame 1: vertical stretch (scaleY 1.0 → 1.03 → 1.0)
- CSS on Frame 2: bounce entry (translateY -5px → 0 with overshoot)
- Overlay: 2-3 small sparkle/star particles appear around character in Frame 2
