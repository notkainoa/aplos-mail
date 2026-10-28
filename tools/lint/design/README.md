# tools/lint/design

UI-core owns this folder: the DESIGN section 12.2 rules go here. `eslint.config.mjs` spreads the array exported by `index.mjs` (flat config objects, empty today), and `stylelint.config.mjs` merges `{ plugins?, rules? }` from `stylelint.mjs` if you add that file.
