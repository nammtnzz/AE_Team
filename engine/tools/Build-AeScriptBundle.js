/* Build the only runnable JSX. Uses Node built-ins; never talks to After Effects. */
"use strict";
const fs = require("node:fs");
const path = require("node:path");
const crypto = require("node:crypto");
const vm = require("node:vm");
const { expandSource, consolidateSource } = require("./AeScriptSource.js");
const { analyzeCapabilities } = require("./AeScriptCapabilities.js");
const { readFunctionsRuntime } = require("./AeFunctionsSource.js");
const root = path.resolve(__dirname, "..");
const validName = name => /^[A-Za-z0-9 _.-]+\.jsx$/.test(name) && !name.includes("..");
const hash = data => crypto.createHash("sha256").update(data).digest("hex");
function checksum(text) {
    let a = 1, b = 0;
    for (let i = 0; i < text.length; i++) { a = (a + text.charCodeAt(i)) % 65521; b = (b + a) % 65521; }
    return String(b * 65536 + a);
}
function prepare(text) { return text.replace(/^\uFEFF/, "").replace(/^#target[^\r\n]*/gm, "").replace(/\$\.evalFile\s*\(/g, "$.global.__aectBundleV1.evalFile("); }
function encodeModule(text) {
    return JSON.stringify(text).replace(/\*\//g, "*\\/").replace(/[\u007f-\uffff]/g,
        character => "\\u" + character.charCodeAt(0).toString(16).padStart(4, "0"));
}
function checkInventory(bundleRoot, source) {
    const inventory = JSON.parse(fs.readFileSync(path.join(bundleRoot, "source/script-inventory.json"), "utf8"));
    for (const name of inventory.names) {
        if (!Object.hasOwn(source.branches, name)) { throw new Error("Missing original branch: " + name); }
    }
}
function functionCatalog(functionsRuntime, names, bridge, revision) {
    const sandbox = { $: { global: { __aectBundleV1: { names, has: name => names.includes(name) } } } };
    vm.runInNewContext(functionsRuntime, sandbox, { timeout: 3000, filename: "functions-runtime.js" });
    const api = sandbox.$.global.__aectFunctionsV1;
    if (!api || typeof api.list !== "function") { throw new Error("Function registry is missing"); }
    const descriptors = JSON.parse(JSON.stringify(api.list(true)));
    return { schema: "aect-functions-catalog/v1", bridgeVersion: bridge.match(/BRIDGE_VERSION\s*=\s*"([^"]+)"/)?.[1] || "fixture",
        revision, functions: descriptors.filter(item => !item.legacy && !item.internal),
        maintenanceFunctions: descriptors.filter(item => item.internal && !item.legacy),
        legacyBranches: names.map(name => ({ name, function: "team.script.run", args: { branch: name },
            description: "Preserved JSX branch. Inspect source requirements before using it in a project." })) };
}
function build(bundleRoot = root, options = {}) {
    const editableSource = options.source || JSON.parse(fs.readFileSync(path.join(bundleRoot, "source/scripts.json"), "utf8"));
    const source = expandSource(editableSource);
    const packed = editableSource.schema === "aect-scripts/v2" ? editableSource : consolidateSource(source).source;
    const names = Object.keys(source.branches).sort();
    if (!names.length) { throw new Error("No branches"); }
    const runtime = fs.readFileSync(path.join(bundleRoot, "source/bundle-runtime.js"), "utf8");
    const functionsRuntime = readFunctionsRuntime(bundleRoot);
    const bridge = fs.readFileSync(path.join(bundleRoot, "source/bridge.js"), "utf8").replace(/^#.*\r?\n/gm, "");
    new vm.Script(runtime + "\n" + functionsRuntime + "\n" + bridge);
    checkInventory(bundleRoot, source);
    const foldedNames = new Set();
    for (const name of names) {
        if (foldedNames.has(name.toLowerCase())) { throw new Error("Case-insensitive duplicate branch: " + name); }
        foldedNames.add(name.toLowerCase());
    }
    let offset = 0;
    const rows = [], records = [];
    for (const name of names) {
        if (!validName(name) || name === "AECT Engine.jsx" || typeof source.branches[name] !== "string") { throw new Error("Invalid branch: " + name); }
        const text = source.branches[name];
        try { new vm.Script(prepare(text), { filename: name }); }
        catch (error) { throw new Error("Branch syntax error in " + name + ": " + error.message); }
        const deps = new Set();
        for (const match of text.matchAll(/\/jsx\/([A-Za-z0-9 _.-]+\.jsx)/g)) { deps.add(match[1]); }
        for (const dep of deps) {
            if (dep !== "AECT Engine.jsx" && !Object.hasOwn(source.branches, dep)) { throw new Error("Missing dependency " + dep + " in " + name); }
        }
        const parts = packed.branches[name].parts;
        const recipe = parts.map(part => typeof part === "string" ? [part, 0, packed.modules[part].length] : part).map(part => part.join(":")).join("|");
        const record = encodeURIComponent(recipe);
        rows.push(["B", name, offset, record.length, checksum(record), [...deps].sort().join("|"), checksum(encodeURIComponent(text))].join("\t"));
        records.push(record); offset += record.length + 1;
    }
    const moduleNames = Object.keys(packed.modules).sort();
    for (const name of moduleNames) {
        if (!/^m[0-9]+$/.test(name)) { throw new Error("Invalid shared module ID: " + name); }
        const record = encodeModule(packed.modules[name]);
        rows.push(["M", name, offset, record.length, checksum(record)].join("\t"));
        records.push(record); offset += record.length + 1;
    }
    const index = rows.join("\n") + "\n";
    const body = runtime + "\n" + functionsRuntime + "\n" + bridge + "\n/* AECT_BUNDLE_DATA\n";
    const revision = hash(runtime + functionsRuntime + bridge + JSON.stringify(packed));
    const catalog = functionCatalog(functionsRuntime, names, bridge, revision);
    const capabilities = analyzeCapabilities(source, {
        inventoryNames: JSON.parse(fs.readFileSync(path.join(bundleRoot, "source/script-inventory.json"), "utf8")).names
    });
    capabilities.revision = revision;
    // Bind discovery to the exact editable inputs, including dry-run/fixture overrides.
    capabilities.sourceFileSha256 = options.source ? hash(JSON.stringify(editableSource)) : hash(fs.readFileSync(path.join(bundleRoot, "source/scripts.json")));
    capabilities.inventoryFileSha256 = hash(fs.readFileSync(path.join(bundleRoot, "source/script-inventory.json")));
    if (!capabilities.coverage.complete || capabilities.summary.syntaxInvalid || capabilities.branches.some(entry => entry.missingDependencies.length)) {
        throw new Error("Capability analysis failed: missing branch, syntax error or dependency");
    }
    catalog.capabilitiesRelativePath = ".ae-codex/functions/capabilities.json";
    catalog.capabilitySummary = capabilities.summary;
    catalog.legacyBranches = capabilities.branches.map(entry => ({
        name: entry.name, id: entry.capabilityId, function: "team.script.run", args: { branch: entry.name },
        description: entry.description, categories: entry.categories, risks: entry.risks, sourceSha256: entry.sourceSha256,
        runtimeVerified: false
    }));
    let header = "", previous, output;
    do {
        previous = header;
        const indexOffset = Buffer.byteLength(header + body);
        const total = indexOffset + index.length + offset + 3;
        header = '#target aftereffects\n#targetengine "aeCodexTeamBridge"\n' +
            ["// AECT_BUNDLE_V2", revision, total, indexOffset, index.length, checksum(index), names.length].join("\t") + "\n";
    } while (header !== previous);
    output = header + body + index + records.join("\n") + "\n*/\n";
    const outputPath = path.join(bundleRoot, "jsx/AECT Engine.jsx");
    verify(output, source);
    fs.mkdirSync(path.dirname(outputPath), { recursive: true });
    if (!options.dryRun && (!fs.existsSync(outputPath) || fs.readFileSync(outputPath, "utf8") !== output)) {
        fs.writeFileSync(outputPath + ".tmp", output, "utf8");
        fs.renameSync(outputPath + ".tmp", outputPath);
    }
    if (!options.dryRun) {
        const catalogPath = path.join(bundleRoot, ".ae-codex/functions/catalog.json");
        fs.mkdirSync(path.dirname(catalogPath), { recursive: true });
        const catalogText = JSON.stringify(catalog, null, 2) + "\n";
        if (!fs.existsSync(catalogPath) || fs.readFileSync(catalogPath, "utf8") !== catalogText) {
            fs.writeFileSync(catalogPath + ".tmp", catalogText, "utf8"); fs.renameSync(catalogPath + ".tmp", catalogPath);
        }
        const capabilitiesPath = path.join(bundleRoot, ".ae-codex/functions/capabilities.json");
        const capabilitiesText = JSON.stringify(capabilities, null, 2) + "\n";
        if (!fs.existsSync(capabilitiesPath) || fs.readFileSync(capabilitiesPath, "utf8") !== capabilitiesText) {
            fs.writeFileSync(capabilitiesPath + ".tmp", capabilitiesText, "utf8"); fs.renameSync(capabilitiesPath + ".tmp", capabilitiesPath);
        }
    }
    return { file: outputPath, branches: names.length, modules: moduleNames.length, bytes: Buffer.byteLength(output), revision, sha256: hash(output) };
}
function verify(output, source) {
    const bytes = Buffer.from(output), fields = output.split("\n", 3)[2].split("\t");
    if (fields[0] !== "// AECT_BUNDLE_V2" || fields.length !== 7 || bytes.length !== Number(fields[2])) { throw new Error("Bundle header mismatch"); }
    if (source) { source = expandSource(source); }
    const index = bytes.subarray(Number(fields[3]), Number(fields[3]) + Number(fields[4])).toString("ascii");
    if (checksum(index) !== fields[5]) { throw new Error("Bundle index checksum mismatch"); }
    const rows = index.trimEnd().split("\n"), found = new Set(), folded = new Set(), payload = Number(fields[3]) + Number(fields[4]), modules = new Map(), branches = [];
    let end = 0;
    for (const line of rows) {
        const row = line.split("\t"), [kind, name, offset, length, sum] = row;
        if ((kind === "B" && (row.length !== 7 || !validName(name) || folded.has(name.toLowerCase()))) ||
            (kind === "M" && (row.length !== 5 || !/^m[0-9]+$/.test(name) || modules.has(name))) ||
            !["B", "M"].includes(kind) || !/^\d+$/.test(offset) || !/^\d+$/.test(length) || !/^\d+$/.test(sum) || Number(offset) !== end) {
            throw new Error("Duplicate/invalid bundle record: " + name);
        }
        const record = bytes.subarray(payload + Number(offset), payload + Number(offset) + Number(length)).toString("ascii");
        if (checksum(record) !== sum) { throw new Error("Corrupt branch: " + name); }
        end = Number(offset) + Number(length) + 1;
        if (kind === "M") {
            const text = JSON.parse(record);
            if (typeof text !== "string") { throw new Error("Invalid module string: " + name); }
            modules.set(name, text);
        }
        else { found.add(name); folded.add(name.toLowerCase()); branches.push({ name, recipe: decodeURIComponent(record), sourceChecksum: row[6], dependencies: row[5] }); }
    }
    if (payload + end + 3 !== bytes.length || found.size !== Number(fields[6])) { throw new Error("Bundle count/size mismatch"); }
    for (const branch of branches) {
        const name = branch.name;
        const text = (branch.recipe ? branch.recipe.split("|") : []).map(slice => {
            const [module, start, length, ...rest] = slice.split(":");
            if (!modules.has(module) || rest.length || !/^\d+$/.test(start) || !/^\d+$/.test(length) || Number(start) + Number(length) > modules.get(module).length) {
                throw new Error("Invalid module slice in " + name);
            }
            return modules.get(module).slice(Number(start), Number(start) + Number(length));
        }).join("");
        if (checksum(encodeURIComponent(text)) !== branch.sourceChecksum) { throw new Error("Branch source checksum mismatch: " + name); }
        for (const dep of branch.dependencies ? branch.dependencies.split("|") : []) {
            if (dep !== "AECT Engine.jsx" && !found.has(dep)) { throw new Error("Missing bundle dependency: " + dep); }
        }
        if (source && source.branches[name] !== text) { throw new Error("Branch round-trip mismatch: " + name); }
        new vm.Script(prepare(text), { filename: name });
    }
    if (source && found.size !== Object.keys(source.branches).length) { throw new Error("Missing source branches"); }
    new vm.Script(output.replace(/^#.*$/gm, ""), { filename: "AECT Engine.jsx" });
    return { branches: found.size, modules: modules.size, bytes: bytes.length, revision: fields[1] };
}
if (require.main === module) {
    try {
        const args = process.argv.slice(2);
        if (args[0] === "--verify") {
            const source = expandSource(JSON.parse(fs.readFileSync(path.join(root, "source/scripts.json"), "utf8")));
            checkInventory(root, source);
            const result = verify(fs.readFileSync(path.join(root, "jsx/AECT Engine.jsx"), "utf8"), source);
            const coverage = require("./AeCapabilities.js").capabilityStatus();
            result.capabilities = { functions: coverage.functions, scripts: coverage.scripts, complete: coverage.coverage.complete };
            console.log(JSON.stringify(result));
        } else if (args[0] === "--export") {
            const source = expandSource(JSON.parse(fs.readFileSync(path.join(root, "source/scripts.json"), "utf8")));
            const name = args[1], destination = path.resolve(args[2] || path.join(root, "jsx", name || ""));
            if (!validName(name) || !Object.hasOwn(source.branches, name)) { throw new Error("Unknown branch: " + name); }
            if (fs.existsSync(destination)) { throw new Error("Export destination exists: " + destination); }
            fs.mkdirSync(path.dirname(destination), { recursive: true });
            fs.writeFileSync(destination, source.branches[name]); console.log(destination);
        } else if (args[0] === "--optimize") {
            const sourcePath = path.join(root, "source/scripts.json");
            const source = JSON.parse(fs.readFileSync(sourcePath, "utf8"));
            const beforeBundleBytes = fs.existsSync(path.join(root, "jsx/AECT Engine.jsx")) ? fs.statSync(path.join(root, "jsx/AECT Engine.jsx")).size : 0;
            const consolidated = consolidateSource(source);
            build(root, { source: consolidated.source, dryRun: true });
            const backups = path.join(root, ".ae-codex/bundle/backups"); fs.mkdirSync(backups, { recursive: true });
            const backupPath = path.join(backups, "scripts-before-optimize-" + Date.now() + ".json");
            fs.copyFileSync(sourcePath, backupPath);
            fs.writeFileSync(sourcePath + ".tmp", JSON.stringify(consolidated.source) + "\n");
            fs.renameSync(sourcePath + ".tmp", sourcePath);
            const result = { ...build(), ...consolidated.stats, beforeBundleBytes, backupPath,
                sourceFileBytes: fs.statSync(sourcePath).size };
            const report = path.join(root, ".ae-codex/bundle/optimization-result.json");
            fs.writeFileSync(report, JSON.stringify(result, null, 2) + "\n");
            console.log(JSON.stringify(result));
        } else if (args[0] === "--update") {
            const sourcePath = path.join(root, "source/scripts.json"), source = expandSource(JSON.parse(fs.readFileSync(sourcePath, "utf8")));
            const input = path.resolve(args[1]), name = path.basename(input);
            if (!validName(name) || name === "AECT Engine.jsx") { throw new Error("Invalid branch input"); }
            if (fs.lstatSync(input).isSymbolicLink()) { throw new Error("Refusing a staged symbolic link"); }
            const text = fs.readFileSync(input, "utf8"); new vm.Script(prepare(text));
            source.branches[name] = text;
            const consolidated = consolidateSource(source);
            build(root, { source: consolidated.source, dryRun: true });
            if (fs.readFileSync(input, "utf8") !== text) { throw new Error("Staged source changed during validation"); }
            // Keep a recoverable source snapshot for every edit.
            const backups = path.join(root, ".ae-codex/bundle/backups"); fs.mkdirSync(backups, { recursive: true });
            fs.copyFileSync(sourcePath, path.join(backups, "scripts-" + Date.now() + ".json"));
            fs.writeFileSync(sourcePath + ".tmp", JSON.stringify(consolidated.source) + "\n");
            fs.renameSync(sourcePath + ".tmp", sourcePath);
            const inventoryPath = path.join(root, "source/script-inventory.json");
            const inventory = JSON.parse(fs.readFileSync(inventoryPath, "utf8"));
            inventory.names = [...new Set([...inventory.names, ...Object.keys(source.branches)])].sort();
            fs.writeFileSync(inventoryPath + ".tmp", JSON.stringify(inventory, null, 2) + "\n");
            fs.renameSync(inventoryPath + ".tmp", inventoryPath);
            const result = build();
            if (path.dirname(input) === path.join(root, "jsx")) {
                if (fs.lstatSync(input).isSymbolicLink()) { throw new Error("Refusing to consume a symbolic link"); }
                if (fs.readFileSync(input, "utf8") !== text) { throw new Error("Staged source changed during update"); }
                fs.unlinkSync(input);
                result.consumedStagingFile = input;
            }
            console.log(JSON.stringify(result));
        } else if (!args.length) { console.log(JSON.stringify(build())); }
        else { throw new Error("Use --verify, --optimize, --export <branch.jsx> [path], --update <file.jsx>, or no arguments to build"); }
    } catch (error) { console.error(error.message); process.exitCode = 1; }
}
module.exports = { build, verify, checksum, prepare, expandSource, checkInventory, functionCatalog };
