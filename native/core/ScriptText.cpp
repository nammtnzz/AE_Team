#include "ScriptText.h"

#include "Json.h"

namespace aect {

std::string JsString(const std::string& utf8) {
    std::string quoted = JsonQuote(utf8), out;
    out.reserve(quoted.size());
    for (size_t i = 0; i < quoted.size(); ++i) {
        if ((unsigned char)quoted[i] == 0xE2 && i + 2 < quoted.size() && (unsigned char)quoted[i + 1] == 0x80 &&
            ((unsigned char)quoted[i + 2] == 0xA8 || (unsigned char)quoted[i + 2] == 0xA9)) {
            out += (unsigned char)quoted[i + 2] == 0xA8 ? "\\u2028" : "\\u2029";
            i += 2;
        } else {
            out += quoted[i];
        }
    }
    return out;
}

namespace {
// Loads the installed function runtime once per bundle file stamp into this plug-in's own global key.
// Directive lines (#target/#targetengine) are stripped so the runtime lands in the engine we call, and the
// bundle-only flag keeps the ScriptUI panel code from running. Job text is only ever passed as data.
std::string Wrap(const std::string& root, const std::string& body) {
    return std::string(
        "(function () {\n"
        "  var g = $.global, key = \"__aeCodexTeamNativeV1\", root = ") + JsString(root) + ";\n"
        "  function describe(e) { var t = e && e.toString ? e.toString() : String(e);\n"
        "    if (e && e.line) { t += \" (line \" + e.line + \")\"; } if (e && e.fileName) { t += \" in \" + e.fileName; } return t; }\n"
        "  try {\n"
        "    var file = new File(root + \"/jsx/AECT Engine.jsx\");\n"
        "    if (!file.exists) { throw new Error(\"Missing function runtime: \" + file.fsName); }\n"
        "    var stamp = String(file.modified ? file.modified.getTime() : 0) + \":\" + file.length;\n"
        "    var state = g[key];\n"
        "    if (!state || state.root !== root || state.stamp !== stamp) {\n"
        "      file.encoding = \"UTF-8\";\n"
        "      if (!file.open(\"r\")) { throw new Error(\"Cannot read function runtime: \" + file.error); }\n"
        "      var source; try { source = file.read(); } finally { file.close(); }\n"
        "      source = source.replace(/^#[^\\r\\n]*/gm, \"\");\n"
        "      var hadOnly = g.hasOwnProperty(\"__AECT_BUNDLE_ONLY__\"), oldOnly = g.__AECT_BUNDLE_ONLY__;\n"
        "      var hadRoot = g.hasOwnProperty(\"__AECT_WORKSPACE_ROOT__\"), oldRoot = g.__AECT_WORKSPACE_ROOT__;\n"
        "      g.__AECT_BUNDLE_ONLY__ = true; g.__AECT_WORKSPACE_ROOT__ = root;\n"
        "      try { eval(source); } finally {\n"
        "        if (hadOnly) { g.__AECT_BUNDLE_ONLY__ = oldOnly; } else { delete g.__AECT_BUNDLE_ONLY__; }\n"
        "        if (hadRoot) { g.__AECT_WORKSPACE_ROOT__ = oldRoot; } else { delete g.__AECT_WORKSPACE_ROOT__; }\n"
        "      }\n"
        "      if (!g.__aectFunctionsV1 || !g.__aectBundleV1) { throw new Error(\"Function runtime did not load\"); }\n"
        "      state = g[key] = { root: root, stamp: stamp, F: g.__aectFunctionsV1, B: g.__aectBundleV1 };\n"
        "    }\n"
        "    var F = state.F, B = state.B;\n" +
        body +
        "  } catch (error) { return \"ERR\\n\" + describe(error); }\n"
        "}());\n";
}
}  // namespace

std::string ScriptStatus(const std::string& root) {
    return Wrap(root, "    B.refresh(false); B.loadInstallation(); return \"OK\\n\" + F.stringify(B.status());\n");
}

std::string ScriptValidate(const std::string& root, const std::string& requestText) {
    return Wrap(root,
        "    var request = F.parse(" + JsString(requestText) + ");\n"
        "    B.refresh(false); F.validate(request);\n"
        "    var names = [], i; for (i = 0; i < request.steps.length; i += 1) { names.push(request.steps[i][\"function\"]); }\n"
        "    return \"OK\\nfunctions: \" + names.join(\", \");\n");
}

std::string ScriptRun(const std::string& root, const std::string& requestText, const std::string& runId) {
    return Wrap(root,
        "    var request = F.parse(" + JsString(requestText) + ");\n"
        "    var context = { schema: \"aect-context/v1\", runId: " + JsString(runId) + ", workspaceRoot: root,\n"
        "      progress: function () {}, log: function () {} };\n"
        "    g.__AECT_RUN_CONTEXT__ = context;\n"
        "    try { return \"OK\\n\" + F.stringify(F.run(request, context)); }\n"
        "    finally { try { delete g.__AECT_RUN_CONTEXT__; } catch (ignored) { g.__AECT_RUN_CONTEXT__ = null; } }\n");
}

std::string ScriptAppVersion(const std::string& root) {
    return Wrap(root, "    return \"OK\\n\" + app.version;\n");
}

}  // namespace aect
