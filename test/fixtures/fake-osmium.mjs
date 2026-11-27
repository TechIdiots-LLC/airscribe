// osmium, as far as Roads.fetchExtract uses it, for tests: the "extract" is GeoJSONSeq text, passed through.
// Each run's arguments are added to FAKE_OSMIUM_LOG, a line each.
import { appendFileSync, copyFileSync, readFileSync } from 'node:fs';

const args = process.argv.slice(2);
if (process.env.FAKE_OSMIUM_LOG) appendFileSync(process.env.FAKE_OSMIUM_LOG, `${JSON.stringify(args)}\n`);
if (args[0] === '--version') {
  console.log('osmium version 1.16.0 (fake)');
  process.exit(0);
}
const out = args[args.indexOf('-o') + 1];
const input = args[args.indexOf('-o') + 2];
if (args[0] === 'export') process.stdout.write(readFileSync(input));
else copyFileSync(input, out);
