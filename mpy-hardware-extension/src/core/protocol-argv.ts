// Argv flag reading shared by the loop's guards.
//
// argparse accepts `--flag value` AND `--flag=value`, and the models emit both (protocol-build's
// path correction already splits the `=` form). Every guard that reads a flag must see both
// spellings, or a model is refused for the very thing it did: an upload carrying
// `--output-json=upload_summary.json` was refused as evidence-less, and a select-hw gate run with
// `--compare-manifest=x` never recorded a verdict, so its honest success was refused forever.

export function splitFlag(arg: string): { flag: string; value: string | undefined } {
  if (!arg.startsWith("-")) return { flag: arg, value: undefined };
  const eq = arg.indexOf("=");
  return eq > 0 ? { flag: arg.slice(0, eq), value: arg.slice(eq + 1) } : { flag: arg, value: undefined };
}

export function hasFlag(args: readonly string[], flag: string): boolean {
  return args.some((a) => splitFlag(a).flag === flag);
}

/** Every value given to `flag`, in argv order, whichever spelling. A trailing bare flag yields nothing. */
export function flagValues(args: readonly string[], flag: string): string[] {
  const values: string[] = [];
  for (let i = 0; i < args.length; i++) {
    const s = splitFlag(args[i]);
    if (s.flag !== flag) continue;
    const value = s.value ?? args[i + 1];
    if (value !== undefined) values.push(value);
  }
  return values;
}

/** The first value given to `flag`, or undefined. */
export function flagValue(args: readonly string[], flag: string): string | undefined {
  return flagValues(args, flag)[0];
}
