// The suite may run from inside an 8gent tool shell (the pilot dogfood path). The nesting mark
// would make every spawned bin/8gent.ts exit 2, so tests start without it (#4715). The guard's
// own test sets the mark explicitly on its child.
Reflect.deleteProperty(process.env, "EIGHT_PARENT_SESSION");
