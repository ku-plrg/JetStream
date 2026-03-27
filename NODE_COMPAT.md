# Node.js Compatibility

This document describes the changes made to allow JetStream to run under
Node.js via `node node-cli.js`, and the reasoning behind each one.

## New files

### `node-cli.js`

Entry point for running JetStream under Node.js, analogous to `cli.js` for
JS engine shells (JSC / V8 / SpiderMonkey).  It:

1. Installs Node.js shims via `utils/node-shims.js`.
2. Parses CLI flags (same set as `cli.js`).
3. Loads `shell-config.js`, `params.js`, and `JetStreamDriver.js` as a single
   concatenated `vm.runInThisContext` call.  Concatenation is necessary because
   V8 keeps `const`/`let`/`class` bindings in per-script scope, so separate
   `runInThisContext` calls cannot see each other's top-level declarations.
4. Calls `JetStream.initialize()` then `JetStream.start()`.

Usage:

```
node node-cli.js [options] [test-names...]
node node-cli.js --dump-test-list
node node-cli.js Kotlin-compose-wasm transformersjs-bert-wasm
```

Error handling in `runJetStream()` uses `String(error)` inside a try/catch
rather than `error.toString()` or string concatenation, because some thrown
values (notably `WebAssembly.Exception` objects that cross vm-realm
boundaries) have null prototypes and cannot be coerced to strings normally.

### `utils/node-shims.js`

Provides the global functions that JSC / V8 / SpiderMonkey shells expose
natively, so that `JetStreamDriver.js` and benchmark scripts can run
unmodified under Node.js.

#### Shell builtins

| Global | Description |
|--------|-------------|
| `load(path)` | Reads and executes a JS file via `vm.runInThisContext`. Sets `__filename`/`__dirname` for the duration so Emscripten-generated code can derive its own `scriptDirectory`. |
| `readFile(path)` | Returns file contents as a UTF-8 string (JSC/SpiderMonkey builtin). |
| `read(path[, 'binary'])` | Returns a UTF-8 string or an `ArrayBuffer` copy (JSC/V8 builtin). |
| `print(…)` | Writes to stdout (shell builtin fallback). |
| `printErr(…)` | Writes to stderr (shell builtin fallback). |
| `gc()` | No-op if `--expose-gc` is not passed; uses the real GC otherwise. |
| `require` | Exposed on `globalThis` so Emscripten modules that detect Node.js and call `require('fs')` can resolve built-in modules from inside `vm.runInContext`. |

#### `runString(code)` — per-benchmark vm sandbox

`JetStreamDriver.js` calls `runString("")` (a JSC builtin) to create a fresh
global object (realm) for each benchmark.  The shim emulates this with
`vm.createContext()`.

The sandbox is pre-populated with the helpers the driver reads back from the
returned global:

- `loadString(s)` — evaluates a string inside the sandbox.
- `readFile(fp)`, `read(fp[, 'binary'])` — file I/O inside the sandbox.
- `load(fp)` — reads and runs a file inside the sandbox.
- `setTimeout`, `clearTimeout`, `setInterval`, `clearInterval`,
  `setImmediate`, `clearImmediate` — timer globals; vm contexts do not inherit
  these from Node.js.

The sandbox's `runOpts` set `filename` to a synthetic path inside the
JetStream root so that relative `import()` specifiers in benchmark code
(e.g. `./transformersjs/build/transformers.js`) resolve correctly against the
JetStream root when `USE_MAIN_CONTEXT_DEFAULT_LOADER` delegates to Node's ESM
loader.

#### Fetch bridge

When a benchmark calls `JetStream.dynamicImport()`, the resulting ES module
runs in the **main** Node.js context and uses `globalThis.fetch` from that
context — not the `fetch` installed on the vm sandbox by `benchmark.js`.
`JetStream.preload` for some benchmarks (e.g. `transformersjs-bert-wasm`)
installs a redirecting `fetch` on the sandbox that serves pre-loaded binary
resources from memory rather than hitting the network.

The shim installs a wrapper `fetch` on the main-context `globalThis` that
delegates to the active sandbox's `fetch` whenever one is present.  A module-
level `_activeBenchmarkCtx` variable is updated to the current sandbox each
time `runString()` creates one.

#### Browser globals for ES-module benchmarks

ES modules loaded via `dynamicImport()` (e.g. `Kotlin-compose-wasm`,
`transformersjs-*`) execute in the main Node.js context.  Their top-level
code and callback closures capture browser globals like `window`, `document`,
`self`, and various DOM constructor names directly from that context.  Without
these, the modules throw `ReferenceError` during initialization.

The shim installs minimal stubs in the main context:

- `window`, `self` — aliased to `globalThis`.
- `navigator` — `{ languages, userAgent, platform }`.
- `isSecureContext` — `false`.
- `document` — stub with `createElement` (returns a canvas-like object),
  `getElementById`, `querySelector`, `addEventListener`, `documentElement`,
  and `body`.  Sufficient for Compose / Skiko initialization checks without a
  real DOM.
- `Event`, `KeyboardEvent`, `ClipboardEvent`, `Element` — empty stub classes
  so that `instanceof` checks in Kotlin Wasm `js_code` handlers do not throw.
- `DOMParser`, `WebSocket`, `AbortController` — minimal stubs.

Note: these stubs are installed with `??=` so they are no-ops on runtimes
(browsers, Deno) that already provide real implementations.

## Modified files

### `JetStreamDriver.js` — `pushError` hardening

`Driver.pushError` calls `error.toString()` to serialize a caught exception.
Some thrown values are not normal `Error` objects:

- `WebAssembly.Exception` objects have null prototypes and no `toString`.
- Kotlin/Wasm exceptions cross vm-realm boundaries; when caught in a different
  realm, `instanceof WebAssembly.Exception` is false and `String(e)` throws
  `TypeError: Cannot convert object to primitive value`.

The fix wraps serialization in a try/catch cascade:

```js
try { errorStr = String(error); }
catch (e) {
    try { errorStr = Object.prototype.toString.call(error); }
    catch (e2) { errorStr = "(unrepresentable error)"; }
}
```

`error.stack` is also guarded with optional chaining (`error?.stack`).

### `transformersjs/benchmark.js` — `env.useFSCache = false`

`transformers.js` can cache model files to the filesystem.  When it does, the
cache returns a **file-path string** instead of a `Uint8Array` buffer.
`onnxruntime-web` (the wasm backend used in the shell; see below) requires a
buffer, not a path.  Setting `env.useFSCache = false` ensures the model is
always returned as a `Uint8Array`.

### `Kotlin-compose/benchmark.js` — pass `wasmBinary` to Skiko

`skiko.mjs` is an Emscripten-generated module patched (see
`skiko-disable-instantiate.patch`) to defer Wasm instantiation.  When
Emscripten runs in a Node.js environment it normally loads the Wasm binary via
`fs.readFileSync`.  However, `skiko.mjs` has its Node.js filesystem path
compiled out (`if (false)`), so Emscripten has neither fs nor browser fetch
available to load `skiko.wasm`.

The fix passes the pre-loaded binary directly as `Module["wasmBinary"]`:

```js
const skikoWasm = preload['skiko.wasm'];
const skikoExports = (await this.skikoInstantiate({
  wasmBinary: skikoWasm?.buffer ? skikoWasm.buffer : skikoWasm,
})).wasmExports;
```

Emscripten checks `Module["wasmBinary"]` before attempting any file or fetch
loading, so this bypasses both unavailable paths entirely.

### `transformersjs/build/transformers.js` and `transformers.js.patch`

`transformers.js` is a pre-built webpack ESM bundle.  Four patches are
required for Node.js shell compatibility.

#### 1. `onnxruntime-node` stub guard (line ~7358)

The bundle's webpack config marks `onnxruntime-node` as ignored for browser
builds, so `require('onnxruntime-node')` returns an empty object `{}`.  The
original code unconditionally picks this empty object when `IS_NODE_ENV` is
true, resulting in `ONNX = {}` and therefore `ONNX.env = undefined`, which
crashes immediately on `delete env.backends.onnx.webgl`.

Fix: guard the Node path with a check that the module actually has an
`InferenceSession` export:

```js
// Before
} else if (IS_NODE_ENV) {
// After
} else if (IS_NODE_ENV && onnxruntime_node?.InferenceSession) {
```

This causes `onnxruntime-web` (the wasm backend, which is fully bundled) to
be used instead.

#### 2. Device selection probe (line ~12077)

After falling through to `onnxruntime-web`, the device-selection logic still
contained `IS_NODE_ENV ? 'cpu' : 'wasm'`.  `onnxruntime-web` only supports
`'wasm'`, not `'cpu'`, so selecting `'cpu'` caused session creation to fail.

Fix: call `deviceToExecutionProviders()` (already available in scope) to
probe which devices are actually supported before defaulting to `'cpu'`:

```js
device ?? (IS_NODE_ENV && deviceToExecutionProviders().includes('cpu') ? 'cpu' : 'wasm')
```

#### 3. Cross-realm `Float32Array` instanceof (line ~7570)

The whisper benchmark creates a `Float32Array` inside a vm sandbox.  The
audio validation in `transformers.js` runs in the main context, where the
sandbox's `Float32Array` constructor is a different object, so
`audio instanceof Float32Array` returns `false`.

Fix: add a name-based fallback:

```js
if (!(audio instanceof Float32Array || audio instanceof Float64Array ||
        audio?.constructor?.name === 'Float32Array' || audio?.constructor?.name === 'Float64Array')) {
```

#### 4. Webpack public-path guard removal (line ~37874)

The webpack runtime throws `Error("Automatic publicPath is not supported in
this browser")` when `import.meta.url` is not a string.  In some shell
environments `import.meta.url` is undefined.

Fix: initialize `scriptUrl` to `''` and remove the throw:

```js
// Before
var scriptUrl;
if (typeof import.meta.url === "string") scriptUrl = import.meta.url
if (!scriptUrl) throw new Error("Automatic publicPath is not supported in this browser");
// After
var scriptUrl = '';
if (typeof import.meta.url === "string") scriptUrl = import.meta.url
// (throw removed)
```

## Architecture notes

### Two execution contexts

Benchmarks run in a split-context architecture:

- **vm sandbox** (`vm.createContext`): each benchmark gets a fresh global.
  `benchmark.js` and the driver harness code run here.  Browser-polyfill
  globals set by `benchmark.js` (e.g. `globalThis.window`) live only here.

- **Main Node.js context**: ES modules loaded via `JetStream.dynamicImport()`
  — `transformers.js`, `skiko.mjs`, `compose-benchmarks-benchmarks.uninstantiated.mjs`
  — execute here.  Their top-level code and Wasm import-callback closures
  capture globals from *this* context, not the sandbox.

This split is why the browser-global stubs must be installed in
`node-shims.js` (main context) in addition to (or instead of) inside
`benchmark.js` (sandbox).

### `dynamicImport` fallback

`JetStreamDriver.js` defines `JetStream.dynamicImport` for shell environments
as:

```js
try { return await import(path); }
catch (e) { return await import(path.slice("./".length)); }
```

The fallback (strip `./`) is intended for JSC which requires bare specifiers
for relative imports.  Under Node.js, bare specifiers like
`transformersjs/build/transformers.js` are interpreted as package names and
cause `ERR_MODULE_NOT_FOUND`.  The first attempt with `./` succeeds under
Node.js as long as the main-context `globalThis` provides the browser globals
the module needs at parse/evaluation time.

### Kotlin-compose-wasm environment detection

`compose-benchmarks-benchmarks.uninstantiated.mjs` detects its runtime at the
top of `instantiate()`:

```js
const isNodeJs = typeof process !== 'undefined' && process.release.name === 'node';
const isStandaloneJsVM = !isDeno && !isNodeJs && (typeof d8 !== 'undefined' || …);
const isBrowser = !isNodeJs && !isDeno && !isStandaloneJsVM && (typeof window !== 'undefined' || …);
```

When running under Node.js, `isNodeJs = true` and the module loads `compose-benchmarks-benchmarks.wasm`
via `fs.readFileSync` — which works because the file is present on disk.
`isBrowser = false`, so the `js_code` callback closures that reference
`document` and other browser APIs are never entered during instantiation.
They are entered during `customLaunch(...)`, at which point the browser-global
stubs installed in `node-shims.js` must be present in the main context.

### Timer globals in vm sandboxes

`vm.createContext()` creates a fully isolated global; it does not inherit
`setTimeout`, `setInterval`, etc. from Node.js.  Emscripten-generated code
(both `skiko.mjs` and `compose-benchmarks-benchmarks.uninstantiated.mjs`)
uses `setTimeout` extensively for coroutine scheduling.  The `runString` shim
copies all timer functions into the sandbox context explicitly.
