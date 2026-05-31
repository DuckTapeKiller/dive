const http = require("http");
const fs = require("fs");
const net = require("net");
const os = require("os");
const path = require("path");
const { spawnSync } = require("child_process");
const { app, BrowserWindow, dialog, shell } = require("electron");

let mainWindow = null;
let localPort = 8080;
const SERVER_LABEL = "com.ollamapichat.server";
const USER_ID = String(process.getuid ? process.getuid() : 501);
const LAUNCH_AGENTS_DIR = path.join(os.homedir(), "Library", "LaunchAgents");
const LAUNCH_PLIST_PATH = path.join(LAUNCH_AGENTS_DIR, `${SERVER_LABEL}.plist`);
const SETTINGS_DATA_DIR = path.join(os.homedir(), "ollama-pi-chat");
const PI_SETTINGS_FILE = path.join(SETTINGS_DATA_DIR, "pi-settings.json");

function findOpenPort(startPort = 8080, maxAttempts = 30) {
  return new Promise((resolve, reject) => {
    const attempt = (offset) => {
      if (offset >= maxAttempts) {
        reject(new Error("No available local port found."));
        return;
      }
      const candidate = startPort + offset;
      const tester = net.createServer();
      tester.once("error", () => {
        attempt(offset + 1);
      });
      tester.once("listening", () => {
        tester.close(() => resolve(candidate));
      });
      tester.listen(candidate, "127.0.0.1");
    };
    attempt(0);
  });
}

function waitForServer(port, timeoutMs = 15000) {
  const deadline = Date.now() + timeoutMs;
  return new Promise((resolve, reject) => {
    const probe = () => {
      const request = http.get(
        { hostname: "127.0.0.1", port, path: "/api/models", timeout: 1500 },
        (response) => {
          response.resume();
          resolve();
        },
      );
      request.on("error", () => {
        if (Date.now() >= deadline) {
          reject(new Error("Timed out waiting for local server."));
          return;
        }
        setTimeout(probe, 250);
      });
      request.on("timeout", () => {
        request.destroy();
      });
    };
    probe();
  });
}

function resolveNodeBinary() {
  const explicitPath = process.env.PI_CHAT_NODE_PATH;
  if (explicitPath && fs.existsSync(explicitPath)) return explicitPath;
  try {
    const lookup = spawnSync("/usr/bin/env", ["which", "node"], {
      encoding: "utf8",
    });
    if (lookup.status === 0) {
      const found = (lookup.stdout || "").trim();
      if (found && fs.existsSync(found)) return found;
    }
  } catch (_error) {}
  if (process.execPath && fs.existsSync(process.execPath)) {
    const basename = path.basename(process.execPath).toLowerCase();
    if (basename.includes("node")) return process.execPath;
  }
  return null;
}

function readConfiguredServerPort() {
  try {
    if (!fs.existsSync(PI_SETTINGS_FILE)) return 8080;
    const raw = JSON.parse(fs.readFileSync(PI_SETTINGS_FILE, "utf8"));
    const value = Number.parseInt(raw?.serverPort, 10);
    if (Number.isFinite(value) && value >= 1024 && value <= 65535) {
      return value;
    }
  } catch (_error) {}
  return 8080;
}

function copyIfExists(srcPath, dstPath, options = {}) {
  const { recursive = false, required = false } = options;
  try {
    if (!fs.existsSync(srcPath)) {
      if (required) {
        throw new Error(`Required source missing: ${srcPath}`);
      }
      return;
    }
    const stat = fs.statSync(srcPath);
    if (recursive) {
      if (!stat.isDirectory()) return;
      fs.cpSync(srcPath, dstPath, { recursive: true, force: true });
      return;
    }
    if (!stat.isFile()) return;
    fs.mkdirSync(path.dirname(dstPath), { recursive: true });
    fs.copyFileSync(srcPath, dstPath);
  } catch (error) {
    if (required) throw error;
    console.warn(
      `Ollama Pi Chat runtime sync skipped for ${srcPath}: ${error.message}`,
    );
  }
}

function syncRuntimeFiles(runtimeDir) {
  const appRoot = app.getAppPath();
  try {
    if (fs.existsSync(runtimeDir) && !fs.statSync(runtimeDir).isDirectory()) {
      fs.rmSync(runtimeDir, { force: true });
    }
  } catch (_error) {}
  fs.mkdirSync(runtimeDir, { recursive: true });
  copyIfExists(
    path.join(appRoot, "server.js"),
    path.join(runtimeDir, "server.js"),
    {
      required: true,
    },
  );
  copyIfExists(
    path.join(appRoot, "index.html"),
    path.join(runtimeDir, "index.html"),
    {
      required: true,
    },
  );
  copyIfExists(
    path.join(appRoot, "package.json"),
    path.join(runtimeDir, "package.json"),
    {
      required: false,
    },
  );
  copyIfExists(
    path.join(appRoot, "prompts.json"),
    path.join(runtimeDir, "prompts.json"),
  );
  copyIfExists(
    path.join(appRoot, "font_faces.css"),
    path.join(runtimeDir, "font_faces.css"),
    { required: true },
  );
  copyIfExists(path.join(appRoot, "fonts"), path.join(runtimeDir, "fonts"), {
    recursive: true,
  });
  copyIfExists(
    path.join(appRoot, "security"),
    path.join(runtimeDir, "security"),
    {
      recursive: true,
    },
  );
}

function buildLaunchPlist({ nodeBin, runtimeDir, logsDir, serverPort }) {
  const runtimeServerPath = path.join(runtimeDir, "server.js");
  const outLog = path.join(logsDir, "launchagent.out.log");
  const errLog = path.join(logsDir, "launchagent.err.log");
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>${SERVER_LABEL}</string>
  <key>ProgramArguments</key>
  <array>
    <string>${nodeBin}</string>
    <string>${runtimeServerPath}</string>
  </array>
  <key>WorkingDirectory</key>
  <string>${runtimeDir}</string>
  <key>EnvironmentVariables</key>
  <dict>
    <key>PORT</key>
    <string>${serverPort}</string>
  </dict>
  <key>RunAtLoad</key>
  <true/>
  <key>KeepAlive</key>
  <true/>
  <key>StandardOutPath</key>
  <string>${outLog}</string>
  <key>StandardErrorPath</key>
  <string>${errLog}</string>
</dict>
</plist>
`;
}

function runLaunchctl(args, throwOnFailure = false) {
  const result = spawnSync("/bin/launchctl", args, { encoding: "utf8" });
  if (throwOnFailure && result.status !== 0) {
    throw new Error(
      `launchctl ${args.join(" ")} failed: ${result.stderr || result.stdout || "unknown error"}`,
    );
  }
  return result;
}

function installOrRefreshLaunchAgent(serverPort) {
  const nodeBin = resolveNodeBinary();
  if (!nodeBin) return;

  const dataDir = app.getPath("userData");
  const runtimeDir = path.join(dataDir, "runtime");
  fs.mkdirSync(dataDir, { recursive: true });
  syncRuntimeFiles(runtimeDir);

  fs.mkdirSync(LAUNCH_AGENTS_DIR, { recursive: true });
  const plist = buildLaunchPlist({
    nodeBin,
    runtimeDir,
    logsDir: dataDir,
    serverPort,
  });
  fs.writeFileSync(LAUNCH_PLIST_PATH, plist, "utf8");

  runLaunchctl(["bootout", `gui/${USER_ID}`, LAUNCH_PLIST_PATH], false);
  runLaunchctl(["bootstrap", `gui/${USER_ID}`, LAUNCH_PLIST_PATH], false);
  runLaunchctl(["enable", `gui/${USER_ID}/${SERVER_LABEL}`], false);
  runLaunchctl(["kickstart", "-k", `gui/${USER_ID}/${SERVER_LABEL}`], false);
}

async function bootLocalServer() {
  const configuredPort = readConfiguredServerPort();
  installOrRefreshLaunchAgent(configuredPort);

  try {
    await waitForServer(configuredPort, 6000);
    localPort = configuredPort;
    return;
  } catch (_error) {}

  localPort = configuredPort;
  process.env.PORT = String(localPort);
  require(path.join(app.getAppPath(), "server.js"));
  await waitForServer(localPort);
}

function createMainWindow() {
  const iconPath = path.join(
    app.getAppPath(),
    "assets",
    "icons",
    "icon-1024.png",
  );
  const windowIcon = process.platform === "darwin" ? undefined : iconPath;

  mainWindow = new BrowserWindow({
    width: 1320,
    height: 860,
    minWidth: 720,
    minHeight: 480,
    backgroundColor: "#000000",
    show: false,
    icon: windowIcon,
    titleBarStyle: process.platform === "darwin" ? "hidden" : "default",
    autoHideMenuBar: true,
    webPreferences: {
      contextIsolation: true,
      sandbox: true,
      nodeIntegration: false,
      devTools: true,
    },
  });

  mainWindow.once("ready-to-show", () => {
    mainWindow.show();
  });

  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    shell.openExternal(url);
    return { action: "deny" };
  });

  mainWindow.loadURL(`http://127.0.0.1:${localPort}`);
}

const singleLock = app.requestSingleInstanceLock();
if (!singleLock) {
  app.quit();
} else {
  app.on("second-instance", () => {
    if (mainWindow) {
      if (mainWindow.isMinimized()) mainWindow.restore();
      mainWindow.focus();
    }
  });

  app.whenReady().then(async () => {
    try {
      await bootLocalServer();
      createMainWindow();
    } catch (error) {
      dialog.showErrorBox(
        "Ollama Pi Chat Startup Error",
        String(error?.message || error),
      );
      app.quit();
    }
  });

  app.on("window-all-closed", () => {
    app.quit();
  });
}
