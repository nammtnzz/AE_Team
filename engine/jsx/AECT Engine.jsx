#target aftereffects
#targetengine "aeCodexTeamBridge"
// AECT_BUNDLE_V2	f3ac1f6b8dbf77ef3b1847699411c58f3257b5209f1467d56d307252dd8cda24	314768	269283	76	3649048789	1
/* ES3 runtime. Branch bodies remain inert in the indexed comment at EOF. */
(function () {
    function workspaceRoot() {
        var configured = $.global.__AECT_WORKSPACE_ROOT__, script;
        if (typeof configured === "string" && configured.replace(/^\s+|\s+$/g, "")) {
            return (new Folder(configured)).fsName.replace(/\\/g, "/").replace(/\/$/, "");
        }
        script = new File($.fileName);
        if (String(script.parent.name).toLowerCase() !== "jsx") {
            throw new Error("Open Codex Bridge through its installed loader or the workspace jsx folder.");
        }
        return script.parent.parent.fsName.replace(/\\/g, "/").replace(/\/$/, "");
    }
    var ROOT = workspaceRoot();
    var PATH = ROOT + "/jsx/AECT Engine.jsx";
    var nativeEvalFile = $.evalFile;
    function checksum(text) {
        var a = 1, b = 0, i;
        for (i = 0; i < text.length; i += 1) {
            a = (a + text.charCodeAt(i)) % 65521;
            b = (b + a) % 65521;
        }
        return String(b * 65536 + a);
    }
    function readRange(file, offset, length) {
        var text;
        if (!file.seek(offset, 0)) { throw new Error("Bundle seek failed: " + offset); }
        text = file.read(length);
        if (text.length !== length) { throw new Error("Bundle is truncated at " + offset); }
        return text;
    }
    function validName(name) {
        return /^[A-Za-z0-9 _.-]+\.jsx$/.test(name) && name.indexOf("..") < 0;
    }
    function decodeModule(record) {
        var out = [], i = 1, character, hex;
        if (record.charAt(0) !== '"' || record.charAt(record.length - 1) !== '"') { throw new Error("Invalid module string"); }
        while (i < record.length - 1) {
            character = record.charAt(i++);
            if (character === '"' || character.charCodeAt(0) < 32) { throw new Error("Invalid module string character"); }
            if (character === "\\") {
                character = record.charAt(i++);
                if (character === "u") {
                    hex = record.substr(i, 4);
                    if (!/^[0-9a-fA-F]{4}$/.test(hex) || i + 4 > record.length - 1) { throw new Error("Invalid module Unicode escape"); }
                    out.push(String.fromCharCode(parseInt(hex, 16))); i += 4;
                } else if (character === "n") { out.push("\n"); }
                else if (character === "r") { out.push("\r"); }
                else if (character === "t") { out.push("\t"); }
                else if (character === "b") { out.push("\b"); }
                else if (character === "f") { out.push("\f"); }
                else if (character === '"' || character === "/" || character === "\\") { out.push(character); }
                else { throw new Error("Invalid module escape"); }
            } else { out.push(character); }
        }
        if (i !== record.length - 1) { throw new Error("Truncated module string"); }
        return out.join("");
    }
    function Bundle() {
        this.revision = "";
        this.names = [];
        this.entries = {};
        this.modules = {};
        this.moduleCache = {};
        this.cacheOrder = [];
        this.cacheSize = 0;
        this.sharedModules = 0;
        this.checked = 0;
        this.errors = [];
        this.error = "";
        this.lastPoll = 0;
        this.lastCycle = 0;
        this.fileStamp = "";
        this.depth = 0;
        this.installation = { state: "missing", message: "Installation validation has not been recorded" };
    }
    Bundle.prototype.refresh = function (force) {
        var file = new File(PATH), stamp, fields, index, rows, row, i, j, end = 0, entries = {}, foldedNames = {}, names = [], modules = {}, moduleCount = 0;
        try {
            if (!file.exists || file.alias || file.parent.alias) { throw new Error("Workspace bundle missing or aliased"); }
            stamp = String(file.length) + ":" + (file.modified ? file.modified.getTime() : "");
            this.lastPoll = new Date().getTime();
            if (!force && stamp === this.fileStamp && !this.error) { return false; }
            file.encoding = "BINARY";
            if (!file.open("r")) { throw new Error("Cannot open workspace bundle: " + file.error); }
            try {
                file.readln(); file.readln(); fields = file.readln().split("\t");
                if (fields.length !== 7 || fields[0] !== "// AECT_BUNDLE_V2" ||
                        !/^[a-f0-9]{64}$/.test(fields[1])) { throw new Error("Invalid bundle header"); }
                for (i = 2; i < fields.length; i += 1) {
                    if (!/^\d+$/.test(fields[i])) { throw new Error("Invalid bundle header number"); }
                }
                if (Number(fields[2]) !== file.length || Number(fields[4]) > 1048576 ||
                        Number(fields[5]) > 4294967295 || Number(fields[6]) < 1) { throw new Error("Bundle size/count mismatch"); }
                index = readRange(file, Number(fields[3]), Number(fields[4]));
                if (checksum(index) !== fields[5]) { throw new Error("Bundle index checksum mismatch"); }
                rows = index.replace(/\n$/, "").split("\n");
                this.payloadOffset = Number(fields[3]) + Number(fields[4]);
                for (i = 0; i < rows.length; i += 1) {
                    row = rows[i].split("\t");
                    if (!/^\d+$/.test(row[2]) || !/^\d+$/.test(row[3]) || !/^\d+$/.test(row[4]) ||
                            Number(row[2]) !== end) { throw new Error("Invalid bundle record: " + row[1]); }
                    if (row[0] === "B" && row.length === 7 && validName(row[1]) && !foldedNames.hasOwnProperty(row[1].toLowerCase()) && /^\d+$/.test(row[6])) {
                        entries[row[1]] = { offset: Number(row[2]), length: Number(row[3]), checksum: row[4], sourceChecksum: row[6],
                            dependencies: row[5] ? row[5].split("|") : [], state: "pending", error: "" };
                        names.push(row[1]);
                        foldedNames[row[1].toLowerCase()] = true;
                    } else if (row[0] === "M" && row.length === 5 && /^m[0-9]+$/.test(row[1]) && !modules.hasOwnProperty(row[1])) {
                        modules[row[1]] = { offset: Number(row[2]), length: Number(row[3]), checksum: row[4], users: 0 };
                        moduleCount += 1;
                    } else { throw new Error("Invalid/duplicate bundle branch or module: " + row[1]); }
                    end = Number(row[2]) + Number(row[3]) + 1;
                }
                if (names.length !== Number(fields[6])) { throw new Error("Missing bundle index rows"); }
                if (this.payloadOffset + end + 3 !== file.length) { throw new Error("Bundle payload size mismatch"); }
                for (i = 0; i < names.length; i += 1) {
                    row = entries[names[i]];
                    for (j = 0; j < row.dependencies.length; j += 1) {
                        if (!entries.hasOwnProperty(row.dependencies[j]) && row.dependencies[j] !== "AECT Engine.jsx") {
                            throw new Error("Missing dependency " + row.dependencies[j] + " for " + names[i]);
                        }
                    }
                }
                this.entries = entries; this.names = names; this.modules = modules; this.moduleCount = moduleCount;
                this.moduleCache = {}; this.cacheOrder = []; this.cacheSize = 0; this.sharedModules = 0;
                this.revision = fields[1];
                this.fileStamp = stamp; this.checked = 0; this.errors = []; this.error = "";
                this.lastCycle = new Date().getTime();
                this.loadInstallation();
            } finally { file.close(); }
            return true;
        } catch (error) {
            this.error = String(error);
            throw error;
        }
    };
    Bundle.prototype.has = function (name) { return validName(name) && this.entries.hasOwnProperty(name); };
    Bundle.prototype.recordValidation = function (name, error) {
        var entry = this.entries[name], prefix = name + ": ", errors = [], i;
        if (!entry) { return; }
        entry.state = error ? "error" : "ok";
        entry.error = error ? String(error) : "";
        for (i = 0; i < this.errors.length; i += 1) {
            if (this.errors[i].indexOf(prefix) !== 0) { errors.push(this.errors[i]); }
        }
        if (error) { errors.push(prefix + entry.error); }
        this.errors = errors;
    };
    Bundle.prototype.loadInstallation = function () {
        var file = new File(ROOT + "/.ae-codex/bundle/installed-validation.tsv"), fields, text;
        this.installation = { state: "missing", message: "Run the panel installer/update once to validate scripts" };
        if (!file.exists) { return false; }
        try {
            if (file.length > 4096) { throw new Error("Installation certificate is too large"); }
            file.encoding = "UTF-8";
            if (!file.open("r")) { throw new Error("Cannot read installation certificate"); }
            try { text = file.read().replace(/^\uFEFF/, "").replace(/\r?\n$/, ""); } finally { file.close(); }
            fields = text.split("\t");
            if (fields.length !== 6 || fields[0] !== "aect-install/v1" ||
                    !/^[a-f0-9]{64}$/.test(fields[1]) || !/^[a-f0-9]{64}$/.test(fields[5]) ||
                    !/^\d+$/.test(fields[2]) || !/^\d+$/.test(fields[3]) || !/^\d+$/.test(fields[4])) {
                throw new Error("Invalid installation certificate");
            }
            if (fields[1] !== this.revision || Number(fields[2]) !== (new File(PATH)).length ||
                    Number(fields[3]) !== this.names.length || Number(fields[4]) !== this.moduleCount) {
                this.installation = { state: "stale", message: "Bundle updated; validate once with the panel updater" };
                return false;
            }
            this.installation = { state: "verified", message: "Verified at installation", sha256: fields[5] };
            return true;
        } catch (error) {
            this.installation = { state: "error", message: String(error) };
            return false;
        }
    };
    Bundle.prototype.readRecord = function (entry, name, isModule) {
        var file = new File(PATH), record;
        file.encoding = "BINARY";
        if (!file.open("r")) { throw new Error("Cannot read bundle: " + file.error); }
        try { record = readRange(file, this.payloadOffset + entry.offset, entry.length); }
        finally { file.close(); }
        if (checksum(record) !== entry.checksum) { throw new Error("Branch checksum mismatch: " + name); }
        return isModule ? decodeModule(record) : decodeURIComponent(record);
    };
    Bundle.prototype.recipe = function (name) {
        if (!this.has(name)) { throw new Error("Bundle branch missing: " + name); }
        return this.readRecord(this.entries[name], name);
    };
    Bundle.prototype.moduleSource = function (name) {
        var text, oldest;
        if (!this.modules.hasOwnProperty(name)) { throw new Error("Bundle module missing: " + name); }
        if (this.moduleCache.hasOwnProperty(name)) { return this.moduleCache[name]; }
        text = this.readRecord(this.modules[name], name, true);
        // Bound decoded-source memory independently of how many branches exist.
        if (text.length <= 131072) {
            while (this.cacheSize + text.length > 131072 && this.cacheOrder.length) {
                oldest = this.cacheOrder.shift(); this.cacheSize -= this.moduleCache[oldest].length;
                delete this.moduleCache[oldest];
            }
            this.moduleCache[name] = text; this.cacheOrder.push(name); this.cacheSize += text.length;
        }
        return text;
    };
    Bundle.prototype.source = function (name) {
        var recipe = this.recipe(name), parts = recipe ? recipe.split("|") : [], out = [], seen = {}, i, slice, text, module;
        for (i = 0; i < parts.length; i += 1) {
            slice = parts[i].split(":");
            if (slice.length !== 3 || !/^m[0-9]+$/.test(slice[0]) || !/^\d+$/.test(slice[1]) || !/^\d+$/.test(slice[2])) {
                throw new Error("Invalid module slice: " + name);
            }
            module = this.modules[slice[0]];
            text = this.moduleSource(slice[0]);
            if (Number(slice[1]) + Number(slice[2]) > text.length) { throw new Error("Invalid module slice: " + name); }
            out.push(text.substr(Number(slice[1]), Number(slice[2])));
            if (!seen.hasOwnProperty(slice[0])) {
                if (!module.branches) { module.branches = {}; }
                if (!module.branches.hasOwnProperty(name)) {
                    module.branches[name] = true; module.users += 1;
                    if (module.users === 2) { this.sharedModules += 1; }
                }
                seen[slice[0]] = true;
            }
        }
        text = out.join("");
        if (checksum(encodeURIComponent(text)) !== this.entries[name].sourceChecksum) { throw new Error("Branch source checksum mismatch: " + name); }
        return text;
    };
    Bundle.prototype.prepare = function (source) {
        return source.replace(/^\uFEFF/, "").replace(/^#target[^\r\n]*/gm, "").replace(/\$\.evalFile\s*\(/g,
            "$.global.__aectBundleV1.evalFile(");
    };
    Bundle.prototype.run = function (name) {
        var code;
        this.refresh(false);
        if (this.error) { throw new Error(this.error); }
        if (this.depth >= 32) { throw new Error("Bundle dependency recursion limit"); }
        try {
            code = this.prepare(this.source(name));
            this.recordValidation(name, null);
        } catch (validationError) {
            this.recordValidation(name, validationError);
            throw validationError;
        }
        this.depth += 1;
        try {
            // Only reviewed bundle code is evaluated; request data never becomes code.
            return (function (source) { return eval(source); }(code));
        } finally { this.depth -= 1; }
    };
    Bundle.prototype.evalFile = function (file) {
        var path = String(file.fsName || file).replace(/\\/g, "/"), prefix = (ROOT + "/jsx/").toLowerCase(), name;
        if (path.toLowerCase().indexOf(prefix) === 0) {
            name = path.substring(prefix.length);
            if (name !== "AECT Engine.jsx") {
                if (!validName(name)) { throw new Error("Invalid bundle branch path"); }
                return this.run(name);
            }
        }
        return nativeEvalFile(file);
    };
    Bundle.prototype.tick = function () {
        var now = new Date().getTime(), started = now, count = 0, name, entry;
        try {
            if (now - this.lastPoll >= 2000) { this.refresh(false); }
            if (this.error) { return; }
            // Explicit diagnostic only. The panel never schedules full-script scans.
            while (this.checked < this.names.length && count < 8) {
                name = this.names[this.checked]; entry = this.entries[name];
                try {
                    // Parse without running any project edits, imports, saves or renders.
                    new Function(this.prepare(this.source(name)));
                    this.recordValidation(name, null);
                } catch (error) {
                    this.recordValidation(name, error);
                }
                this.checked += 1; count += 1;
                if (new Date().getTime() - started >= 8) { break; }
            }
        } catch (error) { this.error = String(error); }
    };
    Bundle.prototype.describe = function () {
        if (this.error) { return "Scripts ERROR: " + this.error; }
        if (this.errors.length) { return "Scripts ERROR: " + this.errors.length + " branch(es) - " + this.errors[0]; }
        return "Archive: " + this.names.length + " historical scripts | " +
            (this.installation.state === "verified" ? "verified at installation" : this.installation.message) +
            " | on demand";
    };
    Bundle.prototype.status = function () {
        return { revision: this.revision, total: this.names.length, checked: this.checked, modules: this.moduleCount,
            sharedModules: this.sharedModules, cachedSourceCharacters: this.cacheSize,
            validationMode: "installation-only", installationState: this.installation.state,
            errors: this.errors.length + (this.error ? 1 : 0), state: this.error || this.errors.length ? "error" :
                (this.installation.state === "verified" || this.checked === this.names.length ? "ready" : "unverified") };
    };
    $.global.__aectBundleV1 = new Bundle();
}());

/* Reusable ES3 tools. Requests are JSON data, never evaluated as source code. */
(function () {
    var VERSION = "1.0.0", SCHEMA = "aect-functions/v1";
    var own = Object.prototype.hasOwnProperty;
    var MAX_TEXT = 1048576, MAX_DEPTH = 32, MAX_NODES = 50000;
    var definitions = {}, order = [];
    function has(object, key) { return own.call(object, key); }
    function fail(message) { throw new Error(message); }
    function forbidden(key) { return key === "__proto__" || key === "prototype" || key === "constructor"; }
    function array(value) { return Object.prototype.toString.call(value) === "[object Array]"; }
    function object(value) { return value !== null && typeof value === "object" && !array(value); }
    function finite(value) { return typeof value === "number" && isFinite(value); }
    function integer(value) { return finite(value) && Math.floor(value) === value; }
    function keys(value) { var out = [], key; for (key in value) { if (has(value, key)) { out.push(key); } } return out; }
    function exact(value, allowed, path) {
        var i, names;
        if (!object(value)) { fail(path + " must be an object"); }
        names = keys(value);
        for (i = 0; i < names.length; i += 1) {
            if (forbidden(names[i]) || ("|" + allowed + "|").indexOf("|" + names[i] + "|") < 0) { fail(path + ": unsupported field " + names[i]); }
        }
    }
    function text(value, path, maximum, empty) {
        if (typeof value !== "string" || (!empty && !value.length) || value.length > (maximum || 1024)) { fail(path + " must be a " + (empty ? "" : "nonempty ") + "string of at most " + (maximum || 1024) + " characters"); }
    }
    function number(value, path, minimum, maximum) {
        if (!finite(value) || (typeof minimum === "number" && value < minimum) || (typeof maximum === "number" && value > maximum)) { fail(path + " must be a finite number" + (typeof minimum === "number" ? " >= " + minimum : "") + (typeof maximum === "number" ? " <= " + maximum : "")); }
    }
    function whole(value, path, minimum, maximum) { number(value, path, minimum, maximum); if (!integer(value)) { fail(path + " must be an integer"); } }
    function boolValue(value, path) { if (typeof value !== "boolean") { fail(path + " must be boolean"); } }
    function vector(value, path, minimumLength, maximumLength, minimum, maximum) {
        var i;
        if (!array(value) || value.length < minimumLength || value.length > maximumLength) { fail(path + " has invalid vector dimensions"); }
        for (i = 0; i < value.length; i += 1) { number(value[i], path + "[" + i + "]", minimum, maximum); }
    }
    function optional(args, name, check) { if (has(args, name)) { check(args[name], "args." + name); } }
    function valueData(value, path) {
        var i;
        if (typeof value === "string") { text(value, path, 262144, true); }
        else if (typeof value === "boolean") { return; }
        else if (finite(value)) { return; }
        else if (array(value) && value.length <= 16) { for (i = 0; i < value.length; i += 1) { number(value[i], path + "[" + i + "]"); } }
        else { fail(path + " must be a number, string, boolean or numeric vector"); }
    }

    function parse(input) {
        var cursor = 0, nodes = 0, length;
        if (typeof input !== "string" || input.length > MAX_TEXT) { fail("Request text must be at most " + MAX_TEXT + " characters"); }
        length = input.length;
        function whitespace() { while (cursor < length && /[\x20\t\r\n]/.test(input.charAt(cursor))) { cursor += 1; } }
        function string() {
            var out = [], character, code;
            cursor += 1;
            while (cursor < length) {
                character = input.charAt(cursor++);
                if (character === '"') { return out.join(""); }
                if (character === "\\") {
                    character = input.charAt(cursor++);
                    if (character === '"' || character === "/" || character === "\\") { out.push(character); }
                    else if (character === "b") { out.push("\b"); }
                    else if (character === "f") { out.push("\f"); }
                    else if (character === "n") { out.push("\n"); }
                    else if (character === "r") { out.push("\r"); }
                    else if (character === "t") { out.push("\t"); }
                    else if (character === "u") {
                        code = input.substr(cursor, 4);
                        if (!/^[a-fA-F0-9]{4}$/.test(code)) { fail("Invalid JSON Unicode escape at " + cursor); }
                        out.push(String.fromCharCode(parseInt(code, 16))); cursor += 4;
                    } else { fail("Invalid JSON escape at " + cursor); }
                } else {
                    if (character.charCodeAt(0) < 32) { fail("Invalid JSON string character at " + cursor); }
                    out.push(character);
                }
            }
            fail("Unterminated JSON string");
        }
        function read(depth) {
            var result, seen, key, character, match;
            nodes += 1;
            if (depth > MAX_DEPTH || nodes > MAX_NODES) { fail("JSON complexity limit exceeded"); }
            whitespace(); character = input.charAt(cursor);
            if (character === '"') { return string(); }
            if (character === "{") {
                result = {}; seen = {}; cursor += 1; whitespace();
                if (input.charAt(cursor) === "}") { cursor += 1; return result; }
                while (cursor < length) {
                    whitespace(); if (input.charAt(cursor) !== '"') { fail("Expected JSON object key at " + cursor); }
                    key = string();
                    if (forbidden(key) || has(seen, key)) { fail("Forbidden or duplicate JSON key: " + key); }
                    seen[key] = true; whitespace();
                    if (input.charAt(cursor++) !== ":") { fail("Expected JSON colon at " + cursor); }
                    result[key] = read(depth + 1); whitespace(); character = input.charAt(cursor++);
                    if (character === "}") { return result; }
                    if (character !== ",") { fail("Expected JSON comma at " + cursor); }
                }
                fail("Unterminated JSON object");
            }
            if (character === "[") {
                result = []; cursor += 1; whitespace();
                if (input.charAt(cursor) === "]") { cursor += 1; return result; }
                while (cursor < length) {
                    result.push(read(depth + 1)); whitespace(); character = input.charAt(cursor++);
                    if (character === "]") { return result; }
                    if (character !== ",") { fail("Expected JSON array comma at " + cursor); }
                }
                fail("Unterminated JSON array");
            }
            if (input.substr(cursor, 4) === "true") { cursor += 4; return true; }
            if (input.substr(cursor, 5) === "false") { cursor += 5; return false; }
            if (input.substr(cursor, 4) === "null") { cursor += 4; return null; }
            match = /^-?(?:0|[1-9][0-9]*)(?:\.[0-9]+)?(?:[eE][+-]?[0-9]+)?/.exec(input.substring(cursor));
            if (match) {
                cursor += match[0].length; result = Number(match[0]);
                if (!isFinite(result)) { fail("JSON number is not finite"); }
                return result;
            }
            fail("Invalid JSON value at " + cursor);
        }
        var result = read(0);
        whitespace(); if (cursor !== length) { fail("Unexpected JSON content at " + cursor); }
        return result;
    }
    function stringify(value) {
        var nodes = 0, stack = [];
        function quote(input) {
            return '"' + input.replace(/["\\\x00-\x1f\u2028\u2029]/g, function (character) {
                var code = character.charCodeAt(0).toString(16);
                if (character === '"') { return '\\"'; }
                if (character === "\\") { return "\\\\"; }
                return "\\u" + ("0000" + code).slice(-4);
            }) + '"';
        }
        function write(input, depth) {
            var i, names, out = [], result;
            nodes += 1;
            if (depth > MAX_DEPTH || nodes > MAX_NODES) { fail("JSON result complexity limit exceeded"); }
            if (input === null) { return "null"; }
            if (typeof input === "string") { return quote(input); }
            if (typeof input === "boolean") { return input ? "true" : "false"; }
            if (typeof input === "number") { if (!isFinite(input)) { fail("Cannot serialize a nonfinite number"); } return String(input); }
            if (typeof input !== "object") { fail("Cannot serialize a non-data value"); }
            for (i = 0; i < stack.length; i += 1) { if (stack[i] === input) { fail("Cannot serialize a circular value"); } }
            stack.push(input);
            if (array(input)) {
                for (i = 0; i < input.length; i += 1) { out.push(write(input[i], depth + 1)); }
                result = "[" + out.join(",") + "]";
            } else {
                names = keys(input);
                for (i = 0; i < names.length; i += 1) {
                    if (forbidden(names[i])) { fail("Cannot serialize prototype key: " + names[i]); }
                    out.push(quote(names[i]) + ":" + write(input[names[i]], depth + 1));
                }
                result = "{" + out.join(",") + "}";
            }
            stack.pop(); return result;
        }
        return write(value, 0);
    }
    function selector(value, path, kind, refs) {
        var names;
        exact(value, kind === "comp" || kind === "item" ? "id|name|ref" : "index|name|ref", path);
        names = keys(value);
        if (names.length !== 1) { fail(path + " must select by exactly one field"); }
        if (has(value, "name")) { text(value.name, path + ".name", 1024); }
        if (has(value, "id")) { whole(value.id, path + ".id", 1); }
        if (has(value, "index")) { whole(value.index, path + ".index", 1); }
        if (has(value, "ref")) {
            text(value.ref, path + ".ref", 64);
            if (!has(refs, value.ref) || (refs[value.ref] !== kind && !(kind === "item" && refs[value.ref] === "comp"))) { fail(path + ": ref must name an earlier " + kind + " result: " + value.ref); }
        }
    }
    function selectors(args, refs, needsLayer) {
        if (has(args, "comp")) { selector(args.comp, "args.comp", "comp", refs); }
        if (needsLayer) { selector(args.layer, "args.layer", "layer", refs); }
    }
    function propertyPath(value, path) {
        var i;
        if (!array(value) || !value.length || value.length > 32) { fail(path + " must contain 1 to 32 property names/indices"); }
        for (i = 0; i < value.length; i += 1) {
            if (typeof value[i] === "string") { text(value[i], path + "[" + i + "]", 1024); }
            else { whole(value[i], path + "[" + i + "]", 1); }
        }
    }
    function register(name, description, mutates, fields, validateArgs, execute, resultKind, options) {
        if (has(definitions, name)) { fail("Duplicate installed function: " + name); }
        definitions[name] = { name: name, description: description, mutates: mutates, args: fields, check: validateArgs, execute: execute, resultKind: resultKind || "", options: options || {} };
        order.push(name);
    }
    function project() { if (typeof app === "undefined" || !app.project) { fail("After Effects has no open project"); } return app.project; }
    function isComp(item) { return item && typeof CompItem !== "undefined" && item instanceof CompItem; }
    function resolveComp(args, refs) {
        var p = project(), selection = args.comp, item, found = null, i;
        if (!selection) { if (!isComp(p.activeItem)) { fail("The active item must be a composition, or supply args.comp"); } return p.activeItem; }
        if (has(selection, "ref")) { item = refs[selection.ref]; if (!isComp(item)) { fail("Composition reference is unavailable: " + selection.ref); } return item; }
        for (i = 1; i <= p.numItems; i += 1) {
            item = p.item(i);
            if (isComp(item) && (has(selection, "id") ? item.id === selection.id : item.name === selection.name)) {
                if (found) { fail("Composition name is ambiguous; use its id: " + selection.name); } found = item;
            }
        }
        if (!found) { fail("Composition not found: " + stringify(selection)); }
        return found;
    }
    function resolveLayer(comp, selection, refs) {
        var item, found = null, i;
        if (has(selection, "ref")) {
            item = refs[selection.ref];
            if (!item || item.containingComp !== comp) { fail("Layer reference does not belong to the selected composition: " + selection.ref); }
            return item;
        }
        if (has(selection, "index")) {
            if (selection.index > comp.numLayers) { fail("Layer index does not exist: " + selection.index); }
            item = comp.layer(selection.index); if (!item) { fail("Layer does not exist"); } return item;
        }
        for (i = 1; i <= comp.numLayers; i += 1) {
            item = comp.layer(i);
            if (item && item.name === selection.name) { if (found) { fail("Layer name is ambiguous; use its index: " + selection.name); } found = item; }
        }
        if (!found) { fail("Layer not found: " + selection.name); }
        return found;
    }
    function resolveProperty(layer, path) {
        var current = layer, i;
        for (i = 0; i < path.length; i += 1) {
            if (!current || typeof current.property !== "function") { fail("Property path cannot be traversed at " + path[i]); }
            current = current.property(path[i]);
            if (!current) { fail("Property not found: " + path.slice(0, i + 1).join(" / ")); }
        }
        return current;
    }
    function compSummary(comp) {
        var result = { id: comp.id, name: comp.name, width: comp.width, height: comp.height, pixelAspect: comp.pixelAspect, duration: comp.duration, frameRate: comp.frameRate, numLayers: comp.numLayers, time: comp.time };
        if (array(comp.bgColor)) { result.bgColor = dataValue(comp.bgColor); }
        return result;
    }
    function layerSummary(layer) {
        var result = { index: layer.index, name: layer.name, compId: layer.containingComp.id, enabled: !!layer.enabled, locked: !!layer.locked, startTime: layer.startTime, inPoint: layer.inPoint, outPoint: layer.outPoint, parent: layer.parent ? layer.parent.index : null };
        var flags = ["solo", "shy", "adjustmentLayer", "nullLayer", "guideLayer", "hasVideo", "hasAudio"], i;
        if (typeof layer.id === "number") { result.id = layer.id; }
        if (typeof layer.threeDLayer === "boolean") { result.threeDLayer = layer.threeDLayer; }
        for (i = 0; i < flags.length; i += 1) { if (typeof layer[flags[i]] === "boolean") { result[flags[i]] = layer[flags[i]]; } }
        if ((typeof TextLayer !== "undefined" && layer instanceof TextLayer) || layer.matchName === "ADBE Text Layer") { result.type = "text"; }
        else if ((typeof ShapeLayer !== "undefined" && layer instanceof ShapeLayer) || layer.matchName === "ADBE Vector Layer") { result.type = "shape"; }
        else if ((typeof CameraLayer !== "undefined" && layer instanceof CameraLayer) || layer.matchName === "ADBE Camera Layer") { result.type = "camera"; }
        else if ((typeof LightLayer !== "undefined" && layer instanceof LightLayer) || layer.matchName === "ADBE Light Layer") { result.type = "light"; }
        else if (layer.nullLayer) { result.type = "null"; }
        else if (layer.adjustmentLayer) { result.type = "adjustment"; }
        else { result.type = "av"; }
        try { if (typeof layer.blendingMode !== "undefined") { result.blendingMode = String(layer.blendingMode); } } catch (blendReadError) {}
        if (layer.source) { result.source = { id: layer.source.id, name: layer.source.name }; }
        return result;
    }
    function dataValue(value, depth) {
        var i, out;
        depth = depth || 0;
        if (depth > 16) { fail("Property value nesting limit exceeded"); }
        if (value === null || typeof value === "string" || typeof value === "boolean" || finite(value)) { return value; }
        if (array(value)) { out = []; for (i = 0; i < value.length; i += 1) { out.push(dataValue(value[i], depth + 1)); } return out; }
        if (value && typeof value.text === "string") {
            out = { text: value.text };
            if (typeof value.font === "string") { out.font = value.font; }
            if (finite(value.fontSize)) { out.fontSize = value.fontSize; }
            return out;
        }
        if (value && value.vertices && value.inTangents && value.outTangents) { return { vertices: dataValue(value.vertices, depth + 1), inTangents: dataValue(value.inTangents, depth + 1), outTangents: dataValue(value.outTangents, depth + 1), closed: !!value.closed }; }
        return { unsupported: true, description: String(value).substr(0, 1024) };
    }
    function writeValue(property, value, time) {
        if (!property || typeof property.setValue !== "function") { fail("Selected property cannot be assigned a value"); }
        if (typeof value === "string" && property.value && typeof property.value.text === "string") {
            var document = property.value; document.text = value; value = document;
        }
        if (typeof time === "number") {
            if (!property.canVaryOverTime || typeof property.setValueAtTime !== "function") { fail("Selected property cannot be keyframed"); }
            property.setValueAtTime(time, value);
        } else {
            if (property.numKeys > 0) { fail("Property has keyframes; supply args.time or use property.keyframes"); }
            property.setValue(value);
        }
    }
    function resolved(args, refs, entry, needsLayer) {
        var comp = entry && entry.comp ? entry.comp : resolveComp(args, refs);
        return { comp: comp, layer: needsLayer ? (entry && entry.layer ? entry.layer : resolveLayer(comp, args.layer, refs)) : null };
    }
    function checkLayerUpdate(layer, args) {
        var names, i, name, property, dimensions, threeD = has(args, "threeDLayer") ? args.threeDLayer : !!layer.threeDLayer;
        if (layer.locked && args.locked !== false) { fail("Layer is locked; explicitly set locked:false before editing it"); }
        if (!args.transform) { return; }
        names = keys(args.transform);
        for (i = 0; i < names.length; i += 1) {
            name = names[i];
            if (name === "xRotation" || name === "yRotation") { if (!threeD) { fail(name + " requires a 3D layer"); } if (args.threeDLayer === true) { continue; } }
            property = resolveProperty(layer, ["ADBE Transform Group", transformNames[name]]);
            if (property.numKeys > 0) { fail("Transform has keyframes; use property.set with time or property.keyframes"); }
            if (name === "position" || name === "anchorPoint" || name === "scale") {
                dimensions = has(args, "threeDLayer") ? (threeD ? 3 : 2) : (array(property.value) ? property.value.length : 0);
                if (dimensions && args.transform[name].length !== dimensions) { fail("Transform " + name + " requires " + dimensions + " dimensions for this layer"); }
            }
        }
    }
    function list(includeLegacy) {
        var out = [], i, definition, bundle = $.global.__aectBundleV1, names;
        for (i = 0; i < order.length; i += 1) {
            definition = definitions[order[i]];
            if (definition.name === "team.script.run" && includeLegacy !== true) { continue; }
            out.push({ name: definition.name, description: definition.description, mutates: definition.mutates, args: definition.args, inputSchema: inputSchema(definition), resultRef: definition.resultKind || null, internal: definition.name === "team.script.run", exclusive: !!definition.options.exclusive });
        }
        if (includeLegacy === true && bundle && bundle.names) {
            names = bundle.names;
            for (i = 0; i < names.length; i += 1) { out.push({ name: "team.script.run", branch: names[i], description: "Preserved installed branch; requires its original project and authorization prerequisites", mutates: true, legacy: true, args: { branch: names[i] }, inputSchema: { type: "object", properties: { branch: { type: "string", "enum": [names[i]] } }, required: ["branch"], additionalProperties: false } }); }
        }
        return out;
    }
    function selectorSchema(kind) {
        var byId = kind === "comp" || kind === "item";
        var options = [{ type: "object", properties: { name: { type: "string", minLength: 1, maxLength: 1024 } }, required: ["name"], additionalProperties: false }, { type: "object", properties: { ref: { type: "string", minLength: 1, maxLength: 64 } }, required: ["ref"], additionalProperties: false }], numeric = { type: "object", properties: {}, required: [byId ? "id" : "index"], additionalProperties: false };
        numeric.properties[byId ? "id" : "index"] = { type: "integer", minimum: 1 }; options.push(numeric); return { oneOf: options };
    }
    function inputSchema(definition) {
        if (definition.options.nativeInputSchema) { return parse(stringify(definition.options.nativeInputSchema)); }
        var requiredFields = { "team.comp.rebuildMedia": "name", "team.comp.create": "name", "team.comp.seek": "time", "team.layer.inspect": "layer", "team.layer.text.create": "text", "team.layer.solid.create": "color", "team.layer.duplicate": "layer", "team.layer.update": "layer", "team.layer.parent": "layer|parent", "team.property.list": "layer", "team.property.get": "layer|path", "team.property.set": "layer|path|value", "team.property.keyframes": "layer|path|keys", "team.property.expression": "layer|path|expression", "team.effect.add": "layer|matchName", "team.layer.shape.create": "shape", "team.script.run": "branch" };
        var result = { type: "object", properties: {}, required: requiredFields[definition.name] ? requiredFields[definition.name].split("|") : [], additionalProperties: false }, names = keys(definition.args), i, name, schema;
        var numeric = "|width|height|pixelAspect|duration|frameRate|sampleRate|resumeCompId|workAreaStart|workAreaDuration|displayStartTime|fontSize|startTime|inPoint|outPoint|label|time|roundness|strokeWidth|maxItems|maxLayers|maxProperties|";
        var bools = "|includeLegacy|includeLayers|applyFill|enabled|shy|locked|solo|threeDLayer|guideLayer|adjustmentLayer|preserveTransforms|closed|bold|italic|moveAttributes|replace|sequence|forceAlphabetical|overwrite|";
        var vectors = "|bgColor|color|fillColor|strokeColor|position|size|";
        function genericValue() { return { anyOf: [{ type: "number" }, { type: "string", maxLength: 262144 }, { type: "boolean" }, { type: "array", items: { type: "number" }, maxItems: 16 }] }; }
        for (i = 0; i < names.length; i += 1) {
            name = names[i]; schema = { type: "string", maxLength: 1024 };
            if (numeric.indexOf("|" + name + "|") >= 0) { schema = { type: "number" }; }
            if (bools.indexOf("|" + name + "|") >= 0) { schema = { type: "boolean" }; }
            if (vectors.indexOf("|" + name + "|") >= 0) { schema = { type: "array", items: { type: "number" }, minItems: name === "position" || name === "size" ? 2 : 3, maxItems: name === "position" || name === "size" ? 2 : 3 }; }
            if (name === "comp" || name === "layer") { schema = selectorSchema(name === "comp" ? "comp" : "layer"); }
            if (name === "parent") { schema = { anyOf: [selectorSchema("layer"), { type: "null" }] }; }
            if (name === "value") { schema = genericValue(); }
            if (name === "path") { schema = { type: "array", minItems: 1, maxItems: 32, items: { anyOf: [{ type: "string", minLength: 1, maxLength: 1024 }, { type: "integer", minimum: 1 }] } }; }
            if (name === "properties") { schema = { type: "array", maxItems: 100, items: { type: "array", minItems: 1, maxItems: 32, items: { anyOf: [{ type: "string", minLength: 1 }, { type: "integer", minimum: 1 }] } } }; }
            if (name === "vertices" || name === "inTangents" || name === "outTangents") { schema = { type: "array", minItems: 2, maxItems: 5000, items: { type: "array", minItems: 2, maxItems: 2, items: { type: "number" } } }; }
            if (name === "keys") { schema = definition.name === "team.property.get" ? { type: "boolean" } : { type: "array", minItems: 1, maxItems: 5000, items: { type: "object", properties: { time: { type: "number" }, value: genericValue(), interpolation: { type: "string", "enum": ["linear", "bezier", "hold"] } }, required: ["time", "value"], additionalProperties: false } }; }
            if (name === "transform") { schema = { type: "object", properties: { position: { type: "array", minItems: 2, maxItems: 3, items: { type: "number" } }, anchorPoint: { type: "array", minItems: 2, maxItems: 3, items: { type: "number" } }, scale: { type: "array", minItems: 2, maxItems: 3, items: { type: "number" } }, rotation: { type: "number" }, xRotation: { type: "number" }, yRotation: { type: "number" }, zRotation: { type: "number" }, opacity: { type: "number", minimum: 0, maximum: 100 } }, additionalProperties: false }; }
            if (name === "shape") { schema = { type: "string", "enum": ["rect", "ellipse", "path"] }; }
            if (name === "justification") { schema = { type: "string", "enum": ["left", "center", "right"] }; }
            if (name === "expression" || name === "text") { schema.maxLength = name === "expression" ? 65536 : 262144; }
            if (name === "width" || name === "height") { schema = { type: "integer", minimum: 4, maximum: 30000 }; }
            if (name === "maxItems" || name === "maxLayers" || name === "maxProperties") { schema = { type: "integer", minimum: 1, maximum: 5000 }; }
            if (name === "label") { schema = { type: "integer", minimum: 0, maximum: 16 }; }
            if (name === "resumeCompId") { schema = { type: "integer", minimum: 1 }; }
            if (name === "item") { schema = selectorSchema("item"); }
            if (name === "layers") { schema = { type: "array", minItems: definition.name === "team.layer.select" ? 0 : 1, maxItems: 1000, items: selectorSchema("layer") }; }
            if (name === "effect") { schema = { oneOf: [{ type: "object", properties: { index: { type: "integer", minimum: 1 } }, required: ["index"], additionalProperties: false }, { type: "object", properties: { name: { type: "string", minLength: 1, maxLength: 1024 } }, required: ["name"], additionalProperties: false }] }; }
            if (name === "path" && (definition.name === "team.media.import" || definition.name === "team.project.save")) { schema = { type: "string", minLength: 1, maxLength: 4096 }; }
            if (name === "outputPath") { schema = { type: "string", minLength: 1, maxLength: 4096 }; }
            if (name === "zoom" || name === "intensity" || name === "points" || name === "outerRadius" || name === "innerRadius" || name === "shapeRotation") { schema = { type: "number" }; }
            if (name === "numFrames") { schema = { type: "integer", minimum: 1, maximum: 3 }; }
            if (name === "times") { schema = { type: "array", minItems: 1, maxItems: 3, items: { type: "number", minimum: 0 } }; }
            if (name === "type" && definition.name === "team.project.search") { schema = { type: "string", "enum": ["all", "composition", "footage", "solid", "folder"] }; }
            if (name === "type" && definition.name === "team.layer.camera.create") { schema = { type: "string", "enum": ["one-node", "two-node"] }; }
            if (name === "type" && definition.name === "team.layer.light.create") { schema = { type: "string", "enum": ["point", "spot", "parallel", "ambient"] }; }
            if (name === "mode" && definition.name === "team.layer.blendMode") { schema = { type: "string", "enum": ["Normal", "Add", "Multiply", "Screen", "Overlay", "SoftLight", "HardLight", "ColorDodge", "ColorBurn", "Difference", "Exclusion", "Hue", "Saturation", "Color", "Luminosity", "Darken", "Lighten"] }; }
            if (name === "shape") { schema = { type: "string", "enum": ["rect", "ellipse", "path", "star", "polygon"] }; }
            schema.description = definition.args[name]; result.properties[name] = schema;
        }
        var extraRequired = { "team.comp.precompose": ["layers", "name"], "team.layer.remove": ["layer"], "team.layer.select": ["layers"], "team.layer.blendMode": ["layer", "mode"], "team.project.search": ["query"], "team.media.import": ["path"], "team.layer.media.add": ["item"], "team.render.queue.add": ["outputPath"], "team.effect.inspect": ["layer"], "team.effect.remove": ["layer", "effect"] };
        if (has(extraRequired, definition.name)) { result.required = extraRequired[definition.name]; }
        if (definition.name === "team.property.keyframes") { result.properties.keys.items.properties.easing = { anyOf: [{ type: "string", "enum": ["ease", "ease-in", "ease-out", "ease-in-out"] }, { type: "object", properties: { inSpeed: { type: "number" }, outSpeed: { type: "number" }, inInfluence: { type: "number", minimum: 0.1, maximum: 100 }, outInfluence: { type: "number", minimum: 0.1, maximum: 100 } }, additionalProperties: false }] }; }
        return result;
    }

    register("team.system.info", "Read host version and connection context", false, {}, function () {}, function () {
        return { runtimeVersion: VERSION, host: "After Effects", version: String(app.version || ""), projectOpen: !!app.project, activeComp: app.project && isComp(app.project.activeItem) ? compSummary(app.project.activeItem) : null };
    });
    function memoryBytes() {
        if (typeof app === "undefined" || !app) { fail("After Effects memory information is unavailable"); }
        var value = app.memoryInUse;
        if (!finite(value) || value < 0) { fail("After Effects memoryInUse must report a nonnegative byte count"); }
        return value;
    }
    function memoryNativeMethod(type) { return type === "function" || type === "unknown"; }
    function memoryPreflight(a) {
        var operation = has(a, "operation") ? a.operation : "inspect", bytes = memoryBytes(), p, queue;
        if (operation !== "inspect") {
            p = app.project;
            if (p) {
                queue = p.renderQueue;
                if (!queue || typeof queue.rendering !== "boolean") { fail("Cannot verify the After Effects render queue is idle"); }
                if (queue.rendering) { fail("Memory configuration and cache release are unavailable while After Effects is rendering"); }
            }
            if (operation === "configure" && !memoryNativeMethod(typeof app.setMemoryUsageLimits)) { fail("After Effects setMemoryUsageLimits is unavailable"); }
            if (operation === "purgeImages" && (!memoryNativeMethod(typeof app.purge) || typeof PurgeTarget === "undefined" || typeof PurgeTarget.IMAGE_CACHES === "undefined" || PurgeTarget.IMAGE_CACHES === null)) { fail("After Effects IMAGE_CACHES purge is unavailable"); }
        }
        return bytes;
    }
    var memoryOperationSchema = { type: "string", "enum": ["inspect", "configure", "purgeImages"], "default": "inspect", description: "Inspect memory by default; configure application percentages or release only cached image data when explicitly requested" };
    var memoryPercentageSchema = { type: "number", minimum: 0, maximum: 100, description: "Native AE percentage; required only for configure, with no supported readback or hard byte-limit guarantee" };
    register("team.app.memory", "Inspect native AE memory use, configure its memory percentages, or release image cache without clearing Undo or disk cache; never changes project data", true, { operation: "optional inspect (default), configure or purgeImages", imageCachePercentage: "configure only: required finite percentage 0..100 for the image cache", maximumMemoryPercentage: "configure only: required finite percentage 0..100 for maximum usable memory; not a hard process byte cap" }, function (a) {
        var operation = has(a, "operation") ? a.operation : "inspect";
        if (operation !== "inspect" && operation !== "configure" && operation !== "purgeImages") { fail("args.operation must be inspect, configure or purgeImages"); }
        if (operation === "configure") {
            number(a.imageCachePercentage, "args.imageCachePercentage", 0, 100);
            number(a.maximumMemoryPercentage, "args.maximumMemoryPercentage", 0, 100);
        } else if (has(a, "imageCachePercentage") || has(a, "maximumMemoryPercentage")) { fail("Memory percentages are accepted only for args.operation configure"); }
    }, function (a) {
        var operation = has(a, "operation") ? a.operation : "inspect", before = memoryPreflight(a), result;
        if (operation === "configure") { app.setMemoryUsageLimits(a.imageCachePercentage, a.maximumMemoryPercentage); }
        else if (operation === "purgeImages") { app.purge(PurgeTarget.IMAGE_CACHES); }
        result = { operation: operation, beforeBytes: before, afterBytes: memoryBytes(), limitsReadbackAvailable: false, projectModified: false, preservesUndo: true, preservesDiskCache: true };
        if (operation === "configure") { result.requestedLimits = { imageCachePercentage: a.imageCachePercentage, maximumMemoryPercentage: a.maximumMemoryPercentage }; }
        if (operation === "purgeImages") { result.purgedTarget = "IMAGE_CACHES"; result.releasedBytes = Math.max(0, before - result.afterBytes); }
        return result;
    }, "", { undo: false, exclusive: true, nativeInputSchema: { type: "object", properties: { operation: memoryOperationSchema, imageCachePercentage: memoryPercentageSchema, maximumMemoryPercentage: memoryPercentageSchema }, required: [], additionalProperties: false, oneOf: [
        { type: "object", properties: { operation: { type: "string", "enum": ["inspect"] } }, additionalProperties: false },
        { type: "object", properties: { operation: { type: "string", "enum": ["configure"] }, imageCachePercentage: memoryPercentageSchema, maximumMemoryPercentage: memoryPercentageSchema }, required: ["operation", "imageCachePercentage", "maximumMemoryPercentage"], additionalProperties: false },
        { type: "object", properties: { operation: { type: "string", "enum": ["purgeImages"] } }, required: ["operation"], additionalProperties: false }
    ] } });
    register("team.tools.list", "List reusable installed tools; archived scripts require explicit includeLegacy:true", false, { includeLegacy: "optional boolean; default false, archive maintenance only" }, function (a) { optional(a, "includeLegacy", boolValue); }, function (a) { return list(a.includeLegacy); });
    register("team.project.inspect", "Read project items without changing the project", false, { maxItems: "optional integer 1..5000; default 100" }, function (a) { optional(a, "maxItems", function (v, p) { whole(v, p, 1, 5000); }); }, function (a) {
        var p = project(), out = [], limit = a.maxItems || 100, i, item, projectFile = p.file, summary, fields = ["width", "height", "duration", "frameRate", "numLayers", "numItems"], j, value, file, color;
        for (i = 1; i <= p.numItems && i <= limit; i += 1) {
            item = p.item(i);
            if (isComp(item)) { out.push({ type: "composition", item: compSummary(item) }); }
            else {
                summary = { type: "item", id: item.id, name: item.name, typeName: String(item.typeName || "") };
                for (j = 0; j < fields.length; j += 1) { try { value = item[fields[j]]; if (finite(value)) { summary[fields[j]] = value; } } catch (ignoreItemMetadata) {} }
                try { file = item.file; if (file) { summary.path = String(file.fsName || file.fullName); summary.file = summary.path; } } catch (ignoreItemFile) {}
                try {
                    if (typeof SolidSource !== "undefined" && item.mainSource instanceof SolidSource) {
                        summary.isSolid = true; color = item.mainSource.color;
                        if (array(color) && color.length === 3 && finite(color[0]) && finite(color[1]) && finite(color[2])) { summary.color = [color[0], color[1], color[2]]; }
                    }
                } catch (ignoreSolidMetadata) {}
                out.push(summary);
            }
        }
        return { name: projectFile ? String(projectFile.displayName || projectFile.name || "Untitled") : "Untitled",
            path: projectFile ? String(projectFile.fsName || projectFile.fullName) : null,
            bitsPerChannel: finite(p.bitsPerChannel) ? p.bitsPerChannel : null,
            saved: typeof p.dirty === "boolean" ? !p.dirty : null,
            numItems: p.numItems, items: out, truncated: p.numItems > limit, activeComp: isComp(p.activeItem) ? compSummary(p.activeItem) : null };
    });
    register("team.comp.inspect", "Read composition settings and layers", false, { comp: "optional comp selector", includeLayers: "optional boolean; default true", maxLayers: "optional integer 1..5000; default 200" }, function (a, refs) {
        selectors(a, refs, false); optional(a, "includeLayers", boolValue); optional(a, "maxLayers", function (v, p) { whole(v, p, 1, 5000); });
    }, function (a, refs, entry) {
        var comp = resolved(a, refs, entry, false).comp, result = compSummary(comp), i, limit = a.maxLayers || 200;
        if (a.includeLayers !== false) { result.layers = []; for (i = 1; i <= comp.numLayers && i <= limit; i += 1) { result.layers.push(layerSummary(comp.layer(i))); } result.truncated = comp.numLayers > limit; }
        return result;
    });
    function compSettings(a, refs, creating) {
        var fields = ["width", "height"], i;
        if (!creating) { selectors(a, refs, false); }
        if (creating || has(a, "name")) { text(a.name, "args.name", 1024); }
        for (i = 0; i < fields.length; i += 1) { if (has(a, fields[i])) { whole(a[fields[i]], "args." + fields[i], 4, 30000); } }
        optional(a, "pixelAspect", function (v, p) { number(v, p, 0.01, 100); });
        optional(a, "duration", function (v, p) { number(v, p, 0.001, 10800); });
        optional(a, "frameRate", function (v, p) { number(v, p, 1, 999); });
        optional(a, "bgColor", function (v, p) { vector(v, p, 3, 3, 0, 1); });
        optional(a, "workAreaStart", function (v, p) { number(v, p, 0, 10800); });
        optional(a, "workAreaDuration", function (v, p) { number(v, p, 0.001, 10800); });
        optional(a, "displayStartTime", function (v, p) { number(v, p, -10800, 86339); });
    }
    function assignComp(comp, a) {
        var names = ["name", "width", "height", "pixelAspect", "duration", "frameRate", "bgColor", "displayStartTime", "workAreaStart", "workAreaDuration"], i;
        for (i = 0; i < names.length; i += 1) { if (has(a, names[i])) { comp[names[i]] = a[names[i]]; } }
    }
    var compFields = { name: "composition name", width: "optional integer 4..30000; default 1920", height: "optional integer 4..30000; default 1080", pixelAspect: "optional number; default 1", duration: "optional seconds; default 10", frameRate: "optional frames/second; default 30", bgColor: "optional RGB [0..1,0..1,0..1]", workAreaStart: "optional seconds", workAreaDuration: "optional seconds", displayStartTime: "optional seconds" };
    register("team.comp.create", "Create a composition; optionally label it with step.as", true, compFields, function (a, refs) { compSettings(a, refs, true); }, function (a) {
        var comp = project().items.addComp(a.name, a.width || 1920, a.height || 1080, has(a, "pixelAspect") ? a.pixelAspect : 1, a.duration || 10, a.frameRate || 30);
        assignComp(comp, a); return { value: compSummary(comp), reference: comp };
    }, "comp");
    register("team.comp.update", "Update selected composition settings", true, { comp: "optional comp selector", name: "optional name", width: "optional integer 4..30000", height: "optional integer 4..30000", pixelAspect: "optional number", duration: "optional seconds", frameRate: "optional frames/second", bgColor: "optional RGB vector", workAreaStart: "optional seconds", workAreaDuration: "optional seconds", displayStartTime: "optional seconds" }, function (a, refs) { compSettings(a, refs, false); }, function (a, refs, entry) { var comp = resolved(a, refs, entry, false).comp; assignComp(comp, a); return compSummary(comp); });
    register("team.comp.activate", "Open selected composition in the viewer", true, { comp: "optional comp selector" }, function (a, refs) { selectors(a, refs, false); }, function (a, refs, entry) { var comp = resolved(a, refs, entry, false).comp; comp.openInViewer(); return compSummary(comp); });
    register("team.layer.inspect", "Read the selected layer and optional property paths", false, { comp: "optional comp selector", layer: "layer selector", properties: "optional list of property paths; max 100" }, function (a, refs) {
        var i; selectors(a, refs, true);
        if (has(a, "properties")) { if (!array(a.properties) || a.properties.length > 100) { fail("args.properties must contain at most 100 paths"); } for (i = 0; i < a.properties.length; i += 1) { propertyPath(a.properties[i], "args.properties[" + i + "]"); } }
    }, function (a, refs, entry) {
        var layer = resolved(a, refs, entry, true).layer, result = layerSummary(layer), i;
        if (a.properties) { result.properties = []; for (i = 0; i < a.properties.length; i += 1) { result.properties.push({ path: a.properties[i], value: dataValue(resolveProperty(layer, a.properties[i]).value) }); } }
        return result;
    });
    function createLayerCheck(a, refs) {
        selectors(a, refs, false); optional(a, "name", function (v, p) { text(v, p, 1024); }); optional(a, "duration", function (v, p) { number(v, p, 0.001, 10800); });
    }
    register("team.layer.text.create", "Create a text layer with optional text style", true, { comp: "optional comp selector", text: "text content", name: "optional layer name", font: "optional installed font PostScript name", fontSize: "optional positive number", fillColor: "optional RGB vector", applyFill: "optional boolean", justification: "optional left, center or right", bold: "optional faux bold", italic: "optional faux italic" }, function (a, refs) {
        selectors(a, refs, false); text(a.text, "args.text", 262144, true); optional(a, "name", function (v, p) { text(v, p, 1024); }); optional(a, "font", function (v, p) { text(v, p, 256); }); optional(a, "fontSize", function (v, p) { number(v, p, 0.1, 30000); }); optional(a, "fillColor", function (v, p) { vector(v, p, 3, 3, 0, 1); }); optional(a, "applyFill", boolValue);
        optional(a, "bold", boolValue); optional(a, "italic", boolValue);
        if (has(a, "justification") && a.justification !== "left" && a.justification !== "center" && a.justification !== "right") { fail("args.justification must be left, center or right"); }
    }, function (a, refs, entry) {
        var comp = resolved(a, refs, entry, false).comp, layer = comp.layers.addText(a.text), property = resolveProperty(layer, ["ADBE Text Properties", "ADBE Text Document"]), document = property.value;
        if (has(a, "name")) { layer.name = a.name; }
        if (has(a, "font")) { document.font = a.font; } if (has(a, "fontSize")) { document.fontSize = a.fontSize; }
        if (has(a, "bold")) { document.fauxBold = a.bold; } if (has(a, "italic")) { document.fauxItalic = a.italic; }
        if (has(a, "fillColor")) { document.fillColor = a.fillColor; document.applyFill = true; } if (has(a, "applyFill")) { document.applyFill = a.applyFill; }
        if (has(a, "justification")) { document.justification = a.justification === "left" ? ParagraphJustification.LEFT_JUSTIFY : (a.justification === "center" ? ParagraphJustification.CENTER_JUSTIFY : ParagraphJustification.RIGHT_JUSTIFY); }
        property.setValue(document); return { value: layerSummary(layer), reference: layer };
    }, "layer");
    register("team.layer.solid.create", "Create a solid in the selected composition", true, { comp: "optional comp selector", color: "RGB [0..1,0..1,0..1]", name: "optional layer name", width: "optional integer", height: "optional integer", pixelAspect: "optional number", duration: "optional seconds" }, function (a, refs) {
        createLayerCheck(a, refs); vector(a.color, "args.color", 3, 3, 0, 1); optional(a, "width", function (v, p) { whole(v, p, 4, 30000); }); optional(a, "height", function (v, p) { whole(v, p, 4, 30000); }); optional(a, "pixelAspect", function (v, p) { number(v, p, 0.01, 100); });
    }, function (a, refs, entry) { var comp = resolved(a, refs, entry, false).comp, layer = comp.layers.addSolid(a.color, a.name || "Solid", a.width || comp.width, a.height || comp.height, has(a, "pixelAspect") ? a.pixelAspect : comp.pixelAspect, a.duration || comp.duration); return { value: layerSummary(layer), reference: layer }; }, "layer");
    register("team.layer.null.create", "Create a null layer", true, { comp: "optional comp selector", name: "optional layer name", duration: "optional seconds" }, createLayerCheck, function (a, refs, entry) { var comp = resolved(a, refs, entry, false).comp, layer = comp.layers.addNull(a.duration || comp.duration); if (has(a, "name")) { layer.name = a.name; } return { value: layerSummary(layer), reference: layer }; }, "layer");
    register("team.layer.duplicate", "Duplicate the selected layer", true, { comp: "optional comp selector", layer: "layer selector", name: "optional new name" }, function (a, refs) { selectors(a, refs, true); optional(a, "name", function (v, p) { text(v, p, 1024); }); }, function (a, refs, entry) { var layer = resolved(a, refs, entry, true).layer.duplicate(); if (has(a, "name")) { layer.name = a.name; } return { value: layerSummary(layer), reference: layer }; }, "layer");
    var layerBooleanFields = ["enabled", "shy", "locked", "solo", "threeDLayer", "guideLayer", "adjustmentLayer"];
    var transformNames = { position: "ADBE Position", anchorPoint: "ADBE Anchor Point", scale: "ADBE Scale", rotation: "ADBE Rotate Z", xRotation: "ADBE Rotate X", yRotation: "ADBE Rotate Y", zRotation: "ADBE Rotate Z", opacity: "ADBE Opacity" };
    register("team.layer.update", "Update layer timing, flags and transform values", true, { comp: "optional comp selector", layer: "layer selector", name: "optional name", startTime: "optional seconds", inPoint: "optional seconds", outPoint: "optional seconds", label: "optional integer 0..16", enabled: "optional boolean", shy: "optional boolean", locked: "optional boolean", solo: "optional boolean", threeDLayer: "optional boolean", guideLayer: "optional boolean", adjustmentLayer: "optional boolean", transform: "optional {position,anchorPoint,scale,rotation,xRotation,yRotation,zRotation,opacity}" }, function (a, refs) {
        var i, names; selectors(a, refs, true); optional(a, "name", function (v, p) { text(v, p, 1024); });
        for (i = 0; i < layerBooleanFields.length; i += 1) { optional(a, layerBooleanFields[i], boolValue); }
        optional(a, "startTime", function (v, p) { number(v, p, -10800, 10800); }); optional(a, "inPoint", function (v, p) { number(v, p, -10800, 10800); }); optional(a, "outPoint", function (v, p) { number(v, p, -10800, 10800); }); optional(a, "label", function (v, p) { whole(v, p, 0, 16); });
        if (has(a, "inPoint") && has(a, "outPoint") && a.inPoint >= a.outPoint) { fail("args.inPoint must precede args.outPoint"); }
        if (has(a, "transform")) {
            exact(a.transform, "position|anchorPoint|scale|rotation|xRotation|yRotation|zRotation|opacity", "args.transform"); names = keys(a.transform);
            if (has(a.transform, "rotation") && has(a.transform, "zRotation")) { fail("Use rotation or zRotation, not both"); }
            for (i = 0; i < names.length; i += 1) {
                if (names[i] === "position" || names[i] === "anchorPoint" || names[i] === "scale") { vector(a.transform[names[i]], "args.transform." + names[i], 2, 3); }
                else { number(a.transform[names[i]], "args.transform." + names[i], names[i] === "opacity" ? 0 : undefined, names[i] === "opacity" ? 100 : undefined); }
            }
        }
    }, function (a, refs, entry) {
        var layer = resolved(a, refs, entry, true).layer, names = ["name", "startTime", "inPoint", "outPoint", "label", "enabled", "shy", "solo", "threeDLayer", "guideLayer", "adjustmentLayer"], i, property;
        checkLayerUpdate(layer, a);
        if (a.locked === false) { layer.locked = false; }
        for (i = 0; i < names.length; i += 1) { if (has(a, names[i])) { layer[names[i]] = a[names[i]]; } }
        if (a.transform) { names = keys(a.transform); for (i = 0; i < names.length; i += 1) { property = resolveProperty(layer, ["ADBE Transform Group", transformNames[names[i]]]); writeValue(property, a.transform[names[i]]); } }
        if (has(a, "locked")) { layer.locked = a.locked; }
        return layerSummary(layer);
    });
    register("team.layer.parent", "Parent or unparent a layer within its composition", true, { comp: "optional comp selector", layer: "layer selector", parent: "layer selector or null", preserveTransforms: "optional boolean; default true" }, function (a, refs) { selectors(a, refs, true); if (!has(a, "parent")) { fail("args.parent is required"); } if (a.parent !== null) { selector(a.parent, "args.parent", "layer", refs); } optional(a, "preserveTransforms", boolValue); }, function (a, refs, entry) {
        var target = resolved(a, refs, entry, true), parent = a.parent === null ? null : resolveLayer(target.comp, a.parent, refs), ancestor = parent, limit = 0;
        while (ancestor) { if (ancestor === target.layer) { fail("Parenting would create a layer cycle"); } ancestor = ancestor.parent; limit += 1; if (limit > target.comp.numLayers) { fail("Existing parent cycle detected"); } }
        if (a.preserveTransforms === false) { target.layer.setParentWithJump(parent); } else { target.layer.parent = parent; } return layerSummary(target.layer);
    });
    function propertyCheck(a, refs) { selectors(a, refs, true); propertyPath(a.path, "args.path"); }
    register("team.property.list", "Read child property names, matchNames and indices for discovering exact paths", false, { comp: "optional comp selector", layer: "layer selector", path: "optional property path; omit for top-level layer properties", maxProperties: "optional integer 1..5000; default 200" }, function (a, refs) {
        selectors(a, refs, true); if (has(a, "path")) { propertyPath(a.path, "args.path"); } optional(a, "maxProperties", function (v, p) { whole(v, p, 1, 5000); });
    }, function (a, refs, entry) {
        var layer = resolved(a, refs, entry, true).layer, group = a.path ? resolveProperty(layer, a.path) : layer, count = Number(group.numProperties || 0), out = [], limit = a.maxProperties || 200, i, property;
        for (i = 1; i <= count && i <= limit; i += 1) { property = group.property(i); if (property) { out.push({ index: i, name: String(property.name), matchName: String(property.matchName || ""), numProperties: Number(property.numProperties || 0), canSetExpression: !!property.canSetExpression, numKeys: Number(property.numKeys || 0) }); } }
        return { name: String(group.name), numProperties: count, properties: out, truncated: count > limit };
    });
    register("team.property.get", "Read a layer property and optional keyframes", false, { comp: "optional comp selector", layer: "layer selector", path: "array of exact matchNames/names or positive indices", keys: "optional boolean; default false" }, function (a, refs) { propertyCheck(a, refs); optional(a, "keys", boolValue); }, function (a, refs, entry) {
        var target = resolved(a, refs, entry, true), property = resolveProperty(target.layer, a.path), result = { name: property.name, matchName: property.matchName, value: dataValue(property.value), numKeys: property.numKeys || 0, canSetExpression: !!property.canSetExpression }, i;
        if (property.canSetExpression) { result.expression = String(property.expression || ""); result.expressionEnabled = !!property.expressionEnabled; result.expressionError = String(property.expressionError || ""); }
        if (a.keys) { if (property.numKeys > 5000) { fail("Property has more than 5000 keyframes; read without keys"); } result.keys = []; for (i = 1; i <= property.numKeys; i += 1) { result.keys.push({ time: property.keyTime(i), value: dataValue(property.keyValue(i)) }); } }
        return result;
    });
    register("team.property.set", "Set a static property or a value at a specified time", true, { comp: "optional comp selector", layer: "layer selector", path: "property path", value: "number, string, boolean or numeric vector", time: "optional keyframe time in seconds" }, function (a, refs) { propertyCheck(a, refs); if (!has(a, "value")) { fail("args.value is required"); } valueData(a.value, "args.value"); optional(a, "time", function (v, p) { number(v, p, -10800, 10800); }); }, function (a, refs, entry) { var property = resolveProperty(resolved(a, refs, entry, true).layer, a.path); writeValue(property, a.value, a.time); return { name: property.name, value: dataValue(property.value), numKeys: property.numKeys || 0 }; });
    function checkTemporalEase(value, path) {
        if (typeof value === "string") { if (value !== "ease" && value !== "ease-in" && value !== "ease-out" && value !== "ease-in-out") { fail(path + " must be ease, ease-in, ease-out or ease-in-out"); } return; }
        exact(value, "inSpeed|outSpeed|inInfluence|outInfluence", path);
        optional(value, "inSpeed", function (v) { number(v, path + ".inSpeed", -10000000, 10000000); });
        optional(value, "outSpeed", function (v) { number(v, path + ".outSpeed", -10000000, 10000000); });
        optional(value, "inInfluence", function (v) { number(v, path + ".inInfluence", 0.1, 100); });
        optional(value, "outInfluence", function (v) { number(v, path + ".outInfluence", 0.1, 100); });
    }
    function setTemporalEase(property, index, spec) {
        var incoming = 33.333, outgoing = 33.333, inSpeed = 0, outSpeed = 0, dimensions, a = [], b = [], i;
        if (typeof property.setTemporalEaseAtKey !== "function" || typeof KeyframeEase === "undefined") { fail("Temporal easing is unavailable for this property"); }
        if (typeof spec === "string") { if (spec === "ease" || spec === "ease-in-out") { incoming = 75; outgoing = 75; } if (spec === "ease-in") { incoming = 75; } if (spec === "ease-out") { outgoing = 75; } }
        else { if (has(spec, "inInfluence")) { incoming = spec.inInfluence; } if (has(spec, "outInfluence")) { outgoing = spec.outInfluence; } if (has(spec, "inSpeed")) { inSpeed = spec.inSpeed; } if (has(spec, "outSpeed")) { outSpeed = spec.outSpeed; } }
        dimensions = property.isSpatial ? 1 : (array(property.value) ? property.value.length : 1);
        if (dimensions < 1 || dimensions > 4) { fail("Unsupported temporal easing dimensions"); }
        for (i = 0; i < dimensions; i += 1) { a.push(new KeyframeEase(inSpeed, incoming)); b.push(new KeyframeEase(outSpeed, outgoing)); }
        property.setTemporalEaseAtKey(index, a, b);
    }
    register("team.property.keyframes", "Add or update keyframes with optional temporal easing; preserves other keys", true, { comp: "optional comp selector", layer: "layer selector", path: "property path", keys: "1..5000 {time,value,interpolation?:linear|bezier|hold,easing?:ease|ease-in|ease-out|ease-in-out or {inSpeed,outSpeed,inInfluence,outInfluence}}" }, function (a, refs) {
        var i, key, seen = {}; propertyCheck(a, refs);
        if (!array(a.keys) || !a.keys.length || a.keys.length > 5000) { fail("args.keys must contain 1 to 5000 keyframes"); }
        for (i = 0; i < a.keys.length; i += 1) {
            key = a.keys[i]; exact(key, "time|value|interpolation|easing", "args.keys[" + i + "]"); number(key.time, "args.keys[" + i + "].time", -10800, 10800); if (has(seen, String(key.time))) { fail("Duplicate keyframe time: " + key.time); } seen[String(key.time)] = true; valueData(key.value, "args.keys[" + i + "].value");
            if (has(key, "interpolation") && key.interpolation !== "linear" && key.interpolation !== "bezier" && key.interpolation !== "hold") { fail("Invalid keyframe interpolation"); }
            if (has(key, "easing")) { checkTemporalEase(key.easing, "args.keys[" + i + "].easing"); if (key.interpolation === "hold" || key.interpolation === "linear") { fail("Temporal easing requires bezier interpolation"); } }
        }
    }, function (a, refs, entry) {
        var property = resolveProperty(resolved(a, refs, entry, true).layer, a.path), i, key, interpolation, index;
        if (!property.canVaryOverTime || typeof property.setValueAtTime !== "function") { fail("Selected property cannot be keyframed"); }
        for (i = 0; i < a.keys.length; i += 1) {
            key = a.keys[i]; writeValue(property, key.value, key.time);
            if (key.interpolation) { interpolation = key.interpolation === "hold" ? KeyframeInterpolationType.HOLD : (key.interpolation === "bezier" ? KeyframeInterpolationType.BEZIER : KeyframeInterpolationType.LINEAR); index = property.nearestKeyIndex(key.time); property.setInterpolationTypeAtKey(index, interpolation, interpolation); }
            if (has(key, "easing")) { index = property.nearestKeyIndex(key.time); property.setInterpolationTypeAtKey(index, KeyframeInterpolationType.BEZIER, KeyframeInterpolationType.BEZIER); setTemporalEase(property, index, key.easing); }
        }
        return { name: property.name, numKeys: property.numKeys };
    });
    register("team.property.expression", "Set or clear an After Effects property expression", true, { comp: "optional comp selector", layer: "layer selector", path: "property path", expression: "expression string; empty clears", enabled: "optional boolean" }, function (a, refs) { propertyCheck(a, refs); text(a.expression, "args.expression", 65536, true); optional(a, "enabled", boolValue); }, function (a, refs, entry) {
        var property = resolveProperty(resolved(a, refs, entry, true).layer, a.path);
        if (!property.canSetExpression) { fail("Selected property does not support expressions"); }
        property.expression = a.expression; if (has(a, "enabled")) { property.expressionEnabled = a.enabled; }
        if (property.expressionError) { fail("After Effects expression error: " + property.expressionError); }
        return { name: property.name, expression: property.expression, enabled: !!property.expressionEnabled };
    });
    register("team.effect.add", "Add an installed effect using its exact matchName", true, { comp: "optional comp selector", layer: "layer selector", matchName: "registered effect matchName", name: "optional effect instance name" }, function (a, refs) { selectors(a, refs, true); text(a.matchName, "args.matchName", 256); optional(a, "name", function (v, p) { text(v, p, 1024); }); }, function (a, refs, entry) {
        var layer = resolved(a, refs, entry, true).layer, group = resolveProperty(layer, ["ADBE Effect Parade"]), effect;
        if (!group.canAddProperty(a.matchName)) { fail("Effect is unavailable for this layer: " + a.matchName); }
        effect = group.addProperty(a.matchName); if (!effect) { fail("After Effects did not add effect " + a.matchName); } if (has(a, "name")) { effect.name = a.name; }
        return { name: effect.name, matchName: effect.matchName, index: effect.propertyIndex, layer: layerSummary(layer) };
    });
    register("team.layer.shape.create", "Create a rectangle, ellipse, star, polygon or Bezier path shape layer", true, { comp: "optional comp selector", name: "optional layer name", shape: "rect, ellipse, star, polygon or path", size: "rect/ellipse [width,height]", position: "optional shape-local [x,y]", roundness: "optional rectangle corner radius", points: "optional star/polygon point count; default 5", outerRadius: "optional star/polygon radius; default 100", innerRadius: "optional star inner radius; default 50", shapeRotation: "optional star/polygon rotation degrees", vertices: "path [[x,y],...]", inTangents: "optional path tangent vectors", outTangents: "optional path tangent vectors", closed: "optional path boolean; default true", fillColor: "optional RGB vector", strokeColor: "optional RGB vector", strokeWidth: "optional nonnegative number; default 2" }, function (a, refs) {
        var i, names = ["vertices", "inTangents", "outTangents"];
        selectors(a, refs, false); optional(a, "name", function (v, p) { text(v, p, 1024); });
        if (a.shape !== "rect" && a.shape !== "ellipse" && a.shape !== "path" && a.shape !== "star" && a.shape !== "polygon") { fail("args.shape must be rect, ellipse, path, star or polygon"); }
        if (a.shape !== "star" && a.shape !== "polygon" && (has(a, "points") || has(a, "outerRadius") || has(a, "innerRadius") || has(a, "shapeRotation"))) { fail("Star/polygon parameters require a star or polygon shape"); }
        if (a.shape === "path") {
            if (has(a, "size") || has(a, "roundness") || has(a, "position")) { fail("Path shapes use vertices/tangents rather than size, roundness or position"); }
            if (!array(a.vertices) || a.vertices.length < 2 || a.vertices.length > 5000) { fail("Path requires 2 to 5000 vertices"); }
            for (i = 0; i < names.length; i += 1) { if (has(a, names[i])) { checkPoints(a[names[i]], names[i], a.vertices.length); } }
        } else if (a.shape === "star" || a.shape === "polygon") {
            if (has(a, "vertices") || has(a, "inTangents") || has(a, "outTangents") || has(a, "closed") || has(a, "size") || has(a, "roundness")) { fail("Star/polygon uses points and radii, not path or rectangle parameters"); }
            optional(a, "position", function (v, p) { vector(v, p, 2, 2); });
            optional(a, "points", function (v, p) { whole(v, p, 3, 1000); });
            optional(a, "outerRadius", function (v, p) { number(v, p, 0.001, 30000); });
            optional(a, "innerRadius", function (v, p) { number(v, p, 0.001, 30000); });
            optional(a, "shapeRotation", function (v, p) { number(v, p, -1000000, 1000000); });
            if (a.shape === "polygon" && has(a, "innerRadius")) { fail("Polygon has no inner radius"); }
        } else {
            if (has(a, "vertices") || has(a, "inTangents") || has(a, "outTangents") || has(a, "closed")) { fail("Only path shapes accept vertices, tangents and closed"); }
            vector(a.size, "args.size", 2, 2, 0.001); optional(a, "position", function (v, p) { vector(v, p, 2, 2); }); optional(a, "roundness", function (v, p) { number(v, p, 0); }); if (a.shape === "ellipse" && has(a, "roundness")) { fail("Ellipse has no roundness parameter"); }
        }
        optional(a, "closed", boolValue); optional(a, "fillColor", function (v, p) { vector(v, p, 3, 3, 0, 1); }); optional(a, "strokeColor", function (v, p) { vector(v, p, 3, 3, 0, 1); }); optional(a, "strokeWidth", function (v, p) { number(v, p, 0, 30000); });
        if (has(a, "strokeWidth") && !has(a, "strokeColor")) { fail("args.strokeWidth requires args.strokeColor"); }
    }, function (a, refs, entry) {
        var comp = resolved(a, refs, entry, false).comp, layer = comp.layers.addShape(), root = resolveProperty(layer, ["ADBE Root Vectors Group"]), group = root.addProperty("ADBE Vector Group"), contents = group.property("ADBE Vectors Group"), shape, path, fill, stroke, i;
        if (has(a, "name")) { layer.name = a.name; }
        if (a.shape === "path") {
            shape = contents.addProperty("ADBE Vector Shape - Group"); path = new Shape(); path.vertices = a.vertices; path.inTangents = []; path.outTangents = [];
            for (i = 0; i < a.vertices.length; i += 1) { path.inTangents.push(a.inTangents ? a.inTangents[i] : [0, 0]); path.outTangents.push(a.outTangents ? a.outTangents[i] : [0, 0]); }
            path.closed = a.closed !== false; shape.property("ADBE Vector Shape").setValue(path);
        } else if (a.shape === "star" || a.shape === "polygon") {
            shape = contents.addProperty("ADBE Vector Shape - Star");
            shape.property("ADBE Vector Star Type").setValue(a.shape === "star" ? 1 : 2);
            shape.property("ADBE Vector Star Points").setValue(has(a, "points") ? a.points : 5);
            shape.property("ADBE Vector Star Outer Radius").setValue(has(a, "outerRadius") ? a.outerRadius : 100);
            if (a.shape === "star") { shape.property("ADBE Vector Star Inner Radius").setValue(has(a, "innerRadius") ? a.innerRadius : 50); }
            if (a.position) { shape.property("ADBE Vector Star Position").setValue(a.position); }
            if (has(a, "shapeRotation")) { shape.property("ADBE Vector Star Rotation").setValue(a.shapeRotation); }
        } else {
            shape = contents.addProperty(a.shape === "rect" ? "ADBE Vector Shape - Rect" : "ADBE Vector Shape - Ellipse");
            shape.property(a.shape === "rect" ? "ADBE Vector Rect Size" : "ADBE Vector Ellipse Size").setValue(a.size);
            if (a.position) { shape.property(a.shape === "rect" ? "ADBE Vector Rect Position" : "ADBE Vector Ellipse Position").setValue(a.position); }
            if (has(a, "roundness")) { shape.property("ADBE Vector Rect Roundness").setValue(a.roundness); }
        }
        if (a.fillColor || !a.strokeColor) { fill = contents.addProperty("ADBE Vector Graphic - Fill"); fill.property("ADBE Vector Fill Color").setValue(a.fillColor || [1, 1, 1]); }
        if (a.strokeColor) { stroke = contents.addProperty("ADBE Vector Graphic - Stroke"); stroke.property("ADBE Vector Stroke Color").setValue(a.strokeColor); stroke.property("ADBE Vector Stroke Width").setValue(has(a, "strokeWidth") ? a.strokeWidth : 2); }
        return { value: layerSummary(layer), reference: layer };
    }, "layer");
    function checkPoints(points, path, expected) { var i; if (!array(points) || points.length !== expected) { fail("args." + path + " must match the vertices count"); } for (i = 0; i < points.length; i += 1) { vector(points[i], "args." + path + "[" + i + "]", 2, 2); } }
    register("team.comp.rebuildMedia", "Rebuild a 2D composition from original media, baking nested transforms without retaining precomps", true, { comp: "source comp selector", name: "new composition name", sampleRate: "optional samples per second; default source frameRate", resumeCompId: "optional existing partial rebuild composition id" }, function (a, refs) {
        selectors(a, refs, false); text(a.name, "args.name", 1024);
        optional(a, "sampleRate", function (v, p) { number(v, p, 1, 60); });
        optional(a, "resumeCompId", function (v, p) { whole(v, p, 1); });
    }, function (a, refs, entry) {
        var source = resolved(a, refs, entry, false).comp, rate = a.sampleRate || source.frameRate;
        var dest, leaves = [], warnings = [], count = 0, existingCount = 0, i;
        function val(l, n, t) { return l.property("ADBE Transform Group").property(n).valueAtTime(t, false); }
        function mul(x, y) { return [x[0]*y[0]+x[2]*y[1], x[1]*y[0]+x[3]*y[1], x[0]*y[2]+x[2]*y[3], x[1]*y[2]+x[3]*y[3], x[0]*y[4]+x[2]*y[5]+x[4], x[1]*y[4]+x[3]*y[5]+x[5]]; }
        function point(m, p) { return [m[0]*p[0]+m[2]*p[1]+m[4], m[1]*p[0]+m[3]*p[1]+m[5]]; }
        function matrix(l, t) {
            var an = val(l,"ADBE Anchor Point",t), po = val(l,"ADBE Position",t), sc = val(l,"ADBE Scale",t), r = val(l,"ADBE Rotate Z",t)*Math.PI/180, c = Math.cos(r), s = Math.sin(r);
            var m = [c*sc[0]/100,s*sc[0]/100,-s*sc[1]/100,c*sc[1]/100,0,0];
            m[4]=po[0]-m[0]*an[0]-m[2]*an[1]; m[5]=po[1]-m[1]*an[0]-m[3]*an[1];
            return l.parent ? mul(matrix(l.parent,t),m) : m;
        }
        function geometry(l, t) {
            var m=[1,0,0,1,0,0], fx=l.property("ADBE Effect Parade"), j,e,an,po,sc,sy,r,c,s,n;
            if(!fx)return m;
            for(j=1;j<=fx.numProperties;j++) { e=fx.property(j); if(!e.enabled)continue;
                if(e.matchName!=="ADBE Geometry2") { warnings.push("Container effect omitted: "+l.name+" / "+e.matchName); continue; }
                an=e.property(1).valueAtTime(t,false); po=e.property(2).valueAtTime(t,false);
                sc=e.property(4).valueAtTime(t,false)/100; sy=e.property(3).valueAtTime(t,false)?sc:e.property(5).valueAtTime(t,false)/100;
                r=e.property(8).valueAtTime(t,false)*Math.PI/180; c=Math.cos(r);s=Math.sin(r);
                n=[c*sc,s*sc,-s*sy,c*sy,0,0]; n[4]=po[0]-n[0]*an[0]-n[2]*an[1];n[5]=po[1]-n[1]*an[0]-n[3]*an[1]; m=mul(n,m);
            }return m;
        }
        function scan(c, offset, speed, lo, hi, chain, video, audio, depth) {
            var j,l,s,v,au,start,end,ch;
            if(depth>12)fail("Nested composition depth exceeds 12");
            for(j=1;j<=c.numLayers;j++) { l=c.layer(j);s=l.source;
                if(l.threeDLayer&&(Math.abs(val(l,"ADBE Rotate X",0))>0.001||Math.abs(val(l,"ADBE Rotate Y",0))>0.001))fail("Nonplanar 3D layers are not supported: "+l.name);
                if(l.timeRemapEnabled)fail("Time remapping is not supported: "+l.name);
                if(l.stretch<=0)fail("Reverse time is not supported: "+l.name);
                v=video&&l.enabled&&!l.guideLayer&&!l.nullLayer;au=audio&&l.hasAudio&&l.audioEnabled;
                if(!v&&!au)continue;
                start=Math.max(lo,offset+speed*l.inPoint);end=Math.min(hi,offset+speed*l.outPoint);
                if(end<=start)continue;
                if(isComp(s)) {ch=chain.concat([{layer:l,offset:offset,speed:speed}]);scan(s,offset+speed*l.startTime,speed*l.stretch/100,start,end,ch,v,au,depth+1);}
                else leaves.push({layer:l,offset:offset,speed:speed,lo:start,hi:end,chain:chain,video:v,audio:au});
            }
        }
        scan(source,0,1,0,source.duration,[],true,true,0);
        if(leaves.length>300)fail("Rebuild is limited to 300 media layers");
        if(a.resumeCompId){dest=resolveComp({comp:{id:a.resumeCompId}},{});if(dest.id===source.id||dest.name!==a.name||dest.numLayers>leaves.length)fail("Invalid partial rebuild destination");existingCount=dest.numLayers;
            for(i=0;i<existingCount;i++)if(dest.layer(existingCount-i).name!==leaves[leaves.length-1-i].layer.name)fail("Partial rebuild layer order does not match");
        } else dest=project().items.addComp(a.name,source.width,source.height,source.pixelAspect,source.duration,source.frameRate);
        dest.bgColor=source.bgColor;dest.workAreaStart=source.workAreaStart;dest.workAreaDuration=source.workAreaDuration;
        function times(lo, hi) { var ts=[],k;for(k=Math.floor(lo*rate);k<=Math.ceil(hi*rate);k++)if(k/rate>=lo&&k/rate<=hi)ts.push(k/rate);if(!ts.length||ts[0]>lo)ts.unshift(lo);return ts; }
        function transfer(sp, dp, rec) {
            var ts,vs=[],k,t;
            if(!dp||sp.propertyValueType===PropertyValueType.NO_VALUE||sp.propertyValueType===PropertyValueType.CUSTOM_VALUE)return;
            try {
                if(sp.canVaryOverTime&&(sp.numKeys>0||sp.expressionEnabled)) {ts=times(rec.lo,rec.hi);for(k=0;k<ts.length;k++){t=(ts[k]-rec.offset)/rec.speed;vs.push(sp.valueAtTime(t,false));}dp.setValuesAtTimes(ts,vs);}
                else dp.setValue(sp.valueAtTime((rec.lo-rec.offset)/rec.speed,false));
            }catch(e){warnings.push("Property omitted: "+sp.name+" / "+String(e));}
        }
        function group(sp,dp,rec) {var j,p,q,idx; if(!sp||!dp)return;for(j=1;j<=sp.numProperties;j++){p=sp.property(j);q=null;
            try {if(dp.propertyType===PropertyType.INDEXED_GROUP&&dp.canAddProperty(p.matchName)){q=dp.addProperty(p.matchName);idx=q.propertyIndex;q.name=p.name;}else q=dp.property(p.matchName)||dp.property(j);
                if(!q)continue;
                if(p.propertyType===PropertyType.PROPERTY)transfer(p,q,rec);else group(p,q,rec);
                try{q.enabled=p.enabled;}catch(ignore){}
            }catch(e){warnings.push("Group omitted: "+p.name+" / "+String(e));}
        }}
        function build(rec) {
            var l=rec.layer,s=l.source,n,tp,ts=times(rec.lo,rec.hi),ps=[],ss=[],rs=[],ops=[],k,j,t,m,an,po,op,c,det,scx,scy;
            if(count<existingCount)n=dest.layer(existingCount-count);
            else if(s&&s.mainSource&&s.mainSource.color) n=dest.layers.addSolid(s.mainSource.color,l.name,s.width,s.height,s.pixelAspect,source.duration);
            else if(s)n=dest.layers.add(s);
            else if(l.property("ADBE Text Properties")) {n=dest.layers.addText("");group(l.property("ADBE Text Properties"),n.property("ADBE Text Properties"),rec);}
            else if(l.property("ADBE Root Vectors Group")){n=dest.layers.addShape();group(l.property("ADBE Root Vectors Group"),n.property("ADBE Root Vectors Group"),rec);}
            else {warnings.push("Unsupported layer: "+l.name);return;}
            n.name=l.name;n.stretch=l.stretch*rec.speed;n.startTime=rec.offset+rec.speed*l.startTime;n.inPoint=rec.lo;n.outPoint=rec.hi;n.enabled=rec.video;
            if(n.hasAudio)n.audioEnabled=rec.audio;
            n.label=l.label;try{n.blendingMode=l.blendingMode;}catch(ignoreBlend){}
            if(s&&!s.hasVideo){if(n.hasAudio)group(l.property("ADBE Audio Group"),n.property("ADBE Audio Group"),rec);count++;return;}
            tp=n.property("ADBE Transform Group");an=val(l,"ADBE Anchor Point",(rec.lo-rec.offset)/rec.speed);tp.property("ADBE Anchor Point").setValue([an[0],an[1]]);
            for(k=0;k<ts.length;k++) {t=(ts[k]-rec.offset)/rec.speed;m=matrix(l,t);op=val(l,"ADBE Opacity",t);
                for(j=rec.chain.length-1;j>=0;j--){c=rec.chain[j];t=(ts[k]-c.offset)/c.speed;m=mul(mul(matrix(c.layer,t),geometry(c.layer,t)),m);op*=val(c.layer,"ADBE Opacity",t)/100;}
                po=point(m,an);scx=Math.sqrt(m[0]*m[0]+m[1]*m[1]);det=m[0]*m[3]-m[1]*m[2];scy=det/scx;
                ps.push(po);ss.push([scx*100,scy*100]);rs.push(Math.atan2(m[1],m[0])*180/Math.PI);ops.push(op);
            }
            tp.property("ADBE Position").setValuesAtTimes(ts,ps);tp.property("ADBE Scale").setValuesAtTimes(ts,ss);tp.property("ADBE Rotate Z").setValuesAtTimes(ts,rs);tp.property("ADBE Opacity").setValuesAtTimes(ts,ops);
            group(l.property("ADBE Mask Parade"),n.property("ADBE Mask Parade"),rec);
            group(l.property("ADBE Effect Parade"),n.property("ADBE Effect Parade"),rec);
            if(n.hasAudio)group(l.property("ADBE Audio Group"),n.property("ADBE Audio Group"),rec);
            count++;
        }
        for(i=leaves.length-1;i>=0;i--)build(leaves[i]);
        for(i=1;i<=dest.numLayers;i++)if(isComp(dest.layer(i).source))fail("Unexpected precomp dependency");
        var unique=[],seen={},w;for(i=0;i<warnings.length;i++){w=warnings[i];if(!seen[w]){seen[w]=true;unique.push(w);}}
        dest.comment="Rebuilt from original media with independent baked animation. No nested compositions.";dest.time=0;dest.openInViewer();
        return {value:{comp:compSummary(dest),mediaLayers:count,precompDependencies:0,warnings:unique},reference:dest};
    }, "comp");
    
/* Installed module: functions-layer-tools.js */
/* Included inside the reusable-function runtime IIFE; ES3, no separate JSX. */
    function extraLayerSelectors(value, path, refs, allowEmpty) {
        var i;
        if (!array(value) || value.length > 1000 || (!allowEmpty && !value.length)) { fail(path + " must contain " + (allowEmpty ? "0" : "1") + " to 1000 layer selectors"); }
        for (i = 0; i < value.length; i += 1) { selector(value[i], path + "[" + i + "]", "layer", refs); }
    }
    function extraResolveLayers(comp, selections, refs, entry) {
        var layers = [], i, j, layer;
        for (i = 0; i < selections.length; i += 1) {
            layer = entry && entry.layers && entry.layers[i] ? entry.layers[i] : resolveLayer(comp, selections[i], refs);
            if (layer.containingComp !== comp) { fail("Selected layer no longer belongs to the selected composition: " + layer.name); }
            for (j = 0; j < layers.length; j += 1) { if (layers[j] === layer) { fail("The same layer was selected more than once: " + layer.name); } }
            layers.push(layer);
        }
        return layers;
    }
    function extraUnlocked(layer, operation) {
        if (!layer || !layer.containingComp || !integer(layer.index) || layer.index < 1) { fail("Layer is no longer available for " + operation); }
        if (layer.locked) { fail("Layer is locked; unlock it explicitly before " + operation + ": " + layer.name); }
    }
    function extraLayerCreationCheck(args, refs) {
        selectors(args, refs, false);
        optional(args, "name", function (value, path) { text(value, path, 1024); });
        optional(args, "position", function (value, path) { vector(value, path, 2, 2); });
    }
    register("team.comp.duplicate", "Duplicate a composition, preserving its layer sources; optional step.as creates a comp reference", true,
        { comp: "optional comp selector", name: "optional duplicate composition name" },
        function (args, refs) { selectors(args, refs, false); optional(args, "name", function (value, path) { text(value, path, 1024); }); },
        function (args, refs, entry) {
            var comp = resolved(args, refs, entry, false).comp, duplicate;
            if (typeof comp.duplicate !== "function") { fail("Composition duplication is unavailable"); }
            duplicate = comp.duplicate();
            if (!isComp(duplicate)) { fail("After Effects did not return a duplicated composition"); }
            if (has(args, "name")) { duplicate.name = args.name; }
            return { value: compSummary(duplicate), reference: duplicate };
        }, "comp");
    register("team.comp.precompose", "Move selected layers into a new precomposition; optional step.as creates a comp reference", true,
        { comp: "optional comp selector", layers: "1..1000 unique layer selectors", name: "new precomposition name", moveAttributes: "optional boolean; default true; false requires exactly one layer" },
        function (args, refs) {
            selectors(args, refs, false); extraLayerSelectors(args.layers, "args.layers", refs, false); text(args.name, "args.name", 1024); optional(args, "moveAttributes", boolValue);
            if (args.moveAttributes === false && args.layers.length !== 1) { fail("moveAttributes:false requires exactly one layer"); }
        },
        function (args, refs, entry) {
            var comp = resolved(args, refs, entry, false).comp, layers = extraResolveLayers(comp, args.layers, refs, entry), indices = [], i, precomp;
            if (!comp.layers || typeof comp.layers.precompose !== "function") { fail("Composition precompose is unavailable"); }
            for (i = 0; i < layers.length; i += 1) { extraUnlocked(layers[i], "precomposing"); indices.push(layers[i].index); }
            indices.sort(function (left, right) { return left - right; });
            precomp = comp.layers.precompose(indices, args.name, args.moveAttributes !== false);
            if (!isComp(precomp)) { fail("After Effects did not return a precomposition"); }
            return { value: compSummary(precomp), reference: precomp };
        }, "comp");
    register("team.layer.camera.create", "Create a camera using a 2D creation center; configure zoom and one-node/two-node orientation", true,
        { comp: "optional comp selector", name: "optional camera name; default Camera", position: "optional [x,y] creation center; default composition center", type: "optional one-node or two-node; default two-node", zoom: "optional camera zoom >= 0.001 and <= 10000000" },
        function (args, refs) {
            extraLayerCreationCheck(args, refs);
            if (has(args, "type") && args.type !== "one-node" && args.type !== "two-node") { fail("args.type must be one-node or two-node"); }
            optional(args, "zoom", function (value, path) { number(value, path, 0.001, 10000000); });
        },
        function (args, refs, entry) {
            var comp = resolved(args, refs, entry, false).comp, orientation, layer, zoom;
            if (!comp.layers || typeof comp.layers.addCamera !== "function") { fail("Camera creation is unavailable"); }
            if (typeof AutoOrientType === "undefined") { fail("Camera orientation constants are unavailable"); }
            orientation = args.type === "one-node" ? AutoOrientType.NO_AUTO_ORIENT : AutoOrientType.CAMERA_OR_POINT_OF_INTEREST;
            if (typeof orientation === "undefined") { fail("Requested camera orientation is unavailable"); }
            layer = comp.layers.addCamera(args.name || "Camera", args.position || [comp.width / 2, comp.height / 2]);
            layer.autoOrient = orientation;
            if (has(args, "zoom")) { zoom = resolveProperty(layer, ["ADBE Camera Options Group", "ADBE Camera Zoom"]); writeValue(zoom, args.zoom); }
            return { value: layerSummary(layer), reference: layer };
        }, "layer");
    register("team.layer.light.create", "Create a light with an explicit type, 2D creation center and optional color/intensity", true,
        { comp: "optional comp selector", name: "optional light name; default Light", type: "optional point, spot, parallel or ambient; default point", position: "optional [x,y] creation center; default composition center", color: "optional RGB [0..1,0..1,0..1]", intensity: "optional number 0..100000" },
        function (args, refs) {
            extraLayerCreationCheck(args, refs);
            if (has(args, "type") && args.type !== "point" && args.type !== "spot" && args.type !== "parallel" && args.type !== "ambient") { fail("args.type must be point, spot, parallel or ambient"); }
            optional(args, "color", function (value, path) { vector(value, path, 3, 3, 0, 1); }); optional(args, "intensity", function (value, path) { number(value, path, 0, 100000); });
        },
        function (args, refs, entry) {
            var comp = resolved(args, refs, entry, false).comp, kind = args.type || "point", type, layer;
            if (!comp.layers || typeof comp.layers.addLight !== "function") { fail("Light creation is unavailable"); }
            if (typeof LightType === "undefined") { fail("Light type constants are unavailable"); }
            type = kind === "spot" ? LightType.SPOT : (kind === "parallel" ? LightType.PARALLEL : (kind === "ambient" ? LightType.AMBIENT : LightType.POINT));
            if (typeof type === "undefined") { fail("Requested light type is unavailable"); }
            layer = comp.layers.addLight(args.name || "Light", args.position || [comp.width / 2, comp.height / 2]); layer.lightType = type;
            if (has(args, "color")) { writeValue(resolveProperty(layer, ["ADBE Light Options Group", "ADBE Light Color"]), args.color); }
            if (has(args, "intensity")) { writeValue(resolveProperty(layer, ["ADBE Light Options Group", "ADBE Light Intensity"]), args.intensity); }
            return { value: layerSummary(layer), reference: layer };
        }, "layer");
    register("team.layer.remove", "Remove exactly the selected unlocked layer", true,
        { comp: "optional comp selector", layer: "layer selector" },
        function (args, refs) { selectors(args, refs, true); },
        function (args, refs, entry) {
            var layer = resolved(args, refs, entry, true).layer, summary;
            extraUnlocked(layer, "removing"); if (typeof layer.remove !== "function") { fail("Selected layer cannot be removed"); }
            summary = layerSummary(layer); layer.remove(); return { removed: summary };
        });
    register("team.layer.select", "Select exact layers; replace defaults true, and an empty list clears the selection", true,
        { comp: "optional comp selector", layers: "0..1000 unique unlocked layer selectors", replace: "optional boolean; default true" },
        function (args, refs) { selectors(args, refs, false); extraLayerSelectors(args.layers, "args.layers", refs, true); optional(args, "replace", boolValue); },
        function (args, refs, entry) {
            var comp = resolved(args, refs, entry, false).comp, layers = extraResolveLayers(comp, args.layers, refs, entry), i, selected = [];
            for (i = 0; i < layers.length; i += 1) { extraUnlocked(layers[i], "selecting"); }
            if (args.replace !== false) { for (i = 1; i <= comp.numLayers; i += 1) { comp.layer(i).selected = false; } }
            for (i = 0; i < layers.length; i += 1) { layers[i].selected = true; }
            for (i = 1; i <= comp.numLayers; i += 1) { if (comp.layer(i).selected) { selected.push(layerSummary(comp.layer(i))); } }
            return { compId: comp.id, selected: selected };
        });
    var extraBlendModes = { Normal: "NORMAL", Add: "ADD", Multiply: "MULTIPLY", Screen: "SCREEN", Overlay: "OVERLAY", SoftLight: "SOFT_LIGHT", HardLight: "HARD_LIGHT", ColorDodge: "COLOR_DODGE", ColorBurn: "COLOR_BURN", Difference: "DIFFERENCE", Exclusion: "EXCLUSION", Hue: "HUE", Saturation: "SATURATION", Color: "COLOR", Luminosity: "LUMINOSITY", Darken: "DARKEN", Lighten: "LIGHTEN" };
    register("team.layer.blendMode", "Set an AV layer's actual blendingMode using a supported mode name", true,
        { comp: "optional comp selector", layer: "layer selector", mode: "Normal, Add, Multiply, Screen, Overlay, SoftLight, HardLight, ColorDodge, ColorBurn, Difference, Exclusion, Hue, Saturation, Color, Luminosity, Darken or Lighten" },
        function (args, refs) { selectors(args, refs, true); text(args.mode, "args.mode", 32); if (!has(extraBlendModes, args.mode)) { fail("Unsupported blend mode: " + args.mode); } },
        function (args, refs, entry) {
            var layer = resolved(args, refs, entry, true).layer, mode;
            extraUnlocked(layer, "changing blending mode");
            if (typeof layer.blendingMode === "undefined") { fail("Selected layer does not support blending modes"); }
            if (typeof BlendingMode === "undefined") { fail("Blending mode constants are unavailable"); }
            mode = BlendingMode[extraBlendModes[args.mode]]; if (typeof mode === "undefined") { fail("Requested blending mode is unavailable in this host"); }
            layer.blendingMode = mode; return { layer: layerSummary(layer), mode: args.mode };
        });


/* Installed module: functions-project-tools.js */
    /* Project/media/render tools. Injected into the reusable registry; ES3 only. */
    var projectToolsRenderApprovals = [];
    function projectToolsType(item) {
        if (isComp(item)) { return "composition"; }
        if (typeof FolderItem !== "undefined" && item instanceof FolderItem) { return "folder"; }
        if (typeof FootageItem !== "undefined" && item instanceof FootageItem) { return "footage"; }
        return "item";
    }
    function projectToolsIsSolid(item) {
        try { return projectToolsType(item) === "footage" && typeof SolidSource !== "undefined" && item.mainSource instanceof SolidSource; }
        catch (ignoreSourceRead) { return false; }
    }
    function projectToolsItemSummary(item) {
        var out = { id: item.id, name: item.name, type: projectToolsType(item) }, fields = ["width", "height", "duration", "frameRate", "numLayers", "numItems"], i, value, file, color;
        if (out.type === "footage") { out.isSolid = projectToolsIsSolid(item); }
        try { if (item.parentFolder && finite(item.parentFolder.id)) { out.parentFolderId = item.parentFolder.id; } } catch (ignoreFolderRead) {}
        for (i = 0; i < fields.length; i += 1) {
            try { value = item[fields[i]]; if (finite(value)) { out[fields[i]] = value; } } catch (ignoreMetadataRead) {}
        }
        try { file = item.file; if (file) { out.path = String(file.fsName || file.fullName); out.file = out.path; } } catch (ignoreFileRead) {}
        if (out.isSolid) {
            try { color = item.mainSource.color; if (array(color) && color.length === 3 && finite(color[0]) && finite(color[1]) && finite(color[2])) { out.color = [color[0], color[1], color[2]]; } } catch (ignoreColorRead) {}
        }
        return out;
    }
    function projectToolsResolveItem(selection, refs) {
        var p = project(), found = null, item, i;
        if (has(selection, "ref")) {
            item = refs[selection.ref];
            if (!item || !finite(item.id)) { fail("Project item reference is unavailable: " + selection.ref); }
            return item;
        }
        for (i = 1; i <= p.numItems; i += 1) {
            item = p.item(i);
            if (item && (has(selection, "id") ? item.id === selection.id : item.name === selection.name)) {
                if (found) { fail("Project item name is ambiguous; use its id: " + selection.name); }
                found = item;
            }
        }
        if (!found) { fail("Project item not found: " + stringify(selection)); }
        return found;
    }
    function projectToolsCheckPrecompCycle(target, source) {
        var queue = [source], seen = {}, cursor = 0, count = 0, current, layer, i;
        while (cursor < queue.length) {
            current = queue[cursor++];
            if (current === target) { fail("Adding this precomp would create an indirect composition cycle"); }
            if (has(seen, "$" + current.id)) { continue; }
            seen["$" + current.id] = true;
            if (cursor > 5000) { fail("Cannot validate a precomp graph larger than 5000 compositions"); }
            for (i = 1; i <= current.numLayers; i += 1) {
                count += 1; if (count > 50000) { fail("Cannot validate a precomp graph larger than 50000 layers"); }
                layer = current.layer(i); if (!layer) { fail("A precomp layer is unavailable while checking for composition cycles"); }
                if (isComp(layer.source)) { queue.push(layer.source); }
            }
        }
    }
    function projectToolsPath(value, label) {
        text(value, label, 4096);
        if (/[\x00-\x1f]/.test(value) || !/^(?:[A-Za-z]:[\\\/]|\\\\|\/)/.test(value)) { fail(label + " must be an absolute file path without control characters"); }
    }
    function projectToolsFile(value, label, needsParent) {
        projectToolsPath(value, label);
        if (typeof File === "undefined") { fail("After Effects File API is unavailable"); }
        var file = new File(value);
        if (needsParent && (!file.parent || !file.parent.exists)) { fail(label + ": destination folder does not exist"); }
        return file;
    }
    function projectToolsPathKey(file) { return String(file.fsName || file.fullName).replace(/\\/g, "/").toLowerCase(); }
    function projectToolsEscapeRegex(value) { return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"); }
    function projectToolsOutputsConflict(first, second) {
        var left = projectToolsPathKey(first), right = projectToolsPathKey(second), a, b, prefixA, prefixB, suffixA, suffixB;
        if (left === right) { return true; }
        a = /\[#+\]/.exec(left); b = /\[#+\]/.exec(right);
        if (!a && !b) { return false; }
        if (a && b) {
            prefixA = left.substring(0, a.index); suffixA = left.substring(a.index + a[0].length);
            prefixB = right.substring(0, b.index); suffixB = right.substring(b.index + b[0].length);
            return (prefixA.indexOf(prefixB) === 0 || prefixB.indexOf(prefixA) === 0) &&
                (suffixA.slice(-suffixB.length) === suffixB || suffixB.slice(-suffixA.length) === suffixA);
        }
        if (!a) { a = b; b = left; left = right; right = b; }
        return new RegExp("^" + projectToolsEscapeRegex(left.substring(0, a.index)) + "[0-9]+" + projectToolsEscapeRegex(left.substring(a.index + a[0].length)) + "$").test(right);
    }
    function projectToolsOutputExists(file) {
        var match, prefix, suffix, pattern, candidates, i, expression;
        if (file.exists) { return true; }
        match = /\[#+\]/.exec(String(file.name || ""));
        if (!match) { return false; }
        prefix = file.name.substring(0, match.index); suffix = file.name.substring(match.index + match[0].length);
        pattern = prefix + "*" + suffix;
        if (!file.parent || typeof file.parent.getFiles !== "function") { fail("Cannot inspect existing output sequence files"); }
        candidates = file.parent.getFiles(pattern);
        expression = new RegExp("^" + projectToolsEscapeRegex(prefix) + "[0-9]+" + projectToolsEscapeRegex(suffix) + "$", "i");
        for (i = 0; i < candidates.length; i += 1) { if (expression.test(String(candidates[i].name || ""))) { return true; } }
        return false;
    }
    function projectToolsStatus(value) {
        var names = ["WILL_CONTINUE", "NEEDS_OUTPUT", "UNQUEUED", "QUEUED", "RENDERING", "USER_STOPPED", "ERR_STOPPED", "DONE"], i;
        if (typeof RQItemStatus !== "undefined") {
            for (i = 0; i < names.length; i += 1) { if (typeof RQItemStatus[names[i]] !== "undefined" && value === RQItemStatus[names[i]]) { return names[i]; } }
        }
        return "UNKNOWN:" + String(value);
    }
    function projectToolsQueue() {
        var queue = project().renderQueue;
        if (!queue || !queue.items || typeof queue.items.add !== "function") { fail("The After Effects render queue is unavailable"); }
        if (queue.rendering) { fail("The render queue is already rendering"); }
        return queue;
    }
    function projectToolsQueueIndex(queue, item) {
        var i;
        for (i = 1; i <= queue.numItems; i += 1) { if (queue.item(i) === item) { return i; } }
        fail("The render queue item is no longer present");
    }
    function projectToolsTemplate(templates, name, label) {
        var i;
        if (!templates || typeof templates.length !== "number") { fail(label + " template inventory is unavailable"); }
        for (i = 0; i < templates.length; i += 1) { if (templates[i] === name) { return; } }
        fail(label + " template is not installed: " + name);
    }
    function projectToolsCheckQueueDestination(queue, file) {
        var i, j, item, output;
        if (queue.numItems >= 1000) { fail("Render queue reached the supported 1000-item inspection bound"); }
        for (i = 1; i <= queue.numItems; i += 1) {
            item = queue.item(i);
            if (!item || !item.render || projectToolsStatus(item.status) !== "QUEUED") { continue; }
            if (!integer(item.numOutputModules) || item.numOutputModules > 100) { fail("Cannot inspect an invalid output-module count in queue item " + i); }
            for (j = 1; j <= item.numOutputModules; j += 1) {
                output = item.outputModule(j);
                if (output && output.file && projectToolsOutputsConflict(output.file, file)) { fail("Render destination conflicts with an enabled queued output at item " + i + ", module " + j); }
            }
        }
    }
    function projectToolsApproved(item, file) {
        var i;
        for (i = 0; i < projectToolsRenderApprovals.length; i += 1) {
            if (projectToolsRenderApprovals[i].item === item && projectToolsRenderApprovals[i].path === projectToolsPathKey(file)) { return projectToolsRenderApprovals[i].overwrite; }
        }
        return false;
    }

    register("team.project.search", "Find project items by name and type without changing the project", false,
        { query: "name substring; empty lists all", type: "optional all, composition, footage, solid or folder; footage includes solids", maxItems: "optional integer 1..5000; default 100" }, function (a) {
            text(a.query, "args.query", 1024, true);
            optional(a, "type", function (v, p) { if (v !== "all" && v !== "composition" && v !== "footage" && v !== "solid" && v !== "folder") { fail(p + " must be all, composition, footage, solid or folder"); } });
            optional(a, "maxItems", function (v, p) { whole(v, p, 1, 5000); });
        }, function (a) {
            var p = project(), query = a.query.toLowerCase(), kind = a.type || "all", limit = a.maxItems || 100, items = [], matched = 0, i, item;
            for (i = 1; i <= p.numItems; i += 1) {
                item = p.item(i);
                if (item && String(item.name).toLowerCase().indexOf(query) >= 0 && (kind === "all" || (kind === "solid" ? projectToolsIsSolid(item) : projectToolsType(item) === kind))) {
                    matched += 1; if (items.length < limit) { items.push(projectToolsItemSummary(item)); }
                }
            }
            return { numItems: p.numItems, totalMatches: matched, items: items, truncated: matched > items.length };
        });
    register("team.comp.hierarchy", "Read composition, layer parents and nested precomp links with bounded traversal", false,
        { comp: "optional composition selector", maxLayers: "optional total layer limit 1..5000; default 1000" }, function (a, refs) {
            selectors(a, refs, false); optional(a, "maxLayers", function (v, p) { whole(v, p, 1, 5000); });
        }, function (a, refs, entry) {
            var rootComp = resolved(a, refs, entry, false).comp, queue = [rootComp], seen = {}, compositions = [], limit = a.maxLayers || 1000;
            var cursor = 0, count = 0, truncated = false, comp, node, i, layer, info, source;
            seen["$" + rootComp.id] = true;
            while (cursor < queue.length && count < limit) {
                comp = queue[cursor++]; node = { id: comp.id, name: comp.name, numLayers: comp.numLayers, layers: [] };
                for (i = 1; i <= comp.numLayers; i += 1) {
                    if (count >= limit) { truncated = true; break; }
                    layer = comp.layer(i); if (!layer) { fail("Layer is unavailable in composition " + comp.id + " at index " + i); }
                    info = { index: layer.index, name: layer.name, parentIndex: layer.parent ? layer.parent.index : null };
                    if (finite(layer.id)) { info.id = layer.id; }
                    source = layer.source;
                    if (source && finite(source.id)) {
                        info.source = { id: source.id, name: source.name, precomp: !!isComp(source) };
                        if (isComp(source) && !has(seen, "$" + source.id)) { seen["$" + source.id] = true; queue.push(source); }
                    }
                    node.layers.push(info); count += 1;
                }
                compositions.push(node);
            }
            if (cursor < queue.length) { truncated = true; }
            return { rootCompId: rootComp.id, compositions: compositions, layersRead: count, truncated: truncated };
        });
    register("team.media.import", "Import existing media or an .aep/.aepx project as a folder into the open project", true,
        { path: "absolute source file path", sequence: "optional boolean; default false", forceAlphabetical: "optional boolean; requires sequence:true" }, function (a) {
            projectToolsPath(a.path, "args.path"); optional(a, "sequence", boolValue); optional(a, "forceAlphabetical", boolValue);
            if (a.forceAlphabetical && a.sequence !== true) { fail("forceAlphabetical requires sequence:true"); }
            if (/\.aepx?$/i.test(a.path) && (a.sequence || a.forceAlphabetical)) { fail("Project import does not support sequence flags"); }
        }, function (a) {
            var p = project(), file = projectToolsFile(a.path, "args.path", false), settings, item, importingProject = /\.aepx?$/i.test(a.path), importType;
            if (!file.exists) { fail("Media file does not exist: " + a.path); }
            if (typeof ImportOptions === "undefined" || typeof p.importFile !== "function") { fail("After Effects media import API is unavailable"); }
            if (importingProject && p.file && projectToolsPathKey(file) === projectToolsPathKey(p.file)) { fail("Cannot import the current project into itself"); }
            settings = new ImportOptions(file);
            if (importingProject && (typeof ImportAsType === "undefined" || typeof ImportAsType.PROJECT === "undefined" || typeof settings.canImportAs !== "function")) { fail("After Effects project import API is unavailable"); }
            if (typeof ImportAsType !== "undefined" && typeof settings.canImportAs === "function") {
                importType = importingProject ? ImportAsType.PROJECT : ImportAsType.FOOTAGE;
                if (!settings.canImportAs(importType)) { fail("The selected file cannot be imported as " + (importingProject ? "a project" : "footage")); }
                settings.importAs = importType;
            }
            settings.sequence = a.sequence === true;
            if (has(a, "forceAlphabetical")) { settings.forceAlphabetical = a.forceAlphabetical; }
            item = p.importFile(settings);
            if (!item || !finite(item.id)) { fail("After Effects did not return an imported project item"); }
            return { value: projectToolsItemSummary(item), reference: item };
        }, "item");
    register("team.layer.media.add", "Add an installed project footage item or precomp as a layer", true,
        { comp: "optional composition selector", item: "project item selector {id|name|ref}", name: "optional layer name", startTime: "optional seconds", inPoint: "optional seconds; supply with outPoint", outPoint: "optional seconds; supply with inPoint" }, function (a, refs) {
            selectors(a, refs, false); selector(a.item, "args.item", "item", refs);
            optional(a, "name", function (v, p) { text(v, p, 1024); });
            optional(a, "startTime", function (v, p) { number(v, p, -10800, 10800); });
            optional(a, "inPoint", function (v, p) { number(v, p, -10800, 10800); });
            optional(a, "outPoint", function (v, p) { number(v, p, -10800, 10800); });
            if (has(a, "inPoint") !== has(a, "outPoint") || (has(a, "inPoint") && a.inPoint >= a.outPoint)) { fail("Supply inPoint and outPoint together, with inPoint < outPoint"); }
        }, function (a, refs, entry) {
            var comp = resolved(a, refs, entry, false).comp, item = projectToolsResolveItem(a.item, refs), layer;
            if (projectToolsType(item) !== "footage" && !isComp(item)) { fail("Only footage or a composition can be added as a media layer"); }
            if (item === comp) { fail("A composition cannot contain itself"); }
            if (isComp(item)) { projectToolsCheckPrecompCycle(comp, item); }
            if (!comp.layers || typeof comp.layers.add !== "function") { fail("Composition media-layer API is unavailable"); }
            layer = comp.layers.add(item);
            if (has(a, "name")) { layer.name = a.name; }
            if (has(a, "startTime")) { layer.startTime = a.startTime; }
            if (has(a, "inPoint")) { layer.inPoint = a.inPoint; layer.outPoint = a.outPoint; }
            return { value: layerSummary(layer), reference: layer };
        }, "layer");
    register("team.project.open", "Open an existing .aep/.aepx as the current project; refuses to replace unsaved changes", true,
        { path: "absolute path to an existing .aep or .aepx file" }, function (a) {
            projectToolsPath(a.path, "args.path");
            if (!/\.aepx?$/i.test(a.path)) { fail("Project source must end in .aep or .aepx"); }
        }, function (a) {
            var destination = projectToolsFile(a.path, "args.path", false), current = app.project, opened;
            if (!destination.exists || destination.alias || destination.parent.alias) { fail("Project source is missing or aliased"); }
            if (current && current.renderQueue && current.renderQueue.rendering) { fail("Cannot open another project while rendering"); }
            if (current && current.file && projectToolsPathKey(current.file) === projectToolsPathKey(destination)) {
                return { opened: true, alreadyOpen: true, path: String(current.file.fsName || current.file.fullName) };
            }
            if (current && current.dirty !== false) { fail("Current project has unsaved changes or its saved state is unknown. Save it first; no project was closed"); }
            if (typeof app.open !== "function") { fail("After Effects project open API is unavailable"); }
            opened = app.open(destination);
            if (!opened || !opened.file || projectToolsPathKey(opened.file) !== projectToolsPathKey(destination)) { fail("After Effects did not confirm the opened project; inspect AE before another request"); }
            return { opened: true, alreadyOpen: false, path: String(opened.file.fsName || opened.file.fullName), numItems: opened.numItems };
        }, "", { undo: false, exclusive: true, nativeInputSchema: { type: "object", properties: { path: { type: "string", minLength: 1, maxLength: 4096 } }, required: ["path"], additionalProperties: false } });
    register("team.project.save", "Save the current project or an explicit destination; replacing another file requires overwrite:true", true,
        { path: "optional absolute .aep or .aepx path; omit to save the current project file", overwrite: "optional boolean; default false for a different existing destination" }, function (a) {
            optional(a, "path", projectToolsPath); optional(a, "overwrite", boolValue);
            if (has(a, "path") && !/\.aepx?$/i.test(a.path)) { fail("Project destination must end in .aep or .aepx"); }
        }, function (a) {
            var p = project(), destination = has(a, "path") ? projectToolsFile(a.path, "args.path", true) : p.file, current = p.file;
            if (!destination) { fail("The unsaved project requires an explicit args.path; no save dialog was opened"); }
            if (!destination.parent || !destination.parent.exists) { fail("Project destination folder does not exist"); }
            if (destination.exists && (!current || projectToolsPathKey(destination) !== projectToolsPathKey(current)) && a.overwrite !== true) { fail("Project destination already exists; set overwrite:true to replace it"); }
            if (typeof p.save !== "function") { fail("After Effects project save API is unavailable"); }
            if (has(a, "path")) { p.save(destination); } else { p.save(); }
            if (!p.file || !p.file.exists || projectToolsPathKey(p.file) !== projectToolsPathKey(destination)) { fail("After Effects did not confirm the requested project destination"); }
            return { saved: true, path: String(p.file.fsName || p.file.fullName) };
        }, "", { undo: false, exclusive: true });
    register("team.project.undo", "Request one native After Effects Undo command; call this tool by itself", true, {}, function () {}, function () {
        project(); if (typeof app.executeCommand !== "function") { fail("The After Effects menu-command API is unavailable"); }
        app.executeCommand(16);
        return { undoRequested: true, commandId: 16, verification: "native-command-dispatched" };
    }, "", { undo: false, exclusive: true });
    register("team.render.queue.add", "Queue one composition at an explicit output path using exact installed template names", true,
        { comp: "optional composition selector", outputPath: "absolute output path; existing files require overwrite:true", renderTemplate: "optional exact render-settings template name", outputTemplate: "optional exact output-module template name", overwrite: "optional boolean; default false" }, function (a, refs) {
            selectors(a, refs, false); projectToolsPath(a.outputPath, "args.outputPath");
            optional(a, "renderTemplate", function (v, p) { text(v, p, 1024); }); optional(a, "outputTemplate", function (v, p) { text(v, p, 1024); }); optional(a, "overwrite", boolValue);
        }, function (a, refs, entry) {
            var queue = projectToolsQueue(), comp = resolved(a, refs, entry, false).comp;
            var file = projectToolsFile(a.outputPath, "args.outputPath", true), item = null, output, actual, errorText;
            if (projectToolsOutputExists(file) && a.overwrite !== true) { fail("Render output already exists; set overwrite:true to replace it"); }
            projectToolsCheckQueueDestination(queue, file);
            try {
                item = queue.items.add(comp); if (!item) { fail("After Effects did not create a render-queue item"); }
                if (has(a, "renderTemplate")) { projectToolsTemplate(item.templates, a.renderTemplate, "Render settings"); item.applyTemplate(a.renderTemplate); }
                output = item.outputModule(1); if (!output) { fail("Render queue item has no output module"); }
                if (has(a, "outputTemplate")) { projectToolsTemplate(output.templates, a.outputTemplate, "Output module"); output.applyTemplate(a.outputTemplate); }
                output.file = file; actual = output.file;
                if (!actual || projectToolsPathKey(actual) !== projectToolsPathKey(file)) { fail("The output template changed the requested destination; specify its exact output path"); }
                if (projectToolsOutputExists(actual) && a.overwrite !== true) { fail("Render output already exists; set overwrite:true to replace it"); }
                item.render = true;
                projectToolsRenderApprovals.push({ item: item, path: projectToolsPathKey(actual), overwrite: a.overwrite === true });
                if (projectToolsRenderApprovals.length > 1000) { projectToolsRenderApprovals.shift(); }
                return { queueIndex: projectToolsQueueIndex(queue, item), comp: { id: comp.id, name: comp.name }, outputPath: String(actual.fsName || actual.fullName), status: projectToolsStatus(item.status),
                    renderTemplate: has(a, "renderTemplate") ? a.renderTemplate : null, outputTemplate: has(a, "outputTemplate") ? a.outputTemplate : null, overwriteAuthorized: a.overwrite === true };
            } catch (error) {
                errorText = String(error.message || error);
                if (item && typeof item.remove === "function") { try { item.remove(); } catch (cleanupError) { errorText += "; failed to remove the newly created queue item: " + String(cleanupError.message || cleanupError); } }
                fail(errorText);
            }
        });
    register("team.render.start", "Render the enabled queued items once and report their native final states; call this tool by itself", true, {}, function () {}, function () {
        var queue = projectToolsQueue(), selected = [], destinations = [], i, j, k, item, output, file, started, states = [], complete = true, renderError = null;
        if (typeof queue.render !== "function" || typeof RQItemStatus === "undefined") { fail("The native render API/status enumeration is unavailable"); }
        if (queue.numItems > 1000) { fail("Render queue exceeds the supported 1000-item inspection bound"); }
        for (i = 1; i <= queue.numItems; i += 1) {
            item = queue.item(i); if (!item || !item.render) { continue; }
            if (projectToolsStatus(item.status) !== "QUEUED") { fail("Enabled queue item " + i + " is not ready: " + projectToolsStatus(item.status)); }
            if (!isComp(item.comp)) { fail("Queue item " + i + " has no valid composition"); }
            if (!integer(item.numOutputModules) || item.numOutputModules < 1 || item.numOutputModules > 100) { fail("Queue item " + i + " has an invalid output-module count"); }
            for (j = 1; j <= item.numOutputModules; j += 1) {
                output = item.outputModule(j); file = output && output.file;
                if (!file || !file.parent || !file.parent.exists) { fail("Queue item " + i + " output " + j + " needs an existing destination folder"); }
                if (projectToolsOutputExists(file) && !projectToolsApproved(item, file)) { fail("Queue item " + i + " output exists without overwrite authorization; queue it explicitly with overwrite:true"); }
                for (k = 0; k < destinations.length; k += 1) {
                    if (projectToolsOutputsConflict(destinations[k].file, file)) { fail("Render destinations conflict between queue item " + destinations[k].queueIndex + " output " + destinations[k].moduleIndex + " and item " + i + " output " + j); }
                }
                destinations.push({ file: file, queueIndex: i, moduleIndex: j });
            }
            selected.push(item);
        }
        if (!selected.length) { fail("There are no enabled queued items to render"); }
        started = new Date().getTime();
        try { queue.render(); } catch (error) { renderError = String(error.message || error); }
        for (i = 0; i < selected.length; i += 1) {
            item = selected[i]; states.push({ queueIndex: projectToolsQueueIndex(queue, item), compId: item.comp.id, status: projectToolsStatus(item.status) });
            if (projectToolsStatus(item.status) !== "DONE") { complete = false; }
        }
        if (renderError || queue.rendering || !complete) { fail("Render did not complete all selected queue items" + (renderError ? ": " + renderError : "") + "; native final states: " + stringify(states)); }
        return { completed: true, elapsedMilliseconds: new Date().getTime() - started, items: states };
    }, "", { undo: false, exclusive: true });


/* Installed module: functions-inspection-tools.js */
/* ES3 fragment inserted inside the reusable-function registry. No CEP or AI code. */
    function inspectionShort(value, maximum) {
        return String(value === null || typeof value === "undefined" ? "" : value).substr(0, maximum || 1024);
    }
    function inspectionEffects(layer) {
        var group = layer && typeof layer.property === "function" ? layer.property("ADBE Effect Parade") : null;
        if (!group || typeof group.property !== "function") { fail("Selected layer has no effect group"); }
        return group;
    }
    function inspectionEffect(group, selection) {
        var count = Number(group.numProperties || 0), found = null, i, item;
        if (has(selection, "index")) {
            if (selection.index > count) { fail("Effect index does not exist: " + selection.index); }
            found = group.property(selection.index);
        } else {
            for (i = 1; i <= count; i += 1) {
                item = group.property(i);
                if (item && item.name === selection.name) {
                    if (found) { fail("Effect name is ambiguous; use its index: " + selection.name); }
                    found = item;
                }
            }
        }
        if (!found) { fail("Effect not found: " + stringify(selection)); }
        return found;
    }
    function inspectionValue(value, depth) {
        var out = [], i;
        depth = depth || 0;
        if (value === null || typeof value === "boolean" || finite(value)) { return value; }
        if (typeof value === "string") { return value.length > 2048 ? { text: value.substr(0, 2048), truncated: true } : value; }
        if (array(value) && depth < 3 && value.length <= 32) {
            for (i = 0; i < value.length; i += 1) { out.push(inspectionValue(value[i], depth + 1)); }
            return out;
        }
        return { unsupported: true };
    }
    register("team.effects.list", "Read registered AE effects directly without creating test layers; registration does not prove licensing", false,
        { search: "optional case-insensitive display name/matchName search", category: "optional exact case-insensitive category", maxItems: "optional integer 1..5000; default 200" }, function (a) {
            optional(a, "search", function (v, p) { text(v, p, 256, true); });
            optional(a, "category", function (v, p) { text(v, p, 256, true); });
            optional(a, "maxItems", function (v, p) { whole(v, p, 1, 5000); });
        }, function (a) {
            var registered, out = [], matched = 0, i, effect, item, search = String(a.search || "").toLowerCase(), category = String(a.category || "").toLowerCase(), limit = a.maxItems || 200;
            if (typeof app === "undefined" || !app.effects) { fail("After Effects does not expose registered effect metadata"); }
            registered = app.effects;
            for (i = 0; i < registered.length; i += 1) {
                effect = registered[i]; if (!effect) { continue; }
                item = { displayName: inspectionShort(effect.displayName), matchName: inspectionShort(effect.matchName), category: inspectionShort(effect.category), version: inspectionShort(effect.version, 128) };
                if (search && (item.displayName + " " + item.matchName).toLowerCase().indexOf(search) < 0) { continue; }
                if (category && item.category.toLowerCase() !== category) { continue; }
                matched += 1; if (out.length < limit) { out.push(item); }
            }
            return { registeredCount: registered.length, matchedCount: matched, effects: out, truncated: matched > out.length, runtimeLicenseVerified: false };
        });
    register("team.effect.inspect", "Read applied effects and bounded nested property values without changing layers", false,
        { comp: "optional comp selector", layer: "layer selector", maxProperties: "optional integer 1..5000 total effect/property nodes; default 200" }, function (a, refs) {
            selectors(a, refs, true); optional(a, "maxProperties", function (v, p) { whole(v, p, 1, 5000); });
        }, function (a, refs, entry) {
            var target = resolved(a, refs, entry, true), group = inspectionEffects(target.layer), count = Number(group.numProperties || 0), out = [], i, effect, item, used = 0, truncated = false, limit = a.maxProperties || 200;
            function children(parent, path, depth) {
                var values = [], total = Number(parent.numProperties || 0), j, property, result, nextPath;
                if (depth > 8) { if (total) { truncated = true; } return values; }
                for (j = 1; j <= total; j += 1) {
                    if (used >= limit) { truncated = true; break; }
                    property = parent.property(j); if (!property) { continue; }
                    used += 1; nextPath = path.concat([j]);
                    result = { index: j, path: nextPath, name: inspectionShort(property.name), matchName: inspectionShort(property.matchName), numProperties: Number(property.numProperties || 0), numKeys: Number(property.numKeys || 0) };
                    if (result.numProperties > 0 && typeof property.property === "function") { result.properties = children(property, nextPath, depth + 1); }
                    else {
                        try { result.value = inspectionValue(property.value); }
                        catch (valueError) { result.valueUnavailable = true; result.error = inspectionShort(valueError.message || valueError, 240); }
                        if (property.canSetExpression) {
                            result.expressionEnabled = !!property.expressionEnabled;
                            result.expression = inspectionShort(property.expression, 2048);
                            result.expressionError = inspectionShort(property.expressionError, 240);
                        }
                    }
                    values.push(result);
                }
                return values;
            }
            for (i = 1; i <= count; i += 1) {
                if (used >= limit) { truncated = true; break; }
                effect = group.property(i); if (!effect) { continue; }
                used += 1;
                item = { index: i, name: inspectionShort(effect.name), matchName: inspectionShort(effect.matchName), enabled: typeof effect.enabled === "boolean" ? effect.enabled : null, numProperties: Number(effect.numProperties || 0), properties: children(effect, ["ADBE Effect Parade", i], 0) };
                out.push(item);
            }
            return { compId: target.comp.id, layerIndex: target.layer.index, effectCount: count, returnedNodes: used, effects: out, truncated: truncated };
        });
    register("team.effect.remove", "Remove exactly one applied effect selected by unambiguous instance name or index", true,
        { comp: "optional comp selector", layer: "layer selector", effect: "exact selector: {index:positive integer} or {name:exact instance name}" }, function (a, refs) {
            var names;
            selectors(a, refs, true); exact(a.effect, "index|name", "args.effect"); names = keys(a.effect);
            if (names.length !== 1) { fail("args.effect must select by exactly one field"); }
            if (has(a.effect, "index")) { whole(a.effect.index, "args.effect.index", 1); }
            if (has(a.effect, "name")) { text(a.effect.name, "args.effect.name", 1024); }
        }, function (a, refs, entry) {
            var target = resolved(a, refs, entry, true), group, effect, result;
            if (target.layer.locked) { fail("Layer is locked; unlock it explicitly before removing an effect"); }
            group = inspectionEffects(target.layer); effect = inspectionEffect(group, a.effect);
            if (typeof effect.remove !== "function") { fail("Selected effect cannot be removed"); }
            result = { compId: target.comp.id, layerIndex: target.layer.index, index: effect.propertyIndex, name: inspectionShort(effect.name), matchName: inspectionShort(effect.matchName), removed: true };
            effect.remove(); return result;
        });

    function inspectionFolder(path, create) {
        var folder = new Folder(path);
        if (folder.alias) { fail("Inspection folders must not be aliases: " + path); }
        if (!folder.exists && (!create || !folder.create())) { fail("Inspection folder is unavailable: " + path + "; " + folder.error); }
        return folder;
    }
    function inspectionPng(path) {
        var file = new File(path), bytes, width, height;
        if (!file.exists || file.length < 33 || file.length > 104857600) { fail("Inspection PNG is missing, incomplete or exceeds 100 MiB"); }
        if (file.alias) { fail("Inspection output must not be an alias"); }
        file.encoding = "BINARY";
        if (!file.open("r")) { fail("Cannot read inspection PNG: " + file.error); }
        try { bytes = file.read(33); } finally { file.close(); }
        if (bytes.length !== 33 || bytes.substr(0, 8) !== "\x89PNG\r\n\x1a\n" || bytes.substr(12, 4) !== "IHDR") { fail("Inspection PNG has an invalid signature or IHDR header"); }
        width = bytes.charCodeAt(16) * 16777216 + bytes.charCodeAt(17) * 65536 + bytes.charCodeAt(18) * 256 + bytes.charCodeAt(19);
        height = bytes.charCodeAt(20) * 16777216 + bytes.charCodeAt(21) * 65536 + bytes.charCodeAt(22) * 256 + bytes.charCodeAt(23);
        if (!width || !height || width > 16384 || height > 16384 || width * height > 100000000) { fail("Inspection PNG dimensions exceed technical-review limits"); }
        return { width: width, height: height, bitDepth: bytes.charCodeAt(24), colorType: bytes.charCodeAt(25), byteLength: file.length, pngSignatureValid: true };
    }
    function inspectionAwaitPng(path) {
        var started = new Date().getTime(), file;
        while (new Date().getTime() - started < 5000) {
            file = new File(path);
            if (file.exists && file.length >= 33) { return inspectionPng(path); }
            if (typeof $.sleep !== "function") { break; }
            $.sleep(50);
        }
        fail("After Effects did not publish an inspection PNG within 5000 ms");
    }
    register("team.inspection.capture", "Export the current frame by default, or up to 3 sampled frames; at most one capture call per request to limit preview rendering; does not save or import project data", false,
        { comp: "optional comp selector", times: "optional 1..3 explicit seconds in valid frame range; cannot combine with numFrames", numFrames: "optional integer 1..3 evenly sampled frames; default captures only the current time" }, function (a, refs) {
            var i;
            selectors(a, refs, false);
            if (has(a, "times") && has(a, "numFrames")) { fail("Use args.times or args.numFrames, not both"); }
            if (has(a, "times")) {
                if (!array(a.times) || !a.times.length || a.times.length > 3) { fail("args.times must contain 1 to 3 numeric times"); }
                for (i = 0; i < a.times.length; i += 1) { number(a.times[i], "args.times[" + i + "]", 0, 10800); }
            }
            optional(a, "numFrames", function (v, p) { whole(v, p, 1, 3); });
        }, function (a, refs, entry) {
            var comp = resolved(a, refs, entry, false).comp, context = entry && entry.context, root, runFolder, relativeRoot, maximumTime, frameDuration, times = [], count, i, time, filename, file, metadata, frames = [], manifest, temporary, destination, published;
            if (!context || context.schema !== "aect-context/v1" || !/^[A-Za-z0-9-]{8,80}$/.test(context.runId || "")) { fail("inspection.capture requires a valid AE_CodexTeam Bridge run context"); }
            root = String(context.workspaceRoot || "").replace(/\\/g, "/").replace(/\/$/, "");
            if (!/^(?:[A-Za-z]:\/|\/)/.test(root) || /(?:^|\/)\.{1,2}(?:\/|$)|\x00/.test(root)) { fail("Bridge inspection workspace root must be an absolute path without traversal"); }
            inspectionFolder(root, false);
            if (typeof comp.saveFrameToPng !== "function") { fail("This AE version does not expose CompItem.saveFrameToPng"); }
            number(comp.duration, "composition duration", 0.000001);
            frameDuration = finite(comp.frameDuration) && comp.frameDuration > 0 ? comp.frameDuration : 1 / comp.frameRate;
            number(frameDuration, "composition frame duration", 0.000001);
            maximumTime = Math.max(0, comp.duration - frameDuration);
            if (has(a, "times")) { for (i = 0; i < a.times.length; i += 1) { time = a.times[i]; number(time, "args.times[" + i + "]", 0, maximumTime); times.push(time); } }
            else if (has(a, "numFrames")) {
                count = a.numFrames;
                for (i = 0; i < count; i += 1) { times.push(count === 1 ? 0 : maximumTime * i / (count - 1)); }
            } else { number(comp.time, "composition viewer time"); times.push(Math.max(0, Math.min(comp.time, maximumTime))); }
            if (comp.width > 16384 || comp.height > 16384 || comp.width * comp.height > 100000000) { fail("Composition dimensions exceed inspection technical-review limits"); }
            inspectionFolder(root + "/.ae-codex", true); inspectionFolder(root + "/.ae-codex/inspection", true);
            relativeRoot = ".ae-codex/inspection/" + context.runId;
            runFolder = new Folder(root + "/" + relativeRoot);
            if (runFolder.exists || runFolder.alias) { fail("Inspection output already exists for this run ID; refusing to overwrite"); }
            runFolder = inspectionFolder(root + "/" + relativeRoot, true);
            for (i = 0; i < times.length; i += 1) {
                filename = i === 0 ? "frame.png" : "frame-" + ("00" + (i + 1)).slice(-3) + ".png";
                file = new File(runFolder.fsName + "/" + filename);
                if (file.exists || file.alias) { fail("Inspection frame already exists; refusing to overwrite"); }
                comp.saveFrameToPng(times[i], file); metadata = inspectionAwaitPng(file.fsName);
                metadata.frameRelativePath = relativeRoot + "/" + filename; metadata.timeSeconds = times[i];
                metadata.visualVerified = false; metadata.visualReviewState = "pending"; frames.push(metadata);
                safeNotify(context, "log", ["Captured inspection frame " + (i + 1) + "/" + times.length]);
            }
            manifest = { schema: "aect-inspection/v1", state: "captured", runId: context.runId, frameRelativePath: frames[0].frameRelativePath,
                manifestRelativePath: relativeRoot + "/manifest.json", compositionName: inspectionShort(comp.name), compositionWidth: comp.width, compositionHeight: comp.height,
                frameWidth: frames[0].width, frameHeight: frames[0].height, bitDepth: frames[0].bitDepth, colorType: frames[0].colorType,
                timeSeconds: frames[0].timeSeconds, byteLength: frames[0].byteLength, pngSignatureValid: true, visualVerified: false,
                visualReviewState: "pending", fallbackErrorCode: "", retention: "manual", createdAtEpochMs: new Date().getTime(), frames: frames,
                nextAction: "open_frame_with_view_image" };
            destination = new File(runFolder.fsName + "/manifest.json"); temporary = new File(runFolder.fsName + "/manifest.json.tmp");
            if (destination.exists || temporary.exists || destination.alias || temporary.alias) { fail("Inspection manifest already exists; refusing to overwrite"); }
            temporary.encoding = "UTF-8";
            if (!temporary.open("w")) { fail("Cannot create inspection manifest: " + temporary.error); }
            try { published = temporary.write(stringify(manifest)); if (published === false) { fail("Cannot write inspection manifest: " + temporary.error); } }
            finally { temporary.close(); }
            if (!temporary.rename(destination.name)) { fail("Cannot publish inspection manifest: " + temporary.error); }
            return manifest;
        });

    register("team.script.run", "Maintenance only: call an archived project-specific JSX branch", true, { branch: "exact archived branch name, including .jsx" }, function (a) {
        var bundle = $.global.__aectBundleV1, i, found = false;
        text(a.branch, "args.branch", 256);
        if (!/^[A-Za-z0-9 _.-]+\.jsx$/.test(a.branch) || a.branch.indexOf("..") >= 0) { fail("Invalid installed branch name"); }
        if (!bundle || !bundle.names) { fail("Installed script bundle is unavailable"); }
        for (i = 0; i < bundle.names.length; i += 1) { if (bundle.names[i] === a.branch) { found = true; break; } }
        if (!found) { fail("Installed branch does not exist: " + a.branch); }
    }, function (a) { var result = $.global.__aectBundleV1.run(a.branch); return { branch: a.branch, result: typeof result === "undefined" ? null : (typeof result === "object" ? dataValue(result) : result) }; });

    register("team.comp.seek", "Set the composition viewer time for preview inspection", true, { comp: "optional comp selector", time: "composition time in seconds" }, function (a, refs) {
        selectors(a, refs, false); number(a.time,"args.time",0,10800);
    }, function (a, refs, entry) {
        var c=resolved(a,refs,entry,false).comp;
        if(a.time>=c.duration)fail("Preview time must be before composition end");
        c.time=a.time;c.openInViewer();return compSummary(c);
    });
    function validate(request) {
        var refs = {}, i, step, definition, allowed, captureCalls = 0;
        exact(request, "schema|steps", "request");
        if (request.schema !== SCHEMA) { fail("request.schema must be " + SCHEMA); }
        if (!array(request.steps) || !request.steps.length || request.steps.length > 100) { fail("request.steps must contain 1 to 100 calls"); }
        /* Also reject inherited/prototype data and unsupported values for direct API callers. */
        if (stringify(request).length > MAX_TEXT) { fail("Request data exceeds the text limit"); }
        for (i = 0; i < request.steps.length; i += 1) {
            step = request.steps[i]; exact(step, "function|args|as", "steps[" + i + "]");
            text(step["function"], "steps[" + i + "].function", 128);
            if (!has(definitions, step["function"])) { fail("Unknown installed function: " + step["function"]); }
            definition = definitions[step["function"]]; allowed = keys(definition.args).join("|");
            if (definition.options.exclusive && request.steps.length !== 1) { fail(definition.name + " must be called alone, outside an edit plan"); }
            exact(step.args, allowed, "steps[" + i + "].args"); definition.check(step.args, refs);
            if (definition.name === "team.inspection.capture") {
                captureCalls += 1;
                if (captureCalls > 1) { fail("Only one inspection.capture call is allowed per request; capture at most 3 frames in that call"); }
            }
            if (has(step, "as")) {
                if (!definition.resultKind) { fail("This function does not create a reference: " + definition.name); }
                text(step.as, "steps[" + i + "].as", 64);
                if (!/^[A-Za-z][A-Za-z0-9_-]*$/.test(step.as) || forbidden(step.as) || has(refs, step.as)) { fail("Invalid or duplicate step.as label: " + step.as); }
                refs[step.as] = definition.resultKind;
            }
        }
        return { valid: true, schema: SCHEMA, steps: request.steps.length };
    }
    function preflight(request) {
        var out = [], i, step, a, entry, definition, dynamicComp, dynamicLayer, property, j, priorMutation = false;
        for (i = 0; i < request.steps.length; i += 1) {
            step = request.steps[i]; a = step.args; definition = definitions[step["function"]]; entry = { step: step, definition: definition };
            if (definition.name === "team.app.memory") { memoryPreflight(a); }
            dynamicComp = a.comp && has(a.comp, "ref"); dynamicLayer = a.layer && has(a.layer, "ref");
            if (definition.name === "team.project.inspect" || definition.name === "team.comp.create") { project(); }
            if (has(definition.args, "comp") && !dynamicComp) {
                entry.comp = resolveComp(a, {});
                if (a.layers) {
                    entry.layers = [];
                    for (j = 0; j < a.layers.length; j += 1) { entry.layers.push(has(a.layers[j], "ref") ? null : resolveLayer(entry.comp, a.layers[j], {})); }
                }
                if (a.layer && !dynamicLayer) {
                    entry.layer = resolveLayer(entry.comp, a.layer, {});
                    if (a.path && !priorMutation) {
                        property = resolveProperty(entry.layer, a.path);
                        if ((definition.name === "team.property.set" || definition.name === "team.property.keyframes") && typeof property.setValue !== "function") { fail("Selected property cannot be assigned a value"); }
                        if (definition.name === "team.property.set" && !has(a, "time") && property.numKeys > 0) { fail("Property has keyframes; supply args.time or use property.keyframes"); }
                        if ((definition.name === "team.property.keyframes" || (definition.name === "team.property.set" && has(a, "time"))) && !property.canVaryOverTime) { fail("Selected property cannot be keyframed"); }
                        if (definition.name === "team.property.expression" && !property.canSetExpression) { fail("Selected property does not support expressions"); }
                    }
                    if (definition.name === "team.effect.add") { property = resolveProperty(entry.layer, ["ADBE Effect Parade"]); if (!property.canAddProperty(a.matchName)) { fail("Effect is unavailable for this layer: " + a.matchName); } }
                    if (definition.name === "team.layer.update" && !priorMutation) { checkLayerUpdate(entry.layer, a); }
                    if (definition.name === "team.layer.inspect" && a.properties && !priorMutation) { for (j = 0; j < a.properties.length; j += 1) { resolveProperty(entry.layer, a.properties[j]); } }
                }
            }
            out.push(entry); if (definition.mutates) { priorMutation = true; }
        }
        return out;
    }
    function safeNotify(context, method, args) {
        try { if (context && typeof context[method] === "function") { context[method].apply(context, args); } } catch (ignoreLogError) {}
    }
    function run(request, context) {
        var plan, refs = {}, out = [], i, entry, step, result, wrapped, mutates = false, undoOpen = false, error;
        if (typeof request === "string") { request = parse(request); }
        validate(request); plan = preflight(request);
        for (i = 0; i < plan.length; i += 1) { if (plan[i].definition.mutates && plan[i].definition.options.undo !== false) { mutates = true; } }
        try {
            if (mutates) { app.beginUndoGroup("Codex reusable functions"); undoOpen = true; }
            for (i = 0; i < plan.length; i += 1) {
                entry = plan[i]; step = entry.step;
                entry.context = context || $.global.__AECT_RUN_CONTEXT__ || null;
                safeNotify(context, "progress", [Math.floor(i * 100 / plan.length), "Step " + (i + 1) + "/" + plan.length + ": " + entry.definition.name]);
                try {
                    result = entry.definition.execute(step.args, refs, entry);
                    if (entry.definition.resultKind) { if (step.as) { refs[step.as] = result.reference; } result = result.value; }
                    wrapped = { "function": entry.definition.name, value: result }; if (step.as) { wrapped.as = step.as; } out.push(wrapped);
                } catch (stepError) {
                    error = new Error("Step " + (i + 1) + "/" + plan.length + " (" + entry.definition.name + ") failed after " + out.length + " completed step(s): " + String(stepError.message || stepError));
                    error.stepIndex = i; error.completedSteps = out.length; error.functionName = entry.definition.name;
                    safeNotify(context, "log", [error.message, "error"]); throw error;
                }
            }
            safeNotify(context, "progress", [100, "Completed " + plan.length + " reusable function(s)"]);
            return { schema: "aect-functions-result/v1", count: out.length, results: out };
        } finally { if (undoOpen) { app.endUndoGroup(); } }
    }
    $.global.__aectFunctionsV1 = { version: VERSION, schema: SCHEMA, list: list, parse: parse, stringify: stringify, validate: validate, run: run };
}());


/*
 * AE_CodexTeam Bridge
 *
 * Run this file once per After Effects session with:
 * File > Scripts > Run Script File...
 *
 * The bridge polls a local workspace inbox. It never evaluates request text;
 * it only loads reviewed bundle branches or direct .jsx files in jsx/.
 */
(function (thisObject) {
    // Direct-run fallback can load the dispatcher without creating/stopping a panel.
    if ($.global.__AECT_BUNDLE_ONLY__) { return; }
    if ($.global.__AECT_PANEL_HOST__ instanceof Panel) {
        thisObject = $.global.__AECT_PANEL_HOST__;
    }
    var GLOBAL_NAME = "__aeCodexTeamBridgeV1";
    var BRIDGE_VERSION = "1.0.0";
    function workspaceRoot() {
        var configured = $.global.__AECT_WORKSPACE_ROOT__, script;
        if (typeof configured === "string" && configured.replace(/^\s+|\s+$/g, "")) {
            return (new Folder(configured)).fsName.replace(/\\/g, "/").replace(/\/$/, "");
        }
        script = new File($.fileName);
        if (String(script.parent.name).toLowerCase() !== "jsx") {
            throw new Error("Open Codex Bridge through its installed loader or the workspace jsx folder.");
        }
        return script.parent.parent.fsName.replace(/\\/g, "/").replace(/\/$/, "");
    }
    var WORKSPACE_ROOT = workspaceRoot();
    $.global.__aectRunSwitch = function () {
        var g = $.global, pending = g.__aectPendingSwitch, keys = ["__AECT_WORKSPACE_ROOT__", "__AECT_PANEL_HOST__", "__AECT_AUTOSTART_ONLY__"], saved = {}, i;
        delete g.__aectPendingSwitch;
        if (!pending) { return; }
        for (i = 0; i < keys.length; i += 1) { saved[keys[i]] = { had: g.hasOwnProperty(keys[i]), value: g[keys[i]] }; }
        try {
            g.__AECT_WORKSPACE_ROOT__ = pending.root; g.__AECT_PANEL_HOST__ = pending.host; g.__AECT_AUTOSTART_ONLY__ = false;
            $.evalFile(new File(pending.root + "/jsx/AECT Engine.jsx"));
        } catch (switchError) {
            try { $.writeln("AE_CodexTeam update failed: " + switchError); } catch (switchLogError) {}
        } finally {
            for (i = 0; i < keys.length; i += 1) { if (saved[keys[i]].had) { g[keys[i]] = saved[keys[i]].value; } else { delete g[keys[i]]; } }
        }
    };
    var existingBridge = $.global[GLOBAL_NAME];
    var preserveReplacementStop = false;
    if (!existingBridge && thisObject instanceof Panel) {
        try {
            var anchoredBridge = thisObject.__aeCodexTeamBridgeOwnerV1;
            if (anchoredBridge) {
                if (anchoredBridge.window !== thisObject || !anchoredBridge.ui ||
                        normalizePath(anchoredBridge.workspaceRoot) !== normalizePath(WORKSPACE_ROOT)) {
                    refuseAnchoredPanel(anchoredBridge, "Panel này thuộc một cầu nối khác. Đóng panel cũ trước khi mở bản cài đặt này.");
                    return;
                }
                if (anchoredBridge.version !== BRIDGE_VERSION && (anchoredBridge.busy || anchoredBridge.pendingReport ||
                        anchoredBridge.pendingCleanupFile || anchoredBridge.scheduledCallbackActive || anchoredBridge.connectionActionActive)) {
                    refuseAnchoredPanel(anchoredBridge, "Chưa thể thay cầu nối cũ: còn thao tác hoặc kết quả chưa xác nhận. Không chạy lại lệnh.");
                    return;
                }
                existingBridge = anchoredBridge;
                if (anchoredBridge.version === BRIDGE_VERSION) { $.global[GLOBAL_NAME] = anchoredBridge; }
                else { preserveReplacementStop = anchoredBridge.manualStop === true ||
                    (!anchoredBridge.running && anchoredBridge.lastStatus === "Bridge stopped"); }
            }
        } catch (missingHostAnchorError) {
            try { $.writeln("Codex AE cannot read the existing panel owner; close and reopen the panel."); } catch (anchorLogError) {}
            return;
        }
    }
    var autoStartOnly = !!$.global.__AECT_AUTOSTART_ONLY__;
    var sameWorkspace = existingBridge && normalizePath(existingBridge.workspaceRoot) === normalizePath(WORKSPACE_ROOT);
    if (autoStartOnly && existingBridge && existingBridge.version === BRIDGE_VERSION && sameWorkspace) {
        // A Startup loader must not duplicate a listener or override manual Stop.
        return;
    }
    if (!autoStartOnly && existingBridge && existingBridge.version === BRIDGE_VERSION && sameWorkspace &&
            existingBridge.window && existingBridge.ui) {
        try {
            // Reusing a live view preserves Stop and never duplicates controls.
            if ((existingBridge.window === thisObject ||
                    (!(thisObject instanceof Panel) && existingBridge.window instanceof Window)) &&
                    typeof existingBridge.window.visible === "boolean" && typeof existingBridge.statusText.text === "string") {
                if (rewireUiActions(existingBridge)) {
                    existingBridge.showWindow();
                    if (existingBridge.window && existingBridge.ui) { return; }
                }
            }
        } catch (staleWindowError) { /* Disposed native controls are replaced below. */ }
    }

    function trim(value) {
        return String(value).replace(/^\s+|\s+$/g, "");
    }

    function normalizePath(value) {
        return String(value).replace(/\\/g, "/").toLowerCase();
    }

    function jsonEscape(value) {
        var input = String(value);
        var output = "";
        var index;

        for (index = 0; index < input.length; index += 1) {
            var character = input.charAt(index);
            var code = input.charCodeAt(index);
            var hex;

            if (character === "\\") {
                output += "\\\\";
            } else if (character === "\"") {
                output += "\\\"";
            } else if (character === "\b") {
                output += "\\b";
            } else if (character === "\f") {
                output += "\\f";
            } else if (character === "\n") {
                output += "\\n";
            } else if (character === "\r") {
                output += "\\r";
            } else if (character === "\t") {
                output += "\\t";
            } else if (code < 32) {
                hex = code.toString(16);
                while (hex.length < 4) {
                    hex = "0" + hex;
                }
                output += "\\u" + hex;
            } else {
                output += character;
            }
        }

        return output;
    }

    function Bridge(workspaceRoot) {
        this.version = BRIDGE_VERSION;
        this.workspaceRoot = workspaceRoot;
        this.bridgeRoot = workspaceRoot + "/.ae-codex/bridge";
        this.inboxPath = this.bridgeRoot + "/inbox";
        this.resultsPath = this.bridgeRoot + "/results";
        this.heartbeatPath = this.bridgeRoot + "/heartbeat.json";
        this.running = false;
        this.ready = false;
        this.busy = false;
        this.taskId = 0;
        this.taskToken = 0;
        this.taskDueAt = 0;
        this.scheduledCallbackActive = false;
        this.connectionActionActive = false;
        this.connectionRecoveryPending = false;
        this.manualStop = false;
        this.startupStep = 0;
        this.generation = 0;
        this.lastHeartbeat = 0;
        this.lastStatus = "Đang khởi động cầu nối…";
        this.progressValue = 0;
        this.progressLabel = "Đang tải";
        this.hideProgressPending = false;
        this.pendingReport = null;
        this.pendingCleanupFile = null;
        this.sessionNonce = String(new Date().getTime()) + "-" +
            Math.floor(Math.random() * 2147483647).toString(16);
        this.window = null;
        this.statusText = null;
        this.connectionText = null;
        this.connectionConnected = false;
        this.progressGroup = null;
        this.progressText = null;
        this.progressBar = null;
        this.library = null;
        this.libraryText = null;
        this.libraryControls = null;
        this.libraryDisplayValue = "";
        this.bundle = $.global.__aectBundleV1;
        this.functions = $.global.__aectFunctionsV1;
        this.scriptsText = null;
        this.logs = [];
        this.logRevision = 0;
        this.logViewRevision = -1;
        this.logEntries = this.logs;
        this.logView = null;
        this.logNotices = {};
        this.logWriteError = "";
        this.ui = null;
        this.hadUi = false;
        this.ownedUiRoots = [];
        this.connectionPens = null;
        this.connectionUiColor = null;
    }

    function setControl(control, key, value) {
        if (control && control[key] !== value) { control[key] = value; }
    }
    function refuseAnchoredPanel(owner, message) {
        try {
            owner.lastStatus = String(message); owner.connectionConnected = false;
            if (owner.statusText) { setControl(owner.statusText, "text", message); }
            if (owner.connectionText) { setControl(owner.connectionText, "text", "Chưa kết nối · " + message); }
        } catch (anchorStatusError) {}
    }
    function rewireUiActions(owner) {
        var ui = owner && owner.ui, palette = owner && owner.window, records = ui && ui.actions, i;
        if (!ui || !palette || !records || !records.length || records.length > 16) { return false; }
        function bind(record) {
            record.handler = function actionHandler() {
                var action = record.action, selectedValue;
                if (record.handler !== actionHandler || owner.ui !== ui || owner.window !== palette) { return; }
                if (action === "effects" || action === "sfx") { selectedValue = !!record.control.value; }
                if (action === "start") { owner.reconnect(); return; }
                if (!owner.ensureListenerOwner("button " + action, true)) { return; }
                if (action === "stop") { owner.stop(); return; }
                owner.refreshConnectionHealth(); owner.recoverScheduled("button " + action);
                if (action === "effects" || action === "sfx") { owner.setLibraryEnabled(action, selectedValue); }
                else if (action === "folders") { owner.showSfxFolders(); }
                else if (action === "refresh") { owner.requestLibraryRefresh(); }
                else if (action === "functions") { owner.showFunctions(); }
                else if (action === "scripts") { owner.showScripts(); }
                else if (action === "clearLog") { owner.clearLog(); }
                else if (action === "qa") { owner.sendQa(); }
                else if (action === "toggleLog") { ui.logExpanded = !ui.logExpanded; owner.reflowUi(true); }
            };
            record.control.onClick = record.handler;
        }
        try {
            for (i = 0; i < records.length; i += 1) { bind(records[i]); }
            ui.activityHandler = function activityHandler() {
                if (ui.activityHandler === activityHandler && owner.ui === ui && owner.window === palette) { owner.reflowUi(true); }
            };
            palette.onActivate = palette.onResizing = palette.onResize = ui.activityHandler;
            if (ui.layoutManager) { ui.layoutManager.layout = ui.activityHandler; ui.layoutManager.resize = ui.activityHandler; }
            if (palette instanceof Window) {
                ui.closeHandler = function closeHandler() {
                    if (ui.closeHandler !== closeHandler || owner.ui !== ui || owner.window !== palette) { return true; }
                    if (!owner.ensureListenerOwner("panel close", false)) { releaseBridgeUi(owner); return true; }
                    owner.stop(); releaseBridgeUi(owner); $.global[GLOBAL_NAME] = null; return true;
                };
                palette.onClose = ui.closeHandler;
            }
            return true;
        } catch (disposedBindingError) { releaseBridgeUi(owner); return false; }
    }
    function releaseBridgeUi(owner) {
        var legacy = owner && owner.chat, previousUi = legacy && legacy.ui,
            window = owner && owner.window, roots = owner && owner.ownedUiRoots || [],
            stack = [], node, children, record, i, j, visited = 0,
            events = ["onDraw", "onClick", "onChange", "onChanging", "onActivate", "onDoubleClick"];
        if (!owner) { return; }
        if (owner.ui && owner.ui.actions) {
            for (i = 0; i < owner.ui.actions.length; i += 1) {
                record = owner.ui.actions[i];
                try { if (record.control && record.control.onClick === record.handler) { record.control.onClick = null; } } catch (disposedActionError) {}
                record.handler = null; record.control = null;
            }
            owner.ui.actions = []; owner.ui.activityHandler = owner.ui.closeHandler = null;
        }
        try {
            if (window && owner.ui && owner.ui.layoutManager && window.layout === owner.ui.layoutManager) {
                window.layout = owner.ui.nativeLayout;
            }
        } catch (disposedLayoutError) {}
        // Compatibility cleanup only. A new controller has no embedded chat.
        // The old controller's Stop runs before its idle resources are released.
        if (legacy) {
            for (i = 0; previousUi && previousUi.nativeListeners && i < previousUi.nativeListeners.length; i += 1) {
                record = previousUi.nativeListeners[i];
                try { record.control.removeEventListener(record.type, record.handler); } catch (listenerReleaseError) {}
            }
            legacy.ui = null; legacy.state = null; legacy.pending = null;
            legacy.chatPaint = null; legacy.chatTextWidths = null;
            legacy.previewWanted = null; legacy.previewCache = {}; legacy.previewOrder = [];
            legacy.transcriptMessages = []; legacy.transcriptMedia = [];
            legacy.transcriptRows = []; legacy.transcriptCommands = [];
            owner.chat = null;
        }
        for (i = 0; i < roots.length; i += 1) { stack.push(roots[i]); }
        while (stack.length && visited < 512) {
            node = stack.pop(); visited += 1;
            try {
                children = node.children || [];
                for (i = 0; i < children.length; i += 1) { stack.push(children[i]); }
                for (j = 0; j < events.length; j += 1) { if (typeof node[events[j]] === "function") { node[events[j]] = null; } }
            } catch (disposedControlError) {}
        }
        try {
            if (window) {
                try { if (window.__aeCodexTeamBridgeOwnerV1 === owner) { delete window.__aeCodexTeamBridgeOwnerV1; } } catch (anchorReleaseError) {}
                window.onClose = window.onResize = window.onResizing = window.onActivate = null;
                if (window instanceof Window) { window.close(); }
                else {
                    // AE owns the dock. Remove only this plugin's recorded roots.
                    for (i = 0; i < roots.length; i += 1) {
                        try { window.remove(roots[i]); } catch (disposedRootError) {}
                    }
                }
            }
        } catch (disposedWindowError) {}
        owner.ui = null; owner.ownedUiRoots = []; owner.connectionPens = null; owner.connectionUiColor = null;
        owner.window = owner.statusText = owner.connectionText = null;
        owner.progressGroup = owner.progressText = owner.progressBar = null;
        owner.libraryText = owner.scriptsText = owner.logView = owner.logSummary = null;
        owner.libraryControls = null;
    }

    Bridge.prototype.refreshLog = function () {
        var lines, i, entry;
        try {
            if (!this.logView) { return; }
            if (this.logSummary) {
                entry = this.logs.length ? this.logs[this.logs.length - 1] : null;
                setControl(this.logSummary, "text", entry ? (entry.level === "error" ? "Lỗi: " : "") + entry.message.substring(0, 180) : "Sẵn sàng");
                setControl(this.logSummary, "helpTip", entry ? entry.message : "Mở Nhật ký để xem tiến trình và lỗi.");
            }
            // Keep entries and the persistent log while collapsed, without
            // rebuilding an invisible 200-line native text buffer on each event.
            if (!this.ui || !this.ui.logVisible || this.logViewRevision === this.logRevision) { return; }
            lines = [];
            for (i = 0; i < this.logs.length; i += 1) {
                entry = this.logs[i];
                lines.push(entry.time + " [" + entry.level.toUpperCase() + "] " +
                    (entry.runId ? entry.runId + " | " : "") +
                    (typeof entry.percent === "number" ? entry.percent + "% | " : "") + entry.message);
            }
            setControl(this.logView, "text", lines.join("\n"));
            setControl(this.logView, "helpTip", this.logWriteError || "200 sự kiện gần nhất. Nhật ký: .ae-codex/bridge/logs/events.log");
            this.logViewRevision = this.logRevision;
            if (this.window && this.window.update) { this.window.update(); }
        } catch (logUiError) { releaseBridgeUi(this); }
    };

    Bridge.prototype.persistLog = function (entry) {
        var file = null, previous, opened = false;
        try {
            if (!(new Folder(this.workspaceRoot)).exists) { throw new Error("Workspace unavailable"); }
            this.ensureFolders();
            this.ensureFolder(this.bridgeRoot + "/logs");
            file = new File(this.bridgeRoot + "/logs/events.log");
            if (file.exists && file.length >= 262144) {
                previous = new File(this.bridgeRoot + "/logs/previous.log");
                if (previous.exists && !previous.remove()) { throw new Error(previous.error); }
                if (!file.rename("previous.log")) { throw new Error(file.error); }
                file = new File(this.bridgeRoot + "/logs/events.log");
            }
            file.encoding = "UTF-8";
            if (!file.open("a")) { throw new Error(file.error); }
            opened = true;
            if (!file.write("{\"time\":\"" + jsonEscape(entry.time) + "\",\"epochMs\":" + entry.epochMs +
                    ",\"level\":\"" + jsonEscape(entry.level) + "\",\"runId\":\"" + jsonEscape(entry.runId) +
                    "\",\"message\":\"" + jsonEscape(entry.message) + "\"" +
                    (typeof entry.percent === "number" ? ",\"percent\":" + entry.percent : "") + "}\n")) {
                throw new Error(file.error);
            }
            this.logWriteError = "";
        } catch (logFileError) {
            this.logWriteError = "Disk log unavailable: " + String(logFileError);
        } finally {
            if (opened) { try { file.close(); } catch (logCloseError) {} }
        }
    };

    Bridge.prototype.log = function (level, message, runId, percent) {
        // Logging must never affect script execution or result publication.
        try {
            var now = new Date(), pad = function (n) { return n < 10 ? "0" + n : String(n); };
            var entry = {
                time: pad(now.getHours()) + ":" + pad(now.getMinutes()) + ":" + pad(now.getSeconds()),
                epochMs: now.getTime(), level: String(level || "info").toLowerCase(),
                message: String(message || "").substring(0, 1000), runId: String(runId || "").substring(0, 80)
            };
            if (typeof percent === "number" && isFinite(percent)) { entry.percent = Math.max(0, Math.min(100, Math.round(percent))); }
            this.logs.push(entry);
            if (this.logs.length > 200) { this.logs.splice(0, this.logs.length - 200); }
            this.logRevision += 1;
            this.persistLog(entry);
            this.refreshLog();
        } catch (logError) {}
    };
    Bridge.prototype.appendLog = Bridge.prototype.log;
    Bridge.prototype.clearLog = function () { this.logs.splice(0, this.logs.length); this.logRevision += 1; this.refreshLog(); };
    Bridge.prototype.logOnce = function (key, level, message, runId) {
        if (this.logNotices[key] !== message) {
            this.logNotices[key] = message;
            this.log(level, message, runId);
        }
    };

    Bridge.prototype.getPublicFunctionCount = function () {
        var runtime = this.functions, cache = this.publicFunctionCountCache, count;
        if (!cache || cache.runtime !== runtime) {
            // A registry is immutable for its runtime. Do not allocate all descriptors
            // again on every idle tick, including when an unavailable registry fails.
            cache = { runtime: runtime, count: null, error: "" };
            this.publicFunctionCountCache = cache;
            try {
                count = runtime.list(false).length;
                if (typeof count !== "number" || !isFinite(count) || count < 0 || count !== Math.floor(count)) {
                    throw new Error("Danh mục công cụ không hợp lệ");
                }
                cache.count = count;
            } catch (functionCountError) {
                cache.error = String(functionCountError).slice(0, 500);
            }
        }
        return cache.count;
    };

    Bridge.prototype.refreshScriptsDisplay = function () {
        var count, countError;
        try {
            if (this.scriptsText) {
                count = this.getPublicFunctionCount();
                countError = this.publicFunctionCountCache.error;
                setControl(this.scriptsText, "text", (count === null ? "Công cụ: chưa đọc được danh mục" :
                    "Công cụ: " + count + " chức năng dùng lại") + "\n" + this.bundle.describe());
                setControl(this.scriptsText, "helpTip", countError || (this.bundle.errors.length ? this.bundle.errors.join("\n") :
                    "Bộ công cụ được kiểm tra khi cài đặt hoặc cập nhật. Mỗi nhánh được kiểm tra checksum khi cần; không quét toàn bộ script trong nền."));
            }
        } catch (disposedScriptsUiError) { releaseBridgeUi(this); }
    };

    Bridge.prototype.showScripts = function () {
        var dialog = new Window("dialog", "Kho script cũ · " + this.bundle.names.length + " nhánh lưu trữ");
        var bundle = this.bundle;
        var search = dialog.add("edittext", undefined, "");
        var list = dialog.add("listbox", undefined, []);
        var detail = dialog.add("statictext", undefined, "", { multiline: true });
        var close = dialog.add("button", undefined, "Đóng", { name: "ok" });
        dialog.orientation = "column"; dialog.alignChildren = ["fill", "top"];
        search.helpTip = "Tìm tên nhánh trong kho script cũ";
        list.preferredSize = [560, 320]; detail.preferredSize = [560, 64];
        function fill() {
            var i, name, entry, item, query = String(search.text).toLowerCase();
            list.removeAll();
            for (i = 0; i < bundle.names.length; i += 1) {
                name = bundle.names[i]; entry = bundle.entries[name];
                if (name.toLowerCase().indexOf(query) < 0) { continue; }
                item = list.add("item", "[" + (entry.state === "pending" && bundle.installation.state === "verified" ?
                    "installed OK" : entry.state) + "] " + name); item.branchName = name;
            }
        }
        search.onChanging = fill;
        list.onChange = function () {
            var entry = list.selection ? bundle.entries[list.selection.branchName] : null;
            if (!entry) { detail.text = ""; return; }
            try {
                detail.text = entry.error || "Shared source pieces: " + bridge.bundle.recipe(list.selection.branchName).split("|").length +
                    "\nDependencies: " + (entry.dependencies.join(", ") || "none");
            } catch (recipeError) { detail.text = String(recipeError); }
        };
        cartoonDialog(dialog, search, list, detail, close);
        fill(); dialog.center(); dialog.show();
    };

    Bridge.prototype.showFunctions = function () {
        var dialog = new Window("dialog", "Công cụ đã cài · " + this.functions.list(false).length);
        var search = dialog.add("edittext", undefined, "");
        var list = dialog.add("listbox", undefined, []);
        var detail = cartoonText(dialog, "", true);
        var descriptors = this.functions.list(false);
        dialog.orientation = "column"; dialog.alignChildren = ["fill", "top"];
        search.helpTip = "Tìm công cụ dùng lại và tham số. Các script dự án cũ được giữ trong Kho script.";
        list.preferredSize = [560, 280]; detail.preferredSize = [560, 180];
        var close = dialog.add("button", undefined, "Đóng", { name: "ok" });
        function fill() {
            var i, entry, item, query = String(search.text).toLowerCase(), label;
            list.removeAll();
            for (i = 0; i < descriptors.length; i += 1) {
                entry = descriptors[i]; label = entry.legacy ? "script.run / " + entry.branch : entry.name;
                if ((label + " " + entry.description).toLowerCase().indexOf(query) < 0) { continue; }
                item = list.add("item", label); item.descriptorIndex = i;
            }
        }
        search.onChanging = fill;
        list.onChange = function () {
            var entry = list.selection ? descriptors[list.selection.descriptorIndex] : null;
            detail.text = entry ? entry.description + "\n\n" + bridge.functions.stringify({
                "function": entry.name, args: entry.args || {}, legacy: !!entry.legacy
            }) : "";
        };
        cartoonDialog(dialog, search, list, detail, close);
        fill(); dialog.center(); dialog.show();
    };

    Bridge.prototype.beginLibrary = function () {
        try {
            this.bundle.run("Codex Library.jsx");
            if (typeof $.global.__aectLibraryFactoryV1 !== "function") {
                throw new Error("Library module did not load");
            }
            this.library = $.global.__aectLibraryFactoryV1(this);
            this.library.begin(this.generation);
        } catch (libraryError) {
            this.library = null;
            this.libraryDisplayValue = "Library unavailable: " + this.describeError(libraryError);
            if (this.libraryText) { this.libraryText.text = this.libraryDisplayValue; }
            this.log("error", this.libraryDisplayValue);
        }
        this.refreshLibraryDisplay();
    };

    Bridge.prototype.refreshLibraryDisplay = function () {
        var display = this.library ? this.library.describe() :
            (this.libraryDisplayValue || "Library: connect to scan effects and SFX");
        try {
            if (this.libraryText && this.libraryText.text !== display) {
                this.libraryText.text = display;
                if (this.window) { this.reflowUi(); }
            }
        } catch (libraryUiError) { releaseBridgeUi(this); }
        this.refreshLibraryControls();
    };

    Bridge.prototype.refreshLibraryControls = function () {
        var controls = this.libraryControls, library = this.library, preferences = null,
            available = !!(library && typeof library.getPreferences === "function" &&
                typeof library.setEnabled === "function" && typeof library.requestRefresh === "function"),
            scanning = available && (library.refreshPending === true || (library.state && library.state.state === "scanning")),
            idle = this.running && this.ready && !this.busy && !this.pendingReport && !this.pendingCleanupFile,
            tooltip = "Chỉ lập chỉ mục thư viện theo yêu cầu; không bật/tắt effects, layer hay âm thanh trong project.";
        if (!controls) { return; }
        try {
            if (available) {
                preferences = library.getPreferences();
                available = !!(preferences && typeof preferences.effectsEnabled === "boolean" &&
                    typeof preferences.sfxEnabled === "boolean" && preferences.manualRefresh === true);
            }
            if (available) {
                setControl(controls.effects, "value", preferences.effectsEnabled);
                setControl(controls.sfx, "value", preferences.sfxEnabled);
            }
            setControl(controls.effects, "enabled", !!(available && idle && !scanning));
            setControl(controls.sfx, "enabled", !!(available && idle && !scanning));
            setControl(controls.folders, "enabled", !!(available && idle && !scanning &&
                typeof library.getSfxRoots === "function" && typeof library.setSfxRoots === "function"));
            setControl(controls.refresh, "enabled", !!(available && idle && !scanning &&
                (preferences.effectsEnabled || preferences.sfxEnabled)));
            setControl(controls.refresh, "helpTip", !available ? "Chưa tải được bộ kiểm kê thủ công. Hãy kết nối lại hoặc cập nhật Codex AE." :
                (scanning ? "Đã có yêu cầu cập nhật thư viện. Chờ hoàn tất rồi cập nhật tiếp." : tooltip));
        } catch (libraryControlsError) {
            try { controls.effects.enabled = controls.sfx.enabled = controls.folders.enabled = controls.refresh.enabled = false; }
            catch (disposedLibraryControlsError) { releaseBridgeUi(this); }
        }
    };

    Bridge.prototype.setLibraryEnabled = function (kind, enabled) {
        try {
            if ((kind !== "effects" && kind !== "sfx") || typeof enabled !== "boolean") { throw new Error("Lựa chọn thư viện không hợp lệ."); }
            if (!this.running || !this.ready || this.busy || this.pendingReport || this.pendingCleanupFile ||
                    !this.library || typeof this.library.setEnabled !== "function") {
                throw new Error("Cầu nối chưa sẵn sàng để lưu lựa chọn thư viện.");
            }
            this.library.setEnabled(kind, enabled);
            this.log("info", (enabled ? "Đã bật" : "Đã tắt") + " kiểm kê " + (kind === "effects" ? "Effects" : "SFX") + ". Bấm Cập nhật thư viện để quét.");
            this.refreshLibraryDisplay();
            return true;
        } catch (preferenceError) {
            this.log("error", "Không lưu được lựa chọn thư viện: " + this.describeError(preferenceError));
            this.refreshLibraryControls();
            return false;
        }
    };

    Bridge.prototype.requestLibraryRefresh = function () {
        var accepted = false;
        try {
            if (!this.running || !this.ready || this.busy || this.pendingReport || this.pendingCleanupFile ||
                    !this.library || typeof this.library.requestRefresh !== "function") {
                throw new Error("Cầu nối chưa sẵn sàng. Chờ tác vụ hiện tại hoàn tất hoặc kết nối lại.");
            }
            accepted = this.library.requestRefresh() === true;
            this.log(accepted ? "info" : "warning", accepted ? "Đã nhận yêu cầu cập nhật thư viện; sẽ quét khi AE rảnh." : "Chưa nhận yêu cầu: thư viện đang cập nhật hoặc chưa bật mục kiểm kê.");
        } catch (refreshError) {
            this.log("error", "Không cập nhật được thư viện: " + this.describeError(refreshError));
        }
        this.refreshLibraryDisplay();
        return accepted;
    };

    Bridge.prototype.showSfxFolders = function () {
        var owner = this, library = this.library, roots, initial, i, dialog, instructions, list, actions,
            add, remove, status, footer, save, cancel, changed = false;
        try {
            if (!this.running || !this.ready || this.busy || this.pendingReport || this.pendingCleanupFile || !library ||
                    library.refreshPending || (library.state && library.state.state === "scanning") ||
                    typeof library.getSfxRoots !== "function" || typeof library.setSfxRoots !== "function") {
                throw new Error("Cầu nối chưa sẵn sàng để sửa thư mục SFX. Chờ cập nhật hoặc tác vụ hiện tại hoàn tất.");
            }
            initial = library.getSfxRoots(); roots = [];
            if (Object.prototype.toString.call(initial) !== "[object Array]" || initial.length > 32) { throw new Error("Danh sách thư mục SFX không hợp lệ."); }
            for (i = 0; i < initial.length; i += 1) {
                if (typeof initial[i] !== "string") { throw new Error("Đường dẫn thư mục SFX không hợp lệ."); }
                roots.push(initial[i]);
            }
            dialog = new Window("dialog", "Thư mục thư viện SFX");
            dialog.orientation = "column"; dialog.alignChildren = ["fill", "top"];
            instructions = dialog.add("statictext", undefined, "Để bỏ thư mục sai: chọn dòng → Bỏ khỏi danh sách → Lưu. Không xóa dữ liệu trên đĩa.\nChỉ thêm thư mục cụ thể, không chọn cả ổ đĩa. Lưu không quét; bấm Cập nhật khi cần.", { multiline: true });
            instructions.preferredSize = [560, 46];
            list = dialog.add("listbox", undefined, [], { multiselect: false }); list.preferredSize = [560, 180];
            actions = dialog.add("group"); add = actions.add("button", undefined, "Thêm thư mục…");
            remove = actions.add("button", undefined, "Bỏ khỏi danh sách");
            remove.helpTip = "Chỉ bỏ đường dẫn khỏi cấu hình; không xóa thư mục hoặc âm thanh trên đĩa.";
            status = dialog.add("statictext", undefined, "", { multiline: true }); status.preferredSize = [560, 38];
            footer = dialog.add("group"); save = footer.add("button", undefined, "Lưu", { name: "ok" });
            cancel = footer.add("button", undefined, "Hủy", { name: "cancel" });
            function selectedIndex() {
                var selected = list.selection, index = selected ? selected.index : -1;
                if (typeof index !== "number" || Math.floor(index) !== index || index < 0 || index >= roots.length ||
                        list.items[index] !== selected) { return -1; }
                return index;
            }
            function refreshSelection() {
                remove.enabled = selectedIndex() >= 0;
            }
            function fill(selectionIndex, message) {
                var index;
                list.removeAll();
                for (index = 0; index < roots.length; index += 1) { list.add("item", roots[index]); }
                if (roots.length > 0) { list.selection = Math.max(0, Math.min(selectionIndex, roots.length - 1)); }
                save.enabled = true; add.enabled = roots.length < 32; refreshSelection();
                status.text = roots.length + "/32 thư mục. " + (message || "Chọn dòng cần bỏ khỏi danh sách.") +
                    (roots.length === 0 ? " Bấm Lưu để xóa danh sách và tắt kiểm kê SFX." : (changed ? " Bấm Lưu để áp dụng." : ""));
            }
            list.onChange = refreshSelection;
            add.onClick = function () {
                var selected = Folder.selectDialog("Chọn thư mục chứa SFX cụ thể"), value, index;
                if (!selected) { return; }
                value = selected.fsName;
                for (index = 0; index < roots.length; index += 1) {
                    if (normalizePath(roots[index]) === normalizePath(value)) { status.text = "Thư mục này đã có trong danh sách."; return; }
                }
                if (roots.length >= 32) { status.text = "Chỉ lưu tối đa 32 thư mục SFX."; return; }
                roots.push(value); changed = true; fill(roots.length - 1, "Đã thêm thư mục vào danh sách.");
            };
            remove.onClick = function () {
                var index = selectedIndex();
                if (index < 0) { refreshSelection(); status.text = "Chọn một dòng thư mục cần bỏ, rồi bấm Bỏ khỏi danh sách. Chưa có thay đổi nào được lưu."; return; }
                roots.splice(index, 1); changed = true; fill(index, "Đã bỏ thư mục đã chọn. Không xóa dữ liệu trên đĩa.");
            };
            save.onClick = function () {
                try {
                    if (!owner.running || !owner.ready || owner.busy || owner.pendingReport || owner.pendingCleanupFile || owner.library !== library) {
                        throw new Error("Cầu nối đã đổi trạng thái. Hủy hộp thoại và chờ tác vụ hoàn tất.");
                    }
                    library.setSfxRoots(roots.slice(0));
                    owner.log("info", roots.length === 0 ? "Đã lưu danh sách thư mục trống và tắt kiểm kê SFX. Không xóa dữ liệu trên đĩa." :
                        "Đã lưu " + roots.length + " thư mục SFX. Chưa quét và không tự bật SFX; bấm Cập nhật khi cần.");
                    owner.refreshLibraryDisplay(); dialog.close(1);
                } catch (saveError) {
                    status.text = "Không lưu được: " + owner.describeError(saveError);
                    owner.log("error", "Không lưu được thư mục SFX: " + owner.describeError(saveError));
                }
            };
            cancel.onClick = function () { dialog.close(0); };
            cartoonSurface(dialog, cartoonPaper); cartoonSurface(instructions, cartoonPaper, "Segoe UI", 11);
            cartoonSurface(list, cartoonField, "Segoe UI", 11); cartoonSurface(status, cartoonPaper, "Segoe UI", 11);
            cartoonButton(add, [0.19, 0.29, 0.46, 1]); cartoonButton(remove, [0.43, 0.22, 0.23, 1]);
            cartoonButton(save, [0.16, 0.34, 0.27, 1]); cartoonButton(cancel, [0.29, 0.24, 0.44, 1]);
            remove.preferredSize = [160, 32]; fill(0); dialog.center(); dialog.show();
            return true;
        } catch (folderError) {
            this.log("error", "Không mở được thư mục SFX: " + this.describeError(folderError));
            return false;
        }
    };

    Bridge.prototype.ensureFolder = function (path) {
        var folder = new Folder(path);
        if (!folder.exists && !folder.create()) {
            throw new Error("Cannot create bridge folder: " + path + "; " + folder.error);
        }
        return folder;
    };

    Bridge.prototype.ensureFolders = function () {
        this.ensureFolder(this.workspaceRoot + "/.ae-codex");
        this.ensureFolder(this.bridgeRoot);
        this.ensureFolder(this.inboxPath);
        this.ensureFolder(this.resultsPath);
    };

    Bridge.prototype.writeAtomic = function (path, text) {
        var destination = new File(path);
        var temporary = new File(path + ".tmp");
        var attempt;
        var lastError = "unknown file error";

        for (attempt = 0; attempt < 4; attempt += 1) {
            try {
                if (temporary.exists && !temporary.remove()) {
                    throw new Error("Cannot clear temporary file: " + temporary.error);
                }

                temporary.encoding = "UTF-8";
                if (!temporary.open("w")) {
                    throw new Error("Cannot open temporary file: " + temporary.error);
                }
                try {
                    temporary.write(text);
                } finally {
                    temporary.close();
                }

                if (destination.exists && !destination.remove()) {
                    throw new Error("Cannot replace destination: " + destination.error);
                }
                if (!temporary.rename(destination.name)) {
                    throw new Error("Cannot publish temporary file: " + temporary.error);
                }
                return;
            } catch (writeError) {
                lastError = String(writeError);
                if (temporary.opened) {
                    temporary.close();
                }
                if (attempt < 3) {
                    $.sleep(35 * (attempt + 1));
                }
            }
        }

        throw new Error("Atomic write failed for " + destination.fsName + ": " + lastError);
    };

    Bridge.prototype.writeNewAtomic = function (path, text) {
        var destination = new File(path);
        var temporary = new File(path + ".tmp-" + this.sessionNonce);
        var attempt;
        var lastError = "unknown file error";

        if (destination.exists) {
            throw new Error("Refusing to replace immutable result: " + destination.fsName);
        }

        for (attempt = 0; attempt < 4; attempt += 1) {
            try {
                if (temporary.exists && !temporary.remove()) {
                    throw new Error("Cannot clear temporary result: " + temporary.error);
                }

                temporary.encoding = "UTF-8";
                if (!temporary.open("w")) {
                    throw new Error("Cannot open temporary result: " + temporary.error);
                }
                try {
                    temporary.write(text);
                } finally {
                    temporary.close();
                }

                if (destination.exists) {
                    throw new Error("Immutable result appeared while publishing");
                }
                if (!temporary.rename(destination.name)) {
                    throw new Error("Cannot publish immutable result: " + temporary.error);
                }
                return;
            } catch (writeError) {
                lastError = String(writeError);
                if (temporary.opened) {
                    temporary.close();
                }
                if (destination.exists) {
                    throw new Error("Refusing to replace immutable result: " + destination.fsName);
                }
                if (attempt < 3) {
                    $.sleep(35 * (attempt + 1));
                }
            }
        }

        throw new Error("Immutable result write failed for " + destination.fsName + ": " + lastError);
    };

    Bridge.prototype.setConnectionStatus = function (connected, detail) {
        this.connectionConnected = connected;
        try {
            if (this.connectionText) {
                setControl(this.connectionText, "text", (connected ? "Đã kết nối · " : "Chưa kết nối · ") + detail);
                if (this.connectionPens && this.connectionUiColor !== connected) {
                    this.connectionText.graphics.foregroundColor = connected ? this.connectionPens.connected : this.connectionPens.disconnected;
                    this.connectionUiColor = connected;
                }
            }
        } catch (disposedConnectionUiError) {
            releaseBridgeUi(this);
        }
        this.refreshLibraryControls();
    };

    Bridge.prototype.setUiStatus = function (text) {
        this.lastStatus = String(text);
        try {
            if (this.statusText) {
                setControl(this.statusText, "text", this.lastStatus);
                if (this.window) {
                    this.reflowUi();
                }
            }
        } catch (disposedUiError) {
            releaseBridgeUi(this);
        }
    };

    Bridge.prototype.reflowUi = function (force) {
        this.refreshConnectionHealth();
        this.recoverScheduled("panel layout");
        if (!this.window) { return; }
        try {
            if (this.ui && this.ui.reflow) { this.ui.reflow(!!force); }
            else { this.window.layout.layout(true); }
        } catch (disposedLayoutError) {
            // Home/project/workspace changes may dispose the native panel while
            // the session remains alive. UI failure must never block jobs or
            // restart/replay the controller's in-flight work.
            releaseBridgeUi(this);
            this.logOnce("ui-disposed", "info", "Panel AE đã được thay đổi; cầu nối tiếp tục nhận lệnh. Mở lại Codex Bridge để hiện bảng.");
        }
    };

    Bridge.prototype.setProgress = function (value, label) {
        var normalizedValue = Math.max(0, Math.min(100, Math.round(Number(value))));
        if (!isFinite(normalizedValue)) { normalizedValue = 0; }
        this.progressValue = normalizedValue;
        this.progressLabel = String(label || "Loading");

        try {
            if (this.progressBar) {
                this.progressBar.value = normalizedValue;
            }
            if (this.progressText) {
                this.progressText.text = this.progressLabel + " - " + normalizedValue + "%";
            }
            if (this.window) {
                this.reflowUi();
                if (this.window.update) {
                    this.window.update();
                }
            }
        } catch (disposedUiError) {
            releaseBridgeUi(this);
        }
    };

    Bridge.prototype.showProgress = function () {
        try {
            if (this.progressGroup) {
                this.progressGroup.visible = true;
            }
            if (this.progressText) {
                this.progressText.visible = true;
            }
            if (this.progressBar) {
                this.progressBar.visible = true;
            }
            if (this.window) {
                this.reflowUi();
                if (this.window.update) {
                    this.window.update();
                }
            }
        } catch (disposedUiError) {
            releaseBridgeUi(this);
        }
    };

    Bridge.prototype.hideProgress = function () {
        try {
            if (this.progressGroup) {
                this.progressGroup.visible = false;
            }
            if (this.progressText) {
                this.progressText.visible = false;
            }
            if (this.progressBar) {
                this.progressBar.visible = false;
            }
            if (this.window) {
                this.reflowUi();
                if (this.window.update) {
                    this.window.update();
                }
            }
        } catch (disposedUiError) {
            releaseBridgeUi(this);
        }
    };

    Bridge.prototype.writeHeartbeat = function (state, message) {
        var now = new Date().getTime();
        var payload = "{" +
            "\"schema\":\"aect-heartbeat/v1\"," +
            "\"state\":\"" + jsonEscape(state) + "\"," +
            "\"bridgeVersion\":\"" + jsonEscape(BRIDGE_VERSION) + "\"," +
            "\"startupPercent\":" + this.progressValue + "," +
            "\"startupStage\":\"" + jsonEscape(this.progressLabel) + "\"," +
            "\"sessionNonce\":\"" + jsonEscape(this.sessionNonce) + "\"," +
            "\"timestampEpochMs\":" + now + "," +
            "\"afterEffectsVersion\":\"" + jsonEscape(app.version) + "\"," +
            "\"functions\":{\"schema\":\"aect-functions/v1\",\"catalogRelativePath\":\".ae-codex/functions/catalog.json\"}," +
            "\"message\":\"" + jsonEscape(message || "") + "\"" +
            (this.library && $.global.__aectLibraryJsonV1 ?
                ",\"library\":" + $.global.__aectLibraryJsonV1(this.library.heartbeat()) : "") +
            (this.bundle && $.global.__aectLibraryJsonV1 ?
                ",\"scripts\":" + $.global.__aectLibraryJsonV1(this.bundle.status()) : "") +
            "}";

        this.writeAtomic(this.heartbeatPath, payload);
        this.lastHeartbeat = now;
        if (state === "running") {
            this.connectionRecoveryPending = false;
            if (this.running && this.ready && (this.lastStatus === "Đang khôi phục kết nối; chờ heartbeat mới…" ||
                    this.lastStatus === "Mất nhịp kết nối; đang kiểm tra listener AE…")) {
                this.setUiStatus("Bridge " + BRIDGE_VERSION + " connected successfully\nReady for Codex jobs");
            }
        }
        this.setConnectionStatus(state === "running" && this.running && this.ready,
            state === "running" ? "Connected / Ready for Codex" :
                (state === "starting" ? "Connecting..." :
                    (state === "stopped" ? "Disconnected" : "Connection error")));
    };

    Bridge.prototype.writeStarted = function (runId, operation, startedAt) {
        var now = new Date().getTime();
        var path = this.resultsPath + "/started-" + runId + ".json";
        var payload = "{" +
            "\"schema\":\"aect-run-started/v1\"," +
            "\"mode\":\"file-bridge\"," +
            "\"runId\":\"" + jsonEscape(runId) + "\"," +
            "\"sessionNonce\":\"" + jsonEscape(this.sessionNonce) + "\"," +
            "\"state\":\"running\"," +
            "\"phase\":\"evaluating\"," +
            "\"operation\":\"" + jsonEscape(operation || "") + "\"," +
            "\"afterEffectsVersion\":\"" + jsonEscape(app.version) + "\"," +
            "\"startedAtEpochMs\":" + startedAt + "," +
            "\"timestampEpochMs\":" + now +
            "}";

        this.writeNewAtomic(path, payload);
    };

    Bridge.prototype.writeStatus = function (report) {
        var now = new Date().getTime();
        var path = this.resultsPath + "/status-" + report.runId + ".json";
        var payload = "{" +
            "\"schema\":\"aect-run/v2\"," +
            "\"mode\":\"file-bridge\"," +
            "\"runId\":\"" + jsonEscape(report.runId) + "\"," +
            "\"sessionNonce\":\"" + jsonEscape(this.sessionNonce) + "\"," +
            "\"state\":\"" + jsonEscape(report.state) + "\"," +
            "\"phase\":\"" + jsonEscape(report.phase) + "\"," +
            "\"errorCode\":\"" + jsonEscape(report.errorCode || "") + "\"," +
            "\"retryable\":" + (report.retryable ? "true" : "false") + "," +
            "\"completionKnown\":" + (report.completionKnown ? "true" : "false") + "," +
            "\"operation\":\"" + jsonEscape(report.operation || "") + "\"," +
            "\"afterEffectsVersion\":\"" + jsonEscape(app.version) + "\"," +
            "\"startedAtEpochMs\":" + report.startedAt + "," +
            "\"timestampEpochMs\":" + now + "," +
            "\"message\":\"" + jsonEscape(report.message || "") + "\"," +
            "\"result\":\"" + jsonEscape(report.result || "") + "\"" +
            "}";

        this.writeNewAtomic(path, payload);
    };

    Bridge.prototype.describeError = function (error) {
        var description = error && error.toString ? error.toString() : String(error);
        if (error && error.line) {
            description += " (line " + error.line + ")";
        }
        if (error && error.fileName) {
            description += " in " + error.fileName;
        }
        return description;
    };

    Bridge.prototype.publishPendingReport = function () {
        var report = this.pendingReport;
        var cleanupWarning = "";

        if (!report) {
            return true;
        }

        try {
            this.writeStatus(report);
            this.pendingReport = null;
            this.logNotices.report = "";
            this.log("info", "Result report published: " + report.state, report.runId);

            if (report.runningFile && report.runningFile.exists && !report.runningFile.remove()) {
                cleanupWarning = "\nResult published; job cleanup failed: " + report.runningFile.error;
                this.pendingCleanupFile = report.runningFile;
                this.logOnce("cleanup", "error", cleanupWarning, report.runId);
            } else {
                this.pendingCleanupFile = null;
            }
            this.busy = this.pendingCleanupFile !== null;

            if (report.state === "success") {
                this.setUiStatus(
                    "Completed " + report.operation + "\nRun ID: " + report.runId + cleanupWarning
                );
            } else {
                this.setUiStatus(
                    "Failed " + report.operation + "\n" + report.message + cleanupWarning
                );
            }
            return true;
        } catch (statusError) {
            this.busy = true;
            this.logOnce("report", "error", "Result publication failed; retrying report only: " + this.describeError(statusError), report.runId);
            this.setUiStatus(
                "JSX finished; reporting result will retry\n" + String(statusError)
            );
            return false;
        }
    };

    Bridge.prototype.retryPendingCleanup = function () {
        var file = this.pendingCleanupFile;

        if (!file) {
            return true;
        }
        if (!file.exists || file.remove()) {
            this.pendingCleanupFile = null;
            this.busy = this.pendingReport !== null;
            this.setUiStatus("Result published and job cleanup completed");
            this.logNotices.cleanup = "";
            this.log("info", "Job marker cleanup completed");
            return true;
        }

        this.busy = true;
        this.logOnce("cleanup", "error", "Job marker cleanup failed; retrying: " + file.error);
        this.setUiStatus("Result published; waiting to clean job marker\n" + file.error);
        return false;
    };

    Bridge.prototype.readJob = function (jobFile) {
        var values = {};
        var fieldCount = 0;

        if (jobFile.length > 800 * 1024) {
            throw new Error("Job request is too large");
        }

        jobFile.encoding = "UTF-8";
        if (!jobFile.open("r")) {
            throw new Error("Cannot read job: " + jobFile.fsName + "; " + jobFile.error);
        }

        try {
            while (!jobFile.eof) {
                var line = jobFile.readln();
                if (trim(line) === "") {
                    continue;
                }

                var separator = line.indexOf("=");
                if (separator < 1) {
                    throw new Error("Invalid job line: " + line);
                }

                var key = trim(line.substring(0, separator));
                var value = trim(line.substring(separator + 1));
                if (key !== "schema" && key !== "runId" && key !== "sessionNonce" && key !== "script" && key !== "request") {
                    throw new Error("Unknown job field: " + key);
                }
                if (typeof values[key] !== "undefined") {
                    throw new Error("Duplicate job field: " + key);
                }
                values[key] = value;
                fieldCount += 1;
            }
        } finally {
            jobFile.close();
        }

        if (fieldCount !== 4) {
            throw new Error("Job must contain exactly schema, runId, sessionNonce, and script or request");
        }

        return values;
    };

    Bridge.prototype.validateJob = function (jobFile, job) {
        if (job.schema !== "aect-job/v1" && job.schema !== "aect-job/v2") {
            throw new Error("Unsupported job schema");
        }

        if (!/^[A-Za-z0-9-]{8,80}$/.test(job.runId || "")) {
            throw new Error("Invalid run ID");
        }

        if (jobFile.name !== "job-" + job.runId + ".job") {
            throw new Error("Job filename does not match run ID");
        }

        if (job.schema === "aect-job/v2") {
            if (typeof job.request !== "string" || typeof job.script !== "undefined") {
                throw new Error("Function jobs require request data and cannot contain a script path");
            }
            var requestText = decodeURIComponent(job.request), request, names = [], stepIndex;
            if (requestText.length > 131072 || encodeURIComponent(requestText).replace(/%[A-Fa-f0-9]{2}|./g, "x").length > 131072) {
                throw new Error("Function request exceeds 128 KiB");
            }
            request = this.functions.parse(requestText);
            this.bundle.refresh(false);
            this.functions.validate(request);
            for (stepIndex = 0; stepIndex < request.steps.length; stepIndex += 1) { names.push(request.steps[stepIndex]["function"]); }
            return { name: "functions: " + names.join(", "), functionRequest: request };
        }
        if (typeof job.script !== "string" || typeof job.request !== "undefined" || jobFile.length > 4096) {
            throw new Error("Legacy jobs require a script path only, up to 4096 bytes");
        }

        var relativePath = String(job.script || "").replace(/\\/g, "/");
        if (!/^jsx\/[^\/]+\.jsx$/i.test(relativePath)) {
            throw new Error("Only direct .jsx files inside jsx/ are allowed");
        }

        if (/[:*?\"<>|\x00-\x1F]/.test(relativePath)) {
            throw new Error("Script path contains invalid characters");
        }

        var segments = relativePath.split("/");
        var index;
        for (index = 0; index < segments.length; index += 1) {
            if (segments[index] === "" || segments[index] === "." || segments[index] === "..") {
                throw new Error("Script path traversal is not allowed");
            }
        }

        var jsxFolder = new Folder(this.workspaceRoot + "/jsx");
        var jsxRoot = normalizePath(jsxFolder.fsName);
        var targetFile = new File(this.workspaceRoot + "/" + relativePath);
        var targetPath = normalizePath(targetFile.fsName);

        if (jsxFolder.alias || targetFile.alias) {
            throw new Error("Aliases, shortcuts, and symbolic links are not allowed");
        }

        if (normalizePath(targetFile.parent.fsName) !== jsxRoot ||
                targetPath.indexOf(jsxRoot + "/") !== 0) {
            throw new Error("Script resolves outside the jsx folder");
        }

        this.bundle.refresh(false);
        if (this.bundle.has(targetFile.name)) { return { name: targetFile.name, bundleBranch: true }; }
        if (!targetFile.exists) {
            throw new Error("Script does not exist: " + relativePath);
        }

        return targetFile;
    };

    Bridge.prototype.rejectJob = function (jobFile, error, job) {
        var rejectedName = jobFile.name + ".rejected-" + new Date().getTime();
        jobFile.rename(rejectedName);
        this.setUiStatus("Rejected job: " + String(error));
        this.log("error", "Rejected job: " + this.describeError(error), job ? job.runId : "");

        if (job && job.sessionNonce === this.sessionNonce &&
                /^[A-Za-z0-9-]{8,80}$/.test(job.runId || "")) {
            this.pendingReport = {
                runId: job.runId,
                state: "error",
                phase: "validation",
                errorCode: "JOB_REJECTED",
                retryable: false,
                completionKnown: true,
                operation: job.schema === "aect-job/v2" ? "function plan" : (job.script || "unknown JSX"),
                startedAt: new Date().getTime(),
                message: this.describeError(error),
                result: "",
                runningFile: null
            };
            this.busy = true;
            this.publishPendingReport();
        }
    };

    Bridge.prototype.processJob = function (jobFile) {
        var job;
        var targetFile;

        try {
            job = this.readJob(jobFile);
            if (job.sessionNonce !== this.sessionNonce) {
                // Another AE instance owns this job. Leave it untouched so the
                // matching bridge can claim it.
                return;
            }
            targetFile = this.validateJob(jobFile, job);
        } catch (validationError) {
            this.rejectJob(jobFile, validationError, job);
            return;
        }

        var runningName = "job-" + job.runId + ".running";
        if (!jobFile.rename(runningName)) {
            this.setUiStatus("Could not claim job " + job.runId + ": " + jobFile.error);
            this.logOnce("claim", "error", "Could not claim job " + job.runId + ": " + jobFile.error, job.runId);
            return;
        }
        this.logNotices.claim = "";

        var runningFile = new File(this.inboxPath + "/" + runningName);
        var startedAt = new Date().getTime();
        var report;
        var evaluationResult;
        var executionDescription = "";
        var executionSucceeded = false;
        var controller = this, contextActive = true;
        this.busy = true;
        this.hideProgressPending = false;
        this.showProgress();
        this.setProgress(0, "Running " + targetFile.name);
        this.log("info", "Started " + targetFile.name, job.runId);
        this.setUiStatus("Running " + targetFile.name + "\nRun ID: " + job.runId);

        try {
            // If this preflight write fails, the target is not executed.
            this.writeStarted(job.runId, targetFile.name, startedAt);
        } catch (preflightError) {
            this.log("error", "Job preflight failed: " + this.describeError(preflightError), job.runId);
            this.setProgress(0, "Preflight failed");
            this.pendingReport = {
                runId: job.runId,
                state: "error",
                phase: "preflight",
                errorCode: "START_STATUS_FAILED",
                retryable: true,
                completionKnown: true,
                operation: targetFile.name,
                startedAt: startedAt,
                message: this.describeError(preflightError),
                result: "",
                runningFile: runningFile
            };
            this.publishPendingReport();
            return;
        }

        try {
            $.global.__AECT_RUN_CONTEXT__ = {
                schema: "aect-context/v1",
                runId: job.runId,
                workspaceRoot: this.workspaceRoot,
                progress: function (percent, message) {
                    if (!contextActive || !isFinite(Number(percent))) { return; }
                    controller.setProgress(percent, message || targetFile.name);
                    controller.log("progress", message || targetFile.name, job.runId, Number(percent));
                },
                log: function (message, level) {
                    if (contextActive) { controller.log(level === "error" || level === "warning" ? level : "info", message, job.runId); }
                }
            };

            if (targetFile.functionRequest) {
                evaluationResult = this.functions.stringify(this.functions.run(targetFile.functionRequest, $.global.__AECT_RUN_CONTEXT__));
            } else {
                evaluationResult = targetFile.bundleBranch ? this.bundle.run(targetFile.name) : $.evalFile(targetFile);
            }
            executionSucceeded = true;
        } catch (executionError) {
            executionDescription = this.describeError(executionError);
        } finally {
            contextActive = false;
            try {
                delete $.global.__AECT_RUN_CONTEXT__;
            } catch (contextError) {
                $.global.__AECT_RUN_CONTEXT__ = null;
            }
        }

        if (executionSucceeded) {
            this.setProgress(100, "Completed " + targetFile.name);
            this.log("info", "Completed successfully: " + targetFile.name, job.runId, 100);
            this.hideProgressPending = true;
        } else {
            this.setProgress(this.progressValue, "Failed " + targetFile.name);
            this.log("error", executionDescription, job.runId);
        }

        report = {
            runId: job.runId,
            state: executionSucceeded ? "success" : "error",
            phase: executionSucceeded ? "completed" : "evaluating",
            errorCode: executionSucceeded ? "" : (targetFile.functionRequest ? "FUNCTION_EXECUTION_FAILED" : "JSX_EXECUTION_FAILED"),
            retryable: false,
            completionKnown: true,
            operation: targetFile.name,
            startedAt: startedAt,
            message: executionSucceeded ? (targetFile.functionRequest ? "Function plan completed" : "JSX completed") : executionDescription,
            result: executionSucceeded && typeof evaluationResult !== "undefined" ?
                String(evaluationResult) : "",
            runningFile: runningFile
        };
        this.pendingReport = report;
        this.publishPendingReport();
    };

    Bridge.prototype.markConnectionUnavailable = function (message, preserveStatus) {
        this.setConnectionStatus(false, message);
        if (preserveStatus) { return; }
        this.lastStatus = String(message);
        try { if (this.statusText) { setControl(this.statusText, "text", this.lastStatus); } }
        catch (disposedStatusError) { releaseBridgeUi(this); }
    };

    Bridge.prototype.ensureListenerOwner = function (reason, reclaimMissing) {
        var registered = $.global[GLOBAL_NAME], message;
        if (registered === this) { return true; }
        if (!registered && reclaimMissing) {
            $.global[GLOBAL_NAME] = this;
            this.log("warning", "Restored missing bridge binding; session=" + this.sessionNonce +
                "; generation=" + this.generation + "; reason=" + String(reason || "panel").substring(0, 80));
            return true;
        }
        message = "Panel này không còn giữ kết nối. Đóng và mở lại Codex Bridge để dùng phiên hiện tại.";
        this.markConnectionUnavailable(message);
        this.logOnce("ownership-conflict", "warning", "Refused stale panel listener; session=" + this.sessionNonce +
            "; generation=" + this.generation + "; reason=" + String(reason || "panel").substring(0, 80));
        return false;
    };

    Bridge.prototype.refreshConnectionHealth = function () {
        var age;
        if (!this.running || !this.ready || this.connectionActionActive) { return; }
        age = new Date().getTime() - this.lastHeartbeat;
        if ($.global[GLOBAL_NAME] !== this || !this.lastHeartbeat || age < -5000 || age > 10000 || this.connectionRecoveryPending) {
            this.markConnectionUnavailable(this.connectionRecoveryPending ? "Đang khôi phục kết nối; chờ heartbeat mới…" :
                "Mất nhịp kết nối; đang kiểm tra listener AE…", /^Bridge (error|listener stopped):/.test(this.lastStatus));
        }
    };

    Bridge.prototype.scheduleNext = function (delay) {
        if (this.running && !this.taskId) {
            if ($.global[GLOBAL_NAME] !== this) { throw new Error("Bridge listener ownership changed before scheduling"); }
            this.taskToken += 1;
            this.taskDueAt = new Date().getTime() + delay;
            this.taskId = app.scheduleTask(
                "if ($.global.__aeCodexTeamBridgeV1 && typeof $.global.__aeCodexTeamBridgeV1.runScheduled === \"function\") { " +
                    "$.global.__aeCodexTeamBridgeV1.runScheduled(" + this.generation + "," + this.taskToken + ",\"" +
                    jsonEscape(this.sessionNonce) + "\"); }",
                delay,
                false
            );
            if (!this.taskId) {
                throw new Error("After Effects could not schedule the next bridge task");
            }
        }
    };

    Bridge.prototype.runScheduled = function (generation, taskToken, sessionNonce) {
        if ($.global[GLOBAL_NAME] !== this || !this.running || generation !== this.generation || taskToken !== this.taskToken ||
                sessionNonce !== this.sessionNonce || this.scheduledCallbackActive) {
            return;
        }

        this.taskId = 0;
        this.taskDueAt = 0;
        this.scheduledCallbackActive = true;
        try {
            if (!this.ready) { this.advanceStartup(generation); }
            else { this.tick(generation); }
        } finally {
            this.scheduledCallbackActive = false;
        }
    };

    Bridge.prototype.recoverScheduled = function (reason) {
        var now, staleTask;
        // AE can discard a one-shot task while restoring Home/workspaces. Native
        // panel activity may rearm only that listener, never restart a session or
        // replay a job. Healthy layout events allocate no additional timer.
        if (!this.running || this.connectionActionActive || this.scheduledCallbackActive ||
                (this.busy && !this.pendingReport && !this.pendingCleanupFile)) { return false; }
        now = new Date().getTime();
        if (this.taskId && (!this.taskDueAt || now - this.taskDueAt < 10000)) { return false; }
        if (!this.ensureListenerOwner(reason, true)) { return false; }
        staleTask = this.taskId;
        this.taskToken += 1;
        this.taskId = 0;
        this.taskDueAt = 0;
        if (staleTask) { try { app.cancelTask(staleTask); } catch (expiredTaskError) {} }
        try {
            this.connectionRecoveryPending = true;
            this.markConnectionUnavailable("Đang khôi phục kết nối; chờ heartbeat mới…");
            this.scheduleNext(60);
            this.log("warning", "Khôi phục nhịp kết nối AE; session=" + this.sessionNonce + "; generation=" +
                this.generation + "; reason=" + String(reason || "panel hoạt động").substring(0, 80) + ". Không chạy lại lệnh cũ.");
            return true;
        } catch (recoveryError) {
            this.running = false; this.ready = false;
            this.log("error", "Không khôi phục được nhịp kết nối: " + this.describeError(recoveryError));
            this.setConnectionStatus(false, "Listener stopped");
            this.setUiStatus("Bridge listener stopped:\n" + String(recoveryError));
            try { this.writeHeartbeat("error", String(recoveryError)); } catch (heartbeatError) {}
            return false;
        }
    };

    Bridge.prototype.failStartup = function (error) {
        this.log("error", "Connection failed: " + this.describeError(error));
        this.setConnectionStatus(false, "Connection error");
        var failedAt = this.progressValue;
        this.ready = false;
        this.running = false;
        this.taskId = 0;
        this.showProgress();
        this.setProgress(failedAt, "Failed at " + failedAt + "%");
        this.setUiStatus("Could not start bridge:\n" + String(error));
        try {
            this.writeHeartbeat("error", String(error));
        } catch (heartbeatError) {
            // The inline status remains available when file access failed.
        }
    };

    Bridge.prototype.advanceStartup = function (generation) {
        if (!this.running || generation !== this.generation) {
            return;
        }

        try {
            switch (this.startupStep) {
            case 0:
                this.setProgress(10, "Checking workspace");
                if (!(new Folder(this.workspaceRoot)).exists) {
                    throw new Error("Workspace folder does not exist: " + this.workspaceRoot);
                }
                break;
            case 1:
                this.setProgress(25, "Preparing runtime folder");
                this.ensureFolder(this.workspaceRoot + "/.ae-codex");
                break;
            case 2:
                this.setProgress(45, "Preparing bridge storage");
                this.ensureFolder(this.bridgeRoot);
                break;
            case 3:
                this.setProgress(65, "Preparing job inbox");
                this.ensureFolder(this.inboxPath);
                break;
            case 4:
                this.setProgress(80, "Preparing result storage");
                this.ensureFolder(this.resultsPath);
                break;
            case 5:
                this.setProgress(92, "Testing heartbeat");
                this.writeHeartbeat("starting", "Bridge startup in progress");
                break;
            case 6:
                this.setProgress(97, "Starting library and job listener");
                this.bundle.refresh(false);
                this.bundle.loadInstallation();
                this.refreshScriptsDisplay();
                this.beginLibrary();
                break;
            default:
                this.ready = true;
                this.setProgress(100, "Success");
                this.writeHeartbeat("running", "Waiting for jobs");
                this.setUiStatus(
                    "Bridge " + BRIDGE_VERSION + " connected successfully\n" +
                    "Ready for Codex jobs"
                );
                this.hideProgressPending = true;
                this.log("info", "Bridge " + BRIDGE_VERSION + " connected; ready for jobs");
                break;
            }

            if (!this.ready) { this.log("info", this.progressLabel, "", this.progressValue); }
            this.startupStep += 1;
            if (this.running && generation === this.generation) {
                this.scheduleNext(this.ready ? 700 : 80);
            }
        } catch (startupError) {
            this.failStartup(startupError);
        }
    };

    function clock(epoch) { var d = new Date(Number(epoch) || 0), h = d.getHours(), mi = d.getMinutes(); return (h < 10 ? "0" : "") + h + ":" + (mi < 10 ? "0" : "") + mi; }
    var TEAM_STATES = { running: "Đang làm", done: "Xong", idle: "Chờ việc", blocked: "Cần xử lý", stopped: "Đã dừng" };
    // Text loading bar per position, like the VS Code cards: a moving segment while running, full when done.
    function teamBar(state, frame) {
        var width = 10, cells = [], i, head = frame % (width + 3);
        for (i = 0; i < width; i += 1) {
            if (state === "done") { cells.push("█"); }
            else if (state === "running") { cells.push(i >= head - 3 && i < head ? "█" : "░"); }
            else if (state === "blocked" || state === "stopped") { cells.push("▒"); }
            else { cells.push("░"); }
        }
        return cells.join("") + "  " + (TEAM_STATES[state] || "");
    }
    Bridge.prototype.animateTeam = function () {
        var team = this.ui && this.ui.team, items, i, row, data = team && team.data;
        if (!team || !data || !team.list.visible) { return; }
        team.frame = (team.frame || 0) + 1; items = team.list.items;
        for (i = 0; i < items.length && i < data.roles.length; i += 1) {
            row = data.roles[i];
            if (row.state === "running") { items[i].subItems[2].text = teamBar("running", team.frame); }
        }
    };
    Bridge.prototype.refreshTeam = function (force) {
        var team = this.ui && this.ui.team, now = new Date().getTime(), file, stamp, text, data;
        if (!team || (!force && now - team.lastCheck < 1500)) { return; }
        team.lastCheck = now;
        file = new File(this.workspaceRoot + "/.ae-codex/team/status.json");
        stamp = file.exists ? String(file.length) + ":" + (file.modified ? file.modified.getTime() : 0) : "none";
        if (!force && stamp === team.stamp) { return; }
        team.stamp = stamp; team.data = null;
        if (stamp !== "none") {
            file.encoding = "UTF-8";
            if (file.open("r")) {
                try { text = file.read(); } finally { file.close(); }
                try { data = this.functions.parse(text); if (data && data.schema === "aect-team-status/v1") { team.data = data; this.logTeamEvents(data); } } catch (teamParseError) {}
            }
        }
        this.renderTeam();
    };
    // Copy what the team does (from VS Code) into the work log once per event; first view shows the last 10.
    Bridge.prototype.logTeamEvents = function (data) {
        var team = this.ui.team, events = data.events || [], sessionId = data.session ? data.session.id : "", start = 0, i, e, known = team.loggedEvents || {}, count = 0;
        if (team.eventSession !== sessionId) {
            team.eventSession = sessionId; known = team.loggedEvents = {};
            if (data.session) { this.log("info", "── TEAM · phiên: " + data.session.name); }
            start = Math.max(0, events.length - 10);
            for (i = 0; i < start; i += 1) { known[events[i].id] = true; }
        }
        for (i = start; i < events.length; i += 1) {
            e = events[i];
            if (!e || known[e.id]) { continue; }
            known[e.id] = true; count += 1;
            this.log(e.kind === "error" ? "error" : "info", "[TEAM " + clock(e.at) + "] " + e.text);
        }
        // Bound the de-duplication map to the events still in the window.
        if (count) { team.loggedEvents = {}; for (i = 0; i < events.length; i += 1) { team.loggedEvents[events[i].id] = true; } }
    };
    Bridge.prototype.renderTeam = function () {
        var team = this.ui && this.ui.team, data = team && team.data, roles = data && data.roles || [], keep, i, row, item;
        if (!team) { return; }
        keep = team.list.selection ? team.list.selection.roleId : "lead";
        team.list.removeAll();
        for (i = 0; i < roles.length && i < 16; i += 1) {
            row = roles[i]; item = team.list.add("item", (row.n < 10 ? "0" : "") + row.n); item.roleId = row.id;
            item.subItems[0].text = row.name; item.subItems[1].text = row.model; item.subItems[2].text = teamBar(row.state, team.frame || 0);
            if (row.id === keep) { team.list.selection = item; }
        }
        this.renderChat();
        setControl(team.header, "text", "TEAM · " + roles.length + " VỊ TRÍ" + (data && data.session ? " · " + data.session.name : " · chưa có phiên"));
        this.renderTeamDetail();
    };
    Bridge.prototype.renderTeamDetail = function () {
        var team = this.ui && this.ui.team, data = team && team.data, id = team && team.list.selection ? team.list.selection.roleId : "", row = null, i, lines = [];
        if (!team) { return; }
        if (!data) { setControl(team.detail, "text", "Mở bảng AE_CodexTeam trong VS Code để hiện trạng thái team."); return; }
        for (i = 0; i < data.roles.length; i += 1) { if (data.roles[i].id === id) { row = data.roles[i]; } }
        if (!row) { setControl(team.detail, "text", "Chọn một vị trí để xem việc và ý tưởng."); return; }
        setControl(team.detail, "text", row.name + " · " + row.model + "\nViệc: " + (row.task || "chưa có") + "\n\n" + (row.idea || "Chưa có ý tưởng / kết quả."));
    };
    Bridge.prototype.renderChat = function () {
        var team = this.ui && this.ui.team, data = team && team.data, items = data && data.qa || [], out = [], i, msg, mine, body;
        if (!team || !team.chat) { return; }
        for (i = Math.max(0, items.length - 14); i < items.length; i += 1) {
            msg = items[i]; mine = msg.from === "CEO";
            body = String(msg.text || "").replace(/\r?\n/g, mine ? "\n                    " : "\n    ");
            out.push(mine ? "                    Bạn · " + clock(msg.at) + "  ●\n                    " + body
                : "◆ QA · " + clock(msg.at) + "\n    " + body);
        }
        setControl(team.chat, "text", out.length ? out.join("\n\n") : "Chưa có tin nhắn. Gõ yêu cầu sửa bên dưới rồi bấm Gửi; QA chuyển cho PO điều phối.");
    };
    Bridge.prototype.sendQa = function () {
        var team = this.ui && this.ui.team, text = team ? String(team.input.text).replace(/^\s+|\s+$/g, "") : "", folder, name;
        if (!team || !text) { return; }
        if (text.length > 10000) { this.setUiStatus("Góp ý tối đa 10.000 ký tự."); return; }
        try {
            this.ensureFolder(this.workspaceRoot + "/.ae-codex/team"); folder = this.ensureFolder(this.workspaceRoot + "/.ae-codex/team/qa-inbox");
            name = "qa-" + new Date().getTime() + "-" + Math.floor(Math.random() * 1000000) + ".txt";
            this.writeAtomic(folder.fsName.replace(/\\/g, "/") + "/" + name, text);
            team.input.text = ""; this.log("info", "Đã gửi góp ý cho QA trong VS Code.");
            this.setUiStatus("Đã gửi cho QA · QA chuyển yêu cầu sửa cho PO."); team.lastCheck = 0;
        } catch (qaError) { this.log("error", "Không gửi được góp ý QA: " + this.describeError(qaError)); }
    };
    Bridge.prototype.tick = function (generation) {
        if (!this.running || !this.ready || generation !== this.generation) {
            return;
        }

        try {
            if (this.hideProgressPending) {
                this.hideProgressPending = false;
                this.hideProgress();
            }

            if (this.pendingReport) {
                this.publishPendingReport();
            }
            if (!this.pendingReport && this.pendingCleanupFile) {
                this.retryPendingCleanup();
            }

            var now = new Date().getTime();
            this.reflowUi();
            if (now - this.lastHeartbeat >= 2000) {
                this.writeHeartbeat(
                    "running",
                    this.pendingReport ? "Reporting JSX result" :
                        (this.pendingCleanupFile ? "Cleaning completed job" :
                            (this.busy ? "Executing JSX" : "Waiting for jobs"))
                );
            }

            if (!this.busy && !this.pendingReport && !this.pendingCleanupFile) {
                var inbox = new Folder(this.inboxPath);
                var jobs = inbox.getFiles(function (candidate) {
                    return candidate instanceof File && /\.job$/i.test(candidate.name);
                });

                if (jobs.length > 0) {
                    jobs.sort(function (left, right) {
                        return left.name < right.name ? -1 : (left.name > right.name ? 1 : 0);
                    });
                    this.processJob(jobs[0]);
                } else {
                    if (now - this.bundle.lastPoll >= 2000) { this.bundle.refresh(false); }
                    this.refreshScriptsDisplay();
                    this.refreshTeam(false);
                    this.animateTeam();
                    if (this.library) {
                        this.library.tick();
                        this.refreshLibraryDisplay();
                    }
                }
            }
        } catch (tickError) {
            this.logOnce("listener", "error", "Bridge listener error: " + this.describeError(tickError));
            this.setConnectionStatus(false, "Connection error");
            this.setUiStatus("Bridge error: " + String(tickError));
            try {
                this.writeHeartbeat("error", String(tickError));
            } catch (heartbeatError) {
                // The palette remains visible so the user can see the failure.
            }
        } finally {
            if (this.running && this.ready && generation === this.generation) {
                try {
                    this.scheduleNext(500);
                } catch (scheduleError) {
                    this.log("error", "Bridge listener stopped: " + this.describeError(scheduleError));
                    this.ready = false;
                    this.running = false;
                    this.setConnectionStatus(false, "Listener stopped");
                    this.showProgress();
                    this.setProgress(100, "Listener stopped");
                    this.setUiStatus("Bridge listener stopped:\n" + String(scheduleError));
                    try {
                        this.writeHeartbeat("error", String(scheduleError));
                    } catch (heartbeatError) {
                        // The inline status remains available.
                    }
                }
            }
        }
    };

    // Kết nối lại also picks up a newer installed AE_CodexTeam: the installer moves the pointer in
    // %LOCALAPPDATA%\\AE_CodexTeam\\installation.json; the new engine is loaded into this same panel.
    Bridge.prototype.installedRoot = function () {
        var base = $.getenv("LOCALAPPDATA"), file, text, info;
        if (!base) { return ""; }
        file = new File(base + "/AE_CodexTeam/installation.json");
        if (!file.exists) { return ""; }
        file.encoding = "UTF-8";
        if (!file.open("r")) { return ""; }
        try { text = file.read(); } finally { file.close(); }
        try { info = this.functions.parse(text); } catch (pointerError) { return ""; }
        if (!info || typeof info.runtimeRoot !== "string" || info.state === "uninstalled") { return ""; }
        return (new Folder(info.runtimeRoot)).fsName.replace(/\\/g, "/").replace(/\/$/, "");
    };
    Bridge.prototype.reconnect = function () {
        var root = "", bundle;
        try { root = this.installedRoot(); } catch (installedError) { root = ""; }
        if (root && normalizePath(root) !== normalizePath(this.workspaceRoot)) {
            bundle = new File(root + "/jsx/AECT Engine.jsx");
            if (!bundle.exists) { this.log("warning", "Bản cài mới thiếu engine: " + bundle.fsName); }
            else if (this.busy || this.pendingReport || this.pendingCleanupFile || this.scheduledCallbackActive || this.connectionActionActive) {
                this.log("warning", "Có bản mới nhưng còn lệnh AE đang xử lý; chờ xong rồi bấm Kết nối lại. Không chạy lại lệnh.");
                this.setUiStatus("Có bản cập nhật · chờ lệnh hiện tại xong rồi bấm Kết nối lại.");
                return;
            } else if (this.window instanceof Panel) {
                this.log("info", "Đang nạp bản mới: " + root);
                $.global.__aectPendingSwitch = { root: root, host: this.window };
                app.scheduleTask("if ($.global.__aectRunSwitch) { $.global.__aectRunSwitch(); }", 30, false);
                return;
            }
        }
        this.start("Reconnect button");
    };
    Bridge.prototype.start = function (reason) {
        if (this.connectionActionActive || this.scheduledCallbackActive ||
                (this.busy && !this.pendingReport && !this.pendingCleanupFile)) {
            this.logOnce("reconnect-busy", "warning", "Reconnect deferred: a bridge operation is still active; session=" + this.sessionNonce);
            return false;
        }
        if (!this.ensureListenerOwner(reason || "start", true)) { return false; }
        this.connectionActionActive = true;
        try {
            // A ScriptUI panel can be closed while its named engine survives.
            // Always replace the old task instead of trusting a stale running
            // flag or task ID when the panel is opened again.
            if (this.taskId) {
                try {
                    app.cancelTask(this.taskId);
                } catch (cancelError) {
                    // The previous task may already have expired.
                }
            }
            this.generation += 1;
            this.taskToken += 1;
            if (this.library) { this.library.stop(); }
            this.taskId = 0;
            this.taskDueAt = 0;
            this.running = true;
            this.manualStop = false;
            this.ready = false;
            this.busy = this.pendingReport !== null || this.pendingCleanupFile !== null;
            this.setConnectionStatus(false, "Connecting...");
            this.startupStep = 0;
            this.hideProgressPending = false;
            this.lastHeartbeat = 0;
            this.connectionRecoveryPending = true;
            this.showProgress();
            this.setProgress(0, "Initializing");
            this.setUiStatus("Bridge " + BRIDGE_VERSION + " starting...");
            this.log("info", "Connecting automatically to workspace bridge; session=" + this.sessionNonce +
                "; generation=" + this.generation + "; reason=" + String(reason || "auto start").substring(0, 80));
            this.scheduleNext(60);
            return true;
        } catch (startError) {
            this.failStartup(startError);
            return false;
        } finally {
            this.connectionActionActive = false;
        }
    };

    Bridge.prototype.stop = function () {
        this.manualStop = true;
        this.log("info", "Bridge stopped by user");
        this.generation += 1;
        this.taskToken += 1;
        if (this.library) { this.library.stop(); }
        this.refreshLibraryDisplay();
        if (this.taskId) {
            try {
                app.cancelTask(this.taskId);
            } catch (cancelError) {
                // Continue stopping even if the task already ended.
            }
        }

        this.taskId = 0;
        this.taskDueAt = 0;
        this.running = false;
        this.ready = false;
        this.setConnectionStatus(false, "Disconnected");
        this.startupStep = 0;
        this.hideProgressPending = false;
        this.setProgress(0, "Stopped");
        this.hideProgress();
        try {
            this.writeHeartbeat("stopped", "Bridge stopped by user");
        } catch (heartbeatError) {
            // There may be no file permission while stopping.
        }
        this.setUiStatus("Bridge stopped");
    };

    Bridge.prototype.showWindow = function () {
        this.recoverScheduled("panel shown");
        if (this.window) {
            if (this.window instanceof Window) {
                this.window.show();
            } else {
                this.reflowUi();
            }
        }
    };

    var bridge, preserveConnection = false;
    if (existingBridge && existingBridge.version === BRIDGE_VERSION && sameWorkspace) {
        bridge = existingBridge; preserveConnection = !!bridge.hadUi;
    }
    else {
        if (existingBridge && existingBridge.stop) { try { existingBridge.stop(); } catch (oldBridgeError) {} }
        if (existingBridge) { releaseBridgeUi(existingBridge); }
        bridge = new Bridge(WORKSPACE_ROOT);
    }
    $.global[GLOBAL_NAME] = bridge;
    if (autoStartOnly) { bridge.start(); return; }
    if (bridge.window || bridge.ui) { releaseBridgeUi(bridge); }
    var palette = (thisObject instanceof Panel) ? thisObject : new Window("palette", "AE_CodexTeam Bridge", undefined, { resizeable: true });
    palette.orientation = "column"; palette.alignChildren = ["fill", "top"];
    palette.margins = 9; palette.spacing = 6;
    palette.preferredSize = [440, 310]; palette.minimumSize = [340, 220];
    if (palette instanceof Window) { palette.size = [440, 310]; }

    // ScriptUI keeps its native controls/keyboard behavior. Styling is optional
    // so an AE host without custom graphics can still connect and display errors.
    var cartoonInk = [0.92, 0.94, 0.98, 1];
    // AE_CodexTeam theme: deep violet panel with a violet title band, so it is never
    // confused with the grey/blue Codex AE panel when both are docked side by side.
    var cartoonPaper = [0.12, 0.10, 0.18, 1];
    var cartoonCard = [0.36, 0.22, 0.62, 1];
    var cartoonField = [0.08, 0.06, 0.12, 1];
    var teamBand = [0.69, 0.53, 1.0, 1];
    function cartoonSurface(control, color, fontName, fontSize) {
        try {
            if (fontName) { control.graphics.font = ScriptUI.newFont(fontName, "REGULAR", fontSize); }
        } catch (fontThemeError) { /* Use the host font if unavailable. */ }
        try {
            var graphics = control.graphics;
            graphics.backgroundColor = graphics.newBrush(graphics.BrushType.SOLID_COLOR, color);
            graphics.foregroundColor = graphics.newPen(graphics.PenType.SOLID_COLOR, cartoonInk, 1);
            graphics.disabledBackgroundColor = graphics.newBrush(graphics.BrushType.SOLID_COLOR, color);
            graphics.disabledForegroundColor = graphics.newPen(graphics.PenType.SOLID_COLOR, [0.62, 0.66, 0.74, 1], 1);
        } catch (themeError) { /* Native host styling remains usable. */ }
    }
    // EditText owns selection, keyboard and wheel scrolling. ScriptUI calls this
    // option "scrollable"; "scrolling" is ignored. Keep one native vertical rail
    // per pane, without extra frames or a second custom scroll state. Its OS rail
    // color is not exposed by ScriptUI graphics.
    function cartoonText(parent, text, readonly) {
        var control = parent.add("edittext", undefined, text || "", {
            multiline: true, readonly: !!readonly, scrollable: true, borderless: true
        });
        cartoonSurface(control, cartoonField, "Segoe UI", 12);
        return control;
    }
    function cartoonButton(control, color) {
        control.preferredSize = [110, 32];
        cartoonSurface(control, color, "Segoe UI", 12);
        // Leave painting to AE. Custom onDraw can lose the entire button after
        // docking or a native graphics reset, including its fallback drawing.
        // Native controls retain disabled, keyboard and focus behavior without
        // cached paint handles or a redraw timer.
    }
    function cartoonDialog(dialog, search, list, detail, close) {
        cartoonSurface(dialog, cartoonPaper);
        cartoonSurface(search, cartoonField, "Segoe UI", 12);
        cartoonSurface(list, cartoonField, "Segoe UI", 12);
        cartoonSurface(detail, cartoonCard, "Segoe UI", 12);
        cartoonButton(close, [0.27, 0.24, 0.43, 1]);
    }
    cartoonSurface(palette, cartoonPaper);
    var title = palette.add("statictext", undefined, "◆ AE_CodexTeam Bridge · TEAM");
    title.helpTip = "Bản AE_CodexTeam (MCP ae_codexteam, %LOCALAPPDATA%\\AE_CodexTeam). Không phải panel Codex Bridge của Codex AE.";
    var connectionText = palette.add("statictext", undefined, "Đang kết nối After Effects…");
    connectionText.helpTip = "Kết nối tương thích ScriptUI. Plugin native .aex đang chờ SDK; chưa thay thế engine này.";
    var statusText = palette.add("statictext", undefined, "Đang khởi động cầu nối…", { multiline: true });
    var scriptsText = palette.add("statictext", undefined, "Đang tải danh mục công cụ…", { multiline: true });
    var libraryText = palette.add("statictext", undefined, "Thư viện chỉ cập nhật khi bạn bấm nút.", { multiline: true });
    var libraryOptions = palette.add("group");
    var effectsToggle = libraryOptions.add("checkbox", undefined, "Effects");
    var sfxToggle = libraryOptions.add("checkbox", undefined, "SFX");
    var sfxFoldersButton = libraryOptions.add("button", undefined, "Thư mục…");
    var refreshLibraryButton = libraryOptions.add("button", undefined, "Cập nhật");
    effectsToggle.value = false; sfxToggle.value = false;
    effectsToggle.enabled = sfxToggle.enabled = sfxFoldersButton.enabled = refreshLibraryButton.enabled = false;
    effectsToggle.helpTip = "Chọn kiểm kê effects. Không tắt effects hay layer trong project; không tự quét khi đổi lựa chọn.";
    sfxToggle.helpTip = "Chọn kiểm kê SFX đã cho phép. Không tắt âm thanh trong project; không tự quét khi đổi lựa chọn.";
    refreshLibraryButton.helpTip = "Chỉ lập chỉ mục thư viện theo yêu cầu; không bật/tắt effects, layer hay âm thanh trong project.";
    sfxFoldersButton.helpTip = "Thêm hoặc đổi thư mục SFX trên ổ đĩa. Chỉ lưu lựa chọn; không tự quét, tự bật SFX hay xóa dữ liệu.";
    effectsToggle.onClick = function () { bridge.setLibraryEnabled("effects", !!effectsToggle.value); };
    sfxToggle.onClick = function () { bridge.setLibraryEnabled("sfx", !!sfxToggle.value); };
    refreshLibraryButton.onClick = function () { bridge.requestLibraryRefresh(); };
    sfxFoldersButton.onClick = function () { bridge.showSfxFolders(); };
    var buttons = palette.add("group");
    var viewFunctionsButton = buttons.add("button", undefined, "Công cụ");
    var viewScriptsButton = buttons.add("button", undefined, "Kho tương thích");
    var startButton = buttons.add("button", undefined, "Kết nối lại");
    var stopButton = buttons.add("button", undefined, "Dừng");
    viewFunctionsButton.onClick = function () { bridge.showFunctions(); };
    viewScriptsButton.onClick = function () { bridge.showScripts(); };
    startButton.onClick = function () {
        if (bridge.ui !== attachedUi || bridge.window !== palette) { return; }
        bridge.reconnect();
    };
    stopButton.onClick = function () { bridge.stop(); };
    var progressGroup = palette.add("group");
    var progressText = progressGroup.add("statictext", undefined, "Đang tải · 0%");
    var progressBar = progressGroup.add("progressbar", undefined, 0, 100);
    var logPanel = palette.add("panel", undefined, "Nhật ký làm việc");
    var logView = cartoonText(logPanel, "", true);
    var clearLogButton = logPanel.add("button", undefined, "Xóa nhật ký hiển thị");
    clearLogButton.onClick = function () { bridge.clearLog(); };
    var footer = palette.add("group");
    var logToggle = footer.add("button", undefined, "Nhật ký ▸");
    var logSummary = footer.add("statictext", undefined, "Đang kết nối…");
    logToggle.onClick = function () {
        if (bridge.ui !== attachedUi || bridge.window !== palette) { return; }
        bridge.ui.logExpanded = !bridge.ui.logExpanded; bridge.reflowUi(true);
    };
    // Team view (VS Code Explorer style): the 9 positions with model and live state from VS Code,
    // their current idea/result, and a QA box that sends feedback to VS Code.
    var teamHeader = palette.add("statictext", undefined, "TEAM · 9 VỊ TRÍ");
    var teamList = palette.add("listbox", undefined, [], { numberOfColumns: 4, showHeaders: true,
        columnTitles: ["#", "Vị trí", "Model", "Trạng thái"], columnWidths: [28, 190, 150, 200] });
    var teamDetail = cartoonText(palette, "Mở bảng AE_CodexTeam trong VS Code để hiện trạng thái team.", true);
    var chatHeader = palette.add("statictext", undefined, "CHAT VỚI QA · yêu cầu sửa được chuyển cho PO");
    var chatView = cartoonText(palette, "Chưa có tin nhắn. Gõ yêu cầu sửa bên dưới rồi bấm Gửi.", true);
    var qaInput = palette.add("edittext", undefined, "");
    var qaSend = palette.add("button", undefined, "Gửi ➤");
    qaInput.helpTip = "Góp ý hoặc câu hỏi cho QA. VS Code nhận khi bảng AE_CodexTeam đang mở; không chỉnh project.";
    teamList.onChange = function () { if (bridge.ui === attachedUi) { bridge.renderTeamDetail(); } };
    qaSend.onClick = function () { if (bridge.ui === attachedUi) { bridge.sendQa(); } };
    cartoonSurface(palette, cartoonPaper); cartoonSurface(title, cartoonPaper, "Segoe UI", 15);
    try { title.graphics.foregroundColor = title.graphics.newPen(title.graphics.PenType.SOLID_COLOR, teamBand, 1); } catch (titleInkError) {}
    cartoonSurface(connectionText, cartoonPaper, "Segoe UI", 12); cartoonSurface(statusText, cartoonCard, "Segoe UI", 11);
    cartoonSurface(scriptsText, cartoonPaper, "Segoe UI", 11); cartoonSurface(libraryText, cartoonPaper, "Segoe UI", 11);
    cartoonSurface(effectsToggle, cartoonPaper, "Segoe UI", 11); cartoonSurface(sfxToggle, cartoonPaper, "Segoe UI", 11);
    cartoonSurface(progressText, cartoonPaper, "Segoe UI", 11); cartoonSurface(logPanel, cartoonCard);
    cartoonSurface(logSummary, cartoonPaper, "Segoe UI", 10);
    cartoonSurface(teamHeader, cartoonPaper, "Segoe UI", 11); cartoonSurface(chatHeader, cartoonPaper, "Segoe UI", 11);
    try { chatHeader.graphics.foregroundColor = chatHeader.graphics.newPen(chatHeader.graphics.PenType.SOLID_COLOR, [0.69, 0.53, 1.0, 1], 1); } catch (chatHeaderInk) {}
    try { teamHeader.graphics.foregroundColor = teamHeader.graphics.newPen(teamHeader.graphics.PenType.SOLID_COLOR, [0.55, 0.62, 0.72, 1], 1); } catch (teamHeaderInk) {}
    cartoonSurface(teamList, cartoonField, "Consolas", 12); cartoonSurface(qaInput, cartoonField, "Segoe UI", 12);
    cartoonButton(qaSend, [0.0, 0.40, 0.76, 1]);
    cartoonButton(viewFunctionsButton, [0.19, 0.29, 0.46, 1]); cartoonButton(viewScriptsButton, [0.29, 0.24, 0.44, 1]);
    cartoonButton(startButton, [0.16, 0.34, 0.27, 1]); cartoonButton(stopButton, [0.43, 0.22, 0.23, 1]);
    cartoonButton(clearLogButton, [0.35, 0.29, 0.17, 1]); cartoonButton(logToggle, [0.22, 0.25, 0.31, 1]);
    cartoonButton(refreshLibraryButton, [0.19, 0.29, 0.46, 1]);
    cartoonButton(sfxFoldersButton, [0.29, 0.24, 0.44, 1]);
    try {
        bridge.connectionPens = {
            connected: connectionText.graphics.newPen(connectionText.graphics.PenType.SOLID_COLOR, [0.47, 0.88, 0.66, 1], 1),
            disconnected: connectionText.graphics.newPen(connectionText.graphics.PenType.SOLID_COLOR, [1, 0.55, 0.52, 1], 1)
        };
    } catch (connectionThemeError) { bridge.connectionPens = null; }
    bridge.window = palette; bridge.statusText = statusText; bridge.connectionText = connectionText;
    try { palette.__aeCodexTeamBridgeOwnerV1 = bridge; } catch (hostAnchorError) {}
    bridge.scriptsText = scriptsText; bridge.libraryText = libraryText;
    bridge.progressGroup = progressGroup; bridge.progressText = progressText; bridge.progressBar = progressBar;
    bridge.logView = logView; bridge.logSummary = logSummary;
    bridge.libraryControls = { effects: effectsToggle, sfx: sfxToggle, folders: sfxFoldersButton, refresh: refreshLibraryButton };
    bridge.ui = { logExpanded: false, logVisible: false, layoutSignature: "" };
    bridge.logViewRevision = -1;
    bridge.hadUi = true;
    var attachedUi = bridge.ui;
    bridge.ui.actions = [
        { control: effectsToggle, action: "effects" }, { control: sfxToggle, action: "sfx" },
        { control: sfxFoldersButton, action: "folders" }, { control: refreshLibraryButton, action: "refresh" },
        { control: viewFunctionsButton, action: "functions" }, { control: viewScriptsButton, action: "scripts" },
        { control: startButton, action: "start" }, { control: stopButton, action: "stop" },
        { control: clearLogButton, action: "clearLog" }, { control: logToggle, action: "toggleLog" }, { control: qaSend, action: "qa" }
    ];
    bridge.ownedUiRoots = [title, connectionText, statusText, scriptsText, libraryText, libraryOptions, buttons, progressGroup, logPanel, footer, teamHeader, teamList, teamDetail, qaInput, qaSend, chatHeader, chatView];
    bridge.ui.team = { header: teamHeader, list: teamList, detail: teamDetail, input: qaInput, send: qaSend, chatHeader: chatHeader, chat: chatView, stamp: "", data: null, lastCheck: 0 };
    // TOOLS_LAYOUT_BEGIN: idle ticks reuse bounds and never rebuild controls.
    function setToolsBounds(control, bounds) {
        var actual = control.bounds, i, same = !!actual;
        for (i = 0; same && i < 4; i += 1) { if (Number(actual[i]) !== bounds[i]) { same = false; } }
        if (same) { return; }
        control.minimumSize = [0, 0]; control.maximumSize = [100000, 100000]; control.bounds = bounds;
    }
    bridge.ui.reflow = function (force) {
        if (bridge.ui !== attachedUi || bridge.window !== palette) { return; }
        var size = palette.size, w = size && Number(typeof size.width === "number" ? size.width : size[0]),
            h = size && Number(typeof size.height === "number" ? size.height : size[1]),
            ui = bridge.ui, m = 9, gap = 6, width, signature, footerY, logHeight, logY, buttonY, libraryY, progressY, infoBottom, buttonWidth, i, controls;
        if (!isFinite(w) || !isFinite(h) || w < 340 || h < 220) { return; }
        signature = w + "|" + h + "|" + ui.logExpanded + "|" + progressGroup.visible;
        if (!force && signature === ui.layoutSignature) { return; }
        controls = [viewFunctionsButton, viewScriptsButton, startButton, stopButton];
        if (w >= 560 && h >= 260) {
            // AE_CodexTeam layout (differs from Codex AE's stacked bar): left action sidebar,
            // right column with status on top and the work log always open below.
            var sb = 176, x = m + sb + gap * 2, rw = w - m - x, y = m, side = [startButton, stopButton, viewFunctionsButton, viewScriptsButton], sy, logTop, progressH;
            setToolsBounds(title, [m, m, w - m, m + 24]);
            sy = m + 32;
            sy += side.length * (30 + gap);
            sy += 8;
            setToolsBounds(libraryOptions, [m, sy, m + sb, sy + 24 + gap + 26 + gap + 26]);
            setToolsBounds(effectsToggle, [0, 0, 80, 24]); setToolsBounds(sfxToggle, [86, 0, sb, 24]);
            setToolsBounds(sfxFoldersButton, [0, 24 + gap, sb, 24 + gap + 26]);
            setToolsBounds(refreshLibraryButton, [0, 24 + gap * 2 + 26, sb, 24 + gap * 2 + 52]);
            setToolsBounds(buttons, [m, m + 32, m + sb, sy - 8]);
            for (i = 0; i < side.length; i += 1) { setToolsBounds(side[i], [0, i * (30 + gap), sb, i * (30 + gap) + 30]); }
            setToolsBounds(libraryText, [m, sy + 90, m + sb, Math.min(h - m, sy + 160)]);
            setControl(scriptsText, "visible", false); setToolsBounds(scriptsText, [0, 0, 0, 0]);
            y = m + 32;
            setToolsBounds(connectionText, [x, y, w - m, y + 20]); y += 22;
            setToolsBounds(statusText, [x, y, w - m, y + 32]); y += 36;
            footerY = h - m - 26; progressH = progressGroup.visible ? 30 : 0;
            var teamControls = [teamHeader, teamList, teamDetail, qaInput, qaSend, chatHeader, chatView], bottom = footerY - gap - progressH - (progressH ? gap : 0),
                split = rw >= 760, tw = split ? Math.floor((rw - gap * 2) * 0.55) : rw, cx = split ? x + tw + gap * 2 : x, top = y, avail = bottom - y, listH, detailH, chatH;
            for (i = 0; i < teamControls.length; i += 1) { setControl(teamControls[i], "visible", true); }
            if (split) {
                listH = Math.max(90, Math.min(214, Math.floor(avail * 0.62))); detailH = Math.max(36, avail - 20 - listH - gap);
                setToolsBounds(teamHeader, [x, top, x + tw, top + 18]);
                setToolsBounds(teamList, [x, top + 20, x + tw, top + 20 + listH]);
                setToolsBounds(teamDetail, [x, top + 20 + listH + gap, x + tw, bottom]);
                setToolsBounds(chatHeader, [cx, top, w - m, top + 18]);
                setToolsBounds(chatView, [cx, top + 20, w - m, bottom - 26 - gap]);
                setToolsBounds(qaInput, [cx, bottom - 26, w - m - 76, bottom]); setToolsBounds(qaSend, [w - m - 70, bottom - 26, w - m, bottom]);
                y = bottom;
            } else {
                listH = Math.max(80, Math.min(196, Math.floor(avail * 0.38))); detailH = Math.max(34, Math.min(80, Math.floor(avail * 0.16))); chatH = Math.max(60, avail - listH - detailH - 20 * 2 - 26 - gap * 4);
                setToolsBounds(teamHeader, [x, y, w - m, y + 18]); y += 20;
                setToolsBounds(teamList, [x, y, w - m, y + listH]); y += listH + gap;
                setToolsBounds(teamDetail, [x, y, w - m, y + detailH]); y += detailH + gap;
                setToolsBounds(chatHeader, [x, y, w - m, y + 18]); y += 20;
                setToolsBounds(chatView, [x, y, w - m, y + chatH]); y += chatH + gap;
                setToolsBounds(qaInput, [x, y, w - m - 76, y + 26]); setToolsBounds(qaSend, [w - m - 70, y, w - m, y + 26]); y += 26 + gap;
            }
            setToolsBounds(progressGroup, [x, footerY - gap - progressH, w - m, footerY - gap]);
            setToolsBounds(progressText, [0, 0, rw, 15]); setToolsBounds(progressBar, [0, 18, rw, 27]);
            logTop = y; logHeight = Math.max(0, footerY - gap - progressH - (progressH ? gap : 0) - logTop);
            setControl(logPanel, "visible", logHeight >= 60);
            if (logHeight < 60) { logHeight = 0; }
            setToolsBounds(logPanel, [x, logTop, w - m, logTop + logHeight]);
            setToolsBounds(logView, [6, 17, rw - 6, Math.max(17, logHeight - 29)]);
            setToolsBounds(clearLogButton, [6, Math.max(17, logHeight - 26), Math.min(rw - 6, 184), Math.max(17, logHeight - 3)]);
            setToolsBounds(footer, [x, footerY, w - m, footerY + 26]); setControl(logToggle, "visible", false);
            setToolsBounds(logToggle, [0, 0, 0, 0]); setToolsBounds(logSummary, [0, 3, rw, 24]);
            ui.layoutSignature = signature;
            if (ui.logVisible !== (logHeight > 0)) {
                ui.logVisible = logHeight > 0;
                if (!ui.logVisible) { setControl(logView, "text", ""); bridge.logViewRevision = -1; } else { bridge.refreshLog(); }
            }
            return;
        }
        setControl(logToggle, "visible", true); setControl(scriptsText, "visible", true);
        for (i = 0; i < 7; i += 1) { setControl([teamHeader, teamList, teamDetail, qaInput, qaSend, chatHeader, chatView][i], "visible", false); }
        width = w - m * 2; footerY = h - m - 26;
        logHeight = ui.logExpanded && h >= 300 ? Math.min(140, Math.max(80, h - 252)) : 0;
        logY = footerY - gap - logHeight;
        progressY = logY - (progressGroup.visible ? 34 : 0) - gap;
        buttonY = progressY - 30 - gap; libraryY = buttonY - 24 - gap; infoBottom = libraryY - gap;
        setToolsBounds(title, [m, m, w - m, m + 23]); setToolsBounds(connectionText, [m, 37, w - m, 57]);
        setToolsBounds(statusText, [m, 63, w - m, Math.max(63, Math.min(94, infoBottom))]);
        setToolsBounds(scriptsText, [m, Math.min(99, infoBottom), w - m, Math.min(132, infoBottom)]);
        setToolsBounds(libraryText, [m, Math.min(136, infoBottom), w - m, Math.max(Math.min(136, infoBottom), infoBottom)]);
        setToolsBounds(libraryOptions, [m, libraryY, w - m, libraryY + 24]);
        setToolsBounds(effectsToggle, [0, 0, 64, 24]); setToolsBounds(sfxToggle, [68, 0, 112, 24]);
        setToolsBounds(sfxFoldersButton, [118, 0, 198, 24]); setToolsBounds(refreshLibraryButton, [204, 0, width, 24]);
        setToolsBounds(buttons, [m, buttonY, w - m, buttonY + 30]);
        buttonWidth = Math.floor((width - gap * 3) / 4);
        for (i = 0; i < controls.length; i += 1) { setToolsBounds(controls[i], [i * (buttonWidth + gap), 0, i === 3 ? width : i * (buttonWidth + gap) + buttonWidth, 30]); }
        setToolsBounds(progressGroup, [m, progressY, w - m, progressY + (progressGroup.visible ? 28 : 0)]);
        setToolsBounds(progressText, [0, 0, width, 15]); setToolsBounds(progressBar, [0, 18, width, 27]);
        setControl(logPanel, "visible", logHeight > 0); setToolsBounds(logPanel, [m, logY, w - m, logY + logHeight]);
        setToolsBounds(logView, [6, 17, width - 6, Math.max(17, logHeight - 29)]);
        setToolsBounds(clearLogButton, [6, Math.max(17, logHeight - 26), Math.min(width - 6, 184), Math.max(17, logHeight - 3)]);
        setToolsBounds(footer, [m, footerY, w - m, footerY + 26]); setToolsBounds(logToggle, [0, 0, 96, 26]);
        setToolsBounds(logSummary, [103, 3, width, 24]); setControl(logToggle, "text", logHeight > 0 ? "Nhật ký ▾" : "Nhật ký ▸");
        setControl(logToggle, "helpTip", ui.logExpanded && !logHeight ? "Kéo panel cao hơn để mở nhật ký." : "Mở / thu gọn nhật ký công việc và lỗi.");
        ui.layoutSignature = signature;
        if (ui.logVisible !== (logHeight > 0)) {
            ui.logVisible = logHeight > 0;
            if (!ui.logVisible) { setControl(logView, "text", ""); bridge.logViewRevision = -1; }
            else { bridge.refreshLog(); }
        }
    };
    // TOOLS_LAYOUT_END
    // AE can request layout again after docking without changing panel size.
    // Keep one owner of bounds instead of letting the default auto-layout
    // overwrite the manual layout behind its unchanged-size cache.
    bridge.ui.nativeLayout = palette.layout;
    bridge.ui.layoutManager = {
        layout: function () { if (bridge.ui === attachedUi && bridge.window === palette) { bridge.reflowUi(true); } },
        resize: function () { if (bridge.ui === attachedUi && bridge.window === palette) { bridge.reflowUi(true); } }
    };
    palette.layout = bridge.ui.layoutManager;
    if (palette instanceof Window) {
        palette.onClose = function () {
            if (bridge.ui !== attachedUi || bridge.window !== palette) { return true; }
            bridge.stop(); releaseBridgeUi(bridge); $.global[GLOBAL_NAME] = null; return true;
        };
    }
    palette.onActivate = palette.onResizing = palette.onResize = function () {
        if (bridge.ui === attachedUi && bridge.window === palette) { bridge.reflowUi(true); }
    };
    rewireUiActions(bridge);
    bridge.refreshLog();
    try { bridge.bundle.refresh(false); bridge.bundle.loadInstallation(); }
    catch (bundleError) { bridge.bundle.error = String(bundleError); bridge.log("error", "Không tải được bộ công cụ: " + String(bundleError)); }
    bridge.refreshScriptsDisplay(); statusText.text = bridge.lastStatus || "Đang khởi động cầu nối…";
    progressText.text = bridge.progressLabel + " · " + bridge.progressValue + "%"; progressBar.value = bridge.progressValue;
    if (palette instanceof Window) { palette.center(); palette.show(); } else { palette.layout.layout(true); }
    bridge.reflowUi(true);
    if (preserveConnection) {
        bridge.setConnectionStatus(bridge.running && bridge.ready && !bridge.connectionRecoveryPending && bridge.lastHeartbeat > 0 &&
            new Date().getTime() - bridge.lastHeartbeat <= 10000, bridge.running ?
            (bridge.ready ? "Connected / Ready for Codex" : "Connecting...") : "Disconnected");
        bridge.refreshConnectionHealth();
        bridge.refreshLibraryDisplay();
        if (!bridge.running || (bridge.ready && !bridge.busy && !bridge.pendingReport)) { bridge.hideProgress(); }
    } else if (preserveReplacementStop) { bridge.stop(); }
    else { bridge.start(); }
}(this));

/* AECT_BUNDLE_DATA
B	Codex Library.jsx	0	18	621544383		4177896842
M	m00001	19	45386	1398758840
m00001%3A0%3A43106
"#target aftereffects\r\n/* Read-only, incremental inventories used by Codex Bridge. No project mutations. *\/\r\n(function () {\r\n    function stringify(value) {\r\n        var i, parts = [], key;\r\n        if (value === null || typeof value === \"undefined\") { return \"null\"; }\r\n        if (typeof value === \"string\") {\r\n            return '\"' + value.replace(/[\\\\\"\\x00-\\x1f]/g, function (c) {\r\n                var n = c.charCodeAt(0).toString(16);\r\n                if (c === \"\\\\\") { return \"\\\\\\\\\"; }\r\n                if (c === '\"') { return '\\\\\"'; }\r\n                while (n.length < 4) { n = \"0\" + n; }\r\n                return \"\\\\u\" + n;\r\n            }) + '\"';\r\n        }\r\n        if (typeof value === \"number\") { return isFinite(value) ? String(value) : \"null\"; }\r\n        if (typeof value === \"boolean\") { return value ? \"true\" : \"false\"; }\r\n        if (value instanceof Array) {\r\n            for (i = 0; i < value.length; i += 1) { parts.push(stringify(value[i])); }\r\n            return \"[\" + parts.join(\",\") + \"]\";\r\n        }\r\n        for (key in value) {\r\n            if (value.hasOwnProperty(key)) { parts.push(stringify(key) + \":\" + stringify(value[key])); }\r\n        }\r\n        return \"{\" + parts.join(\",\") + \"}\";\r\n    }\r\n\r\n    // External status/config is data only: never eval JSON or shell fragments.\r\n    function parseJson(text) {\r\n        var at = 0;\r\n        function space() { while (at < text.length && /\\s/.test(text.charAt(at))) { at += 1; } }\r\n        function fail() { throw new Error(\"Invalid library JSON at \" + at); }\r\n        function string() {\r\n            var out = \"\", c, hex;\r\n            at += 1;\r\n            while (at < text.length) {\r\n                c = text.charAt(at++);\r\n                if (c === '\"') { return out; }\r\n                if (c.charCodeAt(0) < 32) { fail(); }\r\n                if (c === \"\\\\\") {\r\n                    c = text.charAt(at++);\r\n                    if (c === \"u\") {\r\n                        hex = text.substr(at, 4);\r\n                        if (!/^[0-9a-fA-F]{4}$/.test(hex)) { fail(); }\r\n                        out += String.fromCharCode(parseInt(hex, 16)); at += 4;\r\n                    } else if (c === \"n\") { out += \"\\n\"; }\r\n                    else if (c === \"r\") { out += \"\\r\"; }\r\n                    else if (c === \"t\") { out += \"\\t\"; }\r\n                    else if (c === \"b\") { out += \"\\b\"; }\r\n                    else if (c === \"f\") { out += \"\\f\"; }\r\n                    else if (c === '\"' || c === \"\\\\\" || c === \"/\") { out += c; }\r\n                    else { fail(); }\r\n                } else { out += c; }\r\n            }\r\n            fail();\r\n        }\r\n        function value(depth) {\r\n            var c, out, key, number;\r\n            if (depth > 30) { fail(); }\r\n            space(); c = text.charAt(at);\r\n            if (c === '\"') { return string(); }\r\n            if (c === \"{\" || c === \"[\") {\r\n                at += 1; out = c === \"{\" ? {} : []; space();\r\n                if (text.charAt(at) === (c === \"{\" ? \"}\" : \"]\")) { at += 1; return out; }\r\n                while (at < text.length) {\r\n                    if (c === \"{\") {\r\n                        if (text.charAt(at) !== '\"') { fail(); }\r\n                        key = string();\r\n                        if (key === \"__proto__\" || key === \"constructor\" || key === \"prototype\" || key === \"hasOwnProperty\" || out.hasOwnProperty(key)) { fail(); }\r\n                        space(); if (text.charAt(at++) !== \":\") { fail(); }\r\n                        out[key] = value(depth + 1);\r\n                    } else { out.push(value(depth + 1)); }\r\n                    space();\r\n                    if (text.charAt(at) === (c === \"{\" ? \"}\" : \"]\")) { at += 1; return out; }\r\n                    if (text.charAt(at++) !== \",\") { fail(); }\r\n                    space();\r\n                }\r\n                fail();\r\n            }\r\n            if (text.substr(at, 4) === \"true\") { at += 4; return true; }\r\n            if (text.substr(at, 5) === \"false\") { at += 5; return false; }\r\n            if (text.substr(at, 4) === \"null\") { at += 4; return null; }\r\n            number = text.substr(at).match(/^-?(?:0|[1-9][0-9]*)(?:\\.[0-9]+)?(?:[eE][+-]?[0-9]+)?/);\r\n            if (number) { at += number[0].length; out = Number(number[0]); if (!isFinite(out)) { fail(); } return out; }\r\n            fail();\r\n        }\r\n        var result = value(0); space(); if (at !== text.length) { fail(); } return result;\r\n    }\r\n    function readJson(path) {\r\n        var f = new File(path), data;\r\n        if (!f.exists) { return null; }\r\n        if (f.length > 262144) { throw new Error(\"Library metadata exceeds size limit\"); }\r\n        f.encoding = \"UTF-8\";\r\n        if (!f.open(\"r\")) { throw new Error(\"Cannot read library metadata: \" + path); }\r\n        try { data = f.read(); } finally { f.close(); }\r\n        return parseJson(data.replace(/^\\uFEFF/, \"\"));\r\n    }\r\n    function clean(value) { return String(value).replace(/[\\t\\r\\n]/g, \" \"); }\r\n    function catalogPath(status) {\r\n        var session = status.catalogSessionId || status.sessionId, request = status.catalogRequestId || status.requestId;\r\n        if (typeof session !== \"string\" || !/^[A-Za-z0-9-]{8,80}$/.test(session) ||\r\n                typeof request !== \"string\" || !/^[A-Za-z0-9-]{8,80}$/.test(request)) { throw new Error(\"Invalid SFX catalog identity\"); }\r\n        var expected = \".ae-codex/library/sessions/\" + session + \"/sfx-\" + request + \".jsonl\";\r\n        if (status.catalogRelativePath !== expected) { throw new Error(\"Invalid SFX catalog path\"); }\r\n        return expected;\r\n    }\r\n    function safeValue(p) {\r\n        try {\r\n            if (p.propertyValueType === PropertyValueType.CUSTOM_VALUE || p.propertyValueType === PropertyValueType.NO_VALUE) { return \"\"; }\r\n            return clean(p.value);\r\n        } catch (e) { return \"unavailable\"; }\r\n    }\r\n    function walkStep(stack, lines) {\r\n        var frame = stack[stack.length - 1], p, range = \"\";\r\n        if (frame.index > frame.group.numProperties) { stack.pop(); return; }\r\n        p = frame.group.property(frame.index++); if (!p) { return; }\r\n        if (p.propertyType === PropertyType.PROPERTY) {\r\n            try {\r\n                if (p.hasMin) { range += \"min=\" + p.minValue + \" \"; }\r\n                if (p.hasMax) { range += \"max=\" + p.maxValue; }\r\n            } catch (rangeError) { range = \"unavailable\"; }\r\n        }\r\n        lines.push(\"PARAM\\t\" + clean(frame.path) + \"\\t\" + clean(p.matchName) + \"\\t\" + clean(p.name) + \"\\t\" + p.propertyType + \"\\t\" + range + \"\\t\" + (p.propertyType === PropertyType.PROPERTY ? safeValue(p) : \"\"));\r\n        if (p.propertyType !== PropertyType.PROPERTY && frame.depth < 8) {\r\n            stack.push({ group: p, path: frame.path + \"/\" + p.matchName, index: 1, depth: frame.depth + 1 });\r\n        }\r\n    }\r\n    function count(value) { return typeof value === \"number\" && isFinite(value) && value >= 0 && value === Math.floor(value); }\r\n    function configPreferences(config) {\r\n        var result = { effectsEnabled: true, sfxEnabled: false, manualRefresh: true };\r\n        if (config === null) { return result; }\r\n        if (!config || config instanceof Array || typeof config !== \"object\" || config.schemaVersion !== 1) { throw new Error(\"Invalid library configuration\"); }\r\n        if (typeof config.effects !== \"undefined\") {\r\n            if (!config.effects || config.effects instanceof Array || typeof config.effects !== \"object\") { throw new Error(\"Invalid library effects configuration\"); }\r\n            if (typeof config.effects.enabled !== \"undefined\" && typeof config.effects.enabled !== \"boolean\") { throw new Error(\"Library effects.enabled must be a boolean\"); }\r\n            result.effectsEnabled = config.effects.enabled !== false;\r\n        }\r\n        if (typeof config.sfx !== \"undefined\") {\r\n            if (!config.sfx || config.sfx instanceof Array || typeof config.sfx !== \"object\") { throw new Error(\"Invalid library SFX configuration\"); }\r\n            if (typeof config.sfx.enabled !== \"undefined\" && typeof config.sfx.enabled !== \"boolean\") { throw new Error(\"Library sfx.enabled must be a boolean\"); }\r\n            result.sfxEnabled = config.sfx.enabled !== false;\r\n        }\r\n        return result;\r\n    }\r\n    function array(value) { return Object.prototype.toString.call(value) === \"[object Array]\"; }\r\n    function normalizeRoots(roots, allowEmpty, deduplicate) {\r\n        var result = [], seen = {}, i, path, parts, j, folder, parent, limit;\r\n        if (!array(roots) || roots.length > 32 || (!allowEmpty && !roots.length)) { throw new Error(\"Select at most 32 specific SFX folders\"); }\r\n        for (i = 0; i < roots.length; i += 1) {\r\n            if (typeof roots[i] !== \"string\" || !roots[i] || roots[i].length > 512 || /[\\x00-\\x1f<>\"|?*]/.test(roots[i]) || /^\\s|\\s$/.test(roots[i])) { throw new Error(\"Invalid SFX folder path\"); }\r\n            path = roots[i].replace(/\\\\/g, \"/\").replace(/\\/+$/, \"\");\r\n            if (/^[A-Za-z]:\\//.test(path)) {\r\n                parts = path.substr(3).split(\"/\");\r\n                if (!path.substr(3)) { throw new Error(\"Select a specific SFX folder, not a drive root\"); }\r\n            } else if (/^\\/\\/[^\\/]+\\/[^\\/]+\\//.test(path)) {\r\n                parts = path.substr(2).split(\"/\");\r\n                if (parts.length < 3) { throw new Error(\"Select a specific SFX folder, not a share root\"); }\r\n            } else { throw new Error(\"SFX folders must be absolute specific folder paths\"); }\r\n            for (j = 0; j < parts.length; j += 1) {\r\n                if (!parts[j] || parts[j] === \".\" || parts[j] === \"..\" || /[.: ]$|:/.test(parts[j]) || /^(?:CON|PRN|AUX|NUL|COM[1-9]|LPT[1-9])(?:\\.|$)/i.test(parts[j])) { throw new Error(\"Invalid SFX folder component\"); }\r\n            }\r\n            if (seen[\"$\" + path.toLowerCase()]) { if (deduplicate) { continue; } throw new Error(\"Duplicate SFX folder\"); }\r\n            seen[\"$\" + path.toLowerCase()] = true;\r\n            folder = new Folder(path);\r\n            if ((new File(path)).exists && !folder.exists) { throw new Error(\"SFX location must be a folder\"); }\r\n            limit = 0;\r\n            while (folder && limit++ < 128) {\r\n                if (folder.alias) { throw new Error(\"SFX folder aliases are not allowed\"); }\r\n                parent = folder.parent;\r\n                if (!parent || parent.fsName === folder.fsName || !parent.fsName) { break; }\r\n                folder = parent;\r\n            }\r\n            result.push(path);\r\n        }\r\n        return result;\r\n    }\r\n    function rootsKey(roots) {\r\n        var keys = [], i;\r\n        for (i = 0; i < roots.length; i += 1) { keys.push(roots[i].toLowerCase()); }\r\n        keys.sort(); return keys.join(\"\\n\");\r\n    }\r\n    function Library(bridge) {\r\n        this.bridge = bridge;\r\n        this.root = bridge.workspaceRoot + \"/.ae-codex/library\";\r\n        this.active = false; this.refreshPending = false; this.refreshSequence = 0; this.settingsSequence = 0;\r\n        this.lastRefresh = 0; this.aeDone = true; this.sfxDone = true;\r\n        this.preferences = { effectsEnabled: true, sfxEnabled: false, manualRefresh: true };\r\n        this.state = { schema: \"aect-library/v1\", state: \"stopped\", effectsCount: 0, sfxCount: 0, projectAudioCount: 0, errors: [] };\r\n    }\r\n    Library.prototype.publish = function () {\r\n        this.state.timestampEpochMs = new Date().getTime();\r\n        this.bridge.writeAtomic(this.root + \"/current.json\", stringify(this.state));\r\n    };\r\n    Library.prototype.getPreferences = function () {\r\n        return { effectsEnabled: this.preferences.effectsEnabled, sfxEnabled: this.preferences.sfxEnabled, manualRefresh: true };\r\n    };\r\n    Library.prototype.loadPreferences = function () {\r\n        this.configurationError = null;\r\n        try { this.configuration = readJson(this.root + \"/config.json\"); this.preferences = configPreferences(this.configuration); }\r\n        catch (error) {\r\n            this.configurationError = \"Library config: \" + String(error);\r\n            this.preferences = { effectsEnabled: false, sfxEnabled: false, manualRefresh: true };\r\n        }\r\n        this.effectsEnabled = this.preferences.effectsEnabled; this.sfxEnabled = this.preferences.sfxEnabled;\r\n    };\r\n    Library.prototype.getSfxRoots = function () {\r\n        var config = readJson(this.root + \"/config.json\"); configPreferences(config);\r\n        return normalizeRoots(config && config.sfx && typeof config.sfx.roots !== \"undefined\" ? config.sfx.roots : [], true, true);\r\n    };\r\n    Library.prototype.cachedRootsMatch = function (cached) {\r\n        var config = this.configuration, summary, expected, roots = [], i;\r\n        if (!config || !config.sfx || config.sfx.requireRootsMatch !== true) { return true; }\r\n        if (typeof cached.sessionId !== \"string\" || !/^[A-Za-z0-9-]{8,80}$/.test(cached.sessionId) || typeof cached.requestId !== \"string\" || !/^[A-Za-z0-9-]{8,80}$/.test(cached.requestId)) { return false; }\r\n        expected = \".ae-codex/library/sessions/\" + cached.sessionId + \"/summary-sfx-\" + cached.requestId + \".json\";\r\n        if (cached.summaryRelativePath !== expected) { return false; }\r\n        summary = readJson(this.bridge.workspaceRoot + \"/\" + expected);\r\n        if (!summary || summary.schemaVersion !== 1 || summary.kind !== \"disk-sfx\" || summary.state !== \"success\" || summary.enabled === false || summary.sessionId !== cached.sessionId || summary.requestId !== cached.requestId || !array(summary.roots) || summary.roots.length > 32) { return false; }\r\n        for (i = 0; i < summary.roots.length; i += 1) { if (!summary.roots[i] || typeof summary.roots[i].path !== \"string\") { return false; } roots.push(summary.roots[i].path); }\r\n        return rootsKey(normalizeRoots(roots, true, true)) === rootsKey(normalizeRoots(config.sfx.roots || [], true, true));\r\n    };\r\n    Library.prototype.loadCached = function () {\r\n        var current, cached, relative, file;\r\n        this.cachedEffects = null; this.cachedEffectsMetadata = null; this.cachedSfx = null;\r\n        try {\r\n            cached = readJson(this.root + \"/latest-effects.json\");\r\n            current = readJson(this.root + \"/current.json\");\r\n            if (!cached) { cached = current; }\r\n            if (cached && cached.schema === \"aect-library/v1\" && count(cached.effectsCount) && count(cached.projectAudioCount) && count(cached.appliedSchemaCount)) {\r\n                relative = \".ae-codex/library/sessions/\" + cached.sessionId + \"/\";\r\n                if (typeof cached.sessionId === \"string\" && /^[A-Za-z0-9-]{8,80}$/.test(cached.sessionId) &&\r\n                        typeof cached.requestId === \"string\" && /^[A-Za-z0-9-]{8,120}$/.test(cached.requestId) &&\r\n                        cached.effectsRelativePath === relative + \"effects-\" + cached.requestId + \".tsv\" &&\r\n                        cached.projectAudioRelativePath === relative + \"project-audio-\" + cached.requestId + \".json\" &&\r\n                        (new File(this.bridge.workspaceRoot + \"/\" + cached.effectsRelativePath)).exists &&\r\n                        (new File(this.bridge.workspaceRoot + \"/\" + cached.projectAudioRelativePath)).exists) {\r\n                    this.cachedEffectsMetadata = cached;\r\n                    this.cachedEffects = { effectsCount: cached.effectsCount, projectAudioCount: cached.projectAudioCount,\r\n                        appliedSchemaCount: cached.appliedSchemaCount, effectsRelativePath: cached.effectsRelativePath,\r\n                        projectAudioRelativePath: cached.projectAudioRelativePath,\r\n                        effectsTimestampEpochMs: cached.effectsTimestampEpochMs || cached.timestampEpochMs || null };\r\n                }\r\n            }\r\n        } catch (effectCacheError) { /* Reject corrupt metadata without scanning or loading catalog contents. *\/ }\r\n        try {\r\n            cached = readJson(this.root + \"/latest-sfx.json\");\r\n            if (cached && cached.schemaVersion === 1 && cached.kind === \"disk-sfx\" && cached.enabled !== false && count(cached.count)) {\r\n                relative = catalogPath(cached); file = new File(this.bridge.workspaceRoot + \"/\" + relative);\r\n                if (file.exists && this.cachedRootsMatch(cached)) {\r\n                    this.cachedSfx = { sfxRelativePath: relative, sfxCount: cached.count,\r\n                        sfxTimestampEpochMs: cached.timestampEpochMs || cached.scannedAtEpochMs || null, sfxCompletedUtc: typeof cached.completedUtc === \"string\" ? cached.completedUtc.substr(0, 80) : null };\r\n                }\r\n            }\r\n        } catch (sfxCacheError) { /* Never read a JSONL catalog into the AE process. *\/ }\r\n    };\r\n    Library.prototype.persistEffectsCache = function () {\r\n        if (this.cachedEffectsMetadata && !(new File(this.root + \"/latest-effects.json\")).exists) {\r\n            try { this.bridge.writeAtomic(this.root + \"/latest-effects.json\", stringify(this.cachedEffectsMetadata)); }\r\n            catch (cacheError) { try { this.bridge.log(\"error\", \"Library cached descriptor could not be saved: \" + String(cacheError)); } catch (ignoredLogError) {} }\r\n        }\r\n    };\r\n    Library.prototype.applyCached = function () {\r\n        var key;\r\n        this.state.manualRefresh = true; this.state.refreshMode = \"manual\";\r\n        this.state.effectsEnabled = this.effectsEnabled; this.state.sfxEnabled = this.sfxEnabled;\r\n        this.state.effectsCount = 0; this.state.projectAudioCount = 0; this.state.appliedSchemaCount = 0; this.state.sfxCount = 0;\r\n        delete this.state.effectsRelativePath; delete this.state.projectAudioRelativePath; delete this.state.effectsTimestampEpochMs;\r\n        delete this.state.sfxRelativePath; delete this.state.sfxSummaryRelativePath; delete this.state.sfxTimestampEpochMs; delete this.state.sfxCompletedUtc;\r\n        this.state.effectsCatalogCached = false; this.state.sfxCatalogCached = false; this.state.sfxCatalogReused = false;\r\n        if (!this.sfxEnabled) { delete this.state.sfxLaunchState; delete this.state.sfxWarnings; delete this.state.pendingArchiveCount; }\r\n        this.state.effectsState = this.effectsEnabled ? \"not-indexed\" : \"disabled\";\r\n        this.state.sfxState = this.sfxEnabled ? \"not-indexed\" : \"disabled\";\r\n        if (this.effectsEnabled && this.cachedEffects) {\r\n            for (key in this.cachedEffects) { if (this.cachedEffects.hasOwnProperty(key)) { this.state[key] = this.cachedEffects[key]; } }\r\n            this.state.effectsState = \"ready\"; this.state.effectsCatalogCached = true;\r\n        }\r\n        if (this.sfxEnabled && this.cachedSfx) {\r\n            for (key in this.cachedSfx) { if (this.cachedSfx.hasOwnProperty(key)) { this.state[key] = this.cachedSfx[key]; } }\r\n            this.state.sfxState = \"ready\"; this.state.sfxCatalogCached = true;\r\n        }\r\n    };\r\n    Library.prototype.withdrawPending = function () {\r\n        try {\r\n            var path = this.root + \"/requests/pending-launch.json\", pointer = readJson(path);\r\n            if (pointer && pointer.requestId === this.requestId && pointer.sessionId === this.bridge.sessionNonce) { (new File(path)).remove(); }\r\n        } catch (pointerError) { /* Never withdraw a different or malformed request. *\/ }\r\n    };\r\n    Library.prototype.cancelRefresh = function () {\r\n        this.refreshPending = false; this.aeDone = true; this.sfxDone = true;\r\n        this.scanParade = null; this.propertyStack = []; this.project = null; this.comp = null;\r\n        this.lines = []; this.effects = []; this.audio = []; this.seen = {}; this.withdrawPending();\r\n    };\r\n    Library.prototype.saveConfig = function (config) {\r\n        var suffix = new Date().getTime() + \"-\" + (++this.settingsSequence), original = new File(this.root + \"/config.json\"),\r\n            staged = new File(this.root + \"/settings-\" + suffix + \".json\"), backup = new File(this.root + \"/settings-previous-\" + suffix + \".json\"), moved = false;\r\n        this.bridge.writeNewAtomic(staged.fsName, stringify(config));\r\n        try {\r\n            if (original.exists) {\r\n                if (!original.rename(backup.name)) { throw new Error(\"Cannot preserve library configuration: \" + original.error); }\r\n                moved = true;\r\n            }\r\n            if (!staged.rename(\"config.json\")) { throw new Error(\"Cannot save library configuration: \" + staged.error); }\r\n        } catch (saveError) {\r\n            if (moved && !(new File(this.root + \"/config.json\")).exists) { backup.rename(\"config.json\"); }\r\n            try { if (staged.exists && staged.name !== \"config.json\") { staged.remove(); } } catch (ignoredCleanup) {}\r\n            throw saveError;\r\n        }\r\n        if (moved && backup.exists) { backup.remove(); }\r\n    };\r\n    Library.prototype.setEnabled = function (kind, enabled) {\r\n        if ((kind !== \"effects\" && kind !== \"sfx\") || typeof enabled !== \"boolean\") { throw new Error(\"Invalid library switch\"); }\r\n        var config = readJson(this.root + \"/config.json\"), prefs = configPreferences(config);\r\n        if (!config) { config = { schemaVersion: 1 }; }\r\n        if (!config[kind]) { config[kind] = {}; }\r\n        config[kind].enabled = enabled; config.refreshMode = \"manual\";\r\n        // Commit first; malformed/unwritable config never changes live preferences.\r\n        this.saveConfig(config);\r\n        prefs = configPreferences(config); this.configuration = config; this.preferences = prefs; this.configurationError = null;\r\n        // Optional cache migration/publication cannot undo a committed preference.\r\n        this.persistEffectsCache();\r\n        this.effectsEnabled = prefs.effectsEnabled; this.sfxEnabled = prefs.sfxEnabled;\r\n        this.cancelRefresh(); this.applyCached(); this.state.errors = []; this.state.state = this.active ? \"ready\" : \"stopped\";\r\n        try { this.publish(); }\r\n        catch (publicationError) { try { this.bridge.log(\"error\", \"Library settings saved; status publication failed: \" + String(publicationError)); } catch (ignoredLogError) {} }\r\n        return this.getPreferences();\r\n    };\r\n    Library.prototype.setSfxRoots = function (roots) {\r\n        var selected = normalizeRoots(roots, true, false), config = readJson(this.root + \"/config.json\"), prefs = configPreferences(config), previous;\r\n        previous = normalizeRoots(config && config.sfx && typeof config.sfx.roots !== \"undefined\" ? config.sfx.roots : [], true, true);\r\n        if (rootsKey(selected) === rootsKey(previous) && (selected.length ||\r\n                (config && config.sfx && array(config.sfx.roots) && config.sfx.enabled === false))) { return selected; }\r\n        if (!config) { config = { schemaVersion: 1 }; }\r\n        // A new SFX object defaults off; choosing folders is not consent to scan.\r\n        if (!config.sfx) { config.sfx = { enabled: false }; }\r\n        config.sfx.roots = selected;\r\n        // Clearing the list is one explicit opt-out operation. Commit the empty\r\n        // roots and disabled flag together; never substitute a default folder.\r\n        if (!selected.length) { config.sfx.enabled = false; }\r\n        config.sfx.requireRootsMatch = true; config.refreshMode = \"manual\";\r\n        this.saveConfig(config);\r\n        this.configuration = config; this.preferences = configPreferences(config); this.configurationError = null;\r\n        this.effectsEnabled = this.preferences.effectsEnabled; this.sfxEnabled = this.preferences.sfxEnabled;\r\n        this.cachedSfx = null; this.cancelRefresh(); this.persistEffectsCache(); this.applyCached();\r\n        this.state.errors = []; this.state.state = this.active ? \"ready\" : \"stopped\";\r\n        try { this.publish(); }\r\n        catch (publicationError) { try { this.bridge.log(\"error\", \"Library folders saved; status publication failed: \" + String(publicationError)); } catch (ignoredLogError) {} }\r\n        return selected;\r\n    };\r\n    Library.prototype.failSfx = function (message) {\r\n        this.sfxDone = true; this.state.sfxState = \"error\"; this.state.errors.push(String(message));\r\n        try { this.bridge.log(\"error\", \"Library: \" + String(message)); } catch (ignoredLogError) {}\r\n    };\r\n    Library.prototype.begin = function (generation) {\r\n        this.active = true; this.generation = generation; this.refreshPending = false;\r\n        this.bridge.ensureFolder(this.root); this.bridge.ensureFolder(this.root + \"/requests\"); this.bridge.ensureFolder(this.root + \"/sessions\");\r\n        this.folder = this.root + \"/sessions/\" + this.bridge.sessionNonce; this.bridge.ensureFolder(this.folder);\r\n        this.loadPreferences(); this.loadCached();\r\n        // Persist a validated legacy descriptor before current.json is republished\r\n        // under the new connection. This migrates metadata only, not catalog data.\r\n        this.persistEffectsCache();\r\n        this.state = { schema: \"aect-library/v1\", state: \"ready\", sessionId: this.bridge.sessionNonce, generation: generation,\r\n            requestId: \"\", effectsCount: 0, appliedSchemaCount: 0, projectAudioCount: 0, sfxCount: 0, errors: [] };\r\n        this.applyCached();\r\n        if (this.configurationError) {\r\n            this.state.state = \"error\"; this.state.errors.push(this.configurationError);\r\n            try { this.bridge.log(\"error\", this.configurationError); } catch (ignoredLogError) {}\r\n        }\r\n        this.publish();\r\n    };\r\n    Library.prototype.requestRefresh = function () {\r\n        if (this.configurationError) { throw new Error(this.configurationError); }\r\n        if (!this.active || !this.bridge.running || this.generation !== this.bridge.generation || (!this.effectsEnabled && !this.sfxEnabled) || this.refreshPending || this.state.state === \"scanning\") { return false; }\r\n        this.refreshPending = true; return true;\r\n    };\r\n    Library.prototype.refresh = function () {\r\n        var now = new Date().getTime(), i, e, runtime;\r\n        this.refreshPending = false; this.loadPreferences(); this.state.errors = [];\r\n        if (this.configurationError) { this.state.state = \"error\"; this.state.errors.push(this.configurationError); this.publish(); return; }\r\n        this.lastRefresh = now; this.refreshSequence += 1;\r\n        this.requestId = \"library-\" + this.bridge.sessionNonce + \"-\" + this.generation + \"-\" + now + \"-\" + this.refreshSequence;\r\n        this.itemIndex = 1; this.layerIndex = 1; this.comp = null; this.scanParade = null; this.effectIndex = 1; this.propertyStack = [];\r\n        this.lines = []; this.effects = []; this.audio = []; this.seen = {}; this.layerErrors = 0; this.appliedSchemaCount = 0;\r\n        this.aeDone = !this.effectsEnabled; this.sfxDone = !this.sfxEnabled; this.sfxLaunched = false; this.statusReadAt = 0;\r\n        this.state = { schema: \"aect-library/v1\", state: \"scanning\", sessionId: this.bridge.sessionNonce,\r\n            generation: this.generation, requestId: this.requestId, afterEffectsVersion: String(app.version), errors: [] };\r\n        this.applyCached();\r\n        if (this.effectsEnabled) {\r\n            this.state.effectsState = \"scanning\"; this.project = app.project;\r\n            this.lines = [\"AE_PLUGIN_CATALOG_V1\", \"AE\\t\" + clean(app.version)];\r\n            try {\r\n                var registered = app.effects;\r\n                for (i = 0; i < registered.length; i += 1) {\r\n                    e = registered[i]; this.effects.push({ displayName: String(e.displayName), matchName: String(e.matchName), category: String(e.category), version: String(e.version) });\r\n                    this.lines.push(\"EFFECT\\t\" + clean(e.displayName) + \"\\t\" + clean(e.matchName) + \"\\t\" + clean(e.category) + \"\\t\" + clean(e.version));\r\n                }\r\n            } catch (registryError) { this.failAe(\"Effect registry: \" + String(registryError)); }\r\n        } else { this.project = null; }\r\n        if (this.sfxEnabled) {\r\n            this.state.sfxState = \"scanning\";\r\n            try {\r\n                runtime = readJson(this.root + \"/runtime.json\");\r\n                var expectedLauncher = this.bridge.workspaceRoot + \"/tools/Codex AE Background.exe\";\r\n                if (!runtime || runtime.backgroundServiceVersion !== 1 || typeof runtime.backgroundLauncherPath !== \"string\" ||\r\n                        runtime.backgroundLauncherPath.replace(/\\\\/g, \"/\").toLowerCase() !== expectedLauncher.replace(/\\\\/g, \"/\").toLowerCase()) {\r\n                    throw new Error(\"SFX background service is not configured. Run the Codex AE updater or tools/Initialize-AeLibrary.ps1 -SkipScan -StartBackgroundService\");\r\n                }\r\n                var launcher = new File(expectedLauncher);\r\n                if (!launcher.exists || launcher.alias || launcher.parent.alias) { throw new Error(\"SFX background launcher is missing or aliased. Run the Codex AE updater\"); }\r\n                this.bridge.writeNewAtomic(this.root + \"/requests/sfx-\" + this.requestId + \".json\", stringify({\r\n                    schemaVersion: 1, requestId: this.requestId, sessionId: this.bridge.sessionNonce, workspaceRoot: this.bridge.workspaceRoot, createdUtc: new Date(now).toUTCString()\r\n                }));\r\n                // Select this manual request only; never rediscover/replay old requests.\r\n                this.bridge.writeAtomic(this.root + \"/requests/pending-launch.json\", stringify({ schemaVersion: 1, requestId: this.requestId, sessionId: this.bridge.sessionNonce }));\r\n                this.state.sfxLaunchState = \"pending\";\r\n            } catch (launchError) { this.failSfx(\"SFX launcher: \" + String(launchError)); }\r\n        }\r\n        this.publish();\r\n    };\r\n    Library.prototype.readSfxLaunch = function () {\r\n        var launched = readJson(this.root + \"/requests/launch-sfx-\" + this.requestId + \".json\");\r\n        if (!launched) {\r\n            if (new Date().getTime() - this.lastRefresh > 60000) {\r\n                throw new Error(\"SFX background service did not acknowledge within 60 seconds. Run Codex AE Update/Repair; see .ae-codex/library/launcher-errors.log\");\r\n            }\r\n            return;\r\n        }\r\n        if (launched.schemaVersion !== 1 || launched.requestId !== this.requestId || launched.sessionId !== this.bridge.sessionNonce) {\r\n            throw new Error(\"Foreign or invalid SFX launcher acknowledgement\");\r\n        }\r\n        if (launched.state === \"error\") { throw new Error(\"SFX launcher: \" + clean(launched.error || \"failed\").substr(0, 500)); }\r\n        if (launched.state !== \"launched\" || typeof launched.processId !== \"number\" || !isFinite(launched.processId) ||\r\n                launched.processId <= 0 || launched.processId !== Math.floor(launched.processId)) {\r\n            throw new Error(\"Invalid SFX launcher process acknowledgement\");\r\n        }\r\n        this.sfxLaunched = true;\r\n        this.state.sfxLaunchState = \"launched\";\r\n    };\r\n    Library.prototype.failAe = function (message) {\r\n        this.aeDone = true; this.state.effectsState = \"error\"; this.state.errors.push(String(message));\r\n        this.scanParade = null; this.propertyStack = []; this.project = null; this.comp = null;\r\n        this.lines = []; this.effects = []; this.audio = []; this.seen = {};\r\n        try { this.bridge.log(\"error\", \"Library: \" + String(message)); } catch (ignoredLogError) {}\r\n    };\r\n    Library.prototype.scanChunk = function () {\r\n        var deadline = new Date().getTime() + 8, processed = 0, operations = 0, item, layer, effect;\r\n        if (this.project !== app.project) {\r\n            this.failAe(\"Project changed during inventory; press Update Library to rescan\"); return;\r\n        }\r\n        // A single effect can expose thousands of properties. Keep its exact\r\n        // depth-first cursor between ticks instead of recursively blocking AE.\r\n        // Both elapsed time and a fixed operation cap apply even to one layer.\r\n        while (processed < 6 && operations < 64 && new Date().getTime() < deadline) {\r\n            operations += 1;\r\n            if (this.propertyStack.length || this.scanParade) {\r\n                try {\r\n                    if (this.propertyStack.length) {\r\n                        walkStep(this.propertyStack, this.lines);\r\n                        if (!this.propertyStack.length) { this.appliedSchemaCount += 1; }\r\n                    } else if (this.effectIndex <= this.scanParade.numProperties) {\r\n                        effect = this.scanParade.property(this.effectIndex++);\r\n                        if (!effect || this.seen[\"$\" + effect.matchName]) { continue; }\r\n                        this.seen[\"$\" + effect.matchName] = true;\r\n                        this.lines.push(\"APPLIED\\t\" + clean(effect.matchName) + \"\\t\" + clean(effect.name));\r\n                        this.propertyStack.push({ group: effect, path: effect.matchName, index: 1, depth: 0 });\r\n                    } else { this.scanParade = null; }\r\n                } catch (propertyError) {\r\n                    // Match the previous per-layer failure behavior: keep rows\r\n                    // already read, skip the rest of that layer, continue later.\r\n                    this.layerErrors += 1; this.scanParade = null; this.propertyStack = [];\r\n                }\r\n            } else if (this.comp && this.layerIndex <= this.comp.numLayers) {\r\n                processed += 1;\r\n                try {\r\n                    layer = this.comp.layer(this.layerIndex++);\r\n                    this.scanParade = layer.property(\"ADBE Effect Parade\"); this.effectIndex = 1;\r\n                } catch (layerError) { this.layerErrors += 1; }\r\n            } else {\r\n                processed += 1;\r\n                this.comp = null;\r\n                if (!this.project || this.itemIndex > this.project.numItems) { this.finishAe(); return; }\r\n                try {\r\n                    item = this.project.item(this.itemIndex++);\r\n                    if (item instanceof CompItem) { this.comp = item; this.layerIndex = 1; }\r\n                    else if (item instanceof FootageItem && item.hasAudio) {\r\n                        this.audio.push({ id: item.id, name: String(item.name), hasVideo: item.hasVideo,\r\n                            duration: item.duration, filePath: item.file ? item.file.fsName : null,\r\n                            available: item.file ? item.file.exists : false });\r\n                    }\r\n                } catch (itemError) { this.layerErrors += 1; }\r\n            }\r\n        }\r\n    };\r\n    Library.prototype.finishAe = function () {\r\n        var pluginRoot = this.bridge.workspaceRoot + \"/.ae-codex/plugins\", tsv = this.lines.join(\"\\n\"), categories = {}, names = [], i, e, category, index;\r\n        this.state.effectsState = \"ready\";\r\n        this.state.effectsCount = this.effects.length;\r\n        this.state.appliedSchemaCount = this.appliedSchemaCount;\r\n        this.state.effectsCatalogCached = false;\r\n        this.state.effectsTimestampEpochMs = new Date().getTime();\r\n        this.state.projectAudioCount = this.audio.length;\r\n        if (this.layerErrors) { this.state.errors.push(\"Unavailable project layers/items: \" + this.layerErrors); }\r\n        var relative = \".ae-codex/library/sessions/\" + this.bridge.sessionNonce + \"/\";\r\n        this.bridge.writeNewAtomic(this.folder + \"/effects-\" + this.requestId + \".tsv\", tsv);\r\n        this.bridge.writeNewAtomic(this.folder + \"/project-audio-\" + this.requestId + \".json\", stringify({ schema: \"aect-project-audio/v1\", items: this.audio }));\r\n        this.state.effectsRelativePath = relative + \"effects-\" + this.requestId + \".tsv\";\r\n        this.state.projectAudioRelativePath = relative + \"project-audio-\" + this.requestId + \".json\";\r\n        this.bridge.ensureFolder(pluginRoot);\r\n        this.bridge.writeAtomic(pluginRoot + \"/effects-and-parameters.tsv\", tsv);\r\n        for (i = 0; i < this.effects.length; i += 1) {\r\n            e = this.effects[i]; category = e.category || \"Uncategorized\";\r\n            if (!categories[\"$\" + category]) { categories[\"$\" + category] = []; names.push(category); }\r\n            categories[\"$\" + category].push(e);\r\n        }\r\n        names.sort(); index = [\"# Effects registered in After Effects\", \"\", \"Updated manually from Codex Bridge. PARAM rows describe already-applied effects only; license and render support are not verified.\", \"\"];\r\n        for (i = 0; i < names.length; i += 1) {\r\n            category = names[i]; index.push(\"## \" + category + \" (\" + categories[\"$\" + category].length + \")\", \"\", \"| Effect | Exact matchName | Version |\", \"|---|---|---|\");\r\n            var list = categories[\"$\" + category], j;\r\n            for (j = 0; j < list.length; j += 1) { e = list[j]; index.push(\"| \" + clean(e.displayName).replace(/\\|/g, \"\\\\|\") + \" | `\" + e.matchName + \"` | \" + clean(e.version) + \" |\"); }\r\n            index.push(\"\");\r\n        }\r\n        this.bridge.writeAtomic(pluginRoot + \"/effect-index.md\", index.join(\"\\n\"));\r\n        this.cachedEffects = { effectsCount: this.state.effectsCount, projectAudioCount: this.state.projectAudioCount,\r\n            appliedSchemaCount: this.state.appliedSchemaCount, effectsRelativePath: this.state.effectsRelativePath,\r\n            projectAudioRelativePath: this.state.projectAudioRelativePath, effectsTimestampEpochMs: this.state.effectsTimestampEpochMs };\r\n        this.cachedEffectsMetadata = this.state;\r\n        this.bridge.writeAtomic(this.root + \"/latest-effects.json\", stringify(this.state));\r\n        this.aeDone = true; this.project = null; this.comp = null;\r\n        this.lines = []; this.effects = []; this.audio = []; this.seen = {};\r\n    };\r\n    Library.prototype.readSfxStatus = function () {\r\n        if (!this.sfxEnabled) { this.sfxDone = true; return; }\r\n        var status = readJson(this.folder + \"/status-sfx-\" + this.requestId + \".json\");\r\n        if (!status) { return; }\r\n        if (status.requestId !== this.requestId || status.sessionId !== this.bridge.sessionNonce || (status.state !== \"success\" && status.state !== \"error\")) { throw new Error(\"Foreign or invalid SFX status\"); }\r\n        if (status.state === \"success\") {\r\n            var prefix = \".ae-codex/library/sessions/\" + this.bridge.sessionNonce + \"/\";\r\n            if (status.schemaVersion !== 1 || status.kind !== \"disk-sfx\" || !count(status.count) ||\r\n                    status.summaryRelativePath !== prefix + \"summary-sfx-\" + this.requestId + \".json\") { throw new Error(\"Invalid SFX catalog metadata\"); }\r\n            var validatedCatalogPath = catalogPath(status);\r\n            if (typeof status.enabled !== \"undefined\" && typeof status.enabled !== \"boolean\") { throw new Error(\"Invalid SFX enabled flag\"); }\r\n            if (status.enabled === false && status.count !== 0) { throw new Error(\"Disabled SFX inventory must be empty\"); }\r\n            this.state.sfxCompletedUtc = typeof status.completedUtc === \"string\" ? status.completedUtc.substr(0, 80) : null;\r\n            this.state.sfxTimestampEpochMs = typeof status.timestampEpochMs === \"number\" ? status.timestampEpochMs : new Date().getTime();\r\n            this.state.sfxCount = status.count;\r\n            this.state.sfxRelativePath = validatedCatalogPath;\r\n            this.state.sfxCatalogCached = false;\r\n            this.state.sfxCatalogReused = status.reusedCatalog === true;\r\n            this.state.sfxSummaryRelativePath = status.summaryRelativePath;\r\n            this.state.sfxEnabled = status.enabled !== false;\r\n            this.state.sfxState = status.enabled === false ? \"disabled\" : \"ready\";\r\n            if (status.enabled === false) { delete this.state.sfxRelativePath; this.state.sfxCatalogReused = false; }\r\n            this.state.sfxWarnings = status.warnings || [];\r\n            this.state.pendingArchiveCount = status.pendingArchiveCount || 0;\r\n            if (status.enabled !== false) { this.cachedSfx = { sfxRelativePath: validatedCatalogPath, sfxCount: status.count, sfxTimestampEpochMs: this.state.sfxTimestampEpochMs, sfxCompletedUtc: this.state.sfxCompletedUtc }; }\r\n        } else { this.failSfx(\"SFX scan: \" + String(status.error || status.message || \"failed\")); }\r\n        this.sfxDone = true;\r\n    };\r\n    Library.prototype.tick = function () {\r\n        if (!this.active || !this.bridge.running || this.generation !== this.bridge.generation || this.bridge.busy || this.bridge.pendingReport || this.bridge.pendingCleanupFile) { return; }\r\n        try {\r\n            var now = new Date().getTime();\r\n            if (this.refreshPending) { this.refresh(); }\r\n            if (this.state.state !== \"scanning\") { return; }\r\n            if (!this.aeDone && this.effectsEnabled) { this.scanChunk(); }\r\n            if (!this.sfxDone && this.sfxEnabled && now - this.statusReadAt >= 1000) {\r\n                this.statusReadAt = now;\r\n                try {\r\n                    this.readSfxStatus();\r\n                    if (!this.sfxDone && !this.sfxLaunched) { this.readSfxLaunch(); }\r\n                } catch (statusError) { this.failSfx(String(statusError)); }\r\n                if (!this.sfxDone && now - this.lastRefresh > 300000) { this.failSfx(\"SFX scan timed out; cached catalog retained\"); }\r\n            }\r\n            if (this.aeDone && this.sfxDone) {\r\n                this.state.state = this.state.errors.length ? \"partial\" : \"ready\";\r\n                this.withdrawPending(); this.publish();\r\n            }\r\n        } catch (inventoryError) {\r\n            this.cancelRefresh(); this.state.state = \"error\"; this.state.errors.push(String(inventoryError));\r\n            try { this.bridge.log(\"error\", \"Library: \" + String(inventoryError)); } catch (ignoredLogError) {}\r\n            try { this.publish(); } catch (publicationError) { /* Keep bridge jobs usable. *\/ }\r\n        }\r\n    };\r\n    Library.prototype.stop = function () {\r\n        this.active = false; this.cancelRefresh(); this.state.state = \"stopped\";\r\n        try { this.publish(); } catch (stopError) { /* Stop must always work. *\/ }\r\n    };\r\n    Library.prototype.describe = function () {\r\n        if (this.state.state === \"stopped\") { return \"Th\u01b0 vi\u1ec7n: \u0111\u00e3 ng\u1eaft k\u1ebft n\u1ed1i\"; }\r\n        if (this.configurationError) { return \"Th\u01b0 vi\u1ec7n: l\u1ed7i c\u1ea5u h\u00ecnh \u2014 xem nh\u1eadt k\u00fd\"; }\r\n        if (this.state.state === \"error\") { return \"Th\u01b0 vi\u1ec7n: c\u1eadp nh\u1eadt l\u1ed7i \u2014 xem nh\u1eadt k\u00fd\"; }\r\n        if (this.state.state === \"partial\") { return \"Th\u01b0 vi\u1ec7n: c\u1eadp nh\u1eadt ch\u01b0a \u0111\u1ea7y \u0111\u1ee7 \u2014 xem nh\u1eadt k\u00fd\"; }\r\n        if (this.refreshPending) { return \"Th\u01b0 vi\u1ec7n: \u0111ang ch\u1edd c\u1eadp nh\u1eadt\"; }\r\n        if (this.state.state === \"scanning\") { return \"Th\u01b0 vi\u1ec7n: \u0111ang c\u1eadp nh\u1eadt...\"; }\r\n        if ((this.effectsEnabled && this.state.effectsState === \"not-indexed\") || (this.sfxEnabled && this.state.sfxState === \"not-indexed\")) { return \"Ch\u01b0a c\u00f3 d\u1eef li\u1ec7u \u2014 b\u1ea5m C\u1eadp nh\u1eadt th\u01b0 vi\u1ec7n\"; }\r\n        return \"Th\u01b0 vi\u1ec7n: \" + this.state.effectsCount + \" effect | \" + this.state.projectAudioCount + \" \u00e2m thanh d\u1ef1 \u00e1n | \" + this.state.sfxCount + \" SFX\";\r\n    };\r\n    Library.prototype.heartbeat = function () {\r\n        return { state: this.state.state, manualRefresh: true, refreshPending: this.refreshPending,\r\n            manifestRelativePath: \".ae-codex/library/current.json\", requestId: this.requestId || \"\",\r\n            effectsEnabled: this.effectsEnabled, sfxEnabled: this.sfxEnabled, effectsCount: this.state.effectsCount, sfxCount: this.state.sfxCount };\r\n    };\r\n    $.global.__aectLibraryFactoryV1 = function (bridge) { return new Library(bridge); };\r\n    $.global.__aectLibraryJsonV1 = stringify;\r\n}());\r\n"
*/
