<!-- =============================================================================
  RIGHT PANEL: post text and sharing.
  ─────────────────────────────────────────────────────────────────────────────
  Stateless presentation of category metadata, the page's only h1, expandable
  paragraphs, sources and the desktop share action. Astro's noscript copy uses
  a paragraph to avoid a second h1. Scoped styles use :global only for state
  classes owned by StoryPlayer.
============================================================================= -->
<script lang="ts">
import type { StoryUi } from "./i18n";
import type { PlayerPost } from "./payload";

let {
  post,
  ui,
  updating,
  expanded,
  readMoreVisible,
  readingVisible,
  shareCopied,
  copyEl = $bindable(null),
  ontogglereadmore,
  onshare,
}: {
  post: PlayerPost;
  ui: StoryUi;
  updating: boolean;
  expanded: boolean;
  readMoreVisible: boolean;
  readingVisible: boolean;
  shareCopied: boolean;
  copyEl?: HTMLElement | null;
  ontogglereadmore: () => void;
  onshare: () => void;
} = $props();

const readingTimeMin = $derived(Math.max(1, Math.ceil(post.body.join(" ").split(/\s+/).length / 180)));
</script>

<!-- CSS describes whether the panel is hidden, not an attribute: on desktop it
     is a permanent third column, and only below 760px is it a sliding sheet.
     The old aria-hidden={!readingVisible} was always true on desktop, hiding
     the page's only h1, the whole post body and live buttons from screen
     readers (axe: aria-hidden-focus). The mobile closed state gets
     visibility: hidden instead — that drops the panel out of the accessibility
     tree and out of the Tab order exactly where it is not visible. -->
<aside class="story-context" data-story-context>
  <div class="story-panel is-active" class:is-updating={updating} data-panel="post">
    <!-- One line above the headline, the way a rubric works in print: what
         section this is, when it ran, how long it takes. It used to be two
         separate blocks — a bordered, tinted category pill and a meta row
         under the title — which put three framed objects in a column whose
         main content, the text, has no frame at all. View count is gone from
         here: it is a number for the author, and Command Center already
         reports it. -->
    <p class="story-eyebrow">
      <span class="story-eyebrow__rubric">{post.category}</span>
      <span class="story-eyebrow__dot" aria-hidden="true">·</span>
      <span>{post.relativeDate}</span>
      <span class="story-eyebrow__dot" aria-hidden="true">·</span>
      <span>{readingTimeMin} min</span>
    </p>
    <h1 class="story-title" data-story-title>{post.title}</h1>
    <div class="story-copy" class:is-expanded={expanded} data-story-copy bind:this={copyEl}>
      {#each post.body as paragraph}
        <p>{paragraph}</p>
      {/each}
    </div>
    <button class="read-more-button" type="button" hidden={!readMoreVisible} onclick={ontogglereadmore}>
      {expanded ? ui.collapse : ui.readMore}
    </button>
    <!-- The footnote line: the one action the column offers. Sharing used to be
         a full-width bordered button pinned to the bottom of a full-height
         panel — the loudest object in the column, for something the desktop
         address bar already does, with a gap above it wherever the post was
         short. As a plain link it stays available and stops competing. Phones
         keep the real button: it lives on the stage's floating bar
         (StoryVisual), where no URL is visible to copy. -->
    <footer class="story-footnote">
      <button class="story-footnote__link story-footnote__action" type="button" onclick={onshare}>
        {shareCopied ? ui.copied : ui.share}
      </button>
    </footer>
  </div>
</aside>

<style>
  /* ---------------------- Context panel (right column) ---------------------- */
  .story-context {
    /* A caption to the frame, so it is as tall as its own text and sits level
       with the middle of the stage. Stretched to the full column height it had
       to distribute that height somehow, and every short post turned into a
       line of text at the top and a button at the bottom with a void between.
       The cap keeps a long post inside the viewport, where the copy scrolls. */
    align-self: center;
    height: auto;
    max-height: 100%;
    min-height: 0;
    display: flex;
    flex-direction: column;
    /* A reading column, not a card. Framed and filled it was a white rectangle
       on a white sheet, outlined for no reason — the type and the space around
       it already say where the column is. The stage keeps its frame because it
       holds media; this holds text. On phones the same element becomes a bottom
       sheet and takes its fill and border back below. */
    border: 0;
    border-radius: 10px;
    background: transparent;
    overflow: hidden;
    min-width: 0;
    animation: appReveal 0.68s cubic-bezier(0.16, 1, 0.3, 1) forwards;
    animation-delay: 0.36s;
    opacity: 0;
  }

  @keyframes appReveal {
    from {
      opacity: 0;
      transform: translateY(12px);
    }
    to {
      opacity: 1;
      transform: translateY(0);
    }
  }

  .story-panel {
    height: auto;
    max-height: 100%;
    min-height: 0;
    display: flex;
    flex-direction: column;
    padding: clamp(1rem, 1.35vw, 1.25rem);
    overflow: hidden;
  }

  .story-context [hidden] {
    display: none;
  }

  /* -------------------------------- Rubric ---------------------------------- */
  .story-eyebrow {
    display: flex;
    align-items: baseline;
    flex-wrap: wrap;
    gap: 0.4rem;
    margin: 0 0 0.7rem;
    font-family: var(--font-mono);
    font-size: 0.7rem;
    letter-spacing: 0.05em;
    color: var(--text-muted);
    flex-shrink: 0;
  }

  /* The only colour in the column, and it is a word rather than a fill. As a
     tinted pill with its own border it was a fourth framed object competing
     with the headline; hue reads as brand at this size and as an alert at
     badge size. --accent is tuned per theme, so it clears 4.5:1 on both. */
  .story-eyebrow__rubric {
    color: var(--accent);
    font-weight: 700;
    text-transform: uppercase;
  }

  .story-eyebrow__dot {
    color: var(--meta-dot);
  }

  /* ------------------------------- Headline --------------------------------- */
  .story-title {
    /* The gap between the headline block and the body is the one place the
       hierarchy is allowed to be loud, now that the type sizes are not. It
       used to be carried by the meta row's own bottom margin; with the meta
       moved above the title, the space has to live here. */
    margin: 0 0 1.15rem;
    color: var(--text-header);
    letter-spacing: -0.015em;
    line-height: 1.16;
    /* Down from clamp(1.8rem, 2.3vw, 2.5rem). The panel is a reading column,
       not a poster: at the old size a three-word headline filled two lines and
       pushed the body out of view. Hierarchy now comes from weight and the
       space around the block, not from raw size. */
    font-size: clamp(1.45rem, 1.65vw, 1.9rem);
    font-weight: 800;
  }

  /* Smooth post change (.is-updating is set on the root during a repaint). */
  .story-title,
  .story-copy,
  .story-eyebrow {
    transition:
      opacity 0.25s cubic-bezier(0.4, 0, 0.2, 1),
      transform 0.25s cubic-bezier(0.4, 0, 0.2, 1);
    opacity: 1;
    transform: translateY(0);
  }

  .story-panel.is-updating .story-title,
  .story-panel.is-updating .story-copy,
  .story-panel.is-updating .story-eyebrow {
    opacity: 0;
    transform: translateY(8px);
    transition: none;
  }

  /* ------------------------------- Post body -------------------------------- */
  .story-copy {
    display: block;
    color: var(--text-main);
    /* Body copy sized for reading, not for a slide. It was up at 1.16-1.48rem
       with 1.32 leading — display proportions applied to running text, which
       is why a two-sentence post looked like a pull quote. Comfortable body
       size with generous leading is what carries a text column. */
    font-size: clamp(0.95rem, 0.95vw, 1.05rem);
    line-height: 1.62;
    /* Shrink, do not grow: the column is sized by its content now, and the
       only reason this box is a flex item with a floor of zero is so a long
       post scrolls inside it instead of pushing the footnote off-screen. */
    flex: 0 1 auto;
    min-height: 0;
    overflow-y: auto;
    position: relative;
    padding-right: 0.45rem;
    scrollbar-width: thin;
    scrollbar-color: var(--border-dashed) transparent;
  }

  .story-copy::-webkit-scrollbar {
    width: 4px;
  }

  .story-copy::-webkit-scrollbar-track {
    background: transparent;
  }

  .story-copy::-webkit-scrollbar-thumb {
    background-color: var(--border-dashed);
    border-radius: 999px;
  }

  /* One measure for the column: ~68 characters is the usual comfortable line,
     and the paragraph gap is tied to the leading rather than a round number. */
  .story-copy p {
    margin: 0 0 1.05em 0;
    max-width: 68ch;
  }

  .story-copy p:last-child {
    margin-bottom: 0;
  }

  /* The headline is an h1 inside the panel: restore its margin over the rule above. */
  .story-panel > h1.story-title {
    /* The gap between the headline block and the body is the one place the
       hierarchy is allowed to be loud, now that the type sizes are not. It
       used to be carried by the meta row's own bottom margin; with the meta
       moved above the title, the space has to live here. */
    margin: 0 0 1.15rem;
  }

  /* ------------------------------- Footnote --------------------------------- */
  /* Sits right under the text, not at the bottom of the viewport. The old
     actions row was pushed down with `margin-top: auto` inside a full-height
     panel, so a two-sentence post left several hundred pixels of nothing
     between the copy and the button — a gap that reads as a loading failure
     rather than as air. */
  .story-footnote {
    display: flex;
    flex-wrap: wrap;
    align-items: baseline;
    gap: 0.35rem 0.85rem;
    margin-top: 1.1rem;
    flex-shrink: 0;
    font-size: 0.72rem;
    line-height: 1.25;
  }

  /* A link and a button that look identical on purpose: at this weight neither
     is an object, they are just the last line of the column. */
  .story-footnote__link {
    color: var(--text-muted);
    text-decoration: none;
    transition: color 0.16s ease;
  }

  .story-footnote__link:hover {
    color: var(--text-main);
    text-decoration: underline;
  }

  .story-footnote__action {
    padding: 0;
    border: 0;
    background: none;
    font: inherit;
    cursor: pointer;
  }


  /* Note: the old CSS had a "compact desktop" block (max-height: 800px) that
     shrank the panel's typography, but it never applied — @import order
     overrode it. The migration kept the actual behaviour; if a compact mode is
     wanted, add @media (max-height: 800px) and (min-width: 1121px) here
     deliberately. */

  /* ---- Tablet (<=1120px): the panel sits below the stage ---- */
  @media (max-width: 1120px) {
    .story-context {
      order: 2;
      width: min(100%, 720px);
      justify-self: center;
      height: auto;
      min-height: 0;
      max-height: none;
    }
  }

  /* ---- Phone (<=760px): the panel becomes a sheet sliding over the stage ---- */
  @media (max-width: 760px) {
    /* A bottom sheet, the way every mobile OS does one: pinned to the bottom
       edge, full width, rounded only at the top, sliding up from below.
   
       It used to be a floating card inset from all four sides whose height
       followed its content, which meant it appeared in a different place and
       at a different size for every post — there was no "where the text is",
       and a short post left it hovering mid-screen. A sheet trades that for
       one fixed shape: it always arrives from the bottom, always the same
       height, and the reader's eye already knows where to go. Empty space at
       the foot of a bottom-anchored sheet reads as padding; the same emptiness
       inside a floating card read as a bug. */
    .story-context {
      position: fixed;
      z-index: var(--z-controls);
      top: auto;
      right: 0;
      left: 0;
      /* Stops at the action strip so Read/Back stays visible and keeps working
         as the way out of the sheet. */
      bottom: var(--stage-actions-strip);
      box-sizing: border-box;
      display: block;
      /* Explicit, not `auto` with left/right 0: the tablet rule above sets a
         width and the sheet inherited it, arriving 243px wide on a 375px
         screen — a card, not a sheet. */
      width: 100vw;
      min-height: 0;
      height: min(58dvh, calc(100dvh - 7rem - var(--stage-actions-strip) - env(safe-area-inset-top, 0)));
      max-width: none;
      max-height: none;
      border: 0;
      border-top: 1px solid var(--border);
      border-radius: 20px 20px 0 0;
      background: var(--player-surface);
      box-shadow: var(--player-lift);
      overflow-x: hidden;
      overflow-y: auto;
      overscroll-behavior: contain;
      /* visibility, not opacity alone: this hides the panel from screen readers
         and from Tab while the sheet is closed. The visibility transition is
         delayed for the slide-out, or the panel would vanish instantly with no
         animation. */
      visibility: hidden;
      pointer-events: none;
      transform: translateY(100%);
      /* The easing sheets use: quick to leave, long settle. The old animation
         was a 1.2rem nudge with a 2% scale — technically a transition, not
         enough movement to read as the panel arriving from anywhere. */
      transition:
        transform 0.36s cubic-bezier(0.32, 0.72, 0, 1),
        visibility 0s linear 0.36s;
      backdrop-filter: none;
      -webkit-backdrop-filter: none;
      animation: none;
    }

    /* The grab handle every sheet has. Purely a signal of what this surface is
       and which way it goes; dragging it is not wired up, Back closes. */
    .story-context::before {
      content: "";
      position: sticky;
      top: 0.5rem;
      z-index: var(--z-sticky);
      display: block;
      width: 2.25rem;
      height: 0.25rem;
      margin: 0.5rem auto -0.25rem;
      border-radius: 999px;
      background: var(--border-dashed);
    }

    :global(.story-player.is-reading) .story-context {
      opacity: 1;
      visibility: visible;
      pointer-events: auto;
      transform: translateY(0);
      transition-delay: 0s;
    }

    .story-eyebrow {
      margin-top: 0.25rem;
      margin-bottom: 0.9rem;
    }

    .story-title {
      font-size: clamp(1.7rem, 8vw, 2.35rem);
      line-height: 1.05;
    }

    /* The sheet owns the height now, so the panel fills it and the copy scrolls
       inside rather than the whole sheet moving under the reader. */
    .story-panel {
      min-height: 0;
      height: 100%;
      padding: 0.9rem 1.15rem 1.25rem;
      overflow: hidden;
    }

    /* On mobile the headline is already on the stage, so hide it in the sheet. */
    .story-context [data-story-title] {
      display: none;
    }

    /* Sharing on a phone is the stage's floating bar, next to Read — the sheet
       covers the picture, so an action down here would be a second Share two
       taps apart. The source stays: it is information, not an action. */
    .story-footnote__action {
      display: none;
    }

    .story-copy {
      flex: 1 1 auto;
      min-width: 0;
      overflow-y: auto;
      overflow-wrap: anywhere;
      word-break: break-word;
      padding-right: 0;
      font-size: 1rem;
      line-height: 1.6;
    }

    .story-footnote {
      padding-bottom: env(safe-area-inset-bottom, 0);
    }

    .story-copy p {
      max-width: 100%;
      overflow-wrap: anywhere;
      word-break: break-word;
    }
  }
</style>
