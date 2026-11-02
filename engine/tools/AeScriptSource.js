/* Lossless, editable shared-source recipes. This tool never executes JSX. */
"use strict";

const crypto = require("node:crypto");
const V1 = "aect-scripts/v1";
const V2 = "aect-scripts/v2";
const own = (object, key) => Object.prototype.hasOwnProperty.call(object, key);
const sha256 = text => crypto.createHash("sha256").update(text, "utf8").digest("hex");
const validModule = name => /^m\d{5,}$/.test(name);
const validBranch = name => /^[A-Za-z0-9 _.-]+\.jsx$/.test(name) && !name.includes("..");
const isRecord = value => value !== null && typeof value === "object" && !Array.isArray(value) &&
    (Object.getPrototypeOf(value) === Object.prototype || Object.getPrototypeOf(value) === null);

function requireRecord(value, label) {
    if (!isRecord(value)) { throw new Error("Invalid " + label); }
}

function expandSource(source) {
    requireRecord(source, "scripts source");
    requireRecord(source.branches, "source branches");
    if (source.schema !== V1 && source.schema !== V2) { throw new Error("Unsupported scripts source schema"); }
    const branches = {};
    if (source.schema === V2) {
        requireRecord(source.modules, "source modules");
        for (const [id, text] of Object.entries(source.modules)) {
            if (!validModule(id) || typeof text !== "string") { throw new Error("Invalid source module: " + id); }
        }
    }
    for (const name of Object.keys(source.branches).sort()) {
        if (!validBranch(name)) { throw new Error("Invalid source branch: " + name); }
        const recipe = source.branches[name];
        if (source.schema === V1) {
            if (typeof recipe !== "string") { throw new Error("Invalid source text: " + name); }
            branches[name] = recipe;
            continue;
        }
        requireRecord(recipe, "source recipe: " + name);
        if (!Array.isArray(recipe.parts) || typeof recipe.sha256 !== "string" || !/^[a-f0-9]{64}$/.test(recipe.sha256)) {
            throw new Error("Invalid source recipe/hash: " + name);
        }
        const pieces = [];
        for (const part of recipe.parts) {
            const id = typeof part === "string" ? part : (Array.isArray(part) && part.length === 3 ? part[0] : null);
            if (typeof id !== "string" || !validModule(id) || !own(source.modules, id)) {
                throw new Error("Missing/invalid module in " + name + ": " + String(id));
            }
            const text = source.modules[id];
            if (typeof part === "string") { pieces.push(text); }
            else {
                const start = part[1], length = part[2];
                if (!Number.isSafeInteger(start) || !Number.isSafeInteger(length) || start < 0 || length < 1 ||
                        start > text.length || length > text.length - start) {
                    throw new Error("Invalid module slice in " + name + ": " + id);
                }
                // Slice and join UTF-16 strings directly; never decode an individual fragment.
                pieces.push(text.slice(start, start + length));
            }
        }
        const text = pieces.join("");
        if (sha256(text) !== recipe.sha256) { throw new Error("Source SHA-256 mismatch: " + name); }
        branches[name] = text;
    }
    return { schema: V1, branches };
}

function consolidateSource(input) {
    const original = expandSource(input);
    const names = Object.keys(original.branches).sort();
    // Large scripts make useful reusable baselines for smaller related scripts.
    const processingOrder = names.slice().sort((a, b) => original.branches[b].length - original.branches[a].length ||
        (a < b ? -1 : a > b ? 1 : 0));
    const modules = {}, recipes = {}, anchors = new Map(), exactModules = new Map(), exactRecipes = new Map();
    const anchorLength = 32, anchorStride = 16, minimumMatch = 96, candidateLimit = 16;
    let moduleCount = 0, referenceCount = 0, sharedCharacters = 0;

    function splitsSurrogate(text, position) {
        return position > 0 && position < text.length &&
            text.charCodeAt(position - 1) >= 0xd800 && text.charCodeAt(position - 1) <= 0xdbff &&
            text.charCodeAt(position) >= 0xdc00 && text.charCodeAt(position) <= 0xdfff;
    }

    function indexAnchor(id, text, position) {
        if (splitsSurrogate(text, position)) { return; }
        const key = text.slice(position, position + anchorLength);
        let candidates = anchors.get(key);
        if (!candidates) { candidates = []; anchors.set(key, candidates); }
        // The cap bounds both memory and worst-case searches for repeated whitespace/text.
        if (candidates.length < candidateLimit) { candidates.push({ id, position }); }
    }

    function storeLiteral(text) {
        if (exactModules.has(text)) { return exactModules.get(text); }
        const id = "m" + String(++moduleCount).padStart(5, "0");
        modules[id] = text;
        exactModules.set(text, id);
        for (let position = 0; position + anchorLength <= text.length; position += anchorStride) {
            indexAnchor(id, text, position);
        }
        const last = text.length - anchorLength;
        if (last >= 0 && last % anchorStride !== 0) { indexAnchor(id, text, last); }
        return id;
    }

    for (const name of processingOrder) {
        const text = original.branches[name], parts = [];
        if (exactRecipes.has(text)) {
            const prior = exactRecipes.get(text);
            recipes[name] = { parts: prior.parts.map(part => Array.isArray(part) ? part.slice() : part), sha256: prior.sha256 };
            referenceCount += prior.parts.length; sharedCharacters += text.length;
            continue;
        }
        let position = 0, literalStart = 0;
        if (exactModules.has(text)) {
            parts.push(exactModules.get(text));
            sharedCharacters += text.length;
            position = text.length; literalStart = position;
        }
        while (position + minimumMatch <= text.length) {
            const candidates = anchors.get(text.slice(position, position + anchorLength));
            let best = null, bestLength = 0;
            if (candidates) {
                for (const candidate of candidates) {
                    const module = modules[candidate.id];
                    const limit = Math.min(text.length - position, module.length - candidate.position);
                    if (limit <= bestLength || limit < minimumMatch) { continue; }
                    let length = anchorLength;
                    while (length < limit && text.charCodeAt(position + length) === module.charCodeAt(candidate.position + length)) {
                        length += 1;
                    }
                    // Each raw module must remain independently URI-encodable for the JSX payload.
                    if (splitsSurrogate(text, position + length) || splitsSurrogate(module, candidate.position + length)) { length -= 1; }
                    if (length >= minimumMatch && length > bestLength) { best = candidate; bestLength = length; }
                }
            }
            if (!best) { position += 1; continue; }
            if (position > literalStart) { parts.push(storeLiteral(text.slice(literalStart, position))); }
            const module = modules[best.id];
            parts.push(best.position === 0 && bestLength === module.length ? best.id : [best.id, best.position, bestLength]);
            sharedCharacters += bestLength;
            position += bestLength; literalStart = position;
        }
        if (literalStart < text.length) { parts.push(storeLiteral(text.slice(literalStart))); }
        recipes[name] = { parts, sha256: sha256(text) };
        exactRecipes.set(text, recipes[name]);
        referenceCount += parts.length;
    }
    const branches = {};
    for (const name of names) { branches[name] = recipes[name]; }
    const source = { schema: V2, modules, branches };
    const expanded = expandSource(source);
    for (const name of names) {
        if (expanded.branches[name] !== original.branches[name]) { throw new Error("Consolidation round-trip mismatch: " + name); }
    }
    const sourceBytes = Object.values(original.branches).reduce((sum, text) => sum + Buffer.byteLength(text, "utf8"), 0);
    const moduleBytes = Object.values(modules).reduce((sum, text) => sum + Buffer.byteLength(text, "utf8"), 0);
    const originalJsonBytes = Buffer.byteLength(JSON.stringify(original, null, 2) + "\n", "utf8");
    const consolidatedJsonBytes = Buffer.byteLength(JSON.stringify(source, null, 2) + "\n", "utf8");
    const compactJsonBytes = Buffer.byteLength(JSON.stringify(source) + "\n", "utf8");
    return { source, stats: {
        branches: names.length, uniqueImplementations: new Set(Object.values(original.branches)).size,
        modules: moduleCount, references: referenceCount, sourceBytes, moduleBytes,
        sharedCharacters, storedBytesSaved: sourceBytes - moduleBytes,
        originalJsonBytes, consolidatedJsonBytes, compactJsonBytes,
        jsonBytesSaved: originalJsonBytes - consolidatedJsonBytes
    } };
}

module.exports = { expandSource, consolidateSource };
