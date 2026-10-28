# Design lint

Enforces `plans/DESIGN.md` section 12.2 on the renderer. One core, three front doors:

| Front door | File | Status |
|---|---|---|
| Standalone CLI | `run.mjs` | Runs today. Needs only `postcss` and `typescript`, which are already in `node_modules`. |
| ESLint 9 flat-config plugin | `eslint-plugin.mjs` | Tiny adapter, **not executed in Phase 0** (ESLint is not installed). Only its shape and one fake-context report are unit-tested. |
| stylelint plugin array | `stylelint-plugin.mjs` | Tiny adapter, **not executed in Phase 0** (stylelint is not installed). `stylelint` is imported lazily inside each rule, so the module loads without it. Only its shape is unit-tested. |

Rule logic lives once, in `rules/<rule-id>.mjs`, and runs on a PostCSS AST (CSS) and on the TypeScript compiler API AST (`.ts .tsx .js .jsx .mjs`). Each rule exports `{id, description, appliesTo: ['css'|'ts'], check(fileContext) -> [{line, column, message}]}`. The adapters only wrap `check`.

## Run it

```
node tools/lint/design/run.mjs                      # default scope from config.mjs
node tools/lint/design/run.mjs apps/desktop/src/renderer/home   # a folder or files
node tools/lint/design/run.mjs --rule no-raw-color --rule button-variant <paths>
node tools/lint/design/run.mjs --json <paths>
node tools/lint/design/run.mjs --no-ignore <paths>  # used by the tests to lint fixtures
node --test tools/lint/design/design-lint.test.mjs
```

Output is `file:line:col rule-id message`. Exit code 1 on any violation, 0 when clean, 2 on a usage error.

## What each rule bans, and why

| Rule | Bans | DESIGN |
|---|---|---|
| `no-raw-color` | Hex colours, `rgb() rgba() hsl() hsla() hwb() lab() lch() oklab() oklch() color()` in CSS values and in any TS string or template (`style={{color:'#fff'}}`, `` `${x} #0b5394` ``); named colours (`red`, `white`...) in colour properties; `color-mix()` containing a literal colour. `transparent`, `currentColor`, `inherit` and `var(--...)` are fine, so `color-mix(in srgb, var(--ink) 8%, transparent)` passes. Raw colours inside `var()` fallbacks and custom properties fail too. | 4.1 rules, 12.2 |
| `no-decoration` | `linear- repeating-linear- radial- conic-gradient()`, `backdrop-filter` (CSS, style key, strings), `perspective` and `perspective() rotateY()` anywhere, and the old class names `post-edge airmail skyscene sky-scene dock-pill deck has-next low-line reader-dock` in selectors, `className` strings, `classList` calls and `.class` selector strings. | 2.3 (5, 6), 2.4, 4.6, 4.9, 13 |
| `no-literal-motion` | Literal durations (`120ms`, `.2s`) and easings (`cubic-bezier() steps() linear()` and the `ease`, `ease-in`, `ease-out`, `ease-in-out`, `linear` keywords) in `transition*` and `animation*`; a literal duration or easing in any custom property (`--x: 120ms`, `'--x': '120ms'`); `.animate(keyframes, options)` with a literal `duration`, `delay`, `endDelay` or `easing`, or a bare number as options; `setTimeout`/`setInterval` with a literal delay whose callback writes `style.transform/opacity/transition/...` or toggles a class named like enter, leave, exit, animate, fade, slide. `var(--dur-*)`, `var(--ease-*)`, `var(--spring-*)` and `dur.x` imports are fine. A zero duration is allowed. | 4.8, 12.2 |
| `no-layout-motion` | `transition` or `transition-property` containing `all`, `width`, `height`, min/max sizes, `padding* margin* inset*`, `top left right bottom`, `flex*`, `grid-template*`, `font-size`, `font-weight`, `letter-spacing`, `line-height`, `border-width`, `gap`; the same in `style` objects, strings and `el.style.transition`; any `@keyframes` or WAAPI keyframe property outside transform, opacity and colour (`background-color color border-color fill stroke box-shadow outline-color`, plus the individual `translate rotate scale` transforms). | 5 rule 7, 4.8 |
| `hover-no-layout` | In a rule whose selector contains `:hover`, anything but colour and fill: `color background background-color border-color outline-color fill stroke text-decoration-color box-shadow opacity visibility cursor` and `--hover*`/`--press*` custom properties. Also a `<Kbd>` rendered under a condition that mentions hover (a `hover`-named variable, or state set from `onMouseEnter`/`onPointerOver`). | 3 (11), 5 rule 17 |
| `no-literal-size` | Literals in `padding* margin* gap row-gap column-gap font-size line-height font letter-spacing border-radius (and corner longhands) box-shadow z-index`, in CSS, in style objects (a number counts as px) and in inline strings. Allowed: `0`, `1px` hairlines (spacing, gap, shadow), `100%` (not for radius), `auto`, `normal`, `inherit/initial/unset`, `var(--...)`, and `calc() min() max() clamp()` whose literals are unitless multipliers, `0`, `1px` or `100%`. | 4.3-4.6, 12.2 |
| `no-static-will-change` | `will-change` in a stylesheet, a style object or a string. `el.style.willChange = ...` (the dynamic path `motion.ts` uses) and `will-change: auto` pass. | 5 rule 14 |
| `reduced-motion-covered` | An `animation` / `animation-duration` without a `var(--dur-*)` duration (the generated reduced-motion block only neutralises those); an `@keyframes` not used by an `animation` in the same file (mark WAAPI exports with a comment containing `waapi`); an `infinite` loop whose duration is not `--dur-breathe` or `--dur-status`. | 4.8, 11 (5) |
| `no-banned-icon` | Imports (default, named, aliased, namespace member) and JSX tags of Sparkles, Sparkle, Wand, Wand2, WandSparkles, Stars, Star, StarOff, StarHalf, Brain, BrainCircuit, BrainCog, Bot, BotMessageSquare, BotOff and anything whose name has the word star, bot or contains sparkl, wand, brain, robot, from an icon module (`lucide`, `icon`, `symbol`, `phosphor`, `tabler`...); SF Symbol names in any string (`sparkle`, `sparkles`, `wand.and.stars`, `wand.and.rays`, `star`, `star.fill`, `apple.intelligence`, `brain`, `brain.head.profile`, anything starting `sparkle` or `wand.`); the glyphs and entities for sparkles, stars, wand, robot, brain (also `\2605`-style CSS escapes) in strings, JSX text and CSS values. `Restart` and `Start` are not stars; `bookmark` is the bookmark icon. | 4.7, 9 rule 8 |
| `no-banned-string` | The phrase list of DESIGN 10 and 13 (case-insensitive, word-bounded): "Swipe through them", "Hold to talk", "Hold Space to talk", "Tap to write", "Hide all", "Todo", "Todos", "Be here now", "Sent with", "Ask me anything", "magic", "AI-powered", "AI powered", "Copilot", "Ready when you are", "Waiting on you", "No reply yet", "All clear for now", "Making room for your mail", "Aplos needs a moment", "Couldn't summarize this email", "Your day beside your mail", "A comfortable place for your mail", "Make light work of your inbox", "A little less inbox", "Aplos is ready when your day begins", "Skypaper", "Airmail", "par avion"; "Smart" or "Beta" alone as a label; and any `!`. Scanned only in copy positions: JSX text and string children, JSX string props (not `className id key data-* type` and the like, and not lowercase code-like strings in unknown props), string values of properties named label, title, description, placeholder, ariaLabel, hint, tooltip, message, copy, text (plus subtitle, caption, heading, aria-label), and CSS `content`. A same-file const used as copy is followed. | 2.3 (6), 9 rule 8, 10, 13 |
| `button-variant` | `<Button variant="...">` other than `filled`, `text`, `icon`, including every string branch of a conditional, logical or same-file const expression. | 4.6, 12.2 |

The Avec hex values of `lint/identity-references.json` (when it exists) and `#e5e4e1`, `#0682fe`, `#0a9c0a` need no rule of their own: every hex is already banned outside the token source by `no-raw-color`.

## What is checked beyond plain declarations

- **Style objects.** `style={{...}}`, objects typed `CSSProperties`, objects under a key named `*style`, `Object.assign(el.style, {...})`, and any object with two or more style-looking keys. Numbers count as px only inside these objects, so a plain `{ top: 40, gap: 8 }` is left alone.
- **Imperative writes.** `el.style.x = ...`, `el.style['--x'] = ...`, `el.style.setProperty(...)`.
- **Inline CSS text.** A string such as `'padding: 0 7px; will-change: transform'` or `el.style.cssText = ...` is read as declarations.
- **Embedded stylesheets.** A string or template that contains `{ }` and parses as CSS (a `<style>{`...`}</style>` block, a `css` tagged template) is parsed with PostCSS and every declaration goes through the same rules, selectors included. `reduced-motion-covered` is the one rule that does not look inside embedded stylesheets.
- **Same-file indirection.** `const t = 'all 120ms'; style={{transition: t}}`, `const v = 'pill'; <Button variant={v}>`, `const L = 'Hide all'; <b>{L}</b>`, a keyframes or options constant passed to `.animate()`, and a named timer callback are followed to their const initializer.

## Exemptions

Only token sources and generated files are exempt (`config.mjs`): `renderer/ui/tokens.json` and `renderer/ui/generated/**`. Test files (`*.test.*`) and `fixtures/` folders are skipped because they plant violations on purpose. `renderer/legacy/**` and a **temporary explicit list of today's renderer files** are skipped until the restructure moves them; the list in `config.mjs` is deleted once restructure step 1 lands. `apps/web` is outside the include glob until its redesign.

There are no inline disable comments. The CLI has none to honour. When the adapters are wired in, the config should switch the tools' own directives off (`linterOptions: { noInlineConfig: true }` in ESLint, `ignoreDisables: true` in stylelint). There is no escape hatch. A new token goes in `tokens.json`; a genuinely needed exception is a DESIGN change.

## Evasions deliberately left to the screenshot harness

Static analysis cannot see these; the harness (DESIGN 12.5) catches the visible result.

- Values built at run time: `` `${a}${b}` `` where both parts are variables, `[0, 7].join('px ')`, values read from an imported module or a function result (`padding: spacing(3)`). The rule sees a non-literal and passes it.
- Constants defined in another file and imported into a style object or a `.animate()` call.
- Computed property names that are not string literals, and `Object.fromEntries`-style style construction.
- Motion driven by `requestAnimationFrame`, `await sleep(n)` or a promise chain rather than a literal timer; layout driven per frame by React state (`width` set from a spring value); a spring solver writing `width`. The harness's layout-shift check and the performance suite see these.
- Hover that reveals layout through JS (a class toggled by an `onMouseEnter` handler that changes size) rather than `:hover` or a `<Kbd>` under a hover condition. The harness hovers every interactive element and fails on any box that moves by more than 0.5 px.
- Colour or size smuggled through a library that takes props (a charting or calendar component given a `color="red"` prop). Named colours are checked in colour properties of style objects, not in arbitrary props.
- `<Button>` shadows: a differently named component that renders `variant="pill"`.
- Copy that is built in code (`'Hide ' + 'all'`) or that comes from the engine or the AI. The DOM text scan of the harness covers rendered strings.
- System colour keywords (`Canvas`, `CanvasText`, `Highlight`) are not flagged, so a forced-colors block may use them.

## Known approximations

- The `star` icon-name check works on PascalCase words, so `Starter` and `Restart` pass and `StarIcon` fails. A string that is exactly `star`, `sparkle`, `brain` or similar is treated as a symbol name wherever it appears.
- A hex-looking string such as `'#abc'` or `'#1234'` is treated as a colour wherever it appears, even outside style code; write `'#main'`-style anchors with a non-hex name or avoid them.
- `reduced-motion-covered` pairs `animation-iteration-count: infinite` with an `animation-duration` or `animation` in the same rule only.
- `z-index` has no token family in DESIGN section 4 yet. The rule accepts any `var(--...)`, `0` and `auto`; the README of the token owner should name the layer tokens (`--z-menu` and so on).
