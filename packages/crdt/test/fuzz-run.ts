import { runScenario } from "./fuzz";
import { stats } from "./helpers";
const n = Number(process.argv[2] ?? 200);
const steps = Number(process.argv[3] ?? 60);
const start = Number(process.argv[4] ?? 1);
const kinds = ["qyq", "yqy", "qqy", "yyq", "qqq"];
let fails = 0;
const t0 = Date.now();
for (let seed = start; seed < start + n; seed++) {
  const r = runScenario(seed, steps, kinds[seed % kinds.length]!);
  if (!r.ok) {
    fails++;
    if (fails <= 3) console.log(`seed ${seed} kinds ${kinds[seed % kinds.length]} FAILED: ${r.detail.slice(0, 1500)}`);
  }
}
console.log(`${n} scenarios x ${steps} steps, ${fails} failed, ${Date.now() - t0} ms; qala docs applied ${stats.applied} updates, ${stats.pendingStructs} left pending structs, ${stats.pendingDs} left pending deletes`);
