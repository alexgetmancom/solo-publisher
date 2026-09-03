<!-- =============================================================================
  PLAYER ROOT. The sole owner of state.
  ─────────────────────────────────────────────────────────────────────────────
  All player state is declared here ($state below): active post, manual pause,
  reading panel, expanded text, feed mode, and the audio-state machine.

  Child components (Rail / Visual / Context) own no state. They receive props
  and call back here. New behaviour keeps state here, markup in the child, and
  complex transitions in a tested pure function.

  Keyboard, swipes, wheel navigation, automatic progress and view analytics
  also live here. Media API calls live in the effects below.

  Keep SEO markup (h1/canonical/JSON-LD, owned by Astro) and database queries out.
============================================================================= -->
<script lang="ts">
import { onMount, tick } from "svelte";
import { createStoryViewTracker } from "../../scripts/story-player/analytics";
import {
  applyMutePreference,
  autoplayRejected,
  beginAutoplay,
  clearAutoplayMute,
  confirmFirstFrame,
  initialVideoAudioState,
  resetForNewStory,
} from "../../scripts/story-player/audio-state";
import { advanceGallerySequence } from "../../scripts/story-player/gallery-state";
import { readSwipe } from "../../scripts/story-player/gestures";
import { preloadAdjacentMedia } from "../../scripts/story-player/media";
import { hasMutedPreference, readMutedPreference, writeMutedPreference } from "../../scripts/story-player/preferences";
import { createStoryProgressController } from "../../scripts/story-player/progress";
import { storyIntervalMs, swipeThresholdPx, wheelCooldownMs } from "./config";
/* Shared styles for the action bar: both the stage and the context panel draw
   it, so the block lives outside either scoped style (see the file itself). */
import "./story-actions.css";
import type { StoryUi } from "./i18n";
import type { PlayerPost } from "./payload";
import RailControl from "./RailControl.svelte";
import StoryContext from "./StoryContext.svelte";
import StoryRail from "./StoryRail.svelte";
import StoryVisual from "./StoryVisual.svelte";

let {
  posts,
  ui,
  locale,
  initialPaused = false,
}: { posts: PlayerPost[]; ui: StoryUi; locale: "en" | "ru"; initialPaused?: boolean } = $props();

/* --------------------------------- State --------------------------------- */
/* The initialPaused prop is read exactly once: it is a starting value, after
     which the user owns the pause, so prop reactivity is not wanted. */
// svelte-ignore state_referenced_locally
const startPaused = initialPaused;
let active = $state(0);
let manualPaused = $state(startPaused);
let manualPausedBeforeReading = $state(startPaused);
let readingVisible = $state(false);
let expanded = $state(false);
let feedMode = $state("latest");
let audioState = $state(initialVideoAudioState(true));
/* Starts false during SSR and is set from storage on mount, so the prompt is
 * only ever shown to someone who has genuinely not answered yet. */
let soundChoiceMade = $state(true);
let updating = $state(false); // Short post-change animation (.is-updating).
let readMoreVisible = $state(false);
let feedMenuOpen = $state(false);
let shareCopied = $state(false);
let overlayTick = $state(0); // Restarts the play/pause overlay animation.
let debugEnabled = $state(false);
let gallerySubIndex = $state(0); // Current slide for a multi-image post.

const activePost = $derived(posts[active] ?? posts[0]);
const paused = $derived(manualPaused);
/* Several images on a non-video post — page through them before moving to
     the next post (see advanceStory). */
const gallerySequence = $derived(activePost?.mediaType === "video" ? [] : activePost?.gallery || []);
const visibleIndexes = $derived.by(() => {
  const visible = posts
    .map((post, index) => ({ post, index }))
    .filter(({ post }) => feedMode === "latest" || post.feedModes.includes(feedMode))
    .map(({ index }) => index);
  return visible.length ? visible : posts.map((_, index) => index);
});

/* Elements we drive imperatively (media API, progress). */
let root = $state<HTMLElement | null>(null);
let video = $state<HTMLVideoElement | null>(null);
let audio = $state<HTMLAudioElement | null>(null);
let progressFill = $state<HTMLElement | null>(null);
let copyEl = $state<HTMLElement | null>(null);

let progress: ReturnType<typeof createStoryProgressController> | null = null;
let viewTracker: ReturnType<typeof createStoryViewTracker> | null = null;
let mounted = false;

const normalizedPath = (value: string) => {
  try {
    const url = new URL(value, window.location.origin);
    return url.pathname.endsWith("/") ? url.pathname : `${url.pathname}/`;
  } catch {
    return "/";
  }
};

/* ---------------------------- Post navigation ----------------------------- */
function nextVisibleIndex(direction: number): number {
  const currentPosition = visibleIndexes.indexOf(active);
  if (currentPosition === -1) return visibleIndexes[0] ?? active;
  return visibleIndexes[(currentPosition + direction + visibleIndexes.length) % visibleIndexes.length] ?? active;
}

/** The old render() equivalent: change the active post and every reset it implies. */
function goTo(index: number, options: { keepProgressIdle?: boolean } = {}): void {
  active = ((index % posts.length) + posts.length) % posts.length;
  expanded = false;
  gallerySubIndex = 0;
  audioState = resetForNewStory(audioState);
  if (readingVisible) setReading(false);
  updating = true;
  progress?.resetForStory(options);
  viewTracker?.scheduleStoryView(activePost);
  preloadAdjacentMedia({ active, posts, toPublicSrc: (value) => value ?? "" });
  window.requestAnimationFrame(() => {
    window.requestAnimationFrame(() => (updating = false));
  });
}

function navigate(direction: number): void {
  goTo(nextVisibleIndex(direction), { keepProgressIdle: true });
  progress?.resumeAfterManualNavigation();
}

/** The progress timer expired: if the post still has unshown images, page to
      the next one and simply restart the bar; otherwise advance to the next
      post as usual. */
function advanceStory(): void {
  const next = advanceGallerySequence(gallerySubIndex, gallerySequence.length);
  if (next.advancePost) {
    goTo(nextVisibleIndex(1));
    return;
  }
  gallerySubIndex = next.subIndex;
  progress?.resetForSlide();
}

function selectGalleryImage(index: number): void {
  if (index === gallerySubIndex || index < 0 || index >= gallerySequence.length) return;
  gallerySubIndex = index;
  progress?.resumeAfterManualNavigation();
}

/* ----------------------------- Pause and sound ---------------------------- */
function togglePause(): void {
  manualPaused = !manualPaused;
  overlayTick += 1;
  syncPlayback();
}

function syncPlayback(): void {
  progress?.update(paused);
  if (video && activePost?.mediaType === "video") {
    if (paused) video.pause?.();
    else playActiveVideo();
  }
}

function setMuted(nextMuted: boolean, persist = true): void {
  audioState = applyMutePreference(nextMuted);
  if (persist) writeMutedPreference(audioState.muted);
  if (audio) {
    audio.muted = audioState.muted;
    if (!audioState.muted && audio.getAttribute("src") && activePost?.mediaType !== "video") audio.play?.().catch(() => {});
    else audio.pause?.();
  }
  if (video) video.muted = audioState.muted;
}

/* The sound prompt is shown while this post has audio, sound is off, and the
 * visitor has never answered the question. Any answer — the plate, the corner
 * chip, or a tap on the stage — retires it for good. */
function grantSound(): void {
  soundChoiceMade = true;
  if (audioState.videoAutoplayMuted && video) {
    audioState = clearAutoplayMute(audioState);
    video.muted = false;
    video.play?.().catch(() => {});
    writeMutedPreference(false);
    return;
  }
  setMuted(false);
}

function onAudioToggle(): void {
  soundChoiceMade = true;
  if (audioState.videoAutoplayMuted && video) {
    audioState = clearAutoplayMute(audioState);
    video.muted = false;
    video.play?.().catch(() => {});
    return;
  }
  setMuted(!audioState.muted);
}

/* Armed when the current clip is not ready yet and playback has to wait for
 * `canplay`. Kept so the next post can cancel it: scrolling faster than the
 * network armed one waiter per post, all of them on the same element and none
 * of them ever removed, so a single `canplay` fired the whole backlog and every
 * stale closure ran beginAutoplay() against state that had since moved on. */
let pendingPlay: (() => void) | null = null;
function cancelPendingPlay(): void {
  if (!pendingPlay || !video) return;
  video.removeEventListener("canplay", pendingPlay);
  pendingPlay = null;
}

/* Browser autoplay policies: all the transition logic lives in audio-state.ts. */
function playActiveVideo(): void {
  if (!video || activePost?.mediaType !== "video") return;
  const el = video;
  cancelPendingPlay();
  const play = () => {
    const intent = beginAutoplay(audioState);
    audioState = intent.state;
    if (intent.muteBeforePlay) el.muted = true;
    const mutedBeforePlay = el.muted;
    el.play?.().catch(() => {
      const rejection = autoplayRejected(audioState, mutedBeforePlay);
      audioState = rejection.state;
      if (rejection.retryMuted) {
        el.muted = true;
        el.play?.().catch(() => {});
      }
    });
  };
  if (el.readyState < HTMLMediaElement.HAVE_CURRENT_DATA) {
    const waiter = () => {
      pendingPlay = null;
      play();
    };
    pendingPlay = waiter;
    el.addEventListener("canplay", waiter, { once: true });
  } else play();
}

function onVideoTimeUpdate(): void {
  progress?.handleVideoTimeUpdate();
}

function onVideoPlaying(): void {
  progress?.handleVideoPlaying();
  const confirmation = confirmFirstFrame(audioState, { isManualPaused: manualPaused });
  audioState = confirmation.state;
  if (!confirmation.shouldRestoreSound) return;
  const el = video;
  if (!el || audioState.muted || manualPaused || activePost?.mediaType !== "video") return;
  el.muted = false;
  audioState = clearAutoplayMute(audioState);
  // Some browsers silently pause playback when script unmutes without a
  // fresh user gesture; retry once so the story doesn't freeze mid-video.
  if (el.paused) el.play?.().catch(() => {});
}

/* --------------------------- Reading and replies -------------------------- */
function setReading(visible: boolean): void {
  readingVisible = visible;
  if (visible) {
    manualPausedBeforeReading = manualPaused;
    manualPaused = true;
  } else {
    manualPaused = manualPausedBeforeReading;
  }
  syncPlayback();
}

async function share(): Promise<void> {
  const url = new URL(activePost.url, window.location.origin).href;
  try {
    if (navigator.share) await navigator.share({ title: activePost.title, url });
    else {
      await navigator.clipboard.writeText(url);
      shareCopied = true;
      window.setTimeout(() => (shareCopied = false), 1400);
    }
  } catch (error) {
    /* Dismissing the system sheet is a refusal, not a failure: copying the
       link behind the user's back is not on. Copy only if share itself broke. */
    if (error instanceof Error && error.name === "AbortError") return;
    await navigator.clipboard?.writeText(url).catch(() => {});
    shareCopied = true;
    window.setTimeout(() => (shareCopied = false), 1400);
  }
}

/* -------------------------------- Feed mode ------------------------------- */
function selectFeedMode(mode: string): void {
  feedMenuOpen = false;
  if (mode === feedMode) return;
  feedMode = mode;
  goTo(visibleIndexes.includes(active) ? active : (visibleIndexes[0] ?? 0), { keepProgressIdle: true });
  progress?.resumeAfterManualNavigation();
}

/* --------------------- Gestures: mouse wheel and swipes ------------------- */
let lastWheelTime = 0;
let wheelGestureLocked = false;
let wheelUnlockTimer: number | null = null;
function handleWheel(event: WheelEvent): void {
  if (Math.abs(event.deltaY) < 10) return;
  event.preventDefault();
  const now = Date.now();
  if (wheelGestureLocked || now - lastWheelTime < wheelCooldownMs) return;
  lastWheelTime = now;
  wheelGestureLocked = true;
  if (wheelUnlockTimer) window.clearTimeout(wheelUnlockTimer);
  wheelUnlockTimer = window.setTimeout(() => {
    wheelGestureLocked = false;
    wheelUnlockTimer = null;
  }, wheelCooldownMs);
  navigate(event.deltaY > 0 ? 1 : -1);
}

let touchStartX = 0;
let touchStartY = 0;
function onTouchStart(event: TouchEvent): void {
  const touch = event.touches[0];
  touchStartX = touch?.clientX || 0;
  touchStartY = touch?.clientY || 0;
}
function onTouchEnd(event: TouchEvent): void {
  /* The reading sheet is fixed on phones but still a DOM descendant, so its
     touches bubble up here. While it is open the gesture belongs to the text
     the finger is scrolling, not to the feed. */
  if (readingVisible) return;
  const touch = event.changedTouches[0];
  const intent = readSwipe((touch?.clientX || 0) - touchStartX, (touch?.clientY || 0) - touchStartY, swipeThresholdPx);
  if (intent !== "none") navigate(intent === "next" ? 1 : -1);
}

const isTypingTarget = (element: Element | null) => {
  const tagName = element?.tagName;
  return tagName === "INPUT" || tagName === "TEXTAREA" || tagName === "SELECT";
};
function onKeydown(event: KeyboardEvent): void {
  if (event.defaultPrevented || isTypingTarget(document.activeElement)) return;
  if (event.key === "Escape" && readingVisible) {
    event.preventDefault();
    setReading(false);
    return;
  }
  if (event.key === "ArrowDown" || event.key === "PageDown") {
    event.preventDefault();
    navigate(1);
  } else if (event.key === "ArrowUp" || event.key === "PageUp") {
    event.preventDefault();
    navigate(-1);
  } else if (event.key === " ") {
    event.preventDefault();
    togglePause();
  }
}

/* ---------------------------- Effects and mount --------------------------- */
/* A post or pause change syncs <video>/<audio> with state. The one place
     hand-written DOM is allowed: the media API and measurements. */
$effect(() => {
  void active;
  if (!mounted) return;
  cancelPendingPlay();
  tick().then(() => {
    if (video && activePost?.mediaType === "video") {
      video.muted = audioState.muted;
      video.load();
      if (!paused) playActiveVideo();
    }
    if (audio) {
      audio.pause?.();
      if (activePost?.audioUrl && activePost.mediaType !== "video") {
        audio.muted = audioState.muted;
        if (!audioState.muted && !paused) audio.play?.().catch(() => {});
      }
    }
    measureReadMore();
  });
});

/* Whether the body fits depends on the column height, and that changes without
   a post change: rotation, window resize, the mobile address bar collapsing.
   Without this, "Read more" reflected the previous size. */
$effect(() => {
  const element = copyEl;
  if (!element) return;
  const observer = new ResizeObserver(() => measureReadMore());
  observer.observe(element);
  return () => observer.disconnect();
});

/* "Read more" appears only when the body genuinely overflowed. */
function measureReadMore(): void {
  window.requestAnimationFrame(() => {
    if (!copyEl) return;
    readMoreVisible = copyEl.scrollHeight > copyEl.clientHeight + 4 || expanded;
  });
}

onMount(() => {
  debugEnabled = new URLSearchParams(window.location.search).has("debug");
  audioState = initialVideoAudioState(readMutedPreference());
  soundChoiceMade = hasMutedPreference();
  progress = createStoryProgressController({
    getVideo: () => video,
    getProgressFill: () => progressFill,
    posts,
    activeIndex: () => active,
    isPaused: () => paused,
    onAdvance: () => advanceStory(),
    intervalMs: storyIntervalMs,
  });
  viewTracker = createStoryViewTracker({ activeIndex: () => active, normalizedPath });
  mounted = true;
  goTo(0);
  return () => {
    if (wheelUnlockTimer) window.clearTimeout(wheelUnlockTimer);
  };
});
</script>

<svelte:window onkeydown={onKeydown} />
<svelte:document
  onclick={() => {
    feedMenuOpen = false;
  }}
/>

<section
  bind:this={root}
  class="story-player"
  class:is-reading={readingVisible}
  aria-label={ui.storyLabel}
  data-story-player
  ontouchstart={onTouchStart}
  ontouchend={onTouchEnd}
>
  <div class="story-player__main">
    <div class="story-rail-container" onwheel={handleWheel}>
      <!-- The viewfinder: a frame that never moves, marking the slot the stage
           is showing. The cards travel through it. -->
      <span class="story-rail-viewfinder" aria-hidden="true"></span>
      <RailControl
        {ui}
        {locale}
        {feedMode}
        {feedMenuOpen}
        ontogglemenu={() => (feedMenuOpen = !feedMenuOpen)}
        onselectmode={selectFeedMode}
      />
      <StoryRail {posts} {ui} {active} {visibleIndexes} onselect={(index) => {
        if (!visibleIndexes.includes(index)) return;
        goTo(index, { keepProgressIdle: true });
        progress?.resumeAfterManualNavigation();
      }} />
    </div>
    <StoryVisual
      post={activePost}
      {ui}
      {paused}
      muted={audioState.muted}
      autoplayMuted={audioState.videoAutoplayMuted}
      {overlayTick}
      {shareCopied}
      readingVisible={readingVisible}
      {gallerySubIndex}
      bind:video
      bind:audio
      bind:progressFill
      onwheel={handleWheel}
      soundPrompt={!soundChoiceMade && !readingVisible}
      ontoggleplay={() => {
        // The first tap on a stage that is still asking for sound answers that
        // question instead of pausing: on a video feed the tap is how people
        // unmute everywhere else, and pausing a silent clip is not what they
        // meant.
        if (!soundChoiceMade && activePost?.mediaType === "video") grantSound();
        else togglePause();
      }}
      onaudiotoggle={onAudioToggle}
      ongrantsound={grantSound}
      ontoggleread={() => setReading(!readingVisible)}
      onshare={share}
      onvideoplaying={onVideoPlaying}
      onvideotimeupdate={onVideoTimeUpdate}
      onvideoended={() => progress?.handleVideoEnded()}
      onvideowaiting={() => progress?.handleVideoWaiting()}
      onselectgallery={selectGalleryImage}
    />
    <StoryContext
      post={activePost}
      {ui}
      {updating}
      {expanded}
      {readMoreVisible}
      {readingVisible}
      {shareCopied}
      bind:copyEl
      ontogglereadmore={() => {
        expanded = !expanded;
        measureReadMore();
      }}
      onshare={share}
    />
  </div>
  {#if debugEnabled}
    <pre class="story-debug-panel">{JSON.stringify(
        {
          active,
          postId: activePost?.id,
          paused,
          manualPaused,
          mediaType: activePost?.mediaType,
          url: activePost?.url,
          gallerySubIndex,
          gallerySequenceLength: gallerySequence.length,
        },
        null,
        2,
      )}</pre>
  {/if}
</section>

<style>
  /* ---------------- Player grid (rail | stage | body text) ------------------ */
  .story-player {
    position: relative;
    display: grid;
    gap: 0;
  }

  .story-player__main {
    display: grid;
    grid-template-columns:
      minmax(250px, 370px)
      minmax(520px, calc((100dvh - 0.25rem) * 0.5625))
      minmax(360px, 560px);
    gap: clamp(0.5rem, 0.72vw, 0.85rem);
    align-items: center;
    justify-content: center;
    height: calc(100dvh - 0.25rem);
    min-height: 700px;
    max-height: calc(100dvh - 0.25rem);
  }

  /* ------------------ Rail container and card geometry ---------------------- */
  .story-rail-container {
    /* Rail geometry: a fixed number of visible cards with the active one
       centred (index 2). Everything below derives from these two values —
       change the card count or the gap only here. The variables are inherited
       by StoryRail.svelte. */
    --rail-cards: 5;
    --rail-gap: 0.55rem;
    --rail-card-height: calc((100% - (var(--rail-cards) - 1) * var(--rail-gap)) / var(--rail-cards));
    --rail-active-offset: calc(2 * (var(--rail-card-height) + var(--rail-gap)));
    /* An opaque dark backdrop, not decoration. Inactive rail cards are dimmed
     * with opacity: 0.38 (StoryRail.svelte), which only reads as "dimmed" when
     * something dark is behind them — on the light theme the page showed
     * through and the cards turned into grey slabs with white text on them.
     * Opacity cannot be fixed by the card's own background; the backdrop has to
     * sit underneath. */
    background: var(--player-backdrop);
    position: relative;
    grid-column: 1;
    height: 100%;
    min-height: 0;
    width: 100%;
    padding-left: 50px;
    display: flex;
    flex-direction: column;
    gap: 0;
  }

  /* The viewfinder. The rail's active slot is already fixed — the control is
   * pinned to it and the cards glide until the chosen one lands there — but
   * nothing said so, and the only cue that a card was the active one travelled
   * with the card. A frame that stays put turns the strip into a picker: this
   * is the slot, whatever is in it is what the stage is showing.
   *
   * It spans the control and the card as one shape, because they are one
   * shape: the control's right border is open so the two read as a single
   * bracket around the current story. Purely decorative, so it is inert and
   * takes no part in hit-testing. */
  .story-rail-viewfinder {
    position: absolute;
    z-index: var(--z-above);
    top: var(--rail-active-offset);
    /* Starts where the card does — the container reserves 50px on the left for
       the control, whose own border carries the bracket that far. */
    left: calc(50px + 0.05rem);
    right: 0.05rem;
    height: var(--rail-card-height);
    border: 1px solid var(--player-active-border);
    border-radius: 10px;
    box-shadow: var(--player-lift-soft);
    pointer-events: none;
  }

  /* The control (avatar + feed modes) lives in RailControl.svelte; its
     geometry derives from the --rail-* values above and is inherited there. */

  /* ------------------------- Debug panel (?debug=1) ------------------------- */
  .story-debug-panel {
    position: fixed;
    right: 12px;
    bottom: 12px;
    z-index: var(--z-debug);
    max-width: min(360px, calc(100vw - 24px));
    max-height: 48vh;
    overflow: auto;
    padding: 12px;
    border: 1px solid var(--overlay-debug-border);
    border-radius: 8px;
    background: var(--overlay-debug-surface);
    color: var(--overlay-debug-text);
    font: 12px / 1.45 var(--font-mono);
    white-space: pre-wrap;
  }

  /* ---- Compact desktop (short windows) ---- */
  @media (max-height: 800px) and (min-width: 1121px) {
    .story-player__main {
      height: calc(100vh - 0.75rem);
      min-height: 0;
    }
  }

  /* ---- Tablet (<=1120px): one column, rail horizontal underneath ---- */
  @media (max-width: 1120px) {
    .story-player__main {
      grid-template-columns: 1fr;
      height: auto;
      min-height: 0;
      max-height: none;
      gap: 1rem;
    }

    /* No viewfinder once the rail turns horizontal: there is no fixed slot to
       point at, the control sits above the strip rather than beside it. */
    .story-rail-viewfinder {
      display: none;
    }

    .story-rail-container {
      order: 3;
      width: min(100%, 720px);
      justify-self: center;
      height: auto;
      min-height: 0;
      flex-direction: row;
      flex-wrap: wrap;
      padding-left: 0;
    }
  }

  /* ---- Phone (<=760px): full-screen player, rail hidden ---- */
  @media (max-width: 760px) {
    .story-player {
      display: block;
    }

    .story-player__main {
      display: flex;
      flex-direction: column;
      gap: 0;
      width: 100%;
      min-height: 0;
      height: auto;
      max-height: none;
    }

    .story-rail-container {
      display: none;
    }
  }
</style>
