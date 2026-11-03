import test from 'node:test';
import { SEQUENCES, runPart, seedRange } from './overlay.property.run';

const { first, last } = seedRange(4, 8);

test(`seeded sequences ${first} to ${last} of ${SEQUENCES} (commands, mail and frames never show a state the engine never had)`, async () => {
  await runPart(4, 8);
});
