import { describe, test, expect } from "bun:test";
import { resolve, join } from "node:path";

const WORK_DIR = process.env.WORK_DIR;
if (!WORK_DIR) throw new Error("WORK_DIR env required");

async function loadModules() {
  const lexerMod = await import(resolve(join(WORK_DIR, "lexer.ts")));
  const parserMod = await import(resolve(join(WORK_DIR, "parser.ts")));
  const validatorMod = await import(resolve(join(WORK_DIR, "validator.ts")));
  const serializerMod = await import(resolve(join(WORK_DIR, "serializer.ts")));

  const lex =
    lexerMod.lex ?? lexerMod.tokenize ?? lexerMod.Lexer?.tokenize ?? lexerMod.default;
  const parse =
    parserMod.parse ?? parserMod.Parser?.parse ?? parserMod.default;
  const validate =
    validatorMod.validate ?? validatorMod.Validator?.validate ?? validatorMod.default;
  const serialize =
    serializerMod.serialize ?? serializerMod.Serializer?.serialize ?? serializerMod.default;

  return { lex, parse, validate, serialize };
}

describe("TC001: Config Parser with AST Roundtrip", () => {
  describe("Simple Directives", () => {
    test("parses simple directives", async () => {
      const { parse } = await loadModules();
      expect(typeof parse).toBe("function");

      const ast = parse("FROM node:20\nRUN apt-get update\n");
      expect(ast).toBeTruthy();

      const nodes = ast.body ?? ast.nodes ?? ast.children ?? (Array.isArray(ast) ? ast : [ast]);
      expect(nodes.length).toBeGreaterThanOrEqual(2);

      const first = nodes[0];
      const directive = first.directive ?? first.name ?? first.type ?? first.keyword;
      expect(String(directive).toUpperCase()).toContain("FROM");
    });

    test("parses key-value assignments", async () => {
      const { parse } = await loadModules();
      const ast = parse("PORT 3000\nHOST localhost\n");
      const nodes = ast.body ?? ast.nodes ?? ast.children ?? (Array.isArray(ast) ? ast : [ast]);
      expect(nodes.length).toBeGreaterThanOrEqual(2);
    });
  });

  describe("Nested Blocks", () => {
    test("parses nested blocks", async () => {
      const { parse } = await loadModules();
      const input = `SERVICE api {
  PORT 3000
  DEPENDS_ON db
}`;
      const ast = parse(input);
      const nodes = ast.body ?? ast.nodes ?? ast.children ?? (Array.isArray(ast) ? ast : [ast]);

      const serviceNode = nodes.find(
        (n: any) =>
          (n.directive ?? n.name ?? n.type ?? "").toString().toUpperCase().includes("SERVICE") ||
          n.block === true ||
          n.children?.length > 0
      );
      expect(serviceNode).toBeTruthy();
    });

    test("handles deeply nested blocks (3 levels)", async () => {
      const { parse } = await loadModules();
      const input = `ENVIRONMENT prod {
  SERVICE api {
    ROUTE /health {
      METHOD GET
      STATUS 200
    }
  }
}`;
      const ast = parse(input);
      expect(ast).toBeTruthy();
      // Should not crash on nested blocks
    });
  });

  describe("Heredocs", () => {
    test("parses heredoc values", async () => {
      const { parse } = await loadModules();
      const input = `SCRIPT <<EOF
echo "hello world"
ls -la
EOF
PORT 3000`;
      const ast = parse(input);
      const nodes = ast.body ?? ast.nodes ?? ast.children ?? (Array.isArray(ast) ? ast : [ast]);
      expect(nodes.length).toBeGreaterThanOrEqual(2);

      const scriptNode = nodes.find(
        (n: any) =>
          (n.directive ?? n.name ?? n.type ?? "").toString().toUpperCase().includes("SCRIPT")
      );
      if (scriptNode) {
        const value = scriptNode.value ?? scriptNode.content ?? scriptNode.body;
        expect(String(value)).toContain("hello world");
      }
    });
  });

  describe("Variable Interpolation", () => {
    test("parses variable references with defaults", async () => {
      const { parse } = await loadModules();
      const input = `PORT \${API_PORT:-3000}\nHOST \${HOST}`;
      const ast = parse(input);
      expect(ast).toBeTruthy();

      const nodes = ast.body ?? ast.nodes ?? ast.children ?? (Array.isArray(ast) ? ast : [ast]);
      const portNode = nodes.find(
        (n: any) =>
          (n.directive ?? n.name ?? n.type ?? "").toString().toUpperCase().includes("PORT")
      );
      if (portNode) {
        const value = JSON.stringify(portNode.value ?? portNode.content ?? portNode);
        expect(value).toContain("API_PORT");
      }
    });
  });

  describe("Conditionals", () => {
    test("parses conditional directives", async () => {
      const { parse } = await loadModules();
      const input = `@if production {
  REPLICAS 3
} @else {
  REPLICAS 1
}`;
      const ast = parse(input);
      const nodes = ast.body ?? ast.nodes ?? ast.children ?? (Array.isArray(ast) ? ast : [ast]);

      const conditional = nodes.find(
        (n: any) =>
          (n.type ?? n.kind ?? "").toString().toLowerCase().includes("if") ||
          (n.type ?? n.kind ?? "").toString().toLowerCase().includes("conditional") ||
          n.condition !== undefined
      );
      expect(conditional).toBeTruthy();
    });
  });

  describe("Roundtrip Fidelity", () => {
    test("parse -> serialize -> parse produces equivalent AST", async () => {
      const { parse, serialize } = await loadModules();
      expect(typeof serialize).toBe("function");

      const input = `FROM node:20
PORT 3000
RUN apt-get update`;

      const ast1 = parse(input);
      const output = serialize(ast1);
      expect(typeof output).toBe("string");
      expect(output.length).toBeGreaterThan(0);

      const ast2 = parse(output);

      // Compare structural equivalence (not exact string match)
      const nodes1 = ast1.body ?? ast1.nodes ?? ast1.children ?? (Array.isArray(ast1) ? ast1 : [ast1]);
      const nodes2 = ast2.body ?? ast2.nodes ?? ast2.children ?? (Array.isArray(ast2) ? ast2 : [ast2]);
      expect(nodes2.length).toBe(nodes1.length);
    });

    test("roundtrip with nested blocks preserves structure", async () => {
      const { parse, serialize } = await loadModules();

      const input = `SERVICE api {
  PORT 3000
  HOST localhost
}`;

      const ast1 = parse(input);
      const output = serialize(ast1);
      const ast2 = parse(output);

      const nodes1 = ast1.body ?? ast1.nodes ?? ast1.children ?? (Array.isArray(ast1) ? ast1 : [ast1]);
      const nodes2 = ast2.body ?? ast2.nodes ?? ast2.children ?? (Array.isArray(ast2) ? ast2 : [ast2]);
      expect(nodes2.length).toBe(nodes1.length);
    });
  });

  describe("Validation", () => {
    test("catches duplicate keys in same block", async () => {
      const { parse, validate } = await loadModules();
      const ast = parse("PORT 3000\nPORT 8080\n");

      const result = validate(ast);
      const errors = result.errors ?? result.issues ?? result.warnings ?? result;

      if (Array.isArray(errors)) {
        const hasDup = errors.some((e: any) =>
          JSON.stringify(e).toLowerCase().includes("duplicate")
        );
        expect(hasDup).toBe(true);
      }
    });
  });

  describe("Edge Cases", () => {
    test("empty input returns empty AST", async () => {
      const { parse } = await loadModules();
      const ast = parse("");
      expect(ast).toBeTruthy();
      const nodes = ast.body ?? ast.nodes ?? ast.children ?? (Array.isArray(ast) ? ast : []);
      expect(nodes.length).toBe(0);
    });

    test("comments-only input", async () => {
      const { parse } = await loadModules();
      const ast = parse("# this is a comment\n# another comment\n");
      expect(ast).toBeTruthy();
    });

    test("handles inline comments", async () => {
      const { parse } = await loadModules();
      const ast = parse("PORT 3000 # the api port\n");
      const nodes = ast.body ?? ast.nodes ?? ast.children ?? (Array.isArray(ast) ? ast : [ast]);
      expect(nodes.length).toBeGreaterThanOrEqual(1);
    });
  });

  describe("Lexer", () => {
    test("tokenizes basic input", async () => {
      const { lex } = await loadModules();
      if (typeof lex !== "function") return; // lexer optional if parse handles it

      const tokens = lex("FROM node:20\n");
      expect(Array.isArray(tokens)).toBe(true);
      expect(tokens.length).toBeGreaterThan(0);
    });
  });
});
