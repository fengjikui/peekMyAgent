const repositoryRootUrl = new URL("../../../", import.meta.url);
const catalogUrl = new URL("assets/demo/storyboard/catalog.zh-CN.json", repositoryRootUrl);
const elements = {
  list: document.querySelector(".chapter-list"),
  title: document.querySelector("#chapter-title"),
  player: document.querySelector(".demo-player"),
  question: document.querySelector(".chapter-question"),
  boundary: document.querySelector(".chapter-boundary"),
  guide: document.querySelector(".guide-link"),
};

const catalog = await fetch(catalogUrl).then((response) => {
  if (!response.ok) throw new Error(`章节目录载入失败：HTTP ${response.status}`);
  return response.json();
});

const buttons = catalog.chapters.map((chapter, index) => {
  const button = document.createElement("button");
  button.className = "chapter-button";
  button.type = "button";
  button.textContent = `${String(index + 1).padStart(2, "0")} · ${chapter.label}`;
  button.addEventListener("click", () => selectChapter(chapter));
  elements.list.append(button);
  return [chapter.id, button];
});

const buttonByChapter = new Map(buttons);

function selectChapter(chapter) {
  for (const [id, button] of buttonByChapter) {
    button.setAttribute("aria-current", id === chapter.id ? "true" : "false");
  }

  elements.title.textContent = chapter.label;
  elements.question.textContent = chapter.review.question;
  elements.boundary.textContent = `${chapter.review.source.label}。${chapter.review.source.boundary}`;
  elements.guide.href = resolveGuideUrl(chapter.guide, chapter.guide_section);
  elements.guide.hidden = false;

  const playerUrl = new URL("./index.html", window.location.href);
  playerUrl.searchParams.set("embed", "1");
  playerUrl.searchParams.set("autoplay", "0");
  playerUrl.searchParams.set("timeline", chapter.timeline);
  elements.player.src = playerUrl;

  const pageUrl = new URL(window.location.href);
  pageUrl.searchParams.set("chapter", chapter.id);
  window.history.replaceState(null, "", pageUrl);
}

const requestedChapter = new URLSearchParams(window.location.search).get("chapter");
const initialChapter = catalog.chapters.find((chapter) => chapter.id === requestedChapter)
  || catalog.chapters.find((chapter) => chapter.id === catalog.default_chapter)
  || catalog.chapters[0];

selectChapter(initialChapter);

function markdownHeadingSlug(value) {
  return value
    .trim()
    .toLowerCase()
    .replace(/[\p{P}\p{S}]+/gu, "")
    .replace(/\s+/g, "-");
}

function resolveGuideUrl(path, section) {
  const slug = markdownHeadingSlug(section);
  if (window.location.hostname.endsWith(".github.io")) {
    const owner = window.location.hostname.split(".")[0];
    const repository = repositoryRootUrl.pathname.split("/").filter(Boolean)[0];
    if (owner && repository) {
      return `https://github.com/${owner}/${repository}/blob/main/${String(path).replace(/^\/+/, "")}#${slug}`;
    }
  }
  return `${new URL(String(path).replace(/^\/+/, ""), repositoryRootUrl).href}#${slug}`;
}
