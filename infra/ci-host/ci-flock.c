/* util-linux's flock, for a macOS CI host's GNU bundle (ci-gnu-userland.sh):
 * util-linux does not build on macOS, and the Mac's own flock
 * was a Python shim that read `flock -w 30 9` as descriptor 30.
 *
 *   flock [options] FD
 *   flock [options] FILE|DIR COMMAND [ARGS...]
 *   flock [options] FILE|DIR -c COMMAND
 *
 * -s/--shared, -x/-e/--exclusive, -u/--unlock, -n/--nb/--nonblock,
 * -w/--timeout SECS, -E/--conflict-exit-code N, -o/--close (the command does
 * not inherit the lock's descriptor), -c/--command; short options combine
 * (-xn) and long ones take =VALUE. A lock not taken exits 1 (or -E's code);
 * a command's own exit status is flock's. A number that is not one is
 * refused with 64: -E abc, -E 300, -w 1s and a descriptor past INT_MAX as
 * util-linux refuses them; -w -1 and -w inf too (util-linux exits 71 there).
 * Read as atoi/atof read them, -E abc made a lock not taken exit 0 and -w -1
 * wait forever. The -w deadline is on the monotonic clock. ci-gnu-userland.test.sh holds it to util-linux's
 * behaviour. */
#include <errno.h>
#include <fcntl.h>
#include <limits.h>
#include <math.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <sys/file.h>
#include <sys/wait.h>
#include <time.h>
#include <unistd.h>

static double now(void) {
  struct timespec t;
  clock_gettime(CLOCK_MONOTONIC, &t);
  return t.tv_sec + t.tv_nsec / 1e9;
}

static void invalid(const char *what, const char *v) {
  fprintf(stderr, "flock: invalid %s: '%s'\n", what, v);
  exit(64);
}

/* -w SECS: a finite number, zero or more. errno is not asked: strtod's
 * ERANGE is an overflow (HUGE_VAL, not finite) or an underflow (1e-400 is
 * about 0, as util-linux reads it). */
static double secs(const char *v) {
  char *end;
  double d = strtod(v, &end);
  if (!*v || *end || !isfinite(d) || d < 0) invalid("timeout value", v);
  return d;
}

/* -E N: an exit status, 0 to 255. */
static int exit_code(const char *v) {
  char *end;
  errno = 0;
  long n = strtol(v, &end, 10);
  if (!*v || *end || errno || n < 0 || n > 255) invalid("exit code", v);
  return (int)n;
}

static int usage(void) {
  fprintf(stderr, "usage: flock [-sxunoE] [-w secs] fd | file [-c cmd | cmd args...]\n");
  return 64;
}

int main(int argc, char **argv) {
  int i = 1, op = LOCK_EX, nb = 0, unlock = 0, close_fd = 0, conflict = 1, fd = -1;
  double wait = -1;
  const char *cmd = NULL;
  for (; i < argc && argv[i][0] == '-' && argv[i][1]; i++) {
    char *a = argv[i], *val = NULL;
    if (!strcmp(a, "--")) { i++; break; }
    if (a[1] == '-') {
      char *eq = strchr(a, '=');
      if (eq) { *eq = 0; val = eq + 1; }
      const char *name = a + 2;
      if (!strcmp(name, "shared")) op = LOCK_SH;
      else if (!strcmp(name, "exclusive")) op = LOCK_EX;
      else if (!strcmp(name, "unlock")) unlock = 1;
      else if (!strcmp(name, "nb") || !strcmp(name, "nonblock")) nb = 1;
      else if (!strcmp(name, "close")) close_fd = 1;
      else if (!strcmp(name, "timeout") || !strcmp(name, "wait") || !strcmp(name, "conflict-exit-code") || !strcmp(name, "command")) {
        if (!val) { if (i + 1 >= argc) return usage(); val = argv[++i]; }
        if (!strcmp(name, "command")) cmd = val;
        else if (!strcmp(name, "conflict-exit-code")) conflict = exit_code(val);
        else wait = secs(val);
      } else { fprintf(stderr, "flock: unknown option --%s\n", name); return usage(); }
      continue;
    }
    for (char *c = a + 1; *c; c++) {
      if (*c == 's') op = LOCK_SH;
      else if (*c == 'x' || *c == 'e') op = LOCK_EX;
      else if (*c == 'u') unlock = 1;
      else if (*c == 'n') nb = 1;
      else if (*c == 'o') close_fd = 1;
      else if (*c == 'w' || *c == 'E' || *c == 'c') {
        const char *v = c[1] ? c + 1 : (i + 1 < argc ? argv[++i] : NULL);
        if (!v) return usage();
        if (*c == 'w') wait = secs(v); else if (*c == 'E') conflict = exit_code(v); else cmd = v;
        break;
      } else { fprintf(stderr, "flock: unknown option -%c\n", *c); return usage(); }
    }
  }
  if (i >= argc) return usage();
  char *end;
  errno = 0;
  long n = strtol(argv[i], &end, 10);
  /* One numeric operand and no command: a descriptor the caller holds open. */
  int is_fd = *argv[i] && !*end && i == argc - 1 && !cmd;
  if (is_fd && (errno || n < 0 || n > INT_MAX)) { fprintf(stderr, "flock: bad file descriptor: '%s'\n", argv[i]); return 64; }
  if (is_fd) fd = (int)n;
  else if (i == argc - 1 && !cmd) { fprintf(stderr, "flock: %s: not a descriptor, and no command to run\n", argv[i]); return 64; }
  else if ((fd = open(argv[i], O_RDONLY | O_CREAT | O_NOCTTY, 0666)) < 0 && (fd = open(argv[i], O_RDONLY | O_NOCTTY)) < 0) {
    fprintf(stderr, "flock: cannot open %s: %s\n", argv[i], strerror(errno));
    return 66;
  }
  i++;
  /* FILE -c COMMAND: the option after the file, as util-linux takes it. */
  if (!is_fd && !cmd && i + 1 < argc && (!strcmp(argv[i], "-c") || !strcmp(argv[i], "--command"))) { cmd = argv[i + 1]; i += 2; }
  if (unlock) {
    if (flock(fd, LOCK_UN) < 0) { perror("flock"); return 1; }
  } else {
    double deadline = wait >= 0 ? now() + wait : 0;
    for (;;) {
      if (flock(fd, op | ((nb || wait >= 0) ? LOCK_NB : 0)) == 0) break;
      if (errno != EWOULDBLOCK && errno != EINTR) { perror("flock"); return 1; }
      if (nb || (wait >= 0 && now() >= deadline)) return conflict;
      if (wait >= 0) usleep(10000);
    }
  }
  if (is_fd) return 0;
  pid_t pid = fork();
  if (pid < 0) { perror("flock: fork"); return 1; }
  if (pid == 0) {
    if (close_fd) close(fd);
    if (cmd) execl("/bin/sh", "sh", "-c", cmd, (char *)NULL);
    else execvp(argv[i], argv + i);
    perror(cmd ? "/bin/sh" : argv[i]);
    _exit(127);
  }
  int status;
  while (waitpid(pid, &status, 0) < 0)
    if (errno != EINTR) { perror("flock: wait"); return 1; }
  return WIFEXITED(status) ? WEXITSTATUS(status) : 128 + WTERMSIG(status);
}
