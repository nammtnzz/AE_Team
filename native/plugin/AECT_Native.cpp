// AE_CodexTeam Native Bridge (phase 1): native AEGP transport replacing the ScriptUI panel and its
// app.scheduleTask loop. Jobs, heartbeat, results and Stop are handled here in C++; named functions still
// run in the installed function runtime (see ScriptExecutor) until later phases port them.
#include <memory>
#include <new>
#include <stdexcept>
#include <string>

#include "AECT_Native.h"
#include "NativePanel.h"
#include "ScriptExecutor.h"
#include "../core/BridgeCore.h"
#include "../core/Files.h"
#include "../core/Json.h"

namespace aect {

namespace {
// Locates the installed AE_CodexTeam runtime; never a Codex AE install.
bool ResolveRuntime(std::string* root, std::string* error) {
    wchar_t local[MAX_PATH] = {0};
    if (!GetEnvironmentVariableW(L"LOCALAPPDATA", local, MAX_PATH)) { *error = "LOCALAPPDATA is not set"; return false; }
    std::string installRoot = JoinPath(Narrow(local), "AE_CodexTeam");
    try {
        JsonValue info = ParseJson(ReadTextFile(JoinPath(installRoot, "installation.json"), 4 * 1024 * 1024));
        std::string runtime = info.str("runtimeRoot");
        if (info.str("schema") != "aect-installation/v1" || runtime.empty()) throw std::runtime_error("invalid installation.json");
        std::string versions = JoinPath(installRoot, "versions");
        std::string a = runtime, b = versions;
        for (auto* s : {&a, &b}) for (char& c : *s) { if (c == '\\') c = '/'; c = (char)tolower((unsigned char)c); }
        if (a.compare(0, b.size() + 1, b + "/") != 0) throw std::runtime_error("runtime is outside the installation");
        if (!PathExists(JoinPath(runtime, "jsx/AECT Engine.jsx"))) throw std::runtime_error("function runtime is missing");
        if (IsReparsePoint(runtime)) throw std::runtime_error("linked runtime folders are not supported");
        *root = runtime;
        return true;
    } catch (const std::exception& e) {
        *error = std::string("AE_CodexTeam is not installed (") + e.what() + "). Run AE_CodexTeam-Setup, then restart After Effects.";
        return false;
    }
}
}  // namespace

class NativeBridgePlugin {
public:
    NativeBridgePlugin(SPBasicSuite* pica, AEGP_PluginID id)
        : pica_(pica), id_(id), suites_(pica), panels_(pica, kAEGPPanelSuite, kAEGPPanelSuiteVersion1) {
        A_Err err = suites_.CommandSuite1()->AEGP_GetUniqueCommand(&command_);
        if (!err) err = suites_.CommandSuite1()->AEGP_InsertMenuCommand(command_, AECT_MENU_TEXT, AEGP_Menu_WINDOW, AEGP_MENU_INSERT_SORTED);
        if (!err) err = suites_.RegisterSuite5()->AEGP_RegisterCommandHook(id_, AEGP_HP_BeforeAE, command_, &S_Command, (AEGP_CommandRefcon)this);
        if (!err) err = suites_.RegisterSuite5()->AEGP_RegisterUpdateMenuHook(id_, &S_UpdateMenu, nullptr);
        if (!err) err = panels_->AEGP_RegisterCreatePanelHook(id_, (const A_u_char*)AECT_PANEL_MATCH_NAME, &S_CreatePanel, (AEGP_CreatePanelRefcon)this, true);
        if (!err) err = suites_.RegisterSuite5()->AEGP_RegisterIdleHook(id_, &S_Idle, nullptr);
        if (err) throw err;
    }

private:
    // ---- AE hooks ----
    static A_Err S_Command(AEGP_GlobalRefcon, AEGP_CommandRefcon refcon, AEGP_Command command, AEGP_HookPriority, A_Boolean, A_Boolean* handled) {
        auto* self = reinterpret_cast<NativeBridgePlugin*>(refcon);
        if (command == self->command_) {
            self->panels_->AEGP_ToggleVisibility((const A_u_char*)AECT_PANEL_MATCH_NAME);
            *handled = TRUE;
        }
        return A_Err_NONE;
    }
    static A_Err S_UpdateMenu(AEGP_GlobalRefcon global, AEGP_UpdateMenuRefcon, AEGP_WindowType) {
        auto* self = reinterpret_cast<NativeBridgePlugin*>(global);
        self->suites_.CommandSuite1()->AEGP_EnableCommand(self->command_);
        A_Boolean shown = FALSE, front = FALSE;
        self->panels_->AEGP_IsShown((const A_u_char*)AECT_PANEL_MATCH_NAME, &shown, &front);
        self->suites_.CommandSuite1()->AEGP_CheckMarkMenuCommand(self->command_, shown && front);
        return A_Err_NONE;
    }
    static A_Err S_CreatePanel(AEGP_GlobalRefcon, AEGP_CreatePanelRefcon refcon, AEGP_PlatformViewRef container, AEGP_PanelH,
                               AEGP_PanelFunctions1* functions, AEGP_PanelRefcon* outRefcon) {
        auto* self = reinterpret_cast<NativeBridgePlugin*>(refcon);
        try {
            self->panel_ = new NativePanel(container, functions,
                [self] { return self->Snapshot(); },
                [self](bool start) { self->UserAction(start); },
                [self](NativePanel* gone) { if (self->panel_ == gone) self->panel_ = nullptr; });
            *outRefcon = reinterpret_cast<AEGP_PanelRefcon>(self->panel_);
            return A_Err_NONE;
        } catch (...) {
            return A_Err_GENERIC;
        }
    }
    static A_Err S_Idle(AEGP_GlobalRefcon global, AEGP_IdleRefcon, A_long* maxSleep) {
        auto* self = reinterpret_cast<NativeBridgePlugin*>(global);
        try { self->Idle(); } catch (...) { /* the listener reports its own errors; never throw into AE */ }
        if (maxSleep) *maxSleep = 30;  // wake about every 0.5 s (1/60 s units); AE may call sooner
        return A_Err_NONE;
    }

    // ---- bridge lifecycle ----
    void Idle() {
        int64_t now = NowMs();
        if (!autoStartDone_) {
            autoStartDone_ = true;
            Start("automatic start");  // same behaviour as the ScriptUI Startup loader
        }
        if (core_ && core_->running() && now - lastTick_ >= 500) {
            lastTick_ = now;
            core_->Tick();
        }
    }

    void Start(const std::string& reason) {
        if (core_ && core_->running()) return;
        std::string root, error;
        if (!ResolveRuntime(&root, &error)) { setupError_ = error; Refresh(); return; }
        setupError_.clear();
        if (!core_ || core_->options().workspaceRoot != root) {
            executor_ = std::make_unique<ScriptExecutor>(pica_, id_, root);
            BridgeOptions options;
            options.workspaceRoot = root;
            options.logPath = JoinPath(root, ".ae-codex/bridge/logs/native-bridge.log");
            try { EnsureDirectory(JoinPath(root, ".ae-codex/bridge/logs")); } catch (...) {}
            core_ = std::make_unique<BridgeCore>(options, *executor_);
            core_->onChange = [this] { Refresh(); };
        }
        std::string why;
        core_->Start(&why);
        Refresh();
        (void)reason;
    }

    void UserAction(bool start) {
        if (start) {
            manualStop_ = false;
            Start("user");
        } else if (core_) {
            // Stop only stops listening. A job already claimed has finished in this same call stack,
            // so nothing is cut off; jobs are never re-run after Stop.
            manualStop_ = true;
            core_->Stop();
        }
        Refresh();
    }

    void Refresh() { if (panel_) panel_->Invalidate(); }

    PanelSnapshot Snapshot() {
        PanelSnapshot s;
        if (!setupError_.empty()) {
            s.state = PanelSnapshot::State::Error; s.headline = "Chưa sẵn sàng"; s.status = setupError_;
            s.runtimeRoot = "(chưa cài)"; s.canStart = true;
            return s;
        }
        if (!core_) { s.headline = "Đang chờ After Effects sẵn sàng…"; s.runtimeRoot = "…"; return s; }
        s.runtimeRoot = core_->options().workspaceRoot;
        if (core_->running()) {
            s.state = PanelSnapshot::State::Connected;
            s.headline = core_->busy() ? "Đang báo cáo kết quả" : "Đã kết nối · sẵn sàng nhận việc";
            s.session = core_->sessionNonce();
        } else if (core_->blocked()) {
            s.state = PanelSnapshot::State::Blocked; s.headline = "Đang nhường cho bridge khác";
        } else {
            s.state = PanelSnapshot::State::Stopped; s.headline = manualStop_ ? "Đã dừng (bấm Kết nối để chạy lại)" : "Chưa kết nối";
        }
        s.status = core_->status();
        s.counters = "Hoàn tất: " + std::to_string(core_->completed()) + " · Lỗi: " + std::to_string(core_->failed()) +
            (core_->lastRunId().empty() ? "" : " · Gần nhất: " + core_->lastRunId());
        for (const LogEntry& e : core_->logs()) {
            std::string line = (e.level == "error" ? "[lỗi] " : e.level == "warning" ? "[!] " : "") + e.message;
            s.log.push_back(line);
        }
        s.canStart = !core_->running();
        s.canStop = core_->running();
        return s;
    }

    SPBasicSuite* pica_;
    AEGP_PluginID id_;
    AEGP_SuiteHandler suites_;
    SimpleSuiteHelper<AEGP_PanelSuite1> panels_;
    AEGP_Command command_ = 0;
    std::unique_ptr<ScriptExecutor> executor_;
    std::unique_ptr<BridgeCore> core_;
    NativePanel* panel_ = nullptr;
    std::string setupError_;
    bool autoStartDone_ = false, manualStop_ = false;
    int64_t lastTick_ = 0;
};

}  // namespace aect

A_Err EntryPointFunc(SPBasicSuite* pica, A_long, A_long, AEGP_PluginID id, AEGP_GlobalRefcon* globalRefcon) {
    try {
        *globalRefcon = (AEGP_GlobalRefcon) new aect::NativeBridgePlugin(pica, id);
        return A_Err_NONE;
    } catch (A_Err err) {
        return err;
    } catch (const std::bad_alloc&) {
        return A_Err_ALLOC;
    } catch (...) {
        return A_Err_GENERIC;
    }
}
