/**
 * `playbook actions ...`: the original playbook's argument parsing for its `actions`
 * subcommand (Python argparse, at its default 80-column width): the same help, the
 * same refusals with exit 2, abbreviations (`--ba X`), `--opt=value`, and the
 * unrecognized arguments refused by the top-level parser.
 */
import { runActionsRequired, type ActionsIo } from "./actionsRequired.ts";
import { pyRepr } from "./pyValues.ts";

const MODES = ["merge-gate", "evidence", "all"];

const TOP_USAGE = `usage: playbook [-h] [-C DIR]
                {init,doctor,check,up,db-dict,intent-diff,intent-audit,amend,ci-files,snapshot,minimal,map,challenge,storage,actions,review-model,stats,version} ...`;

const ACTIONS_USAGE = "usage: playbook actions [-h] {required} ...";
const ACTIONS_HELP = `${ACTIONS_USAGE}

positional arguments:
  {required}
    required  the walks the tree must run against a base, one name per line

options:
  -h, --help  show this help message and exit`;

const REQUIRED_USAGE = `usage: playbook actions required [-h] [--base BASE]
                                 [--mode {merge-gate,evidence,all}]`;
const REQUIRED_HELP = `${REQUIRED_USAGE}

options:
  -h, --help            show this help message and exit
  --base BASE           the base ref (default: the gate's base)
  --mode {merge-gate,evidence,all}
                        which measuredBy mode to select (default: merge-gate
                        when declared, else evidence)`;

class Exit {
  readonly code: number;
  constructor(code: number) {
    this.code = code;
  }
}

type Token =
  | { readonly kind: "A"; readonly text: string }
  | { readonly kind: "sep"; readonly text: string }
  | {
      readonly kind: "O";
      readonly text: string;
      readonly opt: string | null;
      readonly explicit: string | null;
    };

/** Python 3.14 argparse: an argument that starts like a negative number is a value. */
const NEGATIVE = /^-\.?\d/;

/** argparse's reading of one argument against a parser's long options (and -h). */
function classify(arg: string, longs: ReadonlyArray<string>): Token {
  if (arg === "--") return { kind: "sep", text: arg };
  if (!arg.startsWith("-") || arg === "-") return { kind: "A", text: arg };
  if (arg === "-h" || longs.includes(arg))
    return { kind: "O", text: arg, opt: arg, explicit: null };
  if (arg.includes("=")) {
    const at = arg.indexOf("=");
    const name = arg.slice(0, at);
    if (name === "-h" || longs.includes(name)) {
      return { kind: "O", text: arg, opt: name, explicit: arg.slice(at + 1) };
    }
  }
  if (arg.startsWith("--")) {
    const at = arg.indexOf("=");
    const prefix = at < 0 ? arg : arg.slice(0, at);
    const hits = longs.filter((o) => o.startsWith(prefix));
    if (hits.length === 1) {
      return { kind: "O", text: arg, opt: hits[0]!, explicit: at < 0 ? null : arg.slice(at + 1) };
    }
  } else if (arg.startsWith("-h")) {
    return { kind: "O", text: arg, opt: "-h", explicit: null };
  }
  if (NEGATIVE.test(arg) || arg.includes(" ")) return { kind: "A", text: arg };
  return { kind: "O", text: arg, opt: null, explicit: null };
}

interface Parsed {
  base: string | null;
  mode: string | null;
}

/** The arguments after `actions`, as argparse takes them; throws Exit after printing help or a refusal. */
function parse(args: ReadonlyArray<string>, io: ActionsIo): Parsed {
  const fail = (usage: string, prog: string, msg: string): never => {
    io.err(`${usage}\n${prog}: error: ${msg}`);
    throw new Exit(2);
  };
  const extras: string[] = [];
  let i = 0;
  let afterSep = false;
  let cmd: string | null = null;
  for (; i < args.length; i += 1) {
    const tok = afterSep
      ? ({ kind: "A", text: args[i]! } as const)
      : classify(args[i]!, ["--help"]);
    if (tok.kind === "sep") {
      afterSep = true;
      continue;
    }
    if (tok.kind === "A") {
      cmd = tok.text;
      i += 1;
      break;
    }
    if (tok.opt === null) {
      extras.push(tok.text);
      continue;
    }
    if (tok.explicit !== null) {
      fail(
        ACTIONS_USAGE,
        "playbook actions",
        `argument -h/--help: ignored explicit argument ${pyRepr(tok.explicit)}`,
      );
    }
    io.out(ACTIONS_HELP);
    throw new Exit(0);
  }
  if (cmd === null)
    fail(ACTIONS_USAGE, "playbook actions", "the following arguments are required: actions_cmd");
  if (cmd !== "required") {
    fail(
      ACTIONS_USAGE,
      "playbook actions",
      `argument actions_cmd: invalid choice: ${pyRepr(cmd)} (choose from required)`,
    );
  }
  const out: Parsed = { base: null, mode: null };
  const fails = (msg: string) => fail(REQUIRED_USAGE, "playbook actions required", msg);
  const longs = ["--help", "--base", "--mode"];
  let rest = false;
  for (; i < args.length; i += 1) {
    const arg = args[i]!;
    if (rest) {
      extras.push(arg);
      continue;
    }
    const tok = classify(arg, longs);
    if (tok.kind === "sep") {
      rest = true;
      extras.push(arg);
      continue;
    }
    if (tok.kind === "A" || tok.opt === null) {
      extras.push(tok.text);
      continue;
    }
    if (tok.opt === "-h" || tok.opt === "--help") {
      if (tok.explicit !== null)
        fails(`argument -h/--help: ignored explicit argument ${pyRepr(tok.explicit)}`);
      io.out(REQUIRED_HELP);
      throw new Exit(0);
    }
    let value = tok.explicit;
    if (value === null) {
      const next = args[i + 1];
      if (next === undefined || classify(next, longs).kind !== "A")
        fails(`argument ${tok.opt}: expected one argument`);
      value = next!;
      i += 1;
    }
    if (tok.opt === "--mode") {
      if (!MODES.includes(value)) {
        fails(
          `argument --mode: invalid choice: ${pyRepr(value)} (choose from ${MODES.join(", ")})`,
        );
      }
      out.mode = value;
    } else out.base = value;
  }
  if (extras.length > 0) fail(TOP_USAGE, "playbook", `unrecognized arguments: ${extras.join(" ")}`);
  return out;
}

/**
 * `playbook actions` with ARGS (after the subcommand); its exit code. ROOT is asked only
 * once the arguments parse, as the original checks -C DIR after parsing; null: it refused.
 */
export async function cmdActions(
  args: ReadonlyArray<string>,
  io: ActionsIo,
  root: () => string | null,
): Promise<number> {
  let parsed: Parsed;
  try {
    parsed = parse(args, io);
  } catch (cause) {
    if (cause instanceof Exit) return cause.code;
    throw cause;
  }
  const dir = root();
  if (dir === null) return 2;
  return runActionsRequired(dir, parsed.base, parsed.mode, io);
}
