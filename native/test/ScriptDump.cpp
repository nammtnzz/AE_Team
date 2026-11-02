// Prints the exact ExtendScript the plug-in sends through AEGP_ExecuteScript, so the Node harness
// (script-harness.cjs) can run it against the real installed function runtime.
// Usage: ScriptDump <status|validate|run|version> <workspaceRoot> [requestFile] [runId]
#include <fcntl.h>
#include <io.h>

#include <cstdio>
#include <fstream>
#include <sstream>
#include <string>

#include "../core/ScriptText.h"

int main(int argc, char** argv) {
    if (argc < 3) { std::fprintf(stderr, "usage: ScriptDump mode root [requestFile] [runId]\n"); return 2; }
    std::string mode = argv[1], root = argv[2], request, runId = argc > 4 ? argv[4] : "dump-run-0001";
    if (argc > 3) {
        std::ifstream in(argv[3], std::ios::binary);
        std::stringstream buffer; buffer << in.rdbuf(); request = buffer.str();
    }
    std::string script = mode == "status" ? aect::ScriptStatus(root) : mode == "validate" ? aect::ScriptValidate(root, request) :
        mode == "run" ? aect::ScriptRun(root, request, runId) : aect::ScriptAppVersion(root);
    _setmode(_fileno(stdout), _O_BINARY);
    std::fwrite(script.data(), 1, script.size(), stdout);
    return 0;
}
