#include <errno.h>
#include <libproc.h>
#include <mach/mach_time.h>
#include <stdio.h>
#include <stdlib.h>
#include <sys/resource.h>

// A single read of a live process. No task port, suspension, or TCC capability is requested.
int main(int argc, char **argv) {
  if (argc != 2) return 2;
  char *end = NULL;
  long parsed = strtol(argv[1], &end, 10);
  if (!end || *end || parsed <= 0 || parsed > 999999) return 2;
  struct rusage_info_v0 usage = {0};
  if (proc_pid_rusage((int)parsed, RUSAGE_INFO_V0, (rusage_info_t *)&usage) != 0) {
    fprintf(stderr, "proc_pid_rusage errno=%d\n", errno);
    return 1;
  }
  char path[PROC_PIDPATHINFO_MAXSIZE] = {0};
  if (proc_pidpath((int)parsed, path, sizeof(path)) <= 0) return 1;
  mach_timebase_info_data_t timebase;
  if (mach_timebase_info(&timebase) != KERN_SUCCESS || !timebase.denom) return 1;
  printf("{\"pid\":%ld,\"birthAbstime\":%llu,\"userNs\":%llu,\"systemNs\":%llu,\"physicalBytes\":%llu,\"path\":\"",
    parsed, (unsigned long long)usage.ri_proc_start_abstime,
    (unsigned long long)(usage.ri_user_time * timebase.numer / timebase.denom),
    (unsigned long long)(usage.ri_system_time * timebase.numer / timebase.denom),
    (unsigned long long)usage.ri_phys_footprint);
  for (const char *p = path; *p; p++) {
    if (*p == '"' || *p == '\\') putchar('\\');
    putchar(*p);
  }
  puts("\"}");
  return 0;
}
