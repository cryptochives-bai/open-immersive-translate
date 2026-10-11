import { afterEach, describe, expect, it, vi } from "vitest";

const { controlLooksUntampered } = await vi.importActual<{
  controlLooksUntampered: (
    control: Element,
    host: Element,
    size: { min: number; max: number },
  ) => boolean;
}>("../../src/content/features/clickjack-guard");

function mount(size = 36): { host: HTMLElement; control: HTMLElement } {
  const host = document.createElement("div");
  const control = document.createElement("button");
  host.append(control);
  document.body.append(host);
  vi.spyOn(control, "getBoundingClientRect").mockReturnValue({
    x: 100,
    y: 100,
    left: 100,
    top: 100,
    right: 100 + size,
    bottom: 100 + size,
    width: size,
    height: size,
    toJSON: () => ({}),
  });
  return { host, control };
}

afterEach(() => {
  document.body.replaceChildren();
  document.documentElement.removeAttribute("style");
  vi.restoreAllMocks();
});

describe("clickjacking guard", () => {
  const size = { min: 24, max: 56 };

  it("accepts a control drawn at its normal size", () => {
    const { host, control } = mount();
    expect(controlLooksUntampered(control, host, size)).toBe(true);
  });

  it("rejects an enlarged control", () => {
    const { host, control } = mount(14_400);
    expect(controlLooksUntampered(control, host, size)).toBe(false);
  });

  it.each([
    ["opacity", "0"],
    ["opacity", "0.01"],
    ["visibility", "hidden"],
    ["filter", "opacity(0)"],
    ["clip-path", "inset(50%)"],
  ])("rejects a host with %s: %s", (property, value) => {
    const { host, control } = mount();
    host.style.setProperty(property, value);
    expect(controlLooksUntampered(control, host, size)).toBe(false);
  });

  it("rejects a transparent root element", () => {
    const { host, control } = mount();
    document.documentElement.style.opacity = "0";
    expect(controlLooksUntampered(control, host, size)).toBe(false);
  });

  it("rejects a control outside the viewport", () => {
    const { host, control } = mount();
    vi.spyOn(control, "getBoundingClientRect").mockReturnValue({
      x: -500,
      y: -500,
      left: -500,
      top: -500,
      right: -464,
      bottom: -464,
      width: 36,
      height: 36,
      toJSON: () => ({}),
    });
    expect(controlLooksUntampered(control, host, size)).toBe(false);
  });
});
