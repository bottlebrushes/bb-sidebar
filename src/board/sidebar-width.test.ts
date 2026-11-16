import { describe, expect, it } from "vitest";
import { clampWidth, seedState, toggledWidth, withWidth } from "./sidebar-width";

describe("sidebar width", () => {
  it("never squeezes the chat below its minimum or the sidebar below bb's", () => {
    expect(clampWidth(2000, 1600)).toBe(1320);
    expect(clampWidth(100, 1600)).toBe(240);
    expect(clampWidth(900, 400)).toBe(240);
  });

  it("starts from bb's own width the first time, ignoring missing or bad values", () => {
    expect(seedState(null, "380").width).toBe(380);
    expect(seedState(null, null).width).toBe(320);
    expect(seedState(null, "").width).toBe(320);
    expect(seedState("not json", "abc").width).toBe(320);
    // A width bb never allowed cannot be bb's list width.
    expect(seedState(null, "900").width).toBe(320);
  });

  it("restores the saved board width and the list width to return to", () => {
    const saved = JSON.stringify({ width: 1100, listWidth: 300, boardWidth: 1100 });
    expect(seedState(saved, "380")).toMatchObject({ width: 1100, listWidth: 300, boardWidth: 1100 });
  });

  it("remembers the list width while the board is open, and toggles between the two", () => {
    let state = seedState(null, "300");
    state = withWidth(state, 1000);
    expect(state).toMatchObject({ width: 1000, listWidth: 300, boardWidth: 1000 });
    expect(toggledWidth(state, 1600)).toBe(300);
    state = withWidth(state, 300);
    expect(toggledWidth(state, 1600)).toBe(1000);
    expect(toggledWidth(seedState(null, "300"), 1600)).toBe(900);
  });
});
