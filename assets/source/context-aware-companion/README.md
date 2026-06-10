# Context-Aware Companion — Animation Asset Prompts

## Workflow

1. Open each `.md` file in `idle-life/`, `context-reactions/`, `touch-reactions/`
2. Copy the **Prompt** section into GPT (or any image generation model)
3. Attach your **reference image** of the pet character alongside the prompt
4. Save the generated PNG(s) in the **same folder** as the `.md` file
5. Name them to match: e.g. `01-yawn.md` → `01-yawn-frame1.png`, `01-yawn-frame2.png`
6. Once all PNGs are placed, Claude will assemble them into animated SVGs with CSS animation

## Shared Technical Requirements (included in every prompt)

These constraints are already embedded in each prompt. Listed here for reference:

- **Output**: PNG with transparent background
- **Dimensions**: 512x512 px (square, will be scaled down)
- **Style**: Match the reference image exactly — same line weight, color palette, proportions
- **Composition**: Character centered, occupying ~60-70% of the canvas
- **DO NOT** add background, ground shadow, or decorative borders
- **DO NOT** redesign or reinterpret the character — only change pose/expression/props

## File Structure

```
context-aware-companion/
  README.md              ← you are here
  idle-life/
    01-yawn.md           ← prompt
    01-yawn-frame1.png   ← you place generated image here
    02-snack.md
    03-wander.md
    04-bored.md
    05-nap-hint.md
    06-curious.md
  context-reactions/
    01-error-comfort.md
    02-smooth-thumbsup.md
    03-bye-wave.md
    04-good-morning.md
    05-break-reminder.md
    06-celebration.md
  touch-reactions/
    01-dizzy.md
    02-shake-off.md
```

## What Claude Will Do With the PNGs

- Wrap each frame in an SVG container matching the theme's viewBox
- Add CSS keyframe animations for movement (bounce, sway, float, shake, etc.)
- Add programmatic overlay elements (floating "?", "Z z z", sparkles, confetti, etc.)
- Generate the final `.svg` files ready for `theme.json` integration
- Wire up the new states in the codebase
