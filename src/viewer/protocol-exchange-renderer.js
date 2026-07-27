export function renderProtocolExchange(view, { translate, escapeHtml, formatNumber = String }) {
  if (!view) return `<div class="empty-box">${escapeHtml(translate("protocolExchangeUnavailable"))}</div>`;
  return `
    <section class="protocol-exchange-view">
      <header class="protocol-exchange-header">
        <div>
          <span class="protocol-exchange-eyebrow">${escapeHtml(translate("protocolExchangeTitle"))}</span>
          <h3>${escapeHtml(view.protocolLabel)}</h3>
        </div>
        <div class="protocol-exchange-identity">
          ${view.model ? `<span>${escapeHtml(view.model)}</span>` : ""}
          <code>${escapeHtml(view.protocol)}</code>
        </div>
      </header>
      <p class="protocol-exchange-note">${escapeHtml(translate("protocolExchangeEvidenceNote"))}</p>
      <div class="protocol-direction-stack">
        ${renderUpstream(view, { translate, escapeHtml, formatNumber })}
        ${renderDownstream(view, { translate, escapeHtml, formatNumber })}
      </div>
    </section>
  `;
}

function renderUpstream(view, dependencies) {
  const { translate, escapeHtml } = dependencies;
  const counts = view.upstream.counts;
  return `
    <section class="protocol-direction upstream">
      ${renderDirectionHeader("↑", escapeHtml(translate("protocolUpstream")), escapeHtml(translate("protocolUpstreamDescription")), [
        metric(translate("protocolInstructionBlocks"), counts.instruction_blocks, dependencies),
        metric(translate("protocolInputItems"), counts.input_items, dependencies),
        metric(translate("protocolEffectiveTools"), counts.tools, dependencies),
      ])}
      ${renderInstructionBlocks(view, dependencies)}
      ${renderToolStages(view, dependencies)}
      ${renderItemSequence(view.requestId, view.upstream.items, "request", dependencies)}
      <div class="protocol-direction-actions">
        ${rawButton(view.requestId, "history", translate("rawHistory"), "request", escapeHtml)}
        ${rawButton(view.requestId, "message", translate("rawMessage"), "request", escapeHtml)}
        ${rawButton(view.requestId, "metadata", translate("rawRequestMetadata"), "request", escapeHtml)}
        ${rawButton(view.requestId, "full", translate("rawFull"), "request", escapeHtml)}
      </div>
    </section>
  `;
}

function renderDownstream(view, dependencies) {
  const { translate, escapeHtml } = dependencies;
  const counts = view.downstream.counts;
  return `
    <section class="protocol-direction downstream">
      ${renderDirectionHeader("↓", escapeHtml(translate("protocolDownstream")), escapeHtml(translate("protocolDownstreamDescription")), [
        metric(translate("protocolOutputItems"), counts.output_items, dependencies),
        metric(translate("protocolReasoningItems"), counts.reasoning_items, dependencies),
        metric(translate("protocolToolCalls"), counts.tool_calls, dependencies),
      ], view.downstream.status ? escapeHtml(view.downstream.status) : "")}
      ${renderItemSequence(view.requestId, view.downstream.items, "response", dependencies)}
      <div class="protocol-direction-actions">
        ${rawButton(view.requestId, "response", translate("protocolFullResponse"), "response", escapeHtml)}
        ${rawButton(view.requestId, "tool_calls", translate("protocolToolCallDetails"), "response", escapeHtml)}
      </div>
    </section>
  `;
}

function renderDirectionHeader(symbol, title, description, metrics, status = "") {
  return `
    <header class="protocol-direction-header">
      <span class="protocol-direction-symbol">${symbol}</span>
      <div class="protocol-direction-copy">
        <div class="protocol-direction-title"><h4>${title}</h4>${status ? `<span>${status}</span>` : ""}</div>
        <p>${description}</p>
      </div>
      <div class="protocol-metrics">${metrics.join("")}</div>
    </header>
  `;
}

function renderInstructionBlocks(view, dependencies) {
  const { translate, escapeHtml, formatNumber } = dependencies;
  if (!view.upstream.instructions.length) return "";
  return `
    <section class="protocol-subsection">
      <div class="protocol-subsection-heading">
        <h5>${escapeHtml(translate("protocolInstructions"))}</h5>
        <div class="protocol-subsection-meta">
          <em>${escapeHtml(translate("protocolInstructionTranslationPolicy"))}</em>
          <span>${escapeHtml(translate("itemCount", { count: view.upstream.instructions.length }))}</span>
        </div>
      </div>
      <div class="protocol-record-list">
        ${view.upstream.instructions.map((item) => `
          <button type="button" class="protocol-record" data-raw="${escapeHtml(view.requestId)}" data-raw-section="${escapeHtml(item.section)}">
            <span class="protocol-record-kind">${escapeHtml(item.role)}</span>
            <code>${escapeHtml(item.sourcePath)}</code>
            <small>${escapeHtml(translate("protocolChars", { count: formatNumber(item.chars) }))}</small>
          </button>
        `).join("")}
      </div>
    </section>
  `;
}

function renderToolStages(view, dependencies) {
  const { translate, escapeHtml, formatNumber } = dependencies;
  if (!view.upstream.toolStages.length) return "";
  return `
    <section class="protocol-subsection">
      <div class="protocol-subsection-heading">
        <h5>${escapeHtml(translate("protocolToolLifecycle"))}</h5>
        <div class="protocol-subsection-meta">
          <em>${escapeHtml(translate("protocolToolTranslationPolicy"))}</em>
          <button type="button" data-raw="${escapeHtml(view.requestId)}" data-raw-section="tools">${escapeHtml(translate("protocolToolSchemas"))}</button>
        </div>
      </div>
      <div class="protocol-tool-stages">
        ${view.upstream.toolStages.map((stage) => `
          <button type="button" class="protocol-tool-stage ${escapeHtml(stage.kind)}" data-raw="${escapeHtml(view.requestId)}" data-raw-section="${escapeHtml(stage.section)}">
            <header>
              <span>${escapeHtml(toolStageLabel(stage.kind, translate))}</span>
              <code>${escapeHtml(stage.sourcePath)}</code>
              <small>${escapeHtml(translate("protocolEffectiveToolCount", { count: formatNumber(stage.effectiveToolCount) }))}</small>
            </header>
            ${stage.namespaces.length || stage.namespacesOmitted ? `
              <div class="protocol-namespace-chips">
                ${stage.namespaces.map((namespace) => `<span title="${escapeHtml(namespace.sourcePath)}"><strong>${escapeHtml(namespace.qualifiedName)}</strong><em>${escapeHtml(translate("protocolNamespaceToolCount", { count: formatNumber(namespace.toolCount) }))}</em></span>`).join("")}
                ${stage.namespacesOmitted ? `<span><strong>+${escapeHtml(formatNumber(stage.namespacesOmitted))}</strong></span>` : ""}
              </div>
            ` : ""}
            <div class="protocol-tool-chips">
              ${stage.tools.map((tool) => `<span title="${escapeHtml(tool.sourcePath || tool.qualifiedName)}"><strong>${escapeHtml(tool.qualifiedName)}</strong><em>${escapeHtml(tool.type)}${tool.deferred ? ` · ${escapeHtml(translate("protocolDeferred"))}` : ""}</em></span>`).join("")}
              ${stage.toolsOmitted ? `<span><strong>+${escapeHtml(formatNumber(stage.toolsOmitted))}</strong></span>` : ""}
            </div>
          </button>
        `).join("")}
      </div>
    </section>
  `;
}

function renderItemSequence(requestId, items, mode, dependencies) {
  const { translate, escapeHtml, formatNumber } = dependencies;
  if (!items.length) return `<div class="empty-box">${escapeHtml(translate(mode === "response" ? "protocolNoDownstreamItems" : "protocolNoUpstreamItems"))}</div>`;
  return `
    <section class="protocol-subsection protocol-sequence">
      <div class="protocol-subsection-heading">
        <h5>${escapeHtml(translate(mode === "response" ? "protocolOutputSequence" : "protocolInputSequence"))}</h5>
        <div class="protocol-subsection-meta">
          <em>${escapeHtml(translate(mode === "response" ? "protocolResponseTranslationPolicy" : "protocolContextTranslationPolicy"))}</em>
          <span>${escapeHtml(translate("itemCount", { count: items.length }))}</span>
        </div>
      </div>
      <ol>
        ${items.map((item) => `
          <li class="semantic-${escapeHtml(item.semantic)}">
            <button type="button" class="protocol-sequence-entry" data-raw="${escapeHtml(requestId)}" data-raw-section="${escapeHtml(item.section)}"${item.mode === "response" ? ' data-raw-mode="response"' : ""}>
              <span class="protocol-sequence-index">${item.index == null ? "·" : item.index}</span>
              <div class="protocol-sequence-main">
                <div>
                  <strong>${escapeHtml(protocolSemanticLabel(item.semantic, translate))}</strong>
                  <code>${escapeHtml(item.itemType)}</code>
                  ${item.role && item.role !== "unknown" ? `<span>${escapeHtml(item.role)}</span>` : ""}
                </div>
                <small>${escapeHtml(item.sourcePath)}</small>
                ${item.name ? `<p>${escapeHtml(item.name)}${item.callId ? ` · ${escapeHtml(item.callId)}` : ""}</p>` : ""}
                ${item.toolNames.length ? `<p>${escapeHtml(item.toolNames.join(" · "))}</p>` : ""}
              </div>
              ${item.chars ? `<span class="protocol-sequence-size">${escapeHtml(translate("protocolChars", { count: formatNumber(item.chars) }))}</span>` : ""}
            </button>
          </li>
        `).join("")}
      </ol>
    </section>
  `;
}

function metric(label, value, { escapeHtml, formatNumber }) {
  return `<span><strong>${escapeHtml(formatNumber(Number(value || 0)))}</strong><small>${escapeHtml(label)}</small></span>`;
}

function rawButton(requestId, section, label, mode, escapeHtml) {
  return `<button type="button" data-raw="${escapeHtml(requestId)}" data-raw-section="${escapeHtml(section)}"${mode === "response" ? ' data-raw-mode="response"' : ""}>${escapeHtml(label)}</button>`;
}

function toolStageLabel(kind, translate) {
  if (kind === "added") return translate("protocolToolsAdded");
  if (kind === "loaded") return translate("protocolToolsLoaded");
  return translate("protocolToolsDeclared");
}

function protocolSemanticLabel(semantic, translate) {
  const key = {
    instruction: "protocolSemanticInstruction",
    tools_added: "protocolSemanticToolsAdded",
    tools_loaded: "protocolSemanticToolsLoaded",
    user_message: "protocolSemanticUserMessage",
    assistant_message: "protocolSemanticAssistantMessage",
    reasoning: "protocolSemanticReasoning",
    tool_search: "protocolSemanticToolSearch",
    tool_call: "protocolSemanticToolCall",
    tool_result: "protocolSemanticToolResult",
    response_item: "protocolSemanticResponseItem",
    input_item: "protocolSemanticInputItem",
    message: "protocolSemanticInputItem",
  }[semantic];
  return translate(key || "protocolSemanticUnknown");
}
