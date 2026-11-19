# Aplos Paper: taste rubric

Condensed from plans/DESIGN.md sections 3, 4 and 9 and the aplos-design skill. Judge only what is
visible in the screenshots. Each criterion is scored 0 to 10 (10 = a careful designer would change
nothing, 5 = acceptable but visibly off, 0 = clearly breaks the rule).

## The identity

Paper: a gray shell, one white pane for content, type and space carry the identity. Calm, quiet,
keyboard-first mail. Cards exist only for the thing in hand (focus letter, inline reply, dialogs,
menus, toasts). The accent is one ink blue. Done is green, Later is slate blue, danger is one red,
each used only where it means that.

## Criteria (use these ids exactly)

- restraint: Calm and quiet. Few things on screen, secondary actions hidden in the more menu or
  the command palette, no competing focal points, nothing shouting. Colour is rare and meaningful.
- hierarchy: Typographic hierarchy is clear and uses few steps. Sans for everything except words
  Aplos wrote. Section labels are 13 px semibold ink with a dim count. No page titles. Metadata is
  small and dim. Unread rows are heavier than read rows. Weights are 400, 500, 600 only.
- serif: Aplos-written words (summaries, Ask answers) are set in the Newsreader serif at the one
  big size; the serif is used nowhere else; no glyph, badge, label or glow marks AI. Score null when
  the view shows no summary and no AI text.
- accent: At most one filled accent button per view, owned by the topmost surface. The accent
  appears only as the filled button, focus ring, cursor bar, unread dot or links. No colour floods.
- rhythm: Spacing sits on a 4 px grid (4, 8, 12, 16, 20, 24, 32, 40). Edges align: one left edge
  per column, consistent row heights, groups about 32 px apart, pane inset 8 px, pane radius 12 px.
  Nothing cramped or drifting.
- density: Comfortable, not sparse and not crammed. Rows about 40 px, the list column at most
  720 px, the reader column 640 px. Whitespace is purposeful rather than empty.
- copy: Plain, literal microcopy. Buttons are verbs ("Send", "Reconnect"), never "OK". No
  exclamation marks. Errors say what happened, what is safe and what to do. Home labels are exactly
  "Do now", "Back from Later", "Important updates", "Low importance", "Follow up". Empty states are
  one plain sentence with at most one action. No cute or marketing phrasing.
- ornament: No decoration. Banned: sparkle, wand, star, brain or robot glyphs; any gradient,
  glow, shimmer, blur, texture or rainbow border; stamps, sky or hill art; app icon inside the UI;
  pill buttons with inline keycaps; the floating bottom action cluster; avatars; page titles;
  spinners that appear for local data. Score 10 only when none is visible.
- affordance: Interactive things look interactive and keyboard cues are present where a hand is
  on the keys: visible focus ring or cursor bar, keycaps beside the primary action, clear
  hover-ready controls, hit targets at least 24 px. Hover itself cannot be seen in a still, so judge
  affordances that are shown. Score null when the view has nothing interactive.
- parity: The light and dark shots are the same design. Hierarchy, contrast and accents survive in
  dark; the dark pane is slightly lighter than the shell for cards; text is legible; nothing
  disappears or glows. Compare the two images directly.
- fidelity: When a reference mockup is supplied, how closely the shot matches its layout, spacing,
  type and tone. Differences in sample text are fine. Score null when no reference is supplied.

## Scoring rules

- Score only what is visible. Do not infer behaviour. Do not reward length or detail of text.
- Be a harsh, consistent reviewer. 9 or 10 is rare; most careful work earns 6 to 8.
- Numbers are for relative comparison between versions, not absolute truth.
- Each finding is one sentence: where in the view, what is wrong, the fix. Worst first, at most 8,
  empty when truly nothing stands out. Name the theme when the problem is theme-specific.
