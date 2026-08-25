import assert from "node:assert/strict";
import test from "node:test";

import { databaseName, isTestScopedDatabase } from "./test-database.ts";

// This rule is what stands between an exported dev DATABASE_URL and rows written into the dev
// database by the api contract suite, which creates a user, a session and a credit grant and
// cleans up none of it. It was verified by hand once, across four environments, and that
// verification evaporated with the session that did it. Asserted as properties rather than a
// handful of examples, because the failure that matters is a name wrongly ACCEPTED.

test("a name only counts as a test database when test is a delimited word in it", () => {
  for (const name of ["mpyhw_test", "test_mpyhw", "ci_test", "my-test-db", "test-db", "test"]) {
    assert.equal(isTestScopedDatabase(name), true, `${name} should count`);
  }
  // The dangerous direction. "protest" and "latest" merely contain the letters; "testing" is a
  // word of its own; "mpyhw" and "mpyhw_production" are the real thing.
  for (const name of ["mpyhw", "mpyhw_production", "protest", "detest", "latest", "contest", "testing"]) {
    assert.equal(isTestScopedDatabase(name), false, `${name} must NOT count`);
  }
});

test("case does not let a database through", () => {
  assert.equal(isTestScopedDatabase("MPYHW"), false);
  assert.equal(isTestScopedDatabase("MPYHW_TEST"), true, "an uppercase test database is still one");
});

// The parse is the other half: anything unreadable has to fail toward refusing, and it has to do
// that by RETURNING, not throwing. Reading the name with `new URL` directly made a malformed
// DATABASE_URL an ERR_INVALID_URL at import, which failed the suite instead of skipping it.
test("an unreadable or nameless URL yields no name, and never throws", () => {
  for (const url of ["not-a-url", "", "   ", "postgresql://host", "postgresql://host/", "://", "postgres@@", undefined, null]) {
    let name: string | null = "unset";
    assert.doesNotThrow(() => { name = databaseName(url as any); }, `threw on ${JSON.stringify(url)}`);
    assert.equal(name, null, `${JSON.stringify(url)} should yield no name`);
  }
});

test("a readable URL yields the database name the server will connect to", () => {
  assert.equal(databaseName("postgresql://u:p@127.0.0.1:55432/mpyhw_test"), "mpyhw_test");
  assert.equal(databaseName("postgresql://u:p@127.0.0.1:55432/mpyhw"), "mpyhw");
  // An unrelated query param leaves the path alone.
  assert.equal(databaseName("postgresql://u:p@h:5432/mpyhw_test?sslmode=require"), "mpyhw_test");
});

// The name that matters is the one the SERVER connects to, and libpq lets the query string
// override the path. A URL that disagrees with itself is the one case where reading the obvious
// half makes the guard confidently wrong: this URL looks test-scoped and connects to the dev
// database. Verified against psycopg's own parser before writing it down.
test("dbname in the query string wins over the path, as libpq does", () => {
  assert.equal(databaseName("postgresql://h/mpyhw_test?dbname=mpyhw"), "mpyhw");
  assert.equal(isTestScopedDatabase(databaseName("postgresql://h/mpyhw_test?dbname=mpyhw")), false,
    "a URL whose real database is the dev one must be refused however the path is spelled");
  // And the other direction still works: dbname naming a test database is honoured.
  assert.equal(databaseName("postgresql://h/mpyhw?dbname=mpyhw_test"), "mpyhw_test");
});

// The same trick one step out, and the reason the first version of this fix was not enough:
// libpq keeps the LAST dbname, while URLSearchParams.get returns the FIRST. Reading the first
// value is wrong in exactly the direction reading the path was -- the URL looks test-scoped and
// the server connects to the dev database.
test("the last dbname wins, as libpq does, not the first", () => {
  assert.equal(databaseName("postgresql://h/mpyhw_test?dbname=mpyhw_test&dbname=mpyhw"), "mpyhw");
  assert.equal(
    isTestScopedDatabase(databaseName("postgresql://h/mpyhw_test?dbname=mpyhw_test&dbname=mpyhw")),
    false,
    "a repeated dbname must not let the dev database through",
  );
});

// An empty dbname is not "no dbname": libpq stores it and then defaults the database to the
// USERNAME, so the path is not what gets connected to. Returning the path there would vouch for
// a name the server will not use, so this refuses instead.
test("an empty dbname refuses rather than falling back to the path", () => {
  assert.equal(databaseName("postgresql://h/mpyhw_test?dbname="), null);
  assert.equal(isTestScopedDatabase(databaseName("postgresql://h/mpyhw_test?dbname=")), false);
});

// The last class, closed by refusing rather than by argument. `new URL` drops a fragment and
// strips tabs and newlines; libpq does neither, so the name we read is not the name it connects
// to. Differential testing found no case where a REAL database slips through this way, because
// the literal "test" survives the normalisation either side -- but a guard that has to explain
// why its divergences are harmless is one bad assumption from being wrong again.
test("a URL the parser would normalise is refused, not vouched for", () => {
  assert.equal(databaseName("postgresql://h/mpyhw_test#frag"), null, "libpq would connect to mpyhw_test#frag");
  assert.equal(databaseName("postgresql://h/db?dbname=mpyhw_test#junk"), null);
  assert.equal(databaseName("postgresql://h/mpy\thw_test"), null, "libpq keeps the tab, the URL parser drops it");
  assert.equal(databaseName("postgresql://h/mpyhw_test\n"), null);
  // The ordinary URL is untouched by any of this.
  assert.equal(databaseName("postgresql://h/mpyhw_test"), "mpyhw_test");
});

// The two composed, which is how the caller uses them: no name means refuse.
test("an unreadable URL is refused rather than trusted", () => {
  assert.equal(isTestScopedDatabase(databaseName("not-a-url")), false);
  assert.equal(isTestScopedDatabase(databaseName("postgresql://host/")), false);
  assert.equal(isTestScopedDatabase(databaseName("postgresql://h/mpyhw")), false);
  assert.equal(isTestScopedDatabase(databaseName("postgresql://h/mpyhw_test")), true);
});
