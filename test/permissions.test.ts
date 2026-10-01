import assert from "node:assert/strict";
import { test } from "node:test";
import { atLeast, Level, levelFor } from "../src/permissions.ts";

const SUPER = "111111111111111111";

test("the SUPER_ADMINISTRATOR from .env is a Super Administrator without being stored", () => {
	assert.equal(levelFor(SUPER, SUPER, undefined), Level.SuperAdministrator);
	assert.equal(levelFor(SUPER, SUPER, Level.Moderator), Level.SuperAdministrator);
});

test("stored levels are used for everybody else, and nobody stored is a customer", () => {
	assert.equal(levelFor("2", SUPER, Level.Moderator), Level.Moderator);
	assert.equal(levelFor("2", SUPER, Level.Administrator), Level.Administrator);
	assert.equal(levelFor("2", SUPER, null), Level.Customer);
	assert.equal(levelFor("2", "", null), Level.Customer, "an empty SUPER_ADMINISTRATOR makes nobody super");
	assert.equal(levelFor("", "", null), Level.Customer);
});

test("a higher level can do everything a lower one can", () => {
	assert.ok(atLeast(Level.SuperAdministrator, Level.Moderator));
	assert.ok(atLeast(Level.SuperAdministrator, Level.Administrator));
	assert.ok(atLeast(Level.Administrator, Level.Moderator));
	assert.ok(atLeast(Level.Moderator, Level.Moderator));
	assert.ok(!atLeast(Level.Moderator, Level.Administrator));
	assert.ok(!atLeast(Level.Administrator, Level.SuperAdministrator));
	assert.ok(!atLeast(Level.Customer, Level.Moderator));
});
