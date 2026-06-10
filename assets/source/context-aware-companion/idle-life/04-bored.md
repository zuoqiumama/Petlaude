# Idle Life — Bored

## When This Plays
Pet has been idle for 10+ minutes with no mouse activity.

## Frames Needed: 2

### Frame 1 — Chin Rest
The character sits/leans with one hand propping up its chin, eyes half-lidded and droopy, looking off to the side with a bored expression. Body slouched.

### Frame 2 — Lazy Kick
Same seated/leaning posture but one foot is extended forward in a lazy kick. Expression unchanged — still bored. The other hand rests at its side.

## Prompt
(Attach reference image of the pet character)

```
Using the attached character as exact reference — same art style, proportions, colors, line weight.

Generate 2 separate PNG images, 512x512, transparent background, character centered at ~60-70% canvas size:

Image 1: The character in a bored posture — one hand propping up its chin, eyes half-lidded and droopy, looking off to the side. Body slouched, disinterested expression.

Image 2: Same bored posture but one foot lazily kicks outward. Same half-lidded expression. Other hand resting at its side.

Do NOT change the character design. Only change the pose and expression. No background, no ground shadow, no borders.
```

## Animation Plan (Claude will implement)
- Alternate Frame 1 ↔ Frame 2 with slow crossfade (1.5s each direction)
- Total loop: 5s
- CSS: very subtle body sway (translateX -1px → 1px) for breathing feel
- Overlay: a tiny dust ball or pebble near the kicking foot (CSS circle, bounced on kick frame)
