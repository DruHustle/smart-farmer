// Acceptance diagnostics only: public, same-user libproc reads, never attach or suspend.
#ifndef __APPLE__
#error This diagnostic must be compiled against the actual Darwin SDK.
#endif
#include <errno.h>
#include <inttypes.h>
#include <limits.h>
#include <libproc.h>
#include <mach/thread_info.h>
#include <poll.h>
#include <pthread.h>
#include <stdint.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <sys/proc_info.h>
#include <time.h>
#include <unistd.h>

static int process_identity(pid_t pid, struct proc_bsdinfo *info) {
  memset(info, 0, sizeof(*info));
  return proc_pidinfo(pid, PROC_PIDTBSDINFO, 0, info, sizeof(*info)) == (int)sizeof(*info)
    && info->pbi_pid == (uint32_t)pid && info->pbi_uid == getuid();
}

#ifdef NODE_IDENTITY_BRIDGE
#include <node_api.h>

static int property(napi_env env, napi_value object, const char *key, const char *value) {
  napi_value text;
  return napi_create_string_utf8(env, value, NAPI_AUTO_LENGTH, &text) == napi_ok
    && napi_set_named_property(env, object, key, text) == napi_ok;
}

static napi_value identity(napi_env env, napi_callback_info ignored) {
  (void)ignored;
  napi_value result;
  if (napi_create_object(env, &result) != napi_ok) return NULL;
  const char *reason = "not_main_thread";
  uint64_t tid = 0;
  struct proc_bsdinfo info;
  if (pthread_main_np()) {
    reason = "identity_unavailable";
    if (pthread_threadid_np(NULL, &tid) == 0 && tid != 0 && process_identity(getpid(), &info)) {
      char value[32];
      const char *keys[] = {"pid", "uid", "startSeconds", "startMicros", "threadId"};
      const uint64_t values[] = {(uint64_t)getpid(), (uint64_t)getuid(),
        info.pbi_start_tvsec, info.pbi_start_tvusec, tid};
      for (size_t i = 0; i < sizeof(values) / sizeof(values[0]); i++) {
        snprintf(value, sizeof(value), "%" PRIu64, values[i]);
        if (!property(env, result, keys[i], value)) return NULL;
      }
      reason = "ready";
    }
  }
  if (!property(env, result, "reason", reason)) return NULL;
  return result;
}

static napi_value initialize(napi_env env, napi_value exports) {
  napi_value function;
  if (napi_create_function(env, "identity", NAPI_AUTO_LENGTH, identity, NULL, &function) != napi_ok
    || napi_set_named_property(env, exports, "identity", function) != napi_ok) return NULL;
  return exports;
}
NAPI_MODULE(NODE_GYP_MODULE_NAME, initialize)
#else
static int decimal(const char *text, uint64_t *value) {
  if (!text || !*text || strlen(text) > 20 || (text[0] == '0' && text[1])) return 0;
  for (const char *p = text; *p; p++) if (*p < '0' || *p > '9') return 0;
  char *end;
  errno = 0;
  *value = strtoull(text, &end, 10);
  return errno == 0 && *end == 0;
}

static uint64_t clock_ns(clockid_t clock) {
  struct timespec time;
  if (clock_gettime(clock, &time) != 0) return 0;
  return (uint64_t)time.tv_sec * UINT64_C(1000000000) + (uint64_t)time.tv_nsec;
}

static int refuse(const char *reason) {
  printf("{\"reason\":\"%s\"}\n", reason);
  return 0;
}

int main(int argc, char **argv) {
  if (argc != 7 || (strcmp(argv[1], "once") && strcmp(argv[1], "observe"))) return refuse("invalid_input");
  uint64_t values[5];
  for (size_t i = 0; i < 5; i++) if (!decimal(argv[i + 2], &values[i])) return refuse("invalid_input");
  if (values[0] <= 1 || values[0] > INT_MAX || values[1] != getuid()
    || values[2] == 0 || values[3] >= 1000000 || values[4] == 0) return refuse("identity_mismatch");
  const pid_t pid = (pid_t)values[0];
  const int count = !strcmp(argv[1], "observe") ? 20 : 1;
  const uint64_t cpu_started = clock_ns(CLOCK_PROCESS_CPUTIME_ID);
  if (!cpu_started) return refuse("clock_unavailable");
  for (int index = 0; index < count; index++) {
    struct proc_bsdinfo before, after;
    struct proc_threadinfo thread;
    const uint64_t started = clock_ns(CLOCK_MONOTONIC);
    const uint64_t wall = clock_ns(CLOCK_REALTIME);
    if (!started || !wall) return refuse("clock_unavailable");
    if (!process_identity(pid, &before)) return refuse("process_unavailable");
    if (before.pbi_start_tvsec != values[2] || before.pbi_start_tvusec != values[3]) return refuse("identity_mismatch");
    memset(&thread, 0, sizeof(thread));
    if (proc_pidinfo(pid, PROC_PIDTHREADID64INFO, values[4], &thread, sizeof(thread)) != (int)sizeof(thread)) return refuse("thread_unavailable");
    if (!process_identity(pid, &after) || before.pbi_start_tvsec != after.pbi_start_tvsec
      || before.pbi_start_tvusec != after.pbi_start_tvusec) return refuse("identity_mismatch");
    const uint64_t ended = clock_ns(CLOCK_MONOTONIC);
    const uint64_t wall_ended = clock_ns(CLOCK_REALTIME);
    const uint64_t cpu_ended = clock_ns(CLOCK_PROCESS_CPUTIME_ID);
    if (ended < started || wall_ended < wall || cpu_ended < cpu_started) return refuse("clock_unavailable");
    if (thread.pth_run_state < TH_STATE_RUNNING || thread.pth_run_state > TH_STATE_HALTED) return refuse("state_unavailable");
    // CPU fields are nanoseconds; the kernel constructs them from microsecond counters.
    // Do not output the structure's name, addresses, scaled usage or zeroed sleep_time.
    printf("{\"reason\":\"ready\",\"index\":%d,\"state\":%d,\"wallMs\":%.3f,\"wallEndMs\":%.3f,"
      "\"monotonicNs\":\"%" PRIu64 "\",\"queryNs\":\"%" PRIu64 "\","
      "\"userNs\":\"%" PRIu64 "\",\"systemNs\":\"%" PRIu64 "\",\"readerCpuNs\":\"%" PRIu64 "\"}\n",
      index, thread.pth_run_state, (double)wall / 1000000.0, (double)wall_ended / 1000000.0, started, ended - started,
      thread.pth_user_time, thread.pth_system_time, cpu_ended - cpu_started);
    if (fflush(stdout) != 0) return 0;
    if (index + 1 < count) {
      // EOF cancels only this reader. No signal is ever sent to the observed PID.
      struct pollfd input = {.fd = STDIN_FILENO, .events = POLLIN | POLLHUP};
      const int ready = poll(&input, 1, 100);
      if (ready < 0 || (ready > 0 && input.revents)) return 0;
    }
  }
  return 0;
}
#endif
