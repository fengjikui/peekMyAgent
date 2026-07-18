const MAX_ARGUMENT_TEXT_CHARS = 64 * 1024;
const MAX_NESTED_TOOLS = 4;

export function analyzeToolCallSemantics(call = {}) {
  const toolName = cleanName(call?.name);
  const argumentText = collectArgumentText(call?.arguments);
  const nestedToolNames = extractNestedToolNames(argumentText).filter(
    (name) => name.toLowerCase() !== toolName.toLowerCase(),
  );
  const explicitSkill = explicitSkillInvocation(toolName, call?.arguments);
  const observedSkill = explicitSkill || extractSkillInstructionRead(argumentText);

  if (!observedSkill && !nestedToolNames.length) return null;
  return {
    schema_version: 1,
    kind: observedSkill?.kind || "nested_tool_dispatch",
    skill_name: observedSkill?.skill_name || null,
    nested_tool_names: nestedToolNames,
    evidence: {
      source: observedSkill?.source || "tool_arguments",
      confidence: observedSkill?.confidence || "high",
    },
  };
}

export function extractNestedToolNames(value) {
  const text = typeof value === "string" ? value : collectArgumentText(value);
  const names = [];
  const seen = new Set();
  const pattern = /\btools\.([A-Za-z_$][\w$]*)\s*\(/g;
  for (const match of text.matchAll(pattern)) {
    const name = match[1];
    if (seen.has(name)) continue;
    seen.add(name);
    names.push(name);
    if (names.length >= MAX_NESTED_TOOLS) break;
  }
  return names;
}

export function extractSkillInstructionRead(value) {
  const text = typeof value === "string" ? value : collectArgumentText(value);
  const normalized = text.replaceAll("\\", "/");
  const match = normalized.match(/(?:^|[\s"'`])(?:[^\s"'`]*\/)?skills\/([^/\s"'`]+)\/SKILL\.md\b/i);
  if (!match) return null;
  return {
    kind: "skill_instruction_read",
    skill_name: decodeDisplayText(match[1]),
    source: "tool_arguments",
    confidence: "high",
  };
}

function explicitSkillInvocation(toolName, argumentsValue) {
  if (!/^(?:skill|load_skill)$/i.test(toolName)) return null;
  const skillName =
    cleanName(argumentsValue?.skill) ||
    cleanName(argumentsValue?.skill_name) ||
    cleanName(argumentsValue?.name) ||
    "unknown";
  return {
    kind: "skill_load",
    skill_name: skillName,
    source: "tool_name",
    confidence: "explicit",
  };
}

function collectArgumentText(value) {
  const output = [];
  const seen = new Set();
  let outputChars = 0;
  visit(value, 0);
  return output.join("\n").slice(0, MAX_ARGUMENT_TEXT_CHARS);

  function visit(item, depth) {
    if (outputChars >= MAX_ARGUMENT_TEXT_CHARS || depth > 6 || item == null) return;
    if (typeof item === "string") {
      const remaining = MAX_ARGUMENT_TEXT_CHARS - outputChars;
      const text = item.slice(0, remaining);
      output.push(text);
      outputChars += text.length + 1;
      return;
    }
    if (typeof item !== "object" || seen.has(item)) return;
    seen.add(item);
    if (Array.isArray(item)) {
      for (const child of item) visit(child, depth + 1);
      return;
    }
    for (const child of Object.values(item)) visit(child, depth + 1);
  }
}

function cleanName(value) {
  return typeof value === "string" ? value.trim() : "";
}

function decodeDisplayText(value) {
  try {
    return decodeURIComponent(value);
  } catch {
    return value;
  }
}
