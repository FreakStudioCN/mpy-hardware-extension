// Which database a test is allowed to write to.
//
// The api contract suite spawns the real API and writes real rows -- a user, a session, a daily
// credit grant -- and cleans up none of them. For a long time it could not run on a developer
// machine at all: it resolved python off PATH, and a PATH python cannot import uvicorn, so it
// always skipped whatever the environment said. That accident was the only thing keeping it off
// dev databases, and fixing the interpreter resolution removed it.
//
// So the rule is explicit now, and it lives here rather than inline because a rule with no test is
// the thing that quietly stops holding.
export const TEST_DATABASE_HINT = "point MPYHW_TEST_DATABASE_URL at a test database";

/**
 * The database name in a postgres URL, or null when there is not one to read.
 *
 * Null for a URL this cannot parse, which is deliberate: a URL it cannot read is one it cannot
 * vouch for, and the caller refuses on null. Reading the name with `new URL` directly turned a
 * malformed DATABASE_URL into an ERR_INVALID_URL at import, failing the suite instead of skipping
 * it -- an env var typo read as a broken test.
 */
export function databaseName(url: string | undefined | null): string | null {
  if (!url) return null;
  // Characters the URL parser normalizes away but libpq keeps, so the name we would vouch for is
  // not the name it would connect to. libpq has no fragment concept -- `#` is an ordinary dbname
  // character -- and it preserves tabs and newlines that `new URL` silently strips. Differential
  // testing against psycopg found no case where this lets a REAL database through (the literal
  // "test" word survives either way, so libpq ends up with our name plus junk, which is a
  // database nobody has). Refused anyway: two conditions turn a class we would have to keep
  // arguing about into one that cannot arise.
  if (/[\t\n\r]/.test(url)) return null;
  try {
    const parsed = new URL(url);
    if (parsed.hash !== "") return null;
    // `dbname` in the query string WINS over the path, and the LAST dbname wins over earlier ones,
    // because that is what libpq does and this has to name the database the server will actually
    // connect to rather than the one the URL appears to name. Both halves were learned the hard
    // way against psycopg's own parser: `postgresql://h/mpyhw_test?dbname=mpyhw` connects to mpyhw,
    // and so does `...?dbname=mpyhw_test&dbname=mpyhw`, where reading only the FIRST value is
    // wrong in exactly the same direction as reading only the path was.
    //
    // An empty last value returns null rather than falling back to the path: libpq stores the
    // empty string and then defaults the database to the USERNAME, so the path is not what gets
    // connected to and vouching for it would be a guess.
    const declared = parsed.searchParams.getAll("dbname");
    const name = declared.length ? declared[declared.length - 1] : parsed.pathname.replace(/^\//, "");
    return name || null;
  } catch {
    return null;
  }
}

/**
 * Whether a database name says, in its own name, that it is a test database.
 *
 * Delimited on both sides so a name only qualifies when "test" is a WORD in it: `mpyhw_test`,
 * `test_mpyhw`, `ci_test` and `my-test-db` qualify, while `protest`, `detest`, `latest`,
 * `testing` and plain `mpyhw` do not. Refusing is the safe direction, so anything ambiguous
 * falls on the refusing side.
 */
export function isTestScopedDatabase(name: string | null): boolean {
  return !!name && /(^|[_-])test([_-]|$)/i.test(name);
}
