<!-- =============================================================================
  STORY RAIL (left column, bottom strip on mobile).
  ─────────────────────────────────────────────────────────────────────────────
  Stateless presentation of posts, the active card and visible feed indexes.
  It renders cards, scrolls to the active one and reports selection to the root.
  Scoped styles include mobile overrides; --rail-* variables on StoryPlayer's
  container own the rail geometry.
============================================================================= -->
<script lang="ts">
import { onStoryImageError } from "../../scripts/story-player/media";
import { easeOutCubic, railScrollTarget } from "../../scripts/story-player/rail-geometry";
import { truncateText } from "../../utils/text";
import type { StoryUi } from "./i18n";
import type { PlayerPost } from "./payload";

let {
  posts,
  ui,
  active,
  visibleIndexes,
  onselect,
}: {
  posts: PlayerPost[];
  ui: StoryUi;
  active: number;
  visibleIndexes: number[];
  onselect: (index: number) => void;
} = $props();

let rail = $state<HTMLElement | null>(null);
/* Card DOM references live in a Map rather than an array: when a post leaves a
   keyed {#each}, Svelte calls bind:this with null and the entry goes with the
   card. An array would keep a reference to a detached element in its place. */
const cards = new Map<number, HTMLElement>();

/* includes() over an array, once per card, made a rail repaint O(n^2). */
const visible = $derived(new Set(visibleIndexes));

/* How far a card sits from the active one, counted in cards the reader can
   actually see. Filtered-out cards are display:none, so post index distance
   would lie: with a mode filter on, index+1 can be three slots down the strip.
   The rail is a scroll affordance — the neighbours have to stay legible so it
   is obvious there is more above and below — so the dimming is a falloff over
   this distance, not one flat "inactive" state. */
const positions = $derived(new Map(visibleIndexes.map((postIndex, slot) => [postIndex, slot])));

function distanceFromActive(index: number): number {
  const from = positions.get(active);
  const to = positions.get(index);
  if (from === undefined || to === undefined) return 9;
  return Math.abs(to - from);
}

/* The rail is deliberately not user-scrollable (overflow: hidden, hidden
   scrollbars) — only the active card sets its position. Side effect: browsers
   will not animate scrollTo({behavior:"smooth"}) on such a container and
   silently leave scrollTop where it was, so we drive the position ourselves. */
const SCROLL_MS = 380;

function glideTo(railEl: HTMLElement, left: number, top: number): () => void {
  const fromLeft = railEl.scrollLeft;
  const fromTop = railEl.scrollTop;
  const deltaLeft = left - fromLeft;
  const deltaTop = top - fromTop;
  if (window.matchMedia("(prefers-reduced-motion: reduce)").matches) {
    railEl.scrollLeft = left;
    railEl.scrollTop = top;
    return () => {};
  }
  let frame = 0;
  const start = performance.now();
  const step = (now: number) => {
    const progress = Math.min(1, (now - start) / SCROLL_MS);
    const eased = easeOutCubic(progress);
    railEl.scrollLeft = fromLeft + deltaLeft * eased;
    railEl.scrollTop = fromTop + deltaTop * eased;
    if (progress < 1) frame = requestAnimationFrame(step);
  };
  frame = requestAnimationFrame(step);
  return () => cancelAnimationFrame(frame);
}

/* The active card is always scrolled to the centre of the rail. */
$effect(() => {
  const card = cards.get(active);
  if (!rail || !card) return;
  const railEl = rail;
  let stopGlide: (() => void) | undefined;
  const timer = window.setTimeout(() => {
    const target = railScrollTarget(railEl, card);
    stopGlide = glideTo(railEl, target.left, target.top);
  }, 60);
  return () => {
    window.clearTimeout(timer);
    stopGlide?.();
  };
});
</script>

<nav class="story-rail" aria-label={ui.storyRail} bind:this={rail}>
  {#each posts as post, index (post.id)}
    <a
      href={post.url}
      class="rail-card"
      class:is-active={index === active}
      class:rail-card--no-image={!post.image}
      class:is-filtered-out={!visible.has(index)}
      data-distance={Math.min(3, distanceFromActive(index))}
      {@attach (node) => {
        cards.set(index, node);
        return () => cards.delete(index);
      }}
      onclick={(event) => {
        event.preventDefault();
        onselect(index);
      }}
    >
      <span class="rail-card__media" aria-hidden="true">
        {#if post.image}
          {#if post.mediaType === "video"}
            {#if post.fallbackImage}
              <img
                src={post.fallbackImage}
                srcset={post.imageSrcSet || undefined}
                alt={post.title}
                loading={index < 4 ? "eager" : "lazy"}
                decoding="async"
                sizes="(max-width: 760px) 38vw, 140px"
              />
            {:else}
              <video src={`${post.image}#t=0.001`} muted playsinline preload="metadata"></video>
            {/if}
          {:else}
            <img
              src={post.image}
              srcset={post.imageSrcSet || undefined}
              alt={post.title}
              loading={index < 4 ? "eager" : "lazy"}
              decoding="async"
              sizes="(max-width: 760px) 38vw, 140px"
              onerror={(event) => onStoryImageError(event, post.fallbackImage)}
            />
          {/if}
        {:else}
          <span>{post.category}</span>
        {/if}
      </span>
      <span class="rail-card__shade"></span>
      <span class="rail-card__text">
        <strong>{truncateText(post.title, 62)}</strong>
      </span>
    </a>
  {/each}
</nav>

<style>
  /* ---- Rail (desktop: a vertical column, active card centred) ---- */
  .story-rail {
    align-self: center;
    display: flex;
    flex-direction: column;
    width: 100%;
    height: 100%;
    min-height: 0;
    gap: var(--rail-gap);
    overflow-y: hidden;
    overflow-x: hidden;
    overscroll-behavior-y: contain;
    padding: 0.05rem;
    scrollbar-width: none;
    /* Entrance on load */
    animation: appReveal 0.68s cubic-bezier(0.16, 1, 0.3, 1) forwards;
    animation-delay: 0.08s;
    opacity: 0;
  }

  /* Empty spacers so the active card can sit dead centre. */
  .story-rail::before,
  .story-rail::after {
    content: "";
    display: block;
    height: var(--rail-active-offset);
    flex-shrink: 0;
  }

  .story-rail::-webkit-scrollbar {
    display: none;
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

  /* -------------------------------- Card ----------------------------------- */
  .rail-card {
    position: relative;
    min-height: 0;
    height: var(--rail-card-height);
    flex-shrink: 0;
    display: flex;
    align-items: stretch;
    border: 1px solid var(--border);
    border-radius: 8px;
    overflow: hidden;
    background: var(--player-surface);
    color: var(--text-header);
    /* On a white sheet the hairline alone is not enough to say "card" — the
       fill matches the backdrop now, so the lift is what gives the strip its
       objects. */
    box-shadow: var(--player-lift-soft);
    isolation: isolate;
    padding: 0;
    transition:
      filter 0.3s cubic-bezier(0.4, 0, 0.2, 1),
      opacity 0.3s cubic-bezier(0.4, 0, 0.2, 1),
      border-color 0.3s ease,
      box-shadow 0.3s ease;
  }

  /* Neighbours stay readable. The rail used to drop every inactive card to
     opacity 0.38 with full grayscale, which erased the titles either side of
     the active one — the strip stopped looking scrollable at all. Now the fade
     runs over the two nearest neighbours and only bottoms out beyond them, so
     "there is a story above and below this one" is visible at a glance. */
  .rail-card[data-distance="1"] {
    opacity: 0.86;
    filter: grayscale(25%);
  }

  .rail-card[data-distance="2"] {
    opacity: 0.66;
    filter: grayscale(55%);
  }

  .rail-card[data-distance="3"] {
    opacity: 0.44;
    filter: grayscale(85%);
  }

  .rail-card:not(.is-active):hover {
    filter: none;
    opacity: 1;
    border-color: var(--player-active-border);
  }

  /* No frame of its own: the viewfinder in StoryPlayer.svelte draws the one
     around this slot, and a second border inside it just doubled the line.
     Being undimmed and in the frame is what marks this card as the active one. */
  .rail-card.is-active {
    filter: none;
    opacity: 1;
    background: var(--player-surface);
  }

  /* Post hidden by the current feed mode (Deep/Watched). */
  .rail-card.is-filtered-out {
    display: none;
  }

  .rail-card__media {
    position: relative;
    height: 100%;
    order: 2;
    width: clamp(92px, 30%, 148px);
    max-width: 42%;
    flex-shrink: 0;
    overflow: hidden;
    /* The letterbox beside a thumbnail follows the theme. Hard black was a
       stripe of night down the side of every card on a white page. */
    background: var(--player-backdrop);
    border-left: 1px solid var(--border);
  }

  .rail-card.is-active .rail-card__media {
    order: 2;
    border-left: 1px solid var(--border-soft);
  }

  .rail-card__media img,
  .rail-card__media video {
    width: 100%;
    height: 100%;
    object-fit: contain;
    object-position: center;
    display: block;
  }

  /* Card with no image: the category badge over a gradient. */
  .rail-card__media > span {
    display: grid;
    place-items: center;
    height: 100%;
    padding: 0.35rem;
    font-size: 0.56rem;
    color: var(--text-muted);
    font-family: var(--font-mono);
    font-weight: 800;
    text-align: center;
    background: var(--scrim-soft);
  }

  /* Desktop keeps the shade empty — it only earns its place over the tablet
     layout, where the title sits on top of the thumbnail. */
  .rail-card__shade {
    position: absolute;
    inset: 0;
    z-index: var(--z-base);
    pointer-events: none;
  }

  .rail-card__text {
    position: relative;
    order: 1;
    z-index: var(--z-above);
    display: flex;
    flex-direction: column;
    justify-content: center;
    min-width: 0;
    flex-grow: 1;
    padding: clamp(0.48rem, 0.72vw, 0.68rem) clamp(0.6rem, 0.8vw, 0.95rem);
  }

  .rail-card.is-active .rail-card__text {
    order: 1;
    padding-left: clamp(0.82rem, 1vw, 1.15rem);
    padding-right: clamp(0.82rem, 1vw, 1.15rem);
  }

  .rail-card__text strong {
    font-size: clamp(1.08rem, 1.18vw, 1.35rem);
    line-height: 1.04;
    overflow-wrap: anywhere;
    display: -webkit-box;
    -webkit-line-clamp: 3;
    line-clamp: 3;
    -webkit-box-orient: vertical;
    overflow: hidden;
  }

  /* ---- Tablet (<=1120px): the rail turns horizontal below the player ---- */
  @media (max-width: 1120px) {
    .story-rail {
      order: 2;
      width: 100%;
      height: auto;
      max-height: none;
      display: flex;
      flex-direction: row;
      gap: 0.55rem;
      overflow-x: auto;
      overflow-y: hidden;
      overscroll-behavior-x: contain;
      overscroll-behavior-y: auto;
      padding: 0.05rem 0.05rem 0.48rem;
    }

    .story-rail::before,
    .story-rail::after {
      display: none;
    }

    .rail-card {
      min-height: 0;
      width: clamp(104px, 12vw, 124px);
      height: 140px;
      flex-shrink: 0;
      position: relative;
      display: block;
      padding: 0;
    }

    .rail-card.is-active {
      padding-left: 0;
    }

    .rail-card__media,
    .rail-card__shade,
    .rail-card__text {
      position: absolute;
      inset: 0;
    }

    .rail-card__media {
      width: auto;
      aspect-ratio: auto;
      border: 0;
      border-radius: 0;
    }

    .rail-card__shade {
      background: linear-gradient(180deg, transparent 32%, var(--overlay-rail-shade) 100%);
    }

    .rail-card__text {
      justify-content: flex-end;
      padding: 0.72rem;
    }
  }

  /* ---- Phone (<=760px): the rail itself is hidden by its container in
     StoryPlayer, but cards are larger in case it is shown (feed mode). ---- */
  @media (max-width: 760px) {
    .story-rail {
      width: 100%;
      gap: 0.65rem;
      animation: none;
      opacity: 1;
      transform: none;
    }

    .rail-card {
      width: clamp(118px, 34vw, 148px);
      height: 168px;
      border-radius: 10px;
    }

    .rail-card.is-active {
      padding-left: 0;
      border-color: var(--player-active-border);
    }

    .rail-card.is-active .rail-card__media {
      order: initial;
      border: 0;
    }

    .rail-card.is-active .rail-card__text {
      order: initial;
      padding: 0.72rem;
    }
  }
</style>
