#include "ScriptExecutor.h"

#include <stdexcept>

#include "../core/Json.h"
#include "../core/ScriptText.h"

namespace aect {

namespace {
std::string HandleText(AEGP_SuiteHandler& suites, AEGP_MemHandle handle) {
    if (!handle) return std::string();
    void* ptr = nullptr;
    std::string text;
    if (suites.MemorySuite1()->AEGP_LockMemHandle(handle, &ptr) == A_Err_NONE && ptr) {
        text = static_cast<const char*>(ptr);
        suites.MemorySuite1()->AEGP_UnlockMemHandle(handle);
    }
    suites.MemorySuite1()->AEGP_FreeMemHandle(handle);
    return text;
}
}  // namespace

ScriptExecutor::ScriptExecutor(SPBasicSuite* pica, AEGP_PluginID pluginId, std::string workspaceRoot)
    : pica_(pica), pluginId_(pluginId), workspaceRoot_(std::move(workspaceRoot)) {}

bool ScriptExecutor::Call(const std::string& script, std::string* payload) {
    AEGP_SuiteHandler suites(pica_);
    A_Boolean available = FALSE;
    if (suites.UtilitySuite6()->AEGP_IsScriptingAvailable(&available) != A_Err_NONE || !available) {
        *payload = "After Effects scripting is not available right now";
        return false;
    }
    AEGP_MemHandle resultH = nullptr, errorH = nullptr;
    // FALSE = script, result and error text are UTF-8.
    A_Err err = suites.UtilitySuite6()->AEGP_ExecuteScript(pluginId_, script.c_str(), FALSE, &resultH, &errorH);
    std::string result = HandleText(suites, resultH), error = HandleText(suites, errorH);
    if (err != A_Err_NONE || !error.empty()) {
        *payload = "Script engine error " + std::to_string(err) + (error.empty() ? "" : ": " + error);
        return false;
    }
    if (result.compare(0, 3, "OK\n") == 0) { *payload = result.substr(3); return true; }
    if (result.compare(0, 4, "ERR\n") == 0) { *payload = result.substr(4); return false; }
    *payload = "Unexpected script result";
    return false;
}

ValidateResult ScriptExecutor::Validate(const std::string& requestText) {
    std::string out;
    bool ok = Call(ScriptValidate(workspaceRoot_, requestText), &out);
    return ok ? ValidateResult{true, out, ""} : ValidateResult{false, "", out};
}

RunResult ScriptExecutor::Run(const std::string& requestText, const std::string& runId) {
    std::string out;
    bool ok = Call(ScriptRun(workspaceRoot_, requestText, runId), &out);
    return ok ? RunResult{true, out, ""} : RunResult{false, "", out};
}

std::string ScriptExecutor::ScriptsStatusJson() {
    std::string out;
    if (Call(ScriptStatus(workspaceRoot_), &out)) {
        try { if (ParseJson(out).get("revision")) return out; } catch (...) {}
    }
    throw std::runtime_error("Cannot read the installed function runtime: " + out);
}

std::string ScriptExecutor::AfterEffectsVersion() {
    if (aeVersion_.empty()) {
        std::string out;
        aeVersion_ = Call(ScriptAppVersion(workspaceRoot_), &out) ? out : "unknown";
    }
    return aeVersion_;
}

}  // namespace aect
