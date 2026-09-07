export interface Options {
  app?: string;
  trustedApps: Set<string>;
  readOnly: boolean;
  idleMs: number;
}

export const bundleIdPattern = /^[A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)+$/;

export function parseOptions(args: string[]): Options {
  const options: Options = {
    trustedApps: new Set(),
    readOnly: false,
    idleMs: 300_000,
  };
  for (let index = 0; index < args.length; index++) {
    const arg = args[index];
    if (arg === "--read-only") options.readOnly = true;
    else if (
      arg === "--app" ||
      arg === "--trust-app" ||
      arg === "--idle-seconds"
    ) {
      const value = args[++index];
      if (!value || value.startsWith("--"))
        throw new Error(`Missing value for ${arg}`);
      if (arg === "--app") options.app = value;
      else if (arg === "--trust-app") {
        if (!bundleIdPattern.test(value))
          throw new Error(
            "--trust-app requires an exact bundle identifier, not a name, path, or wildcard",
          );
        options.trustedApps.add(value);
      } else {
        const seconds = Number(value);
        if (!Number.isInteger(seconds) || seconds < 10 || seconds > 3600)
          throw new Error("--idle-seconds must be between 10 and 3600");
        options.idleMs = seconds * 1000;
      }
    } else throw new Error(`Unknown option: ${arg}`);
  }
  return options;
}
