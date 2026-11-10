/* HAND-WRITTEN C TRANSLATION of fixtures/ref/motor-startstop.st using matiec's located-variable
 * convention (BOOL *__IX0_0 and friends, config_init__, config_run__). Not matiec output: it checks the
 * harness protocol and the TS gates, it is NOT evidence for Gate A. -DFAULT_LATE / -DFAULT_RESTART /
 * -DFAULT_NOESTOP inject three of the seeded faults. */
typedef unsigned char BOOL;
static BOOL i0, i1, i2, i3, i4, q0;
BOOL *__IX0_0 = &i0, *__IX0_1 = &i1, *__IX0_2 = &i2, *__IX0_3 = &i3, *__IX0_4 = &i4, *__QX0_0 = &q0;
static BOOL run, hb_prev, start_prev, estop_prev = 1, safe_s; static int count, hb_stale;
void config_init__(void) { run = hb_prev = start_prev = safe_s = 0; estop_prev = 1; count = hb_stale = 0; }
void config_run__(unsigned long tick) {
	(void)tick;
	if (i4 != hb_prev) hb_stale = 0; else hb_stale++;
	hb_prev = i4;
	BOOL wd_ok = hb_stale < 3, edge = i0 && !start_prev;
#ifdef FAULT_RESTART
	start_prev = i0 && safe_s;
#else
	start_prev = i0;
#endif
#if defined(FAULT_LATE)
	BOOL safe = estop_prev && i3 && wd_ok; estop_prev = i2;
#elif defined(FAULT_NOESTOP)
	BOOL safe = i3 && wd_ok;
#else
	BOOL safe = i2 && i3 && wd_ok;
#endif
	safe_s = safe;
	if (!safe) { run = 0; count = 0; }
	else if (i1) { run = 0; count = 0; }
	else if (edge) { run = 1; count = 0; }
	else if (run) { count++; if (count >= 50) { run = 0; count = 0; } }
	q0 = run && safe;
}
