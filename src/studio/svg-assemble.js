"use strict";

// ── Animated SVG assembler ───────────────────────────────────────────────────
// Turns normalized frame data URLs into a single animated SVG asset for the
// theme. Uses discrete sprite-style frame swapping (CSS `step-end`, so frames
// switch cleanly with no ghosting) plus a continuous bottom-anchored "bob" for
// liveliness. The CSS is built with a string builder that emits SINGLE braces —
// the `}}` f-string bug found during prototyping is guarded by a unit test.

function buildSequence(n, loop) {
  const fwd = [];
  for (let i = 0; i < n; i += 1) fwd.push(i);
  if (loop === "pingpong" && n > 2) {
    for (let i = n - 2; i >= 1; i -= 1) fwd.push(i);
  }
  return fwd;
}

// Cumulative boundary percentages [0, ...100] for `seq.length` segments,
// weighting a segment by `hold[frameIndex]` (default 1).
function boundaries(seq, hold = {}) {
  const weights = seq.map((frameIdx) => {
    const w = hold && Number.isFinite(hold[frameIdx]) ? hold[frameIdx] : 1;
    return w > 0 ? w : 1;
  });
  const total = weights.reduce((a, b) => a + b, 0);
  const pcts = [0];
  let acc = 0;
  for (const w of weights) {
    acc += w;
    pcts.push(Math.round((acc / total) * 10000) / 100);
  }
  return pcts; // length seq.length + 1; first 0, last 100
}

function frameKeyframes(name, frameIndex, seq, pcts) {
  const lines = [`  @keyframes ${name} {`];
  for (let s = 0; s < seq.length; s += 1) {
    const op = seq[s] === frameIndex ? 1 : 0;
    lines.push(`    ${pcts[s]}% { opacity: ${op}; }`);
  }
  // close the loop: hold the final segment's value to 100%
  const lastOp = seq[seq.length - 1] === frameIndex ? 1 : 0;
  lines.push(`    100% { opacity: ${lastOp}; }`);
  lines.push("  }");
  return lines.join("\n");
}

function assembleAnimatedSvg(options = {}) {
  const frames = Array.isArray(options.frames) ? options.frames : [];
  if (frames.length === 0) throw new Error("assembleAnimatedSvg requires at least one frame");
  const anim = options.anim || {};
  const totalMs = Number.isFinite(anim.totalMs) && anim.totalMs > 0 ? anim.totalMs : 3000;
  const vb = options.viewBox || { x: 0, y: 0, width: 512, height: 512 };
  const bob = options.bob !== false;

  const seq = buildSequence(frames.length, anim.loop || "once");
  const pcts = boundaries(seq, anim.hold || {});

  const css = [];
  for (let i = 0; i < frames.length; i += 1) {
    css.push(frameKeyframes(`f${i}`, i, seq, pcts));
    css.push(`  .l${i} { animation: f${i} ${totalMs}ms step-end infinite; }`);
  }
  if (bob) {
    css.push("  @keyframes bob {");
    css.push("    0% { transform: translateY(0); }");
    css.push("    50% { transform: translateY(-3px); }");
    css.push("    100% { transform: translateY(0); }");
    css.push("  }");
    css.push("  .bob { animation: bob 1.6s ease-in-out infinite; transform-origin: center bottom; }");
  }
  css.push("  image { image-rendering: pixelated; }");

  const images = frames
    .map((href, i) => `    <image class="l${i}" x="${vb.x}" y="${vb.y}" width="${vb.width}" height="${vb.height}" href="${href}" opacity="0" />`)
    .join("\n");

  return [
    `<svg xmlns="http://www.w3.org/2000/svg" viewBox="${vb.x} ${vb.y} ${vb.width} ${vb.height}">`,
    "<defs><style>",
    css.join("\n"),
    "</style></defs>",
    bob ? '  <g class="bob">' : "  <g>",
    images,
    "  </g>",
    "</svg>",
    "",
  ].join("\n");
}

module.exports = { assembleAnimatedSvg, buildSequence, boundaries };
