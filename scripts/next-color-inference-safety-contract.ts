import assert from 'node:assert/strict';
import { inferNextColourFromTitle } from '../src/server/services/scraper.js';

const cases = [
  ['Light Green Sweatshirt and Leggings Set (3mths-7yrs)', 'Light Green'],
  ['Navy Sweatshirt and Joggers Set (3mths-7yrs)', 'Navy'],
  ['Pink Floral Dress (3mths-7yrs)', 'Pink Floral'],
] as const;

for (const [title, expected] of cases) {
  assert.equal(inferNextColourFromTitle(title), expected, title);
}

console.log(`Next color inference safety contract passed: ${cases.length}/${cases.length}`);
process.exit(0);
