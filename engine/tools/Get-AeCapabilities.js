/* Local CLI for the same search/inspect/status data exposed by MCP. No AE dispatch. */
"use strict";
const api = require("./AeCapabilities.js");
try {
    const [action = "status", json = "{}"] = process.argv.slice(2);
    const actions = { search: api.searchCapabilities, inspect: api.inspectCapability, status: api.capabilityStatus };
    if (!Object.hasOwn(actions, action)) { throw new Error("Usage: node tools/Get-AeCapabilities.js status|search|inspect '<JSON object>'"); }
    const result = actions[action](JSON.parse(json));
    process.stdout.write(JSON.stringify(result, null, 2) + "\n");
} catch (error) {
    process.stderr.write(error.message + "\n"); process.exitCode = 1;
}
