#include "BridgeCore.h"

#include <algorithm>
#include <cstdio>
#include <random>
#include <stdexcept>

#include "Files.h"
#include "Json.h"

namespace aect {

namespace {
const uint64_t kMaxJobBytes = 800 * 1024;
const size_t kMaxRequestBytes = 131072;
const size_t kMaxLogEntries = 200;

std::string Trim(const std::string& s) {
    size_t a = s.find_first_not_of(" \t\r\n"), b = s.find_last_not_of(" \t\r\n");
    return a == std::string::npos ? std::string() : s.substr(a, b - a + 1);
}
bool ValidUtf8(const std::string& s) {
    try { (void)Widen(s); return true; } catch (...) { return false; }
}
}  // namespace

BridgeCore::BridgeCore(BridgeOptions options, Executor& executor) : options_(std::move(options)), executor_(executor) {}

std::string BridgeCore::BridgeRoot() const { return JoinPath(JoinPath(options_.workspaceRoot, ".ae-codex"), "bridge"); }
std::string BridgeCore::InboxPath() const { return JoinPath(BridgeRoot(), "inbox"); }
std::string BridgeCore::ResultsPath() const { return JoinPath(BridgeRoot(), "results"); }
std::string BridgeCore::HeartbeatPath() const { return JoinPath(BridgeRoot(), "heartbeat.json"); }

bool BridgeCore::ValidRunId(const std::string& runId) {
    if (runId.size() < 8 || runId.size() > 80) return false;
    for (char c : runId) if (!(isalnum((unsigned char)c) || c == '-')) return false;
    return true;
}

std::string BridgeCore::UrlDecode(const std::string& value) {
    std::string out;
    out.reserve(value.size());
    for (size_t i = 0; i < value.size(); ++i) {
        char c = value[i];
        if (c != '%') { out += c; continue; }
        if (i + 2 >= value.size() || !isxdigit((unsigned char)value[i + 1]) || !isxdigit((unsigned char)value[i + 2]))
            throw std::runtime_error("URIError: malformed request encoding");
        out += (char)std::stoi(value.substr(i + 1, 2), nullptr, 16);
        i += 2;
    }
    if (!ValidUtf8(out)) throw std::runtime_error("URIError: request is not valid UTF-8");
    return out;
}

void BridgeCore::Log(const std::string& level, const std::string& message, const std::string& runId) {
    logs_.push_back({NowMs(), level, message, runId});
    while (logs_.size() > kMaxLogEntries) logs_.pop_front();
    if (!options_.logPath.empty())
        AppendBoundedLog(options_.logPath, std::to_string(NowMs()) + " " + level + (runId.empty() ? "" : " [" + runId + "]") + " " + message, 1024 * 1024);
    Changed();
}
void BridgeCore::SetStatus(const std::string& text) { status_ = text; Changed(); }

void BridgeCore::EnsureFolders() {
    EnsureDirectory(JoinPath(options_.workspaceRoot, ".ae-codex"));
    EnsureDirectory(BridgeRoot());
    EnsureDirectory(InboxPath());
    EnsureDirectory(ResultsPath());
}

bool BridgeCore::ForeignHeartbeatActive(int64_t maxAgeMs, std::string* detail) const {
    try {
        if (!PathExists(HeartbeatPath())) return false;
        JsonValue hb = ParseJson(ReadTextFile(HeartbeatPath(), 4 * 1024 * 1024));
        std::string nonce = hb.str("sessionNonce"), state = hb.str("state");
        int64_t age = NowMs() - (int64_t)hb.num("timestampEpochMs", 0);
        if (nonce.empty() || nonce == sessionNonce_ || state != "running" || age > maxAgeMs || age < -5000) return false;
        if (detail) *detail = (hb.str("transport") == "native-aegp" ? "another After Effects instance (native bridge)" : "the ScriptUI panel AE_CodexTeam Bridge") +
            std::string(", session ") + nonce;
        return true;
    } catch (...) {
        return false;  // unreadable heartbeat is treated as absent; ours replaces it atomically
    }
}

void BridgeCore::WriteHeartbeat(const std::string& state, const std::string& message) {
    int64_t now = NowMs();
    std::string payload = "{"
        "\"schema\":\"aect-heartbeat/v1\","
        "\"state\":" + JsonQuote(state) + ","
        "\"bridgeVersion\":" + JsonQuote(options_.bridgeVersion) + ","
        "\"transport\":\"native-aegp\","
        "\"startupPercent\":" + std::string(state == "running" ? "100" : "0") + ","
        "\"startupStage\":" + JsonQuote(state == "running" ? "Success" : state) + ","
        "\"sessionNonce\":" + JsonQuote(sessionNonce_) + ","
        "\"timestampEpochMs\":" + std::to_string(now) + ","
        "\"afterEffectsVersion\":" + JsonQuote(executor_.AfterEffectsVersion()) + ","
        "\"functions\":{\"schema\":\"aect-functions/v1\",\"catalogRelativePath\":\".ae-codex/functions/catalog.json\"},"
        "\"message\":" + JsonQuote(message) +
        (scriptsJson_.empty() ? "" : ",\"scripts\":" + scriptsJson_) +
        "}";
    WriteAtomic(HeartbeatPath(), payload);
    lastHeartbeat_ = now;
}

void BridgeCore::WriteStarted(const std::string& runId, const std::string& operation, int64_t startedAt) {
    std::string payload = "{"
        "\"schema\":\"aect-run-started/v1\",\"mode\":\"file-bridge\","
        "\"runId\":" + JsonQuote(runId) + ",\"sessionNonce\":" + JsonQuote(sessionNonce_) + ","
        "\"state\":\"running\",\"phase\":\"evaluating\",\"operation\":" + JsonQuote(operation) + ","
        "\"afterEffectsVersion\":" + JsonQuote(executor_.AfterEffectsVersion()) + ","
        "\"startedAtEpochMs\":" + std::to_string(startedAt) + ",\"timestampEpochMs\":" + std::to_string(NowMs()) + "}";
    WriteNew(JoinPath(ResultsPath(), "started-" + runId + ".json"), payload, sessionNonce_);
}

void BridgeCore::WriteStatus(const Report& r) {
    std::string payload = "{"
        "\"schema\":\"aect-run/v2\",\"mode\":\"file-bridge\","
        "\"runId\":" + JsonQuote(r.runId) + ",\"sessionNonce\":" + JsonQuote(sessionNonce_) + ","
        "\"state\":" + JsonQuote(r.state) + ",\"phase\":" + JsonQuote(r.phase) + ","
        "\"errorCode\":" + JsonQuote(r.errorCode) + ","
        "\"retryable\":" + (r.retryable ? "true" : "false") + ",\"completionKnown\":" + (r.completionKnown ? "true" : "false") + ","
        "\"operation\":" + JsonQuote(r.operation) + ",\"afterEffectsVersion\":" + JsonQuote(executor_.AfterEffectsVersion()) + ","
        "\"startedAtEpochMs\":" + std::to_string(r.startedAt) + ",\"timestampEpochMs\":" + std::to_string(NowMs()) + ","
        "\"message\":" + JsonQuote(r.message) + ",\"result\":" + JsonQuote(r.result) + "}";
    WriteNew(JoinPath(ResultsPath(), "status-" + r.runId + ".json"), payload, sessionNonce_);
}

bool BridgeCore::PublishPendingReport() {
    if (!pendingReport_.active) return true;
    try {
        WriteStatus(pendingReport_);
        Report report = pendingReport_;
        pendingReport_ = Report();
        Log("info", "Result report published: " + report.state, report.runId);
        if (report.state == "success") ++completed_; else ++failed_;
        if (!report.runningPath.empty() && !RemoveFile(report.runningPath)) {
            pendingCleanup_ = report.runningPath;
            Log("error", "Result published; job marker cleanup failed, retrying", report.runId);
        }
        SetStatus(report.state == "success" ? "Completed " + report.operation : "Failed " + report.operation + "\n" + report.message);
        return true;
    } catch (const std::exception& e) {
        // Retry the report only; the plan itself is never executed again.
        Log("error", std::string("Result publication failed; retrying report only: ") + e.what(), pendingReport_.runId);
        SetStatus("Plan finished; result report will retry");
        return false;
    }
}

bool BridgeCore::RetryPendingCleanup() {
    if (pendingCleanup_.empty()) return true;
    if (RemoveFile(pendingCleanup_)) {
        pendingCleanup_.clear();
        Log("info", "Job marker cleanup completed");
        return true;
    }
    return false;
}

void BridgeCore::RejectJob(const std::string& path, const std::string& error, const std::string& runId, const std::string& nonce) {
    std::string rejected = path + ".rejected-" + std::to_string(NowMs());
    RenameNoReplace(path, rejected, nullptr);
    Log("error", "Rejected job: " + error, runId);
    SetStatus("Rejected job: " + error);
    if (nonce == sessionNonce_ && ValidRunId(runId)) {
        Report r;
        r.active = true; r.runId = runId; r.state = "error"; r.phase = "validation"; r.errorCode = "JOB_REJECTED";
        r.retryable = false; r.operation = "function plan"; r.startedAt = NowMs(); r.message = error;
        pendingReport_ = r;
        PublishPendingReport();
    }
}

bool BridgeCore::ProcessJob(const std::string& name) {
    std::string path = JoinPath(InboxPath(), name);
    std::string runId, nonce, schema, request;
    bool hasScript = false;
    try {
        if (FileSizeOf(path) > kMaxJobBytes) throw std::runtime_error("Job request is too large");
        std::string text = ReadTextFile(path, kMaxJobBytes);
        int fields = 0;
        size_t start = 0;
        bool seenSchema = false, seenRun = false, seenNonce = false, seenRequest = false;
        while (start <= text.size()) {
            size_t end = text.find('\n', start);
            std::string line = text.substr(start, end == std::string::npos ? std::string::npos : end - start);
            start = end == std::string::npos ? text.size() + 1 : end + 1;
            if (Trim(line).empty()) continue;
            size_t eq = line.find('=');
            if (eq == std::string::npos || eq < 1) throw std::runtime_error("Invalid job line: " + line.substr(0, 120));
            std::string key = Trim(line.substr(0, eq)), value = Trim(line.substr(eq + 1));
            bool* seen = key == "schema" ? &seenSchema : key == "runId" ? &seenRun : key == "sessionNonce" ? &seenNonce :
                key == "request" ? &seenRequest : key == "script" ? &hasScript : nullptr;
            if (!seen) throw std::runtime_error("Unknown job field: " + key);
            if (*seen) throw std::runtime_error("Duplicate job field: " + key);
            *seen = true;
            if (key == "schema") schema = value; else if (key == "runId") runId = value;
            else if (key == "sessionNonce") nonce = value; else if (key == "request") request = value;
            ++fields;
        }
        if (fields != 4) throw std::runtime_error("Job must contain exactly schema, runId, sessionNonce, and script or request");
        // Another AE instance owns this job: leave it untouched for the matching bridge.
        if (nonce != sessionNonce_) return false;
        if (schema == "aect-job/v1" || hasScript)
            throw std::runtime_error("The native bridge runs named function plans only (aect-job/v2); legacy JSX script jobs are not accepted");
        if (schema != "aect-job/v2") throw std::runtime_error("Unsupported job schema");
        if (!ValidRunId(runId)) throw std::runtime_error("Invalid run ID");
        if (name != "job-" + runId + ".job") throw std::runtime_error("Job filename does not match run ID");
        if (!seenRequest) throw std::runtime_error("Function jobs require request data");
    } catch (const std::exception& e) {
        RejectJob(path, e.what(), runId, nonce);
        return true;
    }

    std::string requestText, operation;
    try {
        requestText = UrlDecode(request);
        if (requestText.size() > kMaxRequestBytes) throw std::runtime_error("Function request exceeds 128 KiB");
        ValidateResult v = executor_.Validate(requestText);
        if (!v.ok) throw std::runtime_error(v.error.empty() ? "Function plan is invalid" : v.error);
        operation = v.operation.empty() ? "function plan" : v.operation;
    } catch (const std::exception& e) {
        RejectJob(path, e.what(), runId, nonce);
        return true;
    }

    std::string runningPath = JoinPath(InboxPath(), "job-" + runId + ".running"), claimError;
    if (!RenameNoReplace(path, runningPath, &claimError)) {
        Log("error", "Could not claim job " + runId + ": " + claimError, runId);
        return true;
    }
    lastRunId_ = runId;
    int64_t startedAt = NowMs();
    Log("info", "Started " + operation, runId);
    SetStatus("Running " + operation + "\nRun ID: " + runId);

    Report r;
    r.active = true; r.runId = runId; r.operation = operation; r.startedAt = startedAt; r.runningPath = runningPath;
    try {
        // If this preflight write fails, the plan is not executed.
        WriteStarted(runId, operation, startedAt);
    } catch (const std::exception& e) {
        r.state = "error"; r.phase = "preflight"; r.errorCode = "START_STATUS_FAILED"; r.retryable = true; r.message = e.what();
        pendingReport_ = r;
        PublishPendingReport();
        return true;
    }
    RunResult result;
    try { result = executor_.Run(requestText, runId); }
    catch (const std::exception& e) { result.ok = false; result.error = e.what(); }
    catch (...) { result.ok = false; result.error = "Unknown native execution failure"; }
    r.state = result.ok ? "success" : "error";
    r.phase = result.ok ? "completed" : "evaluating";
    r.errorCode = result.ok ? "" : "FUNCTION_EXECUTION_FAILED";
    r.message = result.ok ? "Function plan completed" : result.error;
    r.result = result.ok ? result.result : "";
    Log(result.ok ? "info" : "error", result.ok ? "Completed successfully: " + operation : result.error, runId);
    pendingReport_ = r;
    PublishPendingReport();
    return true;
}

bool BridgeCore::Start(std::string* reason) {
    if (running_) return true;
    std::mt19937_64 rng(std::random_device{}());
    char suffix[17];
    std::snprintf(suffix, sizeof suffix, "%llx", (unsigned long long)(rng() & 0x7fffffffffffULL));
    sessionNonce_ = std::to_string(NowMs()) + "-" + suffix;
    blocked_ = false;
    std::string detail;
    if (ForeignHeartbeatActive(10000, &detail)) {
        blocked_ = true;
        std::string message = "Another bridge is using this runtime: " + detail + ". Close it, then press Start.";
        if (reason) *reason = message;
        SetStatus(message);
        Log("warning", message);
        return false;
    }
    try {
        EnsureFolders();
        scriptsJson_ = executor_.ScriptsStatusJson();
        WriteHeartbeat("starting", "Native bridge startup in progress");
        running_ = true;
        WriteHeartbeat("running", "Waiting for jobs");
        Log("info", "Native bridge " + options_.bridgeVersion + " connected; session=" + sessionNonce_);
        SetStatus("Connected · ready for Codex jobs");
        return true;
    } catch (const std::exception& e) {
        running_ = false;
        std::string message = std::string("Could not start bridge: ") + e.what();
        if (reason) *reason = message;
        try { WriteHeartbeat("error", message); } catch (...) {}
        Log("error", message);
        SetStatus(message);
        return false;
    }
}

void BridgeCore::Stop(const std::string& message) {
    if (!running_) return;
    running_ = false;
    try { WriteHeartbeat("stopped", message); } catch (...) {}
    Log("info", message);
    SetStatus("Stopped");
}

void BridgeCore::Tick() {
    if (!running_) return;
    try {
        if (pendingReport_.active) PublishPendingReport();
        if (!pendingReport_.active && !pendingCleanup_.empty()) RetryPendingCleanup();
        int64_t now = NowMs();
        if (now - lastHeartbeat_ >= options_.heartbeatIntervalMs) {
            std::string detail;
            // Never fight another live bridge over the heartbeat (e.g. the ScriptUI panel opened later).
            if (ForeignHeartbeatActive(std::max<int64_t>(options_.heartbeatIntervalMs * 2, 4000), &detail)) {
                running_ = false; blocked_ = true;
                std::string message = "Paused: another bridge took over this runtime (" + detail + "). Jobs of this session are not replayed.";
                Log("warning", message);
                SetStatus(message);
                return;
            }
            WriteHeartbeat("running", pendingReport_.active ? "Reporting result" : !pendingCleanup_.empty() ? "Cleaning completed job" : "Waiting for jobs");
        }
        if (!pendingReport_.active && pendingCleanup_.empty()) {
            std::vector<std::string> jobs = ListFiles(InboxPath(), ".job");
            // At most one job per tick; jobs of other sessions are skipped, never claimed.
            for (const std::string& job : jobs) if (ProcessJob(job)) break;
        }
    } catch (const std::exception& e) {
        Log("error", std::string("Bridge listener error: ") + e.what());
        SetStatus(std::string("Bridge error: ") + e.what());
        try { WriteHeartbeat("error", e.what()); } catch (...) {}
    }
}

}  // namespace aect
