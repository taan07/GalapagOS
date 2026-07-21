import assert from "node:assert/strict";
import test from "node:test";
import {
  parseSlashCommand,
  rankSlashCommands,
  recordSlashCommandUse,
  slashCommandAutofill,
  slashCommandPrompt,
  slashMenuQuery,
} from "../src/core/slash-commands";

test("slash menu appears only while the leading command token is being typed", () => {
  assert.equal(slashMenuQuery("/"), "");
  assert.equal(slashMenuQuery("/rev"), "rev");
  assert.equal(slashMenuQuery("/review auth"), null);
  assert.equal(slashMenuQuery("please /review"), null);
});

test("parser recognizes canonical commands and aliases only at message start", () => {
  const canonical = parseSlashCommand("/review auth");
  assert.equal(canonical.kind, "command");
  if (canonical.kind === "command") {
    assert.equal(canonical.command.name, "review");
    assert.equal(canonical.args, "auth");
  }

  const alias = parseSlashCommand("/tasks");
  assert.equal(alias.kind, "command");
  if (alias.kind === "command") {
    assert.equal(alias.command.name, "workers");
    assert.equal(alias.invokedAs, "tasks");
  }

  assert.deepEqual(parseSlashCommand("/"), { kind: "incomplete" });
  assert.deepEqual(parseSlashCommand("/remote-control"), {
    kind: "unknown",
    name: "remote-control",
  });
  assert.deepEqual(parseSlashCommand("try /review"), { kind: "none" });
});

test("ranking filters by the typed token and learns personal popularity", () => {
  assert.deepEqual(
    rankSlashCommands("re").map((command) => command.name),
    ["review", "records", "status", "compact"],
  );
  const usage = recordSlashCommandUse(recordSlashCommandUse({}, "records"), "records");
  assert.equal(rankSlashCommands("", usage)[0]?.name, "records");
});

test("autofill preserves an argument space and prompt commands expand visibly", () => {
  const review = rankSlashCommands("review")[0];
  assert.ok(review);
  assert.equal(slashCommandAutofill(review), "/review ");

  const invocation = parseSlashCommand("/verify worker 2");
  assert.equal(invocation.kind, "command");
  if (invocation.kind === "command") {
    assert.match(slashCommandPrompt(invocation) ?? "", /worker 2/);
    assert.match(slashCommandPrompt(invocation) ?? "", /deterministic checks/);
  }
});
