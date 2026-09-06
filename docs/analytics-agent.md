[English](analytics-agent.md) · [Русский](analytics-agent.ru.md)

# Telling an agent how to read the numbers

[Operating a Studio from an agent](mcp.md) connects one. This is what to put in
its own instructions — `AGENTS.md`, `CLAUDE.md`, a system prompt — so that what
it says about a channel is worth acting on.

Copy what applies. Everything here is about a creator asking "how did the videos
do", answered by an agent that has this Studio's tools and a browser.

## Start with one command

`brief` is the whole picture in one call: the week against the one before it,
what took off, when and what to publish, which opening held viewers, what the
audience wrote, which words paid off, which platform carried a video further,
who is watching, and what the Studio is missing.

Every section of `brief` names the command that shows it in full. When the
creator asks "why", go to the named command rather than paraphrasing the
summary.

| Question | Command |
|---|---|
| Everything about the videos, with sample sizes | `video-report` |
| One video: every reading, its gains, its speed | `video-metrics --ref video:N` |
| What changed this week | `digest` |
| What is taking off right now | `outliers` |
| Where the same video did better | `platform-compare` |
| Which tags and hashtags pay off | `keywords` |
| Which games, which genres | `games` |
| What the comments are worth, not how many | `comments-quality` |
| The numbers and the comments read together | `review` |
| Who is watching: age, gender, countries | `audience-demographics` |
| When the audience is awake | `audience-heatmap` |
| A video stopped collecting and the cause is gone | `video-metrics-resume` |
| Is everything being collected | `status`, `doctor` |

## How to answer

**Read the `reading` block.** Every report carries one, and it says what its
numbers do not mean. It is written for this exact purpose.

**Never recommend on `confidence: anecdotal` or `low`.** Under five videos in a
slot, say so out loud: "too little data, this is not a finding". A slot flagged
`dominatedBySingleVideo` rests on one lucky video and is not a best hour.

**Keep a heatmap apart from a result.** A heatmap is a hypothesis about when
people are awake. Actual publications are evidence. When they disagree, believe
the publications and say which you are using.

**An empty metric can be broken collection.** `video-report` carries a
`collection` block: look there before reporting a zero.

**Answer in two parts.** First the short human conclusion and what to do about
it; then the figures with their sample sizes, for whoever wants to check.

## The opening of a video

This is the one block about a choice rather than an outcome, and on a feed-driven
platform it is the strongest lever a creator has. Views describe the feed; the
opening describes the video.

Two independent things are known about each video:

- **`openings.byShape`** — what was on screen two seconds in: a face, a split
  screen, or plain gameplay. Measured by arithmetic over the pixels of one
  frame, so it can say a large skin-toned region sits in the middle of the
  frame and cannot say whose face it is.
- **`openings.byKind`** — what kind the first spoken line is:
  - `question` — it asks the viewer something, or poses a puzzle;
  - `shock` — it states something extreme, alarming or absurd as fact;
  - `address` — it speaks to the viewer directly and asks them to do something;
  - `announcement` — it reports that a game exists, released or updated;
  - `callback` — it refers to a previous video or something the audience knows.

Both are laid against retention at three seconds and Instagram's skip rate.

**The kind is a model's judgement about ten words, not a measurement.** When a
finding rests on it, show the opening line beside the label so the creator can
disagree.

## What each platform will and will not say

These hold everywhere; the numbers behind them are your own.

- Retention above 100% is not an error: YouTube counts a rewatched second again.
- Instagram does not attribute a follow to a Reel. "This video brought
  subscribers" has no answer there, at all.
- Instagram publishes a skip rate for the first three seconds and nothing finer.
  YouTube publishes a full retention curve. They are not the same measurement.
- Totals across platforms mislead. Compare one video against itself with
  `platform-compare`, not one platform's sum against another's.
- Check `trafficSources` before advising on tags, and `subscribedStatus` before
  treating channel demographics as a video's audience. On a feed-driven channel
  search is a small fraction of the traffic, and most viewers are not
  subscribers — two different populations.

## What no API answers

**Heatmaps of when the audience is awake** exist only in YouTube Studio and
Instagram Insights. Read one in a browser and store it with
`audience-heatmap-import`, so it keeps the date it was taken on instead of being
lost after the conversation.

**New against returning viewers** and Instagram's follower breakdown are the
same: on screen only.

When you read something from a screen, say so in the answer and give the date,
and never mix it into a table of figures that came from the tools.

## What the Studio needs from the creator

Two fields are worth naming, because a report can only group by what is filled
in:

- **The script**, attached in the bot when a video is uploaded. Its first
  paragraph is the opening line every finding above is built from. Text pulled
  from captions is stored too, marked as heard rather than written — one is what
  was planned and the other is what a machine made of it.
- **The game**, so genre and player mode can be looked up and a hundred one-off
  titles become a handful of axes.

`video-report` reports the share of videos carrying each. Read it before ranking
anything by them.
