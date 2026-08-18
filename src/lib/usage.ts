// Turning banked token/cost figures into something a header chip can show.
// Pure, so the numbers can be tested without the components.
import type { Bot, TaskUsage } from "@/state/store";

export const EMPTY_USAGE: TaskUsage = { input: 0, output: 0, costUsd: null, turns: 0 };

/** Sum a set of usages; cost stays null until any of them has one. */
export function sumUsage(items: Array<TaskUsage | undefined>): TaskUsage {
  const out: TaskUsage = { ...EMPTY_USAGE };
  for (const u of items) {
    if (!u) continue;
    out.input += u.input;
    out.output += u.output;
    out.turns += u.turns;
    if (reportedCost(u.costUsd)) out.costUsd = (out.costUsd ?? 0) + u.costUsd;
  }
  return out;
}

export function botUsage(bot: Pick<Bot, "tasks">): TaskUsage {
  return sumUsage((bot.tasks ?? []).map((t) => t.usage));
}

/** 950 → "950", 12_400 → "12.4k", 2_300_000 → "2.3M" */
export function formatTokens(n: number | null | undefined): string {
  if (n == null || !Number.isFinite(n)) return "0";
  if (n < 1000) return String(n);
  if (n < 1_000_000) return `${trim(n / 1000)}k`;
  return `${trim(n / 1_000_000)}M`;
}
const trim = (x: number) => (x >= 100 ? Math.round(x).toString() : x.toFixed(1).replace(/\.0$/, ""));

/** True when a turn (or a sum of turns) actually reported a dollar figure.
 * Missing and null are the same for records from before cost existed. */
export function reportedCost(usd: number | null | undefined): usd is number {
  return Number.isFinite(usd);
}

/** Dollars, with enough precision that a cheap turn isn't "$0.00". */
export function formatUsd(usd: number | null | undefined): string {
  if (!reportedCost(usd)) return "";
  if (usd === 0) return "$0";
  if (usd < 0.01) return `$${usd.toFixed(3)}`;
  return `$${usd.toFixed(2)}`;
}

/** The chip text: tokens, and cost when known. Empty string when nothing
 * has been spent — a fresh task shows no chip. */
export function usageChip(u: TaskUsage): string {
  if (u.turns === 0 && u.input + u.output === 0) return "";
  const parts = [`${formatTokens(u.input + u.output)} tok`];
  if (reportedCost(u.costUsd)) parts.push(formatUsd(u.costUsd));
  return parts.join(" · ");
}

/** How to caption a cost figure given how the engine is billed. */
export function costCaption(billing: "metered" | "subscription" | undefined): string {
  if (billing === "subscription") return "equivalent — on your subscription, not billed";
  if (billing === "metered") return "billed to your API key";
  return "as reported by the engine";
}
