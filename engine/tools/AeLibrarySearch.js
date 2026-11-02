/* Read saved SFX metadata only. Never scan media, import audio or enable indexing. */
"use strict";
const fs = require("node:fs"), path = require("node:path"), crypto = require("node:crypto");
const normalize = value => String(value).toLowerCase().normalize("NFD").replace(/[\u0300-\u036f]/g, "").replace(/đ/g, "d");
function plain(file) {
    for (let cursor = path.resolve(file);;) {
        if (fs.existsSync(cursor) && fs.lstatSync(cursor).isSymbolicLink()) throw Error("Linked library paths are not supported");
        const parent = path.dirname(cursor); if (parent === cursor) break; cursor = parent;
    }
    return file;
}
function json(file) {
    plain(file); if (fs.statSync(file).size > 262144) throw Error("Library metadata exceeds 256 KiB");
    return JSON.parse(fs.readFileSync(file, "utf8"));
}
async function searchLibrary(root, args = {}) {
    if (!args || Object.keys(args).some(k => !["query", "limit"].includes(k)) || typeof args.query !== "string" || args.query.length > 200 ||
        (args.limit !== undefined && (!Number.isInteger(args.limit) || args.limit < 1 || args.limit > 35))) throw Error("query:string (max 200), limit:1..35 required");
    const result = { kind: "sfx", state: "disabled", results: [], metadataOnly: true, scanned: false };
    const library = path.join(root, ".ae-codex/library"); let config;
    try { config = json(path.join(library, "config.json")); } catch (e) { if (e.code === "ENOENT") return result; throw e; }
    const sfx = config.sfx;
    if (!sfx || sfx.enabled === false || !(sfx.enabled === true || sfx.roots?.length)) return result;
    let latest;
    try { latest = json(path.join(library, "latest-sfx.json")); } catch (e) { if (e.code === "ENOENT") return { ...result, state: "needs-manual-scan" }; throw e; }
    const settings = { roots: (sfx.roots || []).map(r => path.resolve(r)), extensions: [...(sfx.extensions || [".wav", ".mp3", ".aif", ".aiff", ".m4a", ".aac", ".flac", ".ogg"])].sort() };
    const fingerprint = crypto.createHash("sha256").update(JSON.stringify(settings)).digest("hex");
    if (latest.state !== "success" || !latest.enabled || latest.settingsFingerprint !== fingerprint) return { ...result, state: "needs-manual-scan" };
    const relative = latest.catalogRelativePath;
    if (typeof relative !== "string" || !/^\.ae-codex\/library\/sessions\/[A-Za-z0-9_-]+\/sfx-[A-Za-z0-9_-]+\.jsonl$/.test(relative)) throw Error("Unsafe SFX catalog path");
    const file = plain(path.join(root, relative));
    const tokens = normalize(args.query).split(/\s+/).filter(Boolean), limit = args.limit || 20;
    const stream = fs.createReadStream(file, { highWaterMark: 16384, encoding: "utf8" });
    let pending = "", bytes = 0, rows = 0, truncated = false; const matches = [], started = Date.now();
    function row(line) {
        if (!line.trim()) return;
        rows++; let entry; try { entry = JSON.parse(line); } catch { return; }
        if (typeof entry.path !== "string" || typeof entry.name !== "string" || !settings.roots.some(r => {
            const rel = path.relative(r, entry.path); return rel && !rel.startsWith("..") && !path.isAbsolute(rel);
        })) return;
        const search = normalize([entry.name, entry.relativePath, entry.tags].join(" "));
        if (tokens.every(t => search.includes(t))) matches.push({
            path: entry.path, name: entry.name, extension: entry.extension, tags: entry.tags, sizeBytes: entry.sizeBytes
        });
    }
    try {
        outer: for await (const chunk of stream) {
            bytes += Buffer.byteLength(chunk); pending += chunk;
            if (bytes > 67108864 || Date.now() - started > 2500) { truncated = true; break; }
            let pos;
            while ((pos = pending.indexOf("\n")) >= 0) {
                if (pos > 65536) throw Error("SFX metadata row exceeds 64 KiB");
                row(pending.slice(0, pos)); pending = pending.slice(pos + 1);
                if (matches.length >= limit || rows >= 250000) { truncated = true; break outer; }
            }
            if (pending.length > 65536) throw Error("SFX metadata row exceeds 64 KiB");
        }
        if (!truncated && pending) row(pending);
    } finally { stream.destroy(); }
    // Recheck consent and pointer after the streamed read; a changed library is never exposed.
    if (JSON.stringify(json(path.join(library, "config.json"))) !== JSON.stringify(config) ||
        JSON.stringify(json(path.join(library, "latest-sfx.json"))) !== JSON.stringify(latest)) return { ...result, state: "settings-changed" };
    return { ...result, state: "ready", results: matches.slice(0, limit), truncated, rowsRead: rows, completedUtc: latest.completedUtc,
        note: "Catalog đã lưu, không xác nhận file còn tồn tại hoặc giấy phép. Chỉ import khi plan được duyệt." };
}
module.exports = { searchLibrary };
