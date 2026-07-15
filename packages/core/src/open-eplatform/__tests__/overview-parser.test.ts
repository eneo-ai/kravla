// SPDX-License-Identifier: AGPL-3.0-only
/**
 * Unit tests for the Open ePlatform overview-page parser, driven from
 * captured fixtures for three real services across two municipalities:
 *   - sundsvall-overview-145: login-required, full simplebox panels,
 *     populated requirements checklist.
 *   - sundsvall-overview-104: no login required, full simplebox panels,
 *     no sidebar requirements.
 *   - hudiksvall-overview-426: login-required, inline `.about-flow`
 *     contact, no GDPR `#simplebox-owner` panel at all.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, it, expect } from "vitest";
import { parseOverview } from "../overview-parser";

const fix = (name: string) => readFileSync(join(__dirname, "fixtures", name), "utf8");

const HTML_145 = fix("sundsvall-overview-145.html");
const HTML_104 = fix("sundsvall-overview-104.html");
const HTML_HUDI = fix("hudiksvall-overview-426.html");

describe("parseOverview — sundsvall /145 (alkohol, login required, full panels)", () => {
  const overview = parseOverview(HTML_145);

  it("extracts the flow-start link and its numeric id", () => {
    expect(overview.flowStartUrl).toBe("/oversikt/flow/1478");
    expect(overview.flowStartId).toBe(1478);
  });

  it("returns the meta description verbatim", () => {
    expect(overview.metaDescription).toMatch(/Här kan du ansöka om nytt serveringstillstånd/i);
  });

  it("emits the long-form description text and excludes contact sub-panels", () => {
    expect(overview.descriptionText).toBeTruthy();
    expect(overview.descriptionText).toMatch(/Ansök eller anmäl via e-tjänst/);
    // mailto/tel links from the contact box must not appear in the body
    expect(overview.descriptionText).not.toMatch(/alkohol&tobaksenheten@sundsvall\.se/);
  });

  it("emits the sidebar requirements checklist in order", () => {
    expect(overview.requirements).toEqual(["Du måste ha fyllt 20 år", "E-legitimation"]);
  });

  it("emits the steps in the data-step order", () => {
    expect(overview.steps).toEqual([
      "Kontaktuppgifter",
      "Ansökan/anmälan",
      "Förhandsgranska",
      "Signera och skicka in",
    ]);
  });

  it("collects related links from the description body and skips mailto/tel", () => {
    expect(overview.relatedLinks.length).toBeGreaterThan(0);
    for (const link of overview.relatedLinks) {
      expect(link.href).not.toMatch(/^(mailto:|tel:|javascript:|#)/);
      expect(link.text.length).toBeGreaterThan(0);
    }
    const hrefs = overview.relatedLinks.map((l) => l.href);
    expect(hrefs.some((h) => h.includes("sundsvall.se"))).toBe(true);
  });

  it("pulls department / email / phone out of #simplebox-contact", () => {
    expect(overview.contact).not.toBeNull();
    expect(overview.contact?.department).toMatch(/Alkohol- och tobaksenheten/);
    expect(overview.contact?.email).toBe("alkohol&tobaksenheten@sundsvall.se");
    expect(overview.contact?.phone).toBe("060-191000");
  });

  it("captures the GDPR panel as a sequence of h3 sections + mailto", () => {
    expect(overview.dataController).not.toBeNull();
    const headings = overview.dataController?.sections.map((s) => s.heading) ?? [];
    // Section labels come from the fixture verbatim — no string assertion on
    // exact ordering of internal label semantics, just structural presence.
    expect(headings.length).toBeGreaterThanOrEqual(4);
    expect(overview.dataController?.email).toBe("ian@sundsvall.se");
    // Items inside the first section should be non-empty.
    const first = overview.dataController?.sections[0];
    expect(first?.items.length).toBeGreaterThan(0);
  });
});

describe("parseOverview — sundsvall /104 (matförgift, no login, no sidebar checklist)", () => {
  const overview = parseOverview(HTML_104);

  it("extracts the flow-start link", () => {
    expect(overview.flowStartUrl).toBe("/oversikt/flow/910");
    expect(overview.flowStartId).toBe(910);
  });

  it("returns an empty requirements array when the checklist is absent", () => {
    expect(overview.requirements).toEqual([]);
  });

  it("still extracts steps and contact", () => {
    expect(overview.steps.length).toBeGreaterThan(0);
    expect(overview.contact?.email).toBe("miljonamnden@sundsvall.se");
    expect(overview.contact?.phone).toBe("060-19 11 90");
  });
});

describe("parseOverview — hudiksvall /426 (inline contact, no GDPR panel)", () => {
  const overview = parseOverview(HTML_HUDI);

  it("extracts the flow-start link", () => {
    expect(overview.flowStartUrl).toBe("/oversikt/flow/1899");
    expect(overview.flowStartId).toBe(1899);
  });

  it("emits steps even on a simpler template", () => {
    expect(overview.steps).toEqual([
      "Elev som överenskommelsen gäller.",
      "Klass",
      "Överenskommelse",
      "Signera och skicka in",
    ]);
  });

  it("pulls the contact info out of the inline .about-flow block", () => {
    expect(overview.contact).not.toBeNull();
    expect(overview.contact?.email).toBe("fredrik.palsson@hudiksvall.se");
    // Inline pattern has no <a href="tel:"> at all on this service.
    expect(overview.contact?.phone).toBeNull();
    // Department text on Hudiksvall is rendered as a bare text node before
    // the email link — should round-trip as "Fredrik Pålsson".
    expect(overview.contact?.department).toMatch(/Fredrik Pålsson/);
  });

  it("reports null for the data-controller block when #simplebox-owner is absent", () => {
    expect(overview.dataController).toBeNull();
  });
});

describe("parseOverview — non-overview HTML", () => {
  it("returns the empty shape when .flow-overview is missing", () => {
    const overview = parseOverview("<html><body><p>Hello</p></body></html>");
    expect(overview).toEqual({
      flowStartUrl: null,
      flowStartId: null,
      metaDescription: null,
      descriptionText: null,
      requirements: [],
      steps: [],
      relatedLinks: [],
      contact: null,
      dataController: null,
    });
  });
});
