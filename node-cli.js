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

// Node.js entry point for running JetStream benchmarks.
//
// Usage:  node node-cli.js [options] [test-names...]
//
// The regular cli.js entry point is designed for JSC / V8 / SpiderMonkey shells
// and relies on shell builtins (load, readFile, read, runString …).  This file
// serves the same purpose for Node.js:
//
//   1. It installs Node.js shims for all required shell builtins.
//   2. It parses CLI arguments (same flags as cli.js).
//   3. It loads the JetStream harness (shell-config.js + params.js +
//      JetStreamDriver.js) as a single vm.runInThisContext call so that
//      top-level const/let/class declarations across the three files are in
//      the same script scope and mutually visible.
//   4. It runs the benchmark suite.
//
// Node 22+ is required (matches the project's engines field in package.json).

"use strict";

const fs = require("fs");
const path = require("path");
const vm = require("vm");

// ── Working directory ────────────────────────────────────────────────────────
// All relative paths in the harness assume the JetStream root as CWD.
const ROOT = __dirname;
process.chdir(ROOT);

// ── Install Node.js shims for shell builtins ─────────────────────────────────
require("./utils/node-shims.js");

// ── CLI argument definitions (mirrors cli.js) ────────────────────────────────
const CLI_PARAMS = {
    __proto__: null,
    help: {
        help: "Print this help message.",
        param: "help",
    },
    "iteration-count": {
        help: "Set the default iteration count.",
        param: "testIterationCount",
    },
    "worst-case-count": {
        help: "Set the default worst-case count.",
        param: "testWorstCaseCount",
    },
    "dump-json-results": {
        help: "Print summary json to the console.",
        param: "dumpJSONResults",
    },
    "dump-test-list": {
        help: "Print the selected test list instead of running.",
        param: "dumpTestList",
    },
    ramification: {
        help: "Enable ramification support.",
        param: "RAMification",
    },
    "no-prefetch": {
        help: "Do not prefetch resources before running.",
        param: "prefetchResources",
    },
    "group-details": {
        help: "Display detailed group items.",
        param: "groupDetails",
    },
    test: {
        help: "Run a specific test or comma-separated list of tests.",
        param: "test",
    },
    tag: {
        help: "Run tests with a specific tag or comma-separated list of tags.",
        param: "tag",
    },
    "start-automatically": {
        help: "Start the benchmark automatically (browser mode).",
        param: "startAutomatically",
    },
    report: {
        help: "Report results to a server URL.",
        param: "report",
    },
    "start-delay": {
        help: "Delay in milliseconds before starting the benchmark.",
        param: "startDelay",
    },
    "custom-pre-iteration-code": {
        help: "JavaScript code to run before each iteration.",
        param: "customPreIterationCode",
    },
    "custom-post-iteration-code": {
        help: "JavaScript code to run after each iteration.",
        param: "customPostIterationCode",
    },
    "force-gc": {
        help: "Force garbage collection before each benchmark. Requires --expose-gc.",
        param: "forceGC",
    },
};

function help(message) {
    if (message) {
        console.log(message);
        console.log();
    }
    console.log("Usage: node node-cli.js [options] [test-names...]");
    console.log();
    console.log("Options:");
    for (const [flag, { help: desc }] of Object.entries(CLI_PARAMS))
        console.log(`    --${flag.padEnd(24)} ${desc}`);
    console.log();
    console.log(
        "test-names can be benchmark names or tag names (see --dump-test-list)."
    );
}

// ── Parse process.argv ───────────────────────────────────────────────────────
const cliParams = new Map();
const cliArgs = []; // positional test/tag names

function parseCliFlag(argument) {
    const eqIndex = argument.indexOf("=", 2);
    const flagName = eqIndex >= 0 ? argument.slice(2, eqIndex) : argument.slice(2);

    if (!(flagName in CLI_PARAMS)) {
        help(`Unknown flag: '--${flagName}'`);
        process.exit(1);
    }

    let value;
    if (flagName.startsWith("no-")) {
        // e.g. --no-prefetch → prefetchResources = "false"
        value = "false";
    } else if (eqIndex >= 0) {
        value = argument.slice(eqIndex + 1);
    } else {
        value = "true";
    }

    cliParams.set(CLI_PARAMS[flagName].param, value);
}

for (const arg of process.argv.slice(2)) {
    if (arg.startsWith("--")) {
        parseCliFlag(arg);
    } else {
        cliArgs.push(arg);
    }
}

// Collect positional test names into the "test" param
if (cliArgs.length) {
    const existing = cliParams.has("test") ? cliParams.get("test").split(",") : [];
    cliParams.set("test", existing.concat(cliArgs).join(","));
}

const printHelp = cliParams.delete("help");
const dumpTestList = cliParams.delete("dumpTestList");

// Expose parsed params to params.js via the same global that cli.js uses
if (cliParams.size) {
    globalThis.JetStreamParamsSource = cliParams;
}

// ── Load the JetStream harness ───────────────────────────────────────────────
//
// WHY concatenate instead of separate load() calls?
//
// Node.js treats each vm.runInThisContext() call as a separate script compilation
// unit.  V8 keeps const/let/class declarations in "script scope" — they are
// accessible within one script but NOT from a different script, even when both
// run in the same context.  The three harness files cross-reference each other's
// top-level bindings (e.g. JetStreamDriver.js reads isInBrowser/isD8/isSpiderMonkey
// from shell-config.js and JetStreamParams from params.js), so they must share
// a single script scope.  Concatenating them achieves this without touching the
// original source files.
//
// var declarations and globalThis assignments ARE shared across separate scripts,
// so any load() calls that happen at runtime (e.g. wasm/zlib/shell.js) continue
// to work correctly through the globalThis.load shim.

const harnessFiles = [
    path.join(ROOT, "utils", "shell-config.js"),
    path.join(ROOT, "utils", "params.js"),
    path.join(ROOT, "JetStreamDriver.js"),
];

const harnessCode = harnessFiles
    .map((f) => fs.readFileSync(f, "utf8"))
    .join("\n;\n");

vm.runInThisContext(harnessCode, { filename: "jetstream-harness.js" });

// JetStreamDriver.js ends with:  this.JetStream = new Driver(benchmarks);
// At the top level of a vm.runInThisContext script, `this` is the Node.js
// global object, so JetStream is now available as globalThis.JetStream.

// ── Help / dump-test-list / run ──────────────────────────────────────────────

if (printHelp) {
    help();
    process.exit(0);
}

if (dumpTestList) {
    globalThis.JetStream.dumpTestList();
    process.exit(0);
}

async function runJetStream() {
    try {
        await globalThis.JetStream.initialize();
        await globalThis.JetStream.start();
    } catch (e) {
        let eStr;
        try { eStr = String(e); } catch (_) { eStr = Object.prototype.toString.call(e); }
        console.error("JetStream3 failed: " + eStr);
        console.error(e?.stack ?? "(no stack)");
        process.exit(1);
    }
}

runJetStream().catch(() => process.exit(1));
