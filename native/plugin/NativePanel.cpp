#include "NativePanel.h"

#include "../core/Files.h"

namespace aect {

namespace {
const wchar_t kSelfProp[] = L"AECT_NativePanel";
const int kStartId = 4101, kStopId = 4102;
// AE_CodexTeam violet theme (matches the ScriptUI panel and the VS Code extension).
const COLORREF kPaper = RGB(31, 26, 46), kBand = RGB(176, 135, 255), kBandInk = RGB(26, 15, 41);
const COLORREF kInk = RGB(235, 238, 248), kMuted = RGB(160, 150, 190), kCard = RGB(48, 36, 78);
const COLORREF kOk = RGB(120, 225, 168), kWarn = RGB(240, 180, 105), kErr = RGB(255, 140, 133);

void DrawLine(HDC dc, const std::string& text, RECT& box, HFONT font, COLORREF color, UINT flags = DT_SINGLELINE | DT_END_ELLIPSIS) {
    SelectObject(dc, font);
    SetTextColor(dc, color);
    std::wstring wide;
    try { wide = Widen(text); } catch (...) { wide = L"?"; }
    RECT measure = box;
    DrawTextW(dc, wide.c_str(), (int)wide.size(), &measure, flags | DT_CALCRECT);
    int height = measure.bottom - measure.top;
    DrawTextW(dc, wide.c_str(), (int)wide.size(), &box, flags);
    box.top += height + 4;
}
}  // namespace

NativePanel::NativePanel(HWND container, AEGP_PanelFunctions1* functions, SnapshotFn snapshot, ActionFn action, GoneFn gone)
    : container_(container), snapshot_(std::move(snapshot)), action_(std::move(action)), gone_(std::move(gone)) {
    functions->GetSnapSizes = S_GetSnapSizes;
    functions->PopulateFlyout = S_PopulateFlyout;
    functions->DoFlyoutCommand = S_DoFlyoutCommand;
    titleFont_ = CreateFontW(-15, 0, 0, 0, FW_BOLD, 0, 0, 0, DEFAULT_CHARSET, 0, 0, CLEARTYPE_QUALITY, 0, L"Segoe UI");
    textFont_ = CreateFontW(-13, 0, 0, 0, FW_NORMAL, 0, 0, 0, DEFAULT_CHARSET, 0, 0, CLEARTYPE_QUALITY, 0, L"Segoe UI");
    smallFont_ = CreateFontW(-11, 0, 0, 0, FW_NORMAL, 0, 0, 0, DEFAULT_CHARSET, 0, 0, CLEARTYPE_QUALITY, 0, L"Consolas");
    previous_ = (WNDPROC)GetWindowLongPtrW(container_, GWLP_WNDPROC);
    SetPropW(container_, kSelfProp, (HANDLE)this);
    SetWindowLongPtrW(container_, GWLP_WNDPROC, (LONG_PTR)StaticProc);
    startButton_ = CreateWindowW(L"BUTTON", L"Kết nối", WS_CHILD | WS_VISIBLE | BS_PUSHBUTTON, 0, 0, 90, 28,
        container_, (HMENU)(INT_PTR)kStartId, nullptr, nullptr);
    stopButton_ = CreateWindowW(L"BUTTON", L"Dừng", WS_CHILD | WS_VISIBLE | BS_PUSHBUTTON, 0, 0, 90, 28,
        container_, (HMENU)(INT_PTR)kStopId, nullptr, nullptr);
    SendMessageW(startButton_, WM_SETFONT, (WPARAM)textFont_, TRUE);
    SendMessageW(stopButton_, WM_SETFONT, (WPARAM)textFont_, TRUE);
    Layout();
    Invalidate();
}

void NativePanel::Invalidate() {
    if (!IsWindow(container_)) return;
    PanelSnapshot s = snapshot_();
    EnableWindow(startButton_, s.canStart);
    EnableWindow(stopButton_, s.canStop);
    InvalidateRect(container_, nullptr, FALSE);
}

void NativePanel::Layout() {
    RECT client; GetClientRect(container_, &client);
    int y = 34;  // just below the title band
    MoveWindow(startButton_, client.right - 196, y + 6, 90, 26, TRUE);
    MoveWindow(stopButton_, client.right - 100, y + 6, 90, 26, TRUE);
}

void NativePanel::Paint(HDC dc, const RECT& client) {
    PanelSnapshot s = snapshot_();
    HBRUSH paper = CreateSolidBrush(kPaper), band = CreateSolidBrush(kBand), card = CreateSolidBrush(kCard);
    FillRect(dc, &client, paper);
    RECT title = {client.left, client.top, client.right, client.top + 32};
    FillRect(dc, &title, band);
    SetBkMode(dc, TRANSPARENT);
    RECT titleText = {title.left + 10, title.top + 7, title.right - 8, title.bottom};
    DrawLine(dc, "\xE2\x97\x86 AE_CodexTeam Native Bridge \xC2\xB7 TEAM", titleText, titleFont_, kBandInk);

    COLORREF stateColor = s.state == PanelSnapshot::State::Connected ? kOk : s.state == PanelSnapshot::State::Stopped ? kMuted :
        s.state == PanelSnapshot::State::Blocked ? kWarn : kErr;
    const char* dot = s.state == PanelSnapshot::State::Connected ? "\xE2\x97\x8F " : s.state == PanelSnapshot::State::Stopped ? "\xE2\x97\x8B " : "! ";
    RECT line = {client.left + 10, title.bottom + 10, client.right - 205, client.bottom};
    DrawLine(dc, std::string(dot) + s.headline, line, textFont_, stateColor);
    line.right = client.right - 10;
    line.top = (std::max)(line.top, (LONG)(title.bottom + 40));
    DrawLine(dc, "Runtime: " + s.runtimeRoot, line, smallFont_, kMuted, DT_SINGLELINE | DT_PATH_ELLIPSIS);
    if (!s.session.empty()) DrawLine(dc, "Session: " + s.session, line, smallFont_, kMuted);
    DrawLine(dc, s.counters, line, smallFont_, kMuted);

    RECT statusCard = {client.left + 8, line.top + 2, client.right - 8, line.top + 54};
    FillRect(dc, &statusCard, card);
    RECT statusText = {statusCard.left + 8, statusCard.top + 6, statusCard.right - 8, statusCard.bottom - 4};
    DrawLine(dc, s.status, statusText, textFont_, kInk, DT_WORDBREAK | DT_END_ELLIPSIS);
    line.top = statusCard.bottom + 8;

    DrawLine(dc, "Nhật ký", line, textFont_, kBand);
    for (auto it = s.log.rbegin(); it != s.log.rend() && line.top < client.bottom - 14; ++it) DrawLine(dc, *it, line, smallFont_, kInk);
    DeleteObject(paper); DeleteObject(band); DeleteObject(card);
}

LRESULT CALLBACK NativePanel::StaticProc(HWND hwnd, UINT msg, WPARAM wParam, LPARAM lParam) {
    NativePanel* self = reinterpret_cast<NativePanel*>(GetPropW(hwnd, kSelfProp));
    return self ? self->Proc(hwnd, msg, wParam, lParam) : DefWindowProcW(hwnd, msg, wParam, lParam);
}

LRESULT NativePanel::Proc(HWND hwnd, UINT msg, WPARAM wParam, LPARAM lParam) {
    switch (msg) {
    case WM_ERASEBKGND:
        return 1;
    case WM_PAINT: {
        PAINTSTRUCT ps;
        HDC dc = BeginPaint(hwnd, &ps);
        RECT client; GetClientRect(hwnd, &client);
        // Double buffer: no flicker while the listener refreshes the status.
        HDC mem = CreateCompatibleDC(dc);
        HBITMAP bitmap = CreateCompatibleBitmap(dc, (std::max)(1L, client.right), (std::max)(1L, client.bottom));
        HGDIOBJ old = SelectObject(mem, bitmap);
        Paint(mem, client);
        BitBlt(dc, 0, 0, client.right, client.bottom, mem, 0, 0, SRCCOPY);
        SelectObject(mem, old); DeleteObject(bitmap); DeleteDC(mem);
        EndPaint(hwnd, &ps);
        return 0;
    }
    case WM_SIZE:
        Layout();
        InvalidateRect(hwnd, nullptr, FALSE);
        break;
    case WM_COMMAND:
        if (HIWORD(wParam) == BN_CLICKED && (LOWORD(wParam) == kStartId || LOWORD(wParam) == kStopId)) {
            action_(LOWORD(wParam) == kStartId);
            Invalidate();
            return 0;
        }
        break;
    case WM_NCDESTROY: {
        WNDPROC previous = previous_;
        RemovePropW(hwnd, kSelfProp);
        SetWindowLongPtrW(hwnd, GWLP_WNDPROC, (LONG_PTR)previous);
        DeleteObject(titleFont_); DeleteObject(textFont_); DeleteObject(smallFont_);
        GoneFn gone = gone_;
        delete this;
        if (gone) gone(this);
        return previous ? CallWindowProcW(previous, hwnd, msg, wParam, lParam) : DefWindowProcW(hwnd, msg, wParam, lParam);
    }
    }
    return previous_ ? CallWindowProcW(previous_, hwnd, msg, wParam, lParam) : DefWindowProcW(hwnd, msg, wParam, lParam);
}

A_Err NativePanel::S_GetSnapSizes(AEGP_PanelRefcon, A_LPoint* sizes, A_long* count) {
    sizes[0].x = 320; sizes[0].y = 220;
    sizes[1].x = 460; sizes[1].y = 360;
    *count = 2;
    return A_Err_NONE;
}
A_Err NativePanel::S_PopulateFlyout(AEGP_PanelRefcon, AEGP_FlyoutMenuItem*, A_long* count) { *count = 0; return A_Err_NONE; }
A_Err NativePanel::S_DoFlyoutCommand(AEGP_PanelRefcon, AEGP_FlyoutMenuCmdID) { return A_Err_NONE; }

}  // namespace aect
