// Win32 file primitives with the same guarantees as the ScriptUI bridge (bridge.js):
// atomic replace for the heartbeat, write-once for run results, no-replace rename to claim a job.
// Paths are UTF-8; both '/' and '\' are accepted.
#pragma once
#include <cstdint>
#include <string>
#include <vector>

namespace aect {

std::wstring Widen(const std::string& utf8);
std::string Narrow(const std::wstring& wide);
std::string JoinPath(const std::string& a, const std::string& b);
int64_t NowMs();

bool PathExists(const std::string& path);
bool IsDirectory(const std::string& path);
bool IsReparsePoint(const std::string& path);
void EnsureDirectory(const std::string& path);                      // throws
std::string ReadTextFile(const std::string& path, uint64_t maxBytes);  // throws
uint64_t FileSizeOf(const std::string& path);                       // throws
// Replace destination atomically (temp file + MoveFileEx REPLACE_EXISTING), up to 4 attempts.
void WriteAtomic(const std::string& path, const std::string& text);
// Publish once. Throws if the destination exists before or during publication.
void WriteNew(const std::string& path, const std::string& text, const std::string& tempSuffix);
// Rename without replacing; false (with error text) when the target exists or the source vanished.
bool RenameNoReplace(const std::string& from, const std::string& to, std::string* error);
bool RemoveFile(const std::string& path);
// Regular files directly in dir whose name ends with suffix (case-insensitive), sorted by name.
std::vector<std::string> ListFiles(const std::string& dir, const std::string& suffix);
// Appends one line; rotates to path + ".1" once the file exceeds maxBytes (bounded log).
void AppendBoundedLog(const std::string& path, const std::string& line, uint64_t maxBytes);

}  // namespace aect
