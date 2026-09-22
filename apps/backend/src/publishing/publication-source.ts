import * as z from "zod";

const mediaSchema = z.array(z.record(z.string(), z.unknown()));
/** A post after the first in a thread, in one language. */
const threadPartSchema = z.object({
  text: z.string(),
  entities: z.array(z.record(z.string(), z.unknown())),
  media: mediaSchema,
});

const localeSourceSchema = z.object({
  text: z.string(),
  entities: z.array(z.record(z.string(), z.unknown())),
  media: mediaSchema,
  storyMedia: mediaSchema,
  siteMedia: mediaSchema,
  slug: z.string(),
  publishAt: z.string().nullable(),
  siteEnabled: z.boolean(),
  thread: z.array(threadPartSchema),
});

const publicationSourceSchema = z.object({
  draftId: z.number().int().positive(),
  postId: z.number().int().positive(),
  targets: z.record(z.string(), z.boolean()),
  locales: z.object({ ru: localeSourceSchema, en: localeSourceSchema }),
});

export type PublicationLocaleSource = z.infer<typeof localeSourceSchema>;
export type PublicationSource = z.infer<typeof publicationSourceSchema>;

export function parsePublicationSource(value: unknown): PublicationSource {
  return publicationSourceSchema.parse(value);
}
