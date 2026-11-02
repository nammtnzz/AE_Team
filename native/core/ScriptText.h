// ExtendScript text sent through AEGP_ExecuteScript (phase 1). Kept free of AE headers so the exact
// script can be dumped by a console tool and exercised against the real function runtime in tests.
#pragma once
#include <string>

namespace aect {

// ES3 string literal (JSON quoting plus U+2028/U+2029 escapes).
std::string JsString(const std::string& utf8);

// Each script returns "OK\n<payload>" or "ERR\n<message>".
std::string ScriptStatus(const std::string& workspaceRoot);
std::string ScriptValidate(const std::string& workspaceRoot, const std::string& requestText);
std::string ScriptRun(const std::string& workspaceRoot, const std::string& requestText, const std::string& runId);
std::string ScriptAppVersion(const std::string& workspaceRoot);

}  // namespace aect
