// Minimal JSON reader/writer for the native bridge. Only what the file protocol needs:
// reading installation.json / heartbeat.json / catalog.json and escaping strings we write.
#pragma once
#include <map>
#include <memory>
#include <string>
#include <vector>

namespace aect {

struct JsonValue {
    enum class Type { Null, Bool, Number, String, Array, Object } type = Type::Null;
    bool boolean = false;
    double number = 0;
    std::string text;                                   // UTF-8
    std::vector<JsonValue> items;
    std::map<std::string, JsonValue> fields;

    const JsonValue* get(const std::string& key) const;  // nullptr when missing or not an object
    std::string str(const std::string& key, const std::string& fallback = "") const;
    double num(const std::string& key, double fallback = 0) const;
};

// Throws std::runtime_error on malformed input. Depth and size are bounded.
JsonValue ParseJson(const std::string& utf8);

// Returns a quoted JSON string literal (UTF-8 kept as is, control characters escaped).
std::string JsonQuote(const std::string& utf8);

}  // namespace aect
