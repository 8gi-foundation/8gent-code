/**
 * schema-diff.ts
 * Compares two object schemas and reports structural differences.
 * Detects added/removed/changed fields, type changes, optional-to-required
 * promotions, and generates migration hints.
 *
 * Zero dependencies. Self-contained.
 */

export type SchemaType =
  | "string"
  | "number"
  | "boolean"
  | "array"
  | "object"
  | "null"
  | "undefined"
  | "unknown"
  | string;

export interface SchemaField {
  type: SchemaType;
  required?: boolean;
  items?: SchemaField;        // for arrays
  properties?: SchemaRecord;  // for nested objects
}

export type SchemaRecord = Record<string, SchemaField>;

export type ChangeKind =
  | "added"
  | "removed"
  | "type_changed"
  | "required_changed"
  | "nested_changed";

export interface SchemaDiff {
  kind: ChangeKind;
  path: string;
  before?: SchemaField;
  after?: SchemaField;
  hint: string;
}

export interface DiffResult {
  added: SchemaDiff[];
  removed: SchemaDiff[];
  changed: SchemaDiff[];
  identical: boolean;
  migrationHints: string[];
}

function formatPath(prefix: string, key: string): string {
  return prefix ? `${prefix}.${key}` : key;
}

function typeSummary(field: SchemaField): string {
  if (field.type === "array" && field.items) {
    return `${field.type}<${typeSummary(field.items)}>`;
  }
  if (field.type === "object" && field.properties) {
    const keys = Object.keys(field.properties).join(", ");
    return `object{${keys}}`;
  }
  return field.type;
}

function diffFields(
  before: SchemaRecord,
  after: SchemaRecord,
  diffs: SchemaDiff[],
  prefix = ""
): void {
  const allKeys = new Set([...Object.keys(before), ...Object.keys(after)]);

  for (const key of allKeys) {
    const path = formatPath(prefix, key);
    const bField = before[key];
    const aField = after[key];

    if (!bField) {
      // Field was added
      diffs.push({
        kind: "added",
        path,
        after: aField,
        hint: aField.required
          ? `BREAKING: add required field "${path}" (${typeSummary(aField)}) - existing records need backfill`
          : `Non-breaking: optional field "${path}" (${typeSummary(aField)}) added`,
      });
      continue;
    }

    if (!aField) {
      // Field was removed
      diffs.push({
        kind: "removed",
        path,
        before: bField,
        hint: `BREAKING: field "${path}" removed - consumers must drop references`,
      });
      continue;
    }

    // Both exist - check for changes
    const typeChanged = bField.type !== aField.type;
    const requiredChanged =
      (bField.required ?? false) !== (aField.required ?? false);

    if (typeChanged) {
      diffs.push({
        kind: "type_changed",
        path,
        before: bField,
        after: aField,
        hint: `BREAKING: "${path}" type changed ${typeSummary(bField)} -> ${typeSummary(aField)} - migration/coercion required`,
      });
    } else if (requiredChanged) {
      const promoted = !bField.required && aField.required;
      diffs.push({
        kind: "required_changed",
        path,
        before: bField,
        after: aField,
        hint: promoted
          ? `BREAKING: "${path}" promoted to required - all records must have this field`
          : `Non-breaking: "${path}" relaxed to optional`,
      });
    }

    // Recurse into nested objects
    if (
      bField.type === "object" &&
      aField.type === "object" &&
      bField.properties &&
      aField.properties
    ) {
      diffFields(bField.properties, aField.properties, diffs, path);
    }

    // Recurse into array items
    if (
      bField.type === "array" &&
      aField.type === "array" &&
      bField.items &&
      aField.items &&
      bField.items.type === "object" &&
      aField.items.type === "object" &&
      bField.items.properties &&
      aField.items.properties
    ) {
      diffFields(bField.items.properties, aField.items.properties, diffs, `${path}[]`);
    }
  }
}

/**
 * Compare two schemas and return a structured diff with migration hints.
 *
 * @param before - Schema before the change
 * @param after  - Schema after the change
 * @returns DiffResult with categorized changes and migration hints
 */
export function diffSchema(
  before: SchemaRecord,
  after: SchemaRecord
): DiffResult {
  const allDiffs: SchemaDiff[] = [];
  diffFields(before, after, allDiffs);

  const added = allDiffs.filter((d) => d.kind === "added");
  const removed = allDiffs.filter((d) => d.kind === "removed");
  const changed = allDiffs.filter(
    (d) => d.kind !== "added" && d.kind !== "removed"
  );

  const breakingHints = allDiffs
    .filter((d) => d.hint.startsWith("BREAKING"))
    .map((d) => d.hint);

  const nonBreakingHints = allDiffs
    .filter((d) => d.hint.startsWith("Non-breaking"))
    .map((d) => d.hint);

  const migrationHints = [...breakingHints, ...nonBreakingHints];

  if (breakingHints.length === 0 && nonBreakingHints.length === 0) {
    if (allDiffs.length === 0) {
      migrationHints.push("No changes detected - schemas are identical.");
    }
  }

  return {
    added,
    removed,
    changed,
    identical: allDiffs.length === 0,
    migrationHints,
  };
}
