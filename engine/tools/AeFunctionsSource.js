/* Assemble ES3 tool modules into the single installed runtime. No AE calls. */
"use strict";
const fs = require("node:fs");
const path = require("node:path");
const moduleNames = ["functions-layer-tools.js", "functions-project-tools.js", "functions-inspection-tools.js"];
function readFunctionsRuntime(root = path.resolve(__dirname, "..")) {
    const base = fs.readFileSync(path.join(root, "source/functions-runtime.js"), "utf8");
    const marker = "/* AECT_EXTRA_FUNCTIONS */";
    if (!base.includes(marker)) { return base; }
    if (base.split(marker).length !== 2) { throw new Error("Function include marker must be unique"); }
    const modules = moduleNames.map(name => "\n/* Installed module: " + name + " */\n" + fs.readFileSync(path.join(root, "source", name), "utf8"));
    return base.replace(marker, function () { return modules.join("\n"); });
}
module.exports = { readFunctionsRuntime, moduleNames };
