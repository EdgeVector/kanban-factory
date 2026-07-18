/**
 * Pull the human "ask" + deliverable out of a kanban card body, skipping
 * agent boilerplate (skill header, Repo/Base/Kind lines, etc.).
 *
 * Used by the factory hover tooltip so Tom sees what the card is for,
 * not the first 200 chars of instructions to the agent.
 */

const BOILER_LINE =
  /^(Surfaces:|\*\*Follow the kanban-agent|\*\*Follow the `?kanban-agent|Repo:|Base:|Branch:|Kind:|Priority:|North Star:|Tags:|Parent:|Design:|PR:|Head-Oid:|Head Oid:|##\s)/i;

function cleanBlock(s, max = 320) {
  if (!s) return "";
  const t = String(s)
    .replace(/\r\n/g, "\n")
    .replace(/[ \t]+\n/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim()
    .replace(/\s+/g, " ");
  if (t.length <= max) return t;
  return t.slice(0, max - 1) + "…";
}

function section(text, names) {
  for (const name of names) {
    const re = new RegExp(
      String.raw`^##\s*${name}\s*\n([\s\S]*?)(?=\n##\s|\n---\s*$|$)`,
      "im",
    );
    const m = text.match(re);
    if (m && m[1] && m[1].trim()) return m[1].trim();
  }
  return "";
}

/**
 * @param {string} body
 * @returns {{ ask: string, deliverable: string, summary: string, hasSubstance: boolean }}
 */
export function extractCardAsk(body) {
  const empty = { ask: "", deliverable: "", summary: "", hasSubstance: false };
  if (!body || !String(body).trim()) return empty;

  const text = String(body).replace(/\r\n/g, "\n");

  let ask = section(text, [
    "GOAL",
    "Goal",
    "WANT",
    "Want",
    "ASK",
    "Ask",
    "PROBLEM",
    "Problem",
  ]);
  let deliverable = section(text, [
    "END STATE",
    "End State",
    "DONE WHEN",
    "Done When",
    "DONE-WHEN",
    "DELIVERABLE",
    "Deliverable",
    "PROOF",
    "Proof",
  ]);

  // Header form: DONE-WHEN: file ... matches /PASS/
  if (!deliverable) {
    const m = text.match(/^DONE-WHEN:\s*(.+)$/im);
    if (m) deliverable = m[1].trim();
  }

  // First non-boilerplate paragraph as fallback summary
  let summary = "";
  if (!ask && !deliverable) {
    const chunks = [];
    for (const line of text.split("\n")) {
      const t = line.trim();
      if (!t) {
        if (chunks.length) break;
        continue;
      }
      if (BOILER_LINE.test(t)) continue;
      if (/^[-*]\s*Follow the/i.test(t)) continue;
      chunks.push(t.replace(/^[-*]\s+/, ""));
      if (chunks.join(" ").length > 200) break;
    }
    summary = chunks.join(" ");
  }

  ask = cleanBlock(ask, 360);
  deliverable = cleanBlock(deliverable, 360);
  summary = cleanBlock(summary || ask || deliverable, 360);

  return {
    ask,
    deliverable,
    summary,
    hasSubstance: Boolean(ask || deliverable || summary),
  };
}
