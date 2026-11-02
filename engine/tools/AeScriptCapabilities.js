/* Offline discovery only. This module parses and labels JSX; it never executes it. */
"use strict";
const crypto = require("node:crypto");
const vm = require("node:vm");
const { expandSource } = require("./AeScriptSource.js");

const sha256 = value => crypto.createHash("sha256").update(value, "utf8").digest("hex");
const compare = (left, right) => left < right ? -1 : left > right ? 1 : 0;
const unique = values => [...new Set(values)].sort(compare);
const trim = (value, length) => String(value).replace(/\s+/g, " ").trim().slice(0, length);
const LIMIT = 16, HINT_LENGTH = 160;
const SYNTAX_PARSER = "node-vm-compatible-syntax";

function decodeString(raw) {
    let result = "";
    for (let index = 1; index < raw.length - 1; index++) {
        const character = raw[index];
        if (character !== "\\") { result += character; continue; }
        index++;
        const escaped = raw[index];
        const simple = { n: "\n", r: "\r", t: "\t", b: "\b", f: "\f", v: "\v" };
        if (Object.hasOwn(simple, escaped)) { result += simple[escaped]; }
        else if (escaped === "\n") { /* line continuation */ }
        else if (escaped === "\r") { if (raw[index + 1] === "\n") { index++; } }
        else if (escaped === "x" && /^[a-f0-9]{2}$/i.test(raw.slice(index + 1, index + 3))) {
            result += String.fromCharCode(parseInt(raw.slice(index + 1, index + 3), 16)); index += 2;
        } else if (escaped === "u" && /^[a-f0-9]{4}$/i.test(raw.slice(index + 1, index + 5))) {
            result += String.fromCharCode(parseInt(raw.slice(index + 1, index + 5), 16)); index += 4;
        } else if (/[0-7]/.test(escaped || "")) {
            const octal = raw.slice(index).match(/^[0-7]{1,3}/)[0];
            result += String.fromCharCode(parseInt(octal, 8)); index += octal.length - 1;
        } else { result += escaped || ""; }
    }
    return result;
}

// A small lexical scanner keeps comments and strings out of API/risk matching.
// It is not an ES3 parser; actual syntax eligibility is reported separately.
function lex(source) {
    const tokens = [], comments = [];
    let offset = 0, line = 1;
    function consume(end) {
        for (let index = offset; index < end; index++) { if (source[index] === "\n") { line++; } }
        offset = end;
    }
    while (offset < source.length) {
        const start = offset, startLine = line, character = source[offset], next = source[offset + 1];
        if (/\s/.test(character) || character === "\uFEFF") { consume(offset + 1); continue; }
        if (character === "#" && (offset === 0 || /[\r\n]/.test(source[offset - 1]))) {
            const end = source.indexOf("\n", offset); consume(end < 0 ? source.length : end); continue;
        }
        if (character === "/" && (next === "/" || next === "*")) {
            let end = next === "/" ? source.indexOf("\n", offset + 2) : source.indexOf("*/", offset + 2);
            if (end < 0) { end = source.length; } else if (next === "*") { end += 2; }
            comments.push({ text: source.slice(offset + 2, next === "*" ? end - 2 : end), line, start: offset });
            consume(end); continue;
        }
        if (character === "\"" || character === "'") {
            let end = offset + 1;
            while (end < source.length) {
                if (source[end] === "\\") { end += 2; }
                else if (source[end++] === character) { break; }
            }
            end = Math.min(end, source.length);
            const raw = source.slice(start, end);
            tokens.push({ kind: "string", value: decodeString(raw), raw, line: startLine, start });
            consume(end); continue;
        }
        const identifier = source.slice(offset).match(/^[A-Za-z_$\u0080-\uffff][A-Za-z0-9_$\u0080-\uffff]*/);
        if (identifier) {
            tokens.push({ kind: "identifier", value: identifier[0], line, start });
            consume(offset + identifier[0].length); continue;
        }
        const number = source.slice(offset).match(/^(?:0[xX][a-fA-F0-9]+|(?:\d+\.?\d*|\.\d+)(?:[eE][+-]?\d+)?)/);
        if (number) {
            tokens.push({ kind: "number", value: number[0], line, start });
            consume(offset + number[0].length); continue;
        }
        const previous = tokens[tokens.length - 1];
        const regexStart = !previous || /^(?:\(|\[|\{|=|:|,|;|!|\?|&&|\|\|)$/.test(previous.value) ||
            (previous.kind === "identifier" && /^(?:return|throw|case|typeof|void|delete|in|instanceof)$/.test(previous.value));
        if (character === "/" && next !== "=" && regexStart) {
            let end = offset + 1, inClass = false, closed = false;
            while (end < source.length && source[end] !== "\n" && source[end] !== "\r") {
                if (source[end] === "\\") { end += 2; continue; }
                if (source[end] === "[") { inClass = true; }
                if (source[end] === "]") { inClass = false; }
                if (source[end++] === "/" && !inClass) { closed = true; break; }
            }
            if (closed) {
                while (/[A-Za-z]/.test(source[end] || "")) { end++; }
                tokens.push({ kind: "regex", value: source.slice(start, end), line, start });
                consume(end); continue;
            }
        }
        const operator = source.slice(offset).match(/^(?:===|!==|>>>|<<=|>>=|==|!=|<=|>=|\+\+|--|&&|\|\||\+=|-=|\*=|\/=|<<|>>)/);
        const value = operator ? operator[0] : character;
        tokens.push({ kind: "punctuation", value, line, start }); consume(offset + value.length);
    }
    return { tokens, comments };
}

function syntax(source, name) {
    const prepared = source.replace(/^\uFEFF/, "").replace(/^#target[^\r\n]*/gm, "")
        .replace(/\$\.evalFile\s*\(/g, "$.global.__aectBundleV1.evalFile(");
    try { new vm.Script(prepared, { filename: name }); return { valid: true, parser: SYNTAX_PARSER }; }
    catch (error) { return { valid: false, parser: SYNTAX_PARSER, error: trim(error.message, 240) }; }
}

function toolName(name) {
    const slug = name.replace(/\.jsx$/i, "").toLowerCase().replace(/[^a-z0-9]+/g, "_").replace(/^_+|_+$/g, "") || "branch";
    return "ae_script_" + slug.slice(0, 43) + "_" + sha256(name).slice(0, 10);
}

function description(name, comments, tokens) {
    const title = trim(name.replace(/\.jsx$/i, "").replace(/[-_]+/g, " "), 110);
    const leading = comments.find(comment => comment.start < (tokens[0]?.start ?? Infinity) && /[A-Za-z]/.test(comment.text));
    if (!leading) { return "Preserved script: " + title + ". Static source analysis only."; }
    const text = trim(leading.text.replace(/^\s*\*\s?/gm, "").replace(/^\s*(?:@[^\n]+\n)+/, ""), 180);
    return text ? title + ": " + text : "Preserved script: " + title + ".";
}

function analyzeBranch(name, source, allNames) {
    const { tokens, comments } = lex(source);
    const hints = { comps: [], layers: [], files: [], effects: [], truncated: false };
    const hintSeen = { comps: new Set(), layers: new Set(), files: new Set(), effects: new Set() };
    function hint(kind, token, via) {
        const input = token.value;
        if (!input || /[\r\n\0]/.test(input)) { return; }
        const value = trim(input, HINT_LENGTH);
        if (!value || hintSeen[kind].has(value)) { return; }
        hintSeen[kind].add(value);
        if (hints[kind].length >= LIMIT) { hints.truncated = true; return; }
        if (input.length > HINT_LENGTH) { hints.truncated = true; }
        hints[kind].push({ value, line: token.line, via });
    }
    const risks = new Set(), categories = new Set(), dependencies = new Set();
    const fileBindings = new Set(), projectBindings = new Set(), stringBindings = new Set();
    for (let index = 0; index < tokens.length; index++) {
        if (tokens[index].kind !== "identifier" || tokens[index + 1]?.value !== "=") { continue; }
        if (tokens[index + 2]?.value === "new" && tokens[index + 3]?.value === "File") { fileBindings.add(tokens[index].value); }
        if (tokens[index + 2]?.value === "app" && tokens[index + 3]?.value === "." && tokens[index + 4]?.value === "project") { projectBindings.add(tokens[index].value); }
        if (tokens[index + 2]?.kind === "string") { stringBindings.add(tokens[index].value); }
    }
    let mutation = false, possibleMutation = false;
    const codeName = name.toLowerCase();
    if (/^(?:inspect|audit|read|check|verify|hello)[-_ .]/.test(codeName)) { categories.add("inspection"); }
    if (/^(?:capture|preview|export)[-_ .]/.test(codeName)) { categories.add("capture-export"); }
    if (/(?:^|[-_ ])(?:audio|sfx|voice|sound|music|beat)(?:[-_ .]|$)/.test(codeName)) { categories.add("audio"); }
    if (/(?:^|[-_ ])(?:text|caption|title|typography)(?:[-_ .]|$)/.test(codeName)) { categories.add("text"); }
    if (/(?:^|[-_ ])(?:camera|zoom|motion|timing|retime|animation)(?:[-_ .]|$)/.test(codeName)) { categories.add("animation"); }
    if (/(?:^|[-_ ])(?:effect|fx|vfx|glow|plugin)(?:[-_ .]|$)/.test(codeName)) { categories.add("effects"); }
    for (let index = 0; index < tokens.length; index++) {
        const token = tokens[index], previous = tokens[index - 1], next = tokens[index + 1];
        if (token.kind === "string") {
            if (/^(?:[A-Za-z]:[\\/]|\\\\|\.\.?[\\/])/.test(token.value) ||
                    /[\\/][^\\/]+\.(?:aep|aepx|jsx|ffx|mov|mp4|wav|mp3|png|jpg|jpeg|json|tsv|txt|log)$/i.test(token.value)) {
                hint("files", token, "path literal");
            }
            if (/^(?:S_|BCC |RG |uni\.|Twixtor|Deep Glow|Particular|Element$)/.test(token.value)) {
                hint("effects", token, "property/matchName literal");
            }
            const pathDependency = token.value.match(/(?:^|[\\/])jsx[\\/]([A-Za-z0-9 _.-]+\.jsx)(?:$|[\\/])/i);
            if (pathDependency) { dependencies.add(pathDependency[1]); }
            if (previous?.value === "(" && tokens[index - 2]?.kind === "identifier") {
                const callee = tokens[index - 2].value;
                if (/^(?:find|get|require|resolve|select|target)?(?:Comp|Composition)(?:ByName)?$/i.test(callee)) {
                    hint("comps", token, callee + " literal");
                }
                if (/^(?:find|get|require|resolve|select|target)?Layer(?:ByName)?$/i.test(callee)) {
                    hint("layers", token, callee + " literal");
                }
                if (callee === "addProperty" && !/^ADBE (?:Vector|Root Vectors|Transform|Text|Mask|Effect Parade|Position|Anchor|Scale|Rotate|Opacity|Material|Camera|Light)/.test(token.value)) {
                    hint("effects", token, "addProperty literal");
                }
                if (callee === "effect") { hint("effects", token, "effect lookup literal"); }
            }
            const assignName = tokens[index - 2];
            if (previous?.value === "=" && assignName?.kind === "identifier") {
                if (/^(?:(?:target|source|active|destination|main|parent|child|pre)?comp(?:osition)?_?name|COMP_NAME)$/i.test(assignName.value)) {
                    hint("comps", token, assignName.value + " assignment");
                }
                if (/^(?:(?:target|source|active|destination|main|parent|child)?layer_?name|LAYER_NAME)$/i.test(assignName.value)) {
                    hint("layers", token, assignName.value + " assignment");
                }
            }
            if ((previous?.value === "===" || previous?.value === "==") && tokens[index - 2]?.value === "name") {
                const owner = tokens[index - 4];
                if (owner?.kind === "identifier" && /comp/i.test(owner.value)) { hint("comps", token, "composition name comparison"); }
                if (owner?.kind === "identifier" && /layer/i.test(owner.value)) { hint("layers", token, "layer name comparison"); }
            }
        }
        if (token.kind !== "identifier") { continue; }
        const value = token.value;
        if (next?.value === "(" && previous?.value === ".") {
            if (/^(?:save|saveWithDialog|saveAsTemplate)$/.test(value)) { risks.add("project-save"); mutation = true; }
            if (/^(?:remove|removeAll)$/.test(value)) {
                const owner = tokens[index - 2];
                if (owner?.kind === "identifier" && (fileBindings.has(owner.value) || /file|folder/i.test(owner.value))) { risks.add("file-delete"); }
                else { risks.add("delete"); possibleMutation = true; }
            }
            if (value === "close") {
                const owner = tokens[index - 2];
                if (owner?.kind === "identifier" && (projectBindings.has(owner.value) ||
                        (owner.value === "project" && tokens[index - 3]?.value === "." && tokens[index - 4]?.value === "app"))) {
                    risks.add("project-close"); mutation = true;
                } else if (owner?.kind === "identifier" && (fileBindings.has(owner.value) || /file|handle|stream|reader|writer/i.test(owner.value))) {
                    risks.add("file-close");
                } else { risks.add("ambiguous-close"); }
            }
            if (/^(?:render|renderAsync|queueInAME)$/.test(value)) { risks.add("render-export"); }
            if (value === "saveFrameToPng") { risks.add("frame-export"); }
            if (/^(?:importFile|importFileWithDialog|importPlaceholder|replaceWithSequence)$/.test(value)) { risks.add("import-replace"); mutation = true; }
            if (value === "replace") {
                const owner = tokens[index - 2];
                if (owner?.kind !== "string" && !(owner?.kind === "identifier" && stringBindings.has(owner.value))) {
                    risks.add("ambiguous-media-or-string-replace"); possibleMutation = true;
                }
            }
            if (/^(?:addText|addBoxText|addSolid|addShape|addNull|addCamera|addLight|addComp|addFolder|addProperty|duplicate|copyToComp|applyPreset|setValue|setValueAtTime|setValueAtKey|setValuesAtTimes|setInterpolationTypeAtKey|setTemporalEaseAtKey|removeKey|moveBefore|moveAfter|moveToBeginning|moveToEnd)$/.test(value)) {
                mutation = true;
            }
            if (value === "add") { possibleMutation = true; }
            if (/^(?:write|writeln|writech|rename|copy|execute)$/.test(value)) { risks.add("file-io-or-external-action"); }
            if (value === "callSystem") { risks.add("external-process"); }
            if (value === "evalFile") {
                risks.add("dynamic-script-loading");
                let argument = tokens[index + 2];
                if (argument?.value === "new" && tokens[index + 3]?.value === "File" && tokens[index + 4]?.value === "(") {
                    argument = tokens[index + 5];
                }
                if (argument?.kind === "string" && /\.jsx$/i.test(argument.value)) {
                    dependencies.add(argument.value.replace(/\\/g, "/").split("/").pop());
                }
            }
        }
        if (next?.value === "(" && /^(?:alert|confirm|prompt)$/.test(value)) { risks.add("modal-input"); }
        if (next?.value === "(" && /^(?:eval|Function)$/.test(value)) { risks.add("dynamic-code"); }
        if (previous?.value === "." && /^(?:expression|timeRemapEnabled|enabled|name|startTime|inPoint|outPoint|stretch|parent|threeDLayer|blendingMode|trackMatteType|locked|shy|label)$/.test(value) &&
                /^(?:=|\+=|-=|\+\+|--)$/.test(next?.value || "")) { possibleMutation = true; }
        if (previous?.value === "." && value === "expression" && next?.value === "=") { risks.add("expression-assignment"); categories.add("animation"); }
        if (/^(?:addText|addBoxText|TextDocument)$/.test(value)) { categories.add("text"); }
        if (/^(?:setValueAtTime|setValuesAtTimes|setTemporalEaseAtKey|KeyframeEase)$/.test(value)) { categories.add("animation"); }
        if (/^(?:addProperty|applyPreset)$/.test(value)) { categories.add("effects"); }
        if (/^(?:audioEnabled|audioLevels|hasAudio)$/.test(value)) { categories.add("audio"); }
        if (/^(?:addComp|CompItem)$/.test(value)) { categories.add("composition"); }
        if (/^(?:layers|Layer|AVLayer|ShapeLayer|TextLayer)$/.test(value)) { categories.add("layers"); }
    }
    if (hints.comps.length || hints.layers.length || hints.files.length) { categories.add("static-project-hints"); }
    if (!categories.size) { categories.add("utility"); }
    const internal = /^Codex Library\.jsx$/i.test(name);
    if (internal) { categories.add("internal-inventory"); }
    const shortDescription = description(name, comments, tokens);
    const words = [name, shortDescription, ...categories, ...risks, ...dependencies, ...Object.values(hints).flatMap(value => Array.isArray(value) ? value.map(item => item.value) : [])]
        .join(" ").toLowerCase().match(/[a-z0-9\u00c0-\uffff]+/g) || [];
    const id = toolName(name);
    const structuralHash = sha256(tokens.map(token => token.kind === "string" ? "<string>" : token.kind === "number" ? "<number>" : token.value).join("\n"));
    return { entry: {
        name, capabilityId: id, toolName: id, kind: "legacy-script", internal,
        description: shortDescription, categories: [...categories].sort(compare), searchTokens: unique(words).slice(0, 96),
        sourceSha256: sha256(source), sourceBytes: Buffer.byteLength(source, "utf8"),
        call: { function: "team.script.run", args: { branch: name } },
        staticHints: hints, risks: [...risks].sort(compare), projectMutation: mutation ? "detected" : possibleMutation ? "possible" : "not-detected",
        dependencies: [...dependencies].sort(compare), missingDependencies: [...dependencies].filter(dependency => dependency !== "AECT Engine.jsx" && !allNames.has(dependency)).sort(compare),
        syntax: syntax(source, name), duplicates: { exactGroup: null, structuralGroup: null }, runtimeVerified: false
    }, structuralHash };
}

function analyzeCapabilities(source, options = {}) {
    const expanded = expandSource(source), names = Object.keys(expanded.branches).sort(compare);
    const allNames = new Set(names), inventory = unique(options.inventoryNames || names);
    const analyzed = names.map(name => analyzeBranch(name, expanded.branches[name], allNames));
    const exact = new Map(), structural = new Map();
    for (const item of analyzed) {
        if (!exact.has(item.entry.sourceSha256)) { exact.set(item.entry.sourceSha256, []); }
        exact.get(item.entry.sourceSha256).push(item.entry.name);
        if (!structural.has(item.structuralHash)) { structural.set(item.structuralHash, []); }
        structural.get(item.structuralHash).push(item.entry.name);
    }
    const exactGroups = [...exact.entries()].filter(([, members]) => members.length > 1)
        .map(([digest, members]) => ({ id: "exact-" + digest, names: members })).sort((a, b) => compare(a.id, b.id));
    const structuralGroups = [...structural.entries()].filter(([, members]) => members.length > 1 &&
        new Set(members.map(name => sha256(expanded.branches[name]))).size > 1)
        .map(([digest, members]) => ({ id: "shape-" + digest, names: members })).sort((a, b) => compare(a.id, b.id));
    const exactLookup = new Map(exactGroups.flatMap(group => group.names.map(name => [name, group.id])));
    const shapeLookup = new Map(structuralGroups.flatMap(group => group.names.map(name => [name, group.id])));
    const entries = analyzed.map(item => {
        item.entry.duplicates.exactGroup = exactLookup.get(item.entry.name) || null;
        item.entry.duplicates.structuralGroup = shapeLookup.get(item.entry.name) || null;
        return item.entry;
    });
    const inventorySet = new Set(inventory), missing = inventory.filter(name => !allNames.has(name));
    const extras = names.filter(name => !inventorySet.has(name));
    const riskCounts = {};
    for (const risk of unique(entries.flatMap(entry => entry.risks))) { riskCounts[risk] = entries.filter(entry => entry.risks.includes(risk)).length; }
    return {
        schema: "aect-script-capabilities/v1",
        analysis: { mode: "static-only", runtimeVerified: false, parser: SYNTAX_PARSER,
            limitations: ["Static hints are literal candidates, not verified project requirements.",
                "API matching is heuristic: aliases, dynamic receivers and shared method names can cause false positives or missed operations.",
                "No detected mutation or risk is not proof that a script is read-only or safe.",
                "Node-compatible syntax parsing does not prove ExtendScript ES3 or AE runtime compatibility.",
                "Structural duplicate groups ignore literal values; they are not semantic equivalence and are never merged."],
            hintLimitPerCategory: LIMIT, hintValueLimit: HINT_LENGTH, searchTokenLimit: 96 },
        coverage: { sourceBranches: names.length, inventoryBranches: inventory.length, mappedBranches: entries.length,
            missing, extras, complete: missing.length === 0 && entries.length === names.length },
        summary: { branches: entries.length, internalBranches: entries.filter(entry => entry.internal).length,
            syntaxValid: entries.filter(entry => entry.syntax.valid).length, syntaxInvalid: entries.filter(entry => !entry.syntax.valid).length,
            uniqueExactSources: exact.size, uniqueStructuralShapes: structural.size,
            exactDuplicateGroups: exactGroups.length, structuralVariantGroups: structuralGroups.length, riskCounts },
        branches: entries,
        duplicateGroups: { exact: exactGroups, structural: structuralGroups }
    };
}

module.exports = { analyzeCapabilities, toolName };
