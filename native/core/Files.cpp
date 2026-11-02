#include "Files.h"

#define WIN32_LEAN_AND_MEAN
#define NOMINMAX
#include <windows.h>

#include <algorithm>
#include <chrono>
#include <stdexcept>

namespace aect {

std::wstring Widen(const std::string& utf8) {
    if (utf8.empty()) return std::wstring();
    int n = MultiByteToWideChar(CP_UTF8, MB_ERR_INVALID_CHARS, utf8.data(), (int)utf8.size(), nullptr, 0);
    if (n <= 0) throw std::runtime_error("Invalid UTF-8 path or text");
    std::wstring out(n, L'\0');
    MultiByteToWideChar(CP_UTF8, MB_ERR_INVALID_CHARS, utf8.data(), (int)utf8.size(), out.data(), n);
    return out;
}
std::string Narrow(const std::wstring& wide) {
    if (wide.empty()) return std::string();
    int n = WideCharToMultiByte(CP_UTF8, 0, wide.data(), (int)wide.size(), nullptr, 0, nullptr, nullptr);
    std::string out(n, '\0');
    WideCharToMultiByte(CP_UTF8, 0, wide.data(), (int)wide.size(), out.data(), n, nullptr, nullptr);
    return out;
}
std::string JoinPath(const std::string& a, const std::string& b) {
    if (a.empty()) return b;
    char last = a.back();
    return (last == '/' || last == '\\') ? a + b : a + "/" + b;
}
int64_t NowMs() {
    return std::chrono::duration_cast<std::chrono::milliseconds>(std::chrono::system_clock::now().time_since_epoch()).count();
}

static std::string LastErrorText() {
    DWORD code = GetLastError();
    wchar_t* buffer = nullptr;
    FormatMessageW(FORMAT_MESSAGE_ALLOCATE_BUFFER | FORMAT_MESSAGE_FROM_SYSTEM | FORMAT_MESSAGE_IGNORE_INSERTS,
        nullptr, code, 0, (LPWSTR)&buffer, 0, nullptr);
    std::string text = buffer ? Narrow(buffer) : std::string();
    if (buffer) LocalFree(buffer);
    while (!text.empty() && (text.back() == '\n' || text.back() == '\r' || text.back() == ' ')) text.pop_back();
    return "Win32 " + std::to_string(code) + (text.empty() ? "" : ": " + text);
}

bool PathExists(const std::string& path) { return GetFileAttributesW(Widen(path).c_str()) != INVALID_FILE_ATTRIBUTES; }
bool IsDirectory(const std::string& path) {
    DWORD a = GetFileAttributesW(Widen(path).c_str());
    return a != INVALID_FILE_ATTRIBUTES && (a & FILE_ATTRIBUTE_DIRECTORY);
}
bool IsReparsePoint(const std::string& path) {
    DWORD a = GetFileAttributesW(Widen(path).c_str());
    return a != INVALID_FILE_ATTRIBUTES && (a & FILE_ATTRIBUTE_REPARSE_POINT);
}
void EnsureDirectory(const std::string& path) {
    if (IsDirectory(path)) return;
    if (!CreateDirectoryW(Widen(path).c_str(), nullptr) && GetLastError() != ERROR_ALREADY_EXISTS)
        throw std::runtime_error("Cannot create bridge folder: " + path + "; " + LastErrorText());
}

uint64_t FileSizeOf(const std::string& path) {
    WIN32_FILE_ATTRIBUTE_DATA data;
    if (!GetFileAttributesExW(Widen(path).c_str(), GetFileExInfoStandard, &data))
        throw std::runtime_error("Cannot stat " + path + "; " + LastErrorText());
    return (uint64_t(data.nFileSizeHigh) << 32) | data.nFileSizeLow;
}

std::string ReadTextFile(const std::string& path, uint64_t maxBytes) {
    HANDLE h = CreateFileW(Widen(path).c_str(), GENERIC_READ, FILE_SHARE_READ | FILE_SHARE_WRITE | FILE_SHARE_DELETE,
        nullptr, OPEN_EXISTING, FILE_ATTRIBUTE_NORMAL, nullptr);
    if (h == INVALID_HANDLE_VALUE) throw std::runtime_error("Cannot read " + path + "; " + LastErrorText());
    LARGE_INTEGER size{};
    GetFileSizeEx(h, &size);
    if ((uint64_t)size.QuadPart > maxBytes) { CloseHandle(h); throw std::runtime_error("File is too large: " + path); }
    std::string out((size_t)size.QuadPart, '\0');
    DWORD read = 0;
    BOOL ok = out.empty() ? TRUE : ReadFile(h, out.data(), (DWORD)out.size(), &read, nullptr);
    CloseHandle(h);
    if (!ok) throw std::runtime_error("Cannot read " + path + "; " + LastErrorText());
    out.resize(read);
    return out;
}

static void WriteWhole(const std::wstring& path, const std::string& text) {
    HANDLE h = CreateFileW(path.c_str(), GENERIC_WRITE, 0, nullptr, CREATE_ALWAYS, FILE_ATTRIBUTE_NORMAL, nullptr);
    if (h == INVALID_HANDLE_VALUE) throw std::runtime_error("Cannot open temporary file; " + LastErrorText());
    DWORD written = 0;
    BOOL ok = text.empty() ? TRUE : WriteFile(h, text.data(), (DWORD)text.size(), &written, nullptr);
    BOOL flushed = FlushFileBuffers(h);
    CloseHandle(h);
    if (!ok || written != text.size() || !flushed) {
        DeleteFileW(path.c_str());
        throw std::runtime_error("Cannot write temporary file; " + LastErrorText());
    }
}

void WriteAtomic(const std::string& path, const std::string& text) {
    std::wstring target = Widen(path), temporary = Widen(path + ".tmp-native");
    std::string lastError = "unknown file error";
    for (int attempt = 0; attempt < 4; ++attempt) {
        try {
            WriteWhole(temporary, text);
            if (!MoveFileExW(temporary.c_str(), target.c_str(), MOVEFILE_REPLACE_EXISTING | MOVEFILE_WRITE_THROUGH))
                throw std::runtime_error("Cannot publish temporary file; " + LastErrorText());
            return;
        } catch (const std::exception& e) {
            lastError = e.what();
            DeleteFileW(temporary.c_str());
            if (attempt < 3) Sleep(35 * (attempt + 1));
        }
    }
    throw std::runtime_error("Atomic write failed for " + path + ": " + lastError);
}

void WriteNew(const std::string& path, const std::string& text, const std::string& tempSuffix) {
    std::wstring target = Widen(path), temporary = Widen(path + ".tmp-" + tempSuffix);
    if (PathExists(path)) throw std::runtime_error("Refusing to replace immutable result: " + path);
    std::string lastError = "unknown file error";
    for (int attempt = 0; attempt < 4; ++attempt) {
        try {
            WriteWhole(temporary, text);
            // No REPLACE_EXISTING: publication itself refuses an existing result.
            if (!MoveFileExW(temporary.c_str(), target.c_str(), MOVEFILE_WRITE_THROUGH)) {
                DWORD code = GetLastError();
                DeleteFileW(temporary.c_str());
                if (code == ERROR_ALREADY_EXISTS || code == ERROR_FILE_EXISTS)
                    throw std::logic_error("Refusing to replace immutable result: " + path);
                SetLastError(code);
                throw std::runtime_error("Cannot publish immutable result; " + LastErrorText());
            }
            return;
        } catch (const std::logic_error&) {
            throw;
        } catch (const std::exception& e) {
            lastError = e.what();
            DeleteFileW(temporary.c_str());
            if (PathExists(path)) throw std::runtime_error("Refusing to replace immutable result: " + path);
            if (attempt < 3) Sleep(35 * (attempt + 1));
        }
    }
    throw std::runtime_error("Immutable result write failed for " + path + ": " + lastError);
}

bool RenameNoReplace(const std::string& from, const std::string& to, std::string* error) {
    if (MoveFileExW(Widen(from).c_str(), Widen(to).c_str(), 0)) return true;
    if (error) *error = LastErrorText();
    return false;
}

bool RemoveFile(const std::string& path) {
    if (DeleteFileW(Widen(path).c_str())) return true;
    return GetLastError() == ERROR_FILE_NOT_FOUND;
}

std::vector<std::string> ListFiles(const std::string& dir, const std::string& suffix) {
    std::vector<std::string> names;
    WIN32_FIND_DATAW data;
    HANDLE h = FindFirstFileW(Widen(JoinPath(dir, "*")).c_str(), &data);
    if (h == INVALID_HANDLE_VALUE) return names;
    auto lower = [](std::string s) { std::transform(s.begin(), s.end(), s.begin(), [](unsigned char c) { return (char)tolower(c); }); return s; };
    std::string wanted = lower(suffix);
    do {
        if (data.dwFileAttributes & (FILE_ATTRIBUTE_DIRECTORY | FILE_ATTRIBUTE_REPARSE_POINT)) continue;
        std::string name = Narrow(data.cFileName), folded = lower(name);
        if (folded.size() >= wanted.size() && folded.compare(folded.size() - wanted.size(), wanted.size(), wanted) == 0) names.push_back(name);
    } while (FindNextFileW(h, &data));
    FindClose(h);
    std::sort(names.begin(), names.end());
    return names;
}

void AppendBoundedLog(const std::string& path, const std::string& line, uint64_t maxBytes) {
    try {
        if (PathExists(path) && FileSizeOf(path) > maxBytes) {
            MoveFileExW(Widen(path).c_str(), Widen(path + ".1").c_str(), MOVEFILE_REPLACE_EXISTING);
        }
        HANDLE h = CreateFileW(Widen(path).c_str(), FILE_APPEND_DATA, FILE_SHARE_READ, nullptr, OPEN_ALWAYS, FILE_ATTRIBUTE_NORMAL, nullptr);
        if (h == INVALID_HANDLE_VALUE) return;
        std::string text = line + "\r\n";
        DWORD written = 0;
        WriteFile(h, text.data(), (DWORD)text.size(), &written, nullptr);
        CloseHandle(h);
    } catch (...) {
        // Logging never breaks the bridge.
    }
}

}  // namespace aect
