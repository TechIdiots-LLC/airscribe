// A stand-in speech worker: loads (or never does), answers each clip, and hangs on one named hang.wav
import { createInterface } from 'node:readline';

if (process.argv[2] !== 'never-loads') process.stdout.write(`${JSON.stringify({ event: 'ready' })}\n`);
createInterface({ input: process.stdin }).on('line', (line) => {
  const { id, wav } = JSON.parse(line);
  if (!wav.endsWith('hang.wav')) process.stdout.write(`${JSON.stringify({ id, ok: true, text: `heard ${wav} in ${process.pid}` })}\n`);
});
setInterval(() => {}, 1000);
