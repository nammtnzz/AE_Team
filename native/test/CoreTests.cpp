// Console tests for the native bridge protocol (no After Effects needed).
// Each case runs in a fresh temporary runtime folder and checks the files the engine reads.
#define WIN32_LEAN_AND_MEAN
#define NOMINMAX
#include <windows.h>
#include <shellapi.h>

#include <cstdio>
#include <functional>
#include <string>
#include <vector>

#include "../core/BridgeCore.h"
#include "../core/Files.h"
#include "../core/Json.h"

using namespace aect;

static int g_failures = 0, g_checks = 0;
#define CHECK(cond, what) do { ++g_checks; if (!(cond)) { ++g_failures; std::printf("  FAIL %s (line %d)\n", what, __LINE__); } } while (0)

struct FakeExecutor : Executor {
    int validations = 0, runs = 0;
    bool validateOk = true, runOk = true;
    std::string lastRequest;
    ValidateResult Validate(const std::string& request) override {
        ++validations; lastRequest = request;
        if (!validateOk) return {false, "", "Function step 1: unknown function"};
        return {true, "functions: team.project.inspect", ""};
    }
    RunResult Run(const std::string& request, const std::string&) override {
        ++runs;
        if (!runOk) return {false, "", "Error: layer not found (line 12)"};
        return {true, "{\"ok\":true,\"echo\":" + JsonQuote(request) + "}", ""};
    }
    std::string ScriptsStatusJson() override { return "{\"revision\":\"rev-123\",\"total\":1,\"state\":\"ready\"}"; }
    std::string AfterEffectsVersion() override { return "26.5x1"; }
};

static std::string TempRoot() {
    wchar_t base[MAX_PATH]; GetTempPathW(MAX_PATH, base);
    std::string root = Narrow(base) + "aect-native-" + std::to_string(NowMs()) + "-" + std::to_string(GetTickCount64() % 100000);
    EnsureDirectory(root);
    return root;
}
static void RemoveTree(const std::string& root) {
    std::wstring from = Widen(root) + L'\0' + L'\0';
    SHFILEOPSTRUCTW op{}; op.wFunc = FO_DELETE; op.pFrom = from.c_str(); op.fFlags = FOF_NO_UI;
    SHFileOperationW(&op);
}
static std::string Encode(const std::string& text) {
    std::string out; char buf[4];
    for (unsigned char c : text) {
        if (isalnum(c) || c == '-' || c == '_' || c == '.' || c == '~') out += (char)c;
        else { std::snprintf(buf, sizeof buf, "%%%02X", c); out += buf; }
    }
    return out;
}
struct Env {
    std::string root; FakeExecutor exec; BridgeOptions opts; BridgeCore* core = nullptr;
    Env() { root = TempRoot(); opts.workspaceRoot = root; opts.heartbeatIntervalMs = 0; core = new BridgeCore(opts, exec); }
    ~Env() { delete core; RemoveTree(root); }
    std::string bridge(const std::string& rel) { return root + "/.ae-codex/bridge/" + rel; }
    void job(const std::string& runId, const std::string& body) {
        WriteAtomic(bridge("inbox/job-" + runId + ".job"), body);
    }
    void v2(const std::string& runId, const std::string& request, const std::string& nonce = "") {
        job(runId, "schema=aect-job/v2\nrunId=" + runId + "\nsessionNonce=" + (nonce.empty() ? core->sessionNonce() : nonce) +
            "\nrequest=" + Encode(request) + "\n");
    }
    JsonValue status(const std::string& runId) { return ParseJson(ReadTextFile(bridge("results/status-" + runId + ".json"), 1 << 20)); }
    bool has(const std::string& rel) { return PathExists(bridge(rel)); }
};

static void Case(const char* name, const std::function<void()>& body) {
    int before = g_failures;
    try { body(); } catch (const std::exception& e) { ++g_failures; std::printf("  FAIL exception: %s\n", e.what()); }
    std::printf("%s %s\n", g_failures == before ? "PASS" : "FAIL", name);
}

int main() {
    const std::string plan = "{\"schema\":\"aect-functions/v1\",\"steps\":[{\"function\":\"team.project.inspect\",\"args\":{\"note\":\"Tiếng Việt ✓\"}}]}";

    Case("start writes a running heartbeat the engine accepts", [] {
        Env e; std::string why;
        CHECK(e.core->Start(&why), "start");
        JsonValue hb = ParseJson(ReadTextFile(e.bridge("heartbeat.json"), 1 << 20));
        CHECK(hb.str("schema") == "aect-heartbeat/v1" && hb.str("state") == "running", "schema/state");
        CHECK(hb.str("sessionNonce") == e.core->sessionNonce() && BridgeCore::ValidRunId(hb.str("sessionNonce")), "nonce");
        CHECK(hb.str("transport") == "native-aegp" && hb.str("bridgeVersion") == "1.0.0", "transport/version");
        CHECK(hb.get("scripts") && hb.get("scripts")->str("revision") == "rev-123", "scripts.revision");
        CHECK(NowMs() - (int64_t)hb.num("timestampEpochMs") < 5000, "fresh timestamp");
        CHECK(IsDirectory(e.bridge("inbox")) && IsDirectory(e.bridge("results")), "folders");
    });

    Case("valid v2 job: started, executed once, status success, marker removed", [&] {
        Env e; e.core->Start(nullptr);
        e.v2("run-00000001", plan); e.core->Tick();
        CHECK(e.exec.runs == 1 && e.exec.lastRequest == plan, "ran decoded UTF-8 request once");
        CHECK(e.has("results/started-run-00000001.json"), "started written");
        JsonValue st = e.status("run-00000001");
        CHECK(st.str("schema") == "aect-run/v2" && st.str("state") == "success" && st.str("phase") == "completed", "status success");
        CHECK(st.str("sessionNonce") == e.core->sessionNonce() && st.str("operation") == "functions: team.project.inspect", "status fields");
        CHECK(ParseJson(st.str("result")).str("echo") == plan, "result payload round-trips");
        CHECK(!e.has("inbox/job-run-00000001.running") && !e.has("inbox/job-run-00000001.job"), "markers cleaned");
        e.core->Tick(); e.core->Tick();
        CHECK(e.exec.runs == 1, "never re-run");
    });

    Case("foreign-session job is left untouched and does not block own jobs", [&] {
        Env e; e.core->Start(nullptr);
        e.v2("aaaa-foreign", plan, "1111-otherinstance");
        e.v2("bbbb-own0001", plan); e.core->Tick();
        CHECK(e.has("inbox/job-aaaa-foreign.job"), "foreign job kept");
        CHECK(!e.has("results/status-aaaa-foreign.json"), "no status for foreign job");
        CHECK(e.exec.runs == 1 && e.has("results/status-bbbb-own0001.json"), "own job processed");
    });

    Case("malformed jobs are rejected without execution", [&] {
        Env e; e.core->Start(nullptr);
        std::string n = e.core->sessionNonce();
        e.job("bad-field-01", "schema=aect-job/v2\nrunId=bad-field-01\nsessionNonce=" + n + "\nevil=1\n");
        e.core->Tick();
        CHECK(!e.has("inbox/job-bad-field-01.job") && e.status("bad-field-01").str("errorCode") == "JOB_REJECTED", "unknown field");
        e.job("legacy-0001", "schema=aect-job/v1\nrunId=legacy-0001\nsessionNonce=" + n + "\nscript=jsx/x.jsx\n");
        e.core->Tick();
        CHECK(e.status("legacy-0001").str("message").find("aect-job/v2") != std::string::npos, "legacy JSX job refused");
        e.job("mismatch-01", "schema=aect-job/v2\nrunId=other-run-01\nsessionNonce=" + n + "\nrequest=%7B%7D\n");
        e.core->Tick();
        CHECK(e.status("other-run-01").str("message").find("filename") != std::string::npos, "filename mismatch");
        e.job("badenc-0001", "schema=aect-job/v2\nrunId=badenc-0001\nsessionNonce=" + n + "\nrequest=%ZZ\n");
        e.core->Tick();
        CHECK(e.status("badenc-0001").str("message").find("URIError") != std::string::npos, "bad encoding");
        e.v2("toolarge-01", std::string(131073, 'x')); e.core->Tick();
        CHECK(e.status("toolarge-01").str("message").find("128 KiB") != std::string::npos, "request limit");
        CHECK(e.exec.runs == 0, "nothing executed");
        CHECK(ListFiles(e.bridge("inbox"), ".job").empty(), "inbox drained");
    });

    Case("plan validation failure is reported, never executed", [&] {
        Env e; e.exec.validateOk = false; e.core->Start(nullptr);
        e.v2("invalid-0001", plan); e.core->Tick();
        JsonValue st = e.status("invalid-0001");
        CHECK(st.str("errorCode") == "JOB_REJECTED" && st.str("phase") == "validation", "rejected at validation");
        CHECK(e.exec.runs == 0 && !e.has("results/started-invalid-0001.json"), "not started");
    });

    Case("execution failure is final: error status, retryable=false", [&] {
        Env e; e.exec.runOk = false; e.core->Start(nullptr);
        e.v2("fail-000001", plan); e.core->Tick(); e.core->Tick();
        JsonValue st = e.status("fail-000001");
        CHECK(st.str("errorCode") == "FUNCTION_EXECUTION_FAILED" && st.get("retryable")->boolean == false, "error status");
        CHECK(e.exec.runs == 1 && e.core->failed() == 1, "ran once");
    });

    Case("preflight failure (started exists) never executes", [&] {
        Env e; e.core->Start(nullptr);
        WriteAtomic(e.bridge("results/started-pre-000001.json"), "{}");
        e.v2("pre-000001", plan); e.core->Tick();
        CHECK(e.status("pre-000001").str("errorCode") == "START_STATUS_FAILED", "preflight error");
        CHECK(e.exec.runs == 0, "not executed");
    });

    Case("status publication failure retries the report only, never the plan", [&] {
        Env e; e.core->Start(nullptr);
        WriteAtomic(e.bridge("results/status-imm-000001.json"), "{\"blocker\":true}");
        e.v2("imm-000001", plan); e.core->Tick(); e.core->Tick(); e.core->Tick();
        CHECK(e.exec.runs == 1, "executed exactly once");
        CHECK(ReadTextFile(e.bridge("results/status-imm-000001.json"), 1 << 20) == "{\"blocker\":true}", "existing result not replaced");
        CHECK(e.core->busy() && e.has("inbox/job-imm-000001.running"), "stays busy with marker kept");
        e.v2("next-000001", plan); e.core->Tick();
        CHECK(e.exec.runs == 1, "no new job while a report is pending");
    });

    Case("claimed .running markers from a previous session are never executed", [&] {
        Env e; e.core->Start(nullptr);
        WriteAtomic(e.bridge("inbox/job-old-000001.running"), "schema=aect-job/v2\n");
        e.core->Tick(); e.core->Tick();
        CHECK(e.exec.runs == 0 && e.has("inbox/job-old-000001.running"), "left for reconciliation");
    });

    Case("another live bridge blocks start; a stale heartbeat does not", [&] {
        Env e;
        std::string foreign = "{\"schema\":\"aect-heartbeat/v1\",\"state\":\"running\",\"sessionNonce\":\"1700-scriptui\",\"timestampEpochMs\":" + std::to_string(NowMs()) + "}";
        EnsureDirectory(e.root + "/.ae-codex"); EnsureDirectory(e.root + "/.ae-codex/bridge");
        WriteAtomic(e.bridge("heartbeat.json"), foreign);
        std::string why;
        CHECK(!e.core->Start(&why) && e.core->blocked() && why.find("ScriptUI") != std::string::npos, "blocked by fresh ScriptUI heartbeat");
        CHECK(ReadTextFile(e.bridge("heartbeat.json"), 1 << 20) == foreign, "foreign heartbeat untouched");
        WriteAtomic(e.bridge("heartbeat.json"), "{\"schema\":\"aect-heartbeat/v1\",\"state\":\"running\",\"sessionNonce\":\"1700-old\",\"timestampEpochMs\":" + std::to_string(NowMs() - 60000) + "}");
        CHECK(e.core->Start(&why), "stale heartbeat ignored");
    });

    Case("takeover while running pauses instead of fighting over the heartbeat", [&] {
        Env e; e.core->Start(nullptr);
        std::string foreign = "{\"schema\":\"aect-heartbeat/v1\",\"state\":\"running\",\"sessionNonce\":\"1700-scriptui\",\"timestampEpochMs\":" + std::to_string(NowMs()) + "}";
        WriteAtomic(e.bridge("heartbeat.json"), foreign);
        e.v2("after-takeover", plan, e.core->sessionNonce());
        e.core->Tick();
        CHECK(!e.core->running() && e.core->blocked(), "paused");
        CHECK(ReadTextFile(e.bridge("heartbeat.json"), 1 << 20) == foreign, "heartbeat not overwritten");
        CHECK(e.exec.runs == 0, "no job taken after takeover");
    });

    Case("stop publishes a stopped heartbeat and ignores jobs", [&] {
        Env e; e.core->Start(nullptr); e.core->Stop();
        CHECK(ParseJson(ReadTextFile(e.bridge("heartbeat.json"), 1 << 20)).str("state") == "stopped", "stopped heartbeat");
        e.v2("stopped-0001", plan); e.core->Tick();
        CHECK(e.exec.runs == 0 && e.has("inbox/job-stopped-0001.job"), "job waits");
    });

    Case("json parser handles escapes, unicode and rejects garbage", [] {
        JsonValue v = ParseJson("{\"a\":\"x\\u00e9\\ud83d\\ude00\\n\",\"b\":[1,2.5,-3e2],\"c\":true,\"d\":null}");
        CHECK(v.str("a") == "x\xC3\xA9\xF0\x9F\x98\x80\n" && v.get("b")->items.size() == 3 && v.get("c")->boolean, "parse");
        CHECK(ParseJson(JsonQuote("q\"\\\x01")).text == "q\"\\\x01", "quote round-trip");
        bool threw = false; try { ParseJson("{\"a\":}"); } catch (...) { threw = true; }
        CHECK(threw, "malformed rejected");
    });

    std::printf("\n%d checks, %d failures\n", g_checks, g_failures);
    return g_failures ? 1 : 0;
}
