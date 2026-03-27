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

    // loadString(s): evaluate a JS string inside this benchmark sandbox.
    // The driver assigns this after runString() for D8/SpiderMonkey; for JSC it
    // is a built-in on every global.  We pre-populate it here for Node.js.
    ctx.loadString = function loadString(s) {
        return vm.runInContext(s, ctx);
    };

    // readFile(fp): read a file as a UTF-8 string, accessible from within the sandbox.
    ctx.readFile = function readFile(fp) {
        return fs.readFileSync(path.resolve(fp), "utf8");
    };

    // load(fp): read a file and execute it inside this benchmark sandbox.
    // Used when prefetchResources=false; ShellFileLoader returns load("url")
    // snippets that are later eval'd via loadString inside the sandbox.
    ctx.load = function load(fp) {
        const absPath = path.resolve(fp);
        const src = fs.readFileSync(absPath, "utf8");
        return vm.runInContext(src, ctx, { filename: absPath });
    };

    if (code) {
        vm.runInContext(code, ctx);
    }
    return ctx;
};
