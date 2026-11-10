/* Scan harness for the PLC lane. Compiled by gcc or clang against the C that matiec generated.
 * stdin: one line per scan, "IX0.0=1 IX0.1=0 ..." sets located inputs, then one scan runs.
 * stdout: one line per scan, every located output, "QX0.0=1 ...".
 * "--probe PORT": try one loopback connect and exit 0 when it failed (network denied), 3 when it worked.
 * ptrs.h is written by lane.ts from the generated LOCATED_VARIABLES.h. BOOL located variables only. */
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <unistd.h>
#include <sys/socket.h>
#include <netinet/in.h>
#include <arpa/inet.h>
#include "iec_types_all.h"
#include "ptrs.h"

TIME __CURRENT_TIME;
unsigned long long common_ticktime__ = 20000000ULL;
extern void config_init__(void);
extern void config_run__(unsigned long tick);

int main(int argc, char **argv) {
	if (argc == 3 && !strcmp(argv[1], "--probe")) {
		int s = socket(AF_INET, SOCK_STREAM, 0);
		struct sockaddr_in a;
		memset(&a, 0, sizeof a);
		a.sin_family = AF_INET;
		a.sin_port = htons((unsigned short)atoi(argv[2]));
		a.sin_addr.s_addr = htonl(INADDR_LOOPBACK);
		return (s >= 0 && connect(s, (struct sockaddr *)&a, sizeof a) == 0) ? 3 : 0;
	}
	config_init__();
	PTR_INIT();
	unsigned long tick = 0;
	char line[4096];
	while (fgets(line, sizeof line, stdin)) {
		for (char *t = strtok(line, " \n"); t; t = strtok(NULL, " \n")) {
			char *e = strchr(t, '=');
			if (!e) continue;
			*e = 0;
			for (int i = 0; i < NPTR; i++)
				if (!strcmp(PTR[i].n, t)) *PTR[i].p = atoi(e + 1) ? 1 : 0;
		}
		config_run__(tick++);
		int first = 1;
		for (int i = 0; i < NPTR; i++) {
			if (PTR[i].n[0] != 'Q') continue;
			printf("%s%s=%d", first ? "" : " ", PTR[i].n, *PTR[i].p ? 1 : 0);
			first = 0;
		}
		printf("\n");
		fflush(stdout);
	}
	return 0;
}
