/* util-linux's setsid, for a macOS CI host's GNU bundle (ci-gnu-userland.sh,
 * private-repo): util-linux does not build on macOS, and the Mac had none.
 *
 *   setsid [-f] [-w] PROGRAM [ARGS...]
 *
 * Runs PROGRAM in a new session. It forks first when this process leads its
 * process group (setsid(2) refuses a group leader) or with -f; -w waits for
 * the child and exits with its status (128+N for a signal N).
 * ci-gnu-userland.test.sh holds it to util-linux's behaviour. */
#include <stdio.h>
#include <string.h>
#include <sys/wait.h>
#include <unistd.h>

int main(int argc, char **argv) {
  int i = 1, fork_always = 0, wait_child = 0;
  for (; i < argc && argv[i][0] == '-' && argv[i][1]; i++) {
    if (!strcmp(argv[i], "--")) { i++; break; }
    if (!strcmp(argv[i], "--fork")) { fork_always = 1; continue; }
    if (!strcmp(argv[i], "--wait")) { wait_child = 1; continue; }
    if (argv[i][1] == '-') { fprintf(stderr, "setsid: unknown option %s\n", argv[i]); return 1; }
    for (char *c = argv[i] + 1; *c; c++) {
      if (*c == 'f') fork_always = 1;
      else if (*c == 'w') wait_child = 1;
      else { fprintf(stderr, "setsid: unknown option -%c\n", *c); return 1; }
    }
  }
  if (i >= argc) { fprintf(stderr, "usage: setsid [-f] [-w] program [arguments]\n"); return 1; }
  if (fork_always || getpgrp() == getpid()) {
    pid_t pid = fork();
    if (pid < 0) { perror("setsid: fork"); return 1; }
    if (pid > 0) {
      int status;
      if (!wait_child) return 0;
      if (waitpid(pid, &status, 0) < 0) { perror("setsid: wait"); return 1; }
      return WIFEXITED(status) ? WEXITSTATUS(status) : 128 + WTERMSIG(status);
    }
  }
  if (setsid() < 0) { perror("setsid"); return 1; }
  execvp(argv[i], argv + i);
  perror(argv[i]);
  return 127;
}
