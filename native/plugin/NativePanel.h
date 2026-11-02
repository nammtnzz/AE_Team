// Native Win32 panel for Window > AE_CodexTeam Native Bridge. No ScriptUI.
// Violet AE_CodexTeam theme so it is never confused with the grey/blue Codex AE "Codex Bridge" panel.
#pragma once
#include <functional>
#include <string>
#include <vector>

#include "AECT_Native.h"

namespace aect {

struct PanelSnapshot {
    enum class State { Connected, Stopped, Blocked, Error } state = State::Stopped;
    std::string headline;     // e.g. "Đã kết nối · sẵn sàng nhận việc"
    std::string runtimeRoot;
    std::string session;
    std::string status;
    std::string counters;
    std::vector<std::string> log;  // newest last
    bool canStart = false, canStop = false;
};

class NativePanel {
public:
    using SnapshotFn = std::function<PanelSnapshot()>;
    using ActionFn = std::function<void(bool start)>;
    using GoneFn = std::function<void(NativePanel*)>;

    NativePanel(HWND container, AEGP_PanelFunctions1* functions, SnapshotFn snapshot, ActionFn action, GoneFn gone);
    void Invalidate();

private:
    static LRESULT CALLBACK StaticProc(HWND hwnd, UINT msg, WPARAM wParam, LPARAM lParam);
    LRESULT Proc(HWND hwnd, UINT msg, WPARAM wParam, LPARAM lParam);
    void Paint(HDC dc, const RECT& client);
    void Layout();
    static A_Err S_GetSnapSizes(AEGP_PanelRefcon, A_LPoint* sizes, A_long* count);
    static A_Err S_PopulateFlyout(AEGP_PanelRefcon, AEGP_FlyoutMenuItem*, A_long* count);
    static A_Err S_DoFlyoutCommand(AEGP_PanelRefcon, AEGP_FlyoutMenuCmdID);

    HWND container_;
    WNDPROC previous_ = nullptr;
    HWND startButton_ = nullptr, stopButton_ = nullptr;
    HFONT titleFont_ = nullptr, textFont_ = nullptr, smallFont_ = nullptr;
    SnapshotFn snapshot_;
    ActionFn action_;
    GoneFn gone_;
};

}  // namespace aect
