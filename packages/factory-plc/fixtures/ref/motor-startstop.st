(* Reference: start/stop motor with fail-safe e-stop, sensor fault, heartbeat watchdog and a run timeout.
   Inputs are healthy at 1 for estop_ok, sensor_ok and heartbeat; a lost wire reads 0 and trips the safe state.
   Timeout is counted in scans (50), not TON, so the lane does not depend on the runtime clock. *)
PROGRAM main
  VAR
    start AT %IX0.0 : BOOL;
    stop AT %IX0.1 : BOOL;
    estop_ok AT %IX0.2 : BOOL;
    sensor_ok AT %IX0.3 : BOOL;
    heartbeat AT %IX0.4 : BOOL;
    motor AT %QX0.0 : BOOL;
    run : BOOL := FALSE;
    count : INT := 0;
    hb_prev : BOOL := FALSE;
    hb_stale : INT := 0;
    wd_ok : BOOL := TRUE;
    start_prev : BOOL := FALSE;
    start_edge : BOOL := FALSE;
    safe : BOOL := FALSE;
  END_VAR

  IF heartbeat <> hb_prev THEN hb_stale := 0; ELSE hb_stale := hb_stale + 1; END_IF;
  hb_prev := heartbeat;
  wd_ok := hb_stale < 3;
  start_edge := start AND NOT start_prev;
  start_prev := start;
  safe := estop_ok AND sensor_ok AND wd_ok;
  IF NOT safe THEN run := FALSE; count := 0;
  ELSIF stop THEN run := FALSE; count := 0;
  ELSIF start_edge THEN run := TRUE; count := 0;
  ELSIF run THEN count := count + 1; IF count >= 50 THEN run := FALSE; count := 0; END_IF;
  END_IF;
  motor := run AND safe;
END_PROGRAM

CONFIGURATION config0
  RESOURCE res0 ON PLC
    TASK task0(INTERVAL := T#20ms, PRIORITY := 0);
    PROGRAM inst0 WITH task0 : main;
  END_RESOURCE
END_CONFIGURATION
