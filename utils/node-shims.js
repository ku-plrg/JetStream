/*
 * Copyright (C) 2025 Apple Inc. All rights reserved.
 *
 * Redistribution and use in source and binary forms, with or without
 * modification, are permitted provided that the following conditions
 * are met:
 * 1. Redistributions of source code must retain the above copyright
 *    notice, this list of conditions and the following disclaimer.
 * 2. Redistributions in binary form must reproduce the above copyright
 *    notice, this list of conditions and the following disclaimer in the
 *    documentation and/or other materials provided with the distribution.
 *
 * THIS SOFTWARE IS PROVIDED BY APPLE INC. AND ITS CONTRIBUTORS ``AS IS''
 * AND ANY EXPRESS OR IMPLIED WARRANTIES, INCLUDING, BUT NOT LIMITED TO,
 * THE IMPLIED WARRANTIES OF MERCHANTABILITY AND FITNESS FOR A PARTICULAR
 * PURPOSE ARE DISCLAIMED. IN NO EVENT SHALL APPLE INC. OR ITS CONTRIBUTORS
 * BE LIABLE FOR ANY DIRECT, INDIRECT, INCIDENTAL, SPECIAL, EXEMPLARY, OR
 * CONSEQUENTIAL DAMAGES (INCLUDING, BUT NOT LIMITED TO, PROCUREMENT OF
 * SUBSTITUTE GOODS OR SERVICES; LOSS OF USE, DATA, OR PROFITS; OR BUSINESS
 * INTERRUPTION) HOWEVER CAUSED AND ON ANY THEORY OF LIABILITY, WHETHER IN
 * CONTRACT, STRICT LIABILITY, OR TORT (INCLUDING NEGLIGENCE OR OTHERWISE)
 * ARISING IN ANY WAY OUT OF THE USE OF THIS SOFTWARE, EVEN IF ADVISED OF
 * THE POSSIBILITY OF SUCH DAMAGE.
 */

// Node.js shims for JetStream shell builtins.
// Provides the global functions that JSC/V8/SpiderMonkey shells expose natively,
// allowing JetStream to run under Node.js via node-cli.js.

"use strict";

const fs = require("fs");
const path = require("path");
const vm = require("vm");

// require / __filename / __dirname: CommonJS module globals that are NOT in
// scope for code executed via vm.runInThisContext.  We expose them on globalThis
// so that Emscripten-generated files (e.g. wasm/zlib/build/zlib.js) that detect
// Node.js via `typeof process == "object"` and then call `require("fs")` can
// resolve the built-in modules correctly.
globalThis.require = require;

// load(filePath): read and execute a JS file in the current Node.js context.
// Sets __filename and __dirname for the duration of the call so that any
// Emscripten-generated code that uses those identifiers to derive its own
// scriptDirectory gets the correct path for the loaded file.
// Uses vm.runInThisContext so that var declarations become global properties.
// Note: const/let at the top level of the loaded file are NOT visible outside
// that single script compilation unit.  The harness files (shell-config.js,
// params.js, JetStreamDriver.js) are therefore concatenated and loaded together
// by node-cli.js so that their top-level const/let bindings are mutually visible.
globalThis.load = function load(filePath) {
    const absPath = path.resolve(filePath);
    const code = fs.readFileSync(absPath, "utf8");
    const prevFilename = globalThis.__filename;
    const prevDirname = globalThis.__dirname;
    globalThis.__filename = absPath;
    globalThis.__dirname = path.dirname(absPath);
    try {
        vm.runInThisContext(code, { filename: absPath });
    } finally {
        globalThis.__filename = prevFilename;
        globalThis.__dirname = prevDirname;
    }
};

// readFile(filePath): read a file and return its contents as a UTF-8 string.
// Matches the JSC/SpiderMonkey shell builtin of the same name.
globalThis.readFile = function readFile(filePath) {
    return fs.readFileSync(path.resolve(filePath), "utf8");
};

// read(filePath[, 'binary']): read a file as a UTF-8 string or as an ArrayBuffer.
// Matches the JSC/V8 shell builtin used in JetStreamDriver.js for compressed resources.
globalThis.read = function read(filePath, type) {
    const buf = fs.readFileSync(path.resolve(filePath));
    if (type === "binary") {
        // Return a proper ArrayBuffer copy detached from Node's internal pool.
        return buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength);
    }
    return buf.toString("utf8");
};

// print / printErr: shell output builtins used by shell-config.js as fallbacks
// for console.log / console.error when the native console object is absent.
// Node.js already has console, so these are mostly no-ops but are provided for
// completeness in case any benchmark code calls them directly.
globalThis.print = (...args) => process.stdout.write(args.join(" ") + "\n");
globalThis.printErr = (...args) => process.stderr.write(args.join(" ") + "\n");

// gc: use the garbage collector exposed via --expose-gc when available; otherwise
// provide a harmless no-op so that --force-gc mode does not crash.
if (typeof globalThis.gc === "undefined") {
    globalThis.gc = function gc() {};
}

// Browser globals for ES modules (e.g. Kotlin-compose-wasm) that are loaded via
// dynamicImport() and run in the MAIN Node.js context, not the vm sandbox.
// benchmark.js sets these on the sandbox's globalThis but that doesn't affect the
// main context.  We install the minimal stubs here so that the Kotlin Wasm js_code
// import closures (which capture bare `window`, `document`, etc.) don't throw
// ReferenceError when called back from the Wasm module.
globalThis.window ??= globalThis;
globalThis.self ??= globalThis;
globalThis.navigator ??= {};
if (!globalThis.navigator.languages) {
    globalThis.navigator.languages = ["en-US", "en"];
    globalThis.navigator.userAgent =
        "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 " +
        "(KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36";
    globalThis.navigator.platform = "MacIntel";
}
globalThis.isSecureContext ??= false;

// Minimal document stub: returns sensible defaults for the DOM properties that
// Compose / Skiko check during initialization.  Real DOM methods (createElement,
// getElementById, …) are not used during headless benchmarking.
globalThis.document ??= {
    createElement: (tag) => {
        // Skiko requests a <canvas> element; return a minimal stub.
        const el = {
            tagName: tag.toUpperCase(),
            style: {},
            addEventListener: () => {},
            removeEventListener: () => {},
            setAttribute: () => {},
            getAttribute: () => null,
            getContext: () => null,
            width: 0,
            height: 0,
        };
        return el;
    },
    getElementById: () => null,
    getElementsByTagName: () => [],
    querySelector: () => null,
    querySelectorAll: () => [],
    addEventListener: () => {},
    removeEventListener: () => {},
    documentElement: {
        namespaceURI: "http://www.w3.org/1999/xhtml",
        localName: "html",
        getAttribute: () => null,
        getAttributeNS: () => null,
    },
    body: {
        appendChild: () => {},
        removeChild: () => {},
        addEventListener: () => {},
        removeEventListener: () => {},
        style: {},
    },
};

// DOM classes: Kotlin-compose-wasm uses instanceof checks for these.
// Providing empty stub classes keeps the checks from throwing ReferenceError.
globalThis.Event ??= class Event { constructor(type, init) { this.type = type; } };
globalThis.KeyboardEvent ??= class KeyboardEvent extends globalThis.Event {};
globalThis.ClipboardEvent ??= class ClipboardEvent extends globalThis.Event {};
globalThis.Element ??= class Element {};
globalThis.DOMParser ??= class DOMParser {
    parseFromString() { return globalThis.document; }
};
globalThis.WebSocket ??= class WebSocket {
    constructor(url) { this.url = url; }
};
globalThis.AbortController ??= class AbortController {
    constructor() { this.signal = {}; }
    abort() {}
};

// fetch bridging: benchmark.js sets globalThis.fetch = redirectingFetch inside
// the vm sandbox (ctx.fetch).  But ES modules imported via dynamicImport() run in
// the MAIN Node.js context and use the main globalThis.fetch, not the sandbox's.
// We override the main-context fetch once with a wrapper that delegates to the
// currently active benchmark sandbox's fetch whenever one is installed there.
// _activeBenchmarkCtx is updated each time runString() creates a new sandbox.
let _activeBenchmarkCtx = null;
const _nativeFetch = typeof globalThis.fetch === "function"
    ? globalThis.fetch.bind(globalThis)
    : null;

globalThis.fetch = function fetch(url, opts) {
    // If the active sandbox has overridden fetch (e.g. redirectingFetch), use it.
    const sandboxFetch = _activeBenchmarkCtx?.fetch;
    if (typeof sandboxFetch === "function" && sandboxFetch !== globalThis.fetch) {
        return sandboxFetch(url, opts);
    }
    if (_nativeFetch) return _nativeFetch(url, opts);
    throw new Error("fetch is not available in this environment");
};

// runString(code): JSC shell builtin that creates a new isolated global object
// (realm) and evaluates code in it, returning the new global.
// JetStreamDriver.js calls runString("") in ShellScripts.run() to build a fresh
// sandbox for each benchmark.  We emulate this with vm.createContext().
//
// The returned context object is pre-populated with the helpers that the driver
// subsequently reads from globalObject (loadString, readFile, load) so that
// benchmark scripts can load additional files and resolve their results.
globalThis.runString = function runString(code) {
    const ctx = {};
    vm.createContext(ctx);

    // Register this sandbox as the active benchmark context so that the main-
    // context fetch bridge (above) delegates to ctx.fetch when the benchmark
    // installs its own redirecting fetch.
    _activeBenchmarkCtx = ctx;

    // Options for vm.runInContext calls within this sandbox.
    //
    // filename: a synthetic path inside the JetStream root directory so that
    // relative dynamic import() specifiers (e.g. "./transformersjs/build/transformers.js")
    // resolve correctly against the JetStream root when USE_MAIN_CONTEXT_DEFAULT_LOADER
    // delegates to Node's ESM loader.
    //
    // importModuleDynamically: required so that benchmarks that call import()
    // inside the vm sandbox (e.g. transformersjs-bert-wasm) do not throw
    // ERR_VM_DYNAMIC_IMPORT_CALLBACK_MISSING.  USE_MAIN_CONTEXT_DEFAULT_LOADER
    // delegates to Node's own ESM module loader, which can handle both CJS and
    // ESM files by file path or URL.  Available since Node 20.12 / 21.7.
    const runOpts = {
        filename: path.join(path.resolve("."), "_jetstream-vm.js"),
        importModuleDynamically: vm.constants.USE_MAIN_CONTEXT_DEFAULT_LOADER,
    };

    // loadString(s): evaluate a JS string inside this benchmark sandbox.
    // The driver assigns this after runString() for D8/SpiderMonkey; for JSC it
    // is a built-in on every global.  We pre-populate it here for Node.js.
    ctx.loadString = function loadString(s) {
        return vm.runInContext(s, ctx, runOpts);
    };

    // readFile(fp): read a file as a UTF-8 string, accessible from within the sandbox.
    ctx.readFile = function readFile(fp) {
        return fs.readFileSync(path.resolve(fp), "utf8");
    };

    // read(fp[, 'binary']): read a file as UTF-8 string or as an ArrayBuffer.
    // JetStreamDriver.js calls read(path, "binary") inside the sandbox to load
    // binary resources (e.g. prefetched WASM files) when prefetchResources=false.
    ctx.read = function read(fp, type) {
        const buf = fs.readFileSync(path.resolve(fp));
        if (type === "binary") {
            return buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength);
        }
        return buf.toString("utf8");
    };

    // Timer globals: vm contexts do not inherit Node.js timer functions.
    // Emscripten-generated Wasm benchmarks (e.g. Kotlin-compose-wasm) use
    // setTimeout/clearTimeout/setInterval/clearInterval/setImmediate.
    ctx.setTimeout = setTimeout;
    ctx.clearTimeout = clearTimeout;
    ctx.setInterval = setInterval;
    ctx.clearInterval = clearInterval;
    ctx.setImmediate = setImmediate;
    ctx.clearImmediate = clearImmediate;

    // load(fp): read a file and execute it inside this benchmark sandbox.
    // Used when prefetchResources=false; ShellFileLoader returns load("url")
    // snippets that are later eval'd via loadString inside the sandbox.
    ctx.load = function load(fp) {
        const absPath = path.resolve(fp);
        const src = fs.readFileSync(absPath, "utf8");
        return vm.runInContext(src, ctx, { ...runOpts, filename: absPath });
    };

    if (code) {
        vm.runInContext(code, ctx, runOpts);
    }
    return ctx;
};
