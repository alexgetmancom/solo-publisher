import { describe, expect, it } from "bun:test";
import { readFeedSkill, skillDigest } from "../server/agent-skill";
import { GET as agentSkillsIndex } from "./.well-known/agent-skills/index.json";
import { GET as skillDocument } from "./.well-known/agent-skills/read-feed/SKILL.md";
import { GET as apiCatalog } from "./.well-known/api-catalog";
import { GET as mcpServerCard } from "./.well-known/mcp/server-card.json";
import { GET as authorizationServer } from "./.well-known/oauth-authorization-server";
import { GET as protectedResource } from "./.well-known/oauth-protected-resource";
import { telegramToSearchItems } from "./search-index.json";

const context = { site: new URL("https://studio.example.com") } as never;

async function json(response: Response | Promise<Response>): Promise<Record<string, unknown>> {
  return (await (await response).json()) as Record<string, unknown>;
}

describe("discovery documents", () => {
  it("names the install's own origin rather than the canonical deployment", async () => {
    // These documents used to be static files carrying alexgetman.com in every
    // href, which made them wrong for every install but one.
    const catalog = await json(apiCatalog(context));
    const resource = await json(protectedResource(context));
    const issuer = await json(authorizationServer(context));
    const card = await json(mcpServerCard(context));

    expect(JSON.stringify(catalog)).toContain("https://studio.example.com/openapi.json");
    expect(JSON.stringify(catalog)).not.toContain("alexgetman.com");
    expect(resource.resource).toBe("https://studio.example.com");
    expect(resource.authorization_servers).toEqual(["https://studio.example.com"]);
    expect(issuer.issuer).toBe("https://studio.example.com");
    expect(card.description).toContain("studio.example.com");
  });

  it("hashes the skill body it actually serves", async () => {
    // The digest was a literal in a hand-edited file. Any edit to the skill left
    // it stale, and a client that verifies would reject a document that is fine.
    const body = await (await skillDocument(context)).text();
    const index = (await json(agentSkillsIndex(context))) as { skills: { digest: string; url: string }[] };

    expect(body).toBe(readFeedSkill("https://studio.example.com"));
    expect(index.skills[0]?.digest).toBe(skillDigest(body));
    expect(index.skills[0]?.url).toBe("/.well-known/agent-skills/read-feed/SKILL.md");
  });
});

describe("search index", () => {
  it("attributes an entry to the host that served it", () => {
    // Every entry carried a literal alexgetman.com, so a self-hosted Studio
    // published a search index crediting somebody else for its own posts.
    const item = {
      post_id: 7,
      date: "2026-01-01T00:00:00.000Z",
      has_en: true,
      has_ru: false,
      text_en: "A headline. And the body that follows it.",
      slug_en: "a-headline",
      entities: [],
    } as never;

    const entries = telegramToSearchItems(item, "studio.example.com");

    expect(entries).toHaveLength(1);
    expect(entries[0]?.source).toBe("studio.example.com");
    expect(JSON.stringify(entries)).not.toContain("alexgetman.com");
  });
});
