// The app's AI mark, in one place.
//
// The supplied logo (public/ai-mark.png), cropped to its content and squared —
// the original was 1536×1024 with a wide transparent margin, which would have
// shrunk the glyph to nothing at icon size. Its background really is
// transparent, so it sits on any theme without a plate behind it.
//
// An <img> rather than inline SVG because the artwork is a raster with gloss
// and glow that no hand-drawn path would match. It therefore does NOT follow
// currentColor — the palette is the point, so it stays constant across themes
// and hover states.
//
// Used by the top bar's Ask AI pill and DART's log button. Anything meaning
// "AI did this" should use this rather than inventing a glyph.

const SRC = `${import.meta.env.BASE_URL}ai-mark.png`

export default function AiMark({ className }: { className?: string }) {
  return (
    <img
      className={className}
      src={SRC}
      alt=""
      aria-hidden="true"
      draggable={false}
      // Decoding async keeps a cold cache from delaying the header paint.
      decoding="async"
    />
  )
}
