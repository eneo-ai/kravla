// SPDX-License-Identifier: AGPL-3.0-only
/**
 * Unit tests for the Open ePlatform HTML parser. Driven from a captured
 * fixture so the assertions read like a contract against real portal HTML
 * rather than a synthetic snippet.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, it, expect } from "vitest";
import { parseEservices, probePortal } from "../parser";

const FIXTURE = readFileSync(join(__dirname, "fixtures", "sundsvall-portal.html"), "utf8");
const REAL_FIXTURE = readFileSync(join(__dirname, "fixtures", "sundsvall-real.html"), "utf8");

describe("probePortal", () => {
  it("identifies an Open ePlatform portal via meta tags", () => {
    const probe = probePortal(FIXTURE);
    expect(probe.isOpenEplatform).toBe(true);
    expect(probe.detectedHints.join(" ")).toMatch(/open eplatform/i);
  });

  it("falls back to the flowtype_ structural marker when meta tags are stripped", () => {
    const stripped = FIXTURE.replace(/<meta[^>]+>/g, "");
    const probe = probePortal(stripped);
    expect(probe.isOpenEplatform).toBe(true);
  });

  it("rejects unrelated HTML", () => {
    const probe = probePortal("<html><body><p>Hello</p></body></html>");
    expect(probe.isOpenEplatform).toBe(false);
  });
});

describe("parseEservices", () => {
  const services = parseEservices(FIXTURE);

  it("extracts one record per <li data-flowid>", () => {
    expect(services).toHaveLength(3);
  });

  it("captures name, description, category, and the flow id", () => {
    const bygglov = services.find((s) => s.flowId === "101")!;
    expect(bygglov.name).toBe("Ansök om bygglov");
    expect(bygglov.description).toMatch(/bygglov för nybyggnad/);
    expect(bygglov.category).toBe("Bygga, bo & miljö");
    expect(bygglov.categoryFlowTypeId).toBe("1");
  });

  it("strips the trailing service count from the category heading", () => {
    const forskola = services.find((s) => s.flowId === "201")!;
    expect(forskola.category).toBe("Förskola & skola");
  });

  it("detects requires_login from icon-person", () => {
    const bygglov = services.find((s) => s.flowId === "101")!;
    expect(bygglov.requiresLogin).toBe(true);

    const eldstad = services.find((s) => s.flowId === "102")!;
    expect(eldstad.requiresLogin).toBe(false);
  });

  it("detects is_external from icon-launch", () => {
    const forskola = services.find((s) => s.flowId === "201")!;
    expect(forskola.isExternal).toBe(true);

    const bygglov = services.find((s) => s.flowId === "101")!;
    expect(bygglov.isExternal).toBe(false);
  });

  it("extracts the overview id from /overview/<id> URLs", () => {
    const bygglov = services.find((s) => s.flowId === "101")!;
    expect(bygglov.overviewId).toBe("101");

    // External services point at an absolute URL with no /overview/ segment
    // — `overviewId` should be null rather than a bogus guess.
    const forskola = services.find((s) => s.flowId === "201")!;
    expect(forskola.overviewId).toBeNull();
  });
});

describe("parseEservices against real Sundsvall portal structure", () => {
  // Real Open ePlatform deployments wrap the category h2 in
  // `<div class="heading-wrapper">`, use `&nbsp;` before the count, and
  // tag login with `i.material-icons.icon-person`. This fixture exercises
  // all three so a future refactor can't silently regress them.
  const services = parseEservices(REAL_FIXTURE);

  it("skips the popular-services section (no id^=flowtype_)", () => {
    // Popular section has `aria-labelledby`, not an `id` starting with
    // `flowtype_`, so its <li>s shouldn't show up.
    expect(services.some((s) => s.flowId === "999")).toBe(false);
  });

  it("extracts categories despite the heading-wrapper div", () => {
    const eldstad = services.find((s) => s.flowId === "2666")!;
    expect(eldstad.category).toBe("Bygga, bo och miljö");

    const forskola = services.find((s) => s.flowId === "201")!;
    expect(forskola.category).toBe("Utbildning och förskola");
  });

  it("detects requires_login on the modern material-icons class", () => {
    const eldstad = services.find((s) => s.flowId === "2666")!;
    expect(eldstad.requiresLogin).toBe(true);

    const matforgiftning = services.find((s) => s.flowId === "910")!;
    expect(matforgiftning.requiresLogin).toBe(false);
  });

  it("detects is_external on the modern material-icons class", () => {
    const forskola = services.find((s) => s.flowId === "201")!;
    expect(forskola.isExternal).toBe(true);
  });
});
