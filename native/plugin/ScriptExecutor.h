// Phase 1 executor: the transport, heartbeat, panel and Stop are native; the 44 named AE functions still
// live in the installed ExtendScript function runtime and are invoked through AEGP_ExecuteScript.
// Only the installed bundle is loaded (bundle-only mode, no ScriptUI panel); job text is passed as data,
// never evaluated as code. Script text comes from core/ScriptText (tested outside AE).
// Later phases move functions to native AEGP calls one by one.
#pragma once
#include <string>

#include "AECT_Native.h"
#include "../core/BridgeCore.h"

namespace aect {

class ScriptExecutor : public Executor {
public:
    ScriptExecutor(SPBasicSuite* pica, AEGP_PluginID pluginId, std::string workspaceRoot);
    ValidateResult Validate(const std::string& requestText) override;
    RunResult Run(const std::string& requestText, const std::string& runId) override;
    std::string ScriptsStatusJson() override;
    std::string AfterEffectsVersion() override;

private:
    // Runs one script from ScriptText; true + payload after "OK\n", or false with the error text.
    bool Call(const std::string& script, std::string* payload);

    SPBasicSuite* pica_;
    AEGP_PluginID pluginId_;
    std::string workspaceRoot_;
    std::string aeVersion_;
};

}  // namespace aect
