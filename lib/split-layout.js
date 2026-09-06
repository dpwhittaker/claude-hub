// Does this viewport get the PWA shell's split layout? (V58, B22)
//
// The rule is the media query it replaced — (min-width: 900px) and
// (orientation: landscape) — judged against the TALLEST height this width has
// been seen at rather than the current one. The shell's viewport meta carries
// interactive-widget=resizes-content, so on Android the soft keyboard shrinks
// the layout viewport, and `orientation` is a layout-viewport feature (landscape
// ⇔ width > height): on a portrait tablet 900px+ wide, a keyboard taking half
// the height flipped it to landscape and the shell into split for as long as
// the keyboard was up, then dropped it to the right-half pane — not the
// terminal being typed in — when the keyboard closed (B22).
//
// A keyboard only ever takes height; a rotation always changes the width. So a
// width is judged by the tallest height it has been seen at: a rotation brings
// a new width and (unless the keyboard rode through the rotation) its
// keyboard-free height, while a shorter height at a known width is the
// keyboard. A taller height at a known width — the keyboard closing after the
// width was first seen with it up — replaces the memory, so the judge is
// always right once the keyboard is down. Desktop corner: a window resized
// only vertically keeps its previous verdict until the width next moves.
//
// Self-contained per V42: inlined into the shell via .toString(), so no
// module-scope references — the threshold arrives as an argument.
function makeSplitLayout(minWidth) {
  const tallest = new Map();
  return function splitLayout(width, height) {
    const t = Math.max(height, tallest.get(width) || 0);
    tallest.set(width, t);
    return width >= minWidth && width > t;
  };
}

module.exports = { makeSplitLayout };
