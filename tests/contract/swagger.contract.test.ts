import { beforeAll, describe, expect, it } from "vitest";
import { REST_CONTRACT } from "../../src/api/contract.js";

// Routes, query parameters and request-body property names (with their exact
// casing) must exist in the published OpenAPI document. It declares no response schemas,
// so response shapes are covered by fixtures and the manual E2E checklist only.
const URL_ = process.env.TICKR_SWAGGER_URL ?? "https://tickr.coderise.cloud/api/docs/v1/swagger.json";

interface Doc { paths: Record<string, Record<string, Operation>>; components?: { schemas?: Record<string, Schema> } }
interface Operation { parameters?: { name: string }[]; requestBody?: { content?: Record<string, { schema?: Schema }> } }
interface Schema { $ref?: string; properties?: Record<string, unknown> }

let doc: Doc;
beforeAll(async () => {
  const res = await fetch(URL_);
  expect(res.ok, `GET ${URL_} → ${res.status}`).toBe(true);
  doc = (await res.json()) as Doc;
});

function resolve(schema: Schema | undefined): Schema | undefined {
  if (!schema?.$ref) return schema;
  const name = schema.$ref.split("/").pop()!;
  return doc.components?.schemas?.[name];
}

describe("Tickr OpenAPI contract", () => {
  for (const route of REST_CONTRACT) {
    it(`${route.method.toUpperCase()} ${route.path}`, () => {
      const op = doc.paths[route.path]?.[route.method];
      expect(op, "route missing from the OpenAPI document").toBeDefined();
      const declared = new Set((op!.parameters ?? []).map((p) => p.name));
      for (const q of route.query) expect(declared, `query parameter ${q}`).toContain(q);
      if (route.body) {
        const schema = resolve(op!.requestBody?.content?.["application/json"]?.schema);
        const props = Object.keys(schema?.properties ?? {});
        for (const p of route.body) expect(props, `body property ${p}`).toContain(p);
      }
    });
  }
});
