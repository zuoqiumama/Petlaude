# Idle Life — Nap Hint (Late Night)

## When This Plays
System time is between 23:00-06:00, pet is idle. Suggests the user should go to sleep.

## Frames Needed: 2

### Frame 1 — Head Drooping
The character standing but head drooping forward, eyes closed, body slightly slumped. About to fall asleep on its feet.

### Frame 2 — Startled Awake
The character snapping back upright with wide startled eyes, mouth slightly open in surprise. Arms slightly raised as if catching balance. "I wasn't sleeping!" energy.

## Prompt
(Attach reference image of the pet character)

```
Using the attached character as exact reference — same art style, proportions, colors, line weight.

Generate 2 separate PNG images, 512x512, transparent background, character centered at ~60-70% canvas size:

Image 1: The character dozing off while standing — head drooping forward, eyes fully closed, body slightly slumped, about to fall asleep on its feet.

Image 2: The character suddenly startled awake — eyes wide open, mouth slightly open in surprise, body snapped upright, arms slightly raised as if catching balance.

Do NOT change the character design. Only change the pose and expression. No background, no ground shadow, no borders.
```

## Animation Plan (Claude will implement)
- Frame 1 (2s) → Frame 2 (0.8s) → Frame 1 (1.2s) loop
- CSS on Frame 1: slow head nod (translateY 2px) to simulate drooping
- CSS on Frame 2: quick jolt (translateY -3px snap)
- Overlay: "Z z z" text elements float up during Frame 1 (CSS translateY + opacity)
