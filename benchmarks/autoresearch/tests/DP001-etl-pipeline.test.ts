import { describe, test, expect } from "bun:test";
import { resolve, join } from "node:path";

const WORK_DIR = process.env.WORK_DIR;
if (!WORK_DIR) throw new Error("WORK_DIR env required");

// Dynamic imports from LLM output
async function loadModules() {
  const parserMod = await import(resolve(join(WORK_DIR, "parser.ts")));
  const transformsMod = await import(resolve(join(WORK_DIR, "transforms.ts")));
  const pipelineMod = await import(resolve(join(WORK_DIR, "pipeline.ts")));
  const reportMod = await import(resolve(join(WORK_DIR, "report.ts")));

  const parseCSV =
    parserMod.parseCSV ?? parserMod.parse ?? parserMod.default?.parseCSV ?? parserMod.default;
  const pipeline =
    pipelineMod.runPipeline ??
    pipelineMod.Pipeline?.run ??
    pipelineMod.default?.run ??
    pipelineMod.etl ??
    pipelineMod.default;

  return { parserMod, transformsMod, pipelineMod, reportMod, parseCSV, pipeline };
}

describe("DP001: ETL Data Pipeline", () => {
  describe("CSV Parser", () => {
    test("parses basic CSV with headers", async () => {
      const { parseCSV } = await loadModules();
      expect(typeof parseCSV).toBe("function");
      const result = parseCSV("name,age\nAlice,30\nBob,25\n");
      expect(result).toBeTruthy();
      const rows = Array.isArray(result) ? result : result.rows ?? result.data;
      expect(rows.length).toBeGreaterThanOrEqual(2);
    });

    test("handles quoted fields with commas", async () => {
      const { parseCSV } = await loadModules();
      const result = parseCSV('name,bio\nAlice,"Loves coding, hiking"\n');
      const rows = Array.isArray(result) ? result : result.rows ?? result.data;
      expect(rows.length).toBeGreaterThanOrEqual(1);
      const first = rows[0];
      const bio = first.bio ?? first[1] ?? first["bio"];
      expect(bio).toContain("coding");
      expect(bio).toContain("hiking");
    });

    test("handles BOM marker", async () => {
      const { parseCSV } = await loadModules();
      const result = parseCSV("\ufeffid,name\n1,Alice\n");
      const rows = Array.isArray(result) ? result : result.rows ?? result.data;
      expect(rows.length).toBeGreaterThanOrEqual(1);
      const first = rows[0];
      // The key should be "id", not "\ufeffid"
      const id = first.id ?? first["id"];
      expect(id).toBeDefined();
    });

    test("handles mixed line endings (CRLF and LF)", async () => {
      const { parseCSV } = await loadModules();
      const result = parseCSV("a,b\r\n1,2\n3,4\r\n");
      const rows = Array.isArray(result) ? result : result.rows ?? result.data;
      expect(rows.length).toBeGreaterThanOrEqual(2);
    });
  });

  describe("Full Pipeline", () => {
    test("runs without crashing on messy data", async () => {
      const { pipeline } = await loadModules();
      expect(typeof pipeline).toBe("function");

      // Import the fixture data
      const fixtureData = await import(
        resolve(join(WORK_DIR, "..", "..", "fixtures", "etl-data.ts"))
      ).catch(() =>
        import(resolve(join(process.cwd(), "benchmarks", "fixtures", "etl-data.ts")))
      );

      const result = await Promise.resolve(
        pipeline(fixtureData.CUSTOMERS_CSV, fixtureData.ORDERS_CSV, fixtureData.PRODUCTS_CSV)
      );
      expect(result).toBeTruthy();
    });

    test("deduplicates customers by email", async () => {
      const { pipeline } = await loadModules();
      const fixtureData = await import(
        resolve(join(WORK_DIR, "..", "..", "fixtures", "etl-data.ts"))
      ).catch(() =>
        import(resolve(join(process.cwd(), "benchmarks", "fixtures", "etl-data.ts")))
      );

      const result = await Promise.resolve(
        pipeline(fixtureData.CUSTOMERS_CSV, fixtureData.ORDERS_CSV, fixtureData.PRODUCTS_CSV)
      );

      const customers =
        result.customers ?? result.validCustomers ?? result.data?.customers;
      if (customers) {
        // alice@example.com appears twice (C001 and C004) — should be merged
        const alices = customers.filter(
          (c: any) =>
            (c.email ?? c.Email ?? "").toLowerCase() === "alice@example.com"
        );
        expect(alices.length).toBe(1);

        // bob@example.com appears twice (C002 and C011) — should be merged
        const bobs = customers.filter(
          (c: any) =>
            (c.email ?? c.Email ?? "").toLowerCase() === "bob@example.com"
        );
        expect(bobs.length).toBe(1);
      }
    });

    test("normalizes dates to ISO format", async () => {
      const { pipeline } = await loadModules();
      const fixtureData = await import(
        resolve(join(WORK_DIR, "..", "..", "fixtures", "etl-data.ts"))
      ).catch(() =>
        import(resolve(join(process.cwd(), "benchmarks", "fixtures", "etl-data.ts")))
      );

      const result = await Promise.resolve(
        pipeline(fixtureData.CUSTOMERS_CSV, fixtureData.ORDERS_CSV, fixtureData.PRODUCTS_CSV)
      );

      const customers =
        result.customers ?? result.validCustomers ?? result.data?.customers;
      if (customers) {
        for (const c of customers) {
          const date = c.created_at ?? c.createdAt ?? c.date;
          if (date) {
            // Should be ISO format: YYYY-MM-DD
            expect(date).toMatch(/^\d{4}-\d{2}-\d{2}/);
          }
        }
      }
    });

    test("drops orders with invalid references", async () => {
      const { pipeline } = await loadModules();
      const fixtureData = await import(
        resolve(join(WORK_DIR, "..", "..", "fixtures", "etl-data.ts"))
      ).catch(() =>
        import(resolve(join(process.cwd(), "benchmarks", "fixtures", "etl-data.ts")))
      );

      const result = await Promise.resolve(
        pipeline(fixtureData.CUSTOMERS_CSV, fixtureData.ORDERS_CSV, fixtureData.PRODUCTS_CSV)
      );

      const orders = result.orders ?? result.validOrders ?? result.data?.orders;
      if (orders) {
        // O005 references C999 (doesn't exist) — should be dropped
        const o005 = orders.find(
          (o: any) => (o.order_id ?? o.orderId ?? o.id) === "O005"
        );
        expect(o005).toBeUndefined();

        // O006 references P999 (doesn't exist) — should be dropped
        const o006 = orders.find(
          (o: any) => (o.order_id ?? o.orderId ?? o.id) === "O006"
        );
        expect(o006).toBeUndefined();
      }
    });

    test("computes revenue per customer", async () => {
      const { pipeline } = await loadModules();
      const fixtureData = await import(
        resolve(join(WORK_DIR, "..", "..", "fixtures", "etl-data.ts"))
      ).catch(() =>
        import(resolve(join(process.cwd(), "benchmarks", "fixtures", "etl-data.ts")))
      );

      const result = await Promise.resolve(
        pipeline(fixtureData.CUSTOMERS_CSV, fixtureData.ORDERS_CSV, fixtureData.PRODUCTS_CSV)
      );

      const revenue =
        result.revenue ?? result.revenuePerCustomer ?? result.data?.revenue ?? result.aggregates;
      expect(revenue).toBeTruthy();

      // Check Alice's revenue (should be highest)
      if (typeof revenue === "object") {
        const values = Array.isArray(revenue)
          ? revenue
          : Object.entries(revenue).map(([k, v]) => ({
              customer: k,
              total: v,
            }));

        // Alice should have > $1000 total
        const alice = values.find(
          (r: any) =>
            (r.customer ?? r.email ?? r.customerId ?? r.name ?? "")
              .toString()
              .toLowerCase()
              .includes("alice") ||
            (r.customer ?? r.email ?? r.customerId ?? "")
              .toString()
              .includes("C001")
        );
        if (alice) {
          const total =
            typeof alice.total === "number"
              ? alice.total
              : parseFloat(String(alice.total ?? alice.revenue ?? 0));
          // Alice's total should be ~$1055.43 (allow for currency conversion differences)
          expect(total).toBeGreaterThan(1000);
        }
      }
    });

    test("generates quality report with issue counts", async () => {
      const { pipeline } = await loadModules();
      const fixtureData = await import(
        resolve(join(WORK_DIR, "..", "..", "fixtures", "etl-data.ts"))
      ).catch(() =>
        import(resolve(join(process.cwd(), "benchmarks", "fixtures", "etl-data.ts")))
      );

      const result = await Promise.resolve(
        pipeline(fixtureData.CUSTOMERS_CSV, fixtureData.ORDERS_CSV, fixtureData.PRODUCTS_CSV)
      );

      const report =
        result.report ?? result.qualityReport ?? result.quality ?? result.errors;
      expect(report).toBeTruthy();

      // Report should mention dropped/invalid rows
      if (typeof report === "object") {
        const reportStr = JSON.stringify(report).toLowerCase();
        // Should have some count of issues
        expect(
          report.droppedRows ??
            report.dropped ??
            report.errors ??
            report.issues ??
            report.totalIssues ??
            reportStr.includes("drop") ??
            reportStr.includes("invalid")
        ).toBeTruthy();
      }
    });

    test("handles malformed rows without crashing", async () => {
      const { parseCSV } = await loadModules();
      // Row with wrong column count
      const result = parseCSV("a,b,c\n1,2\n3,4,5\n6\n");
      // Should not throw, should process what it can
      expect(result).toBeTruthy();
    });

    test("converts currency strings to numeric values", async () => {
      const { pipeline } = await loadModules();
      const fixtureData = await import(
        resolve(join(WORK_DIR, "..", "..", "fixtures", "etl-data.ts"))
      ).catch(() =>
        import(resolve(join(process.cwd(), "benchmarks", "fixtures", "etl-data.ts")))
      );

      const result = await Promise.resolve(
        pipeline(fixtureData.CUSTOMERS_CSV, fixtureData.ORDERS_CSV, fixtureData.PRODUCTS_CSV)
      );

      const orders = result.orders ?? result.validOrders ?? result.data?.orders;
      if (orders && orders.length > 0) {
        const first = orders[0];
        const total = first.total ?? first.amount ?? first.price;
        // Total should be numeric, not a string like "$25.98"
        if (total !== undefined) {
          expect(typeof total === "number" || !String(total).includes("$")).toBe(
            true
          );
        }
      }
    });
  });
});
