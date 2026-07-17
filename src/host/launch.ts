/**
 * Manual launch runs the bridge and stock ChatGPT together without installing
 * persistent state. ChatGPT keeps its own logs; bridge output stays here.
 */

import { spawn, execFile } from "node:child_process";
import { randomBytes } from "node:crypto";
import { chmod, lstat, mkdtemp, rm } from "node:fs/promises";
import { createConnection } from "node:net";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);
export const CHATGPT_APP_BUNDLE_ENV = "CODEX_MINILAB_CHATGPT_APP";

interface ManualLaunchOptions {
  configPath?: string;
  chatGPTPath?: string;
  appArguments?: string[];
}

export async function launchChatGPT(options: ManualLaunchOptions = {}): Promise<number> {
  if (process.platform !== "darwin") throw new Error("codex-midi launch is supported only on macOS");
  const root = fileURLToPath(new URL("../../", import.meta.url));
  const cli = fileURLToPath(new URL("../cli.ts", import.meta.url));
  const preload = resolve(root, "shim/chatgpt-preload.cjs");
  const chatGPT = resolve(
    options.chatGPTPath ??
      process.env.CHATGPT_BIN ??
      "/Applications/ChatGPT.app/Contents/MacOS/ChatGPT",
  );
  const chatGPTBundle = applicationBundleForExecutable(chatGPT);
  await requireSafeFile(preload);
  await requireExecutable(chatGPT);
  if (await executableIsRunning(chatGPT)) {
    throw new Error("ChatGPT is already running. Quit it completely before using codex-minilab3 launch.");
  }

  const runtime = await mkdtemp(join(tmpdir(), "codex-midi-"));
  await chmod(runtime, 0o700);
  const socket = join(runtime, "project2077.sock");
  const token = randomBytes(32).toString("hex");
  const bridgeArguments = [cli, "bridge", "--socket", socket];
  if (options.configPath !== undefined) bridgeArguments.push("--config", resolve(options.configPath));

  const bridgeEnvironment: NodeJS.ProcessEnv = {
    ...process.env,
    CODEX_MIDI_TOKEN: token,
    [CHATGPT_APP_BUNDLE_ENV]: chatGPTBundle,
  };
  delete bridgeEnvironment.NODE_OPTIONS;
  const bridge = spawn(process.execPath, bridgeArguments, {
    cwd: root,
    env: bridgeEnvironment,
    stdio: "inherit",
  });
  let chatGPTLauncher: ReturnType<typeof spawn> | undefined;
  let interrupted = false;
  let terminateChatGPT = false;
  const stopChildren = () => {
    chatGPTLauncher?.kill("SIGTERM");
    bridge.kill("SIGTERM");
  };
  const onSignal = () => {
    interrupted = true;
    terminateChatGPT = chatGPTLauncher !== undefined;
    stopChildren();
  };
  process.once("SIGINT", onSignal);
  process.once("SIGTERM", onSignal);

  try {
    try {
      await waitForSocket(socket, bridge);
    } catch (error) {
      if (interrupted) return 0;
      throw error;
    }
    if (interrupted) return 0;
    const managedRequire = `--require=${JSON.stringify(preload)}`;
    chatGPTLauncher = spawn("/usr/bin/open", buildLaunchServicesArguments({
      appBundle: chatGPTBundle,
      appArguments: options.appArguments ?? [],
      environment: {
        CODEX_MIDI_SOCKET: socket,
        CODEX_MIDI_TOKEN: token,
        NODE_OPTIONS: managedRequire,
      },
    }), {
      stdio: "ignore",
    });

    const winner = await Promise.race([
      childExit(chatGPTLauncher).then(({ code, signal }) => ({ process: "chatgpt" as const, code, signal })),
      childExit(bridge).then(({ code, signal }) => ({ process: "bridge" as const, code, signal })),
    ]);
    if (interrupted) return 0;
    if (winner.process === "bridge") {
      terminateChatGPT = true;
      chatGPTLauncher.kill("SIGTERM");
      throw new Error(`The codex-midi bridge stopped unexpectedly (${winner.signal ?? winner.code})`);
    }
    return winner.code ?? (winner.signal === null ? 0 : 1);
  } finally {
    process.off("SIGINT", onSignal);
    process.off("SIGTERM", onSignal);
    stopChildren();
    if (terminateChatGPT) await terminateExecutable(chatGPT);
    await Promise.all([
      childExit(bridge).catch(() => undefined),
      ...(chatGPTLauncher === undefined
        ? []
        : [childExit(chatGPTLauncher).catch(() => undefined)]),
    ]);
    await rm(runtime, { recursive: true, force: true });
  }
}

export function applicationBundleForExecutable(executable: string): string {
  const marker = ".app/Contents/MacOS/";
  const markerIndex = executable.lastIndexOf(marker);
  if (markerIndex < 0) {
    throw new Error(
      `ChatGPT executable must be inside a macOS application bundle: ${executable}`,
    );
  }
  return executable.slice(0, markerIndex + ".app".length);
}

export async function activateApplication(appBundle: string): Promise<void> {
  await execFileAsync("/usr/bin/open", ["-a", appBundle], { timeout: 1_000 });
}

export function buildLaunchServicesArguments(options: {
  readonly appBundle: string;
  readonly appArguments: readonly string[];
  readonly environment: Readonly<Record<string, string>>;
}): string[] {
  const args = ["-n", "-W"];
  for (const [name, value] of Object.entries(options.environment)) {
    args.push("--env", `${name}=${value}`);
  }
  args.push("-a", options.appBundle);
  if (options.appArguments.length > 0) args.push("--args", ...options.appArguments);
  return args;
}

async function waitForSocket(
  socketPath: string,
  bridge: ReturnType<typeof spawn>,
): Promise<void> {
  const deadline = Date.now() + 10_000;
  while (Date.now() < deadline) {
    if (bridge.exitCode !== null) throw new Error(`Bridge exited during startup (${bridge.exitCode})`);
    if (await probeSocket(socketPath)) return;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error(`Timed out waiting for bridge socket: ${socketPath}`);
}

function probeSocket(path: string): Promise<boolean> {
  return new Promise((resolve) => {
    const socket = createConnection(path);
    const timer = setTimeout(() => {
      socket.destroy();
      resolve(false);
    }, 250);
    socket.once("connect", () => {
      clearTimeout(timer);
      socket.destroy();
      resolve(true);
    });
    socket.once("error", () => {
      clearTimeout(timer);
      resolve(false);
    });
  });
}

async function executableIsRunning(executable: string): Promise<boolean> {
  return (await executablePids(executable)).length > 0;
}

async function terminateExecutable(executable: string): Promise<void> {
  for (const pid of await executablePids(executable)) {
    try {
      process.kill(pid, "SIGTERM");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ESRCH") throw error;
    }
  }
}

async function executablePids(executable: string): Promise<number[]> {
  const { stdout } = await execFileAsync("/bin/ps", ["-axo", "pid=,command="]);
  const pids: number[] = [];
  for (const line of stdout.split("\n")) {
    const match = /^\s*(\d+)\s+(.+)$/.exec(line);
    if (match === null) continue;
    const pidText = match[1]!;
    const command = match[2]!;
    if (command === executable || command.startsWith(`${executable} `)) {
      pids.push(Number(pidText));
    }
  }
  return pids;
}

async function requireSafeFile(path: string): Promise<void> {
  const info = await lstat(path);
  const uid = process.getuid?.();
  if (!info.isFile() || info.isSymbolicLink() || (uid !== undefined && info.uid !== uid) || (info.mode & 0o022) !== 0) {
    throw new Error(`Unsafe preload ownership or mode: ${path}`);
  }
}

async function requireExecutable(path: string): Promise<void> {
  const info = await lstat(path);
  if (!info.isFile() || info.isSymbolicLink() || (info.mode & 0o111) === 0) {
    throw new Error(`ChatGPT executable not found: ${path}`);
  }
}

function childExit(child: ReturnType<typeof spawn>): Promise<{ code: number | null; signal: NodeJS.Signals | null }> {
  if (child.exitCode !== null || child.signalCode !== null) {
    return Promise.resolve({ code: child.exitCode, signal: child.signalCode });
  }
  return new Promise((resolve, reject) => {
    child.once("error", reject);
    child.once("exit", (code, signal) => resolve({ code, signal }));
  });
}
