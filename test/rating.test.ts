import { describe, expect, it } from "vitest";
import { computeRatingChanges, expectedA, type RatingInput } from "../src/rating";

const P = (playerId: number, team: "A" | "B", extra: Partial<RatingInput> = {}): RatingInput => ({
  playerId, team, skill: 5, gamesBefore: 10, goals: 0, assists: 0, ownGoals: 0, ...extra,
});

describe("формула рейтинга", () => {
  // Пример из обсуждения: равные составы, синие (A) выиграли 7:4.
  // Иван (1) — 3 гола и пас, Олег (2) — пусто; Пётр (6) — 2 гола, Сергей (7) — пусто.
  const players = [
    P(1, "A", { goals: 3, assists: 1 }), P(2, "A"), P(3, "A", { goals: 2, assists: 2 }), P(4, "A", { goals: 2, assists: 1 }), P(5, "A", { assists: 1 }),
    P(6, "B", { goals: 2 }), P(7, "B"), P(8, "B", { goals: 1, assists: 1 }), P(9, "B", { goals: 1, assists: 1 }), P(10, "B"),
  ];
  const r = computeRatingChanges(players, { A: 7, B: 4 });
  const by = (id: number) => r.find((x) => x.playerId === id)!;

  it("командная часть ±0,24 при равных составах и победе 7:4", () => {
    for (const x of r) expect(x.teamPart).toBe(x.team === "A" ? 0.24 : -0.24);
    expect(by(1).result).toBe("W");
    expect(by(6).result).toBe("L");
  });

  it("личная часть: гол 0,05, пас 0,04, общий котёл — сумма около нуля", () => {
    expect(by(1).personalPart - by(2).personalPart).toBeCloseTo(0.19, 2); // 3×0,05 + 0,04
    expect(by(6).personalPart - by(7).personalPart).toBeCloseTo(0.1, 2); // 2×0,05
    expect(Math.abs(r.reduce((s, x) => s + x.personalPart, 0))).toBeLessThan(0.05);
  });

  it("честная формула: забивший в проигравшей команде теряет меньше, но теряет", () => {
    expect(by(6).delta).toBeLessThan(0);
    expect(by(6).delta).toBeGreaterThan(by(7).delta);
    expect(by(1).delta).toBeGreaterThan(by(2).delta);
    expect(by(1).after).toBeCloseTo(5 + by(1).delta, 5);
  });

  it("новичкам первые 5 игр двойной шаг", () => {
    const x = computeRatingChanges([P(1, "A", { gamesBefore: 0 }), P(2, "B")], { A: 7, B: 4 });
    expect(x[0].teamPart).toBe(0.48);
    expect(x[1].teamPart).toBe(-0.24);
  });

  it("ничья: при равных — 0, фаворит теряет, андердог растёт", () => {
    expect(computeRatingChanges([P(1, "A"), P(2, "B")], { A: 3, B: 3 })[0].teamPart).toBe(0);
    const fav = computeRatingChanges([P(1, "A", { skill: 7 }), P(2, "B", { skill: 5 })], { A: 3, B: 3 });
    expect(fav[0].teamPart).toBeLessThan(0);
    expect(fav[1].teamPart).toBeGreaterThan(0);
  });

  it("неожиданная победа ценится больше, разница мячей — с потолком", () => {
    expect(expectedA(5, 5)).toBe(0.5);
    const upset = computeRatingChanges([P(1, "A", { skill: 4 }), P(2, "B", { skill: 6 })], { A: 5, B: 4 })[0].teamPart;
    const expected = computeRatingChanges([P(1, "A", { skill: 6 }), P(2, "B", { skill: 4 })], { A: 5, B: 4 })[0].teamPart;
    expect(upset).toBeGreaterThan(expected);
    const big = computeRatingChanges([P(1, "A"), P(2, "B")], { A: 10, B: 5 })[0].teamPart;
    const huge = computeRatingChanges([P(1, "A"), P(2, "B")], { A: 20, B: 2 })[0].teamPart;
    expect(huge).toBe(big);
  });

  it("личный бонус не больше 0,25, рейтинг в границах 1..10", () => {
    const x = computeRatingChanges([P(1, "A", { goals: 10, skill: 9.9 }), P(2, "B", { skill: 1 })], { A: 10, B: 0 });
    expect(x[0].after).toBe(10);
    expect(x[1].after).toBe(1);
    const cap = computeRatingChanges([P(1, "A", { goals: 10 }), P(2, "A")], { A: 10, B: 0 });
    expect(cap[0].personalPart - cap[1].personalPart).toBeCloseTo(0.25, 2);
  });
});
