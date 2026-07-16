export async function runTranslationGenerationOperation({
  prepare,
  generate,
  reloadCache,
  isCurrent,
  onSuccess,
  onError,
  onStale,
} = {}) {
  try {
    if (prepare) await prepare();
    if (!isCurrent()) return stale("prepare");
    const result = await generate();
    if (!isCurrent()) return stale("generate");
    if (reloadCache) await reloadCache(result);
    if (!isCurrent()) return stale("reload-cache");
    onSuccess?.(result);
    return { status: "completed" };
  } catch (error) {
    if (!isCurrent()) return stale("error");
    onError?.(error);
    return { status: "failed" };
  }

  function stale(stage) {
    onStale?.(stage);
    return { status: "stale", stage };
  }
}
