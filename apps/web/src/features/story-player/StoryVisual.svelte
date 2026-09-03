<!-- =============================================================================
  CENTRAL STAGE: active post photo or video.
  ─────────────────────────────────────────────────────────────────────────────
  Presentational component; only the failed-video fallback is local state.
  It owns the active media elements, sound/read controls and mobile actions.
  StoryProgressBar owns progress, PlayPauseOverlay owns the click flash, and
  every interaction calls back into StoryPlayer. Styles below are scoped.
============================================================================= -->
<script lang="ts">
import { readTapIntent } from "../../scripts/story-player/gestures";
import { onStoryImageError } from "../../scripts/story-player/media";
import type { StoryUi } from "./i18n";
import PlayPauseOverlay from "./PlayPauseOverlay.svelte";
import type { PlayerPost } from "./payload";
import StoryProgressBar from "./StoryProgressBar.svelte";

let {
  post,
  ui,
  paused,
  muted,
  autoplayMuted,
  soundPrompt,
  overlayTick,
  shareCopied,
  readingVisible,
  gallerySubIndex = 0,
  video = $bindable(null),
  audio = $bindable(null),
  progressFill = $bindable(null),
  onwheel,
  ontoggleplay,
  ongrantsound,
  onaudiotoggle,
  ontoggleread,
  onshare,
  onvideoplaying,
  onvideotimeupdate,
  onvideoended,
  onvideowaiting,
  onselectgallery,
}: {
  post: PlayerPost;
  ui: StoryUi;
  paused: boolean;
  muted: boolean;
  autoplayMuted: boolean;
  soundPrompt: boolean;
  overlayTick: number;
  shareCopied: boolean;
  readingVisible: boolean;
  gallerySubIndex?: number;
  video?: HTMLVideoElement | null;
  audio?: HTMLAudioElement | null;
  progressFill?: HTMLElement | null;
  onwheel: (event: WheelEvent) => void;
  ontoggleplay: () => void;
  ongrantsound: () => void;
  onaudiotoggle: () => void;
  ontoggleread: () => void;
  onshare: () => void;
  onvideoplaying: () => void;
  onvideotimeupdate: () => void;
  onvideoended: () => void;
  onvideowaiting: () => void;
  onselectgallery?: (index: number) => void;
} = $props();

const isVideo = $derived(post.mediaType === "video");
const audioLabel = $derived(autoplayMuted ? ui.tapForSound : muted ? ui.muted : ui.mute);
let videoFailed = $state(false);
/* A video carries its own soundtrack; a still only has sound if the post ships
 * an audio track. Anything else has nothing to mute. */
const hasAudio = $derived(isVideo ? !videoFailed : Boolean(post.audioUrl));
/* Ask for sound while it is off and the visitor has not answered yet — either
 * because the browser refused an unmuted autoplay, or simply because muted is
 * the default nobody has overridden. Both look identical from here. */
const showSoundPrompt = $derived(soundPrompt && (muted || autoplayMuted));

/* Several images on a post (the post itself is not a video) — page through
     them as separate slides before moving to the next post. */
const gallerySequence = $derived(isVideo ? [] : post.gallery || []);
const hasGallerySequence = $derived(gallerySequence.length >= 2);
const activeGalleryMedia = $derived(hasGallerySequence ? gallerySequence[Math.min(gallerySubIndex, gallerySequence.length - 1)] : null);

/* The video failed to load — show the poster/fallback image instead. */
function onVideoError(): void {
  if (post.fallbackImage) videoFailed = true;
}
$effect(() => {
  void post.id;
  videoFailed = false;
});

function onImageError(event: Event): void {
  onStoryImageError(event, post.fallbackImage);
}

/* How much of each side pages the gallery. Wide enough to hit with a thumb
   without looking, narrow enough to leave the picture itself a play/pause
   target — the same proportion the stories apps use. */
const TAP_EDGE_RATIO = 0.28;

function onStageClick(event: MouseEvent & { currentTarget: HTMLElement }): void {
  /* detail is 0 for a click the keyboard synthesised on the focused link, and
     such an event carries clientX 0 — which the zones would read as a tap on
     the far left. Enter on the stage means play/pause, as it always did. */
  const rect = event.currentTarget.getBoundingClientRect();
  const intent =
    event.detail > 0 && rect.width > 0
      ? readTapIntent((event.clientX - rect.left) / rect.width, hasGallerySequence, TAP_EDGE_RATIO)
      : "toggle-play";
  if (intent === "toggle-play") {
    ontoggleplay();
    return;
  }
  /* Clamped, not wrapped: paging past either end of the gallery does nothing
     rather than jumping to a neighbouring post. The edges of the stage answer
     for the pictures inside this post; moving between posts is the swipe. */
  onselectgallery?.(gallerySubIndex + (intent === "next-image" ? 1 : -1));
}

/* Removing a <video> from the DOM does not stop it. The element keeps its
 * decoder and keeps playing to the speakers until it is garbage collected, and
 * nothing here holds a reference by then.
 *
 * That happens on every scroll from a video post to a still one: the {#if}
 * below unmounts the element mid-playback while the next post mounts its own.
 * Scroll fast enough and two clips are audible at once — the one you can see
 * and one you cannot. Pausing and dropping the source on destroy releases it. */
function releaseOnDestroy(el: HTMLVideoElement) {
  return {
    destroy() {
      el.pause();
      el.removeAttribute("src");
      el.load();
    },
  };
}
</script>

<div class="story-visual-wrap">
  <article class="story-visual" class:story-visual--no-image={!post.image} data-story-visual {onwheel}>
    <!-- A soft darkening band under the top overlay. The progress bar is white,
         which is right over most photos and invisible over a light one — and
         plenty of posts are screenshots of white pages. A scrim fixes it for
         every image at once, instead of trying to pick a bar colour that works
         on all of them. -->
    <span class="story-visual__top-scrim" aria-hidden="true"></span>
    <StoryProgressBar
      title={post.title}
      {gallerySequence}
      {gallerySubIndex}
      bind:progressFill
      {onselectgallery}
    />
    <a
      class="story-visual__link"
      href={post.url}
      aria-label={post.title}
      onclick={(event) => {
        /* href is the post's real address: a modifier-click or middle button
           must open it in a new tab rather than being swallowed as a pause. */
        if (event.metaKey || event.ctrlKey || event.shiftKey || event.altKey || event.button !== 0) return;
        event.preventDefault();
        onStageClick(event);
      }}
    >
      {#if post.image && (!isVideo || videoFailed)}
        <img
          src={activeGalleryMedia ? activeGalleryMedia.path || post.image : videoFailed ? post.fallbackImage : post.image}
          srcset={activeGalleryMedia || videoFailed ? undefined : post.imageSrcSet || undefined}
          alt={`${post.title}${hasGallerySequence ? ` — ${gallerySubIndex + 1}/${gallerySequence.length}` : ""}`}
          loading="eager"
          fetchpriority="high"
          decoding="async"
          sizes="(max-width: 760px) min(100vw - 2rem, 390px), 320px"
          onerror={onImageError}
        />
      {/if}
      {#if post.image && isVideo && !videoFailed}
        <video
          bind:this={video}
          use:releaseOnDestroy
          src={post.image}
          poster={post.posterSrc || post.fallbackImage || undefined}
          muted
          autoplay
          playsinline
          preload="metadata"
          onerror={onVideoError}
          onplaying={onvideoplaying}
          ontimeupdate={onvideotimeupdate}
          onended={onvideoended}
          onwaiting={onvideowaiting}
        ></video>
      {/if}
      {#if !post.image}
        <span class="story-visual__fallback">{post.title}</span>
      {/if}
    </a>
    <!-- Only rendered when this post can actually make a sound. A video always
         can; a still needs its own audio track. Without the guard every plain
         image story showed a mute control that toggled silence. -->
    <!-- Autoplay policy: browsers refuse to start a video with sound until the
         user has interacted with the page, so the clip always begins muted and
         the state machine flags it (videoAutoplayMuted). That flag is a call to
         action, not a status — the voice-over is the story. It gets a plate on
         the stage until sound is granted; after that the quiet corner chip is
         enough, and the choice is remembered for the session. -->
    {#if hasAudio && showSoundPrompt}
      <button class="sound-cta" type="button" onclick={ongrantsound}>
        <svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
          <path d="M11 5 6 9H3v6h3l5 4z"></path>
          <path d="M15.5 8.5a5 5 0 0 1 0 7"></path>
          <path d="M18.5 5.5a9 9 0 0 1 0 13"></path>
        </svg>
        <span>{ui.tapForSound}</span>
      </button>
    {/if}
    {#if hasAudio && !showSoundPrompt}
      <button
        class="audio-chip"
        class:is-on={!muted && !autoplayMuted}
        type="button"
        aria-pressed={muted}
        aria-label={audioLabel}
        onclick={onaudiotoggle}
      >
        <svg class="audio-chip__icon" viewBox="0 0 24 24" width="19" height="19" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
          <path d="M11 5 6 9H3v6h3l5 4z"></path>
          {#if muted || autoplayMuted}
            <line x1="17" y1="9" x2="22" y2="15"></line>
            <line x1="22" y1="9" x2="17" y2="15"></line>
          {:else}
            <path d="M15.5 8.5a5 5 0 0 1 0 7"></path>
            <path d="M18.5 5.5a9 9 0 0 1 0 13"></path>
          {/if}
        </svg>
      </button>
    {/if}
    <div class="story-mobile-caption" aria-hidden="true">
      <span>{post.category}</span>
      <strong>{post.title}</strong>
    </div>
    <!-- Two equal items in one floating bar. Nothing is lit until a panel is
         actually open — see story-actions.css. -->
    <div class="story-action-bar" aria-label={ui.storyLabel}>
      <button
        class="story-action"
        class:is-open={readingVisible}
        type="button"
        aria-expanded={readingVisible}
        onclick={ontoggleread}
      >
        <svg class="story-action-icon" viewBox="0 0 24 24" width="21" height="21" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
          <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"></path>
          <path d="M14 2v6h6"></path>
          <path d="M8 13h8"></path>
          <path d="M8 17h6"></path>
        </svg>
        <span class="story-action__label">{readingVisible ? ui.back : ui.read}</span>
      </button>
      <button class="story-action" type="button" onclick={onshare}>
        {#if shareCopied}
          <svg class="story-action-icon" viewBox="0 0 24 24" width="21" height="21" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
            <path d="M20 6 9 17l-5-5"></path>
          </svg>
        {:else}
          <svg class="story-action-icon" viewBox="0 0 24 24" width="21" height="21" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
            <circle cx="18" cy="5" r="3"></circle>
            <circle cx="6" cy="12" r="3"></circle>
            <circle cx="18" cy="19" r="3"></circle>
            <line x1="8.59" y1="13.51" x2="15.42" y2="17.49"></line>
            <line x1="15.41" y1="6.51" x2="8.59" y2="10.49"></line>
          </svg>
        {/if}
        <span class="story-action__label">{shareCopied ? ui.copied : ui.share}</span>
      </button>
    </div>
    <PlayPauseOverlay {paused} {overlayTick} />
    <audio bind:this={audio} src={!isVideo ? post.audioUrl || undefined : undefined} preload="none"></audio>
  </article>
</div>

<style>
  /* ----------------- Stage wrapper (centre of the player grid) -------------- */
  .story-visual-wrap {
    position: relative;
    display: grid;
    place-items: center;
    height: 100%;
    min-width: 0;
    min-height: 0;
    animation: appReveal 0.68s cubic-bezier(0.16, 1, 0.3, 1) forwards;
    animation-delay: 0.22s;
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

  /* --------------------- Portrait 9:16 stage with media --------------------- */
  .story-visual {
    position: relative;
    width: min(760px, calc((100dvh - 0.25rem) * 0.5625), 100%);
    height: auto;
    max-height: 100%;
    aspect-ratio: 9 / 16;
    /* Neutral hairline. --border-hover is crimson-tinted, so the stage wore a
       red outline on both themes — glaring on the light one, and it framed the
       media as if it were an alert. */
    border: 1px solid var(--border);
    border-radius: 10px;
    /* The surround follows the theme. Only the picture is exempt from the
     * theme — the frame around it is page, and a black slab behind a story on
     * a light page is just a black slab. */
    background: var(--player-backdrop);
    overflow: hidden;
    isolation: isolate;
    box-shadow: var(--player-lift);
    backdrop-filter: blur(18px);
    -webkit-backdrop-filter: blur(18px);
  }

  .story-visual__link,
  .story-visual__link img,
  .story-visual__link video,
  .story-visual__fallback {
    position: absolute;
    inset: 0;
  }

  .story-visual__link img,
  .story-visual__link video {
    width: 100%;
    height: 100%;
    display: block;
  }

  .story-visual__link img {
    object-fit: contain;
    /* Transparent, not black: with `contain` the element's own background is
       what fills the letterbox, so an opaque colour here would punch a dark
       rectangle through the themed surround. */
    background: transparent;
  }

  .story-visual__link video {
    /* Keep the video surface below the progress bar: some browsers render
       video in a compositing layer that sits above a higher z-index.
       `contain` keeps landscape clips whole instead of cropping the sides. */
    clip-path: inset(8px 0 0);
    object-fit: contain;
    background: transparent;
  }

  /* The progress bar, plain and segmented, lives in StoryProgressBar.svelte. */

  /* Post with no image: a large headline over a gradient. */
  .story-visual__fallback {
    display: grid;
    align-content: end;
    background:
      radial-gradient(circle at 35% 18%, var(--overlay-fallback-glow), transparent 35%),
      linear-gradient(135deg, var(--overlay-fallback-wash), var(--overlay-fallback-sheen));
    color: var(--text-header);
    font-weight: 900;
    font-size: clamp(1.6rem, 3.1vw, 2.7rem);
    line-height: 1.04;
    padding: 1.2rem;
    overflow-wrap: anywhere;
  }

  .story-visual__top-scrim {
    position: absolute;
    z-index: var(--z-above);
    inset: 0 0 auto;
    height: 4.5rem;
    background: linear-gradient(180deg, var(--overlay-top-scrim), var(--overlay-clear));
    pointer-events: none;
  }

  /* Sits just above the action bar, centred: the one thing to tap before the
   * story makes sense. It disappears for good once sound is granted. */
  .sound-cta {
    position: absolute;
    z-index: var(--z-player-sound-cta);
    left: 50%;
    bottom: calc(4.2rem + env(safe-area-inset-bottom, 0));
    transform: translateX(-50%);
    display: inline-flex;
    align-items: center;
    gap: 0.45rem;
    min-height: 44px;
    padding: 0.5rem 1rem;
    border: 1px solid var(--overlay-cta-border);
    border-radius: 14px;
    background: var(--overlay-cta-surface);
    backdrop-filter: blur(10px);
    -webkit-backdrop-filter: blur(10px);
    color: var(--overlay-text-strong);
    font-size: 0.85rem;
    font-weight: 600;
    white-space: nowrap;
    cursor: pointer;
  }

  .sound-cta:hover {
    background: var(--overlay-cta-surface-hover);
    border-color: var(--overlay-cta-border-hover);
  }

  /* ------------------------------ Sound control ----------------------------- */
  /* A round icon button, not a labelled pill. It sits on the picture, so it
   * keeps the un-themed --overlay-* palette, and it is the one control every
   * video app puts in this corner — the word next to the speaker was doing no
   * work the icon was not already doing, while making the control wide enough
   * to read as a banner. State is the icon itself: crossed out or not. */
  .audio-chip {
    position: absolute;
    z-index: var(--z-player-media-control);
    right: 0.8rem;
    top: 2.05rem;
    display: inline-flex;
    align-items: center;
    justify-content: center;
    width: 38px;
    height: 38px;
    padding: 0;
    border: 1px solid var(--overlay-border);
    border-radius: 50%;
    background: var(--overlay-surface);
    backdrop-filter: blur(20px) saturate(150%);
    -webkit-backdrop-filter: blur(20px) saturate(150%);
    color: var(--overlay-text-strong);
    cursor: pointer;
    transition:
      background 0.18s ease,
      border-color 0.18s ease,
      color 0.18s ease;
  }

  .audio-chip__icon {
    flex: 0 0 auto;
  }

  .audio-chip:hover,
  .audio-chip.is-on {
    background: var(--overlay-fill-hover);
  }

  /* Mobile-only elements: hidden on desktop. */
  .story-mobile-caption {
    display: none;
  }

  /* The bar is the phone layout's bottom strip. On desktop the same three
   * actions live at the foot of the context panel (StoryContext), styled by the
   * same .story-action rules, so there is one button language rather than two. */
  .story-action-bar {
    display: none;
  }

  /* The click-to-play/pause overlay lives in PlayPauseOverlay.svelte. */

  /* ---- Tablet (<=1120px): the stage comes first in the column ---- */
  @media (max-width: 1120px) {
    .story-visual-wrap {
      order: 1;
    }
  }

  /* ---- Phone (<=760px): full-screen stage ---- */
  @media (max-width: 760px) {
    .story-visual-wrap {
      order: 1;
      width: 100%;
      height: 100svh;
      min-height: 560px;
      max-height: none;
      place-items: stretch;
      /* Fixed dark on a phone, in both themes. Here the stage is the whole
         screen rather than a framed object on a page, so whatever sits beside
         the picture is the inside of a media viewer — and a white band down the
         side of a photo, fullscreen, reads as a broken image rather than as a
         light theme. Desktop keeps the themed surround: there the frame really
         is page. */
      background: var(--bg-deep);
      animation: none;
      opacity: 1;
      transform: none;
    }

    .story-visual {
      width: 100%;
      height: 100%;
      max-height: none;
      border: 0;
      border-radius: 0;
      box-shadow: none;
      background: var(--bg-deep);
    }

    /* The picture gets the whole screen and the controls float on top of it.
       It used to stop above a reserved --stage-actions-strip, which was the
       right call when a story could be any shape: contain-fitting left a
       margin, and on a handset close to 9:16 the bar would have landed back on
       the image. The pipeline now composes every story to 9:16 with a blurred
       backdrop baked into the file, so the picture is already the shape of the
       screen — and reserving 88px turned a width-filling photo into a
       height-limited one with white gutters down both sides. On a browser with
       a persistent bottom bar there was little height to spare, which is why
       the story looked shrunk on a real phone and full-bleed in a simulator.
       --stage-actions-strip stays: the reading sheet still hangs off it, and it
       still measures the room the floating bar needs. */
    .story-visual__link img,
    .story-visual__link video,
    .story-visual__fallback {
      inset: 0;
      height: 100%;
    }

    .audio-chip {
      top: calc(env(safe-area-inset-top, 0) + 0.72rem);
      right: 0.72rem;
      z-index: var(--z-player-actions);
    }

    .story-mobile-caption {
      display: none;
      pointer-events: none;
    }

    .story-mobile-caption span {
      width: fit-content;
      padding: 0.22rem 0.5rem;
      border: 1px solid var(--overlay-error-border);
      border-radius: 7px;
      background: var(--overlay-error-fill);
      color: var(--overlay-error-text);
      font-family: var(--font-mono);
      font-size: 0.7rem;
      font-weight: 900;
      text-transform: uppercase;
    }

    .story-mobile-caption strong {
      max-width: 13ch;
      color: var(--overlay-text-strong);
      font-size: clamp(2rem, 10.5vw, 3.25rem);
      line-height: 0.95;
      letter-spacing: 0;
      text-shadow: 0 4px 24px var(--overlay-title-shadow);
    }

    /* Geometry only — the bar's surface, blur and items are in
     * story-actions.css, shared with the desktop panel. It floats clear of the
     * screen edges instead of spanning them, which is what makes it read as a
     * control layer sitting on the story rather than a strip cut out of it.
     *
     * The read action used to be a separate 4.25rem crimson circle above this
     * row, with its own radius, shadow and font: a fourth visual language on a
     * screen that already had three. */
    .story-action-bar {
      /* Scoped, so it beats the display:flex in story-actions.css — the base
         rule up top hides the bar on desktop and this is what brings it back. */
      display: flex;
      position: absolute;
      z-index: var(--z-player-actions);
      left: 0.7rem;
      right: 0.7rem;
      bottom: calc(0.7rem + env(safe-area-inset-bottom, 0));
      pointer-events: auto;
      /* Back on the picture, so back to the blurred dark slab from
         story-actions.css and the un-themed --overlay-* palette. The themed,
         transparent version here was correct only while the bar stood on a
         strip of page below the story; floating over media it would have been
         unreadable type on a photograph. */
    }
  }

  /* The buttons themselves are styled by the shared story-actions.css, loaded
     once from StoryPlayer.svelte, so the bar and the desktop context panel
     cannot drift apart. */

</style>
