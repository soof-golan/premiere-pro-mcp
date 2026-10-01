using System.Diagnostics;
using System.IO.Compression;
using System.Reflection;
using System.Text.Json;
using Microsoft.Win32;

namespace PremiereConnectorInstaller;

internal static class Program
{
    private const string ExtensionId = "MCPBridgeCEP";
    private const string ResourceName = "MCPBridgeCEP.zxp";

    [STAThread]
    private static int Main(string[] args)
    {
        bool verifyOnly = args.Contains("--verify-only", StringComparer.OrdinalIgnoreCase);
        if (verifyOnly)
        {
            try
            {
                VerifyEmbeddedPackage();
                Console.WriteLine("Embedded connector package verified without installation.");
                return 0;
            }
            catch (Exception error)
            {
                Console.Error.WriteLine("Embedded connector package verification failed: " + error.Message);
                return 1;
            }
        }

        ApplicationConfiguration.Initialize();

        bool quiet = args.Contains("--quiet", StringComparer.OrdinalIgnoreCase);
        bool uninstall = args.Contains("--uninstall", StringComparer.OrdinalIgnoreCase);

        try
        {
            if (uninstall)
            {
                if (IsPremiereRunning())
                {
                    Show(quiet, "Premiere Pro is running. Close it before removing the Connector.", MessageBoxIcon.Warning);
                    return 3;
                }
                RemoveConnector();
                string debugModeMessage = RestorePlayerDebugMode();
                Show(
                    quiet,
                    "Premiere Connector was removed. " + debugModeMessage +
                    " Remove the MCP server from your AI client separately if needed.",
                    MessageBoxIcon.Information);
                return 0;
            }

            if (!quiet)
            {
                DialogResult answer = MessageBox.Show(
                    "Install or repair the Premiere Connector for the current Windows account?\n\n" +
                    "Close Premiere Pro first. Your media and projects are not accessed.",
                    "Premiere Connector Setup",
                    MessageBoxButtons.OKCancel,
                    MessageBoxIcon.Information);
                if (answer != DialogResult.OK) return 2;
            }

            if (IsPremiereRunning())
            {
                Show(quiet, "Premiere Pro is running. Close it, then run this installer again.", MessageBoxIcon.Warning);
                return 3;
            }

            InstallConnector();
            Show(
                quiet,
                "Premiere Connector is installed.\n\n" +
                "Next: open Premiere Pro, choose Window > Extensions > MCP Bridge, then ask your AI assistant to verify the Premiere connection.",
                MessageBoxIcon.Information);
            return 0;
        }
        catch (Exception error)
        {
            Show(quiet, "Setup could not finish:\n\n" + error.Message, MessageBoxIcon.Error);
            return 1;
        }
    }

    private static string CepRoot => Path.GetFullPath(Path.Combine(
        Environment.GetFolderPath(Environment.SpecialFolder.ApplicationData),
        "Adobe", "CEP", "extensions"));

    private static string Destination => Path.GetFullPath(Path.Combine(CepRoot, ExtensionId));

    // Shared with scripts/install-cep.ps1 and scripts/uninstall-cep.ps1: both
    // write into the same CEP extensions directory, so they use the same
    // PlayerDebugMode baseline file and JSON schema.
    private static string PlayerDebugModeStateFile => Path.Combine(CepRoot, ".premiere-pro-mcp-player-debug-mode.state.json");

    private sealed class PlayerDebugModeEntry
    {
        [System.Text.Json.Serialization.JsonPropertyName("existed")]
        public bool Existed { get; set; }

        [System.Text.Json.Serialization.JsonPropertyName("value")]
        public string? Value { get; set; }

        [System.Text.Json.Serialization.JsonPropertyName("kind")]
        public string? Kind { get; set; }
    }

    private static void InstallConnector()
    {
        EnsureInsideCepRoot(Destination);
        Directory.CreateDirectory(CepRoot);

        string staging = Path.Combine(CepRoot, $".{ExtensionId}-staging-{Guid.NewGuid():N}");
        string backup = Path.Combine(CepRoot, $".{ExtensionId}-backup-{Guid.NewGuid():N}");

        try
        {
            Directory.CreateDirectory(staging);
            ExtractEmbeddedPackage(staging);
            string manifest = Path.Combine(staging, "CSXS", "manifest.xml");
            if (!File.Exists(manifest)) throw new InvalidDataException("The connector package is missing CSXS/manifest.xml.");

            if (Directory.Exists(Destination)) Directory.Move(Destination, backup);
            Directory.Move(staging, Destination);
            if (Directory.Exists(backup)) Directory.Delete(backup, true);

            // This installer always embeds a verified, signed MCPBridgeCEP.zxp
            // (enforced by RequireConnectorPackage / VerifyEmbeddedPackage), so
            // unlike the unsigned development bundle copied by install-cep.ps1,
            // it does not need Adobe's PlayerDebugMode to load. PlayerDebugMode
            // disables CEP signature verification for ALL CEP extensions for
            // this Windows user, so it is intentionally left untouched here.
        }
        catch
        {
            if (!Directory.Exists(Destination) && Directory.Exists(backup)) Directory.Move(backup, Destination);
            throw;
        }
        finally
        {
            if (Directory.Exists(staging)) Directory.Delete(staging, true);
            if (Directory.Exists(backup)) Directory.Delete(backup, true);
        }
    }

    private static void ExtractEmbeddedPackage(string staging)
    {
        using Stream package = Assembly.GetExecutingAssembly().GetManifestResourceStream(ResourceName)
            ?? throw new InvalidOperationException("The verified connector package is not embedded in this installer.");
        using var archive = new ZipArchive(package, ZipArchiveMode.Read);
        string root = Path.GetFullPath(staging).TrimEnd(Path.DirectorySeparatorChar) + Path.DirectorySeparatorChar;

        foreach (ZipArchiveEntry entry in archive.Entries)
        {
            string target = Path.GetFullPath(Path.Combine(staging, entry.FullName.Replace('/', Path.DirectorySeparatorChar)));
            if (!target.StartsWith(root, StringComparison.OrdinalIgnoreCase))
                throw new InvalidDataException("The connector package contains an unsafe path.");

            if (string.IsNullOrEmpty(entry.Name))
            {
                Directory.CreateDirectory(target);
                continue;
            }

            Directory.CreateDirectory(Path.GetDirectoryName(target)!);
            entry.ExtractToFile(target, true);
        }
    }

    // This is deliberately read-only: CI can execute the shipped single-file installer
    // and prove its embedded connector is structurally safe without touching the CEP
    // directory, registry, Premiere process state, or any project data.
    private static void VerifyEmbeddedPackage()
    {
        using Stream package = Assembly.GetExecutingAssembly().GetManifestResourceStream(ResourceName)
            ?? throw new InvalidOperationException("The verified connector package is not embedded in this installer.");
        using var archive = new ZipArchive(package, ZipArchiveMode.Read);
        string validationRoot = Path.GetFullPath(Path.Combine(Path.GetTempPath(), "premiere-connector-validate"))
            .TrimEnd(Path.DirectorySeparatorChar) + Path.DirectorySeparatorChar;
        ZipArchiveEntry? manifest = null;

        foreach (ZipArchiveEntry entry in archive.Entries)
        {
            string target = Path.GetFullPath(Path.Combine(
                validationRoot,
                entry.FullName.Replace('/', Path.DirectorySeparatorChar)));
            if (!target.StartsWith(validationRoot, StringComparison.OrdinalIgnoreCase))
                throw new InvalidDataException("The connector package contains an unsafe path.");

            if (string.Equals(entry.FullName, "CSXS/manifest.xml", StringComparison.Ordinal))
                manifest = entry;
        }

        if (manifest is null) throw new InvalidDataException("The connector package is missing CSXS/manifest.xml.");
        using var reader = new StreamReader(manifest.Open());
        string manifestText = reader.ReadToEnd();
        if (!manifestText.Contains("<ExtensionManifest", StringComparison.Ordinal) ||
            !manifestText.Contains("ExtensionBundleId=\"com.mcp.premiere.bridge\"", StringComparison.Ordinal))
            throw new InvalidDataException("The connector package has an invalid CSXS/manifest.xml.");
    }

    private static void RemoveConnector()
    {
        EnsureInsideCepRoot(Destination);
        if (Directory.Exists(Destination)) Directory.Delete(Destination, true);
    }

    // Restores PlayerDebugMode values recorded by an older build of this
    // installer or by scripts/install-cep.ps1 (they share the same CEP
    // extensions directory and state-file schema). This installer's own
    // current InstallConnector() no longer sets PlayerDebugMode, but a
    // machine that was set up before this fix may still have it enabled with
    // no baseline recorded.
    private static string RestorePlayerDebugMode()
    {
        string stateFile = PlayerDebugModeStateFile;
        string afterEffectsSibling = Path.Combine(CepRoot, "MCPAfterEffectsBridgeCEP");

        if (Directory.Exists(afterEffectsSibling))
        {
            return "Another MCP CEP connector is still installed for this Windows user, so Adobe's PlayerDebugMode setting was left unchanged.";
        }

        if (!File.Exists(stateFile))
        {
            return "Adobe's shared PlayerDebugMode setting was left unchanged (no baseline was recorded, so it may have been enabled by an older installer). " +
                "To turn it off manually for CSXS 9-14, only if no other unsigned CEP extension needs it, remove the PlayerDebugMode value under " +
                @"HKEY_CURRENT_USER\SOFTWARE\Adobe\CSXS.9 through CSXS.14.";
        }

        try
        {
            string json = File.ReadAllText(stateFile);
            Dictionary<string, PlayerDebugModeEntry>? priorState =
                JsonSerializer.Deserialize<Dictionary<string, PlayerDebugModeEntry>>(json);

            if (priorState is not null)
            {
                foreach (KeyValuePair<string, PlayerDebugModeEntry> pair in priorState)
                {
                    string version = pair.Key.StartsWith("CSXS.", StringComparison.OrdinalIgnoreCase)
                        ? pair.Key["CSXS.".Length..]
                        : pair.Key;
                    using RegistryKey key = Registry.CurrentUser.CreateSubKey($@"SOFTWARE\Adobe\CSXS.{version}", true);
                    if (pair.Value.Existed)
                    {
                        RegistryValueKind kind = Enum.TryParse(pair.Value.Kind, out RegistryValueKind parsedKind)
                            ? parsedKind
                            : RegistryValueKind.String;
                        key.SetValue("PlayerDebugMode", pair.Value.Value ?? "0", kind);
                    }
                    else
                    {
                        key.DeleteValue("PlayerDebugMode", false);
                    }
                }
            }

            File.Delete(stateFile);
            return "Adobe's PlayerDebugMode setting was restored to the values recorded before installation.";
        }
        catch (Exception error)
        {
            return "Adobe's PlayerDebugMode setting could not be restored automatically (" + error.Message + "). " +
                "Check it manually under HKEY_CURRENT_USER\\SOFTWARE\\Adobe\\CSXS.9 through CSXS.14.";
        }
    }

    private static void EnsureInsideCepRoot(string path)
    {
        string root = CepRoot.TrimEnd(Path.DirectorySeparatorChar) + Path.DirectorySeparatorChar;
        if (!path.StartsWith(root, StringComparison.OrdinalIgnoreCase))
            throw new InvalidOperationException("Refusing to modify files outside the Adobe CEP extensions folder.");
    }

    private static bool IsPremiereRunning() => Process.GetProcesses().Any(process =>
    {
        try { return process.ProcessName.Contains("Adobe Premiere Pro", StringComparison.OrdinalIgnoreCase); }
        catch { return false; }
    });

    private static void Show(bool quiet, string message, MessageBoxIcon icon)
    {
        if (quiet) Console.Error.WriteLine(message);
        else MessageBox.Show(message, "Premiere Connector Setup", MessageBoxButtons.OK, icon);
    }
}
