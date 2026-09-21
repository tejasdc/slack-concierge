/*
 * The executable inside the Mac's agent-host app bundle. launchd starts this instead of
 * bun, so macOS attributes every permission the service and the agents it starts request
 * to this app (shown as its CFBundleDisplayName) rather than to "bun". It starts the given
 * program as a child, forwards stop signals to it and exits with its status. It must spawn
 * rather than exec: after an exec the running code would be bun again.
 *
 * Kept deliberately tiny and stable: macOS remembers approvals by the app's signed identity,
 * and the installer rebuilds it only when this file or the bundle's metadata changes.
 */
#include <errno.h>
#include <signal.h>
#include <spawn.h>
#include <stdio.h>
#include <string.h>
#include <sys/wait.h>
#include <unistd.h>

extern char **environ;
static volatile pid_t child = 0;

static void forward(int signal_number) {
  if (child > 0) kill(child, signal_number);
}

int main(int argc, char **argv) {
  if (argc < 2) {
    fprintf(stderr, "usage: %s <program> [arguments...]\n", argv[0]);
    return 64;
  }
  struct sigaction action;
  memset(&action, 0, sizeof action);
  action.sa_handler = forward;
  sigemptyset(&action.sa_mask);
  sigaction(SIGTERM, &action, NULL);
  sigaction(SIGINT, &action, NULL);
  sigaction(SIGHUP, &action, NULL);

  pid_t pid;
  int spawned = posix_spawn(&pid, argv[1], NULL, NULL, argv + 1, environ);
  if (spawned != 0) {
    fprintf(stderr, "agent-host: cannot start %s: %s\n", argv[1], strerror(spawned));
    return 70;
  }
  child = pid;
  int status = 0;
  while (waitpid(pid, &status, 0) < 0) {
    if (errno != EINTR) return 71;
  }
  if (WIFEXITED(status)) return WEXITSTATUS(status);
  if (WIFSIGNALED(status)) return 128 + WTERMSIG(status);
  return 1;
}
