import { groupToolTranslationMaterials } from "./translation-view-model.js";

export function translationActionMaterials(item) {
  if (Array.isArray(item?.materials) && item.materials.length) return item.materials;
  if (!item?.kind) return [];
  return [
    {
      kind: item.kind,
      source_text: item.sourceText || item.source_text || "",
      metadata: item.metadata || {},
    },
  ];
}

export function translationBlockClipboardText(
  item,
  { translatedTextFor = () => "", labelForKind = (kind) => kind || "description", translate = identityTranslate } = {},
) {
  const kind = item?.kind || "";
  const sourceText = item?.sourceText || item?.source_text || "";
  const label = item?.metadata?.label || labelForKind(kind);
  const translation = translatedTextFor(kind, sourceText);
  const parts = [`## ${label}  [${kind}]`, "", `${translate("sourceLabel")}:`, sourceText];
  if (translation) parts.push("", `${translate("translationLabel")}:`, translation);
  return parts.join("\n");
}

export function translationSectionClipboardText(
  { section, request, materials, sectionLabel },
  { translatedTextFor = () => "", labelForKind = (kind) => kind || "description", translate = identityTranslate } = {},
) {
  const sourceMaterials = Array.isArray(materials) ? materials : [];
  if (!request || !sourceMaterials.length) return "";
  const header = `# ${sectionLabel} · ${translate("requestClipboardTitle", { index: request.request_index })}`;
  const body =
    section === "tools"
      ? toolsTranslationClipboardText(sourceMaterials, { translatedTextFor, translate })
      : sourceMaterials
          .map((material) =>
            translationBlockClipboardText(material, {
              translatedTextFor,
              labelForKind,
              translate,
            }),
          )
          .join("\n\n---\n\n");
  return `${header}\n\n${body}\n`;
}

export function toolsTranslationClipboardText(
  materials,
  { translatedTextFor = () => "", translate = identityTranslate } = {},
) {
  return groupToolTranslationMaterials(materials)
    .map((group) => {
      const parts = [`## ${translate("toolClipboardHeading")}: ${group.toolName}`];
      if (group.description) {
        parts.push(
          "",
          translationMaterialClipboardSection(group.description, translate("toolDescription"), {
            translatedTextFor,
            translate,
          }),
        );
      }
      for (const parameter of group.parameters) {
        const parameterName = parameter.metadata?.field_name || parameter.metadata?.path || "parameter";
        parts.push(
          "",
          translationMaterialClipboardSection(
            parameter,
            translate("parameterClipboardHeading", { name: parameterName }),
            { translatedTextFor, translate },
          ),
        );
      }
      return parts.join("\n");
    })
    .join("\n\n---\n\n");
}

export function translationGenerationMessage(
  { cacheAvailable, translated, remaining, stats, languageLabel },
  { translate = identityTranslate } = {},
) {
  if (!cacheAvailable) return translate("translationCacheNotFoundAfterGenerate", { language: languageLabel });
  if (stats.total && stats.hit < stats.total) {
    return translated
      ? translate("translationSectionPartialWithTranslated", {
          translated,
          hit: stats.hit,
          total: stats.total,
          remaining,
        })
      : translate("translationSectionPartial", {
          language: languageLabel,
          hit: stats.hit,
          total: stats.total,
        });
  }
  if (translated) {
    return translate("translationSectionCompletedWithTranslated", {
      translated,
      language: languageLabel,
      hit: stats.hit,
      total: stats.total,
    });
  }
  return stats.total
    ? translate("translationSectionLatest", {
        language: languageLabel,
        hit: stats.hit,
        total: stats.total,
      })
    : translate("translationCacheLatest", { language: languageLabel });
}

function translationMaterialClipboardSection(
  material,
  label,
  { translatedTextFor = () => "", translate = identityTranslate } = {},
) {
  const sourceText = material?.source_text || "";
  const translation = translatedTextFor(material?.kind, sourceText);
  const parts = [`### ${label}`, "", `${translate("sourceLabel")}:`, sourceText];
  if (translation) parts.push("", `${translate("translationLabel")}:`, translation);
  return parts.join("\n");
}

function identityTranslate(key, vars = {}) {
  return Object.keys(vars).reduce(
    (text, name) => text.replaceAll(`{${name}}`, String(vars[name])),
    String(key || ""),
  );
}
