import { describe, it, expect } from "vitest";
import { createVersion } from "@yammer/core";
import { defaultSettings, type Version } from "@yammer/shared";
import { createTestDb, seedUser } from "../test-support";
import { DuplicateNameError, isUniqueViolation } from "./repos";
import { documents as documentsTable, versions as versionsTable } from "./schema";
import { eq } from "drizzle-orm";

async function nextVersion(
  repos: ReturnType<typeof createTestDb>["repos"],
  userId: string,
  documentId: string,
  newText: string,
): Promise<Version> {
  const parent = await repos.versions
    .listForDocument(userId, documentId)
    .then((vs) => vs[vs.length - 1]!);
  return createVersion({
    id: `v-${newText}`,
    createdAt: new Date().toISOString(),
    documentId,
    parent,
    author: "ai",
    kind: "edit",
    newText,
    summary: `set to ${newText}`,
  });
}

describe("UsersRepo", () => {
  it("creates a user with default settings and finds it by id and googleSub", async () => {
    const { repos } = createTestDb();
    const user = await repos.users.create({
      googleSub: "g-1",
      email: "a@b.c",
      name: "Ada",
    });
    expect(user.settings).toEqual(defaultSettings);
    expect((await repos.users.findById(user.id))?.email).toBe("a@b.c");
    expect((await repos.users.findByGoogleSub("g-1"))?.id).toBe(user.id);
    expect(await repos.users.findByGoogleSub("nope")).toBeNull();
  });
});

describe("DocumentsRepo", () => {
  it("creates a document with an empty seq-0 create version and reads it back", async () => {
    const { repos } = createTestDb();
    const user = await seedUser(repos);
    const doc = await repos.documents.create(user.id, { name: "Notes" });
    expect(doc.text).toBe("");
    expect(doc.currentSeq).toBe(0);

    const versions = await repos.versions.listForDocument(user.id, doc.id);
    expect(versions).toHaveLength(1);
    expect(versions[0]!.kind).toBe("create");
    expect(versions[0]!.seq).toBe(0);

    const fetched = await repos.documents.get(user.id, doc.id);
    expect(fetched?.name).toBe("Notes");
    expect(fetched?.currentVersionId).toBe(doc.currentVersionId);
  });

  it("lists documents sorted by name ascending and updated descending", async () => {
    const { repos } = createTestDb();
    const user = await seedUser(repos);
    const beta = await repos.documents.create(user.id, { name: "Beta" });
    await repos.documents.create(user.id, { name: "Alpha" });

    const byName = await repos.documents.list(user.id, "name");
    expect(byName.map((d) => d.name)).toEqual(["Alpha", "Beta"]);

    // Touch Beta so it becomes most-recently-updated.
    await repos.documents.rename(user.id, beta.id, "Beta2");
    const byUpdated = await repos.documents.list(user.id, "updated");
    expect(byUpdated[0]!.name).toBe("Beta2");
  });

  it("finds a document by name and renames it", async () => {
    const { repos } = createTestDb();
    const user = await seedUser(repos);
    const doc = await repos.documents.create(user.id, { name: "Draft" });
    expect((await repos.documents.findByName(user.id, "Draft"))?.id).toBe(doc.id);
    const renamed = await repos.documents.rename(user.id, doc.id, "Final");
    expect(renamed.name).toBe("Final");
    expect(await repos.documents.findByName(user.id, "Draft")).toBeNull();
  });

  it("rejects creating a case-insensitively duplicate name with DuplicateNameError", async () => {
    const { repos } = createTestDb();
    const user = await seedUser(repos);
    await repos.documents.create(user.id, { name: "Journal" });
    await expect(
      repos.documents.create(user.id, { name: "journal" }),
    ).rejects.toBeInstanceOf(DuplicateNameError);
    // The unique index is per-user: another user may reuse the same name.
    const other = await seedUser(repos);
    const otherDoc = await repos.documents.create(other.id, { name: "Journal" });
    expect(otherDoc.name).toBe("Journal");
  });

  it("auto-disambiguates nameless documents so 'new document' never collides", async () => {
    const { repos } = createTestDb();
    const user = await seedUser(repos);
    const a = await repos.documents.create(user.id, {});
    const b = await repos.documents.create(user.id, {});
    const c = await repos.documents.create(user.id, {});
    expect([a.name, b.name, c.name]).toEqual(["Untitled", "Untitled 2", "Untitled 3"]);
  });

  it("rejects renaming a document onto another document's name (case-insensitively)", async () => {
    const { repos } = createTestDb();
    const user = await seedUser(repos);
    await repos.documents.create(user.id, { name: "Journal" });
    const notes = await repos.documents.create(user.id, { name: "Notes" });
    await expect(
      repos.documents.rename(user.id, notes.id, "JOURNAL"),
    ).rejects.toBeInstanceOf(DuplicateNameError);
    // A case-only rename of a document onto ITS OWN name is allowed.
    const renamed = await repos.documents.rename(user.id, notes.id, "notes");
    expect(renamed.name).toBe("notes");
  });
});

describe("VersionsRepo append advances the document head", () => {
  it("appending a version updates the document's current text and seq", async () => {
    const { repos } = createTestDb();
    const user = await seedUser(repos);
    const doc = await repos.documents.create(user.id, { name: "Doc" });

    const v1 = await nextVersion(repos, user.id, doc.id, "hello");
    await repos.versions.append(user.id, v1);

    const after = await repos.documents.get(user.id, doc.id);
    expect(after?.text).toBe("hello");
    expect(after?.currentSeq).toBe(1);
    expect(after?.currentVersionId).toBe(v1.id);

    const history = await repos.versions.listForDocument(user.id, doc.id);
    expect(history.map((v) => v.seq)).toEqual([0, 1]);
  });

  it("refuses to append a version to a document owned by another user", async () => {
    const { repos } = createTestDb();
    const alice = await seedUser(repos);
    const bob = await seedUser(repos);
    const aliceDoc = await repos.documents.create(alice.id, { name: "Alice Doc" });

    const v = await nextVersion(repos, alice.id, aliceDoc.id, "hijack");
    // Bob tries to append against Alice's document -- the ownership assert throws
    // before any row is written.
    await expect(repos.versions.append(bob.id, v)).rejects.toThrow(/not found for this user/);
    expect((await repos.versions.listForDocument(alice.id, aliceDoc.id)).map((x) => x.seq)).toEqual([0]);
  });

  it("rejects a second version reusing a seq with a UNIQUE(document_id, seq) violation", async () => {
    const { repos } = createTestDb();
    const user = await seedUser(repos);
    const doc = await repos.documents.create(user.id, { name: "Doc" });

    const first = await nextVersion(repos, user.id, doc.id, "one");
    await repos.versions.append(user.id, first);

    // A different id reusing seq 1 (the concurrent-append race) must be rejected by
    // the unique constraint, detectable as a 23505 for the route to map to 409.
    const collision: Version = { ...first, id: "v-collision", fullText: "two" };
    let caught: unknown;
    try {
      await repos.versions.append(user.id, collision);
    } catch (e) {
      caught = e;
    }
    expect(isUniqueViolation(caught)).toBe(true);
    // The losing append wrote nothing: history + head are unchanged.
    expect((await repos.versions.listForDocument(user.id, doc.id)).map((v) => v.seq)).toEqual([0, 1]);
    expect((await repos.documents.get(user.id, doc.id))?.currentVersionId).toBe(first.id);
  });
});

describe("write atomicity (version append + document create)", () => {
  it("append is atomic: a fault on the head-advance rolls the version insert back too (no bricked doc)", async () => {
    // Fail ONLY the head-advance UPDATE. The version INSERT runs first inside the
    // same transaction; if the pair were not atomic the version would persist while
    // the head never moved -- bricking the doc (every future seq-1 append would then
    // hit UNIQUE(doc,seq) forever). The transaction must roll the insert back too.
    const { db, repos } = createTestDb({
      failOn: (sql) =>
        sql.toLowerCase().includes('update "documents"') &&
        sql.includes("current_version_id"),
    });
    const user = await seedUser(repos);
    const doc = await repos.documents.create(user.id, { name: "Doc" });
    const v1 = await nextVersion(repos, user.id, doc.id, "hello");

    await expect(repos.versions.append(user.id, v1)).rejects.toThrow(
      /injected write fault/,
    );

    // Neither write survived: no seq-1 version row, and the head still points at the
    // seq-0 create version -- the document is intact, not bricked.
    expect(
      (await repos.versions.listForDocument(user.id, doc.id)).map((v) => v.seq),
    ).toEqual([0]);
    expect(await repos.versions.get(user.id, v1.id)).toBeNull();
    const head = await repos.documents.get(user.id, doc.id);
    expect(head?.currentSeq).toBe(0);
    expect(head?.currentVersionId).toBe(doc.currentVersionId);
  });

  it("document create is atomic: a fault on the seq-0 version insert rolls the document row back", async () => {
    // Fail the version INSERT (the second write). The document row is inserted first;
    // if the pair were not atomic a doc row would survive with a currentVersionId
    // pointing at a version that was never written -- reads would 500 forever.
    const { db, repos } = createTestDb({
      failOn: (sql) => sql.toLowerCase().includes('insert into "versions"'),
    });
    const user = await seedUser(repos);

    await expect(
      repos.documents.create(user.id, { name: "Doc" }),
    ).rejects.toThrow(/injected write fault/);

    // Neither the document row nor its seq-0 version persisted -- rolled back together.
    expect(await repos.documents.list(user.id, "updated")).toEqual([]);
    expect(await repos.documents.findByName(user.id, "Doc")).toBeNull();
    expect(
      await db.select().from(documentsTable).where(eq(documentsTable.name, "Doc")),
    ).toEqual([]);
    expect(await db.select().from(versionsTable)).toEqual([]);
  });
});

describe("TurnsRepo", () => {
  it("appends turns and lists them oldest-first for a document", async () => {
    const { repos } = createTestDb();
    const user = await seedUser(repos);
    const doc = await repos.documents.create(user.id, { name: "Doc" });

    await repos.turns.append(user.id, {
      id: "t1",
      userId: user.id,
      documentId: doc.id,
      createdAt: "2026-01-01T00:00:00.000Z",
      transcript: "add a title",
      sttMeta: { seconds: 2 },
      llmModel: "gpt-5.6-luna",
      llmRawResponse: { ok: true },
      actions: [{ type: "insert_text" }],
      chatMessage: "done",
      usage: { sttSeconds: 2, inputTokens: 100, cachedInputTokens: 0, outputTokens: 20 },
    });

    const turns = await repos.turns.listForDocument(user.id, doc.id);
    expect(turns).toHaveLength(1);
    expect(turns[0]!.transcript).toBe("add a title");
    expect(turns[0]!.usage.inputTokens).toBe(100);
    expect(turns[0]!.actions).toEqual([{ type: "insert_text" }]);
  });
});

describe("SettingsRepo", () => {
  it("reads defaults and persists an update", async () => {
    const { repos } = createTestDb();
    const user = await seedUser(repos);
    expect(await repos.settings.get(user.id)).toEqual(defaultSettings);

    const updated = { ...defaultSettings, theme: "dark" as const, sfxEnabled: false };
    await repos.settings.update(user.id, updated);
    expect((await repos.settings.get(user.id)).theme).toBe("dark");
    expect((await repos.settings.get(user.id)).sfxEnabled).toBe(false);
  });
});

describe("per-user isolation (a hard invariant)", () => {
  it("scopes documents, versions, turns, and settings to their owner", async () => {
    const { repos } = createTestDb();
    const alice = await seedUser(repos, { name: "Alice" });
    const bob = await seedUser(repos, { name: "Bob" });

    const aliceDoc = await repos.documents.create(alice.id, { name: "Alice Doc" });
    await repos.versions.append(
      alice.id,
      await nextVersion(repos, alice.id, aliceDoc.id, "secret text"),
    );
    await repos.turns.append(alice.id, {
      id: "at1",
      userId: alice.id,
      documentId: aliceDoc.id,
      createdAt: "2026-01-01T00:00:00.000Z",
      transcript: "alice only",
      sttMeta: null,
      llmModel: "gpt-5.6-luna",
      llmRawResponse: null,
      actions: [],
      usage: { sttSeconds: 0, inputTokens: 0, cachedInputTokens: 0, outputTokens: 0 },
    });

    // Bob sees none of Alice's data.
    expect(await repos.documents.list(bob.id, "updated")).toEqual([]);
    expect(await repos.documents.get(bob.id, aliceDoc.id)).toBeNull();
    expect(await repos.documents.findByName(bob.id, "Alice Doc")).toBeNull();
    expect(await repos.versions.listForDocument(bob.id, aliceDoc.id)).toEqual([]);
    expect(await repos.turns.listForDocument(bob.id, aliceDoc.id)).toEqual([]);
    expect(await repos.versions.get(bob.id, `v-secret text`)).toBeNull();

    // Alice still sees her own.
    expect((await repos.documents.get(alice.id, aliceDoc.id))?.text).toBe("secret text");
    expect(await repos.turns.listForDocument(alice.id, aliceDoc.id)).toHaveLength(1);
  });

  it("does not let one user rename another user's document", async () => {
    const { repos } = createTestDb();
    const alice = await seedUser(repos);
    const bob = await seedUser(repos);
    const doc = await repos.documents.create(alice.id, { name: "Alice Doc" });

    await expect(repos.documents.rename(bob.id, doc.id, "Hijacked")).rejects.toThrow();
    expect((await repos.documents.get(alice.id, doc.id))?.name).toBe("Alice Doc");
  });
});
