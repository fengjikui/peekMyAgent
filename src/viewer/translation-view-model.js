export function buildTranslationSectionView({
  section,
  materials,
  query = "",
  toolNames = null,
  displaySource = false,
  translatedTextFor = () => "",
  labelForKind = (kind) => kind || "description",
}) {
  const sourceMaterials = Array.isArray(materials) ? materials : [];
  const normalizedQuery = String(query || "").trim();
  if (section === "tools") {
    const allGroups = groupToolTranslationMaterials(sourceMaterials);
    const scopedGroups = filterToolTranslationGroupsByName(allGroups, toolNames);
    const groups = filterToolTranslationGroups(scopedGroups, {
      query: normalizedQuery,
      translatedTextFor,
    });
    return {
      section,
      type: "tools",
      query: normalizedQuery,
      totalMaterials: sourceMaterials.length,
      searchMatchCount: groups.length,
      totalGroups: allGroups.length,
      scopedGroups: scopedGroups.length,
      groups: groups.map((group) =>
        toolTranslationGroupView(group, { translatedTextFor, labelForKind, displaySource }),
      ),
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
  return [
    extraText,
    metadata.tool_name,
    metadata.tool_leaf_name,
    metadata.tool_namespace,
    metadata.namespace_name,
    metadata.field_name,
    metadata.label,
    displayedText,
  ]
    .filter(Boolean)
    .join("\n")
    .toLowerCase()
    .includes(normalizedQuery);
}

export function groupToolTranslationMaterials(materials) {
  const groups = new Map();
  const namespaceDescriptions = new Map();
  for (const item of Array.isArray(materials) ? materials : []) {
    if (item?.kind === "tool_namespace_description") {
      const namespaceName = item?.metadata?.namespace_name || "unknown";
      if (!namespaceDescriptions.has(namespaceName)) namespaceDescriptions.set(namespaceName, item);
      continue;
    }
    const toolName = item?.metadata?.tool_name || "unknown";
    if (!groups.has(toolName)) {
      groups.set(toolName, {
        toolName,
        toolDisplayName: item?.metadata?.tool_leaf_name || toolName,
        namespace: item?.metadata?.tool_namespace || "",
        namespaceToolCount: Number(item?.metadata?.tool_namespace_tool_count || 0),
        description: null,
        parameters: [],
      });
    }
    const group = groups.get(toolName);
    if (item?.kind === "tool_description" && !group.description) group.description = item;
    else group.parameters.push(item);
  }
  return [...groups.values()].map((group) => ({
    ...group,
    namespaceDescription: namespaceDescriptions.get(group.namespace) || null,
  }));
}

export function filterToolTranslationGroups(groups, { query = "", translatedTextFor = () => "" } = {}) {
  const sourceGroups = Array.isArray(groups) ? groups : [];
  const normalizedQuery = String(query || "").trim().toLowerCase();
  if (!normalizedQuery) return sourceGroups;
  return sourceGroups
    .map((group, index) => {
      const names = [group.toolName, group.toolDisplayName, group.namespace]
        .filter(Boolean)
        .map((name) => String(name).toLowerCase());
      const nameMatch = names.some((name) => name.includes(normalizedQuery));
      const contentMatch = [group.namespaceDescription, group.description, ...(group.parameters || [])]
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
        rank: names.includes(normalizedQuery) ? 0 : nameMatch ? 1 : 2,
        matches: nameMatch || contentMatch,
      };
    })
    .filter((entry) => entry.matches)
    .sort((left, right) => left.rank - right.rank || left.index - right.index)
    .map((entry) => entry.group);
}

export function filterToolTranslationGroupsByName(groups, toolNames = null) {
  const sourceGroups = Array.isArray(groups) ? groups : [];
  if (!toolNames) return sourceGroups;
  const names = new Set(
    [...toolNames]
      .map((name) => String(name || "").trim())
      .filter(Boolean),
  );
  if (!names.size) return sourceGroups;
  return sourceGroups.filter((group) => {
    const qualifiedName = String(group?.toolName || "");
    const leafName = String(group?.toolDisplayName || "");
    return names.has(qualifiedName) || names.has(leafName);
  });
}

export function responseInvokedToolNames(response) {
  return [
    ...new Set(
      (Array.isArray(response?.tool_calls) ? response.tool_calls : [])
        .map((call) => call?.name || call?.tool_name || call?.function?.name || "")
        .map((name) => String(name).trim())
        .filter(Boolean),
    ),
  ];
}

export function translationKindClass(kind) {
  if (kind === "tool_namespace_description") return "tool-namespace-description";
  if (kind === "tool_description") return "tool-description";
  if (kind === "tool_parameter_description") return "tool-parameter";
  if (kind === "system_prompt") return "system-prompt";
  if (kind === "system_injected_context") return "system-injected";
  if (kind === "assistant_thinking") return "assistant-thinking-kind";
  if (kind === "assistant_reasoning") return "assistant-reasoning-kind";
  if (kind === "assistant_response") return "assistant-response-kind";
  if (kind === "developer_instruction") return "developer-instruction-kind";
  if (kind?.startsWith("harness_")) return "harness-kind";
  return "other-kind";
}

function toolTranslationGroupView(group, { translatedTextFor, labelForKind, displaySource }) {
  const parameters = (group.parameters || []).map((material) => {
    const label = material?.metadata?.field_name || material?.metadata?.path || "parameter";
    const block = translationBlockView({ material, label, translatedTextFor, labelForKind });
    return { ...block, displayText: displaySource ? block.sourceText : block.displayText };
  });
  const description = group.description
    ? translationBlockView({
        material: group.description,
        label: "",
        translatedTextFor,
        labelForKind,
      })
    : null;
  const namespaceDescription = group.namespaceDescription
    ? translationBlockView({
        material: group.namespaceDescription,
        label: "",
        translatedTextFor,
        labelForKind,
      })
    : null;
  const materials = [group.description, ...(group.parameters || [])]
    .filter(Boolean)
    .map((item) => ({
      kind: item.kind,
      source_text: item.source_text,
      metadata: item.metadata || {},
    }));
  const hit = [description, ...parameters].filter((item) => item?.hit).length;
  return {
    toolName: group.toolName,
    toolDisplayName: group.toolDisplayName,
    namespace: group.namespace,
    namespaceToolCount: group.namespaceToolCount,
    namespaceDescription: namespaceDescription
      ? {
          ...namespaceDescription,
          displayText: displaySource ? namespaceDescription.sourceText : namespaceDescription.displayText,
        }
      : null,
    description: description
      ? { ...description, displayText: displaySource ? description.sourceText : description.displayText }
      : null,
    parameters: {
      items: parameters,
      hit: parameters.filter((item) => item.hit).length,
      total: parameters.length,
    },
    materials,
    hit,
    total: materials.length,
    displaySource: Boolean(displaySource),
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
