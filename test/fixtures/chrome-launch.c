#include <libproc.h>
#include <stdio.h>
#include <stdlib.h>
#include <unistd.h>

int main(int argc, char **argv) {
    if (argc < 2) return 2;
    char path[PROC_PIDPATHINFO_MAXSIZE];
    if (proc_pidpath(getpid(), path, sizeof(path)) <= 0) return 3;
    FILE *output = fopen(argv[argc - 1], "wx");
    if (!output) return 4;
    fprintf(output, "%s\n%s\n", path, getenv("HOME"));
    for (int i = 1; i < argc; i++) fprintf(output, "%s\n", argv[i]);
    fclose(output);
    sleep(15);
    return 0;
}
