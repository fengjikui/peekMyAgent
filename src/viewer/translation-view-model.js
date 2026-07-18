export function buildTranslationSectionView({
  section,
  materials,
  query = "",
  translatedTextFor = () => "",
  labelForKind = (kind) => kind || "description",
}) {
  const sourceMaterials = Array.isArray(materials) ? materials : [];
  const normalizedQuery = String(query || "").trim();
  if (section === "tools") {
    const groups = filterToolTranslationGroups(groupToolTranslationMaterials(sourceMaterials), {
      query: normalizedQuery,
      translatedTextFor,
    });
    return {
      section,
      type: "tools",
      query: normalizedQuery,
      totalMaterials: sourceMaterials.length,
      searchMatchCount: groups.length,
      groups: groups.map((group) => toolTranslationGroupView(group, { translatedTextFor, labelForKind })),
    };
  }

  const visibleMaterials = filterTranslationMaterials(sourceMaterials, {
    query: normalizedQuery,
    translatedTextFor,
  });
  return {
    section,
    type: "list",
    query: normalizedQuery,
    totalMaterials: sourceMaterials.length,
    searchMatchCount: visibleMaterials.length,
    items: visibleMaterials.map((material, index) =>
      translationBlockView({
        material,
        label: translationMaterialLabel(material, index, section, labelForKind),
        translatedTextFor,
        labelForKind,
      }),
    ),
  };
}

export function translationSectionStats(materials, { translatedTextFor = () => "" } = {}) {
  const sourceMaterials = Array.isArray(materials) ? materials : [];
  const hit = sourceMaterials.filter((item) => translatedTextFor(item.kind, item.source_text)).length;
  return {
    total: sourceMaterials.length,
    hit,
    missing: Math.max(0, sourceMaterials.length - hit),
  };
}

export function translationBlockView({ material, label, translatedTextFor = () => "", labelForKind = (kind) => kind || "description" }) {
  const sourceText = material?.source_text || "";
  const translatedText = translatedTextFor(material?.kind, sourceText) || "";
  return {
    label: String(label || ""),
    kind: material?.kind || "",
    kindClass: translationKindClass(material?.kind),
    kindLabel: labelForKind(material?.kind),
    sourceText,
    translatedText,
    displayText: translatedText || sourceText,
    hit: Boolean(translatedText),
    metadata: material?.metadata || {},
  };
}

export function filterTranslationMaterials(materials, { query = "", translatedTextFor = () => "" } = {}) {
  return (Array.isArray(materials) ? materials : []).filter((item) =>
    translationMaterialMatchesQuery(item, { query, translatedTextFor }),
  );
}

export function translationMaterialMatchesQuery(item, { query = "", translatedTextFor = () => "", extraText = "" } = {}) {
  const normalizedQuery = String(query || "").trim().toLowerCase();
  if (!normalizedQuery) return true;
  const translated = translatedTextFor(item?.kind, item?.source_text) || "";
  const metadata = item?.metadata || {};
  const displayedText = translated || item?.source_text || "";
  return [extraText, metadata.tool_name, metadata.field_name, metadata.label, displayedText]
    .filter(Boolean)
    .join("\n")
    .toLowerCase()
    .includes(normalizedQuery);
}

export function groupToolTranslationMaterials(materials) {
  const groups = new Map();
  for (const item of Array.isArray(materials) ? materials : []) {
    const toolName = item?.metadata?.tool_name || "unknown";
    if (!groups.has(toolName)) groups.set(toolName, { toolName, description: null, parameters: [] });
    const group = groups.get(toolName);
    if (item?.kind === "tool_description" && !group.description) group.description = item;
    else group.parameters.push(item);
  }
  return [...groups.values()];
}

export function filterToolTranslationGroups(groups, { query = "", translatedTextFor = () => "" } = {}) {
  const sourceGroups = Array.isArray(groups) ? groups : [];
  const normalizedQuery = String(query || "").trim().toLowerCase();
  if (!normalizedQuery) return sourceGroups;
  return sourceGroups
    .map((group, index) => {
      const lowerName = String(group.toolName || "").toLowerCase();
      const nameMatch = lowerName.includes(normalizedQuery);
      const contentMatch = [group.description, ...(group.parameters || [])]
        .filter(Boolean)
        .some((item) =>
          translationMaterialMatchesQuery(item, {
            query: normalizedQuery,
            translatedTextFor,
            extraText: group.toolName,
          }),
        );
      return {
        group,
        index,
        rank: lowerName === normalizedQuery ? 0 : nameMatch ? 1 : 2,
        matches: nameMatch || contentMatch,
      };
    })
    .filter((entry) => entry.matches)
    .sort((left, right) => left.rank - right.rank || left.index - right.index)
    .map((entry) => entry.group);
}

export function translationKindClass(kind) {
  if (kind === "tool_description") return "tool-description";
  if (kind === "tool_parameter_description") return "tool-parameter";
  if (kind === "system_prompt") return "system-prompt";
  if (kind === "system_injected_context") return "system-injected";
  if (kind === "assistant_thinking") return "assistant-thinking-kind";
  if (kind?.startsWith("harness_")) return "harness-kind";
  return "other-kind";
}

function toolTranslationGroupView(group, { translatedTextFor, labelForKind }) {
  const parameters = (group.parameters || []).map((material) => {
    const label = material?.metadata?.field_name || material?.metadata?.path || "parameter";
    return translationBlockView({ material, label, translatedTextFor, labelForKind });
  });
  return {
    toolName: group.toolName,
    description: group.description
      ? {
          ...translationBlockView({
            material: group.description,
            label: "",
            translatedTextFor,
            labelForKind,
          }),
          actionLabel: group.toolName,
        }
      : null,
    parameters: {
      items: parameters,
      materials: (group.parameters || []).map((item) => ({
        kind: item.kind,
        source_text: item.source_text,
        metadata: item.metadata || {},
      })),
      hit: parameters.filter((item) => item.hit).length,
      total: parameters.length,
    },
  };
}

function translationMaterialLabel(material, index, section, labelForKind) {
  if (section === "system") {
    const source = material?.metadata?.source || "system";
    const position = Number.isInteger(material?.metadata?.index) ? material.metadata.index + 1 : index + 1;
    return `${source} #${position}`;
  }
  return material?.metadata?.label || labelForKind(material?.kind);
}
