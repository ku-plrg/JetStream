#! /usr/bin/env node

/*
 * Copyright (C) 2025 Apple Inc. All rights reserved.
 * Copyright 2025 Google LLC
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

import commandLineArgs from "command-line-args";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { fileURLToPath } from "url";

import { logGroup, logInfo, printHelp, runTest, sh } from "./helper.mjs";

const FILE_PATH = fileURLToPath(import.meta.url);
const SRC_DIR = path.dirname(path.dirname(FILE_PATH));
const CLI_PATH = path.join(SRC_DIR, "cli.js");
const NODE_CLI_PATH = path.join(SRC_DIR, "node-cli.js");
const UNIT_TEST_PATH = path.join(SRC_DIR, "tests", "unit-tests.js");

const TESTS = [
    {
        name: "UnitTests",
        tags: ["all", "main", "unit"],
        run(shell_binary) {
            // node-cli.js loads the harness via concatenation so that top-level
            // const/let bindings are shared — but unit-tests.js relies on load()
            // calls whose const/let are not globally visible under Node.js.
            // Use --dump-test-list as a smoke test instead: it verifies that the
            // harness loads and every benchmark is registered without errors.
            if (SHELL_NAME === "node")
                return runTest("UnitTests", () => sh(shell_binary, NODE_CLI_PATH, "--dump-test-list"));
            return runTest("UnitTests", () => sh(shell_binary, UNIT_TEST_PATH));
        },
    },
    {
        name: "CLI Help",
        tags: ["all", "main", "help"],
        run(shell_binary) {
            return runCLITest("Cli Help", shell_binary, "--help");
        },
    },
    {
        name: "Single Suite",
        tags: ["all", "main", "single"],
        run(shell_binary) {
            return runCLITest("Single Suite", shell_binary, "proxy-mobx");
        },
    },
    {
        name: "Tag No Prefetch",
        tags: ["all", "main", "no-prefetch"],
        run(shell_binary) {
            return runCLITest(
                "Tag No Prefetch",
                shell_binary,
                "proxy",
                "argon2-wasm",
                "--no-prefetch"
            );
        },
    },
    {
        name: "Grouped with Details",
        tags: ["all", "main", "group-details"],
        run(shell_binary) {
            return runCLITest("Grouped with Details", shell_binary, "SunSpider", "--group-details");
        },
    },
    {
        name: "Disabled Suite",
        tags: ["all", "disabled"],
        run(shell_binary) {
            return runCLITest("Disabled Suite", shell_binary, "disabled");
        },
    },
    {
        name: "Default Suite",
        tags: ["all", "default"],
        run(shell_binary) {
            return runCLITest("Default Suite", shell_binary);
        },
    },
];

const VALID_TAGS = Array.from(new Set(TESTS.map((each) => each.tags).flat()));

const optionDefinitions = [
    {
        name: "shell",
        type: String,
        description: "Set the shell to test, choices are [jsc, v8, spidermonkey, node].",
    },
    { name: "help", alias: "h", description: "Print this help text." },
    {
        name: "suite",
        type: String,
        defaultOption: true,
        typeLabel: `choices: ${VALID_TAGS.join(", ")}`,
        description: "Run a specific suite by name.",
    },
];

const options = commandLineArgs(optionDefinitions);

if ("help" in options) {
    printHelp("", optionDefinitions);
}

if (options.suite && !VALID_TAGS.includes(options.suite)) {
    printHelp(
        `Invalid suite: ${options.suite}. Choices are: ${VALID_TAGS.join(", ")}`,
        optionDefinitions
    );
}

const JS_SHELL = options?.shell;
if (!JS_SHELL) {
    printHelp("No javascript shell specified, use --shell", optionDefinitions);
}

const SHELL_NAME = (function () {
    switch (JS_SHELL) {
        case "javascriptcore":
        case "jsc": {
            return "javascriptcore";
        }
        case "spidermonkey": {
            return "spidermonkey";
        }
        case "v8": {
            return "v8";
        }
        case "node":
        case "nodejs": {
            return "node";
        }
        default: {
            printHelp(
                `Invalid shell "${JS_SHELL}", choices are: "jsc", "spidermonkey", "v8" and "node"`,
                optionDefinitions
            );
        }
    }
})();

function convertCliArgs(cli, ...cliArgs) {
    // SpiderMonkey and Node.js do not use the "--" argument separator.
    // For Node.js we also swap cli.js for node-cli.js.
    if (SHELL_NAME === "node") return [NODE_CLI_PATH, ...cliArgs];
    if (SHELL_NAME === "spidermonkey") return [cli, ...cliArgs];
    return [cli, "--", ...cliArgs];
}

async function runTests() {
    const shell_binary = await logGroup(`Installing JavaScript Shell: ${SHELL_NAME}`, testSetup);
    const suiteFilter = options.suite || "all";
    let success = true;
    const testsToRun = TESTS.filter((test) => test.tags.includes(suiteFilter));

    if (testsToRun.length === 0) {
        console.error(`No suite found for filter: ${suiteFilter}`);
        process.exit(1);
    }

    for (const test of testsToRun) {
        success &&= await test.run(shell_binary);
    }

    if (!success) {
        process.exit(1);
    }
}

function jsvuOSName() {
    const osName = () => {
        switch (os.platform()) {
            case "win32":
                return "win";
            case "darwin":
                return "mac";
            case "linux":
                return "linux";
            default:
                throw new Error("Unsupported OS");
        }
    };
    const osArch = () => {
        switch (os.arch()) {
            case "x64":
                return "64";
            case "arm64":
                return "64arm";
            default:
                throw new Error("Unsupported architecture");
        }
    };
    return `${osName()}${osArch()}`;
}

const DEFAULT_JSC_LOCATION =
    "/System/Library/Frameworks/JavaScriptCore.framework/Versions/Current/Helpers/jsc";

async function testSetup() {
    // Node.js is already present — use the same binary that is running this script.
    if (SHELL_NAME === "node") {
        const shellBinary = process.execPath;
        logInfo(`Using Node.js binary: ${shellBinary}`);
        return shellBinary;
    }

    await sh("jsvu", `--engines=${SHELL_NAME}`, `--os=${jsvuOSName()}`);
    let shellBinary = path.join(os.homedir(), ".jsvu/bin", SHELL_NAME);
    if (!fs.existsSync(shellBinary) && SHELL_NAME == "javascriptcore")
        shellBinary = DEFAULT_JSC_LOCATION;
    if (!fs.existsSync(shellBinary)) throw new Error(`Could not find shell binary: ${shellBinary}`);
    logInfo(`Installed JavaScript Shell: ${shellBinary}`);
    return shellBinary;
}

function runCLITest(name, shellBinary, ...args) {
    return runTest(name, () => runShell(shellBinary, ...convertCliArgs(CLI_PATH, ...args)));
}

async function runShell(shellBinary, ...args) {
    const result = await sh(shellBinary, ...args);
    // JSC does not set a non-0 exit status on async exceptions.
    if (SHELL_NAME == "javascriptcore" && result.stdoutString.includes("JetStream3 failed")) {
        throw new Error("test failed");
    }
}

setImmediate(runTests);
