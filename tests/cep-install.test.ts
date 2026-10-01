import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const root = process.cwd();

describe("CEP installation metadata", () => {
  it("keeps the CEP bundle and extension versions aligned with package.json", () => {
    const pkg = JSON.parse(readFileSync(join(root, "package.json"), "utf8"));
    const manifest = readFileSync(join(root, "cep-plugin", "CSXS", "manifest.xml"), "utf8");
    const updater = readFileSync(join(root, "cep-plugin", "updater.cjs"), "utf8");

    expect(manifest).toContain(`ExtensionBundleVersion="${pkg.version}"`);
    expect(manifest.match(new RegExp(`Version="${pkg.version.replaceAll(".", "\\.")}"`, "g"))).toHaveLength(3);
    expect(updater).toContain(`CURRENT_VERSION = "${pkg.version}"`);
  });

  it("declares Premiere compatibility with a Marketplace-safe minimum only", () => {
    const manifest = readFileSync(join(root, "cep-plugin", "CSXS", "manifest.xml"), "utf8");

    expect(manifest).toContain('<Host Name="PPRO" Version="14.0"/>');
    expect(manifest).not.toMatch(/<Host Name="PPRO" Version="[[(]/);
  });

  it("ships a separately addressed After Effects authoring connector", () => {
    const pkg = JSON.parse(readFileSync(join(root, "package.json"), "utf8"));
    const manifest = readFileSync(join(root, "after-effects-cep-plugin", "CSXS", "manifest.xml"), "utf8");
    const panel = readFileSync(join(root, "after-effects-cep-plugin", "main.js"), "utf8");
    const cli = readFileSync(join(root, "src", "index.ts"), "utf8");

    expect(pkg.files).toContain("after-effects-cep-plugin");
    expect(manifest).toContain(`ExtensionBundleVersion="${pkg.version}"`);
    expect(manifest).toContain('<Host Name="AEFT" Version="15.0"/>');
    expect(panel).toContain("after-effects-mcp-bridge");
    expect(panel).toContain("AFTER_EFFECTS_MCP_TEMP_DIR");
    expect(cli).toContain("--install-after-effects-cep");
    expect(cli).toContain('powershellArgs.push("-ConnectorHost", "AfterEffects")');
  });

  it("documents the Windows unsigned-extension value as REG_SZ", () => {
    const readme = readFileSync(join(root, "README.md"), "utf8");
    const installer = readFileSync(join(root, "scripts", "install-cep.ps1"), "utf8");

    expect(readme).toContain("String (`REG_SZ`)");
    expect(readme).not.toContain("set these DWORD values");
    expect(installer).toContain('-PropertyType String -Value "1"');
    expect(installer).toContain("artifacts\\MCPBridgeCEP.zxp");
    expect(installer).toContain('ExtensionBundleVersion="');
    expect(installer).toContain("signedPackageMatchesRelease");
    expect(installer).toContain("embedded connector version does not match package version");
    expect(installer).toContain("Signature verification failed");
  });

  it("builds and verifies a signed Windows CEP release package", () => {
    const packageJson = JSON.parse(readFileSync(join(root, "package.json"), "utf8"));
    const signer = readFileSync(join(root, "scripts", "build-signed-cep.ps1"), "utf8");
    const workflow = readFileSync(join(root, ".github", "workflows", "npm-publish.yml"), "utf8");

    expect(packageJson.files).toContain("artifacts/MCPBridgeCEP.zxp");
    expect(signer).toContain("-selfSignedCert");
    expect(signer).toContain("-verify");
    expect(workflow).toContain("build-signed-cep");
    expect(workflow).toContain("signed-cep");
  });

  it("publishes connector updates and exposes the updater in the panel", () => {
    const workflow = readFileSync(join(root, ".github", "workflows", "cep-release.yml"), "utf8");
    const panel = readFileSync(join(root, "cep-plugin", "index.html"), "utf8");
    const panelLogic = readFileSync(join(root, "cep-plugin", "main.js"), "utf8");

    expect(workflow).toContain("release:");
    expect(workflow).toContain("artifacts/MCPBridgeCEP.zxp");
    expect(panel).toContain('src="updater.cjs"');
    expect(panel).toContain("MCP updates");
    expect(panel).toContain('aria-describedby="updateDetail"');
    expect(panelLogic).toContain("Update after quit");
    expect(panelLogic).toContain("scheduleWindowsGlobalUpdate");
    expect(panelLogic).toContain("window.confirm");
    expect(panelLogic).toContain("getPerUserGlobalInstall");
    expect(panelLogic).toContain("LATEST_PACKAGE_API");
    expect(panelLogic).toContain("This panel will not modify a source checkout.");
    expect(panelLogic).toContain("writeResponseFile(resFilePath, response)");
    expect(panelLogic).toContain("fs.renameSync(stagedPath, filePath)");
    expect(panelLogic).toContain('"bridge-heartbeat.json"');
    expect(panelLogic).toContain("protocolVersion: 1");
    expect(panelLogic).toContain("startBridgeHeartbeat()");
    expect(panelLogic).toContain("PREMIERE_TEMP_DIR");
    expect(panelLogic).toContain('nodeRequire("process")');
    expect(panelLogic).toContain('return "mcpstate:"');
    expect(panelLogic).toContain("/^mcpstate:([01]),([01])$/");
    expect(panelLogic).not.toContain("return JSON.stringify({projectOpen:");
  });

  it("copies the macOS plugin for npm installs and supports diagnostics", () => {
    const cli = readFileSync(join(root, "src", "index.ts"), "utf8");
    const installer = readFileSync(join(root, "scripts", "install-cep.sh"), "utf8");
    expect(cli).toContain('diagnose ? "--diagnose" : "--copy"');
    expect(installer).toContain('HOST="Premiere"');
    expect(installer).toContain('for arg in "$@"; do');
    expect(installer).toContain("--after-effects");
    expect(installer).toContain('if [ "$MODE" = "--diagnose" ]');
    expect(installer).toContain("Installation verified");
  });

  it("rejects CEP installation on unsupported host operating systems", () => {
    const cli = readFileSync(join(root, "src", "index.ts"), "utf8");
    expect(cli).toContain("supported only on Windows and macOS");
  });

  it("offers an idempotent connector-only uninstall path on both supported operating systems", () => {
    const cli = readFileSync(join(root, "src", "index.ts"), "utf8");
    const windows = readFileSync(join(root, "scripts", "uninstall-cep.ps1"), "utf8");
    const macos = readFileSync(join(root, "scripts", "uninstall-cep.sh"), "utf8");

    expect(cli).toContain("--uninstall-cep");
    expect(windows).toContain("Refusing to uninstall outside the CEP extensions directory");
    expect(windows).toContain("leaving PlayerDebugMode unchanged");
    expect(macos).toContain("--uninstall-system");
    expect(macos).toContain("leaving PlayerDebugMode unchanged");
  });

  it("only enables PlayerDebugMode where it is not already set, and records a restorable baseline", () => {
    const installSh = readFileSync(join(root, "scripts", "install-cep.sh"), "utf8");
    const installPs1 = readFileSync(join(root, "scripts", "install-cep.ps1"), "utf8");

    expect(installSh).toContain("disables CEP extension");
    expect(installSh).toContain(".premiere-pro-mcp-player-debug-mode.state");
    expect(installSh).toContain('if [ "$current" != "1" ]');

    expect(installPs1).toContain("disables CEP extension signature verification");
    expect(installPs1).toContain(".premiere-pro-mcp-player-debug-mode.state.json");
    expect(installPs1).toContain("Signed package in use; PlayerDebugMode was not changed.");
  });

  it("restores the recorded PlayerDebugMode baseline on uninstall, or explains how to reset manually", () => {
    const uninstallSh = readFileSync(join(root, "scripts", "uninstall-cep.sh"), "utf8");
    const uninstallPs1 = readFileSync(join(root, "scripts", "uninstall-cep.ps1"), "utf8");
    const installerCs = readFileSync(join(root, "installer", "windows", "Program.cs"), "utf8");

    expect(uninstallSh).toContain("restore_player_debug_mode");
    expect(uninstallSh).toContain("No PlayerDebugMode baseline was recorded");
    expect(uninstallSh).toContain("defaults delete");

    expect(uninstallPs1).toContain(".premiere-pro-mcp-player-debug-mode.state.json");
    expect(uninstallPs1).toContain("No PlayerDebugMode baseline was recorded");

    expect(installerCs).toContain("RestorePlayerDebugMode");
    expect(installerCs).toContain("PlayerDebugModeStateFile");
    expect(installerCs).toContain("no baseline was recorded");
  });
});
