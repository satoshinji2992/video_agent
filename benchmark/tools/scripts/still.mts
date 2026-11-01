// Usage: still.mts <stills.json> <stem> [<stem> ...]
// Generates the selected still specs (gpt-image-2 or Seedream) into tools/work/stills.
import { readFileSync } from 'node:fs';
import { runStill, type StillSpec } from './lib.mts';

const [specFile, ...stems] = process.argv.slice(2);
const specs = JSON.parse(readFileSync(specFile, 'utf8')) as StillSpec[];
const picked = stems.map((s) => {
  const spec = specs.find((x) => x.stem === s);
  if (!spec) throw new Error(`no still spec ${s}`);
  return spec;
});
await Promise.all(picked.map(runStill));
