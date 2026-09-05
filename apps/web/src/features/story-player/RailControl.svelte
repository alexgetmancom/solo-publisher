<!-- =============================================================================
  Stateless side controls: avatar navigation, language, Telegram and feed mode.
  `feedMenuOpen` lives in StoryPlayer because a document click closes it.

  Geometry inherits the rail container's `--rail-*` variables.
============================================================================= -->
<script lang="ts">
import type { StoryUi } from "./i18n";

let {
  ui,
  locale,
  feedMode,
  feedMenuOpen,
  ontogglemenu,
  onselectmode,
}: {
  ui: StoryUi;
  locale: "en" | "ru";
  feedMode: string;
  feedMenuOpen: boolean;
  ontogglemenu: () => void;
  onselectmode: (mode: string) => void;
} = $props();
</script>

<div class="rail-control" aria-label={ui.feedMode}>
  <div class="rail-avatar-menu">
    <button class="rail-avatar-menu__button" type="button" aria-label={ui.menu}>
      <img src="/avatar-small.webp" alt="" width="34" height="34" />
    </button>
    <div class="rail-avatar-menu__panel">
      <a href={locale === "ru" ? "/ru/" : "/"}>Alex Getman</a>
      <a href={locale === "ru" ? "/ru/about/" : "/about/"}>{ui.about}</a>
      <a class="notranslate" href={locale === "ru" ? "/" : "/ru/"}>{ui.language}</a>
      <a href="https://t.me/alexgetmancom" target="_blank" rel="noopener noreferrer">{ui.telegram}</a>
    </div>
  </div>
  <div class="feed-mode-menu">
    <button
      class="feed-mode-menu__button is-active"
      type="button"
      aria-haspopup="true"
      aria-expanded={feedMenuOpen}
      onclick={(event) => {
        event.stopPropagation();
        ontogglemenu();
      }}
    >
      <span>{feedMode === "deep" ? ui.feedDeep : feedMode === "watched" ? ui.feedWatched : ui.feedLatest}</span>
      <span aria-hidden="true">▾</span>
    </button>
    <div class="feed-mode-menu__panel" class:is-open={feedMenuOpen}>
      <button class:is-active={feedMode === "latest"} type="button" onclick={() => onselectmode("latest")}>{ui.feedLatest}</button>
      <button class:is-active={feedMode === "deep"} type="button" onclick={() => onselectmode("deep")}>{ui.feedDeep}</button>
      <button class:is-active={feedMode === "watched"} type="button" onclick={() => onselectmode("watched")}>{ui.feedWatched}</button>
    </div>
  </div>
</div>

<style>
  .rail-control {
    position: absolute;
    z-index: var(--z-rail);
    top: var(--rail-active-offset);
    left: 0.05rem;
    width: 50px;
    height: var(--rail-card-height);
    box-sizing: border-box;
    display: flex;
    flex-direction: column;
    align-items: center;
    gap: 0.32rem;
    padding: 0.38rem 0.32rem;
    /* Neutral, like every other frame in the rail. This panel is chrome, not
       content — an accent outline made it compete with the story cards. */
    border: 1px solid var(--border);
    border-right: 0;
    border-radius: 8px 0 0 8px;
    background: var(--player-surface);
    box-shadow: var(--player-lift-soft);
    pointer-events: auto;
    backdrop-filter: blur(12px);
    -webkit-backdrop-filter: blur(12px);
  }

  .rail-avatar-menu,
  .feed-mode-menu {
    position: relative;
  }

  .rail-avatar-menu {
    flex: 0 0 auto;
  }

  .feed-mode-menu {
    flex: 1 1 auto;
    display: flex;
  }

  .rail-avatar-menu__button,
  .feed-mode-menu__button,
  .feed-mode-menu__panel button {
    min-height: 36px;
    border: 1px solid var(--border);
    background: var(--player-surface);
    color: var(--text-header);
    cursor: pointer;
    backdrop-filter: blur(14px);
    -webkit-backdrop-filter: blur(14px);
    transition:
      border-color 0.16s ease,
      background 0.16s ease,
      color 0.16s ease;
  }

  .rail-avatar-menu__button {
    width: 34px;
    height: 34px;
    display: grid;
    place-items: center;
    padding: 0;
    border-radius: 10px;
    box-shadow: var(--player-lift-soft);
  }

  .rail-avatar-menu__button img {
    width: 28px;
    height: 28px;
    border-radius: 7px;
    object-fit: cover;
  }

  .feed-mode-menu__button {
    flex: 1 1 auto;
    min-height: 0;
    width: 34px;
    display: flex;
    align-items: center;
    justify-content: center;
    gap: 0.36rem;
    padding: 0.48rem 0.2rem;
    border-radius: 7px;
    font-size: 0.72rem;
    font-weight: 900;
    writing-mode: vertical-rl;
    text-orientation: mixed;
  }

  .rail-avatar-menu__button:hover,
  .feed-mode-menu__button:hover,
  .feed-mode-menu__button.is-active {
    border-color: var(--player-active-border);
    background: var(--scrim-soft);
  }

  .rail-avatar-menu__panel,
  .feed-mode-menu__panel {
    position: absolute;
    left: calc(100% + 0.48rem);
    top: 0;
    min-width: 154px;
    display: grid;
    gap: 0.16rem;
    padding: 0.38rem;
    border: 1px solid var(--border);
    border-radius: 8px;
    background: var(--player-surface);
    box-shadow: var(--player-lift);
    opacity: 0;
    pointer-events: none;
    transform: translateY(-4px);
    transition:
      opacity 0.16s ease,
      transform 0.16s ease;
    backdrop-filter: blur(16px);
    -webkit-backdrop-filter: blur(16px);
  }

  .rail-avatar-menu:hover .rail-avatar-menu__panel,
  .rail-avatar-menu:focus-within .rail-avatar-menu__panel,
  .feed-mode-menu__panel.is-open,
  .feed-mode-menu:focus-within .feed-mode-menu__panel {
    opacity: 1;
    pointer-events: auto;
    transform: translateY(0);
  }

  .rail-avatar-menu__panel a,
  .feed-mode-menu__panel button {
    display: block;
    width: 100%;
    padding: 0.48rem 0.55rem;
    border-radius: 6px;
    color: var(--text-main);
    font-size: 0.82rem;
    font-weight: 850;
    text-align: left;
  }

  .feed-mode-menu__panel button {
    min-height: 0;
    border: 0;
    background: transparent;
  }

  .rail-avatar-menu__panel a:hover,
  .feed-mode-menu__panel button:hover,
  .feed-mode-menu__panel button.is-active {
    background: var(--scrim-soft);
    border-color: var(--border-hover);
    color: var(--text-header);
  }

  /* ---- Tablet (<=1120px): the control turns horizontal, above the rail ---- */
  @media (max-width: 1120px) {
    .rail-control {
      position: relative;
      top: auto;
      left: auto;
      width: 100%;
      height: auto;
      flex-direction: row;
      order: 1;
      margin-bottom: 0.48rem;
      border-radius: 8px;
    }

    .feed-mode-menu__button {
      width: auto;
      min-height: 36px;
      writing-mode: horizontal-tb;
    }
  }

  /* ---- Phone (<=760px): the rail is hidden, the control stays as a header ---- */
  @media (max-width: 760px) {
    .rail-control {
      position: relative;
      left: auto;
      top: auto;
      width: 100%;
      height: auto;
      flex-direction: row;
      justify-content: flex-start;
      margin: 0 0 0.55rem;
      padding: 0.42rem;
      border: 1px solid var(--border);
      border-radius: 10px;
    }

    .rail-avatar-menu__panel,
    .feed-mode-menu__panel {
      left: 0;
      top: calc(100% + 0.45rem);
    }

    .feed-mode-menu {
      flex: 0 0 auto;
    }

    .feed-mode-menu__button {
      width: auto;
      min-height: 36px;
      writing-mode: horizontal-tb;
      padding: 0.34rem 0.68rem;
    }
  }
</style>
