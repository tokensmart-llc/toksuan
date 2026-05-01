import { describe, expect, test } from "bun:test";
import {
  applyTemplateToBody,
  parseTemplateRef,
  parseTemplateVarsHeader,
  renderTemplate,
} from "../src/templates";

describe("parseTemplateRef", () => {
  test("returns null when header is missing or empty", () => {
    expect(parseTemplateRef(null)).toBeNull();
    expect(parseTemplateRef(undefined)).toBeNull();
    expect(parseTemplateRef("")).toBeNull();
    expect(parseTemplateRef("   ")).toBeNull();
  });

  test("parses a bare name → null version (use current_version)", () => {
    expect(parseTemplateRef("code-reviewer")).toEqual({
      ok: true,
      name: "code-reviewer",
      version: null,
    });
  });

  test("parses name@<int> as a pinned version", () => {
    expect(parseTemplateRef("summarizer@7")).toEqual({
      ok: true,
      name: "summarizer",
      version: 7,
    });
  });

  test("treats name@latest as no pin", () => {
    expect(parseTemplateRef("summarizer@latest")).toEqual({
      ok: true,
      name: "summarizer",
      version: null,
    });
  });

  test("rejects bad version pin", () => {
    const r = parseTemplateRef("foo@abc");
    expect(r?.ok).toBe(false);
    if (r && !r.ok) expect(r.error).toContain("version pin");
  });

  test("rejects non-positive integer version", () => {
    expect(parseTemplateRef("foo@0")?.ok).toBe(false);
    expect(parseTemplateRef("foo@-3")?.ok).toBe(false);
    expect(parseTemplateRef("foo@1.5")?.ok).toBe(false);
  });

  test("rejects names with bad chars", () => {
    expect(parseTemplateRef("hello world")?.ok).toBe(false);
    expect(parseTemplateRef("a/b")?.ok).toBe(false);
  });

  test("accepts the dashboard's full character class", () => {
    expect(parseTemplateRef("Foo_BAR.x-y")?.ok).toBe(true);
  });
});

describe("parseTemplateVarsHeader", () => {
  test("returns empty object on missing/empty/bad input", () => {
    expect(parseTemplateVarsHeader(null)).toEqual({});
    expect(parseTemplateVarsHeader("")).toEqual({});
    expect(parseTemplateVarsHeader("not json")).toEqual({});
  });
  test("rejects arrays / non-objects (returns {})", () => {
    expect(parseTemplateVarsHeader("[1,2,3]")).toEqual({});
    expect(parseTemplateVarsHeader("42")).toEqual({});
    expect(parseTemplateVarsHeader('"a string"')).toEqual({});
  });
  test("parses a valid object", () => {
    expect(parseTemplateVarsHeader('{"a":"x","n":3}')).toEqual({
      a: "x",
      n: 3,
    });
  });
});

describe("renderTemplate", () => {
  test("substitutes {{var}} placeholders", () => {
    expect(renderTemplate("hello {{name}}!", { name: "world" })).toBe(
      "hello world!"
    );
  });
  test("tolerates whitespace inside braces", () => {
    expect(renderTemplate("hi {{  who  }}", { who: "a" })).toBe("hi a");
  });
  test("leaves unknown vars untouched (loud, debuggable)", () => {
    expect(renderTemplate("a {{x}} b", { y: "z" })).toBe("a {{x}} b");
  });
  test("renders numbers, booleans, nulls", () => {
    expect(renderTemplate("{{n}} {{b}} {{x}}", { n: 1, b: true, x: null })).toBe(
      "1 true "
    );
  });
  test("renders objects via JSON.stringify", () => {
    expect(renderTemplate("{{o}}", { o: { a: 1 } })).toBe('{"a":1}');
  });
  test("repeats are independently substituted", () => {
    expect(renderTemplate("{{x}}-{{x}}", { x: "a" })).toBe("a-a");
  });
});

describe("applyTemplateToBody", () => {
  test("prepends a system message when none exists", () => {
    const body: Record<string, unknown> = {
      messages: [{ role: "user", content: "hi" }],
    };
    applyTemplateToBody(body, "you are helpful", {});
    expect(body.messages).toEqual([
      { role: "system", content: "you are helpful" },
      { role: "user", content: "hi" },
    ]);
  });

  test("replaces an existing system message", () => {
    const body: Record<string, unknown> = {
      messages: [
        { role: "system", content: "old" },
        { role: "user", content: "hi" },
      ],
    };
    applyTemplateToBody(body, "new system", {});
    expect((body.messages as Array<{ role: string; content: string }>)[0]).toEqual({
      role: "system",
      content: "new system",
    });
  });

  test("substitutes vars in existing message content (string only)", () => {
    const body: Record<string, unknown> = {
      messages: [{ role: "user", content: "Review {{code}}" }],
    };
    applyTemplateToBody(body, "you are reviewer", { code: "let x=1;" });
    expect(
      (body.messages as Array<{ role: string; content: string }>)[1]!.content
    ).toBe("Review let x=1;");
  });

  test("does not touch multi-part (non-string) message content", () => {
    const parts = [{ type: "text", text: "{{x}}" }];
    const body: Record<string, unknown> = {
      messages: [{ role: "user", content: parts }],
    };
    applyTemplateToBody(body, "sys", { x: "should-not-replace" });
    expect(
      (body.messages as Array<{ role: string; content: unknown }>)[1]!.content
    ).toEqual(parts);
  });

  test("strips ts_template_vars from outgoing body", () => {
    const body: Record<string, unknown> = {
      messages: [],
      ts_template_vars: { a: 1 },
    };
    applyTemplateToBody(body, "sys", {});
    expect("ts_template_vars" in body).toBe(false);
  });

  test("works on empty messages array", () => {
    const body: Record<string, unknown> = { messages: [] };
    applyTemplateToBody(body, "sys-only", {});
    expect(body.messages).toEqual([{ role: "system", content: "sys-only" }]);
  });
});
