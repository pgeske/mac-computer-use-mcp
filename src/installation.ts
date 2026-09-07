import { execFile } from "node:child_process";
import { access, realpath } from "node:fs/promises";
import { userInfo } from "node:os";
import path from "node:path";
import { promisify } from "node:util";

const exec = promisify(execFile);
const teamId = "2DC432GLL2";

export interface Installation {
  app: string;
  codex: string;
  client: string;
  runtime: string;
  version: string;
}

export async function verifySignature(binary: string): Promise<void> {
  await exec("/usr/bin/codesign", ["--verify", "--strict", binary], {
    timeout: 10_000,
  });
  const { stderr } = await exec(
    "/usr/bin/codesign",
    ["-dv", "--verbose=2", binary],
    { timeout: 10_000 },
  );
  if (!stderr.split("\n").includes(`TeamIdentifier=${teamId}`))
    throw new Error("Expected an OpenAI-signed executable");
}

export async function findInstallation(
  preferred?: string,
): Promise<Installation> {
  if (process.platform !== "darwin")
    throw new Error(
      "Computer Use requires macOS and an unlocked graphical login session",
    );
  const apps = preferred
    ? [preferred]
    : ["/Applications/ChatGPT.app", "/Applications/Codex.app"];
  for (const candidate of apps) {
    const app = path.resolve(candidate);
    const codex = path.join(app, "Contents/Resources/codex");
    try {
      await access(codex);
    } catch {
      continue;
    }
    // Never silently fall back from an installed executable that fails verification.
    await verifySignature(codex);
    const runtime = path.join(
      userInfo().homedir,
      ".codex/computer-use/Codex Computer Use.app",
    );
    const client = path.join(
      runtime,
      "Contents/SharedSupport/SkyComputerUseClient.app/Contents/MacOS/SkyComputerUseClient",
    );
    try {
      await access(client);
    } catch {
      throw new Error(
        "Install Computer Use through the official ChatGPT/Codex app first; its signed client is missing",
      );
    }
    if ((await realpath(client)) !== client)
      throw new Error("The Computer Use client path must not contain symlinks");
    await verifySignature(client);
    await verifySignature(runtime);
    const { stdout } = await exec(codex, ["--version"], { timeout: 10_000 });
    return { app, codex, client, runtime, version: stdout.trim() };
  }
  throw new Error(
    "No supported ChatGPT.app or Codex.app found. Use --app /path/to/the/official.app",
  );
}
