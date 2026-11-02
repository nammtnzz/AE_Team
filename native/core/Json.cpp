#include "Json.h"

#include <cctype>
#include <cstdio>
#include <stdexcept>

namespace aect {

const JsonValue* JsonValue::get(const std::string& key) const {
    if (type != Type::Object) return nullptr;
    auto it = fields.find(key);
    return it == fields.end() ? nullptr : &it->second;
}
std::string JsonValue::str(const std::string& key, const std::string& fallback) const {
    const JsonValue* v = get(key);
    return v && v->type == Type::String ? v->text : fallback;
}
double JsonValue::num(const std::string& key, double fallback) const {
    const JsonValue* v = get(key);
    return v && v->type == Type::Number ? v->number : fallback;
}

namespace {
class Parser {
public:
    explicit Parser(const std::string& s) : s_(s) {}
    JsonValue parseDocument() {
        // Skip a UTF-8 BOM written by some tools.
        if (s_.size() >= 3 && (unsigned char)s_[0] == 0xEF && (unsigned char)s_[1] == 0xBB && (unsigned char)s_[2] == 0xBF) i_ = 3;
        JsonValue v = value(0);
        ws();
        if (i_ != s_.size()) fail("trailing characters");
        return v;
    }

private:
    const std::string& s_;
    size_t i_ = 0;

    [[noreturn]] void fail(const char* what) { throw std::runtime_error(std::string("JSON: ") + what); }
    void ws() { while (i_ < s_.size() && (s_[i_] == ' ' || s_[i_] == '\t' || s_[i_] == '\r' || s_[i_] == '\n')) ++i_; }
    bool eat(char c) { ws(); if (i_ < s_.size() && s_[i_] == c) { ++i_; return true; } return false; }
    void expect(char c) { if (!eat(c)) fail("unexpected character"); }
    bool literal(const char* word) {
        size_t n = std::char_traits<char>::length(word);
        if (s_.compare(i_, n, word) == 0) { i_ += n; return true; }
        return false;
    }

    JsonValue value(int depth) {
        if (depth > 64) fail("nesting too deep");
        ws();
        if (i_ >= s_.size()) fail("unexpected end");
        JsonValue v;
        char c = s_[i_];
        if (c == '{') {
            ++i_; v.type = JsonValue::Type::Object;
            if (eat('}')) return v;
            do {
                ws();
                if (i_ >= s_.size() || s_[i_] != '"') fail("expected key");
                std::string key = string();
                expect(':');
                v.fields[key] = value(depth + 1);
            } while (eat(','));
            expect('}');
        } else if (c == '[') {
            ++i_; v.type = JsonValue::Type::Array;
            if (eat(']')) return v;
            do { v.items.push_back(value(depth + 1)); } while (eat(','));
            expect(']');
        } else if (c == '"') {
            v.type = JsonValue::Type::String; v.text = string();
        } else if (literal("true")) { v.type = JsonValue::Type::Bool; v.boolean = true; }
        else if (literal("false")) { v.type = JsonValue::Type::Bool; }
        else if (literal("null")) { v.type = JsonValue::Type::Null; }
        else {
            size_t start = i_;
            while (i_ < s_.size() && (isdigit((unsigned char)s_[i_]) || s_[i_] == '-' || s_[i_] == '+' || s_[i_] == '.' || s_[i_] == 'e' || s_[i_] == 'E')) ++i_;
            if (start == i_) fail("unexpected character");
            v.type = JsonValue::Type::Number;
            try { v.number = std::stod(s_.substr(start, i_ - start)); } catch (...) { fail("bad number"); }
        }
        return v;
    }

    static void appendUtf8(std::string& out, unsigned cp) {
        if (cp < 0x80) out += (char)cp;
        else if (cp < 0x800) { out += (char)(0xC0 | (cp >> 6)); out += (char)(0x80 | (cp & 0x3F)); }
        else if (cp < 0x10000) { out += (char)(0xE0 | (cp >> 12)); out += (char)(0x80 | ((cp >> 6) & 0x3F)); out += (char)(0x80 | (cp & 0x3F)); }
        else { out += (char)(0xF0 | (cp >> 18)); out += (char)(0x80 | ((cp >> 12) & 0x3F)); out += (char)(0x80 | ((cp >> 6) & 0x3F)); out += (char)(0x80 | (cp & 0x3F)); }
    }
    unsigned hex4() {
        if (i_ + 4 > s_.size()) fail("bad escape");
        unsigned v = 0;
        for (int k = 0; k < 4; ++k) {
            char h = s_[i_++]; v <<= 4;
            if (h >= '0' && h <= '9') v |= h - '0'; else if (h >= 'a' && h <= 'f') v |= h - 'a' + 10;
            else if (h >= 'A' && h <= 'F') v |= h - 'A' + 10; else fail("bad escape");
        }
        return v;
    }
    std::string string() {
        ++i_;  // opening quote
        std::string out;
        while (true) {
            if (i_ >= s_.size()) fail("unterminated string");
            char c = s_[i_++];
            if (c == '"') break;
            if ((unsigned char)c < 0x20) fail("control character in string");
            if (c != '\\') { out += c; continue; }
            if (i_ >= s_.size()) fail("bad escape");
            char e = s_[i_++];
            switch (e) {
            case '"': out += '"'; break; case '\\': out += '\\'; break; case '/': out += '/'; break;
            case 'b': out += '\b'; break; case 'f': out += '\f'; break; case 'n': out += '\n'; break;
            case 'r': out += '\r'; break; case 't': out += '\t'; break;
            case 'u': {
                unsigned cp = hex4();
                if (cp >= 0xD800 && cp <= 0xDBFF && i_ + 6 <= s_.size() && s_[i_] == '\\' && s_[i_ + 1] == 'u') {
                    i_ += 2; unsigned lo = hex4();
                    if (lo >= 0xDC00 && lo <= 0xDFFF) cp = 0x10000 + ((cp - 0xD800) << 10) + (lo - 0xDC00);
                }
                appendUtf8(out, cp);
                break;
            }
            default: fail("bad escape");
            }
        }
        return out;
    }
};
}  // namespace

JsonValue ParseJson(const std::string& utf8) {
    if (utf8.size() > 8 * 1024 * 1024) throw std::runtime_error("JSON: document too large");
    return Parser(utf8).parseDocument();
}

std::string JsonQuote(const std::string& utf8) {
    std::string out = "\"";
    for (unsigned char c : utf8) {
        switch (c) {
        case '"': out += "\\\""; break; case '\\': out += "\\\\"; break;
        case '\n': out += "\\n"; break; case '\r': out += "\\r"; break; case '\t': out += "\\t"; break;
        default:
            if (c < 0x20) { char buf[8]; std::snprintf(buf, sizeof buf, "\\u%04x", c); out += buf; }
            else out += (char)c;
        }
    }
    return out + "\"";
}

}  // namespace aect
