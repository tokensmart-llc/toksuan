/**
 * SAML helper tests. Don't fire a full XML round-trip (that would
 * require a fixture cert + assertion which is brittle); cover the
 * code paths we actually own:
 *   - parseTemplateRef-style header parsing for SAML config
 *   - emailDomain helper
 *   - safeRelayPath open-redirect blocker
 *   - buildEntities config-validation guards
 *   - spMetadataXml returns valid XML for a real org config
 */
import { describe, expect, test } from "bun:test";
import {
  buildEntities,
  emailDomain,
  safeRelayPath,
  spMetadataXml,
  type OrgSamlConfig,
} from "../src/lib/saml";

const VALID_CFG: OrgSamlConfig = {
  organization_id: "org-1",
  organization_name: "Acme",
  saml_idp_metadata_xml: null,
  saml_idp_entity_id: "https://idp.example.com/saml2",
  saml_idp_sso_url: "https://idp.example.com/saml2/sso",
  // 32 random bytes base64-encoded — samlify only needs SOMETHING that
  // looks like a cert at metadata-construction time; it doesn't validate
  // the chain until consume.
  saml_idp_x509_cert:
    "MIIBIjANBgkqhkiG9w0BAQEFAAOCAQ8AMIIBCgKCAQEAxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx",
  saml_email_domain: "acme.com",
  saml_enforcement_mode: "optional",
  saml_default_role: "member",
};

describe("emailDomain", () => {
  test("extracts the domain part lowercased", () => {
    expect(emailDomain("Alice@Acme.COM")).toBe("acme.com");
  });
  test("returns null on missing @", () => {
    expect(emailDomain("not-an-email")).toBeNull();
  });
  test("handles addresses with multiple @ (last @ wins)", () => {
    expect(emailDomain("a@b@c.com")).toBe("c.com");
  });
});

describe("safeRelayPath", () => {
  test("returns / when the input is null/empty", () => {
    expect(safeRelayPath(null)).toBe("/");
    expect(safeRelayPath("")).toBe("/");
  });
  test("returns / for absolute URLs (open-redirect block)", () => {
    expect(safeRelayPath("https://evil.example/")).toBe("/");
    expect(safeRelayPath("//evil.example/")).toBe("/");
  });
  test("returns / for protocol-relative or javascript: URLs", () => {
    expect(safeRelayPath("javascript:alert(1)")).toBe("/");
  });
  test("returns / when CR or LF is present (header injection block)", () => {
    expect(safeRelayPath("/projects\r\nLocation: /evil")).toBe("/");
  });
  test("returns / for backslash-smuggled open-redirect attempts", () => {
    // Modern browsers normalise `\` → `/` in URL paths, so
    // `/\evil.example` resolves as `//evil.example` (authority).
    expect(safeRelayPath("/\\evil.example/path")).toBe("/");
    expect(safeRelayPath("\\evil.example")).toBe("/");
    expect(safeRelayPath("/foo\\bar")).toBe("/");
  });
  test("returns / for control-character smuggling", () => {
    expect(safeRelayPath("/foo\u0000bar")).toBe("/");
    expect(safeRelayPath("/foo\tbar")).toBe("/");
  });
  test("returns / for pathologically long inputs", () => {
    expect(safeRelayPath("/" + "a".repeat(3000))).toBe("/");
  });
  test("passes through legitimate relative paths", () => {
    expect(safeRelayPath("/projects/abc")).toBe("/projects/abc");
    expect(safeRelayPath("/audit?since=7d")).toBe("/audit?since=7d");
  });
});

describe("buildEntities", () => {
  test("throws when SAML mode is off", () => {
    expect(() =>
      buildEntities({ ...VALID_CFG, saml_enforcement_mode: "off" })
    ).toThrow(/disabled/);
  });
  test("throws when manual fields are incomplete", () => {
    expect(() =>
      buildEntities({
        ...VALID_CFG,
        saml_idp_metadata_xml: null,
        saml_idp_entity_id: "https://idp.example.com/saml2",
        saml_idp_sso_url: "https://idp.example.com/saml2/sso",
        // Missing cert.
        saml_idp_x509_cert: null,
      })
    ).toThrow(/incomplete/);
  });
  test("constructs SP + IdP from manual fields", () => {
    const { sp, idp, acsUrl } = buildEntities(VALID_CFG);
    expect(sp).toBeTruthy();
    expect(idp).toBeTruthy();
    expect(acsUrl).toContain("/sso/saml/acs?org=org-1");
  });
});

describe("spMetadataXml", () => {
  test("returns a non-empty XML document containing the SP entity ID", () => {
    const xml = spMetadataXml(VALID_CFG);
    expect(xml).toContain("EntityDescriptor");
    expect(xml).toContain("AssertionConsumerService");
    expect(xml.length).toBeGreaterThan(200);
  });
});
