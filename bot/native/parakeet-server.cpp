// Resident Parakeet transcriber for Concierge.
//
// Loading the model is most of the cost of a short dictation (~370 ms of ~620 ms for a
// one-second clip, measured September 20, 2026), so this process loads it once and then
// answers requests for as long as Concierge runs.
//
// Protocol, one request and one response per line:
//   stdin:  <request id>\t<path to raw 16 kHz mono float32 PCM>\n
//   stdout: {"ready":true,"loadMs":N}                                   once, after loading
//           {"id":"…","text":"…","audioMs":N,"chunks":N,"computeMs":N}  per request
//           {"id":"…","error":"…"}                                      per failed request
//
// Long audio is cut into pieces of at most 45 seconds, because the model's single-pass
// context is 50 seconds and its long-audio path dropped ~40% of the words on a 12.6-minute
// recording (2,017 characters against 3,410 from base.en). Each cut is placed at the
// quietest 100 ms in the last five seconds of its window so words are not split.

#include "ggml-backend.h"
#include "parakeet.h"

#include <algorithm>
#include <chrono>
#include <cmath>
#include <cstdio>
#include <cstdlib>
#include <cstring>
#include <fstream>
#include <iostream>
#include <string>
#include <vector>

namespace {

constexpr int kSampleRate = PARAKEET_SAMPLE_RATE;
constexpr size_t kMaxChunk = 45 * kSampleRate;
constexpr size_t kSearchSpan = 5 * kSampleRate;
constexpr size_t kFrame = kSampleRate / 10;

void quiet_log(enum ggml_log_level level, const char * text, void *) {
    if (level == GGML_LOG_LEVEL_ERROR) fputs(text, stderr);
}

std::string json_escape(const std::string & in) {
    std::string out;
    out.reserve(in.size() + 8);
    for (unsigned char c : in) {
        switch (c) {
            case '"':  out += "\\\""; break;
            case '\\': out += "\\\\"; break;
            case '\n': out += "\\n";  break;
            case '\r': out += "\\r";  break;
            case '\t': out += "\\t";  break;
            default:
                if (c < 0x20) { char buf[8]; snprintf(buf, sizeof buf, "\\u%04x", c); out += buf; }
                else out += static_cast<char>(c);
        }
    }
    return out;
}

bool read_pcm(const std::string & path, std::vector<float> & pcm) {
    std::ifstream in(path, std::ios::binary | std::ios::ate);
    if (!in) return false;
    const std::streamsize bytes = in.tellg();
    if (bytes <= 0 || bytes % static_cast<std::streamsize>(sizeof(float)) != 0) return false;
    pcm.resize(static_cast<size_t>(bytes) / sizeof(float));
    in.seekg(0);
    return static_cast<bool>(in.read(reinterpret_cast<char *>(pcm.data()), bytes));
}

// End of the next piece: the whole remainder if it fits, otherwise the quietest frame
// near the end of a 45-second window.
size_t next_cut(const std::vector<float> & pcm, size_t start) {
    const size_t remaining = pcm.size() - start;
    if (remaining <= kMaxChunk) return pcm.size();
    const size_t window_end = start + kMaxChunk;
    const size_t search_from = window_end - kSearchSpan;
    size_t best = window_end;
    double best_energy = INFINITY;
    for (size_t frame = search_from; frame + kFrame <= window_end; frame += kFrame / 2) {
        double energy = 0;
        for (size_t i = frame; i < frame + kFrame; ++i) energy += static_cast<double>(pcm[i]) * pcm[i];
        if (energy < best_energy) { best_energy = energy; best = frame + kFrame / 2; }
    }
    return best;
}

void append_text(std::string & out, const char * text) {
    std::string piece(text ? text : "");
    const size_t first = piece.find_first_not_of(" \t\n");
    if (first == std::string::npos) return;
    piece = piece.substr(first, piece.find_last_not_of(" \t\n") - first + 1);
    if (!out.empty()) out += ' ';
    out += piece;
}

}  // namespace

int main(int argc, char ** argv) {
    std::string model;
    int threads = 6;
    for (int i = 1; i < argc; ++i) {
        const std::string arg = argv[i];
        if (arg == "-m" && i + 1 < argc) model = argv[++i];
        else if (arg == "-t" && i + 1 < argc) threads = std::max(1, std::atoi(argv[++i]));
    }
    if (model.empty()) { fprintf(stderr, "usage: %s -m model.bin [-t threads]\n", argv[0]); return 2; }

    ggml_backend_load_all();
    parakeet_log_set(quiet_log, nullptr);

    const auto load_start = std::chrono::steady_clock::now();
    struct parakeet_context * ctx = parakeet_init_from_file_with_params(model.c_str(), parakeet_context_default_params());
    if (!ctx) { fprintf(stderr, "failed to load Parakeet model '%s'\n", model.c_str()); return 1; }
    const auto load_ms = std::chrono::duration_cast<std::chrono::milliseconds>(std::chrono::steady_clock::now() - load_start).count();
    printf("{\"ready\":true,\"loadMs\":%lld}\n", static_cast<long long>(load_ms));
    fflush(stdout);

    std::string line;
    while (std::getline(std::cin, line)) {
        const size_t tab = line.find('\t');
        const std::string id = tab == std::string::npos ? "" : line.substr(0, tab);
        const std::string path = tab == std::string::npos ? "" : line.substr(tab + 1);
        if (id.empty() || path.empty()) { printf("{\"id\":\"%s\",\"error\":\"BAD_REQUEST\"}\n", json_escape(id).c_str()); fflush(stdout); continue; }

        std::vector<float> pcm;
        if (!read_pcm(path, pcm) || pcm.empty()) { printf("{\"id\":\"%s\",\"error\":\"UNREADABLE_AUDIO\"}\n", json_escape(id).c_str()); fflush(stdout); continue; }

        const auto start = std::chrono::steady_clock::now();
        struct parakeet_full_params params = parakeet_full_default_params(PARAKEET_SAMPLING_GREEDY);
        params.n_threads = threads;

        std::string text;
        int chunks = 0;
        bool failed = false;
        for (size_t at = 0; at < pcm.size();) {
            const size_t end = next_cut(pcm, at);
            if (parakeet_full(ctx, params, pcm.data() + at, static_cast<int>(end - at)) != 0) { failed = true; break; }
            const int segments = parakeet_full_n_segments(ctx);
            for (int s = 0; s < segments; ++s) append_text(text, parakeet_full_get_segment_text(ctx, s));
            ++chunks;
            at = end;
        }
        const auto compute_ms = std::chrono::duration_cast<std::chrono::milliseconds>(std::chrono::steady_clock::now() - start).count();
        const long long audio_ms = static_cast<long long>(pcm.size()) * 1000 / kSampleRate;
        if (failed) printf("{\"id\":\"%s\",\"error\":\"INFERENCE_FAILED\"}\n", json_escape(id).c_str());
        else printf("{\"id\":\"%s\",\"text\":\"%s\",\"audioMs\":%lld,\"chunks\":%d,\"computeMs\":%lld}\n",
                    json_escape(id).c_str(), json_escape(text).c_str(), audio_ms, chunks, static_cast<long long>(compute_ms));
        fflush(stdout);
    }

    parakeet_free(ctx);
    return 0;
}
