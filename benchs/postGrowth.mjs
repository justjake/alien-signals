// Steady-state write cost after arena growth. Growth rebuilds the engine;
// without codegen clones the second instantiation of the engine literals
// permanently disables V8's context specialization (~1.9x on walk-heavy
// steady state). With clones (instantiateEngine + new Function), fresh
// function identities restore specialization: expect after/before within
// ~1.1-1.2x (old handles pay the retired-forward hop; mixed-generation
// graphs mix call-site feedback) and fresh single-generation engines at
// parity. Usage: MODE=grow|nogrow node benchs/postGrowth.mjs
import { createReactiveSystem } from '../esm/system.mjs';

const MODE = process.env.MODE ?? 'grow';
const sys = createReactiveSystem({ initialCapacity: MODE === 'grow' ? 8192 : 1 << 20 });

const src = sys.makeSignal(1);
let last = src;
for (let i = 0; i < 40; i++) {
  const prev = last;
  last = sys.makeComputed(() => prev() + 1);
}
sys.makeEffect(() => { last(); });

const N = 200_000;
const time = () => {
  const t0 = performance.now();
  for (let i = 0; i < N; i++) src(i);
  return performance.now() - t0;
};
time(); // warm
const before = time();

if (MODE === 'grow') {
  const cap0 = sys.stats().capacityRecords;
  while (sys.stats().capacityRecords === cap0) {
    for (let i = 0; i < 512; i++) sys.makeSignal(i);
    await Promise.resolve(); // let boundary maintenance run
  }
}

time(); // rewarm
const after = time();
// FRESH: same chain shape, handles minted on the current generation.
let src2 = sys.makeSignal(1);
let last2 = src2;
for (let i = 0; i < 40; i++) {
  const prev = last2;
  last2 = sys.makeComputed(() => prev() + 1);
}
sys.makeEffect(() => { last2(); });
const time2 = () => {
  const t0 = performance.now();
  for (let i = 0; i < N; i++) src2(i);
  return performance.now() - t0;
};
time2();
const fresh = time2();
console.log(`${MODE}: before ${before.toFixed(1)}ms after(old handles) ${after.toFixed(1)}ms ratio ${(after / before).toFixed(3)} | fresh handles ${fresh.toFixed(1)}ms ratio ${(fresh / before).toFixed(3)} | capacity ${sys.stats().capacityRecords}`);
