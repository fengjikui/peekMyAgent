export function validateStoryboardNarrativeContract({ label, chapter, timeline, manifest }) {
  const teaching = manifest.teaching_contract;
  assert(teaching && typeof teaching === "object" && !Array.isArray(teaching),
    `${label} manifest needs a teaching_contract`);
  const audiences = Array.isArray(teaching.audiences)
    ? teaching.audiences
    : [teaching.audience].filter(Boolean);
  assert(audiences.length > 0 && audiences.every((audience) => (
    typeof audience === "string" && audience.trim().length >= 12
  )), `${label} teaching_contract needs at least one concrete audience`);
  for (const field of ["question", "takeaway"]) {
    assert(typeof teaching[field] === "string" && teaching[field].trim().length >= 24,
      `${label} teaching_contract.${field} must be a concrete statement`);
  }
  const limits = Array.isArray(teaching.explicit_limits)
    ? teaching.explicit_limits
    : teaching.out_of_scope;
  assert(Array.isArray(limits) && limits.length > 0 && limits.every((limit) => (
    typeof limit === "string" && limit.trim().length >= 4
  )), `${label} teaching_contract needs explicit_limits or out_of_scope`);

  const story = chapter.review.story;
  assert(story && typeof story === "object" && !Array.isArray(story),
    `${label}.review.story is required`);
  assert(Array.isArray(timeline.scenes) && timeline.scenes.length >= 3,
    `${label} timeline needs an opening, proof, and closing`);
  const sceneById = new Map(timeline.scenes.map((scene) => [scene.id, scene]));

  const opening = auditNarrativeBeat({
    label: `${label}.review.story.opening`,
    beat: story.opening,
    sceneById,
    timeline,
    requireSubtitles: true,
  });
  assert(opening === timeline.scenes[0],
    `${label}.review.story.opening must name the first scene`);
  assert(story.opening.ends_by_seconds <= 30,
    `${label}.review.story.opening must finish within the first 30 seconds`);

  const value = auditNarrativeBeat({
    label: `${label}.review.story.value`,
    beat: story.value,
    sceneById,
    timeline,
  });
  assert(story.value.ends_by_seconds <= 60,
    `${label}.review.story.value must make PMA's value explicit within 60 seconds`);
  assert(value.start_seconds >= opening.start_seconds,
    `${label}.review.story.value cannot precede the opening`);

  assert(Array.isArray(story.proof_scenes) && story.proof_scenes.length >= 2,
    `${label}.review.story.proof_scenes needs at least two Viewer evidence scenes`);
  assert(new Set(story.proof_scenes).size === story.proof_scenes.length,
    `${label}.review.story.proof_scenes must not repeat a scene`);
  for (const sceneId of story.proof_scenes) {
    const scene = sceneById.get(sceneId);
    assert(scene, `${label}.review.story.proof_scenes names an unknown scene: ${sceneId}`);
    assert(typeof scene.source_image === "string" && scene.source_image.startsWith("/assets/demo/"),
      `${label}.review.story.proof_scenes must point to real Viewer evidence: ${sceneId}`);
    assert(scene.start_seconds >= opening.end_seconds,
      `${label}.review.story.proof_scenes must follow the opening: ${sceneId}`);
  }

  const closing = auditNarrativeBeat({
    label: `${label}.review.story.closing`,
    beat: story.closing,
    sceneById,
    timeline,
  });
  assert(closing === timeline.scenes.at(-1),
    `${label}.review.story.closing must name the last scene`);
  assert(closing.start_seconds > value.start_seconds,
    `${label}.review.story.closing must follow the product-value beat`);
}

function auditNarrativeBeat({ label, beat, sceneById, timeline, requireSubtitles = false }) {
  assert(beat && typeof beat === "object" && !Array.isArray(beat), `${label} is required`);
  assert(typeof beat.scene === "string" && beat.scene.trim(), `${label}.scene is required`);
  const scene = sceneById.get(beat.scene);
  assert(scene, `${label}.scene is not present in the timeline: ${beat.scene}`);
  if (beat.ends_by_seconds !== undefined) {
    assert(Number.isFinite(beat.ends_by_seconds) && beat.ends_by_seconds > 0,
      `${label}.ends_by_seconds must be positive`);
    assert(scene.end_seconds <= beat.ends_by_seconds,
      `${label}.scene ends at ${scene.end_seconds}s, after its ${beat.ends_by_seconds}s deadline`);
  }
  assertNarrativeTerms(scene.narration, beat.narration_includes, `${label}.narration_includes`);
  if (requireSubtitles || beat.subtitle_includes !== undefined) {
    assertNarrativeTerms((scene.subtitle_cues || []).join("\n"), beat.subtitle_includes,
      `${label}.subtitle_includes`);
  }
  assert(scene.end_seconds <= timeline.duration_seconds,
    `${label}.scene must stay inside the timeline`);
  return scene;
}

function assertNarrativeTerms(text, terms, label) {
  assert(Array.isArray(terms) && terms.length > 0, `${label} must be a non-empty array`);
  const normalized = String(text || "").normalize("NFKC").toLocaleLowerCase("zh-CN");
  for (const term of terms) {
    assert(typeof term === "string" && term.trim().length >= 2,
      `${label} entries must contain at least two characters`);
    const expected = term.normalize("NFKC").toLocaleLowerCase("zh-CN");
    assert(normalized.includes(expected), `${label} is missing required phrase: ${term}`);
  }
}

function assert(condition, message) {
  if (!condition) throw new Error(message);
}
