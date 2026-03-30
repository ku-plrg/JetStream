# JetStreamDriver.js Changes

## Goal

Allow `node node-cli.js` to continue running all benchmarks even when individual benchmarks fail (e.g. thrown `Error`), rather than aborting the entire suite.

---

## Change 1 — Don't re-throw benchmark run errors

**Location:** `Driver.start()`, inside the `for (const benchmark of this.benchmarks)` loop.

**Before:**
```js
try {
    await benchmark.run();
} catch(e) {
    this.reportError(benchmark, e);
    throw e;
}
```

**After:**
```js
try {
    await benchmark.run();
} catch(e) {
    this.reportError(benchmark, e);
}
```

**Reason:** The original code recorded the error via `reportError` but then re-threw it, which propagated up through `runJetStream()` and called `process.exit(1)`. Dropping `throw e` lets the loop continue to the next benchmark while still recording the failure.

---

## Change 2 — Wrap `updateUIAfterRun()` in a try/catch

**Location:** `Driver.start()`, immediately after the benchmark run try/catch.

**Before:**
```js
performance.mark("update-ui");
benchmark.updateUIAfterRun();
```

**After:**
```js
performance.mark("update-ui");
try {
    benchmark.updateUIAfterRun();
} catch(e) {
    this.reportError(benchmark, e);
}
```

**Reason:** When a benchmark fails its scores are `null`, and `updateUIAfterRun()` calls `uiFriendlyNumber(null)` which throws `TypeError: Cannot read properties of null (reading 'toFixed')`. This call was outside the run try/catch so it still aborted the suite. Wrapping it prevents that.

---

## Change 3 — Exclude failed benchmarks from overall score computation

**Location:** `Driver.start()`, score aggregation section after the benchmark loop.

**Before:** All benchmarks (including failed ones with `null` scores) were unconditionally pushed into `allScores` and category score/time arrays. A single `null` score causes `geomeanScore` to multiply by `0`, making the overall score `0`.

**After:** Benchmarks where `benchmark.score` is not a positive number are skipped with a console log message:
```js
if (!(score > 0)) {
    console.log(`Skipping ${benchmark.name} from overall score (invalid score: ${score})`);
    continue;
}
```
The same guard is applied when building `categoryScores` and `categoryTimes` maps, and when pushing individual sub-scores and sub-times.

**Reason:** The geometric mean of a set containing `0` or `null` is always `0`. Excluding failed benchmarks ensures the overall score reflects only the benchmarks that actually completed successfully.
