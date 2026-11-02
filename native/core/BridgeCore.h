// Native implementation of the AE_CodexTeam file bridge protocol (same contract as engine/source/bridge.js):
//   heartbeat.json            atomic replace, every 2 s while running, carries sessionNonce + scripts.revision
//   inbox/job-<runId>.job     key=value lines: schema, runId, sessionNonce, request (aect-job/v2 only)
//   inbox/job-<runId>.running claimed job (no-replace rename) — never re-run after a restart
//   results/started-<runId>.json  written once before execution; no write, no execution
//   results/status-<runId>.json   written once; the .running marker is removed only after it exists
// Execution is delegated to an Executor so this file has no After Effects dependency and is unit-tested.
#pragma once
#include <cstdint>
#include <deque>
#include <functional>
#include <string>

namespace aect {

struct ValidateResult { bool ok = false; std::string operation; std::string error; };
struct RunResult { bool ok = false; std::string result; std::string error; };

class Executor {
public:
    virtual ~Executor() = default;
    // Parse + validate a function plan without touching the project.
    virtual ValidateResult Validate(const std::string& requestText) = 0;
    virtual RunResult Run(const std::string& requestText, const std::string& runId) = 0;
    // JSON object for heartbeat.scripts; must contain "revision" matching the installed catalog.
    virtual std::string ScriptsStatusJson() = 0;
    virtual std::string AfterEffectsVersion() = 0;
};

struct BridgeOptions {
    std::string workspaceRoot;            // installed runtime root (versions/<packageId>)
    std::string bridgeVersion = "1.0.0";
    int64_t heartbeatIntervalMs = 2000;
    std::string logPath;                  // optional bounded log file
};

struct LogEntry { int64_t at; std::string level; std::string message; std::string runId; };

class BridgeCore {
public:
    BridgeCore(BridgeOptions options, Executor& executor);

    // Starts a new session. Refuses (returns false) while another bridge holds a fresh heartbeat.
    bool Start(std::string* reason);
    void Stop(const std::string& message = "Bridge stopped by user");
    // One listener step: publish pending report, heartbeat, then at most one job. Never throws.
    void Tick();

    bool running() const { return running_; }
    bool blocked() const { return blocked_; }
    bool busy() const { return pendingReport_.active || !pendingCleanup_.empty(); }
    const std::string& sessionNonce() const { return sessionNonce_; }
    const std::string& status() const { return status_; }
    const std::string& lastRunId() const { return lastRunId_; }
    int completed() const { return completed_; }
    int failed() const { return failed_; }
    const std::deque<LogEntry>& logs() const { return logs_; }
    const BridgeOptions& options() const { return options_; }
    std::function<void()> onChange;  // UI refresh hint

    // Exposed for tests.
    static bool ValidRunId(const std::string& runId);
    static std::string UrlDecode(const std::string& value);  // throws on malformed escapes / invalid UTF-8

private:
    struct Report {
        bool active = false;
        std::string runId, state, phase, errorCode, operation, message, result, runningPath;
        bool retryable = false, completionKnown = true;
        int64_t startedAt = 0;
    };

    std::string BridgeRoot() const;
    std::string InboxPath() const;
    std::string ResultsPath() const;
    std::string HeartbeatPath() const;
    void EnsureFolders();
    bool ForeignHeartbeatActive(int64_t maxAgeMs, std::string* detail) const;
    void WriteHeartbeat(const std::string& state, const std::string& message);
    void WriteStarted(const std::string& runId, const std::string& operation, int64_t startedAt);
    void WriteStatus(const Report& report);
    bool PublishPendingReport();
    bool RetryPendingCleanup();
    // Returns false when the job belongs to another session and was left untouched.
    bool ProcessJob(const std::string& name);
    void RejectJob(const std::string& path, const std::string& error, const std::string& runId, const std::string& nonce);
    void Log(const std::string& level, const std::string& message, const std::string& runId = "");
    void SetStatus(const std::string& text);
    void Changed() { if (onChange) onChange(); }

    BridgeOptions options_;
    Executor& executor_;
    bool running_ = false;
    bool blocked_ = false;
    std::string sessionNonce_;
    std::string status_ = "Stopped";
    std::string lastRunId_;
    std::string scriptsJson_;
    int64_t lastHeartbeat_ = 0;
    int completed_ = 0, failed_ = 0;
    Report pendingReport_;
    std::string pendingCleanup_;
    std::deque<LogEntry> logs_;
};

}  // namespace aect
